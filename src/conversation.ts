import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ChatMessage, MessagePage, TraceContext, TraceEvent } from './view.js';

export function publicData(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[nested value omitted]';
  if (typeof value === 'string') return (value.slice(0, 8192) + (value.length > 8192 ? '\n[truncated]' : ''))
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{12,}/gi, 'Bearer [redacted]');
  if (Array.isArray(value)) return value.slice(0, 40).map(item => publicData(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, item]) => [
    key, /^(api.?key|authorization|password|secret|credential|access.?token|refresh.?token)$/i.test(key)
      ? '[redacted]' : publicData(item, depth + 1),
  ]));
  return value;
}

export class Conversation {
  constructor(private readonly db: DatabaseSync, private readonly atomic: <T>(run: () => T) => T) {
    db.exec(`CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, request_id TEXT UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_tasks(message_id TEXT NOT NULL REFERENCES messages(id), task_id TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(message_id,task_id));
      CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY AUTOINCREMENT, root_id TEXT NOT NULL, task_id TEXT, message_id TEXT, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS journal_root ON journal(root_id,seq);
      CREATE INDEX IF NOT EXISTS journal_task ON journal(task_id,seq);
      CREATE INDEX IF NOT EXISTS journal_message ON journal(message_id,seq);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  meta<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  }
  setMeta(key: string, value: unknown) {
    this.db.prepare('INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }
  emit(event: Omit<TraceEvent, 'id' | 'seq' | 'at'>): TraceEvent {
    let data = publicData(event.data);
    const encoded = JSON.stringify(data);
    if (encoded && encoded.length > 8192) data = { preview: encoded.slice(0, 8192), truncated: true };
    const body = { ...event, id: randomUUID(), at: Date.now(), data };
    const result = this.db.prepare('INSERT INTO journal(root_id,task_id,message_id,body) VALUES(?,?,?,?)')
      .run(event.rootId, event.taskId ?? null, event.messageId ?? null, JSON.stringify(body));
    return { ...body, seq: Number(result.lastInsertRowid) };
  }
  private decode(row: Record<string, unknown>): ChatMessage {
    const message = JSON.parse(String(row.body)) as ChatMessage;
    message.seq = Number(row.seq);
    message.version = Number(this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM journal WHERE message_id=?').get(message.id)!.seq);
    message.taskIds = this.db.prepare('SELECT task_id FROM message_tasks WHERE message_id=? ORDER BY rowid').all(message.id).map(link => String(link.task_id));
    return message;
  }
  get(id: string): ChatMessage {
    const row = this.db.prepare('SELECT seq,body FROM messages WHERE id=?').get(id);
    if (!row) throw new Error('Message not found');
    return this.decode(row);
  }
  byRequest(requestId: string): ChatMessage | undefined {
    const row = this.db.prepare('SELECT seq,body FROM messages WHERE request_id=?').get(requestId);
    return row ? this.decode(row) : undefined;
  }
  create(message: Omit<ChatMessage, 'seq' | 'version' | 'at' | 'taskIds'>): ChatMessage {
    return this.atomic(() => {
      const body = { ...message, at: Date.now() };
      this.db.prepare('INSERT INTO messages(id,request_id,body) VALUES(?,?,?)').run(body.id, body.requestId ?? null, JSON.stringify(body));
      this.emit({ type: 'message', kind: 'message_created', rootId: body.replyTo ?? body.id, messageId: body.id,
        spanId: body.role === 'user' ? body.id : undefined,
        actor: body.role === 'user' ? 'user' : 'router', label: body.role === 'user' ? '用户消息' : 'Router 回复', status: body.status });
      return this.get(body.id);
    });
  }
  update(id: string, patch: Partial<Pick<ChatMessage, 'text' | 'status' | 'reason'>>) {
    return this.atomic(() => {
      const message = { ...this.get(id), ...patch };
      if (message.text.length > 65_536) throw new Error('Message exceeds 65536 character limit');
      this.db.prepare('UPDATE messages SET body=? WHERE id=?').run(JSON.stringify(message), id);
      this.emit({ type: 'message', kind: 'message_updated', rootId: message.replyTo ?? id, messageId: id,
        spanId: message.role === 'user' ? id : undefined,
        actor: message.role === 'user' ? 'user' : 'router', label: message.role === 'user' ? '用户消息' : 'Router 公开回复', status: message.status });
      return message;
    });
  }
  link(messageId: string, taskId: string) {
    this.atomic(() => {
      const inserted = this.db.prepare('INSERT OR IGNORE INTO message_tasks VALUES(?,?)').run(messageId, taskId);
      if (inserted.changes) this.emit({ type: 'trace', kind: 'work_linked', rootId: messageId, messageId, taskId,
        actor: 'router', label: '关联后台工作', status: 'linked' });
    });
  }
  history(before?: number, limit = 8): MessagePage {
    const rows = before === undefined
      ? this.db.prepare('SELECT seq,body FROM messages ORDER BY seq DESC LIMIT ?').all(limit + 1)
      : this.db.prepare('SELECT seq,body FROM messages WHERE seq<? ORDER BY seq DESC LIMIT ?').all(before, limit + 1);
    const items = rows.slice(0, limit).map(row => this.decode(row)).reverse();
    return { items, hasMore: rows.length > limit, before: items[0]?.seq };
  }
  recentContext(): unknown[] {
    return this.history(undefined, 12).items.map(({ id, role, text, mode, status, taskIds, paths }) => ({ id, role, mode, text: text.slice(-4096), truncated: text.length > 4096, status, taskIds, fileCount: paths.length }));
  }
  trace(filter: { messageId?: string; taskId?: string }, after = 0): TraceEvent[] {
    let rows;
    if (filter.taskId) rows = this.db.prepare('SELECT seq,body FROM journal WHERE seq>? AND task_id=? ORDER BY seq LIMIT 60').all(after, filter.taskId);
    else if (filter.messageId) rows = this.db.prepare(`SELECT seq,body FROM journal WHERE seq>? AND
      (root_id=? OR message_id=? OR task_id IN (SELECT task_id FROM message_tasks WHERE message_id=?)) ORDER BY seq LIMIT 60`)
      .all(after, filter.messageId, filter.messageId, filter.messageId);
    else rows = this.db.prepare('SELECT seq,body FROM journal WHERE seq>? ORDER BY seq LIMIT 60').all(after);
    return rows.map(row => ({ ...JSON.parse(String(row.body)), seq: Number(row.seq) } as TraceEvent));
  }
  latestSeq(): number { return Number(this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM journal').get()!.seq); }
  recover() {
    this.atomic(() => {
      const rows = this.db.prepare('SELECT seq,body FROM messages').all();
      for (const row of rows) {
        const message = this.decode(row);
        if (['queued', 'processing', 'streaming'].includes(message.status)) {
          this.update(message.id, { status: 'interrupted', reason: '服务中断，处理进度未确认；已保留内容，不自动重发或重放。' });
        }
      }
      const latestSpans = this.db.prepare(`SELECT body FROM journal WHERE seq IN (
        SELECT max(seq) FROM journal WHERE json_extract(body,'$.spanId') IS NOT NULL GROUP BY json_extract(body,'$.spanId'))`).all();
      for (const row of latestSpans) {
        const event = JSON.parse(String(row.body)) as TraceEvent;
        if (event.type === 'trace' && ['started', 'running', 'requested', 'streaming'].includes(event.status)) {
          const { seq: _seq, id: _id, at: _at, ...previous } = event;
          this.emit({ ...previous, status: 'interrupted', data: { reason: '服务重启，未确认完成，不自动重放。' } });
        }
      }
      this.db.exec(`DELETE FROM metadata WHERE key='router_pending'`);
    });
  }
  span(context: TraceContext, actor: TraceEvent['actor'], label: string, status: string, data?: unknown) {
    return this.emit({ ...context, type: 'trace', kind: 'span', actor, label, status, data });
  }
}

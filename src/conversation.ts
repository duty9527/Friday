import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ChatMessage, MessagePage, TraceContext, TraceEvent, RouteAction, RoutingRecord } from './view.js';

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
      const origin = message.origin ?? (message.replyTo ? this.get(message.replyTo).origin : undefined);
      const body = { ...message, origin, at: Date.now() };
      this.db.prepare('INSERT INTO messages(id,request_id,body) VALUES(?,?,?)').run(body.id, body.requestId ?? null, JSON.stringify(body));
      this.emit({ type: 'message', kind: 'message_created', rootId: body.replyTo ?? body.id, messageId: body.id,
        spanId: body.role === 'user' ? body.id : undefined,
        actor: body.role === 'user' ? 'user' : 'router', label: body.role === 'user' ? '用户消息' : 'Router 回复', status: body.status });
      return this.get(body.id);
    });
  }
  update(id: string, patch: Partial<Pick<ChatMessage, 'text' | 'status' | 'reason' | 'routing' | 'origin' | 'paths' | 'attachments'>>) {
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
  delete(id: string) {
    this.atomic(() => {
      this.db.prepare('DELETE FROM message_tasks WHERE message_id=?').run(id);
      this.db.prepare('DELETE FROM messages WHERE id=?').run(id);
    });
  }
  routeAction(messageId: string, action: RouteAction, parentSpanId?: string) {
    this.atomic(() => {
      const message = this.get(messageId);
      if (!message.routing) return;
      const actions = [...message.routing.actions];
      const index = actions.findIndex(item => item.id === action.id);
      if (index < 0) actions.push(action); else actions[index] = action;
      // Only a newly appended action can push the oldest out; updating a visible one drops nothing.
      const dropped = index < 0 ? Math.max(0, actions.length - 40) : 0;
      this.update(messageId, { routing: { ...message.routing, actions: actions.slice(-40), omittedActions: (message.routing.omittedActions ?? 0) + dropped } });
      this.emit({ type: 'trace', kind: 'route_action', rootId: messageId, messageId, taskId: action.taskId,
        spanId: action.id, parentSpanId: parentSpanId ?? messageId, actor: 'router', label: action.kind, status: action.status, data: action });
    });
  }
  routeState(messageId: string, status: RoutingRecord['status']) {
    const message = this.get(messageId);
    if (message.routing) this.update(messageId, { routing: { ...message.routing, status,
      actions: message.routing.actions.map(action => action.status === 'pending' && (status === 'failed' || status === 'interrupted') ? { ...action, status: 'interrupted' } : action) } });
  }
  followupState(id: string, state: string) {
    const rows = this.db.prepare(`SELECT id FROM messages WHERE EXISTS (
      SELECT 1 FROM json_each(messages.body, '$.routing.actions') WHERE json_extract(value, '$.followupId')=?)`).all(id);
    for (const row of rows) {
      const message = this.get(String(row.id));
      if (message.routing) this.update(message.id, { routing: { ...message.routing,
        actions: message.routing.actions.map(action => action.followupId === id ? { ...action, delivery: state } : action) } });
      for (const action of message.routing?.actions.filter(item => item.followupId === id) ?? []) this.emit({
        type: 'trace', kind: 'followup_state', rootId: message.id, messageId: message.id, taskId: action.taskId,
        spanId: `${action.id}:delivery`, parentSpanId: action.id, actor: 'worker', label: '处理补充要求', status: state,
        data: { followupId: id, taskLabel: action.taskLabel, state } });
    }
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
  allMessages(limit = 500): ChatMessage[] {
    const rows = this.db.prepare('SELECT seq,body FROM messages ORDER BY seq DESC LIMIT ?').all(limit);
    return rows.map(row => this.decode(row));
  }
  neighbors(seq: number, radius = 1): Array<{ id: string; seq: number; role: 'user' | 'assistant'; preview: string }> {
    const prev = this.db.prepare('SELECT seq,body FROM messages WHERE seq<? ORDER BY seq DESC LIMIT ?').all(seq, radius).reverse();
    const next = this.db.prepare('SELECT seq,body FROM messages WHERE seq>? ORDER BY seq ASC LIMIT ?').all(seq, radius);
    return [...prev, ...next].map(row => {
      const msg = this.decode(row);
      return { id: msg.id, seq: msg.seq, role: msg.role, preview: String(publicData(msg.text.slice(0, 240))) };
    });
  }
  /**
   * `after` reads forward for live updates, `before` reads the window that precedes a known event,
   * and neither reads the most recent window, so a long-running work can be opened where it is now
   * instead of replaying its first hour. Every direction returns durable sequence order.
   */
  trace(filter: { messageId?: string; taskId?: string }, after?: number, before?: number): TraceEvent[] {
    const limit = 60;
    // A work's process starts with the Router turn that created it, so that decision stays visible
    // instead of a Worker apparently starting on its own. Only the creating round's message-level
    // rows are added: rows stamped with a sibling work's id belong to that sibling, not to this one.
    const origin = filter.taskId ? this.originMessage(filter.taskId) : undefined;
    // A message's own round is what happened because of it, including the replies its Router turns
    // produced. Work events belong to the message that created the work, so a later follow-up's
    // routing decision cannot appear inside an earlier round.
    const own = filter.messageId ? [filter.messageId, ...this.replyIds(filter.messageId)] : [];
    const listed = own.map(() => '?').join(',');
    const scope = filter.taskId ? (origin ? '(task_id=? OR (message_id=? AND task_id IS NULL))' : 'task_id=?')
      : filter.messageId
        ? `(root_id=? OR message_id IN (${listed}) OR task_id IN (SELECT task_id FROM message_tasks WHERE message_id=?))
          AND (message_id IS NULL OR message_id IN (${listed}))` : '';
    const args = filter.taskId ? origin ? [filter.taskId, origin] : [filter.taskId]
      : filter.messageId ? [filter.messageId, ...own, filter.messageId, ...own] : [];
    const where = [scope, after !== undefined ? 'seq>?' : 'seq<?']
      .filter(Boolean).join(' AND ');
    const anchor = after !== undefined ? after : before !== undefined ? before : Number.MAX_SAFE_INTEGER;
    const descending = after === undefined;
    const sql = `SELECT seq,body FROM journal${where ? ` WHERE ${where}` : ''} ORDER BY seq ${descending ? 'DESC' : 'ASC'} LIMIT ${limit}`;
    const rows = this.db.prepare(sql).all(...args, anchor) as Array<Record<string, unknown>>;
    if (descending) rows.reverse();
    return rows.map(row => ({ ...JSON.parse(String(row.body)), seq: Number(row.seq) } as TraceEvent));
  }
  private replyIds(messageId: string): string[] {
    return this.db.prepare("SELECT id FROM messages WHERE json_extract(body,'$.replyTo')=?").all(messageId).map(row => String(row.id));
  }
  private originMessage(taskId: string): string | undefined {
    const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(taskId);
    if (!row) return undefined;
    const origin = (JSON.parse(String(row.body)) as { originMessageId?: string }).originMessageId;
    return typeof origin === 'string' ? origin : undefined;
  }
  latestSeq(): number { return Number(this.db.prepare('SELECT coalesce(max(seq),0) AS seq FROM journal').get()!.seq); }
  recover() {
    this.atomic(() => {
      const rows = this.db.prepare("SELECT seq,body FROM messages WHERE json_extract(body,'$.status') IN ('queued','processing','streaming')").all();
      for (const row of rows) {
        const message = this.decode(row);
        this.update(message.id, { status: 'interrupted', reason: '服务中断，处理进度未确认；已保留内容，不自动重发或重放。',
          routing: message.routing ? { ...message.routing, status: 'interrupted', actions: message.routing.actions.map(action => action.status === 'pending' ? { ...action, status: 'interrupted' } : action) } : undefined });
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

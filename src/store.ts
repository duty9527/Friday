import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { InputFile } from './files.js';
import { Conversation } from './conversation.js';

export type TaskStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export interface Task {
  id: string; requestId: string; fingerprint: string; prompt: string;
  status: TaskStatus; revision: number; files: InputFile[];
  mode: 'real' | 'offline'; createdAt: number; limitMs: number; activeMs: number;
  report?: string; reason?: string; sessionFile?: string;
  originMessageId?: string; parentTaskId?: string; parentSpanId?: string;
  execution?: 'native' | 'snapshot'; cwd?: string; paths?: string[];
}
export interface TaskEvent { id: string; taskId: string; text: string; state: string }
export interface Operation {
  id: string; taskId: string; revision: number; fileId: string;
  status: 'requested' | 'started' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'unknown';
  result?: string; error?: string; parentSpanId?: string;
}
export interface Notice { seq: number; taskId: string; kind: string; text: string; at: number }

export class Store {
  private readonly db: DatabaseSync;
  private depth = 0;
  readonly conversation: Conversation;
  constructor(home: string) {
    this.db = new DatabaseSync(join(home, 'state.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), text TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notices(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);`);
    this.conversation = new Conversation(this.db, run => this.transaction(run));
  }
  transaction<T>(run: () => T): T {
    const level = this.depth++;
    const savepoint = `nested_${level}`;
    this.db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    try {
      const result = run();
      this.db.exec(level === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}`);
      if (level !== 0) this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally { this.depth--; }
  }
  create(task: Task) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(task.id, task.requestId, JSON.stringify(task));
      this.notice(task.id, 'accepted', `Task accepted (${task.mode})`);
    });
  }
  get(id: string): Task {
    const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id);
    if (!row) throw new Error('Task not found');
    return JSON.parse(String(row.body)) as Task;
  }
  byRequest(requestId: string): Task | undefined {
    const row = this.db.prepare('SELECT body FROM tasks WHERE request_id=?').get(requestId);
    return row ? JSON.parse(String(row.body)) as Task : undefined;
  }
  list(): Task[] {
    return this.db.prepare('SELECT body FROM tasks ORDER BY rowid').all().map(row => JSON.parse(String(row.body)) as Task);
  }
  save(task: Task) {
    this.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(task), task.id);
  }
  transition(id: string, status: TaskStatus, reason?: string, report?: string): Task {
    return this.transaction(() => {
      const task = this.get(id);
      task.status = status; task.reason = reason;
      if (report !== undefined) task.report = report;
      this.save(task);
      this.notice(id, status, report ?? reason ?? status);
      return task;
    });
  }
  addEvent(id: string, taskId: string, text: string): boolean {
    const row = this.db.prepare('SELECT task_id, text FROM events WHERE id=?').get(id);
    if (row) {
      if (row.task_id !== taskId || row.text !== text) throw new Error('Request ID already used for a different follow-up');
      return false;
    }
    this.transaction(() => {
      this.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(id, taskId, text, 'pending');
      this.notice(taskId, 'followup', 'Follow-up accepted');
    });
    return true;
  }
  takeEvents(taskId: string): TaskEvent[] {
    return this.transaction(() => {
      const events = this.db.prepare("SELECT * FROM events WHERE task_id=? AND state='pending' ORDER BY rowid").all(taskId);
      this.db.prepare("UPDATE events SET state='processing' WHERE task_id=? AND state='pending'").run(taskId);
      for (const row of events) this.conversation.followupState(String(row.id), 'processing');
      return events.map(row => ({ id: String(row.id), taskId, text: String(row.text), state: 'processing' }));
    });
  }
  finishEvents(events: TaskEvent[]) {
    this.transaction(() => {
      for (const event of events) {
        this.db.prepare("UPDATE events SET state='done' WHERE id=?").run(event.id);
        this.conversation.followupState(event.id, 'done');
      }
    });
  }
  /** A taken follow-up whose delivery failed must stay visible instead of vanishing in `processing`. */
  abandonEvents(events: TaskEvent[], reason: string) {
    this.transaction(() => {
      for (const event of events) {
        const row = this.db.prepare('SELECT state FROM events WHERE id=?').get(event.id);
        if (row?.state !== 'processing') continue;
        this.db.prepare("UPDATE events SET state='failed' WHERE id=?").run(event.id);
        this.conversation.followupState(event.id, 'failed');
        this.notice(event.taskId, 'followup_failed', `补充要求未送达 Worker：${reason}`);
      }
    });
  }
  events(taskId: string): TaskEvent[] {    return this.db.prepare('SELECT id,task_id,text,state FROM events WHERE task_id=? ORDER BY rowid').all(taskId)
      .map(row => ({ id: String(row.id), taskId: String(row.task_id), text: String(row.text), state: String(row.state) }));
  }
  hasPending(taskId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM events WHERE task_id=? AND state='pending' LIMIT 1").get(taskId);
  }
  /** Pending follow-ups on a settled work were never processed; record that rather than leaving them pending. */
  failPendingEvents(taskId: string, reason: string) {
    this.transaction(() => {
      for (const event of this.db.prepare("SELECT id FROM events WHERE task_id=? AND state='pending' ORDER BY rowid").all(taskId)) {
        this.db.prepare("UPDATE events SET state='failed' WHERE id=?").run(String(event.id));
        this.conversation.followupState(String(event.id), 'failed');
        this.notice(taskId, 'followup_failed', `补充要求未被处理：${reason}`);
      }
    });
  }
  operation(op: Operation) {
    this.transaction(() => {
      const previous = this.db.prepare('SELECT body FROM operations WHERE id=?').get(op.id);
      this.db.prepare('INSERT INTO operations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(op.id, op.taskId, JSON.stringify(op));
      if (previous && (JSON.parse(String(previous.body)) as Operation).status === op.status) return;
      const task = this.get(op.taskId);
      this.conversation.emit({ type: 'trace', kind: 'operation', rootId: task.originMessageId ?? task.id,
        messageId: task.originMessageId, taskId: task.id, spanId: op.id, parentSpanId: op.parentSpanId ?? task.id,
        actor: op.fileId.startsWith('native:') || op.status === 'requested' ? 'worker' : 'executor',
        label: op.fileId.startsWith('native:') ? `本机工具 · ${op.fileId.slice(7)}` : '读取文件副本', status: op.status,
        data: { fileId: op.fileId, fileName: task.files.find(file => file.id === op.fileId)?.name,
          resultRef: op.result === undefined ? undefined : op.id, preview: op.result?.slice(0, 512), error: op.error } });
    });
  }
  operations(taskId: string): Operation[] {
    return this.db.prepare('SELECT body FROM operations WHERE task_id=? ORDER BY rowid').all(taskId).map(row => JSON.parse(String(row.body)) as Operation);
  }
  notice(taskId: string, kind: string, text: string) {
    this.db.prepare('INSERT INTO notices(task_id,kind,text,at) VALUES(?,?,?,?)').run(taskId, kind, text.length > 4096 ? text.slice(0, 4096) + '\n[notice truncated; use get for the full task report]' : text, Date.now());
    const task = this.get(taskId);
    this.conversation.emit({ type: 'trace', kind: 'task_state', rootId: task.originMessageId ?? taskId,
      messageId: task.originMessageId, taskId, spanId: taskId, parentSpanId: task.parentSpanId,
      actor: 'system', label: task.prompt.slice(0, 100), status: kind, data: { reason: task.reason, mode: task.mode } });
  }
  notices(after = 0): Notice[] {
    return this.db.prepare('SELECT seq,task_id,kind,text,at FROM notices WHERE seq>? ORDER BY seq LIMIT 200').all(after).map(row => ({
      seq: Number(row.seq), taskId: String(row.task_id), kind: String(row.kind), text: String(row.text), at: Number(row.at),
    }));
  }
  recover() {
    this.transaction(() => {
      // Follow-ups taken by a worker whose progress cannot be proven are never silently dropped.
      for (const row of this.db.prepare("SELECT id, task_id FROM events WHERE state='processing'").all()) {
        this.db.prepare("UPDATE events SET state='failed' WHERE id=?").run(String(row.id));
        this.conversation.followupState(String(row.id), 'failed');
        this.notice(String(row.task_id), 'followup_failed', '服务重启时该补充要求仍在处理中，无法证明已送达；不会自动重发。');
      }
      for (const task of this.list()) {
        for (const op of this.operations(task.id)) {
          if (['requested', 'started', 'cancel_requested'].includes(op.status)) {
            op.status = 'unknown'; this.operation(op);
          }
        }
        if (task.status !== 'running' && task.status !== 'queued') continue;
        task.revision++;
        task.status = 'paused';
        task.reason = '服务已重启：先前模型/交付进度与已用时间无法证明，不会自动重放。';
        this.save(task);
        this.notice(task.id, 'paused', task.reason);
      }
      this.conversation.recover();
    });
  }
  close() { this.db.close(); }
}

import type { DatabaseSync } from 'node:sqlite';
import type { Conversation } from '../conversation.js';
import type { InputFile } from '../files.js';
import type { DecisionSource, ModelTier, PendingQuestion, QualityGateAssessment, RunInitiator, ThinkingLevel, MessageOrigin, WorkerProfile } from '../view.js';

export type TaskStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface Task {
  origin?: MessageOrigin;
  id: string;
  requestId: string;
  fingerprint: string;
  prompt: string;
  status: TaskStatus;
  revision: number;
  files: InputFile[];
  mode: 'real' | 'offline';
  createdAt: number;
  limitMs: number;
  activeMs: number;
  report?: string;
  reason?: string;
  sessionFile?: string;
  sessionId?: string;
  originMessageId?: string;
  parentTaskId?: string;
  parentSpanId?: string;
  execution?: 'native' | 'snapshot';
  cwd?: string;
  paths?: string[];
  contextBrief?: string;
  memoryIds?: string[];
  profile?: WorkerProfile;
  workerModel?: string;
  modelTier?: ModelTier;
  thinkingLevel?: ThinkingLevel;
  decisionSource?: DecisionSource;
  decisionConfidence?: number;
  skipQualityGate?: boolean;
  qualityGate?: QualityGateAssessment;
  pendingQuestion?: PendingQuestion;
  initiator?: RunInitiator;
  timerId?: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  text: string;
  state: string;
}

export interface Operation {
  id: string;
  taskId: string;
  revision: number;
  fileId: string;
  status: 'requested' | 'started' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'unknown';
  result?: string;
  error?: string;
  parentSpanId?: string;
}

export interface Notice {
  seq: number;
  taskId: string;
  kind: string;
  text: string;
  at: number;
}

export interface TaskListOptions {
  limit?: number;
  offset?: number;
}

export interface TaskPatchOptions {
  expectedRevision?: number;
}

/**
 * Thrown by `TaskStore.patch` when the stored `task.revision` does not match
 * the caller's `expectedRevision` under SQLite CAS.
 */
export class TaskConflictError extends Error {
  constructor(
    readonly taskId: string,
    readonly expectedRevision: number,
    readonly actualRevision?: number,
  ) {
    super(`Task ${taskId} revision conflict (expected ${expectedRevision}, actual ${actualRevision ?? 'missing'})`);
    this.name = 'TaskConflictError';
  }
}

function parseJsonSafe<T>(raw: unknown): T | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return undefined;
  }
}

/**
 * Persistence and recovery for background worker tasks, follow-up events,
 * tool/file operations, and task state notices.
 */
export class TaskStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly atomic: <T>(run: () => T) => T,
    private readonly conversation: Conversation,
  ) {}

  create(task: Task): void {
    this.atomic(() => {
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(task.id, task.requestId, JSON.stringify(task));
      this.notice(task.id, 'accepted', `Task accepted (${task.mode})`);
    });
  }

  get(id: string): Task {
    const exact = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id);
    if (exact) {
      const parsed = parseJsonSafe<Task>(exact.body);
      if (!parsed) throw new Error('Corrupt task record');
      return parsed;
    }

    const prefix = id.trim();
    if (prefix.length >= 6) {
      const matches = this.db.prepare('SELECT id, body FROM tasks WHERE substr(id, 1, ?) = ? LIMIT 5').all(prefix.length, prefix);
      if (matches.length === 1) {
        const parsed = parseJsonSafe<Task>(matches[0]!.body);
        if (!parsed) throw new Error('Corrupt task record');
        return parsed;
      }
      if (matches.length > 1) {
        const candidates = matches.map(m => String(m.id).slice(0, 8)).join(', ');
        throw new Error(`Ambiguous task ID prefix "${prefix}" matches multiple tasks (${candidates})`);
      }
    }
    throw new Error('Task not found');
  }

  byRequest(requestId: string): Task | undefined {
    const row = this.db.prepare('SELECT body FROM tasks WHERE request_id=?').get(requestId);
    return row ? parseJsonSafe<Task>(row.body) : undefined;
  }

  list(limitOrOptions?: number | TaskListOptions): Task[] {
    const opts = typeof limitOrOptions === 'number'
      ? { limit: limitOrOptions, offset: 0 }
      : (limitOrOptions ?? {});
    const limit = opts.limit;
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const rows = limit === undefined
      ? (offset > 0
          ? this.db.prepare('SELECT body FROM tasks ORDER BY rowid DESC LIMIT -1 OFFSET ?').all(offset).reverse()
          : this.db.prepare('SELECT body FROM tasks ORDER BY rowid').all())
      : this.db.prepare('SELECT body FROM tasks ORDER BY rowid DESC LIMIT ? OFFSET ?').all(Math.max(0, Math.floor(limit)), offset).reverse();
    const tasks: Task[] = [];
    for (const row of rows) {
      const parsed = parseJsonSafe<Task>(row.body);
      if (parsed) tasks.push(parsed);
    }
    return tasks;
  }

  countTasks(): number {
    return Number(this.db.prepare('SELECT count(*) AS cnt FROM tasks').get()?.cnt ?? 0);
  }

  countOrphanTasks(): number {
    return Number(
      this.db.prepare("SELECT count(*) AS cnt FROM tasks WHERE json_valid(body)=1 AND (CASE WHEN json_valid(body) THEN json_extract(body, '$.originMessageId') END) IS NULL").get()?.cnt ?? 0,
    );
  }

  listOrphanTasks(limit = 200): Task[] {
    const safeLimit = Math.max(1, Math.floor(limit));
    const rows = this.db.prepare(
      "SELECT body FROM tasks WHERE json_valid(body)=1 AND (CASE WHEN json_valid(body) THEN json_extract(body, '$.originMessageId') END) IS NULL ORDER BY rowid DESC LIMIT ?",
    ).all(safeLimit);
    const tasks: Task[] = [];
    for (const row of rows) {
      const parsed = parseJsonSafe<Task>(row.body);
      if (parsed) tasks.push(parsed);
    }
    return tasks;
  }

  /**
   * Targeted loader for Mindmap snapshots: loads only tasks referenced by visible
   * user turns (`originMessageId` or linked `taskIds`), avoiding decoding the full archive.
   */
  listTasksForMindmap(originMessageIds: string[], taskIds: string[] = []): Task[] {
    const byId = new Map<string, Task>();
    const pushRows = (rows: Array<Record<string, unknown>>) => {
      for (const row of rows) {
        const task = parseJsonSafe<Task>(row.body);
        if (task && !byId.has(task.id)) byId.set(task.id, task);
      }
    };

    const uniqueOriginIds = [...new Set(originMessageIds.filter(Boolean))];
    for (let i = 0; i < uniqueOriginIds.length; i += 200) {
      const chunk = uniqueOriginIds.slice(i, i + 200);
      const placeholders = chunk.map(() => '?').join(',');
      pushRows(
        this.db.prepare(`SELECT body FROM tasks WHERE (CASE WHEN json_valid(body) THEN json_extract(body, '$.originMessageId') END) IN (${placeholders})`).all(...chunk) as Array<Record<string, unknown>>,
      );
    }

    const missingTaskIds = [...new Set(taskIds.filter(id => Boolean(id) && !byId.has(id)))];
    for (let i = 0; i < missingTaskIds.length; i += 200) {
      const chunk = missingTaskIds.slice(i, i + 200);
      const placeholders = chunk.map(() => '?').join(',');
      pushRows(
        this.db.prepare(`SELECT body FROM tasks WHERE id IN (${placeholders})`).all(...chunk) as Array<Record<string, unknown>>,
      );
    }
    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  save(task: Task): void {
    this.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(task), task.id);
  }

  /**
   * Atomically updates a task using optimistic-lock revision CAS validation.
   * Throws `TaskConflictError` if `expectedRevision` does not match the stored revision.
   */
  patch(id: string, updater: (current: Task) => Task | void, options?: TaskPatchOptions): Task {
    return this.atomic(() => {
      const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id);
      if (!row) throw new Error('Task not found');
      const current = parseJsonSafe<Task>(row.body);
      if (!current) throw new Error('Corrupt task record');
      const expectedRevision = options?.expectedRevision ?? current.revision;
      if (current.revision !== expectedRevision) {
        throw new TaskConflictError(id, expectedRevision, current.revision);
      }
      const draft = structuredClone(current);
      const updated = updater(draft) ?? draft;
      updated.id = current.id;
      updated.revision = expectedRevision + 1;
      const result = this.db.prepare(
        "UPDATE tasks SET body=? WHERE id=? AND CAST(CASE WHEN json_valid(body) THEN json_extract(body, '$.revision') END AS INTEGER)=?",
      ).run(JSON.stringify(updated), id, expectedRevision);
      if (result.changes !== 1) {
        const latestRow = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id);
        const actualRevision = latestRow ? parseJsonSafe<Task>(latestRow.body)?.revision : undefined;
        throw new TaskConflictError(id, expectedRevision, actualRevision);
      }
      return updated;
    });
  }

  transition(id: string, status: TaskStatus, reason?: string, report?: string): Task {
    return this.atomic(() => {
      const task = this.get(id);
      task.status = status;
      task.reason = reason;
      if (['completed', 'failed', 'cancelled'].includes(status)) delete task.pendingQuestion;
      if (report !== undefined) task.report = report;
      else if (status !== 'completed') delete task.report;
      this.save(task);
      this.notice(task.id, status, report ?? reason ?? status);
      return task;
    });
  }

  addEvent(id: string, taskId: string, text: string): boolean {
    return this.atomic(() => {
      const row = this.db.prepare('SELECT task_id, text FROM events WHERE id=?').get(id);
      if (row) {
        if (row.task_id !== taskId || row.text !== text) throw new Error('Request ID already used for a different follow-up');
        return false;
      }
      this.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(id, taskId, text, 'pending');
      this.notice(taskId, 'followup', 'Follow-up accepted');
      return true;
    });
  }

  takeEvents(taskId: string): TaskEvent[] {
    return this.atomic(() => {
      const events = this.db.prepare("SELECT * FROM events WHERE task_id=? AND state='pending' ORDER BY rowid").all(taskId);
      this.db.prepare("UPDATE events SET state='processing' WHERE task_id=? AND state='pending'").run(taskId);
      for (const row of events) this.conversation.followupState(String(row.id), 'processing');
      return events.map(row => ({ id: String(row.id), taskId, text: String(row.text), state: 'processing' }));
    });
  }

  finishEvents(events: TaskEvent[]): void {
    this.atomic(() => {
      for (const event of events) {
        this.db.prepare("UPDATE events SET state='done' WHERE id=?").run(event.id);
        this.conversation.followupState(event.id, 'done');
      }
    });
  }

  /** A taken follow-up whose delivery failed must stay visible instead of vanishing in `processing`. */
  abandonEvents(events: TaskEvent[], reason: string): void {
    this.atomic(() => {
      for (const event of events) {
        const row = this.db.prepare('SELECT state FROM events WHERE id=?').get(event.id);
        if (row?.state !== 'processing') continue;
        this.db.prepare("UPDATE events SET state='failed' WHERE id=?").run(event.id);
        this.conversation.followupState(event.id, 'failed');
        this.notice(event.taskId, 'followup_failed', `补充要求未送达 Worker：${reason}`);
      }
    });
  }

  events(taskId: string): TaskEvent[] {
    return this.db.prepare('SELECT id,task_id,text,state FROM events WHERE task_id=? ORDER BY rowid').all(taskId)
      .map(row => ({ id: String(row.id), taskId: String(row.task_id), text: String(row.text), state: String(row.state) }));
  }

  hasPending(taskId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM events WHERE task_id=? AND state='pending' LIMIT 1").get(taskId);
  }

  /** Pending follow-ups on a settled work were never processed; record that rather than leaving them pending. */
  failPendingEvents(taskId: string, reason: string): void {
    this.atomic(() => {
      for (const event of this.db.prepare("SELECT id FROM events WHERE task_id=? AND state='pending' ORDER BY rowid").all(taskId)) {
        this.db.prepare("UPDATE events SET state='failed' WHERE id=?").run(String(event.id));
        this.conversation.followupState(String(event.id), 'failed');
        this.notice(taskId, 'followup_failed', `补充要求未被处理：${reason}`);
      }
    });
  }

  operation(op: Operation): void {
    this.atomic(() => {
      const previous = this.db.prepare('SELECT body FROM operations WHERE id=?').get(op.id);
      this.db.prepare('INSERT INTO operations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(op.id, op.taskId, JSON.stringify(op));
      if (previous && (JSON.parse(String(previous.body)) as Operation).status === op.status) return;
      const task = this.get(op.taskId);
      this.conversation.emit({
        type: 'trace',
        kind: 'operation',
        rootId: task.originMessageId ?? task.id,
        messageId: task.originMessageId,
        taskId: task.id,
        spanId: op.id,
        parentSpanId: op.parentSpanId ?? task.id,
        actor: op.fileId.startsWith('native:') || op.status === 'requested' ? 'worker' : 'executor',
        label: op.fileId.startsWith('native:') ? `本机工具 · ${op.fileId.slice(7)}` : '读取文件副本',
        status: op.status,
        data: {
          fileId: op.fileId,
          fileName: task.files.find(file => file.id === op.fileId)?.name,
          resultRef: op.result === undefined ? undefined : op.id,
          preview: op.result?.slice(0, 512),
          error: op.error,
        },
      });
    });
  }

  operationById(id: string, taskId?: string): Operation | undefined {
    const row = taskId === undefined
      ? this.db.prepare('SELECT body FROM operations WHERE id=?').get(id)
      : this.db.prepare('SELECT body FROM operations WHERE id=? AND task_id=?').get(id, taskId);
    return row ? parseJsonSafe<Operation>(row.body) : undefined;
  }

  operations(taskId: string): Operation[] {
    const out: Operation[] = [];
    for (const row of this.db.prepare('SELECT body FROM operations WHERE task_id=? ORDER BY rowid').all(taskId)) {
      const op = parseJsonSafe<Operation>(row.body);
      if (op) out.push(op);
    }
    return out;
  }

  acknowledgeUnsettledOperations(taskId: string): void {
    this.atomic(() => {
      for (const op of this.operations(taskId)) {
        if (['requested', 'started', 'cancel_requested', 'unknown'].includes(op.status)) {
          op.status = 'cancelled';
          op.error = op.error ? `${op.error}（用户已确认续跑并核销）` : '用户已确认续跑，核销未确认操作';
          this.operation(op);
        }
      }
    });
  }

  notice(taskId: string, kind: string, text: string): void {
    const clippedText = text.length > 4096
      ? text.slice(0, 4096) + '\n[notice truncated; use get for the full task report]'
      : text;
    this.atomic(() => {
      this.db.prepare('INSERT INTO notices(task_id,kind,text,at) VALUES(?,?,?,?)').run(
        taskId,
        kind,
        clippedText,
        Date.now(),
      );
      const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(taskId);
      if (!row) return;
      const task = parseJsonSafe<Task>(row.body);
      if (!task) return;
      const includeText = kind === 'followup' || kind === 'followup_failed';
      this.conversation.emit({
        type: 'trace',
        kind: 'task_state',
        rootId: task.originMessageId ?? taskId,
        messageId: task.originMessageId,
        taskId,
        spanId: taskId,
        parentSpanId: task.parentSpanId,
        actor: 'system',
        label: task.prompt.slice(0, 100),
        status: kind,
        data: {
          ...(includeText ? { text: clippedText } : {}),
          reason: task.reason,
          mode: task.mode,
        },
      });
    });
  }

  notices(after = 0): Notice[] {
    return this.db.prepare('SELECT seq,task_id,kind,text,at FROM notices WHERE seq>? ORDER BY seq LIMIT 200').all(after).map(row => ({
      seq: Number(row.seq),
      taskId: String(row.task_id),
      kind: String(row.kind),
      text: String(row.text),
      at: Number(row.at),
    }));
  }

  recoverTasks(): void {
    this.atomic(() => {
      // Follow-ups taken by a worker whose progress cannot be proven are never silently dropped.
      for (const row of this.db.prepare("SELECT id, task_id FROM events WHERE state='processing'").all()) {
        this.db.prepare("UPDATE events SET state='failed' WHERE id=?").run(String(row.id));
        this.conversation.followupState(String(row.id), 'failed');
        this.notice(String(row.task_id), 'followup_failed', '服务重启时该补充要求仍在处理中，无法证明已送达；不会自动重发。');
      }
      for (const row of this.db.prepare("SELECT body FROM operations WHERE (CASE WHEN json_valid(body) THEN json_extract(body,'$.status') END) IN ('requested','started','cancel_requested') ORDER BY rowid").all()) {
        const op = parseJsonSafe<Operation>(row.body);
        if (!op) continue;
        op.status = 'unknown';
        this.operation(op);
      }
      for (const row of this.db.prepare("SELECT body FROM tasks WHERE (CASE WHEN json_valid(body) THEN json_extract(body,'$.status') END) IN ('running','queued') ORDER BY rowid").all()) {
        const task = parseJsonSafe<Task>(row.body);
        if (!task) continue;
        const priorQuestion = task.pendingQuestion?.question;
        delete task.pendingQuestion;
        task.revision++;
        task.status = 'paused';
        task.reason = priorQuestion
          ? `服务已重启：中断前正在等待老板拍板（「${priorQuestion.slice(0, 120)}」），先前进度无法自动重放。`
          : '服务已重启：先前模型/交付进度与已用时间无法证明，不会自动重放。';
        this.save(task);
        this.notice(task.id, 'paused', task.reason);
      }
    });
  }
}

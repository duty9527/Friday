import type { DatabaseSync } from 'node:sqlite';
import { publicData } from './conversation.js';
import { RESPONSE_LIMIT } from './protocol.js';
import type { Store, Task } from './store.js';
import type { ChatMessage, MessageOrigin, TraceEvent } from './view.js';

export interface ExecutionTraceOperationSummary {
  id: string;
  fileId: string;
  status: string;
  parentSpanId?: string;
  error?: string;
  resultPreview?: string;
  resultTruncated?: boolean;
  hasFullResult: boolean;
}

export interface ExecutionTraceMemoryBrief {
  id: string;
  topic: string;
  tags: string[];
  preview: string;
}

export interface ExecutionTraceTaskSummary {
  id: string;
  parentTaskId?: string;
  originMessageId?: string;
  prompt: string;
  status: string;
  createdAt: number;
  activeMs: number;
  limitMs: number;
  cwd?: string;
  profile?: string;
  workerModel?: string;
  modelTier?: string;
  thinkingLevel?: string;
  decisionSource?: string;
  decisionConfidence?: number;
  skipQualityGate?: boolean;
  qualityGate?: Record<string, unknown>;
  contextBrief?: string;
  reason?: string;
  report?: string;
  pendingQuestion?: { question: string; options?: string[]; askedAt: number };
  followups: Array<{ id: string; text: string; state: string }>;
  memories: ExecutionTraceMemoryBrief[];
  operations: ExecutionTraceOperationSummary[];
}

export interface ExecutionTraceBundle {
  scope: { type: 'all' | 'task' | 'message'; id?: string };
  cursor: number;
  events: TraceEvent[];
  streamedTextBySpan: Record<string, string>;
  messages: ChatMessage[];
  task?: ExecutionTraceTaskSummary;
  linkedTasks: Array<{
    id: string;
    prompt: string;
    status: string;
    profile?: string;
    workerModel?: string;
    modelTier?: string;
    thinkingLevel?: string;
    activeMs: number;
    createdAt: number;
  }>;
}

const DEFAULT_EVENT_LIMIT = 1200;
const MIN_EVENT_LIMIT = 50;
const MAX_EVENT_LIMIT = 2500;
const MAX_STREAMED_SPAN_CHARS = 4096;
const MAX_BUNDLE_BYTES = Math.min(512 * 1024, Math.floor(RESPONSE_LIMIT / 4));
const EXCLUDED_EVENT_KINDS = new Set(['visible_text', 'message_updated']);

function parseJsonSafe<T>(raw: unknown): T | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return undefined;
  }
}

function getReadonlyDb(store: Store): DatabaseSync {
  const rec = store as unknown as {
    sqlite?: { db?: DatabaseSync };
    conversation?: { db?: DatabaseSync };
  };
  const db = rec.sqlite?.db ?? rec.conversation?.db;
  if (!db) throw new Error('Database handle is unavailable');
  return db;
}

function clampLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_EVENT_LIMIT;
  return Math.max(MIN_EVENT_LIMIT, Math.min(MAX_EVENT_LIMIT, Math.floor(limit)));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function clipPreview(text: string, maxLen: number): { text: string; truncated: boolean } {
  if (text.length <= maxLen) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxLen - 1))}…`, truncated: true };
}

function sanitizeOrigin(origin?: MessageOrigin): MessageOrigin | undefined {
  if (!origin) return undefined;
  const { contextToken: _contextToken, replyWebhook: _replyWebhook, ...rest } = origin;
  return rest;
}

function stripSensitiveOriginKeys(value: unknown, depth = 0): unknown {
  if (depth > 6 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => stripSensitiveOriginKeys(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'contextToken' || key === 'replyWebhook') continue;
    out[key] = stripSensitiveOriginKeys(item, depth + 1);
  }
  return out;
}

function redactTraceValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  return stripSensitiveOriginKeys(publicData(value));
}

function sanitizeMessage(msg: ChatMessage): ChatMessage {
  if (!msg.origin) return { ...msg };
  return {
    ...msg,
    origin: sanitizeOrigin(msg.origin),
  };
}

function decodeMessageRows(db: DatabaseSync, rows: Array<Record<string, unknown>>): ChatMessage[] {
  if (!rows.length) return [];
  const messages: ChatMessage[] = [];
  const seenIds = new Set<string>();
  for (const row of rows) {
    const parsed = parseJsonSafe<ChatMessage>(row.body);
    if (!parsed || !parsed.id || seenIds.has(parsed.id)) continue;
    seenIds.add(parsed.id);
    parsed.seq = Number(row.seq);
    messages.push(parsed);
  }
  if (!messages.length) return [];

  const versionMap = new Map<string, number>();
  const taskIdsMap = new Map<string, string[]>();
  const ids = messages.map(m => m.id);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const placeholders = chunk.map(() => '?').join(',');
    const vRows = db.prepare(
      `SELECT message_id, coalesce(max(seq),0) AS seq FROM journal WHERE message_id IN (${placeholders}) GROUP BY message_id`,
    ).all(...chunk) as Array<Record<string, unknown>>;
    for (const vr of vRows) {
      versionMap.set(String(vr.message_id), Number(vr.seq));
    }
    const tRows = db.prepare(
      `SELECT message_id, task_id FROM message_tasks WHERE message_id IN (${placeholders}) ORDER BY rowid`,
    ).all(...chunk) as Array<Record<string, unknown>>;
    for (const tr of tRows) {
      const mid = String(tr.message_id);
      let list = taskIdsMap.get(mid);
      if (!list) {
        list = [];
        taskIdsMap.set(mid, list);
      }
      list.push(String(tr.task_id));
    }
  }

  return messages
    .map(msg => {
      const sanitized = sanitizeMessage(msg);
      sanitized.version = versionMap.get(msg.id) ?? msg.version ?? 0;
      sanitized.taskIds = taskIdsMap.get(msg.id) ?? msg.taskIds ?? [];
      return sanitized;
    })
    .sort((a, b) => a.seq - b.seq);
}

function loadMessagesByIds(db: DatabaseSync, ids: Iterable<string>): ChatMessage[] {
  const unique = [...new Set([...ids].filter(Boolean))];
  if (!unique.length) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const placeholders = chunk.map(() => '?').join(',');
    const part = db.prepare(`SELECT seq, body FROM messages WHERE id IN (${placeholders}) ORDER BY seq ASC`)
      .all(...chunk) as Array<Record<string, unknown>>;
    rows.push(...part);
  }
  return decodeMessageRows(db, rows);
}

function loadReplyMessages(db: DatabaseSync, parentIds: Iterable<string>): ChatMessage[] {
  const unique = [...new Set([...parentIds].filter(Boolean))];
  if (!unique.length) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const placeholders = chunk.map(() => '?').join(',');
    const part = db.prepare(
      `SELECT seq, body FROM messages WHERE (CASE WHEN json_valid(body) THEN json_extract(body,'$.replyTo') END) IN (${placeholders}) ORDER BY seq ASC`,
    ).all(...chunk) as Array<Record<string, unknown>>;
    rows.push(...part);
  }
  return decodeMessageRows(db, rows);
}

function loadTasksByIds(db: DatabaseSync, ids: Iterable<string>): Task[] {
  const unique = [...new Set([...ids].filter(Boolean))];
  if (!unique.length) return [];
  const tasks: Task[] = [];
  for (let i = 0; i < unique.length; i += 200) {
    const chunk = unique.slice(i, i + 200);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(`SELECT body FROM tasks WHERE id IN (${placeholders})`)
      .all(...chunk) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const parsed = parseJsonSafe<Task>(row.body);
      if (parsed) tasks.push(parsed);
    }
  }
  return tasks.sort((a, b) => a.createdAt - b.createdAt);
}

function toLinkedTaskSummary(task: Task): ExecutionTraceBundle['linkedTasks'][number] {
  return {
    id: task.id,
    prompt: clipPreview(String(publicData(task.prompt)), 400).text,
    status: task.status,
    ...(task.profile ? { profile: task.profile } : {}),
    ...(task.workerModel ? { workerModel: task.workerModel } : {}),
    ...(task.modelTier ? { modelTier: task.modelTier } : {}),
    ...(task.thinkingLevel ? { thinkingLevel: task.thinkingLevel } : {}),
    activeMs: Math.round(task.activeMs),
    createdAt: task.createdAt,
  };
}

function buildTaskSummary(store: Store, task: Task): ExecutionTraceTaskSummary {
  const ops = store.operations(task.id).map((op): ExecutionTraceOperationSummary => {
    const safeError = op.error !== undefined ? clipPreview(String(publicData(op.error)), 600).text : undefined;
    let resultPreview: string | undefined;
    let resultTruncated: boolean | undefined;
    const hasFullResult = typeof op.result === 'string' && op.result.length > 0;
    if (op.result !== undefined) {
      const safeResult = String(publicData(op.result.slice(0, 4096)));
      const clipped = clipPreview(safeResult, 1000);
      resultPreview = clipped.text;
      resultTruncated = op.result.length > 1000 || clipped.truncated || safeResult.length < op.result.length;
    }
    return {
      id: op.id,
      fileId: op.fileId,
      status: op.status,
      ...(op.parentSpanId ? { parentSpanId: op.parentSpanId } : {}),
      ...(safeError ? { error: safeError } : {}),
      ...(resultPreview !== undefined ? { resultPreview, resultTruncated } : {}),
      hasFullResult,
    };
  });

  const followups = store.events(task.id).map(({ id, text, state }) => ({
    id,
    text: String(publicData(text)),
    state,
  }));

  const memories: ExecutionTraceMemoryBrief[] = [];
  const seenMemIds = new Set<string>();
  for (const memId of task.memoryIds ?? []) {
    if (!memId || seenMemIds.has(memId)) continue;
    seenMemIds.add(memId);
    try {
      const card = store.getMemory(memId);
      const normalizedContent = String(publicData(card.content)).replace(/\s+/g, ' ').trim();
      memories.push({
        id: card.id,
        topic: String(publicData(card.topic)),
        tags: card.tags.map(tag => String(publicData(tag))),
        preview: clipPreview(normalizedContent, 280).text,
      });
    } catch {
      // Skip deleted or missing memory cards cleanly.
    }
  }

  return {
    id: task.id,
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.originMessageId ? { originMessageId: task.originMessageId } : {}),
    prompt: String(publicData(task.prompt)),
    status: task.status,
    createdAt: task.createdAt,
    activeMs: Math.round(task.activeMs),
    limitMs: task.limitMs,
    ...(task.cwd ? { cwd: task.cwd } : {}),
    ...(task.profile ? { profile: task.profile } : {}),
    ...(task.workerModel ? { workerModel: task.workerModel } : {}),
    ...(task.modelTier ? { modelTier: task.modelTier } : {}),
    ...(task.thinkingLevel ? { thinkingLevel: task.thinkingLevel } : {}),
    ...(task.decisionSource ? { decisionSource: task.decisionSource } : {}),
    ...(task.decisionConfidence !== undefined ? { decisionConfidence: task.decisionConfidence } : {}),
    ...(task.skipQualityGate !== undefined ? { skipQualityGate: task.skipQualityGate } : {}),
    ...(task.qualityGate ? { qualityGate: redactTraceValue(task.qualityGate) as Record<string, unknown> } : {}),
    ...(task.contextBrief ? { contextBrief: String(publicData(task.contextBrief)) } : {}),
    ...(task.reason ? { reason: String(publicData(task.reason)) } : {}),
    ...(task.report ? { report: String(publicData(task.report)) } : {}),
    ...(task.pendingQuestion
      ? {
          pendingQuestion: {
            question: String(publicData(task.pendingQuestion.question)),
            ...(task.pendingQuestion.options ? { options: task.pendingQuestion.options.map(o => String(publicData(o))) } : {}),
            askedAt: task.pendingQuestion.askedAt,
          },
        }
      : {}),
    followups,
    memories,
    operations: ops,
  };
}

function parseJournalRows(rows: Array<Record<string, unknown>>): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (const row of rows) {
    const parsed = parseJsonSafe<TraceEvent>(row.body);
    if (!parsed) continue;
    out.push({
      ...parsed,
      seq: Number(row.seq),
      ...(parsed.data !== undefined ? { data: redactTraceValue(parsed.data) } : {}),
    });
  }
  return out;
}

function ingestJournalRows(
  rows: Array<Record<string, unknown>>,
  structuredBySeq: Map<number, TraceEvent>,
  visibleBySeq: Map<number, TraceEvent>,
): TraceEvent[] {
  const decoded = parseJournalRows(rows);
  for (const ev of decoded) {
    if (ev.kind === 'visible_text') {
      if (!visibleBySeq.has(ev.seq)) visibleBySeq.set(ev.seq, ev);
    } else if (!EXCLUDED_EVENT_KINDS.has(ev.kind)) {
      if (!structuredBySeq.has(ev.seq)) structuredBySeq.set(ev.seq, ev);
    }
  }
  return decoded;
}

function aggregateStreamedText(visibleEvents: Iterable<TraceEvent>): Record<string, string> {
  const ordered = [...visibleEvents].sort((a, b) => a.seq - b.seq);
  const streamedTextBySpan: Record<string, string> = {};
  for (const ev of ordered) {
    if (!ev.spanId) continue;
    const chunk = asRecord(ev.data)?.text;
    if (typeof chunk !== 'string' || !chunk) continue;
    const prev = streamedTextBySpan[ev.spanId] ?? '';
    if (prev.length >= MAX_STREAMED_SPAN_CHARS) continue;
    const safeChunk = String(publicData(chunk));
    const remaining = MAX_STREAMED_SPAN_CHARS - prev.length;
    streamedTextBySpan[ev.spanId] = prev + safeChunk.slice(0, remaining);
  }
  return streamedTextBySpan;
}

function preserveHeadTail<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const headCount = Math.max(10, Math.floor(limit * 0.35));
  const tailCount = Math.max(1, limit - headCount);
  if (headCount + tailCount >= items.length) return items;
  return [...items.slice(0, headCount), ...items.slice(items.length - tailCount)];
}

function extractRouteActionTaskId(ev: TraceEvent): string | undefined {
  if (ev.taskId) return ev.taskId;
  const data = asRecord(ev.data);
  return typeof data?.taskId === 'string' && data.taskId ? data.taskId : undefined;
}

function compactEventDetail(ev: TraceEvent): TraceEvent {
  const data = asRecord(ev.data);
  if (!data) return ev;
  let changed = false;
  const nextData: Record<string, unknown> = { ...data };
  if (data.detail !== undefined) {
    const encodedDetail = JSON.stringify(data.detail);
    if (encodedDetail && encodedDetail.length > 260) {
      nextData.detail = { preview: encodedDetail.slice(0, 200), truncated: true };
      changed = true;
    }
  }
  if (data.input !== undefined) {
    const encodedInput = JSON.stringify(data.input);
    if (encodedInput && encodedInput.length > 260) {
      nextData.input = { truncated: true };
      changed = true;
    }
  }
  if (typeof data.output === 'string' && data.output.length > 300) {
    nextData.output = `${data.output.slice(0, 280)}…`;
    nextData.outputTruncated = true;
    changed = true;
  }
  if (!changed && JSON.stringify(data).length > 500) {
    const trigger = data.trigger;
    const summary = data.summary;
    const mode = data.mode;
    return {
      ...ev,
      data: {
        ...(mode !== undefined ? { mode } : {}),
        ...(trigger !== undefined ? { trigger } : {}),
        ...(summary !== undefined ? { summary } : {}),
        truncated: true,
      },
    };
  }
  return changed ? { ...ev, data: nextData } : ev;
}

function enforcePayloadBudget(bundle: ExecutionTraceBundle, maxBytes = MAX_BUNDLE_BYTES): ExecutionTraceBundle {
  const byteSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (byteSize(bundle) <= maxBytes) return bundle;

  const events = bundle.events.slice();
  const len = events.length;
  const headEdge = Math.min(len, Math.max(8, Math.floor(len * 0.2)));
  const tailEdge = Math.max(headEdge, len - Math.max(12, Math.floor(len * 0.3)));

  // 1) Gently compact middle event details first, then early events, then tail events if still huge.
  const compactRange = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      events[i] = compactEventDetail(events[i]!);
    }
  };
  compactRange(headEdge, tailEdge);
  let nextBundle: ExecutionTraceBundle = { ...bundle, events };
  if (byteSize(nextBundle) <= maxBytes) return nextBundle;

  compactRange(0, headEdge);
  nextBundle = { ...nextBundle, events };
  if (byteSize(nextBundle) <= maxBytes) return nextBundle;

  compactRange(tailEdge, len);
  nextBundle = { ...nextBundle, events };
  if (byteSize(nextBundle) <= maxBytes) return nextBundle;

  // 2) Trim bulky routing context snapshots inside ChatMessage history.
  const messages = nextBundle.messages.map(msg => {
    const updatedText = msg.text.length > 4096 ? `${msg.text.slice(0, 4095)}…` : msg.text;
    if (!msg.routing) {
      return updatedText === msg.text ? msg : { ...msg, text: updatedText };
    }
    return {
      ...msg,
      text: updatedText,
      routing: {
        ...msg.routing,
        context: {
          execution: msg.routing.context.execution,
          cwd: msg.routing.context.cwd,
          totalWorks: msg.routing.context.totalWorks,
          truncated: true,
          works: msg.routing.context.works.slice(-3),
          messages: msg.routing.context.messages.slice(-3),
        },
      },
    };
  });
  nextBundle = { ...nextBundle, messages };
  if (byteSize(nextBundle) <= maxBytes) return nextBundle;

  // 3) Trim long streamed text buckets and long task report/contextBrief if needed.
  const streamedTextBySpan: Record<string, string> = {};
  for (const [spanId, text] of Object.entries(nextBundle.streamedTextBySpan)) {
    streamedTextBySpan[spanId] = text.length > 1024 ? `${text.slice(0, 1023)}…` : text;
  }
  const task = nextBundle.task
    ? {
        ...nextBundle.task,
        ...(nextBundle.task.report && nextBundle.task.report.length > 4096
          ? { report: `${nextBundle.task.report.slice(0, 4095)}…` }
          : {}),
        ...(nextBundle.task.contextBrief && nextBundle.task.contextBrief.length > 2048
          ? { contextBrief: `${nextBundle.task.contextBrief.slice(0, 2047)}…` }
          : {}),
      }
    : undefined;
  nextBundle = { ...nextBundle, streamedTextBySpan, ...(task ? { task } : {}) };
  if (byteSize(nextBundle) <= maxBytes) return nextBundle;

  // 4) Final safety cap: drop middle events progressively while preserving head & tail.
  let prunedEvents = nextBundle.events;
  while (prunedEvents.length > 40 && byteSize({ ...nextBundle, events: prunedEvents }) > maxBytes) {
    const keepHead = Math.max(12, Math.floor(prunedEvents.length * 0.25));
    const keepTail = Math.max(16, Math.floor(prunedEvents.length * 0.45));
    if (keepHead + keepTail >= prunedEvents.length) break;
    prunedEvents = [...prunedEvents.slice(0, keepHead), ...prunedEvents.slice(prunedEvents.length - keepTail)];
  }
  nextBundle = { ...nextBundle, events: prunedEvents };
  if (byteSize(nextBundle) > maxBytes) {
    const activeSpanIds = new Set(prunedEvents.map(ev => ev.spanId).filter((s): s is string => Boolean(s)));
    const compactStreams: Record<string, string> = {};
    for (const [spanId, text] of Object.entries(nextBundle.streamedTextBySpan)) {
      if (activeSpanIds.has(spanId)) {
        compactStreams[spanId] = text.length > 256 ? `${text.slice(0, 255)}…` : text;
      }
    }
    nextBundle = { ...nextBundle, streamedTextBySpan: compactStreams };
  }
  while (nextBundle.messages.length > 4 && byteSize(nextBundle) > maxBytes) {
    nextBundle = { ...nextBundle, messages: nextBundle.messages.slice(1) };
  }
  return nextBundle;
}

function buildTaskScopeBundle(store: Store, db: DatabaseSync, rawTaskId: string, safeLimit: number): ExecutionTraceBundle {
  const task = store.get(rawTaskId);
  const taskId = task.id;
  const cursor = store.conversation.latestSeq();
  const taskSummary = buildTaskSummary(store, task);

  // 1) Find associated message IDs from task.originMessageId and message_tasks.
  const linkedMessageRows = db.prepare('SELECT message_id FROM message_tasks WHERE task_id = ?')
    .all(taskId) as Array<Record<string, unknown>>;
  const seedMessageIds = new Set<string>();
  if (task.originMessageId) seedMessageIds.add(task.originMessageId);
  for (const row of linkedMessageRows) {
    if (row.message_id) seedMessageIds.add(String(row.message_id));
  }

  // Also check trigger.taskId = taskId rows early so any unlinked reply messageId on Router summary turns is discovered.
  const triggerRows = db.prepare(
    `SELECT seq, body FROM journal
     WHERE json_valid(body) = 1
       AND json_extract(body, '$.data.trigger.taskId') = ?
     ORDER BY seq ASC`,
  ).all(taskId) as Array<Record<string, unknown>>;

  const structuredBySeq = new Map<number, TraceEvent>();
  const visibleBySeq = new Map<number, TraceEvent>();
  const triggerEvents = ingestJournalRows(triggerRows, structuredBySeq, visibleBySeq);

  const summaryRoundSpanIds = new Set<string>();
  const summaryRootIds = new Set<string>();
  const triggerMessageIds = new Set<string>();
  for (const ev of triggerEvents) {
    if (ev.spanId) summaryRoundSpanIds.add(ev.spanId);
    if (ev.rootId && (ev.rootId === taskId || summaryRoundSpanIds.has(ev.rootId))) {
      summaryRootIds.add(ev.rootId);
    }
    if (ev.messageId && ev.messageId !== task.originMessageId) {
      triggerMessageIds.add(ev.messageId);
    }
  }

  // Load seed messages and expand parent (replyTo) + non-sibling replies (replyIds).
  const initialSeedMessages = loadMessagesByIds(db, [...seedMessageIds, ...triggerMessageIds]);
  const parentIds = new Set<string>();
  for (const msg of initialSeedMessages) {
    if (msg.replyTo) parentIds.add(msg.replyTo);
  }
  const anchorIds = new Set<string>([...seedMessageIds, ...triggerMessageIds, ...parentIds]);
  const replyCandidates = loadReplyMessages(db, anchorIds);
  const allowedReplyIds = replyCandidates
    .filter(msg => {
      // Keep replies that belong to this task or are unlinked, while excluding sibling-only deliveries.
      if (msg.taskIds.length === 0 || msg.taskIds.includes(taskId)) return true;
      return triggerMessageIds.has(msg.id);
    })
    .map(msg => msg.id);

  const allMessageIds = new Set<string>([...seedMessageIds, ...parentIds, ...allowedReplyIds]);
  for (const msgId of triggerMessageIds) {
    if (seedMessageIds.has(msgId) || allowedReplyIds.includes(msgId)) {
      allMessageIds.add(msgId);
    }
  }
  const messages = loadMessagesByIds(db, allMessageIds);
  const messageById = new Map(messages.map(m => [m.id, m]));
  const userMessageIds = messages.filter(m => m.role === 'user').map(m => m.id);
  if (task.originMessageId && !userMessageIds.includes(task.originMessageId)) {
    userMessageIds.push(task.originMessageId);
  }
  const replyMessageIds = messages.filter(m => m.role !== 'user').map(m => m.id);

  // 2) Query all journal events belonging to this task:
  //    a) task_id = taskId (or root_id = taskId for standalone/orphan tasks)
  const taskRows = db.prepare(
    `SELECT seq, body FROM journal
     WHERE (task_id = ? OR root_id = ?)
       AND coalesce(CASE WHEN json_valid(body) THEN json_extract(body,'$.kind') END, '') != 'message_updated'
     ORDER BY seq ASC`,
  ).all(taskId, taskId) as Array<Record<string, unknown>>;
  ingestJournalRows(taskRows, structuredBySeq, visibleBySeq);

  //    b) originMessageId & associated user messages' Router round (task_id IS NULL, excluding sibling route_action)
  for (let i = 0; i < userMessageIds.length; i += 100) {
    const chunk = userMessageIds.slice(i, i + 100);
    const placeholders = chunk.map(() => '?').join(',');
    const originRows = db.prepare(
      `SELECT seq, body FROM journal
       WHERE message_id IN (${placeholders})
         AND task_id IS NULL
         AND coalesce(CASE WHEN json_valid(body) THEN json_extract(body,'$.kind') END, '') != 'message_updated'
       ORDER BY seq ASC`,
    ).all(...chunk) as Array<Record<string, unknown>>;
    for (const ev of parseJournalRows(originRows)) {
      if (ev.kind === 'route_action') {
        const actionTaskId = extractRouteActionTaskId(ev);
        if (actionTaskId && actionTaskId !== taskId) continue;
      }
      if (ev.kind === 'visible_text') {
        if (!visibleBySeq.has(ev.seq)) visibleBySeq.set(ev.seq, ev);
      } else if (!EXCLUDED_EVENT_KINDS.has(ev.kind)) {
        if (!structuredBySeq.has(ev.seq)) structuredBySeq.set(ev.seq, ev);
      }
    }
  }

  //    c) Associated reply messages' events (message_created and any delivery spans for this task or untagged)
  for (let i = 0; i < replyMessageIds.length; i += 100) {
    const chunk = replyMessageIds.slice(i, i + 100);
    const placeholders = chunk.map(() => '?').join(',');
    const replyRows = db.prepare(
      `SELECT seq, body FROM journal
       WHERE message_id IN (${placeholders})
         AND (task_id IS NULL OR task_id = ?)
         AND coalesce(CASE WHEN json_valid(body) THEN json_extract(body,'$.kind') END, '') != 'message_updated'
       ORDER BY seq ASC`,
    ).all(...chunk, taskId) as Array<Record<string, unknown>>;
    ingestJournalRows(replyRows, structuredBySeq, visibleBySeq);
  }

  //    d) Complete Router summary round chain via spanId / parentSpanId / rootId
  const collectBySpanLinks = (spanIds: Set<string>, rootIds: Set<string>): TraceEvent[] => {
    const collected: TraceEvent[] = [];
    const spanList = [...spanIds].filter(Boolean);
    for (let i = 0; i < spanList.length; i += 100) {
      const chunk = spanList.slice(i, i + 100);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT seq, body FROM journal
         WHERE json_valid(body) = 1
           AND (json_extract(body, '$.spanId') IN (${placeholders}) OR json_extract(body, '$.parentSpanId') IN (${placeholders}))
           AND coalesce(json_extract(body, '$.kind'), '') != 'message_updated'
         ORDER BY seq ASC`,
      ).all(...chunk, ...chunk) as Array<Record<string, unknown>>;
      collected.push(...ingestJournalRows(rows, structuredBySeq, visibleBySeq));
    }
    const rootList = [...rootIds].filter(Boolean);
    for (let i = 0; i < rootList.length; i += 100) {
      const chunk = rootList.slice(i, i + 100);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT seq, body FROM journal
         WHERE root_id IN (${placeholders})
           AND coalesce(CASE WHEN json_valid(body) THEN json_extract(body,'$.kind') END, '') != 'message_updated'
         ORDER BY seq ASC`,
      ).all(...chunk) as Array<Record<string, unknown>>;
      collected.push(...ingestJournalRows(rows, structuredBySeq, visibleBySeq));
    }
    return collected;
  };

  if (summaryRoundSpanIds.size || summaryRootIds.size) {
    const turnLevel = collectBySpanLinks(summaryRoundSpanIds, summaryRootIds);
    const turnSpanIds = new Set<string>();
    for (const ev of turnLevel) {
      if (ev.spanId && !summaryRoundSpanIds.has(ev.spanId)) turnSpanIds.add(ev.spanId);
    }
    if (turnSpanIds.size) {
      const toolLevel = collectBySpanLinks(turnSpanIds, new Set());
      const toolSpanIds = new Set<string>();
      for (const ev of toolLevel) {
        if (ev.spanId && !summaryRoundSpanIds.has(ev.spanId) && !turnSpanIds.has(ev.spanId)) {
          toolSpanIds.add(ev.spanId);
        }
      }
      if (toolSpanIds.size) {
        collectBySpanLinks(toolSpanIds, new Set());
      }
    }
  }

  // Ensure any message referenced by summary-round events (not owned exclusively by a sibling) is included.
  const extraMsgIds: string[] = [];
  for (const ev of structuredBySeq.values()) {
    if (ev.messageId && !messageById.has(ev.messageId)) extraMsgIds.push(ev.messageId);
  }
  if (extraMsgIds.length) {
    for (const msg of loadMessagesByIds(db, extraMsgIds)) {
      if (msg.taskIds.length === 0 || msg.taskIds.includes(taskId) || msg.id === task.originMessageId) {
        messages.push(msg);
        messageById.set(msg.id, msg);
      }
    }
    messages.sort((a, b) => a.seq - b.seq);
  }

  // 3) Collect related tasks (parent, children, co-origin / linked message tasks)
  const relatedTaskIds = new Set<string>();
  if (task.parentTaskId) relatedTaskIds.add(task.parentTaskId);
  const childRows = db.prepare(
    `SELECT id FROM tasks WHERE json_valid(body) = 1 AND json_extract(body, '$.parentTaskId') = ?`,
  ).all(taskId) as Array<Record<string, unknown>>;
  for (const row of childRows) {
    if (row.id) relatedTaskIds.add(String(row.id));
  }
  if (task.originMessageId) {
    const siblingOriginRows = db.prepare(
      `SELECT id FROM tasks WHERE json_valid(body) = 1 AND json_extract(body, '$.originMessageId') = ?`,
    ).all(task.originMessageId) as Array<Record<string, unknown>>;
    for (const row of siblingOriginRows) {
      if (row.id) relatedTaskIds.add(String(row.id));
    }
  }
  for (const msg of messages) {
    for (const tid of msg.taskIds) relatedTaskIds.add(tid);
  }
  relatedTaskIds.delete(taskId);

  const linkedTasks = loadTasksByIds(db, relatedTaskIds)
    .slice(0, 30)
    .map(toLinkedTaskSummary);

  const streamedTextBySpan = aggregateStreamedText(visibleBySeq.values());
  const allStructured = [...structuredBySeq.values()].sort((a, b) => a.seq - b.seq);
  const events = preserveHeadTail(allStructured, safeLimit);

  return enforcePayloadBudget({
    scope: { type: 'task', id: taskId },
    cursor,
    events,
    streamedTextBySpan,
    messages,
    task: taskSummary,
    linkedTasks,
  });
}

function buildMessageScopeBundle(store: Store, db: DatabaseSync, messageId: string, safeLimit: number): ExecutionTraceBundle {
  const target = store.conversation.get(messageId);
  const cursor = store.conversation.latestSeq();

  const replies = loadReplyMessages(db, [target.id]);
  const ownMsgIds = [target.id, ...replies.map(r => r.id)];
  const messages = loadMessagesByIds(db, ownMsgIds);

  // Tasks linked via message_tasks on target/replies or originMessageId = target.id
  const taskIds = new Set<string>();
  for (const msg of messages) {
    for (const tid of msg.taskIds) taskIds.add(tid);
  }
  const originTaskRows = db.prepare(
    `SELECT id FROM tasks WHERE json_valid(body) = 1 AND json_extract(body, '$.originMessageId') = ?`,
  ).all(target.id) as Array<Record<string, unknown>>;
  for (const row of originTaskRows) {
    if (row.id) taskIds.add(String(row.id));
  }
  const directTaskRows = db.prepare('SELECT task_id FROM message_tasks WHERE message_id = ?')
    .all(target.id) as Array<Record<string, unknown>>;
  const scopedTaskIds = directTaskRows.map(r => String(r.task_id));

  const ownPlaceholders = ownMsgIds.map(() => '?').join(',');
  const taskCondition = scopedTaskIds.length
    ? `OR task_id IN (${scopedTaskIds.map(() => '?').join(',')})`
    : '';
  const whereScope = `(root_id = ? OR message_id IN (${ownPlaceholders}) ${taskCondition}) AND (message_id IS NULL OR message_id IN (${ownPlaceholders}))`;
  const scopeArgs = [target.id, ...ownMsgIds, ...scopedTaskIds, ...ownMsgIds];

  const structuredRows = db.prepare(
    `SELECT seq, body FROM journal
     WHERE ${whereScope}
       AND coalesce(CASE WHEN json_valid(body) THEN json_extract(body,'$.kind') END, '') NOT IN ('visible_text', 'message_updated')
     ORDER BY seq ASC`,
  ).all(...scopeArgs) as Array<Record<string, unknown>>;

  const visibleRows = db.prepare(
    `SELECT seq, body FROM journal
     WHERE ${whereScope}
       AND coalesce(CASE WHEN json_valid(body) THEN json_extract(body,'$.kind') END, '') = 'visible_text'
     ORDER BY seq ASC`,
  ).all(...scopeArgs) as Array<Record<string, unknown>>;

  const structuredBySeq = new Map<number, TraceEvent>();
  const visibleBySeq = new Map<number, TraceEvent>();
  ingestJournalRows(structuredRows, structuredBySeq, visibleBySeq);
  ingestJournalRows(visibleRows, structuredBySeq, visibleBySeq);

  const streamedTextBySpan = aggregateStreamedText(visibleBySeq.values());
  const allStructured = [...structuredBySeq.values()].sort((a, b) => a.seq - b.seq);
  const events = preserveHeadTail(allStructured, safeLimit);

  const linkedTasks = loadTasksByIds(db, taskIds).slice(0, 30).map(toLinkedTaskSummary);

  return enforcePayloadBudget({
    scope: { type: 'message', id: target.id },
    cursor,
    events,
    streamedTextBySpan,
    messages,
    linkedTasks,
  });
}

function buildAllScopeBundle(store: Store, db: DatabaseSync, safeLimit: number): ExecutionTraceBundle {
  const cursor = store.conversation.latestSeq();

  const recentRows = (db.prepare(
    `SELECT seq, body FROM journal
     WHERE coalesce(CASE WHEN json_valid(body) THEN json_extract(body,'$.kind') END, '') NOT IN ('visible_text', 'message_updated')
     ORDER BY seq DESC
     LIMIT ?`,
  ).all(safeLimit) as Array<Record<string, unknown>>).reverse();

  const structuredBySeq = new Map<number, TraceEvent>();
  const visibleBySeq = new Map<number, TraceEvent>();
  const events = ingestJournalRows(recentRows, structuredBySeq, visibleBySeq).sort((a, b) => a.seq - b.seq);

  if (events.length) {
    const minSeq = events[0]!.seq;
    const maxSeq = events.at(-1)!.seq;
    const visibleRows = db.prepare(
      `SELECT seq, body FROM journal
       WHERE seq >= ? AND seq <= ?
         AND coalesce(CASE WHEN json_valid(body) THEN json_extract(body,'$.kind') END, '') = 'visible_text'
       ORDER BY seq ASC
       LIMIT 5000`,
    ).all(minSeq, maxSeq) as Array<Record<string, unknown>>;
    ingestJournalRows(visibleRows, structuredBySeq, visibleBySeq);

    const spanIds = [...new Set(events.map(ev => ev.spanId).filter((s): s is string => Boolean(s)))];
    const missingStartSpans = spanIds.filter(sid => !events.some(ev => ev.spanId === sid && ev.status === 'started'));
    if (missingStartSpans.length) {
      for (let i = 0; i < missingStartSpans.length; i += 100) {
        const chunk = missingStartSpans.slice(i, i + 100);
        const placeholders = chunk.map(() => '?').join(',');
        const spanVisible = db.prepare(
          `SELECT seq, body FROM journal
           WHERE seq < ?
             AND json_valid(body) = 1
             AND json_extract(body, '$.kind') = 'visible_text'
             AND json_extract(body, '$.spanId') IN (${placeholders})
           ORDER BY seq ASC
           LIMIT 2000`,
        ).all(minSeq, ...chunk) as Array<Record<string, unknown>>;
        ingestJournalRows(spanVisible, structuredBySeq, visibleBySeq);
      }
    }
  }

  const streamedTextBySpan = aggregateStreamedText(visibleBySeq.values());

  // Collect latest messages + messages referenced in the recent events
  const msgIdSet = new Set<string>();
  const recentMsgRows = db.prepare('SELECT seq, body FROM messages ORDER BY seq DESC LIMIT 40')
    .all() as Array<Record<string, unknown>>;
  for (const m of decodeMessageRows(db, recentMsgRows)) msgIdSet.add(m.id);
  for (const ev of events) {
    if (ev.messageId) msgIdSet.add(ev.messageId);
  }
  const messages = loadMessagesByIds(db, msgIdSet).slice(-60);

  // Collect recent tasks + tasks referenced in the recent events
  const recentTasks = store.list(30);
  const taskMap = new Map<string, Task>(recentTasks.map(t => [t.id, t]));
  const missingTaskIds: string[] = [];
  for (const ev of events) {
    if (ev.taskId && !taskMap.has(ev.taskId)) missingTaskIds.push(ev.taskId);
  }
  for (const t of loadTasksByIds(db, missingTaskIds)) {
    taskMap.set(t.id, t);
  }
  const linkedTasks = [...taskMap.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 40)
    .map(toLinkedTaskSummary);

  return enforcePayloadBudget({
    scope: { type: 'all' },
    cursor,
    events,
    streamedTextBySpan,
    messages,
    linkedTasks,
  });
}

/**
 * Pure read-only aggregator for the Execution Chain Studio endpoint.
 * Performs zero SQLite mutations and bounds response bytes safely below `RESPONSE_LIMIT`.
 */
export function buildExecutionTraceBundle(
  store: Store,
  options: { taskId?: string; messageId?: string; limit?: number },
): ExecutionTraceBundle {
  const db = getReadonlyDb(store);
  const safeLimit = clampLimit(options.limit);

  if (options.taskId !== undefined && options.taskId !== '') {
    return buildTaskScopeBundle(store, db, options.taskId, safeLimit);
  }
  if (options.messageId !== undefined && options.messageId !== '') {
    return buildMessageScopeBundle(store, db, options.messageId, safeLimit);
  }
  return buildAllScopeBundle(store, db, safeLimit);
}

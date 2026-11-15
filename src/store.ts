import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { InputFile } from './files.js';
import { Conversation, publicData } from './conversation.js';
import {
  computeLexicalConceptOverlap,
  computeSemanticContentHash,
  cosineSimilarity,
  deserializeEmbedding,
  l2Normalize,
  normalizeTopicForDedup,
  serializeEmbedding,
  type SemanticEmbedder,
} from './semantic.js';
import type { ContextSearchHit, ImChannelView, ImPlatform, MemoryCard, MemoryDirectory, MemorySynapse, SynapseRelation, WorkerProfile } from './view.js';

export type TaskStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export interface ImChannelConfig {
  id: string;
  platform: ImPlatform;
  name: string;
  enabled: boolean;
  notifyAll: boolean;
  botToken?: string;
  accountId?: string;
  syncBuf?: string;
  contextTokens?: Record<string, string>;
  webhookUrl?: string;
  secret?: string;
  defaultTarget?: string;
  allowedSenders: string[];
  apiBase?: string;
  pollIntervalMs?: number;
  pollOffset?: number;
  inboundCount: number;
  outboundCount: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}
export interface Task {
  origin?: import('./view.js').MessageOrigin;
  id: string; requestId: string; fingerprint: string; prompt: string;
  status: TaskStatus; revision: number; files: InputFile[];
  mode: 'real' | 'offline'; createdAt: number; limitMs: number; activeMs: number;
  report?: string; reason?: string; sessionFile?: string; sessionId?: string;
  originMessageId?: string; parentTaskId?: string; parentSpanId?: string;
  execution?: 'native' | 'snapshot'; cwd?: string; paths?: string[];
  contextBrief?: string; memoryIds?: string[];
  profile?: WorkerProfile; workerModel?: string; modelTier?: import('./view.js').ModelTier;
  thinkingLevel?: import('./view.js').ThinkingLevel;
  decisionSource?: import('./view.js').DecisionSource;
  decisionConfidence?: number;
  skipQualityGate?: boolean;
  qualityGate?: import('./view.js').QualityGateAssessment;
  pendingQuestion?: import('./view.js').PendingQuestion;
}
export interface TaskEvent { id: string; taskId: string; text: string; state: string }
export interface Operation {
  id: string; taskId: string; revision: number; fileId: string;
  status: 'requested' | 'started' | 'succeeded' | 'failed' | 'cancel_requested' | 'cancelled' | 'unknown';
  result?: string; error?: string; parentSpanId?: string;
}
export interface Notice { seq: number; taskId: string; kind: string; text: string; at: number }
export interface Timer {
  id: string; name: string; instruction: string; intervalMs: number;
  dailyAt?: string; once?: boolean; plugin?: string; pluginAction?: string;
  deliverChannelId?: string; deliverTarget?: string;
  cwd?: string; enabled: boolean; createdAt: number;
  nextRunAt: number; lastRunAt?: number; activeTaskId?: string;
  pendingCatchup?: boolean; missedRuns: number;
  origin?: import('./view.js').MessageOrigin;
}
export interface SubconsciousResidue {
  id: string;
  impression: string;
  insight?: string;
  insightSurfaced?: boolean;
  salience: 'faint' | 'vivid';
  interrupted?: boolean;
  createdAt: number;
  turnsElapsed: number;
}
export interface SubconsciousState {
  lastWakeAt: number;
  lastMessageSeq: number;
  digestedTaskIds: string[];
  nextLatencyMs?: number;
  refractoryMs?: number;
  residues: SubconsciousResidue[];
}
export interface DreamMaterial {
  undigestedMessages: Array<{ id: string; seq: number; role: 'user' | 'assistant'; text: string; at: number }>;
  undigestedTasks: Array<{ id: string; prompt: string; cwd?: string; profile?: WorkerProfile; reportSnippet: string; createdAt: number }>;
  rawStubs: MemoryCard[];
  distantMemories: MemoryCard[];
  candidateCwds: string[];
  latestMessageSeq: number;
  completedTaskIds: string[];
}
export interface ChatSubconscious {
  pendingInsight?: { id: string; insight: string };
  impressions: Array<{ vividness: 'clear' | 'hazy'; text: string; interrupted?: boolean; hoursAgo: number }>;
}
export interface DistillerState {
  lastMessageSeq: number;
  distilledTaskIds: string[];
  lastRunAt: number;
}

interface CachedMemoryEmbedding {
  memoryId: string;
  modelId: string;
  dim: number;
  contentHash: string;
  vector: Float32Array;
  updatedAt: number;
}

const AUTO_SYNAPSE_STOP_TAGS = new Set([
  'auto-consolidated', 'auto-summary', 'general', 'coding', 'research', 'review',
  'router', 'task', 'memory', 'config', 'fix', 'bug', 'test', 'dev', 'ts', 'js',
]);
const MAX_AUTO_SYNAPSES_PER_CARD = 8;
const MAX_AUTO_PEERS_PER_SAVE = 4;

function normalizeCwd(cwd?: string): string {
  const trimmed = cwd?.trim();
  if (!trimmed) return '';
  const unified = trimmed.replace(/\\/g, '/').replace(/\/+/g, '/');
  return unified.length > 1 ? unified.replace(/\/+$/, '') : unified;
}

function hasCwdConflict(cwdA?: string, cwdB?: string): boolean {
  const a = normalizeCwd(cwdA);
  const b = normalizeCwd(cwdB);
  if (!a || !b) return false;
  return a !== b && !a.startsWith(`${b}/`) && !b.startsWith(`${a}/`);
}

function isAutoStubCard(card: Pick<MemoryCard, 'topic' | 'tags'>): boolean {
  const lowerTags = card.tags.map(t => t.trim().toLowerCase());
  return lowerTags.includes('auto-consolidated')
    || lowerTags.includes('auto-summary')
    || /^auto[-_ ]?summary\b/i.test(card.topic.trim());
}

function defaultImportanceFor(card: { pinned?: boolean; topic: string; tags: string[] }): number {
  if (card.pinned) return 90;
  if (isAutoStubCard(card)) return 30;
  return 50;
}

export function memoryDocumentText(input: { topic: string; content: string; tags?: string[] }): string {
  const tagText = (input.tags ?? []).map(t => t.trim()).filter(Boolean).join(' ');
  return [input.topic.trim(), tagText, input.content.trim()].filter(Boolean).join('\n');
}

export class Store {
  private readonly db: DatabaseSync;
  private depth = 0;
  private hasResiduesCache = false;
  private semantic?: SemanticEmbedder;
  private readonly embeddingCache = new Map<string, CachedMemoryEmbedding>();
  readonly conversation: Conversation;
  constructor(readonly home: string) {
    this.db = new DatabaseSync(join(home, 'state.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), text TEXT NOT NULL, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_task ON events(task_id,state);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operations_task ON operations(task_id);
      CREATE TABLE IF NOT EXISTS timers(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, topic TEXT NOT NULL, cwd TEXT, superseded_by TEXT, updated_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memories_active ON memories(superseded_by, updated_at DESC);
      CREATE INDEX IF NOT EXISTS memories_topic ON memories(topic, cwd);
      CREATE TABLE IF NOT EXISTS memory_embeddings(memory_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, dim INTEGER NOT NULL, content_hash TEXT NOT NULL, vector BLOB NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS im_channels(id TEXT PRIMARY KEY, platform TEXT NOT NULL, updated_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notices(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);`);
    this.conversation = new Conversation(this.db, run => this.transaction(run));
    this.hasResiduesCache = (this.conversation.meta<SubconsciousState>('subconscious_state')?.residues?.length ?? 0) > 0;
    this.hydrateEmbeddingCache();
  }
  attachSemanticEngine(engine?: SemanticEmbedder): void {
    this.semantic = engine;
  }
  getSemanticEngine(): SemanticEmbedder | undefined {
    return this.semantic;
  }
  private hydrateEmbeddingCache(): void {
    this.embeddingCache.clear();
    const rows = this.db.prepare(
      `SELECT e.memory_id, e.model_id, e.dim, e.content_hash, e.vector, e.updated_at
       FROM memory_embeddings e
       JOIN memories m ON m.id = e.memory_id
       WHERE m.superseded_by IS NULL`,
    ).all();
    for (const row of rows) {
      if (!(row.vector instanceof Uint8Array)) continue;
      const vec = deserializeEmbedding(row.vector, Number(row.dim));
      if (!vec) continue;
      this.embeddingCache.set(String(row.memory_id), {
        memoryId: String(row.memory_id),
        modelId: String(row.model_id),
        dim: vec.length,
        contentHash: String(row.content_hash),
        vector: vec,
        updatedAt: Number(row.updated_at),
      });
    }
  }
  private upsertEmbeddingRecord(memoryId: string, modelId: string, contentHash: string, vec: Float32Array, updatedAt: number): void {
    const normalized = l2Normalize(vec);
    if (!normalized) return;
    const blob = serializeEmbedding(normalized);
    this.db.prepare(
      `INSERT INTO memory_embeddings(memory_id,model_id,dim,content_hash,vector,updated_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(memory_id) DO UPDATE SET
         model_id=excluded.model_id,
         dim=excluded.dim,
         content_hash=excluded.content_hash,
         vector=excluded.vector,
         updated_at=excluded.updated_at`,
    ).run(memoryId, modelId, normalized.length, contentHash, blob, updatedAt);
    this.embeddingCache.set(memoryId, {
      memoryId,
      modelId,
      dim: normalized.length,
      contentHash,
      vector: normalized,
      updatedAt,
    });
  }
  private deleteEmbeddingRecord(memoryId: string): void {
    this.db.prepare('DELETE FROM memory_embeddings WHERE memory_id=?').run(memoryId);
    this.embeddingCache.delete(memoryId);
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
  list(limit?: number): Task[] {
    const rows = limit === undefined
      ? this.db.prepare('SELECT body FROM tasks ORDER BY rowid').all()
      : this.db.prepare('SELECT body FROM tasks ORDER BY rowid DESC LIMIT ?').all(limit).reverse();
    return rows.map(row => JSON.parse(String(row.body)) as Task);
  }
  save(task: Task) {
    this.db.prepare('UPDATE tasks SET body=? WHERE id=?').run(JSON.stringify(task), task.id);
  }
  transition(id: string, status: TaskStatus, reason?: string, report?: string): Task {
    return this.transaction(() => {
      const task = this.get(id);
      task.status = status; task.reason = reason;
      if (['completed', 'failed', 'cancelled'].includes(status)) delete task.pendingQuestion;
      if (report !== undefined) task.report = report;
      else if (status !== 'completed') delete task.report;
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
  operationById(id: string, taskId?: string): Operation | undefined {
    const row = taskId === undefined
      ? this.db.prepare('SELECT body FROM operations WHERE id=?').get(id)
      : this.db.prepare('SELECT body FROM operations WHERE id=? AND task_id=?').get(id, taskId);
    return row ? JSON.parse(String(row.body)) as Operation : undefined;
  }
  operations(taskId: string): Operation[] {
    return this.db.prepare('SELECT body FROM operations WHERE task_id=? ORDER BY rowid').all(taskId).map(row => JSON.parse(String(row.body)) as Operation);
  }
  acknowledgeUnsettledOperations(taskId: string) {
    this.transaction(() => {
      for (const op of this.operations(taskId)) {
        if (['requested', 'started', 'cancel_requested', 'unknown'].includes(op.status)) {
          op.status = 'cancelled';
          op.error = op.error ? `${op.error}（用户已确认续跑并核销）` : '用户已确认续跑，核销未确认操作';
          this.operation(op);
        }
      }
    });
  }
  saveTimer(timer: Timer) {
    this.db.prepare('INSERT INTO timers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(timer.id, JSON.stringify(timer));
  }
  getTimer(id: string): Timer {
    const row = this.db.prepare('SELECT body FROM timers WHERE id=?').get(id);
    if (!row) throw new Error('Timer not found');
    return JSON.parse(String(row.body)) as Timer;
  }
  listTimers(): Timer[] {
    return this.db.prepare('SELECT body FROM timers ORDER BY rowid').all().map(row => JSON.parse(String(row.body)) as Timer);
  }
  deleteTimer(id: string): boolean {
    return this.db.prepare('DELETE FROM timers WHERE id=?').run(id).changes > 0;
  }
  saveImChannel(channel: ImChannelConfig): ImChannelConfig {
    this.db.prepare('INSERT INTO im_channels(id,platform,updated_at,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET platform=excluded.platform,updated_at=excluded.updated_at,body=excluded.body')
      .run(channel.id, channel.platform, channel.updatedAt, JSON.stringify(channel));
    return channel;
  }
  getImChannel(id: string): ImChannelConfig {
    const row = this.db.prepare('SELECT body FROM im_channels WHERE id=?').get(id);
    if (!row) throw new Error('IM channel not found');
    return JSON.parse(String(row.body)) as ImChannelConfig;
  }
  listImChannels(): ImChannelConfig[] {
    return this.db.prepare('SELECT body FROM im_channels ORDER BY rowid').all().map(row => JSON.parse(String(row.body)) as ImChannelConfig);
  }
  toImChannelView(channel: ImChannelConfig): ImChannelView {
    let webhookUrlMasked: string | undefined;
    if (channel.webhookUrl) {
      try {
        const u = new URL(channel.webhookUrl);
        webhookUrlMasked = `${u.origin}${u.pathname.slice(0, 24)}${u.pathname.length > 24 || u.search ? '…' : ''}`;
      } catch {
        webhookUrlMasked = channel.webhookUrl.slice(0, 24) + '…';
      }
    }
    return {
      id: channel.id,
      platform: channel.platform,
      name: channel.name,
      enabled: channel.enabled,
      notifyAll: channel.notifyAll,
      hasBotToken: Boolean(channel.botToken),
      hasSecret: Boolean(channel.secret),
      accountId: channel.accountId,
      loginStatus: channel.platform === 'wechat'
        ? (channel.botToken ? 'bound' : 'unbound')
        : channel.platform === 'xiaoai'
          ? (Boolean(channel.botToken || channel.webhookUrl || channel.apiBase?.startsWith('ssh://')) ? 'bound' : 'unbound')
          : undefined,
      webhookUrlMasked,
      defaultTarget: channel.defaultTarget,
      allowedSenders: channel.allowedSenders,
      apiBase: channel.apiBase,
      pollIntervalMs: channel.pollIntervalMs,
      inboundCount: channel.inboundCount,
      outboundCount: channel.outboundCount,
      lastInboundAt: channel.lastInboundAt,
      lastOutboundAt: channel.lastOutboundAt,
      lastError: channel.lastError,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    };
  }
  listImChannelViews(): ImChannelView[] {
    return this.listImChannels().map(channel => this.toImChannelView(channel));
  }
  deleteImChannel(id: string): boolean {
    return this.db.prepare('DELETE FROM im_channels WHERE id=?').run(id).changes > 0;
  }
  private trimSynapses(list: MemorySynapse[]): MemorySynapse[] {
    const byTarget = new Map<string, MemorySynapse>();
    for (const syn of list) {
      if (!syn.targetId) continue;
      const prev = byTarget.get(syn.targetId);
      if (!prev || syn.weight > prev.weight || (syn.weight === prev.weight && syn.updatedAt > prev.updatedAt)) {
        byTarget.set(syn.targetId, syn);
      }
    }
    const deduped = [...byTarget.values()];
    const explicit = deduped.filter(s => s.relation === 'explicit');
    const auto = deduped
      .filter(s => s.relation !== 'explicit')
      .sort((a, b) => b.weight - a.weight || b.updatedAt - a.updatedAt)
      .slice(0, MAX_AUTO_SYNAPSES_PER_CARD);
    return [...explicit, ...auto].sort((a, b) => b.weight - a.weight || b.updatedAt - a.updatedAt);
  }
  private upsertSynapseOnCard(
    card: MemoryCard, targetId: string, targetTopic: string | undefined,
    relation: SynapseRelation, deltaOrInit?: number, now = Date.now(),
    mode: 'reinforce' | 'at_least' = 'reinforce',
  ): boolean {
    if (!targetId || targetId === card.id) return false;
    const rank: Record<SynapseRelation, number> = { explicit: 5, task_chain: 4, semantic: 3, co_activated: 2, shared_tag: 1 };
    const defaultInit: Record<SynapseRelation, number> = { explicit: 0.85, task_chain: 0.7, semantic: 0.7, co_activated: 0.5, shared_tag: 0.45 };
    const list = [...(card.synapses ?? [])];
    const existing = list.find(s => s.targetId === targetId);
    if (existing) {
      if (mode === 'at_least') {
        const floorW = deltaOrInit ?? defaultInit[relation];
        existing.weight = Math.min(1, Math.max(existing.weight, Number(floorW.toFixed(2))));
      } else {
        const inc = deltaOrInit ?? 0.15;
        existing.weight = Math.min(1, Number((existing.weight + inc).toFixed(2)));
      }
      if (rank[relation] > rank[existing.relation]) existing.relation = relation;
      if (targetTopic) existing.targetTopic = targetTopic;
      existing.updatedAt = now;
    } else {
      const initW = deltaOrInit ?? defaultInit[relation];
      list.push({
        targetId,
        ...(targetTopic ? { targetTopic } : {}),
        weight: Math.min(1, Math.max(0.1, Number(initW.toFixed(2)))),
        relation,
        updatedAt: now,
      });
    }
    const trimmed = this.trimSynapses(list);
    card.synapses = trimmed.length ? trimmed : undefined;
    return Boolean(card.synapses?.some(s => s.targetId === targetId));
  }
  linkMemories(idA: string, idB: string, relation: SynapseRelation = 'explicit', weightDelta?: number): { source: MemoryCard; target: MemoryCard } {
    if (idA === idB) throw new Error('Cannot link a memory neuron to itself');
    return this.transaction(() => {
      const cardA = this.getMemory(idA);
      const cardB = this.getMemory(idB);
      const now = Date.now();
      this.upsertSynapseOnCard(cardA, cardB.id, cardB.topic, relation, weightDelta, now);
      this.upsertSynapseOnCard(cardB, cardA.id, cardA.topic, relation, weightDelta, now);
      this.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(cardA), cardA.id);
      this.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(cardB), cardB.id);
      return { source: cardA, target: cardB };
    });
  }
  reinforceCoActivated(memoryIds: string[], relation: SynapseRelation = 'co_activated', delta = 0.12) {
    const unique = [...new Set(memoryIds.filter(Boolean))].slice(0, 6);
    if (unique.length < 2) return;
    this.transaction(() => {
      for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
          try {
            if (relation !== 'explicit') {
              const cardA = this.getMemory(unique[i]!);
              const cardB = this.getMemory(unique[j]!);
              if (normalizeCwd(cardA.cwd) !== normalizeCwd(cardB.cwd)) continue;
            }
            this.linkMemories(unique[i]!, unique[j]!, relation, delta);
          } catch { /* ignore missing or superseded edge errors */ }
        }
      }
    });
  }
  saveMemory(input: {
    id?: string; topic: string; content: string; tags?: string[];
    cwd?: string; sourceMessageId?: string; sourceTaskId?: string;
    supersedeId?: string; supersedeIds?: string[]; pinned?: boolean;
    linkedMemoryIds?: string[]; importance?: number;
    embedding?: Float32Array; embeddingModelId?: string;
  }): MemoryCard {
    const topic = String(publicData(input.topic.trim())).slice(0, 160);
    const content = String(publicData(input.content.trim())).slice(0, 8192);
    if (!topic || !content) throw new Error('Memory topic and content must be non-empty');
    const tags = [...new Set((input.tags ?? []).map(tag => String(publicData(tag.trim())).slice(0, 64)).filter(Boolean))].slice(0, 16);
    const cwd = input.cwd?.trim() || undefined;
    const normCwd = normalizeCwd(cwd);
    const now = Date.now();
    const normalizedInputVec = input.embedding ? l2Normalize(input.embedding) : undefined;
    const docText = memoryDocumentText({ topic, content, tags });
    const docHash = computeSemanticContentHash(docText);
    const modelId = input.embeddingModelId ?? this.semantic?.modelId ?? 'custom';
    const clampImp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

    return this.transaction(() => {
      let card: MemoryCard;
      if (input.id) {
        const existingRow = this.db.prepare('SELECT body FROM memories WHERE id=?').get(input.id);
        if (existingRow) {
          const prev = JSON.parse(String(existingRow.body)) as MemoryCard;
          const nextTags = tags.length ? tags : prev.tags;
          const nextPinned = input.pinned ?? prev.pinned;
          const nextImportance = input.importance !== undefined
            ? clampImp(input.importance)
            : (input.pinned === true && !prev.pinned)
              ? Math.max(90, prev.importance ?? 90)
              : (prev.importance ?? defaultImportanceFor({ pinned: nextPinned, topic, tags: nextTags }));
          card = {
            ...prev, topic, content, tags: nextTags,
            cwd: cwd ?? prev.cwd, sourceMessageId: input.sourceMessageId ?? prev.sourceMessageId,
            sourceTaskId: input.sourceTaskId ?? prev.sourceTaskId,
            pinned: nextPinned || undefined,
            importance: nextImportance,
            updatedAt: now,
          };
          this.db.prepare('UPDATE memories SET topic=?,cwd=?,superseded_by=?,updated_at=?,body=? WHERE id=?')
            .run(card.topic, card.cwd ?? null, card.supersededBy ?? null, card.updatedAt, JSON.stringify(card), card.id);
          const updatedHash = computeSemanticContentHash(memoryDocumentText(card));
          if (normalizedInputVec) {
            this.upsertEmbeddingRecord(card.id, modelId, updatedHash, normalizedInputVec, now);
          } else {
            const cached = this.embeddingCache.get(card.id);
            if (cached && cached.contentHash !== updatedHash) this.deleteEmbeddingRecord(card.id);
          }
        } else {
          card = undefined!;
        }
      } else {
        card = undefined!;
      }
      if (!card) {
        const id = input.id ?? randomUUID();
        const explicitSupersedeIds = [...new Set([
          ...(input.supersedeId ? [input.supersedeId] : []),
          ...(input.supersedeIds ?? []),
        ].map(s => s.trim()).filter(Boolean))];
        let priors: MemoryCard[];
        if (explicitSupersedeIds.length) {
          const priorRows = this.db.prepare(`SELECT body FROM memories WHERE id IN (${explicitSupersedeIds.map(() => '?').join(',')}) AND superseded_by IS NULL`).all(...explicitSupersedeIds);
          priors = priorRows.map(row => JSON.parse(String(row.body)) as MemoryCard).filter(prior => prior.id !== id);
        } else {
          const canonicalTopicKey = (value: string): string =>
            normalizeTopicForDedup(value).replace(/(?<=[\u4e00-\u9fff\u3400-\u4dbf])\s+|\s+(?=[\u4e00-\u9fff\u3400-\u4dbf])/g, '');
          const normDedupTopic = canonicalTopicKey(topic);
          const isNewStub = isAutoStubCard({ topic, tags });
          const sameCwdActive = this.listMemories({ includeSuperseded: false, limit: 500 })
            .filter(prior => prior.id !== id && normalizeCwd(prior.cwd) === normCwd);
          priors = sameCwdActive.filter(prior => {
            if (prior.topic === topic) return true;
            if (normDedupTopic.length > 0 && canonicalTopicKey(prior.topic) === normDedupTopic) return true;
            if (prior.pinned) return false;
            const priorCached = this.embeddingCache.get(prior.id);
            const canUseEmbeddings = Boolean(
              normalizedInputVec
              && priorCached
              && priorCached.vector.length === normalizedInputVec.length
              && (!input.embeddingModelId || priorCached.modelId === modelId),
            );
            if (canUseEmbeddings) {
              return cosineSimilarity(normalizedInputVec, priorCached!.vector) >= 0.86;
            }
            if (isAutoStubCard(prior) !== isNewStub) return false;
            const overlap = computeLexicalConceptOverlap(docText, memoryDocumentText(prior));
            return overlap.jaccard >= 0.68 && overlap.sharedTerms >= 4;
          });
        }
        const inheritedPin = input.pinned ?? priors.some(p => p.pinned);
        const baseImp = defaultImportanceFor({ pinned: Boolean(inheritedPin), topic, tags });
        const inheritedImp = input.importance !== undefined
          ? clampImp(input.importance)
          : Math.max(baseImp, ...priors.map(p => p.importance ?? baseImp));
        card = {
          id, topic, content, tags, cwd,
          sourceMessageId: input.sourceMessageId, sourceTaskId: input.sourceTaskId,
          supersedes: priors[0]?.id, pinned: inheritedPin || undefined,
          importance: inheritedImp,
          accessCount: 0, createdAt: now, updatedAt: now,
        };
        // Inherit synapses from superseded prior neurons and redirect neighbor pointers
        for (const prior of priors) {
          for (const syn of prior.synapses ?? []) {
            if (syn.targetId !== card.id) {
              this.upsertSynapseOnCard(card, syn.targetId, syn.targetTopic, syn.relation, syn.weight, now, 'at_least');
              try {
                const neighbor = this.getMemory(syn.targetId);
                neighbor.synapses = (neighbor.synapses ?? []).filter(s => s.targetId !== prior.id);
                this.upsertSynapseOnCard(neighbor, card.id, card.topic, syn.relation, syn.weight, now, 'at_least');
                this.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(neighbor), neighbor.id);
              } catch { /* ignore missing neighbor */ }
            }
          }
        }
        this.db.prepare('INSERT INTO memories(id,topic,cwd,superseded_by,updated_at,body) VALUES(?,?,?,?,?,?)')
          .run(card.id, card.topic, card.cwd ?? null, null, card.updatedAt, JSON.stringify(card));
        if (normalizedInputVec) {
          this.upsertEmbeddingRecord(card.id, modelId, docHash, normalizedInputVec, now);
        }
        for (const prior of priors) {
          prior.supersededBy = card.id;
          prior.updatedAt = now;
          this.db.prepare('UPDATE memories SET superseded_by=?,updated_at=?,body=? WHERE id=?')
            .run(card.id, now, JSON.stringify(prior), prior.id);
          this.deleteEmbeddingRecord(prior.id);
        }
      }
      // Wire explicit synapses
      const explicitLinked = new Set<string>();
      for (const linkedId of input.linkedMemoryIds ?? []) {
        if (linkedId && linkedId !== card.id) {
          try {
            this.linkMemories(card.id, linkedId, 'explicit');
            explicitLinked.add(linkedId);
          } catch { /* ignore unknown ID */ }
        }
      }
      // Domain-gated, high-threshold auto-wiring across active compatible peers
      const cardNormCwd = normalizeCwd(card.cwd);
      const cardVec = normalizedInputVec ?? this.embeddingCache.get(card.id)?.vector;
      const cardModelId = normalizedInputVec ? modelId : this.embeddingCache.get(card.id)?.modelId;
      const specificTags = new Set(
        card.tags.map(t => t.trim().toLowerCase()).filter(t => t && !AUTO_SYNAPSE_STOP_TAGS.has(t)),
      );
      if (specificTags.size >= 2 || card.sourceTaskId || cardVec) {
        const activePeers = this.listMemories({ includeSuperseded: false, limit: 200 })
          .filter(p => p.id !== card.id && !explicitLinked.has(p.id) && normalizeCwd(p.cwd) === cardNormCwd);
        const candidates: Array<{ peer: MemoryCard; relation: SynapseRelation; weight: number }> = [];
        for (const peer of activePeers) {
          if (peer.synapses?.some(s => s.targetId === card.id && s.relation === 'explicit')) continue;
          let best: { relation: SynapseRelation; weight: number } | undefined;
          const consider = (relation: SynapseRelation, weight: number) => {
            if (!best || weight > best.weight) best = { relation, weight };
          };
          if (card.sourceTaskId && peer.sourceTaskId === card.sourceTaskId) {
            consider('task_chain', 0.7);
          }
          if (cardVec) {
            const peerCached = this.embeddingCache.get(peer.id);
            if (peerCached && peerCached.vector.length === cardVec.length && (!cardModelId || peerCached.modelId === cardModelId)) {
              const sim = cosineSimilarity(cardVec, peerCached.vector);
              if (sim >= 0.68) {
                consider('semantic', Number(Math.min(0.85, sim).toFixed(2)));
              }
            }
          }
          if (specificTags.size >= 2) {
            const peerTags = new Set(peer.tags.map(t => t.trim().toLowerCase()).filter(Boolean));
            let sharedCount = 0;
            for (const tag of specificTags) {
              if (peerTags.has(tag)) sharedCount++;
            }
            if (sharedCount >= 2) {
              const initW = Number(Math.min(0.75, 0.48 + (sharedCount - 2) * 0.12).toFixed(2));
              consider('shared_tag', initW);
            }
          }
          if (best) candidates.push({ peer, ...best });
        }
        candidates.sort((a, b) => b.weight - a.weight || b.peer.updatedAt - a.peer.updatedAt);
        let wiredCount = 0;
        let freshCard = this.getMemory(card.id);
        for (const cand of candidates) {
          if (wiredCount >= MAX_AUTO_PEERS_PER_SAVE) break;
          const peerCopy: MemoryCard = { ...cand.peer, synapses: cand.peer.synapses ? cand.peer.synapses.map(s => ({ ...s })) : undefined };
          const cardCopy: MemoryCard = { ...freshCard, synapses: freshCard.synapses ? freshCard.synapses.map(s => ({ ...s })) : undefined };
          const keptOnPeer = this.upsertSynapseOnCard(peerCopy, cardCopy.id, cardCopy.topic, cand.relation, cand.weight, now, 'at_least');
          const keptOnCard = this.upsertSynapseOnCard(cardCopy, peerCopy.id, peerCopy.topic, cand.relation, cand.weight, now, 'at_least');
          if (!keptOnPeer || !keptOnCard) continue;
          this.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(peerCopy), peerCopy.id);
          this.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(cardCopy), cardCopy.id);
          freshCard = cardCopy;
          wiredCount++;
        }
      }
      return this.getMemory(card.id);
    });
  }
  async saveMemoryAsync(input: Parameters<Store['saveMemory']>[0]): Promise<MemoryCard> {
    const rawTopic = input.topic.trim();
    const rawContent = input.content.trim();
    if (!rawTopic || !rawContent) return this.saveMemory(input);
    let embedding = input.embedding;
    let embeddingModelId = input.embeddingModelId;
    if (!embedding && this.semantic?.isReady()) {
      const topic = String(publicData(rawTopic)).slice(0, 160);
      const content = String(publicData(rawContent)).slice(0, 8192);
      const tags = [...new Set((input.tags ?? []).map(tag => String(publicData(tag.trim())).slice(0, 64)).filter(Boolean))].slice(0, 16);
      const docText = memoryDocumentText({ topic, content, tags });
      const docHash = computeSemanticContentHash(docText);
      const existing = input.id ? this.embeddingCache.get(input.id) : undefined;
      if (existing && existing.modelId === this.semantic.modelId && existing.contentHash === docHash) {
        embedding = existing.vector;
        embeddingModelId = existing.modelId;
      } else {
        try {
          const vec = await this.semantic.embed(docText, 'document');
          if (vec) {
            embedding = vec;
            embeddingModelId = this.semantic.modelId;
          }
        } catch { /* graceful degradation */ }
      }
    }
    return this.saveMemory({ ...input, embedding, embeddingModelId });
  }
  pinMemory(id: string, pinned = true): MemoryCard {
    return this.transaction(() => {
      const card = this.getMemory(id);
      card.pinned = pinned || undefined;
      card.importance = pinned ? Math.max(90, card.importance ?? 90) : (card.importance ?? 50);
      card.updatedAt = Date.now();
      this.db.prepare('UPDATE memories SET updated_at=?,body=? WHERE id=?').run(card.updatedAt, JSON.stringify(card), card.id);
      return card;
    });
  }
  touchMemory(id: string, options?: { active?: boolean }): MemoryCard | undefined {
    const row = this.db.prepare('SELECT body FROM memories WHERE id=?').get(id);
    if (!row) return undefined;
    const now = Date.now();
    const card = JSON.parse(String(row.body)) as MemoryCard;
    card.accessCount = (card.accessCount ?? 0) + 1;
    card.lastAccessedAt = now;
    if (options?.active) {
      card.lastReinforcedAt = now;
      const curImp = card.importance ?? defaultImportanceFor(card);
      card.importance = Math.min(75, Math.max(curImp, 25) + 5);
    }
    this.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(card), card.id);
    return card;
  }
  getMemory(id: string): MemoryCard {
    const row = this.db.prepare('SELECT body FROM memories WHERE id=?').get(id);
    if (!row) throw new Error('Memory not found');
    return JSON.parse(String(row.body)) as MemoryCard;
  }
  listMemories(options?: { includeSuperseded?: boolean; cwd?: string; topic?: string; limit?: number }): MemoryCard[] {
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (!options?.includeSuperseded) clauses.push('superseded_by IS NULL');
    if (options?.cwd) { clauses.push('(cwd=? OR cwd IS NULL)'); args.push(options.cwd); }
    if (options?.topic) { clauses.push('topic=?'); args.push(options.topic); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const limit = options?.limit ?? 100;
    const rows = this.db.prepare(`SELECT body FROM memories${where} ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(...args, limit);
    return rows
      .map(row => JSON.parse(String(row.body)) as MemoryCard)
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
  }
  deleteMemory(id: string): boolean {
    return this.transaction(() => {
      let existing: MemoryCard | undefined;
      try { existing = this.getMemory(id); } catch { /* ignore */ }
      const deleted = this.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes > 0;
      this.deleteEmbeddingRecord(id);
      if (deleted && existing?.synapses?.length) {
        for (const syn of existing.synapses) {
          try {
            const neighbor = this.getMemory(syn.targetId);
            if (neighbor.synapses?.some(s => s.targetId === id)) {
              neighbor.synapses = neighbor.synapses.filter(s => s.targetId !== id);
              this.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(neighbor), neighbor.id);
            }
          } catch { /* ignore */ }
        }
      }
      return deleted;
    });
  }
  memoryDirectory(limit = 24): MemoryDirectory {
    const totalRow = this.db.prepare('SELECT count(*) AS total FROM memories WHERE superseded_by IS NULL').get();
    const totalActive = Number(totalRow?.total ?? 0);
    const items = this.listMemories({ includeSuperseded: false, limit }).map(card => ({
      id: card.id, topic: card.topic, tags: card.tags, cwd: card.cwd, updatedAt: card.updatedAt,
      pinned: card.pinned, accessCount: card.accessCount,
      ...(card.synapses?.length ? { synapses: card.synapses } : {}),
      preview: card.content.slice(0, 120) + (card.content.length > 120 ? '…' : ''),
    }));
    return { totalActive, truncated: totalActive > items.length, items };
  }
  memoriesForContext(options: {
    memoryIds?: string[];
    cwd?: string;
    queryText?: string;
    queryEmbedding?: Float32Array;
    limit?: number;
  }): MemoryCard[] {
    const selected = new Map<string, MemoryCard>();
    const limit = Math.max(1, options.limit ?? 8);
    const reqCwd = normalizeCwd(options.cwd);
    const explicitCards: MemoryCard[] = [];
    for (const id of options.memoryIds ?? []) {
      try {
        const card = this.touchMemory(id, { active: true }) ?? this.getMemory(id);
        selected.set(card.id, card);
        explicitCards.push(card);
      } catch { /* ignore unknown memory IDs */ }
    }
    if (explicitCards.length >= 2) {
      this.reinforceCoActivated(explicitCards.map(c => c.id), 'co_activated', 0.15);
      for (let i = 0; i < explicitCards.length; i++) {
        try {
          const refreshed = this.getMemory(explicitCards[i]!.id);
          explicitCards[i] = refreshed;
          selected.set(refreshed.id, refreshed);
        } catch { /* ignore */ }
      }
    }
    // (a) Up to 2 tightly gated 1-hop synaptic neighbors (weight >= 0.60 in compatible cwd)
    const neighborCandidates: Array<{ card: MemoryCard; weight: number }> = [];
    const seenNeighborIds = new Set<string>();
    for (const seed of explicitCards) {
      const expectedScope = reqCwd || normalizeCwd(seed.cwd);
      for (const syn of seed.synapses ?? []) {
        if (syn.weight < 0.60 || selected.has(syn.targetId) || seenNeighborIds.has(syn.targetId)) continue;
        try {
          const neighbor = this.getMemory(syn.targetId);
          if (neighbor.supersededBy) continue;
          if (normalizeCwd(neighbor.cwd) !== expectedScope) continue;
          seenNeighborIds.add(neighbor.id);
          neighborCandidates.push({ card: neighbor, weight: syn.weight });
        } catch { /* ignore */ }
      }
    }
    neighborCandidates.sort((a, b) => b.weight - a.weight || b.card.updatedAt - a.card.updatedAt);
    let addedNeighbors = 0;
    for (const { card: neighbor } of neighborCandidates) {
      if (selected.size >= limit || addedNeighbors >= 2) break;
      selected.set(neighbor.id, neighbor);
      addedNeighbors++;
    }

    const activePool = selected.size < limit ? this.listMemories({ includeSuperseded: false, limit: 300 }) : [];

    // (c) Semantic (cosine >= 0.48) or strong lexical match against queryText/queryEmbedding
    const qText = options.queryText?.trim() ?? '';
    const qVec = options.queryEmbedding ? l2Normalize(options.queryEmbedding) : undefined;
    if (selected.size < limit && (qText || qVec)) {
      const lowerQ = qText.toLowerCase();
      const matched: Array<{ card: MemoryCard; score: number }> = [];
      for (const card of activePool) {
        if (selected.has(card.id)) continue;
        if (hasCwdConflict(options.cwd, card.cwd)) continue;
        const cached = this.embeddingCache.get(card.id);
        const canCompare = Boolean(
          qVec
          && cached
          && cached.vector.length === qVec.length
          && (!this.semantic || cached.modelId === this.semantic.modelId),
        );
        const semSim = canCompare ? cosineSimilarity(qVec, cached!.vector) : 0;
        let strongLex = false;
        let lexBonus = 0;
        if (qText) {
          const doc = memoryDocumentText(card);
          const overlap = computeLexicalConceptOverlap(qText, doc);
          const exactSub = lowerQ.length >= 3 && doc.toLowerCase().includes(lowerQ);
          strongLex = exactSub || overlap.sharedTerms >= 2 || (overlap.jaccard >= 0.35 && overlap.sharedTerms >= 1);
          lexBonus = (exactSub ? 40 : 0) + overlap.sharedTerms * 12 + overlap.jaccard * 30;
        }
        if (semSim < 0.48 && !strongLex) continue;
        const sameCwdBoost = reqCwd && normalizeCwd(card.cwd) === reqCwd ? 15 : 0;
        const total = (semSim >= 0.48 ? semSim * 100 : 0) + lexBonus + sameCwdBoost + (card.pinned ? 10 : 0);
        matched.push({ card, score: total });
      }
      matched.sort((a, b) => b.score - a.score || b.card.updatedAt - a.card.updatedAt);
      for (const item of matched) {
        if (selected.size >= limit) break;
        selected.set(item.card.id, item.card);
      }
    }

    // (b) Same normalized cwd active cards ONLY when non-empty cwd is provided; zero unrelated padding
    if (selected.size < limit && reqCwd) {
      for (const card of activePool) {
        if (selected.size >= limit) break;
        if (selected.has(card.id)) continue;
        if (normalizeCwd(card.cwd) === reqCwd) {
          selected.set(card.id, card);
        }
      }
    }
    return [...selected.values()];
  }
  async memoriesForContextAsync(options: { memoryIds?: string[]; cwd?: string; queryText?: string; limit?: number }): Promise<MemoryCard[]> {
    let queryEmbedding: Float32Array | undefined;
    const qText = options.queryText?.trim();
    if (qText && this.semantic?.isReady()) {
      try {
        queryEmbedding = await this.semantic.embed(qText, 'query');
      } catch { /* graceful degradation */ }
    }
    return this.memoriesForContext({ ...options, queryEmbedding });
  }
  searchContext(options: {
    query: string;
    scope?: 'all' | 'memories' | 'works' | 'messages';
    cwd?: string;
    limit?: number;
    includeSuperseded?: boolean;
    touch?: boolean;
    queryEmbedding?: Float32Array;
  }): { query: string; scope: string; totalHits: number; hits: ContextSearchHit[]; memoryDirectory: MemoryDirectory } {
    const rawQuery = options.query.trim();
    if (!rawQuery) throw new Error('Search query must not be empty');
    const scope = options.scope ?? 'all';
    const limit = Math.max(1, Math.min(options.limit ?? 12, 50));
    const reqCwd = normalizeCwd(options.cwd);
    const lowerQuery = rawQuery.toLowerCase();
    const tokens = [...new Set(lowerQuery.split(/[\s,，。；;、/|?:!！？"'“”‘’()（）[\]【】]+/).filter(Boolean))];
    const cjkBigrams = new Set<string>();
    for (const token of tokens) {
      const cjkRuns = token.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
      for (const run of cjkRuns) {
        for (let i = 0; i < run.length - 1; i++) cjkBigrams.add(run.slice(i, i + 2));
      }
    }
    const now = Date.now();
    const recencyBonus = (at: number) => Math.max(0, 8 - Math.max(0, now - at) / (24 * 3600_000));
    const cwdBonus = (itemCwd?: string) => {
      const normItem = normalizeCwd(itemCwd);
      if (!reqCwd || !normItem) return 0;
      if (normItem === reqCwd) return 25;
      if (normItem.startsWith(`${reqCwd}/`) || reqCwd.startsWith(`${normItem}/`)) return 15;
      return -25;
    };
    const scoreText = (header: string, bodyText: string) => {
      const h = header.toLowerCase();
      const b = bodyText.toLowerCase();
      const combined = `${h}\n${b}`;
      let score = 0;
      let matchedTokens = 0;
      let firstAnchor = '';
      if (combined.includes(lowerQuery)) {
        score += 50;
        matchedTokens++;
        firstAnchor = lowerQuery;
      }
      for (const token of tokens) {
        if (!token) continue;
        let hit = false;
        if (h.includes(token)) { score += 22; hit = true; }
        if (b.includes(token)) { score += 12; hit = true; }
        if (hit) {
          matchedTokens++;
          if (!firstAnchor) firstAnchor = token;
        }
      }
      if (cjkBigrams.size > 0) {
        let bigramHits = 0;
        for (const bg of cjkBigrams) {
          if (combined.includes(bg)) {
            bigramHits++;
            if (!firstAnchor) firstAnchor = bg;
          }
        }
        if (bigramHits >= Math.min(2, cjkBigrams.size)) {
          score += bigramHits * 6;
          matchedTokens += bigramHits;
        }
      }
      return { score: matchedTokens > 0 ? score : 0, firstAnchor };
    };
    const buildSnippet = (textValue: string, anchor: string, maxLen = 280) => {
      const clean = String(publicData(textValue));
      if (clean.length <= maxLen) return clean;
      const idx = anchor ? clean.toLowerCase().indexOf(anchor) : -1;
      if (idx < 0) return clean.slice(0, maxLen) + '…';
      const start = Math.max(0, idx - 80);
      const end = Math.min(clean.length, start + maxLen);
      return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
    };
    const queryVec = options.queryEmbedding ? l2Normalize(options.queryEmbedding) : undefined;
    const hits: ContextSearchHit[] = [];
    const directMemoryHits = new Map<string, { card: MemoryCard; hit: ContextSearchHit }>();
    if (scope === 'all' || scope === 'memories') {
      const cards = this.listMemories({ includeSuperseded: options.includeSuperseded ?? false, limit: 300 });
      const cardById = new Map(cards.map(c => [c.id, c]));
      for (const card of cards) {
        const header = `${card.topic} ${card.tags.join(' ')} ${card.cwd ?? ''}`;
        const { score: lexScore, firstAnchor } = scoreText(header, card.content);
        const cached = !card.supersededBy ? this.embeddingCache.get(card.id) : undefined;
        const canCompareVec = Boolean(
          queryVec
          && cached
          && cached.vector.length === queryVec.length
          && (!this.semantic || cached.modelId === this.semantic.modelId),
        );
        const semSim = canCompareVec ? cosineSimilarity(queryVec, cached!.vector) : 0;
        if (lexScore <= 0 && semSim < 0.42) continue;
        const base = card.supersededBy ? 5 : 30;
        const pinBonus = card.pinned ? 15 : 0;
        const ebbinghausBonus = Math.min(12, (card.accessCount ?? 0) * 2);
        const semScore = semSim >= 0.42 ? Math.max(0, (semSim - 0.30) * 90) : 0;
        const finalScore = Number((base + pinBonus + ebbinghausBonus + lexScore + semScore + cwdBonus(card.cwd) + recencyBonus(card.updatedAt)).toFixed(2));
        if (finalScore <= 0) continue;
        const hit: ContextSearchHit = {
          kind: 'memory', id: card.id, memoryId: card.id, score: finalScore, at: card.updatedAt,
          title: `记忆卡片${card.pinned ? ' [核心]' : ''} · ${card.topic}${card.supersededBy ? '（已被新记忆替代）' : ''}`,
          snippet: buildSnippet(card.content, firstAnchor, 360),
          cwd: card.cwd, tags: card.tags,
          ...(card.synapses?.length ? { synapses: card.synapses } : {}),
          taskId: card.sourceTaskId, messageId: card.sourceMessageId,
        };
        hits.push(hit);
        directMemoryHits.set(card.id, { card, hit });
      }
      // 1-hop Synaptic Spreading Activation across connected memory neurons (weight >= 0.60, spreadScore >= 32, domain-gated)
      const topSeeds = [...directMemoryHits.values()].sort((a, b) => b.hit.score - a.hit.score).slice(0, 5);
      const spreadCandidates = new Map<string, ContextSearchHit>();
      for (const { card: seedCard, hit: seedHit } of topSeeds) {
        for (const syn of seedCard.synapses ?? []) {
          if (syn.weight < 0.60) continue;
          const targetCard = cardById.get(syn.targetId);
          if (!targetCard) continue;
          if (hasCwdConflict(seedCard.cwd, targetCard.cwd) || hasCwdConflict(options.cwd, targetCard.cwd)) continue;
          const directTarget = directMemoryHits.get(targetCard.id);
          if (directTarget) {
            directTarget.hit.score = Number((directTarget.hit.score + syn.weight * 8).toFixed(2));
            continue;
          }
          const spreadScore = Number((seedHit.score * syn.weight * 0.45 + (targetCard.pinned ? 6 : 0)).toFixed(2));
          if (spreadScore < 32) continue;
          const prevSpread = spreadCandidates.get(targetCard.id);
          if (!prevSpread || spreadScore > prevSpread.score) {
            spreadCandidates.set(targetCard.id, {
              kind: 'memory', id: targetCard.id, memoryId: targetCard.id, score: spreadScore, at: targetCard.updatedAt,
              title: `记忆卡片${targetCard.pinned ? ' [核心]' : ''} · ${targetCard.topic}（⚡ 突触扩散激活）`,
              snippet: buildSnippet(targetCard.content, '', 360),
              cwd: targetCard.cwd, tags: targetCard.tags,
              ...(targetCard.synapses?.length ? { synapses: targetCard.synapses } : {}),
              activatedVia: { memoryId: seedCard.id, topic: seedCard.topic, weight: syn.weight, relation: syn.relation },
              taskId: targetCard.sourceTaskId, messageId: targetCard.sourceMessageId,
            });
          }
        }
      }
      for (const spreadHit of spreadCandidates.values()) hits.push(spreadHit);
    }
    if (scope === 'all' || scope === 'works') {
      for (const task of this.list(200)) {
        const header = `${task.prompt} ${task.cwd ?? ''} ${(task.paths ?? []).join(' ')} ${task.profile ?? ''}`;
        const bodyText = `${task.report ?? ''}\n${task.reason ?? ''}\n${task.contextBrief ?? ''}`;
        const { score, firstAnchor } = scoreText(header, bodyText);
        if (score <= 0) continue;
        const base = task.status === 'completed' ? 18 : 12;
        const finalScore = Number((base + score + cwdBonus(task.cwd) + recencyBonus(task.createdAt)).toFixed(2));
        if (finalScore <= 0) continue;
        hits.push({
          kind: 'work', id: task.id, taskId: task.id, score: finalScore, at: task.createdAt,
          title: `后台工作 (${task.status}) · ${String(publicData(task.prompt.slice(0, 100)))}`,
          snippet: buildSnippet(task.report ?? task.reason ?? task.prompt, firstAnchor, 320),
          cwd: task.cwd, status: task.status,
          parentTaskId: task.parentTaskId, originMessageId: task.originMessageId,
        });
      }
    }
    if (scope === 'all' || scope === 'messages') {
      for (const msg of this.conversation.allMessages(300)) {
        const header = `${msg.role} ${msg.paths.join(' ')}`;
        const { score, firstAnchor } = scoreText(header, msg.text);
        if (score <= 0) continue;
        const finalScore = Number((10 + score + recencyBonus(msg.at)).toFixed(2));
        hits.push({
          kind: 'message', id: msg.id, messageId: msg.id, score: finalScore, at: msg.at,
          title: `历史对话 (${msg.role === 'user' ? '用户' : 'F.R.I.D.A.Y.'}) · #${msg.seq}`,
          snippet: buildSnippet(msg.text, firstAnchor, 280),
          neighbors: this.conversation.neighbors(msg.seq, 1),
          linkedTaskIds: msg.taskIds.length ? msg.taskIds : undefined,
        });
      }
    }
    hits.sort((a, b) => b.score - a.score || b.at - a.at);
    const topHits = hits.slice(0, limit);
    if (options.touch) {
      for (const hit of topHits) {
        if (hit.kind === 'memory' && hit.memoryId) {
          this.touchMemory(hit.memoryId);
        }
      }
    }
    return {
      query: rawQuery, scope, totalHits: hits.length,
      hits: topHits,
      memoryDirectory: this.memoryDirectory(16),
    };
  }
  async searchContextAsync(options: Parameters<Store['searchContext']>[0]): Promise<ReturnType<Store['searchContext']>> {
    const rawQuery = options.query.trim();
    if (!rawQuery) throw new Error('Search query must not be empty');
    let queryEmbedding = options.queryEmbedding;
    const needsMemorySearch = options.scope === undefined || options.scope === 'all' || options.scope === 'memories';
    if (!queryEmbedding && needsMemorySearch && this.semantic?.isReady()) {
      try {
        queryEmbedding = await this.semantic.embed(rawQuery, 'query');
      } catch { /* graceful degradation */ }
    }
    return this.searchContext({ ...options, queryEmbedding });
  }
  async backfillEmbeddings(limit = 64, signal?: AbortSignal): Promise<number> {
    const engine = this.semantic;
    if (!engine || signal?.aborted) return 0;
    if (!engine.isReady()) {
      if (!engine.ensureReady) return 0;
      try {
        const ok = await engine.ensureReady(signal);
        if (!ok || signal?.aborted) return 0;
      } catch {
        return 0;
      }
    }
    const maxCount = Math.max(1, Math.min(limit, 500));
    const active = this.listMemories({ includeSuperseded: false, limit: 500 });
    const pending: Array<{ card: MemoryCard; docText: string; docHash: string }> = [];
    for (const card of active) {
      if (pending.length >= maxCount) break;
      const docText = memoryDocumentText(card);
      const docHash = computeSemanticContentHash(docText);
      const cached = this.embeddingCache.get(card.id);
      if (cached && cached.modelId === engine.modelId && cached.contentHash === docHash) continue;
      pending.push({ card, docText, docHash });
    }
    if (!pending.length) return 0;

    let updated = 0;
    const batchSize = 16;
    for (let offset = 0; offset < pending.length; offset += batchSize) {
      if (signal?.aborted) break;
      const chunk = pending.slice(offset, offset + batchSize);
      let vectors: Array<Float32Array | undefined>;
      try {
        if (engine.embedBatch) {
          vectors = await engine.embedBatch(chunk.map(item => item.docText), 'document');
        } else {
          vectors = [];
          for (const item of chunk) {
            if (signal?.aborted) break;
            vectors.push(await engine.embed(item.docText, 'document'));
          }
        }
      } catch {
        continue;
      }
      if (signal?.aborted) break;
      this.transaction(() => {
        const now = Date.now();
        for (let i = 0; i < Math.min(chunk.length, vectors.length); i++) {
          const item = chunk[i]!;
          const vec = vectors[i];
          if (!vec) continue;
          const row = this.db.prepare('SELECT superseded_by FROM memories WHERE id=?').get(item.card.id);
          if (!row || row.superseded_by !== null) continue;
          this.upsertEmbeddingRecord(item.card.id, engine.modelId, item.docHash, vec, now);
          updated++;
        }
      });
    }
    return updated;
  }
  consolidateTaskMemory(task: Task): MemoryCard | undefined {
    if (task.status !== 'completed' || !task.report) return undefined;
    if (this.listMemories({ includeSuperseded: true, limit: 200 }).some(m => m.sourceTaskId === task.id)) {
      return undefined;
    }
    const cleanPrompt = task.prompt.replace(/\s+/g, ' ').trim().slice(0, 60);
    const topic = `任务经验 · ${cleanPrompt}`;
    const reportSnippet = task.report.trim().slice(0, 1200);
    const tags = ['auto-consolidated', task.profile ?? 'general'].filter(Boolean);
    return this.saveMemory({
      topic,
      content: `任务目标：${task.prompt}\n交付摘要：${reportSnippet}`,
      tags,
      cwd: task.cwd,
      sourceTaskId: task.id,
      sourceMessageId: task.originMessageId,
      linkedMemoryIds: task.memoryIds,
    });
  }
  distillerState(): DistillerState {
    const saved = this.conversation.meta<DistillerState>('memory_distiller_state');
    if (saved && typeof saved === 'object') {
      return {
        lastMessageSeq: Number(saved.lastMessageSeq ?? 0),
        distilledTaskIds: Array.isArray(saved.distilledTaskIds) ? saved.distilledTaskIds.slice(-200) : [],
        lastRunAt: Number(saved.lastRunAt ?? 0),
      };
    }
    return { lastMessageSeq: 0, distilledTaskIds: [], lastRunAt: 0 };
  }
  saveDistillerState(state: DistillerState): void {
    this.conversation.setMeta('memory_distiller_state', {
      lastMessageSeq: Math.max(0, Number(state.lastMessageSeq ?? 0)),
      distilledTaskIds: [...new Set((state.distilledTaskIds ?? []).filter(Boolean))].slice(-200),
      lastRunAt: Math.max(0, Number(state.lastRunAt ?? 0)),
    });
  }
  initDistillerStateIfMissing(): DistillerState {
    const saved = this.conversation.meta<DistillerState>('memory_distiller_state');
    if (saved && typeof saved === 'object') return this.distillerState();
    const latestSeq = this.conversation.allMessages(1)[0]?.seq ?? 0;
    const existingCompletedIds = this.list(120)
      .filter(task => task.status === 'completed')
      .map(task => task.id)
      .slice(-200);
    const initial: DistillerState = {
      lastMessageSeq: latestSeq,
      distilledTaskIds: existingCompletedIds,
      lastRunAt: 0,
    };
    this.saveDistillerState(initial);
    return initial;
  }
  markDistilled(update: { latestMessageSeq?: number; taskIds?: string[]; now?: number }): void {
    this.transaction(() => {
      const prev = this.distillerState();
      const nextSeq = update.latestMessageSeq !== undefined
        ? Math.max(prev.lastMessageSeq, update.latestMessageSeq)
        : prev.lastMessageSeq;
      const nextTaskIds = update.taskIds?.length
        ? [...new Set([...prev.distilledTaskIds, ...update.taskIds.filter(Boolean)])].slice(-200)
        : prev.distilledTaskIds;
      this.saveDistillerState({
        lastMessageSeq: nextSeq,
        distilledTaskIds: nextTaskIds,
        lastRunAt: update.now ?? Date.now(),
      });

      const sub = this.subconsciousState();
      const nextSubSeq = update.latestMessageSeq !== undefined
        ? Math.max(sub.lastMessageSeq, update.latestMessageSeq)
        : sub.lastMessageSeq;
      const nextSubTasks = update.taskIds?.length
        ? [...new Set([...sub.digestedTaskIds, ...update.taskIds.filter(Boolean)])].slice(-120)
        : sub.digestedTaskIds;
      this.saveSubconsciousState({
        ...sub,
        lastMessageSeq: nextSubSeq,
        digestedTaskIds: nextSubTasks,
      });
    });
  }
  subconsciousState(): SubconsciousState {
    const saved = this.conversation.meta<SubconsciousState>('subconscious_state');
    if (saved && typeof saved === 'object') {
      return {
        lastWakeAt: Number(saved.lastWakeAt ?? 0),
        lastMessageSeq: Number(saved.lastMessageSeq ?? 0),
        digestedTaskIds: Array.isArray(saved.digestedTaskIds) ? saved.digestedTaskIds.slice(-120) : [],
        ...(typeof saved.nextLatencyMs === 'number' ? { nextLatencyMs: saved.nextLatencyMs } : {}),
        ...(typeof saved.refractoryMs === 'number' ? { refractoryMs: saved.refractoryMs } : {}),
        residues: Array.isArray(saved.residues) ? saved.residues : [],
      };
    }
    return { lastWakeAt: 0, lastMessageSeq: 0, digestedTaskIds: [], residues: [] };
  }
  saveSubconsciousState(state: SubconsciousState) {
    const trimmedResidues = state.residues.slice(-3);
    this.hasResiduesCache = trimmedResidues.length > 0;
    this.conversation.setMeta('subconscious_state', {
      ...state,
      digestedTaskIds: state.digestedTaskIds.slice(-120),
      residues: trimmedResidues,
    });
  }
  homeostaticSleepPass(
    now = Date.now(),
    options?: {
      decayAfterMs?: number;
      decayFactor?: number;
      minWeight?: number;
      stubMaxAgeMs?: number;
      coldMaxAgeMs?: number;
      coldImportanceThreshold?: number;
      coldDecayStep?: number;
      coldPruneThreshold?: number;
    },
  ): { scaledSynapses: number; prunedSynapses: number; forgottenStubs: number; decayedCards: number; prunedColdCards: number } {
    const decayAfterMs = options?.decayAfterMs ?? 24 * 3600_000;
    const decayFactor = options?.decayFactor ?? 0.82;
    const minWeight = options?.minWeight ?? 0.30;
    const stubMaxAgeMs = options?.stubMaxAgeMs ?? 7 * 24 * 3600_000;
    const coldMaxAgeMs = options?.coldMaxAgeMs ?? 45 * 24 * 3600_000;
    const coldImportanceThreshold = options?.coldImportanceThreshold ?? 55;
    const coldPruneThreshold = options?.coldPruneThreshold ?? 20;
    let scaledSynapses = 0;
    let prunedSynapses = 0;
    let forgottenStubs = 0;
    let decayedCards = 0;
    let prunedColdCards = 0;
    return this.transaction(() => {
      const active = this.listMemories({ includeSuperseded: false, limit: 500 });
      for (const card of active) {
        const imp = card.importance ?? defaultImportanceFor(card);
        const recentlyReinforced = Boolean(card.lastReinforcedAt && now - card.lastReinforcedAt < stubMaxAgeMs);
        if (
          isAutoStubCard(card)
          && !card.pinned
          && imp < 85
          && (card.accessCount ?? 0) < 3
          && !recentlyReinforced
          && now - card.updatedAt >= stubMaxAgeMs
        ) {
          if (this.deleteMemory(card.id)) forgottenStubs++;
          continue;
        }
        let cardMutated = false;
        const lastActiveAt = Math.max(card.lastAccessedAt ?? 0, card.lastReinforcedAt ?? 0, card.updatedAt);
        const coldAgeMs = now - lastActiveAt;
        if (!card.pinned && imp < 75 && imp < coldImportanceThreshold && coldAgeMs >= coldMaxAgeMs) {
          const overdueBuckets = Math.floor((coldAgeMs - coldMaxAgeMs) / (15 * 24 * 3600_000));
          const decayStep = options?.coldDecayStep ?? Math.min(35, 15 + overdueBuckets * 10);
          const nextImp = Math.max(0, imp - decayStep);
          if (nextImp <= coldPruneThreshold) {
            if (this.deleteMemory(card.id)) prunedColdCards++;
            continue;
          }
          if (nextImp !== imp) {
            card.importance = nextImp;
            decayedCards++;
            cardMutated = true;
          }
        }
        if (card.synapses?.length) {
          let synMutated = false;
          const nextSynapses: MemorySynapse[] = [];
          for (const syn of card.synapses) {
            if (syn.relation === 'explicit' || now - syn.updatedAt < decayAfterMs) {
              nextSynapses.push(syn);
              continue;
            }
            const decayed = Number((syn.weight * decayFactor).toFixed(2));
            if (decayed < minWeight) {
              prunedSynapses++;
              synMutated = true;
            } else {
              if (decayed !== syn.weight) {
                scaledSynapses++;
                synMutated = true;
              }
              nextSynapses.push({ ...syn, weight: decayed });
            }
          }
          if (synMutated) {
            const trimmed = this.trimSynapses(nextSynapses);
            card.synapses = trimmed.length ? trimmed : undefined;
            cardMutated = true;
          }
        }
        if (cardMutated) {
          this.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(card), card.id);
        }
      }
      return { scaledSynapses, prunedSynapses, forgottenStubs, decayedCards, prunedColdCards };
    });
  }
  sampleDreamMaterial(random: () => number = Math.random): DreamMaterial {
    const state = this.subconsciousState();
    const recentMsgs = this.conversation.allMessages(60).reverse();
    const latestMessageSeq = recentMsgs.at(-1)?.seq ?? state.lastMessageSeq;
    const undigestedMessages = recentMsgs
      .filter(m => m.seq > state.lastMessageSeq && m.status === 'completed' && m.source !== 'system' && m.text.trim().length > 0)
      .slice(-24)
      .map(m => ({ id: m.id, seq: m.seq, role: m.role, text: String(publicData(m.text.slice(0, 800))), at: m.at }));

    const digestedSet = new Set(state.digestedTaskIds);
    const completedTasks = this.list(60).filter(t => t.status === 'completed' && Boolean(t.report));
    const undigestedTasks = completedTasks
      .filter(t => !digestedSet.has(t.id))
      .slice(-8)
      .map(t => ({
        id: t.id,
        prompt: String(publicData(t.prompt.slice(0, 240))),
        cwd: t.cwd,
        profile: t.profile,
        reportSnippet: String(publicData((t.report ?? '').slice(0, 1000))),
        createdAt: t.createdAt,
      }));

    const allActive = this.listMemories({ includeSuperseded: false, limit: 250 });
    const rawStubs = allActive.filter(c => c.tags.includes('auto-consolidated')).slice(0, 8);
    const stubIds = new Set(rawStubs.map(c => c.id));
    const recentCwds = new Set<string>();
    const recentTags = new Set<string>();
    for (const t of undigestedTasks) if (t.cwd) recentCwds.add(t.cwd);
    for (const s of rawStubs) {
      if (s.cwd) recentCwds.add(s.cwd);
      for (const tag of s.tags) if (tag !== 'auto-consolidated') recentTags.add(tag.toLowerCase());
    }

    // Weighted reservoir-like random pick favoring distant / cross-domain neurons (different cwd or unshared tags)
    const pool = allActive.filter(c => !stubIds.has(c.id));
    const distantMemories: MemoryCard[] = [];
    const targetCount = Math.min(pool.length, random() < 0.5 ? 2 : 3);
    const candidates = [...pool];
    while (distantMemories.length < targetCount && candidates.length > 0) {
      const weights = candidates.map(card => {
        const diffCwd = !card.cwd || !recentCwds.has(card.cwd) ? 2.2 : 0.7;
        const hasOverlapTag = card.tags.some(t => recentTags.has(t.toLowerCase()));
        const novelty = hasOverlapTag ? 0.8 : 2.0;
        const dormancy = Math.max(0.6, 1.8 - Math.min(1.2, (card.accessCount ?? 0) * 0.15));
        return diffCwd * novelty * dormancy;
      });
      const sum = weights.reduce((acc, w) => acc + w, 0);
      let r = random() * sum;
      let pickedIdx = 0;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i]!;
        if (r <= 0) { pickedIdx = i; break; }
      }
      distantMemories.push(candidates.splice(pickedIdx, 1)[0]!);
    }

    const candidateCwds = [...new Set([
      ...undigestedTasks.map(t => t.cwd),
      ...rawStubs.map(c => c.cwd),
      ...distantMemories.map(c => c.cwd),
    ].filter((c): c is string => Boolean(c)))].slice(0, 3);

    return {
      undigestedMessages,
      undigestedTasks,
      rawStubs,
      distantMemories,
      candidateCwds,
      latestMessageSeq,
      completedTaskIds: completedTasks.map(t => t.id),
    };
  }
  private classifyResidueVividness(r: SubconsciousResidue, now: number): 'clear' | 'hazy' | 'forgotten' {
    const ageMs = Math.max(0, now - r.createdAt);
    if (r.interrupted) {
      return ageMs <= 2 * 3600_000 && r.turnsElapsed <= 1 ? 'hazy' : 'forgotten';
    }
    if (r.salience === 'vivid') {
      if (ageMs <= 8 * 3600_000 && r.turnsElapsed <= 3) return 'clear';
      if (ageMs <= 24 * 3600_000 && r.turnsElapsed <= 7) return 'hazy';
      return 'forgotten';
    }
    if (ageMs <= 3 * 3600_000 && r.turnsElapsed <= 2) return 'clear';
    if (ageMs <= 12 * 3600_000 && r.turnsElapsed <= 5) return 'hazy';
    return 'forgotten';
  }
  recordDreamOutcome(input: {
    now?: number;
    completed: boolean;
    latestMessageSeq?: number;
    digestedTaskIds?: string[];
    refractoryMs?: number;
    nextLatencyMs?: number;
    residue?: { impression: string; insight?: string; salience: 'faint' | 'vivid'; interrupted?: boolean };
  }) {
    const now = input.now ?? Date.now();
    this.transaction(() => {
      const state = this.subconsciousState();
      if (input.completed) {
        state.lastWakeAt = now;
        if (input.latestMessageSeq !== undefined) state.lastMessageSeq = Math.max(state.lastMessageSeq, input.latestMessageSeq);
        if (input.digestedTaskIds?.length) {
          state.digestedTaskIds = [...new Set([...state.digestedTaskIds, ...input.digestedTaskIds])].slice(-120);
        }
        if (input.refractoryMs !== undefined) state.refractoryMs = input.refractoryMs;
      }
      if (input.nextLatencyMs !== undefined) state.nextLatencyMs = input.nextLatencyMs;
      state.residues = state.residues.filter(r => this.classifyResidueVividness(r, now) !== 'forgotten');
      if (input.residue && input.residue.impression.trim()) {
        const cleanImpression = String(publicData(input.residue.impression.trim())).slice(0, 480);
        const cleanInsight = input.residue.insight?.trim()
          ? String(publicData(input.residue.insight.trim())).slice(0, 360)
          : undefined;
        state.residues.push({
          id: randomUUID(),
          impression: cleanImpression,
          ...(cleanInsight ? { insight: cleanInsight } : {}),
          salience: cleanInsight && input.residue.salience === 'vivid' ? 'vivid' : 'faint',
          ...(input.residue.interrupted ? { interrupted: true } : {}),
          createdAt: now,
          turnsElapsed: 0,
        });
      }
      this.saveSubconsciousState(state);
    });
  }
  peekSubconsciousForChat(now = Date.now()): ChatSubconscious | undefined {
    if (!this.hasResiduesCache) return undefined;
    const state = this.subconsciousState();
    const alive = state.residues.filter(r => this.classifyResidueVividness(r, now) !== 'forgotten');
    if (alive.length !== state.residues.length) {
      state.residues = alive;
      this.saveSubconsciousState(state);
    }
    if (!alive.length) return undefined;
    const vividPending = [...alive].reverse().find(r =>
      r.salience === 'vivid' && r.insight && !r.insightSurfaced && (now - r.createdAt) <= 36 * 3600_000,
    );
    const impressions = alive.map(r => {
      const vividness = this.classifyResidueVividness(r, now) as 'clear' | 'hazy';
      const text = vividness === 'clear'
        ? r.impression
        : r.impression.slice(0, 110) + (r.impression.length > 110 ? '…（醒来已久，其余画面已模糊）' : '');
      return {
        vividness,
        text,
        ...(r.interrupted ? { interrupted: true } : {}),
        hoursAgo: Number((Math.max(0, now - r.createdAt) / 3600_000).toFixed(1)),
      };
    });
    return {
      ...(vividPending ? { pendingInsight: { id: vividPending.id, insight: vividPending.insight! } } : {}),
      impressions,
    };
  }
  advanceSubconsciousTurn(surfacedInsightId?: string, now = Date.now()) {
    if (!this.hasResiduesCache) return;
    const state = this.subconsciousState();
    if (!state.residues.length) return;
    let changed = false;
    const next: SubconsciousResidue[] = [];
    for (const r of state.residues) {
      const updated: SubconsciousResidue = {
        ...r,
        turnsElapsed: r.turnsElapsed + 1,
        ...(surfacedInsightId && r.id === surfacedInsightId ? { insightSurfaced: true } : {}),
      };
      changed = true;
      if (this.classifyResidueVividness(updated, now) !== 'forgotten') next.push(updated);
    }
    if (changed) {
      state.residues = next;
      this.saveSubconsciousState(state);
    }
  }
  notice(taskId: string, kind: string, text: string) {
    this.db.prepare('INSERT INTO notices(task_id,kind,text,at) VALUES(?,?,?,?)').run(taskId, kind, text.length > 4096 ? text.slice(0, 4096) + '\n[notice truncated; use get for the full task report]' : text, Date.now());
    const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(taskId);
    if (!row) return;
    const task = JSON.parse(String(row.body)) as Task;
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
      for (const row of this.db.prepare("SELECT body FROM operations WHERE json_extract(body,'$.status') IN ('requested','started','cancel_requested') ORDER BY rowid").all()) {
        const op = JSON.parse(String(row.body)) as Operation;
        op.status = 'unknown'; this.operation(op);
      }
      for (const row of this.db.prepare("SELECT body FROM tasks WHERE json_extract(body,'$.status') IN ('running','queued') ORDER BY rowid").all()) {
        const task = JSON.parse(String(row.body)) as Task;
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
      this.conversation.recover();
    });
  }
  close() { this.db.close(); }
}

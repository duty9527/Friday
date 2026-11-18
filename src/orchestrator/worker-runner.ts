import { performance } from 'node:perf_hooks';
import type { AgentPort } from '../agent.js';
import { FALLBACK_PROVIDER_MODELS, normalizeProviderId, REAL_PROVIDER_DEFAULTS } from '../models/catalog.js';
import type { Operation, Store, Task, TaskStatus } from '../store.js';
import type { PromptTrace } from '../trace.js';
import type { AttachmentView, ChatMessage, MessageOrigin, ModelTier, PooledModelEntry, ThinkingLevel, WorkerProfile } from '../view.js';
import { resolveRecentSessionImages } from './chat-coalescer.js';

export interface Run {
  id: string;
  revision: number;
  controller: AbortController;
  worker?: AgentPort;
  jobs: number;
  activeCalls: number;
  clockUncertain: boolean;
  reads: Map<string, Promise<Operation>>;
  completions: Operation[];
  stopping?: 'paused' | 'cancelled' | 'failed';
  lastTick: number;
  lastWall: number;
  pendingActiveMs?: number;
  lastPersistedAt?: number;
  trace?: PromptTrace;
  replyId?: string;
  wakeFollowup?: () => void;
  /** The Router already spoke about this failure (WORKER_FAILED turn); no system notice is needed. */
  failureRouted?: boolean;
  acceptedByRouter?: boolean;
  resumed?: boolean;
  userStopped?: boolean;
  deliveryOrigin?: MessageOrigin;
  replyController?: AbortController;
  attachments?: AttachmentView[];
  pendingFollowupAttachments?: AttachmentView[];
}

export interface ChatWork {
  originMessageId?: string;
  origin?: MessageOrigin;
  parentTaskId?: string;
  parentSpanId?: string;
  source?: Task;
  signal: AbortSignal;
  cwd?: string;
  contextBrief?: string;
  memoryIds?: string[];
  profile?: WorkerProfile;
  workerModel?: string;
  modelTier?: ModelTier;
  thinkingLevel?: ThinkingLevel;
  attachments?: AttachmentView[];
}

export class SourceChangedError extends Error {}

export const unsettled = (op: Operation): boolean =>
  ['requested', 'started', 'cancel_requested', 'unknown'].includes(op.status);

export const CLOCK_DRIFT_MAX_MS = 1_500;
export const HEARTBEAT_STALL_MAX_MS = 15_000;
export const TASK_ACTIVE_PERSIST_INTERVAL_MS = 2_500;

export const taskStatusNeedsNotice = (status: TaskStatus): boolean =>
  ['paused', 'cancelled', 'failed'].includes(status);

export function dedupeAttachments(items: AttachmentView[]): AttachmentView[] {
  const seen = new Set<string>();
  const out: AttachmentView[] = [];
  for (const item of items) {
    const key = `${item.kind}\0${item.name}\0${item.path ?? ''}\0${item.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function resolveMessageAttachments(store: Store, message: ChatMessage): AttachmentView[] {
  const own = message.attachments ?? [];
  const carried = own.some(a => a.kind === 'image' && a.status === 'ready' && a.path)
    ? []
    : resolveRecentSessionImages(store, message);
  return dedupeAttachments([...own, ...carried]);
}

export function resolveTaskAttachments(store: Store, task: Task, runAttachments?: AttachmentView[]): AttachmentView[] {
  if (runAttachments?.length) return dedupeAttachments(runAttachments);
  const collected: AttachmentView[] = [];
  if (task.originMessageId) {
    try {
      const originMsg = store.conversation.get(task.originMessageId);
      collected.push(...resolveMessageAttachments(store, originMsg));
    } catch { /* origin message may not exist */ }
  }
  if (!collected.length && task.parentTaskId) {
    try {
      const parent = store.get(task.parentTaskId);
      if (parent.originMessageId) {
        const parentOrigin = store.conversation.get(parent.originMessageId);
        collected.push(...resolveMessageAttachments(store, parentOrigin));
      }
    } catch { /* ignore */ }
  }
  return dedupeAttachments(collected);
}

export function accrueTaskRun(store: Store, run: Run, flush = true): boolean {
  const now = performance.now();
  const wall = Date.now();
  const elapsed = now - run.lastTick;
  const wallElapsed = wall - run.lastWall;
  run.lastTick = now;
  run.lastWall = wall;
  const known = elapsed >= 0 && elapsed <= HEARTBEAT_STALL_MAX_MS && Math.abs(wallElapsed - elapsed) <= CLOCK_DRIFT_MAX_MS;
  const task = store.get(run.id);
  if (task.status === 'running' && (run.activeCalls > 0 || run.reads.size > 0)) {
    if (known) {
      const pending = (run.pendingActiveMs ?? 0) + elapsed;
      run.pendingActiveMs = pending;
      if (
        flush
        || task.activeMs + pending >= task.limitMs
        || now - (run.lastPersistedAt ?? 0) >= TASK_ACTIVE_PERSIST_INTERVAL_MS
      ) {
        task.activeMs += pending;
        run.pendingActiveMs = 0;
        run.lastPersistedAt = now;
        store.save(task);
      }
    } else {
      run.clockUncertain = true;
    }
  } else if (flush && (run.pendingActiveMs ?? 0) > 0) {
    task.activeMs += run.pendingActiveMs!;
    run.pendingActiveMs = 0;
    run.lastPersistedAt = now;
    store.save(task);
  }
  return !run.clockUncertain;
}

const KNOWN_SPEC_PROVIDERS = new Set<string>([
  ...Object.keys(FALLBACK_PROVIDER_MODELS),
  ...Object.keys(REAL_PROVIDER_DEFAULTS),
  'google-vertex',
  'gemini',
  'groq',
  'mistral',
  'bedrock',
  'azure',
  'opencode',
]);

export function extractModelProvider(spec: string | undefined, pool?: PooledModelEntry[]): string | undefined {
  if (!spec) return undefined;
  const trimmed = spec.trim();
  if (!trimmed) return undefined;
  if (pool?.length) {
    const exact = pool.find(entry => entry.spec === trimmed) ?? pool.find(entry => entry.modelId === trimmed);
    if (exact) return exact.providerId;
  }
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return undefined;
  const head = trimmed.slice(0, slash);
  const norm = normalizeProviderId(head) ?? head;
  return KNOWN_SPEC_PROVIDERS.has(head) || KNOWN_SPEC_PROVIDERS.has(norm) ? norm : undefined;
}

function extractStandaloneOuterJson(trimmed: string): string | undefined {
  let inner = trimmed;
  if (inner.startsWith('```')) {
    const openMatch = /^```(?:json)?[ \t]*\r?\n/.exec(inner);
    const closeMatch = /\r?\n```[ \t]*$/.exec(inner);
    if (!openMatch || !closeMatch || closeMatch.index < openMatch[0].length) {
      return undefined;
    }
    inner = inner.slice(openMatch[0].length, closeMatch.index).trim();
  }
  if (!inner.startsWith('{') || !inner.endsWith('}')) return undefined;
  return inner;
}

export function parseWorkerQuestion(raw: string): { question: string; options?: string[] } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const tagMatch = /^\s*\[\[?ASK_BOSS\]?\]\s*[:：]?\s*([\s\S]+)$/i.exec(trimmed);
  if (tagMatch?.[1]?.trim()) {
    return { question: tagMatch[1].trim().slice(0, 1200) };
  }
  if (!/ASK_BOSS/.test(trimmed)) return undefined;
  const candidate = extractStandaloneOuterJson(trimmed);
  if (!candidate) return undefined;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (parsed.kind !== 'ASK_BOSS') return undefined;
    const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';
    if (!question) return undefined;
    const options = Array.isArray(parsed.options)
      ? parsed.options.filter((o): o is string => typeof o === 'string' && Boolean(o.trim())).map(o => o.trim().slice(0, 200)).slice(0, 6)
      : undefined;
    return { question: question.slice(0, 1200), ...(options?.length ? { options } : {}) };
  } catch {
    return undefined;
  }
}

/**
 * Host-level circuit breaker: if at least two recent works on the same provider crashed with the identical
 * error, another dispatch to that provider is a retry of a known environment fault, not new work.
 */
export function detectProviderFailureBreaker(store: Store, workerModel: string | undefined): string | undefined {
  const provider = extractModelProvider(workerModel);
  const sameProvider = (model?: string) => provider
    ? extractModelProvider(model) === provider
    : !extractModelProvider(model);
  const since = Date.now() - 30 * 60_000;
  const counts = new Map<string, number>();
  for (const task of store.list()) {
    if (!task.decisionSource || task.status !== 'failed' || task.createdAt < since || !task.reason || !sameProvider(task.workerModel)) continue;
    counts.set(task.reason, (counts.get(task.reason) ?? 0) + 1);
  }
  for (const [reason, count] of counts) {
    if (count >= 2) {
      return `熔断：最近 30 分钟内已有 ${count} 个${provider ? ` ${provider} ` : ''}任务以相同错误失败（${reason.slice(0, 300)}）。这是环境/工具故障，不要再换花样派发；改用其他提供方的模型，或直接把错误原文告诉老板。`;
    }
  }
  return undefined;
}

export function resolveExcludedFailures(
  store: Store,
  pool: PooledModelEntry[],
  originMessageId: string | undefined,
  activeFailureTask: { id: string; reason: string; workerModel?: string; originMessageId?: string } | undefined,
): { excludedSpecs: string[]; excludedProviders: string[] } {
  const recentSince = Date.now() - 30 * 60_000;
  const failedSpecSet = new Set<string>();
  const excludedProviders: string[] = [];
  const providerFailureCounts = new Map<string, number>();

  const addFailedSpec = (spec: string) => {
    failedSpecSet.add(spec);
    for (const entry of pool) {
      if (entry.modelId === spec || entry.spec === spec) failedSpecSet.add(entry.spec);
    }
  };

  const recordProviderFailure = (spec: string | undefined, reason: string | undefined) => {
    if (!reason || !spec) return;
    const provider = extractModelProvider(spec, pool);
    if (!provider) return;
    const key = `${provider}\u0000${reason}`;
    const count = (providerFailureCounts.get(key) ?? 0) + 1;
    providerFailureCounts.set(key, count);
    if (count >= 2 && !excludedProviders.includes(provider)) excludedProviders.push(provider);
  };

  for (const prev of store.list()) {
    if (!prev.decisionSource || prev.status !== 'failed') continue;
    if (originMessageId && prev.originMessageId === originMessageId && prev.workerModel) {
      addFailedSpec(prev.workerModel);
    }
    if (prev.createdAt >= recentSince) {
      recordProviderFailure(prev.workerModel, prev.reason);
    }
  }

  if (activeFailureTask) {
    if (activeFailureTask.workerModel
      && (!originMessageId || !activeFailureTask.originMessageId || activeFailureTask.originMessageId === originMessageId)) {
      addFailedSpec(activeFailureTask.workerModel);
    }
    recordProviderFailure(activeFailureTask.workerModel, activeFailureTask.reason);
  }

  return { excludedSpecs: [...failedSpecSet], excludedProviders };
}

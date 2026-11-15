import { randomUUID } from 'node:crypto';
import type { AgentFactory } from './agent.js';
import { publicData } from './conversation.js';
import type { ThinkingLevel } from './decision.js';
import type { ModelHub } from './model-hub.js';
import type { Store, Task } from './store.js';
import type { ChatMessage, MemoryCard, ModelTier } from './view.js';

export const DEFAULT_DISTILL_IDLE_MS = 180_000;

export type DistillSaveOperation = {
  action: 'save';
  topic: string;
  content: string;
  tags: string[];
  cwd?: string;
  importance?: number;
  supersedeIds?: string[];
  linkedMemoryIds?: string[];
};

export type DistillForgetOperation = {
  action: 'forget';
  id: string;
};

export type DistillOperation = DistillSaveOperation | DistillForgetOperation;

export function resolveDistillIdleMs(overrideMs?: number): number {
  if (typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs >= 0) {
    return overrideMs;
  }
  const raw = process.env.FRIDAY_DISTILL_IDLE_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_DISTILL_IDLE_MS;
}

function sanitizeDistilledTopic(raw: string): string {
  return String(publicData(raw.trim()))
    .replace(/^(?:任务经验|阶段沉淀|梦境|做梦|Dream)\s*[·:：-]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function sanitizeDistilledTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const banned = /^(?:auto-consolidated|auto-summary|dream|dreaming|梦境|做梦)$/i;
  const cleaned = raw
    .filter((t): t is string => typeof t === 'string')
    .map(t => String(publicData(t.trim())).slice(0, 64))
    .filter(t => t && !banned.test(t));
  return [...new Set(cleaned)].slice(0, 12);
}

function sanitizeIdArray(raw: unknown, max = 16): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = [...new Set(
    raw
      .filter((item): item is string => typeof item === 'string')
      .map(s => s.trim().slice(0, 128))
      .filter(Boolean),
  )].slice(0, max);
  return ids.length ? ids : undefined;
}

export function parseDistillerOutput(
  raw: string,
  options?: { allowForget?: boolean; maxOps?: number },
): DistillOperation[] {
  const allowForget = Boolean(options?.allowForget);
  const maxOps = Math.max(1, options?.maxOps ?? 3);
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim();
  const candidate = fenced ?? (() => {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    return start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined;
  })();
  if (!candidate) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const rawOps = (parsed as { operations?: unknown }).operations;
  if (!Array.isArray(rawOps)) return [];

  const ops: DistillOperation[] = [];
  for (const item of rawOps) {
    if (ops.length >= maxOps) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const action = typeof obj.action === 'string' ? obj.action.trim().toLowerCase() : 'save';

    if (action === 'forget') {
      if (!allowForget) continue;
      const id = typeof obj.id === 'string' ? obj.id.trim().slice(0, 128) : '';
      if (!id) continue;
      ops.push({ action: 'forget', id });
      continue;
    }

    if (action !== 'save') continue;
    const rawTopic = typeof obj.topic === 'string' ? obj.topic : '';
    const rawContent = typeof obj.content === 'string' ? obj.content : '';
    const topic = sanitizeDistilledTopic(rawTopic);
    const content = String(publicData(rawContent.trim())).slice(0, 4096);
    if (!topic || !content) continue;

    const tags = sanitizeDistilledTags(obj.tags);
    const cwd = typeof obj.cwd === 'string' && obj.cwd.trim() ? obj.cwd.trim().slice(0, 4096) : undefined;
    const rawImp = typeof obj.importance === 'number' && Number.isFinite(obj.importance)
      ? Math.max(25, Math.min(95, Math.round(obj.importance)))
      : undefined;
    const supersedeIds = sanitizeIdArray(obj.supersedeIds);
    const linkedMemoryIds = sanitizeIdArray(obj.linkedMemoryIds);

    ops.push({
      action: 'save',
      topic,
      content,
      tags,
      ...(cwd ? { cwd } : {}),
      ...(rawImp !== undefined ? { importance: rawImp } : {}),
      ...(supersedeIds ? { supersedeIds } : {}),
      ...(linkedMemoryIds ? { linkedMemoryIds } : {}),
    });
  }
  return ops;
}

export async function collectRelatedMemoriesForDistill(
  store: Store,
  queries: string[],
  cwd?: string,
  limit = 6,
): Promise<MemoryCard[]> {
  const byId = new Map<string, MemoryCard>();
  const normalizedTargetCwd = cwd?.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '';

  for (const rawQuery of queries.map(q => q.trim()).filter(Boolean).slice(0, 2)) {
    try {
      const result = await store.searchContextAsync({
        query: rawQuery.slice(0, 320),
        scope: 'memories',
        cwd,
        limit,
        touch: false,
      });
      for (const hit of result.hits) {
        if (hit.kind !== 'memory' || !hit.memoryId || byId.has(hit.memoryId)) continue;
        try {
          const card = store.getMemory(hit.memoryId);
          if (!card.supersededBy) byId.set(card.id, card);
        } catch {
          // ignore vanished card
        }
        if (byId.size >= limit) return [...byId.values()].slice(0, limit);
      }
    } catch {
      // ignore search error and fall back to active listing
    }
  }

  if (byId.size < limit) {
    const active = store.listMemories({ includeSuperseded: false, limit: 24 });
    for (const card of active) {
      if (byId.has(card.id)) continue;
      const cardCwd = card.cwd?.trim().replace(/\\/g, '/').replace(/\/+$/, '') || '';
      if (normalizedTargetCwd ? (cardCwd === normalizedTargetCwd || !cardCwd) : true) {
        byId.set(card.id, card);
        if (byId.size >= limit) break;
      }
    }
  }
  return [...byId.values()].slice(0, limit);
}

const DISPATCH_ACK_RE = /^(?:\[OFFLINE SIMULATION\]\s*)?(?:好的老板[，,、\s]*)?任务已下发[。！!.\s]*$/i;

export function shouldSkipTrivialChatBatch(messages: ChatMessage[]): boolean {
  const nonSystem = messages.filter(m => m.source !== 'system' && m.text.trim().length > 0);
  const userMsgs = nonSystem.filter(m => m.role === 'user');
  if (!userMsgs.length) return true;

  if (userMsgs.every(m => m.routing?.actions?.some(a => a.kind === 'save_memory' && a.status === 'accepted'))) {
    return true;
  }

  const assistantMsgs = nonSystem.filter(m => m.role === 'assistant');
  if (assistantMsgs.length > 0 && assistantMsgs.every(m => DISPATCH_ACK_RE.test(m.text.trim()))) {
    return true;
  }
  return false;
}

export function resolveDistillerModel(modelHub: ModelHub): {
  model?: string;
  tier: ModelTier;
  thinkingLevel: ThinkingLevel;
} {
  try {
    const picked = modelHub.selectWorkerModel({
      tier: 'fast',
      profile: 'research',
      thinkingLevel: 'low',
    });
    return {
      model: picked.model,
      tier: picked.tier,
      thinkingLevel: picked.thinkingLevel,
    };
  } catch {
    return { tier: 'fast', thinkingLevel: 'low' };
  }
}

function formatRelatedForPrompt(cards: MemoryCard[]) {
  return cards.map(card => ({
    id: card.id,
    topic: card.topic,
    content: card.content.slice(0, 800),
    tags: card.tags,
    ...(card.cwd ? { cwd: card.cwd } : {}),
    ...(card.pinned ? { pinned: true } : {}),
    ...(card.importance !== undefined ? { importance: card.importance } : {}),
  }));
}

async function applySaveOperations(
  store: Store,
  ops: DistillOperation[],
  defaults: { cwd?: string; sourceTaskId?: string; sourceMessageId?: string },
): Promise<MemoryCard[]> {
  const saved: MemoryCard[] = [];
  for (const op of ops) {
    if (op.action !== 'save') continue;
    const validSupersedeIds = op.supersedeIds?.filter(id => {
      try {
        const card = store.getMemory(id);
        return !card.supersededBy;
      } catch {
        return false;
      }
    });
    const validLinkedIds = op.linkedMemoryIds?.filter(id => {
      try {
        store.getMemory(id);
        return true;
      } catch {
        return false;
      }
    });
    const card = await store.saveMemoryAsync({
      topic: op.topic,
      content: op.content,
      tags: op.tags,
      cwd: op.cwd ?? defaults.cwd,
      ...(defaults.sourceTaskId ? { sourceTaskId: defaults.sourceTaskId } : {}),
      ...(defaults.sourceMessageId ? { sourceMessageId: defaults.sourceMessageId } : {}),
      ...(op.importance !== undefined ? { importance: op.importance } : {}),
      ...(validSupersedeIds?.length ? { supersedeIds: validSupersedeIds } : {}),
      ...(validLinkedIds?.length ? { linkedMemoryIds: validLinkedIds } : {}),
    });
    saved.push(card);
  }
  return saved;
}

export async function distillCompletedTask(params: {
  store: Store;
  factory: AgentFactory;
  modelHub: ModelHub;
  task: Task;
  originUserText?: string;
  followups?: string[];
  signal?: AbortSignal;
}): Promise<{ saved: MemoryCard[] }> {
  const { store, factory, modelHub, task, originUserText, followups, signal } = params;
  signal?.throwIfAborted();

  const report = (task.report ?? '').trim();
  if (!report) {
    store.markDistilled({ taskIds: [task.id] });
    return { saved: [] };
  }

  const related = await collectRelatedMemoriesForDistill(
    store,
    [task.prompt, report.slice(0, 600)],
    task.cwd,
    6,
  );
  signal?.throwIfAborted();

  const resolved = resolveDistillerModel(modelHub);
  const agent = await factory.create('distiller', `distill-task-${randomUUID()}`, [], {
    execution: 'snapshot',
    cwd: task.cwd ?? process.cwd(),
    tier: resolved.tier,
    thinkingLevel: resolved.thinkingLevel,
    ...(resolved.model ? { model: resolved.model } : {}),
  });

  const timeoutSignal = AbortSignal.timeout(45_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let rawOutput: string;
  try {
    rawOutput = await agent.prompt(JSON.stringify({
      kind: 'DISTILL_TASK',
      task: {
        id: task.id,
        prompt: String(publicData(task.prompt.slice(0, 1200))),
        ...(originUserText ? { originUserText: String(publicData(originUserText.slice(0, 800))) } : {}),
        ...(followups?.length ? { followups: followups.slice(-6).map(f => String(publicData(f.slice(0, 400)))) } : {}),
        ...(task.cwd ? { cwd: task.cwd } : {}),
        ...(task.profile ? { profile: task.profile } : {}),
        report: String(publicData(report.slice(0, 6000))),
      },
      existingRelatedMemories: formatRelatedForPrompt(related),
    }), combinedSignal);
  } finally {
    agent.close();
  }

  signal?.throwIfAborted();
  const ops = parseDistillerOutput(rawOutput, { allowForget: false, maxOps: 3 });
  const saved = await applySaveOperations(store, ops, {
    cwd: task.cwd,
    sourceTaskId: task.id,
    sourceMessageId: task.originMessageId,
  });
  store.markDistilled({ taskIds: [task.id] });
  return { saved };
}

export async function distillIdleConversation(params: {
  store: Store;
  factory: AgentFactory;
  modelHub: ModelHub;
  messages: ChatMessage[];
  signal?: AbortSignal;
}): Promise<{ skipped?: boolean; saved: MemoryCard[] }> {
  const { store, factory, modelHub, messages, signal } = params;
  signal?.throwIfAborted();

  const eligible = messages
    .filter(m => m.status === 'completed' && m.source !== 'system' && m.text.trim().length > 0)
    .sort((a, b) => a.seq - b.seq)
    .slice(-20);
  if (!eligible.length) {
    return { skipped: true, saved: [] };
  }

  const maxSeq = Math.max(...eligible.map(m => m.seq));
  if (shouldSkipTrivialChatBatch(eligible)) {
    store.markDistilled({ latestMessageSeq: maxSeq });
    return { skipped: true, saved: [] };
  }

  const querySample = eligible
    .filter(m => m.role === 'user')
    .slice(-3)
    .map(m => m.text)
    .join('\n');
  const related = await collectRelatedMemoriesForDistill(store, [querySample], undefined, 6);
  signal?.throwIfAborted();

  const resolved = resolveDistillerModel(modelHub);
  const agent = await factory.create('distiller', `distill-chat-${randomUUID()}`, [], {
    execution: 'snapshot',
    cwd: process.cwd(),
    tier: resolved.tier,
    thinkingLevel: resolved.thinkingLevel,
    ...(resolved.model ? { model: resolved.model } : {}),
  });

  const timeoutSignal = AbortSignal.timeout(45_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let rawOutput: string;
  try {
    rawOutput = await agent.prompt(JSON.stringify({
      kind: 'DISTILL_CHAT',
      messages: eligible.map(m => ({
        seq: m.seq,
        role: m.role,
        ...(m.origin?.channel ? { channel: m.origin.channel } : {}),
        text: String(publicData(m.text.slice(0, 1200))),
      })),
      existingRelatedMemories: formatRelatedForPrompt(related),
    }), combinedSignal);
  } finally {
    agent.close();
  }

  signal?.throwIfAborted();
  const ops = parseDistillerOutput(rawOutput, { allowForget: false, maxOps: 3 });
  const latestUserMsg = [...eligible].reverse().find(m => m.role === 'user');
  const saved = await applySaveOperations(store, ops, {
    sourceMessageId: latestUserMsg?.id,
  });
  store.markDistilled({ latestMessageSeq: maxSeq });
  return { saved };
}

export async function cleanLegacyMemoriesWithModel(params: {
  store: Store;
  factory: AgentFactory;
  modelHub: ModelHub;
  signal?: AbortSignal;
}): Promise<{ saved: MemoryCard[]; forgottenIds: string[]; supersededIds: string[] }> {
  const { store, factory, modelHub, signal } = params;
  signal?.throwIfAborted();

  const activeMemories = store.listMemories({ includeSuperseded: false, limit: 250 });
  if (!activeMemories.length) {
    return { saved: [], forgottenIds: [], supersededIds: [] };
  }

  const resolved = resolveDistillerModel(modelHub);
  const agent = await factory.create('distiller', `distill-cleanup-${randomUUID()}`, [], {
    execution: 'snapshot',
    cwd: process.cwd(),
    tier: resolved.tier,
    thinkingLevel: resolved.thinkingLevel,
    ...(resolved.model ? { model: resolved.model } : {}),
  });

  const timeoutSignal = AbortSignal.timeout(90_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let rawOutput: string;
  try {
    rawOutput = await agent.prompt(JSON.stringify({
      kind: 'DISTILL_LEGACY_CLEANUP',
      activeMemories: activeMemories.map(card => ({
        id: card.id,
        topic: card.topic,
        content: card.content.slice(0, 1200),
        tags: card.tags,
        ...(card.cwd ? { cwd: card.cwd } : {}),
        pinned: Boolean(card.pinned),
        importance: card.importance,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
      })),
    }), combinedSignal);
  } finally {
    agent.close();
  }

  signal?.throwIfAborted();
  const ops = parseDistillerOutput(rawOutput, { allowForget: true, maxOps: 16 });
  const saved = await applySaveOperations(store, ops, {});

  const supersededIds: string[] = [];
  for (const op of ops) {
    if (op.action === 'save' && op.supersedeIds?.length) {
      for (const sid of op.supersedeIds) {
        if (!supersededIds.includes(sid)) supersededIds.push(sid);
      }
    }
  }

  const forgottenIds: string[] = [];
  for (const op of ops) {
    if (op.action !== 'forget') continue;
    try {
      const card = store.getMemory(op.id);
      if (card.pinned || card.supersededBy) continue;
      if (store.deleteMemory(op.id)) {
        forgottenIds.push(op.id);
      }
    } catch {
      // ignore missing/already-removed card
    }
  }

  return { saved, forgottenIds, supersededIds };
}

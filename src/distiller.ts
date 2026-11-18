import { randomUUID } from 'node:crypto';
import type { AgentFactory } from './agent.js';
import { publicData } from './conversation.js';
import type { ThinkingLevel } from './decision.js';
import type { ModelHub } from './model-hub.js';
import { normalizeCwd } from './semantic.js';
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

export type DistillOperation = DistillSaveOperation;

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

function extractBalancedJsonObjects(raw: string): unknown[] {
  const results: unknown[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== '{') {
      i++;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escape = false;
    let foundEnd = -1;
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j]!;
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          foundEnd = j;
          break;
        }
      }
    }
    if (foundEnd > i) {
      const candidate = raw.slice(i, foundEnd + 1);
      try {
        results.push(JSON.parse(candidate) as unknown);
      } catch {
        // Keep scanning for another valid JSON object.
      }
      i = foundEnd + 1;
    } else {
      i++;
    }
  }
  return results;
}

export function parseDistillerOutput(
  raw: string,
  options?: { maxOps?: number },
): DistillSaveOperation[] {
  const maxOps = Math.max(1, options?.maxOps ?? 3);
  const trimmed = raw.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  const fenceStart = /```(?:json)?\s*\r?\n?/i.exec(trimmed);
  if (fenceStart) {
    const afterStart = fenceStart.index + fenceStart[0].length;
    const lastFence = trimmed.lastIndexOf('```');
    const fencedBody = (lastFence >= afterStart ? trimmed.slice(afterStart, lastFence) : trimmed.slice(afterStart)).trim();
    try {
      const direct = JSON.parse(fencedBody) as unknown;
      if (direct && typeof direct === 'object' && !Array.isArray(direct) && Array.isArray((direct as { operations?: unknown }).operations)) {
        parsed = direct;
      }
    } catch {
      // Fall back to balanced JSON extraction (handles prose or embedded code fences).
    }
  }
  if (!parsed) {
    const candidates = extractBalancedJsonObjects(trimmed);
    parsed = candidates.find(
      item => Boolean(item) && typeof item === 'object' && !Array.isArray(item) && Array.isArray((item as { operations?: unknown }).operations),
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const rawOps = (parsed as { operations?: unknown }).operations;
  if (!Array.isArray(rawOps)) return [];

  const ops: DistillSaveOperation[] = [];
  for (const item of rawOps) {
    if (ops.length >= maxOps) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const action = typeof obj.action === 'string' ? obj.action.trim().toLowerCase() : 'save';

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
  const normalizedTargetCwd = normalizeCwd(cwd);

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
      const cardCwd = normalizeCwd(card.cwd);
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
  ops: DistillSaveOperation[],
  defaults: { cwd?: string; sourceTaskId?: string; sourceMessageId?: string },
): Promise<MemoryCard[]> {
  const saved: MemoryCard[] = [];
  for (const op of ops) {
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
  const ops = parseDistillerOutput(rawOutput, { maxOps: 3 });
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

  const sortedAll = [...messages].sort((a, b) => a.seq - b.seq);
  const firstIncompleteIdx = sortedAll.findIndex(m => ['queued', 'processing', 'streaming'].includes(m.status));
  const settledPrefix = firstIncompleteIdx >= 0 ? sortedAll.slice(0, firstIncompleteIdx) : sortedAll;
  const eligible = settledPrefix
    .filter(m => m.status === 'completed' && m.source !== 'system' && m.origin?.speakerRole !== 'member' && m.text.trim().length > 0)
    .slice(0, 20);
  if (!eligible.length) {
    const skippedCursor = settledPrefix.at(-1)?.seq;
    if (skippedCursor !== undefined) {
      store.markDistilled({ latestMessageSeq: skippedCursor });
    }
    return { skipped: true, saved: [] };
  }

  const maxSeq = eligible.at(-1)!.seq;
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
  const ops = parseDistillerOutput(rawOutput, { maxOps: 3 });
  const latestUserMsg = [...eligible].reverse().find(m => m.role === 'user');
  const saved = await applySaveOperations(store, ops, {
    sourceMessageId: latestUserMsg?.id,
  });
  store.markDistilled({ latestMessageSeq: maxSeq });
  return { saved };
}

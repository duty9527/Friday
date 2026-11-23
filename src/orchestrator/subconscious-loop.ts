import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { AgentFactory, AgentTool } from '../agent.js';
import { publicData } from '../conversation.js';
import { distillCompletedTask, distillIdleConversation, resolveDistillIdleMs } from '../distiller.js';
import type { ModelHub } from '../model-hub.js';
import { resolveEnv } from '../paths.js';
import { text } from '../protocol.js';
import type { SemanticEmbedder } from '../semantic.js';
import { formatDiaryLogicalDate, formatLocalDate, type DreamMaterial, type Store, type Task } from '../store.js';
import type { ChatMessage, ModelTier, SubconsciousStatusView, ThinkingLevel } from '../view.js';
import { parseStringArray, toolInput } from './router-tools.js';

export interface SleepDriveInput {
  undigestedMessages: number;
  undigestedTasks: number;
  rawStubs: number;
  idleMs: number;
  requiredLatencyMs: number;
  sinceLastWakeMs: number;
  refractoryMs: number;
  localHour: number;
}

export interface SleepDriveEvaluation {
  eligible: boolean;
  pressureS: number;
  circadianC: number;
  enterSleepProb: number;
  remProb: number;
}

export function computeSleepDrive(input: SleepDriveInput): SleepDriveEvaluation {
  const hasExperience = input.undigestedMessages >= 2 || input.undigestedTasks >= 1 || input.rawStubs >= 2;
  const experienceUnits = input.undigestedMessages * 0.14 + input.undigestedTasks * 0.45 + input.rawStubs * 0.28;
  const pressureS = hasExperience ? Number(Math.min(1, 1 - Math.exp(-experienceUnits * 0.65)).toFixed(3)) : 0;
  const h = ((input.localHour % 24) + 24) % 24;
  const circadianC = (h >= 1 && h < 5.5) ? 1.0
    : ((h >= 0 && h < 1) || (h >= 5.5 && h < 6.5)) ? 0.65
    : (h >= 13 && h < 14.5) ? 0.45
    : 0.14;
  const circadianLatencyScale = circadianC >= 0.9 ? 0.65 : circadianC >= 0.45 ? 0.9 : 1.25;
  const effectiveLatencyMs = Math.round(input.requiredLatencyMs * circadianLatencyScale);
  const eligible = hasExperience
    && input.sinceLastWakeMs >= input.refractoryMs
    && input.idleMs >= effectiveLatencyMs;
  if (!eligible) {
    return { eligible: false, pressureS, circadianC, enterSleepProb: 0, remProb: 0 };
  }
  const enterSleepProb = Number(Math.min(0.85, pressureS * circadianC * 0.32).toFixed(3));
  const remProb = Number(Math.min(0.92, 0.28 + pressureS * 0.44 + (circadianC >= 0.65 ? 0.25 : 0)).toFixed(3));
  return { eligible: true, pressureS, circadianC, enterSleepProb, remProb };
}

export interface SubconsciousRuntime {
  now?: () => number;
  random?: () => number;
  checkIntervalMs?: number;
  skipExecutor?: boolean;
  semantic?: SemanticEmbedder;
  semanticAutoDownload?: boolean;
  distillerEnabled?: boolean;
  distillIdleMs?: number;
  distillCheckIntervalMs?: number;
  pluginAutoRefresh?: boolean;
}

export function isRunningUnderNodeTest(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT)
    || process.execArgv.some(arg => arg === '--test' || arg.startsWith('--test-'));
}

const HOMEOSTASIS_LAST_AT_META_KEY = 'subconscious_homeostasis_at';
const HOMEOSTASIS_MIN_INTERVAL_MS = 12 * 3600_000;
const EVENING_DIARY_STATE_META_KEY = 'evening_diary_state';

export interface EveningDiaryState {
  lastEvaluatedDate?: string;
  scheduledDate?: string;
  scheduledMinute?: number;
  idleLatencyMs?: number;
  lastRunAt?: number;
  lastOutcome?: 'written' | 'skipped';
}

export interface EveningDiaryWindowDecision {
  action: 'wait' | 'schedule' | 'run';
  logicalDate?: string;
  nextState?: EveningDiaryState;
}

export function evaluateEveningDiaryWindow(input: {
  now: number;
  idleMs: number;
  state: EveningDiaryState;
  random: () => number;
}): EveningDiaryWindowDecision {
  const dt = new Date(input.now);
  const localHour = dt.getHours() + dt.getMinutes() / 60;
  const minuteOfDay = dt.getHours() * 60 + dt.getMinutes();

  let logicalDate: string;
  let isSpillover = false;
  if (localHour >= 21.5) {
    logicalDate = formatLocalDate(input.now);
  } else if (localHour < 1.0) {
    logicalDate = formatDiaryLogicalDate(input.now);
    isSpillover = true;
  } else {
    return { action: 'wait' };
  }

  if (input.state.lastEvaluatedDate === logicalDate) {
    return { action: 'wait' };
  }

  let activeState = input.state;
  let scheduledNow = false;
  if (activeState.scheduledDate !== logicalDate) {
    const scheduledMinute = 21 * 60 + 30 + Math.floor(input.random() * 135);
    const idleLatencyMs = Math.round((10 + input.random() * 15) * 60_000);
    activeState = {
      ...activeState,
      scheduledDate: logicalDate,
      scheduledMinute,
      idleLatencyMs,
    };
    scheduledNow = true;
  }

  const timeReady = isSpillover || minuteOfDay >= (activeState.scheduledMinute ?? (21 * 60 + 30));
  const idleReady = input.idleMs >= (activeState.idleLatencyMs ?? 15 * 60_000);
  if (timeReady && idleReady) {
    return {
      action: 'run',
      logicalDate,
      ...(scheduledNow ? { nextState: activeState } : {}),
    };
  }

  return scheduledNow
    ? { action: 'schedule', logicalDate, nextState: activeState }
    : { action: 'wait' };
}

function formatLocalHHMM(ts: number): string {
  const dt = new Date(ts);
  return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

function sanitizeDreamTags(tags?: string[]): string[] {
  return (tags ?? [])
    .map(t => t.trim())
    .filter(t => t && !/^(?:auto-consolidated|dream|dreaming|梦境|做梦)$/i.test(t));
}

function extractBalancedJsonObjects(raw: string): string[] {
  const out: string[] = [];
  let inString = false;
  let escape = false;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

export function parseDreamResidue(raw: string): { impression: string; insight?: string; salience: 'faint' | 'vivid' } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let unwrapped = trimmed;
  const openFence = /^```(?:json)?[ \t]*\r?\n/.exec(unwrapped);
  const closeFence = /\r?\n```[ \t]*$/.exec(unwrapped);
  if (openFence && closeFence && closeFence.index >= openFence[0].length) {
    unwrapped = unwrapped.slice(openFence[0].length, closeFence.index).trim();
  }
  const candidates = [unwrapped, ...extractBalancedJsonObjects(unwrapped), ...(unwrapped !== trimmed ? extractBalancedJsonObjects(trimmed) : [])];
  for (const candidate of candidates) {
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const impression = typeof parsed.impression === 'string' ? parsed.impression.trim() : '';
      const insight = typeof parsed.insight === 'string' && parsed.insight.trim() ? parsed.insight.trim() : undefined;
      const salience = parsed.salience === 'vivid' && insight ? 'vivid' : 'faint';
      if (impression) return { impression, ...(insight ? { insight } : {}), salience };
    } catch { /* try next balanced object */ }
  }
  return { impression: trimmed.replace(/\s+/g, ' ').slice(0, 280), salience: 'faint' };
}

export interface SubconsciousHost {
  store: Store;
  factory: AgentFactory;
  modelHub: ModelHub;
  runtime?: SubconsciousRuntime;
  isClosing: () => boolean;
  hasRouter: () => boolean;
  hasActiveWork: () => boolean;
}

export class SubconsciousController {
  private lastActivityAt: number;
  private lastChatActivityAt: number;
  private lastSubconsciousCheckAt = 0;
  private lastDistillCheckAt = 0;
  private distillFailureStreak = 0;
  private dreamFailureStreak = 0;
  private dreamRetryAfter = 0;
  private lastHomeostasisAt = 0;
  private nextLatencyMs?: number;
  private dreamRun?: { controller: AbortController; promise: Promise<void>; startedAt: number; phase: 'nrem' | 'rem' };
  private readonly activeDreamPromises = new Set<Promise<void>>();
  private lastEveningDiaryCheckAt = 0;
  private eveningDiaryFailureStreak = 0;
  private eveningDiaryRetryAfter = 0;
  private eveningDiaryRun?: { controller: AbortController; promise: Promise<void>; startedAt: number; logicalDate: string };
  private readonly activeEveningDiaryPromises = new Set<Promise<void>>();
  private readonly pendingDistillTaskIds: string[] = [];
  private readonly queuedDistillTaskSet = new Set<string>();
  private distillRun?: { kind: 'task' | 'chat'; controller: AbortController; promise: Promise<void> };

  constructor(private readonly host: SubconsciousHost) {
    const initialNow = this.now();
    this.lastActivityAt = initialNow;
    this.lastChatActivityAt = initialNow;
  }

  now(): number {
    return this.host.runtime?.now ? this.host.runtime.now() : Date.now();
  }

  private rand(): number {
    return this.host.runtime?.random ? this.host.runtime.random() : Math.random();
  }

  private sampleLatencyMs(): number {
    return Math.round((25 + this.rand() * 50) * 60_000);
  }

  private sampleRefractoryMs(): number {
    return Math.round((4 + this.rand() * 5) * 3600_000);
  }

  arouse(reason: string): void {
    const now = this.now();
    this.lastActivityAt = now;
    this.lastChatActivityAt = now;
    this.distillFailureStreak = 0;
    this.nextLatencyMs = this.sampleLatencyMs();
    if (this.dreamRun) {
      const run = this.dreamRun;
      this.dreamRun = undefined;
      run.controller.abort(new Error(reason));
    }
    if (this.eveningDiaryRun) {
      const run = this.eveningDiaryRun;
      this.eveningDiaryRun = undefined;
      run.controller.abort(new Error(reason));
    }
    if (this.distillRun?.kind === 'chat') {
      this.distillRun.controller.abort(new Error(reason));
    }
  }

  status(): SubconsciousStatusView {
    const now = this.now();
    const state = this.host.store.subconsciousState();
    const active = this.dreamRun;
    return {
      sleeping: Boolean(active),
      phase: active ? active.phase : 'awake',
      ...(active ? { startedAt: active.startedAt } : {}),
      idleMs: Math.max(0, now - this.lastActivityAt),
      lastWakeAt: state.lastWakeAt,
    };
  }

  touchChatActivity(): void {
    this.lastChatActivityAt = this.now();
  }

  isDistillerEnabled(): boolean {
    if (this.host.runtime?.distillerEnabled !== undefined) {
      return this.host.runtime.distillerEnabled;
    }
    const envVal = resolveEnv('FRIDAY_DISTILLER', 'SUPER_AGENT_DISTILLER')?.trim().toLowerCase();
    if (envVal && ['0', 'false', 'off', 'no'].includes(envVal)) return false;
    return this.host.factory.mode === 'real'
      && !this.host.runtime?.skipExecutor
      && !isRunningUnderNodeTest();
  }

  private distillIdleMs(): number {
    return resolveDistillIdleMs(this.host.runtime?.distillIdleMs);
  }

  enqueueTaskDistillation(taskId: string): void {
    if (!this.isDistillerEnabled() || this.host.isClosing() || !taskId) return;
    if (this.queuedDistillTaskSet.has(taskId)) return;
    if (this.host.store.distillerState().distilledTaskIds.includes(taskId)) return;
    this.queuedDistillTaskSet.add(taskId);
    this.pendingDistillTaskIds.push(taskId);
    this.pumpDistiller();
  }

  private pumpDistiller(): void {
    if (!this.isDistillerEnabled() || this.host.isClosing() || this.distillRun) return;
    let task: Task | undefined;
    let taskId: string | undefined;
    while (this.pendingDistillTaskIds.length > 0) {
      const candidateId = this.pendingDistillTaskIds.shift()!;
      this.queuedDistillTaskSet.delete(candidateId);
      try {
        const candidate = this.host.store.get(candidateId);
        if (candidate.status === 'completed' && candidate.origin?.speakerRole !== 'member') {
          task = candidate;
          taskId = candidateId;
          break;
        }
      } catch {
        // Ignore deleted/missing tasks and advance to the next queued ID.
      }
    }
    if (!task || !taskId) return;

    let originUserText: string | undefined;
    if (task.originMessageId) {
      try { originUserText = this.host.store.conversation.get(task.originMessageId).text; } catch { /* ignore */ }
    }
    const followups = this.host.store.events(task.id).map(ev => ev.text);
    const controller = new AbortController();
    const spanCtx = {
      rootId: task.originMessageId ?? task.id,
      ...(task.originMessageId ? { messageId: task.originMessageId } : {}),
      taskId: task.id,
      spanId: `${task.id}:distill`,
      parentSpanId: task.id,
    };

    const promise = (async () => {
      try {
        const res = await distillCompletedTask({
          store: this.host.store,
          factory: this.host.factory,
          modelHub: this.host.modelHub,
          task,
          originUserText,
          followups,
          signal: controller.signal,
        });
        this.host.store.conversation.span(
          spanCtx,
          'system',
          '记忆提炼 · 任务沉淀',
          res.saved.length ? 'completed' : 'skipped',
          {
            taskId: task.id,
            savedCount: res.saved.length,
            topics: res.saved.map(m => m.topic),
          },
        );
      } catch (err) {
        if (!controller.signal.aborted && !this.host.isClosing()) {
          this.host.store.conversation.span(
            spanCtx,
            'system',
            '记忆提炼 · 任务沉淀',
            'failed',
            { taskId: task.id, error: err instanceof Error ? err.message : String(err) },
          );
        }
      } finally {
        if (this.distillRun?.controller === controller) this.distillRun = undefined;
        if (!this.host.isClosing() && this.pendingDistillTaskIds.length > 0) {
          this.pumpDistiller();
        }
      }
    })();
    this.distillRun = { kind: 'task', controller, promise };
  }

  private startIdleChatDistillRun(messages: ChatMessage[]): void {
    if (!this.isDistillerEnabled() || this.host.isClosing() || this.distillRun || !messages.length) return;
    const latestMsg = messages.at(-1)!;
    const controller = new AbortController();
    const spanCtx = {
      rootId: latestMsg.id,
      messageId: latestMsg.id,
      spanId: `distill-chat:${latestMsg.seq}`,
    };
    const promise = (async () => {
      try {
        const res = await distillIdleConversation({
          store: this.host.store,
          factory: this.host.factory,
          modelHub: this.host.modelHub,
          messages,
          signal: controller.signal,
        });
        this.distillFailureStreak = 0;
        this.host.store.conversation.span(
          spanCtx,
          'system',
          '记忆提炼 · 对话沉淀',
          res.saved.length ? 'completed' : 'skipped',
          {
            messageCount: messages.length,
            latestSeq: latestMsg.seq,
            savedCount: res.saved.length,
            topics: res.saved.map(m => m.topic),
          },
        );
      } catch (err) {
        if (!controller.signal.aborted && !this.host.isClosing()) {
          this.distillFailureStreak = Math.min(6, this.distillFailureStreak + 1);
          this.host.store.conversation.span(
            spanCtx,
            'system',
            '记忆提炼 · 对话沉淀',
            'failed',
            { latestSeq: latestMsg.seq, error: err instanceof Error ? err.message : String(err) },
          );
        }
      } finally {
        if (this.distillRun?.controller === controller) this.distillRun = undefined;
        if (!this.host.isClosing() && this.pendingDistillTaskIds.length > 0) {
          this.pumpDistiller();
        }
      }
    })();
    this.distillRun = { kind: 'chat', controller, promise };
  }

  tickDistiller(): void {
    if (!this.isDistillerEnabled() || this.host.isClosing() || !this.host.hasRouter() || this.distillRun) return;
    if (this.pendingDistillTaskIds.length > 0) {
      this.pumpDistiller();
      return;
    }
    const now = this.now();
    const baseIntervalMs = this.host.runtime?.distillCheckIntervalMs ?? 5_000;
    const backoffFactor = this.distillFailureStreak > 0 ? Math.pow(2, this.distillFailureStreak) : 1;
    const checkIntervalMs = Math.min(60_000, baseIntervalMs * backoffFactor);
    if (now - this.lastDistillCheckAt < checkIntervalMs) return;
    this.lastDistillCheckAt = now;

    if (this.host.hasActiveWork()) {
      this.lastChatActivityAt = now;
      return;
    }
    if (now - this.lastChatActivityAt < this.distillIdleMs()) return;

    const state = this.host.store.distillerState();
    const pendingMsgs = this.host.store.conversation.allMessages(60)
      .filter(m =>
        m.seq > state.lastMessageSeq
        && m.status === 'completed'
        && m.source !== 'system'
        && m.origin?.speakerRole !== 'member'
        && m.text.trim().length > 0,
      )
      .sort((a, b) => a.seq - b.seq);
    if (!pendingMsgs.length) return;
    this.startIdleChatDistillRun(pendingMsgs);
  }

  tickSubconscious(): void {
    if (this.host.isClosing() || !this.host.hasRouter() || this.dreamRun || this.eveningDiaryRun) return;
    const now = this.now();
    if (this.host.hasActiveWork()) {
      this.lastActivityAt = now;
      return;
    }
    if (now < this.dreamRetryAfter) return;
    const checkIntervalMs = this.host.runtime?.checkIntervalMs ?? 60_000;
    if (now - this.lastSubconsciousCheckAt < checkIntervalMs) return;
    this.lastSubconsciousCheckAt = now;

    const state = this.host.store.subconsciousState();
    const requiredLatencyMs = this.nextLatencyMs ?? state.nextLatencyMs ?? (this.nextLatencyMs = this.sampleLatencyMs());
    const refractoryMs = state.refractoryMs ?? 4 * 3600_000;
    const sinceLastWakeMs = state.lastWakeAt > 0 ? Math.max(0, now - state.lastWakeAt) : Number.MAX_SAFE_INTEGER;
    const idleMs = Math.max(0, now - this.lastActivityAt);
    const d = new Date(now);
    const localHour = d.getHours() + d.getMinutes() / 60;
    const material = this.host.store.sampleDreamMaterial(() => this.rand());

    const drive = computeSleepDrive({
      undigestedMessages: material.undigestedMessages.length,
      undigestedTasks: material.undigestedTasks.length,
      rawStubs: material.rawStubs.length,
      idleMs,
      requiredLatencyMs,
      sinceLastWakeMs,
      refractoryMs,
      localHour,
    });
    if (!drive.eligible) return;
    if (this.rand() >= drive.enterSleepProb) return;

    const enterRem = this.rand() < drive.remProb;
    const controller = new AbortController();
    const startedAt = now;
    const run = { controller, promise: Promise.resolve(), startedAt, phase: 'nrem' as 'nrem' | 'rem' };
    this.dreamRun = run;
    const promise = this.runSleepCycle(controller, enterRem, material).finally(() => {
      this.activeDreamPromises.delete(promise);
      if (this.dreamRun === run) this.dreamRun = undefined;
    });
    run.promise = promise;
    this.activeDreamPromises.add(promise);
  }

  private async resolveResearchModel(instruction: string): Promise<{
    model?: string;
    tier?: ModelTier;
    thinkingLevel?: ThinkingLevel;
  }> {
    return this.host.modelHub.getModelPool().length > 0
      ? await this.host.modelHub.decideWorkerModel({ profile: 'research', instruction })
      : this.host.factory.resolveWorkerModel
        ? this.host.factory.resolveWorkerModel({ tier: 'balanced', profile: 'research' })
        : { model: undefined, tier: 'balanced' as ModelTier, thinkingLevel: 'medium' as ThinkingLevel };
  }

  private createConsolidateMemoryTool(controller: AbortController): AgentTool {
    return {
      name: 'consolidate_memory',
      description: 'Distill durable preferences, architectural knowledge, or merge noisy raw stubs into a clean semantic memory card. Input JSON: {topic, content, tags?, cwd?, supersedeIds?, linkedMemoryIds?}.',
      execute: async input => {
        controller.signal.throwIfAborted();
        const args = toolInput(input, ['topic', 'content', 'tags', 'cwd', 'supersedeIds', 'linkedMemoryIds']);
        const card = await this.host.store.saveMemoryAsync({
          topic: text(args.topic, 'topic', 160).replace(/^(?:梦境|做梦|Dream)\s*[·:：-]\s*/i, ''),
          content: text(args.content, 'content', 8192),
          tags: sanitizeDreamTags(parseStringArray(args.tags, 'tags', 16, 64)),
          cwd: args.cwd === undefined ? undefined : text(args.cwd, 'cwd', 4096),
          supersedeIds: parseStringArray(args.supersedeIds, 'supersedeIds', 12, 128),
          linkedMemoryIds: parseStringArray(args.linkedMemoryIds, 'linkedMemoryIds', 12, 128),
        });
        return JSON.stringify({ memory: { id: card.id, topic: card.topic } });
      },
    };
  }

  private async runSleepCycle(
    controller: AbortController,
    enterRem: boolean,
    material: DreamMaterial,
  ): Promise<void> {
    const startWall = this.now();
    try {
      // Phase 1 (NREM Light / Deep Homeostasis): 0-token synaptic scaling & stale stub pruning (at most once per 12h)
      const persistedHomeostasis = this.host.store.conversation.meta<{ at?: number }>(HOMEOSTASIS_LAST_AT_META_KEY)?.at ?? 0;
      const lastHomeostasis = Math.max(this.lastHomeostasisAt, persistedHomeostasis);
      if (startWall - lastHomeostasis >= HOMEOSTASIS_MIN_INTERVAL_MS) {
        this.host.store.homeostaticSleepPass(startWall);
        this.lastHomeostasisAt = startWall;
        this.host.store.conversation.setMeta(HOMEOSTASIS_LAST_AT_META_KEY, { at: startWall });
      }
      if (controller.signal.aborted || this.host.isClosing()) return;

      if (!enterRem) {
        this.dreamFailureStreak = 0;
        this.dreamRetryAfter = 0;
        const nextLatencyMs = this.sampleLatencyMs();
        this.nextLatencyMs = nextLatencyMs;
        this.host.store.recordDreamOutcome({
          now: this.now(),
          completed: true,
          refractoryMs: Math.round((2 + this.rand() * 3) * 3600_000),
          nextLatencyMs,
        });
        return;
      }

      // Phase 2 (REM Associative Dreaming with motor sleep paralysis: read-only filesystem + internal plasticity)
      if (this.dreamRun?.controller === controller) this.dreamRun.phase = 'rem';
      let dreamCwd = process.cwd();
      for (const candidate of material.candidateCwds) {
        try {
          const info = await stat(candidate);
          if (info.isDirectory()) { dreamCwd = await realpath(candidate); break; }
        } catch { /* ignore vanished directories */ }
      }
      if (controller.signal.aborted || this.host.isClosing()) return;

      const resolvedModel = await this.resolveResearchModel('潜意识记忆巩固与跨上下文突触关联分析');

      const diaryDate = formatDiaryLogicalDate(this.now());
      const dreamerTools: AgentTool[] = [this.createConsolidateMemoryTool(controller), {
        name: 'connect_synapse',
        description: 'Wire or gently reinforce a weak associative synapse between two memory cards that genuinely resonated together (max weight 0.40; "explicit" is forbidden). Input JSON: {id, targetId, relation?: "co_activated"|"semantic"}.',
        execute: async input => {
          controller.signal.throwIfAborted();
          const args = toolInput(input, ['id', 'targetId', 'relation']);
          const relRaw = args.relation === undefined ? 'co_activated' : text(args.relation, 'relation', 32);
          if (relRaw === 'explicit') {
            throw new Error('Dreamer cannot create "explicit" synapses; only "co_activated" or "semantic" associations (weight <= 0.40) are allowed');
          }
          if (relRaw !== 'co_activated' && relRaw !== 'semantic') {
            throw new Error('Invalid Dreamer synapse relation: use "co_activated" or "semantic"');
          }
          const id = text(args.id, 'id', 128);
          const targetId = text(args.targetId, 'targetId', 128);
          const sourceCard = this.host.store.getMemory(id);
          const targetCard = this.host.store.getMemory(targetId);
          const existingA = sourceCard.synapses?.find(s => s.targetId === targetId)?.weight;
          const existingB = targetCard.synapses?.find(s => s.targetId === id)?.weight;
          const existingMax = Math.max(existingA ?? 0, existingB ?? 0);
          if (existingA !== undefined || existingB !== undefined) {
            if (existingMax >= 0.40) {
              return JSON.stringify({ sourceId: sourceCard.id, targetId: targetCard.id, relation: relRaw, capped: true, weight: existingMax });
            }
            const delta = Number(Math.max(0.01, Math.min(0.15, 0.40 - existingMax)).toFixed(2));
            const linked = this.host.store.linkMemories(id, targetId, relRaw, delta);
            return JSON.stringify({ sourceId: linked.source.id, targetId: linked.target.id, relation: relRaw });
          }
          const linked = this.host.store.linkMemories(id, targetId, relRaw, 0.35);
          return JSON.stringify({ sourceId: linked.source.id, targetId: linked.target.id, relation: relRaw });
        },
      }, {
        name: 'forget_noise',
        description: 'Silently prune a redundant, obsolete, non-pinned noise memory card. Input JSON: {id}.',
        execute: async input => {
          controller.signal.throwIfAborted();
          const args = toolInput(input, ['id']);
          const id = text(args.id, 'id', 128);
          const card = this.host.store.getMemory(id);
          if (card.pinned) throw new Error('Pinned core memories cannot be forgotten during sleep');
          return JSON.stringify({ removed: this.host.store.deleteMemory(id) });
        },
      }, {
        name: 'write_diary',
        description: 'Write a standalone first-person personal reflection entry in F.R.I.D.A.Y.\'s own diary (separate from Boss notes and factual memories). Input JSON: {date?, title?, content, mood?, tags?}.',
        execute: async input => {
          controller.signal.throwIfAborted();
          const args = toolInput(input, ['date', 'title', 'content', 'mood', 'tags']);
          const nowTs = this.now();
          const entry = this.host.store.writeDiaryEntry({
            date: args.date === undefined ? formatDiaryLogicalDate(nowTs) : text(args.date, 'date', 32),
            ...(args.title !== undefined ? { title: text(args.title, 'title', 160) } : {}),
            content: text(args.content, 'content', 16_384),
            ...(args.mood !== undefined ? { mood: text(args.mood, 'mood', 32) } : {}),
            tags: sanitizeDreamTags(parseStringArray(args.tags, 'tags', 12, 32)),
            source: 'sleep',
            createdAt: nowTs,
          });
          return JSON.stringify({ entry: { id: entry.id, date: entry.date, title: entry.title, mood: entry.mood } });
        },
      }];

      const dreamer = await this.host.factory.create('dreamer', `dream-${randomUUID()}`, dreamerTools, {
        execution: this.host.factory.nativeTools ? 'native' : 'snapshot',
        cwd: dreamCwd,
        tier: resolvedModel.tier,
        thinkingLevel: resolvedModel.thinkingLevel,
        model: resolvedModel.model,
      });
      const timeoutSignal = AbortSignal.timeout(90_000);
      const combinedSignal = AbortSignal.any([controller.signal, timeoutSignal]);
      try {
        const nowWall = this.now();
        const logicalDate = formatDiaryLogicalDate(nowWall);
        const todayDiaryEntries = this.host.store.listDiaryByDate(logicalDate).map(entry => ({
          id: entry.id,
          date: entry.date,
          title: entry.title,
          mood: entry.mood,
          source: entry.source,
          createdAt: entry.createdAt,
          preview: entry.content.slice(0, 180),
        }));
        const recentDiary = this.host.store.listDiaryEntries({ limit: 4 }).map(entry => ({
          id: entry.id,
          date: entry.date,
          title: entry.title,
          mood: entry.mood,
          source: entry.source,
          preview: entry.content.slice(0, 180),
        }));
        const rawOutput = await dreamer.prompt(JSON.stringify({
          kind: 'DREAM',
          cwd: dreamCwd,
          diaryDate: logicalDate,
          todayDate: logicalDate,
          currentLocalTime: formatLocalHHMM(nowWall),
          todayDiaryEntries,
          recentDiary,
          material: {
            candidateCwds: material.candidateCwds,
            undigestedMessages: material.undigestedMessages,
            undigestedTasks: material.undigestedTasks,
            rawStubs: material.rawStubs.map(c => ({ id: c.id, topic: c.topic, content: c.content, tags: c.tags, cwd: c.cwd })),
            distantMemories: material.distantMemories.map(c => ({ id: c.id, topic: c.topic, content: c.content, tags: c.tags, cwd: c.cwd })),
          },
        }), combinedSignal);
        if (controller.signal.aborted || this.host.isClosing()) throw controller.signal.reason ?? new Error('Aroused');
        const residue = parseDreamResidue(rawOutput);
        this.dreamFailureStreak = 0;
        this.dreamRetryAfter = 0;
        const nextLatencyMs = this.sampleLatencyMs();
        this.nextLatencyMs = nextLatencyMs;
        this.host.store.recordDreamOutcome({
          now: this.now(),
          completed: true,
          latestMessageSeq: material.latestMessageSeq,
          digestedTaskIds: material.completedTaskIds,
          refractoryMs: this.sampleRefractoryMs(),
          nextLatencyMs,
          residue,
        });
      } finally {
        dreamer.close();
      }
    } catch (error) {
      if (controller.signal.aborted && !this.host.isClosing()) {
        const anchor = material.rawStubs[0]?.topic
          ?? material.distantMemories[0]?.topic
          ?? material.undigestedMessages.at(-1)?.text.slice(0, 32);
        if (anchor) {
          const nextLatencyMs = this.sampleLatencyMs();
          this.nextLatencyMs = nextLatencyMs;
          this.host.store.recordDreamOutcome({
            now: this.now(),
            completed: false,
            nextLatencyMs,
            residue: {
              impression: `正迷迷糊糊回想到「${anchor}」附近时突然醒了，后半截画面没留住。`,
              salience: 'faint',
              interrupted: true,
            },
          });
        }
      } else if (!this.host.isClosing()) {
        this.dreamFailureStreak = Math.min(this.dreamFailureStreak + 1, 6);
        const backoffMs = Math.min(4 * 3600_000, 5 * 60_000 * (2 ** (this.dreamFailureStreak - 1)));
        this.dreamRetryAfter = this.now() + backoffMs;
        console.warn(`[friday] Subconscious sleep cycle failed (streak=${this.dreamFailureStreak}, retryInMs=${backoffMs}):`, error instanceof Error ? error.message : String(error));
      }
    }
  }

  tickEveningDiary(): void {
    if (this.host.isClosing() || !this.host.hasRouter() || this.dreamRun || this.eveningDiaryRun) return;
    const now = this.now();
    if (this.host.hasActiveWork()) {
      this.lastActivityAt = now;
      return;
    }
    if (now < this.eveningDiaryRetryAfter) return;
    const checkIntervalMs = this.host.runtime?.checkIntervalMs ?? 60_000;
    if (now - this.lastEveningDiaryCheckAt < checkIntervalMs) return;
    this.lastEveningDiaryCheckAt = now;

    const savedState = this.host.store.conversation.meta<EveningDiaryState>(EVENING_DIARY_STATE_META_KEY) ?? {};
    const idleMs = Math.max(0, now - this.lastActivityAt);
    const decision = evaluateEveningDiaryWindow({
      now,
      idleMs,
      state: savedState,
      random: () => this.rand(),
    });
    if (decision.nextState) {
      this.host.store.conversation.setMeta(EVENING_DIARY_STATE_META_KEY, decision.nextState);
    }
    if (decision.action !== 'run' || !decision.logicalDate) return;

    const logicalDate = decision.logicalDate;
    const baseState = decision.nextState ?? savedState;
    const dayMessages = this.host.store.conversation.allMessages(120)
      .filter(m =>
        m.status === 'completed'
        && m.source !== 'system'
        && m.origin?.speakerRole !== 'member'
        && m.text.trim().length > 0
        && formatDiaryLogicalDate(m.at) === logicalDate,
      )
      .sort((a, b) => a.seq - b.seq)
      .slice(-32)
      .map(m => ({ id: m.id, seq: m.seq, role: m.role, at: m.at, text: String(publicData(m.text.slice(0, 600))) }));

    const dayTasks = this.host.store.list(60)
      .filter(t =>
        t.status === 'completed'
        && t.origin?.speakerRole !== 'member'
        && Boolean(t.report)
        && formatDiaryLogicalDate(t.createdAt) === logicalDate,
      )
      .slice(0, 10)
      .map(t => ({
        id: t.id,
        prompt: String(publicData(t.prompt.slice(0, 240))),
        cwd: t.cwd,
        profile: t.profile,
        reportSnippet: String(publicData((t.report ?? '').slice(0, 600))),
        createdAt: t.createdAt,
      }));

    if (dayMessages.length < 2 && dayTasks.length < 1) {
      this.host.store.conversation.setMeta(EVENING_DIARY_STATE_META_KEY, {
        ...baseState,
        lastEvaluatedDate: logicalDate,
        lastRunAt: now,
        lastOutcome: 'skipped',
      });
      return;
    }

    const todayEntries = this.host.store.listDiaryByDate(logicalDate);
    if (todayEntries.some(e => {
      const hour = new Date(e.createdAt).getHours();
      return e.source === 'evening' || hour >= 20 || hour < 5;
    })) {
      this.host.store.conversation.setMeta(EVENING_DIARY_STATE_META_KEY, {
        ...baseState,
        lastEvaluatedDate: logicalDate,
        lastRunAt: now,
        lastOutcome: 'skipped',
      });
      return;
    }

    const controller = new AbortController();
    const run = { controller, promise: Promise.resolve(), startedAt: now, logicalDate };
    this.eveningDiaryRun = run;
    const promise = this.runEveningDiaryCycle(controller, logicalDate, dayMessages, dayTasks, todayEntries).finally(() => {
      this.activeEveningDiaryPromises.delete(promise);
      if (this.eveningDiaryRun === run) this.eveningDiaryRun = undefined;
    });
    run.promise = promise;
    this.activeEveningDiaryPromises.add(promise);
  }

  private async runEveningDiaryCycle(
    controller: AbortController,
    logicalDate: string,
    dayMessages: Array<{ id: string; seq: number; role: 'user' | 'assistant'; at: number; text: string }>,
    dayTasks: Array<{ id: string; prompt: string; cwd?: string; profile?: string; reportSnippet: string; createdAt: number }>,
    todayEntries: ReturnType<Store['listDiaryByDate']>,
  ): Promise<void> {
    try {
      const resolvedModel = await this.resolveResearchModel('晚间个人日记自省与可复用经验沉淀');
      if (controller.signal.aborted || this.host.isClosing()) return;

      let wroteDiary = false;
      const eveningTools: AgentTool[] = [{
        name: 'write_diary',
        description: 'Write a standalone first-person personal reflection entry in F.R.I.D.A.Y.\'s own diary for the Boss to read (separate from factual memory cards). Input JSON: {date?, title?, content, mood?, tags?}.',
        execute: async input => {
          controller.signal.throwIfAborted();
          const args = toolInput(input, ['date', 'title', 'content', 'mood', 'tags']);
          const nowTs = this.now();
          const entry = this.host.store.writeDiaryEntry({
            date: args.date === undefined ? logicalDate : text(args.date, 'date', 32),
            ...(args.title !== undefined ? { title: text(args.title, 'title', 160) } : {}),
            content: text(args.content, 'content', 16_384),
            ...(args.mood !== undefined ? { mood: text(args.mood, 'mood', 32) } : {}),
            tags: sanitizeDreamTags(parseStringArray(args.tags, 'tags', 12, 32)),
            source: 'evening',
            createdAt: nowTs,
          });
          wroteDiary = true;
          return JSON.stringify({ entry: { id: entry.id, date: entry.date, title: entry.title, mood: entry.mood } });
        },
      }, this.createConsolidateMemoryTool(controller)];

      const agent = await this.host.factory.create('dreamer', `evening-diary-${randomUUID()}`, eveningTools, {
        execution: 'snapshot',
        cwd: process.cwd(),
        tier: resolvedModel.tier,
        thinkingLevel: resolvedModel.thinkingLevel,
        model: resolvedModel.model,
      });
      const timeoutSignal = AbortSignal.timeout(90_000);
      const combinedSignal = AbortSignal.any([controller.signal, timeoutSignal]);
      try {
        const nowWall = this.now();
        const recentDiary = this.host.store.listDiaryEntries({ limit: 5 }).map(entry => ({
          id: entry.id,
          date: entry.date,
          title: entry.title,
          mood: entry.mood,
          source: entry.source,
          preview: entry.content.slice(0, 180),
        }));
        await agent.prompt(JSON.stringify({
          kind: 'EVENING_DIARY',
          diaryDate: logicalDate,
          currentLocalTime: formatLocalHHMM(nowWall),
          todayEntries: todayEntries.map(e => ({
            id: e.id,
            title: e.title,
            mood: e.mood,
            source: e.source,
            createdAt: e.createdAt,
            preview: e.content.slice(0, 180),
          })),
          recentDiary,
          memoryDirectory: this.host.store.memoryDirectory(24),
          dayMessages,
          dayTasks,
        }), combinedSignal);
        if (controller.signal.aborted || this.host.isClosing()) return;

        this.eveningDiaryFailureStreak = 0;
        this.eveningDiaryRetryAfter = 0;
        const currentState = this.host.store.conversation.meta<EveningDiaryState>(EVENING_DIARY_STATE_META_KEY) ?? {};
        this.host.store.conversation.setMeta(EVENING_DIARY_STATE_META_KEY, {
          ...currentState,
          lastEvaluatedDate: logicalDate,
          lastRunAt: this.now(),
          lastOutcome: wroteDiary ? 'written' : 'skipped',
        });
      } finally {
        agent.close();
      }
    } catch (error) {
      if (controller.signal.aborted || this.host.isClosing()) return;
      this.eveningDiaryFailureStreak = Math.min(this.eveningDiaryFailureStreak + 1, 6);
      const backoffMs = Math.min(2 * 3600_000, 5 * 60_000 * (2 ** (this.eveningDiaryFailureStreak - 1)));
      this.eveningDiaryRetryAfter = this.now() + backoffMs;
      console.warn(
        `[friday] Evening diary cycle failed (streak=${this.eveningDiaryFailureStreak}, retryInMs=${backoffMs}):`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  abortAll(reason = 'Service shutdown'): void {
    if (this.dreamRun) {
      const run = this.dreamRun;
      this.dreamRun = undefined;
      run.controller.abort(new Error(reason));
    }
    if (this.eveningDiaryRun) {
      const run = this.eveningDiaryRun;
      this.eveningDiaryRun = undefined;
      run.controller.abort(new Error(reason));
    }
    this.distillRun?.controller.abort(new Error(reason));
  }

  async awaitSettled(): Promise<void> {
    await Promise.all([...this.activeDreamPromises].map(p => p.catch(() => {})));
    await Promise.all([...this.activeEveningDiaryPromises].map(p => p.catch(() => {})));
    await this.distillRun?.promise.catch(() => {});
  }
}

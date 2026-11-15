import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { AgentFactory, AgentTool } from '../agent.js';
import { distillCompletedTask, distillIdleConversation, resolveDistillIdleMs } from '../distiller.js';
import type { ModelHub } from '../model-hub.js';
import { resolveEnv } from '../paths.js';
import { text } from '../protocol.js';
import type { SemanticEmbedder } from '../semantic.js';
import type { DreamMaterial, Store, Task } from '../store.js';
import type { ChatMessage, ModelTier, ThinkingLevel } from '../view.js';
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
}

export function isRunningUnderNodeTest(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT)
    || process.execArgv.some(arg => arg === '--test' || arg.startsWith('--test-'));
}

export function parseDreamResidue(raw: string): { impression: string; insight?: string; salience: 'faint' | 'vivid' } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim();
  const candidate = fenced ?? (() => {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    return start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined;
  })();
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const impression = typeof parsed.impression === 'string' ? parsed.impression.trim() : '';
      const insight = typeof parsed.insight === 'string' && parsed.insight.trim() ? parsed.insight.trim() : undefined;
      const salience = parsed.salience === 'vivid' && insight ? 'vivid' : 'faint';
      if (impression) return { impression, ...(insight ? { insight } : {}), salience };
    } catch { /* fallback to plain text impression */ }
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
  private nextLatencyMs?: number;
  private dreamRun?: { controller: AbortController; promise: Promise<void>; startedAt: number };
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
      this.dreamRun.controller.abort(new Error(reason));
    }
    if (this.distillRun?.kind === 'chat') {
      this.distillRun.controller.abort(new Error(reason));
    }
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
        if (candidate.status === 'completed') {
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
      .filter(m => m.seq > state.lastMessageSeq && m.status === 'completed' && m.source !== 'system' && m.text.trim().length > 0)
      .sort((a, b) => a.seq - b.seq);
    if (!pendingMsgs.length) return;
    this.startIdleChatDistillRun(pendingMsgs);
  }

  tickSubconscious(): void {
    if (this.host.isClosing() || !this.host.hasRouter() || this.dreamRun) return;
    const now = this.now();
    if (this.host.hasActiveWork()) {
      this.lastActivityAt = now;
      return;
    }
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
    const promise = this.runSleepCycle(controller, enterRem, material).finally(() => {
      if (this.dreamRun?.controller === controller) this.dreamRun = undefined;
    });
    this.dreamRun = { controller, promise, startedAt };
  }

  private async runSleepCycle(
    controller: AbortController,
    enterRem: boolean,
    material: DreamMaterial,
  ): Promise<void> {
    const startWall = this.now();
    try {
      // Phase 1 (NREM Light / Deep Homeostasis): 0-token synaptic scaling & stale stub pruning
      this.host.store.homeostaticSleepPass(startWall);
      if (controller.signal.aborted || this.host.isClosing()) return;

      if (!enterRem) {
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
      let dreamCwd = process.cwd();
      for (const candidate of material.candidateCwds) {
        try {
          const info = await stat(candidate);
          if (info.isDirectory()) { dreamCwd = await realpath(candidate); break; }
        } catch { /* ignore vanished directories */ }
      }
      if (controller.signal.aborted || this.host.isClosing()) return;

      const resolvedModel: { model?: string; tier?: ModelTier; thinkingLevel?: ThinkingLevel } = this.host.modelHub.getModelPool().length > 0
        ? await this.host.modelHub.decideWorkerModel({ profile: 'research', instruction: '潜意识记忆巩固与跨上下文突触关联分析' })
        : this.host.factory.resolveWorkerModel
          ? this.host.factory.resolveWorkerModel({ tier: 'balanced', profile: 'research' })
          : { model: undefined, tier: 'balanced' as ModelTier, thinkingLevel: 'medium' as ThinkingLevel };

      const sanitizeTags = (tags?: string[]) => (tags ?? [])
        .map(t => t.trim())
        .filter(t => t && !/^(?:auto-consolidated|dream|dreaming|梦境|做梦)$/i.test(t));

      const dreamerTools: AgentTool[] = [{
        name: 'consolidate_memory',
        description: 'Distill durable preferences, architectural knowledge, or merge noisy raw stubs into a clean semantic memory card. Input JSON: {topic, content, tags?, cwd?, supersedeIds?, linkedMemoryIds?}.',
        execute: async input => {
          controller.signal.throwIfAborted();
          const args = toolInput(input, ['topic', 'content', 'tags', 'cwd', 'supersedeIds', 'linkedMemoryIds']);
          const card = await this.host.store.saveMemoryAsync({
            topic: text(args.topic, 'topic', 160).replace(/^(?:梦境|做梦|Dream)\s*[·:：-]\s*/i, ''),
            content: text(args.content, 'content', 8192),
            tags: sanitizeTags(parseStringArray(args.tags, 'tags', 16, 64)),
            cwd: args.cwd === undefined ? undefined : text(args.cwd, 'cwd', 4096),
            supersedeIds: parseStringArray(args.supersedeIds, 'supersedeIds', 12, 128),
            linkedMemoryIds: parseStringArray(args.linkedMemoryIds, 'linkedMemoryIds', 12, 128),
          });
          return JSON.stringify({ memory: { id: card.id, topic: card.topic } });
        },
      }, {
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
        const rawOutput = await dreamer.prompt(JSON.stringify({
          kind: 'DREAM',
          cwd: dreamCwd,
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
    } catch {
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
      }
    }
  }

  abortAll(reason = 'Service shutdown'): void {
    this.dreamRun?.controller.abort(new Error(reason));
    this.distillRun?.controller.abort(new Error(reason));
  }

  async awaitSettled(): Promise<void> {
    await this.dreamRun?.promise.catch(() => {});
    await this.distillRun?.promise.catch(() => {});
  }
}

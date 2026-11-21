import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { rm, stat, realpath } from 'node:fs/promises';
import { isAbsolute, join, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { inferModelTier, isRetryableModelError, type AgentFactory, type AgentPort } from './agent.js';
import { publicData } from './conversation.js';
import { Executor } from './executor.js';
import { readSnapshot, snapshot, type InputFile } from './files.js';
import { classifyBashCommandCs80Scene, notifyCs80Scene, type Cs80SceneId } from './cs80-scene.js';
import { ImGateway } from './im.js';
import { ModelHub, type ModelHubConfigureInput } from './model-hub.js';
import {
  BoundedCounterMap,
  BoundedFingerprintMap,
  accrueChatRun,
  computeCoalesceWindowMs,
  imSessionKey,
  isCaptionlessAttachmentText,
  mergeChatContent,
  resetChatContextClock,
  resolveMaxCoalesceMs,
  resolveRecentSessionImages,
  resolveTextCoalesceMs,
  sameImSession,
  waitForChatCoalesceLoop,
  type ChatRun,
} from './orchestrator/chat-coalescer.js';
import {
  MEMBER_ALLOWED_PLUGINS,
  buildToolRequestId,
  buildVoiceTurnHint,
  compactRouterChatMemoryDirectory,
  compactRouterChatRecentContext,
  compactRouterChatWorks,
  createRouterTools,
  createRouterTurnScope,
  isOriginAccessible,
  resolveReportChainKey,
  type RouterToolsHost,
  type RouterTurnScope,
} from './orchestrator/router-tools.js';
import {
  SubconsciousController,
  computeSleepDrive,
  isRunningUnderNodeTest,
  type SleepDriveEvaluation,
  type SleepDriveInput,
  type SubconsciousRuntime,
} from './orchestrator/subconscious-loop.js';
import { PluginRefreshScheduler } from './orchestrator/plugin-refresh.js';
import {
  TimerScheduler,
  extractGoalMetMarker,
  nextDailyRunAt,
  parseTimerIdFromRequestId,
  resolveStoreChannelOrigin,
  type AddTimerOptions,
} from './orchestrator/timer-scheduler.js';
import {
  SourceChangedError,
  accrueTaskRun,
  dedupeAttachments,
  detectProviderFailureBreaker,
  parseWorkerQuestion,
  resolveExcludedFailures,
  resolveMessageAttachments,
  resolveTaskAttachments,
  taskStatusNeedsNotice,
  unsettled,
  type ChatWork,
  type Run,
} from './orchestrator/worker-runner.js';
import { resolveEnv } from './paths.js';
import { listPluginViews } from './plugin.js';
import { sanitizePublicReply } from './reply-filter.js';
import { createSemanticEngine, type SemanticEmbedder } from './semantic.js';
import {
  assignInitialMessageSessionSync,
  backfillPersistedSessions,
  formatTaskSessionId,
  resolveRuntimeMessageSession,
} from './session.js';
import { Store, type Operation, type Task, type TaskStatus, type Timer, type UsageActor } from './store.js';
import { PromptTrace } from './trace.js';
import type {
  AttachmentView,
  ChatMessage,
  DecisionSource,
  MainView,
  MessageOrigin,
  ModelTier,
  ModelTierConfig,
  RunInitiator,
  ThinkingLevel,
  WorkerProfile,
} from './view.js';

export {
  compactRouterChatWorks,
  compactRouterChatMemoryDirectory,
  compactRouterChatRecentContext,
  nextDailyRunAt,
  computeSleepDrive,
  isCaptionlessAttachmentText,
  mergeChatContent,
  type SleepDriveInput,
  type SleepDriveEvaluation,
  type SubconsciousRuntime,
  type RouterTurnScope,
};

export interface FastpathTurnInput {
  channelId: string;
  senderId: string;
  senderName?: string;
  userText: string;
  replyText: string;
  pluginName: string;
  action: string;
  latencyMs?: number;
  sessionId?: string;
  origin?: MessageOrigin;
  requestId?: string;
  replyId?: string;
}

function isFastpathMessage(msg: ChatMessage): boolean {
  if (msg.requestId?.startsWith('fastpath:')) return true;
  return Boolean(
    msg.routing?.actions.some(
      a => a.kind === 'plugin' && typeof a.summary === 'string' && a.summary.includes('fast path'),
    ),
  );
}

const INBOUND_HOLD_TTL_MS = 25_000;

function resolveMaxConcurrentWorkers(): number {
  const raw = resolveEnv('FRIDAY_MAX_CONCURRENT_WORKERS', 'SUPER_AGENT_MAX_CONCURRENT_WORKERS');
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 64) return parsed;
  }
  return 8;
}

export class Coordinator {
  readonly store: Store;
  readonly semantic: SemanticEmbedder;
  readonly im: ImGateway;
  readonly modelHub: ModelHub;
  private executor?: Executor;
  private readonly runs = new Map<string, Run>();
  private readonly activeWorkerSlots = new Set<string>();
  private readonly queuedWorkers: Array<{ run: Run; isChatWork: boolean; launchWork: () => Promise<void> }> = [];
  private readonly jobs = new Set<Promise<void>>();
  private readonly submissions = new Set<Promise<Task>>();
  private readonly closingAbort = new AbortController();
  private readonly semanticAbort = new AbortController();
  private semanticWarmup?: Promise<void>;
  private router?: AgentPort;
  private activeRouterSpec?: string;
  private routerSwapPromise: Promise<void> = Promise.resolve();
  private readonly interactiveRouterQueue: Array<{ run: () => void; reject: (reason?: unknown) => void }> = [];
  private readonly backgroundRouterQueue: Array<{ run: () => void; reject: (reason?: unknown) => void }> = [];
  private routerActive = false;
  private lastRouterChatSeq = 0;
  private readonly turnStorage = new AsyncLocalStorage<RouterTurnScope>();
  private activeChatContext?: ChatRun;
  private readonly reportAutoDispatches = new BoundedCounterMap(500, 3_600_000);
  private readonly chatRuns = new Map<string, ChatRun>();
  private readonly chatJobs = new Set<Promise<void>>();
  private readonly inboundHolds = new Map<string, number[]>();
  private readonly requestFingerprints = new BoundedFingerprintMap<{ messageId: string; text: string; pathsJson: string }>(2000);
  private readonly outboundListeners = new Set<() => void>();
  private readonly timers: TimerScheduler;
  private readonly subconscious: SubconsciousController;
  private readonly pluginRefresh: PluginRefreshScheduler;
  private timer?: NodeJS.Timeout;
  private closing = false;
  private closingPromise?: Promise<void>;
  private storeClosed = false;

  private get currentTurn(): RouterTurnScope | undefined {
    return this.turnStorage.getStore();
  }

  constructor(
    private readonly home: string,
    private readonly factory: AgentFactory,
    private readonly subconsciousRuntime?: SubconsciousRuntime,
  ) {
    this.store = new Store(home);
    this.store.recover();
    const semanticEnv = resolveEnv('FRIDAY_SEMANTIC_AUTO_DOWNLOAD', 'SUPER_AGENT_SEMANTIC_AUTO_DOWNLOAD');
    const explicitAutoDownload = this.subconsciousRuntime?.semanticAutoDownload
      ?? (semanticEnv === '1' ? true : semanticEnv === '0' ? false : undefined);
    const autoDownload = explicitAutoDownload ?? (
      this.factory.mode === 'real'
      && !this.subconsciousRuntime?.skipExecutor
      && !isRunningUnderNodeTest()
    );
    this.semantic = this.subconsciousRuntime?.semantic ?? createSemanticEngine({
      homeDir: home,
      autoDownload,
    });
    this.store.attachSemanticEngine(this.semantic);

    // Lazy-start Executor in native/real tool mode so no idle child process runs until snapshot execution is needed.
    if (!this.subconsciousRuntime?.skipExecutor && !this.factory.nativeTools) {
      this.executor = new Executor(home, op => this.store.operation(op));
    }

    this.im = new ImGateway(this);
    const defaultTiers: ModelTierConfig = this.factory.modelTiers ?? {
      provider: 'offline',
      router: 'gpt-4.1-mini',
      fast: 'gpt-4.1-mini',
      balanced: 'gpt-4.1',
      strong: 'o4-mini',
      available: [],
    };
    this.modelHub = new ModelHub(
      home,
      this.factory.mode,
      defaultTiers,
      this.factory.routerProvider ?? defaultTiers.provider,
      this.factory.runtime,
      (tiers, routerProvider, routerModel, disabledProviders) => {
        this.factory.updateModelConfig?.(tiers, routerProvider, routerModel, disabledProviders);
      },
    );
    this.factory.onModelUsage = entry => {
      this.recordLiveModelUsage(entry);
    };
    this.modelHub.setUsageListener(entry => {
      this.recordLiveModelUsage(entry);
    });

    this.timers = new TimerScheduler({
      home: this.home,
      store: this.store,
      mode: this.factory.mode,
      closingSignal: this.closingAbort.signal,
      isClosing: () => this.closing,
      jobs: this.jobs,
      submit: (requestId, prompt, paths, limitMs, chatWork) =>
        this.submit(requestId, prompt, paths, limitMs, chatWork),
      notifyOutbound: () => this.notifyOutbound(),
    });

    this.subconscious = new SubconsciousController({
      store: this.store,
      factory: this.factory,
      modelHub: this.modelHub,
      runtime: this.subconsciousRuntime,
      isClosing: () => this.closing,
      hasRouter: () => Boolean(this.router),
      hasActiveWork: () => this.chatRuns.size > 0 || this.runs.size > 0 || this.submissions.size > 0,
    });

    this.pluginRefresh = new PluginRefreshScheduler({
      home: this.home,
      mode: this.factory.mode,
      closingSignal: this.closingAbort.signal,
      isClosing: () => this.closing,
      enabled: this.subconsciousRuntime?.pluginAutoRefresh,
      nowFn: this.subconsciousRuntime?.now,
    });
  }

  get homeDir(): string {
    return this.home;
  }

  subscribeOutbound(listener: () => void): () => void {
    this.outboundListeners.add(listener);
    return () => {
      this.outboundListeners.delete(listener);
    };
  }

  private notifyOutbound(): void {
    if (this.outboundListeners.size === 0) return;
    for (const listener of [...this.outboundListeners]) {
      try {
        listener();
      } catch {
        // Never allow an external observer failure to abort coordinator persistence.
      }
    }
  }

  recordFastpathTurn(input: FastpathTurnInput): { userMessage: ChatMessage; replyMessage: ChatMessage } {
    if (this.closing) throw new Error('Service is shutting down');
    this.subconscious.arouse('Fastpath voice activity');
    const channel = this.store.listImChannels().find(ch => ch.id === input.channelId);
    const inboundOrigin: MessageOrigin = input.origin ?? {
      channel: channel?.platform ?? 'xiaoai',
      channelId: input.channelId,
      ...(channel?.accountId ? { accountId: channel.accountId } : {}),
      conversationId: input.senderId,
      senderId: input.senderId,
      ...(input.senderName ? { speakerId: input.senderId, speakerName: input.senderName } : {}),
    };
    const userId = randomUUID();
    const replyId = input.replyId ?? randomUUID();
    const requestId = input.requestId ?? `fastpath:${input.pluginName}:${input.action}:${Date.now()}:${userId}`;
    const at = Date.now();
    const chat = this.store.conversation;

    const result = this.store.transaction(() => {
      const resolvedSession = input.sessionId
        ? { sessionId: input.sessionId, sessionLink: undefined }
        : assignInitialMessageSessionSync(
            this.store,
            { id: userId, text: input.userText, origin: inboundOrigin, source: 'router', at },
            this.store.list(),
          );
      const userMessage = chat.create({
        id: userId,
        requestId,
        role: 'user',
        origin: inboundOrigin,
        sessionId: resolvedSession.sessionId,
        ...(resolvedSession.sessionLink ? { sessionLink: resolvedSession.sessionLink } : {}),
        text: input.userText,
        status: 'completed',
        paths: [],
        mode: this.factory.mode,
        at,
        routing: {
          at,
          status: 'completed',
          actions: [],
          context: {
            execution: this.factory.nativeTools ? 'native' : 'snapshot',
            cwd: process.cwd(),
            totalWorks: 0,
            truncated: false,
            works: [],
            messages: [],
          },
        },
      });
      const replyMessage = chat.create({
        id: replyId,
        role: 'assistant',
        replyTo: userId,
        text: input.replyText,
        status: 'completed',
        origin: inboundOrigin,
        sessionId: resolvedSession.sessionId,
        paths: [],
        mode: this.factory.mode,
        at: at + 1,
      });
      const latencySuffix = input.latencyMs !== undefined ? ` (${Math.round(input.latencyMs)}ms fast path)` : ' (fast path)';
      chat.routeAction(userId, {
        id: randomUUID(),
        kind: 'plugin',
        status: 'accepted',
        at,
        summary: `${input.pluginName}.${input.action}${latencySuffix}`,
      });
      return { userMessage, replyMessage };
    });

    this.notifyOutbound();
    return result;
  }

  private executorStatus(): { executorPid: number | undefined; executorAvailable: boolean } {
    if (this.executor) {
      return { executorPid: this.executor.pid, executorAvailable: this.executor.available };
    }
    const available = !this.closing && Boolean(this.factory.nativeTools || this.subconsciousRuntime?.skipExecutor);
    return { executorPid: this.subconsciousRuntime?.skipExecutor ? process.pid : undefined, executorAvailable: available };
  }

  private async ensureExecutor(): Promise<Executor> {
    if (this.subconsciousRuntime?.skipExecutor) {
      throw new Error('Executor is disabled in test mode');
    }
    if (!this.executor) {
      this.executor = new Executor(this.home, op => this.store.operation(op));
    }
    await this.executor.ready;
    return this.executor;
  }

  health() {
    return this.executorStatus();
  }

  private recordLiveModelUsage(entry: {
    actor: UsageActor;
    sessionId?: string;
    provider: string;
    model: string;
    status: 'completed' | 'failed' | 'interrupted';
    usage: unknown;
  }): void {
    if (this.storeClosed) return;
    try {
      let taskId: string | undefined;
      let messageId: string | undefined;
      if ((entry.actor === 'worker' || entry.actor === 'compaction') && entry.sessionId && this.runs.has(entry.sessionId)) {
        taskId = entry.sessionId;
        try {
          messageId = this.store.get(taskId).originMessageId;
        } catch {
          // ignore missing task
        }
      } else if (entry.actor === 'router') {
        messageId = this.currentTurn?.chatContext?.message.id
          ?? this.currentTurn?.activeReportTask?.originMessageId
          ?? this.currentTurn?.activeFailureTask?.originMessageId;
        taskId = this.currentTurn?.activeReportTask?.id
          ?? this.currentTurn?.activeFailureTask?.id;
      }
      const catalogRate = this.modelHub.getModelCostRates(entry.provider, entry.model);
      this.store.recordUsage({
        actor: entry.actor,
        provider: entry.provider,
        model: entry.model,
        status: entry.status,
        usage: entry.usage,
        ...(catalogRate ? { catalogRate } : {}),
        ...(taskId ? { taskId } : {}),
        ...(messageId ? { messageId } : {}),
      });
    } catch {
      // Never allow usage ledger recording to interrupt live agent execution.
    }
  }

  async ready() {
    if (this.executor) {
      await this.executor.ready;
    }
    await this.modelHub.init(
      this.factory.initialApiKey && this.factory.modelTiers?.provider
        ? { [this.factory.modelTiers.provider]: this.factory.initialApiKey }
        : undefined,
    );
    this.store.backfillUsage(
      this.factory.routerProvider ?? this.factory.modelTiers?.provider,
      this.factory.modelTiers?.router,
    );
    await this.modelHub.syncDecisionEraStats(this.store.list());
    backfillPersistedSessions(this.store);
    this.store.initDistillerStateIfMissing();
    this.activeRouterSpec = `${this.factory.routerProvider ?? ''}/${this.factory.modelTiers?.router ?? ''}`;
    this.router = await this.createRouter(true);
    this.im.start();
    this.startSemanticWarmup();
    if (!this.closing && !this.timer) {
      this.timer = setInterval(() => this.tick(), 200);
    }
  }

  private startSemanticWarmup() {
    if (this.closing || this.semanticWarmup) return;
    if (this.factory.mode !== 'real' && !this.subconsciousRuntime?.semantic) return;
    const signal = this.semanticAbort.signal;
    this.semanticWarmup = (async () => {
      try {
        const ready = this.semantic.ensureReady
          ? await this.semantic.ensureReady(signal)
          : this.semantic.isReady();
        if (!ready || signal.aborted || this.closing) return;
        await this.store.backfillEmbeddings(32, signal);
      } catch {
        // Semantic engine degrades cleanly to lexical/BM25 retrieval.
      }
    })();
  }

  private createRouterToolHost(): RouterToolsHost {
    return {
      home: this.home,
      store: this.store,
      im: this.im,
      isClosing: () => this.closing,
      getTurn: () => this.currentTurn,
      hasInboundHold: origin => this.hasInboundHold(origin),
      runs: this.runs,
      reportAutoDispatches: this.reportAutoDispatches,
      concurrentTasksInCwd: (cwd, excludeTaskId) => this.concurrentTasksInCwd(cwd, excludeTaskId),
      newChatWork: (context, instruction, paths, callId, source, cwd, extra) =>
        this.newChatWork(context, instruction, paths, callId, source, cwd, extra),
      followup: (id, requestId, text) => this.followup(id, requestId, text),
      stop: id => this.stop(id),
      resume: (id, extendMs) => this.resume(id, extendMs),
      addTimer: (name, instruction, intervalMs, cwd, origin, options) =>
        this.addTimer(name, instruction, intervalMs, cwd, origin, options),
      toggleTimer: (id, enabled) => this.toggleTimer(id, enabled),
      completeTimer: (id, summary) => this.completeTimer(id, summary),
      removeTimer: id => this.removeTimer(id),
      resolveChannelOrigin: (channelSpec, deliverTarget) =>
        resolveStoreChannelOrigin(this.store, channelSpec, deliverTarget),
    };
  }

  private async createRouter(restoreCheckpoint = false): Promise<AgentPort> {
    const tools = createRouterTools(
      this.createRouterToolHost(),
      (messageId, callId, kind) => buildToolRequestId(this.currentTurn, messageId, callId, kind),
    );
    const checkpoint = restoreCheckpoint
      ? this.store.conversation.meta<{ sessionFile: string; leafId: string; lastChatSeq?: number } | null>('router_checkpoint')
      : undefined;
    const validRestore = checkpoint && typeof checkpoint.sessionFile === 'string' && typeof checkpoint.leafId === 'string'
      ? { sessionFile: checkpoint.sessionFile, leafId: checkpoint.leafId }
      : undefined;
    const router = await this.factory.create('router', 'router', tools, {
      restore: validRestore,
      onEvent: event => this.currentTurn?.routerTrace?.observe(event),
    });
    this.lastRouterChatSeq = checkpoint
      ? (typeof checkpoint.lastChatSeq === 'number' ? checkpoint.lastChatSeq : (this.store.conversation.allMessages(1)[0]?.seq ?? 0))
      : (this.store.conversation.allMessages(1)[0]?.seq ?? 0);
    return router;
  }

  private enqueueRouter<T>(priority: 'interactive' | 'background', task: () => Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(new Error('Service is shutting down'));
    }
    return new Promise<T>((resolve, reject) => {
      const entry = {
        reject,
        run: () => {
          Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              this.routerActive = false;
              this.pumpRouterQueue();
            });
        },
      };
      const queue = priority === 'interactive'
        ? this.interactiveRouterQueue
        : this.backgroundRouterQueue;
      queue.push(entry);
      if (!this.routerActive) {
        this.pumpRouterQueue();
      }
    });
  }

  private pumpRouterQueue(): void {
    if (this.routerActive) return;
    if (this.closing) {
      this.drainRouterQueues(new Error('Service is shutting down'));
      return;
    }
    const next = this.interactiveRouterQueue.shift() ?? this.backgroundRouterQueue.shift();
    if (!next) return;
    this.routerActive = true;
    next.run();
  }

  private drainRouterQueues(reason: Error): void {
    while (this.interactiveRouterQueue.length) {
      this.interactiveRouterQueue.shift()!.reject(reason);
    }
    while (this.backgroundRouterQueue.length) {
      this.backgroundRouterQueue.shift()!.reject(reason);
    }
  }

  resolveOriginSpeakerRole(origin?: MessageOrigin): 'owner' | 'member' | undefined {
    if (origin?.speakerRole) return origin.speakerRole;
    if (!origin?.speakerId) return undefined;
    return this.im.getVoiceprintStatus().profiles.find(p => p.id === origin.speakerId)?.role;
  }

  private async syncRouterModelIfNeeded(): Promise<void> {
    if (this.closing || !this.router) return;
    const latestSpec = `${this.factory.routerProvider ?? ''}/${this.factory.modelTiers?.router ?? ''}`;
    if (!latestSpec || latestSpec === '/' || latestSpec === this.activeRouterSpec) return;
    const nextAgent = await this.createRouter(false);
    if (this.closing) {
      nextAgent.close();
      return;
    }
    this.router?.close();
    this.router = nextAgent;
    this.activeRouterSpec = latestSpec;
    this.store.conversation.setMeta('router_checkpoint', null);
    if (nextAgent.checkpoint) this.checkpoint();
  }

  private listEnabledPluginSummaries(allowedPlugins?: ReadonlySet<string>) {
    return listPluginViews(this.home)
      .filter(p => p.enabled !== false && (!allowedPlugins || allowedPlugins.has(p.name)))
      .map(p => ({
        name: p.name,
        actions: p.actions.slice(0, 8),
        ...(p.promptHint ? { hint: p.promptHint.slice(0, 120) } : p.description ? { hint: p.description.slice(0, 120) } : {}),
      }));
  }

  async configureModels(input: ModelHubConfigureInput) {
    const view = await this.modelHub.configure(input);
    const targetSpec = `${view.routerProvider}/${view.routerModel}`;
    const swap = this.enqueueRouter('background', async () => {
      const latestSpec = `${this.factory.routerProvider ?? ''}/${this.factory.modelTiers?.router ?? ''}`;
      if (latestSpec === this.activeRouterSpec && targetSpec === this.activeRouterSpec) return;
      await this.syncRouterModelIfNeeded();
    }).catch(error => {
      if (this.closing) return;
      const detail = error instanceof Error ? error.message : String(error);
      console.error('[friday] Router hot-swap failed after model configuration:', detail);
      this.store.notice('system', 'router_swap_failed', `切换 Router 模型 (${targetSpec}) 失败，已保留原会话模型：${detail}`);
    });
    this.routerSwapPromise = this.routerSwapPromise.then(() => swap, () => swap);
    return view;
  }

  private async newChatWork(
    context: ChatRun,
    instruction: string,
    paths: string[],
    callId?: string,
    source?: Task,
    cwd?: string,
    extra?: {
      contextBrief?: string;
      memoryIds?: string[];
      profile?: WorkerProfile;
      modelTier?: ModelTier;
      workerModel?: string;
      attachments?: AttachmentView[];
    },
  ) {
    const turn = this.currentTurn;
    const originMessageId = (turn?.chatContext || turn?.activeReportTask?.originMessageId) ? context.message.id : undefined;
    const attachments = extra?.attachments ?? resolveMessageAttachments(this.store, context.message);
    const task = await this.submit(
      buildToolRequestId(turn, context.message.id, callId, 'work'),
      instruction,
      paths,
      600_000,
      {
        originMessageId,
        origin: context.deliveryOrigin ?? context.message.origin,
        parentTaskId: source?.id,
        parentSpanId: turn?.routerTrace?.toolSpan(callId),
        source,
        cwd,
        contextBrief: extra?.contextBrief,
        memoryIds: extra?.memoryIds,
        profile: extra?.profile,
        modelTier: extra?.modelTier,
        workerModel: extra?.workerModel,
        attachments: attachments.length ? attachments : undefined,
        signal: context.controller.signal,
      },
    );
    context.revisions.set(task.id, task.revision);
    return task;
  }

  private concurrentTasksInCwd(cwd: string | undefined, excludeTaskId: string): string[] {
    if (!cwd) return [];
    return this.store.list()
      .filter(task => task.id !== excludeTaskId && ['queued', 'running'].includes(task.status) && task.execution === 'native' && task.cwd === cwd)
      .map(task => task.id);
  }

  private activePeersInCwd(cwd: string | undefined, excludeTaskId: string): Array<{ taskId: string; profile?: WorkerProfile; prompt: string }> {
    if (!cwd) return [];
    return this.store.list()
      .filter(task => task.id !== excludeTaskId && ['queued', 'running'].includes(task.status) && task.execution === 'native' && task.cwd === cwd)
      .map(task => ({ taskId: task.id, ...(task.profile ? { profile: task.profile } : {}), prompt: task.prompt.slice(0, 180) }));
  }

  view(): MainView {
    const recent = this.store.list(80);
    const vp = this.im.getVoiceprintStatus();
    const health = this.executorStatus();
    return {
      mode: this.factory.mode,
      health: { status: health.executorAvailable ? 'ready' : 'degraded', executorAvailable: health.executorAvailable },
      messages: this.store.conversation.history(),
      cursor: this.store.conversation.latestSeq(),
      memoryDirectory: this.store.memoryDirectory(24),
      ...(this.factory.modelTiers ? { modelTiers: this.factory.modelTiers } : {}),
      timers: this.store.listTimers(),
      plugins: listPluginViews(this.home),
      imChannels: this.store.listImChannelViews(),
      voiceprint: {
        enabled: vp.enabled,
        threshold: vp.threshold,
        wakePrecheck: vp.wakePrecheck,
        active: vp.active,
        modelReady: vp.modelReady,
        profiles: vp.profiles,
      },
      subconscious: this.subconscious.status(),
      ...(() => {
        const kws = this.im.getXiaoaiKwsStatus();
        if (!kws?.active) return {};
        const activeWorker = kws.workers.find(w => w.capturing || w.transcribing) ?? kws.workers[0];
        const transcribing = kws.workers.some(w => w.transcribing);
        return {
          voiceListening: {
            active: kws.active,
            capturing: kws.capturing,
            transcribing,
            ...(activeWorker?.activeKeyword ? { keyword: activeWorker.activeKeyword } : {}),
            ...(activeWorker?.isFollowUpCapture ? { followUp: true } : {}),
            updatedAt: Date.now(),
          },
        };
      })(),
      works: recent.map(({ id, prompt, status, mode, createdAt, activeMs, limitMs, reason, sessionId, originMessageId, parentTaskId, cwd, execution, profile, workerModel, modelTier, thinkingLevel, decisionSource, skipQualityGate, qualityGate, pendingQuestion, initiator, timerId }) => {
        const concurrentTaskIds = execution === 'native' && ['queued', 'running'].includes(status) ? this.concurrentTasksInCwd(cwd, id) : undefined;
        return {
          id,
          prompt: prompt.slice(0, 240),
          status,
          mode,
          createdAt,
          activeMs,
          limitMs,
          reason,
          ...(sessionId ? { sessionId } : {}),
          originMessageId,
          parentTaskId,
          cwd,
          ...(profile ? { profile } : {}),
          ...(modelTier ? { modelTier } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
          ...(decisionSource ? { decisionSource } : {}),
          ...(skipQualityGate ? { skipQualityGate: true } : {}),
          ...(qualityGate ? { qualityGate } : {}),
          ...(workerModel ? { workerModel } : {}),
          ...(pendingQuestion ? { pendingQuestion } : {}),
          ...(concurrentTaskIds?.length ? { concurrentTaskIds } : {}),
          ...(initiator ? { initiator } : {}),
          ...(timerId ? { timerId } : {}),
        };
      }),
    };
  }

  private findMergeableChatRun(origin?: MessageOrigin): ChatRun | undefined {
    if (!origin?.channel || origin.channel === 'local' || origin.channel === 'xiaoai') return undefined;
    for (const run of this.chatRuns.values()) {
      // Keep flat replies separate from quoted replies and from flat replies in other topics.
      const prior = run.message.origin;
      if (origin.channel === 'telegram' && (origin.telegramFlatSourceId !== undefined || prior?.telegramFlatSourceId !== undefined)
        && (origin.telegramFlatSourceId === undefined || prior?.telegramFlatSourceId === undefined
          || origin.messageThreadId !== prior.messageThreadId)) continue;
      if (sameImSession(prior, origin) && !run.controller.signal.aborted && !run.settled && !run.hasSideEffectTool) {
        return run;
      }
    }
    return undefined;
  }

  private pruneInboundHolds(key: string, now = Date.now()): number[] {
    const holds = this.inboundHolds.get(key);
    if (!holds?.length) return [];
    const active = holds.filter(expiresAt => expiresAt > now);
    if (!active.length) {
      this.inboundHolds.delete(key);
      return [];
    }
    if (active.length !== holds.length) this.inboundHolds.set(key, active);
    return active;
  }

  hasInboundHold(origin?: MessageOrigin): boolean {
    const key = imSessionKey(origin);
    return Boolean(key && this.pruneInboundHolds(key).length > 0);
  }

  beginInboundHold(origin?: MessageOrigin) {
    const key = imSessionKey(origin);
    if (!key) return;
    const now = Date.now();
    const active = this.pruneInboundHolds(key, now);
    active.push(now + INBOUND_HOLD_TTL_MS);
    this.inboundHolds.set(key, active);
    const activeRun = this.findMergeableChatRun(origin);
    if (activeRun) {
      activeRun.mergeVersion++;
      const coalesceCfg = { mode: this.factory.mode, env: process.env };
      activeRun.coalesceUntil = Math.min(activeRun.firstAt + resolveMaxCoalesceMs(this.factory.mode), now + resolveTextCoalesceMs(coalesceCfg));
      activeRun.wakeCoalesce?.();
      activeRun.attemptController?.abort(new Error('Superseded by incoming media in same IM session'));
    }
  }

  endInboundHold(origin?: MessageOrigin) {
    const key = imSessionKey(origin);
    if (!key) return;
    const active = this.pruneInboundHolds(key);
    active.shift();
    if (!active.length) this.inboundHolds.delete(key);
    else this.inboundHolds.set(key, active);
    const activeRun = this.findMergeableChatRun(origin);
    if (activeRun) activeRun.wakeCoalesce?.();
  }

  chat(requestId: string, content: string, paths: string[] = [], origin: MessageOrigin = { channel: 'local' }, attachments?: AttachmentView[]): ChatMessage {
    if (this.closing) throw new Error('Service is shutting down');
    if (paths.length > 32 || paths.some(path => !isAbsolute(path))) {
      throw new Error('Provide at most 32 explicit absolute paths (files or directories); do not use ~ or environment variables');
    }
    this.subconscious.arouse('User chat activity');
    const chat = this.store.conversation;
    const pathsJson = JSON.stringify(paths);
    const recorded = this.requestFingerprints.get(requestId);
    if (recorded) {
      if (recorded.text !== content || recorded.pathsJson !== pathsJson) throw new Error('Request ID already used for a different message');
      return chat.get(recorded.messageId);
    }
    const previous = chat.byRequest(requestId);
    if (previous) {
      if (previous.text !== content || JSON.stringify(previous.paths) !== pathsJson) throw new Error('Request ID already used for a different message');
      this.requestFingerprints.set(requestId, { messageId: previous.id, text: content, pathsJson });
      return previous;
    }
    const coalesceCfg = { mode: this.factory.mode, env: process.env };
    const mergeTarget = this.findMergeableChatRun(origin);
    if (mergeTarget) {
      const mergedText = mergeChatContent(mergeTarget.message.text, content);
      const mergedPaths = [...new Set([...mergeTarget.message.paths, ...paths])].slice(0, 32);
      const mergedAttachments = dedupeAttachments([...(mergeTarget.message.attachments ?? []), ...(attachments ?? [])]);
      const mergedOrigin: MessageOrigin = {
        ...mergeTarget.message.origin,
        ...origin,
        contextToken: origin.contextToken ?? mergeTarget.message.origin?.contextToken,
        replyToMessageId: origin.replyToMessageId ?? mergeTarget.message.origin?.replyToMessageId,
      };
      mergeTarget.message = chat.update(mergeTarget.message.id, {
        text: mergedText,
        paths: mergedPaths,
        ...(mergedAttachments.length ? { attachments: mergedAttachments } : {}),
        origin: mergedOrigin,
      });
      if (mergeTarget.replyId) {
        chat.update(mergeTarget.replyId, { origin: mergedOrigin });
      }
      this.requestFingerprints.set(requestId, { messageId: mergeTarget.message.id, text: content, pathsJson });
      mergeTarget.mergeVersion++;
      const windowMs = computeCoalesceWindowMs(mergeTarget.message, coalesceCfg);
      mergeTarget.coalesceUntil = Math.min(mergeTarget.firstAt + resolveMaxCoalesceMs(this.factory.mode), Date.now() + windowMs);
      mergeTarget.wakeCoalesce?.();
      mergeTarget.attemptController?.abort(new Error('Superseded by incoming message in same IM session'));
      return mergeTarget.message;
    }

    const msgId = randomUUID();
    const initialAt = Date.now();
    const initialSession = assignInitialMessageSessionSync(
      this.store,
      { id: msgId, text: content, origin, source: 'router', at: initialAt },
      this.store.list(),
    );
    const message = chat.create({
      id: msgId,
      requestId,
      role: 'user',
      origin,
      attachments,
      sessionId: initialSession.sessionId,
      ...(initialSession.sessionLink ? { sessionLink: initialSession.sessionLink } : {}),
      text: content,
      status: 'queued',
      paths,
      mode: this.factory.mode,
      at: initialAt,
    });
    this.requestFingerprints.set(requestId, { messageId: message.id, text: content, pathsJson });
    this.notifyOutbound();

    const now = Date.now();
    const initialWindowMs = computeCoalesceWindowMs(message, coalesceCfg);
    const context: ChatRun = {
      message,
      controller: new AbortController(),
      revisions: new Map(),
      firstAt: now,
      coalesceUntil: now + initialWindowMs,
      mergeVersion: 0,
    };
    this.chatRuns.set(message.id, context);

    const pending = (async () => {
      for (;;) {
        await waitForChatCoalesceLoop(context, o => this.hasInboundHold(o), () => this.closing);
        if (context.controller.signal.aborted || this.closing) {
          context.settled = true;
          chat.update(message.id, { status: 'interrupted', reason: 'F.R.I.D.A.Y. 处理前已停止；不会自动重发。' });
          if (context.replyId) {
            chat.update(context.replyId, { status: 'interrupted', reason: 'F.R.I.D.A.Y. 回复未完成；已保留公开输出和真实错误轨迹，不自动重放。' });
          }
          this.notifyOutbound();
          return;
        }
        let retryCoalesce = false;
        await this.enqueueRouter('interactive', async () => {
          for (;;) {
            if (context.controller.signal.aborted || this.closing) {
              context.settled = true;
              chat.update(message.id, { status: 'interrupted', reason: 'F.R.I.D.A.Y. 处理前已停止；不会自动重发。' });
              if (context.replyId) {
                chat.update(context.replyId, { status: 'interrupted', reason: 'F.R.I.D.A.Y. 回复未完成；已保留公开输出和真实错误轨迹，不自动重放。' });
              }
              this.notifyOutbound();
              return;
            }
            if (!context.hasSideEffectTool && (Date.now() < context.coalesceUntil || this.hasInboundHold(context.message.origin))) {
              retryCoalesce = true;
              return;
            }
            const attemptVersion = context.mergeVersion;
            context.activeAttemptVersion = attemptVersion;
            let currentMessage = chat.get(message.id);
            const callerOrigin = currentMessage.origin;
            const isNonLocalCaller = Boolean(callerOrigin?.channel && callerOrigin.channel !== 'local');
            const isMemberSpeaker = this.resolveOriginSpeakerRole(callerOrigin) === 'member';
            const knownWorks = isMemberSpeaker
              ? []
              : this.store.list().filter(task => isOriginAccessible(callerOrigin, task.origin));
            const skipAiContinuity = isMemberSpeaker || callerOrigin?.channel === 'xiaoai';
            const resolvedSession = await resolveRuntimeMessageSession(
              this.store,
              this.modelHub,
              currentMessage,
              knownWorks,
              this.semantic,
              { skipAiContinuity },
            );
            if (attemptVersion === 0
              || currentMessage.sessionId !== resolvedSession.sessionId
              || JSON.stringify(currentMessage.sessionLink ?? null) !== JSON.stringify(resolvedSession.sessionLink ?? null)) {
              currentMessage = chat.assignSession(message.id, resolvedSession.sessionId, resolvedSession.sessionLink, attemptVersion === 0);
            }
            context.message = currentMessage;
            const memoryDirectory = isMemberSpeaker
              ? { totalActive: 0, truncated: false, items: [] }
              : this.store.memoryDirectory(24);
            const bareQuery = currentMessage.text.replace(/[。，,！!？?、；;：\s]+/g, '');
            const skipTrivialRecall = bareQuery.length === 0
              || /^(?:好|好的|好嘞|行|可以|不用了?|不需要|不要了?|算了|对|对啊|是的|没错|嗯|发吧|再来一次|再试一次|试一次吧|继续|开始吧)$/.test(bareQuery)
              || (callerOrigin?.channel === 'xiaoai' && bareQuery.length <= 4);
            const autoRecalled = !isMemberSpeaker && !skipTrivialRecall
              ? (await this.store.searchContextAsync({ query: currentMessage.text, limit: 3, touch: false }))
                  .hits
                  .filter(hit => hit.score >= 46 && !(hit.kind === 'message' && hit.messageId === message.id))
              : [];
            const subconscious = isMemberSpeaker ? undefined : this.store.peekSubconsciousForChat(this.subconscious.now());
            context.revisions = new Map(knownWorks.map(task => [task.id, task.revision]));

            // Always reset heartbeat clock right before attaching active turn state after async coalesce/lookup work.
            resetChatContextClock(context);
            const accessibleHistory = isMemberSpeaker
              ? []
              : isNonLocalCaller
                ? chat.history(undefined, 24).items.filter(item => isOriginAccessible(callerOrigin, item.origin)).slice(-12)
                : chat.history(undefined, 12).items;
            const recentContext = isMemberSpeaker
              ? undefined
              : isNonLocalCaller
                ? accessibleHistory.map(({ id, role, text, mode, status, taskIds, paths: itemPaths }) => ({
                    id,
                    role,
                    mode,
                    text: text.slice(-4096),
                    truncated: text.length > 4096,
                    status,
                    taskIds,
                    fileCount: itemPaths.length,
                  }))
                : chat.recentContext();
            const replyOrigin = context.deliveryOrigin ?? currentMessage.origin;
            chat.update(message.id, {
              status: 'processing',
              routing: {
                at: Date.now(),
                status: 'processing',
                actions: [],
                context: {
                  execution: this.factory.nativeTools ? 'native' : 'snapshot',
                  cwd: process.cwd(),
                  totalWorks: knownWorks.length,
                  truncated: knownWorks.length > 40,
                  works: knownWorks.slice(-40).map(({ id, prompt, status, revision }) => ({
                    id,
                    prompt: String(publicData(prompt.slice(0, 240))),
                    status,
                    revision,
                  })),
                  messages: accessibleHistory.map(item => ({
                    id: item.id,
                    role: item.role,
                    preview: String(publicData(item.text.slice(-160))),
                  })),
                  memoryDirectory,
                  ...(autoRecalled.length ? { autoRecalled } : {}),
                },
              },
            });
            const reply = context.replyId
              ? chat.update(context.replyId, { text: '', status: 'streaming', reason: undefined, origin: replyOrigin, sessionId: currentMessage.sessionId })
              : chat.create({
                  id: randomUUID(),
                  replyTo: message.id,
                  role: 'assistant',
                  origin: replyOrigin,
                  text: '',
                  status: 'streaming',
                  mode: this.factory.mode,
                  paths: [],
                  sessionId: currentMessage.sessionId,
                });
            context.replyId = reply.id;
            this.notifyOutbound();

            const trace = new PromptTrace(chat, { rootId: message.id, messageId: message.id, parentSpanId: message.id }, 'router', this.factory.mode, reply.id);
            const turn = createRouterTurnScope({ chatContext: context, routerTrace: trace });
            const attemptController = new AbortController();
            context.attemptController = attemptController;
            const onUserAbort = () => attemptController.abort(context.controller.signal.reason);
            context.controller.signal.addEventListener('abort', onUserAbort, { once: true });
            const preTurnLeafId = isMemberSpeaker ? undefined : this.router?.leafId;
            let memberRouter: AgentPort | undefined;

            try {
              const deliveryChannel = (context.deliveryOrigin ?? currentMessage.origin)?.channel ?? 'local';
              const carriedImages = resolveRecentSessionImages(this.store, currentMessage);
              const { routing: _omittedRouting, ...cleanCurrentMessage } = currentMessage;
              const promptMessage = carriedImages.length
                ? { ...cleanCurrentMessage, attachments: [...(cleanCurrentMessage.attachments ?? []), ...carriedImages] }
                : cleanCurrentMessage;

              let activeRouter: AgentPort;
              let payload: string;
              if (isMemberSpeaker) {
                const memberTools = createRouterTools(
                  this.createRouterToolHost(),
                  (messageId, callId, kind) => buildToolRequestId(this.currentTurn, messageId, callId, kind),
                  { allowedPlugins: MEMBER_ALLOWED_PLUGINS, toolNames: new Set(['run_plugin']) },
                );
                memberRouter = await this.factory.create('router', `member-${message.id}`, memberTools, {
                  onEvent: event => this.currentTurn?.routerTrace?.observe(event),
                });
                activeRouter = memberRouter;
                payload = JSON.stringify({
                  kind: 'CHAT',
                  message: promptMessage,
                  deliveryChannel,
                  ...buildVoiceTurnHint(this.home, deliveryChannel, MEMBER_ALLOWED_PLUGINS),
                  availablePlugins: this.listEnabledPluginSummaries(MEMBER_ALLOWED_PLUGINS),
                  execution: this.factory.nativeTools ? 'native' : 'snapshot',
                  cwd: process.cwd(),
                  memoryDirectory: { total: 0, pinnedCount: 0, items: [] },
                  memberPrivacyNotice: '当前为家庭成员语音对话：仅可操作客厅/全屋公开智能家居，严禁透露或查询机主私人记忆、持仓与后台工作。',
                });
              } else {
                await this.syncRouterModelIfNeeded();
                activeRouter = this.router!;
                const imChannels = this.store.listImChannelViews()
                  .filter(c => c.enabled)
                  .map(({ id, platform, name, loginStatus, defaultTarget }) => ({ id, platform, name, loginStatus, defaultTarget }));
                const promptMemoryDirectory = compactRouterChatMemoryDirectory(
                  this.store.memoryDirectory(deliveryChannel === 'xiaoai' ? 10 : 12),
                );
                const promptAutoRecalled = autoRecalled.map(({ synapses: _synapses, neighbors, ...hit }) => ({
                  ...hit,
                  snippet: hit.snippet.length > 200 ? `${hit.snippet.slice(0, 200)}…` : hit.snippet,
                  ...(neighbors?.length
                    ? {
                        neighbors: neighbors.slice(0, 2).map(n => ({
                          ...n,
                          preview: n.preview.length > 100 ? `${n.preview.slice(0, 100)}…` : n.preview,
                        })),
                      }
                    : {}),
                }));
                const includeRecentContext = !this.router?.leafId;
                let promptContext = includeRecentContext
                  ? (this.factory.mode === 'real' ? compactRouterChatRecentContext(recentContext) : recentContext)
                  : undefined;
                if (!includeRecentContext) {
                  // Fastpath turns (e.g. MiOT/TV-IR) are recorded in SQLite without entering Router's SDK session;
                  // bridge only unseen turns after lastRouterChatSeq whenever an unseen fastpath turn exists.
                  const unseenItems = chat.history(currentMessage.seq, 8).items
                    .filter(m => m.seq > this.lastRouterChatSeq && (!isNonLocalCaller || isOriginAccessible(callerOrigin, m.origin)));
                  if (unseenItems.some(isFastpathMessage)) {
                    const formattedPrior = unseenItems.map(({ id, role, text, mode, status, taskIds, paths: itemPaths }) => ({
                      id,
                      role,
                      mode,
                      text: text.slice(-4096),
                      truncated: text.length > 4096,
                      status,
                      taskIds,
                      fileCount: itemPaths.length,
                    }));
                    promptContext = compactRouterChatRecentContext(formattedPrior, 6);
                  }
                }
                const promptWorks = compactRouterChatWorks(knownWorks, deliveryChannel === 'xiaoai' ? 2 : 3);
                payload = JSON.stringify({
                  kind: 'CHAT',
                  message: promptMessage,
                  deliveryChannel,
                  ...buildVoiceTurnHint(this.home, deliveryChannel),
                  availablePlugins: this.listEnabledPluginSummaries(),
                  ...(promptContext !== undefined ? { context: promptContext } : {}),
                  execution: this.factory.nativeTools ? 'native' : 'snapshot',
                  cwd: process.cwd(),
                  memoryDirectory: promptMemoryDirectory,
                  ...(imChannels.length ? { imChannels } : {}),
                  ...(promptAutoRecalled.length ? { autoRecalled: promptAutoRecalled } : {}),
                  ...(subconscious ? { subconscious } : {}),
                  works: promptWorks,
                });
              }

              resetChatContextClock(context);
              this.activeChatContext = context;
              const result = await this.turnStorage.run(turn, () => trace.run(activeRouter, payload, attemptController.signal));
              accrueChatRun(context);
              if (context.controller.signal.aborted) throw context.controller.signal.reason;
              if ((context.mergeVersion !== attemptVersion || this.hasInboundHold(currentMessage.origin)) && !context.hasSideEffectTool && !this.closing) {
                if (!isMemberSpeaker && preTurnLeafId !== undefined) this.router?.rewind?.(preTurnLeafId);
                retryCoalesce = true;
                return;
              }
              context.settled = true;
              this.store.transaction(() => {
                chat.update(reply.id, {
                  text: this.publicText(result),
                  status: 'completed',
                  ...(context.deliveryOrigin ? { origin: context.deliveryOrigin } : {}),
                });
                if (!chat.get(message.id).routing?.actions.length) {
                  chat.routeAction(message.id, { id: randomUUID(), kind: 'reply', status: 'accepted', at: Date.now() });
                }
                chat.routeState(message.id, 'completed');
                chat.update(message.id, { status: 'completed' });
                for (const id of chat.get(message.id).taskIds) chat.link(reply.id, id);
                if (!isMemberSpeaker) {
                  if (subconscious) this.store.advanceSubconsciousTurn(subconscious.pendingInsight?.id, this.subconscious.now());
                  this.lastRouterChatSeq = Math.max(this.lastRouterChatSeq, currentMessage.seq, reply.seq);
                  this.checkpoint();
                }
              });
              this.notifyOutbound();
              return;
            } catch (error) {
              if ((context.mergeVersion !== attemptVersion || this.hasInboundHold(currentMessage.origin)) && !context.hasSideEffectTool && !context.controller.signal.aborted && !this.closing) {
                if (!isMemberSpeaker && preTurnLeafId !== undefined) this.router?.rewind?.(preTurnLeafId);
                retryCoalesce = true;
                return;
              }
              if (!isMemberSpeaker && preTurnLeafId !== undefined && !context.hasSideEffectTool) {
                this.router?.rewind?.(preTurnLeafId);
              }
              context.settled = true;
              const status = context.controller.signal.aborted ? 'interrupted' : 'failed';
              const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
              const failReason = status === 'interrupted'
                ? 'F.R.I.D.A.Y. 回复未完成；已保留公开输出和真实错误轨迹，不自动重放。'
                : isRetryableModelError(error)
                  ? `这条我没答上：模型那边暂时过载或限流（${detail.slice(0, 120)}），备用模型也没接住。过一会儿再发我一次。`
                  : `这条我没答上：${detail.slice(0, 200) || '未知错误'}`;
              chat.update(reply.id, { status, reason: failReason });
              chat.routeState(message.id, status);
              chat.update(message.id, { status, reason: error instanceof Error ? '处理未完成，可查看执行轨迹。' : '处理失败。' });
              this.notifyOutbound();
              return;
            } finally {
              this.activeChatContext = undefined;
              try {
                memberRouter?.close();
                memberRouter = undefined;
                if (isMemberSpeaker) {
                  await rm(join(this.home, 'sdk', `member-${message.id}`), { recursive: true, force: true }).catch(() => {});
                }
              } finally {
                context.controller.signal.removeEventListener('abort', onUserAbort);
                context.attemptController = undefined;
              }
            }
          }
        });
        if (!retryCoalesce || context.settled) break;
      }
    })().catch((error: unknown) => {
      if (!context.settled) {
        context.settled = true;
        try {
          const isAbortOrShutdown = this.closing || context.controller.signal.aborted;
          const status = isAbortOrShutdown ? 'interrupted' : 'failed';
          const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
          const msgRecord = chat.get(message.id);
          if (msgRecord.status === 'queued' || msgRecord.status === 'processing') {
            chat.update(message.id, {
              status,
              reason: isAbortOrShutdown
                ? 'F.R.I.D.A.Y. 处理前已停止；不会自动重发。'
                : `处理失败：${detail.slice(0, 200) || '未知错误'}`,
            });
          }
          if (context.replyId) {
            const replyRecord = chat.get(context.replyId);
            if (replyRecord.status === 'streaming') {
              chat.update(context.replyId, {
                status,
                reason: isAbortOrShutdown
                  ? 'F.R.I.D.A.Y. 回复未完成；已保留公开输出和真实错误轨迹，不自动重放。'
                  : `这条我没答上：${detail.slice(0, 200) || '未知错误'}`,
              });
            }
          }
          this.notifyOutbound();
        } catch {
          // Ignore store errors if shutdown already closed the DB.
        }
      }
    }).finally(() => {
      this.subconscious.touchChatActivity();
      this.chatRuns.delete(message.id);
      this.chatJobs.delete(pending);
    });

    this.chatJobs.add(pending);
    return message;
  }

  stopReply(id: string) {
    const message = this.store.conversation.get(id);
    const run = this.chatRuns.get(message.role === 'assistant' ? message.replyTo ?? id : id);
    if (run) {
      run.controller.abort(new Error('User stopped the Router reply; independent background works are unchanged'));
      run.wakeCoalesce?.();
      if (!run.replyId) {
        this.store.conversation.update(run.message.id, { status: 'interrupted', reason: '已停止排队中的回复；后台工作不受影响。' });
        this.notifyOutbound();
      }
      return { messageId: id, state: 'stop_requested' };
    }
    let stoppedBackgroundReply = false;
    for (const workerRun of this.runs.values()) {
      if (workerRun.replyId === id || message.taskIds.includes(workerRun.id)) {
        if (workerRun.replyController && !workerRun.replyController.signal.aborted) {
          workerRun.replyController.abort(new Error('User stopped background Router delivery'));
          stoppedBackgroundReply = true;
        }
      }
    }
    return { messageId: id, state: stoppedBackgroundReply ? 'stop_requested' : message.status };
  }

  stopImSessionReplies(origin?: MessageOrigin): number {
    if (!origin?.channel || origin.channel === 'local') return 0;
    let count = 0;
    for (const run of this.chatRuns.values()) {
      if (sameImSession(run.message.origin, origin) && !run.controller.signal.aborted && !run.settled && !run.hasSideEffectTool) {
        run.controller.abort(new Error('Superseded by newer voice utterance on same speaker'));
        run.wakeCoalesce?.();
        if (!run.replyId) {
          this.store.conversation.update(run.message.id, { status: 'interrupted', reason: '已被新的语音指令打断；后台工作不受影响。' });
        }
        count++;
      }
    }
    if (count > 0) this.notifyOutbound();
    return count;
  }

  private checkpoint() {
    if (this.router?.checkpoint) {
      this.store.conversation.setMeta('router_checkpoint', {
        ...this.router.checkpoint,
        lastChatSeq: this.lastRouterChatSeq,
      });
    }
  }

  private pumpWorkerQueue(): void {
    const limit = resolveMaxConcurrentWorkers();
    while (this.activeWorkerSlots.size < limit && this.queuedWorkers.length > 0 && !this.closing) {
      const next = this.queuedWorkers.shift()!;
      if (!this.runs.has(next.run.id) || next.run.stopping || next.run.controller.signal.aborted) continue;
      const current = this.store.get(next.run.id);
      if (current.status !== 'queued' || current.revision !== next.run.revision) continue;
      this.activeWorkerSlots.add(next.run.id);
      if (next.isChatWork) {
        this.store.transition(next.run.id, 'running');
      }
      next.run.lastTick = performance.now();
      next.run.lastWall = Date.now();
      this.launch(next.run, next.launchWork);
    }
  }

  private launch(run: Run, work: () => Promise<void>) {
    run.jobs++;
    const job = work().catch(async (error: unknown) => {
      if (run.controller.signal.aborted) return;
      const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 600) || '未知错误';
      for (const op of this.store.operations(run.id)) {
        if (['requested', 'started'].includes(op.status)) {
          op.status = 'cancel_requested';
          this.store.operation(op);
          if (!op.fileId.startsWith('native:')) this.executor?.stop(op.id);
        }
      }
      if (run.reads.size > 0 || this.store.operations(run.id).some(unsettled)) {
        this.stop(run.id, `模型或执行器请求失败：${detail}`, 'failed');
        return;
      }
      if (await this.routeWorkerFailure(run, detail)) return;
      if (!run.controller.signal.aborted) this.stop(run.id, `模型或执行器请求失败：${detail}`, 'failed');
    }).finally(async () => {
      if (run.stopping && run.reads.size) await Promise.all([...run.reads.values()]);
      run.jobs--;
      this.jobs.delete(job);
      if (run.stopping && run.jobs === 0) {
        const uncertain = this.store.operations(run.id).some(unsettled);
        if (run.stopping !== 'paused' && uncertain) {
          this.finish(run, 'paused', '取消或失败后无法确认操作结算；工作保持暂停，不会自动重放');
        } else {
          this.finish(
            run,
            run.stopping,
            run.stopping === 'cancelled'
              ? '取消已确认：所有在途操作均已结算'
              : this.store.get(run.id).reason,
          );
        }
      }
    });
    this.jobs.add(job);
  }

  private publicText(text: string): string {
    return sanitizePublicReply(text, this.store.list().map(task => task.id), this.home);
  }

  private valid(run: Run): boolean {
    const task = this.store.get(run.id);
    return !run.controller.signal.aborted && task.revision === run.revision && ['queued', 'running'].includes(task.status);
  }

  private async routeWorkerFailure(run: Run, detail: string): Promise<boolean> {
    if (run.reads.size > 0 || this.store.operations(run.id).some(unsettled)) return false;
    const task = this.store.get(run.id);
    if (this.timers.willNextFailureBeSilent(task)) return false;
    if (!this.router || !task.originMessageId || !this.valid(run)) return false;
    const deliveryOrigin = run.deliveryOrigin ?? task.origin;
    try {
      const handled = await this.serialRouter(run, async () => {
        if (run.reads.size > 0 || this.store.operations(run.id).some(unsettled)) return false;
        const chainKey = resolveReportChainKey(this.store, task);
        const turnInit: Partial<RouterTurnScope> = {
          activeFailureTask: {
            id: task.id,
            reason: `模型或执行器请求失败：${detail}`,
            workerModel: task.workerModel,
            originMessageId: task.originMessageId,
          },
        };
        let turnDispatched = false;
        let turnSentFile = false;
        const text = await this.prompt(run, this.router!, JSON.stringify({
          kind: 'WORKER_FAILED',
          taskId: task.id,
          prompt: task.prompt,
          cwd: task.cwd,
          ...(task.workerModel ? { workerModel: task.workerModel } : {}),
          error: detail,
          deliveryChannel: deliveryOrigin?.channel ?? 'local',
          ...buildVoiceTurnHint(this.home, deliveryOrigin?.channel ?? 'local'),
          autoDispatchesRemaining: Math.max(0, 2 - this.reportAutoDispatches.get(chainKey)),
        }), turnInit, scope => {
          turnDispatched = scope.reportTurnDispatched;
          turnSentFile = scope.reportTurnSentFile;
        });
        if (!this.valid(run)) return false;
        const isHandoffText = /^(?:\[OFFLINE SIMULATION\]\s*)?(?:好的老板[，,、\s]*)?任务已下发[。！!.\s]*$/i.test(text.trim());
        if (run.replyId) {
          if (turnDispatched && !turnSentFile && isHandoffText) {
            this.store.conversation.delete(run.replyId);
          } else {
            this.store.conversation.update(run.replyId, {
              text,
              status: 'completed',
              ...(run.deliveryOrigin ? { origin: run.deliveryOrigin } : {}),
            });
          }
          run.replyId = undefined;
          this.notifyOutbound();
        }
        return true;
      });
      if (!handled) return false;
    } catch (routerError) {
      if (run.replyId && run.replyController?.signal.aborted && !run.controller.signal.aborted) {
        this.store.conversation.update(run.replyId, { status: 'interrupted', reason: '已停止播报失败说明。' });
        run.replyId = undefined;
        this.notifyOutbound();
      } else {
        console.warn(`[friday] WORKER_FAILED router turn failed for task ${task.id}:`, routerError instanceof Error ? routerError.message : String(routerError));
      }
      return false;
    }
    if (run.reads.size > 0 || this.store.operations(run.id).some(unsettled)) {
      this.finish(run, 'paused', '失败结算前发现未决操作；工作保持暂停，不会自动重放');
      return true;
    }
    run.failureRouted = true;
    this.finish(run, 'failed', `模型或执行器请求失败：${detail}`);
    return true;
  }

  private serialRouter<T>(
    run: Run,
    work: () => Promise<T>,
    priority: 'interactive' | 'background' = 'background',
  ): Promise<T> {
    return this.enqueueRouter(priority, async () => {
      if (!this.valid(run)) throw new Error('Task no longer active');
      await this.syncRouterModelIfNeeded();
      return work();
    });
  }

  submit(requestId: string, prompt: string, paths: string[], limitMs: number, chatWork?: ChatWork): Promise<Task> {
    const pending = this.submitTask(requestId, prompt, paths, limitMs, chatWork);
    this.submissions.add(pending);
    void pending.finally(() => this.submissions.delete(pending)).catch(() => {});
    return pending;
  }

  private async submitTask(requestId: string, prompt: string, paths: string[], limitMs: number, chatWork?: ChatWork): Promise<Task> {
    if (this.closing) throw new Error('Service is shutting down');
    this.subconscious.arouse('Task submission activity');
    const fingerprint = createHash('sha256').update(JSON.stringify({
      prompt,
      paths,
      limitMs,
      sourceTaskId: chatWork?.source?.id,
      cwd: chatWork?.cwd,
      contextBrief: chatWork?.contextBrief,
      memoryIds: chatWork?.memoryIds,
      profile: chatWork?.profile,
      modelTier: chatWork?.modelTier,
      workerModel: chatWork?.workerModel,
    })).digest('hex');
    const previous = this.store.byRequest(requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error('Request ID already used with different task parameters');
      return previous;
    }

    const id = randomUUID();
    const source = chatWork?.source;
    const native = this.factory.nativeTools === true;
    let cwd: string | undefined;
    if (native) {
      let candidate = chatWork?.cwd ?? (source ? source.cwd : undefined) ?? paths[0] ?? process.cwd();
      if (!isAbsolute(candidate)) throw new Error('Native working directory must be an absolute path');
      const info = await stat(candidate);
      if (chatWork?.cwd && !info.isDirectory()) throw new Error('cwd must be a directory');
      if (info.isFile()) candidate = dirname(candidate);
      else if (!info.isDirectory()) throw new Error('Native path hint must be a file or directory');
      cwd = await realpath(candidate);
    }
    if (source && !native) {
      for (const file of source.files) await readSnapshot(this.home, source.id, file);
    }
    const authorizedPaths = source ? source.files.map(file => join(this.home, 'tasks', source.id, 'inputs', file.id)) : paths;
    let files: InputFile[] = native || (chatWork && !authorizedPaths.length) ? [] : await snapshot(this.home, id, authorizedPaths);
    if (source && !native) {
      if (files.some((file, index) => file.sha256 !== source.files[index]!.sha256)) {
        await rm(join(this.home, 'tasks', id), { recursive: true, force: true });
        throw new Error('Source snapshot changed during continuation');
      }
      files = files.map((file, index) => ({ ...file, name: source.files[index]!.name }));
    }

    const duplicate = this.store.byRequest(requestId);
    if (duplicate || this.closing || chatWork?.signal.aborted) {
      await rm(join(this.home, 'tasks', id), { recursive: true, force: true });
      if (this.closing) throw new Error('Service is shutting down');
      if (chatWork?.signal.aborted) throw new Error('Router request stopped before dispatch');
      if (source) {
        const current = this.store.get(source.id);
        const isActiveReportSource = this.currentTurn?.activeReportTask?.id === source.id && current.status === 'running';
        if (current.revision !== source.revision || (!isActiveReportSource && !['completed', 'failed', 'cancelled'].includes(current.status))) {
          throw new SourceChangedError('Source work changed before dispatch');
        }
      }
      if (duplicate!.fingerprint !== fingerprint) throw new Error('Request ID already used with different task parameters');
      return duplicate!;
    }

    const imageFilePattern = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;
    const originMessage = chatWork?.originMessageId ? this.store.conversation.get(chatWork.originMessageId) : undefined;
    const messageAttachments = originMessage ? resolveMessageAttachments(this.store, originMessage) : [];
    const combinedAttachments = dedupeAttachments([...(chatWork?.attachments ?? []), ...messageAttachments]);
    const hasImages = paths.some(p => imageFilePattern.test(p))
      || files.some(f => imageFilePattern.test(f.name))
      || combinedAttachments.some(a => a.kind === 'image' || a.mimeType?.startsWith('image/'))
      || imageFilePattern.test(prompt);

    const pool = this.modelHub.getModelPool();
    const { excludedSpecs, excludedProviders } = (chatWork && !chatWork.workerModel)
      ? resolveExcludedFailures(this.store, pool, chatWork.originMessageId, this.currentTurn?.activeFailureTask)
      : { excludedSpecs: [] as string[], excludedProviders: [] as string[] };

    const resolutionInput = {
      model: chatWork?.workerModel,
      tier: chatWork?.modelTier,
      thinkingLevel: chatWork?.thinkingLevel,
      profile: chatWork?.profile,
      instruction: prompt,
      contextBrief: chatWork?.contextBrief,
      fileCount: paths.length || files.length,
      hasImages,
      isTimer: requestId.startsWith('timer:'),
      ...(excludedSpecs.length ? { excludedSpecs } : {}),
      ...(excludedProviders.length ? { excludedProviders } : {}),
    };
    const fallbackLevelForTier = (tier: ModelTier | undefined): ThinkingLevel | undefined => (
      tier === 'fast' ? 'low' : tier === 'strong' ? 'high' : tier === 'balanced' ? 'medium' : undefined
    );
    let resolvedModel: {
      model?: string;
      tier?: ModelTier;
      thinkingLevel?: ThinkingLevel;
      confidence?: number;
      needsQualityGate?: boolean;
      needsQualityGateProb?: number;
      source?: DecisionSource;
      attempted?: boolean;
      usage?: { inputTokens: number; outputTokens?: number; totalTokens: number };
      fallbackReason?: string;
    };
    try {
      if (pool.length > 0 || this.modelHub.disabledProviders().length > 0) {
        resolvedModel = await this.modelHub.decideWorkerModel(resolutionInput);
      } else if (this.factory.resolveWorkerModel) {
        const custom = this.factory.resolveWorkerModel(resolutionInput);
        resolvedModel = {
          ...custom,
          thinkingLevel: chatWork?.thinkingLevel ?? fallbackLevelForTier(custom.tier),
          source: 'heuristic',
          attempted: false,
        };
      } else {
        const tier = chatWork?.modelTier ?? (chatWork?.workerModel || chatWork?.profile ? inferModelTier(resolutionInput) : undefined);
        resolvedModel = {
          model: chatWork?.workerModel,
          tier,
          thinkingLevel: chatWork?.thinkingLevel ?? fallbackLevelForTier(tier),
          source: 'heuristic',
          attempted: false,
        };
      }
    } catch (error) {
      await rm(join(this.home, 'tasks', id), { recursive: true, force: true });
      throw error;
    }

    if (this.closing || chatWork?.signal.aborted) {
      await rm(join(this.home, 'tasks', id), { recursive: true, force: true });
      if (this.closing) throw new Error('Service is shutting down');
      throw new Error('Router request stopped before dispatch');
    }
    const breaker = chatWork ? detectProviderFailureBreaker(this.store, resolvedModel.model) : undefined;
    if (breaker) {
      await rm(join(this.home, 'tasks', id), { recursive: true, force: true });
      throw new Error(breaker);
    }

    const sourceOriginSession = chatWork?.source?.sessionId
      ?? (chatWork?.source?.originMessageId
        ? (() => { try { return this.store.conversation.get(chatWork.source.originMessageId!).sessionId; } catch { return undefined; } })()
        : undefined);
    const taskSessionId = originMessage?.sessionId ?? sourceOriginSession ?? formatTaskSessionId(id);
    const resolvedTimerId = chatWork?.timerId ?? parseTimerIdFromRequestId(requestId);
    const resolvedTaskOrigin = chatWork
      ? (chatWork.origin ?? (chatWork.originMessageId ? this.store.conversation.get(chatWork.originMessageId).origin : chatWork.source?.origin))
      : undefined;
    const resolvedInitiator: RunInitiator | undefined = chatWork?.initiator
      ?? (resolvedTimerId ? { kind: 'timer', id: resolvedTimerId } : undefined)
      ?? (resolvedTaskOrigin?.channel === 'xiaoai' ? { kind: 'voice' } : chatWork ? { kind: 'person' } : { kind: 'system' });

    const task: Task = {
      id,
      requestId,
      fingerprint,
      prompt,
      files,
      limitMs,
      activeMs: 0,
      status: 'queued',
      revision: 0,
      mode: this.factory.mode,
      createdAt: Date.now(),
      sessionId: taskSessionId,
      execution: native ? 'native' : 'snapshot',
      cwd,
      paths: native ? (paths.length ? paths : source?.paths ?? []) : undefined,
      origin: resolvedTaskOrigin,
      originMessageId: chatWork?.originMessageId,
      parentTaskId: chatWork?.parentTaskId,
      parentSpanId: chatWork?.parentSpanId,
      contextBrief: chatWork?.contextBrief,
      memoryIds: chatWork?.memoryIds,
      profile: chatWork?.profile,
      modelTier: resolvedModel.tier,
      workerModel: resolvedModel.model,
      thinkingLevel: resolvedModel.thinkingLevel,
      decisionSource: resolvedModel.source,
      decisionConfidence: resolvedModel.confidence,
      ...(resolvedModel.needsQualityGate === false ? { skipQualityGate: true } : {}),
      ...(resolvedInitiator ? { initiator: resolvedInitiator } : {}),
      ...(resolvedTimerId ? { timerId: resolvedTimerId } : {}),
    };

    try {
      this.store.transaction(() => {
        if (source) {
          const current = this.store.get(source.id);
          const isActiveReportSource = this.currentTurn?.activeReportTask?.id === source.id && current.status === 'running';
          if (current.revision !== source.revision || (!isActiveReportSource && !['completed', 'failed', 'cancelled'].includes(current.status))) {
            throw new SourceChangedError('Source work changed or was stopped while preparing this dispatch; no related work was created');
          }
        }
        this.store.create(task);
        if (chatWork?.originMessageId) this.store.conversation.link(chatWork.originMessageId, task.id);
      });
    } catch (error) {
      await rm(join(this.home, 'tasks', id), { recursive: true, force: true });
      throw error;
    }

    if (resolvedModel.attempted) {
      this.store.conversation.span(
        {
          rootId: chatWork?.originMessageId ?? task.id,
          ...(chatWork?.originMessageId ? { messageId: chatWork.originMessageId } : {}),
          taskId: task.id,
          spanId: `${task.id}:decision:route`,
          parentSpanId: task.id,
        },
        'system',
        'Gemini Decision 1 选模定级',
        resolvedModel.source === 'gemini-decision-1' ? 'completed' : 'fallback',
        {
          request: {
            endpoint: '/v1beta/decisions',
            decisionModel: 'gemini-decision-1',
            profile: resolutionInput.profile ?? 'general',
            ...(resolutionInput.tier ? { preferredTier: resolutionInput.tier } : {}),
            ...(resolutionInput.thinkingLevel ? { preferredLevel: resolutionInput.thinkingLevel } : {}),
            fileCount: resolutionInput.fileCount,
            hasImages: resolutionInput.hasImages,
            isTimer: resolutionInput.isTimer,
            candidateCount: pool.length,
            ...(resolutionInput.excludedSpecs ? { excludedSpecs: resolutionInput.excludedSpecs } : {}),
            ...(resolutionInput.excludedProviders ? { excludedProviders: resolutionInput.excludedProviders } : {}),
            instructionPreview: prompt.slice(0, 320),
          },
          model: resolvedModel.model,
          thinkingLevel: resolvedModel.thinkingLevel,
          source: resolvedModel.source,
          ...(resolvedModel.confidence !== undefined ? { confidence: resolvedModel.confidence } : {}),
          ...(resolvedModel.needsQualityGate !== undefined ? { needsQualityGate: resolvedModel.needsQualityGate, needsQualityGateProb: resolvedModel.needsQualityGateProb } : {}),
          ...(resolvedModel.usage ? { usage: resolvedModel.usage } : {}),
          ...(resolvedModel.fallbackReason ? { fallbackReason: resolvedModel.fallbackReason } : {}),
        },
      );
    }

    const run: Run = {
      id,
      revision: 0,
      controller: new AbortController(),
      jobs: 0,
      activeCalls: 0,
      clockUncertain: false,
      reads: new Map(),
      completions: [],
      lastTick: performance.now(),
      lastWall: Date.now(),
      ...(combinedAttachments.length ? { attachments: combinedAttachments } : {}),
    };
    this.runs.set(id, run);

    const limit = resolveMaxConcurrentWorkers();
    if (chatWork) {
      if (this.activeWorkerSlots.size < limit) {
        this.activeWorkerSlots.add(id);
        this.store.transition(id, 'running');
        this.launch(run, () => this.work(run));
        return this.store.get(id);
      }
      this.queuedWorkers.push({ run, isChatWork: true, launchWork: () => this.work(run) });
      return this.store.get(id);
    }

    const launchNonChat = async () => {
      await this.serialRouter(run, async () => {
        if (!this.valid(run)) return;
        if (this.store.get(id).status === 'queued') this.store.transition(id, 'running');
        run.lastTick = performance.now();
        run.lastWall = Date.now();
        let dispatched = false;
        const dispatch = async () => {
          if (!this.valid(run)) throw new Error('Task was stopped');
          if (!dispatched) {
            dispatched = true;
            this.launch(run, () => this.work(run));
          }
          return JSON.stringify({ taskId: id, state: 'dispatched' });
        };
        await this.prompt(run, this.router!, JSON.stringify({ kind: 'NEW_TASK', taskId: id, prompt, files }), { dispatch });
        if (!dispatched && this.valid(run)) throw new Error('Router did not dispatch the task');
      });
    };
    if (this.activeWorkerSlots.size < limit) {
      this.activeWorkerSlots.add(id);
      this.launch(run, launchNonChat);
    } else {
      this.queuedWorkers.push({
        run,
        isChatWork: false,
        launchWork: launchNonChat,
      });
    }
    return task;
  }

  private async work(run: Run) {
    const task = this.store.get(run.id);
    const savedCheckpoint = run.resumed
      ? this.store.conversation.meta<{ sessionFile?: string; leafId?: string } | null>(`worker_checkpoint:${task.id}`)
      : undefined;
    const canRestore = Boolean(
      run.resumed
      && savedCheckpoint?.sessionFile
      && savedCheckpoint.leafId
      && existsSync(savedCheckpoint.sessionFile),
    );
    const restoreCheckpoint = canRestore
      ? { sessionFile: savedCheckpoint!.sessionFile!, leafId: savedCheckpoint!.leafId! }
      : undefined;
    const activeToolScenes = new Map<string, { scene: Cs80SceneId; caption: string }>();
    const extractBashCmd = (data: unknown): string => {
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data) as { command?: unknown };
          if (typeof parsed?.command === 'string') return parsed.command;
        } catch {
          return data;
        }
      }
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const cmd = (data as { command?: unknown }).command;
        if (typeof cmd === 'string') return cmd;
      }
      return '';
    };
    const worker = await this.factory.create(
      'worker',
      run.id,
      task.execution === 'native'
        ? []
        : [{
            name: 'start_read',
            description: 'Start an asynchronous read of a permitted snapshot file. Input must be a listed file ID, such as f0. Returns an operation ID, not file contents.',
            execute: async (fileId, callId) => {
              if (!this.valid(run)) throw new Error('Task is no longer active');
              const file = task.files.find(item => item.id === fileId);
              if (!file) throw new Error('File ID is not authorized');
              if (run.reads.size >= 32) throw new Error('Too many pending reads');
              const op: Operation = {
                id: randomUUID(),
                taskId: task.id,
                revision: run.revision,
                fileId,
                status: 'requested',
                parentSpanId: run.trace?.toolSpan(callId),
              };
              const promise = this.ensureExecutor()
                .then(exec => exec.start(op, file))
                .catch(() => {
                  const unknown: Operation = { ...op, status: 'unknown', error: 'Executor could not accept the operation; no automatic replay' };
                  this.store.operation(unknown);
                  return unknown;
                });
              run.reads.set(op.id, promise);
              void promise.then(result => {
                accrueTaskRun(this.store, run);
                run.reads.delete(op.id);
                if (this.valid(run)) run.completions.push(result);
              });
              return JSON.stringify({ operationId: op.id, state: 'requested' });
            },
          }],
      {
        execution: task.execution ?? 'snapshot',
        cwd: task.cwd,
        profile: task.profile,
        tier: task.modelTier,
        thinkingLevel: task.thinkingLevel,
        model: task.workerModel,
        ...(restoreCheckpoint ? { restore: restoreCheckpoint } : {}),
        nativeTool: event => {
          const id = `${task.id}:${event.id}`;
          if (event.phase === 'start') {
            if (!this.valid(run)) throw new Error('Task is no longer active');
            this.store.operation({
              id,
              taskId: task.id,
              revision: run.revision,
              fileId: `native:${event.name}`,
              status: 'started',
              parentSpanId: run.trace?.toolSpan(event.id),
            });
          } else {
            const previous = this.store.operationById(id, task.id);
            if (!previous) throw new Error('Native tool start record missing');
            this.store.operation({
              ...previous,
              status: event.interrupted ? 'unknown' : event.error ? 'failed' : 'succeeded',
              error: event.interrupted ? '本机工具已中断，副作用结果未经确认；不会自动重放' : event.error ? '本机工具失败，详情见工具轨迹' : undefined,
            });
            if (event.interrupted) this.stop(task.id, '本机工具超时或中断，副作用结果未经确认；工作暂停，不会自动重放', 'paused');
          }
        },
        onEvent: event => {
          if (event.kind === 'tool_start' && event.toolName === 'bash' && event.id) {
            const matched = classifyBashCommandCs80Scene(extractBashCmd(event.data));
            if (matched) {
              activeToolScenes.set(event.id, matched);
              notifyCs80Scene({
                scene: matched.scene,
                phase: 'start',
                holdSec: 30,
                caption: matched.caption,
              });
            }
          } else if (event.kind === 'tool_end' && event.id) {
            const active = activeToolScenes.get(event.id);
            if (active) {
              activeToolScenes.delete(event.id);
              notifyCs80Scene(
                event.error
                  ? { scene: active.scene, phase: 'end', tailSec: 0 }
                  : { scene: active.scene, phase: 'pulse', holdSec: 4.0, caption: active.caption },
              );
            }
          }
          run.trace?.observe(event);
        },
      },
    );
    run.worker = worker;
    if (!this.valid(run)) { worker.close(); return; }
    const current = this.store.get(task.id);
    current.sessionFile = worker.sessionFile;
    this.store.save(current);

    const prior = task.parentTaskId ? this.store.get(task.parentTaskId) : undefined;
    const recalledMemories = await this.store.memoriesForContextAsync({
      memoryIds: task.memoryIds,
      cwd: task.cwd,
      queryText: task.prompt,
      limit: 8,
    });
    const initialPeers = task.execution === 'native' ? this.activePeersInCwd(task.cwd, task.id) : [];
    const compiledContext = (task.contextBrief || recalledMemories.length || initialPeers.length || task.profile || task.workerModel || task.modelTier || task.thinkingLevel)
      ? {
          profile: task.profile ?? 'general',
          ...(task.modelTier ? { modelTier: task.modelTier } : {}),
          ...(task.thinkingLevel ? { thinkingLevel: task.thinkingLevel } : {}),
          ...(task.workerModel ? { workerModel: task.workerModel } : {}),
          ...(task.contextBrief ? { contextBrief: task.contextBrief } : {}),
          ...(initialPeers.length ? { concurrentPeers: initialPeers } : {}),
          recalledMemories: recalledMemories.map(card => ({
            id: card.id, topic: card.topic, content: card.content, tags: card.tags, cwd: card.cwd, updatedAt: card.updatedAt,
          })),
        }
      : undefined;

    const priorFollowups = run.resumed
      ? this.store.events(task.id)
          .filter(ev => ev.state === 'done')
          .map(ev => ({ id: ev.id, text: ev.text }))
      : [];
    const priorOperations = run.resumed
      ? this.store.operations(task.id).map(op => ({ id: op.id, fileId: op.fileId, status: op.status, error: op.error }))
      : [];
    const taskAttachments = resolveTaskAttachments(this.store, task, run.attachments);
    let input: Record<string, unknown> = {
      kind: 'TASK',
      taskId: task.id,
      prompt: task.prompt,
      files: task.files,
      ...(taskAttachments.length ? { attachments: taskAttachments } : {}),
      execution: task.execution ?? 'snapshot',
      cwd: task.cwd,
      paths: task.paths,
      ...(task.profile ? { profile: task.profile } : {}),
      ...(task.modelTier ? { modelTier: task.modelTier } : {}),
      ...(task.thinkingLevel ? { thinkingLevel: task.thinkingLevel } : {}),
      ...(task.workerModel ? { workerModel: task.workerModel } : {}),
      ...(compiledContext ? { compiledContext } : {}),
      ...(run.resumed
        ? {
            resumed: true,
            ...(priorFollowups.length ? { priorFollowups } : {}),
            ...(priorOperations.length ? { priorOperations } : {}),
            ...((task.report ?? task.partialReport) ? { priorReport: task.report ?? task.partialReport } : {}),
          }
        : {}),
      priorWork: prior
        ? {
            taskId: prior.id,
            prompt: prior.prompt,
            mode: prior.mode,
            execution: prior.execution ?? 'snapshot',
            report: prior.report,
            note: 'Historical report only. Its claims about tools or access do not describe the current Worker; use current execution and actual tools.',
          }
        : undefined,
    };

    const followupTexts: string[] = priorFollowups.map(ev => ev.text.trim()).filter(Boolean);
    const persistPartialReport = (candidate: string) => {
      if (candidate.trim() && !parseWorkerQuestion(candidate)) {
        const partialTask = this.store.get(task.id);
        partialTask.partialReport = candidate;
        this.store.save(partialTask);
      }
    };
    try {
      while (this.valid(run)) {
        const events = this.store.takeEvents(task.id);
        for (const ev of events) {
          if (ev.text?.trim()) followupTexts.push(ev.text.trim());
        }
        const livePeers = task.execution === 'native' ? this.activePeersInCwd(task.cwd, task.id) : [];
        let report: string;
        try {
          report = await this.prompt(run, worker, JSON.stringify({
            input,
            followups: events,
            ...(livePeers.length ? { concurrentPeers: livePeers } : {}),
            ...input,
          }));
        } catch (error) {
          if (worker.checkpoint) {
            this.store.conversation.setMeta(`worker_checkpoint:${task.id}`, worker.checkpoint);
          }
          this.store.abandonEvents(events, 'Worker 请求失败或中断，未确认送达');
          throw error;
        }
        if (worker.checkpoint) {
          this.store.conversation.setMeta(`worker_checkpoint:${task.id}`, worker.checkpoint);
        }
        if (!this.valid(run)) {
          this.store.abandonEvents(events, '工作已停止，未确认送达');
          return;
        }
        if (report.length > 65_536) {
          this.store.abandonEvents(events, 'Worker 报告超过交付上限，未确认送达');
          throw new Error('Worker report exceeds delivery limit');
        }
        if (run.reads.size) await Promise.all([...run.reads.values()]);
        if (!this.valid(run)) {
          this.store.abandonEvents(events, '工作已停止，未确认送达');
          return;
        }
        if (run.completions.length) {
          const results = run.completions.splice(0);
          if (results.some(result => result.status !== 'succeeded')) {
            this.store.abandonEvents(events, '文件读取操作失败或结果未知；任务已暂停');
            this.finish(run, 'paused', '文件读取操作失败或结果未知；不会自动重放');
            return;
          }
          this.store.finishEvents(events);
          input = { kind: 'READ_COMPLETIONS', results };
          continue;
        }
        if (this.store.operations(task.id).some(unsettled)) {
          this.store.abandonEvents(events, '存在结果不明的工具调用；任务已暂停');
          this.finish(run, 'paused', '存在结果不明的工具调用；不会自动重放');
          return;
        }
        const successfulReads = new Set(this.store.operations(task.id).filter(op => op.status === 'succeeded').map(op => op.fileId));
        if (task.files.some(file => !successfulReads.has(file.id))) {
          this.store.abandonEvents(events, 'Worker 未读取全部输入；任务已暂停');
          this.finish(run, 'paused', 'Worker 未读取全部明确提供的输入；拒绝交付无依据的成功报告');
          return;
        }
        this.store.finishEvents(events);
        if (this.store.hasPending(task.id)) {
          persistPartialReport(report);
          const pendingAttachments = run.pendingFollowupAttachments?.splice(0) ?? [];
          input = { kind: 'FOLLOWUP', ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}) };
          continue;
        }

        const asked = parseWorkerQuestion(report);
        if (asked) {
          let yieldedToPendingFollowup = false;
          let preQuestionIds = new Set<string>();
          try {
            yieldedToPendingFollowup = await this.serialRouter(run, async () => {
              if (this.store.hasPending(task.id)) {
                return true;
              }
              const waitingTask = this.store.get(task.id);
              waitingTask.pendingQuestion = {
                question: asked.question,
                ...(asked.options?.length ? { options: asked.options } : {}),
                askedAt: Date.now(),
              };
              waitingTask.reason = `等待老板拍板：${asked.question.slice(0, 160)}`;
              this.store.save(waitingTask);
              this.store.notice(task.id, 'waiting_decision', waitingTask.reason);
              const qDeliveryOrigin = run.deliveryOrigin ?? waitingTask.origin;
              preQuestionIds = new Set(this.store.events(task.id).map(ev => ev.id));
              const questionText = await this.prompt(run, this.router!, JSON.stringify({
                kind: 'WORKER_QUESTION',
                taskId: task.id,
                prompt: task.prompt,
                question: asked.question,
                ...(asked.options?.length ? { options: asked.options } : {}),
                deliveryChannel: qDeliveryOrigin?.channel ?? 'local',
                ...buildVoiceTurnHint(this.home, qDeliveryOrigin?.channel ?? 'local'),
              }));
              if (run.replyId) {
                this.store.conversation.update(run.replyId, {
                  text: questionText,
                  status: 'completed',
                  ...(run.deliveryOrigin ? { origin: run.deliveryOrigin } : {}),
                  reason: '等待老板拍板：后台工作已原地挂起（不消耗时限预算），回复后将在同一会话继续推进。',
                });
                run.replyId = undefined;
                this.notifyOutbound();
              }
              return false;
            }, 'interactive');
          } catch (qErr) {
            if (run.replyId && run.replyController?.signal.aborted && !run.controller.signal.aborted) {
              this.store.conversation.update(run.replyId, {
                status: 'interrupted',
                reason: '已停止请示播报；后台工作已暂停等待您的指令。',
              });
              run.replyId = undefined;
              this.notifyOutbound();
            } else if (!this.valid(run)) {
              return;
            } else {
              console.warn(`[friday] WORKER_QUESTION delivery warning for ${task.id}:`, qErr instanceof Error ? qErr.message : String(qErr));
            }
          }
          if (!this.valid(run)) return;
          if (yieldedToPendingFollowup) {
            const pendingAttachments = run.pendingFollowupAttachments?.splice(0) ?? [];
            input = { kind: 'FOLLOWUP', ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}) };
            continue;
          }
          await this.waitForFollowupOrStop(run, preQuestionIds);
          if (!this.valid(run)) return;
          const resumedTask = this.store.get(task.id);
          delete resumedTask.pendingQuestion;
          resumedTask.reason = '已收到老板拍板，继续推进';
          this.store.save(resumedTask);
          this.store.notice(task.id, 'decision_received', resumedTask.reason);
          const pendingAttachments = run.pendingFollowupAttachments?.splice(0) ?? [];
          input = {
            kind: 'BOSS_DECISION',
            question: asked.question,
            ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}),
          };
          continue;
        }

        const taskOps = this.store.operations(task.id);
        const succeededOps = taskOps.filter(op => op.status === 'succeeded').length;
        const failedOps = taskOps.filter(op => op.status === 'failed' || op.status === 'unknown').length;
        const qualityEval = await this.modelHub.evaluateCompletion({
          prompt: task.prompt,
          contextBrief: task.contextBrief,
          profile: task.profile,
          followups: followupTexts,
          report,
          succeededOps,
          failedOps,
          skipRemote: Boolean(task.skipQualityGate),
        });
        if (!this.valid(run)) return;
        const preEvalTask = this.store.get(task.id);
        preEvalTask.report = report;
        preEvalTask.qualityGate = qualityEval.assessment;
        this.store.save(preEvalTask);
        if (qualityEval.attempted) {
          this.store.conversation.span(
            {
              rootId: task.originMessageId ?? task.id,
              ...(task.originMessageId ? { messageId: task.originMessageId } : {}),
              taskId: task.id,
              spanId: `${task.id}:decision:quality`,
              parentSpanId: task.id,
            },
            'system',
            'Gemini Decision 1 完成度评估',
            qualityEval.assessment.source === 'gemini-decision-1' ? 'completed' : 'fallback',
            {
              request: {
                endpoint: '/v1beta/decisions',
                decisionModel: 'gemini-decision-1',
                profile: task.profile ?? 'general',
                succeededOps,
                failedOps,
                followupCount: followupTexts.length,
                reportLength: report.length,
                skipRemote: Boolean(task.skipQualityGate),
              },
              ...qualityEval.assessment,
              ...(qualityEval.usage ? { usage: qualityEval.usage } : {}),
              ...(qualityEval.fallbackReason ? { fallbackReason: qualityEval.fallbackReason } : {}),
            },
          );
        }

        let silentHandoff = false;
        let acceptedByRouter = false;
        let savedMemoryInReportTurn = false;
        let reportDeliveryFailed = false;
        let reportDeliveryStopped = false;
        let delivered: string | undefined;
        try {
          delivered = await this.serialRouter(run, async () => {
            const preReport = this.store.get(task.id);
            preReport.report = report;
            preReport.qualityGate = qualityEval.assessment;
            this.store.save(preReport);
            const chainKey = resolveReportChainKey(this.store, preReport);
            const autoDispatchesRemaining = Math.max(0, 2 - this.reportAutoDispatches.get(chainKey));
            const imChannels = this.store.listImChannelViews()
              .filter(c => c.enabled)
              .map(({ id, platform, name, loginStatus, defaultTarget }) => ({ id, platform, name, loginStatus, defaultTarget }));
            const reportTruncSuffix = `\n…[已截断，完整共${report.length}字，详情调 inspect_work]`;
            const reportForRouter = report.length > 800
              ? `${report.slice(0, Math.max(0, 800 - reportTruncSuffix.length))}${reportTruncSuffix}`
              : report;
            const rDeliveryOrigin = run.deliveryOrigin ?? preReport.origin;
            const turnState: { dispatched: boolean; sentFile: boolean; savedMemory: boolean } = {
              dispatched: false,
              sentFile: false,
              savedMemory: false,
            };
            const timerId = task.timerId ?? parseTimerIdFromRequestId(task.requestId);
            const linkedTimer = timerId ? this.store.listTimers().find(t => t.id === timerId) : undefined;
            const text = await this.prompt(
              run,
              this.router!,
              JSON.stringify({
                kind: 'WORKER_REPORT',
                taskId: task.id,
                prompt: task.prompt,
                cwd: task.cwd,
                report: reportForRouter,
                qualityGate: qualityEval.assessment,
                deliveryChannel: rDeliveryOrigin?.channel ?? 'local',
                ...buildVoiceTurnHint(this.home, rDeliveryOrigin?.channel ?? 'local'),
                ...(imChannels.length ? { imChannels } : {}),
                ...(linkedTimer?.goalCondition && linkedTimer.enabled
                  ? {
                      timerGoal: {
                        timerId: linkedTimer.id,
                        timerName: linkedTimer.name,
                        goalCondition: linkedTimer.goalCondition,
                        hint: '若确认该终态目标已达成，可在总结末尾附加 [[GOAL_MET: 一句话说明达成情况]] 或调用 manage_timer{action:"complete"}。',
                      },
                    }
                  : {}),
                autoDispatchesRemaining,
                memoryDirectory: compactRouterChatMemoryDirectory(this.store.memoryDirectory(10)),
              }),
              undefined,
              scope => {
                turnState.dispatched = scope.reportTurnDispatched;
                turnState.sentFile = scope.reportTurnSentFile;
                turnState.savedMemory = scope.reportTurnSavedMemory;
              },
            );
            savedMemoryInReportTurn = turnState.savedMemory;
            const isHandoffText = /^(?:\[OFFLINE SIMULATION\]\s*)?(?:好的老板[，,、\s]*)?任务已下发[。！!.\s]*$/i.test(text.trim());
            if (this.store.hasPending(task.id)) {
              if (run.replyId) {
                if (!turnState.sentFile && isHandoffText) {
                  this.store.conversation.delete(run.replyId);
                } else {
                  this.store.conversation.update(run.replyId, {
                    text,
                    status: 'completed',
                    ...(run.deliveryOrigin ? { origin: run.deliveryOrigin } : {}),
                    reason: '阶段回复：工作仍在继续，将处理新补充要求。',
                  });
                }
                this.notifyOutbound();
              }
              run.replyId = undefined;
              return undefined;
            }
            if (turnState.dispatched && !turnState.sentFile && isHandoffText) {
              if (run.replyId) {
                this.store.conversation.delete(run.replyId);
                run.replyId = undefined;
                this.notifyOutbound();
              }
              silentHandoff = true;
            }
            acceptedByRouter = !turnState.dispatched;
            run.acceptedByRouter = acceptedByRouter;
            if (text.length > 65_536) throw new Error('Router report exceeds delivery limit');
            return text;
          });
        } catch (reportErr) {
          if (!this.valid(run)) return;
          if (run.replyController?.signal.aborted) {
            reportDeliveryStopped = true;
            if (run.replyId) {
              this.store.conversation.update(run.replyId, { status: 'interrupted', reason: '已停止汇总播报；后台任务完整报告已保留。' });
              run.replyId = undefined;
              this.notifyOutbound();
            }
          } else {
            reportDeliveryFailed = true;
            const errMsg = reportErr instanceof Error ? reportErr.message : String(reportErr);
            this.store.notice(task.id, 'router_report_fallback', `Router 汇总播报失败，已保留完整报告直接交付：${errMsg.slice(0, 200)}`);
          }
        }

        if (!this.valid(run)) return;
        if (reportDeliveryStopped) {
          this.finish(run, 'completed', '汇报播报已停止；完整报告已保留', report);
          return;
        }
        if (reportDeliveryFailed) {
          const fallbackText = report.length > 65_536 ? `${report.slice(0, 65_400)}\n…[完整报告已保存至任务记录]` : report;
          this.finish(run, 'completed', undefined, report, fallbackText);
          const settledTask = this.store.get(task.id);
          if (this.subconscious.isDistillerEnabled() && task.originMessageId && !savedMemoryInReportTurn && settledTask.status === 'completed') {
            this.subconscious.enqueueTaskDistillation(settledTask.id);
          }
          return;
        }
        if (delivered === undefined) {
          persistPartialReport(report);
          const pendingAttachments = run.pendingFollowupAttachments?.splice(0) ?? [];
          input = { kind: 'FOLLOWUP', ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}) };
          continue;
        }
        this.finish(run, 'completed', undefined, report, silentHandoff ? report : delivered);
        const settledTask = this.store.get(task.id);
        if (this.subconscious.isDistillerEnabled() && acceptedByRouter && task.originMessageId && !savedMemoryInReportTurn && settledTask.status === 'completed') {
          this.subconscious.enqueueTaskDistillation(settledTask.id);
        }
        return;
      }
    } finally {
      if (!this.storeClosed && worker.checkpoint && this.store.get(task.id).status === 'paused') {
        this.store.conversation.setMeta(`worker_checkpoint:${task.id}`, worker.checkpoint);
      }
      worker.close();
    }
  }

  private waitForFollowupOrStop(run: Run, preQuestionIds?: Set<string>): Promise<void> {
    const hasPostQuestionPending = () => this.store.events(run.id).some(ev =>
      ev.state === 'pending' && (!preQuestionIds || !preQuestionIds.has(ev.id)),
    );
    if (!this.valid(run) || hasPostQuestionPending()) return Promise.resolve();
    return new Promise<void>(resolve => {
      const done = () => {
        if (preQuestionIds && this.valid(run) && !hasPostQuestionPending()) return;
        if (run.wakeFollowup === done) run.wakeFollowup = undefined;
        run.controller.signal.removeEventListener('abort', done);
        resolve();
      };
      run.wakeFollowup = done;
      run.controller.signal.addEventListener('abort', done, { once: true });
    });
  }

  followup(id: string, requestId: string, text: string): Task {
    this.subconscious.arouse('Follow-up activity');
    const task = this.store.get(id);
    if (!['queued', 'running'].includes(task.status)) {
      throw new Error('Follow-ups require a queued or running task; submit a new task for terminal/paused results');
    }
    const added = this.store.addEvent(requestId, id, text);
    if (added && task.limitMs >= 60_000 && task.limitMs < 1_200_000) {
      const latest = this.store.get(id);
      if (['queued', 'running'].includes(latest.status)) {
        latest.limitMs = Math.min(1_200_000, latest.limitMs + 300_000);
        this.store.save(latest);
      }
    }
    this.runs.get(id)?.wakeFollowup?.();
    return this.store.get(id);
  }

  stop(id: string, reason = '已请求取消，等待在途操作结算', status: 'paused' | 'cancelled' | 'failed' = 'cancelled'): Task {
    const existing = this.runs.get(id);
    if (existing) accrueTaskRun(this.store, existing);
    const task = this.store.get(id);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
    const run = this.runs.get(id);
    if (!run) {
      const uncertain = this.store.operations(id).some(unsettled);
      if (uncertain) return this.store.transition(id, 'paused', '无法确认操作结算；工作保持暂停，不会自动重放');
      if (status === 'cancelled') return this.store.transition(id, 'cancelled', '已取消暂停中的工作；没有正在执行的进程');
      return task;
    }
    if (run.stopping) return this.store.get(id);
    task.revision++;
    task.status = 'paused';
    task.reason = reason;
    this.store.save(task);
    this.store.notice(id, 'stop_requested', reason);
    run.stopping = status;
    run.controller.abort(new Error(reason));
    for (let i = this.queuedWorkers.length - 1; i >= 0; i--) {
      if (this.queuedWorkers[i]!.run.id === id) this.queuedWorkers.splice(i, 1);
    }
    for (const op of this.store.operations(id)) {
      if (['requested', 'started'].includes(op.status)) {
        op.status = 'cancel_requested';
        this.store.operation(op);
        if (!op.fileId.startsWith('native:')) this.executor?.stop(op.id);
      }
    }
    if (!run.jobs) this.finish(run, status, reason);
    return this.store.get(id);
  }

  resume(id: string, extendMs = 600_000): Task {
    if (this.closing) throw new Error('Service is shutting down');
    this.subconscious.arouse('Resume activity');
    const task = this.store.get(id);
    if (task.status !== 'paused' || this.runs.has(id)) throw new Error('Only a settled paused task can be resumed');
    const hasSlot = this.activeWorkerSlots.size < resolveMaxConcurrentWorkers();
    this.store.transaction(() => {
      this.store.acknowledgeUnsettledOperations(id);
      task.revision++;
      task.limitMs = Math.max(task.limitMs, Math.ceil(task.activeMs) + extendMs);
      task.status = hasSlot ? 'running' : 'queued';
      task.reason = hasSlot ? '用户已确认恢复运行' : '用户已确认恢复运行，等待并发槽位';
      this.store.save(task);
      this.store.notice(id, task.status, task.reason);
    });
    const attachments = resolveTaskAttachments(this.store, task);
    const run: Run = {
      id,
      revision: task.revision,
      controller: new AbortController(),
      jobs: 0,
      activeCalls: 0,
      clockUncertain: false,
      reads: new Map(),
      completions: [],
      resumed: true,
      lastTick: performance.now(),
      lastWall: Date.now(),
      ...(attachments.length ? { attachments } : {}),
    };
    this.runs.set(id, run);
    if (hasSlot) {
      this.activeWorkerSlots.add(id);
      this.launch(run, () => this.work(run));
    } else {
      this.queuedWorkers.push({ run, isChatWork: true, launchWork: () => this.work(run) });
    }
    return this.store.get(id);
  }

  addTimer(
    name: string,
    instruction: string,
    intervalMs = 60_000,
    cwd?: string,
    origin?: MessageOrigin,
    options?: AddTimerOptions,
  ): Timer {
    return this.timers.addTimer(name, instruction, intervalMs, cwd, origin, options);
  }

  toggleTimer(id: string, enabled: boolean): Timer {
    return this.timers.toggleTimer(id, enabled);
  }

  completeTimer(id: string, summary?: string): Timer {
    return this.timers.completeTimer(id, summary);
  }

  removeTimer(id: string): boolean {
    return this.timers.removeTimer(id);
  }

  private finish(run: Run, status: TaskStatus, reason?: string, report?: string, replyText?: string) {
    if (!accrueTaskRun(this.store, run) && status === 'completed') {
      status = 'paused';
      reason = '交付时检测到时钟或心跳缺口，无法证明活跃用时';
      report = undefined;
      replyText = undefined;
    }
    const current = this.store.get(run.id);
    if (status === 'completed' && current.activeMs >= current.limitMs) {
      status = 'paused';
      reason = '交付前已达到活跃执行时限；工作暂停';
      report = undefined;
      replyText = undefined;
    }
    if (['completed', 'failed', 'cancelled'].includes(current.status)) {
      this.activeWorkerSlots.delete(run.id);
      this.pumpWorkerQueue();
      return;
    }
    if (run.controller.signal.aborted && !run.stopping) {
      this.activeWorkerSlots.delete(run.id);
      this.pumpWorkerQueue();
      return;
    }
    const effectiveReplyOrigin = run.deliveryOrigin ?? current.origin;
    const isCompleted = status === 'completed';
    const reportMarker = isCompleted ? extractGoalMetMarker(report) : { met: false, cleanedText: report ?? '' };
    const replyMarker = isCompleted ? extractGoalMetMarker(replyText) : { met: false, cleanedText: replyText ?? '' };
    const effectiveReport = isCompleted && report !== undefined
      ? (reportMarker.cleanedText || (reportMarker.met ? (reportMarker.summary ?? '目标已达成') : ''))
      : report;
    const effectiveReplyText = isCompleted && replyText !== undefined
      ? (replyMarker.cleanedText || (replyMarker.met ? ((replyMarker.summary ?? reportMarker.cleanedText) || '目标已达成') : ''))
      : replyText;
    const goalMetSignal = isCompleted && (reportMarker.met || replyMarker.met);
    const goalMetSummary = replyMarker.summary ?? reportMarker.summary;
    const silentTimerFailure = status === 'failed' && this.timers.willNextFailureBeSilent(current);
    const failureNotifiedInConversation = status === 'failed'
      && !silentTimerFailure
      && Boolean(run.replyId || run.failureRouted || (taskStatusNeedsNotice(status) && current.originMessageId));
    this.store.transaction(() => {
      this.store.transition(run.id, status, reason, effectiveReport);
      if (['completed', 'failed', 'cancelled'].includes(status)) {
        this.store.failPendingEvents(run.id, status === 'cancelled' ? '工作已取消' : '工作已结束');
        this.store.conversation.setMeta(`worker_checkpoint:${run.id}`, null);
      }
      if (status === 'completed' || status === 'failed') {
        const calibratedScore = current.qualityGate?.source === 'gemini-decision-1'
          ? current.qualityGate.score
          : undefined;
        const shouldCapScore = run.acceptedByRouter === false || current.qualityGate?.shouldSupplement === true;
        const effectiveQualityScore = status === 'completed'
          ? (shouldCapScore
              ? (calibratedScore !== undefined ? Math.min(calibratedScore, 1.2) : (run.acceptedByRouter === false ? 1.2 : undefined))
              : calibratedScore)
          : undefined;
        this.modelHub.recordTaskOutcome(current.workerModel, status === 'completed', current.activeMs, effectiveQualityScore);
      }
      if (!silentTimerFailure && !run.replyId && !run.failureRouted && taskStatusNeedsNotice(status) && current.originMessageId) {
        const message = this.store.conversation.create({
          id: randomUUID(),
          role: 'assistant',
          source: 'system',
          origin: effectiveReplyOrigin,
          replyTo: current.originMessageId,
          text: '',
          status: status === 'failed' ? 'failed' : 'interrupted',
          reason: `后台工作${status === 'cancelled' ? '已取消' : status === 'failed' ? '失败' : '暂停'}：${reason ?? '未确认完成，可查看执行轨迹；没有自动重放。'}`,
          mode: this.factory.mode,
          paths: [],
        });
        this.store.conversation.link(message.id, run.id);
      }
      if (run.replyId) {
        if (silentTimerFailure) {
          this.store.conversation.delete(run.replyId);
          run.replyId = undefined;
        } else {
          const reply = this.store.conversation.get(run.replyId);
          this.store.conversation.update(
            run.replyId,
            status === 'completed'
              ? {
                  text: effectiveReplyText ?? effectiveReport ?? '',
                  status: 'completed',
                  ...(run.deliveryOrigin ? { origin: run.deliveryOrigin } : {}),
                }
              : {
                  text: reply.text,
                  status: status === 'failed' ? 'failed' : 'interrupted',
                  ...(run.deliveryOrigin ? { origin: run.deliveryOrigin } : {}),
                  reason: reason ? `${reason}；已显示的内容未核实，不视为最终交付。` : '工作未确认完成；已显示的内容未核实。',
                },
          );
        }
      }
    });
    this.timers.onTimerTaskSettled(
      { ...current, reason },
      status,
      {
        goalMet: goalMetSignal,
        goalSummary: goalMetSummary,
        notifyFirstFailure: !failureNotifiedInConversation,
      },
    );
    this.notifyOutbound();
    if (!run.controller.signal.aborted) run.controller.abort(new Error('Task settled'));
    for (const id of run.reads.keys()) this.executor?.stop(id);
    this.runs.delete(run.id);
    this.activeWorkerSlots.delete(run.id);
    this.pumpWorkerQueue();
  }

  private async prompt(
    run: Run,
    agent: AgentPort,
    input: string,
    turnInit?: Partial<RouterTurnScope>,
    onRouterComplete?: (scope: RouterTurnScope) => void,
  ): Promise<string> {
    const task = this.store.get(run.id);
    const router = agent === this.router;
    if (!router) {
      accrueTaskRun(this.store, run);
      run.activeCalls++;
    }
    const event = JSON.parse(input) as { kind?: string; report?: string };
    const routerTaskReply = event.kind === 'WORKER_REPORT' || event.kind === 'WORKER_QUESTION' || event.kind === 'WORKER_FAILED';
    const replyOrigin = run.deliveryOrigin ?? task.origin;
    if (router && task.originMessageId && routerTaskReply && !run.replyId) {
      const reply = this.store.conversation.create({
        id: randomUUID(),
        replyTo: task.originMessageId,
        role: 'assistant',
        ...(replyOrigin ? { origin: replyOrigin } : {}),
        text: '',
        status: 'streaming',
        mode: this.factory.mode,
        paths: [],
      });
      run.replyId = reply.id;
      this.store.conversation.link(reply.id, task.id);
      this.notifyOutbound();
    }

    const trace = new PromptTrace(
      this.store.conversation,
      { rootId: task.originMessageId ?? task.id, messageId: run.replyId ?? task.originMessageId, taskId: task.id, parentSpanId: task.id },
      router ? 'router' : 'worker',
      this.factory.mode,
      router ? run.replyId : undefined,
    );

    let turn: RouterTurnScope | undefined;
    let replyController: AbortController | undefined;
    if (router) {
      turn = createRouterTurnScope({ ...turnInit, routerTrace: trace });
      if (routerTaskReply) {
        replyController = new AbortController();
        run.replyController = replyController;
        turn.activeReportTask = task;
        const originMessage = task.originMessageId
          ? (() => { try { return this.store.conversation.get(task.originMessageId); } catch { return undefined; } })()
          : undefined;
        const syntheticMessage: ChatMessage = originMessage ?? {
          id: task.originMessageId ?? task.id,
          seq: 0,
          version: 1,
          at: task.createdAt,
          role: 'user',
          text: task.prompt,
          status: 'completed',
          mode: task.mode,
          paths: task.paths ?? [],
          taskIds: [task.id],
          ...(task.origin ? { origin: task.origin } : {}),
        };
        turn.reportChatContext = {
          message: syntheticMessage,
          ...(run.deliveryOrigin ? { deliveryOrigin: run.deliveryOrigin } : {}),
          controller: run.controller,
          revisions: new Map(this.store.list().map(item => [item.id, item.revision])),
          replyId: run.replyId,
          firstAt: Date.now(),
          coalesceUntil: 0,
          mergeVersion: 0,
        };
      }
    } else {
      run.trace = trace;
    }

    const runSignal = replyController ? AbortSignal.any([run.controller.signal, replyController.signal]) : run.controller.signal;
    try {
      const result = router && turn
        ? await this.turnStorage.run(turn, () => trace.run(agent, input, runSignal))
        : await trace.run(agent, input, runSignal);
      if (router && turn) {
        if (run.replyId) {
          try {
            const replyMsg = this.store.conversation.get(run.replyId);
            this.lastRouterChatSeq = Math.max(this.lastRouterChatSeq, replyMsg.seq);
          } catch { /* ignore if deleted */ }
        }
        this.checkpoint();
        onRouterComplete?.(turn);
      }
      return router ? this.publicText(result) : result;
    } finally {
      if (router) {
        if (run.replyController === replyController) run.replyController = undefined;
      } else {
        run.trace = undefined;
        accrueTaskRun(this.store, run);
        run.activeCalls--;
      }
    }
  }

  private tick() {
    if (this.activeChatContext) accrueChatRun(this.activeChatContext);
    for (const run of this.runs.values()) {
      if (run.stopping) continue;
      if (!accrueTaskRun(this.store, run, false)) {
        this.stop(run.id, '检测到时钟或心跳缺口，无法证明活跃用时；工作暂停', 'paused');
        continue;
      }
      const task = this.store.get(run.id);
      if (task.status === 'running' && task.activeMs + (run.pendingActiveMs ?? 0) >= task.limitMs) {
        accrueTaskRun(this.store, run, true);
        this.stop(task.id, '已达到活跃执行时限；工作暂停。需要继续时请重新提供输入', 'paused');
      }
    }
    this.timers.tick();
    this.pluginRefresh.tick();
    this.subconscious.tickDistiller();
    this.subconscious.tickSubconscious();
  }

  async close() {
    if (this.closingPromise) return this.closingPromise;
    this.closingPromise = (async () => {
      this.closing = true;
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      this.closingAbort.abort(new Error('Service shutdown'));
      this.semanticAbort.abort(new Error('Service shutdown'));
      this.subconscious.abortAll('Service shutdown');
      await this.im.close();
      for (const context of this.chatRuns.values()) {
        context.controller.abort(new Error('Service shutdown; reply interrupted without replay'));
      }
      for (const run of this.runs.values()) {
        this.stop(run.id, '服务关闭；工作暂停，不会自动重放', 'paused');
      }
      this.queuedWorkers.length = 0;
      this.drainRouterQueues(new Error('Service is shutting down'));
      await this.routerSwapPromise.catch(() => {});
      await Promise.allSettled([...this.submissions]);
      await this.subconscious.awaitSettled();
      await this.pluginRefresh.awaitSettled();
      if (this.executor) await this.executor.close();
      await Promise.allSettled([...this.jobs]);
      await Promise.allSettled([...this.chatJobs]);
      await this.modelHub.close();
      await this.semanticWarmup?.catch(() => {});
      this.outboundListeners.clear();
      this.router?.close();
      this.storeClosed = true;
      this.store.close();
      await Promise.resolve(this.semantic.close?.()).catch(() => {});
    })();
    return this.closingPromise;
  }
}

import type { DecisionSource, MissingAspect, QualityGateAssessment, ThinkingLevel } from './decision.js';
export type { DecisionSource, MissingAspect, QualityGateAssessment, ThinkingLevel };
export type {
  FlowCategory,
  FlowNodeKind,
  FlowTreeNode,
  FlowchartEdge,
  FlowchartEdgeKind,
  FlowchartEdgeTone,
  FlowchartFrame,
  FlowchartGraph,
  FlowchartNode,
  FlowchartShape,
  InspectorPayload,
  MindmapConsolidatedMemory,
  MindmapDeliveryItem,
  MindmapIngressOrigin,
  MindmapJevQualityGateItem,
  MindmapJevRouteInfo,
  MindmapRecalledItem,
  MindmapRouterToolCall,
  MindmapRouterTurn,
  MindmapSession,
  MindmapSessionLinkKind,
  MindmapSessionTurnSummary,
  MindmapSnapshot,
  MindmapTaskDetail,
  MindmapTaskFlow,
  MindmapTurnLink,
  MindmapWorkerPhase,
  MindmapWorkerStep,
  RouteActionSummary,
} from './mindmap-types.js';

export type MessageState = 'queued' | 'processing' | 'streaming' | 'completed' | 'interrupted' | 'failed';
export type RouteKind = 'new_work' | 'followup' | 'related_work' | 'inspect' | 'stop' | 'resume' | 'recall' | 'search_memory' | 'save_memory' | 'note' | 'diary' | 'timer' | 'plugin' | 'send_file' | 'switch_channel' | 'reply';
export type SessionLinkKind =
  | 'task_link'
  | 'msg_link'
  | 'switch_channel'
  | 'in_flight'
  | 'explicit_backref'
  | 'ai_context_synthesis'
  | 'answer_clarification'
  | 'post_task_discussion'
  | 'dialogue_followup'
  | 'topic_continuity'
  | 'rapid_exchange';

export interface SessionTurnLink {
  kind: SessionLinkKind;
  source: 'causal' | 'gemini-decision-1' | 'heuristic';
  gapSec: number;
  confidence?: number;
  label: string;
  detail?: string;
  evaluatedAt?: number;
  usage?: { inputTokens: number; totalTokens: number };
  fallbackReason?: string;
}
export type WorkerProfile = 'general' | 'coding' | 'research' | 'review';
export type ModelTier = 'fast' | 'balanced' | 'strong';
export interface ModelTierConfig {
  provider: string;
  router: string;
  fast: string;
  balanced: string;
  strong: string;
  available: string[];
}
export interface ModelCatalogEntry {
  id: string;
  name: string;
  supportsImages: boolean;
  reasoning: boolean;
  contextWindow: number;
  maxTokens?: number;
  costInput: number;
  costOutput: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  /** 模型自身支持的原生思考/推理等级列表 */
  thinkingLevels?: ThinkingLevel[];
}
export interface SelectedModelEntry {
  id: string;
  /** 可选指定保留的原生等级子集；留空表示保留该模型全部原生等级 */
  thinkingLevels?: ThinkingLevel[];
  /** 向后兼容旧配置文件字段（不再锁定单一自定义档位） */
  tier?: ModelTier;
}
export interface ModelProviderView {
  id: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  authType: 'oauth' | 'api_key' | 'environment' | 'none';
  keyHint?: string;
  baseUrl?: string;
  supportsOAuth: boolean;
  modelSource: 'remote_api' | 'sdk_catalog';
  modelsFetchedAt?: number;
  fetchError?: string;
  defaultFast?: string;
  defaultBalanced?: string;
  defaultStrong?: string;
  models: ModelCatalogEntry[];
  /** 用户显式勾选进入 Worker 模型池的模型（保留各自原生等级） */
  selectedModels?: SelectedModelEntry[];
  /** 按模型 ID 推断的建议等级（供控制台勾选时作为参考标签） */
  suggestedTiers?: Record<string, ModelTier>;
}
export interface ModelProbeResult {
  ok: boolean;
  provider: string;
  model: string;
  mode: 'real' | 'offline';
  latencyMs: number;
  supportsImages: boolean;
  contextWindow?: number;
  reply?: string;
  error?: string;
  testedAt: number;
}
export interface PooledModelEntry {
  spec: string;
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  tier: ModelTier;
  thinkingLevels: ThinkingLevel[];
  specialties: string[];
  supportsImages: boolean;
  reasoning: boolean;
  contextWindow: number;
  latencyMs?: number;
  successCount?: number;
  failCount?: number;
  avgQualityScore?: number;
}
export interface DecisionEngineView {
  model: string;
  enabled: boolean;
  configured: boolean;
  credentialSource: 'decision_config' | 'google_provider' | 'environment' | 'none';
  keyHint?: string;
  baseUrl?: string;
}
export interface ModelHubView {
  mode: 'real' | 'offline';
  routerProvider: string;
  routerModel: string;
  workerProvider: string;
  tiers: ModelTierConfig;
  providers: ModelProviderView[];
  modelPool?: PooledModelEntry[];
  decisionEngine?: DecisionEngineView;
  lastProbe?: ModelProbeResult;
}
export type SynapseRelation = 'explicit' | 'semantic' | 'co_activated' | 'shared_tag' | 'task_chain';
export interface MemorySynapse {
  targetId: string;
  targetTopic?: string;
  weight: number;
  relation: SynapseRelation;
  updatedAt: number;
}
export interface MemoryCard {
  id: string; topic: string; content: string; tags: string[];
  cwd?: string; sourceMessageId?: string; sourceTaskId?: string;
  supersededBy?: string; supersedes?: string;
  pinned?: boolean; accessCount?: number; lastAccessedAt?: number;
  lastReinforcedAt?: number; importance?: number; prePinImportance?: number; lastDecayedAt?: number;
  synapses?: MemorySynapse[];
  createdAt: number; updatedAt: number;
}
export interface MemoryDirectoryItem {
  id: string; topic: string; tags: string[]; cwd?: string; updatedAt: number; preview: string;
  pinned?: boolean; accessCount?: number; synapses?: MemorySynapse[];
}
export interface MemoryDirectory {
  totalActive: number; truncated: boolean; items: MemoryDirectoryItem[];
}
export interface ContextSearchHit {
  kind: 'memory' | 'work' | 'message';
  id: string; score: number; at: number;
  title: string; snippet: string; cwd?: string;
  memoryId?: string; taskId?: string; messageId?: string;
  parentTaskId?: string; originMessageId?: string;
  tags?: string[]; status?: string;
  synapses?: MemorySynapse[];
  activatedVia?: { memoryId: string; topic: string; weight: number; relation: SynapseRelation };
  neighbors?: Array<{ id: string; seq: number; role: 'user' | 'assistant'; preview: string }>;
  linkedTaskIds?: string[];
}
export interface RouteAction {
  id: string; kind: RouteKind; status: 'pending' | 'accepted' | 'failed' | 'interrupted'; at: number;
  taskId?: string; taskLabel?: string; parentTaskId?: string; summary?: string; error?: string;
  followupId?: string; delivery?: string; messageIds?: string[];
  memoryIds?: string[]; searchQuery?: string; workerProfile?: WorkerProfile; workerModel?: string; modelTier?: ModelTier;
  thinkingLevel?: ThinkingLevel; decisionSource?: DecisionSource;
}
export interface RoutingRecord {
  at: number; status: 'processing' | 'completed' | 'failed' | 'interrupted'; omittedActions?: number;
  context: { execution: 'native' | 'snapshot'; cwd: string; totalWorks: number; truncated: boolean;
    works: Array<{ id: string; prompt: string; status: string; revision: number }>;
    messages: Array<{ id: string; role: string; preview: string }>;
    memoryDirectory?: MemoryDirectory;
    autoRecalled?: ContextSearchHit[] };
  actions: RouteAction[];
}
export interface MessageOrigin {
  channel: 'local' | 'telegram' | 'wechat' | 'dingtalk' | 'xiaoai';
  channelId?: string; accountId?: string; conversationId?: string; senderId?: string;
  speakerId?: string; speakerName?: string; speakerRole?: 'owner' | 'member';
  replyToMessageId?: string; replyWebhook?: string; contextToken?: string;
  messageThreadId?: number;
  /** Correlates a flat Telegram response with its source without quoting it. */
  telegramFlatSourceId?: string;
}
export interface AttachmentView {
  kind: 'image' | 'file' | 'voice' | 'video';
  name: string;
  status: 'ready' | 'failed';
  path?: string;
  mimeType?: string;
  bytes?: number;
  error?: string;
  transcript?: string;
  durationSeconds?: number;
}
export interface ChatMessage {
  attachments?: AttachmentView[];
  origin?: MessageOrigin;
  sessionId?: string;
  sessionLink?: SessionTurnLink;
  seq: number; version: number; id: string; requestId?: string; role: 'user' | 'assistant'; text: string;
  status: MessageState; at: number; mode: 'real' | 'offline'; paths: string[];
  replyTo?: string; taskIds: string[]; reason?: string; source?: 'router' | 'system'; routing?: RoutingRecord;
}
export interface TraceContext { rootId: string; messageId?: string; taskId?: string; spanId?: string; parentSpanId?: string }
export interface TraceEvent extends TraceContext {
  seq: number; id: string; type: 'trace' | 'message'; kind: string;
  actor: 'user' | 'router' | 'worker' | 'executor' | 'system';
  label: string; status: string; at: number; data?: unknown;
}
export interface PendingQuestion {
  question: string;
  options?: string[];
  askedAt: number;
}
export interface MessagePage { items: ChatMessage[]; hasMore: boolean; before?: number }
export type InitiatorKind = 'person' | 'timer' | 'voice' | 'dream' | 'system';

export interface RunInitiator {
  kind: InitiatorKind;
  id?: string;
  label?: string;
}

export type TimerRunStatus = 'ok' | 'error' | 'goal_met' | 'fatigue_paused';

export interface WorkView {
  id: string; prompt: string; status: string; mode: 'real' | 'offline'; createdAt: number;
  activeMs: number; limitMs: number; reason?: string; sessionId?: string; originMessageId?: string; parentTaskId?: string;
  cwd?: string; concurrentTaskIds?: string[]; profile?: WorkerProfile; workerModel?: string; modelTier?: ModelTier;
  thinkingLevel?: ThinkingLevel; decisionSource?: DecisionSource; skipQualityGate?: boolean; qualityGate?: QualityGateAssessment;
  pendingQuestion?: PendingQuestion;
  initiator?: RunInitiator; timerId?: string;
}
export interface TimerView {
  id: string; name: string; instruction: string; intervalMs: number;
  dailyAt?: string; once?: boolean; plugin?: string; pluginAction?: string;
  deliverChannelId?: string; deliverTarget?: string;
  cwd?: string; enabled: boolean; createdAt: number;
  nextRunAt: number; lastRunAt?: number; activeTaskId?: string;
  pendingCatchup?: boolean; missedRuns: number;
  goalCondition?: string; goalMetAt?: number; goalSummary?: string;
  maxFailures?: number; consecutiveFailures?: number; fatiguePaused?: boolean;
  lastRunStatus?: TimerRunStatus; lastError?: string; firstFailureNotified?: boolean;
}
export type ImPlatform = 'telegram' | 'dingtalk' | 'wechat' | 'xiaoai';
export interface QuietHoursConfig {
  enabled: boolean;
  start: string;
  end: string;
}
export interface RejectedStrangerView {
  senderId: string;
  senderName?: string;
  lastText?: string;
  count: number;
  firstSeenAt: number;
  lastSeenAt: number;
}
export interface ImChannelView {
  id: string;
  platform: ImPlatform;
  name: string;
  enabled: boolean;
  notifyAll: boolean;
  hasBotToken: boolean;
  hasSecret: boolean;
  accountId?: string;
  loginStatus?: 'bound' | 'unbound';
  webhookUrlMasked?: string;
  defaultTarget?: string;
  allowedSenders: string[];
  telegramMentionExempt?: string[];
  apiBase?: string;
  cdnBaseUrl?: string;
  readLinks?: boolean;
  quietHours?: QuietHoursConfig;
  rejectedSenders?: RejectedStrangerView[];
  pollIntervalMs?: number;
  inboundCount: number;
  outboundCount: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}
export interface WechatQrLoginSession {
  sessionId: string;
  channelId: string;
  channelName: string;
  qrcode: string;
  qrcodeContent: string;
  qrSvgDataUrl: string;
  qrTerminal: string;
  status: 'wait' | 'scaned' | 'verify_code' | 'confirmed' | 'expired' | 'binded_redirect' | 'error';
  accountId?: string;
  userId?: string;
  error?: string;
  verifyRequired?: boolean;
  refreshCount?: number;
  alreadyConnected?: boolean;
  channel?: ImChannelView;
}
export interface TelegramQuickConnectView {
  ok: boolean;
  bot: {
    id: number;
    username?: string;
    firstName: string;
  };
  commandsRegistered: boolean;
  commandsError?: string;
  webhookCleared: boolean;
  channel: ImChannelView;
}
export interface TelegramSyncCommandsView {
  ok: boolean;
  count: number;
  channel: ImChannelView;
}
export type PluginRuntimeMode = 'subprocess' | 'in-process';

export interface PluginActionSpec {
  name: string;
  label?: string;
  description?: string;
  defaultArgs?: Record<string, unknown>;
}
export interface PluginView {
  name: string;
  title: string;
  description: string;
  entry: string;
  enabled?: boolean;
  platforms?: string[];
  isBuiltin?: boolean;
  runtime?: PluginRuntimeMode;
  promptHint?: string;
  voiceFastpath?: boolean;
  actions: string[];
  actionSpecs?: PluginActionSpec[];
  manifestJson?: string;
  /** @deprecated Host paths and source code are omitted from /api/view; kept optional until UI migration. */
  entryPath?: string;
  /** @deprecated Host paths are omitted from /api/view. */
  dir?: string;
  /** @deprecated Host paths are omitted from /api/view. */
  dataDir?: string;
  /** @deprecated Raw plugin source is omitted from /api/view. */
  sourceCode?: string;
}
export interface VoiceprintProfileView {
  id: string;
  name: string;
  role: 'owner' | 'member';
  dim: number;
  sampleCount: number;
  createdAt: number;
  updatedAt: number;
}
export interface VoiceprintStatusView {
  enabled: boolean;
  threshold: number;
  wakePrecheck: boolean;
  active: boolean;
  modelReady: boolean;
  profiles: VoiceprintProfileView[];
}
export type UsageGranularity = 'day' | 'week' | 'month';
export type UsageCurrency = 'CNY' | 'USD';
export type UsageActor = 'router' | 'worker' | 'decision' | 'distiller' | 'dreamer' | 'probe' | 'compaction';
export type UsageCostSource = 'provider' | 'catalog' | 'estimated' | 'free' | 'unknown';

export interface UsagePreferences {
  currency: UsageCurrency; // default 'CNY'
  usdToCnyRate: number;    // default 7.25
}

export interface UsageTotalsView {
  calls: number;
  successCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cacheHitRate: number;
  costUsd: number;
  costCny: number;
  cacheSavingsUsd: number;
  cacheSavingsCny: number;
}

export interface UsageTodaySummary {
  date: string; // YYYY-MM-DD
  calls: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
  costUsd: number;
  costCny: number;
  cacheSavingsUsd: number;
  cacheSavingsCny: number;
  currency: UsageCurrency;
  usdToCnyRate: number;
}

export interface UsageModelBreakdownView extends UsageTotalsView {
  spec: string;
  provider: string;
  model: string;
  tokenShare: number;
  costShare: number;
  unitInputUsdPer1M: number;
  unitOutputUsdPer1M: number;
  unitCacheReadUsdPer1M: number;
  unitCacheWriteUsdPer1M: number;
  costSource: UsageCostSource;
  actors: Partial<Record<UsageActor, number>>;
  lastUsedAt: number;
}

export interface UsageBucketView {
  key: string;
  label: string;
  startAt: number;
  endAt: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  costCny: number;
}

export interface UsagePeriodSummaryView {
  key: string;
  anchorDate: string;
  label: string;
  isCurrent: boolean;
  calls: number;
  totalTokens: number;
  costUsd: number;
  costCny: number;
}

export interface UsageReportView {
  granularity: UsageGranularity;
  anchorDate: string;
  periodLabel: string;
  prevAnchorDate: string;
  nextAnchorDate: string;
  todayDate: string;
  startAt: number;
  endAt: number;
  tzOffsetMin: number;
  prefs: UsagePreferences;
  totals: UsageTotalsView;
  byModel: UsageModelBreakdownView[];
  byActor: Partial<Record<UsageActor, UsageTotalsView>>;
  buckets: UsageBucketView[];
  recentPeriods: UsagePeriodSummaryView[];
}

export type SubconsciousPhase = 'awake' | 'nrem' | 'rem';

export interface SubconsciousStatusView {
  sleeping: boolean;
  phase: SubconsciousPhase;
  startedAt?: number;
  idleMs: number;
  lastWakeAt: number;
}

export interface VoiceListeningView {
  active: boolean;
  capturing: boolean;
  transcribing: boolean;
  keyword?: string;
  followUp?: boolean;
  updatedAt: number;
}

export type NoteAuthor = 'friday' | 'user';
export type DiarySource = 'chat' | 'evening' | 'sleep';
export type DiaryMood =
  | 'neutral'
  | 'happy'
  | 'calm'
  | 'surprised'
  | 'inspecting'
  | 'squinted'
  | 'sleepy'
  | 'confused'
  | 'sad';

export interface NoteItem {
  id: string;
  title: string;
  content: string;
  tags: string[];
  pinned: boolean;
  author: NoteAuthor;
  updatedBy: NoteAuthor;
  sourceMessageId?: string;
  promotedMemoryId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface NoteTagCount {
  tag: string;
  count: number;
}

export interface DiaryEntry {
  id: string;
  date: string;
  title: string;
  content: string;
  mood: DiaryMood;
  tags: string[];
  source: DiarySource;
  sourceMessageId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface NotebookSummaryView {
  noteCount: number;
  pinnedNoteCount: number;
  diaryCount: number;
  latestNoteUpdatedAt: number | null;
  latestDiaryDate: string | null;
  latestDiaryUpdatedAt: number | null;
}

export interface MainView {
  mode: 'real' | 'offline'; health: { status: string; executorAvailable: boolean };
  messages: MessagePage; works: WorkView[]; cursor: number;
  memoryDirectory?: MemoryDirectory;
  notebookSummary?: NotebookSummaryView;
  modelTiers?: ModelTierConfig;
  modelHub?: ModelHubView;
  timers?: TimerView[];
  plugins?: PluginView[];
  imChannels?: ImChannelView[];
  voiceprint?: VoiceprintStatusView;
  usageToday?: UsageTodaySummary;
  subconscious?: SubconsciousStatusView;
  voiceListening?: VoiceListeningView;
}

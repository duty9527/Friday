export type MessageState = 'queued' | 'processing' | 'streaming' | 'completed' | 'interrupted' | 'failed';
export type RouteKind = 'new_work' | 'followup' | 'related_work' | 'inspect' | 'stop' | 'resume' | 'recall' | 'search_memory' | 'save_memory' | 'timer' | 'plugin' | 'send_file' | 'switch_channel' | 'reply';
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
  /** 用户显式勾选进入 Worker 模型池的模型及等级 */
  selectedModels?: Array<{ id: string; tier: ModelTier }>;
  /** 按模型 ID 推断的建议等级（供控制台勾选时作为默认值） */
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
  specialties: string[];
  supportsImages: boolean;
  reasoning: boolean;
  contextWindow: number;
  latencyMs?: number;
  successCount?: number;
  failCount?: number;
}
export interface ModelHubView {
  mode: 'real' | 'offline';
  routerProvider: string;
  routerModel: string;
  workerProvider: string;
  tiers: ModelTierConfig;
  providers: ModelProviderView[];
  modelPool?: PooledModelEntry[];
  lastProbe?: ModelProbeResult;
}
export type SynapseRelation = 'explicit' | 'co_activated' | 'shared_tag' | 'task_chain';
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
  channel: 'local' | 'telegram' | 'wechat' | 'dingtalk';
  channelId?: string; accountId?: string; conversationId?: string; senderId?: string;
  replyToMessageId?: string; replyWebhook?: string; contextToken?: string;
}
export interface ChatMessage {
  attachments?: import('./wechat-inbound.js').ReceivedAttachment[];
  origin?: MessageOrigin;
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
export interface WorkView {
  id: string; prompt: string; status: string; mode: 'real' | 'offline'; createdAt: number;
  activeMs: number; limitMs: number; reason?: string; originMessageId?: string; parentTaskId?: string;
  cwd?: string; concurrentTaskIds?: string[]; profile?: WorkerProfile; workerModel?: string; modelTier?: ModelTier;
  pendingQuestion?: PendingQuestion;
}
export interface TimerView {
  id: string; name: string; instruction: string; intervalMs: number;
  dailyAt?: string; once?: boolean; plugin?: string; pluginAction?: string;
  deliverChannelId?: string; deliverTarget?: string;
  cwd?: string; enabled: boolean; createdAt: number;
  nextRunAt: number; lastRunAt?: number; activeTaskId?: string;
  pendingCatchup?: boolean; missedRuns: number;
}
export type ImPlatform = 'telegram' | 'dingtalk' | 'wechat';
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
  apiBase?: string;
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
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'error';
  accountId?: string;
  userId?: string;
  error?: string;
  channel?: ImChannelView;
}
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
  entryPath: string;
  dir: string;
  dataDir: string;
  actions: string[];
  actionSpecs?: PluginActionSpec[];
  manifestJson?: string;
  sourceCode?: string;
}
export interface MainView {
  mode: 'real' | 'offline'; health: { status: string; executorAvailable: boolean };
  messages: MessagePage; works: WorkView[]; cursor: number;
  memoryDirectory?: MemoryDirectory;
  modelTiers?: ModelTierConfig;
  modelHub?: ModelHubView;
  timers?: TimerView[];
  plugins?: PluginView[];
  imChannels?: ImChannelView[];
}

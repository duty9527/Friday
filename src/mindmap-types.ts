/**
 * Pure mindmap & flowchart DTO interfaces shared across Node backend (`mindmap-flow.ts`),
 * view contracts (`view.ts`), and browser ESM modules (`src/web/mindmap*.ts`).
 *
 * Keep this file 100% type-only with zero runtime imports so browser bundles never
 * pull in Node modules or extra runtime script fetches.
 */

export type FlowCategory =
  | 'core'
  | 'ingress'
  | 'memory'
  | 'router'
  | 'jev'
  | 'worker'
  | 'quality'
  | 'im';

export type FlowNodeKind =
  | 'hub'
  | 'flow_root'
  | 'ingress'
  | 'memory_group'
  | 'memory_item'
  | 'router_turn'
  | 'router_tool'
  | 'direct_plugin'
  | 'task_root'
  | 'jev_route'
  | 'jev_route_req'
  | 'jev_route_res'
  | 'worker_exec'
  | 'worker_step'
  | 'jev_quality'
  | 'jev_quality_req'
  | 'jev_quality_res'
  | 'memory_consolidate'
  | 'im_delivery'
  | 'reply_item';

export interface MindmapRecalledItem {
  kind: 'memory' | 'work' | 'message';
  id: string;
  title: string;
  score: number;
  snippet: string;
  tags?: string[];
  cwd?: string;
  activatedVia?: { memoryId: string; topic: string; weight: number; relation: string };
}

export interface MindmapRouterToolCall {
  spanId: string;
  toolName: string;
  status: string;
  at: number;
  durationMs?: number;
  inputPreview?: string;
  outputPreview?: string;
}

export interface MindmapRouterTurn {
  spanId: string;
  triggerKind: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: string;
  llmTurns: number;
  usage?: { input: number; output: number; cacheRead: number; reasoning: number; totalTokens: number };
  outputPreview?: string;
  tools: MindmapRouterToolCall[];
}

export interface MindmapJevRouteInfo {
  called: boolean;
  source: 'gemini-decision-1' | 'heuristic' | 'tier-config';
  status: 'completed' | 'fallback' | 'static';
  at?: number;
  request: {
    endpoint: string;
    decisionModel: string;
    profile: string;
    preferredTier?: string;
    preferredLevel?: string;
    fileCount: number;
    hasImages: boolean;
    isTimer: boolean;
    candidateCount?: number;
    excludedSpecs?: string[];
    excludedProviders?: string[];
    instructionPreview: string;
  };
  response: {
    selectedModel?: string;
    modelTier?: string;
    thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | (string & {});
    confidence?: number;
    needsQualityGate?: boolean;
    needsQualityGateProb?: number;
    usage?: { inputTokens: number; totalTokens: number };
    fallbackReason?: string;
  };
}

export interface MindmapJevQualityGateItem {
  index: number;
  at: number;
  source: 'gemini-decision-1' | 'heuristic';
  status: 'completed' | 'fallback' | 'skipped';
  request: {
    endpoint: string;
    decisionModel: string;
    profile: string;
    succeededOps: number;
    failedOps: number;
    followupCount: number;
    reportLength: number;
    skipRemote: boolean;
  };
  response: {
    score: number;
    maxScore: number;
    confidence: number;
    supplementProbability: number;
    shouldSupplement: boolean;
    missingAspect:
      | 'none'
      | 'incomplete_requirements'
      | 'missing_verification'
      | 'unresolved_error'
      | 'superficial_analysis'
      | (string & {});
    skippedByRoute?: boolean;
    usage?: { inputTokens: number; totalTokens: number };
    fallbackReason?: string;
  };
}

export interface MindmapWorkerStep {
  id: string;
  kind: 'llm_turn' | 'tool_call' | 'ask_boss' | 'followup';
  at: number;
  durationMs?: number;
  status: string;
  title: string;
  phaseIndex?: number;
  toolName?: string;
  operationId?: string;
  inputPreview?: string;
  outputPreview?: string;
  hasFullOperation?: boolean;
  usage?: { input: number; output: number; cacheRead: number; reasoning: number; totalTokens: number };
  stopReason?: string;
}

export interface MindmapWorkerPhase {
  index: number;
  spanId?: string;
  isFollowup: boolean;
  followupPrompt?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  status: string;
  llmCount: number;
  toolCount: number;
  qualityGateIndex?: number;
  routerReportSpanId?: string;
}

export interface MindmapTaskDetail {
  id: string;
  parentTaskId?: string;
  prompt: string;
  promptTruncated?: boolean;
  status: string;
  reason?: string;
  profile?: 'general' | 'coding' | 'research' | 'review' | (string & {});
  execution?: 'native' | 'snapshot';
  cwd?: string;
  createdAt: number;
  activeMs: number;
  limitMs: number;
  contextBrief?: string;
  compiledMemories: Array<{ id: string; topic: string; tags: string[]; preview: string }>;
  jevRoute?: MindmapJevRouteInfo;
  executionPhases: MindmapWorkerPhase[];
  workerSteps: MindmapWorkerStep[];
  totalSteps: number;
  omittedSteps: number;
  succeededOps: number;
  failedOps: number;
  jevQualityGates: MindmapJevQualityGateItem[];
  reportPreview?: string;
  reportTruncated?: boolean;
}

export interface MindmapConsolidatedMemory {
  id: string;
  topic: string;
  tags: string[];
  pinned: boolean;
  autoConsolidated: boolean;
  contentPreview: string;
  synapseCount: number;
  createdAt: number;
}

export interface MindmapDeliveryItem {
  messageId: string;
  seq: number;
  at: number;
  roleLabel: string;
  status: string;
  text: string;
  textTruncated?: boolean;
  reason?: string;
  source?: string;
}

export interface RouteActionSummary {
  id: string;
  kind: string;
  status: string;
  at: number;
  taskId?: string;
  taskLabel?: string;
  parentTaskId?: string;
  summary?: string;
  error?: string;
  followupId?: string;
  delivery?: string;
  messageIds?: string[];
  memoryIds?: string[];
  searchQuery?: string;
  workerProfile?: string;
  workerModel?: string;
  modelTier?: string;
  thinkingLevel?: string;
  decisionSource?: string;
}

export type MindmapSessionLinkKind =
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

export interface MindmapTurnLink {
  kind: MindmapSessionLinkKind;
  source: 'causal' | 'gemini-decision-1' | 'heuristic';
  gapSec: number;
  confidence?: number;
  label: string;
  detail?: string;
  evaluatedAt?: number;
  usage?: { inputTokens: number; totalTokens: number };
  fallbackReason?: string;
}

export interface MindmapSessionTurnSummary {
  flowId: string;
  seq: number;
  at: number;
  sourceKind: MindmapTaskFlow['ingress']['sourceKind'];
  channelLabel: string;
  textPreview: string;
  status: MindmapTaskFlow['status'];
  taskIds: string[];
  link?: MindmapTurnLink;
}

export interface MindmapSession {
  id: string;
  title: string;
  kind: 'human' | 'timer' | 'standalone';
  status: MindmapTaskFlow['status'];
  startedAt: number;
  updatedAt: number;
  channels: Array<'wechat' | 'telegram' | 'dingtalk' | 'xiaoai' | 'local' | 'timer' | 'standalone'>;
  primaryChannelLabel: string;
  turnCount: number;
  taskCount: number;
  jevCallCount: number;
  recalledMemoryCount: number;
  consolidatedMemoryCount: number;
  aiManagedContext: boolean;
  turnFlowIds: string[];
  turnSummaries: MindmapSessionTurnSummary[];
}

export interface MindmapIngressOrigin {
  channel: 'local' | 'telegram' | 'wechat' | 'dingtalk' | 'xiaoai' | (string & {});
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  senderId?: string;
  speakerId?: string;
  speakerName?: string;
  replyToMessageId?: string;
}

export interface MindmapTaskFlow {
  id: string;
  seq: number;
  createdAt: number;
  completedAt?: number;
  status: 'queued' | 'processing' | 'streaming' | 'running' | 'completed' | 'failed' | 'paused' | 'interrupted';
  sessionId?: string;
  sessionPersisted?: boolean;
  turnIndex?: number;
  turnCount?: number;
  sessionLink?: MindmapTurnLink;
  ingress: {
    sourceKind: 'wechat' | 'telegram' | 'dingtalk' | 'xiaoai' | 'local' | 'timer' | 'standalone';
    channelLabel: string;
    origin?: MindmapIngressOrigin;
    messageId?: string;
    text: string;
    textTruncated?: boolean;
    attachments: Array<{ kind: string; name: string; status: string; path?: string; mimeType?: string; error?: string }>;
    paths: string[];
    timerInfo?: {
      id: string;
      name: string;
      plugin?: string;
      pluginAction?: string;
      dailyAt?: string;
      intervalMs: number;
      once?: boolean;
    };
  };
  memoryRecall: {
    directoryTotal?: number;
    visibleWorksCount?: number;
    executionMode?: 'native' | 'snapshot';
    cwd?: string;
    recalledItems: MindmapRecalledItem[];
  };
  routerTurns: MindmapRouterTurn[];
  routeActions: RouteActionSummary[];
  directPlugin?: { timerName: string; plugin: string; pluginAction: string };
  tasks: MindmapTaskDetail[];
  consolidatedMemories: MindmapConsolidatedMemory[];
  deliveries: MindmapDeliveryItem[];
  imPush: {
    channel: 'wechat' | 'telegram' | 'dingtalk' | 'xiaoai' | 'local';
    channelName: string;
    target?: string;
    delivered: boolean;
    deliveryCount: number;
    sentFiles: Array<{ name: string; target?: string; at: number }>;
  };
}

export interface MindmapSnapshot {
  generatedAt: number;
  cursor: number;
  mode: 'real' | 'offline';
  hasMore: boolean;
  beforeSeq?: number;
  summary: {
    totalFlows: number;
    loadedFlows: number;
    totalSessions: number;
    multiTurnSessions: number;
    wechatFlows: number;
    localFlows: number;
    timerFlows: number;
    totalTasks: number;
    jevCalls: number;
    totalMemories: number;
    routerProvider: string;
    routerModel: string;
    decisionModel: string;
    decisionEnabled: boolean;
    decisionConfigured: boolean;
  };
  sessions: MindmapSession[];
  flows: MindmapTaskFlow[];
}

export interface InspectorPayload {
  flow: MindmapTaskFlow | null;
  snapshot?: MindmapSnapshot;
  session?: MindmapSession;
  phase?: MindmapWorkerPhase;
  memoryItem?: MindmapRecalledItem;
  routerTurn?: MindmapRouterTurn;
  routerTool?: MindmapRouterToolCall;
  task?: MindmapTaskDetail;
  jevRoute?: MindmapJevRouteInfo;
  workerStep?: MindmapWorkerStep;
  jevQuality?: MindmapJevQualityGateItem;
  delivery?: MindmapDeliveryItem;
  consolidatedMemory?: MindmapConsolidatedMemory;
}

export interface FlowTreeNode {
  id: string;
  flowId?: string;
  kind: FlowNodeKind;
  category: FlowCategory;
  icon: string;
  badge: string;
  title: string;
  subtitle: string;
  metric?: string;
  status?: string;
  defaultCollapsed?: boolean;
  inspector: InspectorPayload;
  children: FlowTreeNode[];
}

export type FlowchartShape = 'pill' | 'process' | 'decision' | 'subprocess' | 'io';
export type FlowchartEdgeKind = 'spine' | 'branch' | 'loopback' | 'session_bridge';
export type FlowchartEdgeTone = 'default' | 'accent' | 'warn' | 'success';

export interface FlowchartNode {
  id: string;
  flowId: string;
  sessionId?: string;
  kind: FlowNodeKind | 'session_summary' | 'worker_phase' | 'worker_more';
  category: FlowCategory;
  shape: FlowchartShape;
  icon: string;
  badge: string;
  title: string;
  subtitle: string;
  metric?: string;
  status?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  searchText: string;
  match?: boolean;
  toggleKey?: string;
  collapsed?: boolean;
  hiddenCount?: number;
  inspector: InspectorPayload;
}

export interface FlowchartEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: FlowchartEdgeKind;
  tone: FlowchartEdgeTone;
  points: Array<{ x: number; y: number }>;
  label?: string;
  labelX?: number;
  labelY?: number;
}

export interface FlowchartFrame {
  id: string;
  sessionId: string;
  flowId?: string;
  turnIndex?: number;
  turnCount?: number;
  title: string;
  subtitle: string;
  badge: string;
  status: string;
  x: number;
  y: number;
  w: number;
  h: number;
  collapsed?: boolean;
  toggleKey?: string;
}

export interface FlowchartGraph {
  mode: 'session' | 'overview';
  width: number;
  height: number;
  frames: FlowchartFrame[];
  nodes: FlowchartNode[];
  edges: FlowchartEdge[];
}

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
    thinkingLevel?: string;
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
    missingAspect: string;
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
  profile?: string;
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
  summary?: string;
  error?: string;
  searchQuery?: string;
  workerProfile?: string;
  workerModel?: string;
  modelTier?: string;
  thinkingLevel?: string;
  decisionSource?: string;
  memoryIds?: string[];
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
    origin?: {
      channel: string;
      channelId?: string;
      accountId?: string;
      conversationId?: string;
      senderId?: string;
      replyToMessageId?: string;
    };
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
  sessions?: MindmapSession[];
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

export function shortText(raw: string | undefined, max = 38): string {
  if (!raw) return '（空）';
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

export function formatTimeShort(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

export function sourceIcon(kind: MindmapTaskFlow['ingress']['sourceKind']): string {
  switch (kind) {
    case 'wechat': return '💬';
    case 'telegram': return '✈️';
    case 'dingtalk': return '🔔';
    case 'xiaoai': return '🔊';
    case 'timer': return '⏱️';
    case 'standalone': return '⚡';
    default: return '🖥️';
  }
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    completed: '已完成',
    succeeded: '成功',
    accepted: '已受理',
    running: '执行中',
    processing: '推理中',
    streaming: '输出中',
    queued: '排队中',
    paused: '已暂停',
    failed: '失败',
    interrupted: '已中断',
    fallback: '规则回退',
    static: '静态配置',
    skipped: 'JEV免检',
    done: '已送达',
    pending: '待执行',
    waiting_decision: '待老板拍板',
    decision_received: '已获拍板',
  };
  return map[status] ?? status;
}

const TRIGGER_LABELS: Record<string, string> = {
  CHAT: '首次接单分析 (CHAT)',
  WORKER_REPORT: 'Worker 报告验收 (WORKER_REPORT)',
  WORKER_QUESTION: '转达请示拍板 (WORKER_QUESTION)',
  WORKER_FAILED: 'Worker 失败兜底 (WORKER_FAILED)',
  NEW_TASK: '独立任务调度 (NEW_TASK)',
};

function buildTaskBranchNodes(flow: MindmapTaskFlow, task: MindmapTaskDetail, index: number, detailedDefault: boolean): FlowTreeNode {
  const shortModel = shortText(task.jevRoute?.response.selectedModel ?? '默认模型', 26);
  const levelTag = task.jevRoute?.response.thinkingLevel ? `@${task.jevRoute.response.thinkingLevel}` : '';
  const profileTag = task.profile ? `[${task.profile}] ` : '';

  const taskChildren: FlowTreeNode[] = [];

  // 4. JEV 选模调用与响应
  if (task.jevRoute) {
    const jr = task.jevRoute;
    const isJev = jr.source === 'gemini-decision-1';
    const jevReqNode: FlowTreeNode = {
      id: `${flow.id}:t:${task.id}:jev-req`,
      flowId: flow.id,
      kind: 'jev_route_req',
      category: 'jev',
      icon: '📤',
      badge: '怎么调用的 JEV',
      title: jr.called ? `POST ${jr.request.endpoint}` : '未调用 JEV 远端选模',
      subtitle: `${jr.request.profile} · 图:${jr.request.hasImages ? '是' : '否'} · 候选:${jr.request.candidateCount ?? '池全量'}`,
      metric: jr.request.decisionModel,
      status: jr.status,
      inspector: { flow, task, jevRoute: jr },
      children: [],
    };
    const jevResNode: FlowTreeNode = {
      id: `${flow.id}:t:${task.id}:jev-res`,
      flowId: flow.id,
      kind: 'jev_route_res',
      category: 'jev',
      icon: '📥',
      badge: 'JEV 响应结果',
      title: `${shortModel}${levelTag}`,
      subtitle: jr.response.confidence !== undefined
        ? `置信 ${(jr.response.confidence * 100).toFixed(1)}% · 质检:${jr.response.needsQualityGate === false ? '跳过' : '开启'}`
        : `来源: ${jr.source} · ${jr.response.fallbackReason ?? '已选定'}`,
      metric: jr.response.usage ? `${jr.response.usage.totalTokens} tok` : undefined,
      status: jr.status,
      inspector: { flow, task, jevRoute: jr },
      children: [],
    };
    taskChildren.push({
      id: `${flow.id}:t:${task.id}:jev`,
      flowId: flow.id,
      kind: 'jev_route',
      category: 'jev',
      icon: '🎯',
      badge: isJev ? 'JEV 选模定级' : jr.source === 'heuristic' ? '规则回退选模' : '静态模型配置',
      title: `${shortModel}${levelTag}`,
      subtitle: jr.called
        ? `置信 ${jr.response.confidence !== undefined ? `${(jr.response.confidence * 100).toFixed(1)}%` : '—'} · 质检:${jr.response.needsQualityGate === false ? '免检' : '启用'}`
        : '早期静态档位/人工指定模型',
      metric: isJev ? 'gemini-decision-1' : jr.source,
      status: jr.status,
      defaultCollapsed: !detailedDefault,
      inspector: { flow, task, jevRoute: jr },
      children: [jevReqNode, jevResNode],
    });
  }

  // 5. Worker 执行与逐步操作
  const stepChildren: FlowTreeNode[] = task.workerSteps.map(step => {
    const icon = step.kind === 'llm_turn' ? '💭'
      : step.kind === 'ask_boss' ? '🙋'
        : step.kind === 'followup' ? '➕'
          : '🔧';
    const sub = step.kind === 'llm_turn'
      ? `${step.usage ? `${step.usage.totalTokens} tok` : '推理完成'}${step.stopReason ? ` · ${step.stopReason}` : ''}`
      : step.kind === 'tool_call'
        ? shortText(step.inputPreview || step.outputPreview || '无参数', 36)
        : shortText(step.inputPreview || step.outputPreview, 36);
    return {
      id: `${flow.id}:t:${task.id}:step:${step.id}`,
      flowId: flow.id,
      kind: 'worker_step',
      category: 'worker',
      icon,
      badge: step.kind === 'llm_turn' ? '模型推理' : step.toolName ?? step.kind,
      title: shortText(step.title, 28),
      subtitle: sub,
      metric: step.durationMs ? formatDuration(step.durationMs) : statusLabel(step.status),
      status: step.status,
      inspector: { flow, task, workerStep: step },
      children: [],
    };
  });

  taskChildren.push({
    id: `${flow.id}:t:${task.id}:exec`,
    flowId: flow.id,
    kind: 'worker_exec',
    category: 'worker',
    icon: '⚙️',
    badge: `${profileTag}Worker 执行`,
    title: `${task.execution === 'native' ? '本机工具执行' : '只读快照'} · ${formatDuration(task.activeMs)}`,
    subtitle: `成功操作 ${task.succeededOps} · 失败 ${task.failedOps}${task.omittedSteps ? ` · 省略早期 ${task.omittedSteps} 步` : ''}`,
    metric: `${task.totalSteps} 步`,
    status: task.status,
    defaultCollapsed: !detailedDefault || stepChildren.length > 8,
    inspector: { flow, task },
    children: stepChildren,
  });

  // 6. JEV 完成度质检（支持多次）
  for (const qg of task.jevQualityGates) {
    const qReqNode: FlowTreeNode = {
      id: `${flow.id}:t:${task.id}:qg:${qg.index}:req`,
      flowId: flow.id,
      kind: 'jev_quality_req',
      category: 'quality',
      icon: '📤',
      badge: '怎么调的质检',
      title: qg.request.skipRemote ? '选模预判免检 (skipRemote)' : `POST ${qg.request.endpoint}`,
      subtitle: `成功操作 ${qg.request.succeededOps} · 失败 ${qg.request.failedOps} · 报告 ${qg.request.reportLength} 字`,
      metric: qg.request.decisionModel,
      status: qg.status,
      inspector: { flow, task, jevQuality: qg },
      children: [],
    };
    const qResNode: FlowTreeNode = {
      id: `${flow.id}:t:${task.id}:qg:${qg.index}:res`,
      flowId: flow.id,
      kind: 'jev_quality_res',
      category: 'quality',
      icon: qg.response.shouldSupplement ? '🔁' : '✅',
      badge: 'JEV 质检响应',
      title: `得分 ${qg.response.score.toFixed(2)}/${qg.response.maxScore} · ${qg.response.shouldSupplement ? '建议打回补查' : '通过交付'}`,
      subtitle: `补充概率 ${(qg.response.supplementProbability * 100).toFixed(1)}% · 缺陷: ${qg.response.missingAspect}`,
      metric: qg.response.usage ? `${qg.response.usage.totalTokens} tok` : undefined,
      status: qg.status,
      inspector: { flow, task, jevQuality: qg },
      children: [],
    };
    taskChildren.push({
      id: `${flow.id}:t:${task.id}:qg:${qg.index}`,
      flowId: flow.id,
      kind: 'jev_quality',
      category: 'quality',
      icon: '⚖️',
      badge: `JEV 质检 #${qg.index}`,
      title: qg.status === 'skipped'
        ? '简单任务免检直通'
        : `${qg.response.score.toFixed(2)} / ${qg.response.maxScore} · ${qg.response.shouldSupplement ? '打回补查' : '质检通过'}`,
      subtitle: `置信 ${(qg.response.confidence * 100).toFixed(0)}% · 补充概率 ${(qg.response.supplementProbability * 100).toFixed(1)}%`,
      metric: qg.source,
      status: qg.status,
      defaultCollapsed: !detailedDefault,
      inspector: { flow, task, jevQuality: qg },
      children: [qReqNode, qResNode],
    });
  }

  return {
    id: `${flow.id}:t:${task.id}`,
    flowId: flow.id,
    kind: 'task_root',
    category: 'worker',
    icon: task.parentTaskId ? '🔗' : '🤖',
    badge: task.parentTaskId ? `接力子任务 #${index + 1}` : `后台任务 #${index + 1}`,
    title: shortText(task.prompt, 32),
    subtitle: `${shortModel}${levelTag} · ${statusLabel(task.status)} · ${formatDuration(task.activeMs)}`,
    metric: `${task.succeededOps + task.failedOps} 工具`,
    status: task.status,
    defaultCollapsed: !detailedDefault,
    inspector: { flow, task },
    children: taskChildren,
  };
}

export function buildTaskFlowSubtree(flow: MindmapTaskFlow, detailedDefault: boolean): FlowTreeNode[] {
  const nodes: FlowTreeNode[] = [];

  // 1. 接入来源 & 老板原话
  nodes.push({
    id: `${flow.id}:ingress`,
    flowId: flow.id,
    kind: 'ingress',
    category: 'ingress',
    icon: sourceIcon(flow.ingress.sourceKind),
    badge: '① 接入消息',
    title: flow.ingress.channelLabel,
    subtitle: shortText(flow.ingress.text, 34),
    metric: flow.ingress.attachments.length ? `附件 ${flow.ingress.attachments.length}` : formatTimeShort(flow.createdAt).slice(6),
    status: 'completed',
    inspector: { flow },
    children: [],
  });

  // 2. 记忆加载与联想分析
  const memoryChildren: FlowTreeNode[] = flow.memoryRecall.recalledItems.map((hit, idx) => ({
    id: `${flow.id}:mem:${idx}:${hit.id}`,
    flowId: flow.id,
    kind: 'memory_item',
    category: 'memory',
    icon: hit.activatedVia ? '⚡' : hit.kind === 'memory' ? '🗂️' : hit.kind === 'work' ? '📋' : '💬',
    badge: hit.activatedVia ? '突触扩散联想' : hit.kind === 'memory' ? '记忆卡片' : hit.kind === 'work' ? '历史工作' : '历史对话',
    title: shortText(hit.title, 30),
    subtitle: shortText(hit.snippet, 34),
    metric: `分 ${hit.score}`,
    status: 'completed',
    inspector: { flow, memoryItem: hit },
    children: [],
  }));

  nodes.push({
    id: `${flow.id}:memory`,
    flowId: flow.id,
    kind: 'memory_group',
    category: 'memory',
    icon: '🧠',
    badge: '② 记忆联想',
    title: flow.memoryRecall.recalledItems.length
      ? `闪回联想 ${flow.memoryRecall.recalledItems.length} 条相关记忆`
      : '未触发额外联想闪回',
    subtitle: flow.memoryRecall.directoryTotal !== undefined
      ? `L0目录 ${flow.memoryRecall.directoryTotal} 卡片 · 历史工作 ${flow.memoryRecall.visibleWorksCount ?? 0}`
      : (flow.directPlugin ? '定时脚本直跑（跳过会话联想）' : '使用主控当前连续记忆上下文'),
    metric: flow.memoryRecall.recalledItems.length ? `Top ${flow.memoryRecall.recalledItems[0]!.score}` : undefined,
    status: 'completed',
    defaultCollapsed: !detailedDefault,
    inspector: { flow },
    children: memoryChildren,
  });

  // 3. Router 分析决策 OR 定时插件直跑
  if (flow.directPlugin) {
    nodes.push({
      id: `${flow.id}:direct-plugin`,
      flowId: flow.id,
      kind: 'direct_plugin',
      category: 'router',
      icon: '🔌',
      badge: '③ 零Token插件直跑',
      title: `${flow.directPlugin.plugin} / ${flow.directPlugin.pluginAction}`,
      subtitle: `定时器「${flow.directPlugin.timerName}」直接执行，不消耗 LLM`,
      metric: '0 Token',
      status: flow.status,
      inspector: { flow },
      children: [],
    });
  } else if (flow.routerTurns.length > 0 || flow.routeActions.length > 0) {
    const turnNodes: FlowTreeNode[] = flow.routerTurns.map((turn, tIdx) => {
      const toolChildren: FlowTreeNode[] = turn.tools.map((tool, toolIdx) => ({
        id: `${flow.id}:rt:${tIdx}:tool:${toolIdx}`,
        flowId: flow.id,
        kind: 'router_tool',
        category: 'router',
        icon: tool.toolName === 'start_work' ? '🚀'
          : tool.toolName === 'continue_work' ? '🔁'
            : tool.toolName === 'save_memory' ? '💾'
              : tool.toolName === 'search_memory' ? '🔎'
                : tool.toolName === 'send_file' ? '📎'
                  : '🧭',
        badge: '主控动作',
        title: tool.toolName,
        subtitle: shortText(tool.inputPreview || tool.outputPreview || statusLabel(tool.status), 34),
        metric: tool.durationMs ? formatDuration(tool.durationMs) : statusLabel(tool.status),
        status: tool.status,
        inspector: { flow, routerTurn: turn, routerTool: tool },
        children: [],
      }));

      return {
        id: `${flow.id}:rt:${tIdx}`,
        flowId: flow.id,
        kind: 'router_turn',
        category: 'router',
        icon: '🎛️',
        badge: `③ 主控决策 #${tIdx + 1}`,
        title: TRIGGER_LABELS[turn.triggerKind] ?? turn.triggerKind,
        subtitle: `${turn.tools.length ? `调用 ${turn.tools.map(t => t.toolName).join(', ')}` : '直接形成回复'}${turn.usage ? ` · ${turn.usage.totalTokens} tok` : ''}`,
        metric: turn.durationMs ? formatDuration(turn.durationMs) : statusLabel(turn.status),
        status: turn.status,
        defaultCollapsed: !detailedDefault,
        inspector: { flow, routerTurn: turn },
        children: toolChildren,
      };
    });

    if (turnNodes.length === 0 && flow.routeActions.length > 0) {
      turnNodes.push({
        id: `${flow.id}:rt:actions`,
        flowId: flow.id,
        kind: 'router_turn',
        category: 'router',
        icon: '🎛️',
        badge: '③ 主控决策',
        title: flow.routeActions.map(a => a.kind).join(' → '),
        subtitle: shortText(flow.routeActions[0]?.summary || flow.routeActions[0]?.taskLabel || '路由受理', 34),
        status: flow.status,
        inspector: { flow },
        children: [],
      });
    }

    nodes.push(...turnNodes);
  }

  // 4~6. 关联的后台 Worker 任务（含 JEV 选模 + Worker 步进 + JEV 质检）
  flow.tasks.forEach((task, idx) => {
    nodes.push(buildTaskBranchNodes(flow, task, idx, detailedDefault));
  });

  // 7. 记忆沉淀
  if (flow.consolidatedMemories.length > 0) {
    nodes.push({
      id: `${flow.id}:consolidate`,
      flowId: flow.id,
      kind: 'memory_consolidate',
      category: 'memory',
      icon: '🧬',
      badge: '⑦ 海马体沉淀',
      title: `新沉淀 ${flow.consolidatedMemories.length} 张记忆卡片`,
      subtitle: shortText(flow.consolidatedMemories.map(m => m.topic).join(' · '), 34),
      metric: `${flow.consolidatedMemories[0]!.synapseCount} 突触`,
      status: 'completed',
      defaultCollapsed: !detailedDefault,
      inspector: { flow, consolidatedMemory: flow.consolidatedMemories[0] },
      children: flow.consolidatedMemories.length > 1
        ? flow.consolidatedMemories.map(mem => ({
            id: `${flow.id}:consolidate:${mem.id}`,
            flowId: flow.id,
            kind: 'memory_consolidate',
            category: 'memory',
            icon: mem.pinned ? '📌' : '🗂️',
            badge: mem.autoConsolidated ? '自动经验巩固' : '主动记忆保存',
            title: shortText(mem.topic, 30),
            subtitle: shortText(mem.contentPreview, 34),
            status: 'completed',
            inspector: { flow, consolidatedMemory: mem },
            children: [],
          }))
        : [],
    });
  }

  // 8. 最终响应与 IM 推送
  const deliveryChildren: FlowTreeNode[] = flow.deliveries.map((del, dIdx) => ({
    id: `${flow.id}:del:${dIdx}`,
    flowId: flow.id,
    kind: 'reply_item',
    category: 'im',
    icon: dIdx === flow.deliveries.length - 1 ? '📩' : '💬',
    badge: del.roleLabel,
    title: shortText(del.text || del.reason || '（无正文）', 30),
    subtitle: `${formatTimeShort(del.at)} · ${statusLabel(del.status)}`,
    status: del.status,
    inspector: { flow, delivery: del },
    children: [],
  }));

  nodes.push({
    id: `${flow.id}:im`,
    flowId: flow.id,
    kind: 'im_delivery',
    category: 'im',
    icon: flow.imPush.channel === 'wechat' ? '📲' : flow.imPush.channel === 'xiaoai' ? '🔊' : flow.imPush.channel === 'local' ? '💬' : '📡',
    badge: '⑧ 响应与IM推送',
    title: `${flow.imPush.channelName}${flow.imPush.sentFiles.length ? ` (+${flow.imPush.sentFiles.length}文件)` : ''}`,
    subtitle: flow.deliveries.length
      ? shortText(flow.deliveries.at(-1)!.text || flow.deliveries.at(-1)!.reason, 34)
      : (flow.imPush.delivered ? '已送达目标会话' : '等待生成公开回复'),
    metric: `${flow.deliveries.length} 条回复`,
    status: flow.imPush.delivered ? 'completed' : flow.status,
    defaultCollapsed: !detailedDefault && deliveryChildren.length <= 1,
    inspector: { flow, delivery: flow.deliveries.at(-1) },
    children: deliveryChildren,
  });

  return nodes;
}

export function buildAllTasksTree(snapshot: MindmapSnapshot, flows: MindmapTaskFlow[]): FlowTreeNode {
  const children: FlowTreeNode[] = flows.map((flow, idx) => {
    const expandFlow = idx < 3; // 默认展开最新 3 条真实任务流的主干，其余点圆钮展开
    const stepSummaryParts: string[] = [];
    if (flow.memoryRecall.recalledItems.length) stepSummaryParts.push(`记忆${flow.memoryRecall.recalledItems.length}`);
    if (flow.tasks.length) {
      const firstTask = flow.tasks[0]!;
      const m = firstTask.jevRoute?.response.selectedModel;
      stepSummaryParts.push(m ? `JEV→${shortText(m.split('/').pop(), 16)}` : `任务${flow.tasks.length}`);
      const lastQ = firstTask.jevQualityGates.at(-1);
      if (lastQ && lastQ.status !== 'skipped') {
        stepSummaryParts.push(`质检${lastQ.response.score.toFixed(1)}/${lastQ.response.maxScore}`);
      }
    } else if (flow.directPlugin) {
      stepSummaryParts.push(`插件:${flow.directPlugin.plugin}`);
    } else {
      stepSummaryParts.push('主控直回');
    }
    stepSummaryParts.push(`→ ${flow.imPush.channel === 'wechat' ? '微信' : flow.imPush.channel === 'xiaoai' ? '小爱音箱' : flow.imPush.channel === 'local' ? 'Web' : flow.imPush.channel}`);

    return {
      id: flow.id,
      flowId: flow.id,
      kind: 'flow_root',
      category: flow.ingress.sourceKind === 'wechat' || flow.ingress.sourceKind === 'xiaoai' ? 'im'
        : flow.ingress.sourceKind === 'timer' ? 'router'
          : flow.tasks.length ? 'worker' : 'ingress',
      icon: sourceIcon(flow.ingress.sourceKind),
      badge: `#${flow.seq || '后台'} · ${flow.ingress.sourceKind === 'wechat' ? '微信消息' : flow.ingress.sourceKind === 'xiaoai' ? '小爱语音' : flow.ingress.sourceKind === 'timer' ? '定时触发' : '本地消息'}`,
      title: shortText(flow.ingress.text, 30),
      subtitle: stepSummaryParts.join(' · '),
      metric: formatTimeShort(flow.createdAt).slice(0, 11),
      status: flow.status,
      defaultCollapsed: !expandFlow,
      inspector: { flow, snapshot },
      children: buildTaskFlowSubtree(flow, false),
    };
  });

  return {
    id: 'all-flows-hub',
    kind: 'hub',
    category: 'core',
    icon: '🧠',
    badge: `实时总览 · ${snapshot.mode === 'real' ? 'LIVE' : 'OFFLINE'}`,
    title: `F.R.I.D.A.Y. 任务全流程 (${flows.length} 条)`,
    subtitle: `微信 ${snapshot.summary.wechatFlows} · 本地 ${snapshot.summary.localFlows} · 定时 ${snapshot.summary.timerFlows} · JEV ${snapshot.summary.jevCalls} 次`,
    metric: snapshot.summary.decisionConfigured ? 'gemini-decision-1 就绪' : snapshot.summary.decisionModel,
    status: 'completed',
    inspector: { flow: flows[0] ?? null, snapshot },
    children,
  };
}

export function buildSingleTaskTree(flow: MindmapTaskFlow, snapshot?: MindmapSnapshot): FlowTreeNode {
  return {
    id: `${flow.id}:single-root`,
    flowId: flow.id,
    kind: 'flow_root',
    category: 'core',
    icon: sourceIcon(flow.ingress.sourceKind),
    badge: `回合 #${flow.seq || '独立'} · ${flow.ingress.channelLabel}`,
    title: shortText(flow.ingress.text, 32),
    subtitle: `${formatTimeShort(flow.createdAt)} · 任务 ${flow.tasks.length} 个 · 联想 ${flow.memoryRecall.recalledItems.length} 条`,
    metric: statusLabel(flow.status),
    status: flow.status,
    inspector: { flow, snapshot },
    children: buildTaskFlowSubtree(flow, true),
  };
}

// ---------------- 真·流程图布局引擎 (Flowchart Layout Engine) ----------------

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

export function resolveSessionTurns(session: MindmapSession, flowsById: Map<string, MindmapTaskFlow>): MindmapTaskFlow[] {
  const turns: MindmapTaskFlow[] = [];
  for (const fid of session.turnFlowIds) {
    const found = flowsById.get(fid);
    if (found) turns.push(found);
  }
  return turns;
}

export function getEffectiveSessions(snapshot: MindmapSnapshot | null, loadedFlows: MindmapTaskFlow[]): MindmapSession[] {
  const flowsById = new Map(loadedFlows.map(f => [f.id, f]));
  const base = snapshot?.sessions ? [...snapshot.sessions] : [];
  const coveredFlowIds = new Set<string>();
  for (const s of base) {
    for (const fid of s.turnFlowIds) {
      if (flowsById.has(fid)) coveredFlowIds.add(fid);
    }
  }
  // Fallback for older flows loaded via "Load More" pagination that were not part of initial snapshot.sessions
  for (const flow of loadedFlows) {
    if (coveredFlowIds.has(flow.id)) continue;
    coveredFlowIds.add(flow.id);
    const jevCount = flow.tasks.reduce((sum, t) => sum + (t.jevRoute?.called ? 1 : 0) + t.jevQualityGates.length, 0);
    base.push({
      id: flow.sessionId ?? `session:${flow.id}`,
      title: shortText(flow.ingress.text, 34),
      kind: flow.ingress.sourceKind === 'timer' ? 'timer' : flow.ingress.sourceKind === 'standalone' ? 'standalone' : 'human',
      status: flow.status,
      startedAt: flow.createdAt,
      updatedAt: Math.max(flow.createdAt, flow.completedAt ?? 0, ...(flow.deliveries.map(d => d.at))),
      channels: [flow.ingress.sourceKind],
      primaryChannelLabel: flow.ingress.channelLabel,
      turnCount: 1,
      taskCount: flow.tasks.length,
      jevCallCount: jevCount,
      recalledMemoryCount: flow.memoryRecall.recalledItems.length,
      consolidatedMemoryCount: flow.consolidatedMemories.length,
      aiManagedContext: flow.memoryRecall.recalledItems.length > 0 || flow.tasks.some(t => Boolean(t.contextBrief)),
      turnFlowIds: [flow.id],
      turnSummaries: [{
        flowId: flow.id,
        seq: flow.seq,
        at: flow.createdAt,
        sourceKind: flow.ingress.sourceKind,
        channelLabel: flow.ingress.channelLabel,
        textPreview: shortText(flow.ingress.text, 120),
        status: flow.status,
        taskIds: flow.tasks.map(t => t.id),
      }],
    });
  }
  base.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.startedAt - a.startedAt));
  return base;
}

const FC_FRAME_X = 24;
const FC_FRAME_W = 1024;
const FC_HEADER_H = 52;
const FC_SPINE_X = 90;
const FC_SPINE_W = 306;
const FC_SPINE_CX = FC_SPINE_X + FC_SPINE_W / 2; // 243
const FC_SPINE_H = 74;
const FC_SIDE_TRUNK_X = 432;
const FC_SIDE1_X = 468;
const FC_SIDE_W = 258;
const FC_SIDE2_X = 758;
const FC_SIDE_H = 66;
const FC_LOOP_X = 46;
const FC_SIDE_ROW_GAP = 18;
const FC_SIDE_BUS_GAP = 22;

function nodeSearchBlob(badge: string, title: string, subtitle: string, extra?: string): string {
  return `${badge} ${title} ${subtitle} ${extra ?? ''}`.toLowerCase();
}

export function buildSessionFlowchart(
  session: MindmapSession,
  flowsById: Map<string, MindmapTaskFlow>,
  snapshot: MindmapSnapshot | null,
  collapseMap: Map<string, boolean>,
  searchTerm: string,
): FlowchartGraph {
  const turns = resolveSessionTurns(session, flowsById);
  const needle = searchTerm.trim().toLowerCase();
  const frames: FlowchartFrame[] = [];
  const nodes: FlowchartNode[] = [];
  const edges: FlowchartEdge[] = [];

  if (turns.length === 0) {
    return { mode: 'session', width: FC_FRAME_X * 2 + FC_FRAME_W, height: 220, frames, nodes, edges };
  }

  const pushNode = (raw: Omit<FlowchartNode, 'searchText' | 'match'>, extraSearch?: string): FlowchartNode => {
    const searchText = nodeSearchBlob(raw.badge, raw.title, raw.subtitle, `${raw.metric ?? ''} ${extraSearch ?? ''}`);
    const match = Boolean(needle) && searchText.includes(needle);
    const node: FlowchartNode = { ...raw, searchText, match };
    nodes.push(node);
    return node;
  };

  let globalY = 20;
  let prevTurnTailNode: FlowchartNode | undefined;
  let edgeSeq = 0;
  const nextEdgeId = (prefix: string) => `${prefix}:${++edgeSeq}`;

  turns.forEach((flow, turnIdx) => {
    const frameKey = `turn:${flow.id}`;
    const defaultTurnCollapsed = turns.length > 4
      && turnIdx > 0
      && turnIdx < turns.length - 2
      && flow.tasks.length === 0;
    const isTurnCollapsed = collapseMap.has(frameKey) ? Boolean(collapseMap.get(frameKey)) : defaultTurnCollapsed;

    const frameTopY = globalY;
    const firstTurnTitle = shortText(flow.ingress.text, 44);
    const linkBadge = flow.sessionLink?.label;

    if (isTurnCollapsed) {
      const compactNode = pushNode({
        id: `${flow.id}:collapsed-turn`,
        flowId: flow.id,
        sessionId: session.id,
        kind: 'flow_root',
        category: flow.ingress.sourceKind === 'wechat' || flow.ingress.sourceKind === 'xiaoai' ? 'im' : 'ingress',
        shape: 'pill',
        icon: sourceIcon(flow.ingress.sourceKind),
        badge: `第 ${turnIdx + 1}/${turns.length} 轮 (已折叠)`,
        title: shortText(flow.ingress.text, 34),
        subtitle: flow.deliveries.at(-1)?.text ? `回复: ${shortText(flow.deliveries.at(-1)!.text, 32)}` : '点击标题或展开看本轮思路',
        metric: formatTimeShort(flow.createdAt),
        status: flow.status,
        x: FC_SPINE_X,
        y: frameTopY + FC_HEADER_H + 12,
        w: FC_SPINE_W,
        h: 64,
        toggleKey: frameKey,
        collapsed: true,
        inspector: { flow, snapshot: snapshot ?? undefined, session },
      }, flow.ingress.text);

      if (prevTurnTailNode) {
        const y1 = prevTurnTailNode.y + prevTurnTailNode.h;
        const y2 = compactNode.y;
        edges.push({
          id: nextEdgeId('bridge'),
          fromId: prevTurnTailNode.id,
          toId: compactNode.id,
          kind: 'session_bridge',
          tone: 'accent',
          points: [{ x: FC_SPINE_CX, y: y1 }, { x: FC_SPINE_CX, y: y2 }],
          label: linkBadge ?? '🔗 会话上下文延续',
          labelX: FC_SPINE_CX,
          labelY: Math.round((y1 + y2) / 2),
        });
      }

      const frameH = FC_HEADER_H + 88;
      frames.push({
        id: `frame:${flow.id}`,
        sessionId: session.id,
        flowId: flow.id,
        turnIndex: turnIdx + 1,
        turnCount: turns.length,
        title: `第 ${turnIdx + 1}/${turns.length} 轮 · ${flow.ingress.channelLabel} · #${flow.seq || '独立'}`,
        subtitle: firstTurnTitle,
        badge: linkBadge ?? statusLabel(flow.status),
        status: flow.status,
        x: FC_FRAME_X,
        y: frameTopY,
        w: FC_FRAME_W,
        h: frameH,
        collapsed: true,
        toggleKey: frameKey,
      });

      prevTurnTailNode = compactNode;
      globalY = frameTopY + frameH + (turnIdx < turns.length - 1 ? 66 : 24);
      return;
    }

    let curY = frameTopY + FC_HEADER_H + 18;
    let prevSpine: FlowchartNode | undefined;

    const advanceGap = (label?: string) => (label ? 46 : 30);

    const connectDown = (fromNode: FlowchartNode | undefined, toNode: FlowchartNode, label?: string, tone: FlowchartEdgeTone = 'default', kind: FlowchartEdgeKind = 'spine') => {
      if (!fromNode) return;
      const y1 = fromNode.y + fromNode.h;
      const y2 = toNode.y;
      edges.push({
        id: nextEdgeId(kind),
        fromId: fromNode.id,
        toId: toNode.id,
        kind,
        tone,
        points: [{ x: FC_SPINE_CX, y: y1 }, { x: FC_SPINE_CX, y: y2 }],
        ...(label ? { label, labelX: FC_SPINE_CX, labelY: Math.round((y1 + y2) / 2) } : {}),
      });
    };

    const emitSidePair = (spineNode: FlowchartNode, leftCard: FlowchartNode, rightCard: FlowchartNode, branchLabel: string, tone: FlowchartEdgeTone = 'accent') => {
      const sy = Math.round(spineNode.y + spineNode.h / 2);
      const ly = Math.round(leftCard.y + leftCard.h / 2);
      const ry = Math.round(rightCard.y + rightCard.h / 2);
      edges.push({
        id: nextEdgeId('branch'),
        fromId: spineNode.id,
        toId: leftCard.id,
        kind: 'branch',
        tone,
        points: sy === ly
          ? [{ x: spineNode.x + spineNode.w, y: sy }, { x: leftCard.x, y: ly }]
          : [{ x: spineNode.x + spineNode.w, y: sy }, { x: FC_SIDE_TRUNK_X, y: sy }, { x: FC_SIDE_TRUNK_X, y: ly }, { x: leftCard.x, y: ly }],
        label: branchLabel,
        labelX: Math.round((spineNode.x + spineNode.w + leftCard.x) / 2),
        labelY: sy - 11,
      });
      edges.push({
        id: nextEdgeId('pair'),
        fromId: leftCard.id,
        toId: rightCard.id,
        kind: 'branch',
        tone,
        points: [{ x: leftCard.x + leftCard.w, y: ly }, { x: rightCard.x, y: ry }],
      });
    };

    const emitSideGrid = (spineNode: FlowchartNode, cards: FlowchartNode[], twoCols: boolean, branchLabel?: string) => {
      if (cards.length === 0) return;
      const sy = Math.round(spineNode.y + spineNode.h / 2);
      cards.forEach((card, i) => {
        const isCol2 = twoCols && (i % 2 === 1);
        if (!isCol2) {
          const cy = Math.round(card.y + card.h / 2);
          edges.push({
            id: nextEdgeId('branch'),
            fromId: spineNode.id,
            toId: card.id,
            kind: 'branch',
            tone: 'default',
            points: sy === cy
              ? [{ x: spineNode.x + spineNode.w, y: sy }, { x: card.x, y: cy }]
              : [{ x: spineNode.x + spineNode.w, y: sy }, { x: FC_SIDE_TRUNK_X, y: sy }, { x: FC_SIDE_TRUNK_X, y: cy }, { x: card.x, y: cy }],
            ...(i === 0 && branchLabel ? { label: branchLabel, labelX: Math.round((spineNode.x + spineNode.w + FC_SIDE_TRUNK_X) / 2), labelY: sy - 11 } : {}),
          });
        } else {
          // Route cleanly via top bus above row so no line crosses col-1 card
          const busY = card.y - 11;
          const targetTopX = card.x + 28;
          edges.push({
            id: nextEdgeId('branch'),
            fromId: spineNode.id,
            toId: card.id,
            kind: 'branch',
            tone: 'default',
            points: [
              { x: spineNode.x + spineNode.w, y: sy },
              { x: FC_SIDE_TRUNK_X, y: sy },
              { x: FC_SIDE_TRUNK_X, y: busY },
              { x: targetTopX, y: busY },
              { x: targetTopX, y: card.y },
            ],
          });
        }
      });
    };

    // ① Ingress (Pill)
    const attachNote = flow.ingress.attachments.length ? ` · 附件 ${flow.ingress.attachments.length}` : '';
    const pathNote = flow.ingress.paths.length ? ` · 目录 ${flow.ingress.paths.length}` : '';
    const ingressNode = pushNode({
      id: `${flow.id}:fc:ingress`,
      flowId: flow.id,
      sessionId: session.id,
      kind: 'ingress',
      category: 'ingress',
      shape: 'pill',
      icon: sourceIcon(flow.ingress.sourceKind),
      badge: `① ${flow.ingress.sourceKind === 'timer' ? '定时入口' : `${flow.ingress.channelLabel}接入`}`,
      title: shortText(flow.ingress.text, 34),
      subtitle: `${formatTimeShort(flow.createdAt)}${attachNote}${pathNote}`,
      metric: `#${flow.seq || '独立'}`,
      status: flow.status,
      x: FC_SPINE_X,
      y: curY,
      w: FC_SPINE_W,
      h: FC_SPINE_H,
      inspector: { flow, snapshot: snapshot ?? undefined, session },
    }, flow.ingress.text);

    if (prevTurnTailNode) {
      const y1 = prevTurnTailNode.y + prevTurnTailNode.h;
      const y2 = ingressNode.y;
      edges.push({
        id: nextEdgeId('bridge'),
        fromId: prevTurnTailNode.id,
        toId: ingressNode.id,
        kind: 'session_bridge',
        tone: 'accent',
        points: [{ x: FC_SPINE_CX, y: y1 }, { x: FC_SPINE_CX, y: y2 }],
        label: linkBadge ?? '🔗 AI 会话上下文延续',
        labelX: FC_SPINE_CX,
        labelY: Math.round((y1 + y2) / 2),
      });
    }
    prevSpine = ingressNode;
    curY += FC_SPINE_H + advanceGap();

    // ② Memory recall + session context loading
    const memToggleKey = `${flow.id}:fc:mem`;
    const allRecalled = flow.memoryRecall.recalledItems;
    const memDefaultCollapsed = allRecalled.length > 6;
    const memExpanded = collapseMap.has(memToggleKey) ? !collapseMap.get(memToggleKey) : !memDefaultCollapsed;
    const visibleRecalled = allRecalled.length === 0 ? [] : (memExpanded ? allRecalled : allRecalled.slice(0, 4));
    const memRows = visibleRecalled.length ? Math.ceil(visibleRecalled.length / 2) : 0;
    const memSideHeight = memRows > 0 ? memRows * FC_SIDE_H + (memRows - 1) * FC_SIDE_BUS_GAP : 0;
    const memBandStartY = curY;

    const contextPrefix = turnIdx > 0 ? `携带前 ${turnIdx} 轮对话上下文 · ` : '';
    const memNode = pushNode({
      id: `${flow.id}:fc:memory`,
      flowId: flow.id,
      sessionId: session.id,
      kind: 'memory_group',
      category: 'memory',
      shape: 'process',
      icon: '🧠',
      badge: '② 记忆联想与上下文装载',
      title: allRecalled.length
        ? `${contextPrefix}召回 ${allRecalled.length} 条记忆`
        : `${contextPrefix}加载工作空间上下文`,
      subtitle: `${flow.memoryRecall.executionMode === 'native' ? '本地直访模式' : 'Snapshot 模式'} · 目录记忆 ${flow.memoryRecall.directoryTotal ?? 0}`,
      metric: allRecalled.length > 4 ? (memExpanded ? '已全部展开' : `+${allRecalled.length - 4} 折叠`) : (allRecalled.length ? `${allRecalled.length} 命中` : '0 命中'),
      status: 'completed',
      x: FC_SPINE_X,
      y: memBandStartY,
      w: FC_SPINE_W,
      h: FC_SPINE_H,
      ...(allRecalled.length > 0 ? { toggleKey: memToggleKey, collapsed: !memExpanded, hiddenCount: memExpanded ? 0 : allRecalled.length - visibleRecalled.length } : {}),
      inspector: { flow, session },
    }, allRecalled.map(m => `${m.title} ${m.snippet}`).join(' '));

    connectDown(prevSpine, memNode, turnIdx > 0 ? '注入会话上下文' : undefined);

    if (visibleRecalled.length > 0) {
      const memCards = visibleRecalled.map((item, mIdx) => {
        const col = mIdx % 2;
        const row = Math.floor(mIdx / 2);
        return pushNode({
          id: `${flow.id}:fc:mem:${mIdx}`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'memory_item',
          category: 'memory',
          shape: 'process',
          icon: item.activatedVia ? '✨' : item.kind === 'memory' ? '🗂️' : '📜',
          badge: item.activatedVia ? `突触激活 (${item.activatedVia.weight.toFixed(1)})` : `关联度 ${item.score.toFixed(2)}`,
          title: shortText(item.title, 26),
          subtitle: shortText(item.snippet, 30),
          status: 'completed',
          x: col === 0 ? FC_SIDE1_X : FC_SIDE2_X,
          y: memBandStartY + row * (FC_SIDE_H + FC_SIDE_BUS_GAP),
          w: FC_SIDE_W,
          h: FC_SIDE_H,
          inspector: { flow, memoryItem: item, session },
        }, `${item.title} ${item.snippet}`);
      });
      emitSideGrid(memNode, memCards, true, '联想记忆');
    }

    prevSpine = memNode;
    curY = memBandStartY + Math.max(FC_SPINE_H, memSideHeight) + advanceGap(flow.tasks.length ? '进入主控路由' : undefined);

    // ③ Execution spine: Direct Plugin OR Chat Router Turns OR Task Lifecycle
    if (flow.directPlugin) {
      const dpNode = pushNode({
        id: `${flow.id}:fc:direct-plugin`,
        flowId: flow.id,
        sessionId: session.id,
        kind: 'direct_plugin',
        category: 'router',
        shape: 'subprocess',
        icon: '🔌',
        badge: '③ 零 Token 插件直跑',
        title: `${flow.directPlugin.plugin}.${flow.directPlugin.pluginAction}`,
        subtitle: `定时规则: ${flow.directPlugin.timerName}`,
        metric: '直达推送',
        status: 'completed',
        x: FC_SPINE_X,
        y: curY,
        w: FC_SPINE_W,
        h: FC_SPINE_H,
        inspector: { flow, session },
      }, flow.directPlugin.plugin);
      connectDown(prevSpine, dpNode, '免 LLM 推理');
      prevSpine = dpNode;
      curY += FC_SPINE_H + advanceGap('发送执行结果');
    } else if (flow.tasks.length === 0) {
      const turnsToShow = flow.routerTurns.length ? flow.routerTurns : [{
        spanId: `${flow.id}:synth-router`,
        triggerKind: 'CHAT',
        startedAt: flow.createdAt,
        status: flow.status === 'failed' ? 'failed' : 'completed',
        llmTurns: 1,
        tools: [],
      }];

      turnsToShow.forEach((rt, rtIdx) => {
        const bandY = curY;
        const sideCardsCount = rt.tools.length;
        const sideH = sideCardsCount > 0 ? sideCardsCount * FC_SIDE_H + (sideCardsCount - 1) * FC_SIDE_ROW_GAP : 0;
        const toolNames = rt.tools.map(t => t.toolName).join(' · ');
        const rNode = pushNode({
          id: `${flow.id}:fc:rt:${rtIdx}`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'router_turn',
          category: 'router',
          shape: 'decision',
          icon: '◆',
          badge: `③ Router 思考决策${turnsToShow.length > 1 ? ` #${rtIdx + 1}` : ''}`,
          title: rt.tools.length ? `调用 ${toolNames} 后直回` : '直接回答 / 追问澄清',
          subtitle: `${rt.llmTurns} 轮推理 · ${formatDuration(rt.durationMs)}${rt.usage ? ` · ${rt.usage.totalTokens} tok` : ''}`,
          metric: statusLabel(rt.status),
          status: rt.status,
          x: FC_SPINE_X,
          y: bandY,
          w: FC_SPINE_W,
          h: FC_SPINE_H,
          inspector: { flow, routerTurn: rt, session },
        }, `${rt.outputPreview ?? ''} ${toolNames}`);
        connectDown(prevSpine, rNode, rtIdx === 0 ? '主控判断意图' : '继续推理');

        const toolCards = rt.tools.map((tool, tIdx) => pushNode({
          id: `${flow.id}:fc:rt:${rtIdx}:tool:${tIdx}`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'router_tool',
          category: 'router',
          shape: 'process',
          icon: '🛠️',
          badge: `Router 工具 · ${tool.toolName}`,
          title: shortText(tool.inputPreview || tool.toolName, 26),
          subtitle: shortText(tool.outputPreview || formatDuration(tool.durationMs), 30),
          status: tool.status,
          x: FC_SIDE1_X,
          y: bandY + tIdx * (FC_SIDE_H + FC_SIDE_ROW_GAP),
          w: FC_SIDE_W,
          h: FC_SIDE_H,
          inspector: { flow, routerTurn: rt, routerTool: tool, session },
        }, `${tool.toolName} ${tool.inputPreview ?? ''} ${tool.outputPreview ?? ''}`));
        emitSideGrid(rNode, toolCards, false, '主控工具');

        prevSpine = rNode;
        curY = bandY + Math.max(FC_SPINE_H, sideH) + advanceGap();
      });
    } else {
      // Flow with Worker task(s): chronological causal order!
      const usedDeliveryIds = new Set<string>();
      const usedRouterSpans = new Set<string>();
      const firstTaskAt = flow.tasks[0]!.createdAt;
      const initialTurn = flow.routerTurns[0];
      if (initialTurn) {
        usedRouterSpans.add(initialTurn.spanId);
        const bandY = curY;
        const earlyReply = flow.deliveries.find((d, idx) => idx < flow.deliveries.length - 1 && d.at <= firstTaskAt + 6000);
        if (earlyReply) usedDeliveryIds.add(earlyReply.messageId);
        const startTool = initialTurn.tools.find(t => t.toolName === 'start_work' || t.toolName === 'spawn_task') ?? initialTurn.tools[0];
        const initNode = pushNode({
          id: `${flow.id}:fc:rt:init`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'router_turn',
          category: 'router',
          shape: 'decision',
          icon: '◆',
          badge: '③ Router 接单与意图决策',
          title: `决定派发 ${flow.tasks.length} 个后台 Worker 任务`,
          subtitle: `${TRIGGER_LABELS[initialTurn.triggerKind] ?? initialTurn.triggerKind} · ${formatDuration(initialTurn.durationMs)}`,
          metric: `${initialTurn.llmTurns} 轮推理`,
          status: initialTurn.status,
          x: FC_SPINE_X,
          y: bandY,
          w: FC_SPINE_W,
          h: FC_SPINE_H,
          inspector: { flow, routerTurn: initialTurn, routerTool: startTool, session },
        }, initialTurn.outputPreview);
        connectDown(prevSpine, initNode, '分析任务需求');

        const sideCards: FlowchartNode[] = [];
        if (startTool) {
          sideCards.push(pushNode({
            id: `${flow.id}:fc:rt:init-tool`,
            flowId: flow.id,
            sessionId: session.id,
            kind: 'router_tool',
            category: 'router',
            shape: 'process',
            icon: '🚀',
            badge: `指令 · ${startTool.toolName}`,
            title: shortText(startTool.inputPreview || flow.tasks[0]!.prompt, 26),
            subtitle: shortText(startTool.outputPreview || `Profile: ${flow.tasks[0]!.profile ?? 'general'}`, 28),
            status: startTool.status,
            x: FC_SIDE1_X,
            y: bandY,
            w: FC_SIDE_W,
            h: FC_SIDE_H,
            inspector: { flow, routerTurn: initialTurn, routerTool: startTool, task: flow.tasks[0], session },
          }, startTool.inputPreview));
        }
        if (earlyReply) {
          sideCards.push(pushNode({
            id: `${flow.id}:fc:early-reply`,
            flowId: flow.id,
            sessionId: session.id,
            kind: 'reply_item',
            category: 'im',
            shape: 'io',
            icon: '💬',
            badge: earlyReply.roleLabel,
            title: shortText(earlyReply.text, 26),
            subtitle: `${formatTimeShort(earlyReply.at)} · 先回老板安抚`,
            status: earlyReply.status,
            x: startTool ? FC_SIDE2_X : FC_SIDE1_X,
            y: bandY,
            w: FC_SIDE_W,
            h: FC_SIDE_H,
            inspector: { flow, delivery: earlyReply, session },
          }, earlyReply.text));
        }
        if (sideCards.length === 2) {
          emitSidePair(initNode, sideCards[0]!, sideCards[1]!, '派单并回执');
        } else if (sideCards.length === 1) {
          emitSideGrid(initNode, sideCards, false, '接单动作');
        }

        prevSpine = initNode;
        curY = bandY + Math.max(FC_SPINE_H, sideCards.length ? FC_SIDE_H : 0) + advanceGap('触发选模');
      }

      // Render each task's causal execution chain
      for (let tIdx = 0; tIdx < flow.tasks.length; tIdx += 1) {
        const task = flow.tasks[tIdx]!;
        const taskTag = flow.tasks.length > 1 ? `任务${tIdx + 1} · ` : '';

        // ④ JEV Model Selection Decision + Req -> Res pair
        if (task.jevRoute) {
          const jr = task.jevRoute;
          const selModel = shortText((jr.response.selectedModel ?? '默认模型').split('/').pop(), 22);
          const selLevel = jr.response.thinkingLevel ?? 'medium';
          const bandY = curY;
          const jevRouteNode = pushNode({
            id: `${flow.id}:fc:t:${task.id}:jev-route`,
            flowId: flow.id,
            sessionId: session.id,
            kind: 'jev_route',
            category: 'jev',
            shape: 'decision',
            icon: '🎯',
            badge: `④ ${taskTag}JEV 选模决策`,
            title: `${selModel} @ ${selLevel}`,
            subtitle: jr.response.confidence !== undefined
              ? `置信度 ${(jr.response.confidence * 100).toFixed(0)}% · ${jr.response.needsQualityGate === false ? '可免质检' : '开启质检门禁'}`
              : (jr.source === 'gemini-decision-1' ? 'Gemini Decision 1 选定' : statusLabel(jr.status)),
            metric: jr.source === 'gemini-decision-1' ? 'JEV-1' : statusLabel(jr.source),
            status: jr.status,
            x: FC_SPINE_X,
            y: bandY,
            w: FC_SPINE_W,
            h: FC_SPINE_H,
            inspector: { flow, task, jevRoute: jr, session },
          }, `${jr.response.selectedModel ?? ''} ${jr.request.instructionPreview}`);
          connectDown(prevSpine, jevRouteNode, `${taskTag}请求 JEV 选模`, 'accent');

          const reqCard = pushNode({
            id: `${flow.id}:fc:t:${task.id}:jev-req`,
            flowId: flow.id,
            sessionId: session.id,
            kind: 'jev_route_req',
            category: 'jev',
            shape: 'process',
            icon: '📤',
            badge: '怎么调用的 JEV (Request)',
            title: jr.called ? `POST ${jr.request.endpoint}` : '未调用远端 JEV',
            subtitle: `profile:${jr.request.profile} · 候选:${jr.request.candidateCount ?? '全量'} · 图:${jr.request.hasImages ? '是' : '否'}`,
            status: jr.status,
            x: FC_SIDE1_X,
            y: bandY,
            w: FC_SIDE_W,
            h: FC_SIDE_H,
            inspector: { flow, task, jevRoute: jr, session },
          }, jr.request.instructionPreview);

          const resCard = pushNode({
            id: `${flow.id}:fc:t:${task.id}:jev-res`,
            flowId: flow.id,
            sessionId: session.id,
            kind: 'jev_route_res',
            category: 'jev',
            shape: 'process',
            icon: '📥',
            badge: 'JEV 响应 (Response)',
            title: `选定 ${selModel} · ${selLevel}`,
            subtitle: jr.response.fallbackReason
              ? `回退: ${shortText(jr.response.fallbackReason, 26)}`
              : `${jr.response.usage ? `${jr.response.usage.totalTokens} tok · ` : ''}质检:${jr.response.needsQualityGate === false ? '跳过' : '开启'}`,
            status: jr.status,
            x: FC_SIDE2_X,
            y: bandY,
            w: FC_SIDE_W,
            h: FC_SIDE_H,
            inspector: { flow, task, jevRoute: jr, session },
          });

          emitSidePair(jevRouteNode, reqCard, resCard, '调用入参/响应', 'accent');
          prevSpine = jevRouteNode;
          curY = bandY + Math.max(FC_SPINE_H, FC_SIDE_H) + advanceGap(`派发 ${selModel}`);
        }

        // ⑤ Iterative Worker Phases -> JEV Quality Gate -> Router Evaluation & Loopback!
        const phases: MindmapWorkerPhase[] = task.executionPhases?.length
          ? task.executionPhases
          : [{
              index: 1,
              isFollowup: false,
              startedAt: task.createdAt,
              durationMs: task.activeMs,
              status: task.status,
              llmCount: task.workerSteps.filter(s => s.kind === 'llm_turn').length,
              toolCount: task.workerSteps.filter(s => s.kind === 'tool_call').length,
              ...(task.jevQualityGates[0] ? { qualityGateIndex: task.jevQualityGates[0].index } : {}),
            }];

        let pendingLoopSourceNode: FlowchartNode | undefined;

        phases.forEach((phase, pIdx) => {
          const bandY = curY;
          const phaseStepsAll = task.workerSteps.filter(s =>
            s.kind !== 'followup' && (s.phaseIndex ? s.phaseIndex === phase.index : pIdx === 0),
          );
          const stepsKey = `${flow.id}:t:${task.id}:p:${phase.index}:steps`;
          const stepsExpanded = collapseMap.has(stepsKey) ? !collapseMap.get(stepsKey) : false;
          const MAX_PHASE_SIDE = 6;
          const visibleSteps = stepsExpanded ? phaseStepsAll : phaseStepsAll.slice(0, MAX_PHASE_SIDE);
          const hasHiddenSteps = !stepsExpanded && phaseStepsAll.length > MAX_PHASE_SIDE;
          const totalGridCells = visibleSteps.length + (hasHiddenSteps ? 1 : 0);
          const gridRows = totalGridCells > 0 ? Math.ceil(totalGridCells / 2) : 0;
          const sideH = gridRows > 0 ? gridRows * FC_SIDE_H + (gridRows - 1) * FC_SIDE_BUS_GAP : 0;

          const phaseTag = phases.length > 1 ? ` #${phase.index}` : '';
          const workerNode = pushNode({
            id: `${flow.id}:fc:t:${task.id}:phase:${phase.index}`,
            flowId: flow.id,
            sessionId: session.id,
            kind: 'worker_phase',
            category: 'worker',
            shape: 'subprocess',
            icon: phase.isFollowup ? '🔁' : '⚙️',
            badge: `⑤ ${taskTag}${phase.isFollowup ? `Worker 补充执行${phaseTag}` : `Worker 自主执行${phaseTag}`}`,
            title: phase.followupPrompt
              ? shortText(phase.followupPrompt, 32)
              : shortText(task.prompt, 32),
            subtitle: `${phase.llmCount} 轮推理 · ${phase.toolCount} 次工具 · ${formatDuration(phase.durationMs)}`,
            metric: `${phase.llmCount + phase.toolCount} 步`,
            status: phase.status,
            x: FC_SPINE_X,
            y: bandY,
            w: FC_SPINE_W,
            h: FC_SPINE_H,
            ...(phaseStepsAll.length > MAX_PHASE_SIDE ? {
              toggleKey: stepsKey,
              collapsed: !stepsExpanded,
              hiddenCount: stepsExpanded ? 0 : phaseStepsAll.length - MAX_PHASE_SIDE,
            } : {}),
            inspector: { flow, task, phase, session },
          }, phaseStepsAll.map(s => `${s.title} ${s.inputPreview ?? ''} ${s.outputPreview ?? ''}`).join(' '));

          connectDown(
            prevSpine,
            workerNode,
            pIdx > 0 ? '🔁 continue_work 补充执行' : (task.jevRoute ? '启动 Worker 阶段 #1' : `${taskTag}启动 Worker`),
            pIdx > 0 ? 'warn' : 'default',
          );

          // Left-margin Loopback dashed arrow from previous Router evaluation node!
          if (pendingLoopSourceNode) {
            const sy = Math.round(pendingLoopSourceNode.y + pendingLoopSourceNode.h / 2);
            const ty = Math.round(workerNode.y + workerNode.h / 2);
            edges.push({
              id: nextEdgeId('loopback'),
              fromId: pendingLoopSourceNode.id,
              toId: workerNode.id,
              kind: 'loopback',
              tone: 'warn',
              points: [
                { x: pendingLoopSourceNode.x, y: sy },
                { x: FC_LOOP_X, y: sy },
                { x: FC_LOOP_X, y: ty },
                { x: workerNode.x, y: ty },
              ],
              label: '↺ 打回补查',
              labelX: FC_LOOP_X + 18,
              labelY: Math.round((sy + ty) / 2),
            });
            pendingLoopSourceNode = undefined;
          }

          // Side grid for Worker execution steps in this phase
          const stepCards: FlowchartNode[] = visibleSteps.map((step, sIdx) => {
            const col = sIdx % 2;
            const row = Math.floor(sIdx / 2);
            const icon = step.kind === 'llm_turn' ? '💭' : step.kind === 'ask_boss' ? '🙋' : '🔧';
            return pushNode({
              id: `${flow.id}:fc:t:${task.id}:p:${phase.index}:step:${step.id}`,
              flowId: flow.id,
              sessionId: session.id,
              kind: 'worker_step',
              category: 'worker',
              shape: 'process',
              icon,
              badge: step.toolName ? `${step.toolName} · ${formatDuration(step.durationMs)}` : `推理 · ${formatDuration(step.durationMs)}`,
              title: shortText(step.inputPreview || step.title, 26),
              subtitle: shortText(step.outputPreview || statusLabel(step.status), 30),
              status: step.status,
              x: col === 0 ? FC_SIDE1_X : FC_SIDE2_X,
              y: bandY + row * (FC_SIDE_H + FC_SIDE_BUS_GAP),
              w: FC_SIDE_W,
              h: FC_SIDE_H,
              inspector: { flow, task, phase, workerStep: step, session },
            }, `${step.title} ${step.inputPreview ?? ''} ${step.outputPreview ?? ''}`);
          });
          if (hasHiddenSteps) {
            const mIdx = visibleSteps.length;
            const col = mIdx % 2;
            const row = Math.floor(mIdx / 2);
            stepCards.push(pushNode({
              id: `${flow.id}:fc:t:${task.id}:p:${phase.index}:more`,
              flowId: flow.id,
              sessionId: session.id,
              kind: 'worker_more',
              category: 'worker',
              shape: 'process',
              icon: '➕',
              badge: '点击展开剩余步骤',
              title: `还有 ${phaseStepsAll.length - MAX_PHASE_SIDE} 个执行步骤`,
              subtitle: '点击此卡展开本阶段完整推演与命令',
              status: 'completed',
              x: col === 0 ? FC_SIDE1_X : FC_SIDE2_X,
              y: bandY + row * (FC_SIDE_H + FC_SIDE_BUS_GAP),
              w: FC_SIDE_W,
              h: FC_SIDE_H,
              toggleKey: stepsKey,
              collapsed: true,
              hiddenCount: phaseStepsAll.length - MAX_PHASE_SIDE,
              inspector: { flow, task, phase, session },
            }));
          }
          emitSideGrid(workerNode, stepCards, true, `阶段#${phase.index}步骤`);

          const matchedQg = phase.qualityGateIndex
            ? task.jevQualityGates.find(q => q.index === phase.qualityGateIndex)
            : undefined;
          const matchedReportTurn = phase.routerReportSpanId
            ? flow.routerTurns.find(rt => rt.spanId === phase.routerReportSpanId)
            : undefined;
          if (matchedReportTurn) usedRouterSpans.add(matchedReportTurn.spanId);

          prevSpine = workerNode;
          curY = bandY + Math.max(FC_SPINE_H, sideH) + advanceGap(matchedQg ? '提交 JEV 质检' : matchedReportTurn ? '汇报主控验收' : undefined);

          // ⑥ JEV Quality Gate for this phase
          let nextEdgeFromQgLabel: string | undefined;
          let nextEdgeFromQgTone: FlowchartEdgeTone = 'default';
          if (matchedQg) {
            const qBandY = curY;
            const supp = matchedQg.response.shouldSupplement;
            const scoreStr = `${matchedQg.response.score.toFixed(2)}/${matchedQg.response.maxScore}`;
            const qgNode = pushNode({
              id: `${flow.id}:fc:t:${task.id}:qg:${matchedQg.index}`,
              flowId: flow.id,
              sessionId: session.id,
              kind: 'jev_quality',
              category: 'quality',
              shape: 'decision',
              icon: supp ? '⚠️' : '✅',
              badge: `⑥ JEV 质检门禁 #${matchedQg.index}`,
              title: supp ? `建议打回补充 · ${scoreStr}` : `质检通过 · ${scoreStr}`,
              subtitle: `缺失项:${matchedQg.response.missingAspect} · 补充概率:${(matchedQg.response.supplementProbability * 100).toFixed(0)}%`,
              metric: scoreStr,
              status: supp ? 'paused' : matchedQg.status,
              x: FC_SPINE_X,
              y: qBandY,
              w: FC_SPINE_W,
              h: FC_SPINE_H,
              inspector: { flow, task, jevQuality: matchedQg, session },
            }, `${matchedQg.response.missingAspect} ${scoreStr}`);
            connectDown(prevSpine, qgNode, `阶段#${phase.index}完工交卷`);

            const qReqCard = pushNode({
              id: `${flow.id}:fc:t:${task.id}:qg:${matchedQg.index}:req`,
              flowId: flow.id,
              sessionId: session.id,
              kind: 'jev_quality_req',
              category: 'quality',
              shape: 'process',
              icon: '📤',
              badge: '怎么调用的 JEV 质检',
              title: `POST ${matchedQg.request.endpoint}`,
              subtitle: `成功:${matchedQg.request.succeededOps} · 失败:${matchedQg.request.failedOps} · 报告:${matchedQg.request.reportLength}字`,
              status: matchedQg.status,
              x: FC_SIDE1_X,
              y: qBandY,
              w: FC_SIDE_W,
              h: FC_SIDE_H,
              inspector: { flow, task, jevQuality: matchedQg, session },
            });
            const qResCard = pushNode({
              id: `${flow.id}:fc:t:${task.id}:qg:${matchedQg.index}:res`,
              flowId: flow.id,
              sessionId: session.id,
              kind: 'jev_quality_res',
              category: 'quality',
              shape: 'process',
              icon: '📥',
              badge: 'JEV 质检响应',
              title: `${scoreStr} · ${supp ? 'shouldSupplement=true' : '验收合格'}`,
              subtitle: `置信 ${(matchedQg.response.confidence * 100).toFixed(0)}% · ${matchedQg.source}`,
              status: supp ? 'paused' : matchedQg.status,
              x: FC_SIDE2_X,
              y: qBandY,
              w: FC_SIDE_W,
              h: FC_SIDE_H,
              inspector: { flow, task, jevQuality: matchedQg, session },
            });
            emitSidePair(qgNode, qReqCard, qResCard, '质检入参/评分', supp ? 'warn' : 'success');

            nextEdgeFromQgLabel = supp
              ? `⚠️ 得分 ${scoreStr} · 建议补充`
              : `✅ 得分 ${scoreStr} · 质检通过`;
            nextEdgeFromQgTone = supp ? 'warn' : 'success';
            prevSpine = qgNode;
            curY = qBandY + Math.max(FC_SPINE_H, FC_SIDE_H) + advanceGap(nextEdgeFromQgLabel);
          }

          // Router验收轮次（决定 continue_work 还是终审交付）
          if (matchedReportTurn) {
            const hasMorePhases = pIdx < phases.length - 1;
            const rBandY = curY;
            const contTool = matchedReportTurn.tools.find(t => t.toolName === 'continue_work') ?? matchedReportTurn.tools[0];
            const stageReply = hasMorePhases
              ? flow.deliveries.find((d, idx) =>
                  !usedDeliveryIds.has(d.messageId)
                  && idx < flow.deliveries.length - 1
                  && d.at >= matchedReportTurn.startedAt - 1000
                  && d.at <= (matchedReportTurn.endedAt ?? matchedReportTurn.startedAt) + 5000)
              : undefined;
            if (stageReply) usedDeliveryIds.add(stageReply.messageId);

            const evalNode = pushNode({
              id: `${flow.id}:fc:t:${task.id}:eval:${phase.index}`,
              flowId: flow.id,
              sessionId: session.id,
              kind: 'router_turn',
              category: 'router',
              shape: 'decision',
              icon: hasMorePhases ? '🔁' : '◆',
              badge: hasMorePhases ? 'Router 验收 · 决定打回补充' : 'Router 终审 · 汇总交付',
              title: hasMorePhases ? '采纳质检建议 · 追加 continue_work' : '审核结果合格 · 整理回复老板',
              subtitle: `${matchedReportTurn.llmTurns} 轮推理 · ${formatDuration(matchedReportTurn.durationMs)}${matchedReportTurn.usage ? ` · ${matchedReportTurn.usage.totalTokens} tok` : ''}`,
              metric: statusLabel(matchedReportTurn.status),
              status: matchedReportTurn.status,
              x: FC_SPINE_X,
              y: rBandY,
              w: FC_SPINE_W,
              h: FC_SPINE_H,
              inspector: { flow, routerTurn: matchedReportTurn, routerTool: contTool, task, session },
            }, matchedReportTurn.outputPreview);

            connectDown(prevSpine, evalNode, nextEdgeFromQgLabel, nextEdgeFromQgTone);
            nextEdgeFromQgLabel = undefined;

            const sideCards: FlowchartNode[] = [];
            if (contTool) {
              sideCards.push(pushNode({
                id: `${flow.id}:fc:t:${task.id}:eval-tool:${phase.index}`,
                flowId: flow.id,
                sessionId: session.id,
                kind: 'router_tool',
                category: 'router',
                shape: 'process',
                icon: hasMorePhases ? '🔁' : '🛠️',
                badge: `指令 · ${contTool.toolName}`,
                title: shortText(contTool.inputPreview || contTool.toolName, 26),
                subtitle: shortText(contTool.outputPreview || formatDuration(contTool.durationMs), 28),
                status: contTool.status,
                x: FC_SIDE1_X,
                y: rBandY,
                w: FC_SIDE_W,
                h: FC_SIDE_H,
                inspector: { flow, routerTurn: matchedReportTurn, routerTool: contTool, task, session },
              }, contTool.inputPreview));
            }
            if (stageReply) {
              sideCards.push(pushNode({
                id: `${flow.id}:fc:t:${task.id}:eval-reply:${phase.index}`,
                flowId: flow.id,
                sessionId: session.id,
                kind: 'reply_item',
                category: 'im',
                shape: 'io',
                icon: '💬',
                badge: stageReply.roleLabel,
                title: shortText(stageReply.text, 26),
                subtitle: `${formatTimeShort(stageReply.at)} · 同步阶段进展`,
                status: stageReply.status,
                x: contTool ? FC_SIDE2_X : FC_SIDE1_X,
                y: rBandY,
                w: FC_SIDE_W,
                h: FC_SIDE_H,
                inspector: { flow, delivery: stageReply, session },
              }, stageReply.text));
            }
            if (sideCards.length === 2) emitSidePair(evalNode, sideCards[0]!, sideCards[1]!, '同步并打回');
            else if (sideCards.length === 1) emitSideGrid(evalNode, sideCards, false, '验收动作');

            if (hasMorePhases) pendingLoopSourceNode = evalNode;
            prevSpine = evalNode;
            curY = rBandY + Math.max(FC_SPINE_H, sideCards.length ? FC_SIDE_H : 0) + advanceGap(hasMorePhases ? '准备补充指令' : undefined);
          } else if (nextEdgeFromQgLabel && prevSpine) {
            // Preserve label for the very next downward spine node
            const nextLabel = nextEdgeFromQgLabel;
            const nextTone = nextEdgeFromQgTone;
            if (pIdx < phases.length - 1) pendingLoopSourceNode = prevSpine;
            // Attach note onto current phase when no separate router turn exists
            void nextLabel;
            void nextTone;
          }
        });
      }

      // Any leftover unclaimed router turns
      const leftoverTurns = flow.routerTurns.filter(rt => !usedRouterSpans.has(rt.spanId));
      leftoverTurns.forEach((rt, idx) => {
        const extraNode = pushNode({
          id: `${flow.id}:fc:rt:extra:${idx}`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'router_turn',
          category: 'router',
          shape: 'decision',
          icon: '◆',
          badge: `Router 补充汇报轮 #${idx + 1}`,
          title: TRIGGER_LABELS[rt.triggerKind] ?? rt.triggerKind,
          subtitle: `${rt.llmTurns} 轮推理 · ${formatDuration(rt.durationMs)}`,
          status: rt.status,
          x: FC_SPINE_X,
          y: curY,
          w: FC_SPINE_W,
          h: FC_SPINE_H,
          inspector: { flow, routerTurn: rt, session },
        });
        connectDown(prevSpine, extraNode);
        prevSpine = extraNode;
        curY += FC_SPINE_H + advanceGap();
      });
    }

    // ④ Memory Consolidation (Process)
    if (flow.consolidatedMemories.length > 0) {
      const mBandY = curY;
      const cards = flow.consolidatedMemories.slice(0, 4);
      const rows = Math.ceil(cards.length / 2);
      const sideH = rows * FC_SIDE_H + (rows - 1) * FC_SIDE_BUS_GAP;
      const consNode = pushNode({
        id: `${flow.id}:fc:consolidate`,
        flowId: flow.id,
        sessionId: session.id,
        kind: 'memory_consolidate',
        category: 'memory',
        shape: 'process',
        icon: '💾',
        badge: '⑦ 海马体记忆沉淀',
        title: `新沉淀 ${flow.consolidatedMemories.length} 张经验记忆`,
        subtitle: shortText(flow.consolidatedMemories[0]!.topic, 34),
        metric: `${flow.consolidatedMemories.reduce((s, m) => s + m.synapseCount, 0)} 突触`,
        status: 'completed',
        x: FC_SPINE_X,
        y: mBandY,
        w: FC_SPINE_W,
        h: FC_SPINE_H,
        inspector: { flow, consolidatedMemory: flow.consolidatedMemories[0], session },
      }, flow.consolidatedMemories.map(m => m.topic).join(' '));
      connectDown(prevSpine, consNode, '提炼长期记忆');

      const cardNodes = cards.map((mem, mIdx) => {
        const col = mIdx % 2;
        const row = Math.floor(mIdx / 2);
        return pushNode({
          id: `${flow.id}:fc:cons:${mem.id}`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'memory_consolidate',
          category: 'memory',
          shape: 'process',
          icon: mem.pinned ? '📌' : '🗂️',
          badge: mem.autoConsolidated ? '自动巩固' : '主动记忆',
          title: shortText(mem.topic, 26),
          subtitle: shortText(mem.contentPreview, 28),
          status: 'completed',
          x: col === 0 ? FC_SIDE1_X : FC_SIDE2_X,
          y: mBandY + row * (FC_SIDE_H + FC_SIDE_BUS_GAP),
          w: FC_SIDE_W,
          h: FC_SIDE_H,
          inspector: { flow, consolidatedMemory: mem, session },
        }, `${mem.topic} ${mem.contentPreview}`);
      });
      emitSideGrid(consNode, cardNodes, true, '写入记忆库');
      prevSpine = consNode;
      curY = mBandY + Math.max(FC_SPINE_H, sideH) + advanceGap();
    }

    // ⑤ Final Delivery & IM Push (I/O Parallelogram)
    const finalDelivery = flow.deliveries.at(-1);
    const delBandY = curY;
    const imTargetNote = flow.imPush.sentFiles.length ? ` (+${flow.imPush.sentFiles.length} 附件)` : '';
    const imNode = pushNode({
      id: `${flow.id}:fc:im`,
      flowId: flow.id,
      sessionId: session.id,
      kind: 'im_delivery',
      category: 'im',
      shape: 'io',
      icon: flow.imPush.channel === 'wechat' ? '📲' : flow.imPush.channel === 'xiaoai' ? '🔊' : flow.imPush.channel === 'local' ? '📩' : '📡',
      badge: `⑧ 最终交付 → ${flow.imPush.channelName}`,
      title: finalDelivery
        ? `${shortText(finalDelivery.text || finalDelivery.reason, 30)}${imTargetNote}`
        : `${flow.imPush.delivered ? '已原路送达' : '等待生成回复'}${imTargetNote}`,
      subtitle: `${formatTimeShort(finalDelivery?.at ?? flow.completedAt)} · 共 ${flow.deliveries.length} 条回复`,
      metric: flow.imPush.delivered ? '已送达' : statusLabel(flow.status),
      status: flow.imPush.delivered ? 'completed' : flow.status,
      x: FC_SPINE_X,
      y: delBandY,
      w: FC_SPINE_W,
      h: FC_SPINE_H,
      inspector: { flow, delivery: finalDelivery, session },
    }, flow.deliveries.map(d => d.text).join(' '));
    connectDown(prevSpine, imNode, `推送 ${flow.imPush.channel === 'wechat' ? '微信' : flow.imPush.channel === 'xiaoai' ? '小爱音箱' : flow.imPush.channel === 'local' ? '控制台' : flow.imPush.channel}`, flow.imPush.delivered ? 'success' : 'default');

    // Side card if files sent or multiple replies exist
    const sideDeliveries: FlowchartNode[] = [];
    if (flow.deliveries.length > 1 || flow.imPush.sentFiles.length > 0) {
      if (finalDelivery) {
        sideDeliveries.push(pushNode({
          id: `${flow.id}:fc:final-del-card`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'reply_item',
          category: 'im',
          shape: 'io',
          icon: '✉️',
          badge: finalDelivery.roleLabel,
          title: shortText(finalDelivery.text, 26),
          subtitle: `${formatTimeShort(finalDelivery.at)} · 点击看完整原文`,
          status: finalDelivery.status,
          x: FC_SIDE1_X,
          y: delBandY,
          w: FC_SIDE_W,
          h: FC_SIDE_H,
          inspector: { flow, delivery: finalDelivery, session },
        }, finalDelivery.text));
      }
      if (flow.imPush.sentFiles.length > 0) {
        sideDeliveries.push(pushNode({
          id: `${flow.id}:fc:sent-files`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'im_delivery',
          category: 'im',
          shape: 'process',
          icon: '📎',
          badge: `发送微信/IM 附件 (${flow.imPush.sentFiles.length})`,
          title: shortText(flow.imPush.sentFiles.map(f => f.name).join(', '), 26),
          subtitle: flow.imPush.target ?? flow.imPush.channelName,
          status: 'completed',
          x: sideDeliveries.length ? FC_SIDE2_X : FC_SIDE1_X,
          y: delBandY,
          w: FC_SIDE_W,
          h: FC_SIDE_H,
          inspector: { flow, delivery: finalDelivery, session },
        }));
      }
      if (sideDeliveries.length === 2) emitSidePair(imNode, sideDeliveries[0]!, sideDeliveries[1]!, '正文与附件', 'success');
      else if (sideDeliveries.length === 1) emitSideGrid(imNode, sideDeliveries, false, '交付内容');
    }

    const frameBottomY = delBandY + Math.max(FC_SPINE_H, sideDeliveries.length ? FC_SIDE_H : 0) + 22;
    const frameH = frameBottomY - frameTopY;
    frames.push({
      id: `frame:${flow.id}`,
      sessionId: session.id,
      flowId: flow.id,
      turnIndex: turnIdx + 1,
      turnCount: turns.length,
      title: `第 ${turnIdx + 1}/${turns.length} 轮 · ${flow.ingress.channelLabel} · #${flow.seq || '独立'}`,
      subtitle: firstTurnTitle,
      badge: linkBadge ?? statusLabel(flow.status),
      status: flow.status,
      x: FC_FRAME_X,
      y: frameTopY,
      w: FC_FRAME_W,
      h: frameH,
      collapsed: false,
      toggleKey: turns.length > 1 ? frameKey : undefined,
    });

    prevTurnTailNode = imNode;
    globalY = frameBottomY + (turnIdx < turns.length - 1 ? 66 : 28);
  });

  return {
    mode: 'session',
    width: FC_FRAME_X * 2 + FC_FRAME_W,
    height: Math.max(globalY, 320),
    frames,
    nodes,
    edges,
  };
}

export function buildOverviewFlowchart(
  sessions: MindmapSession[],
  flowsById: Map<string, MindmapTaskFlow>,
  snapshot: MindmapSnapshot | null,
  searchTerm: string,
): FlowchartGraph {
  const needle = searchTerm.trim().toLowerCase();
  const frames: FlowchartFrame[] = [];
  const nodes: FlowchartNode[] = [];
  const edges: FlowchartEdge[] = [];

  const PIPE_FRAME_X = 24;
  const PIPE_FRAME_W = 1480;
  const STAGE_W = 248;
  const STAGE_H = 74;
  const STAGE_GAP = 42;
  const START_X = PIPE_FRAME_X + 24;
  const ROW_STEP = 166;
  let y = 20;
  let edgeId = 0;

  sessions.forEach((session, sIdx) => {
    const turns = resolveSessionTurns(session, flowsById);
    const primaryFlow = turns[turns.length - 1] ?? null;
    const frameY = y;
    const nodeY = frameY + 56;
    const totalTasks = session.taskCount;
    const totalJev = session.jevCallCount;

    const addStage = (col: number, raw: Omit<FlowchartNode, 'x' | 'y' | 'w' | 'h' | 'searchText' | 'match'>, extra?: string) => {
      const searchText = nodeSearchBlob(raw.badge, raw.title, raw.subtitle, `${session.title} ${extra ?? ''}`);
      const match = Boolean(needle) && searchText.includes(needle);
      const node: FlowchartNode = {
        ...raw,
        x: START_X + col * (STAGE_W + STAGE_GAP),
        y: nodeY,
        w: STAGE_W,
        h: STAGE_H,
        searchText,
        match,
      };
      nodes.push(node);
      return node;
    };

    const s0 = addStage(0, {
      id: `${session.id}:ov:0`,
      flowId: primaryFlow?.id ?? session.id,
      sessionId: session.id,
      kind: 'session_summary',
      category: session.channels.includes('wechat') || session.channels.includes('xiaoai') ? 'im' : session.kind === 'timer' ? 'router' : 'ingress',
      shape: 'pill',
      icon: session.turnCount > 1 ? '🗂️' : sourceIcon(turns[0]?.ingress.sourceKind ?? 'local'),
      badge: `${session.turnCount > 1 ? `多轮会话 (${session.turnCount}轮)` : '单轮对话'} · ${session.primaryChannelLabel}`,
      title: shortText(session.title, 26),
      subtitle: `${formatTimeShort(session.startedAt)} ~ ${formatTimeShort(session.updatedAt)}`,
      status: session.status,
      inspector: { flow: primaryFlow, snapshot: snapshot ?? undefined, session },
    }, turns.map(t => t.ingress.text).join(' '));

    const s1 = addStage(1, {
      id: `${session.id}:ov:1`,
      flowId: primaryFlow?.id ?? session.id,
      sessionId: session.id,
      kind: 'memory_group',
      category: 'memory',
      shape: 'process',
      icon: '🧠',
      badge: 'AI 上下文 & 记忆召回',
      title: `召回 ${session.recalledMemoryCount} 条 · 沉淀 ${session.consolidatedMemoryCount} 条`,
      subtitle: session.turnCount > 1 ? '跨轮语义上下文连贯管理' : '工作空间目录记忆联想',
      status: 'completed',
      inspector: { flow: primaryFlow, snapshot: snapshot ?? undefined, session },
    });

    const firstTask = turns.flatMap(t => t.tasks)[0];
    const s2 = addStage(2, {
      id: `${session.id}:ov:2`,
      flowId: primaryFlow?.id ?? session.id,
      sessionId: session.id,
      kind: 'router_turn',
      category: 'router',
      shape: 'decision',
      icon: '◆',
      badge: 'Router & JEV 决策',
      title: totalTasks > 0
        ? `派发 ${totalTasks} 任务 · JEV ${totalJev} 次`
        : '主控直回 / 插件调度',
      subtitle: firstTask?.jevRoute?.response.selectedModel
        ? `选模 ${shortText(firstTask.jevRoute.response.selectedModel.split('/').pop(), 20)}@${firstTask.jevRoute.response.thinkingLevel ?? 'med'}`
        : `${snapshot?.summary.routerModel ?? '主控模型'}`,
      status: session.status,
      inspector: { flow: primaryFlow, task: firstTask, snapshot: snapshot ?? undefined, session },
    });

    const totalPhases = turns.flatMap(t => t.tasks).reduce((sum, t) => sum + (t.executionPhases?.length || 1), 0);
    const totalSteps = turns.flatMap(t => t.tasks).reduce((sum, t) => sum + t.totalSteps, 0);
    const lastQg = turns.flatMap(t => t.tasks).flatMap(t => t.jevQualityGates).at(-1);
    const s3 = addStage(3, {
      id: `${session.id}:ov:3`,
      flowId: primaryFlow?.id ?? session.id,
      sessionId: session.id,
      kind: 'worker_exec',
      category: totalTasks ? 'worker' : 'router',
      shape: 'subprocess',
      icon: totalTasks ? '⚙️' : '⚡',
      badge: totalTasks ? 'Worker 执行 & 质检' : '轻量化执行路径',
      title: totalTasks
        ? `${totalPhases} 轮执行 · ${totalSteps} 个步骤`
        : (turns[0]?.directPlugin ? `插件 ${turns[0].directPlugin.plugin}` : '无后台重型任务'),
      subtitle: lastQg
        ? `终检得分 ${lastQg.response.score.toFixed(2)}/${lastQg.response.maxScore}`
        : (totalTasks ? 'Worker 完成全部操作' : '即时响应完毕'),
      status: session.status,
      inspector: { flow: primaryFlow, task: firstTask, snapshot: snapshot ?? undefined, session },
    });

    const lastTurn = turns.at(-1);
    const s4 = addStage(4, {
      id: `${session.id}:ov:4`,
      flowId: primaryFlow?.id ?? session.id,
      sessionId: session.id,
      kind: 'im_delivery',
      category: 'im',
      shape: 'io',
      icon: lastTurn?.imPush.channel === 'wechat' ? '📲' : lastTurn?.imPush.channel === 'xiaoai' ? '🔊' : '📩',
      badge: `IM 交付 · ${lastTurn?.imPush.channelName ?? '控制台'}`,
      title: lastTurn?.deliveries.at(-1)?.text
        ? shortText(lastTurn.deliveries.at(-1)!.text, 26)
        : '点击进入完整思考流程图',
      subtitle: lastTurn?.imPush.delivered ? '已送达 · 双击查看全链路' : statusLabel(session.status),
      status: session.status,
      inspector: { flow: primaryFlow, delivery: lastTurn?.deliveries.at(-1), snapshot: snapshot ?? undefined, session },
    });

    const rowStages = [s0, s1, s2, s3, s4];
    for (let i = 0; i < rowStages.length - 1; i += 1) {
      const a = rowStages[i]!;
      const b = rowStages[i + 1]!;
      edges.push({
        id: `ov-edge:${++edgeId}`,
        fromId: a.id,
        toId: b.id,
        kind: 'spine',
        tone: i === 2 && totalJev > 0 ? 'accent' : i === 3 && lastTurn?.imPush.delivered ? 'success' : 'default',
        points: [{ x: a.x + a.w, y: Math.round(a.y + a.h / 2) }, { x: b.x, y: Math.round(b.y + b.h / 2) }],
      });
    }

    frames.push({
      id: `ov-frame:${session.id}`,
      sessionId: session.id,
      title: `会话 #${sIdx + 1} · ${session.title}`,
      subtitle: turns.map((t, idx) => `#${t.seq || idx + 1}:${shortText(t.ingress.text, 16)}`).join('  ➔  '),
      badge: `${session.turnCount} 轮 · 点击切换详解`,
      status: session.status,
      x: PIPE_FRAME_X,
      y: frameY,
      w: PIPE_FRAME_W,
      h: 146,
    });

    y += ROW_STEP;
  });

  return {
    mode: 'overview',
    width: PIPE_FRAME_X * 2 + PIPE_FRAME_W,
    height: Math.max(y + 20, 320),
    frames,
    nodes,
    edges,
  };
}

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Coordinator } from './coordinator.js';
import { requestGeminiDecisions, type DecisionCredentials } from './decision.js';
import type { Task } from './store.js';
import type { ChatMessage, DecisionSource, MemoryCard, MessageOrigin, MissingAspect, ModelHubView, RouteAction, SessionLinkKind, SessionTurnLink, ThinkingLevel, TraceEvent, WorkerProfile } from './view.js';

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
  source: DecisionSource | 'tier-config';
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
    thinkingLevel?: ThinkingLevel;
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
  source: DecisionSource;
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
    missingAspect: MissingAspect;
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
  profile?: WorkerProfile;
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

export type MindmapSessionLinkKind = SessionLinkKind;

export type MindmapTurnLink = SessionTurnLink;

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
    origin?: Omit<MessageOrigin, 'contextToken' | 'replyWebhook'>;
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
  routeActions: RouteAction[];
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

const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;
const SDK_META_SPANS = new Set(['Agent 请求', '模型推理调用', '上下文压缩（SDK）', '模型请求重试（SDK）']);
const SAFE_PAYLOAD_BYTES = 2_100_000;
const SESSION_AI_META_KEY = 'mindmap_session_ai_v1';
const SESSION_AI_CACHE_MAX = 400;

function clipText(value: unknown, maxLen: number): { text: string; truncated: boolean } {
  const raw = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
  if (raw.length <= maxLen) return { text: raw, truncated: false };
  return { text: `${raw.slice(0, maxLen)}…`, truncated: true };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function unwrapJsonString(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { return JSON.parse(trimmed); } catch { return raw; }
  }
  return raw;
}

function formatToolInputPreview(rawData: unknown): string | undefined {
  const rec = asRecord(rawData);
  const detail = asRecord(rec?.detail) ?? rec;
  let input = detail?.input;
  const unwrapped = unwrapJsonString(input);
  const inner = asRecord(unwrapped);
  if (inner && typeof inner.input === 'string' && Object.keys(inner).length <= 2) {
    input = unwrapJsonString(inner.input);
  } else if (inner && typeof inner.command === 'string') {
    return clipText(inner.command, 420).text;
  } else if (inner && typeof inner.path === 'string') {
    const lineInfo = inner.offset || inner.limit ? ` (offset=${inner.offset ?? 1}, limit=${inner.limit ?? ''})` : '';
    return clipText(`${inner.path}${lineInfo}`, 300).text;
  } else if (unwrapped !== undefined) {
    input = unwrapped;
  }
  if (input === undefined) return undefined;
  return clipText(input, 420).text;
}

function formatToolOutputPreview(rawData: unknown): string | undefined {
  const rec = asRecord(rawData);
  const detail = asRecord(rec?.detail) ?? rec;
  const rawPreview = detail?.preview ?? detail?.output;
  if (rawPreview === undefined) {
    const summary = asRecord(rec?.summary);
    return summary ? clipText(summary, 420).text : undefined;
  }
  const parsed = unwrapJsonString(rawPreview);
  const parsedRec = asRecord(parsed);
  if (parsedRec?.output && asRecord(parsedRec.output)?.content && Array.isArray(asRecord(parsedRec.output)?.content)) {
    const items = (asRecord(parsedRec.output)!.content as Array<Record<string, unknown>>)
      .map(c => (typeof c?.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
    if (items) return clipText(items, 520).text;
  }
  if (parsedRec?.content && Array.isArray(parsedRec.content)) {
    const items = (parsedRec.content as Array<Record<string, unknown>>)
      .map(c => (typeof c?.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
    if (items) return clipText(items, 520).text;
  }
  return clipText(parsed, 520).text;
}

function readUsageNumbers(rawUsage: unknown): { input: number; output: number; cacheRead: number; reasoning: number; totalTokens: number } | undefined {
  const u = asRecord(rawUsage);
  if (!u) return undefined;
  const input = Number(u.input ?? u.inputTokens ?? 0) || 0;
  const output = Number(u.output ?? u.outputTokens ?? 0) || 0;
  const cacheRead = Number(u.cacheRead ?? 0) || 0;
  const reasoning = Number(u.reasoning ?? 0) || 0;
  const totalTokens = Number(u.totalTokens ?? input + output + cacheRead + reasoning) || 0;
  if (!totalTokens && !input && !output) return undefined;
  return { input, output, cacheRead, reasoning, totalTokens };
}

function sanitizeOrigin(origin?: MessageOrigin): Omit<MessageOrigin, 'contextToken' | 'replyWebhook'> | undefined {
  if (!origin) return undefined;
  return {
    channel: origin.channel,
    ...(origin.channelId ? { channelId: origin.channelId } : {}),
    ...(origin.accountId ? { accountId: origin.accountId } : {}),
    ...(origin.conversationId ? { conversationId: origin.conversationId } : {}),
    ...(origin.senderId ? { senderId: origin.senderId } : {}),
    ...(origin.replyToMessageId ? { replyToMessageId: origin.replyToMessageId } : {}),
  };
}

function parseTimerTriggerName(text: string): string | undefined {
  const match = /^\[定时触发\s*·\s*([^\]]+)\]/.exec(text.trim());
  return match?.[1]?.trim();
}

const STOP_EN = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'have', 'has', 'had',
  'can', 'could', 'will', 'would', 'should', 'what', 'when', 'where', 'which', 'who', 'how', 'why',
  'not', 'but', 'all', 'any', 'use', 'using', 'into', 'out', 'about', 'just', 'like', 'some', 'more',
  'your', 'you', 'our', 'their', 'http', 'https', 'com', 'org', 'net', 'www', 'true', 'false', 'null',
  'undefined', 'file', 'files', 'code', 'test', 'json', 'markdown', 'users', 'duty', 'friday',
]);

const STOP_CJK = new Set([
  '可以', '怎么', '什么', '一下', '一个', '现在', '今天', '昨天', '明天', '自己', '不会', '帮我', '看看', '觉得',
  '为什么', '有没有', '是不是', '还是', '或者', '以及', '如果', '因为', '所以', '但是', '不过', '就是', '这个', '那个',
  '这些', '那些', '这里', '那里', '这样', '那样', '你们', '我们', '他们', '老板', '主控', '任务', '继续', '进行',
  '开始', '完成', '一下吗', '可以吗', '行不行', '好不好', '怎么说', '搞定', '看看吧', '说说', '分析', '一下这',
]);

function extractEntities(text: string): { all: Set<string>; eng: Set<string> } {
  const clean = text.replace(/[\r\n]+/g, ' ').trim();
  const eng = new Set<string>();
  const all = new Set<string>();
  for (const m of clean.matchAll(/[A-Za-z][A-Za-z0-9._-]{2,}/g)) {
    const tok = m[0].toLowerCase().replace(/^[._-]+|[._-]+$/g, '');
    if (tok.length >= 3 && !STOP_EN.has(tok) && !/^\d+$/.test(tok)) {
      eng.add(tok);
      all.add(tok);
    }
  }
  for (const m of clean.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const seq = m[0];
    if (seq.length <= 6 && !STOP_CJK.has(seq)) all.add(seq);
    if (seq.length > 2) {
      for (let i = 0; i <= seq.length - 2; i += 1) {
        const bg = seq.slice(i, i + 2);
        if (!STOP_CJK.has(bg)) all.add(bg);
      }
    }
  }
  return { all, eng };
}

function formatGapCompact(gapSec: number): string {
  const s = Math.max(0, Math.round(gapSec));
  if (s < 60) return `+${s}秒`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `+${m}分${rem}秒` : `+${m}分钟`;
}

function extractTaskHeadline(prompt: string): string | undefined {
  const m = /【任务：([^】\n]+)】/.exec(prompt);
  const title = m?.[1]?.trim();
  if (!title) return undefined;
  return title.length <= 36 ? title : `${title.slice(0, 35)}…`;
}

function detectAssistantQuestion(text: string): boolean {
  const tail = text.trim().slice(-90);
  if (!tail) return false;
  if (/[？?]\s*$/.test(tail)) return true;
  return /(?:你说一声|说一句|告诉我|确认一下|指哪个|哪一个|哪方面|要不要我|请确认|需要哪)/.test(tail);
}

const STRONG_BACKREF_RE = /^(那|那么|还有|另外|顺便|接着|继续|刚才|上面|前面|上一个|前一个|同一个|这几个|那几个|再把|再帮|再看|再查|不对|不是这个|我是说|我说的是|换个|换成|是(?:吗|的|吧|哦|这|那)?\b|是\s)/;
const INLINE_BACKREF_RE = /(刚才|上面说|前面说|上一个任务|接着刚才|你自己不会|你不会去|还没完|之前那个)/;
const STANDALONE_OPENER_RE = /^(帮我定时|每天|每周|早上|晚上|查一下天气|看下天气|帮我看下今天|给我总结一下今天)/;

async function resolveMindmapDecisionCredentials(
  home: string | undefined,
  modelHubView: ModelHubView,
): Promise<DecisionCredentials | undefined> {
  if (modelHubView.mode !== 'real' || !modelHubView.decisionEngine?.enabled || !modelHubView.decisionEngine?.configured) {
    return undefined;
  }
  const baseUrl = modelHubView.decisionEngine.baseUrl;
  const envDecisionKey = process.env.SUPER_AGENT_DECISION_API_KEY?.trim();
  if (envDecisionKey) return { apiKey: envDecisionKey, baseUrl, timeoutMs: 2800 };

  if (home) {
    try {
      const raw = await readFile(join(home, 'sdk', 'model-hub.json'), 'utf8');
      const parsed = JSON.parse(raw) as {
        decision?: { apiKey?: string };
        providers?: { google?: { apiKey?: string } };
      };
      const fileKey = parsed.decision?.apiKey?.trim() || parsed.providers?.google?.apiKey?.trim();
      if (fileKey) return { apiKey: fileKey, baseUrl, timeoutMs: 2800 };
    } catch { /* ignore unreadable config */ }
  }

  const envGoogleKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (envGoogleKey) return { apiKey: envGoogleKey, baseUrl, timeoutMs: 2800 };
  return undefined;
}

type SessionAiCacheEntry = { same: boolean; prob: number; at: number };

interface PendingSessionAiEval {
  pairKey: string;
  prevFlow: MindmapTaskFlow;
  curFlow: MindmapTaskFlow;
  gapSec: number;
}

interface HeuristicEval {
  same: boolean;
  kind: MindmapSessionLinkKind;
  label: string;
  detail?: string;
}

function evaluateHeuristicSessionLink(
  prevFlows: MindmapTaskFlow[],
  prevFlow: MindmapTaskFlow,
  curFlow: MindmapTaskFlow,
  recentUserEntities: Array<{ all: Set<string>; eng: Set<string> }>,
  lastAssistantAsked: boolean,
  gapSec: number,
): HeuristicEval | undefined {
  const cleanText = curFlow.ingress.text.replace(/\s+/g, ' ').trim();
  const sameChannel = prevFlow.ingress.sourceKind === curFlow.ingress.sourceKind;

  if (lastAssistantAsked && gapSec <= 420) {
    return {
      same: true,
      kind: 'answer_clarification',
      label: `💬 ${formatGapCompact(gapSec)} · 回答主控澄清追问`,
    };
  }
  if (cleanText.length <= 6 && gapSec <= 240) {
    return {
      same: true,
      kind: 'dialogue_followup',
      label: `💬 ${formatGapCompact(gapSec)} · 短语追问延续`,
    };
  }
  if (prevFlow.tasks.length > 0 && sameChannel && gapSec <= 260 && !STANDALONE_OPENER_RE.test(cleanText)) {
    return {
      same: true,
      kind: 'post_task_discussion',
      label: `🔗 ${formatGapCompact(gapSec)} · 围绕上一任务继续讨论`,
    };
  }
  const curEnt = extractEntities(cleanText);
  let engMatches = 0;
  let allMatches = 0;
  const seenPrev = new Set<string>();
  const seenPrevEng = new Set<string>();
  for (const bucket of recentUserEntities) {
    for (const e of bucket.eng) seenPrevEng.add(e);
    for (const e of bucket.all) seenPrev.add(e);
  }
  for (const e of curEnt.eng) if (seenPrevEng.has(e)) engMatches += 1;
  for (const e of curEnt.all) if (seenPrev.has(e)) allMatches += 1;
  if ((engMatches >= 1 || allMatches >= 2) && gapSec <= 600) {
    return {
      same: true,
      kind: 'topic_continuity',
      label: `🧠 ${formatGapCompact(gapSec)} · 同主题实体延续`,
    };
  }
  if (sameChannel && gapSec <= 90 && !STANDALONE_OPENER_RE.test(cleanText) && prevFlows.length > 0) {
    return {
      same: true,
      kind: 'rapid_exchange',
      label: `⚡ ${formatGapCompact(gapSec)} · 同端快速连续对话`,
    };
  }
  return undefined;
}

function checkCausalSessionLink(
  activeTaskIds: Set<string>,
  activeMsgIds: Set<string>,
  recentUserEntities: Array<{ all: Set<string>; eng: Set<string> }>,
  prevFlow: MindmapTaskFlow,
  curFlow: MindmapTaskFlow,
  lastAssistantAsked: boolean,
  lastSwitchedChannel: boolean,
  gapSec: number,
): MindmapTurnLink | undefined {
  // 1) Shared or parent taskId
  for (const t of curFlow.tasks) {
    if (activeTaskIds.has(t.id) || (t.parentTaskId && activeTaskIds.has(t.parentTaskId))) {
      return {
        kind: 'task_link',
        source: 'causal',
        gapSec,
        label: `🔗 续接后台任务 #${t.id.slice(0, 6)}`,
      };
    }
  }
  for (const act of curFlow.routeActions) {
    if (act.taskId && activeTaskIds.has(act.taskId)) {
      return {
        kind: 'task_link',
        source: 'causal',
        gapSec,
        label: `🔗 关联后台任务 #${act.taskId.slice(0, 6)}`,
      };
    }
    if (act.messageIds?.some(mid => activeMsgIds.has(mid))) {
      return {
        kind: 'msg_link',
        source: 'causal',
        gapSec,
        label: '🔗 引用前序会话消息',
      };
    }
  }
  // 2) Channel switch
  if (lastSwitchedChannel && gapSec <= 600) {
    return {
      kind: 'switch_channel',
      source: 'causal',
      gapSec,
      label: `📱 ${formatGapCompact(gapSec)} · 跨端切换继续对话`,
    };
  }
  // 3) Immediate burst
  if (gapSec <= 15) {
    return {
      kind: 'in_flight',
      source: 'causal',
      gapSec,
      label: `⚡ ${formatGapCompact(gapSec)} · 连续补充输入`,
    };
  }
  const cleanText = curFlow.ingress.text.replace(/\s+/g, ' ').trim();
  // 4) Explicit back-reference
  if (gapSec <= 1800 && (STRONG_BACKREF_RE.test(cleanText) || INLINE_BACKREF_RE.test(cleanText))) {
    return {
      kind: 'explicit_backref',
      source: 'causal',
      gapSec,
      label: `🔗 ${formatGapCompact(gapSec)} · 上下文追问与指代延续`,
    };
  }
  // 5) AI context synthesis: Router combines previous turn user entities into current task prompt/contextBrief
  if (gapSec <= 480 && curFlow.tasks.length > 0) {
    const curUserEnt = extractEntities(cleanText);
    const prevUniqueAll = new Set<string>();
    const prevUniqueEng = new Set<string>();
    for (const bucket of recentUserEntities) {
      for (const e of bucket.eng) if (!curUserEnt.eng.has(e)) prevUniqueEng.add(e);
      for (const e of bucket.all) if (!curUserEnt.all.has(e)) prevUniqueAll.add(e);
    }
    const synthesized = curFlow.tasks
      .map(t => `${t.prompt} ${t.contextBrief ?? ''}`)
      .join(' ');
    const synthEnt = extractEntities(synthesized);
    const hitEng: string[] = [];
    const hitAll: string[] = [];
    for (const e of prevUniqueEng) if (synthEnt.eng.has(e)) hitEng.push(e);
    for (const e of prevUniqueAll) if (synthEnt.all.has(e)) hitAll.push(e);
    if (hitEng.length >= 1 || hitAll.length >= 2) {
      const sample = [...new Set([...hitEng, ...hitAll])].slice(0, 3).join(', ');
      return {
        kind: 'ai_context_synthesis',
        source: 'causal',
        gapSec,
        label: `🧠 ${formatGapCompact(gapSec)} · AI 合成前序轮次意图派单`,
        detail: sample ? `主控在任务指令中自动融入前序关键实体: ${sample}` : undefined,
      };
    }
  }
  // 6) Direct answer to assistant clarification question
  const sameChannel = prevFlow.ingress.sourceKind === curFlow.ingress.sourceKind;
  if (lastAssistantAsked && sameChannel && gapSec <= 180) {
    return {
      kind: 'answer_clarification',
      source: 'causal',
      gapSec,
      label: `💬 ${formatGapCompact(gapSec)} · 回答主控澄清追问`,
    };
  }
  return undefined;
}

function synthesizeSessionTitle(turns: MindmapTaskFlow[]): string {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    for (const t of turns[i]!.tasks) {
      const headline = extractTaskHeadline(t.prompt);
      if (headline) return headline;
    }
  }
  const first = turns[0]!;
  if (first.ingress.timerInfo?.name) return `⏱️ ${first.ingress.timerInfo.name}`;
  const cleanFirst = first.ingress.text.replace(/\s+/g, ' ').trim();
  if (turns.length > 1 && cleanFirst.length < 10) {
    const cleanSecond = turns[1]!.ingress.text.replace(/\s+/g, ' ').trim();
    const combined = `${cleanFirst} · ${cleanSecond}`;
    return combined.length <= 36 ? combined : `${combined.slice(0, 35)}…`;
  }
  return cleanFirst.length <= 36 ? cleanFirst : `${cleanFirst.slice(0, 35)}…`;
}

async function groupFlowsIntoSessions(
  flowsNewestFirst: MindmapTaskFlow[],
  store: Coordinator['store'],
  home: string | undefined,
  modelHubView: ModelHubView,
): Promise<MindmapSession[]> {
  const chronological = [...flowsNewestFirst].sort((a, b) => (a.createdAt - b.createdAt) || (a.seq - b.seq));
  const persistedGroups = new Map<string, MindmapTaskFlow[]>();
  const legacyChronological: MindmapTaskFlow[] = [];
  for (const flow of chronological) {
    if (flow.sessionPersisted && flow.sessionId) {
      const bucket = persistedGroups.get(flow.sessionId) ?? [];
      bucket.push(flow);
      persistedGroups.set(flow.sessionId, bucket);
    } else {
      legacyChronological.push(flow);
    }
  }

  let legacyGroups: MindmapTaskFlow[][] = [];
  if (legacyChronological.length > 0) {
    const aiCache = { ...(store.conversation.meta<Record<string, SessionAiCacheEntry>>(SESSION_AI_META_KEY) ?? {}) };

    // First pass: identify middle-zone pairs needing AI judgment that are not yet cached
    const pendingPairs: PendingSessionAiEval[] = [];
    let scanLastHuman: MindmapTaskFlow | undefined;
    const scanTaskIds = new Set<string>();
    const scanMsgIds = new Set<string>();
    let scanEntities: Array<{ all: Set<string>; eng: Set<string> }> = [];
    let scanLastAsked = false;
    let scanLastSwitched = false;

    for (const flow of legacyChronological) {
      const isHuman = flow.ingress.sourceKind !== 'timer' && flow.ingress.sourceKind !== 'standalone';
      if (!isHuman) continue;
      if (scanLastHuman) {
        const gapSec = Math.max(0, Math.round((flow.createdAt - scanLastHuman.createdAt) / 1000));
        const causal = checkCausalSessionLink(
          scanTaskIds,
          scanMsgIds,
          scanEntities,
          scanLastHuman,
          flow,
          scanLastAsked,
          scanLastSwitched,
          gapSec,
        );
        if (!causal && gapSec > 15 && gapSec <= 2700) {
          const pairKey = `${scanLastHuman.id}->${flow.id}`;
          if (!aiCache[pairKey]) {
            pendingPairs.push({ pairKey, prevFlow: scanLastHuman, curFlow: flow, gapSec });
          }
        }
      }
      scanLastHuman = flow;
      for (const t of flow.tasks) scanTaskIds.add(t.id);
      if (flow.ingress.messageId) scanMsgIds.add(flow.ingress.messageId);
      for (const d of flow.deliveries) scanMsgIds.add(d.messageId);
      scanEntities = [...scanEntities.slice(-3), extractEntities(flow.ingress.text)];
      const lastReply = flow.deliveries.at(-1)?.text || flow.routerTurns.at(-1)?.outputPreview || '';
      scanLastAsked = detectAssistantQuestion(lastReply);
      scanLastSwitched = flow.routeActions.some(a => a.kind === 'switch_channel');
    }

    // Batch up to 20 uncached middle-zone transitions via gemini-decision-1 when real & configured
    if (pendingPairs.length > 0) {
      const creds = await resolveMindmapDecisionCredentials(home, modelHubView);
      if (creds) {
        const batch = pendingPairs.slice(-20);
        const inputLines = batch.map((p, idx) => {
          const prevReply = (p.prevFlow.deliveries.at(-1)?.text || p.prevFlow.routerTurns.at(-1)?.outputPreview || '(无)')
            .replace(/\s+/g, ' ').slice(0, 140);
          const prevMsg = p.prevFlow.ingress.text.replace(/\s+/g, ' ').slice(0, 120);
          const curMsg = p.curFlow.ingress.text.replace(/\s+/g, ' ').slice(0, 140);
          return `[pair_${idx}] prev(${p.prevFlow.ingress.sourceKind}): "${prevMsg}" -> assistant: "${prevReply}" | +${p.gapSec}s cur(${p.curFlow.ingress.sourceKind}): "${curMsg}"`;
        });
        const questions: Record<string, { type: 'noul'; instructions: string }> = {};
        batch.forEach((p, idx) => {
          questions[`q_${idx}`] = {
            type: 'noul',
            instructions: `For [pair_${idx}] (gap ${p.gapSec}s), return high probability (>=0.5) if cur is a continuation, followup, clarification, answer, or reaction within the SAME conversation session as prev; return low probability (<0.5) if cur starts a brand new unrelated topic/request.`,
          };
        });
        try {
          const res = await requestGeminiDecisions(
            creds,
            `Determine whether consecutive Boss messages belong to the SAME implicit AI conversation session:\n${inputLines.join('\n')}`,
            questions,
          );
          let updated = false;
          batch.forEach((p, idx) => {
            const ans = res.answers[`q_${idx}`];
            const prob = typeof ans?.noul === 'number'
              ? Math.max(0, Math.min(1, ans.noul))
              : typeof ans?.probabilities?.true === 'number'
                ? Math.max(0, Math.min(1, ans.probabilities.true))
                : undefined;
            if (prob !== undefined) {
              aiCache[p.pairKey] = { same: prob >= 0.5, prob, at: Date.now() };
              updated = true;
            }
          });
          if (updated) {
            const entries = Object.entries(aiCache).sort((a, b) => b[1].at - a[1].at).slice(0, SESSION_AI_CACHE_MAX);
            store.conversation.setMeta(SESSION_AI_META_KEY, Object.fromEntries(entries));
          }
        } catch {
          // Fallback smoothly to deterministic + heuristic session grouping
        }
      }
    }

    // Second pass: assemble chronological sessions for unpersisted legacy flows
    const isolatedSessions: MindmapTaskFlow[][] = [];
    const humanGroups: MindmapTaskFlow[][] = [];

    let activeGroup: MindmapTaskFlow[] = [];
    const activeTaskIds = new Set<string>();
    const activeMsgIds = new Set<string>();
    let recentEntities: Array<{ all: Set<string>; eng: Set<string> }> = [];
    let lastAsked = false;
    let lastSwitched = false;

    const resetActiveState = () => {
      activeTaskIds.clear();
      activeMsgIds.clear();
      recentEntities = [];
      lastAsked = false;
      lastSwitched = false;
    };

    for (const flow of legacyChronological) {
      const isHuman = flow.ingress.sourceKind !== 'timer' && flow.ingress.sourceKind !== 'standalone';
      if (!isHuman) {
        isolatedSessions.push([flow]);
        continue;
      }

      if (activeGroup.length === 0) {
        activeGroup = [flow];
        humanGroups.push(activeGroup);
      } else {
        const prevFlow = activeGroup[activeGroup.length - 1]!;
        const gapSec = Math.max(0, Math.round((flow.createdAt - prevFlow.createdAt) / 1000));
        let link = checkCausalSessionLink(
          activeTaskIds,
          activeMsgIds,
          recentEntities,
          prevFlow,
          flow,
          lastAsked,
          lastSwitched,
          gapSec,
        );

        if (!link && gapSec <= 2700) {
          const heuristic = evaluateHeuristicSessionLink(activeGroup, prevFlow, flow, recentEntities, lastAsked, gapSec);
          const pairKey = `${prevFlow.id}->${flow.id}`;
          const ai = aiCache[pairKey];
          const sameChannel = prevFlow.ingress.sourceKind === flow.ingress.sourceKind;
          if (ai) {
            if (ai.prob >= 0.5 || (heuristic?.same && sameChannel && gapSec <= 120 && ai.prob >= 0.3)) {
              link = {
                kind: heuristic?.kind ?? 'dialogue_followup',
                source: 'gemini-decision-1',
                gapSec,
                confidence: Number(ai.prob.toFixed(2)),
                label: `🎯 ${formatGapCompact(gapSec)} · JEV 语义判定延续 (${Math.round(ai.prob * 100)}%)`,
                detail: heuristic?.label,
              };
            }
          } else if (heuristic?.same) {
            link = {
              kind: heuristic.kind,
              source: 'heuristic',
              gapSec,
              label: heuristic.label,
              detail: heuristic.detail,
            };
          }
        }

        if (link) {
          flow.sessionLink = link;
          activeGroup.push(flow);
        } else {
          resetActiveState();
          activeGroup = [flow];
          humanGroups.push(activeGroup);
        }
      }

      for (const t of flow.tasks) activeTaskIds.add(t.id);
      if (flow.ingress.messageId) activeMsgIds.add(flow.ingress.messageId);
      for (const d of flow.deliveries) activeMsgIds.add(d.messageId);
      recentEntities = [...recentEntities.slice(-3), extractEntities(flow.ingress.text)];
      const lastReply = flow.deliveries.at(-1)?.text || flow.routerTurns.at(-1)?.outputPreview || '';
      lastAsked = detectAssistantQuestion(lastReply);
      lastSwitched = flow.routeActions.some(a => a.kind === 'switch_channel');
    }
    legacyGroups = [...humanGroups, ...isolatedSessions];
  }

  const allGroups = [...persistedGroups.values(), ...legacyGroups];
  const sessions: MindmapSession[] = allGroups.map(turns => {
    turns.sort((a, b) => (a.createdAt - b.createdAt) || (a.seq - b.seq));
    const first = turns[0]!;
    const last = turns[turns.length - 1]!;
    const sessionId = first.sessionPersisted && first.sessionId ? first.sessionId : `session:${first.id}`;
    const kind: MindmapSession['kind'] = first.ingress.sourceKind === 'timer'
      ? 'timer'
      : first.ingress.sourceKind === 'standalone'
        ? 'standalone'
        : 'human';

    const channels: MindmapSession['channels'] = [];
    for (const t of turns) {
      if (!channels.includes(t.ingress.sourceKind)) channels.push(t.ingress.sourceKind);
    }

    let taskCount = 0;
    let jevCallCount = 0;
    let recalledMemoryCount = 0;
    let consolidatedMemoryCount = 0;
    let aiManagedContext = turns.some((t, idx) => idx > 0 && Boolean(t.sessionLink));

    const turnSummaries: MindmapSessionTurnSummary[] = turns.map((t, idx) => {
      if (idx === 0 && t.sessionLink) {
        // First loaded turn in page whose predecessor fell before the loaded page keeps its native link
      }
      t.sessionId = sessionId;
      t.turnIndex = idx + 1;
      t.turnCount = turns.length;
      taskCount += t.tasks.length;
      recalledMemoryCount += t.memoryRecall.recalledItems.length;
      consolidatedMemoryCount += t.consolidatedMemories.length;
      if (t.sessionLink?.source === 'gemini-decision-1') jevCallCount += 1;
      for (const task of t.tasks) {
        if (task.jevRoute?.called) jevCallCount += 1;
        jevCallCount += task.jevQualityGates.length;
        if (task.contextBrief || task.compiledMemories.length > 0) aiManagedContext = true;
      }
      if (t.memoryRecall.recalledItems.length > 0 || t.consolidatedMemories.length > 0) aiManagedContext = true;
      return {
        flowId: t.id,
        seq: t.seq,
        at: t.createdAt,
        sourceKind: t.ingress.sourceKind,
        channelLabel: t.ingress.channelLabel,
        textPreview: clipText(t.ingress.text.replace(/\s+/g, ' ').trim(), 120).text,
        status: t.status,
        taskIds: t.tasks.map(tk => tk.id),
        ...(t.sessionLink ? { link: t.sessionLink } : {}),
      };
    });

    const updatedAt = Math.max(
      ...turns.map(t => Math.max(t.createdAt, t.completedAt ?? 0, ...(t.deliveries.map(d => d.at)))),
    );
    const status = last.status;

    return {
      id: sessionId,
      title: synthesizeSessionTitle(turns),
      kind,
      status,
      startedAt: first.createdAt,
      updatedAt,
      channels,
      primaryChannelLabel: first.ingress.channelLabel,
      turnCount: turns.length,
      taskCount,
      jevCallCount,
      recalledMemoryCount,
      consolidatedMemoryCount,
      aiManagedContext,
      turnFlowIds: turns.map(t => t.id),
      turnSummaries,
    };
  });

  sessions.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.startedAt - a.startedAt));
  return sessions;
}

export async function buildMindmapSnapshot(
  coordinator: Coordinator,
  options?: { home?: string; beforeSeq?: number; limit?: number },
): Promise<MindmapSnapshot> {
  const store = coordinator.store;
  const limit = Math.max(1, Math.min(options?.limit ?? 120, 200));
  const cursor = store.conversation.latestSeq();
  const page = store.conversation.userTurnsPage(options?.beforeSeq, limit);

  const allTasks = store.list();
  const tasksById = new Map(allTasks.map(t => [t.id, t]));
  const tasksByOriginMsg = new Map<string, Task[]>();
  const orphanTasks: Task[] = [];
  for (const task of allTasks) {
    if (task.originMessageId) {
      const bucket = tasksByOriginMsg.get(task.originMessageId) ?? [];
      bucket.push(task);
      tasksByOriginMsg.set(task.originMessageId, bucket);
    } else {
      orphanTasks.push(task);
    }
  }

  const includeOrphans = options?.beforeSeq === undefined;
  const userMessageIds = page.items.map(m => m.id);
  const replies = store.conversation.repliesForMessages(userMessageIds);
  const repliesByParent = new Map<string, ChatMessage[]>();
  for (const r of replies) {
    if (!r.replyTo) continue;
    const bucket = repliesByParent.get(r.replyTo) ?? [];
    bucket.push(r);
    repliesByParent.set(r.replyTo, bucket);
  }

  // Gather all task IDs linked via either originMessageId or message_tasks join table
  const flowTaskMap = new Map<string, Task[]>();
  const scopeTaskIds = new Set<string>();
  const scopeMsgIds = new Set<string>([...userMessageIds, ...replies.map(r => r.id)]);

  for (const msg of page.items) {
    const combined = new Map<string, Task>();
    for (const t of tasksByOriginMsg.get(msg.id) ?? []) combined.set(t.id, t);
    for (const tid of msg.taskIds) {
      const found = tasksById.get(tid);
      if (found) combined.set(found.id, found);
    }
    const sorted = [...combined.values()].sort((a, b) => a.createdAt - b.createdAt);
    flowTaskMap.set(msg.id, sorted);
    for (const t of sorted) scopeTaskIds.add(t.id);
  }
  if (includeOrphans) {
    for (const t of orphanTasks) scopeTaskIds.add(t.id);
  }

  const journalEvents = store.conversation.structuredJournalForScopes([...scopeMsgIds], [...scopeTaskIds]);
  const allMemories = store.listMemories({ includeSuperseded: true, limit: 500 });
  const memoryById = new Map<string, MemoryCard>(allMemories.map(c => [c.id, c]));
  const activeMemoriesCount = allMemories.filter(c => !c.supersededBy).length;
  const imChannels = store.listImChannelViews();
  const channelById = new Map(imChannels.map(ch => [ch.id, ch]));
  const timers = store.listTimers();
  const modelHubView = await coordinator.modelHub.getView();

  const buildRouterTurns = (events: TraceEvent[]): MindmapRouterTurn[] => {
    const reqSpans = new Map<string, { start?: TraceEvent; end?: TraceEvent }>();
    const llmSpans = new Map<string, { start?: TraceEvent; end?: TraceEvent }>();
    const toolSpans = new Map<string, { start?: TraceEvent; end?: TraceEvent }>();
    const orderedReqIds: string[] = [];

    for (const ev of events) {
      if (ev.actor !== 'router' || ev.type !== 'trace' || ev.kind !== 'span' || !ev.spanId) continue;
      if (ev.label === 'Agent 请求') {
        const entry = reqSpans.get(ev.spanId) ?? {};
        if (ev.status === 'started') {
          if (!reqSpans.has(ev.spanId)) orderedReqIds.push(ev.spanId);
          entry.start = ev;
        } else {
          if (!reqSpans.has(ev.spanId)) orderedReqIds.push(ev.spanId);
          entry.end = ev;
        }
        reqSpans.set(ev.spanId, entry);
      } else if (ev.label === '模型推理调用') {
        const entry = llmSpans.get(ev.spanId) ?? {};
        if (ev.status === 'started') entry.start = ev; else entry.end = ev;
        llmSpans.set(ev.spanId, entry);
      } else if (!SDK_META_SPANS.has(ev.label)) {
        const entry = toolSpans.get(ev.spanId) ?? {};
        if (ev.status === 'started') entry.start = ev; else entry.end = ev;
        toolSpans.set(ev.spanId, entry);
      }
    }

    const turnsById = new Map<string, MindmapRouterTurn>();
    for (const reqId of orderedReqIds) {
      const pair = reqSpans.get(reqId)!;
      const startData = asRecord(pair.start?.data);
      const trigger = asRecord(startData?.trigger);
      const endData = asRecord(pair.end?.data);
      const startedAt = pair.start?.at ?? pair.end?.at ?? 0;
      const endedAt = pair.end?.at;
      turnsById.set(reqId, {
        spanId: reqId,
        triggerKind: typeof trigger?.kind === 'string' ? trigger.kind : 'CHAT',
        startedAt,
        endedAt,
        durationMs: endedAt && startedAt ? Math.max(0, endedAt - startedAt) : undefined,
        status: pair.end?.status ?? pair.start?.status ?? 'started',
        llmTurns: 0,
        usage: undefined,
        outputPreview: typeof endData?.output === 'string' ? clipText(endData.output, 360).text : undefined,
        tools: [],
      });
    }

    // Associate LLM turn metrics with their parent Agent 请求
    for (const pair of llmSpans.values()) {
      const parentId = pair.end?.parentSpanId ?? pair.start?.parentSpanId;
      const turn = parentId ? turnsById.get(parentId) : undefined;
      if (!turn) continue;
      turn.llmTurns += 1;
      const detail = asRecord(asRecord(pair.end?.data)?.detail);
      const u = readUsageNumbers(detail?.usage);
      if (u) {
        const cur = turn.usage ?? { input: 0, output: 0, cacheRead: 0, reasoning: 0, totalTokens: 0 };
        turn.usage = {
          input: cur.input + u.input,
          output: cur.output + u.output,
          cacheRead: cur.cacheRead + u.cacheRead,
          reasoning: cur.reasoning + u.reasoning,
          totalTokens: cur.totalTokens + u.totalTokens,
        };
      }
    }

    // Map LLM spanId -> Agent 请求 spanId so tool calls resolve to their owning Router turn
    const llmToReq = new Map<string, string>();
    for (const [lid, pair] of llmSpans.entries()) {
      const pid = pair.end?.parentSpanId ?? pair.start?.parentSpanId;
      if (pid && turnsById.has(pid)) llmToReq.set(lid, pid);
    }

    for (const [tid, pair] of toolSpans.entries()) {
      const first = pair.start ?? pair.end!;
      const last = pair.end ?? pair.start!;
      const parentId = first.parentSpanId ?? '';
      const reqId = turnsById.has(parentId) ? parentId : llmToReq.get(parentId) ?? orderedReqIds[0];
      const turn = reqId ? turnsById.get(reqId) : undefined;
      const startAt = pair.start?.at ?? last.at;
      const endAt = pair.end?.at;
      const toolCall: MindmapRouterToolCall = {
        spanId: tid,
        toolName: first.label,
        status: last.status,
        at: startAt,
        durationMs: endAt && startAt ? Math.max(0, endAt - startAt) : undefined,
        inputPreview: formatToolInputPreview(pair.start?.data),
        outputPreview: formatToolOutputPreview(pair.end?.data),
      };
      if (turn) {
        turn.tools.push(toolCall);
      } else {
        const syntheticId = `synthetic:${first.at}`;
        const synthetic: MindmapRouterTurn = {
          spanId: syntheticId,
          triggerKind: 'CHAT',
          startedAt: startAt,
          status: last.status,
          llmTurns: 0,
          tools: [toolCall],
        };
        turnsById.set(syntheticId, synthetic);
      }
    }

    return [...turnsById.values()].sort((a, b) => a.startedAt - b.startedAt);
  };

  const buildTaskDetail = (
    task: Task,
    taskEvents: TraceEvent[],
    routerTurns: MindmapRouterTurn[],
    claimedReportSpans: Set<string>,
  ): MindmapTaskDetail => {
    const ops = store.operations(task.id);
    const opsById = new Map(ops.map(op => [op.id, op]));
    const followups = store.events(task.id);
    const succeededOps = ops.filter(op => op.status === 'succeeded').length;
    const failedOps = ops.filter(op => op.status === 'failed' || op.status === 'unknown').length;

    // 1) JEV 选模信息
    const routeSpan = taskEvents.find(ev => ev.spanId === `${task.id}:decision:route` || ev.label === 'Gemini Decision 1 选模定级');
    const routeData = asRecord(routeSpan?.data);
    const routeReq = asRecord(routeData?.request);
    const hasImages = (task.paths ?? []).some(p => IMAGE_FILE_RE.test(p))
      || task.files.some(f => IMAGE_FILE_RE.test(f.name))
      || IMAGE_FILE_RE.test(task.prompt);

    const jevRoute: MindmapJevRouteInfo | undefined = (routeSpan || task.decisionSource || task.workerModel)
      ? {
          called: Boolean(routeSpan || task.decisionSource),
          source: (routeData?.source as DecisionSource | undefined) ?? task.decisionSource ?? 'tier-config',
          status: routeSpan?.status === 'fallback'
            ? 'fallback'
            : (routeData?.source === 'gemini-decision-1' || task.decisionSource === 'gemini-decision-1')
              ? 'completed'
              : (routeData?.source === 'heuristic' || task.decisionSource === 'heuristic')
                ? 'fallback'
                : 'static',
          at: routeSpan?.at ?? task.createdAt,
          request: {
            endpoint: typeof routeReq?.endpoint === 'string' ? routeReq.endpoint : '/v1beta/decisions',
            decisionModel: typeof routeReq?.decisionModel === 'string' ? routeReq.decisionModel : 'gemini-decision-1',
            profile: typeof routeReq?.profile === 'string' ? routeReq.profile : (task.profile ?? 'general'),
            ...(typeof routeReq?.preferredTier === 'string' ? { preferredTier: routeReq.preferredTier } : task.modelTier ? { preferredTier: task.modelTier } : {}),
            ...(typeof routeReq?.preferredLevel === 'string' ? { preferredLevel: routeReq.preferredLevel } : {}),
            fileCount: typeof routeReq?.fileCount === 'number' ? routeReq.fileCount : (task.paths?.length || task.files.length),
            hasImages: typeof routeReq?.hasImages === 'boolean' ? routeReq.hasImages : hasImages,
            isTimer: typeof routeReq?.isTimer === 'boolean' ? routeReq.isTimer : task.requestId.startsWith('timer:'),
            ...(typeof routeReq?.candidateCount === 'number' ? { candidateCount: routeReq.candidateCount } : {}),
            ...(Array.isArray(routeReq?.excludedSpecs) ? { excludedSpecs: routeReq.excludedSpecs.map(String) } : {}),
            ...(Array.isArray(routeReq?.excludedProviders) ? { excludedProviders: routeReq.excludedProviders.map(String) } : {}),
            instructionPreview: typeof routeReq?.instructionPreview === 'string'
              ? routeReq.instructionPreview
              : clipText(task.prompt, 240).text,
          },
          response: {
            selectedModel: (typeof routeData?.model === 'string' ? routeData.model : undefined) ?? task.workerModel,
            modelTier: task.modelTier,
            thinkingLevel: (routeData?.thinkingLevel as ThinkingLevel | undefined) ?? task.thinkingLevel,
            confidence: typeof routeData?.confidence === 'number' ? routeData.confidence : task.decisionConfidence,
            needsQualityGate: typeof routeData?.needsQualityGate === 'boolean'
              ? routeData.needsQualityGate
              : (task.skipQualityGate ? false : undefined),
            needsQualityGateProb: typeof routeData?.needsQualityGateProb === 'number' ? routeData.needsQualityGateProb : undefined,
            usage: asRecord(routeData?.usage)
              ? {
                  inputTokens: Number(asRecord(routeData?.usage)?.inputTokens ?? 0),
                  totalTokens: Number(asRecord(routeData?.usage)?.totalTokens ?? 0),
                }
              : undefined,
            fallbackReason: typeof routeData?.fallbackReason === 'string' ? routeData.fallbackReason : undefined,
          },
        }
      : undefined;

    // 2) JEV 完成度质检 Spans（支持同一任务多轮质检）
    const qualitySpans = taskEvents.filter(ev => ev.spanId === `${task.id}:decision:quality` || ev.label === 'Gemini Decision 1 完成度评估');
    const jevQualityGates: MindmapJevQualityGateItem[] = [];
    if (qualitySpans.length) {
      qualitySpans.forEach((qs, idx) => {
        const d = asRecord(qs.data);
        const qReq = asRecord(d?.request);
        const src = (d?.source as DecisionSource | undefined) ?? 'heuristic';
        jevQualityGates.push({
          index: idx + 1,
          at: qs.at,
          source: src,
          status: qs.status === 'fallback' ? 'fallback' : d?.skippedByRoute ? 'skipped' : 'completed',
          request: {
            endpoint: typeof qReq?.endpoint === 'string' ? qReq.endpoint : '/v1beta/decisions',
            decisionModel: typeof qReq?.decisionModel === 'string' ? qReq.decisionModel : 'gemini-decision-1',
            profile: typeof qReq?.profile === 'string' ? qReq.profile : (task.profile ?? 'general'),
            succeededOps: typeof qReq?.succeededOps === 'number' ? qReq.succeededOps : succeededOps,
            failedOps: typeof qReq?.failedOps === 'number' ? qReq.failedOps : failedOps,
            followupCount: typeof qReq?.followupCount === 'number' ? qReq.followupCount : followups.length,
            reportLength: typeof qReq?.reportLength === 'number' ? qReq.reportLength : (task.report?.length ?? 0),
            skipRemote: typeof qReq?.skipRemote === 'boolean' ? qReq.skipRemote : Boolean(task.skipQualityGate),
          },
          response: {
            score: Number(d?.score ?? 0),
            maxScore: Number(d?.maxScore ?? 3),
            confidence: Number(d?.confidence ?? 0),
            supplementProbability: Number(d?.supplementProbability ?? 0),
            shouldSupplement: Boolean(d?.shouldSupplement),
            missingAspect: (d?.missingAspect as MissingAspect | undefined) ?? 'none',
            ...(d?.skippedByRoute ? { skippedByRoute: true } : {}),
            usage: asRecord(d?.usage)
              ? {
                  inputTokens: Number(asRecord(d?.usage)?.inputTokens ?? 0),
                  totalTokens: Number(asRecord(d?.usage)?.totalTokens ?? 0),
                }
              : undefined,
            fallbackReason: typeof d?.fallbackReason === 'string' ? d.fallbackReason : undefined,
          },
        });
      });
    } else if (task.qualityGate) {
      const qg = task.qualityGate;
      jevQualityGates.push({
        index: 1,
        at: qg.evaluatedAt,
        source: qg.source,
        status: qg.skippedByRoute ? 'skipped' : qg.source === 'gemini-decision-1' ? 'completed' : 'fallback',
        request: {
          endpoint: '/v1beta/decisions',
          decisionModel: 'gemini-decision-1',
          profile: task.profile ?? 'general',
          succeededOps,
          failedOps,
          followupCount: followups.length,
          reportLength: task.report?.length ?? 0,
          skipRemote: Boolean(task.skipQualityGate),
        },
        response: {
          score: qg.score,
          maxScore: qg.maxScore,
          confidence: qg.confidence,
          supplementProbability: qg.supplementProbability,
          shouldSupplement: qg.shouldSupplement,
          missingAspect: qg.missingAspect,
          ...(qg.skippedByRoute ? { skippedByRoute: true } : {}),
        },
      });
    }

    // 3) Worker 执行阶段与步骤：推理轮次 + 工具操作 + ASK_BOSS + Followup
    const workerPhaseSpans = new Map<string, { spanId: string; start?: TraceEvent; end?: TraceEvent }>();
    const allSteps: MindmapWorkerStep[] = [];
    const workerLlm = new Map<string, { start?: TraceEvent; end?: TraceEvent }>();
    const workerTools = new Map<string, { start?: TraceEvent; end?: TraceEvent }>();

    for (const ev of taskEvents) {
      if (ev.actor === 'worker' && ev.type === 'trace' && ev.kind === 'span' && ev.spanId) {
        if (ev.label === 'Agent 请求') {
          const entry = workerPhaseSpans.get(ev.spanId) ?? { spanId: ev.spanId };
          if (ev.status === 'started') entry.start = ev; else entry.end = ev;
          workerPhaseSpans.set(ev.spanId, entry);
        } else if (ev.label === '模型推理调用') {
          const entry = workerLlm.get(ev.spanId) ?? {};
          if (ev.status === 'started') entry.start = ev; else entry.end = ev;
          workerLlm.set(ev.spanId, entry);
        } else if (!SDK_META_SPANS.has(ev.label)) {
          const entry = workerTools.get(ev.spanId) ?? {};
          if (ev.status === 'started') entry.start = ev; else entry.end = ev;
          workerTools.set(ev.spanId, entry);
        }
      } else if (ev.kind === 'task_state' && (ev.status === 'waiting_decision' || ev.status === 'decision_received')) {
        const d = asRecord(ev.data);
        allSteps.push({
          id: ev.id,
          kind: 'ask_boss',
          at: ev.at,
          status: ev.status,
          title: ev.status === 'waiting_decision' ? 'ASK_BOSS 挂起请示老板' : '收到老板拍板继续推进',
          outputPreview: typeof d?.reason === 'string' ? clipText(d.reason, 400).text : undefined,
        });
      }
    }

    const rawPhases = [...workerPhaseSpans.values()]
      .map(p => ({
        spanId: p.spanId,
        startedAt: p.start?.at ?? p.end?.at ?? task.createdAt,
        endedAt: p.end?.at,
        status: p.end?.status ?? p.start?.status ?? task.status,
      }))
      .sort((a, b) => a.startedAt - b.startedAt);

    let llmIdx = 0;
    const sortedLlm = [...workerLlm.values()].sort((a, b) => (a.start?.at ?? a.end?.at ?? 0) - (b.start?.at ?? b.end?.at ?? 0));
    for (const pair of sortedLlm) {
      llmIdx += 1;
      const first = pair.start ?? pair.end!;
      const last = pair.end ?? pair.start!;
      const detail = asRecord(asRecord(pair.end?.data)?.detail);
      const summary = asRecord(asRecord(pair.end?.data)?.summary);
      const usage = readUsageNumbers(detail?.usage);
      const stopReason = typeof detail?.stopReason === 'string' ? detail.stopReason : undefined;
      const pubText = typeof summary?.publicText === 'string' ? summary.publicText : undefined;
      allSteps.push({
        id: last.spanId ?? last.id,
        kind: 'llm_turn',
        at: first.at,
        durationMs: pair.end && pair.start ? Math.max(0, pair.end.at - pair.start.at) : undefined,
        status: last.status,
        title: `Worker 第 ${llmIdx} 轮推理`,
        usage,
        stopReason,
        outputPreview: pubText ? clipText(pubText, 320).text : undefined,
      });
    }

    const sortedTools = [...workerTools.values()].sort((a, b) => (a.start?.at ?? a.end?.at ?? 0) - (b.start?.at ?? b.end?.at ?? 0));
    for (const pair of sortedTools) {
      const first = pair.start ?? pair.end!;
      const last = pair.end ?? pair.start!;
      const callSuffix = first.spanId?.includes(':') ? first.spanId.slice(first.spanId.indexOf(':') + 1) : '';
      const candidateOpId = callSuffix ? `${task.id}:${callSuffix}` : '';
      const matchedOp = opsById.get(candidateOpId)
        ?? ops.find(o => o.parentSpanId && o.parentSpanId === first.spanId);
      allSteps.push({
        id: first.spanId ?? first.id,
        kind: 'tool_call',
        at: first.at,
        durationMs: pair.end && pair.start ? Math.max(0, pair.end.at - pair.start.at) : undefined,
        status: last.status,
        title: `工具 · ${first.label}`,
        toolName: first.label,
        operationId: matchedOp?.id,
        hasFullOperation: Boolean(matchedOp?.result),
        inputPreview: formatToolInputPreview(pair.start?.data),
        outputPreview: formatToolOutputPreview(pair.end?.data) ?? (matchedOp?.result ? clipText(matchedOp.result, 520).text : undefined) ?? matchedOp?.error,
      });
    }

    // Fallback: for snapshot tasks where journal might only have operation events
    if (sortedTools.length === 0 && ops.length > 0) {
      ops.forEach((op, idx) => {
        allSteps.push({
          id: op.id,
          kind: 'tool_call',
          at: task.createdAt + idx + 1,
          status: op.status,
          title: op.fileId.startsWith('native:') ? `工具 · ${op.fileId.slice(7)}` : `读取文件 · ${op.fileId}`,
          toolName: op.fileId.startsWith('native:') ? op.fileId.slice(7) : 'read_file',
          operationId: op.id,
          hasFullOperation: Boolean(op.result),
          inputPreview: task.files.find(f => f.id === op.fileId)?.name ?? op.fileId,
          outputPreview: op.result ? clipText(op.result, 420).text : op.error,
        });
      });
    }

    followups.forEach((f, idx) => {
      const targetPhase = rawPhases[idx + 1];
      allSteps.push({
        id: `followup:${f.id}`,
        kind: 'followup',
        at: targetPhase ? Math.max(task.createdAt + 1, targetPhase.startedAt - 1) : task.createdAt + 1,
        status: f.state,
        title: '追加补充指令 (Follow-up)',
        inputPreview: clipText(f.text, 400).text,
      });
    });

    allSteps.sort((a, b) => a.at - b.at);

    const executionPhases: MindmapWorkerPhase[] = [];
    if (rawPhases.length > 0) {
      rawPhases.forEach((rp, pIdx) => {
        const phaseIndex = pIdx + 1;
        const winStart = pIdx === 0 ? Number.NEGATIVE_INFINITY : rp.startedAt;
        const nextPhaseStart = rawPhases[pIdx + 1]?.startedAt ?? Number.POSITIVE_INFINITY;
        let llmCount = 0;
        let toolCount = 0;
        for (const step of allSteps) {
          if (step.at >= winStart && step.at < nextPhaseStart) {
            step.phaseIndex = phaseIndex;
            if (step.kind === 'llm_turn') llmCount += 1;
            else if (step.kind === 'tool_call') toolCount += 1;
          }
        }
        const matchedQg = jevQualityGates.find(qg => qg.at >= (pIdx === 0 ? rp.startedAt : winStart) - 500 && qg.at < nextPhaseStart);
        const phaseEndBoundary = rp.endedAt ?? matchedQg?.at ?? rp.startedAt;
        const matchedReportTurn = routerTurns.find((rt, rtIdx) => {
          if (claimedReportSpans.has(rt.spanId)) return false;
          const isCandidateTurn = rt.triggerKind === 'WORKER_REPORT' || rtIdx > 0;
          if (!isCandidateTurn) return false;
          return rt.startedAt >= phaseEndBoundary - 1500 && rt.startedAt <= nextPhaseStart + 2500;
        });
        if (matchedReportTurn) claimedReportSpans.add(matchedReportTurn.spanId);

        const followupForPhase = pIdx > 0 ? followups[pIdx - 1] : undefined;
        executionPhases.push({
          index: phaseIndex,
          spanId: rp.spanId,
          isFollowup: pIdx > 0,
          ...(followupForPhase ? { followupPrompt: clipText(followupForPhase.text, 320).text } : {}),
          startedAt: rp.startedAt,
          ...(rp.endedAt !== undefined ? { endedAt: rp.endedAt, durationMs: Math.max(0, rp.endedAt - rp.startedAt) } : {}),
          status: rp.status,
          llmCount,
          toolCount,
          ...(matchedQg ? { qualityGateIndex: matchedQg.index } : {}),
          ...(matchedReportTurn ? { routerReportSpanId: matchedReportTurn.spanId } : {}),
        });
      });
    } else {
      let llmCount = 0;
      let toolCount = 0;
      for (const step of allSteps) {
        step.phaseIndex = 1;
        if (step.kind === 'llm_turn') llmCount += 1;
        else if (step.kind === 'tool_call') toolCount += 1;
      }
      const fallbackEnd = allSteps.at(-1)?.at ?? (task.createdAt + Math.round(task.activeMs));
      const matchedReportTurn = routerTurns.find((rt, rtIdx) => !claimedReportSpans.has(rt.spanId) && (rt.triggerKind === 'WORKER_REPORT' || rtIdx > 0));
      if (matchedReportTurn) claimedReportSpans.add(matchedReportTurn.spanId);
      executionPhases.push({
        index: 1,
        isFollowup: false,
        startedAt: task.createdAt,
        endedAt: fallbackEnd,
        durationMs: Math.max(0, Math.round(task.activeMs)),
        status: task.status,
        llmCount,
        toolCount,
        ...(jevQualityGates[0] ? { qualityGateIndex: jevQualityGates[0].index } : {}),
        ...(matchedReportTurn ? { routerReportSpanId: matchedReportTurn.spanId } : {}),
      });
    }

    const MAX_STEPS = 45;
    const omittedSteps = Math.max(0, allSteps.length - MAX_STEPS);
    const visibleSteps = omittedSteps > 0 ? [...allSteps.slice(0, 12), ...allSteps.slice(-(MAX_STEPS - 12))] : allSteps;

    const compiledMemories = (task.memoryIds ?? [])
      .map(id => memoryById.get(id))
      .filter((c): c is MemoryCard => Boolean(c))
      .map(c => ({ id: c.id, topic: c.topic, tags: c.tags, preview: clipText(c.content, 200).text }));

    const clippedPrompt = clipText(task.prompt, 1600);
    const clippedReport = task.report ? clipText(task.report, 1600) : undefined;

    return {
      id: task.id,
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
      prompt: clippedPrompt.text,
      ...(clippedPrompt.truncated ? { promptTruncated: true } : {}),
      status: task.status,
      ...(task.reason ? { reason: clipText(task.reason, 400).text } : {}),
      ...(task.profile ? { profile: task.profile } : {}),
      ...(task.execution ? { execution: task.execution } : {}),
      ...(task.cwd ? { cwd: task.cwd } : {}),
      createdAt: task.createdAt,
      activeMs: Math.round(task.activeMs),
      limitMs: task.limitMs,
      ...(task.contextBrief ? { contextBrief: clipText(task.contextBrief, 800).text } : {}),
      compiledMemories,
      jevRoute,
      executionPhases,
      workerSteps: visibleSteps,
      totalSteps: allSteps.length,
      omittedSteps,
      succeededOps,
      failedOps,
      jevQualityGates,
      ...(clippedReport ? { reportPreview: clippedReport.text, ...(clippedReport.truncated ? { reportTruncated: true } : {}) } : {}),
    };
  };

  const flows: MindmapTaskFlow[] = [];

  for (const userMsg of page.items) {
    const flowTasks = flowTaskMap.get(userMsg.id) ?? [];
    const flowTaskIdSet = new Set(flowTasks.map(t => t.id));
    const flowReplies = repliesByParent.get(userMsg.id) ?? [];
    const flowReplyIdSet = new Set(flowReplies.map(r => r.id));

    const flowEvents = journalEvents.filter(ev =>
      ev.rootId === userMsg.id
      || ev.messageId === userMsg.id
      || (ev.messageId && flowReplyIdSet.has(ev.messageId))
      || (ev.taskId && flowTaskIdSet.has(ev.taskId)),
    );

    const timerName = userMsg.source === 'system' ? parseTimerTriggerName(userMsg.text) : undefined;
    const isTimer = Boolean(timerName);
    const matchedTimer = timerName ? timers.find(t => t.name === timerName) : undefined;
    const rawChannel = userMsg.origin?.channel ?? 'local';
    const sourceKind: MindmapTaskFlow['ingress']['sourceKind'] = isTimer ? 'timer' : rawChannel;

    const boundChannel = userMsg.origin?.channelId ? channelById.get(userMsg.origin.channelId) : undefined;
    const channelPlatformLabel = rawChannel === 'wechat' ? '微信'
      : rawChannel === 'telegram' ? 'Telegram'
        : rawChannel === 'dingtalk' ? '钉钉'
          : rawChannel === 'xiaoai' ? '小爱音箱'
            : '本地控制台';
    const channelLabel = isTimer
      ? `定时触发${rawChannel !== 'local' ? ` → ${boundChannel?.name ?? channelPlatformLabel}` : ''}`
      : boundChannel
        ? `${channelPlatformLabel} · ${boundChannel.name}`
        : channelPlatformLabel;

    const recalledItems: MindmapRecalledItem[] = (userMsg.routing?.context?.autoRecalled ?? []).map(hit => ({
      kind: hit.kind,
      id: hit.id,
      title: hit.title,
      score: hit.score,
      snippet: clipText(hit.snippet, 360).text,
      ...(hit.tags?.length ? { tags: hit.tags } : {}),
      ...(hit.cwd ? { cwd: hit.cwd } : {}),
      ...(hit.activatedVia ? { activatedVia: hit.activatedVia } : {}),
    }));

    const routerTurns = buildRouterTurns(flowEvents);
    const routeActions = userMsg.routing?.actions ?? [];
    const directPlugin = isTimer && routerTurns.length === 0 && flowTasks.length === 0 && matchedTimer?.plugin
      ? { timerName: matchedTimer.name, plugin: matchedTimer.plugin, pluginAction: matchedTimer.pluginAction ?? 'status' }
      : undefined;

    const claimedReportSpans = new Set<string>();
    const taskDetails = flowTasks.map(task => {
      const taskSpecificEvents = flowEvents.filter(ev => ev.taskId === task.id);
      return buildTaskDetail(task, taskSpecificEvents, routerTurns, claimedReportSpans);
    });

    // Memories created/saved in this flow (via save_memory or consolidateTaskMemory)
    const savedMemoryIdsFromActions = new Set<string>();
    for (const act of routeActions) {
      if (act.kind === 'save_memory') {
        for (const mid of act.memoryIds ?? []) savedMemoryIdsFromActions.add(mid);
      }
    }
    const consolidatedMemories: MindmapConsolidatedMemory[] = allMemories
      .filter(card =>
        card.sourceMessageId === userMsg.id
        || (card.sourceTaskId && flowTaskIdSet.has(card.sourceTaskId))
        || savedMemoryIdsFromActions.has(card.id),
      )
      .map(card => ({
        id: card.id,
        topic: card.topic,
        tags: card.tags,
        pinned: Boolean(card.pinned),
        autoConsolidated: card.tags.includes('auto-consolidated'),
        contentPreview: clipText(card.content, 360).text,
        synapseCount: card.synapses?.length ?? 0,
        createdAt: card.createdAt,
      }));

    const deliveries: MindmapDeliveryItem[] = flowReplies.map((r, idx) => {
      const clipped = clipText(r.text || r.reason || '', 1600);
      const isLast = idx === flowReplies.length - 1;
      const roleLabel = r.source === 'system'
        ? (isTimer ? '定时插件直报' : '系统状态通知')
        : flowReplies.length > 1 && !isLast
          ? `阶段回复 #${idx + 1}`
          : '最终交付回复';
      return {
        messageId: r.id,
        seq: r.seq,
        at: r.at,
        roleLabel,
        status: r.status,
        text: clipped.text,
        ...(clipped.truncated ? { textTruncated: true } : {}),
        ...(r.reason ? { reason: clipText(r.reason, 280).text } : {}),
        ...(r.source ? { source: r.source } : {}),
      };
    });

    // Sent files from Router send_file calls
    const sentFiles: Array<{ name: string; target?: string; at: number }> = [];
    for (const turn of routerTurns) {
      for (const tool of turn.tools) {
        if (tool.toolName !== 'send_file') continue;
        const parsedOut = unwrapJsonString(tool.outputPreview);
        const outRec = asRecord(parsedOut);
        const parsedIn = unwrapJsonString(tool.inputPreview);
        const inRec = asRecord(parsedIn);
        const fileName = typeof outRec?.name === 'string'
          ? outRec.name
          : typeof inRec?.name === 'string'
            ? inRec.name
            : '微信附件';
        sentFiles.push({
          name: fileName,
          target: typeof outRec?.target === 'string' ? outRec.target : userMsg.origin?.senderId,
          at: tool.at,
        });
      }
    }

    const replyOrigins = flowReplies.map(r => r.origin).filter((o): o is MessageOrigin => Boolean(o));
    const finalOrigin = replyOrigins.at(-1) ?? userMsg.origin;
    const imChannel = finalOrigin?.channel ?? 'local';
    const imBound = finalOrigin?.channelId ? channelById.get(finalOrigin.channelId) : undefined;
    const imChannelName = imChannel === 'local'
      ? '本地 Web 控制台'
      : imBound?.name ?? (imChannel === 'wechat' ? '微信 iLink' : imChannel === 'telegram' ? 'Telegram' : imChannel === 'xiaoai' ? '小爱音箱' : '钉钉');
    const deliveredReplies = flowReplies.filter(r => ['completed', 'failed', 'interrupted'].includes(r.status) && Boolean((r.text || r.reason || '').trim()));

    const hasRunningTask = flowTasks.some(t => t.status === 'running' || t.status === 'queued');
    const hasPausedTask = flowTasks.some(t => t.status === 'paused');
    const hasFailedTask = flowTasks.some(t => t.status === 'failed');
    const flowStatus: MindmapTaskFlow['status'] = hasRunningTask
      ? 'running'
      : (userMsg.status === 'queued' || userMsg.status === 'processing' || userMsg.status === 'streaming')
        ? userMsg.status
        : hasFailedTask || userMsg.status === 'failed'
          ? 'failed'
          : hasPausedTask
            ? 'paused'
            : userMsg.status === 'interrupted'
              ? 'interrupted'
              : 'completed';

    const clippedMsg = clipText(userMsg.text, 1600);
    const completedAt = flowReplies.at(-1)?.at ?? taskDetails.at(-1)?.createdAt;

    flows.push({
      id: `flow:msg:${userMsg.id}`,
      seq: userMsg.seq,
      createdAt: userMsg.at,
      completedAt,
      status: flowStatus,
      ...(userMsg.sessionId ? { sessionId: userMsg.sessionId, sessionPersisted: true } : {}),
      ...(userMsg.sessionLink ? { sessionLink: userMsg.sessionLink } : {}),
      ingress: {
        sourceKind,
        channelLabel,
        origin: sanitizeOrigin(userMsg.origin),
        messageId: userMsg.id,
        text: clippedMsg.text,
        ...(clippedMsg.truncated ? { textTruncated: true } : {}),
        attachments: (userMsg.attachments ?? []).map(a => ({
          kind: a.kind,
          name: a.name,
          status: a.status,
          ...(a.path ? { path: a.path } : {}),
          ...(a.mimeType ? { mimeType: a.mimeType } : {}),
          ...(a.error ? { error: a.error } : {}),
        })),
        paths: userMsg.paths ?? [],
        ...(matchedTimer
          ? {
              timerInfo: {
                id: matchedTimer.id,
                name: matchedTimer.name,
                plugin: matchedTimer.plugin,
                pluginAction: matchedTimer.pluginAction,
                dailyAt: matchedTimer.dailyAt,
                intervalMs: matchedTimer.intervalMs,
                once: matchedTimer.once,
              },
            }
          : {}),
      },
      memoryRecall: {
        directoryTotal: userMsg.routing?.context?.memoryDirectory?.totalActive,
        visibleWorksCount: userMsg.routing?.context?.totalWorks,
        executionMode: userMsg.routing?.context?.execution,
        cwd: userMsg.routing?.context?.cwd,
        recalledItems,
      },
      routerTurns,
      routeActions,
      ...(directPlugin ? { directPlugin } : {}),
      tasks: taskDetails,
      consolidatedMemories,
      deliveries,
      imPush: {
        channel: imChannel,
        channelName: imChannelName,
        target: finalOrigin?.conversationId ?? finalOrigin?.senderId,
        delivered: deliveredReplies.length > 0,
        deliveryCount: deliveredReplies.length,
        sentFiles,
      },
    });
  }

  // Append any standalone tasks submitted directly without a user message (e.g. CLI submit)
  if (includeOrphans) {
    for (const task of [...orphanTasks].sort((a, b) => b.createdAt - a.createdAt)) {
      const taskEvents = journalEvents.filter(ev => ev.taskId === task.id || ev.rootId === task.id);
      const orphanRouterTurns = buildRouterTurns(taskEvents);
      const detail = buildTaskDetail(task, taskEvents, orphanRouterTurns, new Set<string>());
      const imChannel = task.origin?.channel ?? 'local';
      const imBound = task.origin?.channelId ? channelById.get(task.origin.channelId) : undefined;
      flows.push({
        id: `flow:task:${task.id}`,
        seq: 0,
        createdAt: task.createdAt,
        status: task.status === 'cancelled' ? 'interrupted' : task.status,
        ...(task.sessionId ? { sessionId: task.sessionId, sessionPersisted: true } : {}),
        ingress: {
          sourceKind: 'standalone',
          channelLabel: '独立后台提交 (Submit)',
          origin: sanitizeOrigin(task.origin),
          text: detail.prompt,
          ...(detail.promptTruncated ? { textTruncated: true } : {}),
          attachments: [],
          paths: task.paths ?? [],
        },
        memoryRecall: {
          executionMode: task.execution,
          cwd: task.cwd,
          recalledItems: [],
        },
        routerTurns: orphanRouterTurns,
        routeActions: [],
        tasks: [detail],
        consolidatedMemories: allMemories
          .filter(c => c.sourceTaskId === task.id)
          .map(card => ({
            id: card.id,
            topic: card.topic,
            tags: card.tags,
            pinned: Boolean(card.pinned),
            autoConsolidated: card.tags.includes('auto-consolidated'),
            contentPreview: clipText(card.content, 360).text,
            synapseCount: card.synapses?.length ?? 0,
            createdAt: card.createdAt,
          })),
        deliveries: [],
        imPush: {
          channel: imChannel,
          channelName: imBound?.name ?? (imChannel === 'local' ? '本地 Web 控制台' : imChannel),
          target: task.origin?.conversationId ?? task.origin?.senderId,
          delivered: task.status === 'completed',
          deliveryCount: task.status === 'completed' ? 1 : 0,
          sentFiles: [],
        },
      });
    }
  }

  // Enforce safe Unix socket payload limit (< 2.4 MB) by trimming trailing flows if needed
  let wechatFlows = 0;
  let localFlows = 0;
  let timerFlows = 0;
  let jevCalls = 0;
  let hasMore = page.hasMore;
  let beforeSeq = page.before;

  const boundedFlows: MindmapTaskFlow[] = [];
  let runningSize = 2048;
  for (const flow of flows) {
    const chunkSize = Buffer.byteLength(JSON.stringify(flow), 'utf8');
    if (boundedFlows.length > 0 && runningSize + chunkSize > SAFE_PAYLOAD_BYTES) {
      hasMore = true;
      beforeSeq = boundedFlows.at(-1)?.seq || beforeSeq;
      break;
    }
    boundedFlows.push(flow);
    runningSize += chunkSize;
    if (flow.ingress.sourceKind === 'timer') timerFlows += 1;
    else if (flow.ingress.sourceKind === 'wechat') wechatFlows += 1;
    else localFlows += 1;
    if (flow.sessionLink?.source === 'gemini-decision-1') jevCalls += 1;
    for (const t of flow.tasks) {
      if (t.jevRoute?.called) jevCalls += 1;
      jevCalls += t.jevQualityGates.length;
    }
  }

  const sessions = await groupFlowsIntoSessions(boundedFlows, store, options?.home, modelHubView);
  const multiTurnSessions = sessions.filter(s => s.turnCount >= 2).length;

  return {
    generatedAt: Date.now(),
    cursor,
    mode: modelHubView.mode,
    hasMore,
    ...(hasMore && beforeSeq !== undefined ? { beforeSeq } : {}),
    summary: {
      totalFlows: page.totalUsers + orphanTasks.length,
      loadedFlows: boundedFlows.length,
      totalSessions: sessions.length,
      multiTurnSessions,
      wechatFlows,
      localFlows,
      timerFlows,
      totalTasks: allTasks.length,
      jevCalls,
      totalMemories: activeMemoriesCount,
      routerProvider: modelHubView.routerProvider,
      routerModel: modelHubView.routerModel,
      decisionModel: modelHubView.decisionEngine?.model ?? 'gemini-decision-1',
      decisionEnabled: Boolean(modelHubView.decisionEngine?.enabled),
      decisionConfigured: Boolean(modelHubView.decisionEngine?.configured),
    },
    sessions,
    flows: boundedFlows,
  };
}

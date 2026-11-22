import type {
  ChatMessage,
  MessageOrigin,
  RouteAction,
  SessionTurnLink,
  TraceEvent,
  WorkView,
} from '../view.js';
import { activeStatus, record, routeLabel, routeState } from './model.js';
import { formatNumber, profileBadges, statusText, tierBadges } from './shared/format.js';

// ---------------- Backend Shared Contracts ----------------

export interface ExecutionTraceOperationSummary {
  id: string;
  fileId: string;
  status: string;
  parentSpanId?: string;
  error?: string;
  resultPreview?: string;
  resultTruncated?: boolean;
  hasFullResult: boolean;
}

export interface ExecutionTraceMemoryBrief {
  id: string;
  topic: string;
  tags: string[];
  preview: string;
}

export interface ExecutionTraceTaskSummary {
  id: string;
  parentTaskId?: string;
  originMessageId?: string;
  prompt: string;
  status: string;
  createdAt: number;
  activeMs: number;
  limitMs: number;
  cwd?: string;
  profile?: string;
  workerModel?: string;
  modelTier?: string;
  thinkingLevel?: string;
  decisionSource?: string;
  decisionConfidence?: number;
  skipQualityGate?: boolean;
  qualityGate?: Record<string, unknown>;
  contextBrief?: string;
  reason?: string;
  report?: string;
  pendingQuestion?: {
    question: string;
    options?: string[];
    askedAt: number;
  };
  followups: Array<{ id: string; text: string; state: string }>;
  memories: ExecutionTraceMemoryBrief[];
  operations: ExecutionTraceOperationSummary[];
}

export interface ExecutionTraceLinkedTask {
  id: string;
  prompt: string;
  status: string;
  profile?: string;
  workerModel?: string;
  modelTier?: string;
  thinkingLevel?: string;
  activeMs: number;
  createdAt: number;
}

export interface ExecutionTraceBundle {
  scope: { type: 'all' | 'task' | 'message'; id?: string };
  cursor: number;
  events: TraceEvent[];
  streamedTextBySpan: Record<string, string>;
  messages: ChatMessage[];
  task?: ExecutionTraceTaskSummary;
  linkedTasks: ExecutionTraceLinkedTask[];
}

// ---------------- Frontend Chain Model ----------------

export type ChainCategory = 'all' | 'message' | 'llm' | 'tool' | 'routing';

export interface ChainParamItem {
  label: string;
  value: string;
  kind: 'code' | 'path' | 'diff_old' | 'diff_new' | 'text' | 'badge';
}

export interface ChainToolDecision {
  spanId?: string;
  toolName: string;
  displayName: string;
  summary: string;
}

export interface ChainToolDetail {
  toolName: string;
  displayName: string;
  categoryLabel: string;
  params: ChainParamItem[];
  resultText?: string;
  resultTruncated?: boolean;
  exitCode?: number;
  errorText?: string;
  operationId?: string;
  taskId?: string;
  hasFullOutput?: boolean;
}

export interface ChainLlmDetail {
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  stopReason?: string;
  stopReasonLabel: string;
  inputContext?: string;
  thinkingText?: string;
  publicText?: string;
  publicTextTruncated?: boolean;
  toolDecisions: ChainToolDecision[];
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    reasoning?: number;
    totalTokens?: number;
    costUsd?: number;
  };
  errorText?: string;
}

export interface ChainMessageDetail {
  messageId: string;
  role: 'user' | 'assistant' | 'system';
  senderLabel: string;
  channelLabel: string;
  speakerLabel?: string;
  text: string;
  attachments: Array<{ name: string; kind: string; status: string }>;
  paths: string[];
  sessionNote?: string;
}

export interface ChainRoutingDetail {
  kindLabel: string;
  targetTaskId?: string;
  targetTaskLabel?: string;
  summaryItems: Array<{ label: string; value: string }>;
  promptText?: string;
  contextBrief?: string;
  reportText?: string;
  memories?: ExecutionTraceMemoryBrief[];
  options?: string[];
  errorText?: string;
}

export interface ChainActionNode {
  id: string;
  seq: number;
  at: number;
  endedAt?: number;
  offsetMs: number;
  durationMs?: number;
  waterfallStartPermille: number;
  waterfallWidthPermille: number;
  category: Exclude<ChainCategory, 'all'>;
  icon: string;
  actor: 'user' | 'router' | 'worker' | 'executor' | 'system';
  actorLabel: string;
  title: string;
  subtitle?: string;
  preview: string;
  status: string;
  statusLabel: string;
  tone: 'ok' | 'run' | 'warn' | 'err' | 'info' | 'neutral';
  taskId?: string;
  taskLabel?: string;
  messageId?: string;
  toolDetail?: ChainToolDetail;
  llmDetail?: ChainLlmDetail;
  messageDetail?: ChainMessageDetail;
  routingDetail?: ChainRoutingDetail;
}

export interface ExecutionChainView {
  nodes: ChainActionNode[];
  stats: {
    total: number;
    message: number;
    llm: number;
    tool: number;
    routing: number;
    failed: number;
    totalTokens: number;
    totalDurationMs: number;
  };
}

export interface FallbackBundleInput {
  selection?: { type: 'all' } | { type: 'task' | 'message'; id: string; label?: string };
  traceEvents?: readonly TraceEvent[];
  events?: readonly TraceEvent[];
  messages?: Map<string, ChatMessage> | Iterable<ChatMessage>;
  workData?: unknown;
  works?: readonly WorkView[];
  view?: { works?: readonly WorkView[] };
  traceAfter?: number;
  cursor?: number;
}

// ---------------- Constants & Lookups ----------------

const IGNORED_EVENT_KINDS = new Set(['work_linked', 'visible_text', 'thinking', 'message_updated']);

const ROUTER_TOOLS = new Set([
  'start_work',
  'continue_work',
  'inspect_work',
  'stop_work',
  'resume_work',
  'recall_messages',
  'search_memory',
  'save_memory',
  'manage_note',
  'manage_diary',
  'manage_timer',
  'run_plugin',
  'send_file',
  'switch_channel',
  'dispatch_worker',
]);

const TOOL_META: Record<string, { displayName: string; categoryLabel: string; icon: string }> = {
  bash: { displayName: '执行命令', categoryLabel: '系统终端', icon: '⚡' },
  read: { displayName: '读取文件', categoryLabel: '文件读取', icon: '📄' },
  start_read: { displayName: '读取文件副本', categoryLabel: '文件读取', icon: '📄' },
  edit: { displayName: '修改文件', categoryLabel: '代码编辑', icon: '✏️' },
  write: { displayName: '写入文件', categoryLabel: '文件写入', icon: '📝' },
  grep: { displayName: '搜索内容', categoryLabel: '代码检索', icon: '🔍' },
  find: { displayName: '查找文件', categoryLabel: '文件检索', icon: '🗂️' },
  ls: { displayName: '列出目录', categoryLabel: '目录浏览', icon: '📁' },
  run_plugin: { displayName: '调用插件', categoryLabel: '扩展插件', icon: '🧩' },
  start_work: { displayName: '新建工作', categoryLabel: '任务编排', icon: '🚀' },
  continue_work: { displayName: '补充/继续工作', categoryLabel: '任务编排', icon: '🔁' },
  inspect_work: { displayName: '查询工作', categoryLabel: '任务编排', icon: '🔎' },
  stop_work: { displayName: '停止工作', categoryLabel: '任务编排', icon: '⏹️' },
  resume_work: { displayName: '恢复工作', categoryLabel: '任务编排', icon: '▶️' },
  recall_messages: { displayName: '回看历史', categoryLabel: '上下文检索', icon: '📜' },
  search_memory: { displayName: '检索全局记忆', categoryLabel: '记忆系统', icon: '🧠' },
  save_memory: { displayName: '沉淀长期记忆', categoryLabel: '记忆系统', icon: '💾' },
  manage_note: { displayName: '管理记事本', categoryLabel: '笔记日记', icon: '📒' },
  manage_diary: { displayName: '读写日记本', categoryLabel: '笔记日记', icon: '📔' },
  manage_timer: { displayName: '管理定时任务', categoryLabel: '定时调度', icon: '⏱️' },
  send_file: { displayName: '发送附件', categoryLabel: '消息投递', icon: '📎' },
  switch_channel: { displayName: '切换回复通道', categoryLabel: '消息投递', icon: '🔀' },
  dispatch_worker: { displayName: '确认派发 Worker', categoryLabel: '任务编排', icon: '🚀' },
};

const ROUTE_KIND_LABELS: Record<string, string> = {
  new_work: '新建工作',
  followup: '补充已有工作',
  related_work: '关联新执行',
  inspect: '查询工作',
  stop: '停止工作',
  resume: '恢复工作',
  recall: '回看历史',
  search_memory: '检索全局记忆',
  save_memory: '沉淀长期记忆',
  note: '更新记事本',
  diary: '书写日记本',
  timer: '管理定时任务',
  plugin: '调用插件',
  send_file: '发送微信附件',
  switch_channel: '切换回复通道',
  reply: '直接回复',
};

const STOP_REASON_LABELS: Record<string, string> = {
  toolUse: '决定调用工具',
  stop: '生成回复完成',
  length: '达到输出长度上限',
  error: '请求异常',
  aborted: '已中断',
};

const MISSING_ASPECT_LABELS: Record<string, string> = {
  none: '无明显缺失',
  incomplete_requirements: '需求未完整覆盖',
  missing_verification: '缺少验证依据',
  unresolved_error: '存在未解决错误',
  superficial_analysis: '分析深度不足',
};

const TRIGGER_LABELS: Record<string, string> = {
  CHAT: '用户新消息触发',
  WORKER_REPORT: 'Worker 完成汇报验收',
  WORKER_QUESTION: 'Worker 盘中请示拍板',
  BOSS_DECISION: '收到老板拍板继续推进',
  WORKER_FAILED: 'Worker 异常兜底处理',
  NEW_TASK: '独立后台任务调度',
  FOLLOWUP: '补充指令推进',
  READ_COMPLETIONS: '文件读取完成推进',
  TASK: '后台任务启动',
};

const ACTOR_LABELS: Record<ChainActionNode['actor'], string> = {
  user: '用户',
  router: 'F.R.I.D.A.Y.',
  worker: 'Worker',
  executor: '执行器',
  system: '系统',
};

const EXTRA_STATUS_LABELS: Record<string, string> = {
  fallback: '规则回退',
  skipped: '免评直通',
  done: '已送达',
  static: '静态配置',
  error: '失败',
  router_report_fallback: '直交兜底',
};

// ---------------- Pure Helpers ----------------

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clipText(value: string, maxLen: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, Math.max(0, maxLen - 1))}…`;
}

function tryParseJson(raw: string): unknown | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Recursively unwraps stringified JSON payloads (including nested `{ input: "..." }`
 * custom-tool wrappers) so parameters and outputs are never displayed as raw JSON strings.
 */
function deepUnwrapJson(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const parsed = tryParseJson(value);
    if (parsed !== undefined) {
      return deepUnwrapJson(parsed, depth + 1);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => deepUnwrapJson(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = deepUnwrapJson(item, depth + 1);
    }
    const keys = Object.keys(out);
    if (
      'input' in out
      && isPlainObject(out.input)
      && (keys.length === 1 || (keys.length === 2 && 'summary' in out))
    ) {
      const inner = out.input as Record<string, unknown>;
      return keys.length === 2 && out.summary !== undefined && !('summary' in inner)
        ? { ...inner, summary: out.summary }
        : inner;
    }
    return out;
  }
  return value;
}

function extractTextFromContentArray(items: unknown[], depth = 0): string | undefined {
  const hasBlockObject = items.some(item => isPlainObject(item) && ('text' in item || 'type' in item));
  if (!hasBlockObject) return undefined;
  const parts: string[] = [];
  for (const item of items) {
    if (typeof item === 'string') {
      if (item.trim()) parts.push(item);
      continue;
    }
    if (!isPlainObject(item)) continue;
    if (item.type === 'text' && item.text !== undefined && item.text !== null) {
      if (typeof item.text === 'string') {
        parts.push(item.text);
      } else {
        const nested = extractReadableText(item.text, depth + 1);
        if (nested) parts.push(nested);
      }
    } else if (item.text !== undefined && item.text !== null && !('type' in item)) {
      if (typeof item.text === 'string') {
        parts.push(item.text);
      } else {
        const nested = extractReadableText(item.text, depth + 1);
        if (nested) parts.push(nested);
      }
    }
  }
  return parts.length ? parts.join('\n') : undefined;
}

function formatReadableValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return '（空）';
    const textBlock = extractTextFromContentArray(value);
    if (textBlock !== undefined) return textBlock;
    if (value.every(item => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean')) {
      return value.map(String).join(', ');
    }
    return value.map(item => formatReadableValue(item, depth + 1)).join('\n');
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (!entries.length) return '（空）';
    if (depth >= 2) {
      return entries.map(([k, v]) => `${k}: ${typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : formatReadableValue(v, depth + 1)}`).join(' · ');
    }
    return entries.map(([k, v]) => `${k}: ${formatReadableValue(v, depth + 1)}`).join('\n');
  }
  return String(value);
}

function extractReadableText(value: unknown, depth = 0): string {
  if (value === null || value === undefined || depth > 5) return '';
  const unwrapped = depth === 0 ? deepUnwrapJson(value) : value;
  if (typeof unwrapped === 'string') return unwrapped;
  if (typeof unwrapped === 'number' || typeof unwrapped === 'boolean') return String(unwrapped);
  if (Array.isArray(unwrapped)) {
    const contentText = extractTextFromContentArray(unwrapped, depth);
    if (contentText !== undefined) return contentText;
    return unwrapped.map(item => extractReadableText(item, depth + 1)).filter(Boolean).join('\n');
  }
  if (!isPlainObject(unwrapped)) return String(unwrapped);

  if (Array.isArray(unwrapped.content)) {
    const contentText = extractTextFromContentArray(unwrapped.content, depth);
    if (contentText !== undefined) return contentText;
  }
  if ('result' in unwrapped && unwrapped.result !== undefined && unwrapped.result !== null) {
    const inner = extractReadableText(unwrapped.result, depth + 1);
    if (inner) return inner;
  }
  if ('output' in unwrapped && unwrapped.output !== undefined && unwrapped.output !== null) {
    const inner = extractReadableText(unwrapped.output, depth + 1);
    if (inner) return inner;
  }
  if (typeof unwrapped.stdout === 'string' || typeof unwrapped.stderr === 'string') {
    const stdout = typeof unwrapped.stdout === 'string' ? unwrapped.stdout.trimEnd() : '';
    const stderr = typeof unwrapped.stderr === 'string' ? unwrapped.stderr.trimEnd() : '';
    if (stdout && stderr) return `${stdout}\n[stderr]\n${stderr}`;
    if (stdout) return stdout;
    if (stderr) return stderr;
  }
  for (const key of ['text', 'preview', 'diff', 'message', 'report', 'summary'] as const) {
    if (typeof unwrapped[key] === 'string' && unwrapped[key]) {
      const inner = deepUnwrapJson(unwrapped[key]);
      return typeof inner === 'string' ? inner : extractReadableText(inner, depth + 1);
    }
  }
  // Never dump raw JSON string: format remaining non-metadata fields into readable lines
  const skipKeys = new Set(['id', 'taskId', 'revision', 'fileId', 'parentSpanId', 'status', 'error', 'isError', 'details', 'truncated']);
  const meaningful = Object.entries(unwrapped).filter(([k, v]) => !skipKeys.has(k) && v !== undefined && v !== null);
  if (!meaningful.length) return '';
  return meaningful.map(([k, v]) => `${k}: ${formatReadableValue(v)}`).join('\n');
}

/**
 * Extracts clean human-readable output text, error, and status from `/api/operation`
 * responses or nested tool output wrappers, never returning raw JSON dumps.
 */
export function extractReadableOperationOutput(raw: unknown): { text: string; error?: string; status?: string } {
  if (raw === null || raw === undefined) return { text: '' };
  const unwrapped = deepUnwrapJson(raw);
  if (typeof unwrapped === 'string') {
    return { text: unwrapped };
  }
  if (Array.isArray(unwrapped)) {
    return { text: extractReadableText(unwrapped) };
  }
  if (!isPlainObject(unwrapped)) {
    return { text: String(unwrapped) };
  }
  const status = asNonEmptyString(unwrapped.status);
  const rawError = asNonEmptyString(unwrapped.error);
  const text = extractReadableText(unwrapped);
  return {
    text,
    ...(rawError ? { error: rawError } : {}),
    ...(status ? { status } : {}),
  };
}

function extractTaskHeadline(prompt?: string): string | undefined {
  if (!prompt) return undefined;
  const match = /【任务：([^】\n]+)】/.exec(prompt);
  const headline = (match?.[1] ?? prompt).replace(/\s+/g, ' ').trim();
  if (!headline) return undefined;
  return headline.length <= 48 ? headline : `${headline.slice(0, 47)}…`;
}

function parseTimerTriggerName(text: string): string | undefined {
  const match = /^\[定时触发\s*·\s*([^\]]+)\]/.exec(text.trim());
  return match?.[1]?.trim();
}

function resolveChannelLabel(origin?: MessageOrigin, text = '', source?: string): string {
  if (source === 'system' || parseTimerTriggerName(text)) {
    if (/^\[定时触发/.test(text.trim())) return '⏱️ 定时任务';
  }
  if (/^\[定时触发\s*·\s*[^\]]+\]/.test(text.trim())) return '⏱️ 定时任务';
  switch (origin?.channel) {
    case 'wechat': return '💬 微信';
    case 'telegram': return '✈️ Telegram';
    case 'xiaoai': return '🔊 小爱音箱';
    case 'dingtalk': return '🟦 钉钉';
    case 'local':
    default:
      return '🖥️ Web 控制台';
  }
}

function resolveStatusLabel(status: string): string {
  return EXTRA_STATUS_LABELS[status] ?? statusText(status);
}

function resolveTone(status: string, opts?: { shouldSupplement?: boolean; exitCode?: number; hasError?: boolean }): ChainActionNode['tone'] {
  if (opts?.shouldSupplement) return 'warn';
  if (['failed', 'error', 'followup_failed', 'cancelled'].includes(status)) return 'err';
  if (['paused', 'interrupted', 'unknown', 'waiting_decision', 'fallback', 'stop_requested', 'cancel_requested', 'stopping', 'router_report_fallback'].includes(status)) {
    return 'warn';
  }
  if (opts?.exitCode !== undefined && opts.exitCode !== 0) return 'err';
  if (opts?.hasError) return 'err';
  if (['queued', 'processing', 'streaming', 'running', 'started', 'requested', 'pending'].includes(status)) {
    return 'run';
  }
  if (['completed', 'succeeded', 'accepted', 'done', 'decision_received'].includes(status)) {
    return 'ok';
  }
  if (['skipped', 'ready', 'linked'].includes(status)) {
    return 'info';
  }
  return 'neutral';
}

function formatSessionNote(link?: SessionTurnLink, _sessionId?: string): string | undefined {
  if (!link) return undefined;
  const parts = [link.label];
  if (link.detail) parts.push(link.detail);
  if (link.confidence !== undefined) parts.push(`置信度 ${Math.round(link.confidence * 100)}%`);
  return parts.join(' · ');
}

function formatUsageCost(usage: ChainLlmDetail['usage']): string {
  if (!usage) return '';
  const tokens = usage.totalTokens ?? ((usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0));
  const parts: string[] = [];
  if (tokens > 0) parts.push(`${formatNumber(tokens)} tok`);
  if (usage.costUsd !== undefined && usage.costUsd > 0) parts.push(`$${usage.costUsd.toFixed(4)}`);
  return parts.join(' · ');
}

function extractUsage(rawUsage: unknown): ChainLlmDetail['usage'] | undefined {
  const u = record(rawUsage);
  const input = asNumber(u.input ?? u.inputTokens);
  const output = asNumber(u.output ?? u.outputTokens);
  const cacheRead = asNumber(u.cacheRead);
  const cacheWrite = asNumber(u.cacheWrite);
  const reasoning = asNumber(u.reasoning ?? u.reasoningTokens);
  const rawTotal = asNumber(u.totalTokens);
  const computedTotal = (input !== undefined || output !== undefined)
    ? (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
    : undefined;
  const totalTokens = rawTotal && rawTotal > 0 ? rawTotal : computedTotal;
  const costObj = record(u.cost);
  const costUsd = asNumber(costObj.total ?? u.costUsd ?? (typeof u.cost === 'number' ? u.cost : undefined));
  if (input === undefined && output === undefined && totalTokens === undefined && costUsd === undefined) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

// ---------------- Tool Argument & Output Extraction ----------------

function tryRecoverPartialPreview(preview: string): Record<string, unknown> {
  const parsed = deepUnwrapJson(preview);
  if (isPlainObject(parsed)) {
    return isPlainObject(parsed.input) ? parsed.input as Record<string, unknown> : parsed;
  }
  const recovered: Record<string, unknown> = {};
  const patterns: Array<[string, RegExp]> = [
    ['command', /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/],
    ['path', /"(?:path|file_path|filePath)"\s*:\s*"((?:[^"\\]|\\.)*)"/],
    ['pattern', /"pattern"\s*:\s*"((?:[^"\\]|\\.)*)"/],
    ['plugin', /"plugin"\s*:\s*"((?:[^"\\]|\\.)*)"/],
    ['action', /"(?:pluginAction|action)"\s*:\s*"((?:[^"\\]|\\.)*)"/],
    ['instruction', /"instruction"\s*:\s*"((?:[^"\\]|\\.)*)"/],
  ];
  for (const [key, re] of patterns) {
    const match = re.exec(preview);
    if (match?.[1]) {
      try {
        recovered[key] = JSON.parse(`"${match[1]}"`);
      } catch {
        recovered[key] = match[1];
      }
    }
  }
  return recovered;
}

function extractToolArgs(
  startEvent: TraceEvent | undefined,
  opEvent?: TraceEvent,
  matchedOp?: ExecutionTraceOperationSummary,
  endOnly = false,
): Record<string, unknown> {
  const startData = record(startEvent?.data);
  const detail = record(startData.detail);
  const summary = record(startData.summary);
  const summaryInputRaw = deepUnwrapJson(summary.input);
  const summaryInput = isPlainObject(summaryInputRaw) ? summaryInputRaw as Record<string, unknown> : {};

  let detailArgs: Record<string, unknown> = {};
  const rawDetailSource = 'input' in detail ? detail.input : 'input' in startData ? startData.input : undefined;
  if (rawDetailSource !== undefined) {
    const unwrapped = deepUnwrapJson(rawDetailSource);
    if (isPlainObject(unwrapped)) {
      detailArgs = unwrapped as Record<string, unknown>;
    } else if (typeof unwrapped === 'string' && unwrapped.trim()) {
      detailArgs = { input: unwrapped };
    }
  } else if (detail.truncated && typeof detail.preview === 'string') {
    detailArgs = tryRecoverPartialPreview(detail.preview);
  } else if (!endOnly && !Object.keys(detail).length && !Object.keys(summary).length) {
    const direct = deepUnwrapJson(startEvent?.data);
    if (isPlainObject(direct)) {
      const { mode: _m, detail: _d, summary: _s, ...rest } = direct as Record<string, unknown>;
      detailArgs = rest;
    }
  }

  const merged: Record<string, unknown> = { ...summaryInput };
  for (const [key, val] of Object.entries(detailArgs)) {
    if (val === undefined) continue;
    const prev = merged[key];
    if (prev === undefined) {
      merged[key] = val;
    } else if (typeof val === 'string' && typeof prev === 'string') {
      merged[key] = val.length >= prev.length ? val : prev;
    } else if (isPlainObject(val) || Array.isArray(val)) {
      merged[key] = val;
    } else {
      merged[key] = val;
    }
  }

  const opData = record(opEvent?.data);
  if (typeof opData.fileName === 'string' && opData.fileName) {
    if (!merged.fileName) merged.fileName = opData.fileName;
    if (typeof merged.input === 'string' && !merged.path) {
      merged.fileId ??= merged.input;
      merged.path = opData.fileName;
    }
  }
  if (matchedOp && !merged.fileId && !matchedOp.fileId.startsWith('native:')) {
    merged.fileId = matchedOp.fileId;
  }
  return merged;
}

function appendExtraParams(
  params: ChainParamItem[],
  args: Record<string, unknown>,
  handledKeys: Set<string>,
): void {
  for (const [key, value] of Object.entries(args)) {
    if (handledKeys.has(key) || value === undefined || value === null || value === '') continue;
    if (isPlainObject(value)) {
      for (const [subKey, subVal] of Object.entries(value)) {
        if (subVal === undefined || subVal === null || subVal === '') continue;
        params.push({
          label: `${key}.${subKey}`,
          value: formatReadableValue(subVal),
          kind: typeof subVal === 'string' && (subVal.includes('/') || subVal.includes('\\')) ? 'path' : 'text',
        });
      }
      continue;
    }
    const strVal = formatReadableValue(value);
    const kind: ChainParamItem['kind'] =
      /path|file|dir|cwd/i.test(key) ? 'path'
        : /cmd|command|pattern|query|code|script|content/i.test(key) ? 'code'
          : typeof value === 'boolean' || typeof value === 'number' ? 'badge'
            : 'text';
    params.push({ label: key, value: strVal, kind });
  }
}

function buildToolParams(toolName: string, args: Record<string, unknown>): ChainParamItem[] {
  const params: ChainParamItem[] = [];
  const handled = new Set<string>(['summary']);

  if (toolName === 'bash') {
    const cmd = asString(args.command ?? args.cmd);
    if (cmd !== undefined) {
      params.push({ label: '命令', value: cmd, kind: 'code' });
      handled.add('command');
      handled.add('cmd');
    }
    const cwd = asString(args.cwd ?? args.workdir);
    if (cwd) {
      params.push({ label: '工作目录', value: cwd, kind: 'path' });
      handled.add('cwd');
      handled.add('workdir');
    }
    const timeout = args.timeout ?? args.timeoutMs;
    if (timeout !== undefined && timeout !== '') {
      const timeoutLabel = typeof timeout === 'number'
        ? (timeout >= 1000 && 'timeoutMs' in args ? `${Math.round(timeout / 1000)}s` : `${timeout}s`)
        : String(timeout);
      params.push({ label: '超时', value: timeoutLabel, kind: 'badge' });
      handled.add('timeout');
      handled.add('timeoutMs');
    }
    appendExtraParams(params, args, handled);
    return params;
  }

  if (toolName === 'read' || toolName === 'start_read') {
    const pathVal = asString(args.path ?? args.file_path ?? args.filePath ?? args.fileName ?? args.input ?? args.fileId);
    if (pathVal) {
      params.push({ label: '文件路径', value: pathVal, kind: 'path' });
      handled.add('path');
      handled.add('file_path');
      handled.add('filePath');
      handled.add('fileName');
      handled.add('input');
      if (pathVal === args.fileId) handled.add('fileId');
    }
    const offset = args.offset ?? args.startLine;
    const limit = args.limit ?? args.endLine;
    if (offset !== undefined || limit !== undefined) {
      const parts: string[] = [];
      if (offset !== undefined) parts.push(`起始行 ${offset}`);
      if (limit !== undefined) parts.push(`限制 ${limit} 行`);
      params.push({ label: '行偏移/限制', value: parts.join(' · '), kind: 'text' });
      handled.add('offset');
      handled.add('startLine');
      handled.add('limit');
      handled.add('endLine');
    }
    appendExtraParams(params, args, handled);
    return params;
  }

  if (toolName === 'edit') {
    const pathVal = asString(args.path ?? args.file_path ?? args.filePath);
    if (pathVal) {
      params.push({ label: '文件路径', value: pathVal, kind: 'path' });
      handled.add('path');
      handled.add('file_path');
      handled.add('filePath');
    }
    const oldVal = asString(args.oldText ?? args.old_str ?? args.oldString ?? args.target);
    const newVal = asString(args.newText ?? args.new_str ?? args.newString ?? args.replacement);
    if (oldVal !== undefined) {
      params.push({ label: '修改前', value: oldVal, kind: 'diff_old' });
      handled.add('oldText');
      handled.add('old_str');
      handled.add('oldString');
      handled.add('target');
    }
    if (newVal !== undefined) {
      params.push({ label: '修改后', value: newVal, kind: 'diff_new' });
      handled.add('newText');
      handled.add('new_str');
      handled.add('newString');
      handled.add('replacement');
    }
    if (Array.isArray(args.edits)) {
      args.edits.forEach((entry, idx) => {
        if (!isPlainObject(entry)) return;
        const suffix = args.edits && (args.edits as unknown[]).length > 1 ? ` #${idx + 1}` : '';
        const oldPiece = asString(entry.oldText ?? entry.old_str ?? entry.oldString ?? entry.target);
        const newPiece = asString(entry.newText ?? entry.new_str ?? entry.newString ?? entry.replacement);
        if (oldPiece !== undefined) params.push({ label: `修改前${suffix}`, value: oldPiece, kind: 'diff_old' });
        if (newPiece !== undefined) params.push({ label: `修改后${suffix}`, value: newPiece, kind: 'diff_new' });
      });
      handled.add('edits');
    } else if (typeof args.edits === 'string' && args.edits.trim()) {
      const oldMatch = /"(?:oldText|old_str|oldString|target)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(args.edits);
      const newMatch = /"(?:newText|new_str|newString|replacement)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(args.edits);
      if (oldMatch?.[1] || newMatch?.[1]) {
        const decode = (s: string) => {
          try { return JSON.parse(`"${s}"`) as string; } catch { return s; }
        };
        if (oldMatch?.[1]) params.push({ label: '修改前', value: decode(oldMatch[1]), kind: 'diff_old' });
        if (newMatch?.[1]) params.push({ label: '修改后', value: decode(newMatch[1]), kind: 'diff_new' });
        handled.add('edits');
      }
    }
    appendExtraParams(params, args, handled);
    return params;
  }

  if (toolName === 'write') {
    const pathVal = asString(args.path ?? args.file_path ?? args.filePath);
    if (pathVal) {
      params.push({ label: '文件路径', value: pathVal, kind: 'path' });
      handled.add('path');
      handled.add('file_path');
      handled.add('filePath');
    }
    const contentVal = asString(args.content ?? args.text);
    if (contentVal !== undefined) {
      params.push({ label: '写入内容', value: contentVal, kind: 'code' });
      handled.add('content');
      handled.add('text');
    }
    appendExtraParams(params, args, handled);
    return params;
  }

  if (toolName === 'grep' || toolName === 'find' || toolName === 'ls') {
    const pattern = asString(args.pattern ?? args.query ?? args.glob);
    if (pattern) {
      params.push({ label: '匹配模式', value: pattern, kind: 'code' });
      handled.add('pattern');
      handled.add('query');
      handled.add('glob');
    }
    const targetPath = asString(args.path ?? args.dir ?? args.cwd);
    if (targetPath) {
      params.push({ label: '目标目录', value: targetPath, kind: 'path' });
      handled.add('path');
      handled.add('dir');
      handled.add('cwd');
    }
    const filterParts: string[] = [];
    for (const filterKey of ['include', 'exclude', 'type', 'literal', 'ignoreCase', 'caseSensitive', 'context', 'limit'] as const) {
      if (args[filterKey] !== undefined && args[filterKey] !== '') {
        filterParts.push(`${filterKey}: ${formatReadableValue(args[filterKey])}`);
        handled.add(filterKey);
      }
    }
    if (filterParts.length) {
      params.push({ label: '其他过滤', value: filterParts.join(' · '), kind: 'text' });
    }
    appendExtraParams(params, args, handled);
    return params;
  }

  if (toolName === 'run_plugin') {
    const plugin = asString(args.plugin);
    if (plugin) {
      params.push({ label: '插件', value: plugin, kind: 'badge' });
      handled.add('plugin');
    }
    const action = asString(args.pluginAction ?? args.action);
    if (action) {
      params.push({ label: '动作', value: action, kind: 'badge' });
      handled.add('pluginAction');
      handled.add('action');
    }
    if (isPlainObject(args.args)) {
      for (const [k, v] of Object.entries(args.args)) {
        if (v === undefined || v === null || v === '') continue;
        params.push({
          label: k,
          value: formatReadableValue(v),
          kind: typeof v === 'boolean' || typeof v === 'number' ? 'badge' : 'text',
        });
      }
      handled.add('args');
    }
    appendExtraParams(params, args, handled);
    return params;
  }

  appendExtraParams(params, args, handled);
  return params;
}

function summarizeToolArgs(toolName: string, args: Record<string, unknown>, params: ChainParamItem[]): string {
  if (toolName === 'bash') {
    const cmd = asString(args.command ?? args.cmd);
    if (cmd) return clipText(cmd, 90);
  }
  if (toolName === 'read' || toolName === 'start_read' || toolName === 'edit' || toolName === 'write') {
    const p = asString(args.path ?? args.file_path ?? args.filePath ?? args.fileName ?? args.input);
    if (p) return clipText(p, 90);
  }
  if (toolName === 'grep' || toolName === 'find' || toolName === 'ls') {
    const pat = asString(args.pattern ?? args.query ?? args.glob);
    const dir = asString(args.path ?? args.dir ?? args.cwd);
    if (pat && dir) return `${clipText(pat, 40)} @ ${clipText(dir, 45)}`;
    if (pat || dir) return clipText(pat ?? dir ?? '', 90);
  }
  if (toolName === 'run_plugin') {
    const plugin = asString(args.plugin);
    const action = asString(args.pluginAction ?? args.action);
    if (plugin && action) return `${plugin} · ${action}`;
    if (plugin) return plugin;
  }
  const first = params.find(p => p.value);
  return first ? clipText(`${first.label}: ${first.value}`, 90) : '';
}

function buildToolPreview(
  toolName: string,
  params: ChainParamItem[],
  args: Record<string, unknown>,
  resultText?: string,
  exitCode?: number,
  errorText?: string,
): string {
  const argBrief = summarizeToolArgs(toolName, args, params);
  if (toolName === 'bash' && argBrief) {
    const prefix = `$ ${argBrief}`;
    if (exitCode !== undefined && exitCode !== 0) return `${prefix} (退出码 ${exitCode})`;
    if (errorText) return `${prefix} · ${clipText(errorText, 50)}`;
    return prefix;
  }
  if (argBrief) {
    if (errorText) return `${argBrief} · 失败：${clipText(errorText, 50)}`;
    return argBrief;
  }
  if (errorText) return clipText(errorText, 100);
  if (resultText) return clipText(resultText, 100);
  return '执行中';
}

function extractToolOutput(
  endEvent: TraceEvent | undefined,
  opEvent?: TraceEvent,
  matchedOp?: ExecutionTraceOperationSummary,
): {
  resultText?: string;
  resultTruncated?: boolean;
  exitCode?: number;
  errorText?: string;
  operationId?: string;
  hasFullOutput?: boolean;
} {
  const endData = record(endEvent?.data);
  const detail = record(endData.detail);
  const summary = record(endData.summary);
  const opData = record(opEvent?.data);

  const rawDetailOutput = 'output' in detail ? detail.output : undefined;
  const detailOutputObj = isPlainObject(deepUnwrapJson(rawDetailOutput))
    ? deepUnwrapJson(rawDetailOutput) as Record<string, unknown>
    : undefined;
  const detailDetails = record(detailOutputObj?.details);

  const exitCode = asNumber(summary.exitCode ?? detailDetails.exitCode ?? detail.exitCode ?? endData.exitCode);

  let detailText = '';
  let detailIsError = false;
  if (rawDetailOutput !== undefined && !(detail.truncated === true && Object.keys(detail).length === 1)) {
    const extracted = extractReadableOperationOutput(rawDetailOutput);
    detailText = extracted.text;
    detailIsError = Boolean(detailOutputObj?.isError);
  }

  let summaryText = '';
  if (typeof summary.output === 'string' && summary.output) {
    summaryText = extractReadableOperationOutput(summary.output).text;
  }
  const opPreview = asString(opData.preview);
  const matchedPreview = matchedOp?.resultPreview ? extractReadableOperationOutput(matchedOp.resultPreview).text : undefined;
  const isAsyncOpAck = (raw: unknown, formatted: string): boolean => {
    if (!formatted) return false;
    const obj = isPlainObject(deepUnwrapJson(raw)) ? deepUnwrapJson(raw) as Record<string, unknown> : undefined;
    if (obj && 'operationId' in obj && obj.state === 'requested') return true;
    return /operationId:\s*\S+/.test(formatted) && /state:\s*requested/.test(formatted);
  };

  // Prefer fuller readable text between detailText and summaryText,
  // but never let an async start_read ack ("operationId / state: requested") shadow real settled operation output.
  let resultText: string | undefined;
  let resultTruncated = Boolean(summary.outputTruncated);
  if ((matchedPreview || opPreview) && (isAsyncOpAck(rawDetailOutput, detailText) || isAsyncOpAck(summary.output, summaryText))) {
    if (matchedPreview) {
      resultText = matchedPreview;
      resultTruncated = Boolean(matchedOp?.resultTruncated);
    } else if (opPreview) {
      resultText = extractReadableOperationOutput(opPreview).text;
      resultTruncated = true;
    }
  } else if (detailText && (!summaryText || detailText.length >= summaryText.length)) {
    resultText = detailText;
    resultTruncated = Boolean(detail.truncated) && !matchedOp?.hasFullResult;
  } else if (summaryText) {
    resultText = summaryText;
  } else if (matchedPreview) {
    resultText = matchedPreview;
    resultTruncated = Boolean(matchedOp?.resultTruncated);
  } else if (opPreview) {
    resultText = extractReadableOperationOutput(opPreview).text;
    resultTruncated = true;
  }

  const rawError = asNonEmptyString(detail.error)
    ?? asNonEmptyString(endData.error)
    ?? asNonEmptyString(detail.reason)
    ?? asNonEmptyString(opData.error)
    ?? asNonEmptyString(matchedOp?.error);

  // Avoid replacing real command stderr with generic placeholder when resultText already explains the failure
  const isGenericNativePlaceholder = rawError === '本机工具失败，详情见工具轨迹';
  const errorText = isGenericNativePlaceholder && resultText
    ? (exitCode !== undefined ? `命令退出码 ${exitCode}` : undefined)
    : rawError ?? (detailIsError && resultText ? undefined : undefined);

  const operationId = matchedOp?.id ?? (typeof opData.resultRef === 'string' ? opData.resultRef : opEvent?.spanId);
  const hasFullOutput = Boolean(matchedOp?.hasFullResult);

  return {
    ...(resultText ? { resultText } : {}),
    ...(resultTruncated ? { resultTruncated } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(errorText ? { errorText } : {}),
    ...(operationId ? { operationId, hasFullOutput } : {}),
  };
}

// ---------------- Span & Event Grouping ----------------

interface SpanPair {
  id: string;
  parentSpanId?: string;
  events: TraceEvent[];
  start?: TraceEvent;
  end?: TraceEvent;
  first: TraceEvent;
  latest: TraceEvent;
}

function addToSpanPair(map: Map<string, SpanPair>, event: TraceEvent, id: string): void {
  const existing = map.get(id);
  if (!existing) {
    const pair: SpanPair = {
      id,
      parentSpanId: event.parentSpanId && event.parentSpanId !== id ? event.parentSpanId : undefined,
      events: [event],
      start: activeStatus(event.status) ? event : undefined,
      end: !activeStatus(event.status) ? event : undefined,
      first: event,
      latest: event,
    };
    map.set(id, pair);
    return;
  }
  existing.events.push(event);
  if (event.parentSpanId && event.parentSpanId !== id && !existing.parentSpanId) {
    existing.parentSpanId = event.parentSpanId;
  }
  if (activeStatus(event.status) && !existing.start) existing.start = event;
  if (!activeStatus(event.status)) existing.end = event;
  existing.latest = event;
}

function isDecisionRouteSpan(ev: TraceEvent): boolean {
  return Boolean(
    (ev.spanId && ev.spanId.includes(':decision:route'))
    || ev.label === 'Gemini Decision 1 选模定级',
  );
}

function isDecisionQualitySpan(ev: TraceEvent): boolean {
  return Boolean(
    (ev.spanId && ev.spanId.includes(':decision:quality'))
    || ev.label === 'Gemini Decision 1 完成度评估',
  );
}

// ---------------- Main Semantic Chain Builder ----------------

/**
 * Transforms an `ExecutionTraceBundle` (or fallback bundle) into a chronological,
 * human-readable semantic execution chain with waterfall timings and structured inspector payloads.
 */
export function buildExecutionChain(bundle: ExecutionTraceBundle): ExecutionChainView {
  const sortedEvents = (bundle.events ?? []).toSorted((a, b) => a.seq - b.seq || a.at - b.at);
  const messages = (bundle.messages ?? []).toSorted((a, b) => a.seq - b.seq || a.at - b.at);

  // Fold visible_text increments if bundle.events still carries any
  const streamedMap = new Map<string, string>(Object.entries(bundle.streamedTextBySpan ?? {}));
  const localStreamAccumulator = new Map<string, string>();
  for (const ev of sortedEvents) {
    if (ev.kind === 'visible_text' && ev.spanId && !streamedMap.has(ev.spanId)) {
      const piece = asString(record(ev.data).text) ?? '';
      localStreamAccumulator.set(ev.spanId, `${localStreamAccumulator.get(ev.spanId) ?? ''}${piece}`);
    }
  }
  for (const [spanId, text] of localStreamAccumulator) {
    streamedMap.set(spanId, text);
  }

  // Task & Operation lookups
  const taskInfoMap = new Map<string, {
    id: string;
    prompt: string;
    status: string;
    profile?: string;
    workerModel?: string;
    modelTier?: string;
    thinkingLevel?: string;
    cwd?: string;
  }>();
  for (const lt of bundle.linkedTasks ?? []) {
    taskInfoMap.set(lt.id, lt);
  }
  if (bundle.task) {
    taskInfoMap.set(bundle.task.id, {
      id: bundle.task.id,
      prompt: bundle.task.prompt,
      status: bundle.task.status,
      profile: bundle.task.profile,
      workerModel: bundle.task.workerModel,
      modelTier: bundle.task.modelTier,
      thinkingLevel: bundle.task.thinkingLevel,
      cwd: bundle.task.cwd,
    });
  }
  const resolveTaskLabel = (taskId?: string, explicit?: string): string | undefined => {
    if (explicit) return extractTaskHeadline(explicit) ?? explicit;
    if (!taskId) return undefined;
    return extractTaskHeadline(taskInfoMap.get(taskId)?.prompt);
  };

  const ops = bundle.task?.operations ?? [];
  const opById = new Map(ops.map(op => [op.id, op]));
  const opByParentSpan = new Map<string, ExecutionTraceOperationSummary>();
  for (const op of ops) {
    if (op.parentSpanId) opByParentSpan.set(op.parentSpanId, op);
  }
  const findOperationForSpan = (spanId: string, taskId?: string): ExecutionTraceOperationSummary | undefined => {
    const direct = opByParentSpan.get(spanId) ?? opById.get(spanId);
    if (direct) return direct;
    const colon = spanId.indexOf(':');
    if (colon >= 0) {
      const suffix = spanId.slice(colon + 1);
      if (taskId) {
        const byTask = opById.get(`${taskId}:${suffix}`);
        if (byTask) return byTask;
      }
      if (bundle.task) {
        const byBundleTask = opById.get(`${bundle.task.id}:${suffix}`);
        if (byBundleTask) return byBundleTask;
      }
      return ops.find(o => o.id.endsWith(`:${suffix}`));
    }
    return undefined;
  };

  // Partition journal events
  const msgCreatedByMsgId = new Map<string, TraceEvent>();
  const msgUpdatedByMsgId = new Map<string, TraceEvent>();
  const orphanMessageEvents: TraceEvent[] = [];
  const sessionAssignedEvents: TraceEvent[] = [];
  const sessionNoteByMsgId = new Map<string, string>();
  const routeActionSpans = new Map<string, SpanPair>();
  const followupStateSpans = new Map<string, SpanPair>();
  const taskStateEvents: TraceEvent[] = [];
  const operationByParent = new Map<string, TraceEvent[]>();
  const allOperationEvents: TraceEvent[] = [];
  const agentReqSpans = new Map<string, SpanPair>();
  const llmSpans = new Map<string, SpanPair>();
  const decisionRouteSpans = new Map<string, SpanPair>();
  const decisionQualitySpans = new Map<string, SpanPair>();
  const sdkMetaSpans = new Map<string, SpanPair>();
  const toolSpans = new Map<string, SpanPair>();

  for (const ev of sortedEvents) {
    if (ev.kind === 'message_updated' && ev.messageId) {
      msgUpdatedByMsgId.set(ev.messageId, ev);
      continue;
    }
    if (IGNORED_EVENT_KINDS.has(ev.kind)) continue;

    if (ev.type === 'message') {
      if (ev.messageId && ev.kind === 'message_created' && !msgCreatedByMsgId.has(ev.messageId)) {
        msgCreatedByMsgId.set(ev.messageId, ev);
      } else {
        orphanMessageEvents.push(ev);
      }
      continue;
    }

    if (ev.kind === 'session_assigned') {
      sessionAssignedEvents.push(ev);
      if (ev.messageId) {
        const d = record(ev.data);
        const link = isPlainObject(d.sessionLink) ? d.sessionLink as unknown as SessionTurnLink : undefined;
        const note = formatSessionNote(link, asString(d.sessionId)) ?? ev.label;
        if (note) sessionNoteByMsgId.set(ev.messageId, note);
      }
      continue;
    }

    if (ev.kind === 'route_action') {
      addToSpanPair(routeActionSpans, ev, ev.spanId ?? ev.id);
      continue;
    }

    if (ev.kind === 'followup_state') {
      addToSpanPair(followupStateSpans, ev, ev.spanId ?? ev.id);
      continue;
    }

    if (ev.kind === 'task_state') {
      taskStateEvents.push(ev);
      continue;
    }

    if (ev.kind === 'operation') {
      allOperationEvents.push(ev);
      if (ev.parentSpanId && ev.parentSpanId !== ev.spanId) {
        const list = operationByParent.get(ev.parentSpanId) ?? [];
        list.push(ev);
        operationByParent.set(ev.parentSpanId, list);
      }
      continue;
    }

    if (ev.type === 'trace' && ev.kind === 'span') {
      const sid = ev.spanId ?? ev.id;
      if (ev.label === 'Agent 请求') {
        addToSpanPair(agentReqSpans, ev, sid);
      } else if (ev.label === '模型推理调用') {
        addToSpanPair(llmSpans, ev, sid);
      } else if (isDecisionRouteSpan(ev)) {
        addToSpanPair(decisionRouteSpans, ev, sid);
      } else if (isDecisionQualitySpan(ev)) {
        addToSpanPair(decisionQualitySpans, ev, sid);
      } else if (ev.label === '上下文压缩（SDK）' || ev.label === '模型请求重试（SDK）') {
        addToSpanPair(sdkMetaSpans, ev, sid);
      } else {
        addToSpanPair(toolSpans, ev, sid);
      }
    }
  }

  // Deduplicate route_action with its parent Router orchestration tool span
  const absorbedToolSpanIds = new Set<string>();
  const spanToNodeId = new Map<string, string>();
  const routeActionParentTool = new Map<string, SpanPair>();
  for (const [raId, raPair] of routeActionSpans) {
    const parentId = raPair.parentSpanId;
    if (!parentId) continue;
    const parentTool = toolSpans.get(parentId);
    if (parentTool && ROUTER_TOOLS.has(parentTool.first.label)) {
      absorbedToolSpanIds.add(parentId);
      routeActionParentTool.set(raId, parentTool);
      spanToNodeId.set(parentId, raId);
    }
  }

  const rawNodes: Array<Omit<ChainActionNode, 'offsetMs' | 'waterfallStartPermille' | 'waterfallWidthPermille'>> = [];
  const messageById = new Map(messages.map(m => [m.id, m]));
  const renderedMessageIds = new Set<string>();

  // Helper: map Router Agent 请求 spans so assistant delivery nodes align to the exact turn that finished producing them
  const routerReqList = [...agentReqSpans.values()]
    .filter(p => p.first.actor === 'router')
    .toSorted((a, b) => (a.first.seq - b.first.seq));

  // (A) Message Nodes from bundle.messages
  for (const msg of messages) {
    renderedMessageIds.add(msg.id);
    const createdEv = msgCreatedByMsgId.get(msg.id);
    const updatedEv = msgUpdatedByMsgId.get(msg.id);
    const isUser = msg.role === 'user';
    const isSystem = msg.source === 'system';
    const channelLabel = resolveChannelLabel(msg.origin, msg.text, msg.source);
    const speakerName = msg.origin?.speakerName;
    const speakerLabel = speakerName
      ? `${speakerName}${msg.origin?.speakerRole === 'owner' ? ' (主人)' : msg.origin?.speakerRole === 'member' ? ' (成员)' : ''}`
      : undefined;

    let effectiveAt = createdEv?.at ?? msg.at;
    let effectiveSeq = createdEv?.seq ?? msg.seq;

    if (!isUser) {
      if (updatedEv) {
        effectiveAt = Math.max(effectiveAt, updatedEv.at);
        effectiveSeq = Math.max(effectiveSeq, updatedEv.seq);
      } else {
        // Match the Router Agent 请求 that produced this reply:
        // 1) Direct messageId match (e.g. WORKER_REPORT / WORKER_QUESTION stamped with reply.id)
        // 2) Fallback to parent user messageId (CHAT turn) finishing before or at msg.version
        const matchingReq =
          routerReqList.findLast(req => req.first.messageId === msg.id)
          ?? (msg.replyTo
            ? routerReqList.findLast(req =>
                req.first.messageId === msg.replyTo
                && (msg.version <= 0 || (req.end?.seq ?? req.latest.seq) <= msg.version),
              )
            : undefined);
        const producerEnd = matchingReq?.end ?? matchingReq?.latest;
        if (producerEnd && msg.status !== 'streaming') {
          effectiveAt = Math.max(effectiveAt, producerEnd.at);
        }
        if (msg.version > (createdEv?.seq ?? 0)) {
          effectiveSeq = Math.max(msg.version, producerEnd ? producerEnd.seq + 0.5 : 0);
        } else if (producerEnd) {
          effectiveSeq = Math.max(effectiveSeq, producerEnd.seq + 0.5);
        }
      }
    }

    const sessionNote = formatSessionNote(msg.sessionLink, msg.sessionId) ?? sessionNoteByMsgId.get(msg.id);
    const actor: ChainActionNode['actor'] = isUser ? (isSystem ? 'system' : 'user') : (isSystem ? 'system' : 'router');
    const actorLabel = isUser
      ? (isSystem ? '系统定时' : speakerName ?? '用户')
      : (isSystem ? '系统通知' : 'F.R.I.D.A.Y.');
    const senderLabel = actorLabel;
    const displayText = msg.text || msg.reason || '';
    const preview = displayText
      ? clipText(displayText, 140)
      : (msg.status === 'streaming' ? '正在生成回复内容…' : '（无文本内容）');

    rawNodes.push({
      id: `msg:${msg.id}`,
      seq: effectiveSeq,
      at: effectiveAt,
      category: 'message',
      icon: isUser ? '📨' : '📤',
      actor,
      actorLabel,
      title: isUser ? '收到消息' : '公开回复交付',
      subtitle: speakerLabel ? `${channelLabel} · ${speakerLabel}` : channelLabel,
      preview,
      status: msg.status,
      statusLabel: resolveStatusLabel(msg.status),
      tone: resolveTone(msg.status),
      ...(msg.taskIds.length === 1 ? { taskId: msg.taskIds[0], taskLabel: resolveTaskLabel(msg.taskIds[0]) } : {}),
      messageId: msg.id,
      messageDetail: {
        messageId: msg.id,
        role: isUser ? (isSystem ? 'system' : 'user') : (isSystem ? 'system' : 'assistant'),
        senderLabel,
        channelLabel,
        ...(speakerLabel ? { speakerLabel } : {}),
        text: displayText,
        attachments: (msg.attachments ?? []).map(a => ({ name: a.name, kind: a.kind, status: a.status })),
        paths: msg.paths ?? [],
        ...(sessionNote ? { sessionNote } : {}),
      },
    });
  }

  // Fallback for journal `type === 'message'` events without a matching entry in `bundle.messages`
  for (const [msgId, ev] of msgCreatedByMsgId) {
    if (renderedMessageIds.has(msgId)) continue;
    renderedMessageIds.add(msgId);
    const evData = record(ev.data);
    const isUser = ev.actor === 'user';
    const text = asString(evData.text) ?? ev.label;
    const origin = isPlainObject(evData.origin) ? evData.origin as unknown as MessageOrigin : undefined;
    const channelLabel = resolveChannelLabel(origin, text);
    rawNodes.push({
      id: `msg:${msgId}`,
      seq: ev.seq,
      at: ev.at,
      category: 'message',
      icon: isUser ? '📨' : '📤',
      actor: ev.actor,
      actorLabel: isUser ? '用户' : 'F.R.I.D.A.Y.',
      title: isUser ? '收到消息' : '公开回复交付',
      subtitle: channelLabel,
      preview: clipText(text, 140),
      status: ev.status,
      statusLabel: resolveStatusLabel(ev.status),
      tone: resolveTone(ev.status),
      ...(ev.taskId ? { taskId: ev.taskId, taskLabel: resolveTaskLabel(ev.taskId) } : {}),
      messageId: msgId,
      messageDetail: {
        messageId: msgId,
        role: isUser ? 'user' : 'assistant',
        senderLabel: isUser ? '用户' : 'F.R.I.D.A.Y.',
        channelLabel,
        text,
        attachments: [],
        paths: [],
        ...(sessionNoteByMsgId.get(msgId) ? { sessionNote: sessionNoteByMsgId.get(msgId) } : {}),
      },
    });
  }

  for (const ev of orphanMessageEvents) {
    if (ev.messageId && renderedMessageIds.has(ev.messageId)) continue;
    const evData = record(ev.data);
    const isUser = ev.actor === 'user';
    const text = asString(evData.text) ?? ev.label;
    const channelLabel = resolveChannelLabel(undefined, text);
    rawNodes.push({
      id: `msg-ev:${ev.id}`,
      seq: ev.seq,
      at: ev.at,
      category: 'message',
      icon: isUser ? '📨' : '📤',
      actor: ev.actor,
      actorLabel: ACTOR_LABELS[ev.actor],
      title: isUser ? '收到消息' : '公开回复交付',
      subtitle: channelLabel,
      preview: clipText(text, 140),
      status: ev.status,
      statusLabel: resolveStatusLabel(ev.status),
      tone: resolveTone(ev.status),
      ...(ev.taskId ? { taskId: ev.taskId, taskLabel: resolveTaskLabel(ev.taskId) } : {}),
      ...(ev.messageId ? { messageId: ev.messageId } : {}),
      messageDetail: {
        messageId: ev.messageId ?? ev.id,
        role: isUser ? 'user' : 'assistant',
        senderLabel: isUser ? '用户' : 'F.R.I.D.A.Y.',
        channelLabel,
        text,
        attachments: [],
        paths: [],
      },
    });
  }

  // (B1) session_assigned (only emit standalone routing node when rich details exist or no user message absorbed it)
  for (const ev of sessionAssignedEvents) {
    const d = record(ev.data);
    const link = isPlainObject(d.sessionLink) ? d.sessionLink as unknown as SessionTurnLink : undefined;
    const reason = asNonEmptyString(d.reason);
    const hasRichDetails = Boolean(
      link?.detail
      || reason
      || link?.source === 'gemini-decision-1'
      || link?.confidence !== undefined
      || !ev.messageId
      || !messageById.has(ev.messageId),
    );
    if (!hasRichDetails) continue;
    const summaryItems: Array<{ label: string; value: string }> = [];
    if (link?.label) summaryItems.push({ label: '归并判定', value: link.label });
    if (link?.source) {
      summaryItems.push({
        label: '判定来源',
        value: link.source === 'gemini-decision-1' ? 'Gemini Decision 1' : link.source === 'causal' ? '因果关联' : '启发式规则',
      });
    }
    if (link?.gapSec !== undefined) summaryItems.push({ label: '距上轮间隔', value: `${link.gapSec}s` });
    if (link?.confidence !== undefined) summaryItems.push({ label: '置信度', value: `${Math.round(link.confidence * 100)}%` });
    if (asString(d.sessionId)) summaryItems.push({ label: '会话 ID', value: asString(d.sessionId)! });
    rawNodes.push({
      id: `session:${ev.id}`,
      seq: ev.seq,
      at: ev.at,
      category: 'routing',
      icon: '🔗',
      actor: 'system',
      actorLabel: '会话路由',
      title: '会话归并判定',
      subtitle: link?.source === 'gemini-decision-1' ? 'Gemini Decision 1' : undefined,
      preview: clipText(link?.detail ?? reason ?? link?.label ?? ev.label, 120),
      status: ev.status,
      statusLabel: resolveStatusLabel(ev.status),
      tone: resolveTone(ev.status),
      ...(ev.messageId ? { messageId: ev.messageId } : {}),
      routingDetail: {
        kindLabel: '会话上下文归并',
        summaryItems,
        ...(link?.detail || reason ? { promptText: link?.detail ?? reason } : {}),
      },
    });
  }

  // (B2) Agent 请求 spans (Router & Worker phases)
  const workerPhaseCounters = new Map<string, number>();
  const sortedAgentReqs = [...agentReqSpans.values()].toSorted((a, b) => a.first.seq - b.first.seq);
  for (const pair of sortedAgentReqs) {
    const startData = record(pair.start?.data);
    const endData = record(pair.end?.data);
    const trigger = record(startData.trigger);
    const inputObj = isPlainObject(deepUnwrapJson(startData.input)) ? deepUnwrapJson(startData.input) as Record<string, unknown> : {};
    const triggerKind = asString(trigger.kind) ?? (pair.first.actor === 'worker' ? 'TASK' : 'CHAT');
    const targetTaskId = asString(trigger.taskId) ?? pair.latest.taskId;
    const targetTaskLabel = resolveTaskLabel(targetTaskId);

    if (pair.first.actor === 'router') {
      const title = triggerKind === 'WORKER_REPORT'
        ? 'F.R.I.D.A.Y. 验收汇报'
        : triggerKind === 'WORKER_QUESTION'
          ? 'F.R.I.D.A.Y. 转达请示'
          : triggerKind === 'BOSS_DECISION'
            ? 'F.R.I.D.A.Y. 传达拍板'
            : triggerKind === 'WORKER_FAILED'
              ? 'F.R.I.D.A.Y. 处理异常'
              : 'F.R.I.D.A.Y. 接收输入';

      const triggerPreview = asNonEmptyString(trigger.preview)
        ?? asNonEmptyString(record(inputObj.message).text)
        ?? asNonEmptyString(inputObj.report)
        ?? asNonEmptyString(endData.output);

      const summaryItems: Array<{ label: string; value: string }> = [
        { label: '触发类型', value: TRIGGER_LABELS[triggerKind] ?? triggerKind },
      ];
      if (asString(startData.mode)) summaryItems.push({ label: '运行模式', value: asString(startData.mode)! });
      if (asString(inputObj.deliveryChannel)) summaryItems.push({ label: '投递渠道', value: asString(inputObj.deliveryChannel)! });
      if (asNumber(trigger.followupCount)) summaryItems.push({ label: '补充指令数', value: String(trigger.followupCount) });

      rawNodes.push({
        id: pair.id,
        seq: pair.first.seq,
        at: pair.first.at,
        ...(pair.end ? { endedAt: pair.end.at } : {}),
        category: 'routing',
        icon: '🧭',
        actor: 'router',
        actorLabel: 'F.R.I.D.A.Y.',
        title,
        subtitle: TRIGGER_LABELS[triggerKind] ?? triggerKind,
        preview: clipText(triggerPreview ?? TRIGGER_LABELS[triggerKind] ?? '主控调度处理', 130),
        status: pair.latest.status,
        statusLabel: resolveStatusLabel(pair.latest.status),
        tone: resolveTone(pair.latest.status),
        ...(targetTaskId ? { taskId: targetTaskId, taskLabel: targetTaskLabel } : {}),
        ...(pair.first.messageId ? { messageId: pair.first.messageId } : {}),
        routingDetail: {
          kindLabel: TRIGGER_LABELS[triggerKind] ?? triggerKind,
          ...(targetTaskId ? { targetTaskId, targetTaskLabel } : {}),
          summaryItems,
          ...(triggerPreview ? { promptText: triggerPreview } : {}),
          ...(asNonEmptyString(endData.output) ? { reportText: asString(endData.output) } : {}),
          ...(asNonEmptyString(endData.error) ? { errorText: asString(endData.error) } : {}),
        },
      });
    } else {
      // Worker Agent 请求
      const scopeKey = targetTaskId ?? pair.first.rootId ?? 'default';
      const phaseIdx = (workerPhaseCounters.get(scopeKey) ?? 0) + 1;
      workerPhaseCounters.set(scopeKey, phaseIdx);
      const title = phaseIdx === 1 ? 'Worker 接收任务' : `Worker 第 ${phaseIdx} 阶段推进`;

      const compiledCtx = record(inputObj.compiledContext);
      const cwd = asString(inputObj.cwd) ?? (targetTaskId ? taskInfoMap.get(targetTaskId)?.cwd : undefined) ?? bundle.task?.cwd;
      const execution = asString(inputObj.execution);
      const profile = asString(inputObj.profile ?? compiledCtx.profile) ?? bundle.task?.profile;
      const workerModel = asString(inputObj.workerModel ?? compiledCtx.workerModel) ?? bundle.task?.workerModel;
      const modelTier = asString(inputObj.modelTier ?? compiledCtx.modelTier) ?? bundle.task?.modelTier;
      const thinkingLevel = asString(inputObj.thinkingLevel ?? compiledCtx.thinkingLevel) ?? bundle.task?.thinkingLevel;
      const promptText = asNonEmptyString(inputObj.prompt)
        ?? (phaseIdx === 1 ? bundle.task?.prompt : undefined)
        ?? asNonEmptyString(trigger.preview);
      const contextBrief = asNonEmptyString(compiledCtx.contextBrief) ?? bundle.task?.contextBrief;

      let memories: ExecutionTraceMemoryBrief[] | undefined = bundle.task?.memories.length ? bundle.task.memories : undefined;
      if (!memories && Array.isArray(compiledCtx.recalledMemories) && compiledCtx.recalledMemories.length) {
        memories = compiledCtx.recalledMemories
          .filter(isPlainObject)
          .map(m => ({
            id: String(m.id ?? ''),
            topic: String(m.topic ?? ''),
            tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
            preview: clipText(String(m.content ?? m.preview ?? ''), 240),
          }));
      }

      const summaryItems: Array<{ label: string; value: string }> = [];
      if (phaseIdx > 1) summaryItems.push({ label: '推进阶段', value: `第 ${phaseIdx} 阶段 (${TRIGGER_LABELS[triggerKind] ?? triggerKind})` });
      if (profile) summaryItems.push({ label: '专精画像', value: profileBadges[profile] ?? profile });
      if (workerModel || modelTier) {
        summaryItems.push({
          label: '执行模型',
          value: workerModel
            ? `${workerModel}${thinkingLevel ? `@${thinkingLevel}` : ''}`
            : `${tierBadges[modelTier!] ?? modelTier}${thinkingLevel ? `@${thinkingLevel}` : ''}`,
        });
      }
      if (execution) summaryItems.push({ label: '执行沙箱', value: execution === 'native' ? '本机工具 (native)' : '受控快照 (snapshot)' });
      if (cwd) summaryItems.push({ label: '工作目录', value: cwd });

      const followupsRaw = Array.isArray(inputObj.followups) ? inputObj.followups : [];
      const followupTexts = followupsRaw
        .filter(isPlainObject)
        .map(f => asNonEmptyString(f.text))
        .filter((t): t is string => Boolean(t));
      const effectivePrompt = followupTexts.length && phaseIdx > 1
        ? followupTexts.join('\n')
        : promptText;

      rawNodes.push({
        id: pair.id,
        seq: pair.first.seq,
        at: pair.first.at,
        ...(pair.end ? { endedAt: pair.end.at } : {}),
        category: 'routing',
        icon: '⚙️',
        actor: 'worker',
        actorLabel: 'Worker',
        title,
        subtitle: workerModel ? `${workerModel}${thinkingLevel ? `@${thinkingLevel}` : ''}` : cwd,
        preview: clipText(effectivePrompt ?? 'Worker 执行任务', 130),
        status: pair.latest.status,
        statusLabel: resolveStatusLabel(pair.latest.status),
        tone: resolveTone(pair.latest.status),
        ...(targetTaskId ? { taskId: targetTaskId, taskLabel: targetTaskLabel } : {}),
        ...(pair.first.messageId ? { messageId: pair.first.messageId } : {}),
        routingDetail: {
          kindLabel: title,
          ...(targetTaskId ? { targetTaskId, targetTaskLabel } : {}),
          summaryItems,
          ...(effectivePrompt ? { promptText: effectivePrompt } : {}),
          ...(contextBrief ? { contextBrief } : {}),
          ...(memories?.length ? { memories } : {}),
          ...(asNonEmptyString(endData.output) ? { reportText: asString(endData.output) } : {}),
          ...(asNonEmptyString(endData.error) ? { errorText: asString(endData.error) } : {}),
        },
      });
    }
  }

  // (B3) route_action (merged with absorbed Router orchestration tool span)
  for (const [raId, raPair] of routeActionSpans) {
    const action = record(raPair.latest.data) as unknown as RouteAction;
    const parentTool = routeActionParentTool.get(raId);
    const parentToolName = parentTool?.first.label;
    const toolArgs = parentTool ? extractToolArgs(parentTool.start ?? parentTool.first, undefined, undefined, !parentTool.start) : {};
    const toolOut = parentTool ? extractToolOutput(parentTool.end) : {};

    const kind = action.kind ?? (parentToolName === 'run_plugin' ? 'plugin' : 'reply');
    const kindLabel = ROUTE_KIND_LABELS[kind] ?? routeLabel({ kind });
    const targetTaskId = action.taskId ?? raPair.latest.taskId;
    const targetTaskLabel = resolveTaskLabel(targetTaskId, action.taskLabel);
    const selectedModel = action.workerModel
      ?? asString(toolArgs.model)
      ?? (action.modelTier ? (tierBadges[action.modelTier] ?? action.modelTier) : undefined);

    const summaryItems: Array<{ label: string; value: string }> = [
      { label: '路由动作', value: kindLabel },
      { label: '受理状态', value: routeState({ status: action.status ?? raPair.latest.status, kind, delivery: action.delivery }) },
    ];
    if (targetTaskLabel) summaryItems.push({ label: '目标工作', value: targetTaskLabel });
    if (action.workerProfile || asString(toolArgs.profile)) {
      const prof = action.workerProfile ?? asString(toolArgs.profile)!;
      summaryItems.push({ label: '专精画像', value: profileBadges[prof] ?? prof });
    }
    if (selectedModel) {
      summaryItems.push({
        label: '选定模型',
        value: `${selectedModel}${action.thinkingLevel ? `@${action.thinkingLevel}` : ''}`,
      });
    }
    if (action.decisionSource) {
      summaryItems.push({
        label: '选模来源',
        value: action.decisionSource === 'gemini-decision-1' ? 'Gemini Decision 1' : action.decisionSource,
      });
    }
    if (asString(toolArgs.cwd)) summaryItems.push({ label: '工作目录', value: asString(toolArgs.cwd)! });
    if (asString(toolArgs.plugin)) summaryItems.push({ label: '插件', value: asString(toolArgs.plugin)! });
    if (asString(toolArgs.pluginAction ?? toolArgs.action)) {
      summaryItems.push({ label: '插件动作', value: asString(toolArgs.pluginAction ?? toolArgs.action)! });
    }
    if (isPlainObject(toolArgs.args)) {
      for (const [k, v] of Object.entries(toolArgs.args)) {
        if (v !== undefined && v !== null && v !== '') {
          summaryItems.push({ label: `参数 · ${k}`, value: formatReadableValue(v) });
        }
      }
    }
    if (action.searchQuery ?? asString(toolArgs.query)) {
      summaryItems.push({ label: '检索线索', value: (action.searchQuery ?? asString(toolArgs.query))! });
    }
    if (asString(toolArgs.topic)) {
      summaryItems.push({ label: '记忆主题', value: asString(toolArgs.topic)! });
    }
    if (action.memoryIds?.length) {
      summaryItems.push({ label: '关联记忆', value: `${action.memoryIds.length} 条` });
    }
    if (action.summary ?? asString(toolArgs.summary)) {
      summaryItems.push({ label: '公开说明', value: (action.summary ?? asString(toolArgs.summary))! });
    }

    const promptText = asNonEmptyString(toolArgs.instruction) ?? asNonEmptyString(toolArgs.content);
    const contextBrief = asNonEmptyString(toolArgs.contextBrief);
    const errorText = action.error ?? toolOut.errorText;
    const reportText = toolOut.resultText && kind !== 'new_work' && kind !== 'related_work'
      ? toolOut.resultText
      : undefined;

    const effectiveAt = parentTool?.start?.at ?? raPair.first.at;
    const endCandidates = [raPair.end?.at, parentTool?.end?.at].filter((v): v is number => v !== undefined);
    const effectiveEndAt = endCandidates.length ? Math.max(...endCandidates) : undefined;
    const effectiveSeq = parentTool?.first.seq ?? raPair.first.seq;
    const effectiveStatus = action.status ?? raPair.latest.status;

    const previewParts: string[] = [];
    if (targetTaskLabel) previewParts.push(targetTaskLabel);
    else if (asString(toolArgs.plugin)) previewParts.push(`${asString(toolArgs.plugin)}${asString(toolArgs.pluginAction ?? toolArgs.action) ? `/${asString(toolArgs.pluginAction ?? toolArgs.action)}` : ''}`);
    if (promptText && !targetTaskLabel) previewParts.push(clipText(promptText, 80));
    if (action.summary) previewParts.push(action.summary);
    else if (selectedModel) previewParts.push(selectedModel);
    if (!previewParts.length && errorText) previewParts.push(errorText);

    rawNodes.push({
      id: raId,
      seq: effectiveSeq,
      at: action.at && !parentTool ? Math.min(effectiveAt, action.at) : effectiveAt,
      ...(effectiveEndAt !== undefined && effectiveEndAt >= effectiveAt ? { endedAt: effectiveEndAt } : {}),
      category: 'routing',
      icon: kind === 'plugin' ? '🧩' : kind === 'reply' ? '💬' : '🧭',
      actor: 'router',
      actorLabel: 'F.R.I.D.A.Y.',
      title: kindLabel,
      ...(selectedModel ? { subtitle: selectedModel } : {}),
      preview: clipText(previewParts.join(' · ') || kindLabel, 130),
      status: effectiveStatus,
      statusLabel: resolveStatusLabel(effectiveStatus),
      tone: resolveTone(effectiveStatus, { hasError: Boolean(errorText) }),
      ...(targetTaskId ? { taskId: targetTaskId, taskLabel: targetTaskLabel } : {}),
      ...(raPair.first.messageId ? { messageId: raPair.first.messageId } : {}),
      routingDetail: {
        kindLabel,
        ...(targetTaskId ? { targetTaskId, targetTaskLabel } : {}),
        summaryItems,
        ...(promptText ? { promptText } : {}),
        ...(contextBrief ? { contextBrief } : {}),
        ...(reportText ? { reportText } : {}),
        ...(errorText ? { errorText } : {}),
      },
    });
  }

  // (B4) Gemini Decision 1 选模定级
  for (const pair of decisionRouteSpans.values()) {
    const d = record(pair.latest.data);
    const req = record(d.request);
    const model = asString(d.model) ?? bundle.task?.workerModel;
    const level = asString(d.thinkingLevel) ?? bundle.task?.thinkingLevel;
    const source = asString(d.source) ?? 'gemini-decision-1';
    const confidence = asNumber(d.confidence);
    const needsQualityGate = asBoolean(d.needsQualityGate);
    const needsQualityGateProb = asNumber(d.needsQualityGateProb);
    const fallbackReason = asNonEmptyString(d.fallbackReason);
    const usage = record(d.usage);

    const summaryItems: Array<{ label: string; value: string }> = [];
    if (model) summaryItems.push({ label: '选定模型', value: `${model}${level ? `@${level}` : ''}` });
    else if (level) summaryItems.push({ label: '思考等级', value: level });
    summaryItems.push({
      label: '决策来源',
      value: source === 'gemini-decision-1' ? 'Gemini Decision 1 (Jev)' : source === 'heuristic' ? '启发式规则回退' : source,
    });
    if (confidence !== undefined) summaryItems.push({ label: '决策置信度', value: `${Math.round(confidence * 100)}%` });
    if (needsQualityGate !== undefined) {
      summaryItems.push({
        label: '质检预判',
        value: needsQualityGate
          ? `需要完成度质检${needsQualityGateProb !== undefined ? ` (${Math.round(needsQualityGateProb * 100)}%)` : ''}`
          : `免评直通 (轻量任务)${needsQualityGateProb !== undefined ? ` (${Math.round(needsQualityGateProb * 100)}%)` : ''}`,
      });
    }
    const featureParts: string[] = [];
    if (asString(req.profile)) featureParts.push(`画像 ${profileBadges[asString(req.profile)!] ?? asString(req.profile)}`);
    if (asNumber(req.candidateCount) !== undefined) featureParts.push(`候选 ${req.candidateCount} 项`);
    if (asNumber(req.fileCount)) featureParts.push(`附件 ${req.fileCount} 个`);
    if (req.hasImages === true) featureParts.push('含图片');
    if (req.isTimer === true) featureParts.push('定时任务');
    if (featureParts.length) summaryItems.push({ label: '请求特征', value: featureParts.join(' · ') });
    if (fallbackReason) summaryItems.push({ label: '降级原因', value: fallbackReason });
    if (asNumber(usage.totalTokens)) summaryItems.push({ label: 'Decision Token', value: `${formatNumber(Number(usage.totalTokens))} tok` });

    const previewParts: string[] = [];
    if (model) previewParts.push(`选定 ${model}${level ? `@${level}` : ''}`);
    if (confidence !== undefined) previewParts.push(`置信度 ${Math.round(confidence * 100)}%`);
    if (needsQualityGate === false) previewParts.push('免评直通');
    if (fallbackReason) previewParts.push(`降级：${clipText(fallbackReason, 40)}`);

    rawNodes.push({
      id: pair.id,
      seq: pair.first.seq,
      at: pair.first.at,
      category: 'routing',
      icon: '🎯',
      actor: 'system',
      actorLabel: 'Gemini Decision 1',
      title: 'Gemini Decision 1 选模定级',
      subtitle: model ? `${model}${level ? `@${level}` : ''}` : undefined,
      preview: previewParts.join(' · ') || '完成选模与思考等级评估',
      status: pair.latest.status,
      statusLabel: resolveStatusLabel(pair.latest.status),
      tone: resolveTone(pair.latest.status),
      ...(pair.latest.taskId ? { taskId: pair.latest.taskId, taskLabel: resolveTaskLabel(pair.latest.taskId) } : {}),
      ...(pair.latest.messageId ? { messageId: pair.latest.messageId } : {}),
      routingDetail: {
        kindLabel: 'Jev 智能选模定级',
        ...(pair.latest.taskId ? { targetTaskId: pair.latest.taskId, targetTaskLabel: resolveTaskLabel(pair.latest.taskId) } : {}),
        summaryItems,
        ...(asNonEmptyString(req.instructionPreview) ? { promptText: asString(req.instructionPreview) } : {}),
        ...(fallbackReason ? { errorText: fallbackReason } : {}),
      },
    });
  }

  // Synthesize選模 node from bundle.task when span is absent but decision metadata exists
  if (decisionRouteSpans.size === 0 && bundle.task && (bundle.task.decisionSource || bundle.task.workerModel)) {
    const t = bundle.task;
    const summaryItems: Array<{ label: string; value: string }> = [];
    if (t.workerModel) summaryItems.push({ label: '选定模型', value: `${t.workerModel}${t.thinkingLevel ? `@${t.thinkingLevel}` : ''}` });
    else if (t.modelTier) summaryItems.push({ label: '模型档位', value: tierBadges[t.modelTier] ?? t.modelTier });
    if (t.decisionSource) {
      summaryItems.push({
        label: '决策来源',
        value: t.decisionSource === 'gemini-decision-1' ? 'Gemini Decision 1 (Jev)' : t.decisionSource === 'heuristic' ? '启发式规则回退' : t.decisionSource,
      });
    }
    if (t.decisionConfidence !== undefined) summaryItems.push({ label: '决策置信度', value: `${Math.round(t.decisionConfidence * 100)}%` });
    if (t.skipQualityGate !== undefined) summaryItems.push({ label: '质检策略', value: t.skipQualityGate ? '免评直通' : '启用完成度质检' });

    const firstWorkerAt = sortedAgentReqs.find(r => r.first.actor === 'worker')?.first.at;
    const synthAt = firstWorkerAt ? Math.min(t.createdAt, firstWorkerAt - 1) : t.createdAt;
    const firstWorkerSeq = sortedAgentReqs.find(r => r.first.actor === 'worker')?.first.seq;
    const synthSeq = firstWorkerSeq !== undefined ? Math.max(0, firstWorkerSeq - 0.5) : 0.5;
    const synthStatus = t.decisionSource === 'heuristic' ? 'fallback' : 'completed';

    rawNodes.push({
      id: `${t.id}:decision:route`,
      seq: synthSeq,
      at: synthAt,
      category: 'routing',
      icon: '🎯',
      actor: 'system',
      actorLabel: 'Gemini Decision 1',
      title: 'Gemini Decision 1 选模定级',
      subtitle: t.workerModel ? `${t.workerModel}${t.thinkingLevel ? `@${t.thinkingLevel}` : ''}` : undefined,
      preview: [
        t.workerModel ? `选定 ${t.workerModel}${t.thinkingLevel ? `@${t.thinkingLevel}` : ''}` : '',
        t.decisionConfidence !== undefined ? `置信度 ${Math.round(t.decisionConfidence * 100)}%` : '',
        t.skipQualityGate ? '免评直通' : '',
      ].filter(Boolean).join(' · ') || '任务选模配置',
      status: synthStatus,
      statusLabel: resolveStatusLabel(synthStatus),
      tone: resolveTone(synthStatus),
      taskId: t.id,
      taskLabel: resolveTaskLabel(t.id),
      routingDetail: {
        kindLabel: 'Jev 智能选模定级',
        targetTaskId: t.id,
        targetTaskLabel: resolveTaskLabel(t.id),
        summaryItems,
        promptText: t.prompt,
      },
    });
  }

  // (B5) Gemini Decision 1 完成度评估
  for (const pair of decisionQualitySpans.values()) {
    const d = record(pair.latest.data);
    const req = record(d.request);
    const score = asNumber(d.score) ?? 0;
    const maxScore = asNumber(d.maxScore) ?? 3;
    const confidence = asNumber(d.confidence) ?? 0;
    const shouldSupplement = Boolean(d.shouldSupplement);
    const skippedByRoute = Boolean(d.skippedByRoute);
    const missingAspect = asString(d.missingAspect) ?? 'none';
    const source = asString(d.source) ?? 'heuristic';
    const fallbackReason = asNonEmptyString(d.fallbackReason);
    const usage = record(d.usage);

    const summaryItems: Array<{ label: string; value: string }> = [
      { label: '质检得分', value: skippedByRoute ? '免评直通' : `${score.toFixed(2)} / ${maxScore}` },
      { label: '置信度', value: `${Math.round(confidence * 100)}%` },
      { label: '质检结论', value: skippedByRoute ? '轻量任务免评直通' : shouldSupplement ? '建议补做核查' : '达标通过' },
    ];
    if (shouldSupplement && missingAspect !== 'none') {
      summaryItems.push({ label: '缺失项', value: MISSING_ASPECT_LABELS[missingAspect] ?? missingAspect });
    }
    if (asNumber(req.succeededOps) !== undefined || asNumber(req.failedOps) !== undefined) {
      summaryItems.push({ label: '工具执行统计', value: `成功 ${req.succeededOps ?? 0} 次 · 失败 ${req.failedOps ?? 0} 次` });
    }
    summaryItems.push({
      label: '决策来源',
      value: source === 'gemini-decision-1' ? 'Gemini Decision 1 (Jev)' : '启发式规则回退',
    });
    if (fallbackReason) summaryItems.push({ label: '降级原因', value: fallbackReason });
    if (asNumber(usage.totalTokens)) summaryItems.push({ label: 'Decision Token', value: `${formatNumber(Number(usage.totalTokens))} tok` });

    const effectiveStatus = skippedByRoute ? 'skipped' : pair.latest.status;
    const preview = skippedByRoute
      ? '免评直通（选模预判轻量任务）'
      : `得分 ${score.toFixed(2)} / ${maxScore} · 置信度 ${Math.round(confidence * 100)}% · ${shouldSupplement ? `建议补做（${MISSING_ASPECT_LABELS[missingAspect] ?? missingAspect}）` : '质检达标'}`;

    rawNodes.push({
      id: pair.id,
      seq: pair.first.seq,
      at: pair.first.at,
      category: 'routing',
      icon: '🧪',
      actor: 'system',
      actorLabel: 'Gemini Decision 1',
      title: 'Gemini Decision 1 完成度评估',
      subtitle: skippedByRoute ? '免评直通' : `${score.toFixed(2)} / ${maxScore}`,
      preview,
      status: effectiveStatus,
      statusLabel: resolveStatusLabel(effectiveStatus),
      tone: resolveTone(effectiveStatus, { shouldSupplement }),
      ...(pair.latest.taskId ? { taskId: pair.latest.taskId, taskLabel: resolveTaskLabel(pair.latest.taskId) } : {}),
      ...(pair.latest.messageId ? { messageId: pair.latest.messageId } : {}),
      routingDetail: {
        kindLabel: 'Jev 完成度质检',
        ...(pair.latest.taskId ? { targetTaskId: pair.latest.taskId, targetTaskLabel: resolveTaskLabel(pair.latest.taskId) } : {}),
        summaryItems,
        ...(fallbackReason ? { errorText: fallbackReason } : {}),
      },
    });
  }

  // Synthesize quality gate node from bundle.task.qualityGate if span is absent
  if (decisionQualitySpans.size === 0 && bundle.task?.qualityGate) {
    const qg = record(bundle.task.qualityGate);
    const score = asNumber(qg.score) ?? 0;
    const maxScore = asNumber(qg.maxScore) ?? 3;
    const confidence = asNumber(qg.confidence) ?? 0;
    const shouldSupplement = Boolean(qg.shouldSupplement);
    const skippedByRoute = Boolean(qg.skippedByRoute);
    const missingAspect = asString(qg.missingAspect) ?? 'none';
    const evaluatedAt = asNumber(qg.evaluatedAt) ?? bundle.task.createdAt;
    const effectiveStatus = skippedByRoute ? 'skipped' : asString(qg.source) === 'gemini-decision-1' ? 'completed' : 'fallback';
    rawNodes.push({
      id: `${bundle.task.id}:decision:quality`,
      seq: (sortedEvents.at(-1)?.seq ?? 0) + 0.2,
      at: evaluatedAt,
      category: 'routing',
      icon: '🧪',
      actor: 'system',
      actorLabel: 'Gemini Decision 1',
      title: 'Gemini Decision 1 完成度评估',
      subtitle: skippedByRoute ? '免评直通' : `${score.toFixed(2)} / ${maxScore}`,
      preview: skippedByRoute
        ? '免评直通（选模预判轻量任务）'
        : `得分 ${score.toFixed(2)} / ${maxScore} · 置信度 ${Math.round(confidence * 100)}% · ${shouldSupplement ? '建议补做' : '质检达标'}`,
      status: effectiveStatus,
      statusLabel: resolveStatusLabel(effectiveStatus),
      tone: resolveTone(effectiveStatus, { shouldSupplement }),
      taskId: bundle.task.id,
      taskLabel: resolveTaskLabel(bundle.task.id),
      routingDetail: {
        kindLabel: 'Jev 完成度质检',
        targetTaskId: bundle.task.id,
        targetTaskLabel: resolveTaskLabel(bundle.task.id),
        summaryItems: [
          { label: '质检得分', value: skippedByRoute ? '免评直通' : `${score.toFixed(2)} / ${maxScore}` },
          { label: '置信度', value: `${Math.round(confidence * 100)}%` },
          { label: '质检结论', value: skippedByRoute ? '轻量任务免评直通' : shouldSupplement ? `建议补做 (${MISSING_ASPECT_LABELS[missingAspect] ?? missingAspect})` : '达标通过' },
        ],
      },
    });
  }

  // (B6) task_state (filter redundant pure accepted/running/queued spam)
  for (const ev of taskStateEvents) {
    const d = record(ev.data);
    const reason = asNonEmptyString(d.reason);
    const text = asNonEmptyString(d.text);
    const isAskBoss = ev.status === 'waiting_decision' || ev.status === 'decision_received';
    const isTerminalDiagnostic = ['failed', 'cancelled', 'paused', 'followup_failed', 'router_report_fallback'].includes(ev.status);
    const isCompletedWithNote = ev.status === 'completed' && Boolean(reason || text);
    if (!isAskBoss && !isTerminalDiagnostic && !isCompletedWithNote && !(ev.status === 'followup' && text)) {
      continue;
    }

    let title = `任务状态 · ${resolveStatusLabel(ev.status)}`;
    let icon = '📌';
    let options: string[] | undefined;
    let promptText = text ?? reason;
    if (ev.status === 'waiting_decision') {
      title = 'ASK_BOSS 盘中请示';
      icon = '🙋';
      if (bundle.task?.pendingQuestion) {
        promptText = bundle.task.pendingQuestion.question;
        options = bundle.task.pendingQuestion.options;
      } else {
        // Recover question and options from the paired WORKER_QUESTION Router turn for settled historical tasks
        const matchedQReq = routerReqList.find(req => {
          const rStart = record(req.start?.data);
          const trig = record(rStart.trigger);
          return trig.kind === 'WORKER_QUESTION' && (!ev.taskId || trig.taskId === ev.taskId || req.first.taskId === ev.taskId);
        });
        const qInput = isPlainObject(deepUnwrapJson(record(matchedQReq?.start?.data).input))
          ? deepUnwrapJson(record(matchedQReq?.start?.data).input) as Record<string, unknown>
          : {};
        if (asNonEmptyString(qInput.question)) promptText = asString(qInput.question);
        if (Array.isArray(qInput.options)) options = qInput.options.map(String);
      }
    } else if (ev.status === 'decision_received') {
      title = '收到老板拍板继续';
      icon = '✅';
    } else if (ev.status === 'paused') {
      title = '后台工作已暂停';
      icon = '⏸️';
    } else if (ev.status === 'failed' || ev.status === 'followup_failed') {
      title = '后台工作异常';
      icon = '⚠️';
    } else if (ev.status === 'cancelled') {
      title = '后台工作已取消';
      icon = '🛑';
    } else if (ev.status === 'completed') {
      title = '后台工作结算完成';
      icon = '✅';
    }

    const summaryItems: Array<{ label: string; value: string }> = [
      { label: '状态', value: resolveStatusLabel(ev.status) },
    ];
    if (asString(d.mode)) summaryItems.push({ label: '模式', value: asString(d.mode)! });
    if (reason && reason !== promptText) summaryItems.push({ label: '说明', value: reason });

    rawNodes.push({
      id: `task-state:${ev.id}`,
      seq: ev.seq,
      at: ev.at,
      category: 'routing',
      icon,
      actor: ev.actor,
      actorLabel: ACTOR_LABELS[ev.actor],
      title,
      preview: clipText(promptText ?? reason ?? resolveStatusLabel(ev.status), 130),
      status: ev.status,
      statusLabel: resolveStatusLabel(ev.status),
      tone: resolveTone(ev.status),
      ...(ev.taskId ? { taskId: ev.taskId, taskLabel: resolveTaskLabel(ev.taskId) } : {}),
      ...(ev.messageId ? { messageId: ev.messageId } : {}),
      routingDetail: {
        kindLabel: title,
        ...(ev.taskId ? { targetTaskId: ev.taskId, targetTaskLabel: resolveTaskLabel(ev.taskId) } : {}),
        summaryItems,
        ...(promptText ? { promptText } : {}),
        ...(options?.length ? { options } : {}),
        ...(isTerminalDiagnostic && reason ? { errorText: reason } : {}),
      },
    });
  }

  // (B7) followup_state
  const followupById = new Map((bundle.task?.followups ?? []).map(f => [f.id, f]));
  for (const pair of followupStateSpans.values()) {
    const d = record(pair.latest.data);
    const state = asString(d.state) ?? pair.latest.status;
    const followupId = asString(d.followupId);
    const matchedFollowup = followupId ? followupById.get(followupId) : undefined;
    const targetTaskLabel = resolveTaskLabel(pair.latest.taskId, asString(d.taskLabel));
    const summaryItems: Array<{ label: string; value: string }> = [
      { label: '交付状态', value: resolveStatusLabel(state) },
    ];
    if (targetTaskLabel) summaryItems.push({ label: '目标工作', value: targetTaskLabel });
    if (followupId) summaryItems.push({ label: '补充指令 ID', value: followupId });

    rawNodes.push({
      id: pair.id,
      seq: pair.first.seq,
      at: pair.first.at,
      ...(pair.end && pair.end.at >= pair.first.at ? { endedAt: pair.end.at } : {}),
      category: 'routing',
      icon: '💬',
      actor: 'worker',
      actorLabel: 'Worker',
      title: '补充指令交付',
      ...(targetTaskLabel ? { subtitle: targetTaskLabel } : {}),
      preview: clipText(matchedFollowup?.text ?? `${resolveStatusLabel(state)}${targetTaskLabel ? ` · ${targetTaskLabel}` : ''}`, 130),
      status: state,
      statusLabel: resolveStatusLabel(state),
      tone: resolveTone(state),
      ...(pair.latest.taskId ? { taskId: pair.latest.taskId, taskLabel: targetTaskLabel } : {}),
      ...(pair.latest.messageId ? { messageId: pair.latest.messageId } : {}),
      routingDetail: {
        kindLabel: '补充指令交付 (Follow-up)',
        ...(pair.latest.taskId ? { targetTaskId: pair.latest.taskId, targetTaskLabel } : {}),
        summaryItems,
        ...(matchedFollowup?.text ? { promptText: matchedFollowup.text } : {}),
      },
    });
  }

  // (B8) SDK maintenance spans (compaction / retry)
  for (const pair of sdkMetaSpans.values()) {
    const detail = record(record(pair.latest.data).detail);
    const isRetry = pair.first.label.includes('重试');
    const summaryItems: Array<{ label: string; value: string }> = [];
    if (isRetry) {
      if (asNumber(detail.attempt) !== undefined) summaryItems.push({ label: '重试次数', value: `${detail.attempt}/${detail.maxAttempts ?? '?'}` });
      if (asNumber(detail.delayMs) !== undefined) summaryItems.push({ label: '退避等待', value: `${detail.delayMs}ms` });
    } else {
      if (asNumber(detail.tokensBefore) !== undefined) summaryItems.push({ label: '压缩前 Token', value: formatNumber(Number(detail.tokensBefore)) });
      if (asNumber(detail.estimatedTokensAfter) !== undefined) summaryItems.push({ label: '压缩后预估', value: formatNumber(Number(detail.estimatedTokensAfter)) });
    }
    const err = asNonEmptyString(detail.error ?? detail.finalError);
    rawNodes.push({
      id: pair.id,
      seq: pair.first.seq,
      at: pair.first.at,
      ...(pair.end && pair.end.at >= pair.first.at ? { endedAt: pair.end.at } : {}),
      category: 'routing',
      icon: isRetry ? '🔄' : '🗜️',
      actor: pair.first.actor,
      actorLabel: ACTOR_LABELS[pair.first.actor],
      title: pair.first.label,
      preview: clipText(err ?? (summaryItems.length ? summaryItems.map(i => `${i.label}: ${i.value}`).join(' · ') : pair.first.label), 120),
      status: pair.latest.status,
      statusLabel: resolveStatusLabel(pair.latest.status),
      tone: resolveTone(pair.latest.status, { hasError: Boolean(err) }),
      ...(pair.latest.taskId ? { taskId: pair.latest.taskId, taskLabel: resolveTaskLabel(pair.latest.taskId) } : {}),
      routingDetail: {
        kindLabel: pair.first.label,
        summaryItems,
        ...(err ? { errorText: err } : {}),
      },
    });
  }

  // (D) Tool Execution Nodes
  const toolNodesList: Array<{ node: Omit<ChainActionNode, 'offsetMs' | 'waterfallStartPermille' | 'waterfallWidthPermille'>; parentSpanId?: string }> = [];
  const toolInfoBySpanId = new Map<string, ChainToolDecision>();

  for (const [tid, pair] of toolSpans) {
    const toolName = pair.first.label;
    const meta = TOOL_META[toolName] ?? { displayName: toolName, categoryLabel: '扩展工具', icon: '🔧' };
    const matchedOp = findOperationForSpan(tid, pair.latest.taskId);
    const attachedOps = operationByParent.get(tid);
    const opSettlement = attachedOps?.at(-1);
    const args = extractToolArgs(pair.start ?? pair.first, opSettlement, matchedOp, !pair.start);
    const params = buildToolParams(toolName, args);
    const out = extractToolOutput(pair.end, opSettlement, matchedOp);

    // Record for parent LLM's toolDecisions (even if absorbed by a route_action!)
    toolInfoBySpanId.set(tid, {
      spanId: spanToNodeId.get(tid) ?? tid,
      toolName,
      displayName: meta.displayName,
      summary: summarizeToolArgs(toolName, args, params) || meta.displayName,
    });

    if (absorbedToolSpanIds.has(tid)) continue;

    let effectiveStatus = pair.latest.status;
    if (opSettlement && ['failed', 'unknown', 'cancelled'].includes(opSettlement.status) && effectiveStatus !== 'failed') {
      effectiveStatus = opSettlement.status;
    } else if (matchedOp && ['failed', 'unknown', 'cancelled'].includes(matchedOp.status) && effectiveStatus === 'started') {
      effectiveStatus = matchedOp.status;
    }

    const preview = buildToolPreview(toolName, params, args, out.resultText, out.exitCode, out.errorText);
    const taskId = pair.latest.taskId ?? bundle.task?.id;

    const toolNode: Omit<ChainActionNode, 'offsetMs' | 'waterfallStartPermille' | 'waterfallWidthPermille'> = {
      id: tid,
      seq: pair.first.seq,
      at: pair.first.at,
      ...(pair.end && pair.end.at >= pair.first.at ? { endedAt: pair.end.at } : {}),
      category: 'tool',
      icon: meta.icon,
      actor: pair.first.actor,
      actorLabel: ACTOR_LABELS[pair.first.actor],
      title: meta.displayName,
      subtitle: toolName !== meta.displayName ? toolName : undefined,
      preview,
      status: effectiveStatus,
      statusLabel: resolveStatusLabel(effectiveStatus),
      tone: resolveTone(effectiveStatus, { exitCode: out.exitCode, hasError: Boolean(out.errorText) }),
      ...(taskId ? { taskId, taskLabel: resolveTaskLabel(taskId) } : {}),
      ...(pair.first.messageId ? { messageId: pair.first.messageId } : {}),
      toolDetail: {
        toolName,
        displayName: meta.displayName,
        categoryLabel: meta.categoryLabel,
        params,
        ...(out.resultText !== undefined ? { resultText: out.resultText } : {}),
        ...(out.resultTruncated ? { resultTruncated: true } : {}),
        ...(out.exitCode !== undefined ? { exitCode: out.exitCode } : {}),
        ...(out.errorText ? { errorText: out.errorText } : {}),
        ...(out.operationId ? { operationId: out.operationId } : {}),
        ...(taskId ? { taskId } : {}),
        ...(out.hasFullOutput !== undefined ? { hasFullOutput: out.hasFullOutput } : {}),
      },
    };
    rawNodes.push(toolNode);
    toolNodesList.push({ node: toolNode, parentSpanId: pair.parentSpanId });
  }

  // Orphan operation events whose owning tool span wasn't in the window
  const orphanOpsGrouped = new Map<string, TraceEvent[]>();
  for (const opEv of allOperationEvents) {
    if (opEv.parentSpanId && toolSpans.has(opEv.parentSpanId)) continue;
    const key = opEv.spanId ?? opEv.id;
    const list = orphanOpsGrouped.get(key) ?? [];
    list.push(opEv);
    orphanOpsGrouped.set(key, list);
  }
  for (const [opKey, evs] of orphanOpsGrouped) {
    const first = evs[0]!;
    const latest = evs.at(-1)!;
    const d = record(latest.data);
    const fileId = asString(d.fileId) ?? '';
    const toolName = fileId.startsWith('native:') ? fileId.slice(7) : 'start_read';
    const meta = TOOL_META[toolName] ?? { displayName: latest.label, categoryLabel: '扩展工具', icon: '🔧' };
    const matchedOp = opById.get(opKey);
    const params: ChainParamItem[] = [];
    if (asString(d.fileName)) params.push({ label: '文件路径', value: asString(d.fileName)!, kind: 'path' });
    else if (fileId && !fileId.startsWith('native:')) params.push({ label: '文件标识', value: fileId, kind: 'badge' });
    const out = extractToolOutput(undefined, latest, matchedOp);
    const taskId = latest.taskId ?? bundle.task?.id;

    const toolNode: Omit<ChainActionNode, 'offsetMs' | 'waterfallStartPermille' | 'waterfallWidthPermille'> = {
      id: opKey,
      seq: first.seq,
      at: first.at,
      ...(latest !== first && latest.at >= first.at ? { endedAt: latest.at } : {}),
      category: 'tool',
      icon: meta.icon,
      actor: first.actor,
      actorLabel: ACTOR_LABELS[first.actor],
      title: meta.displayName,
      subtitle: toolName !== meta.displayName ? toolName : undefined,
      preview: buildToolPreview(toolName, params, {}, out.resultText, out.exitCode, out.errorText),
      status: latest.status,
      statusLabel: resolveStatusLabel(latest.status),
      tone: resolveTone(latest.status, { hasError: Boolean(out.errorText) }),
      ...(taskId ? { taskId, taskLabel: resolveTaskLabel(taskId) } : {}),
      toolDetail: {
        toolName,
        displayName: meta.displayName,
        categoryLabel: meta.categoryLabel,
        params,
        ...(out.resultText !== undefined ? { resultText: out.resultText } : {}),
        ...(out.resultTruncated ? { resultTruncated: true } : {}),
        ...(out.errorText ? { errorText: out.errorText } : {}),
        ...(out.operationId ? { operationId: out.operationId } : {}),
        ...(taskId ? { taskId } : {}),
        ...(out.hasFullOutput !== undefined ? { hasFullOutput: out.hasFullOutput } : {}),
      },
    };
    rawNodes.push(toolNode);
    toolNodesList.push({ node: toolNode, parentSpanId: latest.parentSpanId });
  }

  // Fallback: historical task operations when zero tool spans/operation events exist in journal
  if (toolNodesList.length === 0 && bundle.task && bundle.task.operations.length > 0) {
    bundle.task.operations.forEach((op, idx) => {
      const toolName = op.fileId.startsWith('native:') ? op.fileId.slice(7) : 'start_read';
      const meta = TOOL_META[toolName] ?? { displayName: toolName, categoryLabel: '扩展工具', icon: '🔧' };
      const params: ChainParamItem[] = op.fileId.startsWith('native:')
        ? []
        : [{ label: '文件标识', value: op.fileId, kind: 'badge' }];
      const out = extractToolOutput(undefined, undefined, op);
      rawNodes.push({
        id: op.id,
        seq: idx + 0.1,
        at: bundle.task!.createdAt + idx + 1,
        category: 'tool',
        icon: meta.icon,
        actor: op.fileId.startsWith('native:') ? 'worker' : 'executor',
        actorLabel: op.fileId.startsWith('native:') ? 'Worker' : '执行器',
        title: meta.displayName,
        subtitle: toolName,
        preview: buildToolPreview(toolName, params, {}, out.resultText, out.exitCode, out.errorText),
        status: op.status,
        statusLabel: resolveStatusLabel(op.status),
        tone: resolveTone(op.status, { hasError: Boolean(out.errorText) }),
        taskId: bundle.task!.id,
        taskLabel: resolveTaskLabel(bundle.task!.id),
        toolDetail: {
          toolName,
          displayName: meta.displayName,
          categoryLabel: meta.categoryLabel,
          params,
          ...(out.resultText !== undefined ? { resultText: out.resultText } : {}),
          ...(out.resultTruncated ? { resultTruncated: true } : {}),
          ...(out.errorText ? { errorText: out.errorText } : {}),
          operationId: op.id,
          taskId: bundle.task!.id,
          ...(op.hasFullResult ? { hasFullOutput: true } : {}),
        },
      });
    });
  }

  // Index child tool decisions & tool nodes by parentSpanId for LLM context association
  const childToolsByLlmSpan = new Map<string, Array<{ rawSpanId: string; decision: ChainToolDecision }>>();
  for (const [tid, pair] of toolSpans) {
    if (!pair.parentSpanId) continue;
    const decision = toolInfoBySpanId.get(tid);
    if (!decision) continue;
    const list = childToolsByLlmSpan.get(pair.parentSpanId) ?? [];
    list.push({ rawSpanId: tid, decision });
    childToolsByLlmSpan.set(pair.parentSpanId, list);
  }

  const toolNodesByLlmSpan = new Map<string, typeof toolNodesList[number]['node'][]>();
  for (const entry of toolNodesList) {
    if (!entry.parentSpanId) continue;
    const list = toolNodesByLlmSpan.get(entry.parentSpanId) ?? [];
    list.push(entry.node);
    toolNodesByLlmSpan.set(entry.parentSpanId, list);
  }

  // (C) LLM Call Nodes
  const sortedLlmSpans = [...llmSpans.values()].toSorted((a, b) => a.first.seq - b.first.seq || a.first.at - b.first.at);
  const routerLlmCount = sortedLlmSpans.filter(p => p.first.actor === 'router').length;
  let routerLlmIdx = 0;
  const workerLlmCounters = new Map<string, number>();
  const lastLlmByParentReq = new Map<string, string>(); // agentReqSpanId -> prev llmSpanId

  for (const pair of sortedLlmSpans) {
    const actor = pair.first.actor;
    const isRouter = actor === 'router';
    const taskId = pair.latest.taskId ?? (isRouter ? undefined : bundle.task?.id);

    let title: string;
    if (isRouter) {
      routerLlmIdx += 1;
      title = routerLlmCount > 1 ? `主控模型推理 #${routerLlmIdx}` : '主控模型推理';
    } else {
      const counterKey = taskId ?? pair.first.rootId ?? 'worker';
      const idx = (workerLlmCounters.get(counterKey) ?? 0) + 1;
      workerLlmCounters.set(counterKey, idx);
      title = `Worker 模型调用 #${idx}`;
    }

    const startData = record(pair.start?.data);
    const startDetail = record(startData.detail);
    const endData = record(pair.end?.data);
    const endDetail = record(endData.detail);
    const endSummary = record(endData.summary);

    const provider = asNonEmptyString(endDetail.provider ?? startDetail.provider ?? endData.provider ?? startData.provider);
    const model = asNonEmptyString(endDetail.model ?? startDetail.model ?? endData.model ?? startData.model)
      ?? (!isRouter ? bundle.task?.workerModel : undefined);
    const thinkingLevel = asNonEmptyString(endDetail.thinkingLevel ?? startDetail.thinkingLevel)
      ?? (!isRouter ? bundle.task?.thinkingLevel : undefined);

    const stopReason = asNonEmptyString(endDetail.stopReason ?? endData.stopReason);
    const stopReasonLabel = stopReason
      ? (STOP_REASON_LABELS[stopReason] ?? stopReason)
      : (activeStatus(pair.latest.status) ? '正在推理中' : resolveStatusLabel(pair.latest.status));

    const usage = extractUsage(endDetail.usage ?? endData.usage);
    const thinkingText = asNonEmptyString(endDetail.thinkingPreview ?? endDetail.thinking ?? endData.thinkingPreview);
    const rawPublicText = asNonEmptyString(endSummary.publicText)
      ?? asNonEmptyString(endDetail.publicText)
      ?? asNonEmptyString(endData.publicText)
      ?? asNonEmptyString(streamedMap.get(pair.id));
    const publicTextTruncated = Boolean(endSummary.publicTextTruncated ?? endDetail.publicTextTruncated);
    const errorText = asNonEmptyString(endDetail.errorMessage ?? endDetail.error ?? endData.error ?? endData.reason);

    // Collect tool decisions: child spans first, then backfill from endDetail.toolCalls
    const childEntries = childToolsByLlmSpan.get(pair.id) ?? [];
    const toolDecisions: ChainToolDecision[] = childEntries.map(entry => entry.decision);
    const matchedRawIds = childEntries.map(entry => entry.rawSpanId);
    const seenToolIds = new Set(toolDecisions.map(d => d.spanId).filter(Boolean));
    const rawToolCalls = Array.isArray(endDetail.toolCalls) ? endDetail.toolCalls : Array.isArray(endData.toolCalls) ? endData.toolCalls : [];
    for (const tc of rawToolCalls) {
      if (!isPlainObject(tc)) continue;
      const tcId = asString(tc.id);
      const tcName = asString(tc.name) ?? '工具调用';
      const expectedSpanId = tcId ? (spanToNodeId.get(tcId) ?? tcId) : undefined;
      const alreadyMatched = toolDecisions.some((d, idx) => {
        if (!tcId) return d.toolName === tcName;
        const rawId = matchedRawIds[idx] ?? '';
        return d.spanId === tcId
          || d.spanId?.endsWith(`:${tcId}`)
          || d.spanId === expectedSpanId
          || rawId === tcId
          || rawId.endsWith(`:${tcId}`);
      });
      if (alreadyMatched) continue;
      if (expectedSpanId && seenToolIds.has(expectedSpanId)) continue;
      const meta = TOOL_META[tcName] ?? { displayName: tcName, categoryLabel: '扩展工具', icon: '🔧' };
      const parsedPreview = tc.argsPreview !== undefined ? deepUnwrapJson(tc.argsPreview) : undefined;
      let summaryStr = '';
      if (isPlainObject(parsedPreview)) {
        summaryStr = summarizeToolArgs(tcName, parsedPreview as Record<string, unknown>, buildToolParams(tcName, parsedPreview as Record<string, unknown>));
      } else if (typeof parsedPreview === 'string') {
        summaryStr = clipText(parsedPreview, 90);
      }
      toolDecisions.push({
        ...(expectedSpanId ? { spanId: expectedSpanId } : {}),
        toolName: tcName,
        displayName: meta.displayName,
        summary: summaryStr || meta.displayName,
      });
    }

    // Associate input context: round 1 -> trigger/task prompt; round 2+ -> preceding tool outputs
    const parentReqKey = pair.parentSpanId ?? (isRouter ? 'router-default' : `worker:${taskId ?? pair.first.rootId ?? 'default'}`);
    const prevLlmId = lastLlmByParentReq.get(parentReqKey);
    lastLlmByParentReq.set(parentReqKey, pair.id);

    let inputContext: string | undefined;
    if (!prevLlmId) {
      const parentReq = pair.parentSpanId ? agentReqSpans.get(pair.parentSpanId) : undefined;
      const reqStartData = record(parentReq?.start?.data);
      const reqTrigger = record(reqStartData.trigger);
      const reqInput = isPlainObject(deepUnwrapJson(reqStartData.input)) ? deepUnwrapJson(reqStartData.input) as Record<string, unknown> : {};
      if (isRouter) {
        const triggerText = asNonEmptyString(reqTrigger.preview)
          ?? asNonEmptyString(record(reqInput.message).text)
          ?? asNonEmptyString(reqInput.report);
        const msgFallback = pair.first.messageId ? messageById.get(pair.first.messageId)?.text : undefined;
        inputContext = triggerText ?? msgFallback ?? (taskId ? bundle.task?.prompt : undefined);
      } else {
        inputContext = asNonEmptyString(reqInput.prompt)
          ?? asNonEmptyString(reqTrigger.preview)
          ?? bundle.task?.prompt
          ?? (taskId ? taskInfoMap.get(taskId)?.prompt : undefined);
      }
    } else {
      const prevTools = toolNodesByLlmSpan.get(prevLlmId) ?? [];
      if (prevTools.length > 0) {
        const lines = prevTools.map(tn => {
          const td = tn.toolDetail;
          const outSnippet = td?.errorText
            ? `错误：${clipText(td.errorText, 100)}`
            : td?.resultText
              ? clipText(td.resultText, 120)
              : tn.preview;
          const exitPart = td?.exitCode !== undefined ? ` (退出码 ${td.exitCode})` : '';
          return `• ${tn.title} (${td?.toolName ?? tn.subtitle ?? 'tool'})${exitPart}: ${outSnippet}`;
        });
        inputContext = `前置 ${prevTools.length} 个工具返回：\n${lines.join('\n')}`;
      } else {
        inputContext = '承接上一轮推理结果继续推进';
      }
    }

    // Build readable preview — NEVER display "本轮未记录公开说明"
    let preview: string;
    if (rawPublicText) {
      preview = clipText(rawPublicText, 140);
    } else if (toolDecisions.length > 0) {
      const names = toolDecisions
        .map(d => (d.displayName !== d.toolName ? `${d.displayName} (${d.toolName})` : d.toolName))
        .join(' · ');
      preview = `决定调用 ${toolDecisions.length} 个工具：${names}`;
    } else if (errorText) {
      preview = `模型请求异常：${clipText(errorText, 110)}`;
    } else if (activeStatus(pair.latest.status)) {
      preview = '正在进行模型推理…';
    } else if (thinkingText) {
      preview = `思考摘要：${clipText(thinkingText, 120)}`;
    } else {
      preview = stopReasonLabel;
    }

    const subtitleParts: string[] = [];
    if (model) subtitleParts.push(`${model}${thinkingLevel ? `@${thinkingLevel}` : ''}`);
    const usageStr = formatUsageCost(usage);
    if (usageStr) subtitleParts.push(usageStr);

    rawNodes.push({
      id: pair.id,
      seq: pair.first.seq,
      at: pair.first.at,
      ...(pair.end && pair.end.at >= pair.first.at ? { endedAt: pair.end.at } : {}),
      category: 'llm',
      icon: '🧠',
      actor,
      actorLabel: isRouter ? 'F.R.I.D.A.Y. 主控' : 'Worker 模型',
      title,
      ...(subtitleParts.length ? { subtitle: subtitleParts.join(' · ') } : {}),
      preview,
      status: pair.latest.status,
      statusLabel: resolveStatusLabel(pair.latest.status),
      tone: resolveTone(pair.latest.status, { hasError: Boolean(errorText) }),
      ...(taskId ? { taskId, taskLabel: resolveTaskLabel(taskId) } : {}),
      ...(pair.first.messageId ? { messageId: pair.first.messageId } : {}),
      llmDetail: {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(stopReason ? { stopReason } : {}),
        stopReasonLabel,
        ...(inputContext ? { inputContext } : {}),
        ...(thinkingText ? { thinkingText } : {}),
        ...(rawPublicText ? { publicText: rawPublicText } : {}),
        ...(publicTextTruncated ? { publicTextTruncated: true } : {}),
        toolDecisions,
        ...(usage ? { usage } : {}),
        ...(errorText ? { errorText } : {}),
      },
    });
  }

  // Chronological sort & timeline waterfall calculations
  rawNodes.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));

  const minAt = rawNodes.length ? Math.min(...rawNodes.map(n => n.at)) : 0;
  const maxAt = rawNodes.length ? Math.max(...rawNodes.map(n => n.endedAt ?? n.at)) : 0;
  const totalDurationMs = rawNodes.length
    ? Math.max(0, maxAt - minAt)
    : Math.max(0, Math.round(bundle.task?.activeMs ?? 0));

  const nodes: ChainActionNode[] = rawNodes.map(item => {
    const offsetMs = Math.max(0, item.at - minAt);
    const durationMs = item.endedAt !== undefined && item.endedAt >= item.at ? item.endedAt - item.at : undefined;
    let waterfallStartPermille = 0;
    let waterfallWidthPermille = 18;
    if (totalDurationMs > 0) {
      const rawStart = Math.round((offsetMs / totalDurationMs) * 1000);
      waterfallStartPermille = Math.min(982, Math.max(0, rawStart));
      const rawWidth = durationMs !== undefined ? Math.round((durationMs / totalDurationMs) * 1000) : 18;
      waterfallWidthPermille = Math.max(18, Math.min(1000 - waterfallStartPermille, rawWidth));
    }
    return {
      ...item,
      offsetMs,
      ...(durationMs !== undefined ? { durationMs } : {}),
      waterfallStartPermille,
      waterfallWidthPermille,
    };
  });

  let messageCount = 0;
  let llmCount = 0;
  let toolCount = 0;
  let routingCount = 0;
  let failedCount = 0;
  let totalTokens = 0;

  for (const node of nodes) {
    if (node.category === 'message') messageCount += 1;
    else if (node.category === 'llm') llmCount += 1;
    else if (node.category === 'tool') toolCount += 1;
    else if (node.category === 'routing') routingCount += 1;
    if (node.tone === 'err') failedCount += 1;
    if (node.llmDetail?.usage) {
      const u = node.llmDetail.usage;
      totalTokens += u.totalTokens ?? ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0));
    }
  }

  return {
    nodes,
    stats: {
      total: nodes.length,
      message: messageCount,
      llm: llmCount,
      tool: toolCount,
      routing: routingCount,
      failed: failedCount,
      totalTokens,
      totalDurationMs,
    },
  };
}

// ---------------- Fallback Bundle Builder ----------------

function toMessageList(messages?: Map<string, ChatMessage> | Iterable<ChatMessage>): ChatMessage[] {
  if (!messages) return [];
  if (messages instanceof Map) return [...messages.values()];
  return [...messages];
}

function normalizeTaskSummary(raw: unknown, fallbackWork?: WorkView): ExecutionTraceTaskSummary | undefined {
  const obj = record(raw);
  const id = asString(obj.id) ?? fallbackWork?.id;
  if (!id) return undefined;

  const rawOps = Array.isArray(obj.operations) ? obj.operations : [];
  const operations: ExecutionTraceOperationSummary[] = rawOps
    .filter(isPlainObject)
    .map(op => {
      const resultStr = asString(op.result);
      const preview = asString(op.resultPreview) ?? (resultStr ? resultStr.slice(0, 512) : undefined);
      return {
        id: String(op.id ?? ''),
        fileId: String(op.fileId ?? ''),
        status: String(op.status ?? 'unknown'),
        ...(asString(op.parentSpanId) ? { parentSpanId: asString(op.parentSpanId) } : {}),
        ...(asString(op.error) ? { error: asString(op.error) } : {}),
        ...(preview ? { resultPreview: preview } : {}),
        ...(Boolean(op.resultTruncated) || (resultStr && resultStr.length > 512) ? { resultTruncated: true } : {}),
        hasFullResult: typeof op.hasFullResult === 'boolean'
          ? op.hasFullResult
          : Boolean(resultStr) || (op.status === 'succeeded' && !String(op.fileId ?? '').startsWith('native:')),
      };
    });

  const rawFollowups = Array.isArray(obj.followups) ? obj.followups : [];
  const followups = rawFollowups
    .filter(isPlainObject)
    .map(f => ({
      id: String(f.id ?? ''),
      text: String(f.text ?? ''),
      state: String(f.state ?? ''),
    }));

  const rawMemories = Array.isArray(obj.memories) ? obj.memories : [];
  const memories: ExecutionTraceMemoryBrief[] = rawMemories
    .filter(isPlainObject)
    .map(m => ({
      id: String(m.id ?? ''),
      topic: String(m.topic ?? ''),
      tags: Array.isArray(m.tags) ? m.tags.map(String) : [],
      preview: String(m.preview ?? m.content ?? ''),
    }));

  const pendingRaw = isPlainObject(obj.pendingQuestion)
    ? obj.pendingQuestion
    : fallbackWork?.pendingQuestion;
  const pendingQuestion = pendingRaw && typeof pendingRaw.question === 'string'
    ? {
        question: pendingRaw.question,
        ...(Array.isArray(pendingRaw.options) ? { options: pendingRaw.options.map(String) } : {}),
        askedAt: asNumber(pendingRaw.askedAt) ?? Date.now(),
      }
    : undefined;

  const qualityGate = isPlainObject(obj.qualityGate)
    ? obj.qualityGate
    : (fallbackWork?.qualityGate as Record<string, unknown> | undefined);

  return {
    id,
    ...(asString(obj.parentTaskId) ?? fallbackWork?.parentTaskId ? { parentTaskId: asString(obj.parentTaskId) ?? fallbackWork?.parentTaskId } : {}),
    ...(asString(obj.originMessageId) ?? fallbackWork?.originMessageId ? { originMessageId: asString(obj.originMessageId) ?? fallbackWork?.originMessageId } : {}),
    prompt: asString(obj.prompt) ?? fallbackWork?.prompt ?? '',
    status: asString(obj.status) ?? fallbackWork?.status ?? 'unknown',
    createdAt: asNumber(obj.createdAt) ?? fallbackWork?.createdAt ?? 0,
    activeMs: asNumber(obj.activeMs) ?? fallbackWork?.activeMs ?? 0,
    limitMs: asNumber(obj.limitMs) ?? fallbackWork?.limitMs ?? 0,
    ...(asString(obj.cwd) ?? fallbackWork?.cwd ? { cwd: asString(obj.cwd) ?? fallbackWork?.cwd } : {}),
    ...(asString(obj.profile) ?? fallbackWork?.profile ? { profile: asString(obj.profile) ?? fallbackWork?.profile } : {}),
    ...(asString(obj.workerModel) ?? fallbackWork?.workerModel ? { workerModel: asString(obj.workerModel) ?? fallbackWork?.workerModel } : {}),
    ...(asString(obj.modelTier) ?? fallbackWork?.modelTier ? { modelTier: asString(obj.modelTier) ?? fallbackWork?.modelTier } : {}),
    ...(asString(obj.thinkingLevel) ?? fallbackWork?.thinkingLevel ? { thinkingLevel: asString(obj.thinkingLevel) ?? fallbackWork?.thinkingLevel } : {}),
    ...(asString(obj.decisionSource) ?? fallbackWork?.decisionSource ? { decisionSource: asString(obj.decisionSource) ?? fallbackWork?.decisionSource } : {}),
    ...(asNumber(obj.decisionConfidence) !== undefined ? { decisionConfidence: asNumber(obj.decisionConfidence) } : {}),
    ...(asBoolean(obj.skipQualityGate) !== undefined || fallbackWork?.skipQualityGate !== undefined
      ? { skipQualityGate: asBoolean(obj.skipQualityGate) ?? fallbackWork?.skipQualityGate }
      : {}),
    ...(qualityGate ? { qualityGate } : {}),
    ...(asString(obj.contextBrief) ? { contextBrief: asString(obj.contextBrief) } : {}),
    ...(asString(obj.reason) ?? fallbackWork?.reason ? { reason: asString(obj.reason) ?? fallbackWork?.reason } : {}),
    ...(asString(obj.report) ? { report: asString(obj.report) } : {}),
    ...(pendingQuestion ? { pendingQuestion } : {}),
    followups,
    memories,
    operations,
  };
}

/**
 * Constructs a client-side fallback `ExecutionTraceBundle` from `appState` or a bare
 * `TraceEvent[]` list when `/api/execution-trace` is unavailable or in unit-test stubs.
 */
export function buildFallbackBundleFromAppState(
  input: readonly TraceEvent[] | FallbackBundleInput,
  options?: Omit<FallbackBundleInput, 'traceEvents' | 'events'>,
): ExecutionTraceBundle {
  const isEventArray = Array.isArray(input);
  const opts: FallbackBundleInput = isEventArray ? (options ?? {}) : (input as FallbackBundleInput);
  const rawEvents: readonly TraceEvent[] = isEventArray
    ? input
    : (opts.traceEvents ?? opts.events ?? []);

  const streamedTextBySpan: Record<string, string> = {};
  const filteredEvents: TraceEvent[] = [];
  const sortedRaw = rawEvents.toSorted((a, b) => a.seq - b.seq || a.at - b.at);
  for (const ev of sortedRaw) {
    if (ev.kind === 'visible_text') {
      if (ev.spanId) {
        const piece = asString(record(ev.data).text) ?? '';
        streamedTextBySpan[ev.spanId] = `${streamedTextBySpan[ev.spanId] ?? ''}${piece}`;
      }
      continue;
    }
    if (ev.kind === 'message_updated') continue;
    filteredEvents.push(ev);
  }

  const selection = opts.selection ?? { type: 'all' as const };
  const works = opts.works ?? opts.view?.works ?? [];
  const allMessages = toMessageList(opts.messages);
  const eventMsgIds = new Set(
    filteredEvents.flatMap(ev => [ev.messageId, ev.rootId].filter((id): id is string => Boolean(id))),
  );

  let task: ExecutionTraceTaskSummary | undefined;
  if (selection.type === 'task') {
    const matchedWork = works.find(w => w.id === selection.id);
    task = normalizeTaskSummary(opts.workData, matchedWork);
    if (task?.originMessageId) eventMsgIds.add(task.originMessageId);
  }

  const scopedMessages = allMessages
    .filter(msg => {
      if (selection.type === 'all') return eventMsgIds.has(msg.id);
      if (selection.type === 'message') {
        return msg.id === selection.id || msg.replyTo === selection.id || eventMsgIds.has(msg.id);
      }
      const taskId = selection.id;
      return (
        msg.id === task?.originMessageId
        || msg.taskIds.includes(taskId)
        || eventMsgIds.has(msg.id)
        || (msg.replyTo !== undefined && eventMsgIds.has(msg.replyTo))
      );
    })
    .toSorted((a, b) => a.seq - b.seq || a.at - b.at);

  const linkedTasks: ExecutionTraceLinkedTask[] = works
    .filter(w => {
      if (selection.type === 'task') return w.id === selection.id || w.parentTaskId === selection.id;
      if (selection.type === 'message') return w.originMessageId === selection.id || scopedMessages.some(m => m.taskIds.includes(w.id));
      return true;
    })
    .slice(0, 40)
    .map(w => ({
      id: w.id,
      prompt: w.prompt,
      status: w.status,
      ...(w.profile ? { profile: w.profile } : {}),
      ...(w.workerModel ? { workerModel: w.workerModel } : {}),
      ...(w.modelTier ? { modelTier: w.modelTier } : {}),
      ...(w.thinkingLevel ? { thinkingLevel: w.thinkingLevel } : {}),
      activeMs: w.activeMs,
      createdAt: w.createdAt,
    }));

  const cursor = opts.cursor ?? opts.traceAfter ?? (sortedRaw.at(-1)?.seq ?? 0);

  return {
    scope: selection.type === 'all' ? { type: 'all' } : { type: selection.type, id: selection.id },
    cursor,
    events: filteredEvents,
    streamedTextBySpan,
    messages: scopedMessages,
    ...(task ? { task } : {}),
    linkedTasks,
  };
}

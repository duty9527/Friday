import type { ChatMessage, RouteAction } from '../../view.js';
import { activeStatus, routeLabel } from '../model.js';
import type { BotStateId } from './bot-avatar.js';

export type ChatChannelId = 'local' | 'wechat' | 'telegram' | 'xiaoai' | 'dingtalk';
export type ChatChannelFilter = 'all' | ChatChannelId;

export interface ChannelMeta {
  id: ChatChannelFilter;
  label: string;
  shortLabel: string;
  icon: string;
}

const CHANNEL_ORDER: readonly ChatChannelId[] = ['local', 'wechat', 'telegram', 'xiaoai', 'dingtalk'];

const CHANNEL_META_MAP: Record<ChatChannelFilter, ChannelMeta> = {
  all: { id: 'all', label: '全部渠道', shortLabel: '全部', icon: '✦' },
  local: { id: 'local', label: '本机控制台', shortLabel: '本机', icon: '💻' },
  wechat: { id: 'wechat', label: '微信', shortLabel: '微信', icon: '💬' },
  telegram: { id: 'telegram', label: 'Telegram', shortLabel: 'TG', icon: '✈️' },
  xiaoai: { id: 'xiaoai', label: '小爱音箱', shortLabel: '小爱', icon: '🔊' },
  dingtalk: { id: 'dingtalk', label: '钉钉', shortLabel: '钉钉', icon: '🟦' },
};

const TASK_ACTION_KINDS = new Set<RouteAction['kind']>([
  'new_work',
  'followup',
  'related_work',
  'resume',
  'stop',
  'inspect',
]);

function isChannelId(value: unknown): value is ChatChannelId {
  return value === 'local' || value === 'wechat' || value === 'telegram' || value === 'xiaoai' || value === 'dingtalk';
}

export function channelMeta(channel: ChatChannelFilter): ChannelMeta {
  return CHANNEL_META_MAP[channel] ?? CHANNEL_META_MAP.local;
}

/**
 * Resolves the source channel of a message, inheriting from its reply parent when omitted.
 */
export function resolveMessageChannel(
  message: ChatMessage,
  lookup?: ReadonlyMap<string, ChatMessage>,
): ChatChannelId {
  if (isChannelId(message.origin?.channel)) {
    return message.origin.channel;
  }
  let parentId = message.replyTo;
  let hops = 0;
  while (parentId && lookup && hops < 4) {
    const parent = lookup.get(parentId);
    if (!parent) break;
    if (isChannelId(parent.origin?.channel)) {
      return parent.origin.channel;
    }
    parentId = parent.replyTo;
    hops++;
  }
  return 'local';
}

/**
 * Lists available channel filter options based on active messages and configured IM platforms.
 */
export function collectAvailableChannels(
  messages: readonly ChatMessage[],
  lookup: ReadonlyMap<string, ChatMessage>,
  configuredPlatforms?: readonly string[],
): ChatChannelFilter[] {
  const seen = new Set<ChatChannelId>(['local']);
  for (const platform of configuredPlatforms ?? []) {
    if (isChannelId(platform)) seen.add(platform);
  }
  for (const msg of messages) {
    seen.add(resolveMessageChannel(msg, lookup));
  }
  return ['all', ...CHANNEL_ORDER.filter(ch => seen.has(ch))];
}

/**
 * Filters messages in durable order by channel and system-notice visibility.
 */
export function filterConversationMessages(
  ordered: readonly ChatMessage[],
  lookup: ReadonlyMap<string, ChatMessage>,
  opts: { channel: ChatChannelFilter; hideSystem: boolean },
): { visible: ChatMessage[]; hiddenSystemCount: number; hiddenChannelCount: number } {
  const visible: ChatMessage[] = [];
  let hiddenSystemCount = 0;
  let hiddenChannelCount = 0;
  for (const msg of ordered) {
    if (opts.hideSystem && msg.source === 'system') {
      hiddenSystemCount++;
      continue;
    }
    if (opts.channel !== 'all' && resolveMessageChannel(msg, lookup) !== opts.channel) {
      hiddenChannelCount++;
      continue;
    }
    visible.push(msg);
  }
  return { visible, hiddenSystemCount, hiddenChannelCount };
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

const zhTimeFormatter = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  : null;

const zhMonthDayFormatter = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' })
  : null;

const zhYearDateFormatter = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'long' })
  : null;

function formatClockPair(d: Date): string {
  return zhTimeFormatter ? zhTimeFormatter.format(d) : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Returns true when a time separator should precede `curr`.
 */
export function shouldShowTimeDivider(prev: ChatMessage | undefined, curr: ChatMessage): boolean {
  if (!prev) return true;
  if (!Number.isFinite(prev.at) || !Number.isFinite(curr.at)) return false;
  if (!sameLocalDay(new Date(prev.at), new Date(curr.at))) return true;
  return curr.at - prev.at >= 15 * 60_000;
}

/**
 * Formats a concise human-readable time divider label (e.g., `今天 10:52`, `昨天 21:05`, `11月15日 09:30`).
 */
export function formatTimeDivider(at: number, now = Date.now()): string {
  if (!Number.isFinite(at)) return '—';
  const target = new Date(at);
  if (Number.isNaN(target.getTime())) return '—';
  const ref = new Date(now);
  const hhmm = formatClockPair(target);
  if (sameLocalDay(target, ref)) return `今天 ${hhmm}`;
  const yesterday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 1);
  if (sameLocalDay(target, yesterday)) return `昨天 ${hhmm}`;
  if (target.getFullYear() === ref.getFullYear()) {
    const md = zhMonthDayFormatter ? zhMonthDayFormatter.format(target) : `${target.getMonth() + 1}月${target.getDate()}日`;
    return `${md} ${hhmm}`;
  }
  const ymd = zhYearDateFormatter
    ? zhYearDateFormatter.format(target)
    : `${target.getFullYear()}年${target.getMonth() + 1}月${target.getDate()}日`;
  return `${ymd} ${hhmm}`;
}

/**
 * Formats a compact `HH:mm` clock timestamp for message metadata.
 */
export function formatShortClock(at: number): string {
  if (!Number.isFinite(at)) return '—';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '—';
  return formatClockPair(d);
}

/**
 * Determines whether `curr` should visually stack closely with `prev` (same speaker/channel within 3 minutes).
 */
export function isGroupedWithPrevious(prev: ChatMessage | undefined, curr: ChatMessage): boolean {
  if (!prev) return false;
  if (prev.source === 'system' || curr.source === 'system') return false;
  if (prev.role !== curr.role) return false;
  if (shouldShowTimeDivider(prev, curr)) return false;
  if (!Number.isFinite(prev.at) || !Number.isFinite(curr.at) || curr.at - prev.at >= 3 * 60_000) return false;
  if ((prev.origin?.channel ?? 'local') !== (curr.origin?.channel ?? 'local')) return false;
  if ((prev.origin?.speakerName ?? '') !== (curr.origin?.speakerName ?? '')) return false;
  return true;
}

/**
 * Shows the inline reply reference only when `detailMode` is on or the reply is separated from its parent message.
 */
export function shouldShowReplyReference(
  message: ChatMessage,
  prevVisible: ChatMessage | undefined,
  detailMode: boolean,
): boolean {
  if (!message.replyTo) return false;
  if (detailMode) return true;
  return prevVisible?.id !== message.replyTo;
}

export interface RoutingDisplayModel {
  visible: boolean;
  mode: 'none' | 'compact' | 'detail';
  pendingText?: string;
  taskActions: RouteAction[];
  metaActions: RouteAction[];
  hasExpandableDetails: boolean;
  warningText?: string;
}

function actionHasDetails(action: RouteAction): boolean {
  return Boolean(
    action.parentTaskId
    || action.messageIds?.length
    || action.searchQuery
    || action.memoryIds?.length
    || action.workerProfile
    || action.workerModel
    || action.thinkingLevel
    || action.modelTier
    || action.decisionSource
    || action.summary
    || action.error,
  );
}

/**
 * Classifies routing actions for either clean compact pills (suppressing routine direct replies)
 * or full audit detail inspection.
 */
export function classifyRoutingDisplay(message: ChatMessage, detailMode: boolean): RoutingDisplayModel {
  const isActive = activeStatus(message.status);

  if (detailMode) {
    if (!message.routing) {
      return {
        visible: true,
        mode: 'detail',
        pendingText: isActive ? '等待 F.R.I.D.A.Y. 处理并记录分配结果…' : '此历史消息未采集路由摘要；不从回复正文猜测。',
        taskActions: [],
        metaActions: [],
        hasExpandableDetails: false,
      };
    }
    const taskActions: RouteAction[] = [];
    const metaActions: RouteAction[] = [];
    for (const action of message.routing.actions) {
      if (TASK_ACTION_KINDS.has(action.kind)) taskActions.push(action);
      else metaActions.push(action);
    }
    const warnings: string[] = [];
    if (message.routing.omittedActions) warnings.push('动作较多，摘要只展示最近 40 条。');
    if (message.routing.status === 'failed' || message.routing.status === 'interrupted') {
      warnings.push('F.R.I.D.A.Y. 处理未完成；已受理的动作保留，不代表已撤销。');
    }
    return {
      visible: true,
      mode: 'detail',
      ...(message.routing.actions.length === 0
        ? {
            pendingText: message.routing.status === 'processing'
              ? 'F.R.I.D.A.Y. 正在处理，尚无已受理动作。'
              : '本次路由未确认完成，没有可确认的分配动作。',
          }
        : {}),
      taskActions,
      metaActions,
      hasExpandableDetails: message.routing.actions.some(actionHasDetails),
      ...(warnings.length ? { warningText: warnings.join(' ') } : {}),
    };
  }

  // Clean compact mode
  if (!message.routing) {
    if (!isActive) {
      return { visible: false, mode: 'none', taskActions: [], metaActions: [], hasExpandableDetails: false };
    }
    return {
      visible: true,
      mode: 'compact',
      pendingText: '正在调度…',
      taskActions: [],
      metaActions: [],
      hasExpandableDetails: false,
    };
  }

  const routing = message.routing;
  const allPureReply = routing.status === 'completed'
    && !routing.omittedActions
    && routing.actions.length > 0
    && routing.actions.every(a => a.kind === 'reply' && a.status === 'accepted' && !a.error);
  if (allPureReply) {
    return { visible: false, mode: 'none', taskActions: [], metaActions: [], hasExpandableDetails: false };
  }

  const taskActions: RouteAction[] = [];
  const metaActions: RouteAction[] = [];
  for (const action of routing.actions) {
    if (TASK_ACTION_KINDS.has(action.kind)) {
      taskActions.push(action);
    } else if (action.kind === 'reply') {
      if (action.status !== 'accepted' || action.error) {
        metaActions.push(action);
      }
    } else {
      metaActions.push(action);
    }
  }

  const warnings: string[] = [];
  if (routing.omittedActions) warnings.push('动作较多（已展示近期动作）');
  if (routing.status === 'failed' || routing.status === 'interrupted') {
    warnings.push('调度未确认完成');
  }

  let pendingText: string | undefined;
  if (!routing.actions.length && (routing.status === 'processing' || isActive)) {
    pendingText = '正在分析调度…';
  }

  const visible = taskActions.length > 0 || metaActions.length > 0 || Boolean(pendingText) || warnings.length > 0;
  return {
    visible,
    mode: visible ? 'compact' : 'none',
    ...(pendingText ? { pendingText } : {}),
    taskActions,
    metaActions,
    hasExpandableDetails: [...taskActions, ...metaActions].some(actionHasDetails),
    ...(warnings.length ? { warningText: warnings.join(' · ') } : {}),
  };
}

/**
 * Generates a concise single-line summary for `source === 'system'` notices.
 */
export function summarizeSystemNotice(message: ChatMessage): {
  icon: string;
  title: string;
  expandable: boolean;
  badge: string;
} {
  const raw = (message.text || '').trim();
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const strippedFirst = (lines[0] ?? '').replace(/^\[?系统(?:通知|消息)?\]?\s*[·:：-]?\s*/i, '').trim();
  const firstLine = strippedFirst || lines[1] || '系统状态更新';

  let icon = '🔔';
  let badge = '系统通知';
  if (/失败|异常|错误|中断|超时|不可用/.test(raw) || message.status === 'failed' || message.status === 'interrupted') {
    icon = '⚠️';
    badge = '状态告警';
  } else if (/拍板|请示|待确认|waiting_decision/i.test(raw)) {
    icon = '⏳';
    badge = '待拍板';
  } else if (/定时|巡检|闹钟|timer/i.test(raw)) {
    icon = '⏱️';
    badge = '定时任务';
  } else if (/持仓|基金|估值|结算/.test(raw)) {
    icon = '📈';
    badge = '投资播报';
  } else if (/体重|体脂|上秤|称重/.test(raw)) {
    icon = '❤️';
    badge = '健康记录';
  }

  const maxTitleLen = 64;
  const truncatedTitle = firstLine.length > maxTitleLen ? `${firstLine.slice(0, maxTitleLen)}…` : firstLine;
  const expandable = lines.length > 1
    || firstLine.length > maxTitleLen
    || message.paths.length > 0
    || Boolean(message.attachments?.length)
    || Boolean(message.reason);

  return { icon, title: truncatedTitle, expandable, badge };
}

/**
 * Derives the live companion status pill text and semantic tone.
 */
export function deriveCompanionStatus(
  botState: BotStateId,
  activeWorksCount: number,
  waitingDecisionCount: number,
): { text: string; tone: 'ok' | 'run' | 'warn' | 'err' | 'neutral' } {
  if (waitingDecisionCount > 0) {
    return { text: `${waitingDecisionCount} 项待拍板`, tone: 'warn' };
  }
  switch (botState) {
    case 'sleeping':
      return { text: '离线 / 等待重连', tone: 'neutral' };
    case 'failed':
      return { text: '执行遇到异常', tone: 'err' };
    case 'finished':
      return { text: '任务已完成', tone: 'ok' };
    case 'streaming':
      return { text: '正在回复…', tone: 'run' };
    case 'searching':
      return { text: '检索记忆中…', tone: 'run' };
    case 'thinking':
      return { text: '正在思考…', tone: 'run' };
    case 'waiting':
      return { text: '连接待恢复', tone: 'warn' };
    case 'working':
      return {
        text: activeWorksCount > 0 ? `${activeWorksCount} 项后台执行中` : '后台执行中',
        tone: 'run',
      };
    case 'listening':
      return { text: '正在输入…', tone: 'ok' };
    case 'idle':
    default:
      return activeWorksCount > 0
        ? { text: `在线 · ${activeWorksCount} 项后台执行`, tone: 'run' }
        : { text: '就绪', tone: 'ok' };
  }
}

/**
 * Formats file byte size into a compact human-readable label.
 */
export function formatByteSize(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatActionShortLabel(action: RouteAction): string {
  if (action.taskLabel) return `${routeLabel(action)} · ${action.taskLabel}`;
  if (action.kind === 'search_memory' && action.searchQuery) return `检索记忆 · ${action.searchQuery}`;
  if (action.kind === 'save_memory' && action.memoryIds?.length) return `沉淀记忆 ×${action.memoryIds.length}`;
  return routeLabel(action);
}

export interface ParsedLeadingQuote {
  label: string;
  preview: string;
  fullText: string;
  body: string;
  uncached?: boolean;
}

const LEADING_QUOTE_WITH_BODY_RE = /^【引用(?:\s*([^】]+))?】\n([\s\S]*?)\n\n([\s\S]*)$/;
const LEADING_QUOTE_ONLY_RE = /^【引用(?:\s*([^】]+))?】\n([\s\S]+)$/;
const UNCACHED_QUOTE_RE = /^\[引用的历史消息未缓存(?:\s*\(ID:\s*[^)]+\))?\]$/;

function collapseSingleLine(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function mapQuoteLabel(rawTag?: string): string {
  const tag = (rawTag ?? '').trim();
  if (!tag) return '回复';
  if (tag === 'F.R.I.D.A.Y. 的消息') return '回复 F.R.I.D.A.Y.';
  if (tag === '你之前的消息') return '回复你';
  return `回复 ${tag}`;
}

/**
 * Extracts a leading WeChat quote block (`【引用...】...\n\n...`) into a compact
 * single-line reply preview plus the user's actual message body.
 */
export function extractLeadingQuote(rawText: string): ParsedLeadingQuote | undefined {
  if (!rawText.startsWith('【引用')) return undefined;
  const withBody = LEADING_QUOTE_WITH_BODY_RE.exec(rawText);
  const match = withBody ?? LEADING_QUOTE_ONLY_RE.exec(rawText);
  if (!match) return undefined;

  const rawTag = match[1];
  const rawQuoteBlock = (match[2] ?? '').trim();
  const body = withBody ? (match[3] ?? '').trim() : '';
  if (!rawQuoteBlock && !withBody) return undefined;

  const blockLines = rawQuoteBlock.split('\n').map(l => l.trim()).filter(Boolean);
  const partialLine = blockLines.find(l => l.startsWith('划词引用：'));
  const uncached = blockLines.some(l => UNCACHED_QUOTE_RE.test(l));

  let previewSource: string;
  if (uncached) {
    previewSource = '历史消息未缓存';
  } else if (partialLine) {
    previewSource = partialLine.slice('划词引用：'.length);
  } else {
    previewSource = blockLines.join(' ');
  }

  return {
    label: mapQuoteLabel(rawTag),
    preview: collapseSingleLine(previewSource) || '引用消息',
    fullText: rawQuoteBlock,
    body,
    ...(uncached ? { uncached: true } : {}),
  };
}

/**
 * Strips a leading `【引用...】` block for compact reply-source previews.
 */
export function stripLeadingQuoteForPreview(rawText: string): string {
  const parsed = extractLeadingQuote(rawText);
  if (!parsed) return rawText;
  return parsed.body || parsed.preview;
}

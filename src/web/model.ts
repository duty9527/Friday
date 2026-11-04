import type { ChatMessage, TraceEvent, RouteAction } from '../view.js';

export const activeStatus = (value: string) => ['queued', 'processing', 'streaming', 'running', 'started', 'requested'].includes(value);
export const settledStatus = (value: string) => ['completed', 'failed', 'interrupted', 'succeeded', 'paused', 'cancelled', 'stopped'].includes(value);
const phaseStatus = (value: string) => ['started', 'running', 'requested', 'streaming'].includes(value);

/** Newer journal version wins, so out-of-order refreshes can never regress a message. */
export function mergeMessages<T extends Pick<ChatMessage, 'id' | 'version'>>(map: Map<string, T>, items: T[]): void {
  for (const message of items) {
    const previous = map.get(message.id);
    if (!previous || message.version >= previous.version) map.set(message.id, message);
  }
}

/** New messages stay where they arrived; causal links are references, not sorting instructions. */
export function orderConversation<T extends Pick<ChatMessage, 'seq'>>(items: Iterable<T>): T[] {
  return [...items].sort((a, b) => a.seq - b.seq);
}

export function routeLabel(action: Pick<RouteAction, 'kind'>): string {
  return { new_work: '新建工作', followup: '补充已有工作（未新建）', related_work: '关联新执行（新建工作）',
    inspect: '查询工作', stop: '请求停止工作', recall: '回看历史', reply: '仅回复（未派发后台工作）' }[action.kind];
}
export function routeState(action: Pick<RouteAction, 'status' | 'kind' | 'delivery'>): string {
  if (action.status !== 'accepted') return { pending: '正在处理，尚未受理', failed: '动作失败', interrupted: '进度未确认' }[action.status];
  if (action.kind === 'followup') return { pending: '已受理，等待 Worker 处理', processing: 'Worker 正在处理补充',
    done: 'Worker 已处理补充，结果另行交付', failed: '补充要求未确认处理' }[action.delivery ?? 'pending'] ?? '已受理，处理状态未记录';
  return action.kind === 'reply' ? 'Router 已回复' : action.kind === 'inspect' || action.kind === 'recall' ? '查询已完成' : '已受理';
}

export interface SpanNode { id: string; parent?: string; events: TraceEvent[] }
/** Spans grouped by id; text deltas, bookkeeping link events and thinking never become nodes. */
export function spanNodes(events: TraceEvent[]): SpanNode[] {
  const spans = new Map<string, SpanNode>();
  for (const event of events) {
    if (!event.spanId || event.kind === 'visible_text' || event.kind === 'thinking' || event.kind === 'work_linked') continue;
    const current = spans.get(event.spanId) ?? { id: event.spanId, events: [] };
    if (event.parentSpanId && event.parentSpanId !== event.spanId) current.parent = event.parentSpanId;
    current.events.push(event);
    spans.set(current.id, current);
  }
  return [...spans.values()];
}
export interface SpanTree { roots: SpanNode[]; children: Map<string, SpanNode[]>; detached: SpanNode[] }
/**
 * Builds the causal tree. `detached` holds nodes whose recorded parent is unknown (for example a
 * truncated history), so they can be shown apart instead of pretending to be causal roots.
 */
export function spanTree(spans: SpanNode[]): SpanTree {
  const byId = new Map(spans.map(span => [span.id, span]));
  const children = new Map<string, SpanNode[]>();
  const roots: SpanNode[] = [];
  const detached: SpanNode[] = [];
  for (const span of spans) {
    if (!span.parent) { roots.push(span); continue; }
    if (!byId.has(span.parent)) { detached.push(span); continue; }
    const list = children.get(span.parent) ?? [];
    list.push(span);
    children.set(span.parent, list);
  }
  return { roots, children, detached };
}
/** Measured duration only when a start and a settle were both recorded. */
export function spanDuration(events: TraceEvent[]): string | undefined {
  const start = events.find(event => phaseStatus(event.status));
  const end = events.findLast(event => settledStatus(event.status));
  return start && end && end.at >= start.at ? `${((end.at - start.at) / 1000).toFixed(2)} 秒` : undefined;
}
/** Usage is shown only when the journal actually recorded it. */
export function usageSummary(data: unknown): string {
  if (!data || typeof data !== 'object') return '— / —';
  const record = data as Record<string, unknown>;
  const usage = record.usage && typeof record.usage === 'object' ? record.usage as Record<string, unknown> : record;
  const input = typeof usage.input === 'number' ? usage.input : undefined;
  const output = typeof usage.output === 'number' ? usage.output : undefined;
  if (typeof record.tokensBefore === 'number') {
    const after = typeof record.estimatedTokensAfter === 'number' ? record.estimatedTokensAfter : undefined;
    return `${record.tokensBefore.toLocaleString('en-US')} → ${after === undefined ? '—' : after.toLocaleString('en-US')} tokens`;
  }
  if (input === undefined && output === undefined) return '— / —';
  return `${input === undefined ? '—' : input.toLocaleString('en-US')} / ${output === undefined ? '—' : output.toLocaleString('en-US')} tokens`;
}

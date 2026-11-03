import type { ChatMessage, TraceEvent } from '../view.js';

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

/**
 * Causal order, not insertion order: each reply stays with the message that asked for it, so a burst
 * of submissions cannot separate a reply from its user message.
 */
export function orderConversation<T extends Pick<ChatMessage, 'id' | 'seq' | 'role' | 'replyTo'>>(items: Iterable<T>): T[] {
  const all = [...items].sort((a, b) => a.seq - b.seq);
  const users = all.filter(message => message.role === 'user');
  const children = new Map<string, T[]>();
  const orphans: T[] = [];
  for (const message of all) {
    if (message.role === 'user') continue;
    const parent = message.replyTo;
    if (parent && users.some(user => user.id === parent)) {
      const list = children.get(parent) ?? [];
      list.push(message);
      children.set(parent, list);
    } else orphans.push(message);
  }
  return [...users.flatMap(user => [user, ...(children.get(user.id) ?? [])]), ...orphans];
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

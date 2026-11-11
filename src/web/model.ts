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
    inspect: '查询工作', stop: '请求停止工作', resume: '恢复暂停工作', recall: '回看历史',
    search_memory: '检索全局记忆', save_memory: '沉淀长期记忆', timer: '管理定时任务', plugin: '执行功能插件', send_file: '发送微信附件', switch_channel: '切换回复通道', reply: '仅回复（未派发后台工作）' }[action.kind];
}
export function routeState(action: Pick<RouteAction, 'status' | 'kind' | 'delivery'>): string {
  if (action.status !== 'accepted') return { pending: '正在处理，尚未受理', failed: '动作失败', interrupted: '进度未确认' }[action.status];
  if (action.kind === 'followup') return { pending: '已受理，等待 Worker 处理', processing: 'Worker 正在处理补充',
    done: 'Worker 已处理补充，结果另行交付', failed: '补充要求未确认处理' }[action.delivery ?? 'pending'] ?? '已受理，处理状态未记录';
  return action.kind === 'reply' ? 'F.R.I.D.A.Y. 已回复'
    : action.kind === 'inspect' || action.kind === 'recall' || action.kind === 'search_memory' ? '查询已完成'
    : action.kind === 'save_memory' ? '记忆已更新'
    : '已受理';
}

export interface TimelineStep {
  id: string; seq: number; at: number; actor: string; kind: string; label: string;
  title: string; status: string; taskId?: string; taskLabel?: string;
  summary?: string; summarySource?: 'turn' | 'action' | 'stream'; summaryTruncated?: boolean;
  input?: Record<string, string>; inputTruncated?: boolean; trigger?: string;
  output?: string; outputTruncated?: boolean; exitCode?: number; error?: string;
  route?: RouteAction; followupState?: string; parent?: string; parentTool?: string;
}
const WORKER_TOOLS: Record<string, string> = {
  read: '读取文件', ls: '列出目录', find: '查找文件', grep: '搜索内容', bash: '执行命令',
  edit: '修改文件', write: '写入文件', start_read: '读取文件副本',
};
const ROUTER_TOOLS = new Set(['start_work', 'continue_work', 'inspect_work', 'stop_work', 'resume_work', 'recall_messages', 'search_memory', 'save_memory', 'manage_timer', 'run_plugin', 'send_file', 'switch_channel', 'dispatch_worker']);
const NOT_A_STEP = new Set(['visible_text', 'thinking', 'work_linked']);
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const TRIGGER_TITLES: Record<string, [string, string]> = {
  CHAT: ['F.R.I.D.A.Y. 处理新输入', 'Worker 接收任务'], WORKER_REPORT: ['F.R.I.D.A.Y. 汇总 Worker 结果', 'Worker 汇报结果'],
  WORKER_QUESTION: ['F.R.I.D.A.Y. 转达关键请示', 'Worker 请求老板拍板'], BOSS_DECISION: ['F.R.I.D.A.Y. 传达老板拍板', 'Worker 接收拍板继续执行'],
  NEW_TASK: ['F.R.I.D.A.Y. 派发任务', 'Worker 接收任务'], FOLLOWUP: ['F.R.I.D.A.Y. 汇总后台变化', 'Worker 处理补充要求'],
  READ_COMPLETIONS: ['F.R.I.D.A.Y. 汇总后台变化', 'Worker 处理读取结果'], TASK: ['F.R.I.D.A.Y. 派发任务', 'Worker 接收任务'],
};
function triggerKind(data: unknown): string | undefined {
  const trigger = record(record(data).trigger).kind;
  return typeof trigger === 'string' ? trigger : undefined;
}
function stepTitle(event: TraceEvent, trigger?: string): string {
  if (event.kind === 'route_action') {
    const action = record(event.data) as unknown as RouteAction;
    return action.kind ? routeLabel(action) : 'F.R.I.D.A.Y. 调度动作';
  }
  if (event.kind === 'followup_state') return '处理补充要求';
  if (event.label === 'Agent 请求') {
    const titles = trigger ? TRIGGER_TITLES[trigger] : undefined;
    if (titles) return event.actor === 'router' ? titles[0] : titles[1];
    return event.actor === 'router' ? 'F.R.I.D.A.Y. 处理输入' : 'Worker 执行任务';
  }
  if (event.kind === 'task_state') return '后台工作状态变化';
  if (event.label === '模型推理调用') return event.actor === 'router' ? 'F.R.I.D.A.Y. 判断' : 'Worker 推理';
  if (event.kind === 'operation') return event.label;
  if (ROUTER_TOOLS.has(event.label)) return event.actor === 'router' ? 'F.R.I.D.A.Y. 调度后台工作' : event.label;
  return WORKER_TOOLS[event.label] ?? event.label;
}
function stepError(event: TraceEvent): string | undefined {
  const detail = record(record(event.data).detail);
  const reason = detail.error ?? record(event.data).error ?? detail.reason;
  return reason === undefined ? undefined : String(reason).slice(0, 400);
}
/**
 * A readable, step-by-step record: one step per recorded call, not per journal row. Starts and
 * settlements merge into their call, text deltas fold into the model round that produced them, and
 * operation rows attach to the tool call that owns them. Order is the durable event sequence.
 */
export function timelineSteps(events: TraceEvent[]): TimelineStep[] {
  const groups = new Map<string, { id: string; parent?: string; events: TraceEvent[] }>();
  const streamed = new Map<string, string>();
  const settled = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (event.kind === 'visible_text') {
      if (event.spanId) streamed.set(event.spanId, `${streamed.get(event.spanId) ?? ''}${String(record(event.data).text ?? '')}`);
      continue;
    }
    // Messages are the conversation itself; the process panel records what was executed, not the transcript.
    if (NOT_A_STEP.has(event.kind) || event.type === 'message' || !event.spanId) continue;
    // An operation row is the settlement of the tool call that owns it, not a second action.
    if (event.kind === 'operation' && event.parentSpanId && event.parentSpanId !== event.spanId) {
      const list = settled.get(event.parentSpanId) ?? [];
      list.push(event); settled.set(event.parentSpanId, list); continue;
    }
    const group = groups.get(event.spanId) ?? { id: event.spanId, events: [] };
    if (event.parentSpanId && event.parentSpanId !== event.spanId) group.parent = event.parentSpanId;
    group.events.push(event);
    groups.set(group.id, group);
  }
  const operations = new Map<string, TraceEvent[]>();
  for (const [parent, rows] of settled) {
    if (groups.has(parent)) { operations.set(parent, rows); continue; }
    // The owning call is outside the read window: keep the settlement visible instead of hiding it.
    for (const row of rows) {
      const own = groups.get(row.spanId ?? parent) ?? { id: row.spanId ?? parent, events: [] };
      own.events.push(row); groups.set(own.id, own);
    }
  }
  const hasRouteAction = new Set([...groups.values()]
    .filter(group => group.events.every(event => event.kind === 'route_action') && group.parent)
    .map(group => group.parent!));
  const steps: TimelineStep[] = [];
  for (const group of groups.values()) {
    const ordered = group.events.slice().sort((a, b) => a.seq - b.seq);
    const latest = ordered.at(-1)!;
    if (ROUTER_TOOLS.has(latest.label) && hasRouteAction.has(group.id) && latest.kind !== 'route_action') continue;
    const start = ordered.find(event => activeStatus(event.status)) ?? ordered[0]!;
    const step: TimelineStep = {
      id: group.id, seq: start.seq, at: start.at, actor: latest.actor, kind: latest.kind, label: latest.label,
      title: stepTitle(latest, triggerKind(start.data)), status: latest.status,
      taskId: latest.taskId, parent: group.parent,
    };
    const trigger = record(record(start.data).trigger);
    if (typeof trigger.preview === 'string' && trigger.preview) step.trigger = trigger.preview;
    const startSummary = record(record(start.data).summary);
    const endSummary = record(record(latest.data).summary);
    if (latest.kind === 'route_action') {
      const action = record(latest.data) as unknown as RouteAction;
      step.route = action; step.taskId = action.taskId ?? latest.taskId; step.taskLabel = action.taskLabel;
      step.summary = action.summary; step.summarySource = action.summary ? 'action' : undefined;
      step.error = action.error;
      step.at = action.at ?? start.at;
      step.title = stepTitle(latest);
      // The routing action replaces its tool call in the list, so keep that call's recorded
      // arguments and result readable instead of hiding them behind a second, folded node.
      const call = group.parent ? groups.get(group.parent) : undefined;
      if (call && ROUTER_TOOLS.has(call.events[0]!.label)) {
        const callEvents = call.events.slice().sort((a, b) => a.seq - b.seq);
        const callStart = callEvents.find(event => activeStatus(event.status)) ?? callEvents[0]!;
        const callEnd = callEvents.at(-1)!;
        const args = record(record(callStart.data).summary);
        const result = record(record(callEnd.data).summary);
        if (Object.keys(record(args.input)).length) step.input = args.input as Record<string, string>;
        if (args.inputTruncated === true) step.inputTruncated = true;
        if (typeof result.output === 'string' && result.output) step.output = result.output;
        if (result.outputTruncated === true) step.outputTruncated = true;
        step.parentTool = call.id;
      }
    } else if (latest.kind === 'followup_state') {
      const data = record(latest.data);
      step.followupState = String(data.state ?? latest.status);
      step.taskLabel = data.taskLabel ? String(data.taskLabel) : undefined;
      step.status = String(data.state ?? latest.status);
    } else {
      const publicText = typeof endSummary.publicText === 'string' ? endSummary.publicText : undefined;
      const stream = latest.spanId ? streamed.get(latest.spanId) : undefined;
      step.summary = publicText ?? stream;
      step.summarySource = publicText ? 'turn' : stream ? 'stream' : undefined;
      step.summaryTruncated = endSummary.publicTextTruncated === true;
      step.input = Object.keys(record(startSummary.input)).length ? record(startSummary.input) as Record<string, string> : undefined;
      step.inputTruncated = startSummary.inputTruncated === true;
      step.output = typeof endSummary.output === 'string' ? endSummary.output : undefined;
      step.outputTruncated = endSummary.outputTruncated === true;
      step.exitCode = typeof endSummary.exitCode === 'number' ? endSummary.exitCode : undefined;
      step.error = stepError(latest);
    }
    const childOperations = operations.get(group.id);
    if (childOperations?.length) {
      const settlement = childOperations.at(-1)!;
      const data = record(settlement.data);
      step.error ??= typeof data.error === 'string' ? data.error : undefined;
      const preview = typeof data.preview === 'string' ? data.preview : undefined;
      if (!step.output && preview) { step.output = preview; step.outputTruncated = true; }
      if (typeof data.fileName === 'string' && step.input?.input) step.input = { ...step.input, input: String(data.fileName) };
      if (step.title === '读取文件副本' && step.input && 'input' in step.input) {
        const { input: file, ...rest } = step.input;
        step.input = { 文件: file, ...rest };
      }
      if (settlement.status === 'unknown' || settlement.status === 'failed') step.status = settlement.status;
    }
    steps.push(step);
  }
  return steps.sort((a, b) => a.seq - b.seq);
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

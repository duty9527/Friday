import type { ChatMessage, MainView, MessagePage, TraceEvent, WorkView, RouteAction } from '../view.js';
import { mergeMessages as mergeInto, orderConversation, routeLabel, routeState, spanDuration, spanNodes as buildSpans, spanTree, usageSummary, type SpanNode } from './model.js';

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing interface element: ${id}`);
  return node as T;
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.textContent = text;
  if (className) result.className = className;
  return result;
}
function button(text: string, action: () => void, className = ''): HTMLButtonElement {
  const result = node('button', text, className);
  result.type = 'button';
  result.addEventListener('click', action);
  return result;
}
const ui = {
  connection: element('connection'), reconnect: element<HTMLButtonElement>('reconnect'),
  mode: element('mode'), works: element('works'), workFilter: element<HTMLSelectElement>('work-filter'),
  stopWork: element<HTMLButtonElement>('stop-work'), sidebar: element('work-sidebar'),
  workToggle: element<HTMLButtonElement>('work-toggle'), messages: element('messages'),
  scroll: element('messages-scroll'), older: element<HTMLButtonElement>('older'), historyError: element('history-error'),
  composer: element<HTMLFormElement>('composer'), draft: element<HTMLTextAreaElement>('draft'),
  paths: element<HTMLTextAreaElement>('paths'), send: element<HTMLButtonElement>('send'), sendError: element('send-error'),
  panels: element('panels'), showChat: element<HTMLButtonElement>('show-chat'), showTrace: element<HTMLButtonElement>('show-trace'),
  traceScope: element('trace-scope'), traceContent: element('trace-content'), traceMore: element<HTMLButtonElement>('trace-more'),
  traceError: element('trace-error'), traceRetry: element<HTMLButtonElement>('trace-retry'),
  graphMode: element<HTMLButtonElement>('graph-mode'), timelineMode: element<HTMLButtonElement>('timeline-mode'),
  eventDetail: element('event-detail'), workDetail: element('work-detail'), routingDetail: element('routing-detail'),
};
const statusNames: Record<string, string> = {
  queued: '排队中', processing: '处理中', streaming: '回复中', completed: '已完成', interrupted: '已中断',
  failed: '失败', running: '运行中', started: '已开始', requested: '已请求', succeeded: '成功',
  paused: '已暂停', cancelled: '已取消', stopped: '已停止', stopping: '正在请求停止',
  stop_requested: '已请求停止', cancel_requested: '已请求取消', unknown: '结果未知',
  linked: '已关联', ready: '就绪', degraded: '服务降级', pending: '处理中', accepted: '已受理',
};
const statusText = (value: string) => statusNames[value] ?? value;
import { activeStatus as active, settledStatus as terminal } from './model.js';
function timestamp(at: number): string {
  return Number.isFinite(at) ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—';
}
function json(value: unknown): string { return JSON.stringify(value, null, 2) ?? '—'; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : '请求失败'; }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const tokenKey = 'super-agent.local-access-token';
let token = '';
let storageUnavailable = false;
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('token')) {
  const candidate = fragment.get('token') ?? '';
  // Consume even an invalid fragment; it must not leak through copied links or referrers.
  history.replaceState(null, '', location.pathname + location.search);
  try {
    sessionStorage.removeItem(tokenKey);
    if (/^[a-f\d]{64}$/i.test(candidate)) sessionStorage.setItem(tokenKey, candidate);
  } catch { storageUnavailable = true; }
  if (/^[a-f\d]{64}$/i.test(candidate)) token = candidate;
} else {
  try { token = sessionStorage.getItem(tokenKey) ?? ''; } catch { storageUnavailable = true; }
}
if (!/^[a-f\d]{64}$/i.test(token)) token = '';
let authExpired = false;
let ready = false;
let view: MainView | undefined;
const messages = new Map<string, ChatMessage>();
let historyBefore: number | undefined;
let historyHasMore = false;
let historyBusy = false;
let sending = false;
interface Submission { requestId: string; text: string; files: string[] }
let pending: Submission | undefined;
let uncertain = false;
const stopRequests = new Set<string>();
let cursor = 0;
let connectionGeneration = 0;
let streamController: AbortController | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 500;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshBusy = false;
let refreshAgain = false;
type Selection = { type: 'all' } | { type: 'task' | 'message'; id: string; label: string };
let selection: Selection = { type: 'all' };
let selectionGeneration = 0;
let traceEvents: TraceEvent[] = [];
let traceAfter = 0;
let traceHasMore = false;
let traceBusy = false;
let traceAgain = false;
let timeline = false;
let selectedEvent: number | undefined;
let selectedSpan: string | undefined;
let workData: unknown;
let workRequest = 0;

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
function connection(text: string, stale = false) {
  if (authExpired) {
    text = '访问链接已失效。请从当前服务的本地启动链接重新进入（服务重启后需使用新链接）。';
    stale = true;
  }
  ui.connection.textContent = text;
  ui.connection.parentElement?.classList.toggle('stale', stale);
}
function expireAuthentication() {
  authExpired = true;
  ready = false;
  streamController?.abort();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (refreshTimer) clearTimeout(refreshTimer);
  connection('访问链接已失效。请从当前服务的本地启动链接重新进入（服务重启后需使用新链接）。', true);
  ui.reconnect.disabled = true;
  updateComposer();
  renderWorks();
  renderMessages();
}
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  if (!token || authExpired) throw new Error('请使用当前服务生成的本地启动链接进入。');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'omit', cache: 'no-store' });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => ({}));
    if (response.status === 401) expireAuthentication();
    throw new ApiError(typeof record(body).error === 'string' ? String(record(body).error) : `本机服务返回 ${response.status}`, response.status);
  }
  return response;
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  return (await request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })).json() as Promise<T>;
}
function updateComposer() {
  const locked = !ready || authExpired;
  ui.draft.disabled = locked;
  ui.paths.disabled = locked;
  ui.draft.readOnly = sending || uncertain;
  ui.paths.readOnly = sending || uncertain;
  ui.send.disabled = locked || sending || (!uncertain && !ui.draft.value.trim());
  ui.send.textContent = sending ? '正在发送…' : uncertain ? '重试原请求' : '发送 ↑';
}
function mergeMessages(items: ChatMessage[]) {
  mergeInto(messages, items);
  if (uncertain && pending && items.some(message => message.requestId === pending?.requestId)) {
    pending = undefined;
    uncertain = false;
    ui.draft.value = '';
    ui.paths.value = '';
    ui.sendError.textContent = '已从持久记录确认接收，无需重发。';
    updateComposer();
  }
}
function renderMessages() {
  const nearBottom = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 90;
  const previousTop = ui.scroll.scrollTop;
  const focus = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.actionKey : undefined;
  const contents = document.createDocumentFragment();
  const ordered = orderConversation(messages.values());
  for (const message of ordered) {
    const systemNotice = message.source === 'system';
    const article = node('article', '', `message ${message.role === 'user' ? 'user-message' : 'router-message'}`);
    article.dataset.messageId = message.id;
    article.dataset.seq = String(message.seq);
    if (message.replyTo) article.dataset.replyTo = message.replyTo;
    const speaker = node('div', '', 'speaker');
    speaker.append(node('span', message.role === 'user' ? '你' : systemNotice ? '系统 · 工作状态（非模型回复）' : 'Super-agent · Router'));
    speaker.append(node('span', message.role === 'user' && message.status === 'completed' ? 'Router 已处理' : statusText(message.status), active(message.status) ? 'running' : ''));
    if (message.mode === 'offline') speaker.append(node('span', '离线模拟'));
    const time = node('time', timestamp(message.at));
    time.dateTime = new Date(message.at).toISOString();
    speaker.append(time);
    const full = message.text || (active(message.status) ? '等待公开回复…' : '没有公开文本。');
    const visible = full.slice(0, 4000);
    const textBlock = node('div', visible, 'message-text');
    article.append(speaker);
    if (message.replyTo) {
      const source = messages.get(message.replyTo);
      article.append(button(`回应：${source?.text.slice(0, 80) ?? '查看原消息'}`, () => { void jumpMessage(message.replyTo!); }, 'source-reference'));
    }
    article.append(textBlock);
    if (message.role === 'user') article.append(routingSummary(message));
    for (const id of message.role === 'assistant' || !message.routing ? message.taskIds : []) {
      const work = view?.works.find(item => item.id === id);
      article.append(button(`关联工作：${work?.prompt ?? '查看工作'}`, () => {
        selectTrace({ type: 'task', id, label: work?.prompt ?? '关联工作' }); showPanel(true);
      }, 'source-reference'));
    }
    if (full.length > visible.length) {
      const more = node('details');
      more.append(node('summary', `展开剩余 ${full.length - visible.length} 个字符`), node('pre', full.slice(visible.length)));
      article.append(more);
    }
    for (const path of message.paths) article.append(node('span', path, 'message-path'));
    if (message.reason) article.append(node('p', message.reason, 'message-reason'));
    const actions = node('div', '', 'message-actions');
    const trace = button(message.role === 'user' ? '查看本次路由与上下文' : '查看来源轨迹', () => {
      selectTrace({ type: 'message', id: message.replyTo ?? message.id, label: '本轮消息' });
      showPanel(true);
    });
    trace.dataset.actionKey = `trace-${message.id}`;
    actions.append(trace);
    if (active(message.status)) {
      const deliveryWork = message.role === 'assistant' ? view?.works.find(work => message.taskIds.includes(work.id) && active(work.status)) : undefined;
      const requested = stopRequests.has(deliveryWork ? `task:${deliveryWork.id}` : `message:${message.id}`);
      const label = message.role === 'user' ? '取消这条消息' : deliveryWork ? '停止这项工作' : '停止本轮回复';
      const stop = button(requested ? '已请求停止' : label, () => {
        if (deliveryWork) void stopWork(deliveryWork.id); else void stopMessage(message.id);
      });
      stop.disabled = requested || authExpired;
      stop.dataset.actionKey = `stop-${message.id}`;
      actions.append(stop);
    }
    article.append(actions);
    contents.append(article);
  }
  if (!contents.childNodes.length) contents.append(node('p', '从这里开始。直接描述目标，Router 会在同一个对话中持续回复。', 'empty'));
  ui.messages.replaceChildren(contents);
  ui.older.hidden = !historyHasMore;
  if (focus) {
    const replacement = [...ui.messages.querySelectorAll<HTMLButtonElement>('button')].find(item => item.dataset.actionKey === focus);
    replacement?.focus({ preventScroll: true });
  }
  ui.scroll.scrollTop = nearBottom ? ui.scroll.scrollHeight : previousTop;
  renderRoutingDetail();
}
async function jumpMessage(id: string) {
  try {
    if (!messages.has(id)) { mergeMessages([await api<ChatMessage>(`/api/message?${new URLSearchParams({ messageId: id })}`)]); renderMessages(); }
    showPanel(false);
    const target = [...ui.messages.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.dataset.messageId === id);
    if (target) {
      ui.scroll.scrollTop += target.getBoundingClientRect().top - ui.scroll.getBoundingClientRect().top - 16;
      target.classList.add('message-highlight'); setTimeout(() => target.classList.remove('message-highlight'), 2000);
    }
  } catch (error) { connection(`来源消息读取失败：${errorText(error)}`, true); }
}
function actionRow(action: RouteAction): HTMLElement {
  const row = node('div', '', 'route-action');
  const title = `${routeLabel(action)}${action.taskId ? ` · ${action.taskLabel ?? '目标工作名称未记录'}` : ''}`;
  if (action.taskId) row.append(button(title, () => {
    selectTrace({ type: 'task', id: action.taskId!, label: action.taskLabel ?? '目标工作' }); showPanel(true);
  }, 'route-target'));
  else row.append(node('strong', title));
  row.append(node('p', routeState(action), action.status === 'failed' || action.status === 'interrupted' || action.delivery === 'failed' ? 'error' : 'meta'));
  if (action.parentTaskId) row.append(button('来源工作：查看原执行（本次是新执行）', () => {
    selectTrace({ type: 'task', id: action.parentTaskId!, label: '来源工作' }); showPanel(true);
  }, 'source-reference'));
  if (action.messageIds?.length) row.append(node('p', `已读取 ${action.messageIds.length} 条历史消息引用`, 'meta'));
  if (action.summary) row.append(node('p', `Router 公开说明：${action.summary}`, 'meta'));
  if (action.error) row.append(node('p', action.error, 'error'));
  return row;
}
function routingSummary(message: ChatMessage): HTMLElement {
  const area = node('div', '', 'routing-summary');
  if (!message.routing) {
    area.append(node('p', active(message.status) ? '等待 Router 处理并记录分配结果…' : '此历史消息未采集路由摘要；不从回复正文猜测。', 'meta'));
    return area;
  }
  for (const action of message.routing.actions) area.append(actionRow(action));
  if (!message.routing.actions.length) area.append(node('p', message.routing.status === 'processing' ? 'Router 正在处理，尚无已受理动作。' : '本次路由未确认完成，没有可确认的分配动作。', 'meta'));
  if (message.routing.omittedActions) area.append(node('p', '动作较多，摘要只展示最近 40 条；完整动作记录请在事件时间线查看。', 'meta'));
  if (message.routing.status === 'failed' || message.routing.status === 'interrupted') area.append(node('p', 'Router 处理未完成；已受理的动作保留，不代表已撤销。', 'meta'));
  return area;
}
function renderRoutingDetail() {
  ui.routingDetail.hidden = selection.type !== 'message';
  if (selection.type !== 'message') return;
  const message = messages.get(selection.id);
  const referencesOpen = ui.routingDetail.querySelector('details')?.open ?? false;
  ui.routingDetail.replaceChildren(node('h3', '本次 Router 分配'));
  if (!message?.routing) {
    ui.routingDetail.append(node('p', '此消息尚无已记录的路由上下文。旧历史不会补造。', 'meta')); return;
  }
  const routing = message.routing;
  ui.routingDetail.append(node('p', `路由处理时：${timestamp(routing.at)} · ${statusText(routing.status)}`, 'meta'));
  ui.routingDetail.append(node('h4', '当时可见的工作'));
  for (const work of routing.context.works) {
    const row = node('div', '', 'routing-work');
    row.append(button(work.prompt || '后台工作', () => { selectTrace({ type: 'task', id: work.id, label: work.prompt }); showPanel(true); }, 'source-reference'),
      node('span', `当时${statusText(work.status)}`, 'meta'));
    ui.routingDetail.append(row);
  }
  if (!routing.context.works.length) ui.routingDetail.append(node('p', '当时没有后台工作。', 'meta'));
  if (routing.context.truncated) ui.routingDetail.append(node('p', `当时共 ${routing.context.totalWorks} 项工作，Router 仅收到最近 ${routing.context.works.length} 项摘要。`, 'meta'));
  ui.routingDetail.append(node('p', '以上是处理当时的状态，不随当前工作状态改写。', 'meta'), node('h4', '已记录动作'));
  for (const action of routing.actions) {
    ui.routingDetail.append(actionRow(action));
    for (const [index, id] of (action.messageIds ?? []).entries()) ui.routingDetail.append(button(
      `召回引用 ${index + 1}：${messages.get(id)?.text.slice(0, 60) ?? '读取原消息'}`, () => { void jumpMessage(id); }, 'source-reference'));
  }
  if (routing.omittedActions) ui.routingDetail.append(node('p', '摘要只展示最近 40 条动作；完整动作记录请查看事件时间线。', 'meta'));
  if (!routing.actions.length) ui.routingDetail.append(node('p', '尚无已确认的路由动作。', 'meta'));
  const refs = node('details'); refs.open = referencesOpen; refs.append(node('summary', '当时的近期对话引用'));
  for (const reference of routing.context.messages) refs.append(button(`${reference.role === 'user' ? '你' : 'Router'}：${reference.preview || '无公开文本'}`, () => { void jumpMessage(reference.id); }, 'source-reference'));
  ui.routingDetail.append(refs, node('p', `执行环境：${routing.context.execution} · ${routing.context.cwd}`, 'meta'));
}
function renderWorks() {
  const filter = ui.workFilter.value;
  const works = (view?.works ?? []).filter(work => filter === 'all' || (filter === 'active' ? active(work.status) : !active(work.status)));
  const contents = document.createDocumentFragment();
  for (const work of works) {
    const selected = selection.type === 'task' && selection.id === work.id;
    const entry = button('', () => {
      selectTrace({ type: 'task', id: work.id, label: work.prompt });
      closeSidebar();
      showPanel(true);
    }, `work-row${selected ? ' selected' : ''}`);
    entry.setAttribute('aria-pressed', String(selected));
    entry.title = work.prompt;
    entry.append(node('span', work.prompt || '后台工作', 'work-title'));
    entry.append(node('span', `${statusText(work.status)} · ${timestamp(work.createdAt)}`, `meta${active(work.status) ? ' running' : ''}`));
    contents.append(entry);
  }
  if (!works.length) contents.append(node('p', view ? '暂无符合筛选的后台工作。' : '尚未读取后台工作。', 'empty'));
  ui.works.replaceChildren(contents);
  const selectedId = selection.type === 'task' ? selection.id : undefined;
  const selected = view?.works.find(work => work.id === selectedId);
  const requested = selection.type === 'task' && stopRequests.has(`task:${selection.id}`);
  ui.stopWork.disabled = !selected || !active(selected.status) || requested || authExpired;
  ui.stopWork.textContent = requested ? '已请求停止，等待结算' : '停止选中的工作';
  ui.stopWork.title = selected ? '停止请求不等于已确认取消，以持久状态为准' : '请先在后台工作列表选择工作';
}
async function hydrateParents() {
  // A page of replies must never appear without the message that asked for it.
  const missing = [...new Set([...messages.values()].map(message => message.replyTo).filter((id): id is string => Boolean(id) && !messages.has(id!)))];
  if (!missing.length) return;
  const parents = await Promise.all(missing.slice(0, 40).map(id => api<ChatMessage>(`/api/message?${new URLSearchParams({ messageId: id })}`).catch(() => undefined)));
  mergeMessages(parents.filter((message): message is ChatMessage => Boolean(message)));
}
async function refreshView(initial = false) {
  if (refreshBusy) { refreshAgain = true; return; }
  refreshBusy = true;
  try {
    const result = await api<MainView>('/api/view');
    const selectedTaskId = selection.type === 'task' ? selection.id : undefined;
    const previousWorkStatus = view?.works.find(work => work.id === selectedTaskId)?.status;
    view = result;
    for (const work of result.works) if (['completed', 'failed', 'cancelled'].includes(work.status)) stopRequests.delete(`task:${work.id}`);
    for (const message of result.messages.items) if (!active(message.status)) stopRequests.delete(`message:${message.id}`);
    ready = true;
    mergeMessages(result.messages.items);
    await hydrateParents();
    if (initial || historyBefore === undefined) {
      historyBefore = result.messages.before;
      historyHasMore = result.messages.hasMore;
    }
    if (initial) cursor = result.cursor;
    ui.mode.textContent = result.mode === 'offline' ? '[OFFLINE SIMULATION] / 离线模拟' : '真实模式 · 完整本机工具（非沙箱）';
    ui.mode.classList.toggle('offline', result.mode === 'offline');
    renderMessages();
    renderWorks();
    updateComposer();
    if (!initial && selection.type === 'task' && result.works.find(work => work.id === selectedTaskId)?.status !== previousWorkStatus) {
      void loadWork(selection.id, selectionGeneration, true);
    }
  } finally {
    refreshBusy = false;
    if (refreshAgain && !authExpired) { refreshAgain = false; scheduleRefresh(); }
  }
}
function scheduleRefresh() {
  if (refreshTimer || authExpired) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refreshView().catch(error => connection(`数据可能已过时：${errorText(error)}。后台工作不会因页面断开而停止。`, true));
    if (!traceHasMore) void loadTrace();
  }, 150);
}
async function loadOlder() {
  if (historyBusy || historyBefore === undefined) return;
  historyBusy = true;
  ui.older.disabled = true;
  ui.older.textContent = '正在读取…';
  ui.historyError.textContent = '';
  const oldHeight = ui.scroll.scrollHeight;
  const oldTop = ui.scroll.scrollTop;
  try {
    const page = await api<MessagePage>(`/api/history?before=${historyBefore}`);
    mergeMessages(page.items);
    historyBefore = page.before;
    historyHasMore = page.hasMore;
    renderMessages();
    ui.scroll.scrollTop = oldTop + ui.scroll.scrollHeight - oldHeight;
  } catch (error) { ui.historyError.textContent = `更早消息读取失败：${errorText(error)}。可再次点击加载。`; }
  finally { historyBusy = false; ui.older.disabled = false; ui.older.textContent = '加载更早消息'; }
}
async function send() {
  if (sending || !ready || authExpired) return;
  if (!uncertain) {
    const text = ui.draft.value.trim();
    if (!text) return;
    const files = ui.paths.value.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
    if (files.length > 32 || files.some(path => path.length > 4096 || !path.startsWith('/') || path.includes('\0')))  {
      ui.sendError.textContent = '最多提供 32 个本机绝对路径（文件或文件夹，以 / 开头、每个不超过 4096 字符）；用于提示工作位置，由服务进一步校验。';
      return;
    }
    pending = { requestId: crypto.randomUUID(), text, files };
  }
  if (!pending) return;
  const submitted = pending;
  sending = true;
  ui.sendError.textContent = '';
  updateComposer();
  try {
    const accepted = await api<ChatMessage>('/api/chat', submitted);
    mergeMessages([accepted]);
    pending = undefined;
    uncertain = false;
    ui.draft.value = '';
    ui.paths.value = '';
    renderMessages();
    selectTrace({ type: 'message', id: accepted.id, label: submitted.text.slice(0, 80) });
    ui.scroll.scrollTop = ui.scroll.scrollHeight;
    scheduleRefresh();
  } catch (error) {
    const confirmed = [...messages.values()].some(message => message.requestId === submitted.requestId);
    if (confirmed) {
      pending = undefined; uncertain = false; ui.draft.value = ''; ui.paths.value = '';
      ui.sendError.textContent = '已从持久记录确认接收，无需重发。';
      return;
    }
    uncertain = !(error instanceof ApiError) || error.status >= 500;
    if (!uncertain) pending = undefined;
    ui.sendError.textContent = uncertain
      ? `接收结果未确认：${errorText(error)}。草稿已保留并锁定；点击“重试原请求”会使用同一请求标识，不自动重发。`
      : `发送失败，草稿已保留：${errorText(error)}`;
  } finally { sending = false; updateComposer(); }
}
async function stopMessage(id: string) {
  const key = `message:${id}`;
  stopRequests.add(key);
  renderMessages();
  try {
    await api<unknown>('/api/chat-stop', { messageId: id });
    connection('已请求停止本轮回复；以最终记录为准。其他后台工作不受影响。');
    scheduleRefresh();
  } catch (error) {
    stopRequests.delete(key);
    renderMessages();
    connection(`停止请求未确认：${errorText(error)}。可再次请求；本轮回复不一定已停止。`, true);
  }
}
async function stopWork(target?: string) {
  const id = target ?? (selection.type === 'task' ? selection.id : undefined);
  if (!id) return;
  const key = `task:${id}`;
  stopRequests.add(key);
  renderWorks(); renderMessages();
  try {
    const task = await api<unknown>('/api/stop', { taskId: id });
    if (selection.type === 'task' && selection.id === id) { workData = task; renderWorkDetail(); }
    connection('已请求停止选中工作，尚不代表确认取消；请查看最终状态与原因。');
    scheduleRefresh();
  } catch (error) {
    stopRequests.delete(key);
    renderWorks();
    connection(`停止请求未确认：${errorText(error)}。可再次请求。`, true);
  }
}

function showPanel(trace: boolean) {
  ui.panels.classList.toggle('trace-visible', trace);
  ui.showChat.setAttribute('aria-pressed', String(!trace));
  ui.showTrace.setAttribute('aria-pressed', String(trace));
}
function closeSidebar() {
  ui.sidebar.classList.remove('open');
  ui.workToggle.setAttribute('aria-expanded', 'false');
}
function selectTrace(next: Selection) {
  selection = next;
  selectionGeneration++;
  traceEvents = [];
  traceAfter = 0;
  traceHasMore = false;
  traceBusy = false;
  traceAgain = false;
  selectedEvent = undefined;
  selectedSpan = undefined;
  workData = undefined;
  ui.traceScope.textContent = next.type === 'all' ? '全部已记录事件' : `${next.type === 'task' ? '后台工作' : '消息'} · ${next.label}`;
  ui.traceScope.title = ui.traceScope.textContent;
  ui.traceContent.replaceChildren(node('p', '正在读取实际轨迹…', 'empty'));
  ui.eventDetail.replaceChildren(node('h3', '节点详情'), node('p', '选择节点查看公开数据与记录时间。', 'meta'));
  renderWorks();
  renderWorkDetail();
  renderRoutingDetail();
  void loadTrace();
  if (next.type === 'task') void loadWork(next.id, selectionGeneration);
}
async function loadTrace() {
  if (!ready || authExpired) return;
  if (traceBusy) { traceAgain = true; return; }
  const generation = selectionGeneration;
  const after = traceAfter;
  const params = new URLSearchParams({ after: String(after) });
  if (selection.type !== 'all') params.set(selection.type === 'task' ? 'taskId' : 'messageId', selection.id);
  traceBusy = true;
  ui.traceMore.disabled = true;
  ui.traceError.textContent = '';
  ui.traceRetry.hidden = true;
  try {
    const events = await api<TraceEvent[]>(`/api/trace?${params}`);
    if (generation !== selectionGeneration || after !== traceAfter) return;
    const merged = new Map(traceEvents.map(event => [event.seq, event]));
    for (const event of events) merged.set(event.seq, event);
    traceEvents = [...merged.values()].sort((a, b) => a.seq - b.seq);
    traceAfter = events.at(-1)?.seq ?? after;
    traceHasMore = events.length === 60;
    renderTrace();
  } catch (error) {
    if (generation === selectionGeneration) {
      ui.traceError.textContent = `轨迹读取失败：${errorText(error)}`;
      ui.traceRetry.hidden = false;
    }
  } finally {
    if (generation === selectionGeneration) {
      traceBusy = false;
      ui.traceMore.disabled = false;
      ui.traceMore.hidden = !traceHasMore;
      if ((!timeline && selection.type !== 'all' && traceHasMore) || (traceAgain && !traceHasMore)) { traceAgain = false; void loadTrace(); }
    }
  }
}
function eventButton(event: TraceEvent, events: TraceEvent[], span?: string): HTMLButtonElement {
  const selected = span ? selectedSpan === span : selectedEvent === event.seq;
  const entry = button('', () => {
    selectedEvent = event.seq;
    selectedSpan = span;
    renderTrace();
  }, `node-button${active(event.status) ? ' running' : ''}${selected ? ' selected' : ''}`);
  entry.setAttribute('aria-pressed', String(selected));
  entry.append(node('span', `${event.actor} · ${event.label}`, 'node-title'));
  const measured = span ? spanDuration(events) : undefined;
  entry.append(node('span', `${statusText(event.status)} · ${measured ?? timestamp(events.at(-1)?.at ?? event.at)}`, 'meta'));
  return entry;
}
function renderTrace() {
  const contents = document.createDocumentFragment();
  if (timeline) {
    const list = node('ul');
    for (const event of traceEvents) {
      if (event.kind === 'thinking') continue;
      const item = node('li', '', 'trace-node');
      item.append(eventButton(event, [event]));
      list.append(item);
    }
    contents.append(list);
  } else {
    const spans = buildSpans(traceEvents);
    const tree = spanTree(spans);
    const visited = new Set<string>();
    // Rendered as deep as the recorded chain goes: an operation two model calls below the message is
    // still a child, not a second root.
    const appendSpan = (span: SpanNode, list: HTMLUListElement) => {
      if (visited.has(span.id)) return;
      visited.add(span.id);
      const latest = span.events.at(-1);
      if (!latest) return;
      const item = node('li', '', 'trace-node');
      item.append(eventButton(latest, span.events, span.id));
      const children = (tree.children.get(span.id) ?? []).filter(child => !visited.has(child.id));
      if (children.length) {
        if (children.filter(child => child.events.some(event => event.kind === 'task_state')).length > 1) {
          item.append(node('p', '↳ 多项后台工作分支', 'branch-note'));
        }
        const branch = node('ul');
        for (const child of children) appendSpan(child, branch);
        item.append(branch);
      }
      list.append(item);
    };
    const list = node('ul');
    for (const span of tree.roots) appendSpan(span, list);
    if (tree.detached.length) {
      list.append(node('p', `有 ${tree.detached.length} 个节点的父级不在本次读取的范围内（历史被截断或父节点未采集），单独列出以免误认为顶层事件。`, 'branch-note'));
      for (const span of tree.detached) appendSpan(span, list);
    }
    // Cyclic or malformed records stay inspectable instead of disappearing.
    for (const span of spans) if (!visited.has(span.id)) appendSpan(span, list);
    contents.append(list);
    const unspanned = new Map<string, TraceEvent[]>();
    for (const event of traceEvents.filter(event => !event.spanId && event.kind !== 'visible_text' && event.kind !== 'thinking' && event.kind !== 'work_linked')) {
      const key = event.type === 'message' ? `message:${event.messageId}` : `${event.kind}:${event.messageId}:${event.taskId}`;
      const group = unspanned.get(key) ?? []; group.push(event); unspanned.set(key, group);
    }
    for (const events of unspanned.values()) contents.append(eventButton(events.at(-1)!, events));
  }
  if (!traceEvents.length) contents.append(node('p', selection.type === 'task' ? '此历史工作未采集详细轨迹' : '此范围尚无已记录轨迹。', 'empty'));
  else if (!timeline && !buildSpans(traceEvents).length && traceEvents.every(event => event.kind === 'visible_text')) {
    contents.append(node('p', '仅有公开文本增量，请在事件时间线查看。', 'empty'));
  }
  ui.traceContent.replaceChildren(contents);
  ui.traceMore.hidden = !traceHasMore;
  if (selectedEvent !== undefined || selectedSpan) renderEventDetail();
}
function detailRow(parent: HTMLElement, label: string, value: string) {
  const row = node('div', '', 'detail-row');
  row.append(node('span', label), node('span', value));
  parent.append(row);
}
function renderEventDetail() {
  const events = selectedSpan ? traceEvents.filter(event => event.spanId === selectedSpan && event.kind !== 'visible_text')
    : traceEvents.filter(event => event.seq === selectedEvent);
  const latest = events.at(-1);
  if (!latest) return;
  ui.eventDetail.replaceChildren(node('h3', latest.label));
  detailRow(ui.eventDetail, '调用方', latest.actor);
  detailRow(ui.eventDetail, '状态', statusText(latest.status));
  detailRow(ui.eventDetail, '首次记录', timestamp(events[0]?.at ?? latest.at));
  detailRow(ui.eventDetail, '最后记录', timestamp(latest.at));
  detailRow(ui.eventDetail, '记录耗时', spanDuration(events) ?? '—（未记录完整起止）');
  detailRow(ui.eventDetail, 'Token 用量', usageSummary(events.at(-1)?.data));
  if (selectedSpan) detailRow(ui.eventDetail, 'Span', selectedSpan);
  if (latest.parentSpanId) detailRow(ui.eventDetail, '父 Span', latest.parentSpanId);
  ui.eventDetail.append(node('pre', json(events.map(event => ({ seq: event.seq, kind: event.kind, status: event.status, at: event.at, data: event.data })))));
}
async function loadWork(id: string, generation: number, background = false) {
  const requestNumber = ++workRequest;
  ui.workDetail.hidden = false;
  if (!background || !workData) ui.workDetail.replaceChildren(node('h3', '工作详情'), node('p', '正在读取报告与文件记录…', 'meta'));
  try {
    const task = await api<unknown>(`/api/work?${new URLSearchParams({ taskId: id })}`);
    if (generation !== selectionGeneration || requestNumber !== workRequest) return;
    workData = task;
    renderWorkDetail();
  } catch (error) {
    if (generation !== selectionGeneration || requestNumber !== workRequest) return;
    ui.workDetail.replaceChildren(node('h3', '工作详情'), node('p', `读取失败：${errorText(error)}`, 'error'), button('重试工作详情', () => { void loadWork(id, generation); }));
  }
}
function renderWorkDetail() {
  ui.workDetail.hidden = selection.type !== 'task';
  if (selection.type !== 'task' || !workData) return;
  const taskId = selection.id;
  const generation = selectionGeneration;
  const task = record(workData);
  ui.workDetail.replaceChildren(node('h3', '工作详情 · 诊断'), button('刷新工作详情', () => { void loadWork(taskId, generation); }));
  if (typeof task.status === 'string') detailRow(ui.workDetail, '状态', statusText(task.status));
  if (typeof task.reason === 'string') ui.workDetail.append(node('p', task.reason, 'message-reason'));
  if (task.report !== undefined) {
    const report = node('details');
    report.append(node('summary', '查看已交付报告（Router 汇总）'), node('pre', typeof task.report === 'string' ? task.report : json(task.report)));
    ui.workDetail.append(report);
  }
  if (Array.isArray(task.followups) && task.followups.length) {
    const area = node('div', '', 'followups');
    area.append(node('h3', '补充要求'));
    for (const value of task.followups) {
      const item = record(value);
      const row = node('div', '', 'detail-row');
      row.append(node('span', typeof item.text === 'string' ? item.text : '（无正文）'));
      row.append(node('span', statusText(String(item.state ?? '')), item.state === 'failed' ? 'state-failed' : 'meta'));
      area.append(row);
    }
    ui.workDetail.append(area);
  }
  if (task.files !== undefined) {
    const files = node('details');
    files.append(node('summary', '查看文件记录'), node('pre', json(task.files)));
    ui.workDetail.append(files);
  }
  if (Array.isArray(task.operations)) {
    for (const value of task.operations) {
      const operation = record(value);
      const id = operation.id;
      if (typeof id !== 'string') continue;
      const area = node('div', '', 'operation');
      const output = node('div');
      const load = button(`按需读取操作结果 · ${typeof operation.status === 'string' ? statusText(operation.status) : id}`, () => {
        load.disabled = true;
        output.replaceChildren(node('p', '正在读取完整操作结果…', 'meta'));
        void api<unknown>(`/api/operation?${new URLSearchParams({ taskId, operationId: id })}`).then(result => {
          if (generation === selectionGeneration) output.replaceChildren(node('pre', json(result)));
        }).catch(error => {
          if (generation === selectionGeneration) output.replaceChildren(node('p', `读取失败：${errorText(error)}。可再次点击重试。`, 'error'));
        }).finally(() => { load.disabled = false; });
      });
      area.append(load, output);
      ui.workDetail.append(area);
    }
  }
  const metadata = node('details');
  const { report: _report, files: _files, ...rest } = task;
  metadata.append(node('summary', '查看工作与操作元数据'), node('pre', json(rest)));
  ui.workDetail.append(metadata);
}

interface StreamBatch { events: TraceEvent[]; cursor: number; head: number }
async function consumeStream(response: Response, generation: number) {
  if (!response.body) throw new Error('浏览器未提供流式响应');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let data: string[] = [];
  async function dispatch() {
    if (!data.length) { eventName = ''; return; }
    const raw = data.join('\n');
    data = [];
    const name = eventName;
    eventName = '';
    if (name === 'problem') throw new Error(String(record(JSON.parse(raw)).error ?? '事件流暂不可用'));
    if (name !== 'updates' || generation !== connectionGeneration) return;
    const batch = JSON.parse(raw) as StreamBatch;
    const fresh = batch.events.filter(event => event.seq > cursor);
    const ids = [...new Set(fresh.filter(event => event.type === 'message' || event.kind === 'work_linked').map(event => event.messageId).filter((id): id is string => Boolean(id)))];
    const changed = await Promise.all(ids.map(id => api<ChatMessage>(`/api/message?${new URLSearchParams({ messageId: id })}`)));
    if (generation !== connectionGeneration) return;
    mergeMessages(changed);
    await hydrateParents();
    if (changed.length) renderMessages();
    cursor = Math.max(cursor, batch.cursor);
    retryDelay = 500;
    connection(`本机已连接 · ${view?.health.executorAvailable === false ? '执行器不可用，服务降级' : '后台服务持续运行'}${storageUnavailable ? ' · 当前标签页无法保存访问链接' : ''}`);
    if (fresh.length) scheduleRefresh();
  }
  try {
    while (generation === connectionGeneration) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 4_300_000) throw new Error('事件流记录超过可处理长度');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) await dispatch();
        else if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        // SSE comments are heartbeats, not activity or invented counters.
      }
    }
    if (generation === connectionGeneration) throw new Error('事件流已断开');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
async function connect() {
  if (!token || authExpired) return;
  const generation = ++connectionGeneration;
  streamController?.abort();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  streamController = new AbortController();
  const controller = streamController;
  ui.reconnect.disabled = true;
  connection(ready ? '正在恢复连接，保留上次数据…' : '正在连接本机服务…', ready);
  try {
    const initial = !view;
    await refreshView(initial);
    if (generation !== connectionGeneration || authExpired) return;
    if (initial) {
      const latest = [...messages.values()].sort((a, b) => b.seq - a.seq).find(message => message.role === 'user');
      selectTrace(latest ? { type: 'message', id: latest.id, label: latest.text.slice(0, 80) } : { type: 'all' });
    }
    else if (!traceHasMore) void loadTrace();
    const response = await request(`/api/stream?after=${cursor}`, { signal: controller.signal, headers: { Accept: 'text/event-stream' } });
    if (generation !== connectionGeneration) return;
    ui.reconnect.disabled = false;
    connection('本机已连接 · 后台服务持续运行');
    await consumeStream(response, generation);
  } catch (error) {
    if (generation !== connectionGeneration || authExpired || controller.signal.aborted) return;
    connection(`连接已断开 / 数据可能过时：${errorText(error)}。后台工作继续；消息不会自动重发。`, true);
    ui.reconnect.disabled = false;
    reconnectTimer = setTimeout(() => { void connect(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 5000);
  }
}

ui.composer.addEventListener('submit', event => { event.preventDefault(); void send(); });
ui.draft.addEventListener('input', updateComposer);
let composing = false;
ui.draft.addEventListener('compositionstart', () => { composing = true; });
ui.draft.addEventListener('compositionend', () => { composing = false; });
ui.draft.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) {
    event.preventDefault();
    void send();
  }
});
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  // A viewport change must not leave the newest reply clipped under the composer.
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = undefined;
    ui.scroll.scrollTop = ui.scroll.scrollHeight;
  }, 120);
});
ui.older.addEventListener('click', () => { void loadOlder(); });
ui.workFilter.addEventListener('change', renderWorks);
ui.stopWork.addEventListener('click', () => { void stopWork(); });
ui.reconnect.addEventListener('click', () => { retryDelay = 500; void connect(); });
ui.traceMore.addEventListener('click', () => { void loadTrace(); });
ui.traceRetry.addEventListener('click', () => { void loadTrace(); });
element('clear-filter').addEventListener('click', () => selectTrace({ type: 'all' }));
ui.graphMode.addEventListener('click', () => setTraceMode(false));
ui.timelineMode.addEventListener('click', () => setTraceMode(true));
function setTraceMode(value: boolean) {
  timeline = value;
  ui.graphMode.classList.toggle('active', !value);
  ui.timelineMode.classList.toggle('active', value);
  ui.graphMode.setAttribute('aria-pressed', String(!value));
  ui.timelineMode.setAttribute('aria-pressed', String(value));
  renderTrace();
  if (!timeline && traceHasMore && selection.type !== 'all') void loadTrace();
}
ui.showChat.addEventListener('click', () => showPanel(false));
ui.showTrace.addEventListener('click', () => showPanel(true));
ui.workToggle.addEventListener('click', () => {
  const open = ui.sidebar.classList.toggle('open');
  ui.workToggle.setAttribute('aria-expanded', String(open));
  if (open) ui.workFilter.focus();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && ui.sidebar.classList.contains('open')) { closeSidebar(); ui.workToggle.focus(); }
});
document.addEventListener('click', event => {
  if (event.target instanceof Node && !ui.sidebar.contains(event.target) && !ui.workToggle.contains(event.target)) closeSidebar();
});
if (token) void connect();
else {
  connection('缺少有效的本机访问链接。请从当前服务生成的本地启动链接进入；无需在页面输入 API 密钥。', true);
  ui.reconnect.disabled = true;
  ui.messages.replaceChildren(node('p', '请使用带访问令牌的本地启动链接。对话与后台工作由本机服务保存。', 'empty'));
  ui.works.replaceChildren(node('p', '连接本机服务后显示后台工作。', 'empty'));
}

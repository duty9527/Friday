import type { ChatMessage, ContextSearchHit, ImChannelView, MainView, MemoryCard, MessagePage, ModelHubView, ModelProbeResult, ModelProviderView, PluginActionSpec, PluginView, TimerView, TraceEvent, WechatQrLoginSession, WorkView, RouteAction } from '../view.js';
import { mergeMessages as mergeInto, orderConversation, routeLabel, routeState, spanDuration, spanNodes as buildSpans,
  spanTree, timelineSteps, usageSummary, type SpanNode, type TimelineStep } from './model.js';

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
  stepMode: element<HTMLButtonElement>('step-mode'),
  eventDetail: element('event-detail'), workDetail: element('work-detail'), routingDetail: element('routing-detail'),
  memoryTopBadge: element('memory-top-badge'),
  openMemoryHubTop: element<HTMLButtonElement>('open-memory-hub-top'),
  memoryHubBackdrop: element('memory-hub-backdrop'),
  memoryModalClose: element<HTMLButtonElement>('memory-modal-close'),
  memoryKpiGrid: element('memory-kpi-grid'),
  memorySearchScope: element<HTMLSelectElement>('memory-search-scope'),
  memorySearchInput: element<HTMLInputElement>('memory-search-input'),
  memorySearchBtn: element<HTMLButtonElement>('memory-search-btn'),
  memorySearchResults: element('memory-search-results'),
  memoryFilterAll: element<HTMLButtonElement>('memory-filter-all'),
  memoryFilterPinned: element<HTMLButtonElement>('memory-filter-pinned'),
  memoryFilterSynapse: element<HTMLButtonElement>('memory-filter-synapse'),
  memoryAddDetails: element<HTMLDetailsElement>('memory-add-details'),
  memoryTopicInput: element<HTMLInputElement>('memory-topic-input'),
  memoryTagsInput: element<HTMLInputElement>('memory-tags-input'),
  memoryContentInput: element<HTMLTextAreaElement>('memory-content-input'),
  memoryPinnedInput: element<HTMLInputElement>('memory-pinned-input'),
  memoryCancelEditBtn: element<HTMLButtonElement>('memory-cancel-edit-btn'),
  memorySaveBtn: element<HTMLButtonElement>('memory-save-btn'),
  memoryListSubtitle: element('memory-list-subtitle'),
  memoriesList: element('memories-list'),
  timerTopBadge: element('timer-top-badge'),
  openTimerHubTop: element<HTMLButtonElement>('open-timer-hub-top'),
  timerHubBackdrop: element('timer-hub-backdrop'),
  timerModalClose: element<HTMLButtonElement>('timer-modal-close'),
  timerKpiGrid: element('timer-kpi-grid'),
  timerAddDetails: element<HTMLDetailsElement>('timer-add-details'),
  timerNameInput: element<HTMLInputElement>('timer-name-input'),
  timerDailyInput: element<HTMLInputElement>('timer-daily-input'),
  timerIntervalInput: element<HTMLInputElement>('timer-interval-input'),
  timerPluginInput: element<HTMLInputElement>('timer-plugin-input'),
  timerChannelInput: element<HTMLInputElement>('timer-channel-input'),
  timerInstructionInput: element<HTMLTextAreaElement>('timer-instruction-input'),
  timerSaveBtn: element<HTMLButtonElement>('timer-save-btn'),
  timerListSubtitle: element('timer-list-subtitle'),
  timersList: element('timers-list'),
  pluginTopBadge: element('plugin-top-badge'),
  openPluginHubTop: element<HTMLButtonElement>('open-plugin-hub-top'),
  pluginHubBackdrop: element('plugin-hub-backdrop'),
  pluginModalClose: element<HTMLButtonElement>('plugin-modal-close'),
  pluginKpiGrid: element('plugin-kpi-grid'),
  pluginListSubtitle: element('plugin-list-subtitle'),
  pluginsList: element('plugins-list'),
  imTopBadge: element('im-top-badge'),
  openImHubTop: element<HTMLButtonElement>('open-im-hub-top'),
  imHubBackdrop: element('im-hub-backdrop'),
  imModalClose: element<HTMLButtonElement>('im-modal-close'),
  imKpiGrid: element('im-kpi-grid'),
  imWechatQrBtn: element<HTMLButtonElement>('im-wechat-qr-btn'),
  imWechatQrBox: element('im-wechat-qr-box'),
  imWechatQrTitle: element('im-wechat-qr-title'),
  imWechatQrImg: element<HTMLImageElement>('im-wechat-qr-img'),
  imWechatQrStatus: element('im-wechat-qr-status'),
  imWechatQrRefresh: element<HTMLButtonElement>('im-wechat-qr-refresh'),
  imWechatQrClose: element<HTMLButtonElement>('im-wechat-qr-close'),
  imAddDetails: element<HTMLDetailsElement>('im-add-details'),
  imFormSummary: element('im-form-summary'),
  imPlatformInput: element<HTMLSelectElement>('im-platform-input'),
  imNameInput: element<HTMLInputElement>('im-name-input'),
  imWebhookInput: element<HTMLInputElement>('im-webhook-input'),
  imTokenInput: element<HTMLInputElement>('im-token-input'),
  imSecretInput: element<HTMLInputElement>('im-secret-input'),
  imTargetInput: element<HTMLInputElement>('im-target-input'),
  imAllowInput: element<HTMLInputElement>('im-allow-input'),
  imCancelEditBtn: element<HTMLButtonElement>('im-cancel-edit-btn'),
  imSaveBtn: element<HTMLButtonElement>('im-save-btn'),
  imListSubtitle: element('im-list-subtitle'),
  imList: element('im-list'),
  modelTopBadge: element('model-top-badge'),
  modelCurrentStatus: element('model-current-status'),
  openModelHubTop: element<HTMLButtonElement>('open-model-hub-top'),
  modelProvidersList: element('model-providers-list'),
  modelHubBackdrop: element('model-hub-backdrop'),
  modelHubModal: element('model-hub-modal'),
  modelModalClose: element<HTMLButtonElement>('model-modal-close'),
  modalProviderTabs: element('modal-provider-tabs'),
  modalAuthProviderTitle: element('modal-auth-provider-title'),
  modalAuthStatusBadge: element('modal-auth-status-badge'),
  modalAuthToggleBtn: element<HTMLButtonElement>('modal-auth-toggle-btn'),
  modalAuthKeyInput: element<HTMLInputElement>('modal-auth-key-input'),
  modalAuthBaseurlInput: element<HTMLInputElement>('modal-auth-baseurl-input'),
  modalAuthCustomModelsInput: element<HTMLInputElement>('modal-auth-custom-models-input'),
  modalAuthModelSource: element('modal-auth-model-source'),
  modalAuthTestModelSelect: element<HTMLSelectElement>('modal-auth-test-model-select'),
  modalAuthFetchBtn: element<HTMLButtonElement>('modal-auth-fetch-btn'),
  modalAuthTestBtn: element<HTMLButtonElement>('modal-auth-test-btn'),
  modalAuthSaveTestBtn: element<HTMLButtonElement>('modal-auth-save-test-btn'),
  modalAuthClearBtn: element<HTMLButtonElement>('modal-auth-clear-btn'),
  modalAuthProbeResult: element('modal-auth-probe-result'),
  modalCustomProviderDetails: element<HTMLDetailsElement>('modal-custom-provider-details'),
  customProvIdInput: element<HTMLInputElement>('custom-prov-id-input'),
  customProvNameInput: element<HTMLInputElement>('custom-prov-name-input'),
  customProvUrlInput: element<HTMLInputElement>('custom-prov-url-input'),
  customProvKeyInput: element<HTMLInputElement>('custom-prov-key-input'),
  customProvModelsInput: element<HTMLInputElement>('custom-prov-models-input'),
  customProvSaveBtn: element<HTMLButtonElement>('custom-prov-save-btn'),
  modalSaveRoutingBtn: element<HTMLButtonElement>('modal-save-routing-btn'),
  modalRouterProviderSelect: element<HTMLSelectElement>('modal-router-provider-select'),
  modalRouterModelSelect: element<HTMLSelectElement>('modal-router-model-select'),
  modalTestRouterBtn: element<HTMLButtonElement>('modal-test-router-btn'),
  modalRouterProbeResult: element('modal-router-probe-result'),
  modelPoolSubtitle: element('model-pool-subtitle'),
  modelPoolMatrix: element('model-pool-matrix'),
};
const statusNames: Record<string, string> = {
  queued: '排队中', processing: '处理中', streaming: '回复中', completed: '已完成', interrupted: '已中断',
  failed: '失败', running: '运行中', started: '已开始', requested: '已请求', succeeded: '成功',
  paused: '已暂停', cancelled: '已取消', stopped: '已停止', stopping: '正在请求停止',
  stop_requested: '已请求停止', cancel_requested: '已请求取消', unknown: '结果未知',
  waiting_decision: '等待老板拍板', decision_received: '已获老板拍板',
  linked: '已关联', ready: '就绪', degraded: '服务降级', pending: '处理中', accepted: '已受理',
  followup: '收到补充要求', followup_failed: '补充要求未处理',
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
let traceHasEarlier = false;
let traceBusy = false;
let traceAgain = false;
/** `steps` is the readable process; `graph` and `events` stay available as raw diagnostics. */
let traceMode: 'steps' | 'graph' | 'events' = 'steps';
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
  renderMemories();
  renderTimers();
  renderPlugins();
  renderImChannels();
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
    speaker.append(node('span', message.role === 'user' ? '你' : systemNotice ? '系统 · 工作状态（非模型回复）' : 'F.R.I.D.A.Y.'));
    speaker.append(node('span', message.role === 'user' && message.status === 'completed' ? 'F.R.I.D.A.Y. 已处理' : statusText(message.status), active(message.status) ? 'running' : ''));
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
  if (!contents.childNodes.length) contents.append(node('p', '从这里开始。直接描述目标，F.R.I.D.A.Y. 会在同一个对话中持续回复。', 'empty'));
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
  if (action.searchQuery) row.append(node('p', `检索线索：${action.searchQuery}`, 'meta'));
  if (action.memoryIds?.length) row.append(node('p', `关联全局记忆：${action.memoryIds.length} 条`, 'meta'));
  if (action.workerProfile || action.modelTier || action.workerModel) {
    const tierName = action.modelTier ? ({ fast: '极速档', balanced: '均衡档', strong: '强力档' }[action.modelTier] ?? action.modelTier) : undefined;
    row.append(node('p', `执行子 AI：${[action.workerProfile, tierName, action.workerModel].filter(Boolean).join(' · ')}`, 'meta'));
  }
  if (action.summary) row.append(node('p', `F.R.I.D.A.Y. 公开说明：${action.summary}`, 'meta'));
  if (action.error) row.append(node('p', action.error, 'error'));
  return row;
}
function routingSummary(message: ChatMessage): HTMLElement {
  const area = node('div', '', 'routing-summary');
  if (!message.routing) {
    area.append(node('p', active(message.status) ? '等待 F.R.I.D.A.Y. 处理并记录分配结果…' : '此历史消息未采集路由摘要；不从回复正文猜测。', 'meta'));
    return area;
  }
  for (const action of message.routing.actions) area.append(actionRow(action));
  if (!message.routing.actions.length) area.append(node('p', message.routing.status === 'processing' ? 'F.R.I.D.A.Y. 正在处理，尚无已受理动作。' : '本次路由未确认完成，没有可确认的分配动作。', 'meta'));
  if (message.routing.omittedActions) area.append(node('p', '动作较多，摘要只展示最近 40 条；完整动作记录请在事件时间线查看。', 'meta'));
  if (message.routing.status === 'failed' || message.routing.status === 'interrupted') area.append(node('p', 'F.R.I.D.A.Y. 处理未完成；已受理的动作保留，不代表已撤销。', 'meta'));
  return area;
}
let routingDetailRequest = 0;
function renderRoutingDetail() {
  ui.routingDetail.hidden = selection.type !== 'message';
  if (selection.type !== 'message') return;
  const message = messages.get(selection.id);
  if (!message) {
    // A message outside the loaded page still has a recorded routing decision; read it instead of claiming none.
    const request = ++routingDetailRequest;
    const generation = selectionGeneration;
    const id = selection.id;
    ui.routingDetail.replaceChildren(node('p', '正在读取该消息的路由记录…', 'meta'));
    void api<ChatMessage>(`/api/message?${new URLSearchParams({ messageId: id })}`).then(fetched => {
      if (request !== routingDetailRequest || generation !== selectionGeneration) return;
      mergeMessages([fetched]);
      renderMessages();
    }).catch(error => {
      if (request === routingDetailRequest) ui.routingDetail.replaceChildren(node('p', `读取路由记录失败：${errorText(error)}`, 'error'));
    });
    return;
  }
  const previous = ui.routingDetail.querySelector<HTMLDetailsElement>('details.routing-facts');
  const factsOpen = previous?.open ?? false;
  const referencesOpen = previous?.querySelector<HTMLDetailsElement>('details.references')?.open ?? false;
  ui.routingDetail.replaceChildren();
  if (!message?.routing) {
    ui.routingDetail.append(node('p', '此消息尚无已记录的路由上下文。旧历史不会补造。', 'meta')); return;
  }
  const routing = message.routing;
  // The readable process leads; the recorded routing context stays available without crowding it.
  const summary = routing.actions.length
    ? routing.actions.map(action => `${routeLabel(action)}${action.taskLabel ? ` · ${action.taskLabel}` : ''}`).join('；')
    : routing.status === 'processing' ? 'F.R.I.D.A.Y. 正在处理' : '没有已确认的分配动作';
  const wrap = node('details', '', 'routing-facts');
  wrap.open = factsOpen;
  const target = node('div', '', 'routing-facts-body');
  wrap.append(node('summary', `分配记录与当时上下文：${summary}`), target);
  ui.routingDetail.append(wrap);
  target.append(node('p', `路由处理时：${timestamp(routing.at)} · ${statusText(routing.status)}`, 'meta'));
  target.append(node('h4', '当时可见的工作'));
  for (const work of routing.context.works) {
    const row = node('div', '', 'routing-work');
    row.append(button(work.prompt || '后台工作', () => { selectTrace({ type: 'task', id: work.id, label: work.prompt }); showPanel(true); }, 'source-reference'),
      node('span', `当时${statusText(work.status)}`, 'meta'));
    target.append(row);
  }
  if (!routing.context.works.length) target.append(node('p', '当时没有后台工作。', 'meta'));
  if (routing.context.truncated) target.append(node('p', `当时共 ${routing.context.totalWorks} 项工作，F.R.I.D.A.Y. 仅收到最近 ${routing.context.works.length} 项摘要。`, 'meta'));
  target.append(node('p', '以上是处理当时的状态，不随当前工作状态改写。', 'meta'), node('h4', '已记录动作'));
  for (const action of routing.actions) {
    target.append(actionRow(action));
    for (const [index, id] of (action.messageIds ?? []).entries()) target.append(button(
      `召回引用 ${index + 1}：${messages.get(id)?.text.slice(0, 60) ?? '读取原消息'}`, () => { void jumpMessage(id); }, 'source-reference'));
  }
  if (routing.omittedActions) target.append(node('p', '摘要只展示最近 40 条动作；完整动作记录请查看原始事件。', 'meta'));
  if (!routing.actions.length) target.append(node('p', '尚无已确认的路由动作。', 'meta'));
  const refs = node('details', '', 'references'); refs.open = referencesOpen; refs.append(node('summary', '当时的近期对话引用'));
  for (const reference of routing.context.messages) refs.append(button(`${reference.role === 'user' ? '你' : 'F.R.I.D.A.Y.'}：${reference.preview || '无公开文本'}`, () => { void jumpMessage(reference.id); }, 'source-reference'));
  if (routing.context.autoRecalled?.length) {
    target.append(node('h4', `潜意识记忆闪回（自动关联 ${routing.context.autoRecalled.length} 条）`));
    for (const hit of routing.context.autoRecalled) {
      const row = node('div', '', 'routing-work');
      const kindLabel = hit.kind === 'memory' ? '记忆神经元' : hit.kind === 'work' ? '历史工作' : '历史消息';
      const viaSuffix = hit.activatedVia
        ? ` · ⚡经由「${hit.activatedVia.topic}」突触扩散 (${Math.round(hit.activatedVia.weight * 100)}%)`
        : '';
      if (hit.kind === 'message' && hit.messageId) {
        row.append(button(`[${kindLabel}] ${hit.title}：${hit.snippet.slice(0, 60)}`, () => { void jumpMessage(hit.messageId!); }, 'source-reference'));
      } else if (hit.kind === 'work' && hit.taskId) {
        row.append(button(`[${kindLabel}] ${hit.title}：${hit.snippet.slice(0, 60)}`, () => { selectTrace({ type: 'task', id: hit.taskId!, label: hit.title }); showPanel(true); }, 'source-reference'));
      } else {
        row.append(node('span', `[${kindLabel}] ${hit.title}${viaSuffix}：${hit.snippet.slice(0, 80)}`, 'meta'));
      }
      target.append(row);
    }
  }
  if (routing.context.memoryDirectory) {
    target.append(node('p', `全局记忆目录：当时共有 ${routing.context.memoryDirectory.totalActive} 条活跃记忆卡片`, 'meta'));
  }
  target.append(refs, node('p', `执行环境：${routing.context.execution} · ${routing.context.cwd}`, 'meta'));
}
const profileBadges: Record<string, string> = { coding: '编码 AI', research: '调研 AI', review: '审查 AI', general: '通用 AI' };
const tierBadges: Record<string, string> = { fast: '⚡极速', balanced: '⚖️均衡', strong: '🧠强力' };
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
    const tierLabel = work.modelTier ? `${tierBadges[work.modelTier] ?? work.modelTier}${work.workerModel ? `·${work.workerModel}` : ''}` : work.workerModel;
    const profilePrefix = (work.profile || tierLabel)
      ? `${profileBadges[work.profile ?? 'general'] ?? (work.profile || '子 AI')}${tierLabel ? ` (${tierLabel})` : ''} · `
      : '';
    const statusLabel = work.pendingQuestion ? '⏳ 等待拍板' : statusText(work.status);
    entry.append(node('span', `${profilePrefix}${statusLabel} · ${timestamp(work.createdAt)}`, `meta${active(work.status) ? ' running' : ''}`));
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
const synapseRelationNames: Record<string, string> = {
  explicit: '显式关联',
  co_activated: '共现强化',
  shared_tag: '标签共振',
  task_chain: '任务同源',
};
function kpiCard(label: string, value: string, sub = '', tone: 'default' | 'accent' | 'positive' | 'warning' = 'default'): HTMLElement {
  const card = node('div', '', `hub-kpi-card tone-${tone}`);
  card.append(
    node('span', label, 'hub-kpi-label'),
    node('strong', value, 'hub-kpi-value'),
  );
  if (sub) card.append(node('span', sub, 'hub-kpi-sub meta'));
  return card;
}
function formatIntervalText(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec % 3600 === 0) return `每 ${sec / 3600} 小时 (${sec}s)`;
  if (sec % 60 === 0) return `每 ${sec / 60} 分钟 (${sec}s)`;
  return `每 ${sec} 秒`;
}
function closeAllHubModals() {
  ui.memoryHubBackdrop.hidden = true;
  ui.timerHubBackdrop.hidden = true;
  ui.pluginHubBackdrop.hidden = true;
  ui.imHubBackdrop.hidden = true;
  ui.modelHubBackdrop.hidden = true;
  stopWechatQrPoll();
}

let fullMemoriesCache: MemoryCard[] | undefined;
let memoryFilterMode: 'all' | 'pinned' | 'synapse' = 'all';
let editingMemoryId: string | undefined;

async function fetchFullMemories() {
  if (!ready || authExpired) return;
  try {
    const list = await api<MemoryCard[]>('/api/memories');
    if (Array.isArray(list)) {
      fullMemoriesCache = list;
      renderMemories();
    }
  } catch {
    /* fallback to view.memoryDirectory */
  }
}

function openMemoryHubModal() {
  closeAllHubModals();
  renderMemories();
  ui.memoryHubBackdrop.hidden = false;
  void fetchFullMemories();
}
function closeMemoryHubModal() {
  ui.memoryHubBackdrop.hidden = true;
}
function setMemoryFilter(mode: 'all' | 'pinned' | 'synapse') {
  memoryFilterMode = mode;
  for (const [key, btn] of [
    ['all', ui.memoryFilterAll],
    ['pinned', ui.memoryFilterPinned],
    ['synapse', ui.memoryFilterSynapse],
  ] as const) {
    btn.classList.toggle('active', key === mode);
  }
  renderMemories();
}
function editMemoryFromUi(item: { id: string; topic: string; content?: string; preview?: string; tags: string[]; pinned?: boolean }) {
  editingMemoryId = item.id;
  ui.memoryTopicInput.value = item.topic;
  ui.memoryTagsInput.value = item.tags.join(', ');
  ui.memoryContentInput.value = item.content ?? item.preview ?? '';
  ui.memoryPinnedInput.checked = Boolean(item.pinned);
  ui.memoryCancelEditBtn.hidden = false;
  ui.memorySaveBtn.textContent = '💾 更新记忆神经元';
  ui.memoryAddDetails.open = true;
  ui.memoryTopicInput.focus();
}
function resetMemoryForm() {
  editingMemoryId = undefined;
  ui.memoryTopicInput.value = '';
  ui.memoryTagsInput.value = '';
  ui.memoryContentInput.value = '';
  ui.memoryPinnedInput.checked = false;
  ui.memoryCancelEditBtn.hidden = true;
  ui.memorySaveBtn.textContent = '💾 刻印到全息记忆';
}
function renderMemories() {
  const directory = view?.memoryDirectory;
  const baseItems = fullMemoriesCache ?? directory?.items ?? [];
  const total = directory?.totalActive ?? baseItems.length;
  ui.memoryTopBadge.textContent = String(total);

  const pinnedCount = baseItems.filter(i => i.pinned).length;
  const synapseCount = baseItems.reduce((sum, i) => sum + (i.synapses?.length ?? 0), 0);
  const accessCountTotal = baseItems.reduce((sum, i) => sum + (i.accessCount ?? 0), 0);

  const kpiFrag = document.createDocumentFragment();
  kpiFrag.append(
    kpiCard('记忆总数', `${total}`, '', total > 0 ? 'accent' : 'default'),
    kpiCard('★ 置顶记忆', `${pinnedCount}`, '', pinnedCount > 0 ? 'positive' : 'default'),
    kpiCard('⚡ 突触连接', `${synapseCount}`, '', synapseCount > 0 ? 'accent' : 'default'),
    kpiCard('🔥 累计提取', `${accessCountTotal}`, '', 'default'),
  );
  ui.memoryKpiGrid.replaceChildren(kpiFrag);

  const filtered = baseItems.filter(item => {
    if (memoryFilterMode === 'pinned') return Boolean(item.pinned);
    if (memoryFilterMode === 'synapse') return Boolean(item.synapses?.length);
    return true;
  });
  ui.memoryListSubtitle.textContent = `${filtered.length} / ${baseItems.length}`;

  const contents = document.createDocumentFragment();
  for (const item of filtered) {
    const bodyText = 'content' in item ? item.content : item.preview;
    const card = node('article', '', `hub-entity-card memory-card${item.pinned ? ' is-pinned' : ''}`);

    const head = node('div', '', 'hub-card-head');
    const titleWrap = node('div', '', 'hub-card-title-group');
    if (item.pinned) titleWrap.append(node('span', '★ 置顶', 'hub-badge badge-amber'));
    titleWrap.append(node('strong', item.topic, 'hub-card-title'));
    head.append(titleWrap);

    const actions = node('div', '', 'timer-actions');
    const pinBtn = button(item.pinned ? '取消置顶' : '★ 置顶', () => { void pinMemoryFromUi(item.id, !item.pinned); }, 'mini-button');
    const editBtn = button('✏️ 编辑', () => { editMemoryFromUi(item); }, 'mini-button');
    const forgetBtn = button('🗑️ 遗忘', () => { void removeMemoryFromUi(item.id); }, 'mini-button danger-btn');
    pinBtn.disabled = authExpired || !ready;
    editBtn.disabled = authExpired || !ready;
    forgetBtn.disabled = authExpired || !ready;
    actions.append(pinBtn, editBtn, forgetBtn);
    head.append(actions);
    card.append(head);

    card.append(node('div', bodyText, 'hub-card-body-text'));

    const badgesRow = node('div', '', 'hub-badges-row');
    for (const tag of item.tags) {
      badgesRow.append(node('span', `#${tag}`, 'hub-tag-chip'));
    }
    if (item.accessCount) {
      badgesRow.append(node('span', `🔥 强化提取 ${item.accessCount} 次`, 'hub-meta-chip'));
    }
    if (item.cwd) {
      badgesRow.append(node('span', `📁 ${item.cwd}`, 'hub-meta-chip mono-chip'));
    }
    badgesRow.append(node('span', `🕒 更新于 ${timestamp(item.updatedAt)}`, 'hub-meta-chip'));
    card.append(badgesRow);

    if (item.synapses?.length) {
      const synBox = node('div', '', 'hub-synapse-box');
      synBox.append(node('span', `⚡ 突触连接 (${item.synapses.length})：`, 'hub-synapse-label'));
      for (const syn of item.synapses.slice(0, 6)) {
        const targetTitle = syn.targetTopic ?? fullMemoriesCache?.find(m => m.id === syn.targetId)?.topic ?? syn.targetId.slice(0, 8);
        const relText = synapseRelationNames[syn.relation] ?? syn.relation;
        const chip = button(
          `🔗 ${targetTitle} · ${Math.round(syn.weight * 100)}% (${relText})`,
          () => {
            ui.memorySearchInput.value = targetTitle;
            void searchMemories();
          },
          'hub-synapse-chip',
        );
        synBox.append(chip);
      }
      card.append(synBox);
    }

    contents.append(card);
  }
  if (!filtered.length) {
    const emptyMsg = view
      ? (memoryFilterMode === 'all' ? '暂无记忆' : '无匹配记忆')
      : '未连接';
    contents.append(node('p', emptyMsg, 'empty hub-empty-state'));
  }
  ui.memoriesList.replaceChildren(contents);
}
async function searchMemories() {
  const query = ui.memorySearchInput.value.trim();
  const scope = ui.memorySearchScope.value || 'all';
  if (!query) {
    ui.memorySearchResults.hidden = true;
    ui.memorySearchResults.replaceChildren();
    return;
  }
  ui.memorySearchResults.hidden = false;
  ui.memorySearchResults.replaceChildren(node('p', '⏳ 正在执行全息图谱检索与 1-Hop 突触扩散激活…', 'meta'));
  try {
    const res = await api<{ hits?: ContextSearchHit[] } | ContextSearchHit[]>(`/api/memories?${new URLSearchParams({ query, scope })}`);
    const hits = Array.isArray(res) ? res : (res.hits ?? []);
    const frag = document.createDocumentFragment();
    const header = node('div', '', 'hub-card-head');
    header.append(
      node('strong', `🔍 联想检索命中 ${hits.length} 条结果`, 'hub-card-title'),
      button('✕ 清空检索', () => {
        ui.memorySearchInput.value = '';
        ui.memorySearchResults.hidden = true;
        ui.memorySearchResults.replaceChildren();
      }, 'mini-button'),
    );
    frag.append(header);
    const listWrap = node('div', '', 'hub-search-hits-grid');
    for (const hit of hits) {
      const row = node('div', '', 'hub-entity-card search-hit-card');
      const hitHead = node('div', '', 'hub-card-head');
      const kindBadge = hit.kind === 'memory'
        ? node('span', '🧠 记忆神经元', 'hub-badge badge-teal')
        : hit.kind === 'work'
          ? node('span', '🔧 历史工作', 'hub-badge badge-blue')
          : node('span', '💬 历史对话', 'hub-badge badge-slate');
      const titleGroup = node('div', '', 'hub-card-title-group');
      titleGroup.append(kindBadge, node('strong', hit.title, 'hub-card-title'));
      hitHead.append(titleGroup);

      if (hit.kind === 'message' && hit.messageId) {
        hitHead.append(button('↗ 定位到此对话', () => {
          closeAllHubModals();
          closeSidebar();
          void jumpMessage(hit.messageId!);
        }, 'mini-button'));
      } else if (hit.kind === 'work' && hit.taskId) {
        hitHead.append(button('↗ 查看执行轨迹', () => {
          closeAllHubModals();
          closeSidebar();
          selectTrace({ type: 'task', id: hit.taskId!, label: hit.title });
          showPanel(true);
        }, 'mini-button'));
      }
      row.append(hitHead);
      row.append(node('p', hit.snippet, 'hub-card-body-text'));
      if (hit.activatedVia) {
        const relLabel = synapseRelationNames[hit.activatedVia.relation] ?? hit.activatedVia.relation;
        row.append(node('div', `⚡ 经由神经元「${hit.activatedVia.topic}」突触扩散激活（连接权重 ${Math.round(hit.activatedVia.weight * 100)}% · ${relLabel}）`, 'hub-synapse-banner'));
      }
      listWrap.append(row);
    }
    if (!hits.length) listWrap.append(node('p', '未找到匹配的记忆、工作或对话。', 'empty hub-empty-state'));
    frag.append(listWrap);
    ui.memorySearchResults.replaceChildren(frag);
  } catch (error) {
    ui.memorySearchResults.replaceChildren(node('p', `搜索失败：${errorText(error)}`, 'error'));
  }
}
async function saveMemoryFromUi() {
  const topic = ui.memoryTopicInput.value.trim();
  const content = ui.memoryContentInput.value.trim();
  const tags = ui.memoryTagsInput.value.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean);
  const pinned = ui.memoryPinnedInput.checked;
  if (!topic || !content) return;
  ui.memorySaveBtn.disabled = true;
  try {
    await api<MemoryCard>('/api/memory-save', {
      ...(editingMemoryId ? { id: editingMemoryId } : {}),
      topic,
      content,
      ...(tags.length ? { tags } : {}),
      pinned,
    });
    resetMemoryForm();
    ui.memoryAddDetails.open = false;
    await refreshView();
    await fetchFullMemories();
  } catch (error) {
    connection(`保存记忆失败：${errorText(error)}`, true);
  } finally {
    ui.memorySaveBtn.disabled = false;
  }
}
async function pinMemoryFromUi(id: string, pinned: boolean) {
  try {
    await api<MemoryCard>('/api/memory-pin', { id, pinned });
    await refreshView();
    await fetchFullMemories();
  } catch (error) {
    connection(`置顶记忆失败：${errorText(error)}`, true);
  }
}
async function removeMemoryFromUi(id: string) {
  try {
    await api<unknown>('/api/memory-remove', { id });
    await refreshView();
    await fetchFullMemories();
  } catch (error) {
    connection(`移除记忆失败：${errorText(error)}`, true);
  }
}

function openTimerHubModal() {
  closeAllHubModals();
  renderTimers();
  ui.timerHubBackdrop.hidden = false;
}
function closeTimerHubModal() {
  ui.timerHubBackdrop.hidden = true;
}
function renderTimers() {
  const timers = view?.timers ?? [];
  const activeCount = timers.filter(t => t.enabled).length;
  const pausedCount = timers.length - activeCount;
  const missedTotal = timers.reduce((sum, t) => sum + (t.missedRuns ?? 0), 0);
  const badgeText = timers.length ? `${activeCount}/${timers.length}` : '0';
  ui.timerTopBadge.textContent = badgeText;

  const kpiFrag = document.createDocumentFragment();
  kpiFrag.append(
    kpiCard('运行中', `${activeCount}`, '', activeCount > 0 ? 'positive' : 'default'),
    kpiCard('已暂停', `${pausedCount}`, '', 'default'),
    kpiCard('漏跑补偿', `${missedTotal}`, '', missedTotal > 0 ? 'warning' : 'default'),
  );
  ui.timerKpiGrid.replaceChildren(kpiFrag);
  ui.timerListSubtitle.textContent = timers.length ? `${activeCount} / ${timers.length} 运行中` : '';

  const contents = document.createDocumentFragment();
  for (const timer of timers) {
    const card = node('article', '', `hub-entity-card timer-card${timer.enabled ? ' is-active' : ' is-paused'}`);
    const head = node('div', '', 'hub-card-head');
    const titleGroup = node('div', '', 'hub-card-title-group');
    const scheduleText = timer.once
      ? (timer.dailyAt ? `⚡ 单次 ${timer.dailyAt}` : `⚡ 单次 ${formatIntervalText(timer.intervalMs)}`)
      : (timer.dailyAt ? `⏰ 每日 ${timer.dailyAt}` : `🔄 ${formatIntervalText(timer.intervalMs)}`);
    titleGroup.append(
      node('span', timer.enabled ? '● 运行中' : (timer.once && timer.lastRunAt ? '✓ 已完成' : '⏸ 已暂停'), `hub-badge ${timer.enabled ? 'badge-green' : 'badge-slate'}`),
      node('strong', timer.name, 'hub-card-title'),
      node('span', scheduleText, 'hub-badge badge-teal'),
    );
    if (timer.plugin) {
      titleGroup.append(node('span', `🔌 ${timer.plugin}/${timer.pluginAction ?? 'status'}`, 'hub-badge badge-purple'));
    }
    if (timer.deliverChannelId) {
      titleGroup.append(node('span', `📨 投递: ${timer.deliverChannelId}${timer.deliverTarget ? `→${timer.deliverTarget}` : ''}`, 'hub-badge badge-blue'));
    }
    head.append(titleGroup);

    const actions = node('div', '', 'timer-actions');
    if (timer.plugin) {
      actions.append(button('📄 插件代码与参数', () => {
        openPluginHubModal(timer.plugin, true);
      }, 'mini-button'));
    }
    if (timer.activeTaskId) {
      actions.append(button('⚡ 查看执行中工作', () => {
        closeAllHubModals();
        closeSidebar();
        selectTrace({ type: 'task', id: timer.activeTaskId!, label: timer.name });
        showPanel(true);
      }, 'mini-button'));
    }
    const toggleBtn = button(timer.enabled ? '⏸ 暂停' : '▶️ 启用', () => { void toggleTimerFromUi(timer.id, !timer.enabled); }, 'mini-button');
    const delBtn = button('🗑️ 删除', () => { void removeTimerFromUi(timer.id); }, 'mini-button danger-btn');
    toggleBtn.disabled = authExpired || !ready;
    delBtn.disabled = authExpired || !ready;
    actions.append(toggleBtn, delBtn);
    head.append(actions);
    card.append(head);

    card.append(node('div', timer.instruction, 'hub-code-block'));
    if (timer.plugin) {
      const boundPlugin = (view?.plugins ?? []).find(p => p.name === timer.plugin);
      const act = timer.pluginAction ?? 'status';
      const entry = boundPlugin?.entryPath ?? `plugins/${timer.plugin}/index.mjs`;
      const runtimeArgs = JSON.stringify({
        timerId: timer.id,
        timerName: timer.name,
        instruction: timer.instruction,
      });
      const execBox = node('div', '', 'hub-code-block');
      execBox.append(
        node('div', `⚙️ 执行命令: node ${entry} ${act} '${runtimeArgs}'`, 'meta'),
        node('div', `🔧 注入环境变量: SUPER_AGENT_HOME · SUPER_AGENT_PLUGIN_DATA_DIR=${boundPlugin?.dataDir ?? `~/.super-agent/plugins/${timer.plugin}`}`, 'meta'),
      );
      card.append(execBox);
    }

    const badgesRow = node('div', '', 'hub-badges-row');
    badgesRow.append(node('span', `⏭ 下次触发：${timer.enabled ? timestamp(timer.nextRunAt) : '已暂停'}`, 'hub-meta-chip'));
    badgesRow.append(node('span', `⏮ 上次触发：${timer.lastRunAt ? timestamp(timer.lastRunAt) : '尚未触发'}`, 'hub-meta-chip'));
    if (timer.cwd) badgesRow.append(node('span', `📁 ${timer.cwd}`, 'hub-meta-chip mono-chip'));
    if (timer.missedRuns > 0) badgesRow.append(node('span', `⚠️ 曾漏跑补偿 ${timer.missedRuns} 次`, 'hub-badge badge-amber'));
    card.append(badgesRow);

    contents.append(card);
  }
  if (!timers.length) {
    contents.append(node('p', '暂无定时任务', 'empty hub-empty-state'));
  }
  ui.timersList.replaceChildren(contents);
}
async function addTimerFromUi() {
  const name = ui.timerNameInput.value.trim();
  const dailyAt = ui.timerDailyInput.value.trim() || undefined;
  const intervalSeconds = Number(ui.timerIntervalInput.value);
  const pluginSpec = ui.timerPluginInput.value.trim();
  const [plugin, pluginAction] = pluginSpec ? pluginSpec.split('/').map(s => s.trim()) : [undefined, undefined];
  const deliverChannelId = ui.timerChannelInput.value.trim() || undefined;
  const instruction = ui.timerInstructionInput.value.trim();
  if (!name || (!instruction && !plugin) || (!dailyAt && (!Number.isFinite(intervalSeconds) || intervalSeconds < 5))) return;
  ui.timerSaveBtn.disabled = true;
  try {
    await api<TimerView>('/api/timer-add', {
      name,
      intervalMs: Math.round((Number.isFinite(intervalSeconds) && intervalSeconds >= 5 ? intervalSeconds : 60) * 1000),
      ...(dailyAt ? { dailyAt } : {}),
      ...(plugin ? { plugin } : {}),
      ...(pluginAction ? { pluginAction } : {}),
      ...(deliverChannelId ? { deliverChannelId } : {}),
      instruction: instruction || `执行插件 ${plugin}/${pluginAction ?? 'status'}`,
    });
    ui.timerNameInput.value = '';
    ui.timerDailyInput.value = '';
    ui.timerPluginInput.value = '';
    ui.timerChannelInput.value = '';
    ui.timerInstructionInput.value = '';
    await refreshView();
  } catch (error) {
    connection(`创建定时器失败：${errorText(error)}`, true);
  } finally {
    ui.timerSaveBtn.disabled = false;
  }
}
async function toggleTimerFromUi(id: string, enabled: boolean) {
  try {
    await api<unknown>('/api/timer-toggle', { id, enabled });
    await refreshView();
  } catch (error) {
    connection(`切换定时器失败：${errorText(error)}`, true);
  }
}
async function removeTimerFromUi(id: string) {
  try {
    await api<unknown>('/api/timer-remove', { id });
    await refreshView();
  } catch (error) {
    connection(`删除定时器失败：${errorText(error)}`, true);
  }
}

let focusedPluginName: string | undefined;
let expandFocusedPluginSource = false;

function openPluginHubModal(pluginName?: string, expandSource = false) {
  closeAllHubModals();
  focusedPluginName = pluginName;
  expandFocusedPluginSource = expandSource;
  renderPlugins();
  ui.pluginHubBackdrop.hidden = false;
}
function closePluginHubModal() {
  ui.pluginHubBackdrop.hidden = true;
}
function renderPlugins() {
  const plugins: PluginView[] = view?.plugins ?? [];
  const timers = view?.timers ?? [];
  const totalActions = plugins.reduce((sum, p) => sum + (p.actions?.length ?? 0), 0);
  const boundTimersCount = timers.filter(t => Boolean(t.plugin)).length;
  ui.pluginTopBadge.textContent = String(plugins.length);

  const kpiFrag = document.createDocumentFragment();
  kpiFrag.append(
    kpiCard('已加载插件', `${plugins.length}`, '', plugins.length > 0 ? 'positive' : 'default'),
    kpiCard('可执行动作 (Actions)', `${totalActions}`, '', totalActions > 0 ? 'accent' : 'default'),
    kpiCard('绑定定时任务', `${boundTimersCount}`, '', boundTimersCount > 0 ? 'positive' : 'default'),
  );
  ui.pluginKpiGrid.replaceChildren(kpiFrag);
  ui.pluginListSubtitle.textContent = plugins.length ? `共 ${plugins.length} 个脚本插件` : '暂无插件';

  const contents = document.createDocumentFragment();
  for (const plugin of plugins) {
    const isFocused = focusedPluginName === plugin.name;
    const card = node('article', '', `hub-entity-card plugin-card${isFocused ? ' is-active' : ''}`);
    card.dataset.pluginName = plugin.name;

    const head = node('div', '', 'hub-card-head');
    const titleGroup = node('div', '', 'hub-card-title-group');
    titleGroup.append(
      node('span', '🔌 Node 脚本插件', 'hub-badge badge-purple'),
      node('strong', `${plugin.title} (${plugin.name})`, 'hub-card-title'),
      node('span', `${plugin.actions.length} 个动作`, 'hub-badge badge-teal'),
    );
    head.append(titleGroup);
    card.append(head);

    card.append(node('p', plugin.description, 'hub-card-body-text'));

    // Execution paths & environment info
    const pathBox = node('div', '', 'hub-code-block');
    pathBox.append(
      node('div', `📄 执行脚本入口: ${plugin.entryPath}`, 'meta'),
      node('div', `💾 专属数据目录 (SUPER_AGENT_PLUGIN_DATA_DIR): ${plugin.dataDir}`, 'meta'),
    );
    card.append(pathBox);

    // Bound timers summary
    const boundTimers = timers.filter(t => t.plugin === plugin.name);
    if (boundTimers.length) {
      const timerRow = node('div', '', 'hub-badges-row');
      timerRow.append(node('span', `⏰ 关联定时任务 (${boundTimers.length})：`, 'hub-meta-chip'));
      for (const bt of boundTimers) {
        timerRow.append(node(
          'span',
          `${bt.name} · ${bt.dailyAt ? `每日 ${bt.dailyAt}` : formatIntervalText(bt.intervalMs)} · action=${bt.pluginAction ?? 'status'}${bt.deliverChannelId ? ` → ${bt.deliverChannelId}` : ''}`,
          `hub-badge ${bt.enabled ? 'badge-green' : 'badge-slate'}`,
        ));
      }
      card.append(timerRow);
    }

    // Action & Parameter Specs section + Interactive Test Runner
    const specs: PluginActionSpec[] = plugin.actionSpecs?.length
      ? plugin.actionSpecs
      : plugin.actions.map(a => ({ name: a }));

    const runnerWrap = node('div', '', 'hub-form-card');
    runnerWrap.append(node('strong', '⚙️ 动作参数规范 (Action Specs) 与在线调试执行', 'hub-card-title'));

    const actionSelect = node('select', '', 'hub-input') as HTMLSelectElement;
    for (const spec of specs) {
      const opt = node('option', `${spec.name}${spec.label ? ` — ${spec.label}` : ''}`);
      opt.value = spec.name;
      actionSelect.append(opt);
    }

    const argsInput = node('input', '', 'hub-input mono-input') as HTMLInputElement;
    argsInput.type = 'text';
    argsInput.placeholder = '执行参数 JSON，例如 {} 或 {"code":"018168","cost":720}';

    const cmdPreview = node('div', '', 'hub-code-block meta');
    const syncCmdPreview = () => {
      const act = actionSelect.value || 'status';
      const rawArgs = argsInput.value.trim() || '{}';
      cmdPreview.textContent = `$ node ${plugin.entryPath} ${act} '${rawArgs}'`;
    };

    const selectSpec = (specName: string) => {
      actionSelect.value = specName;
      const matched = specs.find(s => s.name === specName);
      argsInput.value = JSON.stringify(matched?.defaultArgs ?? {});
      syncCmdPreview();
    };

    // Spec table / chips
    const specsList = node('div', '', 'hub-search-hits-grid');
    for (const spec of specs) {
      const specCard = node('div', '', 'hub-code-block');
      const specHead = node('div', '', 'hub-card-head');
      const specTitle = node('div', '', 'hub-card-title-group');
      specTitle.append(
        node('span', spec.name, 'hub-badge badge-teal'),
        node('strong', spec.label ?? spec.name),
      );
      const fillBtn = button('填入调试器', () => {
        selectSpec(spec.name);
        argsInput.focus();
      }, 'mini-button');
      specHead.append(specTitle, fillBtn);
      specCard.append(specHead);
      if (spec.description) {
        specCard.append(node('div', spec.description, 'meta'));
      }
      specCard.append(node('div', `默认/示例参数 (argv[3] JSON): ${JSON.stringify(spec.defaultArgs ?? {})}`, 'meta'));
      specsList.append(specCard);
    }
    runnerWrap.append(specsList);

    // Interactive runner controls
    const controlsRow = node('div', '', 'hub-form-grid');
    const actField = node('label', '', 'hub-field');
    actField.append(node('span', '选择执行动作 (argv[2])'), actionSelect);
    const argsField = node('label', '', 'hub-field hub-field-wide');
    argsField.append(node('span', '执行参数 JSON (argv[3])'), argsInput);
    controlsRow.append(actField, argsField);
    runnerWrap.append(controlsRow);

    actionSelect.addEventListener('change', () => selectSpec(actionSelect.value));
    argsInput.addEventListener('input', syncCmdPreview);
    selectSpec(specs[0]?.name ?? 'status');

    runnerWrap.append(cmdPreview);

    const runResultBox = node('div', '', 'hub-probe-banner');
    runResultBox.hidden = true;

    const runActionsRow = node('div', '', 'hub-form-actions');
    const runBtn = button('▶️ 立即运行该动作', () => {
      void (async () => {
        let parsedArgs: Record<string, unknown> = {};
        const raw = argsInput.value.trim();
        if (raw) {
          try {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('参数必须是 JSON 对象');
            }
            parsedArgs = parsed as Record<string, unknown>;
          } catch (err) {
            runResultBox.hidden = false;
            runResultBox.replaceChildren(node('p', `❌ 参数 JSON 解析失败：${errorText(err)}`, 'error'));
            return;
          }
        }
        runBtn.disabled = true;
        runBtn.textContent = '⏳ 正在执行脚本…';
        runResultBox.hidden = false;
        runResultBox.replaceChildren(node('p', `正在执行 node ${plugin.entryPath} ${actionSelect.value} …`, 'meta'));
        try {
          const res = await api<{
            ok: boolean;
            plugin: string;
            action: string;
            notify: boolean;
            title?: string;
            message: string;
            data?: unknown;
          }>('/api/plugin-run', {
            plugin: plugin.name,
            action: actionSelect.value,
            args: parsedArgs,
          });
          const resFrag = document.createDocumentFragment();
          resFrag.append(
            node('strong', `${res.ok ? '✅ 执行成功' : '❌ 执行返回 ok=false'} · action=${res.action} · notify=${String(res.notify)}`),
            node('pre', res.message),
          );
          if (res.data !== undefined) {
            const dataDetails = node('details');
            dataDetails.append(node('summary', '查看返回结构化数据 (result.data)'), node('pre', json(res.data)));
            resFrag.append(dataDetails);
          }
          runResultBox.replaceChildren(resFrag);
        } catch (err) {
          runResultBox.replaceChildren(node('p', `❌ 执行失败：${errorText(err)}`, 'error'));
        } finally {
          runBtn.disabled = false;
          runBtn.textContent = '▶️ 立即运行该动作';
        }
      })();
    }, 'primary-button');
    runBtn.disabled = authExpired || !ready;
    runActionsRow.append(runBtn);
    runnerWrap.append(runActionsRow, runResultBox);
    card.append(runnerWrap);

    // Source code viewer (index.mjs)
    if (plugin.sourceCode) {
      const codeDetails = node('details', '', 'hub-accordion');
      if (isFocused && expandFocusedPluginSource) codeDetails.open = true;
      const lineCount = plugin.sourceCode.split('\n').length;
      codeDetails.append(
        node('summary', `📄 查看具体执行代码 (${plugin.entry} · ${lineCount} 行 · ${plugin.entryPath})`, 'hub-accordion-summary'),
        node('pre', plugin.sourceCode, 'hub-code-block'),
      );
      card.append(codeDetails);
    }

    // Manifest viewer (plugin.json)
    if (plugin.manifestJson) {
      const manifestDetails = node('details', '', 'hub-accordion');
      manifestDetails.append(
        node('summary', '📋 查看插件清单配置 (plugin.json)', 'hub-accordion-summary'),
        node('pre', plugin.manifestJson, 'hub-code-block'),
      );
      card.append(manifestDetails);
    }

    contents.append(card);
  }
  if (!plugins.length) {
    contents.append(node('p', '当前未发现任何插件（存放于 plugins/<name>/plugin.json）', 'empty hub-empty-state'));
  }
  ui.pluginsList.replaceChildren(contents);
}
const imPlatformLabels: Record<string, string> = { dingtalk: '🟦 钉钉机器人', wechat: '💬 微信 iLink', telegram: '✈️ Telegram Bot' };
let wechatQrPollTimer: ReturnType<typeof setInterval> | undefined;
let activeWechatQrChannelId: string | undefined;
let editingImChannelId: string | undefined;

function openImHubModal() {
  closeAllHubModals();
  renderImChannels();
  ui.imHubBackdrop.hidden = false;
}
function closeImHubModal() {
  stopWechatQrPoll();
  ui.imHubBackdrop.hidden = true;
}
function stopWechatQrPoll() {
  if (wechatQrPollTimer) {
    clearInterval(wechatQrPollTimer);
    wechatQrPollTimer = undefined;
  }
}

function closeWechatQrFromUi() {
  stopWechatQrPoll();
  ui.imWechatQrBox.hidden = true;
}

async function startWechatQrFromUi(channelId?: string, channelName?: string) {
  stopWechatQrPoll();
  activeWechatQrChannelId = channelId;
  ui.imWechatQrBox.hidden = false;
  ui.imWechatQrTitle.textContent = channelName ? `微信扫码绑定 · ${channelName}` : '微信扫码绑定 F.R.I.D.A.Y.';
  ui.imWechatQrStatus.textContent = '⏳ 正在向腾讯 iLink 申请微信登录二维码…';
  ui.imWechatQrRefresh.disabled = true;
  try {
    const session = await api<WechatQrLoginSession>('/api/im-wechat-qr-start', {
      ...(channelId ? { id: channelId } : {}),
      ...(channelName ? { name: channelName } : {}),
    });
    activeWechatQrChannelId = session.channelId;
    ui.imWechatQrImg.src = session.qrSvgDataUrl;
    ui.imWechatQrStatus.textContent = '📱 请使用手机微信扫描左侧二维码绑定 F.R.I.D.A.Y.…';
    await refreshView();

    let pollingBusy = false;
    wechatQrPollTimer = setInterval(() => {
      if (pollingBusy) return;
      pollingBusy = true;
      void (async () => {
        try {
          const current = await api<WechatQrLoginSession>('/api/im-wechat-qr-status', {
            sessionId: session.sessionId,
          });
          if (current.status === 'scaned') {
            ui.imWechatQrStatus.textContent = '📲 已扫码！请在手机微信上点击「确认登录」…';
          } else if (current.status === 'confirmed') {
            stopWechatQrPoll();
            ui.imWechatQrStatus.textContent = `✅ 微信扫码绑定成功！(${current.accountId ?? 'iLink 实时收发已激活'})`;
            await refreshView();
            setTimeout(() => {
              if (!wechatQrPollTimer) ui.imWechatQrBox.hidden = true;
            }, 2500);
          } else if (current.status === 'expired') {
            stopWechatQrPoll();
            ui.imWechatQrStatus.textContent = '⚠️ 二维码已过期，请点击「🔄 刷新二维码」重新获取。';
          }
        } catch {
          /* ignore transient poll error */
        } finally {
          pollingBusy = false;
        }
      })();
    }, 1500);
  } catch (error) {
    ui.imWechatQrStatus.textContent = `获取二维码失败：${errorText(error)}`;
  } finally {
    ui.imWechatQrRefresh.disabled = false;
  }
}

function renderImChannels() {
  const channels = view?.imChannels ?? [];
  const activeCount = channels.filter(c => c.enabled).length;
  const wechatBound = channels.some(c => c.platform === 'wechat' && c.hasBotToken);
  const totalIn = channels.reduce((sum, c) => sum + (c.inboundCount ?? 0), 0);
  const totalOut = channels.reduce((sum, c) => sum + (c.outboundCount ?? 0), 0);
  const badgeText = channels.length ? `${activeCount}/${channels.length}` : '0';
  ui.imTopBadge.textContent = badgeText;

  const kpiFrag = document.createDocumentFragment();
  kpiFrag.append(
    kpiCard('启用通道', `${activeCount} / ${channels.length}`, '', activeCount > 0 ? 'positive' : 'default'),
    kpiCard('微信绑定', wechatBound ? '✅ 已直连' : '⚪ 未绑定', '', wechatBound ? 'positive' : 'default'),
    kpiCard('收发消息', `收 ${totalIn} · 发 ${totalOut}`, '', 'accent'),
  );
  ui.imKpiGrid.replaceChildren(kpiFrag);
  ui.imListSubtitle.textContent = channels.length ? `${activeCount} / ${channels.length} 运行中` : '';

  const contents = document.createDocumentFragment();
  for (const ch of channels) {
    const card = node('article', '', `hub-entity-card im-card${ch.enabled ? ' is-active' : ' is-paused'}`);
    const head = node('div', '', 'hub-card-head');
    const titleGroup = node('div', '', 'hub-card-title-group');
    titleGroup.append(
      node('span', imPlatformLabels[ch.platform] ?? ch.platform, 'hub-badge badge-blue'),
      node('strong', ch.name, 'hub-card-title'),
      node('span', ch.enabled ? '● 已启用' : '⏸ 已暂停', `hub-badge ${ch.enabled ? 'badge-green' : 'badge-slate'}`),
    );
    head.append(titleGroup);

    const actions = node('div', '', 'timer-actions');
    if (ch.platform === 'wechat') {
      const qrBtn = button(ch.hasBotToken ? '📱 换绑扫码' : '📱 扫码绑定', () => { void startWechatQrFromUi(ch.id, ch.name); }, 'mini-button');
      qrBtn.disabled = authExpired || !ready;
      actions.append(qrBtn);
    }
    const testBtn = button('⚡ 自检', () => { void testImChannelFromUi(ch.id); }, 'mini-button');
    const editBtn = button('✏️ 编辑', () => { editImChannelFromUi(ch); }, 'mini-button');
    const toggleBtn = button(ch.enabled ? '⏸ 暂停' : '▶️ 启用', () => { void toggleImChannelFromUi(ch.id, !ch.enabled); }, 'mini-button');
    const delBtn = button('🗑️ 删除', () => { void removeImChannelFromUi(ch.id); }, 'mini-button danger-btn');
    editBtn.disabled = authExpired || !ready;
    testBtn.disabled = authExpired || !ready;
    toggleBtn.disabled = authExpired || !ready;
    delBtn.disabled = authExpired || !ready;
    actions.append(testBtn, editBtn, toggleBtn, delBtn);
    head.append(actions);
    card.append(head);

    const webhookPath = `${location.origin}/im/webhook/${encodeURIComponent(ch.id)}`;
    const endpointBox = node('div', '', 'hub-endpoint-row');
    if (ch.platform === 'wechat') {
      const bindText = ch.hasBotToken
        ? `✅ 微信 iLink 已扫码授权${ch.accountId ? ` · 绑定账号: ${ch.accountId}` : ''} · 本机长轮询实时收发已就绪`
        : ch.webhookUrlMasked
          ? `🔗 企微/网桥 Webhook: ${ch.webhookUrlMasked}`
          : '⚠️ 尚未完成微信扫码授权，请点击右上角「📱 扫码绑定」获取登录二维码';
      endpointBox.append(node('span', bindText, ch.hasBotToken ? 'hub-endpoint-text ok' : 'hub-endpoint-text warn'));
    } else {
      endpointBox.append(node('code', `回调 Webhook: ${webhookPath}`, 'hub-endpoint-code'));
      const copyBtn = button('📋 复制地址', () => {
        void navigator.clipboard?.writeText(webhookPath).then(() => {
          copyBtn.textContent = '✅ 已复制';
          setTimeout(() => { copyBtn.textContent = '📋 复制地址'; }, 1800);
        });
      }, 'mini-button');
      endpointBox.append(copyBtn);
    }
    card.append(endpointBox);

    const badgesRow = node('div', '', 'hub-badges-row');
    badgesRow.append(
      node('span', `📥 收到 ${ch.inboundCount} 条`, 'hub-meta-chip'),
      node('span', `📤 发送 ${ch.outboundCount} 条`, 'hub-meta-chip'),
    );
    if (ch.defaultTarget) badgesRow.append(node('span', `🎯 默认目标: ${ch.defaultTarget}`, 'hub-meta-chip mono-chip'));
    if (ch.allowedSenders.length) {
      badgesRow.append(node('span', `🛡️ 白名单: ${ch.allowedSenders.join(', ')}`, 'hub-meta-chip'));
    } else {
      badgesRow.append(node('span', '🛡️ 允许全部已鉴权会话', 'hub-meta-chip'));
    }
    if (ch.lastInboundAt) badgesRow.append(node('span', `最近收信: ${timestamp(ch.lastInboundAt)}`, 'hub-meta-chip'));
    card.append(badgesRow);

    if (ch.lastError) card.append(node('p', `⚠️ 最近异常：${ch.lastError}`, 'error hub-error-banner'));
    contents.append(card);
  }
  if (!channels.length) {
    contents.append(node('p', '暂无 IM 通道', 'empty hub-empty-state'));
  }
  ui.imList.replaceChildren(contents);
}
function resetImChannelForm() {
  editingImChannelId = undefined;
  ui.imNameInput.value = '';
  ui.imWebhookInput.value = '';
  ui.imTokenInput.value = '';
  ui.imSecretInput.value = '';
  ui.imTargetInput.value = '';
  ui.imAllowInput.value = '';
  ui.imCancelEditBtn.hidden = true;
  ui.imSaveBtn.textContent = '💾 保存 IM 通道配置';
}
function editImChannelFromUi(ch: ImChannelView) {
  editingImChannelId = ch.id;
  ui.imPlatformInput.value = ch.platform;
  ui.imNameInput.value = ch.name;
  ui.imTargetInput.value = ch.defaultTarget ?? '';
  ui.imAllowInput.value = ch.allowedSenders.join(', ');
  ui.imCancelEditBtn.hidden = false;
  ui.imSaveBtn.textContent = `💾 更新通道「${ch.name}」`;
  ui.imAddDetails.open = true;
  ui.imNameInput.focus();
}
async function saveImChannelFromUi() {
  const platform = ui.imPlatformInput.value as 'dingtalk' | 'wechat' | 'telegram';
  const name = ui.imNameInput.value.trim() || `${imPlatformLabels[platform] ?? platform}助手`;
  const webhookUrl = ui.imWebhookInput.value.trim() || undefined;
  const botToken = ui.imTokenInput.value.trim() || undefined;
  const secret = ui.imSecretInput.value.trim() || undefined;
  const defaultTarget = ui.imTargetInput.value.trim() || undefined;
  const allowedSenders = ui.imAllowInput.value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
  ui.imSaveBtn.disabled = true;
  try {
    await api<ImChannelView>('/api/im-save', {
      ...(editingImChannelId ? { id: editingImChannelId } : {}),
      platform, name,
      ...(webhookUrl !== undefined ? { webhookUrl } : {}),
      ...(botToken !== undefined ? { botToken } : {}),
      ...(secret !== undefined ? { secret } : {}),
      ...(defaultTarget !== undefined ? { defaultTarget } : {}),
      ...(editingImChannelId || allowedSenders.length ? { allowedSenders } : {}),
    });
    resetImChannelForm();
    ui.imAddDetails.open = false;
    await refreshView();
  } catch (error) {
    connection(`保存 IM 通道失败：${errorText(error)}`, true);
  } finally {
    ui.imSaveBtn.disabled = false;
  }
}
async function toggleImChannelFromUi(id: string, enabled: boolean) {
  try {
    await api<unknown>('/api/im-toggle', { id, enabled });
    await refreshView();
  } catch (error) {
    connection(`切换 IM 通道失败：${errorText(error)}`, true);
  }
}
async function testImChannelFromUi(id: string) {
  try {
    await api<unknown>('/api/im-test', { id });
    connection('已向该 IM 通道发送 FRIDAY 神经链路自检消息。');
    await refreshView();
  } catch (error) {
    connection(`IM 通道自检失败：${errorText(error)}`, true);
    await refreshView();
  }
}
async function removeImChannelFromUi(id: string) {
  try {
    await api<unknown>('/api/im-remove', { id });
    await refreshView();
  } catch (error) {
    connection(`删除 IM 通道失败：${errorText(error)}`, true);
  }
}
let activeAuthProviderTab = 'deepseek';
function providerStatusText(prov: ModelProviderView): string {
  const prefix = prov.enabled === false ? '🚫 已禁用 · ' : '';
  if (prov.authType === 'oauth') return `${prefix}✅ OAuth 已授权`;
  if (prov.authType === 'api_key') return `${prefix}✅ Key 已保存 (${prov.keyHint ?? '已配置'})`;
  if (prov.authType === 'environment') return `${prefix}✅ 环境变量凭据`;
  if (prov.baseUrl) return `${prefix}🌐 自定义网关 (${prov.baseUrl})`;
  return `${prefix}⚠️ 未配置凭据`;
}
function renderProbeInto(container: HTMLElement, probe: ModelProbeResult | undefined) {
  if (!probe) {
    container.hidden = true;
    container.replaceChildren();
    return;
  }
  container.hidden = false;
  container.replaceChildren();
  container.className = `model-probe-result ${probe.ok ? 'probe-ok' : 'probe-err'}`;
  const head = node('p', `${probe.ok ? '✅ 连通正常' : '❌ 探针异常'} · ${probe.provider}/${probe.model} · 延迟 ${probe.latencyMs}ms · ${probe.supportsImages ? '🖼️ 支持多模态看图' : '📝 纯文本模型'}`, probe.ok ? 'probe-title-ok' : 'error');
  const body = node('p', probe.ok ? `模型响应：${probe.reply ?? '响应成功'}` : `错误详情：${probe.error ?? '请求失败'}`, probe.ok ? 'memory-preview' : 'error');
  container.append(head, body);
}
function populateProviderSelect(selectEl: HTMLSelectElement, providers: ModelProviderView[], selectedId: string) {
  const frag = document.createDocumentFragment();
  for (const prov of providers) {
    const opt = document.createElement('option');
    opt.value = prov.id;
    const disabled = prov.enabled === false;
    opt.disabled = disabled;
    opt.textContent = `${prov.name}${disabled ? ' (已禁用)' : (prov.configured ? ' ✓' : '')}`;
    if (prov.id === selectedId) opt.selected = true;
    frag.append(opt);
  }
  selectEl.replaceChildren(frag);
  if ([...selectEl.options].some(o => o.value === selectedId)) selectEl.value = selectedId;
}
function populateModelSelect(selectEl: HTMLSelectElement, prov: ModelProviderView | undefined, selectedModelId?: string) {
  const frag = document.createDocumentFragment();
  const models = prov?.models ?? [];
  const hasSelected = Boolean(selectedModelId && models.some(m => m.id === selectedModelId));
  if (selectedModelId && !hasSelected) {
    const customOpt = document.createElement('option');
    customOpt.value = selectedModelId;
    customOpt.textContent = `${selectedModelId}（当前指定）`;
    customOpt.selected = true;
    frag.append(customOpt);
  }
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    const visionTag = m.supportsImages ? '🖼️看图' : '📝文本';
    const ctxTag = `${Math.round(m.contextWindow / 1000)}K`;
    const priceTag = m.costInput > 0 ? `$${m.costInput}/$${m.costOutput}` : '免费/内置';
    opt.textContent = `${m.id} — ${m.name} (${visionTag} · ${ctxTag} · ${priceTag})`;
    if (m.id === selectedModelId) opt.selected = true;
    frag.append(opt);
  }
  selectEl.replaceChildren(frag);
  if (selectedModelId && [...selectEl.options].some(o => o.value === selectedModelId)) {
    selectEl.value = selectedModelId;
  }
}
function renderModalAuthSection() {
  const hub = view?.modelHub;
  if (!hub) return;
  const providers = hub.providers;
  if (!providers.some(p => p.id === activeAuthProviderTab) && providers[0]) {
    activeAuthProviderTab = providers[0].id;
  }
  const tabsFrag = document.createDocumentFragment();
  for (const prov of providers) {
    const isCurrent = prov.id === activeAuthProviderTab;
    const statusIcon = prov.enabled === false ? '🚫' : (prov.configured ? '🟢' : '⚪');
    const tabBtn = button(
      `${statusIcon} ${prov.name} (${prov.models.length})`,
      () => {
        activeAuthProviderTab = prov.id;
        ui.modalAuthKeyInput.value = '';
        ui.modalAuthProbeResult.hidden = true;
        renderModalAuthSection();
      },
      `modal-tab-btn${isCurrent ? ' active' : ''}`,
    );
    tabsFrag.append(tabBtn);
  }
  ui.modalProviderTabs.replaceChildren(tabsFrag);

  const currentProv = providers.find(p => p.id === activeAuthProviderTab);
  if (!currentProv) return;
  const isDisabled = currentProv.enabled === false;
  ui.modalAuthProviderTitle.textContent = `${currentProv.name} (${currentProv.id})`;
  ui.modalAuthStatusBadge.textContent = providerStatusText(currentProv);
  ui.modalAuthStatusBadge.className = `hub-badge ${isDisabled ? 'badge-slate' : (currentProv.configured ? 'badge-green' : 'badge-amber')}`;
  ui.modalAuthToggleBtn.textContent = isDisabled ? '▶️ 启用提供方' : '🚫 禁用提供方';
  ui.modalAuthToggleBtn.className = `mini-button${isDisabled ? '' : ' danger-btn'}`;
  ui.modalAuthToggleBtn.disabled = authExpired || !ready;
  ui.modalAuthFetchBtn.disabled = isDisabled || authExpired || !ready;
  ui.modalAuthTestBtn.disabled = isDisabled || authExpired || !ready;
  ui.modalAuthBaseurlInput.value = currentProv.baseUrl ?? '';
  if (currentProv.modelSource === 'remote_api') {
    ui.modalAuthModelSource.textContent = `🌐 远端同步 (${currentProv.models.length} 款)`;
  } else {
    ui.modalAuthModelSource.textContent = `📦 预置目录 (${currentProv.models.length} 款)`;
  }
  const defaultTestModel = currentProv.id === 'deepseek'
    ? 'deepseek-flash'
    : (currentProv.defaultBalanced ?? currentProv.models[0]?.id);
  populateModelSelect(ui.modalAuthTestModelSelect, currentProv, defaultTestModel);
}
function syncModalRouterModels(preferredModel?: string) {
  const hub = view?.modelHub;
  if (!hub) return;
  const provId = ui.modalRouterProviderSelect.value;
  const prov = hub.providers.find(p => p.id === provId);
  const targetModel = preferredModel
    ?? (provId === hub.routerProvider ? hub.routerModel : undefined)
    ?? (provId === 'deepseek' ? 'deepseek-flash' : prov?.defaultBalanced ?? prov?.models[0]?.id);
  populateModelSelect(ui.modalRouterModelSelect, prov, targetModel);
}
function openModelHubModal(focusProviderId?: string) {
  const hub = view?.modelHub;
  if (!hub) {
    connection('正在读取模型中心数据，请稍候…');
    return;
  }
  closeAllHubModals();
  if (focusProviderId) activeAuthProviderTab = focusProviderId;
  ui.modalAuthKeyInput.value = '';
  ui.modalAuthCustomModelsInput.value = '';
  ui.modalAuthProbeResult.hidden = true;
  renderModelHub();
  renderModalAuthSection();

  const routerProv = hub.providers.some(p => p.id === hub.routerProvider) ? hub.routerProvider : 'deepseek';
  populateProviderSelect(ui.modalRouterProviderSelect, hub.providers, routerProv);
  syncModalRouterModels(hub.routerModel);

  ui.modelHubBackdrop.hidden = false;
}
function closeModelHubModal() {
  ui.modelHubBackdrop.hidden = true;
}
function renderModelHub() {
  const hub = view?.modelHub;
  const tiers = hub?.tiers ?? view?.modelTiers;
  if (!hub && !tiers) {
    ui.modelTopBadge.textContent = '—';
    ui.modelCurrentStatus.replaceChildren();
    return;
  }
  const configuredCount = hub?.providers.filter(p => p.configured && p.enabled !== false).length ?? 0;
  const disabledCount = hub?.providers.filter(p => p.enabled === false).length ?? 0;
  const totalProviders = hub?.providers.length ?? 0;
  const pool = hub?.modelPool ?? [];
  const reasoningCount = pool.filter(m => m.reasoning || m.specialties.includes('深度推理')).length;
  const visionCount = pool.filter(m => m.supportsImages).length;
  const routerShort = hub?.routerModel ?? tiers?.router ?? '—';
  ui.modelTopBadge.textContent = `${configuredCount}方·${pool.length}模`;

  const statusFrag = document.createDocumentFragment();
  statusFrag.append(
    kpiCard('🤖 F.R.I.D.A.Y. 主控', routerShort, hub?.routerProvider ?? '', 'accent'),
    kpiCard('🟢 已启用提供方', `${configuredCount} / ${totalProviders}`, disabledCount > 0 ? `已禁用 ${disabledCount} 个` : '', configuredCount > 0 ? 'positive' : 'warning'),
    kpiCard('🧩 跨方调度池', `${pool.length} 款模型`, '', pool.length > 0 ? 'positive' : 'default'),
    kpiCard('🧠 推理 / 🖼️ 看图', `${reasoningCount} / ${visionCount}`, '', 'default'),
  );
  ui.modelCurrentStatus.replaceChildren(statusFrag);

  ui.modelPoolSubtitle.textContent = pool.length
    ? `${configuredCount} 个提供方 · ${pool.length} 款模型`
    : '';
  const poolFrag = document.createDocumentFragment();
  for (const item of pool) {
    const card = node('article', '', `hub-entity-card pool-card${item.tier === 'strong' ? ' is-pinned' : ' is-active'}`);
    const head = node('div', '', 'hub-card-head');
    const titleGroup = node('div', '', 'hub-card-title-group');
    const tierBadge = item.tier === 'strong'
      ? node('span', '🧠 强力', 'hub-badge badge-amber')
      : item.tier === 'fast'
        ? node('span', '⚡ 极速', 'hub-badge badge-teal')
        : node('span', '⚖️ 均衡', 'hub-badge badge-blue');
    titleGroup.append(
      node('span', item.providerName, 'hub-badge badge-green'),
      tierBadge,
      node('strong', item.modelId, 'hub-card-title'),
    );
    head.append(titleGroup);

    const probeBox = node('div', '', 'model-probe-result');
    probeBox.hidden = true;
    const probeBtn = button('⚡ 实测', () => {
      void runInlineProbe(item.providerId, item.modelId, probeBox, probeBtn);
    }, 'mini-button');
    probeBtn.disabled = authExpired || !ready;
    head.append(probeBtn);
    card.append(head);

    const badgesRow = node('div', '', 'hub-badges-row');
    for (const specTag of item.specialties) {
      badgesRow.append(node('span', specTag, 'hub-tag-chip'));
    }
    badgesRow.append(node('span', `📐 ${Math.round(item.contextWindow / 1000)}K 上下文`, 'hub-meta-chip'));
    if (item.latencyMs) {
      badgesRow.append(node('span', `⏱️ ${item.latencyMs}ms`, 'hub-meta-chip'));
    }
    if (item.successCount || item.failCount) {
      badgesRow.append(node('span', `📊 成 ${item.successCount ?? 0} / 败 ${item.failCount ?? 0}`, 'hub-meta-chip'));
    }
    card.append(badgesRow, probeBox);
    poolFrag.append(card);
  }
  if (!pool.length) {
    poolFrag.append(node('p', '暂无已就绪模型', 'empty hub-empty-state'));
  }
  ui.modelPoolMatrix.replaceChildren(poolFrag);

  const listFrag = document.createDocumentFragment();
  for (const prov of hub?.providers ?? []) {
    const isDisabled = prov.enabled === false;
    const card = node('article', '', `hub-entity-card provider-card${isDisabled ? ' is-paused' : (prov.configured ? ' is-active' : '')}`);
    const head = node('div', '', 'hub-card-head');
    const titleGroup = node('div', '', 'hub-card-title-group');
    const badgeLabel = isDisabled ? '🚫 已禁用' : (prov.configured ? '🟢 已接入' : '⚪ 待接入');
    const badgeClass = isDisabled ? 'badge-slate' : (prov.configured ? 'badge-green' : 'badge-slate');
    titleGroup.append(
      node('span', badgeLabel, `hub-badge ${badgeClass}`),
      node('strong', `${prov.name} (${prov.id})`, 'hub-card-title'),
    );
    head.append(titleGroup);
    const actions = node('div', '', 'timer-actions');
    const toggleBtn = button(isDisabled ? '▶️ 启用' : '🚫 禁用', () => {
      void toggleProviderEnabledFromUi(prov.id, isDisabled);
    }, `mini-button${isDisabled ? '' : ' danger-btn'}`);
    const configBtn = button(prov.configured ? '⚙️ 管理凭据 ↑' : '➕ 接入提供方 ↑', () => {
      activeAuthProviderTab = prov.id;
      ui.modalAuthKeyInput.value = '';
      ui.modalAuthCustomModelsInput.value = '';
      ui.modalAuthProbeResult.hidden = true;
      renderModalAuthSection();
      ui.modalProviderTabs.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 'mini-button');
    toggleBtn.disabled = authExpired || !ready;
    configBtn.disabled = authExpired || !ready;
    actions.append(toggleBtn, configBtn);
    head.append(actions);
    card.append(head);

    const srcTag = prov.modelSource === 'remote_api' ? `🌐 接口同步 (${prov.models.length} 款)` : `📦 目录模型 (${prov.models.length} 款)`;
    const badgesRow = node('div', '', 'hub-badges-row');
    badgesRow.append(
      node('span', providerStatusText(prov), 'hub-meta-chip'),
      node('span', srcTag, 'hub-meta-chip'),
    );
    card.append(badgesRow);
    listFrag.append(card);
  }
  ui.modelProvidersList.replaceChildren(listFrag);
}
async function runInlineProbe(
  provider: string,
  model: string,
  targetBox: HTMLElement,
  triggerBtn?: HTMLButtonElement,
  inlineCreds?: { apiKey?: string; baseUrl?: string },
): Promise<ModelProbeResult | undefined> {
  if (!model) return undefined;
  if (triggerBtn) triggerBtn.disabled = true;
  targetBox.hidden = false;
  targetBox.replaceChildren(node('p', `⏳ 正在实测 ${provider}/${model} 连通性与响应延迟…`, 'meta'));
  try {
    const probe = await api<ModelProbeResult>('/api/model-probe', {
      provider,
      model,
      ...(inlineCreds?.apiKey ? { apiKey: inlineCreds.apiKey } : {}),
      ...(inlineCreds?.baseUrl ? { baseUrl: inlineCreds.baseUrl } : {}),
    });
    if (view?.modelHub) view.modelHub.lastProbe = probe;
    renderProbeInto(targetBox, probe);
    return probe;
  } catch (error) {
    targetBox.replaceChildren(node('p', `❌ 探针请求失败：${errorText(error)}`, 'error'));
    return undefined;
  } finally {
    if (triggerBtn) triggerBtn.disabled = false;
  }
}
async function fetchAuthProviderModelsFromModal() {
  const providerId = activeAuthProviderTab;
  const apiKey = ui.modalAuthKeyInput.value.trim() || undefined;
  const baseUrl = ui.modalAuthBaseurlInput.value.trim() || undefined;
  ui.modalAuthFetchBtn.disabled = true;
  ui.modalAuthProbeResult.hidden = false;
  ui.modalAuthProbeResult.replaceChildren(node('p', `⏳ 正在请求 ${providerId} 官方 /models 接口拉取真实模型列表…`, 'meta'));
  try {
    const updated = await api<ModelHubView>('/api/model-fetch', {
      providerId,
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });
    if (view) { view.modelHub = updated; view.modelTiers = updated.tiers; }
    renderModelHub();
    renderModalAuthSection();
    syncModalRouterModels();
    const prov = updated.providers.find(p => p.id === providerId);
    ui.modalAuthProbeResult.hidden = false;
    ui.modalAuthProbeResult.replaceChildren(
      node('p', `✅ 已从 ${prov?.name ?? providerId} 接口实时同步 ${prov?.models.length ?? 0} 款模型并加入 F.R.I.D.A.Y. 调度池`, 'memory-topic'),
      node('p', `返回模型：${(prov?.models ?? []).slice(0, 12).map(m => m.id).join(', ')}${(prov?.models.length ?? 0) > 12 ? ' …' : ''}`, 'memory-preview'),
    );
  } catch (error) {
    ui.modalAuthProbeResult.hidden = false;
    ui.modalAuthProbeResult.replaceChildren(node('p', `❌ 拉取模型列表失败：${errorText(error)}`, 'error'));
  } finally {
    ui.modalAuthFetchBtn.disabled = false;
  }
}
async function testAuthProviderFromModal(saveFirst: boolean) {
  const providerId = activeAuthProviderTab;
  const apiKey = ui.modalAuthKeyInput.value.trim() || undefined;
  const baseUrl = ui.modalAuthBaseurlInput.value.trim();
  const customModels = ui.modalAuthCustomModelsInput.value.split(/[,，\s]+/).map(m => m.trim()).filter(Boolean);
  const testModel = ui.modalAuthTestModelSelect.value;
  ui.modalAuthTestBtn.disabled = true;
  ui.modalAuthSaveTestBtn.disabled = true;
  try {
    if (saveFirst) {
      const updated = await api<ModelHubView>('/api/model-configure', {
        providerId,
        ...(apiKey ? { apiKey } : {}),
        baseUrl,
        ...(customModels.length ? { customModels } : {}),
      });
      if (view) { view.modelHub = updated; view.modelTiers = updated.tiers; }
      ui.modalAuthKeyInput.value = '';
      ui.modalAuthCustomModelsInput.value = '';
      renderModelHub();
      renderModalAuthSection();
      populateProviderSelect(ui.modalRouterProviderSelect, updated.providers, updated.routerProvider);
      syncModalRouterModels();
      if ([...ui.modalAuthTestModelSelect.options].some(o => o.value === testModel)) {
        ui.modalAuthTestModelSelect.value = testModel;
      }
    }
    await runInlineProbe(providerId, ui.modalAuthTestModelSelect.value || testModel, ui.modalAuthProbeResult, undefined, {
      apiKey,
      baseUrl: baseUrl || undefined,
    });
    await refreshView();
  } catch (error) {
    ui.modalAuthProbeResult.hidden = false;
    ui.modalAuthProbeResult.replaceChildren(node('p', `❌ 保存或测试失败：${errorText(error)}`, 'error'));
  } finally {
    ui.modalAuthTestBtn.disabled = false;
    ui.modalAuthSaveTestBtn.disabled = false;
  }
}
async function addCustomProviderFromModal() {
  const providerId = ui.customProvIdInput.value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  const providerName = ui.customProvNameInput.value.trim() || providerId;
  const baseUrl = ui.customProvUrlInput.value.trim();
  const apiKey = ui.customProvKeyInput.value.trim() || undefined;
  const customModels = ui.customProvModelsInput.value.split(/[,，\s]+/).map(m => m.trim()).filter(Boolean);
  if (!providerId || !baseUrl) {
    connection('请填写自定义提供方 ID 和 Base URL', true);
    return;
  }
  ui.customProvSaveBtn.disabled = true;
  try {
    const updated = await api<ModelHubView>('/api/model-configure', {
      providerId,
      providerName,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      ...(customModels.length ? { customModels } : {}),
    });
    if (view) { view.modelHub = updated; view.modelTiers = updated.tiers; }
    activeAuthProviderTab = providerId;
    ui.customProvIdInput.value = '';
    ui.customProvNameInput.value = '';
    ui.customProvUrlInput.value = '';
    ui.customProvKeyInput.value = '';
    ui.customProvModelsInput.value = '';
    ui.modalCustomProviderDetails.open = false;
    renderModelHub();
    renderModalAuthSection();
    populateProviderSelect(ui.modalRouterProviderSelect, updated.providers, updated.routerProvider);
    syncModalRouterModels();
    connection(`✅ 已添加提供方「${providerName}」并接入 F.R.I.D.A.Y. 跨方模型调度池`);
  } catch (error) {
    connection(`添加提供方失败：${errorText(error)}`, true);
  } finally {
    ui.customProvSaveBtn.disabled = false;
  }
}
async function toggleProviderEnabledFromUi(providerId: string, enabled: boolean) {
  ui.modalAuthToggleBtn.disabled = true;
  try {
    const updated = await api<ModelHubView>('/api/model-configure', {
      providerId,
      enabled,
    });
    if (view) { view.modelHub = updated; view.modelTiers = updated.tiers; }
    renderModelHub();
    renderModalAuthSection();
    populateProviderSelect(ui.modalRouterProviderSelect, updated.providers, updated.routerProvider);
    syncModalRouterModels(updated.routerModel);
    const provName = updated.providers.find(p => p.id === providerId)?.name ?? providerId;
    connection(enabled ? `✅ 已启用模型提供方「${provName}」` : `🚫 已禁用模型提供方「${provName}」，后续请求将无法调用该提供方`);
  } catch (error) {
    connection(`${enabled ? '启用' : '禁用'}提供方失败：${errorText(error)}`, true);
  } finally {
    ui.modalAuthToggleBtn.disabled = false;
  }
}
async function clearAuthProviderFromModal() {
  const providerId = activeAuthProviderTab;
  ui.modalAuthClearBtn.disabled = true;
  try {
    const updated = await api<ModelHubView>('/api/model-configure', {
      providerId,
      clearApiKey: true,
    });
    if (view) { view.modelHub = updated; view.modelTiers = updated.tiers; }
    ui.modalAuthKeyInput.value = '';
    renderModelHub();
    renderModalAuthSection();
    ui.modalAuthProbeResult.hidden = false;
    ui.modalAuthProbeResult.replaceChildren(node('p', `已清除提供方 ${providerId} 的已存凭据。`, 'meta'));
  } catch (error) {
    ui.modalAuthProbeResult.hidden = false;
    ui.modalAuthProbeResult.replaceChildren(node('p', `清除失败：${errorText(error)}`, 'error'));
  } finally {
    ui.modalAuthClearBtn.disabled = false;
  }
}
async function saveModalRoutingFromUi() {
  const routerProvider = ui.modalRouterProviderSelect.value;
  const routerModel = ui.modalRouterModelSelect.value;
  ui.modalSaveRoutingBtn.disabled = true;
  try {
    const updated = await api<ModelHubView>('/api/model-configure', {
      routerProvider,
      routerModel: `${routerProvider}/${routerModel}`,
    });
    if (view) { view.modelHub = updated; view.modelTiers = updated.tiers; }
    renderModelHub();
    connection(`✅ 已设定 F.R.I.D.A.Y. 主控模型为 ${updated.routerProvider}/${updated.routerModel}`);
  } catch (error) {
    connection(`设定 F.R.I.D.A.Y. 主控模型失败：${errorText(error)}`, true);
  } finally {
    ui.modalSaveRoutingBtn.disabled = false;
  }
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
    ui.mode.textContent = result.mode === 'offline' ? '离线模拟' : '真实模式';
    ui.mode.classList.toggle('offline', result.mode === 'offline');
    renderMessages();
    renderWorks();
    renderMemories();
    renderTimers();
    renderPlugins();
    renderImChannels();
    renderModelHub();
    updateComposer();
    followLatestMessage(result);
    if (!initial && selection.type === 'task' && result.works.find(work => work.id === selectedTaskId)?.status !== previousWorkStatus) {
      void loadWork(selection.id, selectionGeneration, true);
    }
  } finally {
    refreshBusy = false;
    if (refreshAgain && !authExpired) { refreshAgain = false; scheduleRefresh(); }
  }
}
/**
 * The readable process follows the newest round unless the reader pinned another work or message.
 * Following never changes the conversation itself, only which recorded steps are shown.
 */
function followLatestMessage(result: MainView) {
  if (selectionPinned) return;
  const latest = [...messages.values()].filter(message => message.role === 'user').sort((a, b) => b.seq - a.seq)[0];
  if (!latest || latest.id === followedMessage) return;
  selectTrace({ type: 'message', id: latest.id, label: latest.text.slice(0, 80) }, false);
}
function scheduleRefresh() {
  if (refreshTimer || authExpired) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refreshView().catch(error => connection(`数据可能已过时：${errorText(error)}。后台工作不会因页面断开而停止。`, true));
    if (!traceHasMore) void loadTrace('live');
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
let selectionPinned = false;
let followedMessage: string | undefined;
function selectTrace(next: Selection, pin = true) {
  if (pin) selectionPinned = true;
  if (next.type === 'message') followedMessage = next.id;
  selection = next;
  selectionGeneration++;
  traceEvents = [];
  traceAfter = 0;
  traceHasMore = false;
  traceHasEarlier = false;
  traceBusy = false;
  traceAgain = false;
  selectedEvent = undefined;
  selectedSpan = undefined;
  workData = undefined;
  ui.traceScope.textContent = next.type === 'all' ? '全部已记录事件' : `${next.type === 'task' ? '后台工作' : '消息'} · ${next.label}`;
  ui.traceScope.title = ui.traceScope.textContent;
  ui.traceContent.replaceChildren(node('p', '正在读取实际轨迹…', 'empty'));
  ui.eventDetail.replaceChildren(node('h3', '节点详情'), node('p', '选择节点查看公开数据与记录时间。', 'meta'));
  ui.eventDetail.hidden = true;
  renderWorks();
  renderWorkDetail();
  renderRoutingDetail();
  void loadTrace('recent').then(fillProcessStart);
  if (next.type === 'task') void loadWork(next.id, selectionGeneration);
}
async function loadTrace(direction: 'live' | 'earlier' | 'recent' = 'live') {
  if (!ready || authExpired) return;
  if (traceBusy) { traceAgain = true; return; }
  const generation = selectionGeneration;
  const latest = direction === 'live';
  const anchor = direction === 'earlier' ? traceEvents[0]?.seq : latest ? traceAfter : undefined;
  const params = new URLSearchParams();
  if (anchor !== undefined) params.set(direction === 'earlier' ? 'before' : 'after', String(anchor));
  if (selection.type !== 'all') params.set(selection.type === 'task' ? 'taskId' : 'messageId', selection.id);
  traceBusy = true;
  ui.traceMore.disabled = true;
  ui.traceError.textContent = '';
  ui.traceRetry.hidden = true;
  try {
    const events = await api<TraceEvent[]>(`/api/trace?${params}`);
    if (generation !== selectionGeneration) return;
    const merged = new Map(traceEvents.map(event => [event.seq, event]));
    for (const event of events) merged.set(event.seq, event);
    traceEvents = [...merged.values()].sort((a, b) => a.seq - b.seq);
    traceAfter = Math.max(traceAfter, events.at(-1)?.seq ?? 0);
    // A full page forward means there may be more; the recent window may legitimately end at the head.
    if (direction === 'live') traceHasMore = events.length === 60;
    const full = events.length === 60;
    if (direction === 'recent') traceHasEarlier = full;
    else if (direction === 'earlier') traceHasEarlier = full;
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
      syncTraceMore();
      if ((traceMode !== 'events' && selection.type !== 'all' && traceHasMore) || (traceAgain && !traceHasMore)) {
        traceAgain = false; void loadTrace('live');
      }
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
const actorNames: Record<string, string> = { router: 'F.R.I.D.A.Y.', worker: 'Worker', executor: '执行器', system: '系统', user: '你' };
function workLabel(step: TimelineStep): string | undefined {
  if (step.taskLabel) return step.taskLabel;
  return step.taskId ? view?.works.find(work => work.id === step.taskId)?.prompt : undefined;
}
const openSteps = new Set<string>();
function renderSteps(contents: DocumentFragment) {
  const steps = timelineSteps(traceEvents);
  if (traceHasEarlier) contents.append(node('p', '从最近记录的步骤开始显示；更早的步骤可继续加载。', 'branch-note'));
  if (!steps.length) {
    contents.append(node('p', traceEvents.length ? '暂无已记录的执行步骤，请查看原始事件。' :
      selection.type === 'task' ? '此历史工作未采集详细轨迹。' : '此范围尚无可阅读的执行步骤。', 'empty'));
    return;
  }
  const list = node('ul', '', 'timeline');
  for (const step of steps) {
    const item = node('li', '', `timeline-step ${step.actor}${active(step.status) ? ' live' : ''}`);
    const head = node('div', '', 'step-head');
    head.append(node('span', actorNames[step.actor] ?? step.actor, `step-role ${step.actor}`));
    const task = workLabel(step);
    if (task) head.append(button(task, () => {
      if (!step.taskId) return;
      selectTrace({ type: 'task', id: step.taskId, label: task }); showPanel(true);
    }, 'step-task'));
    head.append(node('span', step.route ? routeState(step.route) : step.followupState
      ? `补充要求：${statusText(step.followupState)}` : statusText(step.status), 'step-state'));
    head.append(node('time', timestamp(step.at), 'step-time'));
    item.append(head, node('p', step.title, 'step-title'));
    if (step.trigger && step.title.startsWith('F.R.I.D.A.Y.')) item.append(node('p', `触发内容：${step.trigger}`, 'meta'));
    if (step.summary) {
      const text = step.summary.length > 1200 ? step.summary.slice(0, 1200) : step.summary;
      item.append(node('p', `${step.summarySource === 'stream' ? '公开输出' : '公开说明'}：${text}${step.summaryTruncated || text.length < step.summary.length ? '…（已截断）' : ''}`,
        step.summarySource === 'stream' ? 'step-summary streaming' : 'step-summary'));
    } else if (step.kind === 'span' && step.label === '模型推理调用') {
      item.append(node('p', active(step.status) ? '本轮尚无公开说明。' : '本轮未记录公开说明。', 'meta'));
    }
    if (step.input) {
      const lines = Object.entries(step.input).filter(([, value]) => value !== '').map(([key, value]) => `${key}: ${value}`);
      if (lines.length) item.append(node('pre', `${lines.join('\n')}${step.inputTruncated ? '\n…（已截断）' : ''}`, 'step-io input'));
    }
    if (step.output) item.append(node('p', '已记录结果：', 'meta'),
      node('pre', `${step.output}${step.outputTruncated ? '\n…（已截断）' : ''}`, 'step-io'));
    if (step.exitCode !== undefined) item.append(node('p', `退出码 ${step.exitCode}`, 'meta'));
    if (step.error) item.append(node('p', `错误：${step.error}`, 'error'));
    const raw = traceEvents.filter(event => (event.spanId === step.id || event.parentSpanId === step.id || event.spanId === step.parentTool)
      && event.kind !== 'visible_text' && event.kind !== 'thinking');
    const details = node('details', '', 'step-records');
    const records = node('pre');
    // Raw records are built only when opened: a live window can hold hundreds of events per step.
    const fillRecords = () => {
      if (!records.textContent) records.textContent = json(raw.map(event =>
        ({ seq: event.seq, label: event.label, status: event.status, at: event.at, data: event.data })));
    };
    details.open = openSteps.has(step.id);
    if (details.open) fillRecords();
    details.addEventListener('toggle', () => {
      if (details.open) { openSteps.add(step.id); fillRecords(); } else openSteps.delete(step.id);
    });
    details.append(node('summary', `已记录的 ${raw.length} 条记录${traceHasEarlier ? '（更早记录可能未加载）' : ''}`), records);
    item.append(details);
    list.append(item);
  }
  contents.append(list);
}
/**
 * The recent window is where live work is, but a short round should read from its own beginning.
 * Earlier pages are bounded so a very long work still opens quickly and says what is not loaded.
 */
async function fillProcessStart() {
  if (traceMode !== 'steps') return;
  const generation = selectionGeneration;
  const starts = new Set(['F.R.I.D.A.Y. 处理新输入', 'F.R.I.D.A.Y. 派发任务', 'Worker 接收任务']);
  for (let page = 0; page < 4; page++) {
    if (generation !== selectionGeneration || !traceHasEarlier || traceBusy) return;
    const steps = timelineSteps(traceEvents);
    if (!steps.length || starts.has(steps[0]!.title)) return;
    await loadTrace('earlier');
  }
}
function syncTraceMore() {
  ui.traceMore.hidden = traceMode === 'steps' ? !traceHasEarlier : !traceHasMore;
  ui.traceMore.textContent = traceMode === 'steps' ? '加载更早记录' : '加载更多事件';
}
function renderTrace() {
  const contents = document.createDocumentFragment();
  const scroller = ui.traceContent.closest<HTMLElement>('.trace-scroll');
  const pinned = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120 : false;
  if (traceMode === 'steps') renderSteps(contents);
  else if (traceMode === 'events') {
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
  else if (traceMode === 'graph' && !buildSpans(traceEvents).length && traceEvents.every(event => event.kind === 'visible_text')) {
    contents.append(node('p', '仅有公开文本增量，请在原始事件中查看。', 'empty'));
  }
  ui.traceContent.replaceChildren(contents);
  syncTraceMore();
  // The raw node inspector belongs to the diagnostic modes; each step carries its own recorded data.
  ui.eventDetail.hidden = traceMode === 'steps' && selectedEvent === undefined && !selectedSpan;
  if (scroller && pinned) scroller.scrollTop = scroller.scrollHeight;
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
  if (task.status === 'paused') {
    const resumeBtn = button('确认继续运行此工作', () => {
      resumeBtn.disabled = true;
      void api<unknown>('/api/resume', { taskId }).then(updated => {
        if (generation === selectionGeneration) { workData = updated; renderWorkDetail(); }
        connection('已确认恢复运行工作。');
        scheduleRefresh();
      }).catch(error => {
        resumeBtn.disabled = false;
        connection(`恢复工作失败：${errorText(error)}`, true);
      });
    });
    ui.workDetail.append(resumeBtn);
  }
  if (typeof task.status === 'string') detailRow(ui.workDetail, '状态', task.pendingQuestion ? '⏳ 等待老板拍板（不计入活跃耗时）' : statusText(task.status));
  if (task.pendingQuestion && typeof task.pendingQuestion === 'object') {
    const pq = record(task.pendingQuestion);
    if (typeof pq.question === 'string') detailRow(ui.workDetail, '待拍板问题', pq.question);
    if (Array.isArray(pq.options) && pq.options.length) detailRow(ui.workDetail, '可选方案', pq.options.map(String).join(' / '));
  }
  if (typeof task.profile === 'string') detailRow(ui.workDetail, '子 AI 专精画像', profileBadges[task.profile] ?? task.profile);
  if (typeof task.modelTier === 'string') detailRow(ui.workDetail, '动态模型档位', tierBadges[task.modelTier] ?? task.modelTier);
  if (typeof task.workerModel === 'string' && task.workerModel) detailRow(ui.workDetail, '指定模型', task.workerModel);
  if (typeof task.contextBrief === 'string' && task.contextBrief) detailRow(ui.workDetail, 'F.R.I.D.A.Y. 编译背景', task.contextBrief);
  if (Array.isArray(task.memoryIds) && task.memoryIds.length) detailRow(ui.workDetail, '挂载记忆卡片', task.memoryIds.map(String).join(', '));
  if (typeof task.reason === 'string') ui.workDetail.append(node('p', task.reason, 'message-reason'));
  if (task.report !== undefined) {
    const report = node('details');
    report.append(node('summary', '查看已交付报告（F.R.I.D.A.Y. 汇总）'), node('pre', typeof task.report === 'string' ? task.report : json(task.report)));
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
      selectTrace(latest ? { type: 'message', id: latest.id, label: latest.text.slice(0, 80) } : { type: 'all' }, false);
    }
    else if (!traceHasMore) void loadTrace('live');
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
let resizePinned = true;
ui.scroll.addEventListener('scroll', () => {
  resizePinned = ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 90;
}, { passive: true });
window.addEventListener('resize', () => {
  // A viewport change must not leave the newest reply clipped under the composer when already near bottom.
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = undefined;
    if (resizePinned) ui.scroll.scrollTop = ui.scroll.scrollHeight;
  }, 120);
});
ui.older.addEventListener('click', () => { void loadOlder(); });
ui.workFilter.addEventListener('change', renderWorks);
ui.stopWork.addEventListener('click', () => { void stopWork(); });
ui.memorySearchBtn.addEventListener('click', () => { void searchMemories(); });
ui.memorySearchInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); void searchMemories(); }
});
ui.memoryFilterAll.addEventListener('click', () => setMemoryFilter('all'));
ui.memoryFilterPinned.addEventListener('click', () => setMemoryFilter('pinned'));
ui.memoryFilterSynapse.addEventListener('click', () => setMemoryFilter('synapse'));
ui.memoryCancelEditBtn.addEventListener('click', () => {
  resetMemoryForm();
  ui.memoryAddDetails.open = false;
});
ui.memorySaveBtn.addEventListener('click', () => { void saveMemoryFromUi(); });

ui.timerSaveBtn.addEventListener('click', () => { void addTimerFromUi(); });
for (const chip of document.querySelectorAll<HTMLButtonElement>('[data-timer-name]')) {
  chip.addEventListener('click', () => {
    ui.timerNameInput.value = chip.dataset.timerName ?? '';
    ui.timerDailyInput.value = chip.dataset.timerDaily ?? '';
    ui.timerIntervalInput.value = chip.dataset.timerSec ?? '300';
    ui.timerPluginInput.value = chip.dataset.timerPlugin
      ? `${chip.dataset.timerPlugin}${chip.dataset.timerAction ? `/${chip.dataset.timerAction}` : ''}`
      : '';
    ui.timerChannelInput.value = chip.dataset.timerChannel ?? '';
    ui.timerInstructionInput.value = chip.dataset.timerCmd ?? '';
    ui.timerAddDetails.open = true;
    ui.timerInstructionInput.focus();
  });
}
for (const quickBtn of document.querySelectorAll<HTMLButtonElement>('[data-interval-sec]')) {
  quickBtn.addEventListener('click', () => {
    ui.timerIntervalInput.value = quickBtn.dataset.intervalSec ?? '300';
  });
}

ui.imCancelEditBtn.addEventListener('click', () => {
  resetImChannelForm();
  ui.imAddDetails.open = false;
});
ui.imSaveBtn.addEventListener('click', () => { void saveImChannelFromUi(); });
ui.imWechatQrBtn.addEventListener('click', () => { void startWechatQrFromUi(); });
ui.imWechatQrRefresh.addEventListener('click', () => { void startWechatQrFromUi(activeWechatQrChannelId); });
ui.imWechatQrClose.addEventListener('click', closeWechatQrFromUi);

ui.openMemoryHubTop.addEventListener('click', () => openMemoryHubModal());
ui.memoryModalClose.addEventListener('click', closeMemoryHubModal);
ui.memoryHubBackdrop.addEventListener('click', event => {
  if (event.target === ui.memoryHubBackdrop) closeMemoryHubModal();
});

ui.openTimerHubTop.addEventListener('click', () => openTimerHubModal());
ui.timerModalClose.addEventListener('click', closeTimerHubModal);
ui.timerHubBackdrop.addEventListener('click', event => {
  if (event.target === ui.timerHubBackdrop) closeTimerHubModal();
});

ui.openPluginHubTop.addEventListener('click', () => openPluginHubModal());
ui.pluginModalClose.addEventListener('click', closePluginHubModal);
ui.pluginHubBackdrop.addEventListener('click', event => {
  if (event.target === ui.pluginHubBackdrop) closePluginHubModal();
});

ui.openImHubTop.addEventListener('click', () => openImHubModal());
ui.imModalClose.addEventListener('click', closeImHubModal);
ui.imHubBackdrop.addEventListener('click', event => {
  if (event.target === ui.imHubBackdrop) closeImHubModal();
});

ui.openModelHubTop.addEventListener('click', () => openModelHubModal());
ui.modelModalClose.addEventListener('click', closeModelHubModal);
ui.modelHubBackdrop.addEventListener('click', event => {
  if (event.target === ui.modelHubBackdrop) closeModelHubModal();
});
ui.modalRouterProviderSelect.addEventListener('change', () => {
  ui.modalRouterProbeResult.hidden = true;
  syncModalRouterModels();
});
ui.modalAuthToggleBtn.addEventListener('click', () => {
  const currentProv = view?.modelHub?.providers.find(p => p.id === activeAuthProviderTab);
  if (!currentProv) return;
  void toggleProviderEnabledFromUi(currentProv.id, currentProv.enabled === false);
});
ui.modalAuthFetchBtn.addEventListener('click', () => { void fetchAuthProviderModelsFromModal(); });
ui.modalAuthTestBtn.addEventListener('click', () => { void testAuthProviderFromModal(false); });
ui.modalAuthSaveTestBtn.addEventListener('click', () => { void testAuthProviderFromModal(true); });
ui.modalAuthClearBtn.addEventListener('click', () => { void clearAuthProviderFromModal(); });
ui.customProvSaveBtn.addEventListener('click', () => { void addCustomProviderFromModal(); });
ui.modalTestRouterBtn.addEventListener('click', () => {
  void runInlineProbe(ui.modalRouterProviderSelect.value, ui.modalRouterModelSelect.value, ui.modalRouterProbeResult, ui.modalTestRouterBtn);
});
ui.modalSaveRoutingBtn.addEventListener('click', () => { void saveModalRoutingFromUi(); });
ui.reconnect.addEventListener('click', () => { retryDelay = 500; void connect(); });
ui.traceMore.addEventListener('click', () => { void loadTrace(traceMode === 'steps' ? 'earlier' : 'live'); });
ui.traceRetry.addEventListener('click', () => { void loadTrace(traceEvents.length ? 'live' : 'recent'); });
element('clear-filter').addEventListener('click', () => selectTrace({ type: 'all' }));
ui.stepMode.addEventListener('click', () => setTraceMode('steps'));
ui.graphMode.addEventListener('click', () => setTraceMode('graph'));
ui.timelineMode.addEventListener('click', () => setTraceMode('events'));
function setTraceMode(mode: 'steps' | 'graph' | 'events') {
  if (traceMode === mode) return;
  traceMode = mode;
  if (mode === 'steps') { selectedEvent = undefined; selectedSpan = undefined; }
  for (const [key, control] of [['steps', ui.stepMode], ['graph', ui.graphMode], ['events', ui.timelineMode]] as const) {
    control.classList.toggle('active', key === mode);
    control.setAttribute('aria-pressed', String(key === mode));
  }
  renderTrace();
  // The readable process must open where the work is now, not replay a very long history from its first event.
  if (mode === 'steps' && traceHasMore && traceEvents.length) void loadTrace('recent');
}
ui.showChat.addEventListener('click', () => showPanel(false));
ui.showTrace.addEventListener('click', () => showPanel(true));
ui.workToggle.addEventListener('click', () => {
  const open = ui.sidebar.classList.toggle('open');
  ui.workToggle.setAttribute('aria-expanded', String(open));
  if (open) ui.workFilter.focus();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && (!ui.memoryHubBackdrop.hidden || !ui.timerHubBackdrop.hidden || !ui.pluginHubBackdrop.hidden || !ui.imHubBackdrop.hidden || !ui.modelHubBackdrop.hidden)) {
    closeAllHubModals();
    return;
  }
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

import type { ChatMessage, MainView, TraceEvent } from '../view.js';
import { activeStatus as active } from './model.js';
import {
  createLiveBotAvatar,
  deriveFridayBotState,
} from './shared/bot-avatar.js';
import { createSharedSseHub, type SseUpdateBatch } from './shared/sse-hub.js';
import { element, node } from './shared/dom.js';
import { errorText } from './shared/format.js';
import { initChatPanel } from './panels/chat.js';
import { initTracePanel } from './panels/trace.js';
import { initMemoryHub } from './hubs/memory-hub.js';
import { initTimerPluginHub } from './hubs/timer-plugin-hub.js';
import { initImVoiceHub } from './hubs/im-voice-hub.js';
import { initModelHub } from './hubs/model-hub.js';
import { initUsageHub } from './hubs/usage-hub.js';
import type { HealthScaleUiController } from './plugins/health-scale-ui.js';
import { api, appState, fetchMessagesBatch, hooks, request } from './state.js';

const connectionEl = element('connection');
const reconnectBtn = element<HTMLButtonElement>('reconnect');
const modeEl = element('mode');
const openHealthHubTop = element<HTMLButtonElement>('open-health-hub-top');
const memoryHubBackdrop = element<HTMLElement>('memory-hub-backdrop');
const timerHubBackdrop = element<HTMLElement>('timer-hub-backdrop');
const pluginHubBackdrop = element<HTMLElement>('plugin-hub-backdrop');
const imHubBackdrop = element<HTMLElement>('im-hub-backdrop');
const modelHubBackdrop = element<HTMLElement>('model-hub-backdrop');
const usageHubBackdrop = element<HTMLElement>('usage-hub-backdrop');
const healthHubBackdrop = element<HTMLElement>('health-hub-backdrop');
const messagesEl = element('messages');
const worksEl = element('works');
const companionEl = element('companion-avatar');

const companionAvatar = createLiveBotAvatar({
  size: 38,
  interactive: true,
  idPrefix: 'friday-companion',
});
companionEl.replaceChildren(companionAvatar.svg);
companionEl.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    companionAvatar.poke('bounce');
  }
});
window.addEventListener('pointermove', event => {
  const rect = companionEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  companionAvatar.setGaze((event.clientX - cx) / 360, -(event.clientY - cy) / 280);
}, { passive: true });
window.addEventListener('pointerleave', () => {
  companionAvatar.setGaze(0, 0);
});

let staleConnection = false;
let transientCompanionState: 'finished' | 'failed' | undefined;
let transientCompanionTimer: ReturnType<typeof setTimeout> | undefined;
const trackedActiveMessages = new Set<string>();
const trackedActiveWorks = new Set<string>();

function syncCompanionState(): void {
  if (transientCompanionState && appState.ready && !appState.authExpired) {
    companionAvatar.setState(transientCompanionState);
    return;
  }
  const next = deriveFridayBotState({
    ready: appState.ready,
    authExpired: appState.authExpired,
    staleConnection,
    sending: appState.sending,
    draftTyping: chatPanel.isDraftTyping(),
    messages: appState.messages.values(),
    works: appState.view?.works ?? [],
  });
  companionAvatar.setState(next);
}

function triggerTransientCompanion(state: 'finished' | 'failed', durationMs: number): void {
  if (transientCompanionTimer) clearTimeout(transientCompanionTimer);
  transientCompanionState = state;
  companionAvatar.setState(state);
  transientCompanionTimer = setTimeout(() => {
    transientCompanionTimer = undefined;
    transientCompanionState = undefined;
    syncCompanionState();
  }, durationMs);
}

function trackCompanionTransitions(initial = false): void {
  let completedNow = false;
  let failedNow = false;

  if (!initial) {
    for (const id of trackedActiveMessages) {
      const msg = appState.messages.get(id);
      if (!msg || active(msg.status)) continue;
      if (msg.status === 'failed') failedNow = true;
      else if (msg.status === 'completed' && msg.role === 'assistant') completedNow = true;
    }
    for (const id of trackedActiveWorks) {
      const work = appState.view?.works.find(item => item.id === id);
      if (!work || work.status === 'queued' || work.status === 'running') continue;
      if (work.status === 'failed') failedNow = true;
      else if (work.status === 'completed') completedNow = true;
    }
  }

  trackedActiveMessages.clear();
  for (const msg of appState.messages.values()) {
    if (active(msg.status)) trackedActiveMessages.add(msg.id);
  }
  trackedActiveWorks.clear();
  for (const work of appState.view?.works ?? []) {
    if (work.status === 'queued' || work.status === 'running') trackedActiveWorks.add(work.id);
  }

  if (failedNow) triggerTransientCompanion('failed', 2500);
  else if (completedNow) triggerTransientCompanion('finished', 2300);
  else syncCompanionState();
}

const chatPanel = initChatPanel({ onDraftActivity: syncCompanionState });
const tracePanel = initTracePanel();
const memoryHub = initMemoryHub();
const timerPluginHub = initTimerPluginHub();
const imVoiceHub = initImVoiceHub();
const modelHub = initModelHub();
const usageHub = initUsageHub();

let healthScaleUi: HealthScaleUiController | undefined;
let healthScaleLoadPromise: Promise<HealthScaleUiController> | undefined;

async function loadHealthScaleUi(): Promise<HealthScaleUiController> {
  if (healthScaleUi) return healthScaleUi;
  if (!healthScaleLoadPromise) {
    healthScaleLoadPromise = import('./plugins/health-scale-ui.js')
      .then(mod => {
        healthScaleUi = mod.initHealthScaleUi();
        return healthScaleUi;
      })
      .catch(error => {
        healthScaleLoadPromise = undefined;
        throw error;
      });
  }
  return healthScaleLoadPromise;
}

function connection(text: string, stale = false): void {
  if (appState.authExpired) {
    text = '访问链接已失效。请从当前服务的本地启动链接重新进入（服务重启后需使用新链接）。';
    stale = true;
  }
  staleConnection = stale;
  connectionEl.textContent = text;
  connectionEl.parentElement?.classList.toggle('stale', stale);
  syncCompanionState();
}

function closeAllHubModals(): void {
  memoryHub.closeModal();
  timerPluginHub.closeTimerModal();
  timerPluginHub.closePluginModal();
  imVoiceHub.closeModal();
  modelHub.closeModal();
  usageHub.closeModal();
  healthScaleUi?.closeModal();
  healthHubBackdrop.hidden = true;
}

function expireAuthentication(): void {
  appState.authExpired = true;
  appState.ready = false;
  sseHub.stop();
  if (appState.reconnectTimer) { clearTimeout(appState.reconnectTimer); appState.reconnectTimer = undefined; }
  if (appState.refreshTimer) { clearTimeout(appState.refreshTimer); appState.refreshTimer = undefined; }
  imVoiceHub.stopWechatQrPoll();
  healthScaleUi?.closeModal();
  connection('访问链接已失效。请从当前服务的本地启动链接重新进入（服务重启后需使用新链接）。', true);
  reconnectBtn.disabled = true;
  chatPanel.updateComposer();
  tracePanel.renderWorks();
  memoryHub.render();
  timerPluginHub.renderTimers();
  timerPluginHub.renderPlugins();
  imVoiceHub.render();
  modelHub.render();
  usageHub.render();
  chatPanel.renderMessages();
  syncCompanionState();
}

function followLatestMessage(): void {
  if (appState.selectionPinned) return;
  const latest = [...appState.messages.values()]
    .filter(message => message.role === 'user')
    .sort((a, b) => b.seq - a.seq)[0];
  if (!latest || latest.id === appState.followedMessage) return;
  tracePanel.selectTrace({ type: 'message', id: latest.id, label: latest.text.slice(0, 80) }, false);
}

function scheduleRefresh(): void {
  if (appState.refreshTimer || appState.authExpired) return;
  appState.refreshTimer = setTimeout(() => {
    appState.refreshTimer = undefined;
    void refreshView().catch(error => {
      connection(`数据可能已过时：${errorText(error)}。后台工作不会因页面断开而停止。`, true);
    });
    if (!appState.traceHasMore) void tracePanel.loadTrace('live');
  }, 150);
}

let activeRefresh: Promise<void> | undefined;
let refreshRunSeq = 0;

async function refreshView(initial = false): Promise<void> {
  if (activeRefresh) {
    appState.refreshAgain = true;
    await activeRefresh;
    if (!initial || appState.view || appState.authExpired) return;
  }
  const runSeq = ++refreshRunSeq;
  appState.refreshBusy = true;
  const run = (async () => {
    try {
      const result = await api<MainView>('/api/view');
      const selectedTaskId = appState.selection.type === 'task' ? appState.selection.id : undefined;
      const previousWorkStatus = appState.view?.works.find(work => work.id === selectedTaskId)?.status;
      const cursorReset = !initial && result.cursor < appState.cursor;
      appState.view = result;
      appState.voiceprintState = result.voiceprint;
      if (cursorReset) {
        appState.messages.clear();
        appState.followedMessage = undefined;
        appState.traceAfter = 0;
        appState.traceEvents = [];
        appState.traceHasMore = false;
        appState.traceHasEarlier = false;
        appState.historyBefore = result.messages.before;
        appState.historyHasMore = result.messages.hasMore;
        appState.cursor = result.cursor;
        sseHub.setCursor(result.cursor);
      }
      for (const work of result.works) {
        if (['completed', 'failed', 'cancelled'].includes(work.status)) {
          appState.stopRequests.delete(`task:${work.id}`);
        }
      }
      for (const message of result.messages.items) {
        if (!active(message.status)) appState.stopRequests.delete(`message:${message.id}`);
      }
      appState.ready = true;
      chatPanel.mergeMessages(result.messages.items);
      await chatPanel.hydrateParents();
      if (initial || appState.historyBefore === undefined) {
        appState.historyBefore = result.messages.before;
        appState.historyHasMore = result.messages.hasMore;
      }
      if (initial) {
        appState.cursor = result.cursor;
        sseHub.setCursor(result.cursor);
      }
      modeEl.textContent = result.mode === 'offline' ? '离线模拟' : '真实模式';
      modeEl.classList.toggle('offline', result.mode === 'offline');
      chatPanel.renderMessages();
      tracePanel.renderWorks();
      memoryHub.render();
      timerPluginHub.renderTimers();
      timerPluginHub.renderPlugins();
      imVoiceHub.render();
      modelHub.render();
      usageHub.render();
      const healthPlugin = appState.view?.plugins?.find(p => p.name === 'health-scale');
      const healthEnabled = healthPlugin ? healthPlugin.enabled !== false : false;
      openHealthHubTop.hidden = !healthEnabled;
      if (!healthEnabled && !healthHubBackdrop.hidden) {
        healthScaleUi?.closeModal();
        healthHubBackdrop.hidden = true;
      }
      chatPanel.updateComposer();
      followLatestMessage();
      trackCompanionTransitions(initial);
      if (
        !initial
        && appState.selection.type === 'task'
        && result.works.find(work => work.id === selectedTaskId)?.status !== previousWorkStatus
      ) {
        void tracePanel.loadWork(appState.selection.id, appState.selectionGeneration, true);
      }
    } finally {
      appState.refreshBusy = false;
      if (refreshRunSeq === runSeq) activeRefresh = undefined;
      if (appState.refreshAgain && !appState.authExpired) {
        appState.refreshAgain = false;
        scheduleRefresh();
      }
    }
  })();
  activeRefresh = run;
  return run;
}

Object.assign(hooks, {
  connection,
  expireAuthentication,
  refreshView,
  scheduleRefresh,
  updateComposer: chatPanel.updateComposer,
  renderMessages: chatPanel.renderMessages,
  renderRoutingDetail: chatPanel.renderRoutingDetail,
  jumpMessage: chatPanel.jumpMessage,
  renderWorks: tracePanel.renderWorks,
  stopWork: tracePanel.stopWork,
  showPanel: tracePanel.showPanel,
  closeSidebar: tracePanel.closeSidebar,
  selectTrace: tracePanel.selectTrace,
  loadTrace: tracePanel.loadTrace,
  loadWork: tracePanel.loadWork,
  openPluginHubModal: timerPluginHub.openPluginModal,
  closeAllHubModals,
});

const sseHub = createSharedSseHub({
  token: appState.token,
  request,
  isStopped: () => appState.authExpired,
  onConnected: viaLeader => {
    reconnectBtn.disabled = false;
    const runtimeStatus = appState.view?.health.executorAvailable === false ? '执行器不可用，服务降级' : '后台服务持续运行';
    const prefix = viaLeader ? '本机已连接（共享流）' : '本机已连接';
    connection(`${prefix} · ${runtimeStatus}${appState.storageUnavailable ? ' · 当前标签页无法保存访问链接' : ''}`);
  },
  onError: error => {
    if (appState.authExpired) return;
    connection(`连接已断开 / 数据可能过时：${errorText(error)}。后台工作继续；消息不会自动重发。`, true);
    reconnectBtn.disabled = false;
  },
  onUpdates: async (batch: SseUpdateBatch) => {
    if (appState.authExpired) return;
    const cursorReset = Boolean(batch.reset) || batch.cursor < appState.cursor;
    if (cursorReset) {
      appState.messages.clear();
      appState.followedMessage = undefined;
      appState.traceAfter = 0;
      appState.traceEvents = [];
      appState.cursor = batch.cursor;
      scheduleRefresh();
      return;
    }
    const fresh = batch.events.filter(event => event.seq > appState.cursor);
    const ids = [...new Set(
      fresh
        .filter(event => event.type === 'message' || event.kind === 'work_linked')
        .map(event => event.messageId)
        .filter((id): id is string => Boolean(id)),
    )];
    const changed = ids.length ? await fetchMessagesBatch(ids) : [];
    if (appState.authExpired) return;
    chatPanel.mergeMessages(changed);
    await chatPanel.hydrateParents();
    if (changed.length) {
      chatPanel.renderMessages();
      trackCompanionTransitions(false);
    }
    appState.cursor = Math.max(appState.cursor, batch.cursor);
    if (fresh.length) scheduleRefresh();
  },
});

window.addEventListener('pagehide', () => { sseHub.stop(); });

let sseStarted = false;

async function connect(forceReconnect = false): Promise<void> {
  if (!appState.token || appState.authExpired) return;
  const generation = ++appState.connectionGeneration;
  if (appState.reconnectTimer) { clearTimeout(appState.reconnectTimer); appState.reconnectTimer = undefined; }
  reconnectBtn.disabled = true;
  connection(appState.ready ? '正在恢复连接，保留上次数据…' : '正在连接本机服务…', appState.ready);
  try {
    const initial = !appState.view;
    await refreshView(initial);
    if (generation !== appState.connectionGeneration || appState.authExpired) return;
    if (initial) {
      const latest = [...appState.messages.values()]
        .sort((a, b) => b.seq - a.seq)
        .find(message => message.role === 'user');
      tracePanel.selectTrace(
        latest ? { type: 'message', id: latest.id, label: latest.text.slice(0, 80) } : { type: 'all' },
        false,
      );
    } else if (!appState.traceHasMore) {
      void tracePanel.loadTrace('live');
    }
    appState.retryDelay = 500;
    reconnectBtn.disabled = false;
    if (forceReconnect && sseStarted) {
      sseHub.reconnect(appState.cursor);
    } else {
      sseStarted = true;
      sseHub.start(appState.cursor);
    }
  } catch (error) {
    if (generation !== appState.connectionGeneration || appState.authExpired) return;
    connection(`连接已断开 / 数据可能过时：${errorText(error)}。后台工作继续；消息不会自动重发。`, true);
    reconnectBtn.disabled = false;
    appState.reconnectTimer = setTimeout(() => { void connect(forceReconnect); }, appState.retryDelay);
    appState.retryDelay = Math.min(appState.retryDelay * 2, 5000);
  }
}

reconnectBtn.addEventListener('click', () => { appState.retryDelay = 500; void connect(true); });

openHealthHubTop.addEventListener('click', () => {
  openHealthHubTop.disabled = true;
  void loadHealthScaleUi()
    .then(ctrl => ctrl.openModal())
    .catch(error => connection(`加载健康体脂看板模块失败：${errorText(error)}`, true))
    .finally(() => { openHealthHubTop.disabled = false; });
});

const modalBackdrops = [memoryHubBackdrop, timerHubBackdrop, pluginHubBackdrop, imHubBackdrop, modelHubBackdrop, usageHubBackdrop, healthHubBackdrop];
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (memoryHub.isImmersive()) {
    event.preventDefault();
    memoryHub.exitImmersive();
  } else if (modalBackdrops.some(el => !el.hidden)) {
    closeAllHubModals();
  } else if (tracePanel.isSidebarOpen()) {
    tracePanel.closeSidebar();
    tracePanel.focusSidebarToggle();
  }
});

if (appState.token) {
  void connect();
} else {
  connection('缺少有效的本机访问链接。请从当前服务生成的本地启动链接进入；无需在页面输入 API 密钥。', true);
  reconnectBtn.disabled = true;
  messagesEl.replaceChildren(node('p', '请使用带访问令牌的本地启动链接。对话与后台工作由本机服务保存。', 'empty'));
  worksEl.replaceChildren(node('p', '连接本机服务后显示后台工作。', 'empty'));
}

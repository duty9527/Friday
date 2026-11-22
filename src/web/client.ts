import type { ChatMessage, MainView } from '../view.js';
import { activeStatus as active } from './model.js';
import {
  createLiveBotAvatar,
  deriveFridayBotState,
  type BotPokeKind,
} from './shared/bot-avatar.js';
import { createSharedSseHub, type SseUpdateBatch } from './shared/sse-hub.js';
import { element, node } from './shared/dom.js';
import { errorText } from './shared/format.js';
import { bindThemeButtons, initDesktopDrawers, syncThemeChrome } from './shared/theme.js';
import { initMobileViewport } from './shared/mobile-viewport.js';
import {
  announceStatus,
  isDialogOpen,
  onReducedMotionChange,
  prefersReducedMotion,
  safeFocus,
  scheduleBackgroundTask,
  setInertElements,
} from './shared/ui-primitives.js';
import { initChatPanel } from './panels/chat.js';
import { initTracePanel } from './panels/trace.js';
import { initMemoryHub } from './hubs/memory-hub.js';
import { initTimerPluginHub, type PluginSurfaceRegistration } from './hubs/timer-plugin-hub.js';
import { initImVoiceHub } from './hubs/im-voice-hub.js';
import { initNotebookHub } from './hubs/notebook-hub.js';
import { initSystemHub } from './hubs/system-hub.js';
import { api, appState, fetchMessagesBatch, hooks, request } from './state.js';

const connectionBannerEl = element('connection-banner');
const connectionEl = element('connection');
const reconnectBtn = element<HTMLButtonElement>('reconnect');
const memoryHubDialog = element<HTMLElement>('memory-hub-dialog');
const timerHubDialog = element<HTMLElement>('timer-hub-dialog');
const pluginHubDialog = element<HTMLElement>('plugin-hub-dialog');
const imHubDialog = element<HTMLElement>('im-hub-dialog');
const systemHubDialog = element<HTMLElement>('system-hub-dialog');
const appConfirmDialog = document.getElementById('app-confirm-dialog');
const healthSurfacePanel = element<HTMLElement>('plugin-panel-health-scale');
const fundSurfacePanel = element<HTMLElement>('plugin-panel-fund-tracker');
const cs80SurfacePanel = element<HTMLElement>('plugin-panel-cs80-face');
const laifenSurfacePanel = element<HTMLElement>('plugin-panel-laifen');
const ninebotSurfacePanel = element<HTMLElement>('plugin-panel-ninebot');
const netleaSurfacePanel = element<HTMLElement>('plugin-panel-netlea');
const appleSurfacePanel = element<HTMLElement>('plugin-panel-apple-devices');
const miotSurfacePanel = element<HTMLElement>('plugin-panel-miot');
const messagesEl = element('messages');
const worksEl = element('works');
const companionEl = element('companion-avatar');
const themeSpatialBtn = element<HTMLButtonElement>('theme-spatial-btn');
const themeIndustrialBtn = element<HTMLButtonElement>('theme-industrial-btn');
const themeSystemBtn = document.getElementById('theme-system-btn') as HTMLButtonElement | null;
const desktopWorkFoldBtn = element<HTMLButtonElement>('desktop-work-fold');
const desktopTraceFoldBtn = element<HTMLButtonElement>('desktop-trace-fold');
const mobileNavBtn = document.getElementById('mobile-nav-btn') as HTMLButtonElement | null;
const mobileNavCloseBtn = document.getElementById('mobile-nav-close') as HTMLButtonElement | null;
const mobileNavScrim = document.getElementById('mobile-nav-scrim');
const appTopbar = document.getElementById('app-topbar');
const mainContentEl = document.getElementById('main-content');
const workSidebarEl = document.getElementById('work-sidebar');

connectionBannerEl.removeAttribute?.('role');
connectionBannerEl.removeAttribute?.('aria-live');

const modalDialogs = [
  memoryHubDialog,
  timerHubDialog,
  pluginHubDialog,
  imHubDialog,
  systemHubDialog,
];

function hasOpenModal(): boolean {
  return modalDialogs.some(el => isDialogOpen(el)) || isDialogOpen(appConfirmDialog);
}

function setMobileNavOpen(open: boolean, restoreFocus = true): void {
  const wasOpen = document.body.classList.contains('mobile-nav-open');
  document.body.classList.toggle('mobile-nav-open', open);
  if (mobileNavScrim) mobileNavScrim.hidden = !open;
  mobileNavBtn?.setAttribute('aria-expanded', String(open));
  setInertElements([mainContentEl, workSidebarEl], open);
  if (open) {
    appTopbar?.setAttribute('role', 'dialog');
    appTopbar?.setAttribute('aria-modal', 'true');
    appTopbar?.setAttribute('aria-label', '功能导航菜单');
    const firstTarget = mobileNavCloseBtn
      ?? appTopbar?.querySelector<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')
      ?? null;
    safeFocus(firstTarget);
  } else {
    appTopbar?.removeAttribute?.('role');
    appTopbar?.removeAttribute?.('aria-modal');
    appTopbar?.removeAttribute?.('aria-label');
    syncThemeChrome();
    if (wasOpen && restoreFocus) {
      safeFocus(mobileNavBtn);
    }
  }
}

bindThemeButtons(themeSpatialBtn, themeIndustrialBtn, themeSystemBtn);
initMobileViewport();
initDesktopDrawers({
  leftBtn: desktopWorkFoldBtn,
  rightBtn: desktopTraceFoldBtn,
});

const companionAvatar = createLiveBotAvatar({
  size: 38,
  interactive: true,
  idPrefix: 'friday-companion',
});
companionEl.replaceChildren(companionAvatar.svg);
let companionPokeSeq = 0;
companionEl.addEventListener('click', () => {
  const seq: BotPokeKind[] = ['bounce', 'nod', 'spin'];
  const kind = seq[companionPokeSeq % seq.length]!;
  companionPokeSeq++;
  companionAvatar.poke(kind, kind === 'spin' ? 2 : 1);
});

let cachedCompanionRect: { left: number; top: number; width: number; height: number } | null = null;
let pendingPointerX = 0;
let pendingPointerY = 0;
let gazeRafId = 0;
let reducedMotionActive = prefersReducedMotion();

function refreshCompanionRect(): void {
  if (typeof companionEl.getBoundingClientRect !== 'function') return;
  const rect = companionEl.getBoundingClientRect();
  cachedCompanionRect = rect.width > 0 && rect.height > 0 ? rect : null;
}

function cancelPendingGaze(): void {
  if (gazeRafId && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(gazeRafId);
  }
  gazeRafId = 0;
}

function flushCompanionGaze(): void {
  gazeRafId = 0;
  if (reducedMotionActive || hasOpenModal()) return;
  if (!cachedCompanionRect) refreshCompanionRect();
  const rect = cachedCompanionRect;
  if (!rect || !rect.width || !rect.height) return;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  companionAvatar.setGaze((pendingPointerX - cx) / 360, -(pendingPointerY - cy) / 280);
}

if (typeof ResizeObserver === 'function') {
  const rectObserver = new ResizeObserver(() => refreshCompanionRect());
  rectObserver.observe(companionEl);
  if (mainContentEl) rectObserver.observe(mainContentEl);
  if (appTopbar) rectObserver.observe(appTopbar);
} else {
  refreshCompanionRect();
}
window.addEventListener('resize', refreshCompanionRect, { passive: true });
desktopWorkFoldBtn.addEventListener('click', () => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refreshCompanionRect);
  else refreshCompanionRect();
});
desktopTraceFoldBtn.addEventListener('click', () => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(refreshCompanionRect);
  else refreshCompanionRect();
});
onReducedMotionChange(reduced => {
  reducedMotionActive = reduced;
  if (reduced) {
    cancelPendingGaze();
    companionAvatar.setGaze(0, 0);
  }
});

window.addEventListener('pointermove', event => {
  if (reducedMotionActive || hasOpenModal()) return;
  pendingPointerX = event.clientX;
  pendingPointerY = event.clientY;
  if (typeof requestAnimationFrame === 'function') {
    if (!gazeRafId) gazeRafId = requestAnimationFrame(flushCompanionGaze);
  } else {
    flushCompanionGaze();
  }
}, { passive: true });
window.addEventListener('pointerleave', () => {
  cancelPendingGaze();
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
    chatPanel.updateCompanionStatus(transientCompanionState);
    return;
  }
  const next = deriveFridayBotState({
    ready: appState.ready,
    authExpired: appState.authExpired,
    staleConnection,
    sending: appState.sending,
    draftTyping: chatPanel.isDraftTyping(),
    voiceListening: Boolean(appState.view?.voiceListening?.capturing && !appState.view?.voiceListening?.transcribing),
    voiceTranscribing: Boolean(appState.view?.voiceListening?.transcribing),
    subconsciousSleeping: Boolean(appState.view?.subconscious?.sleeping),
    messages: appState.messages.values(),
    works: appState.view?.works ?? [],
  });
  companionAvatar.setState(next);
  chatPanel.updateCompanionStatus(next);
}

function triggerTransientCompanion(state: 'finished' | 'failed', durationMs: number): void {
  if (transientCompanionTimer) clearTimeout(transientCompanionTimer);
  transientCompanionState = state;
  companionAvatar.setState(state);
  chatPanel.updateCompanionStatus(state);
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

const pluginSurfaces: PluginSurfaceRegistration[] = [
  {
    pluginName: 'health-scale',
    tabId: 'plugin-tab-health-scale',
    panelId: 'plugin-panel-health-scale',
    label: '健康管理',
    messageTrigger: /体重|体脂|上秤|称重|health-scale/,
    load: () => import('./plugins/health-scale-ui.js').then(mod =>
      mod.initHealthScaleUi({
        isVisible: () => isDialogOpen(pluginHubDialog) && !healthSurfacePanel.hidden,
      })),
  },
  {
    pluginName: 'fund-tracker',
    tabId: 'plugin-tab-fund-tracker',
    panelId: 'plugin-panel-fund-tracker',
    label: '投资管理',
    messageTrigger: /持仓晚间结算|持仓午间估值|持仓总览|fund-tracker/,
    load: () => import('./plugins/fund-tracker-ui.js').then(mod =>
      mod.initFundTrackerUi({
        isVisible: () => isDialogOpen(pluginHubDialog) && !fundSurfacePanel.hidden,
      })),
  },
  {
    pluginName: 'cs80-face',
    tabId: 'plugin-tab-cs80-face',
    panelId: 'plugin-panel-cs80-face',
    label: 'CS80 副屏',
    messageTrigger: /CS80|cs80-face|副屏|Bento/,
    load: () => import('./plugins/cs80-face-ui.js').then(mod =>
      mod.initCs80FaceUi({
        isVisible: () => isDialogOpen(pluginHubDialog) && !cs80SurfacePanel.hidden,
      })),
  },
  {
    pluginName: 'laifen',
    tabId: 'plugin-tab-laifen',
    panelId: 'plugin-panel-laifen',
    label: '口腔护理',
    messageTrigger: /牙刷|徕芬|莱芬|刷头|口腔护理|laifen/,
    load: () => import('./plugins/laifen-ui.js').then(mod =>
      mod.initLaifenUi({
        isVisible: () => isDialogOpen(pluginHubDialog) && !laifenSurfacePanel.hidden,
      })),
  },
  {
    pluginName: 'ninebot',
    tabId: 'plugin-tab-ninebot',
    panelId: 'plugin-panel-ninebot',
    label: '九号守护',
    messageTrigger: /九号|电摩|电动车|小电驴|ninebot/,
    load: () => import('./plugins/ninebot-ui.js').then(mod =>
      mod.initNinebotUi({
        isVisible: () => isDialogOpen(pluginHubDialog) && !ninebotSurfacePanel.hidden,
      })),
  },
  {
    pluginName: 'netlea',
    tabId: 'plugin-tab-netlea',
    panelId: 'plugin-panel-netlea',
    label: '鱼缸灯光',
    messageTrigger: /鱼缸灯|尼特利|水草灯|netlea/i,
    load: () => import('./plugins/netlea-ui.js').then(mod =>
      mod.initNetleaUi({
        isVisible: () => isDialogOpen(pluginHubDialog) && !netleaSurfacePanel.hidden,
      })),
  },
  {
    pluginName: 'apple-devices',
    tabId: 'plugin-tab-apple-devices',
    panelId: 'plugin-panel-apple-devices',
    label: '苹果设备',
    messageTrigger: /iPhone|iPad|AirPods|Apple\s*Watch|Find\s*My|苹果设备|apple-devices/i,
    load: () => import('./plugins/apple-devices-ui.js').then(mod =>
      mod.initAppleDevicesUi({
        isVisible: () => isDialogOpen(pluginHubDialog) && !appleSurfacePanel.hidden,
      })),
  },
  {
    pluginName: 'miot',
    tabId: 'plugin-tab-miot',
    panelId: 'plugin-panel-miot',
    label: '米家中枢',
    messageTrigger: /米家|中枢|蓝牙\s*Mesh|极客版|自动化|空气炸锅|空调|miot/i,
    load: () => import('./plugins/miot-ui.js').then(mod =>
      mod.initMiotUi({
        isVisible: () => isDialogOpen(pluginHubDialog) && !miotSurfacePanel.hidden,
      })),
  },
];

const chatPanel = initChatPanel({ onDraftActivity: syncCompanionState });
const tracePanel = initTracePanel();
const memoryHub = initMemoryHub();
const timerPluginHub = initTimerPluginHub({ pluginSurfaces });
const imVoiceHub = initImVoiceHub();
const notebookHub = initNotebookHub();
const systemHub = initSystemHub();

type HubKey = 'memory' | 'timer' | 'plugin' | 'im' | 'notebook' | 'system';
const ALL_HUB_KEYS: readonly HubKey[] = ['memory', 'timer', 'plugin', 'im', 'notebook', 'system'];
const dirtyHubs = new Set<HubKey>();
let hubBgAbort: AbortController | undefined;

function isHubOpen(key: HubKey): boolean {
  switch (key) {
    case 'memory':
    case 'notebook':
      return isDialogOpen(memoryHubDialog);
    case 'timer':
      return isDialogOpen(timerHubDialog);
    case 'plugin':
      return isDialogOpen(pluginHubDialog);
    case 'im':
      return isDialogOpen(imHubDialog);
    case 'system':
      return isDialogOpen(systemHubDialog);
  }
}

function renderHubKey(key: HubKey, force = false): void {
  switch (key) {
    case 'memory':
      memoryHub.render(force);
      break;
    case 'timer':
      timerPluginHub.renderTimers(force);
      break;
    case 'plugin':
      timerPluginHub.renderPlugins(force);
      break;
    case 'im':
      imVoiceHub.render(force);
      break;
    case 'notebook':
      notebookHub.render(force);
      break;
    case 'system':
      systemHub.render(force);
      break;
  }
}

function flushDirtyHubs(): void {
  if (!dirtyHubs.size) return;
  for (const key of [...dirtyHubs]) {
    dirtyHubs.delete(key);
    renderHubKey(key);
  }
}

function syncHubRenders(): void {
  for (const key of ALL_HUB_KEYS) {
    if (isHubOpen(key)) {
      dirtyHubs.delete(key);
      renderHubKey(key);
    } else {
      dirtyHubs.add(key);
    }
  }
  if (dirtyHubs.size > 0) {
    hubBgAbort?.abort();
    hubBgAbort = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    scheduleBackgroundTask(flushDirtyHubs, hubBgAbort?.signal);
  }
}

let lastPluginCheckSeq = 0;
let lastConnectionAnnouncement = '';
let lastConnectionWasStale = false;

function connection(text: string, stale = false): void {
  if (appState.authExpired) {
    text = '访问链接已失效。请从当前服务的本地启动链接重新进入（服务重启后需使用新链接）。';
    stale = true;
  }
  staleConnection = stale;
  connectionBannerEl.hidden = !stale;
  connectionBannerEl.classList.toggle('stale', stale);
  connectionEl.textContent = stale ? text : '';
  if (stale) {
    if (text !== lastConnectionAnnouncement || !lastConnectionWasStale) {
      lastConnectionAnnouncement = text;
      lastConnectionWasStale = true;
      announceStatus(text, 'assertive');
    }
  } else if (lastConnectionWasStale) {
    lastConnectionAnnouncement = text;
    lastConnectionWasStale = false;
    announceStatus(text, 'polite');
  }
  syncCompanionState();
}

function closeAllHubModals(): void {
  memoryHub.closeModal();
  timerPluginHub.closeTimerModal();
  timerPluginHub.closePluginModal();
  imVoiceHub.closeModal();
  notebookHub.closeModal();
  systemHub.closeModal();
}

function expireAuthentication(): void {
  appState.authExpired = true;
  appState.ready = false;
  sseHub.stop();
  hubBgAbort?.abort();
  dirtyHubs.clear();
  if (appState.reconnectTimer) { clearTimeout(appState.reconnectTimer); appState.reconnectTimer = undefined; }
  if (appState.refreshTimer) { clearTimeout(appState.refreshTimer); appState.refreshTimer = undefined; }
  imVoiceHub.stopWechatQrPoll();
  timerPluginHub.deactivateActiveSurface();
  connection('访问链接已失效。请从当前服务的本地启动链接重新进入（服务重启后需使用新链接）。', true);
  reconnectBtn.disabled = true;
  chatPanel.updateComposer();
  tracePanel.renderWorks();
  for (const key of ALL_HUB_KEYS) renderHubKey(key);
  chatPanel.renderMessages();
  syncCompanionState();
}

function findLatestUserMessage(): ChatMessage | undefined {
  let latest: ChatMessage | undefined;
  for (const message of appState.messages.values()) {
    if (message.role === 'user' && (!latest || message.seq > latest.seq)) {
      latest = message;
    }
  }
  return latest;
}

function followLatestMessage(): void {
  if (appState.selectionPinned) return;
  const latest = findLatestUserMessage();
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
let pendingCursorReset = false;
let cursorResetEpoch = 0;

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
      const resetEpochAtStart = cursorResetEpoch;
      const hadPendingReset = pendingCursorReset;
      const result = await api<MainView>('/api/view', undefined, initial ? undefined : { priority: 'low' });
      const selectedTaskId = appState.selection.type === 'task' ? appState.selection.id : undefined;
      const previousWorkStatus = appState.view?.works.find(work => work.id === selectedTaskId)?.status;
      const cursorReset = !initial && (hadPendingReset || result.cursor < appState.cursor);
      if (hadPendingReset && cursorResetEpoch === resetEpochAtStart) {
        pendingCursorReset = false;
      }
      appState.view = result;
      appState.voiceprintState = result.voiceprint;
      if (cursorReset) {
        appState.messages.clear();
        appState.followedMessage = undefined;
        appState.selectionPinned = false;
        appState.traceAfter = 0;
        appState.traceEvents = [];
        appState.traceHasMore = false;
        appState.traceHasEarlier = false;
        appState.traceBundle = undefined;
        appState.workData = undefined;
        appState.operationTextCache.clear();
        appState.stopRequests.clear();
        appState.historyBefore = result.messages.before;
        appState.historyHasMore = result.messages.hasMore;
        appState.cursor = result.cursor;
        lastPluginCheckSeq = 0;
        sseHub.setCursor(result.cursor);
      }
      for (const work of result.works) {
        if (!active(work.status)) {
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
      chatPanel.renderMessages();
      tracePanel.renderWorks();
      syncHubRenders();
      const newMessages = result.messages.items.filter(m => m.seq > lastPluginCheckSeq);
      lastPluginCheckSeq = result.messages.items.reduce((acc, m) => Math.max(acc, m.seq), lastPluginCheckSeq);
      timerPluginHub.syncPluginSurfaces({
        initial,
        cursorReset,
        newMessages,
      });
      chatPanel.updateComposer();
      chatPanel.renderBossDecisionDock();
      followLatestMessage();
      if (cursorReset && !appState.followedMessage) {
        tracePanel.selectTrace({ type: 'all' }, false);
      }
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
  openSystemHubModal: systemHub.openModal,
  openNotebookHubModal: notebookHub.openModal,
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
      pendingCursorReset = true;
      cursorResetEpoch += 1;
      appState.messages.clear();
      appState.followedMessage = undefined;
      appState.selectionPinned = false;
      appState.traceAfter = 0;
      appState.traceEvents = [];
      appState.traceHasMore = false;
      appState.traceHasEarlier = false;
      appState.traceBundle = undefined;
      appState.workData = undefined;
      appState.operationTextCache.clear();
      appState.historyBefore = undefined;
      appState.historyHasMore = false;
      appState.stopRequests.clear();
      lastPluginCheckSeq = 0;
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
    const changed = ids.length ? await fetchMessagesBatch(ids, { priority: 'low' }) : [];
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

window.addEventListener('pagehide', () => {
  cancelPendingGaze();
  hubBgAbort?.abort();
  flushDirtyHubs();
  if (appState.refreshTimer) {
    clearTimeout(appState.refreshTimer);
    appState.refreshTimer = undefined;
  }
  sseHub.pause();
});

window.addEventListener('pageshow', event => {
  if (!event.persisted || appState.authExpired) return;
  syncThemeChrome();
  refreshCompanionRect();
  if (sseStarted) {
    sseHub.resume();
    scheduleRefresh();
  } else if (appState.token) {
    void connect(true);
  }
});

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
      if (appState.selectionGeneration === 0) {
        const latest = findLatestUserMessage();
        tracePanel.selectTrace(
          latest ? { type: 'message', id: latest.id, label: latest.text.slice(0, 80) } : { type: 'all' },
          false,
        );
      }
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

mobileNavBtn?.addEventListener('click', () => {
  const next = !document.body.classList.contains('mobile-nav-open');
  if (next) {
    tracePanel.showPanel(false, { restoreFocus: false });
    tracePanel.closeSidebar(false);
  }
  setMobileNavOpen(next, !next);
});
mobileNavCloseBtn?.addEventListener('click', () => {
  setMobileNavOpen(false, true);
});
mobileNavScrim?.addEventListener('click', () => {
  setMobileNavOpen(false, true);
});
appTopbar?.addEventListener('click', event => {
  if (!document.body.classList.contains('mobile-nav-open')) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (target.closest('#work-toggle, #open-memory-hub-top, #open-timer-hub-top, #open-plugin-hub-top, #open-im-hub-top, #open-system-hub-top')) {
    setMobileNavOpen(false, false);
  }
}, { capture: true });
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  try {
    const mobileNavMql = window.matchMedia('(max-width: 730px)');
    mobileNavMql.addEventListener?.('change', e => {
      if (!e.matches && document.body.classList.contains('mobile-nav-open')) {
        setMobileNavOpen(false, false);
      }
    });
  } catch {
    // Ignore matchMedia errors in stub environments
  }
}
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (memoryHub.isImmersive()) {
    event.preventDefault();
    memoryHub.exitImmersive();
  } else if (isDialogOpen(appConfirmDialog)) {
    return;
  } else if (modalDialogs.some(el => isDialogOpen(el))) {
    closeAllHubModals();
  } else if (document.body.classList.contains('mobile-nav-open')) {
    setMobileNavOpen(false, true);
  } else if (tracePanel.isSidebarOpen()) {
    tracePanel.closeSidebar();
  } else if (
    typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 730px)').matches
    && tracePanel.isTraceVisible()
  ) {
    tracePanel.showPanel(false);
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

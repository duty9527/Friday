import type { ImChannelView, PluginActionSpec, PluginView, TimerView } from '../../view.js';
import { button, element, isEditingWithin, kpiCard, node } from '../shared/dom.js';
import { errorText, formatIntervalText, json, timestamp } from '../shared/format.js';
import {
  classifyPluginActions,
  cleanPluginText,
  clearPluginOrder,
  createPluginIconSvg,
  createPluginPrefsSync,
  createUiIconSvg,
  filterAndGroupPlugins,
  formatActionDefaultArgs,
  formatPlatformsLabel,
  formatRuntimeLabel,
  getPluginDisplayTitle,
  getPluginDomainLabel,
  getPluginQuickCheckArgs,
  getPluginSpecs,
  getPluginStatusInfo,
  isCustomOrder,
  isSafeQuickRunAction,
  mergePluginOrder,
  movePluginStep,
  readPluginOrder,
  readSidebarCollapsed,
  reorderPluginList,
  resolvePluginActionLabel,
  summarizePluginRunMessage,
  writePluginOrder,
  writeSidebarCollapsed,
  type PluginCatalogFilter,
} from '../shared/plugin-catalog.js';
import { api, appState, hooks } from '../state.js';

export interface PluginSurfaceLifecycle {
  activate: () => void;
  deactivate: () => void;
  refreshBadge: () => Promise<void>;
}

export interface PluginSurfaceRegistration {
  pluginName: string;
  tabId: string;
  panelId: string;
  label: string;
  messageTrigger?: RegExp;
  load: () => Promise<PluginSurfaceLifecycle>;
}

export interface TimerPluginHubOptions {
  pluginSurfaces?: PluginSurfaceRegistration[];
}

export interface TimerPluginHubController {
  openTimerModal: () => void;
  closeTimerModal: () => void;
  renderTimers: (force?: boolean) => void;
  openPluginModal: (pluginName?: string, expandSource?: boolean, mode?: 'catalog' | 'surface') => void;
  closePluginModal: () => void;
  deactivateActiveSurface: () => void;
  renderPlugins: (force?: boolean) => void;
  syncPluginSurfaces: (opts: {
    initial: boolean;
    cursorReset: boolean;
    newMessages: readonly { seq: number; text: string }[];
  }) => void;
}

interface LiveBadgeSnapshot {
  text: string;
  tone: '' | 'ok' | 'warn' | 'err' | 'accent';
}

interface QuickCheckState {
  busy?: boolean;
  ok?: boolean;
  summary?: string;
}

interface PluginRunApiResponse {
  ok: boolean;
  plugin: string;
  action: string;
  notify: boolean;
  title?: string;
  message: string;
  data?: unknown;
}

const CHANNEL_PLATFORM_LABELS: Record<string, string> = {
  auto: '自动路由',
  wechat: '微信',
  xiaoai: '小爱音箱',
  dingtalk: '钉钉',
  telegram: 'Telegram',
};

function resolveDeliverChannelLabel(channelId: string, channels: readonly ImChannelView[] = []): string {
  const matched = channels.find(c => c.id === channelId);
  if (matched) return matched.name || CHANNEL_PLATFORM_LABELS[matched.platform] || matched.platform;
  if (channelId in CHANNEL_PLATFORM_LABELS) return CHANNEL_PLATFORM_LABELS[channelId]!;
  return /^(?:im|ch|chan)[_-]/i.test(channelId) || /^[0-9a-f-]{8,}$/i.test(channelId) ? '指定通道' : channelId;
}

function classifyBadgeTone(badgeEl: HTMLElement): LiveBadgeSnapshot['tone'] {
  if (badgeEl.classList.contains('badge-red') || badgeEl.classList.contains('fund-neg')) return 'err';
  if (badgeEl.classList.contains('badge-amber')) return 'warn';
  if (badgeEl.classList.contains('badge-green') || badgeEl.classList.contains('fund-pos')) return 'ok';
  const text = (badgeEl.textContent ?? '').trim();
  if (!text || text === '—' || text === '未绑定' || text === '待同步' || text === '待读') return '';
  if (/过期|离线|失败|告警/.test(text)) return 'err';
  if (/2FA|待机|需权限/.test(text)) return 'warn';
  return 'accent';
}

function isMobileViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth <= 720;
}

function isTabletViewport(): boolean {
  return typeof window !== 'undefined' && window.innerWidth > 720 && window.innerWidth <= 1024;
}

export function initTimerPluginHub(options: TimerPluginHubOptions = {}): TimerPluginHubController {
  const timerTopBadge = element<HTMLElement>('timer-top-badge');
  const openTimerHubTop = element<HTMLButtonElement>('open-timer-hub-top');
  const timerHubBackdrop = element<HTMLElement>('timer-hub-backdrop');
  const timerModalClose = element<HTMLButtonElement>('timer-modal-close');
  const timerKpiGrid = element<HTMLElement>('timer-kpi-grid');
  const timerAddDetails = element<HTMLDetailsElement>('timer-add-details');
  const timerPresetBar = element<HTMLElement>('timer-preset-bar');
  const timerNameInput = element<HTMLInputElement>('timer-name-input');
  const timerDailyInput = element<HTMLInputElement>('timer-daily-input');
  const timerIntervalInput = element<HTMLInputElement>('timer-interval-input');
  const timerPluginInput = element<HTMLInputElement>('timer-plugin-input');
  const timerChannelInput = element<HTMLInputElement>('timer-channel-input');
  const timerGoalInput = element<HTMLInputElement>('timer-goal-input');
  const timerMaxFailuresInput = element<HTMLInputElement>('timer-max-failures-input');
  const timerOnceInput = element<HTMLInputElement>('timer-once-input');
  const timerInstructionInput = element<HTMLTextAreaElement>('timer-instruction-input');
  const timerSaveBtn = element<HTMLButtonElement>('timer-save-btn');
  const timerListSubtitle = element<HTMLElement>('timer-list-subtitle');
  const timersList = element<HTMLElement>('timers-list');

  const pluginTopBadge = element<HTMLElement>('plugin-top-badge');
  const pluginCatalogBadge = element<HTMLElement>('plugin-catalog-badge');
  const openPluginHubTop = element<HTMLButtonElement>('open-plugin-hub-top');
  const pluginHubBackdrop = element<HTMLElement>('plugin-hub-backdrop');
  const pluginModalClose = element<HTMLButtonElement>('plugin-modal-close');
  const pluginModalTitle = element<HTMLElement>('plugin-modal-title');
  const pluginMobileNavBtn = element<HTMLButtonElement>('plugin-mobile-nav-btn');
  const pluginMobileNavLabel = element<HTMLElement>('plugin-mobile-nav-label');
  const pluginShell = element<HTMLElement>('plugin-shell');
  const pluginSidebarScrim = element<HTMLElement>('plugin-sidebar-scrim');
  const pluginSidebarToggle = element<HTMLButtonElement>('plugin-sidebar-toggle');
  const pluginSurfaceTabs = element<HTMLElement>('plugin-surface-tabs');
  const pluginNavSortable = element<HTMLElement>('plugin-nav-sortable');
  const pluginOrderResetBtn = element<HTMLButtonElement>('plugin-order-reset-btn');
  const pluginTabCatalog = element<HTMLButtonElement>('plugin-tab-catalog');
  const pluginPanelCatalog = element<HTMLElement>('plugin-panel-catalog');
  const pluginCatalogHome = element<HTMLElement>('plugin-catalog-home');
  const pluginCatalogDetail = element<HTMLElement>('plugin-catalog-detail');
  const pluginKpiGrid = element<HTMLElement>('plugin-kpi-grid');
  const pluginCatalogSearch = element<HTMLInputElement>('plugin-catalog-search');
  const pluginCatalogFilters = element<HTMLElement>('plugin-catalog-filters');
  const pluginListSubtitle = element<HTMLElement>('plugin-list-subtitle');
  const pluginsList = element<HTMLElement>('plugins-list');
  const pluginStage = pluginPanelCatalog.parentElement;

  const surfaces = (options.pluginSurfaces ?? []).map(reg => {
    const tabEl = element<HTMLButtonElement>(reg.tabId);
    const panelEl = element<HTMLElement>(reg.panelId);
    const badgeEl = tabEl.querySelector<HTMLElement>('.plugin-nav-badge');
    const dotEl = tabEl.querySelector<HTMLElement>('.plugin-nav-dot');
    return {
      reg,
      tabEl,
      panelEl,
      badgeEl,
      dotEl,
    };
  });
  const surfaceByName = new Map(surfaces.map(entry => [entry.reg.pluginName, entry]));
  const surfaceNames = new Set(surfaces.map(entry => entry.reg.pluginName));
  const defaultSurfaceOrder = surfaces.map(entry => entry.reg.pluginName);
  const surfaceLoadPromises = new Map<string, Promise<PluginSurfaceLifecycle>>();
  const surfaceControllers = new Map<string, PluginSurfaceLifecycle>();
  const surfaceBadgeSynced = new Set<string>();
  const liveBadges = new Map<string, LiveBadgeSnapshot>();
  const quickCheckStates = new Map<string, QuickCheckState>();

  let userCollapsedPref: boolean | null = readSidebarCollapsed();
  let pluginOrder: string[] = readPluginOrder();
  let activePluginTab = 'catalog';
  let activeSurfaceCtrl: PluginSurfaceLifecycle | undefined;
  let tabSwitchSeq = 0;

  let catalogFilter: PluginCatalogFilter = 'all';
  let catalogQuery = '';
  let detailPluginName: string | undefined;
  let detailSubTab: 'overview' | 'dev' = 'overview';
  let detailInitialAction: string | undefined;
  let suppressClickUntil = 0;
  let resizeDispatchTimer: ReturnType<typeof setTimeout> | undefined;

  function resolveEffectiveCollapsed(): boolean {
    if (isMobileViewport()) return false;
    if (userCollapsedPref !== null) return userCollapsedPref;
    return isTabletViewport();
  }

  function dispatchStageResize(): void {
    if (typeof window === 'undefined' || pluginHubBackdrop.hidden) return;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    }
    if (resizeDispatchTimer !== undefined) clearTimeout(resizeDispatchTimer);
    resizeDispatchTimer = setTimeout(() => {
      resizeDispatchTimer = undefined;
      if (!pluginHubBackdrop.hidden) {
        window.dispatchEvent(new Event('resize'));
      }
    }, 320);
  }

  function setMobileNavOpen(open: boolean): void {
    const effective = open && isMobileViewport();
    pluginShell.classList.toggle('is-mobile-nav-open', effective);
    pluginSidebarScrim.hidden = !effective;
    pluginMobileNavBtn.setAttribute('aria-expanded', String(effective));
  }

  function applySidebarCollapsed(collapsed: boolean, emitResize = false): void {
    const changed = pluginShell.classList.contains('is-sidebar-collapsed') !== collapsed;
    pluginShell.classList.toggle('is-sidebar-collapsed', collapsed);
    pluginSidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    pluginSidebarToggle.setAttribute('aria-label', collapsed ? '展开侧边栏' : '收起侧边栏');
    pluginSidebarToggle.title = collapsed ? '展开侧边栏' : '收起为仅图标模式';
    pluginSidebarToggle.replaceChildren(
      createUiIconSvg(collapsed ? 'sidebar-expand' : 'sidebar-collapse', 'plugin-ui-svg', 16),
    );
    if (emitResize && changed) {
      dispatchStageResize();
    }
  }

  function applySidebarOrder(): void {
    const ordered = mergePluginOrder(pluginOrder, defaultSurfaceOrder);
    for (const name of ordered) {
      const entry = surfaceByName.get(name);
      if (entry) pluginNavSortable.append(entry.tabEl);
    }
    pluginOrderResetBtn.hidden = !isCustomOrder(pluginOrder, defaultSurfaceOrder);
  }

  const prefsSync = createPluginPrefsSync({
    onCollapsed: next => {
      userCollapsedPref = next;
      applySidebarCollapsed(resolveEffectiveCollapsed(), true);
    },
    onOrder: next => {
      pluginOrder = next;
      applySidebarOrder();
      if (!pluginHubBackdrop.hidden && activePluginTab === 'catalog' && !detailPluginName) {
        renderPlugins(true);
      }
    },
  });

  function commitPluginOrder(nextOrder: string[]): void {
    pluginOrder = nextOrder;
    writePluginOrder(nextOrder);
    prefsSync.broadcastOrder(nextOrder);
    applySidebarOrder();
    if (!pluginHubBackdrop.hidden && activePluginTab === 'catalog' && !detailPluginName) {
      renderPlugins(true);
    }
  }

  function syncSurfaceBadgeMeta(entry: (typeof surfaces)[number]): void {
    const text = (entry.badgeEl?.textContent ?? '').trim();
    const tone = entry.badgeEl ? classifyBadgeTone(entry.badgeEl) : '';
    const hasMeaningfulValue = Boolean(text && text !== '—');
    entry.tabEl.title = hasMeaningfulValue ? `${entry.reg.label} · ${text}` : entry.reg.label;
    if (entry.dotEl) {
      entry.dotEl.className = tone ? `plugin-nav-dot tone-${tone}` : 'plugin-nav-dot';
      entry.dotEl.hidden = !tone;
    }
    liveBadges.set(entry.reg.pluginName, { text, tone });

    const cardBadge = pluginsList.querySelector<HTMLElement>(`[data-live-badge="${entry.reg.pluginName}"]`);
    if (cardBadge) {
      cardBadge.textContent = text || '—';
      cardBadge.hidden = !hasMeaningfulValue;
      cardBadge.className = `hub-badge plugin-card-live-badge${
        tone === 'ok'
          ? ' badge-green'
          : tone === 'warn'
            ? ' badge-amber'
            : tone === 'err'
              ? ' badge-red'
              : ' badge-slate'
      }`;
    }
  }

  for (const entry of surfaces) {
    syncSurfaceBadgeMeta(entry);
    if (entry.badgeEl && typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(() => syncSurfaceBadgeMeta(entry));
      observer.observe(entry.badgeEl, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });
    }
  }

  function syncHeaderContext(): void {
    if (activePluginTab === 'catalog') {
      if (detailPluginName) {
        const matched = appState.view?.plugins?.find(p => p.name === detailPluginName);
        const title = matched ? getPluginDisplayTitle(matched) : detailPluginName;
        pluginModalTitle.textContent = `插件详情 · ${title}`;
        pluginMobileNavLabel.textContent = '插件目录';
      } else {
        pluginModalTitle.textContent = '应用与插件';
        pluginMobileNavLabel.textContent = '插件目录';
      }
      return;
    }
    const entry = surfaceByName.get(activePluginTab);
    const label = entry?.reg.label ?? activePluginTab;
    pluginModalTitle.textContent = `应用与插件 · ${label}`;
    pluginMobileNavLabel.textContent = label;
  }

  function isSurfaceEnabled(pluginName: string): boolean {
    const plugin = appState.view?.plugins?.find(p => p.name === pluginName);
    return plugin ? plugin.enabled !== false : false;
  }

  function loadSurfaceController(reg: PluginSurfaceRegistration): Promise<PluginSurfaceLifecycle> {
    const existing = surfaceControllers.get(reg.pluginName);
    if (existing) return Promise.resolve(existing);
    let pending = surfaceLoadPromises.get(reg.pluginName);
    if (!pending) {
      pending = reg.load()
        .then(ctrl => {
          surfaceControllers.set(reg.pluginName, ctrl);
          return ctrl;
        })
        .catch(error => {
          surfaceLoadPromises.delete(reg.pluginName);
          throw error;
        });
      surfaceLoadPromises.set(reg.pluginName, pending);
    }
    return pending;
  }

  function deactivateActiveSurface(): void {
    activeSurfaceCtrl?.deactivate();
    activeSurfaceCtrl = undefined;
  }

  function syncPluginTabElements(): void {
    const isCatalog = activePluginTab === 'catalog';
    pluginTabCatalog.classList.toggle('active', isCatalog);
    pluginTabCatalog.setAttribute('aria-selected', isCatalog ? 'true' : 'false');
    pluginPanelCatalog.hidden = !isCatalog;

    for (const entry of surfaces) {
      const selected = activePluginTab === entry.reg.pluginName;
      entry.tabEl.classList.toggle('active', selected);
      entry.tabEl.setAttribute('aria-selected', selected ? 'true' : 'false');
      entry.panelEl.hidden = !selected;
    }
    syncHeaderContext();
  }

  function switchPluginTab(targetTab: string): void {
    const entry = targetTab === 'catalog' ? undefined : surfaceByName.get(targetTab);
    const resolvedTab = entry && isSurfaceEnabled(entry.reg.pluginName) ? targetTab : 'catalog';
    const seq = ++tabSwitchSeq;

    if (activePluginTab !== resolvedTab) {
      deactivateActiveSurface();
    }
    activePluginTab = resolvedTab;
    setMobileNavOpen(false);
    syncPluginTabElements();

    if (resolvedTab === 'catalog') {
      renderPlugins(true);
      return;
    }

    if (!entry) return;
    surfaceBadgeSynced.add(entry.reg.pluginName);
    void loadSurfaceController(entry.reg)
      .then(ctrl => {
        if (seq !== tabSwitchSeq || pluginHubBackdrop.hidden || activePluginTab !== resolvedTab) {
          return;
        }
        activeSurfaceCtrl = ctrl;
        ctrl.activate();
        dispatchStageResize();
      })
      .catch(error => {
        if (seq !== tabSwitchSeq) return;
        hooks.connection(`加载${entry.reg.label}面板失败：${errorText(error)}`, true);
        activePluginTab = 'catalog';
        syncPluginTabElements();
        renderPlugins(true);
      });
  }

  function refreshEnabledBadges(): void {
    if (appState.authExpired || !appState.ready) return;
    for (const entry of surfaces) {
      if (!isSurfaceEnabled(entry.reg.pluginName)) continue;
      if (activePluginTab === entry.reg.pluginName || surfaceBadgeSynced.has(entry.reg.pluginName)) continue;
      surfaceBadgeSynced.add(entry.reg.pluginName);
      void loadSurfaceController(entry.reg)
        .then(ctrl => ctrl.refreshBadge())
        .catch(() => {
          surfaceBadgeSynced.delete(entry.reg.pluginName);
        });
    }
  }

  function renderDynamicTimerPresets(plugins: PluginView[]) {
    for (const stale of timerPresetBar.querySelectorAll<HTMLElement>('.dynamic-preset')) {
      stale.remove();
    }
    let added = 0;
    for (const plugin of plugins) {
      if (plugin.enabled === false) continue;
      if (added >= 4) break;
      const spec = plugin.actionSpecs?.[0] ?? (plugin.actions[0] ? { name: plugin.actions[0] } : undefined);
      if (!spec) continue;
      const chip = node(
        'button',
        `🔌 ${plugin.title} · ${spec.label ?? spec.name}`,
        'hub-preset-chip dynamic-preset',
      );
      chip.type = 'button';
      chip.dataset.timerName = `${plugin.title}巡检`;
      chip.dataset.timerSec = '3600';
      chip.dataset.timerPlugin = plugin.name;
      chip.dataset.timerAction = spec.name;
      chip.dataset.timerCmd = spec.description ?? `执行插件 ${plugin.title} (${spec.name})`;
      timerPresetBar.append(chip);
      added++;
    }
  }

  async function toggleTimerFromUi(id: string, enabled: boolean) {
    try {
      await api<unknown>('/api/timer-toggle', { id, enabled });
      await hooks.refreshView();
    } catch (error) {
      hooks.connection(`切换定时器失败：${errorText(error)}`, true);
    }
  }

  async function completeTimerFromUi(id: string) {
    try {
      await api<TimerView>('/api/timer-complete', { id });
      await hooks.refreshView();
    } catch (error) {
      hooks.connection(`标记定时目标达成失败：${errorText(error)}`, true);
    }
  }

  async function removeTimerFromUi(id: string) {
    try {
      await api<unknown>('/api/timer-remove', { id });
      await hooks.refreshView();
    } catch (error) {
      hooks.connection(`删除定时器失败：${errorText(error)}`, true);
    }
  }

  async function addTimerFromUi() {
    const name = timerNameInput.value.trim();
    const dailyAt = timerDailyInput.value.trim() || undefined;
    const intervalSeconds = Number(timerIntervalInput.value);
    const pluginSpec = timerPluginInput.value.trim();
    const [plugin, pluginAction] = pluginSpec ? pluginSpec.split('/').map(s => s.trim()) : [undefined, undefined];
    const deliverChannelId = timerChannelInput.value.trim() || undefined;
    const goalCondition = timerGoalInput.value.trim() || undefined;
    const once = timerOnceInput.checked;
    const rawMaxFailures = Number(timerMaxFailuresInput.value);
    const maxFailures = Number.isInteger(rawMaxFailures) && rawMaxFailures >= 1 && rawMaxFailures <= 100
      ? rawMaxFailures
      : undefined;
    const instruction = timerInstructionInput.value.trim();
    if (once && goalCondition) {
      hooks.connection('单次定时提醒与终态目标条件不可同时设置', true);
      return;
    }
    if (!name || (!instruction && !plugin) || (!dailyAt && (!Number.isFinite(intervalSeconds) || intervalSeconds < 5))) return;
    timerSaveBtn.disabled = true;
    try {
      await api<TimerView>('/api/timer-add', {
        name,
        intervalMs: Math.round((Number.isFinite(intervalSeconds) && intervalSeconds >= 5 ? intervalSeconds : 60) * 1000),
        ...(dailyAt ? { dailyAt } : {}),
        ...(once ? { once: true } : {}),
        ...(goalCondition ? { goalCondition } : {}),
        ...(maxFailures !== undefined ? { maxFailures } : {}),
        ...(plugin ? { plugin } : {}),
        ...(pluginAction ? { pluginAction } : {}),
        ...(deliverChannelId ? { deliverChannelId } : {}),
        instruction: instruction || `执行插件 ${plugin}/${pluginAction ?? 'status'}`,
      });
      timerNameInput.value = '';
      timerDailyInput.value = '';
      timerPluginInput.value = '';
      timerChannelInput.value = '';
      timerGoalInput.value = '';
      timerMaxFailuresInput.value = '5';
      timerOnceInput.checked = false;
      timerInstructionInput.value = '';
      await hooks.refreshView();
    } catch (error) {
      hooks.connection(`创建定时器失败：${errorText(error)}`, true);
    } finally {
      timerSaveBtn.disabled = false;
    }
  }

  function timerStatusRank(timer: TimerView): number {
    if (timer.fatiguePaused || timer.lastRunStatus === 'fatigue_paused') return 0;
    if (timer.enabled) return 1;
    if (timer.goalMetAt || timer.lastRunStatus === 'goal_met') return 2;
    if (timer.once && timer.lastRunAt) return 3;
    return 4;
  }

  function renderTimers(force = false) {
    const timers = appState.view?.timers ?? [];
    const plugins = appState.view?.plugins ?? [];
    const activeCount = timers.filter(t => t.enabled).length;
    const goalMetCount = timers.filter(t => Boolean(t.goalMetAt) || t.lastRunStatus === 'goal_met').length;
    const fatigueCount = timers.filter(t => Boolean(t.fatiguePaused) || t.lastRunStatus === 'fatigue_paused').length;
    const missedTotal = timers.reduce((sum, t) => sum + (t.missedRuns ?? 0), 0);
    timerTopBadge.textContent = timers.length ? `${activeCount}/${timers.length}` : '0';

    if (timerHubBackdrop.hidden && !force) {
      return;
    }

    renderDynamicTimerPresets(plugins);

    const kpiFrag = document.createDocumentFragment();
    kpiFrag.append(
      kpiCard('运行中', `${activeCount}`, `${activeCount}/20 上限`, activeCount > 0 ? 'positive' : 'default'),
      kpiCard('目标已达成', `${goalMetCount}`, '', goalMetCount > 0 ? 'accent' : 'default'),
      kpiCard('失败熔断', `${fatigueCount}`, '', fatigueCount > 0 ? 'warning' : 'default'),
      kpiCard('漏跑补偿', `${missedTotal}`, '', missedTotal > 0 ? 'warning' : 'default'),
    );
    timerKpiGrid.replaceChildren(kpiFrag);
    timerListSubtitle.textContent = timers.length ? `${activeCount} / ${timers.length} 运行中` : '';

    const sortedTimers = [...timers].sort((a, b) => timerStatusRank(a) - timerStatusRank(b) || b.createdAt - a.createdAt);
    const contents = document.createDocumentFragment();
    for (const timer of sortedTimers) {
      const isFatigue = Boolean(timer.fatiguePaused || timer.lastRunStatus === 'fatigue_paused');
      const isGoalMet = Boolean(timer.goalMetAt || timer.lastRunStatus === 'goal_met');
      const cardStateClass = isFatigue ? 'is-fatigue' : timer.enabled ? 'is-active' : isGoalMet ? 'is-goal-met' : 'is-paused';
      const card = node('article', '', `hub-entity-card timer-card ${cardStateClass}`);
      const head = node('div', '', 'hub-card-head');
      const titleGroup = node('div', '', 'hub-card-title-group');
      const scheduleText = timer.once
        ? (timer.dailyAt ? `⚡ 单次 ${timer.dailyAt}` : `⚡ 单次 ${formatIntervalText(timer.intervalMs)}`)
        : (timer.dailyAt ? `⏰ 每日 ${timer.dailyAt}` : `🔄 ${formatIntervalText(timer.intervalMs)}`);
      const statusText = isFatigue
        ? '🛑 连续失败熔断'
        : timer.enabled
          ? '● 运行中'
          : isGoalMet
            ? '🎯 目标已达成'
            : (timer.once && timer.lastRunAt)
              ? '✓ 已完成'
              : '⏸ 已暂停';
      const statusBadgeClass = isFatigue
        ? 'hub-badge badge-red'
        : timer.enabled
          ? 'hub-badge badge-green'
          : isGoalMet
            ? 'hub-badge badge-purple'
            : 'hub-badge badge-slate';
      titleGroup.append(
        node('span', statusText, statusBadgeClass),
        node('strong', timer.name, 'hub-card-title'),
        node('span', scheduleText, 'hub-badge badge-teal'),
      );
      if (timer.goalCondition && !isGoalMet) {
        titleGroup.append(node('span', '🎯 有终态目标', 'hub-badge badge-purple'));
      }
      if ((timer.consecutiveFailures ?? 0) > 0) {
        titleGroup.append(
          node(
            'span',
            `⚠️ 连续失败 ${timer.consecutiveFailures}/${timer.maxFailures ?? 5}`,
            `hub-badge ${isFatigue ? 'badge-red' : 'badge-amber'}`,
          ),
        );
      }
      if (timer.plugin) {
        const boundPlugin = plugins.find(p => p.name === timer.plugin);
        const pluginTitle = boundPlugin ? getPluginDisplayTitle(boundPlugin) : timer.plugin;
        const actionLabel = resolvePluginActionLabel(
          boundPlugin ? getPluginSpecs(boundPlugin) : [],
          timer.pluginAction ?? 'status',
        );
        titleGroup.append(node('span', `🔌 ${pluginTitle} · ${actionLabel}`, 'hub-badge badge-purple'));
      }
      if (timer.deliverChannelId) {
        const channelLabel = resolveDeliverChannelLabel(timer.deliverChannelId, appState.view?.imChannels);
        titleGroup.append(node('span', `📨 投递: ${channelLabel}`, 'hub-badge badge-blue'));
      }
      head.append(titleGroup);

      const actions = node('div', '', 'timer-actions');
      if (timer.plugin) {
        actions.append(button('📄 插件详情与调试', () => {
          openPluginModal(timer.plugin, true);
        }, 'mini-button'));
      }
      if (timer.activeTaskId) {
        actions.append(button('⚡ 查看执行中工作', () => {
          hooks.closeAllHubModals();
          hooks.closeSidebar();
          hooks.selectTrace({ type: 'task', id: timer.activeTaskId!, label: timer.name });
          hooks.showPanel(true);
        }, 'mini-button'));
      }
      if (timer.goalCondition && !isGoalMet) {
        const completeBtn = button('🎯 标记达成', () => { void completeTimerFromUi(timer.id); }, 'mini-button');
        completeBtn.disabled = appState.authExpired || !appState.ready;
        actions.append(completeBtn);
      }
      const toggleLabel = timer.enabled ? '⏸ 暂停' : ((isFatigue || isGoalMet) ? '🔄 重新启用' : '▶️ 启用');
      const toggleBtn = button(toggleLabel, () => { void toggleTimerFromUi(timer.id, !timer.enabled); }, 'mini-button');
      const delBtn = button('🗑️ 删除', () => { void removeTimerFromUi(timer.id); }, 'mini-button danger-btn');
      toggleBtn.disabled = appState.authExpired || !appState.ready;
      delBtn.disabled = appState.authExpired || !appState.ready;
      actions.append(toggleBtn, delBtn);
      head.append(actions);
      card.append(head);

      card.append(node('div', timer.instruction, 'hub-code-block'));
      if (timer.goalCondition) {
        const goalBanner = node('div', '', `timer-goal-banner${isGoalMet ? ' is-met' : ''}`);
        goalBanner.append(node('div', `${isGoalMet ? '✅' : '🎯'} 终态目标：${timer.goalCondition}`));
        if (isGoalMet) {
          goalBanner.append(
            node(
              'div',
              `达成摘要：${timer.goalSummary ?? '已达成'}${timer.goalMetAt ? `（${timestamp(timer.goalMetAt)}）` : ''}`,
              'meta',
            ),
          );
        }
        card.append(goalBanner);
      }
      if (isFatigue || (timer.consecutiveFailures ?? 0) > 0) {
        const fatigueBanner = node('div', '', `timer-fatigue-banner${isFatigue ? ' is-tripped' : ''}`);
        fatigueBanner.append(
          node(
            'div',
            `${isFatigue ? '🛑 已触发连续失败疲劳熔断并自动暂停' : '⚠️ 最近执行异常（中间失败静默累计中）'}：连续失败 ${timer.consecutiveFailures ?? 0} / ${timer.maxFailures ?? 5} 次`,
          ),
        );
        if (timer.lastError) {
          fatigueBanner.append(node('div', `最近错误：${timer.lastError}`, 'meta'));
        }
        card.append(fatigueBanner);
      }

      const badgesRow = node('div', '', 'hub-badges-row');
      const nextRunLabel = timer.enabled
        ? timestamp(timer.nextRunAt)
        : (isFatigue ? '已熔断暂停' : isGoalMet ? '目标已达成' : '已暂停');
      badgesRow.append(node('span', `⏭ 下次触发：${nextRunLabel}`, 'hub-meta-chip'));
      badgesRow.append(node('span', `⏮ 上次触发：${timer.lastRunAt ? timestamp(timer.lastRunAt) : '尚未触发'}`, 'hub-meta-chip'));
      badgesRow.append(node('span', `🛡 熔断阈值：${timer.maxFailures ?? 5} 次`, 'hub-meta-chip'));
      if (timer.cwd) badgesRow.append(node('span', `📁 ${timer.cwd}`, 'hub-meta-chip mono-chip'));
      if (timer.missedRuns > 0) badgesRow.append(node('span', `⚠️ 曾漏跑补偿 ${timer.missedRuns} 次`, 'hub-badge badge-amber'));
      card.append(badgesRow);

      contents.append(card);
    }
    if (!timers.length) {
      contents.append(node('p', '暂无定时任务', 'empty hub-empty-state'));
    }
    timersList.replaceChildren(contents);
  }

  function renderFormattedRunResult(
    container: HTMLElement,
    res: PluginRunApiResponse,
    specs: readonly PluginActionSpec[],
  ): void {
    const frag = document.createDocumentFragment();
    const head = node('div', '', 'plugin-run-result-head');
    const actionLabel = resolvePluginActionLabel(specs, res.action);
    head.append(
      node('span', res.ok ? '执行成功' : '返回异常', `hub-badge ${res.ok ? 'badge-green' : 'badge-red'}`),
      node('strong', actionLabel, 'plugin-run-result-title'),
      node('span', res.notify ? '将触发提醒' : '静默输出', 'hub-meta-chip'),
    );
    frag.append(head);

    if (res.title) {
      frag.append(node('div', res.title, 'plugin-run-result-subtitle'));
    }

    const msgText = (res.message || '').trim() || '执行完成，未返回文本内容。';
    frag.append(node('div', msgText, 'plugin-run-message'));

    if (res.data !== undefined) {
      const dataDetails = node('details', '', 'hub-accordion plugin-dev-subdrawer') as HTMLDetailsElement;
      dataDetails.append(
        node('summary', '查看原始结构化数据 (JSON)', 'hub-accordion-summary'),
        node('pre', json(res.data), 'hub-code-block'),
      );
      frag.append(dataDetails);
    }
    container.replaceChildren(frag);
  }

  async function executeQuickCheck(plugin: PluginView): Promise<void> {
    if (appState.authExpired || !appState.ready) return;
    const prev = quickCheckStates.get(plugin.name);
    if (prev?.busy) return;
    quickCheckStates.set(plugin.name, { busy: true });
    renderPlugins(true);
    try {
      const res = await api<PluginRunApiResponse>('/api/plugin-run', {
        plugin: plugin.name,
        action: 'status',
        args: getPluginQuickCheckArgs(plugin.name),
      });
      quickCheckStates.set(plugin.name, {
        busy: false,
        ok: res.ok,
        summary: summarizePluginRunMessage(res.message),
      });
    } catch (err) {
      quickCheckStates.set(plugin.name, {
        busy: false,
        ok: false,
        summary: `自检失败：${errorText(err)}`,
      });
    }
    if (!pluginHubBackdrop.hidden && activePluginTab === 'catalog' && !detailPluginName) {
      renderPlugins(true);
    }
  }

  function openCatalogDetail(
    pluginName: string,
    subTab: 'overview' | 'dev' = 'overview',
    initialAction?: string,
  ): void {
    detailPluginName = pluginName;
    detailSubTab = subTab;
    detailInitialAction = initialAction;
    pluginCatalogHome.hidden = true;
    pluginCatalogDetail.hidden = false;
    syncHeaderContext();
    renderPluginDetail();
    if (pluginStage) pluginStage.scrollTop = 0;
  }

  function closeCatalogDetail(): void {
    detailPluginName = undefined;
    detailSubTab = 'overview';
    detailInitialAction = undefined;
    pluginCatalogDetail.hidden = true;
    pluginCatalogHome.hidden = false;
    syncHeaderContext();
    renderPlugins(true);
  }

  function buildCatalogCard(plugin: PluginView, timers: readonly TimerView[]): HTMLElement {
    const isEnabled = plugin.enabled !== false;
    const surfaceEntry = surfaceByName.get(plugin.name);
    const hasSurface = Boolean(surfaceEntry);
    const statusInfo = getPluginStatusInfo(plugin);
    const classified = classifyPluginActions(plugin);
    const boundTimers = timers.filter(t => t.plugin === plugin.name);
    const activeBoundTimers = boundTimers.filter(t => t.enabled);
    const liveBadge = liveBadges.get(plugin.name);
    const quickState = quickCheckStates.get(plugin.name);

    const card = node(
      'article',
      '',
      `hub-entity-card plugin-card${hasSurface ? ' is-surface' : ' is-extension'}${!isEnabled ? ' is-paused' : ''}`,
    );
    card.dataset.pluginName = plugin.name;

    const head = node('div', '', 'plugin-card-head');
    const identity = node('div', '', 'plugin-card-identity');
    const iconWrap = node('span', '', `plugin-card-icon${hasSurface ? ' tone-surface' : ' tone-extension'}`);
    iconWrap.append(createPluginIconSvg(plugin.name, 'plugin-svg-icon', 19));

    const titleWrap = node('div', '', 'plugin-card-title-wrap');
    const titleLine = node('div', '', 'plugin-card-title-line');
    titleLine.append(node('strong', getPluginDisplayTitle(plugin), 'hub-card-title plugin-card-title'));
    const subLine = node('div', '', 'plugin-card-slug-line');
    subLine.append(node('span', getPluginDomainLabel(plugin, hasSurface), 'plugin-card-domain'));
    titleWrap.append(titleLine, subLine);
    identity.append(iconWrap, titleWrap);

    const headActions = node('div', '', 'plugin-card-actions');
    if (hasSurface && surfaceEntry && isEnabled) {
      const liveText = liveBadge?.text && liveBadge.text !== '—' ? liveBadge.text : '';
      const livePill = node(
        'span',
        liveText || '—',
        `hub-badge plugin-card-live-badge${
          liveBadge?.tone === 'ok'
            ? ' badge-green'
            : liveBadge?.tone === 'warn'
              ? ' badge-amber'
              : liveBadge?.tone === 'err'
                ? ' badge-red'
                : ' badge-slate'
        }`,
      );
      livePill.dataset.liveBadge = plugin.name;
      livePill.hidden = !liveText;

      const openBtn = button('打开看板 →', () => {
        switchPluginTab(plugin.name);
      }, 'primary plugin-open-btn');
      openBtn.disabled = appState.authExpired || !appState.ready;
      headActions.append(livePill, openBtn);
    } else if (isEnabled && plugin.actions.includes('status')) {
      const checkBtn = button(
        quickState?.busy ? '检测中…' : '⚡ 快速自检',
        () => { void executeQuickCheck(plugin); },
        'mini-button plugin-check-btn',
      );
      checkBtn.disabled = Boolean(quickState?.busy) || appState.authExpired || !appState.ready;
      headActions.append(checkBtn);
    } else if (!isEnabled) {
      const disabledPill = node(
        'span',
        statusInfo.label,
        `hub-badge ${statusInfo.tone === 'amber' ? 'badge-amber' : 'badge-slate'}`,
      );
      disabledPill.title = statusInfo.detail;
      headActions.append(disabledPill);
    }
    head.append(identity, headActions);
    card.append(head);

    const traitsRow = node('div', '', 'plugin-traits-row');
    const statusChip = node(
      'span',
      isEnabled ? '● 已启用' : `○ ${statusInfo.label}`,
      `hub-badge ${statusInfo.tone === 'green' ? 'badge-green' : statusInfo.tone === 'amber' ? 'badge-amber' : 'badge-slate'}`,
    );
    statusChip.title = statusInfo.detail;
    traitsRow.append(
      statusChip,
      node('span', hasSurface ? '专属看板' : '系统扩展', `hub-badge ${hasSurface ? 'badge-teal' : 'badge-purple'}`),
    );
    if (plugin.voiceFastpath) {
      const voiceChip = node('span', '🎙️ 语音直通', 'hub-badge badge-blue');
      voiceChip.title = '支持小爱/语音快车道直接触发控制';
      traitsRow.append(voiceChip);
    }
    if (boundTimers.length) {
      const timerChip = node(
        'span',
        activeBoundTimers.length
          ? `⏰ 巡检 ${activeBoundTimers.length}/${boundTimers.length}`
          : `⏰ 巡检 ${boundTimers.length} (已暂停)`,
        `hub-badge ${activeBoundTimers.length ? 'badge-green' : 'badge-slate'}`,
      );
      timerChip.title = boundTimers
        .map(bt => `${bt.name} · ${bt.dailyAt ? `每日 ${bt.dailyAt}` : formatIntervalText(bt.intervalMs)}`)
        .join('\n');
      traitsRow.append(timerChip);
    }
    card.append(traitsRow);

    if (classified.primary.length) {
      const capRow = node('div', '', 'plugin-cap-row');
      const visibleCaps = classified.primary.slice(0, 4);
      for (const spec of visibleCaps) {
        const capLabel = spec.label || resolvePluginActionLabel(classified.all, spec.name);
        const capChip = node('span', capLabel, 'plugin-cap-chip');
        if (spec.description) capChip.title = spec.description;
        capRow.append(capChip);
      }
      const hiddenCount = classified.all.length - visibleCaps.length;
      if (hiddenCount > 0) {
        const moreBtn = button(`+${hiddenCount} 项能力`, () => {
          openCatalogDetail(plugin.name, 'overview');
        }, 'plugin-cap-chip is-overflow plugin-cap-more-btn');
        capRow.append(moreBtn);
      }
      card.append(capRow);
    }

    if (quickState && !quickState.busy && quickState.summary) {
      const banner = node('div', '', `plugin-quick-banner ${quickState.ok ? 'is-ok' : 'is-err'}`);
      banner.append(
        node('span', quickState.ok ? '✅' : '⚠️', 'plugin-quick-icon'),
        node('span', quickState.summary, 'plugin-quick-text'),
      );
      card.append(banner);
    }

    const footer = node('div', '', 'plugin-card-footer');
    const sourceText = `${plugin.isBuiltin === false ? '自定义插件' : '内置扩展'} · ${formatRuntimeLabel(plugin.runtime)} · ${classified.all.length} 项能力`;
    footer.append(
      node('span', sourceText, 'plugin-card-meta'),
      button('查看详情 →', () => {
        openCatalogDetail(plugin.name, 'overview');
      }, 'mini-button plugin-detail-trigger'),
    );
    card.append(footer);

    return card;
  }

  function renderPluginDetail(): void {
    const plugins = appState.view?.plugins ?? [];
    const timers = appState.view?.timers ?? [];
    const plugin = plugins.find(p => p.name === detailPluginName);
    if (!plugin) {
      closeCatalogDetail();
      return;
    }

    const isEnabled = plugin.enabled !== false;
    const surfaceEntry = surfaceByName.get(plugin.name);
    const statusInfo = getPluginStatusInfo(plugin);
    const classified = classifyPluginActions(plugin);
    const boundTimers = timers.filter(t => t.plugin === plugin.name);

    const frag = document.createDocumentFragment();

    // Detail top bar
    const topBar = node('div', '', 'plugin-detail-bar');
    const leftGroup = node('div', '', 'plugin-detail-bar-left');
    const backBtn = button('', () => closeCatalogDetail(), 'mini-button plugin-detail-back-btn');
    backBtn.append(createUiIconSvg('back', 'plugin-ui-svg', 14), node('span', '返回插件目录'));
    leftGroup.append(backBtn);

    const idBlock = node('div', '', 'plugin-detail-identity');
    const iconBox = node('span', '', `plugin-card-icon${surfaceEntry ? ' tone-surface' : ' tone-extension'}`);
    iconBox.append(createPluginIconSvg(plugin.name, 'plugin-svg-icon', 20));
    const titleCol = node('div', '', 'plugin-detail-title-col');
    const titleRow = node('div', '', 'hub-card-title-group');
    titleRow.append(
      node('h3', getPluginDisplayTitle(plugin), 'plugin-detail-title'),
      node('span', statusInfo.label, `hub-badge ${statusInfo.tone === 'green' ? 'badge-green' : statusInfo.tone === 'amber' ? 'badge-amber' : 'badge-slate'}`),
    );
    titleCol.append(titleRow);
    idBlock.append(iconBox, titleCol);
    leftGroup.append(idBlock);

    const rightGroup = node('div', '', 'plugin-detail-bar-right');
    const subTabs = node('div', '', 'hub-filter-pills');
    subTabs.setAttribute('role', 'tablist');
    const overviewTabBtn = button('概览与能力', () => {
      detailSubTab = 'overview';
      renderPluginDetail();
    }, `hub-filter-pill${detailSubTab === 'overview' ? ' active' : ''}`);
    overviewTabBtn.setAttribute('role', 'tab');
    overviewTabBtn.setAttribute('aria-selected', String(detailSubTab === 'overview'));
    const devTabBtn = button('开发者调试与清单', () => {
      detailSubTab = 'dev';
      renderPluginDetail();
    }, `hub-filter-pill${detailSubTab === 'dev' ? ' active' : ''}`);
    devTabBtn.setAttribute('role', 'tab');
    devTabBtn.setAttribute('aria-selected', String(detailSubTab === 'dev'));
    subTabs.append(overviewTabBtn, devTabBtn);
    rightGroup.append(subTabs);

    if (surfaceEntry && isEnabled) {
      const openBtn = button(`打开${surfaceEntry.reg.label} →`, () => {
        switchPluginTab(plugin.name);
      }, 'primary plugin-open-btn');
      openBtn.disabled = appState.authExpired || !appState.ready;
      rightGroup.append(openBtn);
    }

    topBar.append(leftGroup, rightGroup);
    frag.append(topBar);

    if (detailSubTab === 'overview') {
      // Structured metadata strip
      const metaGrid = node('div', '', 'plugin-detail-meta-grid');
      const addMetaCard = (label: string, value: string, hint: string, tone: 'default' | 'accent' | 'positive' | 'warning' = 'default') => {
        metaGrid.append(kpiCard(label, value, hint, tone));
      };
      addMetaCard(
        '运行状态',
        statusInfo.label,
        statusInfo.detail,
        statusInfo.tone === 'green' ? 'positive' : statusInfo.tone === 'amber' ? 'warning' : 'default',
      );
      addMetaCard(
        '平台与运行方式',
        formatRuntimeLabel(plugin.runtime),
        `${formatPlatformsLabel(plugin.platforms)} · ${plugin.isBuiltin === false ? '用户扩展插件' : '系统内置插件'}`,
        'default',
      );
      addMetaCard(
        '交互通道',
        plugin.voiceFastpath ? '支持语音直通' : (surfaceEntry ? '专属看板 + 对话' : '对话与定时调用'),
        plugin.voiceFastpath ? '小爱/语音快车道可直接触发' : '可通过 F.R.I.D.A.Y. 对话或定时任务调度',
        plugin.voiceFastpath ? 'accent' : 'default',
      );
      addMetaCard(
        '能力规模',
        `${classified.all.length} 项动作`,
        boundTimers.length ? `已绑定 ${boundTimers.length} 项定时巡检` : '暂未绑定定时巡检',
        boundTimers.length ? 'positive' : 'default',
      );
      frag.append(metaGrid);

      // Full human-readable description
      const cleanDesc = cleanPluginText(plugin.description || plugin.promptHint || '');
      if (cleanDesc) {
        const descCard = node('section', '', 'plugin-detail-section');
        descCard.append(
          node('h4', '功能说明', 'plugin-detail-heading'),
          node('p', cleanDesc, 'plugin-detail-prose'),
        );
        frag.append(descCard);
      }

      // Bound timers section
      if (boundTimers.length) {
        const timerSection = node('section', '', 'plugin-detail-section');
        timerSection.append(node('h4', `关联定时巡检 (${boundTimers.length})`, 'plugin-detail-heading'));
        const timerList = node('div', '', 'plugin-detail-timers');
        for (const bt of boundTimers) {
          const row = node('div', '', 'plugin-detail-timer-row');
          const actLabel = resolvePluginActionLabel(classified.all, bt.pluginAction ?? 'status');
          const scheduleLabel = bt.dailyAt ? `每日 ${bt.dailyAt}` : formatIntervalText(bt.intervalMs);
          row.append(
            node('span', bt.enabled ? '● 运行中' : '⏸ 已暂停', `hub-badge ${bt.enabled ? 'badge-green' : 'badge-slate'}`),
            node('strong', bt.name, 'plugin-detail-timer-name'),
            node('span', scheduleLabel, 'hub-meta-chip'),
            node('span', `动作：${actLabel}`, 'hub-meta-chip'),
          );
          if (bt.deliverChannelId) {
            const channelLabel = resolveDeliverChannelLabel(bt.deliverChannelId, appState.view?.imChannels);
            row.append(node('span', `投递：${channelLabel}`, 'hub-badge badge-blue'));
          }
          timerList.append(row);
        }
        timerSection.append(timerList);
        frag.append(timerSection);
      }

      // Shared formatted run result box for Overview quick-run buttons
      const overviewRunBox = node('div', '', 'hub-probe-banner plugin-detail-run-box');
      overviewRunBox.hidden = true;

      const buildActionRow = (spec: PluginActionSpec): HTMLElement => {
        const row = node('div', '', 'plugin-action-row');
        const info = node('div', '', 'plugin-action-row-main');
        const titleLine = node('div', '', 'hub-card-title-group');
        titleLine.append(
          node('strong', spec.label || resolvePluginActionLabel(classified.all, spec.name), 'plugin-action-label'),
        );
        info.append(titleLine);
        if (spec.description) {
          info.append(node('p', cleanPluginText(spec.description), 'plugin-action-desc'));
        }
        const paramPills = formatActionDefaultArgs(spec.defaultArgs);
        if (paramPills.length) {
          const paramsRow = node('div', '', 'plugin-param-pills');
          for (const pill of paramPills) {
            const pEl = node('span', `${pill.label}：${pill.value}`, 'plugin-param-pill');
            pEl.title = `${pill.key} = ${pill.value}`;
            paramsRow.append(pEl);
          }
          info.append(paramsRow);
        }

        const rowActions = node('div', '', 'plugin-action-row-ops');
        if (isEnabled && isSafeQuickRunAction(spec.name)) {
          const quickRunBtn = button('▶ 运行', () => {
            void (async () => {
              quickRunBtn.disabled = true;
              quickRunBtn.textContent = '执行中…';
              overviewRunBox.hidden = false;
              overviewRunBox.replaceChildren(
                node('p', `正在执行「${spec.label || spec.name}」…`, 'meta'),
              );
              const args = spec.name === 'status'
                ? { ...(spec.defaultArgs ?? {}), ...getPluginQuickCheckArgs(plugin.name) }
                : { ...(spec.defaultArgs ?? {}) };
              try {
                const res = await api<PluginRunApiResponse>('/api/plugin-run', {
                  plugin: plugin.name,
                  action: spec.name,
                  args,
                });
                renderFormattedRunResult(overviewRunBox, res, classified.all);
              } catch (err) {
                overviewRunBox.replaceChildren(node('p', `❌ 执行失败：${errorText(err)}`, 'error'));
              } finally {
                quickRunBtn.disabled = false;
                quickRunBtn.textContent = '▶ 运行';
              }
            })();
          }, 'primary mini-button');
          quickRunBtn.disabled = appState.authExpired || !appState.ready;
          rowActions.append(quickRunBtn);
        }
        const debugBtn = button('参数调试', () => {
          detailSubTab = 'dev';
          detailInitialAction = spec.name;
          renderPluginDetail();
        }, 'mini-button');
        rowActions.append(debugBtn);

        row.append(info, rowActions);
        return row;
      };

      const primarySection = node('section', '', 'plugin-detail-section');
      primarySection.append(
        node('h4', `核心能力 (${classified.primary.length})`, 'plugin-detail-heading'),
      );
      const primaryList = node('div', '', 'plugin-detail-actions-list');
      for (const spec of classified.primary) {
        primaryList.append(buildActionRow(spec));
      }
      primarySection.append(primaryList, overviewRunBox);
      frag.append(primarySection);

      if (classified.management.length) {
        const mgmtDetails = node('details', '', 'hub-accordion plugin-mgmt-accordion') as HTMLDetailsElement;
        mgmtDetails.append(
          node('summary', `配置、鉴权与数据管理能力 (${classified.management.length} 项)`, 'hub-accordion-summary'),
        );
        const mgmtBody = node('div', '', 'plugin-detail-actions-list plugin-mgmt-body');
        for (const spec of classified.management) {
          mgmtBody.append(buildActionRow(spec));
        }
        mgmtDetails.append(mgmtBody);
        frag.append(mgmtDetails);
      }
    } else {
      // Developer Debug & Raw Manifest sub-tab
      const specs = getPluginSpecs(plugin);
      const runnerWrap = node('div', '', 'hub-form-card plugin-dev-runner');
      runnerWrap.append(
        node('strong', '动作与自定义参数调试台', 'hub-card-title'),
        node(
          'p',
          `运行模式：${formatRuntimeLabel(plugin.runtime)} (${plugin.runtime ?? 'subprocess'}) · 入口：${plugin.entry}`,
          'meta',
        ),
      );

      const actionSelect = node('select', '', 'hub-input') as HTMLSelectElement;
      for (const spec of specs) {
        const opt = node('option', `${spec.name}${spec.label ? ` — ${spec.label}` : ''}`);
        opt.value = spec.name;
        actionSelect.append(opt);
      }

      const argsInput = node('input', '', 'hub-input mono-input') as HTMLInputElement;
      argsInput.type = 'text';
      argsInput.placeholder = '执行参数 JSON 对象，例如 {} 或 {"refresh":true}';

      const specHint = node('p', '', 'meta plugin-dev-spec-hint');
      const cmdPreview = node('div', '', 'hub-code-block meta');

      const syncCmdPreview = () => {
        const act = actionSelect.value || 'status';
        const rawArgs = argsInput.value.trim() || '{}';
        cmdPreview.textContent = `$ friday plugin run ${plugin.name} ${act} '${rawArgs}'`;
      };

      const selectSpec = (specName: string) => {
        actionSelect.value = specName;
        const matched = specs.find(s => s.name === specName);
        argsInput.value = JSON.stringify(matched?.defaultArgs ?? {});
        specHint.textContent = matched?.description ? cleanPluginText(matched.description) : '无附加参数说明';
        syncCmdPreview();
      };

      const controlsRow = node('div', '', 'hub-form-grid');
      const actField = node('label', '', 'hub-field');
      actField.append(node('span', '选择调试动作'), actionSelect);
      const argsField = node('label', '', 'hub-field hub-field-wide');
      argsField.append(node('span', '调试参数 (JSON 对象)'), argsInput);
      controlsRow.append(actField, argsField);
      runnerWrap.append(controlsRow, specHint, cmdPreview);

      actionSelect.addEventListener('change', () => selectSpec(actionSelect.value));
      argsInput.addEventListener('input', syncCmdPreview);
      const initialSpecName = (detailInitialAction && specs.some(s => s.name === detailInitialAction))
        ? detailInitialAction
        : (specs[0]?.name ?? 'status');
      selectSpec(initialSpecName);

      const runResultBox = node('div', '', 'hub-probe-banner plugin-detail-run-box');
      runResultBox.hidden = true;

      const runActionsRow = node('div', '', 'hub-form-actions');
      const runBtn = button('▶ 立即运行该动作', () => {
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
          runBtn.textContent = '⏳ 正在执行…';
          runResultBox.hidden = false;
          runResultBox.replaceChildren(node('p', `正在执行 ${plugin.name}/${actionSelect.value} …`, 'meta'));
          try {
            const res = await api<PluginRunApiResponse>('/api/plugin-run', {
              plugin: plugin.name,
              action: actionSelect.value,
              args: parsedArgs,
            });
            renderFormattedRunResult(runResultBox, res, specs);
          } catch (err) {
            runResultBox.replaceChildren(node('p', `❌ 执行失败：${errorText(err)}`, 'error'));
          } finally {
            runBtn.disabled = false;
            runBtn.textContent = '▶ 立即运行该动作';
          }
        })();
      }, 'primary mini-button');
      runBtn.disabled = !isEnabled || appState.authExpired || !appState.ready;
      runActionsRow.append(runBtn);
      if (!isEnabled) {
        runActionsRow.append(node('span', `当前不可执行：${statusInfo.detail}`, 'meta'));
      }
      runnerWrap.append(runActionsRow, runResultBox);
      frag.append(runnerWrap);

      if (plugin.manifestJson) {
        const manifestDetails = node('details', '', 'hub-accordion plugin-dev-subdrawer') as HTMLDetailsElement;
        manifestDetails.append(
          node('summary', '查看原始插件清单配置 (plugin.json)', 'hub-accordion-summary'),
          node('pre', plugin.manifestJson, 'hub-code-block'),
        );
        frag.append(manifestDetails);
      }
    }

    pluginCatalogDetail.replaceChildren(frag);
  }

  function syncCatalogFilterButtons(counts: {
    all: number;
    surface: number;
    extension: number;
    voice: number;
    timer: number;
  }): void {
    const labels: Record<PluginCatalogFilter, string> = {
      all: `全部 (${counts.all})`,
      surface: `专属看板 (${counts.surface})`,
      extension: `系统扩展 (${counts.extension})`,
      voice: `语音直通 (${counts.voice})`,
      timer: `定时巡检 (${counts.timer})`,
    };
    for (const btn of pluginCatalogFilters.querySelectorAll<HTMLButtonElement>('button[data-catalog-filter]')) {
      const key = btn.dataset.catalogFilter as PluginCatalogFilter | undefined;
      if (!key || !(key in labels)) continue;
      btn.textContent = labels[key];
      const active = key === catalogFilter;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    }
  }

  function renderPlugins(force = false) {
    const plugins: PluginView[] = appState.view?.plugins ?? [];
    const timers = appState.view?.timers ?? [];
    const boundTimersCount = timers.filter(t => Boolean(t.plugin)).length;
    const activeBoundTimersCount = timers.filter(t => Boolean(t.plugin) && t.enabled).length;
    const enabledCount = plugins.filter(p => p.enabled !== false).length;
    const surfaceCount = plugins.filter(p => surfaceByName.has(p.name)).length;
    const extensionCount = plugins.length - surfaceCount;
    const voiceCount = plugins.filter(p => Boolean(p.voiceFastpath)).length;
    const countText = String(plugins.length);
    pluginTopBadge.textContent = countText;
    pluginCatalogBadge.textContent = countText;
    pluginTabCatalog.title = `插件目录 · 共 ${plugins.length} 个`;

    if ((pluginHubBackdrop.hidden || activePluginTab !== 'catalog') && !force) {
      return;
    }

    if (detailPluginName) {
      if (force) {
        renderPluginDetail();
      }
      return;
    }

    const kpiFrag = document.createDocumentFragment();
    kpiFrag.append(
      kpiCard(
        '已安装插件',
        `${plugins.length}`,
        plugins.length ? `已启用 ${enabledCount} 个 · ${surfaceCount} 看板 · ${extensionCount} 扩展` : '暂无已安装插件',
        plugins.length > 0 ? 'positive' : 'default',
      ),
      kpiCard(
        '语音快车道',
        `${voiceCount}`,
        voiceCount > 0 ? '已启用语音直通' : '暂无',
        voiceCount > 0 ? 'accent' : 'default',
      ),
      kpiCard(
        '自动化巡检',
        `${boundTimersCount}`,
        boundTimersCount > 0 ? `运行中 ${activeBoundTimersCount} 项定时任务` : '暂未绑定定时巡检',
        boundTimersCount > 0 ? 'positive' : 'default',
      ),
    );
    pluginKpiGrid.replaceChildren(kpiFrag);

    const filtered = filterAndGroupPlugins({
      plugins,
      timers,
      surfaceNames,
      order: [...pluginOrder, ...defaultSurfaceOrder],
      filter: catalogFilter,
      query: catalogQuery,
    });
    syncCatalogFilterButtons(filtered.counts);
    pluginListSubtitle.textContent = filtered.items.length === plugins.length
      ? `共 ${plugins.length} 个插件`
      : `已筛出 ${filtered.items.length} / ${plugins.length} 个`;

    // Avoid interrupting active inline states during background SSE ticks.
    if (!force && isEditingWithin(pluginsList)) return;

    const contents = document.createDocumentFragment();
    if (!plugins.length) {
      contents.append(node('p', '当前未发现任何插件（存放于 plugins/<name>/plugin.json）', 'empty hub-empty-state'));
    } else if (!filtered.items.length) {
      const emptyBox = node('div', '', 'plugin-catalog-empty');
      emptyBox.append(
        node('p', '未找到匹配的插件，可尝试清除搜索关键词或切换分类筛选。', 'empty'),
        button('重置筛选', () => {
          catalogFilter = 'all';
          catalogQuery = '';
          pluginCatalogSearch.value = '';
          renderPlugins(true);
        }, 'mini-button'),
      );
      contents.append(emptyBox);
    } else if (filtered.grouped) {
      if (filtered.surfaces.length) {
        const surfGroup = node('section', '', 'plugin-catalog-group');
        const surfHead = node('div', '', 'plugin-catalog-group-head');
        surfHead.append(
          node('h3', `专属交互看板 (${filtered.surfaces.length})`, 'plugin-catalog-group-title'),
        );
        const surfGrid = node('div', '', 'plugin-cards-grid');
        for (const plugin of filtered.surfaces) {
          surfGrid.append(buildCatalogCard(plugin, timers));
        }
        surfGroup.append(surfHead, surfGrid);
        contents.append(surfGroup);
      }
      if (filtered.extensions.length) {
        const extGroup = node('section', '', 'plugin-catalog-group');
        const extHead = node('div', '', 'plugin-catalog-group-head');
        extHead.append(
          node('h3', `系统与语音扩展 (${filtered.extensions.length})`, 'plugin-catalog-group-title'),
        );
        const extGrid = node('div', '', 'plugin-cards-grid');
        for (const plugin of filtered.extensions) {
          extGrid.append(buildCatalogCard(plugin, timers));
        }
        extGroup.append(extHead, extGrid);
        contents.append(extGroup);
      }
    } else {
      const flatGrid = node('div', '', 'plugin-cards-grid');
      for (const plugin of filtered.items) {
        flatGrid.append(buildCatalogCard(plugin, timers));
      }
      contents.append(flatGrid);
    }

    pluginsList.replaceChildren(contents);
  }

  function openTimerModal() {
    hooks.closeAllHubModals();
    timerHubBackdrop.hidden = false;
    renderTimers(true);
  }

  function closeTimerModal() {
    timerHubBackdrop.hidden = true;
  }

  function openPluginModal(
    pluginName?: string,
    expandSource = false,
    mode: 'catalog' | 'surface' = 'catalog',
  ) {
    hooks.closeAllHubModals();
    pluginHubBackdrop.hidden = false;
    applySidebarOrder();
    applySidebarCollapsed(resolveEffectiveCollapsed());
    setMobileNavOpen(false);

    if (mode === 'surface' && pluginName) {
      detailPluginName = undefined;
      pluginCatalogDetail.hidden = true;
      pluginCatalogHome.hidden = false;
      switchPluginTab(pluginName);
    } else if (pluginName) {
      detailPluginName = pluginName;
      detailSubTab = 'overview';
      detailInitialAction = undefined;
      void expandSource;
      pluginCatalogHome.hidden = true;
      pluginCatalogDetail.hidden = false;
      switchPluginTab('catalog');
    } else {
      switchPluginTab(activePluginTab);
    }
    refreshEnabledBadges();
  }

  function closePluginModal() {
    tabSwitchSeq++;
    deactivateActiveSurface();
    setMobileNavOpen(false);
    pluginHubBackdrop.hidden = true;
  }

  function syncPluginSurfaces(opts: {
    initial: boolean;
    cursorReset: boolean;
    newMessages: readonly { seq: number; text: string }[];
  }): void {
    for (const entry of surfaces) {
      const enabled = isSurfaceEnabled(entry.reg.pluginName);
      entry.tabEl.hidden = !enabled;
      if (!enabled) {
        surfaceBadgeSynced.delete(entry.reg.pluginName);
        if (activePluginTab === entry.reg.pluginName) {
          switchPluginTab('catalog');
        }
        continue;
      }

      const matchedMessage = entry.reg.messageTrigger
        ? opts.newMessages.some(msg => entry.reg.messageTrigger!.test(msg.text))
        : false;
      if (opts.cursorReset || matchedMessage) {
        surfaceBadgeSynced.delete(entry.reg.pluginName);
      }

      if (!pluginHubBackdrop.hidden && !appState.authExpired && !surfaceBadgeSynced.has(entry.reg.pluginName)) {
        surfaceBadgeSynced.add(entry.reg.pluginName);
        void loadSurfaceController(entry.reg)
          .then(ctrl => ctrl.refreshBadge())
          .catch(() => {
            surfaceBadgeSynced.delete(entry.reg.pluginName);
          });
      }
    }
    applySidebarOrder();
  }

  // ---- Drag-and-Drop Reordering (Desktop HTML5 DnD + Touch Pointer + Keyboard Alt+Arrows) ----
  let dndDraggedName: string | undefined;
  let dndTargetName: string | undefined;
  let dndDropPos: 'before' | 'after' = 'before';

  function clearDndClasses(): void {
    for (const item of pluginNavSortable.querySelectorAll<HTMLElement>('.plugin-nav-item')) {
      item.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
    }
  }

  function setDndDropMarker(targetEl: HTMLElement | undefined, pos: 'before' | 'after'): void {
    for (const item of pluginNavSortable.querySelectorAll<HTMLElement>('.plugin-nav-item')) {
      item.classList.remove('is-drop-before', 'is-drop-after');
    }
    if (!targetEl) {
      dndTargetName = undefined;
      return;
    }
    dndTargetName = targetEl.dataset.pluginTab;
    dndDropPos = pos;
    targetEl.classList.add(pos === 'before' ? 'is-drop-before' : 'is-drop-after');
  }

  pluginNavSortable.addEventListener('dragstart', event => {
    const item = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.plugin-nav-item[data-plugin-tab]');
    const name = item?.dataset.pluginTab;
    if (!item || !name) return;
    dndDraggedName = name;
    dndTargetName = undefined;
    item.classList.add('is-dragging');
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', name);
    }
  });

  pluginNavSortable.addEventListener('dragover', event => {
    if (!dndDraggedName) return;
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.plugin-nav-item[data-plugin-tab]');
    const targetName = target?.dataset.pluginTab;
    if (!target || !targetName || targetName === dndDraggedName) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const rect = target.getBoundingClientRect();
    const pos: 'before' | 'after' = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setDndDropMarker(target, pos);
  });

  pluginNavSortable.addEventListener('dragleave', event => {
    if (!dndDraggedName) return;
    const related = event.relatedTarget as Node | null;
    if (related && pluginNavSortable.contains(related)) return;
    setDndDropMarker(undefined, 'before');
  });

  pluginNavSortable.addEventListener('drop', event => {
    if (!dndDraggedName) return;
    event.preventDefault();
    const dragged = dndDraggedName;
    const target = dndTargetName
      ?? (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.plugin-nav-item[data-plugin-tab]')?.dataset.pluginTab;
    const pos = dndDropPos;
    dndDraggedName = undefined;
    dndTargetName = undefined;
    clearDndClasses();
    suppressClickUntil = Date.now() + 160;
    if (target && target !== dragged) {
      const base = [...new Set([...pluginOrder, ...defaultSurfaceOrder])];
      commitPluginOrder(reorderPluginList(base, dragged, target, pos));
    }
  });

  pluginNavSortable.addEventListener('dragend', () => {
    dndDraggedName = undefined;
    dndTargetName = undefined;
    clearDndClasses();
    suppressClickUntil = Date.now() + 160;
  });

  // Touch/Pen fallback via grip handle (zero inline styles under strict CSP)
  let touchDragName: string | undefined;
  let touchDragPointerId: number | undefined;

  pluginNavSortable.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    const grip = (event.target as HTMLElement | null)?.closest<HTMLElement>('.plugin-nav-grip');
    if (!grip) return;
    const item = grip.closest<HTMLButtonElement>('.plugin-nav-item[data-plugin-tab]');
    const name = item?.dataset.pluginTab;
    if (!item || !name) return;
    event.preventDefault();
    touchDragName = name;
    touchDragPointerId = event.pointerId;
    dndTargetName = undefined;
    item.classList.add('is-dragging');
    try {
      grip.setPointerCapture(event.pointerId);
    } catch {
      // Ignore pointer capture errors on synthetic events.
    }
  });

  pluginNavSortable.addEventListener('pointermove', event => {
    if (!touchDragName || event.pointerId !== touchDragPointerId) return;
    event.preventDefault();
    const hit = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLButtonElement>('.plugin-nav-item[data-plugin-tab]');
    const targetName = hit?.dataset.pluginTab;
    if (!hit || !targetName || targetName === touchDragName || !pluginNavSortable.contains(hit)) {
      setDndDropMarker(undefined, 'before');
      return;
    }
    const rect = hit.getBoundingClientRect();
    const pos: 'before' | 'after' = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setDndDropMarker(hit, pos);
  });

  const finishTouchDrag = (commit: boolean) => {
    if (!touchDragName) return;
    const dragged = touchDragName;
    const target = dndTargetName;
    const pos = dndDropPos;
    touchDragName = undefined;
    touchDragPointerId = undefined;
    dndTargetName = undefined;
    clearDndClasses();
    suppressClickUntil = Date.now() + 160;
    if (commit && target && target !== dragged) {
      const base = [...new Set([...pluginOrder, ...defaultSurfaceOrder])];
      commitPluginOrder(reorderPluginList(base, dragged, target, pos));
    }
  };

  pluginNavSortable.addEventListener('pointerup', event => {
    if (event.pointerId === touchDragPointerId) finishTouchDrag(true);
  });
  pluginNavSortable.addEventListener('pointercancel', event => {
    if (event.pointerId === touchDragPointerId) finishTouchDrag(false);
  });

  // Keyboard accessibility: Alt + ArrowUp / ArrowDown reorders focused plugin tab
  pluginNavSortable.addEventListener('keydown', event => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    const item = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.plugin-nav-item[data-plugin-tab]');
    const name = item?.dataset.pluginTab;
    if (!item || !name) return;
    event.preventDefault();
    const visibleNames = surfaces.filter(s => !s.tabEl.hidden).map(s => s.reg.pluginName);
    const delta: -1 | 1 = event.key === 'ArrowUp' ? -1 : 1;
    const next = movePluginStep([...new Set([...pluginOrder, ...defaultSurfaceOrder])], visibleNames, name, delta);
    commitPluginOrder(next);
    item.focus();
  });

  // ---- Event Wiring ----
  openTimerHubTop.addEventListener('click', openTimerModal);
  timerModalClose.addEventListener('click', closeTimerModal);
  timerHubBackdrop.addEventListener('click', event => {
    if (event.target === timerHubBackdrop) closeTimerModal();
  });
  timerSaveBtn.addEventListener('click', () => { void addTimerFromUi(); });
  timerPresetBar.addEventListener('click', event => {
    const chip = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-timer-name]');
    if (!chip) return;
    timerNameInput.value = chip.dataset.timerName ?? '';
    timerDailyInput.value = chip.dataset.timerDaily ?? '';
    timerIntervalInput.value = chip.dataset.timerSec ?? '300';
    timerPluginInput.value = chip.dataset.timerPlugin
      ? `${chip.dataset.timerPlugin}${chip.dataset.timerAction ? `/${chip.dataset.timerAction}` : ''}`
      : '';
    timerChannelInput.value = chip.dataset.timerChannel ?? '';
    timerGoalInput.value = chip.dataset.timerGoal ?? '';
    timerOnceInput.checked = chip.dataset.timerOnce === 'true';
    timerMaxFailuresInput.value = chip.dataset.timerMaxFailures ?? '5';
    timerInstructionInput.value = chip.dataset.timerCmd ?? '';
    timerAddDetails.open = true;
    timerInstructionInput.focus();
  });
  timerHubBackdrop.addEventListener('click', event => {
    const quickBtn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-interval-sec]');
    if (!quickBtn) return;
    timerIntervalInput.value = quickBtn.dataset.intervalSec ?? '300';
  });

  openPluginHubTop.addEventListener('click', () => openPluginModal());
  pluginModalClose.addEventListener('click', closePluginModal);
  pluginHubBackdrop.addEventListener('click', event => {
    if (event.target === pluginHubBackdrop) closePluginModal();
  });
  pluginSidebarToggle.addEventListener('click', () => {
    if (isMobileViewport()) {
      setMobileNavOpen(false);
      return;
    }
    const next = !resolveEffectiveCollapsed();
    userCollapsedPref = next;
    writeSidebarCollapsed(next);
    prefsSync.broadcastCollapsed(next);
    applySidebarCollapsed(next, true);
  });
  pluginMobileNavBtn.addEventListener('click', () => {
    const open = !pluginShell.classList.contains('is-mobile-nav-open');
    setMobileNavOpen(open);
  });
  pluginSidebarScrim.addEventListener('click', () => {
    setMobileNavOpen(false);
  });
  pluginOrderResetBtn.addEventListener('click', () => {
    clearPluginOrder();
    pluginOrder = [];
    prefsSync.broadcastOrder([]);
    applySidebarOrder();
    if (!pluginHubBackdrop.hidden && activePluginTab === 'catalog' && !detailPluginName) {
      renderPlugins(true);
    }
  });
  pluginSurfaceTabs.addEventListener('click', event => {
    if (Date.now() < suppressClickUntil) return;
    const tabBtn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-plugin-tab]');
    const nextTab = tabBtn?.dataset.pluginTab;
    if (!nextTab) return;
    if (nextTab === 'catalog' && activePluginTab === 'catalog' && detailPluginName) {
      closeCatalogDetail();
      setMobileNavOpen(false);
      return;
    }
    if (nextTab === activePluginTab) {
      setMobileNavOpen(false);
      return;
    }
    if (nextTab !== 'catalog') {
      detailPluginName = undefined;
      pluginCatalogDetail.hidden = true;
      pluginCatalogHome.hidden = false;
    }
    switchPluginTab(nextTab);
  });

  pluginCatalogSearch.addEventListener('input', () => {
    catalogQuery = pluginCatalogSearch.value;
    renderPlugins(true);
  });
  pluginCatalogFilters.addEventListener('click', event => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-catalog-filter]');
    const nextFilter = btn?.dataset.catalogFilter as PluginCatalogFilter | undefined;
    if (!nextFilter || nextFilter === catalogFilter) return;
    catalogFilter = nextFilter;
    renderPlugins(true);
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => {
      if (pluginHubBackdrop.hidden) return;
      if (!isMobileViewport() && pluginShell.classList.contains('is-mobile-nav-open')) {
        setMobileNavOpen(false);
      }
      applySidebarCollapsed(resolveEffectiveCollapsed());
    });
  }

  // Initial DOM alignment
  applySidebarOrder();
  applySidebarCollapsed(resolveEffectiveCollapsed());

  return {
    openTimerModal,
    closeTimerModal,
    renderTimers,
    openPluginModal,
    closePluginModal,
    deactivateActiveSurface,
    renderPlugins,
    syncPluginSurfaces,
  };
}

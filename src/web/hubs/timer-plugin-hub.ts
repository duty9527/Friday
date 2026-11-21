import type { PluginActionSpec, PluginView, TimerView } from '../../view.js';
import { button, element, isEditingWithin, kpiCard, node } from '../shared/dom.js';
import { errorText, formatIntervalText, json, timestamp } from '../shared/format.js';
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

const PLUGIN_ACTION_FALLBACK_LABELS: Record<string, string> = {
  status: '实时状态',
  dashboard: '看板概览',
  patrol: '安全巡检',
  remind: '准点提醒',
  noon: '午间估值',
  settle: '晚间结算',
  devices: '设备列表',
  scan: '扫描发现',
  locate: '设备定位',
  'play-sound': '响铃寻物',
  trips: '骑行行程',
  vehicles: '车辆列表',
  'charge-check': '电量巡检',
  sync: '唤醒同步',
  config: '参数配置',
  on: '临时开灯',
  off: '临时关灯',
  resume: '恢复行程',
};

function resolvePluginActionLabel(specs: readonly PluginActionSpec[], actionName: string): string {
  const matched = specs.find(spec => spec.name === actionName);
  if (matched?.label) return matched.label;
  return PLUGIN_ACTION_FALLBACK_LABELS[actionName] ?? actionName;
}

function hasActivePluginUiState(container: HTMLElement): boolean {
  if (isEditingWithin(container)) return true;
  if (container.querySelector('details[open]')) return true;
  for (const banner of container.querySelectorAll<HTMLElement>('.hub-probe-banner')) {
    if (!banner.hidden) return true;
  }
  return false;
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
  const pluginSurfaceTabs = element<HTMLElement>('plugin-surface-tabs');
  const pluginTabCatalog = element<HTMLButtonElement>('plugin-tab-catalog');
  const pluginPanelCatalog = element<HTMLElement>('plugin-panel-catalog');
  const pluginKpiGrid = element<HTMLElement>('plugin-kpi-grid');
  const pluginListSubtitle = element<HTMLElement>('plugin-list-subtitle');
  const pluginsList = element<HTMLElement>('plugins-list');

  const surfaces = (options.pluginSurfaces ?? []).map(reg => ({
    reg,
    tabEl: element<HTMLButtonElement>(reg.tabId),
    panelEl: element<HTMLElement>(reg.panelId),
  }));
  const surfaceByName = new Map(surfaces.map(entry => [entry.reg.pluginName, entry]));
  const surfaceLoadPromises = new Map<string, Promise<PluginSurfaceLifecycle>>();
  const surfaceControllers = new Map<string, PluginSurfaceLifecycle>();
  const surfaceBadgeSynced = new Set<string>();

  let focusedPluginName: string | undefined;
  let expandFocusedPluginSource = false;
  let activePluginTab = 'catalog';
  let activeSurfaceCtrl: PluginSurfaceLifecycle | undefined;
  let tabSwitchSeq = 0;

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
  }

  function switchPluginTab(targetTab: string): void {
    const entry = targetTab === 'catalog' ? undefined : surfaceByName.get(targetTab);
    const resolvedTab = entry && isSurfaceEnabled(entry.reg.pluginName) ? targetTab : 'catalog';
    const seq = ++tabSwitchSeq;

    if (activePluginTab !== resolvedTab) {
      deactivateActiveSurface();
    }
    activePluginTab = resolvedTab;
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
        titleGroup.append(node('span', `🔌 ${timer.plugin}/${timer.pluginAction ?? 'status'}`, 'hub-badge badge-purple'));
      }
      if (timer.deliverChannelId) {
        titleGroup.append(node('span', `📨 投递: ${timer.deliverChannelId}${timer.deliverTarget ? `→${timer.deliverTarget}` : ''}`, 'hub-badge badge-blue'));
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
      if (timer.plugin) {
        const boundPlugin = plugins.find(p => p.name === timer.plugin);
        const act = timer.pluginAction ?? 'status';
        const runtimeArgs = JSON.stringify({
          timerId: timer.id,
          timerName: timer.name,
          instruction: timer.instruction,
        });
        const execLine = boundPlugin?.entryPath
          ? `⚙️ 执行命令: node ${boundPlugin.entryPath} ${act} '${runtimeArgs}'`
          : `⚙️ 执行方式: friday plugin run ${timer.plugin} ${act} '${runtimeArgs}'`;
        const envLine = boundPlugin?.dataDir
          ? `🔧 注入环境变量: FRIDAY_HOME · FRIDAY_PLUGIN_DATA_DIR=${boundPlugin.dataDir}`
          : `🔧 注入环境变量: FRIDAY_HOME · FRIDAY_PLUGIN_DATA_DIR=~/.friday/plugins/${timer.plugin}/data`;
        const execBox = node('div', '', 'hub-code-block');
        execBox.append(node('div', execLine, 'meta'), node('div', envLine, 'meta'));
        card.append(execBox);
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

  function renderPlugins(force = false) {
    const plugins: PluginView[] = appState.view?.plugins ?? [];
    const timers = appState.view?.timers ?? [];
    const totalActions = plugins.reduce((sum, p) => sum + (p.actions?.length ?? 0), 0);
    const boundTimersCount = timers.filter(t => Boolean(t.plugin)).length;
    const activeBoundTimersCount = timers.filter(t => Boolean(t.plugin) && t.enabled).length;
    const enabledCount = plugins.filter(p => p.enabled !== false).length;
    const surfaceCount = plugins.filter(p => p.enabled !== false && surfaceByName.has(p.name)).length;
    const countText = String(plugins.length);
    pluginTopBadge.textContent = countText;
    pluginCatalogBadge.textContent = countText;

    if ((pluginHubBackdrop.hidden || activePluginTab !== 'catalog') && !force) {
      return;
    }

    const kpiFrag = document.createDocumentFragment();
    kpiFrag.append(
      kpiCard(
        '已安装插件',
        `${plugins.length}`,
        plugins.length ? `已启用 ${enabledCount} 个 · ${surfaceCount} 个专属看板` : '',
        plugins.length > 0 ? 'positive' : 'default',
      ),
      kpiCard(
        '支持能力数',
        `${totalActions}`,
        totalActions > 0 ? '可在对话或副屏中直接调用' : '',
        totalActions > 0 ? 'accent' : 'default',
      ),
      kpiCard(
        '自动化巡检',
        `${boundTimersCount}`,
        boundTimersCount > 0 ? `运行中 ${activeBoundTimersCount} 项` : '暂未绑定定时巡检',
        boundTimersCount > 0 ? 'positive' : 'default',
      ),
    );
    pluginKpiGrid.replaceChildren(kpiFrag);
    pluginListSubtitle.textContent = plugins.length ? `共 ${plugins.length} 个已安装插件` : '暂无插件';

    // Do not wipe edited runner inputs, open accordions, or probe output during SSE background updates.
    if (!force && hasActivePluginUiState(pluginsList)) return;

    const contents = document.createDocumentFragment();
    for (const plugin of plugins) {
      const isFocused = focusedPluginName === plugin.name;
      const isEnabled = plugin.enabled !== false;
      const surfaceEntry = surfaceByName.get(plugin.name);
      const card = node(
        'article',
        '',
        `hub-entity-card plugin-card${isFocused ? ' is-active' : ''}${!isEnabled ? ' is-paused' : ''}`,
      );
      card.dataset.pluginName = plugin.name;

      const head = node('div', '', 'hub-card-head plugin-card-head');
      const headerMain = node('div', '', 'plugin-card-head-main');
      const titleGroup = node('div', '', 'hub-card-title-group');
      titleGroup.append(
        surfaceEntry
          ? node('span', '专属看板', 'hub-badge badge-teal')
          : node('span', '系统扩展', 'hub-badge badge-purple'),
        node('span', `${plugin.actions.length} 项能力`, 'hub-meta-chip'),
      );
      if (!isEnabled) {
        titleGroup.append(node('span', '已禁用', 'hub-badge badge-slate'));
      }
      headerMain.append(
        titleGroup,
        node('strong', plugin.title || plugin.name, 'hub-card-title plugin-card-title'),
      );
      head.append(headerMain);
      if (surfaceEntry && isEnabled) {
        const openSurfaceBtn = button(`打开${surfaceEntry.reg.label}`, () => {
          switchPluginTab(plugin.name);
        }, 'primary plugin-open-btn');
        openSurfaceBtn.disabled = appState.authExpired || !appState.ready;
        head.append(openSurfaceBtn);
      }
      card.append(head);

      card.append(node('p', plugin.description, 'hub-card-body-text plugin-card-desc'));

      const specs: PluginActionSpec[] = plugin.actionSpecs?.length
        ? plugin.actionSpecs
        : plugin.actions.map(a => ({ name: a }));

      if (specs.length) {
        const capRow = node('div', '', 'plugin-cap-row');
        for (const spec of specs.slice(0, 6)) {
          const capLabel = spec.label || resolvePluginActionLabel(specs, spec.name);
          const capChip = node('span', capLabel, 'plugin-cap-chip');
          if (spec.description) capChip.title = spec.description;
          capRow.append(capChip);
        }
        if (specs.length > 6) {
          capRow.append(node('span', `+${specs.length - 6}`, 'plugin-cap-chip is-overflow'));
        }
        card.append(capRow);
      }

      const boundTimers = timers.filter(t => t.plugin === plugin.name);
      if (boundTimers.length) {
        const timerRow = node('div', '', 'hub-badges-row plugin-timer-row');
        timerRow.append(node('span', `⏰ 关联巡检 (${boundTimers.length})`, 'hub-meta-chip'));
        for (const bt of boundTimers) {
          const actLabel = resolvePluginActionLabel(specs, bt.pluginAction ?? 'status');
          const scheduleLabel = bt.dailyAt ? `每日 ${bt.dailyAt}` : formatIntervalText(bt.intervalMs);
          timerRow.append(node(
            'span',
            `${bt.name} · ${scheduleLabel} · ${actLabel}${bt.deliverChannelId ? ` → ${bt.deliverChannelId}` : ''}`,
            `hub-badge ${bt.enabled ? 'badge-green' : 'badge-slate'}`,
          ));
        }
        card.append(timerRow);
      }

      const devDrawer = node('details', '', 'hub-accordion plugin-dev-drawer') as HTMLDetailsElement;
      if (isFocused && expandFocusedPluginSource) devDrawer.open = true;
      devDrawer.append(node('summary', '🛠️ 开发者调试、运行参数与源码', 'hub-accordion-summary'));

      const devBody = node('div', '', 'plugin-dev-drawer-body');

      const pathBox = node('div', '', 'hub-code-block');
      pathBox.append(
        node(
          'div',
          plugin.entryPath
            ? `📄 执行脚本入口: ${plugin.entryPath}`
            : `📄 执行入口: ${plugin.entry} (${plugin.runtime ?? 'subprocess'})`,
          'meta',
        ),
        node(
          'div',
          plugin.dataDir
            ? `💾 专属数据目录 (FRIDAY_PLUGIN_DATA_DIR): ${plugin.dataDir}`
            : `💾 数据隔离目录: FRIDAY_PLUGIN_DATA_DIR (~/.friday/plugins/${plugin.name}/data)`,
          'meta',
        ),
      );
      devBody.append(pathBox);

      const runnerWrap = node('div', '', 'hub-form-card');
      runnerWrap.append(node('strong', '⚙️ 动作与参数调试', 'hub-card-title'));

      const actionSelect = node('select', '', 'hub-input') as HTMLSelectElement;
      for (const spec of specs) {
        const opt = node('option', `${spec.name}${spec.label ? ` — ${spec.label}` : ''}`);
        opt.value = spec.name;
        actionSelect.append(opt);
      }

      const argsInput = node('input', '', 'hub-input mono-input') as HTMLInputElement;
      argsInput.type = 'text';
      argsInput.placeholder = '执行参数 JSON，例如 {} 或 {"target":"example"}';

      const cmdPreview = node('div', '', 'hub-code-block meta');
      const syncCmdPreview = () => {
        const act = actionSelect.value || 'status';
        const rawArgs = argsInput.value.trim() || '{}';
        cmdPreview.textContent = plugin.entryPath
          ? `$ node ${plugin.entryPath} ${act} '${rawArgs}'`
          : `$ friday plugin run ${plugin.name} ${act} '${rawArgs}'`;
      };

      const selectSpec = (specName: string) => {
        actionSelect.value = specName;
        const matched = specs.find(s => s.name === specName);
        argsInput.value = JSON.stringify(matched?.defaultArgs ?? {});
        syncCmdPreview();
      };

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
        specCard.append(node('div', `默认参数 JSON: ${JSON.stringify(spec.defaultArgs ?? {})}`, 'meta'));
        specsList.append(specCard);
      }
      runnerWrap.append(specsList);

      const controlsRow = node('div', '', 'hub-form-grid');
      const actField = node('label', '', 'hub-field');
      actField.append(node('span', '选择调试动作'), actionSelect);
      const argsField = node('label', '', 'hub-field hub-field-wide');
      argsField.append(node('span', '调试参数 (JSON 对象)'), argsInput);
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
          runResultBox.replaceChildren(
            node(
              'p',
              plugin.entryPath
                ? `正在执行 node ${plugin.entryPath} ${actionSelect.value} …`
                : `正在执行 ${plugin.name}/${actionSelect.value} …`,
              'meta',
            ),
          );
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
              node('strong', `${res.ok ? '✅ 执行成功' : '❌ 执行返回失败'} · 动作=${res.action} · 通知=${res.notify ? '是' : '否'}`),
              node('pre', res.message),
            );
            if (res.data !== undefined) {
              const dataDetails = node('details');
              dataDetails.append(node('summary', '查看返回结构化数据'), node('pre', json(res.data)));
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
      }, 'primary mini-button');
      runBtn.disabled = appState.authExpired || !appState.ready;
      runActionsRow.append(runBtn);
      runnerWrap.append(runActionsRow, runResultBox);
      devBody.append(runnerWrap);

      if (plugin.sourceCode) {
        const codeDetails = node('details', '', 'hub-accordion plugin-dev-subdrawer') as HTMLDetailsElement;
        if (isFocused && expandFocusedPluginSource) codeDetails.open = true;
        const lineCount = plugin.sourceCode.split('\n').length;
        codeDetails.append(
          node('summary', `📄 查看具体执行代码 (${plugin.entry} · ${lineCount} 行)`, 'hub-accordion-summary'),
          node('pre', plugin.sourceCode, 'hub-code-block'),
        );
        devBody.append(codeDetails);
      }

      if (plugin.manifestJson) {
        const manifestDetails = node('details', '', 'hub-accordion plugin-dev-subdrawer') as HTMLDetailsElement;
        if (isFocused && expandFocusedPluginSource && !plugin.sourceCode) manifestDetails.open = true;
        manifestDetails.append(
          node('summary', '📋 查看插件清单配置 (plugin.json)', 'hub-accordion-summary'),
          node('pre', plugin.manifestJson, 'hub-code-block'),
        );
        devBody.append(manifestDetails);
      }

      devDrawer.append(devBody);
      card.append(devDrawer);

      contents.append(card);
    }
    if (!plugins.length) {
      contents.append(node('p', '当前未发现任何插件（存放于 plugins/<name>/plugin.json）', 'empty hub-empty-state'));
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
    focusedPluginName = pluginName;
    expandFocusedPluginSource = expandSource;
    pluginHubBackdrop.hidden = false;

    const targetTab = mode === 'surface' && pluginName
      ? pluginName
      : pluginName
        ? 'catalog'
        : activePluginTab;
    switchPluginTab(targetTab);
    refreshEnabledBadges();
  }

  function closePluginModal() {
    tabSwitchSeq++;
    deactivateActiveSurface();
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
  }

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
  pluginSurfaceTabs.addEventListener('click', event => {
    const tabBtn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-plugin-tab]');
    const nextTab = tabBtn?.dataset.pluginTab;
    if (!nextTab || nextTab === activePluginTab) return;
    switchPluginTab(nextTab);
  });

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

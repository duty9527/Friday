import type { PluginActionSpec, PluginView, TimerView } from '../../view.js';
import { button, element, isEditingWithin, kpiCard, node } from '../shared/dom.js';
import { errorText, formatIntervalText, json, timestamp } from '../shared/format.js';
import { api, appState, hooks } from '../state.js';

export interface TimerPluginHubController {
  openTimerModal: () => void;
  closeTimerModal: () => void;
  renderTimers: (force?: boolean) => void;
  openPluginModal: (pluginName?: string, expandSource?: boolean) => void;
  closePluginModal: () => void;
  renderPlugins: (force?: boolean) => void;
}

function hasActivePluginUiState(container: HTMLElement): boolean {
  if (isEditingWithin(container)) return true;
  if (container.querySelector('details[open]')) return true;
  for (const banner of container.querySelectorAll<HTMLElement>('.hub-probe-banner')) {
    if (!banner.hidden) return true;
  }
  return false;
}

export function initTimerPluginHub(): TimerPluginHubController {
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
  const timerInstructionInput = element<HTMLTextAreaElement>('timer-instruction-input');
  const timerSaveBtn = element<HTMLButtonElement>('timer-save-btn');
  const timerListSubtitle = element<HTMLElement>('timer-list-subtitle');
  const timersList = element<HTMLElement>('timers-list');

  const pluginTopBadge = element<HTMLElement>('plugin-top-badge');
  const openPluginHubTop = element<HTMLButtonElement>('open-plugin-hub-top');
  const pluginHubBackdrop = element<HTMLElement>('plugin-hub-backdrop');
  const pluginModalClose = element<HTMLButtonElement>('plugin-modal-close');
  const pluginKpiGrid = element<HTMLElement>('plugin-kpi-grid');
  const pluginListSubtitle = element<HTMLElement>('plugin-list-subtitle');
  const pluginsList = element<HTMLElement>('plugins-list');

  let focusedPluginName: string | undefined;
  let expandFocusedPluginSource = false;

  function renderDynamicTimerPresets(plugins: PluginView[]) {
    for (const stale of timerPresetBar.querySelectorAll<HTMLElement>('.dynamic-preset')) {
      stale.remove();
    }
    let added = 0;
    for (const plugin of plugins) {
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
    const instruction = timerInstructionInput.value.trim();
    if (!name || (!instruction && !plugin) || (!dailyAt && (!Number.isFinite(intervalSeconds) || intervalSeconds < 5))) return;
    timerSaveBtn.disabled = true;
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
      timerNameInput.value = '';
      timerDailyInput.value = '';
      timerPluginInput.value = '';
      timerChannelInput.value = '';
      timerInstructionInput.value = '';
      await hooks.refreshView();
    } catch (error) {
      hooks.connection(`创建定时器失败：${errorText(error)}`, true);
    } finally {
      timerSaveBtn.disabled = false;
    }
  }

  function renderTimers(force = false) {
    const timers = appState.view?.timers ?? [];
    const plugins = appState.view?.plugins ?? [];
    const activeCount = timers.filter(t => t.enabled).length;
    const pausedCount = timers.length - activeCount;
    const missedTotal = timers.reduce((sum, t) => sum + (t.missedRuns ?? 0), 0);
    timerTopBadge.textContent = timers.length ? `${activeCount}/${timers.length}` : '0';

    if (timerHubBackdrop.hidden && !force) {
      appState.dirtyModals.add('timer');
      return;
    }
    appState.dirtyModals.delete('timer');

    renderDynamicTimerPresets(plugins);

    const kpiFrag = document.createDocumentFragment();
    kpiFrag.append(
      kpiCard('运行中', `${activeCount}`, '', activeCount > 0 ? 'positive' : 'default'),
      kpiCard('已暂停', `${pausedCount}`, '', 'default'),
      kpiCard('漏跑补偿', `${missedTotal}`, '', missedTotal > 0 ? 'warning' : 'default'),
    );
    timerKpiGrid.replaceChildren(kpiFrag);
    timerListSubtitle.textContent = timers.length ? `${activeCount} / ${timers.length} 运行中` : '';

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
      const toggleBtn = button(timer.enabled ? '⏸ 暂停' : '▶️ 启用', () => { void toggleTimerFromUi(timer.id, !timer.enabled); }, 'mini-button');
      const delBtn = button('🗑️ 删除', () => { void removeTimerFromUi(timer.id); }, 'mini-button danger-btn');
      toggleBtn.disabled = appState.authExpired || !appState.ready;
      delBtn.disabled = appState.authExpired || !appState.ready;
      actions.append(toggleBtn, delBtn);
      head.append(actions);
      card.append(head);

      card.append(node('div', timer.instruction, 'hub-code-block'));
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
    timersList.replaceChildren(contents);
  }

  function renderPlugins(force = false) {
    const plugins: PluginView[] = appState.view?.plugins ?? [];
    const timers = appState.view?.timers ?? [];
    const totalActions = plugins.reduce((sum, p) => sum + (p.actions?.length ?? 0), 0);
    const boundTimersCount = timers.filter(t => Boolean(t.plugin)).length;
    pluginTopBadge.textContent = String(plugins.length);

    if (pluginHubBackdrop.hidden && !force) {
      appState.dirtyModals.add('plugin');
      return;
    }
    appState.dirtyModals.delete('plugin');

    const kpiFrag = document.createDocumentFragment();
    kpiFrag.append(
      kpiCard('已加载插件', `${plugins.length}`, '', plugins.length > 0 ? 'positive' : 'default'),
      kpiCard('可执行动作 (Actions)', `${totalActions}`, '', totalActions > 0 ? 'accent' : 'default'),
      kpiCard('绑定定时任务', `${boundTimersCount}`, '', boundTimersCount > 0 ? 'positive' : 'default'),
    );
    pluginKpiGrid.replaceChildren(kpiFrag);
    pluginListSubtitle.textContent = plugins.length ? `共 ${plugins.length} 个脚本插件` : '暂无插件';

    // Do not wipe edited runner inputs, open accordions, or probe output during SSE background updates.
    if (!force && hasActivePluginUiState(pluginsList)) return;

    const contents = document.createDocumentFragment();
    for (const plugin of plugins) {
      const isFocused = focusedPluginName === plugin.name;
      const card = node('article', '', `hub-entity-card plugin-card${isFocused ? ' is-active' : ''}`);
      card.dataset.pluginName = plugin.name;

      const head = node('div', '', 'hub-card-head');
      const titleGroup = node('div', '', 'hub-card-title-group');
      titleGroup.append(
        node('span', '🔌 脚本插件', 'hub-badge badge-purple'),
        node('strong', `${plugin.title} (${plugin.name})`, 'hub-card-title'),
        node('span', `${plugin.actions.length} 个动作`, 'hub-badge badge-teal'),
      );
      head.append(titleGroup);
      card.append(head);

      card.append(node('p', plugin.description, 'hub-card-body-text'));

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
            : `💾 数据隔离模式: FRIDAY_PLUGIN_DATA_DIR (~/.friday/plugins/${plugin.name}/data)`,
          'meta',
        ),
      );
      card.append(pathBox);

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
        specCard.append(node('div', `默认/示例参数 (argv[3] JSON): ${JSON.stringify(spec.defaultArgs ?? {})}`, 'meta'));
        specsList.append(specCard);
      }
      runnerWrap.append(specsList);

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
      runBtn.disabled = appState.authExpired || !appState.ready;
      runActionsRow.append(runBtn);
      runnerWrap.append(runActionsRow, runResultBox);
      card.append(runnerWrap);

      if (plugin.sourceCode) {
        const codeDetails = node('details', '', 'hub-accordion');
        if (isFocused && expandFocusedPluginSource) codeDetails.open = true;
        const lineCount = plugin.sourceCode.split('\n').length;
        codeDetails.append(
          node('summary', `📄 查看具体执行代码 (${plugin.entry} · ${lineCount} 行)`, 'hub-accordion-summary'),
          node('pre', plugin.sourceCode, 'hub-code-block'),
        );
        card.append(codeDetails);
      }

      if (plugin.manifestJson) {
        const manifestDetails = node('details', '', 'hub-accordion');
        if (isFocused && expandFocusedPluginSource && !plugin.sourceCode) manifestDetails.open = true;
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

  function openPluginModal(pluginName?: string, expandSource = false) {
    hooks.closeAllHubModals();
    focusedPluginName = pluginName;
    expandFocusedPluginSource = expandSource;
    pluginHubBackdrop.hidden = false;
    renderPlugins(true);
  }

  function closePluginModal() {
    pluginHubBackdrop.hidden = true;
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

  return {
    openTimerModal,
    closeTimerModal,
    renderTimers,
    openPluginModal,
    closePluginModal,
    renderPlugins,
  };
}

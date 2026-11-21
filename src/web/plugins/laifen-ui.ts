import { button, element, isEditingWithin, kpiCard, node } from '../shared/dom.js';
import { errorText, timestamp } from '../shared/format.js';
import { api } from '../state.js';

export interface LaifenUiOptions {
  isVisible: () => boolean;
}

export interface LaifenUiController {
  activate: () => void;
  deactivate: () => void;
  refreshBadge: () => Promise<void>;
}

interface ModeSlot {
  strength: number;
  range: number;
  speed: number;
}

interface LaifenDeviceState {
  mac: string;
  address: string;
  name: string;
  protocol: string;
  rssi: number | null;
  batteryPct: number | null;
  activeMode: number;
  activeStrength: number | null;
  activeRange: number | null;
  activeSpeed: number | null;
  modes: Record<string, ModeSlot>;
  durationSec: number;
  highFrequency: boolean;
  reminder30s: boolean;
  airplaneMode: boolean;
  status: string;
  features?: Record<string, unknown>;
  lastSyncedAt: number | null;
}

interface LaifenPreset {
  id: string;
  label: string;
  mode: number;
  strength: number;
  range: number;
  speed: number;
  highFrequency: boolean;
  description: string;
}

interface LaifenBrushSession {
  id: string;
  mac: string;
  brushedAt: number;
  durationSec: number;
  mode: number | null;
  strength: number | null;
  range: number | null;
  speed: number | null;
  batteryBefore: number | null;
  batteryAfter: number | null;
  overPressureCount: number;
  source: string;
  note: string;
}

interface LaifenDayBucket {
  date: string;
  label: string;
  count: number;
  totalDurationSec: number;
  goalMet: boolean;
}

interface LaifenStats {
  todayCount: number;
  todayDurationSec: number;
  dailyGoalCount: number;
  morningDone: boolean;
  eveningDone: boolean;
  streakDays: number;
  goalStreakDays: number;
  totalSessions: number;
  last7Days: LaifenDayBucket[];
  brushHead: {
    replacedAt: number | null;
    lifespanDays: number;
    daysUsed: number;
    daysLeft: number;
    percentLeft: number;
    usedSessions: number;
    needsReplacement: boolean;
  };
}

interface LaifenLiveSession {
  sessionId: string;
  phase: string;
  message: string;
  activeBrushingSec: number;
  overPressureEvents: number;
  startedAt: number | null;
  updatedAt: number | null;
}

interface LaifenConfig {
  targetMac: string;
  namePrefix: string;
  brushHeadLifespanDays: number;
  brushHeadReplacedAt: number | null;
  dailyGoalCount: number;
  targetDurationSec: number;
}

interface LaifenWatchStatus {
  enabled: boolean;
  running: boolean;
  phase: string;
  message: string;
  updatedAt: number | null;
  lastSyncedAt?: number | null;
  lastEventKind?: string | null;
  error?: string | null;
}

interface LaifenPendingPatch {
  patchId: string;
  patch: Record<string, unknown>;
  queuedAt: number;
}

interface LaifenDashboardPayload {
  batteryPct: number | null;
  activeMode: number | null;
  todayCount: number;
  streakDays: number;
  brushHeadDaysLeft: number;
  device: LaifenDeviceState | null;
  stats: LaifenStats;
  sessions: LaifenBrushSession[];
  liveSession: LaifenLiveSession | null;
  watchStatus?: LaifenWatchStatus;
  pendingPatch?: LaifenPendingPatch | null;
  presets: LaifenPreset[];
  config: LaifenConfig;
}

interface PluginRunResponse<T = unknown> {
  ok: boolean;
  plugin: string;
  action: string;
  title?: string;
  message?: string;
  data?: T;
}

const SOURCE_LABELS: Record<string, string> = {
  ble_monitor: '蓝牙实测',
  ble_auto: '唤醒自动记录',
  manual: '手动打卡',
};

const PHASE_BADGES: Record<string, { text: string; cls: string }> = {
  scanning: { text: '扫描唤醒中', cls: 'badge-amber' },
  connecting: { text: '连接中', cls: 'badge-amber' },
  monitoring: { text: '监听同步中', cls: 'badge-green' },
  watching: { text: '自动唤醒监听中', cls: 'badge-green' },
  brushing: { text: '自动监测刷牙中', cls: 'badge-green' },
  cooldown: { text: '已同步 · 冷却待机', cls: 'badge-green' },
  syncing: { text: '自动同步中', cls: 'badge-amber' },
  yielding: { text: '蓝牙礼让中', cls: 'badge-amber' },
  starting: { text: '守护启动中', cls: 'badge-amber' },
  completed: { text: '已完成', cls: 'badge-green' },
  stopped: { text: '已停止', cls: 'badge-slate' },
  timeout: { text: '已超时', cls: 'badge-slate' },
  error: { text: '异常', cls: 'badge-red' },
};

function formatLaifenDisplayName(raw?: string | null): string {
  const s = (raw || '').trim();
  return s && /[\u4e00-\u9fff]/.test(s) ? s : '徕芬电动牙刷';
}

export function initLaifenUi(options: LaifenUiOptions): LaifenUiController {
  const panelEl = element<HTMLElement>('plugin-panel-laifen');
  const topBadge = element<HTMLElement>('laifen-top-badge');
  const statusBanner = element<HTMLElement>('laifen-action-status');
  const kpiGrid = element<HTMLElement>('laifen-kpi-grid');

  const refreshBtn = element<HTMLButtonElement>('laifen-refresh-btn');
  const syncBtn = element<HTMLButtonElement>('laifen-sync-btn');
  const scanBtn = element<HTMLButtonElement>('laifen-scan-btn');

  const livePhaseEl = element<HTMLElement>('laifen-live-phase');
  const liveMessageEl = element<HTMLElement>('laifen-live-message');
  const deviceMetaEl = element<HTMLElement>('laifen-device-meta');
  const monitorStartBtn = element<HTMLButtonElement>('laifen-monitor-start-btn');
  const monitorStopBtn = element<HTMLButtonElement>('laifen-monitor-stop-btn');
  const checkinBtn = element<HTMLButtonElement>('laifen-checkin-btn');
  const brushheadResetBtn = element<HTMLButtonElement>('laifen-brushhead-reset-btn');

  const modePillsEl = element<HTMLElement>('laifen-mode-pills');
  const presetPillsEl = element<HTMLElement>('laifen-preset-pills');
  const strengthInput = element<HTMLInputElement>('laifen-strength');
  const strengthValEl = element<HTMLElement>('laifen-strength-val');
  const rangeInput = element<HTMLInputElement>('laifen-range');
  const rangeValEl = element<HTMLElement>('laifen-range-val');
  const speedInput = element<HTMLInputElement>('laifen-speed');
  const speedValEl = element<HTMLElement>('laifen-speed-val');
  const durationInput = element<HTMLInputElement>('laifen-duration');
  const durationValEl = element<HTMLElement>('laifen-duration-val');

  const hfCheck = element<HTMLInputElement>('laifen-hf-check');
  const reminderCheck = element<HTMLInputElement>('laifen-reminder-check');
  const airplaneCheck = element<HTMLInputElement>('laifen-airplane-check');

  const v2proGroup = element<HTMLElement>('laifen-v2pro-group');
  const deepCleanCheck = element<HTMLInputElement>('laifen-deepclean-check');
  const antiSplashCheck = element<HTMLInputElement>('laifen-antisplash-check');
  const rampUpCheck = element<HTMLInputElement>('laifen-rampup-check');
  const bristleCheck = element<HTMLInputElement>('laifen-bristle-check');
  const wakeCheck = element<HTMLInputElement>('laifen-wake-check');
  const overPressureSelect = element<HTMLSelectElement>('laifen-overpressure-select');
  const applyBtn = element<HTMLButtonElement>('laifen-apply-btn');

  const weekStripEl = element<HTMLElement>('laifen-week-strip');
  const sessionsSubtitleEl = element<HTMLElement>('laifen-sessions-subtitle');
  const sessionsListEl = element<HTMLElement>('laifen-sessions-list');

  const cfgMacInput = element<HTMLInputElement>('laifen-cfg-mac');
  const cfgPrefixInput = element<HTMLInputElement>('laifen-cfg-prefix');
  const cfgLifespanInput = element<HTMLInputElement>('laifen-cfg-lifespan');
  const cfgGoalInput = element<HTMLInputElement>('laifen-cfg-goal');
  const cfgSaveBtn = element<HTMLButtonElement>('laifen-cfg-save-btn');

  const powerOnBtn = element<HTMLButtonElement>('laifen-power-on-btn');
  const powerOffBtn = element<HTMLButtonElement>('laifen-power-off-btn');
  const calLimpBtn = element<HTMLButtonElement>('laifen-cal-limp-btn');
  const calAlignBtn = element<HTMLButtonElement>('laifen-cal-align-btn');

  let active = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let bleProgressTimer: ReturnType<typeof setInterval> | undefined;
  let latestData: LaifenDashboardPayload | undefined;
  let selectedMode = 1;
  let draftDirty = false;
  let busy = false;
  let bleOpInFlight = false;

  // Dynamic strict-CSP UI elements injected into existing plugin panel
  const watchRow = node('div', '', 'modal-row-head');
  const watchLeft = node('div', '', 'laifen-pill-row');
  const watchLabelEl = node('span', '后台自动唤醒：', 'meta');
  const watchBadgeEl = node('span', '未开启', 'hub-badge badge-slate');
  watchLeft.append(watchLabelEl, watchBadgeEl);
  const watchToggleBtn = button('开启自动唤醒同步', () => {
    const currentlyEnabled = Boolean(latestData?.watchStatus?.enabled);
    void runBusyAction(
      currentlyEnabled ? '正在关闭后台自动唤醒同步…' : '正在开启后台自动唤醒同步…',
      async () => {
        const res = await callPlugin<LaifenDashboardPayload & { dashboard?: LaifenDashboardPayload }>(
          currentlyEnabled ? 'watch-stop' : 'watch-start',
          {},
        );
        setBanner(res.message || (res.ok ? '已更新自动唤醒状态' : '切换自动唤醒失败'), !res.ok);
        if (res.data?.dashboard) renderDashboard(res.data.dashboard);
        else await refreshDashboard();
      },
    );
  }, 'mini-button');
  watchRow.append(watchLeft, watchToggleBtn);
  const heroBtnGroup = monitorStartBtn.parentElement;
  if (heroBtnGroup && heroBtnGroup.parentElement) {
    heroBtnGroup.parentElement.insertBefore(watchRow, heroBtnGroup);
  }

  const queueBtn = button('📥 暂存（下次唤醒自动写入）', () => {
    void runBusyAction('正在暂存参数到待唤醒队列…', async () => {
      const res = await callPlugin('set', buildSetArgs({ queueOnly: true }));
      setBanner(res.message || (res.ok ? '已暂存待唤醒写入' : '暂存失败'), !res.ok);
      if (res.ok) draftDirty = false;
      await refreshDashboard();
    });
  }, 'mini-button');
  const applyGroup = node('div', '', 'modal-btn-group');
  if (applyBtn.parentElement) {
    applyBtn.replaceWith(applyGroup);
    applyGroup.append(queueBtn, applyBtn);
  }

  const pendingBox = node('div', '', 'laifen-v2pro-box');
  pendingBox.hidden = true;
  const pendingRow = node('div', '', 'modal-row-head');
  const pendingTextEl = node('span', '', 'meta');
  const pendingClearBtn = button('撤销暂存', () => {
    void runBusyAction('正在清空暂存参数…', async () => {
      const res = await callPlugin<LaifenDashboardPayload & { dashboard?: LaifenDashboardPayload }>('pending-clear', {});
      setBanner(res.message || (res.ok ? '已清空暂存参数' : '撤销失败'), !res.ok);
      if (res.data?.dashboard) renderDashboard(res.data.dashboard);
      else await refreshDashboard();
    });
  }, 'mini-button');
  pendingRow.append(pendingTextEl, pendingClearBtn);
  pendingBox.append(pendingRow);
  const applyHeader = applyGroup.parentElement;
  if (applyHeader && applyHeader.parentElement) {
    applyHeader.parentElement.insertBefore(pendingBox, applyHeader.nextSibling);
  }

  function setBanner(text: string, isError = false): void {
    statusBanner.textContent = text;
    statusBanner.classList.toggle('is-error', isError);
    statusBanner.hidden = !text;
  }

  function buildSetArgs(extras: Record<string, unknown> = {}): Record<string, unknown> {
    const args: Record<string, unknown> = {
      mode: selectedMode,
      strength: Number(strengthInput.value),
      range: Number(rangeInput.value),
      speed: Number(speedInput.value),
      durationSec: Number(durationInput.value),
      highFrequency: hfCheck.checked,
      reminder30s: reminderCheck.checked,
      airplaneMode: airplaneCheck.checked,
      ...extras,
    };
    if (latestData?.device?.protocol === 'v2pro') {
      args.deepClean = deepCleanCheck.checked;
      args.antiSplash = antiSplashCheck.checked;
      args.powerRampUp = rampUpCheck.checked;
      args.bristleProtection = bristleCheck.checked;
      args.liftToWake = wakeCheck.checked;
      args.overPressureLevel = overPressureSelect.value;
    }
    return args;
  }

  function summarizePendingPatch(patch: Record<string, unknown>): string {
    const parts: string[] = [];
    if (patch.mode !== undefined) parts.push(`Mode ${String(patch.mode)}`);
    if (patch.strength !== undefined || patch.range !== undefined || patch.speed !== undefined) {
      parts.push(`振${patch.strength ?? '-'}/幅${patch.range ?? '-'}/速${patch.speed ?? '-'}`);
    }
    if (patch.durationSec !== undefined) parts.push(`${String(patch.durationSec)}s`);
    if (patch.highFrequency !== undefined) parts.push(`高频${patch.highFrequency ? '开' : '关'}`);
    if (patch.reminder30s !== undefined) parts.push(`30s提醒${patch.reminder30s ? '开' : '关'}`);
    if (patch.airplaneMode !== undefined) parts.push(`飞行${patch.airplaneMode ? '开' : '关'}`);
    return parts.join(' · ') || '自定义参数';
  }

  function renderHeroLiveState(data: LaifenDashboardPayload): void {
    const live = data.liveSession;
    const watch = data.watchStatus;
    const isLiveActive = Boolean(live && ['scanning', 'connecting', 'monitoring'].includes(live.phase));
    const showStop = bleOpInFlight || isLiveActive;
    monitorStartBtn.hidden = showStop;
    monitorStopBtn.hidden = !showStop;
    const isOneShotWait = bleOpInFlight || Boolean(live?.sessionId && (live.sessionId.startsWith('sync-') || live.sessionId.startsWith('write-')));
    monitorStopBtn.textContent = isOneShotWait ? '⏹ 取消等待' : '⏹ 停止监听';

    if (isLiveActive && live) {
      const badge = PHASE_BADGES[live.phase] || { text: live.phase, cls: 'badge-amber' };
      livePhaseEl.className = `hub-badge ${badge.cls}`;
      livePhaseEl.textContent = badge.text;
      liveMessageEl.textContent = live.activeBrushingSec > 0
        ? `${live.message}（本次累计 ${live.activeBrushingSec}s）`
        : live.message;
    } else if (watch?.enabled && watch.running) {
      const badge = PHASE_BADGES[watch.phase] || { text: '自动唤醒监听中', cls: 'badge-green' };
      livePhaseEl.className = `hub-badge ${badge.cls}`;
      livePhaseEl.textContent = badge.text;
      liveMessageEl.textContent = watch.message || '后台自动唤醒监听中：拿起牙刷亮灯即自动同步电量与打卡';
    } else if (live) {
      const badge = PHASE_BADGES[live.phase] || { text: live.phase, cls: 'badge-slate' };
      livePhaseEl.className = `hub-badge ${badge.cls}`;
      livePhaseEl.textContent = badge.text;
      liveMessageEl.textContent = live.activeBrushingSec > 0
        ? `${live.message}（本次累计 ${live.activeBrushingSec}s）`
        : live.message;
    } else {
      livePhaseEl.className = 'hub-badge badge-slate';
      livePhaseEl.textContent = '待机中';
      liveMessageEl.textContent = '手动同步请先点击「🔄 唤醒同步」再拿起牙刷；建议开启下方「自动唤醒同步」，日常拿起即自动同步。';
    }

    if (watch) {
      const wBadge = watch.enabled
        ? (PHASE_BADGES[watch.running ? watch.phase : 'starting'] || { text: '已开启', cls: 'badge-green' })
        : { text: '未开启', cls: 'badge-slate' };
      watchBadgeEl.className = `hub-badge ${wBadge.cls}`;
      watchBadgeEl.textContent = wBadge.text;
      watchToggleBtn.textContent = watch.enabled ? '关闭自动唤醒' : '开启自动唤醒同步';
    }
  }

  async function callPlugin<T = unknown>(
    action: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<PluginRunResponse<T>> {
    return api<PluginRunResponse<T>>('/api/plugin-run', {
      plugin: 'laifen',
      action,
      args: { silent: true, ...args },
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  function updateTopBadge(payload?: { batteryPct?: number | null; device?: LaifenDeviceState | null }): void {
    topBadge.classList.remove('badge-green', 'badge-amber', 'badge-red', 'badge-slate');
    const batt = payload?.batteryPct ?? payload?.device?.batteryPct ?? null;
    if (batt === null || batt === undefined) {
      topBadge.textContent = '待同步';
      topBadge.classList.add('badge-slate');
      return;
    }
    topBadge.textContent = `${batt}%`;
    topBadge.classList.add(batt <= 20 ? 'badge-red' : (batt <= 40 ? 'badge-amber' : 'badge-green'));
  }

  function syncSliderReadouts(): void {
    const isHf = selectedMode === 4;
    strengthInput.min = isHf ? '11' : '1';
    strengthInput.max = isHf ? '20' : '10';
    const rawStr = Number(strengthInput.value);
    const clampedStr = isHf ? Math.max(11, Math.min(20, rawStr)) : Math.max(1, Math.min(10, rawStr));
    if (clampedStr !== rawStr) strengthInput.value = String(clampedStr);
    strengthValEl.textContent = `${clampedStr}${isHf ? ' (高频)' : ''}`;
    rangeValEl.textContent = rangeInput.value;
    speedValEl.textContent = speedInput.value;
    const dur = Number(durationInput.value);
    const mins = (dur / 60).toFixed(dur % 60 === 0 ? 0 : 1);
    durationValEl.textContent = `${dur}s (${mins} 分钟)`;
  }

  function renderModePills(): void {
    const pills = modePillsEl.querySelectorAll<HTMLButtonElement>('button[data-mode]');
    for (const pill of pills) {
      const m = Number(pill.dataset.mode);
      pill.classList.toggle('active', m === selectedMode);
    }
  }

  function applyDeviceControls(dev: LaifenDeviceState | null): void {
    if (!dev) return;
    selectedMode = Math.max(1, Math.min(4, dev.activeMode || 1));
    renderModePills();
    const slot = dev.modes?.[String(selectedMode)];
    if (slot) {
      strengthInput.value = String(slot.strength);
      rangeInput.value = String(slot.range);
      speedInput.value = String(slot.speed);
    }
    durationInput.value = String(dev.durationSec || 180);
    hfCheck.checked = Boolean(dev.highFrequency);
    reminderCheck.checked = Boolean(dev.reminder30s);
    airplaneCheck.checked = Boolean(dev.airplaneMode);

    const isV2Pro = dev.protocol === 'v2pro';
    v2proGroup.hidden = !isV2Pro;
    if (isV2Pro && dev.features) {
      deepCleanCheck.checked = Boolean(dev.features.deepClean);
      antiSplashCheck.checked = Boolean(dev.features.antiSplash);
      rampUpCheck.checked = Boolean(dev.features.powerRampUp);
      bristleCheck.checked = Boolean(dev.features.bristleProtection);
      wakeCheck.checked = Boolean(dev.features.liftToWake);
      const lvl = String(dev.features.overPressureLevel || 'Medium');
      if (['Light', 'Medium', 'Hard'].includes(lvl)) {
        overPressureSelect.value = lvl;
      }
    }
    syncSliderReadouts();
  }

  function renderDashboard(data: LaifenDashboardPayload): void {
    latestData = data;
    updateTopBadge(data);

    const dev = data.device;
    const st = data.stats;
    const bh = st.brushHead;

    const battSub = dev?.lastSyncedAt
      ? `上次同步 ${timestamp(dev.lastSyncedAt)}${data.watchStatus?.enabled ? ' · 拿起自动同步' : ''}`
      : (data.watchStatus?.enabled ? '自动唤醒已开启 · 拿起牙刷即同步' : '请先点「唤醒同步」再拿起牙刷');

    kpiGrid.replaceChildren(
      kpiCard(
        '剩余电量',
        dev?.batteryPct !== null && dev?.batteryPct !== undefined ? `${dev.batteryPct}%` : '待同步',
        battSub,
        dev?.batteryPct !== null && dev?.batteryPct !== undefined
          ? (dev.batteryPct <= 20 ? 'warning' : 'positive')
          : 'default',
      ),
      kpiCard(
        '当前档位与参数',
        dev ? `Mode ${dev.activeMode}` : '未连接',
        dev
          ? `振 ${dev.activeStrength ?? '--'} · 幅 ${dev.activeRange ?? '--'} · 速 ${dev.activeSpeed ?? '--'} · ${dev.durationSec}s`
          : '待同步',
        'accent',
      ),
      kpiCard(
        '今日打卡 · 连续达标',
        `${st.todayCount} / ${st.dailyGoalCount} 次`,
        `早 ${st.morningDone ? '✓' : '○'} · 晚 ${st.eveningDone ? '✓' : '○'} · 连续 ${st.streakDays} 天`,
        st.todayCount >= st.dailyGoalCount ? 'positive' : 'default',
      ),
      kpiCard(
        '刷头寿命',
        `余 ${bh.daysLeft} 天`,
        `已用 ${bh.daysUsed}/${bh.lifespanDays} 天 (${bh.percentLeft}%) · ${bh.usedSessions} 次`,
        bh.needsReplacement ? 'warning' : 'default',
      ),
    );

    renderHeroLiveState(data);

    if (data.pendingPatch?.patch) {
      pendingBox.hidden = false;
      pendingTextEl.textContent = `⏳ 已暂存参数（${summarizePendingPatch(data.pendingPatch.patch)}），下次拿起牙刷亮灯时自动写入生效`;
    } else {
      pendingBox.hidden = true;
      pendingTextEl.textContent = '';
    }

    if (dev) {
      const flags = [
        dev.highFrequency ? '高频已开' : '高频关',
        dev.reminder30s ? '30s提醒开' : '30s提醒关',
        dev.airplaneMode ? '✈️飞行锁定' : '正常解锁',
      ].join(' · ');
      deviceMetaEl.textContent = `${formatLaifenDisplayName(dev.name)} · ${dev.protocol.toUpperCase()} · RSSI ${dev.rssi ?? '--'} dBm · ${flags}`;
    } else {
      deviceMetaEl.textContent = data.config.targetMac
        ? '已绑定设备（尚未采集状态帧）'
        : '尚未绑定设备，可点击「扫描设备」自动绑定';
    }

    if (!draftDirty && !isEditingWithin(panelEl)) {
      applyDeviceControls(dev);
      cfgMacInput.value = data.config.targetMac || '';
      cfgPrefixInput.value = data.config.namePrefix || 'LFTB';
      cfgLifespanInput.value = String(data.config.brushHeadLifespanDays || 90);
      cfgGoalInput.value = String(data.config.dailyGoalCount || 2);
    }

    // Presets
    presetPillsEl.replaceChildren();
    for (const preset of data.presets || []) {
      const btn = button(preset.label, () => {
        selectedMode = preset.mode;
        renderModePills();
        strengthInput.value = String(preset.strength);
        rangeInput.value = String(preset.range);
        speedInput.value = String(preset.speed);
        hfCheck.checked = Boolean(preset.highFrequency);
        draftDirty = true;
        syncSliderReadouts();
        setBanner(`已载入预设「${preset.label}」（Mode ${preset.mode}），可点「⚡ 唤醒并写入牙刷」或「📥 暂存」。`);
      }, 'hub-filter-pill');
      btn.title = preset.description;
      presetPillsEl.append(btn);
    }

    // 7-day strip
    weekStripEl.replaceChildren();
    for (const day of st.last7Days || []) {
      const card = node('div', '', `laifen-day-cell ${day.goalMet ? 'is-goal' : (day.count > 0 ? 'is-partial' : '')}`);
      card.append(
        node('span', day.label, 'meta'),
        node('strong', `${day.count} 次`, 'laifen-day-count'),
        node('span', day.totalDurationSec > 0 ? `${Math.round(day.totalDurationSec / 60)}m` : '—', 'meta'),
      );
      weekStripEl.append(card);
    }

    // Sessions list
    sessionsSubtitleEl.textContent = `共 ${st.totalSessions} 条刷牙记录 · 今日 ${st.todayCount}/${st.dailyGoalCount} 次`;
    if (!data.sessions || data.sessions.length === 0) {
      sessionsListEl.replaceChildren(node('p', '暂无刷牙打卡记录，可启动蓝牙监听或点击手动打卡。', 'empty'));
    } else {
      const listFrag = document.createDocumentFragment();
      for (const s of data.sessions) {
        const row = node('div', '', 'laifen-session-row');
        const left = node('div', '', 'laifen-session-main');
        const titleLine = node('div', '', 'laifen-session-title');
        const isBleSrc = s.source === 'ble_monitor' || s.source === 'ble_auto';
        const srcBadge = node('span', SOURCE_LABELS[s.source] || s.source, `hub-badge ${isBleSrc ? 'badge-green' : 'badge-slate'}`);
        const modeTxt = s.mode ? `Mode ${s.mode}` : '未知档位';
        const paramTxt = s.strength !== null ? ` · 振${s.strength}/幅${s.range ?? '-'}/速${s.speed ?? '-'}` : '';
        titleLine.append(
          srcBadge,
          node('strong', `${s.durationSec} 秒`, ''),
          node('span', `${modeTxt}${paramTxt}`, 'meta'),
        );
        const subText = [
          timestamp(s.brushedAt),
          s.batteryBefore !== null && s.batteryAfter !== null ? `电量 ${s.batteryBefore}%→${s.batteryAfter}%` : '',
          s.overPressureCount > 0 ? `过压 ${s.overPressureCount} 次` : '',
          s.note || '',
        ].filter(Boolean).join(' · ');
        left.append(titleLine, node('div', subText, 'meta'));

        const delBtn = button('删除', async () => {
          if (busy) return;
          busy = true;
          try {
            const res = await callPlugin<LaifenDashboardPayload & { dashboard?: LaifenDashboardPayload }>('session-delete', { id: s.id });
            if (!res.ok) {
              setBanner(res.message || '删除失败', true);
            } else {
              setBanner(res.message || '已删除记录');
              if (res.data?.dashboard) renderDashboard(res.data.dashboard);
              else await refreshDashboard();
            }
          } catch (err) {
            setBanner(errorText(err), true);
          } finally {
            busy = false;
          }
        }, 'mini-button');
        row.append(left, delBtn);
        listFrag.append(row);
      }
      sessionsListEl.replaceChildren(listFrag);
    }
  }

  async function refreshDashboard(): Promise<void> {
    try {
      const res = await callPlugin<LaifenDashboardPayload>('dashboard', { limit: 30 });
      if (res.ok && res.data) {
        renderDashboard(res.data);
      } else if (!res.ok) {
        setBanner(res.message || '读取口腔护理看板失败', true);
      }
    } catch (err) {
      setBanner(errorText(err), true);
    }
  }

  async function runBusyAction(label: string, fn: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    setBanner(label);
    try {
      await fn();
    } catch (err) {
      setBanner(errorText(err), true);
    } finally {
      busy = false;
    }
  }

  function stopBleProgressPolling(): void {
    if (bleProgressTimer) {
      clearInterval(bleProgressTimer);
      bleProgressTimer = undefined;
    }
  }

  async function pollBleProgressOnce(): Promise<void> {
    if (!bleOpInFlight || !active || !options.isVisible()) return;
    try {
      const res = await callPlugin<LaifenDashboardPayload>('dashboard', { limit: 10 });
      if (!bleOpInFlight || !res.ok || !res.data) return;
      renderHeroLiveState(res.data);
      const liveMsg = res.data.liveSession?.message;
      if (liveMsg && ['scanning', 'connecting', 'monitoring'].includes(res.data.liveSession?.phase || '')) {
        setBanner(liveMsg);
      }
    } catch {
      // ignore transient progress poll errors
    }
  }

  async function runBleOpWithProgress(label: string, fn: () => Promise<void>): Promise<void> {
    await runBusyAction(label, async () => {
      bleOpInFlight = true;
      if (latestData) renderHeroLiveState(latestData);
      stopBleProgressPolling();
      bleProgressTimer = setInterval(() => {
        void pollBleProgressOnce();
      }, 900);
      try {
        await fn();
      } finally {
        bleOpInFlight = false;
        stopBleProgressPolling();
      }
    });
  }

  modePillsEl.addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-mode]');
    if (!btn) return;
    const mode = Number(btn.dataset.mode);
    if (mode >= 1 && mode <= 4) {
      selectedMode = mode;
      draftDirty = true;
      renderModePills();
      const slot = latestData?.device?.modes?.[String(mode)];
      if (slot) {
        strengthInput.value = String(slot.strength);
        rangeInput.value = String(slot.range);
        speedInput.value = String(slot.speed);
      }
      if (mode === 4) hfCheck.checked = true;
      syncSliderReadouts();
    }
  });

  for (const inputEl of [strengthInput, rangeInput, speedInput, durationInput]) {
    inputEl.addEventListener('input', () => {
      draftDirty = true;
      syncSliderReadouts();
    });
  }
  for (const checkEl of [hfCheck, reminderCheck, airplaneCheck, deepCleanCheck, antiSplashCheck, rampUpCheck, bristleCheck, wakeCheck, overPressureSelect]) {
    checkEl.addEventListener('change', () => {
      draftDirty = true;
    });
  }

  refreshBtn.addEventListener('click', () => {
    draftDirty = false;
    void refreshDashboard();
  });

  scanBtn.addEventListener('click', () => {
    void runBusyAction('正在扫描周围唤醒中的徕芬牙刷（请拿起或按亮牙刷）…', async () => {
      const res = await callPlugin('scan', { timeoutSec: 5, bind: true }, 25_000);
      setBanner(res.message || (res.ok ? '扫描完成' : '扫描失败'), !res.ok);
      draftDirty = false;
      await refreshDashboard();
    });
  });

  syncBtn.addEventListener('click', () => {
    void runBleOpWithProgress('请拿起或轻按牙刷亮灯，正在等待蓝牙连接同步（25秒窗口）…', async () => {
      const res = await callPlugin('sync', { timeoutSec: 25 }, 60_000);
      setBanner(res.message || (res.ok ? '同步成功' : '同步失败'), !res.ok);
      if (res.ok) draftDirty = false;
      await refreshDashboard();
    });
  });

  applyBtn.addEventListener('click', () => {
    void runBleOpWithProgress('请保持牙刷唤醒亮灯，正在写入并校验参数…', async () => {
      const res = await callPlugin('set', buildSetArgs({ timeoutSec: 25, queueIfAsleep: true }), 60_000);
      setBanner(res.message || (res.ok ? '写入并校验完成' : '写入失败'), !res.ok);
      if (res.ok) draftDirty = false;
      await refreshDashboard();
    });
  });

  monitorStartBtn.addEventListener('click', () => {
    void runBusyAction('正在启动后台刷牙监听会话…', async () => {
      const res = await callPlugin('monitor-start', { timeoutSec: 180 });
      setBanner(res.message || (res.ok ? '已启动监听' : '启动监听失败'), !res.ok);
      await refreshDashboard();
    });
  });

  monitorStopBtn.addEventListener('click', () => {
    // Allow cancelling even while sync/set/power is waiting in runBleOpWithProgress
    monitorStopBtn.disabled = true;
    setBanner('正在停止蓝牙等待…');
    void callPlugin('monitor-stop', {})
      .then(async res => {
        setBanner(res.message || (res.ok ? '已停止等待' : '停止失败'), !res.ok);
        if (!bleOpInFlight) await refreshDashboard();
      })
      .catch(err => {
        setBanner(errorText(err), true);
      })
      .finally(() => {
        monitorStopBtn.disabled = false;
      });
  });

  checkinBtn.addEventListener('click', () => {
    void runBusyAction('正在记录本次刷牙打卡…', async () => {
      const res = await callPlugin('session-add', {
        durationSec: Number(durationInput.value) || 180,
        mode: selectedMode,
        note: '面板手动打卡',
      });
      setBanner(res.message || (res.ok ? '打卡成功' : '打卡失败'), !res.ok);
      await refreshDashboard();
    });
  });

  brushheadResetBtn.addEventListener('click', () => {
    void runBusyAction('正在重置刷头寿命计时…', async () => {
      const res = await callPlugin('brushhead-reset', {});
      setBanner(res.message || (res.ok ? '已重置刷头寿命' : '重置失败'), !res.ok);
      await refreshDashboard();
    });
  });

  cfgSaveBtn.addEventListener('click', () => {
    void runBusyAction('正在保存牙刷配置…', async () => {
      const res = await callPlugin('config', {
        targetMac: cfgMacInput.value.trim(),
        namePrefix: cfgPrefixInput.value.trim() || 'LFTB',
        brushHeadLifespanDays: Number(cfgLifespanInput.value) || 90,
        dailyGoalCount: Number(cfgGoalInput.value) || 2,
      });
      setBanner(res.message || (res.ok ? '配置已保存' : '配置保存失败'), !res.ok);
      if (res.ok) draftDirty = false;
      await refreshDashboard();
    });
  });

  powerOnBtn.addEventListener('click', () => {
    void runBleOpWithProgress('请唤醒牙刷，正在发送电机启动指令…', async () => {
      const res = await callPlugin('power', { on: true, timeoutSec: 25 }, 60_000);
      setBanner(res.message || (res.ok ? '电机已启动' : '控制失败'), !res.ok);
      await refreshDashboard();
    });
  });

  powerOffBtn.addEventListener('click', () => {
    void runBleOpWithProgress('正在发送电机停止指令…', async () => {
      const res = await callPlugin('power', { on: false, timeoutSec: 25 }, 60_000);
      setBanner(res.message || (res.ok ? '电机已停止' : '控制失败'), !res.ok);
      await refreshDashboard();
    });
  });

  calLimpBtn.addEventListener('click', () => {
    void runBleOpWithProgress('正在切换刷头松弛对准模式…', async () => {
      const res = await callPlugin('power', { calibration: 'limp', timeoutSec: 25 }, 60_000);
      setBanner(res.message || (res.ok ? '已进入松弛对准' : '操作失败'), !res.ok);
    });
  });

  calAlignBtn.addEventListener('click', () => {
    void runBleOpWithProgress('正在执行刷头零位校准…', async () => {
      const res = await callPlugin('power', { calibration: 'calibrate', timeoutSec: 25 }, 60_000);
      setBanner(res.message || (res.ok ? '校准完成' : '校准失败'), !res.ok);
    });
  });

  return {
    activate() {
      active = true;
      draftDirty = false;
      void refreshDashboard();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        if (active && options.isVisible() && !busy && !isEditingWithin(panelEl)) {
          void refreshDashboard();
        }
      }, 4000);
    },
    deactivate() {
      active = false;
      stopBleProgressPolling();
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    },
    async refreshBadge() {
      try {
        const res = await callPlugin<LaifenDashboardPayload>('status', {});
        if (res.ok && res.data) updateTopBadge(res.data);
      } catch {
        topBadge.textContent = '—';
      }
    },
  };
}

import { element, isEditingWithin, kpiCard, node } from '../shared/dom.js';
import { errorText, timestamp } from '../shared/format.js';
import { api } from '../state.js';

export interface NinebotUiOptions {
  isVisible: () => boolean;
}

export interface NinebotUiController {
  activate: () => void;
  deactivate: () => void;
  refreshBadge: () => Promise<void>;
}

interface NinebotLocation {
  valid: boolean;
  wgsLat: number | null;
  wgsLon: number | null;
  gcjLat: number | null;
  gcjLon: number | null;
  address: string | null;
  shortAddress: string | null;
  source: string | null;
}

interface NinebotSnapshot {
  sn: string;
  name: string;
  modelName: string;
  backend: 'account' | 'official';
  businessLine: 'motor' | 'ebike' | 'official';
  capturedAt: number;
  battery: number | null;
  auxBattery: number | null;
  voltageV: number | null;
  temperatureC: number | null;
  cycles: number | null;
  charging: boolean;
  chargingPowerW: number | null;
  remainChargeTime: string | null;
  estimateMileageKm: number | null;
  preciseEstimateMileageKm: number | null;
  aiEstimateMileageKm: number | null;
  effectiveRangeKm: number | null;
  odometerKm: number | null;
  powerOn: boolean;
  locked: boolean | null;
  smartServiceExpired: boolean;
  isSharedAccount: boolean;
  location: NinebotLocation;
}

interface NinebotHistoryPoint {
  capturedAt: number;
  battery: number | null;
  auxBattery: number | null;
  voltageV: number | null;
  temperatureC: number | null;
  charging: boolean;
  chargingPowerW: number | null;
  effectiveRangeKm: number | null;
  odometerKm: number | null;
  powerOn: boolean;
  locked: boolean | null;
  address: string | null;
}

interface NinebotTripItem {
  travelId: string;
  startTime: number;
  endTime: number;
  date: string;
  durationSec: number;
  distanceKm: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  usedElectricity: number;
  month: string;
}

interface NinebotTripSummary {
  tripCount: number;
  totalDistanceKm: number;
  totalDurationSec: number;
  totalUsedElectricity: number;
  maxSpeedKmh: number;
  overallAvgSpeedKmh: number;
  todayCount: number;
  todayDistanceKm: number;
  sevenDayCount: number;
  sevenDayDistanceKm: number;
  trips: NinebotTripItem[];
}

interface NinebotVehicleItem {
  sn: string;
  name: string;
  modelName?: string;
  businessLine?: string;
}

interface NinebotActiveAlert {
  key: string;
  lastNotifiedAt: number;
  lastValue: unknown;
}

interface NinebotRedactedConfig {
  backend: 'auto' | 'account' | 'official';
  effectiveBackend: 'account' | 'official';
  preferredLine: 'motor' | 'ebike';
  coordSys: 'wgs84' | 'gcj02';
  defaultSn: string;
  deviceName: string;
  areaCode: string;
  usernameMasked: string;
  hasPassword: boolean;
  hasSession: boolean;
  sessionValid: boolean;
  hasBusinessUid: boolean;
  hasDeviceServiceKey: boolean;
  hasAmapKey: boolean;
  lowBatteryThreshold: number;
  minRangeKm: number;
  idleRemindDays: number;
  alertCooldownHours: number;
  checkUnlocked: boolean;
}

interface NinebotDashboardPayload {
  configured: boolean;
  vehicles?: NinebotVehicleItem[];
  snapshot: NinebotSnapshot | null;
  history: NinebotHistoryPoint[];
  tripSummary: NinebotTripSummary | null;
  activeAlerts: NinebotActiveAlert[];
  config: NinebotRedactedConfig;
}

interface PluginRunResponse<T = unknown> {
  ok: boolean;
  plugin: string;
  action: string;
  notify?: boolean;
  title?: string;
  message?: string;
  data?: T;
}

type TrendMetricKey = 'battery' | 'range';

const ALERT_LABELS: Record<string, string> = {
  low_battery: '电量偏低提醒',
  low_range: '预估续航不足',
  charge_complete: '充电已完成提醒',
  unlocked_warning: '未锁车 / 电门未关告警',
  idle_discharge: '久置低电提醒',
  smart_service_expired: '智能服务费已到期',
};

function formatDurationZh(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0分钟';
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${Math.max(1, mins)}分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}小时${m}分钟` : `${h}小时`;
}

export function initNinebotUi(options: NinebotUiOptions): NinebotUiController {
  const panelEl = element<HTMLElement>('plugin-panel-ninebot');
  const topBadge = element<HTMLElement>('ninebot-top-badge');
  const statusBanner = element<HTMLElement>('ninebot-action-status');
  const vehicleSelect = element<HTMLSelectElement>('ninebot-vehicle-select');
  const syncBtn = element<HTMLButtonElement>('ninebot-sync-btn');
  const patrolBtn = element<HTMLButtonElement>('ninebot-patrol-btn');
  const tripsSyncBtn = element<HTMLButtonElement>('ninebot-trips-sync-btn');
  const refreshBtn = element<HTMLButtonElement>('ninebot-refresh-btn');
  const kpiGrid = element<HTMLElement>('ninebot-kpi-grid');

  const guardBadgeEl = element<HTMLElement>('ninebot-guard-badge');
  const locationTextEl = element<HTMLElement>('ninebot-location-text');
  const updatedMetaEl = element<HTMLElement>('ninebot-updated-meta');
  const alertsBoxEl = element<HTMLElement>('ninebot-alerts-box');

  const trendPillsEl = element<HTMLElement>('ninebot-trend-pills');
  const trendCanvas = element<HTMLCanvasElement>('ninebot-trend-canvas');
  const trendCaptionEl = element<HTMLElement>('ninebot-trend-caption');

  const loginUserInput = element<HTMLInputElement>('ninebot-login-user');
  const loginPassInput = element<HTMLInputElement>('ninebot-login-pass');
  const loginAreaInput = element<HTMLInputElement>('ninebot-login-area');
  const loginStatusHintEl = element<HTMLElement>('ninebot-login-status-hint');
  const loginBtn = element<HTMLButtonElement>('ninebot-login-btn');
  const clearCredsBtn = element<HTMLButtonElement>('ninebot-clear-creds-btn');

  const cfgLineSelect = element<HTMLSelectElement>('ninebot-cfg-line');
  const cfgLowBattInput = element<HTMLInputElement>('ninebot-cfg-low-batt');
  const cfgMinRangeInput = element<HTMLInputElement>('ninebot-cfg-min-range');
  const cfgIdleDaysInput = element<HTMLInputElement>('ninebot-cfg-idle-days');
  const cfgCooldownInput = element<HTMLInputElement>('ninebot-cfg-cooldown');
  const cfgUnlockedCheck = element<HTMLInputElement>('ninebot-cfg-unlocked');
  const cfgAmapInput = element<HTMLInputElement>('ninebot-cfg-amap');
  const cfgDsKeyInput = element<HTMLInputElement>('ninebot-cfg-dskey');
  const cfgSaveBtn = element<HTMLButtonElement>('ninebot-cfg-save-btn');

  const monthInput = element<HTMLInputElement>('ninebot-month-input');
  const tripsSubtitleEl = element<HTMLElement>('ninebot-trips-subtitle');
  const tripsListEl = element<HTMLElement>('ninebot-trips-list');

  let active = false;
  let busy = false;
  let draftDirty = false;
  let trendMetric: TrendMetricKey = 'battery';
  let latestData: NinebotDashboardPayload | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  function setBanner(text: string, isError = false): void {
    statusBanner.textContent = text;
    statusBanner.classList.toggle('is-error', isError);
    statusBanner.hidden = !text;
  }

  async function callPlugin<T = unknown>(
    action: string,
    args: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<PluginRunResponse<T>> {
    return api<PluginRunResponse<T>>('/api/plugin-run', {
      plugin: 'ninebot',
      action,
      args: { silent: true, ...args },
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  }

  function updateTopBadge(data: NinebotDashboardPayload): void {
    const snap = data.snapshot;
    if (!snap || snap.battery === null || snap.battery === undefined) {
      topBadge.textContent = data.configured ? '待同步' : '—';
      return;
    }
    topBadge.textContent = snap.charging ? `⚡${snap.battery}%` : `${snap.battery}%`;
  }

  function renderVehicleSelector(data: NinebotDashboardPayload): void {
    const vehicles = data.vehicles ?? [];
    const curSn = data.config.defaultSn || data.snapshot?.sn || '';
    const optionsList: Array<{ sn: string; label: string }> = [];
    const seen = new Set<string>();

    for (const v of vehicles) {
      if (!v?.sn || seen.has(v.sn)) continue;
      seen.add(v.sn);
      const tag = v.businessLine === 'motor' ? '电摩' : v.businessLine === 'ebike' ? '电自' : '官方';
      optionsList.push({ sn: v.sn, label: `${v.name || v.sn} (${v.sn}) · ${tag}` });
    }
    if (curSn && !seen.has(curSn)) {
      optionsList.unshift({
        sn: curSn,
        label: `${data.config.deviceName || data.snapshot?.name || curSn} (${curSn})`,
      });
    }

    vehicleSelect.replaceChildren();
    if (!optionsList.length) {
      const opt = node('option', '未绑定车辆');
      opt.value = '';
      vehicleSelect.append(opt);
      vehicleSelect.disabled = true;
      return;
    }

    for (const item of optionsList) {
      const opt = node('option', item.label);
      opt.value = item.sn;
      opt.selected = item.sn === curSn;
      vehicleSelect.append(opt);
    }
    vehicleSelect.disabled = false;
  }

  function renderKpis(data: NinebotDashboardPayload): void {
    const snap = data.snapshot;
    const cfg = data.config;
    if (!snap) {
      kpiGrid.replaceChildren(
        kpiCard('主电池电量', '—', data.configured ? '点击「实时同步车况」拉取' : '请先在下方登录九号子账号'),
        kpiCard('72V BMS 遥测', '—', '电压与温度待采集'),
        kpiCard('预估精准续航', '—', '总里程待采集'),
        kpiCard('充电与锁车安防', '未同步', `低电量阈值 ${cfg.lowBatteryThreshold}%`),
      );
      return;
    }

    const battText = snap.battery !== null ? `${snap.battery}%` : '—';
    const battTone: 'default' | 'accent' | 'positive' | 'warning' =
      snap.battery !== null && snap.battery <= cfg.lowBatteryThreshold && !snap.charging
        ? 'warning'
        : snap.charging || (snap.battery !== null && snap.battery >= 50)
          ? 'positive'
          : 'default';
    const battSub = [
      snap.auxBattery !== null ? `通信备电 ${snap.auxBattery}%` : '',
      snap.businessLine === 'motor' ? 'steeldust 电摩网关' : snap.businessLine === 'ebike' ? 'ebike 网关' : '官方 DeviceService',
    ].filter(Boolean).join(' · ');

    const voltText = snap.voltageV !== null ? `${snap.voltageV} V` : '—';
    const bmsSub = [
      snap.temperatureC !== null ? `温度 ${snap.temperatureC} ℃` : '温度 —',
      snap.cycles !== null ? `循环 ${snap.cycles} 次` : '',
    ].filter(Boolean).join(' · ');

    const rangeText = snap.effectiveRangeKm !== null ? `${snap.effectiveRangeKm} km` : '—';
    const rangeSub = snap.odometerKm !== null ? `总里程 ${snap.odometerKm} km` : '总里程 —';

    const secValue = snap.charging
      ? `⚡ 充电中${snap.chargingPowerW ? ` (${snap.chargingPowerW}W)` : ''}`
      : snap.locked === true
        ? '🔒 已上锁'
        : snap.locked === false
          ? '🔓 未锁车'
          : '待机中';
    const secTone: 'default' | 'accent' | 'positive' | 'warning' =
      !snap.charging && (snap.powerOn || snap.locked === false)
        ? 'warning'
        : snap.charging || snap.locked === true
          ? 'positive'
          : 'default';
    const secSub = snap.charging
      ? (snap.remainChargeTime ? `预计剩余 ${snap.remainChargeTime}` : '正在补能中')
      : (snap.powerOn ? '电门处于开启状态' : '车辆已关机');

    kpiGrid.replaceChildren(
      kpiCard('主电池电量', battText, battSub, battTone),
      kpiCard('72V BMS 遥测', voltText, bmsSub, 'accent'),
      kpiCard('预估精准续航', rangeText, rangeSub, 'default'),
      kpiCard('充电与锁车安防', secValue, secSub, secTone),
    );
  }

  function renderGuardAndLocation(data: NinebotDashboardPayload): void {
    const snap = data.snapshot;
    const alerts = data.activeAlerts ?? [];

    if (!snap) {
      guardBadgeEl.textContent = data.configured ? '待同步' : '未绑定';
      guardBadgeEl.className = 'hub-badge badge-slate';
      locationTextEl.textContent = data.configured
        ? '已配置凭据，点击右上角「🔄 实时同步车况」获取最新位置与状态。'
        : '尚未绑定九号账号，请展开下方「九号账号登录绑定」配置子账号。';
      updatedMetaEl.textContent = '';
      alertsBoxEl.replaceChildren(node('p', '暂无守护巡检记录。', 'meta'));
      return;
    }

    const hasRisk = alerts.length > 0 || (!snap.charging && (snap.powerOn || snap.locked === false)) || snap.smartServiceExpired;
    guardBadgeEl.textContent = hasRisk ? `异常关注 (${alerts.length || 1})` : snap.charging ? '充电守护中' : '停放正常';
    guardBadgeEl.className = `hub-badge ${hasRisk ? 'badge-red' : snap.charging ? 'badge-amber' : 'badge-green'}`;

    if (snap.location?.address) {
      locationTextEl.textContent = `📍 ${snap.location.address}`;
    } else if (snap.location?.valid && snap.location.gcjLat !== null && snap.location.gcjLon !== null) {
      locationTextEl.textContent = `📍 GCJ-02 坐标：${snap.location.gcjLat}, ${snap.location.gcjLon}（配置高德 Key 可自动解析街道地址）`;
    } else {
      locationTextEl.textContent = '📍 暂无有效 GPS 定位';
    }

    const shareTag = snap.isSharedAccount ? '家庭只读子账号' : '车主账号';
    updatedMetaEl.textContent = `${snap.name || snap.sn} (${snap.sn}) · ${shareTag} · 最近采集 ${timestamp(snap.capturedAt)}`;

    if (!alerts.length) {
      alertsBoxEl.replaceChildren(node('div', '✅ 当前无激活告警，电量与停车安防正常。', 'ninebot-alert-item is-ok'));
      return;
    }

    const frag = document.createDocumentFragment();
    for (const a of alerts) {
      const label = ALERT_LABELS[a.key] || a.key;
      const valHint = a.lastValue !== null && a.lastValue !== undefined && String(a.lastValue) !== ''
        ? `（触发值：${String(a.lastValue)}）`
        : '';
      const timeHint = a.lastNotifiedAt > 0 ? ` · ${timestamp(a.lastNotifiedAt)}` : '';
      frag.append(node('div', `⚠️ ${label}${valHint}${timeHint}`, 'ninebot-alert-item is-warn'));
    }
    alertsBoxEl.replaceChildren(frag);
  }

  function renderTrendPills(): void {
    for (const btn of trendPillsEl.querySelectorAll<HTMLButtonElement>('button[data-metric]')) {
      btn.classList.toggle('active', btn.dataset.metric === trendMetric);
    }
  }

  function renderTrendChart(data: NinebotDashboardPayload): void {
    renderTrendPills();
    const ctx = trendCanvas.getContext('2d');
    if (!ctx) return;

    const rect = trendCanvas.getBoundingClientRect();
    const cssW = Math.max(300, Math.round(rect.width || trendCanvas.width || 520));
    const cssH = Math.max(140, Math.round(rect.height || trendCanvas.height || 156));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (trendCanvas.width !== cssW * dpr || trendCanvas.height !== cssH * dpr) {
      trendCanvas.width = cssW * dpr;
      trendCanvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const chronological = (data.history ?? []).slice().reverse();
    const points = chronological
      .map(item => ({
        val: trendMetric === 'battery' ? item.battery : item.effectiveRangeKm,
        ts: item.capturedAt,
      }))
      .filter((pt): pt is { val: number; ts: number } => pt.val !== null && pt.val !== undefined && Number.isFinite(pt.val));

    const unit = trendMetric === 'battery' ? '%' : ' km';
    const label = trendMetric === 'battery' ? '主电池电量' : '预估续航';

    if (points.length === 0) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12.5px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`暂无「${label}」历史快照，点击「实时同步车况」开始记录`, cssW / 2, cssH / 2);
      trendCaptionEl.textContent = `暂无「${label}」走势点。`;
      return;
    }

    const isIndustrial = document.documentElement.dataset.theme === 'industrial';
    const strokeColor = trendMetric === 'battery'
      ? (isIndustrial ? '#22c55e' : '#10b981')
      : (isIndustrial ? '#ff6b1a' : '#38bdf8');
    const fillRgb = trendMetric === 'battery'
      ? '16, 185, 129'
      : (isIndustrial ? '255, 107, 26' : '56, 189, 248');

    const vals = points.map(p => p.val);
    const minRaw = Math.min(...vals);
    const maxRaw = Math.max(...vals);
    const minV = trendMetric === 'battery' ? Math.max(0, Math.min(minRaw - 8, 90)) : Math.max(0, minRaw - 8);
    const maxV = trendMetric === 'battery' ? 100 : Math.max(maxRaw + 8, minV + 10);
    const span = Math.max(1, maxV - minV);

    const padL = 42;
    const padR = 16;
    const padT = 16;
    const padB = 24;
    const plotW = Math.max(60, cssW - padL - padR);
    const plotH = Math.max(50, cssH - padT - padB);

    const xOf = (idx: number) => (points.length === 1 ? padL + plotW / 2 : padL + (idx / (points.length - 1)) * plotW);
    const yOf = (val: number) => padT + plotH * (1 - (val - minV) / span);

    ctx.lineWidth = 1;
    ctx.font = '10.5px monospace';
    ctx.textAlign = 'right';
    const steps = 3;
    for (let i = 0; i <= steps; i++) {
      const v = minV + (span * (steps - i)) / steps;
      const y = padT + (plotH * i) / steps;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(cssW - padR, y);
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.fillText(`${Math.round(v)}${trendMetric === 'battery' ? '%' : ''}`, padL - 6, y + 3.5);
    }

    if (points.length > 1) {
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, `rgba(${fillRgb}, 0.28)`);
      grad.addColorStop(1, `rgba(${fillRgb}, 0.02)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(xOf(0), padT + plotH);
      for (let i = 0; i < points.length; i++) {
        ctx.lineTo(xOf(i), yOf(points[i]!.val));
      }
      ctx.lineTo(xOf(points.length - 1), padT + plotH);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      for (let i = 0; i < points.length; i++) {
        const px = xOf(i);
        const py = yOf(points[i]!.val);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    for (let i = 0; i < points.length; i++) {
      const px = xOf(i);
      const py = yOf(points[i]!.val);
      const isLast = i === points.length - 1;
      ctx.beginPath();
      ctx.arc(px, py, isLast ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = strokeColor;
      ctx.fill();
    }

    const latest = points[points.length - 1]!;
    const first = points[0]!;
    trendCaptionEl.textContent = `共 ${points.length} 个快照点 · 最新 ${latest.val}${unit}（范围 ${minRaw}${unit} ~ ${maxRaw}${unit}，起始 ${timestamp(first.ts)}）`;
  }

  function renderFormsFromConfig(cfg: NinebotRedactedConfig): void {
    const credStatus = cfg.hasSession
      ? (cfg.sessionValid
          ? `✅ 已登录账号 ${cfg.usernameMasked || '（已保存）'} · 会话有效`
          : `⚠️ 账号 ${cfg.usernameMasked || ''} 会话已过期，下次同步将自动续期`)
      : cfg.hasDeviceServiceKey
        ? '✅ 已配置官方 DeviceService Key'
        : '尚未绑定九号账号，建议先在 App 建立「用车人/家庭只读子账号」并设置登录密码。';
    loginStatusHintEl.textContent = credStatus;

    if (draftDirty || isEditingWithin(panelEl)) {
      return;
    }

    if (cfg.areaCode) loginAreaInput.value = cfg.areaCode;
    cfgLineSelect.value = cfg.preferredLine;
    cfgLowBattInput.value = String(cfg.lowBatteryThreshold);
    cfgMinRangeInput.value = String(cfg.minRangeKm);
    cfgIdleDaysInput.value = String(cfg.idleRemindDays);
    cfgCooldownInput.value = String(cfg.alertCooldownHours);
    cfgUnlockedCheck.checked = Boolean(cfg.checkUnlocked);
    cfgAmapInput.placeholder = cfg.hasAmapKey ? '已配置高德 Key（留空保持不变）' : '可选：输入高德 Web 服务 Key';
    cfgDsKeyInput.placeholder = cfg.hasDeviceServiceKey ? '已配置官方 Key（留空保持不变）' : '可选：输入 NINEBOT_DEVICESERVICE_KEY';
  }

  function renderTrips(data: NinebotDashboardPayload): void {
    const summary = data.tripSummary;
    if (!summary || !summary.trips.length) {
      tripsSubtitleEl.textContent = '暂无本地骑行行程缓存（点击「🛣️ 同步本月行程」拉取）。';
      tripsListEl.replaceChildren(node('p', '暂无骑行记录。', 'empty'));
      return;
    }

    tripsSubtitleEl.textContent =
      `累计 ${summary.tripCount} 次 · ${summary.totalDistanceKm} km（今日 ${summary.todayCount} 次 ${summary.todayDistanceKm} km · 近 7 日 ${summary.sevenDayDistanceKm} km）· 极速 ${summary.maxSpeedKmh} km/h · 均速 ${summary.overallAvgSpeedKmh} km/h`;

    const frag = document.createDocumentFragment();
    for (const t of summary.trips) {
      const row = node('div', '', 'ninebot-trip-row');
      const left = node('div', '', 'ninebot-trip-main');
      const head = node('div', '', 'ninebot-trip-title');
      head.append(
        node('span', t.date || t.month || '--', 'hub-badge badge-slate'),
        node('strong', `${t.distanceKm} km`, ''),
        node('span', `极速 ${t.maxSpeedKmh} km/h`, 'hub-badge badge-amber'),
        node('span', `均速 ${t.avgSpeedKmh} km/h`, 'hub-badge badge-teal'),
      );
      const subParts = [
        `耗时 ${formatDurationZh(t.durationSec)}`,
        t.usedElectricity > 0 ? `耗电 ${t.usedElectricity}%` : '',
        t.endTime > 0 ? timestamp(t.endTime * 1000) : '',
      ].filter(Boolean);
      left.append(head, node('div', subParts.join(' · '), 'meta'));
      row.append(left);
      frag.append(row);
    }
    tripsListEl.replaceChildren(frag);
  }

  function renderDashboard(data: NinebotDashboardPayload): void {
    latestData = data;
    updateTopBadge(data);
    renderVehicleSelector(data);
    renderKpis(data);
    renderGuardAndLocation(data);
    renderTrendChart(data);
    renderFormsFromConfig(data.config);
    renderTrips(data);
  }

  async function refreshDashboard(): Promise<void> {
    try {
      const res = await callPlugin<NinebotDashboardPayload>('dashboard', { limit: 30 });
      if (res.ok && res.data) {
        renderDashboard(res.data);
      } else if (!res.ok) {
        setBanner(res.message || '读取九号电摩看板失败', true);
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

  vehicleSelect.addEventListener('change', () => {
    const selectSn = vehicleSelect.value.trim();
    if (!selectSn) return;
    void runBusyAction(`正在切换默认车辆至 ${selectSn}…`, async () => {
      const res = await callPlugin('vehicles', { selectSn }, 20_000);
      setBanner(res.message || (res.ok ? '已切换车辆' : '切换失败'), !res.ok);
      await refreshDashboard();
    });
  });

  syncBtn.addEventListener('click', () => {
    void runBusyAction('正在连接九号云端同步实时车况与本月行程…', async () => {
      const res = await callPlugin('status', {}, 30_000);
      if (res.ok) {
        await callPlugin('trips', { limit: 20 }, 30_000).catch(() => undefined);
      }
      setBanner(res.message || (res.ok ? '同步成功' : '同步失败'), !res.ok);
      await refreshDashboard();
    });
  });

  patrolBtn.addEventListener('click', () => {
    void runBusyAction('正在执行电摩安全与补能巡检…', async () => {
      const res = await callPlugin('patrol', { force: true }, 30_000);
      setBanner(res.message || (res.ok ? '巡检完成' : '巡检失败'), !res.ok);
      await refreshDashboard();
    });
  });

  tripsSyncBtn.addEventListener('click', () => {
    void runBusyAction('正在同步九号骑行轨迹与极速统计…', async () => {
      const month = monthInput.value.trim();
      const args: Record<string, unknown> = { limit: 20 };
      if (month) args.month = month;
      const res = await callPlugin('trips', args, 30_000);
      setBanner(res.message || (res.ok ? '行程同步完成' : '行程同步失败'), !res.ok);
      await refreshDashboard();
    });
  });

  refreshBtn.addEventListener('click', () => {
    draftDirty = false;
    void refreshDashboard();
  });

  trendPillsEl.addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-metric]');
    if (!btn) return;
    const metric = btn.dataset.metric === 'range' ? 'range' : 'battery';
    trendMetric = metric;
    if (latestData) renderTrendChart(latestData);
  });

  for (const inputEl of [
    loginUserInput,
    loginPassInput,
    loginAreaInput,
    cfgLineSelect,
    cfgLowBattInput,
    cfgMinRangeInput,
    cfgIdleDaysInput,
    cfgCooldownInput,
    cfgUnlockedCheck,
    cfgAmapInput,
    cfgDsKeyInput,
  ]) {
    inputEl.addEventListener('input', () => { draftDirty = true; });
    inputEl.addEventListener('change', () => { draftDirty = true; });
  }

  loginBtn.addEventListener('click', () => {
    const username = loginUserInput.value.trim();
    const password = loginPassInput.value;
    const areaCode = loginAreaInput.value.trim() || '86';
    if (!username || !password) {
      setBanner('请输入九号子账号手机号与登录密码。', true);
      return;
    }
    void runBusyAction('正在登录九号账号并自动发现绑定车辆…', async () => {
      const res = await callPlugin('login', { username, password, areaCode }, 30_000);
      setBanner(res.message || (res.ok ? '登录成功' : '登录失败'), !res.ok);
      if (res.ok) {
        loginPassInput.value = '';
        draftDirty = false;
        await callPlugin('status', {}, 30_000).catch(() => undefined);
        await callPlugin('trips', { limit: 20 }, 30_000).catch(() => undefined);
      }
      await refreshDashboard();
    });
  });

  clearCredsBtn.addEventListener('click', () => {
    void runBusyAction('正在清除已保存的账号密码与会话…', async () => {
      const res = await callPlugin('config', { clearCredentials: true });
      setBanner(res.message || (res.ok ? '已清除凭据' : '清除失败'), !res.ok);
      loginPassInput.value = '';
      draftDirty = false;
      await refreshDashboard();
    });
  });

  cfgSaveBtn.addEventListener('click', () => {
    void runBusyAction('正在保存九号守护阈值与地图配置…', async () => {
      const args: Record<string, unknown> = {
        preferredLine: cfgLineSelect.value === 'ebike' ? 'ebike' : 'motor',
        lowBatteryThreshold: Number(cfgLowBattInput.value) || 30,
        minRangeKm: Number(cfgMinRangeInput.value) || 0,
        idleRemindDays: Number(cfgIdleDaysInput.value) || 0,
        alertCooldownHours: Number(cfgCooldownInput.value) || 12,
        checkUnlocked: cfgUnlockedCheck.checked,
      };
      const amap = cfgAmapInput.value.trim();
      const dsKey = cfgDsKeyInput.value.trim();
      if (amap) args.amapKey = amap;
      if (dsKey) args.deviceServiceKey = dsKey;
      const res = await callPlugin('config', args);
      setBanner(res.message || (res.ok ? '配置已保存' : '保存失败'), !res.ok);
      if (res.ok) {
        cfgAmapInput.value = '';
        cfgDsKeyInput.value = '';
        draftDirty = false;
      }
      await refreshDashboard();
    });
  });

  return {
    activate() {
      active = true;
      draftDirty = false;
      void refreshDashboard();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        if (active && options.isVisible() && !busy && !draftDirty && !isEditingWithin(panelEl)) {
          void refreshDashboard();
        }
      }, 15_000);
    },
    deactivate() {
      active = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    },
    async refreshBadge() {
      try {
        const res = await callPlugin<NinebotDashboardPayload>('dashboard', { limit: 1 });
        if (res.ok && res.data) updateTopBadge(res.data);
      } catch {
        // Ignore badge refresh error
      }
    },
  };
}

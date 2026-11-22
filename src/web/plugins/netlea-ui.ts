import { button, element, isEditingWithin, kpiCard, node } from '../shared/dom.js';
import { errorText, timestamp } from '../shared/format.js';
import {
  announceStatus,
  attachDelayedFormValidation,
  bindRovingTablist,
  confirmAction,
  safeFocus,
  syncRovingTablist,
} from '../shared/ui-primitives.js';
import { api, appState, type ApiRequestOptions } from '../state.js';

export interface NetleaUiOptions {
  isVisible: () => boolean;
}

export interface NetleaUiController {
  activate: () => void;
  deactivate: () => void;
  refreshBadge: () => Promise<void>;
  dispose: () => void;
}

interface NetleaChannels {
  red: number;
  green: number;
  white: number;
  blue: number;
  fan: number;
}

interface NetleaSceneMatch {
  modeCode: number;
  model: number;
  seriesName: string;
  tab: number;
  name: string;
  gear: number;
  powerWatts: number;
}

interface NetleaDeviceView {
  address: string;
  name: string;
  rssi: number | null;
  connected: boolean;
  seenAt?: number;
  advertisement?: {
    rtc: string;
    deviceType: number;
    mac: string;
  };
}

interface NetleaState {
  rawHex: string;
  on: boolean;
  haveTravel?: boolean;
  scheduleRunning?: boolean;
  runMode?: string;
  runModeLabel?: string;
  channels: NetleaChannels;
  powerWatts?: number;
  maxWatts?: number;
  matchedScene?: NetleaSceneMatch | null;
}

interface NetleaTrip {
  enable: number;
  dayList: number[];
  startH: number;
  startM: number;
  endH: number;
  endM: number;
  modeCode: number;
  gear: number;
  red: number;
  green: number;
  white: number;
  blue: number;
  fan: number;
  powerWatts?: number;
  name?: string;
  seriesName?: string;
  hasSunrise?: boolean;
  hasSunset?: boolean;
  sunriseDays?: number[];
  sunsetDays?: number[];
}

interface NetleaSchedule {
  rawHex?: string;
  travelModel: number;
  sunEnable?: number;
  sunriseMinutes: number;
  sunsetMinutes: number;
  trips: NetleaTrip[];
  presetId?: string;
  presetName?: string;
  targetBaseWatts?: number;
}

interface NetleaTempConfig {
  onMinutes: number;
  offMinutes: number;
  channels: NetleaChannels;
  powerWatts: number;
  modeCode: number;
  gear: number;
}

interface NetleaSavedPreset extends NetleaChannels {
  name: string;
}

interface NetleaConfig {
  targetMac: string;
  namePrefix: string;
  fadeSeconds: number;
  tempOnMinutes: number;
  tempOffMinutes: number;
  tankSize: {
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    lampCount?: number;
  };
  defaultChannels: NetleaChannels;
  savedCustomPresets: NetleaSavedPreset[];
}

interface NetleaCatalogScene {
  modeCode: number;
  model: number;
  seriesName: string;
  tab: number;
  name: string;
  maxGear: number;
  gears: Array<{
    gear: number;
    powerWatts: number;
    channels: NetleaChannels;
  }>;
}

interface NetleaCatalog {
  modelKey: string;
  maxWatts: number;
  scenes: NetleaCatalogScene[];
  cultivationPresets: Array<{
    id: string;
    type: number;
    name: string;
    totalHours: number;
  }>;
}

interface NetleaDashboardPayload {
  updatedAt: number | null;
  lastAddress: string | null;
  device: NetleaDeviceView | null;
  state: NetleaState | null;
  tempConfig?: NetleaTempConfig | null;
  schedule?: NetleaSchedule | null;
  activeTrip?: NetleaTrip | null;
  config: NetleaConfig;
  catalog?: NetleaCatalog;
}

interface NetleaPluginResponse<T = unknown> {
  ok: boolean;
  plugin: string;
  action: string;
  notify: boolean;
  title?: string;
  message: string;
  data?: T;
}

const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

function clampInt(raw: number, min: number, max: number): number {
  if (!Number.isFinite(raw)) return min;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

function pad2(n: number): string {
  return String(clampInt(n, 0, 99)).padStart(2, '0');
}

function formatHm(h: number, m: number): string {
  return `${pad2(h)}:${pad2(m)}`;
}

function parseHm(value: string, fallbackH = 9, fallbackM = 0): { h: number; m: number } {
  const parts = value.split(':');
  if (parts.length !== 2) return { h: fallbackH, m: fallbackM };
  return {
    h: clampInt(Number(parts[0]), 0, 23),
    m: clampInt(Number(parts[1]), 0, 59),
  };
}

function formatDaySummary(dayList: number[]): string {
  const days = Array.isArray(dayList) ? dayList : [1, 1, 1, 1, 1, 1, 1];
  const activeCount = days.filter(Boolean).length;
  if (activeCount === 7) return '每天';
  if (activeCount === 0) return '未选星期';
  if (days.slice(0, 5).every(Boolean) && !days[5] && !days[6]) return '工作日';
  if (days.slice(0, 5).every(v => !v) && days[5] && days[6]) return '周末';
  return `周${days.map((v, i) => (v ? DAY_NAMES[i] : '')).filter(Boolean).join('')}`;
}

function mixSpectrumRgb(ch: NetleaChannels): [number, number, number] {
  const r = Math.min(255, Math.round((ch.red / 100) * 245 + (ch.white / 100) * 180));
  const g = Math.min(255, Math.round((ch.green / 100) * 235 + (ch.white / 100) * 185));
  const b = Math.min(255, Math.round((ch.blue / 100) * 245 + (ch.white / 100) * 185));
  return [r, g, b];
}

function prepareHiDpiCanvas(
  canvas: HTMLCanvasElement,
  fallbackW: number,
  fallbackH: number,
): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(280, Math.round(rect.width || canvas.clientWidth || fallbackW));
  const h = Math.max(fallbackH, Math.round(rect.height || canvas.clientHeight || fallbackH));
  const rawDpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
  const dpr = Math.min(rawDpr, 2);
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawSpectrumCanvas(
  canvas: HTMLCanvasElement,
  channels: NetleaChannels,
  labelBadge: string,
): void {
  const prep = prepareHiDpiCanvas(canvas, 560, 176);
  if (!prep) return;
  const { ctx, w, h } = prep;

  const isIndustrial = typeof document !== 'undefined' && document.documentElement?.dataset?.theme === 'industrial';
  const bg = isIndustrial ? '#11161f' : 'rgba(13, 19, 32, 0.92)';
  const trackBg = isIndustrial ? '#1e2633' : 'rgba(255, 255, 255, 0.08)';
  const textCol = '#e6edf3';
  const mutedCol = '#93a4bc';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const [mr, mg, mb] = mixSpectrumRgb(channels);
  ctx.fillStyle = trackBg;
  ctx.fillRect(14, 12, w - 28, 22);
  ctx.fillStyle = `rgb(${mr}, ${mg}, ${mb})`;
  ctx.fillRect(14, 12, w - 28, 22);

  ctx.font = '600 12px sans-serif';
  ctx.fillStyle = (mr + mg + mb) > 420 ? '#111827' : textCol;
  ctx.fillText(labelBadge, 22, 27);

  const rows: Array<{ label: string; value: number; max: number; unit: string; color: string }> = [
    { label: '红光 R', value: channels.red, max: 100, unit: '%', color: '#f87171' },
    { label: '绿光 G', value: channels.green, max: 100, unit: '%', color: '#4ade80' },
    { label: '白光 W', value: channels.white, max: 100, unit: '%', color: '#f8fafc' },
    { label: '蓝光 B', value: channels.blue, max: 100, unit: '%', color: '#60a5fa' },
    { label: '风扇 F', value: channels.fan, max: 5, unit: ' 档', color: '#fbbf24' },
  ];

  const startY = 48;
  const rowStep = 24;
  const barX = 76;
  const barW = Math.max(40, w - barX - 58);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const y = startY + i * rowStep;
    const ratio = Math.max(0, Math.min(1, row.value / row.max));

    ctx.font = '500 12px sans-serif';
    ctx.fillStyle = mutedCol;
    ctx.fillText(row.label, 14, y + 11);

    ctx.fillStyle = trackBg;
    ctx.fillRect(barX, y, barW, 13);

    ctx.fillStyle = row.color;
    ctx.fillRect(barX, y, Math.max(ratio > 0 ? 4 : 0, Math.round(barW * ratio)), 13);

    ctx.fillStyle = textCol;
    ctx.font = '600 12px monospace';
    ctx.fillText(`${row.value}${row.unit}`, barX + barW + 8, y + 11);
  }
}

function drawTimelineCanvas(
  canvas: HTMLCanvasElement,
  trips: NetleaTrip[],
  sunriseMinutes: number,
  sunsetMinutes: number,
  maxWatts: number,
  todayIdx: number,
): void {
  const prep = prepareHiDpiCanvas(canvas, 880, 190);
  if (!prep) return;
  const { ctx, w, h } = prep;

  const isIndustrial = typeof document !== 'undefined' && document.documentElement?.dataset?.theme === 'industrial';
  const bg = isIndustrial ? '#11161f' : 'rgba(13, 19, 32, 0.92)';
  const gridCol = isIndustrial ? 'rgba(255,255,255,0.08)' : 'rgba(148, 163, 184, 0.14)';
  const labelCol = '#94a3b8';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const padL = 42;
  const padR = 16;
  const padT = 18;
  const padB = 28;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const xForMin = (min: number) => padL + (Math.max(0, Math.min(1440, min)) / 1440) * plotW;
  const safeMaxW = Math.max(10, maxWatts);
  const yForWatts = (watts: number) => padT + plotH - (Math.max(0, Math.min(safeMaxW, watts)) / safeMaxW) * plotH;

  // Horizontal wattage lines
  ctx.font = '11px monospace';
  ctx.fillStyle = labelCol;
  ctx.strokeStyle = gridCol;
  ctx.lineWidth = 1;
  for (const frac of [0, 0.5, 1]) {
    const wy = yForWatts(safeMaxW * frac);
    ctx.beginPath();
    ctx.moveTo(padL, wy);
    ctx.lineTo(w - padR, wy);
    ctx.stroke();
    ctx.fillText(`${Math.round(safeMaxW * frac)}W`, 6, wy + 4);
  }

  // Vertical hour ticks (every 3h)
  for (let hr = 0; hr <= 24; hr += 3) {
    const x = xForMin(hr * 60);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.fillText(`${pad2(hr)}:00`, Math.min(w - 38, Math.max(padL - 8, x - 14)), h - 8);
  }

  // Build segments active today (0..1440)
  interface PlotSeg {
    start: number;
    end: number;
    watts: number;
    trip: NetleaTrip;
    hasRise: boolean;
    hasSet: boolean;
  }
  const prevIdx = (todayIdx + 6) % 7;
  const segs: PlotSeg[] = [];
  for (const t of trips) {
    if (!t.enable) continue;
    const days = Array.isArray(t.dayList) ? t.dayList : [1, 1, 1, 1, 1, 1, 1];
    const s = clampInt(t.startH, 0, 23) * 60 + clampInt(t.startM, 0, 59);
    const rawE = clampInt(t.endH, 0, 23) * 60 + clampInt(t.endM, 0, 59);
    const e = rawE === 0 && s > 0 ? 1440 : rawE;
    if (s === e) continue;
    const watts = Math.max(1, Number(t.powerWatts ?? 12));
    if (e > s) {
      if (days[todayIdx]) {
        segs.push({ start: s, end: e, watts, trip: t, hasRise: false, hasSet: false });
      }
    } else {
      if (days[todayIdx]) {
        segs.push({ start: s, end: 1440, watts, trip: t, hasRise: false, hasSet: false });
      }
      if (days[prevIdx] && e > 0) {
        segs.push({ start: 0, end: e, watts, trip: t, hasRise: false, hasSet: false });
      }
    }
  }
  segs.sort((a, b) => a.start - b.start || a.end - b.end);

  const rise = clampInt(sunriseMinutes, 0, 300);
  const set = clampInt(sunsetMinutes, 0, 300);
  for (let i = 0; i < segs.length; i++) {
    const cur = segs[i]!;
    const prev = i > 0 ? segs[i - 1] : null;
    const next = i < segs.length - 1 ? segs[i + 1] : null;
    const dur = cur.end - cur.start;
    let canRise = rise > 0 && (!prev || prev.end < cur.start);
    let canSet = set > 0 && (!next || cur.end < next.start);
    if (canRise && canSet && dur < rise + set) {
      if (dur >= rise) canSet = false;
      else if (dur < set) { canRise = false; canSet = false; }
      else canRise = false;
    } else {
      if (canRise && dur < rise) canRise = false;
      if (canSet && dur < set) canSet = false;
    }
    cur.hasRise = canRise;
    cur.hasSet = canSet;
  }

  if (segs.length === 0) {
    ctx.font = '500 13px sans-serif';
    ctx.fillStyle = labelCol;
    ctx.fillText('今日暂无启用的定时行程（新增时段或选择官方养殖预设即可预览日出/日落曲线）', padL + 24, padT + plotH / 2);
  } else {
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const prev = i > 0 ? segs[i - 1] : null;
      const startWatts = (prev && prev.end === seg.start) ? prev.watts : (seg.hasRise ? 0 : seg.watts);
      const riseLen = seg.hasRise ? Math.min(rise, seg.end - seg.start) : 0;
      const setLen = seg.hasSet ? Math.min(set, seg.end - seg.start - riseLen) : 0;

      const x0 = xForMin(seg.start);
      const x1 = xForMin(seg.start + riseLen);
      const x2 = xForMin(seg.end - setLen);
      const x3 = xForMin(seg.end);

      const y0 = yForWatts(startWatts);
      const yTop = yForWatts(seg.watts);
      const yBase = yForWatts(0);

      const [r, g, b] = mixSpectrumRgb({
        red: seg.trip.red,
        green: seg.trip.green,
        white: seg.trip.white,
        blue: seg.trip.blue,
        fan: seg.trip.fan,
      });

      ctx.beginPath();
      ctx.moveTo(x0, yBase);
      ctx.lineTo(x0, y0);
      if (riseLen > 0) ctx.lineTo(x1, yTop);
      else ctx.lineTo(x0, yTop);
      ctx.lineTo(x2, yTop);
      if (setLen > 0) ctx.lineTo(x3, yBase);
      else ctx.lineTo(x3, yTop);
      ctx.lineTo(x3, yBase);
      ctx.closePath();
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.34)`;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(x0, y0);
      if (riseLen > 0) ctx.lineTo(x1, yTop);
      else ctx.lineTo(x0, yTop);
      ctx.lineTo(x2, yTop);
      if (setLen > 0) ctx.lineTo(x3, yBase);
      else ctx.lineTo(x3, yTop);
      ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.lineWidth = 2.2;
      ctx.stroke();

      if (x3 - x0 > 46) {
        ctx.font = '600 11px sans-serif';
        ctx.fillStyle = '#e2e8f0';
        const tag = `${seg.trip.name || '时段'} ${seg.watts}W`;
        ctx.fillText(tag, Math.min(x3 - 44, (x0 + x3) / 2 - 24), Math.max(padT + 14, yTop - 6));
      }
    }
  }

  // Current wall-clock needle
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nowX = xForMin(nowMin);
  ctx.beginPath();
  ctx.moveTo(nowX, padT);
  ctx.lineTo(nowX, padT + plotH);
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.font = '600 11px monospace';
  ctx.fillStyle = '#fbbf24';
  ctx.fillText(`现在 ${formatHm(now.getHours(), now.getMinutes())}`, Math.min(w - 76, Math.max(padL + 2, nowX + 4)), padT + 12);
}

function formatNetleaDisplayName(raw?: string | null): string {
  const s = (raw || '').trim();
  return s && /[\u4e00-\u9fff]/.test(s) ? s : '尼特利鱼缸灯';
}

function listenEvent(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) return;
  target.addEventListener(type, handler, signal ? { signal } : undefined);
  if (signal) {
    signal.addEventListener('abort', () => {
      target.removeEventListener(type, handler);
    }, { once: true });
  }
}

function bindFormSubmission(
  form: HTMLFormElement,
  submitBtn: HTMLButtonElement,
  onSubmit: () => void,
  signal?: AbortSignal,
): void {
  attachDelayedFormValidation(form, signal);
  listenEvent(form, 'submit', e => {
    e.preventDefault();
    onSubmit();
  }, signal);
  listenEvent(submitBtn, 'click', e => {
    if (typeof form.requestSubmit !== 'function') {
      e.preventDefault();
      onSubmit();
    }
  }, signal);
}

export function initNetleaUi(options: NetleaUiOptions): NetleaUiController {
  const panel = element<HTMLElement>('plugin-panel-netlea');
  const topBadge = element<HTMLElement>('netlea-top-badge');
  const statusBanner = element<HTMLElement>('netlea-action-status');
  const kpiGrid = element<HTMLElement>('netlea-kpi-grid');
  const modelPill = element<HTMLElement>('netlea-model-pill');

  // Top & quick bar
  const clockBtn = element<HTMLButtonElement>('netlea-clock-btn');
  const scanBtn = element<HTMLButtonElement>('netlea-scan-btn');
  const syncBtn = element<HTMLButtonElement>('netlea-sync-btn');
  const refreshBtn = element<HTMLButtonElement>('netlea-refresh-btn');
  const onBtn = element<HTMLButtonElement>('netlea-on-btn');
  const offBtn = element<HTMLButtonElement>('netlea-off-btn');
  const resumeBtn = element<HTMLButtonElement>('netlea-resume-btn');
  const tempMinInput = element<HTMLInputElement>('netlea-temp-min');
  const brightnessRange = element<HTMLInputElement>('netlea-brightness-range');
  const brightnessVal = element<HTMLElement>('netlea-brightness-val');
  const brightnessBtn = element<HTMLButtonElement>('netlea-brightness-btn');

  // Workspace view switcher
  const workspaceTabs = element<HTMLElement>('netlea-workspace-tabs');
  const viewSchedule = element<HTMLElement>('netlea-view-schedule');
  const viewPreset = element<HTMLElement>('netlea-view-preset');
  const viewManual = element<HTMLElement>('netlea-view-manual');

  // View 1: Schedule & Sunrise/Sunset
  const schedBadge = element<HTMLElement>('netlea-sched-badge');
  const timelineCanvas = element<HTMLCanvasElement>('netlea-timeline-canvas');
  const timelineCaption = element<HTMLElement>('netlea-timeline-caption');
  const sunriseInput = element<HTMLInputElement>('netlea-sunrise-min');
  const sunsetInput = element<HTMLInputElement>('netlea-sunset-min');
  const sunPills = element<HTMLElement>('netlea-sun-pills');
  const schedDirtyLabel = element<HTMLElement>('netlea-sched-dirty');
  const schedReadBtn = element<HTMLButtonElement>('netlea-sched-read-btn');
  const tripNewBtn = element<HTMLButtonElement>('netlea-trip-new-btn');
  const schedClearBtn = element<HTMLButtonElement>('netlea-sched-clear-btn');
  const schedSaveBtn = element<HTMLButtonElement>('netlea-sched-save-btn');
  const tripListEl = element<HTMLElement>('netlea-trip-list');

  // Trip Editor
  const tripEditor = element<HTMLFormElement>('netlea-trip-editor');
  const tripEditorTitle = element<HTMLElement>('netlea-trip-editor-title');
  const tripEnabledInput = element<HTMLInputElement>('netlea-trip-enabled');
  const tripStartInput = element<HTMLInputElement>('netlea-trip-start');
  const tripEndInput = element<HTMLInputElement>('netlea-trip-end');
  const tripDaysEl = element<HTMLElement>('netlea-trip-days');
  const tripDayQuickEl = element<HTMLElement>('netlea-day-quick');
  const tripSpecModeEl = element<HTMLElement>('netlea-trip-spec-mode');
  const tripSceneBox = element<HTMLElement>('netlea-trip-scene-box');
  const tripCustomBox = element<HTMLElement>('netlea-trip-custom-box');
  const tripSceneSelect = element<HTMLSelectElement>('netlea-trip-scene');
  const tripGearInput = element<HTMLInputElement>('netlea-trip-gear');
  const tripGearVal = element<HTMLElement>('netlea-trip-gear-val');
  const tripWattsSpan = element<HTMLElement>('netlea-trip-watts');
  const tripR = element<HTMLInputElement>('netlea-trip-r');
  const tripG = element<HTMLInputElement>('netlea-trip-g');
  const tripW = element<HTMLInputElement>('netlea-trip-w');
  const tripB = element<HTMLInputElement>('netlea-trip-b');
  const tripRVal = element<HTMLElement>('netlea-trip-r-val');
  const tripGVal = element<HTMLElement>('netlea-trip-g-val');
  const tripWVal = element<HTMLElement>('netlea-trip-w-val');
  const tripBVal = element<HTMLElement>('netlea-trip-b-val');
  const tripCustomWatts = element<HTMLElement>('netlea-trip-custom-watts');
  const tripCancelBtn = element<HTMLButtonElement>('netlea-trip-cancel-btn');
  const tripApplyBtn = element<HTMLButtonElement>('netlea-trip-apply-btn');

  // View 2: Official Cultivation Presets
  const presetForm = element<HTMLFormElement>('netlea-preset-form');
  const cultivationPills = element<HTMLElement>('netlea-cultivation-pills');
  const tankLInput = element<HTMLInputElement>('netlea-tank-l');
  const tankWInput = element<HTMLInputElement>('netlea-tank-w');
  const tankHInput = element<HTMLInputElement>('netlea-tank-h');
  const presetStartInput = element<HTMLInputElement>('netlea-preset-start');
  const presetFadeInput = element<HTMLInputElement>('netlea-preset-fade');
  const presetMeta = element<HTMLElement>('netlea-preset-meta');
  const presetPreviewEl = element<HTMLElement>('netlea-preset-preview');
  const presetImportBtn = element<HTMLButtonElement>('netlea-preset-import-btn');
  const presetApplyBtn = element<HTMLButtonElement>('netlea-preset-apply-btn');

  // View 3: Manual & 12-Scene Spectrum Workbench + Config
  const powerBadge = element<HTMLElement>('netlea-power-badge');
  const sceneSeriesTabs = element<HTMLElement>('netlea-scene-series-tabs');
  const sceneSelectorBox = element<HTMLElement>('netlea-scene-selector-box');
  const sceneSubpills = element<HTMLElement>('netlea-scene-subpills');
  const sceneGearInput = element<HTMLInputElement>('netlea-scene-gear');
  const sceneGearVal = element<HTMLElement>('netlea-scene-gear-val');
  const sceneWattsSpan = element<HTMLElement>('netlea-scene-watts');
  const customSlidersBox = element<HTMLElement>('netlea-custom-sliders-box');
  const powerClampNote = element<HTMLElement>('netlea-power-clamp-note');
  const customSlotsEl = element<HTMLElement>('netlea-custom-slots');
  const saveSlotBtn = element<HTMLButtonElement>('netlea-save-slot-btn');
  const applyTempBtn = element<HTMLButtonElement>('netlea-apply-channels-btn');
  const applyManualBtn = element<HTMLButtonElement>('netlea-apply-manual-btn');
  const manualOffBtn = element<HTMLButtonElement>('netlea-manual-off-btn');
  const saveDefaultBtn = element<HTMLButtonElement>('netlea-save-default-btn');
  const spectrumCanvas = element<HTMLCanvasElement>('netlea-spectrum-canvas');
  const deviceMeta = element<HTMLElement>('netlea-device-meta');

  const chRed = element<HTMLInputElement>('netlea-ch-red');
  const chGreen = element<HTMLInputElement>('netlea-ch-green');
  const chWhite = element<HTMLInputElement>('netlea-ch-white');
  const chBlue = element<HTMLInputElement>('netlea-ch-blue');
  const chFan = element<HTMLInputElement>('netlea-ch-fan');
  const chRedVal = element<HTMLElement>('netlea-ch-red-val');
  const chGreenVal = element<HTMLElement>('netlea-ch-green-val');
  const chWhiteVal = element<HTMLElement>('netlea-ch-white-val');
  const chBlueVal = element<HTMLElement>('netlea-ch-blue-val');
  const chFanVal = element<HTMLElement>('netlea-ch-fan-val');

  const cfgTempForm = element<HTMLFormElement>('netlea-cfg-temp-form');
  const cfgOnMinInput = element<HTMLInputElement>('netlea-cfg-on-min');
  const cfgOffMinInput = element<HTMLInputElement>('netlea-cfg-off-min');
  const cfgTempSaveBtn = element<HTMLButtonElement>('netlea-cfg-temp-save-btn');
  const cfgForm = element<HTMLFormElement>('netlea-cfg-form');
  const cfgMacInput = element<HTMLInputElement>('netlea-cfg-mac');
  const cfgPrefixInput = element<HTMLInputElement>('netlea-cfg-prefix');
  const cfgSaveBtn = element<HTMLButtonElement>('netlea-cfg-save-btn');
  const scanList = element<HTMLElement>('netlea-scan-list');

  timelineCanvas.setAttribute('aria-describedby', 'netlea-timeline-caption');
  let spectrumSummaryEl = typeof document !== 'undefined' ? document.getElementById('netlea-spectrum-summary') : null;
  if (!spectrumSummaryEl && spectrumCanvas.parentElement && typeof document !== 'undefined' && typeof document.createElement === 'function') {
    spectrumSummaryEl = node('p', '', 'visually-hidden');
    spectrumSummaryEl.id = 'netlea-spectrum-summary';
    spectrumCanvas.parentElement.append(spectrumSummaryEl);
  }
  if (spectrumSummaryEl) {
    spectrumCanvas.setAttribute('aria-describedby', 'netlea-spectrum-summary');
  }

  const lifecycleAc = new AbortController();
  let activeAc: AbortController | null = null;
  let badgeAc: AbortController | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let spectrumRafId: number | null = null;
  let tripPreviewRafId: number | null = null;
  let resizeRafId: number | null = null;
  let disposed = false;

  const actionButtons = [
    clockBtn,
    scanBtn,
    syncBtn,
    refreshBtn,
    onBtn,
    offBtn,
    resumeBtn,
    brightnessBtn,
    schedReadBtn,
    schedClearBtn,
    schedSaveBtn,
    presetImportBtn,
    presetApplyBtn,
    applyTempBtn,
    applyManualBtn,
    manualOffBtn,
    saveDefaultBtn,
    saveSlotBtn,
    cfgTempSaveBtn,
    cfgSaveBtn,
  ];

  let active = false;
  let busy = false;
  let dashboardSeq = 0;
  let badgeSeq = 0;
  let previewSeq = 0;
  let activeView: 'schedule' | 'preset' | 'manual' = 'schedule';
  let lastPayload: NetleaDashboardPayload | null = null;
  let catalog: NetleaCatalog | null = null;

  // Schedule editor state
  let draftTrips: NetleaTrip[] = [];
  let draftSunrise = 20;
  let draftSunset = 20;
  let draftTravelModel = 0;
  let schedDirty = false;
  let clearArmed = false;
  let clearArmTimer: ReturnType<typeof setTimeout> | null = null;

  // Single trip editor modal state
  let editingTripIndex = -1; // -1 = new
  let editorSpecMode: 'scene' | 'custom' = 'scene';
  let editorDays: number[] = [1, 1, 1, 1, 1, 1, 1];

  // Cultivation preset preview state
  let selectedPresetId = 'open_tank';
  let previewedSchedule: NetleaSchedule | null = null;
  let presetDebounce: ReturnType<typeof setTimeout> | null = null;

  // Manual workbench state
  let selectedSeries: '0' | '1' | '2' | 'custom' = '0';
  let selectedSceneCode = 0;
  let selectedSceneGear = 8;
  let manualPreviewDirty = false;
  let lastBannerText = '';

  function setBanner(text: string, tone: 'ok' | 'warn' | 'err' = 'ok'): void {
    const trimmed = text.trim();
    statusBanner.className = `health-status-banner tone-${tone}`;
    statusBanner.textContent = text;
    statusBanner.hidden = !text;
    if (trimmed && trimmed !== lastBannerText && options.isVisible()) {
      announceStatus(trimmed, tone === 'err' ? 'assertive' : 'polite');
    }
    lastBannerText = trimmed;
  }

  function setBusyState(nextBusy: boolean): void {
    busy = nextBusy;
    const disabled = nextBusy || appState.authExpired || !appState.ready;
    for (const btn of actionButtons) {
      btn.disabled = disabled;
    }
  }

  function findScene(modeCode: number): NetleaCatalogScene | undefined {
    return catalog?.scenes.find(s => s.modeCode === modeCode);
  }

  function approxCustomWatts(ch: NetleaChannels): number {
    const maxW = catalog?.maxWatts ?? 22;
    const est = Math.round(((ch.red * 0.35 + ch.green * 0.3 + ch.white * 0.1 + ch.blue * 0.3) / 100) * (maxW * 1.4));
    return clampInt(est, 0, Math.round(maxW * 1.8));
  }

  function switchWorkspaceView(view: 'schedule' | 'preset' | 'manual'): void {
    activeView = view;
    let matchedTab: HTMLElement | undefined;
    for (const tab of workspaceTabs.querySelectorAll<HTMLButtonElement>('button[data-netlea-view]')) {
      const isSelected = tab.dataset.netleaView === view;
      tab.classList.toggle('active', isSelected);
      if (isSelected) matchedTab = tab;
    }
    syncRovingTablist(workspaceTabs, matchedTab);
    viewSchedule.hidden = view !== 'schedule';
    viewPreset.hidden = view !== 'preset';
    viewManual.hidden = view !== 'manual';
    if (view === 'schedule') redrawTimeline();
    if (view === 'preset' && !previewedSchedule) void refreshCultivationPreview();
    if (view === 'manual') refreshSpectrumPreview();
  }

  function getTodayIdx(): number {
    const d = new Date().getDay();
    return d === 0 ? 6 : d - 1;
  }

  function markSchedDirty(dirty: boolean): void {
    schedDirty = dirty;
    schedDirtyLabel.textContent = dirty
      ? '⚠️ 有未下发改动，请点击「🚀 保存并下发行程」写入灯具'
      : '已与灯具缓存同步';
  }

  function redrawTimeline(): void {
    const maxW = catalog?.maxWatts ?? lastPayload?.state?.maxWatts ?? 22;
    drawTimelineCanvas(timelineCanvas, draftTrips, draftSunrise, draftSunset, maxW, getTodayIdx());
    const enabled = draftTrips.filter(t => t.enable).length;
    if (enabled === 0) {
      schedBadge.className = 'hub-badge badge-slate';
      schedBadge.textContent = '未配置行程';
      timelineCaption.textContent = '当前尚未设置启用的定时行程；新增时段或使用「🌱 官方养殖预设」即可开启 24h 日出日落曲线。';
    } else {
      schedBadge.className = 'hub-badge badge-blue';
      schedBadge.textContent = `已配置 ${enabled} 段 · 日出 ${draftSunrise}m / 日落 ${draftSunset}m`;
      timelineCaption.textContent = `今日（周${DAY_NAMES[getTodayIdx()]}）共 ${enabled}/${draftTrips.length} 个启用的时段；橙色竖线为当前时刻。`;
    }
  }

  function renderTripList(): void {
    if (!draftTrips.length) {
      tripListEl.replaceChildren(node('p', '暂无定时时段，点击「＋ 新增时段」或切换到「🌱 官方养殖预设」一键生成。', 'empty'));
      redrawTimeline();
      return;
    }
    const focusedTripKey = typeof document !== 'undefined' && tripListEl.contains?.(document.activeElement)
      ? ((document.activeElement as HTMLElement | null)?.dataset?.tripFocusKey ?? null)
      : null;

    const frag = document.createDocumentFragment();
    for (let i = 0; i < draftTrips.length; i++) {
      const trip = draftTrips[i]!;
      const timeRangeLabel = `${formatHm(trip.startH, trip.startM)}-${formatHm(trip.endH, trip.endM)}`;
      const tripNameLabel = `${timeRangeLabel} ${trip.name || '时段'}`;
      const card = node(
        'div',
        '',
        `netlea-trip-card${trip.enable ? '' : ' is-disabled'}`,
      );

      const main = node('div', '', 'netlea-trip-main');
      const titleRow = node('div', '', 'netlea-trip-title');
      const timeStrong = node('strong', `${formatHm(trip.startH, trip.startM)} - ${formatHm(trip.endH, trip.endM)}`);
      const modeBadge = node(
        'span',
        trip.modeCode === 12
          ? `自定义 (${trip.powerWatts ?? approxCustomWatts(trip)}W)`
          : `${trip.seriesName ? `${trip.seriesName}·` : ''}${trip.name || '场景'} ${trip.gear}档 (${trip.powerWatts ?? '--'}W)`,
        'hub-badge badge-blue',
      );
      const daySpan = node('span', formatDaySummary(trip.dayList), 'hub-badge badge-slate');
      titleRow.append(timeStrong, modeBadge, daySpan);

      if (trip.enable && draftSunrise > 0 && trip.hasSunrise !== false) {
        titleRow.append(node('span', `🌅 ${draftSunrise}m`, 'hub-badge badge-amber'));
      }
      if (trip.enable && draftSunset > 0 && trip.hasSunset !== false) {
        titleRow.append(node('span', `🌇 ${draftSunset}m`, 'hub-badge badge-amber'));
      }

      const detail = node(
        'div',
        `R${trip.red}% G${trip.green}% W${trip.white}% B${trip.blue}%`,
        'meta',
      );
      main.append(titleRow, detail);

      const actions = node('div', '', 'modal-btn-group');
      const toggleBtn = button(trip.enable ? '⏸ 停用' : '▶ 启用', () => {
        trip.enable = trip.enable ? 0 : 1;
        markSchedDirty(true);
        renderTripList();
      }, 'mini-button');
      toggleBtn.setAttribute('aria-pressed', String(Boolean(trip.enable)));
      toggleBtn.setAttribute('aria-label', `${trip.enable ? '停用' : '启用'}时段 ${tripNameLabel}`);
      toggleBtn.dataset.tripFocusKey = `${i}:toggle`;

      const editBtn = button('✏️ 编辑', () => {
        openTripEditor(i);
      }, 'mini-button');
      editBtn.setAttribute('aria-label', `编辑时段 ${tripNameLabel}`);
      editBtn.dataset.tripFocusKey = `${i}:edit`;

      const delBtn = button('🗑 删除', () => {
        void (async () => {
          const confirmed = await confirmAction({
            title: '删除定时时段',
            message: `确定从草稿列表中移除定时时段「${tripNameLabel}」吗？`,
            confirmLabel: '确认删除',
            cancelLabel: '取消',
            danger: true,
          });
          if (!confirmed) return;
          const curIdx = draftTrips.indexOf(trip);
          if (curIdx < 0) return;
          draftTrips.splice(curIdx, 1);
          markSchedDirty(true);
          if (editingTripIndex === curIdx) {
            tripEditor.hidden = true;
            editingTripIndex = -1;
          } else if (editingTripIndex > curIdx) {
            editingTripIndex--;
          }
          renderTripList();
        })();
      }, 'mini-button danger-btn');
      delBtn.setAttribute('aria-label', `删除时段 ${tripNameLabel}`);
      delBtn.dataset.tripFocusKey = `${i}:del`;
      actions.append(toggleBtn, editBtn, delBtn);

      card.append(main, actions);
      frag.append(card);
    }
    tripListEl.replaceChildren(frag);
    if (focusedTripKey) {
      const target = Array.from(tripListEl.querySelectorAll<HTMLButtonElement>('button[data-trip-focus-key]'))
        .find(b => b.dataset.tripFocusKey === focusedTripKey);
      if (target) safeFocus(target, { preventScroll: true });
    }
    redrawTimeline();
  }

  function populateTripSceneSelect(): void {
    if (!catalog || tripSceneSelect.options.length > 0) return;
    const frag = document.createDocumentFragment();
    for (const sc of catalog.scenes) {
      const opt = document.createElement('option');
      opt.value = String(sc.modeCode);
      opt.textContent = `${sc.seriesName} · ${sc.name}`;
      frag.append(opt);
    }
    tripSceneSelect.replaceChildren(frag);
  }

  function syncTripEditorPreview(): void {
    const modeCode = clampInt(Number(tripSceneSelect.value || 0), 0, 11);
    const sc = findScene(modeCode);
    const maxGear = sc?.maxGear ?? 10;
    tripGearInput.max = String(maxGear);
    const gear = clampInt(Number(tripGearInput.value), 1, maxGear);
    tripGearInput.value = String(gear);
    const gearObj = sc?.gears.find(g => g.gear === gear);
    tripGearVal.textContent = `${gear} 档`;
    const gearWattsText = gearObj ? `${gearObj.powerWatts}W` : '--W';
    tripWattsSpan.textContent = gearWattsText;
    tripGearInput.setAttribute('aria-valuetext', gearObj ? `${gear} 档（${gearObj.powerWatts} W）` : `${gear} 档`);

    const ch: NetleaChannels = {
      red: clampInt(Number(tripR.value), 0, 100),
      green: clampInt(Number(tripG.value), 0, 100),
      white: clampInt(Number(tripW.value), 0, 100),
      blue: clampInt(Number(tripB.value), 0, 100),
      fan: 0,
    };
    tripRVal.textContent = String(ch.red);
    tripGVal.textContent = String(ch.green);
    tripWVal.textContent = String(ch.white);
    tripBVal.textContent = String(ch.blue);
    tripR.setAttribute('aria-valuetext', `${ch.red}%`);
    tripG.setAttribute('aria-valuetext', `${ch.green}%`);
    tripW.setAttribute('aria-valuetext', `${ch.white}%`);
    tripB.setAttribute('aria-valuetext', `${ch.blue}%`);
    const maxW = catalog?.maxWatts ?? 22;
    const estW = approxCustomWatts(ch);
    tripCustomWatts.textContent = estW > maxW ? `约 ${estW}W (超 ${maxW}W 将自动限幅)` : `约 ${estW}W / ${maxW}W`;
    tripCustomWatts.className = `hub-badge ${estW > maxW ? 'badge-red' : 'badge-slate'}`;
  }

  function syncEditorDaysUi(): void {
    for (const btn of tripDaysEl.querySelectorAll<HTMLButtonElement>('button[data-day]')) {
      const idx = clampInt(Number(btn.dataset.day), 0, 6);
      const isSelected = Boolean(editorDays[idx]);
      btn.classList.toggle('active', isSelected);
      btn.setAttribute('aria-pressed', String(isSelected));
    }
  }

  function setEditorSpecMode(mode: 'scene' | 'custom'): void {
    editorSpecMode = mode;
    for (const btn of tripSpecModeEl.querySelectorAll<HTMLButtonElement>('button[data-spec-mode]')) {
      const isSelected = btn.dataset.specMode === mode;
      btn.classList.toggle('active', isSelected);
      btn.setAttribute('aria-pressed', String(isSelected));
    }
    tripSceneBox.hidden = mode !== 'scene';
    tripCustomBox.hidden = mode !== 'custom';
    syncTripEditorPreview();
  }

  function openTripEditor(idx: number): void {
    populateTripSceneSelect();
    editingTripIndex = idx;
    if (idx === -1) {
      tripEditorTitle.textContent = `新增时段 (#${draftTrips.length + 1})`;
      const last = draftTrips[draftTrips.length - 1];
      const defStartH = last ? last.endH : 9;
      const defStartM = last ? last.endM : 0;
      const defEndMin = Math.min(23 * 60 + 59, defStartH * 60 + defStartM + 120);
      tripStartInput.value = formatHm(defStartH, defStartM);
      tripEndInput.value = formatHm(Math.floor(defEndMin / 60), defEndMin % 60);
      tripEnabledInput.checked = true;
      editorDays = [1, 1, 1, 1, 1, 1, 1];
      tripSceneSelect.value = '0';
      tripGearInput.value = '8';
      tripR.value = String(lastPayload?.config.defaultChannels.red ?? 39);
      tripG.value = String(lastPayload?.config.defaultChannels.green ?? 59);
      tripW.value = String(lastPayload?.config.defaultChannels.white ?? 79);
      tripB.value = String(lastPayload?.config.defaultChannels.blue ?? 36);
      setEditorSpecMode('scene');
    } else {
      const t = draftTrips[idx]!;
      tripEditorTitle.textContent = `编辑第 ${idx + 1} 段行程`;
      tripEnabledInput.checked = Boolean(t.enable);
      tripStartInput.value = formatHm(t.startH, t.startM);
      tripEndInput.value = formatHm(t.endH, t.endM);
      editorDays = Array.isArray(t.dayList) && t.dayList.length === 7 ? [...t.dayList] : [1, 1, 1, 1, 1, 1, 1];
      if (t.modeCode === 12) {
        tripR.value = String(t.red);
        tripG.value = String(t.green);
        tripW.value = String(t.white);
        tripB.value = String(t.blue);
        setEditorSpecMode('custom');
      } else {
        tripSceneSelect.value = String(clampInt(t.modeCode, 0, 11));
        tripGearInput.value = String(clampInt(t.gear, 1, 10));
        setEditorSpecMode('scene');
      }
    }
    syncEditorDaysUi();
    syncTripEditorPreview();
    tripEditor.hidden = false;
  }

  async function refreshCultivationPreview(): Promise<void> {
    if (presetDebounce) {
      clearTimeout(presetDebounce);
      presetDebounce = null;
    }
    const seq = ++previewSeq;
    const start = parseHm(presetStartInput.value, 9, 0);
    const lengthCm = clampInt(Number(tankLInput.value), 10, 300);
    const widthCm = clampInt(Number(tankWInput.value), 10, 200);
    const heightCm = clampInt(Number(tankHInput.value), 10, 200);
    const sunriseMinutes = clampInt(Number(presetFadeInput.value), 0, 300);
    try {
      const res = await api<NetleaPluginResponse<{ schedule: NetleaSchedule }>>('/api/plugin-run', {
        plugin: 'netlea',
        action: 'schedule',
        args: {
          op: 'preset',
          preset: selectedPresetId,
          lengthCm,
          widthCm,
          heightCm,
          startHour: start.h,
          startMinute: start.m,
          sunriseMinutes,
          sunsetMinutes: sunriseMinutes,
          previewOnly: true,
        },
      });
      if (seq !== previewSeq || appState.authExpired) return;
      if (!res.ok || !res.data?.schedule) return;
      previewedSchedule = res.data.schedule;
      const sched = previewedSchedule;
      presetMeta.textContent = `${sched.presetName || selectedPresetId} · 推荐基准功率约 ${sched.targetBaseWatts ?? '--'}W · 共 ${sched.trips.length} 阶段（含日出/日落 ${sched.sunriseMinutes} 分钟）`;

      const frag = document.createDocumentFragment();
      for (let i = 0; i < sched.trips.length; i++) {
        const t = sched.trips[i]!;
        const card = node('div', '', 'netlea-trip-card');
        const main = node('div', '', 'netlea-trip-main');
        const row = node('div', '', 'netlea-trip-title');
        row.append(
          node('strong', `阶段 ${i + 1} · ${formatHm(t.startH, t.startM)} - ${formatHm(t.endH, t.endM)}`),
          node('span', `${t.seriesName || '水草'}·${t.name || '正白'} ${t.gear}档 (${t.powerWatts ?? '--'}W)`, 'hub-badge badge-blue'),
        );
        if (t.hasSunrise) row.append(node('span', `🌅 ${sched.sunriseMinutes}m`, 'hub-badge badge-amber'));
        if (t.hasSunset) row.append(node('span', `🌇 ${sched.sunsetMinutes}m`, 'hub-badge badge-amber'));
        main.append(row, node('div', `R${t.red}% G${t.green}% W${t.white}% B${t.blue}%`, 'meta'));
        card.append(main);
        frag.append(card);
      }
      presetPreviewEl.replaceChildren(frag);
    } catch {
      // Ignore transient preview errors
    }
  }

  function syncSceneSeriesHeaderUi(): void {
    for (const tab of sceneSeriesTabs.querySelectorAll<HTMLButtonElement>('button[data-series]')) {
      const isSelected = tab.dataset.series === selectedSeries;
      tab.classList.toggle('active', isSelected);
      tab.setAttribute('aria-pressed', String(isSelected));
    }
    sceneSelectorBox.hidden = selectedSeries === 'custom';
    customSlidersBox.hidden = selectedSeries !== 'custom';
  }

  function syncSceneGearReadout(): void {
    const activeScene = findScene(selectedSceneCode);
    const maxGear = activeScene?.maxGear ?? 10;
    sceneGearInput.max = String(maxGear);
    selectedSceneGear = clampInt(selectedSceneGear, 1, maxGear);
    sceneGearInput.value = String(selectedSceneGear);
    const gearData = activeScene?.gears.find(g => g.gear === selectedSceneGear);
    sceneGearVal.textContent = `${selectedSceneGear} 档`;
    sceneWattsSpan.textContent = gearData ? `${gearData.powerWatts}W` : '--W';
    sceneGearInput.setAttribute('aria-valuetext', gearData ? `${selectedSceneGear} 档（${gearData.powerWatts} W）` : `${selectedSceneGear} 档`);
    if (gearData) {
      syncSliderInputs(gearData.channels);
    }
  }

  function renderSceneSeriesSubpills(): void {
    const modelIdx = selectedSeries === 'custom' ? -1 : clampInt(Number(selectedSeries), 0, 2);
    syncSceneSeriesHeaderUi();
    if (selectedSeries === 'custom' || !catalog) {
      refreshSpectrumPreview();
      return;
    }

    const seriesScenes = catalog.scenes.filter(s => s.model === modelIdx);
    if (!seriesScenes.some(s => s.modeCode === selectedSceneCode) && seriesScenes.length > 0) {
      selectedSceneCode = seriesScenes[0]!.modeCode;
    }

    const focusedSceneCode = typeof document !== 'undefined' && sceneSubpills.contains?.(document.activeElement)
      ? ((document.activeElement as HTMLElement | null)?.dataset?.sceneCode ?? null)
      : null;

    const frag = document.createDocumentFragment();
    for (const sc of seriesScenes) {
      const isSelected = sc.modeCode === selectedSceneCode;
      const btn = button(sc.name, () => {
        selectedSceneCode = sc.modeCode;
        manualPreviewDirty = true;
        renderSceneSeriesSubpills();
      }, `hub-filter-pill${isSelected ? ' active' : ''}`);
      btn.setAttribute('aria-pressed', String(isSelected));
      btn.dataset.sceneCode = String(sc.modeCode);
      frag.append(btn);
    }
    sceneSubpills.replaceChildren(frag);
    if (focusedSceneCode) {
      const target = Array.from(sceneSubpills.querySelectorAll<HTMLButtonElement>('button[data-scene-code]'))
        .find(b => b.dataset.sceneCode === focusedSceneCode);
      if (target) safeFocus(target, { preventScroll: true });
    }

    syncSceneGearReadout();
    refreshSpectrumPreview();
  }

  function readCustomSliderChannels(): NetleaChannels {
    return {
      red: clampInt(Number(chRed.value), 0, 100),
      green: clampInt(Number(chGreen.value), 0, 100),
      white: clampInt(Number(chWhite.value), 0, 100),
      blue: clampInt(Number(chBlue.value), 0, 100),
      fan: clampInt(Number(chFan.value), 0, 5),
    };
  }

  function syncSliderInputs(channels: NetleaChannels): void {
    chRed.value = String(channels.red);
    chGreen.value = String(channels.green);
    chWhite.value = String(channels.white);
    chBlue.value = String(channels.blue);
    chFan.value = String(channels.fan);
    syncChannelReadoutText(channels);
  }

  function syncChannelReadoutText(channels: NetleaChannels): void {
    chRedVal.textContent = String(channels.red);
    chGreenVal.textContent = String(channels.green);
    chWhiteVal.textContent = String(channels.white);
    chBlueVal.textContent = String(channels.blue);
    chFanVal.textContent = String(channels.fan);
    chRed.setAttribute('aria-valuetext', `${channels.red}%`);
    chGreen.setAttribute('aria-valuetext', `${channels.green}%`);
    chWhite.setAttribute('aria-valuetext', `${channels.white}%`);
    chBlue.setAttribute('aria-valuetext', `${channels.blue}%`);
    chFan.setAttribute('aria-valuetext', `${channels.fan} 档`);
  }

  function renderSavedCustomSlots(presets: NetleaSavedPreset[]): void {
    if (!presets.length) {
      customSlotsEl.replaceChildren(node('span', '暂无收藏槽（调整四通道后点击「➕ 收藏当前自定义」）', 'meta'));
      return;
    }
    const frag = document.createDocumentFragment();
    presets.forEach((p, idx) => {
      const btn = button(`${p.name} (R${p.red} G${p.green} W${p.white} B${p.blue})`, () => {
        selectedSeries = 'custom';
        manualPreviewDirty = true;
        syncSliderInputs(p);
        renderSceneSeriesSubpills();
        setBanner(`已加载收藏「${p.name}」，可选择临时下发或设为手动恒亮。`, 'warn');
      }, 'hub-filter-pill');
      btn.setAttribute('aria-label', `加载收藏光谱 ${p.name}`);
      const rmBtn = button('✕', () => {
        void (async () => {
          if (disposed || busy || appState.authExpired || !appState.ready) return;
          const confirmed = await confirmAction({
            title: '删除自定义光谱收藏',
            message: `确定删除收藏光谱「${p.name}」吗？`,
            confirmLabel: '确认删除',
            cancelLabel: '取消',
            danger: true,
          });
          if (!confirmed || disposed || busy || appState.authExpired || !appState.ready) return;
          const next = (lastPayload?.config.savedCustomPresets || presets).filter((_, i) => i !== idx);
          void runNetleaAndRefresh('config', { savedCustomPresets: next }, { forceInputs: false });
        })();
      }, 'mini-button');
      rmBtn.setAttribute('aria-label', `删除收藏光谱 ${p.name}`);
      frag.append(btn, rmBtn);
    });
    customSlotsEl.replaceChildren(frag);
  }

  function refreshSpectrumPreview(): void {
    const ch = readCustomSliderChannels();
    syncChannelReadoutText(ch);

    const maxW = catalog?.maxWatts ?? lastPayload?.state?.maxWatts ?? 22;
    let watts = approxCustomWatts(ch);
    let badgeText = '';
    if (selectedSeries !== 'custom') {
      const sc = findScene(selectedSceneCode);
      const gearObj = sc?.gears.find(g => g.gear === selectedSceneGear);
      if (sc && gearObj) {
        watts = gearObj.powerWatts;
        badgeText = `${manualPreviewDirty ? '预览：' : ''}${sc.seriesName} · ${sc.name} ${gearObj.gear}档 (${watts}W)`;
      }
    }
    if (!badgeText) {
      const state = lastPayload?.state;
      badgeText = manualPreviewDirty
        ? `自定义通道预览 · 约 ${watts}W`
        : state
          ? `当前状态：${state.runModeLabel || (state.on ? '开启' : '关闭')} (${state.powerWatts ?? watts}W)`
          : '尚未同步实时状态';
    }
    powerBadge.textContent = `${watts}W / ${maxW}W`;
    powerBadge.className = `hub-badge ${watts > maxW ? 'badge-red' : 'badge-amber'}`;
    powerClampNote.textContent = watts > maxW
      ? `⚠️ 超出 ${maxW}W 额定上限，下发时将自动等比限幅至 ${maxW}W`
      : `开启 ${maxW}W 额定功率上限保护`;
    const summaryText = `四通道实时光谱分布：${badgeText}，红光 ${ch.red}%、绿光 ${ch.green}%、白光 ${ch.white}%、蓝光 ${ch.blue}%、风扇 ${ch.fan} 档，估算功率 ${watts}W（上限 ${maxW}W）`;
    spectrumCanvas.setAttribute('aria-label', summaryText);
    if (spectrumSummaryEl) spectrumSummaryEl.textContent = summaryText;
    drawSpectrumCanvas(spectrumCanvas, ch, badgeText);
  }

  function scheduleSpectrumRedraw(): void {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      if (spectrumRafId !== null) window.cancelAnimationFrame(spectrumRafId);
      spectrumRafId = window.requestAnimationFrame(() => {
        spectrumRafId = null;
        refreshSpectrumPreview();
      });
    } else {
      refreshSpectrumPreview();
    }
  }

  function scheduleTripEditorPreview(): void {
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      if (tripPreviewRafId !== null) window.cancelAnimationFrame(tripPreviewRafId);
      tripPreviewRafId = window.requestAnimationFrame(() => {
        tripPreviewRafId = null;
        syncTripEditorPreview();
      });
    } else {
      syncTripEditorPreview();
    }
  }

  function updateBadge(payload: NetleaDashboardPayload | null): void {
    const st = payload?.state;
    if (!st) {
      topBadge.textContent = '待读';
      return;
    }
    topBadge.textContent = st.on
      ? `${st.runModeLabel || '开'} · ${st.powerWatts ?? st.channels.white}W`
      : '已关';
  }

  function renderDashboard(payload: NetleaDashboardPayload, forceInputs = false): void {
    lastPayload = payload;
    if (payload.catalog) catalog = payload.catalog;
    updateBadge(payload);

    const dev = payload.device;
    const st = payload.state;
    const cfg = payload.config;
    const adv = dev?.advertisement;
    const maxW = catalog?.maxWatts ?? st?.maxWatts ?? 22;

    modelPill.textContent = `${formatNetleaDisplayName(dev?.name)} · ${maxW}W`;

    const statusLabel = st ? (st.runModeLabel || (st.on ? '开启' : '关闭')) : '未知';
    const statusTone = st ? (st.on ? 'positive' : 'default') : 'warning';
    const rssiText = typeof dev?.rssi === 'number' ? `${dev.rssi} dBm` : '--';
    const rtcText = adv?.rtc || '--';
    const chText = st
      ? `${st.powerWatts ?? '--'}W · R${st.channels.red} G${st.channels.green} W${st.channels.white} B${st.channels.blue}`
      : `默认 W${cfg.defaultChannels.white}%`;
    const sceneSub = st?.matchedScene
      ? `${st.matchedScene.seriesName}·${st.matchedScene.name} ${st.matchedScene.gear}档`
      : (st ? '自定义比例' : '尚无缓存');
    const schedKpi = payload.activeTrip
      ? `「${payload.activeTrip.name || '时段'}」`
      : (payload.schedule?.trips?.length ? `${payload.schedule.trips.filter(t => t.enable).length} 段启用` : '无行程');

    const kpiFrag = document.createDocumentFragment();
    kpiFrag.append(
      kpiCard('运行模式与开关', statusLabel, dev ? formatNetleaDisplayName(dev.name) : (cfg.targetMac ? '已绑定设备' : '未读取'), statusTone),
      kpiCard('光谱与功率', chText, sceneSub, st?.on ? 'accent' : 'default'),
      kpiCard('定时行程 / 信号', `${schedKpi} · ${rssiText}`, dev ? '已连接发现' : '自动发现', typeof dev?.rssi === 'number' && dev.rssi > -75 ? 'positive' : 'default'),
      kpiCard('灯内时钟 (RTC)', rtcText.length >= 19 ? rtcText.slice(11, 19) : rtcText, payload.updatedAt ? `同步于 ${timestamp(payload.updatedAt)}` : '尚无缓存', 'default'),
    );
    kpiGrid.replaceChildren(kpiFrag);

    if (dev || st) {
      const parts = [
        dev ? `设备：${formatNetleaDisplayName(dev.name)}` : '',
        adv?.rtc ? `灯内 RTC：${adv.rtc}` : '',
        payload.tempConfig ? `灯内临时时长：开 ${payload.tempConfig.onMinutes}m / 关 ${payload.tempConfig.offMinutes}m` : '',
        payload.updatedAt ? `缓存时间：${timestamp(payload.updatedAt)}` : '',
      ].filter(Boolean);
      deviceMeta.textContent = parts.join(' ｜ ');
    } else {
      deviceMeta.textContent = '尚未读取鱼缸灯实时数据，点击右上角「🔄 实时同步」连接灯具。';
    }

    if (!schedDirty && payload.schedule) {
      draftTrips = (payload.schedule.trips || []).map(t => ({ ...t, dayList: [...(t.dayList || [1, 1, 1, 1, 1, 1, 1])] }));
      draftSunrise = clampInt(payload.schedule.sunriseMinutes ?? 20, 0, 300);
      draftSunset = clampInt(payload.schedule.sunsetMinutes ?? 20, 0, 300);
      draftTravelModel = payload.schedule.travelModel ?? 0;
      sunriseInput.value = String(draftSunrise);
      sunsetInput.value = String(draftSunset);
      markSchedDirty(false);
    }
    renderTripList();

    if (forceInputs || !isEditingWithin(panel)) {
      manualPreviewDirty = false;
      const shownChannels = st && st.on ? st.channels : cfg.defaultChannels;
      syncSliderInputs(shownChannels);
      if (st?.matchedScene) {
        const modelStr = String(st.matchedScene.model);
        selectedSeries = modelStr === '0' || modelStr === '1' || modelStr === '2' ? modelStr : 'custom';
        selectedSceneCode = st.matchedScene.modeCode;
        selectedSceneGear = st.matchedScene.gear;
      } else if (st) {
        selectedSeries = 'custom';
      }
      renderSceneSeriesSubpills();

      tempMinInput.value = String(payload.tempConfig?.onMinutes ?? cfg.tempOnMinutes ?? 20);
      cfgOnMinInput.value = String(payload.tempConfig?.onMinutes ?? cfg.tempOnMinutes ?? 20);
      cfgOffMinInput.value = String(payload.tempConfig?.offMinutes ?? cfg.tempOffMinutes ?? 20);
      cfgMacInput.value = cfg.targetMac;
      cfgPrefixInput.value = cfg.namePrefix;
      tankLInput.value = String(cfg.tankSize?.lengthCm ?? 60);
      tankWInput.value = String(cfg.tankSize?.widthCm ?? 30);
      tankHInput.value = String(cfg.tankSize?.heightCm ?? 36);
    }
    ++badgeSeq;
    renderSavedCustomSlots(cfg.savedCustomPresets || []);
    refreshSpectrumPreview();
    if (!previewedSchedule && !viewPreset.hidden) {
      void refreshCultivationPreview();
    }
  }

  async function runNetlea(
    action: string,
    args: Record<string, unknown> = {},
    opts: { silent?: boolean; pendingBanner?: string } = {},
  ): Promise<NetleaPluginResponse<Record<string, unknown>> | null> {
    if (busy || appState.authExpired || !appState.ready) return null;
    setBusyState(true);
    ++dashboardSeq;
    if (opts.pendingBanner) setBanner(opts.pendingBanner, 'warn');
    try {
      const res = await api<NetleaPluginResponse<Record<string, unknown>>>('/api/plugin-run', {
        plugin: 'netlea',
        action,
        args,
      });
      if (!res.ok) {
        if (!opts.silent) setBanner(res.message || '执行失败', 'err');
        return res;
      }
      if (!opts.silent && res.message) {
        setBanner(res.message, 'ok');
      }
      return res;
    } catch (err) {
      if (!opts.silent) setBanner(`操作失败：${errorText(err)}`, 'err');
      return null;
    } finally {
      setBusyState(false);
    }
  }

  async function loadDashboard(refresh = false, forceInputs = false): Promise<void> {
    const res = await runNetlea(
      'dashboard',
      refresh ? { refresh: true } : {},
      {
        silent: !refresh,
        ...(refresh ? { pendingBanner: '正在单次短连接读取实时状态、临时设置与灯内行程…' } : {}),
      },
    );
    if (!appState.authExpired && res?.ok && res.data) {
      renderDashboard(res.data as unknown as NetleaDashboardPayload, forceInputs);
    }
  }

  async function refreshAfterMutation(forceInputs = true): Promise<void> {
    if (appState.authExpired) return;
    const seq = ++dashboardSeq;
    try {
      const dashRes = await api<NetleaPluginResponse<NetleaDashboardPayload>>('/api/plugin-run', {
        plugin: 'netlea',
        action: 'dashboard',
        args: {},
      });
      if (seq !== dashboardSeq || appState.authExpired) return;
      if (dashRes.ok && dashRes.data) {
        renderDashboard(dashRes.data, forceInputs);
      } else if (!dashRes.ok) {
        setBanner(dashRes.message || '刷新鱼缸灯看板失败', 'err');
      }
    } catch (err) {
      if (seq === dashboardSeq && !appState.authExpired) {
        setBanner(`刷新状态失败：${errorText(err)}`, 'err');
      }
    }
  }

  async function runNetleaAndRefresh(
    action: string,
    args: Record<string, unknown> = {},
    opts: {
      pendingBanner?: string;
      forceInputs?: boolean;
      onSuccess?: (res: NetleaPluginResponse<Record<string, unknown>>) => Promise<void> | void;
    } = {},
  ): Promise<void> {
    if (busy || appState.authExpired || !appState.ready) return;
    setBusyState(true);
    ++dashboardSeq;
    if (opts.pendingBanner) setBanner(opts.pendingBanner, 'warn');
    try {
      const res = await api<NetleaPluginResponse<Record<string, unknown>>>('/api/plugin-run', {
        plugin: 'netlea',
        action,
        args,
      });
      if (appState.authExpired) return;
      if (!res.ok) {
        setBanner(res.message || '执行失败', 'err');
        return;
      }
      if (res.message) {
        setBanner(res.message, 'ok');
      }
      if (opts.onSuccess) {
        await opts.onSuccess(res);
      }
      await refreshAfterMutation(opts.forceInputs ?? true);
    } catch (err) {
      if (!appState.authExpired) {
        setBanner(`操作失败：${errorText(err)}`, 'err');
      }
    } finally {
      setBusyState(false);
    }
  }

  function renderScanResults(devices: NetleaDeviceView[]): void {
    if (!devices.length) {
      scanList.replaceChildren(node('p', '未扫描到可用尼特利鱼缸灯，请确认灯具通电且手机 App 未占用蓝牙。', 'meta'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const dev of devices) {
      const row = node('div', '', 'netlea-scan-item');
      const info = node('div');
      const adv = dev.advertisement?.rtc ? ` · RTC ${dev.advertisement.rtc}` : '';
      info.append(
        node('strong', formatNetleaDisplayName(dev.name)),
        node('div', `${dev.address} · RSSI ${dev.rssi ?? '--'} dBm${adv}`, 'meta'),
      );
      const bindBtn = button('设为绑定 MAC', () => {
        if (busy || appState.authExpired || !appState.ready) return;
        cfgMacInput.value = dev.address;
        void runNetleaAndRefresh('config', { targetMac: dev.address });
      }, 'mini-button');
      bindBtn.setAttribute('aria-label', `将 ${formatNetleaDisplayName(dev.name)} (${dev.address}) 设为绑定 MAC`);
      row.append(info, bindBtn);
      frag.append(row);
    }
    scanList.replaceChildren(frag);
  }

  function syncBrightnessReadout(): void {
    const val = `${brightnessRange.value}%`;
    brightnessVal.textContent = val;
    brightnessRange.setAttribute('aria-valuetext', val);
  }

  syncBrightnessReadout();
  syncTripEditorPreview();
  syncSceneGearReadout();
  syncChannelReadoutText(readCustomSliderChannels());

  // Event wiring: Top bar & quick controls
  listenEvent(clockBtn, 'click', () => {
    void runNetleaAndRefresh('clock', {}, {
      pendingBanner: '正在通过蓝牙将主机时钟同步写入鱼缸灯 RTC…',
      forceInputs: false,
    });
  }, lifecycleAc.signal);

  listenEvent(scanBtn, 'click', () => {
    void (async () => {
      const res = await runNetlea('scan', { timeoutSec: 5 }, {
        pendingBanner: '正在扫描尼特利鱼缸灯蓝牙广播…',
      });
      if (res?.ok && res.data) {
        const devices = Array.isArray(res.data.devices) ? (res.data.devices as NetleaDeviceView[]) : [];
        renderScanResults(devices);
        if (devices.length > 0 && activeView !== 'manual') {
          setBanner(`扫描到 ${devices.length} 台设备（已填入「手动控光与光谱库 -> 蓝牙绑定」列表）`, 'ok');
        }
      }
    })();
  }, lifecycleAc.signal);

  listenEvent(syncBtn, 'click', () => {
    if (busy || appState.authExpired || !appState.ready) return;
    schedDirty = false;
    void loadDashboard(true, true);
  }, lifecycleAc.signal);

  listenEvent(refreshBtn, 'click', () => {
    void loadDashboard(false, true);
  }, lifecycleAc.signal);

  listenEvent(onBtn, 'click', () => {
    const durationMinutes = clampInt(Number(tempMinInput.value), 1, 300);
    void runNetleaAndRefresh('on', { durationMinutes }, {
      pendingBanner: `正在发送 ${durationMinutes} 分钟临时开灯指令…`,
    });
  }, lifecycleAc.signal);

  listenEvent(offBtn, 'click', () => {
    const durationMinutes = clampInt(Number(tempMinInput.value), 1, 300);
    void runNetleaAndRefresh('off', { durationMinutes }, {
      pendingBanner: `正在发送 ${durationMinutes} 分钟临时关灯指令…`,
    });
  }, lifecycleAc.signal);

  listenEvent(resumeBtn, 'click', () => {
    void runNetleaAndRefresh('resume', {}, {
      pendingBanner: '正在切换回 24h 自动行程…',
    });
  }, lifecycleAc.signal);

  listenEvent(brightnessRange, 'input', syncBrightnessReadout, lifecycleAc.signal);

  listenEvent(brightnessBtn, 'click', () => {
    const brightness = clampInt(Number(brightnessRange.value), 1, 100);
    const durationMinutes = clampInt(Number(tempMinInput.value), 1, 300);
    void runNetleaAndRefresh('on', { brightness, durationMinutes }, {
      pendingBanner: `正在按默认光谱 ${brightness}% 亮度临时开启…`,
    });
  }, lifecycleAc.signal);

  // Event wiring: Workspace sub-tabs
  bindRovingTablist(workspaceTabs, {
    signal: lifecycleAc.signal,
    onActivate: btn => {
      const view = btn.dataset.netleaView as 'schedule' | 'preset' | 'manual' | undefined;
      if (view) switchWorkspaceView(view);
    },
  });

  // Event wiring: View 1 - Schedule & Sunrise/Sunset
  const handleSunChange = () => {
    draftSunrise = clampInt(Number(sunriseInput.value), 0, 300);
    draftSunset = clampInt(Number(sunsetInput.value), 0, 300);
    for (const p of sunPills.querySelectorAll<HTMLButtonElement>('button[data-sun-min]')) {
      const match = draftSunrise === draftSunset && Number(p.dataset.sunMin) === draftSunrise;
      p.classList.toggle('active', match);
      p.setAttribute('aria-pressed', String(match));
    }
    markSchedDirty(true);
    renderTripList();
  };
  listenEvent(sunriseInput, 'change', handleSunChange, lifecycleAc.signal);
  listenEvent(sunsetInput, 'change', handleSunChange, lifecycleAc.signal);

  listenEvent(sunPills, 'click', event => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-sun-min]');
    if (!btn) return;
    const min = clampInt(Number(btn.dataset.sunMin), 0, 300);
    draftSunrise = min;
    draftSunset = min;
    sunriseInput.value = String(min);
    sunsetInput.value = String(min);
    for (const p of sunPills.querySelectorAll<HTMLButtonElement>('button[data-sun-min]')) {
      const isSelected = p === btn;
      p.classList.toggle('active', isSelected);
      p.setAttribute('aria-pressed', String(isSelected));
    }
    markSchedDirty(true);
    renderTripList();
  }, lifecycleAc.signal);

  listenEvent(schedReadBtn, 'click', () => {
    void runNetleaAndRefresh('schedule', { op: 'get' }, {
      pendingBanner: '正在从灯具闪存回读 24h 定时行程…',
      forceInputs: false,
      onSuccess: res => {
        if (res.data?.schedule) {
          const sc = res.data.schedule as NetleaSchedule;
          draftTrips = (sc.trips || []).map(t => ({ ...t, dayList: [...t.dayList] }));
          draftSunrise = clampInt(sc.sunriseMinutes ?? 0, 0, 300);
          draftSunset = clampInt(sc.sunsetMinutes ?? 0, 0, 300);
          draftTravelModel = sc.travelModel ?? 0;
          sunriseInput.value = String(draftSunrise);
          sunsetInput.value = String(draftSunset);
          markSchedDirty(false);
        }
      },
    });
  }, lifecycleAc.signal);

  listenEvent(tripNewBtn, 'click', () => {
    if (draftTrips.length >= 10) {
      setBanner('灯具最多支持 10 个定时时段，请先删除或修改现有时段。', 'err');
      return;
    }
    openTripEditor(-1);
  }, lifecycleAc.signal);

  listenEvent(schedClearBtn, 'click', () => {
    if (busy || appState.authExpired || !appState.ready) return;
    if (!clearArmed) {
      clearArmed = true;
      schedClearBtn.classList.add('is-armed');
      schedClearBtn.textContent = '⚠ 再次点击确认清空';
      setBanner('确认清空灯内全部定时行程？请在 5 秒内再次点击「⚠ 再次点击确认清空」。', 'warn');
      if (clearArmTimer) clearTimeout(clearArmTimer);
      clearArmTimer = setTimeout(() => {
        clearArmed = false;
        clearArmTimer = null;
        schedClearBtn.classList.remove('is-armed');
        schedClearBtn.textContent = '🧹 清空灯内行程';
      }, 5000);
      return;
    }
    clearArmed = false;
    if (clearArmTimer) {
      clearTimeout(clearArmTimer);
      clearArmTimer = null;
    }
    schedClearBtn.classList.remove('is-armed');
    schedClearBtn.textContent = '🧹 清空灯内行程';
    void runNetleaAndRefresh('schedule', { op: 'clear' }, {
      pendingBanner: '正在清空灯内全部定时行程…',
      forceInputs: false,
      onSuccess: () => {
        draftTrips = [];
        markSchedDirty(false);
        tripEditor.hidden = true;
        editingTripIndex = -1;
      },
    });
  }, lifecycleAc.signal);

  listenEvent(schedSaveBtn, 'click', () => {
    if (busy || appState.authExpired || !appState.ready) return;
    if (draftTrips.length === 0) {
      setBanner('当前列表没有时段；如需彻底关闭定时请点击「清空灯内行程」。', 'err');
      return;
    }
    const sunriseMinutes = clampInt(Number(sunriseInput.value), 0, 300);
    const sunsetMinutes = clampInt(Number(sunsetInput.value), 0, 300);
    void runNetleaAndRefresh('schedule', {
      op: 'set',
      travelModel: draftTravelModel,
      sunriseMinutes,
      sunsetMinutes,
      trips: draftTrips,
    }, {
      pendingBanner: '正在向灯具写入并激活 24h 日出日落行程…',
      forceInputs: false,
      onSuccess: () => {
        markSchedDirty(false);
      },
    });
  }, lifecycleAc.signal);

  // Event wiring: Trip editor
  listenEvent(tripDaysEl, 'click', event => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-day]');
    if (!btn) return;
    const idx = clampInt(Number(btn.dataset.day), 0, 6);
    editorDays[idx] = editorDays[idx] ? 0 : 1;
    syncEditorDaysUi();
  }, lifecycleAc.signal);

  listenEvent(tripDayQuickEl, 'click', event => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-day-preset]');
    const preset = btn?.dataset.dayPreset;
    if (preset === 'all') editorDays = [1, 1, 1, 1, 1, 1, 1];
    else if (preset === 'workday') editorDays = [1, 1, 1, 1, 1, 0, 0];
    else if (preset === 'weekend') editorDays = [0, 0, 0, 0, 0, 1, 1];
    syncEditorDaysUi();
  }, lifecycleAc.signal);

  listenEvent(tripSpecModeEl, 'click', event => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-spec-mode]');
    const m = btn?.dataset.specMode as 'scene' | 'custom' | undefined;
    if (m) setEditorSpecMode(m);
  }, lifecycleAc.signal);

  listenEvent(tripSceneSelect, 'change', syncTripEditorPreview, lifecycleAc.signal);
  listenEvent(tripGearInput, 'input', scheduleTripEditorPreview, lifecycleAc.signal);
  for (const el of [tripR, tripG, tripW, tripB]) {
    listenEvent(el, 'input', scheduleTripEditorPreview, lifecycleAc.signal);
  }

  listenEvent(tripCancelBtn, 'click', () => {
    tripEditor.hidden = true;
    editingTripIndex = -1;
    safeFocus(tripNewBtn);
  }, lifecycleAc.signal);

  function saveTripFromEditor(): void {
    tripStartInput.setAttribute('aria-invalid', 'false');
    tripEndInput.setAttribute('aria-invalid', 'false');
    const start = parseHm(tripStartInput.value, 9, 0);
    const end = parseHm(tripEndInput.value, 18, 0);
    if (start.h === end.h && start.m === end.m) {
      tripEndInput.setAttribute('aria-invalid', 'true');
      setBanner('开始时间与结束时间不能相同。', 'err');
      safeFocus(tripEndInput);
      return;
    }
    if (!editorDays.some(Boolean)) {
      setBanner('请至少选择 1 个生效星期。', 'err');
      const firstDayBtn = tripDaysEl.querySelector<HTMLButtonElement>('button[data-day]');
      if (firstDayBtn) safeFocus(firstDayBtn);
      return;
    }
    let nextTrip: NetleaTrip;
    if (editorSpecMode === 'scene') {
      const modeCode = clampInt(Number(tripSceneSelect.value), 0, 11);
      const sc = findScene(modeCode);
      const gear = clampInt(Number(tripGearInput.value), 1, sc?.maxGear ?? 10);
      const gearObj = sc?.gears.find(g => g.gear === gear);
      nextTrip = {
        enable: tripEnabledInput.checked ? 1 : 0,
        dayList: [...editorDays],
        startH: start.h,
        startM: start.m,
        endH: end.h,
        endM: end.m,
        modeCode,
        gear,
        red: gearObj?.channels.red ?? 39,
        green: gearObj?.channels.green ?? 59,
        white: gearObj?.channels.white ?? 79,
        blue: gearObj?.channels.blue ?? 36,
        fan: 0,
        powerWatts: gearObj?.powerWatts ?? 18,
        name: sc?.name || '场景',
        seriesName: sc?.seriesName || '水草',
      };
    } else {
      const red = clampInt(Number(tripR.value), 0, 100);
      const green = clampInt(Number(tripG.value), 0, 100);
      const white = clampInt(Number(tripW.value), 0, 100);
      const blue = clampInt(Number(tripB.value), 0, 100);
      nextTrip = {
        enable: tripEnabledInput.checked ? 1 : 0,
        dayList: [...editorDays],
        startH: start.h,
        startM: start.m,
        endH: end.h,
        endM: end.m,
        modeCode: 12,
        gear: 0,
        red,
        green,
        white,
        blue,
        fan: 0,
        powerWatts: approxCustomWatts({ red, green, white, blue, fan: 0 }),
        name: '自定义',
        seriesName: '自定义',
      };
    }

    if (editingTripIndex === -1) {
      draftTrips.push(nextTrip);
    } else {
      draftTrips[editingTripIndex] = nextTrip;
    }
    draftTrips.sort((a, b) => (a.startH * 60 + a.startM) - (b.startH * 60 + b.startM));
    draftTravelModel = 0;
    tripEditor.hidden = true;
    editingTripIndex = -1;
    markSchedDirty(true);
    renderTripList();
    setBanner('已更新时段列表，请点击「🚀 保存并下发行程」写入灯具。', 'warn');
  }

  bindFormSubmission(tripEditor, tripApplyBtn, saveTripFromEditor, lifecycleAc.signal);

  // Event wiring: View 2 - Official Cultivation Presets
  const schedulePresetPreview = () => {
    if (presetDebounce) clearTimeout(presetDebounce);
    presetDebounce = setTimeout(() => {
      presetDebounce = null;
      void refreshCultivationPreview();
    }, 120);
  };

  for (const pill of cultivationPills.querySelectorAll<HTMLButtonElement>('button[data-cultivation-id]')) {
    pill.setAttribute('aria-pressed', String(pill.dataset.cultivationId === selectedPresetId));
  }

  listenEvent(cultivationPills, 'click', event => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-cultivation-id]');
    const pid = btn?.dataset.cultivationId;
    if (!pid) return;
    selectedPresetId = pid;
    for (const pill of cultivationPills.querySelectorAll<HTMLButtonElement>('button[data-cultivation-id]')) {
      const isSelected = pill === btn;
      pill.classList.toggle('active', isSelected);
      pill.setAttribute('aria-pressed', String(isSelected));
    }
    void refreshCultivationPreview();
  }, lifecycleAc.signal);

  for (const inp of [tankLInput, tankWInput, tankHInput, presetStartInput, presetFadeInput]) {
    listenEvent(inp, 'change', schedulePresetPreview, lifecycleAc.signal);
  }

  listenEvent(presetImportBtn, 'click', () => {
    void (async () => {
      if (presetDebounce !== null || !previewedSchedule) await refreshCultivationPreview();
      if (!previewedSchedule) return;
      draftTrips = previewedSchedule.trips.map(t => ({ ...t, dayList: [...t.dayList] }));
      draftSunrise = previewedSchedule.sunriseMinutes;
      draftSunset = previewedSchedule.sunsetMinutes;
      draftTravelModel = 1;
      sunriseInput.value = String(draftSunrise);
      sunsetInput.value = String(draftSunset);
      markSchedDirty(true);
      switchWorkspaceView('schedule');
      renderTripList();
      setBanner(`已导入「${previewedSchedule.presetName || selectedPresetId}」，可微调后点击「🚀 保存并下发行程」。`, 'warn');
    })();
  }, lifecycleAc.signal);

  function applyCultivationPreset(): void {
    const start = parseHm(presetStartInput.value, 9, 0);
    const fade = clampInt(Number(presetFadeInput.value), 0, 300);
    void runNetleaAndRefresh('schedule', {
      op: 'preset',
      preset: selectedPresetId,
      lengthCm: clampInt(Number(tankLInput.value), 10, 300),
      widthCm: clampInt(Number(tankWInput.value), 10, 200),
      heightCm: clampInt(Number(tankHInput.value), 10, 200),
      startHour: start.h,
      startMinute: start.m,
      sunriseMinutes: fade,
      sunsetMinutes: fade,
    }, {
      pendingBanner: '正在按缸体尺寸计算预设并写入灯具闪存…',
      forceInputs: false,
      onSuccess: () => {
        markSchedDirty(false);
        switchWorkspaceView('schedule');
      },
    });
  }

  bindFormSubmission(presetForm, presetApplyBtn, applyCultivationPreset, lifecycleAc.signal);

  // Event wiring: View 3 - Manual Workbench & Config
  listenEvent(sceneSeriesTabs, 'click', event => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-series]');
    const ser = btn?.dataset.series as '0' | '1' | '2' | 'custom' | undefined;
    if (!ser) return;
    selectedSeries = ser;
    manualPreviewDirty = true;
    renderSceneSeriesSubpills();
  }, lifecycleAc.signal);

  listenEvent(sceneGearInput, 'input', () => {
    selectedSceneGear = clampInt(Number(sceneGearInput.value), 1, Number(sceneGearInput.max) || 10);
    manualPreviewDirty = true;
    syncSceneGearReadout();
    scheduleSpectrumRedraw();
  }, lifecycleAc.signal);

  for (const input of [chRed, chGreen, chWhite, chBlue, chFan]) {
    listenEvent(input, 'input', () => {
      if (selectedSeries !== 'custom') {
        selectedSeries = 'custom';
        syncSceneSeriesHeaderUi();
      }
      manualPreviewDirty = true;
      syncChannelReadoutText(readCustomSliderChannels());
      scheduleSpectrumRedraw();
    }, lifecycleAc.signal);
  }

  listenEvent(saveSlotBtn, 'click', () => {
    if (busy || appState.authExpired || !appState.ready) return;
    const existing = lastPayload?.config.savedCustomPresets || [];
    if (existing.length >= 6) {
      setBanner('最多保存 6 个自定义光谱收藏槽，请先删除不需要的收藏。', 'err');
      return;
    }
    const ch = readCustomSliderChannels();
    const next = [...existing, { name: `方案 ${existing.length + 1}`, ...ch }];
    void runNetleaAndRefresh('config', { savedCustomPresets: next }, { forceInputs: false });
  }, lifecycleAc.signal);

  function buildSpectrumActionArgs(): Record<string, unknown> {
    if (selectedSeries !== 'custom') {
      return { modeCode: selectedSceneCode, gear: selectedSceneGear };
    }
    return { ...readCustomSliderChannels() };
  }

  listenEvent(applyTempBtn, 'click', () => {
    const durationMinutes = clampInt(Number(tempMinInput.value), 1, 300);
    void runNetleaAndRefresh('on', { ...buildSpectrumActionArgs(), durationMinutes }, {
      pendingBanner: `正在以当前光谱临时开灯（${durationMinutes} 分钟后恢复行程）…`,
    });
  }, lifecycleAc.signal);

  listenEvent(applyManualBtn, 'click', () => {
    void runNetleaAndRefresh('mode', { mode: 'manual', on: true, ...buildSpectrumActionArgs() }, {
      pendingBanner: '正在切换为手动恒亮模式（常亮不随定时变化）…',
    });
  }, lifecycleAc.signal);

  listenEvent(manualOffBtn, 'click', () => {
    void runNetleaAndRefresh('mode', { mode: 'manual', on: false }, {
      pendingBanner: '正在发送手动恒定关灯指令…',
    });
  }, lifecycleAc.signal);

  listenEvent(saveDefaultBtn, 'click', () => {
    const defaultChannels = readCustomSliderChannels();
    void runNetleaAndRefresh('config', { defaultChannels });
  }, lifecycleAc.signal);

  function saveTempConfig(): void {
    const onMinutes = clampInt(Number(cfgOnMinInput.value), 1, 300);
    const offMinutes = clampInt(Number(cfgOffMinInput.value), 1, 300);
    void runNetleaAndRefresh('mode', {
      mode: 'temp-config',
      onMinutes,
      offMinutes,
      ...buildSpectrumActionArgs(),
    }, {
      pendingBanner: '正在将默认临时开关灯分钟数写入灯具 (0x1A)…',
    });
  }

  bindFormSubmission(cfgTempForm, cfgTempSaveBtn, saveTempConfig, lifecycleAc.signal);

  function saveBindConfig(): void {
    const targetMac = cfgMacInput.value.trim();
    const namePrefix = cfgPrefixInput.value.trim() || 'SG-';
    void runNetleaAndRefresh('config', { targetMac, namePrefix });
  }

  bindFormSubmission(cfgForm, cfgSaveBtn, saveBindConfig, lifecycleAc.signal);

  function scheduleCanvasRedraws(): void {
    if (!active || !options.isVisible()) return;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      if (resizeRafId !== null) window.cancelAnimationFrame(resizeRafId);
      resizeRafId = window.requestAnimationFrame(() => {
        resizeRafId = null;
        if (!active || !options.isVisible()) return;
        redrawTimeline();
        refreshSpectrumPreview();
      });
    } else {
      redrawTimeline();
      refreshSpectrumPreview();
    }
  }

  function deactivate(): void {
    active = false;
    activeAc?.abort();
    activeAc = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      if (spectrumRafId !== null) {
        window.cancelAnimationFrame(spectrumRafId);
        spectrumRafId = null;
      }
      if (tripPreviewRafId !== null) {
        window.cancelAnimationFrame(tripPreviewRafId);
        tripPreviewRafId = null;
      }
      if (resizeRafId !== null) {
        window.cancelAnimationFrame(resizeRafId);
        resizeRafId = null;
      }
    }
    if (presetDebounce) {
      clearTimeout(presetDebounce);
      presetDebounce = null;
    }
    if (clearArmTimer) {
      clearTimeout(clearArmTimer);
      clearArmTimer = null;
    }
    clearArmed = false;
    schedClearBtn.classList.remove('is-armed');
    schedClearBtn.textContent = '🧹 清空灯内行程';
    // Preserve in-flight BLE busy lock so deactivate() cannot allow concurrent BLE writes
    setBusyState(busy);
  }

  return {
    activate() {
      if (disposed) return;
      active = true;
      ++badgeSeq;
      badgeAc?.abort();
      badgeAc = null;
      setBusyState(busy);

      activeAc?.abort();
      activeAc = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (typeof window !== 'undefined' && activeAc) {
        listenEvent(window, 'friday:themechange', () => {
          if (options.isVisible()) {
            redrawTimeline();
            refreshSpectrumPreview();
          }
        }, activeAc.signal);
      }

      resizeObserver?.disconnect();
      resizeObserver = null;
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          scheduleCanvasRedraws();
        });
        resizeObserver.observe(timelineCanvas.parentElement ?? timelineCanvas);
        resizeObserver.observe(spectrumCanvas.parentElement ?? spectrumCanvas);
      }

      if (!appState.authExpired && appState.ready) {
        void loadDashboard(false, false);
      }
    },
    deactivate,
    async refreshBadge() {
      if (disposed || active || appState.authExpired || !appState.ready) return;
      const seq = ++badgeSeq;
      badgeAc?.abort();
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      badgeAc = ac;
      try {
        const res = await api<NetleaPluginResponse<NetleaDashboardPayload>>('/api/plugin-run', {
          plugin: 'netlea',
          action: 'dashboard',
          args: {},
        }, {
          priority: 'low',
          ...(ac ? { signal: ac.signal } : {}),
        });
        if (disposed || active || seq !== badgeSeq || appState.authExpired) return;
        if (res.ok && res.data) {
          lastPayload = res.data;
          if (res.data.catalog) catalog = res.data.catalog;
          updateBadge(res.data);
        }
      } catch {
        // Ignore transient or aborted badge sync errors
      } finally {
        if (badgeAc === ac) badgeAc = null;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      deactivate();
      badgeAc?.abort();
      badgeAc = null;
      lifecycleAc.abort();
    },
  };
}

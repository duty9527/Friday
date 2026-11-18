import { button, element, isEditingWithin, kpiCard, node, svgNode } from '../shared/dom.js';
import { errorText, json, timestamp } from '../shared/format.js';
import { api, appState, hooks } from '../state.js';

export interface HealthScaleUiController {
  openModal: () => void;
  closeModal: () => void;
}

interface HealthProfile {
  id: string;
  name: string;
  sex: 'male' | 'female';
  age: number;
  heightCm: number;
  targetWeightKg: number | null;
  unit: 'kg' | 'jin';
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

interface HealthDevice {
  mac: string;
  address: string;
  name: string;
  rssi: number | null;
  battery: number | null;
  charging: boolean | null;
  protocolVer: number | null;
  deviceSubtype: number | null;
  model: string | null;
  hardwareVer: string | null;
  softwareVer: string | null;
  manufacturer: string | null;
  supportFuns: string[];
  rawAdv: Record<string, unknown> | null;
  lastSeenAt: number | null;
}

interface HealthMetricRange {
  min: number;
  max: number;
  scaleMin: number;
  scaleMax: number;
  unit: string;
}

interface HealthMetricItem {
  key: string;
  label: string;
  value: number;
  unit: string;
  secondaryText: string;
  status: 'low' | 'normal' | 'excellent' | 'high' | 'critical';
  statusLabel: string;
  range: HealthMetricRange;
}

interface HealthMetrics {
  weightKg: number;
  weightJin: number;
  weightLb: number;
  weightG: number;
  bmi: number;
  bmiCategory: string;
  bodyScore: number;
  bodyType: string;
  bodyAge: number;
  estimationMode: 'bia' | 'bmi_only';
  formulaModel: string;
  resistanceOhm: number | null;
  secondaryOhm: number | null;
  adcs: number[];
  impedances: number[];
  algType: number | null;
  bodyFatPercent: number;
  fatMassKg: number;
  fatFreeMassKg: number;
  leanPercent: number;
  musclePercent: number;
  muscleMassKg: number;
  skeletalMusclePercent: number;
  skeletalMuscleMassKg: number;
  waterPercent: number;
  waterMassKg: number;
  proteinPercent: number;
  proteinMassKg: number;
  bonePercent: number;
  boneMassKg: number;
  subcutaneousFatPercent: number;
  subcutaneousFatMassKg: number;
  visceralFatLevel: number;
  bmrKcal: number;
  tdeeKcal: number;
  standardWeightKg: number;
  weightDiffFromStandardKg: number;
  weightDiffFromTargetKg: number | null;
  weightControlKg: number;
  fatControlKg: number;
  muscleControlKg: number;
  items: HealthMetricItem[];
}

interface HealthRecord {
  id: string;
  profileId: string;
  measuredAt: number;
  source: 'live' | 'history' | 'manual' | string;
  deviceMac: string | null;
  weightKg: number;
  weightJin: number;
  weightLb: number;
  weightG: number;
  stable: boolean;
  impedanceMeasured: boolean;
  adcs: number[];
  impedances: number[];
  primaryOhm: number | null;
  secondaryOhm: number | null;
  algType: number | null;
  heartRate: number | null;
  battery: number | null;
  charging: boolean | null;
  rssi: number | null;
  calibrationMode: string | number | null;
  overWeight: boolean | number | null;
  dianji: string | number | null;
  rawMeta: Record<string, unknown>;
  note: string | null;
  createdAt: number;
  deltaFromPrevKg: number | null;
  metrics: HealthMetrics | null;
}

interface HealthLiveReadout {
  weightKg: number | null;
  weightJin: number | null;
  stable: boolean;
  impedanceMeasured: boolean;
  adcs: number[];
  impedances: number[];
  battery: number | null;
  charging: boolean | null;
  dianji: string | number | null;
  packetCount: number;
}

interface HealthLiveSession {
  sessionId: string;
  profileId: string;
  pid: number | null;
  phase: 'scanning' | 'connecting' | 'measuring' | 'completed' | 'stopped' | 'error' | 'timeout' | string;
  startedAt: number;
  updatedAt: number;
  message: string;
  error: string | null;
  device: HealthDevice | null;
  deviceInfo: Record<string, unknown>;
  liveReadout: HealthLiveReadout | null;
  historySyncedCount: number;
  ingestedIds: string[];
}

interface HealthDeltas {
  prevDiffKg: number | null;
  prevFatDiff: number | null;
  avg7dKg: number | null;
  avg30dKg: number | null;
  minWeightKg: number;
  maxWeightKg: number;
  targetDiffKg: number | null;
  totalCount: number;
}

interface HealthDashboardData {
  profiles: HealthProfile[];
  activeProfileId: string | null;
  activeProfile: HealthProfile | null;
  needsProfile?: boolean;
  device: HealthDevice | null;
  liveSession: HealthLiveSession | null;
  latest: HealthRecord | null;
  deltas: HealthDeltas | null;
  records: HealthRecord[];
}

interface HealthPluginResponse<T = unknown> {
  ok: boolean;
  plugin: string;
  action: string;
  notify: boolean;
  title?: string;
  message: string;
  data?: T;
}

interface HealthTrendPoint {
  x: number;
  y: number;
  value: number;
  unit: string;
  rec: HealthRecord;
}

type HealthTrendMetricKey = 'weight' | 'fat' | 'bmi' | 'muscle' | 'bmr' | 'impedance';
type HealthSourceFilterKey = 'all' | 'live' | 'history' | 'manual';

const HEALTH_ACTIVE_PHASES = new Set(['scanning', 'connecting', 'measuring']);

export function initHealthScaleUi(): HealthScaleUiController {
  const healthTopBadge = element<HTMLElement>('health-top-badge');
  const healthHubBackdrop = element<HTMLElement>('health-hub-backdrop');
  const healthModalClose = element<HTMLButtonElement>('health-modal-close');
  const healthProfileSelect = element<HTMLSelectElement>('health-profile-select');
  const healthUnitKg = element<HTMLButtonElement>('health-unit-kg');
  const healthUnitJin = element<HTMLButtonElement>('health-unit-jin');
  const healthRefreshBtn = element<HTMLButtonElement>('health-refresh-btn');
  const healthActionStatus = element<HTMLElement>('health-action-status');
  const healthLivePhase = element<HTMLElement>('health-live-phase');
  const healthLiveSource = element<HTMLElement>('health-live-source');
  const healthHeroWeight = element<HTMLElement>('health-hero-weight');
  const healthHeroMultiunit = element<HTMLElement>('health-hero-multiunit');
  const healthLiveMessage = element<HTMLElement>('health-live-message');
  const healthMeasureStartBtn = element<HTMLButtonElement>('health-measure-start-btn');
  const healthMeasureStopBtn = element<HTMLButtonElement>('health-measure-stop-btn');
  const healthScanBtn = element<HTMLButtonElement>('health-scan-btn');
  const healthScoreBadge = element<HTMLElement>('health-score-badge');
  const healthScoreRing = element<HTMLElement>('health-score-ring');
  const healthBodyType = element<HTMLElement>('health-body-type');
  const healthScoreMeta = element<HTMLElement>('health-score-meta');
  const healthFormulaMeta = element<HTMLElement>('health-formula-meta');
  const healthTargetSummary = element<HTMLElement>('health-target-summary');
  const healthDeviceSeen = element<HTMLElement>('health-device-seen');
  const healthDeviceTelemetry = element<HTMLElement>('health-device-telemetry');
  const healthKpiGrid = element<HTMLElement>('health-kpi-grid');
  const healthTrendMetrics = element<HTMLElement>('health-trend-metrics');
  const healthTrendRanges = element<HTMLElement>('health-trend-ranges');
  const healthTrendCanvas = element<HTMLCanvasElement>('health-trend-canvas');
  const healthTrendCaption = element<HTMLElement>('health-trend-caption');
  const healthInspectLabel = element<HTMLElement>('health-inspect-label');
  const healthInspectLatestBtn = element<HTMLButtonElement>('health-inspect-latest-btn');
  const healthBodytypeGrid = element<HTMLElement>('health-bodytype-grid');
  const healthMetricsGrid = element<HTMLElement>('health-metrics-grid');
  const healthRawGrid = element<HTMLElement>('health-raw-grid');
  const healthRawJson = element<HTMLElement>('health-raw-json');
  const healthProfileDetails = element<HTMLDetailsElement>('health-profile-details');
  const healthProfilesBar = element<HTMLElement>('health-profiles-bar');
  const healthProfileId = element<HTMLInputElement>('health-profile-id');
  const healthProfileName = element<HTMLInputElement>('health-profile-name');
  const healthProfileSex = element<HTMLSelectElement>('health-profile-sex');
  const healthProfileAge = element<HTMLInputElement>('health-profile-age');
  const healthProfileHeight = element<HTMLInputElement>('health-profile-height');
  const healthProfileTarget = element<HTMLInputElement>('health-profile-target');
  const healthProfileUnit = element<HTMLSelectElement>('health-profile-unit');
  const healthProfileDefault = element<HTMLInputElement>('health-profile-default');
  const healthProfileNewBtn = element<HTMLButtonElement>('health-profile-new-btn');
  const healthProfileSaveBtn = element<HTMLButtonElement>('health-profile-save-btn');
  const healthManualDetails = element<HTMLDetailsElement>('health-manual-details');
  const healthManualWeight = element<HTMLInputElement>('health-manual-weight');
  const healthManualUnit = element<HTMLSelectElement>('health-manual-unit');
  const healthManualImpedance = element<HTMLInputElement>('health-manual-impedance');
  const healthManualHr = element<HTMLInputElement>('health-manual-hr');
  const healthManualTime = element<HTMLInputElement>('health-manual-time');
  const healthManualNote = element<HTMLInputElement>('health-manual-note');
  const healthManualAddBtn = element<HTMLButtonElement>('health-manual-add-btn');
  const healthSourceFilters = element<HTMLElement>('health-source-filters');
  const healthRecordsSubtitle = element<HTMLElement>('health-records-subtitle');
  const healthRecordsList = element<HTMLElement>('health-records-list');

  const healthRecordDeleteArmed = new Map<string, number>();
  const healthProfileDeleteArmed = new Map<string, number>();

  let healthDashboard: HealthDashboardData | null = null;
  let healthUnit: 'kg' | 'jin' = 'kg';
  let healthUnitInitialized = false;
  let healthTrendMetric: HealthTrendMetricKey = 'weight';
  let healthTrendLimit = 30;
  let healthSourceFilter: HealthSourceFilterKey = 'all';
  let healthInspectedRecordId: string | null = null;
  let healthPollTimer: number | undefined;
  let healthBusy = false;
  let healthLastSessionPhase = '';
  let healthHoveredPointIdx: number | null = null;
  let healthPlottedPoints: HealthTrendPoint[] = [];

  function stopHealthMeasurePoll() {
    if (healthPollTimer !== undefined) {
      window.clearTimeout(healthPollTimer);
      healthPollTimer = undefined;
    }
  }

  function scheduleHealthMeasurePoll(delayMs = 850) {
    stopHealthMeasurePoll();
    if (healthHubBackdrop.hidden || appState.authExpired) return;
    healthPollTimer = window.setTimeout(() => {
      void pollHealthMeasureOnce();
    }, delayMs);
  }

  function setHealthActionStatus(text = '', tone: 'ok' | 'warn' | 'err' | '' = '') {
    if (!text) {
      healthActionStatus.textContent = '';
      healthActionStatus.className = 'health-status-banner';
      healthActionStatus.hidden = true;
      return;
    }
    healthActionStatus.textContent = text;
    healthActionStatus.className = `health-status-banner${tone ? ` tone-${tone}` : ''}`;
    healthActionStatus.hidden = false;
  }

  function formatWeightVal(weightKg: number, unit: 'kg' | 'jin' = healthUnit, digits = 2): string {
    const scaled = unit === 'jin' ? weightKg * 2 : weightKg;
    return scaled.toFixed(digits);
  }

  function formatWeightWithUnit(weightKg: number, unit: 'kg' | 'jin' = healthUnit, digits = 2): string {
    return `${formatWeightVal(weightKg, unit, digits)} ${unit === 'jin' ? '斤' : 'kg'}`;
  }

  function formatSignedDelta(deltaKg: number, unit: 'kg' | 'jin' = healthUnit, digits = 2): string {
    const scaled = unit === 'jin' ? deltaKg * 2 : deltaKg;
    const sign = scaled > 0 ? '+' : '';
    return `${sign}${scaled.toFixed(digits)} ${unit === 'jin' ? '斤' : 'kg'}`;
  }

  function healthSourceLabel(source: string): { text: string; cls: string } {
    if (source === 'live') return { text: '蓝牙实测', cls: 'badge-green' };
    if (source === 'history') return { text: '秤端缓存', cls: 'badge-teal' };
    if (source === 'manual') return { text: '手动补录', cls: 'badge-blue' };
    return { text: source || '记录', cls: 'badge-slate' };
  }

  function healthPhaseDisplay(phase?: string): { text: string; cls: string; active: boolean } {
    switch (phase) {
      case 'scanning': return { text: '扫描广播中…', cls: 'badge-blue', active: true };
      case 'connecting': return { text: '正在连接与同步参数…', cls: 'badge-blue', active: true };
      case 'measuring': return { text: '称重与生物电阻抗采集中…', cls: 'badge-amber', active: true };
      case 'completed': return { text: '测量已完成', cls: 'badge-green', active: false };
      case 'stopped': return { text: '已手动停止', cls: 'badge-slate', active: false };
      case 'timeout': return { text: '等待上秤超时', cls: 'badge-amber', active: false };
      case 'error': return { text: '蓝牙测量异常', cls: 'badge-amber', active: false };
      default: return { text: '待机中', cls: 'badge-slate', active: false };
    }
  }

  async function runHealthPlugin<T>(action: string, args: Record<string, unknown> = {}): Promise<HealthPluginResponse<T>> {
    return api<HealthPluginResponse<T>>('/api/plugin-run', {
      plugin: 'health-scale',
      action,
      args,
    });
  }

  function resetHealthProfileForm() {
    healthProfileId.value = '';
    healthProfileName.value = '';
    healthProfileSex.value = 'male';
    healthProfileAge.value = '';
    healthProfileHeight.value = '';
    healthProfileTarget.value = '';
    healthProfileUnit.value = healthUnit;
    healthProfileDefault.checked = healthDashboard ? healthDashboard.profiles.length === 0 : false;
  }

  function syncHealthProfileForm(profile: HealthProfile) {
    healthProfileId.value = profile.id;
    healthProfileName.value = profile.name;
    healthProfileSex.value = profile.sex;
    healthProfileAge.value = String(profile.age);
    healthProfileHeight.value = String(profile.heightCm);
    healthProfileTarget.value = profile.targetWeightKg !== null ? String(profile.targetWeightKg) : '';
    healthProfileUnit.value = profile.unit === 'jin' ? 'jin' : 'kg';
    healthProfileDefault.checked = Boolean(profile.isDefault);
  }

  function clearHealthProfileFormForNew() {
    resetHealthProfileForm();
    healthProfileDetails.open = true;
    healthProfileName.focus();
  }

  function renderHealthTopBadge() {
    const latest = healthDashboard?.latest;
    const session = healthDashboard?.liveSession;
    if (session && HEALTH_ACTIVE_PHASES.has(session.phase) && session.liveReadout?.weightKg) {
      healthTopBadge.textContent = formatWeightWithUnit(session.liveReadout.weightKg, healthUnit, 1);
      return;
    }
    if (!latest) {
      healthTopBadge.textContent = '—';
      return;
    }
    healthTopBadge.textContent = formatWeightWithUnit(latest.weightKg, healthUnit, 1);
  }

  function getInspectedHealthRecord(): HealthRecord | null {
    if (!healthDashboard) return null;
    if (healthInspectedRecordId) {
      const match = healthDashboard.records.find(r => r.id === healthInspectedRecordId);
      if (match) return match;
    }
    return healthDashboard.latest;
  }

  function applyHealthDashboard(data: HealthDashboardData) {
    healthDashboard = data;
    if (!healthUnitInitialized && data.activeProfile) {
      healthUnit = data.activeProfile.unit === 'jin' ? 'jin' : 'kg';
      healthUnitInitialized = true;
    }
    if (healthInspectedRecordId && !data.records.some(r => r.id === healthInspectedRecordId)) {
      healthInspectedRecordId = null;
    }
    if (!isEditingWithin(healthProfileDetails)) {
      if (data.activeProfile) {
        syncHealthProfileForm(data.activeProfile);
      } else {
        resetHealthProfileForm();
        healthProfileDetails.open = true;
      }
    }
    renderHealthTopBadge();
    if (!healthHubBackdrop.hidden) {
      renderHealthModal();
    }
  }

  let dashboardFetchSeq = 0;

  async function refreshHealthDashboard(options: { profileId?: string; quiet?: boolean } = {}) {
    const seq = ++dashboardFetchSeq;
    const targetProfileId = options.profileId ?? healthDashboard?.activeProfileId ?? undefined;
    const args: Record<string, unknown> = {};
    if (targetProfileId) args.profileId = targetProfileId;
    try {
      const res = await runHealthPlugin<HealthDashboardData>('dashboard', args);
      if (seq !== dashboardFetchSeq) return;
      if (!res.ok || !res.data) {
        if (!options.quiet) setHealthActionStatus(res.message || '读取健康看板失败', 'err');
        return;
      }
      applyHealthDashboard(res.data);
      const phase = res.data.liveSession?.phase || '';
      healthLastSessionPhase = phase;
      if (!healthHubBackdrop.hidden && HEALTH_ACTIVE_PHASES.has(phase)) {
        scheduleHealthMeasurePoll(750);
      }
    } catch (err) {
      if (seq !== dashboardFetchSeq) return;
      if (!options.quiet) setHealthActionStatus(`读取健康数据失败：${errorText(err)}`, 'err');
    }
  }

  async function pollHealthMeasureOnce() {
    if (healthHubBackdrop.hidden || appState.authExpired) return;
    const seq = ++dashboardFetchSeq;
    try {
      const args: Record<string, unknown> = {};
      if (healthDashboard?.activeProfileId) args.profileId = healthDashboard.activeProfileId;
      const res = await runHealthPlugin<{ session: HealthLiveSession | null; dashboard: HealthDashboardData }>('measure-status', args);
      if (seq !== dashboardFetchSeq) return;
      if (!res.ok || !res.data) {
        scheduleHealthMeasurePoll(1200);
        return;
      }
      const { session, dashboard } = res.data;
      const prevPhase = healthLastSessionPhase;
      const nextPhase = session?.phase || '';
      healthLastSessionPhase = nextPhase;
      applyHealthDashboard(dashboard);

      if (HEALTH_ACTIVE_PHASES.has(nextPhase)) {
        scheduleHealthMeasurePoll(800);
      } else {
        stopHealthMeasurePoll();
        if (HEALTH_ACTIVE_PHASES.has(prevPhase)) {
          if (nextPhase === 'completed') {
            healthInspectedRecordId = null;
            setHealthActionStatus(session?.message || '实测完成并已自动分析入库。', 'ok');
            renderHealthModal();
          } else if (nextPhase === 'error' || nextPhase === 'timeout') {
            setHealthActionStatus(session?.error || session?.message || '蓝牙测量未完成', 'warn');
          } else if (nextPhase === 'stopped') {
            setHealthActionStatus(session?.message || '已停止蓝牙测量', '');
          }
        }
      }
    } catch (err) {
      setHealthActionStatus(`轮询测量状态失败：${errorText(err)}`, 'warn');
      scheduleHealthMeasurePoll(1500);
    }
  }

  function renderHealthHeader() {
    if (!healthDashboard) return;
    if (document.activeElement !== healthProfileSelect) {
      const selectFrag = document.createDocumentFragment();
      if (healthDashboard.profiles.length === 0) {
        const emptyOpt = document.createElement('option');
        emptyOpt.value = '';
        emptyOpt.textContent = '尚未创建成员档案';
        emptyOpt.selected = true;
        selectFrag.append(emptyOpt);
      } else {
        for (const p of healthDashboard.profiles) {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = `${p.name}${p.isDefault ? ' (默认)' : ''} · ${p.sex === 'male' ? '男' : '女'} ${p.heightCm}cm/${p.age}岁`;
          opt.selected = p.id === healthDashboard.activeProfileId;
          selectFrag.append(opt);
        }
      }
      healthProfileSelect.replaceChildren(selectFrag);
    }
    healthUnitKg.classList.toggle('active', healthUnit === 'kg');
    healthUnitJin.classList.toggle('active', healthUnit === 'jin');
  }

  function renderHealthScoreRing(score: number | null, label: string) {
    const radius = 44;
    const circumference = 2 * Math.PI * radius;
    const clamped = score !== null ? Math.max(0, Math.min(100, score)) : 0;
    const dashOffset = circumference * (1 - clamped / 100);

    const svg = svgNode('svg', { viewBox: '0 0 112 112', class: 'health-score-svg', 'aria-hidden': 'true' });
    svg.append(
      svgNode('circle', { cx: '56', cy: '56', r: String(radius), class: 'health-ring-track' }),
      svgNode('circle', {
        cx: '56',
        cy: '56',
        r: String(radius),
        class: 'health-ring-progress',
        'stroke-dasharray': circumference.toFixed(1),
        'stroke-dashoffset': dashOffset.toFixed(1),
      }),
    );

    const center = node('div', '', 'health-score-center');
    center.append(
      node('strong', score !== null ? String(score) : '--', 'health-score-num'),
      node('span', label, 'health-score-sub'),
    );
    healthScoreRing.replaceChildren(svg, center);
  }

  function renderHealthHero(inspected: HealthRecord | null) {
    if (!healthDashboard) return;
    const session = healthDashboard.liveSession;
    const phaseInfo = healthPhaseDisplay(session?.phase);
    const liveKg = phaseInfo.active ? (session?.liveReadout?.weightKg ?? null) : null;
    const profile = healthDashboard.activeProfile;

    healthLivePhase.className = `hub-badge ${phaseInfo.cls}`;
    healthLivePhase.textContent = phaseInfo.text;
    healthMeasureStartBtn.disabled = healthBusy || phaseInfo.active || !profile;
    healthMeasureStartBtn.textContent = phaseInfo.active ? '⏳ 蓝牙采集中…' : '⚡ 开始上秤测量';
    healthMeasureStopBtn.hidden = !phaseInfo.active;
    healthScanBtn.disabled = healthBusy || phaseInfo.active;

    if (phaseInfo.active && session) {
      healthLiveSource.textContent = session.liveReadout
        ? `${session.liveReadout.packetCount} 帧 · ${session.liveReadout.stable ? '体重已锁定' : '称重波动中'}`
        : `开始于 ${timestamp(session.startedAt)}`;
      healthLiveMessage.textContent = session.message || '请赤脚站稳沃莱 A1 电极片，保持静止以测双频阻抗…';

      if (liveKg !== null && liveKg > 0) {
        const valueSpan = node('span', formatWeightVal(liveKg, healthUnit, 2), 'health-hero-num');
        const unitSpan = node('span', healthUnit === 'jin' ? '斤' : 'kg', 'health-hero-unit');
        healthHeroWeight.replaceChildren(valueSpan, unitSpan);
        healthHeroMultiunit.textContent = `${liveKg.toFixed(2)} kg · ${(liveKg * 2).toFixed(2)} 斤 · ${(liveKg * 2.20462).toFixed(2)} lb · ${Math.round(liveKg * 1000)} g${session.liveReadout?.impedanceMeasured ? ' · ✅ 双频阻抗已捕获' : ''}`;
      } else {
        healthHeroWeight.replaceChildren(node('span', '--', 'health-hero-num'), node('span', healthUnit === 'jin' ? '斤' : 'kg', 'health-hero-unit'));
        healthHeroMultiunit.textContent = '等待秤端广播稳定数值…';
      }
    } else if (inspected) {
      const srcInfo = healthSourceLabel(inspected.source);
      healthLiveSource.textContent = `${srcInfo.text} · ${timestamp(inspected.measuredAt)}`;
      healthLiveMessage.textContent = session?.error
        ? `上次测量：${session.error}`
        : session?.message && session.phase !== 'idle'
          ? session.message
          : '点击「开始上秤测量」并赤脚站上沃莱 A1，自动同步实测与秤端离线记录。';
      const valueSpan = node('span', formatWeightVal(inspected.weightKg, healthUnit, 2), 'health-hero-num');
      const unitSpan = node('span', healthUnit === 'jin' ? '斤' : 'kg', 'health-hero-unit');
      healthHeroWeight.replaceChildren(valueSpan, unitSpan);
      healthHeroMultiunit.textContent = `${inspected.weightKg.toFixed(2)} kg · ${inspected.weightJin.toFixed(2)} 斤 · ${inspected.weightLb.toFixed(2)} lb · ${inspected.weightG} g`;
    } else if (!profile) {
      healthLiveSource.textContent = '待建档';
      healthLiveMessage.textContent = '请先在下方「成员档案」填写您的昵称、性别、年龄和身高并保存，随后即可开始蓝牙测脂或手动记录。';
      healthHeroWeight.replaceChildren(node('span', '--', 'health-hero-num'), node('span', healthUnit === 'jin' ? '斤' : 'kg', 'health-hero-unit'));
      healthHeroMultiunit.textContent = '— kg · — 斤 · — lb · — g';
    } else {
      healthLiveSource.textContent = '尚无记录';
      healthLiveMessage.textContent = session?.message || '请点击「开始上秤测量」赤脚站上体脂秤，或通过下方「手动补录」录入一条体重数据。';
      healthHeroWeight.replaceChildren(node('span', '--', 'health-hero-num'), node('span', healthUnit === 'jin' ? '斤' : 'kg', 'health-hero-unit'));
      healthHeroMultiunit.textContent = '— kg · — 斤 · — lb · — g';
    }

    const m = inspected?.metrics;
    if (!profile) {
      renderHealthScoreRing(null, '身体得分');
      healthScoreBadge.className = 'hub-badge badge-amber';
      healthScoreBadge.textContent = '待建档';
      healthBodyType.textContent = '体型：尚未创建成员档案';
      healthScoreMeta.textContent = '请先在下方填写年龄、身高并保存成员档案';
      healthFormulaMeta.textContent = '算法模型：—';
      healthTargetSummary.textContent = '建档后自动测算 BMI、体脂率、肌肉量与身体得分';
      return;
    }

    if (!m) {
      renderHealthScoreRing(null, '身体得分');
      healthScoreBadge.className = 'hub-badge badge-slate';
      healthScoreBadge.textContent = '待测量';
      healthBodyType.textContent = '体型：—';
      healthScoreMeta.textContent = `成员：${profile.name} (${profile.sex === 'male' ? '男' : '女'} · ${profile.age} 岁 · ${profile.heightCm} cm)`;
      healthFormulaMeta.textContent = '算法模型：—';
      healthTargetSummary.textContent = profile.targetWeightKg
        ? `目标体重：${formatWeightWithUnit(profile.targetWeightKg, healthUnit, 1)}`
        : '目标体重：未设定（可在档案中设置）';
      return;
    }

    const scoreTone = m.bodyScore >= 85 ? 'badge-green' : m.bodyScore >= 70 ? 'badge-teal' : 'badge-amber';
    const scoreTitle = m.bodyScore >= 85 ? '优秀' : m.bodyScore >= 70 ? '良好' : '待改善';
    renderHealthScoreRing(m.bodyScore, '身体得分');
    healthScoreBadge.className = `hub-badge ${scoreTone}`;
    healthScoreBadge.textContent = `${scoreTitle} · ${m.bodyType}`;
    healthBodyType.textContent = `${m.bodyType} · BMI ${m.bmi} (${m.bmiCategory})`;
    healthScoreMeta.textContent = `身体年龄 ${m.bodyAge} 岁 (实际 ${profile.age} 岁) · 体脂 ${m.bodyFatPercent}% · 骨骼肌 ${m.skeletalMusclePercent}%`;
    healthFormulaMeta.textContent = m.resistanceOhm !== null
      ? `BIA 实测阻抗：${m.resistanceOhm} Ω${m.secondaryOhm !== null ? ` / ${m.secondaryOhm} Ω` : ''} (${m.formulaModel})`
      : `BMI 纯体重推算：${m.formulaModel}`;

    const stdText = `理想参考 ${formatWeightWithUnit(m.standardWeightKg, healthUnit, 1)}`;
    const targetText = profile.targetWeightKg && m.weightDiffFromTargetKg !== null
      ? `目标 ${formatWeightWithUnit(profile.targetWeightKg, healthUnit, 1)}（相差 ${formatSignedDelta(m.weightDiffFromTargetKg, healthUnit, 1)}）`
      : `脂肪建议 ${m.fatControlKg >= 0 ? '+' : ''}${m.fatControlKg.toFixed(1)} kg · 肌肉建议 +${m.muscleControlKg.toFixed(1)} kg`;
    healthTargetSummary.textContent = `${stdText} · ${targetText}`;
  }

  function renderHealthDeviceTelemetry() {
    const dev = healthDashboard?.device;
    if (!dev) {
      healthDeviceSeen.textContent = '未发现设备';
      healthDeviceTelemetry.replaceChildren(node('p', '尚未发现沃莱 A1 (AFU-WL-TZ-A1) 广播，请踩亮秤面后点击「扫描体脂秤」。', 'empty'));
      return;
    }
    healthDeviceSeen.textContent = dev.lastSeenAt ? `最近发现 ${timestamp(dev.lastSeenAt)}` : '已配对';

    const kvPairs: Array<[string, string]> = [
      ['设备名称', dev.name || 'AFU-WL-TZ-A1'],
      ['蓝牙 MAC', dev.mac],
      ['蓝牙地址', dev.address],
      ['信号强度 RSSI', dev.rssi !== null ? `${dev.rssi} dBm` : '--'],
      ['电池电量', dev.battery !== null ? `${dev.battery}%${dev.charging ? ' (充电中)' : ''}` : '--'],
      ['协议版本 / 子类型', `${dev.protocolVer ?? '--'} / subtype ${dev.deviceSubtype ?? '--'}`],
      ['厂商 / 型号', `${dev.manufacturer ?? '--'} · ${dev.model ?? '--'}`],
      ['硬件 / 固件版本', `HW ${dev.hardwareVer ?? '--'} · SW ${dev.softwareVer ?? '--'}`],
      ['秤端特性标志', dev.supportFuns?.length ? dev.supportFuns.join('、') : '标准 BIA 体脂称重'],
    ];
    const rawAdvPayload = dev.rawAdv && typeof dev.rawAdv.payloadHex === 'string'
      ? String(dev.rawAdv.payloadHex)
      : dev.rawAdv ? json(dev.rawAdv) : '';
    if (rawAdvPayload) {
      kvPairs.push(['广播载荷', rawAdvPayload]);
    }

    const frag = document.createDocumentFragment();
    for (const [k, v] of kvPairs) {
      const row = node('div', '', 'health-kv-row');
      row.append(node('span', k, 'health-kv-key'), node('span', v, 'health-kv-val'));
      frag.append(row);
    }
    healthDeviceTelemetry.replaceChildren(frag);
  }

  function renderHealthKpis() {
    if (!healthDashboard) {
      healthKpiGrid.replaceChildren();
      return;
    }
    const { latest, deltas, activeProfile } = healthDashboard;
    if (!activeProfile) {
      healthKpiGrid.replaceChildren(
        kpiCard('成员档案', '尚未创建', '请在下方填写昵称 / 年龄 / 身高后保存', 'warning'),
        kpiCard('历史记录数', '0 条', '建档后支持蓝牙实测与手动补录', 'default'),
      );
      return;
    }
    if (!latest || !latest.metrics || !deltas) {
      healthKpiGrid.replaceChildren(
        kpiCard('当前成员', activeProfile.name, `${activeProfile.sex === 'male' ? '男' : '女'} · ${activeProfile.age}岁 · ${activeProfile.heightCm}cm`, 'accent'),
        kpiCard('历史记录数', '0 条', '等待首次上秤或补录', 'default'),
      );
      return;
    }
    const m = latest.metrics;
    const diffStr = deltas.prevDiffKg !== null ? `较上次 ${formatSignedDelta(deltas.prevDiffKg, healthUnit, 2)}` : '首次记录';
    const fatDiffStr = deltas.prevFatDiff !== null
      ? `较上次 ${deltas.prevFatDiff > 0 ? '+' : ''}${deltas.prevFatDiff.toFixed(1)}% · 脂肪 ${m.fatMassKg} kg`
      : `脂肪重量 ${m.fatMassKg} kg`;
    const avg7Text = deltas.avg7dKg !== null ? formatWeightWithUnit(deltas.avg7dKg, healthUnit, 2) : '--';
    const avg30Text = deltas.avg30dKg !== null ? `30日均值 ${formatWeightWithUnit(deltas.avg30dKg, healthUnit, 2)}` : '30日均值 --';
    const rangeText = `${formatWeightVal(deltas.minWeightKg, healthUnit, 1)} ~ ${formatWeightWithUnit(deltas.maxWeightKg, healthUnit, 1)}`;
    const targetSub = deltas.targetDiffKg !== null
      ? `距目标 ${formatSignedDelta(deltas.targetDiffKg, healthUnit, 1)}`
      : `区间 ${rangeText}`;

    const frag = document.createDocumentFragment();
    frag.append(
      kpiCard('最新体重', formatWeightWithUnit(m.weightKg, healthUnit, 2), diffStr, 'accent'),
      kpiCard('体脂率', `${m.bodyFatPercent.toFixed(1)}%`, fatDiffStr, m.bodyFatPercent <= (activeProfile.sex === 'male' ? 20 : 28) ? 'positive' : 'warning'),
      kpiCard('BMI / 体型', `${m.bmi.toFixed(1)}`, `${m.bmiCategory} · ${m.bodyType}`, m.bmi >= 18.5 && m.bmi < 24 ? 'positive' : 'warning'),
      kpiCard('骨骼肌率', `${m.skeletalMusclePercent.toFixed(1)}%`, `骨骼肌 ${m.skeletalMuscleMassKg} kg · 总肌 ${m.muscleMassKg} kg`, 'positive'),
      kpiCard('7 日均重', avg7Text, avg30Text, 'default'),
      kpiCard('基础代谢 / 内脏脂肪', `${m.bmrKcal} kcal`, `TDEE ${m.tdeeKcal} kcal · 内脏脂肪 ${m.visceralFatLevel} 级`, m.visceralFatLevel <= 9 ? 'positive' : 'warning'),
      kpiCard(`累计记录 (${deltas.totalCount} 次)`, rangeText, targetSub, 'default'),
    );
    healthKpiGrid.replaceChildren(frag);
  }

  function renderHealthTrendControls() {
    for (const btn of healthTrendMetrics.querySelectorAll<HTMLButtonElement>('button[data-metric]')) {
      btn.classList.toggle('active', btn.dataset.metric === healthTrendMetric);
    }
    for (const btn of healthTrendRanges.querySelectorAll<HTMLButtonElement>('button[data-range]')) {
      btn.classList.toggle('active', Number(btn.dataset.range) === healthTrendLimit);
    }
  }

  function extractTrendValue(rec: HealthRecord, metric: HealthTrendMetricKey): { value: number; unit: string; label: string } | null {
    const m = rec.metrics;
    switch (metric) {
      case 'weight':
        return {
          value: healthUnit === 'jin' ? Number((rec.weightKg * 2).toFixed(2)) : rec.weightKg,
          unit: healthUnit === 'jin' ? '斤' : 'kg',
          label: '体重',
        };
      case 'fat':
        return m ? { value: m.bodyFatPercent, unit: '%', label: '体脂率' } : null;
      case 'bmi':
        return m ? { value: m.bmi, unit: '', label: 'BMI' } : null;
      case 'muscle':
        return m ? { value: m.skeletalMusclePercent, unit: '%', label: '骨骼肌率' } : null;
      case 'bmr':
        return m ? { value: m.bmrKcal, unit: 'kcal', label: '基础代谢' } : null;
      case 'impedance': {
        const imp = rec.primaryOhm ?? m?.resistanceOhm ?? null;
        return imp !== null && imp > 0 ? { value: imp, unit: 'Ω', label: '生物电阻抗' } : null;
      }
    }
  }

  function renderHealthTrendChart() {
    const canvas = healthTrendCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(320, Math.round(rect.width || canvas.width || 900));
    const cssH = Math.max(180, Math.round(rect.height || canvas.height || 220));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const rawRecords = (healthDashboard?.records ?? []).slice(0, healthTrendLimit).slice().reverse();
    const series: Array<{ rec: HealthRecord; value: number; unit: string; label: string }> = [];
    for (const r of rawRecords) {
      const ext = extractTrendValue(r, healthTrendMetric);
      if (ext) series.push({ rec: r, ...ext });
    }
    healthPlottedPoints = [];

    if (series.length === 0) {
      ctx.fillStyle = '#8b949e';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无该指标的历史趋势数据，完成测量或补录后自动绘制', cssW / 2, cssH / 2);
      healthTrendCaption.textContent = '暂无可用数据点。';
      return;
    }

    const firstSeries = series[0];
    if (!firstSeries) return;
    const unitLabel = firstSeries.unit;
    const metricLabel = firstSeries.label;

    const values = series.map(s => s.value);
    const activeTargetKg = healthDashboard?.activeProfile?.targetWeightKg ?? null;
    const targetVal = healthTrendMetric === 'weight' && activeTargetKg
      ? (healthUnit === 'jin' ? activeTargetKg * 2 : activeTargetKg)
      : null;
    if (targetVal !== null) values.push(targetVal);

    let minV = Math.min(...values);
    let maxV = Math.max(...values);
    const span = Math.max(maxV - minV, healthTrendMetric === 'bmr' ? 40 : 1.0);
    minV -= span * 0.14;
    maxV += span * 0.14;
    const vRange = Math.max(0.01, maxV - minV);

    const padL = 52;
    const padR = 20;
    const padT = 22;
    const padB = 34;
    const plotW = Math.max(60, cssW - padL - padR);
    const plotH = Math.max(60, cssH - padT - padB);

    const yOf = (val: number) => padT + plotH * (1 - (val - minV) / vRange);
    const xOf = (idx: number) => series.length === 1
      ? padL + plotW / 2
      : padL + (idx / (series.length - 1)) * plotW;

    ctx.lineWidth = 1;
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const val = minV + (vRange * (gridSteps - i)) / gridSteps;
      const y = padT + (plotH * i) / gridSteps;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(cssW - padR, y);
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      const valStr = healthTrendMetric === 'bmr' || healthTrendMetric === 'impedance'
        ? Math.round(val).toString()
        : val.toFixed(1);
      ctx.fillText(valStr, padL - 8, y + 4);
    }

    if (targetVal !== null) {
      const ty = yOf(targetVal);
      ctx.save();
      ctx.strokeStyle = 'rgba(34, 197, 94, 0.72)';
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, ty);
      ctx.lineTo(cssW - padR, ty);
      ctx.stroke();
      ctx.fillStyle = '#4ade80';
      ctx.textAlign = 'left';
      ctx.fillText(`目标 ${targetVal.toFixed(1)} ${unitLabel}`, padL + 6, Math.max(padT + 12, ty - 5));
      ctx.restore();
    }

    const pts: HealthTrendPoint[] = series.map((s, idx) => ({
      x: xOf(idx),
      y: yOf(s.value),
      value: s.value,
      unit: s.unit,
      rec: s.rec,
    }));
    healthPlottedPoints = pts;

    if (pts.length > 1) {
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, 'rgba(56, 189, 248, 0.30)');
      grad.addColorStop(1, 'rgba(56, 189, 248, 0.01)');
      ctx.beginPath();
      const firstPt = pts[0];
      const lastPt = pts[pts.length - 1];
      if (firstPt && lastPt) {
        ctx.moveTo(firstPt.x, padT + plotH);
        for (const p of pts) ctx.lineTo(p.x, p.y);
        ctx.lineTo(lastPt.x, padT + plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(firstPt.x, firstPt.y);
        for (let i = 1; i < pts.length; i++) {
          const p = pts[i];
          if (p) ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2.4;
        ctx.stroke();
      }
    }

    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    const tickCount = Math.min(pts.length, 5);
    for (let t = 0; t < tickCount; t++) {
      const idx = tickCount === 1 ? 0 : Math.round((t * (pts.length - 1)) / (tickCount - 1));
      const p = pts[idx];
      if (!p) continue;
      const d = new Date(p.rec.measuredAt);
      const label = `${d.getMonth() + 1}/${d.getDate()}`;
      ctx.fillText(label, p.x, cssH - 10);
    }

    const activeHoverIdx = healthHoveredPointIdx !== null && healthHoveredPointIdx < pts.length
      ? healthHoveredPointIdx
      : pts.length - 1;

    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p) continue;
      const isSelected = healthInspectedRecordId === p.rec.id;
      const isActive = i === activeHoverIdx || isSelected;
      if (isActive) {
        ctx.save();
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(p.x, padT);
        ctx.lineTo(p.x, padT + plotH);
        ctx.stroke();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, isActive ? 5.2 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? '#fbbf24' : i === activeHoverIdx ? '#7dd3fc' : '#38bdf8';
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    const focusPt = pts[activeHoverIdx] ?? pts[pts.length - 1];
    const minSeries = Math.min(...series.map(s => s.value));
    const maxSeries = Math.max(...series.map(s => s.value));
    const fmt = (v: number) => healthTrendMetric === 'bmr' || healthTrendMetric === 'impedance' ? Math.round(v).toString() : v.toFixed(2);
    if (focusPt) {
      healthTrendCaption.textContent = `${metricLabel}（共 ${series.length} 点 · 最低 ${fmt(minSeries)} / 最高 ${fmt(maxSeries)} ${unitLabel}）｜ 焦点：${timestamp(focusPt.rec.measuredAt)} → ${fmt(focusPt.value)} ${unitLabel}（点击数据点可定位明细）`;
    }
  }

  function renderHealthBodyTypeMatrix(inspected: HealthRecord | null) {
    const m = inspected?.metrics;
    const profile = healthDashboard?.activeProfile;
    const cells: Array<{ bmiBucket: number; fatBucket: number; label: string; hint: string }> = [
      { bmiBucket: 0, fatBucket: 2, label: '隐性肥胖型', hint: 'BMI偏轻 · 体脂偏高' },
      { bmiBucket: 1, fatBucket: 2, label: '微胖型', hint: 'BMI标准 · 体脂偏高' },
      { bmiBucket: 2, fatBucket: 2, label: '肥胖型', hint: 'BMI超标 · 体脂偏高' },
      { bmiBucket: 0, fatBucket: 1, label: '偏瘦型', hint: 'BMI偏轻 · 体脂标准' },
      { bmiBucket: 1, fatBucket: 1, label: '标准型', hint: 'BMI标准 · 体脂标准' },
      { bmiBucket: 2, fatBucket: 1, label: '偏壮标准型', hint: 'BMI偏高 · 体脂标准' },
      { bmiBucket: 0, fatBucket: 0, label: '瘦弱偏瘦型', hint: 'BMI偏轻 · 体脂偏低' },
      { bmiBucket: 1, fatBucket: 0, label: '偏瘦肌肉型', hint: 'BMI标准 · 体脂偏低' },
      { bmiBucket: 2, fatBucket: 0, label: '运动健美型', hint: 'BMI偏高 · 低体脂' },
    ];

    let activeBmiBucket = -1;
    let activeFatBucket = -1;
    if (m && profile) {
      const male = profile.sex !== 'female';
      activeBmiBucket = m.bmi < 18.5 ? 0 : m.bmi < 24.0 ? 1 : 2;
      const fatLow = male ? 11.0 : 18.0;
      const fatHigh = male ? 20.0 : 28.0;
      activeFatBucket = m.bodyFatPercent < fatLow ? 0 : m.bodyFatPercent <= fatHigh ? 1 : 2;
    }

    const frag = document.createDocumentFragment();
    for (const cell of cells) {
      const isActive = cell.bmiBucket === activeBmiBucket && cell.fatBucket === activeFatBucket;
      const card = node('div', '', `health-bodytype-cell${isActive ? ' active' : ''}`);
      const displayLabel = isActive && m?.bodyType ? `${m.bodyType} ★` : cell.label;
      card.append(node('strong', displayLabel), node('span', cell.hint, 'meta'));
      frag.append(card);
    }
    healthBodytypeGrid.replaceChildren(frag);
  }

  function createHealthRangeSvg(item: HealthMetricItem): SVGSVGElement {
    const { min, max, scaleMin, scaleMax } = item.range;
    const span = Math.max(0.01, scaleMax - scaleMin);
    const toX = (val: number) => Math.max(6, Math.min(214, 6 + ((val - scaleMin) / span) * 208));

    const xMin = toX(min);
    const xMax = toX(max);
    const valX = toX(item.value);

    const svg = svgNode('svg', { viewBox: '0 0 220 18', class: 'health-range-svg', 'aria-hidden': 'true' });
    svg.append(
      svgNode('rect', { x: '6', y: '7', width: '208', height: '4', rx: '2', class: 'health-bar-track' }),
      svgNode('rect', { x: xMin.toFixed(1), y: '6', width: Math.max(4, xMax - xMin).toFixed(1), height: '6', rx: '3', class: 'health-bar-ideal' }),
      svgNode('circle', { cx: valX.toFixed(1), cy: '9', r: '4.5', class: `health-bar-dot dot-${item.status}` }),
    );
    return svg;
  }

  function renderHealthMetricsGrid(inspected: HealthRecord | null) {
    const isViewingOld = Boolean(healthInspectedRecordId && healthDashboard?.latest && healthInspectedRecordId !== healthDashboard.latest.id);
    healthInspectLatestBtn.hidden = !isViewingOld;
    if (inspected) {
      const srcInfo = healthSourceLabel(inspected.source);
      healthInspectLabel.textContent = isViewingOld
        ? `正在检视历史记录：${timestamp(inspected.measuredAt)} (${srcInfo.text})`
        : `当前显示最新记录：${timestamp(inspected.measuredAt)} (${srcInfo.text})`;
    } else {
      healthInspectLabel.textContent = '当前显示：暂无测量记录';
    }

    const items = inspected?.metrics?.items ?? [];
    if (items.length === 0) {
      healthMetricsGrid.replaceChildren(node('p', '完成一次测量或补录后，将在此展示全部 16+ 项人体成分、代谢评级与正常参考区间。', 'empty'));
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of items) {
      const card = node('div', '', `health-metric-card rating-${item.status}`);
      const head = node('div', '', 'health-metric-head');
      head.append(
        node('span', item.label, 'health-metric-label'),
        node('span', item.statusLabel, `hub-badge rating-badge-${item.status}`),
      );

      const valRow = node('div', '', 'health-metric-val-row');
      let shownValue = String(item.value);
      let shownUnit = item.unit;
      if ((item.key === 'weight' || item.key === 'standardWeight') && healthUnit === 'jin' && item.unit === 'kg') {
        shownValue = (item.value * 2).toFixed(2);
        shownUnit = '斤';
      }
      valRow.append(
        node('strong', shownValue, 'health-metric-value'),
        node('span', shownUnit, 'health-metric-unit'),
      );

      const rangeMin = (item.key === 'weight' || item.key === 'standardWeight') && healthUnit === 'jin' ? (item.range.min * 2).toFixed(1) : String(item.range.min);
      const rangeMax = (item.key === 'weight' || item.key === 'standardWeight') && healthUnit === 'jin' ? (item.range.max * 2).toFixed(1) : String(item.range.max);
      const rangeUnit = (item.key === 'weight' || item.key === 'standardWeight') && healthUnit === 'jin' ? '斤' : item.range.unit;
      const footer = node('div', '', 'health-metric-foot');
      footer.append(
        node('span', item.secondaryText, 'hint'),
        node('span', `参考 ${rangeMin}~${rangeMax}${rangeUnit}`, 'meta'),
      );

      card.append(head, valRow, createHealthRangeSvg(item), footer);
      frag.append(card);
    }
    healthMetricsGrid.replaceChildren(frag);
  }

  function renderHealthRawTelemetry(inspected: HealthRecord | null) {
    if (!inspected) {
      healthRawGrid.replaceChildren(node('p', '暂无单次记录原始遥测帧。', 'empty'));
      healthRawJson.textContent = json({ device: healthDashboard?.device ?? null, liveSession: healthDashboard?.liveSession ?? null });
      return;
    }

    const m = inspected.metrics;
    const cells: Array<[string, string]> = [
      ['测量 ID', inspected.id],
      ['精确时间戳', `${timestamp(inspected.measuredAt)} (${inspected.measuredAt})`],
      ['数据来源 / 稳定位', `${healthSourceLabel(inspected.source).text} · ${inspected.stable ? '已锁定' : '未锁定'}`],
      ['四单位换算', `${inspected.weightKg} kg / ${inspected.weightJin} 斤 / ${inspected.weightLb} lb / ${inspected.weightG} g`],
      ['生物电阻抗测量', inspected.impedanceMeasured ? `已测 (${inspected.primaryOhm ?? '--'} Ω${inspected.secondaryOhm !== null ? ` / ${inspected.secondaryOhm} Ω` : ''})` : '未测到人体阻抗 (仅 BMI 推算)'],
      ['全频率阻抗数组 (Ω)', inspected.impedances.length ? inspected.impedances.join(' · ') : '—'],
      ['原始 ADC 数组', inspected.adcs.length ? inspected.adcs.join(' · ') : '—'],
      ['计算模型 / algType', `${m?.formulaModel ?? '--'} · algType=${inspected.algType ?? '--'}`],
      ['脂肪量 / 去脂体重', m ? `${m.fatMassKg} kg / ${m.fatFreeMassKg} kg (去脂 ${m.leanPercent}%)` : '--'],
      ['肌肉控制 / 体重控制', m ? `肌肉建议 +${m.muscleControlKg} kg · 体重建议 ${m.weightControlKg >= 0 ? '+' : ''}${m.weightControlKg} kg` : '--'],
      ['称重时电量 / 信号', `电量 ${inspected.battery !== null ? `${inspected.battery}%` : '--'}${inspected.charging ? ' (充电中)' : ''} · RSSI ${inspected.rssi !== null ? `${inspected.rssi} dBm` : '--'}`],
      ['电极 / 校准 / 超重 / 心率', `电极=${inspected.dianji ?? '--'} · 校准=${inspected.calibrationMode ?? '--'} · 超重=${inspected.overWeight ?? '--'} · 心率=${inspected.heartRate ?? '--'} bpm`],
    ];

    const frag = document.createDocumentFragment();
    for (const [k, v] of cells) {
      const cell = node('div', '', 'health-raw-cell');
      cell.append(node('span', k, 'meta'), node('strong', v));
      frag.append(cell);
    }
    healthRawGrid.replaceChildren(frag);
    healthRawJson.textContent = json({
      record: { ...inspected, metrics: undefined },
      device: healthDashboard?.device ?? null,
      liveSession: healthDashboard?.liveSession ?? null,
    });
  }

  function renderHealthProfilesBar() {
    if (!healthDashboard) return;
    if (healthDashboard.profiles.length === 0) {
      healthProfilesBar.replaceChildren(node('p', '暂无成员档案，请在下方表单保存您的首位成员。', 'empty'));
      return;
    }
    const now = Date.now();
    const frag = document.createDocumentFragment();
    for (const p of healthDashboard.profiles) {
      const chip = node('div', '', `health-profile-chip${p.id === healthDashboard.activeProfileId ? ' active' : ''}`);
      const selectBtn = button(
        `${p.name}${p.isDefault ? ' ★默认' : ''} (${p.sex === 'male' ? '男' : '女'} ${p.heightCm}cm ${p.age}岁)`,
        () => {
          healthInspectedRecordId = null;
          void refreshHealthDashboard({ profileId: p.id });
        },
        'mini-button',
      );
      chip.append(selectBtn);

      if (!p.isDefault && healthDashboard.profiles.length > 1) {
        const armedAt = healthProfileDeleteArmed.get(p.id) ?? 0;
        const isArmed = now - armedAt < 5000;
        const delBtn = button(isArmed ? '确认删成员' : '删除', () => {
          if (!isArmed) {
            healthProfileDeleteArmed.set(p.id, Date.now());
            renderHealthProfilesBar();
            return;
          }
          healthProfileDeleteArmed.delete(p.id);
          void deleteHealthProfileFromUi(p.id);
        }, 'mini-button danger-btn');
        chip.append(delBtn);
      }
      frag.append(chip);
    }
    healthProfilesBar.replaceChildren(frag);
  }

  function renderHealthRecordsList() {
    for (const btn of healthSourceFilters.querySelectorAll<HTMLButtonElement>('button[data-source]')) {
      btn.classList.toggle('active', btn.dataset.source === healthSourceFilter);
    }
    const all = healthDashboard?.records ?? [];
    const filtered = healthSourceFilter === 'all' ? all : all.filter(r => r.source === healthSourceFilter);
    healthRecordsSubtitle.textContent = `共 ${filtered.length} 条记录（总 ${all.length} 条）· 点击任意一条查看其全量成分分析与原始数据`;

    if (filtered.length === 0) {
      healthRecordsList.replaceChildren(node('p', '当前筛选条件下暂无测量记录。', 'empty'));
      return;
    }

    const now = Date.now();
    const frag = document.createDocumentFragment();
    for (const rec of filtered) {
      const activeId = healthInspectedRecordId || healthDashboard?.latest?.id || '';
      const isSelected = rec.id === activeId;
      const srcInfo = healthSourceLabel(rec.source);
      const m = rec.metrics;
      const row = node('div', '', `health-record-row${isSelected ? ' selected' : ''}`);
      row.addEventListener('click', () => {
        healthInspectedRecordId = rec.id;
        renderHealthModal();
      });

      const mainCol = node('div', '', 'health-record-main');
      const titleRow = node('div', '', 'health-record-title');
      titleRow.append(
        node('strong', formatWeightWithUnit(rec.weightKg, healthUnit, 2), 'health-record-weight'),
        node('span', srcInfo.text, `hub-badge ${srcInfo.cls}`),
      );
      if (rec.deltaFromPrevKg !== null) {
        const diffCls = rec.deltaFromPrevKg <= 0 ? 'badge-green' : 'badge-amber';
        titleRow.append(node('span', formatSignedDelta(rec.deltaFromPrevKg, healthUnit, 2), `hub-badge ${diffCls}`));
      }
      if (rec.primaryOhm !== null) {
        titleRow.append(node('span', `BIA ${rec.primaryOhm} Ω`, 'hub-badge badge-teal'));
      }
      titleRow.append(node('span', timestamp(rec.measuredAt), 'meta'));

      const subText = m
        ? `BMI ${m.bmi} (${m.bmiCategory}) · 体脂 ${m.bodyFatPercent}% · 骨骼肌 ${m.skeletalMusclePercent}% · 水分 ${m.waterPercent}% · 内脏脂肪 ${m.visceralFatLevel} 级 · 评分 ${m.bodyScore}${rec.note ? ` · ${rec.note}` : ''}`
        : (rec.note || '无扩展成分');
      mainCol.append(titleRow, node('div', subText, 'hint'));

      const actionsCol = node('div', '', 'health-record-actions');
      const armedAt = healthRecordDeleteArmed.get(rec.id) ?? 0;
      const isArmed = now - armedAt < 5000;
      const delBtn = button(isArmed ? '确认删除' : '删除', () => {
        if (!isArmed) {
          healthRecordDeleteArmed.set(rec.id, Date.now());
          renderHealthRecordsList();
          return;
        }
        healthRecordDeleteArmed.delete(rec.id);
        void deleteHealthRecordFromUi(rec.id);
      }, 'mini-button danger-btn');
      delBtn.addEventListener('click', e => e.stopPropagation());
      actionsCol.append(delBtn);

      row.append(mainCol, actionsCol);
      frag.append(row);
    }
    healthRecordsList.replaceChildren(frag);
  }

  function renderHealthModal() {
    if (!healthDashboard) return;
    const inspected = getInspectedHealthRecord();
    renderHealthHeader();
    renderHealthHero(inspected);
    renderHealthDeviceTelemetry();
    renderHealthKpis();
    renderHealthTrendControls();
    renderHealthTrendChart();
    renderHealthBodyTypeMatrix(inspected);
    renderHealthMetricsGrid(inspected);
    renderHealthRawTelemetry(inspected);
    renderHealthProfilesBar();
    renderHealthRecordsList();
  }

  async function startHealthMeasureFromUi() {
    if (healthBusy) return;
    if (!healthDashboard?.activeProfile) {
      setHealthActionStatus('请先创建并保存成员档案（性别 / 年龄 / 身高），再启动蓝牙测量。', 'warn');
      healthProfileDetails.open = true;
      healthProfileName.focus();
      return;
    }
    healthBusy = true;
    healthMeasureStartBtn.disabled = true;
    setHealthActionStatus('正在唤醒蓝牙适配器和沃莱 A1，请赤脚站上体脂秤…', '');
    try {
      const args: Record<string, unknown> = { timeoutSec: 45 };
      if (healthDashboard.activeProfileId) args.profileId = healthDashboard.activeProfileId;
      if (healthDashboard.device?.mac) args.targetMac = healthDashboard.device.mac;
      const res = await runHealthPlugin<{ session: HealthLiveSession }>('measure-start', args);
      if (!res.ok) {
        setHealthActionStatus(res.message || '启动蓝牙测量失败', 'err');
        return;
      }
      if (res.data?.session && healthDashboard) {
        healthDashboard = { ...healthDashboard, liveSession: res.data.session };
        healthLastSessionPhase = res.data.session.phase;
        renderHealthHero(getInspectedHealthRecord());
      }
      setHealthActionStatus(res.message || '已启动实时测量，请赤脚上秤并保持静止。', 'ok');
      scheduleHealthMeasurePoll(650);
    } catch (err) {
      setHealthActionStatus(`启动上秤测量失败：${errorText(err)}`, 'err');
    } finally {
      healthBusy = false;
      renderHealthHero(getInspectedHealthRecord());
    }
  }

  async function stopHealthMeasureFromUi() {
    stopHealthMeasurePoll();
    healthMeasureStopBtn.disabled = true;
    try {
      const args: Record<string, unknown> = {};
      if (healthDashboard?.activeProfileId) args.profileId = healthDashboard.activeProfileId;
      const res = await runHealthPlugin<{ session: HealthLiveSession | null }>('measure-stop', args);
      if (healthDashboard && res.data) {
        healthDashboard = { ...healthDashboard, liveSession: res.data.session };
      }
      setHealthActionStatus(res.message || '已停止当前测量会话', '');
      await refreshHealthDashboard();
    } catch (err) {
      setHealthActionStatus(`停止测量失败：${errorText(err)}`, 'err');
    } finally {
      healthMeasureStopBtn.disabled = false;
    }
  }

  async function scanHealthScaleFromUi() {
    if (healthBusy) return;
    healthBusy = true;
    healthScanBtn.disabled = true;
    healthScanBtn.textContent = '📡 扫描中…';
    setHealthActionStatus('正在通过 BlueZ 扫描附近沃莱 A1 (AFU-WL*) 体脂秤…', '');
    try {
      const res = await runHealthPlugin<{ device: HealthDevice | null; cached?: boolean }>('scan', { timeoutSec: 4 });
      setHealthActionStatus(res.message, res.ok && res.data?.device ? 'ok' : 'warn');
      await refreshHealthDashboard({ quiet: true });
    } catch (err) {
      setHealthActionStatus(`蓝牙扫描失败：${errorText(err)}`, 'err');
    } finally {
      healthBusy = false;
      healthScanBtn.disabled = false;
      healthScanBtn.textContent = '📡 扫描体脂秤';
    }
  }

  async function saveHealthProfileFromUi() {
    const name = healthProfileName.value.trim();
    if (!name) {
      setHealthActionStatus('请填写成员昵称', 'warn');
      healthProfileName.focus();
      return;
    }
    const age = Number(healthProfileAge.value.trim());
    if (!Number.isFinite(age) || age < 5 || age > 120) {
      setHealthActionStatus('请填写有效年龄（5 ~ 120 岁）', 'warn');
      healthProfileAge.focus();
      return;
    }
    const heightCm = Number(healthProfileHeight.value.trim());
    if (!Number.isFinite(heightCm) || heightCm < 80 || heightCm > 230) {
      setHealthActionStatus('请填写有效身高（80 ~ 230 cm）', 'warn');
      healthProfileHeight.focus();
      return;
    }
    const targetRaw = healthProfileTarget.value.trim();
    const targetWeightKg = targetRaw === '' ? null : Number(targetRaw);
    if (targetWeightKg !== null && (!Number.isFinite(targetWeightKg) || targetWeightKg < 20 || targetWeightKg > 250)) {
      setHealthActionStatus('目标体重需在 20 ~ 250 kg 之间', 'warn');
      healthProfileTarget.focus();
      return;
    }

    healthProfileSaveBtn.disabled = true;
    try {
      const args: Record<string, unknown> = {
        name,
        sex: healthProfileSex.value === 'female' ? 'female' : 'male',
        age,
        heightCm,
        targetWeightKg,
        unit: healthProfileUnit.value === 'jin' ? 'jin' : 'kg',
        setDefault: healthProfileDefault.checked,
      };
      const editId = healthProfileId.value.trim();
      if (editId) args.id = editId;
      const res = await runHealthPlugin<HealthDashboardData>('profile-save', args);
      if (!res.ok || !res.data) {
        setHealthActionStatus(res.message || '保存档案失败', 'err');
        return;
      }
      healthUnit = res.data.activeProfile?.unit === 'jin' ? 'jin' : 'kg';
      if (res.data.activeProfile) syncHealthProfileForm(res.data.activeProfile);
      applyHealthDashboard(res.data);
      setHealthActionStatus(res.message, 'ok');
    } catch (err) {
      setHealthActionStatus(`保存档案失败：${errorText(err)}`, 'err');
    } finally {
      healthProfileSaveBtn.disabled = false;
    }
  }

  async function deleteHealthProfileFromUi(id: string) {
    try {
      const res = await runHealthPlugin<HealthDashboardData>('profile-delete', { id });
      if (!res.ok || !res.data) {
        setHealthActionStatus(res.message || '删除成员档案失败', 'err');
        return;
      }
      healthInspectedRecordId = null;
      if (res.data.activeProfile) syncHealthProfileForm(res.data.activeProfile);
      else resetHealthProfileForm();
      applyHealthDashboard(res.data);
      setHealthActionStatus(res.message, 'ok');
    } catch (err) {
      setHealthActionStatus(`删除成员档案失败：${errorText(err)}`, 'err');
    }
  }

  async function addManualHealthRecordFromUi() {
    if (!healthDashboard?.activeProfile) {
      setHealthActionStatus('请先创建并保存成员档案后再补录记录。', 'warn');
      healthProfileDetails.open = true;
      healthProfileName.focus();
      return;
    }
    const rawWeight = Number(healthManualWeight.value);
    if (!Number.isFinite(rawWeight) || rawWeight <= 0) {
      setHealthActionStatus('请输入有效的体重数值', 'warn');
      healthManualWeight.focus();
      return;
    }
    healthManualAddBtn.disabled = true;
    try {
      const args: Record<string, unknown> = {
        weight: rawWeight,
        unit: healthManualUnit.value === 'jin' ? 'jin' : 'kg',
        note: healthManualNote.value.trim() || '手动补录',
      };
      if (healthDashboard.activeProfileId) args.profileId = healthDashboard.activeProfileId;
      const impRaw = healthManualImpedance.value.trim();
      if (impRaw !== '' && Number.isFinite(Number(impRaw))) args.impedanceOhm = Number(impRaw);
      const hrRaw = healthManualHr.value.trim();
      if (hrRaw !== '' && Number.isFinite(Number(hrRaw))) args.heartRate = Number(hrRaw);
      const timeRaw = healthManualTime.value.trim();
      if (timeRaw !== '') {
        const parsedAt = new Date(timeRaw).getTime();
        if (!Number.isFinite(parsedAt)) {
          setHealthActionStatus('请输入有效的测量时间格式', 'warn');
          healthManualTime.focus();
          return;
        }
        args.measuredAt = parsedAt;
      }

      const res = await runHealthPlugin<HealthDashboardData>('record-add', args);
      if (!res.ok || !res.data) {
        setHealthActionStatus(res.message || '补录记录失败', 'err');
        return;
      }
      healthManualWeight.value = '';
      healthManualImpedance.value = '';
      healthManualHr.value = '';
      healthManualNote.value = '';
      healthManualDetails.open = false;
      healthInspectedRecordId = null;
      applyHealthDashboard(res.data);
      setHealthActionStatus(res.message, 'ok');
    } catch (err) {
      setHealthActionStatus(`补录失败：${errorText(err)}`, 'err');
    } finally {
      healthManualAddBtn.disabled = false;
    }
  }

  async function deleteHealthRecordFromUi(id: string) {
    try {
      const args: Record<string, unknown> = { id };
      if (healthDashboard?.activeProfileId) args.profileId = healthDashboard.activeProfileId;
      const res = await runHealthPlugin<HealthDashboardData>('record-delete', args);
      if (!res.ok || !res.data) {
        setHealthActionStatus(res.message || '删除记录失败', 'err');
        return;
      }
      if (healthInspectedRecordId === id) healthInspectedRecordId = null;
      applyHealthDashboard(res.data);
      setHealthActionStatus(res.message, 'ok');
    } catch (err) {
      setHealthActionStatus(`删除记录失败：${errorText(err)}`, 'err');
    }
  }

  function handleHealthCanvasPointer(event: MouseEvent, selectPoint: boolean) {
    if (!healthPlottedPoints.length) return;
    const rect = healthTrendCanvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    let bestIdx: number | null = null;
    let bestDist = 28;
    for (let i = 0; i < healthPlottedPoints.length; i++) {
      const pt = healthPlottedPoints[i];
      if (!pt) continue;
      const dist = Math.hypot(pt.x - px, pt.y - py);
      if (dist <= bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (selectPoint && bestIdx !== null) {
      const chosen = healthPlottedPoints[bestIdx];
      if (chosen) {
        healthInspectedRecordId = chosen.rec.id;
        healthHoveredPointIdx = bestIdx;
        renderHealthModal();
        return;
      }
    }
    if (bestIdx !== healthHoveredPointIdx) {
      healthHoveredPointIdx = bestIdx;
      renderHealthTrendChart();
    }
  }

  function openModal() {
    hooks.closeAllHubModals();
    setHealthActionStatus();
    healthHubBackdrop.hidden = false;
    if (healthDashboard) {
      renderHealthModal();
    }
    void refreshHealthDashboard();
  }

  function closeModal() {
    stopHealthMeasurePoll();
    healthHubBackdrop.hidden = true;
  }

  healthModalClose.addEventListener('click', closeModal);
  healthHubBackdrop.addEventListener('click', event => {
    if (event.target === healthHubBackdrop) closeModal();
  });
  healthRefreshBtn.addEventListener('click', () => void refreshHealthDashboard());
  healthProfileSelect.addEventListener('change', () => {
    const nextId = healthProfileSelect.value;
    if (!nextId) return;
    healthInspectedRecordId = null;
    void refreshHealthDashboard({ profileId: nextId });
  });
  healthUnitKg.addEventListener('click', () => {
    healthUnit = 'kg';
    renderHealthTopBadge();
    renderHealthModal();
  });
  healthUnitJin.addEventListener('click', () => {
    healthUnit = 'jin';
    renderHealthTopBadge();
    renderHealthModal();
  });
  healthMeasureStartBtn.addEventListener('click', () => void startHealthMeasureFromUi());
  healthMeasureStopBtn.addEventListener('click', () => void stopHealthMeasureFromUi());
  healthScanBtn.addEventListener('click', () => void scanHealthScaleFromUi());
  healthInspectLatestBtn.addEventListener('click', () => {
    healthInspectedRecordId = null;
    renderHealthModal();
  });
  healthTrendMetrics.addEventListener('click', event => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-metric]');
    const metric = target?.dataset.metric as HealthTrendMetricKey | undefined;
    if (!metric) return;
    healthTrendMetric = metric;
    healthHoveredPointIdx = null;
    renderHealthTrendControls();
    renderHealthTrendChart();
  });
  healthTrendRanges.addEventListener('click', event => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-range]');
    const range = Number(target?.dataset.range);
    if (!Number.isFinite(range) || range <= 0) return;
    healthTrendLimit = range;
    healthHoveredPointIdx = null;
    renderHealthTrendControls();
    renderHealthTrendChart();
  });
  healthTrendCanvas.addEventListener('mousemove', event => handleHealthCanvasPointer(event, false));
  healthTrendCanvas.addEventListener('click', event => handleHealthCanvasPointer(event, true));
  healthTrendCanvas.addEventListener('mouseleave', () => {
    if (healthHoveredPointIdx !== null) {
      healthHoveredPointIdx = null;
      renderHealthTrendChart();
    }
  });
  healthSourceFilters.addEventListener('click', event => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-source]');
    const src = target?.dataset.source as HealthSourceFilterKey | undefined;
    if (!src) return;
    healthSourceFilter = src;
    renderHealthRecordsList();
  });
  healthProfileNewBtn.addEventListener('click', clearHealthProfileFormForNew);
  healthProfileSaveBtn.addEventListener('click', () => void saveHealthProfileFromUi());
  healthManualAddBtn.addEventListener('click', () => void addManualHealthRecordFromUi());

  return {
    openModal,
    closeModal,
  };
}

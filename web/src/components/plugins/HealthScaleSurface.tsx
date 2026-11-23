import { errorText, timestamp } from '@friday/web/shared/format.js';
import {
  ActivityIcon,
  BluetoothIcon,
  PlusIcon,
  ScaleIcon,
  SearchIcon,
  SquareIcon,
  Trash2Icon,
  UserPlusIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmActionDialog } from '@/components/shared/ConfirmActionDialog';
import { FullContentDialog, type FullContentPayload } from '@/components/shared/FullContentViewer';
import { TrendLineChart, type TrendPoint } from '@/components/shared/MetricCharts';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFriday } from '@/lib/friday-store';

interface HealthProfile {
  id: string;
  name: string;
  sex: 'male' | 'female';
  age: number;
  heightCm: number;
  targetWeightKg: number | null;
  unit: 'kg' | 'jin';
  isDefault: boolean;
}

interface HealthDevice {
  mac: string;
  name: string;
  rssi: number | null;
  battery: number | null;
  charging: boolean | null;
  protocolVer: number | null;
  deviceSubtype: number | null;
  supportFuns: string[];
  manufacturer: string | null;
  model: string | null;
  hardwareVer: string | null;
  softwareVer: string | null;
  lastSeenAt: number;
  rawAdv: Record<string, unknown> | null;
}

interface HealthMetricItem {
  key: string;
  label: string;
  value: number;
  unit: string;
  status: 'low' | 'normal' | 'high' | 'excellent' | 'attention';
  statusLabel: string;
  description: string;
  range: { min: number; max: number; scaleMin: number; scaleMax: number };
}

interface HealthMetrics {
  weightKg: number;
  bmi: number;
  bmiCategory: string;
  bodyFatPercent: number;
  fatMassKg: number;
  skeletalMusclePercent: number;
  skeletalMuscleMassKg: number;
  muscleMassKg: number;
  visceralFatLevel: number;
  bmrKcal: number;
  tdeeKcal: number;
  bodyAge: number;
  bodyScore: number;
  bodyType: string;
  standardWeightKg: number;
  weightDiffFromTargetKg: number | null;
  fatControlKg: number;
  muscleControlKg: number;
  resistanceOhm: number | null;
  secondaryOhm: number | null;
  formulaModel: string;
  items: HealthMetricItem[];
}

interface HealthRecord {
  id: string;
  profileId: string;
  measuredAt: number;
  source: 'live' | 'history' | 'manual' | string;
  weightKg: number;
  weightJin: number;
  weightLb: number;
  weightG: number;
  primaryOhm: number | null;
  secondaryOhm: number | null;
  heartRate: number | null;
  note?: string;
  metrics: HealthMetrics | null;
}

interface HealthLiveReadout {
  weightKg: number | null;
  stable: boolean;
  impedanceMeasured: boolean;
  packetCount: number;
}

interface HealthLiveSession {
  sessionId: string;
  phase: string;
  startedAt: number;
  message: string;
  error: string | null;
  liveReadout: HealthLiveReadout | null;
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
  device: HealthDevice | null;
  liveSession: HealthLiveSession | null;
  latest: HealthRecord | null;
  deltas: HealthDeltas | null;
  records: HealthRecord[];
}

interface HealthPluginResponse<T = unknown> {
  ok: boolean;
  message: string;
  data?: T;
}

type TrendMetricKey = 'weight' | 'fat' | 'bmi' | 'muscle' | 'bmr' | 'impedance';
type SourceFilterKey = 'all' | 'live' | 'history' | 'manual';

const ACTIVE_PHASES = new Set(['scanning', 'connecting', 'measuring']);

const BODY_TYPE_CELLS = [
  { bmiBucket: 0, fatBucket: 2, label: '隐性肥胖型', hint: 'BMI偏轻 · 体脂偏高' },
  { bmiBucket: 1, fatBucket: 2, label: '微胖型', hint: 'BMI标准 · 体脂偏高' },
  { bmiBucket: 2, fatBucket: 2, label: '肥胖型', hint: 'BMI超标 · 体脂偏高' },
  { bmiBucket: 0, fatBucket: 1, label: '偏瘦型', hint: 'BMI偏轻 · 体脂标准' },
  { bmiBucket: 1, fatBucket: 1, label: '标准型', hint: 'BMI标准 · 体脂标准' },
  { bmiBucket: 2, fatBucket: 1, label: '偏壮标准型', hint: 'BMI偏高 · 体脂标准' },
  { bmiBucket: 0, fatBucket: 0, label: '瘦弱偏瘦型', hint: 'BMI偏轻 · 体脂偏低' },
  { bmiBucket: 1, fatBucket: 0, label: '偏瘦肌肉型', hint: 'BMI标准 · 体脂偏低' },
  { bmiBucket: 2, fatBucket: 0, label: '运动健美型', hint: 'BMI偏高 · 低体脂' },
] as const;

const METRIC_LABELS: Array<{ key: TrendMetricKey; label: string }> = [
  { key: 'weight', label: '体重' },
  { key: 'fat', label: '体脂率' },
  { key: 'bmi', label: 'BMI' },
  { key: 'muscle', label: '骨骼肌率' },
  { key: 'bmr', label: '基础代谢' },
  { key: 'impedance', label: '生物电阻抗' },
];

const SOURCE_LABELS: Array<{ key: SourceFilterKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'live', label: '蓝牙实测' },
  { key: 'history', label: '秤端缓存' },
  { key: 'manual', label: '手动补录' },
];

function fmtWeight(kg: number, unit: 'kg' | 'jin', digits = 2): string {
  return (unit === 'jin' ? kg * 2 : kg).toFixed(digits);
}

function fmtWeightUnit(kg: number, unit: 'kg' | 'jin', digits = 2): string {
  return `${fmtWeight(kg, unit, digits)} ${unit === 'jin' ? '斤' : 'kg'}`;
}

function fmtSignedDelta(deltaKg: number, unit: 'kg' | 'jin', digits = 2): string {
  const scaled = unit === 'jin' ? deltaKg * 2 : deltaKg;
  return `${scaled > 0 ? '+' : ''}${scaled.toFixed(digits)} ${unit === 'jin' ? '斤' : 'kg'}`;
}

function sourceBadgeInfo(source: string): { text: string; variant: 'success' | 'info' | 'secondary' } {
  if (source === 'live') return { text: '蓝牙实测', variant: 'success' };
  if (source === 'history') return { text: '秤端缓存', variant: 'info' };
  if (source === 'manual') return { text: '手动补录', variant: 'secondary' };
  return { text: source || '记录', variant: 'secondary' };
}

function phaseBadgeInfo(phase?: string): { text: string; variant: 'info' | 'warning' | 'success' | 'secondary'; active: boolean } {
  switch (phase) {
    case 'scanning': return { text: '扫描广播中…', variant: 'info', active: true };
    case 'connecting': return { text: '连接并同步参数…', variant: 'info', active: true };
    case 'measuring': return { text: '称重与电阻抗采集中…', variant: 'warning', active: true };
    case 'completed': return { text: '测量已完成', variant: 'success', active: false };
    case 'stopped': return { text: '已手动停止', variant: 'secondary', active: false };
    case 'timeout': return { text: '等待上秤超时', variant: 'warning', active: false };
    case 'error': return { text: '蓝牙测量异常', variant: 'warning', active: false };
    default: return { text: '待机中', variant: 'secondary', active: false };
  }
}

export default function HealthScaleSurface() {
  const { authExpired, api } = useFriday();
  const [dashboard, setDashboard] = useState<HealthDashboardData | null>(null);
  const [unit, setUnit] = useState<'kg' | 'jin'>('kg');
  const unitInitRef = useRef(false);
  const [trendMetric, setTrendMetric] = useState<TrendMetricKey>('weight');
  const [trendLimit, setTrendLimit] = useState<number>(30);
  const [sourceFilter, setSourceFilter] = useState<SourceFilterKey>('all');
  const [inspectedRecordId, setInspectedRecordId] = useState<string | null>(null);
  const [showAllRecords, setShowAllRecords] = useState(false);
  const [viewerPayload, setViewerPayload] = useState<FullContentPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);

  // Profile form states
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const [profId, setProfId] = useState('');
  const [profName, setProfName] = useState('');
  const [profSex, setProfSex] = useState<'male' | 'female'>('male');
  const [profAge, setProfAge] = useState('');
  const [profHeight, setProfHeight] = useState('');
  const [profTarget, setProfTarget] = useState('');
  const [profUnit, setProfUnit] = useState<'kg' | 'jin'>('kg');
  const [profDefault, setProfDefault] = useState(false);

  // Manual record form states
  const [manualOpen, setManualOpen] = useState(false);
  const [manWeight, setManWeight] = useState('');
  const [manUnit, setManUnit] = useState<'kg' | 'jin'>('kg');
  const [manImpedance, setManImpedance] = useState('');
  const [manHr, setManHr] = useState('');
  const [manTime, setManTime] = useState('');
  const [manNote, setManNote] = useState('');

  // Confirmation dialogs
  const [deleteProfileTarget, setDeleteProfileTarget] = useState<HealthProfile | null>(null);
  const [deleteRecordTarget, setDeleteRecordTarget] = useState<HealthRecord | null>(null);

  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  const lastPhaseRef = useRef('');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runHealth = useCallback(
    async <T,>(action: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
      return api<HealthPluginResponse<T>>('/api/plugin-run', {
        plugin: 'health-scale',
        action,
        args,
      }, { signal });
    },
    [api],
  );

  const syncProfileForm = useCallback((p: HealthProfile | null, currentUnit: 'kg' | 'jin', count: number) => {
    if (p) {
      setProfId(p.id);
      setProfName(p.name);
      setProfSex(p.sex);
      setProfAge(String(p.age));
      setProfHeight(String(p.heightCm));
      setProfTarget(p.targetWeightKg !== null ? String(p.targetWeightKg) : '');
      setProfUnit(p.unit === 'jin' ? 'jin' : 'kg');
      setProfDefault(Boolean(p.isDefault));
    } else {
      setProfId('');
      setProfName('');
      setProfSex('male');
      setProfAge('');
      setProfHeight('');
      setProfTarget('');
      setProfUnit(currentUnit);
      setProfDefault(count === 0);
      setProfileOpen(true);
    }
  }, []);

  const applyDashboard = useCallback(
    (data: HealthDashboardData, forceSyncForm = false) => {
      setDashboard(data);
      let nextUnit = unit;
      if (!unitInitRef.current && data.activeProfile) {
        nextUnit = data.activeProfile.unit === 'jin' ? 'jin' : 'kg';
        setUnit(nextUnit);
        setManUnit(nextUnit);
        unitInitRef.current = true;
      }
      setInspectedRecordId(prev => (prev && !data.records.some(r => r.id === prev) ? null : prev));
      if (forceSyncForm || !profileDirty) {
        syncProfileForm(data.activeProfile, nextUnit, data.profiles.length);
      }
    },
    [profileDirty, syncProfileForm, unit],
  );

  const refreshDashboard = useCallback(
    async (opts: { profileId?: string; quiet?: boolean } = {}) => {
      if (authExpired) return;
      const seq = ++seqRef.current;
      const targetId = opts.profileId ?? dashboard?.activeProfileId ?? undefined;
      try {
        const res = await runHealth<HealthDashboardData>('dashboard', targetId ? { profileId: targetId } : {});
        if (!mountedRef.current || seq !== seqRef.current || authExpired) return;
        if (!res.ok || !res.data) {
          if (!opts.quiet) setStatus({ text: res.message || '读取健康看板失败', tone: 'err' });
          return;
        }
        lastPhaseRef.current = res.data.liveSession?.phase || '';
        applyDashboard(res.data);
      } catch (err) {
        if (!mountedRef.current || seq !== seqRef.current || authExpired) return;
        if (!opts.quiet) setStatus({ text: `读取健康数据失败：${errorText(err)}`, tone: 'err' });
      }
    },
    [applyDashboard, authExpired, dashboard?.activeProfileId, runHealth],
  );

  useEffect(() => {
    void refreshDashboard();
    // Initial mount load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activePhase = dashboard?.liveSession?.phase || '';
  const isMeasuring = ACTIVE_PHASES.has(activePhase);

  // Active Bluetooth measurement polling
  useEffect(() => {
    if (!isMeasuring || authExpired) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ac = new AbortController();

    const pollOnce = async () => {
      if (cancelled || document.hidden || authExpired) return;
      const seq = ++seqRef.current;
      try {
        const res = await runHealth<{ session: HealthLiveSession | null; dashboard: HealthDashboardData }>(
          'measure-status',
          {},
          ac.signal,
        );
        if (cancelled || !mountedRef.current || seq !== seqRef.current) return;
        if (res.ok && res.data) {
          const prevPhase = lastPhaseRef.current;
          const nextPhase = res.data.session?.phase || '';
          lastPhaseRef.current = nextPhase;
          applyDashboard(res.data.dashboard);
          if (ACTIVE_PHASES.has(nextPhase)) {
            timer = setTimeout(() => void pollOnce(), 800);
          } else if (ACTIVE_PHASES.has(prevPhase)) {
            if (nextPhase === 'completed') {
              setInspectedRecordId(null);
              setStatus({ text: res.data.session?.message || '实测完成并已自动分析入库。', tone: 'ok' });
            } else if (nextPhase === 'error' || nextPhase === 'timeout') {
              setStatus({ text: res.data.session?.error || res.data.session?.message || '蓝牙测量未完成', tone: 'warn' });
            } else if (nextPhase === 'stopped') {
              setStatus({ text: res.data.session?.message || '已停止蓝牙测量', tone: 'warn' });
            }
          }
        } else {
          timer = setTimeout(() => void pollOnce(), 1200);
        }
      } catch (err) {
        if (ac.signal.aborted || cancelled) return;
        setStatus({ text: `轮询测量状态失败：${errorText(err)}`, tone: 'warn' });
        timer = setTimeout(() => void pollOnce(), 1500);
      }
    };

    timer = setTimeout(() => void pollOnce(), 800);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      ac.abort();
    };
  }, [applyDashboard, authExpired, isMeasuring, runHealth]);

  const inspectedRecord = useMemo(() => {
    if (!dashboard) return null;
    if (inspectedRecordId) {
      const m = dashboard.records.find(r => r.id === inspectedRecordId);
      if (m) return m;
    }
    return dashboard.latest;
  }, [dashboard, inspectedRecordId]);

  const startMeasure = async () => {
    if (busy || !dashboard?.activeProfile || authExpired) return;
    setBusy(true);
    setStatus({ text: '正在唤醒蓝牙适配器和沃莱 A1，请赤脚站上体脂秤…', tone: 'warn' });
    ++seqRef.current;
    try {
      const args: Record<string, unknown> = { timeoutSec: 45 };
      if (dashboard.activeProfileId) args.profileId = dashboard.activeProfileId;
      if (dashboard.device?.mac) args.targetMac = dashboard.device.mac;
      const res = await runHealth<{ session: HealthLiveSession }>('measure-start', args);
      if (!mountedRef.current) return;
      if (!res.ok) {
        setStatus({ text: res.message || '启动蓝牙测量失败', tone: 'err' });
        return;
      }
      if (res.data?.session) {
        lastPhaseRef.current = res.data.session.phase;
        setDashboard(prev => (prev ? { ...prev, liveSession: res.data!.session } : prev));
      }
      setStatus({ text: res.message || '已启动实时测量，请赤脚上秤并保持静止。', tone: 'ok' });
    } catch (err) {
      setStatus({ text: `启动上秤测量失败：${errorText(err)}`, tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const stopMeasure = async () => {
    if (authExpired) return;
    setBusy(true);
    ++seqRef.current;
    try {
      const res = await runHealth<{ session: HealthLiveSession | null }>(
        'measure-stop',
        dashboard?.activeProfileId ? { profileId: dashboard.activeProfileId } : {},
      );
      if (!mountedRef.current) return;
      setDashboard(prev => (prev && res.data ? { ...prev, liveSession: res.data.session } : prev));
      setStatus({ text: res.message || '已停止当前测量会话', tone: 'warn' });
      await refreshDashboard({ quiet: true });
    } catch (err) {
      setStatus({ text: `停止测量失败：${errorText(err)}`, tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const scanScale = async () => {
    if (busy || authExpired) return;
    setBusy(true);
    ++seqRef.current;
    setStatus({ text: '正在通过 BlueZ 扫描附近沃莱 A1 (AFU-WL*) 体脂秤…', tone: 'warn' });
    try {
      const res = await runHealth<{ device: HealthDevice | null }>('scan', { timeoutSec: 4 });
      if (!mountedRef.current) return;
      setStatus({ text: res.message, tone: res.ok && res.data?.device ? 'ok' : 'warn' });
      await refreshDashboard({ quiet: true });
    } catch (err) {
      setStatus({ text: `蓝牙扫描失败：${errorText(err)}`, tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = profName.trim();
    const age = Number(profAge.trim());
    const heightCm = Number(profHeight.trim());
    const targetRaw = profTarget.trim();
    const targetWeightKg = targetRaw === '' ? null : Number(targetRaw);
    if (!name) {
      setStatus({ text: '请填写成员昵称', tone: 'warn' });
      return;
    }
    if (!Number.isFinite(age) || age < 5 || age > 120) {
      setStatus({ text: '请填写有效年龄（5 ~ 120 岁）', tone: 'warn' });
      return;
    }
    if (!Number.isFinite(heightCm) || heightCm < 80 || heightCm > 230) {
      setStatus({ text: '请填写有效身高（80 ~ 230 cm）', tone: 'warn' });
      return;
    }
    if (targetWeightKg !== null && (!Number.isFinite(targetWeightKg) || targetWeightKg < 20 || targetWeightKg > 250)) {
      setStatus({ text: '目标体重需在 20 ~ 250 kg 之间', tone: 'warn' });
      return;
    }
    setBusy(true);
    ++seqRef.current;
    try {
      const args: Record<string, unknown> = {
        name,
        sex: profSex,
        age,
        heightCm,
        targetWeightKg,
        unit: profUnit,
        setDefault: profDefault,
      };
      if (profId.trim()) args.id = profId.trim();
      const res = await runHealth<HealthDashboardData>('profile-save', args);
      if (!mountedRef.current) return;
      if (!res.ok || !res.data) {
        setStatus({ text: res.message || '保存档案失败', tone: 'err' });
        return;
      }
      setProfileDirty(false);
      if (res.data.activeProfile) {
        setUnit(res.data.activeProfile.unit === 'jin' ? 'jin' : 'kg');
      }
      applyDashboard(res.data, true);
      setStatus({ text: res.message, tone: 'ok' });
    } catch (err) {
      setStatus({ text: `保存档案失败：${errorText(err)}`, tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const confirmDeleteProfile = async () => {
    if (!deleteProfileTarget) return;
    setBusy(true);
    ++seqRef.current;
    try {
      const res = await runHealth<HealthDashboardData>('profile-delete', { id: deleteProfileTarget.id });
      if (!mountedRef.current) return;
      if (!res.ok || !res.data) {
        setStatus({ text: res.message || '删除成员档案失败', tone: 'err' });
        return;
      }
      setDeleteProfileTarget(null);
      setProfileDirty(false);
      setInspectedRecordId(null);
      applyDashboard(res.data, true);
      setStatus({ text: res.message, tone: 'ok' });
    } catch (err) {
      setStatus({ text: `删除成员档案失败：${errorText(err)}`, tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const addManualRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dashboard?.activeProfile) {
      setProfileOpen(true);
      setStatus({ text: '请先创建并保存成员档案后再补录记录。', tone: 'warn' });
      return;
    }
    const rawWeight = Number(manWeight);
    if (!Number.isFinite(rawWeight) || rawWeight <= 0) {
      setStatus({ text: '请输入有效的体重数值', tone: 'warn' });
      return;
    }
    const args: Record<string, unknown> = {
      weight: rawWeight,
      unit: manUnit,
      note: manNote.trim() || '手动补录',
    };
    if (dashboard.activeProfileId) args.profileId = dashboard.activeProfileId;
    if (manImpedance.trim() && Number.isFinite(Number(manImpedance))) args.impedanceOhm = Number(manImpedance);
    if (manHr.trim() && Number.isFinite(Number(manHr))) args.heartRate = Number(manHr);
    if (manTime.trim()) {
      const ts = new Date(manTime.trim()).getTime();
      if (!Number.isFinite(ts)) {
        setStatus({ text: '请输入有效的测量时间格式', tone: 'warn' });
        return;
      }
      args.measuredAt = ts;
    }
    setBusy(true);
    ++seqRef.current;
    try {
      const res = await runHealth<HealthDashboardData>('record-add', args);
      if (!mountedRef.current) return;
      if (!res.ok || !res.data) {
        setStatus({ text: res.message || '补录记录失败', tone: 'err' });
        return;
      }
      setManWeight('');
      setManImpedance('');
      setManHr('');
      setManTime('');
      setManNote('');
      setManualOpen(false);
      setInspectedRecordId(null);
      applyDashboard(res.data);
      setStatus({ text: res.message, tone: 'ok' });
    } catch (err) {
      setStatus({ text: `补录失败：${errorText(err)}`, tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const confirmDeleteRecord = async () => {
    if (!deleteRecordTarget) return;
    setBusy(true);
    ++seqRef.current;
    try {
      const args: Record<string, unknown> = { id: deleteRecordTarget.id };
      if (dashboard?.activeProfileId) args.profileId = dashboard.activeProfileId;
      const res = await runHealth<HealthDashboardData>('record-delete', args);
      if (!mountedRef.current) return;
      if (!res.ok || !res.data) {
        setStatus({ text: res.message || '删除记录失败', tone: 'err' });
        return;
      }
      if (inspectedRecordId === deleteRecordTarget.id) setInspectedRecordId(null);
      setDeleteRecordTarget(null);
      applyDashboard(res.data);
      setStatus({ text: res.message, tone: 'ok' });
    } catch (err) {
      setStatus({ text: `删除记录失败：${errorText(err)}`, tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const phaseInfo = phaseBadgeInfo(dashboard?.liveSession?.phase);
  const liveKg = phaseInfo.active ? (dashboard?.liveSession?.liveReadout?.weightKg ?? null) : null;
  const activeProfile = dashboard?.activeProfile ?? null;
  const metrics = inspectedRecord?.metrics ?? null;

  // Trend chart data
  const trendData = useMemo(() => {
    const raw = (dashboard?.records ?? []).slice(0, trendLimit).toReversed();
    const pts: TrendPoint[] = [];
    for (const r of raw) {
      const d = new Date(r.measuredAt);
      const label = `${d.getMonth() + 1}/${d.getDate()}`;
      let val: number | null = null;
      if (trendMetric === 'weight') val = unit === 'jin' ? Number((r.weightKg * 2).toFixed(2)) : r.weightKg;
      else if (trendMetric === 'fat') val = r.metrics?.bodyFatPercent ?? null;
      else if (trendMetric === 'bmi') val = r.metrics?.bmi ?? null;
      else if (trendMetric === 'muscle') val = r.metrics?.skeletalMusclePercent ?? null;
      else if (trendMetric === 'bmr') val = r.metrics?.bmrKcal ?? null;
      else if (trendMetric === 'impedance') val = r.primaryOhm ?? r.metrics?.resistanceOhm ?? null;
      if (val !== null && Number.isFinite(val)) {
        pts.push({ label, value: val });
      }
    }
    return pts;
  }, [dashboard?.records, trendLimit, trendMetric, unit]);

  const currentMetricMeta = METRIC_LABELS.find(m => m.key === trendMetric)!;
  const currentUnitSuffix =
    trendMetric === 'weight'
      ? unit === 'jin'
        ? ' 斤'
        : ' kg'
      : trendMetric === 'fat' || trendMetric === 'muscle'
        ? '%'
        : trendMetric === 'bmr'
          ? ' kcal'
          : trendMetric === 'impedance'
            ? ' Ω'
            : '';

  const filteredRecords = useMemo(() => {
    const recs = dashboard?.records ?? [];
    if (sourceFilter === 'all') return recs;
    return recs.filter(r => r.source === sourceFilter);
  }, [dashboard?.records, sourceFilter]);

  // Body type active bucket
  const activeBuckets = useMemo(() => {
    if (!metrics || !activeProfile) return { bmi: -1, fat: -1 };
    const male = activeProfile.sex !== 'female';
    const bmi = metrics.bmi < 18.5 ? 0 : metrics.bmi < 24 ? 1 : 2;
    const fat = metrics.bodyFatPercent < (male ? 11 : 18) ? 0 : metrics.bodyFatPercent <= (male ? 20 : 28) ? 1 : 2;
    return { bmi, fat };
  }, [activeProfile, metrics]);

  // SVG Score Ring computation (no inline CSS styles)
  const score = metrics?.bodyScore ?? null;
  const ringR = 42;
  const ringC = 2 * Math.PI * ringR;
  const ringOffset = ringC * (1 - (score !== null ? Math.max(0, Math.min(100, score)) : 0) / 100);

  return (
    <div className="space-y-4">
      {/* Header Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <ScaleIcon className="size-4 text-primary" />
            <span>健康管理 · 沃莱 A1 蓝牙智能体脂秤</span>
          </h3>
          <select
            aria-label="选择家庭成员"
            value={dashboard?.activeProfileId ?? ''}
            disabled={busy || authExpired}
            onChange={e => {
              setInspectedRecordId(null);
              void refreshDashboard({ profileId: e.target.value || undefined });
            }}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none"
          >
            {!dashboard?.profiles.length ? (
              <option value="">尚未创建成员档案</option>
            ) : (
              dashboard.profiles.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.isDefault ? ' (默认)' : ''} · {p.sex === 'male' ? '男' : '女'} {p.heightCm}cm/{p.age}岁
                </option>
              ))
            )}
          </select>
          <div className="inline-flex rounded-md border p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setUnit('kg')}
              className={`rounded px-2 py-0.5 ${unit === 'kg' ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`}
            >
              kg
            </button>
            <button
              type="button"
              onClick={() => setUnit('jin')}
              className={`rounded px-2 py-0.5 ${unit === 'jin' ? 'bg-primary text-primary-foreground font-medium' : 'text-muted-foreground hover:text-foreground'}`}
            >
              斤
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" disabled={busy || phaseInfo.active || authExpired} onClick={() => void scanScale()}>
            <SearchIcon className="size-3.5" />
            <span>扫描体脂秤</span>
          </Button>
          <Button
            size="xs"
            disabled={busy || phaseInfo.active || !activeProfile || authExpired}
            onClick={() => void startMeasure()}
          >
            <BluetoothIcon className="size-3.5" />
            <span>{phaseInfo.active ? '蓝牙采集中…' : '开始上秤测量'}</span>
          </Button>
          {phaseInfo.active && (
            <Button size="xs" variant="destructive" onClick={() => void stopMeasure()}>
              <SquareIcon className="size-3" />
              <span>停止测量</span>
            </Button>
          )}
        </div>
      </div>

      {status && (
        <Alert variant={status.tone === 'err' ? 'error' : status.tone === 'warn' ? 'warning' : 'success'}>
          <AlertDescription className="text-xs">{status.text}</AlertDescription>
        </Alert>
      )}

      {/* Hero Row */}
      <div className="grid gap-3 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge variant={phaseInfo.variant}>{phaseInfo.text}</Badge>
              <span className="text-xs text-muted-foreground">
                {phaseInfo.active && dashboard?.liveSession
                  ? dashboard.liveSession.liveReadout
                    ? `${dashboard.liveSession.liveReadout.packetCount} 帧 · ${dashboard.liveSession.liveReadout.stable ? '体重已锁定' : '波动中'}`
                    : `开始于 ${timestamp(dashboard.liveSession.startedAt)}`
                  : inspectedRecord
                    ? `${sourceBadgeInfo(inspectedRecord.source).text} · ${timestamp(inspectedRecord.measuredAt)}`
                    : activeProfile
                      ? '尚无记录'
                      : '待建档'}
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {phaseInfo.active ? (
              <>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-bold tracking-tight">
                    {liveKg !== null && liveKg > 0 ? fmtWeight(liveKg, unit, 2) : '--'}
                  </span>
                  <span className="text-sm text-muted-foreground">{unit === 'jin' ? '斤' : 'kg'}</span>
                </div>
                <p className="font-mono text-xs text-muted-foreground">
                  {liveKg !== null && liveKg > 0
                    ? `${liveKg.toFixed(2)} kg · ${(liveKg * 2).toFixed(2)} 斤 · ${(liveKg * 2.20462).toFixed(2)} lb${dashboard?.liveSession?.liveReadout?.impedanceMeasured ? ' · 双频阻抗已捕获' : ''}`
                    : '等待秤端广播稳定数值…'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {dashboard?.liveSession?.message || '请赤脚站稳沃莱 A1 电极片，保持静止以测双频阻抗…'}
                </p>
              </>
            ) : inspectedRecord ? (
              <>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-bold tracking-tight">
                    {fmtWeight(inspectedRecord.weightKg, unit, 2)}
                  </span>
                  <span className="text-sm text-muted-foreground">{unit === 'jin' ? '斤' : 'kg'}</span>
                </div>
                <p className="font-mono text-xs text-muted-foreground">
                  {inspectedRecord.weightKg.toFixed(2)} kg · {inspectedRecord.weightJin.toFixed(2)} 斤 · {inspectedRecord.weightLb.toFixed(2)} lb · {inspectedRecord.weightG} g
                </p>
                <p className="text-xs text-muted-foreground">
                  {dashboard?.liveSession?.error
                    ? `上次测量：${dashboard.liveSession.error}`
                    : dashboard?.liveSession?.message && dashboard.liveSession.phase !== 'idle'
                      ? dashboard.liveSession.message
                      : '点击「开始上秤测量」并赤脚站上沃莱 A1，自动同步实测与秤端离线记录。'}
                </p>
              </>
            ) : (
              <>
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono text-3xl font-bold tracking-tight">--</span>
                  <span className="text-sm text-muted-foreground">{unit === 'jin' ? '斤' : 'kg'}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {!activeProfile
                    ? '请先在下方「成员档案」填写昵称、性别、年龄和身高并保存。'
                    : '尚无测量记录，可点击上方「开始上秤测量」或下方「手动补录」。'}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* Score Ring Card */}
        <Card>
          <CardContent className="flex items-center gap-3 pt-4">
            <div className="relative flex size-24 shrink-0 items-center justify-center">
              <svg viewBox="0 0 112 112" className="size-24 -rotate-90" aria-hidden="true">
                <circle cx="56" cy="56" r={ringR} fill="none" stroke="var(--border)" strokeWidth="8" />
                <circle
                  cx="56"
                  cy="56"
                  r={ringR}
                  fill="none"
                  stroke={score !== null && score >= 85 ? 'var(--success)' : score !== null && score >= 70 ? 'var(--info)' : 'var(--warning)'}
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={ringC.toFixed(1)}
                  strokeDashoffset={ringOffset.toFixed(1)}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
                <strong className="font-mono text-xl font-bold">{score !== null ? score : '--'}</strong>
                <span className="text-[10px] text-muted-foreground">身体得分</span>
              </div>
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              {metrics ? (
                <>
                  <Badge variant={metrics.bodyScore >= 85 ? 'success' : metrics.bodyScore >= 70 ? 'info' : 'warning'}>
                    {metrics.bodyScore >= 85 ? '优秀' : metrics.bodyScore >= 70 ? '良好' : '待改善'} · {metrics.bodyType}
                  </Badge>
                  <p className="text-xs font-medium">BMI {metrics.bmi} ({metrics.bmiCategory})</p>
                  <p className="text-[11px] text-muted-foreground">
                    身体年龄 {metrics.bodyAge} 岁 · 体脂 {metrics.bodyFatPercent}% · 骨骼肌 {metrics.skeletalMusclePercent}%
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {metrics.resistanceOhm !== null ? `BIA ${metrics.resistanceOhm} Ω` : metrics.formulaModel}
                  </p>
                </>
              ) : (
                <>
                  <Badge variant={activeProfile ? 'secondary' : 'warning'}>{activeProfile ? '待测量' : '待建档'}</Badge>
                  <p className="text-xs text-muted-foreground">
                    {activeProfile
                      ? `${activeProfile.name} (${activeProfile.sex === 'male' ? '男' : '女'} ${activeProfile.heightCm}cm)`
                      : '保存成员档案后自动计算体脂与得分'}
                  </p>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* KPIs */}
      {activeProfile && metrics && dashboard?.deltas && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="pb-1"><CardDescription className="text-xs">最新体重</CardDescription></CardHeader>
            <CardContent>
              <div className="font-mono text-lg font-semibold">{fmtWeightUnit(metrics.weightKg, unit, 2)}</div>
              <p className="text-[11px] text-muted-foreground">
                {dashboard.deltas.prevDiffKg !== null ? `较上次 ${fmtSignedDelta(dashboard.deltas.prevDiffKg, unit, 2)}` : '首次记录'}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1"><CardDescription className="text-xs">体脂率 / 脂肪</CardDescription></CardHeader>
            <CardContent>
              <div className="font-mono text-lg font-semibold">{metrics.bodyFatPercent.toFixed(1)}%</div>
              <p className="text-[11px] text-muted-foreground">
                脂肪 {metrics.fatMassKg} kg{dashboard.deltas.prevFatDiff !== null ? ` · 较上次 ${dashboard.deltas.prevFatDiff > 0 ? '+' : ''}${dashboard.deltas.prevFatDiff.toFixed(1)}%` : ''}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1"><CardDescription className="text-xs">骨骼肌 / 代谢</CardDescription></CardHeader>
            <CardContent>
              <div className="font-mono text-lg font-semibold">{metrics.skeletalMusclePercent.toFixed(1)}%</div>
              <p className="text-[11px] text-muted-foreground">
                骨骼肌 {metrics.skeletalMuscleMassKg} kg · BMR {metrics.bmrKcal} kcal
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1"><CardDescription className="text-xs">7日均值 ({dashboard.deltas.totalCount} 次)</CardDescription></CardHeader>
            <CardContent>
              <div className="font-mono text-lg font-semibold">
                {dashboard.deltas.avg7dKg !== null ? fmtWeightUnit(dashboard.deltas.avg7dKg, unit, 2) : '--'}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {dashboard.deltas.targetDiffKg !== null
                  ? `距目标 ${fmtSignedDelta(dashboard.deltas.targetDiffKg, unit, 1)}`
                  : `区间 ${fmtWeight(dashboard.deltas.minWeightKg, unit, 1)}~${fmtWeightUnit(dashboard.deltas.maxWeightKg, unit, 1)}`}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Trend Chart */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <ActivityIcon className="size-4" />
              <span>健康指标趋势</span>
            </CardTitle>
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="flex flex-wrap gap-1">
                {METRIC_LABELS.map(m => (
                  <Button
                    key={m.key}
                    size="xs"
                    variant={trendMetric === m.key ? 'default' : 'outline'}
                    onClick={() => setTrendMetric(m.key)}
                  >
                    {m.label}
                  </Button>
                ))}
              </div>
              <div className="flex gap-1">
                {[7, 30, 999].map(lim => (
                  <Button
                    key={lim}
                    size="xs"
                    variant={trendLimit === lim ? 'secondary' : 'ghost'}
                    onClick={() => setTrendLimit(lim)}
                  >
                    {lim === 999 ? '全部' : `近${lim}次`}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <TrendLineChart
            points={trendData}
            primaryLabel={currentMetricMeta.label}
            unit={currentUnitSuffix}
            emptyText="暂无该指标的历史趋势数据，完成测量或补录后自动绘制"
          />
        </CardContent>
      </Card>

      {/* Body Composition Metrics & 3x3 Matrix */}
      {metrics && (
        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm">
                  人体成分与健康参考 ({metrics.items.length} 项)
                </CardTitle>
                {inspectedRecordId && dashboard?.latest && inspectedRecordId !== dashboard.latest.id && (
                  <Button size="xs" variant="outline" onClick={() => setInspectedRecordId(null)}>
                    回到最新记录
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {metrics.items.map(item => {
                const span = Math.max(0.01, item.range.scaleMax - item.range.scaleMin);
                const toX = (v: number) => Math.max(4, Math.min(196, 4 + ((v - item.range.scaleMin) / span) * 192));
                const xMin = toX(item.range.min);
                const xMax = toX(item.range.max);
                const vx = toX(item.value);
                return (
                  <div key={item.key} className="rounded-lg border p-2.5 space-y-1">
                    <div className="flex items-center justify-between gap-1 text-xs">
                      <span className="font-medium">{item.label}</span>
                      <Badge variant={item.status === 'normal' || item.status === 'excellent' ? 'success' : item.status === 'low' ? 'info' : 'warning'}>
                        {item.statusLabel}
                      </Badge>
                    </div>
                    <div className="font-mono text-sm font-semibold">
                      {item.value} <span className="text-xs font-normal text-muted-foreground">{item.unit}</span>
                    </div>
                    <svg viewBox="0 0 200 14" className="h-3.5 w-full" aria-hidden="true">
                      <rect x="4" y="5" width="192" height="4" rx="2" fill="var(--muted)" />
                      <rect
                        x={xMin.toFixed(1)}
                        y="4"
                        width={Math.max(4, xMax - xMin).toFixed(1)}
                        height="6"
                        rx="3"
                        fill="var(--success)"
                        fillOpacity="0.4"
                      />
                      <circle
                        cx={vx.toFixed(1)}
                        cy="7"
                        r="4"
                        fill={item.status === 'normal' || item.status === 'excellent' ? 'var(--success)' : 'var(--warning)'}
                      />
                    </svg>
                    <p className="text-[11px] text-muted-foreground">{item.description}</p>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <div className="space-y-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">九宫格体型判定</CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-3 gap-1.5">
                {BODY_TYPE_CELLS.map(cell => {
                  const isAct = cell.bmiBucket === activeBuckets.bmi && cell.fatBucket === activeBuckets.fat;
                  return (
                    <div
                      key={cell.label}
                      className={`rounded-md border p-2 text-center ${isAct ? 'border-primary bg-primary/10' : 'bg-muted/20'}`}
                    >
                      <div className="text-[11px] font-medium leading-tight">
                        {isAct && metrics.bodyType ? `${metrics.bodyType} ★` : cell.label}
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">{cell.hint}</div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            {/* Device telemetry */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">体脂秤蓝牙状态</CardTitle>
                <CardDescription className="text-xs">
                  {dashboard?.device
                    ? dashboard.device.lastSeenAt
                      ? `最近发现 ${timestamp(dashboard.device.lastSeenAt)}`
                      : '已配对'
                    : '未发现设备，踩亮秤面后点击扫描'}
                </CardDescription>
              </CardHeader>
              {dashboard?.device && (
                <CardContent className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">设备名</span>
                    <span className="font-mono">{dashboard.device.name || 'AFU-WL-TZ-A1'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">MAC / RSSI</span>
                    <span className="font-mono">
                      {dashboard.device.mac} · {dashboard.device.rssi !== null ? `${dashboard.device.rssi} dBm` : '--'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">电量</span>
                    <span className="font-mono">
                      {dashboard.device.battery !== null ? `${dashboard.device.battery}%${dashboard.device.charging ? ' (充电)' : ''}` : '--'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">固件 / 硬件</span>
                    <span className="font-mono">
                      HW {dashboard.device.hardwareVer ?? '--'} / SW {dashboard.device.softwareVer ?? '--'}
                    </span>
                  </div>
                </CardContent>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* Profile Management */}
      <Collapsible open={profileOpen} onOpenChange={setProfileOpen}>
        <Card>
          <CardHeader className="pb-2">
            <CollapsibleTrigger render={<button type="button" className="flex w-full items-center justify-between text-left" />}>
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <UserPlusIcon className="size-4" />
                <span>成员档案管理 ({dashboard?.profiles.length ?? 0} 位)</span>
              </span>
              <span className="text-xs text-muted-foreground">{profileOpen ? '收起' : '展开配置'}</span>
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsiblePanel>
            <CardContent className="space-y-3">
              {dashboard?.profiles.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {dashboard.profiles.map(p => (
                    <div key={p.id} className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
                      <button
                        type="button"
                        onClick={() => {
                          setProfileDirty(false);
                          void refreshDashboard({ profileId: p.id });
                        }}
                        className={`font-medium ${p.id === dashboard.activeProfileId ? 'text-primary' : 'text-foreground'}`}
                      >
                        {p.name}
                        {p.isDefault ? ' (默认)' : ''}
                      </button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setDeleteProfileTarget(p)}
                        aria-label={`删除成员 ${p.name}`}
                      >
                        <Trash2Icon className="size-3 text-destructive" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      setProfileDirty(true);
                      setProfId('');
                      setProfName('');
                      setProfAge('');
                      setProfHeight('');
                      setProfTarget('');
                    }}
                  >
                    <PlusIcon className="size-3" />
                    <span>新增成员</span>
                  </Button>
                </div>
              ) : null}

              <form onSubmit={e => void saveProfile(e)} className="grid gap-2 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label className="text-xs">成员昵称</Label>
                  <Input
                    size="sm"
                    value={profName}
                    onChange={e => { setProfileDirty(true); setProfName(e.target.value); }}
                    placeholder="如：主理人"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">性别</Label>
                  <select
                    value={profSex}
                    onChange={e => { setProfileDirty(true); setProfSex(e.target.value === 'female' ? 'female' : 'male'); }}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
                  >
                    <option value="male">男</option>
                    <option value="female">女</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">年龄 (5~120)</Label>
                  <Input
                    size="sm"
                    type="number"
                    value={profAge}
                    onChange={e => { setProfileDirty(true); setProfAge(e.target.value); }}
                    placeholder="28"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">身高 (cm)</Label>
                  <Input
                    size="sm"
                    type="number"
                    value={profHeight}
                    onChange={e => { setProfileDirty(true); setProfHeight(e.target.value); }}
                    placeholder="175"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">目标体重 (kg，可选)</Label>
                  <Input
                    size="sm"
                    type="number"
                    step="0.1"
                    value={profTarget}
                    onChange={e => { setProfileDirty(true); setProfTarget(e.target.value); }}
                    placeholder="70.0"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">默认单位</Label>
                  <select
                    value={profUnit}
                    onChange={e => { setProfileDirty(true); setProfUnit(e.target.value === 'jin' ? 'jin' : 'kg'); }}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
                  >
                    <option value="kg">kg</option>
                    <option value="jin">斤</option>
                  </select>
                </div>
                <div className="sm:col-span-3 flex flex-wrap items-center justify-between gap-2 pt-1">
                  <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <Checkbox
                      checked={profDefault}
                      onCheckedChange={v => { setProfileDirty(true); setProfDefault(Boolean(v)); }}
                    />
                    <span>设为默认成员档案</span>
                  </label>
                  <Button type="submit" size="sm" disabled={busy || authExpired}>保存成员档案</Button>
                </div>
              </form>
            </CardContent>
          </CollapsiblePanel>
        </Card>
      </Collapsible>

      {/* Manual Record Entry */}
      <Collapsible open={manualOpen} onOpenChange={setManualOpen}>
        <Card>
          <CardHeader className="pb-2">
            <CollapsibleTrigger render={<button type="button" className="flex w-full items-center justify-between text-left" />}>
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <PlusIcon className="size-4" />
                <span>手动补录体重 / 体脂记录</span>
              </span>
              <span className="text-xs text-muted-foreground">{manualOpen ? '收起' : '展开补录'}</span>
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsiblePanel>
            <CardContent>
              <form onSubmit={e => void addManualRecord(e)} className="grid gap-2 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label className="text-xs">体重</Label>
                  <Input size="sm" type="number" step="0.01" value={manWeight} onChange={e => setManWeight(e.target.value)} placeholder="如 70.5" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">单位</Label>
                  <select
                    value={manUnit}
                    onChange={e => setManUnit(e.target.value === 'jin' ? 'jin' : 'kg')}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
                  >
                    <option value="kg">kg</option>
                    <option value="jin">斤</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">生物电阻抗 (Ω，可选)</Label>
                  <Input size="sm" type="number" step="0.1" value={manImpedance} onChange={e => setManImpedance(e.target.value)} placeholder="如 510" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">静息心率 (bpm，可选)</Label>
                  <Input size="sm" type="number" value={manHr} onChange={e => setManHr(e.target.value)} placeholder="68" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">测量时间 (可选)</Label>
                  <Input size="sm" type="datetime-local" value={manTime} onChange={e => setManTime(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">备注</Label>
                  <Input size="sm" value={manNote} onChange={e => setManNote(e.target.value)} placeholder="如：晨起空腹" />
                </div>
                <div className="sm:col-span-3 flex justify-end pt-1">
                  <Button type="submit" size="sm" disabled={busy || authExpired}>写入健康档案</Button>
                </div>
              </form>
            </CardContent>
          </CollapsiblePanel>
        </Card>
      </Collapsible>

      {/* Records History */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">历史测量明细</CardTitle>
              <CardDescription className="text-xs">共 {filteredRecords.length} 条记录</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {filteredRecords.length > 60 && (
                <Button size="xs" variant="ghost" onClick={() => setShowAllRecords(v => !v)}>
                  {showAllRecords ? '收起至前 60 条' : `显示全部 (${filteredRecords.length} 条)`}
                </Button>
              )}
              {SOURCE_LABELS.map(src => (
                <Button
                  key={src.key}
                  size="xs"
                  variant={sourceFilter === src.key ? 'default' : 'outline'}
                  onClick={() => setSourceFilter(src.key)}
                >
                  {src.label}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filteredRecords.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">尚无匹配来源的测量记录。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">时间</TableHead>
                  <TableHead className="text-xs">来源</TableHead>
                  <TableHead className="text-xs">体重</TableHead>
                  <TableHead className="text-xs">体脂 / BMI</TableHead>
                  <TableHead className="text-xs">备注</TableHead>
                  <TableHead className="text-right text-xs">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(showAllRecords ? filteredRecords : filteredRecords.slice(0, 60)).map(r => {
                  const sb = sourceBadgeInfo(r.source);
                  const isInspected = inspectedRecord?.id === r.id;
                  return (
                    <TableRow key={r.id} className={isInspected ? 'bg-accent/50' : undefined}>
                      <TableCell className="font-mono text-xs">{timestamp(r.measuredAt)}</TableCell>
                      <TableCell><Badge variant={sb.variant}>{sb.text}</Badge></TableCell>
                      <TableCell className="font-mono text-xs font-medium">{fmtWeightUnit(r.weightKg, unit, 2)}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {r.metrics ? `${r.metrics.bodyFatPercent.toFixed(1)}% / ${r.metrics.bmi.toFixed(1)}` : '—'}
                      </TableCell>
                      <TableCell className="max-w-44 text-xs text-muted-foreground">
                        {r.note && r.note.length > 16 ? (
                          <button
                            type="button"
                            title={`${r.note}（点击查看完整备注）`}
                            onClick={() =>
                              setViewerPayload({
                                title: `测量记录完整备注 · ${fmtWeightUnit(r.weightKg, unit, 2)}`,
                                subtitle: `${timestamp(r.measuredAt)} · ${sb.text}${r.metrics ? ` · 体脂 ${r.metrics.bodyFatPercent.toFixed(1)}% · BMI ${r.metrics.bmi.toFixed(1)}` : ''}`,
                                content: r.note!,
                                mode: 'text',
                              })
                            }
                            className="block w-full cursor-pointer truncate text-start hover:text-foreground hover:underline"
                          >
                            {r.note}
                          </button>
                        ) : (
                          <span title={r.note || undefined} className="block truncate">{r.note || '—'}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1">
                          <Button size="xs" variant={isInspected ? 'secondary' : 'ghost'} onClick={() => setInspectedRecordId(r.id)}>
                            {isInspected ? '检视中' : '查看'}
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => setDeleteRecordTarget(r)} aria-label="删除记录">
                            <Trash2Icon className="size-3.5 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ConfirmActionDialog
        open={Boolean(deleteProfileTarget)}
        onOpenChange={open => { if (!open) setDeleteProfileTarget(null); }}
        title="删除成员档案"
        description={`确定删除成员档案「${deleteProfileTarget?.name ?? ''}」及其相关历史记录吗？`}
        confirmLabel="确认删除"
        busy={busy}
        onConfirm={confirmDeleteProfile}
      />

      <ConfirmActionDialog
        open={Boolean(deleteRecordTarget)}
        onOpenChange={open => { if (!open) setDeleteRecordTarget(null); }}
        title="删除测量记录"
        description={`确定删除 ${deleteRecordTarget ? timestamp(deleteRecordTarget.measuredAt) : ''} 的体重记录吗？`}
        confirmLabel="确认删除"
        busy={busy}
        onConfirm={confirmDeleteRecord}
      />

      <FullContentDialog payload={viewerPayload} onClose={() => setViewerPayload(null)} />
    </div>
  );
}

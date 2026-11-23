import { errorText, timestamp } from '@friday/web/shared/format.js';
import {
  BatteryChargingIcon,
  BikeIcon,
  MapPinIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmActionDialog } from '@/components/shared/ConfirmActionDialog';
import { ColumnBarChart, TrendLineChart, type ColumnBarDatum, type TrendPoint } from '@/components/shared/MetricCharts';
import { isSafePreviewImageUrl } from '@/components/shared/safeUrl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFriday } from '@/lib/friday-store';
import { useTheme } from '@/lib/theme';

type ChartGranularity = 'year' | 'month' | 'week' | 'day';
type ChartMetric = 'distance' | 'count';

interface NinebotSnapshot {
  sn: string;
  name: string;
  modelName: string;
  capturedAt: number;
  battery: number | null;
  auxBattery: number | null;
  voltageV: number | null;
  temperatureC: number | null;
  charging: boolean;
  chargingPowerW: number | null;
  remainChargeTime: string | null;
  effectiveRangeKm: number | null;
  odometerKm: number | null;
  powerOn: boolean;
  locked: boolean | null;
  location: { valid: boolean; address: string | null; shortAddress: string | null };
}

interface NinebotTripItem {
  travelId: string;
  date: string;
  startTime: number;
  startTimeMs?: number;
  endTime?: number;
  endTimeMs?: number;
  durationSec: number;
  distanceKm: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  usedElectricity?: number;
  month?: string;
}

interface NinebotTripPage {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  totalDistanceKm: number;
  totalDurationSec: number;
  maxSpeedKmh: number;
  items: NinebotTripItem[];
}

interface NinebotTripBucket {
  key: string;
  label: string;
  sublabel?: string;
  fullLabel: string;
  distanceKm: number;
  tripCount: number;
  durationSec: number;
  maxSpeedKmh: number;
  usedElectricity: number;
  drillGranularity?: 'month' | 'day';
  drillAnchor?: string;
}

interface NinebotTripAnalytics {
  granularity: ChartGranularity;
  anchorDate: string;
  anchorMonth: string;
  todayDate: string;
  todayMonth: string;
  periodLabel: string;
  prevAnchor: string;
  nextAnchor: string;
  canGoNext: boolean;
  availableMonths: string[];
  totals: {
    distanceKm: number;
    tripCount: number;
    durationSec: number;
    maxSpeedKmh: number;
    overallAvgSpeedKmh: number;
    usedElectricity: number;
  };
  buckets: NinebotTripBucket[];
}

interface NinebotTripSyncState {
  windowMonths: string[];
  currentMonth: string;
  completedMonths: string[];
  pendingMonths: string[];
  completedMonthCount: number;
  totalWindowMonths: number;
  yearComplete: boolean;
  totalCachedTrips: number;
  earliestTripSec: number | null;
  latestTripSec: number | null;
  lastSyncedAt: number | null;
}

interface TripsActionPayload {
  tripPage?: NinebotTripPage;
  tripAnalytics?: NinebotTripAnalytics;
  tripSync?: NinebotTripSyncState;
  syncBatch?: {
    syncedMonths?: string[];
    addedCount?: number;
    fetchedCount?: number;
  };
}

interface NinebotDashboardPayload {
  configured: boolean;
  vehicles?: Array<{ sn: string; name: string; modelName?: string }>;
  snapshot: NinebotSnapshot | null;
  vehicleImages?: { darkDataUrl: string | null; lightDataUrl: string | null };
  history: Array<{ capturedAt: number; battery: number | null; effectiveRangeKm: number | null }>;
  tripSummary: {
    tripCount: number;
    totalDistanceKm: number;
    todayCount: number;
    todayDistanceKm: number;
    maxSpeedKmh: number;
    trips: NinebotTripItem[];
  } | null;
  tripPage?: NinebotTripPage | null;
  tripAnalytics?: NinebotTripAnalytics | null;
  tripSync?: NinebotTripSyncState | null;
  activeAlerts: Array<{ key: string; lastNotifiedAt: number; lastValue: unknown }>;
  config: {
    preferredLine: 'motor' | 'ebike';
    defaultSn: string;
    areaCode: string;
    usernameMasked: string;
    hasPassword: boolean;
    hasSession: boolean;
    hasAmapKey: boolean;
    lowBatteryThreshold: number;
    minRangeKm: number;
    idleRemindDays: number;
    alertCooldownHours: number;
    checkUnlocked: boolean;
  };
}

const GRANULARITY_LABELS: Record<ChartGranularity, string> = {
  year: '年',
  month: '月',
  week: '周',
  day: '日',
};

const CURRENT_PERIOD_LABELS: Record<ChartGranularity, string> = {
  year: '近一年',
  month: '本月',
  week: '本周',
  day: '今天',
};

const CHART_TITLES: Record<ChartGranularity, string> = {
  year: '按月分布',
  month: '按日分布',
  week: '按周分布',
  day: '按小时分布',
};

function formatTripStart(startTime: number, fallbackDate?: string): string {
  if (!Number.isFinite(startTime) || startTime <= 0) {
    return fallbackDate || '—';
  }
  const ms = startTime > 1_000_000_000_000 ? startTime : startTime * 1000;
  return timestamp(ms);
}

function formatTripDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0 min';
  if (sec < 60) return `${Math.round(sec)} 秒`;
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatCompactMonthLabel(ym: string): string {
  return ym.length === 6 ? `${ym.slice(0, 4)}-${ym.slice(4)}` : ym;
}

export default function NinebotSurface() {
  const { authExpired, api, openSystemHub } = useFriday();
  const { theme: resolvedTheme } = useTheme();
  const [data, setData] = useState<NinebotDashboardPayload | null>(null);
  const [trendMetric, setTrendMetric] = useState<'battery' | 'range'>('battery');
  const [tripPage, setTripPage] = useState(1);
  const [chartGranularity, setChartGranularity] = useState<ChartGranularity>('year');
  const [chartAnchor, setChartAnchor] = useState('');
  const [chartMetric, setChartMetric] = useState<ChartMetric>('distance');
  const [tripsLoading, setTripsLoading] = useState(false);
  const [tripSyncing, setTripSyncing] = useState(false);
  const [tripSyncNote, setTripSyncNote] = useState<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);

  // Login & config with draftDirty guard
  const [draftDirty, setDraftDirty] = useState(false);
  const [areaCode, setAreaCode] = useState('86');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [preferredLine, setPreferredLine] = useState<'motor' | 'ebike'>('motor');
  const [lowBatt, setLowBatt] = useState('30');
  const [minRange, setMinRange] = useState('0');
  const [idleDays, setIdleDays] = useState('0');
  const [cooldownHours, setCooldownHours] = useState('12');
  const [checkUnlocked, setCheckUnlocked] = useState(false);
  const [dsKey, setDsKey] = useState('');

  const [clearCredsOpen, setClearCredsOpen] = useState(false);

  const seqRef = useRef(0);
  const tripsSeqRef = useRef(0);
  const viewStateRef = useRef<{ tripPage: number; chartGranularity: ChartGranularity; chartAnchor: string }>({
    tripPage: 1,
    chartGranularity: 'year',
    chartAnchor: '',
  });
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const callNinebot = useCallback(
    async <T,>(action: string, args: Record<string, unknown> = {}, timeoutMs?: number) => {
      return api<{ ok: boolean; message?: string; data?: T }>('/api/plugin-run', {
        plugin: 'ninebot',
        action,
        args,
        ...(timeoutMs ? { timeoutMs } : {}),
      }, timeoutMs ? { timeoutMs } : undefined);
    },
    [api],
  );

  const applyDashboard = useCallback(
    (d: NinebotDashboardPayload, forceSync = false) => {
      setData(d);
      if (d.tripPage?.page) {
        setTripPage(d.tripPage.page);
        viewStateRef.current.tripPage = d.tripPage.page;
      }
      if (!forceSync && draftDirty) return;
      setAreaCode(d.config.areaCode || '86');
      setPreferredLine(d.config.preferredLine === 'ebike' ? 'ebike' : 'motor');
      setLowBatt(String(d.config.lowBatteryThreshold ?? 30));
      setMinRange(String(d.config.minRangeKm ?? 0));
      setIdleDays(String(d.config.idleRemindDays ?? 0));
      setCooldownHours(String(d.config.alertCooldownHours ?? 12));
      setCheckUnlocked(Boolean(d.config.checkUnlocked));
    },
    [draftDirty],
  );

  const loadDashboard = useCallback(
    async (quiet = false) => {
      if (authExpired) return;
      const seq = ++seqRef.current;
      const { tripPage: curPage, chartGranularity: curGran, chartAnchor: curAnchor } = viewStateRef.current;
      try {
        const res = await callNinebot<NinebotDashboardPayload>('dashboard', {
          historyLimit: 96,
          tripPage: curPage,
          tripPageSize: 10,
          chartGranularity: curGran,
          ...(curAnchor ? { chartAnchor: curAnchor } : {}),
        });
        if (!mountedRef.current || seq !== seqRef.current || authExpired) return;
        if (res.ok && res.data) applyDashboard(res.data);
        else if (!quiet) setStatus({ text: res.message || '读取九号电摩看板失败', tone: 'err' });
      } catch (err) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        if (!quiet) setStatus({ text: errorText(err), tone: 'err' });
      }
    },
    [applyDashboard, authExpired, callNinebot],
  );

  useEffect(() => {
    void loadDashboard(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadTripsView = useCallback(
    async (next: { page?: number; granularity?: ChartGranularity; anchor?: string }) => {
      if (authExpired) return;
      const nextPage = next.page ?? viewStateRef.current.tripPage;
      const nextGran = next.granularity ?? viewStateRef.current.chartGranularity;
      const nextAnchor = next.anchor !== undefined ? next.anchor : viewStateRef.current.chartAnchor;

      viewStateRef.current = {
        tripPage: nextPage,
        chartGranularity: nextGran,
        chartAnchor: nextAnchor,
      };
      setTripPage(nextPage);
      setChartGranularity(nextGran);
      setChartAnchor(nextAnchor);

      const seq = ++tripsSeqRef.current;
      setTripsLoading(true);
      try {
        const res = await callNinebot<TripsActionPayload>('trips', {
          offline: true,
          tripPage: nextPage,
          tripPageSize: 10,
          chartGranularity: nextGran,
          ...(nextAnchor ? { chartAnchor: nextAnchor } : {}),
        }, 15_000);
        if (!mountedRef.current || seq !== tripsSeqRef.current || authExpired) return;
        if (res.ok && res.data) {
          setData(prev => {
            if (!prev) return prev;
            return {
              ...prev,
              ...(res.data?.tripPage ? { tripPage: res.data.tripPage } : {}),
              ...(res.data?.tripAnalytics ? { tripAnalytics: res.data.tripAnalytics } : {}),
              ...(res.data?.tripSync ? { tripSync: res.data.tripSync } : {}),
            };
          });
          if (res.data.tripPage?.page && res.data.tripPage.page !== nextPage) {
            setTripPage(res.data.tripPage.page);
            viewStateRef.current.tripPage = res.data.tripPage.page;
          }
        } else if (!res.ok) {
          setTripSyncNote({ text: res.message || '读取本地行程失败', tone: 'err' });
        }
      } catch (err) {
        if (!mountedRef.current || seq !== tripsSeqRef.current) return;
        setTripSyncNote({ text: errorText(err), tone: 'err' });
      } finally {
        if (mountedRef.current && seq === tripsSeqRef.current) {
          setTripsLoading(false);
        }
      }
    },
    [authExpired, callNinebot],
  );

  const runBusy = async (label: string, fn: () => Promise<void>) => {
    if (busy || tripSyncing || authExpired) return;
    setBusy(true);
    setStatus({ text: label, tone: 'warn' });
    try {
      await fn();
    } catch (err) {
      if (mountedRef.current) setStatus({ text: errorText(err), tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleSyncTrips = async () => {
    if (busy || tripSyncing || authExpired) return;
    setTripSyncing(true);
    setTripSyncNote({ text: '正在检查最新行程并同步近一年历史记录…', tone: 'warn' });
    try {
      let totalAdded = 0;
      let ranBackfill = false;
      for (let batchIdx = 0; batchIdx < 12; batchIdx++) {
        if (!mountedRef.current || authExpired) break;
        const { chartGranularity: curGran, chartAnchor: curAnchor } = viewStateRef.current;
        const res = await callNinebot<TripsActionPayload>('trips', {
          sync: 'year',
          maxMonths: 2,
          ...(batchIdx > 0 ? { skipCurrentIfSynced: true } : {}),
          tripPage: 1,
          tripPageSize: 10,
          chartGranularity: curGran,
          ...(curAnchor ? { chartAnchor: curAnchor } : {}),
        }, 90_000);
        if (!mountedRef.current || authExpired) break;
        if (!res.ok || !res.data) {
          const errText = res.message || '行程同步失败';
          setTripSyncNote({ text: errText, tone: 'err' });
          setStatus({ text: errText, tone: 'err' });
          break;
        }

        totalAdded += res.data.syncBatch?.addedCount ?? 0;
        if ((res.data.syncBatch?.syncedMonths?.length ?? 0) > 1 || !res.data.tripSync?.yearComplete) {
          ranBackfill = true;
        }

        setTripPage(1);
        viewStateRef.current.tripPage = 1;
        setData(prev => (prev ? {
          ...prev,
          ...(res.data?.tripPage ? { tripPage: res.data.tripPage } : {}),
          ...(res.data?.tripAnalytics ? { tripAnalytics: res.data.tripAnalytics } : {}),
          ...(res.data?.tripSync ? { tripSync: res.data.tripSync } : {}),
        } : prev));

        const syncInfo = res.data.tripSync;
        const pendingCount = syncInfo?.pendingMonths?.length ?? 0;
        if (syncInfo && !syncInfo.yearComplete && pendingCount > 0) {
          setTripSyncNote({
            text: `正在首次回溯近一年行程（已完成 ${syncInfo.completedMonthCount}/${syncInfo.totalWindowMonths} 个月，已新增 ${totalAdded} 段）…`,
            tone: 'warn',
          });
          continue;
        }

        const totalCached = syncInfo?.totalCachedTrips ?? res.data.tripPage?.totalCount ?? 0;
        const doneMsg = ranBackfill
          ? `近一年行程同步完成（12 个月，本次新增 ${totalAdded} 段，共缓存 ${totalCached} 段）。`
          : `已完成增量同步（本次新增 ${totalAdded} 段，共缓存 ${totalCached} 段）。`;
        setTripSyncNote({ text: doneMsg, tone: 'ok' });
        setStatus({ text: doneMsg, tone: 'ok' });
        break;
      }
    } catch (err) {
      if (mountedRef.current) {
        const msg = errorText(err);
        setTripSyncNote({ text: msg, tone: 'err' });
        setStatus({ text: msg, tone: 'err' });
      }
    } finally {
      if (mountedRef.current) setTripSyncing(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setStatus({ text: '请输入九号账号手机号与密码。', tone: 'warn' });
      return;
    }
    const pwd = password;
    setPassword('');
    await runBusy('正在登录九号账号并自动发现绑定车辆…', async () => {
      const res = await callNinebot('login', { username: username.trim(), password: pwd, areaCode }, 30_000);
      setStatus({ text: res.message || (res.ok ? '登录成功' : '登录失败'), tone: res.ok ? 'ok' : 'err' });
      if (res.ok) {
        setDraftDirty(false);
        await callNinebot('status', {}, 30_000).catch(() => undefined);
        await callNinebot('trips', { sync: 'incremental', tripPage: 1, tripPageSize: 10 }, 45_000).catch(() => undefined);
      }
      await loadDashboard(true);
    });
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    await runBusy('正在保存九号守护配置…', async () => {
      const args: Record<string, unknown> = {
        preferredLine,
        lowBatteryThreshold: Number(lowBatt) || 30,
        minRangeKm: Number(minRange) || 0,
        idleRemindDays: Number(idleDays) || 0,
        alertCooldownHours: Number(cooldownHours) || 12,
        checkUnlocked,
      };
      if (dsKey.trim()) args.deviceServiceKey = dsKey.trim();
      const res = await callNinebot('config', args);
      setStatus({ text: res.message || (res.ok ? '配置已保存' : '保存失败'), tone: res.ok ? 'ok' : 'err' });
      if (res.ok) {
        setDsKey('');
        setDraftDirty(false);
      }
      await loadDashboard(true);
    });
  };

  const trendPoints = useMemo<TrendPoint[]>(() => {
    return (data?.history ?? [])
      .slice()
      .sort((a, b) => a.capturedAt - b.capturedAt)
      .map(pt => ({
        label: new Date(pt.capturedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        value: Number(trendMetric === 'battery' ? (pt.battery ?? 0) : (pt.effectiveRangeKm ?? 0)),
      }));
  }, [data?.history, trendMetric]);

  const analytics = data?.tripAnalytics ?? null;
  const tripSync = data?.tripSync ?? null;
  const chartItems = useMemo<ColumnBarDatum[]>(() => {
    if (!analytics?.buckets?.length) return [];
    return analytics.buckets.map(b => ({
      key: b.key,
      label: b.label,
      sublabel: b.sublabel,
      fullLabel: b.fullLabel,
      value: chartMetric === 'distance' ? b.distanceKm : b.tripCount,
      hint: `${b.distanceKm.toFixed(2)} km · ${b.tripCount} 段 · ${formatTripDuration(b.durationSec)}${b.maxSpeedKmh > 0 ? ` · 极速 ${b.maxSpeedKmh.toFixed(1)} km/h` : ''}`,
      clickable: Boolean(b.drillGranularity && b.drillAnchor),
    }));
  }, [analytics, chartMetric]);

  const tripPageData = data?.tripPage ?? null;
  const tripPageItems = tripPageData?.items ?? data?.tripSummary?.trips ?? [];
  const tripTotalCount = tripPageData?.totalCount ?? data?.tripSummary?.tripCount ?? 0;
  const tripTotalDistance = tripPageData?.totalDistanceKm ?? data?.tripSummary?.totalDistanceKm ?? 0;
  const tripMaxSpeed = tripPageData?.maxSpeedKmh ?? data?.tripSummary?.maxSpeedKmh ?? 0;
  const currentPage = tripPageData?.page ?? tripPage;
  const totalPages = tripPageData?.totalPages ?? 1;
  const pageSize = tripPageData?.pageSize ?? 10;
  const startRow = tripTotalCount > 0 ? (currentPage - 1) * pageSize + 1 : 0;
  const endRow = tripTotalCount > 0 ? startRow + tripPageItems.length - 1 : 0;

  const snap = data?.snapshot;
  const rawImg = resolvedTheme === 'dark' ? data?.vehicleImages?.darkDataUrl : data?.vehicleImages?.lightDataUrl;
  const safeVehicleImg = isSafePreviewImageUrl(rawImg) ? rawImg! : '';
  const actionDisabled = busy || tripSyncing;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <BikeIcon className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">九号电动 · 车况监控与骑行轨迹</h3>
          {(data?.vehicles?.length ?? 0) > 1 && (
            <select
              aria-label="选择车辆"
              value={snap?.sn || data?.config.defaultSn || ''}
              disabled={actionDisabled}
              onChange={e => {
                const sn = e.target.value;
                void runBusy(`切换车辆 ${sn}…`, async () => {
                  const res = await callNinebot('vehicles', { selectSn: sn }, 20_000);
                  setStatus({ text: res.message || '已切换车辆', tone: res.ok ? 'ok' : 'err' });
                  setTripPage(1);
                  viewStateRef.current.tripPage = 1;
                  await loadDashboard(true);
                });
              }}
              className="h-7 rounded-md border border-input bg-background px-2 text-xs outline-none"
            >
              {data?.vehicles?.map(v => <option key={v.sn} value={v.sn}>{v.name || v.sn}</option>)}
            </select>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" onClick={() => openSystemHub('services')}>
            <MapPinIcon className="size-3.5" />
            <span>高德 Key ({data?.config.hasAmapKey ? '已配' : '未配'})</span>
          </Button>
          <Button size="xs" variant="outline" disabled={actionDisabled} onClick={() => void runBusy('同步九号车况与新增行程…', async () => {
            const res = await callNinebot('status', {}, 30_000);
            if (res.ok) {
              try {
                const tripRes = await callNinebot('trips', { sync: 'incremental', tripPage: 1, tripPageSize: 10 }, 45_000);
                if (!tripRes.ok) {
                  setTripSyncNote({ text: tripRes.message || '增量同步最新行程失败', tone: 'warn' });
                } else {
                  setTripPage(1);
                  viewStateRef.current.tripPage = 1;
                }
              } catch (err) {
                setTripSyncNote({ text: `车况已同步，行程增量更新失败：${errorText(err)}`, tone: 'warn' });
              }
            }
            setStatus({ text: res.message || '同步完成', tone: res.ok ? 'ok' : 'err' });
            await loadDashboard(true);
          })}>
            <RefreshCwIcon className="size-3.5" />
            <span>同步车况</span>
          </Button>
          <Button size="xs" disabled={actionDisabled} onClick={() => void runBusy('执行安全与补能巡检…', async () => {
            const res = await callNinebot('patrol', { force: true }, 30_000);
            setStatus({ text: res.message || '巡检完成', tone: res.ok ? 'ok' : 'err' });
            await loadDashboard(true);
          })}>
            <ShieldCheckIcon className="size-3.5" />
            <span>安全巡检</span>
          </Button>
        </div>
      </div>

      {status && (
        <Alert variant={status.tone === 'err' ? 'error' : status.tone === 'warn' ? 'warning' : 'success'}>
          <AlertDescription className="text-xs">{status.text}</AlertDescription>
        </Alert>
      )}

      {/* Vehicle Hero */}
      {snap && (
        <div className="grid gap-3 md:grid-cols-3">
          <Card className="md:col-span-2">
            <CardHeader className="pb-1">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm">{snap.name || snap.modelName} ({snap.sn})</CardTitle>
                <div className="flex gap-1">
                  {snap.charging && <Badge variant="success"><BatteryChargingIcon className="size-3 me-1" />充电中</Badge>}
                  <Badge variant={snap.locked ? 'success' : 'warning'}>{snap.locked ? '已锁车' : '未锁车'}</Badge>
                </div>
              </div>
              <CardDescription className="text-xs">{snap.location.shortAddress || snap.location.address || '位置未知'}</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 text-xs">
              <div><div className="text-muted-foreground">主电池</div><div className="font-mono text-lg font-semibold">{snap.battery ?? '--'}%</div></div>
              <div><div className="text-muted-foreground">预估续航</div><div className="font-mono text-lg font-semibold">{snap.effectiveRangeKm ?? '--'} km</div></div>
              <div><div className="text-muted-foreground">总里程</div><div className="font-mono text-lg font-semibold">{snap.odometerKm ?? '--'} km</div></div>
              <div><div className="text-muted-foreground">电池温度/电压</div><div className="font-mono text-sm font-semibold">{snap.temperatureC ?? '--'}℃ · {snap.voltageV ?? '--'}V</div></div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex h-full items-center justify-center p-3">
              {safeVehicleImg ? (
                <img src={safeVehicleImg} alt={snap.modelName} className="max-h-36 object-contain" />
              ) : (
                <div className="text-xs text-muted-foreground">暂无车辆渲染图</div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Active Alerts */}
      {data?.activeAlerts?.length ? (
        <Alert variant="warning">
          <AlertDescription className="text-xs">
            当前活跃告警 ({data.activeAlerts.length})：{data.activeAlerts.map(a => `${a.key}=${String(a.lastValue)}`).join(' · ')}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Trend Chart */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-sm">电量与续航曲线</CardTitle>
            <div className="flex gap-1">
              <Button size="xs" variant={trendMetric === 'battery' ? 'default' : 'outline'} onClick={() => setTrendMetric('battery')}>
                主电池 %
              </Button>
              <Button size="xs" variant={trendMetric === 'range' ? 'default' : 'outline'} onClick={() => setTrendMetric('range')}>
                精准续航 km
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <TrendLineChart
            points={trendPoints}
            primaryLabel={trendMetric === 'battery' ? '主电池电量' : '预估续航'}
            unit={trendMetric === 'battery' ? '%' : ' km'}
          />
        </CardContent>
      </Card>

      {/* Yearly / Monthly / Weekly / Daily Riding Bar Chart */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-sm">近一年骑行统计</CardTitle>
              {tripSync && (
                <Badge variant={tripSync.yearComplete ? 'success' : 'outline'}>
                  {tripSync.yearComplete
                    ? '已同步近 12 个月'
                    : `已同步 ${tripSync.completedMonthCount}/${tripSync.totalWindowMonths} 个月`}
                </Badge>
              )}
              {tripSync && !tripSync.yearComplete && (
                <Button size="xs" variant="outline" disabled={actionDisabled} onClick={() => void handleSyncTrips()}>
                  同步近一年
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <div className="flex gap-1">
                {(['year', 'month', 'week', 'day'] as const).map(g => (
                  <Button
                    key={g}
                    size="xs"
                    variant={chartGranularity === g ? 'default' : 'outline'}
                    disabled={tripsLoading}
                    onClick={() => void loadTripsView({ granularity: g })}
                  >
                    {GRANULARITY_LABELS[g]}
                  </Button>
                ))}
              </div>
              <div className="flex gap-1">
                <Button
                  size="xs"
                  variant={chartMetric === 'distance' ? 'secondary' : 'outline'}
                  onClick={() => setChartMetric('distance')}
                >
                  里程 km
                </Button>
                <Button
                  size="xs"
                  variant={chartMetric === 'count' ? 'secondary' : 'outline'}
                  onClick={() => setChartMetric('count')}
                >
                  段数
                </Button>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1">
              <Button
                size="xs"
                variant="outline"
                disabled={tripsLoading || !analytics}
                onClick={() => analytics && void loadTripsView({ anchor: analytics.prevAnchor })}
              >
                ← 上期
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={tripsLoading || !analytics || !analytics.canGoNext}
                onClick={() => void loadTripsView({ anchor: '' })}
              >
                {CURRENT_PERIOD_LABELS[chartGranularity]}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={tripsLoading || !analytics || !analytics.canGoNext}
                onClick={() => analytics && void loadTripsView({ anchor: analytics.nextAnchor })}
              >
                下期 →
              </Button>
              {analytics && (
                <span className="ms-1 text-xs font-medium text-foreground">{analytics.periodLabel}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {chartGranularity === 'month' && analytics && analytics.availableMonths.length > 0 && (
                <select
                  aria-label="选择月份"
                  value={analytics.anchorMonth}
                  disabled={tripsLoading}
                  onChange={e => {
                    const ym = e.target.value;
                    if (ym.length === 6) {
                      void loadTripsView({ granularity: 'month', anchor: `${ym.slice(0, 4)}-${ym.slice(4)}-01` });
                    }
                  }}
                  className="h-7 rounded-md border border-input bg-background px-2 font-mono text-xs outline-none"
                >
                  {analytics.availableMonths.map(ym => (
                    <option key={ym} value={ym}>{formatCompactMonthLabel(ym)}</option>
                  ))}
                </select>
              )}
              {(chartGranularity === 'week' || chartGranularity === 'day') && analytics && (
                <Input
                  size="sm"
                  type="date"
                  aria-label="选择日期"
                  className="w-36 font-mono"
                  value={analytics.anchorDate}
                  max={analytics.todayDate}
                  disabled={tripsLoading}
                  onChange={e => {
                    if (e.target.value) {
                      void loadTripsView({ anchor: e.target.value });
                    }
                  }}
                />
              )}
            </div>
          </div>

          {analytics && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="rounded-lg border bg-muted/20 p-2.5">
                <div className="text-muted-foreground">骑行里程</div>
                <div className="font-mono text-base font-semibold">{analytics.totals.distanceKm.toFixed(1)} km</div>
              </div>
              <div className="rounded-lg border bg-muted/20 p-2.5">
                <div className="text-muted-foreground">骑行段数</div>
                <div className="font-mono text-base font-semibold">{analytics.totals.tripCount} 段</div>
              </div>
              <div className="rounded-lg border bg-muted/20 p-2.5">
                <div className="text-muted-foreground">累计耗时</div>
                <div className="font-mono text-base font-semibold">{formatTripDuration(analytics.totals.durationSec)}</div>
              </div>
              <div className="rounded-lg border bg-muted/20 p-2.5">
                <div className="text-muted-foreground">最高极速</div>
                <div className="font-mono text-base font-semibold">{analytics.totals.maxSpeedKmh.toFixed(1)} km/h</div>
              </div>
            </div>
          )}

          <ColumnBarChart
            items={chartItems}
            title={CHART_TITLES[chartGranularity]}
            formatValue={v => (chartMetric === 'distance' ? `${v.toFixed(1)} km` : `${Math.round(v)} 段`)}
            onSelect={(item) => {
              const bucket = analytics?.buckets.find(b => b.key === item.key);
              if (bucket?.drillGranularity && bucket.drillAnchor) {
                void loadTripsView({ granularity: bucket.drillGranularity, anchor: bucket.drillAnchor });
              }
            }}
          />
        </CardContent>
      </Card>

      {/* Trips (Latest-First Paginated) */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">骑行轨迹 ({tripTotalCount} 段)</CardTitle>
              <CardDescription className="text-xs">
                累计 {tripTotalDistance.toFixed(1)} km · 极速 {tripMaxSpeed.toFixed(1)} km/h
              </CardDescription>
            </div>
            <Button size="xs" variant="outline" disabled={actionDisabled} onClick={() => void handleSyncTrips()}>
              <RefreshCwIcon className={tripSyncing ? 'size-3.5 animate-spin' : 'size-3.5'} />
              <span>{tripSyncing ? '同步中…' : '同步行程'}</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {tripSyncNote && (
            <Alert variant={tripSyncNote.tone === 'err' ? 'error' : tripSyncNote.tone === 'warn' ? 'warning' : 'success'}>
              <AlertDescription className="text-xs">{tripSyncNote.text}</AlertDescription>
            </Alert>
          )}

          {!tripPageItems.length ? (
            <p className="py-4 text-center text-xs text-muted-foreground">暂无行程记录，点击右上角「同步行程」获取近一年数据。</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">时间</TableHead>
                    <TableHead className="text-xs">里程</TableHead>
                    <TableHead className="text-xs">均速 / 极速</TableHead>
                    <TableHead className="text-xs">耗时</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tripPageItems.map(t => (
                    <TableRow key={t.travelId}>
                      <TableCell className="font-mono text-xs">{formatTripStart(t.startTime, t.date)}</TableCell>
                      <TableCell className="font-mono text-xs font-medium">{t.distanceKm.toFixed(2)} km</TableCell>
                      <TableCell className="font-mono text-xs">{t.avgSpeedKmh.toFixed(1)} / {t.maxSpeedKmh.toFixed(1)} km/h</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{formatTripDuration(t.durationSec)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
                <span>
                  第 {currentPage} / {totalPages} 页 · 第 {startRow}–{endRow} 段（共 {tripTotalCount} 段）
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={tripsLoading || currentPage <= 1}
                    onClick={() => void loadTripsView({ page: 1 })}
                  >
                    最新
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={tripsLoading || currentPage <= 1}
                    onClick={() => void loadTripsView({ page: currentPage - 1 })}
                  >
                    上一页
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={tripsLoading || currentPage >= totalPages}
                    onClick={() => void loadTripsView({ page: currentPage + 1 })}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Account & Config */}
      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">九号账号认证 ({data?.config.usernameMasked || '未登录'})</CardTitle>
              {data?.config.hasSession && (
                <Button size="xs" variant="ghost" onClick={() => setClearCredsOpen(true)}>
                  <Trash2Icon className="size-3.5 text-destructive" />
                  <span>清除凭据</span>
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={e => void handleLogin(e)} className="space-y-2 text-xs">
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">区号</Label>
                  <Input size="sm" value={areaCode} onChange={e => { setDraftDirty(true); setAreaCode(e.target.value); }} />
                </div>
                <div className="space-y-1 col-span-2">
                  <Label className="text-xs">手机号</Label>
                  <Input size="sm" value={username} onChange={e => { setDraftDirty(true); setUsername(e.target.value); }} placeholder="九号账号手机号" />
                </div>
              </div>
              <div className="flex items-end gap-2">
                <div className="space-y-1 flex-1">
                  <Label className="text-xs">登录密码</Label>
                  <Input size="sm" type="password" value={password} onChange={e => setPassword(e.target.value)} />
                </div>
                <Button type="submit" size="sm" disabled={actionDisabled}>登录发现车辆</Button>
              </div>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">巡检告警配置</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={e => void handleSaveConfig(e)} className="grid grid-cols-2 gap-2 text-xs">
              <div className="space-y-1">
                <Label className="text-xs">业务线</Label>
                <select
                  value={preferredLine}
                  onChange={e => { setDraftDirty(true); setPreferredLine(e.target.value === 'ebike' ? 'ebike' : 'motor'); }}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
                >
                  <option value="motor">电摩</option>
                  <option value="ebike">新国标电自</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">低电量告警(%)</Label>
                <Input size="sm" type="number" value={lowBatt} onChange={e => { setDraftDirty(true); setLowBatt(e.target.value); }} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">低续航提醒(km)</Label>
                <Input size="sm" type="number" value={minRange} onChange={e => { setDraftDirty(true); setMinRange(e.target.value); }} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">冷却时间(小时)</Label>
                <Input size="sm" type="number" value={cooldownHours} onChange={e => { setDraftDirty(true); setCooldownHours(e.target.value); }} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">闲置提醒(天)</Label>
                <Input size="sm" type="number" value={idleDays} onChange={e => { setDraftDirty(true); setIdleDays(e.target.value); }} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">官方开放 Key (可选)</Label>
                <Input size="sm" type="password" value={dsKey} onChange={e => setDsKey(e.target.value)} placeholder="留空不改" />
              </div>
              <div className="col-span-2 flex items-center justify-between pt-1">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <Checkbox checked={checkUnlocked} onCheckedChange={v => { setDraftDirty(true); setCheckUnlocked(Boolean(v)); }} />
                  <span>检查未锁车告警</span>
                </label>
                <Button type="submit" size="sm" disabled={actionDisabled}>保存配置</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>

      <ConfirmActionDialog
        open={clearCredsOpen}
        onOpenChange={setClearCredsOpen}
        title="清除九号账号凭据"
        description="确定清除已保存的九号账号密码、本地会话及巡检凭据吗？"
        confirmLabel="确认清除"
        busy={actionDisabled}
        onConfirm={async () => {
          setClearCredsOpen(false);
          await runBusy('清除九号账号凭据…', async () => {
            const res = await callNinebot('config', { clearCredentials: true });
            setStatus({ text: res.message || '已清除凭据', tone: res.ok ? 'ok' : 'err' });
            setDraftDirty(false);
            await loadDashboard(true);
          });
        }}
      />
    </div>
  );
}

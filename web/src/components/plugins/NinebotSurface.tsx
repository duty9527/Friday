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
import { TrendLineChart, type TrendPoint } from '@/components/shared/MetricCharts';
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
    trips: Array<{ travelId: string; date: string; startTime: number; durationSec: number; distanceKm: number; maxSpeedKmh: number; avgSpeedKmh: number }>;
  } | null;
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

export default function NinebotSurface() {
  const { authExpired, api, openSystemHub } = useFriday();
  const { theme: resolvedTheme } = useTheme();
  const [data, setData] = useState<NinebotDashboardPayload | null>(null);
  const [trendMetric, setTrendMetric] = useState<'battery' | 'range'>('battery');
  const [tripMonth, setTripMonth] = useState('');
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
      }, timeoutMs ? { timeoutMs } : undefined);
    },
    [api],
  );

  const applyDashboard = useCallback(
    (d: NinebotDashboardPayload, forceSync = false) => {
      setData(d);
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
      try {
        const res = await callNinebot<NinebotDashboardPayload>('dashboard', { historyLimit: 96, tripLimit: 20 });
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

  const runBusy = async (label: string, fn: () => Promise<void>) => {
    if (busy || authExpired) return;
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
        await callNinebot('trips', { limit: 20 }, 30_000).catch(() => undefined);
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

  const snap = data?.snapshot;
  const rawImg = resolvedTheme === 'dark' ? data?.vehicleImages?.darkDataUrl : data?.vehicleImages?.lightDataUrl;
  const safeVehicleImg = isSafePreviewImageUrl(rawImg) ? rawImg! : '';

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
              disabled={busy}
              onChange={e => {
                const sn = e.target.value;
                void runBusy(`切换车辆 ${sn}…`, async () => {
                  const res = await callNinebot('vehicles', { selectSn: sn }, 20_000);
                  setStatus({ text: res.message || '已切换车辆', tone: res.ok ? 'ok' : 'err' });
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
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void runBusy('同步九号车况与本月行程…', async () => {
            const res = await callNinebot('status', {}, 30_000);
            if (res.ok) await callNinebot('trips', { limit: 20 }, 30_000).catch(() => undefined);
            setStatus({ text: res.message || '同步完成', tone: res.ok ? 'ok' : 'err' });
            await loadDashboard(true);
          })}>
            <RefreshCwIcon className="size-3.5" />
            <span>同步车况</span>
          </Button>
          <Button size="xs" disabled={busy} onClick={() => void runBusy('执行安全与补能巡检…', async () => {
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

      {/* Trips */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">骑行轨迹 ({data?.tripSummary?.tripCount ?? 0} 段)</CardTitle>
              <CardDescription className="text-xs">
                累计 {data?.tripSummary?.totalDistanceKm ?? 0} km · 极速 {data?.tripSummary?.maxSpeedKmh ?? 0} km/h
              </CardDescription>
            </div>
            <div className="flex items-center gap-1.5">
              <Input size="sm" className="w-28" placeholder="YYYYMM" value={tripMonth} onChange={e => setTripMonth(e.target.value)} />
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void runBusy('同步行程轨迹…', async () => {
                const res = await callNinebot('trips', { limit: 20, ...(tripMonth.trim() ? { month: tripMonth.trim() } : {}) }, 30_000);
                setStatus({ text: res.message || '行程同步完成', tone: res.ok ? 'ok' : 'err' });
                await loadDashboard(true);
              })}>
                同步行程
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {!(data?.tripSummary?.trips?.length) ? (
            <p className="py-4 text-center text-xs text-muted-foreground">暂无行程记录。</p>
          ) : (
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
                {data.tripSummary.trips.map(t => (
                  <TableRow key={t.travelId}>
                    <TableCell className="font-mono text-xs">{timestamp(t.startTime)}</TableCell>
                    <TableCell className="font-mono text-xs font-medium">{t.distanceKm.toFixed(2)} km</TableCell>
                    <TableCell className="font-mono text-xs">{t.avgSpeedKmh.toFixed(1)} / {t.maxSpeedKmh.toFixed(1)} km/h</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{Math.round(t.durationSec / 60)} min</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
                <Button type="submit" size="sm" disabled={busy}>登录发现车辆</Button>
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
                  <option value="motor">电摩 (motor)</option>
                  <option value="ebike">新国标电自 (ebike)</option>
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
                <Button type="submit" size="sm" disabled={busy}>保存配置</Button>
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
        busy={busy}
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

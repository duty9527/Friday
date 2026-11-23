import { errorText, timestamp } from '@friday/web/shared/format.js';
import {
  BluetoothIcon,
  CheckCircle2Icon,
  PowerIcon,
  RadioIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  SquareIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmActionDialog } from '@/components/shared/ConfirmActionDialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFriday } from '@/lib/friday-store';

interface ModeSlot {
  strength: number;
  range: number;
  speed: number;
}

interface LaifenDeviceState {
  mac: string;
  name: string;
  protocol: string;
  rssi: number | null;
  batteryPct: number | null;
  activeMode: number;
  modes: Record<string, ModeSlot>;
  durationSec: number;
  highFrequency: boolean;
  reminder30s: boolean;
  airplaneMode: boolean;
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

interface LaifenDashboardPayload {
  batteryPct: number | null;
  todayCount: number;
  streakDays: number;
  brushHeadDaysLeft: number;
  device: LaifenDeviceState | null;
  stats: {
    todayCount: number;
    todayDurationSec: number;
    dailyGoalCount: number;
    streakDays: number;
    totalSessions: number;
    last7Days: Array<{ date: string; label: string; count: number; totalDurationSec: number; goalMet: boolean }>;
    brushHead: { daysUsed: number; daysLeft: number; percentLeft: number; needsReplacement: boolean };
  };
  sessions: LaifenBrushSession[];
  liveSession: { phase: string; message: string; activeBrushingSec: number; brushingActive?: boolean } | null;
  watchStatus?: { enabled: boolean; phase: string; message: string };
  pendingPatch?: { patchId: string; patch: Record<string, unknown>; queuedAt: number } | null;
  presets: LaifenPreset[];
  config: { targetMac: string; namePrefix: string; brushHeadLifespanDays: number; dailyGoalCount: number };
}

const ACTIVE_PHASES = new Set(['scanning', 'connecting', 'monitoring', 'reconnecting']);

export default function LaifenSurface() {
  const { authExpired, api } = useFriday();
  const [data, setData] = useState<LaifenDashboardPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);

  // Brush parameter controls with draftDirty guard
  const [draftDirty, setDraftDirty] = useState(false);
  const [mode, setMode] = useState(1);
  const [strength, setStrength] = useState(5);
  const [range, setRange] = useState(5);
  const [speed, setSpeed] = useState(5);
  const [durationSec, setDurationSec] = useState('120');
  const [highFrequency, setHighFrequency] = useState(false);
  const [reminder30s, setReminder30s] = useState(true);
  const [airplaneMode, setAirplaneMode] = useState(false);

  // V2Pro extended flags
  const [deepClean, setDeepClean] = useState(false);
  const [antiSplash, setAntiSplash] = useState(true);
  const [powerRampUp, setPowerRampUp] = useState(true);
  const [bristleProtection, setBristleProtection] = useState(true);
  const [liftToWake, setLiftToWake] = useState(true);
  const [overPressureLevel, setOverPressureLevel] = useState('medium');

  // Config inputs
  const [cfgMac, setCfgMac] = useState('');
  const [cfgPrefix, setCfgPrefix] = useState('LFTB');
  const [cfgLifespan, setCfgLifespan] = useState('90');
  const [cfgGoal, setCfgGoal] = useState('2');

  const [resetHeadOpen, setResetHeadOpen] = useState(false);
  const [delSessionTarget, setDelSessionTarget] = useState<LaifenBrushSession | null>(null);

  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const callLaifen = useCallback(
    async <T,>(action: string, args: Record<string, unknown> = {}, timeoutMs?: number, signal?: AbortSignal) => {
      return api<{ ok: boolean; message?: string; data?: T }>('/api/plugin-run', {
        plugin: 'laifen',
        action,
        args,
      }, { ...(timeoutMs ? { timeoutMs } : {}), ...(signal ? { signal } : {}) });
    },
    [api],
  );

  const applyDashboard = useCallback(
    (d: LaifenDashboardPayload, forceSync = false) => {
      setData(d);
      if (!forceSync && draftDirty) return;
      if (d.device) {
        const m = d.device.activeMode || 1;
        const slot = d.device.modes[String(m)];
        setMode(m);
        if (slot) {
          setStrength(slot.strength);
          setRange(slot.range);
          setSpeed(slot.speed);
        }
        setDurationSec(String(d.device.durationSec || 120));
        setHighFrequency(Boolean(d.device.highFrequency));
        setReminder30s(Boolean(d.device.reminder30s));
        setAirplaneMode(Boolean(d.device.airplaneMode));
      }
      setCfgMac(d.config.targetMac || '');
      setCfgPrefix(d.config.namePrefix || 'LFTB');
      setCfgLifespan(String(d.config.brushHeadLifespanDays || 90));
      setCfgGoal(String(d.config.dailyGoalCount || 2));
    },
    [draftDirty],
  );

  const refreshDashboard = useCallback(
    async (quiet = false) => {
      if (authExpired) return;
      const seq = ++seqRef.current;
      try {
        const res = await callLaifen<LaifenDashboardPayload>('dashboard', { limit: 30 });
        if (!mountedRef.current || seq !== seqRef.current || authExpired) return;
        if (res.ok && res.data) applyDashboard(res.data);
        else if (!quiet) setStatus({ text: res.message || '读取口腔护理看板失败', tone: 'err' });
      } catch (err) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        if (!quiet) setStatus({ text: errorText(err), tone: 'err' });
      }
    },
    [applyDashboard, authExpired, callLaifen],
  );

  useEffect(() => {
    void refreshDashboard(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll live BLE / monitor phase when active
  const isLiveActive = ACTIVE_PHASES.has(data?.liveSession?.phase || '') || data?.watchStatus?.phase === 'brushing';
  useEffect(() => {
    if (!isLiveActive || authExpired) return;
    const ac = new AbortController();
    const timer = setInterval(() => {
      if (document.hidden || ac.signal.aborted) return;
      void callLaifen<LaifenDashboardPayload>('dashboard', { limit: 15 }, undefined, ac.signal)
        .then(res => {
          if (mountedRef.current && res.ok && res.data) applyDashboard(res.data);
        })
        .catch(() => undefined);
    }, 1500);
    return () => {
      clearInterval(timer);
      ac.abort();
    };
  }, [applyDashboard, authExpired, callLaifen, isLiveActive]);

  const runAction = async (label: string, fn: () => Promise<void>) => {
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

  const buildSetArgs = (extras: Record<string, unknown> = {}) => {
    const args: Record<string, unknown> = {
      mode,
      strength,
      range,
      speed,
      durationSec: Number(durationSec) || 120,
      highFrequency,
      reminder30s,
      airplaneMode,
      ...extras,
    };
    if (data?.device?.protocol === 'v2pro') {
      args.deepClean = deepClean;
      args.antiSplash = antiSplash;
      args.powerRampUp = powerRampUp;
      args.bristleProtection = bristleProtection;
      args.liftToWake = liftToWake;
      args.overPressureLevel = overPressureLevel;
    }
    return args;
  };

  const saveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    const lifespan = Number(cfgLifespan);
    const goal = Number(cfgGoal);
    if (!Number.isFinite(lifespan) || lifespan < 15 || lifespan > 365) {
      setStatus({ text: '刷头更换周期需在 15 ~ 365 天之间。', tone: 'warn' });
      return;
    }
    if (!Number.isFinite(goal) || goal < 1 || goal > 6) {
      setStatus({ text: '每日目标次数需在 1 ~ 6 次之间。', tone: 'warn' });
      return;
    }
    await runAction('正在保存牙刷配置…', async () => {
      const res = await callLaifen('config', {
        targetMac: cfgMac.trim(),
        namePrefix: cfgPrefix.trim() || 'LFTB',
        brushHeadLifespanDays: lifespan,
        dailyGoalCount: goal,
      });
      setStatus({ text: res.message || (res.ok ? '配置已保存' : '保存失败'), tone: res.ok ? 'ok' : 'err' });
      if (res.ok) setDraftDirty(false);
      await refreshDashboard(true);
    });
  };

  const st = data?.stats;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <BluetoothIcon className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">徕芬电动牙刷 · BLE 控齿与护理记录</h3>
          {data?.device && <Badge variant="outline">{data.device.protocol.toUpperCase()} · 电量 {data.batteryPct ?? '--'}%</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAction('正在扫描绑定牙刷…', async () => {
            const res = await callLaifen('scan', { timeoutSec: 5, bind: true }, 25_000);
            if (res.ok) setDraftDirty(false);
            setStatus({ text: res.message || '扫描完毕', tone: res.ok ? 'ok' : 'err' });
            await refreshDashboard(true);
          })}>
            <BluetoothIcon className="size-3.5" />
            <span>扫描绑定</span>
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAction('正在连接牙刷同步电量与参数…', async () => {
            const res = await callLaifen('sync', { timeoutSec: 25 }, 60_000);
            if (res.ok) setDraftDirty(false);
            setStatus({ text: res.message || '同步完成', tone: res.ok ? 'ok' : 'err' });
            await refreshDashboard(true);
          })}>
            <RefreshCwIcon className="size-3.5" />
            <span>同步电控</span>
          </Button>
          <Button size="xs" disabled={busy} onClick={() => void runAction('正在记录本次刷牙打卡…', async () => {
            const res = await callLaifen('session-add', { durationSec: Number(durationSec) || 120, mode, note: '面板手动打卡' });
            setStatus({ text: res.message || '打卡成功', tone: res.ok ? 'ok' : 'err' });
            await refreshDashboard(true);
          })}>
            <CheckCircle2Icon className="size-3.5" />
            <span>手动打卡</span>
          </Button>
        </div>
      </div>

      {status && (
        <Alert variant={status.tone === 'err' ? 'error' : status.tone === 'warn' ? 'warning' : 'success'}>
          <AlertDescription className="text-xs">{status.text}</AlertDescription>
        </Alert>
      )}

      {/* KPIs */}
      <div className="grid gap-2 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-1"><CardDescription className="text-xs">今日刷牙</CardDescription></CardHeader>
          <CardContent className="text-xs">
            <div className="font-mono text-lg font-semibold">{st?.todayCount ?? 0} / {st?.dailyGoalCount ?? 2} 次</div>
            <div className="text-muted-foreground">累计 {Math.round((st?.todayDurationSec ?? 0) / 60)} 分钟</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardDescription className="text-xs">连续达标</CardDescription></CardHeader>
          <CardContent className="text-xs">
            <div className="font-mono text-lg font-semibold">{st?.streakDays ?? 0} 天</div>
            <div className="text-muted-foreground">总记录 {st?.totalSessions ?? 0} 次</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardDescription className="text-xs">刷头剩余寿命</CardDescription></CardHeader>
          <CardContent className="flex items-center justify-between text-xs">
            <div>
              <div className="font-mono text-lg font-semibold">{st?.brushHead.daysLeft ?? 0} 天</div>
              <div className="text-muted-foreground">已用 {st?.brushHead.daysUsed ?? 0} 天</div>
            </div>
            <Button size="xs" variant="ghost" onClick={() => setResetHeadOpen(true)} title="重置刷头寿命">
              <RotateCcwIcon className="size-3.5" />
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardDescription className="text-xs">后台自动唤醒</CardDescription></CardHeader>
          <CardContent className="flex items-center justify-between text-xs">
            <Badge variant={data?.watchStatus?.enabled ? 'success' : 'secondary'}>
              {data?.watchStatus?.enabled ? data.watchStatus.phase || '运行中' : '未开启'}
            </Badge>
            <Switch
              checked={Boolean(data?.watchStatus?.enabled)}
              disabled={busy}
              onCheckedChange={checked => void runAction(checked ? '开启后台自动唤醒…' : '关闭后台自动唤醒…', async () => {
                const res = await callLaifen(checked ? 'watch-start' : 'watch-stop', {});
                setStatus({ text: res.message || '已更新自动唤醒状态', tone: res.ok ? 'ok' : 'err' });
                await refreshDashboard(true);
              })}
            />
          </CardContent>
        </Card>
      </div>

      {/* Live Monitor & Hardware Quick Buttons */}
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-2 pt-4 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={isLiveActive ? 'success' : 'secondary'}>
              {data?.liveSession?.phase || '待机'} · {data?.liveSession?.activeBrushingSec ?? 0}s
            </Badge>
            <span className="text-muted-foreground">{data?.liveSession?.message || '拿起唤醒牙刷或点击启动 360s 监听'}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAction('启动后台刷牙监听…', async () => {
              const res = await callLaifen('monitor-start', { timeoutSec: 360 });
              setStatus({ text: res.message || '已启动监听', tone: res.ok ? 'ok' : 'err' });
              await refreshDashboard(true);
            })}>
              <RadioIcon className="size-3.5" />
              <span>启动监听</span>
            </Button>
            <Button size="xs" variant="outline" onClick={() => void callLaifen('monitor-stop', {}).then(() => refreshDashboard(true))}>
              <SquareIcon className="size-3" />
              <span>停止监听</span>
            </Button>
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAction('启动电机…', async () => {
              const res = await callLaifen('power', { on: true, timeoutSec: 25 }, 60_000);
              setStatus({ text: res.message || '电机已启动', tone: res.ok ? 'ok' : 'err' });
            })}>
              <PowerIcon className="size-3.5" />
              <span>开刷</span>
            </Button>
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAction('停止电机…', async () => {
              const res = await callLaifen('power', { on: false, timeoutSec: 25 }, 60_000);
              setStatus({ text: res.message || '电机已停止', tone: res.ok ? 'ok' : 'err' });
            })}>
              停机
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Parameter Sliders */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <SlidersHorizontalIcon className="size-4" />
              <span>档位与振扫参数调校</span>
            </CardTitle>
            <div className="flex gap-1.5">
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAction('暂存参数到待唤醒队列…', async () => {
                const res = await callLaifen('set', buildSetArgs({ queueOnly: true }));
                if (res.ok) setDraftDirty(false);
                setStatus({ text: res.message || '已暂存待唤醒写入', tone: res.ok ? 'ok' : 'err' });
                await refreshDashboard(true);
              })}>
                暂存待唤醒写入
              </Button>
              <Button size="xs" disabled={busy} onClick={() => void runAction('下发刷牙参数到牙刷…', async () => {
                const res = await callLaifen('set', buildSetArgs({ timeoutSec: 25, queueIfAsleep: true }), 60_000);
                if (res.ok) setDraftDirty(false);
                setStatus({ text: res.message || '参数已下发', tone: res.ok ? 'ok' : 'err' });
                await refreshDashboard(true);
              })}>
                立即写入牙刷
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          {data?.pendingPatch && (
            <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-1.5">
              <span>存在待唤醒下发队列（{timestamp(data.pendingPatch.queuedAt)}）</span>
              <Button size="xs" variant="ghost" onClick={() => void callLaifen('pending-clear', {}).then(() => refreshDashboard(true))}>
                撤销暂存
              </Button>
            </div>
          )}

          {/* Presets */}
          {data?.presets?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {data.presets.map(pr => (
                <Button
                  key={pr.id}
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setDraftDirty(true);
                    setMode(pr.mode);
                    setStrength(pr.strength);
                    setRange(pr.range);
                    setSpeed(pr.speed);
                    setHighFrequency(pr.highFrequency);
                  }}
                >
                  {pr.label}
                </Button>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-1.5">
            {[1, 2, 3, 4].map(m => (
              <Button key={m} size="xs" variant={mode === m ? 'default' : 'outline'} onClick={() => { setDraftDirty(true); setMode(m); }}>
                Mode {m}
              </Button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <div className="flex justify-between"><span>振动强度</span><span className="font-mono font-semibold">{strength}</span></div>
              <Slider min={1} max={10} step={1} value={strength} onValueChange={v => { setDraftDirty(true); setStrength(Number(v)); }} />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between"><span>摆动幅度</span><span className="font-mono font-semibold">{range}</span></div>
              <Slider min={1} max={10} step={1} value={range} onValueChange={v => { setDraftDirty(true); setRange(Number(v)); }} />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between"><span>摆动速度</span><span className="font-mono font-semibold">{speed}</span></div>
              <Slider min={1} max={10} step={1} value={speed} onValueChange={v => { setDraftDirty(true); setSpeed(Number(v)); }} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 pt-1">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs">时长(秒)</Label>
              <Input size="sm" className="w-20" type="number" value={durationSec} onChange={e => { setDraftDirty(true); setDurationSec(e.target.value); }} />
            </div>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <Checkbox checked={highFrequency} onCheckedChange={v => { setDraftDirty(true); setHighFrequency(Boolean(v)); }} />
              <span>高频护龈</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <Checkbox checked={reminder30s} onCheckedChange={v => { setDraftDirty(true); setReminder30s(Boolean(v)); }} />
              <span>30s 换区提醒</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <Checkbox checked={airplaneMode} onCheckedChange={v => { setDraftDirty(true); setAirplaneMode(Boolean(v)); }} />
              <span>飞行模式</span>
            </label>
          </div>

          {data?.device?.protocol === 'v2pro' && (
            <div className="flex flex-wrap items-center gap-4 border-t pt-2">
              {[
                { label: '深层清洁', val: deepClean, set: setDeepClean },
                { label: '防飞溅', val: antiSplash, set: setAntiSplash },
                { label: '渐强启动', val: powerRampUp, set: setPowerRampUp },
                { label: '护齿降压', val: bristleProtection, set: setBristleProtection },
                { label: '拿起唤醒', val: liftToWake, set: setLiftToWake },
              ].map(item => (
                <label key={item.label} className="flex items-center gap-1.5 cursor-pointer">
                  <Checkbox checked={item.val} onCheckedChange={v => { setDraftDirty(true); item.set(Boolean(v)); }} />
                  <span>{item.label}</span>
                </label>
              ))}
              <select
                aria-label="过压灵敏度"
                value={overPressureLevel}
                onChange={e => { setDraftDirty(true); setOverPressureLevel(e.target.value); }}
                className="h-7 rounded-md border border-input bg-background px-2 text-xs outline-none"
              >
                <option value="low">轻度过压</option>
                <option value="medium">标准过压</option>
                <option value="high">敏感过压</option>
              </select>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Sessions Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">近期刷牙记录 ({data?.sessions.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {!data?.sessions.length ? (
            <p className="py-4 text-center text-xs text-muted-foreground">暂无刷牙记录，可点击上方手动打卡或启用自动唤醒同步。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">时间</TableHead>
                  <TableHead className="text-xs">来源</TableHead>
                  <TableHead className="text-xs">时长 / 档位</TableHead>
                  <TableHead className="text-xs">备注</TableHead>
                  <TableHead className="text-right text-xs">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.sessions.slice(0, 30).map(s => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">{timestamp(s.brushedAt)}</TableCell>
                    <TableCell><Badge variant="outline">{s.source}</Badge></TableCell>
                    <TableCell className="font-mono text-xs">{s.durationSec}s · Mode {s.mode ?? '-'}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.note || '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button size="xs" variant="ghost" onClick={() => setDelSessionTarget(s)} aria-label="删除刷牙记录">
                        <Trash2Icon className="size-3.5 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Config */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">绑定与护齿目标配置</CardTitle></CardHeader>
        <CardContent>
          <form onSubmit={e => void saveConfig(e)} className="grid gap-2 sm:grid-cols-4 items-end text-xs">
            <div className="space-y-1">
              <Label className="text-xs">目标 MAC</Label>
              <Input size="sm" value={cfgMac} onChange={e => { setDraftDirty(true); setCfgMac(e.target.value); }} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">设备前缀</Label>
              <Input size="sm" value={cfgPrefix} onChange={e => { setDraftDirty(true); setCfgPrefix(e.target.value); }} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">刷头周期(天)</Label>
              <Input size="sm" type="number" value={cfgLifespan} onChange={e => { setDraftDirty(true); setCfgLifespan(e.target.value); }} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">每日目标(次)</Label>
              <Input size="sm" type="number" value={cfgGoal} onChange={e => { setDraftDirty(true); setCfgGoal(e.target.value); }} />
            </div>
            <div className="sm:col-span-4 flex justify-end pt-1">
              <Button type="submit" size="sm" disabled={busy}>保存配置</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <ConfirmActionDialog
        open={resetHeadOpen}
        onOpenChange={setResetHeadOpen}
        title="重置刷头寿命计时"
        description="确定将当前刷头已使用天数与次数清零并从今天重新计算吗？"
        confirmLabel="确认重置"
        busy={busy}
        onConfirm={async () => {
          setResetHeadOpen(false);
          await runAction('重置刷头寿命计时…', async () => {
            const res = await callLaifen('brushhead-reset', {});
            setStatus({ text: res.message || '已重置刷头寿命', tone: res.ok ? 'ok' : 'err' });
            await refreshDashboard(true);
          });
        }}
      />

      <ConfirmActionDialog
        open={Boolean(delSessionTarget)}
        onOpenChange={open => { if (!open) setDelSessionTarget(null); }}
        title="删除刷牙记录"
        description={`确定删除 ${delSessionTarget ? timestamp(delSessionTarget.brushedAt) : ''} 的刷牙记录吗？`}
        busy={busy}
        onConfirm={async () => {
          const target = delSessionTarget!;
          setDelSessionTarget(null);
          await runAction('正在删除刷牙记录…', async () => {
            const res = await callLaifen('session-delete', { id: target.id });
            setStatus({ text: res.message || '已删除', tone: res.ok ? 'ok' : 'err' });
            await refreshDashboard(true);
          });
        }}
      />
    </div>
  );
}

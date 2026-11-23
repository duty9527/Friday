import { errorText } from '@friday/web/shared/format.js';
import {
  ClockIcon,
  PencilIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SunIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmActionDialog } from '@/components/shared/ConfirmActionDialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { useFriday } from '@/lib/friday-store';

interface NetleaChannels {
  red: number;
  green: number;
  white: number;
  blue: number;
  fan: number;
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
}

interface NetleaSchedule {
  travelModel: number;
  sunriseMinutes: number;
  sunsetMinutes: number;
  trips: NetleaTrip[];
  presetName?: string;
}

interface NetleaSavedPreset extends NetleaChannels {
  name: string;
}

interface NetleaCatalogScene {
  modeCode: number;
  seriesName: string;
  name: string;
  maxGear: number;
  gears: Array<{ gear: number; powerWatts: number; channels: NetleaChannels }>;
}

interface NetleaDashboardPayload {
  device: { address: string; name: string; rssi: number | null; connected: boolean } | null;
  state: { on: boolean; runModeLabel?: string; scheduleRunning?: boolean; channels: NetleaChannels; powerWatts?: number } | null;
  schedule?: NetleaSchedule | null;
  tempConfig?: { onMinutes: number; offMinutes: number } | null;
  config: {
    targetMac: string;
    namePrefix: string;
    tempOnMinutes: number;
    tempOffMinutes: number;
    tankSize: { lengthCm: number; widthCm: number; heightCm: number };
    defaultChannels: NetleaChannels;
    savedCustomPresets: NetleaSavedPreset[];
  };
  catalog?: {
    scenes: NetleaCatalogScene[];
    cultivationPresets: Array<{ id: string; name: string; totalHours: number }>;
  };
}

const DAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
const pad2 = (n: number) => String(Math.max(0, Math.min(99, Math.round(n)))).padStart(2, '0');

export default function NetleaSurface() {
  const { authExpired, api } = useFriday();
  const [data, setData] = useState<NetleaDashboardPayload | null>(null);
  const [tab, setTab] = useState<'schedule' | 'preset' | 'manual'>('schedule');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);

  // Quick control
  const [tempMinutes, setTempMinutes] = useState('60');
  const [brightness, setBrightness] = useState(100);

  // Schedule state & trip editor
  const [schedDirty, setSchedDirty] = useState(false);
  const [draftTravelModel, setDraftTravelModel] = useState(0);
  const [draftSunrise, setDraftSunrise] = useState(20);
  const [draftSunset, setDraftSunset] = useState(20);
  const [draftTrips, setDraftTrips] = useState<NetleaTrip[]>([]);
  const [editingTripIndex, setEditingTripIndex] = useState<number>(-2); // -2 closed, -1 new, >=0 edit
  const [tripStart, setTripStart] = useState('09:00');
  const [tripEnd, setTripEnd] = useState('17:00');
  const [tripDays, setTripDays] = useState<number[]>([1, 1, 1, 1, 1, 1, 1]);
  const [tripEnabled, setTripEnabled] = useState(true);
  const [tripSpecMode, setTripSpecMode] = useState<'scene' | 'custom'>('scene');
  const [tripSceneCode, setTripSceneCode] = useState(0);
  const [tripGear, setTripGear] = useState(6);
  const [tripCustomCh, setTripCustomCh] = useState<NetleaChannels>({ red: 40, green: 60, white: 80, blue: 35, fan: 0 });
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  // Preset calculator
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [tankL, setTankL] = useState('60');
  const [tankW, setTankW] = useState('40');
  const [tankH, setTankH] = useState('40');
  const [presetStart, setPresetStart] = useState('09:00');
  const [presetFade, setPresetFade] = useState('20');

  // Manual 5 channels
  const [channels, setChannels] = useState<NetleaChannels>({ red: 45, green: 60, white: 85, blue: 35, fan: 50 });
  const [cfgOnMin, setCfgOnMin] = useState('60');
  const [cfgOffMin, setCfgOffMin] = useState('60');
  const [cfgMac, setCfgMac] = useState('');
  const [cfgPrefix, setCfgPrefix] = useState('SG-');

  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const callNetlea = useCallback(
    async <T,>(action: string, args: Record<string, unknown> = {}) => {
      return api<{ ok: boolean; message: string; data?: T }>('/api/plugin-run', {
        plugin: 'netlea',
        action,
        args,
      });
    },
    [api],
  );

  const applyDashboard = useCallback(
    (d: NetleaDashboardPayload, forceInputs = false) => {
      setData(d);
      if (forceInputs || !schedDirty) {
        if (d.schedule) {
          setDraftTrips((d.schedule.trips || []).map(t => ({ ...t, dayList: [...t.dayList] })));
          setDraftSunrise(d.schedule.sunriseMinutes ?? 20);
          setDraftSunset(d.schedule.sunsetMinutes ?? 20);
          setDraftTravelModel(d.schedule.travelModel ?? 0);
        }
      }
      if (d.state?.channels && forceInputs) {
        setChannels(d.state.channels);
      }
      if (!selectedPresetId && d.catalog?.cultivationPresets?.length) {
        setSelectedPresetId(d.catalog.cultivationPresets[0]!.id);
      }
      if (forceInputs) {
        setTankL(String(d.config.tankSize?.lengthCm ?? 60));
        setTankW(String(d.config.tankSize?.widthCm ?? 40));
        setTankH(String(d.config.tankSize?.heightCm ?? 40));
        setCfgOnMin(String(d.tempConfig?.onMinutes ?? d.config.tempOnMinutes ?? 60));
        setCfgOffMin(String(d.tempConfig?.offMinutes ?? d.config.tempOffMinutes ?? 60));
        setCfgMac(d.config.targetMac || '');
        setCfgPrefix(d.config.namePrefix || 'SG-');
      }
    },
    [schedDirty, selectedPresetId],
  );

  const refresh = useCallback(
    async (forceInputs = false) => {
      if (authExpired) return;
      const seq = ++seqRef.current;
      try {
        const res = await callNetlea<NetleaDashboardPayload>('dashboard', {});
        if (!mountedRef.current || seq !== seqRef.current || authExpired) return;
        if (res.ok && res.data) applyDashboard(res.data, forceInputs);
      } catch (err) {
        if (mountedRef.current) setStatus({ text: `读取水草灯失败：${errorText(err)}`, tone: 'err' });
      }
    },
    [applyDashboard, authExpired, callNetlea],
  );

  useEffect(() => {
    void refresh(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runAndRefresh = async (action: string, args: Record<string, unknown>, pendingText: string) => {
    if (busy || authExpired) return;
    setBusy(true);
    setStatus({ text: pendingText, tone: 'warn' });
    try {
      const res = await callNetlea(action, args);
      if (!mountedRef.current) return;
      setStatus({ text: res.message || (res.ok ? '指令已生效' : '指令失败'), tone: res.ok ? 'ok' : 'err' });
      if (res.ok) await refresh(false);
    } catch (err) {
      if (mountedRef.current) setStatus({ text: errorText(err), tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const openEditor = (idx: number) => {
    if (idx === -1) {
      setEditingTripIndex(-1);
      setTripStart('09:00');
      setTripEnd('17:00');
      setTripDays([1, 1, 1, 1, 1, 1, 1]);
      setTripEnabled(true);
      setTripSpecMode('scene');
      setTripSceneCode(0);
      setTripGear(6);
      return;
    }
    const t = draftTrips[idx];
    if (!t) return;
    setEditingTripIndex(idx);
    setTripStart(`${pad2(t.startH)}:${pad2(t.startM)}`);
    setTripEnd(`${pad2(t.endH)}:${pad2(t.endM)}`);
    setTripDays([...t.dayList]);
    setTripEnabled(t.enable !== 0);
    if (t.modeCode < 12) {
      setTripSpecMode('scene');
      setTripSceneCode(t.modeCode);
      setTripGear(t.gear || 1);
    } else {
      setTripSpecMode('custom');
      setTripCustomCh({ red: t.red, green: t.green, white: t.white, blue: t.blue, fan: t.fan });
    }
  };

  const deleteTripAt = (idx: number) => {
    setDraftTrips(prev => prev.filter((_, i) => i !== idx));
    // Shift editingTripIndex cleanly when deleting trips
    setEditingTripIndex(prev => {
      if (prev === idx) return -2;
      if (prev > idx) return prev - 1;
      return prev;
    });
    setSchedDirty(true);
  };

  const saveTrip = (e: React.FormEvent) => {
    e.preventDefault();
    const parseHm = (raw: string, fh: number, fm: number) => {
      const m = /^(\d{1,2}):(\d{1,2})$/.exec(raw.trim());
      return m ? { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) } : { h: fh, m: fm };
    };
    const st = parseHm(tripStart, 9, 0);
    const ed = parseHm(tripEnd, 17, 0);
    const scenes = data?.catalog?.scenes ?? [];
    const scene = scenes.find(s => s.modeCode === tripSceneCode);
    const gearObj = scene?.gears.find(g => g.gear === tripGear);

    const nextTrip: NetleaTrip =
      tripSpecMode === 'scene'
        ? {
            enable: tripEnabled ? 1 : 0,
            dayList: [...tripDays],
            startH: st.h,
            startM: st.m,
            endH: ed.h,
            endM: ed.m,
            modeCode: tripSceneCode,
            gear: tripGear,
            red: gearObj?.channels.red ?? 40,
            green: gearObj?.channels.green ?? 60,
            white: gearObj?.channels.white ?? 80,
            blue: gearObj?.channels.blue ?? 35,
            fan: 0,
            powerWatts: gearObj?.powerWatts ?? 18,
            name: scene?.name || '场景',
            seriesName: scene?.seriesName || '水草',
          }
        : {
            enable: tripEnabled ? 1 : 0,
            dayList: [...tripDays],
            startH: st.h,
            startM: st.m,
            endH: ed.h,
            endM: ed.m,
            modeCode: 12,
            gear: 0,
            ...tripCustomCh,
            name: '自定义',
            seriesName: '自定义',
          };

    setDraftTrips(prev => {
      const copy = [...prev];
      if (editingTripIndex === -1) copy.push(nextTrip);
      else if (editingTripIndex >= 0 && editingTripIndex < copy.length) copy[editingTripIndex] = nextTrip;
      return copy.sort((a, b) => a.startH * 60 + a.startM - (b.startH * 60 + b.startM));
    });
    setEditingTripIndex(-2);
    setSchedDirty(true);
    setStatus({ text: '已更新本地时段列表，请点击「保存并下发行程」写入灯具。', tone: 'warn' });
  };

  // Spectrum SVG bars (pure SVG presentation attributes)
  const spectrumBars = useMemo(
    () => [
      { key: 'red', label: '红 R', val: channels.red, fill: '#ef4444' },
      { key: 'green', label: '绿 G', val: channels.green, fill: '#22c55e' },
      { key: 'white', label: '白 W', val: channels.white, fill: '#e5e7eb' },
      { key: 'blue', label: '蓝 B', val: channels.blue, fill: '#3b82f6' },
      { key: 'fan', label: '风扇', val: channels.fan, fill: '#06b6d4' },
    ],
    [channels],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SunIcon className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">尼特利水草灯 · 五通道光谱与 24h 日照</h3>
          <Badge variant={data?.state?.on ? 'success' : 'secondary'}>
            {data?.state ? (data.state.on ? `${data.state.runModeLabel || '开灯'} (${data.state.powerWatts ?? 0}W)` : '已关灯') : '待同步'}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Input size="sm" className="w-16 font-mono" type="number" value={tempMinutes} onChange={e => setTempMinutes(e.target.value)} aria-label="临时时长(分)" />
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAndRefresh('off', { durationMinutes: Number(tempMinutes) || 60 }, '发送临时关灯指令…')}>
            临时关灯
          </Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAndRefresh('resume', {}, '恢复 24h 自动行程…')}>
            恢复自动
          </Button>
          <Button size="xs" disabled={busy} onClick={() => void runAndRefresh('on', { brightness, durationMinutes: Number(tempMinutes) || 60 }, `开启 ${brightness}% 默认光谱…`)}>
            <PowerIcon className="size-3.5" />
            <span>{brightness}% 亮灯</span>
          </Button>
        </div>
      </div>

      {status && (
        <Alert variant={status.tone === 'err' ? 'error' : status.tone === 'warn' ? 'warning' : 'success'}>
          <AlertDescription className="text-xs">{status.text}</AlertDescription>
        </Alert>
      )}

      {/* Quick brightness */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 pt-3 text-xs">
          <span className="text-muted-foreground">一键总亮度：</span>
          <div className="flex-1 min-w-44">
            <Slider min={1} max={100} step={1} value={brightness} onValueChange={v => setBrightness(Number(v))} />
          </div>
          <span className="font-mono font-semibold w-10">{brightness}%</span>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void refresh(true)}>
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={v => setTab(v as 'schedule' | 'preset' | 'manual')}>
        <TabsList>
          <TabsTab value="schedule">24h 日照行程 ({draftTrips.length})</TabsTab>
          <TabsTab value="preset">官方缸体预设</TabsTab>
          <TabsTab value="manual">手动五通道调光</TabsTab>
        </TabsList>

        <TabsPanel value="schedule" className="mt-3 space-y-3">
          {/* 24h SVG Timeline Preview */}
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="flex items-center gap-1.5 text-xs">
                <ClockIcon className="size-3.5" />
                <span>24h 光照日程时间轴 (日出渐亮 {draftSunrise}m / 日落渐暗 {draftSunset}m)</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <svg viewBox="0 0 480 48" className="h-12 w-full" aria-label="24小时日照时间轴">
                <rect x="0" y="14" width="480" height="14" rx="4" fill="var(--muted)" />
                {draftTrips.map((t, idx) => {
                  const sMin = t.startH * 60 + t.startM;
                  const eMin = Math.max(sMin + 5, t.endH * 60 + t.endM);
                  const x = (sMin / 1440) * 480;
                  const w = Math.max(4, ((eMin - sMin) / 1440) * 480);
                  return (
                    <rect
                      key={`${sMin}-${idx}`}
                      x={x.toFixed(1)}
                      y="12"
                      width={w.toFixed(1)}
                      height="18"
                      rx="3"
                      fill={t.enable ? 'var(--primary)' : 'var(--muted-foreground)'}
                      fillOpacity={t.enable ? 0.85 : 0.35}
                    />
                  );
                })}
                {[0, 6, 12, 18, 24].map(h => (
                  <text key={h} x={h === 24 ? 476 : h * 20 + 2} y="44" textAnchor={h === 24 ? 'end' : 'start'} fill="var(--muted-foreground)" fontSize="9">
                    {pad2(h)}:00
                  </text>
                ))}
              </svg>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <Label className="text-xs">日出(分)</Label>
              <Input size="sm" className="w-16" type="number" value={draftSunrise} onChange={e => { setSchedDirty(true); setDraftSunrise(Number(e.target.value) || 0); }} />
              <Label className="text-xs">日落(分)</Label>
              <Input size="sm" className="w-16" type="number" value={draftSunset} onChange={e => { setSchedDirty(true); setDraftSunset(Number(e.target.value) || 0); }} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAndRefresh('schedule', { op: 'get' }, '回读灯内定时行程…')}>回读行程</Button>
              <Button size="xs" variant="outline" disabled={draftTrips.length >= 10} onClick={() => openEditor(-1)}>
                <PlusIcon className="size-3" />
                <span>新增时段</span>
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setClearConfirmOpen(true)}>清空行程</Button>
              <Button
                size="xs"
                disabled={busy || !draftTrips.length}
                onClick={() => void runAndRefresh('schedule', { op: 'set', travelModel: draftTravelModel, sunriseMinutes: draftSunrise, sunsetMinutes: draftSunset, trips: draftTrips }, '保存并下发 24h 日照行程…').then(() => setSchedDirty(false))}
              >
                保存并下发行程
              </Button>
            </div>
          </div>

          {editingTripIndex >= -1 && (
            <Card>
              <CardContent className="pt-4">
                <form onSubmit={saveTrip} className="space-y-3 text-xs">
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="space-y-1">
                      <Label className="text-xs">开始时间</Label>
                      <Input size="sm" value={tripStart} onChange={e => setTripStart(e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">结束时间</Label>
                      <Input size="sm" value={tripEnd} onChange={e => setTripEnd(e.target.value)} />
                    </div>
                    <div className="flex items-end pb-1">
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <Checkbox checked={tripEnabled} onCheckedChange={v => setTripEnabled(Boolean(v))} />
                        <span>启用该时段</span>
                      </label>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {DAY_NAMES.map((d, i) => (
                      <Button
                        key={d}
                        type="button"
                        size="xs"
                        variant={tripDays[i] ? 'default' : 'outline'}
                        onClick={() => setTripDays(prev => prev.map((v, idx) => (idx === i ? (v ? 0 : 1) : v)))}
                      >
                        周{d}
                      </Button>
                    ))}
                  </div>
                  <div className="flex gap-1.5">
                    <Button type="button" size="xs" variant={tripSpecMode === 'scene' ? 'default' : 'outline'} onClick={() => setTripSpecMode('scene')}>内置场景模式</Button>
                    <Button type="button" size="xs" variant={tripSpecMode === 'custom' ? 'default' : 'outline'} onClick={() => setTripSpecMode('custom')}>自定义四色比例</Button>
                  </div>
                  {tripSpecMode === 'scene' ? (
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={String(tripSceneCode)}
                        onChange={e => setTripSceneCode(Number(e.target.value))}
                        className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none"
                      >
                        {(data?.catalog?.scenes ?? []).map(s => (
                          <option key={s.modeCode} value={String(s.modeCode)}>{s.seriesName} · {s.name}</option>
                        ))}
                      </select>
                      <Input size="sm" type="number" min={1} max={10} value={String(tripGear)} onChange={e => setTripGear(Number(e.target.value) || 1)} />
                    </div>
                  ) : (
                    <div className="grid grid-cols-4 gap-2">
                      {(['red', 'green', 'white', 'blue'] as const).map(ch => (
                        <div key={ch} className="space-y-1">
                          <Label className="text-[11px] uppercase">{ch}</Label>
                          <Input size="sm" type="number" min={0} max={100} value={String(tripCustomCh[ch])} onChange={e => setTripCustomCh(p => ({ ...p, [ch]: Number(e.target.value) || 0 }))} />
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex justify-end gap-1.5">
                    <Button type="button" size="xs" variant="ghost" onClick={() => setEditingTripIndex(-2)}>取消</Button>
                    <Button type="submit" size="xs">确认添加到列表</Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          <div className="space-y-1.5">
            {draftTrips.map((t, idx) => (
              <div key={`${t.startH}-${t.startM}-${idx}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={t.enable ? 'success' : 'secondary'}>{pad2(t.startH)}:{pad2(t.startM)} ~ {pad2(t.endH)}:{pad2(t.endM)}</Badge>
                  <span className="font-medium">{t.seriesName || ''} {t.name || '时段'}</span>
                  <span className="font-mono text-muted-foreground">R{t.red}/G{t.green}/W{t.white}/B{t.blue} · {t.powerWatts ?? 0}W</span>
                </div>
                <div className="flex gap-1">
                  <Button size="xs" variant="ghost" onClick={() => openEditor(idx)} aria-label="编辑时段"><PencilIcon className="size-3" /></Button>
                  <Button size="xs" variant="ghost" onClick={() => deleteTripAt(idx)} aria-label="删除时段"><Trash2Icon className="size-3 text-destructive" /></Button>
                </div>
              </div>
            ))}
          </div>
        </TabsPanel>

        <TabsPanel value="preset" className="mt-3 space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-1.5 text-sm">
                <SparklesIcon className="size-4" />
                <span>根据鱼缸尺寸计算科学培养光谱</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              <div className="flex flex-wrap gap-1.5">
                {(data?.catalog?.cultivationPresets ?? []).map(p => (
                  <Button key={p.id} size="xs" variant={selectedPresetId === p.id ? 'default' : 'outline'} onClick={() => setSelectedPresetId(p.id)}>
                    {p.name} ({p.totalHours}h)
                  </Button>
                ))}
              </div>
              <div className="grid gap-2 sm:grid-cols-5">
                <div className="space-y-1"><Label className="text-xs">长 (cm)</Label><Input size="sm" value={tankL} onChange={e => setTankL(e.target.value)} /></div>
                <div className="space-y-1"><Label className="text-xs">宽 (cm)</Label><Input size="sm" value={tankW} onChange={e => setTankW(e.target.value)} /></div>
                <div className="space-y-1"><Label className="text-xs">高 (cm)</Label><Input size="sm" value={tankH} onChange={e => setTankH(e.target.value)} /></div>
                <div className="space-y-1"><Label className="text-xs">开灯</Label><Input size="sm" value={presetStart} onChange={e => setPresetStart(e.target.value)} /></div>
                <div className="space-y-1"><Label className="text-xs">渐变(分)</Label><Input size="sm" value={presetFade} onChange={e => setPresetFade(e.target.value)} /></div>
              </div>
              <Button
                size="sm"
                disabled={busy || !selectedPresetId}
                onClick={() => {
                  const m = /^(\d{1,2}):(\d{1,2})$/.exec(presetStart.trim());
                  void runAndRefresh(
                    'schedule',
                    {
                      op: 'preset',
                      preset: selectedPresetId,
                      lengthCm: Number(tankL) || 60,
                      widthCm: Number(tankW) || 40,
                      heightCm: Number(tankH) || 40,
                      startHour: m ? Number(m[1]) : 9,
                      startMinute: m ? Number(m[2]) : 0,
                      sunriseMinutes: Number(presetFade) || 20,
                      sunsetMinutes: Number(presetFade) || 20,
                    },
                    '正在按鱼缸尺寸生成并下发科学预设…',
                  ).then(() => setTab('schedule'));
                }}
              >
                计算并直接下发行程
              </Button>
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="manual" className="mt-3 space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-1.5 text-sm">
                <SlidersHorizontalIcon className="size-4" />
                <span>RGBW 五通道微调与恒亮控制</span>
              </CardTitle>
              <CardDescription className="text-xs">调整红色 / 绿色 / 白光 / 蓝光及风扇散热百分比</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              {/* SVG Spectrum Bars */}
              <svg viewBox="0 0 300 68" className="h-16 w-full rounded-md border bg-muted/20 p-1" aria-label="五通道光谱分布">
                {spectrumBars.map((b, i) => {
                  const x = 18 + i * 56;
                  const h = Math.max(2, (b.val / 100) * 40);
                  return (
                    <g key={b.key}>
                      <rect x={x} y={48 - h} width="32" height={h} rx="3" fill={b.fill} />
                      <text x={x + 16} y="62" textAnchor="middle" fill="var(--muted-foreground)" fontSize="9">{b.label} {b.val}%</text>
                    </g>
                  );
                })}
              </svg>

              <div className="space-y-2.5">
                {(
                  [
                    { key: 'red', label: '红光 R (%)' },
                    { key: 'green', label: '绿光 G (%)' },
                    { key: 'white', label: '白光 W (%)' },
                    { key: 'blue', label: '蓝光 B (%)' },
                    { key: 'fan', label: '风扇散热 (%)' },
                  ] as const
                ).map(item => (
                  <div key={item.key} className="flex items-center gap-3">
                    <span className="w-24 text-muted-foreground">{item.label}</span>
                    <div className="flex-1">
                      <Slider min={0} max={100} step={1} value={channels[item.key]} onValueChange={v => setChannels(prev => ({ ...prev, [item.key]: Number(v) }))} />
                    </div>
                    <span className="w-10 text-right font-mono">{channels[item.key]}%</span>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-1.5 pt-2">
                <Button size="xs" disabled={busy} onClick={() => void runAndRefresh('on', { ...channels, durationMinutes: Number(tempMinutes) || 60 }, '临时光谱开灯…')}>
                  临时光谱开灯 ({tempMinutes}分)
                </Button>
                <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAndRefresh('mode', { mode: 'manual', on: true, ...channels }, '切换手动恒亮…')}>
                  手动恒亮 (不随定时)
                </Button>
                <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAndRefresh('mode', { mode: 'manual', on: false }, '发送手动恒定关灯…')}>
                  手动恒定关灯
                </Button>
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => void runAndRefresh('config', { defaultChannels: channels }, '设为默认光谱…')}>
                  保存为默认光谱
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-3 sm:grid-cols-2">
            <Card>
              <CardHeader className="pb-1"><CardTitle className="text-xs">临时开关灯默认时长</CardTitle></CardHeader>
              <CardContent className="flex items-end gap-2 text-xs">
                <div className="space-y-1 flex-1"><Label className="text-[11px]">开灯(分)</Label><Input size="sm" value={cfgOnMin} onChange={e => setCfgOnMin(e.target.value)} /></div>
                <div className="space-y-1 flex-1"><Label className="text-[11px]">关灯(分)</Label><Input size="sm" value={cfgOffMin} onChange={e => setCfgOffMin(e.target.value)} /></div>
                <Button size="xs" disabled={busy} onClick={() => void runAndRefresh('mode', { mode: 'temp-config', onMinutes: Number(cfgOnMin) || 60, offMinutes: Number(cfgOffMin) || 60, ...channels }, '写入硬件默认时长…')}>写入</Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-1"><CardTitle className="text-xs">蓝牙设备绑定</CardTitle></CardHeader>
              <CardContent className="flex items-end gap-2 text-xs">
                <div className="space-y-1 flex-1"><Label className="text-[11px]">目标 MAC</Label><Input size="sm" value={cfgMac} onChange={e => setCfgMac(e.target.value)} /></div>
                <div className="space-y-1 w-20"><Label className="text-[11px]">前缀</Label><Input size="sm" value={cfgPrefix} onChange={e => setCfgPrefix(e.target.value)} /></div>
                <Button size="xs" disabled={busy} onClick={() => void runAndRefresh('config', { targetMac: cfgMac.trim(), namePrefix: cfgPrefix.trim() || 'SG-' }, '保存蓝牙绑定…')}>保存</Button>
              </CardContent>
            </Card>
          </div>
        </TabsPanel>
      </Tabs>

      <ConfirmActionDialog
        open={clearConfirmOpen}
        onOpenChange={setClearConfirmOpen}
        title="清空灯内全部行程"
        description="确定清空水草灯闪存中的全部 24h 日照定时行程吗？"
        confirmLabel="确认清空"
        busy={busy}
        onConfirm={async () => {
          setClearConfirmOpen(false);
          await runAndRefresh('schedule', { op: 'clear' }, '清空灯内行程…');
          setDraftTrips([]);
          setSchedDirty(false);
          setEditingTripIndex(-2);
        }}
      />
    </div>
  );
}

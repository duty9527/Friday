import { errorText, timestamp } from '@friday/web/shared/format.js';
import {
  CpuIcon,
  ExternalLinkIcon,
  HomeIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  ZapIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmActionDialog } from '@/components/shared/ConfirmActionDialog';
import { isSafeHttpUrl } from '@/components/shared/safeUrl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useFriday } from '@/lib/friday-store';

interface MiotDeviceItem {
  did: string;
  name: string;
  room: string;
  fullName: string;
  category: string;
  controlChannel: string;
  controllable: boolean;
  online: boolean;
  model: string;
  modelName?: string;
  ip?: string;
  protected?: boolean;
  state?: { on?: boolean; source?: string };
  fryer?: { statusText?: string; targetTempC?: number; leftTimeMin?: number };
  liveError?: string;
}

interface MiotGeekRuleItem {
  id: string;
  name: string;
  enable: boolean;
  lastUpdateTime?: number;
  nodeCount: number;
  nodeTypes?: string[];
  summary: string;
}

interface MiotGeekLogEntry {
  ts: number;
  graphId: string;
  graphName: string;
  ok?: boolean;
  summary: string;
}

interface MiotSceneItem {
  id: string;
  updatedAt?: number;
  turnsOffProtected?: boolean;
  summary: string;
}

interface MiotVarItem {
  scope: string;
  id: string;
  type: string;
  value?: unknown;
}

interface MiotConfigData {
  routerSsh?: string;
  speakerSsh?: string;
  protectedDevices?: string[];
  customAliases?: Record<string, string[]>;
  cacheTtlMs?: number;
  topologyTtlMs?: number;
  udpTimeoutMs?: number;
}

interface MiotDashboardData {
  configured?: boolean;
  degraded?: boolean;
  fromCache?: boolean;
  routerSsh?: string;
  gateway?: { online?: boolean; homeName?: string; ip?: string; roleLabel?: string; geekPort?: number };
  btService?: { version?: string };
  subGateways?: unknown[];
  speaker?: { configured?: boolean; id?: string; source?: string };
  geekUrl?: string;
  geekReady?: boolean;
  devices?: MiotDeviceItem[];
  geekGraphs?: MiotGeekRuleItem[];
  geekLogs?: MiotGeekLogEntry[];
  scenes?: MiotSceneItem[];
  variables?: MiotVarItem[];
  config?: MiotConfigData;
}

type MiotTab = 'mesh' | 'geek' | 'scenes' | 'config';

function parseCustomAliases(raw: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const vals = trimmed.slice(eq + 1).split(/[,，、]/).map(s => s.trim()).filter(Boolean);
    if (key && vals.length > 0) out[key] = vals;
  }
  return out;
}

function formatCustomAliases(aliases?: Record<string, string[]>): string {
  if (!aliases) return '';
  return Object.entries(aliases)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(', ') : String(v ?? '')}`)
    .join('\n');
}

export default function MiotSurface() {
  const { authExpired, api } = useFriday();
  const [data, setData] = useState<MiotDashboardData | null>(null);
  const [tab, setTab] = useState<MiotTab>('mesh');
  const [selectedRoom, setSelectedRoom] = useState('');
  const [selectedChannel, setSelectedChannel] = useState('all');
  const [logFilterGraphId, setLogFilterGraphId] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);

  // Create geek schedule form
  const [geekOpen, setGeekOpen] = useState(false);
  const [geekName, setGeekName] = useState('');
  const [geekDid, setGeekDid] = useState('');
  const [geekOnTime, setGeekOnTime] = useState('');
  const [geekOffTime, setGeekOffTime] = useState('');
  const [geekEnable, setGeekEnable] = useState(true);

  // Custom variable creation & dirty edits
  const [varScope, setVarScope] = useState('custom');
  const [varId, setVarId] = useState('');
  const [varType, setVarType] = useState<'number' | 'string'>('number');
  const [varValue, setVarValue] = useState('');
  const [dirtyVars, setDirtyVars] = useState<Record<string, string>>({});

  // Hub config form with dirty guard
  const [cfgDirty, setCfgDirty] = useState(false);
  const [cfgRouter, setCfgRouter] = useState('');
  const [cfgSpeaker, setCfgSpeaker] = useState('');
  const [cfgProtected, setCfgProtected] = useState('');
  const [cfgAliases, setCfgAliases] = useState('');
  const [cfgCacheTtl, setCfgCacheTtl] = useState('15000');
  const [cfgTopoTtl, setCfgTopoTtl] = useState('600000');
  const [cfgUdpTimeout, setCfgUdpTimeout] = useState('3500');

  // Confirmations
  const [batchConfirm, setBatchConfirm] = useState<boolean | null>(null);
  const [delRuleTarget, setDelRuleTarget] = useState<MiotGeekRuleItem | null>(null);
  const [sceneConfirmTarget, setSceneConfirmTarget] = useState<MiotSceneItem | null>(null);
  const [delVarTarget, setDelVarTarget] = useState<MiotVarItem | null>(null);

  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runMiot = useCallback(
    async (action: string, args: Record<string, unknown> = {}) => {
      return api<{ ok: boolean; message: string; data?: MiotDashboardData }>('/api/plugin-run', {
        plugin: 'miot',
        action,
        args,
      });
    },
    [api],
  );

  const syncConfigFields = useCallback(
    (cfg?: MiotConfigData, force = false) => {
      if (!cfg || (!force && cfgDirty)) return;
      setCfgRouter(cfg.routerSsh ?? '');
      setCfgSpeaker(cfg.speakerSsh ?? '');
      setCfgProtected((cfg.protectedDevices ?? []).join(', '));
      setCfgAliases(formatCustomAliases(cfg.customAliases));
      setCfgCacheTtl(String(cfg.cacheTtlMs ?? 15000));
      setCfgTopoTtl(String(cfg.topologyTtlMs ?? 600000));
      setCfgUdpTimeout(String(cfg.udpTimeoutMs ?? 3500));
    },
    [cfgDirty],
  );

  const loadDashboard = useCallback(
    async (mode: 'cache' | 'auto' | 'refresh' | 'live', preserveBanner = false) => {
      if (authExpired) return;
      const seq = ++seqRef.current;
      setBusy(true);
      try {
        const args =
          mode === 'cache'
            ? { cacheOnly: true }
            : mode === 'live'
              ? { refresh: true, live: true }
              : mode === 'refresh'
                ? { refresh: true, live: false }
                : { refresh: false, live: false };
        const res = await runMiot('dashboard', args);
        if (!mountedRef.current || seq !== seqRef.current || authExpired) return;
        if (res.data) {
          setData(res.data);
          syncConfigFields(res.data.config);
        }
        if (!preserveBanner) {
          if (!res.ok) setStatus({ text: res.message || '读取米家中枢失败', tone: 'err' });
          else if (res.data?.degraded) setStatus({ text: res.message, tone: 'warn' });
          else if (mode === 'live' || mode === 'refresh') setStatus({ text: res.message || '中枢状态已刷新', tone: 'ok' });
        }
      } catch (err) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        if (!preserveBanner) setStatus({ text: `加载米家中枢失败：${errorText(err)}`, tone: 'err' });
      } finally {
        if (mountedRef.current && seq === seqRef.current) setBusy(false);
      }
    },
    [authExpired, runMiot, syncConfigFields],
  );

  useEffect(() => {
    void loadDashboard('auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runAndReload = async (
    action: string,
    args: Record<string, unknown>,
    pendingText: string,
    reloadMode: 'auto' | 'refresh' | 'live' = 'auto',
  ): Promise<boolean> => {
    if (busy || authExpired) return false;
    setBusy(true);
    setStatus({ text: pendingText, tone: 'warn' });
    try {
      const res = await runMiot(action, args);
      if (!mountedRef.current) return false;
      setStatus({ text: res.message || (res.ok ? '操作成功' : '操作失败'), tone: res.ok ? 'ok' : 'err' });
      setBusy(false);
      if (res.ok) await loadDashboard(reloadMode, true);
      return res.ok;
    } catch (err) {
      if (mountedRef.current) setStatus({ text: `操作失败：${errorText(err)}`, tone: 'err' });
      return false;
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const devices = useMemo(() => data?.devices ?? [], [data?.devices]);
  const meshDevices = useMemo(() => devices.filter(d => d.controlChannel === 'bt_mesh' && d.controllable), [devices]);
  const rooms = useMemo(() => [...new Set(devices.map(d => d.room || '未分区'))], [devices]);

  useEffect(() => {
    if (!geekDid && meshDevices.length > 0) setGeekDid(meshDevices[0]!.did);
  }, [geekDid, meshDevices]);

  const filteredDevices = useMemo(
    () =>
      devices.filter(d => {
        if (selectedRoom && (d.room || '未分区') !== selectedRoom) return false;
        if (selectedChannel !== 'all' && d.controlChannel !== selectedChannel) return false;
        return true;
      }),
    [devices, selectedChannel, selectedRoom],
  );

  const safeGeekHref = useMemo(() => (isSafeHttpUrl(data?.geekUrl) ? data?.geekUrl : undefined), [data?.geekUrl]);
  const graphs = data?.geekGraphs ?? [];
  const filteredLogs = useMemo(
    () => (logFilterGraphId ? (data?.geekLogs ?? []).filter(l => l.graphId === logFilterGraphId) : (data?.geekLogs ?? [])),
    [data?.geekLogs, logFilterGraphId],
  );

  const createGeekSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = geekName.trim();
    const did = geekDid.trim();
    if (!name || !did) {
      setStatus({ text: '请填写规则名称并选择蓝牙 Mesh 设备。', tone: 'warn' });
      return;
    }
    const rules: Array<{ time: string; did: string; on: boolean }> = [];
    if (geekOnTime.trim()) rules.push({ time: geekOnTime.trim(), did, on: true });
    if (geekOffTime.trim()) rules.push({ time: geekOffTime.trim(), did, on: false });
    if (!rules.length) {
      setStatus({ text: '请至少填写一个开启或关闭时间。', tone: 'warn' });
      return;
    }
    const ok = await runAndReload(
      'geek',
      { op: 'create-schedule', name, enable: geekEnable, rules },
      `正在向 BE6500 Pro 写入极客定时规则「${name}」…`,
      'auto',
    );
    if (ok) {
      setGeekName('');
      setGeekOpen(false);
    }
  };

  const createVar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!varScope.trim() || !varId.trim()) {
      setStatus({ text: '请填写变量 Scope 与 ID。', tone: 'warn' });
      return;
    }
    const ok = await runAndReload(
      'geek',
      { op: 'var-create', scope: varScope.trim(), id: varId.trim(), type: varType, value: varValue.trim() },
      `正在创建变量 ${varScope.trim()}.${varId.trim()}…`,
      'auto',
    );
    if (ok) {
      setVarId('');
      setVarValue('');
    }
  };

  const saveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await runAndReload(
      'config',
      {
        routerSsh: cfgRouter.trim(),
        speakerSsh: cfgSpeaker.trim(),
        protectedDevices: cfgProtected.split(/[,，\n]/).map(s => s.trim()).filter(Boolean),
        customAliases: parseCustomAliases(cfgAliases),
        cacheTtlMs: Number(cfgCacheTtl),
        topologyTtlMs: Number(cfgTopoTtl),
        udpTimeoutMs: Number(cfgUdpTimeout),
      },
      '正在保存米家中枢配置…',
      'refresh',
    );
    if (ok) setCfgDirty(false);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <HomeIcon className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">米家全屋中枢 · BE6500 Pro</h3>
          <Badge variant={data?.gateway?.online ? 'success' : data?.degraded ? 'warning' : 'secondary'}>
            {data?.configured === false ? '未配置' : data?.degraded ? '缓存降级' : data?.gateway?.online ? '在线' : '状态未知'}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {safeGeekHref && (
            <Button size="xs" variant="outline" render={<a href={safeGeekHref} target="_blank" rel="noopener noreferrer" />}>
              <span>极客版后台</span>
              <ExternalLinkIcon className="size-3" />
            </Button>
          )}
          <Button size="xs" variant="outline" disabled={busy || authExpired} onClick={() => void loadDashboard('refresh')}>
            <RefreshCwIcon className="size-3.5" />
            <span>同步拓扑</span>
          </Button>
          <Button size="xs" disabled={busy || authExpired} onClick={() => void loadDashboard('live')}>
            <ZapIcon className="size-3.5" />
            <span>实时测控刷新</span>
          </Button>
        </div>
      </div>

      {status && (
        <Alert variant={status.tone === 'err' ? 'error' : status.tone === 'warn' ? 'warning' : 'success'}>
          <AlertDescription className="text-xs">{status.text}</AlertDescription>
        </Alert>
      )}

      {/* Gateway KPI Summary */}
      <div className="grid gap-2 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-1"><CardDescription className="text-xs">中枢网关</CardDescription></CardHeader>
          <CardContent className="text-xs">
            <div className="font-semibold">{data?.gateway?.roleLabel || 'BE6500 Pro'}</div>
            <div className="text-muted-foreground">{data?.gateway?.ip || data?.routerSsh || '未配置'}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardDescription className="text-xs">全屋设备</CardDescription></CardHeader>
          <CardContent className="text-xs">
            <div className="font-mono text-base font-semibold">{devices.length} 台</div>
            <div className="text-muted-foreground">{meshDevices.length} 台蓝牙 Mesh</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardDescription className="text-xs">极客自动化</CardDescription></CardHeader>
          <CardContent className="text-xs">
            <div className="font-mono text-base font-semibold">{graphs.filter(g => g.enable).length}/{graphs.length}</div>
            <div className="text-muted-foreground">{data?.geekReady ? '引擎运行中' : '待检测'}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardDescription className="text-xs">场景 / 变量</CardDescription></CardHeader>
          <CardContent className="text-xs">
            <div className="font-mono text-base font-semibold">{data?.scenes?.length ?? 0} / {data?.variables?.length ?? 0}</div>
            <div className="text-muted-foreground">{data?.speaker?.configured ? '小爱音箱已绑' : '音箱未配'}</div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={tab} onValueChange={v => setTab(v as MiotTab)}>
        <TabsList>
          <TabsTab value="mesh">设备总控 ({devices.length})</TabsTab>
          <TabsTab value="geek">极客规则 ({graphs.length})</TabsTab>
          <TabsTab value="scenes">场景与变量</TabsTab>
          <TabsTab value="config">中枢与保护配置</TabsTab>
        </TabsList>

        <TabsPanel value="mesh" className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              <Button size="xs" variant={selectedRoom === '' ? 'default' : 'outline'} onClick={() => setSelectedRoom('')}>
                全部房间
              </Button>
              {rooms.map(rm => (
                <Button key={rm} size="xs" variant={selectedRoom === rm ? 'default' : 'outline'} onClick={() => setSelectedRoom(rm)}>
                  {rm}
                </Button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  { k: 'all', l: '全部通道' },
                  { k: 'bt_mesh', l: '蓝牙Mesh' },
                  { k: 'miio_udp', l: '局域网miio' },
                  { k: 'xiaoai_nlp', l: '小爱语音' },
                ] as const
              ).map(ch => (
                <Button key={ch.k} size="xs" variant={selectedChannel === ch.k ? 'secondary' : 'ghost'} onClick={() => setSelectedChannel(ch.k)}>
                  {ch.l}
                </Button>
              ))}
              <Button size="xs" variant="outline" disabled={busy} onClick={() => setBatchConfirm(true)}>全亮 Mesh</Button>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => setBatchConfirm(false)}>全关 Mesh</Button>
            </div>
          </div>

          {filteredDevices.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">暂无匹配的米家设备。</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {filteredDevices.map(dev => (
                <Card key={dev.did}>
                  <CardHeader className="pb-1">
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className="text-xs font-semibold truncate">{dev.fullName}</CardTitle>
                      <div className="flex shrink-0 items-center gap-1">
                        {dev.protected && <Badge variant="warning">保护</Badge>}
                        <Badge variant={dev.online ? 'success' : 'secondary'}>{dev.online ? '在线' : '离线'}</Badge>
                      </div>
                    </div>
                    <CardDescription className="text-[11px] font-mono">
                      {dev.modelName || dev.model} · {dev.ip ? `IP ${dev.ip}` : `DID ${dev.did}`}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {dev.liveError && <p className="text-[11px] text-warning">{dev.liveError}</p>}
                    <div className="flex flex-wrap gap-1.5">
                      {dev.controlChannel === 'bt_mesh' && dev.controllable ? (
                        <>
                          <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAndReload('set', { did: dev.did, on: true }, `正在打开 ${dev.fullName}…`, 'live')}>
                            打开
                          </Button>
                          <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAndReload('set', { did: dev.did, on: false }, `正在关闭 ${dev.fullName}…`, 'live')}>
                            关闭
                          </Button>
                        </>
                      ) : dev.category === 'air_fryer' && dev.controlChannel === 'miio_udp' ? (
                        <>
                          <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAndReload('cook', { did: dev.did, op: 'status' }, '查询炸锅状态…', 'auto')}>状态</Button>
                          <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAndReload('cook', { did: dev.did, op: 'pause' }, '暂停炸锅…', 'auto')}>暂停</Button>
                          <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAndReload('cook', { did: dev.did, op: 'stop' }, '停止炸锅…', 'auto')}>停止</Button>
                        </>
                      ) : dev.controlChannel === 'xiaoai_nlp' && dev.category === 'air_conditioner' ? (
                        <>
                          <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAndReload('set', { did: dev.did, on: true }, `开启 ${dev.fullName}…`, 'live')}>开机</Button>
                          <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAndReload('set', { did: dev.did, temperature: 26 }, `设定 26℃…`, 'live')}>26℃</Button>
                          <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAndReload('set', { did: dev.did, on: false }, `关闭 ${dev.fullName}…`, 'live')}>关机</Button>
                        </>
                      ) : dev.controlChannel === 'tv_agent' ? (
                        <Button size="xs" variant="outline" disabled={busy} onClick={() => void runAndReload('set', { did: dev.did, toggle: true }, `切换 ${dev.fullName} 电源…`, 'live')}>
                          电源切换
                        </Button>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">{dev.controllable ? '仅查看' : '只读节点'}</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsPanel>

        <TabsPanel value="geek" className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button size="xs" variant="outline" onClick={() => setGeekOpen(v => !v)}>
              <PlusIcon className="size-3.5" />
              <span>{geekOpen ? '收起新建' : '新建定时自动化'}</span>
            </Button>
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void loadDashboard('refresh')}>
              <RefreshCwIcon className="size-3.5" />
              <span>刷新规则</span>
            </Button>
          </div>

          {geekOpen && (
            <Card>
              <CardContent className="pt-4">
                <form onSubmit={e => void createGeekSchedule(e)} className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label className="text-xs">规则名称</Label>
                    <Input size="sm" value={geekName} onChange={e => setGeekName(e.target.value)} placeholder="如：客厅灯早晚定时" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">目标蓝牙 Mesh 设备</Label>
                    <select
                      value={geekDid}
                      onChange={e => setGeekDid(e.target.value)}
                      className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
                    >
                      {!meshDevices.length ? <option value="">暂无设备</option> : meshDevices.map(d => <option key={d.did} value={d.did}>{d.fullName}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">开启时间 (HH:mm)</Label>
                    <Input size="sm" value={geekOnTime} onChange={e => setGeekOnTime(e.target.value)} placeholder="07:30" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">关闭时间 (HH:mm)</Label>
                    <Input size="sm" value={geekOffTime} onChange={e => setGeekOffTime(e.target.value)} placeholder="23:30" />
                  </div>
                  <div className="sm:col-span-2 flex items-center justify-between pt-1">
                    <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                      <Checkbox checked={geekEnable} onCheckedChange={v => setGeekEnable(Boolean(v))} />
                      <span>写入后立即启用</span>
                    </label>
                    <Button type="submit" size="sm" disabled={busy}>写入中枢规则</Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          {graphs.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">中枢上暂无极客版自动化规则。</p>
          ) : (
            <div className="space-y-2">
              {graphs.map(g => (
                <Card key={g.id}>
                  <CardContent className="flex flex-wrap items-center justify-between gap-2 pt-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant={g.enable ? 'success' : 'secondary'}>{g.enable ? '运行中' : '已停用'}</Badge>
                        <span className="text-xs font-semibold">{g.name || g.id}</span>
                        <span className="font-mono text-[11px] text-muted-foreground">ID {g.id} · {g.nodeCount} 节点</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{g.summary || '暂无摘要'}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="xs"
                        variant={g.enable ? 'outline' : 'default'}
                        disabled={busy}
                        onClick={() => void runAndReload('geek', { op: g.enable ? 'disable' : 'enable', id: g.id }, `${g.enable ? '停用' : '启用'}规则 ${g.name}…`, 'auto')}
                      >
                        {g.enable ? <PauseIcon className="size-3" /> : <PlayIcon className="size-3" />}
                        <span>{g.enable ? '停用' : '启用'}</span>
                      </Button>
                      <Button size="xs" variant="ghost" disabled={busy} onClick={() => setDelRuleTarget(g)} aria-label={`删除 ${g.name}`}>
                        <Trash2Icon className="size-3.5 text-destructive" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Geek Logs */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-xs font-medium">极客执行日志</CardTitle>
                <select
                  aria-label="筛选规则日志"
                  value={logFilterGraphId}
                  onChange={e => setLogFilterGraphId(e.target.value)}
                  className="h-7 rounded-md border border-input bg-background px-2 text-xs outline-none"
                >
                  <option value="">全部规则</option>
                  {graphs.map(g => <option key={g.id} value={g.id}>{g.name || g.id}</option>)}
                </select>
              </div>
            </CardHeader>
            <CardContent className="space-y-1">
              {filteredLogs.length === 0 ? (
                <p className="text-xs text-muted-foreground">暂无执行日志。</p>
              ) : (
                filteredLogs.slice(0, 30).map((entry, idx) => (
                  <div key={`${entry.ts}-${idx}`} className="flex items-center justify-between gap-2 border-b py-1 text-xs last:border-0">
                    <div className="min-w-0 truncate">
                      <span className="font-mono text-[11px] text-muted-foreground me-2">{timestamp(entry.ts)}</span>
                      <Badge variant="outline" className="me-1.5">{entry.graphName || entry.graphId}</Badge>
                      <span>{entry.summary}</span>
                    </div>
                    {entry.ok !== undefined && (
                      <Badge variant={entry.ok ? 'success' : 'error'}>{entry.ok ? '成功' : '异常'}</Badge>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="scenes" className="mt-3 space-y-4">
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-muted-foreground">本地化米家场景 ({data?.scenes?.length ?? 0})</h4>
            {!data?.scenes?.length ? (
              <p className="text-xs text-muted-foreground">暂无本地手动场景。</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {data.scenes.map(sc => (
                  <Card key={sc.id}>
                    <CardContent className="flex items-center justify-between gap-2 pt-3">
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium truncate">{sc.summary || sc.id}</span>
                          {sc.turnsOffProtected && <Badge variant="warning">含保护设备</Badge>}
                        </div>
                        <p className="font-mono text-[11px] text-muted-foreground">ID {sc.id}</p>
                      </div>
                      <Button
                        size="xs"
                        disabled={busy}
                        onClick={() => {
                          if (sc.turnsOffProtected) setSceneConfirmTarget(sc);
                          else void runAndReload('scene', { op: 'run', id: sc.id }, `正在触发「${sc.summary}」…`, 'auto');
                        }}
                      >
                        <PlayIcon className="size-3" />
                        <span>触发</span>
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* Variables */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-xs font-semibold">极客版自定义变量</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <form onSubmit={e => void createVar(e)} className="flex flex-wrap items-end gap-2">
                <div className="space-y-1">
                  <Label className="text-[11px]">Scope</Label>
                  <Input size="sm" className="w-24" value={varScope} onChange={e => setVarScope(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">ID</Label>
                  <Input size="sm" className="w-28" value={varId} onChange={e => setVarId(e.target.value)} placeholder="mode" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[11px]">类型</Label>
                  <select
                    value={varType}
                    onChange={e => setVarType(e.target.value === 'string' ? 'string' : 'number')}
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none"
                  >
                    <option value="number">number</option>
                    <option value="string">string</option>
                  </select>
                </div>
                <div className="space-y-1 flex-1 min-w-24">
                  <Label className="text-[11px]">初始值</Label>
                  <Input size="sm" value={varValue} onChange={e => setVarValue(e.target.value)} placeholder="0" />
                </div>
                <Button type="submit" size="sm" disabled={busy}>创建变量</Button>
              </form>

              {!data?.variables?.length ? (
                <p className="text-xs text-muted-foreground">当前没有自定义变量。</p>
              ) : (
                <div className="space-y-1.5">
                  {data.variables.map(v => {
                    const key = `${v.scope}.${v.id}`;
                    const curVal = dirtyVars[key] ?? (v.value === undefined || v.value === null ? '' : String(v.value));
                    return (
                      <div key={key} className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs">
                        <span className="font-mono font-medium">{key}</span>
                        <Badge variant="outline">{v.type}</Badge>
                        <Input
                          size="sm"
                          className="flex-1 min-w-28"
                          value={curVal}
                          onChange={e => setDirtyVars(prev => ({ ...prev, [key]: e.target.value }))}
                        />
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={async () => {
                            const ok = await runAndReload('geek', { op: 'var-set', scope: v.scope, id: v.id, value: curVal }, `更新 ${key}…`, 'auto');
                            if (ok) {
                              setDirtyVars(prev => {
                                const next = { ...prev };
                                delete next[key];
                                return next;
                              });
                            }
                          }}
                        >
                          写入
                        </Button>
                        <Button size="xs" variant="ghost" disabled={busy} onClick={() => setDelVarTarget(v)} aria-label={`删除 ${key}`}>
                          <Trash2Icon className="size-3.5 text-destructive" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsPanel>

        <TabsPanel value="config" className="mt-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-1.5 text-sm">
                <CpuIcon className="size-4" />
                <span>中枢通信与保护设备配置</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={e => void saveConfig(e)} className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">路由器 SSH 地址</Label>
                  <Input size="sm" value={cfgRouter} onChange={e => { setCfgDirty(true); setCfgRouter(e.target.value); }} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">小爱音箱 SSH 地址</Label>
                  <Input size="sm" value={cfgSpeaker} onChange={e => { setCfgDirty(true); setCfgSpeaker(e.target.value); }} />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">受保护设备（逗号分隔，批量关闭时跳过）</Label>
                  <Input size="sm" value={cfgProtected} onChange={e => { setCfgDirty(true); setCfgProtected(e.target.value); }} />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs">自定义别名映射（每行 key=alias1, alias2）</Label>
                  <Textarea size="sm" rows={3} value={cfgAliases} onChange={e => { setCfgDirty(true); setCfgAliases(e.target.value); }} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">状态缓存 TTL (ms)</Label>
                  <Input size="sm" type="number" value={cfgCacheTtl} onChange={e => { setCfgDirty(true); setCfgCacheTtl(e.target.value); }} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">拓扑缓存 TTL (ms)</Label>
                  <Input size="sm" type="number" value={cfgTopoTtl} onChange={e => { setCfgDirty(true); setCfgTopoTtl(e.target.value); }} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">UDP 超时 (ms)</Label>
                  <Input size="sm" type="number" value={cfgUdpTimeout} onChange={e => { setCfgDirty(true); setCfgUdpTimeout(e.target.value); }} />
                </div>
                <div className="sm:col-span-2 flex justify-end pt-1">
                  <Button type="submit" size="sm" disabled={busy || authExpired}>保存配置</Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </TabsPanel>
      </Tabs>

      <ConfirmActionDialog
        open={batchConfirm !== null}
        onOpenChange={open => { if (!open) setBatchConfirm(null); }}
        title={`批量${batchConfirm ? '打开' : '关闭'}蓝牙 Mesh 设备`}
        description={`确定批量${batchConfirm ? '打开' : '关闭'}${selectedRoom ? `「${selectedRoom}」的` : '全屋'}蓝牙 Mesh 设备吗？（受保护设备会自动跳过）`}
        confirmLabel={`确认${batchConfirm ? '打开' : '关闭'}`}
        busy={busy}
        onConfirm={async () => {
          const targetOn = batchConfirm!;
          setBatchConfirm(null);
          await runAndReload('mesh', { op: 'batch', on: targetOn, ...(selectedRoom ? { room: selectedRoom } : {}) }, `批量${targetOn ? '打开' : '关闭'} Mesh 设备…`, 'live');
        }}
      />

      <ConfirmActionDialog
        open={Boolean(delRuleTarget)}
        onOpenChange={open => { if (!open) setDelRuleTarget(null); }}
        title="删除极客规则"
        description={`确定删除规则「${delRuleTarget?.name ?? ''}」吗？`}
        busy={busy}
        onConfirm={async () => {
          const t = delRuleTarget!;
          setDelRuleTarget(null);
          await runAndReload('geek', { op: 'delete', id: t.id }, `删除规则「${t.name}」…`, 'auto');
        }}
      />

      <ConfirmActionDialog
        open={Boolean(sceneConfirmTarget)}
        onOpenChange={open => { if (!open) setSceneConfirmTarget(null); }}
        title="触发含保护设备的场景"
        description={`场景「${sceneConfirmTarget?.summary ?? ''}」包含关闭保护设备的操作，确定要触发吗？`}
        confirmLabel="确认触发"
        busy={busy}
        onConfirm={async () => {
          const sc = sceneConfirmTarget!;
          setSceneConfirmTarget(null);
          await runAndReload('scene', { op: 'run', id: sc.id, confirmProtected: true }, `触发「${sc.summary}」…`, 'auto');
        }}
      />

      <ConfirmActionDialog
        open={Boolean(delVarTarget)}
        onOpenChange={open => { if (!open) setDelVarTarget(null); }}
        title="删除极客版变量"
        description={`确定删除变量 ${delVarTarget ? `${delVarTarget.scope}.${delVarTarget.id}` : ''} 吗？`}
        busy={busy}
        onConfirm={async () => {
          const v = delVarTarget!;
          setDelVarTarget(null);
          const ok = await runAndReload('geek', { op: 'var-delete', scope: v.scope, id: v.id }, `删除 ${v.scope}.${v.id}…`, 'auto');
          if (ok) {
            setDirtyVars(prev => {
              const next = { ...prev };
              delete next[`${v.scope}.${v.id}`];
              return next;
            });
          }
        }}
      />
    </div>
  );
}

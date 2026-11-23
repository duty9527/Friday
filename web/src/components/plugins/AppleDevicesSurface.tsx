import { errorText, timestamp } from '@friday/web/shared/format.js';
import {
  BellRingIcon,
  LogOutIcon,
  MapPinIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  SmartphoneIcon,
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
import { Textarea } from '@/components/ui/textarea';
import { useFriday } from '@/lib/friday-store';

interface ApplePlaceMatch {
  name: string;
  distanceMeters: number;
  radiusMeters: number;
  inside: boolean;
}

interface AppleDeviceLocation {
  address?: string | null;
  shortAddress?: string | null;
  horizontalAccuracy: number | null;
  timestamp: number | null;
  isOld: boolean;
}

interface AppleDeviceItem {
  id: string;
  name: string;
  displayName: string;
  model: string;
  category: string;
  online: boolean;
  deviceStatusLabel?: string;
  batteryPercent: number | null;
  batteryStatusLabel: string;
  batteryIsCached?: boolean;
  lowPowerMode: boolean;
  soundCapable?: boolean;
  isFamily?: boolean;
  location: AppleDeviceLocation | null;
  place: ApplePlaceMatch | null;
}

interface ApplePluginConfig {
  region: 'cn' | 'global';
  includeFamily?: boolean;
  cacheTtlSec: number;
  minRefreshIntervalSec: number;
  minBatteryPct: number;
  watchDevices: string[];
  customAliases: Record<string, string>;
  places: Record<string, { lat: number; lng: number; radiusMeters: number }>;
}

interface ApplePluginStatusData {
  authState: 'unauthenticated' | 'pending_2fa' | 'authenticated' | 'expired';
  region: 'cn' | 'global';
  appleId: string;
  authenticatedAt: number | null;
  trustedPhones?: Array<{ id: number; numberWithDialCode: string; pushMode: string }>;
  fetchedAt?: number | null;
  devices?: AppleDeviceItem[];
  config?: ApplePluginConfig;
  geoConfigured?: boolean;
}

function fmtAliases(aliases?: Record<string, string>): string {
  if (!aliases) return '';
  return Object.entries(aliases).map(([k, v]) => `${k}=${v}`).join('\n');
}

function parseAliases(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    const eq = t.indexOf('=');
    if (eq > 0) {
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (k && v) out[k] = v;
    }
  }
  return out;
}

function fmtPlaces(places?: Record<string, { lat: number; lng: number; radiusMeters: number }>): string {
  if (!places) return '';
  return Object.entries(places)
    .map(([name, p]) => `${name}=${p.lat},${p.lng},${p.radiusMeters}`)
    .join('\n');
}

function parsePlaces(raw: string): Record<string, { lat: number; lng: number; radiusMeters: number }> {
  const out: Record<string, { lat: number; lng: number; radiusMeters: number }> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const name = t.slice(0, eq).trim();
    const [latStr, lngStr, rStr] = t.slice(eq + 1).split(',').map(s => s.trim());
    const lat = Number(latStr);
    const lng = Number(lngStr);
    const radiusMeters = rStr ? Number(rStr) : 200;
    if (name && Number.isFinite(lat) && Number.isFinite(lng)) {
      out[name] = { lat, lng, radiusMeters: Number.isFinite(radiusMeters) && radiusMeters > 0 ? radiusMeters : 200 };
    }
  }
  return out;
}

export default function AppleDevicesSurface() {
  const { authExpired, api, openSystemHub } = useFriday();
  const [data, setData] = useState<ApplePluginStatusData | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);

  // Auth inputs
  const [appleId, setAppleId] = useState('');
  const [password, setPassword] = useState('');
  const [region, setRegion] = useState<'cn' | 'global'>('cn');
  const [twoFaCode, setTwoFaCode] = useState('');
  const [twoFaMode, setTwoFaMode] = useState<'trusted_device' | 'sms'>('trusted_device');

  // Config inputs with dirty guard
  const [cfgDirty, setCfgDirty] = useState(false);
  const [cfgIncludeFamily, setCfgIncludeFamily] = useState(false);
  const [cfgCacheTtl, setCfgCacheTtl] = useState('120');
  const [cfgCooldown, setCfgCooldown] = useState('60');
  const [cfgMinBattery, setCfgMinBattery] = useState('20');
  const [cfgWatch, setCfgWatch] = useState('');
  const [cfgAliases, setCfgAliases] = useState('');
  const [cfgPlaces, setCfgPlaces] = useState('');

  const [logoutConfirm, setLogoutConfirm] = useState(false);

  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const callApple = useCallback(
    async (action: string, args: Record<string, unknown> = {}) => {
      return api<{ ok: boolean; message: string; data?: ApplePluginStatusData }>('/api/plugin-run', {
        plugin: 'apple-devices',
        action,
        args,
      });
    },
    [api],
  );

  const applyData = useCallback(
    (d: ApplePluginStatusData, forceConfig = false) => {
      setData(d);
      if (!cfgDirty || forceConfig) {
        if (d.appleId) setAppleId(prev => prev || d.appleId);
        setRegion(d.config?.region === 'global' ? 'global' : d.region === 'global' ? 'global' : 'cn');
        if (d.config) {
          setCfgIncludeFamily(Boolean(d.config.includeFamily));
          setCfgCacheTtl(String(d.config.cacheTtlSec ?? 120));
          setCfgCooldown(String(d.config.minRefreshIntervalSec ?? 60));
          setCfgMinBattery(String(d.config.minBatteryPct ?? 20));
          setCfgWatch((d.config.watchDevices ?? []).join(', '));
          setCfgAliases(fmtAliases(d.config.customAliases));
          setCfgPlaces(fmtPlaces(d.config.places));
        }
      }
    },
    [cfgDirty],
  );

  const loadStatus = useCallback(
    async (mode: 'auto' | 'cache' | 'refresh', preserveBanner = false) => {
      if (authExpired) return;
      const seq = ++seqRef.current;
      setBusy(true);
      try {
        const res =
          mode === 'refresh'
            ? await callApple('devices', { refresh: true })
            : await callApple('status', mode === 'cache' ? { cacheOnly: true } : {});
        if (!mountedRef.current || seq !== seqRef.current || authExpired) return;
        if (res.data) applyData(res.data);
        if (!preserveBanner && (mode === 'refresh' || !res.ok)) {
          setStatus({ text: res.message, tone: res.ok ? 'ok' : 'err' });
        }
      } catch (err) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        if (!preserveBanner) setStatus({ text: `读取 Apple Find My 失败：${errorText(err)}`, tone: 'err' });
      } finally {
        if (mountedRef.current && seq === seqRef.current) setBusy(false);
      }
    },
    [applyData, authExpired, callApple],
  );

  useEffect(() => {
    void loadStatus('auto');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!appleId.trim() || !password) {
      setStatus({ text: '请输入 Apple ID 账号与主密码。', tone: 'warn' });
      return;
    }
    const pwd = password;
    setPassword('');
    setBusy(true);
    setStatus({ text: '正在连接苹果认证服务器…', tone: 'warn' });
    try {
      const res = await callApple('auth-login', { appleId: appleId.trim(), password: pwd, region });
      if (!mountedRef.current) return;
      if (res.data) applyData(res.data, true);
      setStatus({
        text: res.message,
        tone: res.ok ? (res.data?.authState === 'pending_2fa' ? 'warn' : 'ok') : 'err',
      });
    } catch (err) {
      if (mountedRef.current) setStatus({ text: `登录失败：${errorText(err)}`, tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleVerify2fa = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = twoFaCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setStatus({ text: '请输入 6 位数字双重认证验证码。', tone: 'warn' });
      return;
    }
    setBusy(true);
    try {
      const res = await callApple('auth-verify', { code, mode: twoFaMode });
      if (!mountedRef.current) return;
      if (res.ok) setTwoFaCode('');
      if (res.data) applyData(res.data, true);
      setStatus({ text: res.message, tone: res.ok ? 'ok' : 'err' });
    } catch (err) {
      if (mountedRef.current) setStatus({ text: `2FA 验证失败：${errorText(err)}`, tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await callApple('config', {
        region,
        includeFamily: cfgIncludeFamily,
        cacheTtlSec: Number(cfgCacheTtl) || 120,
        minRefreshIntervalSec: Number(cfgCooldown) || 60,
        minBatteryPct: Number(cfgMinBattery) || 20,
        watchDevices: cfgWatch.split(/[,，\n]/).map(s => s.trim()).filter(Boolean),
        customAliases: parseAliases(cfgAliases),
        places: parsePlaces(cfgPlaces),
      });
      if (!mountedRef.current) return;
      if (res.ok) setCfgDirty(false);
      setStatus({ text: res.message, tone: res.ok ? 'ok' : 'err' });
      await loadStatus('cache', true);
    } catch (err) {
      if (mountedRef.current) setStatus({ text: `保存配置失败：${errorText(err)}`, tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const authBadge =
    data?.authState === 'authenticated'
      ? { label: `已登录 · ${data.appleId || ''}`, variant: 'success' as const }
      : data?.authState === 'pending_2fa'
        ? { label: '等待双重认证 (2FA)', variant: 'warning' as const }
        : data?.authState === 'expired'
          ? { label: '会话已过期', variant: 'error' as const }
          : { label: '未登录 Apple ID', variant: 'secondary' as const };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SmartphoneIcon className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">苹果生态 · Find My 设备定位与电控</h3>
          <Badge variant={authBadge.variant}>{authBadge.label}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant="outline" onClick={() => openSystemHub('services')}>
            <MapPinIcon className="size-3.5" />
            <span>高德坐标设置 ({data?.geoConfigured ? '已配' : '未配'})</span>
          </Button>
          <Button size="xs" variant="outline" disabled={busy || authExpired} onClick={() => void loadStatus('cache')}>
            仅查缓存
          </Button>
          <Button size="xs" disabled={busy || authExpired} onClick={() => void loadStatus('refresh')}>
            <RefreshCwIcon className="size-3.5" />
            <span>实时拉取设备</span>
          </Button>
          {data?.authState === 'authenticated' && (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setLogoutConfirm(true)}>
              <LogOutIcon className="size-3.5 text-destructive" />
              <span>退出登录</span>
            </Button>
          )}
        </div>
      </div>

      {status && (
        <Alert variant={status.tone === 'err' ? 'error' : status.tone === 'warn' ? 'warning' : 'success'}>
          <AlertDescription className="text-xs">{status.text}</AlertDescription>
        </Alert>
      )}

      {/* Auth Section when not authenticated */}
      {data?.authState !== 'authenticated' && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <ShieldAlertIcon className="size-4 text-warning" />
              <span>Apple ID 会话认证</span>
            </CardTitle>
            <CardDescription className="text-xs">支持国区 / 国际区 Apple ID 登录、受信任设备弹窗或短信双重认证</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={e => void handleLogin(e)} className="grid gap-2 sm:grid-cols-4 items-end">
              <div className="space-y-1">
                <Label className="text-xs">Apple ID</Label>
                <Input size="sm" value={appleId} onChange={e => setAppleId(e.target.value)} placeholder="name@icloud.com" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">密码</Label>
                <Input size="sm" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="仅内存校验不落盘" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">区服</Label>
                <select
                  value={region}
                  onChange={e => setRegion(e.target.value === 'global' ? 'global' : 'cn')}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
                >
                  <option value="cn">中国内地 (icloud.com.cn)</option>
                  <option value="global">国际区 (icloud.com)</option>
                </select>
              </div>
              <Button type="submit" size="sm" disabled={busy}>登录连接</Button>
            </form>

            {data?.authState === 'pending_2fa' && (
              <form onSubmit={e => void handleVerify2fa(e)} className="flex flex-wrap items-end gap-2 border-t pt-3">
                <div className="space-y-1">
                  <Label className="text-xs">6 位验证码</Label>
                  <Input size="sm" className="w-32 font-mono" maxLength={6} value={twoFaCode} onChange={e => setTwoFaCode(e.target.value)} placeholder="123456" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">校验模式</Label>
                  <select
                    value={twoFaMode}
                    onChange={e => setTwoFaMode(e.target.value === 'sms' ? 'sms' : 'trusted_device')}
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none"
                  >
                    <option value="trusted_device">受信任设备弹窗</option>
                    <option value="sms">手机短信验证码</option>
                  </select>
                </div>
                <Button type="submit" size="sm" disabled={busy}>核验 2FA</Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const res = await callApple('auth-sms', {});
                      if (res.data) applyData(res.data);
                      if (res.ok) setTwoFaMode('sms');
                      setStatus({ text: res.message, tone: res.ok ? 'ok' : 'err' });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  请求发送短信
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const res = await callApple('auth-verify', { bypass2fa: true });
                      if (res.data) applyData(res.data, true);
                      setStatus({ text: res.message, tone: res.ok ? 'ok' : 'err' });
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  尝试免码直通
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      )}

      {/* Device Grid */}
      <div className="grid gap-2 sm:grid-cols-2">
        {!(data?.devices?.length) ? (
          <Card className="sm:col-span-2">
            <CardContent className="py-6 text-center text-xs text-muted-foreground">
              {data?.authState === 'authenticated' ? '暂无 Find My 设备记录，点击上方「实时拉取设备」刷新。' : '完成上方 Apple ID 登录后可查看设备电量、实时位置与响铃控制。'}
            </CardContent>
          </Card>
        ) : (
          data.devices.map(dev => (
            <Card key={dev.id}>
              <CardHeader className="pb-1">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-xs font-semibold truncate">
                    {dev.name}
                    {dev.isFamily && <Badge variant="secondary" className="ms-1.5">家人</Badge>}
                  </CardTitle>
                  <Badge variant={dev.online ? 'success' : 'secondary'}>
                    {dev.deviceStatusLabel || (dev.online ? '在线' : '离线')}
                  </Badge>
                </div>
                <CardDescription className="text-[11px]">
                  {dev.displayName || dev.model} · 电量 {dev.batteryPercent !== null ? `${dev.batteryPercent}%` : '未知'}
                  {dev.lowPowerMode ? ' · 低电量模式' : ''}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-xs">
                <div className="text-muted-foreground">
                  {dev.place ? (
                    <Badge variant={dev.place.inside ? 'success' : 'outline'} className="me-1.5">
                      {dev.place.inside ? `位于 ${dev.place.name}` : `距 ${dev.place.name} ${Math.round(dev.place.distanceMeters)}m`}
                    </Badge>
                  ) : null}
                  <span>{dev.location?.shortAddress || dev.location?.address || '暂无定位坐标'}</span>
                  {dev.location?.timestamp ? <span className="ms-1 font-mono text-[10px]">({timestamp(dev.location.timestamp)})</span> : null}
                </div>
                {dev.soundCapable && (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const res = await callApple('play-sound', { device: dev.id });
                        setStatus({ text: res.message || `已向 ${dev.name} 发送响铃指令`, tone: res.ok ? 'ok' : 'err' });
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <BellRingIcon className="size-3.5" />
                    <span>播放查找提示音</span>
                  </Button>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Config Form */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">定位策略与地理围栏配置</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={e => void handleSaveConfig(e)} className="grid gap-2 sm:grid-cols-3 text-xs">
            <div className="space-y-1">
              <Label className="text-xs">缓存 TTL (秒)</Label>
              <Input size="sm" type="number" value={cfgCacheTtl} onChange={e => { setCfgDirty(true); setCfgCacheTtl(e.target.value); }} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">最小拉取冷却 (秒)</Label>
              <Input size="sm" type="number" value={cfgCooldown} onChange={e => { setCfgDirty(true); setCfgCooldown(e.target.value); }} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">低电量告警阈值 (%)</Label>
              <Input size="sm" type="number" value={cfgMinBattery} onChange={e => { setCfgDirty(true); setCfgMinBattery(e.target.value); }} />
            </div>
            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs">重点关注设备（逗号分隔）</Label>
              <Input size="sm" value={cfgWatch} onChange={e => { setCfgDirty(true); setCfgWatch(e.target.value); }} />
            </div>
            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs">设备别名（每行 别名=原设备名）</Label>
              <Textarea size="sm" rows={2} value={cfgAliases} onChange={e => { setCfgDirty(true); setCfgAliases(e.target.value); }} />
            </div>
            <div className="space-y-1 sm:col-span-3">
              <Label className="text-xs">地理围栏地点（每行 名称=lat,lng,radiusMeters）</Label>
              <Textarea size="sm" rows={2} value={cfgPlaces} onChange={e => { setCfgDirty(true); setCfgPlaces(e.target.value); }} />
            </div>
            <div className="sm:col-span-3 flex flex-wrap items-center justify-between gap-2 pt-1">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <Checkbox checked={cfgIncludeFamily} onCheckedChange={v => { setCfgDirty(true); setCfgIncludeFamily(Boolean(v)); }} />
                <span>包含「家庭共享」成员设备</span>
              </label>
              <Button type="submit" size="sm" disabled={busy}>保存配置</Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <ConfirmActionDialog
        open={logoutConfirm}
        onOpenChange={setLogoutConfirm}
        title="退出 Apple ID 会话"
        description="确定退出当前 Apple ID 会话并清除本机缓存的查找认证状态吗？"
        confirmLabel="确认退出"
        busy={busy}
        onConfirm={async () => {
          setLogoutConfirm(false);
          setBusy(true);
          try {
            const res = await callApple('logout', {});
            setStatus({ text: res.message, tone: res.ok ? 'ok' : 'err' });
            await loadStatus('cache', true);
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

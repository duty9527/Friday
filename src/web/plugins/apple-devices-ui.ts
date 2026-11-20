import { button, element, isEditingWithin, kpiCard, node, svgNode } from '../shared/dom.js';
import { errorText, timestamp } from '../shared/format.js';
import { api, appState } from '../state.js';

export interface AppleDevicesUiOptions {
  isVisible: () => boolean;
}

export interface AppleDevicesUiController {
  activate: () => void;
  deactivate: () => void;
  refreshBadge: () => Promise<void>;
}

interface ApplePlaceMatch {
  name: string;
  distanceMeters: number;
  radiusMeters: number;
  inside: boolean;
}

interface AppleDeviceLocation {
  latitude?: number;
  longitude?: number;
  horizontalAccuracy: number | null;
  positionType: string | null;
  timestamp: number | null;
  isOld: boolean;
}

interface AppleDeviceItem {
  id: string;
  name: string;
  displayName: string;
  model: string;
  category: 'iphone' | 'ipad' | 'mac' | 'watch' | 'airpods' | 'other' | string;
  online: boolean;
  deviceStatus: string;
  batteryPercent: number | null;
  batteryStatus: string;
  batteryStatusLabel: string;
  lowPowerMode: boolean;
  lostModeCapable: boolean;
  isLocating: boolean;
  location: AppleDeviceLocation | null;
  place: ApplePlaceMatch | null;
}

interface ApplePluginConfig {
  region: 'cn' | 'global';
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
  cacheAgeSec?: number | null;
  fromCache?: boolean;
  cooldownActive?: boolean;
  cooldownRemainingSec?: number;
  devices?: AppleDeviceItem[];
  config?: ApplePluginConfig;
}

interface PluginRunEnvelope {
  ok: boolean;
  plugin: string;
  action: string;
  notify: boolean;
  title?: string;
  message: string;
  data?: ApplePluginStatusData;
}

const CATEGORY_ICONS: Record<string, string> = {
  iphone: '📱',
  ipad: '📲',
  mac: '💻',
  watch: '⌚',
  airpods: '🎧',
  other: '🍎',
};

const AUTH_STATE_DISPLAY: Record<string, { text: string; badgeClass: string }> = {
  authenticated: { text: '● 已绑定会话', badgeClass: 'hub-badge badge-green' },
  pending_2fa: { text: '🔐 等待 2FA 验证', badgeClass: 'hub-badge badge-amber' },
  expired: { text: '⚠️ 会话已过期', badgeClass: 'hub-badge badge-red' },
  unauthenticated: { text: '未绑定', badgeClass: 'hub-badge badge-slate' },
};

async function runApplePlugin(action: string, args: Record<string, unknown> = {}): Promise<PluginRunEnvelope> {
  return await api<PluginRunEnvelope>('/api/plugin-run', {
    plugin: 'apple-devices',
    action,
    args,
  });
}

function formatPlacesTextarea(places: ApplePluginConfig['places'] | undefined): string {
  if (!places) return '';
  return Object.entries(places)
    .map(([name, cfg]) => `${name}=${cfg.lat},${cfg.lng},${cfg.radiusMeters}`)
    .join('\n');
}

function formatAliasesTextarea(aliases: ApplePluginConfig['customAliases'] | undefined): string {
  if (!aliases) return '';
  return Object.entries(aliases)
    .map(([alias, target]) => `${alias}=${target}`)
    .join('\n');
}

function parseAliasesTextarea(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf('=');
    if (sep <= 0) continue;
    const key = trimmed.slice(0, sep).trim();
    const val = trimmed.slice(sep + 1).trim();
    if (key && val) out[key] = val;
  }
  return out;
}

function parsePlacesTextarea(raw: string): Record<string, { lat: number; lng: number; radiusMeters: number }> {
  const out: Record<string, { lat: number; lng: number; radiusMeters: number }> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf('=');
    if (sep <= 0) continue;
    const name = trimmed.slice(0, sep).trim();
    const coords = trimmed.slice(sep + 1).split(',').map(s => s.trim());
    const lat = Number(coords[0]);
    const lng = Number(coords[1]);
    const radiusMeters = Number(coords[2] ?? '250');
    if (name && Number.isFinite(lat) && Number.isFinite(lng)) {
      out[name] = {
        lat,
        lng,
        radiusMeters: Number.isFinite(radiusMeters) && radiusMeters >= 20 ? Math.round(radiusMeters) : 250,
      };
    }
  }
  return out;
}

function buildBatterySvg(percent: number | null, status: string, thresholdPct: number): SVGSVGElement {
  const svg = svgNode('svg', { viewBox: '0 0 200 10', class: 'apple-battery-svg', 'aria-hidden': 'true' });
  svg.append(svgNode('rect', { x: '0', y: '1', width: '200', height: '8', rx: '4', class: 'apple-battery-track' }));
  if (typeof percent === 'number') {
    const clamped = Math.max(0, Math.min(100, percent));
    const fillWidth = Math.max(clamped > 0 ? 4 : 0, Math.round((clamped / 100) * 200));
    const toneClass = status === 'Charging' || status === 'Charged'
      ? 'tone-charging'
      : clamped < thresholdPct
        ? 'tone-low'
        : clamped < 50
          ? 'tone-mid'
          : 'tone-ok';
    svg.append(svgNode('rect', {
      x: '0',
      y: '1',
      width: String(fillWidth),
      height: '8',
      rx: '4',
      class: `apple-battery-fill ${toneClass}`,
    }));
  }
  return svg;
}

export function initAppleDevicesUi(options: AppleDevicesUiOptions): AppleDevicesUiController {
  const topBadge = element<HTMLElement>('apple-top-badge');
  const authPill = element<HTMLElement>('apple-auth-pill');
  const refreshBtn = element<HTMLButtonElement>('apple-refresh-btn');
  const cachedBtn = element<HTMLButtonElement>('apple-cached-btn');
  const logoutBtn = element<HTMLButtonElement>('apple-logout-btn');
  const statusBanner = element<HTMLElement>('apple-action-status');
  const authSection = element<HTMLElement>('apple-auth-section');
  const boundAccountEl = element<HTMLElement>('apple-bound-account');
  const loginForm = element<HTMLElement>('apple-login-form');
  const loginActions = element<HTMLElement>('apple-login-actions');
  const regionSelect = element<HTMLSelectElement>('apple-region-select');
  const appleIdInput = element<HTMLInputElement>('apple-id-input');
  const passwordInput = element<HTMLInputElement>('apple-password-input');
  const loginBtn = element<HTMLButtonElement>('apple-login-btn');
  const twoFaBox = element<HTMLElement>('apple-2fa-box');
  const twoFaPhonesEl = element<HTMLElement>('apple-2fa-phones');
  const twoFaCodeInput = element<HTMLInputElement>('apple-2fa-code-input');
  const twoFaModeSelect = element<HTMLSelectElement>('apple-2fa-mode-select');
  const smsBtn = element<HTMLButtonElement>('apple-sms-btn');
  const twoFaVerifyBtn = element<HTMLButtonElement>('apple-2fa-verify-btn');
  const kpiGrid = element<HTMLElement>('apple-kpi-grid');
  const devicesSubtitle = element<HTMLElement>('apple-devices-subtitle');
  const devicesGrid = element<HTMLElement>('apple-devices-grid');
  const configDetails = element<HTMLDetailsElement>('apple-config-details');
  const cfgCacheTtl = element<HTMLInputElement>('apple-cfg-cache-ttl');
  const cfgCooldown = element<HTMLInputElement>('apple-cfg-cooldown');
  const cfgMinBattery = element<HTMLInputElement>('apple-cfg-min-battery');
  const cfgWatch = element<HTMLInputElement>('apple-cfg-watch');
  const cfgAliases = element<HTMLTextAreaElement>('apple-cfg-aliases');
  const cfgPlaces = element<HTMLTextAreaElement>('apple-cfg-places');
  const cfgSaveBtn = element<HTMLButtonElement>('apple-cfg-save-btn');

  let active = false;
  let busy = false;
  let lastData: ApplePluginStatusData | undefined;

  function setStatus(text: string, tone: 'ok' | 'warn' | 'err' = 'ok'): void {
    statusBanner.hidden = !text;
    statusBanner.textContent = text;
    statusBanner.className = `health-status-banner tone-${tone}`;
  }

  function updateTopBadge(data?: ApplePluginStatusData): void {
    const state = data?.authState ?? 'unauthenticated';
    if (state === 'authenticated') {
      const devices = data?.devices ?? [];
      const firstIphone = devices.find(d => d.category === 'iphone') ?? devices[0];
      if (firstIphone && typeof firstIphone.batteryPercent === 'number') {
        topBadge.textContent = `${firstIphone.batteryPercent}%`;
      } else {
        topBadge.textContent = `${devices.length}`;
      }
      return;
    }
    if (state === 'pending_2fa') {
      topBadge.textContent = '2FA';
      return;
    }
    if (state === 'expired') {
      topBadge.textContent = '过期';
      return;
    }
    topBadge.textContent = '未绑定';
  }

  function render(data: ApplePluginStatusData): void {
    lastData = data;
    updateTopBadge(data);

    const authState = data.authState ?? 'unauthenticated';
    const badgeInfo = AUTH_STATE_DISPLAY[authState] ?? AUTH_STATE_DISPLAY.unauthenticated!;
    authPill.textContent = badgeInfo.text;
    authPill.className = badgeInfo.badgeClass;

    logoutBtn.hidden = authState === 'unauthenticated';
    refreshBtn.disabled = busy || authState !== 'authenticated' || appState.authExpired || !appState.ready;
    cachedBtn.disabled = busy || appState.authExpired || !appState.ready;

    const showLoginFields = authState !== 'authenticated';
    loginForm.hidden = !showLoginFields || authState === 'pending_2fa';
    loginActions.hidden = !showLoginFields || authState === 'pending_2fa';
    twoFaBox.hidden = authState !== 'pending_2fa';

    if (authState === 'authenticated') {
      boundAccountEl.textContent = `当前已绑定 ${data.appleId || 'Apple ID'}（${data.region === 'cn' ? '国区 icloud.com.cn' : '国际区 icloud.com'}）`;
    } else if (authState === 'pending_2fa') {
      boundAccountEl.textContent = `账号 ${data.appleId || ''} 等待 6 位双重认证码`;
      const phones = data.trustedPhones ?? [];
      twoFaPhonesEl.textContent = phones.length > 0
        ? `备选短信号码：${phones.map(p => p.numberWithDialCode).join(' / ')}`
        : '请查看你名下 iPhone / iPad / Mac 收到的 6 位弹窗验证码';
    } else if (authState === 'expired') {
      boundAccountEl.textContent = `账号 ${data.appleId || ''} 会话已过期，请重新登录并完成 2FA 授权`;
    } else {
      boundAccountEl.textContent = '密码仅在当次计算密码学证明，绝不落盘、不进入聊天上下文';
    }

    const devices = data.devices ?? [];
    const minBatteryPct = data.config?.minBatteryPct ?? 25;
    const lowCount = devices.filter(d =>
      typeof d.batteryPercent === 'number'
      && d.batteryPercent < minBatteryPct
      && d.batteryStatus !== 'Charging'
      && d.batteryStatus !== 'Charged',
    ).length;
    const onlineCount = devices.filter(d => d.online).length;
    const updatedStr = data.fetchedAt ? timestamp(data.fetchedAt) : '尚无快照';

    const kpiFrag = document.createDocumentFragment();
    kpiFrag.append(
      kpiCard('会话状态', authState === 'authenticated' ? '已连接' : authState === 'pending_2fa' ? '待 2FA' : authState === 'expired' ? '已过期' : '未绑定', data.region === 'cn' ? '国区云上贵州' : '国际区', authState === 'authenticated' ? 'positive' : authState === 'expired' ? 'warning' : 'default'),
      kpiCard('设备总数', `${devices.length}`, `${onlineCount} 台在线`, devices.length > 0 ? 'accent' : 'default'),
      kpiCard('低电量告警', `${lowCount}`, `阈值 < ${minBatteryPct}%`, lowCount > 0 ? 'warning' : 'positive'),
      kpiCard('最近拉取', updatedStr, data.fromCache ? '缓存快照' : '实时直连', 'default'),
    );
    kpiGrid.replaceChildren(kpiFrag);

    devicesSubtitle.textContent = devices.length > 0
      ? `共 ${devices.length} 台设备 · ${data.fromCache ? '防耗电缓存模式' : '刚刚实时唤醒拉取'}`
      : '完成绑定并刷新后将在这里展示名下设备';

    if (devices.length === 0) {
      devicesGrid.replaceChildren(node('p', authState === 'authenticated' ? '暂无设备缓存，请点击右上角「🔄 实时刷新」。' : '请先在上方绑定你的 Apple ID。', 'empty'));
    } else {
      const frag = document.createDocumentFragment();
      for (const dev of devices) {
        const card = node('article', '', 'hub-entity-card apple-device-card');
        const head = node('div', '', 'hub-card-head');
        const titleGroup = node('div', '', 'hub-card-title-group');
        const icon = CATEGORY_ICONS[dev.category] ?? '🍎';
        titleGroup.append(
          node('span', `${icon} ${dev.name}`, 'hub-card-title'),
          node('span', dev.online ? '在线' : '离线', `hub-badge ${dev.online ? 'badge-green' : 'badge-slate'}`),
        );
        if (dev.lowPowerMode) {
          titleGroup.append(node('span', '低电量模式', 'hub-badge badge-amber'));
        }
        head.append(titleGroup, node('span', dev.model, 'meta'));
        card.append(head);

        const batRow = node('div', '', 'apple-battery-row');
        const batText = typeof dev.batteryPercent === 'number'
          ? `🔋 ${dev.batteryPercent}% · ${dev.batteryStatusLabel}`
          : '🔋 暂无电量上报';
        batRow.append(
          node('span', batText, 'apple-battery-text'),
          buildBatterySvg(dev.batteryPercent, dev.batteryStatus, minBatteryPct),
        );
        card.append(batRow);

        let locText = '📍 暂无位置上报';
        if (dev.place?.inside) {
          locText = `📍 在「${dev.place.name}」附近（约 ${dev.place.distanceMeters}m）`;
        } else if (dev.place) {
          locText = `📍 距「${dev.place.name}」约 ${dev.place.distanceMeters}m`;
        } else if (dev.location) {
          const acc = dev.location.horizontalAccuracy !== null ? ` · 精度 ${dev.location.horizontalAccuracy}m` : '';
          const oldTag = dev.location.isOld ? '（历史位置）' : '';
          locText = `📍 ${dev.location.latitude ?? '**'}, ${dev.location.longitude ?? '**'}${acc}${oldTag}`;
        }
        card.append(node('div', locText, 'meta apple-location-line'));

        const actionsRow = node('div', '', 'apple-card-actions');
        const ringBtn = button('🔊 播放提示音', () => {
          void handlePlaySound(dev);
        }, 'mini-button');
        ringBtn.disabled = busy || authState !== 'authenticated';
        actionsRow.append(
          node('span', dev.id, 'apple-device-id meta'),
          ringBtn,
        );
        card.append(actionsRow);
        frag.append(card);
      }
      devicesGrid.replaceChildren(frag);
    }

    if (data.config && !isEditingWithin(configDetails)) {
      if (!isEditingWithin(authSection)) {
        regionSelect.value = data.config.region;
      }
      cfgCacheTtl.value = String(data.config.cacheTtlSec);
      cfgCooldown.value = String(data.config.minRefreshIntervalSec);
      cfgMinBattery.value = String(data.config.minBatteryPct);
      cfgWatch.value = (data.config.watchDevices ?? []).join(', ');
      cfgAliases.value = formatAliasesTextarea(data.config.customAliases);
      cfgPlaces.value = formatPlacesTextarea(data.config.places);
    }
  }

  async function loadStatus(refresh = false): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const action = refresh ? 'devices' : 'status';
      const res = await runApplePlugin(action, refresh ? { refresh: true } : {});
      if (res.data) {
        render(res.data);
      }
      if (!res.ok) {
        setStatus(res.message || '操作失败', 'err');
      } else if (refresh) {
        const msg = res.data?.cooldownActive
          ? `命中防耗电冷却（${res.data.cooldownRemainingSec}s 后可再次唤醒），已返回最近缓存`
          : '已刷新苹果设备实时状态';
        setStatus(msg, res.data?.cooldownActive ? 'warn' : 'ok');
      } else {
        setStatus('');
      }
    } catch (err) {
      setStatus(`加载苹果设备状态失败：${errorText(err)}`, 'err');
    } finally {
      busy = false;
      if (lastData) {
        refreshBtn.disabled = lastData.authState !== 'authenticated';
      }
    }
  }

  async function handlePlaySound(dev: AppleDeviceItem): Promise<void> {
    if (busy) return;
    busy = true;
    setStatus(`正在向 ${dev.name} 发送 Find My 响铃指令…`, 'warn');
    try {
      const res = await runApplePlugin('play-sound', { device: dev.id });
      setStatus(res.message || (res.ok ? `已触发 ${dev.name} 响铃` : '响铃失败'), res.ok ? 'ok' : 'err');
    } catch (err) {
      setStatus(`发送响铃失败：${errorText(err)}`, 'err');
    } finally {
      busy = false;
    }
  }

  async function handleLogin(): Promise<void> {
    const appleId = appleIdInput.value.trim();
    const password = passwordInput.value;
    const region = regionSelect.value === 'global' ? 'global' : 'cn';
    if (!appleId || !password) {
      setStatus('请输入 Apple ID 账号与主密码。', 'warn');
      return;
    }
    passwordInput.value = '';
    busy = true;
    loginBtn.disabled = true;
    setStatus('正在通过 SRP-6a 协议连接苹果认证服务器…', 'warn');
    try {
      const res = await runApplePlugin('auth-login', { appleId, password, region });
      if (res.data) {
        render(res.data);
      }
      setStatus(res.message, res.ok ? (res.data?.authState === 'pending_2fa' ? 'warn' : 'ok') : 'err');
    } catch (err) {
      setStatus(`登录失败：${errorText(err)}`, 'err');
    } finally {
      busy = false;
      loginBtn.disabled = false;
    }
  }

  async function handleSendSms(): Promise<void> {
    if (busy) return;
    busy = true;
    smsBtn.disabled = true;
    setStatus('正在请求向受信任手机号发送短信验证码…', 'warn');
    try {
      const res = await runApplePlugin('auth-sms', {});
      if (res.data) render(res.data);
      if (res.ok) twoFaModeSelect.value = 'sms';
      setStatus(res.message, res.ok ? 'ok' : 'err');
    } catch (err) {
      setStatus(`发送短信验证码失败：${errorText(err)}`, 'err');
    } finally {
      busy = false;
      smsBtn.disabled = false;
    }
  }

  async function handleVerify2fa(): Promise<void> {
    const code = twoFaCodeInput.value.trim();
    const mode = twoFaModeSelect.value === 'sms' ? 'sms' : 'trusted_device';
    if (!/^\d{6}$/.test(code)) {
      setStatus('请输入 6 位数字双重认证验证码。', 'warn');
      return;
    }
    if (busy) return;
    busy = true;
    twoFaVerifyBtn.disabled = true;
    setStatus('正在核验 6 位验证码并建立长期信任会话…', 'warn');
    try {
      const res = await runApplePlugin('auth-verify', { code, mode });
      if (res.ok) twoFaCodeInput.value = '';
      if (res.data) render(res.data);
      setStatus(res.message, res.ok ? 'ok' : 'err');
    } catch (err) {
      setStatus(`2FA 验证失败：${errorText(err)}`, 'err');
    } finally {
      busy = false;
      twoFaVerifyBtn.disabled = false;
    }
  }

  async function handleLogout(): Promise<void> {
    if (busy) return;
    busy = true;
    logoutBtn.disabled = true;
    try {
      const res = await runApplePlugin('logout', {});
      setStatus(res.message, res.ok ? 'ok' : 'err');
      busy = false;
      await loadStatus(false);
    } catch (err) {
      setStatus(`退出失败：${errorText(err)}`, 'err');
    } finally {
      busy = false;
      logoutBtn.disabled = false;
    }
  }

  async function handleSaveConfig(): Promise<void> {
    if (busy) return;
    busy = true;
    cfgSaveBtn.disabled = true;
    try {
      const watchDevices = cfgWatch.value
        .split(/[,，\n]/)
        .map(s => s.trim())
        .filter(Boolean);
      const res = await runApplePlugin('config', {
        region: regionSelect.value === 'global' ? 'global' : 'cn',
        cacheTtlSec: Number(cfgCacheTtl.value),
        minRefreshIntervalSec: Number(cfgCooldown.value),
        minBatteryPct: Number(cfgMinBattery.value),
        watchDevices,
        customAliases: parseAliasesTextarea(cfgAliases.value),
        places: parsePlacesTextarea(cfgPlaces.value),
      });
      setStatus(res.message, res.ok ? 'ok' : 'err');
      busy = false;
      await loadStatus(false);
    } catch (err) {
      setStatus(`保存配置失败：${errorText(err)}`, 'err');
    } finally {
      busy = false;
      cfgSaveBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener('click', () => { void loadStatus(true); });
  cachedBtn.addEventListener('click', () => { void loadStatus(false); });
  loginBtn.addEventListener('click', () => { void handleLogin(); });
  smsBtn.addEventListener('click', () => { void handleSendSms(); });
  twoFaVerifyBtn.addEventListener('click', () => { void handleVerify2fa(); });
  logoutBtn.addEventListener('click', () => { void handleLogout(); });
  cfgSaveBtn.addEventListener('click', () => { void handleSaveConfig(); });

  return {
    activate: () => {
      active = true;
      if (options.isVisible()) {
        void loadStatus(false);
      }
    },
    deactivate: () => {
      active = false;
    },
    refreshBadge: async () => {
      if (active) return;
      try {
        const res = await runApplePlugin('status', {});
        if (res.data) {
          lastData = res.data;
          updateTopBadge(res.data);
        }
      } catch {
        // Silent badge refresh failure
      }
    },
  };
}

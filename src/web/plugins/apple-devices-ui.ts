import { button, element, isEditingWithin, kpiCard, node, svgNode } from '../shared/dom.js';
import { errorText, timestamp } from '../shared/format.js';
import { announceStatus, attachDelayedFormValidation, confirmAction, safeFocus } from '../shared/ui-primitives.js';
import { api, appState, hooks, type ApiRequestOptions } from '../state.js';

export interface AppleDevicesUiOptions {
  isVisible: () => boolean;
}

export interface AppleDevicesUiController {
  activate: () => void;
  deactivate: () => void;
  refreshBadge: () => Promise<void>;
  dispose: () => void;
}

interface ApplePlaceMatch {
  name: string;
  distanceMeters: number;
  radiusMeters: number;
  inside: boolean;
}

interface AppleDeviceLocation {
  latitude?: number | null;
  longitude?: number | null;
  gcjLat?: number | null;
  gcjLon?: number | null;
  address?: string | null;
  shortAddress?: string | null;
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
  deviceStatusLabel?: string;
  batteryPercent: number | null;
  batteryStatus: string;
  batteryStatusLabel: string;
  batteryIsCached?: boolean;
  batteryUpdatedAt?: number | null;
  lowPowerMode: boolean;
  lostModeCapable: boolean;
  isLocating: boolean;
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
  cacheAgeSec?: number | null;
  fromCache?: boolean;
  cooldownActive?: boolean;
  cooldownRemainingSec?: number;
  devices?: AppleDeviceItem[];
  config?: ApplePluginConfig;
  geoConfigured?: boolean;
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

async function runApplePlugin(
  action: string,
  args: Record<string, unknown> = {},
  reqOpts?: ApiRequestOptions,
): Promise<PluginRunEnvelope> {
  return await api<PluginRunEnvelope>('/api/plugin-run', {
    plugin: 'apple-devices',
    action,
    args,
  }, reqOpts);
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
  // FakeDOM fallback: FakeElement.click() on <button type="submit"> does not dispatch form 'submit'.
  listenEvent(submitBtn, 'click', e => {
    if (typeof form.requestSubmit !== 'function') {
      e.preventDefault();
      onSubmit();
    }
  }, signal);
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
  const loginSubmitForm = element<HTMLFormElement>('apple-login-submit-form');
  const loginForm = element<HTMLElement>('apple-login-form');
  const loginActions = element<HTMLElement>('apple-login-actions');
  const regionSelect = element<HTMLSelectElement>('apple-region-select');
  const appleIdInput = element<HTMLInputElement>('apple-id-input');
  const passwordInput = element<HTMLInputElement>('apple-password-input');
  const loginBtn = element<HTMLButtonElement>('apple-login-btn');
  const twoFaBox = element<HTMLFormElement>('apple-2fa-box');
  const twoFaPhonesEl = element<HTMLElement>('apple-2fa-phones');
  const twoFaCodeInput = element<HTMLInputElement>('apple-2fa-code-input');
  const twoFaModeSelect = element<HTMLSelectElement>('apple-2fa-mode-select');
  const smsBtn = element<HTMLButtonElement>('apple-sms-btn');
  const bypass2faBtn = element<HTMLButtonElement>('apple-bypass-2fa-btn');
  const twoFaVerifyBtn = element<HTMLButtonElement>('apple-2fa-verify-btn');
  const kpiGrid = element<HTMLElement>('apple-kpi-grid');
  const devicesSubtitle = element<HTMLElement>('apple-devices-subtitle');
  const devicesGrid = element<HTMLElement>('apple-devices-grid');
  const configDetails = element<HTMLDetailsElement>('apple-config-details');
  const cfgForm = element<HTMLFormElement>('apple-cfg-form');
  const cfgCacheTtl = element<HTMLInputElement>('apple-cfg-cache-ttl');
  const cfgCooldown = element<HTMLInputElement>('apple-cfg-cooldown');
  const cfgMinBattery = element<HTMLInputElement>('apple-cfg-min-battery');
  const cfgWatch = element<HTMLInputElement>('apple-cfg-watch');
  const cfgAliases = element<HTMLTextAreaElement>('apple-cfg-aliases');
  const cfgPlaces = element<HTMLTextAreaElement>('apple-cfg-places');
  const cfgIncludeFamily = element<HTMLInputElement>('apple-cfg-include-family');
  const geoStatusHint = element<HTMLElement>('apple-geo-status-hint');
  const openGeoBtn = element<HTMLButtonElement>('apple-open-geo-btn');
  const cfgSaveBtn = element<HTMLButtonElement>('apple-cfg-save-btn');

  const lifecycleAc = new AbortController();
  let active = false;
  let disposed = false;
  let busy = false;
  let statusSeq = 0;
  let badgeSeq = 0;
  let badgeAc: AbortController | null = null;
  let ringingId: string | null = null;
  let lastData: ApplePluginStatusData | undefined;
  let lastStatusBanner = '';

  function setStatus(text: string, tone: 'ok' | 'warn' | 'err' = 'ok'): void {
    const trimmed = text.trim();
    statusBanner.hidden = !text;
    statusBanner.textContent = text;
    statusBanner.className = `health-status-banner tone-${tone}`;
    if (trimmed && trimmed !== lastStatusBanner && options.isVisible()) {
      announceStatus(trimmed, tone === 'err' ? 'assertive' : 'polite');
    }
    lastStatusBanner = trimmed;
  }

  function resolveDeviceBadge(dev: AppleDeviceItem): { text: string; badgeClass: string } {
    if (dev.online) return { text: '在线', badgeClass: 'hub-badge badge-green' };
    if (dev.deviceStatus === 'pending' && dev.isLocating) {
      return { text: '🔄 唤醒同步中', badgeClass: 'hub-badge badge-amber' };
    }
    if (dev.deviceStatus === 'pending') {
      return { text: '待机', badgeClass: 'hub-badge badge-amber' };
    }
    if (dev.deviceStatus === 'offline') {
      return { text: '离线休眠', badgeClass: 'hub-badge badge-slate' };
    }
    return { text: dev.deviceStatusLabel || '离线', badgeClass: 'hub-badge badge-slate' };
  }

  function syncControlStates(): void {
    const authState = lastData?.authState ?? 'unauthenticated';
    const blocked = busy || appState.authExpired;
    refreshBtn.disabled = blocked || authState !== 'authenticated';
    cachedBtn.disabled = blocked;
    loginBtn.disabled = blocked;
    smsBtn.disabled = blocked;
    bypass2faBtn.disabled = blocked;
    twoFaVerifyBtn.disabled = blocked;
    logoutBtn.disabled = blocked;
    cfgSaveBtn.disabled = blocked;
    for (const btn of devicesGrid.querySelectorAll<HTMLButtonElement>('button.apple-ring-btn')) {
      btn.disabled = blocked || authState !== 'authenticated' || btn.dataset.soundCapable === 'false';
    }
  }

  function setBusy(next: boolean): void {
    busy = next;
    syncControlStates();
  }

  function updateTopBadge(data?: ApplePluginStatusData): void {
    const state = data?.authState ?? 'unauthenticated';
    if (state === 'authenticated') {
      const devices = data?.devices ?? [];
      const primaryIphone = devices.find(d => !d.isFamily && d.category === 'iphone')
        ?? devices.find(d => d.category === 'iphone')
        ?? devices[0];
      if (primaryIphone && typeof primaryIphone.batteryPercent === 'number') {
        topBadge.textContent = `${primaryIphone.batteryPercent}%`;
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
      boundAccountEl.textContent = '未绑定';
    }

    const devices = data.devices ?? [];
    const minBatteryPct = data.config?.minBatteryPct ?? 25;
    const lowCount = devices.filter(d =>
      typeof d.batteryPercent === 'number'
      && !d.batteryIsCached
      && d.batteryPercent < minBatteryPct
      && d.batteryStatus !== 'Charging'
      && d.batteryStatus !== 'Charged',
    ).length;
    const onlineCount = devices.filter(d => d.online).length;
    const pendingCount = devices.filter(d => !d.online && d.deviceStatus === 'pending').length;
    const updatedStr = data.fetchedAt ? timestamp(data.fetchedAt) : '尚无快照';

    const kpiFrag = document.createDocumentFragment();
    kpiFrag.append(
      kpiCard('会话状态', authState === 'authenticated' ? '已连接' : authState === 'pending_2fa' ? '待 2FA' : authState === 'expired' ? '已过期' : '未绑定', data.region === 'cn' ? '国区云上贵州' : '国际区', authState === 'authenticated' ? 'positive' : authState === 'expired' ? 'warning' : 'default'),
      kpiCard('设备总数', `${devices.length}`, `${onlineCount} 台在线${pendingCount > 0 ? ` · ${pendingCount} 台待机` : ''}`, devices.length > 0 ? 'accent' : 'default'),
      kpiCard('低电量告警', `${lowCount}`, `阈值 < ${minBatteryPct}%`, lowCount > 0 ? 'warning' : 'positive'),
      kpiCard('最近拉取', updatedStr, data.fromCache ? '缓存快照' : '实时直连', 'default'),
    );
    kpiGrid.replaceChildren(kpiFrag);

    devicesSubtitle.textContent = devices.length > 0
      ? `共 ${devices.length} 台设备 · ${data.fromCache ? '缓存快照' : '实时直连'}`
      : '';

    if (devices.length === 0) {
      devicesGrid.replaceChildren(node('p', authState === 'authenticated' ? '暂无设备缓存，请点击右上角「🔄 实时刷新」。' : '请先在上方绑定你的 Apple ID。', 'empty'));
    } else {
      const focusedDeviceId = typeof document !== 'undefined' && devicesGrid.contains?.(document.activeElement)
        ? ((document.activeElement as HTMLElement | null)?.dataset?.deviceId ?? null)
        : null;
      const frag = document.createDocumentFragment();
      for (const dev of devices) {
        const card = node('article', '', 'hub-entity-card apple-device-card');
        const head = node('div', '', 'hub-card-head');
        const titleGroup = node('div', '', 'hub-card-title-group');
        const icon = CATEGORY_ICONS[dev.category] ?? '🍎';
        const devBadge = resolveDeviceBadge(dev);
        titleGroup.append(
          node('span', `${icon} ${dev.name}`, 'hub-card-title'),
          node('span', devBadge.text, devBadge.badgeClass),
        );
        if (dev.isFamily) {
          titleGroup.append(node('span', '家人共享', 'hub-badge badge-slate'));
        }
        if (dev.lowPowerMode) {
          titleGroup.append(node('span', '低电量模式', 'hub-badge badge-amber'));
        }
        head.append(titleGroup, node('span', dev.model, 'meta'));
        card.append(head);

        const batRow = node('div', '', 'apple-battery-row');
        const batText = typeof dev.batteryPercent === 'number'
          ? `🔋 ${dev.batteryPercent}% · ${dev.batteryStatusLabel}${dev.batteryIsCached ? '（休眠前记录）' : ''}`
          : '🔋 暂无电量上报（休眠或关机）';
        batRow.append(
          node('span', batText, 'apple-battery-text'),
          buildBatterySvg(dev.batteryPercent, dev.batteryStatus, minBatteryPct),
        );
        card.append(batRow);

        const addrLabel = dev.location?.shortAddress || dev.location?.address || '';
        const acc = dev.location && dev.location.horizontalAccuracy !== null ? ` · 精度 ${dev.location.horizontalAccuracy}m` : '';
        const oldTag = dev.location?.isOld ? '（历史位置）' : '';
        let locText = '📍 暂无位置上报';
        if (dev.place?.inside) {
          locText = `📍 在「${dev.place.name}」附近（约 ${dev.place.distanceMeters}m${addrLabel ? ` · ${addrLabel}` : ''}）`;
        } else if (dev.place) {
          locText = addrLabel
            ? `📍 ${addrLabel}（距「${dev.place.name}」约 ${dev.place.distanceMeters}m）`
            : `📍 距「${dev.place.name}」约 ${dev.place.distanceMeters}m`;
        } else if (dev.location) {
          locText = addrLabel
            ? `📍 ${addrLabel}${acc}${oldTag}`
            : `📍 ${dev.location.latitude ?? '**'}, ${dev.location.longitude ?? '**'}${acc}${oldTag}`;
        }
        const locEl = node('div', locText, 'meta apple-location-line');
        if (dev.location?.address && dev.location.address !== addrLabel) {
          locEl.title = dev.location.address;
        }
        card.append(locEl);

        const actionsRow = node('div', '', 'apple-card-actions');
        const ringLabel = ringingId === dev.id ? '🔔 发送中…' : '🔊 播放提示音';
        const ringBtn = button(ringLabel, () => {
          void handlePlaySound(dev);
        }, 'mini-button apple-ring-btn');
        ringBtn.dataset.soundCapable = String(dev.soundCapable !== false);
        ringBtn.dataset.deviceId = dev.id;
        ringBtn.setAttribute(
          'aria-label',
          ringingId === dev.id ? `正在向 ${dev.name} 发送提示音` : `播放 ${dev.name} 提示音`,
        );
        actionsRow.append(ringBtn);
        card.append(actionsRow);
        frag.append(card);
      }
      devicesGrid.replaceChildren(frag);
      if (focusedDeviceId) {
        const targetBtn = Array.from(devicesGrid.querySelectorAll<HTMLButtonElement>('button.apple-ring-btn'))
          .find(btn => btn.dataset.deviceId === focusedDeviceId);
        if (targetBtn) safeFocus(targetBtn, { preventScroll: true });
      }
    }

    if (data.geoConfigured === true) {
      geoStatusHint.textContent = '🗺️ 高德逆地理：已就绪';
    } else if (data.geoConfigured === false) {
      geoStatusHint.textContent = '🗺️ 高德逆地理：未配置';
    }

    if (data.config && !isEditingWithin(configDetails)) {
      if (!isEditingWithin(authSection)) {
        regionSelect.value = data.config.region;
      }
      cfgIncludeFamily.checked = data.config.includeFamily !== false;
      cfgCacheTtl.value = String(data.config.cacheTtlSec);
      cfgCooldown.value = String(data.config.minRefreshIntervalSec);
      cfgMinBattery.value = String(data.config.minBatteryPct);
      cfgWatch.value = (data.config.watchDevices ?? []).join(', ');
      cfgAliases.value = formatAliasesTextarea(data.config.customAliases);
      cfgPlaces.value = formatPlacesTextarea(data.config.places);
    }

    syncControlStates();
  }

  async function loadStatus(mode: 'auto' | 'refresh' | 'cache' = 'auto', opts?: { preserveBanner?: boolean }): Promise<void> {
    if (disposed || busy || appState.authExpired) return;
    const seq = ++statusSeq;
    setBusy(true);
    if (mode === 'refresh') {
      setStatus('正在唤醒苹果设备并同步实时电量与定位（约需 2～5 秒）…', 'warn');
    }
    try {
      const res = mode === 'refresh'
        ? await runApplePlugin('devices', { refresh: true }, { signal: lifecycleAc.signal })
        : mode === 'cache'
          ? await runApplePlugin('status', { cacheOnly: true }, { signal: lifecycleAc.signal })
          : await runApplePlugin('status', {}, { signal: lifecycleAc.signal });
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      busy = false;
      if (res.data) {
        render(res.data);
      }
      if (!opts?.preserveBanner) {
        if (!res.ok) {
          setStatus(res.message || '操作失败', 'err');
        } else if (mode === 'refresh') {
          const msg = res.data?.cooldownActive
            ? `命中防耗电冷却（${res.data.cooldownRemainingSec}s 后可再次唤醒），已返回最近缓存`
            : '已刷新苹果设备实时状态';
          setStatus(msg, res.data?.cooldownActive ? 'warn' : 'ok');
        } else if (mode === 'cache') {
          setStatus('已加载本地缓存快照', 'ok');
        } else {
          setStatus('');
        }
      }
    } catch (err) {
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      if (!opts?.preserveBanner) {
        setStatus(`加载苹果设备状态失败：${errorText(err)}`, 'err');
      }
    } finally {
      if (seq === statusSeq) setBusy(false);
    }
  }

  async function handlePlaySound(dev: AppleDeviceItem): Promise<void> {
    if (disposed || busy || appState.authExpired) return;
    const seq = ++statusSeq;
    ringingId = dev.id;
    setBusy(true);
    if (lastData) render(lastData);
    setStatus(`正在向 ${dev.name} 发送 Find My 响铃指令…`, 'warn');
    try {
      const res = await runApplePlugin('play-sound', { device: dev.id }, { signal: lifecycleAc.signal });
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      setStatus(res.message || (res.ok ? `已触发 ${dev.name} 响铃` : '响铃失败'), res.ok ? 'ok' : 'err');
    } catch (err) {
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      setStatus(`发送响铃失败：${errorText(err)}`, 'err');
    } finally {
      if (seq === statusSeq) {
        ringingId = null;
        busy = false;
        if (lastData) render(lastData);
        syncControlStates();
      }
    }
  }

  async function handleLogin(): Promise<void> {
    if (disposed || busy || appState.authExpired) return;
    const appleId = appleIdInput.value.trim();
    const password = passwordInput.value;
    const region = regionSelect.value === 'global' ? 'global' : 'cn';
    appleIdInput.setAttribute('aria-invalid', appleId ? 'false' : 'true');
    passwordInput.setAttribute('aria-invalid', password ? 'false' : 'true');
    if (!appleId || !password) {
      setStatus('请输入 Apple ID 账号与主密码。', 'warn');
      safeFocus(!appleId ? appleIdInput : passwordInput);
      return;
    }
    const seq = ++statusSeq;
    passwordInput.value = '';
    setBusy(true);
    setStatus('正在通过 SRP-6a 协议连接苹果认证服务器…', 'warn');
    try {
      const res = await runApplePlugin('auth-login', { appleId, password, region }, { signal: lifecycleAc.signal });
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      busy = false;
      if (res.data) {
        render(res.data);
      }
      setStatus(res.message, res.ok ? (res.data?.authState === 'pending_2fa' ? 'warn' : 'ok') : 'err');
    } catch (err) {
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      setStatus(`登录失败：${errorText(err)}`, 'err');
    } finally {
      passwordInput.value = '';
      if (seq === statusSeq) setBusy(false);
    }
  }

  async function handleSendSms(): Promise<void> {
    if (disposed || busy || appState.authExpired) return;
    const seq = ++statusSeq;
    setBusy(true);
    setStatus('正在请求向受信任手机号发送短信验证码…', 'warn');
    try {
      const res = await runApplePlugin('auth-sms', {}, { signal: lifecycleAc.signal });
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      busy = false;
      if (res.data) render(res.data);
      if (res.ok) twoFaModeSelect.value = 'sms';
      setStatus(res.message, res.ok ? 'ok' : 'err');
    } catch (err) {
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      setStatus(`发送短信验证码失败：${errorText(err)}`, 'err');
    } finally {
      if (seq === statusSeq) setBusy(false);
    }
  }

  async function handleVerify2fa(): Promise<void> {
    if (disposed || busy || appState.authExpired) return;
    const code = twoFaCodeInput.value.trim();
    const mode = twoFaModeSelect.value === 'sms' ? 'sms' : 'trusted_device';
    const validCode = /^\d{6}$/.test(code);
    twoFaCodeInput.setAttribute('aria-invalid', validCode ? 'false' : 'true');
    if (!validCode) {
      setStatus('请输入 6 位数字双重认证验证码。', 'warn');
      safeFocus(twoFaCodeInput);
      return;
    }
    const seq = ++statusSeq;
    setBusy(true);
    setStatus('正在核验 6 位验证码并建立长期信任会话…', 'warn');
    try {
      const res = await runApplePlugin('auth-verify', { code, mode }, { signal: lifecycleAc.signal });
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      if (res.ok) twoFaCodeInput.value = '';
      busy = false;
      if (res.data) render(res.data);
      setStatus(res.message, res.ok ? 'ok' : 'err');
    } catch (err) {
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      setStatus(`2FA 验证失败：${errorText(err)}`, 'err');
    } finally {
      if (seq === statusSeq) setBusy(false);
    }
  }

  async function handleLogout(): Promise<void> {
    if (disposed || busy || appState.authExpired) return;
    const confirmed = await confirmAction({
      title: '退出 Apple ID 会话',
      message: '确定退出当前 Apple ID 会话并清除本机缓存的查找认证状态吗？退出后需重新登录并完成双重认证。',
      confirmLabel: '确认退出',
      cancelLabel: '取消',
      danger: true,
    });
    if (!confirmed || disposed || busy || appState.authExpired) return;
    const seq = ++statusSeq;
    setBusy(true);
    try {
      const res = await runApplePlugin('logout', {}, { signal: lifecycleAc.signal });
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      setStatus(res.message, res.ok ? 'ok' : 'err');
      busy = false;
      await loadStatus('cache', { preserveBanner: true });
    } catch (err) {
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      setStatus(`退出失败：${errorText(err)}`, 'err');
    } finally {
      if (seq === statusSeq) setBusy(false);
    }
  }

  async function handleSaveConfig(): Promise<void> {
    if (disposed || busy || appState.authExpired) return;
    const seq = ++statusSeq;
    setBusy(true);
    try {
      const watchDevices = cfgWatch.value
        .split(/[,，\n]/)
        .map(s => s.trim())
        .filter(Boolean);
      const res = await runApplePlugin('config', {
        region: regionSelect.value === 'global' ? 'global' : 'cn',
        includeFamily: cfgIncludeFamily.checked,
        cacheTtlSec: Number(cfgCacheTtl.value),
        minRefreshIntervalSec: Number(cfgCooldown.value),
        minBatteryPct: Number(cfgMinBattery.value),
        watchDevices,
        customAliases: parseAliasesTextarea(cfgAliases.value),
        places: parsePlacesTextarea(cfgPlaces.value),
      }, { signal: lifecycleAc.signal });
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      setStatus(res.message, res.ok ? 'ok' : 'err');
      busy = false;
      await loadStatus('auto', { preserveBanner: true });
    } catch (err) {
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      setStatus(`保存配置失败：${errorText(err)}`, 'err');
    } finally {
      if (seq === statusSeq) setBusy(false);
    }
  }

  async function handleBypass2fa(): Promise<void> {
    if (disposed || busy || appState.authExpired) return;
    const seq = ++statusSeq;
    setBusy(true);
    setStatus('正在尝试 Find My 单因素免码直通通道…', 'warn');
    try {
      const res = await runApplePlugin('auth-verify', { bypass2fa: true }, { signal: lifecycleAc.signal });
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      busy = false;
      if (res.data) render(res.data);
      setStatus(res.message, res.ok ? 'ok' : 'err');
    } catch (err) {
      if (disposed || seq !== statusSeq || appState.authExpired) return;
      setStatus(`免码直通失败：${errorText(err)}`, 'err');
    } finally {
      if (seq === statusSeq) setBusy(false);
    }
  }

  listenEvent(refreshBtn, 'click', () => { void loadStatus('refresh'); }, lifecycleAc.signal);
  listenEvent(cachedBtn, 'click', () => { void loadStatus('cache'); }, lifecycleAc.signal);
  bindFormSubmission(loginSubmitForm, loginBtn, () => { void handleLogin(); }, lifecycleAc.signal);
  listenEvent(smsBtn, 'click', () => { void handleSendSms(); }, lifecycleAc.signal);
  listenEvent(bypass2faBtn, 'click', () => { void handleBypass2fa(); }, lifecycleAc.signal);
  bindFormSubmission(twoFaBox, twoFaVerifyBtn, () => { void handleVerify2fa(); }, lifecycleAc.signal);
  listenEvent(logoutBtn, 'click', () => { void handleLogout(); }, lifecycleAc.signal);
  bindFormSubmission(cfgForm, cfgSaveBtn, () => { void handleSaveConfig(); }, lifecycleAc.signal);
  listenEvent(openGeoBtn, 'click', () => { hooks.openSystemHubModal?.('services', 'amap'); }, lifecycleAc.signal);

  function deactivate(): void {
    active = false;
    syncControlStates();
  }

  return {
    activate: () => {
      if (disposed) return;
      active = true;
      ++badgeSeq;
      badgeAc?.abort();
      badgeAc = null;
      syncControlStates();
      if (options.isVisible()) {
        void loadStatus('auto');
      }
    },
    deactivate,
    refreshBadge: async () => {
      if (disposed || active || busy || appState.authExpired) return;
      const bSeq = ++badgeSeq;
      badgeAc?.abort();
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      badgeAc = ac;
      try {
        const res = await runApplePlugin('status', { cacheOnly: true }, {
          priority: 'low',
          ...(ac ? { signal: ac.signal } : {}),
        });
        if (disposed || active || busy || bSeq !== badgeSeq || appState.authExpired) return;
        if (res.data) {
          lastData = res.data;
          updateTopBadge(res.data);
        }
      } catch {
        // Silent badge refresh failure
      } finally {
        if (badgeAc === ac) badgeAc = null;
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      deactivate();
      badgeAc?.abort();
      badgeAc = null;
      lifecycleAc.abort();
    },
  };
}

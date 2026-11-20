import { button, element, isEditingWithin, kpiCard, node } from '../shared/dom.js';
import { errorText, timestamp } from '../shared/format.js';
import { api, appState } from '../state.js';

export interface NetleaUiOptions {
  isVisible: () => boolean;
}

export interface NetleaUiController {
  activate: () => void;
  deactivate: () => void;
  refreshBadge: () => Promise<void>;
}

interface NetleaChannels {
  red: number;
  green: number;
  white: number;
  blue: number;
  fan: number;
}

interface NetleaDeviceView {
  address: string;
  name: string;
  rssi: number | null;
  connected: boolean;
  seenAt?: number;
  advertisement?: {
    rtc: string;
    deviceType: number;
    mac: string;
  };
}

interface NetleaState {
  rawHex: string;
  on: boolean;
  channels: NetleaChannels;
}

interface NetleaConfig {
  targetMac: string;
  namePrefix: string;
  fadeSeconds: number;
  defaultChannels: NetleaChannels;
}

interface NetleaDashboardPayload {
  updatedAt: number | null;
  lastAddress: string | null;
  device: NetleaDeviceView | null;
  state: NetleaState | null;
  config: NetleaConfig;
}

interface NetleaPluginResponse<T = unknown> {
  ok: boolean;
  plugin: string;
  action: string;
  notify: boolean;
  title?: string;
  message: string;
  data?: T;
}

const PRESETS: Record<string, { label: string; channels: NetleaChannels }> = {
  vivid: { label: '增艳全光谱', channels: { red: 69, green: 54, white: 98, blue: 54, fan: 0 } },
  daylight: { label: '清澈日光', channels: { red: 35, green: 45, white: 100, blue: 45, fan: 0 } },
  sunset: { label: '暖金晚霞', channels: { red: 85, green: 30, white: 45, blue: 15, fan: 0 } },
  moonlight: { label: '静谧月光', channels: { red: 0, green: 5, white: 8, blue: 38, fan: 0 } },
};

function clampInt(raw: number, min: number, max: number): number {
  if (!Number.isFinite(raw)) return min;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

function drawSpectrumCanvas(
  canvas: HTMLCanvasElement,
  channels: NetleaChannels,
  isOn: boolean | null,
  previewing: boolean,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const isIndustrial = document.documentElement.dataset.theme === 'industrial';
  const bg = isIndustrial ? '#0d1117' : 'rgba(13, 19, 32, 0.9)';
  const trackBg = isIndustrial ? '#1e2633' : 'rgba(255, 255, 255, 0.08)';
  const textCol = '#e6edf3';
  const mutedCol = '#93a4bc';

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Mixed RGBW ambient preview strip at top
  const rMix = Math.round((channels.red / 100) * 255 * 0.85 + (channels.white / 100) * 255 * 0.7);
  const gMix = Math.round((channels.green / 100) * 255 * 0.8 + (channels.white / 100) * 255 * 0.72);
  const bMix = Math.round((channels.blue / 100) * 255 * 0.9 + (channels.white / 100) * 255 * 0.72);
  const mr = Math.min(255, rMix);
  const mg = Math.min(255, gMix);
  const mb = Math.min(255, bMix);

  ctx.fillStyle = trackBg;
  ctx.fillRect(14, 12, w - 28, 16);
  ctx.fillStyle = `rgb(${mr}, ${mg}, ${mb})`;
  ctx.fillRect(14, 12, w - 28, 16);

  ctx.font = '600 11px sans-serif';
  ctx.fillStyle = (mr + mg + mb) > 420 ? '#111827' : textCol;
  const badgeText = previewing
    ? '预览通道比例（尚未下发）'
    : isOn === true
      ? '灯具状态：开启'
      : isOn === false
        ? '灯具状态：关闭（下方显示待机/滑块值）'
        : '尚未读取实时状态';
  ctx.fillText(badgeText, 22, 24);

  const rows: Array<{ label: string; value: number; max: number; unit: string; color: string }> = [
    { label: '红光 R', value: channels.red, max: 100, unit: '%', color: '#f87171' },
    { label: '绿光 G', value: channels.green, max: 100, unit: '%', color: '#4ade80' },
    { label: '白光 W', value: channels.white, max: 100, unit: '%', color: '#f8fafc' },
    { label: '蓝光 B', value: channels.blue, max: 100, unit: '%', color: '#60a5fa' },
    { label: '风扇 F', value: channels.fan, max: 5, unit: ' 档', color: '#fbbf24' },
  ];

  const startY = 44;
  const rowStep = 22;
  const barX = 76;
  const barW = w - barX - 58;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const y = startY + i * rowStep;
    const ratio = Math.max(0, Math.min(1, row.value / row.max));

    ctx.font = '500 12px sans-serif';
    ctx.fillStyle = mutedCol;
    ctx.fillText(row.label, 14, y + 10);

    ctx.fillStyle = trackBg;
    ctx.fillRect(barX, y, barW, 12);

    ctx.fillStyle = row.color;
    ctx.fillRect(barX, y, Math.max(ratio > 0 ? 4 : 0, Math.round(barW * ratio)), 12);

    ctx.fillStyle = textCol;
    ctx.font = '600 12px monospace';
    ctx.fillText(`${row.value}${row.unit}`, barX + barW + 8, y + 10);
  }
}

export function initNetleaUi(options: NetleaUiOptions): NetleaUiController {
  const panel = element<HTMLElement>('plugin-panel-netlea');
  const topBadge = element<HTMLElement>('netlea-top-badge');
  const statusBanner = element<HTMLElement>('netlea-action-status');
  const kpiGrid = element<HTMLElement>('netlea-kpi-grid');
  const deviceMeta = element<HTMLElement>('netlea-device-meta');
  const spectrumCanvas = element<HTMLCanvasElement>('netlea-spectrum-canvas');
  const scanList = element<HTMLElement>('netlea-scan-list');

  const scanBtn = element<HTMLButtonElement>('netlea-scan-btn');
  const syncBtn = element<HTMLButtonElement>('netlea-sync-btn');
  const refreshBtn = element<HTMLButtonElement>('netlea-refresh-btn');
  const onBtn = element<HTMLButtonElement>('netlea-on-btn');
  const offBtn = element<HTMLButtonElement>('netlea-off-btn');
  const resumeBtn = element<HTMLButtonElement>('netlea-resume-btn');
  const presetBar = element<HTMLElement>('netlea-preset-bar');
  const brightnessRange = element<HTMLInputElement>('netlea-brightness-range');
  const brightnessVal = element<HTMLElement>('netlea-brightness-val');
  const brightnessBtn = element<HTMLButtonElement>('netlea-brightness-btn');

  const chRed = element<HTMLInputElement>('netlea-ch-red');
  const chGreen = element<HTMLInputElement>('netlea-ch-green');
  const chWhite = element<HTMLInputElement>('netlea-ch-white');
  const chBlue = element<HTMLInputElement>('netlea-ch-blue');
  const chFan = element<HTMLInputElement>('netlea-ch-fan');
  const chRedVal = element<HTMLElement>('netlea-ch-red-val');
  const chGreenVal = element<HTMLElement>('netlea-ch-green-val');
  const chWhiteVal = element<HTMLElement>('netlea-ch-white-val');
  const chBlueVal = element<HTMLElement>('netlea-ch-blue-val');
  const chFanVal = element<HTMLElement>('netlea-ch-fan-val');
  const fadeSecInput = element<HTMLInputElement>('netlea-fade-sec');
  const saveDefaultBtn = element<HTMLButtonElement>('netlea-save-default-btn');
  const applyChannelsBtn = element<HTMLButtonElement>('netlea-apply-channels-btn');

  const cfgMacInput = element<HTMLInputElement>('netlea-cfg-mac');
  const cfgPrefixInput = element<HTMLInputElement>('netlea-cfg-prefix');
  const cfgSaveBtn = element<HTMLButtonElement>('netlea-cfg-save-btn');

  const actionButtons = [
    scanBtn,
    syncBtn,
    refreshBtn,
    onBtn,
    offBtn,
    resumeBtn,
    brightnessBtn,
    saveDefaultBtn,
    applyChannelsBtn,
    cfgSaveBtn,
  ];

  let active = false;
  let busy = false;
  let lastPayload: NetleaDashboardPayload | null = null;
  let previewMode = false;

  function setBanner(text: string, tone: 'ok' | 'warn' | 'err' = 'ok'): void {
    statusBanner.className = `health-status-banner tone-${tone}`;
    statusBanner.textContent = text;
    statusBanner.hidden = !text;
  }

  function readSliderChannels(): NetleaChannels {
    return {
      red: clampInt(Number(chRed.value), 0, 100),
      green: clampInt(Number(chGreen.value), 0, 100),
      white: clampInt(Number(chWhite.value), 0, 100),
      blue: clampInt(Number(chBlue.value), 0, 100),
      fan: clampInt(Number(chFan.value), 0, 5),
    };
  }

  function syncSliderLabels(channels: NetleaChannels): void {
    chRed.value = String(channels.red);
    chGreen.value = String(channels.green);
    chWhite.value = String(channels.white);
    chBlue.value = String(channels.blue);
    chFan.value = String(channels.fan);
    chRedVal.textContent = String(channels.red);
    chGreenVal.textContent = String(channels.green);
    chWhiteVal.textContent = String(channels.white);
    chBlueVal.textContent = String(channels.blue);
    chFanVal.textContent = String(channels.fan);
  }

  function refreshCanvasPreview(): void {
    const ch = readSliderChannels();
    chRedVal.textContent = String(ch.red);
    chGreenVal.textContent = String(ch.green);
    chWhiteVal.textContent = String(ch.white);
    chBlueVal.textContent = String(ch.blue);
    chFanVal.textContent = String(ch.fan);
    const currentOn = lastPayload?.state ? lastPayload.state.on : null;
    drawSpectrumCanvas(spectrumCanvas, ch, currentOn, previewMode);
  }

  function setBusyState(nextBusy: boolean): void {
    busy = nextBusy;
    const disabled = nextBusy || appState.authExpired || !appState.ready;
    for (const btn of actionButtons) {
      btn.disabled = disabled;
    }
  }

  function updateBadge(payload: NetleaDashboardPayload | null): void {
    const st = payload?.state;
    if (!st) {
      topBadge.textContent = '待读';
      return;
    }
    topBadge.textContent = st.on ? `开 · W${st.channels.white}%` : '已关';
  }

  function renderDashboard(payload: NetleaDashboardPayload, forceInputs = false): void {
    lastPayload = payload;
    updateBadge(payload);

    const dev = payload.device;
    const st = payload.state;
    const cfg = payload.config;
    const adv = dev?.advertisement;

    const statusLabel = st ? (st.on ? '开启' : '关闭') : '未知';
    const statusTone = st ? (st.on ? 'positive' : 'default') : 'warning';
    const rssiText = typeof dev?.rssi === 'number' ? `${dev.rssi} dBm` : '--';
    const rtcText = adv?.rtc || '--';
    const chText = st
      ? `R${st.channels.red} G${st.channels.green} W${st.channels.white} B${st.channels.blue}`
      : `预设 W${cfg.defaultChannels.white}%`;

    const kpiFrag = document.createDocumentFragment();
    kpiFrag.append(
      kpiCard('灯光状态', statusLabel, dev?.name || cfg.targetMac || '未读取', statusTone),
      kpiCard('四通道光谱', chText, st ? `风扇 ${st.channels.fan} 档` : '默认预设', st?.on ? 'accent' : 'default'),
      kpiCard('蓝牙信号', rssiText, dev?.address || '自动发现', typeof dev?.rssi === 'number' && dev.rssi > -75 ? 'positive' : 'default'),
      kpiCard('灯内时钟', rtcText.length >= 19 ? rtcText.slice(11, 19) : rtcText, payload.updatedAt ? `同步于 ${timestamp(payload.updatedAt)}` : '尚无缓存', 'default'),
    );
    kpiGrid.replaceChildren(kpiFrag);

    if (dev || st) {
      const parts = [
        dev?.name ? `设备：${dev.name}` : '',
        dev?.address ? `MAC：${dev.address}` : '',
        adv?.rtc ? `灯内 RTC：${adv.rtc}` : '',
        payload.updatedAt ? `缓存时间：${timestamp(payload.updatedAt)}` : '',
      ].filter(Boolean);
      deviceMeta.textContent = parts.join(' ｜ ');
    } else {
      deviceMeta.textContent = '尚未读取鱼缸灯实时数据，点击右上角「实时读取」连接灯具。';
    }

    if (forceInputs || !isEditingWithin(panel)) {
      previewMode = false;
      const shownChannels = st && st.on ? st.channels : cfg.defaultChannels;
      syncSliderLabels(shownChannels);
      fadeSecInput.value = String(cfg.fadeSeconds);
      cfgMacInput.value = cfg.targetMac;
      cfgPrefixInput.value = cfg.namePrefix;
    }

    refreshCanvasPreview();
  }

  async function runNetlea(
    action: string,
    args: Record<string, unknown> = {},
    opts: { silent?: boolean; forceInputs?: boolean } = {},
  ): Promise<NetleaPluginResponse<Record<string, unknown>> | null> {
    if (busy) return null;
    setBusyState(true);
    try {
      const res = await api<NetleaPluginResponse<Record<string, unknown>>>('/api/plugin-run', {
        plugin: 'netlea',
        action,
        args,
      });
      if (!res.ok) {
        if (!opts.silent) setBanner(res.message || '执行失败', 'err');
        return res;
      }
      if (!opts.silent && res.message) {
        setBanner(res.message, 'ok');
      }
      return res;
    } catch (err) {
      if (!opts.silent) setBanner(`操作失败：${errorText(err)}`, 'err');
      return null;
    } finally {
      setBusyState(false);
    }
  }

  async function loadDashboard(refresh = false, forceInputs = false): Promise<void> {
    const res = await runNetlea(
      'dashboard',
      refresh ? { refresh: true } : {},
      { silent: !refresh, forceInputs },
    );
    if (res?.ok && res.data) {
      renderDashboard(res.data as unknown as NetleaDashboardPayload, forceInputs);
    }
  }

  async function refreshAfterMutation(forceInputs = true): Promise<void> {
    const dashRes = await api<NetleaPluginResponse<NetleaDashboardPayload>>('/api/plugin-run', {
      plugin: 'netlea',
      action: 'dashboard',
      args: {},
    });
    if (dashRes.ok && dashRes.data) {
      renderDashboard(dashRes.data, forceInputs);
    }
  }

  function renderScanResults(devices: NetleaDeviceView[]): void {
    if (!devices.length) {
      scanList.replaceChildren(node('p', '未扫描到可用尼特利鱼缸灯，请确认灯具通电且手机 App 未占用蓝牙。', 'meta'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const dev of devices) {
      const row = node('div', '', 'netlea-scan-item');
      const info = node('div');
      const adv = dev.advertisement?.rtc ? ` · RTC ${dev.advertisement.rtc}` : '';
      info.append(
        node('strong', dev.name || 'Netlea'),
        node('div', `${dev.address} · RSSI ${dev.rssi ?? '--'} dBm${adv}`, 'meta'),
      );
      const bindBtn = button('设为绑定 MAC', () => {
        cfgMacInput.value = dev.address;
        void (async () => {
          const res = await runNetlea('config', { targetMac: dev.address }, { forceInputs: true });
          if (res?.ok) await refreshAfterMutation(true);
        })();
      }, 'mini-button');
      row.append(info, bindBtn);
      frag.append(row);
    }
    scanList.replaceChildren(frag);
  }

  scanBtn.addEventListener('click', () => {
    void (async () => {
      setBanner('正在扫描尼特利鱼缸灯蓝牙广播…', 'warn');
      const res = await runNetlea('scan', { timeoutSec: 5 });
      if (res?.ok && res.data) {
        const devices = Array.isArray(res.data.devices)
          ? (res.data.devices as NetleaDeviceView[])
          : [];
        renderScanResults(devices);
      }
    })();
  });

  syncBtn.addEventListener('click', () => {
    setBanner('正在通过蓝牙短连接读取灯具状态…', 'warn');
    void loadDashboard(true, true);
  });

  refreshBtn.addEventListener('click', () => {
    void loadDashboard(false, true);
  });

  onBtn.addEventListener('click', () => {
    const fadeSeconds = clampInt(Number(fadeSecInput.value), 0, 60);
    setBanner('正在发送临时开灯指令…', 'warn');
    void (async () => {
      const res = await runNetlea('on', { fadeSeconds }, { forceInputs: true });
      if (res?.ok) await refreshAfterMutation(true);
    })();
  });

  offBtn.addEventListener('click', () => {
    const fadeSeconds = clampInt(Number(fadeSecInput.value), 0, 60);
    setBanner('正在发送临时关灯指令…', 'warn');
    void (async () => {
      const res = await runNetlea('off', { fadeSeconds }, { forceInputs: true });
      if (res?.ok) await refreshAfterMutation(true);
    })();
  });

  resumeBtn.addEventListener('click', () => {
    setBanner('正在切换回 24h 自动行程…', 'warn');
    void (async () => {
      const res = await runNetlea('resume', {}, { forceInputs: true });
      if (res?.ok) await refreshAfterMutation(true);
    })();
  });

  presetBar.addEventListener('click', event => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-netlea-preset]');
    const key = btn?.dataset.netleaPreset;
    const preset = key ? PRESETS[key] : undefined;
    if (!preset) return;
    for (const pill of presetBar.querySelectorAll<HTMLButtonElement>('button[data-netlea-preset]')) {
      pill.classList.toggle('active', pill === btn);
    }
    previewMode = true;
    syncSliderLabels(preset.channels);
    refreshCanvasPreview();
    setBanner(`已加载「${preset.label}」预设到滑块，点击「下发当前光谱」即可写入灯具。`, 'warn');
  });

  brightnessRange.addEventListener('input', () => {
    brightnessVal.textContent = `${brightnessRange.value}%`;
  });

  brightnessBtn.addEventListener('click', () => {
    const brightness = clampInt(Number(brightnessRange.value), 1, 100);
    const fadeSeconds = clampInt(Number(fadeSecInput.value), 0, 60);
    setBanner(`正在按 ${brightness}% 亮度开启…`, 'warn');
    void (async () => {
      const res = await runNetlea('on', { brightness, fadeSeconds }, { forceInputs: true });
      if (res?.ok) await refreshAfterMutation(true);
    })();
  });

  for (const input of [chRed, chGreen, chWhite, chBlue, chFan]) {
    input.addEventListener('input', () => {
      previewMode = true;
      refreshCanvasPreview();
    });
  }

  applyChannelsBtn.addEventListener('click', () => {
    const channels = readSliderChannels();
    const fadeSeconds = clampInt(Number(fadeSecInput.value), 0, 60);
    setBanner('正在下发当前 R/G/W/B 与风扇设置…', 'warn');
    void (async () => {
      const res = await runNetlea('on', { ...channels, fadeSeconds }, { forceInputs: true });
      if (res?.ok) await refreshAfterMutation(true);
    })();
  });

  saveDefaultBtn.addEventListener('click', () => {
    const defaultChannels = readSliderChannels();
    const fadeSeconds = clampInt(Number(fadeSecInput.value), 0, 60);
    void (async () => {
      const res = await runNetlea('config', { fadeSeconds, defaultChannels }, { forceInputs: true });
      if (res?.ok) await refreshAfterMutation(true);
    })();
  });

  cfgSaveBtn.addEventListener('click', () => {
    const targetMac = cfgMacInput.value.trim();
    const namePrefix = cfgPrefixInput.value.trim() || 'SG-';
    void (async () => {
      const res = await runNetlea('config', { targetMac, namePrefix }, { forceInputs: true });
      if (res?.ok) await refreshAfterMutation(true);
    })();
  });

  return {
    activate() {
      active = true;
      setBusyState(false);
      void loadDashboard(false, false);
    },
    deactivate() {
      active = false;
    },
    async refreshBadge() {
      try {
        const res = await api<NetleaPluginResponse<NetleaDashboardPayload>>('/api/plugin-run', {
          plugin: 'netlea',
          action: 'dashboard',
          args: {},
        });
        if (res.ok && res.data) {
          if (active && options.isVisible()) {
            renderDashboard(res.data, false);
          } else {
            lastPayload = res.data;
            updateBadge(res.data);
          }
        }
      } catch {
        // Ignore transient badge sync errors
      }
    },
  };
}

import { element, kpiCard, node } from '../shared/dom.js';
import { errorText, timestamp } from '../shared/format.js';
import { api, appState } from '../state.js';

export interface SystemGeoStatusView {
  configured: boolean;
  source: 'system' | 'env' | 'none';
  maskedKey: string;
  updatedAt: number | null;
  cacheEntries: number;
}

export interface AmapProbeResultView {
  ok: boolean;
  message: string;
  sampleAddress?: string;
}

export interface ServicesHubOptions {
  isVisible: () => boolean;
  onBadgeChange?: (summary: { configured: boolean; badgeText: string; detailText: string }) => void;
}

export interface ServicesHubController {
  activate: () => void;
  render: (force?: boolean) => void;
}

export function initServicesHub(options: ServicesHubOptions): ServicesHubController {
  const topBadgeEl = element<HTMLElement>('services-top-badge');
  const kpiGridEl = element<HTMLElement>('geo-kpi-grid');
  const statusBadgeEl = element<HTMLElement>('geo-status-badge');
  const keyInputEl = element<HTMLInputElement>('geo-amap-key-input');
  const refreshBtn = element<HTMLButtonElement>('geo-refresh-btn');
  const probeBtn = element<HTMLButtonElement>('geo-probe-btn');
  const saveBtn = element<HTMLButtonElement>('geo-save-btn');
  const clearBtn = element<HTMLButtonElement>('geo-clear-btn');
  const probeResultEl = element<HTMLElement>('geo-probe-result');

  let busy = false;
  let loaded = false;
  let lastStatus: SystemGeoStatusView | undefined;

  function renderProbeResult(res?: AmapProbeResultView): void {
    if (!res) {
      probeResultEl.hidden = true;
      probeResultEl.replaceChildren();
      return;
    }
    probeResultEl.hidden = false;
    probeResultEl.className = `model-probe-result ${res.ok ? 'probe-ok' : 'probe-err'}`;
    probeResultEl.replaceChildren(
      node('p', `${res.ok ? '✅' : '❌'} ${res.message}`, res.ok ? 'probe-title-ok' : 'error'),
      ...(res.sampleAddress
        ? [node('p', `示例逆地理返回：${res.sampleAddress}`, 'memory-preview')]
        : []),
    );
  }

  function renderStatus(data: SystemGeoStatusView): void {
    lastStatus = data;
    loaded = true;
    const configured = Boolean(data.configured);
    const sourceLabel = data.source === 'system'
      ? `系统底座私密保存 (${data.maskedKey})`
      : data.source === 'env'
        ? `环境变量 AMAP_KEY (${data.maskedKey})`
        : '未配置高德 Web 服务 Key';

    topBadgeEl.textContent = configured ? '已就绪' : '未配置';
    statusBadgeEl.textContent = configured ? '● 已配置生效' : '未配置';
    statusBadgeEl.className = `hub-status-pill ${configured ? 'badge-green' : 'badge-slate'}`;
    keyInputEl.placeholder = configured
      ? `已配置 ${data.maskedKey}（留空保持不变）`
      : '输入高德「Web服务」API Key（留空保持已存凭据）';
    clearBtn.disabled = busy || !configured || data.source === 'env' || appState.authExpired;

    const updatedSub = data.updatedAt ? `最近更新 ${timestamp(data.updatedAt)}` : '待写入配置';
    kpiGridEl.replaceChildren(
      kpiCard('高德位置引擎', configured ? '已接入' : '待配置', sourceLabel, configured ? 'positive' : 'default'),
      kpiCard('24h 网格缓存', `${data.cacheEntries} 个点位`, '九号 + 苹果约 20 米网格共用', 'accent'),
      kpiCard('流控与共享状态', '3 QPS · 全局共用', updatedSub, 'default'),
    );

    options.onBadgeChange?.({
      configured,
      badgeText: configured ? '地图就绪' : '未配地图',
      detailText: configured ? `位置底座 ${data.maskedKey}` : '未配置高德位置底座',
    });
  }

  function setBusy(next: boolean): void {
    busy = next;
    const dis = busy || appState.authExpired;
    refreshBtn.disabled = dis;
    probeBtn.disabled = dis;
    saveBtn.disabled = dis;
    clearBtn.disabled = dis || !lastStatus?.configured || lastStatus.source === 'env';
  }

  async function refreshStatus(showErrors = false): Promise<void> {
    if (!appState.ready || appState.authExpired) return;
    try {
      const status = await api<SystemGeoStatusView>('/api/geo-config');
      renderStatus(status);
    } catch (err) {
      if (showErrors || options.isVisible()) {
        renderProbeResult({ ok: false, message: `读取位置底座配置失败：${errorText(err)}` });
      }
    }
  }

  async function handleProbe(explicitKey?: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const candidate = explicitKey ?? keyInputEl.value.trim();
      const res = await api<AmapProbeResultView>(
        '/api/geo-probe',
        candidate ? { amapKey: candidate } : {},
      );
      renderProbeResult(res);
    } catch (err) {
      renderProbeResult({ ok: false, message: `测试失败：${errorText(err)}` });
    } finally {
      setBusy(false);
    }
  }

  async function handleSave(): Promise<void> {
    if (busy) return;
    const rawKey = keyInputEl.value.trim();
    if (!rawKey) {
      await handleProbe();
      return;
    }
    setBusy(true);
    try {
      const saved = await api<SystemGeoStatusView>('/api/geo-config', { amapKey: rawKey });
      keyInputEl.value = '';
      renderStatus(saved);
      const probeRes = await api<AmapProbeResultView>('/api/geo-probe', {});
      renderProbeResult(probeRes);
    } catch (err) {
      renderProbeResult({ ok: false, message: `保存失败：${errorText(err)}` });
    } finally {
      setBusy(false);
    }
  }

  async function handleClear(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const saved = await api<SystemGeoStatusView>('/api/geo-config', { clearAmapKey: true });
      keyInputEl.value = '';
      renderStatus(saved);
      renderProbeResult({ ok: true, message: '已清除系统底座保存的高德 API Key。' });
    } catch (err) {
      renderProbeResult({ ok: false, message: `清除失败：${errorText(err)}` });
    } finally {
      setBusy(false);
    }
  }

  refreshBtn.addEventListener('click', () => {
    void refreshStatus(true);
  });
  probeBtn.addEventListener('click', () => {
    void handleProbe();
  });
  saveBtn.addEventListener('click', () => {
    void handleSave();
  });
  clearBtn.addEventListener('click', () => {
    void handleClear();
  });

  return {
    activate() {
      void refreshStatus(true);
    },
    render(force = false) {
      if (appState.ready && (!loaded || force)) {
        void refreshStatus(false);
      }
    },
  };
}

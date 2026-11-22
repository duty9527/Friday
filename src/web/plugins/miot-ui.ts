import { button, element, isEditingWithin, kpiCard, node } from '../shared/dom.js';
import { errorText, timestamp } from '../shared/format.js';
import {
  announceStatus,
  attachDelayedFormValidation,
  bindRovingTablist,
  confirmAction,
  safeFocus,
  syncRovingTablist,
} from '../shared/ui-primitives.js';
import { api, appState, type ApiRequestOptions } from '../state.js';

export interface MiotUiOptions {
  isVisible: () => boolean;
}

export interface MiotUiController {
  activate: () => void;
  deactivate: () => void;
  refreshBadge: () => Promise<void>;
  dispose: () => void;
}

interface MiotDeviceItem {
  did: string;
  name: string;
  room: string;
  fullName: string;
  category: string;
  categories: string[];
  controlChannel: string;
  controllable: boolean;
  online: boolean;
  model: string;
  modelName?: string;
  ip?: string;
  protected?: boolean;
  state?: { on?: boolean; source?: string; ts?: number };
  fryer?: { statusText?: string; targetTempC?: number; leftTimeMin?: number; statusCode?: number };
  liveError?: string;
}

interface MiotGatewayInfo {
  online?: boolean;
  bindStatus?: boolean;
  homeId?: string;
  homeName?: string;
  ip?: string;
  role?: number;
  roleLabel?: string;
  geekPort?: number;
  geekUrl?: string;
}

interface MiotGeekRuleItem {
  id: string;
  name: string;
  enable: boolean;
  uiType?: string;
  lastUpdateTime?: number;
  nodeCount: number;
  nodeTypes?: string[];
  steps?: Array<{ id: string; type: string; description: string }>;
  summary: string;
}

interface MiotGeekLogEntry {
  ts: number;
  level?: number;
  type: string;
  graphId: string;
  graphName: string;
  detail?: string;
  ok?: boolean;
  summary: string;
}

interface MiotSceneItem {
  id: string;
  signature?: string;
  updatedAt?: number;
  touchesProtected?: boolean;
  turnsOffProtected?: boolean;
  summary: string;
  actions?: Array<{ did: string; deviceName: string; text: string; protected?: boolean }>;
}

interface MiotVarItem {
  scope: string;
  id: string;
  type: string;
  value: unknown;
}

interface MiotConfigData {
  routerSsh: string;
  speakerSsh: string;
  protectedDevices: string[];
  customAliases: Record<string, string | string[]>;
  cacheTtlMs: number;
  topologyTtlMs: number;
  udpTimeoutMs: number;
}

interface MiotDashboardData {
  fromCache?: boolean;
  configured?: boolean;
  degraded?: boolean;
  hubError?: string;
  centralError?: string;
  routerSsh?: string;
  devices?: MiotDeviceItem[];
  counts?: Record<string, number>;
  gateway?: MiotGatewayInfo | null;
  subGateways?: unknown[];
  btService?: { version?: string } | null;
  btMeshDids?: string[];
  geekReady?: boolean;
  geekUrl?: string;
  geekGraphs?: MiotGeekRuleItem[];
  geekLogs?: MiotGeekLogEntry[];
  varScopes?: string[];
  variables?: MiotVarItem[];
  scenes?: MiotSceneItem[];
  fetchedAt?: number | null;
  hotDataFetchedAt?: number | null;
  liveFetchedAt?: number | null;
  centralFetchedAt?: number | null;
  speaker?: { configured?: boolean; id?: string; userHost?: string; source?: string };
  config?: MiotConfigData;
}

interface PluginRunEnvelope {
  ok: boolean;
  plugin: string;
  action: string;
  notify: boolean;
  title?: string;
  message: string;
  data?: MiotDashboardData;
}

type MiotWorkspaceView = 'mesh' | 'geek' | 'scenes' | 'config';

const SAFE_GEEK_URL_RE = /^http:\/\/[0-9A-Za-z._:-]+$/;

const CATEGORY_ICONS: Record<string, string> = {
  light: '💡',
  outlet: '🔌',
  switch: '🎛️',
  air_fryer: '🍟',
  air_conditioner: '❄️',
  tv: '📺',
  speaker: '🔊',
  router: '📡',
  other: '📦',
};

const CHANNEL_LABELS: Record<string, string> = {
  bt_mesh: '蓝牙 Mesh',
  miio_udp: 'Wi-Fi MiIO',
  xiaoai_nlp: '小爱红外',
  tv_agent: '智能电视',
  router: '中枢网关',
  unknown: '未知通道',
};

async function runMiotPlugin(
  action: string,
  args: Record<string, unknown> = {},
  reqOpts?: ApiRequestOptions,
): Promise<PluginRunEnvelope> {
  return await api<PluginRunEnvelope>('/api/plugin-run', {
    plugin: 'miot',
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
  listenEvent(submitBtn, 'click', e => {
    if (typeof form.requestSubmit !== 'function') {
      e.preventDefault();
      onSubmit();
    }
  }, signal);
}

function formatCustomAliasesTextarea(aliases: MiotConfigData['customAliases'] | undefined): string {
  if (!aliases) return '';
  return Object.entries(aliases)
    .map(([target, vals]) => {
      const list = Array.isArray(vals) ? vals.join(', ') : String(vals ?? '');
      return `${target}=${list}`;
    })
    .join('\n');
}

function parseCustomAliasesTextarea(raw: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const vals = trimmed
      .slice(eq + 1)
      .split(/[,，、]/)
      .map(s => s.trim())
      .filter(Boolean);
    if (key && vals.length > 0) {
      out[key] = vals;
    }
  }
  return out;
}

export function initMiotUi(options: MiotUiOptions): MiotUiController {
  const topBadge = element<HTMLElement>('miot-top-badge');
  const hubPill = element<HTMLElement>('miot-hub-pill');
  const openGeekLink = element<HTMLAnchorElement>('miot-open-geek-link');
  const openGeekLink2 = element<HTMLAnchorElement>('miot-open-geek-link-2');
  const liveRefreshBtn = element<HTMLButtonElement>('miot-live-refresh-btn');
  const refreshBtn = element<HTMLButtonElement>('miot-refresh-btn');
  const statusBanner = element<HTMLElement>('miot-action-status');
  const kpiGrid = element<HTMLElement>('miot-kpi-grid');
  const workspaceTabs = element<HTMLElement>('miot-workspace-tabs');

  const viewMesh = element<HTMLElement>('miot-view-mesh');
  const viewGeek = element<HTMLElement>('miot-view-geek');
  const viewScenes = element<HTMLElement>('miot-view-scenes');
  const viewConfig = element<HTMLElement>('miot-view-config');

  const gatewayCard = element<HTMLElement>('miot-gateway-card');
  const roomPills = element<HTMLElement>('miot-room-pills');
  const channelPills = element<HTMLElement>('miot-channel-pills');
  const batchOnBtn = element<HTMLButtonElement>('miot-batch-on-btn');
  const batchOffBtn = element<HTMLButtonElement>('miot-batch-off-btn');
  const devicesGrid = element<HTMLElement>('miot-devices-grid');

  const geekNewToggleBtn = element<HTMLButtonElement>('miot-geek-new-toggle');
  const geekRefreshBtn = element<HTMLButtonElement>('miot-geek-refresh-btn');
  const geekCreateBox = element<HTMLFormElement>('miot-geek-create-box');
  const geekNewNameInput = element<HTMLInputElement>('miot-geek-new-name');
  const geekNewDeviceSelect = element<HTMLSelectElement>('miot-geek-new-device');
  const geekNewOnTime = element<HTMLInputElement>('miot-geek-new-on-time');
  const geekNewOffTime = element<HTMLInputElement>('miot-geek-new-off-time');
  const geekNewEnable = element<HTMLInputElement>('miot-geek-new-enable');
  const geekCancelBtn = element<HTMLButtonElement>('miot-geek-cancel-btn');
  const geekCreateBtn = element<HTMLButtonElement>('miot-geek-create-btn');
  const geekList = element<HTMLElement>('miot-geek-list');
  const logFilterSelect = element<HTMLSelectElement>('miot-log-filter');
  const geekLogs = element<HTMLElement>('miot-geek-logs');

  const scenesRefreshBtn = element<HTMLButtonElement>('miot-scenes-refresh-btn');
  const scenesList = element<HTMLElement>('miot-scenes-list');
  const varsForm = element<HTMLFormElement>('miot-vars-form');
  const varScopeInput = element<HTMLInputElement>('miot-var-scope');
  const varIdInput = element<HTMLInputElement>('miot-var-id');
  const varTypeSelect = element<HTMLSelectElement>('miot-var-type');
  const varValueInput = element<HTMLInputElement>('miot-var-value');
  const varCreateBtn = element<HTMLButtonElement>('miot-var-create-btn');
  const varsList = element<HTMLElement>('miot-vars-list');

  const configCard = element<HTMLFormElement>('miot-config-card');
  const cfgRouterInput = element<HTMLInputElement>('miot-cfg-router');
  const cfgSpeakerInput = element<HTMLInputElement>('miot-cfg-speaker');
  const cfgProtectedInput = element<HTMLInputElement>('miot-cfg-protected');
  const cfgAliasesInput = element<HTMLTextAreaElement>('miot-cfg-aliases');
  const cfgCacheTtlInput = element<HTMLInputElement>('miot-cfg-cache-ttl');
  const cfgTopoTtlInput = element<HTMLInputElement>('miot-cfg-topo-ttl');
  const cfgUdpTimeoutInput = element<HTMLInputElement>('miot-cfg-udp-timeout');
  const cfgSaveBtn = element<HTMLButtonElement>('miot-cfg-save-btn');

  const lifecycleAc = new AbortController();
  const openRuleDetails = new Set<string>();
  const dirtyVars = new Map<string, string>();
  let badgeAc: AbortController | null = null;
  let active = false;
  let disposed = false;
  let busy = false;
  let requestSeq = 0;
  let badgeSeq = 0;
  let currentView: MiotWorkspaceView = 'mesh';
  let selectedRoom = '';
  let selectedChannel = 'all';
  let selectedLogGraphId = '';
  let lastData: MiotDashboardData | undefined;
  let lastStatusBanner = '';

  geekNewToggleBtn.setAttribute('aria-controls', 'miot-geek-create-box');
  geekNewToggleBtn.setAttribute('aria-expanded', String(!geekCreateBox.hidden));

  function setGeekCreateOpen(open: boolean, moveFocus = true): void {
    const wasInside = typeof document !== 'undefined' && geekCreateBox.contains?.(document.activeElement);
    geekCreateBox.hidden = !open;
    geekNewToggleBtn.setAttribute('aria-expanded', String(open));
    if (moveFocus) {
      if (open) {
        safeFocus(geekNewNameInput);
      } else if (wasInside) {
        safeFocus(geekNewToggleBtn);
      }
    }
  }

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

  function syncControlStates(): void {
    const blocked = busy || appState.authExpired;
    const configured = lastData?.configured !== false;
    liveRefreshBtn.disabled = blocked || !configured;
    refreshBtn.disabled = blocked || !configured;
    batchOnBtn.disabled = blocked || !configured;
    batchOffBtn.disabled = blocked || !configured;
    geekNewToggleBtn.disabled = blocked || !configured;
    geekRefreshBtn.disabled = blocked || !configured;
    geekCreateBtn.disabled = blocked || !configured;
    geekCancelBtn.disabled = blocked;
    scenesRefreshBtn.disabled = blocked || !configured;
    varCreateBtn.disabled = blocked || !configured;
    cfgSaveBtn.disabled = blocked;

    for (const container of [devicesGrid, geekList, scenesList, varsList]) {
      for (const btn of container.querySelectorAll<HTMLButtonElement>('button')) {
        btn.disabled = blocked || btn.dataset.locked === 'true';
      }
    }
  }

  function setBusy(next: boolean): void {
    busy = next;
    syncControlStates();
  }

  function switchView(nextView: MiotWorkspaceView): void {
    currentView = nextView;
    const views: Record<MiotWorkspaceView, HTMLElement> = {
      mesh: viewMesh,
      geek: viewGeek,
      scenes: viewScenes,
      config: viewConfig,
    };
    for (const [key, panel] of Object.entries(views) as Array<[MiotWorkspaceView, HTMLElement]>) {
      panel.hidden = key !== nextView;
    }
    let matchedTab: HTMLElement | undefined;
    for (const tab of workspaceTabs.querySelectorAll<HTMLButtonElement>('[data-miot-view]')) {
      const isMatch = tab.dataset.miotView === nextView;
      tab.classList.toggle('active', isMatch);
      if (isMatch) matchedTab = tab;
    }
    syncRovingTablist(workspaceTabs, matchedTab);
  }

  function updateTopBadge(data?: MiotDashboardData): void {
    if (!data || data.configured === false) {
      topBadge.textContent = '未配置';
      return;
    }
    const devices = data.devices ?? [];
    const meshCount = devices.filter(d => d.controlChannel === 'bt_mesh').length;
    const graphs = data.geekGraphs ?? [];
    if (meshCount > 0) {
      topBadge.textContent = `${meshCount} Mesh`;
      return;
    }
    if (graphs.length > 0) {
      topBadge.textContent = `${graphs.length} 规则`;
      return;
    }
    topBadge.textContent = devices.length > 0 ? `${devices.length}` : '—';
  }

  function syncGeekLinks(rawUrl: unknown): void {
    const safeUrl = typeof rawUrl === 'string' && SAFE_GEEK_URL_RE.test(rawUrl) ? rawUrl : '';
    for (const link of [openGeekLink, openGeekLink2]) {
      if (safeUrl) {
        link.href = safeUrl;
        link.rel = 'noopener noreferrer';
        link.hidden = false;
      } else {
        link.removeAttribute('href');
        link.hidden = true;
      }
    }
  }

  function renderGatewayCard(data: MiotDashboardData): void {
    const gw = data.gateway;
    const subCount = data.subGateways?.length ?? 0;
    const btVer = data.btService?.version || '未知';
    const meshCount = (data.devices ?? []).filter(d => d.controlChannel === 'bt_mesh').length;
    const spkText = data.speaker?.configured
      ? `小爱音箱 ${data.speaker.id ?? ''} (${data.speaker.source ?? ''})`
      : '小爱音箱未配置';

    const cardHead = node('div', '', 'modal-row-head');
    const titleBox = node('div', '', 'hub-card-title-group');
    titleBox.append(
      node('strong', `📡 ${gw?.roleLabel || 'BE6500 Pro'} · ${gw?.homeName || '本地中枢'}`, 'hub-card-title'),
      node('span', gw?.online ? '在线' : (data.configured === false ? '未配置' : '状态未知'), gw?.online ? 'hub-badge badge-green' : 'hub-badge badge-slate'),
    );
    cardHead.append(titleBox, node('span', gw?.ip ? `${gw.ip}${gw.geekPort ? ` · 极客版 :${gw.geekPort}` : ''}` : (data.routerSsh || '尚未配置 SSH'), 'meta'));

    const metaRow = node('div', '', 'miot-gateway-meta');
    metaRow.append(
      node('span', `BT 网关服务：v${btVer}`, 'hub-badge badge-slate'),
      node('span', `从网关：${subCount} 台`, 'hub-badge badge-slate'),
      node('span', `蓝牙 Mesh 节点：${meshCount} 台`, 'hub-badge badge-slate'),
      node('span', `极客引擎：${data.geekReady ? '已就绪' : '未就绪'}`, data.geekReady ? 'hub-badge badge-green' : 'hub-badge badge-slate'),
      node('span', spkText, 'hub-badge badge-slate'),
    );

    gatewayCard.replaceChildren(cardHead, metaRow);
  }

  function renderRoomPills(devices: MiotDeviceItem[]): void {
    const rooms = [...new Set(devices.map(d => d.room || '未分区'))];
    if (selectedRoom && !rooms.includes(selectedRoom)) {
      selectedRoom = '';
    }
    const focusedRoomKey = typeof document !== 'undefined' && roomPills.contains?.(document.activeElement)
      ? ((document.activeElement as HTMLElement | null)?.dataset?.roomKey ?? null)
      : null;

    const frag = document.createDocumentFragment();
    const allBtn = button('全部房间', () => {
      selectedRoom = '';
      if (lastData) renderMeshView(lastData);
    }, `hub-filter-pill${selectedRoom === '' ? ' active' : ''}`);
    allBtn.dataset.roomKey = '__all__';
    allBtn.setAttribute('aria-pressed', String(selectedRoom === ''));
    frag.append(allBtn);
    for (const room of rooms) {
      const isSelected = selectedRoom === room;
      const btn = button(room, () => {
        selectedRoom = room;
        if (lastData) renderMeshView(lastData);
      }, `hub-filter-pill${isSelected ? ' active' : ''}`);
      btn.dataset.roomKey = room;
      btn.setAttribute('aria-pressed', String(isSelected));
      frag.append(btn);
    }
    roomPills.replaceChildren(frag);
    if (focusedRoomKey) {
      const target = Array.from(roomPills.querySelectorAll<HTMLButtonElement>('button[data-room-key]'))
        .find(b => b.dataset.roomKey === focusedRoomKey);
      if (target) safeFocus(target, { preventScroll: true });
    }

    for (const chBtn of channelPills.querySelectorAll<HTMLButtonElement>('[data-miot-channel]')) {
      const isSelected = chBtn.dataset.miotChannel === selectedChannel;
      chBtn.classList.toggle('active', isSelected);
      chBtn.setAttribute('aria-pressed', String(isSelected));
    }
  }

  function renderDevicesGrid(devices: MiotDeviceItem[]): void {
    const filtered = devices.filter(d => {
      if (selectedRoom && (d.room || '未分区') !== selectedRoom) return false;
      if (selectedChannel !== 'all' && d.controlChannel !== selectedChannel) return false;
      return true;
    });

    if (filtered.length === 0) {
      devicesGrid.replaceChildren(node('p', lastData?.configured === false ? '请先在「中枢与保护配置」中填写 BE6500 Pro 路由器 SSH。' : '当前筛选条件下没有设备。', 'empty'));
      return;
    }

    const focusedDeviceAction = typeof document !== 'undefined' && devicesGrid.contains?.(document.activeElement)
      ? ((document.activeElement as HTMLElement | null)?.dataset?.miotActionKey ?? null)
      : null;

    const frag = document.createDocumentFragment();
    for (const dev of filtered) {
      const devLabel = dev.fullName || dev.name || dev.did;
      const card = node('article', '', 'hub-entity-card miot-device-card');
      const head = node('div', '', 'hub-card-head');
      const titleGroup = node('div', '', 'hub-card-title-group');
      const icon = CATEGORY_ICONS[dev.category] ?? '📦';
      titleGroup.append(node('span', `${icon} ${devLabel}`, 'hub-card-title'));

      if (dev.state?.on !== undefined) {
        titleGroup.append(node('span', dev.state.on ? '已打开' : '已关闭', dev.state.on ? 'hub-badge badge-green' : 'hub-badge badge-slate'));
      } else if (dev.fryer?.statusText) {
        titleGroup.append(node('span', dev.fryer.statusText, 'hub-badge badge-amber'));
      } else {
        titleGroup.append(node('span', dev.online ? '在线' : '离线', dev.online ? 'hub-badge badge-green' : 'hub-badge badge-slate'));
      }
      if (dev.protected) {
        titleGroup.append(node('span', '🛡️ 受保护', 'hub-badge badge-amber'));
      }
      head.append(titleGroup, node('span', CHANNEL_LABELS[dev.controlChannel] ?? dev.controlChannel, 'meta'));
      card.append(head);

      const metaLine = [
        dev.modelName || dev.model,
        dev.ip ? `IP ${dev.ip}` : `DID ${dev.did}`,
        dev.state?.source === 'live' ? '实时' : dev.state?.source === 'cache' ? '中枢缓存' : '',
      ].filter(Boolean).join(' · ');
      card.append(node('p', metaLine, 'meta'));

      if (dev.liveError) {
        card.append(node('p', `⚠️ ${dev.liveError}`, 'hint'));
      }

      const actionsRow = node('div', '', 'miot-card-actions');
      if (dev.controlChannel === 'bt_mesh' && dev.controllable) {
        const onBtn = button('💡 打开', () => { void handleDeviceSet(dev, { on: true }); }, 'mini-button');
        onBtn.setAttribute('aria-label', `打开 ${devLabel}`);
        onBtn.dataset.miotActionKey = `${dev.did}:on`;
        const offBtn = button('🌑 关闭', () => { void handleDeviceSet(dev, { on: false }); }, 'mini-button');
        offBtn.setAttribute('aria-label', `关闭 ${devLabel}`);
        offBtn.dataset.miotActionKey = `${dev.did}:off`;
        if (dev.protected) {
          for (const btn of [onBtn, offBtn]) {
            btn.dataset.locked = 'true';
            btn.title = '已设为保护设备，请在「中枢与保护配置」中解除保护后再手动开关';
          }
        }
        actionsRow.append(onBtn, offBtn);
      } else if (dev.category === 'air_fryer' && dev.controlChannel === 'miio_udp') {
        const stBtn = button('📊 状态', () => { void handleFryerOp(dev, 'status'); }, 'mini-button');
        stBtn.setAttribute('aria-label', `查询 ${devLabel} 状态`);
        stBtn.dataset.miotActionKey = `${dev.did}:status`;
        const pauseBtn = button('⏸ 暂停', () => { void handleFryerOp(dev, 'pause'); }, 'mini-button');
        pauseBtn.setAttribute('aria-label', `暂停 ${devLabel}`);
        pauseBtn.dataset.miotActionKey = `${dev.did}:pause`;
        const stopBtn = button('⏹ 停止', () => { void handleFryerOp(dev, 'stop'); }, 'mini-button');
        stopBtn.setAttribute('aria-label', `停止 ${devLabel}`);
        stopBtn.dataset.miotActionKey = `${dev.did}:stop`;
        actionsRow.append(stBtn, pauseBtn, stopBtn);
      } else if (dev.controlChannel === 'xiaoai_nlp' && dev.category === 'air_conditioner') {
        const onBtn = button('❄️ 开机', () => { void handleDeviceSet(dev, { on: true }); }, 'mini-button');
        onBtn.setAttribute('aria-label', `开启 ${devLabel}`);
        onBtn.dataset.miotActionKey = `${dev.did}:ac-on`;
        const tempBtn = button('26℃', () => { void handleDeviceSet(dev, { temperature: 26 }); }, 'mini-button');
        tempBtn.setAttribute('aria-label', `将 ${devLabel} 设为 26 摄氏度`);
        tempBtn.dataset.miotActionKey = `${dev.did}:ac-26`;
        const offBtn = button('⏹ 关机', () => { void handleDeviceSet(dev, { on: false }); }, 'mini-button');
        offBtn.setAttribute('aria-label', `关闭 ${devLabel}`);
        offBtn.dataset.miotActionKey = `${dev.did}:ac-off`;
        actionsRow.append(onBtn, tempBtn, offBtn);
      } else if (dev.controlChannel === 'tv_agent') {
        const tvBtn = button('📺 电源切换', () => { void handleDeviceSet(dev, { toggle: true }); }, 'mini-button');
        tvBtn.setAttribute('aria-label', `切换 ${devLabel} 电源`);
        tvBtn.dataset.miotActionKey = `${dev.did}:tv-toggle`;
        actionsRow.append(tvBtn);
      } else {
        actionsRow.append(node('span', dev.controllable ? '仅查看' : '中枢/只读节点', 'meta'));
      }
      card.append(actionsRow);
      frag.append(card);
    }
    devicesGrid.replaceChildren(frag);
    if (focusedDeviceAction) {
      const target = Array.from(devicesGrid.querySelectorAll<HTMLButtonElement>('button[data-miot-action-key]'))
        .find(b => b.dataset.miotActionKey === focusedDeviceAction);
      if (target) safeFocus(target, { preventScroll: true });
    }
  }

  function renderMeshView(data: MiotDashboardData): void {
    const devices = data.devices ?? [];
    renderGatewayCard(data);
    renderRoomPills(devices);
    renderDevicesGrid(devices);
  }

  function renderGeekView(data: MiotDashboardData): void {
    const devices = data.devices ?? [];
    const meshDevices = devices.filter(d => d.controlChannel === 'bt_mesh' && d.controllable);
    if (!isEditingWithin(geekCreateBox)) {
      const prevSelect = geekNewDeviceSelect.value;
      const optFrag = document.createDocumentFragment();
      if (meshDevices.length === 0) {
        const emptyOpt = node('option', '暂无可用蓝牙 Mesh 设备');
        emptyOpt.value = '';
        optFrag.append(emptyOpt);
      } else {
        for (const d of meshDevices) {
          const opt = node('option', `${d.fullName} (${d.did})`);
          opt.value = d.did;
          optFrag.append(opt);
        }
      }
      geekNewDeviceSelect.replaceChildren(optFrag);
      if (prevSelect && meshDevices.some(d => d.did === prevSelect)) {
        geekNewDeviceSelect.value = prevSelect;
      }
    }

    const graphs = data.geekGraphs ?? [];
    if (graphs.length === 0) {
      geekList.replaceChildren(node('p', data.configured === false ? '请先配置 BE6500 Pro 路由器 SSH。' : '中枢上暂无极客版自动化规则。', 'empty'));
    } else {
      const focusedGeekKey = typeof document !== 'undefined' && geekList.contains?.(document.activeElement)
        ? ((document.activeElement as HTMLElement | null)?.dataset?.geekFocusKey ?? null)
        : null;
      const frag = document.createDocumentFragment();
      for (const g of graphs) {
        const ruleName = g.name || g.id;
        const card = node('article', '', 'hub-entity-card miot-geek-card');
        const head = node('div', '', 'hub-card-head');
        const titleGroup = node('div', '', 'hub-card-title-group');
        titleGroup.append(
          node('span', `⚡ ${ruleName}`, 'hub-card-title'),
          node('span', g.enable ? '运行中' : '已停用', g.enable ? 'hub-badge badge-green' : 'hub-badge badge-slate'),
        );
        head.append(titleGroup, node('span', `ID ${g.id} · ${g.nodeCount} 节点`, 'meta'));
        card.append(head);

        card.append(node('p', g.summary || '暂无摘要', 'miot-flow-summary'));

        if (g.nodeTypes && g.nodeTypes.length > 0) {
          const chips = node('div', '', 'miot-node-chips');
          for (const t of g.nodeTypes) {
            chips.append(node('span', t, 'hub-badge badge-slate'));
          }
          card.append(chips);
        }

        if (g.steps && g.steps.length > 0) {
          const details = node('details', '', 'miot-rule-details') as HTMLDetailsElement;
          details.open = openRuleDetails.has(g.id);
          details.addEventListener('toggle', () => {
            if (details.open) openRuleDetails.add(g.id);
            else openRuleDetails.delete(g.id);
          });
          const summary = node('summary', `查看节点明细 (${g.steps.length})`, 'meta');
          summary.dataset.geekFocusKey = `${g.id}:details`;
          details.append(summary);
          const ul = node('ul', '', 'miot-step-list');
          for (const step of g.steps) {
            ul.append(node('li', `[${step.type}] ${step.description}`, 'meta'));
          }
          details.append(ul);
          card.append(details);
        }

        const rowBottom = node('div', '', 'modal-row-head');
        const updatedText = g.lastUpdateTime ? `更新于 ${timestamp(g.lastUpdateTime)}` : '';
        const btns = node('div', '', 'modal-btn-group');
        const toggleBtn = button(g.enable ? '⏸ 停用' : '▶ 启用', () => {
          void handleToggleGeekRule(g);
        }, g.enable ? 'mini-button' : 'primary');
        toggleBtn.setAttribute('aria-label', `${g.enable ? '停用' : '启用'}极客规则 ${ruleName}`);
        toggleBtn.dataset.geekFocusKey = `${g.id}:toggle`;

        const delBtn = button('🗑 删除', () => {
          void handleDeleteGeekRule(g);
        }, 'mini-button danger-btn');
        delBtn.setAttribute('aria-label', `删除极客规则 ${ruleName}`);
        delBtn.dataset.geekFocusKey = `${g.id}:del`;
        btns.append(toggleBtn, delBtn);

        rowBottom.append(node('span', updatedText, 'meta'), btns);
        card.append(rowBottom);
        frag.append(card);
      }
      geekList.replaceChildren(frag);
      if (focusedGeekKey) {
        const target = Array.from(geekList.querySelectorAll<HTMLElement>('[data-geek-focus-key]'))
          .find(el => el.dataset.geekFocusKey === focusedGeekKey);
        if (target) safeFocus(target, { preventScroll: true });
      }
    }

    const prevLogFilter = selectedLogGraphId;
    const filterFrag = document.createDocumentFragment();
    const allOpt = node('option', '全部规则');
    allOpt.value = '';
    filterFrag.append(allOpt);
    for (const g of graphs) {
      const opt = node('option', `${g.name || g.id}`);
      opt.value = g.id;
      filterFrag.append(opt);
    }
    logFilterSelect.replaceChildren(filterFrag);
    if (prevLogFilter && graphs.some(g => g.id === prevLogFilter)) {
      logFilterSelect.value = prevLogFilter;
    } else {
      selectedLogGraphId = '';
    }

    renderGeekLogs(data.geekLogs ?? []);
  }

  function renderGeekLogs(logs: MiotGeekLogEntry[]): void {
    const filtered = selectedLogGraphId
      ? logs.filter(l => l.graphId === selectedLogGraphId)
      : logs;
    if (filtered.length === 0) {
      geekLogs.replaceChildren(node('p', '暂无匹配的极客引擎执行日志。', 'empty'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const entry of filtered) {
      const row = node('div', '', 'miot-log-row');
      const left = node('div', '', 'miot-log-main');
      left.append(
        node('span', timestamp(entry.ts), 'meta'),
        node('span', entry.graphName || entry.graphId, 'hub-badge badge-slate'),
        node('span', entry.summary, 'miot-log-summary'),
      );
      row.append(left);
      if (entry.ok === true) {
        row.append(node('span', '成功', 'hub-badge badge-green'));
      } else if (entry.ok === false) {
        row.append(node('span', '异常', 'hub-badge badge-red'));
      }
      frag.append(row);
    }
    geekLogs.replaceChildren(frag);
  }

  function renderScenesView(data: MiotDashboardData): void {
    const scenes = data.scenes ?? [];
    if (scenes.length === 0) {
      scenesList.replaceChildren(node('p', '当前没有已本地化的米家手动场景。', 'empty'));
    } else {
      const focusedSceneKey = typeof document !== 'undefined' && scenesList.contains?.(document.activeElement)
        ? ((document.activeElement as HTMLElement | null)?.dataset?.sceneFocusKey ?? null)
        : null;
      const frag = document.createDocumentFragment();
      for (const sc of scenes) {
        const sceneTitle = sc.summary || sc.id;
        const card = node('article', '', 'hub-entity-card miot-scene-card');
        const head = node('div', '', 'hub-card-head');
        const titleGroup = node('div', '', 'hub-card-title-group');
        titleGroup.append(node('span', `🎬 ${sceneTitle}`, 'hub-card-title'));
        if (sc.turnsOffProtected) {
          titleGroup.append(node('span', '🛡️ 含关闭保护设备', 'hub-badge badge-amber'));
        }
        head.append(titleGroup, node('span', `ID ${sc.id}`, 'meta'));
        card.append(head);

        if (sc.updatedAt) {
          card.append(node('p', `同步时间：${timestamp(sc.updatedAt)}`, 'meta'));
        }
        const actionsRow = node('div', '', 'miot-card-actions');
        const runBtn = button('▶ 立即触发', () => {
          void handleRunScene(sc);
        }, 'primary');
        runBtn.setAttribute('aria-label', `触发本地场景 ${sceneTitle}`);
        runBtn.dataset.sceneFocusKey = sc.id;
        actionsRow.append(runBtn);
        card.append(actionsRow);
        frag.append(card);
      }
      scenesList.replaceChildren(frag);
      if (focusedSceneKey) {
        const target = Array.from(scenesList.querySelectorAll<HTMLButtonElement>('button[data-scene-focus-key]'))
          .find(b => b.dataset.sceneFocusKey === focusedSceneKey);
        if (target) safeFocus(target, { preventScroll: true });
      }
    }

    const vars = data.variables ?? [];
    if (vars.length === 0) {
      varsList.replaceChildren(node('p', '当前极客版没有自定义变量，可在上方创建一个与 Friday 联动。', 'empty'));
    } else {
      const focusedVarKey = typeof document !== 'undefined' && varsList.contains?.(document.activeElement)
        ? ((document.activeElement as HTMLElement | null)?.dataset?.varFocusKey ?? null)
        : null;
      const activeInput = focusedVarKey?.endsWith(':input')
        ? (document.activeElement as HTMLInputElement | null)
        : null;
      const selStart = activeInput?.selectionStart ?? null;
      const selEnd = activeInput?.selectionEnd ?? null;

      const frag = document.createDocumentFragment();
      for (const v of vars) {
        const varKey = `${v.scope}.${v.id}`;
        const row = node('div', '', 'miot-var-row');
        const info = node('div', '', 'miot-var-info');
        info.append(
          node('strong', varKey),
          node('span', v.type, 'hub-badge badge-slate'),
        );
        const valInput = node('input', '', 'hub-input') as HTMLInputElement;
        valInput.type = 'text';
        const serverVal = v.value === undefined || v.value === null ? '' : String(v.value);
        valInput.value = dirtyVars.has(varKey) ? dirtyVars.get(varKey)! : serverVal;
        valInput.setAttribute('aria-label', `${varKey} 变量值`);
        valInput.dataset.varFocusKey = `${varKey}:input`;
        valInput.addEventListener('input', () => {
          dirtyVars.set(varKey, valInput.value);
        });

        const setBtn = button('写入', () => {
          void handleSetVar(v.scope, v.id, valInput.value);
        }, 'mini-button');
        setBtn.setAttribute('aria-label', `写入变量 ${varKey}`);
        setBtn.dataset.varFocusKey = `${varKey}:set`;

        const delBtn = button('删除', () => {
          void handleDeleteVar(v.scope, v.id);
        }, 'mini-button danger-btn');
        delBtn.setAttribute('aria-label', `删除变量 ${varKey}`);
        delBtn.dataset.varFocusKey = `${varKey}:del`;

        const btns = node('div', '', 'modal-btn-group');
        btns.append(setBtn, delBtn);
        row.append(info, valInput, btns);
        frag.append(row);
      }
      varsList.replaceChildren(frag);
      if (focusedVarKey) {
        const target = Array.from(varsList.querySelectorAll<HTMLElement>('[data-var-focus-key]'))
          .find(el => el.dataset.varFocusKey === focusedVarKey);
        if (target) {
          safeFocus(target, { preventScroll: true });
          if (selStart !== null && selEnd !== null && 'setSelectionRange' in target) {
            try {
              (target as HTMLInputElement).setSelectionRange(selStart, selEnd);
            } catch {
              // Ignore selection restore failures on stub inputs
            }
          }
        }
      }
    }
  }

  function renderConfigView(data: MiotDashboardData): void {
    if (!data.config || isEditingWithin(configCard)) return;
    cfgRouterInput.value = data.config.routerSsh ?? '';
    cfgSpeakerInput.value = data.config.speakerSsh ?? '';
    cfgProtectedInput.value = (data.config.protectedDevices ?? []).join(', ');
    cfgAliasesInput.value = formatCustomAliasesTextarea(data.config.customAliases);
    cfgCacheTtlInput.value = String(data.config.cacheTtlMs ?? 15000);
    cfgTopoTtlInput.value = String(data.config.topologyTtlMs ?? 600000);
    cfgUdpTimeoutInput.value = String(data.config.udpTimeoutMs ?? 3500);
  }

  function render(data: MiotDashboardData): void {
    lastData = data;
    updateTopBadge(data);
    syncGeekLinks(data.geekUrl);

    const configured = data.configured !== false;
    const gwOnline = data.gateway?.online === true;
    if (!configured) {
      hubPill.textContent = '未配置中枢';
      hubPill.className = 'hub-badge badge-slate';
    } else if (data.degraded) {
      hubPill.textContent = '● 缓存降级';
      hubPill.className = 'hub-badge badge-amber';
    } else if (gwOnline) {
      hubPill.textContent = '● 中枢在线';
      hubPill.className = 'hub-badge badge-green';
    } else if (data.fromCache) {
      hubPill.textContent = '📦 本地缓存';
      hubPill.className = 'hub-badge badge-slate';
    } else {
      hubPill.textContent = '中枢待检测';
      hubPill.className = 'hub-badge badge-slate';
    }

    const devices = data.devices ?? [];
    const meshCount = devices.filter(d => d.controlChannel === 'bt_mesh').length;
    const graphs = data.geekGraphs ?? [];
    const enabledRules = graphs.filter(g => g.enable).length;
    const scenes = data.scenes ?? [];
    const vars = data.variables ?? [];
    const updatedTs = data.centralFetchedAt ?? data.hotDataFetchedAt ?? data.fetchedAt;

    const kpiFrag = document.createDocumentFragment();
    kpiFrag.append(
      kpiCard(
        '中枢网关',
        !configured ? '未配置' : (gwOnline ? '在线' : (data.fromCache ? '缓存' : '离线')),
        data.gateway?.homeName || (data.btService?.version ? `BT v${data.btService.version}` : 'BE6500 Pro'),
        gwOnline ? 'positive' : (data.degraded ? 'warning' : 'default'),
      ),
      kpiCard('全屋设备', `${devices.length}`, `${meshCount} 台蓝牙 Mesh`, devices.length > 0 ? 'accent' : 'default'),
      kpiCard('极客自动化', `${enabledRules}/${graphs.length}`, data.geekReady ? '引擎运行中' : '引擎待检测', enabledRules > 0 ? 'positive' : 'default'),
      kpiCard('场景 / 变量', `${scenes.length} / ${vars.length}`, updatedTs ? timestamp(updatedTs) : '尚无快照', 'default'),
    );
    kpiGrid.replaceChildren(kpiFrag);

    renderMeshView(data);
    renderGeekView(data);
    renderScenesView(data);
    renderConfigView(data);
    syncControlStates();
  }

  async function loadDashboard(
    mode: 'auto' | 'refresh' | 'live' | 'cache' = 'auto',
    opts?: { preserveBanner?: boolean },
  ): Promise<void> {
    if (disposed || busy || appState.authExpired) return;
    const seq = ++requestSeq;
    setBusy(true);
    if (!opts?.preserveBanner) {
      if (mode === 'live') {
        setStatus('正在实时读取 BE6500 Pro 中枢、蓝牙 Mesh 开关与极客规则…', 'warn');
      } else if (mode === 'refresh') {
        setStatus('正在刷新 BE6500 Pro 中枢拓扑、极客规则与日志…', 'warn');
      }
    }
    try {
      const args = mode === 'cache'
        ? { cacheOnly: true }
        : mode === 'live'
          ? { refresh: true, live: true }
          : mode === 'refresh'
            ? { refresh: true, live: false }
            : { refresh: false, live: false };
      const res = await runMiotPlugin('dashboard', args, { signal: lifecycleAc.signal });
      if (disposed || seq !== requestSeq || appState.authExpired) return;
      busy = false;
      if (res.data) {
        render(res.data);
      }
      if (!opts?.preserveBanner) {
        if (!res.ok) {
          setStatus(res.message || '读取米家中枢失败', 'err');
        } else if (res.data?.degraded) {
          setStatus(res.message, 'warn');
        } else if (mode === 'live' || mode === 'refresh') {
          setStatus(res.message || '中枢状态已刷新', 'ok');
        } else {
          setStatus('');
        }
      }
    } catch (err) {
      if (disposed || seq !== requestSeq || appState.authExpired) return;
      if (!opts?.preserveBanner) {
        setStatus(`加载米家中枢失败：${errorText(err)}`, 'err');
      }
    } finally {
      if (seq === requestSeq) setBusy(false);
    }
  }

  async function runAndReload(
    action: string,
    args: Record<string, unknown>,
    pendingMsg: string,
    reloadMode: 'auto' | 'refresh' | 'live' = 'auto',
  ): Promise<boolean> {
    if (disposed || busy || appState.authExpired) return false;
    const seq = ++requestSeq;
    setBusy(true);
    setStatus(pendingMsg, 'warn');
    try {
      const res = await runMiotPlugin(action, args, { signal: lifecycleAc.signal });
      if (disposed || seq !== requestSeq || appState.authExpired) return false;
      setStatus(res.message || (res.ok ? '操作成功' : '操作失败'), res.ok ? 'ok' : 'err');
      busy = false;
      if (res.ok) {
        await loadDashboard(reloadMode, { preserveBanner: true });
      }
      return res.ok;
    } catch (err) {
      if (disposed || seq !== requestSeq || appState.authExpired) return false;
      setStatus(`操作失败：${errorText(err)}`, 'err');
      return false;
    } finally {
      if (seq === requestSeq) setBusy(false);
    }
  }

  async function handleDeviceSet(dev: MiotDeviceItem, patch: Record<string, unknown>): Promise<void> {
    await runAndReload('set', { did: dev.did, ...patch }, `正在控制 ${dev.fullName}…`, 'live');
  }

  async function handleFryerOp(dev: MiotDeviceItem, op: string): Promise<void> {
    await runAndReload('cook', { did: dev.did, op }, `正在执行空气炸锅 ${op}…`, 'auto');
  }

  async function handleBatchMesh(targetOn: boolean): Promise<void> {
    if (disposed || busy || appState.authExpired) return;
    const scopeLabel = selectedRoom ? `「${selectedRoom}」的` : '全屋';
    const actionLabel = targetOn ? '打开' : '关闭';
    const confirmed = await confirmAction({
      title: `批量${actionLabel}蓝牙 Mesh 设备`,
      message: `确定批量${actionLabel}${scopeLabel}蓝牙 Mesh 设备吗？（受保护设备会自动跳过）`,
      confirmLabel: `确认${actionLabel}`,
      cancelLabel: '取消',
      danger: true,
    });
    if (!confirmed || disposed || appState.authExpired) return;
    await runAndReload(
      'mesh',
      { op: 'batch', on: targetOn, ...(selectedRoom ? { room: selectedRoom } : {}) },
      `正在批量${actionLabel}${scopeLabel}蓝牙 Mesh 设备…`,
      'live',
    );
  }

  async function handleToggleGeekRule(rule: MiotGeekRuleItem): Promise<void> {
    const op = rule.enable ? 'disable' : 'enable';
    await runAndReload(
      'geek',
      { op, id: rule.id },
      `正在${rule.enable ? '停用' : '启用'}极客规则「${rule.name}」…`,
      'auto',
    );
  }

  async function handleDeleteGeekRule(rule: MiotGeekRuleItem): Promise<void> {
    if (disposed || busy || appState.authExpired) return;
    const confirmed = await confirmAction({
      title: '删除极客规则',
      message: `确定删除极客规则「${rule.name}」（ID: ${rule.id}）吗？删除后无法恢复。`,
      confirmLabel: '确认删除',
      cancelLabel: '取消',
      danger: true,
    });
    if (!confirmed || disposed || appState.authExpired) return;
    await runAndReload('geek', { op: 'delete', id: rule.id }, `正在删除极客规则「${rule.name}」…`, 'auto');
  }

  async function handleCreateGeekSchedule(): Promise<void> {
    if (disposed || busy || appState.authExpired) return;
    geekNewNameInput.setAttribute('aria-invalid', 'false');
    geekNewDeviceSelect.setAttribute('aria-invalid', 'false');
    geekNewOnTime.setAttribute('aria-invalid', 'false');
    geekNewOffTime.setAttribute('aria-invalid', 'false');

    const name = geekNewNameInput.value.trim();
    const did = geekNewDeviceSelect.value.trim();
    const onTime = geekNewOnTime.value.trim();
    const offTime = geekNewOffTime.value.trim();
    if (!name) {
      geekNewNameInput.setAttribute('aria-invalid', 'true');
      setStatus('请输入规则名称。', 'warn');
      safeFocus(geekNewNameInput);
      return;
    }
    if (!did) {
      geekNewDeviceSelect.setAttribute('aria-invalid', 'true');
      setStatus('请选择目标蓝牙 Mesh 设备。', 'warn');
      safeFocus(geekNewDeviceSelect);
      return;
    }
    const rules: Array<{ time: string; did: string; on: boolean }> = [];
    if (onTime) rules.push({ time: onTime, did, on: true });
    if (offTime) rules.push({ time: offTime, did, on: false });
    if (rules.length === 0) {
      geekNewOnTime.setAttribute('aria-invalid', 'true');
      setStatus('请至少填写一个开启或关闭时间。', 'warn');
      safeFocus(geekNewOnTime);
      return;
    }
    const ok = await runAndReload(
      'geek',
      {
        op: 'create-schedule',
        name,
        enable: geekNewEnable.checked,
        rules,
      },
      `正在向 BE6500 Pro 写入极客定时规则「${name}」…`,
      'auto',
    );
    if (ok) {
      geekNewNameInput.value = '';
      setGeekCreateOpen(false, false);
    }
  }

  async function handleRunScene(sc: MiotSceneItem): Promise<void> {
    if (disposed || busy || appState.authExpired) return;
    let confirmProtected = false;
    if (sc.turnsOffProtected) {
      const confirmed = await confirmAction({
        title: '触发含保护设备的场景',
        message: `本地场景「${sc.summary}」包含关闭保护设备的操作，确定要触发吗？`,
        confirmLabel: '确认触发',
        cancelLabel: '取消',
        danger: true,
      });
      if (!confirmed || disposed || appState.authExpired) return;
      confirmProtected = true;
    }
    await runAndReload(
      'scene',
      { op: 'run', id: sc.id, ...(confirmProtected ? { confirmProtected: true } : {}) },
      `正在触发本地场景「${sc.summary}」…`,
      'auto',
    );
  }

  async function handleCreateVar(): Promise<void> {
    if (disposed || busy || appState.authExpired) return;
    varScopeInput.setAttribute('aria-invalid', 'false');
    varIdInput.setAttribute('aria-invalid', 'false');
    const scope = varScopeInput.value.trim();
    const id = varIdInput.value.trim();
    const type = varTypeSelect.value === 'string' ? 'string' : 'number';
    const value = varValueInput.value.trim();
    if (!scope || !id) {
      const invalidField = !scope ? varScopeInput : varIdInput;
      invalidField.setAttribute('aria-invalid', 'true');
      setStatus('请填写变量 Scope 与 ID（仅限英文字母与数字）。', 'warn');
      safeFocus(invalidField);
      return;
    }
    const ok = await runAndReload(
      'geek',
      { op: 'var-create', scope, id, type, value },
      `正在创建极客版变量 ${scope}.${id}…`,
      'auto',
    );
    if (ok) {
      varIdInput.value = '';
      varValueInput.value = '';
    }
  }

  async function handleSetVar(scope: string, id: string, value: string): Promise<void> {
    const ok = await runAndReload('geek', { op: 'var-set', scope, id, value }, `正在更新变量 ${scope}.${id}…`, 'auto');
    if (ok) {
      dirtyVars.delete(`${scope}.${id}`);
    }
  }

  async function handleDeleteVar(scope: string, id: string): Promise<void> {
    if (disposed || busy || appState.authExpired) return;
    const confirmed = await confirmAction({
      title: '删除极客版变量',
      message: `确定删除极客版变量 ${scope}.${id} 吗？`,
      confirmLabel: '确认删除',
      cancelLabel: '取消',
      danger: true,
    });
    if (!confirmed || disposed || appState.authExpired) return;
    const ok = await runAndReload('geek', { op: 'var-delete', scope, id }, `正在删除变量 ${scope}.${id}…`, 'auto');
    if (ok) {
      dirtyVars.delete(`${scope}.${id}`);
    }
  }

  async function handleSaveConfig(): Promise<void> {
    const protectedDevices = cfgProtectedInput.value
      .split(/[,，\n]/)
      .map(s => s.trim())
      .filter(Boolean);
    await runAndReload(
      'config',
      {
        routerSsh: cfgRouterInput.value.trim(),
        speakerSsh: cfgSpeakerInput.value.trim(),
        protectedDevices,
        customAliases: parseCustomAliasesTextarea(cfgAliasesInput.value),
        cacheTtlMs: Number(cfgCacheTtlInput.value),
        topologyTtlMs: Number(cfgTopoTtlInput.value),
        udpTimeoutMs: Number(cfgUdpTimeoutInput.value),
      },
      '正在保存米家中枢配置…',
      'refresh',
    );
  }

  bindRovingTablist(workspaceTabs, {
    signal: lifecycleAc.signal,
    onActivate: tab => {
      const view = tab.dataset.miotView as MiotWorkspaceView | undefined;
      if (view && (view === 'mesh' || view === 'geek' || view === 'scenes' || view === 'config')) {
        switchView(view);
      }
    },
  });

  listenEvent(channelPills, 'click', evt => {
    const target = (evt.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-miot-channel]');
    const ch = target?.dataset.miotChannel;
    if (ch) {
      selectedChannel = ch;
      if (lastData) renderMeshView(lastData);
    }
  }, lifecycleAc.signal);

  listenEvent(liveRefreshBtn, 'click', () => { void loadDashboard('live'); }, lifecycleAc.signal);
  listenEvent(refreshBtn, 'click', () => { void loadDashboard('refresh'); }, lifecycleAc.signal);
  listenEvent(batchOnBtn, 'click', () => { void handleBatchMesh(true); }, lifecycleAc.signal);
  listenEvent(batchOffBtn, 'click', () => { void handleBatchMesh(false); }, lifecycleAc.signal);

  listenEvent(geekNewToggleBtn, 'click', () => {
    setGeekCreateOpen(geekCreateBox.hidden);
  }, lifecycleAc.signal);
  listenEvent(geekCancelBtn, 'click', () => {
    setGeekCreateOpen(false);
  }, lifecycleAc.signal);
  bindFormSubmission(geekCreateBox, geekCreateBtn, () => { void handleCreateGeekSchedule(); }, lifecycleAc.signal);
  listenEvent(geekRefreshBtn, 'click', () => { void loadDashboard('refresh'); }, lifecycleAc.signal);
  listenEvent(logFilterSelect, 'change', () => {
    selectedLogGraphId = logFilterSelect.value;
    if (lastData) renderGeekLogs(lastData.geekLogs ?? []);
  }, lifecycleAc.signal);

  listenEvent(scenesRefreshBtn, 'click', () => { void loadDashboard('refresh'); }, lifecycleAc.signal);
  bindFormSubmission(varsForm, varCreateBtn, () => { void handleCreateVar(); }, lifecycleAc.signal);
  bindFormSubmission(configCard, cfgSaveBtn, () => { void handleSaveConfig(); }, lifecycleAc.signal);

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
        void loadDashboard('auto');
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
        const res = await runMiotPlugin('dashboard', { cacheOnly: true }, {
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

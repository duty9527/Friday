import { button, element, isEditingWithin, kpiCard, node } from '../shared/dom.js';
import { errorText } from '../shared/format.js';
import { api, appState } from '../state.js';

export interface Cs80FaceUiOptions {
  isVisible: () => boolean;
}

export interface Cs80FaceUiController {
  activate: () => void;
  deactivate: () => void;
  refreshBadge: () => Promise<void>;
}

type CardSize = '1x1' | '2x1' | '1x2' | '2x2';

interface Cs80CardSpec {
  id: string;
  kind: string;
  size: CardSize;
  plugin?: string;
  action?: string;
  title?: string;
  ttlSec?: number;
}

interface Cs80PageSpec {
  id: string;
  name: string;
  cards: Cs80CardSpec[];
}

interface Cs80LayoutConfig {
  version: number;
  gridRows: 2 | 3;
  marqueeMode: 'auto_pause' | 'continuous' | 'static';
  marqueeSpeed: 1 | 2 | 3;
  pageRotateSec: number;
  autoTaskOverlay: boolean;
  activePage: number;
  weatherCity: string;
  weatherLat: number;
  weatherLon: number;
  pages: Cs80PageSpec[];
}

interface Cs80CatalogItem {
  kind: string;
  category: 'plugin' | 'core' | 'custom_plugin' | string;
  plugin?: string;
  title: string;
  subtitle: string;
  actions?: string[];
  defaultAction?: string;
  configurableAction?: boolean;
  defaultSize: CardSize;
  supportedSizes: CardSize[];
  enabled?: boolean;
}

interface Cs80WidgetSummary {
  headline: string;
  subline: string;
  ok: boolean;
  ageSec: number;
}

interface Cs80StatusData {
  ok: boolean;
  device?: string;
  usbSpeed?: number | null;
  block?: number;
  botState?: string;
  subPhase?: string;
  expression?: string;
  workerCount?: number;
  standby?: boolean;
  brightness?: number;
  fridayConnected?: boolean;
  gridRows?: number;
  activePage?: number;
  pageCount?: number;
  marqueeMode?: string;
  cairo?: boolean;
  fast565?: boolean;
  lastError?: string | null;
  udevHint?: string | null;
  hwState?: { brightness?: number | null; backlightPwm?: number | null; edges?: number | null };
  stats?: { frameMs?: number; patchMs?: number; patchTiles?: number };
  speaker?: { volume?: number; muted?: boolean; quietHours?: string };
}

interface Cs80DashboardPayload {
  ok: boolean;
  status: Cs80StatusData;
  layout: Cs80LayoutConfig;
  catalog: Cs80CatalogItem[];
  widgets: Record<string, Cs80WidgetSummary>;
  previewDataUrl?: string;
}

interface PluginRunResponse<T = unknown> {
  ok: boolean;
  plugin: string;
  action: string;
  title?: string;
  message?: string;
  data?: T;
}

const CARD_SIZES: readonly CardSize[] = ['1x1', '2x1', '1x2', '2x2'];

const DEVICE_STATE_LABELS: Record<string, string> = {
  disconnected: '未连接',
  connecting: '连接中',
  permission_denied: '缺少权限',
  no_sidecar: '缺少驱动',
  up: '在线运行',
};

const BOT_STATE_LABELS: Record<string, string> = {
  idle: '待机守候',
  listening: '正在倾听',
  speaking: '语音播报',
  sending_msg: '发送消息',
  printing: '正在打印',
  operating_xiaoai: '操控小爱',
  operating_tv: '操控电视',
  managing_laifen: '牙刷管理',
  weighing_scale: '体脂测重',
  thinking: '思考推演',
  searching: '记忆检索',
  streaming: '正在回复',
  working: '协同执行',
  waiting: '等待指示',
  finished: '执行完成',
  failed: '执行受阻',
  sleeping: '静默休眠',
};

const SUB_PHASE_LABELS: Record<string, string> = {
  awake: '清醒',
  nrem: '浅休眠',
  rem: '梦境整理',
};

const EXPRESSION_LABELS: Record<string, string> = {
  auto: '自动表情',
  happy: '开心',
  listening: '专注倾听',
  speaking: '语音播报',
  sending_msg: '发送消息',
  printing: '正在打印',
  operating_xiaoai: '操控小爱',
  operating_tv: '操控电视',
  managing_laifen: '牙刷管理',
  weighing_scale: '体脂测重',
  inspecting: '打量',
  surprised: '惊喜',
  calm: '平静',
  sleepy: '困倦',
  neutral: '默认',
  squinted: '专注眯眼',
  confused: '疑惑',
  sad: '失落',
};

const CARD_ACTION_LABELS: Record<string, string> = {
  status: '实时状态',
  dashboard: '看板概览',
  devices: '设备列表',
  scan: '扫描发现',
  patrol: '安全巡检',
  remind: '准点提醒',
  noon: '午间估值',
  settle: '晚间结算',
  trips: '骑行行程',
  vehicles: '车辆列表',
  'charge-check': '电量巡检',
  locate: '设备定位',
  'play-sound': '响铃寻物',
  sync: '唤醒同步',
  config: '参数配置',
  on: '临时开灯',
  off: '临时关灯',
  resume: '恢复行程',
  keys: '支持按键',
  tree: '界面结构',
  screenshot: '屏幕截图',
  get: '查询状态',
  set: '调节设置',
  command: '语音指令',
  action: '调用动作',
  cook: '烹饪控制',
  power: '电源控制',
  volume: '音量控制',
  cast: '投屏控制',
  open_app: '打开应用',
  act: '界面动作',
  navigate: '智能导航',
  press: '发送按键',
  sequence: '按键序列',
  learn: '红外学习',
  init: '初始化',
  login: '账号登录',
  logout: '退出登录',
  'measure-start': '开始测量',
  'measure-status': '测量进度',
  'measure-stop': '停止测量',
  'monitor-start': '开始监听',
  'monitor-status': '监听进度',
  'monitor-stop': '停止监听',
  'watch-start': '开启守护',
  'watch-stop': '关闭守护',
  'brushhead-reset': '重置刷头',
};

function localizeDeviceState(state?: string): string {
  const key = (state ?? '').trim().toLowerCase();
  if (!key) return '未连接';
  return DEVICE_STATE_LABELS[key] ?? state ?? '未连接';
}

function localizeBotState(state?: string): string {
  const key = (state ?? 'idle').trim().toLowerCase();
  return BOT_STATE_LABELS[key] ?? state ?? '待机守候';
}

function localizeSubPhase(phase?: string): string {
  const key = (phase ?? 'awake').trim().toLowerCase();
  return SUB_PHASE_LABELS[key] ?? phase ?? '清醒';
}

function localizeExpression(expr?: string): string {
  const key = (expr ?? 'auto').trim().toLowerCase();
  return EXPRESSION_LABELS[key] ?? expr ?? '自动表情';
}

function localizeCardAction(actionName: string, pluginName?: string): string {
  if (pluginName) {
    const plugin = appState.view?.plugins?.find(p => p.name === pluginName);
    const specLabel = plugin?.actionSpecs?.find(s => s.name === actionName)?.label;
    if (specLabel) return specLabel;
  }
  return CARD_ACTION_LABELS[actionName] ?? actionName;
}

function cloneLayout(src: Cs80LayoutConfig): Cs80LayoutConfig {
  return JSON.parse(JSON.stringify(src)) as Cs80LayoutConfig;
}

function estimateOverflowFlags(cards: readonly Cs80CardSpec[], gridRows: number): boolean[] {
  const rows = gridRows === 3 ? 3 : 2;
  const cols = 2;
  const occ: boolean[][] = Array.from({ length: rows }, () => [false, false]);
  const flags = new Array<boolean>(cards.length).fill(false);

  const fit = (ew: number, eh: number): [number, number] | undefined => {
    for (let r = 0; r <= rows - eh; r++) {
      for (let c = 0; c <= cols - ew; c++) {
        let free = true;
        for (let dr = 0; dr < eh; dr++) {
          for (let dc = 0; dc < ew; dc++) {
            if (occ[r + dr]![c + dc]) free = false;
          }
        }
        if (free) return [r, c];
      }
    }
    return undefined;
  };

  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]!;
    const [rw, rh] = c.size.split('x').map(Number);
    const reqW = rw === 2 ? 2 : 1;
    const reqH = rh === 2 ? 2 : 1;
    const tries: Array<[number, number]> = [[reqW, reqH]];
    if (reqH === 2) tries.push([reqW, 1]);
    if (reqW === 2) tries.push([1, 1]);
    let placed: [number, number, number, number] | undefined;
    for (const [tw, th] of tries) {
      if (th > rows) continue;
      const pos = fit(tw, th);
      if (pos) {
        placed = [pos[0], pos[1], tw, th];
        break;
      }
    }
    if (!placed) {
      flags[i] = true;
    } else {
      for (let dr = 0; dr < placed[3]; dr++) {
        for (let dc = 0; dc < placed[2]; dc++) {
          occ[placed[0] + dr]![placed[1] + dc] = true;
        }
      }
    }
  }
  return flags;
}

export function initCs80FaceUi(options: Cs80FaceUiOptions): Cs80FaceUiController {
  const panelEl = element<HTMLElement>('plugin-panel-cs80-face');
  const topBadge = element<HTMLElement>('cs80-top-badge');
  const autoPreviewCheck = element<HTMLInputElement>('cs80-auto-preview');
  const refreshBtn = element<HTMLButtonElement>('cs80-refresh-btn');
  const saveLayoutBtn = element<HTMLButtonElement>('cs80-save-layout-btn');
  const statusBanner = element<HTMLElement>('cs80-action-status');
  const kpiGrid = element<HTMLElement>('cs80-kpi-grid');
  const devicePill = element<HTMLElement>('cs80-device-pill');
  const livePreviewImg = element<HTMLImageElement>('cs80-live-preview');
  const previewEmpty = element<HTMLElement>('cs80-preview-empty');
  const forceFullBtn = element<HTMLButtonElement>('cs80-force-full-btn');
  const standbyBtn = element<HTMLButtonElement>('cs80-standby-btn');
  const resetLayoutBtn = element<HTMLButtonElement>('cs80-reset-layout-btn');
  const syncBadge = element<HTMLElement>('cs80-sync-badge');

  const gridRowsPills = element<HTMLElement>('cs80-grid-rows-pills');
  const marqueeModeSelect = element<HTMLSelectElement>('cs80-marquee-mode');
  const marqueeSpeedSelect = element<HTMLSelectElement>('cs80-marquee-speed');
  const pageRotateSelect = element<HTMLSelectElement>('cs80-page-rotate');
  const weatherCityInput = element<HTMLInputElement>('cs80-weather-city');
  const taskOverlayCheck = element<HTMLInputElement>('cs80-task-overlay');

  const pageAddBtn = element<HTMLButtonElement>('cs80-page-add-btn');
  const pageRenameBtn = element<HTMLButtonElement>('cs80-page-rename-btn');
  const pageDelBtn = element<HTMLButtonElement>('cs80-page-del-btn');
  const pageTabsEl = element<HTMLElement>('cs80-page-tabs');
  const bentoEditorEl = element<HTMLElement>('cs80-bento-editor');
  const catalogMetaEl = element<HTMLElement>('cs80-catalog-meta');
  const catalogPickerEl = element<HTMLElement>('cs80-catalog-picker');

  const expressBtnsEl = element<HTMLElement>('cs80-express-btns');
  const bannerInput = element<HTMLInputElement>('cs80-banner-input');
  const bannerSendBtn = element<HTMLButtonElement>('cs80-banner-send-btn');
  const brightnessPillsEl = element<HTMLElement>('cs80-brightness-pills');
  const volumeSelect = element<HTMLSelectElement>('cs80-volume-select');
  const muteBtn = element<HTMLButtonElement>('cs80-mute-btn');
  const quietHoursInput = element<HTMLInputElement>('cs80-quiet-hours');
  const quietSaveBtn = element<HTMLButtonElement>('cs80-quiet-save-btn');
  const chimeBtnsEl = element<HTMLElement>('cs80-chime-btns');

  let active = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let latestData: Cs80DashboardPayload | undefined;
  let draftLayout: Cs80LayoutConfig | undefined;
  let dirty = false;
  let busy = false;

  function setBanner(text: string, isError = false): void {
    statusBanner.textContent = text;
    statusBanner.classList.toggle('is-error', isError);
    statusBanner.hidden = !text;
  }

  async function callPlugin<T = unknown>(action: string, args: Record<string, unknown> = {}): Promise<PluginRunResponse<T>> {
    return api<PluginRunResponse<T>>('/api/plugin-run', {
      plugin: 'cs80-face',
      action,
      args: { silent: true, ...args },
    });
  }

  function updateTopBadge(st?: Cs80StatusData): void {
    topBadge.classList.remove('badge-green', 'badge-amber', 'badge-red');
    if (!st || !st.ok) {
      topBadge.textContent = '离线';
      topBadge.classList.add('badge-red');
      return;
    }
    if (st.device === 'up') {
      topBadge.textContent = st.standby ? '待机' : `${st.brightness ?? 100}%`;
      topBadge.classList.add(st.standby ? 'badge-amber' : 'badge-green');
    } else {
      topBadge.textContent = st.device === 'permission_denied' ? '需权限' : '未插屏';
      topBadge.classList.add('badge-amber');
    }
  }

  function updateSyncBadge(): void {
    syncBadge.textContent = dirty ? '待同步' : '已同步';
    syncBadge.classList.toggle('badge-amber', dirty);
    syncBadge.classList.toggle('badge-green', !dirty);
  }

  function activePage(): Cs80PageSpec | undefined {
    if (!draftLayout || !draftLayout.pages.length) return undefined;
    const idx = Math.max(0, Math.min(draftLayout.pages.length - 1, draftLayout.activePage));
    draftLayout.activePage = idx;
    return draftLayout.pages[idx];
  }

  function catalogByKind(kind: string): Cs80CatalogItem | undefined {
    return latestData?.catalog.find(c => c.kind === kind);
  }

  function renderTelemetry(st: Cs80StatusData): void {
    updateTopBadge(st);
    const up = st.device === 'up';
    devicePill.textContent = up
      ? (st.standby ? '待机息屏中' : `USB ${st.usbSpeed ?? 480} Mbps 在线`)
      : (st.device === 'permission_denied'
        ? '缺少 udev 权限'
        : st.device === 'no_sidecar'
          ? '缺少本地驱动'
          : st.device === 'connecting'
            ? '正在连接副屏'
            : '守护进程已就绪 / 未接入屏幕');
    devicePill.className = `hub-badge ${up ? (st.standby ? 'badge-amber' : 'badge-green') : 'badge-slate'}`;
    standbyBtn.textContent = st.standby ? '☀️ 唤醒副屏' : '🌙 待机息屏';

    const spk = st.speaker ?? {};
    const stats = st.stats ?? {};
    const pwmOff = st.hwState?.backlightPwm === 0 || (st.brightness ?? 100) === 100;
    kpiGrid.replaceChildren(
      kpiCard(
        'CS80 屏幕连接',
        up ? (st.standby ? '待机息屏' : '在线运行') : localizeDeviceState(st.device),
        up ? `USB ${st.usbSpeed ?? 480} Mbps · 局部刷新 ${stats.patchMs ?? 0}ms` : (st.lastError || '请插入 CS80 USB'),
        up ? 'positive' : 'warning',
      ),
      kpiCard(
        'F.R.I.D.A.Y. 状态',
        localizeBotState(st.botState),
        `阶段 ${localizeSubPhase(st.subPhase)} · 表情 ${localizeExpression(st.expression)}`,
        'accent',
      ),
      kpiCard(
        '亮度与防闪烁',
        `${st.brightness ?? 100}%`,
        pwmOff ? '软件 PWM 已关闭 (零频闪)' : 'PWM 调光中 (100% 最稳)',
        pwmOff ? 'positive' : 'default',
      ),
      kpiCard(
        '内置喇叭音控',
        spk.muted ? '已静音' : `${spk.volume ?? 65}%`,
        `夜间免打扰：${spk.quietHours || '未开启'}`,
        spk.muted ? 'warning' : 'default',
      ),
    );

    if (!isEditingWithin(panelEl)) {
      for (const btn of brightnessPillsEl.querySelectorAll<HTMLButtonElement>('button[data-brightness]')) {
        btn.classList.toggle('active', Number(btn.dataset.brightness) === (st.brightness ?? 100));
      }
      const volVal = String(Math.round(Number(spk.volume ?? 65)));
      if ([...volumeSelect.options].some(opt => opt.value === volVal)) {
        volumeSelect.value = volVal;
      }
      muteBtn.textContent = spk.muted ? '🔊 取消静音' : '🔇 静音切换';
      quietHoursInput.value = String(spk.quietHours || '');
    }
  }

  function renderGlobalControls(): void {
    if (!draftLayout) return;
    if (!isEditingWithin(panelEl)) {
      for (const btn of gridRowsPills.querySelectorAll<HTMLButtonElement>('button[data-grid-rows]')) {
        btn.classList.toggle('active', Number(btn.dataset.gridRows) === draftLayout.gridRows);
      }
      marqueeModeSelect.value = draftLayout.marqueeMode;
      marqueeSpeedSelect.value = String(draftLayout.marqueeSpeed);
      const rotStr = String(draftLayout.pageRotateSec);
      if ([...pageRotateSelect.options].some(o => o.value === rotStr)) {
        pageRotateSelect.value = rotStr;
      }
      weatherCityInput.value = draftLayout.weatherCity || '上海';
      taskOverlayCheck.checked = draftLayout.autoTaskOverlay;
    }
  }

  function renderPageTabsAndEditor(): void {
    if (!draftLayout) return;
    updateSyncBadge();
    const curPage = activePage();
    pageDelBtn.disabled = draftLayout.pages.length <= 1;

    // 1. Page tabs
    pageTabsEl.replaceChildren();
    draftLayout.pages.forEach((pg, idx) => {
      const btn = node('button', `${pg.name} (${pg.cards.length})`, `hub-filter-pill${idx === draftLayout!.activePage ? ' active' : ''}`);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (!draftLayout) return;
        draftLayout.activePage = idx;
        renderPageTabsAndEditor();
        void syncLayoutToDaemon({ activePage: idx });
      });
      pageTabsEl.append(btn);
    });

    // 2. Bento Editor Grid
    bentoEditorEl.replaceChildren();
    if (!curPage || curPage.cards.length === 0) {
      bentoEditorEl.append(node('p', '当前页为空。请从下方「＋ 添加插件 / 核心数据卡片」中选择卡片。', 'empty'));
      return;
    }

    const overflows = estimateOverflowFlags(curPage.cards, draftLayout.gridRows);
    const widgets = latestData?.widgets ?? {};

    curPage.cards.forEach((card, idx) => {
      const cat = catalogByKind(card.kind);
      const wKey = card.kind.startsWith('plugin:') ? `${card.kind}#${card.id}` : card.kind;
      const widgetData = widgets[wKey] ?? widgets[card.kind];
      const box = node('div', '', `cs80-editor-card cs80-span-${card.size}${overflows[idx] ? ' is-overflow' : ''}`);

      const head = node('div', '', 'cs80-editor-card-head');
      const titleText = card.title || cat?.title || card.kind;
      const titleEl = node('span', titleText, 'cs80-editor-card-title');
      const tagText = overflows[idx] ? '超出格数' : card.size;
      const tagEl = node('span', tagText, `hub-badge ${overflows[idx] ? 'badge-red' : 'badge-amber'}`);
      head.append(titleEl, tagEl);

      const valText = widgetData?.headline || '等待数据采集';
      const subText = widgetData?.subline || '';
      const valEl = node('div', valText, 'cs80-editor-card-value');
      const subEl = subText ? node('div', subText, 'cs80-editor-card-sub') : undefined;

      const tools = node('div', '', 'cs80-editor-card-tools');
      const sizeGroup = node('div', '', 'cs80-size-group');
      for (const sz of CARD_SIZES) {
        const sb = button(sz.replace('x', '×'), () => {
          card.size = sz;
          dirty = true;
          renderPageTabsAndEditor();
          void syncLayoutToDaemon({ pages: draftLayout!.pages, activePage: draftLayout!.activePage });
        }, `cs80-size-btn${card.size === sz ? ' active' : ''}`);
        sizeGroup.append(sb);
      }

      const moveGroup = node('div', '', 'cs80-move-group');
      const upBtn = button('↑', () => {
        if (idx <= 0) return;
        const arr = curPage.cards;
        [arr[idx - 1], arr[idx]] = [arr[idx]!, arr[idx - 1]!];
        dirty = true;
        renderPageTabsAndEditor();
        void syncLayoutToDaemon({ pages: draftLayout!.pages, activePage: draftLayout!.activePage });
      }, 'mini-button');
      upBtn.disabled = idx === 0;
      const downBtn = button('↓', () => {
        if (idx >= curPage.cards.length - 1) return;
        const arr = curPage.cards;
        [arr[idx], arr[idx + 1]] = [arr[idx + 1]!, arr[idx]!];
        dirty = true;
        renderPageTabsAndEditor();
        void syncLayoutToDaemon({ pages: draftLayout!.pages, activePage: draftLayout!.activePage });
      }, 'mini-button');
      downBtn.disabled = idx === curPage.cards.length - 1;
      const delBtn = button('✕', () => {
        curPage.cards.splice(idx, 1);
        dirty = true;
        renderPageTabsAndEditor();
        void syncLayoutToDaemon({ pages: draftLayout!.pages, activePage: draftLayout!.activePage });
      }, 'mini-button danger-btn');
      moveGroup.append(upBtn, downBtn, delBtn);
      tools.append(sizeGroup, moveGroup);

      if (subEl) box.append(head, valEl, subEl, tools);
      else box.append(head, valEl, tools);

      if (cat?.configurableAction || card.kind.startsWith('plugin:')) {
        const optsRow = node('div', '', 'cs80-custom-opts');
        const actionSel = document.createElement('select');
        actionSel.setAttribute('aria-label', `${titleText} 触发动作`);
        const pluginName = card.plugin || (card.kind.startsWith('plugin:') ? card.kind.slice('plugin:'.length) : undefined);
        const acts = cat?.actions?.length ? cat.actions : ['status', 'dashboard'];
        for (const a of acts) {
          const opt = document.createElement('option');
          opt.value = a;
          opt.textContent = `动作: ${localizeCardAction(a, pluginName)}`;
          actionSel.append(opt);
        }
        actionSel.value = card.action || cat?.defaultAction || acts[0]!;
        actionSel.addEventListener('change', () => {
          card.action = actionSel.value;
          dirty = true;
          updateSyncBadge();
          void syncLayoutToDaemon({ pages: draftLayout!.pages, refreshWidgets: true });
        });

        const ttlSel = document.createElement('select');
        ttlSel.setAttribute('aria-label', `${titleText} 轮询间隔`);
        for (const sec of [30, 60, 120, 300, 600]) {
          const opt = document.createElement('option');
          opt.value = String(sec);
          opt.textContent = `每 ${sec} 秒`;
          ttlSel.append(opt);
        }
        ttlSel.value = String(card.ttlSec ?? 120);
        ttlSel.addEventListener('change', () => {
          card.ttlSec = Number(ttlSel.value);
          dirty = true;
          updateSyncBadge();
          void syncLayoutToDaemon({ pages: draftLayout!.pages, refreshWidgets: true });
        });
        optsRow.append(actionSel, ttlSel);
        box.append(optsRow);
      }

      bentoEditorEl.append(box);
    });
  }

  function renderCatalogPicker(): void {
    const catalog = latestData?.catalog ?? [];
    const curPage = activePage();
    catalogMetaEl.textContent = `共 ${catalog.length} 个可用卡片源`;
    catalogPickerEl.replaceChildren();

    for (const item of catalog) {
      const card = node('div', '', 'cs80-catalog-item');
      const head = node('div', '', 'cs80-editor-card-head');
      const catLabel = item.category === 'core'
        ? '核心状态'
        : item.category === 'custom_plugin'
          ? '扩展插件'
          : '内置插件';
      const catTone = item.category === 'core'
        ? 'badge-slate'
        : item.category === 'custom_plugin'
          ? 'badge-purple'
          : 'badge-teal';
      head.append(
        node('span', item.title, 'cs80-catalog-title'),
        node('span', catLabel, `hub-badge ${catTone}`),
      );
      const addBtn = button('＋ 添加到此页', () => {
        if (!draftLayout) return;
        const page = activePage();
        if (!page) return;
        if (page.cards.length >= 8) {
          setBanner('单页最多配置 8 张卡片，可点击上方「＋ 新增页」拓展多屏轮播。', true);
          return;
        }
        const newCard: Cs80CardSpec = {
          id: `c-${Date.now().toString(36).slice(-5)}-${page.cards.length + 1}`,
          kind: item.kind,
          size: item.defaultSize || '1x1',
          ...(item.plugin ? { plugin: item.plugin } : {}),
          ...(item.defaultAction ? { action: item.defaultAction } : {}),
          ...(item.category === 'custom_plugin' ? { title: item.title, ttlSec: 120 } : {}),
        };
        page.cards.push(newCard);
        dirty = true;
        renderPageTabsAndEditor();
        void syncLayoutToDaemon({ pages: draftLayout.pages, activePage: draftLayout.activePage, refreshWidgets: true });
      }, 'mini-button');
      if (curPage && curPage.cards.some(c => c.kind === item.kind) && item.category !== 'custom_plugin') {
        addBtn.textContent = '＋ 再添一张';
      }
      card.append(head, addBtn);
      catalogPickerEl.append(card);
    }
  }

  function applyDashboardPayload(payload: Cs80DashboardPayload): void {
    latestData = payload;
    if (!dirty && payload.layout) {
      draftLayout = cloneLayout(payload.layout);
    } else if (!draftLayout && payload.layout) {
      draftLayout = cloneLayout(payload.layout);
    }
    if (payload.previewDataUrl) {
      livePreviewImg.src = payload.previewDataUrl;
      livePreviewImg.hidden = false;
      previewEmpty.hidden = true;
    }
    renderTelemetry(payload.status);
    renderGlobalControls();
    renderPageTabsAndEditor();
    renderCatalogPicker();
  }

  async function refreshDashboard(): Promise<void> {
    if (busy) return;
    try {
      const res = await callPlugin<Cs80DashboardPayload>('dashboard', { includePreview: true });
      if (res.ok && res.data) {
        setBanner('');
        applyDashboardPayload(res.data);
      } else {
        updateTopBadge(res.data?.status);
        setBanner(res.message || 'CS80 守护进程尚未响应，请确认 friday-face.service 已启动。', true);
      }
    } catch (err) {
      setBanner(`读取 CS80 副屏数据失败：${errorText(err)}`, true);
    }
  }

  async function syncLayoutToDaemon(patch?: Record<string, unknown>): Promise<void> {
    if (!draftLayout) return;
    busy = true;
    try {
      const payload = patch
        ? { ...patch, includePreview: true }
        : {
            gridRows: draftLayout.gridRows,
            marqueeMode: draftLayout.marqueeMode,
            marqueeSpeed: draftLayout.marqueeSpeed,
            pageRotateSec: draftLayout.pageRotateSec,
            autoTaskOverlay: draftLayout.autoTaskOverlay,
            activePage: draftLayout.activePage,
            weatherCity: weatherCityInput.value.trim() || draftLayout.weatherCity || '上海',
            pages: draftLayout.pages,
            refreshWidgets: true,
            includePreview: true,
          };
      const res = await callPlugin<{ ok?: boolean; layout?: Cs80LayoutConfig; previewDataUrl?: string }>('layout', payload);
      if (res.ok && res.data?.layout) {
        draftLayout = cloneLayout(res.data.layout);
        dirty = false;
        updateSyncBadge();
        if (res.data.previewDataUrl) {
          livePreviewImg.src = res.data.previewDataUrl;
          livePreviewImg.hidden = false;
          previewEmpty.hidden = true;
        }
        renderGlobalControls();
        renderPageTabsAndEditor();
        setBanner('');
      } else {
        setBanner(res.message || '同步副屏布局失败', true);
      }
    } catch (err) {
      setBanner(`同步副屏布局失败：${errorText(err)}`, true);
    } finally {
      busy = false;
    }
  }

  // ---- Wire Interactive Controls ----
  refreshBtn.addEventListener('click', () => {
    void refreshDashboard();
  });

  saveLayoutBtn.addEventListener('click', () => {
    if (!draftLayout) return;
    draftLayout.weatherCity = weatherCityInput.value.trim() || '上海';
    void syncLayoutToDaemon();
  });

  forceFullBtn.addEventListener('click', async () => {
    await callPlugin('screen', { refresh: true });
    await refreshDashboard();
  });

  standbyBtn.addEventListener('click', async () => {
    const curStandby = Boolean(latestData?.status?.standby);
    await callPlugin('screen', { standby: !curStandby });
    await refreshDashboard();
  });

  resetLayoutBtn.addEventListener('click', async () => {
    dirty = false;
    await callPlugin('layout', { reset: true, refreshWidgets: true, includePreview: true });
    await refreshDashboard();
  });

  gridRowsPills.addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-grid-rows]');
    if (!btn || !draftLayout) return;
    const rows = Number(btn.dataset.gridRows) === 3 ? 3 : 2;
    draftLayout.gridRows = rows;
    dirty = true;
    renderGlobalControls();
    renderPageTabsAndEditor();
    void syncLayoutToDaemon({ gridRows: rows });
  });

  marqueeModeSelect.addEventListener('change', () => {
    if (!draftLayout) return;
    draftLayout.marqueeMode = marqueeModeSelect.value as Cs80LayoutConfig['marqueeMode'];
    dirty = true;
    void syncLayoutToDaemon({ marqueeMode: draftLayout.marqueeMode });
  });

  marqueeSpeedSelect.addEventListener('change', () => {
    if (!draftLayout) return;
    const spd = Math.max(1, Math.min(3, Number(marqueeSpeedSelect.value) || 2)) as 1 | 2 | 3;
    draftLayout.marqueeSpeed = spd;
    dirty = true;
    void syncLayoutToDaemon({ marqueeSpeed: spd });
  });

  pageRotateSelect.addEventListener('change', () => {
    if (!draftLayout) return;
    draftLayout.pageRotateSec = Number(pageRotateSelect.value) || 0;
    dirty = true;
    void syncLayoutToDaemon({ pageRotateSec: draftLayout.pageRotateSec });
  });

  taskOverlayCheck.addEventListener('change', () => {
    if (!draftLayout) return;
    draftLayout.autoTaskOverlay = taskOverlayCheck.checked;
    dirty = true;
    void syncLayoutToDaemon({ autoTaskOverlay: draftLayout.autoTaskOverlay });
  });

  pageAddBtn.addEventListener('click', () => {
    if (!draftLayout) return;
    if (draftLayout.pages.length >= 6) {
      setBanner('最多支持配置 6 个轮播页签。', true);
      return;
    }
    const n = draftLayout.pages.length + 1;
    draftLayout.pages.push({
      id: `page-${Date.now().toString(36).slice(-4)}`,
      name: `副页 ${n}`,
      cards: [],
    });
    draftLayout.activePage = draftLayout.pages.length - 1;
    dirty = true;
    renderPageTabsAndEditor();
    void syncLayoutToDaemon({ pages: draftLayout.pages, activePage: draftLayout.activePage });
  });

  pageRenameBtn.addEventListener('click', () => {
    const pg = activePage();
    if (!draftLayout || !pg) return;
    const next = window.prompt('请输入当前卡片页名称：', pg.name);
    if (!next || !next.trim()) return;
    pg.name = next.trim().slice(0, 24);
    dirty = true;
    renderPageTabsAndEditor();
    void syncLayoutToDaemon({ pages: draftLayout.pages });
  });

  pageDelBtn.addEventListener('click', () => {
    if (!draftLayout || draftLayout.pages.length <= 1) return;
    draftLayout.pages.splice(draftLayout.activePage, 1);
    draftLayout.activePage = Math.max(0, Math.min(draftLayout.pages.length - 1, draftLayout.activePage));
    dirty = true;
    renderPageTabsAndEditor();
    void syncLayoutToDaemon({ pages: draftLayout.pages, activePage: draftLayout.activePage });
  });

  expressBtnsEl.addEventListener('click', async ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-expr]');
    if (!btn) return;
    const expr = btn.dataset.expr || 'auto';
    const poke = btn.dataset.poke || undefined;
    const channel = btn.dataset.channel || undefined;
    await callPlugin('express', {
      expr,
      ...(poke ? { poke } : {}),
      ...(channel ? { channel } : {}),
      holdSec: expr === 'auto' ? 0 : 8,
    });
    setTimeout(() => {
      if (options.isVisible()) void refreshDashboard();
    }, 220);
  });

  bannerSendBtn.addEventListener('click', async () => {
    const text = bannerInput.value.trim();
    if (!text) return;
    await callPlugin('express', { text, title: '控制台 · 互动消息', holdSec: 14 });
    bannerInput.value = '';
    setTimeout(() => {
      if (options.isVisible()) void refreshDashboard();
    }, 180);
  });

  brightnessPillsEl.addEventListener('click', async ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-brightness]');
    if (!btn) return;
    const val = Number(btn.dataset.brightness) || 100;
    await callPlugin('screen', { brightness: val });
    await refreshDashboard();
  });

  volumeSelect.addEventListener('change', async () => {
    await callPlugin('sound', { volume: Number(volumeSelect.value) });
    await refreshDashboard();
  });

  muteBtn.addEventListener('click', async () => {
    const nextMute = !(latestData?.status?.speaker?.muted ?? false);
    await callPlugin('sound', { muted: nextMute });
    await refreshDashboard();
  });

  quietSaveBtn.addEventListener('click', async () => {
    await callPlugin('sound', {
      volume: Number(volumeSelect.value),
      quietHours: quietHoursInput.value.trim(),
    });
    await refreshDashboard();
  });

  chimeBtnsEl.addEventListener('click', async ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-chime]');
    if (!btn) return;
    const chime = btn.dataset.chime || 'wake';
    const res = await callPlugin('sound', { chime, force: true });
    if (!res.ok) setBanner(res.message || '喇叭试音失败', true);
  });

  return {
    activate() {
      active = true;
      dirty = false;
      void refreshDashboard();
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        if (active && options.isVisible() && autoPreviewCheck.checked && !isEditingWithin(panelEl)) {
          void refreshDashboard();
        }
      }, 3500);
    },
    deactivate() {
      active = false;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
    },
    async refreshBadge() {
      try {
        const res = await callPlugin<Cs80StatusData>('status');
        if (res.data) updateTopBadge(res.data);
      } catch {
        topBadge.textContent = '—';
      }
    },
  };
}

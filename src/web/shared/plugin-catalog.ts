import type { PluginActionSpec, PluginView, TimerView } from '../../view.js';
import { node, svgNode } from './dom.js';
import { announceStatus, attachDelayedFormValidation, safeFocus } from './ui-primitives.js';

export const PLUGIN_SIDEBAR_COLLAPSED_KEY = 'friday.plugin-sidebar-collapsed';
export const PLUGIN_ORDER_STORAGE_KEY = 'friday.plugin-order';
export const PLUGIN_PREFS_CHANNEL_NAME = 'friday.plugin-ui-prefs';

export type PluginCatalogFilter = 'all' | 'surface' | 'extension' | 'voice' | 'timer';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export interface PluginPresentationMeta {
  shortTitle: string;
  domain: string;
  summary: string;
  quickCheckArgs?: Record<string, unknown>;
}

export interface PluginStatusInfo {
  tone: 'green' | 'amber' | 'slate';
  label: string;
  detail: string;
}

export interface ClassifiedPluginActions {
  all: PluginActionSpec[];
  primary: PluginActionSpec[];
  management: PluginActionSpec[];
}

export interface ReadableParamPill {
  key: string;
  label: string;
  value: string;
}

export interface PluginCatalogFilterCounts {
  all: number;
  surface: number;
  extension: number;
  voice: number;
  timer: number;
}

export interface PluginCatalogFilteredResult {
  counts: PluginCatalogFilterCounts;
  grouped: boolean;
  surfaces: PluginView[];
  extensions: PluginView[];
  items: PluginView[];
}

const INTERNAL_ACTION_NAMES: ReadonlySet<string> = new Set([
  'dashboard',
  'config',
  'init',
  'login',
  'logout',
  'auth-login',
  'auth-verify',
  'auth-sms',
  'measure-status',
  'measure-stop',
  'monitor-status',
  'monitor-stop',
  'pending-clear',
  'profile-save',
  'profile-delete',
  'record-add',
  'record-delete',
  'session-add',
  'session-delete',
  'add-holding',
  'remove-holding',
  'set-holding',
  'queue',
  'playlist',
  'downloads',
  'delete-track',
  'search-online',
]);

const SAFE_QUICK_RUN_ACTIONS: ReadonlySet<string> = new Set([
  'status',
  'dashboard',
  'mesh',
  'geek',
  'scene',
  'devices',
  'keys',
  'vehicles',
  'trips',
  'patrol',
  'charge-check',
  'scan',
  'tree',
  'tracks',
]);

const ACTION_FALLBACK_LABELS: Record<string, string> = {
  status: '实时状态',
  dashboard: '看板概览',
  mesh: 'Mesh 中枢',
  geek: '极客自动化',
  scene: '本地场景',
  patrol: '安全巡检',
  remind: '准点提醒',
  noon: '午间估值',
  settle: '晚间结算',
  devices: '设备列表',
  scan: '扫描发现',
  locate: '设备定位',
  'play-sound': '响铃寻物',
  trips: '骑行行程',
  vehicles: '车辆列表',
  'charge-check': '电量巡检',
  sync: '唤醒同步',
  config: '参数配置',
  on: '临时开灯',
  off: '临时关灯',
  resume: '恢复行程',
  power: '电源控制',
  volume: '音量控制',
  cast: '投屏控制',
  open_app: '打开应用',
  tree: '界面结构',
  screenshot: '屏幕截图',
  act: '界面操作',
  navigate: '智能导航',
  keys: '按键列表',
  press: '遥控按键',
  sequence: '组合按键',
  learn: '红外学习',
  get: '单设备状态',
  set: '设备控制',
  cook: '烹饪控制',
  action: '底层动作',
  command: '语音指令',
  'measure-start': '上秤测量',
  'monitor-start': '刷牙监听',
  'watch-start': '自动唤醒',
  'watch-stop': '停止唤醒',
  'brushhead-reset': '重置刷头',
  tracks: '曲库检索',
  play: '点歌播放',
  pause: '暂停播放',
  stop: '停止播放',
  next: '下一首',
  prev: '上一首',
  loop: '循环模式',
  timer: '睡眠定时',
  queue: '播放队列',
  playlist: '歌单管理',
  'search-online': '在线搜歌',
  download: '下载音乐',
  downloads: '下载记录',
  'delete-track': '删除曲目',
};

const PARAM_KEY_LABELS: Record<string, string> = {
  refresh: '实时刷新',
  live: '实时读取',
  offline: '仅读缓存',
  cacheOnly: '仅读缓存',
  dryRun: '预演模式',
  device: '目标设备',
  timeoutSec: '超时',
  timeoutMs: '超时',
  limit: '条数',
  mode: '模式',
  key: '按键',
  keys: '按键序列',
  count: '连发次数',
  intervalMs: '间隔',
  on: '开关',
  state: '目标状态',
  op: '操作',
  app: '应用',
  goal: '导航目标',
  maxSteps: '最大步数',
  settleMs: '等待稳定',
  maxNodes: '节点上限',
  maxWidth: '最大宽度',
  quality: '画质',
  action: '动作',
  text: '内容',
  region: '区域',
  durationSec: '时长',
  note: '备注',
  expr: '表情',
  poke: '互动动画',
  holdSec: '持续',
  chime: '提示音',
  brightness: '亮度',
  bind: '自动绑定',
  code: '代码',
  name: '名称',
  cost: '成本',
  shares: '份额',
  initNav: '初始净值',
  navDate: '净值日期',
  waitMs: '等待上线',
  maxLoadPerCore: '单核负载阈值',
  maxMemUsedPct: '内存阈值',
  minDiskFreeGb: '磁盘余量下限',
  siid: '服务 ID',
  aiid: '动作 ID',
  graphId: '规则 ID',
  scope: '作用域',
  confirmProtected: '确认保护设备',
  includeProtected: '包含保护设备',
  query: '关键词',
  url: '链接',
  source: '音源',
  trackId: '曲目 ID',
  playlistId: '歌单 ID',
  volume: '音量',
  minutes: '分钟',
  shuffle: '随机播放',
  playAfter: '下载后播放',
  quick: '快速扫描',
};

const PLATFORM_LABELS: Record<string, string> = {
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
};

export const PLUGIN_PRESENTATION: Record<string, PluginPresentationMeta> = {
  'health-scale': {
    shortTitle: '健康管理 · 沃莱 A1',
    domain: '健康硬件',
    summary: '蓝牙直连沃莱 A1 体脂秤，采集实时体重与双频阻抗，生成人体成分分析与多成员趋势档案。',
    quickCheckArgs: {},
  },
  'fund-tracker': {
    shortTitle: '投资管理 · 基金持仓',
    domain: '资产金融',
    summary: '管理个人基金持仓，提供交易日午间盘中估值、晚间正式净值结算与历史收益走势。',
    quickCheckArgs: {},
  },
  'cs80-face': {
    shortTitle: 'CS80 实体副屏',
    domain: '桌面外设',
    summary: '控制本地 CS80 桌面副屏的动态表情、Bento 插件卡片编排、屏幕亮度与内置喇叭提示音。',
    quickCheckArgs: {},
  },
  laifen: {
    shortTitle: '口腔护理 · 徕芬牙刷',
    domain: '健康硬件',
    summary: '蓝牙同步徕芬扫振电动牙刷电量、1~4 档三维扫振参数、刷牙实时打卡与刷头更换寿命。',
    quickCheckArgs: { live: false },
  },
  ninebot: {
    shortTitle: '九号守护 · 智能电摩',
    domain: '出行设备',
    summary: '只读监控九号电摩电量、72V BMS 电池状态、精准续航、停放位置与骑行行程，支持主动安全巡检。',
    quickCheckArgs: { offline: true },
  },
  netlea: {
    shortTitle: '鱼缸灯光 · 尼特利',
    domain: '智能家居',
    summary: '蓝牙短连接控制尼特利鱼缸灯，支持四通道光谱调光、观赏预设、临时开关与恢复 24h 自动行程。',
    quickCheckArgs: { live: false },
  },
  'apple-devices': {
    shortTitle: '苹果设备 · Find My',
    domain: '个人设备',
    summary: '支持国区/国际区 iCloud 查找，查看名下苹果设备实时电量、地点围栏、远程响铃寻物与低电巡航。',
    quickCheckArgs: { cacheOnly: true },
  },
  miot: {
    shortTitle: '米家中枢 · Mesh & 极客版',
    domain: '智能家居',
    summary: 'BE6500 Pro 蓝牙 Mesh 中枢直控、全屋设备状态、米家自动化极客版规则/日志/变量与本地场景管理。',
    quickCheckArgs: {},
  },
  'tv-agent': {
    shortTitle: '智能电视 Agent',
    domain: '智能家居',
    summary: '局域网精确控制红米/小米电视：幂等开关机、精确音量、DLNA 投屏、应用启动与多步视觉导航。',
    quickCheckArgs: {},
  },
  'tv-ir': {
    shortTitle: '电视红外遥控',
    domain: '智能家居',
    summary: '通过小爱音箱内置红外毫秒级操控电视方向、音量、电源与组合按键序列，支持物理遥控学习。',
    quickCheckArgs: {},
  },
  'system-pulse': {
    shortTitle: '主机与仓库脉搏',
    domain: '系统运维',
    summary: '零依赖监测主机 CPU/内存/磁盘余量与 Git 仓库状态，支持异常阈值静默巡航与零 Token 准点提醒。',
    quickCheckArgs: {},
  },
  music: {
    shortTitle: '音乐点播 · 小爱曲库',
    domain: '影音娱乐',
    summary: '管理本地音乐曲库与歌单，支持 yt-dlp 在线搜歌下载、网页试听上传，并推送小爱音箱 LX06 连播与语音快控。',
    quickCheckArgs: { live: false },
  },
};

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

export function readSidebarCollapsed(storage: StorageLike | undefined = defaultStorage()): boolean | null {
  try {
    if (!storage) return null;
    const raw = storage.getItem(PLUGIN_SIDEBAR_COLLAPSED_KEY);
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    return null;
  } catch {
    return null;
  }
}

export function writeSidebarCollapsed(collapsed: boolean, storage: StorageLike | undefined = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(PLUGIN_SIDEBAR_COLLAPSED_KEY, String(collapsed));
    return true;
  } catch {
    return false;
  }
}

export function readPluginOrder(storage: StorageLike | undefined = defaultStorage()): string[] {
  try {
    if (!storage) return [];
    const raw = storage.getItem(PLUGIN_ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const clean = item.trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
    }
    return out;
  } catch {
    return [];
  }
}

export function writePluginOrder(order: readonly string[], storage: StorageLike | undefined = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    const clean = [...new Set(order.map(item => item.trim()).filter(Boolean))];
    storage.setItem(PLUGIN_ORDER_STORAGE_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

export function clearPluginOrder(storage: StorageLike | undefined = defaultStorage()): boolean {
  try {
    if (!storage) return false;
    if (typeof storage.removeItem === 'function') {
      storage.removeItem(PLUGIN_ORDER_STORAGE_KEY);
    } else {
      storage.setItem(PLUGIN_ORDER_STORAGE_KEY, '[]');
    }
    return true;
  } catch {
    return false;
  }
}

export interface PluginPrefsSyncHandle {
  broadcastCollapsed: (collapsed: boolean) => void;
  broadcastOrder: (order: readonly string[]) => void;
  close: () => void;
}

export function createPluginPrefsSync(handlers: {
  onCollapsed?: (collapsed: boolean) => void;
  onOrder?: (order: string[]) => void;
  signal?: AbortSignal;
}): PluginPrefsSyncHandle {
  let channel: BroadcastChannel | undefined;
  if (typeof BroadcastChannel === 'function' && !handlers.signal?.aborted) {
    try {
      const bc = new BroadcastChannel(PLUGIN_PREFS_CHANNEL_NAME);
      const unref = (bc as unknown as { unref?: () => void }).unref;
      if (typeof unref === 'function') unref.call(bc);
      bc.onmessage = (event: MessageEvent) => {
        const payload = event?.data as { type?: string; collapsed?: unknown; order?: unknown } | undefined;
        if (!payload || typeof payload !== 'object') return;
        if (payload.type === 'collapsed' && typeof payload.collapsed === 'boolean') {
          handlers.onCollapsed?.(payload.collapsed);
        } else if (payload.type === 'order' && Array.isArray(payload.order)) {
          const valid = payload.order.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
          handlers.onOrder?.(valid);
        }
      };
      channel = bc;
    } catch {
      // Ignore BroadcastChannel errors in restricted environments.
    }
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key === PLUGIN_SIDEBAR_COLLAPSED_KEY) {
      const next = readSidebarCollapsed();
      if (next !== null) handlers.onCollapsed?.(next);
    } else if (event.key === PLUGIN_ORDER_STORAGE_KEY) {
      handlers.onOrder?.(readPluginOrder());
    } else if (event.key === null) {
      const next = readSidebarCollapsed();
      if (next !== null) handlers.onCollapsed?.(next);
      handlers.onOrder?.(readPluginOrder());
    }
  };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && !handlers.signal?.aborted) {
    if (handlers.signal) {
      window.addEventListener('storage', onStorage, { signal: handlers.signal });
    } else {
      window.addEventListener('storage', onStorage);
    }
  }

  const close = () => {
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('storage', onStorage);
    }
    try {
      channel?.close();
    } catch {
      // Ignore close errors.
    }
    channel = undefined;
  };
  handlers.signal?.addEventListener('abort', close, { once: true });

  return {
    broadcastCollapsed(collapsed: boolean) {
      try {
        channel?.postMessage({ type: 'collapsed', collapsed });
      } catch {
        // Ignore closed channel errors.
      }
    },
    broadcastOrder(order: readonly string[]) {
      try {
        channel?.postMessage({ type: 'order', order: [...order] });
      } catch {
        // Ignore closed channel errors.
      }
    },
    close,
  };
}

/**
 * Reconciles a persisted plugin order against the currently available plugin names:
 * - Preserves relative order of known plugins from `savedOrder`
 * - Appends newly installed/unlisted plugins at the end in their default order
 * - Ignores names not present in `currentNames`
 */
export function mergePluginOrder(
  savedOrder: readonly string[],
  currentNames: readonly string[],
): string[] {
  const currentSet = new Set(currentNames);
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const name of savedOrder) {
    if (!currentSet.has(name) || seen.has(name)) continue;
    seen.add(name);
    merged.push(name);
  }
  for (const name of currentNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    merged.push(name);
  }
  return merged;
}

/**
 * Reorders `draggedName` before or after `targetName` inside `baseOrder`
 * while preserving hidden/disabled entries that live in `baseOrder`.
 */
export function reorderPluginList(
  baseOrder: readonly string[],
  draggedName: string,
  targetName: string,
  position: 'before' | 'after',
): string[] {
  if (!draggedName || !targetName || draggedName === targetName) return [...baseOrder];
  const unique = [...new Set(baseOrder)];
  if (!unique.includes(draggedName)) unique.push(draggedName);
  if (!unique.includes(targetName)) return unique;

  const withoutDragged = unique.filter(name => name !== draggedName);
  const targetIdx = withoutDragged.indexOf(targetName);
  if (targetIdx < 0) return unique;
  const insertAt = position === 'after' ? targetIdx + 1 : targetIdx;
  withoutDragged.splice(insertAt, 0, draggedName);
  return withoutDragged;
}

/**
 * Moves `name` by one visible step (-1 up, +1 down) within `visibleNames`,
 * returning an updated full order that retains hidden items untouched.
 */
export function movePluginStep(
  baseOrder: readonly string[],
  visibleNames: readonly string[],
  name: string,
  delta: -1 | 1,
): string[] {
  const orderedVisible = mergePluginOrder(baseOrder, visibleNames);
  const idx = orderedVisible.indexOf(name);
  const swapIdx = idx + delta;
  if (idx < 0 || swapIdx < 0 || swapIdx >= orderedVisible.length) return [...baseOrder];
  const targetName = orderedVisible[swapIdx]!;
  return reorderPluginList(
    [...new Set([...baseOrder, ...orderedVisible])],
    name,
    targetName,
    delta < 0 ? 'before' : 'after',
  );
}

export function isCustomOrder(
  savedOrder: readonly string[],
  defaultNames: readonly string[],
): boolean {
  if (!savedOrder.length || defaultNames.length <= 1) return false;
  const effective = mergePluginOrder(savedOrder, defaultNames);
  if (effective.length !== defaultNames.length) return true;
  return effective.some((name, index) => name !== defaultNames[index]);
}

export function resolvePluginActionLabel(specs: readonly PluginActionSpec[], actionName: string): string {
  const matched = specs.find(spec => spec.name === actionName);
  if (matched?.label) return matched.label;
  return ACTION_FALLBACK_LABELS[actionName] ?? actionName;
}

export function getPluginDisplayTitle(plugin: PluginView): string {
  const meta = PLUGIN_PRESENTATION[plugin.name];
  if (meta) return meta.shortTitle;
  return plugin.title || plugin.name;
}

export function getPluginDomainLabel(plugin: PluginView, hasSurface: boolean): string {
  const meta = PLUGIN_PRESENTATION[plugin.name];
  if (meta) return meta.domain;
  return hasSurface ? '专属应用' : '自定义扩展';
}

export function getPluginQuickCheckArgs(pluginName: string): Record<string, unknown> {
  return { ...(PLUGIN_PRESENTATION[pluginName]?.quickCheckArgs ?? {}) };
}

export function cleanPluginText(raw: string): string {
  return raw
    .replace(/<pluginDataDir>\/[^\s，。；,;()（）]+/g, '插件本地配置')
    .replace(/~\/\.friday\/[^\s，。；,;()（）]+/g, '本地数据目录')
    .replace(/（[^（）]*0600[^（）]*）/g, '')
    .replace(/\([^()]*0600[^()]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getPluginSummary(plugin: PluginView): string {
  const meta = PLUGIN_PRESENTATION[plugin.name];
  if (meta) return meta.summary;
  const candidate = cleanPluginText(plugin.promptHint || plugin.description || '');
  if (!candidate) return '已安装的功能扩展插件，支持在对话、定时任务或调试台中调用。';
  if (candidate.length <= 92) return candidate;
  const firstSentence = candidate.split(/[。！？]/)[0]?.trim();
  if (firstSentence && firstSentence.length >= 16 && firstSentence.length <= 92) {
    return `${firstSentence}。`;
  }
  return `${candidate.slice(0, 88).trim()}…`;
}

export function formatRuntimeLabel(runtime?: string): string {
  if (runtime === 'in-process') return '进程内直连';
  if (runtime === 'subprocess') return '独立子进程';
  return '标准运行';
}

export function formatPlatformsLabel(platforms?: readonly string[]): string {
  if (!platforms || platforms.length === 0) return '全平台通用';
  return platforms.map(p => PLATFORM_LABELS[p] ?? p).join(' / ');
}

export function getPluginStatusInfo(plugin: PluginView): PluginStatusInfo {
  if (plugin.enabled !== false) {
    return {
      tone: 'green',
      label: '已启用',
      detail: plugin.platforms?.length
        ? `当前平台可用（支持 ${formatPlatformsLabel(plugin.platforms)}）`
        : '当前运行环境可用',
    };
  }
  if (plugin.platforms && plugin.platforms.length > 0) {
    const platText = formatPlatformsLabel(plugin.platforms);
    return {
      tone: 'amber',
      label: `仅限 ${platText}`,
      detail: `该插件依赖 ${platText} 系统能力，在当前操作系统下已自动关闭`,
    };
  }
  return {
    tone: 'slate',
    label: '已禁用',
    detail: '该插件已在插件清单中关闭',
  };
}

export function getPluginSpecs(plugin: PluginView): PluginActionSpec[] {
  if (plugin.actionSpecs && plugin.actionSpecs.length > 0) {
    return plugin.actionSpecs;
  }
  return (plugin.actions ?? []).map(name => ({ name }));
}

export function classifyPluginActions(plugin: PluginView): ClassifiedPluginActions {
  const all = getPluginSpecs(plugin);
  const primary: PluginActionSpec[] = [];
  const management: PluginActionSpec[] = [];
  for (const spec of all) {
    if (INTERNAL_ACTION_NAMES.has(spec.name)) {
      management.push(spec);
    } else {
      primary.push(spec);
    }
  }
  if (primary.length === 0) {
    return { all, primary: [...all], management: [] };
  }
  return { all, primary, management };
}

export function isSafeQuickRunAction(actionName: string): boolean {
  return SAFE_QUICK_RUN_ACTIONS.has(actionName);
}

function formatParamValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '待填写';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') {
    if (key.endsWith('Sec')) return `${value} 秒`;
    if (key.endsWith('Ms')) return `${value} ms`;
    if (key.endsWith('Pct')) return `${value}%`;
    if (key.endsWith('Gb')) return `${value} GB`;
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length ? value.map(item => String(item)).join(' → ') : '空列表';
  }
  if (typeof value === 'object') {
    return '自定义对象';
  }
  return String(value);
}

export function formatActionDefaultArgs(
  defaultArgs?: Record<string, unknown>,
): ReadableParamPill[] {
  if (!defaultArgs) return [];
  const entries = Object.entries(defaultArgs);
  if (entries.length === 0) return [];
  return entries.map(([key, value]) => ({
    key,
    label: PARAM_KEY_LABELS[key] ?? key,
    value: formatParamValue(key, value),
  }));
}

export function summarizePluginRunMessage(message: string, maxLen = 140): string {
  const trimmed = (message || '').trim();
  if (!trimmed) return '执行完成，无附加输出。';
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return '已返回结构化状态数据，点击「查看详情」检视完整内容。';
  }
  const compact = trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' · ');
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 1).trim()}…`;
}

export function filterAndGroupPlugins(options: {
  plugins: readonly PluginView[];
  timers: readonly TimerView[];
  surfaceNames: ReadonlySet<string>;
  order: readonly string[];
  filter: PluginCatalogFilter;
  query: string;
}): PluginCatalogFilteredResult {
  const { plugins, timers, surfaceNames, order, filter, query } = options;
  const orderedNames = mergePluginOrder(order, plugins.map(p => p.name));
  const byName = new Map(plugins.map(p => [p.name, p]));
  const orderedPlugins = orderedNames
    .map(name => byName.get(name))
    .filter((p): p is PluginView => Boolean(p));

  const timerPluginNames = new Set(
    timers.map(t => t.plugin).filter((name): name is string => Boolean(name)),
  );

  const counts: PluginCatalogFilterCounts = {
    all: orderedPlugins.length,
    surface: orderedPlugins.filter(p => surfaceNames.has(p.name)).length,
    extension: orderedPlugins.filter(p => !surfaceNames.has(p.name)).length,
    voice: orderedPlugins.filter(p => Boolean(p.voiceFastpath)).length,
    timer: orderedPlugins.filter(p => timerPluginNames.has(p.name)).length,
  };

  const q = query.trim().toLowerCase();
  const matchesFilter = (plugin: PluginView): boolean => {
    switch (filter) {
      case 'surface': return surfaceNames.has(plugin.name);
      case 'extension': return !surfaceNames.has(plugin.name);
      case 'voice': return Boolean(plugin.voiceFastpath);
      case 'timer': return timerPluginNames.has(plugin.name);
      default: return true;
    }
  };

  const matchesQuery = (plugin: PluginView): boolean => {
    if (!q) return true;
    const specs = getPluginSpecs(plugin);
    const haystack = [
      plugin.name,
      plugin.title,
      getPluginDisplayTitle(plugin),
      getPluginDomainLabel(plugin, surfaceNames.has(plugin.name)),
      getPluginSummary(plugin),
      plugin.promptHint ?? '',
      plugin.description ?? '',
      ...specs.flatMap(spec => [spec.name, spec.label ?? '', spec.description ?? '']),
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  };

  const filtered = orderedPlugins.filter(p => matchesFilter(p) && matchesQuery(p));
  const grouped = filter === 'all' && !q;
  const surfaces = filtered.filter(p => surfaceNames.has(p.name));
  const extensions = filtered.filter(p => !surfaceNames.has(p.name));

  return {
    counts,
    grouped,
    surfaces,
    extensions,
    items: filtered,
  };
}

type SvgShape =
  | { tag: 'path'; d: string }
  | { tag: 'rect'; x: string; y: string; width: string; height: string; rx?: string }
  | { tag: 'circle'; cx: string; cy: string; r: string }
  | { tag: 'line'; x1: string; y1: string; x2: string; y2: string }
  | { tag: 'polyline'; points: string };

const PLUGIN_ICON_SHAPES: Record<string, SvgShape[]> = {
  catalog: [
    { tag: 'rect', x: '3', y: '3', width: '7', height: '7', rx: '1.5' },
    { tag: 'rect', x: '14', y: '3', width: '7', height: '7', rx: '1.5' },
    { tag: 'rect', x: '3', y: '14', width: '7', height: '7', rx: '1.5' },
    { tag: 'rect', x: '14', y: '14', width: '7', height: '7', rx: '1.5' },
  ],
  'health-scale': [
    { tag: 'path', d: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z' },
    { tag: 'path', d: 'M7 11h2.5l1.5-2.5 2 5 1.5-2.5H17' },
  ],
  'fund-tracker': [
    { tag: 'polyline', points: '22 7 13.5 15.5 8.5 10.5 2 17' },
    { tag: 'polyline', points: '16 7 22 7 22 13' },
    { tag: 'line', x1: '3', y1: '21', x2: '21', y2: '21' },
  ],
  'cs80-face': [
    { tag: 'rect', x: '2', y: '4', width: '20', height: '14', rx: '2.5' },
    { tag: 'line', x1: '8', y1: '21', x2: '16', y2: '21' },
    { tag: 'line', x1: '12', y1: '18', x2: '12', y2: '21' },
    { tag: 'circle', cx: '9', cy: '10', r: '1' },
    { tag: 'circle', cx: '15', cy: '10', r: '1' },
    { tag: 'path', d: 'M9.5 13.5c.8.8 1.6 1.2 2.5 1.2s1.7-.4 2.5-1.2' },
  ],
  laifen: [
    { tag: 'path', d: 'M12 3v18' },
    { tag: 'path', d: 'M9 6h6' },
    { tag: 'path', d: 'M9 9h6' },
    { tag: 'path', d: 'M5.5 8.5a4 4 0 0 0 0 5' },
    { tag: 'path', d: 'M18.5 8.5a4 4 0 0 1 0 5' },
    { tag: 'rect', x: '10', y: '13', width: '4', height: '8', rx: '1.5' },
  ],
  ninebot: [
    { tag: 'circle', cx: '6.5', cy: '17.5', r: '3' },
    { tag: 'circle', cx: '17.5', cy: '17.5', r: '3' },
    { tag: 'path', d: 'M6.5 14.5 9 9h5l2.5 5.5' },
    { tag: 'path', d: 'M14 9 15.5 5H18' },
    { tag: 'path', d: 'M9.5 17.5h5' },
  ],
  netlea: [
    { tag: 'circle', cx: '12', cy: '8', r: '3' },
    { tag: 'path', d: 'M12 2v1.5' },
    { tag: 'path', d: 'm5.8 5.2 1.1 1.1' },
    { tag: 'path', d: 'm18.2 5.2-1.1 1.1' },
    { tag: 'path', d: 'M3 16c1.8-1.4 3.6-1.4 5.4 0 1.8 1.4 3.6 1.4 5.4 0 1.8-1.4 3.6-1.4 5.4 0' },
    { tag: 'path', d: 'M3 20c1.8-1.4 3.6-1.4 5.4 0 1.8 1.4 3.6 1.4 5.4 0 1.8-1.4 3.6-1.4 5.4 0' },
  ],
  'apple-devices': [
    { tag: 'rect', x: '6', y: '2.5', width: '12', height: '19', rx: '2.5' },
    { tag: 'line', x1: '10.5', y1: '18.5', x2: '13.5', y2: '18.5' },
    { tag: 'circle', cx: '12', cy: '10', r: '2.2' },
    { tag: 'path', d: 'M9.2 7.2a4 4 0 0 1 5.6 0' },
  ],
  miot: [
    { tag: 'path', d: 'M3 10.5 12 3l9 7.5' },
    { tag: 'path', d: 'M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5' },
    { tag: 'path', d: 'M9.5 15a3.5 3.5 0 0 1 5 0' },
    { tag: 'circle', cx: '12', cy: '17.5', r: '0.8' },
  ],
  'tv-agent': [
    { tag: 'rect', x: '2.5', y: '4', width: '19', height: '13', rx: '2' },
    { tag: 'line', x1: '8', y1: '21', x2: '16', y2: '21' },
    { tag: 'path', d: 'm10.5 8.5 4 2.5-4 2.5Z' },
  ],
  'tv-ir': [
    { tag: 'rect', x: '7.5', y: '4', width: '9', height: '17', rx: '2.5' },
    { tag: 'circle', cx: '12', cy: '9.5', r: '1.6' },
    { tag: 'line', x1: '10', y1: '14.5', x2: '14', y2: '14.5' },
    { tag: 'line', x1: '10', y1: '17.5', x2: '14', y2: '17.5' },
    { tag: 'path', d: 'M9 2.2a4.5 4.5 0 0 1 6 0' },
  ],
  'system-pulse': [
    { tag: 'polyline', points: '2 12 6 12 9 4 14 20 17 12 22 12' },
  ],
  default: [
    { tag: 'path', d: 'M12 22v-5' },
    { tag: 'path', d: 'M9 8V2' },
    { tag: 'path', d: 'M15 8V2' },
    { tag: 'path', d: 'M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z' },
  ],
};

const UI_ICON_SHAPES: Record<string, SvgShape[]> = {
  'sidebar-collapse': [
    { tag: 'rect', x: '3', y: '3', width: '18', height: '18', rx: '2.5' },
    { tag: 'line', x1: '9', y1: '3', x2: '9', y2: '21' },
    { tag: 'polyline', points: '15 9 12 12 15 15' },
  ],
  'sidebar-expand': [
    { tag: 'rect', x: '3', y: '3', width: '18', height: '18', rx: '2.5' },
    { tag: 'line', x1: '9', y1: '3', x2: '9', y2: '21' },
    { tag: 'polyline', points: '13 9 16 12 13 15' },
  ],
  grip: [
    { tag: 'circle', cx: '9', cy: '6', r: '1' },
    { tag: 'circle', cx: '15', cy: '6', r: '1' },
    { tag: 'circle', cx: '9', cy: '12', r: '1' },
    { tag: 'circle', cx: '15', cy: '12', r: '1' },
    { tag: 'circle', cx: '9', cy: '18', r: '1' },
    { tag: 'circle', cx: '15', cy: '18', r: '1' },
  ],
  reset: [
    { tag: 'path', d: 'M3 12a9 9 0 1 0 3-6.7L3 8' },
    { tag: 'polyline', points: '3 3 3 8 8 8' },
  ],
  back: [
    { tag: 'polyline', points: '15 18 9 12 15 6' },
  ],
};

function buildSvgFromShapes(shapes: readonly SvgShape[], className: string, size = 18): SVGSVGElement {
  const svg = svgNode('svg', {
    class: className,
    width: String(size),
    height: String(size),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.85',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  });
  for (const shape of shapes) {
    if (shape.tag === 'path') {
      svg.append(svgNode('path', { d: shape.d }));
    } else if (shape.tag === 'rect') {
      svg.append(svgNode('rect', {
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
        ...(shape.rx ? { rx: shape.rx } : {}),
      }));
    } else if (shape.tag === 'circle') {
      svg.append(svgNode('circle', { cx: shape.cx, cy: shape.cy, r: shape.r }));
    } else if (shape.tag === 'line') {
      svg.append(svgNode('line', { x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2 }));
    } else if (shape.tag === 'polyline') {
      svg.append(svgNode('polyline', { points: shape.points }));
    }
  }
  return svg;
}

export function createPluginIconSvg(pluginName: string, className = 'plugin-svg-icon', size = 18): SVGSVGElement {
  const shapes = PLUGIN_ICON_SHAPES[pluginName] ?? PLUGIN_ICON_SHAPES.default!;
  return buildSvgFromShapes(shapes, className, size);
}

export function createUiIconSvg(
  kind: 'sidebar-collapse' | 'sidebar-expand' | 'grip' | 'reset' | 'back',
  className = 'plugin-ui-svg',
  size = 16,
): SVGSVGElement {
  const shapes = UI_ICON_SHAPES[kind] ?? UI_ICON_SHAPES['sidebar-collapse']!;
  return buildSvgFromShapes(shapes, className, size);
}

/**
 * Escapes arbitrary strings for CSS attribute selectors in both real browsers and FakeDOM.
 */
export function cssEscapeValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * Safely checks `document.hidden` across real browsers and Node environments.
 */
export function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && Boolean(document.hidden);
}

function isFocusableCandidate(el: HTMLElement): boolean {
  if ((el as { hidden?: unknown }).hidden === true || el.hasAttribute?.('hidden')) return false;
  if ((el as { disabled?: unknown }).disabled === true || el.hasAttribute?.('disabled')) return false;
  if (el.getAttribute?.('tabindex') === '-1') return false;
  return true;
}

/**
 * Replaces `container`'s children while preserving keyboard focus by `data-focus-key` or `id`,
 * falling back to the nearest surviving control or `fallbackFocus` if the focused node was removed.
 */
export function replaceChildrenPreservingFocus(
  container: HTMLElement,
  content: Node | readonly (Node | string)[],
  fallbackFocus?: () => HTMLElement | null | undefined,
): void {
  const hasDoc = typeof document !== 'undefined' && document !== null;
  const active = hasDoc ? document.activeElement : null;
  const hadFocus = Boolean(active && container.contains?.(active));
  let focusKey = '';
  let prevIdx = -1;

  if (hadFocus && active) {
    const activeEl = active as HTMLElement;
    focusKey = activeEl.getAttribute?.('data-focus-key') ?? activeEl.dataset?.focusKey ?? activeEl.id ?? '';
    const beforeControls = Array.from(
      container.querySelectorAll?.('button, input, select, textarea, a') ?? [],
    ).filter((el): el is HTMLElement => isFocusableCandidate(el as HTMLElement));
    prevIdx = beforeControls.indexOf(activeEl);
  }

  if (Array.isArray(content)) {
    container.replaceChildren(...(content as Array<Node | string>));
  } else {
    container.replaceChildren(content as Node);
  }

  if (!hadFocus) return;

  if (focusKey) {
    const keyed = Array.from(container.querySelectorAll?.('[data-focus-key]') ?? []) as HTMLElement[];
    const match = keyed.find(el =>
      (el.getAttribute?.('data-focus-key') ?? el.dataset?.focusKey) === focusKey && isFocusableCandidate(el),
    );
    if (match) {
      safeFocus(match, { preventScroll: true });
      return;
    }
    const byId = hasDoc ? document.getElementById?.(focusKey) : null;
    if (byId && container.contains?.(byId) && isFocusableCandidate(byId)) {
      safeFocus(byId, { preventScroll: true });
      return;
    }
  }

  const afterControls = Array.from(
    container.querySelectorAll?.('button, input, select, textarea, a') ?? [],
  ).filter((el): el is HTMLElement => isFocusableCandidate(el as HTMLElement));
  if (afterControls.length > 0) {
    const targetIdx = prevIdx >= 0 ? Math.min(prevIdx, afterControls.length - 1) : 0;
    safeFocus(afterControls[targetIdx], { preventScroll: true });
    return;
  }

  const fallback = fallbackFocus?.();
  if (fallback && isFocusableCandidate(fallback)) {
    safeFocus(fallback, { preventScroll: true });
  }
}

/**
 * Ensures an inline form error banner `<p>` exists inside `form` for visible modal validation errors.
 */
export function ensureInlineFormError(form: HTMLFormElement | null, errorId: string): HTMLElement | null {
  if (!form || typeof document === 'undefined') return null;
  const existing = document.getElementById?.(errorId);
  if (existing) return existing;
  const p = node('p', '', 'error hub-error-banner');
  p.id = errorId;
  p.setAttribute('role', 'alert');
  p.hidden = true;
  form.append(p);
  return p;
}

/**
 * Displays or clears an inline modal form validation error, syncing `aria-invalid` and live announcements.
 */
export function setInlineFormError(
  errorEl: HTMLElement | null,
  message?: string,
  invalidFields: readonly (HTMLElement | null | undefined)[] = [],
): void {
  const clean = (message ?? '').trim();
  if (errorEl) {
    errorEl.hidden = !clean;
    errorEl.textContent = clean;
  }
  for (const field of invalidFields) {
    if (!field) continue;
    field.setAttribute?.('aria-invalid', clean ? 'true' : 'false');
  }
  if (clean) {
    announceStatus(clean, 'assertive');
  }
}

/**
 * Binds `<form>` `submit` (`preventDefault()` + delayed validation) with a FakeDOM click fallback
 * when `form.requestSubmit` is unavailable on synthetic test elements.
 */
export function wireHubForm(
  form: HTMLFormElement | null,
  submitBtn: HTMLButtonElement | null,
  onSubmit: () => void,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) return;
  const opts = signal ? { signal } : undefined;
  if (form) {
    attachDelayedFormValidation(form, signal);
    form.addEventListener('submit', event => {
      event.preventDefault();
      onSubmit();
    }, opts);
  }
  if (submitBtn) {
    submitBtn.addEventListener('click', () => {
      if (!form || typeof (form as { requestSubmit?: unknown }).requestSubmit !== 'function') {
        onSubmit();
      }
    }, opts);
  }
}

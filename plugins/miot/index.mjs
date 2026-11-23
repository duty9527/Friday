import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  clampInt,
  errMsg,
  readConfig,
  resolveHomeDir,
  resolvePluginPaths,
  withFileLock,
  writeConfig,
  writeJsonAtomic,
} from '../_shared/config-store.mjs';
import {
  buildSshArgs as buildSharedSshArgs,
  discoverOptionalXiaoaiSshFromSqlite,
  execSshText,
  isValidSshUserHost,
  parseSshSpec as sharedParseSshSpec,
  parseSshTargets as sharedParseSshTargets,
  resolvePrivateRunDir,
  shellQuote,
} from '../_shared/ssh.mjs';
import { handleMiotVoiceFastpath } from './fastpath.mjs';
import {
  CENTRAL_TOPIC_RE,
  GEEK_URL_RE,
  GRAPH_ID_RE,
  VAR_IDENT_RE,
  buildCentralMipsApiScript,
  buildCentralOverviewScript,
  buildSafeGeekUrl,
  buildScheduleGeekGraph,
  callCentralMipsApi,
  decodeCentralJsonz,
  defaultFetchCentralOverview,
  parseAutoLocalLogs,
  parseCentralOverviewOutput,
  readCentralCache,
  summarizeCloudScene,
  summarizeGeekGraph,
  validateGeekNodes,
  validateGraphId,
  validateVarIdentifier,
  writeCentralCache,
} from './central-hub.mjs';

export {
  CENTRAL_TOPIC_RE,
  GEEK_URL_RE,
  GRAPH_ID_RE,
  VAR_IDENT_RE,
  buildCentralMipsApiScript,
  buildCentralOverviewScript,
  buildSafeGeekUrl,
  buildScheduleGeekGraph,
  callCentralMipsApi,
  decodeCentralJsonz,
  defaultFetchCentralOverview,
  parseAutoLocalLogs,
  parseCentralOverviewOutput,
  readCentralCache,
  summarizeCloudScene,
  summarizeGeekGraph,
  validateGeekNodes,
  validateGraphId,
  validateVarIdentifier,
  writeCentralCache,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = Object.freeze({
  routerSsh: '',
  speakerSsh: '',
  protectedDevices: Object.freeze([]),
  customAliases: Object.freeze({}),
  cacheTtlMs: 15000,
  topologyTtlMs: 600000,
  udpTimeoutMs: 3500,
});

export const ACTIONS = ['status', 'dashboard', 'mesh', 'geek', 'scene', 'devices', 'get', 'set', 'cook', 'action', 'command', 'config'];

const HUB_CENTRAL_DIR = '/data/other/central';
export const HUB_TAR_COMMAND = `tar -C ${HUB_CENTRAL_DIR} -cf - share/custom/devInfo local/hotdatasync`;
export const HUB_DEVINFO_TAR_COMMAND = `tar -C ${HUB_CENTRAL_DIR} -cf - share/custom/devInfo`;
const MIIO_PORT = 54321;
const MIIO_HELLO = Buffer.from('21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'hex');
const HEX32_RE = /^[0-9a-fA-F]{32}$/;
const HEX32_SCAN_RE = /(?<![0-9a-zA-Z])[0-9a-fA-F]{32}(?![0-9a-zA-Z])/g;
const SSH_TIMEOUT_MS = 10_000;
const HUB_FETCH_TIMEOUT_MS = 25_000;
const BLE_SSH_TIMEOUT_MS = 12_000;
const MAX_NLP_TEXT = 200;

/** careli.fryer.maf01 `siid=2/piid=1` work-status enum. */
export const FRYER_STATUS_MAP = Object.freeze({
  0: '关机',
  1: '待机',
  2: '暂停',
  3: '预约中',
  4: '烹饪中',
  5: '预热中',
  6: '烹饪完成',
  7: '预热完成',
  8: '预热暂停',
  9: '抽锅暂停',
});

/** Preset recipes understood by the fryer (`start-custom-cook` piid1/piid2). */
export const PRESET_RECIPES = Object.freeze({
  M0: { id: 'M0', key: 'manual', name: '手动模式', aliases: ['manual', 'm0', '手动', '手动模式', 'custom', '自定义'], tempC: 180, minutes: 15 },
  M1: { id: 'M1', key: 'fries', name: '薯条', aliases: ['fries', 'm1', '薯条', '炸薯条', '薯条模式'], tempC: 200, minutes: 15 },
  M2: { id: 'M2', key: 'wings', name: '鸡翅', aliases: ['wings', 'm2', '鸡翅', '烤鸡翅', '鸡翅模式'], tempC: 180, minutes: 18 },
  M3: { id: 'M3', key: 'sweet_potato', name: '红薯', aliases: ['sweet_potato', 'sweetpotato', 'm3', '红薯', '烤红薯', '地瓜', '红薯模式'], tempC: 180, minutes: 30 },
  M4: { id: 'M4', key: 'egg_tart', name: '蛋挞', aliases: ['egg_tart', 'eggtart', 'm4', '蛋挞', '烤蛋挞', '蛋挞模式'], tempC: 200, minutes: 20 },
  M5: { id: 'M5', key: 'defrost', name: '解冻', aliases: ['defrost', 'thaw', 'm5', '解冻', '解冻模式'], tempC: 60, minutes: 10 },
  M6: { id: 'M6', key: 'dried_fruit', name: '果干', aliases: ['dried_fruit', 'driedfruit', 'm6', '果干', '烘干', '果干模式'], tempC: 70, minutes: 180 },
  M7: { id: 'M7', key: 'yogurt', name: '酸奶', aliases: ['yogurt', 'yoghurt', 'm7', '酸奶', '酸奶模式'], tempC: 40, minutes: 480 },
});

/** Fryer properties to read. NEVER include siid=1 (it makes the MCU time out). */
export function buildFryerGetParams(did) {
  const d = String(did);
  return [
    [2, 1], [2, 2], [2, 3], [2, 4], [2, 5],
    [3, 1], [3, 2], [3, 5], [3, 6], [3, 7], [3, 8], [3, 10],
  ].map(([siid, piid]) => ({ did: d, siid, piid }));
}

const CATEGORY_ALIASES = {
  light: ['light', 'lights', 'lamp', '灯', '灯光', '照明', '灯具'],
  outlet: ['outlet', 'plug', 'socket', '插座', '插排', '排插', '插头', '通断器'],
  switch: ['switch', '开关', '墙壁开关'],
  air_fryer: ['air_fryer', 'airfryer', 'fryer', '空气炸锅', '炸锅', '空气炸播', '空气炸国', '空炸', '炸播', '空气炸锅机'],
  air_conditioner: ['air_conditioner', 'airconditioner', 'ac', 'aircon', '空调'],
  tv: ['tv', 'television', '电视', '电视机'],
  speaker: ['speaker', '音箱', '小爱', '小爱音箱', '小爱同学'],
  router: ['router', '路由', '路由器'],
  other: ['other', '其他', '其它'],
};

const CATEGORY_LABELS = {
  light: '灯', outlet: '插座', switch: '开关', air_fryer: '空气炸锅', air_conditioner: '空调',
  tv: '电视', speaker: '音箱', router: '路由器', other: '其他',
};

// Built-in generic device aliases used when exact / room-qualified names do not match.
// Personal device aliases belong in `<pluginDataDir>/config.json` (`customAliases`).
const DEVICE_ALIASES = [
  {
    names: [
      '空气炸锅', '炸锅', '空气炸', '空气炸播', '空气炸国', '空炸', '炸播', '空气炸锅机',
      'airfryer', 'fryer', 'careli.fryer.maf01', '米家智能空气炸锅3.5l', '米家智能空气炸锅',
    ],
    match: d => d.category === 'air_fryer',
  },
  { names: ['电视', '电视机', 'tv', '电视遥控'], match: d => d.category === 'tv' },
];

const AC_MODE_ZH = {
  cool: '制冷', cooling: '制冷', 制冷: '制冷', 冷: '制冷', 冷风: '制冷',
  heat: '制热', heating: '制热', 制热: '制热', 热: '制热', 暖: '制热', 暖风: '制热',
  auto: '自动', 自动: '自动',
  dry: '除湿', dehumidify: '除湿', 除湿: '除湿',
  fan: '送风', 送风: '送风',
};
const AC_FAN_ZH = {
  auto: '自动', 自动: '自动',
  low: '低', 低: '低', 低速: '低', 低风: '低',
  medium: '中', mid: '中', 中: '中', 中速: '中', 中风: '中',
  high: '高', 高: '高', 高速: '高', 高风: '高',
  max: '最大', 最大: '最大', turbo: '最大',
};

// ---------------------------------------------------------------------------
// Result helpers & output sanitisation
// ---------------------------------------------------------------------------

function success(title, message, data) {
  return { ok: true, notify: true, title, message, ...(data === undefined ? {} : { data }) };
}

function failure(title, message, data) {
  return { ok: false, notify: true, title, message, ...(data === undefined ? {} : { data }) };
}

const SECRET_KEYS = new Set(['token', 'tokenbydid', 'tokenmap', 'tokens', 'bindkey', 'bind_key', 'ltmk']);

/** Defence in depth: strip token-ish keys and mask any 32-hex string anywhere in an output value. */
export function sanitizeOutput(value) {
  if (typeof value === 'string') return value.replace(HEX32_SCAN_RE, '[redacted]');
  if (Array.isArray(value)) return value.map(sanitizeOutput);
  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value)) return `[buffer ${value.length}B]`;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k.toLowerCase())) continue;
      out[k] = sanitizeOutput(v);
    }
    return out;
  }
  return value;
}

class MiotError extends Error {
  /** @param {string} message @param {{ code?: string; data?: any }} [opts] */
  constructor(message, { code = undefined, data = undefined } = /** @type {{ code?: string; data?: any }} */ ({})) {
    super(message);
    this.name = 'MiotError';
    this.code = code;
    this.data = data;
  }
}

// ---------------------------------------------------------------------------
// Paths / config
// ---------------------------------------------------------------------------

function getRuntimePaths(deps = {}) {
  return resolvePluginPaths('miot', deps, {
    cachePath: 'hub-cache.json',
    tokenCachePath: 'hub-tokens.json',
    centralCachePath: 'central-cache.json',
  });
}

function writeSecureJson(path, value) {
  writeJsonAtomic(path, value, { mode: 0o600 });
}

function normalizeProtectedDevices(raw) {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const clean = String(item ?? '').trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function normalizeCustomAliases(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const cleanKey = String(k ?? '').trim();
    if (!cleanKey) continue;
    if (Array.isArray(v)) {
      const list = v.map(x => String(x ?? '').trim()).filter(Boolean);
      if (list.length) out[cleanKey] = list;
    } else if (typeof v === 'string' && v.trim()) {
      out[cleanKey] = v.trim();
    }
  }
  return out;
}

export function loadConfig(paths) {
  const safe = readConfig(paths.configPath, DEFAULT_CONFIG);
  return {
    routerSsh: typeof safe.routerSsh === 'string' && safe.routerSsh.trim() ? safe.routerSsh.trim() : DEFAULT_CONFIG.routerSsh,
    speakerSsh: typeof safe.speakerSsh === 'string' ? safe.speakerSsh.trim() : DEFAULT_CONFIG.speakerSsh,
    protectedDevices: normalizeProtectedDevices(safe.protectedDevices),
    customAliases: normalizeCustomAliases(safe.customAliases),
    cacheTtlMs: clampInt(safe.cacheTtlMs, 0, 3_600_000) ?? DEFAULT_CONFIG.cacheTtlMs,
    topologyTtlMs: clampInt(safe.topologyTtlMs, 0, 3_600_000) ?? DEFAULT_CONFIG.topologyTtlMs,
    udpTimeoutMs: clampInt(safe.udpTimeoutMs, 300, 30_000) ?? DEFAULT_CONFIG.udpTimeoutMs,
  };
}

function saveConfig(paths, cfg) {
  writeConfig(paths.configPath, cfg);
}

// ---------------------------------------------------------------------------
// SSH targets & executors
// ---------------------------------------------------------------------------

/**
 * Parse `[ssh://][id=]user@host[:port][,...]` (first usable entry) into `{ id, userHost, port? }`.
 */
export function parseSshTargets(spec, defaultId = 'default') {
  return sharedParseSshTargets(spec, defaultId);
}

export function parseSshSpec(spec, defaultId = 'default') {
  const trimmed = typeof spec === 'string' ? spec.trim() : '';
  if (!trimmed) {
    throw new MiotError('未配置 SSH 目标：请先通过 config 动作设置 routerSsh / speakerSsh，或在 config.json 中配置。');
  }
  const first = sharedParseSshSpec(trimmed, defaultId);
  if (!first) throw new MiotError(`无效的 SSH 目标 "${String(spec ?? '')}"，格式应为 [id=]user@host[:port]。`);
  return first;
}

/** Explicit SSH flags (never rely on ~/.ssh/config aliases). */
export function buildSshArgs(target, remoteCommand, options = {}) {
  if (!isValidSshUserHost(target?.userHost)) {
    throw new MiotError(`无效的 SSH userHost "${String(target?.userHost ?? '')}"`);
  }
  return [
    ...buildSharedSshArgs(target, {
      connectTimeoutSec: 5,
      serverAliveInterval: 10,
      serverAliveCountMax: 2,
      controlPersistSec: 60,
      allowLegacyRsa: true,
      useControlMaster: options.useControlMaster ?? Boolean(options.homeDir),
      homeDir: options.homeDir,
    }),
    '-o', 'LogLevel=ERROR',
    '--',
    target.userHost,
    ...(remoteCommand === undefined ? [] : [remoteCommand]),
  ];
}

/** Default text SSH executor: (target, command, timeoutMs, options?) => { stdout, stderr, code }. */
export function defaultSshTextExec(target, remoteCommand, timeoutMs = SSH_TIMEOUT_MS, options = {}) {
  return execSshText(target, remoteCommand, {
    timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    homeDir: options.homeDir,
    signal: options.signal,
    controlPersistSec: 60,
    allowLegacyRsa: true,
    useControlMaster: options.useControlMaster ?? Boolean(options.homeDir),
  });
}

/**
 * Default binary SSH executor: (target, command, { input?: Buffer, timeoutMs? }) => { stdout: Buffer, stderr, code }.
 * @param {import('../_shared/types.d.ts').SshTarget} target
 * @param {string} remoteCommand
 * @param {{ input?: Buffer; timeoutMs?: number; maxBytes?: number; homeDir?: string; signal?: AbortSignal }} [opts]
 */
export function defaultSshBinaryExec(target, remoteCommand, { input = undefined, timeoutMs = SSH_TIMEOUT_MS, maxBytes = 64 * 1024 * 1024, homeDir = undefined, signal = undefined } = /** @type {{ input?: Buffer; timeoutMs?: number; maxBytes?: number; homeDir?: string; signal?: AbortSignal }} */ ({})) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('ssh', buildSshArgs(target, remoteCommand, { homeDir, useControlMaster: false }), { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let outBytes = 0;
    let settled = false;
    const onAbort = () => {
      child.kill('SIGKILL');
      finish(rejectPromise, new Error('SSH 操作已取消'));
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(rejectPromise, new Error(`SSH 执行超时 (${timeoutMs}ms)`));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      outBytes += chunk.length;
      if (outBytes > maxBytes) {
        child.kill('SIGKILL');
        finish(rejectPromise, new Error('SSH 输出超过大小限制'));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', chunk => { if (err.length < 64) err.push(chunk); });
    child.on('error', e => finish(rejectPromise, e));
    child.on('close', code => finish(resolvePromise, {
      stdout: Buffer.concat(out),
      stderr: Buffer.concat(err).toString('utf8'),
      code: code ?? -1,
    }));
    child.stdin.on('error', () => { /* remote closed early */ });
    if (input && input.length) child.stdin.end(input);
    else child.stdin.end();
  });
}

function shQuote(value) {
  return shellQuote(value);
}

// ---------------------------------------------------------------------------
// Speaker discovery
// ---------------------------------------------------------------------------

/**
 * explicit arg -> config.json speakerSsh -> optional homeDir/state.sqlite im_channels(platform='xiaoai').
 * Returns `{ id, userHost, port?, source, channelId? }`.
 * @param {{ speakerSsh?: unknown; pluginDataDir?: string; dataDir?: string; homeDir?: string }} [opts]
 */
export async function discoverSpeakerSsh({ speakerSsh = undefined, pluginDataDir = undefined, dataDir = undefined, homeDir = undefined } = /** @type {{ speakerSsh?: unknown; pluginDataDir?: string; dataDir?: string; homeDir?: string }} */ ({})) {
  const paths = getRuntimePaths({ pluginDataDir, dataDir, homeDir });
  const config = loadConfig(paths);
  const explicit = typeof speakerSsh === 'string' ? speakerSsh.trim() : '';
  const configured = config.speakerSsh;

  if (explicit) {
    const parsed = parseSshTargets(explicit, 'lx06');
    if (parsed.length > 0) return { ...parsed[0], source: 'args' };
  }
  if (configured) {
    const parsed = parseSshTargets(configured, 'lx06');
    if (parsed.length > 0) return { ...parsed[0], source: 'config' };
  }

  const preferredId = explicit || configured || 'lx06';
  const discovered = discoverOptionalXiaoaiSshFromSqlite({ homeDir: paths.homeDir }, preferredId);
  if (discovered) {
    return { ...discovered.target, source: 'sqlite', channelId: discovered.channelId };
  }

  throw new MiotError(
    `未找到小爱音箱 SSH 目标（home=${paths.homeDir}）：请先绑定 xiaoai 通道，或在 config 动作 / config.json 中设置 speakerSsh（如 "speaker=root@192.0.2.10"）。`,
    { code: 'SPEAKER_SSH_REQUIRED' },
  );
}

// ---------------------------------------------------------------------------
// Hub (BE6500 Pro central) database parsing
// ---------------------------------------------------------------------------

/** device_v4 columns are JSON-encoded text ('"客厅"', 'true', '16'); parse safely with fallback. */
export function unquoteDbVal(val) {
  if (typeof val !== 'string') return val;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
}

/** Like unquoteDbVal but always yields a string (avoids number precision loss for ids/tokens). */
function unquoteString(val) {
  if (val === null || val === undefined) return '';
  if (typeof val !== 'string') return String(val);
  try {
    const parsed = JSON.parse(val);
    if (typeof parsed === 'string') return parsed;
  } catch {
    /* raw */
  }
  return val;
}

function asBool(val) {
  const v = unquoteDbVal(val);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', '1', 'on', 'yes'].includes(v.trim().toLowerCase());
  return false;
}

function urnType(urn) {
  const parts = String(urn || '').split(':');
  return parts[0] === 'urn' ? (parts[3] ?? '') : '';
}

export function classifyCategory({ urn = '', model = '' } = {}) {
  const type = urnType(urn);
  const byType = {
    light: 'light', outlet: 'outlet', switch: 'switch', 'air-fryer': 'air_fryer',
    'air-conditioner': 'air_conditioner', television: 'tv', speaker: 'speaker', router: 'router',
  };
  if (byType[type]) return byType[type];
  const m = String(model).toLowerCase();
  if (m.startsWith('xiaomi.router')) return 'router';
  if (m.includes('fryer')) return 'air_fryer';
  if (m.includes('aircondition')) return 'air_conditioner';
  if (m.startsWith('miir.tv') || m.includes('.tv.')) return 'tv';
  if (m.includes('wifispeaker')) return 'speaker';
  if (m.includes('.light.')) return 'light';
  if (m.includes('.plug.')) return 'outlet';
  if (m.includes('.switch.')) return 'switch';
  return 'other';
}

function classifyChannel({ connectType, category, urn }) {
  if (connectType === 0 || category === 'router') return 'router';
  if (connectType === 16) return 'bt_mesh';
  if (connectType === 15) return /:television:/.test(urn) ? 'tv_agent' : 'xiaoai_nlp';
  if (connectType === 8) return 'miio_udp';
  return 'unknown';
}

function parseHotKey(key) {
  const idx = String(key).indexOf('😂');
  if (idx <= 0) return undefined;
  return { did: String(key).slice(0, idx), name: String(key).slice(idx + '😂'.length) };
}

function parseHotValue(raw) {
  const parsed = unquoteDbVal(raw);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'value' in parsed) {
    return { value: parsed.value, ...(parsed.ts !== undefined ? { ts: parsed.ts } : {}) };
  }
  return { value: parsed };
}

/**
 * Turn raw device_v4 / appMsg rows into `{ homeId, fetchedAt, devices, tokenByDid }`.
 * `devices` never carries the raw token (only `hasToken`); tokens live in `tokenByDid` for MiIO callers.
 * @param {{ devInfoRows?: any[]; hotDataRows?: any[]; nowMs?: number; hotDataFetchedAt?: number }} [opts]
 * @returns {{ homeId: string; fetchedAt: number; hotDataFetchedAt: number; liveFetchedAt?: number; devices: any[]; tokenByDid: Record<string, string> }}
 */
export function parseHubSnapshot({ devInfoRows = [], hotDataRows = [], nowMs, hotDataFetchedAt } = {}) {
  const cachedByDid = new Map();
  for (const row of hotDataRows ?? []) {
    const parsedKey = parseHotKey(row?.key);
    if (!parsedKey) continue;
    let entry = cachedByDid.get(parsedKey.did);
    if (!entry) {
      entry = { properties: {} };
      cachedByDid.set(parsedKey.did, entry);
    }
    const val = parseHotValue(row.value);
    if (/^\d+\.\d+$/.test(parsedKey.name)) {
      entry.properties[parsedKey.name] = val;
    } else if (!/token|secret|passw|bind_?key|ltmk/i.test(parsedKey.name)) {
      entry.rawKeys ??= {};
      entry.rawKeys[parsedKey.name] = val;
    }
  }

  /** @type {any[]} */
  const devices = [];
  /** @type {Record<string, string>} */
  const tokenByDid = {};
  let homeId = '';
  for (const row of devInfoRows ?? []) {
    const did = unquoteString(row?.did).trim();
    if (!did) continue;
    const token = unquoteString(row.token).trim();
    const urn = unquoteString(row.urn);
    const model = unquoteString(row.model);
    const connectTypeRaw = unquoteDbVal(row.connect_type);
    const connectType = Number.isFinite(Number(connectTypeRaw)) ? Number(connectTypeRaw) : -1;
    const name = unquoteString(row.dev_name);
    const category = classifyCategory({ urn, model });
    const controlChannel = classifyChannel({ connectType, category, urn });
    const categories = [category];
    if ((category === 'outlet' || category === 'switch') && name.includes('灯')) categories.push('light');
    if (!homeId) homeId = unquoteString(row.homeid);
    const hasToken = Boolean(token && HEX32_RE.test(token));
    if (hasToken) tokenByDid[did] = token;
    devices.push({
      did,
      name,
      dev_name: name,
      room: unquoteString(row.room_name),
      room_name: unquoteString(row.room_name),
      roomId: unquoteString(row.roomid),
      parent: row.parent === null || row.parent === undefined ? '' : unquoteString(row.parent),
      model,
      model_name: unquoteString(row.model_name),
      urn,
      ip: unquoteString(row.ip),
      connect_type: connectType,
      online: asBool(row.online),
      fw_ver: unquoteString(row.fw_ver),
      category,
      categories,
      controlChannel,
      controllable: controlChannel !== 'router' && controlChannel !== 'unknown',
      hasToken,
      cachedState: cachedByDid.get(did) ?? { properties: {} },
    });
  }
  const fetchedAt = typeof nowMs === 'number' ? nowMs : Date.now();
  return {
    homeId,
    fetchedAt,
    hotDataFetchedAt: typeof hotDataFetchedAt === 'number' ? hotDataFetchedAt : fetchedAt,
    devices,
    tokenByDid,
  };
}

function fullName(device) {
  const room = device.room_name ?? device.room ?? '';
  const name = device.dev_name ?? device.name ?? '';
  if (!room || name.startsWith(room)) return name;
  return `${room}${name}`;
}

function cachedOn(device) {
  if (device.controlChannel !== 'bt_mesh') return undefined;
  const v = device.cachedState?.properties?.['2.1']?.value;
  if (v === undefined || v === null) return undefined;
  return v === true || v === 1 || v === '1' || v === 'true';
}

/** Public, token-free device view. */
function publicDevice(device, extra = {}) {
  const on = cachedOn(device);
  return {
    did: device.did,
    name: device.dev_name ?? device.name,
    room: device.room_name ?? device.room,
    fullName: fullName(device),
    category: device.category,
    categories: device.categories,
    controlChannel: device.controlChannel,
    controllable: device.controllable,
    online: device.online,
    model: device.model,
    modelName: device.model_name,
    ip: device.ip || undefined,
    hasToken: Boolean(device.hasToken),
    ...(on !== undefined ? { state: { on, source: 'cache', ts: device.cachedState?.properties?.['2.1']?.ts } } : {}),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Device resolution
// ---------------------------------------------------------------------------

function norm(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '').replace(/[的]/g, '');
}

function normKeepDe(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

function roomMatches(device, room) {
  if (!room) return true;
  const r = norm(room);
  const dr = norm(device.room_name ?? device.room);
  return Boolean(dr) && (dr === r || dr.includes(r) || r.includes(dr));
}

function ambiguityError(query, candidates) {
  const names = candidates.map(fullName);
  return new MiotError(
    `"${query}" 匹配到多个设备：${names.join('、')}。请指定 room（如 room:"卧室"）或使用完整名称（如 "${names[0]}"）。`,
    { code: 'AMBIGUOUS_DEVICE', data: { candidates: candidates.map(d => ({ did: d.did, fullName: fullName(d), room: d.room_name ?? d.room, name: d.dev_name ?? d.name })) } },
  );
}

function pickUnique(query, list) {
  if (list.length === 1) return list[0];
  if (list.length > 1) throw ambiguityError(query, list);
  return undefined;
}

function matchCustomAliasTarget(pool, customAliases, qn) {
  if (!customAliases || typeof customAliases !== 'object') return undefined;
  const targets = [];
  for (const [key, val] of Object.entries(customAliases)) {
    if (Array.isArray(val)) {
      if (val.some(alias => norm(alias) === qn)) targets.push(key);
    } else if (typeof val === 'string' && norm(key) === qn) {
      targets.push(val);
    }
  }
  if (!targets.length) return undefined;
  const hits = pool.filter(d => targets.some(t => {
    const nt = norm(t);
    const nkt = normKeepDe(t);
    return String(d.did) === t || normKeepDe(d.dev_name ?? d.name ?? '') === nkt || norm(fullName(d)) === nt;
  }));
  return hits;
}

/**
 * Resolve a device by did / name / room-qualified name / custom alias / built-in alias / substring. Throws Chinese errors.
 * @param {any[]} devices
 * @param {{ device?: unknown; did?: unknown; room?: unknown; customAliases?: Record<string, any> }} [opts]
 */
export function resolveDevice(devices, { device = undefined, did = undefined, room = undefined, customAliases = undefined } = /** @type {{ device?: unknown; did?: unknown; room?: unknown; customAliases?: Record<string, any> }} */ ({})) {
  const list = Array.isArray(devices) ? devices : [];
  if (did !== undefined && did !== null && String(did).trim() !== '') {
    const wanted = String(did).trim();
    const hit = list.find(d => String(d.did) === wanted);
    if (hit) return hit;
    throw new MiotError(`未找到 did 为 "${wanted}" 的设备。`, { code: 'DEVICE_NOT_FOUND' });
  }
  const query = String(device ?? '').trim();
  if (!query) {
    throw new MiotError('请通过 device（设备名，如 "卧室灯"）或 did 指定设备。', { code: 'DEVICE_REQUIRED' });
  }
  const pool = room ? list.filter(d => roomMatches(d, room)) : list;
  const notFound = () => new MiotError(
    `未找到设备 "${query}"${room ? `（房间：${room}）` : ''}。可用设备：${(room ? pool : list).map(fullName).join('、') || '（无）'}。`,
    { code: 'DEVICE_NOT_FOUND' },
  );
  if (pool.length === 0) throw notFound();

  const q = normKeepDe(query);
  const qn = norm(query);
  const nameOf = d => d.dev_name ?? d.name ?? '';

  // 1) exact did / model / model_name as a "device" string
  const byId = pool.filter(d => String(d.did) === query || normKeepDe(d.model) === q || normKeepDe(d.model_name) === q);
  if (byId.length === 1) return byId[0];
  if (byId.length > 1 && byId.every(d => normKeepDe(d.model) === q)) throw ambiguityError(query, byId);

  // 2) exact dev_name
  const exact = pool.filter(d => normKeepDe(nameOf(d)) === q);
  const exactHit = pickUnique(query, exact);
  if (exactHit) return exactHit;

  // 3) room_name + dev_name / room_name + 的 + dev_name
  const qualified = pool.filter(d => {
    const r = normKeepDe(d.room_name ?? d.room);
    const n = normKeepDe(nameOf(d));
    return r && (q === `${r}${n}` || q === `${r}的${n}`);
  });
  const qualifiedHit = pickUnique(query, qualified);
  if (qualifiedHit) return qualifiedHit;

  // 4) customAliases (from config.json) then built-in generic aliases
  const customHits = matchCustomAliasTarget(pool, customAliases, qn);
  if (customHits?.length) {
    const customHit = pickUnique(query, customHits);
    if (customHit) return customHit;
  }
  for (const alias of DEVICE_ALIASES) {
    if (alias.names.some(n => norm(n) === qn)) {
      const hits = pool.filter(d => alias.match({ ...d, name: nameOf(d) }));
      const hit = pickUnique(query, hits);
      if (hit) return hit;
    }
  }

  // 5) room-prefixed query whose remainder matches (e.g. "卧室的灯", "客厅电视")
  const rooms = [...new Set(list.map(d => d.room_name ?? d.room).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const r of rooms) {
    const rn = normKeepDe(r);
    if (q.startsWith(rn) && q.length > rn.length) {
      const rest = q.slice(rn.length).replace(/^的/, '');
      const sub = resolveDeviceLoose(list.filter(d => roomMatches(d, r) && roomMatches(d, room ?? r)), rest, customAliases);
      if (sub) return sub(query);
    }
  }

  // 6) substring
  const sub = resolveDeviceLoose(pool, q, customAliases);
  if (sub) return sub(query);
  throw notFound();
}

function resolveDeviceLoose(pool, q, customAliases) {
  const qn = String(q).replace(/的/g, '');
  if (!qn) return undefined;
  const nameOf = d => normKeepDe(d.dev_name ?? d.name ?? '');
  const customHits = matchCustomAliasTarget(pool, customAliases, qn);
  if (customHits?.length) return query => pickUnique(query, customHits);
  for (const alias of DEVICE_ALIASES) {
    if (alias.names.some(n => norm(n) === qn)) {
      const hits = pool.filter(d => alias.match({ ...d, name: d.dev_name ?? d.name ?? '' }));
      if (hits.length) return query => pickUnique(query, hits);
    }
  }
  const exact = pool.filter(d => nameOf(d) === q);
  if (exact.length) return query => pickUnique(query, exact);
  const hits = pool.filter(d => {
    const n = nameOf(d).replace(/的/g, '');
    const f = normKeepDe(fullName(d)).replace(/的/g, '');
    const mn = normKeepDe(d.model_name).replace(/的/g, '');
    return n.includes(qn) || f.includes(qn) || (mn && mn.includes(qn));
  });
  if (hits.length) return query => pickUnique(query, hits);
  return undefined;
}

// ---------------------------------------------------------------------------
// Transport A: MIPS frames over the BE6500 Pro internal MQTT bus (BLE Mesh)
// ---------------------------------------------------------------------------

function tlv(tag, bytes) {
  const header = Buffer.alloc(5);
  header.writeUInt32LE(bytes.length, 0);
  header.writeUInt8(tag, 4);
  return Buffer.concat([header, bytes]);
}

/** `[uint32LE(len)][uint8(tag)][bytes]` x4: reqId(0) / "local\0"(3) / returnTopic\0(1) / JSON(2). */
export function packMipsFrame(reqId, returnTopic, payloadObj) {
  const reqBuf = Buffer.alloc(4);
  reqBuf.writeUInt32LE(Number(reqId) >>> 0, 0);
  return Buffer.concat([
    tlv(0, reqBuf),
    tlv(3, Buffer.from('local\0', 'utf8')),
    tlv(1, Buffer.from(`${returnTopic}\0`, 'utf8')),
    tlv(2, Buffer.from(JSON.stringify(payloadObj), 'utf8')),
  ]);
}

/** Inverse of packMipsFrame: `{ reqId, realm, returnTopic, payload }` (payload = parsed JSON of tag 2). */
export function unpackMipsFrame(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  const out = { reqId: undefined, realm: undefined, returnTopic: undefined, payload: undefined };
  const stripNul = b => b.toString('utf8').replace(/\0+$/, '');
  let offset = 0;
  while (offset + 5 <= data.length) {
    const length = data.readUInt32LE(offset);
    const tag = data.readUInt8(offset + 4);
    const start = offset + 5;
    if (start + length > data.length) break;
    const bytes = data.subarray(start, start + length);
    if (tag === 0 && length >= 4) out.reqId = bytes.readUInt32LE(0);
    else if (tag === 3) out.realm = stripNul(bytes);
    else if (tag === 1) out.returnTopic = stripNul(bytes);
    else if (tag === 2) {
      const text = stripNul(bytes);
      try { out.payload = JSON.parse(text); } catch { out.payload = undefined; out.rawPayload = text; }
    }
    offset = start + length;
  }
  return out;
}

/** Remote shell program: pipe stdin frame into central_service's chroot, pub to local/bt/rpcReq, print the reply frame. */
export function buildMipsRemoteScript(nonce) {
  if (!/^[0-9a-f]{4,32}$/i.test(nonce)) throw new Error('invalid nonce');
  return [
    `MQTT_PID=$(pidof central_service | awk '{print $1}')`,
    `[ -n "$MQTT_PID" ] || { echo "central_service not running" >&2; exit 3; }`,
    `ROOT="/proc/$MQTT_PID/root"`,
    `IN="$ROOT/tmp/friday_mips_${nonce}.in"`,
    `OUT="$ROOT/tmp/friday_mips_${nonce}.out"`,
    `trap 'rm -f "$IN" "$OUT"' EXIT INT TERM HUP`,
    `cat > "$IN"`,
    `chroot "$ROOT" /bin/sh -c '`,
    `  /usr/bin/mosquitto_sub --unix /tmp/mosquitto.sock -N -t "local/friday/rpcReply_${nonce}" -C 1 -W 3 > "/tmp/friday_mips_${nonce}.out" 2>/dev/null &`,
    `  SUB_PID=$!`,
    `  usleep 100000 2>/dev/null || sleep 1`,
    `  /usr/bin/mosquitto_pub --unix /tmp/mosquitto.sock -t "local/bt/rpcReq" -f "/tmp/friday_mips_${nonce}.in"`,
    `  wait $SUB_PID`,
    `'`,
    `cat "$OUT"`,
  ].join('\n');
}

function normalizeMiotResult(entry) {
  return {
    did: entry?.did !== undefined ? String(entry.did) : undefined,
    siid: entry?.siid,
    piid: entry?.piid,
    ...(entry?.aiid !== undefined ? { aiid: entry.aiid } : {}),
    code: entry?.code,
    ...(entry && 'value' in entry ? { value: entry.value } : {}),
  };
}

async function bleRpc(ctx, method, params) {
  const target = routerTarget(ctx);
  const nonce = randomBytes(6).toString('hex');
  const reqId = (randomBytes(4).readUInt32LE(0) % 2_000_000_000) + 1;
  const frame = packMipsFrame(reqId, `local/friday/rpcReply_${nonce}`, { id: reqId, method, params });
  const res = await ctx.sshBin(target, buildMipsRemoteScript(nonce), { input: frame, timeoutMs: BLE_SSH_TIMEOUT_MS });
  const stdout = Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout ?? '', 'utf8');
  if (res.code !== 0 && stdout.length === 0) {
    throw new MiotError(`中枢 BLE 通道调用失败 (ssh code=${res.code})：${String(res.stderr ?? '').trim().slice(0, 200) || '无输出'}`);
  }
  if (stdout.length === 0) {
    throw new MiotError('中枢 BLE Mesh 无响应（3 秒超时），设备可能离线。');
  }
  const frameOut = unpackMipsFrame(stdout);
  let payload = frameOut.payload;
  if (payload === undefined) {
    try { payload = JSON.parse(stdout.toString('utf8')); } catch { /* ignore */ }
  }
  if (payload === undefined) throw new MiotError('无法解析中枢 BLE 响应帧。');
  if (payload.error) {
    throw new MiotError(`中枢 BLE 返回错误：${payload.error.message ?? JSON.stringify(payload.error)}${payload.error.code !== undefined ? ` (code=${payload.error.code})` : ''}`);
  }
  return payload;
}

async function bleGetProperties(ctx, items) {
  const payload = await bleRpc(ctx, 'get_properties', items);
  const result = Array.isArray(payload.result) ? payload.result : [];
  return result.map(normalizeMiotResult);
}

async function bleSetProperties(ctx, items) {
  const payload = await bleRpc(ctx, 'set_properties', items);
  const result = Array.isArray(payload.result) ? payload.result : [];
  return result.map(normalizeMiotResult);
}

async function bleAction(ctx, params) {
  const payload = await bleRpc(ctx, 'action', params);
  const result = payload.result;
  return result && typeof result === 'object' ? normalizeMiotResult(result) : { code: payload.code ?? 0 };
}

// ---------------------------------------------------------------------------
// Transport B: LAN MiIO UDP v2 (:54321)
// ---------------------------------------------------------------------------

function md5(...buffers) {
  const h = createHash('md5');
  for (const b of buffers) h.update(b);
  return h.digest();
}

function miioKeyIv(tokenHex) {
  if (!HEX32_RE.test(String(tokenHex ?? ''))) throw new MiotError('缺少有效的设备 token，无法进行 MiIO 加密。');
  const token = Buffer.from(tokenHex, 'hex');
  const key = md5(token);
  const iv = md5(key, token);
  return { token, key, iv };
}

/** Build a MiIO v2 packet: 32-byte header (0x2131, len, 0, devId, stamp, md5 checksum) + AES-128-CBC body. */
export function encryptMiioPacket({ devId, stamp, tokenHex, payloadObj }) {
  const { token, key, iv } = miioKeyIv(tokenHex);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  const plain = Buffer.from(`${JSON.stringify(payloadObj)}\0`, 'utf8');
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const header = Buffer.alloc(32);
  header.writeUInt16BE(0x2131, 0);
  header.writeUInt16BE(32 + enc.length, 2);
  header.writeUInt32BE(0, 4);
  header.writeUInt32BE(Number(devId) >>> 0, 8);
  header.writeUInt32BE(Number(stamp) >>> 0, 12);
  md5(header.subarray(0, 16), token, enc).copy(header, 16);
  return Buffer.concat([header, enc]);
}

/**
 * Verify checksum and decrypt a MiIO packet: `{ devId, stamp, payload, text }` (payload undefined for empty/hello packets).
 * @param {{ packet: Buffer | Uint8Array | number[]; tokenHex: string }} opts
 * @returns {{ devId: number; stamp: number; payload: Record<string, any> | undefined; text: string }}
 */
export function decryptMiioPacket({ packet, tokenHex }) {
  const buf = Buffer.isBuffer(packet) ? packet : Buffer.from(packet ?? []);
  if (buf.length < 32 || buf.readUInt16BE(0) !== 0x2131) throw new MiotError('无效的 MiIO 数据包头。');
  const length = buf.readUInt16BE(2);
  const devId = buf.readUInt32BE(8);
  const stamp = buf.readUInt32BE(12);
  if (length <= 32 || buf.length <= 32) return { devId, stamp, payload: undefined, text: '' };
  const { token, key, iv } = miioKeyIv(tokenHex);
  const enc = buf.subarray(32, Math.min(length, buf.length));
  const expected = md5(buf.subarray(0, 16), token, enc);
  if (!expected.equals(buf.subarray(16, 32))) throw new MiotError('MiIO 校验和不匹配（token 可能不正确）。');
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  const text = plain.toString('utf8').replace(/\0+$/, '');
  let payload;
  try { payload = JSON.parse(text); } catch { payload = undefined; }
  return { devId, stamp, payload, text };
}

/** @param {any} socket @param {string} ip @param {number} port @param {Buffer} packet @param {number} timeoutMs @param {(msg: Buffer) => boolean} [accept] */
function udpExchange(socket, ip, port, packet, timeoutMs, accept = () => true) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      rejectPromise(new MiotError(`UDP 无响应 (${ip}:${port}, ${timeoutMs}ms)`));
    }, timeoutMs);
    const onMessage = (msg, rinfo) => {
      if (rinfo.address !== ip || !accept(msg)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolvePromise(msg);
    };
    socket.on('message', onMessage);
    socket.send(packet, port, ip, err => {
      if (err) {
        clearTimeout(timer);
        socket.off('message', onMessage);
        rejectPromise(err);
      }
    });
  });
}

/**
 * Live MiIO call. Returns the decrypted JSON reply (e.g. `{ id, result }`).
 * @param {{ ip: string; tokenHex: string; method: string; params?: any; timeoutMs?: number; port?: number }} [opts]
 * @returns {Promise<Record<string, any>>}
 */
export async function udpCall({ ip, tokenHex, method, params = undefined, timeoutMs = DEFAULT_CONFIG.udpTimeoutMs, port = MIIO_PORT } = /** @type {{ ip: string; tokenHex: string; method: string; params?: any; timeoutMs?: number; port?: number }} */ ({})) {
  if (!ip) throw new MiotError('设备缺少局域网 IP。');
  miioKeyIv(tokenHex);
  const socket = dgram.createSocket('udp4');
  socket.on('error', () => { /* surfaced through timeouts */ });
  try {
    let hello;
    let lastErr;
    for (let attempt = 0; attempt < 2 && !hello; attempt++) {
      try {
        hello = await udpExchange(socket, ip, port, MIIO_HELLO, Math.max(500, Math.floor(timeoutMs / 2)), m => m.length >= 32);
      } catch (e) {
        lastErr = e;
      }
    }
    if (!hello) throw lastErr ?? new MiotError('MiIO hello 失败');
    const devId = hello.readUInt32BE(8);
    const stamp = hello.readUInt32BE(12);
    const id = (randomBytes(2).readUInt16BE(0) % 9000) + 1;
    const packet = encryptMiioPacket({ devId, stamp: stamp + 1, tokenHex, payloadObj: { id, method, params } });
    const reply = await udpExchange(socket, ip, port, packet, timeoutMs, m => m.length > 32);
    const { payload } = decryptMiioPacket({ packet: reply, tokenHex });
    if (payload === undefined) throw new MiotError('MiIO 响应无法解析。');
    return payload;
  } finally {
    try { socket.close(); } catch { /* ignore */ }
  }
}

function decodeEscapedUnicode(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Convert fryer get_properties results into a friendly summary. */
export function summarizeFryerProps(results) {
  const map = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    if (r && r.code === 0 && 'value' in r) map.set(`${r.siid}.${r.piid}`, r.value);
  }
  const statusCode = map.get('2.1');
  return {
    statusCode,
    statusText: statusCode === undefined ? '未知' : (FRYER_STATUS_MAP[statusCode] ?? `未知(${statusCode})`),
    fault: map.get('2.2'),
    targetTimeMin: map.get('2.3'),
    targetTempC: map.get('2.4'),
    leftTimeMin: map.get('2.5'),
    recipeId: map.get('3.1'),
    recipeName: decodeEscapedUnicode(map.get('3.2')),
    appointMinutes: map.get('3.5'),
    foodQuantity: map.get('3.6'),
    preheatSwitch: map.get('3.7'),
    appointLeftMin: map.get('3.8'),
    turnPot: map.get('3.10'),
  };
}

function describeFryer(s) {
  const parts = [`空气炸锅：${s.statusText}`];
  if ([2, 3, 4, 5, 7, 8, 9].includes(s.statusCode)) {
    if (s.targetTempC !== undefined) parts.push(`目标 ${s.targetTempC}℃`);
    if (s.targetTimeMin !== undefined) parts.push(`设定 ${s.targetTimeMin} 分钟`);
    if (s.leftTimeMin !== undefined) parts.push(`剩余 ${s.leftTimeMin} 分钟`);
    if (s.recipeName) parts.push(`模式 ${s.recipeName}`);
  }
  if (s.fault) parts.push(`故障码 ${s.fault}`);
  return parts.join('，');
}

async function miioCall(ctx, device, method, params) {
  let tokenHex = ctx.snapshot?.tokenByDid?.[device.did];
  if (!tokenHex) throw new MiotError(`设备 ${fullName(device)} 缺少 token（中枢未下发），无法局域网直控。`);
  if (!device.ip) throw new MiotError(`设备 ${fullName(device)} 缺少局域网 IP。`);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await ctx.udp({ ip: device.ip, tokenHex, method, params, timeoutMs: ctx.cfg.udpTimeoutMs });
      if (reply && reply.error) {
        throw new MiotError(`设备返回错误：${reply.error.message ?? JSON.stringify(reply.error)}${reply.error.code !== undefined ? ` (code=${reply.error.code})` : ''}`);
      }
      return reply;
    } catch (e) {
      lastErr = e;
      if (e instanceof MiotError && /设备返回错误/.test(e.message)) throw e;
    }
  }
  if (ctx.snapshot?.source === 'cache' && (ctx.snapshot.ageMs ?? 0) > 5_000) {
    try {
      const refreshed = await loadSnapshot(ctx, { refresh: true, needHotData: false });
      const updated = refreshed.devices.find(d => String(d.did) === String(device.did));
      const nextToken = refreshed.tokenByDid?.[device.did];
      const nextIp = updated?.ip || device.ip;
      if (updated && nextIp && nextToken) {
        device.ip = nextIp;
        tokenHex = nextToken;
        const reply = await ctx.udp({ ip: nextIp, tokenHex: nextToken, method, params, timeoutMs: ctx.cfg.udpTimeoutMs });
        if (reply && reply.error) {
          throw new MiotError(`设备返回错误：${reply.error.message ?? JSON.stringify(reply.error)}${reply.error.code !== undefined ? ` (code=${reply.error.code})` : ''}`);
        }
        return reply;
      }
    } catch (retryErr) {
      lastErr = retryErr;
    }
  }
  throw lastErr;
}

async function fryerStatus(ctx, device) {
  const reply = await miioCall(ctx, device, 'get_properties', buildFryerGetParams(device.did));
  return summarizeFryerProps(Array.isArray(reply?.result) ? reply.result : []);
}

// ---------------------------------------------------------------------------
// Context, hub snapshot loading
// ---------------------------------------------------------------------------

function routerTarget(ctx) {
  return parseSshSpec(ctx.cfg.routerSsh, 'router');
}

function makeCtx(args, deps) {
  const safeDeps = deps && typeof deps === 'object' ? deps : {};
  const paths = getRuntimePaths(safeDeps);
  const stored = loadConfig(paths);
  const cfg = {
    ...stored,
    routerSsh: typeof args.routerSsh === 'string' && args.routerSsh.trim() ? args.routerSsh.trim() : stored.routerSsh,
    speakerSsh: typeof args.speakerSsh === 'string' && args.speakerSsh.trim() ? args.speakerSsh.trim() : stored.speakerSsh,
    cacheTtlMs: clampInt(args.cacheTtlMs, 0, 3_600_000) ?? stored.cacheTtlMs,
    topologyTtlMs: clampInt(args.topologyTtlMs, 0, 3_600_000) ?? stored.topologyTtlMs,
    udpTimeoutMs: clampInt(args.udpTimeoutMs, 300, 30_000) ?? stored.udpTimeoutMs,
  };
  const sshBin = safeDeps.sshBinaryExec
    ?? ((target, cmd, opts = {}) => defaultSshBinaryExec(target, cmd, {
      ...opts,
      homeDir: paths.homeDir,
      signal: safeDeps.signal,
    }));
  const sshText = safeDeps.sshTextExec
    ?? ((target, cmd, timeoutMs) => defaultSshTextExec(target, cmd, timeoutMs, {
      homeDir: paths.homeDir,
      signal: safeDeps.signal,
    }));
  const tvRun = safeDeps.tvAgentRunner
    ?? (typeof safeDeps.callPlugin === 'function'
      ? (action, tvArgs) => safeDeps.callPlugin('tv-agent', action, tvArgs)
      : (action, tvArgs) => defaultTvAgentRunner(action, tvArgs, paths, safeDeps));
  const sleepFn = typeof safeDeps.sleepFn === 'function'
    ? safeDeps.sleepFn
    : (ms => delay(ms, undefined, safeDeps.signal ? { signal: safeDeps.signal } : undefined));
  const getRouterTarget = () => parseSshSpec(cfg.routerSsh, 'router');
  return {
    args,
    deps: safeDeps,
    paths,
    cfg,
    sshBin,
    sshText,
    udp: safeDeps.udpCall ?? udpCall,
    sleep: sleepFn,
    now: safeDeps.nowFn ?? Date.now,
    fetchRows: safeDeps.fetchHubRawRows ?? (opts => defaultFetchHubRawRows({ ...opts, homeDir: paths.homeDir, sshBinaryExec: sshBin })),
    centralMipsCall: safeDeps.centralMipsCall ?? ((topic, payload = {}, opts = {}) => callCentralMipsApi({
      target: getRouterTarget(),
      sshBin,
      topic,
      payload,
      ...opts,
    })),
    fetchCentralOverview: safeDeps.fetchCentralOverview ?? ((opts = {}) => defaultFetchCentralOverview({
      target: getRouterTarget(),
      sshText,
      ...opts,
    })),
    tvRun,
    snapshot: undefined,
  };
}

function defaultTvAgentRunner(action, args, paths = {}, deps = {}) {
  return import('../tv-agent/index.mjs').then(mod =>
    mod.runAction(action, args, {
      homeDir: paths.homeDir,
      signal: deps.signal,
      callPlugin: deps.callPlugin,
    }),
  );
}

function extractTar(tarBuffer, destDir) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('tar', ['-xf', '-', '-C', destDir, '--no-same-owner'], { stdio: ['pipe', 'ignore', 'pipe'] });
    const err = [];
    child.stderr.on('data', c => err.push(c));
    child.on('error', rejectPromise);
    child.on('close', code => {
      if (code === 0) resolvePromise();
      else rejectPromise(new MiotError(`解包中枢数据库失败：${Buffer.concat(err).toString('utf8').trim().slice(0, 200)}`));
    });
    child.stdin.on('error', () => { /* handled by close */ });
    child.stdin.end(tarBuffer);
  });
}

/**
 * Stream the hub's devInfo.db (+ optional hot_data_v2.db) over SSH into a temp dir and read them with node:sqlite.
 * @param {{ target?: any; sshBinaryExec?: Function; timeoutMs?: number; includeHotData?: boolean; homeDir?: string }} [opts]
 * @returns {Promise<{ devInfoRows: any[]; hotDataRows: any[] }>}
 */
export async function defaultFetchHubRawRows({
  target,
  sshBinaryExec = defaultSshBinaryExec,
  timeoutMs = HUB_FETCH_TIMEOUT_MS,
  includeHotData = true,
  homeDir,
} = {}) {
  const tarCmd = includeHotData === false ? HUB_DEVINFO_TAR_COMMAND : HUB_TAR_COMMAND;
  const res = await sshBinaryExec(target, tarCmd, { timeoutMs });
  const stdout = Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout ?? '');
  if (res.code !== 0 || stdout.length === 0) {
    throw new MiotError(`无法从中枢 ${target.userHost} 读取设备库 (ssh code=${res.code})：${String(res.stderr ?? '').trim().slice(0, 200) || '无输出'}`);
  }
  let baseTmpDir;
  try {
    const resolvedHome = typeof homeDir === 'string' && homeDir.trim() ? homeDir.trim() : resolveHomeDir();
    baseTmpDir = resolvePrivateRunDir(resolvedHome);
  } catch {
    baseTmpDir = tmpdir();
  }
  const tmp = mkdtempSync(join(baseTmpDir, 'friday-miot-'));
  chmodSync(tmp, 0o700);
  let devDb;
  let hotDb;
  try {
    await extractTar(stdout, tmp);
    const { DatabaseSync } = await import('node:sqlite');
    devDb = new DatabaseSync(join(tmp, 'share/custom/devInfo/devInfo.db'), { readOnly: true });
    const devInfoRows = devDb.prepare('SELECT * FROM device_v4').all().map(r => ({ ...r }));
    let hotDataRows = [];
    if (includeHotData !== false) {
      try {
        hotDb = new DatabaseSync(join(tmp, 'local/hotdatasync/hot_data_v2.db'), { readOnly: true });
        hotDataRows = hotDb.prepare('SELECT key, value FROM appMsg').all().map(r => ({ key: r.key, value: r.value }));
      } catch {
        hotDataRows = [];
      }
    }
    return { devInfoRows, hotDataRows };
  } finally {
    try { devDb?.close(); } catch { /* ignore */ }
    try { hotDb?.close(); } catch { /* ignore */ }
    rmSync(tmp, { recursive: true, force: true });
  }
}

const HUB_MEMORY_CACHE = (globalThis.__fridayMiotHubMemoryCache ??= new Map());

function fileSig(filePath) {
  try {
    if (!filePath || !existsSync(filePath)) return '';
    const st = statSync(filePath);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

function normalizeTokenMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && HEX32_RE.test(v.trim())) {
      out[k] = v.trim();
    }
  }
  return out;
}

function normalizeHubCacheRecord(raw, tokenRaw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.devices) || typeof raw.fetchedAt !== 'number') return undefined;
  const legacyTokens = normalizeTokenMap(raw.tokenByDid);
  const isolatedTokens = normalizeTokenMap(tokenRaw?.tokenByDid ?? tokenRaw);
  return {
    homeId: String(raw.homeId ?? ''),
    fetchedAt: raw.fetchedAt,
    hotDataFetchedAt: typeof raw.hotDataFetchedAt === 'number' ? raw.hotDataFetchedAt : raw.fetchedAt,
    ...(typeof raw.liveFetchedAt === 'number' ? { liveFetchedAt: raw.liveFetchedAt } : {}),
    devices: raw.devices,
    tokenByDid: { ...legacyTokens, ...isolatedTokens },
  };
}

function readHubCache(paths) {
  const mem = HUB_MEMORY_CACHE.get(paths.cachePath);
  const cacheSig = fileSig(paths.cachePath);
  const tokenSig = fileSig(paths.tokenCachePath);
  try {
    if (cacheSig) {
      if (mem && mem.cacheSig === cacheSig && mem.tokenSig === tokenSig) {
        return mem.snapshot;
      }
      const raw = JSON.parse(readFileSync(paths.cachePath, 'utf8'));
      let tokenRaw = null;
      if (tokenSig) {
        try {
          tokenRaw = JSON.parse(readFileSync(paths.tokenCachePath, 'utf8'));
        } catch {
          tokenRaw = null;
        }
      }
      const snapshot = normalizeHubCacheRecord(raw, tokenRaw);
      if (snapshot) {
        HUB_MEMORY_CACHE.set(paths.cachePath, { cacheSig, tokenSig, snapshot });
        return snapshot;
      }
    } else if (mem) {
      HUB_MEMORY_CACHE.delete(paths.cachePath);
    }
  } catch {
    /* fallback to memory cache if any */
  }
  return mem?.snapshot;
}

function writeHubCache(paths, snapshot) {
  const normalized = normalizeHubCacheRecord(snapshot);
  if (!normalized) return;
  try {
    const publicCache = {
      version: 1,
      homeId: normalized.homeId,
      fetchedAt: normalized.fetchedAt,
      hotDataFetchedAt: normalized.hotDataFetchedAt,
      ...(typeof normalized.liveFetchedAt === 'number' ? { liveFetchedAt: normalized.liveFetchedAt } : {}),
      devices: normalized.devices,
    };
    writeSecureJson(paths.cachePath, publicCache);
    if (paths.tokenCachePath) {
      writeSecureJson(paths.tokenCachePath, {
        version: 1,
        fetchedAt: normalized.fetchedAt,
        tokenByDid: normalized.tokenByDid,
      });
    }
  } catch {
    /* cache is best effort */
  }
  HUB_MEMORY_CACHE.set(paths.cachePath, {
    cacheSig: fileSig(paths.cachePath),
    tokenSig: fileSig(paths.tokenCachePath),
    snapshot: normalized,
  });
}

function invalidateHubCache(paths) {
  HUB_MEMORY_CACHE.delete(paths.cachePath);
  try {
    rmSync(paths.cachePath, { force: true });
  } catch {
    /* ignore */
  }
  if (paths.tokenCachePath) {
    try {
      rmSync(paths.tokenCachePath, { force: true });
    } catch {
      /* ignore */
    }
  }
  if (paths.centralCachePath) {
    try {
      rmSync(paths.centralCachePath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Load the hub snapshot honouring cacheTtlMs (hotData) and topologyTtlMs (devInfo); falls back to stale cache on SSH failure. */
async function loadSnapshot(ctx, { refresh = false, needHotData = true } = {}) {
  const now = ctx.now();
  const cached = readHubCache(ctx.paths);
  if (cached && !refresh) {
    if (needHotData) {
      const hotFetchedAt = typeof cached.hotDataFetchedAt === 'number' ? cached.hotDataFetchedAt : cached.fetchedAt;
      if (hotFetchedAt > 0 && now - hotFetchedAt <= ctx.cfg.cacheTtlMs && now >= hotFetchedAt) {
        ctx.snapshot = { ...cached, source: 'cache', ageMs: now - hotFetchedAt };
        return ctx.snapshot;
      }
    } else if (now - cached.fetchedAt <= ctx.cfg.topologyTtlMs && now >= cached.fetchedAt) {
      ctx.snapshot = { ...cached, source: 'cache', ageMs: now - cached.fetchedAt };
      return ctx.snapshot;
    }
  }
  try {
    const includeHotData = Boolean(needHotData);
    const rows = await ctx.fetchRows({
      target: routerTarget(ctx),
      refresh,
      includeHotData,
      timeoutMs: HUB_FETCH_TIMEOUT_MS,
    });
    const hotDataFetchedAt = includeHotData ? now : (cached?.hotDataFetchedAt ?? 0);
    const parsed = parseHubSnapshot({ ...rows, nowMs: now, hotDataFetchedAt });
    if (typeof cached?.liveFetchedAt === 'number') {
      parsed.liveFetchedAt = cached.liveFetchedAt;
    }
    if (!includeHotData && cached && Array.isArray(cached.devices)) {
      const prevStateByDid = new Map(cached.devices.map(d => [d.did, d.cachedState]));
      for (const dev of parsed.devices) {
        const prev = prevStateByDid.get(dev.did);
        if (!prev) continue;
        const hasNewProps = dev.cachedState?.properties && Object.keys(dev.cachedState.properties).length > 0;
        if (!hasNewProps) {
          dev.cachedState = prev;
        }
      }
    }
    writeHubCache(ctx.paths, parsed);
    ctx.snapshot = { ...parsed, source: 'hub', ageMs: 0 };
    return ctx.snapshot;
  } catch (err) {
    if (cached) {
      ctx.snapshot = { ...cached, source: 'stale', ageMs: now - cached.fetchedAt, staleReason: errMsg(err) };
      return ctx.snapshot;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function parseBoolish(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'on', 'yes', '开', '打开', '开启', '开机'].includes(v)) return true;
    if (['false', '0', 'off', 'no', '关', '关闭', '关掉', '关机'].includes(v)) return false;
    if (v === 'toggle' || v === '切换') return 'toggle';
  }
  return undefined;
}

function coerceValue(value) {
  if (typeof value === 'string') {
    const t = value.trim();
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  }
  return value;
}

function isDry(args) {
  return args.dryRun === true || args.dryRun === 'true';
}

function stateText(device, live) {
  if (live?.fryer) return live.fryer.statusText;
  if (live && live.on !== undefined) return live.on ? '开' : '关';
  const on = cachedOn(device);
  if (on !== undefined) return on ? '开' : '关';
  return '';
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleStatus(ctx) {
  const routerSpec = /** @type {any} */ ((() => { try { return routerTarget(ctx); } catch (e) { return { error: errMsg(e) }; } })());
  const speakerSpec = /** @type {any} */ (await discoverSpeakerSsh({ speakerSsh: ctx.args.speakerSsh, dataDir: ctx.paths.dataDir, homeDir: ctx.paths.homeDir }).catch(e => ({ error: errMsg(e) })));
  /** @param {any} target @param {string} cmd @returns {Promise<{ reachable: boolean; code?: number; ms?: number; out: string; err?: string; error?: string }>} */
  const probe = async (target, cmd) => {
    const startedAt = ctx.now();
    try {
      const res = await ctx.sshText(target, cmd, 8_000);
      return { reachable: res.code === 0 && /FRIDAY_OK/.test(res.stdout), code: res.code, ms: ctx.now() - startedAt, out: String(res.stdout ?? ''), err: String(res.stderr ?? '').trim().slice(0, 160) };
    } catch (e) {
      return { reachable: false, error: errMsg(e), ms: ctx.now() - startedAt, out: '' };
    }
  };
  const [router, spk] = await Promise.all([
    routerSpec.error
      ? Promise.resolve(/** @type {{ reachable: boolean; code?: number; ms?: number; out: string; err?: string; error?: string }} */ ({ reachable: false, error: routerSpec.error, out: '' }))
      : probe(routerSpec, 'echo FRIDAY_OK; pidof central_service | awk \'{print $1}\''),
    speakerSpec.error
      ? Promise.resolve(/** @type {{ reachable: boolean; code?: number; ms?: number; out: string; err?: string; error?: string }} */ ({ reachable: false, error: speakerSpec.error, out: '' }))
      : probe(speakerSpec, 'echo FRIDAY_OK; ubus list 2>/dev/null | grep -c mibrain'),
  ]);
  const centralPid = router.reachable ? (router.out.split('\n').map(s => s.trim()).filter(s => /^\d+$/.test(s))[0] ?? null) : null;
  const mibrain = spk.reachable ? Number((spk.out.split('\n').map(s => s.trim()).filter(s => /^\d+$/.test(s))[0] ?? '0')) > 0 : false;
  const cache = readHubCache(ctx.paths);
  const now = ctx.now();
  const hotFetchedAt = cache ? (typeof cache.hotDataFetchedAt === 'number' ? cache.hotDataFetchedAt : cache.fetchedAt) : 0;
  const speakerInfo = speakerSpec.error
    ? { id: null, ssh: '', source: 'none', reachable: false, mibrain: false, ...(spk.error ? { error: spk.error } : {}) }
    : { id: speakerSpec.id, ssh: `${speakerSpec.userHost}${speakerSpec.port ? `:${speakerSpec.port}` : ''}`, source: speakerSpec.source, reachable: spk.reachable, mibrain, ms: spk.ms, ...(spk.error || spk.err ? { error: spk.error ?? spk.err } : {}) };
  const data = {
    router: { ssh: ctx.cfg.routerSsh, reachable: router.reachable, centralServicePid: centralPid, ms: router.ms, ...(router.error || router.err ? { error: router.error ?? router.err } : {}) },
    speaker: speakerInfo,
    cache: cache ? {
      exists: true,
      deviceCount: cache.devices.length,
      ageMs: Math.max(0, now - cache.fetchedAt),
      hotDataAgeMs: Math.max(0, now - hotFetchedAt),
      fresh: hotFetchedAt > 0 && now - hotFetchedAt <= ctx.cfg.cacheTtlMs,
      topologyFresh: now - cache.fetchedAt <= ctx.cfg.topologyTtlMs,
    } : { exists: false },
    config: ctx.cfg,
  };
  const lines = [
    `中枢 ${ctx.cfg.routerSsh}：${router.reachable ? `可达${centralPid ? `（central_service pid ${centralPid}）` : '（未发现 central_service 进程）'}` : `不可达${router.error ? `（${router.error}）` : ''}`}`,
    speakerSpec.error
      ? `小爱音箱（未配置）：${spk.error}`
      : `小爱音箱 ${speakerSpec.id}（${data.speaker.ssh}，来源 ${speakerSpec.source}）：${spk.reachable ? `可达${mibrain ? '，mibrain 可用' : '，未发现 mibrain'}` : `不可达${spk.error ? `（${spk.error}）` : ''}`}`,
    cache ? `设备缓存：${cache.devices.length} 台，${Math.round(data.cache.ageMs / 1000)} 秒前` : '设备缓存：无',
  ];
  const ok = router.reachable;
  return (ok ? success : failure)(ok ? '米家状态' : '米家中枢不可达', lines.join('\n'), data);
}

function applyDeviceFilters(devices, args) {
  let list = devices;
  if (args.room) list = list.filter(d => roomMatches(d, args.room));
  if (args.category) {
    const q = String(args.category).trim().toLowerCase().replace(/\s+/g, '');
    const key = Object.entries(CATEGORY_ALIASES).find(([k, names]) => k === q || names.some(n => n.toLowerCase() === q))?.[0];
    if (key) list = list.filter(d => d.categories.includes(key));
    else list = list.filter(d => d.categories.some(c => c.includes(q)) || (d.dev_name ?? d.name ?? '').toLowerCase().includes(q));
  }
  if (args.controllableOnly === true || args.controllableOnly === 'true') list = list.filter(d => d.controllable);
  return list;
}

async function liveForDevices(ctx, devices) {
  const live = new Map();
  const mesh = devices.filter(d => d.controlChannel === 'bt_mesh' && d.controllable);
  const fryers = devices.filter(d => d.category === 'air_fryer' && d.controlChannel === 'miio_udp');
  if (mesh.length > 0) {
    try {
      const results = await bleGetProperties(ctx, mesh.map(d => ({ did: d.did, siid: 2, piid: 1 })));
      for (const d of mesh) {
        const r = results.find(x => x.did === d.did && x.siid === 2 && x.piid === 1);
        if (r && r.code === 0) live.set(d.did, { on: r.value === true || r.value === 1, source: 'live' });
        else live.set(d.did, { error: r ? `读取失败 code=${r.code}（设备可能离线）` : '无返回' });
      }
    } catch (e) {
      for (const d of mesh) live.set(d.did, { error: errMsg(e) });
    }
  }
  for (const d of fryers) {
    try {
      live.set(d.did, { fryer: await fryerStatus(ctx, d), source: 'live' });
    } catch (e) {
      live.set(d.did, { error: errMsg(e) });
    }
  }
  return live;
}

function persistLiveStates(ctx, snap, live, isUnfiltered) {
  const now = ctx.now();
  let mergedAny = false;
  const updatedDevices = snap.devices.map(dev => {
    const l = live.get(dev.did);
    if (dev.controlChannel === 'bt_mesh' && l && l.on !== undefined) {
      const prevCached = dev.cachedState && typeof dev.cachedState === 'object' ? dev.cachedState : { properties: {} };
      const prevProps = prevCached.properties && typeof prevCached.properties === 'object' ? prevCached.properties : {};
      mergedAny = true;
      return {
        ...dev,
        cachedState: {
          ...prevCached,
          properties: {
            ...prevProps,
            '2.1': { value: Boolean(l.on), ts: now },
          },
        },
      };
    }
    return dev;
  });
  const anyLiveOk = live.size === 0 || [...live.values()].some(entry => entry && !entry.error);
  if (mergedAny || (isUnfiltered && anyLiveOk)) {
    const nextLiveFetchedAt = isUnfiltered && anyLiveOk ? now : snap.liveFetchedAt;
    writeHubCache(ctx.paths, {
      ...snap,
      devices: updatedDevices,
      ...(typeof nextLiveFetchedAt === 'number' ? { liveFetchedAt: nextLiveFetchedAt } : {}),
    });
    return { devices: updatedDevices, liveFetchedAt: nextLiveFetchedAt };
  }
  return { devices: snap.devices, liveFetchedAt: snap.liveFetchedAt };
}

async function handleDevices(ctx) {
  const { args } = ctx;
  const snap = await loadSnapshot(ctx, { refresh: args.refresh === true || args.refresh === 'true', needHotData: true });
  const filtered = applyDeviceFilters(snap.devices, args);
  const wantLive = args.live === true || args.live === 'true';
  const live = wantLive ? await liveForDevices(ctx, filtered) : new Map();
  let liveFetchedAt = snap.liveFetchedAt;
  if (wantLive) {
    const isUnfiltered = !args.room && !args.category && !(args.controllableOnly === true || args.controllableOnly === 'true');
    liveFetchedAt = persistLiveStates(ctx, snap, live, isUnfiltered).liveFetchedAt;
  }
  const items = filtered.map(d => {
    const l = live.get(d.did);
    const extra = {};
    if (l?.fryer) extra.fryer = l.fryer;
    if (l && l.on !== undefined) extra.state = { on: l.on, source: 'live' };
    if (l?.error) extra.liveError = l.error;
    return publicDevice(d, extra);
  });
  const rooms = new Map();
  for (const d of filtered) {
    const room = d.room_name || '未分区';
    const st = stateText(d, live.get(d.did));
    const label = `${d.dev_name}${st ? `(${st})` : ''}${d.controllable ? '' : '[不可控]'}`;
    if (!rooms.has(room)) rooms.set(room, []);
    rooms.get(room).push(label);
  }
  const lines = [...rooms.entries()].map(([room, labels]) => `${room}：${labels.join('、')}`);
  const counts = {};
  for (const d of filtered) counts[d.category] = (counts[d.category] ?? 0) + 1;
  const note = snap.source === 'stale' ? `（中枢暂不可达，使用 ${Math.round(snap.ageMs / 1000)} 秒前的缓存）` : '';
  const message = filtered.length
    ? `共 ${filtered.length} 台设备${wantLive ? '（含实时状态）' : '（状态为中枢缓存）'}${note}：\n${lines.join('\n')}`
    : '没有符合条件的设备。';
  return success('米家设备', message, {
    homeId: snap.homeId,
    fetchedAt: snap.fetchedAt,
    hotDataFetchedAt: snap.hotDataFetchedAt,
    ...(typeof liveFetchedAt === 'number' ? { liveFetchedAt } : {}),
    source: snap.source,
    ageMs: snap.ageMs,
    live: wantLive,
    count: items.length,
    counts,
    devices: items,
    ...(snap.staleReason ? { staleReason: snap.staleReason } : {}),
  });
}

/** @param {any} ctx @param {{ defaultCategory?: string; refresh?: boolean; needHotData?: boolean }} [opts] */
async function resolveFromArgs(ctx, { defaultCategory = undefined, refresh = undefined, needHotData = false } = /** @type {{ defaultCategory?: string; refresh?: boolean; needHotData?: boolean }} */ ({})) {
  const explicitRefresh = refresh ?? (ctx.args.refresh === true || ctx.args.refresh === 'true');
  let snap = await loadSnapshot(ctx, { refresh: explicitRefresh, needHotData });
  const { device, did, room } = ctx.args;
  const pickDefaultCategory = currentSnap => {
    const hits = currentSnap.devices.filter(d => d.category === defaultCategory && (!room || roomMatches(d, room)));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw ambiguityError(CATEGORY_LABELS[defaultCategory] ?? defaultCategory, hits);
    return undefined;
  };
  if (defaultCategory && !device && !did) {
    const hit = pickDefaultCategory(snap);
    if (hit) return hit;
    if (!explicitRefresh && snap.source === 'cache' && (snap.ageMs ?? 0) > 5_000) {
      snap = await loadSnapshot(ctx, { refresh: true, needHotData });
      const retryHit = pickDefaultCategory(snap);
      if (retryHit) return retryHit;
    }
  }
  try {
    return resolveDevice(snap.devices, { device, did, room, customAliases: ctx.cfg.customAliases });
  } catch (err) {
    if (
      err instanceof MiotError &&
      err.code === 'DEVICE_NOT_FOUND' &&
      !explicitRefresh &&
      snap.source === 'cache' &&
      (snap.ageMs ?? 0) > 5_000
    ) {
      snap = await loadSnapshot(ctx, { refresh: true, needHotData });
      return resolveDevice(snap.devices, { device, did, room, customAliases: ctx.cfg.customAliases });
    }
    throw err;
  }
}

function failFromError(title, err) {
  if (err instanceof MiotError && err.code === 'AMBIGUOUS_DEVICE') {
    return failure('设备指代不明', err.message, {
      code: err.code,
      needsClarification: true,
      ...(err.data ?? {}),
    });
  }
  if (err instanceof MiotError) {
    const data = err.code || err.data
      ? { ...(err.code ? { code: err.code } : {}), ...(err.data ?? {}) }
      : undefined;
    return failure(title, errMsg(err), data);
  }
  return failure(title, errMsg(err), undefined);
}

async function handleGet(ctx) {
  let device;
  try {
    device = await resolveFromArgs(ctx, { needHotData: true });
  } catch (err) {
    return failFromError('米家设备查询失败', err);
  }
  const name = fullName(device);
  const base = publicDevice(device);
  try {
    if (device.controlChannel === 'bt_mesh') {
      const results = await bleGetProperties(ctx, [{ did: device.did, siid: 2, piid: 1 }]);
      const r = results.find(x => x.siid === 2 && x.piid === 1);
      if (!r || r.code !== 0) {
        const cached = cachedOn(device);
        return failure('米家设备查询失败', `${name} 实时读取失败（code=${r?.code ?? '无返回'}，设备可能离线）${cached !== undefined ? `；中枢缓存显示${cached ? '开' : '关'}` : ''}`, { device: base, live: false, results });
      }
      const on = r.value === true || r.value === 1;
      return success('米家设备状态', `${name}：${on ? '已打开' : '已关闭'}`, { device: { ...base, state: { on, source: 'live' } }, live: true, on, properties: results });
    }
    if (device.category === 'air_fryer' && device.controlChannel === 'miio_udp') {
      await loadSnapshotIfNeeded(ctx, { needHotData: false });
      const s = await fryerStatus(ctx, device);
      return success('空气炸锅状态', describeFryer(s), { device: base, live: true, fryer: s });
    }
    if (device.controlChannel === 'tv_agent') {
      const res = await ctx.tvRun('status', {});
      const { apps: _apps, ...rest } = (res?.data && typeof res.data === 'object') ? res.data : {};
      return (res?.ok === false ? failure : success)('电视状态', res?.message ?? '电视状态已读取', { device: base, live: true, tv: rest });
    }
    if (device.controlChannel === 'xiaoai_nlp') {
      return success('米家设备状态', `${name} 是红外虚拟设备，无法读取真实运行状态；可用 set 发送控制指令。`, { device: base, live: false, note: 'ir_virtual_device' });
    }
    if (device.controlChannel === 'router') {
      return success('米家设备状态', `${name}（${device.model_name || device.model}）${device.online ? '在线' : '离线'}，路由器仅作中枢，不可控制。`, { device: base, live: false });
    }
    return success('米家设备状态', `${name}：${device.online ? '在线' : '离线'}（该设备类型暂无实时读取通道，返回中枢缓存）`, { device: { ...base, cachedState: device.cachedState }, live: false });
  } catch (err) {
    return failFromError('米家设备查询失败', err);
  }
}

async function loadSnapshotIfNeeded(ctx, { needHotData = false } = {}) {
  if (!ctx.snapshot) await loadSnapshot(ctx, { needHotData });
}

// ---- set ------------------------------------------------------------------

function normalizeAcMode(mode) {
  const key = String(mode ?? '').trim().toLowerCase();
  return AC_MODE_ZH[key];
}

function normalizeAcFan(fan) {
  const key = String(fan ?? '').trim().toLowerCase();
  return AC_FAN_ZH[key];
}

/**
 * Compose room-prefixed Chinese XiaoAI instructions for an IR air conditioner.
 * @param {any} device
 * @param {{ on?: unknown; toggle?: boolean; temperature?: unknown; mode?: unknown; fanSpeed?: unknown }} [opts]
 */
export function buildAcInstructions(device, { on = undefined, toggle = undefined, temperature = undefined, mode = undefined, fanSpeed = undefined } = /** @type {{ on?: unknown; toggle?: boolean; temperature?: unknown; mode?: unknown; fanSpeed?: unknown }} */ ({})) {
  const name = fullName(device);
  const texts = [];
  const onValue = parseBoolish(on);
  if (toggle === true || onValue === 'toggle') {
    throw new MiotError('红外空调无法读取当前状态，不支持 toggle，请明确指定 on:true 或 on:false。');
  }
  if (onValue === true) texts.push(`打开${name}`);
  else if (onValue === false) texts.push(`关闭${name}`);
  if (temperature !== undefined && temperature !== null && temperature !== '') {
    const t = clampInt(temperature, 16, 31);
    if (t === undefined) throw new MiotError(`无效的温度 "${temperature}"（16-31）。`);
    texts.push(`把${name}调到${t}度`);
  }
  if (mode !== undefined && mode !== null && mode !== '') {
    const m = normalizeAcMode(mode);
    if (!m) throw new MiotError(`不支持的空调模式 "${mode}"，可用：cool/heat/auto/dry/fan（制冷/制热/自动/除湿/送风）。`);
    texts.push(`${name}设为${m}模式`);
  }
  if (fanSpeed !== undefined && fanSpeed !== null && fanSpeed !== '') {
    const f = normalizeAcFan(fanSpeed);
    if (!f) throw new MiotError(`不支持的风速 "${fanSpeed}"，可用：auto/low/medium/high。`);
    texts.push(`把${name}风速调到${f === '自动' ? '自动' : `${f}档`}`);
  }
  return texts;
}

/** `ubus -t 5 call mibrain ai_service '{...}'` for a silent (or spoken) XiaoAI NLP instruction. */
export function buildMibrainCommand(text, { speakReply = false } = {}) {
  const payload = JSON.stringify({
    nlp: 1,
    nlp_execute: 1,
    nlp_text: text,
    tts: speakReply ? 1 : 0,
    tts_play: speakReply ? 1 : 0,
  });
  return `ubus -t 5 call mibrain ai_service ${shQuote(payload)}`;
}

function cleanNlpText(text) {
  const t = String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) throw new MiotError('请提供要发送给小爱的 text。');
  if (t.length > MAX_NLP_TEXT) throw new MiotError(`指令过长（最多 ${MAX_NLP_TEXT} 字）。`);
  return t;
}

async function sendNlp(ctx, target, text, speakReply) {
  const res = await ctx.sshText(target, buildMibrainCommand(text, { speakReply }), 10_000);
  return { text, code: res.code, stdout: String(res.stdout ?? '').trim().slice(0, 300), stderr: String(res.stderr ?? '').trim().slice(0, 200) };
}

async function setViaNlp(ctx, device, texts, dryRun) {
  const speakReply = ctx.args.speakReply === true || ctx.args.speakReply === 'true';
  const speaker = await discoverSpeakerSsh({ speakerSsh: ctx.args.speakerSsh, dataDir: ctx.paths.dataDir, homeDir: ctx.paths.homeDir });
  const speakerView = { id: speaker.id, userHost: speaker.userHost, ...(speaker.port ? { port: speaker.port } : {}), source: speaker.source };
  if (dryRun) {
    return success('米家设备控制（预演）', `将通过 ${speaker.id} 发送：${texts.join('；')}`, {
      dryRun: true, transport: 'xiaoai_nlp', speaker: speakerView, instructions: texts,
      commands: texts.map(t => buildMibrainCommand(t, { speakReply })),
    });
  }
  const sent = [];
  for (const [i, text] of texts.entries()) {
    if (i > 0) await ctx.sleep(1500);
    const r = await sendNlp(ctx, speaker, text, speakReply);
    sent.push(r);
    if (r.code !== 0) {
      return failure('小爱指令发送失败', `发送 "${text}" 失败 (ssh code=${r.code})：${r.stderr || r.stdout || '无输出'}`, { transport: 'xiaoai_nlp', speaker: speakerView, sent });
    }
  }
  return success('米家设备控制', `已通过小爱发送：${texts.join('；')}（红外设备无状态回读）`, { transport: 'xiaoai_nlp', speaker: speakerView, sent });
}

export function findProtectedRuleForDevice(cfg, device) {
  const list = Array.isArray(cfg?.protectedDevices)
    ? cfg.protectedDevices.map(x => String(x ?? '').trim()).filter(Boolean)
    : [];
  if (list.length === 0 || !device || typeof device !== 'object') return null;

  const didNorm = norm(device.did);
  const devNameNorm = norm(device.dev_name ?? device.name);
  const roomNorm = norm(device.room_name ?? device.room);
  const fullNorm = norm(fullName(device));

  const deviceKeys = new Set(
    [
      didNorm,
      devNameNorm,
      roomNorm && devNameNorm ? `${roomNorm}${devNameNorm}` : '',
      fullNorm,
    ].filter(Boolean),
  );

  const customAliases = cfg?.customAliases;
  if (customAliases && typeof customAliases === 'object' && !Array.isArray(customAliases)) {
    for (const [aliasKey, aliasVal] of Object.entries(customAliases)) {
      const kNorm = norm(aliasKey);
      if (!kNorm) continue;
      if (Array.isArray(aliasVal)) {
        const valNorms = aliasVal.map(v => norm(v)).filter(Boolean);
        if (deviceKeys.has(kNorm) || valNorms.some(vn => deviceKeys.has(vn))) {
          deviceKeys.add(kNorm);
          for (const vn of valNorms) {
            deviceKeys.add(vn);
            if (roomNorm) deviceKeys.add(`${roomNorm}${vn}`);
          }
        }
      } else if (typeof aliasVal === 'string') {
        const vNorm = norm(aliasVal);
        if (vNorm && (deviceKeys.has(kNorm) || deviceKeys.has(vNorm))) {
          deviceKeys.add(kNorm);
          deviceKeys.add(vNorm);
          if (roomNorm) {
            deviceKeys.add(`${roomNorm}${kNorm}`);
            deviceKeys.add(`${roomNorm}${vNorm}`);
          }
        }
      }
    }
  }

  for (const rule of list) {
    const rNorm = norm(rule);
    if (rNorm && deviceKeys.has(rNorm)) {
      return rule;
    }
  }
  return null;
}

function assertNotProtected(ctx, device, title = '米家设备受保护') {
  const matchedRule = findProtectedRuleForDevice(ctx.cfg, device);
  if (!matchedRule) return null;
  const name = fullName(device);
  const base = publicDevice(device);
  return failure(
    title,
    `设备「${name}」已设为保护设备（规则：${matchedRule}），禁止控制。`,
    {
      blocked: true,
      reason: 'protected_device',
      protectedRule: matchedRule,
      device: base,
    },
  );
}

function parseMiotId(raw) {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return undefined;
  if (typeof raw === 'string' && !raw.trim()) return undefined;
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

async function handleSet(ctx) {
  const { args } = ctx;
  const dryRun = isDry(args);
  let device;
  try {
    device = await resolveFromArgs(ctx);
  } catch (err) {
    return failFromError('米家设备控制失败', err);
  }
  const blocked = assertNotProtected(ctx, device, '米家设备控制失败');
  if (blocked) return blocked;
  const name = fullName(device);
  const onValue = parseBoolish(args.on);
  const wantToggle = args.toggle === true || args.toggle === 'true' || onValue === 'toggle';
  const hasGeneric = args.siid !== undefined && args.piid !== undefined && args.value !== undefined;
  let genericSiid;
  let genericPiid;
  if (hasGeneric) {
    genericSiid = parseMiotId(args.siid);
    genericPiid = parseMiotId(args.piid);
    if (genericSiid === undefined || genericPiid === undefined) {
      return failure('米家设备控制失败', 'siid 与 piid 必须为非负整数。', { device: publicDevice(device) });
    }
  }
  const base = publicDevice(device);

  try {
    if (!device.controllable) {
      return failure('米家设备控制失败', `${name} 不可控制（${device.controlChannel === 'router' ? '路由器仅作中枢' : '未知连接类型'}）。`, { device: base });
    }

    // ---- TV (tv-agent) ----
    if (device.controlChannel === 'tv_agent') {
      if (onValue === undefined && !wantToggle) {
        return failure('电视控制失败', `电视仅支持电源控制：请传 on:true / on:false / toggle:true。音量、应用等请使用 tv-agent 插件。`, { device: base });
      }
      const state = wantToggle ? 'toggle' : (onValue ? 'on' : 'off');
      if (dryRun) {
        return success('米家设备控制（预演）', `将调用 tv-agent power state=${state}`, { dryRun: true, transport: 'tv_agent', plan: { action: 'power', args: { state } }, device: base });
      }
      const res = await ctx.tvRun('power', { state });
      return (res?.ok === false ? failure : success)('电视电源', res?.message ?? `电视电源 ${state} 已执行`, { transport: 'tv_agent', state, tv: res?.data, device: base });
    }

    // ---- IR AC / other IR devices (XiaoAI NLP) ----
    if (device.controlChannel === 'xiaoai_nlp') {
      if (hasGeneric) {
        return failure('米家设备控制失败', `${name} 是红外虚拟设备，不支持 siid/piid 属性写入；请使用 on / temperature / mode / fanSpeed。`, { device: base });
      }
      if (device.category !== 'air_conditioner') {
        return failure('米家设备控制失败', `${name} 的红外控制暂只支持空调；其他请用 command 发送自然语言。`, { device: base });
      }
      const texts = buildAcInstructions(device, { on: args.on, toggle: wantToggle, temperature: args.temperature, mode: args.mode, fanSpeed: args.fanSpeed });
      if (texts.length === 0) {
        return failure('米家设备控制失败', `请为 ${name} 指定 on、temperature、mode 或 fanSpeed。`, { device: base });
      }
      const res = await setViaNlp(ctx, device, texts, dryRun);
      return { ...res, data: { ...(res.data ?? {}), device: base } };
    }

    // ---- BLE Mesh lights / switches / outlets ----
    if (device.controlChannel === 'bt_mesh') {
      if (hasGeneric) {
        const item = { did: device.did, siid: /** @type {number} */ (genericSiid), piid: /** @type {number} */ (genericPiid), value: coerceValue(args.value) };
        if (dryRun) {
          return success('米家设备控制（预演）', `将向 ${name} 写入 ${item.siid}.${item.piid}=${JSON.stringify(item.value)}`, { dryRun: true, transport: 'bt_mesh', plan: { method: 'set_properties', params: [item] }, device: base });
        }
        const results = await bleSetProperties(ctx, [item]);
        return checkWrite(name, results, `已写入 ${name} ${item.siid}.${item.piid}=${JSON.stringify(item.value)}`, base);
      }
      if (onValue === undefined && !wantToggle) {
        return failure('米家设备控制失败', `请为 ${name} 指定 on:true / on:false / toggle:true，或 siid/piid/value。`, { device: base });
      }
      if (dryRun) {
        const plan = wantToggle
          ? { method: 'set_properties', params: [{ did: device.did, siid: 2, piid: 1, value: '<!current>' }], note: '执行时先读取实时 2.1 再取反' }
          : { method: 'set_properties', params: [{ did: device.did, siid: 2, piid: 1, value: onValue }] };
        return success('米家设备控制（预演）', `将${wantToggle ? '切换' : (onValue ? '打开' : '关闭')} ${name}`, { dryRun: true, transport: 'bt_mesh', plan, device: base });
      }
      let target = onValue;
      let previous;
      if (wantToggle) {
        const cur = await bleGetProperties(ctx, [{ did: device.did, siid: 2, piid: 1 }]);
        const r = cur.find(x => x.siid === 2 && x.piid === 1);
        if (!r || r.code !== 0) {
          return failure('米家设备控制失败', `无法读取 ${name} 当前状态（code=${r?.code ?? '无返回'}），未执行切换。`, { device: base });
        }
        previous = r.value === true || r.value === 1;
        target = !previous;
      }
      const results = await bleSetProperties(ctx, [{ did: device.did, siid: 2, piid: 1, value: target }]);
      const res = checkWrite(name, results, `已${target ? '打开' : '关闭'}${name}${previous !== undefined ? `（原状态：${previous ? '开' : '关'}）` : ''}`, base);
      if (res.ok) res.data = { ...res.data, on: target, ...(previous !== undefined ? { previous } : {}) };
      return res;
    }

    // ---- Wi-Fi MiIO devices ----
    if (device.controlChannel === 'miio_udp') {
      await loadSnapshotIfNeeded(ctx);
      if (device.category === 'air_fryer') {
        if (onValue === false) return handleCook({ ...ctx, args: { ...args, device: args.device, op: 'stop' } });
        if (!hasGeneric) {
          return failure('米家设备控制失败', '空气炸锅请使用 cook 动作（op=start/pause/resume/stop/status）；set 仅支持 on:false（等同停止）或 siid/piid/value。', { device: base });
        }
      }
      if (!hasGeneric) {
        return failure('米家设备控制失败', `${name} 走 Wi-Fi MiIO 直连，请通过 siid/piid/value 写入属性，或用 action 调用动作。`, { device: base });
      }
      const item = { did: device.did, siid: /** @type {number} */ (genericSiid), piid: /** @type {number} */ (genericPiid), value: coerceValue(args.value) };
      if (dryRun) {
        return success('米家设备控制（预演）', `将向 ${name} 写入 ${item.siid}.${item.piid}=${JSON.stringify(item.value)}`, { dryRun: true, transport: 'miio_udp', plan: { method: 'set_properties', params: [item] }, device: base });
      }
      const reply = await miioCall(ctx, device, 'set_properties', [item]);
      const results = (Array.isArray(reply?.result) ? reply.result : []).map(normalizeMiotResult);
      return checkWrite(name, results, `已写入 ${name} ${item.siid}.${item.piid}=${JSON.stringify(item.value)}`, base);
    }

    return failure('米家设备控制失败', `${name} 的控制通道 "${device.controlChannel}" 暂不支持。`, { device: base });
  } catch (err) {
    return failFromError('米家设备控制失败', err);
  }
}

function checkWrite(name, results, okMessage, base) {
  const bad = results.filter(r => r.code !== 0 && r.code !== undefined);
  if (results.length === 0) {
    return failure('米家设备控制失败', `${name} 没有返回写入结果（设备可能离线）。`, { device: base, results });
  }
  if (bad.length > 0) {
    return failure('米家设备控制失败', `${name} 写入失败（code=${bad.map(b => b.code).join(',')}），设备可能离线或属性只读。`, { device: base, results });
  }
  return success('米家设备控制', okMessage, { device: base, results });
}

// ---- cook -----------------------------------------------------------------

/** Resolve a recipe id/key/alias to a preset (or undefined). */
export function resolveRecipe(query) {
  if (query === undefined || query === null || String(query).trim() === '') return undefined;
  const q = String(query).trim().toLowerCase().replace(/\s+/g, '');
  for (const recipe of Object.values(PRESET_RECIPES)) {
    if (recipe.id.toLowerCase() === q || recipe.key === q || recipe.name === q || recipe.aliases.some(a => a.toLowerCase() === q)) return recipe;
  }
  return undefined;
}

/** `start-custom-cook` input list (siid=3, aiid=1). */
export function buildFryerStartInputs({ recipeId, recipeName, minutes, tempC, appointMinutes = 0, foodQuantity = 0, preheat = false }) {
  return [
    { piid: 1, value: recipeId },
    { piid: 2, value: recipeName },
    { piid: 3, value: minutes },
    { piid: 4, value: tempC },
    { piid: 5, value: appointMinutes },
    { piid: 6, value: foodQuantity },
    { piid: 7, value: preheat ? 2 : 1 },
  ];
}

async function handleCook(ctx) {
  const { args } = ctx;
  const dryRun = isDry(args);
  const op = String(args.op ?? 'status').trim().toLowerCase();
  const normalizedOp = op === 'cancel' ? 'stop' : op;
  if (!['status', 'start', 'pause', 'resume', 'stop'].includes(normalizedOp)) {
    return failure('空气炸锅控制失败', `不支持的 op "${op}"，可用：status、start、pause、resume、stop（cancel 同 stop）。`);
  }
  let device;
  try {
    device = await resolveFromArgs(ctx, { defaultCategory: 'air_fryer' });
  } catch (err) {
    return failFromError('空气炸锅控制失败', err);
  }
  if (normalizedOp !== 'status') {
    const blocked = assertNotProtected(ctx, device, '空气炸锅控制失败');
    if (blocked) return blocked;
  }
  const name = fullName(device);
  const base = publicDevice(device);
  if (device.category !== 'air_fryer' || device.controlChannel !== 'miio_udp') {
    return failure('空气炸锅控制失败', `${name} 不是空气炸锅（cook 仅支持 careli.fryer.maf01 一类设备）。`, { device: base });
  }

  try {
    if (normalizedOp === 'status') {
      const s = await fryerStatus(ctx, device);
      return success('空气炸锅状态', describeFryer(s), { device: base, fryer: s });
    }

    if (normalizedOp === 'start') {
      let recipe = PRESET_RECIPES.M0;
      if (args.recipe !== undefined && String(args.recipe).trim() !== '') {
        const found = resolveRecipe(args.recipe);
        if (!found) {
          return failure('空气炸锅控制失败', `未知菜单 "${args.recipe}"，可用：${Object.values(PRESET_RECIPES).map(r => `${r.id}/${r.name}`).join('、')}。`);
        }
        recipe = found;
      }
      const hasTemp = args.tempC !== undefined && args.tempC !== null && args.tempC !== '';
      const hasMin = args.minutes !== undefined && args.minutes !== null && args.minutes !== '';
      const tempC = clampInt(hasTemp ? args.tempC : recipe.tempC, 40, 200) ?? 180;
      const minutes = clampInt(hasMin ? args.minutes : recipe.minutes, 1, 1440) ?? 15;
      const appointMinutes = clampInt(args.appointMinutes ?? 0, 0, 1440) ?? 0;
      const foodQuantity = clampInt(args.foodQuantity ?? 0, 0, 4) ?? 0;
      const preheat = args.preheat === true || args.preheat === 'true';
      const inputs = buildFryerStartInputs({ recipeId: recipe.id, recipeName: recipe.name, minutes, tempC, appointMinutes, foodQuantity, preheat });
      const clamped = (hasTemp && Number(args.tempC) !== tempC) || (hasMin && Number(args.minutes) !== minutes);
      const plan = { method: 'action', params: { did: device.did, siid: 3, aiid: 1, in: inputs } };
      if (dryRun) {
        return success('空气炸锅（预演）', `将以「${recipe.name}」${tempC}℃ ${minutes} 分钟${preheat ? '（预热）' : ''}启动${appointMinutes ? `，预约 ${appointMinutes} 分钟后` : ''}${clamped ? '（参数已夹紧到安全范围）' : ''}`, {
          dryRun: true, transport: 'miio_udp', device: base, plan, recipe, tempC, minutes, clamped,
        });
      }
      await loadSnapshotIfNeeded(ctx);
      const before = await fryerStatus(ctx, device);
      if (before.statusCode === 9) {
        return failure('空气炸锅抽锅暂停', '空气炸锅处于「抽锅暂停」：炸篮被拉出，物理互锁会切断加热回路，远程无法启动。请先把炸篮推到位再试。', { device: base, fryer: before });
      }
      const reply = await miioCall(ctx, device, 'action', plan.params);
      const code = reply?.result?.code;
      if (code !== 0) {
        return failure('空气炸锅启动失败', `设备拒绝启动指令（code=${code ?? '无'}）。`, { device: base, before, reply: sanitizeOutput(reply) });
      }
      let after;
      for (const delayMs of [220, 320, 460]) {
        await ctx.sleep(delayMs);
        try { after = await fryerStatus(ctx, device); } catch { after = undefined; }
        if (after && ([3, 4, 5].includes(after.statusCode) || (appointMinutes > 0 && after.statusCode === 2))) {
          break;
        }
      }
      const heating = after && ([3, 4, 5].includes(after.statusCode) || (appointMinutes > 0 && after.statusCode === 2));
      const data = { device: base, before, after, recipe: { id: recipe.id, name: recipe.name }, tempC, minutes, preheat, appointMinutes, clamped, replacedRunning: [4, 5].includes(before.statusCode) };
      if (after && !heating) {
        return failure('空气炸锅未进入烹饪', `指令已被设备接受，但回读状态为「${after.statusText}」，可能未开始加热（请确认炸篮已推到位）。`, data);
      }
      const text = `空气炸锅已启动：${recipe.name}，${tempC}℃，${minutes} 分钟${preheat ? '，先预热' : ''}${after ? `（当前：${after.statusText}）` : ''}${clamped ? '。注意：参数已夹紧到安全范围' : ''}`;
      return success('空气炸锅', text, data);
    }

    // pause / resume / stop
    const spec = {
      pause: { siid: 2, aiid: 3, label: '暂停' },
      resume: { siid: 3, aiid: 2, label: '继续' },
      stop: { siid: 2, aiid: 2, label: '停止' },
    }[normalizedOp];
    const params = { did: device.did, siid: spec.siid, aiid: spec.aiid, in: [] };
    if (dryRun) {
      return success('空气炸锅（预演）', `将${spec.label}空气炸锅烹饪（action ${spec.siid}.${spec.aiid}）`, { dryRun: true, transport: 'miio_udp', device: base, plan: { method: 'action', params } });
    }
    await loadSnapshotIfNeeded(ctx);
    const reply = await miioCall(ctx, device, 'action', params);
    const code = reply?.result?.code;
    if (code !== 0) {
      return failure('空气炸锅控制失败', `设备拒绝「${spec.label}」指令（code=${code ?? '无'}）。`, { device: base, reply: sanitizeOutput(reply) });
    }
    const expectedCodes = {
      stop: [0, 1],
      pause: [2, 6, 8, 9],
      resume: [3, 4, 5],
    }[normalizedOp] ?? [];
    let after;
    for (const delayMs of [180, 260]) {
      await ctx.sleep(delayMs);
      try { after = await fryerStatus(ctx, device); } catch { after = undefined; }
      if (after && expectedCodes.includes(after.statusCode)) {
        break;
      }
    }
    return success('空气炸锅', `已${spec.label}空气炸锅烹饪${after ? `（当前：${after.statusText}）` : ''}`, { device: base, after, op: normalizedOp });
  } catch (err) {
    return failFromError('空气炸锅控制失败', err);
  }
}

// ---- action ---------------------------------------------------------------

async function handleActionCall(ctx) {
  const { args } = ctx;
  const dryRun = isDry(args);
  const siid = Number(args.siid);
  const aiid = Number(args.aiid);
  if (!Number.isInteger(siid) || !Number.isInteger(aiid)) {
    return failure('米家动作失败', '请提供整数 siid 与 aiid（以及可选的 in 参数列表）。');
  }
  let device;
  try {
    device = await resolveFromArgs(ctx);
  } catch (err) {
    return failFromError('米家动作失败', err);
  }
  const blocked = assertNotProtected(ctx, device, '米家动作失败');
  if (blocked) return blocked;
  const name = fullName(device);
  const base = publicDevice(device);
  const input = Array.isArray(args.in) ? args.in : (args.in === undefined ? [] : [args.in]);
  const params = { did: device.did, siid, aiid, in: input };
  const warning = device.category === 'air_fryer' && siid === 2 && aiid === 1
    ? '注意：空气炸锅单独 action(2,1) 无法从关机点火，请改用 cook op=start（走 action(3,1)）。'
    : undefined;
  try {
    if (!['bt_mesh', 'miio_udp'].includes(device.controlChannel)) {
      return failure('米家动作失败', `${name} 的控制通道 "${device.controlChannel}" 不支持低层 MIoT action。`, { device: base });
    }
    if (dryRun) {
      return success('米家动作（预演）', `将对 ${name} 调用 action ${siid}.${aiid}${warning ? `。${warning}` : ''}`, { dryRun: true, transport: device.controlChannel, plan: { method: 'action', params }, device: base, ...(warning ? { warning } : {}) });
    }
    let result;
    if (device.controlChannel === 'bt_mesh') {
      result = await bleAction(ctx, params);
    } else {
      await loadSnapshotIfNeeded(ctx);
      const reply = await miioCall(ctx, device, 'action', params);
      result = reply?.result && typeof reply.result === 'object' ? normalizeMiotResult(reply.result) : { code: undefined };
    }
    if (result.code !== undefined && result.code !== 0) {
      return failure('米家动作失败', `${name} 的 action ${siid}.${aiid} 返回 code=${result.code}。`, { device: base, result });
    }
    return success('米家动作', `已对 ${name} 执行 action ${siid}.${aiid}${warning ? `。${warning}` : ''}`, { device: base, result, ...(warning ? { warning } : {}) });
  } catch (err) {
    return failFromError('米家动作失败', err);
  }
}

// ---- command --------------------------------------------------------------

async function handleCommand(ctx) {
  const { args } = ctx;
  let text;
  try {
    text = cleanNlpText(args.text);
  } catch (err) {
    return failure('小爱指令失败', errMsg(err));
  }
  const speakReply = args.speakReply === true || args.speakReply === 'true';
  const speaker = await discoverSpeakerSsh({ speakerSsh: args.speakerSsh, dataDir: ctx.paths.dataDir, homeDir: ctx.paths.homeDir });
  const speakerView = { id: speaker.id, userHost: speaker.userHost, ...(speaker.port ? { port: speaker.port } : {}), source: speaker.source };
  const command = buildMibrainCommand(text, { speakReply });
  if (isDry(args)) {
    return success('小爱指令（预演）', `将通过 ${speaker.id} 发送：${text}${speakReply ? '（朗读回复）' : '（静默）'}`, { dryRun: true, speaker: speakerView, text, speakReply, command });
  }
  try {
    const sent = await sendNlp(ctx, speaker, text, speakReply);
    if (sent.code !== 0) {
      return failure('小爱指令失败', `通过 ${speaker.id} 发送失败 (ssh code=${sent.code})：${sent.stderr || sent.stdout || '无输出'}`, { speaker: speakerView, text, exitCode: sent.code });
    }
    return success('小爱指令', `已通过 ${speaker.id} 发送：${text}${speakReply ? '（朗读回复）' : '（静默执行）'}`, { speaker: speakerView, text, speakReply, exitCode: sent.code, output: sent.stdout });
  } catch (err) {
    return failure('小爱指令失败', errMsg(err), { speaker: speakerView, text });
  }
}

// ---- mesh / geek / scene / dashboard --------------------------------------

function mergeWriteCentralCache(paths, patch) {
  const prev = readCentralCache(paths?.centralCachePath) ?? {};
  writeCentralCache(paths?.centralCachePath, { ...prev, ...patch });
}

async function loadSnapshotBestEffort(ctx, { refresh = false, needHotData = true } = {}) {
  try {
    return { snap: await loadSnapshot(ctx, { refresh, needHotData }), error: undefined };
  } catch (err) {
    const cached = readHubCache(ctx.paths);
    if (cached) {
      return {
        snap: { ...cached, source: 'stale', ageMs: Math.max(0, ctx.now() - cached.fetchedAt) },
        error: errMsg(err),
      };
    }
    return {
      snap: { homeId: '', fetchedAt: 0, hotDataFetchedAt: 0, devices: [], tokenByDid: {}, source: 'empty', ageMs: 0 },
      error: errMsg(err),
    };
  }
}

function buildDevicesByDid(devices) {
  return new Map((Array.isArray(devices) ? devices : []).map(d => [String(d.did), d]));
}

function buildDevicesView(ctx, devices, live = new Map()) {
  return (Array.isArray(devices) ? devices : []).map(d => {
    const l = live.get(d.did);
    /** @type {Record<string, any>} */
    const extra = {
      protected: Boolean(findProtectedRuleForDevice(ctx.cfg, d)),
    };
    if (l?.fryer) extra.fryer = l.fryer;
    if (l && l.on !== undefined) extra.state = { on: l.on, source: 'live' };
    if (l?.error) extra.liveError = l.error;
    return publicDevice(d, extra);
  });
}

async function fetchVariablesForScopes(ctx, scopes) {
  const validScopes = (Array.isArray(scopes) ? scopes : [])
    .slice(0, 16)
    .map(raw => String(raw ?? '').trim())
    .filter(s => s && VAR_IDENT_RE.test(s));
  if (validScopes.length === 0) return [];

  const perScope = await Promise.all(
    validScopes.map(async scope => {
      try {
        const listRes = await ctx.centralMipsCall('local/autoLocal/getVarList', { scope });
        const rawList = Array.isArray(listRes)
          ? listRes
          : Array.isArray(listRes?.list)
            ? listRes.list
            : Array.isArray(listRes?.vars)
              ? listRes.vars
              : Array.isArray(listRes?.variables)
                ? listRes.variables
                : [];
        const items = await Promise.all(
          rawList.map(async item => {
            if (typeof item === 'string') {
              const id = item.trim();
              if (!id) return null;
              let value;
              try {
                const valRes = await ctx.centralMipsCall('local/autoLocal/getVarValue', { scope, id });
                value = valRes?.value ?? valRes?.result;
              } catch {
                value = undefined;
              }
              return { scope, id, type: typeof value === 'number' ? 'number' : 'string', value };
            }
            if (item && typeof item === 'object') {
              const id = String(item.id ?? item.name ?? '').trim();
              if (!id) return null;
              let value = item.value;
              if (value === undefined) {
                try {
                  const valRes = await ctx.centralMipsCall('local/autoLocal/getVarValue', { scope, id });
                  value = valRes?.value ?? valRes?.result;
                } catch {
                  value = undefined;
                }
              }
              return {
                scope,
                id,
                type: String(item.type ?? item.varType ?? (typeof value === 'number' ? 'number' : 'string')),
                value,
              };
            }
            return null;
          }),
        );
        return items.filter(Boolean);
      } catch {
        return [];
      }
    }),
  );
  return perScope.flat();
}

async function resolveSpeakerViewSafe(paths, args = {}) {
  try {
    const spk = await discoverSpeakerSsh({
      speakerSsh: args.speakerSsh,
      pluginDataDir: paths.pluginDataDir,
      dataDir: paths.dataDir,
      homeDir: paths.homeDir,
    });
    return {
      configured: true,
      id: spk.id,
      userHost: spk.userHost,
      ...(spk.port ? { port: spk.port } : {}),
      source: spk.source,
    };
  } catch {
    return { configured: false };
  }
}

function parseArrayLikeArg(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // fall through to comma split
      }
    }
    return trimmed.split(/[,，、\n]/).map(s => s.trim()).filter(Boolean);
  }
  return undefined;
}

function summarizeGeekList(overview, devicesByDid) {
  const bodies = overview?.geekGraphBodiesById ?? {};
  return (Array.isArray(overview?.geekGraphs) ? overview.geekGraphs : []).map(cfg => {
    const body = bodies[cfg.id] ?? { id: cfg.id, nodes: [] };
    const summary = summarizeGeekGraph(body, cfg, devicesByDid);
    return {
      ...summary,
      cfg,
    };
  });
}

function summarizeScenesList(overview, devicesByDid, cfg) {
  const idSet = new Set([
    ...(Array.isArray(overview?.actionGroupIds) ? overview.actionGroupIds : []),
    ...Object.keys(overview?.cloudScenesById ?? {}),
  ]);
  const scenes = [];
  for (const id of idSet) {
    const decoded = overview?.cloudScenesById?.[id];
    scenes.push(summarizeCloudScene(id, decoded, devicesByDid, dev => findProtectedRuleForDevice(cfg, dev)));
  }
  return scenes;
}

async function resolveGeekCfg(ctx, { id = undefined, name = undefined } = {}) {
  const listRes = await ctx.centralMipsCall('local/autoLocal/getGraphList', {});
  const list = Array.isArray(listRes) ? listRes : [];
  const cleanId = id !== undefined && id !== null ? String(id).trim() : '';
  const cleanName = name !== undefined && name !== null ? String(name).trim() : '';
  if (cleanId) {
    const hit = list.find(g => String(g?.id ?? '') === cleanId);
    if (!hit) {
      throw new MiotError(`未找到 ID 为 "${cleanId}" 的极客版规则。`, { code: 'GEEK_RULE_NOT_FOUND' });
    }
    return { cfg: hit, all: list };
  }
  if (!cleanName) {
    throw new MiotError('请通过 id 或 name 指定极客版规则。', { code: 'GEEK_RULE_REQUIRED' });
  }
  const exact = list.filter(g => String(g?.userData?.name ?? '').trim() === cleanName);
  if (exact.length === 1) return { cfg: exact[0], all: list };
  if (exact.length > 1) {
    throw new MiotError(`"${cleanName}" 匹配到多条同名规则，请使用 id 指定。`, { code: 'AMBIGUOUS_GEEK_RULE' });
  }
  const lower = cleanName.toLowerCase();
  const fuzzy = list.filter(g => String(g?.userData?.name ?? '').trim().toLowerCase().includes(lower));
  if (fuzzy.length === 1) return { cfg: fuzzy[0], all: list };
  if (fuzzy.length > 1) {
    throw new MiotError(`"${cleanName}" 匹配到多条规则：${fuzzy.map(g => `${g.userData?.name ?? g.id}(${g.id})`).join('、')}。请使用 id 指定。`, { code: 'AMBIGUOUS_GEEK_RULE' });
  }
  throw new MiotError(`未找到名称为 "${cleanName}" 的极客版规则。`, { code: 'GEEK_RULE_NOT_FOUND' });
}

async function handleMesh(ctx) {
  const { args } = ctx;
  const op = String(args.op ?? 'status').trim().toLowerCase();
  const dryRun = isDry(args);
  if (!['status', 'devices', 'batch'].includes(op)) {
    return failure('Mesh 中枢操作失败', `不支持的 op "${op}"，可用：status、devices、batch。`);
  }

  try {
    if (op === 'batch') {
      const targetOn = parseBoolish(args.on);
      if (typeof targetOn !== 'boolean') {
        return failure('Mesh 批量控制失败', '请通过 on:true 或 on:false 指定批量开关目标。');
      }
      const snap = await loadSnapshot(ctx, { refresh: args.refresh === true || args.refresh === 'true', needHotData: false });
      const meshPool = snap.devices.filter(d => d.controlChannel === 'bt_mesh' && d.controllable);
      const roomFilter = args.room ? String(args.room).trim() : '';
      const deviceQueries = parseArrayLikeArg(args.devices);

      /** @type {any[]} */
      let selected = [];
      if (deviceQueries && deviceQueries.length > 0) {
        const seen = new Set();
        for (const q of deviceQueries) {
          const dev = resolveDevice(meshPool, { device: q, room: roomFilter || undefined, customAliases: ctx.cfg.customAliases });
          if (!seen.has(dev.did)) {
            seen.add(dev.did);
            selected.push(dev);
          }
        }
      } else {
        selected = roomFilter ? meshPool.filter(d => roomMatches(d, roomFilter)) : meshPool;
      }

      const includeProtected = args.includeProtected === true || args.includeProtected === 'true';
      /** @type {any[]} */
      const targets = [];
      /** @type {any[]} */
      const skipped = [];
      for (const dev of selected) {
        const rule = findProtectedRuleForDevice(ctx.cfg, dev);
        if (rule && !includeProtected) {
          skipped.push({ did: dev.did, name: fullName(dev), reason: 'protected_device', protectedRule: rule });
        } else {
          targets.push(dev);
        }
      }

      if (targets.length === 0) {
        if (skipped.length > 0) {
          return failure(
            'Mesh 批量控制受保护',
            `匹配到的设备（${skipped.map(s => s.name).join('、')}）均已设为保护设备，已自动跳过（如需强行包含请传 includeProtected:true）。`,
            { blocked: true, reason: 'protected_device', skipped },
          );
        }
        return failure('Mesh 批量控制失败', '未匹配到可控制的蓝牙 Mesh 设备。');
      }

      const items = targets.map(d => ({ did: d.did, siid: 2, piid: 1, value: targetOn }));
      const targetViews = targets.map(d => publicDevice(d, { protected: Boolean(findProtectedRuleForDevice(ctx.cfg, d)) }));
      if (dryRun) {
        return success(
          'Mesh 批量控制（预演）',
          `将批量${targetOn ? '打开' : '关闭'} ${targets.length} 台蓝牙 Mesh 设备：${targets.map(fullName).join('、')}${skipped.length ? `（跳过受保护：${skipped.map(s => s.name).join('、')}）` : ''}`,
          { dryRun: true, transport: 'bt_mesh', on: targetOn, targets: targetViews, skipped, plan: { method: 'set_properties', params: items } },
        );
      }

      const results = await bleSetProperties(ctx, items);
      const succeeded = [];
      const failed = [];
      for (const dev of targets) {
        const r = results.find(x => x.did === dev.did && x.siid === 2 && x.piid === 1);
        if (r && (r.code === 0 || r.code === undefined)) {
          succeeded.push({ did: dev.did, name: fullName(dev) });
        } else {
          failed.push({ did: dev.did, name: fullName(dev), code: r?.code ?? '无返回' });
        }
      }
      const actionLabel = targetOn ? '打开' : '关闭';
      const parts = [];
      if (succeeded.length) parts.push(`已${actionLabel} ${succeeded.length} 台：${succeeded.map(s => s.name).join('、')}`);
      if (failed.length) parts.push(`失败 ${failed.length} 台：${failed.map(f => `${f.name}(code=${f.code})`).join('、')}`);
      if (skipped.length) parts.push(`跳过受保护 ${skipped.length} 台：${skipped.map(s => s.name).join('、')}`);
      const ok = failed.length === 0;
      return (ok ? success : failure)(
        ok ? 'Mesh 批量控制' : 'Mesh 批量控制部分失败',
        parts.join('；'),
        { on: targetOn, succeeded, failed, skipped, results },
      );
    }

    const wantRefresh = args.refresh === true || args.refresh === 'true';
    const wantLive = args.live === true || args.live === 'true';
    const snap = await loadSnapshot(ctx, { refresh: wantRefresh, needHotData: true });
    const routerDev = snap.devices.find(d => d.category === 'router');
    const overview = op === 'status'
      ? await ctx.fetchCentralOverview({
        routerDid: routerDev?.did ?? '',
        includeLogs: false,
        includeCloudScenes: false,
        includeGraphContents: false,
      })
      : null;

    const meshAll = snap.devices.filter(d => d.controlChannel === 'bt_mesh');
    const meshFiltered = args.room ? meshAll.filter(d => roomMatches(d, args.room)) : meshAll;
    const live = wantLive ? await liveForDevices(ctx, meshFiltered) : new Map();
    if (wantLive) {
      persistLiveStates(ctx, snap, live, !args.room);
    }

    const btDidSet = new Set(overview?.btMeshDids ?? []);
    const items = meshFiltered.map(d => {
      const l = live.get(d.did);
      /** @type {Record<string, any>} */
      const extra = {
        protected: Boolean(findProtectedRuleForDevice(ctx.cfg, d)),
        ...(btDidSet.size > 0 ? { inBtGateway: btDidSet.has(d.did) } : {}),
      };
      if (l && l.on !== undefined) extra.state = { on: l.on, source: 'live' };
      if (l?.error) extra.liveError = l.error;
      return publicDevice(d, extra);
    });

    if (overview) {
      mergeWriteCentralCache(ctx.paths, {
        fetchedAt: ctx.now(),
        gateway: overview.gateway,
        subGateways: overview.subGateways,
        btService: overview.btService,
        btMeshDids: overview.btMeshDids,
        geekReady: overview.geekReady,
        geekUrl: overview.geekUrl,
      });
    }

    const devDesc = items.map(d => {
      const st = d.state?.on !== undefined ? (d.state.on ? '开' : '关') : (d.online ? '在线' : '离线');
      return `${d.fullName}(${st})`;
    }).join('、') || '（无）';

    if (op === 'devices') {
      return success('蓝牙 Mesh 设备', `共 ${items.length} 台蓝牙 Mesh 设备${wantLive ? '（实时）' : ''}：${devDesc}`, {
        op,
        count: items.length,
        live: wantLive,
        devices: items,
      });
    }

    const gw = overview?.gateway ?? {};
    const gwLine = `${gw.roleLabel || '中枢网关'} ${gw.homeName ? `「${gw.homeName}」` : ''}${gw.ip ? `(${gw.ip})` : ''} · ${gw.online ? '在线' : '状态未知'} · bt_service ${overview?.btService?.version || '未知'} · 从网关 ${overview?.subGateways?.length ?? 0} 台`;
    return success(
      'BE6500 Pro Mesh 中枢',
      `${gwLine}\n蓝牙 Mesh 设备 (${items.length})：${devDesc}`,
      {
        op,
        gateway: overview?.gateway,
        subGateways: overview?.subGateways ?? [],
        btService: overview?.btService,
        btMeshDids: overview?.btMeshDids ?? [],
        geekReady: overview?.geekReady ?? false,
        geekUrl: overview?.geekUrl ?? '',
        count: items.length,
        live: wantLive,
        devices: items,
      },
    );
  } catch (err) {
    return failFromError('Mesh 中枢操作失败', err);
  }
}

async function handleGeek(ctx) {
  const { args } = ctx;
  const op = String(args.op ?? 'list').trim().toLowerCase();
  const dryRun = isDry(args);
  const supported = [
    'list', 'get', 'enable', 'disable', 'toggle',
    'create-schedule', 'save', 'delete',
    'logs', 'nodes',
    'vars', 'var-get', 'var-set', 'var-create', 'var-delete',
    'url',
  ];
  if (!supported.includes(op)) {
    return failure('极客自动化操作失败', `不支持的 op "${op}"，可用：${supported.join('、')}。`);
  }

  try {
    if (op === 'url') {
      const overview = await ctx.fetchCentralOverview({
        includeLogs: false,
        includeCloudScenes: false,
        includeGraphContents: false,
      });
      if (!overview.geekUrl) {
        return failure('获取极客版入口失败', '未能从 BE6500 Pro 获取有效的极客版服务地址。', { geekReady: overview.geekReady });
      }
      return success('米家自动化极客版入口', `极客版画布地址：${overview.geekUrl}（${overview.geekReady ? '引擎已就绪' : '引擎未就绪'}）`, {
        geekUrl: overview.geekUrl,
        geekReady: overview.geekReady,
        port: overview.gateway?.geekPort,
      });
    }

    if (op === 'nodes') {
      const res = await ctx.centralMipsCall('local/autoLocal/getNodeVersion', {});
      const nodes = Array.isArray(res?.nodes) ? res.nodes : [];
      return success(
        '极客版节点目录',
        `autoLocal 引擎 v${res?.version ?? '未知'}，支持 ${nodes.length} 种节点：${nodes.map(n => n.name).join('、')}`,
        { version: res?.version, nodes },
      );
    }

    if (op === 'list') {
      const { snap } = await loadSnapshotBestEffort(ctx, { refresh: false, needHotData: false });
      const routerDev = snap.devices.find(d => d.category === 'router');
      const devicesByDid = buildDevicesByDid(snap.devices);
      const overview = await ctx.fetchCentralOverview({
        routerDid: routerDev?.did ?? '',
        includeLogs: false,
        includeCloudScenes: false,
        includeGraphContents: true,
      });
      const graphs = summarizeGeekList(overview, devicesByDid);
      const enabledCount = graphs.filter(g => g.enable).length;
      mergeWriteCentralCache(ctx.paths, {
        fetchedAt: ctx.now(),
        gateway: overview.gateway,
        geekReady: overview.geekReady,
        geekUrl: overview.geekUrl,
        geekGraphs: graphs,
        varScopes: overview.varScopes,
      });
      const lines = graphs.map(g => `• [${g.enable ? '启用' : '停用'}] ${g.name} (id=${g.id})：${g.summary}`);
      return success(
        '米家自动化极客版',
        graphs.length
          ? `共 ${graphs.length} 条极客规则（${enabledCount} 条运行中）：\n${lines.join('\n')}`
          : '当前没有本地极客版自动化规则。',
        {
          geekReady: overview.geekReady,
          geekUrl: overview.geekUrl,
          count: graphs.length,
          enabledCount,
          graphs,
        },
      );
    }

    if (op === 'get') {
      const { snap } = await loadSnapshotBestEffort(ctx, { refresh: false, needHotData: false });
      const devicesByDid = buildDevicesByDid(snap.devices);
      const { cfg } = await resolveGeekCfg(ctx, { id: args.id, name: args.name });
      const graph = await ctx.centralMipsCall('local/autoLocal/getGraph', { id: cfg.id });
      const summary = summarizeGeekGraph(graph, cfg, devicesByDid);
      return success('极客规则详情', `规则「${summary.name}」[${summary.enable ? '启用' : '停用'}]：${summary.summary}`, {
        id: cfg.id,
        cfg,
        graph,
        summary,
      });
    }

    if (op === 'enable' || op === 'disable' || op === 'toggle') {
      const { cfg } = await resolveGeekCfg(ctx, { id: args.id, name: args.name });
      const nextEnable = op === 'enable' ? true : op === 'disable' ? false : !cfg.enable;
      const ruleName = String(cfg.userData?.name ?? cfg.id);
      const payload = {
        id: cfg.id,
        enable: nextEnable,
        uiType: typeof cfg.uiType === 'string' && cfg.uiType ? cfg.uiType : 'test',
        userData: {
          transform: { x: 0, y: 0, scale: 1, rotate: 0 },
          version: 0,
          ...(cfg.userData && typeof cfg.userData === 'object' ? cfg.userData : {}),
          name: ruleName,
          lastUpdateTime: ctx.now(),
        },
      };
      if (dryRun) {
        return success('极客规则控制（预演）', `将${nextEnable ? '启用' : '停用'}极客规则「${ruleName}」`, {
          dryRun: true,
          topic: 'local/autoLocal/changeGraphConfig',
          payload,
          id: cfg.id,
          name: ruleName,
          previousEnable: Boolean(cfg.enable),
          enable: nextEnable,
        });
      }
      await ctx.centralMipsCall('local/autoLocal/changeGraphConfig', payload);
      return success('极客规则控制', `已${nextEnable ? '启用' : '停用'}极客规则「${ruleName}」`, {
        id: cfg.id,
        name: ruleName,
        previousEnable: Boolean(cfg.enable),
        enable: nextEnable,
      });
    }

    if (op === 'create-schedule') {
      const snap = await loadSnapshot(ctx, { refresh: args.refresh === true || args.refresh === 'true', needHotData: false });
      const devicesByDid = buildDevicesByDid(snap.devices);
      let rules = parseArrayLikeArg(args.rules);
      if ((!rules || rules.length === 0) && args.time !== undefined) {
        const onVal = parseBoolish(args.on);
        rules = [{
          time: args.time,
          device: args.device,
          did: args.did,
          room: args.room,
          ...(typeof onVal === 'boolean' ? { on: onVal } : {}),
          ...(args.siid !== undefined ? { siid: args.siid } : {}),
          ...(args.piid !== undefined ? { piid: args.piid } : {}),
          ...(args.value !== undefined ? { value: args.value } : {}),
          ...(args.days !== undefined ? { days: args.days } : {}),
        }];
      }
      const enable = args.enable === undefined ? true : (args.enable === true || args.enable === 'true');
      const built = buildScheduleGeekGraph({
        id: args.id ? String(args.id).trim() : undefined,
        name: args.name,
        enable,
        rules: rules ?? [],
        resolveDeviceFn: rule => resolveDevice(snap.devices, {
          device: rule.device ?? args.device,
          did: rule.did ?? args.did,
          room: rule.room ?? args.room,
          customAliases: ctx.cfg.customAliases,
        }),
        nowMs: ctx.now(),
      });
      const summary = summarizeGeekGraph(built, built.cfg, devicesByDid);
      if (dryRun) {
        return success('创建定时极客规则（预演）', `将创建极客规则「${summary.name}」：${summary.summary}`, {
          dryRun: true,
          topic: 'local/autoLocal/setGraph',
          payload: built,
          summary,
        });
      }
      await ctx.centralMipsCall('local/autoLocal/setGraph', built);
      return success(
        '极客规则已创建',
        `已创建并${enable ? '启用' : '保存'}极客规则「${summary.name}」：${summary.summary}`,
        { id: built.id, cfg: built.cfg, graph: { id: built.id, nodes: built.nodes }, summary },
      );
    }

    if (op === 'save') {
      let rawNodes = args.nodes;
      if (typeof rawNodes === 'string') {
        try { rawNodes = JSON.parse(rawNodes); } catch { /* validated below */ }
      }
      const nodes = validateGeekNodes(rawNodes);
      const graphId = args.id ? validateGraphId(args.id) : String(Math.floor(ctx.now()));
      const prevCfg = args.id
        ? await ctx.centralMipsCall('local/autoLocal/getGraphList', {})
          .then(list => (Array.isArray(list) ? list.find(g => String(g?.id ?? '') === graphId) : undefined))
          .catch(() => undefined)
        : undefined;
      const name = String(args.name ?? args.cfg?.userData?.name ?? prevCfg?.userData?.name ?? graphId).trim();
      if (!name) return failure('保存极客规则失败', '规则名称不能为空。');
      const enable = args.enable !== undefined
        ? (args.enable === true || args.enable === 'true')
        : (args.cfg?.enable ?? prevCfg?.enable ?? true);
      const uiType = String(args.uiType ?? args.cfg?.uiType ?? prevCfg?.uiType ?? 'test').trim() || 'test';
      const payload = {
        id: graphId,
        nodes,
        cfg: {
          id: graphId,
          userData: {
            transform: { x: 0, y: 0, scale: 1, rotate: 0 },
            version: 0,
            ...(prevCfg?.userData && typeof prevCfg.userData === 'object' ? prevCfg.userData : {}),
            ...(args.userData && typeof args.userData === 'object' ? args.userData : {}),
            name,
            lastUpdateTime: ctx.now(),
          },
          uiType,
          enable: Boolean(enable),
        },
      };
      if (dryRun) {
        return success('保存极客规则（预演）', `将写入极客规则「${name}」(id=${graphId}, ${nodes.length} 个节点)`, {
          dryRun: true,
          topic: 'local/autoLocal/setGraph',
          payload,
        });
      }
      await ctx.centralMipsCall('local/autoLocal/setGraph', payload);
      return success('极客规则已保存', `已保存极客规则「${name}」(id=${graphId})`, {
        id: graphId,
        cfg: payload.cfg,
        nodeCount: nodes.length,
      });
    }

    if (op === 'delete') {
      const { cfg } = await resolveGeekCfg(ctx, { id: args.id, name: args.name });
      const ruleName = String(cfg.userData?.name ?? cfg.id);
      if (dryRun) {
        return success('删除极客规则（预演）', `将删除极客规则「${ruleName}」(id=${cfg.id})`, {
          dryRun: true,
          topic: 'local/autoLocal/deleteGraph',
          payload: { id: cfg.id },
          id: cfg.id,
          name: ruleName,
        });
      }
      await ctx.centralMipsCall('local/autoLocal/deleteGraph', { id: cfg.id });
      return success('极客规则已删除', `已删除极客规则「${ruleName}」(id=${cfg.id})`, {
        id: cfg.id,
        name: ruleName,
      });
    }

    if (op === 'logs') {
      const limit = clampInt(args.limit, 1, 200) ?? 30;
      const overview = await ctx.fetchCentralOverview({
        includeLogs: true,
        logLimit: Math.max(limit * 4, 120),
        includeCloudScenes: false,
        includeGraphContents: false,
      });
      const graphNameById = new Map((overview.geekGraphs ?? []).map(g => [String(g.id), String(g.userData?.name ?? g.id)]));
      let graphId = args.graphId ? String(args.graphId).trim() : (args.id ? String(args.id).trim() : '');
      if (!graphId && args.name) {
        const needle = String(args.name).trim();
        const match = (overview.geekGraphs ?? []).find(g => String(g.userData?.name ?? '').trim() === needle);
        if (match) graphId = String(match.id);
      }
      const logs = parseAutoLocalLogs(overview.rawLogText, { graphNameById, graphId, limit });
      const lines = logs.slice(0, 12).map(l => `• [${new Date(l.ts).toLocaleTimeString('zh-CN', { hour12: false })}] ${l.graphName}：${l.summary}`);
      return success(
        '极客版执行日志',
        logs.length ? `最近 ${logs.length} 条记录：\n${lines.join('\n')}` : '暂无极客版执行日志。',
        { count: logs.length, ...(graphId ? { graphId } : {}), logs },
      );
    }

    if (op === 'vars') {
      let scopes;
      if (args.scope !== undefined && String(args.scope).trim() !== '') {
        scopes = [validateVarIdentifier(args.scope, '变量作用域')];
      } else {
        const scopeRes = await ctx.centralMipsCall('local/autoLocal/getVarScopeList', {});
        scopes = Array.isArray(scopeRes?.scopes) ? scopeRes.scopes.map(s => String(s)) : [];
      }
      const variables = await fetchVariablesForScopes(ctx, scopes);
      return success(
        '极客版自定义变量',
        variables.length
          ? `共 ${scopes.length} 个作用域、${variables.length} 个变量：${variables.map(v => `${v.scope}.${v.id}=${JSON.stringify(v.value)}`).join('、')}`
          : `当前共有 ${scopes.length} 个变量作用域，暂无自定义变量。`,
        { scopes, count: variables.length, variables },
      );
    }

    if (op === 'var-get') {
      const scope = validateVarIdentifier(args.scope, '变量作用域');
      const id = validateVarIdentifier(args.id, '变量 ID');
      const res = await ctx.centralMipsCall('local/autoLocal/getVarValue', { scope, id });
      const value = res?.value ?? res?.result ?? res;
      return success('极客版变量读取', `${scope}.${id} = ${JSON.stringify(value)}`, { scope, id, value });
    }

    if (op === 'var-set') {
      const scope = validateVarIdentifier(args.scope, '变量作用域');
      const id = validateVarIdentifier(args.id, '变量 ID');
      if (args.value === undefined) return failure('极客版变量更新失败', '请提供要写入的 value。');
      const value = coerceValue(args.value);
      const payload = { scope, id, value };
      if (dryRun) {
        return success('极客版变量更新（预演）', `将设置 ${scope}.${id} = ${JSON.stringify(value)}`, {
          dryRun: true,
          topic: 'local/autoLocal/setVarValue',
          payload,
        });
      }
      await ctx.centralMipsCall('local/autoLocal/setVarValue', payload);
      return success('极客版变量已更新', `已将 ${scope}.${id} 设为 ${JSON.stringify(value)}`, { scope, id, value });
    }

    if (op === 'var-create') {
      const scope = validateVarIdentifier(args.scope, '变量作用域');
      const id = validateVarIdentifier(args.id, '变量 ID');
      const type = String(args.type ?? 'number').trim().toLowerCase();
      if (!['number', 'string'].includes(type)) {
        return failure('极客版变量创建失败', 'type 只能为 number 或 string。');
      }
      let value;
      if (type === 'number') {
        const coerced = args.value === undefined || args.value === null || args.value === '' ? 0 : coerceValue(args.value);
        if (typeof coerced !== 'number' || !Number.isFinite(coerced)) {
          return failure('极客版变量创建失败', `number 类型变量需要有效数字，收到 "${String(args.value ?? '')}"。`);
        }
        value = coerced;
      } else {
        value = String(args.value ?? '');
      }
      const payload = { scope, id, type, value };
      if (dryRun) {
        return success('极客版变量创建（预演）', `将创建 ${type} 变量 ${scope}.${id} = ${JSON.stringify(value)}`, {
          dryRun: true,
          topic: 'local/autoLocal/createVar',
          payload,
        });
      }
      await ctx.centralMipsCall('local/autoLocal/createVar', payload);
      return success('极客版变量已创建', `已创建变量 ${scope}.${id} (${type}) = ${JSON.stringify(value)}`, payload);
    }

    // var-delete
    const scope = validateVarIdentifier(args.scope, '变量作用域');
    const id = validateVarIdentifier(args.id, '变量 ID');
    if (dryRun) {
      return success('极客版变量删除（预演）', `将删除变量 ${scope}.${id}`, {
        dryRun: true,
        topic: 'local/autoLocal/deleteVar',
        payload: { scope, id },
      });
    }
    await ctx.centralMipsCall('local/autoLocal/deleteVar', { scope, id });
    return success('极客版变量已删除', `已删除变量 ${scope}.${id}`, { scope, id });
  } catch (err) {
    return failFromError('极客自动化操作失败', err);
  }
}

async function handleScene(ctx) {
  const { args } = ctx;
  const op = String(args.op ?? 'list').trim().toLowerCase();
  const dryRun = isDry(args);
  if (!['list', 'run'].includes(op)) {
    return failure('米家本地场景操作失败', `不支持的 op "${op}"，可用：list、run。`);
  }

  try {
    const { snap } = await loadSnapshotBestEffort(ctx, { refresh: false, needHotData: false });
    const routerDev = snap.devices.find(d => d.category === 'router');
    const devicesByDid = buildDevicesByDid(snap.devices);
    const overview = await ctx.fetchCentralOverview({
      routerDid: routerDev?.did ?? '',
      includeLogs: false,
      includeCloudScenes: true,
      includeGraphContents: false,
    });
    const scenes = summarizeScenesList(overview, devicesByDid, ctx.cfg);

    if (op === 'list') {
      mergeWriteCentralCache(ctx.paths, {
        fetchedAt: ctx.now(),
        scenes,
      });
      const lines = scenes.map(s => `• ${s.id}：${s.summary}${s.turnsOffProtected ? ' [含关闭保护设备]' : ''}`);
      return success(
        '米家本地场景',
        scenes.length ? `共 ${scenes.length} 个中枢本地场景：\n${lines.join('\n')}` : '当前没有本地化的米家手动场景。',
        { count: scenes.length, scenes },
      );
    }

    const id = String(args.id ?? '').trim();
    if (!id) return failure('米家场景执行失败', '请提供要执行的本地场景 id。');
    if (!GRAPH_ID_RE.test(id)) return failure('米家场景执行失败', `场景 ID "${id}" 格式无效。`);
    const sceneInfo = scenes.find(s => s.id === id);
    if (!sceneInfo) {
      return failure('米家场景执行失败', `未找到本地场景 "${id}"。可用场景：${scenes.map(s => `${s.id}(${s.summary})`).join('、') || '（无）'}。`);
    }
    const confirmProtected = args.confirmProtected === true || args.confirmProtected === 'true';
    if (sceneInfo.turnsOffProtected && !confirmProtected) {
      return failure(
        '米家场景受保护拦截',
        `场景「${sceneInfo.summary}」包含关闭保护设备的操作，已拦截。如需确认执行，请传 confirmProtected:true。`,
        { blocked: true, reason: 'protected_device', scene: sceneInfo },
      );
    }
    const payload = { id, operation: 'user.click' };
    if (dryRun) {
      return success('米家场景执行（预演）', `将触发本地场景 ${id}：${sceneInfo.summary}`, {
        dryRun: true,
        topic: 'local/automation/execMijiaActionGroup',
        payload,
        scene: sceneInfo,
      });
    }
    await ctx.centralMipsCall('local/automation/execMijiaActionGroup', payload);
    return success('米家场景已触发', `已执行本地场景：${sceneInfo.summary}`, { id, scene: sceneInfo });
  } catch (err) {
    return failFromError('米家本地场景操作失败', err);
  }
}

async function handleDashboard(ctx) {
  const { args } = ctx;
  const cacheOnly = args.cacheOnly === true || args.cacheOnly === 'true';
  const wantRefresh = args.refresh === true || args.refresh === 'true';
  const wantLive = args.live === true || args.live === 'true';
  const logLimit = clampInt(args.logLimit, 5, 100) ?? 30;
  const speaker = await resolveSpeakerViewSafe(ctx.paths, args);
  const configured = Boolean(ctx.cfg.routerSsh);

  if (cacheOnly) {
    const hubCache = readHubCache(ctx.paths);
    const centralCache = readCentralCache(ctx.paths.centralCachePath);
    const devices = buildDevicesView(ctx, hubCache?.devices ?? []);
    const counts = {};
    for (const d of devices) counts[d.category] = (counts[d.category] ?? 0) + 1;
    const geekGraphs = Array.isArray(centralCache?.geekGraphs) ? centralCache.geekGraphs : [];
    const geekLogs = Array.isArray(centralCache?.geekLogs) ? centralCache.geekLogs : [];
    const scenes = Array.isArray(centralCache?.scenes) ? centralCache.scenes : [];
    const varScopes = Array.isArray(centralCache?.varScopes) ? centralCache.varScopes : [];
    const variables = Array.isArray(centralCache?.variables) ? centralCache.variables : [];
    const gateway = centralCache?.gateway ?? null;
    const meshCount = devices.filter(d => d.controlChannel === 'bt_mesh').length;
    return success(
      '米家中枢看板（缓存）',
      configured
        ? `缓存快照：${devices.length} 台设备（${meshCount} 台蓝牙 Mesh）、${geekGraphs.length} 条极客规则、${scenes.length} 个本地场景`
        : '尚未配置 BE6500 Pro 路由器 SSH 地址（routerSsh）。',
      {
        fromCache: true,
        configured,
        degraded: false,
        routerSsh: ctx.cfg.routerSsh,
        devices,
        counts,
        gateway,
        subGateways: Array.isArray(centralCache?.subGateways) ? centralCache.subGateways : [],
        btService: centralCache?.btService ?? null,
        btMeshDids: Array.isArray(centralCache?.btMeshDids) ? centralCache.btMeshDids : [],
        geekReady: centralCache?.geekReady === true,
        geekUrl: typeof centralCache?.geekUrl === 'string' ? centralCache.geekUrl : '',
        geekGraphs,
        geekLogs,
        varScopes,
        variables,
        scenes,
        fetchedAt: hubCache?.fetchedAt ?? null,
        hotDataFetchedAt: hubCache?.hotDataFetchedAt ?? null,
        liveFetchedAt: hubCache?.liveFetchedAt ?? null,
        centralFetchedAt: centralCache?.fetchedAt ?? null,
        speaker,
        config: ctx.cfg,
      },
    );
  }

  if (!configured) {
    return success('米家中枢未配置', '尚未配置 BE6500 Pro 路由器 SSH 地址（routerSsh），请先在配置中填写。', {
      fromCache: false,
      configured: false,
      degraded: false,
      routerSsh: '',
      devices: [],
      counts: {},
      gateway: null,
      subGateways: [],
      btService: null,
      btMeshDids: [],
      geekReady: false,
      geekUrl: '',
      geekGraphs: [],
      geekLogs: [],
      varScopes: [],
      variables: [],
      scenes: [],
      fetchedAt: null,
      hotDataFetchedAt: null,
      liveFetchedAt: null,
      centralFetchedAt: null,
      speaker,
      config: ctx.cfg,
    });
  }

  const cachedHub = !wantRefresh ? readHubCache(ctx.paths) : null;
  const cachedRouterDid = cachedHub?.devices?.find(d => d.category === 'router')?.did ?? '';
  let snapResult;
  let overview = null;
  let centralError;

  if (!wantRefresh && cachedRouterDid) {
    const [hubRes, centralRes] = await Promise.all([
      loadSnapshotBestEffort(ctx, { refresh: false, needHotData: true }),
      ctx.fetchCentralOverview({
        routerDid: cachedRouterDid,
        includeLogs: true,
        logLimit,
        includeCloudScenes: true,
        includeGraphContents: true,
      }).then(
        val => ({ ok: true, val }),
        err => ({ ok: false, err: errMsg(err) }),
      ),
    ]);
    snapResult = hubRes;
    if (centralRes.ok) overview = centralRes.val;
    else centralError = centralRes.err;
  } else {
    snapResult = await loadSnapshotBestEffort(ctx, { refresh: wantRefresh, needHotData: true });
    const routerDev = snapResult.snap.devices.find(d => d.category === 'router');
    try {
      overview = await ctx.fetchCentralOverview({
        routerDid: routerDev?.did ?? '',
        includeLogs: true,
        logLimit,
        includeCloudScenes: true,
        includeGraphContents: true,
      });
    } catch (err) {
      centralError = errMsg(err);
    }
  }

  const { snap, error: hubError } = snapResult;
  let live = new Map();
  let liveFetchedAt = snap.liveFetchedAt ?? null;
  if (wantLive && snap.devices.length > 0) {
    live = await liveForDevices(ctx, snap.devices);
    liveFetchedAt = persistLiveStates(ctx, snap, live, true).liveFetchedAt ?? liveFetchedAt;
  }

  const devicesByDid = buildDevicesByDid(snap.devices);
  const devices = buildDevicesView(ctx, snap.devices, live);
  const counts = {};
  for (const d of devices) counts[d.category] = (counts[d.category] ?? 0) + 1;

  const prevCentral = readCentralCache(ctx.paths.centralCachePath);
  if (overview) {
    const geekGraphs = summarizeGeekList(overview, devicesByDid);
    const graphNameById = new Map(geekGraphs.map(g => [String(g.id), String(g.name || g.id)]));
    const geekLogs = parseAutoLocalLogs(overview.rawLogText, { graphNameById, limit: logLimit });
    const scenes = summarizeScenesList(overview, devicesByDid, ctx.cfg);
    const variables = overview.varScopes.length > 0
      ? await fetchVariablesForScopes(ctx, overview.varScopes.slice(0, 8))
      : [];
    const centralFetchedAt = ctx.now();
    const centralPayload = {
      fetchedAt: centralFetchedAt,
      gateway: overview.gateway,
      subGateways: overview.subGateways,
      btService: overview.btService,
      btMeshDids: overview.btMeshDids,
      geekReady: overview.geekReady,
      geekUrl: overview.geekUrl,
      geekGraphs,
      geekLogs,
      varScopes: overview.varScopes,
      variables,
      scenes,
    };
    writeCentralCache(ctx.paths.centralCachePath, centralPayload);

    const meshCount = devices.filter(d => d.controlChannel === 'bt_mesh').length;
    const enabledRules = geekGraphs.filter(g => g.enable).length;
    const degraded = Boolean(hubError);
    return success(
      '米家中枢看板',
      `${overview.gateway.roleLabel}「${overview.gateway.homeName || 'BE6500 Pro'}」：${devices.length} 台设备（${meshCount} 台蓝牙 Mesh）、${enabledRules}/${geekGraphs.length} 条极客规则运行中、${scenes.length} 个本地场景${degraded ? `（设备库降级：${hubError}）` : ''}`,
      {
        fromCache: false,
        configured: true,
        degraded,
        ...(hubError ? { hubError } : {}),
        routerSsh: ctx.cfg.routerSsh,
        devices,
        counts,
        ...centralPayload,
        centralFetchedAt,
        fetchedAt: snap.fetchedAt || null,
        hotDataFetchedAt: snap.hotDataFetchedAt || null,
        liveFetchedAt,
        speaker,
        config: ctx.cfg,
      },
    );
  }

  const fallbackGateway = prevCentral?.gateway ?? null;
  const fallbackGraphs = Array.isArray(prevCentral?.geekGraphs) ? prevCentral.geekGraphs : [];
  const fallbackLogs = Array.isArray(prevCentral?.geekLogs) ? prevCentral.geekLogs : [];
  const fallbackScenes = Array.isArray(prevCentral?.scenes) ? prevCentral.scenes : [];
  const fallbackScopes = Array.isArray(prevCentral?.varScopes) ? prevCentral.varScopes : [];
  const fallbackVars = Array.isArray(prevCentral?.variables) ? prevCentral.variables : [];

  return success(
    '米家中枢看板（降级缓存）',
    `中枢实时读取失败（${centralError}），已回退本地缓存：${devices.length} 台设备、${fallbackGraphs.length} 条极客规则`,
    {
      fromCache: Boolean(prevCentral),
      configured: true,
      degraded: true,
      ...(hubError ? { hubError } : {}),
      ...(centralError ? { centralError } : {}),
      routerSsh: ctx.cfg.routerSsh,
      devices,
      counts,
      gateway: fallbackGateway,
      subGateways: Array.isArray(prevCentral?.subGateways) ? prevCentral.subGateways : [],
      btService: prevCentral?.btService ?? null,
      btMeshDids: Array.isArray(prevCentral?.btMeshDids) ? prevCentral.btMeshDids : [],
      geekReady: prevCentral?.geekReady === true,
      geekUrl: typeof prevCentral?.geekUrl === 'string' ? prevCentral.geekUrl : '',
      geekGraphs: fallbackGraphs,
      geekLogs: fallbackLogs,
      varScopes: fallbackScopes,
      variables: fallbackVars,
      scenes: fallbackScenes,
      fetchedAt: snap.fetchedAt || null,
      hotDataFetchedAt: snap.hotDataFetchedAt || null,
      liveFetchedAt,
      centralFetchedAt: prevCentral?.fetchedAt ?? null,
      speaker,
      config: ctx.cfg,
    },
  );
}

// ---- config ---------------------------------------------------------------

async function handleConfig(ctx) {
  const { args, paths } = ctx;
  const lockOutcome = await withFileLock(paths.configPath, () => {
    const prev = loadConfig(paths);
    const next = { ...prev };
    const errors = [];
    let changed = false;
    let routerChanged = false;
    if (args.routerSsh !== undefined) {
      const v = String(args.routerSsh ?? '').trim();
      if (!v) next.routerSsh = DEFAULT_CONFIG.routerSsh;
      else if (parseSshTargets(v, 'router').length === 0) errors.push(`routerSsh "${v}" 格式应为 [id=]user@host[:port]`);
      else next.routerSsh = v;
      changed = true;
      routerChanged = next.routerSsh !== prev.routerSsh;
    }
    if (args.speakerSsh !== undefined) {
      const v = String(args.speakerSsh ?? '').trim();
      if (v && (v.includes('@') ? parseSshTargets(v, 'lx06').length === 0 : !/^[A-Za-z0-9._-]+$/.test(v))) {
        errors.push(`speakerSsh "${v}" 格式应为 [id=]user@host[:port]`);
      } else {
        next.speakerSsh = v;
      }
      changed = true;
    }
    if (args.protectedDevices !== undefined) {
      next.protectedDevices = normalizeProtectedDevices(args.protectedDevices);
      changed = true;
    }
    if (args.customAliases !== undefined) {
      if (!args.customAliases || typeof args.customAliases !== 'object' || Array.isArray(args.customAliases)) {
        errors.push('customAliases 必须是 JSON 对象');
      } else {
        next.customAliases = normalizeCustomAliases(args.customAliases);
        changed = true;
      }
    }
    if (args.cacheTtlMs !== undefined) {
      const v = clampInt(args.cacheTtlMs, 0, 3_600_000);
      if (v === undefined) errors.push('cacheTtlMs 必须是 0-3600000 的数字');
      else next.cacheTtlMs = v;
      changed = true;
    }
    if (args.topologyTtlMs !== undefined) {
      const v = clampInt(args.topologyTtlMs, 0, 3_600_000);
      if (v === undefined) errors.push('topologyTtlMs 必须是 0-3600000 的数字');
      else next.topologyTtlMs = v;
      changed = true;
    }
    if (args.udpTimeoutMs !== undefined) {
      const v = clampInt(args.udpTimeoutMs, 300, 30_000);
      if (v === undefined) errors.push('udpTimeoutMs 必须是 300-30000 的数字');
      else next.udpTimeoutMs = v;
      changed = true;
    }
    if (errors.length) return { errors, prev };
    if (changed) {
      saveConfig(paths, next);
      if (routerChanged) {
        invalidateHubCache(paths);
      }
    }
    return { errors, next, changed };
  });
  if (lockOutcome.errors.length) {
    return failure('米家配置无效', lockOutcome.errors.join('；'), { config: lockOutcome.prev });
  }
  const { next, changed } = lockOutcome;
  let speaker = null;
  try {
    speaker = await discoverSpeakerSsh({ pluginDataDir: paths.pluginDataDir, dataDir: paths.dataDir, homeDir: paths.homeDir });
  } catch {
    speaker = null;
  }
  const text = `routerSsh=${next.routerSsh || '(未配置)'}, speakerSsh=${next.speakerSsh || '(自动发现)'}, protectedDevices=${next.protectedDevices.length}, cacheTtlMs=${next.cacheTtlMs}, topologyTtlMs=${next.topologyTtlMs}, udpTimeoutMs=${next.udpTimeoutMs}`;
  return success('米家配置', `${changed ? '✅ 已保存配置：' : '⚙️ 当前配置：'}${text}`, {
    config: next,
    speakerResolved: speaker ? { id: speaker.id, userHost: speaker.userHost, source: speaker.source } : null,
  });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Execute a miot plugin action. deps (all optional, for tests):
 * `{ dataDir, homeDir, env, sshBinaryExec, sshTextExec, fetchHubRawRows, udpCall, tvAgentRunner, sleepFn, nowFn }`.
 */
export async function handleVoiceFastpath(request, context = {}) {
  return handleMiotVoiceFastpath(request, context, (action, args, deps) => runAction(action, args, deps ?? context));
}

export async function runAction(action = 'status', args = {}, deps = {}) {
  const name = String(action || 'status').trim().toLowerCase();
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (!ACTIONS.includes(name)) {
    return sanitizeOutput(failure('米家操作失败', `不支持的 miot 动作 "${action}"，可用动作：${ACTIONS.join('、')}。`));
  }
  let result;
  try {
    const ctx = makeCtx(safeArgs, deps);
    switch (name) {
      case 'status': result = await handleStatus(ctx); break;
      case 'dashboard': result = await handleDashboard(ctx); break;
      case 'mesh': result = await handleMesh(ctx); break;
      case 'geek': result = await handleGeek(ctx); break;
      case 'scene': result = await handleScene(ctx); break;
      case 'devices': result = await handleDevices(ctx); break;
      case 'get': result = await handleGet(ctx); break;
      case 'set': result = await handleSet(ctx); break;
      case 'cook': result = await handleCook(ctx); break;
      case 'action': result = await handleActionCall(ctx); break;
      case 'command': result = await handleCommand(ctx); break;
      case 'config': result = await handleConfig(ctx); break;
      default: result = failure('米家操作失败', `未实现的动作 ${name}`);
    }
  } catch (err) {
    result = failFromError('米家操作失败', err);
  }
  return sanitizeOutput(result);
}

async function main() {
  const action = process.argv[2] || 'status';
  let args = {};
  try {
    args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  } catch {
    args = {};
  }
  try {
    const result = await runAction(action, args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify(sanitizeOutput({ ok: false, notify: true, title: '米家操作失败', message: errMsg(err) }))}\n`);
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  await main();
}

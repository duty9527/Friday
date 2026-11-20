#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  clampInt,
  ensurePrivateDir,
  errMsg,
  readConfig,
  readJsonSafe,
  resolvePluginPaths,
  withFileLock,
  writeConfig,
  writeJsonAtomic,
} from '../_shared/config-store.mjs';

const execFileAsync = promisify(execFile);
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = join(PLUGIN_DIR, 'ble_helper.py');

export const ACTIONS = ['dashboard', 'status', 'scan', 'on', 'off', 'resume', 'config'];

export const DEFAULT_CHANNELS = Object.freeze({
  red: 69,
  green: 54,
  white: 98,
  blue: 54,
  fan: 0,
});

export const DEFAULT_CONFIG = Object.freeze({
  targetMac: '',
  namePrefix: 'SG-',
  fadeSeconds: 3,
  defaultChannels: DEFAULT_CHANNELS,
});

/**
 * @typedef {{ red: number; green: number; white: number; blue: number; fan: number }} NetleaChannels
 * @typedef {{ targetMac: string; namePrefix: string; fadeSeconds: number; defaultChannels: NetleaChannels }} NetleaConfig
 */

/**
 * Compute Netlea modulo-256 checksum.
 * @param {number[]} bytes
 * @returns {number}
 */
export function crc(bytes) {
  let sum = 0;
  for (const b of bytes) {
    sum = (sum + (Number(b) & 0xff)) & 0xff;
  }
  return sum;
}

/**
 * Parse a hex string into byte integers.
 * @param {unknown} raw
 * @returns {number[]}
 */
export function hexBytes(raw) {
  const clean = String(raw ?? '').replace(/\s+/g, '');
  if (!clean || clean.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(clean)) {
    return [];
  }
  const out = [];
  for (let i = 0; i < clean.length; i += 2) {
    out.push(Number.parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * Build one 0x5A Netlea control frame as uppercase hex.
 * @param {number} deviceType
 * @param {number} command
 * @param {number[]} [payload]
 * @returns {string}
 */
export function buildAppFrame(deviceType, command, payload = []) {
  const frame = [
    0x5a,
    0,
    Number(deviceType) & 0xff,
    Number(command) & 0xff,
    0,
    0,
    ...payload.map(b => Number(b) & 0xff),
  ];
  frame[1] = frame.length + 1;
  frame.push(crc(frame));
  return frame.map(b => (b & 0xff).toString(16).padStart(2, '0').toUpperCase()).join('');
}

/**
 * Build the 0x13 lamp state query frame (`5A070113000075`).
 * @returns {string}
 */
export function buildQueryStateFrame() {
  return buildAppFrame(0x01, 0x13, []);
}

/**
 * Build the 0x1A temporary viewing light on/off and RGBWF channel control frame.
 * Verified on SG-X-PRO-60w11: payload channel bytes map to [red, green, white, blue, fan].
 * @param {boolean} on
 * @param {Record<string, unknown>} [opts]
 * @returns {string}
 */
export function buildTempLightFrame(on, opts = {}) {
  const fadeSeconds = clampInt(opts.fadeSeconds, 0, 60) ?? DEFAULT_CONFIG.fadeSeconds;
  const onSeconds = clampInt(opts.onSeconds, 0, 65535) ?? fadeSeconds;
  const offSeconds = clampInt(opts.offSeconds, 0, 65535) ?? fadeSeconds;

  let red = 0;
  let green = 0;
  let white = 0;
  let blue = 0;
  let fan = 0;
  let modeId = 0;
  let grade = 0;

  if (on) {
    red = clampInt(opts.red, 0, 100) ?? DEFAULT_CHANNELS.red;
    green = clampInt(opts.green, 0, 100) ?? DEFAULT_CHANNELS.green;
    white = clampInt(opts.white, 0, 100) ?? DEFAULT_CHANNELS.white;
    blue = clampInt(opts.blue, 0, 100) ?? DEFAULT_CHANNELS.blue;
    fan = clampInt(opts.fan, 0, 5) ?? DEFAULT_CHANNELS.fan;
    modeId = clampInt(opts.modeId, 0, 255) ?? 1;
    grade = clampInt(opts.grade, 0, 65535) ?? 9;
  }

  return buildAppFrame(0x01, 0x1a, [
    onSeconds & 0xff,
    (onSeconds >> 8) & 0xff,
    offSeconds & 0xff,
    (offSeconds >> 8) & 0xff,
    red & 0xff,
    green & 0xff,
    white & 0xff,
    blue & 0xff,
    fan & 0xff,
    modeId & 0xff,
    grade & 0xff,
    (grade >> 8) & 0xff,
  ]);
}

/**
 * Build the 0x10 resume 24h schedule frame.
 * @param {number | boolean} [lampStateHint]
 * @returns {string}
 */
export function buildResumeScheduleFrame(lampStateHint = 1) {
  const hint = lampStateHint ? 1 : 0;
  return buildAppFrame(0x01, 0x10, [hint, ...new Array(15).fill(0)]);
}

/**
 * Decode a 38-byte 0x14 lamp state frame emitted on GATT 0xFF01.
 * @param {unknown} hex
 * @returns {{
 *   rawHex: string;
 *   on: boolean;
 *   channels: NetleaChannels;
 *   master: Record<string, number>;
 *   spot: Record<string, number>;
 *   atmosphere: Record<string, number>;
 * } | null}
 */
export function decodeLampsStateFrame(hex) {
  const bytes = hexBytes(hex);
  if (bytes.length < 38 || bytes[0] !== 0x5a || bytes[2] !== 0x01 || bytes[3] !== 0x14) {
    return null;
  }
  const declaredLen = bytes[1];
  const frameBytes = declaredLen >= 38 && declaredLen <= bytes.length ? bytes.slice(0, declaredLen) : bytes;
  if (crc(frameBytes.slice(0, -1)) !== frameBytes[frameBytes.length - 1]) {
    return null;
  }
  const p = frameBytes.slice(6, -1);
  if (p.length < 31) {
    return null;
  }
  const master = {
    stateType: p[0],
    startH: p[1],
    startM: p[2],
    lampState: p[3],
    lampMode: p[4],
    pattern: p[5],
    red: p[6],
    green: p[7],
    white: p[8],
    blue: p[9],
    fan: p[10],
    reserve1: p[11],
    reserve2: p[12],
  };
  const spot = {
    stateType: p[13],
    startH: p[14],
    startM: p[15],
    lampState: p[16],
    lampMode: p[17],
    pattern: p[18],
    moodLamp: p[19],
    followType: p[20],
    reserve1: p[21],
  };
  const atmosphere = {
    stateType: p[22],
    startH: p[23],
    startM: p[24],
    lampState: p[25],
    lampMode: p[26],
    pattern: p[27],
    moodLamp: p[28],
    followType: p[29],
    reserve1: p[30],
  };
  return {
    rawHex: frameBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(''),
    on: master.lampState === 1,
    channels: {
      red: master.red,
      green: master.green,
      white: master.white,
      blue: master.blue,
      fan: master.fan,
    },
    master,
    spot,
    atmosphere,
  };
}

/**
 * Decode Netlea BLE ManufacturerData (`0x0000`) into RTC clock, deviceType, and MAC.
 * @param {Record<string, unknown> | null | undefined} mfgMap
 * @returns {{
 *   rtc: string;
 *   year: number;
 *   month: number;
 *   day: number;
 *   hour: number;
 *   minute: number;
 *   second: number;
 *   flags: number;
 *   deviceType: number;
 *   realAddress: string;
 *   mac: string;
 * } | null}
 */
export function decodeManufacturerData(mfgMap) {
  if (!mfgMap || typeof mfgMap !== 'object') return null;
  let hex = '';
  for (const [k, v] of Object.entries(mfgMap)) {
    if (String(k).toLowerCase() === '0x0000') {
      hex = String(v ?? '');
      break;
    }
  }
  if (!hex) return null;
  const bytes = hexBytes(hex);
  if (bytes.length < 14) return null;
  const [yy, month, day, hour, minute, second, flags, deviceType] = bytes;
  const year = 2000 + yy;
  const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const macBytes = bytes.slice(8, 14);
  const hexPairs = macBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase());
  return {
    rtc: `${year}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
    year,
    month,
    day,
    hour,
    minute,
    second,
    flags,
    deviceType,
    realAddress: hexPairs.join(''),
    mac: hexPairs.join(':'),
  };
}

/**
 * Normalize a BLE MAC address (`AA:BB:CC:DD:EE:FF` or `AABBCCDDEEFF`), returning
 * `''` when intentionally empty and `null` when invalid.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeMac(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const compact = s.replace(/[:\-.\s]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(compact)) return null;
  return compact.match(/.{2}/g)?.join(':') ?? null;
}

/**
 * Sanitize and normalize stored channel presets.
 * @param {unknown} raw
 * @param {NetleaChannels} [fallback]
 * @returns {NetleaChannels}
 */
function sanitizeChannels(raw, fallback = DEFAULT_CHANNELS) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  return {
    red: clampInt(obj.red ?? obj.r, 0, 100) ?? fallback.red,
    green: clampInt(obj.green ?? obj.g, 0, 100) ?? fallback.green,
    white: clampInt(obj.white ?? obj.w, 0, 100) ?? fallback.white,
    blue: clampInt(obj.blue ?? obj.b, 0, 100) ?? fallback.blue,
    fan: clampInt(obj.fan ?? obj.f, 0, 5) ?? fallback.fan,
  };
}

/**
 * Resolve effective channels for the `on` action, supporting proportional `brightness`
 * scaling over `defaultChannels` and explicit per-channel overrides.
 * @param {Record<string, unknown>} [args]
 * @param {NetleaChannels} [defaultChannels]
 * @returns {NetleaChannels}
 */
export function resolveChannelsForOn(args = {}, defaultChannels = DEFAULT_CHANNELS) {
  const base = sanitizeChannels(defaultChannels, DEFAULT_CHANNELS);
  const brightness = clampInt(args.brightness, 0, 100);
  let resolved = { ...base };
  if (brightness !== undefined) {
    const scaleBase = (base.red + base.green + base.white + base.blue) > 0 ? base : DEFAULT_CHANNELS;
    const scale = brightness / 100;
    resolved = {
      red: clampInt(Math.round(scaleBase.red * scale), 0, 100) ?? 0,
      green: clampInt(Math.round(scaleBase.green * scale), 0, 100) ?? 0,
      white: clampInt(Math.round(scaleBase.white * scale), 0, 100) ?? 0,
      blue: clampInt(Math.round(scaleBase.blue * scale), 0, 100) ?? 0,
      fan: base.fan,
    };
  }
  const overrideRed = clampInt(args.red ?? args.r, 0, 100);
  const overrideGreen = clampInt(args.green ?? args.g, 0, 100);
  const overrideWhite = clampInt(args.white ?? args.w, 0, 100);
  const overrideBlue = clampInt(args.blue ?? args.b, 0, 100);
  const overrideFan = clampInt(args.fan ?? args.f, 0, 5);

  if (overrideRed !== undefined) resolved.red = overrideRed;
  if (overrideGreen !== undefined) resolved.green = overrideGreen;
  if (overrideWhite !== undefined) resolved.white = overrideWhite;
  if (overrideBlue !== undefined) resolved.blue = overrideBlue;
  if (overrideFan !== undefined) resolved.fan = overrideFan;
  return resolved;
}

/**
 * Load normalized Netlea config from `<pluginDataDir>/config.json`.
 * @param {string} configPath
 * @returns {NetleaConfig}
 */
function loadNormalizedConfig(configPath) {
  const raw = readConfig(configPath, /** @type {Record<string, unknown>} */ ({ ...DEFAULT_CONFIG }));
  const normMac = normalizeMac(raw.targetMac);
  const namePrefix = typeof raw.namePrefix === 'string' && raw.namePrefix.trim()
    ? raw.namePrefix.trim()
    : DEFAULT_CONFIG.namePrefix;
  const fadeSeconds = clampInt(raw.fadeSeconds, 0, 60) ?? DEFAULT_CONFIG.fadeSeconds;
  const defaultChannels = sanitizeChannels(raw.defaultChannels, DEFAULT_CHANNELS);
  return {
    targetMac: normMac || '',
    namePrefix,
    fadeSeconds,
    defaultChannels,
  };
}

/**
 * Format channel summary text.
 * @param {NetleaChannels} ch
 * @returns {string}
 */
function formatChannels(ch) {
  return `R:${ch.red} G:${ch.green} W:${ch.white} B:${ch.blue} 风扇:${ch.fan}`;
}

/**
 * Format a compact device summary for `status` and control actions.
 * @param {Record<string, unknown> | null | undefined} device
 * @param {ReturnType<typeof decodeLampsStateFrame>} state
 * @param {string} [prefix]
 * @returns {string}
 */
function formatStatusMessage(device, state, prefix = '') {
  const parts = [];
  if (prefix) parts.push(prefix);
  const name = typeof device?.name === 'string' && device.name.trim() ? device.name.trim() : '尼特利鱼缸灯';
  const rssi = typeof device?.rssi === 'number' ? `（RSSI ${device.rssi} dBm）` : '';
  parts.push(`${name}${rssi}`);
  if (state) {
    parts.push(`状态：${state.on ? '开启' : '关闭'}`);
    parts.push(`通道 ${formatChannels(state.channels)}`);
  }
  const adv = device?.advertisement && typeof device.advertisement === 'object'
    ? /** @type {Record<string, unknown>} */ (device.advertisement)
    : null;
  if (adv && typeof adv.rtc === 'string' && adv.rtc) {
    parts.push(`灯内时钟 ${adv.rtc}`);
  }
  return parts.join('｜');
}

/**
 * Create the default BlueZ subprocess runner, preferring system `/usr/bin/python3`
 * where python3-dbus / PyGObject are installed.
 * @param {string | undefined} explicitPython
 */
function createDefaultBleRunner(explicitPython) {
  const pythonBin = explicitPython?.trim()
    || (existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3');
  /**
   * @param {string[]} commandArgs
   * @param {number} [timeoutMs]
   * @param {AbortSignal} [signal]
   * @returns {Promise<Record<string, unknown>>}
   */
  return async function defaultBleRunner(commandArgs, timeoutMs = 25_000, signal) {
    const { stdout } = await execFileAsync(pythonBin, [HELPER_PATH, ...commandArgs], {
      cwd: PLUGIN_DIR,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    });
    const trimmed = String(stdout || '').trim();
    if (!trimmed) return {};
    return JSON.parse(trimmed);
  };
}

/**
 * @param {string} platform
 */
function disabledBleResult(platform) {
  return {
    ok: false,
    notify: true,
    title: '当前系统已关闭尼特利蓝牙控制',
    message: `尼特利鱼缸灯本地蓝牙直控依赖 Linux BlueZ D-Bus，在当前平台（${platform}）已动态关闭。`,
  };
}

/**
 * Format a failed BLE helper response into a friendly plugin result.
 * @param {Record<string, unknown>} raw
 * @param {string} targetMac
 */
function formatBleFailure(raw, targetMac) {
  const code = typeof raw.code === 'string' && raw.code ? raw.code : 'BLE_ERROR';
  if (code === 'NOT_FOUND') {
    return {
      ok: false,
      notify: true,
      title: '未找到尼特利鱼缸灯',
      message: '未扫描到尼特利鱼缸灯蓝牙广播，请确认灯具已通电且手机「尼特利智能」App/小程序未占用蓝牙连接。',
      data: {
        code,
        ...(targetMac ? { targetMac } : {}),
      },
    };
  }
  return {
    ok: false,
    notify: true,
    title: '尼特利蓝牙控制失败',
    message: typeof raw.error === 'string' && raw.error ? raw.error : '蓝牙通讯失败',
    data: {
      code,
      ...(raw.device ? { device: sanitizeDeviceView(raw.device) } : {}),
    },
  };
}

/**
 * Strip BlueZ object paths and enrich advertisement RTC decoding.
 * @param {unknown} rawDev
 */
function sanitizeDeviceView(rawDev) {
  if (!rawDev || typeof rawDev !== 'object') return null;
  const d = /** @type {Record<string, unknown>} */ (rawDev);
  const mfg = d.manufacturerData && typeof d.manufacturerData === 'object'
    ? /** @type {Record<string, unknown>} */ (d.manufacturerData)
    : undefined;
  const advertisement = decodeManufacturerData(mfg);
  return {
    address: typeof d.address === 'string' ? d.address : '',
    name: typeof d.name === 'string' ? d.name : '',
    rssi: typeof d.rssi === 'number' ? d.rssi : null,
    uuids: Array.isArray(d.uuids) ? d.uuids.map(String) : [],
    connected: Boolean(d.connected),
    ...(typeof d.seenAt === 'number' ? { seenAt: d.seenAt } : {}),
    ...(advertisement ? { advertisement } : {}),
  };
}

/**
 * Persist sanitized last-known device and state snapshot atomically with 0o600.
 * @param {string} statePath
 * @param {Record<string, unknown> | null} deviceView
 * @param {ReturnType<typeof decodeLampsStateFrame>} state
 * @param {number} nowMs
 */
async function saveLastState(statePath, deviceView, state, nowMs) {
  await withFileLock(statePath, () => {
    const prev = readJsonSafe(statePath, {});
    const prevObj = prev && typeof prev === 'object' && !Array.isArray(prev)
      ? /** @type {Record<string, unknown>} */ (prev)
      : {};
    const lastAddress = (deviceView && typeof deviceView.address === 'string' && deviceView.address)
      || (typeof prevObj.lastAddress === 'string' ? prevObj.lastAddress : '');
    writeJsonAtomic(
      statePath,
      {
        updatedAt: nowMs,
        lastAddress,
        device: deviceView ?? prevObj.device ?? null,
        state: state ?? prevObj.state ?? null,
      },
      { mode: 0o600 },
    );
  });
}

/**
 * Read cached last-state snapshot safely from disk.
 * @param {string} statePath
 * @returns {{
 *   updatedAt: number | null;
 *   lastAddress: string | null;
 *   device: Record<string, unknown> | null;
 *   state: ReturnType<typeof decodeLampsStateFrame>;
 * }}
 */
function readCachedSnapshot(statePath) {
  const cachedRaw = readJsonSafe(statePath, null);
  const cached = cachedRaw && typeof cachedRaw === 'object' && !Array.isArray(cachedRaw)
    ? /** @type {Record<string, unknown>} */ (cachedRaw)
    : null;
  const device = cached?.device && typeof cached.device === 'object'
    ? /** @type {Record<string, unknown>} */ (cached.device)
    : null;
  const state = cached?.state && typeof cached.state === 'object'
    ? /** @type {ReturnType<typeof decodeLampsStateFrame>} */ (cached.state)
    : null;
  const updatedAt = typeof cached?.updatedAt === 'number' ? cached.updatedAt : null;
  const lastAddress = typeof cached?.lastAddress === 'string' && cached.lastAddress
    ? cached.lastAddress
    : null;
  return { updatedAt, lastAddress, device, state };
}

/**
 * Execute one BLE `command` frame via helper, decode reply, and update cached state.
 * @param {{
 *   bleRunner: (cmdArgs: string[], timeoutMs?: number, signal?: AbortSignal) => Promise<Record<string, unknown>>;
 *   txFrame: string;
 *   effectiveTargetMac: string;
 *   preferMac: string;
 *   namePrefix: string;
 *   safeArgs: Record<string, unknown>;
 *   statePath: string;
 *   nowFn: () => number;
 *   signal?: AbortSignal;
 * }} opts
 */
async function runBleCommandFrame(opts) {
  const {
    bleRunner,
    txFrame,
    effectiveTargetMac,
    preferMac,
    namePrefix,
    safeArgs,
    statePath,
    nowFn,
    signal,
  } = opts;
  const scanTimeoutSec = clampInt(safeArgs.scanTimeoutSec, 2, 15) ?? 6;
  const connectTimeoutSec = clampInt(safeArgs.connectTimeoutSec, 3, 20) ?? 10;
  const replyTimeoutSec = clampInt(safeArgs.replyTimeoutSec, 1, 10) ?? 3;
  const execTimeoutMs = (scanTimeoutSec + connectTimeoutSec + replyTimeoutSec + 6) * 1000;

  let raw;
  try {
    raw = await bleRunner(
      [
        'command',
        '--tx',
        txFrame,
        '--target-mac',
        effectiveTargetMac,
        '--prefer-mac',
        preferMac,
        '--name-prefix',
        namePrefix,
        '--scan-timeout',
        String(scanTimeoutSec),
        '--connect-timeout',
        String(connectTimeoutSec),
        '--reply-timeout',
        String(replyTimeoutSec),
      ],
      execTimeoutMs,
      signal,
    );
  } catch (err) {
    return {
      ok: false,
      errorResult: {
        ok: false,
        notify: true,
        title: '蓝牙执行异常',
        message: `尼特利蓝牙指令执行异常：${errMsg(err)}`,
      },
    };
  }

  if (!raw || raw.ok === false) {
    return { ok: false, errorResult: formatBleFailure(raw || {}, effectiveTargetMac) };
  }

  const deviceView = sanitizeDeviceView(raw.device);
  const state = decodeLampsStateFrame(raw.stateHex);
  await saveLastState(statePath, deviceView, state, nowFn());
  return {
    ok: true,
    deviceView,
    state,
    replies: Array.isArray(raw.replies) ? raw.replies : [],
  };
}

/**
 * Execute one Netlea plugin action (`dashboard`, `status`, `scan`, `on`, `off`, `resume`, `config`).
 * @param {string} action
 * @param {Record<string, unknown>} [args]
 * @param {import('../_shared/types.d.ts').PluginExecutionContext} [deps]
 */
export async function runAction(action = 'status', args = {}, deps = {}) {
  const cleanAction = String(action || 'status').trim() || 'status';
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const safeDeps = deps && typeof deps === 'object' ? deps : {};

  // Never forward args to resolvePluginPaths so args.dataDir cannot redirect storage.
  const paths = resolvePluginPaths('netlea', safeDeps, { statePath: 'last-state.json' });
  ensurePrivateDir(paths.pluginDataDir);

  const platform = typeof safeDeps.platform === 'string' ? safeDeps.platform : process.platform;
  const hasInjectedRunner = typeof safeDeps.bleRunner === 'function';
  const bleRunner = hasInjectedRunner
    ? /** @type {(cmdArgs: string[], timeoutMs?: number, signal?: AbortSignal) => Promise<Record<string, unknown>>} */ (safeDeps.bleRunner)
    : createDefaultBleRunner(typeof safeDeps.pythonBin === 'string' ? safeDeps.pythonBin : undefined);
  const nowFn = typeof safeDeps.nowFn === 'function' ? safeDeps.nowFn : () => Date.now();
  const signal = safeDeps.signal instanceof AbortSignal ? safeDeps.signal : undefined;

  const config = loadNormalizedConfig(paths.configPath);

  if (cleanAction === 'config') {
    let validationError = '';
    const updated = await withFileLock(paths.configPath, () => {
      const current = loadNormalizedConfig(paths.configPath);
      const next = {
        ...current,
        defaultChannels: { ...current.defaultChannels },
      };
      if (Object.prototype.hasOwnProperty.call(safeArgs, 'targetMac')) {
        const parsedMac = normalizeMac(safeArgs.targetMac);
        if (parsedMac === null) {
          validationError = 'targetMac 格式无效，请使用 AA:BB:CC:DD:EE:FF 或留空清除绑定';
          return current;
        }
        next.targetMac = parsedMac;
      }
      if (Object.prototype.hasOwnProperty.call(safeArgs, 'namePrefix')) {
        const prefix = String(safeArgs.namePrefix ?? '').trim();
        next.namePrefix = prefix || DEFAULT_CONFIG.namePrefix;
      }
      if (Object.prototype.hasOwnProperty.call(safeArgs, 'fadeSeconds')) {
        const fade = clampInt(safeArgs.fadeSeconds, 0, 60);
        if (fade === undefined) {
          validationError = 'fadeSeconds 必须为 0-60 之间的整数';
          return current;
        }
        next.fadeSeconds = fade;
      }
      const chArg = safeArgs.defaultChannels && typeof safeArgs.defaultChannels === 'object' && !Array.isArray(safeArgs.defaultChannels)
        ? /** @type {Record<string, unknown>} */ (safeArgs.defaultChannels)
        : null;
      if (chArg) {
        next.defaultChannels = sanitizeChannels(chArg, current.defaultChannels);
      } else if (
        safeArgs.red !== undefined || safeArgs.green !== undefined
        || safeArgs.white !== undefined || safeArgs.blue !== undefined
        || safeArgs.fan !== undefined
      ) {
        next.defaultChannels = sanitizeChannels(safeArgs, current.defaultChannels);
      }
      writeConfig(paths.configPath, next);
      return next;
    });

    if (validationError) {
      return {
        ok: false,
        notify: true,
        title: '配置校验失败',
        message: validationError,
      };
    }

    return {
      ok: true,
      notify: true,
      title: '尼特利鱼缸灯配置',
      message: `目标 MAC：${updated.targetMac || '自动发现（前缀 ' + updated.namePrefix + '）'}｜渐变：${updated.fadeSeconds}s｜默认通道 ${formatChannels(updated.defaultChannels)}`,
      data: {
        config: updated,
      },
    };
  }

  if (!ACTIONS.includes(cleanAction)) {
    return {
      ok: false,
      notify: true,
      title: '不支持的插件动作',
      message: `netlea 不支持动作 "${cleanAction}"，可用动作：${ACTIONS.join(', ')}`,
    };
  }

  // Handle dryRun / non-live status before Linux BLE check
  const argMacNorm = Object.prototype.hasOwnProperty.call(safeArgs, 'targetMac')
    ? normalizeMac(safeArgs.targetMac)
    : undefined;
  if (argMacNorm === null) {
    return {
      ok: false,
      notify: true,
      title: 'MAC 地址无效',
      message: 'targetMac 格式无效，请传入 AA:BB:CC:DD:EE:FF 格式或留空。',
    };
  }
  const effectiveTargetMac = argMacNorm !== undefined ? argMacNorm : config.targetMac;

  if (cleanAction === 'dashboard') {
    const wantRefresh = safeArgs.refresh === true;
    if (wantRefresh) {
      if (platform !== 'linux' && !hasInjectedRunner) {
        return disabledBleResult(platform);
      }
      const prevSnap = readCachedSnapshot(paths.statePath);
      const cmdRes = await runBleCommandFrame({
        bleRunner,
        txFrame: buildQueryStateFrame(),
        effectiveTargetMac,
        preferMac: prevSnap.lastAddress || '',
        namePrefix: config.namePrefix,
        safeArgs,
        statePath: paths.statePath,
        nowFn,
        signal,
      });
      if (!cmdRes.ok) {
        return cmdRes.errorResult;
      }
    }

    const snap = readCachedSnapshot(paths.statePath);
    const dev = snap.device;
    const st = snap.state;
    const adv = dev?.advertisement && typeof dev.advertisement === 'object'
      ? /** @type {Record<string, unknown>} */ (dev.advertisement)
      : null;
    const rtcText = typeof adv?.rtc === 'string' && adv.rtc ? adv.rtc : '';
    const shortRtc = rtcText.length >= 19 ? rtcText.slice(11, 19) : (rtcText || '--');
    const summaryText = st
      ? (st.on ? `开启 · W${st.channels.white}%` : '已关闭')
      : '待同步';
    const spectrumText = st
      ? `R${st.channels.red} G${st.channels.green} W${st.channels.white} B${st.channels.blue}`
      : `预设 R${config.defaultChannels.red} W${config.defaultChannels.white}`;

    return {
      ok: true,
      notify: false,
      title: '尼特利鱼缸灯看板',
      message: st ? formatStatusMessage(dev, st) : '鱼缸灯尚未同步实时状态，可点击实时读取。',
      data: {
        状态: summaryText,
        光谱: spectrumText,
        信号: typeof dev?.rssi === 'number' ? `${dev.rssi} dBm` : '--',
        灯内时钟: shortRtc,
        设备: (typeof dev?.name === 'string' && dev.name) ? dev.name.slice(0, 22) : (config.targetMac || '自动发现'),
        渐变: `${config.fadeSeconds}s`,
        refreshed: wantRefresh,
        updatedAt: snap.updatedAt,
        lastAddress: snap.lastAddress,
        device: dev,
        state: st,
        config,
      },
    };
  }

  if (cleanAction === 'status' && safeArgs.live === false) {
    const snap = readCachedSnapshot(paths.statePath);
    return {
      ok: true,
      notify: true,
      title: '尼特利鱼缸灯缓存状态',
      message: snap.state
        ? formatStatusMessage(snap.device, snap.state, '最近缓存')
        : '尚无鱼缸灯历史状态缓存，请执行一次实时 status 或 scan。',
      data: {
        live: false,
        updatedAt: snap.updatedAt,
        lastAddress: snap.lastAddress,
        device: snap.device,
        state: snap.state,
        config,
      },
    };
  }

  // Build TX frame for control/query actions to validate args & support dryRun cleanly
  let txFrame = '';
  /** @type {NetleaChannels | undefined} */
  let plannedChannels;
  let effectiveAction = cleanAction;

  if (cleanAction === 'status') {
    txFrame = buildQueryStateFrame();
  } else if (cleanAction === 'on') {
    const hasExplicitChannel = (
      safeArgs.red ?? safeArgs.r ?? safeArgs.green ?? safeArgs.g
      ?? safeArgs.white ?? safeArgs.w ?? safeArgs.blue ?? safeArgs.b
      ?? safeArgs.fan ?? safeArgs.f
    ) !== undefined;
    const reqBrightness = clampInt(safeArgs.brightness, 0, 100);
    if (reqBrightness === 0 && !hasExplicitChannel) {
      effectiveAction = 'off';
      txFrame = buildTempLightFrame(false, {
        fadeSeconds: safeArgs.fadeSeconds ?? config.fadeSeconds,
        onSeconds: safeArgs.onSeconds,
        offSeconds: safeArgs.offSeconds,
      });
    } else {
      plannedChannels = resolveChannelsForOn(safeArgs, config.defaultChannels);
      txFrame = buildTempLightFrame(true, {
        ...plannedChannels,
        fadeSeconds: safeArgs.fadeSeconds ?? config.fadeSeconds,
        onSeconds: safeArgs.onSeconds,
        offSeconds: safeArgs.offSeconds,
        modeId: safeArgs.modeId,
        grade: safeArgs.grade,
      });
    }
  } else if (cleanAction === 'off') {
    txFrame = buildTempLightFrame(false, {
      fadeSeconds: safeArgs.fadeSeconds ?? config.fadeSeconds,
      onSeconds: safeArgs.onSeconds,
      offSeconds: safeArgs.offSeconds,
    });
  } else if (cleanAction === 'resume') {
    const hint = safeArgs.lampStateHint === 0 || safeArgs.lampStateHint === false ? 0 : 1;
    txFrame = buildResumeScheduleFrame(hint);
  }

  if (safeArgs.dryRun === true && cleanAction !== 'scan') {
    return {
      ok: true,
      notify: true,
      title: '尼特利指令预演 (dryRun)',
      message: `dryRun 模式：将向 ${effectiveTargetMac || '自动发现灯具'} 发送帧 ${txFrame}`,
      data: {
        dryRun: true,
        action: effectiveAction,
        targetMac: effectiveTargetMac || null,
        tx: txFrame,
        ...(plannedChannels ? { channels: plannedChannels } : {}),
      },
    };
  }

  if (platform !== 'linux' && !hasInjectedRunner) {
    return disabledBleResult(platform);
  }

  const preferMac = readCachedSnapshot(paths.statePath).lastAddress ?? '';

  if (cleanAction === 'scan') {
    const timeoutSec = clampInt(safeArgs.timeoutSec ?? safeArgs.timeout, 1, 15) ?? 5;
    let raw;
    try {
      raw = await bleRunner(
        [
          'scan',
          '--timeout',
          String(timeoutSec),
          '--target-mac',
          effectiveTargetMac,
          '--name-prefix',
          config.namePrefix,
        ],
        (timeoutSec + 10) * 1000,
        signal,
      );
    } catch (err) {
      return {
        ok: false,
        notify: true,
        title: '蓝牙扫描失败',
        message: `扫描尼特利鱼缸灯失败：${errMsg(err)}`,
      };
    }

    if (!raw || raw.ok === false) {
      return formatBleFailure(raw || {}, effectiveTargetMac);
    }

    const rawDevices = Array.isArray(raw.devices) ? raw.devices : [];
    const devices = rawDevices.map(d => sanitizeDeviceView(d)).filter(Boolean);
    if (devices.length > 0) {
      await saveLastState(paths.statePath, devices[0], null, nowFn());
    }

    if (devices.length === 0) {
      return {
        ok: true,
        notify: true,
        title: '未扫描到尼特利鱼缸灯',
        message: '未扫描到尼特利鱼缸灯蓝牙广播，请确认灯具已通电且手机 App 未占用连接。',
        data: { devices: [] },
      };
    }

    const summary = devices
      .map(d => {
        const adv = d.advertisement ? `｜时钟 ${d.advertisement.rtc}` : '';
        return `${d.name || 'Netlea'} (${d.address}, RSSI ${d.rssi ?? '--'} dBm${adv})`;
      })
      .join('；');

    return {
      ok: true,
      notify: true,
      title: `扫描到 ${devices.length} 台尼特利设备`,
      message: summary,
      data: { devices },
    };
  }

  // Execute BLE command (`status`, `on`, `off`, `resume`)
  const cmdRes = await runBleCommandFrame({
    bleRunner,
    txFrame,
    effectiveTargetMac,
    preferMac,
    namePrefix: config.namePrefix,
    safeArgs,
    statePath: paths.statePath,
    nowFn,
    signal,
  });
  if (!cmdRes.ok) {
    return cmdRes.errorResult;
  }

  const { deviceView, state, replies } = cmdRes;

  const titleMap = {
    status: '尼特利鱼缸灯状态',
    on: '鱼缸灯已临时开启',
    off: '鱼缸灯已临时关闭',
    resume: '鱼缸灯已恢复自动行程',
  };
  const prefixMap = {
    status: '',
    on: '临时开灯完成',
    off: '临时关灯完成',
    resume: '已切换回 24h 自动行程',
  };

  return {
    ok: true,
    notify: true,
    title: titleMap[effectiveAction] ?? '尼特利鱼缸灯',
    message: state
      ? formatStatusMessage(deviceView, state, prefixMap[effectiveAction] ?? '')
      : `${prefixMap[effectiveAction] || '指令已确认'}（${deviceView?.name || '尼特利鱼缸灯'}）`,
    data: {
      live: true,
      action: effectiveAction,
      tx: txFrame,
      ...(plannedChannels ? { plannedChannels } : {}),
      device: deviceView,
      state,
      replies,
    },
  };
}

async function main() {
  const action = process.argv[2] || 'status';
  let args = /** @type {Record<string, unknown>} */ ({});
  try {
    args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  } catch {
    args = {};
  }
  const result = await runAction(action, args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  await main();
}

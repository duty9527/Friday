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
import {
  DEFAULT_XPRO_MODEL,
  buildCatalogSummary,
  buildPresetSchedule,
  decodeHardwarePwm,
  encodeCustomChannelsPwm,
  encodeSceneGearPwm,
  normalizeDayList,
  normalizeTripInput,
  resolveXproProfile,
  validateAndAnnotateTrips,
} from './xpro-profiles.mjs';

const execFileAsync = promisify(execFile);
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = join(PLUGIN_DIR, 'ble_helper.py');

export const ACTIONS = [
  'dashboard',
  'status',
  'scan',
  'on',
  'off',
  'mode',
  'resume',
  'schedule',
  'clock',
  'config',
];

export const DEFAULT_CHANNELS = Object.freeze({
  red: 39,
  green: 59,
  white: 79,
  blue: 36,
  fan: 0,
});

export const DEFAULT_TANK_SIZE = Object.freeze({
  lengthCm: 60,
  widthCm: 30,
  heightCm: 36,
  lampCount: 1,
});

export const DEFAULT_CONFIG = Object.freeze({
  targetMac: '',
  namePrefix: 'SG-',
  fadeSeconds: 3,
  tempOnMinutes: 20,
  tempOffMinutes: 20,
  tankSize: DEFAULT_TANK_SIZE,
  defaultChannels: DEFAULT_CHANNELS,
  savedCustomPresets: [],
});

/**
 * @typedef {{ red: number; green: number; white: number; blue: number; fan: number }} NetleaChannels
 * @typedef {{ name: string; red: number; green: number; white: number; blue: number; fan: number }} NetleaSavedPreset
 * @typedef {{ lengthCm: number; widthCm: number; heightCm: number; lampCount: number }} NetleaTankSize
 * @typedef {{ targetMac: string; namePrefix: string; fadeSeconds: number; tempOnMinutes: number; tempOffMinutes: number; tankSize: NetleaTankSize; defaultChannels: NetleaChannels; savedCustomPresets: NetleaSavedPreset[] }} NetleaConfig
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
 * Convert byte integers into an uppercase hex string.
 * @param {number[]} bytes
 * @returns {string}
 */
function bytesToHex(bytes) {
  return bytes.map(b => (Number(b) & 0xff).toString(16).padStart(2, '0').toUpperCase()).join('');
}

/**
 * Build one 0x5A Netlea control frame as uppercase hex.
 * Byte 4/5 default to 0x00,0x00 and byte 5 is `travelModel` (0|1) for 0x12 schedule writes.
 * @param {number} deviceType
 * @param {number} command
 * @param {number[]} [payload]
 * @param {number} [optByte4]
 * @param {number} [optByte5]
 * @returns {string}
 */
export function buildAppFrame(deviceType, command, payload = [], optByte4 = 0, optByte5 = 0) {
  const frame = [
    0x5a,
    0,
    Number(deviceType) & 0xff,
    Number(command) & 0xff,
    Number(optByte4) & 0xff,
    Number(optByte5) & 0xff,
    ...payload.map(b => Number(b) & 0xff),
  ];
  frame[1] = frame.length + 1;
  frame.push(crc(frame));
  return bytesToHex(frame);
}

/**
 * Build the legacy 0x13 state query frame (`5A070113000075`).
 * @returns {string}
 */
export function buildQueryStateFrame() {
  return buildAppFrame(0x01, 0x13, []);
}

/**
 * Build the 0x15 status query frame (`5A070115000077`).
 * @returns {string}
 */
export function buildQueryStatusFrame() {
  return buildAppFrame(0x01, 0x15, []);
}

/**
 * Build the 0x1B temp duration & default spectrum query frame (`5A07011B00007D`).
 * @returns {string}
 */
export function buildQueryTempConfigFrame() {
  return buildAppFrame(0x01, 0x1b, []);
}

/**
 * Build the 0x25 stored schedule query frame (`5A0801250000078E`).
 * @returns {string}
 */
export function buildQueryScheduleFrame() {
  return buildAppFrame(0x01, 0x25, [0x07]);
}

/**
 * Build the 0x04 RTC clock sync frame (`5A1001040000...`, 16 bytes).
 * Matches official `setTime2dev`: `[groupId, devId, tzByte, yy, mm, dd, hh, mi, ss]`.
 * @param {Date | number | string} [dateInput]
 * @param {{ groupId?: number; devId?: number; tzHours?: number }} [opts]
 * @returns {string}
 */
export function buildClockSyncFrame(dateInput, opts = {}) {
  let d = dateInput instanceof Date ? dateInput : new Date(dateInput ?? Date.now());
  if (Number.isNaN(d.getTime())) d = new Date();
  const groupId = clampInt(opts.groupId, 0, 255) ?? 0;
  const devId = clampInt(opts.devId, 1, 255) ?? 1;
  let tzHours = opts.tzHours !== undefined
    ? (clampInt(opts.tzHours, -12, 14) ?? 8)
    : Math.round(-d.getTimezoneOffset() / 60);
  if (tzHours > 12) tzHours -= 24;
  else if (tzHours < -12) tzHours += 24;
  const tzByte = tzHours < 0 ? Math.abs(tzHours) + 128 : tzHours;

  return buildAppFrame(0x01, 0x04, [
    groupId,
    devId,
    tzByte & 0xff,
    Math.max(0, Math.min(255, d.getFullYear() - 2000)),
    d.getMonth() + 1,
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
  ]);
}

/**
 * Build the 0x10 temporary / manual / resume control frame (23 bytes = `5A1701100000...`).
 * Hardware 5-byte PWM order on SG-X-PRO is `[R, W, G, B, F]`.
 * @param {{
 *   on?: boolean;
 *   permanent?: boolean;
 *   pwm?: number[];
 *   red?: number;
 *   green?: number;
 *   white?: number;
 *   blue?: number;
 *   fan?: number;
 *   modeCode?: number;
 *   gear?: number;
 *   restoreSeconds?: number;
 *   modelName?: string;
 * }} [opts]
 * @returns {string}
 */
export function buildControlFrame(opts = {}) {
  const on = opts.on !== false;
  const permanent = Boolean(opts.permanent);
  const restoreSec = clampInt(opts.restoreSeconds, 0, 65535) ?? (permanent ? 900 : 1200);
  const profile = resolveXproProfile(opts.modelName || DEFAULT_XPRO_MODEL);

  let pwm = [0, 0, 0, 0, 0];
  let modeCode = clampInt(opts.modeCode, 0, 255) ?? 0;
  let gear = clampInt(opts.gear, 0, 65535) ?? 0;

  if (on) {
    if (Array.isArray(opts.pwm) && opts.pwm.length >= 4) {
      pwm = [
        clampInt(opts.pwm[0], 0, 255) ?? 0,
        clampInt(opts.pwm[1], 0, 255) ?? 0,
        clampInt(opts.pwm[2], 0, 255) ?? 0,
        clampInt(opts.pwm[3], 0, 255) ?? 0,
        clampInt(opts.pwm[4], 0, 10) ?? 0,
      ];
    } else if (
      opts.modeCode !== undefined
      && clampInt(opts.modeCode, 0, 11) !== undefined
      && opts.red === undefined
      && opts.green === undefined
      && opts.white === undefined
      && opts.blue === undefined
    ) {
      const encoded = encodeSceneGearPwm(
        profile,
        Number(opts.modeCode),
        opts.gear !== undefined ? Number(opts.gear) : 8,
        opts.fan !== undefined ? Number(opts.fan) : 0,
      );
      pwm = encoded.pwm;
      modeCode = encoded.modeCode;
      gear = encoded.gear;
    } else {
      const encoded = encodeCustomChannelsPwm(profile, {
        red: opts.red ?? DEFAULT_CHANNELS.red,
        green: opts.green ?? DEFAULT_CHANNELS.green,
        white: opts.white ?? DEFAULT_CHANNELS.white,
        blue: opts.blue ?? DEFAULT_CHANNELS.blue,
        fan: opts.fan ?? DEFAULT_CHANNELS.fan,
      });
      pwm = encoded.pwm;
      modeCode = 12;
      gear = 0;
    }
  }

  return buildAppFrame(0x01, 0x10, [
    on ? 1 : 0,
    permanent ? 1 : 0,
    0,
    0,
    pwm[0],
    pwm[1],
    pwm[2],
    pwm[3],
    pwm[4],
    restoreSec & 0xff,
    (restoreSec >> 8) & 0xff,
    modeCode & 0xff,
    gear & 0xff,
    (gear >> 8) & 0xff,
    0,
    0,
  ]);
}

/**
 * Build the 0x10 immediate schedule resume frame (`restoreSec = 1`, matching `mainReturn`).
 * @param {number | boolean} [lampStateHint]
 * @param {number} [restoreSeconds]
 * @returns {string}
 */
export function buildResumeScheduleFrame(lampStateHint = 1, restoreSeconds = 1) {
  return buildControlFrame({
    on: Boolean(lampStateHint),
    permanent: false,
    pwm: [0, 0, 0, 0, 0],
    restoreSeconds: clampInt(restoreSeconds, 0, 65535) ?? 1,
    modeCode: 0,
    gear: 0,
  });
}

/**
 * Build the 0x1A temp duration (minutes) & default spectrum frame (19 bytes).
 * Matches `setLinShiOnOffTimeAndDefPwm`: `[onMinLE(2), offMinLE(2), R, W, G, B, F, modeCode, gearLE(2)]`.
 * @param {{
 *   on?: boolean;
 *   onMinutes?: number;
 *   offMinutes?: number;
 *   pwm?: number[];
 *   red?: number;
 *   green?: number;
 *   white?: number;
 *   blue?: number;
 *   fan?: number;
 *   modeCode?: number;
 *   gear?: number;
 *   modelName?: string;
 * }} [opts]
 * @returns {string}
 */
export function buildTempConfigFrame(opts = {}) {
  const on = opts.on !== false;
  const onMin = clampInt(opts.onMinutes, 1, 300) ?? DEFAULT_CONFIG.tempOnMinutes;
  const offMin = clampInt(opts.offMinutes, 1, 300) ?? DEFAULT_CONFIG.tempOffMinutes;
  const profile = resolveXproProfile(opts.modelName || DEFAULT_XPRO_MODEL);

  let pwm = [0, 0, 0, 0, 0];
  let modeCode = clampInt(opts.modeCode, 0, 255) ?? 0;
  let gear = clampInt(opts.gear, 0, 65535) ?? 0;

  if (on) {
    if (Array.isArray(opts.pwm) && opts.pwm.length >= 4) {
      pwm = [
        clampInt(opts.pwm[0], 0, 255) ?? 0,
        clampInt(opts.pwm[1], 0, 255) ?? 0,
        clampInt(opts.pwm[2], 0, 255) ?? 0,
        clampInt(opts.pwm[3], 0, 255) ?? 0,
        clampInt(opts.pwm[4], 0, 10) ?? 0,
      ];
    } else if (
      opts.modeCode !== undefined
      && clampInt(opts.modeCode, 0, 11) !== undefined
      && opts.red === undefined
      && opts.green === undefined
      && opts.white === undefined
      && opts.blue === undefined
    ) {
      const encoded = encodeSceneGearPwm(
        profile,
        Number(opts.modeCode),
        opts.gear !== undefined ? Number(opts.gear) : 8,
        opts.fan !== undefined ? Number(opts.fan) : 0,
      );
      pwm = encoded.pwm;
      modeCode = encoded.modeCode;
      gear = encoded.gear;
    } else {
      const encoded = encodeCustomChannelsPwm(profile, {
        red: opts.red ?? DEFAULT_CHANNELS.red,
        green: opts.green ?? DEFAULT_CHANNELS.green,
        white: opts.white ?? DEFAULT_CHANNELS.white,
        blue: opts.blue ?? DEFAULT_CHANNELS.blue,
        fan: opts.fan ?? DEFAULT_CHANNELS.fan,
      });
      pwm = encoded.pwm;
      modeCode = 12;
      gear = 0;
    }
  }

  return buildAppFrame(0x01, 0x1a, [
    onMin & 0xff,
    (onMin >> 8) & 0xff,
    offMin & 0xff,
    (offMin >> 8) & 0xff,
    pwm[0],
    pwm[1],
    pwm[2],
    pwm[3],
    pwm[4],
    modeCode & 0xff,
    gear & 0xff,
    (gear >> 8) & 0xff,
  ]);
}

/**
 * Legacy helper kept exported for API continuity; builds a 0x1A temp config frame with `[R, W, G, B, F]`.
 * @param {boolean} on
 * @param {Record<string, unknown>} [opts]
 * @returns {string}
 */
export function buildTempLightFrame(on, opts = {}) {
  return buildTempConfigFrame({
    ...opts,
    on,
    onMinutes: clampInt(opts.onMinutes ?? opts.durationMinutes, 1, 300) ?? DEFAULT_CONFIG.tempOnMinutes,
    offMinutes: clampInt(opts.offMinutes ?? opts.durationMinutes, 1, 300) ?? DEFAULT_CONFIG.tempOffMinutes,
  });
}

/**
 * Decode a 19-byte 0x1A temp duration & default spectrum frame emitted by 0x1B query.
 * @param {unknown} hex
 * @param {string} [modelName]
 */
export function decodeTempConfigFrame(hex, modelName = DEFAULT_XPRO_MODEL) {
  const bytes = hexBytes(hex);
  if (bytes.length < 19 || bytes[0] !== 0x5a || bytes[2] !== 0x01 || bytes[3] !== 0x1a) {
    return null;
  }
  const declaredLen = bytes[1];
  const frameBytes = declaredLen >= 19 && declaredLen <= bytes.length ? bytes.slice(0, declaredLen) : bytes;
  if (crc(frameBytes.slice(0, -1)) !== frameBytes[frameBytes.length - 1]) {
    return null;
  }
  const p = frameBytes.slice(6, -1);
  if (p.length < 12) return null;
  const profile = resolveXproProfile(modelName);
  const decoded = decodeHardwarePwm(profile, p.slice(4, 9));
  return {
    rawHex: bytesToHex(frameBytes),
    onMinutes: p[0] | (p[1] << 8),
    offMinutes: p[2] | (p[3] << 8),
    pwm: decoded.pwm,
    channels: decoded.channels,
    powerWatts: decoded.powerWatts,
    modeCode: p[9],
    gear: p[10] | (p[11] << 8),
    matchedScene: decoded.matchedScene,
  };
}

/**
 * Build a 152-byte (`0x98`) 0x12 main schedule write frame with up to 10 trips and sunrise/sunset minutes.
 * @param {{ travelModel?: number; sunriseMinutes?: number; sunsetMinutes?: number; trips?: unknown[] }} schedule
 * @param {string} [modelName]
 * @returns {string}
 */
export function buildMainScheduleFrame(schedule, modelName = DEFAULT_XPRO_MODEL) {
  const profile = resolveXproProfile(modelName);
  const travelModel = clampInt(schedule?.travelModel, 0, 1) ?? 0;
  const sunriseMinutes = clampInt(schedule?.sunriseMinutes, 0, 300) ?? 0;
  const sunsetMinutes = clampInt(schedule?.sunsetMinutes, 0, 300) ?? 0;
  const rawTrips = Array.isArray(schedule?.trips) ? schedule.trips : [];
  if (rawTrips.length > 10) {
    throw new Error('定时行程最多支持 10 个时段');
  }

  const normalized = rawTrips.map(item =>
    normalizeTripInput(profile, item && typeof item === 'object' ? /** @type {Record<string, unknown>} */ (item) : {}),
  );
  const validation = validateAndAnnotateTrips(normalized, sunriseMinutes, sunsetMinutes);
  if (!validation.valid) {
    throw new Error(validation.error || '定时行程校验失败');
  }

  const hasEnabled = normalized.some(t => t.enable === 1);
  const sunEnable = hasEnabled && (sunriseMinutes > 0 || sunsetMinutes > 0) ? 1 : 0;

  /** @type {number[]} */
  const payload = [
    sunEnable,
    sunriseMinutes & 0xff,
    (sunriseMinutes >> 8) & 0xff,
    sunsetMinutes & 0xff,
    (sunsetMinutes >> 8) & 0xff,
  ];

  for (let i = 0; i < 10; i += 1) {
    if (i < normalized.length) {
      const t = normalized[i];
      let dayMask = 0;
      for (let d = 0; d < 7; d += 1) {
        if (t.dayList[d]) dayMask |= (1 << d);
      }
      payload.push(
        t.enable ? 1 : 0,
        dayMask & 0xff,
        t.startH & 0xff,
        t.startM & 0xff,
        t.endH & 0xff,
        t.endM & 0xff,
        t.pwm[0] & 0xff,
        t.pwm[1] & 0xff,
        t.pwm[2] & 0xff,
        t.pwm[3] & 0xff,
        t.pwm[4] & 0xff,
        t.modeCode & 0xff,
        t.gear & 0xff,
        (t.gear >> 8) & 0xff,
      );
    } else {
      for (let z = 0; z < 14; z += 1) payload.push(0);
    }
  }

  return buildAppFrame(0x01, 0x12, payload, 0x00, travelModel);
}

/**
 * Decode a 152-byte 0x12 main schedule frame emitted by 0x25 query.
 * @param {unknown} hex
 * @param {string} [modelName]
 * @returns {{ rawHex: string; travelModel: number; sunEnable: number; sunriseMinutes: number; sunsetMinutes: number; trips: import('./xpro-profiles.mjs').XproTrip[] } | null}
 */
export function decodeMainScheduleFrame(hex, modelName = DEFAULT_XPRO_MODEL) {
  const bytes = hexBytes(hex);
  if (bytes.length < 152 || bytes[0] !== 0x5a || bytes[2] !== 0x01 || bytes[3] !== 0x12) {
    return null;
  }
  const declaredLen = bytes[1];
  const frameBytes = declaredLen >= 152 && declaredLen <= bytes.length ? bytes.slice(0, declaredLen) : bytes;
  if (crc(frameBytes.slice(0, -1)) !== frameBytes[frameBytes.length - 1]) {
    return null;
  }

  const profile = resolveXproProfile(modelName);
  const travelModel = (frameBytes[4] | frameBytes[5]) & 0xff;
  const sunEnable = frameBytes[6];
  const sunriseMinutes = frameBytes[7] | (frameBytes[8] << 8);
  const sunsetMinutes = frameBytes[9] | (frameBytes[10] << 8);

  const rawTrips = [];
  for (let i = 0; i < 10; i += 1) {
    const off = 11 + i * 14;
    if (off + 14 > frameBytes.length - 1) break;
    const slot = frameBytes.slice(off, off + 14);
    if (slot.every(b => b === 0)) continue;

    const enable = slot[0] ? 1 : 0;
    const dayMask = slot[1];
    const dayList = Array.from({ length: 7 }, (_, d) => ((dayMask >> d) & 1));
    const startH = slot[2];
    const startM = slot[3];
    const endH = slot[4];
    const endM = slot[5];
    const pwm = slot.slice(6, 11);
    const modeCode = slot[11];
    const gear = slot[12] | (slot[13] << 8);

    const decoded = decodeHardwarePwm(profile, pwm);
    let sceneName = '自定义';
    let seriesName = '自定义';
    if (modeCode !== 12) {
      const sc = profile.scenes.find(s => s.modeCode === modeCode);
      if (sc) {
        sceneName = sc.name;
        seriesName = sc.seriesName;
      }
    }

    rawTrips.push({
      enable,
      dayList,
      startH,
      startM,
      endH,
      endM,
      modeCode,
      gear: modeCode === 12 ? 0 : gear,
      red: decoded.channels.red,
      green: decoded.channels.green,
      white: decoded.channels.white,
      blue: decoded.channels.blue,
      fan: decoded.channels.fan,
      pwm: decoded.pwmList,
      powerWatts: decoded.powerWatts,
      name: sceneName,
      seriesName,
    });
  }

  const annotated = validateAndAnnotateTrips(rawTrips, sunriseMinutes, sunsetMinutes);
  return {
    rawHex: bytesToHex(frameBytes),
    travelModel,
    sunEnable,
    sunriseMinutes,
    sunsetMinutes,
    trips: annotated.valid ? annotated.trips : rawTrips,
  };
}

/**
 * Decode a 38-byte 0x14 lamp state frame emitted on GATT 0xFF01.
 * Hardware 5-byte PWM order on SG-X-PRO is `[R, W, G, B, F]`.
 * @param {unknown} hex
 * @param {string} [modelName]
 */
export function decodeLampsStateFrame(hex, modelName = DEFAULT_XPRO_MODEL) {
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

  const pwmArr = [p[6], p[7], p[8], p[9], p[10]];
  const profile = resolveXproProfile(modelName);
  const decoded = decodeHardwarePwm(profile, pwmArr);

  const master = {
    stateType: p[0],
    startH: p[1],
    startM: p[2],
    lampState: p[3],
    lampMode: p[4],
    pattern: p[5],
    red: p[6],
    white: p[7],
    green: p[8],
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

  const haveTravel = (master.pattern & 0x02) !== 0;
  const scheduleRunning = master.lampMode === 0 && master.pattern === 2;
  /** @type {'schedule' | 'manual' | 'temp_on' | 'temp_off' | 'off'} */
  let runMode = 'off';
  let runModeLabel = '已关闭';
  if (master.lampMode === 1) {
    runMode = master.lampState === 1 ? 'manual' : 'off';
    runModeLabel = master.lampState === 1 ? '手动恒亮' : '手动关闭';
  } else if (scheduleRunning) {
    runMode = 'schedule';
    runModeLabel = '自动行程中';
  } else if (master.lampState === 1) {
    runMode = 'temp_on';
    runModeLabel = haveTravel ? '临时开灯' : '固定光效';
  } else {
    runMode = haveTravel ? 'temp_off' : 'off';
    runModeLabel = haveTravel ? '临时关灯' : '已关闭';
  }

  return {
    rawHex: bytesToHex(frameBytes),
    on: master.lampState === 1,
    haveTravel,
    scheduleRunning,
    runMode,
    runModeLabel,
    pwm: decoded.pwm,
    channels: decoded.channels,
    powerWatts: decoded.powerWatts,
    maxWatts: decoded.maxWatts,
    matchedScene: decoded.matchedScene,
    master,
    spot,
    atmosphere,
  };
}

/**
 * Decode Netlea BLE ManufacturerData (`0x0000`) into RTC clock, deviceType, and MAC.
 * @param {Record<string, unknown> | null | undefined} mfgMap
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
 * Sanitize and normalize stored channel presets (0..100% slider units).
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
 * Sanitize tank dimensions for official preset sizing.
 * @param {unknown} raw
 * @param {NetleaTankSize} [fallback]
 * @returns {NetleaTankSize}
 */
function sanitizeTankSize(raw, fallback = DEFAULT_TANK_SIZE) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : {};
  return {
    lengthCm: clampInt(obj.lengthCm ?? obj.l, 10, 300) ?? fallback.lengthCm,
    widthCm: clampInt(obj.widthCm ?? obj.w, 10, 200) ?? fallback.widthCm,
    heightCm: clampInt(obj.heightCm ?? obj.h, 10, 200) ?? fallback.heightCm,
    lampCount: clampInt(obj.lampCount, 1, 8) ?? fallback.lampCount,
  };
}

/**
 * Sanitize up to 6 saved custom channel presets.
 * @param {unknown} raw
 * @returns {NetleaSavedPreset[]}
 */
function sanitizeSavedPresets(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < Math.min(6, raw.length); i += 1) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const ch = sanitizeChannels(item, DEFAULT_CHANNELS);
    const name = String(/** @type {Record<string, unknown>} */ (item).name ?? '').trim().slice(0, 24)
      || `自定义槽 ${i + 1}`;
    out.push({ name, ...ch });
  }
  return out;
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
 * Resolve spectrum arguments either as an official scene gear (0..11) or custom RGBWF (0..100%).
 * @param {Record<string, unknown>} safeArgs
 * @param {ReturnType<typeof resolveXproProfile>} profile
 * @param {NetleaConfig} config
 * @param {boolean} [allowBrightnessScaling]
 */
function resolveSpectrumSpec(safeArgs, profile, config, allowBrightnessScaling = true) {
  const hasExplicitChannel = (
    safeArgs.red ?? safeArgs.r ?? safeArgs.green ?? safeArgs.g
    ?? safeArgs.white ?? safeArgs.w ?? safeArgs.blue ?? safeArgs.b
    ?? safeArgs.fan ?? safeArgs.f
  ) !== undefined;
  const reqModeCode = clampInt(safeArgs.modeCode, 0, 11);

  if (reqModeCode !== undefined && !hasExplicitChannel && (!allowBrightnessScaling || safeArgs.brightness === undefined)) {
    const encoded = encodeSceneGearPwm(
      profile,
      reqModeCode,
      clampInt(safeArgs.gear, 1, 10) ?? 8,
      clampInt(safeArgs.fan ?? safeArgs.f, 0, 5) ?? 0,
    );
    return {
      isScene: true,
      modeCode: encoded.modeCode,
      gear: encoded.gear,
      seriesName: encoded.seriesName,
      sceneName: encoded.sceneName,
      pwm: encoded.pwm,
      channels: encoded.channels,
      powerWatts: encoded.powerWatts,
      powerClamped: false,
    };
  }

  const baseCh = allowBrightnessScaling
    ? resolveChannelsForOn(safeArgs, config.defaultChannels)
    : sanitizeChannels(safeArgs, config.defaultChannels);
  const encoded = encodeCustomChannelsPwm(profile, baseCh);
  return {
    isScene: false,
    modeCode: 12,
    gear: 0,
    seriesName: '自定义',
    sceneName: '自定义',
    pwm: encoded.pwm,
    channels: encoded.channels,
    powerWatts: encoded.powerWatts,
    powerClamped: encoded.powerClamped,
  };
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
  const tempOnMinutes = clampInt(raw.tempOnMinutes, 1, 300) ?? DEFAULT_CONFIG.tempOnMinutes;
  const tempOffMinutes = clampInt(raw.tempOffMinutes, 1, 300) ?? DEFAULT_CONFIG.tempOffMinutes;
  const tankSize = sanitizeTankSize(raw.tankSize, DEFAULT_TANK_SIZE);
  const defaultChannels = sanitizeChannels(raw.defaultChannels, DEFAULT_CHANNELS);
  const savedCustomPresets = sanitizeSavedPresets(raw.savedCustomPresets);
  return {
    targetMac: normMac || '',
    namePrefix,
    fadeSeconds,
    tempOnMinutes,
    tempOffMinutes,
    tankSize,
    defaultChannels,
    savedCustomPresets,
  };
}

/**
 * Format channel summary text.
 * @param {NetleaChannels} ch
 * @returns {string}
 */
function formatChannels(ch) {
  return `R${ch.red}% G${ch.green}% W${ch.white}% B${ch.blue}%`;
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
    parts.push(`${state.runModeLabel}`);
    if (state.on) {
      const sceneTag = state.matchedScene
        ? `${state.matchedScene.seriesName}·${state.matchedScene.name}${state.matchedScene.gear}档`
        : '自定义';
      parts.push(`${sceneTag} ${state.powerWatts}W (${formatChannels(state.channels)})`);
    }
  }
  const adv = device?.advertisement && typeof device.advertisement === 'object'
    ? /** @type {Record<string, unknown>} */ (device.advertisement)
    : null;
  if (adv && typeof adv.rtc === 'string' && adv.rtc) {
    parts.push(`时钟 ${adv.rtc}`);
  }
  return parts.join('｜');
}

/**
 * Find the currently active trip in `schedule.trips` for a given Date.
 * @param {ReturnType<typeof decodeMainScheduleFrame> | null} schedule
 * @param {Date} [now]
 */
function findActiveTrip(schedule, now = new Date()) {
  if (!schedule || !Array.isArray(schedule.trips) || !schedule.trips.length) return null;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const jsDay = now.getDay(); // 0=Sun..6=Sat
  const todayIdx = jsDay === 0 ? 6 : jsDay - 1; // 0=Mon..6=Sun
  const prevIdx = (todayIdx + 6) % 7;

  for (const t of schedule.trips) {
    if (!t || !t.enable) continue;
    const days = Array.isArray(t.dayList) ? t.dayList : [1, 1, 1, 1, 1, 1, 1];
    const start = (Number(t.startH) || 0) * 60 + (Number(t.startM) || 0);
    const rawEnd = (Number(t.endH) || 0) * 60 + (Number(t.endM) || 0);
    const end = rawEnd === 0 && start > 0 ? 1440 : rawEnd;
    if (start === end) continue;
    if (start < end) {
      if (days[todayIdx] && nowMin >= start && nowMin < end) return t;
    } else {
      if ((days[todayIdx] && nowMin >= start) || (days[prevIdx] && nowMin < end)) return t;
    }
  }
  return null;
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
 * Persist sanitized last-known device, state, tempConfig, and schedule snapshot atomically with 0o600.
 * @param {string} statePath
 * @param {{
 *   deviceView?: Record<string, unknown> | null;
 *   state?: ReturnType<typeof decodeLampsStateFrame> | null;
 *   tempConfig?: ReturnType<typeof decodeTempConfigFrame> | null;
 *   schedule?: ReturnType<typeof decodeMainScheduleFrame> | null;
 *   clearScheduleIfNoTravel?: boolean;
 *   nowMs: number;
 * }} patch
 */
async function saveLastState(statePath, patch) {
  await withFileLock(statePath, () => {
    const prev = readJsonSafe(statePath, {});
    const prevObj = prev && typeof prev === 'object' && !Array.isArray(prev)
      ? /** @type {Record<string, unknown>} */ (prev)
      : {};
    const deviceView = patch.deviceView ?? null;
    const lastAddress = (deviceView && typeof deviceView.address === 'string' && deviceView.address)
      || (typeof prevObj.lastAddress === 'string' ? prevObj.lastAddress : '');

    let nextSchedule = patch.schedule !== undefined ? patch.schedule : (prevObj.schedule ?? null);
    if (patch.clearScheduleIfNoTravel && patch.state && patch.state.haveTravel === false && !patch.schedule) {
      nextSchedule = {
        rawHex: '',
        travelModel: 0,
        sunEnable: 0,
        sunriseMinutes: 0,
        sunsetMinutes: 0,
        trips: [],
      };
    }

    writeJsonAtomic(
      statePath,
      {
        updatedAt: patch.nowMs,
        lastAddress,
        device: deviceView ?? prevObj.device ?? null,
        state: patch.state !== undefined && patch.state !== null ? patch.state : (prevObj.state ?? null),
        tempConfig: patch.tempConfig !== undefined && patch.tempConfig !== null
          ? patch.tempConfig
          : (prevObj.tempConfig ?? null),
        schedule: nextSchedule,
      },
      { mode: 0o600 },
    );
  });
}

/**
 * Read cached last-state snapshot safely from disk.
 * @param {string} statePath
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
  const tempConfig = cached?.tempConfig && typeof cached.tempConfig === 'object'
    ? /** @type {ReturnType<typeof decodeTempConfigFrame>} */ (cached.tempConfig)
    : null;
  const schedule = cached?.schedule && typeof cached.schedule === 'object'
    ? /** @type {ReturnType<typeof decodeMainScheduleFrame>} */ (cached.schedule)
    : null;
  const updatedAt = typeof cached?.updatedAt === 'number' ? cached.updatedAt : null;
  const lastAddress = typeof cached?.lastAddress === 'string' && cached.lastAddress
    ? cached.lastAddress
    : null;
  return { updatedAt, lastAddress, device, state, tempConfig, schedule };
}

/**
 * Run a BLE helper invocation under `<pluginDataDir>/ble.lock` with one retry on transient CONNECT_FAILED.
 * @param {string} lockPath
 * @param {(cmdArgs: string[], timeoutMs?: number, signal?: AbortSignal) => Promise<Record<string, unknown>>} bleRunner
 * @param {string[]} cmdArgs
 * @param {number} timeoutMs
 * @param {AbortSignal | undefined} signal
 * @param {boolean} [allowRetry]
 * @returns {Promise<Record<string, unknown>>}
 */
async function invokeBleLocked(lockPath, bleRunner, cmdArgs, timeoutMs, signal, allowRetry = true) {
  return await withFileLock(lockPath, async () => {
    let raw = await bleRunner(cmdArgs, timeoutMs, signal);
    if (allowRetry && raw && raw.ok === false && raw.code === 'CONNECT_FAILED') {
      await new Promise(resolvePause => setTimeout(resolvePause, 250));
      raw = await bleRunner(cmdArgs, timeoutMs, signal);
    }
    return raw;
  });
}

/**
 * Execute one BLE `command` batch via helper, decode replies (`0x14`, `0x1A`, `0x12`), and update cached state.
 * @param {{
 *   bleRunner: (cmdArgs: string[], timeoutMs?: number, signal?: AbortSignal) => Promise<Record<string, unknown>>;
 *   lockPath: string;
 *   txFrames: string[];
 *   effectiveTargetMac: string;
 *   preferMac: string;
 *   modelHint: string;
 *   namePrefix: string;
 *   safeArgs: Record<string, unknown>;
 *   statePath: string;
 *   clearScheduleIfNoTravel?: boolean;
 *   fallbackSchedule?: ReturnType<typeof decodeMainScheduleFrame> | null;
 *   nowFn: () => number;
 *   signal?: AbortSignal;
 * }} opts
 */
async function runBleCommandBatch(opts) {
  const {
    bleRunner,
    lockPath,
    txFrames,
    effectiveTargetMac,
    preferMac,
    modelHint,
    namePrefix,
    safeArgs,
    statePath,
    clearScheduleIfNoTravel = false,
    fallbackSchedule = undefined,
    nowFn,
    signal,
  } = opts;

  const scanTimeoutSec = clampInt(safeArgs.scanTimeoutSec, 2, 15) ?? 6;
  const connectTimeoutSec = clampInt(safeArgs.connectTimeoutSec, 3, 20) ?? 10;
  const replyTimeoutSec = clampInt(safeArgs.replyTimeoutSec, 1, 10) ?? 3;
  const execTimeoutMs = (scanTimeoutSec + connectTimeoutSec + replyTimeoutSec + 8) * 1000;
  const txJoined = txFrames.join(',');

  let raw;
  try {
    raw = await invokeBleLocked(
      lockPath,
      bleRunner,
      [
        'command',
        '--tx',
        txJoined,
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
  const resolvedModel = deviceView?.name || modelHint || DEFAULT_XPRO_MODEL;
  const state = decodeLampsStateFrame(raw.stateHex, resolvedModel);
  const tempConfig = decodeTempConfigFrame(raw.tempConfigHex, resolvedModel);
  const decodedSchedule = decodeMainScheduleFrame(raw.scheduleHex, resolvedModel);
  const scheduleToSave = decodedSchedule !== null ? decodedSchedule : fallbackSchedule;

  await saveLastState(statePath, {
    deviceView,
    state,
    tempConfig,
    schedule: scheduleToSave,
    clearScheduleIfNoTravel,
    nowMs: nowFn(),
  });

  return {
    ok: true,
    deviceView,
    state,
    tempConfig,
    schedule: decodedSchedule ?? fallbackSchedule ?? null,
    replies: Array.isArray(raw.replies) ? raw.replies : [],
  };
}

/**
 * Format schedule summary text for dashboard KPI and notification messages.
 * @param {ReturnType<typeof decodeMainScheduleFrame> | null} schedule
 * @returns {string}
 */
function formatScheduleSummary(schedule) {
  if (!schedule || !Array.isArray(schedule.trips) || schedule.trips.length === 0) {
    return '未设置行程';
  }
  const enabledCount = schedule.trips.filter(t => t.enable).length;
  const sunTag = (schedule.sunriseMinutes > 0 || schedule.sunsetMinutes > 0)
    ? ` · 日出${schedule.sunriseMinutes}m/日落${schedule.sunsetMinutes}m`
    : '';
  return `${enabledCount}/${schedule.trips.length} 段启用${sunTag}`;
}

/**
 * Build the unified `dashboard` response object from disk snapshot + config.
 * @param {string} statePath
 * @param {NetleaConfig} config
 * @param {boolean} refreshed
 * @param {number} nowMs
 */
function buildDashboardResponse(statePath, config, refreshed, nowMs) {
  const snap = readCachedSnapshot(statePath);
  const dev = snap.device;
  const st = snap.state;
  const profile = resolveXproProfile(dev?.name || DEFAULT_XPRO_MODEL);
  const adv = dev?.advertisement && typeof dev.advertisement === 'object'
    ? /** @type {Record<string, unknown>} */ (dev.advertisement)
    : null;
  const rtcText = typeof adv?.rtc === 'string' && adv.rtc ? adv.rtc : '';
  const shortRtc = rtcText.length >= 19 ? rtcText.slice(11, 19) : (rtcText || '--');
  const activeTrip = findActiveTrip(snap.schedule, new Date(nowMs));

  const summaryText = st
    ? (st.on ? `${st.runModeLabel} · ${st.powerWatts}W` : st.runModeLabel)
    : '待同步';
  const spectrumText = st
    ? `R${st.channels.red} G${st.channels.green} W${st.channels.white} B${st.channels.blue}%`
    : `预设 R${config.defaultChannels.red} G${config.defaultChannels.green} W${config.defaultChannels.white} B${config.defaultChannels.blue}%`;
  const schedSummary = formatScheduleSummary(snap.schedule);

  return {
    ok: true,
    notify: false,
    title: '尼特利鱼缸灯看板',
    message: st ? formatStatusMessage(dev, st) : '鱼缸灯尚未同步实时状态，可点击实时同步读取。',
    data: {
      状态: summaryText,
      模式: st?.runModeLabel ?? '未知',
      光谱: spectrumText,
      功率: st ? `${st.powerWatts}W / ${st.maxWatts}W` : `-- / ${profile.maxWatts}W`,
      行程: activeTrip ? `当前「${activeTrip.name}」` : schedSummary,
      信号: typeof dev?.rssi === 'number' ? `${dev.rssi} dBm` : '--',
      灯内时钟: shortRtc,
      设备: (typeof dev?.name === 'string' && dev.name) ? dev.name.slice(0, 22) : (config.targetMac || '自动发现'),
      渐变: `${config.fadeSeconds}s`,
      refreshed,
      updatedAt: snap.updatedAt,
      lastAddress: snap.lastAddress,
      device: dev,
      state: st,
      tempConfig: snap.tempConfig,
      schedule: snap.schedule,
      activeTrip,
      config,
      catalog: buildCatalogSummary(profile),
    },
  };
}

/**
 * Execute one Netlea plugin action (`dashboard`, `status`, `scan`, `on`, `off`, `mode`, `resume`, `schedule`, `clock`, `config`).
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
  const bleLockPath = join(paths.pluginDataDir, 'ble.lock');

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
        tankSize: { ...current.tankSize },
        defaultChannels: { ...current.defaultChannels },
        savedCustomPresets: [...current.savedCustomPresets],
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
      if (Object.prototype.hasOwnProperty.call(safeArgs, 'tempOnMinutes')) {
        const m = clampInt(safeArgs.tempOnMinutes, 1, 300);
        if (m === undefined) {
          validationError = 'tempOnMinutes 必须为 1-300 之间的分钟整数';
          return current;
        }
        next.tempOnMinutes = m;
      }
      if (Object.prototype.hasOwnProperty.call(safeArgs, 'tempOffMinutes')) {
        const m = clampInt(safeArgs.tempOffMinutes, 1, 300);
        if (m === undefined) {
          validationError = 'tempOffMinutes 必须为 1-300 之间的分钟整数';
          return current;
        }
        next.tempOffMinutes = m;
      }
      if (safeArgs.tankSize && typeof safeArgs.tankSize === 'object' && !Array.isArray(safeArgs.tankSize)) {
        next.tankSize = sanitizeTankSize(safeArgs.tankSize, current.tankSize);
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
      if (Array.isArray(safeArgs.savedCustomPresets)) {
        next.savedCustomPresets = sanitizeSavedPresets(safeArgs.savedCustomPresets);
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
      message: `目标 MAC：${updated.targetMac || '自动发现（前缀 ' + updated.namePrefix + '）'}｜临时开/关：${updated.tempOnMinutes}m/${updated.tempOffMinutes}m｜默认通道 ${formatChannels(updated.defaultChannels)}`,
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
  const cachedBefore = readCachedSnapshot(paths.statePath);
  const modelHint = typeof cachedBefore.device?.name === 'string' && cachedBefore.device.name
    ? cachedBefore.device.name
    : (typeof safeArgs.model === 'string' ? safeArgs.model : DEFAULT_XPRO_MODEL);
  const profile = resolveXproProfile(modelHint);

  if (cleanAction === 'dashboard') {
    const wantRefresh = safeArgs.refresh === true;
    if (wantRefresh) {
      if (platform !== 'linux' && !hasInjectedRunner) {
        return disabledBleResult(platform);
      }
      const cmdRes = await runBleCommandBatch({
        bleRunner,
        lockPath: bleLockPath,
        txFrames: [buildQueryStatusFrame(), buildQueryTempConfigFrame(), buildQueryScheduleFrame()],
        effectiveTargetMac,
        preferMac: cachedBefore.lastAddress || '',
        modelHint,
        namePrefix: config.namePrefix,
        safeArgs,
        statePath: paths.statePath,
        clearScheduleIfNoTravel: true,
        nowFn,
        signal,
      });
      if (!cmdRes.ok) {
        return cmdRes.errorResult;
      }
    }
    return buildDashboardResponse(paths.statePath, config, wantRefresh, nowFn());
  }

  if (cleanAction === 'status' && safeArgs.live === false) {
    return {
      ok: true,
      notify: true,
      title: '尼特利鱼缸灯缓存状态',
      message: cachedBefore.state
        ? formatStatusMessage(cachedBefore.device, cachedBefore.state, '最近缓存')
        : '尚无鱼缸灯历史状态缓存，请执行一次实时 status 或 scan。',
      data: {
        live: false,
        updatedAt: cachedBefore.updatedAt,
        lastAddress: cachedBefore.lastAddress,
        device: cachedBefore.device,
        state: cachedBefore.state,
        tempConfig: cachedBefore.tempConfig,
        schedule: cachedBefore.schedule,
        config,
      },
    };
  }

  // Handle offline / dryRun schedule preset preview cleanly without requiring Linux BLE
  if (cleanAction === 'schedule') {
    const op = String(safeArgs.op || (Array.isArray(safeArgs.trips) ? 'set' : safeArgs.preset ? 'preset' : 'get')).trim();
    if (op === 'preset') {
      let computed;
      try {
        const tankOpts = {
          lengthCm: safeArgs.lengthCm ?? safeArgs.l ?? config.tankSize.lengthCm,
          widthCm: safeArgs.widthCm ?? safeArgs.w ?? config.tankSize.widthCm,
          heightCm: safeArgs.heightCm ?? safeArgs.h ?? config.tankSize.heightCm,
          lampCount: safeArgs.lampCount ?? config.tankSize.lampCount,
          startHour: safeArgs.startHour ?? 9,
          startMinute: safeArgs.startMinute ?? 0,
          sunriseMinutes: safeArgs.sunriseMinutes ?? 20,
          sunsetMinutes: safeArgs.sunsetMinutes ?? 20,
          dayList: normalizeDayList(safeArgs.dayList),
        };
        computed = buildPresetSchedule(String(safeArgs.preset ?? 'open_tank'), tankOpts, profile);
      } catch (err) {
        return {
          ok: false,
          notify: true,
          title: '养殖预设参数错误',
          message: errMsg(err),
        };
      }

      if (safeArgs.previewOnly === true) {
        return {
          ok: true,
          notify: false,
          title: `${computed.presetName}行程预览`,
          message: `${computed.presetName}（${computed.tankSize.lengthCm}×${computed.tankSize.widthCm}×${computed.tankSize.heightCm}cm，共 ${computed.trips.length} 段）`,
          data: {
            previewOnly: true,
            schedule: computed,
          },
        };
      }

      let schedTx;
      try {
        schedTx = buildMainScheduleFrame(computed, profile.key);
      } catch (err) {
        return {
          ok: false,
          notify: true,
          title: '预设行程编码失败',
          message: errMsg(err),
        };
      }
      const txFrames = [schedTx, buildResumeScheduleFrame(1, 1), buildQueryStatusFrame(), buildQueryScheduleFrame()];
      if (safeArgs.dryRun === true) {
        return {
          ok: true,
          notify: true,
          title: '尼特利指令预演 (dryRun)',
          message: `dryRun 模式：将写入「${computed.presetName}」(${computed.trips.length} 段) 并激活自动行程`,
          data: { dryRun: true, action: 'schedule:preset', txFrames, schedule: computed },
        };
      }
      if (platform !== 'linux' && !hasInjectedRunner) {
        return disabledBleResult(platform);
      }

      if (safeArgs.saveTankSize !== false) {
        await withFileLock(paths.configPath, () => {
          const cur = loadNormalizedConfig(paths.configPath);
          cur.tankSize = sanitizeTankSize(computed.tankSize, cur.tankSize);
          writeConfig(paths.configPath, cur);
        });
      }

      const cmdRes = await runBleCommandBatch({
        bleRunner,
        lockPath: bleLockPath,
        txFrames,
        effectiveTargetMac,
        preferMac: cachedBefore.lastAddress || '',
        modelHint: profile.key,
        namePrefix: config.namePrefix,
        safeArgs,
        statePath: paths.statePath,
        fallbackSchedule: {
          rawHex: schedTx,
          travelModel: 1,
          sunEnable: computed.sunriseMinutes > 0 || computed.sunsetMinutes > 0 ? 1 : 0,
          sunriseMinutes: computed.sunriseMinutes,
          sunsetMinutes: computed.sunsetMinutes,
          trips: computed.trips,
        },
        nowFn,
        signal,
      });
      if (!cmdRes.ok) return cmdRes.errorResult;

      return {
        ok: true,
        notify: true,
        title: `已下发「${computed.presetName}」`,
        message: `已写入 ${computed.trips.length} 段行程并启用自动运行（日出 ${computed.sunriseMinutes}m / 日落 ${computed.sunsetMinutes}m）`,
        data: {
          live: true,
          action: 'schedule:preset',
          tx: schedTx,
          txFrames,
          device: cmdRes.deviceView,
          state: cmdRes.state,
          schedule: cmdRes.schedule,
          replies: cmdRes.replies,
        },
      };
    }

    if (op === 'set') {
      const sunriseMinutes = clampInt(safeArgs.sunriseMinutes, 0, 300) ?? 20;
      const sunsetMinutes = clampInt(safeArgs.sunsetMinutes, 0, 300) ?? 20;
      const travelModel = clampInt(safeArgs.travelModel, 0, 1) ?? 0;
      const rawTrips = Array.isArray(safeArgs.trips) ? safeArgs.trips : [];
      if (rawTrips.length === 0) {
        return {
          ok: false,
          notify: true,
          title: '行程为空',
          message: '至少需要 1 个定时时段；若需清空灯内行程请使用 op=clear。',
        };
      }

      let schedTx;
      try {
        schedTx = buildMainScheduleFrame({ travelModel, sunriseMinutes, sunsetMinutes, trips: rawTrips }, profile.key);
      } catch (err) {
        return {
          ok: false,
          notify: true,
          title: '行程校验失败',
          message: errMsg(err),
        };
      }
      const decodedLocal = decodeMainScheduleFrame(schedTx, profile.key);
      const txFrames = [schedTx, buildResumeScheduleFrame(1, 1), buildQueryStatusFrame(), buildQueryScheduleFrame()];
      if (safeArgs.dryRun === true) {
        return {
          ok: true,
          notify: true,
          title: '尼特利行程预演 (dryRun)',
          message: `dryRun 模式：将写入 ${rawTrips.length} 段行程（日出 ${sunriseMinutes}m / 日落 ${sunsetMinutes}m）`,
          data: { dryRun: true, action: 'schedule:set', tx: schedTx, txFrames, schedule: decodedLocal },
        };
      }
      if (platform !== 'linux' && !hasInjectedRunner) {
        return disabledBleResult(platform);
      }

      const cmdRes = await runBleCommandBatch({
        bleRunner,
        lockPath: bleLockPath,
        txFrames,
        effectiveTargetMac,
        preferMac: cachedBefore.lastAddress || '',
        modelHint: profile.key,
        namePrefix: config.namePrefix,
        safeArgs,
        statePath: paths.statePath,
        fallbackSchedule: decodedLocal,
        nowFn,
        signal,
      });
      if (!cmdRes.ok) return cmdRes.errorResult;

      return {
        ok: true,
        notify: true,
        title: '定时行程已写入灯具',
        message: `已保存并激活 ${cmdRes.schedule?.trips?.length ?? rawTrips.length} 段定时行程（日出 ${sunriseMinutes}m / 日落 ${sunsetMinutes}m）`,
        data: {
          live: true,
          action: 'schedule:set',
          tx: schedTx,
          txFrames,
          device: cmdRes.deviceView,
          state: cmdRes.state,
          schedule: cmdRes.schedule,
          replies: cmdRes.replies,
        },
      };
    }

    if (op === 'clear') {
      const clearTx = buildMainScheduleFrame({
        travelModel: clampInt(safeArgs.travelModel, 0, 1) ?? 0,
        sunriseMinutes: clampInt(safeArgs.sunriseMinutes, 0, 300) ?? 0,
        sunsetMinutes: clampInt(safeArgs.sunsetMinutes, 0, 300) ?? 0,
        trips: [],
      }, profile.key);
      const emptySched = {
        rawHex: clearTx,
        travelModel: 0,
        sunEnable: 0,
        sunriseMinutes: 0,
        sunsetMinutes: 0,
        trips: [],
      };
      const txFrames = [clearTx, buildQueryStatusFrame()];
      if (safeArgs.dryRun === true) {
        return {
          ok: true,
          notify: true,
          title: '清空行程预演 (dryRun)',
          message: `dryRun 模式：将清空灯内全部定时行程`,
          data: { dryRun: true, action: 'schedule:clear', tx: clearTx, txFrames },
        };
      }
      if (platform !== 'linux' && !hasInjectedRunner) {
        return disabledBleResult(platform);
      }
      const cmdRes = await runBleCommandBatch({
        bleRunner,
        lockPath: bleLockPath,
        txFrames,
        effectiveTargetMac,
        preferMac: cachedBefore.lastAddress || '',
        modelHint: profile.key,
        namePrefix: config.namePrefix,
        safeArgs,
        statePath: paths.statePath,
        fallbackSchedule: emptySched,
        nowFn,
        signal,
      });
      if (!cmdRes.ok) return cmdRes.errorResult;

      return {
        ok: true,
        notify: true,
        title: '已清空灯内定时行程',
        message: '已清除鱼缸灯全部 24h 定时行程。',
        data: {
          live: true,
          action: 'schedule:clear',
          tx: clearTx,
          txFrames,
          device: cmdRes.deviceView,
          state: cmdRes.state,
          schedule: cmdRes.schedule,
          replies: cmdRes.replies,
        },
      };
    }

    // op === 'get'
    const getFrames = [buildQueryStatusFrame(), buildQueryScheduleFrame()];
    if (safeArgs.dryRun === true) {
      return {
        ok: true,
        notify: true,
        title: '读取行程预演 (dryRun)',
        message: `dryRun 模式：将发送状态+行程查询帧 ${getFrames.join(',')}`,
        data: { dryRun: true, action: 'schedule:get', txFrames: getFrames },
      };
    }
    if (platform !== 'linux' && !hasInjectedRunner) {
      return disabledBleResult(platform);
    }
    const cmdRes = await runBleCommandBatch({
      bleRunner,
      lockPath: bleLockPath,
      txFrames: getFrames,
      effectiveTargetMac,
      preferMac: cachedBefore.lastAddress || '',
      modelHint: profile.key,
      namePrefix: config.namePrefix,
      safeArgs,
      statePath: paths.statePath,
      clearScheduleIfNoTravel: true,
      nowFn,
      signal,
    });
    if (!cmdRes.ok) return cmdRes.errorResult;

    const loadedSchedule = cmdRes.schedule ?? {
      rawHex: '',
      travelModel: 0,
      sunEnable: 0,
      sunriseMinutes: 0,
      sunsetMinutes: 0,
      trips: [],
    };
    return {
      ok: true,
      notify: true,
      title: '已读取灯内定时行程',
      message: formatScheduleSummary(loadedSchedule),
      data: {
        live: true,
        action: 'schedule:get',
        txFrames: getFrames,
        device: cmdRes.deviceView,
        state: cmdRes.state,
        schedule: loadedSchedule,
        replies: cmdRes.replies,
      },
    };
  }

  // Build TX frames for status / on / off / mode / resume / clock
  /** @type {string[]} */
  let txFrames = [];
  /** @type {NetleaChannels | undefined} */
  let plannedChannels;
  /** @type {Record<string, unknown> | undefined} */
  let plannedMeta;
  let effectiveAction = cleanAction;

  if (cleanAction === 'status') {
    txFrames = safeArgs.minimal === true
      ? [buildQueryStateFrame()]
      : [buildQueryStatusFrame(), buildQueryTempConfigFrame(), buildQueryScheduleFrame()];
  } else if (cleanAction === 'on') {
    const hasExplicitChannel = (
      safeArgs.red ?? safeArgs.r ?? safeArgs.green ?? safeArgs.g
      ?? safeArgs.white ?? safeArgs.w ?? safeArgs.blue ?? safeArgs.b
      ?? safeArgs.fan ?? safeArgs.f ?? safeArgs.modeCode
    ) !== undefined;
    const reqBrightness = clampInt(safeArgs.brightness, 0, 100);
    if (reqBrightness === 0 && !hasExplicitChannel) {
      effectiveAction = 'off';
      const offMin = clampInt(safeArgs.durationMinutes ?? safeArgs.offMinutes, 1, 300) ?? config.tempOffMinutes;
      txFrames = [buildControlFrame({
        on: false,
        permanent: false,
        restoreSeconds: offMin * 60,
        modelName: profile.key,
      })];
    } else {
      const spec = resolveSpectrumSpec(safeArgs, profile, config, true);
      plannedChannels = spec.channels;
      const onMin = clampInt(safeArgs.durationMinutes ?? safeArgs.onMinutes, 1, 300) ?? config.tempOnMinutes;
      plannedMeta = {
        modeCode: spec.modeCode,
        gear: spec.gear,
        sceneName: spec.sceneName,
        seriesName: spec.seriesName,
        powerWatts: spec.powerWatts,
        powerClamped: spec.powerClamped,
        durationMinutes: onMin,
      };
      txFrames = [buildControlFrame({
        on: true,
        permanent: false,
        pwm: spec.pwm,
        modeCode: spec.modeCode,
        gear: spec.gear,
        restoreSeconds: onMin * 60,
        modelName: profile.key,
      })];
    }
  } else if (cleanAction === 'off') {
    const offMin = clampInt(safeArgs.durationMinutes ?? safeArgs.offMinutes, 1, 300) ?? config.tempOffMinutes;
    plannedMeta = { durationMinutes: offMin };
    txFrames = [buildControlFrame({
      on: false,
      permanent: false,
      restoreSeconds: offMin * 60,
      modelName: profile.key,
    })];
  } else if (cleanAction === 'mode') {
    const subMode = String(safeArgs.mode || 'manual').trim();
    if (subMode === 'temp-config') {
      effectiveAction = 'mode:temp-config';
      const onMin = clampInt(safeArgs.onMinutes ?? safeArgs.tempOnMinutes, 1, 300) ?? config.tempOnMinutes;
      const offMin = clampInt(safeArgs.offMinutes ?? safeArgs.tempOffMinutes, 1, 300) ?? config.tempOffMinutes;
      const spec = resolveSpectrumSpec(safeArgs, profile, config, true);
      plannedChannels = spec.channels;
      plannedMeta = {
        onMinutes: onMin,
        offMinutes: offMin,
        modeCode: spec.modeCode,
        gear: spec.gear,
        powerWatts: spec.powerWatts,
      };
      const frame1A = buildTempConfigFrame({
        on: true,
        onMinutes: onMin,
        offMinutes: offMin,
        pwm: spec.pwm,
        modeCode: spec.modeCode,
        gear: spec.gear,
        modelName: profile.key,
      });
      txFrames = [frame1A, buildQueryTempConfigFrame()];
    } else {
      effectiveAction = 'mode:manual';
      const isOn = safeArgs.on !== false && safeArgs.lampState !== 0;
      if (!isOn) {
        txFrames = [buildControlFrame({
          on: false,
          permanent: true,
          restoreSeconds: config.tempOffMinutes * 60,
          modelName: profile.key,
        })];
      } else {
        const spec = resolveSpectrumSpec(safeArgs, profile, config, false);
        plannedChannels = spec.channels;
        plannedMeta = {
          modeCode: spec.modeCode,
          gear: spec.gear,
          sceneName: spec.sceneName,
          seriesName: spec.seriesName,
          powerWatts: spec.powerWatts,
          powerClamped: spec.powerClamped,
        };
        txFrames = [buildControlFrame({
          on: true,
          permanent: true,
          pwm: spec.pwm,
          modeCode: spec.modeCode,
          gear: spec.gear,
          restoreSeconds: config.tempOnMinutes * 60,
          modelName: profile.key,
        })];
      }
    }
  } else if (cleanAction === 'resume') {
    const hint = safeArgs.lampStateHint === 0 || safeArgs.lampStateHint === false ? 0 : 1;
    txFrames = [buildResumeScheduleFrame(hint, 1)];
  } else if (cleanAction === 'clock') {
    const targetTs = safeArgs.timestamp !== undefined ? safeArgs.timestamp : nowFn();
    const syncTx = buildClockSyncFrame(
      /** @type {Date | number | string} */ (targetTs),
      {
        groupId: clampInt(safeArgs.groupId, 0, 255) ?? 0,
        devId: clampInt(safeArgs.devId, 1, 255) ?? 1,
        tzHours: safeArgs.tzHours !== undefined ? Number(safeArgs.tzHours) : undefined,
      },
    );
    plannedMeta = { syncedAt: new Date(Number.isFinite(Number(targetTs)) ? Number(targetTs) : nowFn()).toISOString() };
    txFrames = [syncTx, buildQueryStatusFrame()];
  }

  if (safeArgs.dryRun === true && cleanAction !== 'scan') {
    return {
      ok: true,
      notify: true,
      title: '尼特利指令预演 (dryRun)',
      message: `dryRun 模式：将向 ${effectiveTargetMac || '自动发现灯具'} 发送帧 ${txFrames.join(',')}`,
      data: {
        dryRun: true,
        action: effectiveAction,
        targetMac: effectiveTargetMac || null,
        tx: txFrames[0],
        txFrames,
        ...(plannedChannels ? { channels: plannedChannels } : {}),
        ...(plannedMeta ? { meta: plannedMeta } : {}),
      },
    };
  }

  if (platform !== 'linux' && !hasInjectedRunner) {
    return disabledBleResult(platform);
  }

  const preferMac = cachedBefore.lastAddress ?? '';

  if (cleanAction === 'scan') {
    const timeoutSec = clampInt(safeArgs.timeoutSec ?? safeArgs.timeout, 1, 15) ?? 5;
    let raw;
    try {
      raw = await invokeBleLocked(
        bleLockPath,
        bleRunner,
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
        false,
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
      await saveLastState(paths.statePath, { deviceView: devices[0], nowMs: nowFn() });
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

  // Persist temp minutes in config.json when writing mode:temp-config
  if (effectiveAction === 'mode:temp-config' && plannedMeta) {
    await withFileLock(paths.configPath, () => {
      const cur = loadNormalizedConfig(paths.configPath);
      cur.tempOnMinutes = Number(plannedMeta.onMinutes) || cur.tempOnMinutes;
      cur.tempOffMinutes = Number(plannedMeta.offMinutes) || cur.tempOffMinutes;
      if (plannedChannels) cur.defaultChannels = plannedChannels;
      writeConfig(paths.configPath, cur);
    });
  }

  const cmdRes = await runBleCommandBatch({
    bleRunner,
    lockPath: bleLockPath,
    txFrames,
    effectiveTargetMac,
    preferMac,
    modelHint,
    namePrefix: config.namePrefix,
    safeArgs,
    statePath: paths.statePath,
    clearScheduleIfNoTravel: cleanAction === 'status' && safeArgs.minimal !== true,
    nowFn,
    signal,
  });
  if (!cmdRes.ok) {
    return cmdRes.errorResult;
  }

  const { deviceView, state, tempConfig, schedule, replies } = cmdRes;

  const titleMap = {
    status: '尼特利鱼缸灯状态',
    on: '鱼缸灯已临时开启',
    off: '鱼缸灯已临时关闭',
    'mode:manual': state?.on === false ? '已切换手动关闭' : '已切换手动恒亮模式',
    'mode:temp-config': '已更新灯内默认临时配置',
    resume: '鱼缸灯已恢复自动行程',
    clock: '灯具时钟同步成功',
  };
  const prefixMap = {
    status: '',
    on: `临时开灯（${plannedMeta?.durationMinutes ?? config.tempOnMinutes} 分钟）`,
    off: `临时关灯（${plannedMeta?.durationMinutes ?? config.tempOffMinutes} 分钟）`,
    'mode:manual': state?.on === false ? '手动恒定关闭' : '已锁定手动恒亮',
    'mode:temp-config': '已保存默认临时分钟与光谱',
    resume: '已切换回 24h 自动行程',
    clock: 'RTC 时钟已与主机对齐',
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
      tx: txFrames[0],
      txFrames,
      ...(plannedChannels ? { plannedChannels } : {}),
      ...(plannedMeta ? { meta: plannedMeta } : {}),
      device: deviceView,
      state,
      tempConfig,
      schedule,
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

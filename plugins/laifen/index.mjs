#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
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
const PYTHON_BIN = existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3';

export const DEFAULT_MAC = '';
export const DEFAULT_NAME_PREFIX = 'LFTB';
export const DEFAULT_LIFESPAN_DAYS = 90;
export const DEFAULT_DAILY_GOAL = 2;
export const DEFAULT_DURATION_SEC = 180;

export const ACTIONS = [
  'dashboard',
  'status',
  'config',
  'scan',
  'sync',
  'set',
  'power',
  'monitor-start',
  'monitor-status',
  'monitor-stop',
  'watch-start',
  'watch-stop',
  'pending-clear',
  'session-add',
  'session-delete',
  'brushhead-reset',
];

export const PRESETS = Object.freeze({
  gentle: {
    id: 'gentle',
    label: '柔和护龈',
    mode: 1,
    strength: 3,
    range: 4,
    speed: 4,
    highFrequency: false,
    description: '轻柔振动与小幅扫动，适合敏感牙龈或日常温和护理',
  },
  daily: {
    id: 'daily',
    label: '日常清洁',
    mode: 2,
    strength: 6,
    range: 6,
    speed: 6,
    highFrequency: false,
    description: '均衡振动频率与摆动幅度，适合早晚常规清洁',
  },
  strong: {
    id: 'strong',
    label: '强劲清洁',
    mode: 3,
    strength: 10,
    range: 9,
    speed: 9,
    highFrequency: false,
    description: '高强度大摆幅巴氏扫振，强化清理顽固菌斑',
  },
  whitening: {
    id: 'whitening',
    label: '高频亮白',
    mode: 4,
    strength: 14,
    range: 8,
    speed: 8,
    highFrequency: true,
    description: '启用 Mode 4 高频模式（力度 11~20），用于抛光亮白',
  },
});

const DEFAULT_CONFIG = {
  targetMac: DEFAULT_MAC,
  namePrefix: DEFAULT_NAME_PREFIX,
  brushHeadLifespanDays: DEFAULT_LIFESPAN_DAYS,
  brushHeadReplacedAt: null,
  dailyGoalCount: DEFAULT_DAILY_GOAL,
  targetDurationSec: DEFAULT_DURATION_SEC,
  autoWakeSync: false,
};

const MAC_RE = /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const V2PRO_OVER_PRESSURE_LEVELS = new Map([
  ['0:220', 'Light'],   // (0x00, 0xDC)
  ['1:74', 'Medium'],   // (0x01, 0x4A)
  ['1:184', 'Hard'],    // (0x01, 0xB8)
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function asFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function asInt(value) {
  const num = asFiniteNumber(value);
  return num === undefined ? undefined : Math.trunc(num);
}

function asOptionalBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return undefined;
}

function normalizeMac(mac) {
  return String(mac || '').trim().toUpperCase();
}

function safeJsonParse(raw, fallback) {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isBleHelperPid(pid) {
  if (!isPidAlive(pid)) return false;
  if (process.platform !== 'linux') return false;
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const argv = cmdline.split('\0').filter(Boolean);
    return argv.some(arg => arg.includes('ble_helper.py'));
  } catch {
    return false;
  }
}

async function terminateBleHelperPid(pid, { sleepFn = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const numPid = Number(pid);
  if (!isBleHelperPid(numPid)) return false;
  try {
    process.kill(numPid, 'SIGTERM');
  } catch {
    return false;
  }
  const deadlineMs = 2000;
  const stepMs = 100;
  for (let waited = 0; waited < deadlineMs; waited += stepMs) {
    await sleepFn(stepMs);
    if (!isPidAlive(numPid)) return true;
  }
  if (isBleHelperPid(numPid)) {
    try {
      process.kill(numPid, 'SIGKILL');
    } catch {
      // ignore ESRCH race
    }
  }
  return true;
}

function defaultModesTable() {
  return {
    '1': { strength: 3, range: 4, speed: 4 },
    '2': { strength: 6, range: 6, speed: 6 },
    '3': { strength: 10, range: 9, speed: 9 },
    '4': { strength: 14, range: 6, speed: 6 },
  };
}

function toBuffer(hexOrBytes) {
  if (Buffer.isBuffer(hexOrBytes)) return hexOrBytes;
  if (hexOrBytes instanceof Uint8Array) return Buffer.from(hexOrBytes);
  const clean = String(hexOrBytes || '').replace(/[^0-9a-fA-F]/g, '');
  if (!clean || clean.length % 2 !== 0) return Buffer.alloc(0);
  return Buffer.from(clean, 'hex');
}

function xorChecksum(bytes) {
  let cs = 0;
  for (const b of bytes) {
    cs ^= b & 0xff;
  }
  return cs & 0xff;
}

function withXorFrame(prefixBytes) {
  const buf = Buffer.allocUnsafe(prefixBytes.length + 1);
  for (let i = 0; i < prefixBytes.length; i++) {
    buf[i] = prefixBytes[i] & 0xff;
  }
  buf[prefixBytes.length] = xorChecksum(buf.subarray(0, prefixBytes.length));
  return buf;
}

// ---------------------------------------------------------------------------
// Laifen BLE Protocol Codec (V1 AA-header & V2 Pro 5A-header)
// ---------------------------------------------------------------------------

export const LaifenProtocol = {
  xorChecksum,

  /**
   * Verify V1 6-byte command ACK: `AA [CMD] 02 01 [STATUS] [CS]`.
   * Real LFTB01-P-640A firmware may return either XOR or bitwise-inverted XOR (~XOR)
   * on the trailing byte of ACKs (e.g. AA0402010052 and AA0502010053), so status==0x00
   * is authoritative and checksumMode records the trailing byte flavor.
   * @param {string | Buffer | Uint8Array} hexOrBytes
   * @param {number} [expectedCmd]
   */
  verifyV1Ack(hexOrBytes, expectedCmd) {
    const buf = toBuffer(hexOrBytes);
    if (buf.length < 6 || buf[0] !== 0xaa || buf[2] !== 0x02 || buf[3] !== 0x01) {
      return { valid: false, ok: false, cmd: null, statusByte: null, checksumMode: 'invalid', rawHex: buf.toString('hex').toUpperCase() };
    }
    const cmd = buf[1];
    if (expectedCmd !== undefined && cmd !== (expectedCmd & 0xff)) {
      return { valid: false, ok: false, cmd, statusByte: buf[4], checksumMode: 'cmd_mismatch', rawHex: buf.toString('hex').toUpperCase() };
    }
    const xor = xorChecksum(buf.subarray(0, 5));
    const tail = buf[5];
    const checksumMode = tail === xor ? 'xor' : (tail === (xor ^ 0xff) ? 'inverted_xor' : 'other');
    return {
      valid: true,
      ok: buf[4] === 0x00,
      cmd,
      statusByte: buf[4],
      checksumMode,
      rawHex: buf.toString('hex').toUpperCase(),
    };
  },

  buildV1ModeSettings(mode, strength, range, speed) {
    const modeIdx = clamp((asInt(mode) ?? 1) - 1, 0, 3);
    const str = modeIdx === 3
      ? clamp(asInt(strength) ?? 11, 11, 20)
      : clamp(asInt(strength) ?? 5, 1, 10);
    const rng = clamp(asInt(range) ?? 5, 1, 10);
    const spd = clamp(asInt(speed) ?? 5, 1, 10);
    return withXorFrame([0xaa, 0x04, 0x01, 0x04, modeIdx, str, rng, spd]);
  },

  buildV1Duration(seconds) {
    const rounded = Math.round(clamp(asFiniteNumber(seconds) ?? 180, 60, 300) / 30) * 30;
    const sec = clamp(rounded, 60, 300);
    return withXorFrame([0xaa, 0x05, 0x01, 0x02, (sec >> 8) & 0xff, sec & 0xff]);
  },

  buildV1HighFrequency(enabled) {
    return withXorFrame([0xaa, 0x0e, 0x01, 0x01, enabled ? 0x01 : 0x00]);
  },

  buildV1Reminder30s(enabled) {
    return withXorFrame([0xaa, 0x0b, 0x01, 0x01, enabled ? 0x01 : 0x00]);
  },

  buildV1AirplaneMode(enabled) {
    return withXorFrame([0xaa, 0x07, 0x01, 0x01, enabled ? 0x01 : 0x00]);
  },

  buildV1Power(on) {
    return withXorFrame([0xaa, 0x0f, 0x01, 0x01, on ? 0x01 : 0x00]);
  },

  buildV1Calibration(action) {
    const val = action === 'calibrate' ? 0x03 : 0x01;
    return withXorFrame([0xaa, 0x06, 0x01, 0x01, val]);
  },

  buildV2ProCommand(cmd16, payload = []) {
    return withXorFrame([
      0xaa,
      (cmd16 >> 8) & 0xff,
      cmd16 & 0xff,
      0x00,
      0x00,
      payload.length & 0xff,
      ...payload,
    ]);
  },

  buildV2ProOverPressureCommand(enabled, level = 'Medium') {
    const map = {
      Light: [0x00, 0xdc],
      Medium: [0x01, 0x4a],
      Hard: [0x01, 0xb8],
    };
    const pair = map[level] || map.Medium;
    return LaifenProtocol.buildV2ProCommand(0x020b, [enabled ? 0x01 : 0x00, pair[0], pair[1]]);
  },

  /**
   * Parse V1 (`AA ...`) or V2 / V2 Pro (`5A ...`) notification frame.
   * @param {string | Buffer | Uint8Array} hexOrBytes
   * @param {Record<string, any>} [prevState]
   */
  parsePacket(hexOrBytes, prevState = {}) {
    const buf = toBuffer(hexOrBytes);
    if (buf.length === 0) return null;
    const rawHex = buf.toString('hex').toUpperCase();
    const prev = prevState || {};

    // V1 Info frame (AA 01 02 ...)
    if (buf.length >= 8 && buf[0] === 0xaa && buf[1] === 0x01 && buf[2] === 0x02) {
      const ascii = buf.toString('ascii').replace(/[^A-Za-z0-9_-]/g, '');
      return {
        type: 'info',
        protocol: 'v1',
        rawHex,
        byteLen: buf.length,
        asciiHint: ascii.slice(0, 24) || null,
      };
    }

    // V1 Status frame (AA 0A 02 ..., 20/26/28 bytes)
    if (buf.length >= 19 && buf[0] === 0xaa && buf[1] === 0x0a && buf[2] === 0x02) {
      const modeIndex = buf[4] <= 3 ? buf[4] : (asInt(prev.activeMode) ? asInt(prev.activeMode) - 1 : 0);
      const prevModes = prev.modes && typeof prev.modes === 'object' ? prev.modes : defaultModesTable();
      /** @type {Record<string, { strength: number; range: number; speed: number }>} */
      const modes = {};
      for (let m = 0; m < 4; m++) {
        const key = String(m + 1);
        const base = 5 + 3 * m;
        const fallbackSlot = prevModes[key] || { strength: m === 3 ? 11 : 5, range: 5, speed: 5 };
        if (buf.length > base + 2) {
          const s = buf[base] >= 1 && buf[base] <= 20 ? buf[base] : fallbackSlot.strength;
          const r = buf[base + 1] >= 1 && buf[base + 1] <= 10 ? buf[base + 1] : fallbackSlot.range;
          const sp = buf[base + 2] >= 1 && buf[base + 2] <= 10 ? buf[base + 2] : fallbackSlot.speed;
          modes[key] = { strength: s, range: r, speed: sp };
        } else {
          modes[key] = { ...fallbackSlot };
        }
      }

      const activeKey = String(modeIndex + 1);
      const activeSlot = modes[activeKey] || modes['1'];
      const hasFullLayout = buf.length >= 26;
      const batteryPct = buf.length > 18 ? buf[18] : (asInt(prev.batteryPct) ?? null);
      const airplaneMode = buf.length > 17 ? Boolean(buf[17]) : Boolean(prev.airplaneMode);
      const reminder30s = hasFullLayout ? Boolean(buf[19]) : Boolean(prev.reminder30s);
      const durationSec = hasFullLayout ? ((buf[20] << 8) | buf[21]) : (asInt(prev.durationSec) ?? DEFAULT_DURATION_SEC);
      const highFrequency = hasFullLayout ? Boolean(buf[22]) : Boolean(prev.highFrequency);
      const status = hasFullLayout ? (buf[23] === 0x01 ? 'Running' : 'Idle') : (prev.status || 'Idle');

      return {
        type: 'status',
        protocol: 'v1',
        rawHex,
        byteLen: buf.length,
        checksumOk: xorChecksum(buf.subarray(0, buf.length - 1)) === buf[buf.length - 1],
        modeIndex,
        activeMode: modeIndex + 1,
        activeStrength: activeSlot.strength,
        activeRange: activeSlot.range,
        activeSpeed: activeSlot.speed,
        modes,
        batteryPct,
        airplaneMode,
        reminder30s,
        durationSec,
        highFrequency,
        status,
      };
    }

    // V2 Pro (5A [TYPE] [SUBCMD] [SEQ] 00 [LEN] [payload] [cs])
    if (buf.length >= 7 && buf[0] === 0x5a && [0xc1, 0x81, 0xc2, 0xf0, 0x82].includes(buf[1])) {
      const ptype = buf[1];
      const subcmd = buf[2];
      const paylen = buf[5];
      if (buf.length < 6 + paylen + 1) return null;
      const payload = buf.subarray(6, 6 + paylen);

      if ((ptype === 0xc1 || ptype === 0x81) && subcmd === 0x03 && payload.length >= 33) {
        const activeMode = clamp(asInt(prev.activeMode) ?? 1, 1, 4);
        const modes = prev.modes && typeof prev.modes === 'object' ? prev.modes : defaultModesTable();
        const activeSlot = modes[String(activeMode)] || modes['1'];
        const durationSec = payload[5] | (payload[6] << 8);
        const opKey = `${payload[27]}:${payload[28]}`;
        return {
          type: 'status',
          protocol: 'v2pro',
          rawHex,
          byteLen: buf.length,
          checksumOk: xorChecksum(buf.subarray(0, buf.length - 1)) === buf[buf.length - 1],
          modeIndex: activeMode - 1,
          activeMode,
          activeStrength: activeSlot.strength,
          activeRange: activeSlot.range,
          activeSpeed: activeSlot.speed,
          modes,
          batteryPct: payload[2],
          durationSec,
          status: payload[13] === 1 ? 'Running' : (payload[13] === 2 ? 'JustStopped' : 'Idle'),
          highFrequency: Boolean(prev.highFrequency),
          reminder30s: Boolean(prev.reminder30s),
          airplaneMode: Boolean(prev.airplaneMode),
          features: {
            deepClean: Boolean(payload[15]),
            antiSplash: Boolean(payload[16]),
            powerRampUp: Boolean(payload[24]),
            quickSpinDry: Boolean(payload[25]),
            overPressure: Boolean(payload[26]),
            overPressureLevel: V2PRO_OVER_PRESSURE_LEVELS.get(opKey) || 'Unknown',
            bristleProtection: Boolean(payload[30]),
            liftToWake: Boolean(payload[32]),
            overPressureActive: Boolean(prev.features?.overPressureActive),
          },
        };
      }

      if (ptype === 0x82 && subcmd === 0x0c && payload.length >= 3) {
        return {
          type: 'telemetry',
          protocol: 'v2pro',
          subcmd: 'pressure',
          rawHex,
          overPressureActive: payload[2] !== 0,
          rawPressure: payload.length > 3 ? payload[3] : null,
        };
      }

      return {
        type: 'ack_or_other',
        protocol: 'v2pro',
        ptype,
        subcmd,
        rawHex,
      };
    }

    // V2 fallback (5A-header)
    if (buf.length >= 7 && buf[0] === 0x5a) {
      const cmd = buf[2];
      const paylen = buf[5];
      if (buf.length < 6 + paylen + 1) return null;
      const payload = buf.subarray(6, 6 + paylen);
      if (cmd === 0x03 && payload.length >= 22) {
        const modeIndex = clamp(payload[13], 0, 3);
        const modes = prev.modes && typeof prev.modes === 'object' ? prev.modes : defaultModesTable();
        const activeSlot = modes[String(modeIndex + 1)] || modes['1'];
        return {
          type: 'status',
          protocol: 'v2',
          rawHex,
          byteLen: buf.length,
          modeIndex,
          activeMode: modeIndex + 1,
          activeStrength: activeSlot.strength,
          activeRange: activeSlot.range,
          activeSpeed: activeSlot.speed,
          modes,
          batteryPct: payload[2],
          charging: payload[3] === 0x01,
          durationSec: payload[21] < 0x60 ? payload[21] : (asInt(prev.durationSec) ?? DEFAULT_DURATION_SEC),
          highFrequency: Boolean(prev.highFrequency),
          reminder30s: Boolean(prev.reminder30s),
          airplaneMode: Boolean(prev.airplaneMode),
          status: modeIndex > 0 ? 'Running' : 'Idle',
        };
      }
    }

    return null;
  },
};

// ---------------------------------------------------------------------------
// Config, Paths & SQLite Persistence
// ---------------------------------------------------------------------------

function resolveLaifenPaths(_args = {}, deps = {}) {
  return resolvePluginPaths('laifen', deps);
}

function loadLaifenConfig(configPath) {
  const raw = readConfig(configPath, DEFAULT_CONFIG);
  const mac = normalizeMac(raw.targetMac || '');
  const lifespan = clamp(asInt(raw.brushHeadLifespanDays) ?? DEFAULT_LIFESPAN_DAYS, 15, 365);
  const goal = clamp(asInt(raw.dailyGoalCount) ?? DEFAULT_DAILY_GOAL, 1, 6);
  const duration = Math.round(clamp(asInt(raw.targetDurationSec) ?? DEFAULT_DURATION_SEC, 60, 300) / 30) * 30;
  const replacedAt = asInt(raw.brushHeadReplacedAt);
  return {
    targetMac: MAC_RE.test(mac) ? mac : '',
    namePrefix: String(raw.namePrefix || DEFAULT_NAME_PREFIX).trim() || DEFAULT_NAME_PREFIX,
    brushHeadLifespanDays: lifespan,
    brushHeadReplacedAt: replacedAt && replacedAt > 0 ? replacedAt : null,
    dailyGoalCount: goal,
    targetDurationSec: clamp(duration, 60, 300),
    autoWakeSync: Boolean(raw.autoWakeSync ?? false),
  };
}

function redactConfig(cfg) {
  return {
    targetMac: cfg.targetMac,
    namePrefix: cfg.namePrefix,
    brushHeadLifespanDays: cfg.brushHeadLifespanDays,
    brushHeadReplacedAt: cfg.brushHeadReplacedAt,
    dailyGoalCount: cfg.dailyGoalCount,
    targetDurationSec: cfg.targetDurationSec,
    autoWakeSync: Boolean(cfg.autoWakeSync),
  };
}

const INITIALIZED_DB_PATHS = new Set();

function openDb(paths) {
  ensurePrivateDir(paths.pluginDataDir);
  const dbPath = join(paths.pluginDataDir, 'laifen.db');
  const dbExistsBeforeOpen = existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
  `);

  if (!dbExistsBeforeOpen || !INITIALIZED_DB_PATHS.has(dbPath)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS device_state (
        id TEXT PRIMARY KEY,
        mac TEXT,
        address TEXT,
        name TEXT,
        protocol TEXT,
        rssi INTEGER,
        battery_pct INTEGER,
        active_mode INTEGER,
        modes_json TEXT,
        duration_sec INTEGER,
        high_frequency INTEGER,
        reminder_30s INTEGER,
        airplane_mode INTEGER,
        status TEXT,
        features_json TEXT,
        last_status_hex TEXT,
        last_info_hex TEXT,
        updated_at INTEGER NOT NULL,
        last_synced_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS battery_logs (
        id TEXT PRIMARY KEY,
        mac TEXT,
        battery_pct INTEGER NOT NULL,
        source TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_battery_logs_time
        ON battery_logs(recorded_at DESC);

      CREATE TABLE IF NOT EXISTS brush_sessions (
        id TEXT PRIMARY KEY,
        dedup_key TEXT UNIQUE,
        mac TEXT,
        brushed_at INTEGER NOT NULL,
        duration_sec INTEGER NOT NULL,
        mode INTEGER,
        strength INTEGER,
        range_val INTEGER,
        speed INTEGER,
        battery_before INTEGER,
        battery_after INTEGER,
        over_pressure_count INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_brush_sessions_time
        ON brush_sessions(brushed_at DESC);
    `);
    INITIALIZED_DB_PATHS.add(dbPath);
  }
  return db;
}

function getDeviceState(db) {
  const row = db.prepare('SELECT * FROM device_state WHERE id = ?').get('primary')
    || db.prepare('SELECT * FROM device_state ORDER BY updated_at DESC LIMIT 1').get();
  if (!row) return null;
  const modes = safeJsonParse(String(row.modes_json || ''), defaultModesTable());
  const activeMode = clamp(asInt(row.active_mode) ?? 1, 1, 4);
  const activeSlot = modes[String(activeMode)] || modes['1'];
  return {
    mac: row.mac || '',
    address: row.address || row.mac || '',
    name: row.name || '',
    protocol: row.protocol || 'v1',
    rssi: asInt(row.rssi) ?? null,
    batteryPct: asInt(row.battery_pct) ?? null,
    activeMode,
    activeStrength: activeSlot?.strength ?? null,
    activeRange: activeSlot?.range ?? null,
    activeSpeed: activeSlot?.speed ?? null,
    modes,
    durationSec: asInt(row.duration_sec) ?? DEFAULT_DURATION_SEC,
    highFrequency: Boolean(row.high_frequency),
    reminder30s: Boolean(row.reminder_30s),
    airplaneMode: Boolean(row.airplane_mode),
    status: row.status || 'Idle',
    features: safeJsonParse(String(row.features_json || ''), {}),
    lastStatusHex: row.last_status_hex || null,
    lastInfoHex: row.last_info_hex || null,
    updatedAt: asInt(row.updated_at) ?? null,
    lastSyncedAt: asInt(row.last_synced_at) ?? null,
  };
}

function recordBatteryLogIfChanged(db, mac, batteryPct, source, nowMs) {
  if (batteryPct === null || batteryPct === undefined || batteryPct < 0 || batteryPct > 100) return;
  const latest = db.prepare('SELECT battery_pct, recorded_at FROM battery_logs ORDER BY recorded_at DESC LIMIT 1').get();
  if (latest) {
    const sameLevel = Number(latest.battery_pct) === Number(batteryPct);
    const recent = nowMs - Number(latest.recorded_at) < 3_600_000;
    if (sameLevel && recent) return;
  }
  db.prepare(`
    INSERT INTO battery_logs (id, mac, battery_pct, source, recorded_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(`bat-${nowMs}-${randomUUID().slice(0, 6)}`, mac || '', batteryPct, source, nowMs);
}

function saveDeviceState(db, patch, nowMs, { source = 'sync', synced = true } = {}) {
  /** @type {Partial<NonNullable<ReturnType<typeof getDeviceState>>>} */
  const prev = getDeviceState(db) || {};
  const mergedModes = patch.modes || prev.modes || defaultModesTable();
  const activeMode = clamp(asInt(patch.activeMode ?? prev.activeMode) ?? 1, 1, 4);
  const mergedFeatures = {
    ...(prev.features && typeof prev.features === 'object' ? prev.features : {}),
    ...(patch.features && typeof patch.features === 'object' ? patch.features : {}),
  };

  const next = {
    mac: normalizeMac(patch.mac || patch.address || prev.mac || ''),
    address: normalizeMac(patch.address || patch.mac || prev.address || ''),
    name: String(patch.name || prev.name || ''),
    protocol: String(patch.protocol || prev.protocol || 'v1'),
    rssi: patch.rssi !== undefined && patch.rssi !== null ? asInt(patch.rssi) : (prev.rssi ?? null),
    batteryPct: patch.batteryPct !== undefined && patch.batteryPct !== null ? asInt(patch.batteryPct) : (prev.batteryPct ?? null),
    activeMode,
    modes: mergedModes,
    durationSec: asInt(patch.durationSec ?? prev.durationSec) ?? DEFAULT_DURATION_SEC,
    highFrequency: patch.highFrequency !== undefined ? Boolean(patch.highFrequency) : Boolean(prev.highFrequency),
    reminder30s: patch.reminder30s !== undefined ? Boolean(patch.reminder30s) : Boolean(prev.reminder30s),
    airplaneMode: patch.airplaneMode !== undefined ? Boolean(patch.airplaneMode) : Boolean(prev.airplaneMode),
    status: String(patch.status || prev.status || 'Idle'),
    features: mergedFeatures,
    lastStatusHex: patch.lastStatusHex || prev.lastStatusHex || null,
    lastInfoHex: patch.lastInfoHex || prev.lastInfoHex || null,
    updatedAt: nowMs,
    lastSyncedAt: synced ? nowMs : (prev.lastSyncedAt ?? null),
  };

  db.prepare(`
    INSERT INTO device_state (
      id, mac, address, name, protocol, rssi, battery_pct, active_mode,
      modes_json, duration_sec, high_frequency, reminder_30s, airplane_mode,
      status, features_json, last_status_hex, last_info_hex, updated_at, last_synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mac = excluded.mac,
      address = excluded.address,
      name = excluded.name,
      protocol = excluded.protocol,
      rssi = excluded.rssi,
      battery_pct = excluded.battery_pct,
      active_mode = excluded.active_mode,
      modes_json = excluded.modes_json,
      duration_sec = excluded.duration_sec,
      high_frequency = excluded.high_frequency,
      reminder_30s = excluded.reminder_30s,
      airplane_mode = excluded.airplane_mode,
      status = excluded.status,
      features_json = excluded.features_json,
      last_status_hex = excluded.last_status_hex,
      last_info_hex = excluded.last_info_hex,
      updated_at = excluded.updated_at,
      last_synced_at = excluded.last_synced_at
  `).run(
    'primary',
    next.mac,
    next.address,
    next.name,
    next.protocol,
    next.rssi,
    next.batteryPct,
    next.activeMode,
    JSON.stringify(next.modes),
    next.durationSec,
    next.highFrequency ? 1 : 0,
    next.reminder30s ? 1 : 0,
    next.airplaneMode ? 1 : 0,
    next.status,
    JSON.stringify(next.features),
    next.lastStatusHex,
    next.lastInfoHex,
    next.updatedAt,
    next.lastSyncedAt,
  );

  if (next.batteryPct !== null) {
    recordBatteryLogIfChanged(db, next.mac, next.batteryPct, source, nowMs);
  }
  return getDeviceState(db);
}

function insertBrushSession(db, entry, nowMs) {
  const dedupKey = entry.dedupKey || null;
  if (dedupKey) {
    const existing = db.prepare('SELECT * FROM brush_sessions WHERE dedup_key = ?').get(dedupKey);
    if (existing) {
      return { inserted: false, row: mapSessionRow(existing) };
    }
  }
  const id = entry.id || `br-${entry.brushedAt}-${randomUUID().slice(0, 6)}`;
  db.prepare(`
    INSERT INTO brush_sessions (
      id, dedup_key, mac, brushed_at, duration_sec, mode, strength, range_val, speed,
      battery_before, battery_after, over_pressure_count, source, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    dedupKey,
    normalizeMac(entry.mac || ''),
    entry.brushedAt,
    clamp(asInt(entry.durationSec) ?? 120, 5, 1800),
    entry.mode ?? null,
    entry.strength ?? null,
    entry.range ?? null,
    entry.speed ?? null,
    entry.batteryBefore ?? null,
    entry.batteryAfter ?? null,
    clamp(asInt(entry.overPressureCount) ?? 0, 0, 9999),
    String(entry.source || 'manual'),
    String(entry.note || ''),
    nowMs,
  );
  const row = db.prepare('SELECT * FROM brush_sessions WHERE id = ?').get(id);
  return { inserted: true, row: mapSessionRow(row) };
}

function mapSessionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    mac: row.mac || '',
    brushedAt: Number(row.brushed_at),
    durationSec: Number(row.duration_sec),
    mode: row.mode !== null && row.mode !== undefined ? Number(row.mode) : null,
    strength: row.strength !== null && row.strength !== undefined ? Number(row.strength) : null,
    range: row.range_val !== null && row.range_val !== undefined ? Number(row.range_val) : null,
    speed: row.speed !== null && row.speed !== undefined ? Number(row.speed) : null,
    batteryBefore: row.battery_before !== null && row.battery_before !== undefined ? Number(row.battery_before) : null,
    batteryAfter: row.battery_after !== null && row.battery_after !== undefined ? Number(row.battery_after) : null,
    overPressureCount: Number(row.over_pressure_count || 0),
    source: row.source,
    note: row.note || '',
    createdAt: Number(row.created_at),
  };
}

function localDayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftDayKey(ms, deltaDays) {
  const d = new Date(ms);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + deltaDays);
  return localDayKey(d.getTime());
}

function computeOralCareStats(db, config, device, nowMs) {
  const allRows = db.prepare('SELECT * FROM brush_sessions ORDER BY brushed_at DESC').all().map(mapSessionRow);
  const todayKey = localDayKey(nowMs);
  const yesterdayKey = shiftDayKey(nowMs, -1);

  /** @type {Map<string, Array<ReturnType<typeof mapSessionRow>>>} */
  const byDay = new Map();
  for (const s of allRows) {
    const key = localDayKey(s.brushedAt);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(s);
    else byDay.set(key, [s]);
  }

  const todayList = byDay.get(todayKey) || [];
  const todayCount = todayList.length;
  const todayDurationSec = todayList.reduce((acc, s) => acc + (s.durationSec || 0), 0);
  const morningDone = todayList.some(s => new Date(s.brushedAt).getHours() < 12);
  const eveningDone = todayList.some(s => new Date(s.brushedAt).getHours() >= 12);

  // Consecutive days with >= 1 brush (start from today if brushed today, otherwise yesterday)
  let streakDays = 0;
  let offset = byDay.has(todayKey) ? 0 : (byDay.has(yesterdayKey) ? -1 : null);
  if (offset !== null) {
    while (byDay.has(shiftDayKey(nowMs, offset))) {
      streakDays += 1;
      offset -= 1;
    }
  }

  // Consecutive days meeting dailyGoalCount
  const goal = config.dailyGoalCount || DEFAULT_DAILY_GOAL;
  let goalStreakDays = 0;
  let gOffset = (byDay.get(todayKey)?.length || 0) >= goal
    ? 0
    : ((byDay.get(yesterdayKey)?.length || 0) >= goal ? -1 : null);
  if (gOffset !== null) {
    while ((byDay.get(shiftDayKey(nowMs, gOffset))?.length || 0) >= goal) {
      goalStreakDays += 1;
      gOffset -= 1;
    }
  }

  const last7Days = [];
  for (let delta = -6; delta <= 0; delta++) {
    const key = shiftDayKey(nowMs, delta);
    const list = byDay.get(key) || [];
    last7Days.push({
      date: key,
      label: key.slice(5),
      count: list.length,
      totalDurationSec: list.reduce((acc, s) => acc + (s.durationSec || 0), 0),
      goalMet: list.length >= goal,
    });
  }

  // Brush-head lifespan calculation
  const lifespanDays = config.brushHeadLifespanDays || DEFAULT_LIFESPAN_DAYS;
  const earliestSession = allRows.length > 0 ? allRows[allRows.length - 1].brushedAt : null;
  const anchorAt = config.brushHeadReplacedAt
    ?? earliestSession
    ?? device?.lastSyncedAt
    ?? nowMs;
  const daysUsed = Math.max(0, Math.floor((nowMs - anchorAt) / 86_400_000));
  const daysLeft = Math.max(0, lifespanDays - daysUsed);
  const percentLeft = clamp(Math.round((daysLeft / lifespanDays) * 100), 0, 100);
  const usedSessions = allRows.filter(s => s.brushedAt >= anchorAt).length;

  return {
    todayCount,
    todayDurationSec,
    dailyGoalCount: goal,
    morningDone,
    eveningDone,
    streakDays,
    goalStreakDays,
    totalSessions: allRows.length,
    last7Days,
    brushHead: {
      replacedAt: config.brushHeadReplacedAt,
      anchorAt,
      lifespanDays,
      daysUsed,
      daysLeft,
      percentLeft,
      usedSessions,
      needsReplacement: daysLeft <= 7,
    },
  };
}

// ---------------------------------------------------------------------------
// Live Monitor, Watch Outbox, Yield Lock & Pending Patch Persistence
// ---------------------------------------------------------------------------

function sessionFilePath(dataDir) {
  return join(dataDir, 'live-session.json');
}

function watchStatePath(dataDir) {
  return join(dataDir, 'watch-state.json');
}

function watchOutboxDir(dataDir) {
  return join(dataDir, 'watch-outbox');
}

function pendingPatchPath(dataDir) {
  return join(dataDir, 'pending-patch.json');
}

function manualBleLockPath(dataDir) {
  return join(dataDir, 'ble-manual.lock');
}

function readPendingPatch(dataDir) {
  const pPath = pendingPatchPath(dataDir);
  if (!existsSync(pPath)) return null;
  const raw = readJsonSafe(pPath, null);
  if (!raw || typeof raw !== 'object' || !raw.patchId || !raw.patch || typeof raw.patch !== 'object' || Array.isArray(raw.patch)) {
    return null;
  }
  if (Object.keys(raw.patch).length === 0) return null;
  return {
    patchId: String(raw.patchId),
    patch: /** @type {Record<string, unknown>} */ ({ ...raw.patch }),
    queuedAt: asInt(raw.queuedAt) ?? Date.now(),
  };
}

function writePendingPatch(dataDir, patch, nowMs) {
  ensurePrivateDir(dataDir);
  const entry = {
    patchId: `patch-${nowMs}-${randomUUID().slice(0, 6)}`,
    patch: { ...patch },
    queuedAt: nowMs,
  };
  writeJsonAtomic(pendingPatchPath(dataDir), entry);
  return entry;
}

function consumePendingPatchIfMatches(dataDir, patchId) {
  const pPath = pendingPatchPath(dataDir);
  if (!existsSync(pPath)) return false;
  if (!patchId) {
    try {
      unlinkSync(pPath);
      return true;
    } catch {
      return false;
    }
  }
  const cur = readPendingPatch(dataDir);
  if (cur && cur.patchId === String(patchId)) {
    try {
      unlinkSync(pPath);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function withManualBleYieldLock(dataDir, fn) {
  ensurePrivateDir(dataDir);
  const lockPath = manualBleLockPath(dataDir);
  const token = randomUUID();
  writeJsonAtomic(lockPath, { pid: process.pid, token, at: Date.now() });
  try {
    return await fn();
  } finally {
    try {
      const cur = readJsonSafe(lockPath, null);
      if (!cur || cur.token === token || cur.pid === process.pid) {
        unlinkSync(lockPath);
      }
    } catch {
      // ignore unlock cleanup error
    }
  }
}

function isWatchProcessAlive(raw) {
  const pid = asInt(raw?.pid) ?? 0;
  if (pid <= 0) return false;
  if (raw?.stubPid) return isPidAlive(pid);
  return isBleHelperPid(pid);
}

function getWatchStatus(dataDir, config, nowMs) {
  const wPath = watchStatePath(dataDir);
  const raw = existsSync(wPath) ? readJsonSafe(wPath, null) : null;
  const enabled = Boolean(config?.autoWakeSync);
  const running = Boolean(raw && isWatchProcessAlive(raw));
  const phase = running
    ? String(raw?.phase || 'watching')
    : (enabled ? 'starting' : String(raw?.phase || 'stopped'));
  const message = running
    ? String(raw?.message || '后台自动唤醒监听中：拿起牙刷亮灯即自动同步')
    : (enabled ? '后台自动唤醒守护待拉起…' : '后台自动唤醒同步未开启');
  return {
    enabled,
    running,
    phase,
    message,
    updatedAt: asInt(raw?.updatedAt) ?? null,
    lastSyncedAt: asInt(raw?.lastSyncedAt) ?? null,
    lastEventKind: raw?.lastEventKind ? String(raw.lastEventKind) : null,
    error: raw?.error ? String(raw.error) : null,
  };
}

function ingestWatchOutbox(db, dataDir, config, paths, nowMs) {
  const outboxDir = watchOutboxDir(dataDir);
  if (!existsSync(outboxDir)) return config;
  let files = [];
  try {
    files = readdirSync(outboxDir)
      .filter(f => f.startsWith('ev-') && f.endsWith('.json'))
      .sort();
  } catch {
    return config;
  }
  if (files.length === 0) return config;

  let currentCfg = config;
  for (const fname of files) {
    const evPath = join(outboxDir, fname);
    const ev = readJsonSafe(evPath, null);
    if (!ev || typeof ev !== 'object') {
      try { unlinkSync(evPath); } catch { /* ignore */ }
      continue;
    }

    const evAt = asInt(ev.at) ?? nowMs;
    /** @type {Partial<NonNullable<ReturnType<typeof getDeviceState>>>} */
    const prevState = getDeviceState(db) || {};
    const firstParsed = ev.firstStatusHex ? LaifenProtocol.parsePacket(ev.firstStatusHex, prevState) : null;
    const latestParsed = ev.latestStatusHex ? LaifenProtocol.parsePacket(ev.latestStatusHex, firstParsed || prevState) : null;
    const infoParsed = ev.infoHex ? LaifenProtocol.parsePacket(ev.infoHex) : null;
    const devMac = normalizeMac(ev.device?.address || currentCfg.targetMac || prevState.mac);

    if (!currentCfg.targetMac && MAC_RE.test(devMac) && paths?.configPath) {
      currentCfg = { ...currentCfg, targetMac: devMac };
      writeConfig(paths.configPath, currentCfg);
    }

    if (latestParsed && latestParsed.type === 'status') {
      saveDeviceState(db, {
        mac: devMac,
        address: devMac,
        name: ev.device?.name || prevState.name || 'LFTB',
        rssi: ev.device?.rssi,
        protocol: latestParsed.protocol,
        batteryPct: latestParsed.batteryPct,
        activeMode: latestParsed.activeMode,
        modes: latestParsed.modes,
        durationSec: latestParsed.durationSec,
        highFrequency: latestParsed.highFrequency,
        reminder30s: latestParsed.reminder30s,
        airplaneMode: latestParsed.airplaneMode,
        status: latestParsed.status,
        features: latestParsed.features,
        lastStatusHex: ev.latestStatusHex,
        lastInfoHex: ev.infoHex || infoParsed?.rawHex || prevState.lastInfoHex,
      }, evAt, { source: 'auto_watch', synced: true });
    }

    if (ev.appliedPatchId) {
      consumePendingPatchIfMatches(dataDir, String(ev.appliedPatchId));
    }

    if (ev.kind === 'session') {
      const durationSec = clamp(asInt(ev.activeBrushingSec) ?? 0, 0, 1800);
      if (durationSec >= 10) {
        /** @type {Record<string, any>} */
        const refState = latestParsed || firstParsed || getDeviceState(db) || {};
        const activeSlot = refState.modes?.[String(refState.activeMode || 1)] || {};
        const overCount = asInt(ev.overPressureEvents) ?? 0;
        insertBrushSession(db, {
          dedupKey: String(ev.dedupKey || `watch:${ev.eventId || fname}`),
          mac: devMac,
          brushedAt: asInt(ev.runningStartedAt) ?? evAt,
          durationSec,
          mode: refState.activeMode ?? null,
          strength: activeSlot.strength ?? refState.activeStrength ?? null,
          range: activeSlot.range ?? refState.activeRange ?? null,
          speed: activeSlot.speed ?? refState.activeSpeed ?? null,
          batteryBefore: firstParsed?.batteryPct ?? null,
          batteryAfter: latestParsed?.batteryPct ?? null,
          overPressureCount: overCount,
          source: 'ble_auto',
          note: overCount > 0 ? `自动监测 · 过压提醒 ${overCount} 次` : '拿起唤醒自动记录',
        }, nowMs);
      }
    }

    try {
      unlinkSync(evPath);
    } catch {
      // ignore already removed
    }
  }
  return currentCfg;
}

function sanitizeLiveSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    sessionId: raw.sessionId || '',
    pid: asInt(raw.pid) ?? null,
    phase: String(raw.phase || 'idle'),
    startedAt: asInt(raw.startedAt) ?? null,
    updatedAt: asInt(raw.updatedAt) ?? null,
    timeoutSec: asFiniteNumber(raw.timeoutSec) ?? null,
    message: String(raw.message || ''),
    device: raw.device || null,
    activeBrushingSec: asInt(raw.activeBrushingSec) ?? 0,
    overPressureEvents: asInt(raw.overPressureEvents) ?? 0,
    firstStatusHex: raw.firstStatusHex || null,
    latestStatusHex: raw.latestStatusHex || null,
    infoHex: raw.infoHex || null,
    runningStartedAt: asInt(raw.runningStartedAt) ?? null,
    error: raw.error || null,
  };
}

function ingestMonitorSessionIfReady(db, dataDir, config, nowMs) {
  const sPath = sessionFilePath(dataDir);
  if (!existsSync(sPath)) return null;
  const raw = readJsonSafe(sPath, null);
  if (!raw || !raw.sessionId) return null;

  let mutated = false;
  if (['scanning', 'connecting', 'monitoring'].includes(raw.phase)) {
    const pid = Number(raw.pid);
    const staleByAge = nowMs - Number(raw.updatedAt || raw.startedAt || 0) > (Number(raw.timeoutSec || 180) + 15) * 1000;
    const dead = pid > 0 ? !isPidAlive(pid) : staleByAge;
    if (dead) {
      raw.phase = raw.latestStatusHex ? 'completed' : 'timeout';
      raw.message = raw.latestStatusHex
        ? '蓝牙连接已结束并保留最新状态'
        : '蓝牙会话已结束，未收到牙刷状态';
      raw.updatedAt = nowMs;
      mutated = true;
    }
  }

  const sId = String(raw.sessionId || '');
  const isOneShotTelemetry = sId.startsWith('sync-') || sId.startsWith('write-');

  if (!isOneShotTelemetry) {
    /** @type {Partial<NonNullable<ReturnType<typeof getDeviceState>>>} */
    const prevState = getDeviceState(db) || {};
    const firstParsed = raw.firstStatusHex ? LaifenProtocol.parsePacket(raw.firstStatusHex, prevState) : null;
    const latestParsed = raw.latestStatusHex ? LaifenProtocol.parsePacket(raw.latestStatusHex, firstParsed || prevState) : null;
    const infoParsed = raw.infoHex ? LaifenProtocol.parsePacket(raw.infoHex) : null;

    if (latestParsed && latestParsed.type === 'status' && !raw.stateSynced) {
      saveDeviceState(db, {
        mac: raw.device?.address || config.targetMac,
        address: raw.device?.address || config.targetMac,
        name: raw.device?.name || prevState.name,
        rssi: raw.device?.rssi,
        protocol: latestParsed.protocol,
        batteryPct: latestParsed.batteryPct,
        activeMode: latestParsed.activeMode,
        modes: latestParsed.modes,
        durationSec: latestParsed.durationSec,
        highFrequency: latestParsed.highFrequency,
        reminder30s: latestParsed.reminder30s,
        airplaneMode: latestParsed.airplaneMode,
        status: latestParsed.status,
        features: latestParsed.features,
        lastStatusHex: raw.latestStatusHex,
        lastInfoHex: raw.infoHex || infoParsed?.rawHex || prevState.lastInfoHex,
      }, nowMs, { source: 'monitor', synced: true });
      raw.stateSynced = true;
      mutated = true;
    }

    // Record brushing session when completed/stopped and active brushing >= 10s
    if ((raw.phase === 'completed' || raw.phase === 'stopped') && !raw.ingestedSessionId) {
      const activeSec = asInt(raw.activeBrushingSec) ?? 0;
      const inferredSec = raw.runningStartedAt
        ? Math.max(activeSec, Math.round((Number(raw.updatedAt || nowMs) - Number(raw.runningStartedAt)) / 1000))
        : activeSec;
      if (inferredSec >= 10) {
        /** @type {Record<string, any>} */
        const refState = latestParsed || firstParsed || getDeviceState(db) || {};
        const activeSlot = refState.modes?.[String(refState.activeMode || 1)] || {};
        const inserted = insertBrushSession(db, {
          dedupKey: `monitor:${raw.sessionId}`,
          mac: raw.device?.address || config.targetMac || prevState.mac,
          brushedAt: Number(raw.runningStartedAt || raw.startedAt || nowMs),
          durationSec: inferredSec,
          mode: refState.activeMode ?? null,
          strength: activeSlot.strength ?? refState.activeStrength ?? null,
          range: activeSlot.range ?? refState.activeRange ?? null,
          speed: activeSlot.speed ?? refState.activeSpeed ?? null,
          batteryBefore: firstParsed?.batteryPct ?? null,
          batteryAfter: latestParsed?.batteryPct ?? null,
          overPressureCount: asInt(raw.overPressureEvents) ?? 0,
          source: 'ble_monitor',
          note: raw.overPressureEvents > 0 ? `过压提醒 ${raw.overPressureEvents} 次` : '',
        }, nowMs);
        raw.ingestedSessionId = inserted.row?.id || null;
        mutated = true;
      }
    }
  }

  if (mutated) {
    writeJsonAtomic(sPath, raw);
  }
  return sanitizeLiveSession(raw);
}

// ---------------------------------------------------------------------------
// Dashboard Builder
// ---------------------------------------------------------------------------

function buildDashboardData(db, dataDir, { limit = 30, nowMs, config, paths = null }) {
  const effectiveCfg = ingestWatchOutbox(db, dataDir, config, paths, nowMs);
  const liveSession = ingestMonitorSessionIfReady(db, dataDir, effectiveCfg, nowMs);
  const device = getDeviceState(db);
  const stats = computeOralCareStats(db, effectiveCfg, device, nowMs);
  const sessions = db.prepare('SELECT * FROM brush_sessions ORDER BY brushed_at DESC LIMIT ?')
    .all(clamp(asInt(limit) ?? 30, 1, 200))
    .map(mapSessionRow);
  const batteryHistory = db.prepare('SELECT id, battery_pct, source, recorded_at FROM battery_logs ORDER BY recorded_at DESC LIMIT 30')
    .all()
    .map(r => ({
      id: r.id,
      batteryPct: Number(r.battery_pct),
      source: r.source,
      recordedAt: Number(r.recorded_at),
    }));

  return {
    generatedAt: nowMs,
    // Top-level scalars for CS80 custom-plugin auto-KPI extraction
    batteryPct: device?.batteryPct ?? null,
    activeMode: device?.activeMode ?? null,
    todayCount: stats.todayCount,
    streakDays: stats.streakDays,
    brushHeadDaysLeft: stats.brushHead.daysLeft,
    device,
    stats,
    sessions,
    batteryHistory,
    liveSession,
    watchStatus: getWatchStatus(dataDir, effectiveCfg, nowMs),
    pendingPatch: readPendingPatch(dataDir),
    presets: Object.values(PRESETS),
    config: redactConfig(effectiveCfg),
  };
}

// ---------------------------------------------------------------------------
// BLE Subprocess Runners (Injectable for tests)
// ---------------------------------------------------------------------------

async function defaultBleRunner(commandArgs, timeoutMs = 35_000, signal) {
  try {
    const { stdout } = await execFileAsync(PYTHON_BIN, [HELPER_PATH, ...commandArgs], {
      cwd: PLUGIN_DIR,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    });
    return JSON.parse(String(stdout || '{}').trim() || '{}');
  } catch (err) {
    const rawOut = String(/** @type {{ stdout?: unknown }} */ (err)?.stdout || '').trim();
    if (rawOut) {
      try {
        return JSON.parse(rawOut);
      } catch {
        // fall through to rethrow
      }
    }
    throw err;
  }
}

function defaultSpawnMonitor(commandArgs) {
  const child = spawn(PYTHON_BIN, [HELPER_PATH, ...commandArgs], {
    cwd: PLUGIN_DIR,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

function disabledBleResult() {
  return {
    ok: false,
    notify: true,
    title: '当前系统已关闭蓝牙牙刷控制',
    message: `徕芬牙刷 BLE 通信依赖 Linux BlueZ D-Bus，在当前平台（${process.platform}）已动态关闭。`,
  };
}

// ---------------------------------------------------------------------------
// Action Handlers
// ---------------------------------------------------------------------------

async function ensureWatchDaemonIfEnabled(ctx, { force = false } = {}) {
  if (!force && !ctx.config.autoWakeSync) {
    return getWatchStatus(ctx.dataDir, ctx.config, ctx.nowMs);
  }
  if (!ctx.hasInjectedSpawnWatch && (process.platform !== 'linux' || ctx.hasInjectedBleRunner)) {
    return getWatchStatus(ctx.dataDir, ctx.config, ctx.nowMs);
  }

  const wPath = watchStatePath(ctx.dataDir);
  const outDir = watchOutboxDir(ctx.dataDir);
  const pPath = pendingPatchPath(ctx.dataDir);
  const lockPath = manualBleLockPath(ctx.dataDir);
  const peerSessionPath = join(ctx.paths.homeDir, 'plugins', 'health-scale', 'live-session.json');
  const targetMac = normalizeMac(ctx.args?.targetMac ?? ctx.config.targetMac ?? DEFAULT_MAC);
  const namePrefix = String(ctx.args?.namePrefix ?? ctx.config.namePrefix ?? DEFAULT_NAME_PREFIX).trim() || DEFAULT_NAME_PREFIX;

  ensurePrivateDir(ctx.dataDir);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });

  await withFileLock(wPath, async () => {
    const existing = existsSync(wPath) ? readJsonSafe(wPath, null) : null;
    if (existing && isWatchProcessAlive(existing)) {
      return;
    }

    writeJsonAtomic(wPath, {
      pid: null,
      phase: 'starting',
      startedAt: ctx.nowMs,
      updatedAt: ctx.nowMs,
      message: '正在启动后台自动唤醒监听…',
      device: existing?.device || null,
      lastSyncedAt: existing?.lastSyncedAt || null,
      lastStatusHex: existing?.lastStatusHex || null,
      lastEventKind: existing?.lastEventKind || null,
      error: null,
    });

    const pid = ctx.spawnWatch([
      'watch',
      '--state-file', wPath,
      '--outbox-dir', outDir,
      '--pending-file', pPath,
      '--yield-lock-file', lockPath,
      '--peer-session-file', peerSessionPath,
      '--target-mac', targetMac,
      '--name-prefix', namePrefix,
    ]);

    for (let i = 0; i < 4; i++) {
      await new Promise(r => setTimeout(r, 40));
      const cur = readJsonSafe(wPath, null);
      if (cur && cur.pid) break;
    }

    const postCur = readJsonSafe(wPath, null);
    if ((!postCur || !postCur.pid) && typeof pid === 'number' && pid > 0) {
      writeJsonAtomic(wPath, {
        ...(postCur && typeof postCur === 'object' ? postCur : {}),
        pid,
        ...(ctx.hasInjectedSpawnWatch ? { stubPid: true } : {}),
        phase: postCur?.phase && postCur.phase !== 'starting' ? postCur.phase : 'watching',
        startedAt: postCur?.startedAt || ctx.nowMs,
        updatedAt: ctx.nowMs,
        message: postCur?.message || '后台自动唤醒监听中：拿起牙刷亮灯即自动同步',
      });
    }
  });

  return getWatchStatus(ctx.dataDir, ctx.config, ctx.nowMs);
}

async function stopWatchDaemon(ctx) {
  const wPath = watchStatePath(ctx.dataDir);
  if (existsSync(wPath)) {
    await withFileLock(wPath, async () => {
      const before = readJsonSafe(wPath, null);
      if (before?.pid) {
        await terminateBleHelperPid(Number(before.pid));
      }
      const latest = readJsonSafe(wPath, before) || before || {};
      writeJsonAtomic(wPath, {
        ...latest,
        pid: null,
        stubPid: false,
        phase: 'stopped',
        message: '后台自动唤醒同步已关闭',
        updatedAt: ctx.nowMs,
      });
    });
  }
  return getWatchStatus(ctx.dataDir, ctx.config, ctx.nowMs);
}

function applyWriteResultToDb(ctx, raw, patch, targetMac, source = 'set') {
  /** @type {Partial<NonNullable<ReturnType<typeof getDeviceState>>>} */
  const prev = getDeviceState(ctx.db) || {};
  const baseParsed = raw.baselineHex ? LaifenProtocol.parsePacket(raw.baselineHex, prev) : null;
  const afterParsed = raw.afterHex ? LaifenProtocol.parsePacket(raw.afterHex, baseParsed || prev) : null;
  const effective = (afterParsed && afterParsed.type === 'status')
    ? afterParsed
    : (baseParsed && baseParsed.type === 'status' ? baseParsed : null);

  // Merge optimistic fields for V2Pro toggles not echoed in status packets
  const mergedModes = effective?.modes ? { ...effective.modes } : { ...(prev.modes || defaultModesTable()) };
  const activeMode = clamp(asInt(patch.mode ?? effective?.activeMode ?? prev.activeMode) ?? 1, 1, 4);
  if (afterParsed?.type !== 'status') {
    const slot = { ...(mergedModes[String(activeMode)] || { strength: 5, range: 5, speed: 5 }) };
    if (patch.strength !== undefined) slot.strength = Number(patch.strength);
    if (patch.range !== undefined) slot.range = Number(patch.range);
    if (patch.speed !== undefined) slot.speed = Number(patch.speed);
    mergedModes[String(activeMode)] = slot;
  }

  const devMac = normalizeMac(raw.device?.address || targetMac || prev.mac);
  if (!ctx.config.targetMac && MAC_RE.test(devMac)) {
    const nextCfg = { ...ctx.config, targetMac: devMac };
    writeConfig(ctx.paths.configPath, nextCfg);
    ctx.config = loadLaifenConfig(ctx.paths.configPath);
  }

  return saveDeviceState(ctx.db, {
    mac: devMac,
    address: devMac,
    name: raw.device?.name || prev.name || 'LFTB',
    rssi: raw.device?.rssi,
    protocol: effective?.protocol || raw.protocol || prev.protocol || 'v1',
    batteryPct: effective?.batteryPct ?? prev.batteryPct,
    activeMode: effective?.activeMode ?? activeMode,
    modes: mergedModes,
    durationSec: effective?.durationSec ?? (patch.durationSec !== undefined ? Number(patch.durationSec) : prev.durationSec),
    highFrequency: patch.highFrequency !== undefined ? Boolean(patch.highFrequency) : (effective?.highFrequency ?? prev.highFrequency),
    reminder30s: patch.reminder30s !== undefined ? Boolean(patch.reminder30s) : (effective?.reminder30s ?? prev.reminder30s),
    airplaneMode: patch.airplaneMode !== undefined ? Boolean(patch.airplaneMode) : (effective?.airplaneMode ?? prev.airplaneMode),
    status: effective?.status ?? prev.status ?? 'Idle',
    features: {
      ...(effective?.features || {}),
      ...(patch.deepClean !== undefined ? { deepClean: Boolean(patch.deepClean) } : {}),
      ...(patch.antiSplash !== undefined ? { antiSplash: Boolean(patch.antiSplash) } : {}),
      ...(patch.powerRampUp !== undefined ? { powerRampUp: Boolean(patch.powerRampUp) } : {}),
      ...(patch.bristleProtection !== undefined ? { bristleProtection: Boolean(patch.bristleProtection) } : {}),
      ...(patch.liftToWake !== undefined ? { liftToWake: Boolean(patch.liftToWake) } : {}),
      ...(patch.overPressure !== undefined ? { overPressure: Boolean(patch.overPressure) } : {}),
      ...(patch.overPressureLevel !== undefined ? { overPressureLevel: String(patch.overPressureLevel) } : {}),
    },
    lastStatusHex: raw.afterHex || raw.baselineHex || prev.lastStatusHex,
    lastInfoHex: raw.infoHex || prev.lastInfoHex,
  }, ctx.nowMs, { source, synced: true });
}

/**
 * Format a user-facing Chinese display name for a Laifen toothbrush without mutating raw BLE/DB names.
 * @param {unknown} rawName
 * @returns {string}
 */
function formatLaifenDisplayName(rawName) {
  const s = typeof rawName === 'string' ? rawName.trim() : '';
  return s && /[\u4e00-\u9fff]/.test(s) ? s : '徕芬电动牙刷';
}

async function handleDashboard(ctx) {
  await ensureWatchDaemonIfEnabled(ctx);
  const data = buildDashboardData(ctx.db, ctx.dataDir, {
    limit: ctx.args.limit,
    nowMs: ctx.nowMs,
    config: ctx.config,
    paths: ctx.paths,
  });
  const dev = data.device;
  const msg = dev
    ? `${formatLaifenDisplayName(dev.name)}：电量 ${dev.batteryPct ?? '--'}%，Mode ${dev.activeMode ?? '--'}（强度 ${dev.activeStrength ?? '--'}/扫幅 ${dev.activeRange ?? '--'}/扫速 ${dev.activeSpeed ?? '--'}），今日打卡 ${data.todayCount}/${data.stats.dailyGoalCount} 次，刷头余 ${data.brushHeadDaysLeft} 天。`
    : `尚未同步徕芬牙刷状态；今日打卡 ${data.todayCount}/${data.stats.dailyGoalCount} 次，刷头余 ${data.brushHeadDaysLeft} 天。`;
  return {
    ok: true,
    notify: false,
    title: '口腔护理看板',
    message: msg,
    data,
  };
}

async function handleStatus(ctx) {
  if (ctx.args.live === true) {
    return handleSync(ctx);
  }
  await ensureWatchDaemonIfEnabled(ctx);
  const dash = buildDashboardData(ctx.db, ctx.dataDir, {
    limit: 10,
    nowMs: ctx.nowMs,
    config: ctx.config,
    paths: ctx.paths,
  });
  const dev = dash.device;
  const bh = dash.stats.brushHead;
  const bhHint = bh.needsReplacement ? `（建议更换刷头，仅余 ${bh.daysLeft} 天）` : `刷头余 ${bh.daysLeft} 天 (${bh.percentLeft}%)`;
  const msg = dev
    ? `${formatLaifenDisplayName(dev.name)}：电量 ${dev.batteryPct ?? '--'}%，当前 Mode ${dev.activeMode}（振动 ${dev.activeStrength} / 扫幅 ${dev.activeRange} / 扫速 ${dev.activeSpeed}），定时 ${dev.durationSec}s，今日刷牙 ${dash.todayCount}/${dash.stats.dailyGoalCount} 次，${bhHint}。`
    : `徕芬牙刷尚未连接同步（${dash.config.targetMac ? `已配置 ${dash.config.targetMac}` : '未绑定 MAC'}）；今日刷牙 ${dash.todayCount}/${dash.stats.dailyGoalCount} 次，${bhHint}。`;

  return {
    ok: true,
    notify: false,
    title: '徕芬牙刷状态',
    message: msg,
    data: {
      batteryPct: dash.batteryPct,
      activeMode: dash.activeMode,
      todayCount: dash.todayCount,
      streakDays: dash.streakDays,
      brushHeadDaysLeft: dash.brushHeadDaysLeft,
      device: dash.device,
      stats: dash.stats,
      liveSession: dash.liveSession,
      watchStatus: dash.watchStatus,
      pendingPatch: dash.pendingPatch,
      config: dash.config,
    },
  };
}

async function handleConfig(ctx) {
  const args = ctx.args;
  const hasUpdates = ['targetMac', 'namePrefix', 'brushHeadLifespanDays', 'brushHeadReplacedAt', 'dailyGoalCount', 'targetDurationSec', 'autoWakeSync']
    .some(k => args[k] !== undefined);

  if (!hasUpdates) {
    const clean = redactConfig(ctx.config);
    return {
      ok: true,
      notify: false,
      title: '牙刷配置',
      message: clean.targetMac
        ? `当前绑定 MAC ${clean.targetMac}（前缀 ${clean.namePrefix}），刷头周期 ${clean.brushHeadLifespanDays} 天，每日目标 ${clean.dailyGoalCount} 次，自动唤醒同步 ${clean.autoWakeSync ? '已开启' : '未开启'}。`
        : `尚未绑定固定 MAC（将按前缀 ${clean.namePrefix} 自动匹配），刷头周期 ${clean.brushHeadLifespanDays} 天，每日目标 ${clean.dailyGoalCount} 次。`,
      data: clean,
    };
  }

  const next = { ...ctx.config };
  if (args.targetMac !== undefined) {
    const mac = normalizeMac(args.targetMac);
    if (mac !== '' && !MAC_RE.test(mac)) {
      return {
        ok: false,
        notify: false,
        title: 'MAC 地址格式无效',
        message: 'targetMac 必须为空或形如 XX:XX:XX:XX:XX:XX 的蓝牙 MAC 地址。',
      };
    }
    next.targetMac = mac;
  }
  if (args.namePrefix !== undefined) {
    const prefix = String(args.namePrefix || '').trim();
    if (!prefix) {
      return { ok: false, notify: false, title: '前缀无效', message: 'namePrefix 不能为空。' };
    }
    next.namePrefix = prefix;
  }
  if (args.brushHeadLifespanDays !== undefined) {
    const days = asInt(args.brushHeadLifespanDays);
    if (days === undefined || days < 15 || days > 365) {
      return { ok: false, notify: false, title: '参数超出范围', message: 'brushHeadLifespanDays 需在 15~365 天之间。' };
    }
    next.brushHeadLifespanDays = days;
  }
  if (args.brushHeadReplacedAt !== undefined) {
    if (args.brushHeadReplacedAt === null || args.brushHeadReplacedAt === '') {
      next.brushHeadReplacedAt = null;
    } else {
      const ts = asInt(args.brushHeadReplacedAt);
      if (ts === undefined || ts <= 0) {
        return { ok: false, notify: false, title: '时间戳无效', message: 'brushHeadReplacedAt 必须为毫秒时间戳或 null。' };
      }
      next.brushHeadReplacedAt = ts;
    }
  }
  if (args.dailyGoalCount !== undefined) {
    const goal = asInt(args.dailyGoalCount);
    if (goal === undefined || goal < 1 || goal > 6) {
      return { ok: false, notify: false, title: '参数超出范围', message: 'dailyGoalCount 需在 1~6 次之间。' };
    }
    next.dailyGoalCount = goal;
  }
  if (args.targetDurationSec !== undefined) {
    const dur = asInt(args.targetDurationSec);
    if (dur === undefined || dur < 60 || dur > 300) {
      return { ok: false, notify: false, title: '参数超出范围', message: 'targetDurationSec 需在 60~300 秒之间。' };
    }
    next.targetDurationSec = Math.round(dur / 30) * 30;
  }
  if (args.autoWakeSync !== undefined) {
    const b = asOptionalBoolean(args.autoWakeSync);
    if (b === undefined) {
      return { ok: false, notify: false, title: '参数无效', message: 'autoWakeSync 必须为布尔值 true/false。' };
    }
    next.autoWakeSync = b;
  }

  writeConfig(ctx.paths.configPath, next);
  const saved = loadLaifenConfig(ctx.paths.configPath);
  ctx.config = saved;
  if (args.autoWakeSync === true) {
    await ensureWatchDaemonIfEnabled(ctx, { force: true });
  } else if (args.autoWakeSync === false) {
    await stopWatchDaemon(ctx);
  }
  return {
    ok: true,
    notify: false,
    title: '牙刷配置已保存',
    message: saved.targetMac
      ? `已保存牙刷配置：绑定 MAC ${saved.targetMac}，刷头周期 ${saved.brushHeadLifespanDays} 天，每日目标 ${saved.dailyGoalCount} 次。`
      : `已保存牙刷配置：按前缀 ${saved.namePrefix} 自动匹配，刷头周期 ${saved.brushHeadLifespanDays} 天。`,
    data: redactConfig(saved),
  };
}

async function handleScan(ctx) {
  if (process.platform !== 'linux' && !ctx.hasInjectedBleRunner && !ctx.hasInjectedSpawnMonitor && !ctx.hasInjectedSpawnWatch) {
    return disabledBleResult();
  }
  const timeoutSec = clamp(asFiniteNumber(ctx.args.timeoutSec ?? ctx.args.timeout) ?? 5, 1, 20);
  const targetMac = normalizeMac(ctx.args.targetMac ?? ctx.config.targetMac ?? DEFAULT_MAC);
  const namePrefix = String(ctx.args.namePrefix ?? ctx.config.namePrefix ?? DEFAULT_NAME_PREFIX).trim() || DEFAULT_NAME_PREFIX;

  const cmdArgs = ['scan', '--timeout', String(timeoutSec), '--target-mac', targetMac, '--name-prefix', namePrefix];
  if (ctx.args.bind === true || Boolean(targetMac)) {
    cmdArgs.push('--stop-on-match');
  }

  const raw = await withManualBleYieldLock(ctx.dataDir, () => ctx.bleRunner(
    cmdArgs,
    (timeoutSec + 6) * 1000,
    ctx.signal,
  ));
  if (!raw || raw.ok === false) {
    return {
      ok: false,
      notify: false,
      title: '蓝牙扫描失败',
      message: raw?.error || '蓝牙扫描未返回有效结果',
    };
  }

  const devices = Array.isArray(raw.devices) ? raw.devices : [];
  let boundMac = ctx.config.targetMac;
  if (ctx.args.bind === true && devices.length > 0 && devices[0]?.address) {
    boundMac = normalizeMac(devices[0].address);
    const updatedCfg = { ...ctx.config, targetMac: boundMac };
    writeConfig(ctx.paths.configPath, updatedCfg);
    saveDeviceState(ctx.db, {
      mac: boundMac,
      address: boundMac,
      name: devices[0].name || '',
      rssi: devices[0].rssi ?? null,
    }, ctx.nowMs, { source: 'scan', synced: false });
  }

  const top = devices[0];
  const msg = devices.length > 0
    ? `发现${formatLaifenDisplayName(top.name)}（${top.address}），信号 ${top.rssi ?? '--'} dBm${ctx.args.bind === true ? `，已绑定 ${boundMac}` : ''}。`
    : '本次未扫到唤醒中的徕芬牙刷（牙刷深度休眠时不广播，请拿起或轻按亮灯后重试）。';

  return {
    ok: true,
    notify: false,
    title: '徕芬扫描完成',
    message: msg,
    data: {
      adapter: raw.adapter || null,
      devices,
      boundMac: boundMac || null,
      scannedAt: raw.scannedAt || ctx.nowMs,
    },
  };
}

async function handleSync(ctx) {
  if (process.platform !== 'linux' && !ctx.hasInjectedBleRunner && !ctx.hasInjectedSpawnMonitor && !ctx.hasInjectedSpawnWatch) {
    return disabledBleResult();
  }
  ctx.config = ingestWatchOutbox(ctx.db, ctx.dataDir, ctx.config, ctx.paths, ctx.nowMs);
  const timeoutSec = clamp(asFiniteNumber(ctx.args.timeoutSec ?? ctx.args.timeout) ?? 25, 3, 60);
  const targetMac = normalizeMac(ctx.args.targetMac ?? ctx.config.targetMac ?? DEFAULT_MAC);
  const namePrefix = String(ctx.args.namePrefix ?? ctx.config.namePrefix ?? DEFAULT_NAME_PREFIX).trim() || DEFAULT_NAME_PREFIX;

  const pending = readPendingPatch(ctx.dataDir);
  const syncSessionId = `sync-${ctx.nowMs}-${randomUUID().slice(0, 6)}`;
  const sPath = sessionFilePath(ctx.dataDir);

  if (pending && pending.patch) {
    const ops = { patch: pending.patch, refreshStatus: true };
    const raw = await withManualBleYieldLock(ctx.dataDir, () => ctx.bleRunner(
      [
        'write',
        '--timeout', String(timeoutSec),
        '--target-mac', targetMac,
        '--name-prefix', namePrefix,
        '--ops-json', JSON.stringify(ops),
        '--state-file', sPath,
        '--session-id', syncSessionId,
      ],
      (timeoutSec + 10) * 1000,
      ctx.signal,
    ));
    if (!raw || raw.ok === false) {
      return {
        ok: false,
        notify: false,
        title: '同步牙刷失败',
        message: raw?.error || '未能连接牙刷下发暂存参数，请拿起或轻按牙刷唤醒后重试。',
      };
    }
    consumePendingPatchIfMatches(ctx.dataDir, pending.patchId);
    const saved = applyWriteResultToDb(ctx, raw, pending.patch, targetMac, 'sync');
    return {
      ok: true,
      notify: false,
      title: '已同步并写入暂存参数',
      message: `已同步${formatLaifenDisplayName(saved.name)}并自动下发暂存设定：电量 ${saved.batteryPct ?? '--'}%，Mode ${saved.activeMode}（振动 ${saved.activeStrength} / 扫幅 ${saved.activeRange} / 扫速 ${saved.activeSpeed}），定时 ${saved.durationSec}s。`,
      data: {
        device: saved,
        statusHex: raw.afterHex || raw.baselineHex || null,
        infoHex: raw.infoHex || null,
        syncedAt: raw.writtenAt || ctx.nowMs,
        appliedPendingPatchId: pending.patchId,
        txLog: raw.txLog || [],
      },
    };
  }

  const raw = await withManualBleYieldLock(ctx.dataDir, () => ctx.bleRunner(
    [
      'sync',
      '--timeout', String(timeoutSec),
      '--target-mac', targetMac,
      '--name-prefix', namePrefix,
      '--state-file', sPath,
      '--session-id', syncSessionId,
    ],
    (timeoutSec + 10) * 1000,
    ctx.signal,
  ));
  if (!raw || raw.ok === false || !raw.statusHex) {
    return {
      ok: false,
      notify: false,
      title: '同步牙刷失败',
      message: raw?.error || '未能连接或读取牙刷状态，请轻按牙刷唤醒后重试。',
    };
  }

  /** @type {Partial<NonNullable<ReturnType<typeof getDeviceState>>>} */
  const prev = getDeviceState(ctx.db) || {};
  const parsed = LaifenProtocol.parsePacket(raw.statusHex, prev);
  if (!parsed || parsed.type !== 'status') {
    return {
      ok: false,
      notify: false,
      title: '解析状态帧失败',
      message: `收到未知状态帧: ${raw.statusHex}`,
    };
  }
  const info = raw.infoHex ? LaifenProtocol.parsePacket(raw.infoHex) : null;
  const devMac = normalizeMac(raw.device?.address || targetMac || prev.mac);

  if (!ctx.config.targetMac && MAC_RE.test(devMac)) {
    writeConfig(ctx.paths.configPath, { ...ctx.config, targetMac: devMac });
  }

  const saved = saveDeviceState(ctx.db, {
    mac: devMac,
    address: devMac,
    name: raw.device?.name || prev.name || 'LFTB',
    rssi: raw.device?.rssi,
    protocol: parsed.protocol,
    batteryPct: parsed.batteryPct,
    activeMode: parsed.activeMode,
    modes: parsed.modes,
    durationSec: parsed.durationSec,
    highFrequency: parsed.highFrequency,
    reminder30s: parsed.reminder30s,
    airplaneMode: parsed.airplaneMode,
    status: parsed.status,
    features: parsed.features,
    lastStatusHex: raw.statusHex,
    lastInfoHex: info?.rawHex || raw.infoHex || prev.lastInfoHex,
  }, ctx.nowMs, { source: 'sync', synced: true });

  return {
    ok: true,
    notify: false,
    title: '牙刷状态已同步',
    message: `已同步${formatLaifenDisplayName(saved.name)}：电量 ${saved.batteryPct ?? '--'}%，Mode ${saved.activeMode}（振动 ${saved.activeStrength} / 扫幅 ${saved.activeRange} / 扫速 ${saved.activeSpeed}），定时 ${saved.durationSec}s。`,
    data: {
      device: saved,
      statusHex: raw.statusHex,
      infoHex: raw.infoHex || null,
      syncedAt: raw.syncedAt || ctx.nowMs,
    },
  };
}

function validateAndBuildSetPatch(args) {
  /** @type {Record<string, unknown>} */
  const patch = {};

  if (args.preset !== undefined && args.preset !== null && args.preset !== '') {
    const key = String(args.preset).trim().toLowerCase();
    const aliasMap = {
      gentle: 'gentle', '柔和': 'gentle', '柔和护龈': 'gentle',
      daily: 'daily', '日常': 'daily', '日常清洁': 'daily',
      strong: 'strong', '强劲': 'strong', '强劲清洁': 'strong',
      whitening: 'whitening', '亮白': 'whitening', '高频亮白': 'whitening', '高频': 'whitening',
    };
    const resolvedKey = aliasMap[key];
    const preset = resolvedKey ? PRESETS[resolvedKey] : undefined;
    if (!preset) {
      return { error: `未知预设方案 "${args.preset}"，可选: gentle / daily / strong / whitening。` };
    }
    patch.mode = preset.mode;
    patch.strength = preset.strength;
    patch.range = preset.range;
    patch.speed = preset.speed;
    patch.highFrequency = preset.highFrequency;
  }

  if (args.mode !== undefined) {
    const m = asInt(args.mode);
    if (m === undefined || m < 1 || m > 4) {
      return { error: 'mode 必须在 1~4 之间。' };
    }
    patch.mode = m;
  }

  if (args.strength !== undefined) {
    const s = asInt(args.strength);
    if (s === undefined || s < 1 || s > 20) {
      return { error: 'strength（振动强度）必须在 1~20 之间（普通模式 1~10，Mode 4 高频 11~20）。' };
    }
    patch.strength = s;
  }

  if (args.range !== undefined) {
    const r = asInt(args.range);
    if (r === undefined || r < 1 || r > 10) {
      return { error: 'range（扫幅）必须在 1~10 之间。' };
    }
    patch.range = r;
  }

  if (args.speed !== undefined) {
    const sp = asInt(args.speed);
    if (sp === undefined || sp < 1 || sp > 10) {
      return { error: 'speed（扫速）必须在 1~10 之间。' };
    }
    patch.speed = sp;
  }

  if (args.durationSec !== undefined) {
    const dur = asInt(args.durationSec);
    if (dur === undefined || dur < 60 || dur > 300) {
      return { error: 'durationSec（刷牙定时）必须在 60~300 秒之间。' };
    }
    patch.durationSec = clamp(Math.round(dur / 30) * 30, 60, 300);
  }

  for (const key of ['highFrequency', 'reminder30s', 'airplaneMode', 'deepClean', 'antiSplash', 'powerRampUp', 'bristleProtection', 'liftToWake', 'overPressure']) {
    if (args[key] !== undefined) {
      const b = asOptionalBoolean(args[key]);
      if (b === undefined) {
        return { error: `${key} 必须为布尔值 true/false。` };
      }
      patch[key] = b;
    }
  }

  if (args.overPressureLevel !== undefined) {
    const raw = String(args.overPressureLevel || '').trim();
    const map = { light: 'Light', medium: 'Medium', hard: 'Hard', '轻': 'Light', '中': 'Medium', '重': 'Hard' };
    const norm = map[raw.toLowerCase()] || (['Light', 'Medium', 'Hard'].includes(raw) ? raw : undefined);
    if (!norm) {
      return { error: 'overPressureLevel 必须为 Light / Medium / Hard。' };
    }
    patch.overPressureLevel = norm;
  }

  if (Object.keys(patch).length === 0) {
    return { error: '未提供任何要修改的参数（支持 mode/strength/range/speed/preset/durationSec/highFrequency/reminder30s/airplaneMode 等）。' };
  }
  return { patch };
}

async function handleSet(ctx) {
  if (process.platform !== 'linux' && !ctx.hasInjectedBleRunner && !ctx.hasInjectedSpawnMonitor && !ctx.hasInjectedSpawnWatch) {
    return disabledBleResult();
  }
  ctx.config = ingestWatchOutbox(ctx.db, ctx.dataDir, ctx.config, ctx.paths, ctx.nowMs);
  const { patch, error } = validateAndBuildSetPatch(ctx.args);
  if (error || !patch) {
    return { ok: false, notify: false, title: '参数无效', message: error || '参数无效' };
  }

  const existingPending = readPendingPatch(ctx.dataDir);
  const mergedPatch = { ...(existingPending?.patch || {}), ...patch };

  if (ctx.args.queueOnly === true) {
    const pendingPatch = writePendingPatch(ctx.dataDir, mergedPatch, ctx.nowMs);
    await ensureWatchDaemonIfEnabled(ctx);
    return {
      ok: true,
      notify: false,
      title: '已暂存待唤醒写入',
      message: '已暂存参数配置；下次拿起牙刷亮灯（或自动唤醒同步）时将自动写入生效。',
      data: {
        queued: true,
        pendingPatch,
        device: getDeviceState(ctx.db),
      },
    };
  }

  const timeoutSec = clamp(asFiniteNumber(ctx.args.timeoutSec ?? ctx.args.timeout) ?? 25, 3, 60);
  const targetMac = normalizeMac(ctx.args.targetMac ?? ctx.config.targetMac ?? DEFAULT_MAC);
  const namePrefix = String(ctx.args.namePrefix ?? ctx.config.namePrefix ?? DEFAULT_NAME_PREFIX).trim() || DEFAULT_NAME_PREFIX;

  const ops = { patch: mergedPatch, refreshStatus: true };
  const writeSessionId = `write-${ctx.nowMs}-${randomUUID().slice(0, 6)}`;
  const sPath = sessionFilePath(ctx.dataDir);

  const raw = await withManualBleYieldLock(ctx.dataDir, () => ctx.bleRunner(
    [
      'write',
      '--timeout', String(timeoutSec),
      '--target-mac', targetMac,
      '--name-prefix', namePrefix,
      '--ops-json', JSON.stringify(ops),
      '--state-file', sPath,
      '--session-id', writeSessionId,
    ],
    (timeoutSec + 10) * 1000,
    ctx.signal,
  ));

  if (!raw || raw.ok === false) {
    const txEmpty = !Array.isArray(raw?.txLog) || raw.txLog.length === 0;
    if ((ctx.args.queueIfAsleep === true || ctx.config.autoWakeSync === true) && txEmpty) {
      const pendingPatch = writePendingPatch(ctx.dataDir, mergedPatch, ctx.nowMs);
      await ensureWatchDaemonIfEnabled(ctx);
      return {
        ok: true,
        notify: false,
        title: '已暂存待唤醒自动写入',
        message: '牙刷当前休眠未在手边，已将参数暂存为「待唤醒同步」；下次拿起牙刷亮灯时将自动写入生效。',
        data: {
          queued: true,
          pendingPatch,
          device: getDeviceState(ctx.db),
          bleError: raw?.error || null,
        },
      };
    }
    return {
      ok: false,
      notify: false,
      title: '写入牙刷失败',
      message: raw?.error || '未能向牙刷写入参数，请确认牙刷已亮灯唤醒。',
    };
  }

  consumePendingPatchIfMatches(ctx.dataDir, existingPending?.patchId);
  const saved = applyWriteResultToDb(ctx, raw, mergedPatch, targetMac, 'set');

  return {
    ok: true,
    notify: false,
    title: '牙刷参数已更新',
    message: `已写入并校验${formatLaifenDisplayName(saved.name)}：Mode ${saved.activeMode}（振动 ${saved.activeStrength} / 扫幅 ${saved.activeRange} / 扫速 ${saved.activeSpeed}），定时 ${saved.durationSec}s，30秒提醒 ${saved.reminder30s ? '开' : '关'}，高频 ${saved.highFrequency ? '开' : '关'}。`,
    data: {
      device: saved,
      patch: mergedPatch,
      txLog: raw.txLog || [],
      baselineHex: raw.baselineHex || null,
      afterHex: raw.afterHex || null,
    },
  };
}

async function handlePower(ctx) {
  if (process.platform !== 'linux' && !ctx.hasInjectedBleRunner && !ctx.hasInjectedSpawnMonitor && !ctx.hasInjectedSpawnWatch) {
    return disabledBleResult();
  }
  const on = asOptionalBoolean(ctx.args.on);
  const cal = typeof ctx.args.calibration === 'string' ? ctx.args.calibration.trim().toLowerCase() : '';
  if (on === undefined && cal !== 'limp' && cal !== 'calibrate') {
    return {
      ok: false,
      notify: false,
      title: '缺少安全操作参数',
      message: 'power 动作必须明确指定 on: true|false 或 calibration: "limp" | "calibrate"。',
    };
  }

  /** @type {Record<string, unknown>} */
  const patch = {};
  if (cal === 'limp' || cal === 'calibrate') {
    patch.calibration = cal;
  } else {
    patch.power = on;
  }
  const timeoutSec = clamp(asFiniteNumber(ctx.args.timeoutSec ?? ctx.args.timeout) ?? 25, 3, 60);
  const targetMac = normalizeMac(ctx.args.targetMac ?? ctx.config.targetMac ?? DEFAULT_MAC);
  const namePrefix = String(ctx.args.namePrefix ?? ctx.config.namePrefix ?? DEFAULT_NAME_PREFIX).trim() || DEFAULT_NAME_PREFIX;

  const ops = {
    patch,
    refreshStatus: cal !== 'limp' && on !== true,
  };
  const writeSessionId = `write-${ctx.nowMs}-${randomUUID().slice(0, 6)}`;
  const sPath = sessionFilePath(ctx.dataDir);

  const raw = await withManualBleYieldLock(ctx.dataDir, () => ctx.bleRunner(
    [
      'write',
      '--timeout', String(timeoutSec),
      '--target-mac', targetMac,
      '--name-prefix', namePrefix,
      '--ops-json', JSON.stringify(ops),
      '--state-file', sPath,
      '--session-id', writeSessionId,
    ],
    (timeoutSec + 10) * 1000,
    ctx.signal,
  ));
  if (!raw || raw.ok === false) {
    return {
      ok: false,
      notify: false,
      title: '牙刷电源/校准控制失败',
      message: raw?.error || '未能向牙刷下发指令，请确认牙刷已唤醒。',
    };
  }

  /** @type {Partial<NonNullable<ReturnType<typeof getDeviceState>>>} */
  const prev = getDeviceState(ctx.db) || {};
  const parsed = raw.afterHex ? LaifenProtocol.parsePacket(raw.afterHex, prev) : null;
  const saved = saveDeviceState(ctx.db, {
    mac: normalizeMac(raw.device?.address || targetMac || prev.mac),
    name: raw.device?.name || prev.name,
    protocol: parsed?.protocol || raw.protocol || prev.protocol || 'v1',
    status: on !== undefined ? (on ? 'Running' : 'Idle') : (parsed?.status || prev.status || 'Idle'),
    batteryPct: parsed?.batteryPct ?? prev.batteryPct,
    activeMode: parsed?.activeMode ?? prev.activeMode,
    modes: parsed?.modes ?? prev.modes,
    lastStatusHex: raw.afterHex || raw.baselineHex || prev.lastStatusHex,
  }, ctx.nowMs, { source: 'power', synced: true });

  const actionDesc = cal === 'limp'
    ? '已进入松弛对准状态（请对齐刷头与机身标志）'
    : (cal === 'calibrate'
      ? '已完成刷头零位校准'
      : (on ? '已启动牙刷电机' : '已停止牙刷电机'));

  return {
    ok: true,
    notify: false,
    title: '牙刷动作已执行',
    message: `${formatLaifenDisplayName(saved.name)} ${actionDesc}。`,
    data: {
      device: saved,
      patch,
      txLog: raw.txLog || [],
    },
  };
}

async function handleWatchStart(ctx) {
  if (process.platform !== 'linux' && !ctx.hasInjectedBleRunner && !ctx.hasInjectedSpawnMonitor && !ctx.hasInjectedSpawnWatch) {
    return disabledBleResult();
  }
  const next = { ...ctx.config, autoWakeSync: true };
  writeConfig(ctx.paths.configPath, next);
  ctx.config = loadLaifenConfig(ctx.paths.configPath);
  const watchStatus = await ensureWatchDaemonIfEnabled(ctx, { force: true });
  const dashboard = buildDashboardData(ctx.db, ctx.dataDir, {
    limit: 30,
    nowMs: ctx.nowMs,
    config: ctx.config,
    paths: ctx.paths,
  });
  return {
    ok: true,
    notify: false,
    title: '已开启后台自动唤醒同步',
    message: '后台自动唤醒守护已开启：平时拿起牙刷亮灯或开始刷牙，主机将自动同步电量、下发暂存设定并记录打卡。',
    data: { watchStatus, dashboard },
  };
}

async function handleWatchStop(ctx) {
  if (process.platform !== 'linux' && !ctx.hasInjectedBleRunner && !ctx.hasInjectedSpawnMonitor && !ctx.hasInjectedSpawnWatch) {
    return disabledBleResult();
  }
  const next = { ...ctx.config, autoWakeSync: false };
  writeConfig(ctx.paths.configPath, next);
  ctx.config = loadLaifenConfig(ctx.paths.configPath);
  const watchStatus = await stopWatchDaemon(ctx);
  const dashboard = buildDashboardData(ctx.db, ctx.dataDir, {
    limit: 30,
    nowMs: ctx.nowMs,
    config: ctx.config,
    paths: ctx.paths,
  });
  return {
    ok: true,
    notify: false,
    title: '已关闭后台自动唤醒同步',
    message: '已停止后台自动唤醒监听并释放蓝牙适配器。',
    data: { watchStatus, dashboard },
  };
}

function handlePendingClear(ctx) {
  const removed = consumePendingPatchIfMatches(ctx.dataDir);
  const dashboard = buildDashboardData(ctx.db, ctx.dataDir, {
    limit: 30,
    nowMs: ctx.nowMs,
    config: ctx.config,
    paths: ctx.paths,
  });
  return {
    ok: true,
    notify: false,
    title: removed ? '已撤销暂存参数' : '无待同步暂存参数',
    message: removed ? '已清空待唤醒写入的参数队列。' : '当前没有待写入的暂存参数。',
    data: { cleared: removed, dashboard },
  };
}

function acquireSessionLockFile(dataDir) {
  ensurePrivateDir(dataDir);
  const lockPath = join(dataDir, 'live-session.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // ignore
        }
      };
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'EEXIST') throw err;
      const meta = readJsonSafe(lockPath, null);
      const holderPid = Number(meta?.pid);
      const stale = !holderPid || !isPidAlive(holderPid) || (Date.now() - Number(meta?.at || 0) > 15_000);
      if (stale && attempt === 0) {
        try {
          unlinkSync(lockPath);
        } catch {
          // ignore
        }
        continue;
      }
      return null;
    }
  }
  return null;
}

async function handleMonitorStart(ctx) {
  if (process.platform !== 'linux' && !ctx.hasInjectedBleRunner && !ctx.hasInjectedSpawnMonitor && !ctx.hasInjectedSpawnWatch) {
    return disabledBleResult();
  }
  const timeoutSec = clamp(asFiniteNumber(ctx.args.timeoutSec ?? ctx.args.timeout) ?? 180, 15, 600);
  const targetMac = normalizeMac(ctx.args.targetMac ?? ctx.config.targetMac ?? DEFAULT_MAC);
  const namePrefix = String(ctx.args.namePrefix ?? ctx.config.namePrefix ?? DEFAULT_NAME_PREFIX).trim() || DEFAULT_NAME_PREFIX;
  const sPath = sessionFilePath(ctx.dataDir);

  return withFileLock(sPath, async () => {
    const releaseLock = acquireSessionLockFile(ctx.dataDir);
    if (!releaseLock) {
      return {
        ok: false,
        notify: false,
        title: '蓝牙监听启动繁忙',
        message: '已有另一路刷牙监听会话正在初始化，请稍后重试或先执行 monitor-stop。',
      };
    }

    try {
      if (existsSync(sPath)) {
        const existing = readJsonSafe(sPath, null);
        if (existing?.pid) {
          await terminateBleHelperPid(Number(existing.pid));
        }
      }

      const sessionId = `brush-${ctx.nowMs}-${randomUUID().slice(0, 6)}`;
      const initialSession = {
        sessionId,
        pid: null,
        phase: 'scanning',
        startedAt: ctx.nowMs,
        updatedAt: ctx.nowMs,
        timeoutSec,
        message: '正在启动刷牙监听会话，请拿起或启动牙刷…',
        device: null,
        firstStatusHex: null,
        latestStatusHex: null,
        infoHex: null,
        runningStartedAt: null,
        activeBrushingSec: 0,
        overPressureEvents: 0,
        notifications: [],
        error: null,
      };
      writeJsonAtomic(sPath, initialSession);

      const pid = ctx.spawnMonitor([
        'monitor',
        '--state-file', sPath,
        '--session-id', sessionId,
        '--timeout', String(timeoutSec),
        '--target-mac', targetMac,
        '--name-prefix', namePrefix,
      ]);

      for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 40));
        const cur = readJsonSafe(sPath, null);
        if (cur && cur.sessionId === sessionId && cur.pid) break;
      }

      const postCur = readJsonSafe(sPath, null);
      if (postCur && postCur.sessionId === sessionId && !postCur.pid && typeof pid === 'number' && pid > 0) {
        writeJsonAtomic(sPath, { ...postCur, pid });
      }

      const session = ingestMonitorSessionIfReady(ctx.db, ctx.dataDir, ctx.config, ctx.nowMs)
        || sanitizeLiveSession({ ...initialSession, pid });

      return {
        ok: true,
        notify: false,
        title: '已启动刷牙监听',
        message: `徕芬牙刷监听已就绪（${timeoutSec} 秒有效），刷牙结束后将自动记录时长与电量。`,
        data: { session },
      };
    } finally {
      releaseLock();
    }
  });
}

function handleMonitorStatus(ctx) {
  const session = ingestMonitorSessionIfReady(ctx.db, ctx.dataDir, ctx.config, ctx.nowMs);
  const dashboard = buildDashboardData(ctx.db, ctx.dataDir, {
    limit: 15,
    nowMs: ctx.nowMs,
    config: ctx.config,
    paths: ctx.paths,
  });
  if (!session) {
    return {
      ok: true,
      notify: false,
      title: '无进行中的监听',
      message: '当前没有运行中的刷牙监听会话。',
      data: { session: null, dashboard },
    };
  }
  return {
    ok: true,
    notify: false,
    title: session.phase === 'completed' ? '刷牙监听已完成' : '刷牙监听状态',
    message: session.message || `监听状态: ${session.phase}`,
    data: { session, dashboard },
  };
}

async function handleMonitorStop(ctx) {
  if (process.platform !== 'linux' && !ctx.hasInjectedBleRunner && !ctx.hasInjectedSpawnMonitor && !ctx.hasInjectedSpawnWatch) {
    return disabledBleResult();
  }
  const sPath = sessionFilePath(ctx.dataDir);
  if (existsSync(sPath)) {
    await withFileLock(sPath, async () => {
      const before = readJsonSafe(sPath, null);
      if (before?.pid) {
        await terminateBleHelperPid(Number(before.pid));
      }
      const latest = readJsonSafe(sPath, before) || before;
      if (latest && ['scanning', 'connecting', 'monitoring'].includes(latest.phase)) {
        latest.phase = 'stopped';
        latest.message = '已手动停止等待';
        latest.updatedAt = ctx.nowMs;
        writeJsonAtomic(sPath, latest);
      }
    });
  }
  const session = ingestMonitorSessionIfReady(ctx.db, ctx.dataDir, ctx.config, ctx.nowMs);
  const dashboard = buildDashboardData(ctx.db, ctx.dataDir, {
    limit: 15,
    nowMs: ctx.nowMs,
    config: ctx.config,
    paths: ctx.paths,
  });
  return {
    ok: true,
    notify: false,
    title: '已停止等待',
    message: session ? `蓝牙等待已停止（${session.message}）。` : '蓝牙监听已停止。',
    data: { session, dashboard },
  };
}

function handleSessionAdd(ctx) {
  const args = ctx.args;
  const durationSec = clamp(asInt(args.durationSec) ?? ctx.config.targetDurationSec ?? 180, 10, 1800);
  const dev = getDeviceState(ctx.db);
  const mode = args.mode !== undefined ? clamp(asInt(args.mode) ?? 1, 1, 4) : (dev?.activeMode ?? 1);
  let brushedAt = ctx.nowMs;
  if (args.brushedAt !== undefined && args.brushedAt !== null && args.brushedAt !== '') {
    const numTs = asInt(args.brushedAt);
    const parsedTs = numTs !== undefined ? numTs : Date.parse(String(args.brushedAt));
    if (!Number.isFinite(parsedTs) || parsedTs <= 0) {
      return { ok: false, notify: false, title: '时间格式无效', message: 'brushedAt 时间格式无法识别。' };
    }
    brushedAt = Math.trunc(parsedTs);
  }
  const slot = dev?.modes?.[String(mode)] || {};
  const res = insertBrushSession(ctx.db, {
    mac: ctx.config.targetMac || dev?.mac || '',
    brushedAt,
    durationSec,
    mode,
    strength: asInt(args.strength) ?? slot.strength ?? dev?.activeStrength ?? null,
    range: asInt(args.range) ?? slot.range ?? dev?.activeRange ?? null,
    speed: asInt(args.speed) ?? slot.speed ?? dev?.activeSpeed ?? null,
    overPressureCount: asInt(args.overPressureCount) ?? 0,
    source: 'manual',
    note: String(args.note || '手动打卡').slice(0, 120),
  }, ctx.nowMs);

  const dash = buildDashboardData(ctx.db, ctx.dataDir, {
    limit: 20,
    nowMs: ctx.nowMs,
    config: ctx.config,
    paths: ctx.paths,
  });

  return {
    ok: true,
    notify: false,
    title: '刷牙记录已保存',
    message: `已记录本次刷牙（${durationSec} 秒，Mode ${mode}），今日已完成 ${dash.todayCount}/${dash.stats.dailyGoalCount} 次，连续打卡 ${dash.streakDays} 天。`,
    data: { session: res.row, dashboard: dash },
  };
}

function handleSessionDelete(ctx) {
  const id = String(ctx.args.id || '').trim();
  if (!id) {
    return { ok: false, notify: false, title: '缺少记录 ID', message: '请提供要删除的刷牙记录 id。' };
  }
  const info = ctx.db.prepare('DELETE FROM brush_sessions WHERE id = ?').run(id);
  if (!info || info.changes === 0) {
    return { ok: false, notify: false, title: '未找到记录', message: `未找到刷牙记录 ${id}。` };
  }
  const dash = buildDashboardData(ctx.db, ctx.dataDir, {
    limit: 20,
    nowMs: ctx.nowMs,
    config: ctx.config,
    paths: ctx.paths,
  });
  return {
    ok: true,
    notify: false,
    title: '刷牙记录已删除',
    message: `已删除记录 ${id}。`,
    data: { deletedId: id, dashboard: dash },
  };
}

function handleBrushheadReset(ctx) {
  let replacedAt = ctx.nowMs;
  if (ctx.args.replacedAt !== undefined && ctx.args.replacedAt !== null && ctx.args.replacedAt !== '') {
    const ts = asInt(ctx.args.replacedAt);
    if (ts === undefined || ts <= 0) {
      return { ok: false, notify: false, title: '时间戳无效', message: 'replacedAt 必须为有效的毫秒时间戳。' };
    }
    replacedAt = ts;
  }
  const next = { ...ctx.config, brushHeadReplacedAt: replacedAt };
  writeConfig(ctx.paths.configPath, next);
  const savedCfg = loadLaifenConfig(ctx.paths.configPath);
  const dash = buildDashboardData(ctx.db, ctx.dataDir, {
    limit: 15,
    nowMs: ctx.nowMs,
    config: savedCfg,
    paths: ctx.paths,
  });
  return {
    ok: true,
    notify: false,
    title: '刷头寿命已重置',
    message: `已记录更换新刷头，寿命周期重置为 ${savedCfg.brushHeadLifespanDays} 天（剩余 100%）。`,
    data: {
      brushHead: dash.stats.brushHead,
      config: dash.config,
    },
  };
}

// ---------------------------------------------------------------------------
// Public Entrypoints (`runAction` & `handleVoiceFastpath`)
// ---------------------------------------------------------------------------

/**
 * Execute a `laifen` plugin action.
 * @param {string} action
 * @param {Record<string, unknown>} [args]
 * @param {import('../_shared/types.d.ts').PluginExecutionContext & {
 *   bleRunner?: (args: string[], timeoutMs?: number, signal?: AbortSignal) => Promise<any>;
 *   spawnMonitor?: (args: string[]) => number | undefined;
 *   spawnWatch?: (args: string[]) => number | undefined;
 *   nowFn?: () => number;
 * }} [deps]
 */
export async function runAction(action, args = {}, deps = {}) {
  const cleanAction = String(action || 'status').trim() || 'status';
  if (!ACTIONS.includes(cleanAction)) {
    return {
      ok: false,
      notify: false,
      title: '未知动作',
      message: `laifen 插件不支持动作 "${cleanAction}"。可选: ${ACTIONS.join(', ')}`,
    };
  }

  const nowFn = typeof deps?.nowFn === 'function' ? deps.nowFn : Date.now;
  const nowMs = nowFn();
  // Security: NEVER honor args.dataDir or args.pluginDataDir; always resolve via deps/context.
  const paths = resolveLaifenPaths({}, deps);
  ensurePrivateDir(paths.pluginDataDir);
  const config = loadLaifenConfig(paths.configPath);
  const db = openDb(paths);

  const ctx = {
    action: cleanAction,
    args: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {},
    deps,
    paths,
    dataDir: paths.pluginDataDir,
    config,
    db,
    nowMs,
    signal: deps?.signal,
    hasInjectedBleRunner: typeof deps?.bleRunner === 'function',
    hasInjectedSpawnMonitor: typeof deps?.spawnMonitor === 'function',
    hasInjectedSpawnWatch: typeof deps?.spawnWatch === 'function',
    bleRunner: typeof deps?.bleRunner === 'function' ? deps.bleRunner : defaultBleRunner,
    spawnMonitor: typeof deps?.spawnMonitor === 'function' ? deps.spawnMonitor : defaultSpawnMonitor,
    spawnWatch: typeof deps?.spawnWatch === 'function' ? deps.spawnWatch : defaultSpawnMonitor,
  };

  try {
    switch (cleanAction) {
      case 'dashboard':
        return await handleDashboard(ctx);
      case 'status':
        return await handleStatus(ctx);
      case 'config':
        return await handleConfig(ctx);
      case 'scan':
        return await handleScan(ctx);
      case 'sync':
        return await handleSync(ctx);
      case 'set':
        return await handleSet(ctx);
      case 'power':
        return await handlePower(ctx);
      case 'monitor-start':
        return await handleMonitorStart(ctx);
      case 'monitor-status':
        return handleMonitorStatus(ctx);
      case 'monitor-stop':
        return await handleMonitorStop(ctx);
      case 'watch-start':
        return await handleWatchStart(ctx);
      case 'watch-stop':
        return await handleWatchStop(ctx);
      case 'pending-clear':
        return handlePendingClear(ctx);
      case 'session-add':
        return handleSessionAdd(ctx);
      case 'session-delete':
        return handleSessionDelete(ctx);
      case 'brushhead-reset':
        return handleBrushheadReset(ctx);
      default:
        return { ok: false, notify: false, title: '未知动作', message: `不支持动作 ${cleanAction}` };
    }
  } catch (err) {
    return {
      ok: false,
      notify: false,
      title: `laifen ${cleanAction} 执行异常`,
      message: errMsg(err),
    };
  } finally {
    try {
      db.close();
    } catch {
      // ignore close error
    }
  }
}

const LAIFEN_TRIGGER_RE = /(牙刷|徕芬|莱芬|刷头|刷牙|刷了几次牙|我刷完?牙了|手动打卡)/;
const LAIFEN_REMINDER_EXCLUSION_RE = /(提醒我|定个?闹钟|设个?提醒|定时器)/;
const LAIFEN_RESET_HEAD_RE = /(换了?新?刷头|重置刷头|刷头已更换|更新刷头)/;
const LAIFEN_MANUAL_CHECKIN_RE = /(手动打卡|刷牙打卡|补录刷牙|记一?次刷牙|我刷完?牙了)/;
const LAIFEN_MONITOR_STOP_RE = /(停止|结束|取消).*(刷牙监听|牙刷监听|监听)/;
const LAIFEN_MONITOR_START_RE = /(开始|启动|打开).*(刷牙监听|牙刷监听|监听刷牙)/;
const LAIFEN_SYNC_RE = /(同步|刷新|连接|读取).*(牙刷|徕芬|莱芬)/;
const LAIFEN_HEAD_QUERY_RE = /(刷头|换刷头).*(多久|几天|寿命|还剩|状态|能用|要换)/;
const LAIFEN_TODAY_QUERY_RE = /(今天|今日|最近).*(刷牙|打卡|刷了几次|刷牙了吗)/;
const LAIFEN_STATUS_QUERY_RE = /(电量|多少电|还有电|档位|模式|状态|情况|怎么样|几档)/;
const LAIFEN_MODE_SET_RE = /(切|调|设|改|换).*(?:模式|档|柔和|日常|强劲|高频)/;

/**
 * XiaoAI / IM voice fastpath handler for Laifen toothbrush.
 * @param {import('../_shared/types.d.ts').VoiceFastpathRequest} request
 * @param {import('../_shared/types.d.ts').PluginExecutionContext} [context]
 * @returns {Promise<import('../_shared/types.d.ts').VoiceFastpathResult>}
 */
export async function handleVoiceFastpath(request, context = {}) {
  const text = String(request?.text || '').trim();
  if (!text || !LAIFEN_TRIGGER_RE.test(text) || LAIFEN_REMINDER_EXCLUSION_RE.test(text)) {
    return { handled: false };
  }

  if (LAIFEN_RESET_HEAD_RE.test(text)) {
    const res = await runAction('brushhead-reset', {}, context);
    return {
      handled: true,
      plugin: 'laifen',
      action: 'brushhead-reset',
      ok: Boolean(res.ok),
      speech: res.ok ? '好的，已为你重置新刷头周期，今天起按90天重新计时。' : (res.message || '重置刷头失败。'),
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }

  if (LAIFEN_MANUAL_CHECKIN_RE.test(text)) {
    const res = await runAction('session-add', { note: '语音打卡' }, context);
    const dash = res.data?.dashboard;
    return {
      handled: true,
      plugin: 'laifen',
      action: 'session-add',
      ok: Boolean(res.ok),
      speech: res.ok
        ? `已记下这次刷牙，今天已完成 ${dash?.todayCount ?? 1} 次，连续打卡 ${dash?.streakDays ?? 1} 天。`
        : (res.message || '刷牙打卡失败。'),
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }

  if (LAIFEN_MONITOR_STOP_RE.test(text)) {
    const res = await runAction('monitor-stop', {}, context);
    return {
      handled: true,
      plugin: 'laifen',
      action: 'monitor-stop',
      ok: Boolean(res.ok),
      speech: res.ok ? '好的，已停止刷牙监听。' : (res.message || '停止监听失败。'),
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }

  if (LAIFEN_MONITOR_START_RE.test(text)) {
    const res = await runAction('monitor-start', {}, context);
    return {
      handled: true,
      plugin: 'laifen',
      action: 'monitor-start',
      ok: Boolean(res.ok),
      speech: res.ok ? '好，刷牙监听已启动，拿起牙刷开始刷牙就会自动记录。' : (res.message || '启动刷牙监听失败。'),
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }

  if (LAIFEN_MODE_SET_RE.test(text)) {
    /** @type {Record<string, unknown>} */
    const setArgs = {};
    if (/柔和/.test(text)) setArgs.preset = 'gentle';
    else if (/日常/.test(text)) setArgs.preset = 'daily';
    else if (/强劲/.test(text)) setArgs.preset = 'strong';
    else if (/亮白|高频/.test(text)) setArgs.preset = 'whitening';
    else {
      const m = text.match(/([1-4一二三四])\s*(?:档|模式)|(?:模式|档位?)\s*([1-4一二三四])/);
      const digitMap = { '1': 1, '2': 2, '3': 3, '4': 4, '一': 1, '二': 2, '三': 3, '四': 4 };
      const picked = m ? digitMap[m[1] || m[2]] : undefined;
      if (picked) setArgs.mode = picked;
    }
    if (Object.keys(setArgs).length > 0) {
      const res = await runAction('set', setArgs, context);
      const dev = res.data?.device;
      return {
        handled: true,
        plugin: 'laifen',
        action: 'set',
        ok: Boolean(res.ok),
        speech: res.ok
          ? `已把牙刷切到 ${dev?.activeMode ?? setArgs.mode ?? ''} 档。`
          : (res.message || '切换牙刷档位失败，请先唤醒牙刷再试。'),
        followUp: false,
        clearSessionState: true,
        data: res.data,
      };
    }
  }

  if (LAIFEN_SYNC_RE.test(text)) {
    const res = await runAction('sync', {}, context);
    const dev = res.data?.device;
    return {
      handled: true,
      plugin: 'laifen',
      action: 'sync',
      ok: Boolean(res.ok),
      speech: res.ok
        ? `牙刷已同步，当前电量百分之 ${dev?.batteryPct ?? '--'}，在 Mode ${dev?.activeMode ?? '--'}。`
        : (res.message || '没能连上牙刷，请先按亮牙刷再试。'),
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }

  if (LAIFEN_HEAD_QUERY_RE.test(text)) {
    const res = await runAction('status', {}, context);
    const bh = res.data?.stats?.brushHead;
    const speech = bh
      ? (bh.needsReplacement
          ? `牙刷刷头只剩 ${bh.daysLeft} 天寿命了，建议尽快更换。`
          : `刷头已用 ${bh.daysUsed} 天，还能用 ${bh.daysLeft} 天，剩余寿命百分之 ${bh.percentLeft}。`)
      : (res.message || '暂无刷头记录。');
    return {
      handled: true,
      plugin: 'laifen',
      action: 'status',
      ok: Boolean(res.ok),
      speech,
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }

  if (LAIFEN_TODAY_QUERY_RE.test(text)) {
    const res = await runAction('status', {}, context);
    const st = res.data?.stats;
    const speech = st
      ? `今天已经刷牙 ${st.todayCount} 次，每日目标 ${st.dailyGoalCount} 次，目前连续打卡 ${st.streakDays} 天。`
      : (res.message || '暂无刷牙统计。');
    return {
      handled: true,
      plugin: 'laifen',
      action: 'status',
      ok: Boolean(res.ok),
      speech,
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }

  if (LAIFEN_STATUS_QUERY_RE.test(text)) {
    const res = await runAction('status', {}, context);
    const dev = res.data?.device;
    const bh = res.data?.stats?.brushHead;
    const speech = dev
      ? `徕芬牙刷剩余电量百分之 ${dev.batteryPct ?? '--'}，当前在 Mode ${dev.activeMode}，定时 ${dev.durationSec} 秒，刷头还能用 ${bh?.daysLeft ?? '--'} 天。`
      : '牙刷还没有连接同步过，拿起牙刷按亮后让我同步一下就行。';
    return {
      handled: true,
      plugin: 'laifen',
      action: 'status',
      ok: Boolean(res.ok),
      speech,
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }

  return { handled: false };
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

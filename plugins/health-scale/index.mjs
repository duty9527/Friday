#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
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

export const DEFAULT_SCALE_MAC = '';
export const DEFAULT_NAME_PREFIX = 'AFU-WL';
export const EXPECTED_SUBTYPE = 7;

export const PACKET_WEIGHT = 213;
export const PACKET_ADC = 214;
export const PACKET_HISTORY = 216;
export const PACKET_SETTING = 223;

export const ACTIONS = [
  'dashboard',
  'status',
  'config',
  'scan',
  'measure-start',
  'measure-status',
  'measure-stop',
  'profile-save',
  'profile-delete',
  'record-add',
  'record-delete',
];

const DEFAULT_CONFIG = {
  targetMac: '',
  namePrefix: DEFAULT_NAME_PREFIX,
  defaultProfile: null,
};

function roundTo(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

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

function normalizeMac(mac) {
  return String(mac || '').trim().toUpperCase();
}

function getBit(value, bit) {
  return (value & (1 << bit)) !== 0 ? 1 : 0;
}

function setBit(value, bit) {
  return value | (1 << bit);
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

function normalizeSexInput(rawSex) {
  if (rawSex === undefined || rawSex === null) return undefined;
  const norm = String(rawSex).trim().toLowerCase();
  if (!norm) return undefined;
  if (['male', 'm', 'man', '男', '1'].includes(norm)) return 'male';
  if (['female', 'f', 'woman', '女', '2'].includes(norm)) return 'female';
  return undefined;
}

function normalizeDefaultProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const name = String(raw.name || '').trim();
  const sex = normalizeSexInput(raw.sex);
  const age = asInt(raw.age);
  const heightCm = asFiniteNumber(raw.heightCm ?? raw.height);
  const targetRaw = raw.targetWeightKg;
  const targetWeightKg =
    targetRaw === undefined || targetRaw === null || targetRaw === ''
      ? null
      : asFiniteNumber(targetRaw);
  const unitRaw = String(raw.unit || 'kg').trim().toLowerCase();
  const unit = unitRaw === 'jin' || unitRaw === '斤' ? 'jin' : 'kg';
  const id = String(raw.id || 'owner').trim() || 'owner';

  if (!name || !sex || age === undefined || age < 5 || age > 120 || heightCm === undefined || heightCm < 80 || heightCm > 230) {
    return null;
  }
  if (targetWeightKg !== null && (targetWeightKg < 20 || targetWeightKg > 250)) {
    return null;
  }
  return { id, name, sex, age, heightCm, targetWeightKg, unit };
}

function loadScaleConfig(configPath) {
  const raw = readConfig(configPath, DEFAULT_CONFIG);
  return {
    targetMac: normalizeMac(raw.targetMac || ''),
    namePrefix: String(raw.namePrefix || DEFAULT_NAME_PREFIX).trim() || DEFAULT_NAME_PREFIX,
    defaultProfile: normalizeDefaultProfile(raw.defaultProfile),
  };
}

function resolveScalePaths(_args = {}, deps = {}) {
  return resolvePluginPaths('health-scale', deps);
}

const INITIALIZED_DB_PATHS = new Set();

function openDb(paths, nowMs, config) {
  ensurePrivateDir(paths.pluginDataDir);
  const dbPath = join(paths.pluginDataDir, 'health.db');
  const dbExistsBeforeOpen = existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
  `);

  if (!dbExistsBeforeOpen || !INITIALIZED_DB_PATHS.has(dbPath)) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sex TEXT NOT NULL,
        age INTEGER NOT NULL,
        height_cm REAL NOT NULL,
        target_weight_kg REAL,
        unit TEXT NOT NULL DEFAULT 'kg',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        mac TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        name TEXT NOT NULL,
        rssi INTEGER,
        battery INTEGER,
        charging INTEGER,
        protocol_ver INTEGER,
        device_subtype INTEGER,
        model TEXT,
        hardware_ver TEXT,
        software_ver TEXT,
        manufacturer TEXT,
        support_funs_json TEXT,
        raw_adv_json TEXT,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS measurements (
        id TEXT PRIMARY KEY,
        dedup_key TEXT UNIQUE,
        profile_id TEXT NOT NULL,
        measured_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        device_mac TEXT,
        weight_kg REAL NOT NULL,
        weight_jin REAL NOT NULL,
        weight_lb REAL NOT NULL,
        weight_g INTEGER NOT NULL,
        stable INTEGER NOT NULL DEFAULT 1,
        impedance_measured INTEGER NOT NULL DEFAULT 0,
        adcs_json TEXT,
        impedances_json TEXT,
        primary_ohm REAL,
        secondary_ohm REAL,
        alg_type INTEGER,
        heart_rate INTEGER,
        battery INTEGER,
        charging INTEGER,
        rssi INTEGER,
        calibration_mode INTEGER,
        over_weight INTEGER,
        dianji INTEGER,
        raw_meta_json TEXT,
        note TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_measurements_profile_time
        ON measurements(profile_id, measured_at DESC);
    `);

    const profileCount = db.prepare('SELECT COUNT(*) AS cnt FROM profiles').get().cnt;
    if (profileCount === 0 && config?.defaultProfile) {
      const dp = config.defaultProfile;
      db.prepare(`
        INSERT INTO profiles (id, name, sex, age, height_cm, target_weight_kg, unit, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(dp.id, dp.name, dp.sex, dp.age, dp.heightCm, dp.targetWeightKg, dp.unit, nowMs, nowMs);
    }

    INITIALIZED_DB_PATHS.add(dbPath);
  }

  return { db, dbPath };
}

// ---------------------------------------------------------------------------
// Scale27 BLE Protocol & Advertisement Parser
// ---------------------------------------------------------------------------

function getIntTrunc(value) {
  return Math.trunc(value * 10.0) % 10 >= 9 ? Math.trunc(value + 1.0) : Math.trunc(value);
}

function gUnitGeneral(value, division, precision) {
  if (division === 0) {
    const scaled = Math.trunc((getIntTrunc(value * 1000.0) + 5) / 10.0);
    return scaled / 100.0;
  }
  if (division === 1) {
    let raw = getIntTrunc(value * 1000.0);
    if (raw % 10 === 9) raw += 10;
    let scaled = Math.trunc(raw / 10.0);
    if (scaled % 2) scaled += 1;
    return scaled / 100.0;
  }
  if (division === 2) {
    const raw = Math.trunc((getIntTrunc(value * 1000.0) + 20) / 10.0);
    const scaled = raw % 10 >= 5 ? Math.floor(raw / 10) * 10 + 5 : Math.floor(raw / 10) * 10;
    return scaled / 100.0;
  }
  if (division === 3) {
    const scaled = Math.trunc((getIntTrunc(value * 100.0) + 5) / 10.0);
    return scaled / 10.0;
  }
  if (division === 4) {
    let raw = getIntTrunc(value * 100.0);
    if (raw % 10 === 9) raw += 10;
    let scaled = Math.trunc(raw / 10.0);
    if (scaled % 2) scaled += 1;
    return scaled / 10.0;
  }
  return roundTo(value, precision);
}

export function g2kgGeneral(grams, division, precision) {
  return gUnitGeneral(Number(grams) / 1000.0, division, precision);
}

export function g2lbGeneral(grams, division, precision) {
  return gUnitGeneral(Number(grams) * 0.0022046, division, precision);
}

function float2int(value, precision) {
  const factor = 10 ** (precision + 1);
  let scaled = Math.trunc(value * factor);
  if (value * factor - scaled >= 0.8) {
    scaled += 10;
  }
  return Math.floor(scaled / 10);
}

function decodeWeightFields(encoded) {
  const u = encoded >>> 0;
  const grams = u & 0x3ffff;
  const kgDivision = (u & 0x1c0000) >>> 18;
  const lbDivision = (u & 0xe00000) >>> 21;
  const precisionKg = [0, 1, 2].includes(kgDivision) ? 2 : 1;
  const precisionLb = [0, 1, 2].includes(lbDivision) ? 2 : 1;
  const weightKg = g2kgGeneral(grams, kgDivision, precisionKg);
  const weightLb = g2lbGeneral(grams, lbDivision, precisionLb);
  const weightSt = Math.floor(weightLb / 14.0);
  const weightStLb = roundTo(weightLb - weightSt * 14, precisionLb);
  return {
    hasTemperature: (u >>> 28) & 1,
    precisionKg,
    precisionLb,
    weightG: grams,
    kgScaleDivision: kgDivision,
    lbScaleDivision: lbDivision,
    weightKg,
    weightJin: roundTo(weightKg * 2, precisionKg),
    weightLb,
    weightSt,
    weightStLb,
    state: (u >>> 31) & 1,
    dianji: (u >>> 24) & 1,
    supportHr: (u >>> 25) & 1,
    supportPh: (u >>> 26) & 1,
    supportZx: (u >>> 27) & 1,
  };
}

export function normalizeImpedances(adcs, weightKg) {
  const nums = Array.isArray(adcs) ? adcs.map(v => Number(v)).filter(Number.isFinite) : [];
  if (nums.length === 5) {
    return [nums[4], nums[0], nums[1], nums[2], nums[3]].map(v => roundTo(v, 2));
  }
  const weight = Number(weightKg || 0);
  return nums.map(value => {
    let adjusted = value;
    if (adjusted >= 1500.0 && weight > 0.0) {
      adjusted = ((adjusted - 1000.0 + weight * 10.0 * -0.4) / 0.6) / 10.0;
    }
    return roundTo(adjusted, 2);
  });
}

function uuid16FromUuid(uuid) {
  const norm = String(uuid || '').toLowerCase();
  if (norm.startsWith('0000') && norm.includes('-0000-1000-8000-00805f9b34fb')) {
    const code = Number.parseInt(norm.slice(4, 8), 16);
    return Number.isFinite(code) && code !== 0 ? code : undefined;
  }
  if (/^[0-9a-f]{4}$/.test(norm)) {
    const code = Number.parseInt(norm, 16);
    return Number.isFinite(code) && code !== 0 ? code : undefined;
  }
  return undefined;
}

function macFromManufacturer(buf) {
  if (!buf || buf.length < 8 || buf[0] !== 0xac) return undefined;
  const macBytes = [...buf.subarray(2, 8)].reverse();
  return macBytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

export function parseScaleAdvertisement(rawDevice) {
  if (!rawDevice || typeof rawDevice !== 'object') return undefined;
  const address = normalizeMac(rawDevice.address);
  const name = String(rawDevice.name || rawDevice.localName || '').trim();
  const rssi = asInt(rawDevice.rssi);
  const services = Array.isArray(rawDevice.uuids)
    ? rawDevice.uuids.map(u => String(u).toLowerCase())
    : Array.isArray(rawDevice.services)
      ? rawDevice.services.map(u => String(u).toLowerCase())
      : [];

  const candidates = [];
  const mfgMap = rawDevice.manufacturerData || {};
  for (const [key, hexVal] of Object.entries(mfgMap)) {
    const companyId = String(key).startsWith('0x') ? Number.parseInt(String(key).slice(2), 16) : Number(key);
    if (!Number.isInteger(companyId) || companyId < 0 || companyId > 0xffff) continue;
    const prefix = Buffer.from([companyId & 0xff, (companyId >> 8) & 0xff]);
    const payload = Buffer.from(String(hexVal || ''), 'hex');
    candidates.push(Buffer.concat([prefix, payload]));
  }

  const svcMap = rawDevice.serviceData || {};
  for (const [uuidKey, hexVal] of Object.entries(svcMap)) {
    const uuid16 = uuid16FromUuid(uuidKey);
    if (uuid16 === undefined) continue;
    const keyHex = uuid16.toString(16).padStart(4, '0').toUpperCase();
    if (!keyHex.includes('AC')) continue;
    const prefix = Buffer.from([uuid16 & 0xff, (uuid16 >> 8) & 0xff]);
    const body = Buffer.from(String(hexVal || ''), 'hex');
    let reconstructed = Buffer.concat([prefix, body]);
    if (keyHex.includes('2C')) {
      const defaults = Buffer.from([0x33, 0x91, 0x1e, 0x1a, 0x0a, 0x01, 0xff, 0x00, 0x00, 0x44, 0x00]);
      if (body.length <= 6) {
        reconstructed = Buffer.concat([prefix, body, defaults]);
      } else if (body.length > 6 && body[6] === 0) {
        reconstructed = Buffer.concat([prefix, body.subarray(0, 6), defaults]);
      }
    }
    candidates.push(reconstructed);
  }

  const manufacturer = candidates.find(c => c.length >= 2 && c[0] === 0xac);
  let actualMac = manufacturer ? macFromManufacturer(manufacturer) : undefined;
  let communicationType = 'connect';
  let category = 2;
  let deviceSubtype = EXPECTED_SUBTYPE;
  let protocolVer = 1;

  if (manufacturer && manufacturer.length >= 2) {
    const flags = manufacturer[1];
    communicationType = ((flags >> 7) & 1) ? 'broadcast' : 'connect';
    category = (flags & 0x70) >> 4;
    deviceSubtype = flags & 0x0f;
    if (manufacturer.length >= 9) {
      protocolVer = manufacturer[8];
    }
  } else if (!name.startsWith(DEFAULT_NAME_PREFIX) && !(DEFAULT_SCALE_MAC && address === DEFAULT_SCALE_MAC)) {
    return undefined;
  }

  if (!actualMac && address) {
    actualMac = address;
  }

  return {
    address: address || actualMac || '',
    mac: actualMac || address || '',
    name: name || 'AFU-WL-TZ-A1',
    rssi: rssi ?? null,
    services,
    manufacturerHex: manufacturer ? manufacturer.toString('hex').toUpperCase() : '',
    communicationType,
    category,
    deviceType: category === 2 ? 'fat_scale' : 'weight_scale',
    deviceSubtype,
    protocolDeviceType: communicationType === 'connect' ? (deviceSubtype | 0x20) : (deviceSubtype | 0xa0),
    protocolVer,
    connected: Boolean(rawDevice.connected),
    paired: Boolean(rawDevice.paired),
  };
}

/** @param {{ deviceType?: number; protocolVer?: number; user?: Record<string, any>; nowMs?: number }} [opts] */
export function encodeTimeAndUserInfo27({
  deviceType = 0x27,
  protocolVer = 1,
  user = /** @type {Record<string, any>} */ ({}),
  nowMs = Date.now(),
} = {}) {
  const nowSec = Math.floor(nowMs / 1000);
  // getTimezoneOffset() is minutes behind UTC (e.g. -480 for UTC+8 -> +32 quarters)
  const utcQuarters = Math.trunc((-new Date(nowMs).getTimezoneOffset() * 60) / 900) & 0xff;
  const unitMap = { kg: 0, kilogram: 0, lb: 1, lbs: 1, pound: 1, st: 2, jin: 3, 斤: 3 };
  const unitStr = String(user.unit ?? 'kg').trim().toLowerCase();
  const unitByte = typeof user.unit === 'number' ? (user.unit & 0xff) : (unitMap[unitStr] ?? 0);
  const userIndex = 1;
  const rawHeight = Number(user.heightCm ?? user.height);
  const rawAge = Number(user.age);
  const sexNorm = normalizeSexInput(user.sex);
  if (!Number.isFinite(rawHeight) || !Number.isFinite(rawAge) || !sexNorm) {
    throw new Error('encodeTimeAndUserInfo27 requires valid user.sex, user.age, and user.heightCm');
  }
  const heightCm = clamp(Math.round(rawHeight), 80, 230) & 0xff;
  const age = clamp(Math.round(rawAge), 5, 120) & 0xff;
  const sexByte = sexNorm === 'male' ? 1 : 2;

  const profileWeight = float2int(0.0, 2);
  const targetWeight = float2int(0.0, 2);
  let functionFlags = 0;
  functionFlags = setBit(functionFlags, 0); // enable BIA impedance measurement
  functionFlags = setBit(functionFlags, 1);

  const buf = Buffer.alloc(20, 0);
  buf[0] = 0xac;
  buf[1] = deviceType & 0xff;
  buf.writeUInt32BE(nowSec >>> 0, 2);
  buf[6] = utcQuarters;
  buf[7] = unitByte;
  buf[8] = userIndex;
  buf[9] = heightCm;
  buf.writeUInt16BE(profileWeight & 0xffff, 10);
  buf[12] = age;
  buf[13] = sexByte;
  buf.writeUInt16BE(targetWeight & 0xffff, 14);
  buf[16] = functionFlags & 0xff;
  buf[17] = 0;
  buf[18] = 0xd0;

  let checksum = 0;
  for (let i = 2; i < 19; i++) checksum += buf[i];
  buf[19] = checksum & 0xff;
  return buf;
}

export class Scale27Protocol {
  constructor() {
    this._packets = [];
  }

  feed(input) {
    const pkt = Buffer.isBuffer(input)
      ? input
      : input instanceof Uint8Array
        ? Buffer.from(input)
        : Buffer.from(String(input || '').replace(/\s+/g, ''), 'hex');
    if (pkt.length === 0) {
      return { status: 'error', frame: null, events: [] };
    }

    // If waiting for continuation fragments of a multi-packet PACKET_SETTING, verify fragment validity;
    // on mismatch or runt packet, reset stale fragments and re-sync on the incoming packet if >= 20B.
    if (this._packets.length > 0) {
      const idx = this._packets.length;
      const validCont =
        idx < 5 &&
        pkt.length >= 18 &&
        ((pkt[3] & 0x0f) === idx);
      if (!validCont) {
        this._packets = [];
        if (pkt.length < 20) {
          return { status: 'error', frame: null, events: [] };
        }
      }
    }

    this._packets.push(pkt);
    const { status, frame } = this._assemble(this._packets);
    if (status === 'perfect' || status === 'error' || status === 'verify_error') {
      this._packets = [];
    }
    if (status !== 'perfect' || !frame) {
      return { status, frame: frame ? frame.toString('hex').toUpperCase() : null, events: [] };
    }
    return {
      status,
      frame: frame.toString('hex').toUpperCase(),
      events: this.decode(frame),
    };
  }

  _assemble(packets) {
    if (!packets.length) return { status: 'imperfect', frame: null };
    const first = packets[0];
    // Never leave a malformed <20B leading packet stuck in _packets.
    if (first.length < 20) return { status: 'error', frame: null };
    const seqOrFlags = first[1] & 0xff;
    if (getBit(seqOrFlags, 7)) return { status: 'error', frame: null };

    const body18 = first.subarray(2, 20);
    let calc = 0;
    for (let i = 0; i < 17; i++) calc += body18[i];
    const checksum = calc & 0x1f;
    const checksumByte = body18[17];
    const status = checksum === (checksumByte & 0x1f) ? 'perfect' : 'verify_error';
    const packetType = body18[16];
    const groupIndex = (checksumByte & 0xe0) >> 5;

    if (packetType === PACKET_SETTING && body18[0] === 6) {
      if (packets.length > 5) return { status: 'error', frame: null };
      if (packets.length !== 5) return { status: 'imperfect', frame: null };
      const combined = Buffer.alloc(128, 0);
      let lastGroup = groupIndex;
      for (let idx = 0; idx < packets.length; idx++) {
        const packet = packets[idx];
        if (packet.length < 18) return { status: 'error', frame: null };
        const marker = packet[3];
        lastGroup = (marker & 0xf0) >> 4;
        if ((marker & 0x0f) !== idx) return { status: 'error', frame: null };
        packet.copy(combined, idx * 14, 4, 18);
      }
      const frame = Buffer.alloc(4 + 67);
      frame[0] = packetType;
      frame[1] = seqOrFlags;
      frame.writeUInt16BE(67, 2);
      frame[4] = 6;
      frame[5] = lastGroup;
      combined.copy(frame, 6, 0, 64);
      frame[70] = groupIndex;
      return { status, frame };
    }

    const frame = Buffer.alloc(4 + 17);
    frame[0] = packetType;
    frame[1] = seqOrFlags;
    frame.writeUInt16BE(17, 2);
    body18.copy(frame, 4, 0, 16);
    frame[20] = groupIndex;
    return { status, frame };
  }

  decode(frame) {
    if (!frame || frame.length < 4) return [];
    const packetType = frame[0];
    const deviceType = frame[1];
    const length = frame.readUInt16BE(2);
    const payload = Buffer.concat([Buffer.from([deviceType]), frame.subarray(4, 4 + length)]);

    let events;
    if (packetType === PACKET_WEIGHT) {
      events = this._decodeWeight(payload);
    } else if (packetType === PACKET_ADC) {
      events = this._decodeAdc(payload);
    } else if (packetType === PACKET_HISTORY) {
      events = this._decodeHistory(payload);
    } else if (packetType === PACKET_SETTING) {
      events = this._decodeSetting(payload);
    } else {
      events = [{ kind: 'unknown', payload: payload.toString('hex').toUpperCase() }];
    }

    for (const ev of events) {
      ev.packageType = packetType;
      ev.deviceType = deviceType;
    }
    return events;
  }

  _decodeWeight(payload) {
    if (payload.length < 8) return [];
    const encoded = payload.readUInt32BE(1);
    const mode = payload[5];
    const event = { kind: 'weight', mode };

    if (mode === 1 && payload.length >= 9) {
      event.calibrationMode = payload[6];
      event.charging = getBit(payload[7], 7);
      event.battery = payload[7] & 0x7f;
      event.overWeight = payload[8];
    } else if (mode === 2 && payload.length >= 11) {
      const bits = payload.readUInt32BE(6);
      event.supportFuns = [];
      for (let b = 0; b < 32; b++) {
        if ((bits & (1 << b)) !== 0) event.supportFuns.push(b);
      }
      event.charging = getBit(payload[10], 7);
      event.battery = payload[10] & 0x7f;
    }

    Object.assign(event, decodeWeightFields(encoded));
    event.algType = payload.length >= 2 ? payload[payload.length - 2] : 0;
    event.unit = payload.length >= 1 ? payload[payload.length - 1] : 0;
    event.stable = Boolean(event.state);
    return [event];
  }

  _decodeAdc(payload) {
    if (payload.length < 5 || getBit(payload[0], 7)) return [];
    const count = payload[1];
    let offset = 3;
    const adcs = [];
    for (let i = 0; i < count; i++) {
      if (offset + 2 > payload.length) return [];
      adcs.push(payload.readUInt16BE(offset));
      offset += 2;
    }
    if (offset >= payload.length) return [];
    const mode = payload[offset];
    offset += 1;

    const event = { kind: 'adc', mode, adcs };
    if (mode === 1 && offset + 4 <= payload.length) {
      Object.assign(event, decodeWeightFields(payload.readUInt32BE(offset)));
    }
    if (event.weightKg !== undefined) {
      event.impedances = normalizeImpedances(adcs, event.weightKg);
    }
    event.algType = payload.length >= 2 ? payload[payload.length - 2] : 0;
    event.unit = payload.length >= 1 ? payload[payload.length - 1] : 0;
    return [event];
  }

  _decodeHistory(payload) {
    if (payload.length < 10) return [];
    const event = { kind: 'history' };
    let offset = 0;
    const deviceType = payload[offset++];

    if (deviceType !== 42) {
      if (offset + 9 > payload.length) return [];
      const historyType = payload[offset++];
      event.historyType = historyType;
      event.time = payload.readUInt32BE(offset);
      offset += 4;
      event.weight = decodeWeightFields(payload.readUInt32BE(offset));
      offset += 4;
      const adcs = [];
      if (historyType === 0 && offset + 4 <= payload.length) {
        offset += 2;
        event.hr = payload[offset++];
        const count = payload[offset++];
        for (let i = 0; i < count && offset + 2 <= payload.length; i++) {
          adcs.push(payload.readUInt16BE(offset));
          offset += 2;
        }
      } else if (historyType === 2 && offset + 2 <= payload.length) {
        event.remainHistoryCount = payload[offset++];
        const count = payload[offset++];
        for (let i = 0; i < count && offset + 2 <= payload.length; i++) {
          adcs.push(payload.readUInt16BE(offset));
          offset += 2;
        }
        event.hr = 0;
      } else {
        for (let i = 0; i < 2 && offset + 2 <= payload.length; i++) {
          adcs.push(payload.readUInt16BE(offset));
          offset += 2;
        }
        offset += 2;
      }
      event.adcs = adcs;
      event.impedances = normalizeImpedances(adcs, event.weight.weightKg);
      if (offset + 2 <= payload.length) {
        event.algType = payload[offset];
        event.unit = payload[offset + 1];
      }
    } else {
      if (offset + 14 > payload.length) return [];
      event.time = payload.readUInt32BE(offset);
      offset += 4;
      event.weight = decodeWeightFields(payload.readUInt32BE(offset));
      offset += 4;
      const adcs = [payload.readUInt16BE(offset)];
      offset += 2;
      offset += 4;
      event.hr = payload[offset++];
      event.adcs = adcs;
      event.impedances = normalizeImpedances(adcs, event.weight.weightKg);
      if (offset + 2 <= payload.length) {
        event.algType = payload[offset];
        event.unit = payload[offset + 1];
      }
    }
    return [event];
  }

  _decodeSetting(payload) {
    if (payload.length < 2) return [];
    const event = { kind: 'setting', operateType: payload[1] };
    if (payload[1] === 6 && payload.length >= 67) {
      event.signIndex = payload[2];
      event.sign = payload.subarray(3, 67).toString('hex').toUpperCase();
    }
    return [event];
  }
}

// ---------------------------------------------------------------------------
// Comprehensive BIA Body Composition & Health Analytics Engine
// ---------------------------------------------------------------------------

function firstValidResistance(impedances) {
  if (!Array.isArray(impedances)) return undefined;
  for (const val of impedances) {
    const r = Number(val);
    if (Number.isFinite(r) && r >= 100.0 && r <= 1500.0) {
      return r;
    }
  }
  return undefined;
}

function segalFfm(weightKg, heightCm, age, male, resistanceOhm) {
  const heightSq = heightCm * heightCm;
  if (male) {
    let ffm = 9.33285 + 0.00066360 * heightSq - 0.02117 * resistanceOhm + 0.62854 * weightKg - 0.12380 * age;
    const pct = 100.0 * (weightKg - ffm) / weightKg;
    if (pct < 20.0) return { ffm, model: 'segal_3a_male_lt20' };
    ffm = 14.52435 + 0.00088580 * heightSq - 0.02999 * resistanceOhm + 0.42688 * weightKg - 0.07002 * age;
    return { ffm, model: 'segal_3b_male_ge20' };
  }
  let ffm = 10.43485 + 0.00064602 * heightSq - 0.01397 * resistanceOhm + 0.42087 * weightKg;
  const pct = 100.0 * (weightKg - ffm) / weightKg;
  if (pct < 30.0) return { ffm, model: 'segal_3c_female_lt30' };
  ffm = 9.37938 + 0.00091186 * heightSq - 0.01466 * resistanceOhm + 0.29990 * weightKg - 0.07012 * age;
  return { ffm, model: 'segal_3d_female_ge30' };
}

function deurenbergBodyFatPercent(weightKg, heightCm, age, male) {
  const bmi = weightKg / ((heightCm / 100.0) ** 2);
  const sexVal = male ? 1 : 0;
  return 1.20 * bmi + 0.23 * age - 10.8 * sexVal - 5.4;
}

/** @param {number} value @param {number} min @param {number} max @param {{ highLabel?: string; criticalHigh?: number; criticalLabel?: string; lowLabel?: string; excellentMin?: number; excellentMax?: number }} [opts] */
function rateRange(value, min, max, {
  highLabel = '偏高',
  criticalHigh = max + (max - min) * 0.6,
  criticalLabel = '超标',
  lowLabel = '偏低',
  excellentMin = undefined,
  excellentMax = undefined,
} = /** @type {{ highLabel?: string; criticalHigh?: number; criticalLabel?: string; lowLabel?: string; excellentMin?: number; excellentMax?: number }} */ ({})) {
  if (value < min) return { status: 'low', statusLabel: lowLabel };
  if (excellentMin !== undefined && excellentMax !== undefined && value >= excellentMin && value <= excellentMax) {
    return { status: 'excellent', statusLabel: '优秀' };
  }
  if (value <= max) return { status: 'normal', statusLabel: '标准' };
  if (value >= criticalHigh) return { status: 'critical', statusLabel: criticalLabel };
  return { status: 'high', statusLabel: highLabel };
}

function classifyBmiChina(bmi) {
  if (bmi < 18.5) return { status: 'low', statusLabel: '偏瘦', category: '偏瘦' };
  if (bmi < 24.0) return { status: 'normal', statusLabel: '标准', category: '标准' };
  if (bmi < 28.0) return { status: 'high', statusLabel: '超重', category: '超重' };
  return { status: 'critical', statusLabel: '肥胖', category: '肥胖' };
}

function classifyBodyType(bmi, bodyFatPct, male) {
  const bmiBucket = bmi < 18.5 ? 0 : bmi < 24.0 ? 1 : 2;
  const fatLow = male ? 11.0 : 18.0;
  const fatHigh = male ? 20.0 : 28.0;
  const fatBucket = bodyFatPct < fatLow ? 0 : bodyFatPct <= fatHigh ? 1 : 2;
  const matrix = [
    ['偏瘦型', '偏瘦型', '隐性肥胖型'],
    ['偏瘦肌肉型', '标准型', '微胖型'],
    ['运动健美型', '偏壮标准型', bmi >= 28.0 ? '重度肥胖型' : '肥胖型'],
  ];
  return matrix[bmiBucket][fatBucket];
}

/** @param {{ weightKg?: any; heightCm?: any; age?: any; sex?: any; targetWeightKg?: any; impedances?: any[]; adcs?: any[]; algType?: any; heartRate?: any }} [opts] */
export function computeFullHealthReport({
  weightKg = undefined,
  heightCm = undefined,
  age = undefined,
  sex = undefined,
  targetWeightKg = null,
  impedances = [],
  adcs = [],
  algType = null,
  heartRate = null,
} = /** @type {{ weightKg?: any; heightCm?: any; age?: any; sex?: any; targetWeightKg?: any; impedances?: any[]; adcs?: any[]; algType?: any; heartRate?: any }} */ ({})) {
  const weight = Number(weightKg);
  const rawHeight = Number(heightCm);
  const rawAge = Number(age);
  const normSex = normalizeSexInput(sex);
  if (!Number.isFinite(weight) || weight <= 0 || !Number.isFinite(rawHeight) || !Number.isFinite(rawAge) || !normSex) {
    return null;
  }
  const height = clamp(rawHeight, 80, 230);
  const ageInt = clamp(Math.round(rawAge), 5, 120);
  const male = normSex === 'male';

  const heightM = height / 100.0;
  const bmi = roundTo(weight / (heightM * heightM), 1);
  const bmiInfo = classifyBmiChina(bmi);

  const normalizedImps = Array.isArray(impedances)
    ? impedances.map(v => Number(v)).filter(Number.isFinite)
    : [];
  const resistance = firstValidResistance(normalizedImps);
  const secondaryOhm = normalizedImps.length > 1 && Number.isFinite(normalizedImps[1]) ? roundTo(normalizedImps[1], 1) : null;

  let baseFatPct;
  let formulaModel;
  if (resistance !== undefined) {
    const segal = segalFfm(weight, height, ageInt, male, resistance);
    const boundedFfm = clamp(segal.ffm, weight * 0.35, weight * 0.97);
    baseFatPct = 100.0 * (weight - boundedFfm) / weight;
    formulaModel = segal.model;
  } else {
    baseFatPct = deurenbergBodyFatPercent(weight, height, ageInt, male);
    formulaModel = 'deurenberg_bmi_fallback';
  }

  const bodyFatPercent = roundTo(clamp(baseFatPct, male ? 3.0 : 8.0, 60.0), 1);
  const fatMassKg = roundTo(weight * bodyFatPercent / 100.0, 1);
  const fatFreeMassKg = roundTo(weight - fatMassKg, 1);
  const leanPercent = roundTo(100.0 - bodyFatPercent, 1);

  const bonePercent = male ? 4.5 : 4.0;
  const boneMassKg = roundTo(weight * bonePercent / 100.0, 1);
  const musclePercent = roundTo(clamp(100.0 - bodyFatPercent - bonePercent, 20.0, 95.0), 1);
  const muscleMassKg = roundTo(weight * musclePercent / 100.0, 1);

  const waterPercent = roundTo(clamp(leanPercent * 0.70, 25.0, 80.0), 1);
  const waterMassKg = roundTo(weight * waterPercent / 100.0, 1);

  const proteinPercent = roundTo(clamp(leanPercent * 0.238, 5.0, 35.0), 1);
  const proteinMassKg = roundTo(weight * proteinPercent / 100.0, 1);

  const skeletalMusclePercent = roundTo(clamp(musclePercent * 0.527, 10.0, 70.0), 1);
  const skeletalMuscleMassKg = roundTo(weight * skeletalMusclePercent / 100.0, 1);

  const subcutaneousFatPercent = roundTo(clamp(bodyFatPercent * 0.72, 1.0, bodyFatPercent), 1);
  const subcutaneousFatMassKg = roundTo(weight * subcutaneousFatPercent / 100.0, 1);

  // Visceral fat grade (1..30) correlated with BMI, body fat excess, and age
  const optimalBmi = male ? 22.0 : 21.0;
  const optimalFat = male ? 16.0 : 23.0;
  const rawVisceral = 4.5 + (bmi - optimalBmi) * 0.85 + (bodyFatPercent - optimalFat) * 0.35 + (ageInt - 25) * 0.08;
  const visceralFatLevel = Math.round(clamp(rawVisceral, 1, 30));

  // Basal Metabolic Rate (Katch-McArdle anchored on FFM, adjusted smoothly) & TDEE
  const katchBmr = 370 + 21.6 * fatFreeMassKg;
  const mifflinBmr = 10 * weight + 6.25 * height - 5 * ageInt + (male ? 5 : -161);
  const bmrKcal = Math.round(resistance !== undefined ? (katchBmr * 0.65 + mifflinBmr * 0.35) : mifflinBmr);
  const tdeeKcal = Math.round(bmrKcal * 1.375);

  // Reference Standard Weight & Control Suggestions
  const standardWeightKg = roundTo(optimalBmi * heightM * heightM, 1);
  const weightDiffFromStandardKg = roundTo(weight - standardWeightKg, 1);
  const targetKg = asFiniteNumber(targetWeightKg);
  const weightDiffFromTargetKg = targetKg !== undefined ? roundTo(weight - targetKg, 1) : null;

  const idealFatPct = male ? 16.0 : 23.0;
  const idealFatMass = standardWeightKg * (idealFatPct / 100.0);
  const fatControlKg = roundTo(idealFatMass - fatMassKg, 1);
  const idealMuscleMass = standardWeightKg * (male ? 0.43 : 0.36); // skeletal muscle target
  const muscleControlKg = roundTo(Math.max(0, idealMuscleMass - skeletalMuscleMassKg), 1);
  const weightControlKg = roundTo(standardWeightKg - weight, 1);

  // Body Age estimation
  const fatPenalty = Math.max(0, bodyFatPercent - (male ? 18.0 : 25.0)) * 0.45;
  const bmiPenalty = Math.max(0, Math.abs(bmi - optimalBmi) - 1.5) * 0.65;
  const muscleBonus = Math.max(0, skeletalMusclePercent - (male ? 42.0 : 35.0)) * 0.35;
  const bodyAge = Math.round(clamp(ageInt + fatPenalty + bmiPenalty - muscleBonus, 14, 85));

  // Body Score (0..100)
  const fatDev = Math.abs(bodyFatPercent - idealFatPct);
  const bmiDev = Math.abs(bmi - optimalBmi);
  const visceralPenalty = Math.max(0, visceralFatLevel - 9) * 2.2;
  const muscleShortfall = Math.max(0, (male ? 39.0 : 32.0) - skeletalMusclePercent) * 1.1;
  const rawScore = 96 - fatDev * 1.35 - bmiDev * 2.1 - visceralPenalty - muscleShortfall;
  const bodyScore = Math.round(clamp(rawScore, 35, 100));

  const bodyType = classifyBodyType(bmi, bodyFatPercent, male);

  // Standard reference brackets
  const stdMinW = roundTo(18.5 * heightM * heightM, 1);
  const stdMaxW = roundTo(23.9 * heightM * heightM, 1);
  const fatMin = male ? 10.0 : 18.0;
  const fatMax = male ? 20.0 : 28.0;
  const skelMin = male ? 38.0 : 31.0;
  const skelMax = male ? 48.0 : 40.0;
  const musMin = male ? 72.0 : 65.0;
  const musMax = male ? 85.0 : 78.0;
  const watMin = male ? 55.0 : 45.0;
  const watMax = male ? 65.0 : 60.0;
  const proMin = 16.0;
  const proMax = 20.0;
  const boneMin = roundTo(standardWeightKg * (male ? 0.04 : 0.035), 1);
  const boneMax = roundTo(standardWeightKg * (male ? 0.05 : 0.045), 1);
  const subMin = male ? 7.0 : 12.0;
  const subMax = male ? 15.0 : 21.0;
  const bmrMin = male ? 1400 : 1150;
  const bmrMax = male ? 1950 : 1550;

  const weightRating = rateRange(weight, stdMinW, stdMaxW, {
    lowLabel: '偏轻',
    highLabel: '偏重',
    criticalHigh: roundTo(28.0 * heightM * heightM, 1),
    criticalLabel: '超标',
    excellentMin: roundTo(standardWeightKg - 1.5, 1),
    excellentMax: roundTo(standardWeightKg + 1.5, 1),
  });
  const fatRating = rateRange(bodyFatPercent, fatMin, fatMax, {
    lowLabel: '偏低',
    highLabel: '偏高',
    criticalHigh: male ? 25.0 : 33.0,
    criticalLabel: '超标',
    excellentMin: male ? 12.0 : 20.0,
    excellentMax: male ? 17.5 : 24.5,
  });
  const skelRating = rateRange(skeletalMusclePercent, skelMin, skelMax, {
    lowLabel: '不足',
    highLabel: '优秀',
    criticalHigh: 65,
    criticalLabel: '优秀',
  });
  if (skeletalMusclePercent > skelMax) {
    skelRating.status = 'excellent';
    skelRating.statusLabel = '强壮';
  }
  const muscleRating = rateRange(musclePercent, musMin, musMax, { lowLabel: '不足', highLabel: '充沛', criticalHigh: 95, criticalLabel: '充沛' });
  if (musclePercent > musMax) {
    muscleRating.status = 'excellent';
    muscleRating.statusLabel = '充沛';
  }
  const waterRating = rateRange(waterPercent, watMin, watMax, { lowLabel: '偏干', highLabel: '偏高', criticalHigh: 75, criticalLabel: '偏高' });
  const proteinRating = rateRange(proteinPercent, proMin, proMax, { lowLabel: '偏低', highLabel: '充足', criticalHigh: 35, criticalLabel: '充足' });
  if (proteinPercent > proMax) {
    proteinRating.status = 'excellent';
    proteinRating.statusLabel = '充足';
  }
  const boneRating = rateRange(boneMassKg, boneMin, boneMax, { lowLabel: '偏低', highLabel: '充足', criticalHigh: 8, criticalLabel: '充足' });
  const subFatRating = rateRange(subcutaneousFatPercent, subMin, subMax, { lowLabel: '偏低', highLabel: '偏高', criticalHigh: male ? 20 : 27, criticalLabel: '超标' });
  const visceralRating = rateRange(visceralFatLevel, 1, 9, { lowLabel: '偏低', highLabel: '警戒', criticalHigh: 15, criticalLabel: '高危', excellentMin: 2, excellentMax: 6 });
  const bmrRating = rateRange(bmrKcal, bmrMin, bmrMax, { lowLabel: '偏低', highLabel: '旺盛', criticalHigh: 3500, criticalLabel: '旺盛' });
  if (bmrKcal > bmrMax) {
    bmrRating.status = 'excellent';
    bmrRating.statusLabel = '旺盛';
  }
  const leanRating = rateRange(fatFreeMassKg, roundTo(stdMinW * 0.78, 1), roundTo(stdMaxW * 0.88, 1), { lowLabel: '偏低', highLabel: '充沛', criticalHigh: 150, criticalLabel: '充沛' });
  const ageRating = bodyAge <= ageInt ? { status: 'excellent', statusLabel: '年轻态' } : bodyAge <= ageInt + 3 ? { status: 'normal', statusLabel: '标准' } : { status: 'high', statusLabel: '偏大' };

  const items = [
    {
      key: 'weight',
      label: '体重',
      value: roundTo(weight, 2),
      unit: 'kg',
      secondaryText: `${roundTo(weight * 2, 2)} 斤 · ${roundTo(weight * 2.20462, 1)} lb`,
      status: weightRating.status,
      statusLabel: weightRating.statusLabel,
      range: { min: stdMinW, max: stdMaxW, scaleMin: roundTo(stdMinW * 0.7, 1), scaleMax: roundTo(stdMaxW * 1.4, 1), unit: 'kg' },
    },
    {
      key: 'bmi',
      label: 'BMI 体质指数',
      value: bmi,
      unit: '',
      secondaryText: `中国成人参考 ${bmiInfo.category}`,
      status: bmiInfo.status,
      statusLabel: bmiInfo.statusLabel,
      range: { min: 18.5, max: 23.9, scaleMin: 12, scaleMax: 35, unit: '' },
    },
    {
      key: 'bodyFat',
      label: '体脂率',
      value: bodyFatPercent,
      unit: '%',
      secondaryText: `脂肪量 ${fatMassKg.toFixed(1)} kg`,
      status: fatRating.status,
      statusLabel: fatRating.statusLabel,
      range: { min: fatMin, max: fatMax, scaleMin: 3, scaleMax: 42, unit: '%' },
    },
    {
      key: 'skeletalMuscle',
      label: '骨骼肌率',
      value: skeletalMusclePercent,
      unit: '%',
      secondaryText: `骨骼肌重 ${skeletalMuscleMassKg.toFixed(1)} kg`,
      status: skelRating.status,
      statusLabel: skelRating.statusLabel,
      range: { min: skelMin, max: skelMax, scaleMin: 20, scaleMax: 60, unit: '%' },
    },
    {
      key: 'muscle',
      label: '肌肉率',
      value: musclePercent,
      unit: '%',
      secondaryText: `肌肉量 ${muscleMassKg.toFixed(1)} kg`,
      status: muscleRating.status,
      statusLabel: muscleRating.statusLabel,
      range: { min: musMin, max: musMax, scaleMin: 45, scaleMax: 92, unit: '%' },
    },
    {
      key: 'fatFreeMass',
      label: '去脂体重 (FFM)',
      value: fatFreeMassKg,
      unit: 'kg',
      secondaryText: `瘦体重占比 ${leanPercent.toFixed(1)}%`,
      status: leanRating.status,
      statusLabel: leanRating.statusLabel,
      range: { min: roundTo(stdMinW * 0.78, 1), max: roundTo(stdMaxW * 0.88, 1), scaleMin: roundTo(stdMinW * 0.55, 1), scaleMax: roundTo(stdMaxW * 1.15, 1), unit: 'kg' },
    },
    {
      key: 'water',
      label: '体水分率',
      value: waterPercent,
      unit: '%',
      secondaryText: `水分重 ${waterMassKg.toFixed(1)} kg`,
      status: waterRating.status,
      statusLabel: waterRating.statusLabel,
      range: { min: watMin, max: watMax, scaleMin: 35, scaleMax: 75, unit: '%' },
    },
    {
      key: 'protein',
      label: '蛋白质率',
      value: proteinPercent,
      unit: '%',
      secondaryText: `蛋白质量 ${proteinMassKg.toFixed(1)} kg`,
      status: proteinRating.status,
      statusLabel: proteinRating.statusLabel,
      range: { min: proMin, max: proMax, scaleMin: 10, scaleMax: 28, unit: '%' },
    },
    {
      key: 'boneMass',
      label: '骨盐量',
      value: boneMassKg,
      unit: 'kg',
      secondaryText: `骨量占比 ${bonePercent.toFixed(1)}%`,
      status: boneRating.status,
      statusLabel: boneRating.statusLabel,
      range: { min: boneMin, max: boneMax, scaleMin: 1.5, scaleMax: 5.0, unit: 'kg' },
    },
    {
      key: 'subcutaneousFat',
      label: '皮下脂肪率',
      value: subcutaneousFatPercent,
      unit: '%',
      secondaryText: `皮下脂肪 ${subcutaneousFatMassKg.toFixed(1)} kg`,
      status: subFatRating.status,
      statusLabel: subFatRating.statusLabel,
      range: { min: subMin, max: subMax, scaleMin: 3, scaleMax: 32, unit: '%' },
    },
    {
      key: 'visceralFat',
      label: '内脏脂肪等级',
      value: visceralFatLevel,
      unit: '级',
      secondaryText: visceralFatLevel <= 9 ? '内脏脂肪健康' : visceralFatLevel <= 14 ? '建议控制饮食与有氧' : '内脏脂肪偏高风险',
      status: visceralRating.status,
      statusLabel: visceralRating.statusLabel,
      range: { min: 1, max: 9, scaleMin: 1, scaleMax: 24, unit: '级' },
    },
    {
      key: 'bmr',
      label: '基础代谢率 (BMR)',
      value: bmrKcal,
      unit: 'kcal',
      secondaryText: `日总消耗 TDEE ≈ ${tdeeKcal} kcal`,
      status: bmrRating.status,
      statusLabel: bmrRating.statusLabel,
      range: { min: bmrMin, max: bmrMax, scaleMin: 900, scaleMax: 2500, unit: 'kcal' },
    },
    {
      key: 'standardWeight',
      label: '理想标准体重',
      value: standardWeightKg,
      unit: 'kg',
      secondaryText: `当前偏差 ${weightDiffFromStandardKg >= 0 ? '+' : ''}${weightDiffFromStandardKg.toFixed(1)} kg`,
      status: Math.abs(weightDiffFromStandardKg) <= 2.5 ? 'excellent' : Math.abs(weightDiffFromStandardKg) <= 6 ? 'normal' : 'high',
      statusLabel: Math.abs(weightDiffFromStandardKg) <= 2.5 ? '贴近理想' : weightDiffFromStandardKg > 0 ? '高于标准' : '低于标准',
      range: { min: stdMinW, max: stdMaxW, scaleMin: roundTo(stdMinW * 0.7, 1), scaleMax: roundTo(stdMaxW * 1.4, 1), unit: 'kg' },
    },
    {
      key: 'fatControl',
      label: '脂肪控制建议',
      value: fatControlKg,
      unit: 'kg',
      secondaryText: fatControlKg < -0.5 ? `建议减脂 ${Math.abs(fatControlKg).toFixed(1)} kg` : fatControlKg > 0.5 ? `可适度增脂 ${fatControlKg.toFixed(1)} kg` : '脂肪量处于理想区间',
      status: Math.abs(fatControlKg) <= 1.5 ? 'excellent' : Math.abs(fatControlKg) <= 4 ? 'normal' : 'high',
      statusLabel: Math.abs(fatControlKg) <= 1.5 ? '理想' : fatControlKg < 0 ? '建议减脂' : '偏瘦',
      range: { min: -2, max: 2, scaleMin: -18, scaleMax: 10, unit: 'kg' },
    },
    {
      key: 'muscleControl',
      label: '肌肉控制建议',
      value: muscleControlKg,
      unit: 'kg',
      secondaryText: muscleControlKg > 0.3 ? `建议增肌 +${muscleControlKg.toFixed(1)} kg` : '骨骼肌储备达标',
      status: muscleControlKg <= 0.5 ? 'excellent' : muscleControlKg <= 2.5 ? 'normal' : 'low',
      statusLabel: muscleControlKg <= 0.5 ? '达标' : '建议增肌',
      range: { min: 0, max: 1.5, scaleMin: 0, scaleMax: 10, unit: 'kg' },
    },
    {
      key: 'bodyAge',
      label: '身体年龄',
      value: bodyAge,
      unit: '岁',
      secondaryText: `实际年龄 ${ageInt} 岁 (${bodyAge <= ageInt ? `年轻 ${ageInt - bodyAge} 岁` : `偏大 ${bodyAge - ageInt} 岁`})`,
      status: ageRating.status,
      statusLabel: ageRating.statusLabel,
      range: { min: Math.max(14, ageInt - 5), max: ageInt + 2, scaleMin: 14, scaleMax: 75, unit: '岁' },
    },
  ];

  if (resistance !== undefined) {
    items.push({
      key: 'impedance',
      label: '生物电阻抗',
      value: roundTo(resistance, 1),
      unit: 'Ω',
      secondaryText: secondaryOhm !== null ? `双频阻抗 ${roundTo(resistance, 1)} / ${secondaryOhm} Ω` : `单通道阻抗 ${roundTo(resistance, 1)} Ω`,
      status: 'normal',
      statusLabel: 'BIA 已测',
      range: { min: 350, max: 650, scaleMin: 150, scaleMax: 1000, unit: 'Ω' },
    });
  }

  if (Number.isFinite(Number(heartRate)) && Number(heartRate) > 0) {
    const hr = Math.round(Number(heartRate));
    const hrRate = rateRange(hr, 60, 100, { lowLabel: '偏缓', highLabel: '偏快', criticalHigh: 120, criticalLabel: '过快' });
    items.push({
      key: 'heartRate',
      label: '静息心率',
      value: hr,
      unit: 'bpm',
      secondaryText: '秤端实测心率',
      status: hrRate.status,
      statusLabel: hrRate.statusLabel,
      range: { min: 60, max: 100, scaleMin: 40, scaleMax: 140, unit: 'bpm' },
    });
  }

  return {
    weightKg: roundTo(weight, 2),
    weightJin: roundTo(weight * 2, 2),
    weightLb: roundTo(weight * 2.20462, 2),
    weightG: Math.round(weight * 1000),
    bmi,
    bmiCategory: bmiInfo.category,
    bodyScore,
    bodyType,
    bodyAge,
    estimationMode: resistance !== undefined ? 'bia' : 'bmi_only',
    formulaModel,
    resistanceOhm: resistance !== undefined ? roundTo(resistance, 2) : null,
    secondaryOhm,
    adcs: Array.isArray(adcs) ? adcs : [],
    impedances: normalizedImps,
    algType,
    bodyFatPercent,
    fatMassKg,
    fatFreeMassKg,
    leanPercent,
    musclePercent,
    muscleMassKg,
    skeletalMusclePercent,
    skeletalMuscleMassKg,
    waterPercent,
    waterMassKg,
    proteinPercent,
    proteinMassKg,
    bonePercent,
    boneMassKg,
    subcutaneousFatPercent,
    subcutaneousFatMassKg,
    visceralFatLevel,
    bmrKcal,
    tdeeKcal,
    standardWeightKg,
    weightDiffFromStandardKg,
    weightDiffFromTargetKg,
    weightControlKg,
    fatControlKg,
    muscleControlKg,
    items,
  };
}

// ---------------------------------------------------------------------------
// Database Row Mappers & Analytics Helpers
// ---------------------------------------------------------------------------

function mapProfileRow(row) {
  return {
    id: row.id,
    name: row.name,
    sex: row.sex,
    age: row.age,
    heightCm: row.height_cm,
    targetWeightKg: row.target_weight_kg,
    unit: row.unit || 'kg',
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDeviceRow(row) {
  if (!row) return null;
  return {
    mac: row.mac,
    address: row.address,
    name: row.name,
    rssi: row.rssi,
    battery: row.battery,
    charging: row.charging === null || row.charging === undefined ? null : Boolean(row.charging),
    protocolVer: row.protocol_ver,
    deviceSubtype: row.device_subtype,
    model: row.model,
    hardwareVer: row.hardware_ver,
    softwareVer: row.software_ver,
    manufacturer: row.manufacturer,
    supportFuns: safeJsonParse(row.support_funs_json, []),
    rawAdv: safeJsonParse(row.raw_adv_json, null),
    lastSeenAt: row.last_seen_at,
  };
}

function mapMeasurementRow(row, profile) {
  const adcs = safeJsonParse(row.adcs_json, []);
  const impedances = safeJsonParse(row.impedances_json, []);
  const rawMeta = safeJsonParse(row.raw_meta_json, {});
  const metrics = profile
    ? computeFullHealthReport({
        weightKg: row.weight_kg,
        heightCm: profile.heightCm,
        age: profile.age,
        sex: profile.sex,
        targetWeightKg: profile.targetWeightKg ?? null,
        impedances,
        adcs,
        algType: row.alg_type,
        heartRate: row.heart_rate,
      })
    : null;

  return {
    id: row.id,
    profileId: row.profile_id,
    measuredAt: row.measured_at,
    source: row.source,
    deviceMac: row.device_mac,
    weightKg: row.weight_kg,
    weightJin: row.weight_jin,
    weightLb: row.weight_lb,
    weightG: row.weight_g,
    stable: Boolean(row.stable),
    impedanceMeasured: Boolean(row.impedance_measured),
    adcs,
    impedances,
    primaryOhm: row.primary_ohm,
    secondaryOhm: row.secondary_ohm,
    algType: row.alg_type,
    heartRate: row.heart_rate,
    battery: row.battery,
    charging: row.charging === null || row.charging === undefined ? null : Boolean(row.charging),
    rssi: row.rssi,
    calibrationMode: row.calibration_mode,
    overWeight: row.over_weight,
    dianji: row.dianji,
    rawMeta,
    note: row.note,
    createdAt: row.created_at,
    metrics,
  };
}

function upsertDevice(db, info, nowMs) {
  const mac = normalizeMac(info.mac || info.address || '');
  if (!mac) return null;
  const existing = db.prepare('SELECT * FROM devices WHERE mac = ?').get(mac);
  const address = normalizeMac(info.address || existing?.address || mac);
  const name = info.name || existing?.name || 'AFU-WL-TZ-A1';
  const rssi = info.rssi !== undefined && info.rssi !== null ? asInt(info.rssi) : (existing?.rssi ?? null);
  const battery = info.battery !== undefined && info.battery !== null ? asInt(info.battery) : (existing?.battery ?? null);
  const charging = info.charging !== undefined && info.charging !== null ? (info.charging ? 1 : 0) : (existing?.charging ?? null);
  const protocolVer = info.protocolVer !== undefined && info.protocolVer !== null ? asInt(info.protocolVer) : (existing?.protocol_ver ?? null);
  const deviceSubtype = info.deviceSubtype !== undefined && info.deviceSubtype !== null ? asInt(info.deviceSubtype) : (existing?.device_subtype ?? null);
  const model = info.model || existing?.model || null;
  const hardwareVer = info.hardwareVer || existing?.hardware_ver || null;
  const softwareVer = info.softwareVer || existing?.software_ver || null;
  const manufacturer = info.manufacturer || existing?.manufacturer || null;
  const supportFunsJson = info.supportFuns ? JSON.stringify(info.supportFuns) : (existing?.support_funs_json ?? null);
  const rawAdvJson = info.rawAdv ? JSON.stringify(info.rawAdv) : (existing?.raw_adv_json ?? null);

  db.prepare(`
    INSERT INTO devices (
      mac, address, name, rssi, battery, charging, protocol_ver, device_subtype,
      model, hardware_ver, software_ver, manufacturer, support_funs_json, raw_adv_json, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mac) DO UPDATE SET
      address = excluded.address,
      name = excluded.name,
      rssi = excluded.rssi,
      battery = excluded.battery,
      charging = excluded.charging,
      protocol_ver = excluded.protocol_ver,
      device_subtype = excluded.device_subtype,
      model = excluded.model,
      hardware_ver = excluded.hardware_ver,
      software_ver = excluded.software_ver,
      manufacturer = excluded.manufacturer,
      support_funs_json = excluded.support_funs_json,
      raw_adv_json = excluded.raw_adv_json,
      last_seen_at = excluded.last_seen_at
  `).run(
    mac, address, name, rssi, battery, charging, protocolVer, deviceSubtype,
    model, hardwareVer, softwareVer, manufacturer, supportFunsJson, rawAdvJson, nowMs,
  );
  return mapDeviceRow(db.prepare('SELECT * FROM devices WHERE mac = ?').get(mac));
}

function insertMeasurement(db, rec, nowMs) {
  const id = rec.id || `m-${nowMs}-${randomUUID().slice(0, 8)}`;
  const weightKg = roundTo(Number(rec.weightKg), 2);
  const weightJin = roundTo(rec.weightJin ?? weightKg * 2, 2);
  const weightLb = roundTo(rec.weightLb ?? weightKg * 2.20462, 2);
  const weightG = Math.round(rec.weightG ?? weightKg * 1000);
  const adcs = Array.isArray(rec.adcs) ? rec.adcs : [];
  const impedances = Array.isArray(rec.impedances) ? rec.impedances : [];
  const primaryOhm = firstValidResistance(impedances) ?? (impedances.length > 0 && Number.isFinite(Number(impedances[0])) ? Number(impedances[0]) : null);
  const secondaryOhm = impedances.length > 1 && Number.isFinite(Number(impedances[1])) ? Number(impedances[1]) : null;
  const impedanceMeasured = primaryOhm !== null && primaryOhm >= 100 && primaryOhm <= 1500 ? 1 : 0;

  if (rec.dedupKey) {
    const existing = db.prepare('SELECT id FROM measurements WHERE dedup_key = ?').get(rec.dedupKey);
    if (existing) return { id: existing.id, inserted: false };
  }

  db.prepare(`
    INSERT INTO measurements (
      id, dedup_key, profile_id, measured_at, source, device_mac,
      weight_kg, weight_jin, weight_lb, weight_g, stable, impedance_measured,
      adcs_json, impedances_json, primary_ohm, secondary_ohm, alg_type, heart_rate,
      battery, charging, rssi, calibration_mode, over_weight, dianji, raw_meta_json, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    rec.dedupKey ?? null,
    rec.profileId,
    rec.measuredAt ?? nowMs,
    rec.source ?? 'live',
    rec.deviceMac ?? null,
    weightKg,
    weightJin,
    weightLb,
    weightG,
    rec.stable === false ? 0 : 1,
    impedanceMeasured,
    JSON.stringify(adcs),
    JSON.stringify(impedances),
    primaryOhm,
    secondaryOhm,
    rec.algType ?? null,
    rec.heartRate ?? null,
    rec.battery ?? null,
    rec.charging === null || rec.charging === undefined ? null : (rec.charging ? 1 : 0),
    rec.rssi ?? null,
    rec.calibrationMode ?? null,
    rec.overWeight ?? null,
    rec.dianji ?? null,
    JSON.stringify(rec.rawMeta ?? {}),
    rec.note ?? null,
    nowMs,
  );
  return { id, inserted: true };
}

function resolveProfilesAndActive(db, requestedProfileId) {
  const rows = db.prepare('SELECT * FROM profiles ORDER BY is_default DESC, created_at ASC').all();
  const profiles = rows.map(mapProfileRow);
  const active = (requestedProfileId && profiles.find(p => p.id === requestedProfileId))
    || profiles.find(p => p.isDefault)
    || profiles[0];
  return { profiles, activeProfile: active };
}

function computeProfileReferenceWeight(db, profile) {
  const primaryRows = db.prepare(`
    SELECT weight_kg FROM measurements
    WHERE profile_id = ? AND source IN ('live', 'manual')
    ORDER BY measured_at DESC, created_at DESC
    LIMIT 7
  `).all(profile.id);
  const rows = primaryRows.length > 0
    ? primaryRows
    : db.prepare(`
      SELECT weight_kg FROM measurements
      WHERE profile_id = ?
      ORDER BY measured_at DESC, created_at DESC
      LIMIT 7
    `).all(profile.id);

  const weights = rows
    .map(r => Number(r.weight_kg))
    .filter(w => Number.isFinite(w) && w > 0)
    .sort((a, b) => a - b);
  if (weights.length > 0) {
    const mid = Math.floor(weights.length / 2);
    const median = weights.length % 2 === 1
      ? weights[mid]
      : (weights[mid - 1] + weights[mid]) / 2;
    return { weightKg: roundTo(median, 2), basis: 'records' };
  }

  const targetKg = asFiniteNumber(profile.targetWeightKg);
  if (targetKg !== undefined && targetKg > 0) {
    return { weightKg: roundTo(targetKg, 2), basis: 'target' };
  }

  const h = Number(profile.heightCm || 170) / 100;
  const bmiRef = profile.sex === 'female' ? 20.5 : 22.2;
  return { weightKg: roundTo(bmiRef * h * h, 2), basis: 'bmi_ref' };
}

/**
 * Resolve which member profile owns a weight measurement based on proximity to
 * each profile's reference weight, falling back to `fallbackProfileId` on ties/ambiguity.
 */
export function resolveMeasurementProfile(
  db,
  profiles,
  fallbackProfileId,
  weightKg,
  { source = 'live', explicitProfile = false } = {},
) {
  if (!Array.isArray(profiles) || profiles.length === 0) return null;
  const fallback = (fallbackProfileId && profiles.find(p => p.id === fallbackProfileId))
    || profiles.find(p => p.isDefault)
    || profiles[0];
  if (profiles.length === 1 || !(Number(weightKg) > 0)) return fallback;
  if (source === 'manual' && explicitProfile) return fallback;

  const targetKg = Number(weightKg);
  const scored = profiles.map(profile => {
    const ref = computeProfileReferenceWeight(db, profile);
    return { profile, diff: Math.abs(targetKg - ref.weightKg) };
  }).sort((a, b) => a.diff - b.diff);

  const best = scored[0];
  const fallbackEntry = scored.find(s => s.profile.id === fallback.id) || best;
  if (!best || best.profile.id === fallback.id) return fallback;

  const marginKg = source === 'history' ? 1.5 : 2.5;
  return (fallbackEntry.diff - best.diff) >= marginKg ? best.profile : fallback;
}

function computeDeltas(records, activeProfile, nowMs) {
  if (!records.length) return null;
  const latest = records[0];
  const prev = records[1];
  const prevDiffKg = prev ? roundTo(latest.weightKg - prev.weightKg, 2) : null;
  const prevFatDiff = prev && latest.metrics && prev.metrics
    ? roundTo(latest.metrics.bodyFatPercent - prev.metrics.bodyFatPercent, 1)
    : null;

  const day7 = records.filter(r => r.measuredAt >= nowMs - 7 * 86400_000);
  const day30 = records.filter(r => r.measuredAt >= nowMs - 30 * 86400_000);
  const avg = arr => arr.length ? roundTo(arr.reduce((s, r) => s + r.weightKg, 0) / arr.length, 2) : null;

  const weights = records.map(r => r.weightKg);
  const targetDiffKg = activeProfile?.targetWeightKg
    ? roundTo(latest.weightKg - activeProfile.targetWeightKg, 2)
    : null;

  return {
    prevDiffKg,
    prevFatDiff,
    avg7dKg: avg(day7),
    avg30dKg: avg(day30),
    minWeightKg: roundTo(Math.min(...weights), 2),
    maxWeightKg: roundTo(Math.max(...weights), 2),
    targetDiffKg,
    totalCount: records.length,
  };
}

/** @param {any} db @param {string} dataDir @param {{ profileId?: string | null; limit?: number; nowMs: number; config?: Record<string, any> }} opts */
function buildDashboardData(db, dataDir, { profileId = null, limit = 120, nowMs, config = DEFAULT_CONFIG }) {
  const { profiles, activeProfile } = resolveProfilesAndActive(db, profileId);
  const devRow = db.prepare('SELECT * FROM devices ORDER BY last_seen_at DESC LIMIT 1').get();
  const device = mapDeviceRow(devRow);

  if (!activeProfile) {
    const liveSession = readLiveSessionSnapshot(dataDir, db, null, nowMs, false);
    return {
      profiles,
      activeProfileId: null,
      activeProfile: null,
      needsProfile: true,
      device,
      liveSession,
      latest: null,
      deltas: null,
      records: [],
      config: {
        targetMac: config.targetMac || '',
        namePrefix: config.namePrefix || DEFAULT_NAME_PREFIX,
        hasDefaultProfile: Boolean(config.defaultProfile),
      },
    };
  }

  const safeLimit = clamp(asInt(limit) ?? 120, 1, 500);
  const rows = db.prepare(`
    SELECT * FROM measurements
    WHERE profile_id = ?
    ORDER BY measured_at DESC, created_at DESC
    LIMIT ?
  `).all(activeProfile.id, safeLimit);

  const records = rows.map(r => mapMeasurementRow(r, activeProfile));
  for (let i = 0; i < records.length; i++) {
    const older = records[i + 1];
    records[i].deltaFromPrevKg = older ? roundTo(records[i].weightKg - older.weightKg, 2) : null;
  }

  const latest = records[0] || null;
  const deltas = computeDeltas(records, activeProfile, nowMs);
  const liveSession = readLiveSessionSnapshot(dataDir, db, activeProfile.id, nowMs, false);

  return {
    profiles,
    activeProfileId: activeProfile.id,
    activeProfile,
    needsProfile: false,
    device,
    liveSession,
    latest,
    deltas,
    records,
    config: {
      targetMac: config.targetMac || '',
      namePrefix: config.namePrefix || DEFAULT_NAME_PREFIX,
      hasDefaultProfile: Boolean(config.defaultProfile),
    },
  };
}

// ---------------------------------------------------------------------------
// Live Session Inspection & Scale27 Decoding
// ---------------------------------------------------------------------------

function sessionFilePath(dataDir) {
  return join(dataDir, 'live-session.json');
}

function decodeNotifications(notifications) {
  const protocol = new Scale27Protocol();
  let latestWeight = /** @type {Record<string, any> | null} */ (null);
  let latestStableWeight = /** @type {Record<string, any> | null} */ (null);
  let latestDynamicWeight = /** @type {Record<string, any> | null} */ (null);
  let latestAdc = /** @type {Record<string, any> | null} */ (null);
  const historyEvents = [];
  const settingEvents = [];

  for (const item of notifications || []) {
    const hex = typeof item === 'string' ? item : item?.hex;
    if (!hex) continue;
    const res = protocol.feed(hex);
    for (const ev of res.events) {
      if (ev.kind === 'weight') {
        latestWeight = { ...(latestWeight || {}), ...ev };
        if (ev.stable && ev.weightKg > 0) {
          latestStableWeight = { ...latestWeight };
        } else if (ev.weightKg > 0) {
          latestDynamicWeight = { ...latestWeight };
        }
      } else if (ev.kind === 'adc') {
        const hasValidImp = firstValidResistance(ev.impedances) !== undefined;
        const prevValidImp = latestAdc ? firstValidResistance(latestAdc.impedances) !== undefined : false;
        if (!latestAdc || hasValidImp || (!prevValidImp && (ev.weightKg ?? 0) > 0)) {
          latestAdc = ev;
        }
      } else if (ev.kind === 'history') {
        historyEvents.push(ev);
      } else if (ev.kind === 'setting') {
        settingEvents.push(ev);
      }
    }
  }
  const effectiveWeight = latestStableWeight ?? latestDynamicWeight ?? latestWeight;
  return {
    latestWeight: /** @type {Record<string, any> | null} */ (effectiveWeight
      ? {
          ...(latestWeight || {}),
          ...effectiveWeight,
          stable: Boolean(latestStableWeight),
        }
      : null),
    latestStableWeight,
    latestAdc,
    historyEvents,
    settingEvents,
  };
}

function readLiveSessionSnapshot(dataDir, db, activeProfileId, nowMs, ingestCompleted = true) {
  const path = sessionFilePath(dataDir);
  if (!existsSync(path)) return null;

  const raw = safeJsonParse(readFileSync(path, 'utf8'), null);
  if (!raw || typeof raw !== 'object') return null;

  let phase = raw.phase || 'idle';
  let message = raw.message || '';
  let error = raw.error || null;

  const activePhases = new Set(['scanning', 'connecting', 'measuring']);
  if (activePhases.has(phase) && raw.pid && !isBleHelperPid(Number(raw.pid))) {
    // Process exited unexpectedly without writing terminal phase
    phase = 'error';
    error = error || '蓝牙采集进程已退出，请重新发起测量';
    message = error;
    try {
      writeJsonAtomic(path, { ...raw, phase, error, message, updatedAt: nowMs });
    } catch { /* ignore */ }
  }

  const decoded = decodeNotifications(raw.notifications || []);
  const parsedAdv = raw.device ? parseScaleAdvertisement(raw.device) : null;
  const devMac = normalizeMac(
    raw.deviceInfo?.mac || parsedAdv?.mac || raw.device?.address || '',
  );

  if (devMac && (raw.device || Object.keys(raw.deviceInfo || {}).length > 0 || decoded.latestWeight)) {
    upsertDevice(db, {
      mac: devMac,
      address: raw.device?.address || devMac,
      name: raw.device?.name || parsedAdv?.name || 'AFU-WL-TZ-A1',
      rssi: raw.device?.rssi,
      battery: decoded.latestWeight?.battery,
      charging: decoded.latestWeight?.charging,
      protocolVer: parsedAdv?.protocolVer,
      deviceSubtype: parsedAdv?.deviceSubtype,
      model: raw.deviceInfo?.model,
      hardwareVer: raw.deviceInfo?.hardware,
      softwareVer: raw.deviceInfo?.software,
      manufacturer: raw.deviceInfo?.manufacturer,
      supportFuns: decoded.latestWeight?.supportFuns,
      rawAdv: parsedAdv || raw.device || null,
    }, nowMs);
  }

  const { profiles } = resolveProfilesAndActive(db, activeProfileId);
  const ingestedIds = [];
  const targetProfileId = raw.profileId || activeProfileId || null;
  const readoutWeight = decoded.latestStableWeight
    ?? (decoded.latestAdc?.weightKg && decoded.latestAdc.weightKg > 0 ? decoded.latestAdc : null)
    ?? decoded.latestWeight;
  const readoutKg = readoutWeight?.weightKg ?? null;
  const matchedLiveProfile = (readoutKg && readoutKg > 0)
    ? resolveMeasurementProfile(db, profiles, targetProfileId, readoutKg, { source: 'live' })
    : null;
  let finalLiveProfile = matchedLiveProfile;

  if (ingestCompleted && targetProfileId) {
    for (const h of decoded.historyEvents) {
      if (!h.weight || !(h.weight.weightKg > 0)) continue;
      const histProfile = resolveMeasurementProfile(
        db,
        profiles,
        targetProfileId,
        h.weight.weightKg,
        { source: 'history' },
      );
      const tsMs = h.time && h.time > 1_000_000_000 ? h.time * 1000 : nowMs;
      const dedupKey = `history:${devMac}:${h.time || 0}:${h.weight.weightG}`;
      const res = insertMeasurement(db, {
        dedupKey,
        profileId: histProfile?.id || targetProfileId,
        measuredAt: tsMs,
        source: 'history',
        deviceMac: devMac,
        weightKg: h.weight.weightKg,
        weightJin: h.weight.weightJin,
        weightLb: h.weight.weightLb,
        weightG: h.weight.weightG,
        stable: true,
        adcs: h.adcs || [],
        impedances: h.impedances || [],
        algType: h.algType ?? null,
        heartRate: h.hr && h.hr > 0 ? h.hr : null,
        battery: decoded.latestWeight?.battery ?? null,
        charging: decoded.latestWeight?.charging ?? null,
        rssi: raw.device?.rssi ?? null,
        rawMeta: { historyType: h.historyType, remainHistoryCount: h.remainHistoryCount, unit: h.unit },
        note: '秤端离线缓存同步',
      }, nowMs);
      if (res.inserted) ingestedIds.push(res.id);
    }

    if (phase === 'completed') {
      const adcWeight = decoded.latestAdc?.weightKg && decoded.latestAdc.weightKg > 0 ? decoded.latestAdc : null;
      const lockedWeight = decoded.latestStableWeight ?? null;
      const primaryWeight = lockedWeight ?? adcWeight ?? decoded.latestWeight;
      const weightKg = primaryWeight?.weightKg;
      const isStable = Boolean(
        lockedWeight || (decoded.latestAdc && firstValidResistance(decoded.latestAdc.impedances) !== undefined),
      );
      if (weightKg && weightKg > 0) {
        finalLiveProfile = resolveMeasurementProfile(db, profiles, targetProfileId, weightKg, { source: 'live' });
        const adcs = decoded.latestAdc?.adcs || [];
        const impedances = decoded.latestAdc?.impedances || normalizeImpedances(adcs, weightKg);
        const dedupKey = `live:${raw.sessionId}`;
        const res = insertMeasurement(db, {
          dedupKey,
          profileId: finalLiveProfile?.id || targetProfileId,
          measuredAt: raw.updatedAt || nowMs,
          source: 'live',
          deviceMac: devMac,
          weightKg,
          weightJin: primaryWeight?.weightJin ?? roundTo(weightKg * 2, 2),
          weightLb: primaryWeight?.weightLb ?? roundTo(weightKg * 2.20462, 2),
          weightG: primaryWeight?.weightG ?? Math.round(weightKg * 1000),
          stable: isStable,
          adcs,
          impedances,
          algType: decoded.latestAdc?.algType ?? primaryWeight?.algType ?? null,
          battery: decoded.latestWeight?.battery ?? null,
          charging: decoded.latestWeight?.charging ?? null,
          rssi: raw.device?.rssi ?? null,
          calibrationMode: decoded.latestWeight?.calibrationMode ?? null,
          overWeight: decoded.latestWeight?.overWeight ?? null,
          dianji: decoded.latestAdc?.dianji ?? primaryWeight?.dianji ?? null,
          rawMeta: {
            unit: decoded.latestAdc?.unit ?? primaryWeight?.unit,
            supportFuns: decoded.latestWeight?.supportFuns ?? [],
            supportHr: decoded.latestWeight?.supportHr,
            supportPh: decoded.latestWeight?.supportPh,
            supportZx: decoded.latestWeight?.supportZx,
            hasTemperature: decoded.latestWeight?.hasTemperature,
            deviceInfo: raw.deviceInfo || {},
            notificationsCount: (raw.notifications || []).length,
          },
        }, nowMs);
        if (res.inserted) ingestedIds.push(res.id);
      }
    }
  }

  const hasValidImpedance = Boolean(decoded.latestAdc && firstValidResistance(decoded.latestAdc.impedances) !== undefined);
  const liveReadout = decoded.latestAdc || decoded.latestWeight
    ? {
        weightKg: readoutWeight?.weightKg ?? null,
        weightJin: readoutWeight?.weightJin ?? (readoutWeight?.weightKg ? roundTo(readoutWeight.weightKg * 2, 2) : null),
        stable: Boolean(hasValidImpedance || decoded.latestStableWeight),
        impedanceMeasured: hasValidImpedance,
        adcs: decoded.latestAdc?.adcs || [],
        impedances: decoded.latestAdc?.impedances || [],
        battery: decoded.latestWeight?.battery ?? null,
        charging: decoded.latestWeight?.charging ?? null,
        dianji: decoded.latestAdc?.dianji ?? decoded.latestWeight?.dianji ?? null,
        packetCount: (raw.notifications || []).length,
      }
    : null;

  return {
    sessionId: raw.sessionId,
    profileId: raw.profileId || activeProfileId,
    matchedProfileId: finalLiveProfile?.id || targetProfileId,
    matchedProfileName: finalLiveProfile?.name || null,
    pid: raw.pid,
    phase,
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    timeoutSec: raw.timeoutSec ?? 45,
    message,
    error,
    device: raw.device || null,
    deviceInfo: raw.deviceInfo || {},
    liveReadout,
    historySyncedCount: decoded.historyEvents.length,
    ingestedIds,
  };
}

// ---------------------------------------------------------------------------
// BLE Subprocess Runners (Injectable for tests)
// ---------------------------------------------------------------------------

async function defaultBleRunner(commandArgs, timeoutMs = 15_000, signal) {
  const { stdout } = await execFileAsync('python3', [HELPER_PATH, ...commandArgs], {
    cwd: PLUGIN_DIR,
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  return JSON.parse(String(stdout || '{}').trim() || '{}');
}

function defaultSpawnMeasure(commandArgs) {
  const child = spawn('python3', [HELPER_PATH, ...commandArgs], {
    cwd: PLUGIN_DIR,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

// ---------------------------------------------------------------------------
// Action Handlers
// ---------------------------------------------------------------------------

function disabledBleResult() {
  return {
    ok: false,
    notify: true,
    title: '当前系统已关闭蓝牙体脂秤',
    message: `沃莱 A1 蓝牙采集依赖 Linux BlueZ D-Bus，在当前平台（${process.platform}）已动态关闭。`,
  };
}

async function handleScan(ctx) {
  if (process.platform !== 'linux' && !ctx.hasInjectedBleRunner && !ctx.hasInjectedSpawnMeasure) {
    return disabledBleResult();
  }
  const timeoutSec = clamp(asFiniteNumber(ctx.args.timeoutSec ?? ctx.args.timeout) ?? 4, 1, 15);
  const targetMac = normalizeMac(ctx.args.targetMac ?? ctx.config.targetMac ?? DEFAULT_SCALE_MAC);
  const namePrefix = String(ctx.args.namePrefix ?? ctx.config.namePrefix ?? DEFAULT_NAME_PREFIX).trim() || DEFAULT_NAME_PREFIX;

  const raw = await ctx.bleRunner(
    ['scan', '--timeout', String(timeoutSec), '--target-mac', targetMac, '--name-prefix', namePrefix],
    (timeoutSec + 6) * 1000,
    ctx.signal,
  );
  if (!raw || raw.ok === false) {
    throw new Error(raw?.error || '蓝牙扫描失败');
  }

  const parsedDevices = [];
  for (const dev of raw.devices || []) {
    const adv = parseScaleAdvertisement(dev);
    const saved = upsertDevice(ctx.db, {
      mac: adv?.mac || dev.address,
      address: dev.address,
      name: adv?.name || dev.name || 'AFU-WL-TZ-A1',
      rssi: dev.rssi,
      protocolVer: adv?.protocolVer,
      deviceSubtype: adv?.deviceSubtype,
      rawAdv: { ...dev, parsed: adv },
    }, ctx.nowMs);
    parsedDevices.push({ ...dev, parsed: adv, stored: saved });
  }

  const devRow = ctx.db.prepare('SELECT * FROM devices ORDER BY last_seen_at DESC LIMIT 1').get();
  const device = mapDeviceRow(devRow);
  const count = parsedDevices.length;
  const top = parsedDevices[0];
  const msg = count > 0
    ? `发现沃莱体脂秤 ${top.name || 'AFU-WL-TZ-A1'} (${top.address})，信号 ${top.rssi ?? '--'} dBm。`
    : '本次未扫到唤醒中的沃莱 A1（秤熄屏休眠时不广播，请踩亮秤面后重试）。';

  return {
    ok: true,
    notify: false,
    title: '蓝牙扫描完成',
    message: msg,
    data: {
      adapter: raw.adapter || null,
      devices: parsedDevices,
      device,
      scannedAt: raw.scannedAt || ctx.nowMs,
    },
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
          // ignore cleanup failure
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
          // ignore race
        }
        continue;
      }
      return null;
    }
  }
  return null;
}

async function handleMeasureStart(ctx) {
  if (process.platform !== 'linux' && !ctx.hasInjectedBleRunner && !ctx.hasInjectedSpawnMeasure) {
    return disabledBleResult();
  }
  const { activeProfile } = resolveProfilesAndActive(ctx.db, ctx.args.profileId);
  if (!activeProfile) {
    return {
      ok: false,
      notify: true,
      title: '需要创建健康档案',
      message: '尚未配置健康档案，请先调用 profile-save 创建成员档案（填写 name、sex、age、heightCm），或先在 config.json 中设置 defaultProfile。',
      data: { needsProfile: true },
    };
  }
  const timeoutSec = clamp(asFiniteNumber(ctx.args.timeoutSec ?? ctx.args.timeout) ?? 45, 10, 120);
  const targetMac = normalizeMac(ctx.args.targetMac ?? ctx.config.targetMac ?? DEFAULT_SCALE_MAC);
  const namePrefix = String(ctx.args.namePrefix ?? ctx.config.namePrefix ?? DEFAULT_NAME_PREFIX).trim() || DEFAULT_NAME_PREFIX;
  const sPath = sessionFilePath(ctx.dataDir);

  return withFileLock(sPath, async () => {
    const releaseLock = acquireSessionLockFile(ctx.dataDir);
    if (!releaseLock) {
      return {
        ok: false,
        notify: false,
        title: '蓝牙测量启动繁忙',
        message: '已有另一路蓝牙测量会话正在初始化，请稍后重试或先执行 measure-stop。',
      };
    }

    try {
      if (existsSync(sPath)) {
        const existing = readJsonSafe(sPath, null);
        if (existing?.pid) {
          await terminateBleHelperPid(Number(existing.pid));
        }
      }

      const devRow = ctx.db.prepare('SELECT * FROM devices ORDER BY last_seen_at DESC LIMIT 1').get();
      const txPacket = encodeTimeAndUserInfo27({
        deviceType: 0x27,
        protocolVer: devRow?.protocol_ver ?? 1,
        user: {
          age: activeProfile.age,
          heightCm: activeProfile.heightCm,
          sex: activeProfile.sex,
          unit: activeProfile.unit,
        },
        nowMs: ctx.nowMs,
      });

      const sessionId = `meas-${ctx.nowMs}-${randomUUID().slice(0, 6)}`;
      const initialSession = {
        sessionId,
        profileId: activeProfile.id,
        pid: null,
        phase: 'scanning',
        startedAt: ctx.nowMs,
        updatedAt: ctx.nowMs,
        timeoutSec,
        message: '正在启动蓝牙测量会话，请赤脚上秤…',
        device: null,
        deviceInfo: {},
        notifications: [],
        error: null,
      };
      writeJsonAtomic(sPath, initialSession);

      const pid = ctx.spawnMeasure([
        'measure',
        '--state-file', sPath,
        '--session-id', sessionId,
        '--profile-id', activeProfile.id,
        '--timeout', String(timeoutSec),
        '--target-mac', targetMac,
        '--name-prefix', namePrefix,
        '--tx-packet-hex', txPacket.toString('hex').toUpperCase(),
      ]);

      // Brief read-only wait (up to 250ms) for Python helper to flush initial state without overwriting sPath
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 50));
        const cur = readJsonSafe(sPath, null);
        if (cur && cur.sessionId === sessionId && cur.pid) {
          break;
        }
      }

      const postCur = readJsonSafe(sPath, null);
      if (postCur && postCur.sessionId === sessionId && !postCur.pid && typeof pid === 'number' && pid > 0) {
        writeJsonAtomic(sPath, { ...postCur, pid });
      }

      const session = readLiveSessionSnapshot(ctx.dataDir, ctx.db, activeProfile.id, ctx.nowMs, false)
        || { ...initialSession, pid };
      session.profileId = session.profileId || activeProfile.id;

      const targetDesc = targetMac ? `${namePrefix} (${targetMac})` : `${namePrefix} (自动扫描匹配)`;
      return {
        ok: true,
        notify: false,
        title: '已启动实时称重测量',
        message: `沃莱 A1 ${targetDesc} 已就绪，请赤脚站上体脂秤（${timeoutSec} 秒内有效）。`,
        data: { session },
      };
    } finally {
      releaseLock();
    }
  });
}

async function handleMeasureStatus(ctx) {
  const { activeProfile } = resolveProfilesAndActive(ctx.db, ctx.args.profileId);
  const activeId = activeProfile?.id ?? null;
  const session = readLiveSessionSnapshot(ctx.dataDir, ctx.db, activeId, ctx.nowMs, true);
  if (!session) {
    return {
      ok: true,
      notify: false,
      title: '无进行中的测量',
      message: '当前没有正在运行的蓝牙测量会话。',
      data: { session: null, dashboard: buildDashboardData(ctx.db, ctx.dataDir, { profileId: activeId, nowMs: ctx.nowMs, config: ctx.config }) },
    };
  }

  const effectiveProfileId = (!ctx.args.lockProfile && session?.matchedProfileId)
    ? session.matchedProfileId
    : (session.profileId || activeId);
  const dashboard = buildDashboardData(ctx.db, ctx.dataDir, {
    profileId: effectiveProfileId,
    nowMs: ctx.nowMs,
    config: ctx.config,
  });

  return {
    ok: true,
    notify: false,
    title: session.phase === 'completed' ? '体脂测量完成' : '实时测量状态',
    message: session.message || `测量状态: ${session.phase}`,
    data: {
      session,
      dashboard,
    },
  };
}

function mergeSessionNotifications(a, b) {
  const out = [];
  const seen = new Set();
  for (const list of [a, b]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const hex = typeof item === 'string' ? item : item?.hex;
      const at = typeof item === 'object' && item ? item.at : '';
      const key = `${at}:${hex ?? ''}`;
      if (!hex || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

async function handleMeasureStop(ctx) {
  const sPath = sessionFilePath(ctx.dataDir);
  const hadSession = existsSync(sPath);
  if (hadSession) {
    await withFileLock(sPath, async () => {
      const before = readJsonSafe(sPath, null);
      if (before?.pid) {
        await terminateBleHelperPid(Number(before.pid));
      }
      // Re-read after terminating helper so final flushed notifications & offline history frames are preserved.
      const latest = readJsonSafe(sPath, before) || before;
      if (latest) {
        const sameSession = !before?.sessionId || !latest?.sessionId || before.sessionId === latest.sessionId;
        const mergedNotifications = sameSession
          ? mergeSessionNotifications(before?.notifications, latest.notifications)
          : (Array.isArray(latest.notifications) ? latest.notifications : []);
        const next = {
          ...latest,
          notifications: mergedNotifications,
          phase: latest.phase === 'completed' ? 'completed' : 'stopped',
          message: latest.phase === 'completed' ? latest.message : '已手动停止本次蓝牙测量',
          updatedAt: ctx.nowMs,
        };
        writeJsonAtomic(sPath, next);
      }
    });
  }
  if (process.platform !== 'linux' && !ctx.hasInjectedBleRunner && !ctx.hasInjectedSpawnMeasure && !hadSession) {
    return disabledBleResult();
  }
  const { activeProfile } = resolveProfilesAndActive(ctx.db, ctx.args.profileId);
  const session = readLiveSessionSnapshot(ctx.dataDir, ctx.db, activeProfile?.id ?? null, ctx.nowMs, true);
  return {
    ok: true,
    notify: false,
    title: '已停止蓝牙测量',
    message: '已停止当前测量会话并释放体脂秤连接。',
    data: { session },
  };
}

function handleProfileSave(ctx) {
  const args = ctx.args;
  const requestedId = args.id ? String(args.id).trim() : '';
  const name = String(args.name || '').trim();
  const sexRaw = args.sex !== undefined ? String(args.sex).trim() : '';
  const sex = sexRaw ? normalizeSexInput(sexRaw) : undefined;
  const age = args.age !== undefined && args.age !== null && args.age !== '' ? asInt(args.age) : undefined;
  const rawHeight = args.heightCm ?? args.height;
  const heightCm = rawHeight !== undefined && rawHeight !== null && rawHeight !== '' ? asFiniteNumber(rawHeight) : undefined;
  const targetWeightKg = args.targetWeightKg !== undefined
    ? (args.targetWeightKg === null || args.targetWeightKg === '' ? null : asFiniteNumber(args.targetWeightKg))
    : undefined;
  const unitRaw = args.unit !== undefined ? String(args.unit).trim().toLowerCase() : undefined;
  const unit = unitRaw ? (unitRaw === 'jin' || unitRaw === '斤' ? 'jin' : 'kg') : undefined;
  const setDefault = Boolean(args.setDefault);

  if (sexRaw && !sex) throw new Error('性别需为 male/female（或 男/女）');
  if (age !== undefined && (age < 5 || age > 120)) throw new Error('年龄需在 5 ~ 120 岁之间');
  if (heightCm !== undefined && (heightCm < 80 || heightCm > 230)) throw new Error('身高需在 80 ~ 230 cm 之间');
  if (targetWeightKg !== undefined && targetWeightKg !== null && (targetWeightKg < 20 || targetWeightKg > 250)) {
    throw new Error('目标体重需在 20 ~ 250 kg 之间');
  }

  let targetId = requestedId;
  const existing = targetId ? ctx.db.prepare('SELECT * FROM profiles WHERE id = ?').get(targetId) : null;

  if (!existing && (!name || !sex || age === undefined || heightCm === undefined)) {
    throw new Error('新建成员档案必须填写名称 (name)、性别 (sex)、年龄 (age) 和身高 (heightCm)');
  }

  const totalProfiles = ctx.db.prepare('SELECT COUNT(*) AS cnt FROM profiles').get().cnt;
  const makeDefault = setDefault || (!existing && totalProfiles === 0 && args.setDefault !== false);

  if (makeDefault) {
    ctx.db.prepare('UPDATE profiles SET is_default = 0').run();
  }

  if (existing) {
    ctx.db.prepare(`
      UPDATE profiles
      SET name = ?, sex = ?, age = ?, height_cm = ?, target_weight_kg = ?, unit = ?,
          is_default = ?, updated_at = ?
      WHERE id = ?
    `).run(
      name || existing.name,
      sex || existing.sex,
      age ?? existing.age,
      heightCm ?? existing.height_cm,
      targetWeightKg !== undefined ? targetWeightKg : existing.target_weight_kg,
      unit || existing.unit,
      makeDefault ? 1 : existing.is_default,
      ctx.nowMs,
      existing.id,
    );
    targetId = existing.id;
  } else {
    targetId = targetId || `p-${randomUUID().slice(0, 8)}`;
    ctx.db.prepare(`
      INSERT INTO profiles (id, name, sex, age, height_cm, target_weight_kg, unit, is_default, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      targetId,
      name,
      sex,
      age,
      heightCm,
      targetWeightKg ?? null,
      unit || 'kg',
      makeDefault ? 1 : 0,
      ctx.nowMs,
      ctx.nowMs,
    );
  }

  const dashboard = buildDashboardData(ctx.db, ctx.dataDir, { profileId: targetId, nowMs: ctx.nowMs, config: ctx.config });
  return {
    ok: true,
    notify: false,
    title: '成员档案已保存',
    message: `已保存健康档案「${dashboard.activeProfile.name}」(${dashboard.activeProfile.sex === 'male' ? '男' : '女'} · ${dashboard.activeProfile.age}岁 · ${dashboard.activeProfile.heightCm}cm)。`,
    data: dashboard,
  };
}

function handleProfileDelete(ctx) {
  const id = String(ctx.args.id || '').trim();
  if (!id) throw new Error('缺少档案 ID');
  const existing = ctx.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
  if (!existing) throw new Error(`未找到档案: ${id}`);
  const total = ctx.db.prepare('SELECT COUNT(*) AS cnt FROM profiles').get().cnt;
  if (total <= 1) throw new Error('至少需要保留一个默认健康档案');
  if (existing.is_default) throw new Error('不能直接删除默认档案，请先将其他成员设为默认');

  ctx.db.prepare('DELETE FROM measurements WHERE profile_id = ?').run(id);
  ctx.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);

  const dashboard = buildDashboardData(ctx.db, ctx.dataDir, { nowMs: ctx.nowMs, config: ctx.config });
  return {
    ok: true,
    notify: false,
    title: '已删除成员档案',
    message: `已移除成员档案「${existing.name}」及其记录。`,
    data: dashboard,
  };
}

function handleRecordAdd(ctx) {
  const { profiles, activeProfile } = resolveProfilesAndActive(ctx.db, ctx.args.profileId);
  if (!activeProfile) {
    throw new Error('尚未创建成员健康档案，请先调用 profile-save 创建档案后再补录体重。');
  }
  const rawWeight = asFiniteNumber(ctx.args.weightKg ?? ctx.args.weight);
  const inputUnit = String(ctx.args.unit || 'kg').trim().toLowerCase();
  if (rawWeight === undefined || rawWeight <= 0) {
    throw new Error('请输入有效的体重数值');
  }
  const weightKg = inputUnit === 'jin' || inputUnit === '斤' ? roundTo(rawWeight / 2, 2) : roundTo(rawWeight, 2);
  if (weightKg < 5 || weightKg > 250) {
    throw new Error('体重应在 5 ~ 250 kg 之间');
  }

  const explicitProfile = Boolean(ctx.args.profileId && String(ctx.args.profileId).trim());
  const targetProfile = explicitProfile
    ? activeProfile
    : (resolveMeasurementProfile(ctx.db, profiles, activeProfile.id, weightKg, { source: 'manual', explicitProfile: false }) || activeProfile);

  const imp = asFiniteNumber(ctx.args.impedanceOhm ?? ctx.args.impedance);
  const impedances = imp !== undefined && imp > 0 ? [imp] : [];
  const measuredAt = asInt(ctx.args.measuredAt) ?? (ctx.args.measuredAtIso ? Date.parse(String(ctx.args.measuredAtIso)) : ctx.nowMs);
  const finalTs = Number.isFinite(measuredAt) ? measuredAt : ctx.nowMs;
  const heartRate = asInt(ctx.args.heartRate);
  const note = ctx.args.note ? String(ctx.args.note).trim() : '手动补录';

  const res = insertMeasurement(ctx.db, {
    profileId: targetProfile.id,
    measuredAt: finalTs,
    source: 'manual',
    weightKg,
    impedances,
    adcs: impedances,
    heartRate: heartRate && heartRate > 0 ? heartRate : null,
    note,
  }, ctx.nowMs);

  const dashboard = buildDashboardData(ctx.db, ctx.dataDir, { profileId: targetProfile.id, nowMs: ctx.nowMs, config: ctx.config });
  return {
    ok: true,
    notify: false,
    title: '已添加体重记录',
    message: `已为「${targetProfile.name}」补录 ${weightKg.toFixed(2)} kg (${(weightKg * 2).toFixed(2)} 斤)。`,
    data: {
      insertedId: res.id,
      ...dashboard,
    },
  };
}

function handleRecordDelete(ctx) {
  const id = String(ctx.args.id || '').trim();
  if (!id) throw new Error('缺少记录 ID');
  const existing = ctx.db.prepare('SELECT id, profile_id FROM measurements WHERE id = ?').get(id);
  if (!existing) throw new Error(`未找到测量记录: ${id}`);
  ctx.db.prepare('DELETE FROM measurements WHERE id = ?').run(id);
  const dashboard = buildDashboardData(ctx.db, ctx.dataDir, {
    profileId: ctx.args.profileId || existing.profile_id,
    nowMs: ctx.nowMs,
    config: ctx.config,
  });
  return {
    ok: true,
    notify: false,
    title: '已删除测量记录',
    message: `已删除测量记录 ${id}。`,
    data: dashboard,
  };
}

function handleDashboard(ctx) {
  const dashboard = buildDashboardData(ctx.db, ctx.dataDir, {
    profileId: ctx.args.profileId,
    limit: ctx.args.limit,
    nowMs: ctx.nowMs,
    config: ctx.config,
  });
  if (!dashboard.activeProfile) {
    return {
      ok: true,
      notify: false,
      title: '需要创建健康档案',
      message: '尚未创建成员健康档案，请先调用 profile-save 创建档案（或配置 config.json.defaultProfile）。',
      data: dashboard,
    };
  }
  return {
    ok: true,
    notify: false,
    title: '健康管理全量看板',
    message: dashboard.latest
      ? `「${dashboard.activeProfile.name}」最新体重 ${dashboard.latest.weightKg.toFixed(2)} kg，体脂 ${dashboard.latest.metrics?.bodyFatPercent ?? '--'}%，评分 ${dashboard.latest.metrics?.bodyScore ?? '--'}。`
      : `「${dashboard.activeProfile.name}」尚无称重记录。`,
    data: dashboard,
  };
}

function handleStatus(ctx) {
  const dashboard = buildDashboardData(ctx.db, ctx.dataDir, {
    profileId: ctx.args.profileId,
    limit: 30,
    nowMs: ctx.nowMs,
    config: ctx.config,
  });
  const { activeProfile, latest, deltas, device } = dashboard;
  if (!activeProfile) {
    return {
      ok: true,
      notify: Boolean(ctx.args.notify),
      title: '沃莱 A1 健康状态（待建档）',
      message: `尚未创建健康档案，请先调用 profile-save 创建成员档案（填写性别、年龄、身高），或在 config.json 中设置 defaultProfile。${device ? `\n设备：${device.name} (${device.mac})` : ''}`,
      data: dashboard,
    };
  }
  const lines = [`【健康管理 · ${activeProfile.name}】`];
  if (latest && latest.metrics) {
    const m = latest.metrics;
    const diffStr = deltas?.prevDiffKg !== null && deltas?.prevDiffKg !== undefined
      ? `（较上次 ${deltas.prevDiffKg >= 0 ? '+' : ''}${deltas.prevDiffKg.toFixed(2)} kg）`
      : '';
    lines.push(
      `最新测量：${new Date(latest.measuredAt).toLocaleString('zh-CN', { hour12: false })}`,
      `体重：${m.weightKg.toFixed(2)} kg / ${m.weightJin.toFixed(2)} 斤 ${diffStr}`,
      `BMI：${m.bmi} (${m.bmiCategory}) · 体型：${m.bodyType} · 综合评分：${m.bodyScore}/100`,
      `体脂率：${m.bodyFatPercent}% (${m.fatMassKg} kg) · 骨骼肌：${m.skeletalMusclePercent}% (${m.skeletalMuscleMassKg} kg)`,
      `水分：${m.waterPercent}% · 蛋白质：${m.proteinPercent}% · 内脏脂肪：${m.visceralFatLevel} 级 · 基础代谢：${m.bmrKcal} kcal`,
      m.resistanceOhm ? `生物电阻抗：${m.resistanceOhm} Ω (${m.formulaModel})` : `估算模式：无阻抗仅 BMI (${m.formulaModel})`,
    );
    if (deltas?.avg7dKg !== null && deltas?.avg7dKg !== undefined) {
      lines.push(`7日均重：${deltas.avg7dKg.toFixed(2)} kg · 共 ${deltas.totalCount} 条记录`);
    }
  } else {
    lines.push('暂无体重测量记录，请在网页顶栏「❤️ 健康管理」或对我说「开始上秤测量」完成首次同步。');
  }
  if (device) {
    lines.push(`设备：${device.name} (${device.mac}) · 电量 ${device.battery ?? '--'}% · RSSI ${device.rssi ?? '--'} dBm`);
  }

  return {
    ok: true,
    notify: Boolean(ctx.args.notify),
    title: '沃莱 A1 健康状态',
    message: lines.join('\n'),
    data: dashboard,
  };
}

function handleConfig(ctx) {
  const { args, paths } = ctx;
  const next = loadScaleConfig(paths.configPath);
  let changed = false;

  if (args.targetMac !== undefined) {
    const mac = normalizeMac(args.targetMac);
    if (mac && !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) {
      throw new Error(`targetMac "${args.targetMac}" 格式无效（示例 AA:BB:CC:DD:EE:FF 或空字符串）`);
    }
    next.targetMac = mac;
    changed = true;
  }
  if (args.namePrefix !== undefined) {
    const prefix = String(args.namePrefix ?? '').trim();
    next.namePrefix = prefix || DEFAULT_NAME_PREFIX;
    changed = true;
  }
  if (args.defaultProfile !== undefined) {
    if (args.defaultProfile === null) {
      next.defaultProfile = null;
    } else {
      const dp = normalizeDefaultProfile(args.defaultProfile);
      if (!dp) {
        throw new Error('defaultProfile 格式无效（需包含有效 name、sex、age[5-120]、heightCm[80-230]）');
      }
      next.defaultProfile = dp;
      const cnt = ctx.db.prepare('SELECT COUNT(*) AS cnt FROM profiles').get().cnt;
      if (cnt === 0) {
        ctx.db.prepare(`
          INSERT INTO profiles (id, name, sex, age, height_cm, target_weight_kg, unit, is_default, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `).run(dp.id, dp.name, dp.sex, dp.age, dp.heightCm, dp.targetWeightKg, dp.unit, ctx.nowMs, ctx.nowMs);
      }
    }
    changed = true;
  }

  if (changed) {
    writeConfig(paths.configPath, next);
  }

  return {
    ok: true,
    notify: false,
    title: '健康秤配置',
    message: `${changed ? '✅ 已保存配置' : '⚙️ 当前配置'}：targetMac=${next.targetMac || '(未绑定，按前缀扫描)'}, namePrefix=${next.namePrefix}, defaultProfile=${next.defaultProfile ? next.defaultProfile.name : '(未设置)'}`,
    data: {
      config: next,
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin Entrypoint
// ---------------------------------------------------------------------------

/**
 * Execute a health-scale plugin action.
 * @param {string} [action]
 * @param {Record<string, unknown>} [args]
 * @param {import('../_shared/types.d.ts').PluginExecutionContext & { bleRunner?: Function; spawnMeasure?: Function }} [deps]
 */
export async function runAction(action = 'status', args = {}, deps = {}) {
  const name = String(action || 'status').trim().toLowerCase();
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (!ACTIONS.includes(name)) {
    return {
      ok: false,
      notify: true,
      title: '健康管理插件参数错误',
      message: `不支持的动作 "${action}"，可用动作：${ACTIONS.join('、')}`,
    };
  }

  const nowMs = typeof deps.nowFn === 'function' ? deps.nowFn() : Date.now();
  const paths = resolveScalePaths(safeArgs, deps);
  const config = loadScaleConfig(paths.configPath);
  const { db } = openDb(paths, nowMs, config);

  const ctx = {
    args: safeArgs,
    dataDir: paths.pluginDataDir,
    paths,
    config,
    db,
    nowMs,
    signal: deps.signal,
    hasInjectedBleRunner: typeof deps.bleRunner === 'function',
    hasInjectedSpawnMeasure: typeof deps.spawnMeasure === 'function',
    bleRunner: deps.bleRunner || defaultBleRunner,
    spawnMeasure: deps.spawnMeasure || defaultSpawnMeasure,
  };

  try {
    switch (name) {
      case 'dashboard': return handleDashboard(ctx);
      case 'status': return handleStatus(ctx);
      case 'config': return handleConfig(ctx);
      case 'scan': return await handleScan(ctx);
      case 'measure-start': return await handleMeasureStart(ctx);
      case 'measure-status': return await handleMeasureStatus(ctx);
      case 'measure-stop': return await handleMeasureStop(ctx);
      case 'profile-save': return handleProfileSave(ctx);
      case 'profile-delete': return handleProfileDelete(ctx);
      case 'record-add': return handleRecordAdd(ctx);
      case 'record-delete': return handleRecordDelete(ctx);
      default:
        return { ok: false, notify: true, title: '未实现的动作', message: `未知动作: ${name}` };
    }
  } catch (err) {
    return {
      ok: false,
      notify: true,
      title: '健康管理插件执行失败',
      message: errMsg(err),
    };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

const HEALTH_FASTPATH_EXCLUDE_RE = /(?:然后|顺便|并且|微信|网页|档案|身高|年龄|性别|新建|添加成员|删除|删掉|移除|补录|设为默认|改回|配置|为什么|怎么)/;
const HEALTH_FASTPATH_START_RE = /^(?:请|帮我|麻烦|现在|重新|再)?(?:开始|启动)?(?:测量体重|测一下体重|称一下体重|称体重|测体重|开始称重|上秤测量|上秤称重|测体脂|量体重)(?:吧|呗|一下)?$/;
const HEALTH_FASTPATH_RETRY_RE = /^(?:再试一次|重试一次|试一次|重新测(?:一下|一次)?|再测一次|再来一次)(?:吧|呗)?$/;
const HEALTH_FASTPATH_STOP_RE = /^(?:请|帮我|麻烦)?(?:停止|取消|结束)(?:称重|测量体重|测体重|体脂测量|上秤)(?:吧|一下)?$/;
const HEALTH_FASTPATH_STATUS_DIRECT_RE = /^(?:帮我)?(?:查一下|看看|看下|播报)?(?:我(?:现在|最新|最近)?的?)?(?:最新|最近)?(?:体重|体脂(?:率)?|称重数据|称重结果|测量结果)(?:是多少|多少|怎么样|出来了吗|有了吗)?$/;
const HEALTH_FASTPATH_STATUS_RECENT_RE = /^(?:(?:现在)?(?:体脂秤|称重)?(?:同步|同到|收到|测到|有|出)?(?:新|最新)?(?:体重|称重|测量)?(?:数据|结果)?了吗|称好了吗|测好了吗|称上了吗|同步了吗)$/;

function stripHealthFastpathText(rawText) {
  return String(rawText || '')
    .replace(/<\|[^|]*\|>/g, '')
    .trim()
    .replace(/^(?:(?:你好|您好|嗨|嘿|喂)[，,\s]*)?(?:星期五|小爱同学?|friday)[，,。！!？?、：\s]*/i, '')
    .replace(/[。，,！!？?\s]+$/g, '')
    .trim();
}

function formatFastpathWeightSpeech(latest, deltas, options = {}) {
  if (!latest) return '当前还没有体重测量记录。';
  const kg = Number(latest.weightKg);
  const jin = Number(latest.weightJin ?? kg * 2);
  const kgText = kg.toFixed(2).replace(/\.?0+$/, '');
  const jinText = jin.toFixed(1).replace(/\.0$/, '');
  const who = options.multiProfile && options.profileName ? String(options.profileName).trim() : '';
  const head = `${options.completedAnnouncement ? '测量完成，' : ''}${who}最新体重${kgText}公斤，合${jinText}斤`;
  const parts = [head];
  if (deltas && deltas.prevDiffKg !== null && deltas.prevDiffKg !== undefined) {
    const diff = Number(deltas.prevDiffKg);
    if (Math.abs(diff) < 0.005) {
      parts.push('与上次持平');
    } else {
      const diffText = Math.abs(diff).toFixed(2).replace(/\.?0+$/, '');
      parts.push(`比上次${diff > 0 ? '重' : '轻'}了${diffText}公斤`);
    }
  }
  const bf = latest.metrics?.bodyFatPercent;
  const bmi = latest.metrics?.bmi;
  if (bf !== null && bf !== undefined && bmi !== null && bmi !== undefined) {
    parts.push(`体脂率${bf}%，BMI ${bmi}`);
  }
  return `${parts.join('，')}。`;
}

/**
 * In-process voice fastpath for unambiguous health-scale commands (start/retry/stop/status)
 * plus internal `measure_poll` / `assistant_reply` session lifecycle hooks.
 * Leaves profile edits, deletions, and open-ended follow-ups to the Router LLM.
 */
export async function handleVoiceFastpath(request, context = {}) {
  if (!request || typeof request !== 'object') {
    return { handled: false };
  }
  const paths = resolveScalePaths({}, context);
  const nowMs = typeof context.nowFn === 'function' ? context.nowFn() : Date.now();
  const sPath = sessionFilePath(paths.pluginDataDir);

  if (request.sessionState?.event === 'measure_poll') {
    const live = readJsonSafe(sPath, null);
    const watchId = request.sessionState.watchMeasureSessionId;
    if (!live || (watchId && live.sessionId !== watchId)) {
      return {
        handled: true,
        plugin: 'health-scale',
        action: 'measure-poll',
        data: { phase: 'superseded' },
      };
    }
    const activePhases = new Set(['scanning', 'connecting', 'measuring']);
    const staleDeadHelper = Boolean(
      live.pid
      && process.platform === 'linux'
      && !isBleHelperPid(Number(live.pid))
      && (nowMs - Number(live.updatedAt || live.startedAt || 0) > 1500),
    );
    if (activePhases.has(live.phase) && !staleDeadHelper) {
      return {
        handled: true,
        plugin: 'health-scale',
        action: 'measure-poll',
        data: { phase: live.phase, sessionId: live.sessionId },
      };
    }

    const res = await runAction('measure-status', {}, context);
    const session = res.data?.session;
    const dashboard = res.data?.dashboard ?? res.data;
    const latest = dashboard?.latest;
    const deltas = dashboard?.deltas;
    if (
      session?.phase === 'completed'
      && latest
      && Number(latest.measuredAt || 0) >= Number(session.startedAt || 0) - 5000
    ) {
      return {
        handled: true,
        plugin: 'health-scale',
        action: 'measure-completed',
        ok: true,
        speech: formatFastpathWeightSpeech(latest, deltas, {
          profileName: dashboard?.activeProfile?.name,
          multiProfile: (dashboard?.profiles?.length ?? 0) > 1,
          completedAnnouncement: true,
        }),
        data: {
          phase: 'completed',
          sessionId: session.sessionId,
          matchedProfileId: session.matchedProfileId,
        },
      };
    }
    if (session?.phase === 'timeout') {
      return {
        handled: true,
        plugin: 'health-scale',
        action: 'measure-timeout',
        ok: true,
        speech: '体脂秤等待45秒超时，本次没有收到稳定称重数据。',
        data: { phase: 'timeout', sessionId: session.sessionId },
      };
    }
    return {
      handled: true,
      plugin: 'health-scale',
      action: 'measure-ended',
      ok: false,
      data: {
        phase: session?.phase || 'ended',
        sessionId: session?.sessionId || live.sessionId,
      },
    };
  }

  if (request.sessionState?.event === 'assistant_reply') {
    const live = readJsonSafe(sPath, null);
    const startedAgeMs = live ? nowMs - Number(live.startedAt || 0) : Number.POSITIVE_INFINITY;
    if (
      live
      && ['scanning', 'connecting', 'measuring'].includes(live.phase)
      && Number.isFinite(startedAgeMs)
      && startedAgeMs >= 0
      && startedAgeMs <= 20_000
    ) {
      return {
        handled: true,
        plugin: 'health-scale',
        action: 'measure-watch',
        followUp: false,
        data: {
          watchMeasureSessionId: live.sessionId,
          timeoutSec: Number(live.timeoutSec || 45),
        },
      };
    }
    return { handled: false };
  }

  const text = stripHealthFastpathText(request.text);
  if (!text || text.length > 32 || HEALTH_FASTPATH_EXCLUDE_RE.test(text)) {
    return { handled: false };
  }

  const live = readJsonSafe(sPath, null);
  const liveAgeMs = live ? nowMs - Number(live.updatedAt || live.startedAt || 0) : Number.POSITIVE_INFINITY;
  const recentStartSession = Boolean(live && Number.isFinite(liveAgeMs) && liveAgeMs >= 0 && liveAgeMs <= 180_000);
  const recentQuerySession = Boolean(live && Number.isFinite(liveAgeMs) && liveAgeMs >= 0 && liveAgeMs <= 300_000);
  const inFollowUp = Boolean(request.sessionState?.healthScaleFollowUp);

  if (inFollowUp && /^(?:不用了?|不需要|不要了?|算了|不用再试了?)$/i.test(text)) {
    return {
      handled: true,
      plugin: 'health-scale',
      action: 'follow-up-cancel',
      ok: true,
      speech: '好的，那先不测了。',
      followUp: false,
      clearSessionState: true,
    };
  }

  if (HEALTH_FASTPATH_START_RE.test(text) || ((recentStartSession || inFollowUp) && HEALTH_FASTPATH_RETRY_RE.test(text))) {
    const res = await runAction('measure-start', {}, context);
    const sessionData = res.data?.session;
    return {
      handled: true,
      plugin: 'health-scale',
      action: 'measure-start',
      ok: Boolean(res.ok),
      speech: res.ok
        ? '好，体脂秤已就绪，现在赤脚上秤吧，45秒内有效。'
        : (res.message || '暂时无法启动蓝牙测量。'),
      followUp: false,
      clearSessionState: true,
      data: {
        ...(res.data && typeof res.data === 'object' ? res.data : {}),
        ...(res.ok && sessionData?.sessionId
          ? {
              watchMeasureSessionId: sessionData.sessionId,
              timeoutSec: Number(sessionData.timeoutSec ?? 45),
            }
          : {}),
      },
    };
  }

  if (HEALTH_FASTPATH_STOP_RE.test(text)) {
    const res = await runAction('measure-stop', {}, context);
    return {
      handled: true,
      plugin: 'health-scale',
      action: 'measure-stop',
      ok: Boolean(res.ok),
      speech: res.ok ? '好的，已停止体重测量。' : (res.message || '停止测量失败。'),
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }

  const directQuery = HEALTH_FASTPATH_STATUS_DIRECT_RE.test(text);
  const contextualQuery = recentQuerySession && HEALTH_FASTPATH_STATUS_RECENT_RE.test(text);
  if (directQuery || contextualQuery) {
    const action = recentQuerySession ? 'measure-status' : 'status';
    const res = await runAction(action, {}, context);
    if (!res.ok) {
      return {
        handled: true,
        plugin: 'health-scale',
        action,
        ok: false,
        speech: res.message || '查询体重数据失败。',
        followUp: false,
        clearSessionState: true,
      };
    }
    const session = res.data?.session;
    const dashboard = res.data?.dashboard ?? res.data;
    const latest = dashboard?.latest;
    const deltas = dashboard?.deltas;
    if (session && ['scanning', 'connecting', 'measuring'].includes(session.phase)) {
      return {
        handled: true,
        plugin: 'health-scale',
        action,
        ok: true,
        speech: '还在等待体脂秤稳定读数，请赤脚站稳。',
        followUp: false,
        clearSessionState: true,
        data: { session },
      };
    }
    if (
      session
      && session.phase === 'timeout'
      && (!latest || Number(latest.measuredAt || 0) < Number(session.startedAt || 0))
    ) {
      return {
        handled: true,
        plugin: 'health-scale',
        action,
        ok: true,
        speech: '刚才45秒超时没收到稳定信号，请确认手机App没占着蓝牙。要再试一次吗？',
        followUp: true,
        followUpWaitMs: 8_000,
        sessionState: { healthScaleFollowUp: true, idleTtlMs: 30_000 },
        data: { session },
      };
    }
    return {
      handled: true,
      plugin: 'health-scale',
      action,
      ok: true,
      speech: formatFastpathWeightSpeech(latest, deltas, {
        profileName: dashboard?.activeProfile?.name,
        multiProfile: (dashboard?.profiles?.length ?? 0) > 1,
      }),
      followUp: false,
      clearSessionState: true,
      data: {
        latest,
        deltas,
        ...(session?.phase === 'completed' ? { announcedMeasureSessionId: session.sessionId } : {}),
      },
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

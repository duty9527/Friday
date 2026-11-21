#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
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
  resolveSystemAmapKey,
  reverseGeocodeWithCache,
  saveSystemGeoConfig,
} from '../_shared/amap-geo.mjs';
import {
  createNinebotClient,
  isSessionTokenValid,
  NinebotApiError,
} from './client.mjs';

export const ACTIONS = [
  'status',
  'patrol',
  'charge-check',
  'trips',
  'vehicles',
  'login',
  'config',
  'dashboard',
];

export const DEFAULT_CONFIG = Object.freeze({
  backend: 'auto',
  preferredLine: 'motor',
  coordSys: 'wgs84',
  defaultSn: '',
  deviceName: '',
  username: '',
  password: '',
  areaCode: '86',
  deviceServiceKey: '',
  amapKey: '',
  lowBatteryThreshold: 30,
  minRangeKm: 15,
  idleRemindDays: 7,
  alertCooldownHours: 12,
  checkUnlocked: true,
});

const GEO_CACHE_TTL_MS = 24 * 3600 * 1000;
const IDLE_COOLDOWN_MS = 72 * 3600 * 1000;
const SERVICE_EXPIRED_COOLDOWN_MS = 168 * 3600 * 1000;
const MAX_SNAPSHOTS_PER_VEHICLE = 500;

const ASR_TAG_RE = /<\|[^|]*\|>/g;
const WAKE_PREFIX_RE = /^(?:(?:小爱同学|小爱|(?:(?:你好|您好|嗨|嘿|喂|诶|唉|欸|黑|呼叫)\s*(?:星期[五武午舞屋吾无物务]|friday)|(?:星期五|friday))(?=$|[\s，,。！!？?、：:]))[\s，,。！!？?、：:]*)+/i;
const TRAILING_PUNCT_RE = /[。！!？?，,、；;\s]+$/g;

const NINEBOT_TRIGGER_RE = /(九号|小九|电动车|电瓶车|电摩|小电驴|摩电)/;
const NINEBOT_EXCLUSION_RE = /(提醒我|定个?闹钟|设个?提醒|定时器|每天|每晚|明早|明天|如果|要是|假如|顺便|然后|并且|为什么|怎么配置|怎么设置|如何接入)/;
const NINEBOT_STATE_QUESTION_RE = /(?:锁好没|锁好没有|锁了吗|锁没|上锁了吗|关机没|关机了吗|开机没|开机了吗|关电门没|关电门了吗|有没有锁|是不是锁|是否已锁|是否上锁|断电没)/;
const NINEBOT_CONTROL_CMD_RE = /(开锁|解锁|锁车|上锁|锁一下|开座桶|打开座桶|开坐桶|打开坐桶|鸣笛|响铃|寻车响铃|远程启动|启动车辆|帮我开机|帮我关机|把.*开机|把.*关机|断电门|开电门)/;
const NINEBOT_LOCATION_LOCK_RE = /(停哪|停在|在哪|位置|地址|锁好|锁了|锁没|上锁|关机|开机|电门|设防)/;
const NINEBOT_TRIPS_RE = /(骑了多远|骑了多少|骑行|行程|轨迹|最高速|极速|均速|平均速度|跑了多远)/;
const NINEBOT_STATUS_RE = /(多少电|电量|还有电|能跑多远|续航|充电|充满|电压|功率|总里程|状态|情况|怎么样|报告)/;

/**
 * @param {number} ms
 * @returns {{ month: string; date: string; monthCompact: string }}
 */
function formatShDateParts(ms) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(ms));
  const year = parts.find(p => p.type === 'year')?.value || '2026';
  const month = parts.find(p => p.type === 'month')?.value || '01';
  const day = parts.find(p => p.type === 'day')?.value || '01';
  return {
    month: `${year}-${month}`,
    monthCompact: `${year}${month}`,
    date: `${year}-${month}-${day}`,
  };
}

/**
 * @param {number} sec
 * @returns {string}
 */
function formatShDateFromUnixSec(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  return formatShDateParts(sec * 1000).date;
}

/**
 * Normalize user-supplied month (`"2026-11"` / `"202611"` / empty) into compact `YYYYMM`.
 * @param {unknown} rawMonth
 * @param {string} fallbackMonthCompact
 * @returns {string}
 */
function normalizeMonthCompact(rawMonth, fallbackMonthCompact) {
  if (rawMonth === undefined || rawMonth === null || String(rawMonth).trim() === '') {
    return fallbackMonthCompact;
  }
  const digits = String(rawMonth).trim().replace(/\D+/g, '');
  if (/^20\d{2}(0[1-9]|1[0-2])$/.test(digits)) {
    return digits;
  }
  throw new NinebotApiError('月份格式无效，请使用 YYYYMM 或 YYYY-MM（例如 202611）', {
    code: 'INVALID_MONTH',
  });
}

/**
 * @param {string} raw
 * @returns {string}
 */
function maskUsername(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.length >= 7) {
    return `${s.slice(0, 3)}****${s.slice(-4)}`;
  }
  if (s.length >= 3) {
    return `${s[0]}***${s[s.length - 1]}`;
  }
  return '***';
}

/**
 * @param {Record<string, unknown>} rawCfg
 * @returns {{
 *   backend: 'auto' | 'account' | 'official';
 *   preferredLine: 'motor' | 'ebike';
 *   coordSys: 'wgs84' | 'gcj02';
 *   defaultSn: string;
 *   deviceName: string;
 *   username: string;
 *   password: string;
 *   areaCode: string;
 *   deviceServiceKey: string;
 *   amapKey: string;
 *   lowBatteryThreshold: number;
 *   minRangeKm: number;
 *   idleRemindDays: number;
 *   alertCooldownHours: number;
 *   checkUnlocked: boolean;
 * }}
 */
function normalizeConfig(rawCfg) {
  const backendRaw = String(rawCfg.backend ?? DEFAULT_CONFIG.backend).trim().toLowerCase();
  const backend = backendRaw === 'account' || backendRaw === 'official' ? backendRaw : 'auto';
  const lineRaw = String(rawCfg.preferredLine ?? DEFAULT_CONFIG.preferredLine).trim().toLowerCase();
  const preferredLine = lineRaw === 'ebike' ? 'ebike' : 'motor';
  const coordRaw = String(rawCfg.coordSys ?? DEFAULT_CONFIG.coordSys).trim().toLowerCase();
  const coordSys = coordRaw === 'gcj02' ? 'gcj02' : 'wgs84';

  return {
    backend,
    preferredLine,
    coordSys,
    defaultSn: String(rawCfg.defaultSn ?? '').trim(),
    deviceName: String(rawCfg.deviceName ?? '').trim(),
    username: String(rawCfg.username ?? '').trim(),
    password: typeof rawCfg.password === 'string' ? rawCfg.password : '',
    areaCode: String(rawCfg.areaCode ?? '86').trim() || '86',
    deviceServiceKey: String(rawCfg.deviceServiceKey ?? '').trim(),
    amapKey: String(rawCfg.amapKey ?? '').trim(),
    lowBatteryThreshold: clampInt(rawCfg.lowBatteryThreshold, 5, 90) ?? DEFAULT_CONFIG.lowBatteryThreshold,
    minRangeKm: clampInt(rawCfg.minRangeKm, 0, 150) ?? DEFAULT_CONFIG.minRangeKm,
    idleRemindDays: clampInt(rawCfg.idleRemindDays, 0, 60) ?? DEFAULT_CONFIG.idleRemindDays,
    alertCooldownHours: clampInt(rawCfg.alertCooldownHours, 1, 168) ?? DEFAULT_CONFIG.alertCooldownHours,
    checkUnlocked: rawCfg.checkUnlocked === undefined ? DEFAULT_CONFIG.checkUnlocked : Boolean(rawCfg.checkUnlocked),
  };
}

/**
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {Record<string, unknown> | null} session
 * @param {Record<string, string | undefined>} env
 * @param {string} [overrideBackend]
 * @returns {'account' | 'official'}
 */
function resolveEffectiveBackend(config, session, env, overrideBackend) {
  const requested = String(overrideBackend || config.backend || 'auto').trim().toLowerCase();
  const officialKey = String(config.deviceServiceKey || env?.NINEBOT_DEVICESERVICE_KEY || '').trim();
  const hasAccount = Boolean(
    (session && typeof session.accessToken === 'string' && session.accessToken.trim()) ||
    (config.username && config.password),
  );
  if (requested === 'official') return 'official';
  if (requested === 'account') return 'account';
  if (hasAccount) return 'account';
  if (officialKey) return 'official';
  return 'account';
}

/**
 * Redacted config view safe to expose in messages and data payloads.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {Record<string, unknown> | null} session
 * @param {Record<string, string | undefined>} env
 * @param {number} nowMs
 */
function redactConfig(config, session, env, nowMs, homeDir) {
  const officialKey = String(config.deviceServiceKey || env?.NINEBOT_DEVICESERVICE_KEY || '').trim();
  const { key: amapKey, source: amapKeySource } = resolveSystemAmapKey({
    homeDir,
    env,
    fallbackKey: config.amapKey,
  });
  return {
    backend: config.backend,
    effectiveBackend: resolveEffectiveBackend(config, session, env),
    preferredLine: config.preferredLine,
    coordSys: config.coordSys,
    defaultSn: config.defaultSn,
    deviceName: config.deviceName,
    areaCode: config.areaCode,
    usernameMasked: maskUsername(config.username || String(session?.username || '')),
    hasPassword: Boolean(config.password),
    hasSession: Boolean(session && typeof session.accessToken === 'string' && session.accessToken),
    sessionValid: isSessionTokenValid(/** @type {any} */ (session), nowMs),
    hasBusinessUid: Boolean(session && typeof session.businessUid === 'string' && session.businessUid),
    hasDeviceServiceKey: Boolean(officialKey),
    hasAmapKey: Boolean(amapKey),
    amapKeySource,
    lowBatteryThreshold: config.lowBatteryThreshold,
    minRangeKm: config.minRangeKm,
    idleRemindDays: config.idleRemindDays,
    alertCooldownHours: config.alertCooldownHours,
    checkUnlocked: config.checkUnlocked,
  };
}

/**
 * @param {string} dbPath
 */
function openDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sn TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      battery INTEGER,
      aux_battery INTEGER,
      voltage_v REAL,
      temp_c REAL,
      charging INTEGER,
      charging_power_w REAL,
      effective_range_km REAL,
      odometer_km REAL,
      power_on INTEGER,
      locked INTEGER,
      gcj_lat REAL,
      gcj_lon REAL,
      address TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_sn_time ON snapshots (sn, captured_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS trips (
      sn TEXT NOT NULL,
      travel_id TEXT NOT NULL,
      start_time INTEGER,
      end_time INTEGER,
      duration_sec INTEGER,
      distance_km REAL,
      max_speed_kmh REAL,
      avg_speed_kmh REAL,
      used_electricity REAL,
      month TEXT,
      payload_json TEXT,
      updated_at INTEGER,
      PRIMARY KEY (sn, travel_id)
    );
    CREATE INDEX IF NOT EXISTS idx_trips_sn_end ON trips (sn, end_time DESC);

    CREATE TABLE IF NOT EXISTS geo_cache (
      grid_key TEXT PRIMARY KEY,
      address TEXT,
      short_address TEXT,
      source TEXT,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS alert_state (
      sn TEXT NOT NULL,
      alert_key TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      last_notified_at INTEGER NOT NULL DEFAULT 0,
      last_value TEXT,
      PRIMARY KEY (sn, alert_key)
    );
  `);
  return db;
}

/**
 * @param {DatabaseSync} db
 * @param {string} sn
 * @returns {Record<string, unknown> | null}
 */
function getLatestSnapshotRow(db, sn) {
  const row = /** @type {Record<string, unknown> | undefined} */ (
    db.prepare('SELECT * FROM snapshots WHERE sn=? ORDER BY captured_at DESC, id DESC LIMIT 1').get(sn)
  );
  return row ?? null;
}

/**
 * @param {DatabaseSync} db
 * @param {string} sn
 * @param {number} limit
 */
function getRecentSnapshotSummaries(db, sn, limit = 20) {
  const rows = /** @type {Array<Record<string, unknown>>} */ (
    db.prepare(
      'SELECT captured_at, battery, aux_battery, voltage_v, temp_c, charging, charging_power_w, effective_range_km, odometer_km, power_on, locked, address FROM snapshots WHERE sn=? ORDER BY captured_at DESC, id DESC LIMIT ?',
    ).all(sn, limit)
  );
  return rows.map(r => ({
    capturedAt: Number(r.captured_at),
    battery: r.battery === null ? null : Number(r.battery),
    auxBattery: r.aux_battery === null ? null : Number(r.aux_battery),
    voltageV: r.voltage_v === null ? null : Number(r.voltage_v),
    temperatureC: r.temp_c === null ? null : Number(r.temp_c),
    charging: r.charging === 1,
    chargingPowerW: r.charging_power_w === null ? null : Number(r.charging_power_w),
    effectiveRangeKm: r.effective_range_km === null ? null : Number(r.effective_range_km),
    odometerKm: r.odometer_km === null ? null : Number(r.odometer_km),
    powerOn: r.power_on === 1,
    locked: r.locked === null ? null : r.locked === 1,
    address: r.address || null,
  }));
}

/**
 * @param {DatabaseSync} db
 * @param {Record<string, any>} snapshot
 */
function insertSnapshot(db, snapshot) {
  db.prepare(`
    INSERT INTO snapshots (
      sn, captured_at, battery, aux_battery, voltage_v, temp_c,
      charging, charging_power_w, effective_range_km, odometer_km,
      power_on, locked, gcj_lat, gcj_lon, address, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.sn,
    snapshot.capturedAt,
    snapshot.battery,
    snapshot.auxBattery,
    snapshot.voltageV,
    snapshot.temperatureC,
    snapshot.charging ? 1 : 0,
    snapshot.chargingPowerW,
    snapshot.effectiveRangeKm,
    snapshot.odometerKm,
    snapshot.powerOn ? 1 : 0,
    snapshot.locked === null ? null : snapshot.locked ? 1 : 0,
    snapshot.location?.gcjLat ?? null,
    snapshot.location?.gcjLon ?? null,
    snapshot.location?.address ?? null,
    JSON.stringify(snapshot),
  );

  db.prepare(
    'DELETE FROM snapshots WHERE sn=? AND id NOT IN (SELECT id FROM snapshots WHERE sn=? ORDER BY captured_at DESC, id DESC LIMIT ?)',
  ).run(snapshot.sn, snapshot.sn, MAX_SNAPSHOTS_PER_VEHICLE);
}

/**
 * @param {DatabaseSync} db
 * @param {string} sn
 * @param {Array<Record<string, any>>} trips
 * @param {number} nowMs
 */
function upsertTrips(db, sn, trips, nowMs) {
  const stmt = db.prepare(`
    INSERT INTO trips (
      sn, travel_id, start_time, end_time, duration_sec,
      distance_km, max_speed_kmh, avg_speed_kmh, used_electricity, month, payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sn, travel_id) DO UPDATE SET
      start_time=excluded.start_time,
      end_time=excluded.end_time,
      duration_sec=excluded.duration_sec,
      distance_km=excluded.distance_km,
      max_speed_kmh=excluded.max_speed_kmh,
      avg_speed_kmh=excluded.avg_speed_kmh,
      used_electricity=excluded.used_electricity,
      month=excluded.month,
      payload_json=excluded.payload_json,
      updated_at=excluded.updated_at
  `);
  for (const t of trips) {
    stmt.run(
      sn,
      t.travelId,
      t.startTime ?? 0,
      t.endTime ?? 0,
      t.durationSec ?? 0,
      t.distanceKm ?? 0,
      t.maxSpeedKmh ?? 0,
      t.avgSpeedKmh ?? 0,
      t.usedElectricity ?? 0,
      t.month || '',
      JSON.stringify(t),
      nowMs,
    );
  }
}

/**
 * @param {DatabaseSync} db
 * @param {string} sn
 * @param {number} nowMs
 * @param {string} [monthFilter]
 * @param {number} [limit]
 */
function summarizeCachedTrips(db, sn, nowMs, monthFilter, limit = 10) {
  const todayStr = formatShDateParts(nowMs).date;
  const sevenDaysAgoSec = Math.floor((nowMs - 7 * 86400 * 1000) / 1000);
  const rows = /** @type {Array<Record<string, any>>} */ (
    monthFilter
      ? db.prepare('SELECT * FROM trips WHERE sn=? AND month=? ORDER BY end_time DESC, start_time DESC').all(sn, monthFilter)
      : db.prepare('SELECT * FROM trips WHERE sn=? ORDER BY end_time DESC, start_time DESC').all(sn)
  );

  let todayDistanceKm = 0;
  let todayCount = 0;
  let sevenDayDistanceKm = 0;
  let sevenDayCount = 0;
  let totalDistanceKm = 0;
  let totalDurationSec = 0;
  let maxSpeedKmh = 0;
  let totalUsedElectricity = 0;

  const normalized = rows.map(r => {
    const dist = Number(r.distance_km ?? 0);
    const dur = Number(r.duration_sec ?? 0);
    const maxSpd = Number(r.max_speed_kmh ?? 0);
    const avgSpd = Number(r.avg_speed_kmh ?? 0);
    const endSec = Number(r.end_time ?? 0);
    const usedElec = Number(r.used_electricity ?? 0);

    totalDistanceKm += dist;
    totalDurationSec += dur;
    totalUsedElectricity += usedElec;
    if (maxSpd > maxSpeedKmh) maxSpeedKmh = maxSpd;

    const rideDate = formatShDateFromUnixSec(endSec);
    if (rideDate && rideDate === todayStr) {
      todayDistanceKm += dist;
      todayCount += 1;
    }
    if (endSec >= sevenDaysAgoSec) {
      sevenDayDistanceKm += dist;
      sevenDayCount += 1;
    }

    return {
      travelId: String(r.travel_id),
      startTime: Number(r.start_time ?? 0),
      endTime: endSec,
      date: rideDate,
      durationSec: dur,
      distanceKm: Number(dist.toFixed(2)),
      maxSpeedKmh: Number(maxSpd.toFixed(1)),
      avgSpeedKmh: Number(avgSpd.toFixed(1)),
      usedElectricity: Number(usedElec.toFixed(1)),
      month: String(r.month || ''),
    };
  });

  const overallAvgSpeedKmh = totalDurationSec > 0
    ? Number((totalDistanceKm / (totalDurationSec / 3600)).toFixed(1))
    : 0;

  return {
    tripCount: normalized.length,
    totalDistanceKm: Number(totalDistanceKm.toFixed(2)),
    totalDurationSec,
    totalUsedElectricity: Number(totalUsedElectricity.toFixed(1)),
    maxSpeedKmh: Number(maxSpeedKmh.toFixed(1)),
    overallAvgSpeedKmh,
    todayCount,
    todayDistanceKm: Number(todayDistanceKm.toFixed(2)),
    sevenDayCount,
    sevenDayDistanceKm: Number(sevenDayDistanceKm.toFixed(2)),
    trips: normalized.slice(0, limit),
  };
}

const MAX_VEHICLE_IMAGE_BYTES = 512 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @param {string} sessionPath
 * @returns {Record<string, any>}
 */
function loadSession(sessionPath) {
  const raw = readJsonSafe(sessionPath, {});
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { deviceId: randomBytes(16).toString('hex') };
  }
  const obj = /** @type {Record<string, any>} */ ({ ...raw });
  if (typeof obj.deviceId !== 'string' || !obj.deviceId.trim()) {
    obj.deviceId = randomBytes(16).toString('hex');
  }
  return obj;
}

/**
 * @param {string} sessionPath
 * @param {Record<string, any>} session
 */
async function saveSessionLocked(sessionPath, session) {
  await withFileLock(sessionPath, () => {
    writeJsonAtomic(sessionPath, session, { mode: 0o600 });
  });
}

/**
 * Atomically write verified binary PNG bytes inside pluginDataDir with 0600 permissions.
 * @param {string} targetPath
 * @param {Buffer} bytes
 */
function writeBinaryFileAtomic(targetPath, bytes) {
  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmpPath, bytes, { mode: 0o600 });
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // Ignore chmod errors on unsupported filesystems
    }
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  }
}

/**
 * Read a local cached PNG as a CSP-safe `data:image/png;base64,...` URI.
 * Rejects symlinks, oversized files, and non-PNG magic bytes.
 * @param {string} filePath
 * @returns {string | null}
 */
function readPngAsDataUrl(filePath) {
  try {
    const st = lstatSync(filePath);
    if (!st.isFile() || st.isSymbolicLink() || st.size < 64 || st.size > MAX_VEHICLE_IMAGE_BYTES) {
      return null;
    }
    const buf = readFileSync(filePath);
    if (buf.length < 64 || buf.length > MAX_VEHICLE_IMAGE_BYTES || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
      return null;
    }
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * Cache dark/light official scooter PNG renders locally (best-effort, non-fatal).
 * @param {string} pluginDataDir
 * @param {ReturnType<typeof createNinebotClient>} client
 * @param {string} sn
 * @param {string} darkUrl
 * @param {string} lightUrl
 * @param {number} nowMs
 */
async function syncVehicleImagesCache(pluginDataDir, client, sn, darkUrl, lightUrl, nowMs) {
  const cleanSn = String(sn || '').trim();
  const cleanDark = String(darkUrl || '').trim();
  const cleanLight = String(lightUrl || '').trim();
  if (!cleanSn || (!cleanDark && !cleanLight)) return;

  try {
    ensurePrivateDir(pluginDataDir);
    const metaPath = join(pluginDataDir, 'vehicle-images-meta.json');
    const darkPath = join(pluginDataDir, 'vehicle-dark.png');
    const lightPath = join(pluginDataDir, 'vehicle-light.png');
    const meta = readJsonSafe(metaPath, /** @type {Record<string, any>} */ ({}));

    const needDark = Boolean(cleanDark) && (meta.sn !== cleanSn || meta.darkUrl !== cleanDark || !existsSync(darkPath));
    const needLight = Boolean(cleanLight) && (meta.sn !== cleanSn || meta.lightUrl !== cleanLight || !existsSync(lightPath));
    if (!needDark && !needLight) return;

    /** @type {Map<string, Buffer | null>} */
    const downloaded = new Map();
    const fetchOnce = async (url) => {
      if (!url) return null;
      if (downloaded.has(url)) return downloaded.get(url) ?? null;
      const bytes = await client.fetchVehicleImagePng(url);
      downloaded.set(url, bytes);
      return bytes;
    };

    let nextDarkUrl = meta.sn === cleanSn && existsSync(darkPath) ? String(meta.darkUrl || '') : '';
    let nextLightUrl = meta.sn === cleanSn && existsSync(lightPath) ? String(meta.lightUrl || '') : '';

    if (needDark) {
      const bytes = await fetchOnce(cleanDark);
      if (bytes) {
        writeBinaryFileAtomic(darkPath, bytes);
        nextDarkUrl = cleanDark;
      }
    }
    if (needLight) {
      const bytes = await fetchOnce(cleanLight);
      if (bytes) {
        writeBinaryFileAtomic(lightPath, bytes);
        nextLightUrl = cleanLight;
      }
    }

    if (nextDarkUrl || nextLightUrl) {
      writeJsonAtomic(
        metaPath,
        {
          sn: cleanSn,
          darkUrl: nextDarkUrl,
          lightUrl: nextLightUrl,
          updatedAt: nowMs,
        },
        { mode: 0o600 },
      );
    }
  } catch {
    // Non-fatal: official CDN failures never block telemetry updates
  }
}

/**
 * Read locally cached PNG data URLs for the specified vehicle SN.
 * @param {string} pluginDataDir
 * @param {string} sn
 * @returns {{ darkDataUrl: string | null; lightDataUrl: string | null }}
 */
function readVehicleImageDataUrls(pluginDataDir, sn) {
  const cleanSn = String(sn || '').trim();
  const metaPath = join(pluginDataDir, 'vehicle-images-meta.json');
  const meta = readJsonSafe(metaPath, /** @type {Record<string, any>} */ ({}));
  if (cleanSn && meta.sn && meta.sn !== cleanSn) {
    return { darkDataUrl: null, lightDataUrl: null };
  }
  return {
    darkDataUrl: readPngAsDataUrl(join(pluginDataDir, 'vehicle-dark.png')),
    lightDataUrl: readPngAsDataUrl(join(pluginDataDir, 'vehicle-light.png')),
  };
}

/**
 * @param {DatabaseSync} db
 * @param {Record<string, any>} snapshot
 * @param {ReturnType<typeof createNinebotClient>} client
 * @param {string} amapKey
 * @param {number} nowMs
 */
async function enrichLocationWithGeo(db, snapshot, client, amapKey, nowMs) {
  const loc = snapshot.location;
  if (!loc || !loc.valid || loc.address || !amapKey) {
    return snapshot;
  }
  if (!Number.isFinite(loc.gcjLat) || !Number.isFinite(loc.gcjLon)) {
    return snapshot;
  }
  const gridKey = `${Number(loc.gcjLat).toFixed(4)},${Number(loc.gcjLon).toFixed(4)}`;
  const cached = /** @type {Record<string, any> | undefined} */ (
    db.prepare('SELECT * FROM geo_cache WHERE grid_key=? AND updated_at > ?').get(gridKey, nowMs - GEO_CACHE_TTL_MS)
  );
  if (cached && cached.address) {
    snapshot.location = {
      ...loc,
      address: String(cached.address),
      shortAddress: String(cached.short_address || cached.address),
      source: 'amap-cache',
    };
    return snapshot;
  }

  const geo = await client.reverseGeocodeAmap(loc.gcjLat, loc.gcjLon, amapKey);
  if (geo && geo.address) {
    db.prepare(`
      INSERT INTO geo_cache (grid_key, address, short_address, source, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(grid_key) DO UPDATE SET
        address=excluded.address,
        short_address=excluded.short_address,
        source=excluded.source,
        updated_at=excluded.updated_at
    `).run(gridKey, geo.address, geo.shortAddress, geo.source, nowMs);
    snapshot.location = {
      ...loc,
      address: geo.address,
      shortAddress: geo.shortAddress,
      source: geo.source,
    };
  }
  return snapshot;
}

/**
 * Format duration seconds into concise Chinese text.
 * @param {number} sec
 * @returns {string}
 */
function formatDurationZh(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '0分钟';
  const mins = Math.round(sec / 60);
  if (mins < 60) return `${Math.max(1, mins)}分钟`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}小时${m}分钟` : `${h}小时`;
}

/**
 * Format snapshot into concise Chinese status report.
 * @param {Record<string, any>} s
 * @returns {string}
 */
function formatSnapshotSummary(s) {
  const name = s.name || s.sn || '九号电摩';
  const batt = s.battery !== null && s.battery !== undefined ? `${s.battery}%` : '未知';
  const rangeStr = s.effectiveRangeKm !== null && s.effectiveRangeKm !== undefined ? `${s.effectiveRangeKm} km` : '未知';
  const chargeStr = s.charging
    ? `充电中${s.chargingPowerW ? ` (${s.chargingPowerW}W)` : ''}${s.remainChargeTime ? ` · 预计 ${s.remainChargeTime}` : ''}`
    : '未充电';
  const lockStr = s.locked === true ? '已上锁' : s.locked === false ? '未锁车' : '锁状态未知';
  const pwrStr = s.powerOn ? '电门开启' : '电门已关';

  const lines = [`🛵 ${name}${s.color ? ` · ${s.color}` : ''}（${s.sn}）`];
  const powerMetrics = [`电量 ${batt}`, `预估续航 ${rangeStr}`];
  if (s.voltageV !== null && s.voltageV !== undefined) powerMetrics.push(`电压 ${s.voltageV}V`);
  if (s.temperatureC !== null && s.temperatureC !== undefined) powerMetrics.push(`温度 ${s.temperatureC}℃`);
  lines.push(`• 能源：${powerMetrics.join(' · ')}`);
  lines.push(`• 充电：${chargeStr}`);
  lines.push(`• 状态：${pwrStr} · ${lockStr}${s.odometerKm !== null && s.odometerKm !== undefined ? ` · 总里程 ${s.odometerKm} km` : ''}`);
  if (s.auxBattery !== null && s.auxBattery !== undefined) {
    lines.push(`• 副电/通信备电：${s.auxBattery}%`);
  }
  if (s.location?.address) {
    lines.push(`• 位置：${s.location.address}`);
  } else if (s.location?.valid) {
    lines.push(`• 坐标：${s.location.gcjLat}, ${s.location.gcjLon}（GCJ-02）`);
  } else {
    lines.push('• 位置：暂无有效定位');
  }
  if (s.smartServiceExpired) {
    lines.push('⚠️ 提示：车辆智能服务费已到期，云端数据可能停止更新。');
  }
  return lines.join('\n');
}

/**
 * Evaluate proactive patrol alerts and update `alert_state` deduplication table.
 * @param {{
 *   db: DatabaseSync;
 *   snapshot: Record<string, any>;
 *   prevSnapshotRow: Record<string, any> | null;
 *   config: ReturnType<typeof normalizeConfig>;
 *   nowMs: number;
 *   force?: boolean;
 * }} ctx
 */
function evaluatePatrolAlerts({ db, snapshot, prevSnapshotRow, config, nowMs, force = false }) {
  const sn = snapshot.sn;
  const rows = /** @type {Array<Record<string, any>>} */ (
    db.prepare('SELECT * FROM alert_state WHERE sn=?').all(sn)
  );
  /** @type {Map<string, { active: number; lastNotifiedAt: number; lastValue: string | null }>} */
  const prevAlerts = new Map();
  for (const r of rows) {
    prevAlerts.set(String(r.alert_key), {
      active: Number(r.active ?? 0),
      lastNotifiedAt: Number(r.last_notified_at ?? 0),
      lastValue: r.last_value !== null && r.last_value !== undefined ? String(r.last_value) : null,
    });
  }

  const upsertAlertState = db.prepare(`
    INSERT INTO alert_state (sn, alert_key, active, last_notified_at, last_value)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(sn, alert_key) DO UPDATE SET
      active=excluded.active,
      last_notified_at=excluded.last_notified_at,
      last_value=excluded.last_value
  `);

  const cooldownMs = config.alertCooldownHours * 3600 * 1000;
  /** @type {Array<{ key: string; level: 'warn' | 'info'; title: string; detail: string; notified: boolean }>} */
  const alerts = [];

  // 1. Low battery check
  const batt = snapshot.battery;
  const lowBattActive = batt !== null && batt !== undefined && batt <= config.lowBatteryThreshold && !snapshot.charging;
  const prevLowBatt = prevAlerts.get('low_battery');
  if (lowBattActive) {
    const prevVal = prevLowBatt?.lastValue !== null && prevLowBatt?.lastValue !== undefined
      ? Number(prevLowBatt.lastValue)
      : NaN;
    const droppedTen = prevLowBatt?.active === 1 && Number.isFinite(prevVal) && batt <= prevVal - 10;
    const cooldownOk = !prevLowBatt || prevLowBatt.active !== 1 || (nowMs - prevLowBatt.lastNotifiedAt >= cooldownMs);
    const shouldNotify = force || cooldownOk || droppedTen;
    upsertAlertState.run(
      sn,
      'low_battery',
      1,
      shouldNotify ? nowMs : (prevLowBatt?.lastNotifiedAt ?? nowMs),
      shouldNotify ? String(batt) : (prevLowBatt?.lastValue ?? String(batt)),
    );
    alerts.push({
      key: 'low_battery',
      level: 'warn',
      title: `电量偏低 (${batt}%)`,
      detail: `当前剩余电量 ${batt}%（低于阈值 ${config.lowBatteryThreshold}%）且未在充电${snapshot.effectiveRangeKm !== null ? `，预计续航约 ${snapshot.effectiveRangeKm} km` : ''}，建议及时补能。`,
      notified: shouldNotify,
    });
  } else if (snapshot.charging || (batt !== null && batt !== undefined && batt > config.lowBatteryThreshold + 5)) {
    upsertAlertState.run(sn, 'low_battery', 0, prevLowBatt?.lastNotifiedAt ?? 0, batt !== null && batt !== undefined ? String(batt) : null);
  }

  // 2. Low range check
  const rangeKm = snapshot.effectiveRangeKm;
  const lowRangeActive =
    config.minRangeKm > 0 &&
    rangeKm !== null &&
    rangeKm !== undefined &&
    rangeKm > 0 &&
    rangeKm <= config.minRangeKm &&
    !snapshot.charging;
  const prevLowRange = prevAlerts.get('low_range');
  if (lowRangeActive) {
    const lowBattNotified = alerts.some(a => a.key === 'low_battery' && a.notified);
    const cooldownOk = !prevLowRange || prevLowRange.active !== 1 || (nowMs - prevLowRange.lastNotifiedAt >= cooldownMs);
    const shouldNotify = force || cooldownOk || lowBattNotified;
    upsertAlertState.run(
      sn,
      'low_range',
      1,
      shouldNotify ? nowMs : (prevLowRange?.lastNotifiedAt ?? nowMs),
      String(rangeKm),
    );
    alerts.push({
      key: 'low_range',
      level: 'warn',
      title: `续航不足 (${rangeKm} km)`,
      detail: `当前预估续航仅剩 ${rangeKm} km（低于阈值 ${config.minRangeKm} km），建议规划充电。`,
      notified: shouldNotify,
    });
  } else if (snapshot.charging || (rangeKm !== null && rangeKm !== undefined && rangeKm > config.minRangeKm + 5)) {
    upsertAlertState.run(sn, 'low_range', 0, prevLowRange?.lastNotifiedAt ?? 0, rangeKm !== null && rangeKm !== undefined ? String(rangeKm) : null);
  }

  // 3. Charge complete transition check
  const prevChargeComplete = prevAlerts.get('charge_complete');
  const prevWasCharging = prevSnapshotRow ? Number(prevSnapshotRow.charging) === 1 : false;
  const chargeFinishedNow =
    prevWasCharging &&
    batt !== null &&
    batt !== undefined &&
    ((!snapshot.charging && batt >= 95) || (snapshot.charging && batt === 100));

  if (chargeFinishedNow) {
    const alreadyNotified = prevChargeComplete?.active === 1;
    const shouldNotify = force || !alreadyNotified;
    upsertAlertState.run(
      sn,
      'charge_complete',
      1,
      shouldNotify ? nowMs : (prevChargeComplete?.lastNotifiedAt ?? nowMs),
      String(batt),
    );
    alerts.push({
      key: 'charge_complete',
      level: 'info',
      title: `充电已完成 (${batt}%)`,
      detail: `车辆已充至 ${batt}%${snapshot.charging ? '（满电待拔枪）' : '（已停止充电）'}，可断开充电器。`,
      notified: shouldNotify,
    });
  } else if (batt !== null && batt !== undefined && batt < 95) {
    upsertAlertState.run(sn, 'charge_complete', 0, prevChargeComplete?.lastNotifiedAt ?? 0, String(batt));
  }

  // 4. Unlocked / powered-on parked warning
  const prevUnlocked = prevAlerts.get('unlocked_warning');
  const unlockedActive = Boolean(config.checkUnlocked && !snapshot.charging && (snapshot.powerOn === true || snapshot.locked === false));
  if (unlockedActive) {
    const cooldownOk = !prevUnlocked || prevUnlocked.active !== 1 || (nowMs - prevUnlocked.lastNotifiedAt >= cooldownMs);
    const shouldNotify = force || cooldownOk;
    upsertAlertState.run(
      sn,
      'unlocked_warning',
      1,
      shouldNotify ? nowMs : (prevUnlocked?.lastNotifiedAt ?? nowMs),
      `${snapshot.powerOn ? 'ON' : 'OFF'}:${snapshot.locked === false ? 'UNLOCKED' : 'UNKNOWN'}`,
    );
    alerts.push({
      key: 'unlocked_warning',
      level: 'warn',
      title: snapshot.powerOn ? '车辆未关电门' : '车辆处于未锁车状态',
      detail: `当前检测到车辆${snapshot.powerOn ? '电源处于开启状态' : '未设防上锁'}${snapshot.location?.address ? `（位置：${snapshot.location.address}）` : ''}，请确认停车安全。`,
      notified: shouldNotify,
    });
  } else if (snapshot.locked === true && !snapshot.powerOn) {
    upsertAlertState.run(sn, 'unlocked_warning', 0, prevUnlocked?.lastNotifiedAt ?? 0, 'LOCKED');
  }

  // 5. Idle discharge warning
  const prevIdle = prevAlerts.get('idle_discharge');
  let idleDays = null;
  if (config.idleRemindDays > 0 && !snapshot.charging && batt !== null && batt !== undefined && batt < 50) {
    const latestTrip = /** @type {Record<string, any> | undefined} */ (
      db.prepare('SELECT MAX(end_time) AS last_end FROM trips WHERE sn=?').get(sn)
    );
    const lastEndSec = Number(latestTrip?.last_end ?? 0);
    if (Number.isFinite(lastEndSec) && lastEndSec > 0) {
      idleDays = (nowMs / 1000 - lastEndSec) / 86400;
    } else if (snapshot.odometerKm !== null && snapshot.odometerKm !== undefined) {
      const oldestChanged = /** @type {Record<string, any> | undefined} */ (
        db.prepare('SELECT MAX(captured_at) AS last_move FROM snapshots WHERE sn=? AND (power_on=1 OR odometer_km != ?)').get(sn, snapshot.odometerKm)
      );
      const earliestSame = /** @type {Record<string, any> | undefined} */ (
        db.prepare('SELECT MIN(captured_at) AS first_ts FROM snapshots WHERE sn=?').get(sn)
      );
      const refTs = Number(oldestChanged?.last_move || earliestSame?.first_ts || 0);
      if (Number.isFinite(refTs) && refTs > 0) {
        idleDays = (nowMs - refTs) / (86400 * 1000);
      }
    }
  }
  if (idleDays !== null && idleDays >= config.idleRemindDays) {
    const cooldownOk = !prevIdle || prevIdle.active !== 1 || (nowMs - prevIdle.lastNotifiedAt >= IDLE_COOLDOWN_MS);
    const shouldNotify = force || cooldownOk;
    const roundedDays = Math.floor(idleDays);
    upsertAlertState.run(
      sn,
      'idle_discharge',
      1,
      shouldNotify ? nowMs : (prevIdle?.lastNotifiedAt ?? nowMs),
      String(roundedDays),
    );
    alerts.push({
      key: 'idle_discharge',
      level: 'warn',
      title: `久置低电提醒 (约 ${roundedDays} 天未骑行)`,
      detail: `车辆已约 ${roundedDays} 天未骑行且当前电量仅 ${batt}%，长时间亏电存放易损伤电池寿命，建议近期补电。`,
      notified: shouldNotify,
    });
  } else {
    upsertAlertState.run(sn, 'idle_discharge', 0, prevIdle?.lastNotifiedAt ?? 0, null);
  }

  // 6. Smart service expired warning
  const prevService = prevAlerts.get('smart_service_expired');
  if (snapshot.smartServiceExpired) {
    const cooldownOk = !prevService || prevService.active !== 1 || (nowMs - prevService.lastNotifiedAt >= SERVICE_EXPIRED_COOLDOWN_MS);
    const shouldNotify = force || cooldownOk;
    upsertAlertState.run(
      sn,
      'smart_service_expired',
      1,
      shouldNotify ? nowMs : (prevService?.lastNotifiedAt ?? nowMs),
      '1',
    );
    alerts.push({
      key: 'smart_service_expired',
      level: 'warn',
      title: '九号智能服务费已到期',
      detail: '车辆云盒智能服务已到期，云端位置/电量可能无法实时更新，如需继续云端守护请在九号出行 App 续费。',
      notified: shouldNotify,
    });
  } else {
    upsertAlertState.run(sn, 'smart_service_expired', 0, prevService?.lastNotifiedAt ?? 0, '0');
  }

  return alerts;
}

/**
 * Format patrol alerts cleanly, consolidating low_battery + low_range if both fire.
 * @param {Array<{ key: string; level: string; title: string; detail: string; notified: boolean }>} notifyingAlerts
 * @param {Record<string, any>} snapshot
 * @returns {string}
 */
function formatPatrolAlertMessage(notifyingAlerts, snapshot) {
  const hasLowBatt = notifyingAlerts.some(a => a.key === 'low_battery');
  const lines = [`⚡ ${snapshot.name || snapshot.sn} 主动守护提醒：`];
  for (const alert of notifyingAlerts) {
    if (alert.key === 'low_range' && hasLowBatt) {
      // Consolidated inside low_battery message
      continue;
    }
    lines.push(`• 【${alert.title}】${alert.detail}`);
  }
  lines.push('');
  lines.push(formatSnapshotSummary(snapshot));
  return lines.join('\n');
}

const MAX_ERROR_LOG_BYTES = 65_536;
const KEEP_ERROR_LOG_BYTES = 32_768;

/**
 * Append a strictly redacted error line to `console.error` (journald) and `<pluginDataDir>/error.log`.
 * Never logs credentials, tokens, vehicle SNs, locations, or host filesystem paths.
 * @param {string} pluginDataDir
 * @param {string} action
 * @param {unknown} err
 * @param {string[]} [pathsToRedact]
 * @param {number} [nowMs]
 */
function logPluginError(pluginDataDir, action, err, pathsToRedact = [], nowMs = Date.now()) {
  const code = err && typeof err === 'object' && 'code' in err && err.code ? String(err.code) : 'ERR';
  const httpStatus = err && typeof err === 'object' && 'httpStatus' in err && err.httpStatus
    ? String(err.httpStatus)
    : '';

  let cleanMsg = errMsg(err).replace(/[\r\n]+/g, ' ').trim();
  const sortedPaths = pathsToRedact
    .filter(p => typeof p === 'string' && p.trim().length > 0)
    .sort((a, b) => b.length - a.length);
  for (const p of sortedPaths) {
    cleanMsg = cleanMsg.split(p).join('<redacted-path>');
  }
  cleanMsg = cleanMsg
    .replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, '$1****$2')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <redacted>')
    .replace(/\b(access_token|refresh_token|password)\s*[:=]\s*\S+/gi, '$1=<redacted>');
  if (cleanMsg.length > 240) {
    cleanMsg = `${cleanMsg.slice(0, 237)}...`;
  }

  const line = `[ninebot] ${new Date(nowMs).toISOString()} action=${action}${httpStatus ? ` http=${httpStatus}` : ''} code=${code} msg=${cleanMsg}`;
  console.error(line);

  try {
    const logPath = join(pluginDataDir, 'error.log');
    try {
      const st = lstatSync(logPath);
      if (st.isSymbolicLink()) return;
    } catch (statErr) {
      if (/** @type {NodeJS.ErrnoException} */ (statErr)?.code !== 'ENOENT') return;
    }

    let size = 0;
    try {
      size = statSync(logPath).size;
    } catch {
      size = 0;
    }
    if (size > MAX_ERROR_LOG_BYTES) {
      const buf = readFileSync(logPath);
      let tail = buf.subarray(Math.max(0, buf.length - KEEP_ERROR_LOG_BYTES));
      const firstNl = tail.indexOf(10);
      if (firstNl >= 0 && firstNl + 1 < tail.length) {
        tail = tail.subarray(firstNl + 1);
      }
      const nextContent = `${tail.toString('utf8')}${line}\n`;
      writeFileSync(logPath, nextContent, { encoding: 'utf8', mode: 0o600 });
    } else {
      appendFileSync(logPath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    try {
      chmodSync(logPath, 0o600);
    } catch {
      // ignore chmod errors
    }
  } catch {
    // logging must never fail plugin execution
  }
}

/**
 * Execute a `ninebot` plugin action.
 * @param {string} action
 * @param {Record<string, unknown>} [args]
 * @param {import('../_shared/types.d.ts').PluginExecutionContext & {
 *   httpRequester?: (req: any) => Promise<any>;
 *   rsaPublicKeyPem?: string;
 *   hosts?: { passport?: string; biz?: string; motor?: string; ebike?: string; travel?: string; amap?: string };
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
      message: `ninebot 插件不支持动作 "${cleanAction}"。可选: ${ACTIONS.join(', ')}`,
    };
  }

  const nowFn = typeof deps?.nowFn === 'function' ? deps.nowFn : Date.now;
  const nowMs = nowFn();
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const env = deps?.env ?? process.env;

  // Security: NEVER honor args.dataDir / args.pluginDataDir / args.homeDir
  const paths = resolvePluginPaths('ninebot', deps, {
    sessionPath: 'session.json',
    dbPath: 'ninebot.sqlite',
  });
  ensurePrivateDir(paths.pluginDataDir);

  let config = normalizeConfig(readConfig(paths.configPath, { ...DEFAULT_CONFIG }));
  let session = loadSession(paths.sessionPath);

  const client = createNinebotClient({
    httpRequester: deps?.httpRequester,
    nowFn,
    signal: deps?.signal,
    rsaPublicKeyPem: deps?.rsaPublicKeyPem,
    hosts: deps?.hosts,
  });

  const db = openDb(paths.dbPath);

  /**
   * Ensure a valid account session (refreshing / logging in if needed) and persist `session.json`.
   */
  async function ensureAccountSession() {
    if (!isSessionTokenValid(/** @type {any} */ (session), nowMs)) {
      if (session.accessToken && session.refreshToken) {
        try {
          const refreshed = await client.passportRefresh(/** @type {any} */ (session));
          session = { ...session, ...refreshed };
          await saveSessionLocked(paths.sessionPath, session);
        } catch {
          // Fall through to password re-login if credentials exist
        }
      }
      if (!isSessionTokenValid(/** @type {any} */ (session), nowMs)) {
        if (config.username && config.password) {
          const sameUser = !session.username || session.username === config.username;
          const loggedIn = await client.passportLogin({
            username: config.username,
            password: config.password,
            areaCode: config.areaCode,
          });
          session = {
            deviceId: session.deviceId,
            ...(sameUser ? session : {}),
            ...loggedIn,
          };
          if (!sameUser) {
            delete session.businessUid;
            delete session.vehicles;
          }
          try {
            const bizUid = await client.businessLogin(/** @type {any} */ (session), session.deviceId);
            if (bizUid) session.businessUid = bizUid;
          } catch {
            // Preserve existing businessUid (same account) or empty fallback if businessLogin fails transiently
          }
          await saveSessionLocked(paths.sessionPath, session);
        } else {
          throw new NinebotApiError('未登录九号账号，请先执行 login 动作绑定九号子账号，或配置 NINEBOT_DEVICESERVICE_KEY。');
        }
      }
    }

    if (!session.businessUid && session.accessToken) {
      try {
        const bizUid = await client.businessLogin(/** @type {any} */ (session), session.deviceId);
        if (bizUid) {
          session.businessUid = bizUid;
          await saveSessionLocked(paths.sessionPath, session);
        }
      } catch {
        // Non-fatal; some requests still work or fall back
      }
    }
    return session;
  }

  /**
   * Execute an account API function with automatic 1-time refresh/re-login retry on auth errors.
   * @template T
   * @param {(sess: Record<string, any>) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async function callWithAccountAuth(fn) {
    let activeSession = await ensureAccountSession();
    try {
      return await fn(activeSession);
    } catch (err) {
      if (!(err instanceof NinebotApiError) || !err.isAuthError) {
        throw err;
      }
      let renewed = false;
      if (activeSession.accessToken && activeSession.refreshToken) {
        try {
          const refreshed = await client.passportRefresh(/** @type {any} */ (activeSession));
          activeSession = { ...activeSession, ...refreshed };
          renewed = true;
        } catch {
          renewed = false;
        }
      }
      if (!renewed && config.username && config.password) {
        const sameUser = !activeSession.username || activeSession.username === config.username;
        const loggedIn = await client.passportLogin({
          username: config.username,
          password: config.password,
          areaCode: config.areaCode,
        });
        activeSession = {
          deviceId: activeSession.deviceId,
          ...(sameUser ? activeSession : {}),
          ...loggedIn,
        };
        if (!sameUser) {
          delete activeSession.businessUid;
          delete activeSession.vehicles;
        }
        renewed = true;
      }
      if (!renewed) throw err;

      try {
        const bizUid = await client.businessLogin(/** @type {any} */ (activeSession), activeSession.deviceId);
        if (bizUid) activeSession.businessUid = bizUid;
      } catch {
        // Ignore transient business-login failure
      }
      session = activeSession;
      await saveSessionLocked(paths.sessionPath, session);
      return await fn(activeSession);
    }
  }

  /**
   * Resolve target vehicle SN & metadata, discovering vehicles automatically when needed.
   * @param {'account' | 'official'} backend
   * @param {string} [requestedSn]
   */
  async function resolveTargetVehicle(backend, requestedSn) {
    const cleanReqSn = typeof requestedSn === 'string' ? requestedSn.trim() : '';
    /** @type {Array<Record<string, any>>} */
    let cachedVehicles = Array.isArray(session.vehicles) ? session.vehicles : [];

    const officialKey = String(config.deviceServiceKey || env?.NINEBOT_DEVICESERVICE_KEY || '').trim();
    if (backend === 'official') {
      if (!officialKey) {
        throw new NinebotApiError('未配置 NINEBOT_DEVICESERVICE_KEY');
      }
      if (!cleanReqSn && !config.defaultSn) {
        const list = await client.officialListVehicles(officialKey);
        if (!list.length) {
          throw new NinebotApiError('官方 DeviceService 下未找到绑定车辆');
        }
        const picked = /** @type {Record<string, any>} */ (list[0]);
        config = normalizeConfig({ ...config, defaultSn: String(picked.sn), deviceName: String(picked.name || '') });
        await withFileLock(paths.configPath, () => writeConfig(paths.configPath, config));
        return { sn: String(picked.sn), vehicleMeta: picked };
      }
      const sn = cleanReqSn || config.defaultSn;
      const meta = cachedVehicles.find(v => v.sn === sn) || null;
      return { sn, vehicleMeta: meta };
    }

    // Account backend
    if (cleanReqSn) {
      const meta = cachedVehicles.find(v => v.sn === cleanReqSn) || null;
      return { sn: cleanReqSn, vehicleMeta: meta };
    }
    if (config.defaultSn) {
      const meta = cachedVehicles.find(v => v.sn === config.defaultSn) || null;
      return { sn: config.defaultSn, vehicleMeta: meta };
    }

    const vehicles = await callWithAccountAuth(sess => client.listVehicles(/** @type {any} */ (sess), config.preferredLine));
    if (!vehicles.length) {
      throw new NinebotApiError('当前九号账号下未绑定任何车辆，请确认已在九号出行 App 完成车辆绑定或子账号授权。');
    }
    session = { ...session, vehicles };
    await saveSessionLocked(paths.sessionPath, session);

    const motorMatch = vehicles.find(v => v.businessLine === 'motor');
    const picked = motorMatch || vehicles[0];
    config = normalizeConfig({
      ...config,
      defaultSn: String(picked.sn),
      deviceName: String(picked.name || ''),
      preferredLine: picked.businessLine === 'ebike' ? 'ebike' : 'motor',
    });
    await withFileLock(paths.configPath, () => writeConfig(paths.configPath, config));
    return { sn: String(picked.sn), vehicleMeta: picked };
  }

  /**
   * Fetch live snapshot (account or official), enrich with optional AMap geocode, and store in SQLite.
   * @param {string} [requestedSn]
   * @param {string} [requestedBackend]
   */
  async function syncLiveSnapshot(requestedSn, requestedBackend) {
    const backend = resolveEffectiveBackend(config, session, env, requestedBackend);
    const { sn, vehicleMeta } = await resolveTargetVehicle(backend, requestedSn);
    const prevSnapshotRow = getLatestSnapshotRow(db, sn);

    let snapshot;
    if (backend === 'official') {
      const officialKey = String(config.deviceServiceKey || env?.NINEBOT_DEVICESERVICE_KEY || '').trim();
      if (!officialKey) {
        throw new NinebotApiError('已选择 official 后端，但未配置 deviceServiceKey / NINEBOT_DEVICESERVICE_KEY');
      }
      snapshot = await client.officialFetchSnapshot(officialKey, sn, vehicleMeta);
    } else {
      snapshot = await callWithAccountAuth(sess =>
        client.fetchVehicleSnapshotAccount(/** @type {any} */ (sess), sn, {
          preferredLine: config.preferredLine,
          vehicleMeta,
          coordSys: config.coordSys,
        }),
      );
    }

    const { key: amapKey } = resolveSystemAmapKey({
      homeDir: paths.homeDir,
      env,
      fallbackKey: config.amapKey,
    });
    if (deps?.httpRequester || deps?.hosts?.amap) {
      snapshot = await enrichLocationWithGeo(db, snapshot, client, amapKey, nowMs);
    } else if (
      snapshot.location?.valid
      && !snapshot.location.address
      && amapKey
      && Number.isFinite(snapshot.location.gcjLat)
      && Number.isFinite(snapshot.location.gcjLon)
    ) {
      const geo = await reverseGeocodeWithCache({
        homeDir: paths.homeDir,
        env,
        lat: snapshot.location.gcjLat,
        lon: snapshot.location.gcjLon,
        coordSys: 'gcj02',
        fallbackKey: config.amapKey,
        nowMs,
      });
      if (geo.address) {
        snapshot.location = {
          ...snapshot.location,
          address: geo.address,
          shortAddress: geo.shortAddress || geo.address,
          source: geo.source || 'amap',
        };
      }
    }
    insertSnapshot(db, snapshot);

    if (snapshot.locked === true && !snapshot.powerOn) {
      db.prepare(
        "UPDATE alert_state SET active=0, last_value='LOCKED' WHERE sn=? AND alert_key='unlocked_warning' AND active=1",
      ).run(sn);
    }

    await syncVehicleImagesCache(
      paths.pluginDataDir,
      client,
      sn,
      String(snapshot.darkImageUrl || ''),
      String(snapshot.lightImageUrl || ''),
      nowMs,
    );

    return { snapshot, prevSnapshotRow, backend };
  }

  try {
    if (cleanAction === 'config') {
      const hasMutation = [
        'backend',
        'preferredLine',
        'coordSys',
        'defaultSn',
        'deviceName',
        'username',
        'password',
        'areaCode',
        'deviceServiceKey',
        'amapKey',
        'lowBatteryThreshold',
        'minRangeKm',
        'idleRemindDays',
        'alertCooldownHours',
        'checkUnlocked',
        'clearCredentials',
      ].some(k => k in safeArgs);

      if (hasMutation) {
        await withFileLock(paths.configPath, () => {
          const cur = normalizeConfig(readConfig(paths.configPath, { ...DEFAULT_CONFIG }));
          const nextRaw = { ...cur };
          if (safeArgs.clearCredentials) {
            nextRaw.username = '';
            nextRaw.password = '';
            nextRaw.deviceServiceKey = '';
          }
          for (const key of [
            'backend',
            'preferredLine',
            'coordSys',
            'defaultSn',
            'deviceName',
            'username',
            'password',
            'areaCode',
            'deviceServiceKey',
            'amapKey',
            'lowBatteryThreshold',
            'minRangeKm',
            'idleRemindDays',
            'alertCooldownHours',
            'checkUnlocked',
          ]) {
            if (safeArgs[key] !== undefined) {
              /** @type {any} */ (nextRaw)[key] = safeArgs[key];
            }
          }
          config = normalizeConfig(nextRaw);
          writeConfig(paths.configPath, config);
        });
        if (safeArgs.clearCredentials) {
          session = { deviceId: session.deviceId };
          await saveSessionLocked(paths.sessionPath, session);
        }
        if (typeof safeArgs.amapKey === 'string' && safeArgs.amapKey.trim()) {
          await saveSystemGeoConfig({
            homeDir: paths.homeDir,
            env,
            amapKey: safeArgs.amapKey.trim(),
          });
        }
      }

      const redacted = redactConfig(config, session, env, nowMs, paths.homeDir);
      return {
        ok: true,
        notify: false,
        title: hasMutation ? '已更新九号守护配置' : '九号守护配置',
        message: hasMutation
          ? `配置已保存：默认车辆 ${redacted.defaultSn || '未绑定'}，车型线路 ${redacted.preferredLine}，低电量提醒 ${redacted.lowBatteryThreshold}%，低续航提醒 ${redacted.minRangeKm} km。`
          : `当前配置：默认车辆 ${redacted.defaultSn || '未绑定'}，后端 ${redacted.effectiveBackend}，低电量提醒 ${redacted.lowBatteryThreshold}%。`,
        data: redacted,
      };
    }

    if (cleanAction === 'login') {
      const username = String(safeArgs.username ?? config.username ?? '').trim();
      const password = typeof safeArgs.password === 'string' && safeArgs.password
        ? safeArgs.password
        : config.password;
      const areaCode = String(safeArgs.areaCode ?? config.areaCode ?? '86').trim() || '86';

      if (!username || !password) {
        logPluginError(
          paths.pluginDataDir,
          cleanAction,
          new NinebotApiError('缺少九号账号或密码', { code: 'MISSING_CREDENTIALS' }),
          [paths.pluginDataDir, paths.homeDir],
          nowMs,
        );
        return {
          ok: false,
          notify: true,
          title: '九号登录缺少凭据',
          message: '请传入 username 与 password（强烈建议使用在《九号出行》App 建立的「用车人/家庭只读子账号」）。',
        };
      }

      const sameUser = !session.username || session.username === username;
      const loggedIn = await client.passportLogin({ username, password, areaCode });
      let businessUid = sameUser ? (session.businessUid || '') : '';
      try {
        const uid = await client.businessLogin(/** @type {any} */ (loggedIn), session.deviceId);
        if (uid) businessUid = uid;
      } catch {
        // Keep best-effort businessUid fallback for same account
      }

      session = {
        deviceId: session.deviceId,
        ...(sameUser ? session : {}),
        ...loggedIn,
        businessUid,
      };

      const vehicles = await client.listVehicles(/** @type {any} */ (session), config.preferredLine);
      session.vehicles = vehicles;
      await saveSessionLocked(paths.sessionPath, session);

      const savePassword = safeArgs.savePassword !== false;
      const motorMatch = vehicles.find(v => v.businessLine === 'motor');
      const autoVehicle = (!config.defaultSn && vehicles.length) ? (motorMatch || vehicles[0]) : null;

      await withFileLock(paths.configPath, () => {
        const cur = normalizeConfig(readConfig(paths.configPath, { ...DEFAULT_CONFIG }));
        config = normalizeConfig({
          ...cur,
          username,
          password: savePassword ? password : '',
          areaCode,
          ...(autoVehicle ? {
            defaultSn: String(autoVehicle.sn),
            deviceName: String(autoVehicle.name || ''),
            preferredLine: autoVehicle.businessLine === 'ebike' ? 'ebike' : 'motor',
          } : {}),
        });
        writeConfig(paths.configPath, config);
      });

      const selected = vehicles.find(v => v.sn === config.defaultSn) || autoVehicle || vehicles[0] || null;
      if (selected) {
        await syncVehicleImagesCache(
          paths.pluginDataDir,
          client,
          String(selected.sn),
          String(selected.darkImageUrl || ''),
          String(selected.lightImageUrl || ''),
          nowMs,
        );
      }
      const isMainAccount = selected ? selected.isSharedAccount === false : false;
      const tips = isMainAccount
        ? '\n⚠️ 检测到当前账号为车主主账号，建议改用《九号出行》App 的「用车人/家庭子账号」（仅开位置与骑行记录权限），避免挤掉手机端登录并实现账号级只读隔离。'
        : '';

      return {
        ok: true,
        notify: true,
        title: '九号账号登录成功',
        message: vehicles.length
          ? `已登录账号 ${maskUsername(username)}，发现 ${vehicles.length} 台车辆${selected ? `，当前默认车辆：${selected.name} (${selected.sn})` : ''}。${tips}`
          : `已登录账号 ${maskUsername(username)}，暂未发现绑定车辆，请检查 App 车辆绑定或子账号授权。`,
        data: {
          config: redactConfig(config, session, env, nowMs, paths.homeDir),
          vehicles,
        },
      };
    }

    if (cleanAction === 'vehicles') {
      const backend = resolveEffectiveBackend(config, session, env, typeof safeArgs.backend === 'string' ? safeArgs.backend : undefined);
      const vehicles = backend === 'official'
        ? await client.officialListVehicles(String(config.deviceServiceKey || env?.NINEBOT_DEVICESERVICE_KEY || ''))
        : await callWithAccountAuth(sess => client.listVehicles(/** @type {any} */ (sess), config.preferredLine));

      if (backend === 'account') {
        session = { ...session, vehicles };
        await saveSessionLocked(paths.sessionPath, session);
      }

      const selectSn = typeof safeArgs.selectSn === 'string' ? safeArgs.selectSn.trim() : '';
      const selectName = typeof safeArgs.selectName === 'string' ? safeArgs.selectName.trim() : '';
      let matched = null;
      if (selectSn) {
        matched = vehicles.find(v => v?.sn === selectSn) || null;
      } else if (selectName) {
        matched = vehicles.find(v => v && (String(v.name).includes(selectName) || String(v.modelName).includes(selectName))) || null;
      } else if (!config.defaultSn && vehicles.length) {
        matched = vehicles.find(v => v?.businessLine === 'motor') || vehicles[0] || null;
      }

      if (matched) {
        await withFileLock(paths.configPath, () => {
          const cur = normalizeConfig(readConfig(paths.configPath, { ...DEFAULT_CONFIG }));
          config = normalizeConfig({
            ...cur,
            defaultSn: String(matched.sn),
            deviceName: String(matched.name || ''),
            preferredLine: matched.businessLine === 'ebike' ? 'ebike' : 'motor',
          });
          writeConfig(paths.configPath, config);
        });
        await syncVehicleImagesCache(
          paths.pluginDataDir,
          client,
          String(matched.sn),
          String(matched.darkImageUrl || ''),
          String(matched.lightImageUrl || ''),
          nowMs,
        );
      }

      const lines = vehicles.length
        ? vehicles.map(v => `• ${v?.name} (${v?.sn}) [${v?.businessLine === 'motor' ? '电摩' : v?.businessLine === 'ebike' ? '电自' : '官方'}]${v?.sn === config.defaultSn ? ' ← 当前默认' : ''}`)
        : ['当前账号下暂无车辆。'];

      return {
        ok: true,
        notify: false,
        title: `九号车辆列表 (${vehicles.length} 台)`,
        message: lines.join('\n'),
        data: {
          defaultSn: config.defaultSn,
          vehicles,
        },
      };
    }

    if (cleanAction === 'status') {
      if (safeArgs.offline) {
        const sn = String(safeArgs.sn ?? config.defaultSn ?? '').trim();
        const row = sn
          ? getLatestSnapshotRow(db, sn)
          : /** @type {Record<string, any> | undefined} */ (db.prepare('SELECT * FROM snapshots ORDER BY captured_at DESC, id DESC LIMIT 1').get());
        if (!row || typeof row.payload_json !== 'string') {
          return {
            ok: false,
            notify: false,
            title: '暂无本地车况缓存',
            message: '本地尚无九号电摩历史快照，请先执行一次联网查询。',
          };
        }
        const cachedSnapshot = JSON.parse(String(row.payload_json));
        return {
          ok: true,
          notify: true,
          title: `${cachedSnapshot.name || cachedSnapshot.sn} 本地缓存车况`,
          message: formatSnapshotSummary(cachedSnapshot),
          data: { offline: true, snapshot: cachedSnapshot },
        };
      }

      const { snapshot } = await syncLiveSnapshot(
        typeof safeArgs.sn === 'string' ? safeArgs.sn : undefined,
        typeof safeArgs.backend === 'string' ? safeArgs.backend : undefined,
      );
      return {
        ok: true,
        notify: true,
        title: `${snapshot.name || snapshot.sn} 实时车况`,
        message: formatSnapshotSummary(snapshot),
        data: { offline: false, snapshot },
      };
    }

    if (cleanAction === 'patrol' || cleanAction === 'charge-check') {
      const force = Boolean(safeArgs.force);
      const { snapshot, prevSnapshotRow } = await syncLiveSnapshot(
        typeof safeArgs.sn === 'string' ? safeArgs.sn : undefined,
        typeof safeArgs.backend === 'string' ? safeArgs.backend : undefined,
      );
      const alerts = evaluatePatrolAlerts({
        db,
        snapshot,
        prevSnapshotRow,
        config,
        nowMs,
        force,
      });
      const notifyingAlerts = alerts.filter(a => a.notified);
      const triggered = notifyingAlerts.length > 0;

      if (triggered) {
        return {
          ok: true,
          notify: true,
          title: '⚡ 九号电摩主动提醒',
          message: formatPatrolAlertMessage(notifyingAlerts, snapshot),
          data: {
            triggered: true,
            alerts: notifyingAlerts,
            allEvaluatedAlerts: alerts,
            snapshot,
          },
        };
      }

      const summaryMsg = formatSnapshotSummary(snapshot);
      return {
        ok: true,
        notify: force,
        title: force ? '🛵 九号电摩巡检报告' : '九号电摩巡检正常',
        message: force ? `✅ 巡检状态正常，当前无需处理。\n\n${summaryMsg}` : summaryMsg,
        data: {
          triggered: false,
          alerts: [],
          allEvaluatedAlerts: alerts,
          snapshot,
        },
      };
    }

    if (cleanAction === 'trips') {
      const sn = String(safeArgs.sn ?? config.defaultSn ?? '').trim();
      const month = normalizeMonthCompact(safeArgs.month, formatShDateParts(nowMs).monthCompact);
      const limit = clampInt(safeArgs.limit, 1, 100) ?? 10;
      const detailId = typeof safeArgs.detailId === 'string' ? safeArgs.detailId.trim() : '';

      if (safeArgs.offline) {
        const targetSn = sn || String(
          /** @type {any} */ (db.prepare('SELECT sn FROM trips ORDER BY end_time DESC LIMIT 1').get())?.sn || '',
        );
        if (!targetSn) {
          return {
            ok: false,
            notify: false,
            title: '暂无本地行程缓存',
            message: '本地尚无骑行行程缓存，请先联网同步一次。',
          };
        }
        const summary = summarizeCachedTrips(db, targetSn, nowMs, safeArgs.month ? month : undefined, limit);
        return {
          ok: true,
          notify: true,
          title: `九号电摩行程统计 (${month})`,
          message: `本月共 ${summary.tripCount} 次骑行，累计 ${summary.totalDistanceKm} km（今日 ${summary.todayDistanceKm} km），历史极速 ${summary.maxSpeedKmh} km/h，平均速度 ${summary.overallAvgSpeedKmh} km/h。`,
          data: { offline: true, sn: targetSn, month, ...summary },
        };
      }

      const backend = resolveEffectiveBackend(config, session, env, typeof safeArgs.backend === 'string' ? safeArgs.backend : undefined);
      if (backend === 'official') {
        return {
          ok: false,
          notify: false,
          title: '官方 Key 暂不支持行程列表',
          message: '官方 DeviceService Key 仅开放基础车况只读接口；如需查询月度行程与最高速统计，请绑定九号子账号。',
        };
      }

      const { sn: resolvedSn, vehicleMeta } = await resolveTargetVehicle('account', sn);
      const vLine = (vehicleMeta?.businessLine === 'ebike' || (!vehicleMeta && config.preferredLine === 'ebike'))
        ? 'ebike'
        : 'motor';
      const explicitPage = safeArgs.page !== undefined ? clampInt(safeArgs.page, 1, 50) : undefined;
      const fetched = await callWithAccountAuth(sess =>
        client.fetchTrips(/** @type {any} */ (sess), resolvedSn, month, {
          businessLine: vLine,
          ...(explicitPage !== undefined ? { page: explicitPage } : { maxPages: 15 }),
        }),
      );
      upsertTrips(db, resolvedSn, fetched.trips, nowMs);

      let detail = null;
      if (detailId) {
        detail = await callWithAccountAuth(sess =>
          client.fetchTripDetail(/** @type {any} */ (sess), resolvedSn, detailId, { businessLine: vLine }),
        );
      }

      const summary = summarizeCachedTrips(db, resolvedSn, nowMs, month, limit);
      const latestRide = summary.trips[0];
      const lines = [
        `🛣️ ${config.deviceName || resolvedSn} ${month} 骑行统计`,
        `• 本月：${summary.tripCount} 次 · ${summary.totalDistanceKm} km · 耗时 ${formatDurationZh(summary.totalDurationSec)}`,
        `• 今日：${summary.todayCount} 次 · ${summary.todayDistanceKm} km | 近 7 日：${summary.sevenDayCount} 次 · ${summary.sevenDayDistanceKm} km`,
        `• 极速：${summary.maxSpeedKmh} km/h · 均速 ${summary.overallAvgSpeedKmh} km/h`,
      ];
      if (latestRide) {
        lines.push(
          `• 最近一次：${latestRide.date || ''} ${latestRide.distanceKm} km（极速 ${latestRide.maxSpeedKmh} km/h，均速 ${latestRide.avgSpeedKmh} km/h，耗时 ${formatDurationZh(latestRide.durationSec)}）`,
        );
      }

      return {
        ok: true,
        notify: true,
        title: `九号电摩行程统计 (${month})`,
        message: lines.join('\n'),
        data: {
          offline: false,
          sn: resolvedSn,
          month,
          ...summary,
          ...(detail ? { detail } : {}),
        },
      };
    }

    if (cleanAction === 'dashboard') {
      const limit = clampInt(safeArgs.limit, 1, 100) ?? 20;
      let latestSnapshot = null;

      if (safeArgs.refresh) {
        const synced = await syncLiveSnapshot(
          typeof safeArgs.sn === 'string' ? safeArgs.sn : undefined,
          typeof safeArgs.backend === 'string' ? safeArgs.backend : undefined,
        );
        latestSnapshot = synced.snapshot;
      }

      const sn = String(safeArgs.sn ?? latestSnapshot?.sn ?? config.defaultSn ?? '').trim();
      const vehiclesList = Array.isArray(session.vehicles) ? session.vehicles : [];
      if (!latestSnapshot && sn) {
        const row = getLatestSnapshotRow(db, sn);
        if (row && typeof row.payload_json === 'string') {
          latestSnapshot = JSON.parse(String(row.payload_json));
        }
      }
      if (latestSnapshot && !latestSnapshot.color && sn) {
        const matchedVeh = vehiclesList.find(v => v?.sn === sn);
        if (matchedVeh?.color) {
          latestSnapshot = { ...latestSnapshot, color: String(matchedVeh.color) };
        }
      }

      const history = sn ? getRecentSnapshotSummaries(db, sn, limit) : [];
      const currentMonth = formatShDateParts(nowMs).monthCompact;
      let tripSummary = sn ? summarizeCachedTrips(db, sn, nowMs, currentMonth, 10) : null;
      if (sn && tripSummary && tripSummary.tripCount === 0) {
        const anyMonthSummary = summarizeCachedTrips(db, sn, nowMs, undefined, 10);
        if (anyMonthSummary.tripCount > 0) {
          tripSummary = anyMonthSummary;
        }
      }
      const activeAlerts = sn
        ? /** @type {Array<Record<string, any>>} */ (
            db.prepare('SELECT alert_key, active, last_notified_at, last_value FROM alert_state WHERE sn=? AND active=1').all(sn)
          ).map(r => ({
            key: String(r.alert_key),
            lastNotifiedAt: Number(r.last_notified_at),
            lastValue: r.last_value,
          }))
        : [];
      const redactedCfg = redactConfig(config, session, env, nowMs, paths.homeDir);
      const vehicleImages = readVehicleImageDataUrls(paths.pluginDataDir, sn);

      return {
        ok: true,
        notify: false,
        title: '九号电摩数据看板',
        message: latestSnapshot
          ? formatSnapshotSummary(latestSnapshot)
          : '尚未采集到九号电摩数据，请先执行 login 与 status。',
        data: {
          configured: redactedCfg.hasSession || redactedCfg.hasDeviceServiceKey || (redactedCfg.hasPassword && Boolean(redactedCfg.usernameMasked)),
          vehicles: vehiclesList,
          snapshot: latestSnapshot,
          vehicleImages,
          history,
          tripSummary,
          activeAlerts,
          config: redactedCfg,
        },
      };
    }

    return {
      ok: false,
      notify: false,
      title: '未知动作',
      message: `不支持动作 ${cleanAction}`,
    };
  } catch (err) {
    logPluginError(paths.pluginDataDir, cleanAction, err, [paths.pluginDataDir, paths.homeDir], nowMs);
    return {
      ok: false,
      notify: true,
      title: `ninebot ${cleanAction} 执行失败`,
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

/**
 * XiaoAI / IM voice fastpath handler for read-only Ninebot vehicle queries.
 * @param {import('../_shared/types.d.ts').VoiceFastpathRequest} request
 * @param {import('../_shared/types.d.ts').PluginExecutionContext & Record<string, any>} [context]
 * @returns {Promise<import('../_shared/types.d.ts').VoiceFastpathResult>}
 */
export async function handleVoiceFastpath(request, context = {}) {
  let text = String(request?.text || '').replace(ASR_TAG_RE, '').trim();
  text = text.replace(WAKE_PREFIX_RE, '').replace(TRAILING_PUNCT_RE, '').trim();

  if (!text || !NINEBOT_TRIGGER_RE.test(text) || NINEBOT_EXCLUSION_RE.test(text)) {
    return { handled: false };
  }

  // Strictly block remote vehicle control requests while allowing state questions ("锁好没?")
  if (NINEBOT_CONTROL_CMD_RE.test(text) && !NINEBOT_STATE_QUESTION_RE.test(text)) {
    return {
      handled: true,
      plugin: 'ninebot',
      action: 'status',
      ok: false,
      speech: '出于安全考虑，九号电摩插件运行在只读守护模式，不支持远程开关锁或控车操作。',
      followUp: false,
      clearSessionState: true,
    };
  }

  if (NINEBOT_TRIPS_RE.test(text)) {
    const res = await runAction('trips', {}, context);
    if (!res.ok) {
      return {
        handled: true,
        plugin: 'ninebot',
        action: 'trips',
        ok: false,
        speech: res.message || '查询九号骑行行程失败。',
        followUp: false,
        clearSessionState: true,
        data: res.data,
      };
    }
    const d = /** @type {Record<string, any>} */ (res.data || {});
    const speech = d.todayCount > 0
      ? `你的九号电摩今天骑了 ${d.todayCount} 次共 ${d.todayDistanceKm} 公里，本月累计 ${d.totalDistanceKm} 公里，最高速度 ${d.maxSpeedKmh} 公里每小时。`
      : `今天还没有骑行记录，本月累计骑了 ${d.tripCount ?? 0} 次共 ${d.totalDistanceKm ?? 0} 公里，最高速度 ${d.maxSpeedKmh ?? 0} 公里每小时。`;
    return {
      handled: true,
      plugin: 'ninebot',
      action: 'trips',
      ok: true,
      speech,
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }

  if (NINEBOT_LOCATION_LOCK_RE.test(text)) {
    const res = await runAction('status', {}, context);
    if (!res.ok) {
      return {
        handled: true,
        plugin: 'ninebot',
        action: 'status',
        ok: false,
        speech: res.message || '查询九号电摩位置和锁车状态失败。',
        followUp: false,
        clearSessionState: true,
        data: res.data,
      };
    }
    const statusData = /** @type {Record<string, any>} */ (res.data || {});
    const s = /** @type {Record<string, any>} */ (statusData.snapshot || {});
    const lockText = s.locked === true ? '已经上锁' : s.locked === false ? '目前没有锁车，注意检查' : '锁车状态暂时未知';
    const powerText = s.powerOn ? '电门还开着' : '电门已关';
    const locText = s.location?.shortAddress || s.location?.address
      ? `停在${s.location.shortAddress || s.location.address}`
      : s.location?.valid
        ? `当前坐标在纬度 ${s.location.gcjLat} 经度 ${s.location.gcjLon}`
        : '暂时没有获取到定位';
    return {
      handled: true,
      plugin: 'ninebot',
      action: 'status',
      ok: true,
      speech: `你的${s.name || '九号电摩'}${locText}，${powerText}，${lockText}，剩余电量百分之 ${s.battery ?? '未知'}。`,
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }

  if (NINEBOT_STATUS_RE.test(text)) {
    const res = await runAction('status', {}, context);
    if (!res.ok) {
      return {
        handled: true,
        plugin: 'ninebot',
        action: 'status',
        ok: false,
        speech: res.message || '九号电摩尚未绑定账号，请先配置或登录九号子账号。',
        followUp: false,
        clearSessionState: true,
        data: res.data,
      };
    }
    const statusData = /** @type {Record<string, any>} */ (res.data || {});
    const s = /** @type {Record<string, any>} */ (statusData.snapshot || {});
    const chargePart = s.charging
      ? `正在充电${s.chargingPowerW ? `，功率 ${s.chargingPowerW} 瓦` : ''}${s.remainChargeTime ? `，大约还需要 ${s.remainChargeTime}` : ''}`
      : '目前没在充电';
    const rangePart = s.effectiveRangeKm !== null && s.effectiveRangeKm !== undefined
      ? `，预估还能跑 ${s.effectiveRangeKm} 公里`
      : '';
    const voltPart = s.voltageV !== null && s.voltageV !== undefined ? `，电压 ${s.voltageV} 伏` : '';
    return {
      handled: true,
      plugin: 'ninebot',
      action: 'status',
      ok: true,
      speech: `你的${s.name || '九号电摩'}当前电量百分之 ${s.battery ?? '未知'}${voltPart}${rangePart}，${chargePart}。`,
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }

  return { handled: false };
}

async function main() {
  const action = process.argv[2] || 'status';
  /** @type {Record<string, unknown>} */
  let args = {};
  if (process.argv[3]) {
    try {
      args = JSON.parse(process.argv[3]);
    } catch {
      args = {};
    }
  }
  const result = await runAction(action, args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch(err => {
    process.stderr.write(`ninebot error: ${errMsg(err)}\n`);
    process.exitCode = 1;
  });
}

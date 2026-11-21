import { existsSync, chmodSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import {
  ensurePrivateDir,
  readJsonSafe,
  resolveHomeDir,
  withFileLock,
  writeJsonAtomic,
} from './config-store.mjs';

export const AMAP_REGEO_URL = 'https://restapi.amap.com/v3/geocode/regeo';
export const GEO_CACHE_TTL_MS = 24 * 3600 * 1000;
const MIN_AMAP_INTERVAL_MS = 360;
const DEFAULT_HTTP_TIMEOUT_MS = 8_000;
const MAX_HTTP_BYTES = 1024 * 1024;

let rateLimitChain = Promise.resolve();
let lastAmapRequestAtMs = 0;

/**
 * Mask an API key for safe UI / status display without revealing the secret.
 * @param {unknown} raw
 * @returns {string}
 */
export function maskApiKey(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  if (s.length >= 10) {
    return `${s.slice(0, 4)}****${s.slice(-4)}`;
  }
  if (s.length >= 4) {
    return `${s[0]}***${s[s.length - 1]}`;
  }
  return '***';
}

/**
 * Check whether coordinates fall outside the GCJ-02 China bounding box.
 * @param {number} lon
 * @param {number} lat
 * @returns {boolean}
 */
export function outOfChina(lon, lat) {
  return !(lon > 72.004 && lon < 137.8347 && lat > 0.8293 && lat < 55.8271);
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320.0 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
function transformLon(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

/**
 * Convert WGS-84 coordinates into GCJ-02 inside Mainland China; return unchanged outside China.
 * @param {number} lat
 * @param {number} lon
 * @returns {{ lat: number; lon: number; inChina: boolean }}
 */
export function wgs84ToGcj02(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { lat, lon, inChina: false };
  }
  if ((lat === 0 && lon === 0) || outOfChina(lon, lat)) {
    return { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), inChina: false };
  }
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return {
    lat: Number((lat + dLat).toFixed(6)),
    lon: Number((lon + dLon).toFixed(6)),
    inChina: true,
  };
}

/**
 * Great-circle Haversine distance in rounded meters.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
export function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = (Math.sin(dLat / 2) ** 2)
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * (Math.sin(dLon / 2) ** 2);
  return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<{ status: number; body: Buffer }>}
 */
function defaultGetRequester(url, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? https : http;
    const req = transport.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'User-Agent': 'friday-geo/1.0',
        },
        timeout: timeoutMs,
      },
      res => {
        /** @type {Buffer[]} */
        const chunks = [];
        let total = 0;
        res.on('data', chunk => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > MAX_HTTP_BYTES) {
            req.destroy(new Error('Geo response too large'));
            return;
          }
          chunks.push(buf);
        });
        res.on('end', () => {
          let raw = Buffer.concat(chunks);
          const encHeader = res.headers['content-encoding'];
          const encoding = (Array.isArray(encHeader) ? encHeader[0] : encHeader || '').toLowerCase().trim();
          try {
            if (encoding === 'gzip') raw = gunzipSync(raw);
            else if (encoding === 'deflate') raw = inflateSync(raw);
            else if (encoding === 'br') raw = brotliDecompressSync(raw);
          } catch (err) {
            reject(err);
            return;
          }
          resolve({ status: res.statusCode ?? 0, body: raw });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时 (${timeoutMs}ms)`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Resolve the effective AMap Web Service API Key across System Base config, env, and optional plugin fallback.
 * @param {{ homeDir?: string; env?: Record<string, string | undefined>; fallbackKey?: string }} [opts]
 * @returns {{ key: string; source: 'system' | 'env' | 'plugin' | 'none' }}
 */
export function resolveSystemAmapKey(opts = {}) {
  const homeDir = resolveHomeDir(opts);
  const cfgPath = join(homeDir, 'geo-config.json');
  const rawCfg = readJsonSafe(cfgPath, /** @type {Record<string, unknown>} */ ({}));
  const sysKey = typeof rawCfg?.amapKey === 'string' ? rawCfg.amapKey.trim() : '';
  if (sysKey) {
    return { key: sysKey, source: 'system' };
  }
  const envObj = opts.env ?? process.env;
  const envKey = typeof envObj?.AMAP_KEY === 'string' ? envObj.AMAP_KEY.trim() : '';
  if (envKey) {
    return { key: envKey, source: 'env' };
  }
  const pluginKey = typeof opts.fallbackKey === 'string' ? opts.fallbackKey.trim() : '';
  if (pluginKey) {
    return { key: pluginKey, source: 'plugin' };
  }
  return { key: '', source: 'none' };
}

/**
 * Read redacted System-Base Geo service configuration and cache statistics.
 * Never exposes plaintext API keys or host filesystem paths.
 * @param {{ homeDir?: string; env?: Record<string, string | undefined> }} [opts]
 * @returns {{ configured: boolean; source: 'system' | 'env' | 'none'; maskedKey: string; updatedAt: number | null; cacheEntries: number }}
 */
export function getSystemGeoStatus(opts = {}) {
  const homeDir = resolveHomeDir(opts);
  const cfgPath = join(homeDir, 'geo-config.json');
  const rawCfg = readJsonSafe(cfgPath, /** @type {Record<string, unknown>} */ ({}));
  const sysKey = typeof rawCfg?.amapKey === 'string' ? rawCfg.amapKey.trim() : '';
  const updatedAt = typeof rawCfg?.updatedAt === 'number' && Number.isFinite(rawCfg.updatedAt)
    ? rawCfg.updatedAt
    : null;

  const envObj = opts.env ?? process.env;
  const envKey = typeof envObj?.AMAP_KEY === 'string' ? envObj.AMAP_KEY.trim() : '';

  const effectiveKey = sysKey || envKey;
  /** @type {'system' | 'env' | 'none'} */
  const source = sysKey ? 'system' : envKey ? 'env' : 'none';

  let cacheEntries = 0;
  const dbPath = join(homeDir, 'geo-cache.sqlite');
  if (existsSync(dbPath)) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const row = /** @type {{ cnt?: number } | undefined} */ (
        db.prepare('SELECT COUNT(*) AS cnt FROM geo_regeo_cache').get()
      );
      cacheEntries = Number(row?.cnt ?? 0);
    } catch {
      cacheEntries = 0;
    } finally {
      try {
        db?.close();
      } catch {
        // ignore close failure
      }
    }
  }

  return {
    configured: Boolean(effectiveKey),
    source,
    maskedKey: maskApiKey(effectiveKey),
    updatedAt,
    cacheEntries,
  };
}

/**
 * Persist or clear the System-Base AMap Web Service API Key atomically (`0600` permissions).
 * @param {{ homeDir?: string; env?: Record<string, string | undefined>; amapKey?: string; clearAmapKey?: boolean }} [opts]
 */
export async function saveSystemGeoConfig(opts = {}) {
  const homeDir = resolveHomeDir(opts);
  ensurePrivateDir(homeDir);
  const cfgPath = join(homeDir, 'geo-config.json');

  await withFileLock(cfgPath, () => {
    const cur = readJsonSafe(cfgPath, /** @type {Record<string, unknown>} */ ({}));
    let nextKey = typeof cur?.amapKey === 'string' ? cur.amapKey.trim() : '';
    if (opts.clearAmapKey === true) {
      nextKey = '';
    } else if (typeof opts.amapKey === 'string' && opts.amapKey.trim()) {
      nextKey = opts.amapKey.trim();
    }
    writeJsonAtomic(
      cfgPath,
      {
        amapKey: nextKey,
        updatedAt: Date.now(),
      },
      { mode: 0o600 },
    );
  });

  return getSystemGeoStatus({ homeDir, env: opts.env });
}

/**
 * Map AMap API error codes into clear Chinese actionable guidance.
 * @param {string} infocode
 * @param {string} info
 * @returns {string}
 */
function formatAmapError(infocode, info) {
  if (infocode === '10009' || /USERKEY_PLAT_NOMATCH/i.test(info)) {
    return 'Key 平台类型不匹配：请在高德开放平台添加 Key 时选择「Web服务」（不要选 Web端 JS API 或移动端）';
  }
  if (infocode === '10001' || /INVALID_USER_KEY/i.test(info)) {
    return '高德 API Key 无效，请检查是否复制完整';
  }
  if (infocode === '10003' || infocode === '10044' || /DAILY_QUERY_OVER_LIMIT|CUQPS_HAS_EXCEEDED_THE_LIMIT/i.test(info)) {
    return '已超出高德当日/当月免费配额上限';
  }
  if (infocode === '10019' || infocode === '10021' || /QPS_HAS_EXCEEDED/i.test(info)) {
    return '请求过于频繁（触发高德个人版 3 QPS 限制），请稍后重试';
  }
  return [info, infocode ? `code=${infocode}` : ''].filter(Boolean).join(' · ') || '高德接口返回错误';
}

/**
 * Open and initialize the shared `<homeDir>/geo-cache.sqlite` DB (`0600` permissions).
 * @param {string} homeDir
 * @returns {DatabaseSync}
 */
function openGeoCacheDb(homeDir) {
  ensurePrivateDir(homeDir);
  const dbPath = join(homeDir, 'geo-cache.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    chmodSync(dbPath, 0o600);
  } catch {
    // ignore on unsupported filesystems
  }
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS geo_regeo_cache (
      grid_key TEXT PRIMARY KEY,
      gcj_lat REAL,
      gcj_lon REAL,
      address TEXT,
      short_address TEXT,
      poi_name TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

/**
 * Probe connectivity and key validity against AMap reverse geocoding Web Service API.
 * @param {{
 *   homeDir?: string;
 *   env?: Record<string, string | undefined>;
 *   amapKey?: string;
 *   requester?: (url: string) => Promise<{ status: number; body: Buffer | string }>;
 *   amapUrl?: string;
 * }} [opts]
 * @returns {Promise<{ ok: boolean; message: string; sampleAddress?: string }>}
 */
export async function probeAmapKey(opts = {}) {
  const candidate = typeof opts.amapKey === 'string' && opts.amapKey.trim()
    ? opts.amapKey.trim()
    : resolveSystemAmapKey({ homeDir: opts.homeDir, env: opts.env }).key;

  if (!candidate) {
    return { ok: false, message: '请先输入或保存高德「Web服务」API Key' };
  }

  const baseUrl = (opts.amapUrl || AMAP_REGEO_URL).replace(/\/+$/, '');
  const reqUrl = `${baseUrl}?key=${encodeURIComponent(candidate)}&location=116.397428,39.909230&extensions=all&radius=200&output=JSON`;
  const doGet = opts.requester ?? defaultGetRequester;

  try {
    const res = await doGet(reqUrl);
    if (res.status !== 200) {
      return { ok: false, message: `高德网关返回 HTTP ${res.status}` };
    }
    const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
    const parsed = /** @type {Record<string, any>} */ (JSON.parse(text));
    if (parsed?.status !== '1') {
      const infocode = String(parsed?.infocode ?? '');
      const info = String(parsed?.info ?? '');
      return { ok: false, message: formatAmapError(infocode, info) };
    }
    const addr = typeof parsed?.regeocode?.formatted_address === 'string'
      ? parsed.regeocode.formatted_address.trim()
      : '';
    return {
      ok: true,
      message: '高德逆地理服务验证通过',
      sampleAddress: addr || '北京市测试坐标解析成功',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `请求高德接口失败：${msg}` };
  }
}

/**
 * Parse AMap `regeocode` payload into formatted full address, concise road+POI shortAddress, and POI landmark.
 * @param {Record<string, any>} parsed
 * @returns {{ address: string; shortAddress: string; poiName: string | null } | null}
 */
function parseAmapRegeoPayload(parsed) {
  if (parsed?.status !== '1') return null;
  const regeocode = parsed?.regeocode && typeof parsed.regeocode === 'object' ? parsed.regeocode : null;
  if (!regeocode) return null;
  const rawFull = typeof regeocode.formatted_address === 'string' ? regeocode.formatted_address.trim() : '';
  if (!rawFull) return null;

  const comp = regeocode.addressComponent && typeof regeocode.addressComponent === 'object' ? regeocode.addressComponent : {};
  const streetNum = comp.streetNumber && typeof comp.streetNumber === 'object' ? comp.streetNumber : {};
  const district = typeof comp.district === 'string' ? comp.district.trim() : '';
  const township = typeof comp.township === 'string' ? comp.township.trim() : '';
  const street = typeof streetNum.street === 'string' ? streetNum.street.trim() : '';
  const number = typeof streetNum.number === 'string' ? streetNum.number.trim() : '';

  const aoi0 = Array.isArray(regeocode.aois) && regeocode.aois[0] && typeof regeocode.aois[0] === 'object'
    ? String(regeocode.aois[0].name ?? '').trim()
    : '';
  const poi0 = Array.isArray(regeocode.pois) && regeocode.pois[0] && typeof regeocode.pois[0] === 'object'
    ? String(regeocode.pois[0].name ?? '').trim()
    : '';
  const poiName = aoi0 || poi0 || null;

  const roadPart = `${district}${street}${number}`.trim() || `${district}${township}`.trim();
  let shortAddress;
  if (poiName && roadPart && !roadPart.includes(poiName)) {
    shortAddress = `${roadPart} · ${poiName}`;
  } else if (poiName && !roadPart) {
    shortAddress = poiName;
  } else {
    shortAddress = roadPart || rawFull;
  }

  return {
    address: rawFull,
    shortAddress,
    poiName,
  };
}

/**
 * Shared reverse geocoding with ~22m GCJ-02 grid 24h SQLite cache and 3 QPS serialization.
 * @param {{
 *   homeDir?: string;
 *   env?: Record<string, string | undefined>;
 *   lat: number;
 *   lon: number;
 *   coordSys?: 'wgs84' | 'gcj02';
 *   fallbackKey?: string;
 *   nowMs?: number;
 *   requester?: (url: string) => Promise<{ status: number; body: Buffer | string }>;
 *   amapUrl?: string;
 * }} opts
 * @returns {Promise<{
 *   valid: boolean;
 *   inChina: boolean;
 *   gcjLat: number | null;
 *   gcjLon: number | null;
 *   address: string | null;
 *   shortAddress: string | null;
 *   poiName: string | null;
 *   source: 'amap' | 'amap-cache' | null;
 * }>}
 */
export async function reverseGeocodeWithCache(opts) {
  const lat = Number(opts?.lat);
  const lon = Number(opts?.lon);
  if (
    !Number.isFinite(lat) || !Number.isFinite(lon)
    || Math.abs(lat) > 90 || Math.abs(lon) > 180
    || (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6)
  ) {
    return { valid: false, inChina: false, gcjLat: null, gcjLon: null, address: null, shortAddress: null, poiName: null, source: null };
  }

  const nowMs = typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const gcj = opts.coordSys === 'gcj02'
    ? { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)), inChina: !outOfChina(lon, lat) }
    : wgs84ToGcj02(lat, lon);

  if (!gcj.inChina) {
    return {
      valid: true,
      inChina: false,
      gcjLat: gcj.lat,
      gcjLon: gcj.lon,
      address: null,
      shortAddress: null,
      poiName: null,
      source: null,
    };
  }

  const homeDir = resolveHomeDir(opts);
  const gridKey = `${(Math.round(gcj.lat * 5000) / 5000).toFixed(4)},${(Math.round(gcj.lon * 5000) / 5000).toFixed(4)}`;

  const readCache = () => {
    let db;
    try {
      db = openGeoCacheDb(homeDir);
      const row = /** @type {Record<string, any> | undefined} */ (
        db.prepare('SELECT * FROM geo_regeo_cache WHERE grid_key=? AND updated_at > ?')
          .get(gridKey, nowMs - GEO_CACHE_TTL_MS)
      );
      if (row && typeof row.address === 'string' && row.address.trim()) {
        return {
          valid: true,
          inChina: true,
          gcjLat: gcj.lat,
          gcjLon: gcj.lon,
          address: String(row.address),
          shortAddress: String(row.short_address || row.address),
          poiName: typeof row.poi_name === 'string' && row.poi_name.trim() ? String(row.poi_name) : null,
          source: /** @type {'amap-cache'} */ ('amap-cache'),
        };
      }
      return null;
    } catch {
      return null;
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  };

  const cachedFirst = readCache();
  if (cachedFirst) return cachedFirst;

  const { key: amapKey } = resolveSystemAmapKey({
    homeDir,
    env: opts.env,
    fallbackKey: opts.fallbackKey,
  });
  if (!amapKey) {
    return {
      valid: true,
      inChina: true,
      gcjLat: gcj.lat,
      gcjLon: gcj.lon,
      address: null,
      shortAddress: null,
      poiName: null,
      source: null,
    };
  }

  const useThrottle = !opts.requester && !opts.amapUrl;
  const doGet = opts.requester ?? defaultGetRequester;
  const baseUrl = (opts.amapUrl || AMAP_REGEO_URL).replace(/\/+$/, '');

  const runSerialized = async () => {
    const cachedInside = readCache();
    if (cachedInside) return cachedInside;

    if (useThrottle) {
      const waitMs = Math.max(0, lastAmapRequestAtMs + MIN_AMAP_INTERVAL_MS - Date.now());
      if (waitMs > 0) {
        await delay(waitMs);
      }
      lastAmapRequestAtMs = Date.now();
    }

    try {
      const locParam = `${gcj.lon.toFixed(6)},${gcj.lat.toFixed(6)}`;
      const reqUrl = `${baseUrl}?key=${encodeURIComponent(amapKey)}&location=${encodeURIComponent(locParam)}&extensions=all&radius=200&output=JSON`;
      const res = await doGet(reqUrl);
      if (res.status !== 200) {
        return { valid: true, inChina: true, gcjLat: gcj.lat, gcjLon: gcj.lon, address: null, shortAddress: null, poiName: null, source: null };
      }
      const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body);
      const parsed = /** @type {Record<string, any>} */ (JSON.parse(text));
      const geo = parseAmapRegeoPayload(parsed);
      if (!geo) {
        return { valid: true, inChina: true, gcjLat: gcj.lat, gcjLon: gcj.lon, address: null, shortAddress: null, poiName: null, source: null };
      }

      let db;
      try {
        db = openGeoCacheDb(homeDir);
        db.prepare(`
          INSERT INTO geo_regeo_cache (grid_key, gcj_lat, gcj_lon, address, short_address, poi_name, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(grid_key) DO UPDATE SET
            gcj_lat=excluded.gcj_lat,
            gcj_lon=excluded.gcj_lon,
            address=excluded.address,
            short_address=excluded.short_address,
            poi_name=excluded.poi_name,
            updated_at=excluded.updated_at
        `).run(gridKey, gcj.lat, gcj.lon, geo.address, geo.shortAddress, geo.poiName, nowMs);
      } catch {
        // Ignore cache write errors
      } finally {
        try {
          db?.close();
        } catch {
          // ignore
        }
      }

      return {
        valid: true,
        inChina: true,
        gcjLat: gcj.lat,
        gcjLon: gcj.lon,
        address: geo.address,
        shortAddress: geo.shortAddress,
        poiName: geo.poiName,
        source: /** @type {'amap'} */ ('amap'),
      };
    } catch {
      return { valid: true, inChina: true, gcjLat: gcj.lat, gcjLon: gcj.lon, address: null, shortAddress: null, poiName: null, source: null };
    }
  };

  const task = rateLimitChain.then(runSerialized, runSerialized);
  rateLimitChain = task.then(() => undefined, () => undefined);
  return task;
}

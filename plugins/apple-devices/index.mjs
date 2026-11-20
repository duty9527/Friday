#!/usr/bin/env node
import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
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
  AppleClientError,
  fetchFindMyDevices,
  playFindMySound,
  requestSmsCode,
  resolveRegionEndpoints,
  startAppleLogin,
  verify2faCode,
} from './icloud-client.mjs';
import { handleAppleVoiceFastpath } from './fastpath.mjs';

export const ACTIONS = [
  'status',
  'devices',
  'locate',
  'play-sound',
  'patrol',
  'auth-login',
  'auth-verify',
  'auth-sms',
  'logout',
  'config',
];

const DEFAULT_CONFIG = {
  region: /** @type {'cn' | 'global'} */ ('cn'),
  cacheTtlSec: 300,
  minRefreshIntervalSec: 30,
  minBatteryPct: 25,
  watchDevices: /** @type {string[]} */ ([]),
  customAliases: /** @type {Record<string, string>} */ ({}),
  places: /** @type {Record<string, { lat: number; lng: number; radiusMeters: number }>} */ ({}),
};

const CATEGORY_PATTERNS = [
  { re: /^(?:iphone|苹果手机|手机)$/i, category: 'iphone' },
  { re: /^(?:ipad|苹果平板|平板)$/i, category: 'ipad' },
  { re: /^(?:macbook|mac|imac|苹果电脑|电脑|笔记本)$/i, category: 'mac' },
  { re: /^(?:apple\s*watch|watch|iwatch|手表|苹果手表)$/i, category: 'watch' },
  { re: /^(?:airpods|苹果耳机|耳机)$/i, category: 'airpods' },
];

const BATTERY_STATUS_LABELS = {
  Charging: '充电中',
  NotCharging: '未充电',
  Charged: '已充满',
  Unknown: '未知',
};

/**
 * @param {string | undefined} appleId
 * @returns {string}
 */
export function maskAppleId(appleId) {
  const raw = String(appleId ?? '').trim();
  if (!raw) return '';
  const atIdx = raw.indexOf('@');
  if (atIdx > 0) {
    const local = raw.slice(0, atIdx);
    const domain = raw.slice(atIdx);
    if (local.length <= 1) return `***${domain}`;
    if (local.length === 2) return `${local[0]}***${domain}`;
    return `${local[0]}***${local[local.length - 1]}${domain}`;
  }
  if (raw.length <= 4) return '***';
  return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
}

/**
 * Great-circle distance in meters using Haversine formula.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number}
 */
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = (Math.sin(dLat / 2) ** 2)
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * (Math.sin(dLng / 2) ** 2);
  return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/**
 * @param {unknown} raw
 * @returns {'cn' | 'global'}
 */
function normalizeRegion(raw) {
  return resolveRegionEndpoints(String(raw ?? 'cn')).region;
}

/**
 * @param {unknown} rawPlaces
 * @returns {Record<string, { lat: number; lng: number; radiusMeters: number }>}
 */
function normalizePlaces(rawPlaces) {
  /** @type {Record<string, { lat: number; lng: number; radiusMeters: number }>} */
  const out = {};
  if (!rawPlaces || typeof rawPlaces !== 'object' || Array.isArray(rawPlaces)) return out;
  for (const [rawName, val] of Object.entries(rawPlaces)) {
    const name = String(rawName ?? '').trim();
    if (!name || !val || typeof val !== 'object' || Array.isArray(val)) continue;
    const obj = /** @type {Record<string, unknown>} */ (val);
    const lat = Number(obj.lat ?? obj.latitude);
    const lng = Number(obj.lng ?? obj.lon ?? obj.longitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      continue;
    }
    const radiusMeters = clampInt(obj.radiusMeters ?? obj.radius ?? 250, 20, 50_000) ?? 250;
    out[name] = {
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      radiusMeters,
    };
  }
  return out;
}

/**
 * @param {unknown} rawAliases
 * @returns {Record<string, string>}
 */
function normalizeAliases(rawAliases) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!rawAliases || typeof rawAliases !== 'object' || Array.isArray(rawAliases)) return out;
  for (const [k, v] of Object.entries(rawAliases)) {
    const key = String(k ?? '').trim();
    const val = String(v ?? '').trim();
    if (key && val) out[key] = val;
  }
  return out;
}

/**
 * @param {unknown} rawList
 * @returns {string[]}
 */
function normalizeWatchDevices(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    const s = String(item ?? '').trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * @param {string} configPath
 * @returns {{
 *   region: 'cn' | 'global';
 *   cacheTtlSec: number;
 *   minRefreshIntervalSec: number;
 *   minBatteryPct: number;
 *   watchDevices: string[];
 *   customAliases: Record<string, string>;
 *   places: Record<string, { lat: number; lng: number; radiusMeters: number }>;
 * }}
 */
function loadPluginConfig(configPath) {
  const raw = readConfig(configPath, DEFAULT_CONFIG);
  return {
    region: normalizeRegion(raw.region),
    cacheTtlSec: clampInt(raw.cacheTtlSec, 0, 86_400) ?? DEFAULT_CONFIG.cacheTtlSec,
    minRefreshIntervalSec: clampInt(raw.minRefreshIntervalSec, 5, 3600) ?? DEFAULT_CONFIG.minRefreshIntervalSec,
    minBatteryPct: clampInt(raw.minBatteryPct, 5, 90) ?? DEFAULT_CONFIG.minBatteryPct,
    watchDevices: normalizeWatchDevices(raw.watchDevices),
    customAliases: normalizeAliases(raw.customAliases),
    places: normalizePlaces(raw.places),
  };
}

/**
 * Strip raw Apple FMiP device IDs and optionally redact exact lat/lng coordinates.
 * @param {any} dev
 * @param {Record<string, { lat: number; lng: number; radiusMeters: number }>} places
 * @param {{ redactCoords?: boolean }} [options]
 */
function sanitizeDeviceForOutput(dev, places, options = {}) {
  let place = null;
  if (dev?.location && typeof dev.location.latitude === 'number' && typeof dev.location.longitude === 'number') {
    let best = /** @type {{ name: string; distanceMeters: number; radiusMeters: number; inside: boolean } | null} */ (null);
    for (const [placeName, cfg] of Object.entries(places)) {
      const distanceMeters = haversineMeters(dev.location.latitude, dev.location.longitude, cfg.lat, cfg.lng);
      const candidate = {
        name: placeName,
        distanceMeters,
        radiusMeters: cfg.radiusMeters,
        inside: distanceMeters <= cfg.radiusMeters,
      };
      if (!best || (candidate.inside && !best.inside) || (candidate.inside === best.inside && candidate.distanceMeters < best.distanceMeters)) {
        best = candidate;
      }
    }
    place = best;
  }

  let location = null;
  if (dev?.location) {
    location = options.redactCoords
      ? {
          horizontalAccuracy: dev.location.horizontalAccuracy ?? null,
          positionType: dev.location.positionType ?? null,
          timestamp: dev.location.timestamp ?? null,
          isOld: Boolean(dev.location.isOld),
        }
      : {
          latitude: dev.location.latitude,
          longitude: dev.location.longitude,
          horizontalAccuracy: dev.location.horizontalAccuracy ?? null,
          positionType: dev.location.positionType ?? null,
          timestamp: dev.location.timestamp ?? null,
          isOld: Boolean(dev.location.isOld),
        };
  }

  return {
    id: String(dev.id),
    name: String(dev.name),
    displayName: String(dev.displayName),
    model: String(dev.model),
    category: String(dev.category),
    online: Boolean(dev.online),
    deviceStatus: String(dev.deviceStatus),
    batteryPercent: typeof dev.batteryPercent === 'number' ? dev.batteryPercent : null,
    batteryStatus: String(dev.batteryStatus ?? 'Unknown'),
    batteryStatusLabel: BATTERY_STATUS_LABELS[/** @type {keyof typeof BATTERY_STATUS_LABELS} */ (dev.batteryStatus)] ?? '未知',
    lowPowerMode: Boolean(dev.lowPowerMode),
    lostModeCapable: Boolean(dev.lostModeCapable),
    isLocating: Boolean(dev.isLocating),
    location,
    place,
  };
}

/**
 * Load session safely from `<pluginDataDir>/session.json`.
 * @param {string} sessionPath
 * @returns {Record<string, any> | null}
 */
function loadSession(sessionPath) {
  const data = readJsonSafe(sessionPath, null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return /** @type {Record<string, any>} */ (data);
}

/**
 * Load device cache safely from `<pluginDataDir>/devices-cache.json`.
 * @param {string} cachePath
 * @returns {{ fetchedAt: number; serverTimestamp: number | null; entries: Array<{ rawId: string; device: Record<string, any> }> } | null}
 */
function loadDeviceCache(cachePath) {
  const data = readJsonSafe(cachePath, null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!Array.isArray(data.entries)) return null;
  return {
    fetchedAt: Number(data.fetchedAt ?? 0),
    serverTimestamp: typeof data.serverTimestamp === 'number' ? data.serverTimestamp : null,
    entries: data.entries,
  };
}

/**
 * @param {Record<string, any> | null} session
 * @param {{ region: 'cn' | 'global' }} config
 * @returns {{
 *   authState: 'unauthenticated' | 'pending_2fa' | 'authenticated' | 'expired';
 *   region: 'cn' | 'global';
 *   appleId: string;
 *   authenticatedAt: number | null;
 *   trustedPhones: Array<{ id: number; numberWithDialCode: string; pushMode: string }>;
 * }}
 */
function buildPublicAuthSummary(session, config) {
  const stateRaw = session?.state;
  const authState = stateRaw === 'authenticated' || stateRaw === 'pending_2fa' || stateRaw === 'expired'
    ? stateRaw
    : 'unauthenticated';
  return {
    authState,
    region: normalizeRegion(session?.region ?? config.region),
    appleId: maskAppleId(session?.appleId),
    authenticatedAt: typeof session?.authenticatedAt === 'number' ? session.authenticatedAt : null,
    trustedPhones: authState === 'pending_2fa' && Array.isArray(session?.trustedPhones)
      ? session.trustedPhones.map(p => ({
          id: Number(p.id),
          numberWithDialCode: String(p.numberWithDialCode ?? ''),
          pushMode: String(p.pushMode ?? 'sms'),
        }))
      : [],
  };
}

/**
 * @param {Array<Record<string, any>>} devices
 * @returns {string}
 */
function formatDevicesSummaryText(devices) {
  if (!devices.length) return '已登录，但名下未发现支持查找的 Apple 设备。';
  return devices
    .map(d => {
      const bat = typeof d.batteryPercent === 'number' ? `${d.batteryPercent}% (${d.batteryStatusLabel})` : '电量未知';
      const online = d.online ? '在线' : '离线';
      const placeStr = d.place ? (d.place.inside ? ` · 在${d.place.name}` : ` · 距${d.place.name}${d.place.distanceMeters}m`) : '';
      return `• ${d.name} [${d.model}]：${bat} · ${online}${placeStr}`;
    })
    .join('\n');
}

/**
 * Resolve a target device entry by ID, alias, exact/partial name, or category noun.
 * @param {Array<{ rawId: string; device: Record<string, any> }>} entries
 * @param {string} rawQuery
 * @param {Record<string, string>} customAliases
 * @returns {{ entry?: { rawId: string; device: Record<string, any> }; ambiguous?: Array<Record<string, any>> }}
 */
function resolveTargetEntry(entries, rawQuery, customAliases) {
  const trimmed = String(rawQuery ?? '').trim();
  if (!trimmed) {
    if (entries.length === 0) return {};
    const primaryIphone = entries.find(e => e.device.category === 'iphone');
    return { entry: primaryIphone ?? entries[0] };
  }

  const lowerTrimmed = trimmed.toLowerCase();
  let resolvedQuery = trimmed;
  for (const [aliasKey, aliasVal] of Object.entries(customAliases)) {
    if (aliasKey.toLowerCase() === lowerTrimmed) {
      resolvedQuery = aliasVal;
      break;
    }
  }
  const qLower = resolvedQuery.toLowerCase();

  // 1. Exact ID or exact name match
  const exact = entries.filter(e =>
    String(e.device.id).toLowerCase() === qLower
    || String(e.device.name).toLowerCase() === qLower
    || String(e.device.displayName).toLowerCase() === qLower,
  );
  if (exact.length === 1) return { entry: exact[0] };
  if (exact.length > 1) return { ambiguous: exact.map(e => e.device) };

  // 2. Category match (`手机`, `iPad`, `手表`, `Mac`, `AirPods`)
  for (const { re, category } of CATEGORY_PATTERNS) {
    if (re.test(resolvedQuery)) {
      const byCat = entries.filter(e => e.device.category === category);
      if (byCat.length === 1) return { entry: byCat[0] };
      if (byCat.length > 1) return { ambiguous: byCat.map(e => e.device) };
    }
  }

  // 3. Substring match on name/displayName/model
  const partial = entries.filter(e =>
    String(e.device.name).toLowerCase().includes(qLower)
    || String(e.device.displayName).toLowerCase().includes(qLower)
    || String(e.device.model).toLowerCase().includes(qLower),
  );
  if (partial.length === 1) return { entry: partial[0] };
  if (partial.length > 1) return { ambiguous: partial.map(e => e.device) };

  return {};
}

/**
 * Persist updated session back to disk inside lock, ensuring 0600 permissions.
 * @param {string} sessionPath
 * @param {Record<string, any>} session
 */
function saveSession(sessionPath, session) {
  writeJsonAtomic(sessionPath, session, { mode: 0o600 });
}

/**
 * Fetch devices from cache or live Apple FMiP API honoring anti-drain cache & cooldown.
 * @param {{
 *   paths: import('../_shared/types.d.ts').PluginPaths;
 *   config: ReturnType<typeof loadPluginConfig>;
 *   refresh: boolean;
 *   fetchFn: typeof fetch;
 *   nowFn: () => number;
 *   signal?: AbortSignal;
 * }} opts
 */
async function getDevicesWithCache(opts) {
  const { paths, config, refresh, fetchFn, nowFn, signal } = opts;
  const session = loadSession(paths.sessionPath);
  if (!session || session.state !== 'authenticated') {
    const auth = buildPublicAuthSummary(session, config);
    const msg = auth.authState === 'pending_2fa'
      ? 'Apple ID 正在等待 6 位双重认证码，请先完成 2FA 验证。'
      : auth.authState === 'expired'
        ? 'Apple ID 会话已过期，请通过 Web 控制台或 CLI 重新登录验证。'
        : '尚未绑定 Apple ID，请通过 Web 控制台「应用与插件 -> 🍎 苹果设备」或 CLI 完成登录。';
    return { ok: false, errorCode: auth.authState === 'expired' ? 'AUTH_EXPIRED' : 'NOT_AUTHENTICATED', message: msg, auth, entries: [], fetchedAt: null, fromCache: true, cooldownActive: false };
  }

  const cache = loadDeviceCache(paths.cachePath);
  const now = nowFn();
  const cacheAgeMs = cache && cache.fetchedAt > 0 ? Math.max(0, now - cache.fetchedAt) : Infinity;

  if (!refresh && cache && cache.entries.length > 0 && cacheAgeMs <= config.cacheTtlSec * 1000) {
    return {
      ok: true,
      auth: buildPublicAuthSummary(session, config),
      entries: cache.entries,
      fetchedAt: cache.fetchedAt,
      fromCache: true,
      cooldownActive: false,
      cooldownRemainingSec: 0,
    };
  }

  if (refresh && cache && cache.entries.length > 0 && cacheAgeMs < config.minRefreshIntervalSec * 1000) {
    const remainingSec = Math.ceil((config.minRefreshIntervalSec * 1000 - cacheAgeMs) / 1000);
    return {
      ok: true,
      auth: buildPublicAuthSummary(session, config),
      entries: cache.entries,
      fetchedAt: cache.fetchedAt,
      fromCache: true,
      cooldownActive: true,
      cooldownRemainingSec: remainingSec,
    };
  }

  try {
    const live = await fetchFindMyDevices({ session, fetchFn, signal });
    const stampedAt = nowFn();
    const cacheObj = {
      fetchedAt: stampedAt,
      serverTimestamp: live.serverTimestamp,
      entries: live.entries,
    };
    await withFileLock(paths.sessionPath, () => saveSession(paths.sessionPath, session));
    await withFileLock(paths.cachePath, () => writeJsonAtomic(paths.cachePath, cacheObj, { mode: 0o600 }));
    return {
      ok: true,
      auth: buildPublicAuthSummary(session, config),
      entries: live.entries,
      fetchedAt: stampedAt,
      fromCache: false,
      cooldownActive: false,
      cooldownRemainingSec: 0,
    };
  } catch (err) {
    if (err instanceof AppleClientError && err.code === 'AUTH_EXPIRED') {
      await withFileLock(paths.sessionPath, () => saveSession(paths.sessionPath, session));
    } else {
      await withFileLock(paths.sessionPath, () => saveSession(paths.sessionPath, session));
    }
    return {
      ok: false,
      errorCode: err instanceof AppleClientError ? err.code : 'FMIP_ERROR',
      message: errMsg(err),
      auth: buildPublicAuthSummary(session, config),
      entries: cache?.entries ?? [],
      fetchedAt: cache?.fetchedAt ?? null,
      fromCache: true,
      cooldownActive: false,
    };
  }
}

/**
 * Main plugin entry point for `apple-devices`.
 * @param {string} [action]
 * @param {Record<string, unknown>} [args]
 * @param {import('../_shared/types.d.ts').PluginExecutionContext & { fetchFn?: typeof fetch }} [deps]
 * @returns {Promise<import('../_shared/types.d.ts').PluginActionResult>}
 */
export async function runAction(action = 'status', args = {}, deps = {}) {
  const paths = resolvePluginPaths('apple-devices', deps, {
    sessionPath: 'session.json',
    cachePath: 'devices-cache.json',
  });
  ensurePrivateDir(paths.pluginDataDir);

  const fetchFn = typeof deps?.fetchFn === 'function' ? deps.fetchFn : fetch;
  const nowFn = typeof deps?.nowFn === 'function' ? deps.nowFn : Date.now;
  const signal = deps?.signal;
  const cleanAction = String(action || 'status').trim().toLowerCase();

  if (cleanAction === 'config') {
    const updated = await withFileLock(paths.configPath, () => {
      const current = loadPluginConfig(paths.configPath);
      const hasMutation =
        args.region !== undefined
        || args.cacheTtlSec !== undefined
        || args.minRefreshIntervalSec !== undefined
        || args.minBatteryPct !== undefined
        || args.watchDevices !== undefined
        || args.customAliases !== undefined
        || args.places !== undefined;
      if (!hasMutation) return current;

      const next = {
        region: args.region !== undefined ? normalizeRegion(args.region) : current.region,
        cacheTtlSec: args.cacheTtlSec !== undefined ? (clampInt(args.cacheTtlSec, 0, 86_400) ?? current.cacheTtlSec) : current.cacheTtlSec,
        minRefreshIntervalSec: args.minRefreshIntervalSec !== undefined
          ? (clampInt(args.minRefreshIntervalSec, 5, 3600) ?? current.minRefreshIntervalSec)
          : current.minRefreshIntervalSec,
        minBatteryPct: args.minBatteryPct !== undefined
          ? (clampInt(args.minBatteryPct, 5, 90) ?? current.minBatteryPct)
          : current.minBatteryPct,
        watchDevices: args.watchDevices !== undefined ? normalizeWatchDevices(args.watchDevices) : current.watchDevices,
        customAliases: args.customAliases !== undefined ? normalizeAliases(args.customAliases) : current.customAliases,
        places: args.places !== undefined ? normalizePlaces(args.places) : current.places,
      };
      writeConfig(paths.configPath, next);
      return next;
    });
    return {
      ok: true,
      notify: true,
      title: '🍎 Apple 设备插件配置',
      message: `区域：${updated.region === 'cn' ? '中国大陆 (icloud.com.cn)' : '国际区 (icloud.com)'} · 缓存 ${updated.cacheTtlSec}s · 最小刷新冷却 ${updated.minRefreshIntervalSec}s · 低电量阈值 ${updated.minBatteryPct}% · 地点围栏 ${Object.keys(updated.places).length} 个`,
      data: { config: updated },
    };
  }

  const config = loadPluginConfig(paths.configPath);

  if (cleanAction === 'logout') {
    await withFileLock(paths.sessionPath, () => {
      if (existsSync(paths.sessionPath)) unlinkSync(paths.sessionPath);
    });
    await withFileLock(paths.cachePath, () => {
      if (existsSync(paths.cachePath)) unlinkSync(paths.cachePath);
    });
    return {
      ok: true,
      notify: true,
      title: '已退出 Apple ID',
      message: '已清除本机保存的 Apple 会话 Cookie、信任票据与设备缓存。',
      data: { authState: 'unauthenticated' },
    };
  }

  if (cleanAction === 'auth-login') {
    const appleId = String(args.appleId ?? args.username ?? '').trim();
    const password = String(args.password ?? '');
    const region = args.region !== undefined ? normalizeRegion(args.region) : config.region;
    if (!appleId || !password) {
      return {
        ok: false,
        notify: true,
        title: '登录参数缺失',
        message: '请提供 Apple ID 与主密码（建议通过 Web 控制台「🍎 苹果设备」面板输入，避免密码留在聊天记录中）。',
      };
    }

    const existingSession = loadSession(paths.sessionPath);
    const existingTrustToken = existingSession?.appleId === appleId && typeof existingSession?.trustToken === 'string'
      ? existingSession.trustToken
      : undefined;

    try {
      const session = await startAppleLogin({
        appleId,
        password,
        region,
        existingTrustToken,
        clientId: existingSession?.clientId,
        fetchFn,
        signal,
      });
      await withFileLock(paths.sessionPath, () => saveSession(paths.sessionPath, session));
      if (args.region !== undefined && region !== config.region) {
        await withFileLock(paths.configPath, () => writeConfig(paths.configPath, { ...config, region }));
      }
      const auth = buildPublicAuthSummary(session, { ...config, region });
      if (session.state === 'pending_2fa') {
        const phoneHint = auth.trustedPhones.length > 0
          ? `（支持短信备选：${auth.trustedPhones.map(p => `${p.id}:${p.numberWithDialCode}`).join('，')}）`
          : '';
        return {
          ok: true,
          notify: true,
          title: '🔐 需要苹果双重认证 (2FA)',
          message: `已向 ${auth.appleId} 的受信任设备发送 6 位验证码${phoneHint}。请使用 auth-verify 提交验证码，或调用 auth-sms 改发短信验证码。`,
          data: { ...auth, requires2fa: true },
        };
      }

      // Immediately populate initial device cache best-effort
      let devices = /** @type {Array<Record<string, any>>} */ ([]);
      let fetchedAt = /** @type {number | null} */ (null);
      try {
        const live = await fetchFindMyDevices({ session, fetchFn, signal });
        fetchedAt = nowFn();
        await withFileLock(paths.sessionPath, () => saveSession(paths.sessionPath, session));
        await withFileLock(paths.cachePath, () => writeJsonAtomic(paths.cachePath, {
          fetchedAt,
          serverTimestamp: live.serverTimestamp,
          entries: live.entries,
        }, { mode: 0o600 }));
        devices = live.entries.map(e => sanitizeDeviceForOutput(e.device, config.places));
      } catch {
        // Login still succeeded even if initial FMiP pull hits a transient error
      }
      return {
        ok: true,
        notify: true,
        title: '✅ Apple ID 登录成功',
        message: `已通过信任票据免码登录 ${auth.appleId}（${region === 'cn' ? '国区' : '国际区'}），共发现 ${devices.length} 台设备。`,
        data: { ...auth, requires2fa: false, fetchedAt, devices },
      };
    } catch (err) {
      return {
        ok: false,
        notify: true,
        title: 'Apple ID 登录失败',
        message: errMsg(err),
        data: { errorCode: err instanceof AppleClientError ? err.code : 'LOGIN_FAILED' },
      };
    }
  }

  if (cleanAction === 'auth-sms') {
    const session = loadSession(paths.sessionPath);
    if (!session || session.state !== 'pending_2fa') {
      return {
        ok: false,
        notify: true,
        title: '无法发送短信验证码',
        message: '当前不在等待 2FA 验证状态，请先发起 Apple ID 登录。',
      };
    }
    try {
      const phoneId = clampInt(args.phoneId, 1, 999);
      await requestSmsCode({ session, phoneId, fetchFn, signal });
      await withFileLock(paths.sessionPath, () => saveSession(paths.sessionPath, session));
      const auth = buildPublicAuthSummary(session, config);
      return {
        ok: true,
        notify: true,
        title: '📱 已发送短信验证码',
        message: '已请求苹果向受信任手机号发送 6 位短信验证码，收到后请使用 auth-verify (mode="sms") 提交验证。',
        data: auth,
      };
    } catch (err) {
      return {
        ok: false,
        notify: true,
        title: '发送短信验证码失败',
        message: errMsg(err),
      };
    }
  }

  if (cleanAction === 'auth-verify') {
    const session = loadSession(paths.sessionPath);
    if (!session || session.state !== 'pending_2fa') {
      return {
        ok: false,
        notify: true,
        title: '无法完成 2FA 验证',
        message: '当前没有待验证的 2FA 会话，请先使用账号密码发起登录。',
      };
    }
    try {
      const code = String(args.code ?? args.securityCode ?? '').trim();
      const mode = String(args.mode ?? 'trusted_device').trim().toLowerCase() === 'sms' ? 'sms' : 'trusted_device';
      const phoneId = clampInt(args.phoneId, 1, 999);
      await verify2faCode({ session, code, mode, phoneId, fetchFn, signal });
      await withFileLock(paths.sessionPath, () => saveSession(paths.sessionPath, session));
      const auth = buildPublicAuthSummary(session, config);

      let devices = /** @type {Array<Record<string, any>>} */ ([]);
      let fetchedAt = /** @type {number | null} */ (null);
      try {
        const live = await fetchFindMyDevices({ session, fetchFn, signal });
        fetchedAt = nowFn();
        await withFileLock(paths.sessionPath, () => saveSession(paths.sessionPath, session));
        await withFileLock(paths.cachePath, () => writeJsonAtomic(paths.cachePath, {
          fetchedAt,
          serverTimestamp: live.serverTimestamp,
          entries: live.entries,
        }, { mode: 0o600 }));
        devices = live.entries.map(e => sanitizeDeviceForOutput(e.device, config.places));
      } catch {
        // Ignore transient initial device pull errors
      }
      return {
        ok: true,
        notify: true,
        title: '✅ Apple 双重认证成功',
        message: `已完成 ${auth.appleId} 长期受信任会话绑定，共发现 ${devices.length} 台设备。`,
        data: { ...auth, fetchedAt, devices },
      };
    } catch (err) {
      return {
        ok: false,
        notify: true,
        title: '双重认证校验失败',
        message: errMsg(err),
        data: { errorCode: err instanceof AppleClientError ? err.code : 'VERIFY_FAILED' },
      };
    }
  }

  if (cleanAction === 'status') {
    if (args.refresh === true) {
      const refreshed = await getDevicesWithCache({
        paths,
        config,
        refresh: true,
        fetchFn,
        nowFn,
        signal,
      });
      const devices = refreshed.entries.map(e => sanitizeDeviceForOutput(e.device, config.places));
      const cacheAgeSec = refreshed.fetchedAt ? Math.max(0, Math.round((nowFn() - refreshed.fetchedAt) / 1000)) : null;
      return {
        ok: refreshed.ok,
        notify: true,
        title: refreshed.ok ? '🍎 Apple 设备状态' : '🍎 Apple 设备未就绪',
        message: refreshed.ok
          ? formatDevicesSummaryText(devices)
          : (refreshed.message || '尚未绑定 Apple ID'),
        data: {
          ...refreshed.auth,
          fetchedAt: refreshed.fetchedAt,
          cacheAgeSec,
          fromCache: refreshed.fromCache,
          cooldownActive: refreshed.cooldownActive,
          devices,
          config,
        },
      };
    }
    const session = loadSession(paths.sessionPath);
    const cache = loadDeviceCache(paths.cachePath);
    const auth = buildPublicAuthSummary(session, config);
    const devices = (cache?.entries ?? []).map(e => sanitizeDeviceForOutput(e.device, config.places));
    const fetchedAt = cache?.fetchedAt && cache.fetchedAt > 0 ? cache.fetchedAt : null;
    const cacheAgeSec = fetchedAt ? Math.max(0, Math.round((nowFn() - fetchedAt) / 1000)) : null;

    let msg;
    if (auth.authState === 'authenticated') {
      msg = devices.length > 0
        ? `已绑定 ${auth.appleId}（${auth.region === 'cn' ? '国区' : '国际区'}），缓存 ${devices.length} 台设备：\n${formatDevicesSummaryText(devices)}`
        : `已绑定 ${auth.appleId}（${auth.region === 'cn' ? '国区' : '国际区'}），暂无设备缓存，请执行 devices 拉取。`;
    } else if (auth.authState === 'pending_2fa') {
      msg = `账号 ${auth.appleId} 等待 6 位双重认证码。`;
    } else if (auth.authState === 'expired') {
      msg = `账号 ${auth.appleId} 会话已过期，需要重新登录与 2FA 授权。`;
    } else {
      msg = '尚未绑定 Apple ID。请通过 Web 控制台「应用与插件 -> 🍎 苹果设备」或 CLI 完成登录。';
    }
    return {
      ok: true,
      notify: true,
      title: '🍎 Apple 设备状态',
      message: msg,
      data: {
        ...auth,
        fetchedAt,
        cacheAgeSec,
        fromCache: true,
        devices,
        config,
      },
    };
  }

  if (cleanAction === 'devices') {
    const res = await getDevicesWithCache({
      paths,
      config,
      refresh: args.refresh === true,
      fetchFn,
      nowFn,
      signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        notify: true,
        title: '获取 Apple 设备失败',
        message: res.message || '获取 Apple 设备失败',
        data: { ...res.auth, errorCode: res.errorCode },
      };
    }
    const devices = res.entries.map(e => sanitizeDeviceForOutput(e.device, config.places));
    const cacheAgeSec = res.fetchedAt ? Math.max(0, Math.round((nowFn() - res.fetchedAt) / 1000)) : null;
    const sourceNote = res.cooldownActive
      ? `命中 ${config.minRefreshIntervalSec}s 防耗电冷却（${res.cooldownRemainingSec}s 后可再次实时唤醒），返回最近缓存：`
      : res.fromCache
        ? `命中缓存（${cacheAgeSec ?? 0}s 前）：`
        : '实时状态：';
    return {
      ok: true,
      notify: true,
      title: '🍎 Apple 设备列表',
      message: `${sourceNote}\n${formatDevicesSummaryText(devices)}`,
      data: {
        ...res.auth,
        fetchedAt: res.fetchedAt,
        cacheAgeSec,
        fromCache: res.fromCache,
        cooldownActive: res.cooldownActive,
        cooldownRemainingSec: res.cooldownRemainingSec,
        devices,
      },
    };
  }

  if (cleanAction === 'locate') {
    const res = await getDevicesWithCache({
      paths,
      config,
      refresh: args.refresh === true,
      fetchFn,
      nowFn,
      signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        notify: true,
        title: '定位 Apple 设备失败',
        message: res.message || '定位失败',
        data: { ...res.auth, errorCode: res.errorCode },
      };
    }
    const query = String(args.device ?? args.id ?? args.name ?? args.query ?? '').trim();
    const match = resolveTargetEntry(res.entries, query, config.customAliases);
    if (match.ambiguous) {
      const candidates = match.ambiguous.map(d => sanitizeDeviceForOutput(d, config.places, { redactCoords: args.redactCoords === true }));
      return {
        ok: false,
        notify: true,
        title: '匹配到多台设备',
        message: `“${query}”匹配到多台 Apple 设备，请指定具体设备名称：${candidates.map(c => `${c.name} (${c.id})`).join('、')}`,
        data: { candidates },
      };
    }
    if (!match.entry) {
      return {
        ok: false,
        notify: true,
        title: '未找到目标设备',
        message: query ? `未在名下找到与“${query}”匹配的 Apple 设备。` : '名下未发现任何 Apple 设备。',
      };
    }
    const dev = sanitizeDeviceForOutput(match.entry.device, config.places, { redactCoords: args.redactCoords === true });
    const batText = typeof dev.batteryPercent === 'number' ? `${dev.batteryPercent}% (${dev.batteryStatusLabel})` : '电量未知';
    const placeText = dev.place
      ? (dev.place.inside ? `在「${dev.place.name}」附近（约 ${dev.place.distanceMeters}m）` : `距「${dev.place.name}」约 ${dev.place.distanceMeters}m`)
      : (dev.location ? `坐标 (${dev.location.latitude ?? '**'}, ${dev.location.longitude ?? '**'})，精度 ${dev.location.horizontalAccuracy ?? '未知'}m` : '暂无定位数据');
    return {
      ok: true,
      notify: true,
      title: `📍 ${dev.name}`,
      message: `${dev.name} [${dev.model}]：电量 ${batText} · ${dev.online ? '在线' : '离线'} · ${placeText}`,
      data: {
        device: dev,
        fetchedAt: res.fetchedAt,
        fromCache: res.fromCache,
      },
    };
  }

  if (cleanAction === 'play-sound') {
    const query = String(args.device ?? args.id ?? args.name ?? args.query ?? '').trim();
    if (!query) {
      return {
        ok: false,
        notify: true,
        title: '缺少目标设备',
        message: '请指定要播放查找提示音的设备（如 device="手机" 或 dev_...）。',
      };
    }
    const res = await getDevicesWithCache({
      paths,
      config,
      refresh: false,
      fetchFn,
      nowFn,
      signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        notify: true,
        title: '无法触发设备响铃',
        message: res.message || '尚未绑定 Apple ID',
        data: { ...res.auth, errorCode: res.errorCode },
      };
    }
    const match = resolveTargetEntry(res.entries, query, config.customAliases);
    if (match.ambiguous) {
      const candidates = match.ambiguous.map(d => sanitizeDeviceForOutput(d, config.places));
      return {
        ok: false,
        notify: true,
        title: '匹配到多台设备',
        message: `为防误响，请明确指定要响铃的设备名称：${candidates.map(c => `${c.name} (${c.id})`).join('、')}`,
        data: { candidates },
      };
    }
    if (!match.entry) {
      return {
        ok: false,
        notify: true,
        title: '未找到目标设备',
        message: `未找到与“${query}”匹配的 Apple 设备。`,
      };
    }
    const targetDev = sanitizeDeviceForOutput(match.entry.device, config.places);
    const subject = typeof args.subject === 'string' && args.subject.trim()
      ? args.subject.trim()
      : 'F.R.I.D.A.Y. 查找设备提醒';

    if (args.dryRun === true) {
      return {
        ok: true,
        notify: true,
        title: '🔔 响铃预检 (dryRun)',
        message: `将向 ${targetDev.name} [${targetDev.model}] 发送 Find My 查找响铃指令（未实际执行）。`,
        data: { dryRun: true, device: targetDev, subject },
      };
    }

    const session = loadSession(paths.sessionPath);
    if (!session) {
      return {
        ok: false,
        notify: true,
        title: '无法触发设备响铃',
        message: 'Apple ID 会话不存在，请重新绑定。',
      };
    }
    try {
      await playFindMySound({
        session,
        rawDeviceId: match.entry.rawId,
        subject,
        fetchFn,
        signal,
      });
      await withFileLock(paths.sessionPath, () => saveSession(paths.sessionPath, session));
      return {
        ok: true,
        notify: true,
        title: `🔔 已触发 ${targetDev.name} 响铃`,
        message: `已向 ${targetDev.name} 发送 Find My 响铃指令，设备将以最大音量播放查找提示音。`,
        data: { dryRun: false, device: targetDev, subject },
      };
    } catch (err) {
      await withFileLock(paths.sessionPath, () => saveSession(paths.sessionPath, session));
      return {
        ok: false,
        notify: true,
        title: '发送响铃指令失败',
        message: errMsg(err),
        data: { errorCode: err instanceof AppleClientError ? err.code : 'PLAY_SOUND_FAILED', device: targetDev },
      };
    }
  }

  if (cleanAction === 'patrol') {
    const res = await getDevicesWithCache({
      paths,
      config,
      refresh: true,
      fetchFn,
      nowFn,
      signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        notify: true,
        title: '🍎 Apple 设备巡检需重新登录',
        message: res.message || 'Apple ID 会话不可用，请重新授权。',
        data: { ...res.auth, errorCode: res.errorCode },
      };
    }
    const allDevices = res.entries.map(e => sanitizeDeviceForOutput(e.device, config.places));
    const watchList = config.watchDevices.map(w => w.toLowerCase());
    const monitored = allDevices.filter(d => {
      if (watchList.length === 0) {
        return d.category === 'iphone' || d.category === 'ipad' || d.category === 'watch';
      }
      return watchList.some(w =>
        d.id.toLowerCase() === w
        || d.name.toLowerCase().includes(w)
        || d.category.toLowerCase() === w,
      );
    });

    const lowBatteryDevices = monitored.filter(d =>
      typeof d.batteryPercent === 'number'
      && d.batteryPercent < config.minBatteryPct
      && d.batteryStatus !== 'Charging'
      && d.batteryStatus !== 'Charged',
    );

    if (lowBatteryDevices.length === 0) {
      return {
        ok: true,
        notify: false,
        message: `巡检了 ${monitored.length} 台监控设备，电量均高于 ${config.minBatteryPct}% 或正在充电。`,
        data: {
          checkedCount: monitored.length,
          thresholdPct: config.minBatteryPct,
          lowBatteryDevices: [],
          devices: monitored,
        },
      };
    }

    return {
      ok: true,
      notify: true,
      title: '🔋 Apple 设备低电量提醒',
      message: lowBatteryDevices
        .map(d => `${d.name} 当前电量 ${d.batteryPercent}%（低于 ${config.minBatteryPct}% 且未在充电）`)
        .join('；'),
      data: {
        checkedCount: monitored.length,
        thresholdPct: config.minBatteryPct,
        lowBatteryDevices,
      },
    };
  }

  return {
    ok: false,
    notify: true,
    title: '未知插件动作',
    message: `apple-devices 不支持动作 "${cleanAction}"。可用动作：${ACTIONS.join(', ')}`,
  };
}

/**
 * In-process voice fastpath entry registered by `src/plugin.ts`.
 * @param {import('../_shared/types.d.ts').VoiceFastpathRequest} request
 * @param {import('../_shared/types.d.ts').PluginExecutionContext} context
 */
export async function handleVoiceFastpath(request, context) {
  return handleAppleVoiceFastpath(request, context, runAction);
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

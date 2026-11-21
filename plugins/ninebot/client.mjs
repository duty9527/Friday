import { randomBytes } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import {
  buildInner,
  buildRequest,
  decryptWireResponse,
  genNonce,
  PASSPORT_CLIENT_ID,
  passportSign,
  wgs84ToGcj02,
} from './crypto.mjs';

export const PASSPORT_HOST = 'https://api-passport-bj.ninebot.com';
export const BIZ_HOST = 'https://api-jhcx-v6-bj.ninebot.com';
export const MOTOR_HOST = 'https://steeldust.ninebot.com';
export const EBIKE_HOST = 'https://ebike.ninebot.com';
export const TRAVEL_HOST = 'https://cn-cbu-gateway.ninebot.com';
export const AMAP_REGEO_URL = 'https://restapi.amap.com/v3/geocode/regeo';

export const APP_VERSION = '610063322';
export const OS_VERSION = '13';
export const OS_MODEL = 'Xiaomi';
export const PLATFORM_VER = '13 Xiaomi';
export const RN_VERSION = '743';
export const USER_AGENT = 'okhttp/4.9.1';

export const VEHICLE_TYPE_MOTOR = '64';
export const VEHICLE_TYPE_EBIKE = '65';
export const VEHICLE_TYPE_TRAVEL = '112';

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_VEHICLE_IMAGE_BYTES = 512 * 1024;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_FALLBACK_TTL_MS = 7 * 86_400_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ALLOWED_IMAGE_HOSTS = new Set(['oms-oss-public.ninebot.com', 'steeldust-image-cdn.ninebot.com']);

const TRANSIENT_ERROR_RE = /(?:econnreset|etimedout|epipe|econnrefused|ehostunreach|timeout|timed out|socket hang up|reset|eof)/i;
const AUTH_ERROR_CODES = new Set(['401905', '4102', '4103', '401', '10001', '90001']);

/**
 * Structured Ninebot API / protocol error.
 */
export class NinebotApiError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string | number; httpStatus?: number; isAuthError?: boolean }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = 'NinebotApiError';
    this.code = meta.code !== undefined ? String(meta.code) : '';
    this.httpStatus = meta.httpStatus;
    this.isAuthError = Boolean(meta.isAuthError);
  }
}

/**
 * @param {string | number | undefined | null} code
 * @param {string | undefined | null} serverMsg
 * @param {string} [fallbackContext]
 * @returns {NinebotApiError}
 */
export function mapNinebotError(code, serverMsg, fallbackContext = '九号接口调用失败') {
  const codeStr = code !== undefined && code !== null ? String(code).trim() : '';
  const rawMsg = typeof serverMsg === 'string' ? serverMsg.trim() : '';
  const isAuthError = AUTH_ERROR_CODES.has(codeStr) || /4102|4103|401905|token|登录/i.test(rawMsg);

  if (codeStr === '90014') {
    return new NinebotApiError(
      '账号或登录密码错误（注意：九号默认短信登录，请先在《九号出行》App「我的 → 设置 → 账号绑定和管理 → 登录密码」单独设置密码）',
      { code: codeStr, isAuthError: false },
    );
  }
  if (codeStr === '00002' || codeStr === '2') {
    return new NinebotApiError('该手机号未注册九号账号', { code: codeStr, isAuthError: false });
  }
  if (codeStr === '90202') {
    return new NinebotApiError(
      '触发九号风控图形验证码，请稍后再试或先在手机 App 登录一次',
      { code: codeStr, isAuthError: false },
    );
  }
  if (codeStr === '90051') {
    return new NinebotApiError('Passport 请求签名校验失败 (90051)', { code: codeStr, isAuthError: false });
  }
  if (codeStr === '651001') {
    return new NinebotApiError(
      '车辆九号智能服务费已到期，云端数据已停用（需在九号出行 App 续费智能服务）',
      { code: codeStr, isAuthError: false },
    );
  }
  if (codeStr === '340000' && /4102/.test(rawMsg)) {
    return new NinebotApiError('业务网关身份校验缺失或已过期 (340000/4102)', { code: '4102', isAuthError: true });
  }
  if (codeStr === '340000' && /4103/.test(rawMsg)) {
    return new NinebotApiError('业务网关身份 uid 无效 (340000/4103)', { code: '4103', isAuthError: true });
  }
  if (codeStr === '401905') {
    return new NinebotApiError('九号业务会话已过期或用户身份无效 (401905)', { code: codeStr, isAuthError: true });
  }

  const detail = [rawMsg, codeStr ? `code=${codeStr}` : ''].filter(Boolean).join(', ');
  return new NinebotApiError(detail ? `${fallbackContext}: ${detail}` : fallbackContext, {
    code: codeStr,
    isAuthError,
  });
}

/**
 * Direct `node:http`/`node:https` requester preserving exact header casing and bypassing env proxies.
 * @param {{
 *   method: string;
 *   url: string;
 *   headers?: Record<string, string>;
 *   body?: string | Buffer;
 *   timeoutMs?: number;
 *   signal?: AbortSignal;
 * }} reqSpec
 * @returns {Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>}
 */
export function defaultHttpRequester(reqSpec) {
  const timeoutMs = reqSpec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = 2;

  const attemptOnce = () =>
    new Promise((resolve, reject) => {
      if (reqSpec.signal?.aborted) {
        reject(new Error('请求已取消'));
        return;
      }
      const parsed = new URL(reqSpec.url);
      const isHttps = parsed.protocol === 'https:';
      const transport = isHttps ? https : http;
      const bodyBuf = reqSpec.body === undefined || reqSpec.body === null
        ? undefined
        : Buffer.isBuffer(reqSpec.body)
          ? reqSpec.body
          : Buffer.from(String(reqSpec.body), 'utf8');

      /** @type {Record<string, string>} */
      const headers = { ...(reqSpec.headers || {}) };
      if (bodyBuf && !Object.keys(headers).some(k => k.toLowerCase() === 'content-length')) {
        headers['Content-Length'] = String(bodyBuf.length);
      }

      let settled = false;
      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const finishResolve = (val) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(val);
      };

      const req = transport.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method: reqSpec.method.toUpperCase(),
          headers,
          timeout: timeoutMs,
        },
        res => {
          /** @type {Buffer[]} */
          const chunks = [];
          let total = 0;
          res.on('data', chunk => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buf.length;
            if (total > MAX_RESPONSE_BYTES) {
              req.destroy(new Error(`响应体超过最大限制 (${MAX_RESPONSE_BYTES} 字节)`));
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
              finishReject(err);
              return;
            }
            finishResolve({
              status: res.statusCode ?? 0,
              headers: /** @type {Record<string, string | string[] | undefined>} */ (res.headers),
              body: raw,
            });
          });
          res.on('error', finishReject);
        },
      );

      const onAbort = () => {
        req.destroy(new Error('请求已中止'));
      };
      const cleanup = () => {
        reqSpec.signal?.removeEventListener('abort', onAbort);
      };

      if (reqSpec.signal) {
        reqSpec.signal.addEventListener('abort', onAbort, { once: true });
      }
      req.on('timeout', () => {
        req.destroy(new Error(`请求超时 (${timeoutMs}ms)`));
      });
      req.on('error', finishReject);

      if (bodyBuf) {
        req.write(bodyBuf);
      }
      req.end();
    });

  return (async () => {
    /** @type {unknown} */
    let lastErr;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await attemptOnce();
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt + 1 < maxAttempts && !reqSpec.signal?.aborted && TRANSIENT_ERROR_RE.test(msg)) {
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  })();
}

/**
 * @param {Buffer | string} body
 * @param {string} contextLabel
 * @returns {Record<string, unknown>}
 */
function parseJsonResponse(body, contextLabel) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('非 JSON 对象');
    }
    return parsed;
  } catch {
    throw new NinebotApiError(`${contextLabel}: 响应解析失败 (${text.slice(0, 120)})`);
  }
}

/**
 * @param {Record<string, unknown>} env
 * @returns {boolean}
 */
export function isBizSuccess(env) {
  const c = env?.code;
  return c === 0 || c === 1 || c === '0' || c === '1';
}

/**
 * @param {string} [preferredLine]
 * @param {{ motor?: string; ebike?: string }} [hosts]
 * @returns {Array<{ host: string; line: 'motor' | 'ebike'; vehicleType: string }>}
 */
export function orderedGateways(preferredLine = 'motor', hosts = {}) {
  const motor = (hosts.motor || MOTOR_HOST).replace(/\/+$/, '');
  const ebike = (hosts.ebike || EBIKE_HOST).replace(/\/+$/, '');
  if (preferredLine === 'ebike') {
    return [
      { host: ebike, line: 'ebike', vehicleType: VEHICLE_TYPE_EBIKE },
      { host: motor, line: 'motor', vehicleType: VEHICLE_TYPE_MOTOR },
    ];
  }
  return [
    { host: motor, line: 'motor', vehicleType: VEHICLE_TYPE_MOTOR },
    { host: ebike, line: 'ebike', vehicleType: VEHICLE_TYPE_EBIKE },
  ];
}

/**
 * @param {string} deviceId
 * @returns {Array<[string, unknown]>}
 */
function commonInnerParams(deviceId) {
  return [
    ['sys_language', 'zh-hans-cn'],
    ['client_ver', APP_VERSION],
    ['device_id', deviceId],
    ['regionx', 'bj'],
    ['language', 'zh'],
    ['ostype', 'and'],
    ['lang', 'zh'],
    ['platform_ver', PLATFORM_VER],
    ['platform', 'android'],
    ['login_country', 'CN'],
  ];
}

/**
 * @param {...unknown} vals
 * @returns {number | null}
 */
function pickNum(...vals) {
  for (const val of vals) {
    if (val === null || val === undefined || val === '' || typeof val === 'boolean') continue;
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * @param {...unknown} vals
 * @returns {string | null}
 */
function pickStr(...vals) {
  for (const val of vals) {
    if (typeof val === 'string' && val.trim()) return val.trim();
    if (typeof val === 'number' && Number.isFinite(val)) return String(val);
  }
  return null;
}

/**
 * Normalize Passport token expiry into epoch milliseconds.
 * Accepts ms epoch, 10-digit sec epoch, relative TTL seconds, or falls back to `savedAt + 7d`.
 * @param {unknown} rawValidity
 * @param {number} [savedAtMs]
 * @returns {number}
 */
export function normalizeTokenExpiryMs(rawValidity, savedAtMs = 0) {
  if (rawValidity !== null && rawValidity !== undefined) {
    const rawStr = String(rawValidity).trim();
    if (rawStr) {
      const n = Number(rawStr);
      if (Number.isFinite(n)) {
        if (n > 1_000_000_000_000) return Math.trunc(n);
        if (n > 1_000_000_000) return Math.trunc(n * 1000);
        if (n > 0 && Number.isFinite(savedAtMs) && savedAtMs > 0) {
          return Math.trunc(savedAtMs) + Math.trunc(n * 1000);
        }
      }
    }
  }
  if (Number.isFinite(savedAtMs) && savedAtMs > 0) {
    return Math.trunc(savedAtMs) + DEFAULT_TOKEN_FALLBACK_TTL_MS;
  }
  return 0;
}

/**
 * Check whether an account session's access token is still fresh.
 * @param {{ accessToken?: string; accessTokenValidity?: string | number; savedAt?: number } | null | undefined} session
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function isSessionTokenValid(session, nowMs = Date.now()) {
  if (!session || typeof session.accessToken !== 'string' || !session.accessToken.trim()) {
    return false;
  }
  const savedAt = Number(session.savedAt ?? 0);
  const expiry = normalizeTokenExpiryMs(session.accessTokenValidity, savedAt);
  if (!Number.isFinite(expiry) || expiry <= 0) {
    return false;
  }
  return expiry > nowMs + TOKEN_REFRESH_MARGIN_MS;
}

/**
 * Determine whether a Ninebot Passport JSON envelope represents success.
 * Live endpoints return `resultCode: "00000"` (login) or `"90000"` (refresh),
 * whereas some gateways/mocks return `code: 0`.
 * @param {Record<string, unknown>} parsed
 * @returns {boolean}
 */
export function isPassportSuccess(parsed) {
  const data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    ? /** @type {Record<string, unknown>} */ (parsed.data)
    : null;
  const hasToken = Boolean(data && pickStr(data.access_token, data.accessToken));
  const rc = parsed.resultCode !== undefined && parsed.resultCode !== null
    ? String(parsed.resultCode).trim()
    : undefined;
  const code = parsed.code !== undefined && parsed.code !== null
    ? String(parsed.code).trim()
    : undefined;
  return hasToken || rc === '00000' || rc === '90000' || rc === '0' || (rc === undefined && code === '0');
}

/**
 * Validate and normalize an official Ninebot PNG render URL.
 * Permits only `https:` on Ninebot domains pointing to a clean `.png` path.
 * @param {unknown} rawUrl
 * @returns {string | null}
 */
export function sanitizeNinebotImageUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  let u;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.hash) return null;
  if (u.port && u.port !== '443') return null;
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_IMAGE_HOSTS.has(host) && !host.endsWith('.ninebot.com')) return null;

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  const rawAfterScheme = trimmed.slice(trimmed.indexOf('://') + 3);
  const slashIdx = rawAfterScheme.indexOf('/');
  const rawPathPart = slashIdx >= 0 ? rawAfterScheme.slice(slashIdx).split(/[?#]/, 1)[0] || '' : '';
  let decodedRawPath = rawPathPart;
  try {
    decodedRawPath = decodeURIComponent(rawPathPart);
  } catch {
    return null;
  }
  if (!decodedPath.startsWith('/') || decodedPath.startsWith('//') || decodedPath.includes('\\') || decodedRawPath.includes('\\')) {
    return null;
  }
  for (let i = 0; i < decodedPath.length; i++) {
    const code = decodedPath.charCodeAt(i);
    if (code <= 32 || code === 127) return null;
  }
  if (
    decodedPath.split('/').some(seg => seg === '.' || seg === '..') ||
    decodedRawPath.split('/').some(seg => seg === '.' || seg === '..')
  ) {
    return null;
  }
  if (!decodedPath.toLowerCase().endsWith('.png')) return null;
  return u.toString();
}

/**
 * Unwrap Ninebot gateway payloads that sometimes wrap the entity inside `[0]` or `{"0": {...}}`.
 * @param {unknown} raw
 * @returns {Record<string, any>}
 */
function unwrapIndexedPayload(raw) {
  if (Array.isArray(raw)) {
    const first = raw[0];
    return first && typeof first === 'object' && !Array.isArray(first)
      ? /** @type {Record<string, any>} */ (first)
      : {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const obj = /** @type {Record<string, any>} */ (raw);
  if (
    !('sn' in obj) &&
    !('dump_energy' in obj) &&
    !('electricity' in obj) &&
    obj['0'] &&
    typeof obj['0'] === 'object' &&
    !Array.isArray(obj['0'])
  ) {
    return /** @type {Record<string, any>} */ (obj['0']);
  }
  return obj;
}

/**
 * Normalize a vehicle list item while stripping sensitive owner/hardware metadata.
 * @param {Record<string, unknown>} item
 * @param {'motor' | 'ebike' | 'official'} businessLine
 * @returns {Record<string, unknown> | null}
 */
export function normalizeVehicleRecord(item, businessLine = 'motor') {
  if (!item || typeof item !== 'object') return null;
  const sn = pickStr(item.wnumber, item.sn, item.vehicleSn, item.vehicle_sn);
  if (!sn) return null;
  const name = pickStr(
    item.ble_name,
    item.device_name,
    item.deviceName,
    item.vehicle_name,
    item.vehicleName,
    item.name,
    item.nick,
    item.nickname,
    item.alias,
    item.title,
  ) || sn;
  const modelName = pickStr(item.vehicle_name_zh, item.vehicle_name, item.vehicleName, item.modelName) || '';
  const color = pickStr(item.color) || '';
  const darkImageUrl = sanitizeNinebotImageUrl(pickStr(item.v6_dark_img_url, item.v6_light_img_url, item.img_url) || '');
  const lightImageUrl = sanitizeNinebotImageUrl(pickStr(item.v6_light_img_url, item.img_url, item.v6_dark_img_url) || '');
  const totalMileageKm = pickNum(item.total_mileage, item.totalMileage);
  const smartServiceSurplusDays = pickNum(item.smart_service_surplus_days);
  const vehicleType = pickNum(item.vehicle_type, item.vehicleType);
  const isSharedAccount = item.is_common_user === 1 || item.is_common_user === '1';

  return {
    sn,
    name,
    modelName,
    color,
    darkImageUrl,
    lightImageUrl,
    businessLine,
    vehicleType,
    totalMileageKm,
    smartServiceSurplusDays,
    isSharedAccount,
    actived: item.actived === undefined ? true : Boolean(item.actived),
    permissions: item.common_user_permissions ?? null,
  };
}

/**
 * Normalize raw payloads from Ninebot account or official backends into one canonical M-series-ready snapshot.
 * @param {{
 *   sn: string;
 *   vehicleMeta?: Record<string, unknown> | null;
 *   desktop?: Record<string, unknown> | null;
 *   vehicleInfo?: Record<string, unknown> | null;
 *   batteryInfo?: Record<string, unknown> | null;
 *   vehicleStatus?: Record<string, unknown> | null;
 *   official?: Record<string, unknown> | null;
 *   backend?: 'account' | 'official';
 *   businessLine?: 'motor' | 'ebike' | 'official';
 *   coordSys?: 'wgs84' | 'gcj02';
 *   capturedAt?: number;
 * }} input
 */
export function normalizeVehicleSnapshot(input) {
  const desktop = unwrapIndexedPayload(input.desktop);
  const vehicleInfo = unwrapIndexedPayload(input.vehicleInfo);
  const batteryInfo = unwrapIndexedPayload(input.batteryInfo);
  const vehicleStatus = unwrapIndexedPayload(input.vehicleStatus);
  const official = /** @type {Record<string, any>} */ (input.official && typeof input.official === 'object' ? input.official : {});
  const meta = /** @type {Record<string, any>} */ (input.vehicleMeta && typeof input.vehicleMeta === 'object' ? input.vehicleMeta : {});

  const packs = Array.isArray(batteryInfo.battery_list)
    ? batteryInfo.battery_list
    : Array.isArray(batteryInfo.batlist)
      ? batteryInfo.batlist
      : [];
  const mainPack = /** @type {Record<string, any>} */ (packs[0] && typeof packs[0] === 'object' ? packs[0] : {});
  const batteryMain = /** @type {Record<string, any>} */ (
    batteryInfo.battery_main && typeof batteryInfo.battery_main === 'object'
      ? batteryInfo.battery_main
      : {}
  );

  const batteryRaw = pickNum(
    desktop.dump_energy,
    batteryInfo.electricity,
    mainPack.electricity,
    desktop.battery,
    official.dumpEnergy,
    official.battery,
  );
  const battery = batteryRaw !== null ? Math.max(0, Math.min(100, Math.round(batteryRaw))) : null;
  const auxBatteryRaw = pickNum(batteryMain.electricity);
  const auxBattery = auxBatteryRaw !== null ? Math.max(0, Math.min(100, Math.round(auxBatteryRaw))) : null;

  const voltageV = pickNum(mainPack.bms_volt, mainPack.bmsvolt, batteryInfo.bms_volt);
  const temperatureC = pickNum(mainPack.bat_temp, mainPack.battemp, batteryInfo.bat_temp);
  const hasCycleSupport = Boolean(batteryInfo.have_bms_cycle_support);
  const cycles = hasCycleSupport ? pickNum(mainPack.bms_cycle) : null;
  const batteryScore = pickNum(mainPack.score);

  const charging =
    desktop.charging === 1 ||
    desktop.charging === '1' ||
    batteryInfo.charging === 1 ||
    batteryInfo.charging === '1' ||
    official.chargingState === 1 ||
    official.chargingState === '1' ||
    String(official.chargingState ?? '').toLowerCase() === 'charging';

  const chargingPowerW = pickNum(batteryInfo.charging_power, desktop.charging_power);
  const remainChargeTime = pickStr(
    batteryInfo.remain_charge_time,
    desktop.remain_charge_time,
    official.remainChargeTime,
  );

  const estimateMileageKm = pickNum(
    desktop.estimate_mileage,
    batteryInfo.estimate_mil,
    official.estimateMileage,
    desktop.range,
  );
  const preciseEstimateMileageKm = pickNum(desktop.precise_estimate_mileage);
  const aiEstimateMileageKm = pickNum(desktop.ai_estimate_mileage);
  const effectiveRangeKm =
    (preciseEstimateMileageKm !== null && preciseEstimateMileageKm > 0 ? preciseEstimateMileageKm : null) ??
    (aiEstimateMileageKm !== null && aiEstimateMileageKm > 0 ? aiEstimateMileageKm : null) ??
    estimateMileageKm;

  const odometerKm = pickNum(vehicleInfo.total_mileage, meta.totalMileageKm);
  const locObj = /** @type {Record<string, any>} */ (
    desktop.loc && typeof desktop.loc === 'object'
      ? desktop.loc
      : vehicleInfo.loc && typeof vehicleInfo.loc === 'object'
        ? vehicleInfo.loc
        : official.locationInfo && typeof official.locationInfo === 'object'
          ? official.locationInfo
          : {}
  );

  // On M-series, `desktop.pwr` / `vehicleInfo.pwr` reports main-battery presence, NOT ignition ACC state.
  // True ignition / power state comes from `vehicleStatus.power_status` and `loc.acc`.
  const psRaw = vehicleStatus.power_status;
  const accRaw = locObj.acc;
  const officialPwr = String(official.powerStatus ?? desktop.powerStatus ?? '').trim().toUpperCase();
  const powerOn =
    psRaw === 1 || psRaw === '1'
      ? true
      : psRaw === 0 || psRaw === '0'
        ? false
        : accRaw === 1 || accRaw === '1'
          ? true
          : accRaw === 0 || accRaw === '0'
            ? false
            : officialPwr === 'ON';

  const batteryPresent =
    desktop.battery_exist === 1 ||
    desktop.battery_exist === '1' ||
    desktop.pwr === 1 ||
    desktop.pwr === '1' ||
    battery !== null;

  const locked =
    locObj.lock === 1 || locObj.lock === '1'
      ? true
      : locObj.lock === 0 || locObj.lock === '0'
        ? false
        : powerOn
          ? false
          : null;

  const sq = vehicleStatus.SQ && typeof vehicleStatus.SQ === 'object'
    ? /** @type {Record<string, any>} */ (vehicleStatus.SQ)
    : {};
  const barrelLockStatus = pickNum(desktop.barrel_lock_status);
  const gsmSignal = pickNum(vehicleStatus.gsm_signal, sq.GSM, vehicleStatus.gsm, vehicleStatus.signal);
  const gnssSignal = pickNum(vehicleStatus.gnss_signal, sq.GNSS, vehicleStatus.gps_signal, vehicleStatus.satellites);
  const gnssTimeSec = pickNum(vehicleInfo.gnss_time, sq.gnss_time, vehicleInfo.lastupdatetime);
  const locDelaySec = pickNum(sq.loc_delay_seconds, vehicleStatus.sd_time);
  const smartServiceExpired =
    desktop.is_smart_service_expired === 1 ||
    desktop.is_smart_service_expired === '1' ||
    vehicleInfo.is_smart_service_expired === 1;

  const isCommonUser =
    desktop.is_common_user === 1 ||
    desktop.is_common_user === '1' ||
    Boolean(meta.isSharedAccount);

  const rawLat = pickNum(locObj.lat, official.lat);
  const rawLon = pickNum(locObj.lon, official.lon);
  const coordValid =
    rawLat !== null &&
    rawLon !== null &&
    Math.abs(rawLat) <= 90 &&
    Math.abs(rawLon) <= 180 &&
    !(Math.abs(rawLat) < 1e-6 && Math.abs(rawLon) < 1e-6);

  let gcjLat = null;
  let gcjLon = null;
  if (coordValid) {
    if (input.coordSys === 'gcj02') {
      gcjLat = Number(rawLat.toFixed(6));
      gcjLon = Number(rawLon.toFixed(6));
    } else {
      const converted = wgs84ToGcj02(rawLat, rawLon);
      gcjLat = converted.lat;
      gcjLon = converted.lon;
    }
  }

  const upstreamAddress = pickStr(
    locObj.desc,
    locObj.address,
    official.locationInfo?.locationDesc,
    official.locationDesc,
  );

  const name = pickStr(
    desktop.ble_name,
    meta.name,
    official.deviceName,
    vehicleInfo.ble_name,
    vehicleInfo.device_name,
  ) || input.sn;

  const modelName = pickStr(
    meta.modelName,
    vehicleInfo.vehicle_name_zh,
    vehicleInfo.vehicle_name,
  ) || '';

  const color = pickStr(meta.color, vehicleInfo.color, desktop.color) || '';
  const darkImageUrl = sanitizeNinebotImageUrl(
    pickStr(desktop.v6_dark_img_url, meta.darkImageUrl, desktop.v6_light_img_url, meta.lightImageUrl, vehicleInfo.img_url) || '',
  );
  const lightImageUrl = sanitizeNinebotImageUrl(
    pickStr(desktop.v6_light_img_url, meta.lightImageUrl, vehicleInfo.img_url, desktop.v6_dark_img_url, meta.darkImageUrl) || '',
  );

  return {
    sn: input.sn,
    name,
    modelName,
    color,
    darkImageUrl,
    lightImageUrl,
    backend: input.backend ?? 'account',
    businessLine: input.businessLine ?? (meta.businessLine || 'motor'),
    capturedAt: input.capturedAt ?? Date.now(),
    battery,
    batteryPresent,
    auxBattery,
    voltageV,
    temperatureC,
    cycles,
    hasCycleSupport,
    batteryScore,
    charging,
    chargingPowerW,
    remainChargeTime,
    estimateMileageKm,
    preciseEstimateMileageKm,
    aiEstimateMileageKm,
    effectiveRangeKm,
    odometerKm,
    powerOn,
    locked,
    barrelLockStatus,
    gsmSignal,
    gnssSignal,
    gnssTimeSec,
    locDelaySec,
    smartServiceExpired,
    isSharedAccount: isCommonUser,
    location: {
      valid: coordValid,
      wgsLat: coordValid ? rawLat : null,
      wgsLon: coordValid ? rawLon : null,
      gcjLat,
      gcjLon,
      address: upstreamAddress,
      shortAddress: upstreamAddress,
      source: upstreamAddress ? 'ninebot' : null,
    },
  };
}

/**
 * Create a Ninebot cloud API client bound to injectable transport & hosts.
 * @param {{
 *   httpRequester?: typeof defaultHttpRequester;
 *   nowFn?: () => number;
 *   signal?: AbortSignal;
 *   rsaPublicKeyPem?: string;
 *   hosts?: {
 *     passport?: string;
 *     biz?: string;
 *     motor?: string;
 *     ebike?: string;
 *     travel?: string;
 *     amap?: string;
 *   };
 * }} [options]
 */
export function createNinebotClient(options = {}) {
  const requester = typeof options.httpRequester === 'function' ? options.httpRequester : defaultHttpRequester;
  const nowFn = typeof options.nowFn === 'function' ? options.nowFn : Date.now;
  const signal = options.signal;
  const rsaPublicKeyPem = typeof options.rsaPublicKeyPem === 'string' && options.rsaPublicKeyPem.trim()
    ? options.rsaPublicKeyPem
    : undefined;
  const hosts = {
    passport: (options.hosts?.passport || PASSPORT_HOST).replace(/\/+$/, ''),
    biz: (options.hosts?.biz || BIZ_HOST).replace(/\/+$/, ''),
    motor: (options.hosts?.motor || MOTOR_HOST).replace(/\/+$/, ''),
    ebike: (options.hosts?.ebike || EBIKE_HOST).replace(/\/+$/, ''),
    travel: (options.hosts?.travel || TRAVEL_HOST).replace(/\/+$/, ''),
    amap: (options.hosts?.amap || AMAP_REGEO_URL).replace(/\/+$/, ''),
  };

  /**
   * @param {string} path
   * @param {Record<string, string>} bodyObj
   */
  async function passportPost(path, bodyObj) {
    const tsMs = nowFn();
    /** @type {Record<string, unknown>} */
    const signParams = {
      app_version: APP_VERSION,
      os: 'Android',
      os_language: 'zh-hans-cn',
      os_version: OS_VERSION,
      timestamp: String(tsMs),
      ...bodyObj,
    };
    const sign = passportSign(path, signParams);
    const headers = {
      App_version: APP_VERSION,
      Clientid: PASSPORT_CLIENT_ID,
      'Content-Type': 'application/json; charset=UTF-8',
      Os: 'Android',
      Os_language: 'zh-hans-cn',
      Os_version: OS_VERSION,
      'Accept-Encoding': 'gzip',
      'User-Agent': USER_AGENT,
      Timestamp: String(tsMs),
      Sign: sign,
    };
    const res = await requester({
      method: 'POST',
      url: `${hosts.passport}${path}`,
      headers,
      body: JSON.stringify(bodyObj),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      signal,
    });
    if (res.status >= 500) {
      throw new NinebotApiError(`Passport 服务异常 (HTTP ${res.status})`, { httpStatus: res.status });
    }
    const parsed = parseJsonResponse(res.body, `Passport ${path}`);
    if (!isPassportSuccess(parsed)) {
      throw mapNinebotError(
        /** @type {string | number | undefined} */ (parsed.resultCode ?? parsed.code),
        /** @type {string | undefined} */ (parsed.resultDesc ?? parsed.msg ?? parsed.desc ?? parsed.message),
        'Passport 登录失败',
      );
    }
    return parsed;
  }

  /**
   * @param {{ username: string; password: string; areaCode?: string }} creds
   */
  async function passportLogin(creds) {
    const username = String(creds.username || '').trim();
    const password = String(creds.password || '');
    const areaCode = String(creds.areaCode || '86').trim() || '86';
    if (!username || !password) {
      throw new NinebotApiError('缺少九号账号或密码');
    }
    const resp = await passportPost('/v6/user/login', {
      areaCode,
      device: 'ANDROID',
      password,
      username,
    });
    const data = /** @type {Record<string, unknown>} */ (resp.data && typeof resp.data === 'object' ? resp.data : {});
    const accessToken = pickStr(data.access_token, data.accessToken);
    if (!accessToken) {
      throw new NinebotApiError('Passport 登录成功但响应缺少 access_token');
    }
    const savedAt = nowFn();
    const validityMs = normalizeTokenExpiryMs(data.accessTokenValidity ?? data.expires_in, savedAt);
    return {
      uuid: pickStr(data.uuid) || '',
      username,
      areaCode,
      region: pickStr(data.region) || 'bj',
      accessToken,
      refreshToken: pickStr(data.refresh_token, data.refreshToken) || '',
      accessTokenValidity: validityMs > 0 ? String(validityMs) : '',
      savedAt,
    };
  }

  /**
   * @param {{ accessToken: string; refreshToken: string; accessTokenValidity?: string | number; uuid?: string; username?: string; areaCode?: string; region?: string; businessUid?: string }} session
   */
  async function passportRefresh(session) {
    if (!session.accessToken || !session.refreshToken) {
      throw new NinebotApiError('缺少 refresh_token，无法刷新九号会话', { isAuthError: true });
    }
    const resp = await passportPost('/v3/user/refresh', {
      access_token: session.accessToken,
      device: 'ANDROID',
      refresh_token: session.refreshToken,
    });
    const data = /** @type {Record<string, unknown>} */ (resp.data && typeof resp.data === 'object' ? resp.data : {});
    const nextToken = pickStr(data.access_token, data.accessToken) || session.accessToken;
    const nextRefresh = pickStr(data.refresh_token, data.refreshToken) || session.refreshToken;
    const savedAt = nowFn();
    const fallbackPrev = Number(session.accessTokenValidity ?? 0) > savedAt ? session.accessTokenValidity : undefined;
    const nextValidityMs = normalizeTokenExpiryMs(data.accessTokenValidity ?? data.expires_in ?? fallbackPrev, savedAt);
    return {
      ...session,
      accessToken: nextToken,
      refreshToken: nextRefresh,
      accessTokenValidity: nextValidityMs > 0 ? String(nextValidityMs) : '',
      savedAt,
    };
  }

  /**
   * Execute one encrypted NET business call (`{ d, h, k, p, t }` -> `{ r }`).
   * @param {string} host
   * @param {string} path
   * @param {Array<[string, unknown]>} extraParams
   * @param {{
   *   accessToken?: string;
   *   businessUid?: string;
   *   deviceId: string;
   *   businessType?: string;
   *   extraHeaders?: Record<string, string>;
   *   includeAccessTokenHeader?: boolean;
   * }} opts
   * @returns {Promise<Record<string, unknown>>}
   */
  async function postEncrypted(host, path, extraParams, opts) {
    const nowMs = nowFn();
    const accessToken = opts.accessToken || '';
    const uid = opts.businessUid || '';
    /** @type {Array<[string, unknown]>} */
    const params = [...commonInnerParams(opts.deviceId)];
    if (accessToken) params.push(['access_token', accessToken]);
    if (uid) params.push(['uid', uid]);
    params.push(...extraParams);

    const innerJson = buildInner(params);
    const { body, secrets } = buildRequest(Buffer.from(innerJson, 'utf8'), {
      timestampSec: Math.floor(nowMs / 1000),
      rsaPublicKeyPem,
    });

    const extraHeaders = opts.extraHeaders || {};
    const hasLowerAccessToken = Object.keys(extraHeaders).some(k => k.toLowerCase() === 'access_token');

    /** @type {Record<string, string>} */
    const headers = {
      'Content-Type': 'text/html;charset=UTF-8',
      'User-Agent': USER_AGENT,
      'Accept-Encoding': 'gzip',
      'Ninebot-Version': '2',
      'Client-Ver': APP_VERSION,
      'Business-Type': opts.businessType ?? '2',
      Language: 'zh',
      'Sys-Language': 'zh-hans-cn',
      'Login-Country': 'CN',
      Platform: 'Android',
      'Platform-Ver': OS_VERSION,
      Regionx: 'bj',
      'Device-Id': opts.deviceId,
      'Request-Id': randomBytes(16).toString('hex'),
      'Service-Time': String(nowMs),
      'Cache-Control': 'no-cache',
      Debug: '0',
      Need_decrypt: '1',
    };
    if (uid) {
      headers.Uid = uid;
    }
    if (opts.includeAccessTokenHeader && accessToken && !hasLowerAccessToken) {
      headers.Access_token = accessToken;
    }
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers[k] = v;
    }

    const url = `${host.replace(/\/+$/, '')}${path}`;
    const res = await requester({
      method: 'POST',
      url,
      headers,
      body: JSON.stringify(body),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new NinebotApiError(`九号业务网关鉴权失败 (HTTP ${res.status})`, {
        httpStatus: res.status,
        isAuthError: true,
      });
    }
    if (res.status >= 400) {
      throw new NinebotApiError(`九号业务网关请求失败 (HTTP ${res.status})`, { httpStatus: res.status });
    }
    const outer = parseJsonResponse(res.body, `Business ${path}`);
    if (typeof outer.r === 'string' && outer.r.trim()) {
      return decryptWireResponse(outer, secrets);
    }
    if ('code' in outer) {
      return outer;
    }
    throw new NinebotApiError(`Business ${path}: 响应缺少加密载荷 r`);
  }

  /**
   * @param {{ accessToken: string; uuid?: string; refreshToken?: string; region?: string }} session
   * @param {string} deviceId
   * @returns {Promise<string | null>}
   */
  async function businessLogin(session, deviceId) {
    const nowMs = nowFn();
    /** @type {Array<[string, unknown]>} */
    const params = [
      ...commonInnerParams(deviceId),
      ['access_token', session.accessToken],
      ['uuid', session.uuid || ''],
      ['token', session.accessToken],
      ['refresh_token', session.refreshToken || ''],
      ['region', session.region || 'bj'],
      ['serviceTime', nowMs],
      ['nonce', genNonce()],
    ];

    const innerJson = buildInner(params);
    const { body, secrets } = buildRequest(Buffer.from(innerJson, 'utf8'), {
      timestampSec: Math.floor(nowMs / 1000),
      rsaPublicKeyPem,
    });
    const headers = {
      'Content-Type': 'text/html;charset=UTF-8',
      'User-Agent': USER_AGENT,
      'Accept-Encoding': 'gzip',
      'Ninebot-Version': '2',
      'Client-Ver': APP_VERSION,
      'Business-Type': '0',
      Language: 'zh',
      'Sys-Language': 'zh-hans-cn',
      'Login-Country': 'CN',
      Platform: 'Android',
      'Platform-Ver': OS_VERSION,
      Regionx: 'bj',
      'Device-Id': deviceId,
      'Request-Id': randomBytes(16).toString('hex'),
      'Service-Time': String(nowMs),
      'Cache-Control': 'no-cache',
      Debug: '0',
      Need_decrypt: '1',
    };
    const res = await requester({
      method: 'POST',
      url: `${hosts.biz}/user/user/login`,
      headers,
      body: JSON.stringify(body),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      signal,
    });
    if (res.status >= 400) {
      throw new NinebotApiError(`Business 登录失败 (HTTP ${res.status})`, {
        httpStatus: res.status,
        isAuthError: res.status === 401,
      });
    }
    const outer = parseJsonResponse(res.body, 'Business /user/user/login');
    const env = typeof outer.r === 'string' && outer.r.trim() ? decryptWireResponse(outer, secrets) : outer;
    if (!isBizSuccess(env)) {
      throw mapNinebotError(
        /** @type {string | number | undefined} */ (env.code),
        /** @type {string | undefined} */ (env.message ?? env.desc),
        'Business 登录失败',
      );
    }
    const data = env.data && typeof env.data === 'object' ? /** @type {Record<string, unknown>} */ (env.data) : {};
    return pickStr(data.uid, data.Uid, data.userId);
  }

  /**
   * @param {{ accessToken: string; businessUid?: string; deviceId: string }} session
   * @param {string} [preferredLine]
   */
  async function listVehicles(session, preferredLine = 'motor') {
    const gateways = orderedGateways(preferredLine, hosts);
    /** @type {Array<Record<string, unknown>>} */
    const merged = [];
    const seen = new Set();
    /** @type {NinebotApiError | null} */
    let lastError = null;
    let anySuccess = false;

    for (const gw of gateways) {
      try {
        const env = await postEncrypted(
          gw.host,
          '/vehicle/binding/my-vehicle',
          [
            ['vehicle_type', gw.vehicleType],
            ['serviceTime', nowFn()],
            ['nonce', genNonce()],
          ],
          {
            accessToken: session.accessToken,
            businessUid: session.businessUid,
            deviceId: session.deviceId,
            businessType: '1',
          },
        );
        if (!isBizSuccess(env)) {
          lastError = mapNinebotError(
            /** @type {string | number | undefined} */ (env.code),
            /** @type {string | undefined} */ (env.message ?? env.desc),
            '获取车辆列表失败',
          );
          if (lastError.isAuthError) throw lastError;
          continue;
        }
        anySuccess = true;
        /** @type {unknown[]} */
        let rawList = [];
        if (Array.isArray(env.data)) {
          rawList = env.data;
        } else if (env.data && typeof env.data === 'object') {
          const d = /** @type {Record<string, unknown>} */ (env.data);
          for (const k of ['vehicles', 'list', 'vehicleList', 'data']) {
            if (Array.isArray(d[k])) {
              rawList = d[k];
              break;
            }
          }
        }
        for (const row of rawList) {
          if (!row || typeof row !== 'object') continue;
          const norm = normalizeVehicleRecord(/** @type {Record<string, unknown>} */ (row), gw.line);
          if (norm && !seen.has(String(norm.sn))) {
            seen.add(String(norm.sn));
            merged.push(norm);
          }
        }
      } catch (err) {
        if (err instanceof NinebotApiError && err.isAuthError) {
          throw err;
        }
        lastError = err instanceof NinebotApiError ? err : new NinebotApiError(err instanceof Error ? err.message : String(err));
      }
    }

    if (!anySuccess && lastError) {
      throw lastError;
    }
    return merged;
  }

  /**
   * Call an endpoint across ordered gateways (`motor` first for M-series, `ebike` fallback) until one returns data.
   * @param {string} path
   * @param {Array<[string, unknown]>} extraParams
   * @param {{ accessToken: string; businessUid?: string; deviceId: string }} session
   * @param {string} [preferredLine]
   * @returns {Promise<{ payload: Record<string, unknown> | null; businessLine: 'motor' | 'ebike' }>}
   */
  async function queryWithGatewayFallback(path, extraParams, session, preferredLine = 'motor') {
    const gateways = orderedGateways(preferredLine, hosts);
    /** @type {NinebotApiError | null} */
    let lastError = null;
    for (const gw of gateways) {
      try {
        const env = await postEncrypted(
          gw.host,
          path,
          [...extraParams, ['serviceTime', nowFn()], ['nonce', genNonce()]],
          {
            accessToken: session.accessToken,
            businessUid: session.businessUid,
            deviceId: session.deviceId,
            businessType: '2',
          },
        );
        if (!isBizSuccess(env)) {
          lastError = mapNinebotError(
            /** @type {string | number | undefined} */ (env.code),
            /** @type {string | undefined} */ (env.message ?? env.desc),
            `请求 ${path} 失败`,
          );
          if (lastError.isAuthError || lastError.code === '651001') {
            throw lastError;
          }
          continue;
        }
        let payload = env.data;
        if (Array.isArray(payload)) {
          payload = payload[0] ?? null;
        } else if (
          payload &&
          typeof payload === 'object' &&
          !('sn' in payload) &&
          !('dump_energy' in payload) &&
          !('electricity' in payload) &&
          '0' in payload
        ) {
          const inner0 = /** @type {Record<string, unknown>} */ (payload)['0'];
          if (inner0 && typeof inner0 === 'object' && !Array.isArray(inner0)) {
            payload = inner0;
          }
        }
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          return {
            payload: /** @type {Record<string, unknown>} */ (payload),
            businessLine: gw.line,
          };
        }
      } catch (err) {
        if (err instanceof NinebotApiError && (err.isAuthError || err.code === '651001')) {
          throw err;
        }
        lastError = err instanceof NinebotApiError ? err : new NinebotApiError(err instanceof Error ? err.message : String(err));
      }
    }
    if (lastError) throw lastError;
    return { payload: null, businessLine: preferredLine === 'ebike' ? 'ebike' : 'motor' };
  }

  /**
   * Fetch live M-series / e-bike telemetry across desktop-component, vehicle-info, battery-info, and vehicle-status.
   * @param {{ accessToken: string; businessUid?: string; deviceId: string }} session
   * @param {string} sn
   * @param {{ preferredLine?: string; vehicleMeta?: Record<string, unknown> | null; coordSys?: 'wgs84' | 'gcj02' }} [opts]
   */
  async function fetchVehicleSnapshotAccount(session, sn, opts = {}) {
    const metaLine = opts.vehicleMeta?.businessLine === 'motor' || opts.vehicleMeta?.businessLine === 'ebike'
      ? String(opts.vehicleMeta.businessLine)
      : undefined;
    const preferredLine = opts.preferredLine || metaLine || 'motor';

    const [desktopRes, infoRes, batteryRes, statusRes] = await Promise.allSettled([
      queryWithGatewayFallback('/vehicle/vehicle/desktop-component', [['sn_str', sn]], session, preferredLine),
      queryWithGatewayFallback('/vehicle/vehicle/vehicle-info', [['wnumber', sn]], session, preferredLine),
      queryWithGatewayFallback('/v6/vehicle/battery-info', [['wnumber', sn]], session, preferredLine),
      queryWithGatewayFallback('/vehicle/vehicle/vehicle-status', [['wnumber', sn]], session, preferredLine),
    ]);

    const results = [desktopRes, infoRes, batteryRes, statusRes];
    for (const r of results) {
      if (r.status === 'rejected' && r.reason instanceof NinebotApiError && (r.reason.isAuthError || r.reason.code === '651001')) {
        throw r.reason;
      }
    }

    const desktop = desktopRes.status === 'fulfilled' ? desktopRes.value.payload : null;
    const vehicleInfo = infoRes.status === 'fulfilled' ? infoRes.value.payload : null;
    const batteryInfo = batteryRes.status === 'fulfilled' ? batteryRes.value.payload : null;
    const vehicleStatus = statusRes.status === 'fulfilled' ? statusRes.value.payload : null;

    if (!desktop && !vehicleInfo && !batteryInfo) {
      const firstRejected = results.find(r => r.status === 'rejected');
      if (firstRejected && firstRejected.status === 'rejected') {
        throw firstRejected.reason;
      }
      throw new NinebotApiError(`未获取到车辆 ${sn} 的任何遥测数据`);
    }

    const resolvedLine =
      (desktopRes.status === 'fulfilled' && desktopRes.value.payload ? desktopRes.value.businessLine : null) ??
      (batteryRes.status === 'fulfilled' && batteryRes.value.payload ? batteryRes.value.businessLine : null) ??
      (preferredLine === 'ebike' ? 'ebike' : 'motor');

    return normalizeVehicleSnapshot({
      sn,
      vehicleMeta: opts.vehicleMeta,
      desktop,
      vehicleInfo,
      batteryInfo,
      vehicleStatus,
      backend: 'account',
      businessLine: resolvedLine,
      coordSys: opts.coordSys ?? 'wgs84',
      capturedAt: nowFn(),
    });
  }

  /**
   * Normalize one raw ride row from `travel-list2`.
   * @param {unknown} item
   * @param {string} monthYYYYMM
   */
  function normalizeTripRow(item, monthYYYYMM) {
    if (!item || typeof item !== 'object') return null;
    const row = /** @type {Record<string, unknown>} */ (item);
    const travelId = pickStr(row.travel_id, row.id) || '';
    if (!travelId) return null;
    const distanceKm = pickNum(row.mileages, row.distance) ?? 0;
    const durationSec = pickNum(row.duration) ?? 0;
    const maxSpeedKmh = pickNum(row.speed, row.max_speed) ?? 0;
    const avgSpeedKmh = durationSec > 0 ? Number((distanceKm / (durationSec / 3600)).toFixed(1)) : 0;
    return {
      travelId,
      startTime: pickNum(row.start_time) ?? 0,
      endTime: pickNum(row.end_time) ?? 0,
      endTimeText: pickStr(row.end_time_format) || '',
      durationSec,
      distanceKm: Number(distanceKm.toFixed(2)),
      maxSpeedKmh: Number(maxSpeedKmh.toFixed(1)),
      avgSpeedKmh,
      usedElectricity: pickNum(row.used_electricity) ?? 0,
      energyConsumption: pickNum(row.ec),
      dayTotalMileageKm: pickNum(row.day_total_mileage),
      month: monthYYYYMM,
    };
  }

  /**
   * Build extra HTTP headers expected by Ninebot's travel gateway (`cn-cbu-gateway`).
   * @param {string} accessToken
   * @returns {Record<string, string>}
   */
  function buildTravelHeaders(accessToken) {
    return {
      Access_token: accessToken,
      Accept: 'application/json',
      'Rn-Module': 'Track',
      'Rn-Ver': RN_VERSION,
      'Rn-Version': '0',
    };
  }

  /**
   * Fetch monthly trips from `cn-cbu-gateway.ninebot.com/app-api/travel/v6/travel-list2`.
   * Automatically maps `motor` -> `Business-Type: "1"` and `ebike` -> `Business-Type: "2"`,
   * probes the alternate type once if empty, and paginates through the full month when `page` is omitted.
   * @param {{ accessToken: string; businessUid?: string; deviceId: string }} session
   * @param {string} sn
   * @param {string} monthYYYYMM
   * @param {number | { page?: number; maxPages?: number; businessLine?: 'motor' | 'ebike' }} [pageOrOpts]
   */
  async function fetchTrips(session, sn, monthYYYYMM, pageOrOpts = {}) {
    const isNumericPage = typeof pageOrOpts === 'number';
    const opts = isNumericPage ? { page: pageOrOpts } : (pageOrOpts || {});
    const line = opts.businessLine === 'ebike' ? 'ebike' : 'motor';
    let activeBizType = line === 'ebike' ? '2' : '1';
    const fallbackBizType = activeBizType === '1' ? '2' : '1';
    const travelHeaders = buildTravelHeaders(session.accessToken);

    /**
     * @param {number} pageNum
     * @param {string} bizType
     */
    const fetchSinglePage = async (pageNum, bizType) => {
      const env = await postEncrypted(
        hosts.travel,
        '/app-api/travel/v6/travel-list2',
        [
          ['wnumber', sn],
          ['rnVersion', RN_VERSION],
          ['vehicle_type', VEHICLE_TYPE_TRAVEL],
          ['month', monthYYYYMM],
          ['page', String(pageNum)],
          ['current_version', APP_VERSION],
          ['serviceTime', nowFn()],
          ['nonce', genNonce()],
        ],
        {
          accessToken: session.accessToken,
          businessUid: session.businessUid,
          deviceId: session.deviceId,
          businessType: bizType,
          extraHeaders: travelHeaders,
        },
      );
      if (!isBizSuccess(env)) {
        throw mapNinebotError(
          /** @type {string | number | undefined} */ (env.code),
          /** @type {string | undefined} */ (env.message ?? env.desc),
          '获取行程列表失败',
        );
      }
      const data = env.data && typeof env.data === 'object' ? /** @type {Record<string, unknown>} */ (env.data) : {};
      const rawList = Array.isArray(data.list) ? data.list : [];
      return { data, rawList };
    };

    const explicitPage = isNumericPage || typeof opts.page === 'number';
    const startPage = explicitPage && Number.isFinite(Number(opts.page))
      ? Math.max(1, Math.trunc(Number(opts.page)))
      : 1;
    const maxPages = explicitPage
      ? startPage
      : Math.max(1, Math.min(15, Number.isFinite(Number(opts.maxPages)) ? Math.trunc(Number(opts.maxPages)) : 15));

    let first = await fetchSinglePage(startPage, activeBizType);
    const firstTimes = pickNum(first.data.times, first.data.count) ?? 0;
    if (startPage === 1 && first.rawList.length === 0 && firstTimes === 0) {
      try {
        const alt = await fetchSinglePage(1, fallbackBizType);
        const altTimes = pickNum(alt.data.times, alt.data.count) ?? 0;
        if (alt.rawList.length > 0 || altTimes > 0) {
          activeBizType = fallbackBizType;
          first = alt;
        }
      } catch {
        // Keep primary empty response if fallback probe fails
      }
    }

    const firstData = first.data;
    const expectedTotal = pickNum(firstData.times, firstData.count) ?? 0;
    /** @type {Array<ReturnType<typeof normalizeTripRow> & {}>} */
    const trips = [];
    const seenIds = new Set();

    /**
     * @param {unknown[]} rawList
     * @returns {number}
     */
    const appendPage = (rawList) => {
      let added = 0;
      for (const item of rawList) {
        const norm = normalizeTripRow(item, monthYYYYMM);
        if (!norm || seenIds.has(norm.travelId)) continue;
        seenIds.add(norm.travelId);
        trips.push(norm);
        added += 1;
      }
      return added;
    };

    appendPage(first.rawList);
    let prevRawLen = first.rawList.length;

    if (!explicitPage) {
      for (let pageNum = 2; pageNum <= maxPages; pageNum++) {
        if (prevRawLen === 0 || expectedTotal <= seenIds.size) {
          break;
        }
        const nextPage = await fetchSinglePage(pageNum, activeBizType);
        prevRawLen = nextPage.rawList.length;
        const added = appendPage(nextPage.rawList);
        if (added === 0) {
          break;
        }
      }
    }

    return {
      month: monthYYYYMM,
      reportedCount: pickNum(firstData.times, firstData.count) ?? trips.length,
      reportedDistanceKm: pickNum(firstData.total_mileages, firstData.mileages),
      totalDurationSec: pickNum(firstData.duration) ?? 0,
      totalEnergyWh: pickNum(firstData.ec) ?? 0,
      trips,
    };
  }

  /**
   * Fetch single ride detail (`travel-info`).
   * @param {{ accessToken: string; businessUid?: string; deviceId: string }} session
   * @param {string} sn
   * @param {string} travelId
   * @param {{ businessLine?: 'motor' | 'ebike' }} [opts]
   */
  async function fetchTripDetail(session, sn, travelId, opts = {}) {
    const bizType = opts?.businessLine === 'ebike' ? '2' : '1';
    const env = await postEncrypted(
      hosts.travel,
      '/app-api/travel/v6/travel-info',
      [
        ['wnumber', sn],
        ['rnVersion', RN_VERSION],
        ['vehicle_type', VEHICLE_TYPE_TRAVEL],
        ['travel_id', travelId],
        ['current_version', APP_VERSION],
        ['serviceTime', nowFn()],
        ['nonce', genNonce()],
      ],
      {
        accessToken: session.accessToken,
        businessUid: session.businessUid,
        deviceId: session.deviceId,
        businessType: bizType,
        extraHeaders: buildTravelHeaders(session.accessToken),
      },
    );
    if (!isBizSuccess(env)) {
      throw mapNinebotError(
        /** @type {string | number | undefined} */ (env.code),
        /** @type {string | undefined} */ (env.message ?? env.desc),
        '获取行程详情失败',
      );
    }
    return env.data && typeof env.data === 'object' ? /** @type {Record<string, unknown>} */ (env.data) : {};
  }

  /**
   * Official Ninebot DeviceService backend (`NINEBOT_DEVICESERVICE_KEY`).
   * @param {string} apiKey
   */
  async function officialListVehicles(apiKey) {
    const res = await requester({
      method: 'GET',
      url: `${hosts.travel}/ai-skill/api/device/info/get-device-list`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      timeoutMs: DEFAULT_TIMEOUT_MS,
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new NinebotApiError(`官方 DeviceService Key 无效或已过期 (HTTP ${res.status})`, {
        httpStatus: res.status,
        isAuthError: true,
      });
    }
    if (res.status >= 400) {
      throw new NinebotApiError(`官方 DeviceService 请求失败 (HTTP ${res.status})`, { httpStatus: res.status });
    }
    const parsed = parseJsonResponse(res.body, 'Official get-device-list');
    if (parsed.code !== undefined && !isBizSuccess(parsed)) {
      throw mapNinebotError(
        /** @type {string | number | undefined} */ (parsed.code),
        /** @type {string | undefined} */ (parsed.msg ?? parsed.desc ?? parsed.message),
        '官方车辆列表获取失败',
      );
    }
    const items = Array.isArray(parsed.data) ? parsed.data : [];
    return items
      .filter(row => row && typeof row === 'object')
      .map(row => normalizeVehicleRecord(/** @type {Record<string, unknown>} */ (row), 'official'))
      .filter(Boolean);
  }

  /**
   * @param {string} apiKey
   * @param {string} sn
   * @param {Record<string, unknown> | null} [vehicleMeta]
   */
  async function officialFetchSnapshot(apiKey, sn, vehicleMeta = null) {
    const res = await requester({
      method: 'POST',
      url: `${hosts.travel}/ai-skill/api/device/info/get-device-dynamic-info`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ sn }),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new NinebotApiError(`官方 DeviceService Key 无效或已过期 (HTTP ${res.status})`, {
        httpStatus: res.status,
        isAuthError: true,
      });
    }
    if (res.status >= 400) {
      throw new NinebotApiError(`官方 DeviceService 请求失败 (HTTP ${res.status})`, { httpStatus: res.status });
    }
    const parsed = parseJsonResponse(res.body, 'Official get-device-dynamic-info');
    if (parsed.code !== undefined && !isBizSuccess(parsed)) {
      throw mapNinebotError(
        /** @type {string | number | undefined} */ (parsed.code),
        /** @type {string | undefined} */ (parsed.msg ?? parsed.desc ?? parsed.message),
        '官方车况获取失败',
      );
    }
    const data = parsed.data && typeof parsed.data === 'object' ? /** @type {Record<string, unknown>} */ (parsed.data) : {};
    return normalizeVehicleSnapshot({
      sn,
      vehicleMeta,
      official: data,
      backend: 'official',
      businessLine: 'official',
      capturedAt: nowFn(),
    });
  }

  /**
   * Optional AMap (Gaode) reverse geocoding for GCJ-02 coordinates.
   * Never throws on transient failure — returns null instead.
   * @param {number} gcjLat
   * @param {number} gcjLon
   * @param {string} amapKey
   * @returns {Promise<{ address: string; shortAddress: string; source: string } | null>}
   */
  async function reverseGeocodeAmap(gcjLat, gcjLon, amapKey) {
    if (!amapKey || !Number.isFinite(gcjLat) || !Number.isFinite(gcjLon)) return null;
    try {
      const loc = `${gcjLon.toFixed(6)},${gcjLat.toFixed(6)}`;
      const url = `${hosts.amap}?key=${encodeURIComponent(amapKey)}&location=${encodeURIComponent(loc)}&extensions=base&output=JSON`;
      const res = await requester({
        method: 'GET',
        url,
        headers: { Accept: 'application/json' },
        timeoutMs: 8_000,
        signal,
      });
      if (res.status !== 200) return null;
      const parsed = parseJsonResponse(res.body, 'AMap regeo');
      if (parsed.status !== '1') return null;
      const regeocode = parsed.regeocode && typeof parsed.regeocode === 'object'
        ? /** @type {Record<string, unknown>} */ (parsed.regeocode)
        : {};
      const fullAddress = pickStr(regeocode.formatted_address);
      if (!fullAddress) return null;
      const comp = regeocode.addressComponent && typeof regeocode.addressComponent === 'object'
        ? /** @type {Record<string, unknown>} */ (regeocode.addressComponent)
        : {};
      const streetNum = comp.streetNumber && typeof comp.streetNumber === 'object'
        ? /** @type {Record<string, unknown>} */ (comp.streetNumber)
        : {};
      const district = pickStr(comp.district) || '';
      const township = pickStr(comp.township) || '';
      const street = pickStr(streetNum.street) || '';
      const number = pickStr(streetNum.number) || '';
      const short = `${district}${township}${street}${number}`.trim() || fullAddress;
      return {
        address: fullAddress,
        shortAddress: short,
        source: 'amap',
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch an official Ninebot transparent PNG render after validating the URL allowlist and PNG header.
   * Never throws on failure — returns `null` when unavailable or invalid.
   * @param {string | null | undefined} urlStr
   * @returns {Promise<Buffer | null>}
   */
  async function fetchVehicleImagePng(urlStr) {
    const safeUrl = sanitizeNinebotImageUrl(urlStr);
    if (!safeUrl) return null;
    try {
      const res = await requester({
        method: 'GET',
        url: safeUrl,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'image/png,image/*;q=0.8',
        },
        timeoutMs: DEFAULT_TIMEOUT_MS,
        signal,
      });
      if (res.status !== 200 || !res.body) return null;
      const rawBody = /** @type {unknown} */ (res.body);
      const buf = Buffer.isBuffer(rawBody)
        ? rawBody
        : rawBody instanceof Uint8Array
          ? Buffer.from(rawBody)
          : null;
      if (!buf || buf.length < 64 || buf.length > MAX_VEHICLE_IMAGE_BYTES) {
        return null;
      }
      if (!buf.subarray(0, 8).equals(PNG_MAGIC)) {
        return null;
      }
      return buf;
    } catch {
      return null;
    }
  }

  return {
    passportLogin,
    passportRefresh,
    businessLogin,
    listVehicles,
    fetchVehicleSnapshotAccount,
    fetchTrips,
    fetchTripDetail,
    officialListVehicles,
    officialFetchSnapshot,
    reverseGeocodeAmap,
    fetchVehicleImagePng,
  };
}

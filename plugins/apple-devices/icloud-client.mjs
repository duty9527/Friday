import { createHash, randomUUID } from 'node:crypto';
import { completeSrpClientChallenge, createSrpClientEphemeral } from './icloud-srp.mjs';

export const APPLE_WIDGET_KEY = 'd39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

export class AppleClientError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   * @param {number} [status]
   */
  constructor(message, code = 'APPLE_API_ERROR', status) {
    super(message);
    this.name = 'AppleClientError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Resolve Apple IDMSa & iCloud regional endpoints.
 * Defaults to China mainland (`cn` / GCBD `.com.cn`).
 * @param {string} [region]
 * @returns {{ region: 'cn' | 'global'; authOrigin: string; authBase: string; homeOrigin: string; setupBase: string }}
 */
export function resolveRegionEndpoints(region = 'cn') {
  const normalized = String(region ?? 'cn').trim().toLowerCase();
  if (normalized === 'global' || normalized === 'us' || normalized === 'intl') {
    return {
      region: 'global',
      authOrigin: 'https://idmsa.apple.com',
      authBase: 'https://idmsa.apple.com/appleauth/auth',
      homeOrigin: 'https://www.icloud.com',
      setupBase: 'https://setup.icloud.com/setup/ws/1',
    };
  }
  return {
    region: 'cn',
    authOrigin: 'https://idmsa.apple.com.cn',
    authBase: 'https://idmsa.apple.com.cn/appleauth/auth',
    homeOrigin: 'https://www.icloud.com.cn',
    setupBase: 'https://setup.icloud.com.cn/setup/ws/1',
  };
}

/**
 * Validate Apple Find My node URL against strict `.icloud.com` / `.icloud.com.cn` HTTPS origin rules.
 * @param {unknown} rawUrl
 * @returns {string}
 */
export function validateFindMeUrl(rawUrl) {
  const candidate = String(rawUrl ?? '').trim();
  if (!candidate) {
    throw new AppleClientError('iCloud 会话未返回 Find My 服务地址 (webservices.findme.url)', 'MISSING_FINDME_URL');
  }
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new AppleClientError('Find My 服务地址格式无效', 'INVALID_FINDME_URL');
  }
  const host = parsed.hostname.toLowerCase();
  const allowedHost = host === 'icloud.com'
    || host === 'icloud.com.cn'
    || host.endsWith('.icloud.com')
    || host.endsWith('.icloud.com.cn');
  if (parsed.protocol !== 'https:' || !allowedHost) {
    throw new AppleClientError(`拒绝非 iCloud 官方域名: ${host}`, 'UNTRUSTED_FINDME_URL');
  }
  return parsed.origin;
}

/**
 * Split a combined `Set-Cookie` header string safely without breaking `Expires=Wed, ...` dates.
 * @param {string} headerValue
 * @returns {string[]}
 */
export function splitSetCookieHeader(headerValue) {
  if (!headerValue) return [];
  const parts = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < headerValue.length; i += 1) {
    const slice = headerValue.slice(i, i + 8).toLowerCase();
    if (slice === 'expires=') {
      inExpires = true;
    } else if (inExpires && headerValue[i] === ';') {
      inExpires = false;
    } else if (!inExpires && headerValue[i] === ',') {
      const candidate = headerValue.slice(start, i).trim();
      if (candidate) parts.push(candidate);
      start = i + 1;
    }
  }
  const tail = headerValue.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

/**
 * Extract `Set-Cookie` lines from Web Fetch `Headers` (or plain object/mock headers).
 * @param {Headers | Record<string, unknown> | undefined} headers
 * @returns {string[]}
 */
export function extractSetCookies(headers) {
  if (!headers) return [];
  const anyHeaders = /** @type {{ getSetCookie?: () => string[]; get?: (k: string) => string | null; ['set-cookie']?: unknown }} */ (headers);
  if (typeof anyHeaders.getSetCookie === 'function') {
    const list = anyHeaders.getSetCookie();
    if (Array.isArray(list) && list.length > 0) return list;
  }
  if (typeof anyHeaders.get === 'function') {
    const combined = anyHeaders.get('set-cookie');
    return combined ? splitSetCookieHeader(combined) : [];
  }
  const raw = anyHeaders['set-cookie'];
  if (Array.isArray(raw)) return raw.map(v => String(v));
  if (typeof raw === 'string') return splitSetCookieHeader(raw);
  return [];
}

/**
 * Merge `Set-Cookie` directives into a plain `name -> value` cookie jar object.
 * @param {Record<string, string> | undefined} existing
 * @param {string[]} setCookies
 * @returns {Record<string, string>}
 */
export function mergeCookies(existing, setCookies) {
  const jar = { ...(existing && typeof existing === 'object' ? existing : {}) };
  for (const line of setCookies) {
    const segments = String(line).split(';');
    const first = segments[0]?.trim() ?? '';
    const eqIdx = first.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = first.slice(0, eqIdx).trim();
    const value = first.slice(eqIdx + 1).trim();
    const expired = segments.slice(1).some(attr => /^max-age\s*=\s*0$/i.test(attr.trim()));
    if (!value || value === '""' || expired) {
      delete jar[name];
    } else {
      jar[name] = value;
    }
  }
  return jar;
}

/**
 * @param {Record<string, string> | undefined} jar
 * @returns {string}
 */
export function serializeCookies(jar) {
  if (!jar || typeof jar !== 'object') return '';
  return Object.entries(jar)
    .filter(([k, v]) => k && typeof v === 'string' && v.length > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * Case-insensitive header lookup for both Fetch `Headers` and plain objects.
 * @param {Headers | Record<string, unknown> | undefined} headers
 * @param {string} name
 * @returns {string}
 */
function readHeader(headers, name) {
  if (!headers) return '';
  const anyHeaders = /** @type {{ get?: (k: string) => string | null } & Record<string, unknown>} */ (headers);
  if (typeof anyHeaders.get === 'function') {
    return String(anyHeaders.get(name) ?? '').trim();
  }
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(anyHeaders)) {
    if (k.toLowerCase() === target && v !== undefined && v !== null) {
      return String(v).trim();
    }
  }
  return '';
}

/**
 * @param {string} raw
 * @returns {any}
 */
function safeJsonParse(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * @param {any} data
 * @param {string} fallback
 * @returns {string}
 */
function extractAppleServiceError(data, fallback) {
  if (data && typeof data === 'object') {
    const list = Array.isArray(data.serviceErrors) ? data.serviceErrors : [];
    if (list.length > 0 && list[0]?.message) {
      return String(list[0].message);
    }
    if (typeof data.error === 'string' && data.error.trim()) {
      return data.error.trim();
    }
    if (typeof data.reason === 'string' && data.reason.trim()) {
      return data.reason.trim();
    }
  }
  return fallback;
}

/**
 * Build standard Apple IDMSa authentication headers.
 * @param {{ authOrigin: string; homeOrigin: string }} endpoints
 * @param {Record<string, unknown>} session
 * @returns {Record<string, string>}
 */
function buildIdmsaHeaders(endpoints, session) {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: endpoints.authOrigin,
    Referer: `${endpoints.authOrigin}/`,
    'User-Agent': DEFAULT_USER_AGENT,
    'X-Apple-Widget-Key': APPLE_WIDGET_KEY,
    'X-Apple-OAuth-Client-Id': APPLE_WIDGET_KEY,
    'X-Apple-OAuth-Client-Type': 'firstPartyAuth',
    'X-Apple-OAuth-Redirect-URI': endpoints.homeOrigin,
    'X-Apple-OAuth-Response-Mode': 'web_message',
    'X-Apple-OAuth-Response-Type': 'code',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (typeof session.clientId === 'string' && session.clientId) {
    headers['X-Apple-OAuth-State'] = session.clientId;
  }
  if (typeof session.scnt === 'string' && session.scnt) {
    headers.scnt = session.scnt;
  }
  if (typeof session.appleSessionId === 'string' && session.appleSessionId) {
    headers['X-Apple-ID-Session-Id'] = session.appleSessionId;
  }
  const cookieStr = serializeCookies(/** @type {Record<string, string> | undefined} */ (session.cookies));
  if (cookieStr) {
    headers.Cookie = cookieStr;
  }
  return headers;
}

/**
 * Build iCloud web-service (`setup` & `fmipservice`) headers.
 * @param {{ homeOrigin: string }} endpoints
 * @param {Record<string, unknown>} session
 * @returns {Record<string, string>}
 */
function buildIcloudHeaders(endpoints, session) {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: endpoints.homeOrigin,
    Referer: `${endpoints.homeOrigin}/`,
    'User-Agent': DEFAULT_USER_AGENT,
  };
  const cookieStr = serializeCookies(/** @type {Record<string, string> | undefined} */ (session.cookies));
  if (cookieStr) {
    headers.Cookie = cookieStr;
  }
  return headers;
}

/**
 * Perform HTTP JSON request with timeout + AbortSignal propagation + cookie/header capture.
 * @param {typeof fetch} fetchFn
 * @param {string} url
 * @param {{
 *   method?: string;
 *   headers?: Record<string, string>;
 *   body?: unknown;
 *   signal?: AbortSignal;
 *   timeoutMs?: number;
 * }} options
 */
async function httpJson(fetchFn, url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const controller = new AbortController();
  let timer;
  let onParentAbort;
  if (options.signal) {
    if (options.signal.aborted) {
      throw options.signal.reason ?? new Error('Request aborted');
    }
    onParentAbort = () => controller.abort(options.signal?.reason);
    options.signal.addEventListener('abort', onParentAbort, { once: true });
  }
  timer = setTimeout(() => controller.abort(new Error(`iCloud HTTP request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: options.method ?? 'POST',
      headers: options.headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const textBody = await res.text();
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      data: safeJsonParse(textBody),
      rawText: textBody,
      setCookies: extractSetCookies(res.headers),
    };
  } finally {
    clearTimeout(timer);
    if (options.signal && onParentAbort) {
      options.signal.removeEventListener('abort', onParentAbort);
    }
  }
}

/**
 * Capture rotating Apple session headers & cookies into session object.
 * @param {Record<string, any>} session
 * @param {Headers | Record<string, unknown> | undefined} headers
 * @param {string[]} setCookies
 */
function absorbAuthResponse(session, headers, setCookies) {
  const scnt = readHeader(headers, 'scnt');
  const appleSessionId = readHeader(headers, 'x-apple-id-session-id');
  const sessionToken = readHeader(headers, 'x-apple-session-token');
  const trustToken = readHeader(headers, 'x-apple-twosv-trust-token');
  const accountCountry = readHeader(headers, 'x-apple-id-account-country');
  if (scnt) session.scnt = scnt;
  if (appleSessionId) session.appleSessionId = appleSessionId;
  if (sessionToken) session.sessionToken = sessionToken;
  if (trustToken) session.trustToken = trustToken;
  if (accountCountry) session.accountCountry = accountCountry;
  session.cookies = mergeCookies(session.cookies, setCookies);
}

/**
 * Exchange `sessionToken` + optional `trustToken` at `/setup/ws/1/accountLogin` to obtain
 * `findme` regional host URL and iCloud webauth cookies.
 * @param {{
 *   session: Record<string, any>;
 *   fetchFn?: typeof fetch;
 *   signal?: AbortSignal;
 * }} params
 */
export async function completeAccountLogin({ session, fetchFn = fetch, signal }) {
  const endpoints = resolveRegionEndpoints(session.region);
  if (!session.sessionToken) {
    throw new AppleClientError('缺少 X-Apple-Session-Token，无法完成 iCloud 登录', 'AUTH_EXPIRED', 401);
  }
  const url = `${endpoints.setupBase}/accountLogin?clientBuildNumber=2510Project50&clientMasteringNumber=2510B20&clientId=${encodeURIComponent(session.clientId || randomUUID())}`;
  const resp = await httpJson(fetchFn, url, {
    method: 'POST',
    headers: buildIcloudHeaders(endpoints, session),
    body: {
      apple_id: session.appleId,
      dsWebAuthToken: session.sessionToken,
      ...(session.trustToken ? { trustToken: session.trustToken } : {}),
      extended_login: true,
    },
    signal,
  });
  session.cookies = mergeCookies(session.cookies, resp.setCookies);
  if (!resp.ok) {
    const code = resp.status === 401 || resp.status === 450 || resp.status === 421 ? 'AUTH_EXPIRED' : 'SETUP_LOGIN_FAILED';
    throw new AppleClientError(
      extractAppleServiceError(resp.data, `iCloud 会话建权失败 (HTTP ${resp.status})`),
      code,
      resp.status,
    );
  }
  const rawFindme = resp.data?.webservices?.findme?.url;
  const findmeUrl = validateFindMeUrl(rawFindme);
  session.findmeUrl = findmeUrl;
  session.state = 'authenticated';
  session.authenticatedAt = Date.now();
  session.trustedPhones = undefined;
  return session;
}

/**
 * Inspect trusted phone numbers available for SMS 2FA fallback.
 * @param {{
 *   session: Record<string, any>;
 *   fetchFn?: typeof fetch;
 *   signal?: AbortSignal;
 * }} params
 */
async function fetchTrustedPhones({ session, fetchFn = fetch, signal }) {
  const endpoints = resolveRegionEndpoints(session.region);
  try {
    const resp = await httpJson(fetchFn, endpoints.authBase, {
      method: 'GET',
      headers: buildIdmsaHeaders(endpoints, session),
      signal,
    });
    absorbAuthResponse(session, resp.headers, resp.setCookies);
    const list = Array.isArray(resp.data?.trustedPhoneNumbers) ? resp.data.trustedPhoneNumbers : [];
    return list
      .filter(p => p && typeof p.id === 'number')
      .map(p => ({
        id: p.id,
        numberWithDialCode: String(p.numberWithDialCode ?? ''),
        pushMode: String(p.pushMode ?? 'sms'),
      }));
  } catch {
    return [];
  }
}

/**
 * Initiate Apple ID SRP-6a authentication against China mainland or global IDMSa endpoints.
 * Password is used strictly in-memory to compute the SRP proof and is never persisted.
 * @param {{
 *   appleId: string;
 *   password: string;
 *   region?: string;
 *   existingTrustToken?: string;
 *   clientId?: string;
 *   fetchFn?: typeof fetch;
 *   signal?: AbortSignal;
 * }} params
 */
export async function startAppleLogin({
  appleId,
  password,
  region = 'cn',
  existingTrustToken,
  clientId,
  fetchFn = fetch,
  signal,
}) {
  const cleanId = String(appleId ?? '').trim();
  const cleanPass = String(password ?? '');
  if (!cleanId || !cleanPass) {
    throw new AppleClientError('请输入 Apple ID 账号与密码', 'INVALID_CREDENTIALS');
  }
  const endpoints = resolveRegionEndpoints(region);
  const resolvedClientId = String(clientId || `auth-${randomUUID()}`);
  const session = /** @type {Record<string, any>} */ ({
    region: endpoints.region,
    appleId: cleanId,
    clientId: resolvedClientId,
    cookies: {},
    ...(existingTrustToken ? { trustToken: existingTrustToken } : {}),
  });

  const { aHex, aBase64 } = createSrpClientEphemeral();
  const initResp = await httpJson(fetchFn, `${endpoints.authBase}/signin/init`, {
    method: 'POST',
    headers: buildIdmsaHeaders(endpoints, session),
    body: {
      a: aBase64,
      accountName: cleanId,
      protocols: ['s2k', 's2k_fo'],
    },
    signal,
  });
  absorbAuthResponse(session, initResp.headers, initResp.setCookies);

  if (initResp.status === 429 || initResp.status === 503) {
    throw new AppleClientError('苹果认证服务当前限流或不可用 (HTTP ' + initResp.status + ')，请稍后再试', 'RATE_LIMITED', initResp.status);
  }
  if (!initResp.ok) {
    throw new AppleClientError(
      extractAppleServiceError(initResp.data, `初始化 SRP 登录失败 (HTTP ${initResp.status})`),
      'SRP_INIT_FAILED',
      initResp.status,
    );
  }

  const protocol = initResp.data?.protocol === 's2k' ? 's2k' : initResp.data?.protocol === 's2k_fo' ? 's2k_fo' : '';
  const saltBase64 = String(initResp.data?.salt ?? '');
  const bBase64 = String(initResp.data?.b ?? '');
  const iterations = Number(initResp.data?.iteration ?? 0);
  const cToken = String(initResp.data?.c ?? '');

  if (!protocol || !saltBase64 || !bBase64 || !Number.isInteger(iterations) || iterations < 1 || !cToken) {
    throw new AppleClientError('苹果服务器返回的 SRP 参数不完整或不支持的协议', 'INVALID_SRP_CHALLENGE', initResp.status);
  }

  const { m1Base64, m2Base64 } = completeSrpClientChallenge({
    accountName: cleanId,
    password: cleanPass,
    aHex,
    saltBase64,
    bBase64,
    iterations,
    protocol,
  });

  const completeResp = await httpJson(fetchFn, `${endpoints.authBase}/signin/complete?isRememberMeEnabled=true`, {
    method: 'POST',
    headers: buildIdmsaHeaders(endpoints, session),
    body: {
      accountName: cleanId,
      rememberMe: true,
      trustTokens: existingTrustToken ? [existingTrustToken] : [],
      m1: m1Base64,
      m2: m2Base64,
      c: cToken,
    },
    signal,
  });
  absorbAuthResponse(session, completeResp.headers, completeResp.setCookies);

  if (completeResp.status === 200) {
    await completeAccountLogin({ session, fetchFn, signal });
    return session;
  }

  if (completeResp.status === 409) {
    session.state = 'pending_2fa';
    session.pending2faAt = Date.now();
    session.trustedPhones = await fetchTrustedPhones({ session, fetchFn, signal });
    return session;
  }

  if (completeResp.status === 401 || completeResp.status === 403) {
    throw new AppleClientError(
      'Apple ID 或密码不正确（注意 Find My 必须使用 Apple ID 主密码，不能使用 App 专用密码）',
      'INVALID_CREDENTIALS',
      completeResp.status,
    );
  }
  if (completeResp.status === 412) {
    throw new AppleClientError(
      '账号需要先在苹果官网或设备上确认隐私条款/安全提示后才能登录',
      'PRECONDITION_REQUIRED',
      412,
    );
  }
  if (completeResp.status === 429 || completeResp.status === 503) {
    throw new AppleClientError(
      `苹果认证服务当前限流或繁忙 (HTTP ${completeResp.status})，请稍后重试`,
      'RATE_LIMITED',
      completeResp.status,
    );
  }
  throw new AppleClientError(
    extractAppleServiceError(completeResp.data, `SRP 校验失败 (HTTP ${completeResp.status})`),
    'SRP_COMPLETE_FAILED',
    completeResp.status,
  );
}

/**
 * Trigger an SMS 2FA code to a trusted phone number when trusted device push isn't convenient.
 * @param {{
 *   session: Record<string, any>;
 *   phoneId?: number;
 *   fetchFn?: typeof fetch;
 *   signal?: AbortSignal;
 * }} params
 */
export async function requestSmsCode({ session, phoneId, fetchFn = fetch, signal }) {
  if (!session || session.state !== 'pending_2fa') {
    throw new AppleClientError('当前不在等待 2FA 验证状态，请先执行 auth-login', 'NOT_PENDING_2FA');
  }
  const endpoints = resolveRegionEndpoints(session.region);
  const targetPhoneId = Number.isInteger(phoneId) && Number(phoneId) > 0
    ? Number(phoneId)
    : (session.trustedPhones?.[0]?.id ?? 1);
  const resp = await httpJson(fetchFn, `${endpoints.authBase}/verify/phone`, {
    method: 'PUT',
    headers: buildIdmsaHeaders(endpoints, session),
    body: {
      phoneNumber: { id: targetPhoneId },
      mode: 'sms',
    },
    signal,
  });
  absorbAuthResponse(session, resp.headers, resp.setCookies);
  if (!resp.ok) {
    throw new AppleClientError(
      extractAppleServiceError(resp.data, `发送短信验证码失败 (HTTP ${resp.status})`),
      'SMS_SEND_FAILED',
      resp.status,
    );
  }
  session.lastSmsPhoneId = targetPhoneId;
  return session;
}

/**
 * Submit 6-digit 2FA verification code, establish trust (`/2sv/trust`), and complete `/accountLogin`.
 * @param {{
 *   session: Record<string, any>;
 *   code: string;
 *   mode?: 'trusted_device' | 'sms';
 *   phoneId?: number;
 *   fetchFn?: typeof fetch;
 *   signal?: AbortSignal;
 * }} params
 */
export async function verify2faCode({
  session,
  code,
  mode = 'trusted_device',
  phoneId,
  fetchFn = fetch,
  signal,
}) {
  if (!session || session.state !== 'pending_2fa') {
    throw new AppleClientError('当前没有待验证的 2FA 登录会话，请先使用账号密码发起登录', 'NOT_PENDING_2FA');
  }
  const cleanCode = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleanCode)) {
    throw new AppleClientError('请输入 6 位数字双重认证验证码', 'INVALID_2FA_FORMAT');
  }
  const endpoints = resolveRegionEndpoints(session.region);
  const isSms = mode === 'sms';
  const targetPhoneId = Number.isInteger(phoneId) && Number(phoneId) > 0
    ? Number(phoneId)
    : (session.lastSmsPhoneId ?? session.trustedPhones?.[0]?.id ?? 1);
  const verifyUrl = isSms
    ? `${endpoints.authBase}/verify/phone/securitycode`
    : `${endpoints.authBase}/verify/trusteddevice/securitycode`;
  const verifyBody = isSms
    ? { securityCode: { code: cleanCode }, phoneNumber: { id: targetPhoneId }, mode: 'sms' }
    : { securityCode: { code: cleanCode } };

  const verifyResp = await httpJson(fetchFn, verifyUrl, {
    method: 'POST',
    headers: buildIdmsaHeaders(endpoints, session),
    body: verifyBody,
    signal,
  });
  absorbAuthResponse(session, verifyResp.headers, verifyResp.setCookies);

  if (!verifyResp.ok) {
    const invalidCode = verifyResp.status === 400 || verifyResp.status === 401 || verifyResp.status === 422;
    throw new AppleClientError(
      invalidCode ? '双重认证验证码无效或已过期，请核对后重试' : extractAppleServiceError(verifyResp.data, `2FA 验证失败 (HTTP ${verifyResp.status})`),
      invalidCode ? 'INVALID_2FA_CODE' : 'TWO_FA_FAILED',
      verifyResp.status,
    );
  }

  const trustResp = await httpJson(fetchFn, `${endpoints.authBase}/2sv/trust`, {
    method: 'GET',
    headers: buildIdmsaHeaders(endpoints, session),
    signal,
  });
  absorbAuthResponse(session, trustResp.headers, trustResp.setCookies);
  if (!trustResp.ok) {
    throw new AppleClientError(
      extractAppleServiceError(trustResp.data, `建立受信任会话失败 (HTTP ${trustResp.status})`),
      'TRUST_FAILED',
      trustResp.status,
    );
  }

  await completeAccountLogin({ session, fetchFn, signal });
  return session;
}

/**
 * Normalize an Apple FMiP device entry, computing a stable redacted `id` (`dev_<hash>`).
 * @param {any} raw
 */
export function normalizeFmipDevice(raw) {
  const rawId = String(raw?.id ?? '');
  if (!rawId) return undefined;
  const redactedId = `dev_${createHash('sha256').update(rawId).digest('hex').slice(0, 12)}`;
  const deviceClass = String(raw?.deviceClass ?? '').trim();
  const deviceModel = String(raw?.deviceModel ?? '').trim();
  const rawDeviceModel = String(raw?.rawDeviceModel ?? '').trim();
  const displayName = String(raw?.deviceDisplayName ?? rawDeviceModel ?? deviceClass ?? 'Apple Device').trim();
  const name = String(raw?.name ?? displayName).trim();

  const probe = `${deviceClass} ${deviceModel} ${rawDeviceModel} ${displayName}`.toLowerCase();
  /** @type {'iphone' | 'ipad' | 'mac' | 'watch' | 'airpods' | 'other'} */
  let category = 'other';
  if (probe.includes('iphone')) category = 'iphone';
  else if (probe.includes('ipad')) category = 'ipad';
  else if (probe.includes('watch')) category = 'watch';
  else if (probe.includes('airpods') || probe.includes('audio')) category = 'airpods';
  else if (probe.includes('mac') || probe.includes('imac') || probe.includes('book')) category = 'mac';

  const rawStatusStr = String(raw?.batteryStatus ?? 'Unknown').trim();
  const batteryStatus = ['Charging', 'NotCharging', 'Charged', 'Unknown'].includes(rawStatusStr)
    ? rawStatusStr
    : 'Unknown';

  const rawLevel = raw?.batteryLevel;
  let batteryPercent = /** @type {number | null} */ (null);
  if (typeof rawLevel === 'number' && Number.isFinite(rawLevel) && !(rawLevel === 0 && batteryStatus === 'Unknown')) {
    const pct = rawLevel > 1 ? rawLevel : rawLevel * 100;
    batteryPercent = Math.round(Math.max(0, Math.min(100, pct)));
  }

  const deviceStatusCode = String(raw?.deviceStatus ?? '');
  const online = deviceStatusCode === '200';
  const deviceStatus = deviceStatusCode === '200'
    ? 'online'
    : deviceStatusCode === '201'
      ? 'offline'
      : deviceStatusCode === '203'
        ? 'pending'
        : deviceStatusCode === '204'
          ? 'unregistered'
          : (deviceStatusCode || 'unknown');

  const rawLoc = raw?.location && typeof raw.location === 'object' ? raw.location : null;
  const lat = rawLoc && typeof rawLoc.latitude === 'number' && Number.isFinite(rawLoc.latitude) ? rawLoc.latitude : null;
  const lng = rawLoc && typeof rawLoc.longitude === 'number' && Number.isFinite(rawLoc.longitude) ? rawLoc.longitude : null;
  const location = lat !== null && lng !== null
    ? {
        latitude: Number(lat.toFixed(6)),
        longitude: Number(lng.toFixed(6)),
        horizontalAccuracy: typeof rawLoc.horizontalAccuracy === 'number' && Number.isFinite(rawLoc.horizontalAccuracy)
          ? Math.round(rawLoc.horizontalAccuracy)
          : null,
        positionType: typeof rawLoc.positionType === 'string' ? rawLoc.positionType : null,
        timestamp: typeof rawLoc.timeStamp === 'number' && Number.isFinite(rawLoc.timeStamp) ? rawLoc.timeStamp : null,
        isOld: Boolean(rawLoc.isOld),
      }
    : null;

  return {
    rawId,
    device: {
      id: redactedId,
      name,
      displayName,
      model: rawDeviceModel || deviceModel || displayName,
      category,
      online,
      deviceStatus,
      batteryPercent,
      batteryStatus,
      lowPowerMode: Boolean(raw?.lowPowerMode),
      lostModeCapable: Boolean(raw?.lostModeCapable),
      isLocating: Boolean(raw?.isLocating),
      location,
    },
  };
}

/**
 * Call an FMiP endpoint with automatic 1-time `accountLogin` renewal on `401` / `450`.
 * @param {{
 *   session: Record<string, any>;
 *   path: string;
 *   body: Record<string, unknown>;
 *   fetchFn?: typeof fetch;
 *   signal?: AbortSignal;
 * }} params
 */
async function postFmipWithRefresh({ session, path, body, fetchFn = fetch, signal }) {
  if (!session || session.state !== 'authenticated' || !session.findmeUrl) {
    throw new AppleClientError('尚未登录或尚未完成 2FA 验证，请先绑定 Apple ID', 'NOT_AUTHENTICATED', 401);
  }
  const endpoints = resolveRegionEndpoints(session.region);
  const makeCall = async () => {
    const base = validateFindMeUrl(session.findmeUrl);
    return httpJson(fetchFn, `${base}${path}`, {
      method: 'POST',
      headers: buildIcloudHeaders(endpoints, session),
      body,
      signal,
    });
  };

  let resp = await makeCall();
  session.cookies = mergeCookies(session.cookies, resp.setCookies);

  if ((resp.status === 401 || resp.status === 450) && session.sessionToken && session.trustToken) {
    await completeAccountLogin({ session, fetchFn, signal });
    resp = await makeCall();
    session.cookies = mergeCookies(session.cookies, resp.setCookies);
  }

  if (resp.status === 401 || resp.status === 450) {
    session.state = 'expired';
    throw new AppleClientError(
      'Apple 会话已过期（约 30～60 天需重新完成一次 2FA 授权），请重新登录绑定',
      'AUTH_EXPIRED',
      resp.status,
    );
  }
  if (!resp.ok) {
    throw new AppleClientError(
      extractAppleServiceError(resp.data, `iCloud Find My 请求失败 (HTTP ${resp.status})`),
      'FMIP_REQUEST_FAILED',
      resp.status,
    );
  }
  return resp.data;
}

/**
 * Fetch and normalize Find My devices via `/fmipservice/client/web/refreshClient`.
 * @param {{
 *   session: Record<string, any>;
 *   fetchFn?: typeof fetch;
 *   signal?: AbortSignal;
 * }} params
 */
export async function fetchFindMyDevices({ session, fetchFn = fetch, signal }) {
  const payload = await postFmipWithRefresh({
    session,
    path: '/fmipservice/client/web/refreshClient',
    body: {
      clientContext: {
        appName: 'iCloud Find (Web)',
        appVersion: '2.0',
        timezone: 'Asia/Shanghai',
        inactiveTime: 1,
        apiVersion: '3.0',
        fmly: false,
      },
    },
    fetchFn,
    signal,
  });

  const content = Array.isArray(payload?.content) ? payload.content : [];
  const entries = [];
  for (const item of content) {
    const normalized = normalizeFmipDevice(item);
    if (normalized) entries.push(normalized);
  }
  return {
    fetchedAt: Date.now(),
    serverTimestamp: typeof payload?.serverContext?.serverTimestamp === 'number' ? payload.serverContext.serverTimestamp : null,
    entries,
  };
}

/**
 * Trigger remote loud sound alert on a specific device via `/fmipservice/client/web/playSound`.
 * @param {{
 *   session: Record<string, any>;
 *   rawDeviceId: string;
 *   subject?: string;
 *   fetchFn?: typeof fetch;
 *   signal?: AbortSignal;
 * }} params
 */
export async function playFindMySound({ session, rawDeviceId, subject, fetchFn = fetch, signal }) {
  if (!rawDeviceId) {
    throw new AppleClientError('缺少目标设备内部 ID，请先刷新设备列表', 'MISSING_DEVICE_ID');
  }
  const payload = await postFmipWithRefresh({
    session,
    path: '/fmipservice/client/web/playSound',
    body: {
      device: rawDeviceId,
      subject: String(subject || 'F.R.I.D.A.Y. 查找设备提醒').trim().slice(0, 120),
    },
    fetchFn,
    signal,
  });
  return {
    statusCode: String(payload?.statusCode ?? '200'),
    ok: true,
  };
}

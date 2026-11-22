import { createHash, randomUUID } from 'node:crypto';
import { completeSrpClientChallenge, createSrpClientEphemeral } from './icloud-srp.mjs';

export const APPLE_WIDGET_KEY = 'd39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15';
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AppleClientError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   * @param {number} [status]
   * @param {string} [stage]
   */
  constructor(message, code = 'APPLE_API_ERROR', status, stage) {
    super(message);
    this.name = 'AppleClientError';
    this.code = code;
    this.status = status;
    this.stage = stage;
  }
}

const WEBAUTH_COOKIE_KEYS = [
  'X-APPLE-WEBAUTH-TOKEN',
  'X-APPLE-WEBAUTH-VALIDATE',
  'X-APPLE-WEBAUTH-LOGIN',
];

/**
 * Return true when session cookies contain a live Apple WebAuth cookie suitable for `/setup/ws/1/validate`.
 * @param {unknown} cookies
 * @returns {boolean}
 */
function hasWebAuthCookies(cookies) {
  if (!cookies || typeof cookies !== 'object' || Array.isArray(cookies)) return false;
  const jar = /** @type {Record<string, unknown>} */ (cookies);
  return WEBAUTH_COOKIE_KEYS.some(k => typeof jar[k] === 'string' && jar[k].trim().length > 0);
}

/**
 * Resolve Apple IDMSa & iCloud regional endpoints.
 * Apple ID authentication always targets `https://idmsa.apple.com`, while
 * China mainland (`cn` / GCBD) routes home & setup/services via `.icloud.com.cn`.
 * @param {string} [region]
 * @returns {{ region: 'cn' | 'global'; authOrigin: string; authBase: string; homeOrigin: string; setupBase: string }}
 */
export function resolveRegionEndpoints(region = 'cn') {
  const normalized = String(region ?? 'cn').trim().toLowerCase();
  const isGlobal = normalized === 'global' || normalized === 'us' || normalized === 'intl';
  const suffix = isGlobal ? '' : '.cn';
  return {
    region: isGlobal ? 'global' : 'cn',
    authOrigin: 'https://idmsa.apple.com',
    authBase: 'https://idmsa.apple.com/appleauth/auth',
    homeOrigin: `https://www.icloud.com${suffix}`,
    setupBase: `https://setup.icloud.com${suffix}/setup/ws/1`,
  };
}

/**
 * Normalize clientId into a standard lowercase UUID expected by Apple's `frame_id` / `X-Apple-OAuth-State`.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeClientId(raw) {
  const s = String(raw ?? '').trim();
  if (UUID_RE.test(s)) return s.toLowerCase();
  return randomUUID().toLowerCase();
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
    } else if (inExpires && headerValue[i] === ',') {
      // HTTP-date in Expires contains at most one comma (after weekday); reset so a following cookie is not swallowed.
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
      const codePrefix = list[0]?.code !== undefined ? `[${list[0].code}] ` : '';
      return `${codePrefix}${String(list[0].message)}`;
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
 * Build Apple IDMSa authentication headers aligned with upstream `pyicloud`.
 * @param {{ authOrigin: string; homeOrigin: string }} endpoints
 * @param {Record<string, unknown>} session
 * @param {Record<string, string>} [overrides]
 * @returns {Record<string, string>}
 */
function buildIdmsaHeaders(endpoints, session, overrides = {}) {
  const clientId = normalizeClientId(session.clientId);
  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'application/json, text/javascript',
    'Content-Type': 'application/json',
    Origin: endpoints.homeOrigin,
    Referer: endpoints.authOrigin,
    'User-Agent': DEFAULT_USER_AGENT,
    'X-Apple-OAuth-Client-Id': APPLE_WIDGET_KEY,
    'X-Apple-OAuth-Client-Type': 'firstPartyAuth',
    'X-Apple-OAuth-Redirect-URI': endpoints.homeOrigin,
    'X-Apple-OAuth-Require-Grant-Code': 'true',
    'X-Apple-OAuth-Response-Mode': 'web_message',
    'X-Apple-OAuth-Response-Type': 'code',
    'X-Apple-OAuth-State': clientId,
    'X-Apple-Frame-Id': clientId,
    'X-Apple-Widget-Key': APPLE_WIDGET_KEY,
    'X-Apple-FD-Client-Info': JSON.stringify({
      U: DEFAULT_USER_AGENT,
      L: 'en-US',
      Z: 'GMT+00:00',
      V: '1.1',
      F: '',
    }),
  };
  if (typeof session.scnt === 'string' && session.scnt) {
    headers.scnt = session.scnt;
  }
  if (typeof session.appleSessionId === 'string' && session.appleSessionId) {
    headers['X-Apple-ID-Session-Id'] = session.appleSessionId;
  }
  if (typeof session.authAttributes === 'string' && session.authAttributes) {
    headers['X-Apple-Auth-Attributes'] = session.authAttributes;
  }
  const cookieStr = serializeCookies(/** @type {Record<string, string> | undefined} */ (session.cookies));
  if (cookieStr) {
    headers.Cookie = cookieStr;
  }
  return { ...headers, ...overrides };
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
 * Build standard iCloud setup/FMiP query parameters (`clientBuildNumber`, `clientMasteringNumber`, `clientId`, optional `dsid`).
 * @param {Record<string, any>} session
 * @returns {string}
 */
function buildSetupQuery(session) {
  const params = new URLSearchParams({
    clientBuildNumber: '2534Project66',
    clientMasteringNumber: '2534B22',
    clientId: normalizeClientId(session.clientId),
  });
  if (session.dsid) {
    params.set('dsid', String(session.dsid));
  }
  return params.toString();
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
  const authAttributes = readHeader(headers, 'x-apple-auth-attributes');
  if (scnt) session.scnt = scnt;
  if (appleSessionId) session.appleSessionId = appleSessionId;
  if (sessionToken) session.sessionToken = sessionToken;
  if (trustToken) session.trustToken = trustToken;
  if (accountCountry) session.accountCountry = accountCountry;
  if (authAttributes) session.authAttributes = authAttributes;
  session.cookies = mergeCookies(session.cookies, setCookies);
}

/**
 * Validate and refresh existing iCloud WebAuth cookies via `/setup/ws/1/validate`.
 * Allows long-lived sessions (30-60 days) to recover after short-lived `dsWebAuthToken` expiry.
 * @param {{
 *   session: Record<string, any>;
 *   fetchFn?: typeof fetch;
 *   signal?: AbortSignal;
 *   nowFn?: () => number;
 * }} params
 */
export async function validateAccountSession({ session, fetchFn = fetch, signal, nowFn = Date.now }) {
  const endpoints = resolveRegionEndpoints(session.region);
  if (!serializeCookies(session.cookies)) {
    throw new AppleClientError('缺少 iCloud 会话 Cookie，无法校验会话', 'AUTH_EXPIRED', 401, 'validate');
  }
  const url = `${endpoints.setupBase}/validate?${buildSetupQuery(session)}`;
  const resp = await httpJson(fetchFn, url, {
    method: 'POST',
    headers: buildIcloudHeaders(endpoints, session),
    body: null,
    signal,
  });
  absorbAuthResponse(session, resp.headers, resp.setCookies);
  if (!resp.ok) {
    const isAuthErr = resp.status === 401 || resp.status === 421 || resp.status === 450;
    throw new AppleClientError(
      extractAppleServiceError(resp.data, `iCloud 会话校验失败 (HTTP ${resp.status})`),
      isAuthErr ? 'AUTH_EXPIRED' : 'VALIDATE_FAILED',
      resp.status,
      'validate',
    );
  }
  if (resp.data?.dsInfo?.dsid) {
    session.dsid = String(resp.data.dsInfo.dsid);
  }
  if (resp.data?.hsaTrustedBrowser !== undefined) {
    session.trustedSession = Boolean(resp.data.hsaTrustedBrowser);
  }
  if (resp.data?.webservices?.findme?.url) {
    session.findmeUrl = validateFindMeUrl(resp.data.webservices.findme.url);
  }
  session.state = 'authenticated';
  session.validatedAt = nowFn();
  session.expiredAt = undefined;
  session.lastError = undefined;
  return session;
}

/**
 * Exchange `sessionToken` + optional `trustToken` at `/setup/ws/1/accountLogin` to obtain
 * `findme` regional host URL, `dsid`, and iCloud webauth cookies.
 * @param {{
 *   session: Record<string, any>;
 *   fetchFn?: typeof fetch;
 *   signal?: AbortSignal;
 *   nowFn?: () => number;
 * }} params
 */
export async function completeAccountLogin({ session, fetchFn = fetch, signal, nowFn = Date.now }) {
  const endpoints = resolveRegionEndpoints(session.region);
  if (!session.sessionToken) {
    throw new AppleClientError('缺少 X-Apple-Session-Token，无法完成 iCloud 登录', 'AUTH_EXPIRED', 401, 'account_login');
  }
  const url = `${endpoints.setupBase}/accountLogin?${buildSetupQuery(session)}`;
  const resp = await httpJson(fetchFn, url, {
    method: 'POST',
    headers: buildIcloudHeaders(endpoints, session),
    body: {
      ...(session.accountCountry ? { accountCountryCode: session.accountCountry } : {}),
      dsWebAuthToken: session.sessionToken,
      extended_login: true,
      trustToken: session.trustToken || '',
    },
    signal,
  });
  absorbAuthResponse(session, resp.headers, resp.setCookies);
  if (!resp.ok) {
    const code = resp.status === 401 || resp.status === 450 || resp.status === 421 ? 'AUTH_EXPIRED' : 'SETUP_LOGIN_FAILED';
    throw new AppleClientError(
      extractAppleServiceError(resp.data, `iCloud 会话建权失败 (HTTP ${resp.status})`),
      code,
      resp.status,
      'account_login',
    );
  }
  if (resp.data?.dsInfo?.dsid) {
    session.dsid = String(resp.data.dsInfo.dsid);
  }
  session.trustedSession = Boolean(resp.data?.hsaTrustedBrowser);
  const rawFindme = resp.data?.webservices?.findme?.url;
  const findmeUrl = validateFindMeUrl(rawFindme);
  session.findmeUrl = findmeUrl;
  session.state = 'authenticated';
  session.authenticatedAt = nowFn();
  session.expiredAt = undefined;
  session.lastError = undefined;
  session.trustedPhones = undefined;
  return session;
}

/**
 * Extract `<script class="boot_args">` JSON embedded in Apple's HTML MFA shell if present.
 * @param {string} html
 * @returns {Record<string, any> | null}
 */
function parseBootArgsFromHtml(html) {
  if (!html) return null;
  const match = /<script[^>]*class="[^"]*boot_args[^"]*"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Collect deduplicated trusted phone numbers from Apple's HTML boot args and JSON MFA payloads.
 * @param {any} source
 * @param {Map<number, { id: number; numberWithDialCode: string; pushMode: string }>} target
 */
function collectPhonesFromPayload(source, target) {
  if (!source || typeof source !== 'object') return;
  const candidates = [];
  if (Array.isArray(source.trustedPhoneNumbers)) {
    candidates.push(...source.trustedPhoneNumbers);
  }
  if (source.trustedPhoneNumber && typeof source.trustedPhoneNumber === 'object') {
    candidates.push(source.trustedPhoneNumber);
  }
  if (Array.isArray(source.phoneNumberVerification?.trustedPhoneNumbers)) {
    candidates.push(...source.phoneNumberVerification.trustedPhoneNumbers);
  }
  if (source.phoneNumberVerification?.trustedPhoneNumber) {
    candidates.push(source.phoneNumberVerification.trustedPhoneNumber);
  }
  for (const p of candidates) {
    const id = Number(p?.id);
    if (!Number.isInteger(id) || id < 1) continue;
    const label = String(p?.numberWithDialCode ?? p?.obfuscatedNumber ?? '');
    const pushMode = String(p?.pushMode ?? 'sms');
    if (!target.has(id)) {
      target.set(id, { id, numberWithDialCode: label, pushMode });
    }
  }
}

/**
 * Inspect trusted phone numbers available for SMS 2FA fallback via HTML boot args + JSON auth probe.
 * @param {{
 *   session: Record<string, any>;
 *   fetchFn?: typeof fetch;
 *   signal?: AbortSignal;
 * }} params
 */
async function fetchTrustedPhones({ session, fetchFn = fetch, signal }) {
  const endpoints = resolveRegionEndpoints(session.region);
  /** @type {Map<number, { id: number; numberWithDialCode: string; pushMode: string }>} */
  const phones = new Map();

  try {
    const htmlResp = await httpJson(fetchFn, endpoints.authBase, {
      method: 'GET',
      headers: buildIdmsaHeaders(endpoints, session, { Accept: 'text/html' }),
      signal,
    });
    absorbAuthResponse(session, htmlResp.headers, htmlResp.setCookies);
    if (htmlResp.data && Object.keys(htmlResp.data).length > 0) {
      collectPhonesFromPayload(htmlResp.data, phones);
    } else {
      const boot = parseBootArgsFromHtml(htmlResp.rawText);
      if (boot) {
        collectPhonesFromPayload(boot.direct ?? boot, phones);
      }
    }
  } catch {
    // Ignore optional HTML shell probe failure
  }

  try {
    const jsonResp = await httpJson(fetchFn, endpoints.authBase, {
      method: 'GET',
      headers: buildIdmsaHeaders(endpoints, session, { Accept: 'application/json' }),
      signal,
    });
    absorbAuthResponse(session, jsonResp.headers, jsonResp.setCookies);
    collectPhonesFromPayload(jsonResp.data, phones);
  } catch {
    // Ignore optional JSON MFA probe failure
  }

  return Array.from(phones.values());
}

/**
 * Initiate Apple ID SRP-6a authentication against Apple IDMSa + regional iCloud setup endpoints.
 * Password is used strictly in-memory to compute the SRP proof and is never persisted.
 * @param {{
 *   appleId: string;
 *   password: string;
 *   region?: string;
 *   existingTrustToken?: string;
 *   existingTrustCookies?: Record<string, string>;
 *   clientId?: string;
 *   pause2FA?: boolean;
 *   fetchFn?: typeof fetch;
 *   signal?: AbortSignal;
 *   nowFn?: () => number;
 * }} params
 */
export async function startAppleLogin({
  appleId,
  password,
  region = 'cn',
  existingTrustToken,
  existingTrustCookies,
  clientId,
  pause2FA = false,
  fetchFn = fetch,
  signal,
  nowFn = Date.now,
}) {
  const cleanId = String(appleId ?? '').trim();
  const cleanPass = String(password ?? '');
  if (!cleanId || !cleanPass) {
    throw new AppleClientError('请输入 Apple ID 账号与密码', 'INVALID_CREDENTIALS', undefined, 'authorize');
  }
  const endpoints = resolveRegionEndpoints(region);
  const resolvedClientId = normalizeClientId(clientId);
  /** @type {Record<string, string>} */
  const seedCookies = {};
  if (existingTrustToken && existingTrustCookies && typeof existingTrustCookies === 'object' && !Array.isArray(existingTrustCookies)) {
    for (const [k, v] of Object.entries(existingTrustCookies)) {
      if (/^DES[0-9a-f]+$/i.test(k) && typeof v === 'string' && v.trim().length > 0) {
        seedCookies[k] = v;
      }
    }
  }
  const session = /** @type {Record<string, any>} */ ({
    region: endpoints.region,
    appleId: cleanId,
    clientId: resolvedClientId,
    cookies: seedCookies,
    ...(existingTrustToken ? { trustToken: existingTrustToken } : {}),
  });

  // 1. Pre-flight OAuth widget bootstrap to establish X-Apple-Auth-Attributes & initial scnt/cookies
  const authorizeParams = new URLSearchParams({
    frame_id: resolvedClientId,
    skVersion: '7',
    iframeid: resolvedClientId,
    client_id: APPLE_WIDGET_KEY,
    response_type: 'code',
    redirect_uri: endpoints.homeOrigin,
    response_mode: 'web_message',
    state: resolvedClientId,
    authVersion: 'latest',
  });
  const authorizeResp = await httpJson(fetchFn, `${endpoints.authBase}/authorize/signin?${authorizeParams.toString()}`, {
    method: 'GET',
    headers: buildIdmsaHeaders(endpoints, session),
    signal,
  });
  absorbAuthResponse(session, authorizeResp.headers, authorizeResp.setCookies);
  if (authorizeResp.status === 429 || authorizeResp.status === 503) {
    throw new AppleClientError(`苹果认证预检限流或不可用 (HTTP ${authorizeResp.status})，请稍后再试`, 'RATE_LIMITED', authorizeResp.status, 'authorize');
  }
  if (!authorizeResp.ok) {
    throw new AppleClientError(
      extractAppleServiceError(authorizeResp.data, `苹果 OAuth 登录初始化失败 (HTTP ${authorizeResp.status})`),
      'AUTH_BOOTSTRAP_FAILED',
      authorizeResp.status,
      'authorize',
    );
  }

  // 2. SRP-6a init
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
    throw new AppleClientError(`苹果认证服务当前限流或不可用 (HTTP ${initResp.status})，请稍后再试`, 'RATE_LIMITED', initResp.status, 'srp_init');
  }
  if (!initResp.ok) {
    throw new AppleClientError(
      extractAppleServiceError(initResp.data, `初始化 SRP 登录失败 (HTTP ${initResp.status})`),
      'SRP_INIT_FAILED',
      initResp.status,
      'srp_init',
    );
  }

  const protocol = initResp.data?.protocol === 's2k' ? 's2k' : initResp.data?.protocol === 's2k_fo' ? 's2k_fo' : '';
  const saltBase64 = String(initResp.data?.salt ?? '');
  const bBase64 = String(initResp.data?.b ?? '');
  const iterations = Number(initResp.data?.iteration ?? 0);
  const cToken = String(initResp.data?.c ?? '');

  if (!protocol || !saltBase64 || !bBase64 || !Number.isInteger(iterations) || iterations < 1 || !cToken) {
    throw new AppleClientError('苹果服务器返回的 SRP 参数不完整或不支持的协议', 'INVALID_SRP_CHALLENGE', initResp.status, 'srp_init');
  }

  // 3. SRP-6a client proof & complete
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
      c: cToken,
      m1: m1Base64,
      m2: m2Base64,
      rememberMe: true,
      trustTokens: existingTrustToken ? [existingTrustToken] : [],
      ...(pause2FA ? { pause2FA: true } : {}),
    },
    signal,
  });
  absorbAuthResponse(session, completeResp.headers, completeResp.setCookies);

  if (completeResp.status === 200) {
    await completeAccountLogin({ session, fetchFn, signal, nowFn });
    return session;
  }

  if (completeResp.status === 409) {
    if (pause2FA && session.sessionToken) {
      try {
        await completeAccountLogin({ session, fetchFn, signal, nowFn });
        return session;
      } catch {
        // Fall through to standard 2FA flow if one-factor Find My setup wasn't accepted
      }
    }
    session.state = 'pending_2fa';
    session.pending2faAt = nowFn();
    session.trustedPhones = await fetchTrustedPhones({ session, fetchFn, signal });
    return session;
  }

  if (completeResp.status === 401 || completeResp.status === 403) {
    const detail = extractAppleServiceError(completeResp.data, '');
    const suffix = detail ? `（${detail}）` : '';
    throw new AppleClientError(
      `Apple ID 或密码不正确（HTTP ${completeResp.status}${suffix}；注意必须使用 Apple ID 主密码，不能使用 App 专用密码）`,
      'INVALID_CREDENTIALS',
      completeResp.status,
      'srp_complete',
    );
  }
  if (completeResp.status === 412) {
    throw new AppleClientError(
      '账号需要先在苹果官网或设备上确认隐私条款/安全提示后才能登录 (HTTP 412)',
      'PRECONDITION_REQUIRED',
      412,
      'srp_complete',
    );
  }
  if (completeResp.status === 429 || completeResp.status === 503) {
    throw new AppleClientError(
      `苹果认证服务当前限流或繁忙 (HTTP ${completeResp.status})，请稍后重试`,
      'RATE_LIMITED',
      completeResp.status,
      'srp_complete',
    );
  }
  throw new AppleClientError(
    extractAppleServiceError(completeResp.data, `SRP 校验失败 (HTTP ${completeResp.status})`),
    'SRP_COMPLETE_FAILED',
    completeResp.status,
    'srp_complete',
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
    throw new AppleClientError('当前不在等待 2FA 验证状态，请先执行 auth-login', 'NOT_PENDING_2FA', undefined, 'sms_send');
  }
  const endpoints = resolveRegionEndpoints(session.region);
  const targetPhoneId = Number.isInteger(phoneId) && Number(phoneId) > 0
    ? Number(phoneId)
    : (session.trustedPhones?.[0]?.id ?? 1);
  const resp = await httpJson(fetchFn, `${endpoints.authBase}/verify/phone`, {
    method: 'PUT',
    headers: buildIdmsaHeaders(endpoints, session, { Accept: 'application/json' }),
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
      'sms_send',
    );
  }
  session.lastSmsPhoneId = targetPhoneId;
  return session;
}

/**
 * Attempt one-factor Find My access using the pre-2FA `sessionToken` without a 6-digit code.
 * Matches Apple's Find My allowance for locating a lost trusted device.
 * @param {{
 *   session: Record<string, any>;
 *   fetchFn?: typeof fetch;
 *   signal?: AbortSignal;
 *   nowFn?: () => number;
 * }} params
 */
export async function bypass2faForFindMy({ session, fetchFn = fetch, signal, nowFn = Date.now }) {
  if (!session || (session.state !== 'pending_2fa' && session.state !== 'expired')) {
    throw new AppleClientError('当前没有可直通的待验证会话，请先使用账号密码发起登录', 'NOT_PENDING_2FA', undefined, 'bypass_2fa');
  }
  if (!session.sessionToken) {
    throw new AppleClientError('当前会话缺少临时 Token，无法使用免码直通，请提交 6 位验证码', 'MISSING_SESSION_TOKEN', 401, 'bypass_2fa');
  }
  await completeAccountLogin({ session, fetchFn, signal, nowFn });
  return session;
}

/**
 * Determine whether Apple accepted the submitted 6-digit security code.
 * Apple may return HTTP 200/204, HTTP 409 with `securityCode.valid === true`,
 * or HTTP 412 with `X-Apple-Repair-Session-Token`.
 * @param {{ ok: boolean; status: number; data: any; headers: Headers | Record<string, unknown> }} verifyResp
 * @returns {boolean}
 */
function isAccepted2faResponse(verifyResp) {
  if (verifyResp.ok) return true;
  if (verifyResp.status === 409 && verifyResp.data?.securityCode?.valid === true) {
    return true;
  }
  if (verifyResp.status === 412 && Boolean(readHeader(verifyResp.headers, 'x-apple-repair-session-token'))) {
    return true;
  }
  return false;
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
 *   nowFn?: () => number;
 * }} params
 */
export async function verify2faCode({
  session,
  code,
  mode = 'trusted_device',
  phoneId,
  fetchFn = fetch,
  signal,
  nowFn = Date.now,
}) {
  if (!session || session.state !== 'pending_2fa') {
    throw new AppleClientError('当前没有待验证的 2FA 登录会话，请先使用账号密码发起登录', 'NOT_PENDING_2FA', undefined, '2fa_verify');
  }
  const cleanCode = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleanCode)) {
    throw new AppleClientError('请输入 6 位数字双重认证验证码', 'INVALID_2FA_FORMAT', undefined, '2fa_verify');
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
  const acceptOverride = isSms ? 'application/json, plain/text' : 'application/json';

  const verifyResp = await httpJson(fetchFn, verifyUrl, {
    method: 'POST',
    headers: buildIdmsaHeaders(endpoints, session, { Accept: acceptOverride }),
    body: verifyBody,
    signal,
  });
  absorbAuthResponse(session, verifyResp.headers, verifyResp.setCookies);

  if (!isAccepted2faResponse(verifyResp)) {
    const invalidCode = verifyResp.status === 400 || verifyResp.status === 401 || verifyResp.status === 422 || verifyResp.status === 409;
    throw new AppleClientError(
      invalidCode
        ? extractAppleServiceError(verifyResp.data, '双重认证验证码无效或已过期，请核对后重试')
        : extractAppleServiceError(verifyResp.data, `2FA 验证失败 (HTTP ${verifyResp.status})`),
      invalidCode ? 'INVALID_2FA_CODE' : 'TWO_FA_FAILED',
      verifyResp.status,
      '2fa_verify',
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
      '2sv_trust',
    );
  }

  await completeAccountLogin({ session, fetchFn, signal, nowFn });
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

  const soundCapable = raw?.features && typeof raw.features === 'object' && 'SND' in raw.features
    ? Boolean(raw.features.SND)
    : true;
  const isFamily = Boolean(raw?.fmlyShare || raw?.prsId);

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
      soundCapable,
      isFamily,
      location,
    },
  };
}

/**
 * Clear short-lived Find My subsession context and FMIP cookie so `/initClient` creates a fresh subsession.
 * @param {Record<string, any>} session
 */
function clearFmipSubsession(session) {
  session.fmipServerContext = undefined;
  session.fmipContextUpdatedAt = undefined;
  if (session.cookies && typeof session.cookies === 'object' && !Array.isArray(session.cookies)) {
    delete session.cookies['X-APPLE-WEBAUTH-FMIP'];
  }
}

/**
 * Mark an Apple session as definitively expired (requiring fresh login/2FA) and throw `AUTH_EXPIRED`.
 * @param {Record<string, any>} session
 * @param {() => number} nowFn
 * @param {string} message
 * @param {number | undefined} status
 * @param {string} stage
 * @returns {never}
 */
function markSessionExpired(session, nowFn, message, status, stage) {
  session.state = 'expired';
  clearFmipSubsession(session);
  session.expiredAt = nowFn();
  throw new AppleClientError(message, 'AUTH_EXPIRED', status, stage);
}

/**
 * Perform a raw FMiP JSON POST against `findmeUrl` and absorb rotated cookies without throwing on HTTP errors.
 * @param {{
 *   session: Record<string, any>;
 *   path: string;
 *   body: Record<string, unknown>;
 *   fetchFn?: typeof fetch;
 *   signal?: AbortSignal;
 * }} params
 */
async function postFmipRaw({ session, path, body, fetchFn = fetch, signal }) {
  const endpoints = resolveRegionEndpoints(session.region);
  const base = validateFindMeUrl(session.findmeUrl);
  const resp = await httpJson(fetchFn, `${base}${path}?${buildSetupQuery(session)}`, {
    method: 'POST',
    headers: buildIcloudHeaders(endpoints, session),
    body,
    signal,
  });
  session.cookies = mergeCookies(session.cookies, resp.setCookies);
  return resp;
}

/**
 * Initialize a fresh FMiP web subsession via `/fmipservice/client/web/initClient`.
 * When Apple returns 401/450, tries `/setup/ws/1/accountLogin` -> `/initClient` first
 * (minting fresh FMiP auth), falling back to `/setup/ws/1/validate` -> `/initClient`.
 * Transient network/5xx/429 errors are re-thrown without marking the session as expired.
 * @param {{
 *   session: Record<string, any>;
 *   baseClientContext: Record<string, unknown>;
 *   locate: boolean;
 *   includeFamily: boolean;
 *   fetchFn?: typeof fetch;
 *   signal?: AbortSignal;
 *   nowFn?: () => number;
 * }} params
 */
async function initFmipSession({
  session,
  baseClientContext,
  locate,
  includeFamily,
  fetchFn = fetch,
  signal,
  nowFn = Date.now,
}) {
  const makeInitBody = () => ({
    clientContext: {
      ...baseClientContext,
      ...(locate ? { shouldLocate: true, selectedDevice: 'all' } : {}),
    },
  });

  let resp = await postFmipRaw({
    session,
    path: '/fmipservice/client/web/initClient',
    body: makeInitBody(),
    fetchFn,
    signal,
  });

  if (resp.status === 401 || resp.status === 450) {
    let authRejectedStatus = resp.status;
    let authRejectedStage = 'fmip_init';
    const sawAuthRejection = true;
    let triedAccountLogin = false;

    // Stage A: accountLogin -> /initClient (primary path to re-mint FMiP auth on 450)
    if (session.sessionToken) {
      triedAccountLogin = true;
      let loginOk = false;
      try {
        await completeAccountLogin({ session, fetchFn, signal, nowFn });
        loginOk = true;
      } catch (err) {
        if (err instanceof AppleClientError && err.code === 'AUTH_EXPIRED') {
          authRejectedStatus = err.status ?? authRejectedStatus;
          authRejectedStage = err.stage || 'account_login';
        } else {
          throw err;
        }
      }
      if (loginOk) {
        clearFmipSubsession(session);
        resp = await postFmipRaw({
          session,
          path: '/fmipservice/client/web/initClient',
          body: makeInitBody(),
          fetchFn,
          signal,
        });
        if (resp.ok) {
          storeFmipServerContext(session, resp.data, includeFamily, nowFn);
          return resp.data;
        }
        if (resp.status !== 401 && resp.status !== 450) {
          throw new AppleClientError(
            extractAppleServiceError(resp.data, `iCloud Find My 初始化失败 (HTTP ${resp.status})`),
            'FMIP_REQUEST_FAILED',
            resp.status,
            'fmip_init',
          );
        }
        authRejectedStatus = resp.status;
        authRejectedStage = 'fmip_init';
      }
    }

    // Stage B: /validate -> /initClient fallback when sessionToken is absent/expired or Stage A still hit 450
    if (hasWebAuthCookies(session.cookies)) {
      let validateOk = false;
      try {
        await validateAccountSession({ session, fetchFn, signal, nowFn });
        validateOk = true;
      } catch (err) {
        if (err instanceof AppleClientError && (err.status === 401 || err.status === 421 || err.status === 450)) {
          authRejectedStatus = err.status;
          authRejectedStage = err.stage || 'validate';
        } else if (err instanceof AppleClientError && err.status === 404) {
          if (!triedAccountLogin) {
            throw err;
          }
        } else {
          throw err;
        }
      }
      if (validateOk) {
        clearFmipSubsession(session);
        resp = await postFmipRaw({
          session,
          path: '/fmipservice/client/web/initClient',
          body: makeInitBody(),
          fetchFn,
          signal,
        });
        if (resp.ok) {
          storeFmipServerContext(session, resp.data, includeFamily, nowFn);
          return resp.data;
        }
        if (resp.status !== 401 && resp.status !== 450) {
          throw new AppleClientError(
            extractAppleServiceError(resp.data, `iCloud Find My 初始化失败 (HTTP ${resp.status})`),
            'FMIP_REQUEST_FAILED',
            resp.status,
            'fmip_init',
          );
        }
        authRejectedStatus = resp.status;
        authRejectedStage = 'fmip_init';
      }
    }

    // Stage C: exhausted all renewal paths with explicit auth rejections
    if (sawAuthRejection) {
      markSessionExpired(
        session,
        nowFn,
        'Apple 会话已过期（约 30～60 天需重新完成一次 2FA 授权），请重新登录绑定',
        authRejectedStatus,
        authRejectedStage,
      );
    }
  }

  if (!resp.ok) {
    throw new AppleClientError(
      extractAppleServiceError(resp.data, `iCloud Find My 初始化失败 (HTTP ${resp.status})`),
      'FMIP_REQUEST_FAILED',
      resp.status,
      'fmip_init',
    );
  }
  storeFmipServerContext(session, resp.data, includeFamily, nowFn);
  return resp.data;
}

/**
 * Sleep for `ms` milliseconds while honoring an optional `AbortSignal`.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
function sleepWithSignal(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('Request aborted'));
  }
  if (!Number.isFinite(ms) || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Request aborted'));
    };
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Check whether two Sets contain identical elements.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {boolean}
 */
function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

/**
 * Inspect an FMiP payload to determine which devices or family members are still settling.
 * @param {any} payload
 * @param {boolean} includeFamily
 */
function collectUnsettledState(payload, includeFamily) {
  const content = Array.isArray(payload?.content) ? payload.content : [];
  /** @type {Set<string>} */
  const locatingIds = new Set();
  /** @type {Set<string>} */
  const pendingIds = new Set();
  /** @type {Set<string>} */
  const unknownOnlineIds = new Set();

  for (const d of content) {
    const id = String(d?.id ?? '');
    if (Boolean(d?.isLocating)) {
      locatingIds.add(id);
    }
    const statusCode = String(d?.deviceStatus ?? '');
    if (statusCode === '203') {
      pendingIds.add(id);
    } else if (statusCode === '200' && (!d?.batteryStatus || d.batteryStatus === 'Unknown')) {
      unknownOnlineIds.add(id);
    }
  }

  /** @type {Set<string>} */
  const loadingMembers = new Set();
  if (includeFamily && payload?.userInfo?.hasMembers && payload?.userInfo?.membersInfo && typeof payload.userInfo.membersInfo === 'object') {
    for (const [key, member] of Object.entries(payload.userInfo.membersInfo)) {
      if (member && typeof member === 'object' && /** @type {any} */ (member).deviceFetchStatus === 'LOADING') {
        loadingMembers.add(key);
      }
    }
  }

  return { locatingIds, pendingIds, unknownOnlineIds, loadingMembers };
}

/**
 * Sanitize & persist FMiP serverContext onto session so subsequent refresh calls don't trigger theftLoss errors.
 * @param {Record<string, any>} session
 * @param {any} payload
 * @param {boolean} [includeFamily]
 * @param {() => number} [nowFn]
 */
function storeFmipServerContext(session, payload, includeFamily, nowFn = Date.now) {
  if (payload?.serverContext && typeof payload.serverContext === 'object') {
    const ctx = { ...payload.serverContext };
    if ('theftLoss' in ctx) ctx.theftLoss = null;
    session.fmipServerContext = ctx;
    session.fmipContextUpdatedAt = nowFn();
    if (includeFamily !== undefined) {
      session.fmipIncludeFamily = Boolean(includeFamily);
    }
  }
}

/**
 * Determine whether the cached `fmipServerContext` has approached or exceeded Apple's `sessionLifespan` (default 15m).
 * @param {Record<string, any>} session
 * @param {number} nowMs
 * @returns {boolean}
 */
function isFmipContextStale(session, nowMs) {
  if (!session?.fmipServerContext || typeof session.fmipServerContext !== 'object') {
    return true;
  }
  const updatedAt = session.fmipContextUpdatedAt;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt) || nowMs < updatedAt) {
    return false;
  }
  const lifespanMs = Number(session.fmipServerContext.sessionLifespan);
  const effectiveLifespan = Number.isFinite(lifespanMs) && lifespanMs > 0 ? lifespanMs : 900_000;
  const staleThresholdMs = Math.max(60_000, effectiveLifespan - 60_000);
  return (nowMs - updatedAt) >= staleThresholdMs;
}

/**
 * Fetch and normalize Find My devices, calling `/initClient` first when no `serverContext` is cached
 * (or when `includeFamily` setting changed or `sessionLifespan` elapsed), then `/refreshClient` with bounded wake-settling polls.
 * @param {{
 *   session: Record<string, any>;
 *   locate?: boolean;
 *   includeFamily?: boolean;
 *   locatePollDelayMs?: number;
 *   maxLocatePolls?: number;
 *   fetchFn?: typeof fetch;
 *   nowFn?: () => number;
 *   signal?: AbortSignal;
 * }} params
 */
export async function fetchFindMyDevices({
  session,
  locate = true,
  includeFamily = true,
  locatePollDelayMs,
  maxLocatePolls = 2,
  fetchFn = fetch,
  nowFn = Date.now,
  signal,
}) {
  if (!session || session.state !== 'authenticated' || !session.findmeUrl) {
    throw new AppleClientError('尚未登录或尚未完成 2FA 验证，请先绑定 Apple ID', 'NOT_AUTHENTICATED', 401, 'fmip_refresh');
  }

  const wantFamily = Boolean(includeFamily);
  const familyChanged = Boolean(
    session.fmipServerContext
    && ((session.fmipIncludeFamily !== undefined && session.fmipIncludeFamily !== wantFamily)
      || (session.fmipIncludeFamily === undefined && wantFamily)),
  );
  if (familyChanged || isFmipContextStale(session, nowFn())) {
    clearFmipSubsession(session);
  }

  const baseClientContext = {
    appName: 'iCloud Find (Web)',
    appVersion: '2.0',
    apiVersion: '3.0',
    deviceListVersion: 1,
    fmly: wantFamily,
    timezone: 'Asia/Shanghai',
    inactiveTime: 0,
  };

  /**
   * @param {boolean} allowReinit
   * @param {boolean} forceLocate
   */
  const runRefreshClient = async (allowReinit, forceLocate) => {
    const resp = await postFmipRaw({
      session,
      path: '/fmipservice/client/web/refreshClient',
      body: {
        clientContext: {
          ...baseClientContext,
          ...(forceLocate ? { shouldLocate: true, selectedDevice: 'all' } : {}),
        },
        serverContext: session.fmipServerContext,
        ...(forceLocate ? { isUpdatingAllLocations: true } : {}),
      },
      fetchFn,
      signal,
    });
    if (resp.status === 401 || resp.status === 450) {
      if (!allowReinit) {
        markSessionExpired(
          session,
          nowFn,
          'Apple 会话已过期（约 30～60 天需重新完成一次 2FA 授权），请重新登录绑定',
          resp.status,
          'fmip_refresh',
        );
      }
      clearFmipSubsession(session);
      const reinitPayload = await initFmipSession({
        session,
        baseClientContext,
        locate: forceLocate,
        includeFamily: wantFamily,
        fetchFn,
        signal,
        nowFn,
      });
      return { payload: reinitPayload, reinitialized: true };
    }
    if (!resp.ok) {
      throw new AppleClientError(
        extractAppleServiceError(resp.data, `iCloud Find My 请求失败 (HTTP ${resp.status})`),
        'FMIP_REQUEST_FAILED',
        resp.status,
        'fmip_refresh',
      );
    }
    storeFmipServerContext(session, resp.data, wantFamily, nowFn);
    return { payload: resp.data, reinitialized: false };
  };

  let payload;
  if (!session.fmipServerContext) {
    const initPayload = await initFmipSession({
      session,
      baseClientContext,
      locate,
      includeFamily: wantFamily,
      fetchFn,
      signal,
      nowFn,
    });
    payload = initPayload;

    if (locate && session.fmipServerContext) {
      const refreshed = await runRefreshClient(true, true);
      if (Array.isArray(refreshed.payload?.content) && refreshed.payload.content.length > 0) {
        payload = refreshed.payload;
      }
    }
  } else {
    const first = await runRefreshClient(true, locate);
    payload = first.payload;
    if (first.reinitialized && locate && session.fmipServerContext) {
      const followUp = await runRefreshClient(false, true);
      if (Array.isArray(followUp.payload?.content) && followUp.payload.content.length > 0) {
        payload = followUp.payload;
      }
    }
  }

  if (locate && maxLocatePolls > 0 && session.fmipServerContext) {
    /** @type {Set<string> | null} */
    let prevPendingIds = null;
    /** @type {Set<string> | null} */
    let prevLoadingMembers = null;
    let reinitUsedInLoop = false;
    for (let poll = 0; poll < maxLocatePolls; poll += 1) {
      const state = collectUnsettledState(payload, wantFamily);
      if (
        state.locatingIds.size === 0
        && state.pendingIds.size === 0
        && state.unknownOnlineIds.size === 0
        && state.loadingMembers.size === 0
      ) {
        break;
      }
      if (
        poll > 0
        && state.locatingIds.size === 0
        && state.unknownOnlineIds.size === 0
        && prevPendingIds
        && prevLoadingMembers
        && setsEqual(state.pendingIds, prevPendingIds)
        && setsEqual(state.loadingMembers, prevLoadingMembers)
      ) {
        break;
      }
      prevPendingIds = state.pendingIds;
      prevLoadingMembers = state.loadingMembers;

      const serverDelayRaw = Number(payload?.serverContext?.callbackIntervalInMS ?? 2200);
      const boundedServerDelay = Number.isFinite(serverDelayRaw)
        ? Math.max(800, Math.min(2500, serverDelayRaw))
        : 2200;
      const delayMs = typeof locatePollDelayMs === 'number' && Number.isFinite(locatePollDelayMs) && locatePollDelayMs >= 0
        ? locatePollDelayMs
        : boundedServerDelay;

      await sleepWithSignal(delayMs, signal);

      const refreshed = await runRefreshClient(!reinitUsedInLoop, true);
      if (refreshed.reinitialized) reinitUsedInLoop = true;
      if (Array.isArray(refreshed.payload?.content) && refreshed.payload.content.length > 0) {
        payload = refreshed.payload;
      }
    }
  }

  const content = Array.isArray(payload?.content) ? payload.content : [];
  const entries = [];
  for (const item of content) {
    const normalized = normalizeFmipDevice(item);
    if (normalized) entries.push(normalized);
  }
  return {
    fetchedAt: nowFn(),
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
 *   nowFn?: () => number;
 *   signal?: AbortSignal;
 * }} params
 */
export async function playFindMySound({ session, rawDeviceId, subject, fetchFn = fetch, nowFn = Date.now, signal }) {
  if (!rawDeviceId) {
    throw new AppleClientError('缺少目标设备内部 ID，请先刷新设备列表', 'MISSING_DEVICE_ID', undefined, 'fmip_play_sound');
  }
  if (!session || session.state !== 'authenticated' || !session.findmeUrl) {
    throw new AppleClientError('尚未登录或尚未完成 2FA 验证，请先绑定 Apple ID', 'NOT_AUTHENTICATED', 401, 'fmip_play_sound');
  }

  const baseClientContext = {
    appName: 'iCloud Find (Web)',
    appVersion: '2.0',
    apiVersion: '3.0',
    deviceListVersion: 1,
    fmly: session.fmipIncludeFamily ?? true,
    timezone: 'Asia/Shanghai',
    inactiveTime: 0,
  };

  if (isFmipContextStale(session, nowFn())) {
    clearFmipSubsession(session);
    await initFmipSession({
      session,
      baseClientContext,
      locate: false,
      includeFamily: session.fmipIncludeFamily ?? true,
      fetchFn,
      signal,
      nowFn,
    });
  }

  const makePlayBody = () => ({
    device: rawDeviceId,
    subject: String(subject || 'F.R.I.D.A.Y. 查找设备提醒').trim().slice(0, 120),
    clientContext: {
      appName: 'iCloud Find (Web)',
      appVersion: '2.0',
      fmly: true,
    },
    ...(session.fmipServerContext ? { serverContext: session.fmipServerContext } : {}),
  });

  let resp = await postFmipRaw({
    session,
    path: '/fmipservice/client/web/playSound',
    body: makePlayBody(),
    fetchFn,
    signal,
  });

  if (resp.status === 401 || resp.status === 450) {
    clearFmipSubsession(session);
    await initFmipSession({
      session,
      baseClientContext,
      locate: false,
      includeFamily: session.fmipIncludeFamily ?? true,
      fetchFn,
      signal,
      nowFn,
    });
    resp = await postFmipRaw({
      session,
      path: '/fmipservice/client/web/playSound',
      body: makePlayBody(),
      fetchFn,
      signal,
    });
  }

  if (resp.status === 401 || resp.status === 450) {
    markSessionExpired(
      session,
      nowFn,
      'Apple 会话已过期（约 30～60 天需重新完成一次 2FA 授权），请重新登录绑定',
      resp.status,
      'fmip_play_sound',
    );
  }
  if (!resp.ok) {
    throw new AppleClientError(
      extractAppleServiceError(resp.data, `iCloud Find My 请求失败 (HTTP ${resp.status})`),
      'FMIP_REQUEST_FAILED',
      resp.status,
      'fmip_play_sound',
    );
  }
  return {
    statusCode: String(resp.data?.statusCode ?? '200'),
    ok: true,
  };
}

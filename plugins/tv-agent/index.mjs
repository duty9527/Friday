import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  errMsg,
  readConfig as readSharedConfig,
  resolvePluginPaths,
  withFileLock,
  writeConfig as writeSharedConfig,
} from '../_shared/config-store.mjs';
import { execSshText, parseSshSpec, shellQuote } from '../_shared/ssh.mjs';

const execFileAsync = promisify(execFile);

export const DEFAULT_CONFIG = Object.freeze({
  tvHost: '',
  tvToken: '',
  agentPort: 8989,
  dlnaPort: 49152,
  sshTarget: '',
  appAliases: Object.freeze({}),
});

const DEFAULT_DECISION_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DECISION_MODEL = 'gemini-decision-1';
const PROBE_TIMEOUT_MS = 1500;
const AGENT_TIMEOUT_MS = 6000;
const SOAP_TIMEOUT_MS = 5000;
const GOAL_REACHED_THRESHOLD = 0.78;
const LOW_CONFIDENCE = 0.5;
const MAX_CLICK_CHOICES = 48;
const MAX_CHOICES = 255;
const ACTIONS = ['status', 'power', 'volume', 'cast', 'open_app', 'tree', 'screenshot', 'act', 'navigate', 'config'];

const RENDER_CONTROL = '/smartshare/render/_urn:schemas-upnp-org:service:RenderingControl_control';
const AV_TRANSPORT = '/smartshare/render/_urn:schemas-upnp-org:service:AVTransport_control';

/** Built-in generic app aliases -> Android package names (personal sideload packages go in config.json.appAliases). */
export const APP_ALIASES = {
  'com.bili.tv.bili_tv_app': ['bili', 'bilibili', 'b站', '哔哩哔哩', 'bilitv'],
  'org.smarttube.stable': ['youtube', '油管', 'smarttube', 'yt'],
};

const ALIAS_MAP = new Map();
for (const [pkg, names] of Object.entries(APP_ALIASES)) {
  for (const name of names) ALIAS_MAP.set(normalizeAlias(name), pkg);
}

const BUILTIN_GOAL_APP_ALIASES = [
  'bilibili', 'bilitv', 'bili', 'b站', '哔哩哔哩', 'smarttube', 'youtube', '油管',
].sort((a, b) => b.length - a.length);
const LAUNCHER_GOAL_RE = /桌面|主页|首页|launcher|home\s*screen/i;

function normalizeAlias(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * Normalize custom `appAliases` from config.json.
 * Accepts `{ pkgName: ['alias1', ...] }` or `{ alias: 'pkgName' }`.
 */
function normalizeCustomAliases(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const normalized = {};
  for (const [key, val] of Object.entries(raw)) {
    const cleanKey = String(key ?? '').trim();
    if (!cleanKey) continue;
    if (Array.isArray(val)) {
      const list = val.map(v => String(v ?? '').trim()).filter(Boolean);
      if (list.length) normalized[cleanKey] = list;
    } else if (typeof val === 'string' && val.trim()) {
      normalized[cleanKey] = val.trim();
    }
  }
  return normalized;
}

function buildAliasIndex(customAliases) {
  const map = new Map(ALIAS_MAP);
  const goalAliases = new Set(BUILTIN_GOAL_APP_ALIASES);
  const launcherPackages = new Set();
  for (const [key, val] of Object.entries(normalizeCustomAliases(customAliases))) {
    if (Array.isArray(val)) {
      for (const alias of val) {
        const norm = normalizeAlias(alias);
        if (!norm) continue;
        map.set(norm, key);
        if (LAUNCHER_GOAL_RE.test(alias) || norm === 'home') {
          launcherPackages.add(key);
        } else if (norm.length >= 2) {
          goalAliases.add(String(alias).trim().toLowerCase());
        }
      }
    } else {
      const norm = normalizeAlias(key);
      if (!norm) continue;
      map.set(norm, val);
      if (LAUNCHER_GOAL_RE.test(key) || norm === 'home') {
        launcherPackages.add(val);
      } else if (norm.length >= 2) {
        goalAliases.add(key.toLowerCase());
      }
    }
  }
  return {
    aliasMap: map,
    goalAliases: Array.from(goalAliases).sort((a, b) => b.length - a.length),
    launcherPackages,
  };
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function success(title, message, data) {
  return { ok: true, notify: true, title, message, ...(data === undefined ? {} : { data }) };
}

function failure(title, message, data) {
  return { ok: false, notify: true, title, message, ...(data === undefined ? {} : { data }) };
}

// ---------------------------------------------------------------------------
// Paths / config / credentials
// ---------------------------------------------------------------------------

function getRuntimePaths(deps = {}) {
  const paths = resolvePluginPaths('tv-agent', deps);
  return {
    homeDir: paths.homeDir,
    dataDir: paths.pluginDataDir,
    configPath: paths.configPath,
    screenshotsDir: join(paths.pluginDataDir, 'screenshots'),
    modelHubPath: deps.modelHubPath ?? join(paths.homeDir, 'sdk', 'model-hub.json'),
  };
}

function sanitizeHost(value) {
  const host = String(value ?? '').trim();
  return /^[A-Za-z0-9._-]{1,253}$/.test(host) ? host : undefined;
}

function sanitizePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
}

function sanitizeAdbTarget(value) {
  const s = String(value ?? '').trim();
  if (!s || s.startsWith('-')) return '';
  return /^[A-Za-z0-9._:-]{1,128}$/.test(s) ? s : '';
}

function loadConfig(paths) {
  const raw = /** @type {Record<string, any>} */ (readSharedConfig(paths.configPath, DEFAULT_CONFIG));
  const adbTarget = sanitizeAdbTarget(raw.adbTarget);
  return {
    tvHost: sanitizeHost(raw.tvHost) ?? DEFAULT_CONFIG.tvHost,
    tvToken: typeof raw.tvToken === 'string' ? raw.tvToken.trim() : DEFAULT_CONFIG.tvToken,
    agentPort: sanitizePort(raw.agentPort) ?? DEFAULT_CONFIG.agentPort,
    dlnaPort: sanitizePort(raw.dlnaPort) ?? DEFAULT_CONFIG.dlnaPort,
    sshTarget: typeof raw.sshTarget === 'string' ? raw.sshTarget.trim() : DEFAULT_CONFIG.sshTarget,
    ...(adbTarget ? { adbTarget } : {}),
    appAliases: normalizeCustomAliases(raw.appAliases),
  };
}

function saveConfig(paths, cfg) {
  writeSharedConfig(paths.configPath, cfg);
}

/** Per-call effective config: stored config with optional per-call overrides. */
function effectiveConfig(args, paths) {
  const cfg = loadConfig(paths);
  const adbTarget = args.adbTarget !== undefined ? sanitizeAdbTarget(args.adbTarget) : (cfg.adbTarget ?? '');
  return {
    ...cfg,
    tvHost: sanitizeHost(args.tvHost) ?? cfg.tvHost,
    tvToken: typeof args.tvToken === 'string' ? args.tvToken.trim() : cfg.tvToken,
    agentPort: sanitizePort(args.agentPort) ?? cfg.agentPort,
    dlnaPort: sanitizePort(args.dlnaPort) ?? cfg.dlnaPort,
    sshTarget: typeof args.sshTarget === 'string' ? args.sshTarget.trim() : cfg.sshTarget,
    ...(adbTarget ? { adbTarget } : {}),
    appAliases: args.appAliases !== undefined
      ? { ...cfg.appAliases, ...normalizeCustomAliases(args.appAliases) }
      : cfg.appAliases,
  };
}

/**
 * Friday's runPlugin() strips every API_KEY / TOKEN / SECRET env var, so Decision API credentials
 * are resolved via args.apiKey, deps.getDecisionCredentials(), or ${SUPER_AGENT_HOME}/sdk/model-hub.json.
 */
export function resolveDecisionCredentials(args = {}, paths = {}, deps = {}) {
  const explicitKey = typeof args?.apiKey === 'string' ? args.apiKey.trim() : '';
  const explicitBase = typeof args?.baseUrl === 'string' ? args.baseUrl.trim() : '';
  if (explicitKey) {
    return { apiKey: explicitKey, baseUrl: explicitBase || DEFAULT_DECISION_BASE_URL };
  }
  const getCreds = typeof deps?.getDecisionCredentials === 'function'
    ? deps.getDecisionCredentials
    : (typeof paths?.getDecisionCredentials === 'function' ? paths.getDecisionCredentials : undefined);
  if (getCreds) {
    try {
      const hostCreds = getCreds();
      const hostKey = typeof hostCreds?.apiKey === 'string' ? hostCreds.apiKey.trim() : '';
      if (hostKey) {
        return {
          apiKey: hostKey,
          baseUrl: explicitBase || (typeof hostCreds?.baseUrl === 'string' ? hostCreds.baseUrl.trim() : '') || DEFAULT_DECISION_BASE_URL,
        };
      }
    } catch {
      /* fall through */
    }
  }
  const hubPath = deps?.modelHubPath ?? paths?.modelHubPath;
  if (hubPath) {
    try {
      const hub = JSON.parse(readFileSync(hubPath, 'utf8'));
      const apiKey = String(hub?.decision?.apiKey || hub?.providers?.google?.apiKey || '').trim();
      if (apiKey) {
        return {
          apiKey,
          baseUrl: explicitBase || String(hub?.decision?.baseUrl || '').trim() || DEFAULT_DECISION_BASE_URL,
        };
      }
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

export function resolveDecisionEndpoint(baseUrl) {
  const clean = String(baseUrl || DEFAULT_DECISION_BASE_URL).trim().replace(/\/+$/, '');
  if (clean.endsWith('/decisions')) return clean;
  if (/\/v\d+(?:alpha|beta)?$/i.test(clean)) return `${clean}/decisions`;
  return `${clean}/v1beta/decisions`;
}

// ---------------------------------------------------------------------------
// HTTP / SOAP primitives
// ---------------------------------------------------------------------------

function finiteNumber(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function makeCtx(args, deps) {
  const safeDeps = deps && typeof deps === 'object' ? deps : {};
  const paths = getRuntimePaths(safeDeps);
  const cfg = effectiveConfig(args, paths);
  const sleepFn = typeof safeDeps.sleep === 'function'
    ? safeDeps.sleep
    : (ms => delay(ms, undefined, safeDeps.signal ? { signal: safeDeps.signal } : undefined));
  return {
    args,
    deps: safeDeps,
    paths,
    cfg,
    aliases: buildAliasIndex(cfg.appAliases),
    fetchFn: safeDeps.fetch ?? globalThis.fetch,
    sleep: sleepFn,
    agentBase: cfg.tvHost ? `http://${cfg.tvHost}:${cfg.agentPort}` : '',
    dlnaBase: cfg.tvHost ? `http://${cfg.tvHost}:${cfg.dlnaPort}` : '',
  };
}

function buildRequestSignal(timeoutMs, externalSignal) {
  const safeTimeoutMs = finiteNumber(timeoutMs, AGENT_TIMEOUT_MS, 1, 300_000);
  const timerSignal = AbortSignal.timeout(safeTimeoutMs);
  if (!externalSignal) return timerSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([timerSignal, externalSignal]);
  }
  return timerSignal;
}

/**
 * @param {any} ctx
 * @param {string} url
 * @param {{ method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number }} [opts]
 */
async function httpRequest(ctx, url, { method = 'GET', body, headers = {}, timeoutMs = AGENT_TIMEOUT_MS } = {}) {
  /** @type {RequestInit & { headers: Record<string, string> }} */
  const init = {
    method,
    headers: { ...headers },
    signal: buildRequestSignal(timeoutMs, ctx.deps.signal),
  };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (typeof body !== 'string') init.headers['Content-Type'] = 'application/json';
  }
  const res = await ctx.fetchFn(url, init);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { ok: res.ok, status: res.status, text, json };
}

/** Never throws: returns { ok:false, error } on network failure. */
async function tryRequest(ctx, url, opts) {
  try {
    return await httpRequest(ctx, url, opts);
  } catch (err) {
    return { ok: false, status: 0, text: '', json: undefined, error: errMsg(err) };
  }
}

function agentHeaders(ctx, extra = {}) {
  if (!ctx.cfg.tvToken) return extra;
  return { ...extra, 'X-TV-Token': ctx.cfg.tvToken };
}

const TV_TOKEN_HEX_RE = /^[0-9a-f]{32,128}$/i;

function parsePairedTokenOutput(rawText) {
  const text = String(rawText ?? '');
  const dataMatch = text.match(/data="([0-9a-f]{32,128})"/i);
  if (dataMatch?.[1] && TV_TOKEN_HEX_RE.test(dataMatch[1])) {
    return dataMatch[1];
  }
  const plain = text.trim();
  if (TV_TOKEN_HEX_RE.test(plain)) {
    return plain;
  }
  return '';
}

async function defaultAdbRunner(adbArgs, timeoutMs = 4000, signal) {
  try {
    const { stdout, stderr } = await execFileAsync('adb', adbArgs, {
      encoding: 'utf8',
      timeout: timeoutMs,
      ...(signal ? { signal } : {}),
    });
    return { code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
  } catch (err) {
    const e = /** @type {{ code?: unknown; stdout?: unknown; stderr?: unknown; message?: string }} */ (err);
    return {
      code: typeof e?.code === 'number' ? e.code : 1,
      stdout: String(e?.stdout ?? ''),
      stderr: String(e?.stderr ?? e?.message ?? ''),
    };
  }
}

async function pairTvTokenViaAdbOrSsh(ctx) {
  if (ctx._tokenPairAttempted) return '';
  ctx._tokenPairAttempted = true;
  if (ctx.cfg.tvToken) return '';

  const adbTarget = sanitizeAdbTarget(ctx.cfg.adbTarget) || (ctx.cfg.tvHost ? `${ctx.cfg.tvHost}:5555` : '');
  const adbRunner = ctx.deps?.adbRunner ?? ((args, timeoutMs) => defaultAdbRunner(args, timeoutMs, ctx.deps?.signal));
  let token = '';

  if (adbTarget && (ctx.cfg.adbTarget || ctx.deps?.adbRunner || ctx.cfg.tvHost)) {
    if (adbTarget.includes(':')) {
      await adbRunner(['connect', adbTarget], 3000).catch(() => {});
    }
    const res = await adbRunner(
      ['-s', adbTarget, 'shell', 'am', 'broadcast', '-n', 'local.friday.tvagent/.TvAgentBootReceiver', '-a', 'local.friday.tvagent.GET_TOKEN'],
      4000,
    ).catch(() => null);
    token = parsePairedTokenOutput(res?.stdout);
  }

  if (!token && ctx.cfg.sshTarget) {
    const sshSpec = parseSshSpec(ctx.cfg.sshTarget, 'tv');
    if (sshSpec) {
      const targetArg = adbTarget || '127.0.0.1:5555';
      const cmd = `adb -s ${shellQuote(targetArg)} shell am broadcast -n local.friday.tvagent/.TvAgentBootReceiver -a local.friday.tvagent.GET_TOKEN`;
      const sshExec = ctx.deps?.sshTextExec ?? ((t, c, ms) => execSshText(t, c, {
        timeoutMs: ms,
        homeDir: ctx.paths?.homeDir,
        signal: ctx.deps?.signal,
      }));
      const sshRes = await sshExec(sshSpec, cmd, 5000).catch(() => null);
      token = parsePairedTokenOutput(sshRes?.stdout);
    }
  }

  if (!token) return '';
  ctx.cfg.tvToken = token;
  try {
    if (ctx.paths?.configPath) {
      await withFileLock(ctx.paths.configPath, () => {
        const persisted = loadConfig(ctx.paths);
        if (!persisted.tvToken) {
          saveConfig(ctx.paths, { ...persisted, tvToken: token });
        }
      });
    }
  } catch {
    // Best-effort cache; token remains valid for current call even if config dir isn't writable.
  }
  return token;
}

async function agentGet(ctx, path, timeoutMs = AGENT_TIMEOUT_MS) {
  if (!ctx.agentBase) {
    return { ok: false, status: 0, text: '', json: undefined, error: '未配置 tvHost' };
  }
  let res = await tryRequest(ctx, `${ctx.agentBase}${path}`, {
    timeoutMs,
    headers: agentHeaders(ctx),
  });
  if (res.status === 401 && !ctx.cfg.tvToken) {
    const paired = await pairTvTokenViaAdbOrSsh(ctx);
    if (paired) {
      res = await tryRequest(ctx, `${ctx.agentBase}${path}`, {
        timeoutMs,
        headers: agentHeaders(ctx),
      });
    }
  }
  return res;
}

async function agentAct(ctx, body, timeoutMs = AGENT_TIMEOUT_MS) {
  if (!ctx.agentBase) {
    return { ok: false, status: 0, detail: '未配置 tvHost', json: undefined };
  }
  let res = await tryRequest(ctx, `${ctx.agentBase}/act`, {
    method: 'POST',
    body,
    timeoutMs,
    headers: agentHeaders(ctx),
  });
  if (res.status === 401 && !ctx.cfg.tvToken) {
    const paired = await pairTvTokenViaAdbOrSsh(ctx);
    if (paired) {
      res = await tryRequest(ctx, `${ctx.agentBase}/act`, {
        method: 'POST',
        body,
        timeoutMs,
        headers: agentHeaders(ctx),
      });
    }
  }
  const ok = res.ok && res.json?.ok !== false;
  return { ok, status: res.status, detail: res.json?.detail ?? res.error ?? res.text.slice(0, 160), json: res.json };
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlTag(xml, tag) {
  const m = new RegExp(`<(?:[\\w-]+:)?${tag}(?:>|\\s[^>]*>)([\\s\\S]*?)</(?:[\\w-]+:)?${tag}\\s*>`, 'i').exec(xml);
  return m ? xmlUnescape(m[1].trim()) : undefined;
}

/**
 * UPnP SOAP call against the TV's DLNA renderer on :49152.
 * @param {'RenderingControl' | 'AVTransport'} service
 * @param {string} action
 * @param {Record<string, string | number>} params ordered argument map (values are XML-escaped here)
 */
async function soapCall(ctx, service, action, params = {}) {
  const urn = `urn:schemas-upnp-org:service:${service}:1`;
  const path = service === 'RenderingControl' ? RENDER_CONTROL : AV_TRANSPORT;
  const inner = Object.entries(params).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('');
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${urn}">${inner}</u:${action}></s:Body></s:Envelope>`;
  const res = await httpRequest(ctx, `${ctx.dlnaBase}${path}`, {
    method: 'POST',
    body,
    timeoutMs: SOAP_TIMEOUT_MS,
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: `"${urn}#${action}"`,
    },
  });
  if (!res.ok) {
    const desc = xmlTag(res.text, 'errorDescription');
    const code = xmlTag(res.text, 'errorCode');
    throw new Error(`SOAP ${service}#${action} HTTP ${res.status}${code ? ` UPnP ${code}` : ''}${desc ? ` ${desc}` : ''}`);
  }
  return res.text;
}

// ---------------------------------------------------------------------------
// Probing / status
// ---------------------------------------------------------------------------

async function probe(ctx) {
  const [agent, dlna] = await Promise.all([
    agentGet(ctx, '/status', PROBE_TIMEOUT_MS),
    tryRequest(ctx, `${ctx.dlnaBase}/description.xml`, { timeoutMs: PROBE_TIMEOUT_MS }),
  ]);
  const agentOk = Boolean(agent.ok && agent.json && agent.json.ok !== false);
  const agentStatus = agentOk ? agent.json : undefined;
  const dlnaOk = Boolean(dlna.ok);
  const awake = agentOk ? agentStatus.awake !== false : undefined;
  return {
    agentOk,
    agentStatus,
    dlnaOk,
    dlnaXml: dlnaOk ? dlna.text : undefined,
    online: (agentOk && awake !== false) || dlnaOk,
  };
}

function appLabel(apps, pkg) {
  if (!pkg || !Array.isArray(apps)) return undefined;
  return apps.find(a => a?.package === pkg)?.label;
}

async function handleStatus(ctx) {
  const p = await probe(ctx);
  let volume;
  let muted;
  let volumeSource;
  let friendlyName;
  if (p.dlnaOk) {
    friendlyName = xmlTag(p.dlnaXml ?? '', 'friendlyName');
    try {
      const xml = await soapCall(ctx, 'RenderingControl', 'GetVolume', { InstanceID: 0, Channel: 'Master' });
      const v = Number(xmlTag(xml, 'CurrentVolume'));
      if (Number.isFinite(v)) {
        volume = v;
        volumeSource = 'dlna';
      }
    } catch { /* ignore */ }
    try {
      const xml = await soapCall(ctx, 'RenderingControl', 'GetMute', { InstanceID: 0, Channel: 'Master' });
      const m = xmlTag(xml, 'CurrentMute');
      if (m !== undefined) muted = m === '1' || m.toLowerCase() === 'true';
    } catch { /* ignore */ }
  }
  const st = p.agentStatus;
  if (volume === undefined && st && Number.isFinite(Number(st.volume))) {
    volume = Number(st.volume);
    volumeSource = 'agent';
  }
  const powerState = p.online ? 'online' : 'standby_or_off';
  const pkg = st?.packageName || undefined;
  const apps = Array.isArray(st?.apps) ? st.apps : [];
  const data = {
    tvHost: ctx.cfg.tvHost,
    powerState,
    agentReachable: p.agentOk,
    dlnaReachable: p.dlnaOk,
    awake: st?.awake,
    a11yBound: st?.a11yBound,
    guardedLauncherEnabled: st?.guardedLauncherEnabled,
    packageName: pkg,
    appName: appLabel(apps, pkg),
    className: st?.className,
    volume,
    maxVolume: volumeSource === 'dlna' ? 100 : st?.maxVolume,
    volumeSource,
    muted,
    friendlyName,
    apps,
  };
  if (!p.online) {
    return success('电视状态', `电视处于关机/待机状态（${ctx.cfg.tvHost} 的 :${ctx.cfg.agentPort} 与 :${ctx.cfg.dlnaPort} 均无响应）。`, data);
  }
  const parts = [`电视在线`];
  if (pkg) parts.push(`前台 ${data.appName ? `${data.appName} (${pkg})` : pkg}`);
  if (volume !== undefined) parts.push(`音量 ${volume}${muted ? '（静音）' : ''}`);
  if (st && st.a11yBound === false) parts.push('无障碍服务未绑定');
  if (!p.agentOk) parts.push('Agent :8989 无响应（仅 DLNA 可用）');
  return success('电视状态', parts.join('，') + '。', data);
}

// ---------------------------------------------------------------------------
// power (idempotent)
// ---------------------------------------------------------------------------

function defaultIrRunner(ctx, action, args) {
  if (typeof ctx.deps.callPlugin === 'function') {
    return ctx.deps.callPlugin('tv-ir', action, args);
  }
  return import('../tv-ir/index.mjs').then(mod =>
    mod.executeTvIrAction(action, args, {
      homeDir: ctx.paths.homeDir,
      signal: ctx.deps.signal,
    }),
  );
}

async function runIr(ctx, action, args) {
  const sshTarget = String(ctx.args.sshTarget ?? ctx.cfg.sshTarget ?? '').trim();
  const fullArgs = sshTarget && !args.sshTarget ? { ...args, sshTarget } : args;
  if (ctx.deps.irRunner) {
    return ctx.deps.irRunner(action, fullArgs);
  }
  return defaultIrRunner(ctx, action, fullArgs);
}

async function handlePower(ctx) {
  const { args } = ctx;
  const state = String(args.state ?? 'toggle').trim().toLowerCase();
  const wanted = ['on', '开', '开机'].includes(state) ? 'on'
    : ['off', '关', '关机', 'standby', '待机'].includes(state) ? 'off'
      : state === 'toggle' ? 'toggle' : undefined;
  if (!wanted) {
    return failure('电视电源', `不支持的电源状态 "${state}"，可用：on、off、toggle。`);
  }
  const waitMs = finiteNumber(args.waitMs, 22000, 0, 120_000);
  const pollMs = finiteNumber(ctx.deps.pollMs ?? args.pollMs, 1500, 1, 30_000);
  const first = await probe(ctx);
  const target = wanted === 'toggle' ? (first.online ? 'off' : 'on') : wanted;

  if (target === 'on') {
    if (first.online) {
      const wake = await agentAct(ctx, { action: 'wake' });
      return success('电视电源', '电视已处于开机状态', { irSent: false, wake: wake.ok, powerState: 'online' });
    }
    if (first.agentOk) {
      // Agent alive but screen dark: try a software wake before spending an IR toggle.
      await agentAct(ctx, { action: 'wake' });
      await ctx.sleep(Math.min(1500, pollMs));
      const again = await probe(ctx);
      if (again.online) {
        return success('电视电源', '电视已唤醒（无需红外）', { irSent: false, wake: true, powerState: 'online' });
      }
    }
    const ir = await runIr(ctx, 'press', { key: 'power' });
    if (!ir || ir.ok === false) {
      return failure('电视开机失败', `红外电源键发送失败：${ir?.message ?? '未知错误'}`, { irSent: false, ir });
    }
    const polls = Math.max(1, Math.ceil(waitMs / pollMs));
    for (let i = 0; i < polls; i++) {
      await ctx.sleep(pollMs);
      const p = await probe(ctx);
      if (p.online) {
        if (p.agentOk) await agentAct(ctx, { action: 'wake' });
        return success('电视电源', '电视已开机', { irSent: true, powerState: 'online', polls: i + 1 });
      }
    }
    return failure('电视开机超时', `已发送红外电源键，但 ${Math.round(waitMs / 1000)} 秒内电视未上线。`, { irSent: true, powerState: 'standby_or_off' });
  }

  // target === 'off'
  if (!first.online) {
    return success('电视电源', '电视已处于关机/待机状态', { irSent: false, powerState: 'standby_or_off' });
  }
  const ir = await runIr(ctx, 'press', { key: 'power' });
  if (!ir || ir.ok === false) {
    return failure('电视关机失败', `红外电源键发送失败：${ir?.message ?? '未知错误'}`, { irSent: false, ir });
  }
  const offWaitMs = finiteNumber(args.offWaitMs, 8000, 0, 120_000);
  const polls = Math.ceil(offWaitMs / pollMs);
  for (let i = 0; i < polls; i++) {
    await ctx.sleep(pollMs);
    const p = await probe(ctx);
    if (!p.online) {
      return success('电视电源', '电视已关机/进入待机', { irSent: true, powerState: 'standby_or_off', polls: i + 1 });
    }
  }
  return success('电视电源', '已发送红外电源键（尚未确认进入待机）', { irSent: true, powerState: 'unknown' });
}

// ---------------------------------------------------------------------------
// volume (DLNA RenderingControl, IR fallback)
// ---------------------------------------------------------------------------

const clampVolume = n => Math.max(0, Math.min(100, Math.round(n)));

async function dlnaGetVolume(ctx) {
  const xml = await soapCall(ctx, 'RenderingControl', 'GetVolume', { InstanceID: 0, Channel: 'Master' });
  const v = Number(xmlTag(xml, 'CurrentVolume'));
  if (!Number.isFinite(v)) throw new Error('GetVolume 响应缺少 CurrentVolume');
  return v;
}

async function dlnaGetMute(ctx) {
  const xml = await soapCall(ctx, 'RenderingControl', 'GetMute', { InstanceID: 0, Channel: 'Master' });
  const m = xmlTag(xml, 'CurrentMute');
  return m === '1' || String(m).toLowerCase() === 'true';
}

async function handleVolume(ctx) {
  const { args } = ctx;
  const hasLevel = args.level !== undefined && args.level !== null && args.level !== '';
  const hasDelta = args.delta !== undefined && args.delta !== null && args.delta !== '';
  const hasMute = args.mute !== undefined && args.mute !== null;
  const level = hasLevel ? Number(args.level) : undefined;
  const delta = hasDelta ? Number(args.delta) : undefined;
  if ((hasLevel && !Number.isFinite(level)) || (hasDelta && !Number.isFinite(delta))) {
    return failure('电视音量', 'level / delta 必须是数字。');
  }
  const data = {};

  try {
    if (hasMute) {
      const mute = args.mute === true || args.mute === 'true' || args.mute === 1 || args.mute === '1';
      await soapCall(ctx, 'RenderingControl', 'SetMute', { InstanceID: 0, Channel: 'Master', DesiredMute: mute ? 1 : 0 });
      data.muted = mute;
    }
    if (hasLevel || hasDelta) {
      const before = await dlnaGetVolume(ctx);
      const target = clampVolume(hasLevel ? level : before + delta);
      await soapCall(ctx, 'RenderingControl', 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: target });
      data.before = before;
      data.volume = target;
    } else {
      data.volume = await dlnaGetVolume(ctx);
    }
    if (!hasMute) {
      try { data.muted = await dlnaGetMute(ctx); } catch { /* optional */ }
    }
    data.via = 'dlna';
    const parts = [];
    if (data.before !== undefined) parts.push(`音量 ${data.before} → ${data.volume}`);
    else parts.push(`当前音量 ${data.volume}`);
    if (data.muted !== undefined) parts.push(data.muted ? '已静音' : '未静音');
    return success('电视音量', parts.join('，'), data);
  } catch (err) {
    return volumeFallback(ctx, { hasLevel, hasDelta, hasMute, level, delta }, errMsg(err));
  }
}

async function volumeFallback(ctx, { hasLevel, hasDelta, hasMute, level, delta }, dlnaError) {
  if (hasMute && !hasLevel && !hasDelta) {
    return failure('电视音量', `DLNA 静音控制失败（${dlnaError}），红外无独立静音键。`);
  }
  const muteNotice = hasMute ? '；注意：DLNA 不可用，静音状态未变更' : '';
  if (!hasLevel && !hasDelta) {
    const st = await agentGet(ctx, '/status', PROBE_TIMEOUT_MS);
    if (st.ok && Number.isFinite(Number(st.json?.volume))) {
      return success('电视音量', `当前音量 ${st.json.volume}（来自 Agent）`, { volume: Number(st.json.volume), via: 'agent', maxVolume: st.json.maxVolume });
    }
    return failure('电视音量', `读取音量失败：${dlnaError}`);
  }
  let steps;
  if (hasDelta) {
    steps = Math.round(delta);
  } else {
    const st = await agentGet(ctx, '/status', PROBE_TIMEOUT_MS);
    const cur = Number(st.json?.volume);
    if (!st.ok || !Number.isFinite(cur)) {
      return failure('电视音量', `DLNA 失败（${dlnaError}）且无法从 Agent 读取当前音量，无法用红外定位到 ${level}。`);
    }
    const maxVolRaw = Number(st.json?.maxVolume);
    const maxVol = Number.isFinite(maxVolRaw) && maxVolRaw > 0 ? maxVolRaw : 15;
    const targetStep = Math.round((clampVolume(level) / 100) * maxVol);
    steps = targetStep - cur;
  }
  if (steps === 0) {
    return success('电视音量', `音量已在目标位置${muteNotice}`, {
      via: 'ir',
      steps: 0,
      ...(hasMute ? { muteIgnored: true } : {}),
    });
  }
  const key = steps > 0 ? 'vol_up' : 'vol_down';
  const count = Math.min(30, Math.abs(steps));
  const ir = await runIr(ctx, 'press', { key, count });
  if (!ir || ir.ok === false) {
    return failure('电视音量', `DLNA 失败（${dlnaError}），红外回退也失败：${ir?.message ?? '未知错误'}`);
  }
  return success('电视音量', `已通过红外 ${key} ×${count}（DLNA 不可用：${dlnaError}${muteNotice}）`, {
    via: 'ir',
    key,
    count,
    ...(hasMute ? { muteIgnored: true } : {}),
  });
}

// ---------------------------------------------------------------------------
// cast (DLNA AVTransport)
// ---------------------------------------------------------------------------

function guessMedia(url) {
  const path = String(url).split(/[?#]/)[0].toLowerCase();
  if (/\.(mp3|flac|aac|m4a|wav|ogg|opus)$/.test(path)) return { cls: 'object.item.audioItem.musicTrack', mime: 'audio/mpeg' };
  if (/\.(jpe?g|png|gif|webp|bmp)$/.test(path)) return { cls: 'object.item.imageItem.photo', mime: 'image/jpeg' };
  if (/\.m3u8$/.test(path)) return { cls: 'object.item.videoItem', mime: 'application/vnd.apple.mpegurl' };
  return { cls: 'object.item.videoItem', mime: 'video/mp4' };
}

export function buildDidlLite(url, title) {
  if (!title) return '';
  const { cls, mime } = guessMedia(url);
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    `<item id="0" parentID="-1" restricted="1"><dc:title>${xmlEscape(title)}</dc:title>` +
    `<upnp:class>${cls}</upnp:class>` +
    `<res protocolInfo="http-get:*:${mime}:*">${xmlEscape(url)}</res></item></DIDL-Lite>`
  );
}

export function formatRelTime(value) {
  const s = String(value ?? '').trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const total = Math.floor(Number(s));
    return `${Math.floor(total / 3600)}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }
  const parts = s.split(':').map(p => Number(p));
  if ((parts.length === 2 || parts.length === 3) && parts.every(n => Number.isFinite(n) && n >= 0)) {
    const [h, m, sec] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
    return `${Math.floor(h)}:${String(Math.floor(m)).padStart(2, '0')}:${String(Math.floor(sec)).padStart(2, '0')}`;
  }
  return undefined;
}

async function handleCast(ctx) {
  const { args } = ctx;
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  const op = String(args.op ?? (url ? 'play' : 'info')).trim().toLowerCase();
  const AV = (action, params = {}) => soapCall(ctx, 'AVTransport', action, { InstanceID: 0, ...params });
  try {
    switch (op) {
      case 'play': {
        if (url) {
          if (!/^https?:\/\//i.test(url)) return failure('电视投屏', '投屏 url 必须以 http:// 或 https:// 开头。');
          await AV('SetAVTransportURI', {
            CurrentURI: url,
            CurrentURIMetaData: buildDidlLite(url, typeof args.title === 'string' ? args.title.trim() : ''),
          });
        }
        await AV('Play', { Speed: 1 });
        return success('电视投屏', url ? `已投屏并开始播放：${args.title || url}` : '已继续播放', { op, url: url || undefined });
      }
      case 'resume':
        await AV('Play', { Speed: 1 });
        return success('电视投屏', '已继续播放', { op });
      case 'pause':
        await AV('Pause');
        return success('电视投屏', '已暂停', { op });
      case 'stop':
        await AV('Stop');
        return success('电视投屏', '已停止投屏', { op });
      case 'seek': {
        const target = formatRelTime(args.position);
        if (!target) return failure('电视投屏', 'seek 需要 position（秒数或 mm:ss / hh:mm:ss）。');
        await AV('Seek', { Unit: 'REL_TIME', Target: target });
        return success('电视投屏', `已跳转到 ${target}`, { op, position: target });
      }
      case 'info': {
        const transport = await AV('GetTransportInfo');
        const info = {
          transportState: xmlTag(transport, 'CurrentTransportState'),
          transportStatus: xmlTag(transport, 'CurrentTransportStatus'),
        };
        try {
          const pos = await AV('GetPositionInfo');
          info.trackUri = xmlTag(pos, 'TrackURI');
          info.relTime = xmlTag(pos, 'RelTime');
          info.duration = xmlTag(pos, 'TrackDuration');
        } catch { /* position optional */ }
        return success(
          '电视投屏状态',
          `投屏状态 ${info.transportState ?? 'UNKNOWN'}${info.relTime ? `，进度 ${info.relTime}/${info.duration ?? '?'}` : ''}`,
          { op, ...info },
        );
      }
      default:
        return failure('电视投屏', `不支持的 cast 操作 "${op}"，可用：play、pause、resume、stop、seek、info。`);
    }
  } catch (err) {
    return failure('电视投屏失败', `DLNA ${op} 失败：${errMsg(err)}`);
  }
}

// ---------------------------------------------------------------------------
// open_app
// ---------------------------------------------------------------------------

export function resolveAliasPackage(query, customAliases = {}) {
  const key = normalizeAlias(query);
  if (!customAliases || typeof customAliases !== 'object' || Object.keys(customAliases).length === 0) {
    return ALIAS_MAP.get(key);
  }
  return buildAliasIndex(customAliases).aliasMap.get(key);
}

async function resolveAppPackage(ctx, query) {
  const q = String(query ?? '').trim();
  if (!q) return { error: '缺少 app 参数。' };
  const alias = ctx.aliases.aliasMap.get(normalizeAlias(q));
  if (alias) return { package: alias, via: 'alias' };
  if (q.includes('.') && /^[A-Za-z0-9_.]+$/.test(q)) return { package: q, via: 'package' };
  const st = await agentGet(ctx, '/status');
  const apps = Array.isArray(st.json?.apps) ? st.json.apps : [];
  if (!apps.length) return { error: `无法识别应用 "${q}"，且未能从电视读取已安装应用列表${st.error ? `（${st.error}）` : ''}。` };
  const lq = q.toLowerCase();
  const labelOf = a => String(a.label ?? '').toLowerCase();
  const hit =
    apps.find(a => labelOf(a) === lq) ||
    apps.find(a => labelOf(a).includes(lq)) ||
    apps.find(a => labelOf(a).length >= 2 && lq.includes(labelOf(a))) ||
    apps.find(a => String(a.package ?? '').toLowerCase().includes(lq));
  if (!hit) return { error: `电视上没有找到匹配 "${q}" 的应用。` };
  return { package: hit.package, label: hit.label, via: 'fuzzy' };
}

async function openApp(ctx, query, uri) {
  const resolved = await resolveAppPackage(ctx, query);
  if (resolved.error) return failure('打开应用失败', resolved.error);
  const body = uri
    ? { action: 'open_uri', uri: String(uri), package: resolved.package }
    : { action: 'launch_app', package: resolved.package };
  const res = await agentAct(ctx, body);
  if (!res.ok) {
    return failure('打开应用失败', `启动 ${resolved.package} 失败：${res.detail || `HTTP ${res.status}`}`, { package: resolved.package, via: resolved.via });
  }
  const name = resolved.label ?? query;
  return success('打开应用', `已${uri ? '打开链接于' : '启动'} ${name} (${resolved.package})`, {
    package: resolved.package,
    via: resolved.via,
    action: body.action,
    detail: res.detail,
  });
}

async function handleOpenApp(ctx) {
  const query = ctx.args.app ?? ctx.args.package ?? ctx.args.name;
  return openApp(ctx, query, ctx.args.uri);
}

// ---------------------------------------------------------------------------
// tree / screenshot / act / config
// ---------------------------------------------------------------------------

async function handleTree(ctx) {
  const maxNodes = Math.max(1, Math.min(300, Math.round(Number(ctx.args.maxNodes ?? 80)) || 80));
  const res = await agentGet(ctx, `/tree?maxNodes=${maxNodes}`);
  if (!res.ok || !res.json) return failure('读取界面树失败', `GET /tree 失败：${res.error ?? `HTTP ${res.status}`}`);
  const nodes = Array.isArray(res.json.nodes) ? res.json.nodes : [];
  return success('电视界面树', `前台 ${res.json.packageName || '未知'}，${nodes.length} 个节点。`, res.json);
}

function resolveSafeScreenshotPath(screenshotsDir, rawSavePath) {
  mkdirSync(screenshotsDir, { recursive: true, mode: 0o700 });
  const realRoot = realpathSync(screenshotsDir);
  const trimmed = String(rawSavePath || '').trim();
  const candidate = isAbsolute(trimmed) ? resolve(trimmed) : resolve(screenshotsDir, trimmed);

  const logicalRel = relative(resolve(screenshotsDir), candidate);
  if (!logicalRel || logicalRel === '.' || logicalRel.startsWith('..') || isAbsolute(logicalRel)) {
    return { error: 'savePath 必须位于插件 screenshots 目录内，拒绝越界路径。' };
  }

  let checkDir = dirname(candidate);
  while (checkDir !== dirname(checkDir)) {
    try {
      const realAncestor = realpathSync(checkDir);
      const rel = relative(realRoot, realAncestor);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        return { error: 'savePath 祖先目录指向沙箱外路径，已拒绝。' };
      }
      break;
    } catch {
      checkDir = dirname(checkDir);
    }
  }

  mkdirSync(dirname(candidate), { recursive: true, mode: 0o700 });
  const realParent = realpathSync(dirname(candidate));
  const parentRel = relative(realRoot, realParent);
  if (parentRel.startsWith('..') || isAbsolute(parentRel)) {
    return { error: 'savePath 目标目录越界，已拒绝。' };
  }
  const safePath = join(realRoot, parentRel, basename(candidate));
  try {
    const leafStat = lstatSync(safePath);
    if (leafStat.isSymbolicLink()) {
      return { error: 'savePath 目标文件为符号链接，已拒绝。' };
    }
    if (leafStat.isDirectory()) {
      return { error: 'savePath 目标为目录，不能覆盖写入。' };
    }
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') {
      return { error: `校验 savePath 失败：${errMsg(err)}` };
    }
  }
  return { path: safePath };
}

function writeFileNoFollow(filePath, dataBuffer, mode = 0o600) {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(filePath, flags, mode);
  try {
    writeSync(fd, dataBuffer);
  } finally {
    closeSync(fd);
  }
}

async function handleScreenshot(ctx) {
  const maxWidth = Math.max(160, Math.min(1920, Math.round(Number(ctx.args.maxWidth ?? 960)) || 960));
  const quality = Math.max(20, Math.min(95, Math.round(Number(ctx.args.quality ?? 70)) || 70));
  let safeSave;
  if (typeof ctx.args.savePath === 'string' && ctx.args.savePath.trim()) {
    safeSave = resolveSafeScreenshotPath(ctx.paths.screenshotsDir, ctx.args.savePath);
    if (safeSave.error) return failure('电视截图失败', safeSave.error);
  }
  const res = await agentGet(ctx, `/screenshot?maxWidth=${maxWidth}&quality=${quality}`, 10_000);
  if (!res.ok || !res.json?.base64) return failure('电视截图失败', `GET /screenshot 失败：${res.error ?? res.json?.error ?? `HTTP ${res.status}`}`);
  const { base64, ...meta } = res.json;
  const data = { ...meta, bytes: Buffer.byteLength(base64, 'base64') };
  if (safeSave?.path) {
    writeFileNoFollow(safeSave.path, Buffer.from(base64, 'base64'), 0o600);
    data.savedTo = safeSave.path;
  }
  if (ctx.args.includeBase64 === true) data.base64 = base64;
  return success('电视截图', `截图 ${meta.width ?? '?'}x${meta.height ?? '?'}，${data.bytes} 字节${data.savedTo ? `，已保存到 ${data.savedTo}` : ''}。`, data);
}

async function handleAct(ctx) {
  const { apiKey: _k, tvHost: _h, tvToken: _t, agentPort: _p, dlnaPort: _d, sshTarget: _s, adbTarget: _adb, appAliases: _a, ...rest } = ctx.args;
  const body = rest.body && typeof rest.body === 'object' ? rest.body : rest;
  if (!body.action || typeof body.action !== 'string') {
    return failure('电视操作', 'act 需要 action（wake/global/click/focus/set_text/scroll/launch_app/open_uri）。');
  }
  const res = await agentAct(ctx, body);
  if (!res.ok) return failure('电视操作失败', `POST /act ${body.action} 失败：${res.detail || `HTTP ${res.status}`}`, res.json);
  return success('电视操作', `${body.action} 成功${res.detail ? `：${res.detail}` : ''}`, res.json);
}

function redactConfigView(cfg) {
  return {
    tvHost: cfg.tvHost,
    tvToken: cfg.tvToken ? '***' : '',
    hasToken: Boolean(cfg.tvToken),
    agentPort: cfg.agentPort,
    dlnaPort: cfg.dlnaPort,
    sshTarget: cfg.sshTarget,
    ...(cfg.adbTarget ? { adbTarget: cfg.adbTarget } : {}),
    appAliases: cfg.appAliases,
  };
}

async function handleConfig(ctx) {
  const { args, paths } = ctx;
  const lockResult = await withFileLock(paths.configPath, () => {
    const current = loadConfig(paths);
    const draft = { ...current };
    const mods = [];
    if (args.tvHost !== undefined) {
      const rawHost = String(args.tvHost ?? '').trim();
      if (!rawHost) {
        draft.tvHost = '';
        mods.push('tvHost');
      } else {
        const host = sanitizeHost(rawHost);
        if (!host) return { error: failure('电视配置', 'tvHost 无效（仅支持主机名或 IP）。') };
        draft.tvHost = host;
        mods.push('tvHost');
      }
    }
    if (args.tvToken !== undefined) {
      draft.tvToken = String(args.tvToken ?? '').trim();
      mods.push('tvToken');
    }
    for (const key of ['agentPort', 'dlnaPort']) {
      if (args[key] !== undefined) {
        const port = sanitizePort(args[key]);
        if (!port) return { error: failure('电视配置', `${key} 必须是 1-65535 的整数。`) };
        draft[key] = port;
        mods.push(key);
      }
    }
    if (args.sshTarget !== undefined) {
      draft.sshTarget = String(args.sshTarget ?? '').trim();
      mods.push('sshTarget');
    }
    if (args.adbTarget !== undefined) {
      const rawAdb = String(args.adbTarget ?? '').trim();
      if (!rawAdb) {
        delete draft.adbTarget;
        mods.push('adbTarget');
      } else {
        const cleanAdb = sanitizeAdbTarget(rawAdb);
        if (!cleanAdb) return { error: failure('电视配置', 'adbTarget 无效（示例 192.168.1.50:5555）。') };
        draft.adbTarget = cleanAdb;
        mods.push('adbTarget');
      }
    }
    if (args.appAliases !== undefined) {
      if (!args.appAliases || typeof args.appAliases !== 'object' || Array.isArray(args.appAliases)) {
        return { error: failure('电视配置', 'appAliases 必须是 JSON 对象（包名 -> 别名数组，或 别名 -> 包名）。') };
      }
      draft.appAliases = normalizeCustomAliases(args.appAliases);
      mods.push('appAliases');
    }
    if (mods.length) saveConfig(paths, draft);
    return { next: draft, changed: mods };
  });
  if (lockResult.error) return lockResult.error;
  const { next, changed } = lockResult;
  if (args.pair === true && !next.tvToken && (next.adbTarget || next.sshTarget || next.tvHost)) {
    const pairCtx = { ...ctx, cfg: { ...next }, _tokenPairAttempted: false };
    const paired = await pairTvTokenViaAdbOrSsh(pairCtx);
    if (paired) {
      next.tvToken = paired;
      changed.push('tvToken');
    }
  }
  return success('电视配置', changed.length ? `已更新：${changed.join('、')}` : '当前电视配置', redactConfigView(next));
}

// ---------------------------------------------------------------------------
// navigate (gemini-decision-1 observe/act loop)
// ---------------------------------------------------------------------------

function nodeLabel(n) {
  return String(n.text || n.desc || '').replace(/\s+/g, ' ').trim();
}

function shortViewId(n) {
  const v = String(n.viewId ?? '');
  const idx = v.lastIndexOf('/');
  return idx >= 0 ? v.slice(idx + 1) : v;
}

function nodeKey(n, i) {
  return typeof n.id === 'string' && n.id ? n.id : `n${i}`;
}

function flags(n) {
  const f = [];
  if (n.focused) f.push('focused');
  if (n.selected) f.push('selected');
  if (n.clickable) f.push('clickable');
  if (n.editable) f.push('editable');
  if (n.scrollable) f.push('scrollable');
  return f;
}

function describeNode(n, i, maxLabel = 40) {
  const label = nodeLabel(n).slice(0, maxLabel);
  const bounds = Array.isArray(n.bounds) ? `[${n.bounds.join(',')}]` : '';
  const parts = [nodeKey(n, i)];
  if (label) parts.push(`"${label}"`);
  const vid = shortViewId(n);
  if (vid) parts.push(`#${vid}`);
  const f = flags(n);
  if (f.length) parts.push(f.join('/'));
  if (bounds) parts.push(bounds);
  return parts.join(' ');
}

export function stateFingerprint(tree) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  const compact = nodes.map(n => `${nodeLabel(n)}|${n.focused ? 'F' : ''}${n.selected ? 'S' : ''}|${Array.isArray(n.bounds) ? n.bounds.join(',') : ''}`).join(';');
  return createHash('sha1').update(`${tree?.packageName ?? ''}\n${compact}`).digest('hex').slice(0, 16);
}

function extractQuoted(goal) {
  const m = /[「“"'《『]([^」”"'》』]{1,60})[」”"'》』]/.exec(goal);
  return m ? m[1].trim() : undefined;
}

/** Package named in the goal (aliases only), regardless of where the goal says to find it. */
function detectGoalApp(ctx, goal) {
  const lower = goal.toLowerCase();
  for (const alias of ctx.aliases.goalAliases) {
    if (lower.includes(alias)) return ctx.aliases.aliasMap.get(normalizeAlias(alias));
  }
  return undefined;
}

const OPEN_VERB_RE = /打开|启动|进入|开启|运行|\bopen\b|\blaunch\b|\bstart\b/i;
const EXTRA_TASK_RE = /搜索|搜一|搜下|播放|放一|观看|看看|看一|看推荐|关注|收藏|登录|\bsearch\b|\bplay\b|\bwatch\b/i;

/** True when the goal only asks to open an app (no search/play follow-up), so foreground == target means done. */
export function isOpenOnlyGoal(goal) {
  return OPEN_VERB_RE.test(goal) && !EXTRA_TASK_RE.test(goal);
}

/** Build the choice criteria map and the action table for one tree snapshot. */
export function buildNextActionCriteria(tree, { searchText, allowScreenshot, exclude }) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  const criteria = {};
  const actions = {};
  const addNode = (prefix, node, i, desc, body) => {
    const key = `${prefix}_${nodeKey(node, i)}`;
    if (Object.keys(criteria).length >= MAX_CHOICES - 12) return;
    criteria[key] = desc;
    actions[key] = body;
  };

  let clickCount = 0;
  const clickable = [];
  nodes.forEach((n, i) => {
    if (n.clickable || n.focused || n.selected) clickable.push([n, i]);
  });
  const pool = clickable.length ? clickable : nodes.map((n, i) => [n, i]).filter(([n]) => nodeLabel(n));
  for (const [n, i] of pool) {
    if (clickCount >= MAX_CLICK_CHOICES) break;
    if (n.editable && searchText) continue; // typed into, not clicked
    addNode('click', n, i, `点击 ${describeNode(n, i)}`, { action: 'click', id: nodeKey(n, i) });
    clickCount++;
  }

  let typeCount = 0;
  if (searchText) {
    const isSearchBox = n => /search|搜索|查找|query/i.test(`${n.viewId ?? ''} ${n.desc ?? ''} ${n.text ?? ''}`);
    const editable = nodes.map((n, i) => [n, i]).filter(([n]) => n.editable);
    const boxes = editable.length ? editable : nodes.map((n, i) => [n, i]).filter(([n]) => isSearchBox(n));
    for (const [n, i] of boxes.slice(0, 4)) {
      addNode('type', n, i, `在 ${describeNode(n, i)} 中输入搜索词 "${searchText}"`, { action: 'set_text', id: nodeKey(n, i), text: searchText });
      typeCount++;
    }
    if (!typeCount) {
      criteria.type_focused = `向当前焦点/首个输入框输入搜索词 "${searchText}"`;
      actions.type_focused = { action: 'set_text', text: searchText };
    }
  }

  criteria.scroll_down = '向下滚动/翻页';
  actions.scroll_down = { action: 'scroll', direction: 'down' };
  criteria.scroll_up = '向上滚动/翻页';
  actions.scroll_up = { action: 'scroll', direction: 'up' };
  criteria.scroll_right = '向右滚动（横向列表）';
  actions.scroll_right = { action: 'scroll', direction: 'right' };
  criteria.scroll_left = '向左滚动（横向列表）';
  actions.scroll_left = { action: 'scroll', direction: 'left' };
  for (const dir of ['up', 'down', 'left', 'right']) {
    criteria[`dpad_${dir}`] = `遥控器方向键 ${dir}（移动焦点一格，用于滚动无效或目标在焦点${{ up: '上方', down: '下方', left: '左侧', right: '右侧' }[dir]}时）`;
    actions[`dpad_${dir}`] = { action: 'global', name: `dpad_${dir}` };
  }
  criteria.dpad_center = '遥控器确认键（点击当前焦点项）';
  actions.dpad_center = { action: 'global', name: 'dpad_center' };
  criteria.key_back = '按返回键';
  actions.key_back = { action: 'global', name: 'back' };
  criteria.key_home = '回到桌面主页';
  actions.key_home = { action: 'global', name: 'home' };
  if (allowScreenshot) criteria.request_screenshot = '界面文字信息不足或不确定，需要查看屏幕截图再决定';
  criteria.done_now = 'Goal is already satisfied on screen, no further action needed';
  criteria.abort_impossible = 'Screen shows an unrecoverable blocker such as QR login wall or missing content';
  // Actions already tried on this exact screen state had no effect: do not offer them again.
  if (exclude) {
    for (const key of exclude) {
      if (key in actions) {
        delete criteria[key];
        delete actions[key];
      }
    }
  }
  return { criteria, actions };
}

function buildContextText(ctx, { goal, searchText, tree, history, hasScreenshot }) {
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  const lines = [
    '你在操控一台安卓电视（遥控器式 UI，焦点移动 + 点击）。',
    `用户目标: ${goal}`,
  ];
  if (searchText) lines.push(`需要输入的搜索词: ${searchText}`);
  lines.push(`前台应用包名: ${tree?.packageName || '未知'}`, `界面节点数: ${nodes.length}`);
  if (hasScreenshot) lines.push('已附带当前屏幕截图，请结合截图与节点判断。');
  lines.push('提示：若目标未出现在可见节点中，横向列表/行的两侧可能有屏幕外的隐藏项；焦点靠近行首（bounds 左边界很小）时优先尝试 dpad_left / scroll_left，靠近行尾时尝试 dpad_right / scroll_right，再不行才考虑 dpad_up/dpad_down 换行。');
  lines.push('界面节点（id "文字" #viewId 标记 [l,t,r,b]）：');
  nodes.slice(0, 60).forEach((n, i) => lines.push(describeNode(n, i, 60)));
  if (history.length) {
    lines.push('已执行动作（避免重复无效动作）：');
    history.slice(-6).forEach(h => lines.push(`- 第${h.step}步 ${h.choice}${h.unchanged ? '（界面无变化，无效）' : ''}`));
  }
  return lines.join('\n');
}

function resolveChoice(answer, validKeys) {
  if (!answer) return {};
  if (typeof answer.choice === 'string' && validKeys.has(answer.choice)) {
    return { key: answer.choice, confidence: typeof answer.confidence === 'number' ? answer.confidence : undefined };
  }
  if (answer.probabilities && typeof answer.probabilities === 'object') {
    let bestKey;
    let best = -Infinity;
    for (const [k, p] of Object.entries(answer.probabilities)) {
      if (validKeys.has(k) && typeof p === 'number' && p > best) {
        best = p;
        bestKey = k;
      }
    }
    if (bestKey) return { key: bestKey, confidence: typeof answer.confidence === 'number' ? answer.confidence : Math.max(0, Math.min(1, best)) };
  }
  return {};
}

async function askDecision(ctx, creds, { goal, searchText, tree, history, screenshot, exclude }) {
  const { criteria, actions } = buildNextActionCriteria(tree, { searchText, allowScreenshot: !screenshot, exclude });
  const contextText = buildContextText(ctx, { goal, searchText, tree, history, hasScreenshot: Boolean(screenshot) });
  const input = screenshot
    ? [{ type: 'image', data: screenshot.base64, mime_type: screenshot.mimeType || 'image/jpeg' }, { type: 'text', text: contextText }]
    : contextText;
  const body = {
    model: DECISION_MODEL,
    input,
    questions: {
      goal_reached: {
        type: 'noul',
        instructions: "Has the user's TV navigation goal ALREADY been achieved on the current screen (e.g. target content is now playing or target destination screen is clearly open)?",
      },
      next_action: {
        type: 'choice',
        instructions: 'Choose the single best immediate action on this TV screen to accomplish the user goal without repeating ineffective actions.',
        criteria,
      },
    },
  };
  const timeoutMs = finiteNumber(ctx.args.decisionTimeoutMs ?? ctx.deps.decisionTimeoutMs, 25_000, 100, 300_000);
  const res = await httpRequest(ctx, resolveDecisionEndpoint(creds.baseUrl), {
    method: 'POST',
    body,
    timeoutMs,
    headers: { Accept: 'application/json', 'x-goog-api-key': creds.apiKey },
  });
  if (!res.ok) throw new Error(`Gemini Decision API HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  const answers = res.json?.answers;
  if (!answers || typeof answers !== 'object') {
    throw new Error(res.json?.error?.message || 'Gemini Decision API 响应缺少 answers');
  }
  const noul = Number(answers.goal_reached?.noul);
  const pick = resolveChoice(answers.next_action, new Set(Object.keys(criteria)));
  return {
    goalNoul: Number.isFinite(noul) ? noul : 0,
    choice: pick.key,
    confidence: pick.confidence,
    actions,
    usedScreenshot: Boolean(screenshot),
  };
}

async function fetchScreenshot(ctx) {
  const res = await agentGet(ctx, '/screenshot?maxWidth=960&quality=68', 10_000);
  if (res.ok && res.json?.base64) return { base64: res.json.base64, mimeType: res.json.mimeType || 'image/jpeg' };
  return undefined;
}

async function handleNavigate(ctx) {
  const { args } = ctx;
  const goal = String(args.goal ?? '').trim();
  if (!goal) return failure('电视导航', 'navigate 需要 goal（例如 "在 B 站搜索周杰伦并播放"）。');
  const maxSteps = Math.max(1, Math.min(12, Math.round(Number(args.maxSteps ?? 8)) || 8));
  const settleMs = finiteNumber(args.settleMs ?? ctx.deps.settleMs, 900, 0, 30_000);
  const launchSettleMs = finiteNumber(args.launchSettleMs ?? ctx.deps.launchSettleMs, 1400, 0, 30_000);
  const searchText = (typeof args.searchText === 'string' && args.searchText.trim()) || extractQuoted(goal) || '';
  const trace = [];

  const creds = resolveDecisionCredentials(args, ctx.paths, ctx.deps);
  if (!creds) {
    return failure('电视导航失败', '未找到 Gemini Decision API 密钥（args.apiKey 或 model-hub.json 的 decision.apiKey / providers.google.apiKey）。');
  }

  const wake = await agentAct(ctx, { action: 'wake' });
  if (!wake.ok) {
    return failure('电视导航失败', `电视 Agent (:${ctx.cfg.agentPort}) 无响应：${wake.detail || '请先开机（power on）'}`, { trace });
  }

  // Optionally launch the target app first.
  const goalPkg = args.app ? (await resolveAppPackage(ctx, args.app)).package : detectGoalApp(ctx, goal);
  const openOnly = isOpenOnlyGoal(goal);
  // Goals that say "on the desktop" are solved by the model navigating the launcher, so skip the auto-launch only.
  const targetPkg = goalPkg && (args.app || !LAUNCHER_GOAL_RE.test(goal)) ? goalPkg : undefined;
  if (args.app && !goalPkg) {
    return failure('电视导航失败', `无法识别应用 "${args.app}"。`, { trace });
  }
  if (targetPkg) {
    const st = await agentGet(ctx, '/status', PROBE_TIMEOUT_MS * 2);
    const fg = st.json?.packageName;
    if (fg !== targetPkg || args.app) {
      const launched = await openApp(ctx, targetPkg);
      trace.push({ step: 0, type: 'launch_app', package: targetPkg, ok: launched.ok, message: launched.message });
      if (!launched.ok) return failure('电视导航失败', launched.message, { trace });
      await ctx.sleep(launchSettleMs);
    }
  }

  const history = [];
  const executed = new Map(); // `${fingerprint}::${choice}` -> count
  const triedByState = new Map(); // fingerprint -> Set<choice> already executed on that screen
  let prevFp;
  let prevNeedsShot = false;
  let stepsUsed = 0;

  for (let step = 1; step <= maxSteps; step++) {
    stepsUsed = step;
    const treeRes = await agentGet(ctx, '/tree?maxNodes=60');
    if (!treeRes.ok || !treeRes.json) {
      trace.push({ step, error: `GET /tree 失败：${treeRes.error ?? `HTTP ${treeRes.status}`}` });
      return failure('电视导航失败', `读取界面树失败（第 ${step} 步）。`, { trace });
    }
    const tree = treeRes.json;
    const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
    const fp = stateFingerprint(tree);
    if (goalPkg && openOnly && tree.packageName === goalPkg && !ctx.aliases.launcherPackages.has(goalPkg)) {
      // Deterministic success: the requested app is already in the foreground.
      trace.push({ step, packageName: tree.packageName, nodeCount: nodes.length, fingerprint: fp, goalReached: 'foreground_match' });
      return success('电视导航完成', `目标已达成（第 ${step} 步，${goalPkg} 已在前台）：${goal}`, {
        goalReached: true, steps: step, packageName: tree.packageName, deterministic: true, trace,
      });
    }
    const richCount = nodes.filter(n => nodeLabel(n)).length;
    const unchanged = prevFp !== undefined && prevFp === fp;
    if (unchanged && history.length) history[history.length - 1].unchanged = true;

    const needShot = nodes.length < 2 || richCount < 2 || prevNeedsShot || unchanged;
    prevNeedsShot = false;
    const entry = { step, packageName: tree.packageName, nodeCount: nodes.length, fingerprint: fp, screenshot: false };

    let decision;
    try {
      let shot = needShot ? await fetchScreenshot(ctx) : undefined;
      const exclude = triedByState.get(fp);
      decision = await askDecision(ctx, creds, { goal, searchText, tree, history, screenshot: shot, exclude });
      if (decision.choice === 'request_screenshot' && !shot) {
        shot = await fetchScreenshot(ctx);
        entry.requestedScreenshot = true;
        decision = await askDecision(ctx, creds, { goal, searchText, tree, history, screenshot: shot, exclude });
      }
      entry.screenshot = decision.usedScreenshot;
    } catch (err) {
      entry.error = errMsg(err);
      trace.push(entry);
      return failure('电视导航失败', `Gemini 决策失败（第 ${step} 步）：${entry.error}`, { trace });
    }

    entry.goalNoul = decision.goalNoul;
    entry.choice = decision.choice;
    entry.confidence = decision.confidence;
    trace.push(entry);

    if (decision.goalNoul >= GOAL_REACHED_THRESHOLD || decision.choice === 'done_now') {
      return success('电视导航完成', `目标已达成（第 ${step} 步，前台 ${tree.packageName || '未知'}）：${goal}`, {
        goalReached: true, steps: step, packageName: tree.packageName, trace,
      });
    }
    if (!decision.choice) {
      return failure('电视导航失败', `决策服务未返回有效动作（第 ${step} 步）。`, { goalReached: false, steps: step, trace });
    }
    if (decision.choice === 'abort_impossible') {
      return failure('电视导航中止', `界面存在无法绕过的阻塞（如扫码登录/内容缺失），已停止：${goal}`, {
        goalReached: false, aborted: true, steps: step, packageName: tree.packageName, trace,
      });
    }
    if (decision.choice === 'request_screenshot') {
      // Screenshot attached and still no concrete action: stop instead of looping.
      return failure('电视导航失败', `即使附带截图也无法确定下一步（第 ${step} 步）。`, { goalReached: false, steps: step, trace });
    }

    const execKey = `${fp}::${decision.choice}`;
    if (executed.has(execKey)) {
      entry.note = 'repeated_same_state_action';
      return failure('电视导航中止', `在相同界面重复选择了相同动作 ${decision.choice}，已停止以避免死循环：${goal}`, {
        goalReached: false, aborted: true, repeated: true, steps: step, trace,
      });
    }
    executed.set(execKey, 1);
    if (!triedByState.has(fp)) triedByState.set(fp, new Set());
    triedByState.get(fp).add(decision.choice);

    const body = decision.actions[decision.choice];
    const act = await agentAct(ctx, body);
    entry.action = body;
    entry.actOk = act.ok;
    entry.actDetail = act.detail;
    history.push({ step, choice: decision.choice, unchanged: false });
    if (decision.confidence !== undefined && decision.confidence < LOW_CONFIDENCE) prevNeedsShot = true;
    prevFp = fp;
    await ctx.sleep(settleMs);
  }

  return failure('电视导航未完成', `已执行 ${stepsUsed} 步仍未确认达成目标：${goal}`, {
    goalReached: false, steps: stepsUsed, trace,
  });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Execute a tv-agent plugin action with optional injected dependencies for unit tests
 * (deps.fetch, deps.sleep, deps.irRunner, deps.pluginDataDir, deps.dataDir, deps.modelHubPath, deps.env, deps.pollMs, deps.callPlugin, deps.signal).
 */
export async function executeTvAgentAction(action = 'status', args = {}, deps = {}) {
  const name = String(action || 'status').trim().toLowerCase();
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (!ACTIONS.includes(name)) {
    return failure('电视 Agent 操作失败', `不支持的 tv-agent 动作 "${action}"，可用动作：${ACTIONS.join('、')}。`);
  }
  const ctx = makeCtx(safeArgs, deps);
  if (name === 'config') {
    return handleConfig(ctx);
  }
  if (!ctx.cfg.tvHost) {
    return failure('电视 Agent 未配置', '请先调用 config 动作设置 tvHost（电视局域网 IP），或写入插件 config.json。');
  }
  switch (name) {
    case 'status': return handleStatus(ctx);
    case 'power': return handlePower(ctx);
    case 'volume': return handleVolume(ctx);
    case 'cast': return handleCast(ctx);
    case 'open_app': return handleOpenApp(ctx);
    case 'tree': return handleTree(ctx);
    case 'screenshot': return handleScreenshot(ctx);
    case 'act': return handleAct(ctx);
    case 'navigate': return handleNavigate(ctx);
    default: return failure('电视 Agent 操作失败', `未实现的动作 ${name}`);
  }
}

export async function runAction(action = 'status', args = {}, context = {}) {
  return executeTvAgentAction(action, args, context);
}

async function main() {
  const action = process.argv[2] || 'status';
  let args = {};
  try {
    args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  } catch {
    args = {};
  }
  try {
    const result = await executeTvAgentAction(action, args);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      notify: true,
      title: '电视 Agent 操作失败',
      message: errMsg(err),
    }) + '\n');
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  await main();
}

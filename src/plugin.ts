import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { classifyFastpathCs80Scene, classifyPluginCs80Scene, notifyCs80Scene } from './cs80-scene.js';
import { resolveFridayHome, resolvePluginDataDir } from './paths.js';
import type { PluginActionSpec, PluginRuntimeMode, PluginView } from './view.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILTIN_PLUGINS_DIR = resolve(REPO_ROOT, 'plugins');
const MAX_PLUGIN_CALL_DEPTH = 4;
const DEFAULT_MEMBER_ALLOWED_PLUGINS: ReadonlySet<string> = new Set(['miot', 'tv-ir', 'tv-agent']);

export type { PluginRuntimeMode };

export interface PluginManifest extends PluginView {
  entryPath: string;
  dir: string;
  dataDir: string;
  enabled: boolean;
  platforms?: string[];
  runtime: PluginRuntimeMode;
  voiceFastpath: boolean;
  isBuiltin?: boolean;
}

export interface PluginRunResult {
  ok: boolean;
  plugin: string;
  action: string;
  notify: boolean;
  title?: string;
  message: string;
  data?: unknown;
}

export interface PluginExecutionContext {
  homeDir: string;
  pluginDataDir: string;
  /** Backwards-compatible alias of `pluginDataDir` for existing plugins reading `deps.dataDir`. */
  dataDir: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  getDecisionCredentials?: () => { apiKey: string; baseUrl?: string } | undefined;
  callPlugin: (
    targetPlugin: string,
    action?: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<PluginRunResult>;
}

export interface VoiceFastpathRequest {
  text: string;
  channelId: string;
  platform: 'telegram' | 'dingtalk' | 'wechat' | 'xiaoai' | (string & {});
  targetId?: string;
  senderId?: string;
  speakerId?: string;
  speakerName?: string;
  speakerRole?: 'owner' | 'member';
  allowedPlugins?: ReadonlySet<string> | readonly string[];
  explicitWake?: boolean;
  sessionState?: Record<string, unknown>;
}

export interface VoiceFastpathResult {
  handled: boolean;
  plugin?: string;
  action?: string;
  ok?: boolean;
  speech?: string;
  followUp?: boolean;
  followUpWaitMs?: number;
  sessionState?: Record<string, unknown>;
  clearSessionState?: boolean;
  data?: unknown;
}

const VALID_PLUGIN_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const SENSITIVE_ENV_KEY_RE = /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

type CachedManifestBase = Omit<PluginManifest, 'dataDir'>;

interface CachedManifestEntry {
  manifestMtimeNs: bigint;
  manifestSize: bigint;
  entryMtimeNs: bigint;
  entrySize: bigint;
  base: CachedManifestBase;
}

const MANIFEST_CACHE = new Map<string, CachedManifestEntry>();

function statBigIntSafe(filePath: string): BigIntStats | undefined {
  try {
    return statSync(filePath, { bigint: true });
  } catch {
    return undefined;
  }
}

function pluginRoots(home: string): Array<{ root: string; isBuiltin: boolean }> {
  return [
    { root: BUILTIN_PLUGINS_DIR, isBuiltin: true },
    { root: join(resolve(home), 'plugins'), isBuiltin: false },
  ];
}

function normalizeAllowedPlugins(
  allowed?: ReadonlySet<string> | readonly string[],
): ReadonlySet<string> | undefined {
  if (allowed === undefined) return undefined;
  return allowed instanceof Set ? allowed : new Set(allowed);
}

function resolveEffectiveAllowedPlugins(
  requestAllowed?: ReadonlySet<string> | readonly string[],
  optionAllowed?: ReadonlySet<string> | readonly string[],
  speakerRole?: 'owner' | 'member',
): ReadonlySet<string> | undefined {
  const sets: ReadonlySet<string>[] = [];
  if (requestAllowed !== undefined) {
    sets.push(requestAllowed instanceof Set ? requestAllowed : new Set(requestAllowed));
  }
  if (optionAllowed !== undefined) {
    sets.push(optionAllowed instanceof Set ? optionAllowed : new Set(optionAllowed));
  }
  if (speakerRole === 'member') {
    sets.push(DEFAULT_MEMBER_ALLOWED_PLUGINS);
  }
  if (sets.length === 0) return undefined;
  const [first, ...rest] = sets;
  const out = new Set<string>();
  for (const item of first!) {
    if (rest.every(s => s.has(item))) out.add(item);
  }
  return out;
}

function resolveRuntimeMode(name: string, entryPath: string, rawRuntime: unknown): PluginRuntimeMode {
  if (rawRuntime === 'in-process') return 'in-process';
  if (rawRuntime === 'subprocess') return 'subprocess';
  // Temporary backwards compatibility until Slice 4 adds explicit `"runtime": "in-process"` to plugin.json.
  const normalizedEntry = entryPath.replace(/\\/g, '/');
  if (
    (name === 'miot' && normalizedEntry.endsWith('plugins/miot/index.mjs')) ||
    (name === 'health-scale' && normalizedEntry.endsWith('plugins/health-scale/index.mjs'))
  ) {
    return 'in-process';
  }
  return 'subprocess';
}

function isPlatformSupported(platforms: string[] | undefined, platform: string): boolean {
  if (!platforms || platforms.length === 0) return true;
  return platforms.includes(platform);
}

function loadCachedPluginManifest(
  homeDir: string,
  pluginName: string,
  dir: string,
  platform: string = process.platform,
  isBuiltin = false,
  realRootDir?: string,
): PluginManifest | undefined {
  let realDir: string;
  try {
    const dirStat = lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      MANIFEST_CACHE.delete(dir);
      return undefined;
    }
    realDir = realpathSync(dir);
    if (realRootDir) {
      const relDir = relative(realRootDir, realDir);
      if (!relDir || relDir === '..' || relDir.startsWith(`..${sep}`) || isAbsolute(relDir)) {
        MANIFEST_CACHE.delete(dir);
        return undefined;
      }
    }
  } catch {
    MANIFEST_CACHE.delete(dir);
    return undefined;
  }

  const manifestPath = join(realDir, 'plugin.json');
  const defaultEntryPath = join(realDir, 'index.mjs');
  const manifestStat = statBigIntSafe(manifestPath);
  const manifestMtimeNs = manifestStat?.mtimeNs ?? -1n;
  const manifestSize = manifestStat?.size ?? -1n;

  const cached = MANIFEST_CACHE.get(dir);
  if (
    cached &&
    cached.manifestMtimeNs === manifestMtimeNs &&
    cached.manifestSize === manifestSize &&
    cached.base.isBuiltin === isBuiltin
  ) {
    const entryStat = statBigIntSafe(cached.base.entryPath);
    if (entryStat && entryStat.isFile() && cached.entryMtimeNs === entryStat.mtimeNs && cached.entrySize === entryStat.size) {
      return {
        ...cached.base,
        enabled: cached.base.enabled && isPlatformSupported(cached.base.platforms, platform),
        dataDir: resolvePluginDataDir(homeDir, pluginName),
      };
    }
  }

  if (!manifestStat && !existsSync(defaultEntryPath)) {
    MANIFEST_CACHE.delete(dir);
    return undefined;
  }

  let raw: Record<string, unknown> = {};
  let manifestJson: string | undefined;
  if (manifestStat) {
    try {
      manifestJson = readFileSync(manifestPath, 'utf8');
      raw = JSON.parse(manifestJson) as Record<string, unknown>;
    } catch {
      /* ignore invalid manifest */
    }
  }

  const entryFile = typeof raw.entry === 'string' && raw.entry.trim() ? raw.entry.trim() : 'index.mjs';
  let entryPath: string;
  try {
    const candidate = resolve(realDir, entryFile);
    entryPath = realpathSync(candidate);
  } catch {
    MANIFEST_CACHE.delete(dir);
    return undefined;
  }

  const relEntry = relative(realDir, entryPath);
  if (!relEntry || relEntry === '..' || relEntry.startsWith(`..${sep}`) || isAbsolute(relEntry)) {
    MANIFEST_CACHE.delete(dir);
    return undefined;
  }

  const entryStat = statBigIntSafe(entryPath);
  if (!entryStat || !entryStat.isFile()) {
    MANIFEST_CACHE.delete(dir);
    return undefined;
  }

  const actions = Array.isArray(raw.actions) ? raw.actions.map(a => String(a)) : ['status'];
  const actionSpecs: PluginActionSpec[] = Array.isArray(raw.actionSpecs)
    ? (raw.actionSpecs as Array<Record<string, unknown>>)
        .filter(item => item && typeof item.name === 'string')
        .map(item => ({
          name: String(item.name),
          label: typeof item.label === 'string' ? item.label : undefined,
          description: typeof item.description === 'string' ? item.description : undefined,
          defaultArgs: item.defaultArgs && typeof item.defaultArgs === 'object' && !Array.isArray(item.defaultArgs)
            ? item.defaultArgs as Record<string, unknown>
            : undefined,
        }))
    : actions.map(actionName => ({ name: actionName, defaultArgs: {} }));

  const promptHint = typeof raw.promptHint === 'string' && raw.promptHint.trim() ? raw.promptHint.trim() : undefined;
  const platforms = Array.isArray(raw.platforms)
    ? raw.platforms.map(p => String(p).trim()).filter(Boolean)
    : undefined;
  const staticEnabled = raw.enabled !== false;
  const runtime = resolveRuntimeMode(pluginName, entryPath, raw.runtime);
  const voiceFastpath = raw.voiceFastpath === true;

  const base: CachedManifestBase = {
    name: pluginName,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : pluginName,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    entry: entryFile,
    entryPath,
    dir: realDir,
    enabled: staticEnabled,
    ...(platforms && platforms.length > 0 ? { platforms } : {}),
    runtime,
    ...(promptHint ? { promptHint } : {}),
    voiceFastpath,
    isBuiltin,
    actions,
    actionSpecs,
    manifestJson,
  };

  MANIFEST_CACHE.set(dir, {
    manifestMtimeNs,
    manifestSize,
    entryMtimeNs: entryStat.mtimeNs,
    entrySize: entryStat.size,
    base,
  });

  return {
    ...base,
    enabled: staticEnabled && isPlatformSupported(platforms, platform),
    dataDir: resolvePluginDataDir(homeDir, pluginName),
  };
}

/** Converts an internal `PluginManifest` to a safe `PluginView` without host paths or raw source code. */
export function toPluginView(manifest: PluginManifest): PluginView {
  return {
    name: manifest.name,
    title: manifest.title,
    description: manifest.description,
    entry: manifest.entry,
    enabled: manifest.enabled,
    ...(manifest.platforms && manifest.platforms.length > 0 ? { platforms: [...manifest.platforms] } : {}),
    ...(manifest.isBuiltin !== undefined ? { isBuiltin: manifest.isBuiltin } : {}),
    runtime: manifest.runtime,
    ...(manifest.promptHint ? { promptHint: manifest.promptHint } : {}),
    ...(manifest.voiceFastpath ? { voiceFastpath: true } : {}),
    actions: manifest.actions,
    ...(manifest.actionSpecs ? { actionSpecs: manifest.actionSpecs } : {}),
    ...(manifest.manifestJson !== undefined ? { manifestJson: manifest.manifestJson } : {}),
  };
}

/** Lists sanitized `PluginView` summaries suitable for `/api/view` and LLM context. */
export function listPluginViews(home: string, options?: { platform?: string }): PluginView[] {
  return listPluginsSync(home, options).map(toPluginView);
}

export function listPluginsSync(home: string, options?: { platform?: string }): PluginManifest[] {
  const resolvedHome = resolveFridayHome(home);
  const platform = options?.platform ?? process.platform;
  const seen = new Set<string>();
  const manifests: PluginManifest[] = [];
  for (const { root, isBuiltin } of pluginRoots(resolvedHome)) {
    if (!existsSync(root)) continue;
    let realRoot: string;
    let entries;
    try {
      realRoot = realpathSync(root);
      entries = readdirSync(realRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !VALID_PLUGIN_NAME.test(entry.name) || seen.has(entry.name)) continue;
      const dir = join(realRoot, entry.name);
      const manifest = loadCachedPluginManifest(resolvedHome, entry.name, dir, platform, isBuiltin, realRoot);
      if (!manifest) continue;
      seen.add(entry.name);
      manifests.push(manifest);
    }
  }
  return manifests;
}

export async function listPlugins(home: string, options?: { platform?: string }): Promise<PluginManifest[]> {
  return listPluginsSync(home, options);
}

interface InProcessPluginModule {
  runAction?: (
    action: string,
    args: Record<string, unknown>,
    deps?: PluginExecutionContext | Record<string, unknown>,
  ) => Promise<unknown>;
  executeMiotAction?: (
    action: string,
    args: Record<string, unknown>,
    deps?: PluginExecutionContext | Record<string, unknown>,
  ) => Promise<unknown>;
  handleVoiceFastpath?: (
    request: VoiceFastpathRequest,
    context: PluginExecutionContext,
  ) => Promise<VoiceFastpathResult | undefined | null>;
}

const IN_PROCESS_MODULE_CACHE = new Map<string, { mtimeNs: bigint; promise: Promise<InProcessPluginModule> }>();

function loadInProcessPluginModule(entryPath: string): Promise<InProcessPluginModule> {
  const mtimeNs = statBigIntSafe(entryPath)?.mtimeNs ?? 0n;
  const existing = IN_PROCESS_MODULE_CACHE.get(entryPath);
  if (existing && existing.mtimeNs === mtimeNs) {
    return existing.promise;
  }
  const baseHref = pathToFileURL(entryPath).href;
  const spec = existing ? `${baseHref}?mtime=${mtimeNs.toString()}` : baseHref;
  const promise = import(spec) as Promise<InProcessPluginModule>;
  promise.catch(() => {
    if (IN_PROCESS_MODULE_CACHE.get(entryPath)?.promise === promise) {
      IN_PROCESS_MODULE_CACHE.delete(entryPath);
    }
  });
  IN_PROCESS_MODULE_CACHE.set(entryPath, { mtimeNs, promise });
  return promise;
}

function buildPluginEnv(homeDir: string, pluginDataDir: string): Record<string, string | undefined> {
  const cleanEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (SENSITIVE_ENV_KEY_RE.test(key)) delete cleanEnv[key];
  }
  cleanEnv.FRIDAY_HOME = homeDir;
  cleanEnv.SUPER_AGENT_HOME = homeDir;
  cleanEnv.PLUGIN_DATA_DIR = pluginDataDir;
  return cleanEnv;
}

function readHostDecisionCredentials(homeDir: string): { apiKey: string; baseUrl?: string } | undefined {
  try {
    const hubPath = join(resolve(homeDir), 'sdk', 'model-hub.json');
    if (!existsSync(hubPath)) return undefined;
    const hub = JSON.parse(readFileSync(hubPath, 'utf8')) as {
      decision?: { apiKey?: unknown; baseUrl?: unknown };
      providers?: { google?: { apiKey?: unknown } };
    };
    const decisionKey = typeof hub?.decision?.apiKey === 'string' ? hub.decision.apiKey.trim() : '';
    const googleKey = typeof hub?.providers?.google?.apiKey === 'string' ? hub.providers.google.apiKey.trim() : '';
    const apiKey = decisionKey || googleKey;
    if (!apiKey) return undefined;
    const baseUrl = typeof hub?.decision?.baseUrl === 'string' && hub.decision.baseUrl.trim()
      ? hub.decision.baseUrl.trim()
      : undefined;
    return { apiKey, ...(baseUrl ? { baseUrl } : {}) };
  } catch {
    return undefined;
  }
}

function isTrustedBuiltinTvAgent(manifest: PluginManifest): boolean {
  if (!manifest.isBuiltin || manifest.name !== 'tv-agent') return false;
  try {
    const builtinTvAgentDir = realpathSync(join(BUILTIN_PLUGINS_DIR, 'tv-agent'));
    return realpathSync(manifest.dir) === builtinTvAgentDir;
  } catch {
    return false;
  }
}

function buildInProcessContext(
  homeDir: string,
  pluginDataDir: string,
  signal: AbortSignal,
  defaultTimeoutMs: number,
  manifest?: PluginManifest,
  contextOptions: {
    allowedPlugins?: ReadonlySet<string>;
    callDepth?: number;
  } = {},
): PluginExecutionContext {
  const allowedPlugins = contextOptions.allowedPlugins;
  const callDepth = contextOptions.callDepth ?? 0;
  return {
    homeDir,
    pluginDataDir,
    dataDir: pluginDataDir,
    env: buildPluginEnv(homeDir, pluginDataDir),
    signal,
    ...(manifest && isTrustedBuiltinTvAgent(manifest)
      ? { getDecisionCredentials: () => readHostDecisionCredentials(homeDir) }
      : {}),
    callPlugin: (targetPlugin, targetAction = 'status', targetArgs = {}, targetTimeoutMs) => {
      const cleanTarget = targetPlugin.trim();
      if (!VALID_PLUGIN_NAME.test(cleanTarget)) {
        return Promise.reject(new Error(`Invalid plugin name: ${cleanTarget}`));
      }
      const nextDepth = callDepth + 1;
      if (nextDepth > MAX_PLUGIN_CALL_DEPTH) {
        return Promise.reject(
          new Error(`Plugin call depth limit (${MAX_PLUGIN_CALL_DEPTH}) exceeded invoking "${cleanTarget}"`),
        );
      }
      if (allowedPlugins && !allowedPlugins.has(cleanTarget)) {
        return Promise.reject(new Error(`Plugin "${cleanTarget}" is not allowed in caller context`));
      }
      return runPlugin(
        homeDir,
        cleanTarget,
        targetAction,
        targetArgs,
        targetTimeoutMs ?? defaultTimeoutMs,
        {
          signal,
          ...(allowedPlugins ? { allowedPlugins } : {}),
          callDepth: nextDepth,
        },
      );
    },
  };
}

async function runWithAbortTimeout<T>(
  timeoutMs: number,
  timeoutMessage: string,
  externalSignal: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let cleanupExternal: (() => void) | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) {
      const reason = externalSignal.reason;
      throw reason instanceof Error ? reason : new Error(String(reason ?? 'Plugin execution aborted'));
    }
    const onExternalAbort = () => controller.abort(externalSignal.reason);
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    cleanupExternal = () => externalSignal.removeEventListener('abort', onExternalAbort);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  return await Promise.race([
    Promise.resolve().then(() => fn(controller.signal)),
    new Promise<never>((_, reject) => {
      onAbort = () => {
        const reason = controller.signal.reason;
        reject(reason instanceof Error ? reason : new Error(String(reason ?? timeoutMessage)));
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        controller.abort(new Error(timeoutMessage));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    cleanupExternal?.();
  });
}

function formatPluginResult(
  plugin: string,
  action: string,
  rawResult: unknown,
  fallbackText?: string,
): PluginRunResult {
  if (rawResult && typeof rawResult === 'object') {
    const parsed = rawResult as Record<string, unknown>;
    return {
      ok: parsed.ok === undefined ? true : Boolean(parsed.ok),
      plugin,
      action,
      notify: parsed.notify === undefined ? true : Boolean(parsed.notify),
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      message: typeof parsed.message === 'string' ? parsed.message : (fallbackText ?? JSON.stringify(parsed)),
      data: parsed.data,
    };
  }
  const trimmed = rawResult === undefined || rawResult === null ? '' : String(rawResult).trim();
  if (!trimmed) {
    return { ok: true, plugin, action, notify: false, message: '' };
  }
  return {
    ok: true,
    plugin,
    action,
    notify: true,
    message: trimmed,
  };
}

function findPluginManifest(home: string, name: string): { resolvedHome: string; cleanName: string; manifest: PluginManifest } {
  const cleanName = name.trim();
  if (!VALID_PLUGIN_NAME.test(cleanName)) {
    throw new Error(`Invalid plugin name: ${cleanName}`);
  }
  const resolvedHome = resolveFridayHome(home);
  const manifest = listPluginsSync(resolvedHome).find(p => p.name === cleanName);
  if (!manifest) {
    throw new Error(`Plugin "${cleanName}" not found`);
  }
  return { resolvedHome, cleanName, manifest };
}

function assertPluginAllowedAndEnabled(
  cleanName: string,
  manifest: PluginManifest,
  allowedPlugins?: ReadonlySet<string>,
): void {
  if (allowedPlugins && !allowedPlugins.has(cleanName)) {
    throw new Error(`Plugin "${cleanName}" is not allowed in current context`);
  }
  if (!manifest.enabled) {
    if (!isPlatformSupported(manifest.platforms, process.platform)) {
      throw new Error(`Plugin "${cleanName}" is not supported on platform "${process.platform}"`);
    }
    throw new Error(`Plugin "${cleanName}" is disabled`);
  }
}

export interface PluginRunOptions {
  signal?: AbortSignal;
  allowedPlugins?: ReadonlySet<string> | readonly string[];
  callDepth?: number;
}

export async function runPluginInProcess(
  home: string,
  name: string,
  action = 'status',
  args: Record<string, unknown> = {},
  timeoutMs = 30_000,
  options?: PluginRunOptions,
): Promise<PluginRunResult> {
  const { resolvedHome, cleanName, manifest } = findPluginManifest(home, name);
  const allowedPlugins = normalizeAllowedPlugins(options?.allowedPlugins);
  assertPluginAllowedAndEnabled(cleanName, manifest, allowedPlugins);
  const callDepth = options?.callDepth ?? 0;
  if (callDepth > MAX_PLUGIN_CALL_DEPTH) {
    throw new Error(`Plugin call depth limit (${MAX_PLUGIN_CALL_DEPTH}) exceeded invoking "${cleanName}"`);
  }

  const pluginDataDir = resolvePluginDataDir(resolvedHome, cleanName);
  await mkdir(pluginDataDir, { recursive: true, mode: 0o700 });

  const mod = await loadInProcessPluginModule(manifest.entryPath);
  const runner = typeof mod.runAction === 'function' ? mod.runAction : mod.executeMiotAction;
  if (typeof runner !== 'function') {
    throw new Error(`Plugin "${cleanName}" does not export runAction`);
  }

  const rawResult = await runWithAbortTimeout(
    timeoutMs,
    `Plugin "${cleanName}" action "${action}" timed out after ${timeoutMs}ms`,
    options?.signal,
    signal => runner(
      action,
      args,
      buildInProcessContext(resolvedHome, pluginDataDir, signal, timeoutMs, manifest, {
        ...(allowedPlugins ? { allowedPlugins } : {}),
        callDepth,
      }),
    ),
  );
  return formatPluginResult(cleanName, action, rawResult);
}

export async function runPlugin(
  home: string,
  name: string,
  action = 'status',
  args: Record<string, unknown> = {},
  timeoutMs = 30_000,
  options?: PluginRunOptions,
): Promise<PluginRunResult> {
  const { resolvedHome, cleanName, manifest } = findPluginManifest(home, name);
  const allowedPlugins = normalizeAllowedPlugins(options?.allowedPlugins);
  assertPluginAllowedAndEnabled(cleanName, manifest, allowedPlugins);
  const callDepth = options?.callDepth ?? 0;
  if (callDepth > MAX_PLUGIN_CALL_DEPTH) {
    throw new Error(`Plugin call depth limit (${MAX_PLUGIN_CALL_DEPTH}) exceeded invoking "${cleanName}"`);
  }

  const cs80Scene = callDepth === 0 ? classifyPluginCs80Scene(cleanName, action, args) : undefined;
  if (cs80Scene && cs80Scene.phase !== 'end') {
    notifyCs80Scene({
      scene: cs80Scene.scene,
      phase: 'start',
      ...(cs80Scene.channel ? { channel: cs80Scene.channel } : {}),
      ...(cs80Scene.caption ? { caption: cs80Scene.caption } : {}),
      holdSec: cs80Scene.holdSec ?? 18,
    });
  }
  const finishCs80Scene = (ok: boolean) => {
    if (!cs80Scene) return;
    if (cs80Scene.phase === 'end') {
      if (ok) {
        notifyCs80Scene({ scene: cs80Scene.scene, phase: 'end', tailSec: cs80Scene.tailSec ?? 0 });
      }
      return;
    }
    if (!ok || options?.signal?.aborted) {
      notifyCs80Scene({ scene: cs80Scene.scene, phase: 'end', tailSec: 0 });
      return;
    }
    notifyCs80Scene({
      scene: cs80Scene.scene,
      phase: 'pulse',
      ...(cs80Scene.channel ? { channel: cs80Scene.channel } : {}),
      ...(cs80Scene.caption ? { caption: cs80Scene.caption } : {}),
      holdSec: cs80Scene.finishHoldSec ?? 3.8,
    });
  };

  if (manifest.runtime === 'in-process') {
    let ok = false;
    try {
      const res = await runPluginInProcess(resolvedHome, cleanName, action, args, timeoutMs, {
        ...options,
        ...(allowedPlugins ? { allowedPlugins } : {}),
        callDepth,
      });
      ok = res.ok;
      return res;
    } finally {
      finishCs80Scene(ok);
    }
  }

  const pluginDataDir = resolvePluginDataDir(resolvedHome, cleanName);
  await mkdir(pluginDataDir, { recursive: true, mode: 0o700 });

  let stdout = '';
  let subprocessFailed = false;
  try {
    const out = await execFileAsync(
      process.execPath,
      [manifest.entryPath, action, JSON.stringify(args)],
      {
        cwd: manifest.dir,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: buildPluginEnv(resolvedHome, pluginDataDir),
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    stdout = out.stdout;
  } catch (err) {
    const e = err as { name?: string; stdout?: unknown; killed?: boolean };
    if (options?.signal?.aborted || e?.name === 'AbortError' || e?.killed) {
      finishCs80Scene(false);
      throw err;
    }
    const errStdout = typeof e?.stdout === 'string'
      ? e.stdout.trim()
      : Buffer.isBuffer(e?.stdout)
        ? e.stdout.toString('utf8').trim()
        : '';
    if (errStdout.startsWith('{')) {
      try {
        const parsed = JSON.parse(errStdout) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>;
          const formatted = formatPluginResult(
            cleanName,
            action,
            obj.ok === undefined ? { ...obj, ok: false } : obj,
            errStdout,
          );
          finishCs80Scene(formatted.ok);
          return formatted;
        }
      } catch {
        /* non-JSON stdout falls through to rethrowing process failure */
      }
    }
    subprocessFailed = true;
    finishCs80Scene(false);
    throw err;
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    if (!subprocessFailed) finishCs80Scene(true);
    return { ok: true, plugin: cleanName, action, notify: false, message: '' };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const formatted = formatPluginResult(cleanName, action, parsed, trimmed);
    finishCs80Scene(formatted.ok);
    return formatted;
  } catch {
    finishCs80Scene(true);
    return {
      ok: true,
      plugin: cleanName,
      action,
      notify: true,
      message: trimmed,
    };
  }
}

/**
 * Iterates enabled in-process plugins declaring `voiceFastpath: true` and calls their
 * exported `handleVoiceFastpath(request, context)` handler in isolation.
 */
export async function tryPluginVoiceFastpath(
  homeDir: string,
  request: VoiceFastpathRequest,
  options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
    allowedPlugins?: ReadonlySet<string> | readonly string[];
  },
): Promise<VoiceFastpathResult | undefined> {
  const resolvedHome = resolveFridayHome(homeDir);
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const effectiveAllowed = resolveEffectiveAllowedPlugins(
    request.allowedPlugins,
    options?.allowedPlugins,
    request.speakerRole,
  );
  const candidates = listPluginsSync(resolvedHome).filter(
    p => p.enabled && p.voiceFastpath && p.runtime === 'in-process' && (!effectiveAllowed || effectiveAllowed.has(p.name)),
  );
  for (const manifest of candidates) {
    if (options?.signal?.aborted) return undefined;
    try {
      const mod = await loadInProcessPluginModule(manifest.entryPath);
      if (typeof mod.handleVoiceFastpath !== 'function') continue;
      const pluginDataDir = resolvePluginDataDir(resolvedHome, manifest.name);
      await mkdir(pluginDataDir, { recursive: true, mode: 0o700 });
      const result = await runWithAbortTimeout(
        timeoutMs,
        `Plugin "${manifest.name}" voice fastpath timed out after ${timeoutMs}ms`,
        options?.signal,
        signal => mod.handleVoiceFastpath!(
          request,
          buildInProcessContext(resolvedHome, pluginDataDir, signal, timeoutMs, manifest, {
            ...(effectiveAllowed ? { allowedPlugins: effectiveAllowed } : {}),
            callDepth: 0,
          }),
        ),
      );
      if (result && result.handled) {
        const effectiveResult: VoiceFastpathResult = {
          ...result,
          plugin: result.plugin ?? manifest.name,
        };
        const fastScene = classifyFastpathCs80Scene(request, effectiveResult);
        if (fastScene) {
          if (fastScene.phase === 'end') {
            notifyCs80Scene({
              scene: fastScene.scene,
              phase: 'end',
              tailSec: fastScene.tailSec ?? 0,
            });
          } else {
            notifyCs80Scene({
              scene: fastScene.scene,
              phase: fastScene.phase ?? 'pulse',
              ...(fastScene.channel ? { channel: fastScene.channel } : {}),
              ...(fastScene.caption ? { caption: fastScene.caption } : {}),
              holdSec: fastScene.holdSec ?? 3.8,
            });
          }
        }
        return effectiveResult;
      }
    } catch {
      /* voice fastpaths must fail open so the Router can still handle the utterance */
    }
  }
  return undefined;
}

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, type BigIntStats } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveFridayHome, resolvePluginDataDir } from './paths.js';
import type { PluginActionSpec, PluginRuntimeMode, PluginView } from './view.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type { PluginRuntimeMode };

export interface PluginManifest extends PluginView {
  entryPath: string;
  dir: string;
  dataDir: string;
  enabled: boolean;
  runtime: PluginRuntimeMode;
  voiceFastpath: boolean;
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

function pluginRoots(home: string): string[] {
  return [join(resolve(home), 'plugins'), join(REPO_ROOT, 'plugins')];
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

function loadCachedPluginManifest(homeDir: string, pluginName: string, dir: string): PluginManifest | undefined {
  const manifestPath = join(dir, 'plugin.json');
  const defaultEntryPath = join(dir, 'index.mjs');
  const manifestStat = statBigIntSafe(manifestPath);
  const manifestMtimeNs = manifestStat?.mtimeNs ?? -1n;
  const manifestSize = manifestStat?.size ?? -1n;

  const cached = MANIFEST_CACHE.get(dir);
  if (cached && cached.manifestMtimeNs === manifestMtimeNs && cached.manifestSize === manifestSize) {
    const entryStat = statBigIntSafe(cached.base.entryPath);
    if (entryStat && cached.entryMtimeNs === entryStat.mtimeNs && cached.entrySize === entryStat.size) {
      return {
        ...cached.base,
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
  const entryPath = join(dir, entryFile);
  const entryStat = statBigIntSafe(entryPath);
  if (!entryStat) {
    MANIFEST_CACHE.delete(dir);
    return undefined;
  }

  let sourceCode: string | undefined;
  try {
    sourceCode = readFileSync(entryPath, 'utf8').slice(0, 131_072);
  } catch {
    /* ignore read error */
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
  const enabled = raw.enabled !== false;
  const runtime = resolveRuntimeMode(pluginName, entryPath, raw.runtime);
  const voiceFastpath = raw.voiceFastpath === true;

  const base: CachedManifestBase = {
    name: pluginName,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : pluginName,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    entry: entryFile,
    entryPath,
    dir,
    enabled,
    runtime,
    ...(promptHint ? { promptHint } : {}),
    voiceFastpath,
    actions,
    actionSpecs,
    manifestJson,
    sourceCode,
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
    runtime: manifest.runtime,
    ...(manifest.promptHint ? { promptHint: manifest.promptHint } : {}),
    ...(manifest.voiceFastpath ? { voiceFastpath: true } : {}),
    actions: manifest.actions,
    ...(manifest.actionSpecs ? { actionSpecs: manifest.actionSpecs } : {}),
    ...(manifest.manifestJson !== undefined ? { manifestJson: manifest.manifestJson } : {}),
  };
}

/** Lists sanitized `PluginView` summaries suitable for `/api/view` and LLM context. */
export function listPluginViews(home: string): PluginView[] {
  return listPluginsSync(home).map(toPluginView);
}

export function listPluginsSync(home: string): PluginManifest[] {
  const resolvedHome = resolveFridayHome(home);
  const seen = new Set<string>();
  const manifests: PluginManifest[] = [];
  for (const root of pluginRoots(resolvedHome)) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !VALID_PLUGIN_NAME.test(entry.name) || seen.has(entry.name)) continue;
      const dir = join(root, entry.name);
      const manifest = loadCachedPluginManifest(resolvedHome, entry.name, dir);
      if (!manifest) continue;
      seen.add(entry.name);
      manifests.push(manifest);
    }
  }
  return manifests;
}

export async function listPlugins(home: string): Promise<PluginManifest[]> {
  return listPluginsSync(home);
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

function buildInProcessContext(
  homeDir: string,
  pluginDataDir: string,
  signal: AbortSignal,
  defaultTimeoutMs: number,
): PluginExecutionContext {
  return {
    homeDir,
    pluginDataDir,
    dataDir: pluginDataDir,
    env: buildPluginEnv(homeDir, pluginDataDir),
    signal,
    callPlugin: (targetPlugin, targetAction = 'status', targetArgs = {}, targetTimeoutMs) => {
      const cleanTarget = targetPlugin.trim();
      if (!VALID_PLUGIN_NAME.test(cleanTarget)) {
        return Promise.reject(new Error(`Invalid plugin name: ${cleanTarget}`));
      }
      return runPlugin(
        homeDir,
        cleanTarget,
        targetAction,
        targetArgs,
        targetTimeoutMs ?? defaultTimeoutMs,
        { signal },
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

export async function runPluginInProcess(
  home: string,
  name: string,
  action = 'status',
  args: Record<string, unknown> = {},
  timeoutMs = 30_000,
  options?: { signal?: AbortSignal },
): Promise<PluginRunResult> {
  const { resolvedHome, cleanName, manifest } = findPluginManifest(home, name);
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
    signal => runner(action, args, buildInProcessContext(resolvedHome, pluginDataDir, signal, timeoutMs)),
  );
  return formatPluginResult(cleanName, action, rawResult);
}

export async function runPlugin(
  home: string,
  name: string,
  action = 'status',
  args: Record<string, unknown> = {},
  timeoutMs = 30_000,
  options?: { signal?: AbortSignal },
): Promise<PluginRunResult> {
  const { resolvedHome, cleanName, manifest } = findPluginManifest(home, name);
  if (manifest.runtime === 'in-process') {
    return runPluginInProcess(resolvedHome, cleanName, action, args, timeoutMs, options);
  }

  const pluginDataDir = resolvePluginDataDir(resolvedHome, cleanName);
  await mkdir(pluginDataDir, { recursive: true, mode: 0o700 });

  const { stdout } = await execFileAsync(
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

  const trimmed = stdout.trim();
  if (!trimmed) {
    return { ok: true, plugin: cleanName, action, notify: false, message: '' };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return formatPluginResult(cleanName, action, parsed, trimmed);
  } catch {
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
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<VoiceFastpathResult | undefined> {
  const resolvedHome = resolveFridayHome(homeDir);
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const candidates = listPluginsSync(resolvedHome).filter(
    p => p.enabled && p.voiceFastpath && p.runtime === 'in-process',
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
          buildInProcessContext(resolvedHome, pluginDataDir, signal, timeoutMs),
        ),
      );
      if (result && result.handled) {
        return {
          ...result,
          plugin: result.plugin ?? manifest.name,
        };
      }
    } catch {
      /* voice fastpaths must fail open so the Router can still handle the utterance */
    }
  }
  return undefined;
}

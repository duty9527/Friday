import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Resolve the active runtime home directory (`FRIDAY_HOME` -> `SUPER_AGENT_HOME`
 * -> `~/.friday` (if exists) -> `~/.super-agent` (if exists) -> `~/.friday`).
 * @param {{ homeDir?: string; env?: Record<string, string | undefined> }} [contextOrDeps]
 * @returns {string}
 */
export function resolveHomeDir(contextOrDeps = {}) {
  const explicitHome = typeof contextOrDeps?.homeDir === 'string' ? contextOrDeps.homeDir.trim() : '';
  if (explicitHome) {
    return resolve(explicitHome);
  }
  const env = contextOrDeps?.env ?? process.env;
  const fridayHome = typeof env.FRIDAY_HOME === 'string' ? env.FRIDAY_HOME.trim() : '';
  if (fridayHome) {
    return resolve(fridayHome);
  }
  const legacyHome = typeof env.SUPER_AGENT_HOME === 'string' ? env.SUPER_AGENT_HOME.trim() : '';
  if (legacyHome) {
    return resolve(legacyHome);
  }
  const baseHome = homedir();
  const preferred = join(baseHome, '.friday');
  if (existsSync(preferred)) {
    return preferred;
  }
  const legacyDefault = join(baseHome, '.super-agent');
  if (existsSync(legacyDefault)) {
    return legacyDefault;
  }
  return preferred;
}

/**
 * Resolve isolated per-plugin data directories without cross-plugin `PLUGIN_DATA_DIR` bleed
 * when an explicit `homeDir` is passed by the caller or test harness.
 * @param {string} pluginName
 * @param {{ homeDir?: string; pluginDataDir?: string; dataDir?: string; env?: Record<string, string | undefined> }} [contextOrDeps]
 * @param {Record<string, string>} [extraFiles]
 * @returns {import('./types.d.ts').PluginPaths}
 */
export function resolvePluginPaths(pluginName, contextOrDeps = {}, extraFiles = {}) {
  const homeDir = resolveHomeDir(contextOrDeps);
  const env = contextOrDeps?.env ?? process.env;

  const explicitPluginDataDir =
    typeof contextOrDeps?.pluginDataDir === 'string' ? contextOrDeps.pluginDataDir.trim() : '';
  const explicitDataDir =
    typeof contextOrDeps?.dataDir === 'string' ? contextOrDeps.dataDir.trim() : '';
  const explicitHomeDir =
    typeof contextOrDeps?.homeDir === 'string' ? contextOrDeps.homeDir.trim() : '';
  const passedEnvPluginDataDir =
    contextOrDeps?.env && typeof contextOrDeps.env.PLUGIN_DATA_DIR === 'string'
      ? contextOrDeps.env.PLUGIN_DATA_DIR.trim()
      : '';
  const ambientPluginDataDir =
    typeof env.PLUGIN_DATA_DIR === 'string' ? env.PLUGIN_DATA_DIR.trim() : '';

  let pluginDataDir;
  if (explicitPluginDataDir) {
    pluginDataDir = resolve(explicitPluginDataDir);
  } else if (explicitDataDir) {
    pluginDataDir = resolve(explicitDataDir);
  } else if (passedEnvPluginDataDir) {
    pluginDataDir = resolve(passedEnvPluginDataDir);
  } else if (explicitHomeDir) {
    pluginDataDir = join(homeDir, 'plugins', pluginName);
  } else if (ambientPluginDataDir) {
    pluginDataDir = resolve(ambientPluginDataDir);
  } else {
    pluginDataDir = join(homeDir, 'plugins', pluginName);
  }

  /** @type {import('./types.d.ts').PluginPaths} */
  const out = {
    homeDir,
    pluginDataDir,
    dataDir: pluginDataDir,
    configPath: join(pluginDataDir, 'config.json'),
  };
  for (const [key, filename] of Object.entries(extraFiles)) {
    out[key] = join(pluginDataDir, filename);
  }
  return out;
}

/** @type {Map<string, Promise<unknown>>} */
const FILE_LOCK_CHAINS = new Map();

/**
 * Serialize async read-modify-write operations on the same canonical file path
 * within the current process so concurrent actions do not clobber each other.
 * @template T
 * @param {string} filePath
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export function withFileLock(filePath, fn) {
  const key = resolve(filePath);
  const prev = FILE_LOCK_CHAINS.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  const tail = next.then(
    () => {
      if (FILE_LOCK_CHAINS.get(key) === tail) FILE_LOCK_CHAINS.delete(key);
    },
    () => {
      if (FILE_LOCK_CHAINS.get(key) === tail) FILE_LOCK_CHAINS.delete(key);
    },
  );
  FILE_LOCK_CHAINS.set(key, tail);
  return next;
}

/**
 * Ensure a directory exists with private 0o700 permissions (strictly rejecting symlinks).
 * @param {string} dirPath
 * @returns {string}
 */
export function ensurePrivateDir(dirPath) {
  let st;
  try {
    st = lstatSync(dirPath);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') throw err;
  }
  if (st) {
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing symlink private directory: ${dirPath}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`Expected directory path, got non-directory: ${dirPath}`);
    }
    chmodSync(dirPath, 0o700);
    return dirPath;
  }
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const created = lstatSync(dirPath);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`Refusing insecure private directory: ${dirPath}`);
  }
  chmodSync(dirPath, 0o700);
  return dirPath;
}

/**
 * Read and parse JSON from disk, returning `fallback` when missing or invalid.
 * @template T
 * @param {string} filePath
 * @param {T} fallback
 * @returns {T}
 */
export function readJsonSafe(filePath, fallback) {
  try {
    if (!existsSync(filePath)) return fallback;
    return /** @type {T} */ (JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    return fallback;
  }
}

/**
 * Atomically write JSON via exclusive temp file + rename and apply restrictive 0o600 permissions.
 * @param {string} filePath
 * @param {unknown} value
 * @param {{ mode?: number }} [options]
 */
export function writeJsonAtomic(filePath, value, options = {}) {
  const mode = options.mode ?? 0o600;
  const parent = dirname(filePath);
  ensurePrivateDir(parent);
  try {
    const existing = lstatSync(filePath);
    if (existing.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symlink file: ${filePath}`);
    }
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') throw err;
  }
  const suffix = randomBytes(6).toString('hex');
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${suffix}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode, flag: 'wx' });
    renameSync(tmpPath, filePath);
    try {
      chmodSync(filePath, mode);
    } catch {
      // ignore chmod failures on restricted filesystems
    }
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

/**
 * Read plugin config.json merged over neutral defaults.
 * @template {Record<string, unknown>} T
 * @param {string} configPath
 * @param {T} defaults
 * @returns {T}
 */
export function readConfig(configPath, defaults) {
  const parsed = readJsonSafe(configPath, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...defaults };
  }
  return { ...defaults, ...parsed };
}

/**
 * Persist plugin config.json atomically with 0o600 mode.
 * @param {string} configPath
 * @param {Record<string, unknown>} config
 */
export function writeConfig(configPath, config) {
  writeJsonAtomic(configPath, config, { mode: 0o600 });
}

/**
 * Parse and clamp an integer within `[min, max]`, returning `undefined` when invalid.
 * Rejects `null`, booleans, objects, and blank strings rather than coercing to `0`.
 * @param {unknown} raw
 * @param {number} min
 * @param {number} max
 * @returns {number | undefined}
 */
export function clampInt(raw, min, max) {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return undefined;
  if (typeof raw === 'string' && !raw.trim()) return undefined;
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * Extract readable error message.
 * @param {unknown} err
 * @returns {string}
 */
export function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}

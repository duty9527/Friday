import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { resolveHomeDir } from './config-store.mjs';

const execFileAsync = promisify(execFile);

const SSH_USER_HOST_RE = /^[A-Za-z0-9._-]+@(?:\[[A-Za-z0-9:]+\]|[A-Za-z0-9._-]+)$/;
const SSH_ID_RE = /^[A-Za-z0-9._-]+$/;
// Keep expanded Unix domain socket path strictly < 100 bytes for Linux/BSD sun_path safety.
const MAX_UNIX_SOCKET_PATH_BYTES = 100;
const SSH_MUX_ERROR_RE = /(?:Control socket|mux_client_|muxserver_|mux master|ControlPath)/i;

/** @type {Map<string, { controlPath: string; userHost: string; port?: number }>} */
const ACTIVE_CONTROL_MASTERS = new Map();
let exitCleanupRegistered = false;

/**
 * Best-effort cleanup for tracked OpenSSH ControlPersist mux masters/sockets before exit.
 */
export function cleanupSshControlMasters() {
  for (const entry of ACTIVE_CONTROL_MASTERS.values()) {
    try {
      const args = [
        '-O', 'exit',
        '-o', `ControlPath=${entry.controlPath}`,
      ];
      if (entry.port) args.push('-p', String(entry.port));
      args.push('--', entry.userHost);
      execFileSync('ssh', args, { stdio: 'ignore', timeout: 800 });
    } catch {
      // best-effort socket teardown
    }
  }
  ACTIVE_CONTROL_MASTERS.clear();
}

/**
 * @param {string | undefined} controlPath
 * @param {import('./types.d.ts').SshTarget} target
 */
function trackControlMaster(controlPath, target) {
  if (!controlPath || !target?.userHost) return;
  const key = `${controlPath}\0${target.userHost}\0${target.port ?? ''}`;
  ACTIVE_CONTROL_MASTERS.set(key, {
    controlPath,
    userHost: target.userHost,
    ...(target.port ? { port: target.port } : {}),
  });
  if (!exitCleanupRegistered) {
    exitCleanupRegistered = true;
    process.once('exit', cleanupSshControlMasters);
  }
}

/**
 * @param {string | undefined} controlPath
 * @returns {boolean}
 */
function isSafeControlPathLength(controlPath) {
  if (!controlPath || !controlPath.trim()) return false;
  // OpenSSH expands %C to 40 hex chars; also account conservatively for %h/%p/%r/%n/%L tokens.
  const expanded = controlPath
    .replace(/%C/g, '0'.repeat(40))
    .replace(/%[hnlpr]/g, '0'.repeat(16));
  return Buffer.byteLength(expanded, 'utf8') < MAX_UNIX_SOCKET_PATH_BYTES;
}

/**
 * POSIX single-quote shell escaping.
 * @param {unknown} value
 * @returns {string}
 */
export function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

/**
 * Validate `user@host` (rejects whitespace, leading '-', or shell metacharacters).
 * @param {unknown} userHost
 * @returns {boolean}
 */
export function isValidSshUserHost(userHost) {
  const raw = String(userHost ?? '').trim();
  if (!raw || raw.startsWith('-')) return false;
  return SSH_USER_HOST_RE.test(raw);
}

/**
 * Parse a speaker/router SSH string such as:
 *   `ssh://oh2p=root@192.0.2.10,lx06=root@192.0.2.11:2222?prefix=Friday`
 * into an ordered list of `{ id, userHost, port? }` targets.
 * @param {unknown} rawSpec
 * @param {string} [defaultId]
 * @returns {import('./types.d.ts').SshTarget[]}
 */
export function parseSshTargets(rawSpec, defaultId = 'default') {
  if (!rawSpec || typeof rawSpec !== 'string') return [];
  const cleaned = rawSpec
    .trim()
    .replace(/^ssh:\/\//i, '')
    .split(/[?#]/)[0] ?? '';

  /** @type {import('./types.d.ts').SshTarget[]} */
  const targets = [];
  for (const rawEntry of cleaned.split(/[;,]/)) {
    const entry = rawEntry.trim();
    if (!entry) continue;

    let id = '';
    let rest = entry;
    const eqIdx = entry.indexOf('=');
    if (eqIdx > 0) {
      const candidateId = entry.slice(0, eqIdx).trim();
      if (SSH_ID_RE.test(candidateId)) {
        id = candidateId;
        rest = entry.slice(eqIdx + 1).trim();
      }
    }

    let userHost = rest;
    /** @type {number | undefined} */
    let port;
    const colonIdx = rest.lastIndexOf(':');
    const closeBracketIdx = rest.lastIndexOf(']');
    if (colonIdx > closeBracketIdx && colonIdx > 0) {
      const portStr = rest.slice(colonIdx + 1).trim();
      if (/^\d{1,5}$/.test(portStr)) {
        const maybePort = Number(portStr);
        if (Number.isInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
          port = maybePort;
          userHost = rest.slice(0, colonIdx).trim();
        }
      }
    }

    if (!isValidSshUserHost(userHost)) continue;
    targets.push({
      id: id || `${defaultId}${targets.length ? `-${targets.length + 1}` : ''}`,
      userHost,
      ...(port !== undefined ? { port } : {}),
    });
  }
  return targets;
}

/**
 * Parse a single `[id=]user@host[:port]` target specification.
 * @param {unknown} rawSpec
 * @param {string} [defaultId]
 * @returns {import('./types.d.ts').SshTarget | undefined}
 */
export function parseSshSpec(rawSpec, defaultId = 'default') {
  const list = parseSshTargets(rawSpec, defaultId);
  return list[0];
}

/**
 * Ensure private `<homeDir>/run` directory with 0o700 permissions (refusing symlinks).
 * Never uses `/tmp/`.
 * @param {string} homeDir
 * @returns {string}
 */
export function resolvePrivateRunDir(homeDir) {
  const runDir = join(resolve(homeDir), 'run');
  let st;
  try {
    st = lstatSync(runDir);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'ENOENT') throw err;
  }
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Refusing insecure SSH run directory (must be a real directory): ${runDir}`);
    }
    chmodSync(runDir, 0o700);
    return runDir;
  }
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const created = lstatSync(runDir);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new Error(`Refusing insecure SSH run directory (must be a real directory): ${runDir}`);
  }
  chmodSync(runDir, 0o700);
  return runDir;
}

/**
 * Compute private ControlPath under `<homeDir>/run/ssh-ctl-%C` when path length fits
 * OS sun_path limits; otherwise returns undefined so caller cleanly falls back.
 * @param {string | undefined} homeDir
 * @returns {string | undefined}
 */
export function resolvePrivateControlPath(homeDir) {
  if (!homeDir || !homeDir.trim()) return undefined;
  const runDir = resolvePrivateRunDir(homeDir);
  const template = join(runDir, 'ssh-ctl-%C');
  if (!isSafeControlPathLength(template)) {
    return undefined;
  }
  return template;
}

/**
 * Build consistent OpenSSH client arguments.
 * @param {import('./types.d.ts').SshTarget} target
 * @param {{
 *   connectTimeoutSec?: number;
 *   serverAliveInterval?: number;
 *   serverAliveCountMax?: number;
 *   homeDir?: string;
 *   controlPath?: string;
 *   controlPersistSec?: number;
 *   useControlMaster?: boolean;
 *   allowLegacyRsa?: boolean;
 * }} [options]
 * @returns {string[]}
 */
export function buildSshArgs(target, options = {}) {
  if (!isValidSshUserHost(target?.userHost)) {
    throw new Error(`Invalid SSH userHost "${target?.userHost ?? ''}"`);
  }
  if (target?.port !== undefined) {
    const portNum = Number(target.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error(`Invalid SSH port "${String(target.port)}"`);
    }
  }

  const {
    connectTimeoutSec = 5,
    serverAliveInterval = 5,
    serverAliveCountMax = 2,
    homeDir,
    controlPath,
    controlPersistSec = 60,
    useControlMaster = true,
    allowLegacyRsa = false,
  } = options;

  const args = [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${connectTimeoutSec}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ServerAliveInterval=${serverAliveInterval}`,
    '-o', `ServerAliveCountMax=${serverAliveCountMax}`,
  ];
  if (allowLegacyRsa) {
    args.push(
      '-o', 'HostKeyAlgorithms=+ssh-rsa',
      '-o', 'PubkeyAcceptedKeyTypes=+ssh-rsa',
    );
  }

  const candidateControlPath = useControlMaster
    ? (controlPath ?? resolvePrivateControlPath(homeDir))
    : undefined;
  const resolvedControlPath = candidateControlPath && isSafeControlPathLength(candidateControlPath)
    ? candidateControlPath
    : undefined;

  if (resolvedControlPath) {
    args.push(
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${resolvedControlPath}`,
      '-o', `ControlPersist=${controlPersistSec}`,
    );
  } else {
    args.push('-o', 'ControlMaster=no', '-o', 'ControlPath=none');
  }

  if (target.port) {
    args.push('-p', String(target.port));
  }
  return args;
}

/**
 * Run a remote command over SSH returning UTF-8 text.
 * Supports AbortSignal and ControlMaster mux failure fallback retry without ControlMaster.
 * Never blindly retries on remote command `exit 255` to avoid replaying non-idempotent commands.
 * @param {import('./types.d.ts').SshTarget} target
 * @param {string} remoteCmd
 * @param {{
 *   timeoutMs?: number;
 *   maxBuffer?: number;
 *   signal?: AbortSignal;
 *   homeDir?: string;
 *   controlPath?: string;
 *   controlPersistSec?: number;
 *   useControlMaster?: boolean;
 *   allowLegacyRsa?: boolean;
 *   idempotent?: boolean;
 * }} [options]
 * @returns {Promise<import('./types.d.ts').SshExecResult>}
 */
export async function execSshText(target, remoteCmd, options = {}) {
  if (!isValidSshUserHost(target?.userHost)) {
    throw new Error(`Invalid SSH userHost "${target?.userHost ?? ''}"`);
  }
  const {
    timeoutMs = 15_000,
    maxBuffer = 2 * 1024 * 1024,
    signal,
    homeDir,
    controlPath,
    controlPersistSec = 60,
    useControlMaster = Boolean(controlPath || homeDir),
    allowLegacyRsa = false,
  } = options;

  /** @param {boolean} withMaster */
  const runOnce = async withMaster => {
    const sshArgs = buildSshArgs(target, {
      connectTimeoutSec: 5,
      homeDir,
      controlPath,
      controlPersistSec,
      useControlMaster: withMaster,
      allowLegacyRsa,
    });
    let usedControlMaster = false;
    if (withMaster) {
      const ctlArg = sshArgs.find(a => a.startsWith('ControlPath=') && a !== 'ControlPath=none');
      if (ctlArg) {
        usedControlMaster = true;
        trackControlMaster(ctlArg.slice('ControlPath='.length), target);
      }
    }
    sshArgs.push('--', target.userHost, remoteCmd);
    try {
      const { stdout, stderr } = await execFileAsync('ssh', sshArgs, {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer,
        ...(signal ? { signal } : {}),
      });
      return { stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: 0, usedControlMaster };
    } catch (err) {
      const e = /** @type {{ name?: string; stdout?: unknown; stderr?: unknown; code?: unknown; status?: unknown; killed?: boolean; signal?: unknown; message?: string }} */ (err);
      if (signal?.aborted || e?.name === 'AbortError') throw err;
      const numericCode = typeof e?.code === 'number' ? e.code : (typeof e?.status === 'number' ? e.status : undefined);
      const code = numericCode ?? 1;
      const rawStderr = e?.stderr !== undefined && e?.stderr !== null ? String(e.stderr) : '';
      const abnormalExit = Boolean(e?.killed || e?.signal || numericCode === undefined);
      const stderr = rawStderr || (abnormalExit || (e?.stderr === undefined || e?.stderr === null) ? String(e?.message ?? '') : '');
      return {
        stdout: String(e?.stdout ?? ''),
        stderr,
        code,
        usedControlMaster,
      };
    }
  };

  const first = await runOnce(useControlMaster);
  if (first.code === 255 && first.usedControlMaster && SSH_MUX_ERROR_RE.test(first.stderr)) {
    const retried = await runOnce(false);
    return { stdout: retried.stdout, stderr: retried.stderr, code: retried.code };
  }
  return { stdout: first.stdout, stderr: first.stderr, code: first.code };
}

/**
 * Run a remote command over SSH returning raw binary Buffer output (e.g., tar streams).
 * @param {import('./types.d.ts').SshTarget} target
 * @param {string} remoteCmd
 * @param {{
 *   timeoutMs?: number;
 *   maxBuffer?: number;
 *   signal?: AbortSignal;
 *   homeDir?: string;
 *   controlPath?: string;
 *   useControlMaster?: boolean;
 *   allowLegacyRsa?: boolean;
 * }} [options]
 * @returns {Promise<import('./types.d.ts').SshBinaryExecResult>}
 */
export async function execSshBinary(target, remoteCmd, options = {}) {
  if (!isValidSshUserHost(target?.userHost)) {
    throw new Error(`Invalid SSH userHost "${target?.userHost ?? ''}"`);
  }
  const {
    timeoutMs = 20_000,
    maxBuffer = 32 * 1024 * 1024,
    signal,
    homeDir,
    controlPath,
    useControlMaster = false,
    allowLegacyRsa = false,
  } = options;

  const sshArgs = buildSshArgs(target, {
    connectTimeoutSec: 5,
    homeDir,
    controlPath,
    useControlMaster,
    allowLegacyRsa,
  });
  if (useControlMaster) {
    const ctlArg = sshArgs.find(a => a.startsWith('ControlPath=') && a !== 'ControlPath=none');
    if (ctlArg) {
      trackControlMaster(ctlArg.slice('ControlPath='.length), target);
    }
  }
  sshArgs.push('--', target.userHost, remoteCmd);

  try {
    const { stdout, stderr } = await execFileAsync('ssh', sshArgs, {
      encoding: 'buffer',
      timeout: timeoutMs,
      maxBuffer,
      ...(signal ? { signal } : {}),
    });
    return {
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
      stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''),
      code: 0,
    };
  } catch (err) {
    const e = /** @type {{ name?: string; stdout?: unknown; stderr?: unknown; code?: unknown; status?: unknown; killed?: boolean; signal?: unknown; message?: string }} */ (err);
    if (signal?.aborted || e?.name === 'AbortError') throw err;
    const numericCode = typeof e?.code === 'number' ? e.code : (typeof e?.status === 'number' ? e.status : undefined);
    const code = numericCode ?? 1;
    const stdoutBuf = Buffer.isBuffer(e?.stdout) ? e.stdout : Buffer.from(String(e?.stdout ?? ''), 'utf8');
    const rawStderr = Buffer.isBuffer(e?.stderr)
      ? e.stderr.toString('utf8')
      : (e?.stderr !== undefined && e?.stderr !== null ? String(e.stderr) : '');
    const abnormalExit = Boolean(e?.killed || e?.signal || numericCode === undefined);
    const stderrStr = rawStderr || (abnormalExit || (e?.stderr === undefined || e?.stderr === null) ? String(e?.message ?? '') : '');
    return { stdout: stdoutBuf, stderr: stderrStr, code };
  }
}

/**
 * Select preferred target from an ordered SSH target list.
 * @param {import('./types.d.ts').SshTarget[]} targets
 * @param {string} preferredId
 * @param {string} [defaultTarget]
 * @returns {import('./types.d.ts').SshTarget | undefined}
 */
function pickPreferredTarget(targets, preferredId, defaultTarget = '') {
  return (
    targets.find(
      t =>
        t.id.toLowerCase() === preferredId.toLowerCase() ||
        t.userHost.toLowerCase() === preferredId.toLowerCase(),
    ) ||
    targets.find(t => /lx06/i.test(t.id)) ||
    (defaultTarget ? targets.find(t => t.id === defaultTarget) : undefined) ||
    targets[0]
  );
}

/**
 * Resolve optional XiaoAI speaker SSH target from explicit args/env first, falling
 * back read-only to `<homeDir>/state.sqlite` only when no explicit/env target exists.
 * @param {{ homeDir?: string; ssh?: string; speakerSsh?: string; env?: Record<string, string | undefined>; sqliteFallback?: boolean }} [contextOrDeps]
 * @param {string} [preferredId]
 * @returns {{ target: import('./types.d.ts').SshTarget; channelId: string } | null}
 */
export function discoverOptionalXiaoaiSshFromSqlite(contextOrDeps = {}, preferredId = 'lx06') {
  const env = contextOrDeps?.env ?? process.env;
  const envSpec = [
    contextOrDeps?.speakerSsh,
    contextOrDeps?.ssh,
    env?.FRIDAY_XIAOAI_SSH,
    env?.XIAOAI_SSH,
  ].find(v => typeof v === 'string' && v.trim());

  if (envSpec) {
    const envTargets = parseSshTargets(envSpec, preferredId || 'xiaoai');
    const envPreferred = pickPreferredTarget(envTargets, preferredId);
    if (envPreferred) {
      return { target: envPreferred, channelId: 'env' };
    }
  }

  if (contextOrDeps?.sqliteFallback === false) {
    return null;
  }

  const homeDir = resolveHomeDir(contextOrDeps);
  const dbPath = join(homeDir, 'state.sqlite');
  if (!existsSync(dbPath)) return null;

  /** @type {DatabaseSync | undefined} */
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = /** @type {Array<{ id: string; platform?: string; body: string }>} */ (
      db.prepare('SELECT id, platform, body FROM im_channels ORDER BY updated_at DESC').all()
    );

    /** @type {Array<{ channelId: string; enabled: boolean; defaultTarget: string; targets: import('./types.d.ts').SshTarget[] }>} */
    const candidates = [];
    for (const row of rows) {
      let body;
      try {
        body = JSON.parse(row.body);
      } catch {
        continue;
      }
      const platform = String(row.platform ?? body?.platform ?? '').trim().toLowerCase();
      if (!body || platform !== 'xiaoai') continue;
      const targets = parseSshTargets(body.apiBase);
      if (targets.length === 0) continue;
      candidates.push({
        channelId: row.id,
        enabled: body.enabled !== false,
        defaultTarget: typeof body.defaultTarget === 'string' ? body.defaultTarget.trim() : '',
        targets,
      });
    }

    candidates.sort((a, b) => Number(b.enabled) - Number(a.enabled));
    for (const cand of candidates) {
      const preferred = pickPreferredTarget(cand.targets, preferredId, cand.defaultTarget);
      if (preferred) {
        return { target: preferred, channelId: cand.channelId };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}

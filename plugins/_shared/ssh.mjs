import { execFile } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { resolveHomeDir } from './config-store.mjs';

const execFileAsync = promisify(execFile);

const SSH_USER_HOST_RE = /^[A-Za-z0-9._-]+@(?:\[[A-Za-z0-9:]+\]|[A-Za-z0-9._-]+)$/;
const SSH_ID_RE = /^[A-Za-z0-9._-]+$/;
const MAX_UNIX_SOCKET_PATH_BYTES = 104;

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
      const maybePort = Number(rest.slice(colonIdx + 1));
      if (Number.isInteger(maybePort) && maybePort >= 1 && maybePort <= 65535) {
        port = maybePort;
        userHost = rest.slice(0, colonIdx).trim();
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
  if (existsSync(runDir)) {
    const st = lstatSync(runDir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Refusing insecure SSH run directory (must be a real directory): ${runDir}`);
    }
    chmodSync(runDir, 0o700);
    return runDir;
  }
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
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
  // OpenSSH expands %C to 40 hex chars; Linux sun_path max is 108 bytes.
  const estimatedExpandedBytes = Buffer.byteLength(template, 'utf8') - 2 + 40;
  if (estimatedExpandedBytes > MAX_UNIX_SOCKET_PATH_BYTES) {
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

  const resolvedControlPath = useControlMaster
    ? (controlPath ?? resolvePrivateControlPath(homeDir))
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
 * Supports AbortSignal and ControlMaster=255 fallback retry without ControlMaster.
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
    sshArgs.push(target.userHost, remoteCmd);
    try {
      const { stdout, stderr } = await execFileAsync('ssh', sshArgs, {
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer,
        ...(signal ? { signal } : {}),
      });
      return { stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: 0 };
    } catch (err) {
      const e = /** @type {{ name?: string; stdout?: unknown; stderr?: unknown; code?: unknown; status?: unknown; message?: string }} */ (err);
      if (e?.name === 'AbortError') throw err;
      const code = typeof e?.code === 'number' ? e.code : (typeof e?.status === 'number' ? e.status : 1);
      return {
        stdout: String(e?.stdout ?? ''),
        stderr: String(e?.stderr ?? e?.message ?? ''),
        code,
      };
    }
  };

  const first = await runOnce(useControlMaster);
  if (first.code === 255 && useControlMaster) {
    return await runOnce(false);
  }
  return first;
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
  sshArgs.push(target.userHost, remoteCmd);

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
    const e = /** @type {{ name?: string; stdout?: unknown; stderr?: unknown; code?: unknown; status?: unknown; message?: string }} */ (err);
    if (e?.name === 'AbortError') throw err;
    const code = typeof e?.code === 'number' ? e.code : (typeof e?.status === 'number' ? e.status : 1);
    const stdoutBuf = Buffer.isBuffer(e?.stdout) ? e.stdout : Buffer.from(String(e?.stdout ?? ''), 'utf8');
    const stderrStr = Buffer.isBuffer(e?.stderr) ? e.stderr.toString('utf8') : String(e?.stderr ?? e?.message ?? '');
    return { stdout: stdoutBuf, stderr: stderrStr, code };
  }
}

/**
 * Gracefully inspect `<homeDir>/state.sqlite` (read-only) for an enabled XiaoAI channel
 * SSH target when plugin-local `config.json` does not explicitly specify `speakerSsh` / `sshTarget`.
 * @param {{ homeDir?: string; env?: Record<string, string | undefined> }} [contextOrDeps]
 * @param {string} [preferredId]
 * @returns {{ target: import('./types.d.ts').SshTarget; channelId: string } | null}
 */
export function discoverOptionalXiaoaiSshFromSqlite(contextOrDeps = {}, preferredId = 'lx06') {
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
      const preferred =
        cand.targets.find(
          t =>
            t.id.toLowerCase() === preferredId.toLowerCase() ||
            t.userHost.toLowerCase() === preferredId.toLowerCase(),
        ) ||
        cand.targets.find(t => /lx06/i.test(t.id)) ||
        (cand.defaultTarget ? cand.targets.find(t => t.id === cand.defaultTarget) : undefined) ||
        cand.targets[0];
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

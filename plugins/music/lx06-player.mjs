import { resolve } from 'node:path';
import {
  discoverOptionalXiaoaiSshFromSqlite,
  execSshText,
  parseSshSpec,
  shellQuote,
} from '../_shared/ssh.mjs';

/**
 * @typedef {(target: import('../_shared/types.d.ts').SshTarget, remoteCmd: string, opts?: Record<string, unknown>) => Promise<import('../_shared/types.d.ts').SshExecResult>} SshExecFn
 */

/** @type {Map<string, { epoch: number; timer: ReturnType<typeof setTimeout> | null; stopped: boolean }>} */
const ACTIVE_WATCHERS = new Map();

/**
 * @param {string} [speakerSsh]
 * @param {string} [homeDir]
 * @returns {{ target: import('../_shared/types.d.ts').SshTarget; source: string } | null}
 */
export function resolveMusicSpeakerTarget(speakerSsh, homeDir) {
  const explicit = typeof speakerSsh === 'string' ? speakerSsh.trim() : '';
  if (explicit) {
    const parsed = parseSshSpec(explicit, 'lx06');
    if (parsed) return { target: parsed, source: 'config' };
  }
  const found = discoverOptionalXiaoaiSshFromSqlite({ homeDir }, 'lx06');
  if (!found) return null;
  return { target: found.target, source: found.channelId };
}

/**
 * @param {string} method
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
export function buildMediaplayerUbusCmd(method, payload) {
  return `ubus -t 5 call mediaplayer ${method} ${shellQuote(JSON.stringify(payload))}`;
}

/**
 * @param {string} stdout
 * @returns {{ status: number | null; volume: number | null; loopType: number | null; raw: unknown }}
 */
export function parseLx06PlayStatus(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return { status: null, volume: null, loopType: null, raw: null };
  let outer;
  try {
    outer = JSON.parse(text);
  } catch {
    return { status: null, volume: null, loopType: null, raw: text };
  }
  let info = outer?.info;
  if (typeof info === 'string') {
    try {
      info = JSON.parse(info);
    } catch {
      info = null;
    }
  }
  if (!info || typeof info !== 'object') {
    info = outer;
  }
  const stRaw = Number(info?.status);
  const volRaw = Number(info?.volume);
  const loopRaw = Number(info?.loop_type);
  return {
    status: Number.isInteger(stRaw) ? stRaw : null,
    volume: Number.isFinite(volRaw) ? Math.max(0, Math.min(100, Math.round(volRaw))) : null,
    loopType: Number.isInteger(loopRaw) ? loopRaw : null,
    raw: info,
  };
}

/**
 * @param {import('../_shared/types.d.ts').SshTarget} target
 * @param {string} remoteCmd
 * @param {{ sshRunner?: SshExecFn; homeDir?: string; timeoutMs?: number; signal?: AbortSignal }} [deps]
 * @returns {Promise<import('../_shared/types.d.ts').SshExecResult>}
 */
async function runLx06Cmd(target, remoteCmd, deps = {}) {
  const runner = deps.sshRunner ?? ((t, cmd, opts) => execSshText(t, cmd, opts));
  return runner(target, remoteCmd, {
    timeoutMs: deps.timeoutMs ?? 8000,
    allowLegacyRsa: true,
    useControlMaster: true,
    ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
}

/**
 * @param {import('../_shared/types.d.ts').SshTarget} target
 * @param {{ sshRunner?: SshExecFn; homeDir?: string; timeoutMs?: number; signal?: AbortSignal }} [deps]
 */
export async function getLx06PlayStatus(target, deps = {}) {
  const res = await runLx06Cmd(target, 'ubus -t 5 call mediaplayer player_get_play_status', {
    ...deps,
    timeoutMs: deps.timeoutMs ?? 4500,
  });
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || `查询小爱播放状态失败 (exit=${res.code})`);
  }
  return parseLx06PlayStatus(res.stdout);
}

/**
 * @param {import('../_shared/types.d.ts').SshTarget} target
 * @param {string} streamUrl
 * @param {{ sshRunner?: SshExecFn; homeDir?: string; signal?: AbortSignal }} [deps]
 */
export async function lx06PlayUrl(target, streamUrl, deps = {}) {
  const ubusCmd = buildMediaplayerUbusCmd('player_play_url', {
    url: streamUrl,
    type: 1,
    media: 'common',
  });
  const cmd = `(/bin/shut_led 1 >/dev/null 2>&1; /bin/shut_led 2 >/dev/null 2>&1 || true); ${ubusCmd}`;
  const res = await runLx06Cmd(target, cmd, deps);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || `推送音乐到小爱失败 (exit=${res.code})`);
  }
  return res;
}

/**
 * @param {import('../_shared/types.d.ts').SshTarget} target
 * @param {'play' | 'pause' | 'stop' | 'toggle' | 'next' | 'prev'} action
 * @param {{ sshRunner?: SshExecFn; homeDir?: string; signal?: AbortSignal }} [deps]
 */
export async function lx06PlayOperation(target, action, deps = {}) {
  const cmd = buildMediaplayerUbusCmd('player_play_operation', {
    action,
    media: 'common',
  });
  const res = await runLx06Cmd(target, cmd, deps);
  let ubusFailed = res.code !== 0;
  if (!ubusFailed && res.stdout.trim()) {
    try {
      const parsed = JSON.parse(res.stdout.trim());
      if (parsed && typeof parsed.code === 'number' && parsed.code !== 0) {
        ubusFailed = true;
      }
    } catch {
      // ignore non-JSON stdout
    }
  }
  if (ubusFailed && action === 'stop') {
    const pauseCmd = buildMediaplayerUbusCmd('player_play_operation', {
      action: 'pause',
      media: 'common',
    });
    const fallbackRes = await runLx06Cmd(target, pauseCmd, deps);
    if (fallbackRes.code === 0) return fallbackRes;
  }
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || `小爱播控操作 ${action} 失败 (exit=${res.code})`);
  }
  return res;
}

/**
 * @param {import('../_shared/types.d.ts').SshTarget} target
 * @param {number} volume
 * @param {{ sshRunner?: SshExecFn; homeDir?: string; signal?: AbortSignal }} [deps]
 */
export async function lx06SetVolume(target, volume, deps = {}) {
  const clamped = Math.max(0, Math.min(100, Math.round(volume)));
  const cmd = buildMediaplayerUbusCmd('player_set_volume', {
    volume: clamped,
    media: 'common',
    tts_silence: true,
  });
  const res = await runLx06Cmd(target, cmd, deps);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || `设置小爱音量失败 (exit=${res.code})`);
  }
  return clamped;
}

/**
 * @param {import('../_shared/types.d.ts').SshTarget} target
 * @param {number} minutes
 * @param {boolean} cancel
 * @param {{ sshRunner?: SshExecFn; homeDir?: string; signal?: AbortSignal }} [deps]
 */
export async function lx06SetShutdownTimer(target, minutes, cancel, deps = {}) {
  const totalMin = Math.max(1, Math.min(240, Math.round(minutes || 0)));
  const hour = Math.floor(totalMin / 60);
  const minute = totalMin % 60;
  const cmd = buildMediaplayerUbusCmd('player_set_shutdown_timer', {
    action: cancel ? 'cancel' : 'start',
    hour: cancel ? 0 : hour,
    minute: cancel ? 0 : minute,
    second: 0,
    media: 'common',
  });
  const res = await runLx06Cmd(target, cmd, deps);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || `设置睡眠定时失败 (exit=${res.code})`);
  }
  return cancel ? 0 : totalMin;
}

/**
 * @param {string} pluginDataDir
 */
export function stopMusicWatcher(pluginDataDir) {
  const key = resolve(pluginDataDir);
  const existing = ACTIVE_WATCHERS.get(key);
  if (existing) {
    existing.stopped = true;
    if (existing.timer) clearTimeout(existing.timer);
    ACTIVE_WATCHERS.delete(key);
  }
}

export function stopAllMusicWatchers() {
  for (const key of [...ACTIVE_WATCHERS.keys()]) {
    stopMusicWatcher(key);
  }
}

/**
 * @param {{
 *   pluginDataDir: string;
 *   epoch: number;
 *   intervalMs?: number;
 *   onTick: (epoch: number) => Promise<number | false>;
 * }} opts
 */
export function startMusicWatcher(opts) {
  const key = resolve(opts.pluginDataDir);
  stopMusicWatcher(key);

  const entry = {
    epoch: opts.epoch,
    timer: /** @type {ReturnType<typeof setTimeout> | null} */ (null),
    stopped: false,
  };
  ACTIVE_WATCHERS.set(key, entry);

  const scheduleNext = (delayMs) => {
    if (entry.stopped || ACTIVE_WATCHERS.get(key) !== entry) return;
    entry.timer = setTimeout(async () => {
      if (entry.stopped || ACTIVE_WATCHERS.get(key) !== entry) return;
      try {
        const nextDelay = await opts.onTick(entry.epoch);
        if (entry.stopped || ACTIVE_WATCHERS.get(key) !== entry) return;
        if (typeof nextDelay === 'number' && nextDelay > 0) {
          scheduleNext(nextDelay);
        } else {
          stopMusicWatcher(key);
        }
      } catch {
        if (!entry.stopped && ACTIVE_WATCHERS.get(key) === entry) {
          scheduleNext(opts.intervalMs ?? 4000);
        }
      }
    }, Math.max(50, delayMs));
    entry.timer.unref?.();
  };

  scheduleNext(opts.intervalMs ?? 3500);
}

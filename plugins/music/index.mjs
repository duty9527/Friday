#!/usr/bin/env node
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clampInt,
  ensurePrivateDir,
  errMsg,
  readConfig,
  readJsonSafe,
  resolvePluginPaths,
  withFileLock,
  writeConfig,
  writeJsonAtomic,
} from '../_shared/config-store.mjs';
import {
  clearDownloadJobs,
  downloadOnlineAudioFile,
  findYtDlp,
  formatYtDlpError,
  inspectNetscapeCookiesFile,
  loadDownloadJobs,
  normalizeNetscapeCookiesText,
  removeDownloadJob,
  searchOnlineTracks,
  upsertDownloadJob,
} from './downloader.mjs';
import { handleMusicVoiceFastpath } from './fastpath.mjs';
import {
  deleteTrackById,
  ensurePlayableFile,
  loadLibrary,
  loadPlaylists,
  mutatePlaylist,
  readTrackLyrics,
  resolveDefaultMusicDir,
  scanLibrary,
  searchLocalTracks,
} from './library.mjs';
import {
  getLx06PlayStatus,
  lx06PlayOperation,
  lx06PlayUrl,
  lx06SetShutdownTimer,
  lx06SetVolume,
  resolveMusicSpeakerTarget,
  startMusicWatcher,
  stopAllMusicWatchers,
  stopMusicWatcher,
} from './lx06-player.mjs';

export { stopAllMusicWatchers };

export const ACTIONS = [
  'dashboard',
  'status',
  'scan',
  'tracks',
  'lyrics',
  'play',
  'pause',
  'resume',
  'stop',
  'next',
  'prev',
  'volume',
  'loop',
  'timer',
  'queue',
  'playlist',
  'search-online',
  'download',
  'downloads',
  'delete-track',
  'config',
];

const LOOP_MODES = new Set(['list', 'single', 'shuffle', 'once']);
const LOOP_LABELS = {
  list: '列表循环',
  single: '单曲循环',
  shuffle: '随机播放',
  once: '顺序单次',
};
const SECRET_HEX_RE = /^[a-f0-9]{64}$/i;

/** @type {Map<string, Promise<unknown>>} */
const ACTIVE_DOWNLOAD_PROMISES = new Map();
/** @type {Map<string, import('./downloader.mjs').DownloadJob>} */
const ACTIVE_DOWNLOAD_PROGRESS = new Map();

/**
 * @param {string} homeDir
 * @returns {Record<string, unknown>}
 */
function buildDefaultConfig(homeDir) {
  return {
    musicDir: resolveDefaultMusicDir(homeDir),
    streamBaseUrl: '',
    speakerSsh: '',
    defaultVolume: 45,
    downloadFormat: 'mp3',
    defaultSearchSource: 'youtube',
    ytDlpPath: '',
    autoDownloadOnVoiceMiss: false,
  };
}

/**
 * @param {unknown} raw
 * @returns {'youtube' | 'bilibili' | 'soundcloud'}
 */
function normalizeSearchSource(raw) {
  const s = String(raw ?? 'youtube').trim().toLowerCase();
  if (s === 'bilibili' || s === 'soundcloud') return s;
  return 'youtube';
}

/**
 * @param {string} pluginDataDir
 * @returns {string}
 */
function resolveCookiesPath(pluginDataDir) {
  const filePath = join(pluginDataDir, 'cookies.txt');
  if (!existsSync(filePath)) return '';
  try {
    const st = statSync(filePath);
    return st.isFile() && st.size > 0 ? filePath : '';
  } catch {
    return '';
  }
}

/**
 * @param {string} configPath
 * @param {string} homeDir
 */
function loadEffectiveConfig(configPath, homeDir) {
  const defaults = buildDefaultConfig(homeDir);
  const raw = readConfig(configPath, defaults);
  return {
    musicDir: typeof raw.musicDir === 'string' && raw.musicDir.trim() ? resolve(raw.musicDir.trim()) : String(defaults.musicDir),
    streamBaseUrl: typeof raw.streamBaseUrl === 'string' ? raw.streamBaseUrl.trim().replace(/\/+$/, '') : '',
    speakerSsh: typeof raw.speakerSsh === 'string' ? raw.speakerSsh.trim() : '',
    defaultVolume: clampInt(raw.defaultVolume, 0, 100) ?? 45,
    downloadFormat: String(raw.downloadFormat ?? 'mp3').trim().toLowerCase() === 'm4a' ? 'm4a' : 'mp3',
    defaultSearchSource: normalizeSearchSource(raw.defaultSearchSource),
    ytDlpPath: typeof raw.ytDlpPath === 'string' ? raw.ytDlpPath.trim() : '',
    autoDownloadOnVoiceMiss: Boolean(raw.autoDownloadOnVoiceMiss),
  };
}

/**
 * @param {string} configuredBase
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveStreamBaseUrl(configuredBase, env = process.env) {
  const explicit = String(configuredBase ?? '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const portRaw = Number(env?.FRIDAY_WEB_PORT || env?.PORT || 3210);
  const port = Number.isInteger(portRaw) && portRaw > 0 && portRaw <= 65535 ? portRaw : 3210;
  try {
    const nets = networkInterfaces();
    /** @type {string[]} */
    const candidates = [];
    for (const entries of Object.values(nets)) {
      if (!Array.isArray(entries)) continue;
      for (const info of entries) {
        if (!info || info.internal || info.family !== 'IPv4' || !info.address) continue;
        candidates.push(info.address);
      }
    }
    const lanIp = candidates.find((ip) => ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(?:1[6-9]|2\d|3[01])\./.test(ip))
      ?? candidates[0];
    if (lanIp) return `http://${lanIp}:${port}`;
  } catch {
    // ignore networkInterfaces error
  }
  return `http://127.0.0.1:${port}`;
}

/**
 * @param {string} pluginDataDir
 * @returns {string}
 */
function ensureStreamSecretSync(pluginDataDir) {
  ensurePrivateDir(pluginDataDir);
  const secretPath = join(pluginDataDir, 'stream-secret');
  if (existsSync(secretPath)) {
    try {
      const existing = readFileSync(secretPath, 'utf8').trim();
      if (SECRET_HEX_RE.test(existing)) return existing.toLowerCase();
    } catch {
      // regenerate if unreadable
    }
  }
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(secretPath, 0o600);
  } catch {
    // ignore chmod failures
  }
  return secret;
}

/**
 * @param {string} secret
 * @param {string} trackId
 * @param {string} ext
 * @param {number} [ttlSec]
 * @returns {string}
 */
function signRelativeStreamPath(secret, trackId, ext, ttlSec = 14_400) {
  const expSec = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = createHmac('sha256', secret).update(`${trackId}:${expSec}`).digest('hex');
  return `/media/music/${trackId}${ext}?exp=${expSec}&sig=${sig}`;
}

/**
 * @param {string} pluginDataDir
 * @param {number} defaultVolume
 */
function loadPlaybackState(pluginDataDir, defaultVolume) {
  const raw = readJsonSafe(join(pluginDataDir, 'playback-state.json'), null);
  const rec = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const loopRaw = String(rec.loopMode ?? 'list');
  const statusRaw = String(rec.status ?? 'stopped');
  return {
    status: statusRaw === 'playing' || statusRaw === 'paused' ? statusRaw : 'stopped',
    currentTrackId: typeof rec.currentTrackId === 'string' && rec.currentTrackId ? rec.currentTrackId : null,
    queue: Array.isArray(rec.queue) ? rec.queue.map((x) => String(x)).filter(Boolean) : [],
    queueIndex: typeof rec.queueIndex === 'number' && Number.isInteger(rec.queueIndex) ? rec.queueIndex : -1,
    loopMode: LOOP_MODES.has(loopRaw) ? loopRaw : 'list',
    volume: typeof rec.volume === 'number' && Number.isFinite(rec.volume) ? Math.max(0, Math.min(100, Math.round(rec.volume))) : defaultVolume,
    startedAtMs: typeof rec.startedAtMs === 'number' && Number.isFinite(rec.startedAtMs) ? rec.startedAtMs : null,
    positionSec: typeof rec.positionSec === 'number' && Number.isFinite(rec.positionSec) ? Math.max(0, Math.round(rec.positionSec)) : 0,
    timerEndsAtMs: typeof rec.timerEndsAtMs === 'number' && Number.isFinite(rec.timerEndsAtMs) ? rec.timerEndsAtMs : null,
    playEpoch: typeof rec.playEpoch === 'number' && Number.isInteger(rec.playEpoch) ? rec.playEpoch : 0,
    sawPlaying: Boolean(rec.sawPlaying),
    consecutivePollErrors: typeof rec.consecutivePollErrors === 'number' && Number.isInteger(rec.consecutivePollErrors) ? rec.consecutivePollErrors : 0,
    stoppedPolls: typeof rec.stoppedPolls === 'number' && Number.isInteger(rec.stoppedPolls) ? rec.stoppedPolls : 0,
    updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : Date.now(),
  };
}

/**
 * @param {string} pluginDataDir
 * @param {ReturnType<typeof loadPlaybackState>} state
 */
function savePlaybackState(pluginDataDir, state) {
  state.updatedAt = Date.now();
  writeJsonAtomic(join(pluginDataDir, 'playback-state.json'), state);
}

/**
 * @param {ReturnType<typeof loadPlaybackState>} state
 * @returns {number}
 */
function computePositionSec(state) {
  if (state.status === 'playing' && typeof state.startedAtMs === 'number') {
    return Math.max(0, Math.floor((Date.now() - state.startedAtMs) / 1000));
  }
  return Math.max(0, Math.floor(state.positionSec || 0));
}

/**
 * @param {ReturnType<typeof loadPlaybackState>} state
 * @returns {number}
 */
function computePositionMs(state) {
  if (state.status === 'playing' && typeof state.startedAtMs === 'number') {
    return Math.max(0, Date.now() - state.startedAtMs);
  }
  return Math.max(0, Math.round((state.positionSec || 0) * 1000));
}

/**
 * @param {import('./library.mjs').MusicTrack[]} tracks
 * @param {ReturnType<typeof loadPlaybackState>} state
 */
function reconcileQueue(tracks, state) {
  const validIds = new Set(tracks.map((t) => t.id));
  state.queue = state.queue.filter((id) => validIds.has(id));
  if (state.currentTrackId && !validIds.has(state.currentTrackId)) {
    state.currentTrackId = null;
  }
  if (state.queue.length === 0) {
    state.queueIndex = -1;
    if (state.status !== 'stopped') state.status = 'stopped';
  } else if (state.queueIndex < 0 || state.queueIndex >= state.queue.length) {
    const idx = state.currentTrackId ? state.queue.indexOf(state.currentTrackId) : 0;
    state.queueIndex = idx >= 0 ? idx : 0;
  }
}

/**
 * @param {ReturnType<typeof loadPlaybackState>} state
 * @param {number} currentIndex
 * @param {string} loopMode
 * @returns {number}
 */
function pickNextIndex(state, currentIndex, loopMode) {
  const len = state.queue.length;
  if (len === 0) return -1;
  if (loopMode === 'single') return currentIndex >= 0 ? currentIndex : 0;
  if (loopMode === 'shuffle') {
    if (len === 1) return 0;
    let next = currentIndex;
    for (let i = 0; i < 6 && next === currentIndex; i += 1) {
      next = Math.floor(Math.random() * len);
    }
    if (next === currentIndex) next = (currentIndex + 1) % len;
    return next;
  }
  if (loopMode === 'once') {
    return currentIndex + 1 < len ? currentIndex + 1 : -1;
  }
  return (currentIndex + 1) % len;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, string | undefined>}
 */
function asEnvRecord(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return /** @type {Record<string, string | undefined>} */ (raw);
  }
  return process.env;
}

/**
 * @param {unknown} raw
 * @param {number} fallback
 * @returns {number}
 */
function asWatcherMs(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

/**
 * @param {string} pluginDataDir
 * @param {string} homeDir
 * @param {string} configPath
 * @param {number} epoch
 * @param {Record<string, unknown>} deps
 */
function startPlaybackWatcher(pluginDataDir, homeDir, configPath, epoch, deps = {}) {
  if (deps.disableWatcher === true) return;
  const intervalMs = asWatcherMs(deps.watcherIntervalMs, 3500);
  const fastIntervalMs = asWatcherMs(deps.watcherFastIntervalMs, 1800);
  startMusicWatcher({
    pluginDataDir,
    epoch,
    intervalMs,
    onTick: async (tickEpoch) => {
      return withFileLock(join(pluginDataDir, 'playback-state.json'), async () => {
        const curCfg = loadEffectiveConfig(configPath, homeDir);
        const curState = loadPlaybackState(pluginDataDir, curCfg.defaultVolume);
        if (curState.status !== 'playing' || curState.playEpoch !== tickEpoch) {
          return false;
        }
        if (curState.timerEndsAtMs && Date.now() >= curState.timerEndsAtMs) {
          const spk = resolveMusicSpeakerTarget(curCfg.speakerSsh, homeDir);
          if (spk) {
            await lx06PlayOperation(spk.target, 'stop', { ...deps, homeDir }).catch(() => {});
          }
          curState.status = 'stopped';
          curState.timerEndsAtMs = null;
          curState.startedAtMs = null;
          curState.positionSec = 0;
          savePlaybackState(pluginDataDir, curState);
          return false;
        }

        const spk = resolveMusicSpeakerTarget(curCfg.speakerSsh, homeDir);
        if (!spk) return false;
        let lx;
        try {
          lx = await getLx06PlayStatus(spk.target, { ...deps, homeDir, timeoutMs: 4500 });
          curState.consecutivePollErrors = 0;
        } catch {
          curState.consecutivePollErrors += 1;
          if (curState.consecutivePollErrors >= 5) {
            savePlaybackState(pluginDataDir, curState);
            return false;
          }
          savePlaybackState(pluginDataDir, curState);
          return intervalMs;
        }

        if (lx.volume !== null && lx.volume !== curState.volume) {
          curState.volume = lx.volume;
        }

        if (lx.status === 1) {
          if (!curState.sawPlaying) {
            curState.startedAtMs = Date.now() - Math.max(0, curState.positionSec || 0) * 1000 - 800;
          }
          curState.sawPlaying = true;
          curState.stoppedPolls = 0;
          savePlaybackState(pluginDataDir, curState);
          const curLib = loadLibrary(pluginDataDir);
          const curTrack = curLib.tracks.find((t) => t.id === curState.currentTrackId);
          const elapsedSec = computePositionSec(curState);
          const remaining = curTrack?.durationSec ? curTrack.durationSec - elapsedSec : 999;
          return remaining <= 12 ? fastIntervalMs : intervalMs;
        }

        if (lx.status === 2) {
          curState.positionSec = computePositionSec(curState);
          curState.startedAtMs = null;
          curState.status = 'paused';
          savePlaybackState(pluginDataDir, curState);
          return false;
        }

        if (lx.status === 0) {
          curState.stoppedPolls += 1;
          const elapsedMs = curState.startedAtMs ? Date.now() - curState.startedAtMs : 0;
          const finished = (curState.sawPlaying && curState.stoppedPolls >= 1)
            || (!curState.sawPlaying && elapsedMs >= 5000 && curState.stoppedPolls >= 2);
          if (!finished) {
            savePlaybackState(pluginDataDir, curState);
            return fastIntervalMs;
          }
          const nextIdx = pickNextIndex(curState, curState.queueIndex, curState.loopMode);
          await playQueueAtIndex(pluginDataDir, homeDir, configPath, nextIdx, deps);
          return false;
        }

        savePlaybackState(pluginDataDir, curState);
        return intervalMs;
      });
    },
  });
}

/**
 * @param {string} pluginDataDir
 * @param {string} homeDir
 * @param {string} configPath
 * @param {number} index
 * @param {Record<string, unknown>} [deps]
 */
async function playQueueAtIndex(pluginDataDir, homeDir, configPath, index, deps = {}) {
  const config = loadEffectiveConfig(configPath, homeDir);
  const lib = loadLibrary(pluginDataDir);
  const state = loadPlaybackState(pluginDataDir, config.defaultVolume);
  reconcileQueue(lib.tracks, state);

  if (index < 0 || index >= state.queue.length) {
    stopMusicWatcher(pluginDataDir);
    state.status = 'stopped';
    state.startedAtMs = null;
    state.positionSec = 0;
    savePlaybackState(pluginDataDir, state);
    return { ok: true, ended: true, state, track: null };
  }

  const trackId = state.queue[index];
  const track = lib.tracks.find((t) => t.id === trackId);
  if (!track) {
    throw new Error('队列中的曲目已不存在，请重新扫描曲库');
  }

  const speaker = resolveMusicSpeakerTarget(config.speakerSsh, homeDir);
  if (!speaker) {
    throw new Error('未找到可用的小爱音箱 (LX06) SSH 配置');
  }

  const playable = await ensurePlayableFile(track, pluginDataDir, deps);
  const secret = ensureStreamSecretSync(pluginDataDir);
  const relStreamUrl = signRelativeStreamPath(secret, track.id, playable.streamExt, 14_400);
  const baseUrl = resolveStreamBaseUrl(config.streamBaseUrl, asEnvRecord(deps.env));
  const fullStreamUrl = `${baseUrl}${relStreamUrl}`;

  await lx06PlayUrl(speaker.target, fullStreamUrl, { ...deps, homeDir });

  const nextEpoch = state.playEpoch + 1;
  state.status = 'playing';
  state.currentTrackId = track.id;
  state.queueIndex = index;
  state.startedAtMs = Date.now();
  state.positionSec = 0;
  state.playEpoch = nextEpoch;
  state.sawPlaying = false;
  state.consecutivePollErrors = 0;
  state.stoppedPolls = 0;
  savePlaybackState(pluginDataDir, state);

  startPlaybackWatcher(pluginDataDir, homeDir, configPath, nextEpoch, deps);

  return { ok: true, ended: false, state, track, streamUrl: fullStreamUrl };
}

/**
 * @param {import('./library.mjs').MusicTrack} track
 * @param {string} secret
 */
function buildTrackView(track, secret) {
  const playableExt = ['.mp3', '.m4a', '.wav', '.aac'].includes(track.ext)
    ? track.ext
    : (track.transcodePath && existsSync(track.transcodePath) ? '.mp3' : track.ext);
  return {
    ...track,
    previewUrl: signRelativeStreamPath(secret, track.id, playableExt, 14_400),
  };
}

/**
 * @param {string} pluginDataDir
 * @param {string} homeDir
 * @param {string} configPath
 * @param {{ live?: boolean }} [options]
 * @param {Record<string, unknown>} [deps]
 */
async function buildDashboard(pluginDataDir, homeDir, configPath, options = {}, deps = {}) {
  const config = loadEffectiveConfig(configPath, homeDir);
  let lib = loadLibrary(pluginDataDir);
  if (!lib.updatedAt && existsSync(config.musicDir)) {
    const scanned = await scanLibrary(pluginDataDir, config.musicDir, { quick: true }, deps);
    lib = { updatedAt: scanned.updatedAt, musicDir: scanned.musicDir, tracks: scanned.tracks };
  }

  const state = loadPlaybackState(pluginDataDir, config.defaultVolume);
  reconcileQueue(lib.tracks, state);
  const secret = ensureStreamSecretSync(pluginDataDir);
  const playlists = loadPlaylists(pluginDataDir).playlists;
  const cookies = inspectNetscapeCookiesFile(join(pluginDataDir, 'cookies.txt'));
  const downloads = loadDownloadJobs(pluginDataDir).map((rawJob) => {
    const liveOverlay = ACTIVE_DOWNLOAD_PROGRESS.get(rawJob.id);
    const job = liveOverlay ? { ...rawJob, ...liveOverlay } : rawJob;
    if (job.status !== 'error' || typeof job.error !== 'string') return job;
    if (/^(?:Command failed:|\[soundcloud\]|ERROR:)/i.test(job.error) || /drm protected|not a bot/i.test(job.error)) {
      return {
        ...job,
        error: formatYtDlpError(job.error, {
          source: job.source,
          hasCookies: cookies.configured,
          hasYouTubeAuth: cookies.hasYouTubeAuth,
        }),
      };
    }
    if (job.source === 'youtube' && cookies.configured && !cookies.hasYouTubeAuth && /登录态校验未通过/.test(job.error)) {
      return {
        ...job,
        error: formatYtDlpError('Sign in to confirm you’re not a bot', {
          source: job.source,
          hasCookies: cookies.configured,
          hasYouTubeAuth: cookies.hasYouTubeAuth,
        }),
      };
    }
    return job;
  });
  const speaker = resolveMusicSpeakerTarget(config.speakerSsh, homeDir);

  let speakerLive = null;
  if (options.live === true && speaker) {
    try {
      speakerLive = await getLx06PlayStatus(speaker.target, { ...deps, homeDir });
      if (speakerLive.volume !== null) {
        state.volume = speakerLive.volume;
      }
      if (speakerLive.status === 2 && state.status === 'playing') {
        state.positionSec = computePositionSec(state);
        state.startedAtMs = null;
        state.status = 'paused';
      } else if (speakerLive.status === 0 && state.status === 'playing') {
        state.status = 'stopped';
        state.startedAtMs = null;
      }
      savePlaybackState(pluginDataDir, state);
    } catch {
      speakerLive = { error: '小爱音箱暂时不可达' };
    }
  }

  if (state.timerEndsAtMs && Date.now() >= state.timerEndsAtMs) {
    state.timerEndsAtMs = null;
  }

  const tracksWithPreview = lib.tracks.map((t) => buildTrackView(t, secret));
  const trackMap = new Map(tracksWithPreview.map((t) => [t.id, t]));
  const currentTrack = state.currentTrackId ? (trackMap.get(state.currentTrackId) ?? null) : null;
  const queueTracks = state.queue.map((id) => trackMap.get(id)).filter(Boolean);
  const ytDlpBin = deps.ytDlpPath || findYtDlp(config.ytDlpPath);

  return {
    updatedAt: Date.now(),
    libraryUpdatedAt: lib.updatedAt,
    status: state.status,
    positionSec: computePositionSec(state),
    positionMs: computePositionMs(state),
    startedAtMs: state.startedAtMs,
    loopMode: state.loopMode,
    loopLabel: LOOP_LABELS[state.loopMode] ?? '列表循环',
    volume: state.volume,
    timerEndsAtMs: state.timerEndsAtMs,
    currentTrack,
    queueIndex: state.queueIndex,
    queue: queueTracks,
    trackCount: tracksWithPreview.length,
    tracks: tracksWithPreview,
    playlists,
    downloads,
    speaker: speaker
      ? {
          configured: true,
          id: speaker.target.id,
          userHost: speaker.target.userHost,
          source: speaker.source,
          live: speakerLive,
        }
      : { configured: false, id: '', userHost: '', source: 'none', live: null },
    ytDlpAvailable: Boolean(ytDlpBin),
    ytDlpPath: ytDlpBin || '',
    cookies,
    streamBaseUrl: resolveStreamBaseUrl(config.streamBaseUrl, asEnvRecord(deps.env)),
    config,
  };
}

/**
 * @param {string} action
 * @param {Record<string, unknown>} [args]
 * @param {import('../_shared/types.d.ts').PluginExecutionContext} [context]
 * @param {Record<string, unknown>} [deps]
 * @returns {Promise<import('../_shared/types.d.ts').PluginActionResult>}
 */
export async function runAction(action, args = {}, context = {}, deps = {}) {
  const cleanAction = String(action ?? 'dashboard').trim().toLowerCase() || 'dashboard';
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const paths = resolvePluginPaths('music', context);
  const homeDir = paths.homeDir;
  const pluginDataDir = paths.pluginDataDir;
  const configPath = paths.configPath;
  ensurePrivateDir(pluginDataDir);

  if (cleanAction === 'dashboard' || cleanAction === 'status') {
    const live = cleanAction === 'status' ? safeArgs.live !== false : Boolean(safeArgs.live);
    const data = await buildDashboard(pluginDataDir, homeDir, configPath, { live }, deps);
    const cur = data.currentTrack;
    const msg = cur && (data.status === 'playing' || data.status === 'paused')
      ? `${data.status === 'paused' ? '已暂停' : '正在播放'}《${cur.title}》${cur.artist ? ` - ${cur.artist}` : ''} · 音量 ${data.volume}% · ${data.loopLabel}`
      : `曲库共 ${data.trackCount} 首歌曲 · 当前未播放`;
    return {
      ok: true,
      notify: false,
      title: '音乐点播状态',
      message: msg,
      data,
    };
  }

  if (cleanAction === 'scan') {
    const config = loadEffectiveConfig(configPath, homeDir);
    const quick = safeArgs.quick !== false;
    const scanned = await scanLibrary(pluginDataDir, config.musicDir, { quick, signal: context.signal }, deps);
    return {
      ok: !scanned.error,
      notify: Boolean(scanned.error),
      title: scanned.error ? '扫描曲库失败' : '曲库扫描完成',
      message: scanned.error
        ? scanned.error
        : `扫描完成：共 ${scanned.total} 首歌曲（新增 ${scanned.added}，移除 ${scanned.removed}）`,
      data: scanned,
    };
  }

  if (cleanAction === 'tracks') {
    const config = loadEffectiveConfig(configPath, homeDir);
    let lib = loadLibrary(pluginDataDir);
    if (!lib.updatedAt && existsSync(config.musicDir)) {
      const scanned = await scanLibrary(pluginDataDir, config.musicDir, { quick: true }, deps);
      lib = { updatedAt: scanned.updatedAt, musicDir: scanned.musicDir, tracks: scanned.tracks };
    }
    const query = String(safeArgs.query ?? '').trim();
    const playlistId = String(safeArgs.playlistId ?? '').trim();
    let list = lib.tracks;
    if (playlistId) {
      const pl = loadPlaylists(pluginDataDir).playlists.find((p) => p.id === playlistId);
      const idSet = new Set(pl?.trackIds ?? []);
      list = list.filter((t) => idSet.has(t.id));
    }
    if (query) {
      list = searchLocalTracks(list, query);
    }
    const secret = ensureStreamSecretSync(pluginDataDir);
    const tracks = list.map((t) => buildTrackView(t, secret));
    return {
      ok: true,
      notify: false,
      title: '曲库检索',
      message: `匹配到 ${tracks.length} 首曲目`,
      data: { total: tracks.length, tracks },
    };
  }

  if (cleanAction === 'play') {
    return withFileLock(join(pluginDataDir, 'playback-state.json'), async () => {
      const config = loadEffectiveConfig(configPath, homeDir);
      let lib = loadLibrary(pluginDataDir);
      if (lib.tracks.length === 0 && existsSync(config.musicDir)) {
        const scanned = await scanLibrary(pluginDataDir, config.musicDir, { quick: true }, deps);
        lib = { updatedAt: scanned.updatedAt, musicDir: scanned.musicDir, tracks: scanned.tracks };
      }
      if (lib.tracks.length === 0) {
        return {
          ok: false,
          notify: true,
          title: '曲库为空',
          message: '本地曲库还没有歌曲，可以在网页控制台上传音频或用搜歌下载添加。',
          data: { miss: true, empty: true, autoDownloadOnVoiceMiss: config.autoDownloadOnVoiceMiss },
        };
      }

      const state = loadPlaybackState(pluginDataDir, config.defaultVolume);
      const trackId = typeof safeArgs.trackId === 'string' ? safeArgs.trackId.trim() : '';
      const playlistId = typeof safeArgs.playlistId === 'string' ? safeArgs.playlistId.trim() : '';
      const query = typeof safeArgs.query === 'string' ? safeArgs.query.trim() : '';
      const shuffle = Boolean(safeArgs.shuffle);

      let targetTracks = lib.tracks;
      if (playlistId) {
        const pl = loadPlaylists(pluginDataDir).playlists.find((p) => p.id === playlistId);
        if (!pl) {
          return { ok: false, notify: true, title: '歌单不存在', message: `未找到歌单 ${playlistId}` };
        }
        const byId = new Map(lib.tracks.map((t) => [t.id, t]));
        targetTracks = pl.trackIds.map((id) => byId.get(id)).filter(Boolean);
        if (targetTracks.length === 0) {
          return { ok: false, notify: true, title: '歌单为空', message: `歌单「${pl.name}」里还没有歌曲` };
        }
      }

      const queueIdx = clampInt(safeArgs.index, 0, Math.max(0, targetTracks.length - 1));
      let chosenIndex = 0;
      if (queueIdx !== undefined && !trackId && !query && !playlistId && state.queue.length > 0) {
        reconcileQueue(lib.tracks, state);
        chosenIndex = Math.min(queueIdx, Math.max(0, state.queue.length - 1));
      } else if (trackId) {
        const idx = targetTracks.findIndex((t) => t.id === trackId);
        if (idx < 0) {
          return { ok: false, notify: true, title: '未找到曲目', message: `未找到曲目 ${trackId}`, data: { miss: true } };
        }
        state.queue = targetTracks.map((t) => t.id);
        chosenIndex = idx;
      } else if (query) {
        const matches = searchLocalTracks(targetTracks, query);
        if (matches.length === 0) {
          return {
            ok: false,
            notify: true,
            title: '本地未找到歌曲',
            message: `本地曲库未找到与「${query}」匹配的歌曲`,
            data: { miss: true, query, autoDownloadOnVoiceMiss: config.autoDownloadOnVoiceMiss },
          };
        }
        const chosen = matches[0];
        state.queue = targetTracks.map((t) => t.id);
        chosenIndex = state.queue.indexOf(chosen.id);
      } else if (playlistId) {
        state.queue = targetTracks.map((t) => t.id);
        chosenIndex = shuffle ? Math.floor(Math.random() * state.queue.length) : 0;
        if (shuffle) state.loopMode = 'shuffle';
      } else if (shuffle || state.queue.length === 0) {
        state.queue = targetTracks.map((t) => t.id);
        chosenIndex = shuffle ? Math.floor(Math.random() * state.queue.length) : 0;
        if (shuffle) state.loopMode = 'shuffle';
      } else {
        reconcileQueue(lib.tracks, state);
        chosenIndex = state.queueIndex >= 0 ? state.queueIndex : 0;
      }

      savePlaybackState(pluginDataDir, state);
      try {
        const played = await playQueueAtIndex(pluginDataDir, homeDir, configPath, chosenIndex, deps);
        return {
          ok: true,
          notify: true,
          title: '开始播放音乐',
          message: `正在小爱音箱播放《${played.track?.title ?? ''}》${played.track?.artist ? ` - ${played.track.artist}` : ''}`,
          data: {
            status: played.state.status,
            currentTrack: played.track,
            queueLength: played.state.queue.length,
            queueIndex: played.state.queueIndex,
            loopMode: played.state.loopMode,
            streamUrl: played.streamUrl,
          },
        };
      } catch (err) {
        return { ok: false, notify: true, title: '播放失败', message: errMsg(err) };
      }
    });
  }

  if (cleanAction === 'pause') {
    return withFileLock(join(pluginDataDir, 'playback-state.json'), async () => {
      const config = loadEffectiveConfig(configPath, homeDir);
      const speaker = resolveMusicSpeakerTarget(config.speakerSsh, homeDir);
      if (!speaker) return { ok: false, notify: true, title: '音箱未配置', message: '未找到可用的小爱音箱 SSH 配置' };
      stopMusicWatcher(pluginDataDir);
      await lx06PlayOperation(speaker.target, 'pause', { ...deps, homeDir });
      const state = loadPlaybackState(pluginDataDir, config.defaultVolume);
      state.positionSec = computePositionSec(state);
      state.startedAtMs = null;
      state.status = 'paused';
      savePlaybackState(pluginDataDir, state);
      return { ok: true, notify: true, title: '已暂停音乐', message: '已暂停小爱音箱播放', data: { status: 'paused', positionSec: state.positionSec } };
    });
  }

  if (cleanAction === 'resume') {
    return withFileLock(join(pluginDataDir, 'playback-state.json'), async () => {
      const config = loadEffectiveConfig(configPath, homeDir);
      const speaker = resolveMusicSpeakerTarget(config.speakerSsh, homeDir);
      if (!speaker) return { ok: false, notify: true, title: '音箱未配置', message: '未找到可用的小爱音箱 SSH 配置' };
      const state = loadPlaybackState(pluginDataDir, config.defaultVolume);
      const lib = loadLibrary(pluginDataDir);
      reconcileQueue(lib.tracks, state);
      if (!state.currentTrackId && state.queue.length === 0) {
        return { ok: false, notify: true, title: '暂无暂停曲目', message: '当前没有可恢复播放的歌曲' };
      }

      const lx = await getLx06PlayStatus(speaker.target, { ...deps, homeDir }).catch(() => null);
      if (lx && lx.status === 2) {
        await lx06PlayOperation(speaker.target, 'play', { ...deps, homeDir });
        state.status = 'playing';
        state.startedAtMs = Date.now() - state.positionSec * 1000;
        state.playEpoch += 1;
        state.sawPlaying = true;
        savePlaybackState(pluginDataDir, state);
        startPlaybackWatcher(pluginDataDir, homeDir, configPath, state.playEpoch, deps);
        return { ok: true, notify: true, title: '继续播放', message: '已恢复播放', data: { status: 'playing' } };
      }

      const idx = state.queueIndex >= 0 ? state.queueIndex : 0;
      try {
        const played = await playQueueAtIndex(pluginDataDir, homeDir, configPath, idx, deps);
        return {
          ok: true,
          notify: true,
          title: '继续播放',
          message: `正在继续播放《${played.track?.title ?? ''}》`,
          data: { status: played.state.status, currentTrack: played.track },
        };
      } catch (err) {
        return { ok: false, notify: true, title: '恢复播放失败', message: errMsg(err) };
      }
    });
  }

  if (cleanAction === 'stop') {
    return withFileLock(join(pluginDataDir, 'playback-state.json'), async () => {
      const config = loadEffectiveConfig(configPath, homeDir);
      const speaker = resolveMusicSpeakerTarget(config.speakerSsh, homeDir);
      stopMusicWatcher(pluginDataDir);
      if (speaker) {
        await lx06PlayOperation(speaker.target, 'stop', { ...deps, homeDir });
      }
      const state = loadPlaybackState(pluginDataDir, config.defaultVolume);
      state.status = 'stopped';
      state.startedAtMs = null;
      state.positionSec = 0;
      state.timerEndsAtMs = null;
      state.playEpoch += 1;
      savePlaybackState(pluginDataDir, state);
      return { ok: true, notify: true, title: '已停止播放', message: '已停止小爱音箱音乐播放', data: { status: 'stopped' } };
    });
  }

  if (cleanAction === 'next' || cleanAction === 'prev') {
    return withFileLock(join(pluginDataDir, 'playback-state.json'), async () => {
      const config = loadEffectiveConfig(configPath, homeDir);
      let lib = loadLibrary(pluginDataDir);
      if (lib.tracks.length === 0 && existsSync(config.musicDir)) {
        const scanned = await scanLibrary(pluginDataDir, config.musicDir, { quick: true }, deps);
        lib = { updatedAt: scanned.updatedAt, musicDir: scanned.musicDir, tracks: scanned.tracks };
      }
      const state = loadPlaybackState(pluginDataDir, config.defaultVolume);
      if (state.queue.length === 0) {
        state.queue = lib.tracks.map((t) => t.id);
        state.queueIndex = -1;
      }
      reconcileQueue(lib.tracks, state);
      if (state.queue.length === 0) {
        return { ok: false, notify: true, title: '曲库为空', message: '当前播放队列和曲库均为空' };
      }

      let nextIdx;
      if (cleanAction === 'next') {
        nextIdx = state.loopMode === 'shuffle'
          ? pickNextIndex(state, state.queueIndex, 'shuffle')
          : (state.queueIndex + 1) % state.queue.length;
      } else {
        nextIdx = state.queueIndex <= 0 ? state.queue.length - 1 : state.queueIndex - 1;
      }
      savePlaybackState(pluginDataDir, state);
      try {
        const played = await playQueueAtIndex(pluginDataDir, homeDir, configPath, nextIdx, deps);
        return {
          ok: true,
          notify: true,
          title: cleanAction === 'next' ? '已切至下一首' : '已切至上一首',
          message: `正在播放《${played.track?.title ?? ''}》`,
          data: { status: played.state.status, currentTrack: played.track, queueIndex: played.state.queueIndex },
        };
      } catch (err) {
        return { ok: false, notify: true, title: '切歌失败', message: errMsg(err) };
      }
    });
  }

  if (cleanAction === 'volume') {
    return withFileLock(join(pluginDataDir, 'playback-state.json'), async () => {
      const config = loadEffectiveConfig(configPath, homeDir);
      const speaker = resolveMusicSpeakerTarget(config.speakerSsh, homeDir);
      if (!speaker) return { ok: false, notify: true, title: '音箱未配置', message: '未找到可用的小爱音箱 SSH 配置' };
      const state = loadPlaybackState(pluginDataDir, config.defaultVolume);
      const delta = Number(safeArgs.delta);
      let targetVol = clampInt(safeArgs.volume, 0, 100);
      if (targetVol === undefined && Number.isFinite(delta) && delta !== 0) {
        targetVol = Math.max(0, Math.min(100, Math.round(state.volume + delta)));
      }
      if (targetVol === undefined) {
        return { ok: false, notify: true, title: '参数缺失', message: '请提供 volume（0..100）或 delta' };
      }
      const applied = await lx06SetVolume(speaker.target, targetVol, { ...deps, homeDir });
      state.volume = applied;
      savePlaybackState(pluginDataDir, state);
      return {
        ok: true,
        notify: true,
        title: '音箱音量已更新',
        message: `小爱音箱音量已设为 ${applied}%`,
        data: { volume: applied, status: state.status },
      };
    });
  }

  if (cleanAction === 'loop') {
    return withFileLock(join(pluginDataDir, 'playback-state.json'), async () => {
      const config = loadEffectiveConfig(configPath, homeDir);
      const state = loadPlaybackState(pluginDataDir, config.defaultVolume);
      const requested = String(safeArgs.mode ?? '').trim().toLowerCase();
      let nextMode = requested;
      if (!nextMode) {
        const order = ['list', 'single', 'shuffle', 'once'];
        nextMode = order[(order.indexOf(state.loopMode) + 1) % order.length];
      }
      if (!LOOP_MODES.has(nextMode)) {
        return { ok: false, notify: true, title: '无效循环模式', message: `不支持循环模式 "${nextMode}"（可选 list/single/shuffle/once）` };
      }
      state.loopMode = nextMode;
      savePlaybackState(pluginDataDir, state);
      const label = LOOP_LABELS[nextMode];
      return {
        ok: true,
        notify: true,
        title: '循环模式已切换',
        message: `已切换为${label}`,
        data: { loopMode: nextMode, loopLabel: label, status: state.status },
      };
    });
  }

  if (cleanAction === 'timer') {
    return withFileLock(join(pluginDataDir, 'playback-state.json'), async () => {
      const config = loadEffectiveConfig(configPath, homeDir);
      const speaker = resolveMusicSpeakerTarget(config.speakerSsh, homeDir);
      if (!speaker) return { ok: false, notify: true, title: '音箱未配置', message: '未找到可用的小爱音箱 SSH 配置' };
      const cancel = Boolean(safeArgs.cancel) || Number(safeArgs.minutes) === 0;
      const minutes = clampInt(safeArgs.minutes, 1, 240) ?? 30;
      const applied = await lx06SetShutdownTimer(speaker.target, minutes, cancel, { ...deps, homeDir });
      const state = loadPlaybackState(pluginDataDir, config.defaultVolume);
      state.timerEndsAtMs = cancel ? null : Date.now() + applied * 60_000;
      savePlaybackState(pluginDataDir, state);
      return {
        ok: true,
        notify: true,
        title: cancel ? '已取消睡眠定时' : '已设置睡眠定时',
        message: cancel ? '已取消音乐定时关闭' : `将在 ${applied} 分钟后停止播放`,
        data: { cancel, minutes: applied, timerEndsAtMs: state.timerEndsAtMs },
      };
    });
  }

  if (cleanAction === 'queue') {
    return withFileLock(join(pluginDataDir, 'playback-state.json'), async () => {
      const config = loadEffectiveConfig(configPath, homeDir);
      const lib = loadLibrary(pluginDataDir);
      const state = loadPlaybackState(pluginDataDir, config.defaultVolume);
      reconcileQueue(lib.tracks, state);
      const op = String(safeArgs.op ?? 'list').trim().toLowerCase();
      const trackId = String(safeArgs.trackId ?? '').trim();

      if (op === 'add') {
        if (!trackId || !lib.tracks.some((t) => t.id === trackId)) {
          return { ok: false, notify: true, title: '未找到曲目', message: `曲目 ${trackId || '(空)'} 不存在` };
        }
        if (!state.queue.includes(trackId)) {
          state.queue.push(trackId);
          if (state.queueIndex < 0) state.queueIndex = 0;
          savePlaybackState(pluginDataDir, state);
        }
        return { ok: true, notify: true, title: '已加入队列', message: `已添加到播放队列（共 ${state.queue.length} 首）`, data: { queue: state.queue } };
      }
      if (op === 'remove') {
        const rmIdx = state.queue.indexOf(trackId);
        if (rmIdx >= 0) {
          state.queue.splice(rmIdx, 1);
          if (rmIdx < state.queueIndex) state.queueIndex -= 1;
          if (state.queueIndex >= state.queue.length) state.queueIndex = state.queue.length - 1;
          savePlaybackState(pluginDataDir, state);
        }
        return { ok: true, notify: false, title: '已移出队列', message: `队列剩余 ${state.queue.length} 首`, data: { queue: state.queue } };
      }
      if (op === 'clear') {
        state.queue = [];
        state.queueIndex = -1;
        savePlaybackState(pluginDataDir, state);
        return { ok: true, notify: true, title: '已清空队列', message: '已清空播放队列', data: { queue: [] } };
      }
      if (op === 'set' && Array.isArray(safeArgs.trackIds)) {
        const valid = new Set(lib.tracks.map((t) => t.id));
        state.queue = safeArgs.trackIds.map((x) => String(x)).filter((id) => valid.has(id));
        state.queueIndex = state.queue.length > 0 ? 0 : -1;
        savePlaybackState(pluginDataDir, state);
        return { ok: true, notify: false, title: '已更新队列', message: `队列已更新（${state.queue.length} 首）`, data: { queue: state.queue } };
      }
      return { ok: true, notify: false, title: '播放队列', message: `队列共 ${state.queue.length} 首歌曲`, data: { queue: state.queue, queueIndex: state.queueIndex } };
    });
  }

  if (cleanAction === 'playlist') {
    const op = String(safeArgs.op ?? 'list').trim().toLowerCase();
    const res = mutatePlaylist(pluginDataDir, {
      op,
      id: typeof safeArgs.id === 'string' ? safeArgs.id : undefined,
      playlistId: typeof safeArgs.playlistId === 'string' ? safeArgs.playlistId : undefined,
      name: typeof safeArgs.name === 'string' ? safeArgs.name : undefined,
      trackId: typeof safeArgs.trackId === 'string' ? safeArgs.trackId : undefined,
    });
    return {
      ok: res.ok,
      notify: op !== 'list',
      title: res.ok ? '歌单管理' : '歌单操作失败',
      message: res.message,
      data: res,
    };
  }

  if (cleanAction === 'search-online') {
    const config = loadEffectiveConfig(configPath, homeDir);
    const query = String(safeArgs.query ?? '').trim();
    const source = String(safeArgs.source ?? config.defaultSearchSource ?? 'youtube').trim().toLowerCase();
    const limit = clampInt(safeArgs.limit, 1, 12) ?? 6;
    const cookiesPath = resolveCookiesPath(pluginDataDir);
    const sourceLabelMap = { bilibili: 'Bilibili', soundcloud: 'SoundCloud', youtube: 'YouTube' };
    try {
      const res = await searchOnlineTracks(query, {
        source,
        limit,
        ytDlpPath: config.ytDlpPath,
        cookiesPath,
        signal: context.signal,
      }, deps);
      const sourceLabel = sourceLabelMap[/** @type {keyof typeof sourceLabelMap} */ (res.source)] ?? 'YouTube';
      return {
        ok: true,
        notify: false,
        title: '在线搜索结果',
        message: `从 ${sourceLabel} 找到 ${res.candidates.length} 个候选音源`,
        data: res,
      };
    } catch (err) {
      return {
        ok: false,
        notify: false,
        title: '在线搜索失败',
        message: errMsg(err),
        data: { source, candidates: [] },
      };
    }
  }

  if (cleanAction === 'download') {
    const config = loadEffectiveConfig(configPath, homeDir);
    const url = typeof safeArgs.url === 'string' ? safeArgs.url.trim() : '';
    const query = typeof safeArgs.query === 'string' ? safeArgs.query.trim() : '';
    const source = String(safeArgs.source ?? config.defaultSearchSource ?? 'youtube').trim().toLowerCase();
    const format = String(safeArgs.format ?? config.downloadFormat ?? 'mp3').trim().toLowerCase();
    const titleHint = typeof safeArgs.titleHint === 'string' ? safeArgs.titleHint.trim() : '';
    const artistHint = typeof safeArgs.artistHint === 'string' ? safeArgs.artistHint.trim() : '';
    const playAfter = Boolean(safeArgs.playAfter);
    const isAsync = Boolean(safeArgs.async);
    const cookiesPath = resolveCookiesPath(pluginDataDir);

    const jobId = `dl-${randomUUID().slice(0, 8)}`;
    const startedAt = Date.now();
    /** @type {import('./downloader.mjs').DownloadJob} */
    const initialJob = {
      id: jobId,
      status: 'downloading',
      phase: query && !url ? 'searching' : 'preparing',
      progressPercent: 0,
      progressText: query && !url ? '正在搜索在线音源…' : '正在解析链接与音轨信息…',
      query,
      url,
      source,
      title: titleHint || query || url || '在线音频',
      artist: artistHint,
      playAfter,
      startedAt,
      updatedAt: startedAt,
    };
    ACTIVE_DOWNLOAD_PROGRESS.set(jobId, initialJob);
    upsertDownloadJob(pluginDataDir, initialJob);

    let liveJob = { ...initialJob };
    let lastPersistedAt = startedAt;
    let lastPersistedPhase = liveJob.phase;
    const persistEveryMs = 450;

    /** @param {Partial<import('./downloader.mjs').DownloadJob>} patch */
    const reportProgress = (patch) => {
      if (!patch || typeof patch !== 'object') return;
      const now = Date.now();
      liveJob = {
        ...liveJob,
        ...patch,
        status: 'downloading',
        updatedAt: now,
      };
      ACTIVE_DOWNLOAD_PROGRESS.set(jobId, liveJob);
      if (liveJob.phase !== lastPersistedPhase || now - lastPersistedAt >= persistEveryMs) {
        lastPersistedPhase = liveJob.phase;
        lastPersistedAt = now;
        upsertDownloadJob(pluginDataDir, liveJob);
      }
    };

    const runDownloadTask = async () => {
      try {
        const downloaded = await downloadOnlineAudioFile({
          url,
          query,
          source,
          format,
          titleHint,
          artistHint,
          musicDir: config.musicDir,
          ytDlpPath: config.ytDlpPath,
          cookiesPath,
          signal: isAsync ? undefined : context.signal,
          onProgress: reportProgress,
        }, deps);
        reportProgress({
          phase: 'indexing',
          progressPercent: 99,
          progressText: '正在扫描入库…',
        });
        const scanned = await scanLibrary(pluginDataDir, config.musicDir, { quick: true }, deps);
        const addedTrack = scanned.tracks.find((t) => resolve(t.filePath) === resolve(downloaded.filePath));
        const finishedAt = Date.now();
        ACTIVE_DOWNLOAD_PROGRESS.delete(jobId);
        upsertDownloadJob(pluginDataDir, {
          ...liveJob,
          status: 'done',
          phase: 'done',
          progressPercent: 100,
          progressText: '已完成并入库',
          speedText: undefined,
          etaText: undefined,
          title: addedTrack?.title || downloaded.title,
          artist: addedTrack?.artist || downloaded.artist,
          source: downloaded.source,
          url: downloaded.url,
          filePath: downloaded.filePath,
          trackId: addedTrack?.id,
          updatedAt: finishedAt,
          finishedAt,
        });
        let playRes = null;
        if (playAfter && addedTrack) {
          playRes = await runAction('play', { trackId: addedTrack.id }, context, deps);
        }
        return { downloaded, scanned, track: addedTrack ?? null, playRes };
      } catch (err) {
        const finishedAt = Date.now();
        ACTIVE_DOWNLOAD_PROGRESS.delete(jobId);
        upsertDownloadJob(pluginDataDir, {
          ...liveJob,
          status: 'error',
          phase: 'error',
          error: errMsg(err),
          updatedAt: finishedAt,
          finishedAt,
        });
        throw err;
      } finally {
        ACTIVE_DOWNLOAD_PROGRESS.delete(jobId);
        ACTIVE_DOWNLOAD_PROMISES.delete(jobId);
      }
    };

    const taskPromise = runDownloadTask();
    ACTIVE_DOWNLOAD_PROMISES.set(jobId, taskPromise);

    if (isAsync) {
      taskPromise.catch(() => {});
      return {
        ok: true,
        notify: false,
        title: '已加入后台下载',
        message: `正在后台下载《${initialJob.title}》`,
        data: { jobId, status: 'downloading', job: initialJob },
      };
    }

    try {
      const done = await taskPromise;
      return {
        ok: true,
        notify: true,
        title: '下载完成并已入库',
        message: done.playRes?.ok
          ? `已下载《${done.track?.title || done.downloaded.title}》并开始在小爱音箱播放`
          : `已下载《${done.track?.title || done.downloaded.title}》到本地曲库`,
        data: {
          jobId,
          status: 'done',
          track: done.track,
          filePath: done.downloaded.filePath,
          played: Boolean(done.playRes?.ok),
        },
      };
    } catch (err) {
      return {
        ok: false,
        notify: true,
        title: '下载失败',
        message: errMsg(err),
        data: { jobId, status: 'error' },
      };
    }
  }

  if (cleanAction === 'downloads') {
    const op = String(safeArgs.op ?? 'list').trim().toLowerCase();
    if (op === 'remove') {
      const jobId = String(safeArgs.jobId ?? safeArgs.id ?? '').trim();
      const res = removeDownloadJob(pluginDataDir, jobId, ACTIVE_DOWNLOAD_PROMISES);
      return {
        ok: res.ok,
        notify: false,
        title: res.ok ? '下载记录已删除' : '删除下载记录失败',
        message: res.message,
        data: res,
      };
    }
    if (op === 'clear') {
      const scope = String(safeArgs.scope ?? 'all').trim().toLowerCase();
      const res = clearDownloadJobs(pluginDataDir, { scope }, ACTIVE_DOWNLOAD_PROMISES);
      return {
        ok: res.ok,
        notify: false,
        title: '下载历史已清理',
        message: res.message,
        data: res,
      };
    }
    const jobs = loadDownloadJobs(pluginDataDir).map((rawJob) => {
      const liveOverlay = ACTIVE_DOWNLOAD_PROGRESS.get(rawJob.id);
      return liveOverlay ? { ...rawJob, ...liveOverlay } : rawJob;
    });
    return {
      ok: true,
      notify: false,
      title: '下载记录列表',
      message: `共 ${jobs.length} 条下载记录`,
      data: { jobs },
    };
  }

  if (cleanAction === 'lyrics') {
    const config = loadEffectiveConfig(configPath, homeDir);
    let lib = loadLibrary(pluginDataDir);
    if (!lib.updatedAt && existsSync(config.musicDir)) {
      const scanned = await scanLibrary(pluginDataDir, config.musicDir, { quick: true }, deps);
      lib = { updatedAt: scanned.updatedAt, musicDir: scanned.musicDir, tracks: scanned.tracks };
    }
    const state = loadPlaybackState(pluginDataDir, config.defaultVolume);
    const targetId = String(safeArgs.trackId ?? state.currentTrackId ?? '').trim().toLowerCase();
    if (!targetId) {
      return { ok: false, notify: false, title: '未指定曲目', message: '请先选择曲目或开始播放歌曲' };
    }
    const track = lib.tracks.find((t) => t.id === targetId);
    if (!track) {
      return { ok: false, notify: false, title: '曲目不存在', message: `未找到曲目 ${targetId}` };
    }
    const lyrics = await readTrackLyrics(track, config.musicDir, deps);
    const lineCount = lyrics.lines.length;
    return {
      ok: true,
      notify: false,
      title: '歌词详情',
      message: lineCount > 0 ? `已加载《${track.title}》的${lyrics.synced ? '同步' : '文本'}歌词（${lineCount} 行）` : `《${track.title}》暂无歌词`,
      data: {
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        ...lyrics,
      },
    };
  }

  if (cleanAction === 'delete-track') {
    const config = loadEffectiveConfig(configPath, homeDir);
    const trackId = String(safeArgs.trackId ?? '').trim();
    const res = deleteTrackById(pluginDataDir, config.musicDir, trackId);
    return {
      ok: res.ok,
      notify: true,
      title: res.ok ? '曲目已删除' : '删除失败',
      message: res.message,
      data: res,
    };
  }

  if (cleanAction === 'config') {
    const current = loadEffectiveConfig(configPath, homeDir);
    const cookiesFilePath = join(pluginDataDir, 'cookies.txt');
    const clearCookies = Boolean(safeArgs.clearCookies);
    const rawCookiesContent = typeof safeArgs.cookiesContent === 'string' ? safeArgs.cookiesContent : undefined;
    const hasFieldUpdates = ['musicDir', 'streamBaseUrl', 'speakerSsh', 'defaultVolume', 'downloadFormat', 'defaultSearchSource', 'ytDlpPath', 'autoDownloadOnVoiceMiss']
      .some((k) => safeArgs[k] !== undefined);

    if (clearCookies) {
      rmSync(cookiesFilePath, { force: true });
    } else if (rawCookiesContent !== undefined) {
      if (!rawCookiesContent.trim()) {
        return { ok: false, notify: true, title: 'Cookie 导入失败', message: 'cookies.txt 内容不能为空' };
      }
      let tmpCookiesPath = '';
      try {
        const { normalizedText } = normalizeNetscapeCookiesText(rawCookiesContent);
        ensurePrivateDir(pluginDataDir);
        tmpCookiesPath = join(pluginDataDir, `.cookies-${randomUUID()}.tmp`);
        writeFileSync(tmpCookiesPath, normalizedText, { encoding: 'utf8', mode: 0o600 });
        chmodSync(tmpCookiesPath, 0o600);
        renameSync(tmpCookiesPath, cookiesFilePath);
        chmodSync(cookiesFilePath, 0o600);
      } catch (err) {
        if (tmpCookiesPath) rmSync(tmpCookiesPath, { force: true });
        return { ok: false, notify: true, title: 'Cookie 导入失败', message: errMsg(err) };
      }
    }

    const next = hasFieldUpdates
      ? {
          ...current,
          ...(typeof safeArgs.musicDir === 'string' && safeArgs.musicDir.trim() ? { musicDir: resolve(safeArgs.musicDir.trim()) } : {}),
          ...(typeof safeArgs.streamBaseUrl === 'string' ? { streamBaseUrl: safeArgs.streamBaseUrl.trim().replace(/\/+$/, '') } : {}),
          ...(typeof safeArgs.speakerSsh === 'string' ? { speakerSsh: safeArgs.speakerSsh.trim() } : {}),
          ...(safeArgs.defaultVolume !== undefined ? { defaultVolume: clampInt(safeArgs.defaultVolume, 0, 100) ?? current.defaultVolume } : {}),
          ...(safeArgs.downloadFormat !== undefined ? { downloadFormat: String(safeArgs.downloadFormat).trim().toLowerCase() === 'm4a' ? 'm4a' : 'mp3' } : {}),
          ...(safeArgs.defaultSearchSource !== undefined ? { defaultSearchSource: normalizeSearchSource(safeArgs.defaultSearchSource) } : {}),
          ...(typeof safeArgs.ytDlpPath === 'string' ? { ytDlpPath: safeArgs.ytDlpPath.trim() } : {}),
          ...(safeArgs.autoDownloadOnVoiceMiss !== undefined ? { autoDownloadOnVoiceMiss: Boolean(safeArgs.autoDownloadOnVoiceMiss) } : {}),
        }
      : current;

    let scanRes = null;
    if (hasFieldUpdates) {
      writeConfig(configPath, next);
      if (next.musicDir !== current.musicDir) {
        scanRes = await scanLibrary(pluginDataDir, next.musicDir, { quick: false, signal: context.signal }, deps);
      }
    }

    const cookies = inspectNetscapeCookiesFile(cookiesFilePath);
    if (hasFieldUpdates || clearCookies || rawCookiesContent !== undefined) {
      const msg = clearCookies
        ? '已清除已保存的 yt-dlp cookies.txt'
        : rawCookiesContent !== undefined
          ? `已保存 ${cookies.cookieCount} 条 Cookie 认证条目`
          : scanRes
            ? `曲库目录已切换为 ${next.musicDir}（扫描 ${scanRes.total} 首曲目）`
            : `曲库目录：${next.musicDir}`;
      return {
        ok: true,
        notify: true,
        title: clearCookies ? '已清除 Cookie 认证' : rawCookiesContent !== undefined ? '已导入 Cookie 认证' : '音乐插件配置已更新',
        message: msg,
        data: { config: next, cookies, ...(scanRes ? { scan: scanRes } : {}) },
      };
    }

    return {
      ok: true,
      notify: false,
      title: '音乐插件配置',
      message: `曲库目录：${current.musicDir}`,
      data: { config: current, cookies },
    };
  }

  return {
    ok: false,
    notify: true,
    title: '未知插件动作',
    message: `music 插件不支持动作 "${cleanAction}"。可用动作：${ACTIONS.join(', ')}`,
  };
}

/**
 * In-process voice fastpath entry registered by `src/plugin.ts`.
 * @param {import('../_shared/types.d.ts').VoiceFastpathRequest} request
 * @param {import('../_shared/types.d.ts').PluginExecutionContext} context
 */
export async function handleVoiceFastpath(request, context) {
  return handleMusicVoiceFastpath(request, context, runAction);
}

async function main() {
  const action = process.argv[2] || 'dashboard';
  let args = /** @type {Record<string, unknown>} */ ({});
  try {
    args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  } catch {
    args = {};
  }
  try {
    const result = await runAction(action, args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      notify: true,
      title: '🎵 音乐点播操作失败',
      message: errMsg(err),
    })}\n`);
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  await main();
}

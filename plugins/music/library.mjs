import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { ensurePrivateDir, readJsonSafe, writeJsonAtomic } from '../_shared/config-store.mjs';

const execFileAsync = promisify(execFile);

export const SUPPORTED_AUDIO_EXTS = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.wav',
  '.ogg',
  '.opus',
  '.aac',
]);

export const DIRECT_LX06_EXTS = new Set(['.mp3', '.m4a', '.wav', '.aac']);
const FAVORITES_PLAYLIST_ID = 'favorites';

/**
 * @typedef {{
 *   id: string;
 *   relPath: string;
 *   filePath: string;
 *   filename: string;
 *   folder: string;
 *   ext: string;
 *   title: string;
 *   artist: string;
 *   album: string;
 *   durationSec: number | null;
 *   bitrateKbps: number | null;
 *   codec: string;
 *   sizeBytes: number;
 *   mtimeMs: number;
 *   addedAt: number;
 *   transcodePath?: string;
 * }} MusicTrack
 *
 * @typedef {{
 *   id: string;
 *   name: string;
 *   builtin?: boolean;
 *   trackIds: string[];
 *   updatedAt: number;
 * }} MusicPlaylist
 */

/**
 * @param {string} homeDir
 * @returns {string}
 */
export function resolveDefaultMusicDir(homeDir) {
  if (existsSync('/mnt/data/music')) {
    return '/mnt/data/music';
  }
  return join(resolve(homeDir), 'music');
}

/**
 * @param {string} relPath
 * @returns {string}
 */
export function computeTrackId(relPath) {
  const normalized = String(relPath ?? '').replace(/\\/g, '/');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * @param {string} rootReal
 * @param {string} targetReal
 * @returns {boolean}
 */
export function isPathInside(rootReal, targetReal) {
  if (targetReal === rootReal) return true;
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
  return targetReal.startsWith(prefix);
}

/**
 * @param {string} relPath
 * @returns {{ title: string; artist: string }}
 */
export function parseFallbackTitleArtist(relPath) {
  const base = basename(relPath, extname(relPath)).trim();
  if (!base) return { title: '未知曲目', artist: '' };
  const sepIdx = base.indexOf(' - ');
  if (sepIdx > 0 && sepIdx < base.length - 3) {
    const artist = base.slice(0, sepIdx).trim();
    const title = base.slice(sepIdx + 3).trim();
    if (title) return { title, artist };
  }
  return { title: base, artist: '' };
}

/**
 * @param {Record<string, unknown> | undefined} tags
 * @param {string} key
 * @returns {string}
 */
function pickTag(tags, key) {
  if (!tags || typeof tags !== 'object') return '';
  const target = key.toLowerCase();
  for (const [k, v] of Object.entries(tags)) {
    if (k.toLowerCase() === target && v !== undefined && v !== null) {
      const s = String(v).trim();
      if (s) return s;
    }
  }
  return '';
}

/**
 * @param {string} filePath
 * @param {{
 *   ffprobePath?: string;
 *   execFileFn?: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout?: unknown; stderr?: unknown }>;
 *   signal?: AbortSignal;
 * }} [deps]
 * @returns {Promise<{ title: string; artist: string; album: string; durationSec: number | null; bitrateKbps: number | null; codec: string }>}
 */
export async function probeAudioMetadata(filePath, deps = {}) {
  const fallback = parseFallbackTitleArtist(filePath);
  const execFn = deps.execFileFn ?? ((cmd, args, opts) => execFileAsync(cmd, args, opts));
  const ffprobeBin = deps.ffprobePath || (existsSync('/usr/bin/ffprobe') ? '/usr/bin/ffprobe' : 'ffprobe');
  try {
    const res = await execFn(
      ffprobeBin,
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024, ...(deps.signal ? { signal: deps.signal } : {}) },
    );
    const raw = String(res?.stdout ?? '').trim();
    if (!raw) throw new Error('empty ffprobe output');
    const parsed = JSON.parse(raw);
    const fmt = parsed?.format && typeof parsed.format === 'object' ? parsed.format : {};
    const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
    const audioStream = streams.find((s) => s && s.codec_type === 'audio') ?? streams[0] ?? {};
    const tags = fmt.tags && typeof fmt.tags === 'object'
      ? fmt.tags
      : (audioStream?.tags && typeof audioStream.tags === 'object' ? audioStream.tags : undefined);
    const title = pickTag(tags, 'title') || fallback.title;
    const artist = pickTag(tags, 'artist') || pickTag(tags, 'album_artist') || fallback.artist;
    const album = pickTag(tags, 'album');
    const rawDur = Number(fmt.duration ?? audioStream?.duration);
    const durationSec = Number.isFinite(rawDur) && rawDur > 0 ? Math.round(rawDur) : null;
    const rawBitrate = Number(fmt.bit_rate ?? audioStream?.bit_rate);
    const bitrateKbps = Number.isFinite(rawBitrate) && rawBitrate > 0 ? Math.round(rawBitrate / 1000) : null;
    const codec = typeof audioStream?.codec_name === 'string' ? audioStream.codec_name.trim() : '';
    return { title, artist, album, durationSec, bitrateKbps, codec };
  } catch {
    return {
      title: fallback.title,
      artist: fallback.artist,
      album: '',
      durationSec: null,
      bitrateKbps: null,
      codec: extname(filePath).slice(1).toLowerCase(),
    };
  }
}

/**
 * @param {string} pluginDataDir
 * @returns {{ updatedAt: number | null; musicDir: string; tracks: MusicTrack[] }}
 */
export function loadLibrary(pluginDataDir) {
  const raw = readJsonSafe(join(pluginDataDir, 'library.json'), null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { updatedAt: null, musicDir: '', tracks: [] };
  }
  const rec = /** @type {Record<string, unknown>} */ (raw);
  const tracks = Array.isArray(rec.tracks) ? /** @type {MusicTrack[]} */ (rec.tracks.filter((t) => t && typeof t === 'object' && typeof t.id === 'string')) : [];
  return {
    updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : null,
    musicDir: typeof rec.musicDir === 'string' ? rec.musicDir : '',
    tracks,
  };
}

/**
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function mapConcurrency(items, limit, worker) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]);
    }
  }));
  return results;
}

/**
 * @param {string} pluginDataDir
 * @param {string} musicDir
 * @param {{ quick?: boolean; signal?: AbortSignal }} [options]
 * @param {{
 *   ffprobePath?: string;
 *   execFileFn?: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout?: unknown; stderr?: unknown }>;
 * }} [deps]
 * @returns {Promise<{ updatedAt: number; musicDir: string; tracks: MusicTrack[]; added: number; removed: number; total: number; error?: string }>}
 */
export async function scanLibrary(pluginDataDir, musicDir, options = {}, deps = {}) {
  const prev = loadLibrary(pluginDataDir);
  const quick = options.quick !== false;

  const resolvedMusicDir = resolve(musicDir);
  try {
    if (!existsSync(resolvedMusicDir)) {
      mkdirSync(resolvedMusicDir, { recursive: true });
    }
  } catch (err) {
    return {
      updatedAt: Date.now(),
      musicDir: resolvedMusicDir,
      tracks: prev.tracks,
      added: 0,
      removed: 0,
      total: prev.tracks.length,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let rootReal;
  try {
    rootReal = realpathSync(resolvedMusicDir);
  } catch (err) {
    return {
      updatedAt: Date.now(),
      musicDir: resolvedMusicDir,
      tracks: [],
      added: 0,
      removed: 0,
      total: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const sameMusicDir = prev.musicDir && resolve(prev.musicDir) === resolve(rootReal);
  const prevByRel = sameMusicDir ? new Map(prev.tracks.map((t) => [t.relPath, t])) : new Map();

  /** @type {Array<{ relPath: string; filePath: string; filename: string; folder: string; ext: string; sizeBytes: number; mtimeMs: number }>} */
  const discovered = [];
  const visitedDirs = new Set([rootReal]);
  const stack = [rootReal];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      let real;
      try {
        real = realpathSync(full);
      } catch {
        continue;
      }
      if (!isPathInside(rootReal, real)) continue;
      let st;
      try {
        st = statSync(real);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!visitedDirs.has(real)) {
          visitedDirs.add(real);
          stack.push(real);
        }
        continue;
      }
      if (!st.isFile() || st.size <= 0) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!SUPPORTED_AUDIO_EXTS.has(ext)) continue;
      const relPath = relative(rootReal, real).split(sep).join('/');
      const relSlash = relPath.lastIndexOf('/');
      const folder = relSlash > 0 ? relPath.slice(0, relSlash) : '';
      discovered.push({
        relPath,
        filePath: real,
        filename: entry.name,
        folder,
        ext,
        sizeBytes: st.size,
        mtimeMs: Math.round(st.mtimeMs),
      });
    }
  }

  const now = Date.now();
  const transcodeCacheDir = join(pluginDataDir, 'transcode-cache');
  let added = 0;

  const tracks = await mapConcurrency(discovered, 4, async (item) => {
    const existing = prevByRel.get(item.relPath);
    const id = computeTrackId(item.relPath);
    const unchanged = Boolean(
      quick
      && existing
      && existing.sizeBytes === item.sizeBytes
      && Math.abs(existing.mtimeMs - item.mtimeMs) < 5,
    );
    const cachedTranscode = join(transcodeCacheDir, `${id}.mp3`);
    const validTranscode = existing?.transcodePath && existsSync(existing.transcodePath)
      ? existing.transcodePath
      : (existsSync(cachedTranscode) ? cachedTranscode : undefined);

    if (unchanged && existing) {
      return {
        ...existing,
        id,
        filePath: item.filePath,
        filename: item.filename,
        folder: item.folder,
        ext: item.ext,
        ...(validTranscode ? { transcodePath: validTranscode } : {}),
      };
    }

    if (!existing) added += 1;
    const meta = await probeAudioMetadata(item.filePath, { ...deps, signal: options.signal });
    return {
      id,
      relPath: item.relPath,
      filePath: item.filePath,
      filename: item.filename,
      folder: item.folder,
      ext: item.ext,
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      durationSec: meta.durationSec,
      bitrateKbps: meta.bitrateKbps,
      codec: meta.codec,
      sizeBytes: item.sizeBytes,
      mtimeMs: item.mtimeMs,
      addedAt: existing?.addedAt ?? now,
      ...(validTranscode ? { transcodePath: validTranscode } : {}),
    };
  });

  tracks.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.title.localeCompare(b.title, 'zh-Hans-CN'));
  const nextRelSet = new Set(tracks.map((t) => t.relPath));
  const removed = prev.tracks.filter((t) => !nextRelSet.has(t.relPath)).length;

  const updatedAt = Date.now();
  writeJsonAtomic(join(pluginDataDir, 'library.json'), {
    updatedAt,
    musicDir: rootReal,
    tracks,
  });

  return {
    updatedAt,
    musicDir: rootReal,
    tracks,
    added,
    removed,
    total: tracks.length,
  };
}

/**
 * @param {string} s
 * @returns {string}
 */
export function normalizeSearchText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[《》「」『』【】()（）\[\]'".,，。!?！？、·\s_-]+/g, '');
}

/**
 * @param {readonly MusicTrack[]} tracks
 * @param {string} query
 * @returns {MusicTrack[]}
 */
export function searchLocalTracks(tracks, query) {
  const raw = String(query ?? '').trim();
  if (!raw) return [...tracks];
  const rawLower = raw.toLowerCase();
  const normQuery = normalizeSearchText(raw);
  const deSplit = raw.replace(/\s*的\s*/g, ' ').trim();
  const tokens = deSplit
    .split(/\s+/)
    .map((t) => normalizeSearchText(t))
    .filter(Boolean);

  /** @type {Array<{ track: MusicTrack; score: number }>} */
  const scored = [];
  for (const track of tracks) {
    const normTitle = normalizeSearchText(track.title);
    const normArtist = normalizeSearchText(track.artist);
    const normAlbum = normalizeSearchText(track.album);
    const normFile = normalizeSearchText(track.filename);
    const combined = `${normArtist}${normTitle}${normAlbum}${normFile}`;
    const combinedRev = `${normTitle}${normArtist}`;

    let score = 0;
    if (normQuery && normTitle === normQuery) score = 1000;
    else if (normQuery && normTitle.startsWith(normQuery)) score = 700;
    else if (normQuery && normTitle.includes(normQuery)) score = 550;
    else if (track.title.toLowerCase().includes(rawLower)) score = 450;
    else if (normQuery && normArtist === normQuery) score = 380;
    else if (normQuery && normArtist.includes(normQuery)) score = 320;
    else if (normQuery && (combined.includes(normQuery) || combinedRev.includes(normQuery))) score = 240;
    else if (tokens.length > 1 && tokens.every((tok) => combined.includes(tok))) score = 160;
    else if (normQuery && normFile.includes(normQuery)) score = 120;

    if (score > 0) {
      scored.push({ track, score });
    }
  }

  scored.sort((a, b) => (b.score - a.score) || (b.track.mtimeMs - a.track.mtimeMs));
  return scored.map((s) => s.track);
}

/**
 * @param {string} pluginDataDir
 * @returns {{ version: number; playlists: MusicPlaylist[] }}
 */
export function loadPlaylists(pluginDataDir) {
  const raw = readJsonSafe(join(pluginDataDir, 'playlists.json'), null);
  /** @type {MusicPlaylist[]} */
  const list = raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.playlists)
    ? raw.playlists
      .filter((p) => p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string')
      .map((p) => ({
        id: String(p.id),
        name: String(p.name),
        ...(p.builtin ? { builtin: true } : {}),
        trackIds: Array.isArray(p.trackIds) ? [...new Set(p.trackIds.map((x) => String(x)).filter(Boolean))] : [],
        updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now(),
      }))
    : [];

  if (!list.some((p) => p.id === FAVORITES_PLAYLIST_ID)) {
    list.unshift({
      id: FAVORITES_PLAYLIST_ID,
      name: '我喜欢的音乐',
      builtin: true,
      trackIds: [],
      updatedAt: Date.now(),
    });
  }
  return { version: 1, playlists: list };
}

/**
 * @param {string} pluginDataDir
 * @param {MusicPlaylist[]} playlists
 */
export function savePlaylists(pluginDataDir, playlists) {
  writeJsonAtomic(join(pluginDataDir, 'playlists.json'), {
    version: 1,
    playlists,
  });
}

/**
 * @param {string} pluginDataDir
 * @param {{ op: string; id?: string; playlistId?: string; name?: string; trackId?: string }} args
 * @returns {{ ok: boolean; playlists: MusicPlaylist[]; playlist?: MusicPlaylist; favorited?: boolean; message: string }}
 */
export function mutatePlaylist(pluginDataDir, args) {
  const store = loadPlaylists(pluginDataDir);
  const playlists = store.playlists;
  const op = String(args.op ?? 'list').trim().toLowerCase();
  const targetId = String(args.playlistId ?? args.id ?? '').trim();
  const trackId = String(args.trackId ?? '').trim();
  const name = String(args.name ?? '').trim();

  if (op === 'list') {
    return { ok: true, playlists, message: `共 ${playlists.length} 个歌单` };
  }

  if (op === 'create') {
    if (!name) return { ok: false, playlists, message: '请输入歌单名称' };
    const cleanName = name.slice(0, 40);
    if (playlists.some((p) => p.name === cleanName)) {
      return { ok: false, playlists, message: `歌单「${cleanName}」已存在` };
    }
    const created = {
      id: `pl-${randomUUID().slice(0, 8)}`,
      name: cleanName,
      trackIds: trackId ? [trackId] : [],
      updatedAt: Date.now(),
    };
    playlists.push(created);
    savePlaylists(pluginDataDir, playlists);
    return { ok: true, playlists, playlist: created, message: `已创建歌单「${cleanName}」` };
  }

  if (op === 'toggle-favorite') {
    if (!trackId) return { ok: false, playlists, message: '缺少 trackId' };
    const fav = playlists.find((p) => p.id === FAVORITES_PLAYLIST_ID);
    if (!fav) return { ok: false, playlists, message: '收藏歌单异常' };
    const idx = fav.trackIds.indexOf(trackId);
    let favorited;
    if (idx >= 0) {
      fav.trackIds.splice(idx, 1);
      favorited = false;
    } else {
      fav.trackIds.unshift(trackId);
      favorited = true;
    }
    fav.updatedAt = Date.now();
    savePlaylists(pluginDataDir, playlists);
    return {
      ok: true,
      playlists,
      playlist: fav,
      favorited,
      message: favorited ? '已添加到「我喜欢的音乐」' : '已移出「我喜欢的音乐」',
    };
  }

  const target = playlists.find((p) => p.id === targetId || (name && p.name === name));
  if (!target) {
    return { ok: false, playlists, message: '未找到指定歌单' };
  }

  if (op === 'rename') {
    if (target.builtin) return { ok: false, playlists, message: '内置歌单不支持重命名' };
    if (!name) return { ok: false, playlists, message: '请输入新的歌单名称' };
    target.name = name.slice(0, 40);
    target.updatedAt = Date.now();
    savePlaylists(pluginDataDir, playlists);
    return { ok: true, playlists, playlist: target, message: `已重命名为「${target.name}」` };
  }

  if (op === 'delete') {
    if (target.builtin || target.id === FAVORITES_PLAYLIST_ID) {
      return { ok: false, playlists, message: '内置「我喜欢的音乐」歌单不可删除' };
    }
    const next = playlists.filter((p) => p.id !== target.id);
    savePlaylists(pluginDataDir, next);
    return { ok: true, playlists: next, message: `已删除歌单「${target.name}」` };
  }

  if (op === 'add-track') {
    if (!trackId) return { ok: false, playlists, message: '缺少 trackId' };
    if (!target.trackIds.includes(trackId)) {
      target.trackIds.push(trackId);
      target.updatedAt = Date.now();
      savePlaylists(pluginDataDir, playlists);
    }
    return { ok: true, playlists, playlist: target, message: `已加入歌单「${target.name}」` };
  }

  if (op === 'remove-track') {
    if (!trackId) return { ok: false, playlists, message: '缺少 trackId' };
    target.trackIds = target.trackIds.filter((id) => id !== trackId);
    target.updatedAt = Date.now();
    savePlaylists(pluginDataDir, playlists);
    return { ok: true, playlists, playlist: target, message: `已从歌单「${target.name}」移除` };
  }

  return { ok: false, playlists, message: `不支持的歌单操作 "${op}"` };
}

/**
 * @param {MusicTrack} track
 * @param {string} pluginDataDir
 * @param {{
 *   forceTranscode?: boolean;
 *   ffmpegPath?: string;
 *   execFileFn?: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout?: unknown; stderr?: unknown }>;
 *   signal?: AbortSignal;
 * }} [deps]
 * @returns {Promise<{ streamExt: string; transcodePath?: string }>}
 */
export async function ensurePlayableFile(track, pluginDataDir, deps = {}) {
  const ext = extname(track.filePath).toLowerCase();
  if (DIRECT_LX06_EXTS.has(ext) && !deps.forceTranscode) {
    return { streamExt: ext };
  }

  const cacheDir = join(pluginDataDir, 'transcode-cache');
  ensurePrivateDir(cacheDir);
  const outPath = join(cacheDir, `${track.id}.mp3`);
  if (existsSync(outPath)) {
    try {
      const st = statSync(outPath);
      if (st.isFile() && st.size > 128 && st.mtimeMs >= track.mtimeMs) {
        return { streamExt: '.mp3', transcodePath: outPath };
      }
    } catch {
      // re-transcode on stat failure
    }
  }

  const execFn = deps.execFileFn ?? ((cmd, args, opts) => execFileAsync(cmd, args, opts));
  const ffmpegBin = deps.ffmpegPath || (existsSync('/usr/bin/ffmpeg') ? '/usr/bin/ffmpeg' : 'ffmpeg');
  const tmpPath = join(cacheDir, `.tmp-${track.id}-${process.pid}.mp3`);
  try {
    await execFn(
      ffmpegBin,
      ['-y', '-v', 'error', '-i', track.filePath, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', tmpPath],
      { encoding: 'utf8', timeout: 120_000, ...(deps.signal ? { signal: deps.signal } : {}) },
    );
    renameSync(tmpPath, outPath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw new Error(`音频转码失败：${err instanceof Error ? err.message : String(err)}`);
  }

  const lib = loadLibrary(pluginDataDir);
  const idx = lib.tracks.findIndex((t) => t.id === track.id);
  if (idx >= 0) {
    lib.tracks[idx] = { ...lib.tracks[idx], transcodePath: outPath };
    writeJsonAtomic(join(pluginDataDir, 'library.json'), {
      updatedAt: lib.updatedAt ?? Date.now(),
      musicDir: lib.musicDir,
      tracks: lib.tracks,
    });
  }

  return { streamExt: '.mp3', transcodePath: outPath };
}

/**
 * @param {string} pluginDataDir
 * @param {string} musicDir
 * @param {string} trackId
 * @returns {{ ok: boolean; deleted?: MusicTrack; message: string }}
 */
export function deleteTrackById(pluginDataDir, musicDir, trackId) {
  const cleanId = String(trackId ?? '').trim().toLowerCase();
  if (!cleanId) return { ok: false, message: '缺少 trackId' };
  const lib = loadLibrary(pluginDataDir);
  const target = lib.tracks.find((t) => t.id === cleanId);
  if (!target) return { ok: false, message: `未找到曲目 ${cleanId}` };

  const rootReal = realpathSync(resolve(musicDir));
  if (existsSync(target.filePath)) {
    const fileReal = realpathSync(target.filePath);
    if (!isPathInside(rootReal, fileReal)) {
      return { ok: false, message: '拒绝删除音乐目录之外的文件' };
    }
    unlinkSync(fileReal);
  }

  const cachedMp3 = join(pluginDataDir, 'transcode-cache', `${cleanId}.mp3`);
  if (existsSync(cachedMp3)) {
    try {
      unlinkSync(cachedMp3);
    } catch {
      // ignore cache cleanup error
    }
  }

  const nextTracks = lib.tracks.filter((t) => t.id !== cleanId);
  writeJsonAtomic(join(pluginDataDir, 'library.json'), {
    updatedAt: Date.now(),
    musicDir: lib.musicDir || rootReal,
    tracks: nextTracks,
  });

  const plStore = loadPlaylists(pluginDataDir);
  let plChanged = false;
  for (const pl of plStore.playlists) {
    const before = pl.trackIds.length;
    pl.trackIds = pl.trackIds.filter((id) => id !== cleanId);
    if (pl.trackIds.length !== before) {
      pl.updatedAt = Date.now();
      plChanged = true;
    }
  }
  if (plChanged) {
    savePlaylists(pluginDataDir, plStore.playlists);
  }

  return { ok: true, deleted: target, message: `已删除曲目《${target.title}》` };
}

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readJsonSafe, writeJsonAtomic } from '../_shared/config-store.mjs';
import { isPathInside, SUPPORTED_AUDIO_EXTS } from './library.mjs';

const execFileAsync = promisify(execFile);
const MAX_DOWNLOAD_JOBS = 30;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const SEARCH_TIMEOUT_MS = 25_000;

/**
 * @typedef {{
 *   id: string;
 *   title: string;
 *   artist: string;
 *   durationSec: number | null;
 *   url: string;
 *   source: 'youtube' | 'bilibili' | 'direct';
 *   thumbnail?: string;
 * }} OnlineSearchCandidate
 *
 * @typedef {{
 *   id: string;
 *   status: 'queued' | 'downloading' | 'done' | 'error';
 *   query: string;
 *   url: string;
 *   source: string;
 *   title: string;
 *   artist: string;
 *   trackId?: string;
 *   filePath?: string;
 *   playAfter?: boolean;
 *   error?: string;
 *   startedAt: number;
 *   finishedAt?: number;
 * }} DownloadJob
 */

/**
 * @param {string} [configuredPath]
 * @returns {string}
 */
export function findYtDlp(configuredPath) {
  const candidates = [
    typeof configuredPath === 'string' ? configuredPath.trim() : '',
    join(homedir(), '.local', 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
  ].filter(Boolean);

  for (const cand of candidates) {
    if (existsSync(cand)) return cand;
  }

  const pathDirs = String(process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of pathDirs) {
    const bin = join(dir, 'yt-dlp');
    if (existsSync(bin)) return bin;
  }
  return '';
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
export function isPrivateOrLoopbackHost(hostname) {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host === '0.0.0.0'
    || host === '::'
    || host === '::1'
  ) {
    return true;
  }

  const mappedMatch = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  const ipCandidate = mappedMatch ? mappedMatch[1] : host;
  const ipKind = isIP(ipCandidate);
  if (ipKind === 4) {
    const parts = ipCandidate.split('.').map((n) => Number(n));
    const [a = 0, b = 0] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (ipKind === 6) {
    return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  }
  return false;
}

/**
 * @param {string} rawUrl
 * @returns {{ url: string; source: 'youtube' | 'bilibili' | 'direct' }}
 */
export function detectSourceFromUrl(rawUrl) {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) throw new Error('下载链接不能为空');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('无效的下载链接格式');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不支持的链接协议 "${parsed.protocol}"（仅允许 http/https）`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('链接不允许包含用户名或密码');
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    throw new Error(`禁止访问局域网或本机地址 "${parsed.hostname}"`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'youtu.be' || host.endsWith('.youtube.com') || host === 'youtube.com') {
    return { url: parsed.toString(), source: 'youtube' };
  }
  if (host === 'b23.tv' || host.endsWith('.bilibili.com') || host === 'bilibili.com') {
    return { url: parsed.toString(), source: 'bilibili' };
  }
  return { url: parsed.toString(), source: 'direct' };
}

/**
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeFilenamePart(raw) {
  return String(raw ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 100)
    .trim();
}

/**
 * @param {string} dir
 * @param {string} stem
 * @param {string} ext
 * @returns {string}
 */
function pickUniqueTarget(dir, stem, ext) {
  const cleanStem = sanitizeFilenamePart(stem) || 'track';
  for (let i = 1; i <= 500; i += 1) {
    const name = i === 1 ? `${cleanStem}${ext}` : `${cleanStem} (${i})${ext}`;
    const full = join(dir, name);
    if (!existsSync(full)) return full;
  }
  return join(dir, `${cleanStem}-${randomUUID().slice(0, 6)}${ext}`);
}

/**
 * @param {'youtube' | 'bilibili'} source
 * @param {string} query
 * @param {number} limit
 * @param {string} ytDlpBin
 * @param {{
 *   execFileFn?: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout?: unknown; stderr?: unknown }>;
 *   signal?: AbortSignal;
 * }} [deps]
 * @returns {Promise<OnlineSearchCandidate[]>}
 */
async function runYtDlpSearch(source, query, limit, ytDlpBin, deps = {}) {
  const prefix = source === 'bilibili' ? 'bilisearch' : 'ytsearch';
  const execFn = deps.execFileFn ?? ((cmd, args, opts) => execFileAsync(cmd, args, opts));
  const args = [
    '--flat-playlist',
    '--dump-json',
    '--no-warnings',
    '--ignore-errors',
    '--js-runtimes',
    'node',
    `${prefix}${limit}:${query}`,
  ];
  const res = await execFn(ytDlpBin, args, {
    encoding: 'utf8',
    timeout: SEARCH_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  const lines = String(res?.stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  /** @type {OnlineSearchCandidate[]} */
  const out = [];
  for (const line of lines) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (item.is_live === true || item.live_status === 'is_live') continue;
    const rawDuration = Number(item.duration);
    const durationSec = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.round(rawDuration) : null;
    if (durationSec !== null && durationSec > 1500) continue;

    const rawUrl = String(item.webpage_url || item.url || '').trim();
    if (!rawUrl) continue;
    const url = rawUrl.startsWith('http://') || rawUrl.startsWith('https://')
      ? rawUrl
      : source === 'youtube'
        ? `https://www.youtube.com/watch?v=${encodeURIComponent(rawUrl)}`
        : rawUrl;

    const title = String(item.title || item.fulltitle || '').trim();
    if (!title) continue;
    const artist = String(item.artist || item.uploader || item.channel || item.creator || '').trim();
    const thumbnail = typeof item.thumbnail === 'string'
      ? item.thumbnail
      : (Array.isArray(item.thumbnails) && item.thumbnails[0]?.url ? String(item.thumbnails[0].url) : undefined);

    out.push({
      id: String(item.id || randomUUID().slice(0, 8)),
      title,
      artist,
      durationSec,
      url,
      source,
      ...(thumbnail ? { thumbnail } : {}),
    });
  }
  return out;
}

/**
 * @param {string} query
 * @param {{ source?: string; limit?: number; ytDlpPath?: string; signal?: AbortSignal }} [options]
 * @param {{
 *   ytDlpPath?: string;
 *   execFileFn?: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout?: unknown; stderr?: unknown }>;
 * }} [deps]
 * @returns {Promise<{ source: string; candidates: OnlineSearchCandidate[] }>}
 */
export async function searchOnlineTracks(query, options = {}, deps = {}) {
  const cleanQuery = String(query ?? '').trim();
  if (!cleanQuery) throw new Error('请输入要搜索的歌名或歌手');
  const ytDlpBin = deps.ytDlpPath || findYtDlp(options.ytDlpPath);
  if (!ytDlpBin) {
    throw new Error('未找到 yt-dlp 可执行文件，请先安装 yt-dlp');
  }
  const limit = Math.max(1, Math.min(12, Math.round(Number(options.limit ?? 6) || 6)));
  const reqSource = String(options.source ?? 'youtube').trim().toLowerCase();

  if (reqSource === 'bilibili') {
    const candidates = await runYtDlpSearch('bilibili', cleanQuery, limit, ytDlpBin, { ...deps, signal: options.signal });
    return { source: 'bilibili', candidates };
  }

  const ytCandidates = await runYtDlpSearch('youtube', cleanQuery, limit, ytDlpBin, { ...deps, signal: options.signal });
  if (ytCandidates.length > 0 || reqSource === 'youtube') {
    return { source: 'youtube', candidates: ytCandidates };
  }

  const biliCandidates = await runYtDlpSearch('bilibili', cleanQuery, limit, ytDlpBin, { ...deps, signal: options.signal });
  return { source: 'bilibili', candidates: biliCandidates };
}

/**
 * @param {string} pluginDataDir
 * @returns {DownloadJob[]}
 */
export function loadDownloadJobs(pluginDataDir) {
  const raw = readJsonSafe(join(pluginDataDir, 'downloads.json'), null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.jobs)) {
    return [];
  }
  return /** @type {DownloadJob[]} */ (raw.jobs.filter((j) => j && typeof j === 'object' && typeof j.id === 'string'));
}

/**
 * @param {string} pluginDataDir
 * @param {DownloadJob} job
 * @returns {DownloadJob[]}
 */
export function upsertDownloadJob(pluginDataDir, job) {
  const jobs = loadDownloadJobs(pluginDataDir);
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) {
    jobs[idx] = { ...jobs[idx], ...job };
  } else {
    jobs.unshift(job);
  }
  const trimmed = jobs.slice(0, MAX_DOWNLOAD_JOBS);
  writeJsonAtomic(join(pluginDataDir, 'downloads.json'), {
    updatedAt: Date.now(),
    jobs: trimmed,
  });
  return trimmed;
}

/**
 * @param {{
 *   url?: string;
 *   query?: string;
 *   source?: string;
 *   format?: string;
 *   titleHint?: string;
 *   artistHint?: string;
 *   musicDir: string;
 *   ytDlpPath?: string;
 *   signal?: AbortSignal;
 * }} params
 * @param {{
 *   ytDlpPath?: string;
 *   execFileFn?: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout?: unknown; stderr?: unknown }>;
 * }} [deps]
 * @returns {Promise<{ filePath: string; title: string; artist: string; source: string; url: string }>}
 */
export async function downloadOnlineAudioFile(params, deps = {}) {
  const ytDlpBin = deps.ytDlpPath || findYtDlp(params.ytDlpPath);
  if (!ytDlpBin) {
    throw new Error('未找到 yt-dlp 可执行文件，请先安装 yt-dlp');
  }

  let targetUrl = '';
  let resolvedSource = String(params.source ?? 'youtube').trim().toLowerCase() || 'youtube';
  let title = String(params.titleHint ?? '').trim();
  let artist = String(params.artistHint ?? '').trim();

  if (params.url && String(params.url).trim()) {
    const checked = detectSourceFromUrl(String(params.url));
    targetUrl = checked.url;
    resolvedSource = checked.source;
  } else if (params.query && String(params.query).trim()) {
    const searchRes = await searchOnlineTracks(String(params.query), {
      source: resolvedSource === 'auto' ? 'auto' : resolvedSource,
      limit: 3,
      ytDlpPath: ytDlpBin,
      signal: params.signal,
    }, deps);
    const best = searchRes.candidates[0];
    if (!best) {
      throw new Error(`未搜索到与「${String(params.query).trim()}」匹配的在线音源`);
    }
    const checked = detectSourceFromUrl(best.url);
    targetUrl = checked.url;
    resolvedSource = best.source;
    title ||= best.title;
    artist ||= best.artist;
  } else {
    throw new Error('请提供下载链接（url）或歌曲搜索关键词（query）');
  }

  const audioFormat = String(params.format ?? 'mp3').trim().toLowerCase() === 'm4a' ? 'm4a' : 'mp3';
  const musicDir = resolve(params.musicDir);
  const downloadsDir = join(musicDir, 'downloads');
  mkdirSync(downloadsDir, { recursive: true });
  const musicDirReal = realpathSync(musicDir);
  const downloadsReal = realpathSync(downloadsDir);
  if (!isPathInside(musicDirReal, downloadsReal)) {
    throw new Error('下载目录越界');
  }

  const tmpDir = join(downloadsReal, `.dl-${randomUUID().slice(0, 8)}`);
  mkdirSync(tmpDir, { recursive: true });
  const execFn = deps.execFileFn ?? ((cmd, args, opts) => execFileAsync(cmd, args, opts));

  try {
    const args = [
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--js-runtimes',
      'node',
      '-x',
      '--audio-format',
      audioFormat,
      '--audio-quality',
      '0',
      '--embed-metadata',
      '--add-metadata',
      '-o',
      join(tmpDir, '%(title).100B.%(ext)s'),
      '--print',
      'after_move:filepath',
      targetUrl,
    ];
    const res = await execFn(ytDlpBin, args, {
      encoding: 'utf8',
      timeout: DOWNLOAD_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      ...(params.signal ? { signal: params.signal } : {}),
    });

    const printedLines = String(res?.stdout ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    let producedPath = printedLines.at(-1) || '';
    if (!producedPath || !existsSync(producedPath)) {
      const files = readdirSync(tmpDir)
        .filter((f) => SUPPORTED_AUDIO_EXTS.has(extname(f).toLowerCase()))
        .map((f) => join(tmpDir, f));
      producedPath = files[0] || '';
    }
    if (!producedPath || !existsSync(producedPath)) {
      throw new Error('yt-dlp 下载完成但未生成音频文件');
    }

    const producedReal = realpathSync(producedPath);
    if (!isPathInside(tmpDir, producedReal)) {
      throw new Error('下载输出文件路径异常');
    }
    const producedExt = extname(producedReal).toLowerCase() || `.${audioFormat}`;
    if (!SUPPORTED_AUDIO_EXTS.has(producedExt)) {
      throw new Error(`不支持的下载输出格式 ${producedExt}`);
    }
    const st = statSync(producedReal);
    if (!st.isFile() || st.size <= 0) {
      throw new Error('下载的音频文件为空');
    }

    const rawBase = basename(producedReal, producedExt);
    const desiredStem = artist && title
      ? `${artist} - ${title}`
      : (title || rawBase);
    const finalPath = pickUniqueTarget(downloadsReal, desiredStem, producedExt);
    if (!isPathInside(musicDirReal, resolve(finalPath))) {
      throw new Error('目标文件路径越界');
    }
    renameSync(producedReal, finalPath);
    return {
      filePath: finalPath,
      title: title || rawBase,
      artist,
      source: resolvedSource,
      url: targetUrl,
    };
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup failure
    }
  }
}

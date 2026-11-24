import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readJsonSafe, writeJsonAtomic } from '../_shared/config-store.mjs';
import { isPathInside, SUPPORTED_AUDIO_EXTS } from './library.mjs';

const execFileAsync = promisify(execFile);
const MAX_DOWNLOAD_JOBS = 30;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const SEARCH_TIMEOUT_MS = 25_000;
const NETSCAPE_HEADER_RE = /^#\s*(?:Netscape\s+)?HTTP Cookie File/i;

/**
 * @typedef {{
 *   id: string;
 *   title: string;
 *   artist: string;
 *   durationSec: number | null;
 *   url: string;
 *   source: 'youtube' | 'bilibili' | 'soundcloud' | 'direct';
 *   thumbnail?: string;
 * }} OnlineSearchCandidate
 *
 * @typedef {{
 *   configured: boolean;
 *   cookieCount: number;
 *   updatedAt: number | null;
 *   hasYouTube: boolean;
 *   hasYouTubeAuth: boolean;
 *   hasBilibili: boolean;
 *   hasBilibiliAuth: boolean;
 *   domains: string[];
 *   warning?: string;
 * }} CookiesSummary
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
 * @returns {{ url: string; source: 'youtube' | 'bilibili' | 'soundcloud' | 'direct' }}
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
  if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com') || host === 'on.soundcloud.com') {
    return { url: parsed.toString(), source: 'soundcloud' };
  }
  return { url: parsed.toString(), source: 'direct' };
}

const YOUTUBE_AUTH_COOKIE_NAMES = new Set([
  'LOGIN_INFO',
  'SID',
  'HSID',
  'SSID',
  'APISID',
  'SAPISID',
  '__Secure-1PSID',
  '__Secure-3PSID',
  '__Secure-1PAPISID',
  '__Secure-3PAPISID',
]);

const BILIBILI_AUTH_COOKIE_NAMES = new Set([
  'SESSDATA',
  'DedeUserID',
  'bili_jct',
]);

/**
 * @param {string} domain
 * @returns {number}
 */
function cookieDomainPriority(domain) {
  if (domain === 'youtube.com' || domain.endsWith('.youtube.com') || domain === 'youtu.be') return 0;
  if (domain === 'bilibili.com' || domain.endsWith('.bilibili.com')) return 1;
  if (domain === 'soundcloud.com' || domain.endsWith('.soundcloud.com')) return 2;
  if (domain === 'google.com' || domain.endsWith('.google.com')) return 3;
  return 4;
}

/**
 * @param {string} rawText
 */
function parseNetscapeCookiesText(rawText) {
  const cleaned = String(rawText ?? '').replace(/^\uFEFF/, '');
  if (cleaned.includes('\0')) {
    throw new Error('cookies.txt 不能包含二进制空字节');
  }

  const lines = cleaned.split(/\r?\n/);
  /** @type {Set<string>} */
  const seenDomains = new Set();
  let hasHeader = false;
  let sawFirstNonEmpty = false;
  let cookieCount = 0;
  let hasYouTube = false;
  let hasYouTubeAuth = false;
  let hasBilibili = false;
  let hasBilibiliAuth = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (!sawFirstNonEmpty) {
      sawFirstNonEmpty = true;
      if (NETSCAPE_HEADER_RE.test(trimmed)) hasHeader = true;
    }
    let parseLine = rawLine;
    if (parseLine.startsWith('#HttpOnly_')) {
      parseLine = parseLine.slice('#HttpOnly_'.length);
    } else if (parseLine.trimStart().startsWith('#')) {
      if (NETSCAPE_HEADER_RE.test(trimmed)) hasHeader = true;
      continue;
    }
    const cols = parseLine.split('\t');
    if (cols.length < 7) continue;
    const domain = String(cols[0] ?? '').trim().replace(/^\.+/, '').toLowerCase();
    const name = String(cols[5] ?? '').trim();
    if (!domain || /\s/.test(domain) || !name) continue;
    cookieCount += 1;
    seenDomains.add(domain);
    const isYtDomain = domain === 'youtube.com' || domain.endsWith('.youtube.com') || domain === 'youtu.be' || domain === 'google.com' || domain.endsWith('.google.com');
    const isBiliDomain = domain === 'bilibili.com' || domain.endsWith('.bilibili.com') || domain === 'biligame.com' || domain.endsWith('.biligame.com');
    if (isYtDomain) {
      hasYouTube = true;
      if (YOUTUBE_AUTH_COOKIE_NAMES.has(name)) {
        hasYouTubeAuth = true;
      }
    }
    if (isBiliDomain) {
      hasBilibili = true;
      if (BILIBILI_AUTH_COOKIE_NAMES.has(name)) {
        hasBilibiliAuth = true;
      }
    }
  }

  const domains = [...seenDomains]
    .sort((a, b) => cookieDomainPriority(a) - cookieDomainPriority(b))
    .slice(0, 6);

  const warning = hasYouTube && !hasYouTubeAuth
    ? '当前 cookies.txt 中的 YouTube Cookie 缺少登录态，无法通过 YouTube 下载校验'
    : undefined;

  return { cleaned, hasHeader, cookieCount, hasYouTube, hasYouTubeAuth, hasBilibili, hasBilibiliAuth, domains, warning };
}

/**
 * @param {string} rawText
 * @returns {{
 *   normalizedText: string;
 *   summary: {
 *     cookieCount: number;
 *     hasYouTube: boolean;
 *     hasYouTubeAuth: boolean;
 *     hasBilibili: boolean;
 *     hasBilibiliAuth: boolean;
 *     domains: string[];
 *     warning?: string;
 *   };
 * }}
 */
export function normalizeNetscapeCookiesText(rawText) {
  const parsed = parseNetscapeCookiesText(rawText);
  if (parsed.cookieCount === 0) {
    throw new Error('未识别到有效的 Netscape cookies.txt 条目，请使用浏览器扩展导出 Netscape 格式');
  }
  if (parsed.hasYouTube && !parsed.hasYouTubeAuth && !parsed.hasBilibili) {
    throw new Error('检测到该 cookies.txt 仅包含 YouTube 访客 Cookie，缺少账号登录态（常见于未登录浏览器或命令行导出失败）。请先在浏览器登录 YouTube，再使用「Get cookies.txt LOCALLY」等扩展导出 Netscape 格式后重新导入。');
  }
  let normalizedText = parsed.cleaned.replace(/\r\n/g, '\n');
  if (!parsed.hasHeader) {
    normalizedText = `# Netscape HTTP Cookie File\n${normalizedText}`;
  }
  if (!normalizedText.endsWith('\n')) {
    normalizedText += '\n';
  }
  return {
    normalizedText,
    summary: {
      cookieCount: parsed.cookieCount,
      hasYouTube: parsed.hasYouTube,
      hasYouTubeAuth: parsed.hasYouTubeAuth,
      hasBilibili: parsed.hasBilibili,
      hasBilibiliAuth: parsed.hasBilibiliAuth,
      domains: parsed.domains,
      ...(parsed.warning ? { warning: parsed.warning } : {}),
    },
  };
}

/**
 * @param {string} filePath
 * @returns {CookiesSummary}
 */
export function inspectNetscapeCookiesFile(filePath) {
  /** @type {CookiesSummary} */
  const empty = {
    configured: false,
    cookieCount: 0,
    updatedAt: null,
    hasYouTube: false,
    hasYouTubeAuth: false,
    hasBilibili: false,
    hasBilibiliAuth: false,
    domains: [],
  };
  if (!filePath || !existsSync(filePath)) return empty;
  try {
    const st = statSync(filePath);
    if (!st.isFile() || st.size <= 0) return empty;
    const raw = readFileSync(filePath, 'utf8');
    const parsed = parseNetscapeCookiesText(raw);
    const configured = parsed.cookieCount > 0;
    return {
      configured,
      cookieCount: parsed.cookieCount,
      updatedAt: Math.round(st.mtimeMs),
      hasYouTube: parsed.hasYouTube,
      hasYouTubeAuth: parsed.hasYouTubeAuth,
      hasBilibili: parsed.hasBilibili,
      hasBilibiliAuth: parsed.hasBilibiliAuth,
      domains: parsed.domains,
      ...(configured && parsed.warning ? { warning: parsed.warning } : {}),
    };
  } catch {
    return empty;
  }
}

/**
 * @param {unknown} err
 * @param {{ source?: string; hasCookies?: boolean; hasYouTubeAuth?: boolean }} [opts]
 * @returns {string}
 */
export function formatYtDlpError(err, opts = {}) {
  let stderr = '';
  let message = '';
  let killed = false;

  if (typeof err === 'string') {
    message = err;
  } else if (err && typeof err === 'object') {
    const rec = /** @type {Record<string, unknown>} */ (err);
    stderr = typeof rec.stderr === 'string' ? rec.stderr : '';
    message = typeof rec.message === 'string' ? rec.message : '';
    killed = Boolean(rec.killed);
  }

  const combined = [stderr, message].filter(Boolean).join('\n').trim();
  const hasCookies = Boolean(opts.hasCookies);

  if (/sign in to confirm you.?re not a bot|confirm you.?re not a bot|use --cookies-from-browser or --cookies/i.test(combined)) {
    if (hasCookies && opts.hasYouTubeAuth === false) {
      return '当前导入的 cookies.txt 仅包含 YouTube 访客 Cookie（缺少账号登录态），无法通过校验；请在已登录 YouTube 的浏览器中用扩展（如 Get cookies.txt LOCALLY）重新导出后在「设置」导入';
    }
    return hasCookies
      ? 'YouTube 登录态校验未通过（cookies.txt 可能已过期或缺少登录态），请在「设置」重新导入最新的 cookies.txt，或改用 SoundCloud / B站直链'
      : 'YouTube 触发风控校验（需要登录态），请在「设置」导入 cookies.txt，或改用免登录的 SoundCloud 搜索 / 直接粘贴 B站 BV 链接';
  }

  if (/http error 412|precondition failed/i.test(combined)) {
    return hasCookies
      ? 'Bilibili 请求触发风控 (HTTP 412)，当前 Cookie 可能已失效；可直接粘贴 B站 BV 视频链接下载，或在「设置」重新导入含 B站登录态的 cookies.txt'
      : 'Bilibili 搜索触发风控 (HTTP 412)，可直接粘贴 B站 BV 视频链接下载，或在「设置」导入含 B站登录态的 cookies.txt';
  }

  if (/drm protected|this video is drm/i.test(combined)) {
    return '该曲目受平台 DRM 版权加密保护，无法下载；请换其他非版权加密版本，或改用已登录的 YouTube / B站直链';
  }

  if (/does not look like a netscape format cookies file|loaderror/i.test(combined)) {
    return 'cookies.txt 格式无效，请重新导出 Netscape 格式的 cookies.txt 并在「设置」导入';
  }

  if (/video unavailable|this video is private|members-only|sign in to view|account associated with this video|requires payment|premium/i.test(combined)) {
    return '该音源不可访问（私密、会员专属或已下架），请尝试其他候选或音源';
  }

  if (killed || /timed out|etimedout/i.test(combined)) {
    return '搜索或下载超时，请检查主机网络代理后重试';
  }

  if (/ffmpeg|ffprobe.*not found|postprocessing.*ffmpeg/i.test(combined)) {
    return '音频转码失败：未找到可用的 ffmpeg';
  }

  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = [...lines].reverse().find((line) => /^ERROR:/i.test(line));
  if (errorLine) {
    const cleaned = errorLine
      .replace(/^ERROR:\s*/i, '')
      .replace(/\b(?:Also\s+)?See\s+https?:\/\/\S+.*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);
    if (cleaned) return cleaned;
  }

  const filtered = lines
    .filter((line) => !/^Command failed:/i.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
  if (filtered) return filtered;

  return combined.replace(/^Command failed:\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 220) || '在线搜歌或下载失败';
}

/**
 * yt-dlp writes updated cookies back to `--cookies FILE` on exit; pass an ephemeral
 * copy so concurrent searches/downloads never corrupt the stored `cookies.txt`.
 * @template T
 * @param {string | undefined} cookiesPath
 * @param {(ephemeralCookiesPath: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withEphemeralCookiesCopy(cookiesPath, fn) {
  const cleanPath = typeof cookiesPath === 'string' ? cookiesPath.trim() : '';
  if (!cleanPath || !existsSync(cleanPath)) {
    return fn('');
  }
  try {
    const st = statSync(cleanPath);
    if (!st.isFile() || st.size <= 0) return fn('');
  } catch {
    return fn('');
  }

  const dir = mkdtempSync(join(tmpdir(), 'friday-ytdlp-cookie-'));
  try {
    chmodSync(dir, 0o700);
    const ephemeralPath = join(dir, 'cookies.txt');
    copyFileSync(cleanPath, ephemeralPath);
    chmodSync(ephemeralPath, 0o600);
    return await fn(ephemeralPath);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup failure
    }
  }
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
 * @param {'youtube' | 'bilibili' | 'soundcloud'} source
 * @param {string} query
 * @param {number} limit
 * @param {string} ytDlpBin
 * @param {{
 *   execFileFn?: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout?: unknown; stderr?: unknown }>;
 *   cookiesPath?: string;
 *   signal?: AbortSignal;
 * }} [deps]
 * @returns {Promise<OnlineSearchCandidate[]>}
 */
async function runYtDlpSearch(source, query, limit, ytDlpBin, deps = {}) {
  const prefix = source === 'bilibili' ? 'bilisearch' : source === 'soundcloud' ? 'scsearch' : 'ytsearch';
  const execFn = deps.execFileFn ?? ((cmd, args, opts) => execFileAsync(cmd, args, opts));
  const res = await withEphemeralCookiesCopy(deps.cookiesPath, async (ephemeralCookies) => {
    const cookieMeta = ephemeralCookies ? inspectNetscapeCookiesFile(ephemeralCookies) : null;
    const args = [
      '--flat-playlist',
      '--dump-json',
      '--no-warnings',
      '--ignore-errors',
      '--js-runtimes',
      'node',
      ...(ephemeralCookies ? ['--cookies', ephemeralCookies] : []),
      `${prefix}${limit}:${query}`,
    ];
    try {
      return await execFn(ytDlpBin, args, {
        encoding: 'utf8',
        timeout: SEARCH_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
    } catch (err) {
      throw new Error(formatYtDlpError(err, {
        source,
        hasCookies: Boolean(ephemeralCookies),
        ...(cookieMeta ? { hasYouTubeAuth: cookieMeta.hasYouTubeAuth } : {}),
      }));
    }
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
 * @param {{ source?: string; limit?: number; ytDlpPath?: string; cookiesPath?: string; signal?: AbortSignal }} [options]
 * @param {{
 *   ytDlpPath?: string;
 *   cookiesPath?: string;
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
  const cookiesPath = options.cookiesPath ?? deps.cookiesPath;
  const searchDeps = { ...deps, cookiesPath, signal: options.signal };

  if (reqSource === 'bilibili') {
    const candidates = await runYtDlpSearch('bilibili', cleanQuery, limit, ytDlpBin, searchDeps);
    return { source: 'bilibili', candidates };
  }
  if (reqSource === 'soundcloud') {
    const candidates = await runYtDlpSearch('soundcloud', cleanQuery, limit, ytDlpBin, searchDeps);
    return { source: 'soundcloud', candidates };
  }
  if (reqSource === 'youtube') {
    const candidates = await runYtDlpSearch('youtube', cleanQuery, limit, ytDlpBin, searchDeps);
    return { source: 'youtube', candidates };
  }

  const ytCandidates = await runYtDlpSearch('youtube', cleanQuery, limit, ytDlpBin, searchDeps);
  if (ytCandidates.length > 0) {
    return { source: 'youtube', candidates: ytCandidates };
  }

  const scCandidates = await runYtDlpSearch('soundcloud', cleanQuery, limit, ytDlpBin, searchDeps);
  return { source: 'soundcloud', candidates: scCandidates };
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
 *   cookiesPath?: string;
 *   signal?: AbortSignal;
 * }} params
 * @param {{
 *   ytDlpPath?: string;
 *   cookiesPath?: string;
 *   execFileFn?: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout?: unknown; stderr?: unknown }>;
 * }} [deps]
 * @returns {Promise<{ filePath: string; title: string; artist: string; source: string; url: string }>}
 */
export async function downloadOnlineAudioFile(params, deps = {}) {
  const ytDlpBin = deps.ytDlpPath || findYtDlp(params.ytDlpPath);
  if (!ytDlpBin) {
    throw new Error('未找到 yt-dlp 可执行文件，请先安装 yt-dlp');
  }

  const cookiesPath = params.cookiesPath ?? deps.cookiesPath;
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
      cookiesPath,
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
    const res = await withEphemeralCookiesCopy(cookiesPath, async (ephemeralCookies) => {
      const cookieMeta = ephemeralCookies ? inspectNetscapeCookiesFile(ephemeralCookies) : null;
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
        ...(ephemeralCookies ? ['--cookies', ephemeralCookies] : []),
        targetUrl,
      ];
      try {
        return await execFn(ytDlpBin, args, {
          encoding: 'utf8',
          timeout: DOWNLOAD_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          ...(params.signal ? { signal: params.signal } : {}),
        });
      } catch (err) {
        throw new Error(formatYtDlpError(err, {
          source: resolvedSource,
          hasCookies: Boolean(ephemeralCookies),
          ...(cookieMeta ? { hasYouTubeAuth: cookieMeta.hasYouTubeAuth } : {}),
        }));
      }
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

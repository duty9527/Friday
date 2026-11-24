import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { resolvePluginDataDir } from './paths.js';

export const AUDIO_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.aac': 'audio/aac',
};

export const MAX_MUSIC_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_MUSIC_COOKIES_BYTES = 2 * 1024 * 1024;
export const TRACK_ID_RE = /^[a-f0-9]{12,32}$/;
const SECRET_HEX_RE = /^[a-f0-9]{64}$/i;
const FOLDER_NAME_RE = /^[A-Za-z0-9._\u4e00-\u9fff-]{1,48}$/;
const STREAM_PATH_RE = /^\/media\/music\/([a-f0-9]{12,32})(\.[a-z0-9]{2,5})$/i;
const UPLOAD_TIMEOUT_MS = 120_000;
const COOKIES_UPLOAD_TIMEOUT_MS = 30_000;
const NETSCAPE_HEADER_RE = /^#\s*(?:Netscape\s+)?HTTP Cookie File/i;

export class MusicMediaError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'MusicMediaError';
  }
}

function isPathInside(rootReal: string, targetReal: string): boolean {
  if (targetReal === rootReal) return true;
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
  return targetReal.startsWith(prefix);
}

async function readJsonSafe<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export async function resolveConfiguredMusicDir(home: string): Promise<string> {
  const dataDir = resolvePluginDataDir(home, 'music');
  const cfg = await readJsonSafe<{ musicDir?: unknown }>(join(dataDir, 'config.json'));
  const configured = typeof cfg?.musicDir === 'string' ? cfg.musicDir.trim() : '';
  if (configured) return resolve(configured);
  if (existsSync('/mnt/data/music')) return '/mnt/data/music';
  return join(resolve(home), 'music');
}

export async function ensureMusicStreamSecret(home: string): Promise<string> {
  const dataDir = resolvePluginDataDir(home, 'music');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const secretPath = join(dataDir, 'stream-secret');
  const existing = await readMusicStreamSecret(home);
  if (existing) return existing;
  const secret = randomBytes(32).toString('hex');
  await writeFile(secretPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

export async function readMusicStreamSecret(home: string): Promise<string | undefined> {
  try {
    const secretPath = join(resolvePluginDataDir(home, 'music'), 'stream-secret');
    const raw = (await readFile(secretPath, 'utf8')).trim();
    return SECRET_HEX_RE.test(raw) ? raw.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export function signMusicStreamToken(secret: string, trackId: string, expSec: number): string {
  return createHmac('sha256', secret).update(`${trackId}:${expSec}`).digest('hex');
}

export function verifyMusicStreamToken(
  secret: string,
  trackId: string,
  expSec: number,
  sig: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!SECRET_HEX_RE.test(secret)) return false;
  if (!TRACK_ID_RE.test(trackId)) return false;
  if (!Number.isSafeInteger(expSec) || expSec < nowSec) return false;
  if (!SECRET_HEX_RE.test(sig)) return false;
  const expected = signMusicStreamToken(secret.toLowerCase(), trackId, expSec);
  const sigBuf = Buffer.from(sig.toLowerCase(), 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  return sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf);
}

interface StoredTrack {
  id?: unknown;
  filePath?: unknown;
  transcodePath?: unknown;
}

interface StoredLibrary {
  musicDir?: unknown;
  tracks?: StoredTrack[];
}

export async function resolveMusicStreamFile(
  home: string,
  trackId: string,
  requestedExt: string,
): Promise<{ filePath: string; mime: string; size: number } | undefined> {
  const cleanId = trackId.toLowerCase();
  const cleanExt = requestedExt.toLowerCase();
  if (!TRACK_ID_RE.test(cleanId) || !Object.hasOwn(AUDIO_MIME_BY_EXT, cleanExt)) {
    return undefined;
  }
  const dataDir = resolvePluginDataDir(home, 'music');
  const library = await readJsonSafe<StoredLibrary>(join(dataDir, 'library.json'));
  const tracks = Array.isArray(library?.tracks) ? library.tracks : [];
  const track = tracks.find(item => item && typeof item.id === 'string' && item.id.toLowerCase() === cleanId);
  if (!track) return undefined;

  const musicDir = await resolveConfiguredMusicDir(home);
  const transcodeCacheDir = join(dataDir, 'transcode-cache');

  const checkCandidate = async (candidateRaw: unknown, allowedRoot: string): Promise<{ filePath: string; mime: string; size: number } | undefined> => {
    if (typeof candidateRaw !== 'string' || !candidateRaw.trim()) return undefined;
    let rootReal: string;
    let fileReal: string;
    try {
      [rootReal, fileReal] = await Promise.all([realpath(allowedRoot), realpath(candidateRaw)]);
    } catch {
      return undefined;
    }
    if (!isPathInside(rootReal, fileReal)) return undefined;
    const actualExt = extname(fileReal).toLowerCase();
    if (actualExt !== cleanExt || !Object.hasOwn(AUDIO_MIME_BY_EXT, actualExt)) return undefined;
    try {
      const info = await stat(fileReal);
      if (!info.isFile()) return undefined;
      return { filePath: fileReal, mime: AUDIO_MIME_BY_EXT[actualExt]!, size: info.size };
    } catch {
      return undefined;
    }
  };

  if (cleanExt === '.mp3' && typeof track.transcodePath === 'string' && track.transcodePath.trim()) {
    const transcoded = await checkCandidate(track.transcodePath, transcodeCacheDir);
    if (transcoded) return transcoded;
  }
  return checkCandidate(track.filePath, musicDir);
}

function parseByteRange(
  rangeHeader: string,
  size: number,
): { ok: true; start: number; end: number } | { ok: false } {
  const trimmed = rangeHeader.trim();
  const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
  if (!match) return { ok: false };
  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (!rawStart && !rawEnd) return { ok: false };
  if (size <= 0) return { ok: false };

  let start: number;
  let end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { ok: false };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { ok: false };
    if (start < 0 || start >= size) return { ok: false };
    end = Math.min(end, size - 1);
    if (end < start) return { ok: false };
  }
  return { ok: true, start, end };
}

export async function serveMusicStream(
  home: string,
  incoming: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  const method = incoming.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    throw new MusicMediaError(405, 'Method not allowed');
  }
  const match = STREAM_PATH_RE.exec(url.pathname);
  if (!match) {
    throw new MusicMediaError(404, 'Not found');
  }
  const trackId = match[1]!.toLowerCase();
  const ext = match[2]!.toLowerCase();
  if (!Object.hasOwn(AUDIO_MIME_BY_EXT, ext)) {
    throw new MusicMediaError(404, 'Not found');
  }

  const rawExp = url.searchParams.get('exp') ?? '';
  const rawSig = url.searchParams.get('sig') ?? '';
  const expSec = /^\d+$/.test(rawExp) ? Number(rawExp) : NaN;
  const secret = await readMusicStreamSecret(home);
  if (!secret || !verifyMusicStreamToken(secret, trackId, expSec, rawSig)) {
    throw new MusicMediaError(403, 'Invalid or expired music stream token');
  }

  const resolved = await resolveMusicStreamFile(home, trackId, ext);
  if (!resolved) {
    throw new MusicMediaError(404, 'Track not found');
  }

  const { filePath, mime, size } = resolved;
  response.socket?.setTimeout(0);

  const rangeHeader = typeof incoming.headers.range === 'string' ? incoming.headers.range : undefined;
  let status = 200;
  let start = 0;
  let end = size > 0 ? size - 1 : 0;

  if (rangeHeader !== undefined) {
    const parsedRange = parseByteRange(rangeHeader, size);
    if (!parsedRange.ok) {
      response.writeHead(416, {
        'content-range': `bytes */${size}`,
        'accept-ranges': 'bytes',
        'content-length': '0',
        'cache-control': 'private, max-age=300',
      });
      response.end();
      return;
    }
    status = 206;
    start = parsedRange.start;
    end = parsedRange.end;
  }

  const contentLength = size === 0 ? 0 : end - start + 1;
  const headers: Record<string, string> = {
    'content-type': mime,
    'content-length': String(contentLength),
    'accept-ranges': 'bytes',
    'content-disposition': 'inline',
    'cache-control': 'private, max-age=300',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
  };
  if (status === 206) {
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
  }

  response.writeHead(status, headers);
  if (method === 'HEAD' || contentLength === 0) {
    response.end();
    return;
  }

  await new Promise<void>((resolveStream, rejectStream) => {
    const stream = createReadStream(filePath, { start, end });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      response.off('close', onClose);
      response.off('finish', onFinish);
      stream.off('error', onError);
      if (err) {
        stream.destroy();
        rejectStream(err);
      } else {
        resolveStream();
      }
    };
    const onClose = () => {
      stream.destroy();
      finish();
    };
    const onFinish = () => finish();
    const onError = (err: Error) => {
      if (!response.headersSent) {
        finish(new MusicMediaError(404, 'Unable to read audio file'));
        return;
      }
      response.destroy(err);
      finish();
    };
    response.once('close', onClose);
    response.once('finish', onFinish);
    stream.once('error', onError);
    stream.pipe(response);
  });
}

function sanitizeUploadFilename(rawHeader: string | string[] | undefined): { filename: string; ext: string } {
  const rawValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    throw new MusicMediaError(400, 'Missing x-music-filename header');
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawValue.trim());
  } catch {
    throw new MusicMediaError(400, 'Malformed x-music-filename header');
  }
  const normalizedBase = basename(decoded.replace(/\\/g, '/'))
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!normalizedBase) {
    throw new MusicMediaError(400, 'Invalid music filename');
  }
  const ext = extname(normalizedBase).toLowerCase();
  if (!Object.hasOwn(AUDIO_MIME_BY_EXT, ext)) {
    throw new MusicMediaError(400, `Unsupported audio extension "${ext || '(none)'}"`);
  }
  const stemMax = Math.max(1, 180 - ext.length);
  const rawStem = normalizedBase.slice(0, normalizedBase.length - ext.length).trim() || 'track';
  const stem = rawStem.slice(0, stemMax).trim() || 'track';
  return { filename: `${stem}${ext}`, ext };
}

function sanitizeUploadFolder(rawHeader: string | string[] | undefined): string {
  const rawValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof rawValue !== 'string' || !rawValue.trim()) return 'uploads';
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawValue.trim());
  } catch {
    throw new MusicMediaError(400, 'Malformed x-music-folder header');
  }
  if (decoded === '.' || decoded === '..' || !FOLDER_NAME_RE.test(decoded)) {
    throw new MusicMediaError(400, 'Invalid x-music-folder name');
  }
  return decoded;
}

async function pickNonCollidingTarget(dirReal: string, filename: string, ext: string): Promise<string> {
  const stem = filename.slice(0, filename.length - ext.length);
  for (let i = 1; i <= 500; i += 1) {
    const candidateName = i === 1 ? filename : `${stem} (${i})${ext}`;
    const candidatePath = join(dirReal, candidateName);
    if (!existsSync(candidatePath)) return candidatePath;
  }
  return join(dirReal, `${stem}-${randomUUID().slice(0, 8)}${ext}`);
}

export async function handleMusicUpload(
  home: string,
  incoming: IncomingMessage,
): Promise<{ filePath: string; relPath: string; filename: string; sizeBytes: number }> {
  const declaredRaw = incoming.headers['content-length'];
  if (declaredRaw !== undefined) {
    const declared = Number(declaredRaw);
    if (!Number.isFinite(declared) || declared < 0) {
      throw new MusicMediaError(400, 'Invalid Content-Length');
    }
    if (declared > MAX_MUSIC_UPLOAD_BYTES) {
      throw new MusicMediaError(413, `Audio upload exceeds ${Math.round(MAX_MUSIC_UPLOAD_BYTES / (1024 * 1024))} MiB limit`);
    }
  }

  const { filename, ext } = sanitizeUploadFilename(incoming.headers['x-music-filename']);
  const folder = sanitizeUploadFolder(incoming.headers['x-music-folder']);
  const musicDir = await resolveConfiguredMusicDir(home);
  await mkdir(musicDir, { recursive: true });
  const targetDir = join(musicDir, folder);
  await mkdir(targetDir, { recursive: true });

  const [musicDirReal, targetDirReal] = await Promise.all([realpath(musicDir), realpath(targetDir)]);
  if (!isPathInside(musicDirReal, targetDirReal)) {
    throw new MusicMediaError(403, 'Upload target resolves outside music directory');
  }

  const tmpPath = join(targetDirReal, `.upload-${randomUUID()}.tmp`);
  let received = 0;

  try {
    await new Promise<void>((resolveWrite, rejectWrite) => {
      const ws = createWriteStream(tmpPath, { flags: 'wx', mode: 0o644 });
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        incoming.off('data', onData);
        incoming.off('end', onEnd);
        incoming.off('error', onInError);
        incoming.off('aborted', onAborted);
        ws.off('error', onOutError);
        ws.destroy();
        rejectWrite(err);
      };
      const timer = setTimeout(() => {
        incoming.pause();
        fail(new MusicMediaError(408, 'Audio upload timed out'));
      }, UPLOAD_TIMEOUT_MS);
      timer.unref?.();

      const onData = (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_MUSIC_UPLOAD_BYTES) {
          incoming.pause();
          fail(new MusicMediaError(413, `Audio upload exceeds ${Math.round(MAX_MUSIC_UPLOAD_BYTES / (1024 * 1024))} MiB limit`));
          return;
        }
        if (!ws.write(chunk)) {
          incoming.pause();
          ws.once('drain', () => {
            if (!settled) incoming.resume();
          });
        }
      };
      const onEnd = () => {
        ws.end(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          incoming.off('data', onData);
          incoming.off('error', onInError);
          incoming.off('aborted', onAborted);
          ws.off('error', onOutError);
          resolveWrite();
        });
      };
      const onAborted = () => fail(new MusicMediaError(400, 'Upload aborted before completion'));
      const onInError = (err: Error) => fail(new MusicMediaError(400, err.message));
      const onOutError = (err: Error) => fail(new MusicMediaError(500, err.message));

      incoming.on('data', onData);
      incoming.once('end', onEnd);
      incoming.once('aborted', onAborted);
      incoming.once('error', onInError);
      ws.once('error', onOutError);
    });

    if (received === 0) {
      throw new MusicMediaError(400, 'Uploaded audio file is empty');
    }

    const finalPath = await pickNonCollidingTarget(targetDirReal, filename, ext);
    if (!isPathInside(musicDirReal, resolve(finalPath))) {
      throw new MusicMediaError(403, 'Final upload path escapes music directory');
    }
    await rename(tmpPath, finalPath);
    return {
      filePath: finalPath,
      relPath: relative(musicDirReal, finalPath).split(sep).join('/'),
      filename: basename(finalPath),
      sizeBytes: received,
    };
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export interface MusicCookiesSummary {
  configured: boolean;
  cookieCount: number;
  updatedAt: number | null;
  hasYouTube: boolean;
  hasYouTubeAuth: boolean;
  hasBilibili: boolean;
  hasBilibiliAuth: boolean;
  domains: string[];
  warning?: string;
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

function isPriorityCookieDomain(domain: string): number {
  if (domain === 'youtube.com' || domain.endsWith('.youtube.com') || domain === 'youtu.be') return 0;
  if (domain === 'bilibili.com' || domain.endsWith('.bilibili.com')) return 1;
  if (domain === 'soundcloud.com' || domain.endsWith('.soundcloud.com')) return 2;
  if (domain === 'google.com' || domain.endsWith('.google.com')) return 3;
  return 4;
}

export function normalizeAndInspectNetscapeCookies(rawText: string): {
  normalizedText: string;
  summary: Omit<MusicCookiesSummary, 'configured' | 'updatedAt'>;
} {
  const cleaned = String(rawText ?? '').replace(/^\uFEFF/, '');
  if (cleaned.includes('\0')) {
    throw new MusicMediaError(400, 'cookies.txt 不能包含二进制空字节');
  }

  const lines = cleaned.split(/\r?\n/);
  const seenDomains = new Set<string>();
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
    const domain = (cols[0] ?? '').trim().replace(/^\.+/, '').toLowerCase();
    const name = (cols[5] ?? '').trim();
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

  if (cookieCount === 0) {
    throw new MusicMediaError(400, '未识别到有效的 Netscape cookies.txt 条目，请使用浏览器扩展导出 Netscape 格式');
  }

  if (hasYouTube && !hasYouTubeAuth && !hasBilibili) {
    throw new MusicMediaError(
      400,
      '检测到该 cookies.txt 仅包含 YouTube 访客 Cookie，缺少账号登录态（常见于未登录浏览器或命令行导出失败）。请先在浏览器登录 YouTube，再使用「Get cookies.txt LOCALLY」等扩展导出 Netscape 格式后重新导入。',
    );
  }

  const domains = [...seenDomains]
    .sort((a, b) => isPriorityCookieDomain(a) - isPriorityCookieDomain(b))
    .slice(0, 6);

  let normalizedText = cleaned.replace(/\r\n/g, '\n');
  if (!hasHeader) {
    normalizedText = `# Netscape HTTP Cookie File\n${normalizedText}`;
  }
  if (!normalizedText.endsWith('\n')) {
    normalizedText += '\n';
  }

  const warning = hasYouTube && !hasYouTubeAuth
    ? '当前 cookies.txt 中的 YouTube Cookie 缺少登录态，无法通过 YouTube 下载校验'
    : undefined;

  return {
    normalizedText,
    summary: {
      cookieCount,
      hasYouTube,
      hasYouTubeAuth,
      hasBilibili,
      hasBilibiliAuth,
      domains,
      ...(warning ? { warning } : {}),
    },
  };
}

export async function handleMusicCookiesUpload(
  home: string,
  incoming: IncomingMessage,
): Promise<MusicCookiesSummary> {
  const declaredRaw = incoming.headers['content-length'];
  if (declaredRaw !== undefined) {
    const declared = Number(declaredRaw);
    if (!Number.isFinite(declared) || declared < 0) {
      throw new MusicMediaError(400, 'Invalid Content-Length');
    }
    if (declared > MAX_MUSIC_COOKIES_BYTES) {
      throw new MusicMediaError(413, `cookies.txt 超过 ${Math.round(MAX_MUSIC_COOKIES_BYTES / (1024 * 1024))} MiB 限制`);
    }
  }

  const rawBuf = await new Promise<Buffer>((resolveBuf, rejectBuf) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      incoming.off('data', onData);
      incoming.off('end', onEnd);
      incoming.off('error', onError);
      incoming.off('aborted', onAborted);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectBuf(err);
    };
    const timer = setTimeout(() => {
      incoming.pause();
      fail(new MusicMediaError(408, 'cookies.txt 上传超时'));
    }, COOKIES_UPLOAD_TIMEOUT_MS);
    timer.unref?.();

    const onData = (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_MUSIC_COOKIES_BYTES) {
        incoming.pause();
        fail(new MusicMediaError(413, `cookies.txt 超过 ${Math.round(MAX_MUSIC_COOKIES_BYTES / (1024 * 1024))} MiB 限制`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveBuf(Buffer.concat(chunks));
    };
    const onAborted = () => fail(new MusicMediaError(400, 'cookies.txt 上传被中断'));
    const onError = (err: Error) => fail(new MusicMediaError(400, err.message));

    incoming.on('data', onData);
    incoming.once('end', onEnd);
    incoming.once('aborted', onAborted);
    incoming.once('error', onError);
  });

  if (rawBuf.length === 0) {
    throw new MusicMediaError(400, 'cookies.txt 内容不能为空');
  }

  const { normalizedText, summary } = normalizeAndInspectNetscapeCookies(rawBuf.toString('utf8'));
  const dataDir = resolvePluginDataDir(home, 'music');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700).catch(() => {});

  const finalPath = join(dataDir, 'cookies.txt');
  const tmpPath = join(dataDir, `.cookies-${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, normalizedText, { encoding: 'utf8', mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, finalPath);
    await chmod(finalPath, 0o600);
    return {
      configured: true,
      ...summary,
      updatedAt: Date.now(),
    };
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

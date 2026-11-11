import { createDecipheriv, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, lstat } from 'node:fs/promises';
import { extname, join } from 'node:path';

export interface ReceivedAttachment {
  kind: 'image' | 'file'; name: string; status: 'ready' | 'failed';
  path?: string; mimeType?: string; bytes?: number; error?: string;
}
export const MEDIA_LIMIT = 16 * 1024 * 1024;
export function decryptMedia(bytes: Buffer, encodedKey: string): Buffer {
  const trimmedKey = encodedKey.trim();
  let key = /^[a-f\d]{32}$/i.test(trimmedKey)
    ? Buffer.from(trimmedKey, 'hex')
    : Buffer.from(trimmedKey, 'base64');
  if (key.length === 32 && /^[a-f\d]{32}$/i.test(key.toString())) key = Buffer.from(key.toString(), 'hex');
  if (key.length !== 16) throw new Error('Invalid media key');
  const cipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}
export function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return undefined;
}
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
function safeExtension(kind: 'image' | 'file', rawName: string, mimeType?: string): string {
  if (kind === 'image' && mimeType && MIME_EXT[mimeType]) return MIME_EXT[mimeType];
  const ext = extname(rawName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}
export function mediaUrl(media: Record<string, unknown>): URL {
  const url = typeof media.full_url === 'string' ? new URL(media.full_url)
    : new URL(`https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(String(media.encrypt_query_param ?? ''))}`);
  if (url.protocol !== 'https:' || url.hostname !== 'novac2c.cdn.weixin.qq.com' || url.port || url.username || url.password || !url.pathname.startsWith('/c2c/')) throw new Error('Untrusted CDN');
  return url;
}
export async function receiveMedia(root: string, item: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<ReceivedAttachment> {
  const kind = Number(item.type) === 2 ? 'image' : 'file';
  const detail = (kind === 'image' ? item.image_item : item.file_item) as Record<string, unknown> | undefined;
  const name = String(detail?.file_name ?? (kind === 'image' ? 'image' : 'file')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255);
  const result: ReceivedAttachment = { kind, name, status: 'failed' };
  try {
    const media = detail?.media as Record<string, unknown> | undefined;
    if (!media) throw new Error('Missing media');
    const url = mediaUrl(media);
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok || !response.body) throw new Error('Download failed');
    const reader = response.body.getReader();
    const chunks: Buffer[] = []; let size = 0;
    try {
      if (Number(response.headers.get('content-length')) > MEDIA_LIMIT + 16) throw new Error('Too large');
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength; if (size > MEDIA_LIMIT + 16) throw new Error('Too large');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    const hex = detail?.aeskey;
    const encodedKey = typeof hex === 'string' && /^[a-f\d]{32}$/i.test(hex) ? Buffer.from(hex, 'hex').toString('base64') : String(media.aes_key ?? '');
    const bytes = decryptMedia(Buffer.concat(chunks), encodedKey);
    if (bytes.length > MEDIA_LIMIT) throw new Error('Too large');
    const mimeType = kind === 'image' ? imageMime(bytes) : undefined;
    if (kind === 'image' && !mimeType) throw new Error('Unsupported image');
    await mkdir(root, { recursive: true, mode: 0o700 });
    let stat = await lstat(root);
    if (stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077)) {
      await chmod(root, 0o700).catch(() => {});
      stat = await lstat(root);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('Unsafe media directory');
    const path = join(root, `${randomUUID()}${safeExtension(kind, name, mimeType)}`);
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); } finally { await file.close(); }
    return { ...result, status: 'ready', path, mimeType, bytes: bytes.length };
  } catch { return { ...result, error: '附件接收失败（下载、大小、安全校验或解密失败）；请重新发送。' }; }
}

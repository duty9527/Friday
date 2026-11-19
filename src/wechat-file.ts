import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { BotExpression } from './web/shared/bot-expressions.js';
import {
  buildWechatBaseInfo,
  DEFAULT_WECHAT_CDN_ORIGIN,
  parseWeixinApiJson,
  validateWechatCdnOrigin,
  validateWechatCdnUrl,
} from './wechat/protocol.js';

// Local memory policy, not an upstream file-size limit. Transfers serialize process-wide.
export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
let globalDeliveryQueue: Promise<void> = Promise.resolve();

const IMAGE_OUTBOUND_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const VIDEO_OUTBOUND_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);

/** Check whether `buf` begins with a supported raster image header (JPEG, PNG, GIF, WebP, BMP). */
export function isValidWechatImageBuffer(buf: Buffer): boolean {
  if (buf.length < 2) return false;
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true; // BMP
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (
    buf.length >= 8
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return true; // PNG
  if (buf.length >= 6) {
    const hdr6 = buf.subarray(0, 6).toString('ascii');
    if (hdr6 === 'GIF87a' || hdr6 === 'GIF89a') return true;
  }
  if (
    buf.length >= 12
    && buf.subarray(0, 4).toString('ascii') === 'RIFF'
    && buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) return true;
  return false;
}

const ISO_BMFF_BOX_TAGS = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

/** Check whether `buf` begins with a supported video container header (MP4/MOV, MKV/WebM, AVI). */
export function isValidWechatVideoBuffer(buf: Buffer): boolean {
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return true; // MKV / WebM (EBML)
  }
  if (buf.length < 12) return false;
  const tag4 = buf.subarray(4, 8).toString('ascii');
  if (ISO_BMFF_BOX_TAGS.has(tag4)) return true; // MP4 / MOV
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'AVI ') {
    return true;
  }
  return false;
}

/** Classify a WeChat outbound attachment filename into native image, native video, or generic file. */
export function classifyWechatOutboundMedia(name: string): 'image' | 'video' | 'file' {
  const ext = extname(name).toLowerCase();
  if (IMAGE_OUTBOUND_EXTS.has(ext)) return 'image';
  if (VIDEO_OUTBOUND_EXTS.has(ext)) return 'video';
  return 'file';
}

function validateSafeFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..' || basename(trimmed) !== trimmed || /[\\/\x00-\x1f]/.test(trimmed)) {
    throw new Error('Invalid attachment name');
  }
  return trimmed;
}

/** Reads a regular, single-link file within the 1B..16MiB bounded policy. */
async function readRegularFileBounded(fullPath: string): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    if (code === 'ENOENT') throw new Error('Attachment file not found');
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_ATTACHMENT_BYTES) {
      throw new Error('Attachment must be a regular, single-link file of 1 byte to 16 MiB (local policy)');
    }
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('Attachment changed while reading');
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function readStagedAttachment(root: string, name: string): Promise<Buffer> {
  const cleanName = validateSafeFileName(name);
  const dir = await realpath(root);
  return readRegularFileBounded(join(dir, cleanName));
}

/** Resolves the bundled transparent animated GIF sticker path for a F.R.I.D.A.Y. bot expression. */
export function resolveBotStickerPath(expr: BotExpression): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return join(repoRoot, 'assets', 'stickers', `bot-${expr}.gif`);
}

function withTimeout(ms: number, parentSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(ms);
  return parentSignal ? AbortSignal.any([timeoutSignal, parentSignal]) : timeoutSignal;
}

export interface WechatMediaDeliveryBase {
  target: string;
  contextToken: string;
  contextTokenUpdatedAt?: number;
  accountId?: string;
  base: string;
  cdnBaseUrl?: string;
  headers: Record<string, string>;
  channelId?: string;
  signal?: AbortSignal;
  isBindingCurrent?: () => boolean;
}

async function deliverEncryptedWechatMedia(
  input: WechatMediaDeliveryBase,
  readPlain: () => Promise<Buffer>,
  mediaType: 1 | 2 | 3,
  buildMessageItem: (params: {
    param: string;
    aesKeyBase64: string;
    plainSize: number;
    cipherSize: number;
  }) => Record<string, unknown>,
  transport: typeof fetch = fetch,
): Promise<{ messageId?: string }> {
  const prev = globalDeliveryQueue;
  const run = prev.catch(() => {}).then(async () => {
    try {
      const plain = await readPlain();
      const key = randomBytes(16);
      const cipher = createCipheriv('aes-128-ecb', key, null);
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      const filekey = randomBytes(16).toString('hex');
      const post = async (endpoint: string, body: unknown) => {
        if (input.isBindingCurrent && !input.isBindingCurrent()) {
          throw new Error('Attachment cancelled because the WeChat binding changed');
        }
        const res = await transport(`${input.base}/ilink/bot/${endpoint}`, {
          method: 'POST',
          headers: input.headers,
          redirect: 'error',
          signal: withTimeout(30_000, input.signal),
          body: JSON.stringify({ base_info: buildWechatBaseInfo(), ...body as object }),
        });
        if (!res.ok) throw new Error(`iLink ${endpoint} HTTP ${res.status}`);
        const data = parseWeixinApiJson<Record<string, unknown>>(await res.text());
        if ((data.ret !== undefined && data.ret !== 0) || (data.errcode !== undefined && data.errcode !== 0)) {
          throw new Error(`iLink ${endpoint} business failure (ret=${typeof data.ret === 'number' ? data.ret : 'unset'}, errcode=${typeof data.errcode === 'number' ? data.errcode : 'unset'})`);
        }
        return data;
      };
      const upload = await post('getuploadurl', {
        filekey,
        media_type: mediaType,
        to_user_id: input.target,
        rawsize: plain.length,
        rawfilemd5: createHash('md5').update(plain).digest('hex'),
        filesize: encrypted.length,
        no_need_thumb: true,
        aeskey: key.toString('hex'),
      });
      const cdn = input.cdnBaseUrl?.trim()
        ? validateWechatCdnOrigin(input.cdnBaseUrl)
        : DEFAULT_WECHAT_CDN_ORIGIN;
      let url: URL;
      try {
        const rawUrl = typeof upload.upload_full_url === 'string' && upload.upload_full_url.trim()
          ? upload.upload_full_url.trim()
          : `${cdn}/c2c/upload?encrypted_query_param=${encodeURIComponent(String(upload.upload_param ?? ''))}&filekey=${filekey}`;
        if (!upload.upload_full_url && !upload.upload_param) {
          throw new Error('Invalid CDN destination');
        }
        url = validateWechatCdnUrl(rawUrl);
        if (url.origin !== cdn) {
          throw new Error('Invalid CDN destination');
        }
      } catch {
        throw new Error('Invalid CDN destination');
      }
      const res = await transport(url, {
        method: 'POST',
        redirect: 'error',
        signal: withTimeout(60_000, input.signal),
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(encrypted.buffer as ArrayBuffer, encrypted.byteOffset, encrypted.byteLength),
      });
      const param = res.headers.get('x-encrypted-param');
      if (res.status !== 200) throw new Error(`CDN upload HTTP ${res.status}`);
      if (!param) throw new Error('CDN upload missing x-encrypted-param');
      const sent = await post('sendmessage', {
        msg: {
          from_user_id: input.accountId ?? '',
          to_user_id: input.target,
          client_id: `friday-${randomUUID()}`,
          message_type: 2,
          message_state: 2,
          context_token: input.contextToken,
          item_list: [buildMessageItem({
            param,
            aesKeyBase64: Buffer.from(key.toString('hex')).toString('base64'),
            plainSize: plain.length,
            cipherSize: encrypted.length,
          })],
        },
      });
      const rawMsgId = sent.message_id ?? sent.msg_id;
      const messageId = typeof rawMsgId === 'string'
        ? rawMsgId.trim() || undefined
        : typeof rawMsgId === 'number' && Number.isFinite(rawMsgId)
          ? String(rawMsgId)
          : undefined;
      return { ...(messageId ? { messageId } : {}) };
    } catch (error) {
      // Only locally constructed diagnostics may cross the tool boundary; fetch errors can contain signed URLs.
      const message = error instanceof Error ? error.message : '';
      const detail = /^(?:iLink (?:getuploadurl|sendmessage) (?:HTTP \d{3}|business failure \(ret=(?:-?\d+|unset), errcode=(?:-?\d+|unset)\))|CDN upload (?:HTTP \d{3}|missing x-encrypted-param)|Invalid CDN destination|Attachment .+|Invalid attachment name)$/.test(message)
        ? message
        : error instanceof Error && error.name === 'TimeoutError'
          ? 'transport timeout'
          : 'local read or transport failure';
      console.warn(`[wechat-file] delivery failed (mediaType=${mediaType}): ${detail}`);
      if (/^iLink (?:getuploadurl|sendmessage) business failure \(ret=-2\b/.test(detail)) {
        const ageMin = typeof input.contextTokenUpdatedAt === 'number' && Number.isFinite(input.contextTokenUpdatedAt) && input.contextTokenUpdatedAt > 0
          ? Math.max(0, Math.round((Date.now() - input.contextTokenUpdatedAt) / 60_000))
          : undefined;
        const ageHint = ageMin !== undefined ? ` after ${ageMin}m without inbound WeChat message` : '';
        throw Object.assign(
          new Error(`Attachment delivery failed (${detail}; WeChat reply session expired${ageHint} — ask user to send a message on WeChat to refresh session before retrying); no automatic retry`),
          { sessionWindowExpired: true },
        );
      }
      throw new Error(`Attachment delivery failed (${detail}); no automatic retry`);
    }
  });
  globalDeliveryQueue = run.then(() => {}, () => {});
  return run;
}

export async function deliverWechatFile(
  input: WechatMediaDeliveryBase & { root: string; name: string },
  transport: typeof fetch = fetch,
): Promise<{ messageId?: string }> {
  return deliverEncryptedWechatMedia(
    input,
    () => readStagedAttachment(input.root, input.name),
    3,
    ({ param, aesKeyBase64, plainSize }) => ({
      type: 4,
      file_item: {
        media: { encrypt_query_param: param, aes_key: aesKeyBase64, encrypt_type: 1 },
        file_name: input.name,
        len: String(plainSize),
      },
    }),
    transport,
  );
}

/**
 * Encrypts and delivers an image/GIF sticker (`media_type: 1`, `type: 2 image_item`) via WeChat iLink CDN.
 */
export async function deliverWechatImage(
  input: WechatMediaDeliveryBase & { filePath: string },
  transport: typeof fetch = fetch,
): Promise<{ messageId?: string }> {
  return deliverEncryptedWechatMedia(
    input,
    async () => readRegularFileBounded(await realpath(input.filePath)),
    1,
    ({ param, aesKeyBase64, cipherSize }) => ({
      type: 2,
      image_item: {
        media: { encrypt_query_param: param, aes_key: aesKeyBase64, encrypt_type: 1 },
        mid_size: cipherSize,
      },
    }),
    transport,
  );
}

/**
 * Encrypts and delivers a video (`media_type: 2`, `type: 5 video_item`) via WeChat iLink CDN.
 */
export async function deliverWechatVideo(
  input: WechatMediaDeliveryBase & { filePath?: string; readPlain?: () => Promise<Buffer> },
  transport: typeof fetch = fetch,
): Promise<{ messageId?: string }> {
  const reader = input.readPlain
    ?? (async () => {
      if (!input.filePath) throw new Error('Invalid attachment name');
      return readRegularFileBounded(await realpath(input.filePath));
    });
  return deliverEncryptedWechatMedia(
    input,
    reader,
    2,
    ({ param, aesKeyBase64, cipherSize }) => ({
      type: 5,
      video_item: {
        media: { encrypt_query_param: param, aes_key: aesKeyBase64, encrypt_type: 1 },
        video_size: cipherSize,
      },
    }),
    transport,
  );
}

/**
 * Reads a staged file under `root` and delivers it via WeChat iLink CDN as native image,
 * native video, or generic file according to its filename extension.
 */
export async function deliverWechatStagedMedia(
  input: WechatMediaDeliveryBase & { root: string; name: string },
  transport: typeof fetch = fetch,
): Promise<{ messageId?: string }> {
  const kind = classifyWechatOutboundMedia(input.name);
  if (kind === 'image') {
    return deliverEncryptedWechatMedia(
      input,
      async () => {
        const buf = await readStagedAttachment(input.root, input.name);
        if (!isValidWechatImageBuffer(buf)) {
          throw new Error('Attachment image content is invalid (not a valid JPEG/PNG/GIF/WebP/BMP file)');
        }
        return buf;
      },
      1,
      ({ param, aesKeyBase64, cipherSize }) => ({
        type: 2,
        image_item: {
          media: { encrypt_query_param: param, aes_key: aesKeyBase64, encrypt_type: 1 },
          mid_size: cipherSize,
        },
      }),
      transport,
    );
  }
  if (kind === 'video') {
    return deliverWechatVideo(
      {
        ...input,
        readPlain: async () => {
          const buf = await readStagedAttachment(input.root, input.name);
          if (!isValidWechatVideoBuffer(buf)) {
            throw new Error('Attachment video content is invalid (not a valid MP4/MOV/MKV/WebM/AVI file)');
          }
          return buf;
        },
      },
      transport,
    );
  }
  return deliverWechatFile(input, transport);
}

/**
 * Encrypts and delivers an in-memory UTF-8/binary buffer (e.g., extracted long code snippet)
 * as a WeChat `type: 4 file_item` attachment.
 */
export async function deliverWechatBufferAsFile(
  input: WechatMediaDeliveryBase & { name: string; content: Buffer },
  transport: typeof fetch = fetch,
): Promise<{ messageId?: string }> {
  const cleanName = validateSafeFileName(input.name);
  return deliverEncryptedWechatMedia(
    input,
    async () => {
      if (input.content.length < 1 || input.content.length > MAX_ATTACHMENT_BYTES) {
        throw new Error('Attachment must be a regular, single-link file of 1 byte to 16 MiB (local policy)');
      }
      return input.content;
    },
    3,
    ({ param, aesKeyBase64, plainSize }) => ({
      type: 4,
      file_item: {
        media: { encrypt_query_param: param, aes_key: aesKeyBase64, encrypt_type: 1 },
        file_name: cleanName,
        len: String(plainSize),
      },
    }),
    transport,
  );
}

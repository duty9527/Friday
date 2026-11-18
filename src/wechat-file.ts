import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { BotExpression } from './web/shared/bot-expressions.js';

// Local memory policy, not an upstream file-size limit. Transfers serialize process-wide.
export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
let globalDeliveryQueue: Promise<void> = Promise.resolve();

/** Reads a regular, single-link file within the 1B..16MiB bounded policy. */
async function readRegularFileBounded(fullPath: string): Promise<Buffer> {
  const handle = await open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
  if (!name || name === '.' || name === '..' || basename(name) !== name || /[\\/\x00-\x1f]/.test(name)) {
    throw new Error('Invalid attachment name');
  }
  const dir = await realpath(root);
  return readRegularFileBounded(join(dir, name));
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

interface WechatMediaDeliveryBase {
  target: string;
  contextToken: string;
  contextTokenUpdatedAt?: number;
  accountId?: string;
  base: string;
  headers: Record<string, string>;
  channelId?: string;
  signal?: AbortSignal;
}

async function deliverEncryptedWechatMedia(
  input: WechatMediaDeliveryBase,
  readPlain: () => Promise<Buffer>,
  mediaType: 1 | 3,
  buildMessageItem: (params: {
    param: string;
    aesKeyBase64: string;
    plainSize: number;
    cipherSize: number;
  }) => Record<string, unknown>,
  transport: typeof fetch = fetch,
): Promise<void> {
  const prev = globalDeliveryQueue;
  const run = prev.catch(() => {}).then(async () => {
    try {
      const plain = await readPlain();
      const key = randomBytes(16);
      const cipher = createCipheriv('aes-128-ecb', key, null);
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      const filekey = randomBytes(16).toString('hex');
      const post = async (endpoint: string, body: unknown) => {
        const res = await transport(`${input.base}/ilink/bot/${endpoint}`, {
          method: 'POST',
          headers: input.headers,
          redirect: 'error',
          signal: withTimeout(30_000, input.signal),
          body: JSON.stringify({ base_info: { channel_version: '1.0.2' }, ...body as object }),
        });
        if (!res.ok) throw new Error(`iLink ${endpoint} HTTP ${res.status}`);
        const data = await res.json() as Record<string, unknown>;
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
      const cdn = 'https://novac2c.cdn.weixin.qq.com';
      const url = typeof upload.upload_full_url === 'string' && upload.upload_full_url.trim()
        ? new URL(upload.upload_full_url.trim())
        : new URL(`${cdn}/c2c/upload?encrypted_query_param=${encodeURIComponent(String(upload.upload_param ?? ''))}&filekey=${filekey}`);
      if ((!upload.upload_full_url && !upload.upload_param) || url.origin !== cdn || url.username || url.password) {
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
      await post('sendmessage', {
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
    } catch (error) {
      // Only locally constructed diagnostics may cross the tool boundary; fetch errors can contain signed URLs.
      const message = error instanceof Error ? error.message : '';
      const detail = /^(?:iLink (?:getuploadurl|sendmessage) (?:HTTP \d{3}|business failure \(ret=(?:-?\d+|unset), errcode=(?:-?\d+|unset)\))|CDN upload (?:HTTP \d{3}|missing x-encrypted-param)|Invalid CDN destination|Attachment .+|Invalid attachment name)$/.test(message)
        ? message
        : error instanceof Error && error.name === 'TimeoutError'
          ? 'transport timeout'
          : 'local read or transport failure';
      if (/^iLink sendmessage business failure \(ret=-2\b/.test(detail)) {
        const ageMin = typeof input.contextTokenUpdatedAt === 'number' && Number.isFinite(input.contextTokenUpdatedAt) && input.contextTokenUpdatedAt > 0
          ? Math.max(0, Math.round((Date.now() - input.contextTokenUpdatedAt) / 60_000))
          : undefined;
        const ageHint = ageMin !== undefined ? ` after ${ageMin}m without inbound WeChat message` : '';
        throw new Error(`Attachment delivery failed (${detail}; WeChat reply session expired${ageHint} — ask user to send a message on WeChat to refresh session before retrying); no automatic retry`);
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
): Promise<void> {
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
): Promise<void> {
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

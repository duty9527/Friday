import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

// Local memory policy, not an upstream file-size limit. Transfers serialize through a queue.
export const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
let deliveryQueue: Promise<void> = Promise.resolve();
export async function readStagedAttachment(root: string, name: string): Promise<Buffer> {
  if (!name || name === '.' || name === '..' || basename(name) !== name || /[\\/\x00-\x1f]/.test(name)) throw new Error('Invalid attachment name');
  const dir = await realpath(root);
  const handle = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_ATTACHMENT_BYTES) throw new Error('Attachment must be a regular, single-link file of 1 byte to 16 MiB (local policy)');
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('Attachment changed while reading');
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

export async function deliverWechatFile(input: {
  root: string; name: string; target: string; contextToken: string; accountId?: string;
  base: string; headers: Record<string, string>;
}, transport: typeof fetch = fetch): Promise<void> {
  const run = deliveryQueue.then(async () => {
    try {
      const plain = await readStagedAttachment(input.root, input.name);
      const key = randomBytes(16);
      const cipher = createCipheriv('aes-128-ecb', key, null);
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      const filekey = randomBytes(16).toString('hex');
      const post = async (endpoint: string, body: unknown) => {
        const res = await transport(`${input.base}/ilink/bot/${endpoint}`, {
          method: 'POST', headers: input.headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
          body: JSON.stringify({ base_info: { channel_version: '1.0.2' }, ...body as object }),
        });
        if (!res.ok) throw new Error(`iLink ${endpoint} HTTP ${res.status}`);
        const data = await res.json() as Record<string, unknown>;
        if ((data.ret !== undefined && data.ret !== 0) || (data.errcode !== undefined && data.errcode !== 0)) throw new Error(`iLink ${endpoint} business failure (ret=${typeof data.ret === 'number' ? data.ret : 'unset'}, errcode=${typeof data.errcode === 'number' ? data.errcode : 'unset'})`);
        return data;
      };
      const upload = await post('getuploadurl', {
        filekey, media_type: 3, to_user_id: input.target, rawsize: plain.length,
        rawfilemd5: createHash('md5').update(plain).digest('hex'), filesize: encrypted.length,
        no_need_thumb: true, aeskey: key.toString('hex'),
      });
      const cdn = 'https://novac2c.cdn.weixin.qq.com';
      const url = typeof upload.upload_full_url === 'string' && upload.upload_full_url.trim()
        ? new URL(upload.upload_full_url.trim())
        : new URL(`${cdn}/c2c/upload?encrypted_query_param=${encodeURIComponent(String(upload.upload_param ?? ''))}&filekey=${filekey}`);
      if ((!upload.upload_full_url && !upload.upload_param) || url.origin !== cdn || url.username || url.password) throw new Error('Invalid CDN destination');
      const res = await transport(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000), headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(encrypted) });
      const param = res.headers.get('x-encrypted-param');
      if (res.status !== 200) throw new Error(`CDN upload HTTP ${res.status}`);
      if (!param) throw new Error('CDN upload missing x-encrypted-param');
      await post('sendmessage', { msg: {
        from_user_id: input.accountId ?? '', to_user_id: input.target,
        client_id: `friday-${randomUUID()}`, message_type: 2, message_state: 2,
        context_token: input.contextToken, item_list: [{ type: 4, file_item: {
          media: { encrypt_query_param: param, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 },
          file_name: input.name, len: String(plain.length),
        } }],
      } });
    } catch (error) {
      // Only locally constructed diagnostics may cross the tool boundary; fetch errors can contain signed URLs.
      const message = error instanceof Error ? error.message : '';
      const detail = /^(?:iLink (?:getuploadurl|sendmessage) (?:HTTP \d{3}|business failure \(ret=(?:-?\d+|unset), errcode=(?:-?\d+|unset)\))|CDN upload (?:HTTP \d{3}|missing x-encrypted-param)|Invalid CDN destination|Attachment .+|Invalid attachment name)$/.test(message)
        ? message : error instanceof Error && error.name === 'TimeoutError' ? 'transport timeout' : 'local read or transport failure';
      throw new Error(`Attachment delivery failed (${detail}); no automatic retry`);
    }
  });
  deliveryQueue = run.then(() => {}, () => {});
  return run;
}

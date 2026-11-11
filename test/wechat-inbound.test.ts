import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { chmod, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptMedia, receiveMedia, mediaUrl, MEDIA_LIMIT } from '../src/wechat-inbound.js';
import { messageImages } from '../src/message-images.js';
import { Store } from '../src/store.js';
import { ImGateway } from '../src/im.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=', 'base64');
const key = Buffer.alloc(16, 7);
function encrypt(bytes: Buffer) { const c = createCipheriv('aes-128-ecb', key, null); return Buffer.concat([c.update(bytes), c.final()]); }
function item(type = 2) { return { type, [type === 2 ? 'image_item' : 'file_item']: { file_name: '../../original.txt', media: { aes_key: key.toString('base64'), encrypt_query_param: 'mock' } } }; }
test('AES formats, safe CDN, real image blocks, random filenames and durable message association', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-inbound-'));
  let store = new Store(home);
  try {
    for (const encoded of [key.toString('base64'), Buffer.from(key.toString('hex')).toString('base64'), key.toString('hex')]) assert.deepEqual(decryptMedia(encrypt(png), encoded), png);
    for (const url of ['http://novac2c.cdn.weixin.qq.com/c2c/x', 'https://127.0.0.1/c2c/x', 'https://evil.test/c2c/x', 'https://novac2c.cdn.weixin.qq.com.evil.test/c2c/x']) assert.throws(() => mediaUrl({ full_url: url }));
    const mediaDir = join(home, 'inbound-media');
    const attachment = await receiveMedia(mediaDir, item(), (async (_url, opts) => { assert.equal(opts?.redirect, 'error'); return new Response(encrypt(png)); }) as typeof fetch);
    assert.equal(attachment.status, 'ready'); assert.equal(attachment.name, '../../original.txt');
    assert.equal(attachment.path?.includes('original'), false);
    assert.ok(attachment.path?.endsWith('.png'), 'image preserves safe extension from detected MIME type');
    assert.deepEqual(await readFile(attachment.path!), png);
    await chmod(mediaDir, 0o755);
    const fileAttachment = await receiveMedia(mediaDir, item(4), (async () => new Response(encrypt(Buffer.from('untrusted file contents')))) as typeof fetch);
    assert.equal(fileAttachment.status, 'ready'); assert.equal(fileAttachment.kind, 'file');
    assert.ok(fileAttachment.path?.endsWith('.txt'), 'file preserves sanitized extension');
    assert.equal(await readFile(fileAttachment.path!, 'utf8'), 'untrusted file contents');
    const origin = { channel: 'wechat' as const, channelId: 'wx', conversationId: 'A', senderId: 'A' };
    store.conversation.create({ id: 'image-message', role: 'user', text: 'mixed caption', paths: [], status: 'queued', mode: 'real', attachments: [attachment], origin });
    store.close(); store = new Store(home);
    const message = store.conversation.get('image-message'); assert.deepEqual(message.origin, origin);
    const event = JSON.stringify({ kind: 'CHAT', message });
    const vision = await messageImages(event, true); assert.equal(vision.images.length, 1); assert.equal(vision.images[0].data, png.toString('base64'));
    const textOnly = await messageImages(event, false); assert.equal(textOnly.images.length, 0); assert.match(textOnly.text, /不支持图像输入/);
    assert.equal((await messageImages(JSON.stringify({ kind: 'WORKER_REPORT', message }), true)).images.length, 0);
  } finally { store.close(); await rm(home, { recursive: true, force: true }); }
});
test('visible download/decrypt/stream-limit failures; stream cancelled', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-fail-'));
  try {
    for (const response of [new Response('bad ciphertext'), new Response('error', { status: 500 }), new Response('small', { headers: { 'content-length': String(MEDIA_LIMIT + 17) } })]) {
      const result = await receiveMedia(home, item(), (async () => response) as typeof fetch); assert.equal(result.status, 'failed'); assert.match(result.error!, /接收失败/); assert.equal(result.path, undefined);
    }
    let cancelled = false;
    const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(MEDIA_LIMIT + 17)); }, cancel() { cancelled = true; } });
    assert.equal((await receiveMedia(home, item(), (async () => new Response(stream)) as typeof fetch)).status, 'failed'); assert.equal(cancelled, true);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test('pure and mixed image parsing; unauthorized sender never downloads or loses caption', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-parse-')); const store = new Store(home);
  const oldFetch = globalThis.fetch; let fetched = 0;
  globalThis.fetch = (async () => { fetched++; throw new Error('unexpected network'); }) as typeof fetch;
  try {
    store.saveImChannel({ id: 'wx', platform: 'wechat', name: 'wx', enabled: true, notifyAll: false, allowedSenders: ['A'], inboundCount: 0, outboundCount: 0, createdAt: 0, updatedAt: 0 });
    const gateway = new ImGateway({ store } as any);
    for (const caption of ['', '这是参考形象']) {
      const inbound = (gateway as any).parseWechatIlinkMessage('wx', { from_user_id: 'B', msg_id: caption || 'pure', item_list: [item(), { type: 1, text_item: { text: caption } }] });
      assert.equal(inbound.mediaItems.length, 1); assert.ok(inbound.text); if (caption) assert.equal(inbound.text, caption);
      assert.equal((await gateway.ingestMessage(inbound)).reason, 'sender_not_allowed');
    }
    assert.equal(fetched, 0);
  } finally { globalThis.fetch = oldFetch; store.close(); await rm(home, { recursive: true, force: true }); }
});

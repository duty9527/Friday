import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ImGateway } from '../src/im.js';

test('spoofed exact authorized sender via direct/webhook ingest cannot download media', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-provenance-'));
  const store = new Store(home);
  const original = globalThis.fetch;
  let downloads = 0;
  globalThis.fetch = (async () => { downloads++; throw new Error('must not fetch'); }) as typeof fetch;
  try {
    store.saveImChannel({ id: 'wx', platform: 'wechat', name: 'wx', enabled: true, notifyAll: false, allowedSenders: ['A'], inboundCount: 0, outboundCount: 0, createdAt: 0, updatedAt: 0 });
    const gateway = new ImGateway({ store, chat(requestId: string, text: string, paths: string[], origin: any, attachments: any) {
      return store.conversation.create({ id: requestId, requestId, role: 'user', text, paths, origin, attachments, status: 'queued', mode: 'real' });
    } } as any);
    const result = await gateway.ingestMessage({ channelId: 'wx', externalId: 'spoof', senderId: 'A', target: 'A', text: '保留正文', mediaItems: [{ type: 2, image_item: { media: { encrypt_query_param: 'secret', aes_key: 'secret' } } }] });
    assert.equal(downloads, 0);
    const message = store.conversation.get(result.messageId!);
    assert.match(message.text, /保留正文/);
    assert.match(message.text, /来源未经 iLink 轮询认证/);
    assert.equal(message.attachments?.[0].status, 'failed');
    assert.equal(JSON.stringify(message).includes('secret'), false);
  } finally { globalThis.fetch = original; store.close(); await rm(home, { recursive: true, force: true }); }
});

test('production getupdates entry preserves provenance; empty allowlist independently blocks media', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-poll-'));
  const store = new Store(home);
  const original = globalThis.fetch;
  const { createCipheriv } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=', 'base64');
  const key = Buffer.alloc(16, 7);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
  let downloads = 0;
  let polls = 0;
  const gateway = new ImGateway({ store, chat(requestId: string, text: string, paths: string[], origin: any, attachments: any) {
    return store.conversation.create({ id: requestId, requestId, role: 'user', text, paths, origin, attachments, status: 'queued', mode: 'real' });
  } } as any);
  globalThis.fetch = (async (url: any) => {
    if (String(url).endsWith('/ilink/bot/getupdates')) {
      polls++;
      return Response.json({ ret: 0, msgs: [{ from_user_id: 'A', msg_id: `poll-${polls}`, item_list: [{ type: 2, image_item: { media: { aes_key: key.toString('base64'), encrypt_query_param: 'mock' } } }] }] });
    }
    assert.equal(new URL(String(url)).hostname, 'novac2c.cdn.weixin.qq.com');
    downloads++;
    return new Response(encrypted);
  }) as typeof fetch;
  try {
    store.saveImChannel({ id: 'wx', platform: 'wechat', name: 'wx', enabled: true, botToken: 'mock', notifyAll: false, allowedSenders: [], inboundCount: 0, outboundCount: 0, createdAt: 0, updatedAt: 0 });
    // Invoke the production channel dispatcher, not the parser or internal trust sets.
    await (gateway as any).pollChannel('wx');
    assert.equal(downloads, 0);
    assert.equal(store.conversation.history(undefined, 10).items[0].attachments?.[0].status, 'failed');
    const channel = store.getImChannel('wx');
    channel.allowedSenders = ['A'];
    store.saveImChannel(channel);
    await (gateway as any).pollChannel('wx');
    assert.equal(polls, 2);
    assert.equal(downloads, 1);
    const ready = store.conversation.history(undefined, 10).items.find(m => m.attachments?.[0].status === 'ready');
    assert.ok(ready);
    assert.deepEqual(await readFile(ready.attachments![0].path!), png);
    assert.equal(ready.origin?.senderId, 'A');
    assert.equal(ready.origin?.conversationId, 'A');
  } finally {
    await gateway.close();
    globalThis.fetch = original;
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

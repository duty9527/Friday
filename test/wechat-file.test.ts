import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { deliverWechatFile, readStagedAttachment, MAX_ATTACHMENT_BYTES } from '../src/wechat-file.js';
import { ImGateway } from '../src/im.js';

test('mock attachment protocol, padding/decryption and failure stages', async () => {
 const root = await mkdtemp(join(tmpdir(), 'ilink-file-'));
 try {
 for (const size of [1, 16, 31, 32]) {
  const plain = Buffer.alloc(size, 42); await writeFile(join(root, 'sample.bin'), plain);
  for (const failure of ['', 'get', 'upload', 'send', 'network']) {
   let calls = 0; let key = ''; let ciphertext: Buffer;
   const mock = (async (url: any, init: any) => {
    calls++;
    if (failure === 'network') throw new Error('secret URL');
    if (calls === 1) {
     assert.match(String(url), /getuploadurl$/); const data = JSON.parse(init.body);
     assert.equal(data.media_type, 3); assert.equal(data.rawsize, size);
     assert.equal(data.filesize, (Math.floor(size / 16) + 1) * 16);
     assert.equal(data.to_user_id, 'current'); assert.equal(data.no_need_thumb, true); key = data.aeskey;
     return Response.json(failure === 'get' ? { ret: 9 } : { ret: 0, upload_param: 'opaque' });
    }
    if (calls === 2) {
     const destination = new URL(url);
     assert.equal(destination.origin, 'https://novac2c.cdn.weixin.qq.com');
     assert.equal(destination.pathname, '/c2c/upload');
     assert.equal(destination.searchParams.get('encrypted_query_param'), 'opaque');
     assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
     assert.deepEqual(init.headers, { 'Content-Type': 'application/octet-stream' });
     ciphertext = Buffer.from(init.body); const decipher = createDecipheriv('aes-128-ecb', Buffer.from(key, 'hex'), null);
     assert.deepEqual(Buffer.concat([decipher.update(ciphertext), decipher.final()]), plain);
     return new Response(null, { status: failure === 'upload' ? 500 : 200, headers: { 'x-encrypted-param': 'download' } });
    }
    const data = JSON.parse(init.body); assert.equal(data.msg.context_token, 'context');
    const item = data.msg.item_list[0]; assert.equal(item.type, 4); assert.equal(item.file_item.len, String(size));
    assert.equal(Buffer.from(item.file_item.media.aes_key, 'base64').toString(), key);
    return Response.json({ ret: failure === 'send' ? 9 : 0 });
   }) as typeof fetch;
   const action = deliverWechatFile({ root, name: 'sample.bin', target: 'current', contextToken: 'context', base: 'https://example.invalid', headers: {} }, mock);
   if (failure) await assert.rejects(action, failure === 'upload' ? /CDN upload HTTP 500/ : failure === 'network' ? /local read or transport failure/ : /business failure/); else await action;
   assert.equal(calls, failure === 'get' || failure === 'network' ? 1 : failure === 'upload' ? 2 : 3);
  }
 }
 await symlink(join(root, 'sample.bin'), join(root, 'sym')); await link(join(root, 'sample.bin'), join(root, 'hard'));
 for (const name of ['../sample.bin', '/etc/passwd', 'a\\b', 'sym', 'hard', 'missing', '.']) await assert.rejects(readStagedAttachment(root, name));
 await writeFile(join(root, 'large'), Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
 await assert.rejects(readStagedAttachment(root, 'large'));
 } finally { await rm(root, { recursive: true, force: true }); }
});

test('attachment entry denies non-explicit senders and missing current context', async () => {
 const channel = { id: 'wx', platform: 'wechat', enabled: true, allowedSenders: [], inboundCount: 0, botToken: 'mock' };
 const gateway = new ImGateway({ store: { getImChannel: () => channel, saveImChannel: () => {} } } as any);
 // Exercise actual inbound entry without starting pollers or any network.
 const method = (gateway as any).ingestMessage;
 assert.equal(typeof method, 'function');
 const result = await method.call(gateway, { channelId: 'wx', senderId: 'remote', target: 'remote', externalId: '1', text: '/file sample.bin', contextToken: 'ctx' });
 assert.equal(result.reason, 'attachment_not_authorized');
});

test('trusted current-session entry sends only to sender; webhook-style injection denied', async () => {
 const root = await mkdtemp(join(tmpdir(), 'ilink-entry-'));
 const previous = process.env.FRIDAY_WECHAT_ATTACHMENT_DIR; const oldFetch = globalThis.fetch;
 try {
 await writeFile(join(root, 'ok.txt'), 'safe fixture'); process.env.FRIDAY_WECHAT_ATTACHMENT_DIR = root;
 const channel: any = { id: 'wx', platform: 'wechat', enabled: true, allowedSenders: ['owner'], inboundCount: 0, outboundCount: 0, botToken: 'mock', defaultTarget: 'wrong-target' };
 const gateway: any = new ImGateway({ store: { getImChannel: () => channel, saveImChannel: () => {} } } as any);
 let calls = 0;
 globalThis.fetch = (async (_url: any, init: any) => {
  calls++;
  if (calls === 2) return new Response(null, { headers: { 'x-encrypted-param': 'opaque' } });
  const data = JSON.parse(init.body);
  if (calls === 1) { assert.equal(data.to_user_id, 'owner'); return Response.json({ ret: 0, upload_param: 'opaque' }); }
  assert.equal(data.msg.to_user_id, 'owner'); assert.equal(data.msg.context_token, 'current-context'); return Response.json({ ret: 0 });
 }) as typeof fetch;
 const msg = { channelId: 'wx', senderId: 'owner', target: 'owner', externalId: '1', text: '/file ok.txt', contextToken: 'current-context' };
 assert.equal((await gateway.ingestMessage({ ...msg })).reason, 'attachment_not_authorized');
 for (const bad of [{ ...msg, target: 'other' }, { ...msg, contextToken: '' }]) {
  gateway.trustedFileRequests.add(bad); assert.equal((await gateway.ingestMessage(bad)).reason, 'attachment_not_authorized');
 }
 gateway.trustedFileRequests.add(msg);
 assert.equal((await gateway.ingestMessage(msg)).action, 'attachment_sent'); assert.equal(calls, 3); assert.equal(channel.outboundCount, 1);
 } finally {
 globalThis.fetch = oldFetch;
 if (previous === undefined) delete process.env.FRIDAY_WECHAT_ATTACHMENT_DIR; else process.env.FRIDAY_WECHAT_ATTACHMENT_DIR = previous;
 await rm(root, { recursive: true, force: true });
 }
});

test('CDN missing header, signed URL redaction, and full URL allowlist', async () => {
 const root = await mkdtemp(join(tmpdir(), 'ilink-errors-'));
 try {
  await writeFile(join(root, 'a.txt'), 'public fixture');
  for (const mode of ['missing', 'redirect', 'foreign', 'full']) {
   let calls = 0;
   const mock = (async (url: any) => {
    calls++;
    if (calls === 1) return Response.json({ ret: 0, upload_full_url: `https://${mode === 'foreign' ? 'evil.invalid' : 'novac2c.cdn.weixin.qq.com'}/c2c/upload?secret=fixture` });
    if (calls === 2) {
     assert.equal(new URL(url).pathname, '/c2c/upload');
     if (mode === 'redirect') throw new TypeError('https://secret.invalid/?token=PRIVATE');
     return new Response(null, { headers: mode === 'full' ? { 'x-encrypted-param': 'opaque' } : {} });
    }
    return Response.json({ ret: 0 });
   }) as typeof fetch;
   const action = deliverWechatFile({root, name:'a.txt', target:'owner', contextToken:'private', base:'https://example.invalid', headers:{}}, mock);
   if (mode === 'full') await action;
   else await assert.rejects(action, (error: Error) => {
    assert.doesNotMatch(error.message, /secret|PRIVATE|https:|token=/);
    assert.match(error.message, mode === 'foreign' ? /Invalid CDN destination/ : mode === 'missing' ? /missing x-encrypted-param/ : /local read or transport failure/);
    return true;
   });
   assert.equal(calls, mode === 'foreign' ? 1 : mode === 'full' ? 3 : 2);
  }
 } finally { await rm(root, { recursive:true, force:true }); }
});

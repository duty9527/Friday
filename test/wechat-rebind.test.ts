import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImGateway } from '../src/im.js';
import { resolveStoreChannelOrigin, TimerScheduler } from '../src/orchestrator/timer-scheduler.js';
import { Store } from '../src/store.js';

const id = 'wechat-clawbot';
const oldUser = 'old@im.wechat';
const newUser = 'new@im.wechat';
const apiBase = 'https://wechat.invalid';

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'friday-wx-rebind-'));
  const store = new Store(home);
  const gateway = new ImGateway({ store } as ConstructorParameters<typeof ImGateway>[0]);
  const now = Date.now();
  store.saveImChannel({
    id, platform: 'wechat', name: 'WeChat rebind', enabled: true, notifyAll: false,
    apiBase, botToken: 'old-login', accountId: 'old@im.bot', syncBuf: 'old-cursor',
    defaultTarget: oldUser, allowedSenders: [oldUser], lastInboundAt: now,
    contextTokens: { [oldUser]: 'old-context' }, contextTokenUpdatedAt: { [oldUser]: now },
    inboundCount: 0, outboundCount: 0, createdAt: now, updatedAt: now,
  });
  return { store, gateway, async close() { await gateway.close(); store.close(); await rm(home, { recursive: true, force: true }); } };
}

function qrCode() {
  return Response.json({ qrcode: 'mock-qr', qrcode_img_content: 'https://wechat.invalid/mock-qr' });
}

function confirmation(userId?: string) {
  return Response.json({ status: 'confirmed', bot_token: 'new-login', ilink_bot_id: 'new@im.bot', ilink_user_id: userId });
}

test('WeChat QR rebinding replaces the old delivery target and ignores late updates from the old login', async t => {
  const { store, gateway, close } = await setup();
  let finishOldPoll!: (response: Response) => void;
  const oldPoll = new Promise<Response>(resolve => { finishOldPoll = resolve; });
  let notifyPollStarted!: () => void;
  const pollStarted = new Promise<void>(resolve => { notifyPollStarted = resolve; });
  const sent: Array<{ from_user_id: string; to_user_id: string; context_token: string }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    if (pathname.endsWith('/get_bot_qrcode')) return qrCode();
    if (pathname.endsWith('/get_qrcode_status')) return confirmation(newUser);
    if (pathname.endsWith('/getupdates')) {
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (auth !== 'Bearer old-login') return Response.json({ ret: 0, msgs: [] });
      notifyPollStarted();
      return oldPoll;
    }
    if (pathname.endsWith('/sendmessage')) {
      sent.push(JSON.parse(String(init?.body)).msg);
      return Response.json({ ret: 0 });
    }
    throw new Error(`Unexpected endpoint: ${pathname}`);
  });

  try {
    const previousQr = await gateway.startWechatQrLogin({ id });
    const qr = await gateway.startWechatQrLogin({ id });
    assert.equal((await gateway.pollWechatQrLogin(previousQr.sessionId)).status, 'expired');
    assert.equal(store.getImChannel(id).defaultTarget, oldUser, 'starting a QR does not replace an active binding');
    const pendingPoll = (gateway as unknown as { pollChannel(id: string): Promise<void> }).pollChannel(id);
    await pollStarted;

    const confirmed = await gateway.pollWechatQrLogin(qr.sessionId);
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(confirmed.userId, newUser);
    assert.equal(confirmed.channel?.defaultTarget, newUser);
    assert.deepEqual(confirmed.channel?.allowedSenders, [newUser]);

    finishOldPoll(Response.json({ ret: 0, get_updates_buf: 'late-old-cursor', msgs: [{
      from_user_id: newUser, context_token: 'wrong-account-context', msg_id: 'late-old',
      item_list: [{ type: 1, text_item: { text: '/status' } }],
    }] }));
    await pendingPoll;
    const rebound = store.getImChannel(id);
    assert.equal(rebound.accountId, 'new@im.bot');
    assert.equal(rebound.syncBuf, undefined);
    assert.equal(rebound.lastInboundAt, undefined);
    assert.equal(rebound.contextTokens, undefined);
    assert.equal(rebound.contextTokenUpdatedAt, undefined);
    assert.equal(resolveStoreChannelOrigin(store, 'wechat')?.conversationId, newUser);
    assert.equal(resolveStoreChannelOrigin(store, 'wechat', oldUser), undefined);
    await assert.rejects(gateway.sendToChannel(id, 'blocked', { target: oldUser }));
    await assert.rejects(gateway.sendWechatAttachment(id, 'test.txt', { target: oldUser, contextToken: 'old-context' }), /未获授权/);
    assert.equal((await gateway.testChannel(id, 'check')).target, newUser);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.from_user_id, 'new@im.bot');
    assert.equal(sent[0]?.to_user_id, newUser);
    assert.equal(sent[0]?.context_token, '');

    const withoutDefault = store.getImChannel(id);
    withoutDefault.defaultTarget = undefined;
    withoutDefault.contextTokens = { [newUser]: 'cached-context' };
    store.saveImChannel(withoutDefault);
    assert.equal(resolveStoreChannelOrigin(store, 'wechat'), undefined);
    await assert.rejects(gateway.testChannel(id, 'must not use the cached target'), /尚未绑定对话目标/);
    assert.equal(sent.length, 1);
  } finally {
    finishOldPoll(Response.json({ ret: 0 }));
    await close();
  }
});

test('a WeChat attachment cannot send to the old recipient if the binding changes during CDN upload', async t => {
  const { store, gateway, close } = await setup();
  const root = join(store.home, 'wechat-files');
  const previousRoot = process.env.FRIDAY_WECHAT_ATTACHMENT_DIR;
  process.env.FRIDAY_WECHAT_ATTACHMENT_DIR = root;
  let startUpload!: () => void;
  const uploading = new Promise<void>(resolve => { startUpload = resolve; });
  let finishUpload!: (response: Response) => void;
  const uploadResponse = new Promise<Response>(resolve => { finishUpload = resolve; });
  let messageAttempts = 0;
  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    const { pathname } = new URL(url);
    if (pathname.endsWith('/getuploadurl')) return Response.json({ upload_param: 'mock-upload' });
    if (pathname === '/c2c/upload') {
      startUpload();
      return uploadResponse;
    }
    if (pathname.endsWith('/get_bot_qrcode')) return qrCode();
    if (pathname.endsWith('/get_qrcode_status')) return confirmation(newUser);
    if (pathname.endsWith('/getupdates')) return Response.json({ msgs: [] });
    if (pathname.endsWith('/sendmessage')) {
      messageAttempts++;
      return Response.json({ ret: 0 });
    }
    throw new Error(`Unexpected endpoint: ${pathname}`);
  });

  try {
    await mkdir(root);
    await writeFile(join(root, 'test.txt'), 'old attachment');
    const sending = assert.rejects(gateway.sendWechatAttachment(id, 'test.txt', { target: oldUser }), /WeChat binding changed/);
    await uploading;
    const qr = await gateway.startWechatQrLogin({ id });
    assert.equal((await gateway.pollWechatQrLogin(qr.sessionId)).status, 'confirmed');
    finishUpload(new Response(null, { headers: { 'x-encrypted-param': 'mock-cdn' } }));
    await sending;
    assert.equal(messageAttempts, 0);
    assert.equal(store.getImChannel(id).lastError, undefined);
    assert.equal(store.getImChannel(id).outboundCount, 0);
  } finally {
    finishUpload(new Response(null, { status: 500 }));
    if (previousRoot === undefined) delete process.env.FRIDAY_WECHAT_ATTACHMENT_DIR;
    else process.env.FRIDAY_WECHAT_ATTACHMENT_DIR = previousRoot;
    await close();
  }
});

test('an incomplete WeChat QR confirmation cannot deliver using the previous target or timer origin', async t => {
  const { store, gateway, close } = await setup();
  const scheduler = new TimerScheduler({ store } as ConstructorParameters<typeof TimerScheduler>[0]);
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.includes('/get_bot_qrcode')) return qrCode();
    if (url.includes('/get_qrcode_status')) return confirmation();
    assert.fail('Must not attempt network delivery');
  });
  try {
    const timer = scheduler.addTimer('test', 'test', 60_000, undefined, undefined, { deliverChannelId: id });
    assert.equal(timer.origin?.conversationId, oldUser);
    const pending = await gateway.startWechatQrLogin({ id });
    const failed = await gateway.pollWechatQrLogin(pending.sessionId);
    assert.equal(failed.status, 'error');
    assert.match(failed.error ?? '', /已暂停投递/);
    assert.equal(failed.userId, undefined);
    assert.equal(failed.channel?.defaultTarget, undefined);
    assert.equal(failed.channel?.loginStatus, 'unbound');
    assert.equal(scheduler.resolveTimerOrigin(timer), undefined);
    await assert.rejects(gateway.testChannel(id, 'blocked'), /已停用/);
  } finally {
    await close();
  }
});

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

test('WeChat prefers fresh contextTokens, treats ret=-2 as session expiry without disabling channel, and falls back system pushes to Telegram', async t => {
  const { store, gateway, close } = await setup();
  const wxSends: Array<{ context_token: string; text: string }> = [];
  const tgSends: Array<{ chat_id: string; text: string }> = [];
  let failWechatWithRetMinus2 = false;

  t.mock.method(globalThis, 'fetch', async (url: string | URL, init?: RequestInit) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/sendmessage')) {
      const body = JSON.parse(String(init?.body)) as { msg: { context_token: string; item_list: Array<{ text_item: { text: string } }> } };
      if (failWechatWithRetMinus2) {
        return Response.json({ ret: -2, errmsg: 'session expired' });
      }
      wxSends.push({ context_token: body.msg.context_token, text: body.msg.item_list[0]!.text_item.text });
      return Response.json({ ret: 0 });
    }
    if (/\/bot[^/]+\/sendMessage$/.test(u.pathname)) {
      const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string };
      tgSends.push(body);
      return Response.json({ ok: true, result: { message_id: tgSends.length } });
    }
    throw new Error(`Unexpected endpoint: ${u.pathname}`);
  });

  try {
    // 1. Channel cached contextTokens['old@im.wechat'] overrides stale options.contextToken
    await gateway.sendToChannel(id, 'fresh-ctx-check', { target: oldUser, contextToken: 'stale-task-ctx' });
    assert.equal(wxSends.length, 1);
    assert.equal(wxSends[0]?.context_token, 'old-context');

    // 2. Without Telegram configured, ret=-2 does NOT disable channel and does NOT queue retries
    failWechatWithRetMinus2 = true;
    await assert.rejects(
      gateway.sendToChannel(id, 'expired-check', { target: oldUser }),
      /会话互动窗口已过期/,
    );
    assert.equal(store.getImChannel(id).enabled, true, 'ret=-2 must not disable WeChat channel');

    store.conversation.create({
      id: 'u-wx-user', role: 'user', source: 'router', text: 'q', status: 'completed', mode: 'offline', paths: [],
      origin: { channel: 'wechat', channelId: id, accountId: 'old@im.bot', conversationId: oldUser, senderId: oldUser },
    });
    store.conversation.create({
      id: 'a-wx-user', replyTo: 'u-wx-user', role: 'assistant', source: 'router', text: 'user reply not leaked',
      status: 'completed', mode: 'offline', paths: [],
      origin: { channel: 'wechat', channelId: id, accountId: 'old@im.bot', conversationId: oldUser, senderId: oldUser },
    });
    await (gateway as unknown as { flushOutboundUpdates(): Promise<void> }).flushOutboundUpdates();
    assert.equal(((gateway as unknown as { outboundRetryQueue: Map<string, unknown> }).outboundRetryQueue).size, 0, 'ret=-2 must not retry 5 times');

    // 3. With enabled private Telegram channel, system proactive pushes fall back automatically
    const now = Date.now();
    store.saveImChannel({
      id: 'tg-fallback', platform: 'telegram', name: 'Livis', enabled: true, notifyAll: false,
      botToken: '123456:TG-TOKEN', accountId: '@livis_bot', defaultTarget: '5094804721',
      allowedSenders: [], inboundCount: 0, outboundCount: 0, createdAt: now, updatedAt: now,
    });

    // 3a. Non-system user reply still does NOT leak to Telegram even when Telegram exists
    store.conversation.create({
      id: 'a-wx-user-2', replyTo: 'u-wx-user', role: 'assistant', source: 'router', text: 'still private to wechat',
      status: 'completed', mode: 'offline', paths: [],
      origin: { channel: 'wechat', channelId: id, accountId: 'old@im.bot', conversationId: oldUser, senderId: oldUser },
    });
    await (gateway as unknown as { flushOutboundUpdates(): Promise<void> }).flushOutboundUpdates();
    assert.equal(tgSends.length, 0);

    // 3b. System proactive push hitting ret=-2 falls back to Telegram
    store.conversation.create({
      id: 'a-sys-ret2', role: 'assistant', source: 'system', text: '📊 午间持仓报告 A',
      status: 'completed', mode: 'offline', paths: [],
      origin: { channel: 'wechat', channelId: id, accountId: 'old@im.bot', conversationId: oldUser, senderId: oldUser },
    });
    await (gateway as unknown as { flushOutboundUpdates(): Promise<void> }).flushOutboundUpdates();
    assert.equal(tgSends.length, 1);
    assert.equal(tgSends[0]?.chat_id, '5094804721');
    assert.match(tgSends[0]?.text ?? '', /午间持仓报告 A/);
    assert.match(tgSends[0]?.text ?? '', /ret=-2/);

    // 3c. System proactive push with >22h stale contextTokenUpdatedAt routes directly to Telegram pre-send
    failWechatWithRetMinus2 = false;
    const chStale = store.getImChannel(id);
    chStale.contextTokenUpdatedAt = { [oldUser]: now - 23 * 60 * 60_000 };
    store.saveImChannel(chStale);
    store.conversation.create({
      id: 'a-sys-stale', role: 'assistant', source: 'system', text: '🌙 晚间结算报告 B',
      status: 'completed', mode: 'offline', paths: [],
      origin: { channel: 'wechat', channelId: id, accountId: 'old@im.bot', conversationId: oldUser, senderId: oldUser },
    });
    await (gateway as unknown as { flushOutboundUpdates(): Promise<void> }).flushOutboundUpdates();
    assert.equal(tgSends.length, 2);
    assert.match(tgSends[1]?.text ?? '', /晚间结算报告 B/);
    assert.match(tgSends[1]?.text ?? '', /22 小时/);
    assert.equal(wxSends.length, 1, 'stale pre-send fallback skipped doomed WeChat request');

    // 3d. Outbound flush + TimerScheduler trigger fall back to Telegram when WeChat is disabled
    const chDisabled = store.getImChannel(id);
    chDisabled.enabled = false;
    store.saveImChannel(chDisabled);
    store.conversation.create({
      id: 'a-sys-disabled', role: 'assistant', source: 'system', text: '📊 持仓报告 C',
      status: 'completed', mode: 'offline', paths: [],
      origin: { channel: 'wechat', channelId: id, accountId: 'old@im.bot', conversationId: oldUser, senderId: oldUser },
    });
    await (gateway as unknown as { flushOutboundUpdates(): Promise<void> }).flushOutboundUpdates();
    assert.equal(tgSends.length, 3);
    assert.match(tgSends[2]?.text ?? '', /微信通道已停用/);

    const submittedOrigins: Array<unknown> = [];
    const scheduler = new TimerScheduler({
      home: store.home,
      store,
      mode: 'offline',
      closingSignal: new AbortController().signal,
      isClosing: () => false,
      jobs: new Set(),
      submit: async (_reqId, _prompt, _paths, _limitMs, opts) => {
        const msg = opts.originMessageId ? store.conversation.get(opts.originMessageId) : undefined;
        submittedOrigins.push(msg?.origin);
        return { id: 'mock-task', status: 'queued' } as never;
      },
      notifyOutbound: () => {},
    });
    const wxTimer = scheduler.addTimer('基金推送', 'run', 60_000, undefined, undefined, { deliverChannelId: id });
    assert.equal(scheduler.resolveTimerOrigin(wxTimer), undefined);
    (scheduler as unknown as { triggerTimer(timer: typeof wxTimer): void }).triggerTimer(wxTimer);
    assert.equal(submittedOrigins.length, 1);
    assert.equal((submittedOrigins[0] as { channel?: string; conversationId?: string })?.channel, 'telegram');
    assert.equal((submittedOrigins[0] as { channel?: string; conversationId?: string })?.conversationId, '5094804721');
  } finally {
    await close();
  }
});

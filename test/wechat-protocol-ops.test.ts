import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeClientVersion, parseWeixinApiJson } from '../src/wechat/protocol.js';
import { isInQuietHours, nextQuietHoursEndMs } from '../src/wechat/quiet-hours.js';
import { buildWechatIlinkHeaders } from '../src/im/channels/wechat-ilink.js';
import { Store } from '../src/store.js';
import { ImGateway } from '../src/im.js';
import { serve } from '../src/server.js';
import { startWeb } from '../src/web-server.js';
import { request } from '../src/protocol.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

test('parseWeixinApiJson preserves 64-bit integer IDs without mutating string literals', () => {
  const raw = '{"ret":0,"msgs":[{"message_id":9007199254740993123,"msg_id":9223372036854775807,"svr_id":1234567890123456789,"item_list":[{"type":1,"text_item":{"text":"raw \\"message_id\\": 9007199254740993123 stays string"}}]}]}';
  const parsed = parseWeixinApiJson<{
    ret: number;
    msgs: Array<{ message_id: string; msg_id: string; svr_id: string; item_list: Array<{ text_item: { text: string } }> }>;
  }>(raw);
  assert.equal(parsed.ret, 0);
  assert.equal(parsed.msgs[0]!.message_id, '9007199254740993123');
  assert.equal(parsed.msgs[0]!.msg_id, '9223372036854775807');
  assert.equal(parsed.msgs[0]!.svr_id, '1234567890123456789');
  assert.equal(
    parsed.msgs[0]!.item_list[0]!.text_item.text,
    'raw "message_id": 9007199254740993123 stays string',
  );

  assert.equal(encodeClientVersion('2.4.10'), '132106');
  const headers = buildWechatIlinkHeaders('tok-1');
  assert.equal(headers['iLink-App-Id'], 'bot');
  assert.equal(headers['iLink-App-ClientVersion'], '132106');
});

test('quietHours checks same-day/cross-midnight ranges and defers only system pushes without blocking user replies', async () => {
  const cross = { enabled: true, start: '23:00', end: '07:00' };
  const midnight = new Date(2026, 10, 19, 23, 30, 0);
  const early = new Date(2026, 10, 20, 6, 45, 0);
  const noon = new Date(2026, 10, 20, 12, 0, 0);
  assert.equal(isInQuietHours(cross, midnight), true);
  assert.equal(isInQuietHours(cross, early), true);
  assert.equal(isInQuietHours(cross, noon), false);
  const endAt = new Date(nextQuietHoursEndMs(cross, midnight));
  assert.equal(endAt.getHours(), 7);
  assert.equal(endAt.getMinutes(), 0);
  assert.equal(endAt.getDate(), 20);

  const sameDay = { enabled: true, start: '13:00', end: '15:00' };
  assert.equal(isInQuietHours(sameDay, new Date(2026, 10, 19, 14, 0, 0)), true);
  assert.equal(isInQuietHours(sameDay, new Date(2026, 10, 19, 16, 0, 0)), false);

  const home = await mkdtemp(join(tmpdir(), 'wx-quiet-'));
  const store = new Store(home);
  const gateway = new ImGateway({ store } as any);
  const oldFetch = globalThis.fetch;
  const sentTexts: string[] = [];

  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { msg: { item_list: Array<{ text_item: { text: string } }> } };
    sentTexts.push(body.msg.item_list[0]!.text_item.text);
    return Response.json({ ret: 0 });
  }) as typeof fetch;

  try {
    // Configure an active 24h-adjacent quiet window covering current minute (using now +/- 1h)
    const nowDate = new Date();
    const startDate = new Date(nowDate.getTime() - 30 * 60_000);
    const endDate = new Date(nowDate.getTime() + 30 * 60_000);
    const fmt = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    store.saveImChannel({
      id: 'wx-quiet',
      platform: 'wechat',
      name: 'wx-quiet',
      enabled: true,
      notifyAll: false,
      botToken: 'tok-quiet',
      accountId: 'bot-quiet',
      apiBase: 'https://wechat.invalid',
      defaultTarget: 'owner',
      allowedSenders: ['owner'],
      contextTokens: { owner: 'ctx-quiet' },
      quietHours: { enabled: true, start: fmt(startDate), end: fmt(endDate) },
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // System proactive push is deferred during quiet hours
    store.conversation.create({
      id: 'sys-quiet-1',
      role: 'assistant',
      source: 'system',
      text: '夜间巡检报告',
      status: 'completed',
      mode: 'offline',
      paths: [],
      origin: { channel: 'wechat', channelId: 'wx-quiet', accountId: 'bot-quiet', conversationId: 'owner', senderId: 'owner' },
    });
    // User reply is NOT blocked by quiet hours
    store.conversation.create({
      id: 'usr-reply-1',
      role: 'assistant',
      source: 'router',
      text: '夜间实时回复',
      status: 'completed',
      mode: 'offline',
      paths: [],
      origin: { channel: 'wechat', channelId: 'wx-quiet', accountId: 'bot-quiet', conversationId: 'owner', senderId: 'owner' },
    });

    await (gateway as any).flushOutboundUpdates();
    assert.deepEqual(sentTexts, ['夜间实时回复']);
    const retryQueue = (gateway as any).outboundRetryQueue as Map<string, { attempts: number; nextRetryAt: number }>;
    assert.ok(retryQueue.has('sys-quiet-1'));
    assert.equal(retryQueue.get('sys-quiet-1')?.attempts, 0, 'quiet-hours deferral must not burn retry attempts');
    assert.ok((retryQueue.get('sys-quiet-1')?.nextRetryAt ?? 0) > Date.now() + 15 * 60_000);
  } finally {
    await gateway.close();
    globalThis.fetch = oldFetch;
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('iLink 2.4.10 lifecycle notifystart/notifystop, QR redirect/verify_code/binded_redirect/auto-refresh, multi-account and stranger allowlisting', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'wx-proto-ops-'));
  const lifecycleEvents: string[] = [];
  const qrStatusQueue: Array<Record<string, unknown>> = [];
  const qrRequests: Array<{ method: string; body: Record<string, unknown> | null }> = [];
  const updatesByAuth = new Map<string, Array<Record<string, unknown>>>();
  let redirectServerPort = 0;

  const redirectServer = createServer((req, res) => {
    const u = req.url ?? '/';
    if (u.startsWith('/ilink/bot/get_qrcode_status')) {
      const next = qrStatusQueue.shift() ?? { status: 'wait' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>(r => redirectServer.listen(0, '127.0.0.1', r));
  const rAddr = redirectServer.address();
  assert.ok(rAddr && typeof rAddr !== 'string');
  redirectServerPort = rAddr.port;

  let qrSeq = 0;
  const mockServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const u = req.url ?? '/';
    const raw = req.method === 'POST' ? await readBody(req) : '';
    if (u.startsWith('/ilink/bot/msg/notifystart')) {
      lifecycleEvents.push(`start:${req.headers.authorization}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ret: 0 }));
      return;
    }
    if (u.startsWith('/ilink/bot/msg/notifystop')) {
      lifecycleEvents.push(`stop:${req.headers.authorization}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ret: 0 }));
      return;
    }
    if (u.startsWith('/ilink/bot/getupdates')) {
      const auth = String(req.headers.authorization ?? '');
      const queued = updatesByAuth.get(auth)?.splice(0) ?? [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ret: 0, msgs: queued }));
      return;
    }
    if (u.startsWith('/ilink/bot/get_bot_qrcode')) {
      qrSeq++;
      qrRequests.push({ method: req.method ?? 'GET', body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        qrcode: `qr-code-${qrSeq}`,
        qrcode_img_content: `https://liteapp.weixin.qq.com/q/mock-${qrSeq}`,
      }));
      return;
    }
    if (u.startsWith('/ilink/bot/get_qrcode_status')) {
      const parsed = new URL(u, 'http://127.0.0.1');
      const next = qrStatusQueue.shift() ?? { status: 'wait' };
      if (next.expectVerifyCode) {
        assert.equal(parsed.searchParams.get('verify_code'), next.expectVerifyCode);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(next));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(r => mockServer.listen(0, '127.0.0.1', r));
  const addr = mockServer.address();
  assert.ok(addr && typeof addr !== 'string');
  const mockBase = `http://127.0.0.1:${addr.port}`;

  const daemon = await serve({ home, mode: 'offline', offlineDelayMs: 10 });
  const web = await startWeb({ home, port: 0 });
  const webOrigin = new URL(web.url).origin;
  const webToken = new URL(web.url).hash.slice('#token='.length);

  try {
    // 1. Existing WeChat account gets notifystart when saved/started, and notifystop when disabled
    await request(home, {
      command: 'im-save',
      id: 'wx-acc-1',
      platform: 'wechat',
      name: '主微信',
      botToken: 'tok-acc-1',
      accountId: 'bot-acc-1',
      apiBase: mockBase,
      allowedSenders: ['owner-1'],
      pollIntervalMs: 5000,
    });
    for (let i = 0; i < 40 && !lifecycleEvents.includes('start:Bearer tok-acc-1'); i++) {
      await delay(20);
    }
    assert.ok(lifecycleEvents.includes('start:Bearer tok-acc-1'));

    await request(home, { command: 'im-toggle', id: 'wx-acc-1', enabled: false });
    for (let i = 0; i < 40 && !lifecycleEvents.includes('stop:Bearer tok-acc-1'); i++) {
      await delay(20);
    }
    assert.ok(lifecycleEvents.includes('stop:Bearer tok-acc-1'));

    // 2. newAccount:true creates an independent second account & sends local_token_list via POST
    const qrNew = await request(home, {
      command: 'im-wechat-qr-start',
      newAccount: true,
      apiBase: mockBase,
    }) as { sessionId: string; channelId: string; channelName: string; qrcode: string; refreshCount?: number };
    assert.notEqual(qrNew.channelId, 'wx-acc-1');
    assert.equal(qrNew.channelName, '微信个人号 #2');
    assert.equal(qrRequests[0]!.method, 'POST');
    assert.deepEqual(qrRequests[0]!.body?.local_token_list, ['tok-acc-1']);

    // 3. expired triggers auto-refresh -> need_verify_code -> verifyCode submitted -> scaned_but_redirect -> confirmed with cdnBaseUrl
    updatesByAuth.set('Bearer tok-acc-2', [
      {
        message_id: 'stranger-msg-1',
        from_user_id: 'stranger-xyz@im.wechat',
        from_user_name: '路人甲',
        item_list: [{ type: 1, text_item: { text: '你好，Bearer secret-123 在吗' } }],
      },
    ]);
    qrStatusQueue.push(
      { status: 'expired' },
      { status: 'need_verify_code' },
      { status: 'scaned_but_redirect', redirect_host: `127.0.0.1:${redirectServerPort}`, expectVerifyCode: '8848' },
      {
        status: 'confirmed',
        bot_token: 'tok-acc-2',
        ilink_bot_id: 'bot-acc-2',
        ilink_user_id: 'owner-2',
        baseurl: mockBase,
        cdn_base_url: 'https://sz.cdn.weixin.qq.com/c2c',
      },
    );

    const poll1 = await request(home, { command: 'im-wechat-qr-status', sessionId: qrNew.sessionId }) as any;
    assert.equal(poll1.status, 'wait');
    assert.equal(poll1.refreshCount, 1);
    assert.notEqual(poll1.qrcode, qrNew.qrcode);

    const poll2 = await request(home, { command: 'im-wechat-qr-status', sessionId: qrNew.sessionId }) as any;
    assert.equal(poll2.status, 'verify_code');
    assert.equal(poll2.verifyRequired, true);

    const poll3 = await request(home, {
      command: 'im-wechat-qr-status',
      sessionId: qrNew.sessionId,
      verifyCode: '8848',
    }) as any;
    assert.equal(poll3.status, 'scaned');

    const poll4 = await request(home, { command: 'im-wechat-qr-status', sessionId: qrNew.sessionId }) as any;
    assert.equal(poll4.status, 'confirmed');
    assert.equal(poll4.channel?.cdnBaseUrl, 'https://sz.cdn.weixin.qq.com');

    // 4. binded_redirect reports explicit state
    const qrBinded = await request(home, {
      command: 'im-wechat-qr-start',
      id: 'wx-acc-1',
      apiBase: mockBase,
    }) as { sessionId: string };
    qrStatusQueue.push({ status: 'binded_redirect' });
    const pollBinded = await request(home, { command: 'im-wechat-qr-status', sessionId: qrBinded.sessionId }) as any;
    assert.equal(pollBinded.status, 'binded_redirect');
    assert.equal(pollBinded.alreadyConnected, true);
    assert.match(pollBinded.error ?? '', /解除该机器人的绑定/);

    // 5. Rejected stranger logged by getupdates poller and allowlisted via Web HTTP API
    let ch2: any;
    for (let i = 0; i < 60; i++) {
      const channelsAfterReject = await request(home, { command: 'im-list' }) as any[];
      ch2 = channelsAfterReject.find(c => c.id === qrNew.channelId);
      if (ch2?.rejectedSenders?.length) break;
      await delay(25);
    }
    assert.equal(ch2?.rejectedSenders?.length, 1);
    assert.equal(ch2.rejectedSenders[0].senderId, 'stranger-xyz@im.wechat');
    assert.equal(ch2.rejectedSenders[0].count, 1);
    assert.doesNotMatch(ch2.rejectedSenders[0].lastText, /secret-123/);

    const allowRes = await fetch(`${webOrigin}/api/im-allow-sender`, {
      method: 'POST',
      headers: { authorization: `Bearer ${webToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: qrNew.channelId, senderId: 'stranger-xyz@im.wechat' }),
    });
    assert.equal(allowRes.status, 200);
    const updatedView = await allowRes.json() as any;
    assert.ok(updatedView.allowedSenders.includes('stranger-xyz@im.wechat'));
    assert.equal(updatedView.rejectedSenders, undefined);
  } finally {
    await web.close();
    await daemon.close();
    await new Promise<void>(r => mockServer.close(() => r()));
    await new Promise<void>(r => redirectServer.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
});

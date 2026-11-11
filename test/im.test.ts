import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '../dist/server.js';
import { startWeb } from '../dist/web-server.js';
import { request } from '../dist/protocol.js';
import { Store } from '../src/store.js';
import { ImGateway } from '../src/im.js';

async function until(predicate: () => boolean | Promise<boolean>, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await delay(15);
  }
  throw new Error('Timed out waiting for IM condition');
}

function readReqBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

test('OpenClaw-style Multi-Channel IM Gateway: DingTalk, WeChat, and Telegram share unified conversation, global memory, and proactive Worker push', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-im-gateway-'));

  // Mock external IM servers (DingTalk, WeChat, Telegram Bot API)
  const dingtalkReceived: Array<{ url: string; body: Record<string, unknown> }> = [];
  const wechatReceived: Array<{ url: string; body: Record<string, unknown> }> = [];
  const wechatIlinkSent: Array<{ headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];
  const wechatIlinkUpdatesQueue: Array<Record<string, unknown>> = [];
  let wechatQrPollStep = 0;
  const telegramSent: Array<Record<string, unknown>> = [];
  const telegramUpdatesQueue: Array<Record<string, unknown>> = [];

  const mockImServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const raw = req.method === 'POST' ? await readReqBody(req) : '';
    if (url.startsWith('/ilink/bot/get_bot_qrcode')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        qrcode: 'qr-session-token-2026',
        qrcode_img_content: 'https://liteapp.weixin.qq.com/q/friday-qr-bind-2026',
      }));
      return;
    }
    if (url.startsWith('/ilink/bot/get_qrcode_status')) {
      wechatQrPollStep++;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (wechatQrPollStep === 1) {
        res.end(JSON.stringify({ status: 'scaned' }));
      } else {
        res.end(JSON.stringify({
          status: 'confirmed',
          bot_token: 'ilink-bot-token-xyz',
          ilink_bot_id: 'wx_bot_friday@im.wechat',
          ilink_user_id: 'wx_user_tony@im.wechat',
        }));
      }
      return;
    }
    if (url.startsWith('/ilink/bot/getupdates')) {
      const body = JSON.parse(raw || '{}') as { get_updates_buf?: string };
      const msgs = body.get_updates_buf === 'cursor-after-1' ? [] : wechatIlinkUpdatesQueue.splice(0);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ret: 0,
        get_updates_buf: 'cursor-after-1',
        msgs,
      }));
      return;
    }
    if (url.startsWith('/ilink/bot/sendmessage')) {
      wechatIlinkSent.push({
        headers: req.headers,
        body: JSON.parse(raw || '{}') as Record<string, unknown>,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ret: 0 }));
      return;
    }
    if (url.startsWith('/dingtalk/webhook') || url.startsWith('/dingtalk/session')) {
      dingtalkReceived.push({ url, body: JSON.parse(raw || '{}') as Record<string, unknown> });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
      return;
    }
    if (url.startsWith('/wechat/webhook')) {
      wechatReceived.push({ url, body: JSON.parse(raw || '{}') as Record<string, unknown> });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
      return;
    }
    if (url.includes('/getUpdates')) {
      const parsed = new URL(url, 'http://127.0.0.1');
      const offset = Number(parsed.searchParams.get('offset') ?? '0');
      const batch = telegramUpdatesQueue.filter(u => Number(u.update_id) >= offset);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: batch }));
      return;
    }
    if (url.includes('/sendMessage')) {
      telegramSent.push(JSON.parse(raw || '{}') as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: 999 } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(resolve => mockImServer.listen(0, '127.0.0.1', resolve));
  const mockAddr = mockImServer.address();
  assert.ok(mockAddr && typeof mockAddr !== 'string');
  const mockBase = `http://127.0.0.1:${mockAddr.port}`;

  const daemon = await serve({ home, mode: 'offline', offlineDelayMs: 10 });
  const web = await startWeb({ home, port: 0 });
  const webOrigin = new URL(web.url).origin;

  try {
    // =========================================================================
    // 1. DingTalk Channel: HMAC-SHA256 verification, sender allowlist, memory save & reply
    // =========================================================================
    const dingSecret = 'SEC-dingtalk-friday-secret';
    const dingChannel = await request(home, {
      command: 'im-save',
      platform: 'dingtalk',
      name: '钉钉战甲管家',
      webhookUrl: `${mockBase}/dingtalk/webhook`,
      secret: dingSecret,
      allowedSenders: ['staff-tony'],
      notifyAll: false,
    }) as { id: string; platform: string };

    // 1a. Reject unsigned DingTalk webhook
    const unsignedRes = await fetch(`${webOrigin}/im/webhook/${dingChannel.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgId: 'd-0', senderStaffId: 'staff-tony', text: { content: '你好' } }),
    });
    assert.equal(unsignedRes.status, 403, 'DingTalk webhook without valid HMAC signature is rejected');

    // Helper to sign DingTalk requests
    const signDingTalk = () => {
      const timestamp = String(Date.now());
      const sign = createHmac('sha256', dingSecret).update(`${timestamp}\n${dingSecret}`).digest('base64');
      return { timestamp, sign };
    };

    // 1b. Reject sender not in allowedSenders
    const strangerSig = signDingTalk();
    const strangerRes = await fetch(`${webOrigin}/im/webhook/${dingChannel.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...strangerSig },
      body: JSON.stringify({ msgId: 'd-1', senderStaffId: 'staff-stranger', text: { content: '你好' } }),
    });
    assert.equal(strangerRes.status, 200);
    const strangerJson = await strangerRes.json() as { ok: boolean; action: string; reason: string };
    assert.equal(strangerJson.ok, false);
    assert.equal(strangerJson.reason, 'sender_not_allowed');

    // 1c. Authorized DingTalk message saves a global memory card and replies to sessionWebhook
    const tonySig = signDingTalk();
    const dingMsgRes = await fetch(`${webOrigin}/im/webhook/${dingChannel.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...tonySig },
      body: JSON.stringify({
        msgId: 'd-2',
        senderStaffId: 'staff-tony',
        senderNick: 'Tony Stark',
        conversationId: 'cid-armor-room',
        sessionWebhook: `${mockBase}/dingtalk/session`,
        text: { content: '记住：战甲协议=Mark85 采用纳米流体钛合金与量子反应堆' },
      }),
    });
    assert.equal(dingMsgRes.status, 200);
    const dingMsgJson = await dingMsgRes.json() as { ok: boolean; action: string; messageId: string };
    assert.equal(dingMsgJson.ok, true);
    assert.equal(dingMsgJson.action, 'routed_to_chat');

    // Wait for FRIDAY to reply back to DingTalk sessionWebhook
    await until(() => dingtalkReceived.some(r => r.url === '/dingtalk/session'));
    const dingReply = dingtalkReceived.find(r => r.url === '/dingtalk/session')!;
    const dingReplyText = String((dingReply.body.text as { content?: string })?.content ?? '');
    assert.match(dingReplyText, /战甲协议/, 'DingTalk received FRIDAY reply confirming saved memory');

    // 1d. Test outbound signed push via im-test
    await request(home, { command: 'im-test', id: dingChannel.id, text: '钉钉主动推送自检' });
    const signedWebhookHit = dingtalkReceived.find(r => r.url.startsWith('/dingtalk/webhook?'));
    assert.ok(signedWebhookHit, 'DingTalk outbound webhook includes timestamp & HMAC sign query params');
    assert.match(signedWebhookHit.url, /timestamp=\d+&sign=/);

    // =========================================================================
    // 2. WeChat Channel: GET echo verification, XML callback, task dispatch & proactive report push
    // =========================================================================
    const wechatSecret = 'wx-friday-token';
    const wechatChannel = await request(home, {
      command: 'im-save',
      platform: 'wechat',
      name: '微信随身副手',
      webhookUrl: `${mockBase}/wechat/webhook`,
      secret: wechatSecret,
      notifyAll: true,
    }) as { id: string };

    // 2a. WeChat GET signature echo verification
    const wxTimestamp = '1700000000';
    const wxNonce = 'nonce123';
    const wxSig = createHash('sha1').update([wechatSecret, wxTimestamp, wxNonce].sort().join('')).digest('hex');
    const wxEchoRes = await fetch(
      `${webOrigin}/im/webhook/${wechatChannel.id}?signature=${wxSig}&timestamp=${wxTimestamp}&nonce=${wxNonce}&echostr=friday_wx_verified`,
    );
    assert.equal(wxEchoRes.status, 200);
    assert.equal(await wxEchoRes.text(), 'friday_wx_verified');

    // 2b. WeChat XML inbound message dispatches a background coding Worker
    const wxXml = `<xml>
      <ToUserName><![CDATA[gh_friday]]></ToUserName>
      <FromUserName><![CDATA[wxid_tony]]></FromUserName>
      <CreateTime>1700000001</CreateTime>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[派发：重构战甲纳米流体钛合金控制模块代码]]></Content>
      <MsgId>wx-msg-2026</MsgId>
    </xml>`;
    const wxPostRes = await fetch(
      `${webOrigin}/im/webhook/${wechatChannel.id}?signature=${wxSig}&timestamp=${wxTimestamp}&nonce=${wxNonce}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/xml' },
        body: wxXml,
      },
    );
    assert.equal(wxPostRes.status, 200);

    // Wait for both Router dispatch reply AND completed Worker report to be pushed to WeChat
    await until(() => wechatReceived.length >= 2);
    const allWechatTexts = wechatReceived.map(r => String(r.body.content ?? '')).join('\n');
    assert.match(allWechatTexts, /coding/, 'WeChat received Router dispatch confirmation with coding specialist profile');
    assert.match(allWechatTexts, /已完成|汇总/, 'WeChat proactively received background Worker completion report');

    // =========================================================================
    // 3. Telegram Channel: Long-polling getUpdates, cross-IM memory recall & reply_to_message_id
    // =========================================================================
    telegramUpdatesQueue.push({
      update_id: 501,
      message: {
        message_id: 88,
        from: { id: 9001, first_name: 'Tony', username: 'tonystark' },
        chat: { id: 9001 },
        text: '/memories',
      },
    });
    telegramUpdatesQueue.push({
      update_id: 502,
      message: {
        message_id: 89,
        from: { id: 9001, first_name: 'Tony', username: 'tonystark' },
        chat: { id: 9001 },
        text: '我们的战甲协议采用什么材料？',
      },
    });

    await request(home, {
      command: 'im-save',
      platform: 'telegram',
      name: 'Telegram Bot',
      botToken: '123456:ABCDEF',
      apiBase: mockBase,
      allowedSenders: ['@tonystark'],
      pollIntervalMs: 100,
      notifyAll: false,
    });

    // Wait for Telegram poller to process both updates (501 /memories command + 502 subconscious memory flashback chat)
    await until(() => telegramSent.length >= 2);

    const tgMemoriesReply = telegramSent.find(m => m.reply_to_message_id === 88);
    assert.ok(tgMemoriesReply, 'Telegram replied directly to message_id 88 (/memories)');
    assert.equal(tgMemoriesReply.chat_id, '9001');
    assert.match(String(tgMemoriesReply.text), /战甲协议/, 'Telegram /memories shows memory saved earlier from DingTalk');
    assert.match(String(tgMemoriesReply.text), /任务经验/, 'Telegram /memories shows auto-consolidated memory from WeChat Worker task');

    const tgChatReply = telegramSent.find(m => m.reply_to_message_id === 89);
    assert.ok(tgChatReply, 'Telegram replied directly to message_id 89 (chat question)');
    assert.match(String(tgChatReply.text), /纳米流体钛合金/, 'Telegram chat automatically recalled DingTalk memory via subconscious flashback');

    // =========================================================================
    // 4. WeChat QR Code Binding (OpenClaw / Tencent iLink protocol: get_bot_qrcode -> get_qrcode_status -> getupdates -> sendmessage)
    // =========================================================================
    const qrStart = await request(home, {
      command: 'im-wechat-qr-start',
      id: 'wechat-personal-qr',
      name: '微信扫码个人号',
      apiBase: mockBase,
      notifyAll: false,
    }) as {
      sessionId: string;
      channelId: string;
      qrcode: string;
      qrcodeContent: string;
      qrSvgDataUrl: string;
      qrTerminal: string;
      status: string;
    };
    assert.equal(qrStart.channelId, 'wechat-personal-qr');
    assert.equal(qrStart.qrcode, 'qr-session-token-2026');
    assert.match(qrStart.qrSvgDataUrl, /^data:image\/svg\+xml;base64,/);
    assert.ok(qrStart.qrTerminal.includes('█'), 'Terminal Unicode QR code is rendered');
    assert.equal(qrStart.status, 'wait');

    // First poll -> 'scaned'
    const qrPoll1 = await request(home, {
      command: 'im-wechat-qr-status',
      sessionId: qrStart.sessionId,
    }) as { status: string };
    assert.equal(qrPoll1.status, 'scaned');

    // Queue an incoming personal WeChat message on the iLink server before confirmation triggers polling
    wechatIlinkUpdatesQueue.push({
      msg_id: 'ilink-msg-101',
      from_user_id: 'wx_user_tony@im.wechat',
      to_user_id: 'wx_bot_friday@im.wechat',
      message_type: 1,
      context_token: 'ctx-token-tony-session-999',
      item_list: [
        {
          type: 1,
          text_item: { text: '/status' },
        },
      ],
    });

    // Second poll -> 'confirmed', saves bot_token & accountId, auto-authorizes ilink_user_id, and starts iLink long-polling
    const qrPoll2 = await request(home, {
      command: 'im-wechat-qr-status',
      sessionId: qrStart.sessionId,
    }) as { status: string; accountId?: string; userId?: string; channel?: { hasBotToken: boolean; loginStatus?: string; allowedSenders?: string[] } };
    assert.equal(qrPoll2.status, 'confirmed');
    assert.equal(qrPoll2.accountId, 'wx_bot_friday@im.wechat');
    assert.equal(qrPoll2.userId, 'wx_user_tony@im.wechat');
    assert.equal(qrPoll2.channel?.hasBotToken, true);
    assert.equal(qrPoll2.channel?.loginStatus, 'bound');
    assert.ok(qrPoll2.channel?.allowedSenders?.includes('wx_user_tony@im.wechat'), 'QR confirmation auto-authorizes ilink_user_id for media & file transfers');

    // Wait for iLink getupdates poller to ingest the message and reply via /ilink/bot/sendmessage
    await until(() => wechatIlinkSent.length >= 1);
    const ilinkReply = wechatIlinkSent[0];
    assert.equal(ilinkReply.headers['authorizationtype'], 'ilink_bot_token');
    assert.equal(ilinkReply.headers['authorization'], 'Bearer ilink-bot-token-xyz');
    assert.ok(ilinkReply.headers['x-wechat-uin'], 'X-WECHAT-UIN header is present');
    const ilinkMsg = ilinkReply.body.msg as {
      to_user_id: string;
      context_token: string;
      message_type: number;
      item_list: Array<{ type: number; text_item: { text: string } }>;
    };
    assert.equal(ilinkMsg.to_user_id, 'wx_user_tony@im.wechat');
    assert.equal(ilinkMsg.context_token, 'ctx-token-tony-session-999', 'Replies echo back the exact iLink context_token');
    assert.equal(ilinkMsg.message_type, 2);
    assert.match(ilinkMsg.item_list[0].text_item.text, /FRIDAY 全息态势简报/);
  } finally {
    await web.close();
    await daemon.close();
    await new Promise<void>(resolve => mockImServer.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
  }
});

test('WeChat iLink typing indicator: getconfig ticket cache, strict start/message/stop ordering, and stale ticket refresh', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-im-wx-typing-'));
  const updatesQueue: Array<Record<string, unknown>> = [];
  const timeline: string[] = [];
  const getconfigCalls: Array<Record<string, unknown>> = [];
  const typingCalls: Array<{ headers: IncomingMessage['headers']; body: Record<string, unknown> }> = [];
  let ticketSeq = 0;
  let rejectTicketOnce = '';

  const mockIlink = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const raw = req.method === 'POST' ? await readReqBody(req) : '';
    const body = JSON.parse(raw || '{}') as Record<string, unknown>;

    if (url.startsWith('/ilink/bot/getupdates')) {
      const msgs = updatesQueue.splice(0);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ret: 0, get_updates_buf: `buf-${Date.now()}`, msgs }));
      return;
    }
    if (url.startsWith('/ilink/bot/getconfig')) {
      ticketSeq++;
      const ticket = `typing-ticket-${ticketSeq}`;
      getconfigCalls.push(body);
      timeline.push(`getconfig:${ticket}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ret: 0, typing_ticket: ticket }));
      return;
    }
    if (url.startsWith('/ilink/bot/sendtyping')) {
      typingCalls.push({ headers: req.headers, body });
      const ticket = String(body.typing_ticket ?? '');
      const status = Number(body.status);
      if (rejectTicketOnce && ticket === rejectTicketOnce) {
        rejectTicketOnce = '';
        timeline.push(`typing-expired:${status}:${ticket}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ret: -1 }));
        return;
      }
      timeline.push(`typing:${status}:${ticket}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ret: 0 }));
      return;
    }
    if (url.startsWith('/ilink/bot/sendmessage')) {
      timeline.push('sendmessage');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ret: 0 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(resolve => mockIlink.listen(0, '127.0.0.1', resolve));
  const addr = mockIlink.address();
  assert.ok(addr && typeof addr !== 'string');
  const mockBase = `http://127.0.0.1:${addr.port}`;

  const daemon = await serve({ home, mode: 'offline', offlineDelayMs: 180 });
  try {
    await request(home, {
      command: 'im-save',
      id: 'wx-typing',
      platform: 'wechat',
      name: '微信输入态测试',
      botToken: 'ilink-typing-bot-token',
      apiBase: mockBase,
      allowedSenders: ['wx_user_pepper@im.wechat'],
      pollIntervalMs: 100,
    });

    // Turn 1: fetches typing_ticket via getconfig, sends status=1, delivers reply, then sends status=2
    updatesQueue.push({
      msg_id: 'wx-t-1',
      from_user_id: 'wx_user_pepper@im.wechat',
      message_type: 1,
      context_token: 'ctx-typing-1',
      item_list: [{ type: 1, text_item: { text: '你好，汇报当前系统状态' } }],
    });

    await until(() => timeline.includes('typing:2:typing-ticket-1'));
    assert.deepEqual(timeline, [
      'getconfig:typing-ticket-1',
      'typing:1:typing-ticket-1',
      'sendmessage',
      'typing:2:typing-ticket-1',
    ]);
    assert.equal(getconfigCalls.length, 1);
    assert.equal(getconfigCalls[0].ilink_user_id, 'wx_user_pepper@im.wechat');
    assert.equal(getconfigCalls[0].context_token, 'ctx-typing-1');
    assert.equal(typingCalls[0].headers['authorizationtype'], 'ilink_bot_token');
    assert.equal(typingCalls[0].headers['authorization'], 'Bearer ilink-typing-bot-token');
    assert.equal(typingCalls[0].body.ilink_user_id, 'wx_user_pepper@im.wechat');

    // Turn 2: reuses cached typing_ticket without calling getconfig again
    timeline.length = 0;
    updatesQueue.push({
      msg_id: 'wx-t-2',
      from_user_id: 'wx_user_pepper@im.wechat',
      message_type: 1,
      context_token: 'ctx-typing-2',
      item_list: [{ type: 1, text_item: { text: '继续汇报能耗参数' } }],
    });

    await until(() => timeline.includes('typing:2:typing-ticket-1'));
    assert.deepEqual(timeline, [
      'typing:1:typing-ticket-1',
      'sendmessage',
      'typing:2:typing-ticket-1',
    ]);
    assert.equal(getconfigCalls.length, 1, 'Cached typing_ticket is reused across turns');

    // Turn 3: server rejects stale typing_ticket -> gateway refreshes via getconfig and completes cleanly
    timeline.length = 0;
    rejectTicketOnce = 'typing-ticket-1';
    updatesQueue.push({
      msg_id: 'wx-t-3',
      from_user_id: 'wx_user_pepper@im.wechat',
      message_type: 1,
      context_token: 'ctx-typing-3',
      item_list: [{ type: 1, text_item: { text: '测试过期票据自动刷新' } }],
    });

    await until(() => timeline.includes('typing:2:typing-ticket-2'));
    assert.deepEqual(timeline, [
      'typing-expired:1:typing-ticket-1',
      'getconfig:typing-ticket-2',
      'typing:1:typing-ticket-2',
      'sendmessage',
      'typing:2:typing-ticket-2',
    ]);
  } finally {
    await daemon.close();
    await new Promise<void>(resolve => mockIlink.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test('WeChat iLink typing keepalive pulses during long streaming and clears cleanly on interruption', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-im-wx-keepalive-'));
  const store = new Store(home);
  const statuses: number[] = [];
  const oldFetch = globalThis.fetch;

  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.endsWith('/ilink/bot/getconfig')) {
      return Response.json({ ret: 0, typing_ticket: 'keepalive-ticket' });
    }
    if (u.endsWith('/ilink/bot/sendtyping')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { status: number };
      statuses.push(body.status);
      return Response.json({ ret: 0 });
    }
    if (u.endsWith('/ilink/bot/getupdates')) {
      return Response.json({ ret: 0, get_updates_buf: 'idle', msgs: [] });
    }
    if (u.endsWith('/ilink/bot/sendmessage')) {
      return Response.json({ ret: 0 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const gateway = new ImGateway({
    store,
    chat(requestId: string, text: string, paths: string[], origin: any, attachments: any) {
      return store.conversation.create({
        id: 'u-long',
        requestId,
        role: 'user',
        text,
        paths,
        origin,
        attachments,
        status: 'processing',
        mode: 'real',
      });
    },
  } as any);
  (gateway as any).typingKeepaliveMs = 40;

  try {
    store.saveImChannel({
      id: 'wx-ka',
      platform: 'wechat',
      name: 'wx-ka',
      enabled: true,
      notifyAll: false,
      botToken: 'bot-tok',
      accountId: 'wx_bot@im.wechat',
      allowedSenders: ['wx_user@im.wechat'],
      pollIntervalMs: 5_000,
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    gateway.start();

    await gateway.ingestMessage({
      channelId: 'wx-ka',
      externalId: 'ext-1',
      senderId: 'wx_user@im.wechat',
      target: 'wx_user@im.wechat',
      text: '长耗时推理与中断清理测试',
      contextToken: 'ctx-ka',
    });

    const reply = store.conversation.create({
      id: 'r-long',
      replyTo: 'u-long',
      role: 'assistant',
      text: '正在生成部分内容...',
      status: 'streaming',
      mode: 'real',
      paths: [],
    });

    // Wait for initial status=1 plus at least two keepalive pulses
    await until(() => statuses.filter(s => s === 1).length >= 3);

    // Interrupt both user message and streaming reply
    store.conversation.update(reply.id, { status: 'interrupted', reason: '已手动停止回复' });
    store.conversation.update('u-long', { status: 'interrupted', reason: '已手动停止回复' });

    await until(() => statuses.includes(2));
    assert.equal(statuses.at(-1), 2, 'Final typing status sent is 2 (cancel typing)');
    const countAtStop = statuses.length;
    await delay(100);
    assert.equal(statuses.length, countAtStop, 'No stray keepalive pulses fire after interruption');
  } finally {
    await gateway.close();
    globalThis.fetch = oldFetch;
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

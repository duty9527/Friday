import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ImGateway } from '../src/im.js';
import { DingtalkChannelAdapter } from '../src/im/channels/dingtalk.js';
import { splitTelegramText, TelegramChannelAdapter } from '../src/im/channels/telegram.js';
import { WechatIlinkAdapter } from '../src/im/channels/wechat-ilink.js';
import { WechatWebhookAdapter } from '../src/im/channels/wechat-webhook.js';
import { isAllowedReplyWebhook, sanitizeImError } from '../src/im/types.js';
import { renderQrSvgDataUrl } from '../src/qrcode.js';
import { sanitizePublicReply } from '../src/reply-filter.js';
import { Store, type ImChannelConfig } from '../src/store.js';
import { parseXiaoaiMiotUtterance } from '../src/xiaoai-miot-fastpath.js';
import { parseTvRemoteEntryUtterance, parseTvRemoteInModeUtterance } from '../src/xiaoai-tv-remote.js';
import { getCloudBases } from '../src/xiaoai/cloud-auth.js';
import { XiaoaiKwsMonitor, type XiaoaiKwsStreamHandle } from '../src/xiaoai/kws-monitor.js';
import { ensureXiaoaiSpeakerModel, XiaoaiSpeakerManager } from '../src/xiaoai/speaker-verify.js';
import {
  buildXiaoaiSshArgs,
  parseXiaoaiSshTargets,
  resolveXiaoaiSshControlPath,
} from '../src/xiaoai/ssh.js';
import {
  bumpXiaoaiSpeechEpoch,
  handleXiaoaiKeywordWake,
  isXiaoaiSpeakingSelfEcho,
  sendXiaoaiSpeech,
} from '../src/xiaoai/tts-player.js';
import { shouldInterceptXiaoaiQuery } from '../src/xiaoai/utterance-utils.js';

const execFileAsync = promisify(execFile);

function makeChannel(overrides: Partial<ImChannelConfig> = {}): ImChannelConfig {
  const now = Date.now();
  return {
    id: overrides.id ?? 'ch-test',
    platform: overrides.platform ?? 'wechat',
    name: overrides.name ?? '测试通道',
    enabled: overrides.enabled ?? true,
    notifyAll: overrides.notifyAll ?? false,
    allowedSenders: overrides.allowedSenders ?? [],
    inboundCount: overrides.inboundCount ?? 0,
    outboundCount: overrides.outboundCount ?? 0,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
}

function synthToneSamples(freqHz: number, durationMs: number, amp = 0.2, sampleRate = 16_000): Float32Array {
  const count = Math.round((durationMs / 1000) * sampleRate);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = freqHz > 0 ? amp * Math.sin((2 * Math.PI * freqHz * i) / sampleRate) : 0;
  }
  return out;
}

function createBandExtractorFactory() {
  return () => ({
    dim: 3,
    extract: (samples: Float32Array) => {
      let cLow = 0;
      let sLow = 0;
      let cMid = 0;
      let sMid = 0;
      let cHigh = 0;
      let sHigh = 0;
      for (let i = 0; i < samples.length; i++) {
        const x = samples[i] ?? 0;
        const t = i / 16_000;
        cLow += x * Math.cos(2 * Math.PI * 200 * t);
        sLow += x * Math.sin(2 * Math.PI * 200 * t);
        cMid += x * Math.cos(2 * Math.PI * 800 * t);
        sMid += x * Math.sin(2 * Math.PI * 800 * t);
        cHigh += x * Math.cos(2 * Math.PI * 3200 * t);
        sHigh += x * Math.sin(2 * Math.PI * 3200 * t);
      }
      return new Float32Array([
        Math.hypot(cLow, sLow) + 1e-6,
        Math.hypot(cMid, sMid) + 1e-6,
        Math.hypot(cHigh, sHigh) + 1e-6,
      ]);
    },
    free: () => {},
  });
}

test('IM Gateway blocks polling/SSH webhooks, browser CSRF, missing secret, malformed JSON, and DingTalk replay', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-im-wh-hard-'));
  const store = new Store(home);
  try {
    const gateway = new ImGateway({
      store,
      homeDir: home,
      chat: () => ({ id: 'm1', role: 'user', text: 'ok', status: 'queued', mode: 'offline', paths: [], version: 1, createdAt: Date.now(), updatedAt: Date.now() }),
    } as any);

    // 1. Polling/SSH channels must never accept webhook posts even if secret is set
    gateway.saveChannel({
      id: 'wx-ilink-poll',
      platform: 'wechat',
      name: '微信扫码轮询',
      botToken: 'secret-ilink-token',
      secret: 'should-not-open-webhook',
    });
    const wxPollRes = await gateway.handleWebhook('wx-ilink-poll', 'POST', new URLSearchParams(), {}, '{}');
    assert.equal(wxPollRes.status, 403);

    gateway.saveChannel({
      id: 'tg-poll',
      platform: 'telegram',
      name: 'Telegram轮询',
      botToken: '123:ABC',
      secret: 'tg-sec',
    });
    const tgPollRes = await gateway.handleWebhook('tg-poll', 'POST', new URLSearchParams(), { 'x-telegram-bot-api-secret-token': 'tg-sec' }, '{}');
    assert.equal(tgPollRes.status, 403);

    gateway.saveChannel({
      id: 'xa-ssh',
      platform: 'xiaoai',
      name: '小爱SSH',
      apiBase: 'ssh://oh2p=root@192.0.2.10',
      secret: 'xa-sec',
    });
    const xaPollRes = await gateway.handleWebhook('xa-ssh', 'POST', new URLSearchParams(), { 'x-xiaoai-secret': 'xa-sec' }, '{}');
    assert.equal(xaPollRes.status, 403);

    // 2. Webhook channel without secret must return 403
    gateway.saveChannel({
      id: 'ding-nosec',
      platform: 'dingtalk',
      name: '钉钉无密钥',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
    });
    const noSecRes = await gateway.handleWebhook('ding-nosec', 'POST', new URLSearchParams(), {}, '{"text":{"content":"hi"}}');
    assert.equal(noSecRes.status, 403);

    // 3. Browser cross-origin headers blocked even with valid secret
    gateway.saveChannel({
      id: 'ding-sec',
      platform: 'dingtalk',
      name: '钉钉签名',
      webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
      secret: 'SEC-ding',
    });
    const ts = String(Date.now());
    const sign = createHmac('sha256', 'SEC-ding').update(`${ts}\nSEC-ding`).digest('base64');
    const csrfRes = await gateway.handleWebhook(
      'ding-sec',
      'POST',
      new URLSearchParams(),
      { timestamp: ts, sign, origin: 'https://evil.example' },
      '{"text":{"content":"hi"}}',
    );
    assert.equal(csrfRes.status, 403);

    // 4. DingTalk stale timestamp (> 1h) rejected even with matching HMAC signature
    const staleTs = String(Date.now() - 2 * 3_600_000);
    const staleSign = createHmac('sha256', 'SEC-ding').update(`${staleTs}\nSEC-ding`).digest('base64');
    const staleRes = await gateway.handleWebhook(
      'ding-sec',
      'POST',
      new URLSearchParams(),
      { timestamp: staleTs, sign: staleSign },
      '{"text":{"content":"hi"}}',
    );
    assert.equal(staleRes.status, 403);

    // 5. Malformed JSON payloads return 400 cleanly instead of throwing 500
    const badDing = await gateway.handleWebhook(
      'ding-sec',
      'POST',
      new URLSearchParams(),
      { timestamp: ts, sign },
      '{not-json',
    );
    assert.equal(badDing.status, 400);

    gateway.saveChannel({
      id: 'tg-wh',
      platform: 'telegram',
      name: 'Telegram Webhook',
      webhookUrl: 'http://127.0.0.1:9999/tg',
      secret: 'tg-wh-sec',
    });
    const badTg = await gateway.handleWebhook(
      'tg-wh',
      'POST',
      new URLSearchParams(),
      { 'x-telegram-bot-api-secret-token': 'tg-wh-sec' },
      '[]',
    );
    assert.equal(badTg.status, 400);

    gateway.saveChannel({
      id: 'wx-wh',
      platform: 'wechat',
      name: '微信Webhook',
      webhookUrl: 'http://127.0.0.1:9999/wx',
      secret: 'wx-wh-sec',
    });
    const badWx = await gateway.handleWebhook(
      'wx-wh',
      'POST',
      new URLSearchParams(),
      { 'x-wechat-secret': 'wx-wh-sec' },
      '{bad',
    );
    assert.equal(badWx.status, 400);

    gateway.saveChannel({
      id: 'xa-wh',
      platform: 'xiaoai',
      name: '小爱Webhook',
      webhookUrl: 'http://127.0.0.1:9999/xa',
      secret: 'xa-wh-sec',
    });
    const badXa = await gateway.handleWebhook(
      'xa-wh',
      'POST',
      new URLSearchParams(),
      { 'x-xiaoai-secret': 'xa-wh-sec' },
      'null',
    );
    assert.equal(badXa.status, 400);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('SSRF and Bearer credential exfiltration guards on replyWebhook / sessionWebhook and XML entity decoding', async () => {
  assert.equal(isAllowedReplyWebhook('dingtalk', 'https://oapi.dingtalk.com/robot/sendBySession?session=1'), true);
  assert.equal(isAllowedReplyWebhook('dingtalk', 'http://127.0.0.1:3800/api/secret'), false);
  assert.equal(isAllowedReplyWebhook('wechat', 'http://169.254.169.254/latest/meta-data'), false);
  assert.equal(isAllowedReplyWebhook('wechat', 'https://attacker.evil/steal'), false);
  assert.equal(isAllowedReplyWebhook('xiaoai', 'http://127.0.0.1:8080/tts', { webhookUrl: 'http://127.0.0.1:8080/hook' }), true);
  assert.equal(isAllowedReplyWebhook('xiaoai', 'http://127.0.0.1:9090/tts', { webhookUrl: 'http://127.0.0.1:8080/hook' }), false);

  const capturedHeaders: Array<Record<string, unknown>> = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    capturedHeaders.push({ url: req.url, auth: req.headers['authorization'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const origin = `http://127.0.0.1:${addr.port}`;

  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-ssrf-exfil-'));
  const store = new Store(home);
  try {
    const ingested: string[] = [];
    const ctx = {
      homeDir: home,
      coordinator: { store },
      shutdownSignal: new AbortController().signal,
      isClosing: () => false,
      markMessageDelivered: () => {},
      clearMessageDelivered: () => {},
      getSeenMessageVersion: () => -1,
      sendToChannel: async () => {},
      ingestMessage: async (inbound: { text: string }) => {
        ingested.push(inbound.text);
        return { ok: true, action: 'routed_to_chat', messageId: 'm-1' };
      },
      markTrustedWechatInbound: () => {},
      scheduleChannelPoll: () => {},
      runVoiceFastpath: async () => undefined,
    } as any;

    const wxAdapter = new WechatWebhookAdapter(ctx);
    const wxChannel = makeChannel({
      id: 'wx-exfil',
      platform: 'wechat',
      botToken: 'top-secret-wx-token',
      webhookUrl: `${origin}/hook`,
      secret: 'wx-sec',
    });

    // Reject untrusted replyWebhook cleanly
    await assert.rejects(
      () => wxAdapter.send(wxChannel, 'hello', { replyWebhook: 'https://evil.example.com/steal' }),
      /未授权/,
    );

    // Same-origin dynamic replyWebhook != configured webhookUrl must NEVER receive Bearer botToken
    await wxAdapter.send(wxChannel, 'hello', { replyWebhook: `${origin}/dynamic-session` });
    assert.equal(capturedHeaders[0]?.url, '/dynamic-session');
    assert.equal(capturedHeaders[0]?.auth, undefined);

    // Configured webhookUrl itself receives Bearer botToken as expected
    await wxAdapter.send(wxChannel, 'hello');
    assert.equal(capturedHeaders[1]?.url, '/hook');
    assert.equal(capturedHeaders[1]?.auth, 'Bearer top-secret-wx-token');

    // XML entity decoding
    const xmlRes = await wxAdapter.handleWebhook(
      wxChannel,
      'POST',
      new URLSearchParams(),
      { 'x-wechat-secret': 'wx-sec' },
      '<xml><FromUserName>u1</FromUserName><Content>a &lt; b &amp;&amp; c &gt; d</Content><MsgId>xm1</MsgId></xml>',
    );
    assert.equal(xmlRes.status, 200);
    assert.equal(ingested[0], 'a < b && c > d');

    // XiaoAI tts-player must not send Authorization to dynamic replyWebhook or untrusted host
    const xaChannel = makeChannel({
      id: 'xa-exfil',
      platform: 'xiaoai',
      botToken: 'mi-secret-token',
      webhookUrl: `${origin}/xa-hook`,
    });
    await assert.rejects(
      () => sendXiaoaiSpeech(xaChannel, '你好', { replyWebhook: 'http://169.254.169.254/metadata' }),
      /未授权/,
    );
    await sendXiaoaiSpeech(xaChannel, '你好', { replyWebhook: `${origin}/xa-dynamic` });
    assert.equal(capturedHeaders.at(-1)?.auth, undefined);

    // Reply filter hides xiaoai-kws / plugins / state.sqlite paths
    const sanitized = sanitizePublicReply(`读取 ${home}/xiaoai-kws/speakers.json 和 ${home}/plugins/tv-ir/cfg.json 与 ${home}/state.sqlite`, [], home);
    assert.ok(!sanitized.includes('speakers.json'));
    assert.ok(!sanitized.includes('tv-ir'));
    assert.ok(!sanitized.includes('state.sqlite'));
  } finally {
    store.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test('Allowlist blocks spoofed senderName/unprefixed username, blocks group /start defaultTarget hijack, enforces Telegram /file, and resets cursors on rebind', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-auth-hard-'));
  const store = new Store(home);
  const chatMessages: string[] = [];
  let tgSendCalls = 0;
  let tgDocCalls = 0;

  const mockTg = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    if (url.includes('/sendMessage')) tgSendCalls++;
    if (url.includes('/sendDocument')) tgDocCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  });
  await new Promise<void>(resolve => mockTg.listen(0, '127.0.0.1', resolve));
  const addr = mockTg.address();
  assert.ok(addr && typeof addr !== 'string');
  const tgApiBase = `http://127.0.0.1:${addr.port}`;

  try {
    const gateway = new ImGateway({
      store,
      homeDir: home,
      chat: (_reqId: string, text: string) => {
        chatMessages.push(text);
        return { id: `u-${chatMessages.length}`, role: 'user', text, status: 'completed', mode: 'offline', paths: [], version: 1, createdAt: Date.now(), updatedAt: Date.now() };
      },
    } as any);

    const ch = gateway.saveChannel({
      id: 'tg-strict',
      platform: 'telegram',
      name: 'TG Strict',
      botToken: '111:TOKEN_A',
      apiBase: tgApiBase,
      allowedSenders: ['9001', '@realuser'],
      pollIntervalMs: 60_000,
    });
    assert.equal(ch.defaultTarget, undefined);

    // 1. Spoofed senderName matching '@realuser' or '9001' must be rejected!
    const spoofNameRes = await gateway.ingestMessage({
      channelId: 'tg-strict',
      externalId: 'spoof-1',
      senderId: '6666',
      senderName: '@realuser',
      target: '6666',
      text: 'hijack',
    });
    assert.equal(spoofNameRes.ok, false);
    assert.equal(spoofNameRes.reason, 'sender_not_allowed');

    const spoofNoUsernameRes = await gateway.ingestMessage({
      channelId: 'tg-strict',
      externalId: 'spoof-2',
      senderId: '6666',
      senderName: '9001',
      target: '6666',
      text: 'hijack',
    });
    assert.equal(spoofNoUsernameRes.ok, false);
    assert.equal(spoofNoUsernameRes.reason, 'sender_not_allowed');

    // Unprefixed username rule must not match senderName or unprefixed senderUsername
    gateway.saveChannel({
      id: 'wx-strict',
      platform: 'wechat',
      name: 'WX Strict',
      allowedSenders: ['wx-owner'],
    });
    const wxSpoof = await gateway.ingestMessage({
      channelId: 'wx-strict',
      externalId: 'wx-sp-1',
      senderId: 'wx-attacker',
      senderName: 'wx-owner',
      senderUsername: 'wx-owner',
      target: 'wx-attacker',
      text: 'hijack',
    });
    assert.equal(wxSpoof.ok, false);
    assert.equal(wxSpoof.reason, 'sender_not_allowed');

    // Empty allowedSenders channel must not let stranger first packet or /start hijack defaultTarget
    gateway.saveChannel({
      id: 'tg-open',
      platform: 'telegram',
      name: 'TG Open',
      botToken: '111:TOKEN_OPEN',
      apiBase: tgApiBase,
      allowedSenders: [],
      pollIntervalMs: 60_000,
    });
    await gateway.ingestMessage({
      channelId: 'tg-open',
      externalId: 'open-start',
      senderId: '7777',
      target: '7777',
      text: '/start',
    });
    assert.equal(store.getImChannel('tg-open').defaultTarget, undefined);

    // 2. Group chat /start must NOT hijack defaultTarget either
    const groupStart = await gateway.ingestMessage({
      channelId: 'tg-strict',
      externalId: 'grp-1',
      senderId: '9001',
      target: '-100999', // group chat ID != senderId
      text: '/start',
    });
    assert.equal(groupStart.ok, true);
    assert.equal(store.getImChannel('tg-strict').defaultTarget, undefined);

    // 3. Telegram /file rejected in group chat and succeeds when webhookUrl is also set in private DM
    const groupFile = await gateway.ingestMessage({
      channelId: 'tg-strict',
      externalId: 'grp-file',
      senderId: '9001',
      target: '-100999',
      text: '/file secret.txt',
    });
    assert.equal(groupFile.ok, false);
    assert.equal(groupFile.reason, 'attachment_not_authorized');

    const rootDir = gateway.wechatAttachmentDir()!;
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    await writeFile(join(rootDir, 'note.txt'), 'ok');
    gateway.saveChannel({
      id: 'tg-strict',
      platform: 'telegram',
      name: 'TG Strict',
      botToken: '111:TOKEN_A',
      webhookUrl: `${tgApiBase}/custom-webhook`,
      apiBase: tgApiBase,
      allowedSenders: ['9001', '@realuser'],
      pollIntervalMs: 60_000,
    });
    const missingFileRes = await gateway.ingestMessage({
      channelId: 'tg-strict',
      externalId: 'priv-missing',
      senderId: '9001',
      target: '9001',
      text: '/file does-not-exist.txt',
    });
    assert.equal(missingFileRes.ok, false);
    assert.equal(missingFileRes.action, 'attachment_failed');
    assert.equal(missingFileRes.reason, 'delivery_failed');
    assert.ok(!(store.getImChannel('tg-strict').lastError ?? '').includes(home));

    const validFileRes = await gateway.ingestMessage({
      channelId: 'tg-strict',
      externalId: 'priv-ok',
      senderId: '9001',
      target: '9001',
      text: '/file note.txt',
    });
    assert.equal(validFileRes.ok, true);
    assert.equal(validFileRes.action, 'attachment_sent');
    assert.equal(tgDocCalls, 1);
    assert.ok(tgSendCalls >= 1);

    // 4. Rebinding botToken clears syncBuf / pollOffset / contextTokens
    const rawCh = store.getImChannel('tg-strict');
    rawCh.pollOffset = 999;
    rawCh.syncBuf = 'old-sync';
    rawCh.contextTokens = { u1: 'ctx-1' };
    rawCh.contextTokenUpdatedAt = { u1: Date.now() };
    store.saveImChannel(rawCh);

    gateway.saveChannel({
      id: 'tg-strict',
      platform: 'telegram',
      name: 'TG Strict',
      botToken: '222:TOKEN_B',
      apiBase: tgApiBase,
      allowedSenders: ['9001'],
      pollIntervalMs: 60_000,
    });
    const rebound = store.getImChannel('tg-strict');
    assert.equal(rebound.pollOffset, undefined);
    assert.equal(rebound.syncBuf, undefined);
    assert.deepEqual(rebound.contextTokens ?? {}, {});

    // 5. splitTelegramText never returns pure whitespace chunks
    const splitChunks = splitTelegramText(`${'A'.repeat(3990)}${'   \n\n   '.repeat(20)}`, 4000);
    assert.ok(splitChunks.length >= 1);
    for (const chunk of splitChunks) {
      assert.ok(chunk.trim().length > 0);
    }

    // 6. qrcode rejects > 271B payload loudly
    assert.throws(() => renderQrSvgDataUrl('X'.repeat(300)), /capacity|exceeds/i);
  } finally {
    store.close();
    await new Promise<void>(resolve => mockTg.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test('WeChat iLink auth-expired stops spinning, pollOffset updates only after ingest, removeChannel stops KWS, and outbound cursor + retry recover safely', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-ilink-out-hard-'));
  const store = new Store(home);
  const origEnv = process.env.SUPER_AGENT_WECHAT_ATTACHMENT_DIR;
  try {
    // 1. SUPER_AGENT_WECHAT_ATTACHMENT_DIR respected
    const customDir = join(home, 'legacy-wx-files');
    process.env.SUPER_AGENT_WECHAT_ATTACHMENT_DIR = customDir;
    const gwEnv = new ImGateway({ store, homeDir: home } as any);
    assert.equal(gwEnv.wechatAttachmentDir(), customDir);
    await gwEnv.close();
  } finally {
    if (origEnv === undefined) delete process.env.SUPER_AGENT_WECHAT_ATTACHMENT_DIR;
    else process.env.SUPER_AGENT_WECHAT_ATTACHMENT_DIR = origEnv;
  }

  let getUpdatesCalls = 0;
  const mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    if (url.includes('/ilink/bot/getupdates')) {
      getUpdatesCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ret: 0, errcode: -14, errmsg: 'session timeout' }));
      return;
    }
    if (url.includes('/bot999:MYSECRET/getUpdates')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        result: [{ update_id: 77, message: { message_id: 1, from: { id: 9001 }, chat: { id: 9001 }, text: 'hi' } }],
      }));
      return;
    }
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const addr = mockServer.address();
  assert.ok(addr && typeof addr !== 'string');
  const mockOrigin = `http://127.0.0.1:${addr.port}`;

  try {
    // 2. WeChat iLink errcode=-14 triggers authExpired -> disables channel and stops polling loop
    const gw1 = new ImGateway({ store, homeDir: home } as any);
    gw1.saveChannel({
      id: 'wx-expired',
      platform: 'wechat',
      name: '微信过期测试',
      botToken: 'bot-secret-tok',
      apiBase: mockOrigin,
      pollIntervalMs: 50,
    });
    gw1.start();
    await delay(180);
    const chAfter = store.getImChannel('wx-expired');
    assert.equal(chAfter.enabled, false);
    assert.match(chAfter.lastError ?? '', /过期|失效/);
    assert.equal(getUpdatesCalls, 1, 'authExpired channel must stop spinning after first -14');
    await gw1.close();

    // 3. Telegram pollOffset must NOT advance if ingestMessage throws
    const tgAdapter = new TelegramChannelAdapter({
      homeDir: home,
      coordinator: { store },
      shutdownSignal: new AbortController().signal,
      isClosing: () => false,
      markMessageDelivered: () => {},
      clearMessageDelivered: () => {},
      getSeenMessageVersion: () => -1,
      sendToChannel: async () => {},
      ingestMessage: async () => { throw new Error('DB busy'); },
      markTrustedWechatInbound: () => {},
      scheduleChannelPoll: () => {},
      runVoiceFastpath: async () => undefined,
    } as any);
    store.saveImChannel(makeChannel({
      id: 'tg-cursor',
      platform: 'telegram',
      name: 'TG Cursor',
      botToken: '999:MYSECRET',
      apiBase: mockOrigin,
      pollOffset: 50,
    }));
    await assert.rejects(() => tgAdapter.poll(store.getImChannel('tg-cursor')), /DB busy/);
    assert.equal(store.getImChannel('tg-cursor').pollOffset, 50);

    // 4. Outbound persistence + transient retry + draining > 60 events
    store.saveImChannel(makeChannel({
      id: 'wx-out',
      platform: 'wechat',
      name: 'WX Out',
      accountId: 'bot@im.bot',
      enabled: true,
    }));

    let failOnce = true;
    const deliveredTexts: string[] = [];
    const gw2 = new ImGateway({ store, homeDir: home } as any);
    gw2.sendToChannel = async (_channelId, text) => {
      if (text === 'msg-transient' && failOnce) {
        failOnce = false;
        throw new Error('HTTP 503 temporary');
      }
      deliveredTexts.push(text);
    };

    const origin = {
      channel: 'wechat' as const,
      channelId: 'wx-out',
      accountId: 'bot@im.bot',
      conversationId: 'boss@im.wechat',
      senderId: 'boss@im.wechat',
    };
    // Create 65 completed assistant messages + 1 transient failing message to verify >60 drain + retry
    store.conversation.create({ id: 'u-trans', role: 'user', text: 'q', status: 'completed', mode: 'offline', paths: [], origin } as any);
    store.conversation.create({ id: 'r-trans', replyTo: 'u-trans', role: 'assistant', text: 'msg-transient', status: 'completed', mode: 'offline', paths: [], origin } as any);
    for (let i = 0; i < 65; i++) {
      store.conversation.create({ id: `u-${i}`, role: 'user', text: 'q', status: 'completed', mode: 'offline', paths: [], origin } as any);
      store.conversation.create({ id: `r-${i}`, replyTo: `u-${i}`, role: 'assistant', text: `batch-${i}`, status: 'completed', mode: 'offline', paths: [], origin } as any);
    }

    await (gw2 as any).flushOutboundUpdates();
    assert.equal(deliveredTexts.length, 65, 'All 65 succeeding messages (>60 page limit) drained in single flush');

    // Persisted delivered versions survive gateway restart
    const savedDelivered = store.conversation.meta<Record<string, number>>('im_outbound_delivered');
    assert.ok(savedDelivered && savedDelivered['r-64'] !== undefined);
    // Simulate backoff elapsed for retry entry then flush again
    const retryMap = (gw2 as any).outboundRetryQueue as Map<string, { nextRetryAt: number }>;
    assert.ok(retryMap.has('r-trans'));
    retryMap.get('r-trans')!.nextRetryAt = 0;
    await (gw2 as any).flushOutboundUpdates();
    assert.ok(deliveredTexts.includes('msg-transient'));
    assert.equal(retryMap.size, 0);

    // 5. sanitizeImError scrubs bot token, Bearer token, URL credentials & query tokens
    const redacted = sanitizeImError(
      new Error('POST https://user:pw@api.telegram.org/bot123456:ABCDEF_SECRET/sendMessage?token=topsec failed Bearer xyz987'),
      ['topsec'],
    );
    assert.ok(!redacted.includes('ABCDEF_SECRET'));
    assert.ok(!redacted.includes('topsec'));
    assert.ok(!redacted.includes('xyz987'));
    assert.ok(!redacted.includes('pw@'));

    // 6. removeChannel triggers syncPollers and tears down active XiaoAI KWS workers
    let killed = 0;
    gw2.xiaoaiDeps = {
      kwsSpotterFactory: () => ({
        createStream: () => ({}),
        acceptWaveform: () => {},
        isReady: () => false,
        decode: () => {},
        getResult: () => '',
        reset: () => {},
      }),
      kwsStreamFactory: () => ({
        stdout: new PassThrough(),
        kill: () => { killed++; },
        onClose: () => {},
      }),
    };
    gw2.saveChannel({
      id: 'xa-rm',
      platform: 'xiaoai',
      name: '小爱移除',
      apiBase: 'ssh://lx06=root@192.0.2.50?kws=1',
    });
    assert.equal(gw2.getXiaoaiKwsStatus('xa-rm')?.active, true);
    assert.equal(gw2.removeChannel('xa-rm'), true);
    assert.equal(killed, 1);
    assert.equal(gw2.getXiaoaiKwsStatus('xa-rm')?.active ?? false, false);
    await gw2.close();
  } finally {
    store.close();
    await new Promise<void>(resolve => mockServer.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoAI voiceprint management fails closed, speaker-verify handles corrupt registry/missing model/dip hysteresis/download cap', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-sec-'));
  const store = new Store(home);
  try {
    // 1. Corrupt speakers.json and missing ONNX model fail CLOSED
    const kwsDir = join(home, 'xiaoai-kws');
    await mkdir(kwsDir, { recursive: true });
    await writeFile(join(kwsDir, 'speakers.json'), '{CORRUPT_JSON');
    const corruptMgr = new XiaoaiSpeakerManager({ homeDir: home, extractorFactory: createBandExtractorFactory() });
    assert.equal(corruptMgr.isVerificationActive(), true);
    const corruptUtterance = corruptMgr.matchSamples(synthToneSamples(200, 1200));
    assert.equal(corruptUtterance.matched, false);
    assert.equal(corruptUtterance.reason, 'registry_corrupt');
    assert.equal(corruptUtterance.speaker, undefined);
    assert.equal(corruptMgr.verifyWakeSlice(synthToneSamples(200, 650), 16_000, '星期五').matched, false);
    corruptMgr.close();

    // Missing ONNX model when valid profiles exist -> Fail-Closed!
    const validHome = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-nomodel-'));
    try {
      const seedMgr = new XiaoaiSpeakerManager({ homeDir: validHome, extractorFactory: createBandExtractorFactory() });
      const ownerEmb = seedMgr.extractEmbedding(synthToneSamples(200, 1200))!;
      seedMgr.enrollEmbeddings({ name: '主人', role: 'owner', embeddings: [ownerEmb] });
      seedMgr.close();

      // Reopen WITHOUT extractorFactory and WITHOUT model on disk
      const noModelMgr = new XiaoaiSpeakerManager({ homeDir: validHome });
      assert.equal(noModelMgr.isModelReady(), false);
      assert.equal(noModelMgr.isVerificationActive(), true);
      const res = noModelMgr.matchSamples(synthToneSamples(200, 1200));
      assert.equal(res.matched, false);
      assert.equal(res.reason, 'model_missing');
      noModelMgr.close();
    } finally {
      await rm(validHome, { recursive: true, force: true });
    }

    // 2. Single mid-sentence dip hysteresis & never attaching speaker when matched=false
    const hystHome = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-hyst-'));
    try {
      const hystMgr = new XiaoaiSpeakerManager({ homeDir: hystHome, extractorFactory: createBandExtractorFactory() });
      const ownerEmb = hystMgr.extractEmbedding(synthToneSamples(200, 1200))!;
      hystMgr.enrollEmbeddings({ name: '主人', role: 'owner', embeddings: [ownerEmb] });

      // Below threshold never leaks owner speaker object
      const tvCheck = hystMgr.matchSamples(synthToneSamples(3200, 1200));
      assert.equal(tvCheck.matched, false);
      assert.equal(tvCheck.speaker, undefined);

      // Build clip: 1.3s owner + 0.5s brief dip (quiet pause/3200Hz) + 1.5s owner -> should recover without cutting at dip!
      const ownerA = synthToneSamples(200, 1300, 0.2);
      const briefDip = synthToneSamples(3200, 450, 0.2);
      const ownerB = synthToneSamples(200, 1600, 0.2);
      const dipAudio = new Float32Array(ownerA.length + briefDip.length + ownerB.length);
      dipAudio.set(ownerA, 0);
      dipAudio.set(briefDip, ownerA.length);
      dipAudio.set(ownerB, ownerA.length + briefDip.length);
      const dipRes = hystMgr.verifyAndTrimUtterance(dipAudio, 16_000);
      assert.equal(dipRes.matched, true);
      assert.equal(dipRes.trimmed, false, 'Single mid-sentence brief dip must recover instead of truncating utterance');
      hystMgr.close();
    } finally {
      await rm(hystHome, { recursive: true, force: true });
    }

    // 3. ensureXiaoaiSpeakerModel rejects oversized content-length cleanly
    await assert.rejects(
      () => ensureXiaoaiSpeakerModel({
        homeDir: home,
        speakerModelsDir: join(home, 'oversize-model'),
        fetchImpl: async () => new Response('x', { status: 200, headers: { 'content-length': String(120 * 1024 * 1024) } }),
      }),
      /超出上限/,
    );

    // 4. xiaoai.ts strict fail-closed voice management, suppressed unverified SSH polling, and member fastpath filter
    const mgrHome = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-auth-'));
    try {
      const m = new XiaoaiSpeakerManager({ homeDir: mgrHome, extractorFactory: createBandExtractorFactory() });
      const ownerEmb = m.extractEmbedding(synthToneSamples(200, 1200))!;
      m.enrollEmbeddings({ name: '主人', role: 'owner', embeddings: [ownerEmb] });
      m.close();

      let sshPollCount = 0;
      const fastpathPluginsCalled: string[] = [];
      let recordedTurnRole: string | undefined;
      const store2 = new Store(mgrHome);
      try {
        const gw = new ImGateway({
          store: store2,
          homeDir: mgrHome,
          chat: (_r: string, text: string) => ({
            id: `u-${Date.now()}`, role: 'user', text, status: 'completed', mode: 'offline', paths: [], version: 1, createdAt: Date.now(), updatedAt: Date.now(),
          }),
          recordFastpathTurn: (input: { origin?: { speakerRole?: string } }) => {
            recordedTurnRole = input.origin?.speakerRole;
            return { userMessage: { id: 'fp-u1' }, replyMessage: { id: 'fp-r1' } };
          },
        } as any);
        const fastpathResults = new Map<string, any>([
          ['private-notes', { handled: true, ok: true, plugin: 'fund-tracker', action: 'get', speech: '资产100万' }],
          ['public-miot', { handled: true, ok: true, plugin: 'miot', action: 'set', speech: '已开灯' }],
        ]);
        (gw as any).ctx.runVoiceFastpath = async (req: { text: string; speakerRole?: string }) => {
          fastpathPluginsCalled.push(`${req.text}:${req.speakerRole ?? 'none'}`);
          return req.text.includes('资产') ? fastpathResults.get('private-notes') : fastpathResults.get('public-miot');
        };
        gw.xiaoaiDeps = {
          speakerExtractorFactory: createBandExtractorFactory(),
          sshRunner: async () => {
            sshPollCount++;
            return { stdout: '', stderr: '', code: 0 };
          },
        };
        const xaCh = gw.saveChannel({
          id: 'xa-auth',
          platform: 'xiaoai',
          name: '小爱权限',
          apiBase: 'ssh://lx06=root@192.0.2.104?kws=1',
        });

        // Suppress unverified SSH instruction.log poll when speaker gate is enforced even without active kwsMonitor worker!
        await (gw as any).xiaoaiAdapter.poll(store2.getImChannel(xaCh.id));
        assert.equal(sshPollCount, 0);

        // Unverified (speaker === undefined) & member denied on all management commands once profiles exist
        for (const text of ['删除主人的声纹', '清空所有声纹', '暂停声纹识别', '查看声纹列表', '帮小偷录入声纹']) {
          const unverified = await gw.ingestMessage({
            channelId: 'xa-auth',
            externalId: `unv-${text}`,
            senderId: 'lx06',
            target: 'lx06',
            text,
          });
          assert.match(unverified.action, /denied/);
          const member = await gw.ingestMessage({
            channelId: 'xa-auth',
            externalId: `mem-${text}`,
            senderId: 'lx06',
            target: 'lx06',
            text,
            speaker: { id: 's-mem', name: '访客', role: 'member', score: 0.7 },
          });
          assert.match(member.action, /denied/);
        }

        // Member is blocked from private non-whitelist fastpaths (fund-tracker) and allowed public miot with speakerRole propagated
        const blockedFp = await gw.ingestMessage({
          channelId: 'xa-auth',
          externalId: 'mem-priv-fp',
          senderId: 'lx06',
          target: 'lx06',
          text: '查我的资产',
          speaker: { id: 's-mem', name: '访客', role: 'member', score: 0.7 },
        });
        assert.equal(blockedFp.ok, false);
        assert.equal(blockedFp.action, 'voice_fastpath_denied');

        const allowedFp = await gw.ingestMessage({
          channelId: 'xa-auth',
          externalId: 'mem-pub-fp',
          senderId: 'lx06',
          target: 'lx06',
          text: '打开客厅灯',
          speaker: { id: 's-mem', name: '访客', role: 'member', score: 0.7 },
        });
        assert.equal(allowedFp.ok, true);
        assert.equal(recordedTurnRole, 'member');
        assert.ok(fastpathPluginsCalled.some(entry => entry.endsWith(':member')));
        await gw.close();
      } finally {
        store2.close();
      }
    } finally {
      await rm(mgrHome, { recursive: true, force: true });
    }
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoAI utterance prefix stripping, TTS probe fallback/unknown target/chime serialization, Cloud HTTPS, KWS stream races, SSH IPv6 & bridge script dedupe', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-tts-kws-'));
  try {
    // 1. Default mode utterance stripping without ?prefix=
    assert.deepEqual(shouldInterceptXiaoaiQuery('你好星期五，打开客厅灯'), { intercept: true, query: '打开客厅灯' });
    assert.deepEqual(shouldInterceptXiaoaiQuery('星期五，暂停'), { intercept: true, query: '暂停' });
    assert.deepEqual(shouldInterceptXiaoaiQuery('星期五'), { intercept: false, query: '' });
    assert.deepEqual(shouldInterceptXiaoaiQuery('星期五要下雨吗'), { intercept: true, query: '星期五要下雨吗' });
    assert.deepEqual(shouldInterceptXiaoaiQuery('打开客厅灯'), { intercept: false, query: '' });

    // 2. Cloud HTTPS check
    assert.throws(() => getCloudBases('http://remote-xiaomi.example.com'), /HTTPS/);
    assert.doesNotThrow(() => getCloudBases('http://127.0.0.1:8080'));

    // 3. TTS player: unknown explicit target rejects, probe unknown retains speech guard & spacing, wake(chime=false) serializes before TTS
    const xaChannel = makeChannel({
      id: 'xa-tts-hard',
      platform: 'xiaoai',
      apiBase: 'ssh://oh2p=root@192.0.2.10,lx06=root@192.0.2.11',
      defaultTarget: 'oh2p',
    });
    await assert.rejects(
      () => sendXiaoaiSpeech(xaChannel, '你好', { target: 'missing-room', sshRunner: async () => ({ stdout: '', stderr: '', code: 0 }) }),
      /未找到匹配的小爱 SSH 目标设备/,
    );

    const callOrder: string[] = [];
    const wakePromise = handleXiaoaiKeywordWake({
      channel: xaChannel,
      target: { id: 'oh2p', userHost: 'root@192.0.2.10' },
      keyword: '星期五',
      chime: false,
      sshRunner: async (_t, cmd) => {
        await delay(50);
        callOrder.push(cmd.includes('pause') ? 'wake-pause-done' : 'wake-other');
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    const speechPromise = sendXiaoaiSpeech(xaChannel, '好的，已开启', {
      target: 'oh2p',
      sshRunner: async (_t, cmd) => {
        callOrder.push(cmd.includes('text_to_speech') ? 'tts-start' : 'other');
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    await Promise.all([wakePromise, speechPromise]);
    assert.deepEqual(callOrder, ['wake-pause-done', 'tts-start']);

    // Unknown probe status preserves full estimated speaking guard instead of squashing to 350ms
    bumpXiaoaiSpeechEpoch('xa-tts-hard', 'lx06');
    await sendXiaoaiSpeech(xaChannel, '这是一段测试语音内容。', {
      target: 'lx06',
      waitForCompletion: true,
      sshRunner: async (_t, cmd) => {
        if (cmd.includes('player_get_play_status')) {
          return { stdout: '', stderr: '', code: 0 }; // immediate unknown
        }
        return { stdout: '', stderr: '', code: 0 };
      },
    });
    // Speaking guard retained cleanly -> self-echo still blocked well past 350ms!
    assert.equal(isXiaoaiSpeakingSelfEcho('xa-tts-hard', 'lx06', '星期五', Date.now() + 1_200), true);

    // 4. KWS Monitor: tryAsrWakeRescue rejects borderline < threshold; stale onClose does not wipe newer stream; startWorkerStream kills on throw
    let killCount = 0;
    let firstOnClose: ((code: number | null) => void) | undefined;
    let streamSeq = 0;
    let rescueAsrCalls = 0;
    const monitor = new XiaoaiKwsMonitor({
      homeDir: home,
      cooldownMs: 10,
      asrWakeRescue: true,
      streamFactory: () => {
        streamSeq++;
        const thisSeq = streamSeq;
        const stream = new PassThrough();
        const handle: XiaoaiKwsStreamHandle = {
          stdout: stream,
          sampleFormat: 's16le',
          kill: () => {
            killCount++;
            stream.end();
          },
          onClose: (cb) => {
            if (thisSeq === 1) firstOnClose = cb;
          },
        };
        return handle;
      },
      spotterFactory: () => ({
        createStream: () => ({}),
        acceptWaveform: () => {},
        isReady: () => false,
        decode: () => {},
        getResult: () => '',
        reset: () => {},
      }),
      recognizerFactory: () => ({
        transcribe: async () => {
          rescueAsrCalls++;
          return '星期五';
        },
      }),
      speakerGate: {
        isActive: () => true,
        verifyWake: () => ({ matched: false, score: 0.27, threshold: 0.34 }),
        verifyUtterance: () => ({ matched: false, score: 0.27, threshold: 0.34 }),
      },
    });
    monitor.sync([makeChannel({ id: 'xa-kws', platform: 'xiaoai', apiBase: 'ssh://oh2p=root@192.0.2.10?kws=1' })]);
    const worker = [...(monitor as any).workers.values()][0];
    assert.ok(worker?.stream);
    const currentStream = worker.stream;
    // Simulate replaced newer stream: firing old stream #1's onClose after worker.stream changed must be ignored!
    const fakeNewStream = { ...currentStream };
    worker.stream = fakeNewStream;
    firstOnClose?.(0);
    assert.equal(worker.stream, fakeNewStream, 'Stale onClose must not clear replaced worker.stream');

    // Borderline score 0.27 < 0.34 must NOT invoke ASR wake rescue
    await (monitor as any).tryAsrWakeRescue(worker, (monitor as any).spotter, synthToneSamples(200, 600), 0.1, ++worker.kwsRescueId);
    assert.equal(rescueAsrCalls, 0);

    // startWorkerStream kills created handle if createStream() throws
    let orphanKilled = false;
    const orphanMonitor = new XiaoaiKwsMonitor({
      homeDir: home,
      streamFactory: () => ({
        stdout: new PassThrough(),
        kill: () => { orphanKilled = true; },
        onClose: () => {},
      }),
      spotterFactory: () => ({
        createStream: () => { throw new Error('spotter boom'); },
        acceptWaveform: () => {},
        isReady: () => false,
        decode: () => {},
        getResult: () => '',
        reset: () => {},
      }),
    });
    orphanMonitor.sync([makeChannel({ id: 'xa-orphan', platform: 'xiaoai', apiBase: 'ssh://oh2p=root@192.0.2.10?kws=1' })]);
    assert.equal(orphanKilled, true);

    monitor.close();
    orphanMonitor.close();

    // 5. SSH hardening: IPv6 + port, reject leading '-', '--' separator, ControlPath < 100 bytes
    const parsedTargets = parseXiaoaiSshTargets('ssh://v6=root@[fd00::1]:2222,bad=-oProxyCommand=id@evil,plain=root@192.0.2.1');
    assert.deepEqual(parsedTargets, [
      { id: 'v6', userHost: 'root@[fd00::1]', port: 2222 },
      { id: 'plain', userHost: 'root@192.0.2.1' },
    ]);
    const sshArgs = buildXiaoaiSshArgs(parsedTargets[0]!, 'echo ok');
    assert.equal(sshArgs[sshArgs.indexOf('root@[fd00::1]') - 1], '--');
    assert.throws(() => buildXiaoaiSshArgs({ id: 'bad', userHost: '-oProxyCommand=pwn@host' }, 'echo'), /无效的 SSH/);
    const longHome = join(home, 'a'.repeat(90));
    const ctlPath = resolveXiaoaiSshControlPath(longHome);
    assert.ok(ctlPath);
    const expandedCtlLen = Buffer.byteLength(ctlPath, 'utf8') - 2 + 40;
    assert.ok(expandedCtlLen < 100, `Expected <100 byte ControlPath, got ${expandedCtlLen}`);

    // 6. scripts/xiaoai-router-bridge.sh: syntax + monotonic log delta handles duplicate lines without replaying history + curl -K hides secret
    const logFile = join(home, 'instruction.log');
    await writeFile(logFile, '{"header":{"namespace":"SpeechRecognizer","name":"RecognizeResult"},"payload":{"is_final":true,"results":[{"text":"星期五，历史消息"}]}}\n');
    const mockBin = join(home, 'mock-bin');
    await mkdir(mockBin, { recursive: true });
    const postRecords = join(home, 'posts.log');
    const curlMock = join(mockBin, 'curl');
    await writeFile(curlMock, `#!/bin/sh
stdin_cfg=$(cat)
echo "ARGS=$*" >> "${postRecords}"
echo "CFG=$stdin_cfg" >> "${postRecords}"
`);
    await chmod(curlMock, 0o755);

    const bridgeScript = join(process.cwd(), 'scripts/xiaoai-router-bridge.sh');
    const shellCmd = `
      export PATH="${mockBin}:$PATH"
      export FRIDAY_BRIDGE_LIB_ONLY=1
      export FRIDAY_WEBHOOK_URL="http://127.0.0.1:9/hook"
      export FRIDAY_SECRET="super-hidden-secret"
      export FRIDAY_XIAOAI_LOG_FILE="${logFile}"
      . "${bridgeScript}"
      init_log_cursor
      poll_log_once
      printf '%s\\n' '{"header":{"namespace":"SpeechRecognizer","name":"RecognizeResult"},"payload":{"is_final":true,"results":[{"text":"星期五，打开灯"}]}}' >> "${logFile}"
      poll_log_once
      printf '%s\\n' '{"header":{"namespace":"SpeechRecognizer","name":"RecognizeResult"},"payload":{"is_final":true,"results":[{"text":"星期五，打开灯"}]}}' >> "${logFile}"
      poll_log_once
    `;
    await execFileAsync('sh', ['-c', shellCmd]);
    const recorded = await import('node:fs/promises').then(fs => fs.readFile(postRecords, 'utf8'));
    const lines = recorded.trim().split('\n');
    const argsLines = lines.filter(l => l.startsWith('ARGS='));
    const cfgLines = lines.filter(l => l.startsWith('CFG='));
    assert.equal(argsLines.length, 2, 'Two duplicate appended commands must both fire while baseline history must NOT replay');
    assert.ok(!argsLines.some(l => l.includes('super-hidden-secret')), 'Secret must never appear on curl argv');
    assert.ok(cfgLines.every(l => l.includes('x-xiaoai-secret: super-hidden-secret')));
    const msgIds = argsLines.map(l => /"msgId":"([^"]+)"/.exec(l)?.[1]).filter(Boolean);
    assert.equal(msgIds.length, 2);
    assert.notEqual(msgIds[0], msgIds[1], 'Identical log lines at different offsets receive distinct msgIds');

    // 7. MiOT & TV-remote shim negation/delayed guards
    assert.equal(parseXiaoaiMiotUtterance('稍后打开客厅灯'), undefined);
    assert.equal(parseXiaoaiMiotUtterance('先不开卧室灯'), undefined);
    assert.equal(parseTvRemoteEntryUtterance('不要进入遥控电视模式').matched, false);
    assert.equal(parseTvRemoteInModeUtterance('稍后按确认').kind, 'unrecognized');
    void killCount;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  sanitizeForSpeech,
  splitSpeechSegments,
  shouldInterceptXiaoaiQuery,
  parseXiaoaiSshTargets,
  isXiaoaiPollable,
  parseXiaoaiWebhookPayload,
  pollXiaoaiChannel,
  sendXiaoaiSpeech,
  type XiaoaiSshRunner,
} from '../src/xiaoai.js';
import { serve } from '../dist/server.js';
import { startWeb } from '../dist/web-server.js';
import { request } from '../dist/protocol.js';
import { Coordinator } from '../dist/coordinator.js';
import { offlineFactory } from '../src/agent.js';
import { Store, type ImChannelConfig } from '../src/store.js';
import { ImGateway } from '../src/im.js';

async function until(predicate: () => boolean | Promise<boolean>, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await delay(15);
  }
  throw new Error('Timed out waiting for XiaoAI condition');
}

function readReqBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function makeChannel(overrides: Partial<ImChannelConfig> = {}): ImChannelConfig {
  const now = Date.now();
  return {
    id: 'xiaoai-test',
    platform: 'xiaoai',
    name: '测试小爱',
    enabled: true,
    notifyAll: false,
    allowedSenders: [],
    inboundCount: 0,
    outboundCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('XiaoAI speech sanitization and segmentation', () => {
  const raw = [
    '### 今日巡检简报 🚀',
    '请看代码片段：',
    '```ts',
    'const status = "ok";',
    'console.log(status);',
    '```',
    '- **核心服务**：已就绪 [旺柴][捂脸]',
    '- `server.ts` 详情请见 [控制台日志](https://example.com/logs) 或访问 https://friday.local/panel ⚠️',
  ].join('\n');

  const clean = sanitizeForSpeech(raw);
  assert.match(clean, /代码详情已同步至控制台/);
  assert.match(clean, /控制台日志/);
  assert.match(clean, /链接见控制台/);
  assert.doesNotMatch(clean, /https?:\/\//);
  assert.doesNotMatch(clean, /console\.log/);
  assert.doesNotMatch(clean, /\[旺柴\]|\[捂脸\]|🚀|⚠️/);
  assert.doesNotMatch(clean, /###|\*\*|`/);
  assert.match(clean, /今日巡检简报/);
  assert.match(clean, /核心服务/);
  assert.match(clean, /server\.ts/);

  assert.deepEqual(splitSpeechSegments('   [旺柴] 🚀  '), []);
  assert.deepEqual(splitSpeechSegments('**你好**，系统一切正常。', 160), ['你好，系统一切正常。']);

  const longText = [
    '第一句，系统启动检查已经全部完成。',
    '第二句，网关连接保持稳定，没有发现异常中断；',
    '第三句，本地记忆检索响应耗时低于十毫秒，性能表现非常优秀，已经达到预期目标！',
    '第四句，后台巡检任务全部正常收尾。',
  ].join('');
  const segments = splitSpeechSegments(longText, 32);
  assert.ok(segments.length >= 3, `Expected >= 3 segments, got ${segments.length}`);
  for (const seg of segments) {
    assert.ok(seg.length > 0 && seg.length <= 32, `Segment exceeds maxSegmentChars (32): "${seg}" (${seg.length})`);
  }
  const rejoined = segments.join('');
  assert.match(rejoined, /第一句/);
  assert.match(rejoined, /第二句/);
  assert.match(rejoined, /第三句/);
  assert.match(rejoined, /第四句/);
});

test('XiaoAI query interception, SSH multi-speaker target parsing, pollability, and webhook parsing', () => {
  // Without prefix: native speaker commands pass through; natural language is intercepted
  for (const nativeCmd of ['音量大一点', '暂停', '定个7点闹钟', '闭嘴', '下一首']) {
    assert.deepEqual(shouldInterceptXiaoaiQuery(nativeCmd), { intercept: false, query: '' }, `Should pass through: ${nativeCmd}`);
  }
  assert.deepEqual(shouldInterceptXiaoaiQuery('小爱同学，今天深圳天气如何'), {
    intercept: true,
    query: '今天深圳天气如何',
  });

  // With prefix: only matching prefixes are intercepted and stripped (case-insensitive)
  assert.deepEqual(
    shouldInterceptXiaoaiQuery('今天天气怎么样', { prefix: '星期五,Friday' }),
    { intercept: false, query: '' },
  );
  assert.deepEqual(
    shouldInterceptXiaoaiQuery('小爱同学，星期五，帮我检查一下项目状态', { prefix: '星期五,Friday' }),
    { intercept: true, query: '帮我检查一下项目状态' },
  );
  assert.deepEqual(
    shouldInterceptXiaoaiQuery('friday: summarize today tasks', { prefix: '星期五,Friday' }),
    { intercept: true, query: 'summarize today tasks' },
  );

  // Multi-speaker SSH URI parsing
  const targets = parseXiaoaiSshTargets('ssh://oh2p=root@192.168.31.101,lx06=root@192.168.31.102:2222?prefix=星期五');
  assert.equal(targets.length, 2);
  assert.equal(targets[0]?.id, 'oh2p');
  assert.equal(targets[0]?.userHost, 'root@192.168.31.101');
  assert.equal(targets[0]?.port, undefined);
  assert.equal(targets[1]?.id, 'lx06');
  assert.equal(targets[1]?.userHost, 'root@192.168.31.102');
  assert.equal(targets[1]?.port, 2222);

  const singleTarget = parseXiaoaiSshTargets('ssh://root@192.168.31.101');
  assert.equal(singleTarget.length, 1);
  assert.equal(singleTarget[0]?.id, 'default');
  assert.equal(singleTarget[0]?.userHost, 'root@192.168.31.101');

  assert.deepEqual(parseXiaoaiSshTargets('https://api2.mina.mi.com'), []);

  // Pollability checks
  assert.equal(isXiaoaiPollable(makeChannel({ apiBase: 'ssh://oh2p=root@192.168.31.101' })), true);
  assert.equal(isXiaoaiPollable(makeChannel({ accountId: '10086', botToken: 'secret' })), true);
  assert.equal(isXiaoaiPollable(makeChannel({ webhookUrl: 'http://127.0.0.1:9999/tts' })), false);

  // Webhook payload parsing
  const parsed = parseXiaoaiWebhookPayload(
    'xiaoai-wh',
    JSON.stringify({ text: '小爱同学，星期五，汇报最新构建状态', deviceId: 'oh2p', msgId: 'wh-msg-1', prefix: '星期五' }),
  );
  assert.ok(parsed);
  assert.equal(parsed.channelId, 'xiaoai-wh');
  assert.equal(parsed.externalId, 'wh-msg-1');
  assert.equal(parsed.senderId, 'oh2p');
  assert.equal(parsed.target, 'oh2p');
  assert.equal(parsed.text, '汇报最新构建状态');

  assert.equal(
    parseXiaoaiWebhookPayload('xiaoai-wh', JSON.stringify({ text: '暂停', deviceId: 'oh2p' })),
    undefined,
  );
});

test('XiaoAI SSH dual-speaker end-to-end: baseline anti-replay, pause interrupt, task dispatch, and exact-speaker sanitized TTS', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-xiaoai-ssh-'));
  const coordinator = new Coordinator(home, offlineFactory(10));
  await coordinator.ready();

  const oh2pLogs: string[] = [
    JSON.stringify({
      header: { namespace: 'SpeechRecognizer', name: 'RecognizeResult', id: 'hist-001' },
      payload: { is_final: true, results: [{ text: '小爱同学，星期五，这是历史日志不要重放' }] },
    }),
  ];
  const lx06Logs: string[] = [];
  const sshCalls: Array<{ targetId: string; command: string }> = [];

  const sshRunner: XiaoaiSshRunner = async (target, remoteCommand) => {
    sshCalls.push({ targetId: target.id, command: remoteCommand });
    if (remoteCommand.includes('/tmp/mico_aivs_lab/instruction.log')) {
      const lines = target.id === 'oh2p' ? oh2pLogs : lx06Logs;
      return { stdout: lines.join('\n'), stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };

  try {
    // 1. Verify pollXiaoaiChannel directly establishes baseline without emitting inbound messages
    const standaloneChannel = makeChannel({
      id: 'xiaoai-direct',
      apiBase: 'ssh://oh2p=root@192.168.31.101,lx06=root@192.168.31.102?prefix=星期五',
    });
    const baseline = await pollXiaoaiChannel(standaloneChannel, { sshRunner });
    assert.equal(baseline.messages.length, 0, 'Initial SSH poll with historical logs produces no inbound messages');
    assert.ok(baseline.nextSyncBuf, 'Initial SSH poll produces baseline syncBuf cursor');

    sshCalls.length = 0;

    // 2. Register dual-speaker SSH channel on Coordinator's ImGateway
    coordinator.im.xiaoaiDeps = { sshRunner };
    coordinator.im.saveChannel({
      id: 'xiaoai-ssh-home',
      platform: 'xiaoai',
      name: '客厅书房双音箱',
      apiBase: 'ssh://oh2p=root@192.168.31.101,lx06=root@192.168.31.102?prefix=星期五',
      pollIntervalMs: 60,
      notifyAll: true,
    });

    // Wait for initial gateway poll to build baseline syncBuf without replaying hist-001
    await until(() => Boolean(coordinator.store.getImChannel('xiaoai-ssh-home').syncBuf));
    assert.equal(
      coordinator.store.conversation.history(undefined, 20).items.length,
      0,
      'Gateway baseline SSH poll does not replay historical log lines',
    );
    assert.equal(
      sshCalls.filter(c => c.command.includes('mediaplayer') || c.command.includes('text_to_speech')).length,
      0,
      'No pause or TTS issued during baseline poll',
    );

    // 3. Append new AIVS RecognizeResult on oh2p dispatching a background task
    oh2pLogs.push(JSON.stringify({
      header: { namespace: 'SpeechRecognizer', name: 'RecognizeResult', id: 'live-002' },
      payload: { is_final: true, results: [{ text: '小爱同学，星期五，派发: 检查项目状态' }] },
    }));

    const isTtsCmd = (cmd: string) => cmd.includes('text_to_speech') || cmd.includes('tts_play.sh');
    const isPauseCmd = (cmd: string) => cmd.includes('mediaplayer') && cmd.includes('pause');

    await until(() => sshCalls.filter(c => c.targetId === 'oh2p' && isTtsCmd(c.command)).length >= 2);

    const oh2pPauses = sshCalls.filter(c => c.targetId === 'oh2p' && isPauseCmd(c.command));
    const lx06Pauses = sshCalls.filter(c => c.targetId === 'lx06' && isPauseCmd(c.command));
    assert.ok(oh2pPauses.length >= 1, 'oh2p received mediaplayer pause command immediately');
    assert.equal(lx06Pauses.length, 0, 'lx06 did not receive pause command');

    const oh2pTts = sshCalls.filter(c => c.targetId === 'oh2p' && isTtsCmd(c.command));
    const lx06Tts = sshCalls.filter(c => c.targetId === 'lx06' && isTtsCmd(c.command));
    assert.equal(lx06Tts.length, 0, 'lx06 did not receive misrouted TTS');

    const joinedTts = oh2pTts.map(c => c.command).join('\n');
    assert.match(joinedTts, /派发|检查项目状态/, 'oh2p received Router dispatch confirmation');
    assert.match(joinedTts, /汇总|报告|后台工作/, 'oh2p received background Worker completion report');
    assert.doesNotMatch(joinedTts, /###|\*\*/, 'SSH TTS output is sanitized for speech');

    // 4. Verify sendXiaoaiSpeech cleans markdown, codeblocks, URLs, and emojis on SSH outbound
    sshCalls.length = 0;
    const ch = coordinator.store.getImChannel('xiaoai-ssh-home');
    const sendRes = await sendXiaoaiSpeech(
      ch,
      '## 摘要\n```js\nconsole.log(1)\n```\n看 [控制台](https://example.com) [旺柴] 🚀',
      { target: 'oh2p', sshRunner },
    );
    assert.equal(sendRes.mode, 'ssh');
    assert.ok(sendRes.segments.length >= 1);
    assert.doesNotMatch(sendRes.segments.join(' '), /console\.log|https?:\/\/|\[旺柴\]|🚀|##/);
    assert.match(sendRes.segments.join(' '), /代码详情已同步至控制台/);
    assert.ok(sshCalls.some(c => c.targetId === 'oh2p' && isTtsCmd(c.command)));
    assert.equal(sshCalls.filter(c => c.targetId === 'lx06').length, 0);
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoAI cloud MiNA mode end-to-end: login session cached in syncBuf, pollOffset anti-replay, pause, and exact device TTS', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-xiaoai-cloud-'));

  let loginAuthCount = 0;
  let stsCount = 0;
  const deviceRecords: Record<string, Array<{ time: number; query: string; answers: unknown[] }>> = {
    'dev-oh2p': [
      { time: 1700000001000, query: '小爱同学，旧的历史提问不要重放', answers: [] },
    ],
    'dev-lx06': [],
  };
  const ubusCalls: Array<{ deviceId: string; path: string; method: string; message: string }> = [];

  let mockBase = '';
  const mockCloud = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = reqUrl.pathname;
    const raw = req.method === 'POST' ? await readReqBody(req) : '';

    if (pathname === '/account/pass/serviceLogin') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('&&&START&&&' + JSON.stringify({
        code: 70016,
        _sign: 'mock-sign',
        qs: '%3Fsid%3Dmicoapi',
        sid: 'micoapi',
        callback: `${mockBase}/account/sts`,
      }));
      return;
    }

    if (pathname === '/account/pass/serviceLoginAuth2') {
      loginAuthCount++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('&&&START&&&' + JSON.stringify({
        code: 0,
        userId: '10086001',
        ssecurity: 'mock-ssecurity',
        nonce: 987654,
        location: `${mockBase}/account/login_sts?ticket=mock-ticket`,
      }));
      return;
    }

    if (pathname.startsWith('/account/')) {
      stsCount++;
      res.writeHead(200, {
        'content-type': 'text/plain',
        'set-cookie': [
          'serviceToken=mock-cloud-service-token; Path=/',
          'userId=10086001; Path=/',
        ],
      });
      res.end('ok');
      return;
    }

    if (pathname === '/mina/admin/v2/device_list') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        code: 0,
        message: 'Success',
        data: [
          { deviceID: 'dev-oh2p', serialNumber: 'SN-OH2P', name: '卧室小爱', hardware: 'OH2P', presence: 'online' },
          { deviceID: 'dev-lx06', serialNumber: 'SN-LX06', name: '书房小爱', hardware: 'LX06', presence: 'online' },
        ],
      }));
      return;
    }

    if (pathname === '/profile/device_profile/v2/conversation') {
      const cookie = String(req.headers.cookie ?? '');
      const deviceIdMatch = /deviceId=([^;\s]+)/.exec(cookie);
      const deviceId = deviceIdMatch ? decodeURIComponent(deviceIdMatch[1]!) : 'dev-oh2p';
      const records = deviceRecords[deviceId] ?? [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        code: 0,
        message: 'Success',
        data: JSON.stringify({ records }),
      }));
      return;
    }

    if (pathname === '/mina/remote/ubus') {
      let parsed: Record<string, string> = {};
      if (raw.trim().startsWith('{')) {
        parsed = JSON.parse(raw) as Record<string, string>;
      } else {
        const params = new URLSearchParams(raw);
        for (const [k, v] of params.entries()) parsed[k] = v;
      }
      ubusCalls.push({
        deviceId: String(parsed.deviceId ?? ''),
        path: String(parsed.path ?? ''),
        method: String(parsed.method ?? ''),
        message: String(parsed.message ?? ''),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, message: 'Success', data: { code: 0 } }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(resolve => mockCloud.listen(0, '127.0.0.1', resolve));
  const addr = mockCloud.address();
  assert.ok(addr && typeof addr !== 'string');
  mockBase = `http://127.0.0.1:${addr.port}`;

  const coordinator = new Coordinator(home, offlineFactory(10));
  await coordinator.ready();

  try {
    coordinator.im.saveChannel({
      id: 'xiaoai-cloud-home',
      platform: 'xiaoai',
      name: '小米云免刷机',
      accountId: '10086001',
      botToken: 'mock-xiaomi-password',
      apiBase: mockBase,
      pollIntervalMs: 60,
      notifyAll: false,
    });

    // Wait for first baseline poll to finish login + set pollOffset & syncBuf
    await until(() => {
      const ch = coordinator.store.getImChannel('xiaoai-cloud-home');
      return ch.pollOffset !== undefined && Boolean(ch.syncBuf);
    });

    const afterBaseline = coordinator.store.getImChannel('xiaoai-cloud-home');
    assert.equal(afterBaseline.pollOffset, 1700000001000, 'First cloud poll records latest timestamp into pollOffset');
    assert.match(afterBaseline.syncBuf ?? '', /mock-cloud-service-token/, 'Cloud session is cached in syncBuf');
    assert.equal(loginAuthCount, 1, 'Cloud login executed once');
    assert.equal(stsCount, 1);
    assert.equal(
      coordinator.store.conversation.history(undefined, 20).items.length,
      0,
      'Historical cloud record is not replayed',
    );
    assert.equal(ubusCalls.length, 0, 'No pause or TTS triggered on baseline poll');

    // Append new conversation record on dev-oh2p
    deviceRecords['dev-oh2p']!.push({
      time: 1700000009000,
      query: '小爱同学，记住：云端模式=免刷机成功',
      answers: [],
    });

    await until(() =>
      ubusCalls.some(c => c.deviceId === 'dev-oh2p' && c.path === 'mibrain' && c.method === 'text_to_speech'),
    );

    const pauseCall = ubusCalls.find(
      c => c.deviceId === 'dev-oh2p' && c.path === 'mediaplayer' && c.method === 'player_play_operation',
    );
    assert.ok(pauseCall, 'Cloud poll sends mediaplayer pause to dev-oh2p');
    assert.match(pauseCall.message, /pause/);

    const ttsCalls = ubusCalls.filter(
      c => c.deviceId === 'dev-oh2p' && c.path === 'mibrain' && c.method === 'text_to_speech',
    );
    assert.ok(ttsCalls.length >= 1, 'Cloud TTS sent back to dev-oh2p');
    assert.match(ttsCalls.map(c => c.message).join(' '), /已存入全局记忆/);
    assert.equal(
      ubusCalls.filter(c => c.deviceId === 'dev-lx06').length,
      0,
      'dev-lx06 did not receive pause or TTS',
    );
    assert.equal(loginAuthCount, 1, 'Cached cloud session in syncBuf is reused across subsequent polls');
  } finally {
    await coordinator.close();
    await new Promise<void>(resolve => mockCloud.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoAI Webhook Bridge secret auth and switch_channel cross-device routing', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-xiaoai-webhook-'));
  const webhookReceived: Array<{ headers: IncomingMessage['headers']; body: Record<string, unknown> }> = [];

  const mockWebhookServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const raw = req.method === 'POST' ? await readReqBody(req) : '';
    if (url.startsWith('/xiaoai/tts')) {
      webhookReceived.push({
        headers: req.headers,
        body: JSON.parse(raw || '{}') as Record<string, unknown>,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(resolve => mockWebhookServer.listen(0, '127.0.0.1', resolve));
  const addr = mockWebhookServer.address();
  assert.ok(addr && typeof addr !== 'string');
  const mockBase = `http://127.0.0.1:${addr.port}`;

  const daemon = await serve({ home, mode: 'offline', offlineDelayMs: 10 });
  const web = await startWeb({ home, port: 0 });
  const webOrigin = new URL(web.url).origin;

  try {
    const xiaoaiSecret = 'xiaoai-bridge-secret-2026';
    const xiaoaiChannel = await request(home, {
      command: 'im-save',
      id: 'xiaoai-bridge',
      platform: 'xiaoai',
      name: '小爱路由器桥接',
      webhookUrl: `${mockBase}/xiaoai/tts`,
      secret: xiaoaiSecret,
      botToken: 'bridge-tts-bearer',
      defaultTarget: 'oh2p',
      notifyAll: false,
    }) as { id: string; platform: string; loginStatus?: string };

    assert.equal(xiaoaiChannel.platform, 'xiaoai');
    assert.equal(xiaoaiChannel.loginStatus, 'bound');

    // 1. Missing or invalid secret returns 403
    const missingSecretRes = await fetch(`${webOrigin}/im/webhook/${xiaoaiChannel.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '小爱同学，你好', deviceId: 'oh2p', msgId: 'wh-bad-1' }),
    });
    assert.equal(missingSecretRes.status, 403, 'Webhook without x-xiaoai-secret returns 403');

    const wrongSecretRes = await fetch(`${webOrigin}/im/webhook/${xiaoaiChannel.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xiaoai-secret': 'wrong-secret' },
      body: JSON.stringify({ text: '小爱同学，你好', deviceId: 'oh2p', msgId: 'wh-bad-2' }),
    });
    assert.equal(wrongSecretRes.status, 403, 'Webhook with wrong x-xiaoai-secret returns 403');

    // 2. Valid secret returns 200 and triggers webhookUrl TTS callback
    const validRes = await fetch(`${webOrigin}/im/webhook/${xiaoaiChannel.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-xiaoai-secret': xiaoaiSecret },
      body: JSON.stringify({
        text: '小爱同学，记住：音箱桥接=高保真语音链路',
        deviceId: 'oh2p',
        msgId: 'wh-ok-1',
      }),
    });
    assert.equal(validRes.status, 200);
    const validJson = await validRes.json() as { ok: boolean; action: string };
    assert.equal(validJson.ok, true);
    assert.equal(validJson.action, 'routed_to_chat');

    await until(() => webhookReceived.length >= 1);
    const firstTts = webhookReceived[0]!;
    assert.equal(firstTts.headers['authorization'], 'Bearer bridge-tts-bearer');
    assert.equal(firstTts.body.msgtype, 'tts');
    assert.equal(firstTts.body.target, 'oh2p');
    assert.ok(Array.isArray(firstTts.body.segments) && firstTts.body.segments.length >= 1);
    assert.match(String(firstTts.body.text ?? ''), /已存入全局记忆/);

    // 3. Local conversation triggers switch_channel to xiaoai and emits TTS to webhookUrl
    const localMsg = await request(home, {
      command: 'chat',
      requestId: 'req-switch-xiaoai',
      text: '这条在小爱音箱回复',
    }) as { id: string };

    await until(() => webhookReceived.length >= 2);
    const switchedTts = webhookReceived[1]!;
    assert.equal(switchedTts.body.msgtype, 'tts');
    assert.equal(switchedTts.body.target, 'oh2p');
    assert.match(String(switchedTts.body.text ?? ''), /已经切到 xiaoai 这边了/);

    const storedUser = await request(home, { command: 'message', messageId: localMsg.id }) as {
      origin?: { channel?: string; channelId?: string; conversationId?: string };
      routing?: { actions?: Array<{ kind?: string; status?: string }> };
    };
    assert.equal(storedUser.origin?.channel, 'xiaoai');
    assert.equal(storedUser.origin?.channelId, 'xiaoai-bridge');
    assert.equal(storedUser.origin?.conversationId, 'oh2p');
    assert.equal(storedUser.routing?.actions?.[0]?.kind, 'switch_channel');
    assert.equal(storedUser.routing?.actions?.[0]?.status, 'accepted');
  } finally {
    await web.close();
    await daemon.close();
    await new Promise<void>(resolve => mockWebhookServer.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

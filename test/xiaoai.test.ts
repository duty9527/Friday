import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, type spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import {
  sanitizeForSpeech,
  smoothXiaoaiTtsProsody,
  splitSpeechSegments,
  shouldInterceptXiaoaiQuery,
  shouldContinueXiaoaiDialog,
  stripXiaoaiDialogDirective,
  parseXiaoaiSshTargets,
  isXiaoaiPollable,
  isXiaoaiSpeakingSelfEcho,
  markXiaoaiSpeakingGuard,
  resetXiaoaiRuntimeState,
  parseXiaoaiWebhookPayload,
  pollXiaoaiChannel,
  getXiaoaiWakeCacheFileName,
  buildXiaoaiWakeCommand,
  buildXiaoaiWakePrewarmCommand,
  resolveXiaoaiWakeGreeting,
  tightenWakeAudioToWavBufferWithFfmpeg,
  handleXiaoaiKeywordWake,
  sendXiaoaiSpeech,
  setXiaoaiSpeakerLed,
  SSH_PAUSE_COMMAND,
  type XiaoaiSshRunner,
} from '../src/xiaoai.js';
import {
  cleanXiaoaiAsrUtterance,
  computeForegroundSpeechGate,
  computeKwsGain,
  computeKwsIdleGateRms,
  computeRms,
  DEFAULT_END_SILENCE_MS,
  DEFAULT_XIAOAI_KEYWORDS,
  decodePcm16leToFloat32,
  decodePcm32leToFloat32,
  extractLeadingXiaoaiWakeKeyword,
  hasLeadingXiaoaiWakeWord,
  isXiaoaiFollowUpCancel,
  normalizeUtteranceSamples,
  updateAmbientNoiseRms,
  XIAOAI_KEYWORDS_VERSION,
  XiaoaiKwsMonitor,
} from '../src/xiaoai-kws.js';
import {
  SPEAKER_SAMPLE_RATE,
  measureWakeSpeechDurationMs,
  trimShortUtteranceSilence,
  trimWakeSpeechWindow,
  XiaoaiSpeakerEnrollController,
  XiaoaiSpeakerManager,
  isEnrollCancelPhrase,
  parseSpeakerVoiceCommand,
  type XiaoaiSpeakerExtractor,
} from '../src/xiaoai-speaker.js';
import { serve } from '../src/server.js';
import { startWeb } from '../src/web-server.js';
import { request } from '../src/protocol.js';
import { Coordinator } from '../src/coordinator.js';
import { compactHostEventText, offlineFactory, prepareRouterSessionModel, type AgentFactory } from '../src/agent.js';
import { Store, type ImChannelConfig } from '../src/store.js';
import { ImGateway } from '../src/im.js';
import { listPluginsSync, runPlugin, tryPluginVoiceFastpath } from '../src/plugin.js';
import { resolvePluginDataDir } from '../src/paths.js';

async function until(predicate: () => boolean | Promise<boolean>, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await delay(15);
  }
  throw new Error('Timed out waiting for XiaoAI condition');
}

type TestTvPluginConfig = {
  idleTtlMs: number;
  captureWaitMs: number;
  stepIntervalMs: number;
};

type TestTvFastpathHandler = (request: {
  text: string;
  explicitWake?: boolean;
  sessionState?: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

const TEST_TV_FASTPATH_KEY = '__fridayTestTvFastpath';
const TEST_TV_IR_CODES = {
  down: 'TEST_TV_IR_DOWN',
  up: 'TEST_TV_IR_UP',
  right: 'TEST_TV_IR_RIGHT',
  ok: 'TEST_TV_IR_OK',
} as const;

function parseTestTvPressSequence(text: string): string[] | undefined {
  const normalized = text.trim();
  if (normalized.includes('往下两下再确认')) {
    return [TEST_TV_IR_CODES.down, TEST_TV_IR_CODES.down, TEST_TV_IR_CODES.ok];
  }
  if (normalized.includes('往右往上')) {
    return [TEST_TV_IR_CODES.right, TEST_TV_IR_CODES.up];
  }
  if (normalized.includes('往下') || normalized.includes('哪下')) {
    return [TEST_TV_IR_CODES.down];
  }
  if (normalized.includes('往上') || normalized.includes('马上')) {
    return [TEST_TV_IR_CODES.up];
  }
  if (normalized.includes('往右') || normalized.includes('网友')) {
    return [TEST_TV_IR_CODES.right];
  }
  if (normalized.includes('确认')) {
    return [TEST_TV_IR_CODES.ok];
  }
  return undefined;
}

async function installTestTvFastpathPlugin(
  home: string,
  targetUserHost: string,
  sshRunner: XiaoaiSshRunner,
  cfg: TestTvPluginConfig,
): Promise<() => void> {
  const realHome = await realpath(home);
  const pluginDir = join(realHome, 'plugins', 'test-tv-ir');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({
    name: 'test-tv-ir',
    version: '1.0.0',
    description: 'Test TV remote fastpath plugin',
    enabled: true,
    runtime: 'in-process',
    voiceFastpath: true,
    entry: 'index.mjs',
    actions: [],
  }));
  const g = globalThis as Record<string, unknown>;
  let reg = g[TEST_TV_FASTPATH_KEY] as Map<string, TestTvFastpathHandler> | undefined;
  if (!reg) {
    reg = new Map();
    g[TEST_TV_FASTPATH_KEY] = reg;
  }
  const key = realHome;
  reg.set(key, async (req) => {
    const activeState = () => ({
      continuous: true,
      tvRemoteActive: true,
      idleTtlMs: cfg.idleTtlMs,
      captureWaitMs: cfg.captureWaitMs,
    });
    if (req.sessionState?.event === 'assistant_reply') {
      const reply = String(req.sessionState.assistantReply ?? '');
      if (reply.includes('要试别的键就说')) {
        return {
          handled: true,
          followUp: true,
          followUpWaitMs: cfg.captureWaitMs,
          sessionState: activeState(),
        };
      }
      return { handled: false };
    }
    const clean = req.text.replace(/[。！？，、\s]+/g, '');
    if (clean === '遥控电视模式') {
      return {
        handled: true,
        ok: true,
        speech: '已进入遥控模式。',
        followUp: true,
        followUpWaitMs: cfg.captureWaitMs,
        sessionState: activeState(),
        action: 'tv_enter',
      };
    }
    if (!req.sessionState?.tvRemoteActive) {
      return { handled: false };
    }
    if (clean === '退出遥控') {
      return {
        handled: true,
        ok: true,
        speech: '已退出遥控。',
        clearSessionState: true,
        action: 'tv_exit',
      };
    }
    const codes = parseTestTvPressSequence(req.text);
    if (!codes?.length) {
      return { handled: false };
    }
    for (let i = 0; i < codes.length; i++) {
      if (i > 0) await delay(cfg.stepIntervalMs);
      await sshRunner(
        { id: 'lx06', userHost: targetUserHost },
        `/bin/show_led 1 >/dev/null 2>&1; ubus call ir_agent play '${JSON.stringify({ protocol: 0, code: codes[i] })}'`,
      );
    }
    return {
      handled: true,
      ok: true,
      followUp: true,
      followUpWaitMs: cfg.captureWaitMs,
      sessionState: activeState(),
      data: { ledRefreshed: true, recordTurn: false },
      action: 'tv_press',
    };
  });
  await writeFile(join(pluginDir, 'index.mjs'), `
export async function handleVoiceFastpath(request, context) {
  const reg = globalThis[${JSON.stringify(TEST_TV_FASTPATH_KEY)}];
  const fn = reg?.get(${JSON.stringify(key)});
  return fn ? fn(request, context) : { handled: false };
}
`);
  return () => {
    reg?.delete(key);
  };
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

  assert.equal(sanitizeForSpeech('好，已经开始监听体脂秤。'), '好，已经开始检测体脂秤。');
});

test('XiaoAI query interception, SSH multi-speaker target parsing, pollability, and webhook parsing', () => {
  // Without prefix: native speaker commands & smart-home IoT pass through; natural language is intercepted
  for (const nativeCmd of ['音量大一点', '暂停', '定个7点闹钟', '闭嘴', '下一首', '打开客厅灯', '关闭客厅空调']) {
    assert.deepEqual(shouldInterceptXiaoaiQuery(nativeCmd), { intercept: false, query: '' }, `Should pass through: ${nativeCmd}`);
  }
  assert.deepEqual(shouldInterceptXiaoaiQuery('小爱同学，今天深圳天气如何'), {
    intercept: true,
    query: '今天深圳天气如何',
  });

  // With prefix: only matching prefixes with non-empty command are intercepted and stripped (case-insensitive)
  assert.deepEqual(
    shouldInterceptXiaoaiQuery('今天天气怎么样', { prefix: '星期五,Friday' }),
    { intercept: false, query: '' },
  );
  assert.deepEqual(
    shouldInterceptXiaoaiQuery('小爱同学，星期五', { prefix: '星期五,Friday' }),
    { intercept: false, query: '' },
  );
  assert.deepEqual(
    shouldInterceptXiaoaiQuery('小爱同学，星期五，帮我检查一下项目状态', { prefix: '星期五,Friday' }),
    { intercept: true, query: '帮我检查一下项目状态' },
  );

  // Local ASR utterance cleanup & anti-crosstalk filters
  assert.equal(cleanXiaoaiAsrUtterance('<|zh|><|NEUTRAL|>帮我打印一张纸。'), '帮我打印一张纸。');
  assert.equal(cleanXiaoaiAsrUtterance('你好星期五，现在几点了'), '现在几点了');
  assert.equal(cleanXiaoaiAsrUtterance('你好星期五。'), '');
  assert.equal(cleanXiaoaiAsrUtterance('在。'), '');
  assert.equal(cleanXiaoaiAsrUtterance('在，查一下明天天气'), '查一下明天天气');
  assert.equal(cleanXiaoaiAsrUtterance('在哪里买咖啡'), '在哪里买咖啡');
  assert.equal(cleanXiaoaiAsrUtterance('小爱同学，打开客厅灯'), '');
  assert.deepEqual(
    shouldInterceptXiaoaiQuery('friday: summarize today tasks', { prefix: '星期五,Friday' }),
    { intercept: true, query: 'summarize today tasks' },
  );
  assert.deepEqual(
    shouldInterceptXiaoaiQuery('小爱，星期五？现在几点', { prefix: '星期五,Friday' }),
    { intercept: true, query: '现在几点' },
  );

  // Multi-speaker SSH URI parsing
  const targets = parseXiaoaiSshTargets('ssh://oh2p=root@192.0.2.101,lx06=root@192.0.2.102:2222?prefix=星期五');
  assert.equal(targets.length, 2);
  assert.equal(targets[0]?.id, 'oh2p');
  assert.equal(targets[0]?.userHost, 'root@192.0.2.101');
  assert.equal(targets[0]?.port, undefined);
  assert.equal(targets[1]?.id, 'lx06');
  assert.equal(targets[1]?.userHost, 'root@192.0.2.102');
  assert.equal(targets[1]?.port, 2222);

  const singleTarget = parseXiaoaiSshTargets('ssh://root@192.0.2.101');
  assert.equal(singleTarget.length, 1);
  assert.equal(singleTarget[0]?.id, 'default');
  assert.equal(singleTarget[0]?.userHost, 'root@192.0.2.101');

  assert.deepEqual(parseXiaoaiSshTargets('https://api2.mina.mi.com'), []);

  // Pollability checks
  assert.equal(isXiaoaiPollable(makeChannel({ apiBase: 'ssh://oh2p=root@192.0.2.101' })), true);
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
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-ssh-'));
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
      apiBase: 'ssh://oh2p=root@192.0.2.101,lx06=root@192.0.2.102?prefix=星期五',
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
      apiBase: 'ssh://oh2p=root@192.0.2.101,lx06=root@192.0.2.102?prefix=星期五',
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
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-cloud-'));

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
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-webhook-'));
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
    assert.equal(storedUser.origin?.channel, 'local');
    assert.equal(storedUser.origin?.channelId, undefined);
    assert.equal(storedUser.origin?.conversationId, undefined);
    assert.equal(storedUser.routing?.actions?.[0]?.kind, 'switch_channel');
    assert.equal(storedUser.routing?.actions?.[0]?.status, 'accepted');

    const historyPage = await request(home, { command: 'history' }) as {
      items?: Array<{
        id: string;
        role?: string;
        replyTo?: string;
        origin?: { channel?: string; channelId?: string; conversationId?: string };
      }>;
    };
    const switchedReplies = (historyPage.items ?? []).filter(
      item => item.role === 'assistant' && item.replyTo === localMsg.id,
    );
    assert.equal(switchedReplies.length, 1);
    assert.equal(switchedReplies[0]?.origin?.channel, 'xiaoai');
    assert.equal(switchedReplies[0]?.origin?.channelId, 'xiaoai-bridge');
    assert.equal(switchedReplies[0]?.origin?.conversationId, 'oh2p');
  } finally {
    await web.close();
    await daemon.close();
    await new Promise<void>(resolve => mockWebhookServer.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoAI SSH multi-segment TTS marks friday_speaking and waits for mediaplayer playback completion', async () => {
  const events: Array<{ type: 'tts' | 'status'; detail: string }> = [];
  let statusPollCount = 0;

  const sshRunner: XiaoaiSshRunner = async (_target, remoteCommand) => {
    if (remoteCommand.includes('player_get_play_status')) {
      statusPollCount++;
      const status = statusPollCount <= 2 ? 1 : 0;
      events.push({ type: 'status', detail: `status=${status}` });
      return {
        stdout: JSON.stringify({
          code: 0,
          info: `{ "status": ${status}, "volume": 42, "loop_type": 1 }`,
        }),
        stderr: '',
        code: 0,
      };
    }
    events.push({ type: 'tts', detail: remoteCommand });
    return { stdout: '', stderr: '', code: 0 };
  };

  const ch = makeChannel({
    id: 'xiaoai-lx06-sync',
    apiBase: 'ssh://lx06=root@192.0.2.104?prefix=星期五,Friday',
  });
  const longSpeech = `${'第一段内容，'.repeat(30)}。${'第二段内容，'.repeat(10)}。`;
  const res = await sendXiaoaiSpeech(ch, longSpeech, { target: 'lx06', sshRunner });

  assert.equal(res.mode, 'ssh');
  assert.ok(res.segments.length >= 2, `Expected >= 2 segments, got ${res.segments.length}`);
  assert.equal(events[0]?.type, 'tts');
  assert.match(events[0]?.detail ?? '', /touch \/tmp\/friday_speaking;/);
  assert.equal(events[1]?.type, 'status');
  assert.equal(events[1]?.detail, 'status=1');
  assert.equal(events[2]?.type, 'status');
  assert.equal(events[2]?.detail, 'status=1');
  assert.equal(events[3]?.type, 'status');
  assert.equal(events[3]?.detail, 'status=0');
  assert.equal(events[4]?.type, 'tts');
});

test('XiaoAI Scheme A KWS direct wake: local VAD + ASR eliminates pnshelper/XiaoAI cross-talk', async () => {
  // 1. Odd-byte PCM carry-over decoding check
  const pcmBuf = Buffer.alloc(4);
  pcmBuf.writeInt16LE(-16384, 0); // -0.5
  pcmBuf.writeInt16LE(8192, 2);   // 0.25
  const part1 = decodePcm16leToFloat32(pcmBuf.subarray(0, 3), null);
  assert.equal(part1.samples.length, 1);
  assert.ok(Math.abs(part1.samples[0]! - (-0.5)) < 1e-6);
  assert.notEqual(part1.leftoverByte, null);
  const part2 = decodePcm16leToFloat32(pcmBuf.subarray(3), part1.leftoverByte);
  assert.equal(part2.samples.length, 1);
  assert.ok(Math.abs(part2.samples[0]! - 0.25) < 1e-6);
  assert.equal(part2.leftoverByte, null);

  // 1b. Software AGC normalizes ultra-quiet noop captures without clipping loud captures
  const quiet = new Float32Array([0, 0.003, -0.0015]);
  const boosted = normalizeUtteranceSamples(quiet);
  assert.ok(boosted[1]! >= 0.15 && boosted[1]! <= 0.5, `expected quiet peak boosted, got ${boosted[1]}`);
  const normal = new Float32Array([0, 0.5, -0.25]);
  assert.equal(normalizeUtteranceSamples(normal), normal);

  // 2. End-to-end Coordinator + KWS local VAD/ASR monitor flow
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-kws-'));
  const sshCalls: Array<{ targetId: string; command: string }> = [];
  const instructionLines: string[] = [
    JSON.stringify({
      header: { id: 'kws-baseline-1', namespace: 'SpeechRecognizer', name: 'RecognizeResult' },
      payload: { is_final: true, results: [{ text: '历史记录不要重放' }] },
    }),
  ];

  const sshRunner: XiaoaiSshRunner = async (target, remoteCommand) => {
    sshCalls.push({ targetId: target.id, command: remoteCommand });
    if (remoteCommand.includes('instruction.log')) {
      return { stdout: instructionLines.join('\n') + '\n', stderr: '', code: 0 };
    }
    if (remoteCommand.includes('player_get_play_status')) {
      return { stdout: '{"code":0,"info":"{ \\"status\\": 0 }"}', stderr: '', code: 0 };
    }
    return { stdout: '{"code":0}', stderr: '', code: 0 };
  };

  let spawnedDevice = '';
  let streamKills = 0;
  let audioStream: PassThrough | undefined;
  const closeListeners: Array<(code: number | null) => void> = [];
  const asrQueue: string[] = [
    '记住：本地直连识别=零串音',
    '记住：一口气连说=不播报提示音',
    '小爱同学，把音量调到50',
  ];

  const coordinator = new Coordinator(home, offlineFactory(10));
  await coordinator.ready();

  try {
    coordinator.im.xiaoaiDeps = {
      sshRunner,
      kwsCooldownMs: 20,
      kwsProbeDurationMs: 25,
      kwsChimeDiscardMs: 20,
      kwsEndSilenceMs: 40,
      kwsMaxWaitSpeechMs: 120,
      kwsStreamFactory: (_target, device) => {
        spawnedDevice = device;
        audioStream = new PassThrough();
        return {
          stdout: audioStream,
          kill: () => {
            streamKills++;
            audioStream?.end();
            for (const cb of closeListeners) cb(0);
          },
          onClose: (cb) => {
            closeListeners.push(cb);
          },
        };
      },
      kwsSpotterFactory: () => {
        const state = { peak: 0 };
        return {
          createStream: () => ({ state }),
          acceptWaveform: (_s, samples) => {
            for (const v of samples) {
              const abs = Math.abs(v);
              if (abs > state.peak) state.peak = abs;
            }
          },
          isReady: () => state.peak >= 0.3,
          decode: () => {},
          getResult: () => {
            if (state.peak >= 0.65) return '你好星期五';
            if (state.peak >= 0.3) return '星期五';
            return '';
          },
          reset: () => {
            state.peak = 0;
          },
        };
      },
      kwsRecognizerFactory: () => ({
        transcribe: async () => asrQueue.shift() ?? '',
      }),
    };

    coordinator.im.saveChannel({
      id: 'xiaoai-kws-lx06',
      platform: 'xiaoai',
      name: '小爱直接唤醒测试',
      apiBase: 'ssh://lx06=root@192.0.2.104?prefix=星期五,Friday',
      pollIntervalMs: 50,
      notifyAll: false,
    });

    await until(() => Boolean(audioStream) && sshCalls.some(c => c.command.includes('instruction.log')));
    assert.equal(spawnedDevice, 'noop');
    await delay(80);
    assert.equal(
      coordinator.store.conversation.history(undefined, 20).items.length,
      0,
      'Baseline poll does not replay old entries',
    );

    const pushPcmSamples = (amplitude: number, sampleCount: number, splitOdd = false) => {
      const b = Buffer.alloc(sampleCount * 2);
      const val = Math.round(amplitude * 32767);
      for (let i = 0; i < sampleCount; i++) b.writeInt16LE(val, i * 2);
      if (splitOdd && b.length > 5) {
        audioStream!.write(b.subarray(0, 5));
        audioStream!.write(b.subarray(5));
      } else {
        audioStream!.write(b);
      }
    };

    const chimeCallCount = () => sshCalls.filter(c => c.command.includes('wakeup_zai_01.wav')).length;
    const led1Count = () => sshCalls.filter(c => c.command.includes('/bin/show_led 1')).length;
    const led2Count = () => sshCalls.filter(c => c.command.includes('/bin/show_led 2')).length;
    const ledOffCount = () => sshCalls.filter(c => c.command.includes('/bin/shut_led 1') && !c.command.includes('/bin/show_led')).length;
    const ttsCallCount = () => sshCalls.filter(c => c.command.includes('text_to_speech')).length;

    // 3. Two-step wake: "你好星期五" -> silent probe -> plays chime + show_led 1 (NO pnshelper!)
    pushPcmSamples(0.75, 16, true);
    pushPcmSamples(0, 480); // 30ms silence (> 25ms probe)
    await until(() => chimeCallCount() === 1);
    const wakeCmd = sshCalls.find(c => c.command.includes('wakeup_zai_01.wav'))!.command;
    assert.match(wakeCmd, /qplayer|miplayer -f/);
    assert.doesNotMatch(wakeCmd, /miplayer '\/usr/);
    assert.equal(
      sshCalls.some(c => c.command.includes('pnshelper') || c.command.includes('event_notify')),
      false,
      'Must never call pnshelper event_notify',
    );

    // 4. Native XiaoAI instruction.log entries without Friday prefix are NEVER hijacked
    instructionLines.push(JSON.stringify({
      header: { id: 'native-xiaoai-1', namespace: 'SpeechRecognizer', name: 'RecognizeResult' },
      payload: { is_final: true, results: [{ text: '打开客厅灯' }] },
    }));
    await delay(120);
    assert.equal(ttsCallCount(), 0, 'Unprefixed native XiaoAI command in instruction.log is never hijacked');

    // 5. Feed chime tail (20ms = 320 samples) + user speech (30ms = 480 samples) + trailing silence (50ms = 800 samples)
    pushPcmSamples(0, 320);
    pushPcmSamples(0.15, 480);
    pushPcmSamples(0, 800);
    await until(() => ttsCallCount() === 1);
    assert.ok(led2Count() >= 1, 'show_led 2 lights during ASR thinking');
    assert.match(
      sshCalls.filter(c => c.command.includes('text_to_speech')).map(c => c.command).join('\n'),
      /已存入全局记忆/,
    );

    // 6. Speaking guard: bare "星期五" is suppressed, while explicit "你好星期五" barges in (one-breath skips chime)
    const led1BeforeEcho = led1Count();
    pushPcmSamples(0.4, 16); // bare "星期五"
    await delay(60);
    assert.equal(led1Count(), led1BeforeEcho, 'Bare "星期五" self-echo is suppressed during speaking guard');

    // Explicit "你好星期五" immediately followed by speech (one-breath) -> show_led 1 without chime!
    pushPcmSamples(0.75, 16);
    pushPcmSamples(0.15, 480); // speech during 25ms probe -> one-breath
    await until(() => led1Count() === led1BeforeEcho + 1);
    assert.equal(chimeCallCount(), 1, 'One-breath speech skips audible chime');
    pushPcmSamples(0, 800); // end utterance
    await until(() => ttsCallCount() === 2);

    // 7. Wake followed by long silence cancels cleanly (shut_led, no LLM turn)
    await delay(30);
    pushPcmSamples(0.75, 16);
    pushPcmSamples(0, 480); // silent probe -> chime #2
    await until(() => chimeCallCount() === 2);
    await delay(15); // let invokeWake microtasks enter 'capturing'
    const shutBeforeTimeout = ledOffCount();
    pushPcmSamples(0, 400); // 25ms discard
    pushPcmSamples(0, 2200); // > 120ms maxWaitSpeech
    await until(() => ledOffCount() > shutBeforeTimeout);
    await delay(60);
    assert.equal(ttsCallCount(), 2, 'Silence timeout does not send anything to Coordinator');

    // 8. If local ASR transcribes "小爱同学...", it is ignored and LED shuts off
    await delay(30);
    pushPcmSamples(0.75, 16);
    pushPcmSamples(0, 480); // silent probe -> chime #3
    await until(() => chimeCallCount() === 3);
    await delay(15); // let invokeWake microtasks enter 'capturing'
    const shutBeforeXiaoaiAsr = ledOffCount();
    pushPcmSamples(0, 400);
    pushPcmSamples(0.15, 480);
    pushPcmSamples(0, 800);
    await until(() => ledOffCount() > shutBeforeXiaoaiAsr);
    await delay(60);
    assert.equal(ttsCallCount(), 2, '"小爱同学..." transcribed by local ASR is ignored');
    assert.equal(
      sshCalls.some(c => c.command.includes('pnshelper') || c.command.includes('event_notify')),
      false,
    );

    await coordinator.close();
    assert.ok(streamKills >= 1, 'KWS audio stream is terminated on close()');
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoAI KWS supports re-wake during capture silent wait and preserves background tasks across concurrent requests', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-conc-'));
  try {
    // Part A: Re-wake during silent wait inside capturing mode
    let audioStreamA: PassThrough | undefined;
    let wakeCalls = 0;
    const monitor = new XiaoaiKwsMonitor({
      homeDir: home,
      cooldownMs: 20,
      probeDurationMs: 25,
      chimeDiscardMs: 20,
      maxWaitSpeechMs: 1_500,
      endSilenceMs: 40,
      streamFactory: () => {
        audioStreamA = new PassThrough();
        return { stdout: audioStreamA, kill: () => audioStreamA?.end(), onClose: () => {} };
      },
      spotterFactory: () => {
        const state = { peak: 0 };
        return {
          createStream: () => ({ state }),
          acceptWaveform: (_s, samples) => {
            for (const v of samples) {
              const abs = Math.abs(v);
              if (abs > state.peak) state.peak = abs;
            }
          },
          isReady: () => state.peak >= 0.65,
          decode: () => {},
          getResult: () => (state.peak >= 0.65 ? '你好星期五' : ''),
          reset: () => { state.peak = 0; },
        };
      },
      recognizerFactory: () => ({ transcribe: async () => '' }),
      vadFactory: () => ({
        isSpeech: (samples) => samples.some(s => Math.abs(s) >= 0.05 && Math.abs(s) < 0.5),
        reset: () => {},
      }),
      onWake: async () => {
        wakeCalls++;
        return { woken: true, suppressed: false };
      },
    });
    monitor.sync([{
      id: 'xiaoai-rewake',
      platform: 'xiaoai',
      name: '小爱测试',
      enabled: true,
      notifyAll: false,
      allowedSenders: [],
      apiBase: 'ssh://lx06=root@192.0.2.104',
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);
    await until(() => Boolean(audioStreamA));
    const pushSamples = (stream: PassThrough, amp: number, count: number) => {
      const buf = Buffer.alloc(count * 2);
      const val = Math.round(amp * 32767);
      for (let i = 0; i < count; i++) buf.writeInt16LE(val, i * 2);
      stream.write(buf);
    };
    pushSamples(audioStreamA!, 0.75, 16);
    pushSamples(audioStreamA!, 0, 480);
    await until(() => wakeCalls === 1);
    await delay(15);
    assert.equal(monitor.isCapturing('xiaoai-rewake', 'lx06'), true);
    // 20ms chime discard + 550ms silence (< 1500ms timeout, > 500ms re-wake guard)
    pushSamples(audioStreamA!, 0, 320 + 8_800);
    pushSamples(audioStreamA!, 0.75, 16);
    pushSamples(audioStreamA!, 0, 480);
    await until(() => wakeCalls === 2);
    monitor.close();

    // Part B: Concurrent voice request does NOT abort Request 1 background task dispatch
    // and holds/skips stale outbound TTS while speaker is actively capturing Request 2
    const sshCalls: Array<{ targetId: string; command: string }> = [];
    const sshRunner: XiaoaiSshRunner = async (target, remoteCommand) => {
      sshCalls.push({ targetId: target.id, command: remoteCommand });
      if (remoteCommand.includes('instruction.log')) return { stdout: '', stderr: '', code: 0 };
      if (remoteCommand.includes('player_get_play_status')) {
        return { stdout: '{"code":0,"info":"{ \\"status\\": 0 }"}', stderr: '', code: 0 };
      }
      return { stdout: '{"code":0}', stderr: '', code: 0 };
    };
    let audioStreamB: PassThrough | undefined;
    const asrQueue = ['派发：后台整理今日日志', '第二条消息'];
    const coordinator = new Coordinator(home, offlineFactory(80));
    await coordinator.ready();
    try {
      coordinator.im.xiaoaiDeps = {
        sshRunner,
        kwsCooldownMs: 20,
        kwsProbeDurationMs: 25,
        kwsChimeDiscardMs: 20,
        kwsEndSilenceMs: 40,
        kwsMaxWaitSpeechMs: 600,
        kwsStreamFactory: () => {
          audioStreamB = new PassThrough();
          return { stdout: audioStreamB, kill: () => audioStreamB?.end(), onClose: () => {} };
        },
        kwsSpotterFactory: () => {
          const state = { peak: 0 };
          return {
            createStream: () => ({ state }),
            acceptWaveform: (_s, samples) => {
              for (const v of samples) {
                const abs = Math.abs(v);
                if (abs > state.peak) state.peak = abs;
              }
            },
            isReady: () => state.peak >= 0.65,
            decode: () => {},
            getResult: () => (state.peak >= 0.65 ? '你好星期五' : ''),
            reset: () => { state.peak = 0; },
          };
        },
        kwsRecognizerFactory: () => ({ transcribe: async () => asrQueue.shift() ?? '' }),
      };
      coordinator.im.saveChannel({
        id: 'xiaoai-bg-lx06',
        platform: 'xiaoai',
        name: '小爱并发后台测试',
        apiBase: 'ssh://lx06=root@192.0.2.104',
        pollIntervalMs: 50,
        notifyAll: false,
      });
      await until(() => Boolean(audioStreamB));

      // Utterance 1 triggers background task (one-breath skips chime)
      pushSamples(audioStreamB!, 0.75, 16);
      pushSamples(audioStreamB!, 0.15, 480);
      pushSamples(audioStreamB!, 0, 800);
      await until(() => coordinator.store.conversation.history(undefined, 10).items.some(m => m.role === 'user'));

      // Wait past kwsCooldownMs (20ms) while Request 1's Router turn (80ms) is still in-flight
      await delay(30);
      pushSamples(audioStreamB!, 0.75, 16);
      await delay(10); // capture active before Utterance 2 finishes
      const ttsDuringCapture = sshCalls.filter(c => c.command.includes('text_to_speech')).length;
      pushSamples(audioStreamB!, 0.15, 480);
      pushSamples(audioStreamB!, 0, 800);

      // Background task from Utterance 1 MUST NOT be aborted, and completes + delivers WORKER_REPORT
      await until(() => {
        const works = coordinator.store.list();
        return works.length === 1 && works[0]!.status === 'completed';
      });
      await until(() => {
        const ttsCmds = sshCalls.filter(c => c.command.includes('text_to_speech')).map(c => c.command);
        return ttsCmds.some(c => c.includes('第二条消息')) && ttsCmds.some(c => c.includes('后台工作已交由'));
      });
      // Request 1's superseded intermediate handoff ack may be skipped when Request 2 already superseded it
      assert.equal(ttsDuringCapture, 0, 'Must not fire TTS mid-capture of Request 2');
    } finally {
      await coordinator.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Router HOST_EVENT snapshot compaction and S32LE single-mic ambient/AGC helpers', () => {
  // 1. compactHostEventText strips bulky per-turn Router world snapshots on historical turns only
  const chatPayload = {
    kind: 'CHAT',
    message: {
      id: 'm1',
      role: 'user',
      text: '今天几点开饭',
      origin: { channel: 'xiaoai', senderId: 'lx06' },
      routing: { status: 'processing', actions: [{ id: 'a1' }] },
      attachments: [{ id: 'att1', name: 'img.png', mime: 'image/png', path: '/tmp/secret.png' }],
      paths: ['/tmp/secret.png', '/tmp/keep.txt'],
    },
    works: [{ id: 'w1', reportPreview: 'x'.repeat(500) }],
    memoryDirectory: [{ id: 'mem1', content: 'y'.repeat(500) }],
    autoRecalled: [{ kind: 'memory', text: 'z'.repeat(200) }],
    context: { summary: 'recent' },
    imChannels: [{ id: 'xiaoai' }],
    subconscious: { pendingInsight: { id: 's1' } },
    execution: 'native',
    cwd: '/tmp/friday-test',
  };
  const chatRaw = `HOST_EVENT\n${JSON.stringify(chatPayload)}`;

  const currentCompacted = JSON.parse(compactHostEventText(chatRaw, false).slice('HOST_EVENT\n'.length));
  assert.equal(currentCompacted.message.routing, undefined);
  assert.equal(currentCompacted.works.length, 1);
  assert.equal(currentCompacted.memoryDirectory.length, 1);
  assert.equal(currentCompacted.message.attachments[0].path, '/tmp/secret.png');

  const histCompacted = JSON.parse(compactHostEventText(chatRaw, true).slice('HOST_EVENT\n'.length));
  assert.equal(histCompacted.works, undefined);
  assert.equal(histCompacted.memoryDirectory, undefined);
  assert.equal(histCompacted.autoRecalled, undefined);
  assert.equal(histCompacted.context, undefined);
  assert.equal(histCompacted.imChannels, undefined);
  assert.equal(histCompacted.subconscious, undefined);
  assert.equal(histCompacted.execution, undefined);
  assert.equal(histCompacted.cwd, undefined);
  assert.equal(histCompacted.message.text, '今天几点开饭');
  assert.equal(histCompacted.message.attachments[0].path, undefined);
  assert.deepEqual(histCompacted.message.paths, ['/tmp/keep.txt']);

  const reportRaw = `HOST_EVENT\n${JSON.stringify({
    kind: 'WORKER_REPORT',
    taskId: 't1',
    report: 'R'.repeat(2000),
    qualityGate: { ok: true },
    autoDispatchesRemaining: 2,
    memoryDirectory: [{ id: 'm' }],
    cwd: '/tmp',
  })}`;
  const histReport = JSON.parse(compactHostEventText(reportRaw, true).slice('HOST_EVENT\n'.length));
  assert.equal(histReport.qualityGate, undefined);
  assert.equal(histReport.autoDispatchesRemaining, undefined);
  assert.equal(histReport.memoryDirectory, undefined);
  assert.equal(histReport.cwd, undefined);
  assert.ok(histReport.report.length <= 1601 && histReport.report.endsWith('…'));

  const workerTaskRaw = `HOST_EVENT\n${JSON.stringify({
    kind: 'TASK',
    taskId: 't1',
    execution: 'native',
    cwd: '/tmp/friday-test',
    compiledContext: { profile: 'coding' },
  })}`;
  assert.equal(compactHostEventText(workerTaskRaw, true), workerTaskRaw);

  // 2. decodePcm32leToFloat32 partial frame carry-over & DC-blocker removes DC bias while keeping AC
  const s32Frames = 1200;
  const s32Buf = Buffer.alloc(s32Frames * 4);
  const dcBias = 0.05;
  for (let i = 0; i < s32Frames; i++) {
    const val = dcBias + 0.01 * Math.sin((2 * Math.PI * 500 * i) / 16000);
    s32Buf.writeInt32LE(Math.round(val * 2147483647), i * 4);
  }
  const dcState = { prevX: 0, prevY: 0 };
  const s1 = decodePcm32leToFloat32(s32Buf.subarray(0, 5), Buffer.alloc(0), dcState);
  assert.equal(s1.samples.length, 1);
  assert.equal(s1.leftover.length, 1);
  const s2 = decodePcm32leToFloat32(s32Buf.subarray(5, 11), s1.leftover, dcState);
  assert.equal(s2.samples.length, 1);
  assert.equal(s2.leftover.length, 3);
  const s3 = decodePcm32leToFloat32(s32Buf.subarray(11), s2.leftover, dcState);
  assert.equal(s3.samples.length, s32Frames - 2);
  assert.equal(s3.leftover.length, 0);
  const tailSlice = s3.samples.subarray(-400);
  const tailMean = tailSlice.reduce((sum, v) => sum + v, 0) / tailSlice.length;
  assert.ok(Math.abs(tailMean) < 0.005, `DC bias should settle near zero, got ${tailMean}`);
  const tailPeak = tailSlice.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(tailPeak >= 0.008 && tailPeak <= 0.014, `AC wave should be preserved, got peak=${tailPeak}`);

  // 3. normalizeUtteranceSamples ignores isolated single-sample click spike >= 0.25 and boosts quiet speech
  const spiky = new Float32Array(2048);
  spiky.fill(0.003);
  for (let i = 0; i < spiky.length; i += 2) spiky[i] = -0.003;
  spiky[100] = 0.40;
  const spikyBoosted = normalizeUtteranceSamples(spiky);
  assert.ok(Math.abs(spikyBoosted[200]!) > 0.25, `expected quiet body boosted despite click, got ${spikyBoosted[200]}`);

  // 4. Un-freezable ambient noise adaptation & foreground gate vs background TV
  let ambient = 0.0002;
  for (let i = 0; i < 400; i++) {
    ambient = updateAmbientNoiseRms(ambient, 0.0006);
  }
  assert.ok(ambient > 0.0005, `ambient must adapt upward when background rises, got ${ambient}`);

  const gate = computeForegroundSpeechGate(0.0006, 0.015);
  assert.ok(gate >= 0.0029 && gate <= 0.0031, `expected wake-referenced gate ~0.003, got ${gate}`);
  assert.equal(0.0012 >= gate, false, 'soft background room audio below wakeRef*0.20 must be gated out');
  const cappedGate = computeForegroundSpeechGate(0.0002, 0.05);
  assert.ok(cappedGate <= 0.0002 * 6 + 1e-9, `loud wake shout must not push gate above 6x noise floor, got ${cappedGate}`);
});

test('XiaoAI KWS keywords auto-sync, follow-up cancel parsing, and Router non-thinking model setup', async () => {
  // 1. DEFAULT_XIAOAI_KEYWORDS covers all wake variants & zero-initial sandhi without comment lines
  assert.equal(XIAOAI_KEYWORDS_VERSION, 'v7');
  const joined = DEFAULT_XIAOAI_KEYWORDS.join('\n');
  for (const tag of ['@星期五', '@你好星期五', '@嘿星期五', '@嗨星期五', '@喂星期五', '@呼叫星期五']) {
    assert.ok(joined.includes(tag), `Missing wake keyword ${tag}`);
  }
  assert.ok(joined.includes('x īng q ī w ǔ'), 'Missing bare 星期五 variant');
  assert.ok(joined.includes('x īng q ī w u'), 'Missing neutral-tone 星期五 variant');
  assert.ok(joined.includes('x īn q ī w ǔ'), 'Missing front-nasal 星期五 variant');
  assert.ok(joined.includes('x īn q í w ǔ'), 'Missing colloquial front-nasal rising-tone 星期五 variant');
  assert.ok(joined.includes('h ēi x ìn q ī w ǔ'), 'Missing h ēi x ìn q ī w ǔ variant');
  assert.ok(joined.includes('ēi x īng q ī w ǔ'), 'Missing zero-initial 嘿/诶 variant');
  assert.ok(joined.includes('h ái x īng q ī w ǔ'), 'Missing tone-sandhi 嗨 variant');
  assert.ok(DEFAULT_XIAOAI_KEYWORDS.every(line => !line.startsWith('#')), 'No # comment lines inside keywords.txt');

  // Peak-safe KWS gain avoids loud-shout tanh clipping while boosting quiet speech
  const quietChunk = new Float32Array([0.002, -0.001, 0.0015]);
  const loudChunk = new Float32Array([0.25, -0.2, 0.18]);
  const quietGain = computeKwsGain(quietChunk, 0.00035);
  const loudGain = computeKwsGain(loudChunk, 0.00035);
  assert.equal(quietGain, 80);
  assert.ok(loudGain <= 2.25, `Expected loud shout gain <= 2.25, got ${loudGain}`);
  assert.ok(0.25 * loudGain <= 0.56, `Expected peak * gain <= 0.56, got ${0.25 * loudGain}`);

  assert.equal(hasLeadingXiaoaiWakeWord('你好星期五，今天天气怎么样'), true);
  assert.equal(hasLeadingXiaoaiWakeWord('<|zh|>星期五。'), true);
  assert.equal(hasLeadingXiaoaiWakeWord('往右往上'), false);
  assert.equal(cleanXiaoaiAsrUtterance('诶星期五，今天天气怎么样'), '今天天气怎么样');
  assert.equal(cleanXiaoaiAsrUtterance('喂星期五帮我查一下'), '帮我查一下');
  assert.equal(cleanXiaoaiAsrUtterance('你好新期五，打开灯'), '打开灯');
  assert.equal(isXiaoaiFollowUpCancel('不用了。'), true);
  assert.equal(isXiaoaiFollowUpCancel('算了吧'), true);
  assert.equal(isXiaoaiFollowUpCancel('退下呗。'), true);
  assert.equal(isXiaoaiFollowUpCancel('发微信'), false);
  assert.equal(isXiaoaiFollowUpCancel('明天上午九点'), false);
  assert.deepEqual(extractLeadingXiaoaiWakeKeyword('<|zh|>星期五。'), { keyword: '星期五', remainder: '' });
  assert.deepEqual(extractLeadingXiaoaiWakeKeyword('新期五。'), { keyword: '星期五', remainder: '' });
  assert.equal(extractLeadingXiaoaiWakeKeyword('新期五个人去吃饭'), undefined);
  assert.deepEqual(extractLeadingXiaoaiWakeKeyword('星期五，打开客厅灯'), { keyword: '星期五', remainder: '打开客厅灯' });

  // 2. Managed keywords.txt auto-upgrades when version file is missing/outdated; custom file untouched
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-kw-'));
  try {
    const kwsDir = join(home, 'xiaoai-kws');
    await mkdir(join(kwsDir, 'models'), { recursive: true });
    for (const file of ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']) {
      await writeFile(join(kwsDir, 'models', file), 'dummy');
    }
    await writeFile(join(kwsDir, 'keywords.txt'), 'old-line @你好星期五\n');

    const streamA = new PassThrough();
    const monitorA = new XiaoaiKwsMonitor({
      homeDir: home,
      streamFactory: () => ({ stdout: streamA, kill: () => streamA.end(), onClose: () => {} }),
      spotterFactory: () => ({
        createStream: () => ({}),
        acceptWaveform: () => {},
        isReady: () => false,
        decode: () => {},
        getResult: () => '',
        reset: () => {},
      }),
    });
    monitorA.sync([{
      id: 'xiaoai-sync',
      platform: 'xiaoai',
      name: '小爱同步',
      enabled: true,
      notifyAll: false,
      allowedSenders: [],
      apiBase: 'ssh://lx06=root@192.0.2.104',
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);
    const syncedKw = await readFile(join(kwsDir, 'keywords.txt'), 'utf8');
    const syncedVer = (await readFile(join(kwsDir, 'keywords.version'), 'utf8')).trim();
    assert.ok(syncedKw.includes('@嘿星期五'));
    assert.equal(syncedVer, XIAOAI_KEYWORDS_VERSION);
    monitorA.close();

    const customKwPath = join(home, 'custom-kw.txt');
    await writeFile(customKwPath, 'custom-only @你好星期五\n');
    const streamB = new PassThrough();
    const monitorB = new XiaoaiKwsMonitor({
      homeDir: home,
      keywordsFile: customKwPath,
      streamFactory: () => ({ stdout: streamB, kill: () => streamB.end(), onClose: () => {} }),
      spotterFactory: () => ({
        createStream: () => ({}),
        acceptWaveform: () => {},
        isReady: () => false,
        decode: () => {},
        getResult: () => '',
        reset: () => {},
      }),
    });
    monitorB.sync([{
      id: 'xiaoai-custom',
      platform: 'xiaoai',
      name: '小爱自定义',
      enabled: true,
      notifyAll: false,
      allowedSenders: [],
      apiBase: 'ssh://lx06=root@192.0.2.104',
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);
    assert.equal(await readFile(customKwPath, 'utf8'), 'custom-only @你好星期五\n');
    monitorB.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  // 3. prepareRouterSessionModel disables CoT thinking for DeepSeek/GLM/MiMo reasoning models on Router
  const ds = prepareRouterSessionModel({
    id: 'deepseek-v4.1-flash',
    api: 'openai-completions',
    reasoning: true,
    compat: { thinkingFormat: 'deepseek' },
    thinkingLevelMap: { off: null, low: 'low' },
  });
  assert.equal(ds.compat?.thinkingFormat, 'deepseek');
  assert.equal(ds.thinkingLevelMap?.off, 'off');

  const glm = prepareRouterSessionModel({
    id: 'glm-5.3-flash',
    api: 'openai-completions',
    reasoning: true,
    thinkingLevelMap: { off: null, high: 'high' },
  });
  assert.equal((glm as { compat?: { thinkingFormat?: string } }).compat?.thinkingFormat, 'deepseek');
  assert.equal(glm.thinkingLevelMap?.off, 'off');

  const plain = prepareRouterSessionModel({
    id: 'gpt-4o-mini',
    api: 'openai-completions',
    reasoning: false,
  });
  assert.equal(plain.reasoning, false);

  // 4. markXiaoaiSpeakingGuard overwrite shrinks guard immediately when playback ends early
  resetXiaoaiRuntimeState();
  try {
    markXiaoaiSpeakingGuard('ch-guard', 'lx06', 18_000);
    assert.equal(isXiaoaiSpeakingSelfEcho('ch-guard', 'lx06', '星期五'), true);
    markXiaoaiSpeakingGuard('ch-guard', 'lx06', 40, true);
    assert.equal(isXiaoaiSpeakingSelfEcho('ch-guard', 'lx06', '星期五'), true);
    await delay(65);
    assert.equal(isXiaoaiSpeakingSelfEcho('ch-guard', 'lx06', '星期五'), false);
  } finally {
    resetXiaoaiRuntimeState();
  }

  // 5. compactHostEventText keeps active voiceModeConstraint and strips it on historical turns
  const activePayload = `HOST_EVENT\n${JSON.stringify({
    kind: 'CHAT',
    deliveryChannel: 'xiaoai',
    voiceModeConstraint: 'short spoken constraint',
    message: { text: '你好' },
  })}`;
  assert.ok(compactHostEventText(activePayload, false).includes('voiceModeConstraint'));
  assert.equal(compactHostEventText(activePayload, true).includes('voiceModeConstraint'), false);
});

test('XiaoAI continuous follow-up confirmation dialog and cross-endpoint switch_channel handoff', async () => {
  // Unit assertions for shouldContinueXiaoaiDialog & directive stripping
  assert.equal(shouldContinueXiaoaiDialog('请问需要定几点？'), true);
  assert.equal(
    shouldContinueXiaoaiDialog('查了一圈，没查到能对上的《醉梦》。帮我确认一下是哪个：你是在哪个平台看到的，或者记得主演、大概剧情？也有可能名字记岔了一点。给个线索我再查一遍。'),
    true,
  );
  assert.equal(shouldContinueXiaoaiDialog('发你微信还是放网页端'), true);
  assert.equal(shouldContinueXiaoaiDialog('好的，后台去办了。'), false);
  assert.equal(shouldContinueXiaoaiDialog('现在凌晨两点整。[[LISTEN]]'), true);
  assert.equal(shouldContinueXiaoaiDialog('需要确认吗？[[END]]'), false);
  assert.equal(
    shouldContinueXiaoaiDialog('好，电视已经能直接控制，刚才往下按了一个，红外码发送成功。要试别的键就说。[[END]]'),
    true,
  );
  assert.equal(shouldContinueXiaoaiDialog('好，刚才往下按了一个。要试别的键就说。'), true);
  assert.equal(shouldContinueXiaoaiDialog('告诉我音箱能不能用蓝牙连手机就行。'), true);
  assert.equal(shouldContinueXiaoaiDialog('有需要随时跟我说。[[END]]'), false);
  assert.deepEqual(stripXiaoaiDialogDirective('确定要删除吗？ [[LISTEN]]'), { text: '确定要删除吗？', directive: 'listen' });
  assert.deepEqual(stripXiaoaiDialogDirective('好，数据已经记下了。[END]'), { text: '好，数据已经记下了。', directive: 'end' });
  assert.deepEqual(stripXiaoaiDialogDirective('已经重新开始测量，请赤脚上秤，45秒内。[ [END] ]'), { text: '已经重新开始测量，请赤脚上秤，45秒内。', directive: 'end' });
  assert.deepEqual(stripXiaoaiDialogDirective('要再试一次吗？[LISTEN]'), { text: '要再试一次吗？', directive: 'listen' });
  assert.deepEqual(stripXiaoaiDialogDirective('要再试一次吗？[ [ LISTEN ] ]'), { text: '要再试一次吗？', directive: 'listen' });
  assert.deepEqual(stripXiaoaiDialogDirective('好的。【END】'), { text: '好的。', directive: 'end' });
  assert.deepEqual(stripXiaoaiDialogDirective('继续说？【【LISTEN】】'), { text: '继续说？', directive: 'listen' });
  assert.deepEqual(stripXiaoaiDialogDirective('详见 [end](https://example.com) 说明'), { text: '详见 [end](https://example.com) 说明' });
  assert.equal(shouldContinueXiaoaiDialog('好，数据已经记下了。[END]'), false);
  assert.equal(shouldContinueXiaoaiDialog('已经重新开始测量，请赤脚上秤，45秒内。[ [END] ]'), false);
  assert.equal(shouldContinueXiaoaiDialog('要再试一次吗？[LISTEN]'), true);
  assert.equal(shouldContinueXiaoaiDialog('要再试一次吗？[ [ LISTEN ] ]'), true);
  assert.equal(sanitizeForSpeech('好，数据已经记下了。[END]'), '好，数据已经记下了。');
  assert.equal(sanitizeForSpeech('已经重新开始测量，请赤脚上秤，45秒内。[ [END] ]'), '已经重新开始测量，请赤脚上秤，45秒内。');
  assert.equal(sanitizeForSpeech('要再试一次吗？[ [ LISTEN ] ]'), '要再试一次吗？');
  assert.equal(sanitizeForSpeech('好的。【END】'), '好的。');
  assert.equal(sanitizeForSpeech('详见 [end](https://example.com) 说明'), '详见 end 说明');
  assert.equal(sanitizeForSpeech('请问定几点？[[LISTEN]]'), '请问定几点？');
  assert.equal(sanitizeForSpeech('要我现在去查这台音箱支不支持蓝牙输入？</br>'), '要我现在去查这台音箱支不支持蓝牙输入？');

  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-dialog-'));
  try {
    const sshCalls: Array<{ targetId: string; command: string }> = [];
    const sshRunner: XiaoaiSshRunner = async (target, remoteCommand) => {
      sshCalls.push({ targetId: target.id, command: remoteCommand });
      if (remoteCommand.includes('instruction.log')) return { stdout: '', stderr: '', code: 0 };
      if (remoteCommand.includes('player_get_play_status')) {
        return { stdout: '{"code":0,"info":"{ \\"status\\": 0 }"}', stderr: '', code: 0 };
      }
      return { stdout: '{"code":0}', stderr: '', code: 0 };
    };

    const wechatOutbound: Array<{ url: string; body: Record<string, unknown> }> = [];
    const wechatServer = createServer(async (req, res) => {
      if (req.url === '/ilink/bot/getupdates') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ret: 0, get_updates_buf: 'buf-1', msgs: [] }));
        return;
      }
      const raw = await readReqBody(req);
      wechatOutbound.push({ url: req.url ?? '', body: JSON.parse(raw || '{}') as Record<string, unknown> });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ret: 0 }));
    });
    await new Promise<void>((resolve) => wechatServer.listen(0, '127.0.0.1', () => resolve()));
    const wechatPort = (wechatServer.address() as { port: number }).port;

    let audioStream: PassThrough | undefined;
    const asrQueue = ['帮我设个提醒', '明天早上九点', '不用了', '切到微信', '切到网页端'];
    const customFactory: AgentFactory = {
      mode: 'offline',
      nativeTools: false,
      async create(role, _id, tools) {
        if (role === 'router') {
          return {
            async prompt(rawPrompt) {
              const event = JSON.parse(rawPrompt) as { kind?: string; message?: { text?: string } };
              if (event.kind !== 'CHAT') return '完成。';
              const text = event.message?.text ?? '';
              const switchTool = tools.find(t => t.name === 'switch_channel');
              if (text === '帮我设个提醒') {
                return '好的，请问要设在几点？';
              }
              if (text === '明天早上九点') {
                return '好的，已记下明天九点提醒。';
              }
              if (text === '切到微信' && switchTool) {
                await switchTool.execute(JSON.stringify({ channel: 'wechat' }));
                return '这是微信端收到的完整长报告内容：一、状态正常；二、磁盘充足。';
              }
              if (text === '切到网页端' && switchTool) {
                await switchTool.execute(JSON.stringify({ channel: 'web' }));
                return '这是网页端控制台收到的详细技术报告，不会在小爱音箱念出。';
              }
              return '收到。';
            },
            close() {},
          };
        }
        return offlineFactory().create(role, _id, tools);
      },
    };

    const coordinator = new Coordinator(home, customFactory);
    await coordinator.ready();
    try {
      coordinator.im.xiaoaiDeps = {
        sshRunner,
        kwsCooldownMs: 20,
        kwsProbeDurationMs: 25,
        kwsChimeDiscardMs: 20,
        kwsEndSilenceMs: 40,
        kwsMaxWaitSpeechMs: 600,
        kwsStreamFactory: () => {
          audioStream = new PassThrough();
          return { stdout: audioStream, kill: () => audioStream?.end(), onClose: () => {} };
        },
        kwsSpotterFactory: () => {
          const state = { peak: 0 };
          return {
            createStream: () => ({ state }),
            acceptWaveform: (_s, samples) => {
              for (const v of samples) {
                const abs = Math.abs(v);
                if (abs > state.peak) state.peak = abs;
              }
            },
            isReady: () => state.peak >= 0.65,
            decode: () => {},
            getResult: () => (state.peak >= 0.65 ? '嘿星期五' : ''),
            reset: () => { state.peak = 0; },
          };
        },
        kwsRecognizerFactory: () => ({ transcribe: async () => asrQueue.shift() ?? '' }),
      };
      coordinator.im.saveChannel({
        id: 'wechat-test',
        platform: 'wechat',
        name: '测试微信',
        apiBase: `http://127.0.0.1:${wechatPort}`,
        botToken: 'bot-tok-test',
        accountId: 'acc-1',
        defaultTarget: 'wx-boss-1',
        pollIntervalMs: 5000,
        notifyAll: false,
      });
      coordinator.im.saveChannel({
        id: 'xiaoai-dialog',
        platform: 'xiaoai',
        name: '小爱连续对话',
        apiBase: 'ssh://lx06=root@192.0.2.104',
        pollIntervalMs: 50,
        notifyAll: false,
      });
      await until(() => Boolean(audioStream));

      const pushSamples = (amp: number, count: number) => {
        const buf = Buffer.alloc(count * 2);
        const val = Math.round(amp * 32767);
        for (let i = 0; i < count; i++) buf.writeInt16LE(val, i * 2);
        audioStream!.write(buf);
      };
      const wakeCount = () => sshCalls.filter(c => c.command.includes('wakeup_zai_01.wav')).length;
      const ttsTexts = () => sshCalls.filter(c => c.command.includes('text_to_speech')).map(c => c.command);

      // Turn 1 (with wake): asks "请问要设在几点？" -> waits for completion -> lights listen LED without chime
      pushSamples(0.75, 16);
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => ttsTexts().some(c => c.includes('请问要设在几点')));
      await until(() => sshCalls.filter(c => c.command.includes('/bin/show_led 1')).length >= 2);
      const chimesAfterQ1 = wakeCount();

      // Turn 2 (NO wake word! Follow-up mode captures directly): "明天早上九点" -> final statement ends dialog
      await until(() => coordinator.im.getXiaoaiKwsStatus('xiaoai-dialog', 'lx06')?.capturing === true);
      pushSamples(0, 3200); // > 180ms follow-up discard
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => ttsTexts().some(c => c.includes('已记下明天九点提醒')));
      assert.equal(wakeCount(), chimesAfterQ1, 'Follow-up turn must not require re-wake or chime');
      await delay(50);
      assert.equal(
        Boolean(coordinator.im.getXiaoaiKwsStatus('xiaoai-dialog', 'lx06')?.capturing),
        false,
        'Speaker must return to standby after final statement',
      );

      // Verify cancel phrase ("不用了") during follow-up capture does not send to Coordinator
      const msgsBeforeCancel = coordinator.store.conversation.history(undefined, 20).items.length;
      assert.equal(coordinator.im.enterXiaoaiFollowUpCapture('xiaoai-dialog', 'lx06', { waitMs: 1200, discardMs: 0 }), true);
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => !coordinator.im.getXiaoaiKwsStatus('xiaoai-dialog', 'lx06')?.capturing);
      await delay(60);
      assert.equal(coordinator.store.conversation.history(undefined, 20).items.length, msgsBeforeCancel);

      // Turn 3: xiaoai -> wechat handoff: speaker hears brief voice notice, WeChat gets full report
      pushSamples(0.75, 16);
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => wechatOutbound.some(r => r.url.startsWith('/ilink/bot/sendmessage')) && ttsTexts().some(c => c.includes('已发到微信')));
      const wxSend = wechatOutbound.find(r => r.url.startsWith('/ilink/bot/sendmessage'))!;
      const wxMsg = JSON.stringify(wxSend.body);
      assert.match(wxMsg, /完整长报告内容/);
      assert.equal(ttsTexts().some(c => c.includes('完整长报告内容')), false, 'Long WeChat report must not play on speaker');

      // Turn 4: xiaoai -> web handoff: speaker hears brief web notice, full reply saved locally only
      await delay(40);
      const ttsBeforeWeb = ttsTexts().length;
      pushSamples(0.75, 16);
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => ttsTexts().slice(ttsBeforeWeb).some(c => c.includes('已转到网页端')));
      await delay(60);
      assert.equal(ttsTexts().some(c => c.includes('详细技术报告')), false, 'Long Web reply must not play on speaker');
      const webMsgs = coordinator.store.conversation.history(undefined, 30).items;
      assert.ok(webMsgs.some(m => m.text.includes('详细技术报告') && m.origin?.channel === 'local'));
    } finally {
      await coordinator.close();
      await new Promise<void>(resolve => wechatServer.close(() => resolve()));
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoAI TV Remote Mode: zero-LLM deterministic keys, empty/timeout/noise capture persistence, and clean exit / idle TTL expiry', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-tvremote-'));
  try {
    const sshCalls: Array<{ targetId: string; command: string }> = [];
    const sshRunner: XiaoaiSshRunner = async (target, remoteCommand) => {
      sshCalls.push({ targetId: target.id, command: remoteCommand });
      if (remoteCommand.includes('instruction.log')) return { stdout: '', stderr: '', code: 0 };
      if (remoteCommand.includes('player_get_play_status')) {
        return { stdout: '{"code":0,"info":"{ \\"status\\": 0 }"}', stderr: '', code: 0 };
      }
      return { stdout: '{"code":0}', stderr: '', code: 0 };
    };

    let audioStream: PassThrough | undefined;
    const asrQueue = [
      '遥控电视模式。',
      '往下。',
      '。',
      '这不是我写的字。',
      '往下两下再确认',
      '呃，往右往上。',
      '网友。',
      '退出遥控',
      '遥控电视模式',
      '遥控电视模式',
      '你好星期五，今天天气怎么样',
      '测试电视能力',
      '马上。',
      '哪下啊。',
      '退出遥控',
    ];
    let routerChatCalls = 0;
    const routerTexts: string[] = [];

    const customFactory: AgentFactory = {
      mode: 'offline',
      nativeTools: false,
      async create(role, id, tools) {
        if (role === 'router') {
          return {
            async prompt(rawPrompt) {
              const event = JSON.parse(rawPrompt) as { kind?: string; message?: { text?: string } };
              if (event.kind === 'CHAT') {
                routerChatCalls++;
                const text = event.message?.text ?? '';
                routerTexts.push(text);
                if (text === '测试电视能力') {
                  return '好，刚才往下按了一个，红外码发送成功。要试别的键就说。[[END]]';
                }
              }
              return '不该走到路由。';
            },
            close() {},
          };
        }
        return offlineFactory().create(role, id, tools);
      },
    };

    const coordinator = new Coordinator(home, customFactory);
    await coordinator.ready();
    const tvCfg: TestTvPluginConfig = {
      idleTtlMs: 3_000,
      captureWaitMs: 220,
      stepIntervalMs: 10,
    };
    const uninstallTvPlugin = await installTestTvFastpathPlugin(home, 'root@192.0.2.104', sshRunner, tvCfg);
    try {
      (coordinator.im as any).ctx.runVoiceFastpath = (req: Parameters<typeof tryPluginVoiceFastpath>[1]) =>
        tryPluginVoiceFastpath(home, req, { allowedPlugins: ['test-tv-ir'] });
      coordinator.im.xiaoaiDeps = {
        sshRunner,
        kwsCooldownMs: 20,
        kwsProbeDurationMs: 25,
        kwsChimeDiscardMs: 20,
        kwsEndSilenceMs: 40,
        kwsMaxWaitSpeechMs: 600,
        kwsStreamFactory: () => {
          audioStream = new PassThrough();
          return { stdout: audioStream, kill: () => audioStream?.end(), onClose: () => {} };
        },
        kwsSpotterFactory: () => {
          const state = { peak: 0 };
          return {
            createStream: () => ({ state }),
            acceptWaveform: (_s, samples) => {
              for (const v of samples) {
                const abs = Math.abs(v);
                if (abs > state.peak) state.peak = abs;
              }
            },
            isReady: () => state.peak >= 0.65,
            decode: () => {},
            getResult: () => (state.peak >= 0.65 ? '嘿星期五' : ''),
            reset: () => { state.peak = 0; },
          };
        },
        kwsRecognizerFactory: () => ({ transcribe: async () => asrQueue.shift() ?? '' }),
      };

      coordinator.im.saveChannel({
        id: 'xiaoai-tv',
        platform: 'xiaoai',
        name: '小爱电视遥控',
        apiBase: 'ssh://lx06=root@192.0.2.104',
        pollIntervalMs: 50,
        notifyAll: false,
      });
      await until(() => Boolean(audioStream));

      const pushSamples = (amp: number, count: number) => {
        const buf = Buffer.alloc(count * 2);
        const val = Math.round(amp * 32767);
        for (let i = 0; i < count; i++) buf.writeInt16LE(val, i * 2);
        audioStream!.write(buf);
      };
      const irPlayCommands = () => sshCalls.filter(c => c.command.includes('call ir_agent play')).map(c => c.command);
      const ttsCommands = () => sshCalls.filter(c => c.command.includes('text_to_speech')).map(c => c.command);
      const listenLedCount = () => sshCalls.filter(c => c.command.includes('/bin/show_led 1')).length;

      const downCode = TEST_TV_IR_CODES.down;
      const upCode = TEST_TV_IR_CODES.up;
      const rightCode = TEST_TV_IR_CODES.right;
      const okCode = TEST_TV_IR_CODES.ok;

      // 1. Enter remote mode via KWS ("遥控电视模式。") -> zero Router LLM calls, announces entry, arms follow-up capture
      pushSamples(0.75, 16);
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => ttsCommands().some(c => c.includes('已进入遥控模式')));
      await until(() => coordinator.im.getXiaoaiKwsStatus('xiaoai-tv', 'lx06')?.capturing === true);
      assert.equal(routerChatCalls, 0, 'Entering TV remote mode must not invoke Router LLM');

      // 2. Direct key without wake word ("往下。") -> instant IR play, zero TTS, zero Router LLM
      const ttsBeforePress = ttsCommands().length;
      pushSamples(0, 2200); // > 120ms entry discard
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => irPlayCommands().length === 1);
      assert.ok(irPlayCommands()[0]!.includes(downCode), 'Should emit TV down IR code');
      assert.ok(irPlayCommands()[0]!.includes('/bin/show_led 1'), 'Should refresh listen LED in same SSH call');
      assert.equal(ttsCommands().length, ttsBeforePress, 'In-mode button press must not block on TTS');
      assert.equal(routerChatCalls, 0, 'In-mode press must not invoke Router LLM');
      assert.equal(Boolean(coordinator.im.getXiaoaiKwsStatus('xiaoai-tv', 'lx06')?.capturing), true);

      // 3. Reproduce 12:46:39 empty ASR bug ("。") -> must NOT exit capture or turn off LED
      const ledsBeforeNoise = listenLedCount();
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => listenLedCount() > ledsBeforeNoise);
      await delay(30);
      assert.equal(
        Boolean(coordinator.im.getXiaoaiKwsStatus('xiaoai-tv', 'lx06')?.capturing),
        true,
        'Empty ASR punctuation during TV remote mode must stay capturing',
      );
      assert.equal(routerChatCalls, 0);

      // 4. Silence wait timeout (< 3000ms idle TTL) -> must automatically re-arm capture instead of dropping out
      const ledsBeforeTimeout = listenLedCount();
      pushSamples(0, 4000); // 250ms > 220ms captureWaitMs
      await until(() => listenLedCount() > ledsBeforeTimeout);
      await delay(30);
      assert.equal(
        Boolean(coordinator.im.getXiaoaiKwsStatus('xiaoai-tv', 'lx06')?.capturing),
        true,
        'Wait timeout before idle TTL must automatically re-arm capture',
      );

      // 5. Unrecognized background speech ("这不是我写的字。") -> ignored cleanly, capture remains active
      const ledsBeforeIgnored = listenLedCount();
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => listenLedCount() > ledsBeforeIgnored);
      assert.equal(irPlayCommands().length, 1, 'Unrecognized speech must not emit IR');
      assert.equal(routerChatCalls, 0, 'Unrecognized speech in remote mode must not invoke Router LLM');
      assert.equal(Boolean(coordinator.im.getXiaoaiKwsStatus('xiaoai-tv', 'lx06')?.capturing), true);

      // 6. Combo phrase after noise/timeout recovery ("往下两下再确认") -> down, down, ok
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => irPlayCommands().length === 4);
      const addedIr = irPlayCommands().slice(1);
      assert.ok(addedIr[0]!.includes(downCode));
      assert.ok(addedIr[1]!.includes(downCode));
      assert.ok(addedIr[2]!.includes(okCode));
      assert.equal(routerChatCalls, 0);
      assert.equal(Boolean(coordinator.im.getXiaoaiKwsStatus('xiaoai-tv', 'lx06')?.capturing), true);

      // 6b. Concatenated & homophone commands ("呃，往右往上。" + "网友。") -> right, up, right
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => irPlayCommands().length === 6);
      assert.ok(irPlayCommands()[4]!.includes(rightCode));
      assert.ok(irPlayCommands()[5]!.includes(upCode));

      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => irPlayCommands().length === 7);
      assert.ok(irPlayCommands()[6]!.includes(rightCode));
      assert.equal(routerChatCalls, 0);
      assert.equal(Boolean(coordinator.im.getXiaoaiKwsStatus('xiaoai-tv', 'lx06')?.capturing), true);

      // 7. Explicit exit ("退出遥控") -> announces exit and returns speaker to standby
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => ttsCommands().some(c => c.includes('已退出遥控')));
      await delay(40);
      assert.equal(Boolean(coordinator.im.getXiaoaiKwsStatus('xiaoai-tv', 'lx06')?.capturing), false);
      assert.equal(routerChatCalls, 0);

      // 8. Re-enter with short idle TTL and confirm natural idle expiry shuts down LED & returns to standby
      tvCfg.idleTtlMs = 260;
      tvCfg.captureWaitMs = 200;
      const entryTtsBefore = ttsCommands().length;
      pushSamples(0.75, 16);
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => ttsCommands().length > entryTtsBefore);
      await until(() => coordinator.im.getXiaoaiKwsStatus('xiaoai-tv', 'lx06')?.capturing === true);
      const offLedCount = () => sshCalls.filter(c => c.command.includes('/bin/shut_led 1') && !c.command.includes('/bin/show_led')).length;
      const shutLedsBeforeExpiry = offLedCount();
      await delay(290);
      pushSamples(0, 6400); // > 120ms entry discard + 200ms capture wait
      await until(() => !coordinator.im.getXiaoaiKwsStatus('xiaoai-tv', 'lx06')?.capturing);
      await until(() => offLedCount() > shutLedsBeforeExpiry);
      await until(() => ttsCommands().some(c => c.includes('已退出电视遥控模式')));
      assert.equal(routerChatCalls, 0);

      // 9. Explicit wake word + non-TV query ("你好星期五，今天天气怎么样") exits TV remote mode & routes to Router
      tvCfg.idleTtlMs = 3_000;
      tvCfg.captureWaitMs = 220;
      const ttsBeforeReenter = ttsCommands().length;
      pushSamples(0.75, 16);
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => ttsCommands().length > ttsBeforeReenter);
      await until(() => coordinator.im.getXiaoaiKwsStatus('xiaoai-tv', 'lx06')?.capturing === true);
      pushSamples(0, 2200);
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => routerChatCalls === 1 && ttsCommands().some(c => c.includes('不该走到路由')));
      assert.deepEqual(routerTexts, ['今天天气怎么样']);
      await delay(40);
      assert.equal(Boolean(coordinator.im.getXiaoaiKwsStatus('xiaoai-tv', 'lx06')?.capturing), false);

      // 10. Router replying "……要试别的键就说。[[END]]" after testing TV activates continuous local TV remote mode
      const irBeforeInvite = irPlayCommands().length;
      pushSamples(0.75, 16);
      pushSamples(0.15, 480);
      pushSamples(0, 800);
      await until(() => routerChatCalls === 2 && ttsCommands().some(c => c.includes('要试别的键就说')));
      await until(() => coordinator.im.getXiaoaiKwsStatus('xiaoai-tv', 'lx06')?.capturing === true);
      pushSamples(0, 2200); // > 120ms discard
      pushSamples(0.15, 480); // "马上。" -> up
      pushSamples(0, 800);
      await until(() => irPlayCommands().length === irBeforeInvite + 1);
      assert.ok(irPlayCommands()[irBeforeInvite]!.includes(upCode));

      pushSamples(0.15, 480); // "哪下啊。" -> down
      pushSamples(0, 800);
      await until(() => irPlayCommands().length === irBeforeInvite + 2);
      assert.ok(irPlayCommands()[irBeforeInvite + 1]!.includes(downCode));
      assert.equal(routerChatCalls, 2, 'Subsequent button presses must stay zero-LLM local');

      pushSamples(0.15, 480); // "退出遥控"
      pushSamples(0, 800);
      await until(() => !coordinator.im.getXiaoaiKwsStatus('xiaoai-tv', 'lx06')?.capturing);
    } finally {
      uninstallTvPlugin();
      await coordinator.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoAI KWS s32le sub-threshold hiss skips ASR and cancels capture cleanly', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-hiss-'));
  try {
    let audioStream: PassThrough | undefined;
    let transcribeCalls = 0;
    const cancels: Array<{ reason: string; keyword: string }> = [];
    const monitor = new XiaoaiKwsMonitor({
      homeDir: home,
      cooldownMs: 20,
      probeDurationMs: 25,
      chimeDiscardMs: 10,
      maxWaitSpeechMs: 500,
      endSilenceMs: 40,
      speechRmsThreshold: 0.0001,
      streamFactory: () => {
        audioStream = new PassThrough();
        return {
          stdout: audioStream,
          sampleFormat: 's32le',
          kill: () => audioStream?.end(),
          onClose: () => {},
        };
      },
      spotterFactory: () => {
        const state = { peak: 0 };
        return {
          createStream: () => ({ state }),
          acceptWaveform: (_s, samples) => {
            for (const v of samples) {
              const abs = Math.abs(v);
              if (abs > state.peak) state.peak = abs;
            }
          },
          isReady: () => state.peak >= 0.4,
          decode: () => {},
          getResult: () => (state.peak >= 0.4 ? '你好星期五' : ''),
          reset: () => { state.peak = 0; },
        };
      },
      recognizerFactory: () => ({
        transcribe: async () => {
          transcribeCalls++;
          return '我。';
        },
      }),
      onWake: async () => ({ woken: true, suppressed: false }),
      onCaptureCancel: (ev) => {
        cancels.push({ reason: ev.reason, keyword: ev.keyword });
      },
    });
    monitor.sync([{
      id: 'xiaoai-hiss',
      platform: 'xiaoai',
      name: '底噪过滤测试',
      enabled: true,
      notifyAll: false,
      allowedSenders: [],
      apiBase: 'ssh://lx06=root@192.0.2.104',
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);
    await until(() => Boolean(audioStream));

    const pushS32Sine = (amp: number, count: number) => {
      const buf = Buffer.alloc(count * 4);
      for (let i = 0; i < count; i++) {
        const val = amp === 0 ? 0 : amp * Math.sin((2 * Math.PI * 1000 * i) / 16000);
        buf.writeInt32LE(Math.round(val * 2147483647), i * 4);
      }
      audioStream!.write(buf);
    };

    // Wake into two-step capture, discard 10ms chime tail, then emit ultra-quiet thermal hiss (~0.00035 RMS < 0.0010)
    pushS32Sine(0.5, 400);
    pushS32Sine(0, 480);
    await until(() => monitor.isCapturing('xiaoai-hiss', 'lx06'));
    pushS32Sine(0, 200);
    pushS32Sine(0.0005, 640);
    pushS32Sine(0, 800);
    await until(() => cancels.length === 1);
    assert.equal(cancels[0]!.reason, 'empty');
    assert.equal(transcribeCalls, 0, 'Sub-0.0010 RMS S32_LE hiss must skip ASR completely');
    monitor.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

function synthToneSamples(freqHz: number, durationMs: number, amplitude = 0.2, sampleRate = SPEAKER_SAMPLE_RATE): Float32Array {
  const total = Math.round((sampleRate * durationMs) / 1000);
  const out = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

function encodeFloat32ToS16Le(samples: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return buf;
}

function concatAudio(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function createBandSpeakerExtractorFactory(): () => XiaoaiSpeakerExtractor {
  const computeVector = (samples: Float32Array, sampleRate: number): Float32Array => {
    const weights = new Float32Array(4); // [200Hz owner, 800Hz wife, 3200Hz tv, fallback]
    const win = Math.max(160, Math.round(sampleRate * 0.04));
    for (let start = 0; start + 32 <= samples.length; start += win) {
      const end = Math.min(samples.length, start + win);
      let energy = 0;
      let crossings = 0;
      let prev = samples[start]!;
      for (let i = start; i < end; i++) {
        const cur = samples[i]!;
        energy += cur * cur;
        if ((prev < 0 && cur >= 0) || (prev > 0 && cur <= 0)) {
          crossings++;
        }
        prev = cur;
      }
      const rms = Math.sqrt(energy / (end - start));
      if (rms < 0.008) continue;
      const zcr = crossings / (end - start);
      if (zcr < 0.06) {
        weights[0]! += rms;
      } else if (zcr < 0.22) {
        weights[1]! += rms;
      } else {
        weights[2]! += rms;
      }
    }
    let norm = 0;
    for (let i = 0; i < weights.length; i++) norm += weights[i]! * weights[i]!;
    if (norm === 0) weights[3] = 1;
    else {
      const inv = 1 / Math.sqrt(norm);
      for (let i = 0; i < weights.length; i++) weights[i] = weights[i]! * inv;
    }
    return weights;
  };

  return () => ({
    dim: 4,
    extract(samples: Float32Array, sampleRate: number): Float32Array | undefined {
      return computeVector(samples, sampleRate);
    },
    free() {},
  });
}

test('XiaoaiSpeakerManager multi-speaker profiles, TV-tail trimming, and command parsing', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-spk-unit-'));
  try {
    assert.deepEqual(parseSpeakerVoiceCommand('你好星期五，录入我的声纹'), { kind: 'enroll', mode: 'replace' });
    assert.deepEqual(parseSpeakerVoiceCommand('帮老婆录入声纹'), { kind: 'enroll', targetName: '老婆', mode: 'replace' });
    assert.deepEqual(parseSpeakerVoiceCommand('给爸爸补充声纹'), { kind: 'enroll', targetName: '爸爸', mode: 'append' });
    assert.deepEqual(parseSpeakerVoiceCommand('我是谁'), { kind: 'whoami' });
    assert.deepEqual(parseSpeakerVoiceCommand('查看声纹列表'), { kind: 'list' });
    assert.deepEqual(parseSpeakerVoiceCommand('删除小明的声纹'), { kind: 'remove', targetName: '小明' });
    assert.deepEqual(parseSpeakerVoiceCommand('清空所有声纹'), { kind: 'clear' });
    assert.deepEqual(parseSpeakerVoiceCommand('暂停声纹识别'), { kind: 'toggle', enabled: false });
    assert.deepEqual(parseSpeakerVoiceCommand('开启声纹识别'), { kind: 'toggle', enabled: true });
    assert.equal(parseSpeakerVoiceCommand('今天天气怎么样'), undefined);
    assert.equal(isEnrollCancelPhrase('不用了取消吧'), true);

    const extractorFactory = createBandSpeakerExtractorFactory();
    const manager = new XiaoaiSpeakerManager({ homeDir: home, extractorFactory });

    // Inactive while empty -> passes everything through
    assert.equal(manager.isVerificationActive(), false);
    assert.equal(manager.verifyWakeSlice(synthToneSamples(3200, 600), SPEAKER_SAMPLE_RATE, '星期五').matched, true);

    // Enroll owner (200Hz) and member (800Hz)
    const ownerEmb = manager.extractEmbedding(synthToneSamples(200, 1200))!;
    const wifeEmb = manager.extractEmbedding(synthToneSamples(800, 1200))!;
    const tvSamples = synthToneSamples(3200, 3000);

    const owner = manager.enrollEmbeddings({ name: '主人', role: 'owner', embeddings: [ownerEmb] });
    assert.equal(owner.role, 'owner');
    assert.equal(manager.isVerificationActive(), true);
    assert.equal(manager.isVerificationActive({ speakerVerify: false }), false);

    const wife = manager.enrollEmbeddings({ name: '老婆', embeddings: [wifeEmb] });
    assert.equal(wife.role, 'member');
    const wifeAppended = manager.enrollEmbeddings({ name: '老婆', mode: 'append', embeddings: [wifeEmb] });
    assert.equal(wifeAppended.sampleCount, 2);

    // Stage 1 wake precheck (including 1.80s ring buffer with long leading room noise + short "星期五")
    assert.equal(manager.verifyWakeSlice(synthToneSamples(200, 700), SPEAKER_SAMPLE_RATE, '星期五').matched, true);
    assert.equal(manager.verifyWakeSlice(synthToneSamples(3200, 700), SPEAKER_SAMPLE_RATE, '星期五').matched, false);
    const ringWithLeadingNoise = concatAudio(
      synthToneSamples(3200, 1150, 0.02),
      synthToneSamples(200, 650, 0.12),
    );
    const trimmedWake = trimWakeSpeechWindow(ringWithLeadingNoise, SPEAKER_SAMPLE_RATE);
    assert.ok(
      trimmedWake.length >= Math.round(SPEAKER_SAMPLE_RATE * 0.65)
        && trimmedWake.length <= Math.round(SPEAKER_SAMPLE_RATE * 0.90),
      `Expected leading noise trimmed to [0.65s, 0.90s], got ${(trimmedWake.length / SPEAKER_SAMPLE_RATE).toFixed(2)}s`,
    );
    assert.equal(manager.verifyWakeSlice(ringWithLeadingNoise, SPEAKER_SAMPLE_RATE, '星期五').matched, true);
    const ringWithTvSpeech = concatAudio(
      synthToneSamples(3200, 1150, 0.02),
      synthToneSamples(3200, 650, 0.12),
    );
    assert.equal(manager.verifyWakeSlice(ringWithTvSpeech, SPEAKER_SAMPLE_RATE, '星期五').matched, false);

    // Stage 2 pure TV rejection
    const tvCheck = manager.verifyAndTrimUtterance(tvSamples, SPEAKER_SAMPLE_RATE);
    assert.equal(tvCheck.matched, false);

    // Stage 2 tail trimming: 2.0s owner + 3.5s TV
    const ownerThenTv = concatAudio(synthToneSamples(200, 2000), synthToneSamples(3200, 3500));
    const trimmedRes = manager.verifyAndTrimUtterance(ownerThenTv, SPEAKER_SAMPLE_RATE);
    assert.equal(trimmedRes.matched, true);
    assert.equal(trimmedRes.speaker?.name, '主人');
    assert.equal(trimmedRes.trimmed, true);
    assert.ok(trimmedRes.samples.length <= Math.round(SPEAKER_SAMPLE_RATE * 2.9), `Expected TV tail trimmed (got ${trimmedRes.samples.length} samples)`);

    // Stage 2 short prefix + long TV tail (1.0s owner + 4.0s TV) rescued by sliding window
    const shortOwnerLongTv = concatAudio(synthToneSamples(200, 1000), synthToneSamples(3200, 4000));
    const rescuedRes = manager.verifyAndTrimUtterance(shortOwnerLongTv, SPEAKER_SAMPLE_RATE);
    assert.equal(rescuedRes.matched, true);
    assert.equal(rescuedRes.speaker?.name, '主人');
    assert.equal(rescuedRes.trimmed, true);
    assert.ok(rescuedRes.samples.length <= Math.round(SPEAKER_SAMPLE_RATE * 1.9));

    // Lazy sliding-window evaluation stops early once TV speech begins instead of scanning entire 8s tail
    let lazyExtractCalls = 0;
    const countingFactory = () => {
      const inner = extractorFactory();
      return {
        dim: inner.dim,
        extract(samples: Float32Array, sampleRate: number) {
          lazyExtractCalls++;
          return inner.extract(samples, sampleRate);
        },
        free: () => inner.free?.(),
      };
    };
    const lazyManager = new XiaoaiSpeakerManager({ homeDir: home, extractorFactory: countingFactory });
    const longTailClip = concatAudio(synthToneSamples(200, 1200), synthToneSamples(3200, 8000));
    const lazyRes = lazyManager.verifyAndTrimUtterance(longTailClip, SPEAKER_SAMPLE_RATE);
    assert.equal(lazyRes.matched, true);
    assert.equal(lazyRes.trimmed, true);
    assert.ok(lazyRes.samples.length <= Math.round(SPEAKER_SAMPLE_RATE * 2.1));
    assert.ok(lazyExtractCalls <= 7, `Expected lazy sliding-window scan (<=7 extracts), got ${lazyExtractCalls}`);

    // Configure rename/role & removing owner promotes remaining member to owner
    manager.configure({ threshold: 0.48, rename: { target: '老婆', name: '太太' } });
    assert.equal(manager.findProfile('太太')?.name, '太太');
    const removedOwner = manager.removeSpeaker('主人');
    assert.equal(removedOwner.removed, true);
    assert.equal(removedOwner.remaining, 1);
    assert.equal(manager.findProfile('太太')?.role, 'owner');

    // Interactive enrollment controller retries + cancel + completion
    const ctrl = new XiaoaiSpeakerEnrollController({ stepTtlMs: 30_000 });
    const prep = ctrl.createPreparingSession({ channelId: 'c1', targetId: 't1', speakerName: '小明', role: 'member', mode: 'replace' });
    ctrl.activateSession(prep.sessionId);
    const shortRes = ctrl.processSample({
      channelId: 'c1',
      targetId: 't1',
      samples: synthToneSamples(200, 300),
      transcript: '你好',
      extractor: (s, sr) => manager.extractEmbedding(s, sr),
    });
    assert.equal(shortRes.outcome, 'retry');
    const step1 = ctrl.processSample({
      channelId: 'c1',
      targetId: 't1',
      samples: synthToneSamples(200, 1000),
      transcript: '第一句声纹样本',
      extractor: (s, sr) => manager.extractEmbedding(s, sr),
    });
    assert.equal(step1.outcome, 'next_step');
    const mismatchTv = ctrl.processSample({
      channelId: 'c1',
      targetId: 't1',
      samples: synthToneSamples(3200, 1000),
      transcript: '电视插话',
      extractor: (s, sr) => manager.extractEmbedding(s, sr),
    });
    assert.equal(mismatchTv.outcome, 'retry');
    assert.equal(ctrl.isActive('c1', 't1'), true);
    assert.equal(ctrl.processSample({
      channelId: 'c1',
      targetId: 't1',
      transcript: '取消录入',
      extractor: (s, sr) => manager.extractEmbedding(s, sr),
    }).outcome, 'cancelled');

    const cleared = manager.clearSpeakers();
    assert.equal(cleared.cleared, 1);
    manager.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoAI E2E voiceprint enrollment, multi-speaker recognition, TV rejection, and poll bypass blocking', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-spk-e2e-'));
  try {
    const sshCalls: Array<{ targetId: string; command: string }> = [];
    let simulateUnverifiedLogLine = false;
    const sshRunner: XiaoaiSshRunner = async (target, remoteCommand) => {
      sshCalls.push({ targetId: target.id, command: remoteCommand });
      if (remoteCommand.includes('instruction.log')) {
        return {
          stdout: simulateUnverifiedLogLine ? '__LINE__:999:{"dialog_id":"log-tv","text":"星期五打开电视"}\n' : '',
          stderr: '',
          code: 0,
        };
      }
      if (remoteCommand.includes('player_get_play_status')) {
        return { stdout: '{"code":0,"info":"{ \\"status\\": 0 }"}', stderr: '', code: 0 };
      }
      return { stdout: '{"code":0}', stderr: '', code: 0 };
    };

    let audioStream: PassThrough | undefined;
    const asrQueue = [
      // 1. Pre-enrollment backward compatibility
      '你好星期五，现在几点了',
      // 2. Owner voice enrollment ("录入我的声纹" + 3 owner utterances)
      '你好星期五，录入我的声纹',
      '今天天气真不错，适合出门散步',
      '明天早上记得提醒我喝水',
      '帮我把客厅灯光调亮一点',
      // 3. Wife voice enrollment triggered by owner ("帮老婆录入声纹" + 3 wife utterances)
      '你好星期五，帮老婆录入声纹',
      '我想周末去看电影',
      '顺便帮我查一下明天下雨吗',
      '晚饭记得多放点青菜',
      // 4. Follow-up dialog initiated by owner ("今天安排提醒") -> TV speaks (rejected before ASR) -> wife replies
      '你好星期五，今天安排提醒',
      '买瓶牛奶',
      // 5. Voice management: whoami (wife), list (owner), member clear denied (wife)
      '你好星期五，我是谁',
      '你好星期五，查看声纹列表',
      '你好星期五，清空所有声纹',
      // 6. TV remote mode: owner enters, TV noise rejected, owner presses down -> IR emitted
      '你好星期五，遥控电视模式',
      '往下',
      '退出遥控',
    ];
    let asrCalls = 0;
    const routerEvents: Array<{ text: string; speakerName?: string }> = [];

    const customFactory: AgentFactory = {
      mode: 'offline',
      nativeTools: false,
      async create(role, id, tools) {
        if (role === 'router') {
          return {
            async prompt(rawPrompt) {
              const event = JSON.parse(rawPrompt) as {
                kind?: string;
                message?: { text?: string; origin?: { speakerName?: string } };
              };
              if (event.kind === 'CHAT') {
                const text = event.message?.text ?? '';
                routerEvents.push({ text, speakerName: event.message?.origin?.speakerName });
                if (text === '今天安排提醒') {
                  return '好的，还有其他需要一起提醒的吗？[[ASK]]';
                }
                return `收到：${text}。`;
              }
              return '已处理。';
            },
            close() {},
          };
        }
        return offlineFactory().create(role, id, tools);
      },
    };

    const coordinator = new Coordinator(home, customFactory);
    await coordinator.ready();
    const uninstallTvPlugin = await installTestTvFastpathPlugin(
      home,
      'root@192.0.2.99',
      sshRunner,
      { idleTtlMs: 3_000, captureWaitMs: 600, stepIntervalMs: 10 },
    );
    try {
      const downCode = TEST_TV_IR_CODES.down;
      (coordinator.im as any).ctx.runVoiceFastpath = (req: Parameters<typeof tryPluginVoiceFastpath>[1]) =>
        tryPluginVoiceFastpath(home, req, { allowedPlugins: ['test-tv-ir'] });

      coordinator.im.xiaoaiDeps = {
        sshRunner,
        kwsCooldownMs: 20,
        kwsProbeDurationMs: 25,
        kwsChimeDiscardMs: 20,
        kwsEndSilenceMs: 40,
        kwsMaxWaitSpeechMs: 1_200,
        speakerEnrollWaitMs: 3_000,
        speakerExtractorFactory: createBandSpeakerExtractorFactory(),
        kwsStreamFactory: () => {
          audioStream = new PassThrough();
          return { stdout: audioStream, sampleFormat: 's16le', kill: () => audioStream?.end(), onClose: () => {} };
        },
        kwsSpotterFactory: () => {
          const state = { wakeSamples: 0 };
          const minWakeSamples = Math.round(SPEAKER_SAMPLE_RATE * 0.5);
          return {
            createStream: () => ({ state }),
            acceptWaveform: (_s, samples) => {
              let peak = 0;
              for (const v of samples) {
                const abs = Math.abs(v);
                if (abs > peak) peak = abs;
              }
              if (peak >= 0.65) {
                state.wakeSamples += samples.length;
              } else if (state.wakeSamples < minWakeSamples) {
                state.wakeSamples = 0;
              }
            },
            isReady: () => state.wakeSamples >= minWakeSamples,
            decode: () => {},
            getResult: () => (state.wakeSamples >= minWakeSamples ? '你好星期五' : ''),
            reset: () => { state.wakeSamples = 0; },
          };
        },
        kwsRecognizerFactory: () => ({
          transcribe: async () => {
            asrCalls++;
            return asrQueue.shift() ?? '';
          },
        }),
      };

      coordinator.im.saveChannel({
        id: 'xiaoai-spk',
        platform: 'xiaoai',
        name: '客厅声纹小爱',
        enabled: true,
        notifyAll: false,
        allowedSenders: ['lx06'],
        apiBase: 'ssh://lx06=root@192.0.2.99?kws=1&chime=0',
        defaultTarget: 'lx06',
        pollIntervalMs: 50,
      });
      await until(() => Boolean(audioStream));

      const ttsCommands = () => sshCalls
        .filter(c => c.command.includes('text_to_speech'))
        .map(c => c.command);
      const irPlayCommands = () => sshCalls
        .filter(c => c.command.includes('call ir_agent play'))
        .map(c => c.command);

      const pushChunked = async (samples: Float32Array, stepMs = 40) => {
        const chunkLen = Math.round((SPEAKER_SAMPLE_RATE * stepMs) / 1000);
        for (let off = 0; off < samples.length; off += chunkLen) {
          audioStream!.write(encodeFloat32ToS16Le(samples.subarray(off, off + chunkLen)));
        }
      };
      const sendSpokenTurn = async (freqHz: number, bodyMs = 1000, wake = true) => {
        const parts: Float32Array[] = [];
        if (wake) {
          parts.push(synthToneSamples(freqHz, 600, 0.72));
        }
        parts.push(synthToneSamples(freqHz, bodyMs, 0.2));
        parts.push(synthToneSamples(0, 160, 0));
        await pushChunked(concatAudio(...parts));
      };

      // 1. Pre-enrollment wake + query passes unobstructed
      await sendSpokenTurn(200, 600, true);
      await until(() => routerEvents.length === 1 && ttsCommands().some(c => c.includes('收到：现在几点了')));
      assert.equal(routerEvents[0]!.text, '现在几点了');
      await delay(35);

      // 2. Owner voice-triggered enrollment (no model needed because custom extractor factory is provided)
      await sendSpokenTurn(200, 700, true);
      await until(() => ttsCommands().some(c => c.includes('开始为主人录入声纹')));
      await until(() => coordinator.im.getXiaoaiKwsStatus('xiaoai-spk', 'lx06')?.capturing === true);
      for (const expectedPrompt of ['请说第 2 句', '请说第 3 句', '已保存主人的声纹']) {
        await pushChunked(synthToneSamples(0, 200, 0)); // clear discard window
        await sendSpokenTurn(200, 1000, false);
        await until(() => ttsCommands().some(c => c.includes(expectedPrompt)));
        if (expectedPrompt !== '已保存主人的声纹') {
          await until(() => coordinator.im.getXiaoaiKwsStatus('xiaoai-spk', 'lx06')?.capturing === true);
        }
      }
      await delay(35);

      // 3. Stage 1 wake precheck rejects TV (3200Hz) completely -> zero ASR calls
      const asrBeforeTvWake = asrCalls;
      const tvWakeWait = ttsCommands().length;
      await sendSpokenTurn(3200, 800, true);
      await delay(80);
      assert.equal(asrCalls, asrBeforeTvWake, 'TV wake phrase must be dropped at Stage 1 without waking ASR');
      assert.equal(ttsCommands().length, tvWakeWait);

      // 4. Owner enrolls family member '老婆' (800Hz) via voice
      const ttsBeforeWife = ttsCommands().length;
      await sendSpokenTurn(200, 700, true);
      await until(() => ttsCommands().slice(ttsBeforeWife).some(c => c.includes('开始为老婆录入声纹')));
      await until(() => coordinator.im.getXiaoaiKwsStatus('xiaoai-spk', 'lx06')?.capturing === true);
      for (const expectedTts of ['第 1 句已收到', '第 2 句已收到', '已保存老婆的声纹']) {
        await pushChunked(synthToneSamples(0, 200, 0));
        await sendSpokenTurn(800, 1000, false);
        await until(() => ttsCommands().slice(ttsBeforeWife).some(c => c.includes(expectedTts)));
        if (expectedTts !== '已保存老婆的声纹') {
          await until(() => coordinator.im.getXiaoaiKwsStatus('xiaoai-spk', 'lx06')?.capturing === true);
        }
      }
      await delay(35);

      const status = coordinator.im.getVoiceprintStatus();
      assert.equal(status.active, true);
      assert.deepEqual(
        status.profiles.map(p => ({ name: p.name, role: p.role })),
        [{ name: '主人', role: 'owner' }, { name: '老婆', role: 'member' }],
      );

      // 5. Owner opens follow-up window -> TV speaks 1.8s (rejected silently, window stays alive) -> Wife replies
      await sendSpokenTurn(200, 700, true);
      await until(() => routerEvents.length === 2 && ttsCommands().some(c => c.includes('还有其他需要一起提醒的吗')));
      await until(() => coordinator.im.getXiaoaiKwsStatus('xiaoai-spk', 'lx06')?.capturing === true);
      const asrBeforeFollowUpTv = asrCalls;
      await pushChunked(synthToneSamples(0, 240, 0)); // clear discardMs (150ms)
      await pushChunked(concatAudio(synthToneSamples(3200, 1650, 0.2), synthToneSamples(0, 120, 0))); // continuous TV dialogue rejected live without breaking follow-up
      await delay(60);
      assert.equal(asrCalls, asrBeforeFollowUpTv, 'TV crosstalk during follow-up must not call ASR');
      assert.equal(Boolean(coordinator.im.getXiaoaiKwsStatus('xiaoai-spk', 'lx06')?.capturing), true, 'Follow-up window must stay open for real user');

      await sendSpokenTurn(800, 700, false); // Wife answers inside re-armed follow-up window
      await until(() => routerEvents.length === 3 && ttsCommands().some(c => c.includes('收到：买瓶牛奶')));
      assert.deepEqual(routerEvents[2], { text: '买瓶牛奶', speakerName: '老婆' });
      await delay(35);

      // 6. Voice commands: whoami (wife), list (owner), member denied clear (wife)
      const ttsBeforeWhoami = ttsCommands().length;
      await sendSpokenTurn(800, 700, true);
      await until(() => ttsCommands().slice(ttsBeforeWhoami).some(c => c.includes('你是老婆')));
      await delay(35);

      const ttsBeforeList = ttsCommands().length;
      await sendSpokenTurn(200, 700, true);
      await until(() => ttsCommands().slice(ttsBeforeList).some(c => c.includes('主人（主人）') && c.includes('老婆')));
      await delay(35);

      const ttsBeforeDenied = ttsCommands().length;
      await sendSpokenTurn(800, 700, true);
      await until(() => ttsCommands().slice(ttsBeforeDenied).some(c => c.includes('只有主人或命令行可以清空全部声纹')));
      assert.equal(coordinator.im.getVoiceprintStatus().profiles.length, 2);
      await delay(35);

      // 7. TV remote mode ignores TV dialogue and still accepts owner's key press
      await sendSpokenTurn(200, 700, true);
      await until(() => ttsCommands().some(c => c.includes('已进入遥控模式')));
      await until(() => coordinator.im.getXiaoaiKwsStatus('xiaoai-spk', 'lx06')?.capturing === true);
      await pushChunked(synthToneSamples(0, 200, 0));
      await pushChunked(concatAudio(synthToneSamples(3200, 1650, 0.2), synthToneSamples(0, 120, 0))); // TV rejected in remote mode
      await delay(60);
      assert.equal(irPlayCommands().length, 0);
      assert.equal(Boolean(coordinator.im.getXiaoaiKwsStatus('xiaoai-spk', 'lx06')?.capturing), true);

      await sendSpokenTurn(200, 500, false); // Owner says "往下"
      await until(() => irPlayCommands().length === 1);
      assert.ok(irPlayCommands()[0]!.includes(downCode));
      await until(() => coordinator.im.getXiaoaiKwsStatus('xiaoai-spk', 'lx06')?.capturing === true);
      await sendSpokenTurn(200, 500, false); // "退出遥控"
      await until(() => ttsCommands().some(c => c.includes('已退出遥控')));

      // 8. Unverified instruction.log polling is suppressed while speaker gate is active on KWS SSH channel
      const routerCountBeforeLog = routerEvents.length;
      simulateUnverifiedLogLine = true;
      await delay(180);
      assert.equal(routerEvents.length, routerCountBeforeLog, 'instruction.log polling must be suppressed when speaker verification is active');
    } finally {
      uninstallTvPlugin();
      await coordinator.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Daemon IPC voice-status, voice-config, voice-remove, and voice-clear commands work end-to-end', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-spk-ipc-'));
  try {
    const seededManager = new XiaoaiSpeakerManager({ homeDir: home });
    seededManager.enrollEmbeddings({ name: '主人', role: 'owner', embeddings: [new Float32Array([1, 0, 0, 0])] });
    seededManager.enrollEmbeddings({ name: '爸爸', role: 'member', embeddings: [new Float32Array([0, 1, 0, 0])] });
    seededManager.close();

    const daemon = await serve({ home, mode: 'offline' });
    try {
      const initial = await request(home, { command: 'voice-status' }) as {
        enabled: boolean;
        threshold: number;
        profiles: Array<{ name: string; role: string }>;
      };
      assert.equal(initial.enabled, true);
      assert.equal(initial.profiles.length, 2);

      const configured = await request(home, {
        command: 'voice-config',
        threshold: 0.52,
        wakePrecheck: false,
        renameTarget: '爸爸',
        renameName: '爷爷',
      }) as {
        threshold: number;
        wakePrecheck: boolean;
        profiles: Array<{ name: string; role: string }>;
      };
      assert.equal(configured.threshold, 0.52);
      assert.equal(configured.wakePrecheck, false);
      assert.ok(configured.profiles.some(p => p.name === '爷爷'));

      const removed = await request(home, { command: 'voice-remove', target: '爷爷' }) as {
        removed: boolean;
        id?: string;
        name?: string;
        remaining: number;
      };
      assert.equal(removed.removed, true);
      assert.equal(removed.name, '爷爷');
      assert.equal(removed.remaining, 1);
      assert.ok(typeof removed.id === 'string' && removed.id.startsWith('spk-'));

      const cleared = await request(home, { command: 'voice-clear' }) as { cleared: number };
      assert.equal(cleared.cleared, 1);
    } finally {
      await daemon.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoaiKwsMonitor adaptive endpointing tolerates 1050ms mid-sentence pause in slow speech before closing cleanly', async () => {
  assert.equal(DEFAULT_END_SILENCE_MS, 900);
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-slow-vad-'));
  try {
    let audioStream: PassThrough | undefined;
    let wakeCount = 0;
    const utterances: Array<{ text: string; durSec: number }> = [];
    const monitor = new XiaoaiKwsMonitor({
      homeDir: home,
      cooldownMs: 20,
      probeDurationMs: 25,
      chimeDiscardMs: 10,
      maxWaitSpeechMs: 2_000,
      speechRmsThreshold: 0.01,
      sshRunner: async () => ({ stdout: '', stderr: '', code: 0 }),
      streamFactory: () => {
        audioStream = new PassThrough();
        return {
          stdout: audioStream,
          sampleFormat: 's16le',
          kill: () => audioStream?.end(),
          onClose: () => {},
        };
      },
      spotterFactory: () => {
        const state = { peak: 0 };
        return {
          createStream: () => ({ state }),
          acceptWaveform: (_s, samples) => {
            for (const v of samples) {
              const abs = Math.abs(v);
              if (abs > state.peak) state.peak = abs;
            }
          },
          isReady: () => state.peak >= 0.4,
          decode: () => {},
          getResult: () => (state.peak >= 0.4 ? '星期五' : ''),
          reset: () => { state.peak = 0; },
        };
      },
      vadFactory: ({ speechRmsThreshold }) => ({
        isSpeech: (samples) => computeRms(samples) >= speechRmsThreshold,
        reset: () => {},
      }),
      recognizerFactory: () => ({
        transcribe: async (samples, sampleRate) => {
          const durSec = samples.length / sampleRate;
          const text = durSec >= 1.8 ? '空气炸锅200度5分钟。' : '空气炸锅。';
          utterances.push({ text, durSec });
          return text;
        },
      }),
      onWake: async () => {
        wakeCount++;
        return { woken: true, suppressed: false };
      },
    });
    monitor.sync([{
      id: 'xiaoai-slow',
      platform: 'xiaoai',
      name: '慢语速断句测试',
      enabled: true,
      notifyAll: false,
      allowedSenders: [],
      apiBase: 'ssh://lx06=root@192.0.2.104',
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }]);
    await until(() => Boolean(audioStream));

    const writeS16 = (amp: number, samplesCount: number) => {
      const buf = Buffer.alloc(samplesCount * 2);
      for (let i = 0; i < samplesCount; i++) {
        const val = amp === 0 ? 0 : amp * Math.sin((2 * Math.PI * 500 * i) / 16000);
        buf.writeInt16LE(Math.round(val * 32767), i * 2);
      }
      audioStream!.write(buf);
    };
    const writeChunks = (amp: number, count: number, chunkSamples = 1600) => {
      for (let i = 0; i < count; i++) writeS16(amp, chunkSamples);
    };

    // Trigger wake -> probe silence -> transition to capturing -> discard 10ms chime
    writeS16(0.5, 400);
    writeS16(0, 480);
    await until(() => wakeCount === 1);
    await delay(20);
    writeS16(0, 160);

    // Part 1: 600ms speech ("空气炸锅") followed by 1050ms mid-sentence pause while thinking of parameters
    writeChunks(0.3, 6, 1600);
    writeChunks(0, 10, 1600);
    writeS16(0, 800);
    await delay(30);
    assert.equal(utterances.length, 0, 'short utterance (<1.8s) must NOT cut off during 1050ms mid-sentence pause');
    assert.equal(monitor.isCapturing('xiaoai-slow', 'lx06'), true);

    // Part 2: 700ms continuation ("200度5分钟"), then 950ms trailing silence closes the full utterance once
    writeChunks(0.3, 7, 1600);
    writeChunks(0, 9, 1600);
    writeS16(0, 800);
    await until(() => utterances.length === 1);
    await delay(30);
    assert.equal(utterances.length, 1);
    assert.equal(utterances[0]!.text, '空气炸锅200度5分钟。');
    assert.ok(utterances[0]!.durSec >= 2.0, `expected combined slow utterance >= 2.0s, got ${utterances[0]!.durSec.toFixed(2)}s`);
    monitor.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoAI KWS ASR wake rescue catches missed bare "星期五" and one-breath commands while blocking TV via speaker gate', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-rescue-'));
  try {
    const extractorFactory = createBandSpeakerExtractorFactory();
    const manager = new XiaoaiSpeakerManager({ homeDir: home, extractorFactory });
    const ownerEmb = manager.extractEmbedding(synthToneSamples(200, 1200))!;
    manager.enrollEmbeddings({ name: '主人', role: 'owner', embeddings: [ownerEmb] });

    let audioStream: PassThrough | undefined;
    let asrCalls = 0;
    const asrQueue = ['星期五。', '退下呗。', '星期五，打开客厅灯'];
    const wakeEvents: Array<{ keyword: string; chime?: boolean }> = [];
    const cancelEvents: Array<{ keyword: string; reason: string; text?: string }> = [];
    const utteranceEvents: Array<{ keyword: string; text: string; explicitWake?: boolean }> = [];

    const channel: ImChannelConfig = {
      id: 'xiaoai-rescue',
      platform: 'xiaoai',
      name: '小爱唤醒兜底测试',
      enabled: true,
      notifyAll: false,
      allowedSenders: [],
      apiBase: 'ssh://lx06=root@192.0.2.104',
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const monitor = new XiaoaiKwsMonitor({
      homeDir: home,
      cooldownMs: 40,
      probeDurationMs: 25,
      chimeDiscardMs: 20,
      maxWaitSpeechMs: 1_500,
      endSilenceMs: 60,
      asrWakeRescue: true,
      sshRunner: async () => ({ stdout: '', stderr: '', code: 0 }),
      streamFactory: () => {
        audioStream = new PassThrough();
        return { stdout: audioStream, sampleFormat: 's16le', kill: () => audioStream?.end(), onClose: () => {} };
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
          asrCalls++;
          return asrQueue.shift() ?? '';
        },
      }),
      vadFactory: () => ({
        isSpeech: (samples) => computeRms(samples) >= 0.02,
        reset: () => {},
      }),
      speakerGate: {
        isActive: () => manager.isVerificationActive(),
        verifyWake: ({ keyword, samples, sampleRate }) => manager.verifyWakeSlice(samples, sampleRate, keyword),
        verifyUtterance: ({ samples, sampleRate }) => manager.verifyAndTrimUtterance(samples, sampleRate),
      },
      onWake: async (ev) => {
        wakeEvents.push({ keyword: ev.keyword, chime: ev.chime });
        return { woken: true, suppressed: false };
      },
      onCaptureCancel: (ev) => {
        cancelEvents.push({ keyword: ev.keyword, reason: ev.reason, ...(ev.text ? { text: ev.text } : {}) });
      },
      onUtterance: (ev) => {
        utteranceEvents.push({ keyword: ev.keyword, text: ev.text, explicitWake: ev.explicitWake });
      },
    });

    monitor.sync([channel]);
    await until(() => Boolean(audioStream));

    const writeChunkedTone = (freqHz: number, totalMs: number, amp: number, chunkMs = 50) => {
      for (let off = 0; off < totalMs; off += chunkMs) {
        const dur = Math.min(chunkMs, totalMs - off);
        audioStream!.write(encodeFloat32ToS16Le(synthToneSamples(freqHz, dur, amp)));
      }
    };

    // 1. 700ms TV dialogue (3200Hz) + 350ms silence -> blocked at speaker gate BEFORE ASR (asrCalls stays 0)
    writeChunkedTone(3200, 700, 0.2);
    writeChunkedTone(0, 350, 0);
    await delay(40);
    assert.equal(asrCalls, 0, 'TV audio must be rejected by speaker gate before invoking ASR wake rescue');
    assert.equal(wakeEvents.length, 0);

    // 2. 650ms owner bare "星期五" + 350ms silence (Zipformer missed) -> SenseVoice rescues bare wake
    writeChunkedTone(200, 650, 0.2);
    writeChunkedTone(0, 350, 0);
    await until(() => wakeEvents.length === 1 && monitor.isCapturing('xiaoai-rescue', 'lx06'));
    assert.equal(asrCalls, 1);
    assert.deepEqual(wakeEvents[0], { keyword: '星期五', chime: true });

    // 3. Flush chime discard then say "退下呗。" -> dismisses cleanly without invoking Router
    await delay(25);
    writeChunkedTone(0, 40, 0);
    writeChunkedTone(200, 500, 0.2);
    writeChunkedTone(0, 200, 0);
    await until(() => cancelEvents.length === 1);
    assert.equal(cancelEvents[0]!.reason, 'cancel');
    assert.equal(cancelEvents[0]!.text, '退下呗。');
    assert.equal(utteranceEvents.length, 0);

    // 4. Past cooldown: 1200ms owner one-breath "星期五，打开客厅灯" -> direct command emission
    await delay(60);
    writeChunkedTone(200, 1200, 0.2);
    writeChunkedTone(0, 350, 0);
    await until(() => utteranceEvents.length === 1);
    assert.equal(wakeEvents.length, 2);
    assert.deepEqual(wakeEvents[1], { keyword: '星期五', chime: false });
    assert.deepEqual(utteranceEvents[0], {
      keyword: '星期五',
      text: '打开客厅灯',
      explicitWake: true,
    });
    monitor.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoaiKwsMonitor remote SSH and ash commands pass sh -n with valid PIDFILE separators and session tag matching', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-ash-'));
  try {
    const spawnedSshCalls: Array<{ cmd: string; args: string[]; remoteCmd: string }> = [];
    const sshRunnerCalls: Array<{ targetId: string; remoteCmd: string }> = [];

    const streamSpawn = ((cmd: string, args: readonly string[]) => {
      const remoteCmd = args[args.length - 1] ?? '';
      spawnedSshCalls.push({ cmd, args: [...args], remoteCmd });
      const proc = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => boolean;
        unref: () => void;
      };
      proc.pid = 42424 + spawnedSshCalls.length;
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => {
        proc.stdout.end();
        proc.emit('exit', 0);
        proc.emit('close', 0);
        return true;
      };
      proc.unref = () => {};
      return proc;
    }) as unknown as typeof spawn;

    const sshRunner: XiaoaiSshRunner = async (target, remoteCommand) => {
      sshRunnerCalls.push({ targetId: target.id, remoteCmd: remoteCommand });
      if (remoteCommand.includes('instruction.log')) {
        return { stdout: '星期五，现在几点\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const channel = makeChannel({
      id: 'xiaoai-ash-check',
      apiBase: 'ssh://lx06=root@192.0.2.104?prefix=星期五',
      defaultTarget: 'lx06',
      syncBuf: JSON.stringify({ mode: 'ssh', cursors: { lx06: '' } }),
    });

    const monitor = new XiaoaiKwsMonitor({
      homeDir: home,
      sshRunner,
      streamSpawn,
      spotterFactory: () => ({
        createStream: () => ({}),
        acceptWaveform: () => {},
        isReady: () => false,
        decode: () => {},
        getResult: () => '',
        reset: () => {},
      }),
    });

    monitor.sync([channel]);
    await until(() => spawnedSshCalls.length >= 1);
    monitor.close();
    await until(() => spawnedSshCalls.length >= 2);

    const streamStart = spawnedSshCalls[0]!;
    const streamCleanup = spawnedSshCalls[1]!;
    assert.equal(streamStart.cmd, 'ssh');
    assert.equal(streamCleanup.cmd, 'ssh');

    // Exercise sshRunner commands (poll, pause, wake, LED, TTS) and verify POSIX sh -n syntax across src/xiaoai/*.ts
    const target = parseXiaoaiSshTargets(channel.apiBase)[0]!;
    await pollXiaoaiChannel(channel, { sshRunner });
    await handleXiaoaiKeywordWake({ channel, target, keyword: '你好星期五', chime: true, sshRunner });
    await handleXiaoaiKeywordWake({ channel, target, keyword: '你好星期五', chime: false, sshRunner });
    await setXiaoaiSpeakerLed(target, 'listen', sshRunner);
    await setXiaoaiSpeakerLed(target, 'think', sshRunner);
    await setXiaoaiSpeakerLed(target, 'off', sshRunner);
    await sendXiaoaiSpeech(channel, "测试'单引号'播报", { target: 'lx06', sshRunner });

    const allRemoteCmds = [
      streamStart.remoteCmd,
      streamCleanup.remoteCmd,
      SSH_PAUSE_COMMAND,
      ...sshRunnerCalls.map(c => c.remoteCmd),
    ];
    for (const remoteCmd of allRemoteCmds) {
      execFileSync('sh', ['-n', '-c', remoteCmd], { stdio: 'pipe' });
    }

    // Verify statement separator (`;` or `\n`) between PIDFILE assignment and `if`
    const pidfileIfRegex = /PIDFILE='\/tmp\/friday_arecord_lx06_noop\.pid'(?:;|\n)\s*if \[ -f "\$PIDFILE" \]/;
    assert.match(streamStart.remoteCmd, pidfileIfRegex);
    assert.match(streamCleanup.remoteCmd, pidfileIfRegex);

    // Verify recordPid and cleanupCmd use the exact same session tag (no truncated .slice(1, -1))
    const recordMatch = /printf '%s %s\\n' "\$\$" '([^']+)' > "\$PIDFILE"/.exec(streamStart.remoteCmd);
    assert.ok(recordMatch?.[1], `Expected printf session tag in start command: ${streamStart.remoteCmd}`);
    const recordedTag = recordMatch[1];
    assert.ok(
      streamCleanup.remoteCmd.includes(`if [ "$2" = '${recordedTag}' ];`),
      `Expected cleanup command to match recorded tag "${recordedTag}": ${streamCleanup.remoteCmd}`,
    );

    // Execute PIDFILE setup + cleanup snippets against a real temp PIDFILE in POSIX sh
    const pidFile = join(home, 'test_arecord.pid');
    const setupSnippet = streamStart.remoteCmd
      .split('; if [ "noop"')[0]!
      .replace('/tmp/friday_arecord_lx06_noop.pid', pidFile);
    const cleanupSnippet = streamCleanup.remoteCmd
      .replace('/tmp/friday_arecord_lx06_noop.pid', pidFile);
    const mismatchedCleanup = cleanupSnippet.replace(recordedTag, `${recordedTag}_mismatch`);

    execFileSync('sh', ['-c', setupSnippet], { stdio: 'pipe' });
    const written = (await readFile(pidFile, 'utf8')).trim();
    const parts = written.split(/\s+/);
    assert.match(parts[0] ?? '', /^\d+$/);
    assert.equal(parts[1], recordedTag);

    // Mismatched tag must not delete the active session's PIDFILE
    execFileSync('sh', ['-c', mismatchedCleanup], { stdio: 'pipe' });
    assert.equal((await readFile(pidFile, 'utf8')).trim(), written);

    // Matching tag deletes PIDFILE cleanly
    execFileSync('sh', ['-c', cleanupSnippet], { stdio: 'pipe' });
    await assert.rejects(() => readFile(pidFile, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Xiaoai inbound fastpath yields on explicitWake=false follow-up unless continuous fastpath session is active', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-fp-wake-'));
  const pluginDir = join(home, 'plugins', 'test-fp-wake');
  const callsKey = '__fridayTestFpWakeCalls';
  const routerPrompts: string[] = [];
  const g = globalThis as Record<string, unknown>;
  g[callsKey] = [] as string[];
  try {
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'test-fp-wake',
      version: '1.0.0',
      description: 'Test wake-gating for voice fastpath',
      enabled: true,
      runtime: 'in-process',
      voiceFastpath: true,
      entry: 'index.mjs',
      actions: [],
    }));
    await writeFile(join(pluginDir, 'index.mjs'), `
export async function handleVoiceFastpath(req) {
  if (req.sessionState?.event === 'assistant_reply') return { handled: false };
  const calls = globalThis[${JSON.stringify(callsKey)}];
  calls.push(req.text);
  if (req.text.includes('进入连续')) {
    return {
      handled: true,
      ok: true,
      speech: '已进入连续模式',
      followUp: true,
      sessionState: { continuous: true, idleTtlMs: 5000 },
      action: 'enter',
    };
  }
  if (req.sessionState?.continuous && req.text.includes('继续')) {
    return {
      handled: true,
      ok: true,
      speech: '连续动作完成',
      followUp: true,
      sessionState: { continuous: true, idleTtlMs: 5000 },
      action: 'step',
    };
  }
  return { handled: true, ok: true, speech: '快速处理完成' };
}
`);
    const factory: AgentFactory = {
      mode: 'real',
      nativeTools: true,
      async create(role) {
        if (role !== 'router') return offlineFactory().create(role, role, []);
        return {
          close() {},
          async prompt(text) {
            const parsed = JSON.parse(text) as { kind?: string; message?: { text?: string } };
            if (parsed.kind === 'CHAT' && parsed.message?.text) {
              routerPrompts.push(parsed.message.text);
            }
            return '好的，这是路由器回复。';
          },
        };
      },
    };

    const coordinator = new Coordinator(home, factory, { skipExecutor: true });
    await coordinator.ready();
    try {
      coordinator.im.xiaoaiDeps = {
        sshRunner: async () => ({ code: 0, stdout: '', stderr: '' }),
      };
      coordinator.im.saveChannel({
        id: 'xa-wake-test',
        platform: 'xiaoai',
        name: '小爱测试',
        enabled: true,
        notifyAll: false,
        allowedSenders: [],
        defaultTarget: 'lx06',
        pollIntervalMs: 50,
      });

      // 1. Follow-up capture without explicit wake word and no active fastpath session -> bypasses fastpath, goes to Router
      const followUpRes = await coordinator.im.ingestMessage({
        channelId: 'xa-wake-test',
        externalId: 'ext-1',
        senderId: 'lx06',
        target: 'lx06',
        text: '打开历史记录',
        explicitWake: false,
      });
      assert.equal(followUpRes.action, 'routed_to_chat');
      await until(() =>
        routerPrompts.includes('打开历史记录')
        && coordinator.store.conversation.get(followUpRes.messageId!).status === 'completed',
      );
      assert.deepEqual(g[callsKey], []);

      // 2. Explicit wake -> reaches fastpath plugin without hitting Router
      const wakeRes = await coordinator.im.ingestMessage({
        channelId: 'xa-wake-test',
        externalId: 'ext-2',
        senderId: 'lx06',
        target: 'lx06',
        text: '打开卧室灯',
        explicitWake: true,
      });
      assert.equal(wakeRes.action, 'voice_fastpath');
      assert.deepEqual(g[callsKey], ['打开卧室灯']);
      assert.equal(routerPrompts.length, 1);

      // 3. Active continuous session -> explicitWake=false still continues fastpath
      const enterRes = await coordinator.im.ingestMessage({
        channelId: 'xa-wake-test',
        externalId: 'ext-3',
        senderId: 'lx06',
        target: 'lx06',
        text: '进入连续',
        explicitWake: true,
      });
      assert.equal(enterRes.action, 'enter');

      const stepRes = await coordinator.im.ingestMessage({
        channelId: 'xa-wake-test',
        externalId: 'ext-4',
        senderId: 'lx06',
        target: 'lx06',
        text: '继续',
        explicitWake: false,
      });
      assert.equal(stepRes.action, 'step');
      assert.deepEqual(g[callsKey], ['打开卧室灯', '进入连续', '继续']);
    } finally {
      await coordinator.close();
    }
  } finally {
    delete g[callsKey];
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoaiKwsMonitor idleEnergyGate skips ONNX inference on silence, replays 400ms pre-roll on onset, and hibernates with 160ms flush', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-idle-gate-'));
  try {
    let audioStream: PassThrough | undefined;
    let vadCalls = 0;
    let vadResets = 0;
    let spotterResets = 0;
    let allowWake = true;
    let sawWake = false;
    const spotterChunks: Array<{ len: number; peak: number; allZero: boolean }> = [];
    const state = { sawQuietOnset: false, ready: false };

    const monitor = new XiaoaiKwsMonitor({
      homeDir: home,
      cooldownMs: 20,
      probeDurationMs: 25,
      chimeDiscardMs: 10,
      idleEnergyGate: true,
      asrWakeRescue: true,
      streamFactory: () => {
        audioStream = new PassThrough();
        return {
          stdout: audioStream,
          sampleFormat: 's32le',
          kill: () => audioStream?.end(),
          onClose: () => {},
        };
      },
      spotterFactory: () => ({
        createStream: () => state,
        acceptWaveform: (_s, samples) => {
          let peak = 0;
          let allZero = samples.length > 0;
          for (let i = 0; i < samples.length; i++) {
            const abs = Math.abs(samples[i] ?? 0);
            if (abs > peak) peak = abs;
            if (abs !== 0) allZero = false;
          }
          spotterChunks.push({ len: samples.length, peak, allZero });
          // Soft consonant onset precedes loud vowel wake phrase
          if (peak >= 0.015 && peak < 0.12) {
            state.sawQuietOnset = true;
          }
          if (allowWake && state.sawQuietOnset && peak >= 0.20) {
            state.ready = true;
          }
        },
        isReady: () => state.ready,
        decode: () => {},
        getResult: () => (state.ready ? '你好星期五' : ''),
        reset: () => {
          spotterResets++;
          state.sawQuietOnset = false;
          state.ready = false;
        },
      }),
      vadFactory: () => ({
        isSpeech: () => {
          vadCalls++;
          return false;
        },
        reset: () => {
          vadResets++;
        },
      }),
      recognizerFactory: () => ({ transcribe: async () => '' }),
      onWake: async () => {
        sawWake = true;
        return { woken: false, suppressed: false };
      },
    });

    monitor.sync([makeChannel({
      id: 'xiaoai-idle-gate',
      apiBase: 'ssh://lx06=root@192.0.2.104',
    })]);
    await until(() => Boolean(audioStream));

    const pushS32Chunk = (amp: number, sampleCount: number, freq = 1000) => {
      const buf = Buffer.alloc(sampleCount * 4);
      for (let i = 0; i < sampleCount; i++) {
        const val = amp === 0 ? 0 : amp * Math.sin((2 * Math.PI * freq * i) / 16000);
        buf.writeInt32LE(Math.round(val * 2147483647), i * 4);
      }
      audioStream!.write(buf);
    };

    // 1. Continuous 3s thermal hiss (< 0.00075 gate RMS) => 0 spotter calls & 0 VAD calls
    assert.ok(computeKwsIdleGateRms(0.00035, 's32le') >= 0.00075);
    for (let i = 0; i < 30; i++) {
      pushS32Chunk(0.00035, 1600);
    }
    await delay(30);
    assert.equal(spotterChunks.length, 0, 'spotter must stay hibernated on quiet thermal hiss');
    assert.equal(vadCalls, 0, 'VAD must stay skipped while KWS is hibernated');

    // 2. Soft onset pre-roll (0.00045 sine, still below gate) followed by loud wake syllable (0.0045)
    for (let i = 0; i < 3; i++) {
      pushS32Chunk(0.00045, 1600);
    }
    await delay(10);
    assert.equal(spotterChunks.length, 0, 'sub-gate onset stays buffered in pre-roll until speech crosses gate');

    pushS32Chunk(0.0045, 1600);
    pushS32Chunk(0.00035, 1600); // Finish probe window (probeDurationMs=25) -> onWake(woken=false) -> resets to kws
    await until(() => sawWake && monitor.getStatus('xiaoai-idle-gate', 'lx06').workers[0]?.mode === 'kws');
    assert.ok(
      spotterChunks.some((c) => c.peak >= 0.015 && c.peak < 0.12),
      '400ms pre-roll onset chunk must be replayed into spotter upon waking from hibernation',
    );

    // 3. After returning to kws mode, hiss again produces 0 calls
    const countAfterWake = spotterChunks.length;
    const vadAfterWake = vadCalls;
    for (let i = 0; i < 6; i++) {
      pushS32Chunk(0.00035, 1600);
    }
    await delay(25);
    assert.equal(spotterChunks.length, countAfterWake);
    assert.equal(vadCalls, vadAfterWake);

    // 4. Brief non-wake blip wakes KWS, then >900ms hiss triggers 160ms zero flush and re-hibernates
    allowWake = false;
    const resetsBeforeBlip = spotterResets;
    const vadResetsBeforeBlip = vadResets;
    pushS32Chunk(0.0045, 1600); // 100ms blip opens 900ms hold window
    for (let i = 0; i < 10; i++) {
      pushS32Chunk(0.00035, 1600); // First 900ms decays hold window -> flushes 160ms zeros -> hibernates
    }
    await until(() => spotterChunks.some((c) => c.len === 2560 && c.allZero));
    assert.ok(spotterResets > resetsBeforeBlip, 'spotter resets upon entering hibernation');
    assert.ok(vadResets > vadResetsBeforeBlip, 'VAD resets upon entering hibernation');

    const countAfterHibernate = spotterChunks.length;
    const vadAfterHibernate = vadCalls;
    for (let i = 0; i < 10; i++) {
      pushS32Chunk(0.00035, 1600);
    }
    await delay(25);
    assert.equal(spotterChunks.length, countAfterHibernate, 'spotter stays silent after hibernation');
    assert.equal(vadCalls, vadAfterHibernate, 'VAD stays silent after hibernation');

    monitor.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoAI wake greeting selection, duration measurement, short-clip silence trimming, prosody smoothing, and POSIX cache scripts', async () => {
  // 1. Urgency (<900ms vs >=900ms) and 4 time-of-day greeting windows + member address (no comma pauses)
  const atHour = (hour: number, minute = 0) => new Date(2026, 10, 17, hour, minute, 0, 0);
  assert.equal(resolveXiaoaiWakeGreeting({ keyword: '星期五', wakeDurationMs: 620, now: atHour(8, 30) }), '在的老板');
  assert.equal(resolveXiaoaiWakeGreeting({ keyword: '你好星期五', wakeDurationMs: 780, now: atHour(23, 15) }), '在的老板');
  assert.equal(resolveXiaoaiWakeGreeting({ keyword: '你好星期五', urgent: true, now: atHour(15, 0) }), '在的老板');

  assert.equal(resolveXiaoaiWakeGreeting({ keyword: '星期五', wakeDurationMs: 1_150, now: atHour(8, 30) }), '早上好老板');
  assert.equal(resolveXiaoaiWakeGreeting({ keyword: '你好星期五', wakeDurationMs: 1_150, now: atHour(12, 15) }), '中午好老板');
  assert.equal(resolveXiaoaiWakeGreeting({ keyword: '你好星期五', wakeDurationMs: 1_150, now: atHour(15, 40) }), '下午好老板');
  assert.equal(resolveXiaoaiWakeGreeting({ keyword: '你好星期五', wakeDurationMs: 1_150, now: atHour(23, 10) }), '晚上好老板');
  assert.equal(resolveXiaoaiWakeGreeting({ keyword: '你好星期五', wakeDurationMs: 1_150, now: atHour(2, 0) }), '晚上好老板');

  const wife = { name: '太太', role: 'member' as const };
  assert.equal(resolveXiaoaiWakeGreeting({ keyword: '星期五', wakeDurationMs: 650, speaker: wife, now: atHour(15, 0) }), '在的太太');
  assert.equal(resolveXiaoaiWakeGreeting({ keyword: '你好星期五', wakeDurationMs: 1_150, speaker: wife, now: atHour(15, 40) }), '下午好太太');

  // 2. Active speech duration measurement inside 1.8s KWS ring buffer (leading noise stripped)
  const ringShort = concatAudio(synthToneSamples(200, 1_100, 0.002), synthToneSamples(200, 620, 0.25));
  const durShort = measureWakeSpeechDurationMs(ringShort, SPEAKER_SAMPLE_RATE);
  assert.ok(durShort >= 500 && durShort < 850, `Expected urgent short wake ~620ms, got ${durShort}ms`);

  const ringRelaxed = concatAudio(synthToneSamples(200, 600, 0.002), synthToneSamples(200, 1_180, 0.25));
  const durRelaxed = measureWakeSpeechDurationMs(ringRelaxed, SPEAKER_SAMPLE_RATE);
  assert.ok(durRelaxed >= 950 && durRelaxed <= 1_400, `Expected relaxed wake ~1180ms, got ${durRelaxed}ms`);

  // 3. trimShortUtteranceSilence removes leading pre-roll and trailing endpointing silence
  const paddedShort = concatAudio(
    synthToneSamples(200, 350, 0.001),
    synthToneSamples(200, 650, 0.22),
    synthToneSamples(200, 350, 0.001),
  );
  const trimmedShort = trimShortUtteranceSilence(paddedShort, SPEAKER_SAMPLE_RATE);
  assert.ok(trimmedShort.length < Math.round(SPEAKER_SAMPLE_RATE * 0.9), `Expected trimmed short speech <0.9s, got ${trimmedShort.length}`);
  assert.ok(trimmedShort.length >= Math.round(SPEAKER_SAMPLE_RATE * 0.55));

  // 4. POSIX sh -n validation & invariant guards for wake / prewarm commands
  const wakeCmd = buildXiaoaiWakeCommand({ chime: true, greetingText: '晚上好老板' });
  const prewarmCmd = buildXiaoaiWakePrewarmCommand(['在的老板', '下午好老板']);
  execFileSync('sh', ['-n', '-c', wakeCmd], { stdio: 'pipe' });
  execFileSync('sh', ['-n', '-c', prewarmCmd], { stdio: 'pipe' });
  assert.equal(wakeCmd.includes('text_to_speech'), false, 'Wake command must use gen-tts wrapper to preserve TTS counters');
  assert.equal(prewarmCmd.includes('text_to_speech'), false);
  assert.ok(wakeCmd.includes('/usr/bin/gen-tts'));
  assert.ok(wakeCmd.includes(getXiaoaiWakeCacheFileName('晚上好老板')));
  assert.ok(wakeCmd.includes('wakeup_zai_01.wav'), 'Wake command must retain native wav fallback');
  assert.ok(wakeCmd.includes('$WAVF') && wakeCmd.includes('/usr/bin/aplay -D notify -q'), 'Wake command should prefer trimmed WAV over aplay');

  const sampleMp3 = execFileSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', 'aevalsrc=0:d=0.15[sil];aevalsrc=0.3*sin(2*PI*500*t):d=0.45[tone];[sil][tone]concat=n=2:v=0:a=1',
      '-ar', '16000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k', '-f', 'mp3', 'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const wavBuf = await tightenWakeAudioToWavBufferWithFfmpeg(sampleMp3);
  assert.ok(wavBuf, 'tightenWakeAudioToWavBufferWithFfmpeg should produce a WAV buffer');
  assert.equal(wavBuf.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wavBuf.subarray(8, 12).toString('ascii'), 'WAVE');
  const wavPcmDurationSec = (wavBuf.length - 44) / (16_000 * 2);
  assert.ok(wavPcmDurationSec >= 0.35 && wavPcmDurationSec <= 0.52, `Expected 150ms leading silence trimmed (<0.52s), got ${wavPcmDurationSec.toFixed(3)}s`);

  // 5. Expanded homophones for bare "星期五" and prefixed homophone commands
  assert.deepEqual(extractLeadingXiaoaiWakeKeyword('星期吾。'), { keyword: '星期五', remainder: '' });
  assert.deepEqual(extractLeadingXiaoaiWakeKeyword('星七五。'), { keyword: '星期五', remainder: '' });
  assert.deepEqual(extractLeadingXiaoaiWakeKeyword('你好星七五，现在几点了'), { keyword: '你好星期五', remainder: '现在几点了' });

  // 6. Everyday TTS prosody smoothing & enrollment exit phrases
  assert.equal(smoothXiaoaiTtsProsody('在的，老板。'), '在的老板。');
  assert.equal(smoothXiaoaiTtsProsody('没听清，老板再说一遍？'), '没听清老板再说一遍？');
  assert.equal(smoothXiaoaiTtsProsody('好的，老板，客厅灯已关。'), '好的老板客厅灯已关。');
  assert.equal(smoothXiaoaiTtsProsody('老板，现在十一点。'), '老板现在十一点。');
  assert.equal(
    smoothXiaoaiTtsProsody('好的，老板，我已经帮你把客厅和卧室的空调全部调到二十六度了。'),
    '好的老板，我已经帮你把客厅和卧室的空调全部调到二十六度了。',
  );
  const ttsSentCmds: string[] = [];
  await sendXiaoaiSpeech(
    makeChannel({ apiBase: 'ssh://lx06=root@192.0.2.104', defaultTarget: 'lx06' }),
    '没听清，老板再说一遍？',
    { sshRunner: async (_t, remoteCmd) => { ttsSentCmds.push(remoteCmd); return { stdout: '', stderr: '', code: 0 }; } },
  );
  assert.ok(ttsSentCmds.some(c => c.includes('没听清老板再说一遍？')));
  assert.equal(isEnrollCancelPhrase('退一下吧。'), true);
  assert.equal(isEnrollCancelPhrase('没事了'), true);
});

test('XiaoaiKwsMonitor re-triggers urgent wake greeting instead of cancelling when "星期五" is repeated inside capturing window', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-rewake-'));
  try {
    let audioStream: PassThrough | undefined;
    const wakeScoreNext = 0.335;
    let utteranceScoreNext = 0.335;
    const asrQueue = ['星期五。', '星期五。', '现在几点了'];
    const wakeEvents: Array<{ keyword: string; chime?: boolean; urgent?: boolean; reWake?: boolean }> = [];
    const cancelEvents: Array<{ keyword: string; reason: string }> = [];
    const utteranceEvents: Array<{ keyword: string; text: string }> = [];

    const channel: ImChannelConfig = {
      id: 'xiaoai-rewake',
      platform: 'xiaoai',
      name: '小爱重唤醒测试',
      enabled: true,
      notifyAll: false,
      allowedSenders: [],
      apiBase: 'ssh://lx06=root@192.0.2.104',
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const monitor = new XiaoaiKwsMonitor({
      homeDir: home,
      cooldownMs: 30,
      probeDurationMs: 25,
      chimeDiscardMs: 20,
      maxWaitSpeechMs: 1_500,
      endSilenceMs: 60,
      asrWakeRescue: false,
      idleEnergyGate: false,
      sshRunner: async () => ({ stdout: '', stderr: '', code: 0 }),
      streamFactory: () => {
        audioStream = new PassThrough();
        return { stdout: audioStream, sampleFormat: 's16le', kill: () => audioStream?.end(), onClose: () => {} };
      },
      spotterFactory: () => {
        let peak = 0;
        return {
          createStream: () => ({}),
          acceptWaveform: (_s, samples) => {
            for (const v of samples) {
              const abs = Math.abs(v);
              if (abs > peak) peak = abs;
            }
          },
          isReady: () => peak >= 0.7,
          decode: () => {},
          getResult: () => (peak >= 0.7 ? '星期五' : ''),
          reset: () => { peak = 0; },
        };
      },
      recognizerFactory: () => ({
        transcribe: async () => asrQueue.shift() ?? '',
      }),
      vadFactory: () => ({
        isSpeech: (samples) => computeRms(samples) >= 0.02,
        reset: () => {},
      }),
      speakerGate: {
        isActive: () => true,
        verifyWake: () => ({ matched: true, score: wakeScoreNext, threshold: 0.32, speaker: { id: 'spk-1', name: '主人', role: 'owner', score: wakeScoreNext } }),
        verifyUtterance: ({ samples }) => ({
          matched: utteranceScoreNext >= 0.41,
          score: utteranceScoreNext,
          threshold: 0.41,
          ...(utteranceScoreNext >= 0.41 ? { speaker: { id: 'spk-1', name: '主人', role: 'owner' as const, score: utteranceScoreNext } } : {}),
          samples,
        }),
      },
      onWake: async (ev) => {
        wakeEvents.push({
          keyword: ev.keyword,
          chime: ev.chime,
          ...(ev.urgent !== undefined ? { urgent: ev.urgent } : {}),
          ...(ev.reWake !== undefined ? { reWake: ev.reWake } : {}),
        });
        return { woken: true, suppressed: false };
      },
      onCaptureCancel: (ev) => {
        cancelEvents.push({ keyword: ev.keyword, reason: ev.reason });
      },
      onUtterance: (ev) => {
        utteranceEvents.push({ keyword: ev.keyword, text: ev.text });
      },
    });

    monitor.sync([channel]);
    await until(() => Boolean(audioStream));

    const writeChunked = (amp: number, totalMs: number, chunkMs = 20) => {
      for (let off = 0; off < totalMs; off += chunkMs) {
        const dur = Math.min(chunkMs, totalMs - off);
        audioStream!.write(encodeFloat32ToS16Le(synthToneSamples(200, dur, amp)));
      }
    };

    // 1. Initial bare wake (20ms wake + 60ms silent probe) -> two-step capturing
    writeChunked(0.75, 20);
    writeChunked(0, 60);
    await until(() => wakeEvents.length === 1 && monitor.isCapturing('xiaoai-rewake', 'lx06'));

    // Flush chime discard, then repeat bare "星期五" with utterance score 0.335 (< 0.410, >= 0.320 wake gate)
    await delay(25);
    writeChunked(0, 40);
    utteranceScoreNext = 0.335;
    writeChunked(0.18, 600);
    writeChunked(0, 120);
    await until(() => wakeEvents.length === 2 && monitor.isCapturing('xiaoai-rewake', 'lx06'));
    assert.equal(cancelEvents.length, 0, 'Repeated bare wake must not cancel/turn off LED');
    assert.deepEqual(wakeEvents[1], { keyword: '星期五', chime: true, urgent: true, reWake: true });

    // 2. Repeat bare "星期五" again with high score (>= 0.410) -> still re-wakes instead of firing empty cancel
    await delay(25);
    writeChunked(0, 40);
    utteranceScoreNext = 0.82;
    writeChunked(0.18, 600);
    writeChunked(0, 120);
    await until(() => wakeEvents.length === 3 && monitor.isCapturing('xiaoai-rewake', 'lx06'));
    assert.equal(cancelEvents.length, 0);
    assert.deepEqual(wakeEvents[2], { keyword: '星期五', chime: true, urgent: true, reWake: true });

    // 3. Finally speak the real command inside the re-armed capturing window -> delivered to onUtterance
    await delay(25);
    writeChunked(0, 40);
    writeChunked(0.18, 600);
    writeChunked(0, 120);
    await until(() => utteranceEvents.length === 1);
    assert.deepEqual(utteranceEvents[0], { keyword: '星期五', text: '现在几点了' });

    monitor.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoaiKwsMonitor early 120ms right-context lookahead flush triggers streaming wake before 300ms asr-rescue', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-early-flush-'));
  try {
    let audioStream: PassThrough | undefined;
    let asrRescueCalls = 0;
    const wakeEvents: Array<{ keyword: string; chime?: boolean }> = [];

    const channel: ImChannelConfig = {
      id: 'xiaoai-early-flush',
      platform: 'xiaoai',
      name: '小爱早触发测试',
      enabled: true,
      notifyAll: false,
      allowedSenders: [],
      apiBase: 'ssh://lx06=root@192.0.2.104',
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const monitor = new XiaoaiKwsMonitor({
      homeDir: home,
      cooldownMs: 30,
      probeDurationMs: 25,
      chimeDiscardMs: 20,
      maxWaitSpeechMs: 1_500,
      endSilenceMs: 60,
      asrWakeRescue: true,
      idleEnergyGate: false,
      sshRunner: async () => ({ stdout: '', stderr: '', code: 0 }),
      streamFactory: () => {
        audioStream = new PassThrough();
        return { stdout: audioStream, sampleFormat: 's16le', kill: () => audioStream?.end(), onClose: () => {} };
      },
      spotterFactory: () => {
        let speechSamples = 0;
        let trailingSilenceSamples = 0;
        return {
          createStream: () => ({}),
          acceptWaveform: (_s, samples) => {
            if (computeRms(samples) >= 0.05) {
              speechSamples += samples.length;
              trailingSilenceSamples = 0;
            } else if (speechSamples >= 3_840) {
              trailingSilenceSamples += samples.length;
            }
          },
          isReady: () => speechSamples >= 3_840 && trailingSilenceSamples >= 2_240,
          decode: () => {},
          getResult: () => (speechSamples >= 3_840 && trailingSilenceSamples >= 2_240 ? '星期五' : ''),
          reset: () => {
            speechSamples = 0;
            trailingSilenceSamples = 0;
          },
        };
      },
      recognizerFactory: () => ({
        transcribe: async () => {
          asrRescueCalls++;
          return '星期五。';
        },
      }),
      vadFactory: () => ({
        isSpeech: (samples) => computeRms(samples) >= 0.02,
        reset: () => {},
      }),
      onWake: async (ev) => {
        wakeEvents.push({ keyword: ev.keyword, chime: ev.chime });
        return { woken: true, suppressed: false };
      },
    });

    monitor.sync([channel]);
    await until(() => Boolean(audioStream));

    const writeChunked = (amp: number, totalMs: number, chunkMs = 20) => {
      for (let off = 0; off < totalMs; off += chunkMs) {
        const dur = Math.min(chunkMs, totalMs - off);
        audioStream!.write(encodeFloat32ToS16Le(synthToneSamples(200, dur, amp)));
      }
    };

    // 280ms speech followed by 180ms silence: early 160ms zero flush at 120ms fires streaming KWS,
    // then the remaining 60ms completes the 25ms probe window well before the 300ms offline asr-rescue path.
    writeChunked(0.18, 280);
    writeChunked(0, 180);
    await until(() => wakeEvents.length === 1);
    assert.equal(wakeEvents[0]?.keyword, '星期五');
    assert.equal(asrRescueCalls, 0, 'Streaming KWS should wake on 120ms early flush without falling back to offline ASR rescue');

    monitor.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoaiKwsMonitor ASR rescue ignores faint non-member audio during recognition and recovers silent wakes', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-rescue-tv-'));
  try {
    const extractorFactory = createBandSpeakerExtractorFactory();
    const manager = new XiaoaiSpeakerManager({ homeDir: home, extractorFactory });
    const ownerEmb = manager.extractEmbedding(synthToneSamples(200, 1200))!;
    manager.enrollEmbeddings({ name: '主人', role: 'owner', embeddings: [ownerEmb] });

    let audioStream: PassThrough | undefined;
    const wakeEvents: Array<{ keyword: string; chime?: boolean }> = [];
    const cancelEvents: Array<{ keyword: string; reason: string }> = [];

    const channel = makeChannel({
      id: 'xiaoai-rescue-tv',
      apiBase: 'ssh://lx06=root@192.0.2.104',
    });

    const monitor = new XiaoaiKwsMonitor({
      homeDir: home,
      cooldownMs: 40,
      probeDurationMs: 25,
      chimeDiscardMs: 20,
      maxWaitSpeechMs: 1_200,
      endSilenceMs: 60,
      asrWakeRescue: true,
      idleEnergyGate: false,
      sshRunner: async () => ({ stdout: '', stderr: '', code: 0 }),
      streamFactory: () => {
        audioStream = new PassThrough();
        return { stdout: audioStream, sampleFormat: 's16le', kill: () => audioStream?.end(), onClose: () => {} };
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
          // Simulate ASR latency during which faint background / non-member TV audio arrives
          await delay(90);
          return '星期五。';
        },
      }),
      vadFactory: () => ({
        isSpeech: (samples) => computeRms(samples) >= 0.004,
        reset: () => {},
      }),
      speakerGate: {
        isActive: () => manager.isVerificationActive(),
        verifyWake: ({ keyword, samples, sampleRate }) => manager.verifyWakeSlice(samples, sampleRate, keyword),
        verifyUtterance: ({ samples, sampleRate }) => manager.verifyAndTrimUtterance(samples, sampleRate),
      },
      onWake: async (ev) => {
        wakeEvents.push({ keyword: ev.keyword, chime: ev.chime });
        return { woken: true, suppressed: false };
      },
      onCaptureCancel: (ev) => {
        cancelEvents.push({ keyword: ev.keyword, reason: ev.reason });
      },
    });

    monitor.sync([channel]);
    await until(() => Boolean(audioStream));

    const writeChunkedTone = (freqHz: number, totalMs: number, amp: number, chunkMs = 50) => {
      for (let off = 0; off < totalMs; off += chunkMs) {
        const dur = Math.min(chunkMs, totalMs - off);
        audioStream!.write(encodeFloat32ToS16Le(synthToneSamples(freqHz, dur, amp)));
      }
    };

    // Owner says "星期五" (600ms, amp=0.2) -> 350ms pause triggers ASR rescue -> faint/TV audio arrives during ASR
    writeChunkedTone(200, 600, 0.2);
    writeChunkedTone(0, 350, 0);
    await delay(15);
    // Faint background TV tone (3200Hz, amp=0.015 < minPostRms) during kwsRescueInFlight must NOT trigger silent live mode
    writeChunkedTone(3200, 300, 0.015);

    await until(() => wakeEvents.length === 1);
    assert.deepEqual(wakeEvents[0], { keyword: '星期五', chime: true });
    assert.equal(cancelEvents.length, 0);

    monitor.close();
    manager.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoaiSpeakerManager preserves fullRes match on >2.2s utterances when trailing noise fails tailCheck and 1.2s sub-windows are borderline', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-fullres-preserve-'));
  try {
    // Custom extractor: full 2.8s utterance passes (0.61), 1.2s tail fails (0.15),
    // and 1.2s sub-windows score 0.36 (< 0.39 anchorWindowThreshold when threshold=0.45 -> 0.45-0.06=0.39).
    const factory = (): XiaoaiSpeakerExtractor => ({
      dim: 2,
      extract: (samples) => {
        let s = 0.36;
        if (samples.length >= SPEAKER_SAMPLE_RATE * 2.5) {
          s = 0.61;
        } else if (samples.length <= SPEAKER_SAMPLE_RATE * 1.25 && (samples[0] ?? 0) < 0) {
          // Tail slice marker (negative samples)
          s = 0.15;
        }
        return new Float32Array([s, Math.sqrt(Math.max(0, 1 - s * s))]);
      },
      free() {},
    });

    const manager = new XiaoaiSpeakerManager({ homeDir: home, extractorFactory: factory });
    manager.enrollEmbeddings({ name: '主人', role: 'owner', embeddings: [new Float32Array([1, 0])] });
    manager.configure({ threshold: 0.45 });

    // 2.8s utterance: first 1.6s positive (owner), last 1.2s negative (TV tail)
    const clip = new Float32Array(Math.round(SPEAKER_SAMPLE_RATE * 2.8));
    clip.fill(0.2, 0, Math.round(SPEAKER_SAMPLE_RATE * 1.6));
    clip.fill(-0.2, Math.round(SPEAKER_SAMPLE_RATE * 1.6));

    const syncRes = manager.verifyAndTrimUtterance(clip, SPEAKER_SAMPLE_RATE);
    const asyncRes = await manager.verifyAndTrimUtteranceAsync(clip, SPEAKER_SAMPLE_RATE);
    for (const res of [syncRes, asyncRes]) {
      assert.equal(res.matched, true, 'Full-clip match (0.61 >= 0.45) must not be overturned when 1.2s sub-windows miss anchor');
      assert.equal(res.speaker?.name, '主人');
      assert.equal(res.trimmed, false);
    }
    manager.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoaiChannelAdapter auto-watches active health-scale session and announces completed measurement via TTS', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-measure-watch-'));
  try {
    const healthMeta = listPluginsSync(home).find(p => p.name === 'health-scale');
    if (!healthMeta?.enabled) {
      return;
    }
    await runPlugin(home, 'health-scale', 'profile-save', {
      id: 'owner',
      name: 'Boss',
      sex: 'male',
      age: 26,
      heightCm: 176,
      targetWeightKg: 80,
      unit: 'kg',
      setDefault: true,
    });

    const pluginDataDir = resolvePluginDataDir(home, 'health-scale');
    const sessionPath = join(pluginDataDir, 'live-session.json');
    const startedAt = Date.now();
    await writeFile(sessionPath, JSON.stringify({
      sessionId: 'meas-auto-watch-1',
      profileId: 'owner',
      pid: null,
      phase: 'scanning',
      startedAt,
      updatedAt: startedAt,
      timeoutSec: 45,
      notifications: [],
    }));

    const routerFactory: AgentFactory = {
      mode: 'real',
      nativeTools: true,
      async create(role) {
        if (role !== 'router') return offlineFactory().create(role, role, []);
        return {
          close() {},
          async prompt() {
            return '秤已经开了，赤脚上去站好，45秒内。[[END]]';
          },
        };
      },
    };

    const ttsPayloads: string[] = [];
    const coordinator = new Coordinator(home, routerFactory, { skipExecutor: true });
    await coordinator.ready();
    try {
      coordinator.im.xiaoaiDeps = {
        measurePollIntervalMs: 30,
        sshRunner: async (_target, remoteCommand) => {
          if (remoteCommand.includes('text_to_speech')) {
            ttsPayloads.push(remoteCommand);
          }
          return { stdout: '{"code":0,"info":"{ \\"status\\": 0 }"}', stderr: '', code: 0 };
        },
      };
      coordinator.im.saveChannel({
        id: 'xiaoai-watch',
        platform: 'xiaoai',
        name: '小爱自动播报测试',
        enabled: true,
        notifyAll: false,
        allowedSenders: [],
        apiBase: 'ssh://lx06=root@192.0.2.104',
        defaultTarget: 'lx06',
        pollIntervalMs: 50,
      });
      coordinator.im.start();

      const res = await coordinator.im.ingestMessage({
        channelId: 'xiaoai-watch',
        externalId: 'ext-watch-1',
        senderId: 'lx06',
        target: 'lx06',
        text: '再开一下体脂秤',
        explicitWake: true,
      });
      assert.equal(res.action, 'routed_to_chat');

      // Wait for Router reply TTS + assistant_reply hook to arm watch
      await until(() => ttsPayloads.some(cmd => cmd.includes('秤已经开了')));
      await delay(50);

      // Write completed Scale27 BLE notifications (80.35 kg, 484 ohm) into live-session.json
      await writeFile(sessionPath, JSON.stringify({
        sessionId: 'meas-auto-watch-1',
        profileId: 'owner',
        pid: null,
        phase: 'completed',
        startedAt,
        updatedAt: Date.now(),
        timeoutSec: 45,
        device: { address: 'D0:5C:00:3A:38:8C', name: 'AFU-WL-TZ-A1', rssi: -72 },
        notifications: [
          { hex: 'AC29806939DE020005400064000000000029D509' },
          { hex: 'AC29020001E401A701806939DE0000000029D60F' },
        ],
      }));

      await until(() => ttsPayloads.some(cmd => cmd.includes('测量完成') && cmd.includes('80.35')));
      const history = coordinator.store.conversation.history(undefined, 20).items;
      assert.ok(
        history.some(m => m.role === 'user' && m.text === '[体脂秤实测同步]'),
        'Completed auto-broadcast must be recorded in conversation history',
      );
      const dash = await runPlugin(home, 'health-scale', 'dashboard', {});
      assert.equal(((dash.data as Record<string, unknown>).latest as Record<string, unknown>)?.weightKg, 80.35);
    } finally {
      await coordinator.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoaiChannelAdapter auto-watches active laifen monitor session and announces completed brushing via TTS', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-laifen-watch-'));
  try {
    const laifenMeta = listPluginsSync(home).find(p => p.name === 'laifen');
    if (!laifenMeta?.enabled) {
      return;
    }

    const pluginDataDir = resolvePluginDataDir(home, 'laifen');
    await mkdir(pluginDataDir, { recursive: true });
    const sessionPath = join(pluginDataDir, 'live-session.json');
    const startedAt = Date.now();
    await writeFile(sessionPath, JSON.stringify({
      sessionId: 'brush-auto-watch-1',
      pid: null,
      phase: 'scanning',
      startedAt,
      updatedAt: startedAt,
      timeoutSec: 360,
      notifications: [],
    }));

    const routerFactory: AgentFactory = {
      mode: 'real',
      nativeTools: true,
      async create(role) {
        if (role !== 'router') return offlineFactory().create(role, role, []);
        return {
          close() {},
          async prompt() {
            return '好，已经开始看着刷牙了。[[END]]';
          },
        };
      },
    };

    const ttsPayloads: string[] = [];
    const coordinator = new Coordinator(home, routerFactory, { skipExecutor: true });
    await coordinator.ready();
    try {
      coordinator.im.xiaoaiDeps = {
        measurePollIntervalMs: 30,
        sshRunner: async (_target, remoteCommand) => {
          if (remoteCommand.includes('text_to_speech')) {
            ttsPayloads.push(remoteCommand);
          }
          return { stdout: '{"code":0,"info":"{ \\"status\\": 0 }"}', stderr: '', code: 0 };
        },
      };
      coordinator.im.saveChannel({
        id: 'xiaoai-laifen-watch',
        platform: 'xiaoai',
        name: '小爱刷牙播报测试',
        enabled: true,
        notifyAll: false,
        allowedSenders: [],
        apiBase: 'ssh://lx06=root@192.0.2.104',
        defaultTarget: 'lx06',
        pollIntervalMs: 50,
      });
      coordinator.im.start();

      const res = await coordinator.im.ingestMessage({
        channelId: 'xiaoai-laifen-watch',
        externalId: 'ext-laifen-watch-1',
        senderId: 'lx06',
        target: 'lx06',
        text: '帮我看着点牙刷',
        explicitWake: true,
      });
      assert.equal(res.action, 'routed_to_chat');

      await until(() => ttsPayloads.some(cmd => cmd.includes('已经开始看着刷牙了')));
      await delay(50);

      // Write completed 180s V1 brushing session (74% -> 73%, Mode 3) into live-session.json
      await writeFile(sessionPath, JSON.stringify({
        sessionId: 'brush-auto-watch-1',
        pid: null,
        phase: 'completed',
        startedAt,
        updatedAt: Date.now(),
        timeoutSec: 360,
        device: { address: 'C0:00:00:06:64:0A', name: 'LFTB01-P-640A', rssi: -72 },
        firstStatusHex: 'AA0A0217020104040406060A0A0A0B0606004A0100B401000000014C',
        latestStatusHex: 'AA0A0217020104040406060A0A0A0B060600490100B401000000014F',
        runningStartedAt: startedAt + 3_000,
        accumulatedActiveSec: 180,
        activeBrushingSec: 180,
        brushingActive: false,
        overPressureEvents: 0,
        notifications: [],
      }));

      await until(() => ttsPayloads.some(cmd => cmd.includes('刷牙已记录') && cmd.includes('3 分钟')));
      const history = coordinator.store.conversation.history(undefined, 20).items;
      assert.ok(
        history.some(m => m.role === 'user' && m.text === '[刷牙实测同步]'),
        'Completed brushing auto-broadcast must be recorded in conversation history',
      );
      const dash = await runPlugin(home, 'laifen', 'dashboard', {});
      const dashData = dash.data as { todayCount: number; sessions: Array<{ durationSec: number; source: string }> };
      assert.equal(dashData.todayCount, 1);
      assert.equal(dashData.sessions[0]?.durationSec, 180);
      assert.equal(dashData.sessions[0]?.source, 'ble_monitor');
    } finally {
      await coordinator.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

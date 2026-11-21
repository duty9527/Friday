import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentFactory } from '../src/agent.js';
import { Coordinator } from '../src/coordinator.js';
import { ImGateway } from '../src/im.js';
import {
  buildVoiceTurnHint,
  compactRouterChatWorks,
  createRouterTools,
  createRouterTurnScope,
} from '../src/orchestrator/router-tools.js';
import { Store, type ImChannelConfig } from '../src/store.js';
import {
  XiaoaiKwsMonitor,
  computeRms,
} from '../src/xiaoai/kws-monitor.js';
import {
  SPEAKER_SAMPLE_RATE,
  XiaoaiSpeakerManager,
  type XiaoaiSpeakerExtractor,
} from '../src/xiaoai/speaker-verify.js';
import { until } from './helpers/async.js';

function encodeFloat32ToS16Le(samples: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buf.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return buf;
}

function makeVoicedWithSilenceBuffer(
  leadingSilenceSec: number,
  voicedSec: number,
  trailingSilenceSec: number,
  voicedAmp = 0.08,
): Float32Array {
  const lead = Math.round(SPEAKER_SAMPLE_RATE * leadingSilenceSec);
  const mid = Math.round(SPEAKER_SAMPLE_RATE * voicedSec);
  const trail = Math.round(SPEAKER_SAMPLE_RATE * trailingSilenceSec);
  const out = new Float32Array(lead + mid + trail);
  for (let i = 0; i < mid; i++) {
    out[lead + i] = voicedAmp * Math.sin((2 * Math.PI * 220 * i) / SPEAKER_SAMPLE_RATE);
  }
  return out;
}

test('XiaoaiSpeakerManager: trims 2.05s silence cliff, grants wake-verified ultra-short relief, and eases far-field wake', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-spk-short-'));
  try {
    let score = 1;
    const factory = (): XiaoaiSpeakerExtractor => ({
      dim: 2,
      extract: () => new Float32Array([score, Math.sqrt(Math.max(0, 1 - score * score))]),
      free() {},
    });
    const manager = new XiaoaiSpeakerManager({ homeDir: home, extractorFactory: factory });
    score = 1;
    manager.enrollEmbeddings({ name: '主人', role: 'owner', embeddings: [new Float32Array([1, 0])] });
    manager.configure({ threshold: 0.45 });

    // 2.05s total buffer containing 0.50s silence + 1.00s voiced speech + 0.55s silence
    // After trimShortUtteranceSilence (~1.05s <= 1.25s):
    // - without wakeVerified: 0.45 - 0.09 = 0.36
    // - with wakeVerified:    0.45 - 0.15 = 0.30
    const paddedUltraShort = makeVoicedWithSilenceBuffer(0.50, 1.00, 0.55);

    for (const s of [0.311, 0.324, 0.385, 0.442]) {
      score = s;
      const syncVerified = manager.verifyAndTrimUtterance(paddedUltraShort, SPEAKER_SAMPLE_RATE, { wakeVerified: true });
      const asyncVerified = await manager.verifyAndTrimUtteranceAsync(paddedUltraShort, SPEAKER_SAMPLE_RATE, { wakeVerified: true });
      assert.equal(syncVerified.matched, true, `wakeVerified should pass score=${s}`);
      assert.equal(asyncVerified.matched, true, `async wakeVerified should pass score=${s}`);
      assert.ok(Math.abs(syncVerified.threshold - 0.30) < 1e-9, `expected 0.30 threshold, got ${syncVerified.threshold}`);
    }

    // Without wakeVerified, 0.385 and 0.442 still pass ultra-short threshold 0.36, while 0.324 is rejected
    score = 0.385;
    assert.equal(manager.verifyAndTrimUtterance(paddedUltraShort, SPEAKER_SAMPLE_RATE).matched, true);
    score = 0.324;
    assert.equal(manager.verifyAndTrimUtterance(paddedUltraShort, SPEAKER_SAMPLE_RATE).matched, false);

    // Non-member / TV speech (0.22) remains rejected even with wakeVerified
    score = 0.22;
    assert.equal(manager.verifyAndTrimUtterance(paddedUltraShort, SPEAKER_SAMPLE_RATE, { wakeVerified: true }).matched, false);

    // Far-field wake precheck margins: bare ultra-short "星期五" (0.260) & "你好星期五" (0.300)
    const bareWakeSlice = makeVoicedWithSilenceBuffer(0, 0.65, 0);
    const fullWakeSlice = makeVoicedWithSilenceBuffer(0, 1.10, 0);
    score = 0.265;
    assert.equal(manager.verifyWakeSlice(bareWakeSlice, SPEAKER_SAMPLE_RATE, '星期五').matched, true);
    score = 0.313;
    assert.equal(manager.verifyWakeSlice(fullWakeSlice, SPEAKER_SAMPLE_RATE, '你好星期五').matched, true);
    score = 0.20;
    assert.equal(manager.verifyWakeSlice(bareWakeSlice, SPEAKER_SAMPLE_RATE, '星期五').matched, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoaiKwsMonitor: passes wakeVerified only on two-step wake utterances, never on follow-up captures', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-kws-wakeverified-'));
  let monitor: XiaoaiKwsMonitor | undefined;
  try {
    let audioStream: PassThrough | undefined;
    let spotterKeyword = '';
    const verifyUtteranceCalls: Array<{ wakeVerified?: boolean }> = [];
    const utterances: string[] = [];
    const wakeEvents: string[] = [];

    const channel: ImChannelConfig = {
      id: 'xiaoai-test',
      platform: 'xiaoai',
      name: 'LX06',
      enabled: true,
      notifyAll: false,
      apiBase: 'ssh://lx06=root@127.0.0.1?kws=1&chime=1',
      allowedSenders: [],
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    monitor = new XiaoaiKwsMonitor({
      homeDir: home,
      cooldownMs: 30,
      probeDurationMs: 30,
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
      spotterFactory: () => ({
        createStream: () => ({}),
        acceptWaveform: () => {},
        isReady: () => Boolean(spotterKeyword),
        decode: () => {},
        getResult: () => {
          const k = spotterKeyword;
          spotterKeyword = '';
          return k;
        },
        reset: () => {},
      }),
      recognizerFactory: () => ({
        transcribe: async () => '测量体重。',
      }),
      vadFactory: () => ({
        isSpeech: (samples) => computeRms(samples) >= 0.02,
        reset: () => {},
      }),
      speakerGate: {
        isActive: () => true,
        verifyWake: ({ keyword }) => ({
          matched: true,
          speaker: { id: 'spk-1', name: '主人', role: 'owner', score: 0.42 },
          score: 0.42,
          threshold: 0.26,
        }),
        verifyUtterance: ({ wakeVerified }) => {
          verifyUtteranceCalls.push({ wakeVerified });
          return {
            matched: true,
            speaker: { id: 'spk-1', name: '主人', role: 'owner', score: 0.33 },
            score: 0.33,
            threshold: wakeVerified ? 0.30 : 0.36,
          };
        },
      },
      onWake: async (ev) => {
        wakeEvents.push(`${ev.keyword}:${ev.chime ? 'chime' : 'silent'}`);
        return { woken: true, suppressed: false };
      },
      onUtterance: (ev) => {
        utterances.push(ev.text);
      },
    });

    monitor.sync([channel]);
    await until(() => Boolean(audioStream));

    const writeTone = (amp: number, totalMs: number, chunkMs = 25) => {
      for (let off = 0; off < totalMs; off += chunkMs) {
        const dur = Math.min(chunkMs, totalMs - off);
        const samples = new Float32Array(Math.round((SPEAKER_SAMPLE_RATE * dur) / 1000)).fill(amp);
        audioStream!.write(encodeFloat32ToS16Le(samples));
      }
    };

    // 1. Trigger two-step wake ("星期五") -> silent pause during probe -> capturing
    spotterKeyword = '星期五';
    writeTone(0.08, 25);
    writeTone(0, 120);
    await until(() => wakeEvents.length === 1 && monitor!.isCapturing('xiaoai-test', 'lx06'));
    assert.equal(wakeEvents[0], '星期五:chime');
    writeTone(0, 40);
    // Speak short command + end silence
    writeTone(0.08, 300);
    writeTone(0, 1500);
    await until(() => utterances.length === 1);
    assert.equal(verifyUtteranceCalls.length, 1);
    assert.equal(verifyUtteranceCalls[0]?.wakeVerified, true);

    // 2. Open follow-up window (no explicit wake) -> wakeVerified must NOT be set
    const entered = monitor.enterFollowUpCapture('xiaoai-test', 'lx06', { waitMs: 1_500, discardMs: 0 });
    assert.equal(entered, true);
    writeTone(0.08, 300);
    writeTone(0, 1500);
    await until(() => utterances.length === 2);
    assert.equal(verifyUtteranceCalls.length, 2);
    assert.equal(verifyUtteranceCalls[1]?.wakeVerified, undefined);
  } finally {
    monitor?.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('health-scale voice fastpath matches short start/retry phrases including 重新获取一次数据', async () => {
  const mod = await import('../plugins/health-scale/index.mjs') as unknown as {
    runAction(action: string, args?: Record<string, unknown>, deps?: Record<string, unknown>): Promise<Record<string, unknown>>;
    handleVoiceFastpath(request: Record<string, unknown>, context?: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  const dataDir = mkdtempSync(join(tmpdir(), 'health-fastpath-short-'));
  try {
    await mod.runAction('profile-save', {
      id: 'owner',
      name: 'Boss',
      sex: 'male',
      age: 35,
      heightCm: 176,
      setDefault: true,
    }, { dataDir, nowFn: () => 1_700_000_000_000 });

    if (process.platform === 'linux') {
      const start1 = await mod.handleVoiceFastpath(
        { text: '测量体重。', channelId: 'xiaoai-lx06', platform: 'xiaoai' },
        { dataDir, nowFn: () => 1_700_000_010_000, spawnMeasure: () => 0 },
      );
      assert.equal(start1.handled, true);
      assert.equal(start1.action, 'measure-start');

      const start2 = await mod.handleVoiceFastpath(
        { text: '上秤', channelId: 'xiaoai-lx06', platform: 'xiaoai' },
        { dataDir, nowFn: () => 1_700_000_015_000, spawnMeasure: () => 0 },
      );
      assert.equal(start2.handled, true);
      assert.equal(start2.action, 'measure-start');

      // Within 180s of active/recent session, "重新获取一次数据" directly restarts measurement
      const retryData = await mod.handleVoiceFastpath(
        { text: '重新获取一次数据。', channelId: 'xiaoai-lx06', platform: 'xiaoai' },
        { dataDir, nowFn: () => 1_700_000_060_000, spawnMeasure: () => 0 },
      );
      assert.equal(retryData.handled, true);
      assert.equal(retryData.action, 'measure-start');
      assert.equal(retryData.ok, true);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Coordinator extends limitMs on followup, preserves partialReport when Phase 2 pauses, and updates voice hint', { timeout: 10_000 }, async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-followup-budget-'));
  let phase1EnteredResolve: (() => void) | undefined;
  let phase1GateResolve: (() => void) | undefined;
  let phase2StartedResolve: (() => void) | undefined;
  const phase1Entered = new Promise<void>(r => { phase1EnteredResolve = r; });
  const phase1Gate = new Promise<void>(r => { phase1GateResolve = r; });
  const phase2Started = new Promise<void>(r => { phase2StartedResolve = r; });

  const factory: AgentFactory = {
    mode: 'offline',
    nativeTools: true,
    async create(role) {
      return {
        close() {},
        async prompt(raw, signal) {
          if (role === 'worker') {
            const ev = JSON.parse(raw) as { kind?: string; prompt?: string };
            if (ev.kind === 'TASK' && ev.prompt === '硬件体检') {
              phase1EnteredResolve?.();
              await phase1Gate;
              return '第一阶段体检完成：HP1020 USB 描述符读取异常，其余正常。';
            }
            if (ev.kind === 'FOLLOWUP') {
              phase2StartedResolve?.();
              await new Promise<void>((_, reject) => {
                if (signal.aborted) {
                  reject(signal.reason ?? new Error('aborted'));
                  return;
                }
                signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
              });
            }
          }
          return 'ok';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory, { skipExecutor: true });
  try {
    await coordinator.ready();

    // 1. Standard 600s task gets +300s per unique followup, capped at 1200s
    const task = await coordinator.submit(randomUUID(), '硬件体检', [], 600_000, {
      signal: new AbortController().signal,
      origin: { channel: 'xiaoai', channelId: 'xiaoai-lx06', conversationId: 'lx06', senderId: 'lx06' },
    });
    assert.equal(coordinator.store.get(task.id).limitMs, 600_000);

    // Wait until Turn 1 has already called takeEvents() and entered prompt()
    await phase1Entered;

    const req1 = randomUUID();
    const after1 = coordinator.followup(task.id, req1, '把今日日报也汇总一下');
    assert.equal(after1.limitMs, 900_000);

    // Duplicate requestId must be idempotent
    const afterDup = coordinator.followup(task.id, req1, '把今日日报也汇总一下');
    assert.equal(afterDup.limitMs, 900_000);

    const after2 = coordinator.followup(task.id, randomUUID(), '再检查一下网络');
    assert.equal(after2.limitMs, 1_200_000);

    const after3 = coordinator.followup(task.id, randomUUID(), '顺便看下磁盘');
    assert.equal(after3.limitMs, 1_200_000, 'limitMs must cap at 1,200,000ms');

    // Micro-limit tasks (<60_000ms) remain untouched
    const microTask = await coordinator.submit(randomUUID(), '微超时测试', [], 15_000, {
      signal: new AbortController().signal,
    });
    const microAfter = coordinator.followup(microTask.id, randomUUID(), '追加一句');
    assert.equal(microAfter.limitMs, 15_000);
    coordinator.stop(microTask.id);
    await until(() => coordinator.store.get(microTask.id).status === 'cancelled');

    // 2. Release Phase 1 -> Coordinator detects pending FOLLOWUP -> saves partialReport -> enters Phase 2
    phase1GateResolve!();
    await phase2Started;
    await until(() => Boolean(coordinator.store.get(task.id).partialReport));
    assert.match(coordinator.store.get(task.id).partialReport!, /第一阶段体检完成/);

    // Compact work preview shows partialReport while running
    const worksPreview = compactRouterChatWorks([coordinator.store.get(task.id)]);
    assert.match(worksPreview[0]?.reportPreview ?? '', /第一阶段体检完成/);

    // Simulate timeout pause during Phase 2: task.report stays undefined (Stage-0 contract),
    // while partialReport remains preserved and visible via inspect_work
    coordinator.stop(task.id, '已达到活跃执行时限；工作暂停。需要继续时请重新提供输入', 'paused');
    await until(() => coordinator.store.get(task.id).status === 'paused');

    const pausedTask = coordinator.store.get(task.id);
    assert.equal(pausedTask.report, undefined, 'paused task must not expose final report');
    assert.match(pausedTask.partialReport ?? '', /第一阶段体检完成/, 'partialReport must survive pause');

    const inspectMsg = coordinator.store.conversation.create({
      id: 'm-inspect',
      role: 'user',
      text: '查一下进度',
      status: 'processing',
      mode: 'offline',
      paths: [],
      origin: { channel: 'local' },
    });
    const tools = createRouterTools(
      {
        home,
        store: coordinator.store,
        im: coordinator.im,
        isClosing: () => false,
        getTurn: () => createRouterTurnScope({
          chatContext: {
            message: inspectMsg,
            controller: new AbortController(),
            revisions: new Map(),
            firstAt: Date.now(),
            coalesceUntil: 0,
            mergeVersion: 0,
          },
        }),
        hasInboundHold: () => false,
        runs: new Map(),
        reportAutoDispatches: { get: () => 0, increment: () => {} } as any,
        concurrentTasksInCwd: () => [],
        newChatWork: async () => { throw new Error('unused'); },
        followup: () => pausedTask,
        stop: () => pausedTask,
        resume: () => pausedTask,
        addTimer: () => { throw new Error('unused'); },
        toggleTimer: () => { throw new Error('unused'); },
        completeTimer: () => { throw new Error('unused'); },
        removeTimer: () => false,
        resolveChannelOrigin: () => undefined,
      },
      () => randomUUID(),
    );
    const inspected = JSON.parse(await tools.find(t => t.name === 'inspect_work')!.execute(JSON.stringify({ taskId: task.id })));
    assert.equal(inspected.report, undefined);
    assert.match(inspected.partialReport, /第一阶段体检完成/);

    // 3. Voice hint explicitly instructs calling switch_channel before start_work when promising WeChat/Telegram delivery
    const hint = buildVoiceTurnHint(home, 'xiaoai');
    assert.match(hint.voiceModeConstraint ?? '', /switch_channel/);
    assert.match(hint.voiceModeConstraint ?? '', /start_work/);
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('ImGateway skips non-system interrupted replies on xiaoai but delivers system pause notices', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-sys-pause-'));
  const store = new Store(home);
  const gateway = new ImGateway({ store } as any);
  try {
    const sent: Array<{ channelId: string; text: string; target?: string }> = [];
    gateway.sendToChannel = async (channelId, text, options) => {
      sent.push({ channelId, text, target: options?.target });
    };

    const now = Date.now();
    store.saveImChannel({
      id: 'xiaoai-lx06',
      platform: 'xiaoai',
      name: 'LX06',
      enabled: true,
      notifyAll: false,
      defaultTarget: 'lx06',
      allowedSenders: [],
      inboundCount: 0,
      outboundCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const origin = {
      channel: 'xiaoai' as const,
      channelId: 'xiaoai-lx06',
      conversationId: 'lx06',
      senderId: 'lx06',
    };
    const u1 = store.conversation.create({
      id: 'u-voice-1',
      role: 'user',
      text: '检测打印机',
      status: 'completed',
      mode: 'real',
      paths: [],
      origin,
    });

    // Non-system interrupted reply (e.g., superseded voice stream) must be skipped
    store.conversation.create({
      id: 'r-superseded',
      replyTo: u1.id,
      role: 'assistant',
      text: '半截语音',
      status: 'interrupted',
      reason: '已被新的语音指令打断',
      mode: 'real',
      paths: [],
      origin,
    });

    // System background pause notice must be delivered as concise XiaoAI speech
    store.conversation.create({
      id: 'r-sys-paused',
      replyTo: u1.id,
      role: 'assistant',
      source: 'system',
      text: '',
      status: 'interrupted',
      reason: '后台工作暂停：已达到活跃执行时限；工作暂停。需要继续时请重新提供输入',
      mode: 'real',
      paths: [],
      origin,
    });

    for (let i = 0; i < 6; i++) {
      await (gateway as any).flushOutboundUpdates();
      await delay(15);
    }

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.channelId, 'xiaoai-lx06');
    assert.equal(sent[0]?.target, 'lx06');
    assert.match(sent[0]?.text ?? '', /达到执行时限已暂停/);
  } finally {
    await gateway.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

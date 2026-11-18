import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentFactory, AgentTool } from '../src/agent.js';
import { Coordinator } from '../src/coordinator.js';
import { privateHome } from '../src/files.js';
import {
  CLOCK_DRIFT_MAX_MS as CHAT_CLOCK_DRIFT_MAX_MS,
  HEARTBEAT_STALL_MAX_MS as CHAT_HEARTBEAT_STALL_MAX_MS,
  accrueChatRun,
  type ChatRun,
} from '../src/orchestrator/chat-coalescer.js';
import { createRouterTools, createRouterTurnScope } from '../src/orchestrator/router-tools.js';
import {
  CLOCK_DRIFT_MAX_MS as WORKER_CLOCK_DRIFT_MAX_MS,
  HEARTBEAT_STALL_MAX_MS as WORKER_HEARTBEAT_STALL_MAX_MS,
  accrueTaskRun,
  type Run,
} from '../src/orchestrator/worker-runner.js';
import { Store } from '../src/store.js';
import { until } from './helpers/async.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('1. Clock drift vs event loop stall: 1600ms-5000ms stall without drift does not abort, 2000ms drift or >15s freeze triggers gap', async t => {
  assert.equal(CHAT_CLOCK_DRIFT_MAX_MS, 1_500);
  assert.equal(CHAT_HEARTBEAT_STALL_MAX_MS, 15_000);
  assert.equal(WORKER_CLOCK_DRIFT_MAX_MS, 1_500);
  assert.equal(WORKER_HEARTBEAT_STALL_MAX_MS, 15_000);

  let monoNow = 10_000;
  let wallNow = 1_700_000_000_000;
  t.mock.method(performance, 'now', () => monoNow);
  t.mock.method(Date, 'now', () => wallNow);

  const chatRun: ChatRun = {
    message: {
      id: 'm1',
      seq: 1,
      version: 1,
      role: 'user',
      text: 'hi',
      status: 'processing',
      at: wallNow,
      mode: 'offline',
      paths: [],
      taskIds: [],
    },
    controller: new AbortController(),
    revisions: new Map(),
    clock: { lastTick: monoNow, lastWall: wallNow, activeMs: 0 },
    firstAt: wallNow,
    coalesceUntil: 0,
    mergeVersion: 0,
  };

  // 3200ms synchronous event loop stall (within 1500..15000ms) with 0ms wall-clock drift -> accrues cleanly
  monoNow += 3_200;
  wallNow += 3_200;
  accrueChatRun(chatRun);
  assert.equal(chatRun.controller.signal.aborted, false);
  assert.equal(chatRun.clock!.activeMs, 3_200);

  // 2000ms wall-clock jump (drift > 1500ms) -> aborts Router
  monoNow += 400;
  wallNow += 2_400;
  accrueChatRun(chatRun);
  assert.equal(chatRun.controller.signal.aborted, true);

  // Extreme >15s freeze even without wall-clock drift -> aborts Router
  const chatRunFreeze: ChatRun = {
    ...chatRun,
    controller: new AbortController(),
    clock: { lastTick: monoNow, lastWall: wallNow, activeMs: 0 },
  };
  monoNow += 15_500;
  wallNow += 15_500;
  accrueChatRun(chatRunFreeze);
  assert.equal(chatRunFreeze.controller.signal.aborted, true);

  // Worker accrueTaskRun checks against real Store
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-clock-worker-'));
  const home = await privateHome(join(root, 'h'));
  const store = new Store(home);
  try {
    store.create({
      id: 't1',
      requestId: 'r1',
      fingerprint: 'fp1',
      prompt: 'test',
      files: [],
      limitMs: 60_000,
      activeMs: 0,
      status: 'running',
      revision: 0,
      mode: 'offline',
      createdAt: wallNow,
      execution: 'native',
    });
    const run: Run = {
      id: 't1',
      revision: 0,
      controller: new AbortController(),
      jobs: 1,
      activeCalls: 1,
      clockUncertain: false,
      reads: new Map(),
      completions: [],
      lastTick: monoNow,
      lastWall: wallNow,
    };

    // 4500ms synchronous block with matching wall clock -> accrues cleanly
    monoNow += 4_500;
    wallNow += 4_500;
    assert.equal(accrueTaskRun(store, run), true);
    assert.equal(run.clockUncertain, false);
    assert.equal(store.get('t1').activeMs, 4_500);

    // 2000ms wall-clock drift -> pauses / marks clockUncertain
    monoNow += 200;
    wallNow += 2_200;
    assert.equal(accrueTaskRun(store, run), false);
    assert.equal(run.clockUncertain, true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('2. Dual-priority Router scheduler: interactive preempts queued background tasks, strictly serial, and drains on close()', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-prio-'));
  const home = await privateHome(join(root, 'h'));
  const file = join(root, 'input.txt');
  await writeFile(file, 'data');

  const gate1 = deferred<void>();
  const gateWorkerQ = deferred<void>();
  const routerOrder: string[] = [];
  let activeRouterCalls = 0;
  let maxConcurrentRouterCalls = 0;
  let newTaskCount = 0;

  const factory: AgentFactory = {
    mode: 'offline',
    async create(role, _id, tools) {
      return {
        close() {},
        async prompt(text) {
          if (role === 'router') {
            activeRouterCalls++;
            maxConcurrentRouterCalls = Math.max(maxConcurrentRouterCalls, activeRouterCalls);
            try {
              const ev = JSON.parse(text) as { kind: string; prompt?: string; message?: { text?: string }; question?: string };
              if (ev.kind === 'NEW_TASK') {
                const idx = ++newTaskCount;
                routerOrder.push(`NEW_TASK:${idx}:${ev.prompt}`);
                if (idx === 1) await gate1.promise;
                await tools[0]!.execute('dispatch');
                return 'Dispatched';
              }
              if (ev.kind === 'CHAT') {
                routerOrder.push(`CHAT:${ev.message?.text}`);
                return `Reply:${ev.message?.text}`;
              }
              if (ev.kind === 'WORKER_QUESTION') {
                routerOrder.push(`WORKER_QUESTION:${ev.question}`);
                return 'Need decision';
              }
              routerOrder.push(ev.kind);
              return 'Report ok';
            } finally {
              activeRouterCalls--;
            }
          }
          await gateWorkerQ.promise;
          return 'Worker done';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    // 1. Background task #1 enters Router and blocks on gate1
    await coordinator.submit(randomUUID(), 'bg-1', [file], 5_000);
    await until(() => routerOrder.length === 1);

    // 2. While bg-1 is holding the Router lock, queue background #2 and interactive chat
    await coordinator.submit(randomUUID(), 'bg-2', [file], 5_000);
    await delay(15);
    const chatMsg = coordinator.chat(randomUUID(), 'urgent-hello');
    await delay(15);

    // Release bg-1 -> interactive CHAT must preempt queued bg-2!
    gate1.resolve();
    await until(() => coordinator.store.conversation.get(chatMsg.id).status === 'completed');
    await until(() => routerOrder.some(item => item.startsWith('NEW_TASK:2:')));

    assert.equal(maxConcurrentRouterCalls, 1, 'Router calls must be strictly serial');
    const chatIdx = routerOrder.findIndex(item => item === 'CHAT:urgent-hello');
    const bg2Idx = routerOrder.findIndex(item => item === 'NEW_TASK:2:bg-2');
    assert.ok(chatIdx > 0 && bg2Idx > chatIdx, `Expected interactive CHAT (${chatIdx}) before queued bg-2 (${bg2Idx}); order=${JSON.stringify(routerOrder)}`);

    gateWorkerQ.resolve();
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }

  // Test close() draining queued interactive + background tasks without hanging
  const root2 = await mkdtemp(join(await realpath(tmpdir()), 'sa-prio-close-'));
  const home2 = await privateHome(join(root2, 'h'));
  const file2 = join(root2, 'input.txt');
  await writeFile(file2, 'data');
  const activeGate = deferred<void>();
  let enteredFirst = false;

  const factory2: AgentFactory = {
    mode: 'offline',
    async create(role) {
      return {
        close() {},
        async prompt(_text, signal) {
          if (role === 'router') {
            if (!enteredFirst) {
              enteredFirst = true;
              await new Promise<void>(resolve => {
                signal.addEventListener('abort', () => resolve(), { once: true });
                void activeGate.promise.then(resolve);
              });
            }
            return 'ok';
          }
          return 'worker ok';
        },
      };
    },
  };

  const coordinator2 = new Coordinator(home2, factory2);
  try {
    await coordinator2.ready();
    await coordinator2.submit(randomUUID(), 'active-bg', [file2], 5_000);
    await until(() => enteredFirst);
    const queuedChat = coordinator2.chat(randomUUID(), 'queued-before-close');
    await coordinator2.submit(randomUUID(), 'queued-bg', [file2], 5_000);

    await coordinator2.close();
    const reopened = new Store(home2);
    try {
      assert.equal(reopened.conversation.get(queuedChat.id).status, 'interrupted');
    } finally {
      reopened.close();
    }
  } finally {
    activeGate.resolve();
    await rm(root2, { recursive: true, force: true });
  }
});

test('3. run_plugin forwards AbortSignal from active turn and rejects disabled plugins before execution', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-plugin-guard-'));
  const home = await privateHome(join(root, 'h'));
  const disabledMarker = join(root, 'disabled-ran.txt');
  const abortedMarker = join(root, 'aborted-signal.txt');

  // Create a disabled plugin
  const disabledDir = join(home, 'plugins', 'disabled-plug');
  await mkdir(disabledDir, { recursive: true });
  await writeFile(join(disabledDir, 'plugin.json'), JSON.stringify({
    name: 'disabled-plug',
    title: 'Disabled Plug',
    entry: 'index.mjs',
    enabled: false,
    actions: ['ping'],
  }));
  await writeFile(join(disabledDir, 'index.mjs'), `
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(disabledMarker)}, 'should-not-run');
    process.stdout.write(JSON.stringify({ ok: true, message: 'ran' }));
  `);

  // Create an in-process plugin that observes AbortSignal
  const abortableDir = join(home, 'plugins', 'abort-probe');
  await mkdir(abortableDir, { recursive: true });
  await writeFile(join(abortableDir, 'plugin.json'), JSON.stringify({
    name: 'abort-probe',
    title: 'Abort Probe',
    entry: 'index.mjs',
    runtime: 'in-process',
    enabled: true,
    actions: ['hang'],
  }));
  await writeFile(join(abortableDir, 'index.mjs'), `
    import { writeFileSync } from 'node:fs';
    export function runAction(_action, _args, ctx) {
      return new Promise((_resolve, reject) => {
        if (ctx.signal.aborted) {
          writeFileSync(${JSON.stringify(abortedMarker)}, 'aborted');
          reject(new Error('already aborted'));
          return;
        }
        ctx.signal.addEventListener('abort', () => {
          writeFileSync(${JSON.stringify(abortedMarker)}, 'aborted');
          reject(new Error('plugin signal aborted'));
        }, { once: true });
      });
    }
  `);

  // Direct router-tools test for disabled interception & AbortSignal propagation
  const store = new Store(home);
  const createdMsg = store.conversation.create({
    id: 'msg-1',
    role: 'user',
    text: 'test',
    status: 'processing',
    mode: 'offline',
    paths: [],
    routing: {
      at: Date.now(),
      status: 'processing',
      actions: [],
      context: { execution: 'snapshot', cwd: root, totalWorks: 0, truncated: false, works: [], messages: [] },
    },
  });
  const controller = new AbortController();
  const attemptController = new AbortController();
  const turn = createRouterTurnScope({
    chatContext: {
      message: createdMsg,
      controller,
      attemptController,
      revisions: new Map(),
      firstAt: Date.now(),
      coalesceUntil: 0,
      mergeVersion: 0,
    },
  });

  try {
    const tools = createRouterTools({
      home,
      store,
      im: {} as never,
      isClosing: () => false,
      getTurn: () => turn,
      hasInboundHold: () => false,
      runs: new Map(),
      reportAutoDispatches: { increment: () => 1 } as never,
      concurrentTasksInCwd: () => [],
      newChatWork: async () => { throw new Error('unused'); },
      followup: () => { throw new Error('unused'); },
      stop: () => { throw new Error('unused'); },
      resume: () => { throw new Error('unused'); },
      addTimer: () => { throw new Error('unused'); },
      toggleTimer: () => { throw new Error('unused'); },
      removeTimer: () => false,
      resolveChannelOrigin: () => undefined,
    }, () => randomUUID());

    const runPluginTool = tools.find(t => t.name === 'run_plugin')!;
    await assert.rejects(
      () => runPluginTool.execute(JSON.stringify({ action: 'run', plugin: 'disabled-plug', pluginAction: 'ping' })),
      /禁用|disabled/i,
    );
    assert.equal(existsSync(disabledMarker), false, 'disabled plugin must not execute');

    const pendingRun = runPluginTool.execute(JSON.stringify({ action: 'run', plugin: 'abort-probe', pluginAction: 'hang' }));
    await delay(30);
    attemptController.abort(new Error('turn cancelled'));
    await assert.rejects(() => pendingRun, /abort|turn cancelled/i);
    assert.equal(existsSync(abortedMarker), true, 'AbortSignal must propagate to runPlugin');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('4. speakerRole: member isolates temp Router, strips owner memory/works/autoRecalled, restricts tools/plugins, and preserves gateway speakerRole', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-member-iso-'));
  const home = await privateHome(join(root, 'h'));

  // Create allowed (miot) and private (fund-tracker) plugins under home
  await mkdir(join(home, 'plugins', 'miot'), { recursive: true });
  await writeFile(join(home, 'plugins', 'miot', 'plugin.json'), JSON.stringify({
    name: 'miot',
    title: 'MiOT',
    entry: 'index.mjs',
    runtime: 'in-process',
    enabled: true,
    actions: ['config', 'set'],
  }));
  await writeFile(join(home, 'plugins', 'miot', 'index.mjs'), `
    export async function runAction() {
      return { ok: true, message: '客厅灯已打开' };
    }
  `);

  await mkdir(join(home, 'plugins', 'fund-tracker'), { recursive: true });
  await writeFile(join(home, 'plugins', 'fund-tracker', 'plugin.json'), JSON.stringify({
    name: 'fund-tracker',
    title: 'Fund Tracker',
    entry: 'index.mjs',
    enabled: true,
    actions: ['status'],
  }));
  await writeFile(join(home, 'plugins', 'fund-tracker', 'index.mjs'), `
    process.stdout.write(JSON.stringify({ ok: true, message: 'SECRET_HOLDINGS_100W' }));
  `);

  const createdRouters: Array<{ id: string; tools: AgentTool[]; closed: boolean }> = [];
  const memberPayloads: Array<Record<string, unknown>> = [];
  let ownerPrompts = 0;

  const factory: AgentFactory = {
    mode: 'offline',
    async create(role, id, tools) {
      if (role === 'router') {
        const record = { id, tools, closed: false };
        createdRouters.push(record);
        return {
          leafId: id === 'router' ? 'owner-leaf-1' : undefined,
          checkpoint: id === 'router' ? { sessionFile: 'owner.jsonl', leafId: 'owner-leaf-1' } : undefined,
          close() {
            record.closed = true;
          },
          async prompt(text) {
            const event = JSON.parse(text) as Record<string, unknown>;
            if (id === 'router') {
              ownerPrompts++;
              return 'owner ok';
            }
            memberPayloads.push(event);
            const runPluginTool = tools.find(t => t.name === 'run_plugin')!;
            // Verify list only returns allowed smart home plugins
            const listRes = JSON.parse(await runPluginTool.execute(JSON.stringify({ action: 'list' }))) as {
              plugins: Array<{ name: string }>;
            };
            assert.ok(listRes.plugins.some(p => p.name === 'miot'));
            assert.equal(listRes.plugins.some(p => p.name === 'fund-tracker'), false);
            // Verify private plugin invocation is blocked
            await assert.rejects(
              () => runPluginTool.execute(JSON.stringify({ action: 'run', plugin: 'fund-tracker', pluginAction: 'status' })),
              /无权|公共智能家居/,
            );
            // Verify allowed smart home plugin succeeds (use local config action for both custom and built-in miot)
            const miotRes = JSON.parse(await runPluginTool.execute(JSON.stringify({ action: 'run', plugin: 'miot', pluginAction: 'config' }))) as {
              ok: boolean;
              message: string;
            };
            assert.equal(miotRes.ok, true);
            return '客厅灯已打开';
          },
        };
      }
      return { close() {}, async prompt() { return 'ok'; } };
    },
  };

  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    // Seed owner memory, owner task, and owner checkpoint
    coordinator.store.saveMemory({ topic: '私密持仓', content: '沪深300持仓秘密信息100万', tags: ['finance'] });
    coordinator.store.create({
      id: 'owner-secret-work',
      requestId: 'req-secret-work',
      fingerprint: 'fp-secret',
      prompt: '整理机主私人财务报表',
      files: [],
      limitMs: 60_000,
      activeMs: 0,
      status: 'running',
      revision: 0,
      mode: 'offline',
      createdAt: Date.now(),
      execution: 'native',
    });

    // Establish owner checkpoint via owner chat
    const ownerMsg = coordinator.chat(randomUUID(), '先记录我的检查点');
    await until(() => coordinator.store.conversation.get(ownerMsg.id).status === 'completed');
    const ownerCheckpointBefore = coordinator.store.conversation.meta<{ sessionFile?: string; leafId?: string; lastChatSeq?: number }>('router_checkpoint');
    assert.equal(ownerCheckpointBefore?.sessionFile, 'owner.jsonl');
    assert.equal(ownerCheckpointBefore?.leafId, 'owner-leaf-1');
    assert.ok(typeof ownerCheckpointBefore?.lastChatSeq === 'number');
    const ownerPromptsBefore = ownerPrompts;

    // Test ImGateway inboundOrigin propagates speakerRole
    coordinator.store.saveImChannel({
      id: 'wx-family',
      platform: 'wechat',
      name: 'Family WeChat',
      enabled: true,
      notifyAll: false,
      allowedSenders: [],
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const ingestRes = await coordinator.im.ingestMessage({
      channelId: 'wx-family',
      externalId: 'ext-member-1',
      senderId: 'wife-wx',
      text: '打开客厅灯，顺便看看私密持仓',
      speaker: { id: 'sp-wife', name: '老婆', role: 'member', score: 0.92 },
    });
    assert.equal(ingestRes.ok, true);
    assert.ok(ingestRes.messageId);
    const memberMsg = coordinator.store.conversation.get(ingestRes.messageId!);
    assert.equal(memberMsg.origin?.speakerRole, 'member');
    assert.equal(coordinator.resolveOriginSpeakerRole(memberMsg.origin), 'member');

    await until(() => coordinator.store.conversation.get(memberMsg.id).status === 'completed');

    // Verify resolveOriginSpeakerRole falls back to voiceprint profile id lookup
    assert.equal(coordinator.resolveOriginSpeakerRole({ channel: 'xiaoai', speakerRole: 'owner' }), 'owner');
    const origGetStatus = coordinator.im.getVoiceprintStatus.bind(coordinator.im);
    coordinator.im.getVoiceprintStatus = () => ({
      ...origGetStatus(),
      profiles: [{ id: 'vp-kid', name: '孩子', role: 'member', dim: 4, sampleCount: 1, createdAt: 1, updatedAt: 1 }],
    });
    assert.equal(coordinator.resolveOriginSpeakerRole({ channel: 'xiaoai', speakerId: 'vp-kid' }), 'member');

    // Verify temporary router lifecycle & isolation
    assert.equal(ownerPrompts, ownerPromptsBefore, 'Member chat must never invoke owner this.router');
    const memberRouterRecord = createdRouters.find(r => r.id === `member-${memberMsg.id}`);
    assert.ok(memberRouterRecord, 'Member turn must create isolated temporary router');
    assert.equal(memberRouterRecord.closed, true, 'Temporary member router must be closed in finally');
    assert.deepEqual(memberRouterRecord.tools.map(t => t.name), ['run_plugin'], 'Member router only exposes run_plugin');

    // Verify owner router_checkpoint was not overwritten
    assert.deepEqual(coordinator.store.conversation.meta('router_checkpoint'), ownerCheckpointBefore);

    // Verify CHAT JSON payload stripped owner private state
    assert.equal(memberPayloads.length, 1);
    const payload = memberPayloads[0]!;
    assert.equal(payload.memberPrivacyNotice, '当前为家庭成员语音对话：仅可操作客厅/全屋公开智能家居，严禁透露或查询机主私人记忆、持仓与后台工作。');
    assert.deepEqual(payload.memoryDirectory, { total: 0, pinnedCount: 0, items: [] });
    assert.equal('autoRecalled' in payload, false);
    assert.equal('subconscious' in payload, false);
    assert.equal('works' in payload, false);
    assert.equal('context' in payload, false);
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('5. Fastpath hot session bridge injects unseen fastpath turns once and stops repeating across 7 subsequent turns', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-fastpath-bridge-'));
  const home = await privateHome(join(root, 'h'));
  const capturedPayloads: Array<Record<string, unknown>> = [];
  let turnNum = 0;

  const factory: AgentFactory = {
    mode: 'offline',
    async create(role) {
      if (role !== 'router') return { close() {}, async prompt() { return 'ok'; } };
      let leafId: string | undefined;
      return {
        get leafId() { return leafId; },
        get checkpoint() { return leafId ? { sessionFile: 's.jsonl', leafId } : undefined; },
        close() {},
        async prompt(text) {
          const ev = JSON.parse(text) as Record<string, unknown>;
          if (ev.kind === 'CHAT') {
            capturedPayloads.push(ev);
            leafId = `leaf-${++turnNum}`;
          }
          return `reply-${turnNum}`;
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    coordinator.store.saveImChannel({
      id: 'xa-1',
      platform: 'xiaoai',
      name: '客厅音箱',
      enabled: true,
      notifyAll: false,
      allowedSenders: [],
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Turn 1: establishes hot leafId & lastRouterChatSeq
    const m1 = coordinator.chat(randomUUID(), '第一轮普通对话', [], { channel: 'xiaoai', channelId: 'xa-1', senderId: 'lx06' });
    await until(() => coordinator.store.conversation.get(m1.id).status === 'completed');

    // Fastpath turn recorded directly to SQLite (bypasses Router)
    coordinator.recordFastpathTurn({
      channelId: 'xa-1',
      senderId: 'lx06',
      userText: '打开客厅灯',
      replyText: '已打开客厅灯',
      pluginName: 'miot',
      action: 'set',
      latencyMs: 120,
    });

    // Turn 2: unseen fastpath exists -> bridges unseen turns into context once
    const m2 = coordinator.chat(randomUUID(), '第二轮询问刚才灯开了吗', [], { channel: 'xiaoai', channelId: 'xa-1', senderId: 'lx06' });
    await until(() => coordinator.store.conversation.get(m2.id).status === 'completed');

    const p2 = capturedPayloads[1]!;
    assert.ok(Array.isArray(p2.context), 'Turn 2 must bridge unseen fastpath turn into context');
    const ctx2 = p2.context as Array<{ text: string }>;
    assert.ok(ctx2.some(item => item.text.includes('打开客厅灯')));
    assert.ok(ctx2.some(item => item.text.includes('已打开客厅灯')));
    assert.ok(!ctx2.some(item => item.text.includes('第一轮普通对话')), 'Already-seen Turn 1 should not be re-injected');

    // Subsequent 7 normal rounds: fastpath already seen -> context must NEVER be re-injected
    for (let i = 3; i <= 9; i++) {
      const m = coordinator.chat(randomUUID(), `第${i}轮普通对话`, [], { channel: 'xiaoai', channelId: 'xa-1', senderId: 'lx06' });
      await until(() => coordinator.store.conversation.get(m.id).status === 'completed');
      const payload = capturedPayloads[i - 1]!;
      assert.equal('context' in payload, false, `Turn ${i} must not repeat fastpath context injection`);
    }
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('6. Pre-try chat() failure (e.g. searchContextAsync throw) settles cleanly without unhandledRejection', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-chat-catch-'));
  const home = await privateHome(join(root, 'h'));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  const factory: AgentFactory = {
    mode: 'offline',
    async create() {
      return { close() {}, async prompt() { return 'ok'; } };
    },
  };
  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    coordinator.store.searchContextAsync = async () => {
      throw new Error('simulated searchContextAsync failure');
    };
    const msg = coordinator.chat(randomUUID(), '触发 pre-try 异常');
    await until(() => coordinator.store.conversation.get(msg.id).status === 'failed');
    await delay(50);
    assert.equal(unhandled.length, 0, `Expected 0 unhandled rejections, got ${unhandled.length}`);
    assert.match(coordinator.store.conversation.get(msg.id).reason ?? '', /simulated searchContextAsync failure/);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

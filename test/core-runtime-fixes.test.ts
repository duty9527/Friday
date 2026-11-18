import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgentFactory, AgentTool } from '../src/agent.js';
import { transformAgentContextMessages } from '../src/agent/router-diet.js';
import { realFactory } from '../src/agent/sdk-runtime.js';
import { Coordinator } from '../src/coordinator.js';
import { Executor } from '../src/executor.js';
import { privateHome, snapshot } from '../src/files.js';
import { nativeShellOperations } from '../src/native-shell.js';
import {
  createRouterTools,
  createRouterTurnScope,
  isOriginAccessible,
  resolveReportChainKey,
} from '../src/orchestrator/router-tools.js';
import { SubconsciousController, parseDreamResidue } from '../src/orchestrator/subconscious-loop.js';
import { TimerScheduler } from '../src/orchestrator/timer-scheduler.js';
import { parseWorkerQuestion, resolveExcludedFailures } from '../src/orchestrator/worker-runner.js';
import { request, resolveRequestTimeoutMs } from '../src/protocol.js';
import { serve } from '../src/server.js';
import {
  assignInitialMessageSessionSync,
  backfillPersistedSessions,
  resolveRuntimeMessageSession,
} from '../src/session.js';
import { Store, type Operation, type Task } from '../src/store.js';
import { Watchdog } from '../src/watchdog.js';
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

async function createHome(prefix: string) {
  const root = await mkdtemp(join(await realpath(tmpdir()), prefix));
  const home = await privateHome(join(root, 'home'));
  return {
    root,
    home,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('[C-01] persists complete Worker task.report separately from short Router oral reply and switch_channel', async () => {
  const f = await createHome('fr-c01-');
  const fullReport = `完整技术报告头部\n${'详细根因与验证记录。'.repeat(100)}\n完整技术报告尾部`;
  assert.ok(fullReport.length > 900);

  const factory: AgentFactory = {
    mode: 'real',
    nativeTools: true,
    async create(role, _id, tools) {
      return {
        close() {},
        async prompt(raw) {
          if (role === 'worker') return fullReport;
          const ev = JSON.parse(raw) as { kind?: string };
          if (ev.kind === 'CHAT') {
            const startWork = tools.find(t => t.name === 'start_work')!;
            await startWork.execute(JSON.stringify({ instruction: 'Run complete audit' }));
            return '好的老板，任务已下发。';
          }
          if (ev.kind === 'WORKER_REPORT') {
            return '改好了老板，测试已全过！';
          }
          return 'ok';
        },
      };
    },
  };

  const coordinator = new Coordinator(f.home, factory, { skipExecutor: true });
  try {
    await coordinator.ready();
    const userMsg = coordinator.chat('req-c01', '做一次全面审计');
    await until(() => coordinator.store.list().some(t => t.status === 'completed'));
    const task = coordinator.store.list()[0]!;
    assert.equal(task.report, fullReport, 'task.report must preserve the complete Worker report verbatim');
    const history = coordinator.store.conversation.history(undefined, 10).items;
    const finalReply = history.find(m => m.role === 'assistant' && m.taskIds.includes(task.id) && m.text.includes('改好了老板'));
    assert.ok(finalReply, 'assistant reply delivers Router oral summary');
  } finally {
    await coordinator.close();
    await f.cleanup();
  }
});

test('[C-04] routeWorkerFailure pauses on unsettled ops and WORKER_REPORT fallback keeps full task.report', async () => {
  const f = await createHome('fr-c04-');
  const fullReport = 'Worker completed all checks cleanly with full report preserved.';
  let workerBehavior: 'fail-unsettled' | 'succeed-report-fails' = 'fail-unsettled';

  const factory: AgentFactory = {
    mode: 'real',
    nativeTools: true,
    async create(role, _id, tools, options) {
      return {
        close() {},
        async prompt(raw) {
          if (role === 'worker') {
            if (workerBehavior === 'fail-unsettled') {
              // Simulate native tool start without matching end event (unsettled operation)
              options?.nativeTool?.({ id: 'call-unsettled', name: 'bash', phase: 'start' });
              throw new Error('Upstream model timeout');
            }
            return fullReport;
          }
          const ev = JSON.parse(raw) as { kind?: string };
          if (ev.kind === 'CHAT') {
            const startWork = tools.find(t => t.name === 'start_work')!;
            await startWork.execute(JSON.stringify({ instruction: 'Run check' }));
            return '好的老板，任务已下发。';
          }
          if (ev.kind === 'WORKER_REPORT') {
            throw new Error('Router 503 during summary');
          }
          if (ev.kind === 'WORKER_FAILED') {
            throw new Error('WORKER_FAILED must not run for unsettled failure or completed report fallback');
          }
          return 'ok';
        },
      };
    },
  };

  const coordinator = new Coordinator(f.home, factory, { skipExecutor: true });
  try {
    await coordinator.ready();
    coordinator.chat('req-c04-a', '触发未决工具失败');
    await until(() => coordinator.store.list().some(t => t.status === 'paused'));
    const pausedTask = coordinator.store.list()[0]!;
    assert.equal(pausedTask.status, 'paused', 'unsettled operation forces paused instead of failed');

    workerBehavior = 'succeed-report-fails';
    coordinator.chat('req-c04-b', '触发汇报阶段降级交付');
    await until(() => coordinator.store.list().some(t => t.status === 'completed'));
    const completedTask = coordinator.store.list().find(t => t.status === 'completed')!;
    assert.equal(completedTask.report, fullReport, 'completed report stays intact when WORKER_REPORT router prompt fails');
    const degradedReply = coordinator.store.conversation.history(undefined, 20).items
      .find(m => m.role === 'assistant' && m.taskIds.includes(completedTask.id) && m.text.includes(fullReport));
    assert.ok(degradedReply, 'degraded direct delivery reply created with full Worker report');
  } finally {
    await coordinator.close();
    await f.cleanup();
  }
});

test('[C-05] resume restores Worker checkpoint & history and unsettled round abandons events instead of finishing', async () => {
  const f = await createHome('fr-c05-');
  const sessionFile = join(f.home, 'worker-session.jsonl');
  await writeFile(sessionFile, '{"type":"session"}\n', 'utf8');

  const observedWorkerRestores: Array<{ restore?: { sessionFile: string; leafId: string }; input: Record<string, unknown> }> = [];
  let runRound = 0;

  const factory: AgentFactory = {
    mode: 'real',
    nativeTools: true,
    async create(role, _id, _tools, options) {
      return {
        sessionFile: role === 'worker' ? sessionFile : undefined,
        checkpoint: role === 'worker' ? { sessionFile, leafId: `leaf-${++runRound}` } : undefined,
        close() {},
        async prompt(raw) {
          if (role !== 'worker') return 'ok';
          const payload = JSON.parse(raw) as { input: Record<string, unknown> };
          observedWorkerRestores.push({ restore: options?.restore, input: payload.input });
          if (runRound === 1) {
            // Simulate leaving a started operation unsettled so round pauses
            options?.nativeTool?.({ id: 'op-pause', name: 'bash', phase: 'start' });
            return 'partial report';
          }
          return 'resumed and done';
        },
      };
    },
  };

  const coordinator = new Coordinator(f.home, factory, { skipExecutor: true });
  try {
    await coordinator.ready();
    const task = await coordinator.submit('req-c05', 'initial job', [], 300_000, { signal: new AbortController().signal });
    coordinator.followup(task.id, 'fu-1', '约束1：只改 core 模块');
    await until(() => coordinator.store.get(task.id).status === 'paused');

    const eventsBeforeResume = coordinator.store.events(task.id);
    assert.equal(eventsBeforeResume.every(e => e.state !== 'done'), true, 'paused unsettled round must abandon followup events instead of marking done');

    // Mark one historical event done and resume
    coordinator.store.addEvent('fu-prior-done', task.id, '已生效约束：保留 API 兼容');
    const doneEv = coordinator.store.takeEvents(task.id);
    coordinator.store.finishEvents(doneEv);

    coordinator.resume(task.id, 300_000);
    await until(() => coordinator.store.get(task.id).status === 'completed');

    assert.equal(observedWorkerRestores.length, 2);
    assert.deepEqual(observedWorkerRestores[1]!.restore, { sessionFile, leafId: 'leaf-1' });
    assert.equal(observedWorkerRestores[1]!.input.resumed, true);
    const priorFollowups = observedWorkerRestores[1]!.input.priorFollowups as Array<{ text: string }>;
    assert.ok(priorFollowups.some(x => x.text.includes('保留 API 兼容')));
  } finally {
    await coordinator.close();
    await f.cleanup();
  }
});

test('[C-06] parseWorkerQuestion rejects embedded JSON examples in reports, preserves pre-question queue race & zero activeMs on Router turns', async () => {
  const reportWithExample = [
    '# 审查报告',
    '代码中 Worker 可通过如下格式请示：',
    '```json',
    '{"kind":"ASK_BOSS","question":"示例问题不应误触发挂起","options":["A","B"]}',
    '```',
    '以上仅为文档示例，任务已完成。',
  ].join('\n');
  assert.equal(parseWorkerQuestion(reportWithExample), undefined);

  assert.deepEqual(
    parseWorkerQuestion('```json\n{"kind":"ASK_BOSS","question":"确认发布吗？","options":["继续","中止"]}\n```'),
    { question: '确认发布吗？', options: ['继续', '中止'] },
  );

  const f = await createHome('fr-c06-');
  let workerTurn = 0;
  let injectedPreQuestionFollowup = false;
  const factory: AgentFactory = {
    mode: 'real',
    nativeTools: true,
    async create(role) {
      return {
        close() {},
        async prompt() {
          if (role === 'router') {
            await delay(120);
            return 'Router spoken cleanly';
          }
          workerTurn++;
          if (workerTurn === 1) {
            return JSON.stringify({ kind: 'ASK_BOSS', question: '先跑哪个？' });
          }
          return '已按指令完成';
        },
      };
    },
  };

  const coordinator = new Coordinator(f.home, factory, { skipExecutor: true });
  try {
    await coordinator.ready();
    const msg = coordinator.chat('req-c06-msg', '启动长任务');
    const task = await coordinator.submit('req-c06-task', 'run', [], 300_000, {
      originMessageId: msg.id,
      signal: new AbortController().signal,
    });
    // Inject a followup BEFORE Worker finishes ASK_BOSS Router prompt, ensuring it routes cleanly as FOLLOWUP rather than spurious decision
    await until(() => workerTurn === 1);
    if (!injectedPreQuestionFollowup) {
      injectedPreQuestionFollowup = true;
      coordinator.followup(task.id, 'fu-pre', '顺便先检查日志');
    }
    await until(() => coordinator.store.get(task.id).status === 'completed');
    const finished = coordinator.store.get(task.id);
    // Worker itself returned immediately (~0ms), while two Router prompts each slept 120ms (= 240ms+)
    assert.ok(finished.activeMs < 100, `Expected Router wait excluded from Worker activeMs, got ${finished.activeMs}`);
  } finally {
    await coordinator.close();
    await f.cleanup();
  }
});

test('[C-07][X-02][X-04][C-10] router-tools short ID, IM origin isolation, switch_channel non-mutation, send_file no-clobber & root reportChainKey', async () => {
  const f = await createHome('fr-rtools-');
  const store = new Store(f.home);
  try {
    const localOrigin = { channel: 'local' as const };
    const wxA = { channel: 'wechat' as const, channelId: 'wx-1', conversationId: 'user-a', senderId: 'user-a' };
    const wxB = { channel: 'wechat' as const, channelId: 'wx-1', conversationId: 'user-b', senderId: 'user-b' };
    assert.equal(isOriginAccessible(localOrigin, wxA), true);
    assert.equal(isOriginAccessible(wxA, localOrigin), false);
    assert.equal(isOriginAccessible(wxA, wxB), false);
    assert.equal(isOriginAccessible(wxA, wxA), true);

    store.saveImChannel({
      id: 'wx-1',
      platform: 'wechat',
      name: '微信1',
      enabled: true,
      notifyAll: false,
      defaultTarget: 'user-a',
      allowedSenders: ['user-a', 'user-b'],
      contextTokens: { 'user-a': 'tok-a' },
      pollIntervalMs: 1500,
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const userMsg = store.conversation.create({
      id: 'u-local-1',
      role: 'user',
      origin: localOrigin,
      text: '把结果发微信',
      status: 'processing',
      paths: [],
      mode: 'offline',
    });
    const replyMsg = store.conversation.create({
      id: 'r-local-1',
      replyTo: userMsg.id,
      role: 'assistant',
      origin: localOrigin,
      text: '',
      status: 'streaming',
      paths: [],
      mode: 'offline',
    });

    const localTask: Task = {
      id: '11111111-aaaa-bbbb-cccc-000000000001',
      requestId: 'rt-1',
      fingerprint: 'fp-1',
      prompt: 'local private task',
      files: [],
      limitMs: 60_000,
      activeMs: 0,
      status: 'completed',
      revision: 2,
      mode: 'offline',
      createdAt: Date.now(),
      origin: localOrigin,
    };
    const wxBTask: Task = {
      ...localTask,
      id: '22222222-aaaa-bbbb-cccc-000000000002',
      requestId: 'rt-2',
      fingerprint: 'fp-2',
      prompt: 'wechat user B task',
      origin: wxB,
    };
    const wxATask: Task = {
      ...localTask,
      id: '33333333-aaaa-bbbb-cccc-000000000003',
      requestId: 'rt-3',
      fingerprint: 'fp-3',
      prompt: 'wechat user A task',
      origin: wxA,
    };
    store.create(localTask);
    store.create(wxBTask);
    store.create(wxATask);

    // Multi-hop root reportChainKey without originMessageId
    const childTask: Task = {
      ...localTask,
      id: '44444444-aaaa-bbbb-cccc-000000000004',
      requestId: 'rt-4',
      fingerprint: 'fp-4',
      parentTaskId: localTask.id,
      originMessageId: undefined,
    };
    const grandChildTask: Task = {
      ...localTask,
      id: '55555555-aaaa-bbbb-cccc-000000000005',
      requestId: 'rt-5',
      fingerprint: 'fp-5',
      parentTaskId: childTask.id,
      originMessageId: undefined,
    };
    store.create(childTask);
    store.create(grandChildTask);
    assert.equal(resolveReportChainKey(store, grandChildTask), localTask.id);

    const outbox = join(f.home, 'wechat-files');
    await mkdir(outbox, { recursive: true });
    await writeFile(join(outbox, 'existing.txt'), 'admin-secret', 'utf8');
    await writeFile(join(f.root, 'outside.txt'), 'outside', 'utf8');
    await symlink(join(f.root, 'outside.txt'), join(outbox, 'link.txt'));

    let activeTurn = createRouterTurnScope({
      chatContext: {
        message: userMsg,
        replyId: replyMsg.id,
        controller: new AbortController(),
        revisions: new Map([[localTask.id, localTask.revision]]),
        firstAt: Date.now(),
        coalesceUntil: 0,
        mergeVersion: 0,
      },
    });
    const tools = createRouterTools({
      home: f.home,
      store,
      im: {
        sendWechatAttachment: async () => ({ sent: true }),
        sendTelegramAttachment: async () => ({ sent: true }),
      } as never,
      isClosing: () => false,
      getTurn: () => activeTurn,
      hasInboundHold: () => false,
      runs: new Map(),
      reportAutoDispatches: { get: () => 0, increment: () => 1 } as never,
      concurrentTasksInCwd: () => [],
      newChatWork: async () => localTask,
      followup: () => localTask,
      stop: () => localTask,
      resume: () => localTask,
      addTimer: () => { throw new Error('unused'); },
      toggleTimer: () => { throw new Error('unused'); },
      removeTimer: () => false,
      resolveChannelOrigin: (spec, target) => spec === 'wechat' ? { ...wxA, ...(target ? { senderId: target, conversationId: target } : {}) } : undefined,
    }, (_mid, callId, kind) => `${userMsg.id}:${callId ?? ''}:${kind}`);

    const switchTool = tools.find(t => t.name === 'switch_channel')!;
    await switchTool.execute(JSON.stringify({ channel: 'wechat', target: 'user-a' }));
    assert.equal(store.conversation.get(userMsg.id).origin?.channel, 'local', 'userMsg origin must stay immutable');
    assert.equal(store.conversation.get(replyMsg.id).origin?.channel, 'wechat', 'replyMsg origin switches to wechat');
    assert.equal(activeTurn.chatContext?.deliveryOrigin?.channel, 'wechat');

    const sendFileTool = tools.find(t => t.name === 'send_file')!;
    await assert.rejects(
      () => sendFileTool.execute(JSON.stringify({ name: 'existing.txt', content: 'overwrite' })),
      /存在同名文件/,
    );
    assert.equal(await readFile(join(outbox, 'existing.txt'), 'utf8'), 'admin-secret');
    await assert.rejects(
      () => sendFileTool.execute(JSON.stringify({ name: 'link.txt', content: 'evil' })),
      /存在同名文件|symbolic link/i,
    );

    // Non-local IM caller A cannot inspect/stop/continue local or user B tasks, but CAN inspect own short ID & update revision
    const wxUserMsg = store.conversation.create({
      id: 'u-wx-a',
      role: 'user',
      origin: wxA,
      text: '查我自己的任务',
      status: 'processing',
      paths: [],
      mode: 'offline',
    });
    activeTurn = createRouterTurnScope({
      chatContext: {
        message: wxUserMsg,
        controller: new AbortController(),
        revisions: new Map(), // stale/missing before inspect_work
        firstAt: Date.now(),
        coalesceUntil: 0,
        mergeVersion: 0,
      },
    });
    const inspectTool = tools.find(t => t.name === 'inspect_work')!;
    const stopTool = tools.find(t => t.name === 'stop_work')!;
    await assert.rejects(() => inspectTool.execute(JSON.stringify({ taskId: localTask.id })), /权限不足/);
    await assert.rejects(() => stopTool.execute(JSON.stringify({ taskId: wxBTask.id })), /权限不足/);

    // Short 8-char prefix inspects own task AND updates revisions map for full task.id
    await inspectTool.execute(JSON.stringify({ taskId: wxATask.id.slice(0, 8) }));
    assert.equal(activeTurn.chatContext!.revisions.get(wxATask.id), wxATask.revision);
  } finally {
    store.close();
    await f.cleanup();
  }
});

test('[C-11] stopReply cancels background WORKER_REPORT delivery without losing task.report, and CHAT error rewinds leafId', async () => {
  const f = await createHome('fr-c11-');
  const fullReport = 'Background report kept intact despite stopReply';
  let routerLeaf = 'leaf-before-chat';
  const rewoundTo: Array<string | null> = [];
  const streamingStarted = deferred();
  const continueReport = deferred();
  let failNextChat = false;

  const factory: AgentFactory = {
    mode: 'real',
    nativeTools: true,
    async create(role) {
      return {
        get leafId() { return role === 'router' ? routerLeaf : undefined; },
        rewind(leafId) { if (role === 'router') { routerLeaf = leafId ?? 'root'; rewoundTo.push(leafId); } },
        close() {},
        async prompt(raw, signal) {
          if (role === 'worker') return fullReport;
          const ev = JSON.parse(raw) as { kind?: string };
          if (ev.kind === 'CHAT') {
            if (failNextChat) throw new Error('Chat boom');
            return 'hi';
          }
          if (ev.kind === 'WORKER_REPORT') {
            streamingStarted.resolve();
            await new Promise<void>((_, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
              void continueReport.promise.then(() => reject(new Error('timeout')));
            });
          }
          return 'ok';
        },
      };
    },
  };

  const coordinator = new Coordinator(f.home, factory, { skipExecutor: true });
  try {
    await coordinator.ready();
    failNextChat = true;
    const failedChat = coordinator.chat('req-c11-chat', 'broken chat');
    await until(() => coordinator.store.conversation.get(failedChat.id).status === 'failed');
    assert.deepEqual(rewoundTo, ['leaf-before-chat']);

    failNextChat = false;
    const m = coordinator.chat('req-c11-task-msg', 'start task');
    const task = await coordinator.submit('req-c11-task', 'run', [], 300_000, {
      originMessageId: m.id,
      signal: new AbortController().signal,
    });
    await streamingStarted.promise;
    const streamingReply = coordinator.store.conversation.history(undefined, 20).items
      .find(item => item.replyTo === m.id && item.status === 'streaming')!;
    const stopRes = coordinator.stopReply(streamingReply.id);
    assert.equal(stopRes.state, 'stop_requested');
    await until(() => coordinator.store.get(task.id).status === 'completed');
    assert.equal(coordinator.store.get(task.id).report, fullReport);
  } finally {
    await coordinator.close();
    await f.cleanup();
  }
});

test('[XM-04][XM-05] isolates member sessions across intake/runtime/backfill and persists lastRouterChatSeq', async () => {
  const f = await createHome('fr-xm04-');
  const store = new Store(f.home);
  try {
    const memberOrigin = { channel: 'xiaoai' as const, channelId: 'xa-1', speakerId: 'child-1', speakerRole: 'member' as const };
    const ownerOrigin = { channel: 'xiaoai' as const, channelId: 'xa-1', speakerId: 'owner-1', speakerRole: 'owner' as const };

    const initMember = assignInitialMessageSessionSync(store, {
      id: 'm-mem-1',
      text: '打开台灯',
      origin: memberOrigin,
      at: Date.now(),
    }, []);
    assert.equal(initMember.sessionId, 'session:member:m-mem-1');

    const mOwner = store.conversation.create({
      id: 'm-own-0',
      role: 'user',
      origin: ownerOrigin,
      sessionId: 'session:flow:m-own-0',
      text: '我前面聊的架构方案怎样？',
      status: 'completed',
      paths: [],
      mode: 'offline',
      at: Date.now() - 5_000,
    });
    const mMember = store.conversation.create({
      id: 'm-mem-2',
      role: 'user',
      origin: memberOrigin,
      text: '打开客厅灯',
      status: 'completed',
      paths: [],
      mode: 'offline',
      at: Date.now() - 2_000,
    });
    const mNextOwner = store.conversation.create({
      id: 'm-own-1',
      role: 'user',
      origin: ownerOrigin,
      text: '刚才那个架构继续',
      status: 'queued',
      paths: [],
      mode: 'offline',
      at: Date.now(),
    });
    backfillPersistedSessions(store);
    assert.equal(store.conversation.get(mMember.id).sessionId, 'session:member:m-mem-2');

    const rt = await resolveRuntimeMessageSession(store, {} as never, mNextOwner, []);
    assert.equal(rt.sessionId, mOwner.sessionId, 'owner utterance links to previous owner session, skipping member turn');
  } finally {
    store.close();
    await f.cleanup();
  }

  // [XM-05] router_checkpoint persists lastChatSeq across restart
  const f2 = await createHome('fr-xm05-');
  let leaf = 'leaf-1';
  const factory: AgentFactory = {
    mode: 'offline',
    async create(role) {
      return {
        get leafId() { return role === 'router' ? leaf : undefined; },
        get checkpoint() { return role === 'router' ? { sessionFile: 'r.jsonl', leafId: leaf } : undefined; },
        close() {},
        async prompt() { return 'ok'; },
      };
    },
  };
  const c1 = new Coordinator(f2.home, factory, { skipExecutor: true });
  try {
    await c1.ready();
    const m = c1.chat('req-xm05', 'hello');
    await until(() => c1.store.conversation.get(m.id).status === 'completed');
    const cp = c1.store.conversation.meta<{ lastChatSeq?: number }>('router_checkpoint');
    assert.ok(typeof cp?.lastChatSeq === 'number' && cp.lastChatSeq >= 2);
  } finally {
    await c1.close();
    await f2.cleanup();
  }
});

test('[R-01][R-03][R-04][D-03] coalesce runs outside Router lock, configures non-blocking, limits concurrent workers, guards timers & dream backoff', async () => {
  const f = await createHome('fr-conc-');
  const prevCoalesce = process.env.FRIDAY_IM_COALESCE_MS;
  const prevWorkers = process.env.FRIDAY_MAX_CONCURRENT_WORKERS;
  process.env.FRIDAY_IM_COALESCE_MS = '1200';
  process.env.FRIDAY_MAX_CONCURRENT_WORKERS = '1';

  const w1Started = deferred();
  const releaseW1 = deferred();
  const slowChatEntered = deferred();
  const releaseSlowChat = deferred();
  const coordinator = new Coordinator(f.home, {
    mode: 'real',
    nativeTools: true,
    async create(role) {
      return {
        close() {},
        async prompt(raw) {
          if (role === 'worker') {
            const p = JSON.parse(raw) as { input?: { prompt?: string } };
            if (p.input?.prompt === 'job-1') {
              w1Started.resolve();
              await releaseW1.promise;
            }
            return `done:${p.input?.prompt}`;
          }
          const ev = JSON.parse(raw) as { kind?: string; message?: { text?: string } };
          if (ev.kind === 'CHAT' && ev.message?.text === 'busy-router-chat') {
            slowChatEntered.resolve();
            await releaseSlowChat.promise;
          }
          return 'ok';
        },
      };
    },
  }, { skipExecutor: true });

  try {
    await coordinator.ready();
    // 1. WeChat coalesce waits 1200ms OUTSIDE Router lock -> local chat finishes far sooner
    const wxMsg = coordinator.chat('wx-coalesce', '第一条', [], {
      channel: 'wechat',
      channelId: 'wx-1',
      conversationId: 'c1',
      senderId: 'u1',
    });
    const localStarted = Date.now();
    const localMsg = coordinator.chat('local-fast', '立刻回答我');
    await until(() => coordinator.store.conversation.get(localMsg.id).status === 'completed');
    assert.ok(Date.now() - localStarted < 900, 'local chat must not wait on WeChat 1200ms coalesce');
    await until(() => coordinator.store.conversation.get(wxMsg.id).status === 'completed');

    // 2. Worker concurrency backpressure: limit=1 puts second task into queued before promotion
    const t1 = await coordinator.submit('w-1', 'job-1', [], 60_000, { signal: new AbortController().signal });
    await w1Started.promise;
    const t2 = await coordinator.submit('w-2', 'job-2', [], 60_000, { signal: new AbortController().signal });
    assert.equal(coordinator.store.get(t1.id).status, 'running');
    assert.equal(coordinator.store.get(t2.id).status, 'queued');
    releaseW1.resolve();
    await until(() => coordinator.store.get(t2.id).status === 'completed');

    // 3. configureModels returns promptly without blocking on an in-flight Router turn
    const busy = coordinator.chat('busy-chat', 'busy-router-chat');
    await slowChatEntered.promise;
    const tCfg = Date.now();
    await coordinator.configureModels({ providerId: 'deepseek', apiKey: 'sk-ds-test-key' });
    assert.ok(Date.now() - tCfg < 500, 'configureModels must not wait for occupied Router slot');
    releaseSlowChat.resolve();
    await until(() => coordinator.store.conversation.get(busy.id).status === 'completed');
  } finally {
    if (prevCoalesce === undefined) delete process.env.FRIDAY_IM_COALESCE_MS;
    else process.env.FRIDAY_IM_COALESCE_MS = prevCoalesce;
    if (prevWorkers === undefined) delete process.env.FRIDAY_MAX_CONCURRENT_WORKERS;
    else process.env.FRIDAY_MAX_CONCURRENT_WORKERS = prevWorkers;
    await coordinator.close();
    await f.cleanup();
  }

  // TimerScheduler guards paused activeTaskId and async in-flight submit
  const fTimer = await createHome('fr-timer-');
  const storeT = new Store(fTimer.home);
  try {
    let submits = 0;
    const pendingSubmit = deferred<Task>();
    const sched = new TimerScheduler({
      home: fTimer.home,
      store: storeT,
      mode: 'offline',
      closingSignal: new AbortController().signal,
      isClosing: () => false,
      jobs: new Set(),
      submit: () => { submits++; return pendingSubmit.promise; },
      notifyOutbound: () => {},
    });
    const timer = sched.addTimer('tick-test', 'run work', 500);
    storeT.saveTimer({ ...timer, nextRunAt: Date.now() - 10 });
    sched.tick();
    sched.tick(); // rapid second tick while first submit is in-flight
    assert.equal(submits, 1, 'submittingTaskTimers prevents concurrent duplicate submits');

    const createdTask: Task = {
      id: randomUUID(),
      requestId: 'tm-1',
      fingerprint: 'fp',
      prompt: 'run work',
      files: [],
      limitMs: 60_000,
      activeMs: 0,
      status: 'paused',
      revision: 1,
      mode: 'offline',
      createdAt: Date.now(),
    };
    storeT.create(createdTask);
    pendingSubmit.resolve(createdTask);
    await delay(20);
    storeT.saveTimer({ ...storeT.getTimer(timer.id), nextRunAt: Date.now() - 10, activeTaskId: createdTask.id });
    sched.tick();
    assert.equal(submits, 1, 'paused activeTaskId must block concurrent respawn');
  } finally {
    storeT.close();
    await fTimer.cleanup();
  }

  // Subconscious parseDreamResidue nested fences & REM failure backoff + homeostasis guard
  const dreamWithFence = JSON.stringify({
    impression: '梦到一段 ```ts\nconst x = 1;\n``` 代码与旧文档对应。',
    salience: 'vivid',
    insight: '需要补齐单测',
  });
  assert.equal(parseDreamResidue(`\`\`\`json\n${dreamWithFence}\n\`\`\``)?.salience, 'vivid');
  assert.match(parseDreamResidue(`\`\`\`json\n${dreamWithFence}\n\`\`\``)?.impression ?? '', /const x = 1/);

  const fDream = await createHome('fr-dream-');
  const storeD = new Store(fDream.home);
  try {
    let virtualNow = new Date('2026-11-11T02:00:00').getTime();
    storeD.saveMemory({ topic: 'stub1', content: 'c1', tags: ['auto-consolidated'] });
    storeD.saveMemory({ topic: 'stub2', content: 'c2', tags: ['auto-consolidated'] });
    let dreamCalls = 0;
    const sub = new SubconsciousController({
      store: storeD,
      factory: {
        mode: 'real',
        async create() {
          dreamCalls++;
          return { close() {}, async prompt() { throw new Error('429 rate limited'); } };
        },
      },
      modelHub: {
        getModelPool: () => [],
        async resolveSubconsciousModel() {
          return { model: 'deepseek/deepseek-chat', tier: 'fast', thinkingLevel: 'low' };
        },
      } as never,
      runtime: { now: () => virtualNow, random: () => 0.01, checkIntervalMs: 1 },
      isClosing: () => false,
      hasRouter: () => true,
      hasActiveWork: () => false,
    });
    virtualNow += 90 * 60_000;
    sub.tickSubconscious();
    await sub.awaitSettled();
    assert.equal(dreamCalls, 1);
    // Immediate subsequent ticks inside 5-minute backoff window must NOT re-enter runSleepCycle
    virtualNow += 60_000;
    sub.tickSubconscious();
    await sub.awaitSettled();
    assert.equal(dreamCalls, 1, 'REM failure backoff blocks immediate retry loop');
  } finally {
    storeD.close();
    await fDream.cleanup();
  }
});

test('IPC messages batch, server drain, native-shell overflow, router-diet valid JSON, files symlink/.. & executor eviction', async () => {
  // 1. native-shell rejects 32-bit timer overflow
  const shell = nativeShellOperations();
  await assert.rejects(
    () => shell.exec('echo hi', process.cwd(), { onData: () => {}, timeout: 3_000_000 }),
    /Invalid command timeout/,
  );

  // 2. router-diet always keeps compactToolCallArguments string args as valid JSON (outside active HOST_EVENT tail)
  const compacted = transformAgentContextMessages([
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'tc1', name: 'start_work', arguments: 'not-json-'.repeat(80) }],
    },
    { role: 'user', content: [{ type: 'text', text: 'HOST_EVENT\n{"kind":"CHAT"}' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'latest' }] },
  ] as Array<{ role: string; content: unknown }>, 'router');
  const tc = (compacted[0] as unknown as { content: Array<{ arguments?: unknown }> }).content[0]!;
  assert.doesNotThrow(() => JSON.parse(String(tc.arguments)));

  // 3. files.ts noSymlinkAncestors rejects symlink/sub/../real.txt & disambiguates duplicate names
  const fFiles = await createHome('fr-files-');
  try {
    const dirA = join(fFiles.root, 'dirA');
    const dirB = join(fFiles.root, 'dirB');
    const targetSub = join(fFiles.root, 'targetSub');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await mkdir(targetSub, { recursive: true });
    await writeFile(join(fFiles.root, 'secret.txt'), 's');
    await symlink(targetSub, join(fFiles.root, 'sym'));
    await assert.rejects(
      () => snapshot(fFiles.home, randomUUID(), [`${fFiles.root}/sym/../secret.txt`]),
      /Symbolic links are not accepted/,
    );
    await writeFile(join(dirA, 'README.md'), 'from-a');
    await writeFile(join(dirB, 'README.md'), 'from-b');
    const files = await snapshot(fFiles.home, randomUUID(), [join(dirA, 'README.md'), join(dirB, 'README.md')]);
    assert.equal(new Set(files.map(x => x.name)).size, 2);
  } finally {
    await fFiles.cleanup();
  }

  // 4. Executor evicted fingerprint + child mismatch never overwrites completed Store record
  const fExec = await createHome('fr-exec-');
  const seenUpdates: Operation[] = [];
  const executor = new Executor(fExec.home, op => seenUpdates.push(op));
  try {
    await executor.ready;
    const taskId = randomUUID();
    const src = join(fExec.root, 'a.txt');
    await writeFile(src, 'alpha');
    const [file] = await snapshot(fExec.home, taskId, [src]);
    const op0: Operation = { id: 'op-evict-0', taskId, revision: 0, fileId: file!.id, status: 'requested' };
    const r0 = await executor.start(op0, file!);
    assert.equal(r0.status, 'succeeded');
    // Force eviction of finished LRU (size > 128)
    for (let i = 1; i <= 135; i++) {
      const done = await executor.start({ id: `op-fill-${i}`, taskId, revision: 0, fileId: file!.id, status: 'requested' }, file!);
      assert.equal(done.status, 'succeeded');
    }
    const countBefore = seenUpdates.length;
    await assert.rejects(
      () => executor.start(op0, { ...file!, sha256: 'tampered' }),
      /Operation ID parameter mismatch/,
    );
    assert.equal(seenUpdates.length, countBefore, 'mismatched retry must not overwrite Store status');
  } finally {
    await executor.close();
    await fExec.cleanup();
  }

  // 5. Server IPC batch `messages`, protocol timeouts & Watchdog defaults + ELOCKED recovery across retries
  assert.equal(new Watchdog({ home: fFiles.home }).state().maxRetries, 3);
  assert.equal((new Watchdog({ home: fFiles.home }) as unknown as { backoffMs: number }).backoffMs, 2_000);
  assert.equal(resolveRequestTimeoutMs({ command: 'plugin-run' }), 305_000);
  const fWdLock = await createHome('fr-wd-lock-');
  try {
    let restartAttempts = 0;
    let serviceUp = false;
    const { createServer } = await import('node:net');
    const { socketPath } = await import('../src/protocol.js');
    const mockHealthSrv = createServer(sock => {
      sock.on('data', () => {
        if (!serviceUp) {
          sock.destroy();
          return;
        }
        sock.end(JSON.stringify({ ok: true, result: { status: 'ready', executorAvailable: true, pid: process.pid } }) + '\n');
      });
    });
    await new Promise<void>(resolve => mockHealthSrv.listen(socketPath(fWdLock.home), () => resolve()));
    try {
      const wdLock = new Watchdog({
        home: fWdLock.home,
        maxRetries: 3,
        backoffMs: 10,
        restartService: async () => {
          restartAttempts++;
          if (restartAttempts < 3) {
            const err = new Error('ELOCKED: Lock file is already being held');
            (err as Error & { code?: string }).code = 'ELOCKED';
            throw err;
          }
          serviceUp = true;
        },
      });
      const s1 = await wdLock.checkOnce();
      assert.equal(s1.status, 'recovering');
      assert.equal(s1.failures, 1);
      const s2 = await wdLock.checkOnce();
      assert.equal(s2.status, 'recovering');
      assert.equal(s2.failures, 2);
      const s3 = await wdLock.checkOnce();
      assert.equal(s3.status, 'healthy');
      assert.equal(s3.failures, 0);
      assert.equal(restartAttempts, 3);
    } finally {
      mockHealthSrv.close();
    }
  } finally {
    await fWdLock.cleanup();
  }
  const fSrv = await createHome('fr-srv-');
  const svc = await serve({ home: fSrv.home, mode: 'offline' });
  try {
    const msgs = await request(fSrv.home, { command: 'messages', ids: ['missing-1'] });
    assert.deepEqual(msgs, []);
    await request(fSrv.home, { command: 'chat', requestId: 'srv-c1', text: 'ping', files: [] });
    const list = await request(fSrv.home, { command: 'history' }) as { items: Array<{ id: string }> };
    const batch = await request(fSrv.home, { command: 'messages', ids: [list.items[0]!.id, list.items[0]!.id, 'missing-2'] }) as Array<{ id: string }>;
    assert.equal(batch.length, 1);
    assert.equal(batch[0]!.id, list.items[0]!.id);
  } finally {
    await svc.close();
    await fSrv.cleanup();
  }
});

test('[sdk-runtime] model-hub.json startup fallback, atomic updateModelConfig, multi-slash models, env secret stripping & dreamer usage', async () => {
  const f = await createHome('fr-sdk-');
  const sdkDir = join(f.home, 'sdk');
  await mkdir(sdkDir, { recursive: true });
  await writeFile(join(sdkDir, 'model-hub.json'), JSON.stringify({
    routerProvider: 'openrouter',
    routerModel: 'anthropic/claude-sonnet-4',
    workerProvider: 'siliconflow',
    fastModel: 'deepseek-ai/DeepSeek-R1',
    balancedModel: 'deepseek-ai/DeepSeek-R1',
    strongModel: 'deepseek-ai/DeepSeek-R1',
    providers: {
      openrouter: {
        enabled: true,
        apiKey: 'sk-or-persisted',
        baseUrl: 'https://openrouter.ai/api/v1',
        customModels: ['anthropic/claude-sonnet-4'],
      },
      siliconflow: {
        enabled: true,
        apiKey: 'sk-sf-persisted',
        baseUrl: 'https://api.siliconflow.cn/v1',
        customModels: ['deepseek-ai/DeepSeek-R1'],
      },
    },
  }));

  const runtime = await ModelRuntime.create({
    authPath: join(sdkDir, 'auth.json'),
    modelsPath: null,
    modelsStorePath: join(sdkDir, 'models-cache.json'),
    refreshOnCreate: false,
  });
  try {
    // Boot with empty config (no env vars, no auth.json) -> loads persisted openrouter & siliconflow seamlessly
    // AND keeps initialApiKey === undefined so ModelHub won't misclassify persisted keys as envProviderKeys
    const factory = await realFactory(f.home, {}, runtime);
    assert.equal(factory.initialApiKey, undefined);
    assert.equal(factory.routerProvider, 'openrouter');
    assert.equal(factory.modelTiers?.router, 'anthropic/claude-sonnet-4');

    // Verify atomic validation in updateModelConfig: unknown target rejects WITHOUT mutating routerProvider
    assert.throws(
      () => factory.updateModelConfig!(factory.modelTiers!, 'deepseek', 'nonexistent-model'),
      /Unknown model/,
    );
    assert.equal(factory.routerProvider, 'openrouter', 'routerProvider stays unchanged on invalid model rejection');

    // Verify multi-slash worker model creates cleanly without mis-splitting deepseek-ai as provider
    const worker = await factory.create('worker', 'w-sf', [], { model: 'siliconflow/deepseek-ai/DeepSeek-R1' });
    worker.close();
  } finally {
    await f.cleanup();
  }

  // Also verify historical string selectedModels & apiKey-only non-deepseek/google providers recover cleanly
  for (const hubSeed of [
    { providers: { openai: { enabled: true, apiKey: 'sk-openai-only' } } },
    { routerProvider: 'openai', providers: { openai: { enabled: true, apiKey: 'sk-openai-str', selectedModels: ['gpt-4.1'] } } },
  ]) {
    const fOai = await createHome('fr-sdk-oai-');
    try {
      const sdkOai = join(fOai.home, 'sdk');
      await mkdir(sdkOai, { recursive: true });
      await writeFile(join(sdkOai, 'model-hub.json'), JSON.stringify(hubSeed));
      const rtOai = await ModelRuntime.create({
        authPath: join(sdkOai, 'auth.json'),
        modelsPath: null,
        modelsStorePath: join(sdkOai, 'models-cache.json'),
        refreshOnCreate: false,
      });
      const oaiFactory = await realFactory(fOai.home, {}, rtOai);
      assert.equal(oaiFactory.initialApiKey, undefined);
      assert.equal(oaiFactory.routerProvider, 'openai');
      assert.equal(oaiFactory.modelTiers?.router, 'gpt-4.1');
    } finally {
      await fOai.cleanup();
    }
  }
});

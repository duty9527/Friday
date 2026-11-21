import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { realFactory, SdkAgent, type AgentFactory } from '../src/agent.js';
import { Coordinator } from '../src/coordinator.js';
import { requestGeminiDecisions } from '../src/decision.js';
import { Executor } from '../src/executor.js';
import { privateHome, snapshot } from '../src/files.js';
import { createRouterTools, createRouterTurnScope } from '../src/orchestrator/router-tools.js';
import { TimerScheduler } from '../src/orchestrator/timer-scheduler.js';
import { runPluginInProcess } from '../src/plugin.js';
import { socketPath } from '../src/protocol.js';
import { serve } from '../src/server.js';
import { Store, type Task } from '../src/store.js';
import { pollTuiUpdatesOnce, TuiMessageDeduper } from '../src/tui.js';
import { createManagedServeRestarter } from '../src/watchdog.js';
import type { ChatMessage } from '../src/view.js';
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

test('stopReply cleanly cancels WORKER_REPORT and WORKER_QUESTION delivery without fallback corruption or stuck streaming', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'audit-stop-reply-'));
  const home = await privateHome(join(root, 'h'));
  try {
    let phase: 'report' | 'question' | 'question-error' = 'report';
    let workerTurn = 0;
    const streamingStarted = deferred<void>();
    const qStreamingStarted = deferred<void>();

    const factory: AgentFactory = {
      mode: 'real',
      nativeTools: true,
      async create(role) {
        return {
          close() {},
          async prompt(raw, signal) {
            const ev = JSON.parse(raw) as { kind?: string };
            if (role === 'worker') {
              workerTurn++;
              if (phase !== 'report' && workerTurn % 2 === 1) {
                return JSON.stringify({ kind: 'ASK_BOSS', question: '继续方案 A 还是 B？' });
              }
              return 'Worker full report body';
            }
            if (ev.kind === 'CHAT') return 'ok';
            if (ev.kind === 'WORKER_REPORT') {
              if (phase === 'report') {
                streamingStarted.resolve();
                await new Promise<void>((_, reject) => {
                  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
              }
              return '最终汇总：Worker full report body';
            }
            if (ev.kind === 'WORKER_QUESTION') {
              if (phase === 'question-error') {
                throw new Error('simulated router question narration failure');
              }
              qStreamingStarted.resolve();
              await new Promise<void>((_, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
              });
            }
            return 'ok';
          },
        };
      },
    };

    const coordinator = new Coordinator(home, factory, { skipExecutor: true });
    try {
      await coordinator.ready();

      // 1) stopReply during WORKER_REPORT: reply becomes interrupted (not completed fallback), no router_report_fallback notice
      const m1 = coordinator.chat(randomUUID(), 'task 1');
      const t1 = await coordinator.submit(randomUUID(), 'run 1', [], 60_000, {
        originMessageId: m1.id,
        signal: new AbortController().signal,
      });
      await streamingStarted.promise;
      const r1 = coordinator.store.conversation.history(undefined, 20).items
        .find(item => item.replyTo === m1.id && item.status === 'streaming')!;
      assert.equal(coordinator.stopReply(r1.id).state, 'stop_requested');
      await until(() => coordinator.store.get(t1.id).status === 'completed');
      const finalR1 = coordinator.store.conversation.get(r1.id);
      assert.equal(finalR1.status, 'interrupted');
      assert.match(finalR1.reason ?? '', /已停止汇总播报/);
      assert.equal(coordinator.store.get(t1.id).report, 'Worker full report body');
      assert.equal(
        coordinator.store.notices(0).some(n => n.taskId === t1.id && n.kind === 'router_report_fallback'),
        false,
        'stopped delivery must not emit fallback failure notice',
      );

      // 2) stopReply during WORKER_QUESTION: reply becomes interrupted (not stuck streaming), task still resumes on followup
      phase = 'question';
      workerTurn = 0;
      const m2 = coordinator.chat(randomUUID(), 'task 2');
      const t2 = await coordinator.submit(randomUUID(), 'run 2', [], 60_000, {
        originMessageId: m2.id,
        signal: new AbortController().signal,
      });
      await qStreamingStarted.promise;
      const r2 = coordinator.store.conversation.history(undefined, 20).items
        .find(item => item.replyTo === m2.id && item.status === 'streaming')!;
      assert.equal(coordinator.stopReply(r2.id).state, 'stop_requested');
      await until(() => coordinator.store.conversation.get(r2.id).status === 'interrupted');
      assert.match(coordinator.store.conversation.get(r2.id).reason ?? '', /已停止请示播报/);
      coordinator.followup(t2.id, randomUUID(), '选 A');
      await until(() => coordinator.store.get(t2.id).status === 'completed');

      // 3) Router error during WORKER_QUESTION marks reply failed instead of leaking streaming state
      phase = 'question-error';
      workerTurn = 0;
      const m3 = coordinator.chat(randomUUID(), 'task 3');
      const t3 = await coordinator.submit(randomUUID(), 'run 3', [], 60_000, {
        originMessageId: m3.id,
        signal: new AbortController().signal,
      });
      await until(() => Boolean(coordinator.store.get(t3.id).pendingQuestion));
      const qReply = coordinator.store.conversation.history(undefined, 20).items
        .find(item => item.replyTo === m3.id && item.taskIds.includes(t3.id));
      assert.ok(qReply);
      assert.equal(qReply.status, 'failed');
      assert.match(qReply.reason ?? '', /继续方案 A 还是 B/);
      coordinator.followup(t3.id, randomUUID(), '选 B');
      await until(() => coordinator.store.get(t3.id).status === 'completed');
    } finally {
      await coordinator.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Coordinator.chat respects stopReply arriving during async searchContextAsync before Router prompt runs', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'audit-chat-abort-'));
  const home = await privateHome(join(root, 'h'));
  try {
    let routerPrompts = 0;
    const searchEntered = deferred<void>();
    const releaseSearch = deferred<void>();

    const factory: AgentFactory = {
      mode: 'offline',
      async create(role) {
        return {
          close() {},
          async prompt() {
            if (role === 'router') routerPrompts++;
            return 'should not run';
          },
        };
      },
    };
    const coordinator = new Coordinator(home, factory, { skipExecutor: true });
    try {
      await coordinator.ready();
      coordinator.store.searchContextAsync = async () => {
        searchEntered.resolve();
        await releaseSearch.promise;
        return { hits: [], query: '', scope: 'all', totalCandidates: 0 } as never;
      };
      const msg = coordinator.chat(randomUUID(), '长查询');
      await searchEntered.promise;
      coordinator.stopReply(msg.id);
      releaseSearch.resolve();
      await until(() => coordinator.store.conversation.get(msg.id).status === 'interrupted');
      await delay(30);
      assert.equal(routerPrompts, 0, 'aborted chat must never invoke Router prompt after async intake');
      const replies = coordinator.store.conversation.history(undefined, 20).items.filter(m => m.replyTo === msg.id);
      assert.equal(replies.length, 0, 'no streaming reply should be created after pre-start abort');
    } finally {
      releaseSearch.resolve();
      await coordinator.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Coordinator.submit handles concurrent duplicate requestId across async decideWorkerModel idempotently', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'audit-submit-race-'));
  const home = await privateHome(join(root, 'h'));
  try {
    const factory: AgentFactory = {
      mode: 'offline',
      nativeTools: true,
      async create() {
        return { close() {}, async prompt() { return 'ok'; } };
      },
    };
    const coordinator = new Coordinator(home, factory, { skipExecutor: true });
    try {
      await coordinator.ready();
      let calls = 0;
      const barrier = deferred<void>();
      coordinator.modelHub.getModelPool = () => [{
        spec: 'openai/gpt-4.1',
        providerId: 'openai',
        providerName: 'OpenAI',
        modelId: 'gpt-4.1',
        modelName: 'GPT-4.1',
        tier: 'balanced',
        thinkingLevels: ['off'],
        specialties: [],
        supportsImages: false,
        reasoning: false,
        contextWindow: 128_000,
      }];
      coordinator.modelHub.decideWorkerModel = async () => {
        calls++;
        if (calls === 2) barrier.resolve();
        await barrier.promise;
        await delay(15);
        return { model: 'openai/gpt-4.1', tier: 'balanced', thinkingLevel: 'off', source: 'heuristic', attempted: false };
      };
      const reqId = randomUUID();
      const [t1, t2] = await Promise.all([
        coordinator.submit(reqId, 'same prompt', [], 60_000),
        coordinator.submit(reqId, 'same prompt', [], 60_000),
      ]);
      assert.equal(t1.id, t2.id, 'concurrent identical submits must resolve to the same task');
      assert.equal(coordinator.store.list().length, 1);
    } finally {
      await coordinator.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('realFactory preserves fetchedModels metadata under baseUrl and SdkAgent restores model even if fallback setModel throws', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'audit-sdk-meta-'));
  const home = await privateHome(join(root, 'h'));
  try {
    const sdkDir = join(home, 'sdk');
    await mkdir(sdkDir, { recursive: true });
    await writeFile(join(sdkDir, 'model-hub.json'), JSON.stringify({
      routerProvider: 'openai',
      routerModel: 'o3-custom',
      providers: {
        openai: {
          enabled: true,
          apiKey: 'sk-test-proxy',
          baseUrl: 'https://proxy.example.invalid/v1',
          fetchedModels: [{
            id: 'o3-custom',
            name: 'O3 Custom',
            reasoning: true,
            supportsImages: true,
            contextWindow: 200_000,
            maxTokens: 16_384,
            costInput: 5,
            costOutput: 20,
          }],
        },
      },
    }));
    const runtime = await ModelRuntime.create({
      authPath: join(sdkDir, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(sdkDir, 'models-cache.json'),
      refreshOnCreate: false,
    });
    await realFactory(home, {}, runtime);
    const model = runtime.getModel('openai', 'o3-custom');
    assert.ok(model);
    assert.equal(model.reasoning, true, 'reasoning capability must be preserved when baseUrl is set');
    assert.equal(model.contextWindow, 200_000);
    assert.equal(model.maxTokens, 16_384);
    assert.deepEqual(model.input, ['text', 'image']);
    assert.equal(model.cost.input, 5);

    // SdkAgent restores primary model even if setModel(fallback) throws
    const primaryModel = { provider: 'openai', id: 'primary', input: ['text'] };
    const fallbackModel = { provider: 'openai', id: 'fallback', input: ['text'] };
    const setModels: string[] = [];
    const fakeSession = {
      model: primaryModel,
      messages: [],
      sessionFile: undefined,
      sessionManager: { getLeafId: () => null, resetLeaf: () => {}, getEntry: () => undefined, branch: () => {} },
      agent: {},
      subscribe: () => () => {},
      refreshContext: () => {},
      dispose: () => {},
      abort: async () => {},
      setModel: async (m: { id: string }) => {
        setModels.push(m.id);
        if (m.id === 'fallback') throw new Error('setModel failed');
      },
      prompt: async () => {
        throw new Error('429 rate limit exceeded');
      },
    };
    const agent = new SdkAgent(
      fakeSession as never,
      undefined,
      undefined,
      () => fallbackModel as never,
      'router',
      () => primaryModel as never,
    );
    await assert.rejects(() => agent.prompt('hi', new AbortController().signal), /setModel failed/);
    assert.deepEqual(setModels, ['fallback', 'primary']);
    agent.close();

    // SdkAgent.promptOnce aborts after messageImages I/O without invoking session.prompt
    const pngPath = join(root, 'tiny.png');
    await writeFile(pngPath, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex'));
    let sessionPromptCalls = 0;
    const imgAgent = new SdkAgent({
      model: { provider: 'openai', id: 'vision', input: ['text', 'image'] },
      messages: [],
      sessionFile: undefined,
      sessionManager: { getLeafId: () => null, resetLeaf: () => {}, getEntry: () => undefined, branch: () => {} },
      agent: {},
      subscribe: () => () => {},
      refreshContext: () => {},
      dispose: () => {},
      abort: async () => {},
      prompt: async () => { sessionPromptCalls++; },
    } as never);
    const imgAbort = new AbortController();
    const imgPayload = JSON.stringify({
      kind: 'CHAT',
      message: {
        attachments: [{ kind: 'image', name: 'tiny.png', status: 'ready', path: pngPath, mimeType: 'image/png' }],
      },
    });
    const imgPromise = imgAgent.prompt(imgPayload, imgAbort.signal);
    queueMicrotask(() => imgAbort.abort(new Error('aborted during messageImages')));
    await assert.rejects(() => imgPromise, /aborted during messageImages/);
    assert.equal(sessionPromptCalls, 0);
    imgAgent.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('createManagedServeRestarter drains child stdout/stderr pipes (>64KiB) and awaits timed-out child stop', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'audit-watchdog-'));
  const home = await privateHome(join(root, 'h'));
  const marker = join(root, 'drained.txt');
  const script = join(root, 'mock-serve.mjs');
  await writeFile(script, `
    import { writeFileSync } from 'node:fs';
    const mode = process.env.MOCK_MODE || 'drain';
    if (mode === 'hang') {
      setInterval(() => {}, 1000);
    } else {
      process.stdout.write(JSON.stringify({ status: 'ready' }) + '\\n');
      for (let i = 0; i < 64; i++) {
        process.stdout.write('O'.repeat(4096) + '\\n');
        process.stderr.write('E'.repeat(4096) + '\\n');
      }
      writeFileSync(${JSON.stringify(marker)}, 'done');
      setInterval(() => {}, 1000);
    }
  `);

  const restarter = createManagedServeRestarter({
    home,
    entryScript: script,
    startupTimeoutMs: 400,
    shutdownTimeoutMs: 250,
  });
  const prevMode = process.env.MOCK_MODE;
  try {
    process.env.MOCK_MODE = 'drain';
    await restarter.restartService();
    await until(async () => {
      try {
        const fs = await import('node:fs/promises');
        await fs.access(marker);
        return true;
      } catch {
        return false;
      }
    });
    await restarter.stop();

    process.env.MOCK_MODE = 'hang';
    await assert.rejects(() => restarter.restartService(), /did not become ready/);
    await restarter.stop();
  } finally {
    if (prevMode === undefined) delete process.env.MOCK_MODE;
    else process.env.MOCK_MODE = prevMode;
    await restarter.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('Executor settles pending ops on child error event and close() never hangs when child fails to spawn', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'audit-executor-'));
  const home = await privateHome(join(root, 'h'));
  try {
    const updates: Array<{ id: string; status: string }> = [];
    const exec = new Executor(home, op => updates.push(op));
    await exec.ready;

    const taskId = randomUUID();
    const src = join(root, 'a.txt');
    await writeFile(src, 'alpha');
    const [file] = await snapshot(home, taskId, [src]);

    // Pause child so start() remains pending, then emit 'error' without 'exit'
    const childPid = exec.pid!;
    process.kill(childPid, 'SIGSTOP');
    const opPromise = exec.start({ id: 'op-err-1', taskId, revision: 0, fileId: file!.id, status: 'requested' }, file!);
    const internals = exec as unknown as {
      child: EventEmitter & { connected: boolean; pid?: number; send: () => void; kill: () => boolean; disconnect: () => void };
      dead: boolean;
    };
    internals.child.emit('error', new Error('simulated IPC error'));
    const settled = await opPromise;
    assert.equal(settled.status, 'unknown');
    assert.ok(updates.some(u => u.id === 'op-err-1' && u.status === 'unknown'));
    try { process.kill(childPid, 'SIGCONT'); } catch {}
    try { process.kill(childPid, 'SIGKILL'); } catch {}

    // Test close() on dead/no-pid child does not hang
    const fakeChild = new EventEmitter() as EventEmitter & { connected: boolean; pid?: number; send: () => void; kill: () => boolean; disconnect: () => void };
    fakeChild.connected = true;
    fakeChild.pid = undefined;
    fakeChild.send = () => {};
    fakeChild.kill = () => false;
    fakeChild.disconnect = () => {};
    internals.dead = false;
    internals.child = fakeChild;
    await exec.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('pollTuiUpdatesOnce skips deleted transient messages and advances cursor without stalling', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'audit-tui-'));
  const home = await privateHome(join(root, 'h'));
  let failTransient = false;
  const msgOk: ChatMessage = {
    seq: 2,
    version: 1,
    id: 'msg-ok',
    role: 'assistant',
    text: 'Delivered after silent handoff',
    status: 'completed',
    at: Date.now(),
    mode: 'offline',
    paths: [],
    taskIds: [],
  };
  const server = createNetServer(socket => {
    let buf = '';
    socket.on('data', chunk => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)) as { command: string; messageId?: string };
      if (failTransient) {
        socket.end(JSON.stringify({ ok: false, error: 'Transient failure' }) + '\n');
        return;
      }
      if (req.command === 'updates') {
        socket.end(JSON.stringify({
          ok: true,
          result: {
            cursor: 10,
            events: [
              { seq: 9, id: 'e1', type: 'message', kind: 'message_created', rootId: 'u1', messageId: 'deleted-handoff', actor: 'router', label: 'r', status: 'streaming', at: 1 },
              { seq: 10, id: 'e2', type: 'message', kind: 'message_updated', rootId: 'u1', messageId: 'msg-ok', actor: 'router', label: 'r', status: 'completed', at: 2 },
            ],
          },
        }) + '\n');
      } else if (req.command === 'message') {
        if (req.messageId === 'deleted-handoff') {
          socket.end(JSON.stringify({ ok: false, error: 'Message not found' }) + '\n');
        } else {
          socket.end(JSON.stringify({ ok: true, result: msgOk }) + '\n');
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(socketPath(home), resolve));
  try {
    const deduper = new TuiMessageDeduper();
    const printed: ChatMessage[] = [];
    const nextCursor = await pollTuiUpdatesOnce(home, 0, deduper, msg => printed.push(msg));
    assert.equal(nextCursor, 10, 'cursor must advance past deleted transient message');
    assert.deepEqual(printed.map(m => m.id), ['msg-ok']);

    failTransient = true;
    await assert.rejects(() => pollTuiUpdatesOnce(home, 10, deduper, () => {}), /Transient failure/);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('requestGeminiDecisions sanitizes non-numeric total_tokens without producing NaN', async () => {
  const srv = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      answers: { ok: { type: 'noul', noul: 0.85 } },
      usage: { total_input_tokens: 42, total_tokens: 'not-a-number' },
    }));
  });
  await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  assert.ok(addr && typeof addr !== 'string');
  try {
    const out = await requestGeminiDecisions(
      { apiKey: 'test-key', baseUrl: `http://127.0.0.1:${addr.port}/v1beta` },
      'check',
      { ok: { type: 'noul', instructions: 'yes?' } },
    );
    assert.equal(out.outputTokens, 0);
    assert.equal(out.usage?.inputTokens, 42);
    assert.equal(out.usage?.totalTokens, 42);
    assert.equal(Number.isNaN(out.usage?.totalTokens), false);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>(resolve => srv.close(() => resolve()));
  }
});

test('run_plugin propagates allowedPlugins into callPlugin and passes reportChatContext AbortSignal; failed ESM plugins recover on edit', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'audit-plugin-'));
  const home = await privateHome(join(root, 'h'));
  const store = new Store(home);
  try {
    const callerDir = join(home, 'plugins', 'audit-caller-plug');
    const targetDir = join(home, 'plugins', 'audit-secret-plug');
    const brokenDir = join(home, 'plugins', 'broken-plug');
    await mkdir(callerDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await mkdir(brokenDir, { recursive: true });

    await writeFile(join(callerDir, 'plugin.json'), JSON.stringify({
      name: 'audit-caller-plug', title: 'Audit Caller', entry: 'index.mjs', runtime: 'in-process', enabled: true, actions: ['call-secret', 'hang'],
    }));
    await writeFile(join(callerDir, 'index.mjs'), `
      export async function runAction(action, _args, ctx) {
        if (action === 'call-secret') {
          return await ctx.callPlugin('audit-secret-plug', 'status', {});
        }
        return await new Promise((_res, rej) => {
          if (ctx.signal.aborted) return rej(new Error('signal aborted'));
          ctx.signal.addEventListener('abort', () => rej(new Error('signal aborted')), { once: true });
        });
      }
    `);

    await writeFile(join(targetDir, 'plugin.json'), JSON.stringify({
      name: 'audit-secret-plug', title: 'Secret', entry: 'index.mjs', runtime: 'in-process', enabled: true, actions: ['status'],
    }));
    await writeFile(join(targetDir, 'index.mjs'), `
      export async function runAction() { return { ok: true, message: 'SECRET' }; }
    `);

    await writeFile(join(brokenDir, 'plugin.json'), JSON.stringify({
      name: 'broken-plug', title: 'Broken', entry: 'index.mjs', runtime: 'in-process', enabled: true, actions: ['ping'],
    }));
    await writeFile(join(brokenDir, 'index.mjs'), 'export const broken = ;;;\n');

    const reportController = new AbortController();
    const userMsg = store.conversation.create({
      id: 'u1', role: 'user', text: 'hi', status: 'completed', mode: 'offline', paths: [],
      routing: { at: Date.now(), status: 'completed', actions: [], context: { execution: 'snapshot', cwd: root, totalWorks: 0, truncated: false, works: [], messages: [] } },
    });
    const turn = createRouterTurnScope({
      activeReportTask: {
        id: 't1', requestId: 'r1', fingerprint: 'fp', prompt: 'p', files: [], limitMs: 60_000, activeMs: 0, status: 'running', revision: 0, mode: 'offline', createdAt: Date.now(), originMessageId: userMsg.id,
      },
      reportChatContext: {
        message: userMsg, controller: reportController, revisions: new Map(), firstAt: Date.now(), coalesceUntil: 0, mergeVersion: 0,
      },
    });
    const tools = createRouterTools({
      home,
      store,
      im: {} as never,
      isClosing: () => false,
      getTurn: () => turn,
      hasInboundHold: () => false,
      runs: new Map(),
      reportAutoDispatches: { get: () => 0, increment: () => 1 } as never,
      concurrentTasksInCwd: () => [],
      newChatWork: async () => { throw new Error('unused'); },
      followup: () => { throw new Error('unused'); },
      stop: () => { throw new Error('unused'); },
      resume: () => { throw new Error('unused'); },
      addTimer: () => { throw new Error('unused'); },
      toggleTimer: () => { throw new Error('unused'); },
      removeTimer: () => false,
      resolveChannelOrigin: () => undefined,
    }, () => randomUUID(), { allowedPlugins: new Set(['audit-caller-plug']) });

    const runPluginTool = tools.find(t => t.name === 'run_plugin')!;
    await assert.rejects(
      () => runPluginTool.execute(JSON.stringify({ action: 'run', plugin: 'audit-caller-plug', pluginAction: 'call-secret' })),
      /not allowed in caller context/,
    );

    const pendingHang = runPluginTool.execute(JSON.stringify({ action: 'run', plugin: 'audit-caller-plug', pluginAction: 'hang' }));
    await delay(25);
    reportController.abort(new Error('report stopped'));
    await assert.rejects(() => pendingHang, /report stopped|signal aborted/);

    // Broken initial in-process ESM plugin must recover once fixed on disk
    await assert.rejects(() => runPluginInProcess(home, 'broken-plug', 'ping'), SyntaxError);
    await writeFile(join(brokenDir, 'index.mjs'), 'export async function runAction() { return { ok: true, message: "fixed" }; }\n');
    const future = new Date(Date.now() + 2000);
    await utimes(join(brokenDir, 'index.mjs'), future, future);
    const fixed = await runPluginInProcess(home, 'broken-plug', 'ping');
    assert.equal(fixed.ok, true);
    assert.equal(fixed.message, 'fixed');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('TimerScheduler bounds oversized plugin replies atomically and ignores already-settled activeTaskId', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'audit-timer-'));
  const home = await privateHome(join(root, 'h'));
  const store = new Store(home);
  try {
    const bigPluginDir = join(home, 'plugins', 'big-plug');
    await mkdir(bigPluginDir, { recursive: true });
    await writeFile(join(bigPluginDir, 'plugin.json'), JSON.stringify({
      name: 'big-plug', title: 'Big', entry: 'index.mjs', runtime: 'in-process', enabled: true, actions: ['ping'],
    }));
    await writeFile(join(bigPluginDir, 'index.mjs'), `
      export async function runAction() { return { ok: true, notify: true, message: 'X'.repeat(70000) }; }
    `);

    const jobs = new Set<Promise<void>>();
    const settledTask: Task = {
      id: randomUUID(), requestId: 'req-fast', fingerprint: 'fp', prompt: 'p', files: [],
      limitMs: 60_000, activeMs: 0, status: 'completed', revision: 1, mode: 'offline', createdAt: Date.now(),
    };
    store.create(settledTask);

    const sched = new TimerScheduler({
      home,
      store,
      mode: 'offline',
      closingSignal: new AbortController().signal,
      isClosing: () => false,
      jobs,
      submit: async () => settledTask,
      notifyOutbound: () => {},
    });

    const pTimer = sched.addTimer('big-plugin-timer', 'check', 60_000, undefined, undefined, { plugin: 'big-plug', pluginAction: 'ping' });
    store.saveTimer({ ...pTimer, nextRunAt: Date.now() - 10 });
    sched.tick();
    await Promise.allSettled([...jobs]);
    assert.equal(store.getTimer(pTimer.id).lastRunStatus, 'ok');
    const msgs = store.conversation.history(undefined, 10).items;
    assert.equal(msgs.length, 2);
    assert.equal(msgs[1]!.text.length, 65_536);

    const aiTimer = sched.addTimer('fast-ai-timer', 'run fast', 60_000);
    store.saveTimer({ ...aiTimer, nextRunAt: Date.now() - 10 });
    sched.tick();
    await delay(20);
    assert.equal(store.getTimer(aiTimer.id).activeTaskId, undefined, 'completed task must not resurrect activeTaskId');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('server.close() settles promptly after in-flight requests complete instead of holding a 5s timer', { timeout: 5_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'audit-srv-close-'));
  const home = await privateHome(join(root, 'h'));
  const svc = await serve({ home, mode: 'offline' });
  try {
    const start = Date.now();
    await svc.close();
    assert.ok(Date.now() - start < 2_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

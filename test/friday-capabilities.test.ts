import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { realFactory, offlineFactory, type AgentFactory } from '../src/agent.js';
import { Coordinator } from '../dist/coordinator.js';
import { serve } from '../dist/server.js';
import { Watchdog } from '../dist/watchdog.js';

async function until(predicate: () => boolean, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for condition');
}

test('Step 1: realFactory supports custom baseUrl and separate router/worker models', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-baseurl-'));
  try {
    await assert.rejects(
      realFactory(home, { provider: 'custom', model: 'deepseek-chat', apiKey: 'k', baseUrl: 'ftp://invalid' }),
      /http or https/,
    );
    const factory = await realFactory(home, {
      provider: 'deepseek-custom',
      model: 'deepseek-chat',
      routerModel: 'deepseek-chat',
      workerModel: 'deepseek-reasoner',
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    const router = await factory.create('router', 'router-custom', [{
      name: 'dispatch_worker', description: 'Dispatch', execute: async () => 'ok',
    }]);
    const worker = await factory.create('worker', 'worker-custom', [{
      name: 'start_read', description: 'Read', execute: async () => 'ok',
    }]);
    assert.ok(router.sessionFile);
    assert.ok(worker.sessionFile);
    router.close();
    worker.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Step 2: paused task can be explicitly resumed via Coordinator.resume and Router resume_work', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-resume-'));
  const coordinator = new Coordinator(home, { ...offlineFactory(30), nativeTools: true });
  try {
    await coordinator.ready();
    const task = await coordinator.submit('req-pause-1', 'long analysis', [], 100);
    coordinator.stop(task.id, '模拟休眠暂停', 'paused');
    await until(() => coordinator.store.get(task.id).status === 'paused' && !coordinator.store.operations(task.id).some(o => o.status === 'started'));
    // Wait for active run cleanup
    await delay(50);
    // Inject an unknown operation to verify resume acknowledges it cleanly
    coordinator.store.operation({ id: 'op-unk-1', taskId: task.id, revision: coordinator.store.get(task.id).revision, fileId: 'native:bash', status: 'unknown' });

    const resumed = coordinator.resume(task.id, 5000);
    assert.equal(resumed.status, 'running');
    assert.ok(resumed.limitMs >= 5000);
    assert.equal(coordinator.store.operationById('op-unk-1', task.id)?.status, 'cancelled');
    await until(() => coordinator.store.get(task.id).status === 'completed');
    assert.match(coordinator.store.get(task.id).report ?? '', /OFFLINE SIMULATION/);
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Step 3: concurrent native works in the same cwd report concurrentTaskIds', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-cwd-'));
  let firstTaskId = '';
  let secondResult: Record<string, unknown> = {};
  const factory: AgentFactory = {
    mode: 'offline', nativeTools: true,
    create: async (role, _id, tools) => ({
      close() {},
      async prompt(text) {
        if (role === 'worker') { await delay(120); return 'done'; }
        const event = JSON.parse(text) as { kind: string; message?: { id: string; text: string } };
        if (event.kind !== 'CHAT') return 'delivered';
        const start = tools.find(t => t.name === 'start_work')!;
        if (event.message!.text === 'first') {
          firstTaskId = (JSON.parse(await start.execute(JSON.stringify({ instruction: 'work 1', cwd: home }))) as { taskId: string }).taskId;
        } else {
          secondResult = JSON.parse(await start.execute(JSON.stringify({ instruction: 'work 2', cwd: home }))) as Record<string, unknown>;
        }
        return 'ok';
      },
    }),
  };
  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    coordinator.chat('c1', 'first');
    await until(() => Boolean(firstTaskId) && coordinator.store.get(firstTaskId).status === 'running');
    coordinator.chat('c2', 'second');
    await until(() => Boolean(secondResult.taskId));
    assert.deepEqual(secondResult.concurrentTaskIds, [firstTaskId]);
    const view = coordinator.view();
    const activeInView = view.works.find(w => w.id === firstTaskId);
    assert.ok(activeInView?.concurrentTaskIds?.includes(String(secondResult.taskId)));
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Step 4: persistent timers coalesce missed wake-up intervals and avoid overlapping runs', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-timer-'));
  const coordinator = new Coordinator(home, offlineFactory(40));
  try {
    await coordinator.ready();
    const timer = coordinator.addTimer('构建巡检', '检查构建状态', 1000, home);
    // Simulate machine wake-up after 3.5 seconds of sleep (3 missed intervals + current due)
    timer.nextRunAt = Date.now() - 3500;
    coordinator.store.saveTimer(timer);

    await until(() => {
      const updated = coordinator.store.getTimer(timer.id);
      return Boolean(updated.lastRunAt);
    });
    const afterWake = coordinator.store.getTimer(timer.id);
    assert.ok(afterWake.missedRuns >= 3, 'missed intervals are recorded and coalesced into one run');
    assert.ok(afterWake.nextRunAt > Date.now(), 'nextRunAt is scheduled into the future');

    // Wait for the triggered task to finish
    await until(() => {
      const tasks = coordinator.store.list();
      return tasks.length === 1 && tasks[0]!.status === 'completed';
    });
    assert.equal(coordinator.removeTimer(timer.id), true);
    assert.equal(coordinator.store.listTimers().length, 0);
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Step 5: Watchdog probes daemon health, recovers via controlled restart, and trips circuit breaker on persistent failure', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-watchdog-'));
  let daemon = await serve({ home, mode: 'offline', offlineDelayMs: 10 });
  try {
    let restarts = 0;
    const watchdog = new Watchdog({
      home,
      maxRetries: 2,
      backoffMs: 20,
      restartService: async () => {
        restarts++;
        if (restarts === 1) {
          daemon = await serve({ home, mode: 'offline', offlineDelayMs: 10 });
        } else {
          throw new Error('daemon binary unreachable');
        }
      },
    });

    // Healthy probe
    const healthy = await watchdog.checkOnce();
    assert.equal(healthy.status, 'healthy');

    // Stop daemon -> first check triggers controlled restart and recovers
    await daemon.close();
    const recovered = await watchdog.checkOnce();
    assert.equal(recovered.status, 'healthy');
    assert.equal(restarts, 1);

    // Stop daemon again -> subsequent restarts fail and trip circuit breaker
    await daemon.close();
    await watchdog.checkOnce(); // failure 1 (restart throws)
    const tripped = await watchdog.checkOnce(); // failure 2 >= maxRetries -> circuit_open
    assert.equal(tripped.status, 'circuit_open');

    // Verify durable notice was written to SQLite for independent clients
    const store = new (await import('../src/store.js')).Store(home);
    try {
      const notices = store.notices();
      assert.ok(notices.some(n => n.kind === 'watchdog_circuit_open'));
    } finally {
      store.close();
    }
  } finally {
    await daemon.close().catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});

test('Step 6: Dynamic Worker model tiering (fast/balanced/strong) from single OAuth or catalog and automatic complexity routing', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-model-tiers-'));
  try {
    // 1. Single OpenAI credential automatically populates fast/balanced/strong tiers from SDK catalog
    const real = await realFactory(home, { provider: 'openai', model: 'gpt-6.1-sol', routerModel: 'gpt-6.1-terra', apiKey: 'test-key' });
    assert.ok(real.modelTiers);
    assert.equal(real.modelTiers.router, 'gpt-6.1-terra', 'Router stays fixed on balanced/fast model');
    assert.equal(real.modelTiers.fast, 'gpt-6-luna', 'Fast tier maps to cheap/fast Luna model');
    assert.equal(real.modelTiers.balanced, 'gpt-6.1-terra', 'Balanced tier maps to Terra model');
    assert.equal(real.modelTiers.strong, 'gpt-6.1-sol', 'Strong tier maps to flagship Sol model');

    // DeepSeek maps all tiers (fast/balanced/strong) to deepseek-flash by default
    const ds = await realFactory(home, { provider: 'deepseek', apiKey: 'test-key' });
    assert.ok(ds.modelTiers);
    assert.equal(ds.modelTiers.router, 'deepseek-flash');
    assert.equal(ds.modelTiers.fast, 'deepseek-flash');
    assert.equal(ds.modelTiers.balanced, 'deepseek-flash');
    assert.equal(ds.modelTiers.strong, 'deepseek-flash');

    // Gemini (google / gemini alias) maps fast & balanced to gemini-3.8-flash, strong to gemini-4-argon
    const gemini = await realFactory(home, { provider: 'gemini', apiKey: 'test-key' });
    assert.ok(gemini.modelTiers);
    assert.equal(gemini.modelTiers.provider, 'google');
    assert.equal(gemini.modelTiers.router, 'gemini-3.8-flash');
    assert.equal(gemini.modelTiers.fast, 'gemini-3.8-flash');
    assert.equal(gemini.modelTiers.balanced, 'gemini-3.8-flash');
    assert.equal(gemini.modelTiers.strong, 'gemini-4-argon');

    // Cross-provider F.R.I.D.A.Y. on deepseek-flash while Workers use OpenAI tiers
    const hybrid = await realFactory(home, { provider: 'openai', model: 'gpt-6.1-sol', routerModel: 'deepseek-flash', apiKey: 'test-key' });
    assert.ok(hybrid.modelTiers);
    assert.equal(hybrid.modelTiers.router, 'deepseek-flash');
    assert.equal(hybrid.modelTiers.fast, 'gpt-6-luna');
    assert.equal(hybrid.modelTiers.balanced, 'gpt-6.1-terra');
    assert.equal(hybrid.modelTiers.strong, 'gpt-6.1-sol');

    // 2. End-to-end Coordinator routing with hybrid explicit tier + automatic complexity heuristic
    const observedWorkers: Array<{ instruction: string; tier?: string; model?: string }> = [];
    const baseOffline = offlineFactory(10);
    const factory: AgentFactory = {
      mode: 'offline',
      nativeTools: true,
      modelTiers: baseOffline.modelTiers,
      resolveWorkerModel: baseOffline.resolveWorkerModel,
      async create(role, _id, tools, options) {
        return {
          close() {},
          async prompt(text) {
            const event = JSON.parse(text) as Record<string, unknown>;
            if (role === 'worker') {
              observedWorkers.push({
                instruction: String(event.prompt ?? ''),
                tier: options?.tier,
                model: options?.model,
              });
              return 'done';
            }
            if (event.kind === 'CHAT') {
              const start = tools.find(t => t.name === 'start_work')!;
              const msg = event.message as { text: string };
              if (msg.text === 'dispatch-all') {
                // a) Simple task without explicit tier -> auto-selects fast
                await start.execute(JSON.stringify({ instruction: '查看状态并概括日志行数', cwd: home }));
                // b) Standard coding task without explicit tier -> auto-selects balanced
                await start.execute(JSON.stringify({ instruction: '为订单列表组件增加分页参数支持', profile: 'coding', cwd: home }));
                // c) Complex refactoring/security task without explicit tier -> auto-selects strong
                await start.execute(JSON.stringify({ instruction: '重构跨进程锁架构并深入排查并发死锁与安全漏洞', profile: 'coding', cwd: home }));
                // d) Explicit tier override from Router -> honors tier="fast" even for coding
                await start.execute(JSON.stringify({ instruction: '修改一行注释', profile: 'coding', tier: 'fast', cwd: home }));
              }
            }
            return 'ok';
          },
        };
      },
    };

    const coordinator = new Coordinator(home, factory);
    try {
      await coordinator.ready();
      coordinator.chat('req-tiers-1', 'dispatch-all');
      await until(() => coordinator.store.list().length === 4 && coordinator.store.list().every(t => t.status === 'completed'));

      assert.equal(observedWorkers.length, 4);
      const byPrompt = (substr: string) => observedWorkers.find(w => w.instruction.includes(substr))!;
      assert.deepEqual(
        { tier: byPrompt('查看状态').tier, model: byPrompt('查看状态').model },
        { tier: 'fast', model: 'gpt-6-luna' },
      );
      assert.deepEqual(
        { tier: byPrompt('分页参数').tier, model: byPrompt('分页参数').model },
        { tier: 'balanced', model: 'gpt-6.1-terra' },
      );
      assert.deepEqual(
        { tier: byPrompt('重构跨进程锁').tier, model: byPrompt('重构跨进程锁').model },
        { tier: 'strong', model: 'gpt-6.1-sol' },
      );
      assert.deepEqual(
        { tier: byPrompt('修改一行注释').tier, model: byPrompt('修改一行注释').model },
        { tier: 'fast', model: 'gpt-6-luna' },
      );
    } finally {
      await coordinator.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Step 7: Model Provider Hub manages credentials, hot-switches F.R.I.D.A.Y. & Worker tiers, and probes models', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-model-hub-'));
  const { createServer } = await import('node:http');
  let lastOpenCodeSessionHeader: string | undefined;
  const mockServer = createServer((req, res) => {
    if (req.url?.includes('/opencode-go/')) {
      const sessionHeader = req.headers['x-opencode-session'];
      lastOpenCodeSessionHeader = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
      if (!lastOpenCodeSessionHeader) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'MissingSessionID', message: 'Request is missing x-opencode-session' }));
        return;
      }
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'F.R.I.D.A.Y. 探针链路正常 (deepseek-flash)' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => mockServer.listen(0, '127.0.0.1', resolve));
  const port = (mockServer.address() as { port: number }).port;
  const coordinator = new Coordinator(home, offlineFactory(10));
  try {
    await coordinator.ready();
    const initialHub = await coordinator.modelHub.getView();
    assert.ok(initialHub.providers.some(p => p.id === 'deepseek'));
    assert.ok(initialHub.providers.some(p => p.id === 'openai'));
    assert.ok(initialHub.providers.some(p => p.id === 'google'));

    // Configure DeepSeek with mock gateway + API key, set F.R.I.D.A.Y. to deepseek/deepseek-flash, and Worker provider to google
    const updatedHub = await coordinator.configureModels({
      providerId: 'deepseek',
      apiKey: 'sk-deepseek-secret-9988',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      routerModel: 'deepseek/deepseek-flash',
      workerProvider: 'google',
    });
    assert.equal(updatedHub.routerProvider, 'deepseek');
    assert.equal(updatedHub.routerModel, 'deepseek-flash');
    assert.equal(updatedHub.workerProvider, 'google');
    assert.equal(updatedHub.tiers.fast, 'gemini-3.8-flash');
    assert.equal(updatedHub.tiers.balanced, 'gemini-3.8-flash');
    assert.equal(updatedHub.tiers.strong, 'gemini-4-argon');

    const dsProvider = updatedHub.providers.find(p => p.id === 'deepseek')!;
    assert.equal(dsProvider.configured, true);
    assert.equal(dsProvider.keyHint, 'sk-d…9988', 'API key is masked in view and never returned in plaintext');

    // Probe DeepSeek model against the local mock SSE endpoint
    const probeRes = await coordinator.modelHub.probe({ model: 'deepseek/deepseek-flash' });
    assert.equal(probeRes.ok, true);
    assert.equal(probeRes.provider, 'deepseek');
    assert.equal(probeRes.model, 'deepseek-flash');
    assert.equal(probeRes.mode, 'real');
    assert.equal(probeRes.supportsImages, true);
    assert.match(probeRes.reply ?? '', /探针链路正常/);

    // Probe OpenCode Go model and verify x-opencode-session header is sent
    const openCodeProbe = await coordinator.modelHub.probe({
      provider: 'opencode-go',
      model: 'deepseek-v4.1-flash',
      apiKey: 'oc_sk_test',
      baseUrl: `http://127.0.0.1:${port}/opencode-go/v1`,
    });
    assert.equal(openCodeProbe.ok, true);
    assert.equal(openCodeProbe.provider, 'opencode-go');
    assert.equal(openCodeProbe.model, 'deepseek-v4.1-flash');
    assert.equal(openCodeProbe.supportsImages, true);
    assert.ok(lastOpenCodeSessionHeader && lastOpenCodeSessionHeader.length > 0, 'x-opencode-session header is attached to OpenCode Go probes');

    // Configure multiple providers (e.g. anthropic & google & dashscope) and verify cross-provider dynamic selection
    await coordinator.configureModels({ providerId: 'anthropic', apiKey: 'sk-ant-test' });
    await coordinator.configureModels({ providerId: 'google', apiKey: 'sk-goog-test' });
    const multiHub = await coordinator.configureModels({ providerId: 'dashscope', apiKey: 'sk-qwen-test' });
    assert.ok((multiHub.modelPool?.length ?? 0) >= 6, 'multi-provider pool aggregates models across all configured providers');

    // Fast inspection picks a fast model across the pool
    const fastPick = coordinator.modelHub.selectWorkerModel({ instruction: '查看状态', isTimer: true });
    assert.equal(fastPick.tier, 'fast');
    assert.match(fastPick.model, /\//, 'multi-provider selection returns qualified provider/model spec');

    // Deep refactoring/review picks a strong reasoning/coding model across the pool
    const strongPick = coordinator.modelHub.selectWorkerModel({
      instruction: '重构核心架构并审计并发死锁与安全漏洞',
      profile: 'review',
    });
    assert.equal(strongPick.tier, 'strong');
    assert.match(strongPick.model, /\//);
  } finally {
    await coordinator.close();
    mockServer.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Step 8: dailyAt plugin timer with task-side delivery channel and fund-tracker plugin execution', async () => {
  process.env.FUND_TRACKER_OFFLINE = '1';
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-fund-plugin-'));
  const coordinator = new Coordinator(home, offlineFactory(20));
  try {
    await coordinator.ready();
    const { listPlugins, runPlugin } = await import('../dist/plugin.js');
    const plugins = await listPlugins(home);
    assert.ok(plugins.some(p => p.name === 'fund-tracker'), 'fund-tracker plugin is discovered');

    // Run status action in offline mode and verify the 7 holdings and 29,020 total cost
    const statusRes = await runPlugin(home, 'fund-tracker', 'status', { offline: true, force: true });
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.notify, true);
    const summary = statusRes.data as { totalCost: number; holdings: Array<{ code: string; cost: number }> };
    assert.equal(summary.totalCost, 29020);
    assert.equal(summary.holdings.length, 7);
    assert.equal(summary.holdings.find(h => h.code === '018168')?.cost, 720);

    // Configure an IM channel and a task-side delivery timer at 12:00 and 21:30
    coordinator.im.saveChannel({
      id: 'wx-fund',
      platform: 'wechat',
      name: '微信基金通知',
      accountId: 'bot-1',
      defaultTarget: 'boss-wx-id',
      enabled: true,
    });
    const delivered: Array<{ channelId: string; text: string; target?: string }> = [];
    coordinator.im.sendToChannel = async (channelId, text, options) => {
      delivered.push({ channelId, text, target: options?.target });
    };

    const noonTimer = coordinator.addTimer(
      '基金午间持仓估值',
      '每日12:00计算持仓盘中估值并通知',
      60_000,
      home,
      undefined,
      {
        dailyAt: '12:00',
        plugin: 'fund-tracker',
        pluginAction: 'status',
        deliverChannelId: 'wx-fund',
        deliverTarget: 'boss-wx-id',
      },
    );
    assert.equal(noonTimer.dailyAt, '12:00');
    assert.equal(noonTimer.plugin, 'fund-tracker');
    assert.equal(noonTimer.deliverChannelId, 'wx-fund');

    // Force timer due now and verify direct plugin execution + IM delivery without spawning Worker Tasks
    noonTimer.nextRunAt = Date.now() - 1000;
    coordinator.store.saveTimer(noonTimer);

    await until(() => delivered.length >= 1, 400);
    assert.equal(delivered[0]!.channelId, 'wx-fund');
    assert.equal(delivered[0]!.target, 'boss-wx-id');
    assert.match(delivered[0]!.text, /29020\.00/);
    assert.equal(coordinator.store.list().length, 0, 'plugin timer executes directly without spawning an LLM Worker task');
  } finally {
    delete process.env.FUND_TRACKER_OFFLINE;
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

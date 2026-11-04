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

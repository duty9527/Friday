import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../src/coordinator.js';
import { BoundedCounterMap, BoundedFingerprintMap } from '../src/orchestrator/chat-coalescer.js';
import { privateHome } from '../src/files.js';
import { abortableDelay, offlineFactory, type AgentFactory } from '../src/agent.js';
import { until } from './helpers/async.js';

test('time spent waiting for the shared Router report queue does not consume active execution budget', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-time-'));
  const home = await privateHome(join(root, 'h'));
  const file = join(root, 'input.txt'); await writeFile(file, 'bounded input');
  let routes = 0;
  const factory: AgentFactory = {
    mode: 'offline',
    async create(role, _id, tools) {
      let read = false;
      return {
        async prompt(text, signal) {
          if (role === 'router') {
            const event = JSON.parse(text);
            if (event.kind === 'NEW_TASK') {
              if (++routes === 2) await abortableDelay(600, signal);
              await tools[0]!.execute('dispatch');
              return 'Dispatched';
            }
            return 'Delivered report';
          }
          if (!read) { read = true; await tools[0]!.execute('f0'); return 'Read accepted'; }
          await abortableDelay(20, signal);
          return 'Grounded analysis';
        },
        close() {},
      };
    },
  };
  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    const began = Date.now();
    const first = await coordinator.submit(randomUUID(), 'first analysis', [file], 200);
    await coordinator.submit(randomUUID(), 'second analysis', [file], 2000);
    const deadline = Date.now() + 5000;
    while (coordinator.store.get(first.id).status === 'queued' || coordinator.store.get(first.id).status === 'running') {
      if (Date.now() > deadline) throw new Error('Report queue did not drain');
      await delay(10);
    }
    const result = coordinator.store.get(first.id);
    assert.equal(result.status, 'completed');
    assert.ok(Date.now() - began >= 550);
    assert.ok(result.activeMs > 0 && result.activeMs < 200);
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }); }
});

test('chat coalesce wait > 1500ms resets ChatRun clock and avoids false heartbeat gap abort', { timeout: 15_000 }, async () => {
  const prevTextCoalesce = process.env.FRIDAY_IM_COALESCE_MS;
  const prevAttCoalesce = process.env.FRIDAY_IM_ATTACHMENT_COALESCE_MS;
  process.env.FRIDAY_IM_COALESCE_MS = '650';
  process.env.FRIDAY_IM_ATTACHMENT_COALESCE_MS = '650';
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-coalesce-clock-'));
  const home = await privateHome(join(root, 'h'));
  const observedPrompts: string[] = [];
  const factory: AgentFactory = {
    mode: 'offline',
    async create(role) {
      return {
        close() {},
        async prompt(text) {
          if (role === 'router') {
            const event = JSON.parse(text) as { message?: { text?: string } };
            observedPrompts.push(event.message?.text ?? '');
            return '合并处理完成';
          }
          return 'ok';
        },
      };
    },
  };
  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    const origin = { channel: 'wechat', channelId: 'wx-1', conversationId: 'conv-1', senderId: 'user-1' } as const;
    const first = coordinator.chat(randomUUID(), '第一句', [], origin);
    await delay(500);
    coordinator.chat(randomUUID(), '第二句', [], origin);
    await delay(500);
    coordinator.chat(randomUUID(), '第三句', [], origin);
    // Total coalesce span > 1500ms across multiple 200ms ticks; resetChatContextClock must prevent Clock/heartbeat gap abort.
    await delay(550);
    await until(() => coordinator.store.conversation.allMessages().some(m => m.replyTo === first.id && m.status === 'completed'), 400);
    const reply = coordinator.store.conversation.allMessages().find(m => m.replyTo === first.id)!;
    assert.equal(reply.status, 'completed');
    assert.equal(reply.text, '合并处理完成');
    assert.equal(observedPrompts.length, 1);
    assert.match(observedPrompts[0]!, /第一句[\s\S]*第二句[\s\S]*第三句/);
  } finally {
    if (prevTextCoalesce === undefined) delete process.env.FRIDAY_IM_COALESCE_MS; else process.env.FRIDAY_IM_COALESCE_MS = prevTextCoalesce;
    if (prevAttCoalesce === undefined) delete process.env.FRIDAY_IM_ATTACHMENT_COALESCE_MS; else process.env.FRIDAY_IM_ATTACHMENT_COALESCE_MS = prevAttCoalesce;
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('periodic timer clamps tiny intervalMs, fast-forwards overdue nextRunAt strictly past now, and blocks overlapping plugin runs', { timeout: 15_000 }, async () => {
  const { readFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-timer-spin-'));
  const home = await privateHome(join(root, 'h'));
  const pluginDir = join(home, 'plugins', 'slow-probe');
  const hitsLog = join(home, 'slow-probe-hits.log');
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({
    name: 'slow-probe',
    title: 'Slow Probe',
    entry: 'index.mjs',
    actions: ['ping'],
  }));
  await writeFile(join(pluginDir, 'index.mjs'), `
    import { appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(hitsLog)}, 'start\\n');
    await new Promise(r => setTimeout(r, 700));
    appendFileSync(${JSON.stringify(hitsLog)}, 'end\\n');
    process.stdout.write(JSON.stringify({ ok: true, notify: false, title: 'ok', message: 'ok' }) + '\\n');
  `);
  const coordinator = new Coordinator(home, offlineFactory(10));
  try {
    await coordinator.ready();
    const timer = coordinator.addTimer('高频防抖测试', 'ping', 10, home, undefined, { plugin: 'slow-probe', pluginAction: 'ping' });
    assert.ok(timer.intervalMs >= 500, `intervalMs (${timer.intervalMs}) is clamped to >= 500ms`);

    // Make timer 12 seconds (24 intervals) overdue so tick() must fast-forward nextRunAt > now instead of catch-up looping.
    timer.nextRunAt = Date.now() - 12_000;
    coordinator.store.saveTimer(timer);

    await until(() => {
      try { return coordinator.store.listTimers()[0]!.missedRuns > 0; } catch { return false; }
    }, 200);
    const updated = coordinator.store.listTimers().find(t => t.id === timer.id)!;
    assert.ok(updated.missedRuns >= 20, 'overdue intervals accumulated into missedRuns');
    assert.ok(updated.nextRunAt > Date.now() - 100, 'nextRunAt fast-forwarded past now instead of looping 0ms catch-up');

    // While first 700ms plugin run crosses the next 500ms interval, overlap guard prevents a concurrent second start.
    await delay(550);
    const midLog = await readFile(hitsLog, 'utf8');
    const startsMid = midLog.split('\n').filter(line => line === 'start').length;
    assert.equal(startsMid, 1, 'overlapping tick while plugin timer is running must not start a second concurrent run');
    await until(async () => {
      try {
        const text = await readFile(hitsLog, 'utf8');
        return text.split('\n').filter(line => line === 'end').length >= 1;
      } catch {
        return false;
      }
    }, 200);
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('BoundedCounterMap enforces TTL expiry and BoundedFingerprintMap evicts least-recently-used key', () => {
  const counters = new BoundedCounterMap(2, 50);
  assert.equal(counters.increment('a', 100), 1);
  assert.equal(counters.increment('b', 110), 1);
  assert.equal(counters.increment('c', 120), 1);
  assert.equal(counters.get('a', 125), 0);
  assert.equal(counters.get('b', 125), 1);
  assert.equal(counters.get('c', 125), 1);
  assert.equal(counters.get('b', 200), 0);

  const lru = new BoundedFingerprintMap<string>(2);
  lru.set('k1', 'v1');
  lru.set('k2', 'v2');
  assert.equal(lru.get('k1'), 'v1');
  lru.set('k3', 'v3');
  assert.equal(lru.get('k2'), undefined);
  assert.equal(lru.get('k1'), 'v1');
  assert.equal(lru.get('k3'), 'v3');
});

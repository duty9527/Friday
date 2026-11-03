import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../dist/coordinator.js';
import { privateHome } from '../src/files.js';
import { abortableDelay, type AgentFactory } from '../src/agent.js';

async function fixture(read: boolean | 'throw' | 'short' = true) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-cancel-'));
  const home = await privateHome(join(root, 'h'));
  const file = join(root, 'file.txt'); await writeFile(file, 'read me');
  const factory: AgentFactory = {
    mode: 'offline',
    async create(role, _id, tools) {
      let issued = false;
      return {
        async prompt(_text, signal) {
          if (role === 'router') {
            if (JSON.parse(_text).kind === 'NEW_TASK') await tools[0]!.execute('dispatch');
            return 'Router delivery';
          }
          if (!read) return 'An ungrounded report without reading inputs';
          if (read === 'short') {
            if (!issued) { issued = true; await tools[0]!.execute('f0'); return 'Read pending'; }
            await abortableDelay(120, signal); return 'Finished analysis';
          }
          await tools[0]!.execute('f0');
          if (read === 'throw') throw new Error('Fixture model stream failed after accepting a background read');
          await abortableDelay(60_000, signal);
          return 'must not be delivered after cancellation';
        },
        close() {},
      };
    },
  };
  const coordinator = new Coordinator(home, factory);
  await coordinator.ready();
  return { root, file, coordinator, pid: coordinator.health().executorPid! };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition timed out');
    await delay(10);
  }
}

test('cancellation remains pending while executor acknowledgement is suspended, and late read results cannot reactivate the task', { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    process.kill(f.pid, 'SIGSTOP');
    const task = await f.coordinator.submit(randomUUID(), 'analyze', [f.file], 600_000);
    await until(() => f.coordinator.store.operations(task.id).length === 1);
    f.coordinator.stop(task.id);
    await delay(100);
    assert.equal(f.coordinator.store.get(task.id).status, 'paused');
    assert.equal(f.coordinator.store.operations(task.id)[0]?.status, 'cancel_requested');
    process.kill(f.pid, 'SIGCONT');
    await until(() => f.coordinator.store.get(task.id).status === 'cancelled');
    assert.ok(f.coordinator.store.operations(task.id).every(op => ['succeeded', 'failed', 'cancelled'].includes(op.status)));
    assert.equal(f.coordinator.store.get(task.id).report, undefined);
  } finally {
    try { process.kill(f.pid, 'SIGCONT'); } catch {}
    await f.coordinator.close(); await rm(f.root, { recursive: true, force: true });
  }
});

test('executor death during cancellation preserves unknown operations and paused status', { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    process.kill(f.pid, 'SIGSTOP');
    const task = await f.coordinator.submit(randomUUID(), 'analyze', [f.file], 600_000);
    await until(() => f.coordinator.store.operations(task.id).length === 1);
    f.coordinator.stop(task.id);
    process.kill(f.pid, 'SIGKILL');
    await until(() => f.coordinator.store.operations(task.id)[0]?.status === 'unknown');
    await delay(50);
    assert.equal(f.coordinator.store.get(task.id).status, 'paused');
    assert.match(f.coordinator.store.get(task.id).reason!, /无法确认操作结算/);
    assert.equal(f.coordinator.stop(task.id).status, 'paused');
  } finally { await f.coordinator.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('model failure after accepting a read waits for acknowledgement before a failed terminal state', { timeout: 10_000 }, async () => {
  const f = await fixture('throw');
  try {
    process.kill(f.pid, 'SIGSTOP');
    const task = await f.coordinator.submit(randomUUID(), 'analyze', [f.file], 600_000);
    await until(() => f.coordinator.store.operations(task.id).length === 1);
    await delay(100);
    assert.equal(f.coordinator.store.get(task.id).status, 'paused');
    assert.equal(f.coordinator.store.operations(task.id)[0]?.status, 'cancel_requested');
    process.kill(f.pid, 'SIGCONT');
    await until(() => f.coordinator.store.get(task.id).status === 'failed');
    assert.ok(f.coordinator.store.operations(task.id).every(op => ['succeeded', 'failed', 'cancelled'].includes(op.status)));
  } finally {
    try { process.kill(f.pid, 'SIGCONT'); } catch {}
    await f.coordinator.close(); await rm(f.root, { recursive: true, force: true });
  }
});

test('model failure followed by executor death leaves unknown work paused, not terminal failed', { timeout: 10_000 }, async () => {
  const f = await fixture('throw');
  try {
    process.kill(f.pid, 'SIGSTOP');
    const task = await f.coordinator.submit(randomUUID(), 'analyze', [f.file], 600_000);
    await until(() => f.coordinator.store.operations(task.id)[0]?.status === 'cancel_requested');
    assert.equal(f.coordinator.store.get(task.id).status, 'paused');
    process.kill(f.pid, 'SIGKILL');
    await until(() => f.coordinator.store.operations(task.id)[0]?.status === 'unknown');
    await delay(50);
    assert.equal(f.coordinator.store.get(task.id).status, 'paused');
    assert.match(f.coordinator.store.get(task.id).reason!, /无法确认操作结算/);
    assert.equal(f.coordinator.stop(task.id).status, 'paused');
  } finally { await f.coordinator.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('result delivery rechecks the execution limit even before the first periodic checkpoint', async () => {
  const f = await fixture('short');
  try {
    const task = await f.coordinator.submit(randomUUID(), 'analyze', [f.file], 100);
    await until(() => ['paused', 'completed'].includes(f.coordinator.store.get(task.id).status));
    const result = f.coordinator.store.get(task.id);
    assert.equal(result.status, 'paused');
    assert.ok(result.activeMs >= 100);
    assert.equal(result.report, undefined);
  } finally { await f.coordinator.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('a model that skips required file reads cannot publish a successful report', async () => {
  const f = await fixture(false);
  try {
    const task = await f.coordinator.submit(randomUUID(), 'analyze', [f.file], 600_000);
    await until(() => f.coordinator.store.get(task.id).status === 'paused');
    assert.match(f.coordinator.store.get(task.id).reason!, /未读取全部明确提供的输入/);
    assert.equal(f.coordinator.store.get(task.id).report, undefined);
  } finally { await f.coordinator.close(); await rm(f.root, { recursive: true, force: true }); }
});

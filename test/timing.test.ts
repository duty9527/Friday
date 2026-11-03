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

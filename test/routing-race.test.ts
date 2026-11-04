import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../dist/coordinator.js';
import type { AgentFactory } from '../src/agent.js';

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  throw new Error('fixture timed out');
}

test('a supplement rejected after a concurrent stop still identifies its named target among two works', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-route-race-'));
  const ids: string[] = [];
  let coordinator: Coordinator;
  const factory: AgentFactory = { mode: 'offline', nativeTools: true, create: async (role, _id, tools) => ({
    close() {}, async prompt(text, signal) {
      if (role === 'worker') { await delay(10_000, undefined, { signal }); return 'report'; }
      const input = JSON.parse(text);
      const call = (name: string, args: unknown) => tools.find(tool => tool.name === name)!.execute(JSON.stringify(args));
      if (input.message?.text === 'create two') {
        for (const instruction of ['artex 架构对比', '登录测试']) ids.push(JSON.parse(await call('start_work', { instruction, cwd: home })).taskId);
      } else if (input.message?.text === 'supplement artex') {
        coordinator.stop(ids[0]!);
        await assert.rejects(call('continue_work', { taskId: ids[0], instruction: '补充恢复机制' }), /changed or was stopped/i);
      }
      return 'Router reply';
    },
  }) };
  coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready(); const first = coordinator.chat('first', 'create two');
    await until(() => coordinator.store.conversation.get(first.id).status === 'completed');
    assert.ok(coordinator.store.list().every(work => work.status === 'running'));
    const second = coordinator.chat('second', 'supplement artex');
    await until(() => coordinator.store.conversation.get(second.id).status === 'completed');
    const routing = coordinator.store.conversation.get(second.id).routing!;
    assert.equal(routing.context.works.length, 2);
    assert.ok(routing.context.works.every(work => work.status === 'running'));
    assert.equal(routing.actions[0]!.status, 'failed');
    assert.equal(routing.actions[0]!.taskId, ids[0]);
    assert.equal(routing.actions[0]!.taskLabel, 'artex 架构对比', 'the failed action must still name its attempted target');
    assert.equal(coordinator.store.list().length, 2);
  } finally { await coordinator.close(); await rm(home, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../dist/coordinator.js';
import { timelineSteps } from '../src/web/model.js';
import type { AgentFactory } from '../src/agent.js';

async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  throw new Error('fixture timed out');
}

test('a round shows its own routing decision; a later follow-up does not leak into the earlier round', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-scope-'));
  let workId = '';
  const factory: AgentFactory = { mode: 'offline', nativeTools: true, create: async (role, _id, tools) => ({
    close() {}, async prompt(text) {
      if (role === 'worker') { await delay(50); return 'worker report'; }
      const event = JSON.parse(text) as { kind: string; message?: { text: string } };
      if (event.kind !== 'CHAT') return 'delivered';
      const call = (name: string, args: unknown) => tools.find(tool => tool.name === name)!.execute(JSON.stringify(args));
      if (event.message!.text === 'create') workId = JSON.parse(await call('start_work', { instruction: 'work', cwd: home })).taskId;
      else await call('continue_work', { taskId: workId, instruction: 'also analyze recovery' });
      return 'Router reply';
    },
  }) };
  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    const first = coordinator.chat('first', 'create');
    await until(() => coordinator.store.conversation.get(first.id).status === 'completed' && Boolean(workId));
    await until(() => coordinator.store.get(workId).status === 'running');
    const second = coordinator.chat('second', 'continue');
    await until(() => {
      const delivery = coordinator.store.conversation.get(second.id).routing?.actions[0]?.delivery;
      return delivery === 'done' || delivery === 'failed';
    });

    const firstSteps = timelineSteps(coordinator.store.conversation.trace({ messageId: first.id }));
    assert.equal(firstSteps[0]!.title, 'Router 处理新输入', 'the round reads from its own Router turn');
    assert.equal(firstSteps[1]!.title, '新建工作');
    assert.ok(firstSteps.some(step => step.title === 'Worker 接收任务'), 'the work it created stays part of the round');
    assert.ok(!firstSteps.some(step => step.title === '补充已有工作（未新建）'),
      'a later message\'s routing decision never appears inside an earlier round');

    const secondSteps = timelineSteps(coordinator.store.conversation.trace({ messageId: second.id }));
    assert.equal(secondSteps[0]!.title, 'Router 处理新输入');
    assert.ok(secondSteps.some(step => step.title === '补充已有工作（未新建）'), 'the follow-up round shows its own decision');
    assert.ok(secondSteps.some(step => step.title === '处理补充要求'), 'and the recorded delivery state');
    assert.ok(!secondSteps.some(step => step.title === '新建工作'), 'it did not create a second work');
  } finally { await coordinator.close(); await rm(home, { recursive: true, force: true }); }
});

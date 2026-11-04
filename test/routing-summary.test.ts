import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../dist/coordinator.js';
import type { AgentFactory } from '../src/agent.js';

async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await delay(10); }
  throw new Error('fixture timed out');
}

test('a malformed public summary never blocks the dispatch the user asked for', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-summary-'));
  const cases: Array<[string, unknown]> = [
    ['too long', 'x'.repeat(400)], ['empty', ''], ['wrong type', 42], ['blank', '   '],
  ];
  const factory: AgentFactory = { mode: 'offline', nativeTools: true, create: async (role, _id, tools) => ({
    close() {}, async prompt(text) {
      if (role === 'worker') return 'report';
      const event = JSON.parse(text) as { kind: string; message?: { text: string } };
      if (event.kind !== 'CHAT') return 'delivered';
      const label = event.message!.text.replace(/^dispatch /, '');
      const summary = cases.find(([name]) => name === label)?.[1] ?? '按路径新建执行';
      const result = await tools.find(tool => tool.name === 'start_work')!.execute(JSON.stringify({
        instruction: `work for ${label}`, cwd: home, summary,
      }));
      return JSON.parse(result).taskId as string;
    },
  }) };
  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    for (const [label, summary] of cases) {
      const message = coordinator.chat(`req-${label}`, `dispatch ${label}`);
      await until(() => coordinator.store.conversation.get(message.id).status === 'completed');
      const action = coordinator.store.conversation.get(message.id).routing!.actions[0]!;
      assert.equal(action.kind, 'new_work');
      assert.equal(action.status, 'accepted', `${label}: the action is accepted, not failed`);
      assert.ok(action.taskId, `${label}: a work was actually created`);
      assert.equal(coordinator.store.get(action.taskId!).prompt, `work for ${label}`);
      if (summary === 'x'.repeat(400)) {
        assert.equal(action.summary?.length, 240, 'an over-long note is kept, truncated, and never blocks the action');
      } else {
        assert.equal(action.summary, undefined, `${label}: an unusable summary is dropped, not invented`);
      }
    }
    assert.equal(coordinator.store.list().length, cases.length);
    const usable = coordinator.chat('req-usable', 'dispatch usable');
    await until(() => Boolean(coordinator.store.list().find(work => work.prompt === 'work for usable')?.id));
    await until(() => coordinator.store.conversation.get(usable.id).status === 'completed');
    const kept = coordinator.store.conversation.get(usable.id).routing!.actions[0]!;
    assert.equal(kept.kind, 'new_work');
  } finally { await coordinator.close(); await rm(home, { recursive: true, force: true }); }
});

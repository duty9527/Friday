import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../dist/coordinator.js';
import { Store } from '../src/store.js';
import type { AgentFactory } from '../src/agent.js';

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(10); }
  throw new Error('routing fixture timed out');
}

test('routing records new work, a targeted follow-up among two running works, queries, failures and direct replies', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-route-'));
  const gates: Array<() => void> = [];
  let a = ''; let b = '';
  const factory: AgentFactory = { mode: 'offline', nativeTools: true, create: async (role, _id, tools) => {
    let first = true;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (role === 'worker') gates.push(release);
    return { close() {}, async prompt(text) {
      const event = JSON.parse(text);
      if (role === 'worker') { if (first) { first = false; await gate; } return 'worker evidence'; }
      if (event.kind !== 'CHAT') return 'new independent result';
      const call = async (name: string, args: unknown) => JSON.parse(await tools.find(tool => tool.name === name)!.execute(JSON.stringify(args)));
      if (event.message.text === 'A' || event.message.text === 'B') {
        const work = await call('start_work', { instruction: event.message.text, cwd: home, summary: '独立工作' });
        if (event.message.text === 'A') a = work.taskId; else b = work.taskId;
      } else if (event.message.text === 'supplement A and query B') {
        await call('continue_work', { taskId: a, instruction: 'add recovery analysis', summary: '补充当前 A 工作' });
        await call('inspect_work', { taskId: b });
      } else if (event.message.text === 'bad dispatch') {
        await assert.rejects(call('start_work', { instruction: 'bad', cwd: '/this-directory-does-not-exist-super-agent' }));
      }
      return 'Router response';
    } };
  } };
  const coordinator = new Coordinator(home, factory);
  let followupMessage = '';
  try {
    await coordinator.ready();
    const first = coordinator.chat('a', 'A');
    await until(() => Boolean(a));
    const second = coordinator.chat('b', 'B');
    await until(() => Boolean(b));
    await until(() => coordinator.store.conversation.get(second.id).status === 'completed');
    assert.equal(coordinator.store.conversation.get(first.id).routing?.actions[0]?.kind, 'new_work');
    const followup = coordinator.chat('f', 'supplement A and query B'); followupMessage = followup.id;
    await until(() => coordinator.store.conversation.get(followup.id).status === 'completed');
    const record = coordinator.store.conversation.get(followup.id).routing!;
    assert.equal(record.context.works.length, 2);
    assert.ok(record.context.works.every(work => work.status === 'running'));
    assert.deepEqual(record.actions.map(action => action.kind), ['followup', 'inspect']);
    assert.equal(record.actions[0]!.taskId, a);
    assert.equal(record.actions[1]!.taskId, b);
    assert.equal(record.actions[0]!.delivery, 'pending', 'acceptance is not Worker completion');
    assert.equal(record.actions[0]!.summary, '补充当前 A 工作');
    assert.equal(coordinator.store.list().length, 2, 'the supplement must not create a third task');
    const bad = coordinator.chat('bad', 'bad dispatch');
    await until(() => coordinator.store.conversation.get(bad.id).status === 'completed');
    assert.equal(coordinator.store.conversation.get(bad.id).routing?.actions[0]?.status, 'failed');
    const direct = coordinator.chat('direct', 'hello');
    await until(() => coordinator.store.conversation.get(direct.id).status === 'completed');
    assert.equal(coordinator.store.conversation.get(direct.id).routing?.actions[0]?.kind, 'reply');
    gates.forEach(release => release());
    await until(() => coordinator.store.get(a).status === 'completed' && coordinator.store.get(b).status === 'completed');
    const updated = coordinator.store.conversation.get(followup.id);
    assert.equal(updated.routing?.actions[0]?.delivery, 'done');
    assert.deepEqual(updated.routing?.context, record.context, 'routing-time context must not turn into current task state');
    const result = coordinator.store.conversation.history(undefined, 40).items.find(message => message.text === 'new independent result' && message.taskIds.includes(a));
    assert.ok(result && result.seq > direct.seq, 'late result is a newly inserted message');
    await coordinator.close();
    const reopened = new Store(home);
    try { assert.deepEqual(reopened.conversation.get(followupMessage).routing, updated.routing); }
    finally { reopened.close(); }
  } finally { gates.forEach(release => release()); await coordinator.close(); await rm(home, { recursive: true, force: true }); }
});

test('a later delivery after an intervening follow-up gets a new reply ID instead of overwriting a previous delivery', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-delivery-'));
  let coordinator: Coordinator;
  let deliveries = 0;
  const factory: AgentFactory = { mode: 'offline', nativeTools: true, create: async (role, _id, tools) => ({ close() {}, async prompt(text) {
    const event = JSON.parse(text);
    if (role === 'worker') return 'worker report';
    if (event.kind === 'CHAT') { await tools.find(tool => tool.name === 'start_work')!.execute(JSON.stringify({ instruction: 'work', cwd: home })); return 'accepted'; }
    if (++deliveries === 1) { coordinator.followup(event.taskId, 'late-followup', 'more'); return 'first stage'; }
    return 'second stage';
  } }) };
  coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready(); const user = coordinator.chat('stage', 'work');
    await until(() => coordinator.store.list()[0]?.status === 'completed');
    const replies = coordinator.store.conversation.history(undefined, 20).items.filter(message => message.replyTo === user.id);
    const first = replies.find(message => message.text === 'first stage');
    const second = replies.find(message => message.text === 'second stage');
    assert.ok(first && second); assert.notEqual(first.id, second.id);
    assert.equal(first.status, 'completed'); assert.equal(second.status, 'completed');
    assert.ok(first.seq < second.seq);
  } finally { await coordinator.close(); await rm(home, { recursive: true, force: true }); }
});

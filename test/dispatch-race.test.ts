import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../dist/coordinator.js';
import { privateHome } from '../src/files.js';
import type { AgentFactory, AgentObservation } from '../src/agent.js';
import { PromptTrace } from '../src/trace.js';
import { abortableDelay } from '../src/agent.js';
import { Store } from '../src/store.js';

async function until(predicate: () => boolean | Promise<boolean>, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Condition timed out');
    await delay(10);
  }
}
const settledStatus = (task: Task) => ['completed', 'failed', 'cancelled'].includes(task.status);

test('Router cannot derive work from an active or paused source, so a stop can never be overtaken by a stale copy', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-race-'));
  const home = await privateHome(join(root, 'h'));
  const input = join(root, 'one.txt');
  await writeFile(input, 'first authorized input');
  let attempts = 0;
  const factory: AgentFactory = {
    mode: 'offline',
    async create(role, _id, tools, options) {
      return {
        async prompt(text, signal) {
          const event = JSON.parse(text) as { kind: string; message?: { text: string }; works?: Array<{ id: string }> };
          if (role === 'worker') {
            if (!readOnce) { readOnce = true; await tools.find(tool => tool.name === 'start_read')!.execute('f0'); }
            await abortableDelay(30_000, signal);
            return 'Worker report for the source work';
          }
          if (event.kind === 'NEW_TASK') {
            await tools.find(tool => tool.name === 'dispatch_worker')!.execute('dispatch');
            return 'Dispatched';
          }
          if (event.kind !== 'CHAT') return 'Router delivery';
          attempts++;
          const turn = randomUUID();
          const callId = randomUUID();
          options?.onEvent?.({ kind: 'turn_start', id: turn });
          options?.onEvent?.({ kind: 'tool_start', id: callId, parentId: turn, toolName: 'start_work', data: {} });
          try {
            await tools.find(tool => tool.name === 'start_work')!.execute(JSON.stringify({
              instruction: 'derived work from the active work', sourceTaskId: event.works![0]!.id,
            }), callId);
          } catch (error) {
            options?.onEvent?.({ kind: 'tool_end', id: callId, parentId: turn, toolName: 'start_work', error: true });
            throw error;
          }
          return 'related work created';
        },
        close() {},
      };
    },
  };
  let readOnce = false;
  const coordinator = new Coordinator(home, factory);
  await coordinator.ready();
  try {
    const source = await coordinator.submit(randomUUID(), 'source work', [input], 600_000);
    await until(() => coordinator.store.operations(source.id).length === 1);
    assert.equal(coordinator.store.get(source.id).status, 'running', 'the source is still active when the Router acts');
    const message = coordinator.chat(randomUUID(), '复用之前的文件继续分析', []);
    await until(async () => coordinator.store.conversation.get(message.id).status === 'failed');
    assert.equal(attempts, 1);
    assert.equal(coordinator.store.list().length, 1, 'no related execution was created from active work');
    assert.equal((await readdir(join(home, 'tasks'))).filter(id => id !== source.id).length, 0, 'no snapshot copy was started');
    const trace = coordinator.store.conversation.trace({ messageId: message.id });
    assert.ok(trace.some(event => event.label === 'start_work' && event.status === 'failed'), 'the refusal is visible in the trace');
    assert.match(JSON.stringify(trace), /still active: use continue_work/);
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a stale source revision is rejected at commit time, after snapshot work and before launch', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-commit-'));
  const home = await privateHome(join(root, 'h'));
  const input = join(root, 'one.txt');
  await writeFile(input, 'authorized input');
  const factory: AgentFactory = {
    mode: 'offline',
    async create(role) { return { async prompt() { return role === 'worker' ? 'report' : 'delivery'; }, close() {} }; },
  };
  const coordinator = new Coordinator(home, factory);
  await coordinator.ready();
  try {
    const source = await coordinator.submit(randomUUID(), 'source work', [input], 600_000);
    await until(() => settledStatus(coordinator.store.get(source.id)));
    const observed = coordinator.store.get(source.id);
    const message = coordinator.store.conversation.create({ id: randomUUID(), role: 'user', text: 'derive', status: 'processing', mode: 'offline', paths: [] });
    // The stop lands while the snapshot is being copied: revision and status move past what the Router saw.
    coordinator.store.transaction(() => {
      const current = coordinator.store.get(source.id);
      current.revision = observed.revision + 1;
      current.status = 'cancelled';
      coordinator.store.save(current);
    });
    await assert.rejects(coordinator.submit(randomUUID(), 'derived instruction', [], 600_000,
      { originMessageId: message.id, source: observed, signal: new AbortController().signal }), /changed or was stopped/);
    assert.equal(coordinator.store.list().length, 1, 'the stale dispatch created no task');
    assert.equal((await readdir(join(home, 'tasks'))).filter(id => id !== source.id).length, 0, 'copied inputs were removed');
    assert.equal(coordinator.store.conversation.get(message.id).taskIds.length, 0, 'no work was linked to the message');
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('SDK compaction and retry work appears in the execution trace without exposing summary text', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-compact-'));
  try {
    const store = new Store(home);
    const trace = new PromptTrace(store.conversation, { rootId: 'm1', messageId: 'm1', parentSpanId: 'm1' }, 'router', 'real');
    const sequence: AgentObservation[] = [
      { kind: 'turn_start', id: 'turn' },
      { kind: 'text_delta', id: 'turn', text: 'partial answer' },
      { kind: 'compaction_start', id: 'compact', parentId: 'turn', data: { reason: 'threshold' } },
      { kind: 'compaction_end', id: 'compact', parentId: 'turn', data: { reason: 'threshold', aborted: false, willRetry: false, tokensBefore: 90_000, estimatedTokensAfter: 12_000, usage: { input: 90_000, output: 800 } } },
      { kind: 'retry_start', id: 'retry', parentId: 'turn', error: true, data: { attempt: 1, maxAttempts: 3, delayMs: 500, error: 'overloaded' } },
      { kind: 'retry_end', id: 'retry', parentId: 'turn', data: { success: true } },
      { kind: 'tool_start', id: 'call1', parentId: 'turn', toolName: 'recall_messages', data: { beforeSeq: 12 } },
      { kind: 'tool_end', id: 'call1', parentId: 'turn', toolName: 'recall_messages', data: 'page' },
      { kind: 'turn_end', id: 'turn', data: { stopReason: 'stop', usage: { input: 1_200, output: 40 } } },
    ];
    await trace.run({
      async prompt() { for (const event of sequence) trace.observe(event); return 'delivered'; },
      close() {},
    }, JSON.stringify({ kind: 'CHAT' }), new AbortController().signal);
    const events = store.conversation.trace({ messageId: 'm1' });
    const compaction = events.filter(event => event.label === '上下文压缩（SDK）');
    assert.ok(compaction.some(event => event.status === 'started' && event.parentSpanId === `${trace.id}:turn`), 'compaction start is parented to its turn');
    const completed = compaction.find(event => event.status === 'completed');
    assert.ok(completed, 'compaction completion is recorded');
    assert.match(JSON.stringify(completed.data), /tokensBefore/);
    assert.match(JSON.stringify(completed.data), /90000/);
    const retry = events.filter(event => event.label === '模型请求重试（SDK）');
    assert.deepEqual(retry.map(event => event.status), ['started', 'completed']);
    assert.ok(events.some(event => event.label === 'recall_messages' && event.status === 'completed'));
    const request = events.find(event => event.label === 'Agent 请求' && event.status === 'completed');
    assert.ok(request, 'the enclosing request still completes');
    store.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a follow-up taken before a worker failure stays visible as undelivered, and restart never leaves it in processing', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-fu-'));
  const home = await privateHome(join(root, 'h'));
  const input = join(root, 'one.txt');
  await writeFile(input, 'authorized input');
  let failNextWorkerPrompt = false;
  let readOnce = false;
  const factory: AgentFactory = {
    mode: 'offline',
    async create(role, _id, tools) {
      return {
        async prompt(text, signal) {
          const event = JSON.parse(text) as { kind: string; followups?: Array<{ id: string }> };
          if (role === 'worker') {
            if (failNextWorkerPrompt) throw new Error('fixture worker prompt failed after accepting the follow-up');
            if (!readOnce) { readOnce = true; await tools.find(tool => tool.name === 'start_read')!.execute('f0'); return 'read requested'; }
            await abortableDelay(30_000, signal);
            return 'worker report';
          }
          if (event.kind === 'NEW_TASK') { await tools.find(tool => tool.name === 'dispatch_worker')!.execute('dispatch'); return 'dispatched'; }
          return 'router delivery';
        },
        close() {},
      };
    },
  };
  const coordinator = new Coordinator(home, factory);
  await coordinator.ready();
  let taskId = '';
  try {
    const task = await coordinator.submit(randomUUID(), 'analyze', [input], 600_000);
    taskId = task.id;
    await until(() => coordinator.store.get(task.id).status === 'running');
    coordinator.followup(task.id, 'fu-1', 'IMPORTANT USER FOLLOWUP TEXT');
    assert.ok(coordinator.store.notices(0).some(notice => notice.kind === 'followup'), 'fixture: the follow-up was accepted');
    failNextWorkerPrompt = true;
    // The worker is prompted again with the follow-up; that prompt fails.
    await until(() => coordinator.store.get(task.id).status !== 'running');
    assert.deepEqual(coordinator.store.events(task.id).map(event => event.state), ['failed'],
      'the accepted follow-up is recorded as undelivered, not stranded in processing');
    assert.ok(coordinator.store.notices(0).some(notice => notice.kind === 'followup_failed'), 'the drop is reported as a notice');
  } finally {
    await coordinator.close();
  }
  const reopened = new Store(home);
  try {
    reopened.recover();
    const notices = reopened.notices(0);
    assert.ok(notices.some(notice => notice.kind === 'followup_failed'), 'the undelivered follow-up stays visible after restart');
    assert.equal(reopened.events(taskId).every(event => event.state !== 'processing'), true, 'no row is left in processing');
  } finally {
    reopened.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a stop during Router delivery keeps the public text already shown and marks it unverified', { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-keep-'));
  const home = await privateHome(join(root, 'h'));
  const input = join(root, 'one.txt');
  await writeFile(input, 'authorized input');
  let readOnce = false;
  const streamed = 'X'.repeat(2_500);
  const factory: AgentFactory = {
    mode: 'offline',
    async create(role, _id, tools, options) {
      return {
        async prompt(text, signal) {
          const event = JSON.parse(text) as { kind: string; message?: { id: string } };
          if (role === 'worker') {
            if (!readOnce) { readOnce = true; await tools.find(tool => tool.name === 'start_read')!.execute('f0'); return 'read requested'; }
            return 'worker report';
          }
          if (event.kind === 'NEW_TASK') { await tools.find(tool => tool.name === 'dispatch_worker')!.execute('dispatch'); return 'dispatched'; }
          if (event.kind === 'CHAT') {
            await tools.find(tool => tool.name === 'start_work')!.execute(JSON.stringify({ instruction: 'analyze', sourceMessageId: event.message!.id }), randomUUID());
            return '已启动后台工作';
          }
          // WORKER_REPORT: stream public text, then stall until the stop arrives.
          const turn = randomUUID();
          options?.onEvent?.({ kind: 'turn_start', id: turn });
          options?.onEvent?.({ kind: 'text_delta', id: turn, text: streamed });
          await abortableDelay(30_000, signal);
          return streamed;
        },
        close() {},
      };
    },
  };
  const coordinator = new Coordinator(home, factory);
  await coordinator.ready();
  try {
    const message = coordinator.chat(randomUUID(), '分析这份文件', [input]);
    let workId = '';
    await until(() => (workId = coordinator.store.list()[0]?.id ?? '', Boolean(workId) && coordinator.store.get(workId).status === 'running'));
    const conversation = coordinator.store.conversation;
    await until(() => conversation.history(undefined, 20).items.some(item => item.replyTo === message.id && item.text === streamed));
    coordinator.stop(workId);
    await until(() => coordinator.store.get(workId).status === 'cancelled');
    const reply = conversation.history(undefined, 20).items.find(item => item.replyTo === message.id && item.text === streamed);
    assert.ok(reply, 'the streamed reply still exists');
    assert.equal(reply.text, streamed, 'already-shown public text is not erased by the stop');
    assert.equal(reply.status, 'interrupted');
    assert.match(reply.reason ?? '', /未核实/, 'the reason says the content was not verified');
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

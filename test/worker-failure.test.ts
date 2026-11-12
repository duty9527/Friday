import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../dist/coordinator.js';
import type { AgentFactory } from '../src/agent.js';

async function until(predicate: () => boolean | Promise<boolean>, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for condition');
}

type RouterHandler = (event: Record<string, unknown>, call: (name: string, args: unknown) => Promise<unknown>) => Promise<string>;

function makeFactory(router: RouterHandler, worker: (model?: string) => Promise<string>): AgentFactory {
  return {
    mode: 'offline',
    nativeTools: true,
    async create(role, _id, tools, options) {
      return {
        close() {},
        async prompt(text) {
          const event = JSON.parse(text) as Record<string, unknown>;
          if (role === 'worker') return worker(options?.model);
          const call = async (name: string, args: unknown) =>
            JSON.parse(await tools.find(tool => tool.name === name)!.execute(JSON.stringify(args)));
          return router(event, call);
        },
      };
    },
  };
}

test('Worker crash is handed to the Router as WORKER_FAILED with the real error instead of a raw system notice', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-fail-route-'));
  const failedEvents: Array<Record<string, unknown>> = [];
  const factory = makeFactory(async (event, call) => {
    if (event.kind === 'CHAT') {
      await call('start_work', { instruction: '看图', cwd: home, model: 'google/gemini-x' });
      return '好的老板，任务已下发。';
    }
    if (event.kind === 'WORKER_FAILED') {
      failedEvents.push(event);
      return 'Gemini 这条通路没跑起来，模块加载失败。';
    }
    return 'ok';
  }, async () => { throw new Error('Model request error: Cannot find module google-generative-ai.js'); });
  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    const msg = coordinator.chat('req-fail-1', '看看这张图');
    await until(() => coordinator.store.list().length === 1 && coordinator.store.list()[0]!.status === 'failed');
    const task = coordinator.store.list()[0]!;
    assert.match(String(task.reason), /Cannot find module google-generative-ai\.js/, 'task reason keeps the real error');
    assert.equal(failedEvents.length, 1);
    assert.match(String(failedEvents[0]!.error), /Cannot find module/);
    assert.equal(failedEvents[0]!.workerModel, 'google/gemini-x');
    await until(() => coordinator.store.conversation.allMessages().some(m => m.replyTo === msg.id && m.text.includes('模块加载失败')));
    const replies = coordinator.store.conversation.allMessages().filter(m => m.replyTo === msg.id);
    assert.ok(!replies.some(m => m.source === 'system' && m.status === 'failed'), 'no empty system failure notice when the Router spoke');
    const routerReply = replies.find(m => m.text.includes('模块加载失败'))!;
    assert.equal(routerReply.status, 'completed');
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Router may retry a crashed Worker on another provider; the handoff stays silent', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-fail-retry-'));
  const factory = makeFactory(async (event, call) => {
    if (event.kind === 'CHAT') {
      await call('start_work', { instruction: '看图', cwd: home, model: 'google/gemini-x' });
      return '好的老板，任务已下发。';
    }
    if (event.kind === 'WORKER_FAILED') {
      await call('start_work', { instruction: '看图（换提供方重试）', model: 'openai/gpt-x' });
      return '好的老板，任务已下发。';
    }
    if (event.kind === 'WORKER_REPORT') return `看到了：${String(event.report)}`;
    return 'ok';
  }, async model => {
    if (model?.startsWith('google/')) throw new Error('Model request error: provider down');
    return '一条红色斗鱼';
  });
  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    const msg = coordinator.chat('req-fail-2', '看看这张图');
    await until(() => coordinator.store.list().some(t => t.workerModel === 'openai/gpt-x' && t.status === 'completed'));
    await until(() => coordinator.store.conversation.allMessages().some(m => m.replyTo === msg.id && m.text.includes('红色斗鱼')));
    const replies = coordinator.store.conversation.allMessages().filter(m => m.replyTo === msg.id);
    assert.ok(!replies.some(m => m.status === 'failed'), 'the crashed attempt produced no failure message');
    assert.equal(replies.filter(m => /任务已下发/.test(m.text)).length, 1, 'only the original CHAT acknowledgment is visible');
    const google = coordinator.store.list().find(t => t.workerModel === 'google/gemini-x')!;
    assert.equal(google.status, 'failed');
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Host circuit breaker rejects a third dispatch to a provider that crashed twice with the same error', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-fail-breaker-'));
  const factory = makeFactory(async (event, call) => {
    if (event.kind === 'CHAT') {
      try {
        await call('start_work', { instruction: '看图', cwd: home, model: 'google/gemini-x' });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      return '好的老板，任务已下发。';
    }
    if (event.kind === 'WORKER_FAILED') return `失败：${String(event.error)}`;
    return 'ok';
  }, async () => { throw new Error('Model request error: Cannot find module X'); });
  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    for (const id of ['a', 'b']) {
      coordinator.chat(`req-breaker-${id}`, `看图 ${id}`);
      await until(() => coordinator.store.list().filter(t => t.status === 'failed').length === (id === 'a' ? 1 : 2));
    }
    const third = coordinator.chat('req-breaker-c', '再看一次');
    await until(() => coordinator.store.conversation.allMessages().some(m => m.replyTo === third.id && m.status === 'completed'));
    const reply = coordinator.store.conversation.allMessages().find(m => m.replyTo === third.id && m.status === 'completed')!;
    assert.match(reply.text, /熔断/);
    assert.match(reply.text, /Cannot find module X/);
    assert.equal(coordinator.store.list().length, 2, 'no third task was created');
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Router chat failure tells the Boss the reason in plain words instead of a trace pointer', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-router-fail-'));
  const factory = makeFactory(async () => {
    throw new Error('Model request error: 429: {"type":"server_error","message":"The inference service is overloaded."}');
  }, async () => 'unused');
  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    const msg = coordinator.chat('req-router-fail', '你读代码了吗');
    await until(() => coordinator.store.conversation.allMessages().some(m => m.replyTo === msg.id && m.status === 'failed'));
    const reply = coordinator.store.conversation.allMessages().find(m => m.replyTo === msg.id && m.status === 'failed')!;
    assert.match(String(reply.reason), /过载或限流/);
    assert.doesNotMatch(String(reply.reason), /执行轨迹/);
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Reports the Router rejected with a supplementary dispatch are not consolidated into task-experience memory', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-fail-consolidate-'));
  let reports = 0;
  const factory = makeFactory(async (event, call) => {
    if (event.kind === 'CHAT') {
      await call('start_work', { instruction: '看图并描述', cwd: home });
      return '好的老板，任务已下发。';
    }
    if (event.kind === 'WORKER_REPORT') {
      reports++;
      if (reports === 1) {
        await call('start_work', { instruction: '压缩后再看一次' });
        return '好的老板，任务已下发。';
      }
      return `看到了：${String(event.report)}`;
    }
    return 'ok';
  }, async () => (reports === 0 ? '图太大，读不出来' : '一条红色斗鱼'));
  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    coordinator.chat('req-consolidate', '看看这张图');
    await until(() => coordinator.store.list().length === 2 && coordinator.store.list().every(t => t.status === 'completed'));
    await until(() => coordinator.store.listMemories().length === 1);
    await delay(50);
    const memories = coordinator.store.listMemories();
    assert.equal(memories.length, 1, 'only the accepted report becomes task experience');
    assert.match(memories[0]!.content, /红色斗鱼/);
    assert.doesNotMatch(memories[0]!.content, /图太大/);
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

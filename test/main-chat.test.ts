import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '../dist/server.js';
import { request } from '../src/protocol.js';
import type { ChatMessage, MainView, TraceEvent } from '../src/view.js';
import type { Task } from '../src/store.js';

async function wait<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 180; i++) { const value = await read(); if (accepts(value)) return value; await delay(20); }
  throw new Error('Conversation fixture timed out');
}
const view = (home: string) => request(home, { command: 'view' }) as Promise<MainView>;
async function transcript(home: string): Promise<ChatMessage[]> {
  let page = (await view(home)).messages;
  const items = [...page.items];
  while (page.hasMore) {
    page = await request(home, { command: 'history', before: page.before }) as MainView['messages'];
    items.unshift(...page.items);
  }
  return items;
}
const send = (home: string, text: string, files: string[] = [], requestId = randomUUID()) => request(home, { command: 'chat', text, files, requestId }) as Promise<ChatMessage>;
async function fixture(delayMs = 20) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-mc-'));
  const service = await serve({ home, mode: 'offline', offlineDelayMs: delayMs });
  return { home, close: async () => { await service.close(); await rm(home, { recursive: true, force: true }); } };
}

test('single persistent main chat accepts ordinary conversation without files and idempotent message retries', async () => {
  const f = await fixture();
  try {
    const message = await send(f.home, '你好，我们始终在这里对话', [], 'stable-message');
    const same = await send(f.home, message.text, [], 'stable-message');
    assert.equal(same.id, message.id);
    await assert.rejects(send(f.home, 'changed', [], 'stable-message'), /already used/);
    const result = await wait(() => view(f.home), state => state.messages.items.some(item => item.replyTo === message.id && item.status === 'completed'));
    assert.equal(result.works.length, 0);
    assert.ok(result.messages.items.some(item => item.role === 'assistant' && item.text.includes('[OFFLINE SIMULATION]')));
    const traces = await request(f.home, { command: 'trace', messageId: message.id }) as TraceEvent[];
    assert.ok(traces.some(event => event.actor === 'router' && event.kind === 'span' && event.status === 'completed'));
    await assert.rejects(send(f.home, 'bad path', ['~/private.txt']), /absolute/);
  } finally { await f.close(); }
});

test('multiple works run behind the same transcript and a completed work can be continued from immutable inputs', async () => {
  const f = await fixture(70);
  try {
    const a = join(f.home, 'a.txt'); const b = join(f.home, 'b.txt');
    await writeFile(a, 'original A'); await writeFile(b, 'original B');
    const first = await send(f.home, '分析 A', [a]);
    const second = await send(f.home, '分析 B', [b]);
    const done = await wait(() => view(f.home), state => state.works.length === 2 && state.works.every(work => work.status === 'completed'));
    const firstWork = done.works.find(work => work.originMessageId === first.id)!;
    assert.ok(firstWork);
    assert.ok(done.works.some(work => work.originMessageId === second.id));
    const records = await request(f.home, { command: 'trace', messageId: first.id }) as TraceEvent[];
    assert.ok(records.some(event => event.kind === 'operation' && event.status === 'succeeded' && event.parentSpanId));
    assert.ok(records.some(event => event.label === 'start_work' && event.actor === 'router'));
    await rm(a); await rm(b);
    const follow = await send(f.home, '继续之前的工作，补充分析限制');
    const next = await wait(() => view(f.home), state => state.works.length === 3 && state.works.every(work => work.status === 'completed'));
    const continued = next.works.find(work => work.originMessageId === follow.id)!;
    assert.ok(continued.parentTaskId);
    const persisted = await request(f.home, { command: 'get', taskId: continued.id }) as Task & { operations: Array<{ id: string }> };
    const op = await request(f.home, { command: 'operation', taskId: persisted.id, operationId: persisted.operations[0]!.id }) as { result: string };
    assert.match(op.result, /original [AB]/);
    assert.match(persisted.files[0]!.name, /^[ab]\.txt$/);
    assert.equal((await transcript(f.home)).filter(item => item.role === 'user').length, 3);
  } finally { await f.close(); }
});

test('active work followups are associated by Router rather than requiring a task ID', async () => {
  const f = await fixture(200);
  try {
    const file = join(f.home, 'input.txt'); await writeFile(file, 'authorized data');
    const initial = await send(f.home, '分析这份文件', [file]);
    await wait(() => view(f.home), state => state.works.some(work => work.originMessageId === initial.id && work.status === 'running'));
    const follow = await send(f.home, '补充：只列出两个重点');
    const done = await wait(() => view(f.home), state => state.works.length === 1 && state.works[0]!.status === 'completed');
    const tasks = done.messages.items.find(message => message.id === follow.id)?.taskIds;
    assert.deepEqual(tasks, [done.works[0]!.id]);
    const record = await request(f.home, { command: 'get', taskId: done.works[0]!.id }) as Task;
    assert.match(record.report!, /只列出两个重点/);
  } finally { await f.close(); }
});

test('stopping a Router reply is independent from daemon lifetime and queued replies never auto-replay', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-stop-'));
  let service = await serve({ home, mode: 'offline', offlineDelayMs: 400 });
  try {
    const first = await send(home, '普通聊天，不要后台任务');
    const queued = await send(home, '这条先排队');
    await request(home, { command: 'chat-stop', messageId: queued.id });
    await request(home, { command: 'chat-stop', messageId: first.id });
    const stopped = await wait(() => view(home), state => state.messages.items.filter(item => item.role === 'user').every(item => item.status === 'interrupted'));
    assert.equal(stopped.works.length, 0);
    await service.close();
    service = await serve({ home, mode: 'offline', offlineDelayMs: 10 });
    const reopened = await view(home);
    assert.ok(reopened.messages.items.some(item => item.id === first.id && item.status === 'interrupted'));
    assert.equal(reopened.messages.items.filter(item => item.role === 'user').length, 2);
    const next = await send(home, '恢复后仍在同一主对话');
    const after = await wait(() => view(home), state => state.messages.items.some(item => item.replyTo === next.id && item.status === 'completed'));
    assert.equal(after.messages.items.filter(item => item.role === 'user').length, 3);
  } finally { await service.close(); await rm(home, { recursive: true, force: true }); }
});

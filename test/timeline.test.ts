import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { timelineSteps } from '../src/web/model.js';
import type { TraceEvent } from '../src/view.js';

let seq = 0;
const event = (overrides: Partial<TraceEvent>): TraceEvent => ({
  seq: ++seq, id: `e${seq}`, type: 'trace', kind: 'span', actor: 'router', label: 'span',
  status: 'started', at: 1_000 + seq, rootId: 'root', ...overrides,
});

test('a readable step exists for every recorded call, with same-named tools kept apart', () => {
  seq = 0;
  const steps = timelineSteps([
    event({ spanId: 'call', label: 'Agent 请求', status: 'started', data: { trigger: { kind: 'CHAT', preview: '比较两个实现' } } }),
    event({ spanId: 'turn', parentSpanId: 'call', label: '模型推理调用', status: 'started' }),
    event({ spanId: 'turn', parentSpanId: 'call', kind: 'visible_text', label: '模型公开输出增量', status: 'streaming', data: { text: '先看' } }),
    event({ spanId: 'turn', parentSpanId: 'call', kind: 'visible_text', label: '模型公开输出增量', status: 'streaming', data: { text: '两个项目的入口。' } }),
    event({ spanId: 'turn', parentSpanId: 'call', label: '模型推理调用', status: 'completed',
      data: { summary: { publicText: '先看两个项目的入口。' } } }),
    event({ spanId: 't1', parentSpanId: 'turn', label: 'grep', actor: 'worker', status: 'started',
      data: { summary: { input: { pattern: 'router', path: '/repo' } } } }),
    event({ spanId: 't1', parentSpanId: 'turn', label: 'grep', actor: 'worker', status: 'completed',
      data: { summary: { output: '3 matches', outputTruncated: false } } }),
    event({ spanId: 't2', parentSpanId: 'turn', label: 'grep', actor: 'worker', status: 'started', data: { summary: { input: { pattern: 'worker' } } } }),
    event({ spanId: 't3', parentSpanId: 'turn', label: 'bash', actor: 'worker', status: 'completed',
      data: { summary: { output: '', exitCode: 255 } } }),
    event({ spanId: 't3', parentSpanId: 'turn', kind: 'operation', label: '本机工具 · bash', actor: 'worker', status: 'failed', data: { error: '命令退出码 255' } }),
  ]);
  assert.deepEqual(steps.map(step => step.title), [
    'Router 处理新输入', 'Router 判断', '搜索内容', '搜索内容', '执行命令',
  ]);
  const toolEnd = steps[0]!;
  assert.equal(toolEnd.summary, undefined, 'a request start records no invented reasoning');
  assert.equal(steps[1]!.summary, '先看两个项目的入口。');
  assert.equal(steps[1]!.summarySource, 'turn');
});

test('the model round carries its public statement, folded stream text and its own tools', () => {
  seq = 0;
  const steps = timelineSteps([
    event({ spanId: 'turn', label: '模型推理调用', status: 'started' }),
    event({ spanId: 'turn', kind: 'visible_text', status: 'streaming', data: { text: '将补充到 artex。' } }),
    event({ spanId: 'turn', label: '模型推理调用', status: 'completed', data: { summary: { publicText: '将补充到 artex。' } } }),
    event({ spanId: 'tool', parentSpanId: 'turn', label: 'start_work', status: 'started' }),
    event({ spanId: 'route', parentSpanId: 'tool', kind: 'route_action', label: 'new_work', status: 'accepted',
      data: { id: 'route', kind: 'new_work', status: 'accepted', at: 1_010, taskId: 'task-1', taskLabel: 'artex 架构对比', summary: '按路径新建执行' } }),
    event({ spanId: 'followup', parentSpanId: 'route', kind: 'followup_state', label: '处理补充要求', actor: 'worker',
      status: 'done', data: { state: 'done', taskLabel: 'artex 架构对比' } }),
  ]);
  assert.deepEqual(steps.map(step => step.title), ['Router 判断', '新建工作', '处理补充要求'],
    'the raw tool call and its confirmed routing action are one readable step');
  assert.equal(steps[1]!.taskLabel, 'artex 架构对比');
  assert.equal(steps[1]!.summary, '按路径新建执行');
  assert.equal(steps[2]!.followupState, 'done');
  assert.equal(steps[2]!.taskLabel, 'artex 架构对比');
});

test('steps stay in recorded order across concurrent roles, and missing summaries are not filled in', () => {
  seq = 0;
  const steps = timelineSteps([
    event({ spanId: 'a', actor: 'worker', label: 'read', status: 'started', data: { summary: { input: { path: 'a.ts' } } } }),
    event({ spanId: 'b', actor: 'router', label: '模型推理调用', status: 'started' }),
    event({ spanId: 'a', actor: 'worker', label: 'read', status: 'completed' }),
    event({ spanId: 'c', actor: 'worker', label: 'bash', status: 'started' }),
    event({ spanId: 'c', actor: 'worker', label: 'bash', status: 'failed', data: { summary: { exitCode: 1 }, detail: { error: 'one test failed' } } }),
  ]);
  assert.deepEqual(steps.map(step => step.id), ['a', 'b', 'c'], 'interleaved roles are not re-sorted by role');
  assert.equal(steps[1]!.summary, undefined);
  assert.equal(steps[2]!.exitCode, 1);
  assert.equal(steps[2]!.error, 'one test failed');
  assert.equal(steps[2]!.status, 'failed');
});

test('trace reads the recent window, then earlier pages, without losing durable order', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-timeline-'));
  try {
    const store = new Store(home);
    const chat = store.conversation;
    const message = chat.create({ id: 'm1', role: 'user', text: 'work', status: 'queued', mode: 'offline', paths: [] });
    for (let index = 0; index < 70; index++) chat.span({ rootId: message.id, messageId: message.id, spanId: `s${index}` }, 'router', 'step', 'completed');
    const recent = chat.trace({ messageId: message.id });
    assert.equal(recent.length, 60);
    assert.ok(recent.every((item, index) => index === 0 || recent[index - 1]!.seq < item.seq));
    assert.equal(recent.at(-1)!.label, 'step');
    const earlier = chat.trace({ messageId: message.id }, undefined, recent[0]!.seq);
    assert.ok(earlier.length > 0 && earlier.every(item => item.seq < recent[0]!.seq));
    assert.equal(earlier.at(-1)!.seq + 1, recent[0]!.seq, 'the two pages meet exactly, with no gap or overlap');
    const forward = chat.trace({ messageId: message.id }, recent.at(-1)!.seq);
    assert.deepEqual(forward, [], 'reading forward from the head is empty rather than replaying history');
    store.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

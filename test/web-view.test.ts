import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMessages, orderConversation, routeLabel, routeState, spanDuration, spanNodes, spanTree, usageSummary } from '../src/web/model.js';
import { layoutBrainGraph } from '../src/web/brain.js';
import type { ChatMessage, TraceEvent } from '../src/view.js';

const message = (id: string, seq: number, role: 'user' | 'assistant', replyTo?: string, version = seq): ChatMessage =>
  ({ id, seq, version, role, replyTo, text: id, status: 'completed', at: seq, mode: 'offline', paths: [], taskIds: [] });
const event = (seq: number, overrides: Partial<TraceEvent>): TraceEvent => ({
  seq, id: `e${seq}`, type: 'trace', kind: 'span', actor: 'router', label: 'span', status: 'completed',
  at: 1_000 + seq, rootId: 'root', ...overrides,
});

test('late replies and notices stay in insertion order; replyTo never moves them back into old conversation', () => {
  // A burst of submissions lands all user rows first, then replies as they are processed.
  const items = [
    message('u1', 1, 'user'), message('u2', 2, 'user'), message('u3', 3, 'user'),
    message('r2', 4, 'assistant', 'u2'), message('r3', 5, 'assistant', 'u3'), message('r1', 6, 'assistant', 'u1'),
  ];
  assert.deepEqual(orderConversation(items).map(item => item.id), ['u1', 'u2', 'u3', 'r2', 'r3', 'r1']);
  const notice = { ...message('n1', 7, 'assistant', 'u1'), source: 'system' as const };
  assert.deepEqual(orderConversation([...items, notice]).map(item => item.id), ['u1', 'u2', 'u3', 'r2', 'r3', 'r1', 'n1']);
  assert.deepEqual(orderConversation([...items].reverse()).map(item => item.id), ['u1', 'u2', 'u3', 'r2', 'r3', 'r1'], 'hydration and paging use durable order, not network response order');
  assert.deepEqual(orderConversation([...items, notice]).filter(item => item.id === 'u1' || item.replyTo === 'u1').map(item => item.id), ['u1', 'r1', 'n1'],
    'children of one message keep their recorded order');
  assert.deepEqual(orderConversation([message('orphan', 9, 'assistant', 'missing')]).map(item => item.id), ['orphan']);
});

test('routing labels distinguish acceptance, delivery and uncertainty without deriving actions from prose', () => {
  assert.match(routeLabel({ kind: 'followup' }), /未新建/);
  assert.match(routeLabel({ kind: 'related_work' }), /新建工作/);
  assert.match(routeLabel({ kind: 'reply' }), /未派发/);
  assert.match(routeState({ kind: 'followup', status: 'accepted', delivery: 'pending' }), /等待 Worker/);
  assert.match(routeState({ kind: 'followup', status: 'accepted', delivery: 'done' }), /结果另行交付/);
  assert.match(routeState({ kind: 'followup', status: 'accepted', delivery: 'failed' }), /未确认/);
  assert.equal(routeState({ kind: 'stop', status: 'accepted' }), '已受理', 'a stop request is not a confirmed stop');
  assert.match(routeState({ kind: 'new_work', status: 'failed' }), /失败/);
});

test('message merge never regresses to an older journal version', () => {
  const map = new Map<string, ChatMessage>();
  mergeMessages(map, [message('m1', 1, 'user', undefined, 10)]);
  mergeMessages(map, [message('m1', 1, 'user', undefined, 4)]);
  assert.equal(map.get('m1')?.version, 10);
  mergeMessages(map, [{ ...message('m1', 1, 'user', undefined, 12), text: 'newer' }]);
  assert.equal(map.get('m1')?.text, 'newer');
});

test('an executor operation two model calls below the message is still a child, never a second root', () => {
  const events: TraceEvent[] = [
    event(1, { spanId: 'user', parentSpanId: undefined, kind: 'message', actor: 'user' }),
    event(2, { spanId: 'call', parentSpanId: 'user', label: 'Agent 请求' }),
    event(3, { spanId: 'turn', parentSpanId: 'call', label: '模型推理调用' }),
    event(4, { spanId: 'tool', parentSpanId: 'turn', label: 'start_work' }),
    event(5, { spanId: 'task', parentSpanId: 'tool', kind: 'task_state', actor: 'system' }),
    event(6, { spanId: 'wcall', parentSpanId: 'task', actor: 'worker', label: 'Agent 请求' }),
    event(7, { spanId: 'wturn', parentSpanId: 'wcall', actor: 'worker', label: '模型推理调用' }),
    event(8, { spanId: 'read', parentSpanId: 'wturn', actor: 'worker', label: 'start_read' }),
    event(9, { spanId: 'op', parentSpanId: 'read', kind: 'operation', actor: 'executor', label: '读取文件副本' }),
  ];
  const spans = spanNodes(events);
  const tree = spanTree(spans);
  assert.deepEqual(tree.roots.map(span => span.id), ['user'], 'exactly one causal root');
  assert.deepEqual(tree.detached, []);
  assert.deepEqual(tree.children.get('read')?.map(span => span.id), ['op'], 'the operation keeps its parent edge at depth 8');
  // A parent outside the fetched window is reported apart, not silently re-rooted as causal.
  const truncated = spanTree(spanNodes([event(1, { spanId: 'child', parentSpanId: 'not-fetched' })]));
  assert.deepEqual(truncated.roots, []);
  assert.deepEqual(truncated.detached.map(span => span.id), ['child']);
});

test('bookkeeping and private channels never become graph nodes, and only measured durations are claimed', () => {
  const spans = spanNodes([
    event(1, { spanId: 'a', kind: 'visible_text', label: '模型公开输出增量', status: 'streaming' }),
    event(2, { spanId: 'b', kind: 'work_linked', status: 'linked' }),
    event(3, { spanId: 'c', kind: 'thinking', status: 'completed' }),
    event(4, { spanId: 'd', parentSpanId: 'a', status: 'started', at: 2_000 }),
    event(5, { spanId: 'd', parentSpanId: 'a', status: 'completed', at: 3_500 }),
    event(6, { spanId: 'e', status: 'completed' }),
  ]);
  assert.deepEqual(spans.map(span => span.id), ['d', 'e']);
  assert.equal(spanDuration(spans[0]!.events), '1.50 秒');
  assert.equal(spanDuration(spans[1]!.events), undefined, 'a single event is not a measured duration');
});

test('usage is reported only from recorded data', () => {
  assert.equal(usageSummary(undefined), '— / —');
  assert.equal(usageSummary({}), '— / —');
  assert.equal(usageSummary({ usage: { input: 1200, output: 40 } }), '1,200 / 40 tokens');
  assert.equal(usageSummary({ usage: { input: 1200 } }), '1,200 / — tokens');
  assert.equal(usageSummary({ tokensBefore: 90_000, estimatedTokensAfter: 12_000 }), '90,000 → 12,000 tokens');
});

test('golden brain 3D layout places pinned beliefs in the inner mantle and deduplicates bidirectional synapses', () => {
  const cards = [
    {
      id: 'core-1',
      topic: '奥创旁边那个大脑',
      preview: '不是工具，是大脑',
      tags: ['persona'],
      pinned: true,
      accessCount: 4,
      updatedAt: 100,
      synapses: [{ targetId: 'outer-1', weight: 0.65, relation: 'shared_tag' as const, updatedAt: 100 }],
    },
    {
      id: 'outer-1',
      topic: 'IM 回复风格',
      preview: '短对话，不长报告',
      tags: ['style'],
      pinned: false,
      accessCount: 1,
      updatedAt: 90,
      synapses: [{ targetId: 'core-1', weight: 0.82, relation: 'co_activated' as const, updatedAt: 95 }],
    },
  ];
  const graph = layoutBrainGraph(cards);
  assert.equal(graph.nodes.length, 2);
  const coreRadius = Math.hypot(graph.nodes[0]!.x, graph.nodes[0]!.y, graph.nodes[0]!.z);
  const outerRadius = Math.hypot(graph.nodes[1]!.x, graph.nodes[1]!.y, graph.nodes[1]!.z);
  assert.ok(coreRadius >= 0.44 && coreRadius <= 0.62, 'pinned core memory occupies inner golden mantle');
  assert.ok(outerRadius >= 0.67 && outerRadius <= 0.96, 'regular memory occupies outer cortex shell');
  assert.equal(graph.edges.length, 1, 'bidirectional synapse pairs collapse to a single filament');
  assert.equal(graph.edges[0]!.weight, 0.82, 'merged synapse retains the stronger weight');
  assert.deepEqual(layoutBrainGraph(cards).nodes.map(n => [n.x, n.y, n.z]), graph.nodes.map(n => [n.x, n.y, n.z]), 'coordinates stay deterministic across renders');
});

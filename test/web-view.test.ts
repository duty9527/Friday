import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMessages, orderConversation, routeLabel, routeState, spanDuration, spanNodes, spanTree, usageSummary } from '../src/web/model.js';
import { layoutBrainGraph } from '../src/web/brain.js';
import { buildOverviewFlowchart, buildSessionFlowchart, type MindmapSession, type MindmapTaskFlow } from '../src/web/mindmap-data.js';
import { consumeSseStream, isValidAccessToken, LEGACY_TOKEN_STORAGE_KEY, resolveBootstrapToken, TOKEN_STORAGE_KEY } from '../src/web/shared/auth-http.js';
import { computePoseFrame, deriveFridayBotState, renderBotStaticSvgString } from '../src/web/shared/bot-avatar.js';
import {
  BOT_EXPRESSIONS,
  inferMessageBotExpression,
  tokenizeBotMessageText,
  transformOutboundBotExpressions,
} from '../src/web/shared/bot-expressions.js';
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

test('flowchart builders lay out session turns, tasks, search matches, and overview rows without v1 trees', () => {
  const flow: MindmapTaskFlow = {
    id: 'flow-1',
    seq: 1,
    createdAt: 1_000,
    completedAt: 2_500,
    status: 'completed',
    sessionId: 'sess-1',
    turnIndex: 1,
    turnCount: 1,
    ingress: {
      sourceKind: 'local',
      channelLabel: 'Web 控制台',
      messageId: 'msg-1',
      text: '检查构建流水线',
      attachments: [],
      paths: [],
    },
    memoryRecall: { recalledItems: [] },
    routerTurns: [{
      spanId: 'rt-1',
      triggerKind: 'message',
      startedAt: 1_050,
      endedAt: 1_300,
      durationMs: 250,
      status: 'completed',
      llmTurns: 1,
      tools: [],
    }],
    routeActions: [{ id: 'ra-1', kind: 'new_work', status: 'accepted', at: 1_250, taskId: 'task-1' }],
    tasks: [{
      id: 'task-1',
      prompt: '检查构建流水线并验证测试',
      status: 'completed',
      profile: 'coding',
      createdAt: 1_300,
      activeMs: 900,
      limitMs: 60_000,
      compiledMemories: [],
      executionPhases: [{
        index: 1,
        isFollowup: false,
        startedAt: 1_320,
        endedAt: 2_200,
        durationMs: 880,
        status: 'completed',
        llmCount: 1,
        toolCount: 1,
      }],
      workerSteps: [{
        id: 'ws-1',
        kind: 'tool_call',
        at: 1_500,
        durationMs: 200,
        status: 'completed',
        title: 'run_tests',
        phaseIndex: 1,
      }],
      totalSteps: 1,
      omittedSteps: 0,
      succeededOps: 1,
      failedOps: 0,
      jevQualityGates: [],
      reportPreview: '构建与测试全部通过',
    }],
    consolidatedMemories: [],
    deliveries: [{
      messageId: 'msg-2',
      seq: 2,
      at: 2_500,
      roleLabel: 'F.R.I.D.A.Y.',
      status: 'completed',
      text: '已确认构建与测试全部通过。',
    }],
    imPush: {
      channel: 'local',
      channelName: 'Web 控制台',
      delivered: true,
      deliveryCount: 1,
      sentFiles: [],
    },
  };
  const session: MindmapSession = {
    id: 'sess-1',
    title: '构建巡检',
    kind: 'human',
    status: 'completed',
    startedAt: 1_000,
    updatedAt: 2_500,
    channels: ['local'],
    primaryChannelLabel: 'Web 控制台',
    turnCount: 1,
    taskCount: 1,
    jevCallCount: 0,
    recalledMemoryCount: 0,
    consolidatedMemoryCount: 0,
    aiManagedContext: false,
    turnFlowIds: ['flow-1'],
    turnSummaries: [{
      flowId: 'flow-1',
      seq: 1,
      at: 1_000,
      sourceKind: 'local',
      channelLabel: 'Web 控制台',
      textPreview: '检查构建流水线',
      status: 'completed',
      taskIds: ['task-1'],
    }],
  };
  const flowsById = new Map<string, MindmapTaskFlow>([['flow-1', flow]]);
  const graph = buildSessionFlowchart(session, flowsById, null, new Map(), '流水线');
  assert.equal(graph.mode, 'session');
  assert.equal(graph.frames.length, 1);
  assert.ok(graph.nodes.some(n => n.kind === 'ingress'));
  assert.ok(graph.nodes.some(n => n.kind === 'worker_phase'));
  assert.ok(graph.nodes.some(n => n.kind === 'worker_step'));
  assert.ok(graph.nodes.some(n => n.kind === 'im_delivery'));
  assert.ok(graph.nodes.some(n => n.match), 'search term marks matching flowchart nodes');
  assert.ok(graph.edges.length >= 2);

  const overview = buildOverviewFlowchart([session], flowsById, null, '');
  assert.equal(overview.mode, 'overview');
  assert.equal(overview.frames.length, 1);
  assert.ok(overview.nodes.some(n => n.kind === 'session_summary'));
  assert.ok(overview.nodes.some(n => n.kind === 'worker_exec'));
});

test('auth-http token validation, fragment stripping, legacy storage migration, and SSE parser', async () => {
  const validToken = 'a'.repeat(64);
  assert.equal(isValidAccessToken(validToken), true);
  assert.equal(isValidAccessToken('short-token'), false);
  assert.equal(isValidAccessToken('g'.repeat(64)), false);

  const store = new Map<string, string>([[LEGACY_TOKEN_STORAGE_KEY, validToken]]);
  const replaced: string[] = [];
  const origLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const origHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const origStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');

  const storageMock = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  try {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { hash: '', pathname: '/mindmap', search: '?view=all' },
    });
    Object.defineProperty(globalThis, 'history', {
      configurable: true,
      value: { replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url) },
    });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storageMock });

    const migrated = resolveBootstrapToken();
    assert.equal(migrated.token, validToken);
    assert.equal(migrated.storageUnavailable, false);
    assert.equal(store.get(TOKEN_STORAGE_KEY), validToken);
    assert.equal(store.has(LEGACY_TOKEN_STORAGE_KEY), false);

    // Invalid fragment is stripped without overwriting storage with invalid data
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { hash: '#token=invalid!', pathname: '/', search: '' },
    });
    const rejected = resolveBootstrapToken();
    assert.equal(rejected.token, '');
    assert.deepEqual(replaced, ['/']);
    assert.equal(store.has(TOKEN_STORAGE_KEY), false);
  } finally {
    const restore = (name: string, desc: PropertyDescriptor | undefined) => {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete (globalThis as Record<string, unknown>)[name];
    };
    restore('location', origLocation);
    restore('history', origHistory);
    restore('sessionStorage', origStorage);
  }

  const ssePayload = ': heartbeat\n\nevent: updates\ndata: {"events":[],"cursor":3,"head":3}\n\n';
  const sseResp = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(ssePayload));
      controller.close();
    },
  }));
  const seen: Array<{ event: string; data: string }> = [];
  await assert.rejects(
    () => consumeSseStream(sseResp, {
      shouldContinue: () => true,
      onEvent: (event, data) => { seen.push({ event, data }); },
    }),
    /已断开/,
  );
  assert.deepEqual(seen, [{ event: 'updates', data: '{"events":[],"cursor":3,"head":3}' }]);

  const probResp = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: problem\ndata: {"error":"daemon down"}\n\n'));
      controller.close();
    },
  }));
  await assert.rejects(
    () => consumeSseStream(probResp, {
      shouldContinue: () => true,
      onEvent: () => {},
    }),
    /daemon down/,
  );
});

test('bot avatar 3D projection, static SVG rendering, state derivation, and inline expression parsing', () => {
  const neutral = computePoseFrame({ expr: 'neutral', ry: 0 });
  const happy = computePoseFrame({ expr: 'happy', ry: -12 });
  assert.match(neutral.bodyPath, /^M[\d.-]+ [\d.-]+.*Z$/);
  assert.notEqual(neutral.eyeLeft.d, happy.eyeLeft.d);
  assert.equal(neutral.eyeLeft.opacity, 1);

  const turnedAway = computePoseFrame({ expr: 'neutral', ry: 180 });
  assert.equal(turnedAway.eyeLeft.opacity, 0, 'eyes hide cleanly when head spins 180 degrees away');

  for (const expr of BOT_EXPRESSIONS) {
    const svg = renderBotStaticSvgString({ size: 64, expr, background: 'transparent' });
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /<mask id="/);
  }

  assert.equal(deriveFridayBotState({
    ready: false, authExpired: false, staleConnection: false, sending: false, draftTyping: false, messages: [], works: [],
  }), 'sleeping');
  assert.equal(deriveFridayBotState({
    ready: true, authExpired: false, staleConnection: false, sending: false, draftTyping: true, messages: [], works: [],
  }), 'listening');
  assert.equal(deriveFridayBotState({
    ready: true, authExpired: false, staleConnection: false, sending: false, draftTyping: false,
    messages: [{ role: 'user', status: 'processing', routing: { status: 'processing', actions: [{ kind: 'search_memory' }] } }],
    works: [],
  }), 'searching');
  assert.equal(deriveFridayBotState({
    ready: true, authExpired: false, staleConnection: false, sending: false, draftTyping: false,
    messages: [{ role: 'assistant', status: 'streaming' }], works: [],
  }), 'streaming');
  assert.equal(deriveFridayBotState({
    ready: true, authExpired: false, staleConnection: false, sending: false, draftTyping: false,
    messages: [], works: [{ status: 'running', pendingQuestion: { question: '确认?' } }],
  }), 'waiting');
  assert.equal(deriveFridayBotState({
    ready: true, authExpired: false, staleConnection: false, sending: false, draftTyping: false,
    messages: [], works: [{ status: 'running' }],
  }), 'working');
  assert.equal(deriveFridayBotState({
    ready: true, authExpired: false, staleConnection: false, sending: false, draftTyping: false,
    messages: [], works: [],
  }), 'idle');

  const tokens = tokenizeBotMessageText('收到 [bot:happy] 马上查 [bot:打量] [bot:invalid_name] <img src=x> [[sticker:confused]]');
  assert.deepEqual(tokens, [
    { kind: 'text', value: '收到 ' },
    { kind: 'emote', expr: 'happy', raw: '[bot:happy]' },
    { kind: 'text', value: ' 马上查 ' },
    { kind: 'emote', expr: 'inspecting', raw: '[bot:打量]' },
    { kind: 'text', value: ' [bot:invalid_name] <img src=x> ' },
    { kind: 'sticker', expr: 'confused', raw: '[[sticker:confused]]' },
  ]);
  assert.equal(inferMessageBotExpression('太棒了 [bot:surprised]'), 'surprised');
  assert.equal(inferMessageBotExpression('搞定啦 [庆祝]'), 'happy');

  const plainMultiline = 'Line 1\r\nLine 2\n\n[旺柴]';
  assert.deepEqual(transformOutboundBotExpressions(plainMultiline, 'wechat'), {
    text: plainMultiline,
    stickers: [],
  });
  assert.deepEqual(transformOutboundBotExpressions('搞定啦 [bot:happy] [[sticker:happy]]', 'wechat'), {
    text: '搞定啦 [庆祝]',
    stickers: ['happy'],
  });
  assert.deepEqual(transformOutboundBotExpressions('搞定啦 [bot:happy] [[sticker:happy]]', 'xiaoai'), {
    text: '搞定啦',
    stickers: [],
  });
});

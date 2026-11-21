import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeMessages, orderConversation, routeLabel, routeState, spanDuration, spanNodes, spanTree, usageSummary } from '../src/web/model.js';
import { layoutBrainGraph } from '../src/web/brain.js';
import { buildOverviewFlowchart, buildSessionFlowchart, type MindmapSession, type MindmapTaskFlow } from '../src/web/mindmap-data.js';
import { consumeSseStream, createHttpClient, hasOpenAuthCookie, isValidAccessToken, LEGACY_TOKEN_STORAGE_KEY, OPEN_AUTH_SENTINEL_TOKEN, resolveBootstrapToken, TOKEN_STORAGE_KEY } from '../src/web/shared/auth-http.js';
import { makeRequestId } from '../src/web/shared/format.js';
import { computePoseFrame, deriveFridayBotState, renderBotStaticSvgString } from '../src/web/shared/bot-avatar.js';
import {
  BOT_EXPRESSIONS,
  inferMessageBotExpression,
  tokenizeBotMessageText,
  transformOutboundBotExpressions,
} from '../src/web/shared/bot-expressions.js';
import {
  channelMeta,
  classifyRoutingDisplay,
  collectAvailableChannels,
  deriveCompanionStatus,
  extractLeadingQuote,
  filterConversationMessages,
  formatByteSize,
  formatShortClock,
  formatTimeDivider,
  isGroupedWithPrevious,
  resolveMessageChannel,
  shouldShowReplyReference,
  shouldShowTimeDivider,
  stripLeadingQuoteForPreview,
  summarizeSystemNotice,
} from '../src/web/shared/chat-view.js';
import {
  isSafeUrl,
  parseInlineTokens,
  parseMarkdownBlocks,
  renderMarkdownContent,
  renderUserMessageContent,
} from '../src/web/shared/markdown.js';
import {
  classifyPluginActions,
  clearPluginOrder,
  filterAndGroupPlugins,
  formatActionDefaultArgs,
  getPluginStatusInfo,
  getPluginSummary,
  isCustomOrder,
  mergePluginOrder,
  movePluginStep,
  readPluginOrder,
  readSidebarCollapsed,
  reorderPluginList,
  summarizePluginRunMessage,
  writePluginOrder,
  writeSidebarCollapsed,
} from '../src/web/shared/plugin-catalog.js';
import type { ChatMessage, PluginView, TimerView, TraceEvent } from '../src/view.js';

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

test('auth-http open-auth cookie enables tokenless bootstrap without polluting sessionStorage and keeps #token precedence', async () => {
  const store = new Map<string, string>();
  const origLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const origHistory = Object.getOwnPropertyDescriptor(globalThis, 'history');
  const origStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const origDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const origFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');

  const storageMock = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  const calls: Array<{ url: string; headers: Headers }> = [];
  try {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { hash: '', pathname: '/', search: '' },
    });
    Object.defineProperty(globalThis, 'history', {
      configurable: true,
      value: { replaceState: () => {} },
    });
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storageMock });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { cookie: 'foo=1; friday_auth_mode=none' },
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    });

    assert.equal(hasOpenAuthCookie(), true);
    const openState = resolveBootstrapToken();
    assert.equal(openState.token, OPEN_AUTH_SENTINEL_TOKEN);
    assert.equal(store.has(TOKEN_STORAGE_KEY), false);

    const openClient = createHttpClient({ token: openState.token });
    await openClient.api('/api/view');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers.has('authorization'), false);

    const realToken = 'b'.repeat(64);
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { hash: `#token=${realToken}`, pathname: '/', search: '' },
    });
    const explicitState = resolveBootstrapToken();
    assert.equal(explicitState.token, realToken);
    assert.equal(store.get(TOKEN_STORAGE_KEY), realToken);

    const explicitClient = createHttpClient({ token: explicitState.token });
    await explicitClient.api('/api/chat', { text: 'hi' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.headers.get('authorization'), `Bearer ${realToken}`);
    assert.equal(calls[1]!.headers.get('content-type'), 'application/json');
  } finally {
    const restore = (name: string, desc: PropertyDescriptor | undefined) => {
      if (desc) Object.defineProperty(globalThis, name, desc);
      else delete (globalThis as Record<string, unknown>)[name];
    };
    restore('location', origLocation);
    restore('history', origHistory);
    restore('sessionStorage', origStorage);
    restore('document', origDocument);
    restore('fetch', origFetch);
  }
});

test('makeRequestId falls back to crypto.getRandomValues and non-crypto IDs in non-secure HTTP contexts', () => {
  const uuidFromRandomValues = makeRequestId({
    getRandomValues: arr => {
      for (let i = 0; i < arr.length; i++) arr[i] = (i * 17 + 3) & 0xff;
      return arr;
    },
  });
  assert.match(uuidFromRandomValues, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const fallbackA = makeRequestId(undefined);
  const fallbackB = makeRequestId({});
  assert.ok(fallbackA.length > 8 && fallbackA.length <= 128);
  assert.ok(fallbackB.length > 8 && fallbackB.length <= 128);
  assert.notEqual(fallbackA, fallbackB);
});

function createMockDoc() {
  interface MockNode {
    nodeType: number;
    tagName?: string;
    textContent: string;
    className: string;
    attributes: Record<string, string>;
    children: MockNode[];
    href?: string;
    target?: string;
    rel?: string;
    type?: string;
    start?: number;
    listeners: Record<string, Array<() => void>>;
    appendChild: (child: MockNode) => MockNode;
    setAttribute: (k: string, v: string) => void;
    addEventListener: (ev: string, fn: () => void) => void;
    classList: {
      add: (c: string) => void;
      remove: (c: string) => void;
      toggle: (c: string) => boolean;
      contains: (c: string) => boolean;
    };
  }
  const makeNode = (nodeType: number, tagName?: string, text = ''): MockNode => {
    const classes = new Set<string>();
    const syncClass = (el: MockNode) => { el.className = [...classes].join(' '); };
    const nodeObj: MockNode = {
      nodeType,
      ...(tagName ? { tagName: tagName.toUpperCase() } : {}),
      textContent: text,
      get className() { return [...classes].join(' '); },
      set className(val: string) {
        classes.clear();
        for (const c of val.split(/\s+/).filter(Boolean)) classes.add(c);
      },
      attributes: {},
      children: [],
      listeners: {},
      appendChild(child: MockNode) {
        if (child.nodeType === 11) {
          for (const nested of child.children) this.children.push(nested);
        } else {
          this.children.push(child);
        }
        return child;
      },
      setAttribute(k: string, v: string) { this.attributes[k] = v; },
      addEventListener(ev: string, fn: () => void) {
        this.listeners[ev] ??= [];
        this.listeners[ev]!.push(fn);
      },
      classList: {
        add(c: string) { classes.add(c); syncClass(nodeObj); },
        remove(c: string) { classes.delete(c); syncClass(nodeObj); },
        toggle(c: string) {
          if (classes.has(c)) { classes.delete(c); return false; }
          classes.add(c); return true;
        },
        contains(c: string) { return classes.has(c); },
      },
    };
    return nodeObj;
  };
  const collectTags = (root: MockNode): string[] => {
    const out: string[] = [];
    if (root.tagName) out.push(root.tagName);
    for (const c of root.children) out.push(...collectTags(c));
    return out;
  };
  const collectText = (root: MockNode): string => {
    if (root.nodeType === 3) return root.textContent;
    if (root.children.length === 0) return root.textContent;
    return root.children.map(collectText).join('');
  };
  const findAll = (root: MockNode, pred: (n: MockNode) => boolean): MockNode[] => {
    const out: MockNode[] = [];
    if (pred(root)) out.push(root);
    for (const c of root.children) out.push(...findAll(c, pred));
    return out;
  };
  const doc = {
    createElement: (tag: string) => makeNode(1, tag),
    createTextNode: (t: string) => makeNode(3, undefined, t),
    createDocumentFragment: () => makeNode(11),
  } as unknown as Document;
  return { doc, makeNode, collectTags, collectText, findAll };
}

test('markdown parser and DOM renderer support rich formatting, streaming code fences, XSS safety, and zero <img> tags', () => {
  assert.equal(isSafeUrl('https://example.com/a?b=1'), true);
  assert.equal(isSafeUrl('http://127.0.0.1:8080'), true);
  assert.equal(isSafeUrl('mailto:test@example.com'), true);
  assert.equal(isSafeUrl('javascript:alert(1)'), false);
  assert.equal(isSafeUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeUrl('/relative/path'), false);

  const mdSample = [
    '# 总览标题',
    '',
    '普通段落含 **加粗**、*斜体*、~~删除~~、snake_case_var、`code [bot:happy]`，以及[安全链接](https://friday.local/doc)和[坏链接](javascript:alert(1))。',
    '裸网址 https://example.com/path?x=1，与图片 ![avatar](https://example.com/x.png) 与原始标签 <img src=x onerror="alert(1)">。',
    '',
    '- [x] 已完成任务',
    '- [ ] 待办任务',
    '',
    '> 引用提示 [bot:happy]',
    '',
    '| 指标 | 数值 | 状态 |',
    '| :--- | ---: | :---: |',
    '| 延迟 | 12ms | 正常 |',
    '',
    '---',
    '',
    '```ts',
    'const x = "[bot:sad]";',
    '```',
  ].join('\n');

  const blocks = parseMarkdownBlocks(mdSample);
  assert.equal(blocks[0]?.kind, 'heading');
  assert.ok(blocks.some(b => b.kind === 'list' && b.items[0]?.checked === true && b.items[1]?.checked === false));
  assert.ok(blocks.some(b => b.kind === 'quote'));
  assert.ok(blocks.some(b => b.kind === 'table' && b.aligns[0] === 'left' && b.aligns[1] === 'right' && b.aligns[2] === 'center'));
  assert.ok(blocks.some(b => b.kind === 'hr'));
  assert.ok(blocks.some(b => b.kind === 'code' && b.lang === 'ts' && b.closed === true));

  // Streaming unclosed code block stays valid
  const streamingBlocks = parseMarkdownBlocks('说明：\n```bash\necho hello');
  assert.equal(streamingBlocks[1]?.kind, 'code');
  if (streamingBlocks[1]?.kind === 'code') {
    assert.equal(streamingBlocks[1].closed, false);
    assert.equal(streamingBlocks[1].code, 'echo hello');
  }

  // Inline italic must not split snake_case_var
  const inline = parseInlineTokens('var_a_b 与 *italic* 和 `code`');
  assert.equal(inline.some(t => t.kind === 'text' && t.text.includes('var_a_b')), true);
  assert.equal(inline.some(t => t.kind === 'italic'), true);

  const mock = createMockDoc();
  let emoteCount = 0;
  const frag = renderMarkdownContent(mdSample, {
    doc: mock.doc,
    createEmote: expr => {
      emoteCount++;
      const span = mock.makeNode(1, 'span', `[emote:${expr}]`);
      span.className = 'bot-inline-emote';
      return span as unknown as Node;
    },
    createSticker: expr => mock.makeNode(1, 'span', `[sticker:${expr}]`) as unknown as Node,
  });

  const root = frag as unknown as ReturnType<typeof mock.makeNode>;
  const tags = mock.collectTags(root);
  assert.equal(tags.includes('IMG'), false, 'Markdown renderer must never emit <img> elements');
  assert.equal(tags.includes('SCRIPT'), false);
  assert.equal(tags.includes('TABLE'), true);
  assert.equal(tags.includes('BLOCKQUOTE'), true);
  assert.equal(emoteCount, 1, 'only the quote [bot:happy] renders as emote, not the one inside inline code or ts code fence');

  const links = mock.findAll(root, n => n.tagName === 'A');
  assert.equal(links.length, 2);
  assert.equal(links[0]!.href, 'https://friday.local/doc');
  assert.equal(links[0]!.target, '_blank');
  assert.equal(links[0]!.rel, 'noopener noreferrer');
  assert.equal(links[1]!.href, 'https://example.com/path?x=1');

  const renderedAllText = mock.collectText(root);
  assert.match(renderedAllText, /<img src=x onerror="alert\(1\)">/);
  assert.match(renderedAllText, /\[图片: avatar\]/);

  // Long code block (> 26 lines) gets collapsible wrapper and toggle button
  const longCode = `\`\`\`js\n${Array.from({ length: 30 }, (_, idx) => `line ${idx + 1}`).join('\n')}\n\`\`\``;
  const longFrag = renderMarkdownContent(longCode, {
    doc: mock.doc,
    createEmote: () => mock.makeNode(1, 'span') as unknown as Node,
    createSticker: () => mock.makeNode(1, 'span') as unknown as Node,
  }) as unknown as ReturnType<typeof mock.makeNode>;
  const codeBlockEl = mock.findAll(longFrag, n => n.classList.contains('md-code-block'))[0]!;
  assert.equal(codeBlockEl.classList.contains('is-collapsible'), true);
  const expandBtn = mock.findAll(longFrag, n => n.classList.contains('md-code-expand-btn'))[0]!;
  assert.match(expandBtn.textContent, /展开全部 30 行/);
  expandBtn.listeners.click?.[0]?.();
  assert.equal(codeBlockEl.classList.contains('is-expanded'), true);
  assert.equal(expandBtn.textContent, '收起代码');

  // User content keeps literal markdown headings intact while linking safe bare URLs
  const userFrag = renderUserMessageContent('# 标题保持原文\n看 https://example.com。', {
    doc: mock.doc,
    createEmote: () => mock.makeNode(1, 'span') as unknown as Node,
    createSticker: () => mock.makeNode(1, 'span') as unknown as Node,
  }) as unknown as ReturnType<typeof mock.makeNode>;
  assert.equal(mock.collectTags(userFrag).includes('H1'), false);
  const userLinks = mock.findAll(userFrag, n => n.tagName === 'A');
  assert.equal(userLinks.length, 1);
  assert.equal(userLinks[0]!.href, 'https://example.com');
});

test('chat-view helpers handle channel inheritance, filtering, time dividers, reply suppression, and routing display', () => {
  const baseAt = new Date(2026, 10, 19, 10, 0, 0).getTime();
  const uLocal: ChatMessage = { ...message('u1', 1, 'user'), at: baseAt, origin: { channel: 'local' } };
  const rLocal: ChatMessage = { ...message('r1', 2, 'assistant', 'u1'), at: baseAt + 10_000 };
  const uWechat: ChatMessage = {
    ...message('u2', 3, 'user'),
    at: baseAt + 20_000,
    origin: { channel: 'wechat', speakerName: '主人' },
  };
  const rWechat: ChatMessage = { ...message('r2', 4, 'assistant', 'u2'), at: baseAt + 30_000 };
  const sysMsg: ChatMessage = {
    ...message('s1', 5, 'assistant'),
    source: 'system',
    at: baseAt + 20 * 60_000,
    text: '定时巡检：Git 工作区干净\n第二行详情',
  };

  const lookup = new Map<string, ChatMessage>([
    [uLocal.id, uLocal],
    [rLocal.id, rLocal],
    [uWechat.id, uWechat],
    [rWechat.id, rWechat],
    [sysMsg.id, sysMsg],
  ]);

  assert.equal(resolveMessageChannel(uWechat, lookup), 'wechat');
  assert.equal(resolveMessageChannel(rWechat, lookup), 'wechat', 'assistant reply inherits parent origin channel');
  assert.equal(resolveMessageChannel(sysMsg, lookup), 'local');

  const channels = collectAvailableChannels([uLocal, rLocal, uWechat, rWechat, sysMsg], lookup, ['telegram']);
  assert.deepEqual(channels, ['all', 'local', 'wechat', 'telegram']);
  assert.equal(channelMeta('telegram').shortLabel, 'TG');

  const filtered = filterConversationMessages([uLocal, rLocal, uWechat, rWechat, sysMsg], lookup, {
    channel: 'wechat',
    hideSystem: true,
  });
  assert.deepEqual(filtered.visible.map(m => m.id), ['u2', 'r2']);
  assert.equal(filtered.hiddenSystemCount, 1);
  assert.equal(filtered.hiddenChannelCount, 2);

  // Time dividers & grouping
  assert.equal(shouldShowTimeDivider(undefined, uLocal), true);
  assert.equal(shouldShowTimeDivider(uLocal, uWechat), false);
  assert.equal(shouldShowTimeDivider(rWechat, sysMsg), true, 'gap >= 15min triggers time divider');
  assert.equal(formatTimeDivider(baseAt, baseAt + 60_000), '今天 10:00');
  assert.equal(formatTimeDivider(baseAt - 86_400_000, baseAt), '昨天 10:00');
  assert.equal(formatShortClock(baseAt), '10:00');

  const rLocalFollow: ChatMessage = { ...rLocal, id: 'r1b', seq: 2.5, at: rLocal.at + 30_000 };
  assert.equal(isGroupedWithPrevious(rLocal, rLocalFollow), true);
  assert.equal(isGroupedWithPrevious(uLocal, rLocal), false);

  // Reply reference suppression when adjacent in clean mode
  assert.equal(shouldShowReplyReference(rLocal, uLocal, false), false, 'adjacent reply hides duplicate quote in clean mode');
  assert.equal(shouldShowReplyReference(rLocal, uLocal, true), true, 'detail mode always shows reply quote');
  assert.equal(shouldShowReplyReference(rWechat, uLocal, false), true, 'out-of-order reply shows quote even in clean mode');

  // Routing display classification
  const pureReplyMsg: ChatMessage = {
    ...uLocal,
    routing: {
      at: baseAt,
      status: 'completed',
      context: { execution: 'native', cwd: '/tmp', totalWorks: 0, truncated: false, works: [], messages: [] },
      actions: [{ id: 'a1', kind: 'reply', status: 'accepted', at: baseAt }],
    },
  };
  assert.equal(classifyRoutingDisplay(pureReplyMsg, false).visible, false, 'pure direct reply stays silent in clean mode');
  assert.equal(classifyRoutingDisplay(pureReplyMsg, true).visible, true, 'detail mode exposes direct reply routing');
  assert.equal(classifyRoutingDisplay(uLocal, false).visible, false, 'historical message without routing stays silent in clean mode');
  assert.equal(classifyRoutingDisplay(uLocal, true).visible, true);

  const taskDispatchMsg: ChatMessage = {
    ...uLocal,
    routing: {
      at: baseAt,
      status: 'completed',
      context: { execution: 'native', cwd: '/tmp', totalWorks: 1, truncated: false, works: [], messages: [] },
      actions: [
        { id: 'a1', kind: 'new_work', status: 'accepted', at: baseAt, taskId: 't1', taskLabel: '检查测试', workerModel: 'claude-sonnet' },
        { id: 'a2', kind: 'search_memory', status: 'accepted', at: baseAt, searchQuery: '测试' },
      ],
    },
  };
  const compactTask = classifyRoutingDisplay(taskDispatchMsg, false);
  assert.equal(compactTask.visible, true);
  assert.equal(compactTask.taskActions.length, 1);
  assert.equal(compactTask.metaActions.length, 1);
  assert.equal(compactTask.hasExpandableDetails, true);

  const sysSummary = summarizeSystemNotice(sysMsg);
  assert.equal(sysSummary.icon, '⏱️');
  assert.equal(sysSummary.badge, '定时任务');
  assert.equal(sysSummary.expandable, true);

  assert.equal(deriveCompanionStatus('idle', 0, 0).text, '就绪');
  assert.equal(deriveCompanionStatus('working', 2, 1).tone, 'warn');
  assert.equal(formatByteSize(1536), '1.5 KB');

  const qBot = extractLeadingQuote('【引用 F.R.I.D.A.Y. 的消息】\n第一行\n第二行\n\n就按这个办');
  assert.deepEqual(qBot, {
    label: '回复 F.R.I.D.A.Y.',
    preview: '第一行 第二行',
    fullText: '第一行\n第二行',
    body: '就按这个办',
  });
  const qSelf = extractLeadingQuote('【引用你之前的消息】\n红色斗鱼照片\n\n再发一遍');
  assert.equal(qSelf?.label, '回复你');
  assert.equal(qSelf?.preview, '红色斗鱼照片');
  assert.equal(qSelf?.body, '再发一遍');

  const qSender = extractLeadingQuote('【引用 小王】\n划词引用：周报周五交\n完整原文：记得周报周五交，别忘了\n\n收到');
  assert.equal(qSender?.label, '回复 小王');
  assert.equal(qSender?.preview, '周报周五交');
  assert.equal(qSender?.body, '收到');

  const qUncached = extractLeadingQuote('【引用】\n[引用的历史消息未缓存 (ID: 7529101339772569352)]\n\n这次呢');
  assert.deepEqual(qUncached, {
    label: '回复',
    preview: '历史消息未缓存',
    fullText: '[引用的历史消息未缓存 (ID: 7529101339772569352)]',
    body: '这次呢',
    uncached: true,
  });

  assert.equal(extractLeadingQuote('普通消息没有引用'), undefined);
  assert.equal(stripLeadingQuoteForPreview('【引用】\n[引用的历史消息未缓存 (ID: 123)]\n\n这次呢'), '这次呢');
  assert.equal(stripLeadingQuoteForPreview('普通正文'), '普通正文');
});

test('plugin sidebar order reconciliation, drag reorder, keyboard stepping, and storage persistence handle edge cases cleanly', () => {
  const defaults = ['health-scale', 'fund-tracker', 'cs80-face', 'laifen', 'ninebot'];

  // Newly installed plugin appended; uninstalled plugin ignored; duplicates deduped
  assert.deepEqual(
    mergePluginOrder(['ninebot', 'removed-old', 'ninebot', 'fund-tracker'], [...defaults, 'custom-new']),
    ['ninebot', 'fund-tracker', 'health-scale', 'cs80-face', 'laifen', 'custom-new'],
  );

  // Drag reorder before / after while retaining hidden plugins in full order
  const withHidden = ['health-scale', 'disabled-ble', 'fund-tracker', 'ninebot'];
  assert.deepEqual(
    reorderPluginList(withHidden, 'ninebot', 'health-scale', 'before'),
    ['ninebot', 'health-scale', 'disabled-ble', 'fund-tracker'],
  );
  assert.deepEqual(
    reorderPluginList(withHidden, 'health-scale', 'fund-tracker', 'after'),
    ['disabled-ble', 'fund-tracker', 'health-scale', 'ninebot'],
  );

  // Keyboard Alt+ArrowUp / ArrowDown moves across visible items while preserving hidden entries
  const visible = ['health-scale', 'fund-tracker', 'ninebot'];
  assert.deepEqual(
    movePluginStep(withHidden, visible, 'fund-tracker', -1),
    ['fund-tracker', 'health-scale', 'disabled-ble', 'ninebot'],
  );
  assert.deepEqual(
    movePluginStep(withHidden, visible, 'health-scale', 1),
    ['disabled-ble', 'fund-tracker', 'health-scale', 'ninebot'],
  );
  assert.deepEqual(movePluginStep(withHidden, visible, 'health-scale', -1), withHidden);

  // Custom order detection ignores irrelevant/default order
  assert.equal(isCustomOrder([], defaults), false);
  assert.equal(isCustomOrder(defaults, defaults), false);
  assert.equal(isCustomOrder(['ninebot', 'health-scale'], defaults), true);

  // Mock storage persistence + corrupt JSON resilience
  const mem = new Map<string, string>();
  const store = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
  };
  assert.equal(readSidebarCollapsed(store), null);
  assert.equal(writeSidebarCollapsed(true, store), true);
  assert.equal(readSidebarCollapsed(store), true);
  assert.equal(writeSidebarCollapsed(false, store), true);
  assert.equal(readSidebarCollapsed(store), false);

  assert.deepEqual(readPluginOrder(store), []);
  writePluginOrder(['ninebot', 'ninebot', ' fund-tracker ', ''], store);
  assert.deepEqual(readPluginOrder(store), ['ninebot', 'fund-tracker']);
  clearPluginOrder(store);
  assert.deepEqual(readPluginOrder(store), []);

  store.setItem('friday.plugin-order', '{corrupt json');
  assert.deepEqual(readPluginOrder(store), []);
});

test('plugin catalog classification, human-readable formatting, status reasons, and search/filter/grouping work cleanly', () => {
  const plugins: PluginView[] = [
    {
      name: 'apple-devices',
      title: 'Apple 设备管理',
      description: 'SRP-6a + 2FA 获取电量',
      entry: 'index.mjs',
      enabled: true,
      runtime: 'in-process',
      voiceFastpath: true,
      isBuiltin: true,
      actions: ['status', 'devices', 'locate', 'play-sound', 'auth-login', 'config'],
      actionSpecs: [
        { name: 'status', label: '查看绑定状态', defaultArgs: {} },
        { name: 'devices', label: '获取设备列表', defaultArgs: { refresh: false } },
        { name: 'locate', label: '定位单台设备', defaultArgs: { device: '手机', refresh: false } },
        { name: 'play-sound', label: '远程响铃寻物', defaultArgs: { device: '手机', dryRun: true } },
        { name: 'auth-login', label: '发起登录', defaultArgs: { region: 'cn' } },
        { name: 'config', label: '插件配置', defaultArgs: {} },
      ],
    },
    {
      name: 'health-scale',
      title: '沃莱 A1 体脂秤',
      description: '蓝牙采集',
      entry: 'index.mjs',
      enabled: false,
      platforms: ['linux'],
      runtime: 'in-process',
      voiceFastpath: true,
      isBuiltin: true,
      actions: ['dashboard', 'status', 'scan'],
    },
    {
      name: 'miot',
      title: '全屋米家',
      description: '控制灯与空气炸锅',
      entry: 'index.mjs',
      enabled: true,
      runtime: 'in-process',
      voiceFastpath: true,
      isBuiltin: true,
      actions: ['status', 'devices', 'set', 'cook', 'config'],
    },
    {
      name: 'custom-weather',
      title: '自定义天气',
      description: '读取本机天气预报并保存在 <pluginDataDir>/config.json（仅 0600 权限保存）。第二句补充细节。',
      entry: 'index.mjs',
      enabled: true,
      runtime: 'subprocess',
      isBuiltin: false,
      actions: ['config'],
    },
  ];

  const timers: TimerView[] = [
    {
      id: 't1',
      name: '苹果低电巡航',
      instruction: '巡航',
      intervalMs: 3600_000,
      plugin: 'apple-devices',
      pluginAction: 'patrol',
      enabled: true,
      createdAt: 1000,
      nextRunAt: 2000,
      missedRuns: 0,
    },
  ];

  // Action tiering separates user-facing features from internal auth/config actions
  const appleActions = classifyPluginActions(plugins[0]!);
  assert.deepEqual(appleActions.primary.map(a => a.name), ['status', 'devices', 'locate', 'play-sound']);
  assert.deepEqual(appleActions.management.map(a => a.name), ['auth-login', 'config']);

  // Fallback when all actions are internal
  const customActions = classifyPluginActions(plugins[3]!);
  assert.deepEqual(customActions.primary.map(a => a.name), ['config']);
  assert.deepEqual(customActions.management, []);

  // Platform-disabled reason is surfaced clearly
  const healthStatus = getPluginStatusInfo(plugins[1]!);
  assert.equal(healthStatus.tone, 'amber');
  assert.equal(healthStatus.label, '仅限 Linux');
  assert.match(healthStatus.detail, /Linux/);

  // Custom plugin summary strips internal path / 0600 jargon
  const customSummary = getPluginSummary(plugins[3]!);
  assert.doesNotMatch(customSummary, /<pluginDataDir>|0600/);
  assert.match(customSummary, /天气预报/);

  // Readable default argument pills & run message summary
  assert.deepEqual(formatActionDefaultArgs({}), []);
  assert.deepEqual(formatActionDefaultArgs({ device: '手机', dryRun: true, timeoutSec: 5 }), [
    { key: 'device', label: '目标设备', value: '手机' },
    { key: 'dryRun', label: '预演模式', value: '是' },
    { key: 'timeoutSec', label: '超时', value: '5 秒' },
  ]);
  assert.match(summarizePluginRunMessage('{"ok":true,"raw":1}'), /结构化状态数据/);
  assert.equal(summarizePluginRunMessage('第一行正常\n第二行补充\n第三行忽略'), '第一行正常 · 第二行补充');

  // Filtering, searching, and grouped view follow custom order
  const surfaces = new Set(['apple-devices', 'health-scale']);
  const groupedAll = filterAndGroupPlugins({
    plugins,
    timers,
    surfaceNames: surfaces,
    order: ['health-scale', 'apple-devices'],
    filter: 'all',
    query: '',
  });
  assert.equal(groupedAll.grouped, true);
  assert.deepEqual(groupedAll.counts, { all: 4, surface: 2, extension: 2, voice: 3, timer: 1 });
  assert.deepEqual(groupedAll.surfaces.map(p => p.name), ['health-scale', 'apple-devices']);
  assert.deepEqual(groupedAll.extensions.map(p => p.name), ['miot', 'custom-weather']);

  const timerOnly = filterAndGroupPlugins({
    plugins,
    timers,
    surfaceNames: surfaces,
    order: [],
    filter: 'timer',
    query: '',
  });
  assert.equal(timerOnly.grouped, false);
  assert.deepEqual(timerOnly.items.map(p => p.name), ['apple-devices']);

  const searchHit = filterAndGroupPlugins({
    plugins,
    timers,
    surfaceNames: surfaces,
    order: [],
    filter: 'all',
    query: '响铃',
  });
  assert.equal(searchHit.grouped, false);
  assert.deepEqual(searchHit.items.map(p => p.name), ['apple-devices']);
});

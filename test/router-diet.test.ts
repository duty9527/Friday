import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ROUTER_CONTEXT_KEEP_MAX,
  ROUTER_CONTEXT_PRUNE_STEP,
  ROUTER_HISTORICAL_ASSISTANT_TEXT_MAX_CHARS,
  ROUTER_HISTORICAL_TOOL_ARG_MAX_CHARS,
  ROUTER_HISTORICAL_TOOL_RESULT_MAX_CHARS,
  compactHostEventText,
  extractCurrentTurnAssistantText,
  prepareRouterSessionModel,
  pruneRouterContextMessages,
  realFactory,
  transformAgentContextMessages,
  type AgentFactory,
} from '../src/agent.js';
import {
  Coordinator,
  compactRouterChatMemoryDirectory,
  compactRouterChatRecentContext,
  compactRouterChatWorks,
} from '../src/coordinator.js';
import { compactPluginResultForRouter } from '../src/orchestrator/router-tools.js';
import type { ModelHub } from '../src/model-hub.js';
import { resolveRuntimeMessageSession } from '../src/session.js';
import { Store } from '../src/store.js';

async function until(predicate: () => boolean | Promise<boolean>, attempts = 400) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for condition');
}

test('prepareRouterSessionModel preserves real contextWindow while disabling CoT thinking for Router', () => {
  const ds = prepareRouterSessionModel({
    id: 'deepseek-v4.1-flash',
    api: 'openai-completions',
    reasoning: true,
    contextWindow: 1_000_000,
    compat: { thinkingFormat: 'deepseek' },
    thinkingLevelMap: { off: null, low: 'low' },
  });
  assert.equal(ds.contextWindow, 1_000_000);
  assert.equal((ds.compat as Record<string, unknown>)?.thinkingFormat, 'deepseek');
  assert.equal(ds.thinkingLevelMap?.off, 'off');

  const smaller = prepareRouterSessionModel({
    id: 'gpt-4o-mini',
    api: 'openai-completions',
    reasoning: false,
    contextWindow: 32_000,
  });
  assert.equal(smaller.contextWindow, 32_000);
  assert.equal(smaller.reasoning, false);

  const missingWindow = prepareRouterSessionModel({
    id: 'glm-5.3-flash',
    api: 'openai-completions',
    reasoning: true,
    thinkingLevelMap: { off: null, high: 'high' },
  });
  assert.equal(missingWindow.contextWindow, 128_000);
  assert.equal((missingWindow as { compat?: Record<string, unknown> }).compat?.thinkingFormat, 'deepseek');
  assert.equal(missingWindow.thinkingLevelMap?.off, 'off');
});

test('pruneRouterContextMessages trims 409 messages cleanly on HOST_EVENT boundary with 24-msg KV-cache stability', () => {
  type SimMsg = { id: number; role: string; content: unknown; toolsAdded?: unknown[] };

  assert.equal(ROUTER_CONTEXT_KEEP_MAX, 24);
  assert.equal(ROUTER_CONTEXT_PRUNE_STEP, 24);
  assert.equal(ROUTER_HISTORICAL_TOOL_RESULT_MAX_CHARS, 480);
  assert.equal(ROUTER_HISTORICAL_ASSISTANT_TEXT_MAX_CHARS, 600);
  assert.equal(ROUTER_HISTORICAL_TOOL_ARG_MAX_CHARS, 360);

  // Build <= 48 messages (keepMax=24 + step=24): returned as-is
  const small: SimMsg[] = [];
  for (let i = 0; i < 24; i++) {
    small.push({ id: i * 2, role: 'user', content: [{ type: 'text', text: `HOST_EVENT\n{"kind":"CHAT","turn":${i}}` }] });
    small.push({ id: i * 2 + 1, role: 'assistant', content: [{ type: 'text', text: `ok ${i}` }] });
  }
  assert.equal(small.length, 48);
  assert.equal(pruneRouterContextMessages(small), small);

  // Build realistic 409-message Router transcript where index 384 (rawDrop for 409 with keepMax=24, step=24)
  // lands directly in the middle of an assistant toolCall -> toolResult sequence!
  const messages: SimMsg[] = [];
  let turnNum = 0;
  while (messages.length < 382) {
    messages.push({
      id: messages.length,
      role: 'user',
      content: [{ type: 'text', text: `HOST_EVENT\n{"kind":"CHAT","turn":${turnNum}}` }],
    });
    if (turnNum % 2 === 0 && messages.length <= 378) {
      messages.push({
        id: messages.length,
        role: 'assistant',
        content: [{ type: 'toolCall', id: `tc-${turnNum}`, name: 'run_plugin', arguments: '{}' }],
      });
      messages.push({
        id: messages.length,
        role: 'toolResult',
        content: [{ type: 'text', text: `result-${turnNum}` }],
      });
    }
    messages.push({
      id: messages.length,
      role: 'assistant',
      content: [{ type: 'text', text: `reply-${turnNum}` }],
    });
    turnNum++;
  }
  assert.equal(messages.length, 382);

  // Index 382: user HOST_EVENT, 383: assistant toolCall, 384 (rawDrop!): toolResult, 385: non-HOST_EVENT user note,
  // 386: assistant final reply, 387: clean HOST_EVENT user turn boundary!
  messages.push({
    id: 382,
    role: 'user',
    content: [{ type: 'text', text: 'HOST_EVENT\n{"kind":"CHAT","turn":"pre-boundary"}' }],
  });
  messages.push({
    id: 383,
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'tc-split-guard', name: 'inspect_work', arguments: '{}' }],
  });
  messages.push({
    id: 384,
    role: 'toolResult',
    content: [{ type: 'text', text: 'must-not-be-orphaned-at-head' }],
  });
  messages.push({
    id: 385,
    role: 'user',
    content: [{ type: 'text', text: 'plain internal note without host event header' }],
  });
  messages.push({
    id: 386,
    role: 'assistant',
    content: [{ type: 'text', text: 'done pre-boundary' }],
  });
  messages.push({
    id: 387,
    role: 'user',
    content: [{ type: 'text', text: 'HOST_EVENT\n{"kind":"CHAT","turn":"clean-anchor"}' }],
  });
  messages.push({
    id: 388,
    role: 'assistant',
    content: [{ type: 'text', text: 'clean-anchor-reply' }],
  });

  while (messages.length < 408) {
    const idx = messages.length;
    if ((idx - 389) % 2 === 0) {
      messages.push({
        id: idx,
        role: 'user',
        content: [{ type: 'text', text: `HOST_EVENT\n{"kind":"CHAT","id":${idx}}` }],
      });
    } else {
      messages.push({
        id: idx,
        role: 'assistant',
        content: [{ type: 'text', text: `reply-${idx}` }],
      });
    }
  }
  // Index 408 -> total length = 409 (active user turn at tail)
  messages.push({
    id: 408,
    role: 'user',
    content: [{ type: 'text', text: 'HOST_EVENT\n{"kind":"CHAT","turn":"latest"}' }],
  });
  assert.equal(messages.length, 409);

  const pruned409 = pruneRouterContextMessages(messages);
  assert.equal(pruned409[0]?.id, 387, 'slices cleanly at first HOST_EVENT user turn >= rawDrop (384), never orphaning toolResult 384');
  assert.equal(pruned409[0]?.role, 'user');
  assert.equal(pruned409.length, 409 - 387);
  assert.equal(pruned409.some(m => m.id === 384), false);

  // Verify KV-cache chunk stability: growing from 409 up to 431 keeps the EXACT same slice head (id === 387)
  const grown = [...messages];
  for (let len = 410; len <= 431; len++) {
    grown.push(
      len % 2 === 1
        ? { id: len - 1, role: 'assistant', content: [{ type: 'text', text: `r-${len}` }] }
        : { id: len - 1, role: 'user', content: [{ type: 'text', text: `HOST_EVENT\n{"kind":"CHAT","len":${len}}` }] },
    );
    const prunedNext = pruneRouterContextMessages(grown);
    assert.equal(prunedNext[0]?.id, 387, `slice anchor stays pinned at 387 for length ${len}`);
  }

  // At 432 (next 24-message step: rawDrop advances from 384 to 408), anchor advances cleanly to >= 408
  grown.push({ id: 431, role: 'user', content: [{ type: 'text', text: 'HOST_EVENT\n{"kind":"CHAT","len":432}' }] });
  assert.equal(grown.length, 432);
  const pruned432 = pruneRouterContextMessages(grown);
  assert.ok((pruned432[0]?.id ?? 0) >= 408, 'anchor advances once 24-message chunk fills');
  assert.equal(pruned432[0]?.role, 'user');

  // Leading SDK system message (systemPrompt + toolsAdded) is preserved at index 0 when present
  const withSystem: SimMsg[] = [
    { id: -1, role: 'system', content: 'You are F.R.I.D.A.Y.', toolsAdded: [{ name: 'start_work' }] },
    ...messages,
  ];
  const prunedWithSystem = pruneRouterContextMessages(withSystem);
  assert.equal(prunedWithSystem[0]?.role, 'system');
  assert.equal(prunedWithSystem[0]?.id, -1);
  assert.equal(prunedWithSystem[1]?.id, 387);

  // Backward fallback when no HOST_EVENT user boundary exists ahead in [rawDrop, rawDrop + step]
  const longToolTurn: SimMsg[] = [];
  for (let i = 0; i < 4; i++) {
    longToolTurn.push({ id: longToolTurn.length, role: 'user', content: `HOST_EVENT\n{"kind":"CHAT","t":${i}}` });
    longToolTurn.push({ id: longToolTurn.length, role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
  }
  // Index 8 is the last clean HOST_EVENT user turn before a 40-message tool loop (total length = 49, rawDrop = 24)
  longToolTurn.push({ id: 8, role: 'user', content: 'HOST_EVENT\n{"kind":"CHAT","t":"long-loop"}' });
  while (longToolTurn.length < 49) {
    const id = longToolTurn.length;
    longToolTurn.push(
      id % 2 === 1
        ? { id, role: 'assistant', content: [{ type: 'toolCall', id: `c-${id}`, name: 'inspect_work', arguments: '{}' }] }
        : { id, role: 'toolResult', content: [{ type: 'text', text: `res-${id}` }] },
    );
  }
  assert.equal(longToolTurn.length, 49);
  const prunedFallback = pruneRouterContextMessages(longToolTurn);
  assert.equal(prunedFallback[0]?.id, 8, 'falls back backwards to clean HOST_EVENT boundary 8 instead of splitting tool loop');
});

test('Router transformContext compacts historical toolResult <=480, assistant text <=600, toolCall args <=360 & strips thinking while preserving Worker contracts', async () => {
  const longToolOutput = 'T'.repeat(2_400);
  const currentToolOutput = 'C'.repeat(2_400);
  const longHistAssistantText = 'H'.repeat(1_200);
  const bulkyHistArgs = {
    input: JSON.stringify({
      instruction: 'B'.repeat(900),
      summary: 'running long analysis',
      cwd: '/tmp/project',
      extra: 'Z'.repeat(400),
    }),
  };
  const bulkyActiveArgs = { input: JSON.stringify({ instruction: 'A'.repeat(900) }) };
  const sampleMessages = [
    {
      role: 'user',
      content: [
        { type: 'image', data: 'base64img', mimeType: 'image/png' },
        {
          type: 'text',
          text: `HOST_EVENT\n${JSON.stringify({
            kind: 'CHAT',
            deliveryChannel: 'xiaoai',
            voiceModeConstraint: 'short spoken',
            message: { id: 'u1', text: '开客厅灯', routing: { status: 'processing' } },
            works: [{ id: 'w1' }],
            memoryDirectory: { totalActive: 1, truncated: false, items: [] },
          })}`,
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'internal CoT step 1 '.repeat(50) },
        { type: 'toolCall', id: 'call-1', name: 'run_plugin', arguments: bulkyHistArgs },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'run_plugin',
      isError: false,
      content: [{ type: 'text', text: longToolOutput }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'internal CoT step 2' },
        { type: 'text', text: longHistAssistantText },
      ],
      usage: {
        input: 221,
        output: 11,
        cacheRead: 138_112,
        cacheWrite: 0,
        totalTokens: 138_344,
        cost: { input: 0.001, output: 0.001, cacheRead: 0.001, cacheWrite: 0, total: 0.003 },
      },
    },
    // Historical assistant without thinking blocks still carries pre-prune usage that must be zeroed for Router
    {
      role: 'assistant',
      content: [{ type: 'text', text: '好，让小爱开始放了。[[END]]' }],
      usage: {
        input: 221,
        output: 11,
        cacheRead: 138_112,
        cacheWrite: 0,
        totalTokens: 138_344,
        cost: { input: 0.001, output: 0.001, cacheRead: 0.001, cacheWrite: 0, total: 0.003 },
      },
    },
    // Edge case: historical assistant message that ONLY has thinking + empty text -> keep thinking so content never empties
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'sole thinking fallback' },
        { type: 'text', text: '   ' },
      ],
    },
    // Current active turn (lastUser at index 6)
    {
      role: 'user',
      content: [
        { type: 'image', data: 'currentimg', mimeType: 'image/png' },
        {
          type: 'text',
          text: `HOST_EVENT\n${JSON.stringify({
            kind: 'CHAT',
            deliveryChannel: 'xiaoai',
            voiceModeConstraint: 'short spoken',
            message: { id: 'u2', text: '现在几度', routing: { status: 'processing' } },
            works: [{ id: 'w1' }],
            memoryDirectory: { totalActive: 1, truncated: false, items: [] },
          })}`,
        },
      ],
    },
    // Active-turn in-progress tool round (index > lastUser): must NOT truncate or strip active-turn toolCall args/toolResult/thinking
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'current turn reasoning' },
        { type: 'toolCall', id: 'call-2', name: 'run_plugin', arguments: bulkyActiveArgs },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'call-2',
      toolName: 'run_plugin',
      isError: false,
      content: [{ type: 'text', text: currentToolOutput }],
    },
  ];

  // 1. Router mode via real SdkAgent.session.agent.transformContext
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-router-diet-sdk-'));
  try {
    const factory = await realFactory(home, {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-not-a-real-key',
    });
    const routerAgent = await factory.create('router', 'router-diet-check', [
      { name: 'dispatch_worker', description: 'test tool', execute: async () => 'ok' },
    ]);
    const workerAgent = await factory.create('worker', 'worker-diet-check', [
      { name: 'start_read', description: 'test tool', execute: async () => 'ok' },
    ]);
    try {
      const routerSession = (routerAgent as unknown as {
        session: {
          model?: { contextWindow?: number };
          settingsManager: { getCompactionSettings: () => { enabled: boolean } };
          agent: { transformContext: (msgs: unknown[]) => Promise<typeof sampleMessages> };
        };
      }).session;
      const workerSession = (workerAgent as unknown as {
        session: {
          model?: { contextWindow?: number };
          settingsManager: { getCompactionSettings: () => { enabled: boolean } };
          agent: { transformContext: (msgs: unknown[]) => Promise<typeof sampleMessages> };
        };
      }).session;

      assert.equal(routerSession.model?.contextWindow, 128_000, 'Router preserves full model contextWindow');
      assert.equal(routerSession.settingsManager.getCompactionSettings().enabled, false, 'Router disables SDK auto-compaction');
      assert.equal(workerSession.settingsManager.getCompactionSettings().enabled, true, 'Worker keeps SDK auto-compaction enabled');

      const routerOut = await routerSession.agent.transformContext(sampleMessages);
      // Historical user message: image stripped & transient world snapshot stripped
      const histUserBlocks = routerOut[0]!.content as Array<{ type: string; text?: string }>;
      assert.equal(histUserBlocks.some(b => b.type === 'image'), false);
      const histUserParsed = JSON.parse(histUserBlocks[0]!.text!.slice('HOST_EVENT\n'.length));
      assert.equal(histUserParsed.works, undefined);
      assert.equal(histUserParsed.voiceModeConstraint, undefined);

      // Historical assistant messages: thinking stripped, bulky toolCall args & long text compacted, usage zeroed without mutating originals
      const histToolCallBlocks = routerOut[1]!.content as Array<{ type: string; arguments?: { input?: string } }>;
      assert.deepEqual(histToolCallBlocks.map(b => b.type), ['toolCall']);
      const compactedArgsJson = JSON.stringify(histToolCallBlocks[0]!.arguments);
      assert.ok(
        compactedArgsJson.length <= ROUTER_HISTORICAL_TOOL_ARG_MAX_CHARS,
        `Expected historical toolCall args <= ${ROUTER_HISTORICAL_TOOL_ARG_MAX_CHARS}, got ${compactedArgsJson.length}`,
      );
      assert.equal(typeof histToolCallBlocks[0]!.arguments?.input, 'string', 'preserves {input} wrapper schema');

      const histAssistantBlocks = routerOut[3]!.content as Array<{ type: string; text?: string }>;
      assert.deepEqual(histAssistantBlocks.map(b => b.type), ['text']);
      assert.ok(
        (histAssistantBlocks[0]!.text?.length ?? 0) <= ROUTER_HISTORICAL_ASSISTANT_TEXT_MAX_CHARS,
        `Expected historical assistant text <= ${ROUTER_HISTORICAL_ASSISTANT_TEXT_MAX_CHARS}, got ${histAssistantBlocks[0]!.text?.length}`,
      );
      assert.equal((routerOut[3] as { usage?: { totalTokens?: number } }).usage?.totalTokens, 0);
      assert.equal((routerOut[4] as { usage?: { totalTokens?: number } }).usage?.totalTokens, 0);
      assert.equal((sampleMessages[3] as { usage?: { totalTokens?: number } }).usage?.totalTokens, 138_344);
      assert.equal((sampleMessages[4] as { usage?: { totalTokens?: number } }).usage?.totalTokens, 138_344);
      // Historical assistant with ONLY thinking + whitespace keeps thinking block
      assert.equal(
        (routerOut[5]!.content as Array<{ type: string }>).some(b => b.type === 'thinking'),
        true,
      );

      // Historical toolResult (>480 chars) compacted within <=480 total chars + suffix
      const histToolText = (routerOut[2]!.content as Array<{ type: string; text: string }>)[0]!.text;
      assert.ok(
        histToolText.length <= ROUTER_HISTORICAL_TOOL_RESULT_MAX_CHARS,
        `Expected historical toolResult <= ${ROUTER_HISTORICAL_TOOL_RESULT_MAX_CHARS}, got ${histToolText.length}`,
      );
      assert.equal(histToolText.endsWith('…[historical tool output compacted]'), true);

      // Active user message: keeps image & voiceModeConstraint & works, strips message.routing
      const curUserBlocks = routerOut[6]!.content as Array<{ type: string; text?: string }>;
      assert.equal(curUserBlocks.some(b => b.type === 'image'), true);
      const curUserParsed = JSON.parse(curUserBlocks[1]!.text!.slice('HOST_EVENT\n'.length));
      assert.equal(curUserParsed.message.routing, undefined);
      assert.equal(curUserParsed.voiceModeConstraint, 'short spoken');
      assert.equal(curUserParsed.works.length, 1);

      // Active-turn assistant & toolCall args & toolResult (index > lastUser) remain uncompacted
      const activeAssistBlocks = routerOut[7]!.content as Array<{ type: string; arguments?: unknown }>;
      assert.equal(activeAssistBlocks.some(b => b.type === 'thinking'), true);
      assert.deepEqual(activeAssistBlocks.find(b => b.type === 'toolCall')?.arguments, bulkyActiveArgs);
      assert.equal(
        (routerOut[8]!.content as Array<{ type: string; text: string }>)[0]!.text,
        currentToolOutput,
      );

      // Worker mode: does NOT truncate historical toolResult, compact toolCall args, strip worker thinking, or zero worker usage
      const workerOut = await workerSession.agent.transformContext(sampleMessages);
      assert.equal(
        (workerOut[2]!.content as Array<{ type: string; text: string }>)[0]!.text,
        longToolOutput,
      );
      assert.equal(
        (workerOut[1]!.content as Array<{ type: string }>).some(b => b.type === 'thinking'),
        true,
      );
      assert.deepEqual(
        (workerOut[1]!.content as Array<{ type: string; arguments?: unknown }>).find(b => b.type === 'toolCall')?.arguments,
        bulkyHistArgs,
      );
      assert.equal(
        (workerOut[3]!.content as Array<{ type: string; text?: string }>).find(b => b.type === 'text')?.text,
        longHistAssistantText,
      );
      assert.equal((workerOut[4] as { usage?: { totalTokens?: number } }).usage?.totalTokens, 138_344);
    } finally {
      routerAgent.close();
      workerAgent.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  // Direct pure helper check + compactHostEventText regression check
  const direct = transformAgentContextMessages(sampleMessages, 'router');
  assert.equal(
    (direct[2]!.content as Array<{ text: string }>)[0]!.text.endsWith('…[historical tool output compacted]'),
    true,
  );
  const rawTask = `HOST_EVENT\n${JSON.stringify({ kind: 'TASK', taskId: 't1', cwd: '/tmp' })}`;
  assert.equal(compactHostEventText(rawTask, true), rawTask);
});

test('resolveRuntimeMessageSession skips remote decideSessionContinuity on xiaoai while preserving wechat JEV resolution', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-xiaoai-sess-'));
  const store = new Store(home);
  try {
    let decisionCalls = 0;
    const mockModelHub = {
      hasDecisionEngine: () => true,
      decideSessionContinuity: async () => {
        decisionCalls++;
        return {
          sameSession: true,
          probability: 0.94,
          confidence: 0.91,
          relation: 'topic_continuity' as const,
          source: 'gemini-decision-1' as const,
          usage: { inputTokens: 110, totalTokens: 120 },
        };
      },
    } as unknown as ModelHub;

    const baseAt = Date.now() - 400_000;

    // 1. xiaoai channel (>15s gap, non-question assistant reply so checkDeterministicCausalLink returns undefined
    // and execution reaches line 446): MUST make 0 calls to decideSessionContinuity and fall straight through to instant local heuristic!
    const xiaoaiPrev = store.conversation.create({
      id: 'xa-u1',
      role: 'user',
      origin: { channel: 'xiaoai', channelId: 'xa-main', senderId: 'lx06' },
      sessionId: 'session:flow:xa-u1',
      text: '空气炸锅现在多少度',
      status: 'completed',
      paths: [],
      mode: 'real',
      at: baseAt,
    });
    store.conversation.create({
      id: 'xa-r1',
      replyTo: xiaoaiPrev.id,
      role: 'assistant',
      origin: { channel: 'xiaoai', channelId: 'xa-main', senderId: 'lx06' },
      sessionId: 'session:flow:xa-u1',
      text: '空气炸锅目前是 180 度。',
      status: 'completed',
      paths: [],
      mode: 'real',
      at: baseAt + 2_000,
    });
    const xiaoaiCur = store.conversation.create({
      id: 'xa-u2',
      role: 'user',
      origin: { channel: 'xiaoai', channelId: 'xa-main', senderId: 'lx06' },
      text: '空气炸锅烹饪倒计时剩几分钟',
      status: 'queued',
      paths: [],
      mode: 'real',
      at: baseAt + 40_000,
    });

    const xiaoaiResolved = await resolveRuntimeMessageSession(store, mockModelHub, xiaoaiCur, [], undefined, { skipAiContinuity: true });
    assert.equal(decisionCalls, 0, 'xiaoai must never block on remote decideSessionContinuity');
    assert.equal(xiaoaiResolved.sessionId, 'session:flow:xa-u1');
    assert.equal(xiaoaiResolved.sessionLink?.source, 'heuristic');

    // Unrelated xiaoai utterance >15s later also skips decideSessionContinuity and starts fresh session locally
    const xiaoaiNewTopic = store.conversation.create({
      id: 'xa-u3',
      role: 'user',
      origin: { channel: 'xiaoai', channelId: 'xa-main', senderId: 'lx06' },
      text: '明天上海天气怎么样',
      status: 'queued',
      paths: [],
      mode: 'real',
      at: baseAt + 190_000,
    });
    const xiaoaiSplit = await resolveRuntimeMessageSession(store, mockModelHub, xiaoaiNewTopic, [], undefined, { skipAiContinuity: true });
    assert.equal(decisionCalls, 0, 'unrelated xiaoai utterance still makes 0 remote decision calls');
    assert.equal(xiaoaiSplit.sessionId, 'session:flow:xa-u3');

    // 2. wechat channel (>15s gap): MUST still call decideSessionContinuity as before!
    const wxPrev = store.conversation.create({
      id: 'wx-u1',
      role: 'user',
      origin: { channel: 'wechat', conversationId: 'boss-wx', senderId: 'boss-wx' },
      sessionId: 'session:flow:wx-u1',
      text: '排查一下网关超时日志',
      status: 'completed',
      paths: [],
      mode: 'real',
      at: baseAt + 250_000,
    });
    store.conversation.create({
      id: 'wx-r1',
      replyTo: wxPrev.id,
      role: 'assistant',
      origin: { channel: 'wechat', conversationId: 'boss-wx', senderId: 'boss-wx' },
      sessionId: 'session:flow:wx-u1',
      text: '发现两处上游超时。',
      status: 'completed',
      paths: [],
      mode: 'real',
      at: baseAt + 255_000,
    });
    const wxCur = store.conversation.create({
      id: 'wx-u2',
      role: 'user',
      origin: { channel: 'wechat', conversationId: 'boss-wx', senderId: 'boss-wx' },
      text: '网关重试上限设了多少',
      status: 'queued',
      paths: [],
      mode: 'real',
      at: baseAt + 295_000,
    });

    const wxResolved = await resolveRuntimeMessageSession(store, mockModelHub, wxCur, []);
    assert.equal(decisionCalls, 1, 'wechat continues using gemini-decision-1 session continuity');
    assert.equal(wxResolved.sessionId, 'session:flow:wx-u1');
    assert.equal(wxResolved.sessionLink?.source, 'gemini-decision-1');
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Coordinator CHAT payload with 40 completed works + 24 memories shrinks cleanly, omits context when leafId exists & keeps Web routing.context intact', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-chat-diet-'));
  const capturedChatPayloads: string[] = [];
  let routerLeafId: string | undefined;

  const factory: AgentFactory = {
    mode: 'real',
    nativeTools: true,
    async create(role) {
      return {
        get leafId() {
          return role === 'router' ? routerLeafId : undefined;
        },
        close() {},
        async prompt(text) {
          if (role === 'router') {
            const parsed = JSON.parse(text) as { kind?: string };
            if (parsed.kind === 'CHAT') capturedChatPayloads.push(text);
          }
          return '好的老板，已处理。';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory, { skipExecutor: true });
  try {
    await coordinator.ready();

    // Seed 40 completed works with bulky prompts (600 chars) and reports (1500 chars)
    for (let i = 0; i < 40; i++) {
      coordinator.store.create({
        id: `work-done-${i}`,
        requestId: `req-work-${i}`,
        fingerprint: `fp-${i}`,
        prompt: `任务 #${i} 详细背景说明：${'排查生产环境网关延迟与设备状态同步逻辑，核对日志与缓存命中率。'.repeat(20)}`,
        status: 'completed',
        revision: 1,
        files: [],
        mode: 'real',
        createdAt: Date.now() - (40 - i) * 10_000,
        limitMs: 300_000,
        activeMs: 5_000,
        report: `第 ${i} 号任务完整核查报告：${'已完成模块级压测与边界条件验证，确认各项指标均符合预期。'.repeat(55)}`,
        execution: 'native',
        cwd: home,
        profile: 'coding',
        modelTier: 'balanced',
        origin: i >= 38
          ? { channel: 'xiaoai', channelId: 'xa-1', senderId: 'lx06' }
          : { channel: 'wechat', conversationId: 'boss-1', senderId: 'boss-1' },
      });
    }

    // Seed 24 genuinely distinct active global memories (zero shared boilerplate so lexical dedup keeps all 24)
    const distinctCards: Array<[string, string, string]> = [
      ['PostgreSQL分区表维护', '按月创建历史订单Range分区并定期执行VacuumAnalyze更新统计信息。', 'postgres'],
      ['Nginx反向代理缓冲区', '开启ProxyBuffering并调大UpstreamHeaderBufferSize避免大Cookie截断。', 'nginx'],
      ['Redis持久化RDB与AOF', '主从同步开启ReplDisklessSync降低磁盘IO抖动并配置AppendfsyncEverysec。', 'redis'],
      ['Docker多阶段镜像构建', '使用Alpine基础镜像剥离编译期Toolchain并将二进制产物体积压到20MB以内。', 'docker'],
      ['Kubernetes就绪与存活探针', 'ReadinessProbe检测下游依赖连通性而LivenessProbe仅探测事件循环死锁。', 'k8s'],
      ['Kafka消费者组再平衡', '调整SessionTimeoutMs与MaxPollIntervalMs避免批处理耗时触发Rebalance风暴。', 'kafka'],
      ['Prometheus直方图指标', '通过HistogramQuantile计算P99分位延迟而非使用不可聚合的Summary类型。', 'prometheus'],
      ['GraphQL深度限制中间件', '拦截嵌套层数超过五层的QueryAst并限制单次Resolver批加载数量。', 'graphql'],
      ['WebSocket心跳保活帧', '每十五秒互发PingPong控制帧并在连续三次超时后主动断开僵尸套接字。', 'websocket'],
      ['OAuth2状态防CSRF校验', '授权跳转生成随机State与PKCECodeVerifier并在回调端一次性原子消费。', 'oauth'],
      ['Stripe支付回调幂等处理', '校验StripeSignature签名后以EventId为唯一键写入幂等流水表防止重复入账。', 'stripe'],
      ['S3对象存储预签名直传', '服务端签发十分钟有效期的PutObjectPreSignedUrl供前端直接上传媒体文件。', 's3'],
      ['SQLite高并发WAL模式', '启用JournalModeWAL并将BusyTimeout设为五千毫秒减少写锁冲突。', 'sqlite'],
      ['TypeScript严格空值检查', '启用StrictNullChecks与NoUncheckedIndexedAccess消除运行时未定义属性崩溃。', 'ts'],
      ['ESBuild外部依赖排除', '后端打包配置PackagesExternal并在构建钩子注入版本构建时间戳常量。', 'esbuild'],
      ['Playwright无头浏览器截图', '拦截字体与分析脚本加速页面首屏渲染并通过NetworkIdle确保图表重绘完毕。', 'playwright'],
      ['Telegram机器人长轮询代理', '设置GetUpdates长轮询超时二十五秒并使用AbortController支持优雅停机。', 'telegram'],
      ['微信企业号XML加解密', '依据EncodingAESKey执行PKCS7补齐后通过AES256CBC解密客服回调报文。', 'wechat'],
      ['钉钉机器人HMAC加签验证', '拼接时间戳与密钥执行HmacSHA256签名并对超过一小时的过期请求直接拒收。', 'dingtalk'],
      ['米家BE6500蓝牙中枢网关', '局域网优先经路由器SSH读取BLEMesh节点温度亮度并通过MiIO补齐设备状态。', 'miot'],
      ['海信电视DLNA投屏协议', '通过SSDP发现MediaRenderer描述文件并调用AVTransportSetAVTransportURI推送流地址。', 'dlna'],
      ['智能体脂秤BIA阻抗换算', '解析BLE广播包中的双频生物电阻抗原始数值并按性别身高年龄计算体脂肌肉率。', 'scale'],
      ['公募基金盘中实时估值', '抓取重仓股票实时涨跌幅加权测算净值估算偏差并在收盘后以官方公布净值为准。', 'fund'],
      ['主机磁盘温度静默巡检', '检测根目录剩余空间与NVMe传感器温度仅在连续异常时向主人推送告警简报。', 'pulse'],
    ];
    for (let i = 0; i < 24; i++) {
      const [topic, content, tag] = distinctCards[i]!;
      coordinator.store.saveMemory({
        topic,
        content,
        tags: [tag],
        cwd: home,
      });
    }

    // Seed 12 prior long conversation messages (each ~1,200 chars)
    const baseAt = Date.now() - 600_000;
    for (let i = 0; i < 6; i++) {
      const u = coordinator.store.conversation.create({
        id: `hist-u-${i}`,
        role: 'user',
        text: `历史问题 ${i}：${'请帮我汇总今天各项后台巡检与系统运行状况。'.repeat(40)}`,
        status: 'completed',
        paths: [],
        mode: 'real',
        at: baseAt + i * 20_000,
      });
      coordinator.store.conversation.create({
        id: `hist-r-${i}`,
        replyTo: u.id,
        role: 'assistant',
        text: `历史回复 ${i}：${'各项巡检指标正常，未发现异常抖动或队列堆积。'.repeat(45)}`,
        status: 'completed',
        paths: [],
        mode: 'real',
        at: baseAt + i * 20_000 + 3_000,
      });
    }

    // 1. Fresh Router turn (leafId undefined): local admin sees all 40 works, compacts settled<=3 without reportPreview
    const msg1 = coordinator.chat('diet-req-1', '现在整体情况怎么样？', [], {
      channel: 'local',
    });
    await until(() => coordinator.store.conversation.get(msg1.id).status === 'completed');

    assert.equal(capturedChatPayloads.length, 1);
    const rawPayload1 = capturedChatPayloads[0]!;
    assert.ok(
      rawPayload1.length < 12_000,
      `Expected CHAT payload < 12_000 chars, got ${rawPayload1.length}`,
    );

    const parsed1 = JSON.parse(rawPayload1) as {
      works: Array<Record<string, unknown> & { id: string; prompt: string; reportPreview?: string }>;
      memoryDirectory: { totalActive: number; items: Array<Record<string, unknown>> };
      context?: Array<{ id: string; text: string }>;
    };
    assert.equal(parsed1.works.length, 3, '40 settled works capped to 3 most recent settled works');
    assert.equal(parsed1.works[0]?.id, 'work-done-37');
    assert.equal(parsed1.works[2]?.id, 'work-done-39');
    assert.ok(parsed1.works.every(w => w.prompt.length <= 160 && !('reportPreview' in w)));

    assert.equal(parsed1.memoryDirectory.totalActive, 24);
    assert.equal(parsed1.memoryDirectory.items.length, 12, 'non-xiaoai CHAT L0 memoryDirectory capped to 12');
    assert.ok(parsed1.memoryDirectory.items.every(item => !('preview' in item) && !('synapses' in item)));

    assert.equal(parsed1.context?.length, 4, 'cold Router session includes compact context capped to last 4 entries');
    assert.ok(parsed1.context!.every(c => c.text.length <= 280));

    // Web UI routing.context MUST remain unmutated (40 works, 24 memoryDirectory items)
    const savedMsg1 = coordinator.store.conversation.get(msg1.id);
    assert.equal(savedMsg1.routing?.context.works.length, 40);
    assert.equal(savedMsg1.routing?.context.memoryDirectory?.items.length, 24);

    // 2. Subsequent turn when Router already has prior leafId + XiaoAI + active works: omits context, L0 <= 10, settled <= 2
    routerLeafId = 'router-leaf-after-turn-1';
    const activeRunning = {
      id: 'work-active-running',
      requestId: 'req-active-1',
      fingerprint: 'fp-active-1',
      prompt: 'R'.repeat(500),
      status: 'running' as const,
      revision: 1,
      files: [],
      mode: 'real' as const,
      createdAt: Date.now() - 2_000,
      limitMs: 300_000,
      activeMs: 1_000,
      report: 'P'.repeat(700),
      execution: 'native' as const,
      cwd: home,
      origin: { channel: 'xiaoai' as const, channelId: 'xa-1', senderId: 'lx06' },
    };
    coordinator.store.create(activeRunning);
    const activeQuestion = {
      id: 'work-active-question',
      requestId: 'req-active-2',
      fingerprint: 'fp-active-2',
      prompt: 'Q'.repeat(500),
      status: 'paused' as const,
      revision: 1,
      files: [],
      mode: 'real' as const,
      createdAt: Date.now() - 1_000,
      limitMs: 300_000,
      activeMs: 1_000,
      pendingQuestion: { question: '是否覆盖旧配置？', options: ['覆盖', '保留'], askedAt: Date.now() },
      execution: 'native' as const,
      cwd: home,
      origin: { channel: 'xiaoai' as const, channelId: 'xa-1', senderId: 'lx06' },
    };
    coordinator.store.create(activeQuestion);

    const msg2 = coordinator.chat('diet-req-2', '后台还有什么在跑', [], {
      channel: 'xiaoai',
      channelId: 'xa-1',
      senderId: 'lx06',
    });
    await until(() => coordinator.store.conversation.get(msg2.id).status === 'completed');

    const rawPayload2 = capturedChatPayloads[1]!;
    assert.ok(rawPayload2.length < 12_000, `Expected XiaoAI CHAT payload < 12_000 chars, got ${rawPayload2.length}`);
    const parsed2 = JSON.parse(rawPayload2) as {
      works: Array<Record<string, unknown> & { id: string; prompt: string; reportPreview?: string; pendingQuestion?: { question: string } }>;
      memoryDirectory: { items: Array<Record<string, unknown>> };
      context?: unknown;
    };
    assert.equal('context' in parsed2, false, 'CHAT omits recentContext when Router already has prior leafId');
    assert.equal(parsed2.memoryDirectory.items.length, 10, 'xiaoai CHAT L0 memoryDirectory capped to 10');
    assert.ok(parsed2.memoryDirectory.items.every(item => !('preview' in item) && !('synapses' in item)));
    assert.equal(parsed2.works.length, 4, '2 active/pendingQuestion works + 2 recent settled works on xiaoai');
    const runEntry = parsed2.works.find(w => w.id === 'work-active-running')!;
    const qEntry = parsed2.works.find(w => w.id === 'work-active-question')!;
    assert.equal(runEntry.prompt.length, 360);
    assert.equal(runEntry.reportPreview?.length, 300);
    assert.equal(qEntry.prompt.length, 360);
    assert.equal(qEntry.pendingQuestion?.question, '是否覆盖旧配置？');
    assert.ok(
      parsed2.works
        .filter(w => w.id !== 'work-active-running' && w.id !== 'work-active-question')
        .every(w => !('reportPreview' in w)),
    );

    // 3. Fastpath turns saved to SQLite while Router leafId exists must be bridged back via compact context
    coordinator.recordFastpathTurn({
      channelId: 'xa-1',
      senderId: 'lx06',
      userText: '打开客厅灯',
      replyText: '已打开客厅灯',
      pluginName: 'miot',
      action: 'handled',
      latencyMs: 320,
    });
    const msg3 = coordinator.chat('diet-req-3', '打开刚才那个记录', [], {
      channel: 'xiaoai',
      channelId: 'xa-1',
      senderId: 'lx06',
    });
    await until(() => coordinator.store.conversation.get(msg3.id).status === 'completed');

    const rawPayload3 = capturedChatPayloads[2]!;
    const parsed3 = JSON.parse(rawPayload3) as {
      context?: Array<{ role: string; text: string }>;
    };
    assert.ok(
      Array.isArray(parsed3.context) && parsed3.context.length <= 6,
      'CHAT bridges recent context when prior fastpath turn exists',
    );
    assert.ok(parsed3.context!.some(c => c.role === 'user' && c.text.includes('打开客厅灯')));
    assert.ok(parsed3.context!.some(c => c.role === 'assistant' && c.text.includes('已打开客厅灯')));

    // Pure unit checks for compactRouterChatWorks, L0 compactRouterChatMemoryDirectory, and structured recentContext
    const sixActive = Array.from({ length: 6 }, (_, idx) => ({
      ...coordinator.store.get(activeRunning.id),
      id: `act-${idx}`,
      status: 'running' as const,
    }));
    const tenSettled = Array.from({ length: 10 }, (_, idx) => ({
      ...coordinator.store.get('work-done-0'),
      id: `set-${idx}`,
      status: 'completed' as const,
    }));
    const defaultSettled3 = compactRouterChatWorks([...tenSettled, ...sixActive]);
    assert.equal(defaultSettled3.length, 9, 'default settled limit is 3: 6 active + 3 settled = 9');
    const capped12 = compactRouterChatWorks([...tenSettled, ...sixActive], 10);
    assert.equal(capped12.length, 12, '6 active + 6 settled respects hard cap of 12 while keeping all 6 active');
    assert.equal(capped12.filter(w => w.status === 'running').length, 6);

    const trimmedDir = compactRouterChatMemoryDirectory({
      totalActive: 1,
      truncated: false,
      items: [{
        id: 'm1',
        topic: 't',
        tags: ['a'],
        updatedAt: 1,
        preview: 'X'.repeat(260),
        synapses: [{ targetId: 'm2', relation: 'explicit', weight: 0.9, updatedAt: 1 }],
      }] as unknown as Parameters<typeof compactRouterChatMemoryDirectory>[0]['items'],
    });
    assert.equal('preview' in trimmedDir.items[0]!, false, 'L0 memoryDirectory strips preview');
    assert.equal('synapses' in trimmedDir.items[0]!, false, 'L0 memoryDirectory strips synapses');
    assert.equal(trimmedDir.items[0]!.topic, 't');

    const compactObjCtx = compactRouterChatRecentContext({
      items: Array.from({ length: 9 }, (_, i) => ({ id: `m-${i}`, text: 'Y'.repeat(800) })),
    }) as { items: Array<{ id: string; text: string; truncated: boolean }> };
    assert.equal(compactObjCtx.items.length, 4);
    assert.equal(compactObjCtx.items[0]?.id, 'm-5');
    assert.equal(compactObjCtx.items[0]?.text.length, 280);
    assert.equal(compactObjCtx.items[0]?.truncated, true);
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }

  // 3. Cold offline mode (no leafId) preserves full recentContext behavior untouched
  const homeOffline = await mkdtemp(join(await realpath(tmpdir()), 'sa-chat-offline-'));
  const offlineCaptured: string[] = [];
  const offlineMockFactory: AgentFactory = {
    mode: 'offline',
    nativeTools: false,
    async create(role) {
      return {
        close() {},
        async prompt(text) {
          if (role === 'router') offlineCaptured.push(text);
          return '[OFFLINE SIMULATION] ok';
        },
      };
    },
  };
  const offlineCoord = new Coordinator(homeOffline, offlineMockFactory, { skipExecutor: true });
  try {
    await offlineCoord.ready();
    for (let i = 0; i < 10; i++) {
      offlineCoord.store.conversation.create({
        id: `off-m-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `offline msg ${i}`,
        status: 'completed',
        paths: [],
        mode: 'offline',
        at: Date.now() - (10 - i) * 5_000,
      });
    }
    const offMsg = offlineCoord.chat('off-req-1', '测试离线上下文保留', []);
    await until(() => offlineCoord.store.conversation.get(offMsg.id).status === 'completed');
    const offParsed = JSON.parse(offlineCaptured[0]!) as { context: unknown[] };
    assert.ok(offParsed.context.length >= 10, 'offline mode keeps full 12-item recentContext untouched');
  } finally {
    await offlineCoord.close();
    await rm(homeOffline, { recursive: true, force: true });
  }
});

test('extractCurrentTurnAssistantText never leaks prior turn assistant reply after context_edit or length truncation', () => {
  const prevTurnAssistant = {
    role: 'assistant',
    stopReason: 'stop',
    content: [{ type: 'text', text: '好，让小爱开始放了。[[END]]' }],
  };
  const currentHostUser = {
    role: 'user',
    content: [{ type: 'text', text: 'HOST_EVENT\n{"kind":"CHAT","message":{"id":"cur","text":"空气炸锅200。"}}' }],
  };

  // Normal turn returns current turn text
  assert.equal(
    extractCurrentTurnAssistantText([
      prevTurnAssistant,
      currentHostUser,
      { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '200度要烤几分钟？[[LISTEN]]' }] },
    ]),
    '200度要烤几分钟？[[LISTEN]]',
  );

  // Exact production bug: context_edit stripped the stopReason='length' whitespace assistant message, leaving prevTurnAssistant
  assert.throws(
    () => extractCurrentTurnAssistantText(
      [prevTurnAssistant, currentHostUser],
      [{ role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: '\n\n' }] }],
    ),
    /stopReason=length/,
  );

  // Even without observedTurnAssistants, never walks backwards before currentHostUser
  assert.throws(
    () => extractCurrentTurnAssistantText([prevTurnAssistant, currentHostUser]),
    /Model returned no report/,
  );

  // Whitespace-only stopReason='length' assistant still present in turn slice also throws
  assert.throws(
    () => extractCurrentTurnAssistantText([
      prevTurnAssistant,
      currentHostUser,
      { role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: '\n\n' }] },
    ]),
    /stopReason=length/,
  );

  // Error stopReason on observed truncated turn reports provider error instead of prior reply
  assert.throws(
    () => extractCurrentTurnAssistantText(
      [prevTurnAssistant, currentHostUser],
      [{ role: 'assistant', stopReason: 'error', errorMessage: 'Upstream 400' }],
    ),
    /Model request error: Upstream 400/,
  );
});

test('Router systemPrompt <= 7_800 chars and Coordinator run_plugin description <= 1_100 chars', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-router-prompt-cap-'));
  let capturedTools: Parameters<AgentFactory['create']>[2] = [];
  const capFactory: AgentFactory = {
    mode: 'real',
    nativeTools: true,
    async create(role, _id, tools) {
      if (role === 'router') capturedTools = tools;
      return {
        close() {},
        async prompt() {
          return 'ok';
        },
      };
    },
  };
  const coordinator = new Coordinator(home, capFactory, { skipExecutor: true });
  try {
    const sdkFactory = await realFactory(home, {
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-not-a-real-key',
    });
    const sdkRouter = await sdkFactory.create('router', 'router-prompt-len-check', []);
    try {
      const systemPrompt = (sdkRouter as unknown as {
        session: { systemPrompt: string; _resourceLoader?: { getSystemPrompt?: () => string } };
      }).session.systemPrompt;
      assert.ok(
        systemPrompt.length > 1_000 && systemPrompt.length <= 7_800,
        `Expected Router systemPrompt <= 7_800 chars, got ${systemPrompt.length}`,
      );
      assert.match(systemPrompt, /WECHAT EXPRESSION HYGIENE/);
      assert.match(systemPrompt, /\[旺柴\].*\[捂脸\]/);
    } finally {
      sdkRouter.close();
    }

    await coordinator.ready();
    const runPluginTool = capturedTools.find(t => t.name === 'run_plugin');
    assert.ok(runPluginTool, 'Coordinator registers run_plugin tool');
    assert.ok(
      runPluginTool.description.length <= 1_100,
      `Expected run_plugin description <= 1_100 chars (including suffix), got ${runPluginTool.description.length}`,
    );
    for (const requiredName of [
      'dispatch_worker', 'start_work', 'continue_work', 'inspect_work', 'recall_messages',
      'search_memory', 'save_memory', 'stop_work', 'resume_work', 'manage_timer',
      'run_plugin', 'send_file', 'switch_channel',
    ]) {
      assert.ok(capturedTools.some(t => t.name === requiredName), `missing Router tool ${requiredName}`);
    }
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Coordinator CHAT autoRecalled uses limit <= 3, score >= 46, and touch: false without passive accessCount bumps', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-chat-recall-diet-'));
  const capturedPayloads: Array<{ autoRecalled?: Array<{ score: number; snippet: string }> }> = [];

  const factory: AgentFactory = {
    mode: 'real',
    nativeTools: true,
    async create() {
      return {
        close() {},
        async prompt(text) {
          const parsed = JSON.parse(text) as { kind?: string; autoRecalled?: Array<{ score: number; snippet: string }> };
          if (parsed.kind === 'CHAT') capturedPayloads.push(parsed);
          return '收到。';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory, { skipExecutor: true });
  try {
    await coordinator.ready();

    const cards = Array.from({ length: 5 }, (_, i) =>
      coordinator.store.saveMemory({
        topic: `生产部署脚本规范 #${i}`,
        content: `生产部署脚本必须先校验灰度配置并检查回滚脚本编号 R-${i}。`,
        tags: ['deploy', 'script', `spec-${i}`],
        cwd: home,
      }),
    );
    const unrelated = coordinator.store.saveMemory({
      topic: '宠物猫咪饮食记录',
      content: '每天喂两次冻干猫粮和温水。',
      tags: ['pet', 'cat'],
      cwd: '/unrelated/cat',
    });
    const beforeAccess = new Map(
      [...cards, unrelated].map(c => {
        const cur = coordinator.store.getMemory(c.id);
        return [c.id, { count: cur.accessCount ?? 0, at: cur.lastAccessedAt ?? 0 }];
      }),
    );

    const m1 = coordinator.chat('recall-1', '请确认生产部署脚本规范和回滚脚本要求', [], {
      channel: 'wechat',
      conversationId: 'boss-recall',
      senderId: 'boss-recall',
    });
    await until(() => coordinator.store.conversation.get(m1.id).status === 'completed');

    const payload1 = capturedPayloads[0]!;
    const recalled = payload1.autoRecalled ?? [];
    assert.ok(recalled.length >= 1 && recalled.length <= 3, `Expected 1..3 autoRecalled hits, got ${recalled.length}`);
    assert.ok(recalled.every(h => h.score >= 46), 'Every autoRecalled hit must satisfy score >= 46');

    for (const c of [...cards, unrelated]) {
      const after = coordinator.store.getMemory(c.id);
      const prev = beforeAccess.get(c.id)!;
      assert.equal(after.accessCount ?? 0, prev.count, `touch:false must not bump accessCount on ${c.id}`);
      assert.equal(after.lastAccessedAt ?? 0, prev.at, `touch:false must not bump lastAccessedAt on ${c.id}`);
    }

    const m2 = coordinator.chat('recall-2', '今天晚霞真漂亮', [], {
      channel: 'wechat',
      conversationId: 'boss-recall',
      senderId: 'boss-recall',
    });
    await until(() => coordinator.store.conversation.get(m2.id).status === 'completed');
    const payload2 = capturedPayloads[1]!;
    assert.equal((payload2.autoRecalled ?? []).length, 0, 'Unrelated chat filters out <46 score weak hits');
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('WORKER_REPORT caps report <= 800 chars, uses L0 memoryDirectory <= 10, stops automatic consolidateTaskMemory & compactHostEventText truncates <= 600', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-worker-report-diet-'));
  let routerTools: Parameters<AgentFactory['create']>[2] = [];
  let capturedWorkerReport: {
    taskId?: string;
    report?: string;
    memoryDirectory?: { totalActive?: number; items: Array<Record<string, unknown>> };
  } | undefined;
  let inspectedReportLength = 0;
  let dispatchedTaskId: string | undefined;

  const factory: AgentFactory = {
    mode: 'real',
    nativeTools: true,
    async create(role, _id, tools) {
      if (role === 'router') routerTools = tools;
      return {
        close() {},
        async prompt(text) {
          const parsed = JSON.parse(text) as { kind?: string; taskId?: string };
          if (role === 'router' && parsed.kind === 'CHAT') {
            const startWork = routerTools.find(t => t.name === 'start_work')!;
            const res = JSON.parse(await startWork.execute(JSON.stringify({
              instruction: '扫描配置文件差异并输出完整清单',
              cwd: home,
            }))) as { taskId: string };
            dispatchedTaskId = res.taskId;
            return '好的老板，已安排后台核查。';
          }
          if (role === 'worker') {
            return `详细排查结果：\n${'检查了网关配置文件并核对字段差异。'.repeat(120)}`;
          }
          if (role === 'router' && parsed.kind === 'WORKER_REPORT') {
            capturedWorkerReport = parsed as typeof capturedWorkerReport;
            const inspectWork = routerTools.find(t => t.name === 'inspect_work')!;
            const inspected = JSON.parse(await inspectWork.execute(JSON.stringify({ taskId: parsed.taskId }))) as { report?: string };
            inspectedReportLength = inspected.report?.length ?? 0;
            return '老板，核查已完成，主要配置字段均正常。';
          }
          return 'ok';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory, { skipExecutor: true });
  try {
    await coordinator.ready();
    const reportCards: Array<[string, string, string]> = [
      ['PostgreSQL分区表维护', '按月创建历史订单Range分区并定期执行VacuumAnalyze。', 'pg'],
      ['Nginx反向代理缓冲区', '开启ProxyBuffering避免Upstream大响应头截断。', 'ngx'],
      ['Redis持久化配置', '主从同步开启ReplDisklessSync降低磁盘IO抖动。', 'rds'],
      ['Docker多阶段构建', '使用Alpine剥离Toolchain压低容器镜体积。', 'dkr'],
      ['K8s健康存活探针', 'ReadinessProbe查依赖而LivenessProbe查事件循环。', 'k8s'],
      ['Kafka消费组再平衡', '调大SessionTimeoutMs与MaxPollIntervalMs。', 'kfk'],
      ['Prometheus分位延迟', '采用HistogramQuantile统计P99分位响应时间。', 'prm'],
      ['GraphQL深度拦截器', '限制QueryAst嵌套深度并约束批量Resolver次数。', 'gql'],
      ['WebSocket心跳保活', '互发PingPong帧清理连续超时的半开套接字。', 'ws'],
      ['OAuth2PKCE防篡改', '随机生成State与Verifier并在回调侧原子消费。', 'oauth'],
      ['Stripe回调幂等键', '校验StripeSignature后以EventId去重入库。', 'strp'],
      ['S3直传预签名链接', '后端签发短效PutObject签名供客户端上传文件。', 's3'],
      ['SQLite开启WAL模式', '设置JournalModeWAL并配合五秒BusyTimeout。', 'sql'],
      ['TypeScript严格空值', '打开StrictNullChecks消除未定义引用报错。', 'tsc'],
      ['Playwright静默截图', '屏蔽外链字体并在NetworkIdle后导出SVG。', 'pw'],
      ['米家BE6500中枢网关', '优先通过路由器SSH查询BLEMesh蓝牙设备。', 'miot'],
    ];
    for (let i = 0; i < 16; i++) {
      const [topic, content, tag] = reportCards[i]!;
      coordinator.store.saveMemory({
        topic,
        content,
        tags: [tag],
        cwd: home,
      });
    }

    coordinator.chat('wr-req-1', '帮我扫描一下配置文件差异', [], {
      channel: 'wechat',
      conversationId: 'boss-wr',
      senderId: 'boss-wr',
    });

    await until(() => Boolean(dispatchedTaskId) && coordinator.store.get(dispatchedTaskId!).status === 'completed');

    assert.ok(capturedWorkerReport, 'Router received WORKER_REPORT payload');
    assert.ok(
      (capturedWorkerReport.report?.length ?? 0) <= 800,
      `Expected WORKER_REPORT.report <= 800 chars, got ${capturedWorkerReport.report?.length}`,
    );
    assert.match(capturedWorkerReport.report!, /inspect_work/);
    assert.ok(
      inspectedReportLength > 1_500,
      `Full untruncated report (>1500 chars) stays accessible via inspect_work, got ${inspectedReportLength}`,
    );
    assert.equal(capturedWorkerReport.memoryDirectory?.totalActive, 16);
    assert.equal(
      capturedWorkerReport.memoryDirectory?.items.length,
      10,
      `Expected WORKER_REPORT memoryDirectory capped to 10, got ${capturedWorkerReport.memoryDirectory?.items.length}`,
    );
    assert.ok(
      capturedWorkerReport.memoryDirectory!.items.every(item => !('preview' in item) && !('synapses' in item)),
      'WORKER_REPORT memoryDirectory uses L0 without preview or synapses',
    );

    assert.equal(
      coordinator.store.listMemories().some(m => m.tags.includes('auto-consolidated')),
      false,
      'Completed task must NOT unconditionally save 任务经验 auto-consolidated spam',
    );
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }

  const compactedHistReport = compactHostEventText(
    `HOST_EVENT\n${JSON.stringify({ kind: 'WORKER_REPORT', taskId: 't1', report: 'R'.repeat(1_500) })}`,
    true,
  );
  const parsedHist = JSON.parse(compactedHistReport.slice('HOST_EVENT\n'.length)) as { report: string };
  assert.ok(parsedHist.report.length <= 600, `Expected historical WORKER_REPORT.report <= 600, got ${parsedHist.report.length}`);
  assert.equal(parsedHist.report.endsWith('…'), true);
});

test('Dreamer connect_synapse forbids explicit synapses and caps weak associations <= 0.40', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-dreamer-guard-'));
  let virtualNow = new Date('2026-11-11T00:10:00').getTime();
  let explicitErrorMessage = '';
  let weightAfterMultiCalls = 0;
  let cardAId = '';
  let cardBId = '';

  const factory: AgentFactory = {
    mode: 'offline',
    nativeTools: false,
    async create(role, _id, tools) {
      if (role !== 'dreamer') {
        return {
          close() {},
          async prompt() {
            return '[OFFLINE SIMULATION] ok';
          },
        };
      }
      return {
        close() {},
        async prompt() {
          const connectTool = tools.find(t => t.name === 'connect_synapse')!;
          assert.doesNotMatch(connectTool.description, /"relation\?":\s*"co_activated"\|"explicit"/);
          assert.ok(cardAId && cardBId);

          try {
            await connectTool.execute(JSON.stringify({ id: cardAId, targetId: cardBId, relation: 'explicit' }));
          } catch (err) {
            explicitErrorMessage = err instanceof Error ? err.message : String(err);
          }

          await connectTool.execute(JSON.stringify({ id: cardAId, targetId: cardBId, relation: 'co_activated' }));
          await connectTool.execute(JSON.stringify({ id: cardAId, targetId: cardBId, relation: 'semantic' }));
          await connectTool.execute(JSON.stringify({ id: cardAId, targetId: cardBId, relation: 'semantic' }));

          weightAfterMultiCalls = coordinator.store.getMemory(cardAId).synapses?.find(s => s.targetId === cardBId)?.weight ?? 0;

          return JSON.stringify({ impression: '平静整理了两项工程约定。', salience: 'faint' });
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory, {
    now: () => virtualNow,
    random: () => 0.01,
    checkIntervalMs: 30,
    skipExecutor: true,
  });
  try {
    await coordinator.ready();
    const cardA = coordinator.store.saveMemory({
      topic: '网关鉴权签名方案',
      content: '使用 Ed25519 校验签名。',
      tags: ['auth'],
      cwd: home,
    });
    const cardB = coordinator.store.saveMemory({
      topic: '审计日志格式约定',
      content: '网关鉴权日志记录 requestId 与签名结果。',
      tags: ['audit'],
      cwd: home,
    });
    cardAId = cardA.id;
    cardBId = cardB.id;
    for (let i = 0; i < 3; i++) {
      coordinator.store.conversation.create({
        id: `dream-guard-msg-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `确认网关鉴权日志与签名审计约定 ${i}。`,
        status: 'completed',
        paths: [],
        mode: 'offline',
        at: virtualNow + i * 1_000,
      });
    }

    virtualNow = new Date('2026-11-11T02:30:00').getTime();
    await until(() => coordinator.store.subconsciousState().lastWakeAt === virtualNow);

    assert.match(explicitErrorMessage, /explicit/i, 'Dreamer connect_synapse rejects relation="explicit"');
    assert.ok(weightAfterMultiCalls > 0 && weightAfterMultiCalls <= 0.40, `Expected capped weight <= 0.40, got ${weightAfterMultiCalls}`);
    const syn = coordinator.store.getMemory(cardA.id).synapses?.find(s => s.targetId === cardB.id);
    assert.ok(syn, 'Allowed co_activated/semantic association created');
    assert.notEqual(syn.relation, 'explicit');
    assert.ok(syn.weight <= 0.40, `Stored synapse weight must be <= 0.40, got ${syn.weight}`);
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('compactPluginResultForRouter shrinks bloated health-scale measure-status payloads while keeping core metrics', () => {
  const items = Array.from({ length: 18 }, (_, i) => ({
    key: `metric_${i}`,
    label: `指标${i}`,
    value: 10 + i,
    unit: '%',
    status: 'normal',
    advice: 'A'.repeat(120),
  }));
  const records = Array.from({ length: 25 }, (_, i) => ({
    id: `m-${i}`,
    measuredAt: 1_794_937_800_000 - i * 86_400_000,
    weightKg: 79.65 - i * 0.1,
    weightJin: 159.3 - i * 0.2,
    source: 'live',
    adcs: [500, 460],
    rawMeta: { extra: 'R'.repeat(120) },
    metrics: {
      weightKg: 79.65 - i * 0.1,
      bmi: 25.7,
      bodyFatPercent: 15.9,
      bodyScore: 86,
      items,
    },
  }));
  const rawResult = {
    ok: true,
    plugin: 'health-scale',
    action: 'measure-status',
    notify: false,
    title: '体脂测量完成',
    message: '测量完成，体重 79.65 kg',
    data: {
      session: {
        sessionId: 'meas-1',
        phase: 'completed',
        notifications: Array.from({ length: 40 }, () => ({ hex: 'AC27'.repeat(10) })),
      },
      dashboard: {
        activeProfile: { id: 'owner', name: 'Boss' },
        latest: records[0],
        deltas: { prevDiffKg: 0.05 },
        records,
      },
    },
  };

  const rawJson = JSON.stringify(rawResult);
  assert.ok(rawJson.length > 30_000);

  const compacted = compactPluginResultForRouter(rawResult, 'measure-status', {});
  const compactedJson = JSON.stringify(compacted);
  assert.ok(compactedJson.length < 3_000, `Expected compacted JSON < 3000 chars, got ${compactedJson.length}`);
  const compactedData = compacted.data as {
    session: { phase: string; notifications?: unknown };
    dashboard: {
      latest: { weightKg: number; metrics: { bodyFatPercent: number; items?: unknown } };
      records?: unknown;
      recordsCount: number;
      recentRecords: unknown[];
    };
  };
  assert.equal(compactedData.session.phase, 'completed');
  assert.equal(compactedData.session.notifications, undefined);
  assert.equal(compactedData.dashboard.latest.weightKg, 79.65);
  assert.equal(compactedData.dashboard.latest.metrics.bodyFatPercent, 15.9);
  assert.equal(compactedData.dashboard.latest.metrics.items, undefined);
  assert.equal(compactedData.dashboard.records, undefined);
  assert.equal(compactedData.dashboard.recordsCount, 25);
  assert.equal(compactedData.dashboard.recentRecords.length, 3);

  // Dashboard action & explicit includeRecords: true remain untouched
  assert.equal(compactPluginResultForRouter(rawResult, 'dashboard', {}), rawResult);
  assert.equal(compactPluginResultForRouter(rawResult, 'measure-status', { includeRecords: true }), rawResult);
});

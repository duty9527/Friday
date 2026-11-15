import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { resolveRuntimeMessageSession } from '../src/session.js';
import { deserializeEmbedding, l2Normalize, type EmbeddingPurpose, type SemanticEmbedder } from '../src/semantic.js';
import type { ModelHub } from '../src/model-hub.js';
import { Coordinator } from '../dist/coordinator.js';
import { serve } from '../dist/server.js';
import { startWeb } from '../dist/web-server.js';
import { request } from '../dist/protocol.js';
import { routeLabel, routeState, timelineSteps } from '../src/web/model.js';
import type { AgentFactory } from '../src/agent.js';

function createMockSemanticEmbedder(modelId = 'mock-bge-v1'): SemanticEmbedder {
  const vecFor = (text: string): Float32Array => {
    const t = text.toLowerCase();
    const raw = [
      /(鉴权|jwt|oauth|令牌|token|登录|校验|ed25519)/.test(t) ? 1 : 0.01,
      /(部署|容器|docker|发布|流水线|ci|cd)/.test(t) ? 1 : 0.01,
      /(网关|限流|熔断|ratelimit|gateway|qps|rps)/.test(t) ? 1 : 0.01,
      /(天气|下雨|温度|北京|上海)/.test(t) ? 1 : 0.01,
      0.01,
    ];
    if (raw[0] === 0.01 && raw[1] === 0.01 && raw[2] === 0.01 && raw[3] === 0.01) {
      raw[4] = 1;
    }
    return l2Normalize(raw)!;
  };
  return {
    modelId,
    dim: 5,
    isReady: () => true,
    async ensureReady() { return true; },
    async embed(text: string, _purpose?: EmbeddingPurpose) {
      if (!text.trim()) return undefined;
      return vecFor(text);
    },
    async embedBatch(texts: string[], _purpose?: EmbeddingPurpose) {
      return texts.map(t => (t.trim() ? vecFor(t) : undefined));
    },
  };
}

async function until(predicate: () => boolean | Promise<boolean>, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for condition');
}

test('Global Memory Step 1: semantic memory cards, L0 meta-memory directory, superseding metabolism, and credential redaction', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-mem-store-'));
  const store = new Store(home);
  try {
    const v1 = store.saveMemory({
      topic: '鉴权架构方案',
      content: '初期采用 Cookie + Session 存储在本地 SQLite，测试密钥 sk-proj-1234567890abcdef',
      tags: ['auth', 'session'],
      cwd: '/repo/backend',
      sourceMessageId: 'msg-1',
    });
    assert.ok(v1.id);
    assert.match(v1.content, /\[redacted\]/, 'secrets are automatically redacted before persisting to global memory');
    assert.equal(v1.supersededBy, undefined);

    // Updating the same topic + cwd automatically supersedes the old card instead of polluting active memory
    const v2 = store.saveMemory({
      topic: '鉴权架构方案',
      content: '已废弃 Session 方案，统一改用无状态 Ed25519 JWT 双令牌机制，过期时间 15 分钟',
      tags: ['auth', 'jwt', 'ed25519'],
      cwd: '/repo/backend',
      sourceMessageId: 'msg-2',
      sourceTaskId: 'task-auth-2',
    });
    assert.notEqual(v2.id, v1.id);
    assert.equal(v2.supersedes, v1.id);

    const oldCard = store.getMemory(v1.id);
    assert.equal(oldCard.supersededBy, v2.id, 'old memory card points to the new card that superseded it');

    const active = store.listMemories();
    assert.equal(active.length, 1);
    assert.equal(active[0]!.id, v2.id);

    const allHistory = store.listMemories({ includeSuperseded: true });
    assert.equal(allHistory.length, 2);

    const dir = store.memoryDirectory();
    assert.equal(dir.totalActive, 1);
    assert.equal(dir.items[0]!.id, v2.id);
    assert.equal(dir.items[0]!.topic, '鉴权架构方案');

    assert.equal(store.deleteMemory(v1.id), true);
    assert.equal(store.listMemories({ includeSuperseded: true }).length, 1);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Global Memory Step 2: human-brain hybrid search across memories, works, and messages with locality neighbors', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-mem-search-'));
  const store = new Store(home);
  try {
    // 1. Create a sequence of conversation messages to verify temporal locality (prev/next neighbors)
    const m1 = store.conversation.create({
      id: 'm1', role: 'user', text: '我们准备重构支付网关的超时重试逻辑，你觉得重试几次合适？',
      status: 'completed', mode: 'offline', paths: [],
    });
    const m2 = store.conversation.create({
      id: 'm2', replyTo: m1.id, role: 'assistant',
      text: '建议支付网关的幂等请求最多重试 2 次，采用指数退避（200ms、800ms），非幂等扣款请求禁止自动重试。',
      status: 'completed', mode: 'offline', paths: [],
    });
    const m3 = store.conversation.create({
      id: 'm3', role: 'user', text: '好，那就按最多重试 2 次加指数退避来执行。',
      status: 'completed', mode: 'offline', paths: [],
    });

    // 2. Create a completed background task linked to m3
    const taskId = 'task-pay-retry';
    store.create({
      id: taskId, requestId: 'req-pay-1', fingerprint: 'fp-1',
      prompt: '修改 src/payment/gateway.ts 实现指数退避重试',
      status: 'completed', revision: 1, files: [], mode: 'offline',
      createdAt: Date.now(), limitMs: 600_000, activeMs: 1200,
      cwd: '/repo/payment', originMessageId: m3.id,
      report: '已完成 src/payment/gateway.ts 的重构：仅对含 Idempotency-Key 的请求开启最多 2 次指数退避重试。',
    });
    store.conversation.link(m3.id, taskId);

    // 3. Save a consolidated semantic memory card
    const mem = store.saveMemory({
      topic: '支付网关重试规范',
      content: '支付网关仅允许带 Idempotency-Key 的请求最多重试 2 次（200ms/800ms 指数退避），非幂等扣款严禁重试。',
      tags: ['payment', 'retry', 'idempotency'],
      cwd: '/repo/payment',
      sourceMessageId: m2.id,
      sourceTaskId: taskId,
    });

    // Search across all sources using natural Chinese phrase
    const result = store.searchContext({ query: '支付网关 指数退避 重试', cwd: '/repo/payment' });
    assert.ok(result.totalHits >= 3, 'should match memory card, completed work, and conversation messages');
    assert.equal(result.hits[0]!.kind, 'memory', 'consolidated active semantic memory card ranks highest');
    assert.equal(result.hits[0]!.memoryId, mem.id);
    assert.equal(result.hits[0]!.taskId, taskId, 'memory hit carries sourceTaskId for Chain of Recall');

    const workHit = result.hits.find(h => h.kind === 'work');
    assert.ok(workHit);
    assert.equal(workHit.taskId, taskId);
    assert.equal(workHit.originMessageId, m3.id);
    assert.match(workHit.snippet, /Idempotency-Key/);

    const msgHit = result.hits.find(h => h.kind === 'message' && h.messageId === m2.id);
    assert.ok(msgHit);
    assert.ok(msgHit.neighbors && msgHit.neighbors.length === 2, 'message hit includes prev (m1) and next (m3) neighbors');
    assert.equal(msgHit.neighbors[0]!.id, m1.id);
    assert.equal(msgHit.neighbors[1]!.id, m3.id);

    const m3Hit = result.hits.find(h => h.kind === 'message' && h.messageId === m3.id);
    assert.ok(m3Hit);
    assert.deepEqual(m3Hit.linkedTaskIds, [taskId], 'message hit includes linked task IDs');
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Global Memory Step 3: Router recalls memory, compiles contextBrief & memoryIds, and dispatches specialist Worker AI', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-mem-router-'));
  let observedWorkerOptions: { profile?: string; model?: string } = {};
  let observedWorkerPayload: Record<string, unknown> = {};
  let observedRouterDirectoryCount = 0;

  const factory: AgentFactory = {
    mode: 'offline',
    nativeTools: true,
    async create(role, _id, tools, options) {
      if (role === 'worker') {
        observedWorkerOptions = { profile: options?.profile, model: options?.model };
      }
      return {
        close() {},
        async prompt(text) {
          const event = JSON.parse(text) as Record<string, unknown>;
          if (role === 'worker') {
            observedWorkerPayload = event;
            return '已完成 gateway.ts 改造并通过单元测试。';
          }
          const call = async (name: string, args: unknown) =>
            JSON.parse(await tools.find(tool => tool.name === name)!.execute(JSON.stringify(args)));

          if (event.kind === 'CHAT') {
            const msg = event.message as { id: string; text: string };
            const dir = event.memoryDirectory as { totalActive: number } | undefined;
            observedRouterDirectoryCount = dir?.totalActive ?? 0;

            if (msg.text === '记住架构规范') {
              await call('save_memory', {
                topic: '数据库事务规范',
                content: '所有状态变更必须走 store.transaction 嵌套保存点，禁止裸写 SQL。',
                tags: ['sqlite', 'transaction'],
                cwd: home,
                summary: '记录数据库事务核心规范',
              });
              return '已记住数据库事务规范。';
            }

            if (msg.text === '按之前的规范实现订单表') {
              const searchRes = await call('search_memory', {
                query: '数据库事务规范',
                cwd: home,
                summary: '检索数据库相关的全局记忆',
              }) as { hits: Array<{ memoryId?: string; snippet: string }> };
              const hitId = searchRes.hits[0]?.memoryId;
              await call('start_work', {
                instruction: '在当前目录实现订单状态流转逻辑',
                cwd: home,
                contextBrief: `请严格遵守检索到的全局记忆：${searchRes.hits[0]?.snippet ?? ''}`,
                memoryIds: hitId ? [hitId] : [],
                profile: 'coding',
                model: 'deepseek-reasoner-specialist',
                summary: '编译全局记忆上下文并派发编码专职子 AI',
              });
              return '已检索到事务规范记忆，编译上下文后派发给 coding 专职子 AI 执行。';
            }
          }

          if (event.kind === 'WORKER_REPORT') {
            await call('save_memory', {
              topic: '订单表实现记录',
              content: `订单状态流转已按事务规范落地（任务 ${String(event.taskId)}）`,
              sourceTaskId: event.taskId,
              cwd: home,
              summary: '归档 Worker 完成结论到全局记忆',
            });
            return `汇总交付：${String(event.report)}`;
          }
          return 'ok';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();

    // Turn 1: User tells Router to remember a rule
    const turn1 = coordinator.chat('req-mem-1', '记住架构规范');
    await until(() => coordinator.store.conversation.get(turn1.id).status === 'completed');
    const turn1Record = coordinator.store.conversation.get(turn1.id).routing!;
    assert.equal(turn1Record.actions.length, 1);
    assert.equal(turn1Record.actions[0]!.kind, 'save_memory');
    assert.equal(routeLabel(turn1Record.actions[0]!), '沉淀长期记忆');
    assert.equal(routeState(turn1Record.actions[0]!), '记忆已更新');
    assert.equal(turn1Record.actions[0]!.memoryIds?.length, 1);

    // Turn 2: User asks to implement a feature following prior rules -> Router sees L0 directory, searches memory, compiles context, dispatches specialist Worker
    const turn2 = coordinator.chat('req-mem-2', '按之前的规范实现订单表');
    await until(() => coordinator.store.list().length === 1 && coordinator.store.list()[0]!.status === 'completed');
    await until(() => coordinator.store.conversation.get(turn2.id).status === 'completed');

    assert.equal(observedRouterDirectoryCount, 1, 'Router receives L0 meta-memory directory in CHAT context');
    assert.equal(observedWorkerOptions.profile, 'coding', 'specialist Worker AI profile was passed to factory');
    assert.equal(observedWorkerOptions.model, 'deepseek-reasoner-specialist', 'heterogeneous Worker model override was passed to factory');

    const compiled = observedWorkerPayload.compiledContext as {
      profile: string;
      workerModel: string;
      contextBrief: string;
      recalledMemories: Array<{ topic: string; content: string }>;
    };
    assert.ok(compiled, 'Worker received compiledContext from Router');
    assert.equal(compiled.profile, 'coding');
    assert.equal(compiled.workerModel, 'deepseek-reasoner-specialist');
    assert.match(compiled.contextBrief, /store\.transaction/);
    assert.equal(compiled.recalledMemories.length, 1);
    assert.equal(compiled.recalledMemories[0]!.topic, '数据库事务规范');

    const turn2Record = coordinator.store.conversation.get(turn2.id).routing!;
    assert.deepEqual(turn2Record.actions.map(a => a.kind), ['search_memory', 'new_work']);
    assert.equal(turn2Record.actions[0]!.searchQuery, '数据库事务规范');
    assert.equal(turn2Record.actions[1]!.workerProfile, 'coding');
    assert.equal(turn2Record.actions[1]!.workerModel, 'deepseek-reasoner-specialist');

    // Verify timeline steps include readable Chinese steps for memory search and work creation
    const steps = timelineSteps(coordinator.store.conversation.trace({ messageId: turn2.id }));
    assert.ok(steps.some(s => s.title === '检索全局记忆'));
    assert.ok(steps.some(s => s.title === '新建工作'));

    // Verify WORKER_REPORT also consolidated a second memory card
    assert.equal(coordinator.store.listMemories().length, 2);
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Global Memory Step 4: daemon IPC commands, Web API /api/memories, and offline simulation memory commands', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-mem-service-'));
  const daemon = await serve({ home, mode: 'offline', offlineDelayMs: 10 });
  const web = await startWeb({ home, port: 0 });
  try {
    // 1. Daemon IPC memory-save / memory-list / memory-search / memory-remove
    const saved = await request(home, {
      command: 'memory-save',
      topic: '部署目录约定',
      content: '生产环境配置统一放在 /etc/super-agent/config.json',
      tags: ['deploy', 'config'],
    }) as { id: string; topic: string };
    assert.ok(saved.id);

    const listed = await request(home, { command: 'memory-list' }) as Array<{ id: string }>;
    assert.equal(listed.length, 1);

    // 2. Web API /api/memories GET (list & search) and POST (/api/memory-save)
    const parsedUrl = new URL(web.url);
    const token = parsedUrl.hash.replace(/^#token=/, '');
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      origin: parsedUrl.origin,
    };

    const webSearchRes = await fetch(`${parsedUrl.origin}/api/memories?query=${encodeURIComponent('生产环境配置')}`, { headers });
    assert.equal(webSearchRes.status, 200);
    const webSearchJson = await webSearchRes.json() as { hits: Array<{ id: string }> };
    assert.equal(webSearchJson.hits[0]?.id, saved.id);

    const webSaveRes = await fetch(`${parsedUrl.origin}/api/memory-save`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ topic: '代码风格', content: '使用 TypeScript strict 模式与单引号' }),
    });
    assert.equal(webSaveRes.status, 200);

    // 3. Offline simulation chat: "记住：..." and "搜索记忆：..."
    const chatRemember = await request(home, {
      command: 'chat',
      requestId: 'off-mem-1',
      text: '记住：测试策略=所有新功能必须包含集成测试',
    }) as { id: string };
    await until(() => {
      return request(home, { command: 'message', messageId: chatRemember.id })
        .then(msg => (msg as { status: string }).status === 'completed');
    });

    const chatSearch = await request(home, {
      command: 'chat',
      requestId: 'off-mem-2',
      text: '搜索记忆：集成测试',
    }) as { id: string };
    await until(() => {
      return request(home, { command: 'message', messageId: chatSearch.id })
        .then(msg => (msg as { status: string }).status === 'completed');
    });
    const searchMsg = await request(home, { command: 'message', messageId: chatSearch.id }) as {
      routing?: { actions: Array<{ kind: string }> };
    };
    assert.equal(searchMsg.routing?.actions[0]?.kind, 'search_memory');

    // 4. Subconscious Memory Flashback (autoRecalled): ordinary question automatically recalls matching memory without explicit "搜索记忆："
    const chatFlashback = await request(home, {
      command: 'chat',
      requestId: 'off-mem-3',
      text: '我们现在的测试策略有什么要求？',
    }) as { id: string };
    await until(() => {
      return request(home, { command: 'message', messageId: chatFlashback.id })
        .then(msg => (msg as { status: string }).status === 'completed');
    });
    const flashbackUserMsg = await request(home, { command: 'message', messageId: chatFlashback.id }) as {
      routing?: { context: { autoRecalled?: Array<{ title: string; snippet: string }> } };
    };
    assert.ok((flashbackUserMsg.routing?.context.autoRecalled?.length ?? 0) >= 1, 'subconscious autoRecalled populated in routing context');

    // 5. Specialist AI delegation in offline mode ("派发：...") automatically compiles recalled memories and infers profile
    const chatDelegate = await request(home, {
      command: 'chat',
      requestId: 'off-mem-4',
      text: '派发：重构代码风格检查脚本并补充集成测试',
    }) as { id: string };
    await until(async () => {
      const view = await request(home, { command: 'view' }) as { works: Array<{ status: string }> };
      return view.works.length === 1 && view.works[0]!.status === 'completed';
    });
    const finalView = await request(home, { command: 'view' }) as {
      works: Array<{ id: string; profile?: string; status: string }>;
      memoryDirectory: { totalActive: number; items: Array<{ id: string; topic: string; tags: string[]; pinned?: boolean; accessCount?: number }> };
      timers: Array<{ id: string; name: string; enabled: boolean }>;
    };
    assert.equal(finalView.works[0]?.profile, 'coding', 'inferred coding specialist profile');
    assert.equal(finalView.memoryDirectory.items.some(m => m.tags.includes('auto-consolidated')), false, 'normal completed Worker task no longer pollutes long-term memory with auto-consolidated stubs');
    assert.ok(finalView.memoryDirectory.items.some(m => (m.accessCount ?? 0) > 0), 'Ebbinghaus retrieval reinforcement incremented accessCount on explicitly searched/recalled memories');

    // Pin a memory via Web API /api/memory-pin and verify it floats to the top of memoryDirectory
    const pinRes = await fetch(`${parsedUrl.origin}/api/memory-pin`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: saved.id, pinned: true }),
    });
    assert.equal(pinRes.status, 200);
    const viewAfterPin = await request(home, { command: 'view' }) as {
      memoryDirectory: { items: Array<{ id: string; pinned?: boolean }> };
    };
    assert.equal(viewAfterPin.memoryDirectory.items[0]?.id, saved.id, 'pinned memory ranks first in memoryDirectory');
    assert.equal(viewAfterPin.memoryDirectory.items[0]?.pinned, true);

    // 6. Web API timer management (/api/timer-add, /api/timer-toggle, /api/timer-remove)
    const timerAddRes = await fetch(`${parsedUrl.origin}/api/timer-add`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: '每日代码巡检', intervalSeconds: 3600, instruction: '检查仓库构建状态' }),
    });
    assert.equal(timerAddRes.status, 200);
    const createdTimer = await timerAddRes.json() as { id: string; enabled: boolean };
    assert.ok(createdTimer.id);
    assert.equal(createdTimer.enabled, true);

    const timerToggleRes = await fetch(`${parsedUrl.origin}/api/timer-toggle`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: createdTimer.id, enabled: false }),
    });
    assert.equal(timerToggleRes.status, 200);

    const viewAfterTimer = await request(home, { command: 'view' }) as { timers: Array<{ id: string; enabled: boolean }> };
    assert.equal(viewAfterTimer.timers.find(t => t.id === createdTimer.id)?.enabled, false);

    const timerRemoveRes = await fetch(`${parsedUrl.origin}/api/timer-remove`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: createdTimer.id }),
    });
    assert.equal(timerRemoveRes.status, 200);
  } finally {
    await web.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Global Memory Step 5: Neural Synaptic Graph (Hebbian co-activation, 1-hop spreading activation, and synaptic metabolism)', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-mem-synapse-'));
  const store = new Store(home);
  try {
    // 1. Auto-wiring requires >= 2 shared non-stop tags within the same cwd
    const singleTag = store.saveMemory({
      topic: '单标签不关联测试',
      content: '仅共享单个具体标签 gateway 与停用词 config 不应自动连边。',
      tags: ['gateway', 'config'],
      cwd: '/repo/edge',
    });
    const n1 = store.saveMemory({
      topic: '网关限流阈值',
      content: '边缘网关对单 IP 限流为 200 RPS，突发桶容量 400。',
      tags: ['gateway', 'ratelimit', 'edge-proxy'],
      cwd: '/repo/edge',
    });
    assert.equal(store.getMemory(singleTag.id).synapses ?? undefined, undefined, 'single shared non-stop tag never auto-wires');

    const n2 = store.saveMemory({
      topic: '熔断降级兜底',
      content: '下游超过 50% 错误率时返回静态缓存降级响应。',
      tags: ['gateway', 'ratelimit', 'circuit-breaker'],
      cwd: '/repo/edge',
    });

    const n1Fresh = store.getMemory(n1.id);
    assert.equal(n1Fresh.synapses?.length, 1, '>= 2 shared specific tags in same cwd automatically wire a synapse');
    assert.equal(n1Fresh.synapses![0]!.targetId, n2.id);
    assert.equal(n1Fresh.synapses![0]!.relation, 'shared_tag');

    // 2. Explicit synapse to a neuron in compatible cwd that shares NO lexical overlap with n1
    const n3 = store.saveMemory({
      topic: '值班告警静默窗口',
      content: '每周三凌晨 03:00-04:00 压测演练期间暂停 PagerDuty 电话呼叫。',
      tags: ['oncall'],
      cwd: '/repo/edge',
      linkedMemoryIds: [n1.id],
    });
    assert.ok(n3.synapses?.some(s => s.targetId === n1.id && s.relation === 'explicit' && s.weight >= 0.8));

    // 3. 1-hop Spreading Activation: searching solely for "边缘网关 单 IP 限流" directly hits n1,
    // and spreads across explicit n1 -> n3 (weight >= 0.60 & spreadScore >= 32), while NOT spreading across weak n1 -> n2 (< 0.60)
    const searchRes = store.searchContext({ query: '边缘网关 单 IP 限流', scope: 'memories', cwd: '/repo/edge' });
    const directHit = searchRes.hits.find(h => h.memoryId === n1.id);
    const spreadHit = searchRes.hits.find(h => h.memoryId === n3.id);
    const weakSpreadHit = searchRes.hits.find(h => h.memoryId === n2.id);
    assert.ok(directHit && !directHit.activatedVia, 'n1 is a direct seed hit');
    assert.ok(spreadHit, 'n3 is recalled via 1-hop synaptic spreading activation despite zero keyword overlap');
    assert.equal(weakSpreadHit, undefined, 'weak synapse (< 0.60) does not trigger 1-hop spreading');
    assert.equal(spreadHit.activatedVia?.memoryId, n1.id);
    assert.equal(spreadHit.activatedVia?.topic, '网关限流阈值');
    assert.equal(spreadHit.activatedVia?.relation, 'explicit');

    // 4. Hebbian learning ("neurons that fire together, wire together") when compiled together via explicit memoryIds
    const beforeW = store.getMemory(n1.id).synapses?.find(s => s.targetId === n2.id)?.weight ?? 0;
    const contextCards = store.memoriesForContext({ memoryIds: [n1.id, n2.id], cwd: '/repo/edge', limit: 5 });
    const afterW = store.getMemory(n1.id).synapses?.find(s => s.targetId === n2.id)?.weight ?? 0;
    assert.ok(afterW > beforeW, 'co-activating n1 and n2 in memoriesForContext strengthens their synaptic weight');
    assert.ok(contextCards.some(c => c.id === n3.id), 'memoriesForContext also pulls in 1-hop strong synaptic neighbor n3');

    // 5. Synaptic metabolism on superseding: updating n1 topic+cwd migrates its synapses to n1_v2 and redirects n3's synapse
    const n1V2 = store.saveMemory({
      topic: '网关限流阈值',
      content: '边缘网关对单 IP 限流上调为 500 RPS，突发桶容量 1000。',
      tags: ['gateway', 'ratelimit', 'edge-proxy'],
      cwd: '/repo/edge',
    });
    assert.equal(n1V2.supersedes, n1.id);
    assert.ok(n1V2.synapses?.some(s => s.targetId === n3.id), 'new neuron inherits prior synapses');
    const n3AfterSupersede = store.getMemory(n3.id);
    assert.ok(n3AfterSupersede.synapses?.some(s => s.targetId === n1V2.id), 'neighbor n3 synapse is redirected to the new neuron');
    assert.ok(!n3AfterSupersede.synapses?.some(s => s.targetId === n1.id), 'stale pointer to superseded neuron is removed');

    // 6. Deleting a neuron cleans up incoming synapses on neighbors
    store.deleteMemory(n3.id);
    assert.ok(!store.getMemory(n1V2.id).synapses?.some(s => s.targetId === n3.id), 'deleting n3 removes dangling synapse from n1V2');
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Global Memory Step 6: SemanticEmbedder SQLite persistence, hybrid cross-phrasing search, backfill, and zero padding', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-mem-sem-'));
  const store = new Store(home);
  const embedder = createMockSemanticEmbedder();
  try {
    store.attachSemanticEngine(embedder);
    assert.equal(store.getSemanticEngine(), embedder);

    // Sync save before backfill -> no embedding row yet
    const preSyncCard = store.saveMemory({
      topic: '容器发布流水线',
      content: '使用 Docker 构建镜像并推送至私有仓库。',
      tags: ['infra'],
      cwd: '/repo/app',
    });

    const authCard = await store.saveMemoryAsync({
      topic: '无状态鉴权规范',
      content: '采用 Ed25519 JWT 双令牌进行登录校验。',
      tags: ['auth'],
      cwd: '/repo/app',
    });
    const authCard2 = await store.saveMemoryAsync({
      topic: '网关鉴权与限流协同',
      content: '在 API gateway 层校验 OAuth token 签名并执行限流策略。',
      tags: ['gateway'],
      cwd: '/repo/app',
    });
    const unrelatedCard = await store.saveMemoryAsync({
      topic: '天气订阅偏好',
      content: '每天早上关注北京下雨与温度变化。',
      tags: ['life'],
      cwd: '/repo/other',
    });

    // Verify semantic synapse wired automatically between authCard and authCard2 (same cwd, cosine >= 0.68)
    const refreshedAuth = store.getMemory(authCard.id);
    assert.ok(
      refreshedAuth.synapses?.some(s => s.targetId === authCard2.id && s.relation === 'semantic' && s.weight >= 0.68),
      'semantic synapse auto-wired for high-similarity cards in same cwd',
    );
    assert.equal(
      refreshedAuth.synapses?.some(s => s.targetId === unrelatedCard.id),
      false,
      'cross-cwd card never auto-wired',
    );

    // Verify SQLite memory_embeddings persistence + hydration across reopen
    const db = new DatabaseSync(join(home, 'state.sqlite'));
    const embRow = db.prepare('SELECT model_id, dim, vector FROM memory_embeddings WHERE memory_id=?').get(authCard.id) as
      { model_id: string; dim: number; vector: Uint8Array } | undefined;
    assert.ok(embRow, 'embedding persisted in memory_embeddings table');
    assert.equal(embRow.model_id, 'mock-bge-v1');
    assert.equal(embRow.dim, 5);
    assert.ok(deserializeEmbedding(embRow.vector, 5));
    db.close();

    // Backfill sync-saved card
    const ac = new AbortController();
    const backfilled = await store.backfillEmbeddings(10, ac.signal);
    assert.equal(backfilled, 1, 'backfillEmbeddings computed missing embedding for preSyncCard');
    assert.equal(await store.backfillEmbeddings(10, ac.signal), 0, 'second backfill skips already up-to-date embeddings');

    // Cross-phrasing searchContextAsync (zero lexical overlap with "容器发布流水线", matched purely via embedding)
    const semSearch = await store.searchContextAsync({
      query: 'CI CD pipeline release',
      scope: 'memories',
      cwd: '/repo/app',
    });
    assert.ok(
      semSearch.hits.some(h => h.memoryId === preSyncCard.id),
      'searchContextAsync retrieves paraphrased memory with zero lexical overlap via semantic embedding',
    );

    // memoriesForContextAsync with queryText and empty cwd: returns ONLY matched card, zero unrelated padding!
    const ctxMatched = await store.memoriesForContextAsync({
      queryText: 'CI CD docker container',
      limit: 8,
    });
    assert.equal(ctxMatched.length, 1, 'memoriesForContextAsync does not pad remaining slots with unrelated recent cards');
    assert.equal(ctxMatched[0]!.id, preSyncCard.id);

    // memoriesForContext with completely unrelated query & no cwd returns []
    assert.deepEqual(
      await store.memoriesForContextAsync({ queryText: '完全不存在的随机火星词xyz', limit: 8 }),
      [],
      'no unrelated padding when nothing matches',
    );

    // Reopen Store to verify embeddingCache hydration on startup
    store.close();
    const reopened = new Store(home);
    reopened.attachSemanticEngine(embedder);
    try {
      const hydratedHit = await reopened.searchContextAsync({ query: 'CI CD release', scope: 'memories' });
      assert.ok(hydratedHit.hits.some(h => h.memoryId === preSyncCard.id), 'embeddingCache hydrated from SQLite on startup');

      // Semantic superseding in same cwd (>= 0.86 cosine) removes superseded embedding from memory_embeddings
      const updatedAuth = await reopened.saveMemoryAsync({
        topic: '接口令牌校验新规',
        content: '全面使用 OAuth JWT 令牌登录校验方案。',
        cwd: '/repo/app',
      });
      assert.ok(updatedAuth.supersedes, 'high semantic similarity in same cwd auto-supersedes non-pinned card');

      const db2 = new DatabaseSync(join(home, 'state.sqlite'));
      const supersededEmb = db2.prepare('SELECT 1 FROM memory_embeddings WHERE memory_id=?').get(updatedAuth.supersedes!);
      assert.equal(supersededEmb, undefined, 'superseded embedding is cleaned from memory_embeddings');
      reopened.deleteMemory(updatedAuth.id);
      const deletedEmb = db2.prepare('SELECT 1 FROM memory_embeddings WHERE memory_id=?').get(updatedAuth.id);
      assert.equal(deletedEmb, undefined, 'deleted memory embedding is cleaned from memory_embeddings');
      db2.close();
    } finally {
      reopened.close();
    }
  } finally {
    try { store.close(); } catch { /* already closed */ }
    await rm(home, { recursive: true, force: true });
  }
});

test('Global Memory Step 7: domain isolation, stop-tag filtering, search non-linking, caps, and spreading gates', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-mem-gates-'));
  const store = new Store(home);
  try {
    // 1. Broad stop tags never auto-wire shared_tag
    const s1 = store.saveMemory({
      topic: 'Vite 本地代理调整',
      content: '将 Vite 开发服务器代理路径转发到 8080 后端，保留验证样本。',
      tags: ['router', 'config', 'fix', 'test', 'ts'],
      cwd: '/repo/a',
    });
    const s2 = store.saveMemory({
      topic: 'ESLint 规则检查',
      content: '为 TypeScript 启用严格 no-floating-promises 规则，保留验证样本。',
      tags: ['router', 'config', 'fix', 'test', 'ts'],
      cwd: '/repo/a',
    });
    assert.equal(store.getMemory(s1.id).supersededBy, undefined, 'distinct cards are not superseded');
    assert.equal(store.getMemory(s1.id).synapses, undefined, 'broad stop tags do not auto-wire synapses');

    // 2. Cross-cwd isolation: identical specific tags + similar text never auto-wire or auto-supersede across cwd
    const projA = store.saveMemory({
      topic: '数据库连接池规范',
      content: '最大连接数设为 32，闲置超时 60 秒，开启健康探活。',
      tags: ['postgres', 'pool', 'keepalive'],
      cwd: '/repo/project-a/',
    });
    const projB = store.saveMemory({
      topic: '数据库连接池规范',
      content: '最大连接数设为 32，闲置超时 60 秒，开启健康探活。',
      tags: ['postgres', 'pool', 'keepalive'],
      cwd: '/repo/project-b',
    });
    assert.equal(projB.supersedes, undefined, 'different cwd never auto-supersedes');
    assert.equal(store.getMemory(projA.id).supersededBy, undefined);
    assert.equal(store.getMemory(projA.id).synapses, undefined, 'different cwd never auto-wires');

    // Normalized topic dedup within same normalized cwd ('/repo/project-a' vs '/repo/project-a/')
    const projA2 = store.saveMemory({
      topic: '数据库·连接池：规范',
      content: '最大连接数调整为 64。',
      tags: ['postgres', 'pool'],
      cwd: '/repo/project-a',
    });
    assert.equal(projA2.supersedes, projA.id, 'normalized topic + normalized cwd auto-supersedes prior card');

    // Lexical fuzzy superseding when embeddings unavailable (jaccard >= 0.68 & sharedTerms >= 4)
    const fuzzy1 = store.saveMemory({
      topic: 'Redis 缓存淘汰策略',
      content: '生产环境 Redis 集群统一使用 allkeys-lru 策略，禁用无过期键写入核心业务库。',
      tags: ['redis', 'cache'],
      cwd: '/repo/cache',
    });
    const fuzzy2 = store.saveMemory({
      topic: 'Redis 缓存淘汰说明',
      content: '生产环境 Redis 集群统一使用 allkeys-lru 策略，严格禁用无过期键写入核心业务库。',
      tags: ['redis', 'cache'],
      cwd: '/repo/cache',
    });
    assert.equal(fuzzy2.supersedes, fuzzy1.id, 'high lexical concept overlap in same cwd auto-supersedes non-pinned card');

    // 3. Search co-occurrence does NOT wire co_activated synapses
    const hitRes = store.searchContext({ query: '验证样本', scope: 'memories', cwd: '/repo/a', touch: true });
    assert.ok(hitRes.hits.length >= 2);
    assert.equal(store.getMemory(s1.id).synapses, undefined, 'searchContext touch:true must NOT wire co_activated synapses');

    // 4. Cap auto-wired peers per saveMemory (<= 4) & auto-synapses per card (<= 8, never evicting explicit)
    const anchor = store.saveMemory({
      topic: '核心枢纽卡片',
      content: '用于验证显式与自动突触上限',
      tags: ['hub-alpha', 'hub-beta'],
      cwd: '/repo/cap',
    });
    const explicitPeer = store.saveMemory({
      topic: '显式关键约束',
      content: '不可被自动突触挤占的显式关联',
      tags: ['unrelated-z'],
      cwd: '/repo/cap',
      linkedMemoryIds: [anchor.id],
    });
    for (let i = 0; i < 10; i++) {
      const peer = store.saveMemory({
        topic: `同域关联节点 ${i}`,
        content: `节点 ${i} 详情`,
        tags: ['hub-alpha', 'hub-beta'],
        cwd: '/repo/cap',
      });
      if (i >= 4) {
        // Manually link more weak co_activated synapses to push total auto-synapses past 8
        store.linkMemories(anchor.id, peer.id, 'co_activated', 0.35 + i * 0.02);
      }
      if (i === 0) {
        // First peer after explicitPeer is auto-wired; check <= 4 limit via a single bulk save below
      }
    }
    const burstCard = store.saveMemory({
      topic: '批量并发节点',
      content: '验证单次 saveMemory 最多自动连边 4 个 peer',
      tags: ['hub-alpha', 'hub-beta'],
      cwd: '/repo/cap',
    });
    assert.ok((burstCard.synapses?.length ?? 0) <= 4, `auto-wired peers per saveMemory capped at <= 4, got ${burstCard.synapses?.length}`);

    const anchorAfterCap = store.getMemory(anchor.id);
    const autoSyns = (anchorAfterCap.synapses ?? []).filter(s => s.relation !== 'explicit');
    const explicitSyns = (anchorAfterCap.synapses ?? []).filter(s => s.relation === 'explicit');
    assert.ok(autoSyns.length <= 8, `auto-synapses capped at <= 8, got ${autoSyns.length}`);
    assert.equal(explicitSyns.some(s => s.targetId === explicitPeer.id), true, 'explicit synapse is never evicted by auto-synapses');

    // 5. Cross-cwd spreading block & memoriesForContext isolation
    const projBIsolated = store.saveMemory({
      topic: 'Project-B 私有策略',
      content: '完全不匹配查询词的跨项目孤立节点内容。',
      tags: ['isolated-b'],
      cwd: '/repo/project-b',
    });
    store.linkMemories(projA2.id, projBIsolated.id, 'explicit', 0.9);
    const spreadCrossSearch = store.searchContext({ query: '最大连接数调整为 64', scope: 'memories', cwd: '/repo/project-a' });
    assert.ok(spreadCrossSearch.hits.some(h => h.memoryId === projA2.id));
    assert.equal(
      spreadCrossSearch.hits.some(h => h.memoryId === projBIsolated.id),
      false,
      '1-hop spreading blocks conflicting cross-cwd candidate even on explicit link',
    );
    const ctxProjectA = store.memoriesForContext({ memoryIds: [projA2.id], cwd: '/repo/project-a', limit: 10 });
    assert.equal(ctxProjectA.some(c => c.id === projBIsolated.id), false, 'memoriesForContext never pulls conflicting cross-cwd neighbor');
    assert.equal(ctxProjectA.some(c => c.id === s1.id), false, 'memoriesForContext never pads with unrelated cwd cards');
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Global Memory Step 8: resolveRuntimeMessageSession leverages SemanticEmbedder for paraphrased continuity', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-sess-sem-'));
  const store = new Store(home);
  const embedder = createMockSemanticEmbedder();
  const noDecisionHub = { hasDecisionEngine: () => false } as unknown as ModelHub;
  try {
    const baseAt = Date.now() - 400_000;
    const u1 = store.conversation.create({
      id: 'sem-u1',
      role: 'user',
      origin: { channel: 'local' },
      sessionId: 'session:flow:sem-u1',
      text: '我们把服务端鉴权架构切换到 Ed25519 JWT 模式吧',
      status: 'completed',
      paths: [],
      mode: 'offline',
      at: baseAt,
    });
    store.conversation.create({
      id: 'sem-r1',
      replyTo: u1.id,
      role: 'assistant',
      origin: { channel: 'local' },
      sessionId: 'session:flow:sem-u1',
      text: '好的，已完成方案确认。',
      status: 'completed',
      paths: [],
      mode: 'offline',
      at: baseAt + 2_000,
    });

    // 300s later, zero keyword/CJK-bigram overlap with u1, yet semantically same topic ("oauth 登录校验过期时间设多久")
    const u2SameTopic = store.conversation.create({
      id: 'sem-u2',
      role: 'user',
      origin: { channel: 'local' },
      text: 'oauth 登录校验过期时间设多久',
      status: 'queued',
      paths: [],
      mode: 'offline',
      at: baseAt + 300_000,
    });
    const withoutSem = await resolveRuntimeMessageSession(store, noDecisionHub, u2SameTopic, []);
    assert.equal(withoutSem.sessionId, 'session:flow:sem-u2', 'without semantic embedder, zero-overlap paraphrase splits');

    const withSem = await resolveRuntimeMessageSession(store, noDecisionHub, u2SameTopic, [], embedder);
    assert.equal(withSem.sessionId, 'session:flow:sem-u1', 'with ready SemanticEmbedder, high-similarity paraphrase merges');
    assert.equal(withSem.sessionLink?.source, 'heuristic');
    assert.equal(withSem.sessionLink?.kind, 'topic_continuity');

    // Unrelated topic starts a new session even with semantic embedder
    const u3Unrelated = store.conversation.create({
      id: 'sem-u3',
      role: 'user',
      origin: { channel: 'local' },
      text: '明天北京会不会下雨',
      status: 'queued',
      paths: [],
      mode: 'offline',
      at: baseAt + 500_000,
    });
    const splitRes = await resolveRuntimeMessageSession(store, noDecisionHub, u3Unrelated, [], embedder);
    assert.equal(splitRes.sessionId, 'session:flow:sem-u3', 'low semantic similarity starts a fresh session');
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

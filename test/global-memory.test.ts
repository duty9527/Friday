import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Coordinator } from '../dist/coordinator.js';
import { serve } from '../dist/server.js';
import { startWeb } from '../dist/web-server.js';
import { request } from '../dist/protocol.js';
import { routeLabel, routeState, timelineSteps } from '../src/web/model.js';
import type { AgentFactory } from '../src/agent.js';

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
    assert.ok(finalView.memoryDirectory.items.some(m => m.tags.includes('auto-consolidated')), 'completed Worker task automatically consolidated into semantic memory');
    assert.ok(finalView.memoryDirectory.items.some(m => (m.accessCount ?? 0) > 0), 'Ebbinghaus retrieval reinforcement incremented accessCount on recalled memories');

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
    // 1. Auto-wiring via shared specific tags
    const n1 = store.saveMemory({
      topic: '网关限流阈值',
      content: '边缘网关对单 IP 限流为 200 RPS，突发桶容量 400。',
      tags: ['gateway', 'ratelimit'],
      cwd: '/repo/edge',
    });
    const n2 = store.saveMemory({
      topic: '熔断降级兜底',
      content: '下游超过 50% 错误率时返回静态缓存降级响应。',
      tags: ['gateway', 'circuit-breaker'],
      cwd: '/repo/edge',
    });

    const n1Fresh = store.getMemory(n1.id);
    assert.equal(n1Fresh.synapses?.length, 1, 'shared specific tag "gateway" automatically wires a synapse');
    assert.equal(n1Fresh.synapses![0]!.targetId, n2.id);
    assert.equal(n1Fresh.synapses![0]!.relation, 'shared_tag');

    // 2. Explicit synapse to a neuron that shares NO lexical overlap with n1
    const n3 = store.saveMemory({
      topic: '值班告警静默窗口',
      content: '每周三凌晨 03:00-04:00 压测演练期间暂停 PagerDuty 电话呼叫。',
      tags: ['oncall'],
      linkedMemoryIds: [n1.id],
    });
    assert.ok(n3.synapses?.some(s => s.targetId === n1.id && s.relation === 'explicit' && s.weight >= 0.8));

    // 3. 1-hop Spreading Activation: searching solely for "边缘网关 限流" directly hits n1,
    // and spreads activation across synapses to wake up n3 ("值班告警静默窗口") even though n3 has zero lexical match!
    const searchRes = store.searchContext({ query: '边缘网关 单 IP 限流', scope: 'memories' });
    const directHit = searchRes.hits.find(h => h.memoryId === n1.id);
    const spreadHit = searchRes.hits.find(h => h.memoryId === n3.id);
    assert.ok(directHit && !directHit.activatedVia, 'n1 is a direct seed hit');
    assert.ok(spreadHit, 'n3 is recalled via 1-hop synaptic spreading activation despite zero keyword overlap');
    assert.equal(spreadHit.activatedVia?.memoryId, n1.id);
    assert.equal(spreadHit.activatedVia?.topic, '网关限流阈值');
    assert.equal(spreadHit.activatedVia?.relation, 'explicit');

    // 4. Hebbian learning ("neurons that fire together, wire together") when compiled together in memoriesForContext
    const beforeW = store.getMemory(n1.id).synapses?.find(s => s.targetId === n2.id)?.weight ?? 0;
    const contextCards = store.memoriesForContext({ memoryIds: [n1.id, n2.id], limit: 5 });
    const afterW = store.getMemory(n1.id).synapses?.find(s => s.targetId === n2.id)?.weight ?? 0;
    assert.ok(afterW > beforeW, 'co-activating n1 and n2 in memoriesForContext strengthens their synaptic weight');
    assert.ok(contextCards.some(c => c.id === n3.id), 'memoriesForContext also pulls in 1-hop strong synaptic neighbor n3');

    // 5. Synaptic metabolism on superseding: updating n1 topic+cwd migrates its synapses to n1_v2 and redirects n3's synapse
    const n1V2 = store.saveMemory({
      topic: '网关限流阈值',
      content: '边缘网关对单 IP 限流上调为 500 RPS，突发桶容量 1000。',
      tags: ['gateway', 'ratelimit'],
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

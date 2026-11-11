import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Store } from '../src/store.js';
import { realFactory, offlineFactory, READONLY_TOOL_NAMES, type AgentFactory } from '../dist/agent.js';
import { Coordinator, computeSleepDrive } from '../dist/coordinator.js';

async function until(predicate: () => boolean | Promise<boolean>, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for condition');
}

test('Two-process sleep model (S x C): zero experience never sleeps, and deep night strongly favors REM dreaming over daytime', () => {
  const noExperience = computeSleepDrive({
    undigestedMessages: 0,
    undigestedTasks: 0,
    rawStubs: 0,
    idleMs: 6 * 3600_000,
    requiredLatencyMs: 30 * 60_000,
    sinceLastWakeMs: 12 * 3600_000,
    refractoryMs: 4 * 3600_000,
    localHour: 2.5,
  });
  assert.equal(noExperience.eligible, false);
  assert.equal(noExperience.pressureS, 0);
  assert.equal(noExperience.enterSleepProb, 0);

  const inRefractory = computeSleepDrive({
    undigestedMessages: 8,
    undigestedTasks: 2,
    rawStubs: 2,
    idleMs: 60 * 60_000,
    requiredLatencyMs: 30 * 60_000,
    sinceLastWakeMs: 1 * 3600_000,
    refractoryMs: 5 * 3600_000,
    localHour: 2.5,
  });
  assert.equal(inRefractory.eligible, false);

  const deepNight = computeSleepDrive({
    undigestedMessages: 10,
    undigestedTasks: 2,
    rawStubs: 2,
    idleMs: 60 * 60_000,
    requiredLatencyMs: 40 * 60_000,
    sinceLastWakeMs: 10 * 3600_000,
    refractoryMs: 5 * 3600_000,
    localHour: 2.5,
  });
  const brightMorning = computeSleepDrive({
    undigestedMessages: 10,
    undigestedTasks: 2,
    rawStubs: 2,
    idleMs: 60 * 60_000,
    requiredLatencyMs: 40 * 60_000,
    sinceLastWakeMs: 10 * 3600_000,
    refractoryMs: 5 * 3600_000,
    localHour: 10.5,
  });
  assert.equal(deepNight.eligible, true);
  assert.equal(brightMorning.eligible, true);
  assert.ok(deepNight.enterSleepProb > brightMorning.enterSleepProb * 4, 'deep night has much higher sleep propensity than daytime');
  assert.ok(deepNight.remProb > brightMorning.remProb, 'deep night has higher REM dreaming probability');
});

test('Synaptic homeostasis & dream amnesia: cold weak synapses prune, explicit synapses persist, and dream residues naturally fade away', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-dream-store-'));
  const store = new Store(home);
  try {
    const baseNow = Date.now();
    const cardA = store.saveMemory({ topic: '网关限流配置', content: '令牌桶每秒 200 请求', tags: ['gateway'] });
    const cardB = store.saveMemory({ topic: '临时调试日志规范', content: '本地开启 debug', tags: ['logging'] });
    const cardC = store.saveMemory({ topic: '核心数据库约定', content: 'SQLite WAL 单写入者', tags: ['sqlite'], pinned: true });
    const staleStub = store.saveMemory({
      topic: '任务经验 · 一次很久以前的临时检查',
      content: '交付摘要：无异常',
      tags: ['auto-consolidated', 'general'],
    });

    // Wire one weak co_activated synapse and one explicit synapse, then age them by 3 days
    store.linkMemories(cardA.id, cardB.id, 'co_activated', 0.19);
    store.linkMemories(cardA.id, cardC.id, 'explicit', 0.85);
    const future = baseNow + 15 * 24 * 3600_000;

    const pass = store.homeostaticSleepPass(future);
    assert.equal(pass.forgottenStubs, 1, '15-day-old zero-access auto-consolidated stub is naturally forgotten');
    assert.throws(() => store.getMemory(staleStub.id), /Memory not found/);
    assert.ok(pass.prunedSynapses >= 2, 'weak unreinforced co_activated synapse decays below 0.18 and is pruned on both ends');

    const refreshedA = store.getMemory(cardA.id);
    assert.equal(refreshedA.synapses?.some(s => s.targetId === cardB.id), false);
    assert.equal(refreshedA.synapses?.some(s => s.targetId === cardC.id && s.relation === 'explicit'), true, 'explicit synapse is protected');

    // Verify Dream Amnesia curve (clear -> hazy -> forgotten) and one-time insight consumption
    store.recordDreamOutcome({
      now: baseNow,
      completed: true,
      residue: {
        impression: '回想网关令牌桶限流时，画面忽然切到了 SQLite WAL 单写锁的队列背压机制上，两者的排队节奏几乎一模一样。',
        insight: '网关限流阈值高于下游 SQLite 单写吞吐时容易积压，后续可以对齐两边的队列上限。',
        salience: 'vivid',
      },
    });

    const freshPeek = store.peekSubconsciousForChat(baseNow + 30 * 60_000);
    assert.ok(freshPeek?.pendingInsight);
    assert.equal(freshPeek.impressions[0]?.vividness, 'clear');

    // After surfacing in one chat turn, pendingInsight is consumed so F. never nags repeatedly
    store.advanceSubconsciousTurn(freshPeek.pendingInsight.id, baseNow + 35 * 60_000);
    const secondPeek = store.peekSubconsciousForChat(baseNow + 10 * 3600_000);
    assert.equal(secondPeek?.pendingInsight, undefined, 'insight is surfaced at most once');
    assert.equal(secondPeek?.impressions[0]?.vividness, 'hazy', '10 hours later the dream impression has degraded to hazy');

    // 30 hours later, the dream has completely vanished from memory
    const vanished = store.peekSubconsciousForChat(baseNow + 30 * 3600_000);
    assert.equal(vanished, undefined, 'dream completely fades after its amnesia window');
    assert.equal(store.subconsciousState().residues.length, 0);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('REM sleep paralysis & sensory reality check: real SDK dreamer has read-only tools (no bash/edit/write), leaves zero disk session files, and verifies cwd files', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-dream-sdk-'));
  const workspace = await mkdtemp(join(await realpath(tmpdir()), 'sa-dream-repo-'));
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'src', 'auth.ts'), 'export const TOKEN_TTL_MINUTES = 5;\n');

  const observedToolSets: string[][] = [];
  let step = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { tools?: Array<{ function: { name: string } }> };
    const toolNames = (body.tools ?? []).map(t => t.function.name);
    observedToolSets.push(toolNames);

    step++;
    const delta = step === 1
      ? {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_read_1',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ path: join(workspace, 'src', 'auth.ts') }) },
          }],
        }
      : {
          role: 'assistant',
          content: JSON.stringify({
            impression: '回看 src/auth.ts 时注意到令牌有效期其实是 5 分钟，而不是白天模糊印象里的 15 分钟。',
            insight: 'src/auth.ts 里的 TOKEN_TTL_MINUTES 实际为 5 分钟，与旧记忆中的 15 分钟不一致。',
            salience: 'vivid',
          }),
        };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const packet = (d: unknown, finish: string | null) => ({
      id: 'dream-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta: d, finish_reason: finish }],
    });
    res.end(`data: ${JSON.stringify(packet(delta, null))}\n\ndata: ${JSON.stringify(packet({}, step === 1 ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');

  try {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, authPath: join(root, 'auth.json') });
    runtime.registerProvider('fixture', {
      baseUrl: `http://127.0.0.1:${addr.port}/v1`,
      api: 'openai-completions',
      apiKey: 'fixture-only',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 }],
    });
    const factory = await realFactory(root, { provider: 'fixture', model: 'fixture', apiKey: 'fixture-only' }, runtime);
    const dreamer = await factory.create('dreamer', 'ephemeral-dream', [{
      name: 'consolidate_memory',
      description: 'Consolidate memory',
      execute: async () => JSON.stringify({ ok: true }),
    }], { execution: 'native', cwd: workspace });

    try {
      assert.equal(dreamer.sessionFile, undefined, 'dreamer uses in-memory session without creating disk session transcripts');
      const out = await dreamer.prompt(JSON.stringify({ kind: 'DREAM', material: {} }), new AbortController().signal);
      assert.match(out, /TOKEN_TTL_MINUTES/);
      assert.ok(observedToolSets.length >= 2);
      const allowed = [...READONLY_TOOL_NAMES, 'consolidate_memory'].sort();
      assert.deepEqual([...observedToolSets[0]!].sort(), allowed, 'dreamer has ONLY read/ls/find/grep + plasticity tools');
      for (const forbidden of ['bash', 'edit', 'write']) {
        assert.equal(observedToolSets[0]!.includes(forbidden), false, `motor tool "${forbidden}" is physically absent during sleep`);
      }
      const sdkEntries = await readdir(join(root, 'sdk'));
      assert.equal(sdkEntries.includes('ephemeral-dream'), false, 'zero dreamer directory left under sdk/');
    } finally {
      dreamer.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await rm(root, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  }
});

test('Invisible natural dreaming & instant arousal: Coordinator dreams randomly at night without board/trace artifacts and wakes immediately on Boss chat', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-dream-coord-'));
  let virtualNow = new Date('2026-11-11T00:10:00').getTime();
  let randomVal = 0.05; // deterministic roll inside test

  const coordinator = new Coordinator(home, offlineFactory(15), {
    now: () => virtualNow,
    random: () => randomVal,
    checkIntervalMs: 50,
  });
  try {
    await coordinator.ready();
    // Seed an older distant memory and two noisy auto-consolidated task stubs + wakeful conversation
    const distant = coordinator.store.saveMemory({
      topic: '全局鉴权双令牌约定',
      content: '所有对外网关采用 Ed25519 短效令牌配合刷新令牌',
      tags: ['security', 'ed25519'],
      cwd: '/opt/legacy-auth',
    });
    const stub1 = coordinator.store.saveMemory({
      topic: '任务经验 · 检查会话过期时间',
      content: '任务目标：检查会话过期\n交付摘要：确认了短令牌 TTL 为 5 分钟',
      tags: ['auto-consolidated', 'coding'],
    });
    const stub2 = coordinator.store.saveMemory({
      topic: '任务经验 · 清理过期刷新令牌',
      content: '任务目标：清理过期刷新令牌\n交付摘要：增加了定时清理索引',
      tags: ['auto-consolidated', 'coding'],
    });

    const m1 = coordinator.chat('req-wake-1', '今天先把令牌清理这块收尾');
    await until(() => coordinator.store.conversation.get(m1.id).status === 'completed');

    const worksBefore = coordinator.view().works.length;
    const noticesBefore = coordinator.store.notices(0).length;
    const traceHeadBefore = coordinator.store.conversation.latestSeq();

    // Advance virtual clock into deep night (02:30) after 55 minutes of quietness
    virtualNow = new Date('2026-11-11T02:30:00').getTime();
    await until(() => coordinator.store.subconsciousState().lastWakeAt === virtualNow);

    // 1. Board & trace invisibility: zero tasks, zero notices, zero journal trace events emitted!
    assert.equal(coordinator.view().works.length, worksBefore, 'dreaming creates zero entries in task list');
    assert.equal(coordinator.store.notices(0).length, noticesBefore, 'dreaming emits zero system notices');
    assert.equal(coordinator.store.conversation.latestSeq(), traceHeadBefore, 'dreaming writes zero events to public execution trace');

    // 2. Silent NREM consolidation & REM distant synaptic wiring occurred naturally
    assert.ok(coordinator.store.getMemory(stub1.id).supersededBy, 'raw stub 1 was absorbed during NREM consolidation');
    assert.ok(coordinator.store.getMemory(stub2.id).supersededBy, 'raw stub 2 was absorbed during NREM consolidation');
    const consolidatedId = coordinator.store.getMemory(stub1.id).supersededBy!;
    const consolidated = coordinator.store.getMemory(consolidatedId);
    assert.doesNotMatch(consolidated.topic, /梦境|做梦|dream/i, 'consolidated memory has no artificial dream label');
    assert.equal(
      consolidated.synapses?.some(s => s.targetId === distant.id),
      true,
      'REM dreaming wired a cross-domain synapse to the distant memory neuron',
    );

    // 3. Normal chat does NOT volunteer dream chatter or leak subconscious into routing context / trace
    const m2 = coordinator.chat('req-wake-2', '早上好');
    await until(() => coordinator.store.conversation.get(m2.id).status === 'completed');
    const m2Full = coordinator.store.conversation.get(m2.id);
    assert.equal('subconscious' in (m2Full.routing?.context ?? {}), false, 'routing context on board never exposes subconscious');
    const m2Traces = JSON.stringify(coordinator.store.conversation.trace({ messageId: m2.id }));
    assert.doesNotMatch(m2Traces, /"subconscious"/, 'public journal trace strips subconscious payload');

    // 4. Only when the Boss curiously asks about dreaming while residue is still fresh, F. recalls the fragmentary impression
    const m3 = coordinator.chat('req-wake-3', '你昨晚有没有梦到什么？');
    await until(() => coordinator.store.conversation.get(m3.id).status === 'completed');
    const repliesAfterM3 = coordinator.store.conversation.history(undefined, 6).items.filter(m => m.replyTo === m3.id);
    assert.match(repliesAfterM3[0]!.text, /隐约记得|模糊印象/);
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Instant arousal preemption: an incoming Boss message immediately aborts an in-flight dream without blocking Router', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-dream-arouse-'));
  let virtualNow = new Date('2026-11-11T01:00:00').getTime();
  let dreamStarted = false;
  let dreamAborted = false;

  const baseOffline = offlineFactory(10);
  const slowDreamFactory: AgentFactory = {
    ...baseOffline,
    async create(role, id, tools, options) {
      if (role !== 'dreamer') return baseOffline.create(role, id, tools, options);
      return {
        close() {},
        async prompt(_text, signal) {
          dreamStarted = true;
          await new Promise<void>((_, reject) => {
            signal.addEventListener('abort', () => {
              dreamAborted = true;
              reject(signal.reason ?? new Error('Aborted'));
            }, { once: true });
          });
          return '{}';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, slowDreamFactory, {
    now: () => virtualNow,
    random: () => 0.01,
    checkIntervalMs: 30,
  });
  try {
    await coordinator.ready();
    coordinator.store.saveMemory({
      topic: '任务经验 · 构建脚本检查',
      content: '交付摘要：构建通过',
      tags: ['auto-consolidated'],
    });
    coordinator.store.saveMemory({
      topic: '任务经验 · 依赖安全扫描',
      content: '交付摘要：零漏洞',
      tags: ['auto-consolidated'],
    });
    const m1 = coordinator.chat('arouse-1', '先放着吧');
    await until(() => coordinator.store.conversation.get(m1.id).status === 'completed');

    // Advance into deep night so F. drifts into sleep
    virtualNow = new Date('2026-11-11T03:00:00').getTime();
    await until(() => dreamStarted);

    // Boss speaks while F. is mid-dream -> immediate arousal abort + zero delay on main chat
    const m2 = coordinator.chat('arouse-2', '在吗？帮我看个事');
    await until(() => dreamAborted);
    await until(() => coordinator.store.conversation.get(m2.id).status === 'completed');

    const stateAfterWake = coordinator.store.subconsciousState();
    assert.equal(stateAfterWake.residues.at(-1)?.interrupted, true, 'interrupted dream leaves only a fleeting half-awake fragment');
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

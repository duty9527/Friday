import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Conversation } from '../src/conversation.js';
import { offlineFactory, type AgentFactory } from '../src/agent.js';
import { Coordinator } from '../src/coordinator.js';
import { selectHeuristicRoute, decideWorkerRoute, type DecisionRouteCandidate } from '../src/decision.js';
import { distillIdleConversation, parseDistillerOutput } from '../src/distiller.js';
import { buildMindmapSnapshot, groupFlowsIntoSessions } from '../src/mindmap/snapshot.js';
import { buildRouterTurns, buildTaskDetail, sanitizeOrigin } from '../src/mindmap/trace-parser.js';
import { ModelHub } from '../src/model-hub.js';
import { parseModelSpec } from '../src/models/catalog.js';
import { fetchRemoteModelsFromEndpoint } from '../src/models/discovery.js';
import { createSemanticEngine } from '../src/semantic.js';
import { SqliteDb } from '../src/store/sqlite-db.js';
import { Store, TaskConflictError, type Task } from '../src/store.js';
import { PromptTrace } from '../src/trace.js';
import type { ChatMessage, TraceEvent } from '../src/view.js';

function makeCandidate(overrides: Partial<DecisionRouteCandidate>): DecisionRouteCandidate {
  return {
    spec: 'deepseek/deepseek-chat',
    providerId: 'deepseek',
    providerName: 'DeepSeek',
    modelId: 'deepseek-chat',
    modelName: 'DeepSeek Chat',
    thinkingLevels: ['off', 'low', 'medium'],
    supportsImages: false,
    reasoning: false,
    contextWindow: 128_000,
    specialties: ['通用执行'],
    costInput: 0.27,
    costOutput: 1.1,
    ...overrides,
  };
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    requestId: `req-${id}`,
    fingerprint: `fp-${id}`,
    prompt: `Task ${id}`,
    status: 'running',
    revision: 0,
    files: [],
    mode: 'real',
    createdAt: Date.now(),
    limitMs: 60_000,
    activeMs: 100,
    ...overrides,
  };
}

function makeUserMsg(id: string, text: string, extra: Partial<Omit<ChatMessage, 'seq' | 'version' | 'at' | 'taskIds'>> = {}) {
  return {
    id,
    role: 'user' as const,
    text,
    status: 'completed' as const,
    mode: 'offline' as const,
    paths: [],
    ...extra,
  };
}

test('SqliteDb: SQLITE_BUSY never leaks transaction depth, migrations bootstrap full schema & pinned column', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-sqlite-hardening-'));
  try {
    // 1. Fresh SqliteDb bootstraps metadata & conversation tables + user_version = 2
    const db1 = new SqliteDb(home);
    const tables = (db1.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map(r => r.name);
    for (const req of ['messages', 'message_tasks', 'journal', 'metadata', 'memories', 'tasks', 'model_usage']) {
      assert.ok(tables.includes(req), `table ${req} exists on fresh SqliteDb`);
    }
    const verRow = db1.db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(verRow.user_version, 2);

    // 2. Simulate SQLITE_BUSY from another connection holding IMMEDIATE lock
    const contender = new DatabaseSync(join(home, 'state.sqlite'));
    db1.db.exec('PRAGMA busy_timeout=10;');
    contender.exec('BEGIN IMMEDIATE;');
    assert.throws(
      () => db1.transaction(() => {
        db1.db.prepare('INSERT INTO metadata(key, value) VALUES(?,?)').run('k1', '"v1"');
      }),
      /database is locked|SQLITE_BUSY/i,
    );
    contender.exec('COMMIT;');
    contender.close();

    // After SQLITE_BUSY failure, depth MUST still be 0 so an error inside the next transaction rolls back cleanly!
    assert.throws(
      () => db1.transaction(() => {
        db1.db.prepare('INSERT INTO metadata(key, value) VALUES(?,?)').run('rollback_check', '"should_revert"');
        throw new Error('intentional inner failure');
      }),
      /intentional inner failure/,
    );
    const afterRollback = db1.db.prepare('SELECT value FROM metadata WHERE key=?').get('rollback_check');
    assert.equal(afterRollback, undefined, 'outer rollback must still run after earlier SQLITE_BUSY failure');
    db1.close();

    // 3. Legacy DB migration adds pinned column and backfills json_extract(body, $.pinned)
    const legacyHome = await mkdtemp(join(await realpath(tmpdir()), 'sa-sqlite-legacy-'));
    try {
      const legacyRaw = new DatabaseSync(join(legacyHome, 'state.sqlite'));
      legacyRaw.exec(`
        CREATE TABLE memories(id TEXT PRIMARY KEY, topic TEXT NOT NULL, cwd TEXT, superseded_by TEXT, updated_at INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE TABLE memory_embeddings(memory_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, dim INTEGER NOT NULL, content_hash TEXT NOT NULL, vector BLOB NOT NULL, updated_at INTEGER NOT NULL);
        INSERT INTO memories(id, topic, cwd, superseded_by, updated_at, body)
        VALUES('m-pin', 'Pinned legacy', NULL, NULL, 1000, '{"id":"m-pin","topic":"Pinned legacy","content":"hello","tags":[],"pinned":true,"createdAt":1000,"updatedAt":1000}');
        PRAGMA user_version = 0;
      `);
      legacyRaw.close();

      const migrated = new SqliteDb(legacyHome);
      const row = migrated.db.prepare('SELECT pinned FROM memories WHERE id=?').get('m-pin') as { pinned: number };
      assert.equal(row.pinned, 1);
      const v2 = migrated.db.prepare('PRAGMA user_version').get() as { user_version: number };
      assert.equal(v2.user_version, 2);
      migrated.close();
    } finally {
      await rm(legacyHome, { recursive: true, force: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Conversation & TaskStore: 65536 limits, recover resilience, corrupt JSON skip, trace reply isolation, patch CAS, and notice text', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-conv-task-'));
  try {
    const store = new Store(home);

    // 1. create() & update({ text }) enforce 65,536 limit
    assert.throws(
      () => store.conversation.create(makeUserMsg('too-long-create', 'a'.repeat(65_537))),
      /65536/,
    );
    const validMsg = store.conversation.create(makeUserMsg('msg-ok', 'hello', { status: 'processing' }));
    assert.throws(
      () => store.conversation.update(validMsg.id, { text: 'b'.repeat(65_537) }),
      /65536/,
    );

    // 2. Legacy oversized queued message + corrupt JSON row do not crash recover() or list queries
    const sqlite = new SqliteDb(home);
    const legacyOverLimit = {
      id: 'legacy-over-65k',
      role: 'assistant',
      text: 'x'.repeat(70_000),
      status: 'streaming',
      mode: 'real',
      paths: [],
      at: Date.now(),
    };
    sqlite.db.prepare('INSERT INTO messages(id, request_id, body) VALUES(?,?,?)').run(
      legacyOverLimit.id,
      null,
      JSON.stringify(legacyOverLimit),
    );
    sqlite.db.prepare('INSERT INTO messages(id, request_id, body) VALUES(?,?,?)').run(
      'corrupt-msg',
      null,
      '{corrupt json!!!',
    );
    sqlite.db.prepare('INSERT INTO journal(root_id, task_id, message_id, body) VALUES(?,?,?,?)').run(
      validMsg.id,
      null,
      validMsg.id,
      '{bad-journal-json',
    );
    sqlite.close();

    assert.doesNotThrow(() => store.recover());
    assert.equal(store.conversation.get('legacy-over-65k').status, 'interrupted');
    assert.ok(store.conversation.history(undefined, 20).items.length >= 2);
    assert.ok(store.conversation.structuredJournalForScopes([validMsg.id], []).length >= 1);

    // 3. trace({ taskId }) includes own linked assistant reply events and excludes sibling reply events
    const origin = store.conversation.create(makeUserMsg('origin-u1', 'do A and B'));
    const taskA = makeTask('task-a', { originMessageId: origin.id });
    const taskB = makeTask('task-b', { originMessageId: origin.id });
    store.create(taskA);
    store.create(taskB);
    store.conversation.link(origin.id, taskA.id);
    store.conversation.link(origin.id, taskB.id);

    const replyA = store.conversation.create({
      id: 'reply-a',
      replyTo: origin.id,
      role: 'assistant',
      text: 'Reply for A',
      status: 'completed',
      mode: 'offline',
      paths: [],
    });
    const replyB = store.conversation.create({
      id: 'reply-b',
      replyTo: origin.id,
      role: 'assistant',
      text: 'Reply for B',
      status: 'completed',
      mode: 'offline',
      paths: [],
    });
    store.conversation.link(replyA.id, taskA.id);
    store.conversation.link(replyB.id, taskB.id);

    const traceA = store.conversation.trace({ taskId: taskA.id });
    assert.ok(traceA.some(ev => ev.messageId === replyA.id && ev.kind === 'message_created'));
    assert.ok(!traceA.some(ev => ev.messageId === replyB.id), 'sibling reply must not leak into trace({ taskId: taskA })');

    // 4. TaskStore.patch CAS optimistic locking
    const patched = store.patchTask(taskA.id, cur => { cur.reason = 'rev-1'; }, { expectedRevision: 0 });
    assert.equal(patched.revision, 1);
    assert.equal(patched.reason, 'rev-1');
    assert.throws(
      () => store.patchTask(taskA.id, cur => { cur.reason = 'stale'; }, { expectedRevision: 0 }),
      TaskConflictError,
    );

    // 5. TaskStore.notice includes text in followup / followup_failed journal task_state.data
    store.notice(taskA.id, 'followup_failed', 'worker unavailable');
    const afterNotice = store.conversation.trace({ taskId: taskA.id });
    const failNoticeEvent = afterNotice.find(ev => ev.kind === 'task_state' && ev.status === 'followup_failed');
    assert.ok(failNoticeEvent);
    assert.equal((failNoticeEvent.data as { text?: string })?.text, 'worker unavailable');

    // 6. RuntimeOpsStore masks credentials in ImChannelView.apiBase
    store.saveImChannel({
      id: 'xiaoai-1',
      platform: 'xiaoai',
      name: 'XiaoAI',
      enabled: true,
      notifyAll: true,
      apiBase: 'ssh://oh2p=root:TopSecretPass99@192.168.1.88:22,key=test',
      allowedSenders: [],
      inboundCount: 0,
      outboundCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const view = store.listImChannelViews()[0]!;
    assert.equal(view.loginStatus, 'bound');
    assert.ok(!view.apiBase?.includes('TopSecretPass99'), 'apiBase password must be masked in view');
    assert.ok(view.apiBase?.includes('ssh://oh2p=root:***@192.168.1.88:22'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('MemoryStore: pinned survival (>24 unpinned), unpin importance restore, tags: [], dedup/delete synapse cleanup, >500 backfill', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-memory-hardening-'));
  try {
    const store = new Store(home);

    // 1. Pin + unpin importance restore + tags: [] explicit clear
    const card = store.saveMemory({
      topic: 'Pinned target',
      content: 'Important rule',
      tags: ['arch', 'db'],
      importance: 62,
    });
    const pinnedCard = store.pinMemory(card.id, true);
    assert.equal(pinnedCard.pinned, true);
    assert.equal(pinnedCard.importance, 90);

    // Create 30 newer unpinned cards -> pinned card must survive limit=24 directory/list
    for (let i = 0; i < 30; i++) {
      store.saveMemory({
        topic: `Recent note ${i}`,
        content: `Unrelated filler ${i}`,
        tags: [`tag-${i}`],
      });
    }
    const top10 = store.listMemories({ limit: 10 });
    assert.ok(top10.some(c => c.id === card.id), 'pinned card survives SQL LIMIT even with 30 newer unpinned cards');
    assert.ok(store.memoryDirectory(10).items.some(i => i.id === card.id));

    const unpinned = store.pinMemory(card.id, false);
    assert.equal(unpinned.pinned, undefined);
    assert.equal(unpinned.importance, 62, 'unpinning restores original importance instead of staying at 90');

    const clearedTags = store.saveMemory({
      id: card.id,
      topic: 'Pinned target',
      content: 'Important rule updated',
      tags: [],
    });
    assert.deepEqual(clearedTags.tags, []);

    // 2. Explicit supersede merge cleans intra-batch dead synapses and redirects neighbors
    const p1 = store.saveMemory({ topic: 'Alpha rule v1', content: 'A1', tags: ['v1'] });
    const p2 = store.saveMemory({ topic: 'Alpha rule v2', content: 'A2', tags: ['v2'] });
    const neighbor = store.saveMemory({ topic: 'Beta neighbor', content: 'B', tags: ['b'] });
    store.linkMemories(p1.id, p2.id, 'explicit', 0.8);
    store.linkMemories(p1.id, neighbor.id, 'explicit', 0.85);
    const merged = store.saveMemory({
      topic: 'Alpha rule unified',
      content: 'Unified A1 + A2',
      tags: ['unified'],
      supersedeIds: [p1.id, p2.id],
    });
    assert.ok(!merged.synapses?.some(s => s.targetId === p1.id || s.targetId === p2.id), 'must not inherit dead synapses to merged peers');
    assert.ok(merged.synapses?.some(s => s.targetId === neighbor.id));
    const refreshedNeighbor = store.getMemory(neighbor.id);
    assert.ok(!refreshedNeighbor.synapses?.some(s => s.targetId === p1.id));
    assert.ok(refreshedNeighbor.synapses?.some(s => s.targetId === merged.id));

    // 3. One-way incoming synapse cleanup on deleteMemory
    const oneWaySrc = store.saveMemory({ topic: 'One-way source', content: 'src', tags: ['src'] });
    const oneWayDst = store.saveMemory({ topic: 'One-way target', content: 'dst', tags: ['dst'] });
    const sqlite = new SqliteDb(home);
    oneWaySrc.synapses = [{ targetId: oneWayDst.id, targetTopic: oneWayDst.topic, relation: 'explicit', weight: 0.9, updatedAt: Date.now() }];
    sqlite.db.prepare('UPDATE memories SET body=? WHERE id=?').run(JSON.stringify(oneWaySrc), oneWaySrc.id);
    sqlite.close();
    assert.equal(store.deleteMemory(oneWayDst.id), true);
    assert.ok(!store.getMemory(oneWaySrc.id).synapses?.some(s => s.targetId === oneWayDst.id));

    // 4. backfillEmbeddings paginates past the 500th active card
    let embeddedCount = 0;
    store.attachSemanticEngine({
      modelId: 'mock-embed',
      dim: 4,
      isReady: () => true,
      embed: async () => new Float32Array([1, 0, 0, 0]),
      embedBatch: async texts => texts.map(() => {
        embeddedCount += 1;
        return new Float32Array([1, 0, 0, 0]);
      }),
      close: async () => {},
    });
    const baseCards: string[] = [];
    for (let i = 0; i < 515; i++) {
      const uid = `${i}k${(i * 7919 + 17).toString(36)}z${(i * 104729 + 31).toString(36)}`;
      const created = store.saveMemory({
        topic: `DistinctTopic-${uid}`,
        content: `alpha${uid} beta${uid} gamma${uid} delta${uid} epsilon${uid}`,
        tags: [`tag-${uid}`],
      });
      baseCards.push(created.id);
    }
    const firstBatch = await store.backfillEmbeddings(500);
    assert.equal(firstBatch, 500);
    const secondBatch = await store.backfillEmbeddings(100);
    assert.ok(secondBatch >= 15, `expected second backfill pass to reach cards beyond 500, got ${secondBatch}`);
    assert.ok(embeddedCount >= 515);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('ConsolidationStore & Distiller: daily sleep idempotency, ASC scan, member filtering, nested fence JSON', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-consolidate-'));
  try {
    const store = new Store(home);
    const c1 = store.saveMemory({ topic: 'Syn A', content: 'A', tags: ['a'] });
    const c2 = store.saveMemory({ topic: 'Syn B', content: 'B', tags: ['b'] });
    store.linkMemories(c1.id, c2.id, 'co_activated', 0.5);

    const day1 = Date.now() + 8 * 24 * 3600_000;
    const pass1 = store.homeostaticSleepPass(day1);
    assert.ok(pass1.scaledSynapses >= 2);
    const weightAfterPass1 = store.getMemory(c1.id).synapses?.find(s => s.targetId === c2.id)?.weight;
    assert.equal(weightAfterPass1, 0.41);

    // Same day re-run must be idempotent
    const pass1Repeat = store.homeostaticSleepPass(day1 + 3600_000);
    assert.deepEqual(pass1Repeat, {
      scaledSynapses: 0,
      prunedSynapses: 0,
      forgottenStubs: 0,
      decayedCards: 0,
      prunedColdCards: 0,
    });
    assert.equal(store.getMemory(c1.id).synapses?.find(s => s.targetId === c2.id)?.weight, 0.41);

    // sampleDreamMaterial filters out member role messages & does not advance cursor past streaming messages
    store.conversation.create(makeUserMsg('owner-1', 'Owner architectural choice', {
      origin: { channel: 'wechat', speakerRole: 'owner', speakerId: 'u-owner', speakerName: 'Boss' },
    }));
    store.conversation.create(makeUserMsg('member-1', 'Member casual noise', {
      origin: { channel: 'wechat', speakerRole: 'member', speakerId: 'u-member', speakerName: 'Guest' },
    }));
    const streaming = store.conversation.create(makeUserMsg('streaming-1', 'Still streaming...', {
      status: 'streaming',
    }));

    const dreamMat = store.sampleDreamMaterial(() => 0.5);
    assert.equal(dreamMat.undigestedMessages.some(m => m.id === 'member-1'), false);
    assert.ok(dreamMat.undigestedMessages.some(m => m.id === 'owner-1'));
    assert.ok(dreamMat.latestMessageSeq < streaming.seq, 'cursor must stop before streaming message');

    // parseDistillerOutput extracts JSON even with nested markdown code fences in string values
    const nestedFenceOutput = [
      'Here are the extracted memories:',
      '```json',
      '{',
      '  "operations": [',
      '    {',
      '      "action": "save",',
      '      "topic": "TS logger pattern",',
      '      "content": "Example:\\n```ts\\nconsole.log(\\"ok\\");\\n```\\nKeep concise.",',
      '      "tags": ["typescript", "logging"]',
      '    }',
      '  ]',
      '}',
      '```',
    ].join('\n');
    const ops = parseDistillerOutput(nestedFenceOutput);
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.topic, 'TS logger pattern');
    assert.ok(ops[0]!.content.includes('```ts'));

    // distillIdleConversation processes oldest 20 window and ignores member messages
    const msgs: ChatMessage[] = [];
    for (let i = 1; i <= 25; i++) {
      msgs.push(store.conversation.create(makeUserMsg(`d-${i}`, `Decision detail number ${i} about module ${i}`)));
    }
    const memberOnlyMsg = store.conversation.create(makeUserMsg('d-member', 'Member side chatter', {
      origin: { channel: 'wechat', speakerRole: 'member', speakerId: 'm-1' },
    }));

    let promptedCount = 0;
    const defaultTiers = offlineFactory(5).modelTiers!;
    const mockFactory: AgentFactory = {
      mode: 'offline',
      modelTiers: defaultTiers,
      async create() {
        return {
          close() {},
          async prompt(raw) {
            promptedCount += 1;
            const parsed = JSON.parse(raw) as { messages: Array<{ text: string }> };
            assert.equal(parsed.messages.length, 20, 'should slice oldest 20');
            return '{"operations":[]}';
          },
        };
      },
    };
    const modelHub = new ModelHub(home, 'offline', { ...defaultTiers }, 'offline');
    await distillIdleConversation({ store, factory: mockFactory, modelHub, messages: msgs });
    assert.equal(promptedCount, 1);
    assert.equal(store.distillerState().lastMessageSeq, msgs[19]!.seq, 'maxSeq advances only past oldest 20');

    // Member-only batch does NOT invoke LLM
    const resMemberOnly = await distillIdleConversation({ store, factory: mockFactory, modelHub, messages: [memberOnlyMsg] });
    assert.equal(resMemberOnly.skipped, true);
    assert.equal(promptedCount, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('SemanticEngine: shared download abort isolation and dynamic embedding dimension inference', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-sem-hardening-'));
  try {
    const modelsDir = join(home, 'models');
    // 1. Dynamic dimension inference (unknown modelRepo guesses 512, inference outputs 768)
    const engine = createSemanticEngine({
      homeDir: home,
      modelsDir,
      modelRepo: 'custom-org/custom-768d-encoder',
      autoDownload: false,
      tokenizerFactory: async () => ({
        encode: () => ({ ids: [101, 2023, 102], attention_mask: [1, 1, 1] }),
      }),
      sessionFactory: async () => ({
        inputNames: ['input_ids', 'attention_mask'],
        outputNames: ['last_hidden_state'],
        run: async () => {
          const data = new Float32Array(3 * 768).fill(0.5);
          return {
            last_hidden_state: { type: 'float32', dims: [1, 3, 768], data },
          };
        },
        release: async () => {},
      }),
    });
    // Create placeholder files so autoDownload=false loads them
    const repoDir = join(modelsDir, 'custom-org--custom-768d-encoder');
    await mkdir(join(repoDir, 'onnx'), { recursive: true });
    await writeFile(join(repoDir, 'tokenizer.json'), '{}');
    await writeFile(join(repoDir, 'onnx', 'model_quantized.onnx'), 'onnx');

    assert.equal(await engine.ensureReady?.(), true);
    const vec = await engine.embed('test dynamic dim');
    assert.ok(vec);
    assert.equal(vec.length, 768);
    assert.equal(engine.dim, 768, 'dim dynamically updates from output tensor');
    await engine.close?.();

    // 2. Shared download isolation: aborting caller 1 must not cancel caller 2
    const dlModelsDir = join(home, 'dl-models');
    let fetchAborted = false;
    const delayedFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { fetchAborted = true; });
      await delay(60);
      if (init?.signal?.aborted) throw new Error('aborted');
      return new Response(JSON.stringify({ model: {} }), { status: 200 });
    }) as typeof fetch;

    const e1 = createSemanticEngine({
      homeDir: home,
      modelsDir: dlModelsDir,
      modelRepo: 'org/shared-model',
      autoDownload: true,
      fetchImpl: delayedFetch,
      tokenizerFactory: async () => ({ encode: () => ({ ids: [1, 2], attention_mask: [1, 1] }) }),
      sessionFactory: async () => ({
        inputNames: ['input_ids', 'attention_mask'],
        outputNames: ['sentence_embedding'],
        run: async () => ({ sentence_embedding: { type: 'float32', dims: [1, 4], data: new Float32Array([1, 0, 0, 0]) } }),
      }),
    });
    const e2 = createSemanticEngine({
      homeDir: home,
      modelsDir: dlModelsDir,
      modelRepo: 'org/shared-model',
      autoDownload: true,
      fetchImpl: delayedFetch,
      tokenizerFactory: async () => ({ encode: () => ({ ids: [1, 2], attention_mask: [1, 1] }) }),
      sessionFactory: async () => ({
        inputNames: ['input_ids', 'attention_mask'],
        outputNames: ['sentence_embedding'],
        run: async () => ({ sentence_embedding: { type: 'float32', dims: [1, 4], data: new Float32Array([1, 0, 0, 0]) } }),
      }),
    });

    const ac1 = new AbortController();
    const p1 = e1.ensureReady!(ac1.signal);
    const p2 = e2.ensureReady!();
    await delay(10);
    ac1.abort();
    assert.equal(await p1, false);
    assert.equal(await p2, true, 'caller 2 completes even after caller 1 aborts');
    assert.equal(fetchAborted, false, 'underlying download fetch is not aborted while waiter 2 remains');
    await e1.close?.();
    await e2.close?.();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('ModelHub, parseModelSpec, discovery, decision & UsageStore hardening', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-hub-usage-'));
  try {
    // 1. parseModelSpec handles multi-slash OpenRouter & SiliconFlow specs
    assert.deepEqual(
      parseModelSpec('openrouter/anthropic/claude-sonnet-4'),
      { providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-4', spec: 'openrouter/anthropic/claude-sonnet-4', explicitLevel: undefined },
    );
    assert.deepEqual(
      parseModelSpec('siliconflow/deepseek-ai/DeepSeek-R1@high'),
      { providerId: 'siliconflow', modelId: 'deepseek-ai/DeepSeek-R1', spec: 'siliconflow/deepseek-ai/DeepSeek-R1', explicitLevel: 'high' },
    );
    assert.deepEqual(
      parseModelSpec('anthropic/claude-sonnet-4', { fallbackProvider: 'openrouter', preferFallbackProvider: true }),
      { providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-4', spec: 'openrouter/anthropic/claude-sonnet-4', explicitLevel: undefined },
    );

    // 2. discovery.ts Google sends x-goog-api-key header instead of ?key= query param
    const origFetch = globalThis.fetch;
    const seenDiscoveryReqs: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seenDiscoveryReqs.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(JSON.stringify({
        models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }],
      }), { status: 200 });
    }) as typeof fetch;
    try {
      await fetchRemoteModelsFromEndpoint('google', 'AIzaTestSecretKey12345', undefined, []);
      assert.equal(seenDiscoveryReqs.length, 1);
      assert.ok(!seenDiscoveryReqs[0]!.url.includes('AIzaTestSecretKey12345'), 'Google API key must not appear in URL');
      assert.equal(seenDiscoveryReqs[0]!.headers['x-goog-api-key'], 'AIzaTestSecretKey12345');
    } finally {
      globalThis.fetch = origFetch;
    }

    // 3. ModelHub: env key non-persistence, env rotation, routerModel validation, baseUrl clearing, HTTP safety, cross-origin protection
    const tiers = offlineFactory(5).modelTiers!;
    const hub = new ModelHub(home, 'offline', { ...tiers }, 'deepseek');
    await hub.init({ deepseek: 'sk-env-secret-v1' });
    await hub.configure({ providerId: 'deepseek', customModels: ['deepseek-chat'] });
    const rawJson1 = JSON.parse(await readFile(join(home, 'sdk', 'model-hub.json'), 'utf8')) as {
      providers?: Record<string, { apiKey?: string }>;
    };
    assert.equal(rawJson1.providers?.deepseek?.apiKey, undefined, 'env API key must NOT be written to model-hub.json');
    const view1 = await hub.getView();
    assert.equal(view1.providers.find(p => p.id === 'deepseek')?.authType, 'environment');

    // Invalid routerModel rejects before modifying state
    await assert.rejects(
      () => hub.configure({ routerProvider: 'deepseek', routerModel: 'deepseek/does-not-exist-999' }),
      /未找到主控模型/,
    );
    assert.equal((await hub.getView()).routerModel, tiers.router);

    // Non-loopback plaintext HTTP with credentials rejects
    await assert.rejects(
      () => hub.configure({ providerId: 'openai', apiKey: 'sk-openai-123', baseUrl: 'http://remote.insecure.example/v1' }),
      /安全限制/,
    );

    // Local loopback server: probe cross-origin protection & failCount decay/reset
    let sawAuthHeader: string | undefined;
    const srv = createServer((req, res) => {
      sawAuthHeader = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      const chunk1 = JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: '老板好' }, finish_reason: null }],
      });
      const chunk2 = JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
      res.end(`data: ${chunk1}\n\ndata: ${chunk2}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
    const port = (srv.address() as { port: number }).port;
    try {
      // Configure openai key at official endpoint, then probe an inline different origin without inlineApiKey
      await hub.configure({
        providerId: 'openai',
        apiKey: 'sk-openai-secret-9999',
        selectedModels: [{ id: 'gpt-4.1' }],
      });
      await hub.probe({
        provider: 'openai',
        model: 'gpt-4.1',
        baseUrl: `http://127.0.0.1:${port}/v1`,
      });
      assert.equal(sawAuthHeader, undefined, 'cross-origin inlineBaseUrl must not leak stored OpenAI API key');

      // Now explicitly configure same baseUrl and verify probe resets failCount = 0
      hub.recordTaskOutcome('openai/gpt-4.1', false);
      hub.recordTaskOutcome('openai/gpt-4.1', false);
      assert.equal(hub.getModelPool().find(p => p.spec === 'openai/gpt-4.1')?.failCount, 2);

      await hub.configure({ providerId: 'openai', baseUrl: `http://127.0.0.1:${port}/v1` });
      const okProbe = await hub.probe({ provider: 'openai', model: 'gpt-4.1' });
      assert.equal(okProbe.ok, true);
      assert.equal(hub.getModelPool().find(p => p.spec === 'openai/gpt-4.1')?.failCount, 0, 'successful probe resets failCount');

      // Clearing baseUrl wipes stale fetchedModels
      await hub.configure({ providerId: 'openai', baseUrl: '' });
      assert.equal((await hub.getView()).providers.find(p => p.id === 'openai')?.baseUrl, undefined);
    } finally {
      srv.close();
      await hub.close();
    }

    // 4. Decision routing fixes: excluded all error, hasImages hard filter, no -200 text penalty on "image"/"diagram"
    const textStrong = makeCandidate({
      spec: 'deepseek/deepseek-reasoner',
      providerId: 'deepseek',
      modelId: 'deepseek-reasoner',
      thinkingLevels: ['off', 'high'],
      supportsImages: false,
      reasoning: true,
      specialties: ['深度推理', '代码工程'],
    });
    const visionFast = makeCandidate({
      spec: 'openai/gpt-4o-mini',
      providerId: 'openai',
      modelId: 'gpt-4o-mini',
      thinkingLevels: ['off', 'low'],
      supportsImages: true,
      reasoning: false,
    });

    assert.throws(
      () => selectHeuristicRoute([textStrong, visionFast], {
        instruction: 'task',
        excludedSpecs: ['deepseek/deepseek-reasoner', 'openai/gpt-4o-mini'],
      }),
      /均已被排除/,
    );
    await assert.rejects(
      () => decideWorkerRoute([textStrong, visionFast], {
        instruction: 'task',
        excludedSpecs: ['deepseek/deepseek-reasoner', 'openai/gpt-4o-mini'],
      }),
      /均已被排除/,
    );

    const imgPick = selectHeuristicRoute([textStrong, visionFast], {
      instruction: 'Debug this complex issue from logs and crash analysis',
      profile: 'coding',
      hasImages: true,
    });
    assert.equal(imgPick.candidate.spec, 'openai/gpt-4o-mini', 'hasImages: true hard-filters non-vision model');

    const textDiagramPick = selectHeuristicRoute([textStrong, visionFast], {
      instruction: 'Refactor docker image build script and sequence diagram parser',
      profile: 'coding',
      hasImages: false,
    });
    assert.equal(textDiagramPick.candidate.spec, 'deepseek/deepseek-reasoner', 'text coding prompt mentioning image/diagram is not penalized away from reasoning model');

    // 5. UsageStore: cutoffSeq prevents double counting live UUID rows on second backfill & DST-aware buckets
    const usageHome = await mkdtemp(join(await realpath(tmpdir()), 'sa-usage-cutoff-'));
    try {
      const store = new Store(usageHome);
      store.conversation.span(
        { rootId: 'm1', messageId: 'm1', spanId: 'sp1' },
        'router',
        '模型推理调用',
        'completed',
        { mode: 'real', detail: { usage: { input: 100, output: 20, totalTokens: 120 } } },
      );
      store.recover(); // Phase 1 without defaultProvider (cutoffSeq = 1)
      // Simulate live call after startup: writes BOTH live UUID row + journal seq = 2
      store.recordUsage({
        actor: 'router',
        provider: 'openai',
        model: 'gpt-4.1',
        usage: { input: 300, output: 50, totalTokens: 350 },
      });
      store.conversation.span(
        { rootId: 'm2', messageId: 'm2', spanId: 'sp2' },
        'router',
        '模型推理调用',
        'completed',
        { mode: 'real', detail: { usage: { input: 300, output: 50, totalTokens: 350 } } },
      );
      store.backfillUsage('openai', 'gpt-4.1'); // Phase 2 upgrades seq <= 1 ONLY
      const todayReport = store.queryUsage({ granularity: 'day' });
      assert.equal(todayReport.totals.calls, 2, 'must not double-count live seq=2 call during second backfill');
      assert.equal(todayReport.totals.totalTokens, 470);

      // DST test in America/New_York across spring-forward day 2026-03-08 (23-hour day)
      const prevTz = process.env.TZ;
      process.env.TZ = 'America/New_York';
      try {
        // 2026-03-08 23:30 EDT = 2026-03-09T03:30:00Z
        const springLateNight = Date.UTC(2026, 2, 9, 3, 30, 0);
        store.recordUsage({
          at: springLateNight,
          actor: 'worker',
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4',
          usage: { input: 10, output: 5, totalTokens: 15 },
        });
        const dstDay = store.queryUsage({ granularity: 'day', anchorDate: '2026-03-08' });
        assert.equal(dstDay.totals.calls, 1, '23:30 EDT on 2026-03-08 belongs to 2026-03-08 despite 23h DST transition');
        assert.equal(dstDay.byModel[0]!.spec, 'openrouter/anthropic/claude-sonnet-4');
      } finally {
        if (prevTz === undefined) delete process.env.TZ;
        else process.env.TZ = prevTz;
      }
    } finally {
      await rm(usageHome, { recursive: true, force: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('PromptTrace & Mindmap snapshot/trace-parser hardening', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-mindmap-hardening-'));
  try {
    const store = new Store(home);

    // 1. PromptTrace preserves parentSpanId on interrupted nested child span & resets active on bad input JSON
    const m = store.conversation.create(makeUserMsg('pt-u1', 'trace me'));
    const trace = new PromptTrace(store.conversation, { rootId: m.id, messageId: m.id }, 'worker', 'real');
    await assert.rejects(
      () => trace.run({ close() {}, prompt: async () => 'ok' }, '{bad-json', new AbortController().signal),
    );
    trace.observe({ kind: 'turn_start', id: 'should-ignore' });
    assert.equal(store.conversation.trace({ messageId: m.id }).some(e => e.label === '模型推理调用'), false);

    const ac = new AbortController();
    const trace2 = new PromptTrace(store.conversation, { rootId: m.id, messageId: m.id }, 'worker', 'real');
    await assert.rejects(
      () => trace2.run({
        close() {},
        async prompt() {
          trace2.observe({ kind: 'turn_start', id: 'turn-1' });
          trace2.observe({ kind: 'tool_start', id: 'call-1', parentId: 'turn-1', toolName: 'read_file', data: { path: 'a.ts' } });
          ac.abort(new Error('stopped'));
          return '';
        },
      }, JSON.stringify({ kind: 'TASK', prompt: 'run' }), ac.signal),
    );
    const ptEvents = store.conversation.trace({ messageId: m.id });
    const interruptedTool = ptEvents.find(e => e.label === 'read_file' && e.status === 'interrupted');
    assert.equal(interruptedTool?.parentSpanId, `${trace2.id}:turn-1`, 'interrupted child tool preserves turn parentSpanId');

    // 2. trace-parser: readUsageNumbers no double reasoning, sanitizeOrigin keeps speakerId/speakerName, WORKER_REPORT matches by taskId
    const originView = sanitizeOrigin({
      channel: 'wechat',
      senderId: 'wx-1',
      speakerId: 'spk-42',
      speakerName: 'Alice',
      speakerRole: 'owner',
      contextToken: 'secret-tok',
      replyWebhook: 'https://secret.hook',
    });
    assert.equal(originView?.speakerId, 'spk-42');
    assert.equal(originView?.speakerName, 'Alice');
    assert.equal((originView as { contextToken?: string })?.contextToken, undefined);

    const routerEvents: TraceEvent[] = [
      {
        id: 'e1', seq: 1, at: 1000, rootId: 'm1', messageId: 'm1', spanId: 'rt-1',
        type: 'trace', kind: 'span', actor: 'router', label: 'Agent 请求', status: 'started',
        data: { trigger: { kind: 'CHAT' } },
      },
      {
        id: 'e2', seq: 2, at: 1010, rootId: 'm1', messageId: 'm1', spanId: 'llm-1', parentSpanId: 'rt-1',
        type: 'trace', kind: 'span', actor: 'router', label: '模型推理调用', status: 'completed',
        data: { detail: { usage: { input: 100, output: 50, cacheRead: 10, reasoning: 30 } } },
      },
      {
        id: 'e3', seq: 3, at: 1020, rootId: 'm1', messageId: 'm1', spanId: 'rt-1',
        type: 'trace', kind: 'span', actor: 'router', label: 'Agent 请求', status: 'completed',
        data: {},
      },
      {
        id: 'e4', seq: 4, at: 2000, rootId: 'm1', messageId: 'm1', taskId: 'sibling-b', spanId: 'rt-report-b',
        type: 'trace', kind: 'span', actor: 'router', label: 'Agent 请求', status: 'started',
        data: { trigger: { kind: 'WORKER_REPORT', taskId: 'sibling-b' } },
      },
      {
        id: 'e5', seq: 5, at: 2010, rootId: 'm1', messageId: 'm1', taskId: 'sibling-a', spanId: 'rt-report-a',
        type: 'trace', kind: 'span', actor: 'router', label: 'Agent 请求', status: 'started',
        data: { trigger: { kind: 'WORKER_REPORT', taskId: 'sibling-a' } },
      },
    ];
    const turns = buildRouterTurns(routerEvents);
    assert.equal(turns[0]!.usage?.totalTokens, 160, 'readUsageNumbers must not double-count reasoning (100+50+10)');

    const taskA = makeTask('sibling-a', { createdAt: 1000 });
    store.create(taskA);
    const detailA = buildTaskDetail(store, taskA, [], turns, new Set<string>(), new Map());
    assert.equal(detailA.executionPhases[0]!.routerReportSpanId, 'rt-report-a', 'WORKER_REPORT matches strictly by taskId');

    // 3. Mindmap snapshot: orphans-only never returns infinite hasMore without beforeSeq; >2.1MB preserves orphanTasks; followup avoids double counting
    const orphanOnlyHome = await mkdtemp(join(await realpath(tmpdir()), 'sa-mm-orphan-'));
    try {
      const mmStore = new Store(orphanOnlyHome);
      mmStore.create(makeTask('orphan-1', { originMessageId: undefined, report: 'R'.repeat(3000) }));
      const mmTiers = offlineFactory(5).modelTiers!;
      const hub = new ModelHub(orphanOnlyHome, 'offline', { ...mmTiers }, 'offline');
      await hub.init();
      const fakeCoord = { store: mmStore, modelHub: hub } as unknown as Coordinator;
      const snapOrphanOnly = await buildMindmapSnapshot(fakeCoord);
      assert.equal(snapOrphanOnly.hasMore, false);
      assert.equal(snapOrphanOnly.beforeSeq, undefined);
      assert.equal(snapOrphanOnly.flows.length, 1);

      // Large chat flows (>2.1MB) + orphanTask preserves orphanTask
      const bigText = 'M'.repeat(1600);
      const summaryPad = 'S'.repeat(550);
      for (let i = 0; i < 110; i++) {
        const actions = Array.from({ length: 40 }, (_, k) => ({
          id: `act-${i}-${k}`,
          kind: 'reply' as const,
          status: 'accepted' as const,
          at: 1000 + i,
          summary: `${i}-${k}-${summaryPad}`,
        }));
        const um = mmStore.conversation.create(makeUserMsg(`big-u-${i}`, `${i}:${bigText}`, {
          routing: {
            at: 1000 + i,
            status: 'completed',
            context: { execution: 'native', cwd: orphanOnlyHome, totalWorks: 0, truncated: false, works: [], messages: [] },
            actions,
          },
        }));
        mmStore.conversation.create({
          id: `big-r-${i}`,
          replyTo: um.id,
          role: 'assistant',
          text: 'done',
          status: 'completed',
          mode: 'offline',
          paths: [],
        });
      }
      const snapLarge = await buildMindmapSnapshot(fakeCoord);
      assert.equal(snapLarge.hasMore, true);
      assert.ok((snapLarge.beforeSeq ?? 0) > 0);
      assert.ok(snapLarge.flows.some(f => f.id === 'flow:task:orphan-1'), 'orphan task preserved under >2.1MB message truncation');

      // Deduplicate task counts in groupFlowsIntoSessions across follow-up turns
      const sharedTask = detailA;
      const sessionGroup = groupFlowsIntoSessions([
        { ...snapOrphanOnly.flows[0]!, id: 'f1', seq: 1, sessionId: 's1', sessionPersisted: true, tasks: [sharedTask] },
        { ...snapOrphanOnly.flows[0]!, id: 'f2', seq: 2, sessionId: 's1', sessionPersisted: true, tasks: [sharedTask] },
      ]);
      assert.equal(sessionGroup[0]!.taskCount, 1, 'shared task across follow-up turns counted once');
      await hub.close();
    } finally {
      await rm(orphanOnlyHome, { recursive: true, force: true });
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

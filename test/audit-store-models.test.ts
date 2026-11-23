import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { offlineFactory } from '../src/agent.js';
import { parseDistillerOutput } from '../src/distiller.js';
import { buildRouterTurns, buildTaskDetail } from '../src/mindmap/trace-parser.js';
import { ModelHub } from '../src/model-hub.js';
import { fetchRemoteModelsFromEndpoint } from '../src/models/discovery.js';
import { createSemanticEngine } from '../src/semantic.js';
import { SqliteDb } from '../src/store/sqlite-db.js';
import { Store, type Task } from '../src/store.js';
import type { TraceEvent } from '../src/view.js';

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    requestId: `req-${id}`,
    fingerprint: `fp-${id}`,
    prompt: `Task ${id}`,
    status: 'running',
    revision: 0,
    files: [],
    mode: 'offline',
    createdAt: Date.now(),
    limitMs: 60_000,
    activeMs: 50,
    ...overrides,
  };
}

test('SqliteDb migrations tolerate malformed JSON in legacy memories rows', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-audit-sqlite-'));
  try {
    const legacy = new DatabaseSync(join(home, 'state.sqlite'));
    legacy.exec(`
      CREATE TABLE memories(id TEXT PRIMARY KEY, topic TEXT NOT NULL, cwd TEXT, superseded_by TEXT, updated_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE memory_embeddings(memory_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, dim INTEGER NOT NULL, content_hash TEXT NOT NULL, vector BLOB NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO memories(id, topic, cwd, superseded_by, updated_at, body)
      VALUES
        ('m-valid', 'Valid', NULL, NULL, 1000, '{"id":"m-valid","topic":"Valid","content":"ok","tags":[],"accessCount":4,"pinned":true,"createdAt":1000,"updatedAt":1000}'),
        ('m-corrupt', 'Corrupt', NULL, NULL, 1000, '{not-valid-json');
      PRAGMA user_version = 0;
    `);
    legacy.close();

    const db = new SqliteDb(home);
    try {
      const row = db.db.prepare('SELECT access_count, pinned FROM memories WHERE id=?').get('m-valid') as {
        access_count: number;
        pinned: number;
      };
      assert.equal(row.access_count, 4);
      assert.equal(row.pinned, 1);
      const corrupt = db.db.prepare('SELECT access_count, pinned FROM memories WHERE id=?').get('m-corrupt') as {
        access_count: number;
        pinned: number;
      };
      assert.equal(corrupt.access_count, 0);
      assert.equal(corrupt.pinned, 0);
      const ver = db.db.prepare('PRAGMA user_version').get() as { user_version: number };
      assert.equal(ver.user_version, 5);
    } finally {
      db.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('RuntimeOpsStore wechat_quote_cache pruning evicts by rowid without deleting same messageId in other conversations', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-audit-quote-'));
  try {
    const store = new Store(home);
    try {
      const db = (store as unknown as { sqlite: { db: DatabaseSync } }).sqlite.db;
      const baseTs = Date.now();
      store.transaction(() => {
        const stmt = db.prepare(
          `INSERT INTO wechat_quote_cache(
            channel_id, account_id, conversation_id, message_id,
            direction, body, media_path, media_mime, media_name, created_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?)`,
        );
        // Oldest record in conv-old with message_id='msg-shared'
        stmt.run('wx-1', 'acc-1', 'conv-old', 'msg-shared', 'inbound', 'old shared body', null, null, null, baseTs - 500_000);
        // 9950 middle records so total > 10,000 after 100 store writes
        for (let i = 0; i < 9950; i++) {
          stmt.run('wx-1', 'acc-1', 'conv-mid', `mid-${i}`, 'inbound', `mid ${i}`, null, null, null, baseTs - 400_000 + i);
        }
      });

      // Write newest record in conv-new with the SAME message_id='msg-shared' plus 99 more writes to trigger prune
      store.saveWechatQuoteRecord({
        channelId: 'wx-1',
        accountId: 'acc-1',
        conversationId: 'conv-new',
        messageId: 'msg-shared',
        direction: 'outbound',
        body: 'new shared body',
        createdAt: baseTs + 10_000,
      });
      for (let i = 0; i < 99; i++) {
        store.saveWechatQuoteRecord({
          channelId: 'wx-1',
          accountId: 'acc-1',
          conversationId: 'conv-tail',
          messageId: `tail-${i}`,
          direction: 'inbound',
          body: `tail ${i}`,
          createdAt: baseTs + 10_001 + i,
        });
      }

      // Old record in conv-old was evicted (> 10,000 cap), while conv-new's same messageId MUST remain intact
      assert.equal(store.findWechatQuoteRecord('wx-1', 'acc-1', 'conv-old', 'msg-shared'), undefined);
      const preserved = store.findWechatQuoteRecord('wx-1', 'acc-1', 'conv-new', 'msg-shared');
      assert.ok(preserved);
      assert.equal(preserved.body, 'new shared body');
    } finally {
      store.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('TaskStore.operation and recoverTasks tolerate corrupt operation/task JSON without aborting recovery', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-audit-task-'));
  try {
    const store = new Store(home);
    const db = (store as unknown as { sqlite: { db: DatabaseSync } }).sqlite.db;

    store.create(makeTask('task-healthy', { status: 'running' }));
    store.create(makeTask('task-corrupt', { status: 'running' }));
    store.operation({ id: 'op-corrupt-prev', taskId: 'task-healthy', revision: 0, fileId: 'f1', status: 'started' });
    store.operation({ id: 'op-on-corrupt-task', taskId: 'task-corrupt', revision: 0, fileId: 'f2', status: 'started' });

    // Corrupt existing operation body & one task body directly in SQLite
    db.prepare('UPDATE operations SET body=? WHERE id=?').run('{bad-op-json', 'op-corrupt-prev');
    db.prepare('UPDATE tasks SET body=? WHERE id=?').run('{bad-task-json', 'task-corrupt');

    // Updating the operation whose previous body was corrupt must not throw SyntaxError
    assert.doesNotThrow(() => {
      store.operation({ id: 'op-corrupt-prev', taskId: 'task-healthy', revision: 0, fileId: 'f1', status: 'succeeded', result: 'ok' });
    });
    assert.equal(store.operationById('op-corrupt-prev')?.status, 'succeeded');

    // Reset op-on-corrupt-task to 'started' and run recover(); healthy task must pause and op must turn 'unknown'
    store.close();
    const reopened = new Store(home);
    try {
      assert.doesNotThrow(() => reopened.recover());
      assert.equal(reopened.get('task-healthy').status, 'paused');
      assert.equal(reopened.operationById('op-on-corrupt-task')?.status, 'unknown');
    } finally {
      reopened.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('MemoryStore: hydrateEmbeddingCache LRU order, saveMemoryAsync tag preservation, stale DB cleanup, and memoryIds dedup', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-audit-mem-'));
  try {
    const store = new Store(home);
    const db = (store as unknown as { sqlite: { db: DatabaseSync } }).sqlite.db;

    // 1. Seed 4096 active cards + embeddings so cache is at full capacity (4096) on reopen
    const vecBytes = new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer);
    const oldestVecBytes = new Uint8Array(new Float32Array([0, 1, 0, 0]).buffer);
    store.transaction(() => {
      const mStmt = db.prepare(
        'INSERT INTO memories(id,topic,cwd,superseded_by,updated_at,access_count,last_accessed_at,last_reinforced_at,importance,pinned,body) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      );
      const eStmt = db.prepare(
        'INSERT INTO memory_embeddings(memory_id,model_id,dim,content_hash,vector,updated_at) VALUES(?,?,?,?,?,?)',
      );
      for (let i = 0; i < 4096; i++) {
        const id = `seed-${i}`;
        const ts = 1_000_000 + i;
        const card = { id, topic: `Seed ${i}`, content: `Body ${i}`, tags: [], createdAt: ts, updatedAt: ts };
        mStmt.run(id, card.topic, null, null, ts, 0, null, null, 50, 0, JSON.stringify(card));
        eStmt.run(id, 'mock-embed', 4, `h-${i}`, i === 0 ? oldestVecBytes : vecBytes, ts);
      }
    });
    store.close();

    // Reopen Store so hydrateEmbeddingCache runs, then add card #4097 (evicts 1 entry)
    const reopened = new Store(home);
    const reopenedDb = (reopened as unknown as { sqlite: { db: DatabaseSync } }).sqlite.db;
    const embeddedTexts: string[] = [];
    reopened.attachSemanticEngine({
      modelId: 'mock-embed',
      dim: 4,
      isReady: () => true,
      embed: async (text) => {
        embeddedTexts.push(text);
        return new Float32Array([0, 0, 1, 0]);
      },
      close: async () => {},
    });

    try {
      reopened.saveMemory({
        id: 'newest-4097',
        topic: 'Newest 4097',
        content: 'Brand new entry',
        tags: [],
        embedding: new Float32Array([0, 0, 0, 1]),
        embeddingModelId: 'mock-embed',
      });
      const cacheMap = (reopened as unknown as { memories: { embeddingCache: Map<string, unknown> } }).memories.embeddingCache;
      assert.equal(cacheMap.has('seed-0'), false, 'oldest hydrated entry must be evicted first');
      assert.equal(cacheMap.has('seed-4095'), true, 'newest hydrated entry must survive LRU eviction');
      assert.equal(cacheMap.has('newest-4097'), true);

      // 2. saveMemoryAsync preserves existing tags when updating without tags, and matches cache on repeat
      const tagged = await reopened.saveMemoryAsync({
        topic: 'Cache Tag Preservation',
        content: 'Initial content body',
        tags: ['alpha-tag', 'beta-tag'],
      });
      assert.equal(embeddedTexts.length, 1);
      assert.ok(embeddedTexts[0]!.includes('alpha-tag'));

      await reopened.saveMemoryAsync({
        id: tagged.id,
        topic: 'Cache Tag Preservation',
        content: 'Initial content body',
      });
      assert.equal(embeddedTexts.length, 1, 'identical topic/content with preserved tags hits embedding cache');

      await reopened.saveMemoryAsync({
        id: tagged.id,
        topic: 'Cache Tag Preservation',
        content: 'Updated content body',
      });
      assert.equal(embeddedTexts.length, 2);
      assert.ok(embeddedTexts[1]!.includes('alpha-tag'), 're-embedding preserves existing card tags');

      // 3. Sync saveMemory cleans up stale DB embedding even if card is not in embeddingCache
      cacheMap.delete(tagged.id);
      reopened.saveMemory({
        id: tagged.id,
        topic: 'Cache Tag Preservation',
        content: 'Sync edited content body',
      });
      const staleEmbRow = reopenedDb.prepare('SELECT * FROM memory_embeddings WHERE memory_id=?').get(tagged.id);
      assert.equal(staleEmbRow, undefined, 'stale DB embedding removed on sync update even after cache eviction');

      // 4. memoriesForContext deduplicates duplicate memoryIds
      const dupTarget = reopened.saveMemory({ topic: 'Dup touch check', content: 'Body', tags: ['dup'] });
      const ctxCards = reopened.memoriesForContext({ memoryIds: [dupTarget.id, dupTarget.id, dupTarget.id] });
      assert.equal(ctxCards.length, 1);
      assert.equal(reopened.getMemory(dupTarget.id).accessCount, 1);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('ConsolidationStore.homeostaticSleepPass handles >500 memories with corrupt JSON and pinned column without infinite loop', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-audit-sleep-'));
  try {
    const store = new Store(home);
    const db = (store as unknown as { sqlite: { db: DatabaseSync } }).sqlite.db;
    const now = Date.now();
    const oldTs = now - 30 * 24 * 3600_000;

    store.transaction(() => {
      const stmt = db.prepare(
        'INSERT INTO memories(id,topic,cwd,superseded_by,updated_at,access_count,last_accessed_at,last_reinforced_at,importance,pinned,body) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      );
      for (let i = 0; i < 505; i++) {
        const id = `mem-${i}`;
        // Deliberately make row 499 (page boundary) corrupt JSON, and mismatch body.updatedAt on row 500
        if (i === 499) {
          stmt.run(id, 'Corrupt boundary', null, null, oldTs + i, 0, null, null, 30, 0, '{corrupt');
        } else {
          const isStub = i === 503;
          const isPinnedCol = i === 504;
          const card = {
            id,
            topic: isStub ? 'auto-summary stub' : `Topic ${i}`,
            content: `Content ${i}`,
            tags: isStub ? ['auto-consolidated'] : ['general'],
            importance: 30,
            createdAt: oldTs,
            updatedAt: i === 500 ? oldTs - 1000 : oldTs + i,
          };
          stmt.run(id, card.topic, null, null, oldTs + i, 0, null, null, 30, isPinnedCol ? 1 : 0, JSON.stringify(card));
        }
      }
    });

    const result = store.homeostaticSleepPass(now, { force: true });
    assert.equal(result.forgottenStubs, 1, 'reaches past page 1 (500) despite corrupt boundary row');
    assert.ok(store.getMemory('mem-504').pinned === true, 'pinned column protects mem-504');
    store.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('UsageStore normalizes provider alias prefix in model specs (gemini -> google)', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-audit-usage-'));
  try {
    const store = new Store(home);
    try {
      store.recordUsage({
        actor: 'worker',
        provider: 'gemini',
        model: 'gemini/gemini-2.5-flash',
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
      const report = store.queryUsage({ granularity: 'day' });
      assert.equal(report.byModel.length, 1);
      assert.equal(report.byModel[0]!.spec, 'google/gemini-2.5-flash');
      assert.equal(report.byModel[0]!.model, 'gemini-2.5-flash');
      assert.equal(report.byModel[0]!.costSource, 'estimated');
    } finally {
      store.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('discovery.ts handles HTTP 200 null JSON payload gracefully with domain error', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    await assert.rejects(
      () => fetchRemoteModelsFromEndpoint('openai', 'sk-test', undefined, []),
      /未返回可用模型/,
    );
    await assert.rejects(
      () => fetchRemoteModelsFromEndpoint('google', 'AIzaTest123456', undefined, []),
      /generateContent/,
    );
    await assert.rejects(
      () => fetchRemoteModelsFromEndpoint('anthropic', 'sk-ant-test', undefined, []),
      /返回为空/,
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('ModelHub: cross-origin probe isolates auth.json, corrupt selectedModels do not crash init, concurrent configure serializes', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-audit-hub-'));
  let seenAuthHeader: string | undefined;
  const srv = createServer((req, res) => {
    seenAuthHeader = req.headers.authorization;
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
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
    res.end(`data: ${chunk1}\n\ndata: ${chunk2}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as { port: number }).port;

  try {
    // 1. Seed sdk/auth.json with an OpenAI API key AND sdk/model-hub.json with invalid selectedModels
    await mkdir(join(home, 'sdk'), { recursive: true });
    await writeFile(
      join(home, 'sdk', 'auth.json'),
      JSON.stringify({ openai: { type: 'api_key', key: 'sk-auth-json-secret-do-not-leak' } }),
      { mode: 0o600 },
    );
    await writeFile(
      join(home, 'sdk', 'model-hub.json'),
      JSON.stringify({
        providers: {
          openai: {
            selectedModels: [{ id: '' }, { id: 'gpt-4.1', thinkingLevels: ['invalid-level'] }],
          },
        },
      }),
    );

    const baseTiers = offlineFactory(5).modelTiers!;
    const hub = new ModelHub(home, 'offline', { ...baseTiers }, 'offline');
    await assert.doesNotReject(() => hub.init());

    // Cross-origin inlineBaseUrl probe must NOT leak auth.json credentials
    await hub.probe({
      provider: 'openai',
      model: 'gpt-4.1',
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    assert.equal(seenAuthHeader, undefined, 'cross-origin inlineBaseUrl probe must not send sdk/auth.json credential');

    // 2. Concurrent configure() calls serialize cleanly without clobbering each other's provider updates
    await Promise.all([
      hub.configure({ providerId: 'openai', customModels: ['gpt-4.1'] }),
      hub.configure({ providerId: 'deepseek', customModels: ['deepseek-chat'] }),
    ]);
    const view = await hub.getView();
    assert.ok(view.providers.find(p => p.id === 'openai')?.models.some(m => m.id === 'gpt-4.1'));
    assert.ok(view.providers.find(p => p.id === 'deepseek')?.models.some(m => m.id === 'deepseek-chat'));
    await hub.close();
  } finally {
    srv.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('SemanticEngine: aborting caller 1 does not poison subsequent ensureReady/download, and close awaits active run()', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-audit-sem-'));
  try {
    // 1. ensureReady recovery immediately after caller 1 aborts
    let sessAttempt = 0;
    const engine = createSemanticEngine({
      homeDir: home,
      modelRepo: 'org/abort-recover',
      autoDownload: false,
      tokenizerFactory: () => ({
        encode: () => ({ ids: [101, 200, 102], attention_mask: [1, 1, 1] }),
      }),
      sessionFactory: async () => {
        sessAttempt++;
        const attemptNum = sessAttempt;
        await delay(40);
        return {
          inputNames: ['input_ids', 'attention_mask'],
          outputNames: ['sentence_embedding'],
          run: async () => ({
            sentence_embedding: { type: 'float32', dims: [1, 2], data: new Float32Array([attemptNum, 0]) },
          }),
        };
      },
    });
    const repoDir = join(home, 'models', 'semantic', 'org--abort-recover');
    await mkdir(join(repoDir, 'onnx'), { recursive: true });
    await writeFile(join(repoDir, 'tokenizer.json'), '{}');
    await writeFile(join(repoDir, 'onnx', 'model_quantized.onnx'), 'onnx');

    const ac1 = new AbortController();
    const p1 = engine.ensureReady!(ac1.signal);
    await delay(10);
    ac1.abort();
    // Immediately call ensureReady again before attempt 1's async sessionFactory settles
    const p2 = engine.ensureReady!();
    assert.equal(await p1, false);
    assert.equal(await p2, true, 'fresh ensureReady must succeed instead of joining aborted attempt');
    await engine.close?.();

    // 2. close() waits for in-flight session.run() to complete before calling session.release()
    const events: string[] = [];
    let releaseWaitRun!: () => void;
    const runStarted = new Promise<void>(resolve => { releaseWaitRun = resolve; });
    const runEngine = createSemanticEngine({
      homeDir: home,
      modelRepo: 'org/close-order',
      autoDownload: false,
      tokenizerFactory: () => ({
        encode: () => ({ ids: [101, 200, 102], attention_mask: [1, 1, 1] }),
      }),
      sessionFactory: async () => ({
        inputNames: ['input_ids', 'attention_mask'],
        outputNames: ['sentence_embedding'],
        run: async () => {
          events.push('run_start');
          releaseWaitRun();
          await delay(40);
          events.push('run_end');
          return { sentence_embedding: { type: 'float32', dims: [1, 2], data: new Float32Array([1, 0]) } };
        },
        release: async () => {
          events.push('release');
        },
      }),
    });
    const closeDir = join(home, 'models', 'semantic', 'org--close-order');
    await mkdir(join(closeDir, 'onnx'), { recursive: true });
    await writeFile(join(closeDir, 'tokenizer.json'), '{}');
    await writeFile(join(closeDir, 'onnx', 'model_quantized.onnx'), 'onnx');

    assert.equal(await runEngine.ensureReady!(), true);
    const embedPromise = runEngine.embed('hello');
    await runStarted;
    await runEngine.close!();
    await embedPromise;
    assert.deepEqual(events, ['run_start', 'run_end', 'release']);

    // 3. downloadFileWithMirrors recovery immediately after waiter 1 aborts
    let dlAttempt = 0;
    const dlFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      dlAttempt++;
      const idx = dlAttempt;
      await delay(idx === 1 ? 50 : 10);
      if (init?.signal?.aborted) throw new Error('aborted');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const dlE1 = createSemanticEngine({
      homeDir: home,
      modelsDir: join(home, 'dl-recover'),
      modelRepo: 'org/dl-abort-recover',
      autoDownload: true,
      fetchImpl: dlFetch,
      tokenizerFactory: () => ({ encode: () => ({ ids: [1, 2], attention_mask: [1, 1] }) }),
      sessionFactory: async () => ({
        inputNames: ['input_ids', 'attention_mask'],
        outputNames: ['sentence_embedding'],
        run: async () => ({ sentence_embedding: { type: 'float32', dims: [1, 2], data: new Float32Array([1, 0]) } }),
      }),
    });
    const dlE2 = createSemanticEngine({
      homeDir: home,
      modelsDir: join(home, 'dl-recover'),
      modelRepo: 'org/dl-abort-recover',
      autoDownload: true,
      fetchImpl: dlFetch,
      tokenizerFactory: () => ({ encode: () => ({ ids: [1, 2], attention_mask: [1, 1] }) }),
      sessionFactory: async () => ({
        inputNames: ['input_ids', 'attention_mask'],
        outputNames: ['sentence_embedding'],
        run: async () => ({ sentence_embedding: { type: 'float32', dims: [1, 2], data: new Float32Array([1, 0]) } }),
      }),
    });
    const dlAc = new AbortController();
    const dlP1 = dlE1.ensureReady!(dlAc.signal);
    await delay(10);
    dlAc.abort();
    const dlP2 = dlE2.ensureReady!();
    assert.equal(await dlP1, false);
    assert.equal(await dlP2, true, 'new download waiter succeeds after prior download was aborted');
    await dlE1.close?.();
    await dlE2.close?.();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('parseDistillerOutput recovers valid JSON even when preceded by stray unmatched brace in prose', () => {
  const raw = 'Observed {partial snippet in logs.\n{"operations":[{"action":"save","topic":"Stray brace resilience","content":"Parser recovers valid JSON","tags":["distill"]}]}';
  const ops = parseDistillerOutput(raw);
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.topic, 'Stray brace resilience');
});

test('trace-parser: preserves same-ms synthetic router tools and excludes WORKER_QUESTION from routerReportSpanId', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-audit-tp-'));
  try {
    const store = new Store(home);
    try {
      const task = makeTask('t-question-report', { createdAt: 1000 });
      store.create(task);

      // 1. Same-ms orphan router tools (no Agent 请求 span) must all survive in synthetic:500
      const orphanEvents: TraceEvent[] = [
        {
          id: 't-1', seq: 1, at: 500, rootId: 'm1', messageId: 'm1', spanId: 'tool-1',
          type: 'trace', kind: 'span', actor: 'router', label: 'search_memory', status: 'completed',
          data: { summary: { input: 'q1' } },
        },
        {
          id: 't-2', seq: 2, at: 500, rootId: 'm1', messageId: 'm1', spanId: 'tool-2',
          type: 'trace', kind: 'span', actor: 'router', label: 'start_work', status: 'completed',
          data: { summary: { input: 'w1' } },
        },
      ];
      const orphanTurns = buildRouterTurns(orphanEvents);
      const synthetic = orphanTurns.find(t => t.spanId === 'synthetic:500');
      assert.ok(synthetic);
      assert.deepEqual(synthetic.tools.map(t => t.toolName), ['search_memory', 'start_work']);

      // 2. WORKER_QUESTION turn carrying taskId before WORKER_REPORT must not claim routerReportSpanId
      const taskTurns = buildRouterTurns([
        {
          id: 'q-1', seq: 3, at: 2000, rootId: 'm1', messageId: 'm1', taskId: task.id, spanId: 'rt-question',
          type: 'trace', kind: 'span', actor: 'router', label: 'Agent 请求', status: 'started',
          data: { trigger: { kind: 'WORKER_QUESTION', taskId: task.id } },
        },
        {
          id: 'r-1', seq: 4, at: 3000, rootId: 'm1', messageId: 'm1', taskId: task.id, spanId: 'rt-report',
          type: 'trace', kind: 'span', actor: 'router', label: 'Agent 请求', status: 'started',
          data: { trigger: { kind: 'WORKER_REPORT', taskId: task.id } },
        },
      ]);
      const detail = buildTaskDetail(store, task, [], taskTurns, new Set<string>(), new Map());
      assert.equal(detail.executionPhases[0]!.routerReportSpanId, 'rt-report');
    } finally {
      store.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

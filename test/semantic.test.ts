import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import {
  BGE_QUERY_INSTRUCTION,
  computeLexicalConceptOverlap,
  computeSemanticContentHash,
  cosineSimilarity,
  createSemanticEngine,
  DEFAULT_SEMANTIC_DIM,
  DEFAULT_SEMANTIC_MODEL_REPO,
  deserializeEmbedding,
  l2Normalize,
  normalizeTopicForDedup,
  serializeEmbedding,
  type SemanticSessionLike,
  type SemanticTokenizerLike,
} from '../src/semantic.js';

function createMinimalWordPieceTokenizerJson() {
  const vocab: Record<string, number> = {
    '[PAD]': 0,
    '[UNK]': 100,
    '[CLS]': 101,
    '[SEP]': 102,
    'hello': 200,
    'world': 201,
    '测': 202,
    '试': 203,
    '为': 204,
    '这': 205,
    '个': 206,
    '句': 207,
    '子': 208,
    '生': 209,
    '成': 210,
    '表': 211,
    '示': 212,
    '以': 213,
    '用': 214,
    '于': 215,
    '检': 216,
    '索': 217,
    '相': 218,
    '关': 219,
    '文': 220,
    '章': 221,
    '：': 222,
    ':': 223,
  };
  return {
    version: '1.0',
    truncation: null,
    padding: null,
    added_tokens: [
      { id: 0, content: '[PAD]', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
      { id: 100, content: '[UNK]', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
      { id: 101, content: '[CLS]', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
      { id: 102, content: '[SEP]', single_word: false, lstrip: false, rstrip: false, normalized: false, special: true },
    ],
    normalizer: {
      type: 'BertNormalizer',
      clean_text: true,
      handle_chinese_chars: true,
      strip_accents: null,
      lowercase: true,
    },
    pre_tokenizer: { type: 'BertPreTokenizer' },
    post_processor: {
      type: 'BertProcessing',
      sep: ['[SEP]', 102],
      cls: ['[CLS]', 101],
    },
    decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
    model: {
      type: 'WordPiece',
      unk_token: '[UNK]',
      continuing_subword_prefix: '##',
      max_input_chars_per_word: 100,
      vocab,
    },
  };
}

function createFakeTokenizer(encodedTexts: string[]): SemanticTokenizerLike {
  return {
    token_to_id(token: string) {
      if (token === '[PAD]') return 0;
      if (token === '[CLS]') return 101;
      if (token === '[SEP]') return 102;
      return undefined;
    },
    encode(text: string) {
      encodedTexts.push(text);
      const chars = Array.from(text);
      const ids = [101, ...chars.map((c, idx) => 1000 + (c.codePointAt(0) ?? idx) % 500), 102];
      const tokens = ['[CLS]', ...chars, '[SEP]'];
      const attention_mask = new Array(ids.length).fill(1);
      const token_type_ids = new Array(ids.length).fill(0);
      return { ids, tokens, attention_mask, token_type_ids };
    },
  };
}

test('Math & binary serialization roundtrips handle valid vectors and reject invalid inputs', () => {
  const norm = l2Normalize([3, 4]);
  assert.ok(norm instanceof Float32Array);
  assert.equal(norm.length, 2);
  assert.ok(Math.abs(norm[0]! - 0.6) < 1e-6);
  assert.ok(Math.abs(norm[1]! - 0.8) < 1e-6);

  assert.equal(l2Normalize([]), undefined);
  assert.equal(l2Normalize([0, 0, 0]), undefined);
  assert.equal(l2Normalize([1e-13, 0]), undefined);
  assert.equal(l2Normalize([1, Number.NaN]), undefined);
  assert.equal(l2Normalize([1, Number.POSITIVE_INFINITY]), undefined);

  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-6);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [-1, 0]) + 1) < 1e-6);
  assert.ok(Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-6);
  assert.equal(cosineSimilarity(undefined, [1, 0]), 0);
  assert.equal(cosineSimilarity([1, 0], undefined), 0);
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  assert.equal(cosineSimilarity([Number.NaN, 1], [1, 1]), 0);

  // Verify little-endian float32 format + non-zero byteOffset view handling
  const sample = new Float32Array([1.5, -0.25, 0.75, 0]);
  const bytes = serializeEmbedding(sample);
  assert.equal(bytes.byteLength, 16);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x00, 0x00, 0xc0, 0x3f]);

  const offsetView = Buffer.concat([Buffer.from([0xaa, 0xbb]), Buffer.from(bytes)]).subarray(2);
  const restored = deserializeEmbedding(offsetView, 4);
  assert.ok(restored instanceof Float32Array);
  assert.deepEqual([...restored], [...sample]);

  // Validation failures
  assert.equal(deserializeEmbedding(new Uint8Array(0)), undefined);
  assert.equal(deserializeEmbedding(new Uint8Array(5)), undefined);
  assert.equal(deserializeEmbedding(bytes, 3), undefined);
  const nanBytes = new Uint8Array(bytes);
  nanBytes[3] = 0x7f;
  nanBytes[2] = 0xc0; // NaN in LE float32
  assert.equal(deserializeEmbedding(nanBytes, 4), undefined);
});

test('Text helpers normalize topics, hash normalized content, and compute lexical concept overlap', () => {
  assert.equal(
    computeSemanticContentHash('  Hello\n  World  '),
    computeSemanticContentHash('Hello World'),
  );
  assert.equal(
    computeSemanticContentHash('ＡＰＩ 接口'),
    computeSemanticContentHash('API 接口'),
  );
  assert.notEqual(
    computeSemanticContentHash('Alpha'),
    computeSemanticContentHash('Beta'),
  );

  assert.equal(
    normalizeTopicForDedup('鉴权 · 架构：V2'),
    normalizeTopicForDedup('鉴权-架构 / v2'),
  );
  assert.equal(normalizeTopicForDedup('Router / Memory - Diet!'), 'router memory diet');

  const sameTopic = computeLexicalConceptOverlap(
    'Router 上下文压缩与 token 优化策略：保留最近 20 条消息，历史 toolResult 截断到 480 字符',
    'Router 上下文压缩和 token 优化策略：保留最近 20 条消息，历史 toolResult 限制为 480 字符',
  );
  assert.ok(sameTopic.sharedTerms >= 4, `expected >= 4 shared terms, got ${sameTopic.sharedTerms}`);
  assert.ok(sameTopic.jaccard >= 0.68, `expected jaccard >= 0.68, got ${sameTopic.jaccard}`);

  const stopwordOnly = computeLexicalConceptOverlap('the and is for our', 'the and is for your');
  assert.deepEqual(stopwordOnly, { jaccard: 0, sharedTerms: 0 });

  const disjoint = computeLexicalConceptOverlap('Redis cache TTL configuration', '小爱音箱红外电视控制');
  assert.deepEqual(disjoint, { jaccard: 0, sharedTerms: 0 });
});

test('BGE query prefix, truncation <= 512 preserving [SEP], token_type_ids gating, and pooling modes', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-sem-bge-'));
  try {
    const encodedTexts: string[] = [];
    const seenFeedKeys: string[][] = [];
    const seenInputLengths: number[] = [];

    // 1) BGE model with token_type_ids + 3D last_hidden_state ([CLS] pooling)
    const bgeEngine = createSemanticEngine({
      homeDir: home,
      autoDownload: false,
      tokenizerFactory: () => createFakeTokenizer(encodedTexts),
      sessionFactory: () => ({
        inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
        outputNames: ['last_hidden_state'],
        async run(feeds) {
          seenFeedKeys.push(Object.keys(feeds).sort());
          const idsTensor = feeds.input_ids as { data: BigInt64Array; dims: number[] };
          const batchSize = idsTensor.dims[0]!;
          const seqLen = idsTensor.dims[1]!;
          seenInputLengths.push(seqLen);
          // Verify last token is [SEP] = 102n even when truncated at 512
          assert.equal(idsTensor.data[0], 101n);
          assert.equal(idsTensor.data[seqLen - 1], 102n);

          const hiddenDim = 4;
          const out = new Float32Array(batchSize * seqLen * hiddenDim);
          // Token 0 ([CLS]) = [3, 4, 0, 0] -> normalized [0.6, 0.8, 0, 0]
          // Token 1 = [0, 0, 10, 0] (should be ignored by CLS pooling)
          for (let b = 0; b < batchSize; b++) {
            out[b * seqLen * hiddenDim + 0] = 3;
            out[b * seqLen * hiddenDim + 1] = 4;
            if (seqLen > 1) {
              out[(b * seqLen + 1) * hiddenDim + 2] = 10;
            }
          }
          return {
            last_hidden_state: { dims: [batchSize, seqLen, hiddenDim], type: 'float32', data: out },
          };
        },
      }),
    });

    assert.equal(bgeEngine.modelId, DEFAULT_SEMANTIC_MODEL_REPO);
    assert.equal(bgeEngine.dim, DEFAULT_SEMANTIC_DIM);
    assert.equal(bgeEngine.isReady(), false);
    assert.equal(await bgeEngine.ensureReady?.(), true);
    assert.equal(bgeEngine.isReady(), true);

    // Empty / whitespace returns undefined
    assert.equal(await bgeEngine.embed('   \n\t  '), undefined);

    const qVec = await bgeEngine.embed('如何配置网关', 'query');
    assert.ok(qVec);
    assert.equal(encodedTexts[0], `${BGE_QUERY_INSTRUCTION}如何配置网关`);
    assert.ok(Math.abs(qVec[0]! - 0.6) < 1e-6);
    assert.ok(Math.abs(qVec[1]! - 0.8) < 1e-6);
    assert.deepEqual(seenFeedKeys[0], ['attention_mask', 'input_ids', 'token_type_ids']);

    const dVec = await bgeEngine.embed('如何配置网关', 'document');
    assert.ok(dVec);
    assert.equal(encodedTexts[1], '如何配置网关');

    // Long text (> 512 tokens) is truncated to 512 preserving [SEP]
    const longVec = await bgeEngine.embed('a'.repeat(700), 'document');
    assert.ok(longVec);
    assert.equal(seenInputLengths[2], 512);

    await bgeEngine.close?.();
    assert.equal(bgeEngine.isReady(), false);
    assert.equal(await bgeEngine.embed('after close'), undefined);

    // 2) Non-BGE model without token_type_ids -> no BGE prefix, attention-masked mean pooling
    const nonBgeTexts: string[] = [];
    const nonBgeFeeds: string[][] = [];
    const nonBgeEngine = createSemanticEngine({
      homeDir: home,
      modelRepo: 'Xenova/all-MiniLM-L6-v2',
      autoDownload: false,
      tokenizerFactory: () => ({
        encode(text: string) {
          nonBgeTexts.push(text);
          // 2 real tokens + 1 masked padding token
          return {
            ids: [101, 200, 0],
            attention_mask: [1, 1, 0],
          };
        },
      }),
      sessionFactory: () => ({
        inputNames: ['input_ids', 'attention_mask'],
        outputNames: ['last_hidden_state'],
        async run(feeds) {
          nonBgeFeeds.push(Object.keys(feeds).sort());
          // Token 0 = [2, 0], Token 1 = [0, 2], Token 2 (masked out!) = [100, 100]
          return {
            last_hidden_state: {
              dims: [1, 3, 2],
              type: 'float32',
              data: new Float32Array([2, 0, 0, 2, 100, 100]),
            },
          };
        },
      }),
    });

    assert.equal(nonBgeEngine.dim, 384);
    assert.equal(await nonBgeEngine.ensureReady?.(), true);
    const minilmVec = await nonBgeEngine.embed('search query', 'query');
    assert.ok(minilmVec);
    assert.equal(nonBgeTexts[0], 'search query');
    assert.deepEqual(nonBgeFeeds[0], ['attention_mask', 'input_ids']);
    // Mean of [2, 0] and [0, 2] is [1, 1] -> normalized [sqrt(0.5), sqrt(0.5)]
    assert.ok(Math.abs(minilmVec[0]! - Math.SQRT1_2) < 1e-6);
    assert.ok(Math.abs(minilmVec[1]! - Math.SQRT1_2) < 1e-6);
    await nonBgeEngine.close?.();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('LRU cache, sentence_embedding pooling, and embedBatch deduplication/mini-batching', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-sem-lru-'));
  try {
    let runCalls = 0;
    const ranTexts: string[] = [];

    const engine = createSemanticEngine({
      homeDir: home,
      autoDownload: false,
      maxCacheEntries: 2,
      tokenizerFactory: () => ({
        encode(text: string) {
          // Encode first non-prefix char code into id[1] so we can distinguish texts deterministically
          const clean = text.replace(BGE_QUERY_INSTRUCTION, '');
          const code = clean.charCodeAt(0) || 1;
          return { ids: [101, code, 102], attention_mask: [1, 1, 1] };
        },
      }),
      sessionFactory: () => ({
        inputNames: ['input_ids', 'attention_mask'],
        outputNames: ['sentence_embedding'],
        async run(feeds) {
          runCalls++;
          const ids = feeds.input_ids as { data: BigInt64Array; dims: number[] };
          const batchSize = ids.dims[0]!;
          const seqLen = ids.dims[1]!;
          const out = new Float32Array(batchSize * 2);
          for (let b = 0; b < batchSize; b++) {
            const code = Number(ids.data[b * seqLen + 1]!);
            ranTexts.push(String.fromCharCode(code));
            out[b * 2] = code;
            out[b * 2 + 1] = 1;
          }
          return {
            sentence_embedding: { dims: [batchSize, 2], type: 'float32', data: out },
          };
        },
      }),
    });

    assert.equal(await engine.ensureReady?.(), true);

    const a1 = await engine.embed('alpha', 'document');
    const a2 = await engine.embed('  alpha ', 'document'); // cache hit
    assert.ok(a1 && a2);
    assert.deepEqual([...a1], [...a2]);
    assert.equal(runCalls, 1);

    // Same text as query misses document cache because purpose differs
    const aq = await engine.embed('alpha', 'query');
    assert.ok(aq);
    assert.equal(runCalls, 2);

    // Cache holds [doc:alpha, query:alpha]. Touch doc:alpha so query:alpha becomes LRU.
    await engine.embed('alpha', 'document');
    assert.equal(runCalls, 2);

    // Insert doc:beta -> evicts query:alpha, keeps doc:alpha
    await engine.embed('beta', 'document');
    assert.equal(runCalls, 3);

    await engine.embed('alpha', 'document'); // still cached
    assert.equal(runCalls, 3);

    // embedBatch handles empty, cached, and duplicate entries cleanly
    const batch = await engine.embedBatch?.(['alpha', '   ', 'gamma', 'gamma'], 'document');
    assert.ok(batch);
    assert.equal(batch.length, 4);
    assert.deepEqual([...batch[0]!], [...a1]);
    assert.equal(batch[1], undefined);
    assert.ok(batch[2] && batch[3]);
    assert.deepEqual([...batch[2]!], [...batch[3]!]);
    assert.equal(runCalls, 4);

    await engine.close?.();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Concurrent ensureReady() coalesces calls, supports mirror fallback, atomic writes, and retry after failure', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-sem-download-'));
  try {
    const requestedUrls: string[] = [];
    let attemptPhase: 'fail' | 'mirror_fallback' = 'fail';

    const tokenizerPayload = JSON.stringify(createMinimalWordPieceTokenizerJson());
    const fakeOnnxBytes = new Uint8Array([0x08, 0x09, 0x10, 0x11]);

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      await new Promise(resolve => setTimeout(resolve, 15));

      if (attemptPhase === 'fail') {
        return new Response('mirror down', { status: 503 });
      }

      // modelscope and hf-mirror fail with 502; huggingface.co succeeds
      if (url.startsWith('https://modelscope.cn/') || url.startsWith('https://hf-mirror.com/')) {
        return new Response('bad gateway', { status: 502 });
      }
      if (url === 'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json') {
        return new Response(tokenizerPayload, { status: 200 });
      }
      if (url === 'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx') {
        return new Response(fakeOnnxBytes, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    let sessionFactoryCalls = 0;
    const engine = createSemanticEngine({
      homeDir: home,
      autoDownload: true,
      fetchImpl: mockFetch,
      sessionFactory: ({ modelPath }) => {
        sessionFactoryCalls++;
        assert.equal(existsSync(modelPath), true);
        return {
          inputNames: ['input_ids', 'attention_mask'],
          outputNames: ['sentence_embedding'],
          async run() {
            return {
              sentence_embedding: { dims: [1, 2], type: 'float32', data: new Float32Array([1, 0]) },
            };
          },
        };
      },
    });

    // Phase 1: concurrent calls coalesce and resolve false gracefully on transient failure
    const [r1, r2, r3] = await Promise.all([
      engine.ensureReady!(),
      engine.ensureReady!(),
      engine.ensureReady!(),
    ]);
    assert.deepEqual([r1, r2, r3], [false, false, false]);
    assert.equal(engine.isReady(), false);
    assert.equal(await engine.embed('hello'), undefined);
    // Coalesced: only tried modelscope + hf-mirror + huggingface.co once for tokenizer.json
    assert.deepEqual(requestedUrls, [
      'https://modelscope.cn/api/v1/models/Xenova/bge-small-zh-v1.5/repo?Revision=master&FilePath=tokenizer.json',
      'https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json',
      'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json',
    ]);

    const modelDir = join(home, 'models', 'semantic', 'Xenova--bge-small-zh-v1.5');
    if (existsSync(modelDir)) {
      assert.equal(readdirSync(modelDir).some(f => f.includes('.tmp')), false);
    }

    // Phase 2: retry after transient failure succeeds via mirror fallback + real defaultTokenizerFactory
    requestedUrls.length = 0;
    attemptPhase = 'mirror_fallback';
    const [ok1, ok2] = await Promise.all([engine.ensureReady!(), engine.ensureReady!()]);
    assert.deepEqual([ok1, ok2], [true, true]);
    assert.equal(engine.isReady(), true);
    assert.equal(sessionFactoryCalls, 1);
    assert.deepEqual(requestedUrls, [
      'https://modelscope.cn/api/v1/models/Xenova/bge-small-zh-v1.5/repo?Revision=master&FilePath=tokenizer.json',
      'https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json',
      'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json',
      'https://modelscope.cn/api/v1/models/Xenova/bge-small-zh-v1.5/repo?Revision=master&FilePath=onnx%2Fmodel_quantized.onnx',
      'https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx',
      'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx',
    ]);
    assert.equal(existsSync(join(modelDir, 'tokenizer.json')), true);
    assert.equal(existsSync(join(modelDir, 'onnx', 'model_quantized.onnx')), true);
    assert.equal(readdirSync(modelDir).some(f => f.includes('.tmp')), false);
    assert.equal(readdirSync(join(modelDir, 'onnx')).some(f => f.includes('.tmp')), false);

    // Real @huggingface/tokenizers parsed the downloaded tokenizer.json cleanly!
    const vec = await engine.embed('hello 测试', 'query');
    assert.ok(vec);
    assert.equal(vec.length, 2);

    // Phase 3: fresh engine reuses cached files on disk with zero fetch calls
    const cachedEngine = createSemanticEngine({
      homeDir: home,
      autoDownload: false,
      fetchImpl: () => {
        throw new Error('should not hit network when model files exist on disk');
      },
      sessionFactory: () => ({
        inputNames: ['input_ids', 'attention_mask'],
        outputNames: ['sentence_embedding'],
        async run() {
          return { sentence_embedding: { dims: [1, 2], type: 'float32', data: new Float32Array([0, 1]) } };
        },
      }),
    });
    assert.equal(await cachedEngine.ensureReady!(), true);
    assert.ok(await cachedEngine.embed('hello'));

    await engine.close?.();
    await cachedEngine.close?.();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Graceful degradation for disable switches, autoDownload=false, AbortSignal, and inference errors', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-sem-degrade-'));
  const prevDisabled = process.env.FRIDAY_SEMANTIC_DISABLED;
  const prevSemantic = process.env.FRIDAY_SEMANTIC;
  const prevAuto = process.env.FRIDAY_SEMANTIC_AUTO_DOWNLOAD;
  const prevModel = process.env.FRIDAY_SEMANTIC_MODEL;

  try {
    // 1) Explicit disabled option
    const optDisabled = createSemanticEngine({ homeDir: home, disabled: true });
    assert.equal(optDisabled.isReady(), false);
    assert.equal(await optDisabled.ensureReady?.(), false);
    assert.equal(await optDisabled.embed('test'), undefined);
    assert.deepEqual(await optDisabled.embedBatch?.(['a', 'b']), [undefined, undefined]);

    // 2) Env FRIDAY_SEMANTIC_DISABLED=1 and FRIDAY_SEMANTIC=0/false/off
    process.env.FRIDAY_SEMANTIC_DISABLED = '1';
    const envDisabled1 = createSemanticEngine({ homeDir: home });
    assert.equal(await envDisabled1.ensureReady?.(), false);
    assert.equal(await envDisabled1.embed('test'), undefined);
    delete process.env.FRIDAY_SEMANTIC_DISABLED;

    for (const val of ['0', 'false', 'off']) {
      process.env.FRIDAY_SEMANTIC = val;
      const envDisabled2 = createSemanticEngine({ homeDir: home });
      assert.equal(await envDisabled2.ensureReady?.(), false);
      assert.equal(await envDisabled2.embed('test'), undefined);
    }
    delete process.env.FRIDAY_SEMANTIC;

    // 3) FRIDAY_SEMANTIC_MODEL override + autoDownload=false skips network
    process.env.FRIDAY_SEMANTIC_MODEL = 'custom/bge-test';
    process.env.FRIDAY_SEMANTIC_AUTO_DOWNLOAD = '0';
    let fetched = false;
    const noDownloadEngine = createSemanticEngine({
      homeDir: home,
      fetchImpl: () => {
        fetched = true;
        throw new Error('network call forbidden');
      },
    });
    assert.equal(noDownloadEngine.modelId, 'custom/bge-test');
    assert.equal(await noDownloadEngine.ensureReady?.(), false);
    assert.equal(fetched, false);
    delete process.env.FRIDAY_SEMANTIC_MODEL;
    delete process.env.FRIDAY_SEMANTIC_AUTO_DOWNLOAD;

    // 4) AbortSignal cancels ensureReady cleanly
    const abortController = new AbortController();
    const slowEngine = createSemanticEngine({
      homeDir: home,
      autoDownload: true,
      fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    });
    const pendingAbort = slowEngine.ensureReady!(abortController.signal);
    abortController.abort();
    assert.equal(await pendingAbort, false);
    assert.equal(slowEngine.isReady(), false);

    // 5) Inference throwing inside session.run degrades to undefined cleanly
    const flakySession: SemanticSessionLike = {
      inputNames: ['input_ids', 'attention_mask'],
      outputNames: ['sentence_embedding'],
      async run() {
        throw new Error('simulated ONNX runtime error');
      },
    };
    const flakyEngine = createSemanticEngine({
      homeDir: home,
      autoDownload: false,
      tokenizerFactory: () => createFakeTokenizer([]),
      sessionFactory: () => flakySession,
    });
    assert.equal(await flakyEngine.ensureReady?.(), true);
    assert.equal(await flakyEngine.embed('boom'), undefined);
    await flakyEngine.close?.();
  } finally {
    if (prevDisabled === undefined) delete process.env.FRIDAY_SEMANTIC_DISABLED;
    else process.env.FRIDAY_SEMANTIC_DISABLED = prevDisabled;
    if (prevSemantic === undefined) delete process.env.FRIDAY_SEMANTIC;
    else process.env.FRIDAY_SEMANTIC = prevSemantic;
    if (prevAuto === undefined) delete process.env.FRIDAY_SEMANTIC_AUTO_DOWNLOAD;
    else process.env.FRIDAY_SEMANTIC_AUTO_DOWNLOAD = prevAuto;
    if (prevModel === undefined) delete process.env.FRIDAY_SEMANTIC_MODEL;
    else process.env.FRIDAY_SEMANTIC_MODEL = prevModel;
    await rm(home, { recursive: true, force: true });
  }
});

test('Offline @huggingface/tokenizers + onnxruntime-node module and native addon smoke check', async () => {
  // 1) @huggingface/tokenizers smoke check
  const tokJson = createMinimalWordPieceTokenizerJson();
  const tokenizer = new Tokenizer(tokJson, {});
  const enc = tokenizer.encode('hello 测试', { return_token_type_ids: true });
  assert.equal(enc.ids[0], 101);
  assert.equal(enc.ids.at(-1), 102);
  assert.ok(enc.ids.includes(200)); // 'hello'
  assert.ok(enc.ids.includes(202)); // '测'
  assert.ok(enc.ids.includes(203)); // '试'
  assert.equal(enc.attention_mask.length, enc.ids.length);
  assert.equal(enc.token_type_ids?.length, enc.ids.length);

  // Also test real tokenizer written to disk via defaultTokenizerFactory
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-sem-smoke-'));
  try {
    const modelDir = join(home, 'models', 'semantic', 'Xenova--bge-small-zh-v1.5');
    await mkdir(join(modelDir, 'onnx'), { recursive: true });
    await writeFile(join(modelDir, 'tokenizer.json'), JSON.stringify(tokJson));
    await writeFile(join(modelDir, 'onnx', 'model_quantized.onnx'), Buffer.from('placeholder'));

    const engine = createSemanticEngine({
      homeDir: home,
      autoDownload: false,
      sessionFactory: () => ({
        inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
        outputNames: ['sentence_embedding'],
        async run(feeds) {
          const ids = feeds.input_ids as { data: BigInt64Array; dims: number[] };
          assert.equal(ids.data[0], 101n);
          return {
            sentence_embedding: { dims: [1, 2], type: 'float32', data: new Float32Array([3, 4]) },
          };
        },
      }),
    });
    assert.equal(await engine.ensureReady?.(), true);
    const vec = await engine.embed('hello 测试');
    assert.ok(vec);
    assert.ok(Math.abs(vec[0]! - 0.6) < 1e-6);
    await engine.close?.();
  } finally {
    await rm(home, { recursive: true, force: true });
  }

  // 2) onnxruntime-node smoke check (module API + native N-API addon load on Node v26)
  const ort = await import('onnxruntime-node');
  assert.equal(typeof ort.InferenceSession?.create, 'function');
  assert.equal(typeof ort.Tensor, 'function');

  const tensor = new ort.Tensor('int64', new BigInt64Array([101n, 200n, 102n]), [1, 3]);
  assert.deepEqual([...tensor.dims], [1, 3]);
  assert.equal(tensor.type, 'int64');

  // Verify native binding dlopen succeeds (invalid dummy bytes must fail at ONNX protobuf parse, not N-API dlopen)
  await assert.rejects(
    () => ort.InferenceSession.create(new Uint8Array([0, 1, 2, 3])),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /protobuf/i);
      return true;
    },
  );
});

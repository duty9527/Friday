import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { l2Normalize, type EmbeddingPurpose, type SemanticEmbedder } from '../src/semantic.js';
import {
  SPEAKER_SAMPLE_RATE,
  XiaoaiSpeakerManager,
  type XiaoaiSpeakerExtractor,
} from '../src/xiaoai/speaker-verify.js';
import { XiaoaiKwsMonitor } from '../src/xiaoai/kws-monitor.js';

function synthTone(freqHz: number, durationMs: number, amplitude = 0.25, sampleRate = SPEAKER_SAMPLE_RATE): Float32Array {
  const total = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const out = new Float32Array(total);
  if (freqHz <= 0 || amplitude <= 0) return out;
  for (let i = 0; i < total; i++) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amplitude;
  }
  return out;
}

function concatFloat32(...chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function encodeS16Le(samples: Float32Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buf.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return buf;
}

function createBandExtractor(onExtract?: () => void): () => XiaoaiSpeakerExtractor {
  return () => ({
    dim: 4,
    extract(samples: Float32Array, sampleRate: number): Float32Array | undefined {
      onExtract?.();
      if (samples.length < Math.round(sampleRate * 0.25)) return undefined;
      const win = Math.max(1, Math.round(sampleRate * 0.02));
      const weights = new Float32Array(4);
      for (let start = 0; start < samples.length; start += win) {
        const end = Math.min(samples.length, start + win);
        let energy = 0;
        let crossings = 0;
        let prev = samples[start] ?? 0;
        for (let i = start; i < end; i++) {
          const v = samples[i] ?? 0;
          energy += v * v;
          if ((v >= 0 && prev < 0) || (v < 0 && prev >= 0)) crossings++;
          prev = v;
        }
        const rms = Math.sqrt(energy / Math.max(1, end - start));
        if (rms < 0.008) continue;
        const zcr = crossings / Math.max(1, end - start);
        if (zcr < 0.06) weights[0] = (weights[0] ?? 0) + rms;
        else if (zcr < 0.22) weights[1] = (weights[1] ?? 0) + rms;
        else weights[2] = (weights[2] ?? 0) + rms;
      }
      const norm = l2Normalize(weights);
      if (norm) return norm;
      return new Float32Array([0, 0, 0, 1]);
    },
    free() {},
  });
}

test('MemoryStore breaks 300-card cap via lexical SQL fallback, escapes LIKE wildcards, and resolves >300 1-hop synapses', async (t) => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-mem-300-lex-'));
  let virtualNow = 1_700_000_000_000;
  const nowMock = t.mock.method(Date, 'now', () => {
    virtualNow += 1_000;
    return virtualNow;
  });

  const store = new Store(home);
  try {
    // 1. Oldest target card (#1, unpinned, earliest timestamp -> guaranteed to fall outside top 300)
    const oldestLexCard = store.saveMemory({
      topic: '玄武网关限流历史档案',
      content: '核心网关限流规则采用双桶令牌控制，特殊策略标识 legacy_quota_100% 且路径前缀为 rule\\v1。',
      tags: ['gateway', 'archive'],
      cwd: '/workspace/gateway',
    });

    // Decoy old card to prove `%` and `_` are escaped instead of acting as SQL LIKE wildcards
    const wildcardDecoy = store.saveMemory({
      topic: '通配符干扰卡片',
      content: '干扰标识 legacyXquotaX1000 不应被精确下划线与百分号检索误命中。',
      tags: ['decoy'],
      cwd: '/workspace/gateway',
    });

    // Oldest synaptic target card (#3, unpinned, contains zero query keywords, outside top 300)
    const oldestSynapseTarget = store.saveMemory({
      topic: '远古冷备机房断电应急手册',
      content: '当备用柴发启动后需手动切换双路 ATS 配电柜并核验冷却水压。',
      tags: ['ops'],
      cwd: '/workspace/gateway',
    });

    // 2. Insert 355 newer independent memories so oldest cards drop past rank 355 (> 300)
    store.transaction(() => {
      for (let i = 1; i <= 355; i++) {
        store.saveMemory({
          topic: `rec${i}t_${i * 17}_${i * 31}`,
          content: `entry_${i} alpha_${i * 13} beta_${i * 29} gamma_${i * 43} delta_${i * 59}`,
          tags: [`b${i}`],
          cwd: '/workspace/gateway',
        });
      }
    });

    // 3. Insert a recent seed card inside top 300 and wire an explicit synapse to oldestSynapseTarget (>300)
    const recentSeed = store.saveMemory({
      topic: '朱雀核心主站容灾演练入口',
      content: '触发主站容灾演练脚本演练指令 zhuque-drill-alpha。',
      tags: ['drill'],
      cwd: '/workspace/gateway',
    });
    store.linkMemories(recentSeed.id, oldestSynapseTarget.id, 'explicit');

    nowMock.mock.restore();

    assert.ok(store.memoryDirectory().totalActive >= 355, 'must persist 355+ active memories without dedup collapse');
    const top300Ids = new Set(store.listMemories({ limit: 300 }).map(c => c.id));
    assert.equal(top300Ids.size, 300);
    assert.equal(top300Ids.has(oldestLexCard.id), false, 'oldest target card must fall outside base LIMIT 300');
    assert.equal(top300Ids.has(oldestSynapseTarget.id), false, 'oldest synapse target must fall outside base LIMIT 300');
    assert.equal(top300Ids.has(recentSeed.id), true);

    // Pure keyword recall in searchContext (without semantic engine)
    const searchRes = store.searchContext({
      query: '玄武网关 双桶令牌',
      scope: 'memories',
      cwd: '/workspace/gateway',
      limit: 10,
    });
    assert.ok(
      searchRes.hits.some(h => h.memoryId === oldestLexCard.id),
      'searchContext must recall card #1 beyond rank 300 via lexical SQL fallback',
    );

    // Escaped LIKE wildcard recall (`_`, `%`, `\`)
    const wildcardSearch = store.searchContext({
      query: 'legacy_quota_100%',
      scope: 'memories',
      cwd: '/workspace/gateway',
      limit: 10,
    });
    assert.ok(wildcardSearch.hits.some(h => h.memoryId === oldestLexCard.id));
    assert.equal(
      wildcardSearch.hits.some(h => h.memoryId === wildcardDecoy.id),
      false,
      'escaped LIKE query must not treat _ or % as wildcards',
    );

    const backslashSearch = store.searchContext({
      query: 'rule\\v1',
      scope: 'memories',
      cwd: '/workspace/gateway',
      limit: 10,
    });
    assert.ok(
      backslashSearch.hits.some(h => h.memoryId === oldestLexCard.id),
      'escaped LIKE query must also recall literal backslashes beyond rank 300',
    );

    // Pure keyword recall in memoriesForContext (without semantic engine)
    const ctxCards = store.memoriesForContext({
      queryText: '玄武网关 双桶令牌限流',
      cwd: '/workspace/gateway',
      limit: 6,
    });
    assert.ok(
      ctxCards.some(c => c.id === oldestLexCard.id),
      'memoriesForContext must recall card #1 beyond rank 300 via lexical SQL fallback',
    );

    // 1-hop synaptic spreading activation across the 300-card boundary
    const spreadRes = store.searchContext({
      query: '朱雀核心主站容灾演练入口 zhuque-drill-alpha',
      scope: 'memories',
      cwd: '/workspace/gateway',
      limit: 10,
    });
    const seedHit = spreadRes.hits.find(h => h.memoryId === recentSeed.id);
    const spreadHit = spreadRes.hits.find(h => h.memoryId === oldestSynapseTarget.id);
    assert.ok(seedHit, 'recent seed card should match directly');
    assert.ok(spreadHit, '1-hop synaptic target beyond rank 300 must be activated via getMemory fallback');
    assert.equal(spreadHit.activatedVia?.memoryId, recentSeed.id);
  } finally {
    nowMock.mock.restore();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('MemoryStore breaks 300-card cap via full embeddingCache cosine pre-ranking across restarts', async (t) => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-mem-300-vec-'));
  let virtualNow = 1_710_000_000_000;
  const nowMock = t.mock.method(Date, 'now', () => {
    virtualNow += 1_000;
    return virtualNow;
  });

  const dim = 32;
  const makeTargetVec = (a: number, b: number): Float32Array => {
    const raw = new Float32Array(dim);
    raw[0] = a;
    raw[1] = b;
    return l2Normalize(raw)!;
  };
  const fillerPairs: Array<[number, number]> = [];
  for (let a = 2; a < dim; a++) {
    for (let b = a + 1; b < dim; b++) {
      fillerPairs.push([a, b]);
    }
  }
  const makeFillerVec = (idx: number): Float32Array => {
    const raw = new Float32Array(dim);
    const [a, b] = fillerPairs[idx % fillerPairs.length]!;
    raw[a] = 1;
    raw[b] = idx >= fillerPairs.length ? -1 : 1;
    return l2Normalize(raw)!;
  };

  const targetVec = makeTargetVec(0.98, 0.18);
  const queryVec = makeTargetVec(0.96, 0.24);

  const mockSemantic: SemanticEmbedder = {
    modelId: 'mock-vec-300',
    dim,
    isReady: () => true,
    async ensureReady() { return true; },
    async embed(text: string, _purpose?: EmbeddingPurpose) {
      if (text.includes('distributed-raft-consensus')) return queryVec;
      return makeFillerVec(9999);
    },
  };

  let store = new Store(home);
  let oldestVecCardId = '';
  try {
    store.attachSemanticEngine(mockSemantic);

    // Card #1: zero lexical overlap with the English query 'distributed-raft-consensus'
    const oldestVecCard = store.saveMemory({
      topic: '多副本状态机选主纪要',
      content: '节点间通过任期编号与日志复制多数派确认保障强一致性。',
      tags: ['storage'],
      cwd: '/workspace/raft',
      embedding: targetVec,
      embeddingModelId: mockSemantic.modelId,
    });
    oldestVecCardId = oldestVecCard.id;

    store.transaction(() => {
      for (let i = 1; i <= 360; i++) {
        store.saveMemory({
          topic: `vecfill_${i}_${i * 19}`,
          content: `item_${i} node_${i * 23} slot_${i * 37} rev_${i * 53}`,
          tags: [`v${i}`],
          cwd: '/workspace/raft',
          embedding: makeFillerVec(i),
          embeddingModelId: mockSemantic.modelId,
        });
      }
    });

    nowMock.mock.restore();

    assert.ok(store.memoryDirectory().totalActive >= 350, 'must persist 350+ active vector memories');
    const top300Ids = new Set(store.listMemories({ limit: 300 }).map(c => c.id));
    assert.equal(top300Ids.has(oldestVecCardId), false, 'oldest vector card must be outside top 300');

    // Recall in current session via searchContext & memoriesForContext (zero lexical match!)
    const syncSearch = store.searchContext({
      query: 'distributed-raft-consensus',
      scope: 'memories',
      cwd: '/workspace/raft',
      queryEmbedding: queryVec,
      limit: 8,
    });
    assert.ok(
      syncSearch.hits.some(h => h.memoryId === oldestVecCardId),
      'searchContext must recall card #1 via full embeddingCache scan even with zero lexical overlap',
    );

    const syncCtx = store.memoriesForContext({
      queryText: 'distributed-raft-consensus',
      queryEmbedding: queryVec,
      cwd: '/workspace/raft',
      limit: 6,
    });
    assert.ok(
      syncCtx.some(c => c.id === oldestVecCardId),
      'memoriesForContext must recall card #1 via full embeddingCache scan',
    );

    // Reopen Store to verify hydrateEmbeddingCache loads all 356 embeddings and recalls card #1
    store.close();
    store = new Store(home);
    store.attachSemanticEngine(mockSemantic);

    const asyncSearch = await store.searchContextAsync({
      query: 'distributed-raft-consensus',
      scope: 'memories',
      cwd: '/workspace/raft',
      limit: 8,
    });
    assert.ok(asyncSearch.hits.some(h => h.memoryId === oldestVecCardId));

    const asyncCtx = await store.memoriesForContextAsync({
      queryText: 'distributed-raft-consensus',
      cwd: '/workspace/raft',
      limit: 6,
    });
    assert.ok(asyncCtx.some(c => c.id === oldestVecCardId));
  } finally {
    nowMock.mock.restore();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoaiSpeakerManager.verifyAndTrimUtteranceAsync yields event loop between window extractions and matches sync result', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-spk-async-'));
  try {
    let eventLoopTicks = 0;
    let extractTicks: number[] = [];
    const manager = new XiaoaiSpeakerManager({
      homeDir: home,
      extractorFactory: createBandExtractor(() => {
        extractTicks.push(eventLoopTicks);
      }),
    });

    const ownerEmb = manager.extractEmbedding(synthTone(200, 1200))!;
    manager.enrollEmbeddings({ name: '主人', role: 'owner', embeddings: [ownerEmb] });

    // > 3s utterance: 1.4s owner speech (200Hz) + 2.8s TV background speech (3200Hz) = 4.2s total
    const longMixedAudio = concatFloat32(synthTone(200, 1400), synthTone(3200, 2800));
    const longPureOwner = synthTone(200, 3400);
    const longPureTv = synthTone(3200, 3400);
    const shortOwner = synthTone(200, 1500);

    // 1. Sync baseline on 4.2s mixed clip: zero event loop yields between extractions
    eventLoopTicks = 0;
    extractTicks = [];
    const syncMixed = manager.verifyAndTrimUtterance(longMixedAudio, SPEAKER_SAMPLE_RATE);
    const syncExtractCount = extractTicks.length;
    assert.ok(syncExtractCount >= 6, `expected multi-window extractions on 4.2s clip, got ${syncExtractCount}`);
    assert.ok(extractTicks.every(tick => tick === 0), 'sync path runs all extractions in a single event loop turn');

    // 2. Async on the exact same 4.2s mixed clip with active setImmediate ticker
    eventLoopTicks = 0;
    extractTicks = [];
    let tickerActive = true;
    const pumpImmediate = () => {
      if (!tickerActive) return;
      setImmediate(() => {
        if (!tickerActive) return;
        eventLoopTicks++;
        pumpImmediate();
      });
    };
    pumpImmediate();

    let asyncMixed;
    try {
      asyncMixed = await manager.verifyAndTrimUtteranceAsync(longMixedAudio, SPEAKER_SAMPLE_RATE);
    } finally {
      tickerActive = false;
    }

    assert.equal(
      extractTicks.length,
      syncExtractCount,
      'async path must perform the exact same number of embedding extractions as sync path',
    );
    assert.ok(
      eventLoopTicks >= syncExtractCount,
      `expected at least ${syncExtractCount} setImmediate yields, observed ${eventLoopTicks}`,
    );
    for (let i = 1; i < extractTicks.length; i++) {
      assert.ok(
        extractTicks[i]! > extractTicks[i - 1]!,
        `event loop must yield via setImmediate between extraction #${i - 1} (tick ${extractTicks[i - 1]}) and #${i} (tick ${extractTicks[i]})`,
      );
    }

    // Exact parity between sync and async results across all scenarios
    assert.equal(asyncMixed.matched, syncMixed.matched);
    assert.equal(asyncMixed.trimmed, true);
    assert.equal(asyncMixed.trimmed, syncMixed.trimmed);
    assert.deepEqual(asyncMixed.speaker, syncMixed.speaker);
    assert.equal(asyncMixed.score, syncMixed.score);
    assert.equal(asyncMixed.threshold, syncMixed.threshold);
    assert.equal(asyncMixed.samples.length, syncMixed.samples.length);
    assert.deepEqual(Array.from(asyncMixed.samples.slice(0, 32)), Array.from(syncMixed.samples.slice(0, 32)));

    for (const clip of [longPureOwner, longPureTv, shortOwner]) {
      const syncRes = manager.verifyAndTrimUtterance(clip, SPEAKER_SAMPLE_RATE);
      const asyncRes = await manager.verifyAndTrimUtteranceAsync(clip, SPEAKER_SAMPLE_RATE);
      assert.equal(asyncRes.matched, syncRes.matched);
      assert.equal(asyncRes.trimmed, syncRes.trimmed);
      assert.deepEqual(asyncRes.speaker, syncRes.speaker);
      assert.equal(asyncRes.score, syncRes.score);
      assert.equal(asyncRes.threshold, syncRes.threshold);
      assert.equal(asyncRes.reason, syncRes.reason);
      assert.equal(asyncRes.samples.length, syncRes.samples.length);
    }

    manager.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoaiKwsMonitor prefers speakerGate.verifyUtteranceAsync over synchronous verifyUtterance', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-kws-async-gate-'));
  let audioStream: PassThrough | undefined;
  let syncCalls = 0;
  let asyncCalls = 0;
  const received: Array<{ text: string; speakerName?: string }> = [];

  const monitor = new XiaoaiKwsMonitor({
    homeDir: home,
    cooldownMs: 20,
    probeDurationMs: 20,
    chimeDiscardMs: 10,
    endSilenceMs: 40,
    maxWaitSpeechMs: 1_000,
    sshRunner: async () => ({ stdout: '{"code":0}', stderr: '', code: 0 }),
    streamFactory: () => {
      audioStream = new PassThrough();
      return {
        stdout: audioStream,
        sampleFormat: 's16le',
        kill: () => audioStream?.end(),
        onClose: () => {},
      };
    },
    spotterFactory: () => {
      let triggered = false;
      return {
        createStream: () => ({}),
        acceptWaveform: (_s, samples) => {
          for (const v of samples) {
            if (Math.abs(v) > 0.6) triggered = true;
          }
        },
        isReady: () => triggered,
        decode: () => {},
        getResult: () => (triggered ? '你好星期五' : ''),
        reset: () => { triggered = false; },
      };
    },
    recognizerFactory: () => ({
      transcribe: async () => '你好星期五打开客厅灯',
    }),
    speakerGate: {
      isActive: () => true,
      verifyUtterance: () => {
        syncCalls++;
        return { matched: true, score: 0.9, threshold: 0.45 };
      },
      verifyUtteranceAsync: async ({ samples }) => {
        await new Promise<void>(resolve => setImmediate(resolve));
        asyncCalls++;
        return {
          matched: true,
          speaker: { id: 'spk-owner', name: '主人', role: 'owner', score: 0.92 },
          score: 0.92,
          threshold: 0.45,
          samples,
          trimmed: false,
        };
      },
    },
    onWake: async () => ({ woken: true, suppressed: false }),
    onUtterance: async (ev) => {
      received.push({ text: ev.text, speakerName: ev.speaker?.name });
    },
  });

  try {
    monitor.sync([
      {
        id: 'ch-kws',
        platform: 'xiaoai',
        name: '测试音箱',
        enabled: true,
        notifyAll: false,
        allowedSenders: ['lx06'],
        apiBase: 'ssh://lx06=root@192.0.2.88?kws=1&chime=0',
        defaultTarget: 'lx06',
        pollIntervalMs: 1_000,
        inboundCount: 0,
        outboundCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ]);

    for (let i = 0; i < 50 && !audioStream; i++) await delay(10);
    assert.ok(audioStream, 'KWS stream should start');

    const wake = synthTone(200, 600, 0.75);
    const speech = synthTone(200, 800, 0.25);
    const silence = synthTone(0, 160, 0);
    const full = concatFloat32(wake, speech, silence);
    const chunkSamples = Math.round(SPEAKER_SAMPLE_RATE * 0.04);
    for (let off = 0; off < full.length; off += chunkSamples) {
      audioStream.write(encodeS16Le(full.subarray(off, off + chunkSamples)));
    }

    for (let i = 0; i < 100 && received.length === 0; i++) await delay(15);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.speakerName, '主人');
    assert.equal(asyncCalls, 1, 'transcribeAndEmit must invoke verifyUtteranceAsync when provided');
    assert.equal(syncCalls, 0, 'synchronous verifyUtterance must not be called when verifyUtteranceAsync exists');
  } finally {
    monitor.close();
    await rm(home, { recursive: true, force: true });
  }
});

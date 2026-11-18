import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { realFactory } from '../src/agent.js';
import { Coordinator } from '../src/coordinator.js';
import { requestGeminiDecisions } from '../src/decision.js';
import { ModelHub } from '../src/model-hub.js';
import {
  calculateModelCallCost,
  DEFAULT_USD_TO_CNY_RATE,
  normalizeSdkUsage,
  resolveModelUnitPrice,
} from '../src/models/pricing.js';
import { Store } from '../src/store.js';

async function until(predicate: () => boolean | Promise<boolean>, attempts = 400) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for condition');
}

function approxEqual(actual: number, expected: number, eps = 1e-9, message?: string) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${message ? `${message}: ` : ''}expected ${actual} ≈ ${expected} (±${eps})`,
  );
}

test('pricing: unit price lookup across providers, catalog override, free models, and unknown fallback', () => {
  assert.equal(DEFAULT_USD_TO_CNY_RATE, 7.25);

  // Free local/offline models
  assert.deepEqual(resolveModelUnitPrice('ollama', 'qwen3:8b'), {
    inputUsdPer1M: 0,
    outputUsdPer1M: 0,
    cacheReadUsdPer1M: 0,
    cacheWriteUsdPer1M: 0,
    source: 'free',
  });
  assert.deepEqual(resolveModelUnitPrice('offline', 'gpt-4o'), {
    inputUsdPer1M: 0,
    outputUsdPer1M: 0,
    cacheReadUsdPer1M: 0,
    cacheWriteUsdPer1M: 0,
    source: 'free',
  });
  assert.deepEqual(resolveModelUnitPrice('zhipu', 'glm-4-flash'), {
    inputUsdPer1M: 0,
    outputUsdPer1M: 0,
    cacheReadUsdPer1M: 0,
    cacheWriteUsdPer1M: 0,
    source: 'free',
  });

  // Catalog override with derived and explicit cache rates
  const catDefaultCache = resolveModelUnitPrice('openai', 'gpt-4.1', { costInput: 4, costOutput: 12 });
  assert.equal(catDefaultCache.source, 'catalog');
  assert.equal(catDefaultCache.inputUsdPer1M, 4);
  assert.equal(catDefaultCache.outputUsdPer1M, 12);
  assert.equal(catDefaultCache.cacheReadUsdPer1M, 1);
  assert.equal(catDefaultCache.cacheWriteUsdPer1M, 4);

  const catExplicitCache = resolveModelUnitPrice('anthropic', 'claude-sonnet-4', {
    costInput: 3,
    costOutput: 15,
    costCacheRead: 0.3,
    costCacheWrite: 3.75,
  });
  assert.equal(catExplicitCache.source, 'catalog');
  assert.equal(catExplicitCache.cacheReadUsdPer1M, 0.3);
  assert.equal(catExplicitCache.cacheWriteUsdPer1M, 3.75);

  // Estimated fallback table with prefix, @thinkingLevel, and case normalization
  const cases: Array<[string, string, number, number]> = [
    ['openai', 'openai/GPT-5@high', 1.25, 10],
    ['openai', 'gpt-4.1-mini@low', 0.4, 1.6],
    ['openai', 'gpt-4.1-nano', 0.1, 0.4],
    ['openai', 'gpt-4.1', 2, 8],
    ['openai', 'gpt-4o-mini', 0.15, 0.6],
    ['openai', 'gpt-4o', 2.5, 10],
    ['openai', 'o4-mini@max', 1.1, 4.4],
    ['openai', 'o3-mini', 1.1, 4.4],
    ['openai', 'o3', 2, 8],
    ['openai', 'o1', 15, 60],
    ['anthropic', 'claude-opus-4-20250514', 15, 75],
    ['anthropic', 'claude-sonnet-4-20250514', 3, 15],
    ['anthropic', 'claude-3-7-sonnet-latest', 3, 15],
    ['anthropic', 'claude-haiku-4-5', 1, 5],
    ['anthropic', 'claude-3-5-haiku-latest', 0.8, 4],
    ['google', 'gemini-2.5-pro', 1.25, 10],
    ['google', 'gemini-2.5-flash-lite', 0.1, 0.4],
    ['google', 'gemini-2.5-flash', 0.3, 2.5],
    ['google', 'gemini-2.0-flash', 0.1, 0.4],
    ['google', 'gemini-decision-1', 0.1, 0.4],
    ['deepseek', 'deepseek-reasoner@high', 0.55, 2.19],
    ['deepseek', 'deepseek-ai/DeepSeek-R1', 0.55, 2.19],
    ['deepseek', 'deepseek-chat', 0.27, 1.1],
    ['openrouter', 'deepseek/deepseek-chat-v3-0324', 0.27, 1.1],
    ['dashscope', 'qwen-max-latest', 1.6, 6.4],
    ['dashscope', 'qwen-coder-plus-latest', 0.5, 1.5],
    ['dashscope', 'qwen-vl-max-latest', 0.8, 2.4],
    ['dashscope', 'qwen-turbo-latest', 0.05, 0.2],
    ['dashscope', 'qwen3-32b', 0.7, 2.8],
    ['custom', 'qwen3-custom-variant', 0.4, 1.2],
    ['moonshot', 'kimi-k2-0711-preview', 1, 3],
    ['moonshot', 'moonshot-v1-128k-vision-preview', 1, 3],
    ['moonshot', 'moonshot-v1-32k', 0.2, 0.6],
    ['moonshot', 'moonshot-v1-8k', 0.15, 0.5],
    ['zhipu', 'glm-4.5-air', 0.2, 1.1],
    ['zhipu', 'glm-4.5', 0.8, 2],
    ['xai', 'grok-4', 3, 15],
    ['xai', 'grok-3-mini', 0.3, 0.5],
    ['xai', 'grok-3', 3, 15],
  ];
  for (const [provider, model, expIn, expOut] of cases) {
    const resolved = resolveModelUnitPrice(provider, model);
    assert.equal(resolved.source, 'estimated', `source for ${provider}/${model}`);
    assert.equal(resolved.inputUsdPer1M, expIn, `input rate for ${provider}/${model}`);
    assert.equal(resolved.outputUsdPer1M, expOut, `output rate for ${provider}/${model}`);
  }

  // Unknown model
  const unknown = resolveModelUnitPrice('custom', 'unlisted-model-xyz', { costInput: 0, costOutput: 0 });
  assert.equal(unknown.source, 'unknown');
  assert.equal(unknown.inputUsdPer1M, 0);
  assert.equal(unknown.outputUsdPer1M, 0);
});

test('pricing: cost calculation respects provider billing and never double-counts reasoning tokens', () => {
  // 1) Reasoning tokens are already inside output tokens: 1000 in, 500 out (including 300 reasoning)
  const calc = calculateModelCallCost({
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    reasoningTokens: 300_000,
  });
  assert.equal(calc.costSource, 'estimated');
  // 1M * $0.55 + 0.5M * $2.19 = $0.55 + $1.095 = $1.645 (NOT + 0.3M * $2.19!)
  approxEqual(calc.costUsd, 1.645, 1e-9, 'reasoning must not be double-billed');

  // 2) Provider-reported billed cost overrides catalog/estimated when totalFromProvider=true
  const providerCost = calculateModelCallCost({
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4',
    inputTokens: 1000,
    outputTokens: 500,
    providerReportedTotalUsd: 0.012345,
    totalFromProvider: true,
  });
  assert.equal(providerCost.costSource, 'provider');
  approxEqual(providerCost.costUsd, 0.012345, 1e-9);
  assert.equal(providerCost.unitInputUsdPer1M, 3);
  assert.equal(providerCost.unitOutputUsdPer1M, 15);

  // 3) If totalFromProvider is false, ignore providerReportedTotalUsd and compute from catalog
  const catalogFallback = calculateModelCallCost({
    provider: 'openai',
    model: 'gpt-4.1',
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cacheReadTokens: 400_000,
    cacheWriteTokens: 100_000,
    providerReportedTotalUsd: 99,
    totalFromProvider: false,
    catalogRate: { costInput: 2, costOutput: 8 },
  });
  assert.equal(catalogFallback.costSource, 'catalog');
  // 1M*2 + 0.5M*8 + 0.4M*(2*0.25=0.5) + 0.1M*2 = 2 + 4 + 0.2 + 0.2 = 6.4
  approxEqual(catalogFallback.costUsd, 6.4, 1e-9);

  // 4) normalizeSdkUsage preserves totalTokens without adding reasoning
  const normalized = normalizeSdkUsage({
    input: 120,
    output: 80,
    cacheRead: 30,
    cacheWrite: 10,
    reasoning: 50,
    totalTokens: 240,
  });
  assert.ok(normalized);
  assert.equal(normalized.inputTokens, 120);
  assert.equal(normalized.outputTokens, 80);
  assert.equal(normalized.reasoningTokens, 50);
  assert.equal(normalized.totalTokens, 240);
});

test('usage-store: idempotent journal backfill across recover() and ready() defaultProvider upgrade', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-usage-backfill-'));
  const store = new Store(home);
  try {
    const taskId = 'task-backfill-1';
    store.create({
      id: taskId,
      requestId: 'req-backfill-1',
      fingerprint: 'fp-1',
      prompt: 'Analyze codebase',
      status: 'completed',
      revision: 0,
      files: [],
      mode: 'real',
      createdAt: Date.now() - 10_000,
      limitMs: 600_000,
      activeMs: 500,
      workerModel: 'deepseek/deepseek-reasoner@high',
    });

    // 1. Started span (should be skipped)
    store.conversation.span(
      { rootId: 'msg-1', messageId: 'msg-1', spanId: 'span-r-1' },
      'router',
      '模型推理调用',
      'started',
      { mode: 'real', detail: {} },
    );
    // 2. Router completed turn without provider/model in detail
    store.conversation.span(
      { rootId: 'msg-1', messageId: 'msg-1', spanId: 'span-r-1' },
      'router',
      '模型推理调用',
      'completed',
      {
        mode: 'real',
        detail: {
          stopReason: 'stop',
          usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 1200 },
        },
      },
    );
    // 3. Worker completed turn linked to task with workerModel
    store.conversation.span(
      { rootId: 'msg-1', messageId: 'msg-1', taskId, spanId: 'span-w-1' },
      'worker',
      '模型推理调用',
      'completed',
      {
        mode: 'real',
        detail: {
          stopReason: 'stop',
          usage: { input: 2000, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 300, totalTokens: 2500 },
        },
      },
    );
    // 4. Compaction span
    store.conversation.span(
      { rootId: 'msg-1', messageId: 'msg-1', taskId, spanId: 'span-c-1' },
      'worker',
      '上下文压缩（SDK）',
      'completed',
      {
        mode: 'real',
        detail: {
          usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 600 },
        },
      },
    );
    // 5. Legacy Gemini Decision 1 span (without outputTokens)
    store.conversation.span(
      { rootId: 'msg-1', messageId: 'msg-1', taskId, spanId: `${taskId}:decision:route` },
      'system',
      'Gemini Decision 1 选模定级',
      'completed',
      {
        request: { decisionModel: 'gemini-decision-1' },
        source: 'gemini-decision-1',
        usage: { inputTokens: 180, totalTokens: 200 },
      },
    );
    // 6. Offline/no-usage span (should be skipped)
    store.conversation.span(
      { rootId: 'msg-1', messageId: 'msg-1', spanId: 'span-offline-1' },
      'router',
      '模型推理调用',
      'completed',
      { mode: 'offline', detail: { stopReason: 'stop', publicText: 'offline' } },
    );

    // Phase 1: recover() runs before defaultProvider is known
    store.recover();
    let report = store.queryUsage({ granularity: 'day' });
    assert.equal(report.totals.calls, 4);
    assert.equal(report.totals.totalTokens, 1200 + 2500 + 600 + 200);
    assert.equal(report.byActor.router?.calls, 1);
    assert.equal(report.byActor.worker?.calls, 1);
    assert.equal(report.byActor.compaction?.calls, 1);
    assert.equal(report.byActor.decision?.calls, 1);
    assert.equal(report.byActor.decision?.outputTokens, 20);
    // Router initially unknown until defaultProvider is supplied
    assert.ok(report.byModel.some(m => m.spec === 'unknown/unknown'));

    // Calling recover() again must be a no-op
    store.recover();
    assert.equal(store.queryUsage({ granularity: 'day' }).totals.calls, 4);

    // Phase 2: ready() supplies defaultProvider + defaultRouterModel, upgrading unknown router rows
    const upgraded = store.backfillUsage('openai', 'gpt-4.1');
    assert.equal(upgraded, 1);

    report = store.queryUsage({ granularity: 'day' });
    assert.equal(report.totals.calls, 4);
    assert.equal(report.byModel.some(m => m.spec === 'unknown/unknown'), false);
    const routerModel = report.byModel.find(m => m.spec === 'openai/gpt-4.1');
    assert.ok(routerModel);
    assert.equal(routerModel.costSource, 'estimated');
    approxEqual(routerModel.costUsd, (1000 * 2 + 200 * 8) / 1_000_000, 1e-9);

    const dsModel = report.byModel.find(m => m.spec === 'deepseek/deepseek-reasoner');
    assert.ok(dsModel);
    assert.equal(dsModel.calls, 2); // worker + compaction
    assert.equal(dsModel.actors.worker, 1);
    assert.equal(dsModel.actors.compaction, 1);
    assert.equal(dsModel.reasoningTokens, 300);

    // Phase 3: subsequent backfillUsage() calls must be strictly idempotent
    assert.equal(store.backfillUsage('openai', 'gpt-4.1'), 0);
    assert.equal(store.backfillUsage('anthropic', 'claude-sonnet-4'), 0);
    assert.equal(store.queryUsage({ granularity: 'day' }).totals.calls, 4);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('usage-store: day/week/month aggregation, timezone boundaries, navigation, recentPeriods, and prefs', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-usage-agg-'));
  const store = new Store(home);
  try {
    // Verify default prefs and validation
    assert.deepEqual(store.getUsagePrefs(), { currency: 'CNY', usdToCnyRate: 7.25 });
    assert.throws(() => store.setUsagePrefs({ usdToCnyRate: 0.1 }), /usdToCnyRate/);
    assert.throws(() => store.setUsagePrefs({ usdToCnyRate: 100.1 }), /usdToCnyRate/);
    assert.throws(() => store.setUsagePrefs({ currency: 'EUR' as 'USD' }), /currency/);

    const updatedPrefs = store.setUsagePrefs({ currency: 'USD', usdToCnyRate: 7.1 });
    assert.deepEqual(updatedPrefs, { currency: 'USD', usdToCnyRate: 7.1 });

    // Timezone boundary test: UTC+8 (tzOffsetMin = -480)
    // A: 2025-05-13 23:30:00 +08:00 === 2025-05-13T15:30:00Z
    // B: 2025-05-14 00:30:00 +08:00 === 2025-05-13T16:30:00Z
    // C: 2025-05-14 14:15:00 +08:00 === 2025-05-14T06:15:00Z
    // D: 2025-05-16 09:00:00 +08:00 === 2025-05-16T01:00:00Z
    // E: 2025-04-05 12:00:00 +08:00 === 2025-04-05T04:00:00Z
    const atA = Date.parse('2025-05-13T23:30:00+08:00');
    const atB = Date.parse('2025-05-14T00:30:00+08:00');
    const atC = Date.parse('2025-05-14T14:15:00+08:00');
    const atD = Date.parse('2025-05-16T09:00:00+08:00');
    const atE = Date.parse('2025-04-05T12:00:00+08:00');

    store.recordUsage({
      id: 'u-A',
      at: atA,
      actor: 'router',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      inputTokens: 1000,
      outputTokens: 500,
      status: 'completed',
    });
    store.recordUsage({
      id: 'u-B',
      at: atB,
      actor: 'worker',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      inputTokens: 2000,
      outputTokens: 1000,
      status: 'completed',
    });
    store.recordUsage({
      id: 'u-C',
      at: atC,
      actor: 'decision',
      provider: 'google',
      model: 'gemini-decision-1',
      inputTokens: 500,
      outputTokens: 100,
      status: 'failed',
    });
    store.recordUsage({
      id: 'u-D',
      at: atD,
      actor: 'dreamer',
      provider: 'deepseek',
      model: 'deepseek-chat',
      inputTokens: 10_000,
      outputTokens: 2000,
      status: 'completed',
    });
    store.recordUsage({
      id: 'u-E',
      at: atE,
      actor: 'probe',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      status: 'completed',
    });

    // Day query in UTC+8 for 2025-05-14: only B and C belong to this day
    const dayUtc8 = store.queryUsage({ granularity: 'day', anchorDate: '2025-05-14', tzOffsetMin: -480 });
    assert.equal(dayUtc8.granularity, 'day');
    assert.equal(dayUtc8.anchorDate, '2025-05-14');
    assert.equal(dayUtc8.prevAnchorDate, '2025-05-13');
    assert.equal(dayUtc8.nextAnchorDate, '2025-05-15');
    assert.equal(dayUtc8.tzOffsetMin, -480);
    assert.deepEqual(dayUtc8.prefs, { currency: 'USD', usdToCnyRate: 7.1 });
    assert.equal(dayUtc8.buckets.length, 24);
    assert.equal(dayUtc8.buckets[0]!.key, '00');
    assert.equal(dayUtc8.buckets[0]!.label, '00:00');
    assert.equal(dayUtc8.buckets[0]!.calls, 1);
    assert.equal(dayUtc8.buckets[14]!.calls, 1);
    assert.equal(dayUtc8.buckets[23]!.label, '23:00');
    assert.equal(dayUtc8.totals.calls, 2);
    assert.equal(dayUtc8.totals.successCalls, 1);
    assert.equal(dayUtc8.totals.failedCalls, 1);
    assert.equal(dayUtc8.totals.totalTokens, 3600);
    // byModel sorted by costUsd DESC (claude-sonnet-4 > gemini-decision-1)
    assert.equal(dayUtc8.byModel[0]!.spec, 'anthropic/claude-sonnet-4');
    assert.equal(dayUtc8.byModel[1]!.spec, 'google/gemini-decision-1');
    approxEqual(dayUtc8.byModel[0]!.tokenShare, 3000 / 3600, 1e-5);
    approxEqual(dayUtc8.totals.costCny, dayUtc8.totals.costUsd * 7.1, 1e-9);
    assert.equal(dayUtc8.recentPeriods.length, 7);
    assert.equal(dayUtc8.recentPeriods.filter(p => p.isCurrent).length, 1);

    // Previous day in UTC+8 (2025-05-13): has A in bucket 23
    const prevDayUtc8 = store.queryUsage({
      granularity: 'day',
      anchorDate: dayUtc8.prevAnchorDate,
      tzOffsetMin: -480,
    });
    assert.equal(prevDayUtc8.totals.calls, 1);
    assert.equal(prevDayUtc8.buckets[23]!.calls, 1);

    // Same instants queried in UTC (tzOffsetMin = 0) on 2025-05-13: BOTH A (15:30Z) and B (16:30Z) appear!
    const dayUtc0 = store.queryUsage({ granularity: 'day', anchorDate: '2025-05-13', tzOffsetMin: 0 });
    assert.equal(dayUtc0.totals.calls, 2);
    assert.equal(dayUtc0.buckets[15]!.calls, 1);
    assert.equal(dayUtc0.buckets[16]!.calls, 1);

    // Week query in UTC+8 (2025-05-14 -> Mon 05/12 ~ Sun 05/18, ISO week 20)
    const weekReport = store.queryUsage({ granularity: 'week', anchorDate: '2025-05-14', tzOffsetMin: -480 });
    assert.equal(weekReport.periodLabel, '2025年第20周 (05/12 ~ 05/18)');
    assert.equal(weekReport.prevAnchorDate, '2025-05-05');
    assert.equal(weekReport.nextAnchorDate, '2025-05-19');
    assert.equal(weekReport.buckets.length, 7);
    assert.equal(weekReport.buckets[0]!.label, '周一 05/12');
    assert.equal(weekReport.buckets[1]!.label, '周二 05/13');
    assert.equal(weekReport.buckets[1]!.calls, 1); // A
    assert.equal(weekReport.buckets[2]!.calls, 2); // B + C
    assert.equal(weekReport.buckets[4]!.calls, 1); // D (Friday 05/16)
    assert.equal(weekReport.buckets[6]!.label, '周日 05/18');
    assert.equal(weekReport.totals.calls, 4);
    assert.equal(weekReport.recentPeriods.length, 8);
    assert.equal(weekReport.recentPeriods.find(p => p.isCurrent)?.key, '2025-W20');

    // Month query in UTC+8 (2025-05-14 -> 2025年5月, 31 days)
    const monthReport = store.queryUsage({ granularity: 'month', anchorDate: '2025-05-14', tzOffsetMin: -480 });
    assert.equal(monthReport.periodLabel, '2025年5月');
    assert.equal(monthReport.prevAnchorDate, '2025-04-01');
    assert.equal(monthReport.nextAnchorDate, '2025-06-01');
    assert.equal(monthReport.buckets.length, 31);
    assert.equal(monthReport.buckets[13]!.label, '14日');
    assert.equal(monthReport.buckets[13]!.calls, 2);
    assert.equal(monthReport.totals.calls, 4);
    assert.equal(monthReport.recentPeriods.length, 6);
    assert.equal(monthReport.recentPeriods.find(p => p.isCurrent)?.key, '2025-05');

    // Prev month (April) includes E
    const aprReport = store.queryUsage({
      granularity: 'month',
      anchorDate: monthReport.prevAnchorDate,
      tzOffsetMin: -480,
    });
    assert.equal(aprReport.periodLabel, '2025年4月');
    assert.equal(aprReport.buckets.length, 30);
    assert.equal(aprReport.totals.calls, 1);
    assert.equal(aprReport.byActor.probe?.calls, 1);

    // Today usage summary records live today data
    store.recordUsage({
      actor: 'worker',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
    });
    const today = store.todayUsageSummary();
    assert.equal(today.calls, 1);
    assert.equal(today.totalTokens, 1500);
    assert.equal(today.currency, 'USD');
    assert.equal(today.usdToCnyRate, 7.1);
    approxEqual(today.costUsd, (1000 * 2.5 + 500 * 10) / 1_000_000, 1e-9);
    approxEqual(today.costCny, today.costUsd * 7.1, 1e-9);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('decision & realFactory SSE integration: automatic model_usage ledger capture across router, probe, and decision', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-usage-live-'));

  const sseServer = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'gpt-4o', object: 'model' },
          { id: 'gpt-4.1-mini', object: 'model' },
        ],
      }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}') as { model?: string; messages?: Array<{ role: string }> };
    const model = body.model ?? 'gpt-4o';
    const packet = (delta: unknown, finish_reason: string | null, usage?: unknown) => ({
      id: 'chatcmpl-usage-test',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason }],
      ...(usage ? { usage } : {}),
    });

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify(packet({ role: 'assistant', content: '老板，已收到。' }, null))}\n\n`
      + `data: ${JSON.stringify(packet({}, 'stop', {
        prompt_tokens: 150,
        completion_tokens: 60,
        total_tokens: 210,
        prompt_tokens_details: { cached_tokens: 30 },
        completion_tokens_details: { reasoning_tokens: 20 },
      }))}\n\n`
      + 'data: [DONE]\n\n',
    );
  });

  const decisionServer = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}') as {
      questions?: Record<string, { criteria?: Record<string, string> }>;
    };
    const routeCriteria = body.questions?.route?.criteria ?? {};
    const firstKey = Object.keys(routeCriteria)[0] ?? 'openai/gpt-4o@off';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      answers: {
        route: { type: 'choice', choice: firstKey, confidence: 0.92 },
        needs_quality_gate: { type: 'noul', noul: 0.1, confidence: 0.9 },
      },
      usage: {
        total_input_tokens: 300,
        total_output_tokens: 25,
        total_tokens: 325,
      },
    }));
  });

  await new Promise<void>(resolve => sseServer.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => decisionServer.listen(0, '127.0.0.1', resolve));
  const sseAddr = sseServer.address() as { port: number };
  const decAddr = decisionServer.address() as { port: number };

  try {
    // 1) Verify requestGeminiDecisions exposes outputTokens
    const decRes = await requestGeminiDecisions(
      { apiKey: 'dec-key', baseUrl: `http://127.0.0.1:${decAddr.port}/v1beta` },
      'test',
      { route: { type: 'choice', instructions: 'pick', criteria: { a: 'opt a' } } },
    );
    assert.deepEqual(decRes.usage, { inputTokens: 300, totalTokens: 325 });
    assert.equal(decRes.outputTokens, 25);

    // 2) Verify realFactory directly emits onModelUsage for local mock OpenAI SSE server
    const directRoot = join(home, 'direct');
    await mkdir(directRoot, { recursive: true });
    const directStore = new Store(directRoot);
    directStore.recover();
    try {
      const runtime = await ModelRuntime.create({
        refreshOnCreate: false,
        modelsPath: null,
        authPath: join(directRoot, 'sdk', 'auth.json'),
      });
      const directFactory = await realFactory(
        directRoot,
        {
          provider: 'openai',
          model: 'gpt-4o',
          apiKey: 'mock-key',
          baseUrl: `http://127.0.0.1:${sseAddr.port}/v1`,
        },
        runtime,
      );
      directFactory.onModelUsage = entry => {
        directStore.recordUsage({
          actor: entry.actor,
          provider: entry.provider,
          model: entry.model,
          status: entry.status,
          usage: entry.usage,
        });
      };

      const observedEvents: Array<{ kind: string; data?: unknown }> = [];
      const agent = await directFactory.create('worker', 'worker-sse-1', [], {
        onEvent: ev => observedEvents.push(ev),
      });
      try {
        const reply = await agent.prompt('hello usage', new AbortController().signal);
        assert.equal(reply, '老板，已收到。');
      } finally {
        agent.close();
      }
      const turnEnd = observedEvents.find(ev => ev.kind === 'turn_end');
      assert.ok(turnEnd?.data && typeof turnEnd.data === 'object');
      assert.equal((turnEnd.data as { provider?: string }).provider, 'openai');
      assert.equal((turnEnd.data as { model?: string }).model, 'gpt-4o');

      const directReport = directStore.queryUsage({ granularity: 'day' });
      assert.equal(directReport.totals.calls, 1);
      assert.equal(directReport.totals.inputTokens, 120); // 150 - 30 cached
      assert.equal(directReport.totals.cacheReadTokens, 30);
      assert.equal(directReport.totals.outputTokens, 60);
      assert.equal(directReport.totals.reasoningTokens, 20);
      assert.equal(directReport.totals.totalTokens, 210);
      assert.equal(directReport.byActor.worker?.calls, 1);
      // 120 * 2.5 + 60 * 10 + 30 * 1.25 (real OpenAI gpt-4o cacheRead rate) = 300 + 600 + 37.5 = 937.5 / 1M
      approxEqual(directReport.totals.costUsd, 937.5 / 1_000_000, 1e-10);
    } finally {
      directStore.close();
    }

    // 3) Verify Coordinator end-to-end wiring (realFactory router + ModelHub probe + ModelHub decision)
    const coordRoot = join(home, 'coord');
    await mkdir(coordRoot, { recursive: true });
    const coordRuntime = await ModelRuntime.create({
      refreshOnCreate: false,
      modelsPath: null,
      authPath: join(coordRoot, 'sdk', 'auth.json'),
    });
    const coordFactory = await realFactory(
      coordRoot,
      {
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'mock-key',
        baseUrl: `http://127.0.0.1:${sseAddr.port}/v1`,
      },
      coordRuntime,
    );
    const coordinator = new Coordinator(coordRoot, coordFactory, {
      skipExecutor: true,
      distillerEnabled: false,
    });
    try {
      await coordinator.ready();
      await coordinator.configureModels({
        providerId: 'openai',
        apiKey: 'mock-key',
        baseUrl: `http://127.0.0.1:${sseAddr.port}/v1`,
        selectedModels: ['gpt-4o', 'gpt-4.1-mini'],
        decisionApiKey: 'dec-key',
        decisionBaseUrl: `http://127.0.0.1:${decAddr.port}/v1beta`,
      });

      const userMsg = coordinator.chat('req-coord-usage-1', '测试真实用量记账');
      await until(() => coordinator.store.conversation.get(userMsg.id).status === 'completed');

      const probeRes = await coordinator.modelHub.probe({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'mock-key',
        baseUrl: `http://127.0.0.1:${sseAddr.port}/v1`,
      });
      assert.equal(probeRes.ok, true);

      await coordinator.modelHub.decideWorkerModel({
        instruction: '帮我分析一下代码结构',
        profile: 'coding',
      });

      const coordReport = coordinator.store.queryUsage({ granularity: 'day' });
      assert.ok(coordReport.byActor.router && coordReport.byActor.router.calls >= 1);
      assert.equal(coordReport.byActor.probe?.calls, 1);
      assert.equal(coordReport.byActor.decision?.calls, 1);
      assert.equal(coordReport.byActor.decision?.inputTokens, 300);
      assert.equal(coordReport.byActor.decision?.outputTokens, 25);
      assert.equal(coordReport.byActor.decision?.totalTokens, 325);
      const today = coordinator.store.todayUsageSummary();
      assert.equal(today.calls, coordReport.totals.calls);
      assert.equal(today.totalTokens, coordReport.totals.totalTokens);
    } finally {
      await coordinator.close();
    }
  } finally {
    sseServer.closeAllConnections();
    decisionServer.closeAllConnections();
    await Promise.all([
      new Promise<void>(resolve => sseServer.close(() => resolve())),
      new Promise<void>(resolve => decisionServer.close(() => resolve())),
    ]);
    await rm(home, { recursive: true, force: true });
  }
});

test('pricing & usage-store: synced fallback snapshot covers latest models and reprices unknown ledger rows on recover()', async () => {
  const expected: Array<[string, string, number, number, number?]> = [
    ['opencode-go', 'deepseek-v4.1-flash', 0.15, 0.6, 0.003],
    ['google', 'gemini-3.8-flash', 0.75, 3.75, 0.075],
    ['openai', 'gpt-6-luna', 0.1, 0.5, 0.01],
    ['opencode-go', 'gpt-6.1-terra', 1, 5, 0.05],
    ['openai', 'gpt-6.2-sol', 2, 10, 0.1],
    ['openai', 'gpt-6.2-astra', 8, 40, 0.4],
    ['google', 'gemini-4-argon', 2, 10, 0.1],
    ['google', 'gemini-4-carbon', 2, 10, 0.1],
    ['google', 'gemini-4-hydrogen', 1.5, 7.5, 0.075],
    ['google', 'gemini-omni-1.2-flash', 1.5, 9, 0.15],
  ];
  for (const [provider, model, expIn, expOut, expCacheRead] of expected) {
    const unit = resolveModelUnitPrice(provider, model);
    assert.equal(unit.source, 'estimated', `source for ${provider}/${model}`);
    assert.equal(unit.inputUsdPer1M, expIn, `input rate for ${provider}/${model}`);
    assert.equal(unit.outputUsdPer1M, expOut, `output rate for ${provider}/${model}`);
    if (expCacheRead !== undefined) {
      assert.equal(unit.cacheReadUsdPer1M, expCacheRead, `cacheRead rate for ${provider}/${model}`);
    }
  }

  // Free variants (:free / -free)
  assert.equal(resolveModelUnitPrice('opencode', 'deepseek-v4.1-flash-free').source, 'free');
  assert.equal(resolveModelUnitPrice('openrouter', 'qwen/qwen3-coder:free').source, 'free');

  // Reprice existing cost_source='unknown' rows on Store.recover()
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-usage-reprice-'));
  try {
    const store1 = new Store(home);
    store1.recover();
    store1.close();

    const rawDb = new DatabaseSync(join(home, 'state.sqlite'));
    const now = Date.now();
    rawDb.prepare(`
      INSERT INTO model_usage(
        id, at, actor, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
        cost_usd, unit_input_usd, unit_output_usd, cost_source, status
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      'legacy-unknown-1',
      now,
      'worker',
      'google',
      'gemini-3.8-flash',
      1_000_000,
      200_000,
      10_000_000,
      0,
      50_000,
      11_200_000,
      0,
      0,
      0,
      'unknown',
      'completed',
    );
    rawDb.prepare(`
      INSERT INTO model_usage(
        id, at, actor, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
        cost_usd, unit_input_usd, unit_output_usd, cost_source, status
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      'legacy-unknown-2',
      now,
      'router',
      'opencode-go',
      'deepseek-v4.1-flash',
      1_000_000,
      100_000,
      1_000_000,
      0,
      0,
      2_100_000,
      0,
      0,
      0,
      'unknown',
      'completed',
    );
    rawDb.prepare("DELETE FROM metadata WHERE key='usage_reprice_version'").run();
    rawDb.close();

    const store2 = new Store(home);
    store2.recover();
    try {
      const report = store2.queryUsage({ granularity: 'day' });
      // gemini-3.8-flash: 1M*0.75 + 0.2M*3.75 + 10M*0.075 = 0.75 + 0.75 + 0.75 = 2.25
      const gRow = report.byModel.find(m => m.spec === 'google/gemini-3.8-flash');
      assert.ok(gRow);
      assert.equal(gRow.costSource, 'estimated');
      approxEqual(gRow.costUsd, 2.25, 1e-6);
      // deepseek-v4.1-flash: 1M*0.15 + 0.1M*0.6 + 1M*0.003 = 0.15 + 0.06 + 0.003 = 0.213
      const dRow = report.byModel.find(m => m.spec === 'opencode-go/deepseek-v4.1-flash');
      assert.ok(dRow);
      assert.equal(dRow.costSource, 'estimated');
      approxEqual(dRow.costUsd, 0.213, 1e-6);
    } finally {
      store2.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

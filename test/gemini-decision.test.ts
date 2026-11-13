import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../dist/coordinator.js';
import { Store } from '../dist/store.js';
import type { AgentFactory } from '../src/agent.js';
import type { QualityGateAssessment, ThinkingLevel } from '../src/view.js';

async function until(predicate: () => boolean | Promise<boolean>, attempts = 400) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for condition');
}

interface RecordedDecisionRequest {
  apiKey?: string;
  model?: string;
  input: Record<string, unknown>;
  questions: Record<string, { type: string; instructions: string; criteria?: Record<string, string> | string[] }>;
}

async function withMockDecisionServer(
  handler: (req: RecordedDecisionRequest, index: number) => { status?: number; body: Record<string, unknown> },
) {
  const requests: RecordedDecisionRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const parsed = JSON.parse(raw || '{}') as {
      model?: string;
      input?: string;
      questions?: RecordedDecisionRequest['questions'];
    };
    const recorded: RecordedDecisionRequest = {
      apiKey: typeof req.headers['x-goog-api-key'] === 'string' ? req.headers['x-goog-api-key'] : undefined,
      model: parsed.model,
      input: parsed.input ? JSON.parse(parsed.input) as Record<string, unknown> : {},
      questions: parsed.questions ?? {},
    };
    const idx = requests.length;
    requests.push(recorded);
    const reply = handler(recorded, idx);
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1beta`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

test('Gemini Decision 1: cross-provider model@thinkingLevel routing, quality gate & model stats loop', async () => {
  let chosenRouteKey = '';
  let evalCallCount = 0;
  const mock = await withMockDecisionServer(req => {
    if (req.questions.route) {
      const keys = Object.keys((req.questions.route.criteria as Record<string, string>) ?? {});
      const preferred = keys.find(k => k.includes('@high') || k.includes('@xhigh') || k.includes('@max')) ?? keys[0]!;
      chosenRouteKey = preferred;
      return {
        body: {
          answers: {
            route: { type: 'choice', choice: preferred, confidence: 0.91 },
          },
          usage: { total_input_tokens: 180, total_output_tokens: 12, total_tokens: 192 },
        },
      };
    }
    evalCallCount++;
    if (evalCallCount === 1) {
      return {
        body: {
          answers: {
            completion: { type: 'score', score: 1.1, confidence: 0.86 },
            should_supplement: { type: 'noul', noul: 0.85, confidence: 0.88 },
            missing_aspect: { type: 'choice', choice: 'missing_verification', confidence: 0.84 },
          },
          usage: { total_input_tokens: 210, total_output_tokens: 16, total_tokens: 226 },
        },
      };
    }
    return {
      body: {
        answers: {
          completion: { type: 'score', score: 2.8, confidence: 0.93 },
          should_supplement: { type: 'noul', noul: 0.08, confidence: 0.92 },
          missing_aspect: { type: 'choice', choice: 'none', confidence: 0.95 },
        },
        usage: { total_input_tokens: 220, total_output_tokens: 16, total_tokens: 236 },
      },
    };
  });

  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-jev-main-'));
  const chatPayloads: Array<Record<string, unknown>> = [];
  const workerReportsObserved: Array<QualityGateAssessment | undefined> = [];
  const workerInvocations: Array<{ model?: string; thinkingLevel?: ThinkingLevel }> = [];

  const factory: AgentFactory = {
    mode: 'offline',
    nativeTools: true,
    async create(role, _id, tools, options) {
      return {
        close() {},
        async prompt(text) {
          const event = JSON.parse(text) as Record<string, unknown>;
          if (role === 'worker') {
            workerInvocations.push({ model: options?.model, thinkingLevel: options?.thinkingLevel });
            if (workerInvocations.length === 1) return '初步看过代码，尚未跑测试';
            return '已完成并发竞态修复并通过 npm test 全部用例验证';
          }
          const call = async (name: string, args: unknown) =>
            JSON.parse(await tools.find(t => t.name === name)!.execute(JSON.stringify(args)));
          if (event.kind === 'CHAT') {
            chatPayloads.push(event);
            await call('start_work', { instruction: '重构异步队列并发竞态并补齐测试', profile: 'coding', cwd: home });
            return '好的老板，任务已下发。';
          }
          if (event.kind === 'WORKER_REPORT') {
            const qg = event.qualityGate as QualityGateAssessment | undefined;
            workerReportsObserved.push(qg);
            if (qg?.shouldSupplement) {
              await call('start_work', {
                instruction: '补齐自动化测试并核实通过结果',
                profile: 'review',
                sourceTaskId: String(event.taskId),
                cwd: home,
              });
              return '好的老板，任务已下发。';
            }
            return `最终交付：${String(event.report ?? '')}`;
          }
          return 'ok';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    await coordinator.configureModels({
      providerId: 'google',
      apiKey: 'sk-goog-test',
      workerProvider: 'google',
    });
    await coordinator.configureModels({
      providerId: 'deepseek',
      apiKey: 'sk-ds-test',
      selectedModels: ['deepseek-flash'],
      decisionApiKey: 'jev-test-key',
      decisionBaseUrl: mock.baseUrl,
    });

    const chatRes = coordinator.chat('req-jev-1', '帮我修复并发竞态并验证');
    await until(() => {
      const tasks = coordinator.store.list();
      return tasks.length === 2 && tasks.every(t => t.status === 'completed');
    });

    // 1. Router CHAT payload no longer includes model selection tables
    assert.equal(chatPayloads.length, 1);
    assert.equal('availableWorkerModels' in chatPayloads[0]!, false);
    assert.equal('modelTiers' in chatPayloads[0]!, false);

    // 2. Gemini Decision 1 request headers, model name, and model@thinkingLevel candidates
    const routeReqs = mock.requests.filter(r => Boolean(r.questions.route));
    assert.equal(routeReqs.length, 2);
    assert.equal(routeReqs[0]!.apiKey, 'jev-test-key');
    assert.equal(routeReqs[0]!.model, 'gemini-decision-1');
    const criteria = routeReqs[0]!.questions.route!.criteria as Record<string, string>;
    const optionKeys = Object.keys(criteria);
    assert.ok(optionKeys.some(k => k.startsWith('deepseek/deepseek-flash@off')));
    assert.ok(optionKeys.some(k => k.startsWith('deepseek/deepseek-flash@max')));
    assert.ok(optionKeys.some(k => k.startsWith('google/')));

    // 3. Worker received the exact model and native thinkingLevel chosen by Jev
    const atIdx = chosenRouteKey.lastIndexOf('@');
    const chosenSpec = chosenRouteKey.slice(0, atIdx);
    const chosenLevel = chosenRouteKey.slice(atIdx + 1);
    assert.equal(workerInvocations.length, 2);
    assert.equal(workerInvocations[1]!.model, chosenSpec);
    assert.equal(workerInvocations[1]!.thinkingLevel, chosenLevel);

    // 4. Quality Gate triggered supplement on low score, accepted on high score
    assert.equal(workerReportsObserved.length, 2);
    assert.equal(workerReportsObserved[0]?.shouldSupplement, true);
    assert.equal(workerReportsObserved[0]?.missingAspect, 'missing_verification');
    assert.equal(workerReportsObserved[0]?.source, 'gemini-decision-1');
    assert.equal(workerReportsObserved[1]?.shouldSupplement, false);
    assert.equal(workerReportsObserved[1]?.score, 2.8);

    // 5. Trace spans and View expose Jev route + qualityGate metadata
    const view = coordinator.view();
    assert.equal(view.works.length, 2);
    assert.ok(view.works.every(w => w.decisionSource === 'gemini-decision-1'));
    assert.equal(view.works.find(w => w.prompt.includes('补齐自动化测试'))?.qualityGate?.score, 2.8);

    const traceEvents = coordinator.store.conversation.trace({ messageId: chatRes.id });
    assert.ok(traceEvents.some(e => e.actor === 'system' && e.label === 'Gemini Decision 1 选模定级'));
    assert.ok(traceEvents.some(e => e.actor === 'system' && e.label === 'Gemini Decision 1 完成度评估'));

    // 6. Model pool stats reflect avgQualityScore feedback
    const hubView = await coordinator.modelHub.getView();
    assert.equal(hubView.decisionEngine?.configured, true);
    assert.equal(hubView.decisionEngine?.credentialSource, 'decision_config');
    const chosenPoolEntry = hubView.modelPool?.find(m => m.spec === chosenSpec);
    assert.ok(chosenPoolEntry?.avgQualityScore !== undefined, 'avgQualityScore updated after quality-gated completions');
    assert.ok(chosenPoolEntry!.avgQualityScore! > 1.0 && chosenPoolEntry!.avgQualityScore! < 2.8);
  } finally {
    await coordinator.close();
    await mock.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Gemini Decision 1: single-model multiple native thinkingLevels selection', async () => {
  const mock = await withMockDecisionServer(req => {
    if (req.questions.route) {
      const keys = Object.keys((req.questions.route.criteria as Record<string, string>) ?? {});
      const maxKey = keys.find(k => k.endsWith('@max')) ?? keys[0]!;
      return {
        body: {
          answers: { route: { type: 'choice', choice: maxKey, confidence: 0.94 } },
        },
      };
    }
    return {
      body: {
        answers: {
          completion: { type: 'score', score: 2.9, confidence: 0.95 },
          should_supplement: { type: 'noul', noul: 0.05, confidence: 0.95 },
          missing_aspect: { type: 'choice', choice: 'none', confidence: 0.95 },
        },
      },
    };
  });

  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-jev-single-'));
  let seenLevel: ThinkingLevel | undefined;
  let seenModel: string | undefined;

  const factory: AgentFactory = {
    mode: 'offline',
    nativeTools: true,
    async create(role, _id, tools, options) {
      return {
        close() {},
        async prompt(text) {
          const event = JSON.parse(text) as Record<string, unknown>;
          if (role === 'worker') {
            seenLevel = options?.thinkingLevel;
            seenModel = options?.model;
            return '详细完成';
          }
          if (event.kind === 'CHAT') {
            await tools.find(t => t.name === 'start_work')!.execute(JSON.stringify({ instruction: '深度分析状态机边界', cwd: home }));
            return '已安排';
          }
          return '交付结果';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    await coordinator.configureModels({
      providerId: 'deepseek',
      apiKey: 'sk-ds-single',
      workerProvider: 'deepseek',
      fastModel: 'deepseek-flash',
      balancedModel: 'deepseek-flash',
      strongModel: 'deepseek-flash',
      decisionApiKey: 'jev-single-key',
      decisionBaseUrl: mock.baseUrl,
    });
    const hub = await coordinator.modelHub.getView();
    assert.equal(hub.modelPool?.length, 1);
    assert.ok((hub.modelPool?.[0]?.thinkingLevels.length ?? 0) >= 3);

    coordinator.chat('req-jev-single', '分析状态机边界');
    await until(() => coordinator.store.list().length === 1 && coordinator.store.list()[0]!.status === 'completed');

    const routeReq = mock.requests.find(r => Boolean(r.questions.route))!;
    const keys = Object.keys((routeReq.questions.route!.criteria as Record<string, string>) ?? {});
    assert.deepEqual(keys, [
      'deepseek/deepseek-flash@off',
      'deepseek/deepseek-flash@low',
      'deepseek/deepseek-flash@high',
      'deepseek/deepseek-flash@max',
    ]);
    assert.equal(seenModel, 'deepseek-flash');
    assert.equal(seenLevel, 'max');
  } finally {
    await coordinator.close();
    await mock.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Gemini Decision 1: excludes failed model on WORKER_FAILED retry & falls back to heuristic on HTTP 500', async () => {
  let failDecisions = false;
  const mock = await withMockDecisionServer(req => {
    if (failDecisions) {
      return { status: 500, body: { error: { message: 'Injected 500 error' } } };
    }
    if (req.questions.route) {
      const keys = Object.keys((req.questions.route.criteria as Record<string, string>) ?? {});
      const googleFirst = keys.find(k => k.startsWith('google/')) ?? keys[0]!;
      return {
        body: {
          answers: { route: { type: 'choice', choice: googleFirst, confidence: 0.9 } },
        },
      };
    }
    return {
      body: {
        answers: {
          completion: { type: 'score', score: 2.7, confidence: 0.9 },
          should_supplement: { type: 'noul', noul: 0.1, confidence: 0.9 },
          missing_aspect: { type: 'choice', choice: 'none', confidence: 0.9 },
        },
      },
    };
  });

  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-jev-fallback-'));
  let workerAttempts = 0;

  const factory: AgentFactory = {
    mode: 'offline',
    nativeTools: true,
    async create(role, _id, tools, options) {
      return {
        close() {},
        async prompt(text) {
          const event = JSON.parse(text) as Record<string, unknown>;
          if (role === 'worker') {
            workerAttempts++;
            if (workerAttempts === 1 && options?.model?.startsWith('google/')) {
              throw new Error('503 google upstream unavailable');
            }
            return '降级切换后顺利完成';
          }
          const call = async (name: string, args: unknown) =>
            JSON.parse(await tools.find(t => t.name === name)!.execute(JSON.stringify(args)));
          if (event.kind === 'CHAT') {
            await call('start_work', { instruction: '排查构建日志问题', cwd: home });
            return '好的，已安排。';
          }
          if (event.kind === 'WORKER_FAILED') {
            await call('start_work', { instruction: '换模型重试排查构建日志问题', cwd: home });
            return '好的，已切换重试。';
          }
          if (event.kind === 'WORKER_REPORT') {
            return `已交付：${String(event.report ?? '')}`;
          }
          return 'ok';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    await coordinator.configureModels({
      providerId: 'google',
      apiKey: 'sk-goog-fb',
      workerProvider: 'google',
    });
    await coordinator.configureModels({
      providerId: 'deepseek',
      apiKey: 'sk-ds-fb',
      selectedModels: ['deepseek-flash'],
      decisionApiKey: 'jev-fb-key',
      decisionBaseUrl: mock.baseUrl,
    });

    // Scenario A: first attempt on google/* fails -> retry excludes google/gemini-* from route candidates
    coordinator.chat('req-jev-retry', '帮我排查构建问题');
    await until(() => {
      const tasks = coordinator.store.list();
      return tasks.length === 2 && tasks[0]!.status === 'failed' && tasks[1]!.status === 'completed';
    });

    const routeReqs = mock.requests.filter(r => Boolean(r.questions.route));
    assert.equal(routeReqs.length, 2);
    const failedSpec = coordinator.store.list()[0]!.workerModel!;
    const retryKeys = Object.keys((routeReqs[1]!.questions.route!.criteria as Record<string, string>) ?? {});
    assert.equal(retryKeys.some(k => k.startsWith(`${failedSpec}@`)), false, 'failed model spec is excluded from retry candidates');
    assert.ok(retryKeys.some(k => k.startsWith('deepseek/deepseek-flash@')));

    // Scenario B: HTTP 500 from decision endpoint falls back seamlessly to heuristic
    failDecisions = true;
    coordinator.chat('req-jev-500', '再查一下测试覆盖率');
    await until(() => {
      const tasks = coordinator.store.list();
      return tasks.length === 3 && tasks[2]!.status === 'completed';
    });
    const fallbackTask = coordinator.store.list()[2]!;
    assert.equal(fallbackTask.decisionSource, 'heuristic');
    assert.equal(fallbackTask.qualityGate?.source, 'heuristic');
  } finally {
    await coordinator.close();
    await mock.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Gemini Decision 1: piggybacks needs_quality_gate on route request to skip trivial second call, but wakes up on anomaly', async () => {
  const mock = await withMockDecisionServer(req => {
    if (req.questions.route) {
      const keys = Object.keys((req.questions.route.criteria as Record<string, string>) ?? {});
      const deepseekLow = keys.find(k => k === 'deepseek/deepseek-flash@low') ?? keys[0]!;
      return {
        body: {
          answers: {
            route: { type: 'choice', choice: deepseekLow, confidence: 0.95 },
            needs_quality_gate: { type: 'noul', noul: 0.12, confidence: 0.91 },
          },
          usage: { total_input_tokens: 140, total_output_tokens: 0, total_tokens: 140 },
        },
      };
    }
    return {
      body: {
        answers: {
          completion: { type: 'score', score: 0.8, confidence: 0.9 },
          should_supplement: { type: 'noul', noul: 0.9, confidence: 0.92 },
          missing_aspect: { type: 'choice', choice: 'incomplete_requirements', confidence: 0.89 },
        },
        usage: { total_input_tokens: 200, total_output_tokens: 0, total_tokens: 200 },
      },
    };
  });

  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-jev-skip-'));
  let workerRun = 0;
  const reportGates: Array<QualityGateAssessment | undefined> = [];

  const factory: AgentFactory = {
    mode: 'offline',
    nativeTools: true,
    async create(role, _id, tools) {
      return {
        close() {},
        async prompt(text) {
          const event = JSON.parse(text) as Record<string, unknown>;
          if (role === 'worker') {
            workerRun++;
            if (workerRun === 1) return '服务运行正常，当前零报错日志。';
            return '?';
          }
          if (event.kind === 'CHAT') {
            await tools.find(t => t.name === 'start_work')!.execute(JSON.stringify({
              instruction: String((event.message as { text: string }).text),
              cwd: home,
            }));
            return '已处理。';
          }
          if (event.kind === 'WORKER_REPORT') {
            reportGates.push(event.qualityGate as QualityGateAssessment | undefined);
            return `结果：${String(event.report ?? '')}`;
          }
          return 'ok';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    await coordinator.configureModels({
      providerId: 'google',
      apiKey: 'sk-goog-skip',
      workerProvider: 'google',
    });
    await coordinator.configureModels({
      providerId: 'deepseek',
      apiKey: 'sk-ds-skip',
      selectedModels: ['deepseek-flash'],
      decisionApiKey: 'jev-skip-key',
      decisionBaseUrl: mock.baseUrl,
    });

    // 1. Trivial status check: route returns needs_quality_gate=false (prob=0.12) and normal report -> skips 2nd HTTP call
    const msg1 = coordinator.chat('req-skip-1', '查看当前服务状态');
    await until(() => coordinator.store.list().length === 1 && coordinator.store.list()[0]!.status === 'completed');

    assert.equal(mock.requests.length, 1, 'only 1 Gemini Decision request sent for trivial task');
    assert.equal(mock.requests[0]!.questions.needs_quality_gate?.type, 'noul');
    const task1 = coordinator.store.list()[0]!;
    assert.equal(task1.skipQualityGate, true);
    assert.equal(task1.qualityGate?.skippedByRoute, true);
    assert.equal(reportGates[0]?.skippedByRoute, true);

    const trace1 = coordinator.store.conversation.trace({ messageId: msg1.id });
    assert.equal(trace1.some(e => e.label === 'Gemini Decision 1 完成度评估'), false);

    const hubAfterSkip = await coordinator.modelHub.getView();
    const dsEntryAfterSkip = hubAfterSkip.modelPool?.find(m => m.spec === 'deepseek/deepseek-flash');
    assert.equal(dsEntryAfterSkip?.successCount, 1);
    assert.equal(dsEntryAfterSkip?.avgQualityScore, undefined, 'skipped trivial task does not inflate avgQualityScore');

    // 2. Anomaly wakeup: route still predicts trivial (0.12), but Worker returns "?" -> wakes up 2nd Jev call
    const msg2 = coordinator.chat('req-skip-2', '列出核心配置');
    await until(() => coordinator.store.list().length === 2 && coordinator.store.list()[1]!.status === 'completed');

    assert.equal(mock.requests.length, 3, 'anomalous empty-like report wakes up a 2nd completion evaluation call');
    assert.ok(mock.requests[1]!.questions.route);
    assert.ok(mock.requests[2]!.questions.completion);
    assert.ok(mock.requests[2]!.questions.should_supplement);
    assert.ok(mock.requests[2]!.questions.missing_aspect);
    assert.equal(reportGates[1]?.source, 'gemini-decision-1');
    assert.equal(reportGates[1]?.shouldSupplement, true);
    assert.equal(reportGates[1]?.missingAspect, 'incomplete_requirements');

    const trace2 = coordinator.store.conversation.trace({ messageId: msg2.id });
    assert.ok(trace2.some(e => e.actor === 'system' && e.label === 'Gemini Decision 1 完成度评估'));
  } finally {
    await coordinator.close();
    await mock.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Gemini Decision 1: isolates pre-Jev history via epoch migration, tags gemini coding specialty, and protects small samples (<3)', async () => {
  const mock = await withMockDecisionServer(req => {
    if (req.questions.route) {
      const keys = Object.keys((req.questions.route.criteria as Record<string, string>) ?? {});
      const geminiHigh = keys.find(k => k.startsWith('google/gemini-4-argon@high'))
        ?? keys.find(k => k.startsWith('google/gemini-4-argon@'))
        ?? keys[0]!;
      return {
        body: {
          answers: {
            route: { type: 'choice', choice: geminiHigh, confidence: 0.92 },
            needs_quality_gate: { type: 'noul', noul: 0.85, confidence: 0.9 },
          },
        },
      };
    }
    return {
      body: {
        answers: {
          completion: { type: 'score', score: 2.85, confidence: 0.94 },
          should_supplement: { type: 'noul', noul: 0.05, confidence: 0.94 },
          missing_aspect: { type: 'choice', choice: 'none', confidence: 0.95 },
        },
      },
    };
  });

  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-jev-era-'));
  try {
    // Seed pre-Jev Store tasks (no decisionSource) + 1 Jev-era completed task, and polluted pre-epoch model-hub.json
    const seedStore = new Store(home);
    const now = Date.now();
    seedStore.create({
      id: 'legacy-sol-ok',
      requestId: 'req-legacy-sol-ok',
      fingerprint: 'fp-1',
      prompt: 'legacy task ok',
      files: [],
      limitMs: 600_000,
      activeMs: 25_000,
      status: 'completed',
      revision: 1,
      mode: 'offline',
      createdAt: now - 100_000,
      workerModel: 'openai/gpt-6.1-sol',
    });
    seedStore.create({
      id: 'legacy-argon-fail-1',
      requestId: 'req-legacy-argon-1',
      fingerprint: 'fp-2',
      prompt: 'legacy argon fail 1',
      files: [],
      limitMs: 600_000,
      activeMs: 4,
      status: 'failed',
      revision: 1,
      mode: 'offline',
      createdAt: now - 90_000,
      workerModel: 'google/gemini-4-argon',
      reason: '模型或执行器请求失败：Cannot find module old-path',
    });
    seedStore.create({
      id: 'legacy-argon-fail-2',
      requestId: 'req-legacy-argon-2',
      fingerprint: 'fp-3',
      prompt: 'legacy argon fail 2',
      files: [],
      limitMs: 600_000,
      activeMs: 4,
      status: 'failed',
      revision: 1,
      mode: 'offline',
      createdAt: now - 80_000,
      workerModel: 'google/gemini-4-argon',
      reason: '模型或执行器请求失败：Cannot find module old-path',
    });
    seedStore.create({
      id: 'jev-argon-ok-1',
      requestId: 'req-jev-argon-1',
      fingerprint: 'fp-4',
      prompt: 'jev-era argon ok',
      files: [],
      limitMs: 600_000,
      activeMs: 30_000,
      status: 'completed',
      revision: 1,
      mode: 'offline',
      createdAt: now - 10_000,
      workerModel: 'google/gemini-4-argon',
      thinkingLevel: 'high',
      decisionSource: 'gemini-decision-1',
      qualityGate: {
        score: 2.85,
        maxScore: 3,
        confidence: 0.9,
        shouldSupplement: false,
        source: 'gemini-decision-1',
        evaluatedAt: now - 9_000,
      },
    });
    seedStore.close();

    await mkdir(join(home, 'sdk'), { recursive: true });
    await writeFile(join(home, 'sdk', 'model-hub.json'), JSON.stringify({
      workerProvider: 'openai',
      routerProvider: 'openai',
      providers: {
        openai: {
          apiKey: 'sk-openai-era',
          selectedModels: ['gpt-6.1-sol'],
        },
        google: {
          apiKey: 'sk-google-era',
          selectedModels: ['gemini-4-argon', 'gemini-3.8-flash'],
        },
      },
      modelStats: {
        'openai/gpt-6.1-sol': { successCount: 12, failCount: 0, lastLatencyMs: 20000, updatedAt: now - 100_000 },
        'google/gemini-4-argon': { successCount: 0, failCount: 2, lastLatencyMs: 4, updatedAt: now - 80_000 },
      },
      decision: {
        enabled: true,
        apiKey: 'jev-era-key',
        baseUrl: mock.baseUrl,
      },
    }), 'utf8');

    const factory: AgentFactory = {
      mode: 'offline',
      nativeTools: true,
      async create(role, _id, tools) {
        return {
          close() {},
          async prompt(text) {
            const event = JSON.parse(text) as Record<string, unknown>;
            if (role === 'worker') return '已完成代码重构并通过验证';
            if (event.kind === 'CHAT') {
              await tools.find(t => t.name === 'start_work')!.execute(JSON.stringify({
                instruction: String((event.message as { text: string }).text),
                profile: 'coding',
                cwd: home,
              }));
              return '已安排';
            }
            return `完成：${String(event.report ?? '')}`;
          },
        };
      },
    };

    const coordinator = new Coordinator(home, factory);
    try {
      await coordinator.ready();

      const hubAfterInit = await coordinator.modelHub.getView();
      const solEntry = hubAfterInit.modelPool?.find(m => m.spec === 'openai/gpt-6.1-sol');
      const argonEntry = hubAfterInit.modelPool?.find(m => m.spec === 'google/gemini-4-argon');
      const flashEntry = hubAfterInit.modelPool?.find(m => m.spec === 'google/gemini-3.8-flash');

      // Legacy 12 successes on gpt-6.1-sol and 2 legacy failures on gemini-4-argon are purged;
      // only the 1 Jev-era success on gemini-4-argon remains.
      assert.equal(solEntry?.successCount, undefined);
      assert.equal(solEntry?.failCount, undefined);
      assert.equal(argonEntry?.successCount, 1);
      assert.equal(argonEntry?.failCount, 0);
      assert.equal(argonEntry?.avgQualityScore, 2.85);
      assert.ok(argonEntry?.specialties.includes('代码工程'), 'gemini-4-argon receives 代码工程 specialty');
      assert.ok(flashEntry?.specialties.includes('代码工程'), 'gemini-3.8-flash receives 代码工程 specialty');

      // Dispatch 1 (argon total Jev samples = 1 -> 2): < 3 samples, no `; stats:` shown; legacy google failures do NOT trip circuit breaker
      coordinator.chat('req-era-1', '重构第一批模块');
      await until(() => coordinator.store.list().some(t => t.prompt.includes('重构第一批模块') && t.status === 'completed'));

      // Dispatch 2 (argon total Jev samples = 2 -> 3): still < 3 when deciding route
      coordinator.chat('req-era-2', '重构第二批模块');
      await until(() => coordinator.store.list().some(t => t.prompt.includes('重构第二批模块') && t.status === 'completed'));

      // Dispatch 3 (argon total Jev samples = 3): now >= 3, route criteria MUST show avgQuality & ok=3/fail=0
      coordinator.chat('req-era-3', '重构第三批模块');
      await until(() => coordinator.store.list().some(t => t.prompt.includes('重构第三批模块') && t.status === 'completed'));

      const routeReqs = mock.requests.filter(r => Boolean(r.questions.route));
      assert.equal(routeReqs.length, 3);

      const criteria1 = routeReqs[0]!.questions.route!.criteria as Record<string, string>;
      const argonDesc1 = criteria1['google/gemini-4-argon@high']!;
      assert.ok(argonDesc1.includes('代码工程'));
      assert.equal(argonDesc1.includes('stats:'), false, 'samples < 3 must not expose stats to Jev');

      const criteria3 = routeReqs[2]!.questions.route!.criteria as Record<string, string>;
      const argonDesc3 = criteria3['google/gemini-4-argon@high']!;
      assert.ok(argonDesc3.includes('stats: avgQuality=2.85/3, ok=3/fail=0'), 'samples >= 3 exposes reliable stats without activeMs latency noise');
      assert.equal(argonDesc3.includes('latency='), false);
    } finally {
      await coordinator.close();
    }
  } finally {
    await mock.close();
    await rm(home, { recursive: true, force: true });
  }
});

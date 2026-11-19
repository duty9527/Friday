import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentFactory } from '../src/agent.js';
import { Coordinator } from '../src/coordinator.js';
import { privateHome } from '../src/files.js';
import { createRouterTools, type RouterToolsHost } from '../src/orchestrator/router-tools.js';
import { MAX_ENABLED_TIMERS, TimerScheduler } from '../src/orchestrator/timer-scheduler.js';
import { serve } from '../src/server.js';
import { Store } from '../src/store.js';
import { startWeb } from '../src/web-server.js';
import { until } from './helpers/async.js';

async function installScriptedPlugin(home: string, pluginName: string, mode: 'fatigue' | 'goal'): Promise<string> {
  const dir = join(home, 'plugins', pluginName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify(
      {
        name: pluginName,
        title: pluginName,
        description: 'test scripted plugin',
        entry: 'index.mjs',
        actions: ['check'],
      },
      null,
      2,
    ),
    'utf8',
  );
  const scriptBody = mode === 'fatigue'
    ? `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.env.PLUGIN_DATA_DIR;
const statePath = join(dataDir, 'script.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const outcome = state.outcomes.shift() ?? 'ok';
writeFileSync(statePath, JSON.stringify(state));
if (outcome === 'fail') {
  console.log(JSON.stringify({ ok: false, notify: true, message: '模拟探针连接超时' }));
} else {
  console.log(JSON.stringify({ ok: true, notify: false, message: '探针恢复正常', data: { healthy: true } }));
}
`
    : `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dataDir = process.env.PLUGIN_DATA_DIR;
const statePath = join(dataDir, 'script.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const count = (state.calls ?? 0) + 1;
state.calls = count;
writeFileSync(statePath, JSON.stringify(state));
if (count >= (state.meetOnCall ?? 2)) {
  console.log(JSON.stringify({ ok: true, notify: false, message: 'CI 检查已通过', data: { goalMet: true, goalSummary: '38/38 检查全部变绿' } }));
} else {
  console.log(JSON.stringify({ ok: true, notify: false, message: '仍在构建中', data: { goalMet: false } }));
}
`;
  await writeFile(join(dir, 'index.mjs'), scriptBody.trimStart(), 'utf8');
  return dir;
}

test('Routines Fatigue Rule (plugin): first failure notifies, intermediate failures stay silent, maxFailures trips pause, and success/re-enable reset', { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'friday-fatigue-plugin-'));
  const home = await privateHome(join(root, 'home'));
  const dataDir = await installScriptedPlugin(home, 'fatigue-probe', 'fatigue');
  await writeFile(join(dataDir, 'script.json'), JSON.stringify({ outcomes: ['fail', 'fail', 'fail', 'fail'] }), 'utf8');

  const coordinator = new Coordinator(home, {
    mode: 'offline',
    async create() {
      return { async prompt() { return 'ok'; }, close() {} };
    },
  });

  try {
    await coordinator.ready();
    const timer = coordinator.addTimer('故障熔断探针', '检查上游服务', 60_000, root, { channel: 'local' }, {
      plugin: 'fatigue-probe',
      pluginAction: 'check',
      maxFailures: 4,
    });
    assert.equal(timer.maxFailures, 4);
    assert.equal(timer.consecutiveFailures, 0);

    // Trigger failure #1: notifies once
    coordinator.store.saveTimer({ ...coordinator.store.getTimer(timer.id), nextRunAt: Date.now() - 10 });
    await until(() => coordinator.store.getTimer(timer.id).consecutiveFailures === 1);
    const t1 = coordinator.store.getTimer(timer.id);
    assert.equal(t1.enabled, true);
    assert.equal(t1.firstFailureNotified, true);
    assert.equal(t1.lastRunStatus, 'error');
    assert.equal(t1.lastError, '模拟探针连接超时');
    assert.equal(coordinator.store.conversation.allMessages().filter(m => m.role === 'assistant').length, 1);

    // Trigger failure #2 & #3: silent accumulation (no additional assistant message)
    coordinator.store.saveTimer({ ...coordinator.store.getTimer(timer.id), nextRunAt: Date.now() - 10 });
    await until(() => coordinator.store.getTimer(timer.id).consecutiveFailures === 2);
    coordinator.store.saveTimer({ ...coordinator.store.getTimer(timer.id), nextRunAt: Date.now() - 10 });
    await until(() => coordinator.store.getTimer(timer.id).consecutiveFailures === 3);
    assert.equal(coordinator.store.conversation.allMessages().filter(m => m.role === 'assistant').length, 1);
    assert.equal(coordinator.store.getTimer(timer.id).enabled, true);

    // Trigger failure #4: trips maxFailures=4 shutdown + final message
    coordinator.store.saveTimer({ ...coordinator.store.getTimer(timer.id), nextRunAt: Date.now() - 10 });
    await until(() => coordinator.store.getTimer(timer.id).fatiguePaused === true);
    const t4 = coordinator.store.getTimer(timer.id);
    assert.equal(t4.enabled, false);
    assert.equal(t4.consecutiveFailures, 4);
    assert.equal(t4.lastRunStatus, 'fatigue_paused');
    const assistantsAfterTrip = coordinator.store.conversation.allMessages().filter(m => m.role === 'assistant');
    assert.equal(assistantsAfterTrip.length, 2);
    assert.match(assistantsAfterTrip[1]!.text, /疲劳熔断|自动暂停/);

    // Manual re-enable clears fatigue counters
    const reenabled = coordinator.toggleTimer(timer.id, true);
    assert.equal(reenabled.enabled, true);
    assert.equal(reenabled.fatiguePaused, false);
    assert.equal(reenabled.consecutiveFailures, 0);
    assert.equal(reenabled.firstFailureNotified, false);
    assert.equal(reenabled.lastError, undefined);

    // Single success resets failure streak before reaching threshold
    await writeFile(join(dataDir, 'script.json'), JSON.stringify({ outcomes: ['fail', 'ok'] }), 'utf8');
    coordinator.store.saveTimer({ ...coordinator.store.getTimer(timer.id), nextRunAt: Date.now() - 10 });
    await until(() => coordinator.store.getTimer(timer.id).consecutiveFailures === 1);
    coordinator.store.saveTimer({ ...coordinator.store.getTimer(timer.id), nextRunAt: Date.now() - 10 });
    await until(() => coordinator.store.getTimer(timer.id).lastRunStatus === 'ok');
    const recovered = coordinator.store.getTimer(timer.id);
    assert.equal(recovered.consecutiveFailures, 0);
    assert.equal(recovered.firstFailureNotified, false);
    assert.equal(recovered.lastError, undefined);
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Routines Fatigue Rule (Worker) & initiator provenance: silent intermediate failure + WorkView metadata', { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'friday-fatigue-worker-'));
  const home = await privateHome(join(root, 'home'));
  let routerFailureReports = 0;

  const factory: AgentFactory = {
    mode: 'offline',
    async create(role) {
      return {
        async prompt(input) {
          if (role === 'router') {
            const ev = JSON.parse(input) as { kind?: string };
            if (ev.kind === 'WORKER_FAILED') {
              routerFailureReports++;
              return '首次失败告警：上游接口不可达。';
            }
            return 'ok';
          }
          throw new Error('fatal worker execution failure');
        },
        close() {},
      };
    },
  };

  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    const timer = coordinator.addTimer('核心巡检 Worker', '检测主链路可用性', 60_000, root, { channel: 'local' }, {
      maxFailures: 3,
    });

    // Run #1 fails -> first failure routed via Router
    coordinator.store.saveTimer({ ...coordinator.store.getTimer(timer.id), nextRunAt: Date.now() - 10 });
    await until(() => coordinator.store.getTimer(timer.id).consecutiveFailures === 1);
    assert.equal(routerFailureReports, 1);
    const assistantAfter1 = coordinator.store.conversation.allMessages().filter(m => m.role === 'assistant');
    assert.equal(assistantAfter1.length, 1);

    // Check Task + WorkView initiator provenance
    const firstTask = coordinator.store.list().find(t => t.timerId === timer.id);
    assert.ok(firstTask);
    assert.deepEqual(firstTask.initiator, { kind: 'timer', id: timer.id, label: '核心巡检 Worker' });
    const viewWork = coordinator.view().works.find(w => w.id === firstTask.id);
    assert.ok(viewWork);
    assert.deepEqual(viewWork.initiator, { kind: 'timer', id: timer.id, label: '核心巡检 Worker' });
    assert.equal(viewWork.timerId, timer.id);

    // Run #2 fails silently -> Router WORKER_FAILED is skipped & no new assistant message emitted
    coordinator.store.saveTimer({ ...coordinator.store.getTimer(timer.id), nextRunAt: Date.now() - 10 });
    await until(() => coordinator.store.getTimer(timer.id).consecutiveFailures === 2);
    assert.equal(routerFailureReports, 1);
    assert.equal(coordinator.store.conversation.allMessages().filter(m => m.role === 'assistant').length, 1);

    // Run #3 hits maxFailures=3 -> fatigue pause + shutdown notification
    coordinator.store.saveTimer({ ...coordinator.store.getTimer(timer.id), nextRunAt: Date.now() - 10 });
    await until(() => coordinator.store.getTimer(timer.id).fatiguePaused === true);
    const tripped = coordinator.store.getTimer(timer.id);
    assert.equal(tripped.enabled, false);
    assert.equal(tripped.lastRunStatus, 'fatigue_paused');
    const finalAssistants = coordinator.store.conversation.allMessages().filter(m => m.role === 'assistant');
    assert.ok(finalAssistants.some(m => /疲劳熔断/.test(m.text)));
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Routines Goal Condition: plugin goalMet, [[GOAL_MET]] marker stripping & auto-stop, and non-goal guards', { timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'friday-goal-paths-'));
  const home = await privateHome(join(root, 'home'));
  const dataDir = await installScriptedPlugin(home, 'goal-probe', 'goal');
  await writeFile(join(dataDir, 'script.json'), JSON.stringify({ calls: 0, meetOnCall: 2 }), 'utf8');

  let seenTimerGoalPayload: unknown;
  const factory: AgentFactory = {
    mode: 'offline',
    async create(role, _id, tools) {
      let readDone = false;
      return {
        async prompt(input) {
          if (role === 'router') {
            const ev = JSON.parse(input) as { kind?: string; report?: string; timerGoal?: unknown };
            if (ev.kind === 'WORKER_REPORT') {
              if (ev.timerGoal) seenTimerGoalPayload = ev.timerGoal;
              if (ev.report?.includes('PR_MERGED')) {
                return '已完成核实，PR 已合入主分支。\n[[GOAL_MET: PR #42 已顺利合并]]';
              }
              return '常规巡检完成 [[GOAL_MET: 误报]]';
            }
            return 'ok';
          }
          if (!readDone && tools[0]) {
            readDone = true;
            await tools[0].execute('f0').catch(() => {});
          }
          if (input.includes('PR_TARGET')) {
            return 'PR_MERGED [[GOAL_MET: Worker 确认合并]]';
          }
          return 'ROUTINE_OK [[GOAL_MET: 误报]]';
        },
        close() {},
      };
    },
  };

  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();

    // Mutually exclusive: once + goalCondition rejected
    assert.throws(
      () => coordinator.addTimer('conflict', 'noop', 60_000, root, undefined, { once: true, goalCondition: '不可能同时成立' }),
      /不可同时设置/,
    );

    // Path 1: plugin returns goalMet on 2nd call even with notify:false
    const pluginGoalTimer = coordinator.addTimer('插件终态跟进', '等待 CI 变绿', 60_000, root, { channel: 'local' }, {
      plugin: 'goal-probe',
      pluginAction: 'check',
      goalCondition: 'CI 检查全部通过',
    });
    coordinator.store.saveTimer({ ...coordinator.store.getTimer(pluginGoalTimer.id), nextRunAt: Date.now() - 10 });
    await until(() => coordinator.store.getTimer(pluginGoalTimer.id).lastRunStatus === 'ok');
    assert.equal(coordinator.store.getTimer(pluginGoalTimer.id).enabled, true);

    coordinator.store.saveTimer({ ...coordinator.store.getTimer(pluginGoalTimer.id), nextRunAt: Date.now() - 10 });
    await until(() => coordinator.store.getTimer(pluginGoalTimer.id).lastRunStatus === 'goal_met');
    const finishedPluginGoal = coordinator.store.getTimer(pluginGoalTimer.id);
    assert.equal(finishedPluginGoal.enabled, false);
    assert.ok(finishedPluginGoal.goalMetAt);
    assert.equal(finishedPluginGoal.goalSummary, '38/38 检查全部变绿');
    assert.ok(coordinator.store.conversation.allMessages().some(m => m.role === 'assistant' && m.text.includes('定时目标已达成')));

    // Path 2: Worker/Router [[GOAL_MET]] stops goalCondition timer & strips markers from report and reply
    const workerGoalTimer = coordinator.addTimer('Worker终态跟进', 'PR_TARGET 状态核查', 60_000, root, { channel: 'local' }, {
      goalCondition: 'PR 已合入主分支',
    });
    coordinator.store.saveTimer({ ...coordinator.store.getTimer(workerGoalTimer.id), nextRunAt: Date.now() - 10 });
    await until(() => coordinator.store.getTimer(workerGoalTimer.id).lastRunStatus === 'goal_met');
    const finishedWorkerGoal = coordinator.store.getTimer(workerGoalTimer.id);
    assert.equal(finishedWorkerGoal.enabled, false);
    assert.equal(finishedWorkerGoal.goalSummary, 'PR #42 已顺利合并');
    assert.ok(seenTimerGoalPayload && typeof seenTimerGoalPayload === 'object');
    const goalTask = coordinator.store.list().find(t => t.timerId === workerGoalTimer.id)!;
    assert.ok(goalTask.report && !goalTask.report.includes('GOAL_MET'));
    const goalReply = coordinator.store.conversation.allMessages().find(m => m.role === 'assistant' && m.text.includes('PR 已合入主分支'));
    assert.ok(goalReply && !goalReply.text.includes('GOAL_MET'));

    // Guard 3: Recurring timer WITHOUT goalCondition rejects completeTimer and ignores [[GOAL_MET]] auto-stop while stripping stray markers
    const plainTimer = coordinator.addTimer('无终态普通巡检', 'CHECK_ROUTINE', 60_000, root, { channel: 'local' });
    assert.throws(() => coordinator.completeTimer(plainTimer.id), /终态目标/);
    coordinator.store.saveTimer({ ...coordinator.store.getTimer(plainTimer.id), nextRunAt: Date.now() - 10 });
    await until(() => coordinator.store.getTimer(plainTimer.id).lastRunAt !== undefined && coordinator.store.list().some(t => t.timerId === plainTimer.id && t.status === 'completed'));
    const plainAfter = coordinator.store.getTimer(plainTimer.id);
    assert.equal(plainAfter.enabled, true);
    assert.equal(plainAfter.goalMetAt, undefined);
    const plainTask = coordinator.store.list().find(t => t.timerId === plainTimer.id)!;
    assert.ok(plainTask.report && !plainTask.report.includes('GOAL_MET'));
    const plainReply = coordinator.store.conversation.allMessages().find(m => m.role === 'assistant' && m.text.includes('常规巡检完成'));
    assert.ok(plainReply && !plainReply.text.includes('GOAL_MET'));
  } finally {
    await coordinator.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Routines Guardrails & 20-timer cap: chat manage_timer validation, cap enforcement, and direct addTimer short intervals', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'friday-guardrails-'));
  const home = await privateHome(join(root, 'home'));
  const store = new Store(home);
  const controller = new AbortController();
  const jobs = new Set<Promise<void>>();
  const scheduler = new TimerScheduler({
    home,
    store,
    mode: 'offline',
    closingSignal: controller.signal,
    isClosing: () => false,
    jobs,
    submit: async () => { throw new Error('unused'); },
    notifyOutbound: () => {},
  });

  try {
    const userMsg = store.conversation.create({
      id: 'msg-1',
      role: 'user',
      origin: { channel: 'local' },
      sessionId: 'chat:test',
      text: '设置定时任务',
      status: 'completed',
      paths: [],
      mode: 'offline',
    });

    const host: RouterToolsHost = {
      home,
      store,
      im: {} as RouterToolsHost['im'],
      isClosing: () => false,
      getTurn: () => ({
        messageId: userMsg.id,
        chatContext: {
          message: userMsg,
          controller: new AbortController(),
          revisions: new Map(),
          deliveryOrigin: { channel: 'local' },
          firstAt: Date.now(),
          coalesceUntil: Date.now(),
          mergeVersion: 0,
        },
        callIndex: 0,
        reportTurnDispatched: false,
        reportTurnSentFile: false,
        reportTurnSavedMemory: false,
      }),
      hasInboundHold: () => false,
      runs: new Map(),
      reportAutoDispatches: { get: () => 0, increment: () => 1 } as unknown as RouterToolsHost['reportAutoDispatches'],
      concurrentTasksInCwd: () => [],
      newChatWork: async () => { throw new Error('unused'); },
      followup: () => { throw new Error('unused'); },
      stop: () => { throw new Error('unused'); },
      resume: () => { throw new Error('unused'); },
      addTimer: (name, instruction, intervalMs, cwd, origin, opts) =>
        scheduler.addTimer(name, instruction, intervalMs, cwd, origin, opts),
      toggleTimer: (id, enabled) => scheduler.toggleTimer(id, enabled),
      completeTimer: (id, summary) => scheduler.completeTimer(id, summary),
      removeTimer: id => scheduler.removeTimer(id),
      resolveChannelOrigin: () => undefined,
    };

    const manageTimerTool = createRouterTools(host, () => 'req-1').find(t => t.name === 'manage_timer')!;
    assert.ok(manageTimerTool);

    // Chat guardrails reject short once, short plugin, and short AI recurring intervals
    await assert.rejects(
      () => manageTimerTool.execute(JSON.stringify({ action: 'add', name: 'too-soon', delayMs: 2_000, instruction: 'ping' })),
      /不能短于 5 秒/,
    );
    await assert.rejects(
      () => manageTimerTool.execute(JSON.stringify({ action: 'add', name: 'fast-plugin', plugin: 'system-pulse', intervalMs: 10_000 })),
      /不能短于 1 分钟/,
    );
    await assert.rejects(
      () => manageTimerTool.execute(JSON.stringify({ action: 'add', name: 'fast-ai', intervalMs: 60_000, instruction: '巡检' })),
      /不能短于 5 分钟/,
    );

    // Valid thresholds succeed
    const onceRes = JSON.parse(await manageTimerTool.execute(JSON.stringify({ action: 'add', name: 'remind-ok', delayMs: 5_000, instruction: '喝水' }))) as { timer: { id: string; enabled: boolean } };
    assert.equal(onceRes.timer.enabled, true);

    const pluginRes = JSON.parse(await manageTimerTool.execute(JSON.stringify({ action: 'add', name: 'plugin-ok', plugin: 'system-pulse', intervalMs: 60_000 }))) as { timer: { id: string; enabled: boolean } };
    assert.equal(pluginRes.timer.enabled, true);

    const aiGoalRes = JSON.parse(await manageTimerTool.execute(JSON.stringify({
      action: 'add',
      name: 'ai-goal-ok',
      intervalMs: 300_000,
      instruction: '跟进部署状态',
      goalCondition: '服务状态健康',
    }))) as { timer: { id: string; enabled: boolean; goalCondition?: string } };
    assert.equal(aiGoalRes.timer.goalCondition, '服务状态健康');

    // manage_timer complete works for goal timer and rejects non-goal timer
    await assert.rejects(
      () => manageTimerTool.execute(JSON.stringify({ action: 'complete', id: pluginRes.timer.id })),
      /终态目标/,
    );
    const completedRes = JSON.parse(await manageTimerTool.execute(JSON.stringify({
      action: 'complete',
      id: aiGoalRes.timer.id,
      summary: '手工确认服务健康',
    }))) as { timer: { enabled: boolean; lastRunStatus: string; goalSummary: string } };
    assert.equal(completedRes.timer.enabled, false);
    assert.equal(completedRes.timer.lastRunStatus, 'goal_met');
    assert.equal(completedRes.timer.goalSummary, '手工确认服务健康');

    // Direct scheduler.addTimer without chat guardrails keeps supporting 500ms short interval (for tests/internal callers)
    const directShort = scheduler.addTimer('short-internal', 'ping', 500);
    assert.equal(directShort.intervalMs, 500);

    // Currently 3 enabled timers (onceRes, pluginRes, directShort); fill up to MAX_ENABLED_TIMERS (20)
    while (store.listTimers().filter(t => t.enabled).length < MAX_ENABLED_TIMERS) {
      scheduler.addTimer(`cap-${store.listTimers().length}`, 'noop', 300_000);
    }
    assert.throws(() => scheduler.addTimer('overflow', 'noop', 300_000), /已达上限（20 个）/);

    // Disable one, add 21st, then toggling the disabled one back on should throw cap error
    scheduler.toggleTimer(pluginRes.timer.id, false);
    const replacement = scheduler.addTimer('replacement', 'noop', 300_000);
    assert.equal(replacement.enabled, true);
    assert.throws(() => scheduler.toggleTimer(pluginRes.timer.id, true), /已达上限（20 个）/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Routines Web API (/api/timer-add, /api/timer-complete) and Strict CSP compliance', { timeout: 20_000 }, async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-web-routines-'));
  const daemon = await serve({ home, mode: 'offline', offlineDelayMs: 10 });
  const web = await startWeb({ home, port: 0 });
  try {
    const parsedUrl = new URL(web.url);
    const token = parsedUrl.hash.replace(/^#token=/, '');
    const headers = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      origin: parsedUrl.origin,
    };

    const addGoalRes = await fetch(`${parsedUrl.origin}/api/timer-add`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Web终态目标任务',
        intervalMs: 60_000,
        instruction: '检查发布状态',
        goalCondition: '发布状态变为 live',
        maxFailures: 3,
      }),
    });
    assert.equal(addGoalRes.status, 200);
    const goalTimer = await addGoalRes.json() as { id: string; goalCondition?: string; maxFailures?: number; enabled: boolean };
    assert.equal(goalTimer.goalCondition, '发布状态变为 live');
    assert.equal(goalTimer.maxFailures, 3);
    assert.equal(goalTimer.enabled, true);

    const completeRes = await fetch(`${parsedUrl.origin}/api/timer-complete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: goalTimer.id, summary: '灰度切流完成' }),
    });
    assert.equal(completeRes.status, 200);
    const completedTimer = await completeRes.json() as { enabled: boolean; lastRunStatus?: string; goalSummary?: string; goalMetAt?: number };
    assert.equal(completedTimer.enabled, false);
    assert.equal(completedTimer.lastRunStatus, 'goal_met');
    assert.equal(completedTimer.goalSummary, '灰度切流完成');
    assert.ok(completedTimer.goalMetAt);

    // Non-goal timer should fail /api/timer-complete
    const addPlainRes = await fetch(`${parsedUrl.origin}/api/timer-add`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'Web普通巡检', intervalMs: 60_000, instruction: '巡检' }),
    });
    const plainTimer = await addPlainRes.json() as { id: string };
    const rejectCompleteRes = await fetch(`${parsedUrl.origin}/api/timer-complete`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: plainTimer.id }),
    });
    assert.equal(rejectCompleteRes.ok, false);

    // Strict CSP check on modified web sources
    const indexHtml = await readFile(join(process.cwd(), 'src/web/index.html'), 'utf8');
    const hubTs = await readFile(join(process.cwd(), 'src/web/hubs/timer-plugin-hub.ts'), 'utf8');
    const traceTs = await readFile(join(process.cwd(), 'src/web/panels/trace.ts'), 'utf8');
    assert.equal(/style\s*=/i.test(indexHtml), false, 'index.html must contain zero inline style=');
    assert.equal(/\.style\./.test(hubTs) || /\.style\./.test(traceTs), false, 'TS modules must contain zero .style.');
    assert.equal(/\.innerHTML\b/.test(hubTs) || /\.innerHTML\b/.test(traceTs), false, 'TS modules must contain zero .innerHTML');
    assert.equal(/setAttribute\s*\(\s*['"]style['"]/.test(hubTs) || /setAttribute\s*\(\s*['"]style['"]/.test(traceTs), false, 'TS modules must not set inline style attributes');
  } finally {
    await web.close();
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});

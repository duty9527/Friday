import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../dist/coordinator.js';
import { offlineFactory, type AgentFactory } from '../dist/agent.js';
import { listPlugins, runPlugin } from '../dist/plugin.js';
import { Store } from '../dist/store.js';

async function until(predicate: () => boolean, attempts = 300, stepMs = 15) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await delay(stepMs);
  }
  throw new Error('Timed out waiting for condition');
}

test('1. Mid-flight ASK_BOSS suspends Worker in-place with zero activeMs burn, relays via IM, and resumes the SAME Worker session on Boss reply', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-ask-boss-'));
  let workerInstancesCreated = 0;
  const baseFactory = offlineFactory(15);
  const countingFactory: AgentFactory = {
    ...baseFactory,
    nativeTools: true,
    async create(role, id, tools, options) {
      if (role === 'worker') workerInstancesCreated++;
      return baseFactory.create(role, id, tools, options);
    },
  };
  const coordinator = new Coordinator(home, countingFactory);
  try {
    await coordinator.ready();
    coordinator.im.saveChannel({
      id: 'wx-tactical',
      platform: 'wechat',
      name: '微信随身耳机',
      accountId: 'friday-bot',
      defaultTarget: 'tony-wx',
      allowedSenders: ['tony-wx'],
      enabled: true,
    });
    const imOutbound: string[] = [];
    coordinator.im.sendToChannel = async (_channelId, text) => {
      imOutbound.push(text);
    };

    const wxOrigin = {
      channel: 'wechat' as const,
      channelId: 'wx-tactical',
      accountId: 'friday-bot',
      conversationId: 'tony-wx',
      senderId: 'tony-wx',
    };

    // Submit a task with a tight 220ms active limit via Coordinator.submit linked to a WeChat message
    coordinator.chat('wx-msg-1', '派发：重构核心存储迁移 [ASK_BOSS: 发现生产库存在未备份历史表，先增量双写还是直接覆盖？]', [], wxOrigin);

    await until(() => {
      const tasks = coordinator.store.list();
      return tasks.length === 1 && Boolean(tasks[0]!.pendingQuestion);
    });

    const waitingTask = coordinator.store.list()[0]!;
    // Wait for F.R.I.D.A.Y. to finish relaying WORKER_QUESTION out to WeChat so pure decision wait begins
    await until(() => imOutbound.some(text => text.includes('关键分岔需要您拍板')));

    // Tighten active limit so that if waiting burned activeMs, 350ms of wall sleep would pause it
    const settledWaiting = coordinator.store.get(waitingTask.id);
    settledWaiting.limitMs = Math.ceil(settledWaiting.activeMs) + 180;
    coordinator.store.save(settledWaiting);
    const activeBeforeWait = settledWaiting.activeMs;

    // Sleep 350ms wall-clock while Boss thinks — activeMs MUST NOT advance while suspended!
    await delay(350);
    const afterWallWait = coordinator.store.get(waitingTask.id);
    assert.equal(afterWallWait.status, 'running', 'Task stays alive and does not time out while waiting for Boss');
    assert.ok(afterWallWait.pendingQuestion, 'pendingQuestion remains visible');
    assert.equal(Math.round(afterWallWait.activeMs), Math.round(activeBeforeWait), 'Zero activeMs budget burned during pure decision wait');

    // Boss replies naturally on WeChat WITHOUT any taskId or "继续/补充" keyword
    coordinator.chat('wx-msg-2', '选方案 A，先做增量双写并保留快照', [], wxOrigin);

    await until(() => coordinator.store.get(waitingTask.id).status === 'completed');
    const finished = coordinator.store.get(waitingTask.id);
    assert.equal(finished.pendingQuestion, undefined, 'pendingQuestion is cleared upon settlement');
    assert.match(finished.report ?? '', /选方案 A，先做增量双写并保留快照/, 'The original Worker session received Boss decision');
    assert.equal(workerInstancesCreated, 1, 'Resumed inside the EXACT same Worker session without spawning a second Worker');

    await until(() => imOutbound.some(text => text.includes('增量双写并保留快照') && text.includes('汇总')));
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('2. Sibling Workspace Awareness injects concurrentPeers into native Workers sharing the same cwd', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-peers-'));
  const sharedCwd = await mkdtemp(join(await realpath(tmpdir()), 'friday-repo-'));
  const seenCompiled: Array<{ prompt: string; peers: unknown }> = [];

  const factory: AgentFactory = {
    mode: 'offline',
    nativeTools: true,
    async create(role, _id, tools) {
      return {
        close() {},
        async prompt(text) {
          const event = JSON.parse(text) as Record<string, unknown>;
          if (role === 'worker') {
            const compiled = event.compiledContext as { concurrentPeers?: unknown } | undefined;
            seenCompiled.push({
              prompt: String(event.prompt ?? ''),
              peers: compiled?.concurrentPeers ?? event.concurrentPeers ?? [],
            });
            await delay(140);
            return 'peer-aware completion';
          }
          if (event.kind === 'CHAT') {
            const start = tools.find(t => t.name === 'start_work')!;
            const msg = event.message as { text: string };
            await start.execute(JSON.stringify({
              instruction: msg.text,
              profile: msg.text.includes('后端') ? 'coding' : 'review',
              cwd: sharedCwd,
            }));
            return 'dispatched';
          }
          return 'delivered';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    coordinator.chat('p1', '修改后端鉴权中间件');
    await until(() => coordinator.store.list().length === 1 && coordinator.store.list()[0]!.status === 'running');

    coordinator.chat('p2', '审查同仓库前端路由守卫');
    await until(() => coordinator.store.list().length === 2 && coordinator.store.list().every(t => t.status === 'completed'));

    const secondWorker = seenCompiled.find(item => item.prompt.includes('前端路由守卫'));
    assert.ok(secondWorker);
    const peers = secondWorker.peers as Array<{ taskId: string; profile?: string; prompt: string }>;
    assert.equal(peers.length, 1, 'Second Worker entering the same cwd receives live sibling task awareness');
    assert.equal(peers[0]!.profile, 'coding');
    assert.match(peers[0]!.prompt, /修改后端鉴权中间件/);
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
    await rm(sharedCwd, { recursive: true, force: true });
  }
});

test('3. One-shot countdown reminders (once + delayMs) fire once via 0-token system-pulse/remind and auto-retire', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-oneshot-'));
  const coordinator = new Coordinator(home, offlineFactory(10));
  try {
    await coordinator.ready();
    coordinator.chat('rem-1', '提醒：1秒后 检查灰度发布监控面板');

    await until(() => coordinator.store.listTimers().length === 1);
    const created = coordinator.store.listTimers()[0]!;
    assert.equal(created.once, true);
    assert.equal(created.plugin, 'system-pulse');
    assert.equal(created.pluginAction, 'remind');
    assert.equal(created.enabled, true);

    // Wait for the 1s one-shot reminder to fire and auto-disable
    await until(() => {
      const t = coordinator.store.getTimer(created.id);
      return t.enabled === false && Boolean(t.lastRunAt);
    }, 250, 20);

    // Wait until the plugin async delivery posts the reminder message to the main conversation
    await until(() => {
      const msgs = coordinator.store.conversation.history().items;
      return msgs.some(m => m.role === 'assistant' && m.text.includes('检查灰度发布监控面板') && m.text.includes('提醒时间到了'));
    });

    assert.equal(coordinator.store.list().length, 0, '0-token plugin reminder does not spawn an LLM Worker task');

    const countAfterFirst = coordinator.store.conversation.history().items.length;
    await delay(1200);
    assert.equal(coordinator.store.conversation.history().items.length, countAfterFirst, 'One-shot timer never fires a second time');
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('4. system-pulse telemetry/silent patrol works and custom forged plugins strip sensitive API keys from env', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-pulse-'));
  const gitRepo = await mkdtemp(join(await realpath(tmpdir()), 'friday-git-'));
  const prevSecret = process.env.SUPER_AGENT_API_KEY;
  const prevToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.SUPER_AGENT_API_KEY = 'sk-should-never-leak-to-plugin';
  process.env.TELEGRAM_BOT_TOKEN = 'bot-token-should-never-leak';
  try {
    execFileSync('git', ['init', '-b', 'feat/friday'], { cwd: gitRepo, stdio: 'ignore' });
    await writeFile(join(gitRepo, 'README.md'), '# Suit Mark L\n');

    const discovered = await listPlugins(home);
    assert.ok(discovered.some(p => p.name === 'system-pulse'), 'Built-in system-pulse plugin is discovered');

    // 1) status returns host + dirty git telemetry
    const statusRes = await runPlugin(home, 'system-pulse', 'status', { cwd: gitRepo });
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.notify, true);
    assert.match(statusRes.message, /feat\/friday/);
    assert.match(statusRes.message, /1 处未提交变更/);

    // 2) patrol stays completely silent (notify: false) when healthy
    const healthyPatrol = await runPlugin(home, 'system-pulse', 'patrol', {
      cwd: gitRepo,
      maxLoadPerCore: 999,
      maxMemUsedPct: 100,
      minDiskFreeGb: 0,
    });
    assert.equal(healthyPatrol.ok, true);
    assert.equal(healthyPatrol.notify, false, 'Healthy patrol stays silent');

    // 3) patrol alerts (notify: true) when threshold is breached
    const alertPatrol = await runPlugin(home, 'system-pulse', 'patrol', {
      cwd: gitRepo,
      warnDirtyGit: true,
      maxLoadPerCore: 999,
      maxMemUsedPct: 100,
      minDiskFreeGb: 0,
    });
    assert.equal(alertPatrol.ok, true);
    assert.equal(alertPatrol.notify, true, 'Anomalous patrol notifies Boss');
    assert.match(alertPatrol.message, /未提交变更/);

    // 4) Self-evolving custom plugin under <home>/plugins/<name> is auto-discovered and isolated from secrets
    const customDir = join(home, 'plugins', 'env-probe');
    await mkdir(customDir, { recursive: true });
    await writeFile(join(customDir, 'plugin.json'), JSON.stringify({
      name: 'env-probe',
      title: '环境隔离探针',
      entry: 'index.mjs',
      actions: ['check'],
    }));
    await writeFile(join(customDir, 'index.mjs'), `
      process.stdout.write(JSON.stringify({
        ok: true,
        notify: true,
        message: 'probed',
        data: {
          hasApiKey: Boolean(process.env.SUPER_AGENT_API_KEY),
          hasBotToken: Boolean(process.env.TELEGRAM_BOT_TOKEN),
          hasHome: Boolean(process.env.SUPER_AGENT_HOME),
          hasDataDir: Boolean(process.env.PLUGIN_DATA_DIR),
        },
      }));
    `);

    const probe = await runPlugin(home, 'env-probe', 'check', {});
    const data = probe.data as { hasApiKey: boolean; hasBotToken: boolean; hasHome: boolean; hasDataDir: boolean };
    assert.equal(data.hasApiKey, false, 'SUPER_AGENT_API_KEY stripped from plugin child env');
    assert.equal(data.hasBotToken, false, 'TELEGRAM_BOT_TOKEN stripped from plugin child env');
    assert.equal(data.hasHome, true);
    assert.equal(data.hasDataDir, true);
  } finally {
    if (prevSecret === undefined) delete process.env.SUPER_AGENT_API_KEY;
    else process.env.SUPER_AGENT_API_KEY = prevSecret;
    if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prevToken;
    await rm(home, { recursive: true, force: true });
    await rm(gitRepo, { recursive: true, force: true });
  }
});

test('5. Channel-adaptive deliveryChannel reaches Router across CHAT/WORKER_QUESTION/WORKER_REPORT and recover() preserves pendingQuestion context', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-channel-'));
  const routerEvents: Array<{ kind: string; deliveryChannel?: string }> = [];

  const factory: AgentFactory = {
    mode: 'offline',
    nativeTools: true,
    async create(role, _id, tools) {
      let asked = false;
      return {
        close() {},
        async prompt(text) {
          const event = JSON.parse(text) as Record<string, unknown>;
          if (role === 'router') {
            routerEvents.push({
              kind: String(event.kind ?? ''),
              deliveryChannel: typeof event.deliveryChannel === 'string' ? event.deliveryChannel : undefined,
            });
            if (event.kind === 'CHAT') {
              const msg = event.message as { text: string };
              const works = (event.works as Array<{ id: string; pendingQuestion?: unknown }>) ?? [];
              const pending = works.find(w => Boolean(w.pendingQuestion));
              if (pending) {
                await tools.find(t => t.name === 'continue_work')!.execute(JSON.stringify({
                  taskId: pending.id,
                  instruction: msg.text,
                }));
                return '已传达';
              }
              await tools.find(t => t.name === 'start_work')!.execute(JSON.stringify({
                instruction: msg.text,
                cwd: home,
              }));
              return '已启动';
            }
            return '汇报完毕';
          }
          if (!asked) {
            asked = true;
            return JSON.stringify({ kind: 'ASK_BOSS', question: '确认灰度比例 10% 吗？' });
          }
          return '灰度 10% 已上线';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    const tgOrigin = {
      channel: 'telegram' as const,
      channelId: 'tg-1',
      accountId: 'bot',
      conversationId: 'chat-99',
      senderId: 'boss-tg',
    };
    coordinator.chat('tg-c1', '发布新版本', [], tgOrigin);
    await until(() => routerEvents.some(e => e.kind === 'WORKER_QUESTION'));

    coordinator.chat('tg-c2', '确认 10%', [], tgOrigin);
    await until(() => routerEvents.some(e => e.kind === 'WORKER_REPORT'));

    assert.deepEqual(
      routerEvents.map(e => `${e.kind}:${e.deliveryChannel}`),
      ['CHAT:telegram', 'WORKER_QUESTION:telegram', 'CHAT:telegram', 'WORKER_REPORT:telegram'],
    );
  } finally {
    await coordinator.close();
  }

  // Verify crash/restart recovery preserves pendingQuestion context in paused reason
  const store = new Store(home);
  try {
    store.create({
      id: 'interrupted-ask',
      requestId: 'req-interrupted-ask',
      fingerprint: 'fp',
      prompt: '生产迁移',
      files: [],
      status: 'running',
      revision: 0,
      mode: 'real',
      execution: 'native',
      cwd: home,
      createdAt: Date.now(),
      activeMs: 50,
      limitMs: 600_000,
      pendingQuestion: { question: '是否清理旧索引？', askedAt: Date.now() },
    });
    store.recover();
    const recovered = store.get('interrupted-ask');
    assert.equal(recovered.status, 'paused');
    assert.equal(recovered.pendingQuestion, undefined);
    assert.match(recovered.reason ?? '', /是否清理旧索引/);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

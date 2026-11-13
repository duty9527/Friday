import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../dist/coordinator.js';
import { buildMindmapSnapshot } from '../dist/mindmap-flow.js';
import { Store } from '../dist/store.js';
import type { AgentFactory } from '../src/agent.js';

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

test('Runtime session attribution: JEV evaluates same_session on intake execution and splits unrelated topics', async () => {
  const mock = await withMockDecisionServer(req => {
    if (req.questions.same_session) {
      const currentText = String(req.input.currentText ?? '');
      if (currentText.includes('基金')) {
        return {
          body: {
            answers: {
              same_session: { type: 'noul', noul: 0.08, confidence: 0.93 },
              relation: { type: 'choice', choice: 'new_topic', confidence: 0.92 },
            },
            usage: { total_input_tokens: 130, total_output_tokens: 10, total_tokens: 140 },
          },
        };
      }
      return {
        body: {
          answers: {
            same_session: { type: 'noul', noul: 0.91, confidence: 0.89 },
            relation: { type: 'choice', choice: 'topic_continuity', confidence: 0.88 },
          },
          usage: { total_input_tokens: 120, total_output_tokens: 10, total_tokens: 130 },
        },
      };
    }
    if (req.questions.route) {
      const keys = Object.keys((req.questions.route.criteria as Record<string, string>) ?? {});
      return {
        body: {
          answers: {
            route: { type: 'choice', choice: keys[0]!, confidence: 0.9 },
            needs_quality_gate: { type: 'noul', noul: 0.1, confidence: 0.9 },
          },
        },
      };
    }
    return {
      body: {
        answers: {
          completion: { type: 'score', score: 2.8, confidence: 0.9 },
          should_supplement: { type: 'noul', noul: 0.05, confidence: 0.9 },
          missing_aspect: { type: 'choice', choice: 'none', confidence: 0.9 },
        },
      },
    };
  });

  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-runtime-sess-'));
  const factory: AgentFactory = {
    mode: 'offline',
    nativeTools: true,
    async create(role, _id, tools) {
      return {
        close() {},
        async prompt(text) {
          const event = JSON.parse(text) as Record<string, unknown>;
          if (role === 'worker') return '已排查完毕';
          if (event.kind === 'CHAT') {
            const msg = event.message as { text: string };
            if (msg.text.includes('顺便检查日志')) {
              await tools.find(t => t.name === 'start_work')!.execute(JSON.stringify({
                instruction: '检查 gateway 服务超时日志',
                cwd: home,
              }));
            }
            return '收到';
          }
          return '完成汇报';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    await coordinator.configureModels({
      providerId: 'deepseek',
      apiKey: 'sk-ds-rt',
      selectedModels: ['deepseek-flash'],
      decisionApiKey: 'jev-rt-key',
      decisionBaseUrl: mock.baseUrl,
    });

    // Turn 1: seed user message 60 seconds ago directly through Store
    const now = Date.now();
    const u1 = coordinator.store.conversation.create({
      id: 'rt-u1',
      role: 'user',
      origin: { channel: 'wechat', conversationId: 'boss-1', senderId: 'boss-1' },
      sessionId: 'session:flow:rt-u1',
      text: '我看一下 gateway 超时情况',
      status: 'completed',
      paths: [],
      mode: 'offline',
      at: now - 120_000,
    });
    const r1 = coordinator.store.conversation.create({
      id: 'rt-r1',
      replyTo: u1.id,
      role: 'assistant',
      origin: { channel: 'wechat', conversationId: 'boss-1', senderId: 'boss-1' },
      text: '目前发现 2 次超时。',
      status: 'completed',
      paths: [],
      mode: 'offline',
      at: now - 115_000,
    });
    assert.equal(r1.sessionId, u1.sessionId);

    // Turn 2: >15s gap, runtime execution invokes JEV same_session and persists merged sessionId + Task.sessionId
    const u2 = coordinator.chat('req-rt-2', '帮我顺便检查日志里有没有报 502', [], {
      channel: 'wechat',
      conversationId: 'boss-1',
      senderId: 'boss-1',
    });
    await until(() => {
      const m = coordinator.store.conversation.get(u2.id);
      const works = coordinator.store.list();
      return m.status === 'completed' && works.length === 1 && works[0]!.status === 'completed';
    });

    const u2Saved = coordinator.store.conversation.get(u2.id);
    const r2Saved = coordinator.store.conversation.repliesForMessages([u2.id])[0]!;
    const task2 = coordinator.store.list()[0]!;
    assert.equal(u2Saved.sessionId, 'session:flow:rt-u1');
    assert.equal(u2Saved.sessionLink?.source, 'gemini-decision-1');
    assert.equal(u2Saved.sessionLink?.kind, 'topic_continuity');
    assert.equal(u2Saved.sessionLink?.usage?.totalTokens, 130);
    assert.equal(r2Saved.sessionId, 'session:flow:rt-u1');
    assert.equal(task2.sessionId, 'session:flow:rt-u1');

    // Verify JEV was called during coordinator.chat execution (before /api/mindmap was ever invoked)
    const sessionCallsBeforeMindmap = mock.requests.filter(r => Boolean(r.questions.same_session));
    assert.equal(sessionCallsBeforeMindmap.length, 1);

    // Seed a 45s-old prior turn in the same session so Turn 3 is >15s later -> JEV returns 0.08 (new_topic) and splits session
    const u2b = coordinator.store.conversation.create({
      id: 'rt-u2b',
      role: 'user',
      origin: { channel: 'wechat', conversationId: 'boss-1', senderId: 'boss-1' },
      sessionId: 'session:flow:rt-u1',
      sessionLink: u2Saved.sessionLink,
      text: '刚刚 502 集中在哪个接口',
      status: 'completed',
      paths: [],
      mode: 'offline',
      at: now - 45_000,
    });
    coordinator.store.conversation.create({
      id: 'rt-r2b',
      replyTo: u2b.id,
      role: 'assistant',
      origin: { channel: 'wechat', conversationId: 'boss-1', senderId: 'boss-1' },
      text: '集中在 /v1/chat 接口。',
      status: 'completed',
      paths: [],
      mode: 'offline',
      at: now - 40_000,
    });

    const u3 = coordinator.chat('req-rt-3', '帮我查一下今天基金净值走势', [], {
      channel: 'wechat',
      conversationId: 'boss-1',
      senderId: 'boss-1',
    });
    await until(() => coordinator.store.conversation.get(u3.id).status === 'completed');

    const u3Saved = coordinator.store.conversation.get(u3.id);
    assert.equal(u3Saved.sessionId, `session:flow:${u3.id}`);
    assert.equal(u3Saved.sessionLink, undefined);

    const sessionCallsAfterU3 = mock.requests.filter(r => Boolean(r.questions.same_session)).length;
    assert.equal(sessionCallsAfterU3, 2);

    // /api/mindmap reads persisted native sessions directly without firing additional JEV requests
    const snapshot = await buildMindmapSnapshot(coordinator, { home });
    assert.equal(
      mock.requests.filter(r => Boolean(r.questions.same_session)).length,
      sessionCallsAfterU3,
      '/api/mindmap must not re-evaluate already persisted runtime sessions',
    );
    const f2 = snapshot.flows.find(f => f.ingress.messageId === u2.id)!;
    const f3 = snapshot.flows.find(f => f.ingress.messageId === u3.id)!;
    assert.equal(f2.sessionPersisted, true);
    assert.equal(f2.sessionId, 'session:flow:rt-u1');
    assert.equal(f3.sessionPersisted, true);
    assert.notEqual(f3.sessionId, f2.sessionId);
  } finally {
    await coordinator.close();
    await mock.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Runtime tool reconciliation: long-gap (>45m) continue_work upgrades sessionId natively without mutating historical task', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-runtime-reconcile-'));
  let capturedOldTaskId = '';

  const factory: AgentFactory = {
    mode: 'offline',
    nativeTools: true,
    async create(role, _id, tools) {
      return {
        close() {},
        async prompt(text) {
          const event = JSON.parse(text) as Record<string, unknown>;
          if (role === 'worker') return '续接执行完毕';
          if (event.kind === 'CHAT') {
            await tools.find(t => t.name === 'continue_work')!.execute(JSON.stringify({
              taskId: capturedOldTaskId,
              instruction: '补充验证 2 小时前的数据库索引方案',
              cwd: home,
            }));
            return '已接续执行。';
          }
          return '交付完成。';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    const twoHoursAgo = Date.now() - 2 * 3600_000;
    const oldUser = coordinator.store.conversation.create({
      id: 'old-u1',
      role: 'user',
      sessionId: 'session:flow:old-u1',
      text: '分析 SQLite 索引设计',
      status: 'completed',
      paths: [],
      mode: 'offline',
      at: twoHoursAgo,
    });
    capturedOldTaskId = 'task-old-2h';
    const historicalTask = {
      id: capturedOldTaskId,
      requestId: 'req-old-task',
      fingerprint: 'fp-old',
      prompt: '分析 SQLite 索引设计',
      files: [],
      limitMs: 600_000,
      activeMs: 5000,
      status: 'completed' as const,
      revision: 1,
      mode: 'offline' as const,
      createdAt: twoHoursAgo + 1000,
      originMessageId: oldUser.id,
      sessionId: 'session:flow:old-u1',
      report: '已完成初步分析',
    };
    coordinator.store.create(historicalTask);
    const oldTaskSnapshotBefore = coordinator.store.get(capturedOldTaskId);

    // After 2 hours gap, intake tentatively starts a fresh sessionId, then Router calls continue_work
    const newMsg = coordinator.chat('req-2h-later', '再深度看一下这个部分');
    assert.equal(newMsg.sessionId, `session:flow:${newMsg.id}`);

    await until(() => {
      const m = coordinator.store.conversation.get(newMsg.id);
      const tasks = coordinator.store.list();
      return m.status === 'completed' && tasks.length === 2 && tasks[1]!.status === 'completed';
    });

    const reconciledUser = coordinator.store.conversation.get(newMsg.id);
    const reconciledReply = coordinator.store.conversation.repliesForMessages([newMsg.id])[0]!;
    const newChildTask = coordinator.store.list().find(t => t.id !== capturedOldTaskId)!;

    assert.equal(reconciledUser.sessionId, 'session:flow:old-u1');
    assert.equal(reconciledUser.sessionLink?.kind, 'task_link');
    assert.equal(reconciledUser.sessionLink?.source, 'causal');
    assert.equal(reconciledReply.sessionId, 'session:flow:old-u1');
    assert.equal(newChildTask.parentTaskId, capturedOldTaskId);
    assert.equal(newChildTask.sessionId, 'session:flow:old-u1');
    assert.deepEqual(coordinator.store.get(capturedOldTaskId), oldTaskSnapshotBefore, 'historical task must stay untouched');
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Startup backfill persists native sessionIds onto legacy Store messages and tasks idempotently', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-runtime-backfill-'));
  try {
    const seed = new Store(home);
    const t0 = Date.now() - 300_000;
    const u1 = seed.conversation.create({
      id: 'leg-u1',
      role: 'user',
      text: '帮我查一下 rex 的 libghostty 分支实现',
      status: 'completed',
      paths: [],
      mode: 'offline',
      at: t0,
    });
    seed.conversation.create({
      id: 'leg-r1',
      replyTo: u1.id,
      role: 'assistant',
      text: '请问你是指终端渲染部分还是键盘事件部分？',
      status: 'completed',
      paths: [],
      mode: 'offline',
      at: t0 + 4000,
    });
    const u2 = seed.conversation.create({
      id: 'leg-u2',
      role: 'user',
      text: '终端渲染和 libghostty 桥接这部分',
      status: 'completed',
      paths: [],
      mode: 'offline',
      at: t0 + 30_000,
    });
    seed.create({
      id: 'leg-task-2',
      requestId: 'req-leg-task-2',
      fingerprint: 'fp-leg-2',
      prompt: '调研 rex 的 libghostty 桥接与终端渲染',
      files: [],
      limitMs: 600_000,
      activeMs: 2000,
      status: 'completed',
      revision: 1,
      mode: 'offline',
      createdAt: t0 + 31_000,
      originMessageId: u2.id,
    });
    seed.conversation.link(u2.id, 'leg-task-2');
    assert.equal(seed.conversation.get(u1.id).sessionId, undefined);
    seed.close();

    const factory: AgentFactory = {
      mode: 'offline',
      nativeTools: true,
      async create() {
        return { close() {}, async prompt() { return 'ok'; } };
      },
    };
    const coordinator = new Coordinator(home, factory);
    try {
      await coordinator.ready();
      const m1 = coordinator.store.conversation.get('leg-u1');
      const r1 = coordinator.store.conversation.get('leg-r1');
      const m2 = coordinator.store.conversation.get('leg-u2');
      const t2 = coordinator.store.get('leg-task-2');

      assert.equal(m1.sessionId, 'session:flow:leg-u1');
      assert.equal(r1.sessionId, 'session:flow:leg-u1');
      assert.equal(m2.sessionId, 'session:flow:leg-u1');
      assert.equal(m2.sessionLink?.source, 'causal');
      assert.ok(m2.sessionLink?.kind === 'ai_context_synthesis' || m2.sessionLink?.kind === 'answer_clarification');
      assert.equal(t2.sessionId, 'session:flow:leg-u1');

      const snap = await buildMindmapSnapshot(coordinator, { home });
      assert.equal(snap.sessions.length, 1);
      assert.equal(snap.sessions[0]!.id, 'session:flow:leg-u1');
      assert.equal(snap.sessions[0]!.turnCount, 2);
      assert.ok(snap.flows.every(f => f.sessionPersisted === true));
    } finally {
      await coordinator.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

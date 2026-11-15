import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { offlineFactory, type AgentFactory, type AgentOptions, type AgentPort, type AgentTool, type Role } from '../src/agent.js';
import { Coordinator } from '../src/coordinator.js';
import {
  distillCompletedTask,
  parseDistillerOutput,
  shouldSkipTrivialChatBatch,
} from '../src/distiller.js';
import type { SemanticEmbedder } from '../src/semantic.js';
import { Store } from '../src/store.js';

async function until(predicate: () => boolean | Promise<boolean>, attempts = 400) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for condition');
}

function makeFakeSemanticEmbedder(mapVector: (text: string) => Float32Array): SemanticEmbedder {
  return {
    modelId: 'fake-semantic-test',
    dim: 4,
    isReady: () => true,
    async ensureReady() { return true; },
    async embed(text: string) {
      return text.trim() ? mapVector(text) : undefined;
    },
  };
}

function makeDistillFactory(handlers: {
  onChat?: (event: Record<string, unknown>, call: (name: string, input: unknown) => Promise<string>) => Promise<string>;
  onWork?: (event: Record<string, unknown>) => Promise<string>;
  onWorkerReport?: (event: Record<string, unknown>, call: (name: string, input: unknown) => Promise<string>) => Promise<string>;
  onDistill?: (event: Record<string, unknown>, signal: AbortSignal) => Promise<string>;
}): AgentFactory {
  return {
    mode: 'offline',
    nativeTools: false,
    async create(role: Role, _id: string, tools: AgentTool[], _options?: AgentOptions): Promise<AgentPort> {
      const call = async (name: string, input: unknown) => {
        const tool = tools.find(t => t.name === name);
        if (!tool) throw new Error(`Missing tool: ${name}`);
        return tool.execute(typeof input === 'string' ? input : JSON.stringify(input));
      };
      return {
        async prompt(raw: string, signal: AbortSignal): Promise<string> {
          signal.throwIfAborted();
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (role === 'distiller') {
            return handlers.onDistill ? handlers.onDistill(parsed, signal) : JSON.stringify({ operations: [] });
          }
          if (role === 'router') {
            if (parsed.kind === 'NEW_TASK') {
              await call('dispatch_worker', 'confirm');
              return 'dispatched';
            }
            if (parsed.kind === 'CHAT') {
              return handlers.onChat ? handlers.onChat(parsed, call) : '收到，老板。';
            }
            if (parsed.kind === 'WORKER_REPORT') {
              return handlers.onWorkerReport
                ? handlers.onWorkerReport(parsed, call)
                : String(parsed.report ?? '任务已完成。');
            }
            return 'ok';
          }
          if (role === 'worker') {
            return handlers.onWork ? handlers.onWork(parsed) : '执行完毕';
          }
          return JSON.stringify({ impression: '平静。', salience: 'faint' });
        },
        close() {},
      };
    },
  };
}

test('parseDistillerOutput sanitizes prefixes, tags, importance bounds, ignores legacy forget ops, and trivial chat skip rules', () => {
  const raw = [
    '```json',
    JSON.stringify({
      operations: [
        {
          action: 'save',
          topic: '任务经验 · HP1020 打印机防休眠参数',
          content: '设置 usbcore.autosuspend=-1 后解决离线问题',
          tags: ['auto-consolidated', '梦境', 'HP1020', 'cups', 'HP1020'],
          importance: 150,
          supersedeIds: ['old-1', 'old-1'],
        },
        { action: 'forget', id: 'noise-1' },
        { action: 'save', topic: '第二条', content: '有效内容', tags: ['test'], importance: 5 },
        { action: 'save', topic: '第三条', content: '有效内容3', tags: [] },
        { action: 'save', topic: '第四条被截断', content: '不应保留', tags: [] },
      ],
    }),
    '```',
  ].join('\n');

  const ops = parseDistillerOutput(raw, { maxOps: 3 });
  assert.equal(ops.length, 3);
  assert.equal(ops[0]?.action, 'save');
  assert.equal(ops[0]?.topic, 'HP1020 打印机防休眠参数');
  assert.deepEqual(ops[0]?.tags, ['HP1020', 'cups']);
  assert.equal(ops[0]?.importance, 95);
  assert.deepEqual(ops[0]?.supersedeIds, ['old-1']);
  assert.equal(ops[1]?.topic, '第二条');
  assert.equal(ops[1]?.importance, 25);
  assert.equal(ops[2]?.topic, '第三条');

  assert.equal(shouldSkipTrivialChatBatch([]), true);
  assert.equal(shouldSkipTrivialChatBatch([
    { id: '1', seq: 1, version: 1, at: 1, role: 'user', source: 'system', text: '[定时触发]', status: 'completed', mode: 'real', paths: [], taskIds: [] },
  ]), true);
  assert.equal(shouldSkipTrivialChatBatch([
    { id: '1', seq: 1, version: 1, at: 1, role: 'user', text: '查一下代码', status: 'completed', mode: 'real', paths: [], taskIds: [] },
    { id: '2', seq: 2, version: 1, at: 2, role: 'assistant', replyTo: '1', text: '好的老板，任务已下发。', status: 'completed', mode: 'real', paths: [], taskIds: [] },
  ]), true);
  assert.equal(shouldSkipTrivialChatBatch([
    {
      id: '1', seq: 1, version: 1, at: 1, role: 'user', text: '记住端口是 3210', status: 'completed', mode: 'real', paths: [], taskIds: [],
      routing: {
        at: 1,
        status: 'completed',
        context: { execution: 'native', cwd: '/tmp', totalWorks: 0, truncated: false, works: [], messages: [] },
        actions: [{ id: 'a1', kind: 'save_memory', status: 'accepted', at: 1 }],
      },
    },
    { id: '2', seq: 2, version: 1, at: 2, role: 'assistant', replyTo: '1', text: '已记住。', status: 'completed', mode: 'real', paths: [], taskIds: [] },
  ]), true);
  assert.equal(shouldSkipTrivialChatBatch([
    { id: '1', seq: 1, version: 1, at: 1, role: 'user', text: '以后所有报告都放附件里别直接刷屏', status: 'completed', mode: 'real', paths: [], taskIds: [] },
    { id: '2', seq: 2, version: 1, at: 2, role: 'assistant', replyTo: '1', text: '收到老板，后续长报告都通过附件发送。', status: 'completed', mode: 'real', paths: [], taskIds: [] },
  ]), false);
});

test('Post-task distiller skips ephemeral tasks, skips rejected drafts, skips manual save_memory turns, and saves accepted insights', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-distill-task-'));
  const distillEvents: Array<Record<string, unknown>> = [];
  let workCount = 0;

  const factory = makeDistillFactory({
    async onChat(event, call) {
      const msg = (event.message as { text: string; id: string }).text;
      if (msg.includes('补查流')) {
        await call('start_work', { instruction: '[NEEDS_SUPPLEMENT: 缺命令] 排查蓝牙连接', cwd: home });
      } else if (msg.includes('手工记')) {
        await call('start_work', { instruction: '手工记住任务', cwd: home });
      } else if (msg.includes('查基金')) {
        await call('start_work', { instruction: '查询今日基金净值', cwd: home });
      } else {
        await call('start_work', { instruction: '排查 HP1020 打印机掉线问题', cwd: home });
      }
      return '好的老板，任务已下发。';
    },
    async onWork(event) {
      workCount++;
      const p = String(event.prompt ?? '');
      if (p.includes('NEEDS_SUPPLEMENT') && !p.includes('已完成补查')) {
        return '初步检查过但未运行验证命令';
      }
      if (p.includes('查询今日基金净值')) {
        return '今日沪深300估值 +0.42%，一次性查询完成。';
      }
      if (p.includes('手工记住任务')) {
        return '已查到本机服务端口为 3210';
      }
      return '根因是 usblp 模块冲突，已在 /etc/modprobe.d/blacklist-usblp.conf 禁用并通过 lpstat 验证。';
    },
    async onWorkerReport(event, call) {
      const prompt = String(event.prompt ?? '');
      if (prompt.includes('NEEDS_SUPPLEMENT') && !prompt.includes('已完成补查')) {
        await call('start_work', { instruction: '[已完成补查] 重新核查蓝牙' });
        return '好的老板，任务已下发。';
      }
      if (prompt.includes('手工记住任务')) {
        await call('save_memory', { topic: 'Router 手动沉淀 · 端口', content: '本机 Web 服务端口为 3210', cwd: home });
        return '已记录端口。';
      }
      return String(event.report ?? '完成');
    },
    async onDistill(event) {
      distillEvents.push(event);
      const task = event.task as { prompt?: string; report?: string; cwd?: string } | undefined;
      const report = task?.report ?? '';
      if (report.includes('一次性查询')) {
        return JSON.stringify({ operations: [] });
      }
      if (report.includes('usblp')) {
        return JSON.stringify({
          operations: [{
            action: 'save',
            topic: 'workstation-a HP1020 禁用 usblp 根因方案',
            content: 'HP1020 掉线根因为 usblp 冲突，blacklist usblp 并用 lpstat 验证生效。',
            tags: ['HP1020', 'cups', 'usblp'],
            cwd: task?.cwd,
            importance: 80,
          }],
        });
      }
      return JSON.stringify({ operations: [] });
    },
  });

  const coordinator = new Coordinator(home, factory, {
    skipExecutor: true,
    distillerEnabled: true,
    distillIdleMs: 10 * 60_000,
    distillCheckIntervalMs: 60_000,
  });

  try {
    await coordinator.ready();

    // 1) Durable task triggers distiller and saves 1 distilled card
    coordinator.chat('req-1', '查下打印机');
    await until(() => distillEvents.length === 1 && coordinator.store.listMemories().length === 1);
    const saved = coordinator.store.listMemories()[0]!;
    assert.equal(saved.topic, 'workstation-a HP1020 禁用 usblp 根因方案');
    assert.equal(saved.tags.includes('auto-consolidated'), false);
    assert.equal(coordinator.store.distillerState().distilledTaskIds.length, 1);

    // 2) Ephemeral task produces 0 cards (SKIP gate), still marks task distilled
    coordinator.chat('req-2', '查基金');
    await until(() => distillEvents.length === 2 && coordinator.store.distillerState().distilledTaskIds.length === 2);
    assert.equal(coordinator.store.listMemories().length, 1);

    // 3) Manual save_memory during WORKER_REPORT skips duplicate post-task distiller call
    coordinator.chat('req-3', '手工记');
    await until(() => coordinator.store.listMemories().length === 2);
    await delay(100);
    assert.equal(distillEvents.length, 2, 'manual save_memory turn must not invoke post-task distiller');

    // 4) Rejected report with supplementary dispatch does NOT trigger distiller for draft 1
    coordinator.chat('req-4', '走补查流');
    await until(() => workCount >= 5 && distillEvents.length === 3);
    const lastDistillPrompt = String((distillEvents.at(-1)?.task as { prompt?: string } | undefined)?.prompt ?? '');
    assert.match(lastDistillPrompt, /已完成补查/);
    assert.equal(distillEvents.some(ev => String((ev.task as { report?: string } | undefined)?.report ?? '').includes('未运行验证命令')), false);
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Post-chat idle distiller debounces on 3-minute clock, cancels when new chat arrives mid-flight, and skips redundant reruns', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-distill-idle-'));
  let fakeNow = 1_700_000_000_000;
  let distillCalls = 0;
  let holdFirstDistill = false;
  let releaseFirstDistill: (() => void) | undefined;
  let firstDistillAborted = false;

  const factory = makeDistillFactory({
    async onChat(event) {
      const text = (event.message as { text: string }).text;
      if (text.includes('以后')) return '收到老板，以后我全部通过附件输出长报告。';
      return '好的，收到。';
    },
    async onDistill(event, signal) {
      distillCalls++;
      if (distillCalls === 1 && holdFirstDistill) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 2000);
          signal.addEventListener('abort', () => {
            firstDistillAborted = true;
            clearTimeout(timer);
            resolve();
          }, { once: true });
          releaseFirstDistill = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        if (signal.aborted) return JSON.stringify({ operations: [] });
      }
      const msgs = (event.messages as Array<{ text: string }> | undefined) ?? [];
      const joined = msgs.map(m => m.text).join('\n');
      if (joined.includes('以后')) {
        return JSON.stringify({
          operations: [{
            action: 'save',
            topic: 'Boss 长报告附件偏好',
            content: '超过篇幅的长报告一律通过附件交付，不在聊天框刷屏。',
            tags: ['boss-preference', 'wechat-attachment'],
            importance: 85,
          }],
        });
      }
      return JSON.stringify({ operations: [] });
    },
  });

  const coordinator = new Coordinator(home, factory, {
    skipExecutor: true,
    distillerEnabled: true,
    distillIdleMs: 180_000,
    distillCheckIntervalMs: 10,
    now: () => fakeNow,
  });

  try {
    await coordinator.ready();

    // First message completes
    coordinator.chat('c1', '以后长报告都用附件发');
    await until(() => coordinator.store.conversation.history().items.some(m => m.role === 'assistant' && m.status === 'completed'));

    // Advance 120s (< 180s): must NOT trigger yet
    fakeNow += 120_000;
    await delay(260);
    assert.equal(distillCalls, 0);

    // Second message arrives: resets idle countdown
    coordinator.chat('c2', '顺便提醒我一句就行');
    await until(() => coordinator.store.conversation.history().items.filter(m => m.role === 'assistant' && m.status === 'completed').length === 2);

    // Advance 120s after second message (< 180s): still must NOT trigger
    fakeNow += 120_000;
    await delay(260);
    assert.equal(distillCalls, 0);

    // Advance past 180s while holding in-flight call, then interrupt with c3
    holdFirstDistill = true;
    fakeNow += 70_000;
    await until(() => distillCalls === 1);
    coordinator.chat('c3', '还有以后默认用精简格式');
    await until(() => firstDistillAborted);
    releaseFirstDistill?.();
    await until(() => coordinator.store.conversation.history().items.filter(m => m.role === 'assistant' && m.status === 'completed').length === 3);
    assert.equal(coordinator.store.listMemories().length, 0, 'aborted in-flight idle distill must not save partial state');

    // Now wait full 180s after c3 completes
    holdFirstDistill = false;
    fakeNow += 185_000;
    await until(() => distillCalls === 2 && coordinator.store.listMemories().length === 1);
    const card = coordinator.store.listMemories()[0]!;
    assert.equal(card.topic, 'Boss 长报告附件偏好');

    // Cursor updated: advancing clock further must NOT trigger again cleanly
    const prevSeq = coordinator.store.distillerState().lastMessageSeq;
    assert.ok(prevSeq > 0);
    fakeNow += 400_000;
    await delay(260);
    assert.equal(distillCalls, 2);
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('Distiller uses semantic pre-retrieval for supersedeIds merge and handles errors safely', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-distill-merge-'));
  const store = new Store(home);
  const semantic = makeFakeSemanticEmbedder(text => {
    const t = text.toLowerCase();
    if (t.includes('hp1020') || t.includes('打印')) return new Float32Array([1, 0, 0, 0]);
    if (t.includes('meizu') || t.includes('adb')) return new Float32Array([0, 1, 0, 0]);
    return new Float32Array([0, 0, 1, 0]);
  });
  store.attachSemanticEngine(semantic);

  try {
    // 1) Pre-retrieval surfaces existing same-domain card so distiller merges via supersedeIds
    const existing = await store.saveMemoryAsync({
      topic: 'HP1020 打印机基础信息',
      content: '打印机队列名 HP1020，连接在 workstation-a 上。',
      tags: ['HP1020', 'cups'],
      cwd: '/srv/app',
    });

    let capturedRelatedTopics: string[] = [];
    const mergeFactory = makeDistillFactory({
      async onDistill(event) {
        const related = (event.existingRelatedMemories as Array<{ id: string; topic: string }> | undefined) ?? [];
        capturedRelatedTopics = related.map(r => r.topic);
        return JSON.stringify({
          operations: [{
            action: 'save',
            topic: 'workstation-a HP1020 打印机配置与故障方案',
            content: '队列名 HP1020；连接在 workstation-a；启用防休眠规则后恢复稳定打印。',
            tags: ['HP1020', 'cups', 'workstation-a'],
            cwd: '/srv/app',
            importance: 82,
            supersedeIds: related.map(r => r.id),
          }],
        });
      },
    });

    const task = {
      id: 'task-merge-1',
      requestId: 'merge-req',
      fingerprint: 'fp-merge-1',
      prompt: '解决 HP1020 打印断连问题',
      status: 'running' as const,
      revision: 0,
      files: [],
      mode: 'offline' as const,
      createdAt: Date.now(),
      limitMs: 60_000,
      activeMs: 100,
      cwd: '/srv/app',
      originMessageId: 'msg-merge-1',
    };
    store.create(task);
    store.transition(task.id, 'completed', undefined, '已固定 USB 规则，打印正常。');

    const mockHub = { selectWorkerModel: () => ({ model: 'fast-mock', tier: 'fast' as const, thinkingLevel: 'low' as const }) } as unknown as import('../src/model-hub.js').ModelHub;
    const taskRes = await distillCompletedTask({
      store,
      factory: mergeFactory,
      modelHub: mockHub,
      task: store.get(task.id),
    });
    assert.ok(capturedRelatedTopics.includes('HP1020 打印机基础信息'));
    assert.equal(taskRes.saved.length, 1);
    assert.equal(store.getMemory(existing.id).supersededBy, taskRes.saved[0]!.id);
    assert.equal(store.listMemories({ includeSuperseded: false }).length, 1);

    // 2) Offline factory distiller fallback + error resilience
    const errRes = await distillCompletedTask({
      store,
      factory: makeDistillFactory({
        async onDistill() { throw new Error('upstream 503'); },
      }),
      modelHub: mockHub,
      task: store.get(task.id),
    }).catch(e => e as Error);
    assert.ok(errRes instanceof Error);

    // Offline factory smoke check preserves deterministic zero-network run
    const offlinePort = await offlineFactory(0).create('distiller', 'offline-distill', []);
    const offlineOut = await offlinePort.prompt(
      JSON.stringify({ kind: 'DISTILL_CHAT', messages: [{ role: 'user', text: '查询今日基金净值' }], existingRelatedMemories: [] }),
      new AbortController().signal,
    );
    offlinePort.close();
    assert.deepEqual(parseDistillerOutput(offlineOut), []);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

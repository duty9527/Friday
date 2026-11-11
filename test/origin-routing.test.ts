import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ImGateway } from '../src/im.js';
import { Coordinator } from '../dist/coordinator.js';
import { offlineFactory } from '../src/agent.js';

test('durable exact-origin delivery: local/legacy suppressed, IM sessions isolated, restart inheritance', async () => {
  const home = await mkdtemp(join(tmpdir(), 'origin-route-'));
  const store = new Store(home);
  try {
    const gateway = new ImGateway({ store } as any);
    const sent: any[] = [];
    gateway.sendToChannel = async (...args: any[]) => { sent.push(args); };
    const now = Date.now();
    for (const [id, platform] of [['wx', 'wechat'], ['tg', 'telegram']] as const) {
      store.saveImChannel({ id, platform, name: id, accountId: id, enabled: true, notifyAll: true,
        defaultTarget: 'WRONG', allowedSenders: [], inboundCount: 0, outboundCount: 0, createdAt: now, updatedAt: now });
    }
    const origins = [undefined, { channel: 'local' },
      { channel: 'wechat', channelId: 'wx', accountId: 'wx', conversationId: 'A', senderId: 'A' },
      { channel: 'wechat', channelId: 'wx', accountId: 'wx', conversationId: 'B', senderId: 'B' },
      { channel: 'telegram', channelId: 'tg', accountId: 'tg', conversationId: 'C', senderId: 'D' }];
    origins.forEach((origin, i) => {
      store.conversation.create({ id: `u${i}`, role: 'user', text: 'question', status: 'completed', mode: 'offline', paths: [], origin } as any);
      store.conversation.create({ id: `r${i}`, replyTo: `u${i}`, role: 'assistant', text: `answer${i}`, status: 'completed', mode: 'offline', paths: [] });
    });
    // New gateway has no in-memory inbound routes, just like recovery after restart.
    for (let i = 0; i < 5; i++) await (gateway as any).flushOutboundUpdates();
    assert.deepEqual(sent.map(([id, text, options]) => [id, text, options.target]), [
      ['wx', 'answer2', 'A'], ['wx', 'answer3', 'B'], ['tg', 'answer4', 'C'],
    ]);
    assert.deepEqual(store.conversation.get('r2').origin, store.conversation.get('u2').origin);
  } finally { store.close(); await rm(home, { recursive: true, force: true }); }
});

test('explicit switch_channel routes a local Web message reply directly to bound WeChat channel', async () => {
  const home = await mkdtemp(join(tmpdir(), 'origin-switch-'));
  const coordinator = new Coordinator(home, offlineFactory(10));
  await coordinator.ready();
  try {
    const sent: any[] = [];
    coordinator.im.sendToChannel = async (...args: any[]) => { sent.push(args); };
    const now = Date.now();
    coordinator.store.saveImChannel({
      id: 'wechat-clawbot',
      platform: 'wechat',
      name: '微信个人号',
      accountId: 'bot@im.bot',
      enabled: true,
      notifyAll: true,
      defaultTarget: 'boss@im.wechat',
      contextTokens: { 'boss@im.wechat': 'ctx-boss-1' },
      allowedSenders: ['boss@im.wechat'],
      inboundCount: 0,
      outboundCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const msg = coordinator.chat('req-switch-wx', '接下来会在微信中，这条对话你在微信中回复', [], { channel: 'local' });
    for (let i = 0; i < 40; i++) {
      if (coordinator.store.conversation.get(msg.id).status === 'completed') break;
      await new Promise(r => setTimeout(r, 20));
    }
    await (coordinator.im as any).flushOutboundUpdates();

    const updatedUser = coordinator.store.conversation.get(msg.id);
    assert.equal(updatedUser.status, 'completed');
    assert.equal(updatedUser.origin?.channel, 'wechat');
    assert.equal(updatedUser.origin?.channelId, 'wechat-clawbot');
    assert.equal(updatedUser.origin?.conversationId, 'boss@im.wechat');
    assert.equal(updatedUser.routing?.actions[0]?.kind, 'switch_channel');
    assert.equal(updatedUser.routing?.actions[0]?.status, 'accepted');
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], 'wechat-clawbot');
    assert.match(sent[0][1], /已经切到 wechat 这边了/);
    assert.equal(sent[0][2].target, 'boss@im.wechat');
    assert.equal(sent[0][2].contextToken, 'ctx-boss-1');
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('send_file with inline content stages and delivers attachment in a single turn without spawning a worker', async () => {
  const home = await mkdtemp(join(tmpdir(), 'origin-sendfile-'));
  const coordinator = new Coordinator(home, offlineFactory(10));
  await coordinator.ready();
  try {
    const sentFiles: any[] = [];
    coordinator.im.sendWechatAttachment = async (...args: any[]) => { sentFiles.push(args); };
    const now = Date.now();
    coordinator.store.saveImChannel({
      id: 'wechat-clawbot',
      platform: 'wechat',
      name: '微信个人号',
      accountId: 'bot@im.bot',
      enabled: true,
      notifyAll: true,
      defaultTarget: 'boss@im.wechat',
      contextTokens: { 'boss@im.wechat': 'ctx-boss-2' },
      allowedSenders: ['boss@im.wechat'],
      inboundCount: 0,
      outboundCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const msg = coordinator.chat(
      'req-inline-file',
      '发送附件: audit-summary.md|# 核查纪要\n这是本轮直接随消息产出的附件正文。',
      [],
      { channel: 'wechat', channelId: 'wechat-clawbot', conversationId: 'boss@im.wechat', senderId: 'boss@im.wechat', contextToken: 'ctx-boss-2' },
    );
    for (let i = 0; i < 40; i++) {
      if (coordinator.store.conversation.get(msg.id).status === 'completed') break;
      await new Promise(r => setTimeout(r, 20));
    }

    assert.equal(sentFiles.length, 1);
    assert.equal(sentFiles[0][0], 'wechat-clawbot');
    assert.equal(sentFiles[0][1], 'audit-summary.md');
    assert.equal(sentFiles[0][2].target, 'boss@im.wechat');
    assert.equal(sentFiles[0][2].contextToken, 'ctx-boss-2');
    const staged = await readFile(join(home, 'wechat-files', 'audit-summary.md'), 'utf8');
    assert.equal(staged, '# 核查纪要\n这是本轮直接随消息产出的附件正文。');
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('WORKER_REPORT supports autonomous supplementary start_work, inspect_work, recall_messages, silent handoff, and bounded depth (max 2)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'origin-supplement-'));
  const coordinator = new Coordinator(home, offlineFactory(10));
  await coordinator.ready();
  try {
    const msg = coordinator.chat(
      'req-supplement-1',
      '派发: 搜索本机表格 [NEEDS_SUPPLEMENT: iCloud 云盘与外接卷]',
      [],
      { channel: 'local' },
    );
    for (let i = 0; i < 80; i++) {
      const works = coordinator.store.list();
      if (works.length >= 2 && works.every(w => w.status === 'completed')) break;
      await new Promise(r => setTimeout(r, 25));
    }

    const works = coordinator.store.list();
    assert.equal(works.length, 2);
    assert.equal(works[0]!.status, 'completed');
    assert.equal(works[1]!.status, 'completed');
    assert.equal(works[1]!.parentTaskId, works[0]!.id);
    assert.equal(works[1]!.originMessageId, msg.id);

    const history = coordinator.store.conversation.history(undefined, 20).items;
    const assistantReplies = history.filter(m => m.role === 'assistant' && m.replyTo === msg.id);
    // Only 2 assistant messages: initial CHAT dispatch ack + final WORKER_REPORT delivery (intermediate silent handoff is absorbed)
    assert.equal(assistantReplies.length, 2);
    assert.match(assistantReplies[1]!.text, /后台工作已交由 Router 汇总/);

    const updatedUser = coordinator.store.conversation.get(msg.id);
    const actionKinds = updatedUser.routing?.actions.map(a => a.kind) ?? [];
    assert.ok(actionKinds.includes('new_work'));
    assert.ok(actionKinds.includes('inspect'));
    assert.ok(actionKinds.includes('recall'));
    assert.ok(actionKinds.includes('related_work'));

    // Verify bounded auto-dispatch limit (max 2 autonomous supplementary dispatches per user message)
    const loopMsg = coordinator.chat(
      'req-supplement-bound',
      '派发: 深度排查 [INFINITE_SUPPLEMENT]',
      [],
      { channel: 'local' },
    );
    for (let i = 0; i < 100; i++) {
      const allWorks = coordinator.store.list().filter(w => w.originMessageId === loopMsg.id);
      if (allWorks.length === 3 && allWorks.every(w => w.status === 'completed')) break;
      await new Promise(r => setTimeout(r, 25));
    }
    const loopWorks = coordinator.store.list().filter(w => w.originMessageId === loopMsg.id);
    // 1 initial + 2 autonomous supplementary dispatches = 3 total tasks, then 3rd auto-dispatch is rejected
    assert.equal(loopWorks.length, 3);
    const loopReplies = coordinator.store.conversation.history(undefined, 20).items
      .filter(m => m.role === 'assistant' && m.replyTo === loopMsg.id);
    assert.equal(loopReplies.length, 2);
    assert.match(loopReplies[1]!.text, /已触发自动补查上限保护/);
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

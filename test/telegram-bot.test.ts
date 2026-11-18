import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Coordinator } from '../src/coordinator.js';
import { offlineFactory } from '../src/agent.js';
import { ImGateway, parseImSlashCommand, TELEGRAM_BOT_COMMANDS } from '../src/im.js';
import { parseTelegramUpdate, splitTelegramText } from '../src/im/channels/telegram.js';
import { Store } from '../src/store.js';
import { until } from './helpers/async.js';
import { withTempHome } from './helpers/tmp-home.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=',
  'base64',
);

function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface MockTelegramState {
  baseUrl: string;
  deleteWebhookCalls: Array<Record<string, unknown>>;
  setMyCommandsCalls: Array<Record<string, unknown>>;
  sentMessages: Array<Record<string, unknown>>;
  sentAnimations: Array<{ url: string; contentType: string; raw: Buffer }>;
  sentDocuments: Array<{ url: string; contentType: string; raw: Buffer }>;
  callbackAnswers: Array<Record<string, unknown>>;
  chatActions: Array<Record<string, unknown>>;
  getFileCalls: string[];
  queuedUpdates: Array<Record<string, unknown>>;
  failDeleteWebhook: boolean;
  failSetMyCommands: boolean;
  failSendAnimation: boolean;
  failChatAction: boolean;
  close(): Promise<void>;
}

async function startMockTelegramServer(): Promise<MockTelegramState> {
  let msgSeq = 100;
  const state: Omit<MockTelegramState, 'baseUrl' | 'close'> = {
    deleteWebhookCalls: [],
    setMyCommandsCalls: [],
    sentMessages: [],
    sentAnimations: [],
    sentDocuments: [],
    callbackAnswers: [],
    chatActions: [],
    getFileCalls: [],
    queuedUpdates: [],
    failDeleteWebhook: false,
    failSetMyCommands: false,
    failSendAnimation: false,
    failChatAction: false,
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';
    const rawBuf = req.method === 'POST' ? await readBodyBuffer(req) : Buffer.alloc(0);
    const rawText = rawBuf.toString('utf8');

    if (url.includes('/bot999:bad-secret-token/getMe')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, description: 'Unauthorized for /bot999:bad-secret-token/getMe' }));
      return;
    }

    if (/\/bot[^/]+\/getMe(?:\?|$)/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        result: { id: 777001, is_bot: true, first_name: 'F.R.I.D.A.Y.', username: 'FridayTestBot' },
      }));
      return;
    }

    if (/\/bot[^/]+\/deleteWebhook(?:\?|$)/.test(url)) {
      state.deleteWebhookCalls.push(JSON.parse(rawText || '{}') as Record<string, unknown>);
      if (state.failDeleteWebhook) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, description: 'Not found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }

    if (/\/bot[^/]+\/setMyCommands(?:\?|$)/.test(url)) {
      state.setMyCommandsCalls.push(JSON.parse(rawText || '{}') as Record<string, unknown>);
      if (state.failSetMyCommands) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, description: 'Upstream setMyCommands error' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }

    if (/\/bot[^/]+\/getUpdates(?:\?|$)/.test(url)) {
      const parsed = new URL(url, 'http://127.0.0.1');
      const offset = Number(parsed.searchParams.get('offset') ?? '0');
      const batch = state.queuedUpdates.filter(u => Number(u.update_id) >= offset);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: batch }));
      return;
    }

    if (/\/bot[^/]+\/sendMessage(?:\?|$)/.test(url)) {
      state.sentMessages.push(JSON.parse(rawText || '{}') as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: ++msgSeq } }));
      return;
    }

    if (/\/bot[^/]+\/sendAnimation(?:\?|$)/.test(url)) {
      if (state.failSendAnimation) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, description: 'Not Found' }));
        return;
      }
      state.sentAnimations.push({
        url,
        contentType: String(req.headers['content-type'] ?? ''),
        raw: rawBuf,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: ++msgSeq } }));
      return;
    }

    if (/\/bot[^/]+\/sendDocument(?:\?|$)/.test(url)) {
      state.sentDocuments.push({
        url,
        contentType: String(req.headers['content-type'] ?? ''),
        raw: rawBuf,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { message_id: ++msgSeq } }));
      return;
    }

    if (/\/bot[^/]+\/answerCallbackQuery(?:\?|$)/.test(url)) {
      state.callbackAnswers.push(JSON.parse(rawText || '{}') as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }

    if (/\/bot[^/]+\/sendChatAction(?:\?|$)/.test(url)) {
      state.chatActions.push(JSON.parse(rawText || '{}') as Record<string, unknown>);
      if (state.failChatAction) {
        res.writeHead(500);
        res.end('fail');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }

    if (/\/bot[^/]+\/getFile(?:\?|$)/.test(url)) {
      const parsed = new URL(url, 'http://127.0.0.1');
      const fileId = parsed.searchParams.get('file_id') ?? '';
      state.getFileCalls.push(fileId);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        result: { file_id: fileId, file_path: 'photos/pic-1.png', file_size: PNG_1X1.length },
      }));
      return;
    }

    if (/\/file\/bot[^/]+\/photos\/pic-1\.png$/.test(url)) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG_1X1.length) });
      res.end(PNG_1X1);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  return Object.assign(state, {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  });
}

test('parseImSlashCommand, parseTelegramUpdate, and splitTelegramText handle normalization, media, callback_query, and chunking', () => {
  assert.deepEqual(parseImSlashCommand('/status@FridayBot'), {
    command: '/status',
    arg: '',
    normalized: '/status',
  });
  assert.deepEqual(parseImSlashCommand('  /START@MyBot  ref_42  '), {
    command: '/start',
    arg: 'ref_42',
    normalized: '/start ref_42',
  });
  assert.deepEqual(parseImSlashCommand('/file@MyBot report.md'), {
    command: '/file',
    arg: 'report.md',
    normalized: '/file report.md',
  });
  assert.equal(parseImSlashCommand('/usr/local/bin'), undefined);

  const cbInbound = parseTelegramUpdate('tg-1', {
    update_id: 10,
    callback_query: {
      id: 'cb-77',
      from: { id: 9001, first_name: 'Tony', username: 'tonystark' },
      message: { message_id: 50, chat: { id: -100999 } },
      data: '/works',
    },
  });
  assert.deepEqual(cbInbound, {
    channelId: 'tg-1',
    externalId: 'cq:cb-77',
    senderId: '9001',
    senderName: 'Tony',
    senderUsername: 'tonystark',
    target: '-100999',
    text: '/works',
    callbackQueryId: 'cb-77',
  });

  const photoInbound = parseTelegramUpdate('tg-1', {
    update_id: 11,
    edited_message: {
      message_id: 51,
      from: { id: 9001, first_name: 'Tony' },
      chat: { id: 9001 },
      photo: [
        { file_id: 'small-id', width: 90, height: 90, file_size: 100 },
        { file_id: 'large-id', width: 1280, height: 720, file_size: 9000 },
        { file_id: 'med-id', width: 320, height: 320, file_size: 800 },
      ],
    },
  });
  assert.ok(photoInbound);
  assert.equal(photoInbound.text, '请查看收到的附件。');
  assert.deepEqual(photoInbound.telegramMedia, [
    { kind: 'image', fileId: 'large-id', fileName: 'photo.jpg', mimeType: 'image/jpeg', fileSize: 9000 },
  ]);

  const docInbound = parseTelegramUpdate('tg-1', {
    update_id: 12,
    message: {
      message_id: 52,
      from: { id: 9001 },
      chat: { id: 9001 },
      caption: '请分析这份文件',
      document: { file_id: 'doc-1', file_name: 'spec.pdf', mime_type: 'application/pdf', file_size: 2048 },
    },
  });
  assert.equal(docInbound?.text, '请分析这份文件');
  assert.deepEqual(docInbound?.telegramMedia, [
    { kind: 'file', fileId: 'doc-1', fileName: 'spec.pdf', mimeType: 'application/pdf', fileSize: 2048 },
  ]);

  const imgDocInbound = parseTelegramUpdate('tg-1', {
    update_id: 13,
    message: {
      message_id: 53,
      from: { id: 9001 },
      chat: { id: 9001 },
      document: { file_id: 'doc-img', file_name: 'diagram.webp', mime_type: 'image/webp' },
    },
  });
  assert.equal(imgDocInbound?.telegramMedia?.[0]?.kind, 'image');

  const paraA = '第一段分析内容。'.repeat(280);
  const paraB = '第二段汇总内容。'.repeat(280);
  const longText = `${paraA}\n\n${paraB}\n\n结尾结论。`;
  const chunks = splitTelegramText(longText, 4000);
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0 && chunk.length <= 4000);
  }
  assert.ok(chunks.join('\n').includes('结尾结论。'));
});

test('quickConnectTelegram, syncTelegramCommands, loginStatus, and error redaction', async () => {
  await withTempHome('friday-tg-quick-', async home => {
    const mock = await startMockTelegramServer();
    const store = new Store(home);
    const gateway = new ImGateway({ store } as any);
    try {
      await assert.rejects(
        gateway.quickConnectTelegram({ botToken: 'invalid-token-no-colon', apiBase: mock.baseUrl }),
        /格式无效/,
      );
      await assert.rejects(
        gateway.quickConnectTelegram({ botToken: '999:bad-secret-token', apiBase: mock.baseUrl }),
        (err: Error) => {
          assert.doesNotMatch(err.message, /bad-secret-token/);
          return true;
        },
      );

      const quick = await gateway.quickConnectTelegram({
        botToken: '123456:SECRET-BOT-TOKEN-XYZ',
        apiBase: mock.baseUrl,
        allowedSenders: ['9001', '@tonystark'],
      });
      assert.equal(quick.ok, true);
      assert.equal(quick.bot.id, 777001);
      assert.equal(quick.bot.username, 'FridayTestBot');
      assert.equal(quick.bot.firstName, 'F.R.I.D.A.Y.');
      assert.equal(quick.webhookCleared, true);
      assert.equal(quick.commandsRegistered, true);
      assert.equal(quick.channel.platform, 'telegram');
      assert.equal(quick.channel.name, 'F.R.I.D.A.Y.');
      assert.equal(quick.channel.accountId, '@FridayTestBot');
      assert.equal(quick.channel.enabled, true);
      assert.equal(quick.channel.hasBotToken, true);
      assert.equal(quick.channel.loginStatus, 'bound');
      assert.equal(mock.deleteWebhookCalls.length, 1);
      assert.equal(mock.setMyCommandsCalls.length, 1);
      assert.deepEqual(mock.setMyCommandsCalls[0]!.commands, TELEGRAM_BOT_COMMANDS);

      const synced = await gateway.syncTelegramCommands(quick.channel.id);
      assert.equal(synced.ok, true);
      assert.equal(synced.count, TELEGRAM_BOT_COMMANDS.length);
      assert.equal(mock.setMyCommandsCalls.length, 2);

      // Non-fatal deleteWebhook / setMyCommands failures still complete quickConnect
      mock.failDeleteWebhook = true;
      mock.failSetMyCommands = true;
      const degraded = await gateway.quickConnectTelegram({
        id: 'tg-degraded',
        botToken: '123456:DEGRADED-TOKEN-999',
        apiBase: mock.baseUrl,
      });
      assert.equal(degraded.ok, true);
      assert.equal(degraded.webhookCleared, false);
      assert.equal(degraded.commandsRegistered, false);
      assert.ok(degraded.commandsError);
      assert.doesNotMatch(degraded.commandsError, /DEGRADED-TOKEN-999/);
    } finally {
      await gateway.close();
      store.close();
      await mock.close();
    }
  });
});

test('Telegram slash commands, inline keyboards, callback_query, chunking, stickers, inbound photo, typing, /file and send_file', async () => {
  await withTempHome('friday-tg-full-', async home => {
    const mock = await startMockTelegramServer();
    const coordinator = new Coordinator(home, Object.assign(offlineFactory(15), { nativeTools: true }));
    await coordinator.ready();

    try {
      const quick = await coordinator.im.quickConnectTelegram({
        id: 'tg-main',
        botToken: '123456:MAIN-TG-TOKEN',
        apiBase: mock.baseUrl,
        allowedSenders: ['9001', '@tonystark'],
      });
      const channelId = quick.channel.id;
      const now = Date.now();

      // 1. /start@FridayTestBot payload -> binds Chat ID & returns Inline Keyboard
      const startRes = await coordinator.im.ingestMessage(parseTelegramUpdate(channelId, {
        update_id: 1001,
        message: {
          message_id: 1,
          from: { id: 9001, first_name: 'Tony', username: 'tonystark' },
          chat: { id: 9001 },
          text: '/start@FridayTestBot deep-link-42',
        },
      })!);
      assert.equal(startRes.action, 'command_start');
      assert.equal(coordinator.store.getImChannel(channelId).defaultTarget, '9001');
      const startMsg = mock.sentMessages.at(-1)!;
      assert.match(String(startMsg.text), /F\.R\.I\.D\.A\.Y\./);
      assert.match(String(startMsg.text), /9001/);
      assert.match(String(startMsg.text), /deep-link-42/);
      assert.deepEqual((startMsg.reply_markup as { inline_keyboard: unknown }).inline_keyboard, [
        [
          { text: '📊 运行状态', callback_data: '/status' },
          { text: '💰 今日用量', callback_data: '/usage' },
        ],
        [
          { text: '📋 后台任务', callback_data: '/works' },
          { text: '🧠 全局记忆', callback_data: '/memories' },
        ],
        [
          { text: '⏱️ 定时巡检', callback_data: '/timers' },
          { text: '❓ 帮助', callback_data: '/help' },
        ],
      ]);
      // Instant slash commands must NOT trigger sendChatAction
      assert.equal(mock.chatActions.length, 0);

      // 2. /help, /id, /status@FridayTestBot, /models
      assert.equal((await coordinator.im.ingestMessage(parseTelegramUpdate(channelId, {
        update_id: 1002,
        message: { message_id: 2, from: { id: 9001, username: 'tonystark' }, chat: { id: 9001 }, text: '/help@FridayTestBot' },
      })!)).action, 'command_help');
      assert.match(String(mock.sentMessages.at(-1)!.text), /常用命令指南/);

      assert.equal((await coordinator.im.ingestMessage(parseTelegramUpdate(channelId, {
        update_id: 1003,
        message: { message_id: 3, from: { id: 9001, first_name: 'Tony', username: 'tonystark' }, chat: { id: 9001 }, text: '/id' },
      })!)).action, 'command_id');
      const idText = String(mock.sentMessages.at(-1)!.text);
      assert.match(idText, /Chat ID: 9001/);
      assert.match(idText, /User ID: 9001/);
      assert.match(idText, /@tonystark/);

      assert.equal((await coordinator.im.ingestMessage(parseTelegramUpdate(channelId, {
        update_id: 1004,
        message: { message_id: 4, from: { id: 9001 }, chat: { id: 9001 }, text: '/status@FridayTestBot' },
      })!)).action, 'command_status');
      assert.match(String(mock.sentMessages.at(-1)!.text), /FRIDAY 全息态势简报/);

      assert.equal((await coordinator.im.ingestMessage(parseTelegramUpdate(channelId, {
        update_id: 1005,
        message: { message_id: 5, from: { id: 9001 }, chat: { id: 9001 }, text: '/models' },
      })!)).action, 'command_models');
      assert.match(String(mock.sentMessages.at(-1)!.text), /主控路由/);

      // 3. /usage (with structured queryUsage)
      const origQueryUsage = (coordinator.store as any).queryUsage;
      (coordinator.store as any).queryUsage = () => ({
        periodLabel: '2026-11-18 (今天)',
        todayDate: '2026-11-18',
        prefs: { currency: 'CNY', usdToCnyRate: 7.25 },
        totals: {
          calls: 6,
          successCalls: 6,
          failedCalls: 0,
          inputTokens: 10000,
          outputTokens: 2000,
          cacheReadTokens: 3000,
          cacheWriteTokens: 0,
          totalTokens: 15000,
          costUsd: 0.025,
          costCny: 0.1813,
        },
        byModel: [
          { spec: 'google/gemini-2.5-pro', calls: 4, totalTokens: 12000, costUsd: 0.02, costCny: 0.145 },
        ],
      });
      try {
        assert.equal((await coordinator.im.ingestMessage(parseTelegramUpdate(channelId, {
          update_id: 1006,
          message: { message_id: 6, from: { id: 9001 }, chat: { id: 9001 }, text: '/usage' },
        })!)).action, 'command_usage');
        const usageText = String(mock.sentMessages.at(-1)!.text);
        assert.match(usageText, /6 次/);
        assert.match(usageText, /15,000/);
        assert.match(usageText, /¥0\.1813/);
        assert.match(usageText, /\$0\.0250/);
        assert.match(usageText, /google\/gemini-2\.5-pro/);
      } finally {
        (coordinator.store as any).queryUsage = origQueryUsage;
      }

      // 4. /works + argumentless /stop + callback_query + answerCallbackQuery
      const origin = {
        channel: 'telegram' as const,
        channelId,
        accountId: '@FridayTestBot',
        conversationId: '9001',
        senderId: '9001',
      };
      coordinator.store.create({
        id: 'aaaa1111-0000-4000-8000-000000000001',
        requestId: 'req-tg-task-a',
        fingerprint: 'fp-a',
        prompt: '编译模块 Alpha',
        status: 'running',
        revision: 0,
        files: [],
        mode: 'offline',
        createdAt: now,
        limitMs: 60_000,
        activeMs: 0,
        origin,
      });
      coordinator.store.create({
        id: 'bbbb2222-0000-4000-8000-000000000002',
        requestId: 'req-tg-task-b',
        fingerprint: 'fp-b',
        prompt: '审计模块 Beta',
        status: 'running',
        revision: 0,
        files: [],
        mode: 'offline',
        createdAt: now + 1,
        limitMs: 60_000,
        activeMs: 0,
        origin,
      });

      assert.equal((await coordinator.im.ingestMessage(parseTelegramUpdate(channelId, {
        update_id: 1007,
        message: { message_id: 7, from: { id: 9001 }, chat: { id: 9001 }, text: '/works' },
      })!)).action, 'command_works');
      const worksMsg = mock.sentMessages.at(-1)!;
      assert.match(String(worksMsg.text), /aaaa1111/);
      const worksButtons = ((worksMsg.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard).flat();
      assert.ok(worksButtons.some(b => b.callback_data === '/stop aaaa1111'));
      assert.ok(worksButtons.some(b => b.callback_data === '/stop bbbb2222'));

      // Argumentless /stop with 2 running tasks asks to select with buttons
      assert.equal((await coordinator.im.ingestMessage(parseTelegramUpdate(channelId, {
        update_id: 1008,
        message: { message_id: 8, from: { id: 9001 }, chat: { id: 9001 }, text: '/stop' },
      })!)).action, 'command_stop_select');

      // Callback query stops task A and triggers answerCallbackQuery
      const cbRes = await coordinator.im.ingestMessage(parseTelegramUpdate(channelId, {
        update_id: 1009,
        callback_query: {
          id: 'cq-stop-aaaa',
          from: { id: 9001, username: 'tonystark' },
          message: { message_id: 8, chat: { id: 9001 } },
          data: '/stop aaaa1111',
        },
      })!);
      assert.equal(cbRes.action, 'command_stop');
      await until(() => mock.callbackAnswers.some(a => a.callback_query_id === 'cq-stop-aaaa'));
      assert.equal(coordinator.store.get('aaaa1111-0000-4000-8000-000000000001').status, 'cancelled');

      // Argumentless /stop with 1 remaining running task stops task B directly
      assert.equal((await coordinator.im.ingestMessage(parseTelegramUpdate(channelId, {
        update_id: 1010,
        message: { message_id: 9, from: { id: 9001 }, chat: { id: 9001 }, text: '/stop' },
      })!)).action, 'command_stop');
      assert.equal(coordinator.store.get('bbbb2222-0000-4000-8000-000000000002').status, 'cancelled');

      // Argumentless /stop with 0 active tasks
      assert.equal((await coordinator.im.ingestMessage(parseTelegramUpdate(channelId, {
        update_id: 1011,
        message: { message_id: 10, from: { id: 9001 }, chat: { id: 9001 }, text: '/stop' },
      })!)).action, 'command_stop_empty');

      // 5. /sticker happy sends GIF via sendAnimation, and degrades to emoji when sendAnimation fails
      assert.equal((await coordinator.im.ingestMessage(parseTelegramUpdate(channelId, {
        update_id: 1012,
        message: { message_id: 11, from: { id: 9001 }, chat: { id: 9001 }, text: '/sticker happy' },
      })!)).action, 'command_sticker');
      assert.equal(mock.sentAnimations.length, 1);
      assert.ok(mock.sentAnimations[0]!.raw.includes('GIF89a'));

      mock.failSendAnimation = true;
      const beforeFallbackCount = mock.sentMessages.length;
      await coordinator.im.sendToChannel(channelId, '收到 [bot:happy] [[sticker:calm]]', { target: '9001' });
      assert.equal(mock.sentMessages.length, beforeFallbackCount + 2);
      assert.equal(mock.sentMessages[beforeFallbackCount]!.text, '收到 😄');
      assert.equal(mock.sentMessages[beforeFallbackCount + 1]!.text, '😌');
      mock.failSendAnimation = false;

      // 6. Long message > 4000 chars splits and attaches reply_markup only on final chunk
      const beforeChunkCount = mock.sentMessages.length;
      const hugeText = `${'分析章节一。'.repeat(700)}\n\n${'分析章节二。'.repeat(700)}`;
      await coordinator.im.sendToChannel(channelId, hugeText, {
        target: '9001',
        replyToMessageId: '77',
        replyMarkup: { inline_keyboard: [[{ text: '确认', callback_data: '/status' }]] },
      });
      const chunkMsgs = mock.sentMessages.slice(beforeChunkCount);
      assert.ok(chunkMsgs.length >= 2);
      assert.equal(chunkMsgs[0]!.reply_to_message_id, 77);
      assert.equal(chunkMsgs[0]!.reply_markup, undefined);
      assert.ok(chunkMsgs.at(-1)!.reply_markup);
      for (const m of chunkMsgs) {
        assert.ok(String(m.text).length <= 4000);
      }

      // Unauthorized sender is rejected without triggering downloadMedia or answerCallbackQuery
      const beforeUnauthorizedGetFile = mock.getFileCalls.length;
      const beforeUnauthorizedCb = mock.callbackAnswers.length;
      const unauthRes = await coordinator.im.ingestMessage(parseTelegramUpdate(channelId, {
        update_id: 10125,
        callback_query: {
          id: 'cq-unauth',
          from: { id: 8888, username: 'stranger' },
          message: { message_id: 87, chat: { id: 8888 } },
          data: '/status',
        },
      })!);
      assert.equal(unauthRes.ok, false);
      assert.equal(unauthRes.reason, 'sender_not_allowed');
      assert.equal(mock.getFileCalls.length, beforeUnauthorizedGetFile);
      assert.equal(mock.callbackAnswers.length, beforeUnauthorizedCb);

      // 7. Inbound photo download + sendChatAction typing indicator (and silent 500 handling)
      mock.failChatAction = true;
      const photoRes = await coordinator.im.ingestMessage(parseTelegramUpdate(channelId, {
        update_id: 1013,
        message: {
          message_id: 88,
          from: { id: 9001, username: 'tonystark' },
          chat: { id: 9001 },
          caption: '请查看这张截图',
          photo: [
            { file_id: 'tg-photo-small', width: 90, height: 90, file_size: 40 },
            { file_id: 'tg-photo-big', width: 800, height: 600, file_size: PNG_1X1.length },
          ],
        },
      })!);
      assert.equal(photoRes.action, 'routed_to_chat');
      assert.ok(mock.getFileCalls.includes('tg-photo-big'));
      assert.ok(mock.chatActions.some(a => a.chat_id === '9001' && a.action === 'typing'));
      const storedPhotoMsg = coordinator.store.conversation.get(photoRes.messageId!);
      assert.equal(storedPhotoMsg.attachments?.length, 1);
      const savedImg = storedPhotoMsg.attachments![0]!;
      assert.equal(savedImg.kind, 'image');
      assert.equal(savedImg.status, 'ready');
      assert.equal(savedImg.mimeType, 'image/png');
      assert.ok(savedImg.path);
      assert.deepEqual(await readFile(savedImg.path!), PNG_1X1);
      const imgMode = (await stat(savedImg.path!)).mode & 0o777;
      assert.equal(imgMode, 0o600);
      await until(() => coordinator.store.conversation.get(photoRes.messageId!).status === 'completed');
      await until(() => coordinator.store.list().every(w => !['queued', 'running'].includes(w.status)));

      // 8. /file <filename> sends staged document via sendDocument
      const outboxDir = join(home, 'wechat-files');
      await mkdir(outboxDir, { recursive: true, mode: 0o700 });
      await writeFile(join(outboxDir, 'staged-note.txt'), 'Telegram staged attachment body', { mode: 0o600 });
      const fileCmdRes = await coordinator.im.ingestMessage(parseTelegramUpdate(channelId, {
        update_id: 1014,
        message: {
          message_id: 89,
          from: { id: 9001, username: 'tonystark' },
          chat: { id: 9001 },
          text: '/file staged-note.txt',
        },
      })!);
      assert.equal(fileCmdRes.action, 'attachment_sent');
      assert.equal(mock.sentDocuments.length, 1);
      assert.ok(mock.sentDocuments[0]!.raw.toString('utf8').includes('Telegram staged attachment body'));

      // 9. Router send_file tool works on Telegram origin and local fallback to Telegram
      const sendFileTg = coordinator.chat(
        'req-tg-sendfile-1',
        '发送附件: tg-report.md|# Telegram 报告\n多通道导出测试',
        [],
        origin,
      );
      await until(() => coordinator.store.conversation.get(sendFileTg.id).status === 'completed');
      await until(() => mock.sentDocuments.length >= 2);
      assert.ok(mock.sentDocuments[1]!.raw.toString('utf8').includes('多通道导出测试'));

      const sendFileLocal = coordinator.chat(
        'req-tg-sendfile-2',
        '发送附件: local-to-tg.md|本地会话自动路由至 Telegram 附件',
        [],
        { channel: 'local' },
      );
      await until(() => coordinator.store.conversation.get(sendFileLocal.id).status === 'completed');
      await until(() => mock.sentDocuments.length >= 3);
      assert.ok(mock.sentDocuments[2]!.raw.toString('utf8').includes('本地会话自动路由至 Telegram 附件'));
    } finally {
      await coordinator.close();
      await mock.close();
    }
  });
});

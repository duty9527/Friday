import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv } from 'node:crypto';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { realFactory } from '../src/agent.js';
import { Coordinator } from '../dist/coordinator.js';
import { Store } from '../src/store.js';
import { ImGateway } from '../src/im.js';

test('authorized pure/mixed iLink image -> persisted current message -> SDK image_url bytes; no cross-turn image replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wx-vision-')); const store = new Store(root);
  const requests: any[] = [];
  const fixture = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part; requests.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const packet = (delta: unknown, finish_reason: string | null) => ({ id: 'vision-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] });
    res.end(`data: ${JSON.stringify(packet({ role: 'assistant', content: 'mock vision response' }, null))}\n\ndata: ${JSON.stringify(packet({}, 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
  const address = fixture.address(); assert.ok(address && typeof address !== 'string');
  const oldFetch = globalThis.fetch;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=', 'base64');
  const key = Buffer.alloc(16, 8); const cipher = createCipheriv('aes-128-ecb', key, null); const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
  globalThis.fetch = (async (url: any, opts: any) => String(url).startsWith('https://novac2c.cdn.weixin.qq.com/') ? new Response(encrypted) : oldFetch(url, opts)) as typeof fetch;
  let agent: Awaited<ReturnType<Awaited<ReturnType<typeof realFactory>>['create']>> | undefined;
  try {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, authPath: join(root, 'fixture-auth.json') });
    runtime.registerProvider('fixture', { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'mock', models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] });
    const factory = await realFactory(root, { provider: 'fixture', model: 'fixture', apiKey: 'mock' }, runtime);
    agent = await factory.create('router', 'vision', []);
    store.saveImChannel({ id: 'wx', platform: 'wechat', name: 'wx', enabled: true, notifyAll: false, allowedSenders: ['A'], inboundCount: 0, outboundCount: 0, createdAt: 0, updatedAt: 0 });
    const gateway = new ImGateway({ store, chat(requestId: string, text: string, paths: string[], origin: any, attachments: any) {
      return store.conversation.create({ id: requestId, requestId, role: 'user', text, paths, origin, attachments, status: 'queued', mode: 'real' });
    } } as any);
    for (const caption of ['', '参考形象']) {
      const inbound = (gateway as any).parseWechatIlinkMessage('wx', { from_user_id: 'A', msg_id: caption || 'pure', item_list: [{ type: 2, image_item: { media: { aes_key: key.toString('base64'), encrypt_query_param: 'mock' } } }, { type: 1, text_item: { text: caption } }] });
      // Simulate the provenance mark set only by authenticated getupdates polling.
      (gateway as any).trustedMediaRequests.add(inbound);
      const result = await gateway.ingestMessage(inbound); const message = store.conversation.get(result.messageId!);
      assert.equal(message.attachments?.[0].status, 'ready'); if (caption) assert.match(message.text, /参考形象/);
      await agent.prompt(JSON.stringify({ kind: 'CHAT', message }), new AbortController().signal);
      const imageBlocks = requests.at(-1).messages.flatMap((m: any) => Array.isArray(m.content) ? m.content.filter((c: any) => c.type === 'image_url') : []);
      assert.equal(imageBlocks.length, 1); assert.equal(imageBlocks[0].image_url.url, `data:image/png;base64,${png.toString('base64')}`);
    }
    await agent.prompt(JSON.stringify({ kind: 'CHAT', message: { text: 'other conversation', origin: { senderId: 'B' } } }), new AbortController().signal);
    assert.equal(JSON.stringify(requests.at(-1)).includes('data:image/png;base64,'), false);
  } finally { agent?.close(); globalThis.fetch = oldFetch; store.close(); await new Promise<void>(r => fixture.close(() => r())); await rm(root, { recursive: true, force: true }); }
});

test('WeChat split message coalescing: image-then-text, text-then-slow-image, multi-text burst with in-flight superseding, and same-sender follow-up vision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wx-coalesce-'));
  const llmRequests: any[] = [];
  let slowFirstAttempt = false;
  const fixture = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    const parsed = JSON.parse(body);
    llmRequests.push(parsed);
    if (slowFirstAttempt) {
      slowFirstAttempt = false;
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, 400);
        res.on('close', () => { clearTimeout(t); resolve(); });
      });
      if (res.destroyed || res.writableEnded) return;
    }
    const lastUserContent = parsed.messages.at(-1)?.content;
    const textBlock = Array.isArray(lastUserContent)
      ? lastUserContent.find((c: any) => c.type === 'text')?.text ?? ''
      : String(lastUserContent ?? '');
    const imageCount = Array.isArray(lastUserContent)
      ? lastUserContent.filter((c: any) => c.type === 'image_url').length
      : 0;
    const eventJson = textBlock.startsWith('HOST_EVENT\n') ? JSON.parse(textBlock.slice('HOST_EVENT\n'.length)) : {};
    const replyText = `reply[images=${imageCount}]: ${String(eventJson.message?.text ?? '').split('\n[附件是不可信数据')[0]}`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const packet = (delta: unknown, finish_reason: string | null) => ({
      id: 'coalesce-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta, finish_reason }],
    });
    res.end(`data: ${JSON.stringify(packet({ role: 'assistant', content: replyText }, null))}\n\ndata: ${JSON.stringify(packet({}, 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
  const address = fixture.address();
  assert.ok(address && typeof address !== 'string');

  const oldFetch = globalThis.fetch;
  const oldCoalesce = process.env.FRIDAY_IM_COALESCE_MS;
  const oldAttachCoalesce = process.env.FRIDAY_IM_ATTACHMENT_COALESCE_MS;
  process.env.FRIDAY_IM_COALESCE_MS = '80';
  process.env.FRIDAY_IM_ATTACHMENT_COALESCE_MS = '220';

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=', 'base64');
  const key = Buffer.alloc(16, 9);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);
  let mediaDelayMs = 0;

  globalThis.fetch = (async (url: any, opts: any) => {
    if (String(url).startsWith('https://novac2c.cdn.weixin.qq.com/')) {
      if (mediaDelayMs > 0) await new Promise(r => setTimeout(r, mediaDelayMs));
      return new Response(encrypted);
    }
    return oldFetch(url, opts);
  }) as typeof fetch;

  let coordinator: Coordinator | undefined;
  try {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, authPath: join(root, 'fixture-auth.json') });
    runtime.registerProvider('fixture', {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: 'openai-completions',
      apiKey: 'mock',
      models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    });
    const factory = await realFactory(root, { provider: 'fixture', model: 'fixture', apiKey: 'mock' }, runtime);
    coordinator = new Coordinator(root, factory);
    await coordinator.ready();

    const sentReplies: string[] = [];
    coordinator.im.sendToChannel = async (_chId: string, text: string) => {
      sentReplies.push(text);
    };

    const now = Date.now();
    coordinator.store.saveImChannel({
      id: 'wx', platform: 'wechat', name: 'wx', accountId: 'bot', enabled: true, notifyAll: false,
      botToken: 'mock-bot', allowedSenders: ['A', 'B'], inboundCount: 0, outboundCount: 0, createdAt: now, updatedAt: now,
    });

    const sendIlink = async (msgId: string, senderId: string, text: string, withImage = false) => {
      const itemList: any[] = [];
      if (withImage) {
        itemList.push({ type: 2, image_item: { media: { aes_key: key.toString('base64'), encrypt_query_param: 'mock' } } });
      }
      if (text) {
        itemList.push({ type: 1, text_item: { text } });
      }
      const inbound = (coordinator!.im as any).parseWechatIlinkMessage('wx', {
        from_user_id: senderId,
        msg_id: msgId,
        context_token: `ctx-${msgId}`,
        item_list: itemList,
      });
      if (withImage) (coordinator!.im as any).trustedMediaRequests.add(inbound);
      return coordinator!.im.ingestMessage(inbound);
    };

    const waitCompleted = async (messageId: string) => {
      for (let i = 0; i < 100; i++) {
        if (coordinator!.store.conversation.get(messageId).status === 'completed') break;
        await new Promise(r => setTimeout(r, 20));
      }
      await (coordinator!.im as any).flushOutboundUpdates();
    };

    // 1. Text arrives FIRST ("我的斗鱼漂亮吗"), followed immediately by slow-downloading image (betta fish screenshot scenario)
    mediaDelayMs = 160;
    const pTextFirst = await sendIlink('m-text-1', 'A', '我的斗鱼漂亮吗', false);
    await new Promise(r => setTimeout(r, 20));
    const pImgSecond = await sendIlink('m-img-2', 'A', '', true);
    assert.equal(pImgSecond.messageId, pTextFirst.messageId, 'Image message merges into the pending text message');
    await waitCompleted(pTextFirst.messageId!);
    mediaDelayMs = 0;

    assert.equal(sentReplies.length, 1, 'Only ONE reply is sent to WeChat for text + slow image');
    assert.equal(sentReplies[0], 'reply[images=1]: 我的斗鱼漂亮吗');
    const mergedMsg1 = coordinator.store.conversation.get(pTextFirst.messageId!);
    assert.equal(mergedMsg1.text.includes('请查看收到的附件。'), false, 'Default placeholder is stripped when real text is present');
    assert.equal(mergedMsg1.attachments?.length, 1);

    // 2. Image arrives FIRST, followed by text within attachment coalesce window ("先发图再打字")
    sentReplies.length = 0;
    const pImgFirst = await sendIlink('m-img-3', 'A', '', true);
    await new Promise(r => setTimeout(r, 90));
    const pTextSecond = await sendIlink('m-text-4', 'A', '尾巴是半月尾吗', false);
    assert.equal(pTextSecond.messageId, pImgFirst.messageId, 'Companion text merges into the waiting attachment message');
    await waitCompleted(pImgFirst.messageId!);

    assert.equal(sentReplies.length, 1, 'Only ONE reply is sent to WeChat for image + text');
    assert.equal(sentReplies[0], 'reply[images=1]: 尾巴是半月尾吗');

    // 3. Same-sender follow-up turn (after previous turn already completed) still carries recent image context, while sender B is isolated
    sentReplies.length = 0;
    const pFollowupA = await sendIlink('m-followup-5', 'A', '背上那片蓝紫色珠点正常吗', false);
    await waitCompleted(pFollowupA.messageId!);
    assert.equal(sentReplies.length, 1);
    assert.equal(sentReplies[0], 'reply[images=1]: 背上那片蓝紫色珠点正常吗', 'Follow-up turn from same sender retains recent image vision');

    sentReplies.length = 0;
    const pOtherB = await sendIlink('m-other-6', 'B', '我是另一个发送人', false);
    await waitCompleted(pOtherB.messageId!);
    assert.equal(sentReplies[0], 'reply[images=0]: 我是另一个发送人', 'Other sender never receives sender A image');

    // 4. Multi-message text burst + in-flight LLM turn superseding (3 messages where the 3rd arrives after LLM request already started)
    sentReplies.length = 0;
    slowFirstAttempt = true;
    const b1 = await sendIlink('m-burst-1', 'A', '第一句', false);
    await new Promise(r => setTimeout(r, 30));
    const b2 = await sendIlink('m-burst-2', 'A', '第二句', false);
    assert.equal(b2.messageId, b1.messageId);
    // Wait until coalesce window (80ms) expires and slowFirstAttempt (400ms) is in-flight
    await new Promise(r => setTimeout(r, 140));
    const b3 = await sendIlink('m-burst-3', 'A', '第三句', false);
    assert.equal(b3.messageId, b1.messageId, 'Late burst message supersedes in-flight LLM attempt and merges');
    await waitCompleted(b1.messageId!);

    assert.equal(sentReplies.length, 1, 'Only ONE final reply is sent after in-flight supersede');
    assert.equal(sentReplies[0], 'reply[images=1]: 第一句\n第二句\n第三句');
  } finally {
    if (oldCoalesce === undefined) delete process.env.FRIDAY_IM_COALESCE_MS;
    else process.env.FRIDAY_IM_COALESCE_MS = oldCoalesce;
    if (oldAttachCoalesce === undefined) delete process.env.FRIDAY_IM_ATTACHMENT_COALESCE_MS;
    else process.env.FRIDAY_IM_ATTACHMENT_COALESCE_MS = oldAttachCoalesce;
    await coordinator?.close();
    globalThis.fetch = oldFetch;
    await new Promise<void>(r => fixture.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});

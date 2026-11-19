import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chunkWechatText,
  filterWechatMarkdown,
  planWechatRichContent,
  renderMarkdownTables,
  StreamingMarkdownFilter,
} from '../src/wechat/outbound-format.js';
import { Store } from '../src/store.js';
import { ImGateway } from '../src/im.js';
import { classifyWechatOutboundMedia } from '../src/wechat-file.js';
import { buildToolRequestId, createRouterTools } from '../src/orchestrator/router-tools.js';

test('StreamingMarkdownFilter strips H5/H6, CJK italics and inline images while preserving H1-H4, bold, code and CRLF', () => {
  const input = [
    '# 一级标题',
    '## 二级标题',
    '##### 五级标题',
    '###### 六级标题',
    '**加粗** *中文斜体* ***中文粗斜体*** _下划线中文_ ___粗斜划线___',
    'English *italic* and ***bold italic*** stay intact.',
    '图 ![被剥离](https://example.com/a.png) 后面还在',
    '```ts',
    'const x = "*中文不剥离*";',
    '##### 围栏里不剥离',
    '```',
  ].join('\r\n');

  const whole = filterWechatMarkdown(input);
  assert.match(whole, /^# 一级标题\r\n## 二级标题\r\n五级标题\r\n六级标题\r\n/);
  assert.ok(whole.includes('**加粗** 中文斜体 中文粗斜体 下划线中文 粗斜划线'));
  assert.ok(whole.includes('English *italic* and ***bold italic*** stay intact.'));
  assert.ok(whole.includes('图  后面还在'));
  assert.ok(whole.includes('const x = "*中文不剥离*";\r\n##### 围栏里不剥离'));

  // Streaming char-by-char equivalence
  const streamer = new StreamingMarkdownFilter();
  let streamed = '';
  for (const ch of input) {
    streamed += streamer.feed(ch);
  }
  streamed += streamer.flush();
  assert.equal(streamed, whole);
});

test('renderMarkdownTables aligns CJK columns and ignores code blocks or lone pipes', () => {
  const md = [
    '说明 | 不是表格',
    '',
    '| 基金名称 | 估值 | 状态 |',
    '| :--- | ---: | :---: |',
    '| 示例基金A | +1.23% | 正常 |',
    '| ABC | -0.45% | 观望 |',
    '',
    '```md',
    '| keep | raw |',
    '| --- | --- |',
    '```',
  ].join('\n');

  const out = renderMarkdownTables(md);
  assert.ok(out.includes('说明 | 不是表格'));
  assert.ok(!out.includes('| :---'));
  assert.ok(out.includes('基金名称   估值    状态'));
  assert.ok(out.includes('示例基金A  +1.23%  正常'));
  assert.ok(out.includes('ABC        -0.45%  观望'));
  assert.ok(out.includes('| keep | raw |\n| --- | --- |'));

  const plain = '无表格内容\r\n保留换行\r\n';
  assert.equal(renderMarkdownTables(plain), plain);
});

test('planWechatRichContent extracts oversized fenced code blocks as files while keeping short ones inline', () => {
  const shortBlock = '```js\nconsole.log(1);\n```';
  const longBody = Array.from({ length: 40 }, (_, i) => `  print("line_${i}_padding_text_for_threshold")`).join('\n');
  const md = `先看小段：\n${shortBlock}\n\n再看长代码：\n\`\`\`python\n${longBody}\n\`\`\`\n结束。`;

  const plan = planWechatRichContent(md, { codeFileThreshold: 500 });
  assert.equal(plan.codeFiles.length, 1);
  assert.equal(plan.codeFiles[0]?.name, 'snippet-1.py');
  assert.ok(plan.codeFiles[0]?.content.includes('line_39'));
  assert.ok(plan.text.includes(shortBlock));
  assert.ok(plan.text.includes('已作为文件 snippet-1.py 发出'));

  // Plain text without tables or extracted blocks remains byte-for-byte identical
  const untouched = '普通文字\r\n```ts\nconst a = 1;\n```\r\n末尾';
  const noopPlan = planWechatRichContent(untouched, { codeFileThreshold: 1200 });
  assert.equal(noopPlan.text, untouched);
  assert.equal(noopPlan.codeFiles.length, 0);
});

test('chunkWechatText splits on boundaries and never splits UTF-16 surrogate pairs', () => {
  const emoji = '😀';
  // 2 chars per emoji; odd limit right after high surrogate would break without guard
  const payload = emoji.repeat(10);
  const chunks = chunkWechatText(payload, 5);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 5);
    assert.equal(Buffer.from(chunk, 'utf8').toString('utf8'), chunk, 'no broken UTF-16 surrogate');
  }
  assert.equal(chunks.join(''), payload);

  const multiline = `${'a'.repeat(800)}\n\n${'b'.repeat(800)}\n${'c'.repeat(800)}`;
  const multiChunks = chunkWechatText(multiline, 1000);
  assert.equal(multiChunks.length, 3);
  assert.equal(multiChunks.join(''), multiline);
});

test('WechatIlinkAdapter.send runs rich formatting, chunking, code snippet upload and sendAttachment routes native image/video/file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-rich-out-'));
  const store = new Store(home);
  const gateway = new ImGateway({ store } as any);
  const outboxDir = join(home, 'wechat-files');
  const prevOutbox = process.env.FRIDAY_WECHAT_ATTACHMENT_DIR;
  process.env.FRIDAY_WECHAT_ATTACHMENT_DIR = outboxDir;
  const oldFetch = globalThis.fetch;

  const sentPayloads: Array<Record<string, any>> = [];
  const uploadUrlRequests: Array<Record<string, any>> = [];
  const uploadedCiphertexts: Array<{ keyHex: string; cipher: Buffer }> = [];
  let pendingUploadKey = '';

  globalThis.fetch = (async (url: any, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/ilink/bot/getuploadurl')) {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      uploadUrlRequests.push(body);
      pendingUploadKey = String(body.aeskey);
      return Response.json({ ret: 0, upload_param: `param-${uploadUrlRequests.length}` });
    }
    if (u.startsWith('https://novac2c.cdn.weixin.qq.com/c2c/upload')) {
      uploadedCiphertexts.push({ keyHex: pendingUploadKey, cipher: Buffer.from(init?.body as Uint8Array) });
      return new Response(null, { status: 200, headers: { 'x-encrypted-param': `dl-${uploadedCiphertexts.length}` } });
    }
    if (u.endsWith('/ilink/bot/sendmessage')) {
      sentPayloads.push(JSON.parse(String(init?.body)) as Record<string, any>);
      return Response.json({ ret: 0, message_id: '9007199254740999999' });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as typeof fetch;

  try {
    assert.equal(classifyWechatOutboundMedia('chart.png'), 'image');
    assert.equal(classifyWechatOutboundMedia('clip.MOV'), 'video');
    assert.equal(classifyWechatOutboundMedia('report.pdf'), 'file');

    const now = Date.now();
    store.saveImChannel({
      id: 'wx-rich',
      platform: 'wechat',
      name: 'wx-rich',
      enabled: true,
      notifyAll: false,
      botToken: 'tok-rich',
      accountId: 'bot-rich',
      apiBase: 'https://wechat.invalid',
      defaultTarget: 'user-rich',
      allowedSenders: ['user-rich'],
      contextTokens: { 'user-rich': 'ctx-rich' },
      inboundCount: 0,
      outboundCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    const longTs = Array.from({ length: 45 }, (_, i) => `export const item_${i} = "padding_${'x'.repeat(20)}";`).join('\n');
    const longProse = Array.from({ length: 20 }, (_, i) => `第${i + 1}段：${'内容'.repeat(45)}`).join('\n\n');
    const fullReply = [
      '##### 小标题',
      '*中文斜体*',
      '| 列A | 列B |',
      '| --- | --- |',
      '| 一 | 二 |',
      '',
      '```ts',
      longTs,
      '```',
      '',
      longProse,
    ].join('\n');

    await gateway.sendToChannel('wx-rich', fullReply, { target: 'user-rich', contextToken: 'ctx-rich' });

    const textMsgs = sentPayloads.filter(p => p.msg.item_list[0].type === 1);
    const fileMsgs = sentPayloads.filter(p => p.msg.item_list[0].type === 4);
    assert.ok(textMsgs.length >= 2, 'long reply split into multiple WeChat text bubbles');
    const joinedText = textMsgs.map(p => String(p.msg.item_list[0].text_item.text)).join('');
    assert.ok(!joinedText.includes('##### '));
    assert.ok(joinedText.includes('小标题\n中文斜体'));
    assert.ok(joinedText.includes('列A  列B'));
    assert.ok(joinedText.includes('snippet-1.ts'));

    assert.equal(fileMsgs.length, 1);
    assert.equal(fileMsgs[0]!.msg.item_list[0].file_item.file_name, 'snippet-1.ts');
    assert.equal(uploadUrlRequests[0]!.media_type, 3);
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(uploadedCiphertexts[0]!.keyHex, 'hex'), null);
    const decryptedSnippet = Buffer.concat([
      decipher.update(uploadedCiphertexts[0]!.cipher),
      decipher.final(),
    ]).toString('utf8');
    assert.ok(decryptedSnippet.includes('export const item_44'));

    // Staged media auto-routing: png -> image_item (type 2), mp4 -> video_item (type 5), pdf -> file_item (type 4)
    sentPayloads.length = 0;
    uploadUrlRequests.length = 0;
    await mkdir(outboxDir, { recursive: true });
    const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const validMp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    await writeFile(join(outboxDir, 'pic.png'), validPng);
    await writeFile(join(outboxDir, 'clip.mp4'), validMp4);
    await writeFile(join(outboxDir, 'doc.pdf'), Buffer.from('%PDF-1.4 fake-pdf-bytes'));

    await gateway.sendWechatAttachment('wx-rich', 'pic.png', { target: 'user-rich', contextToken: 'ctx-rich' });
    await gateway.sendWechatAttachment('wx-rich', 'clip.mp4', { target: 'user-rich', contextToken: 'ctx-rich' });
    await gateway.sendWechatAttachment('wx-rich', 'doc.pdf', { target: 'user-rich', contextToken: 'ctx-rich' });

    assert.deepEqual(uploadUrlRequests.map(r => r.media_type), [1, 2, 3]);
    assert.deepEqual(sentPayloads.map(p => p.msg.item_list[0].type), [2, 5, 4]);
    assert.ok(sentPayloads[0]!.msg.item_list[0].image_item.mid_size > 0);
    assert.ok(sentPayloads[1]!.msg.item_list[0].video_item.video_size > 0);
    assert.equal(sentPayloads[2]!.msg.item_list[0].file_item.file_name, 'doc.pdf');

    // Placeholder text disguised as .jpg is rejected locally without touching CDN/iLink
    const netCallsBeforeBad = uploadUrlRequests.length + sentPayloads.length;
    await writeFile(join(outboxDir, 'placeholder.jpg'), Buffer.from('@@@PLACEHOLDER@@@', 'utf8'));
    await assert.rejects(
      gateway.sendWechatAttachment('wx-rich', 'placeholder.jpg', { target: 'user-rich', contextToken: 'ctx-rich' }),
      /Attachment image content is invalid/,
    );
    assert.equal(uploadUrlRequests.length + sentPayloads.length, netCallsBeforeBad);

    // Missing staged file surfaces Attachment file not found
    await assert.rejects(
      gateway.sendWechatAttachment('wx-rich', 'missing.jpg', { target: 'user-rich', contextToken: 'ctx-rich' }),
      /Attachment file not found/,
    );

    // Router send_file rejects binary placeholder content creation and lists real files on ENOENT
    const validJpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    await writeFile(join(outboxDir, 'real-fish.jpg'), validJpg);
    const createdMsg = store.conversation.create({
      id: 'msg-send-file-test',
      role: 'user',
      text: '发鱼照片给我',
      paths: [],
      status: 'processing',
      mode: 'real',
      origin: {
        channel: 'wechat',
        channelId: 'wx-rich',
        accountId: 'bot-rich',
        senderId: 'user-rich',
        contextToken: 'ctx-rich',
      },
    });
    const routerTools = createRouterTools(
      {
        home,
        store,
        im: gateway,
        runs: new Map(),
        reportAutoDispatches: { get: () => 0 } as any,
        hasInboundHold: () => false,
        isClosing: () => false,
        getTurn: () => ({
          reportTurnDispatched: false,
          reportTurnSentFile: false,
          reportTurnSavedMemory: false,
          chatContext: {
            message: createdMsg,
            controller: new AbortController(),
          } as any,
        }),
        resolveChannelOrigin: () => undefined,
      } as any,
      () => 'req-test',
      { toolNames: new Set(['send_file']) },
    );
    const sendFileTool = routerTools.find(t => t.name === 'send_file');
    assert.ok(sendFileTool);
    assert.equal(typeof buildToolRequestId, 'function');

    await assert.rejects(
      sendFileTool.execute(JSON.stringify({ name: 'fake.jpg', content: '@@@PLACEHOLDER@@@' }), 'call-fake'),
      /禁止用纯文本 content 生成二进制附件/,
    );
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(join(outboxDir, 'fake.jpg')), false);
    await assert.rejects(
      sendFileTool.execute(JSON.stringify({ name: 'wrong.jpg' }), 'call-missing'),
      /暂存目录中不存在 "wrong\.jpg".*real-fish\.jpg/,
    );
  } finally {
    await gateway.close();
    globalThis.fetch = oldFetch;
    if (prevOutbox === undefined) delete process.env.FRIDAY_WECHAT_ATTACHMENT_DIR;
    else process.env.FRIDAY_WECHAT_ATTACHMENT_DIR = prevOutbox;
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import {
  enrichWechatVoice,
  extractWechatDocumentText,
  extractWechatVideoFrames,
  fetchWechatLinks,
  resamplePcm16ToFloat32,
} from '../src/wechat/media-enrich.js';
import { formatWechatQuoteBlock, parseWechatQuote, resolvePartialQuote } from '../src/wechat/protocol.js';
import { messageImages } from '../src/message-images.js';
import { Store } from '../src/store.js';
import { ImGateway } from '../src/im.js';
import { parseWechatIlinkMessage } from '../src/im/channels/wechat-ilink.js';

function encryptAesEcb(bytes: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

function buildMinimalZip(entries: Array<{ name: string; content: Buffer }>): Buffer {
  const localChunks: Buffer[] = [];
  const cdChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.content);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    localChunks.push(local, compressed);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(entry.content.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    cdChunks.push(cd);

    offset += local.length + compressed.length;
  }

  const cdBuf = Buffer.concat(cdChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localChunks, cdBuf, eocd]);
}

test('enrichWechatVoice transcodes SILK->WAV, resamples 24k->16k, strips ASR tags and handles fallbacks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wx-voice-enrich-'));
  try {
    const silkPath = join(dir, 'sample.silk');
    await writeFile(silkPath, Buffer.from('#!SILK_V3mock'));

    // 2400 samples (0.1s at 24kHz) -> 1600 samples at 16kHz
    const pcm24k = Buffer.alloc(2400 * 2);
    for (let i = 0; i < 2400; i++) {
      pcm24k.writeInt16LE(Math.round(Math.sin(i / 20) * 12000), i * 2);
    }
    const resampled = resamplePcm16ToFloat32(pcm24k, 24_000, 16_000);
    assert.equal(resampled.length, 1600);

    const okRes = await enrichWechatVoice({
      silkPath,
      inboundDir: dir,
      deps: {
        decodeSilk: async () => ({ data: new Uint8Array(pcm24k), duration: 100 }),
        transcribePcm: async (samples, rate) => {
          assert.equal(rate, 16_000);
          assert.equal(samples.length, 1600);
          return '<|zh|><|NEUTRAL|>明天帮我查一下基金净值';
        },
      },
    });
    assert.equal(okRes.transcoded, true);
    assert.ok(okRes.wavPath?.endsWith('.wav'));
    assert.equal(okRes.transcript, '明天帮我查一下基金净值');
    assert.equal(okRes.transcriptSource, 'local_asr');
    assert.match(okRes.promptNote, /【语音转写】/);
    const wavHeader = await readFile(okRes.wavPath!);
    assert.equal(wavHeader.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wavHeader.subarray(8, 12).toString('ascii'), 'WAVE');

    // Empty transcription -> honest silence warning without fabrication
    const emptyRes = await enrichWechatVoice({
      silkPath,
      inboundDir: dir,
      deps: {
        decodeSilk: async () => ({ data: new Uint8Array(pcm24k), duration: 100 }),
        transcribePcm: async () => '<|nospeech|>',
      },
    });
    assert.equal(emptyRes.transcript, '');
    assert.match(emptyRes.promptNote, /不要臆测内容/);

    // Missing local ASR -> falls back to ilink voice_item.text
    const fallbackRes = await enrichWechatVoice({
      silkPath,
      inboundDir: dir,
      asrModelsDir: join(dir, 'nonexistent-asr'),
      homeDir: dir,
      ilinkText: '微信服务端附带的转写文本',
      deps: {
        decodeSilk: async () => ({ data: new Uint8Array(pcm24k), duration: 100 }),
      },
    });
    assert.equal(fallbackRes.transcript, '微信服务端附带的转写文本');
    assert.equal(fallbackRes.transcriptSource, 'ilink_text');

    // Decode failure without fallback -> degrades gracefully
    const failRes = await enrichWechatVoice({
      silkPath,
      inboundDir: dir,
      deps: {
        decodeSilk: async () => { throw new Error('corrupt silk frame'); },
      },
    });
    assert.equal(failRes.transcoded, false);
    assert.match(failRes.promptNote, /解码失败/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractWechatDocumentText extracts .docx XML and plain text without external deps', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wx-doc-'));
  try {
    const docxXml = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><w:document><w:body>'
      + '<w:p><w:r><w:t>第一条：甲方 &amp; 乙方协议</w:t><w:tab/><w:t>金额 &lt; 100</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>第二条：生效日期</w:t><w:br/><w:t>2026-11-19</w:t></w:r></w:p>'
      + '</w:body></w:document>',
      'utf8',
    );
    const docxPath = join(dir, 'contract.docx');
    await writeFile(docxPath, buildMinimalZip([{ name: 'word/document.xml', content: docxXml }]));

    const extracted = await extractWechatDocumentText(docxPath);
    assert.equal(extracted.ok, true);
    if (extracted.ok) {
      assert.equal(extracted.kind, 'docx');
      assert.ok(extracted.text.includes('第一条：甲方 & 乙方协议\t金额 < 100'));
      assert.ok(extracted.text.includes('第二条：生效日期\n2026-11-19'));
    }

    const binPath = join(dir, 'raw.txt');
    await writeFile(binPath, Buffer.from([0x61, 0x00, 0x62]));
    const binRes = await extractWechatDocumentText(binPath);
    assert.equal(binRes.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('parseWechatQuote parses refermsg, appmsg.refermsg and ref_msg shapes safely', () => {
  const q1 = parseWechatQuote([
    {
      type: 1,
      text_item: { text: '这条对吗？' },
      refermsg: {
        displayname: 'Alice',
        title: '周报标题',
        content: 'Bearer secret-token-xyz 请核对数据',
      },
    },
  ]);
  assert.ok(q1);
  assert.equal(q1.sender, 'Alice');
  assert.equal(q1.title, '周报标题');
  assert.doesNotMatch(q1.text, /secret-token-xyz/);
  assert.match(formatWechatQuoteBlock(q1), /^【引用 Alice】\n周报标题\n/);

  const q2 = parseWechatQuote([
    {
      type: 1,
      ref_msg: {
        title: '上文截图',
        message_item: { text_item: { text: '请帮我分析一下' } },
      },
    },
  ]);
  assert.ok(q2);
  assert.equal(q2.title, '上文截图');
  assert.equal(q2.text, '请帮我分析一下');
});

test('fetchWechatLinks enforces SSRF host/DNS/redirect blocks and extracts clean HTML text', async () => {
  const res = await fetchWechatLinks(
    '看这三个链接 https://127.0.0.1/a https://169.254.169.254/latest/meta-data/ https://public.example/post',
    {
      bypassCache: true,
      lookup: async host => {
        if (host === 'public.example') return [{ address: '93.184.216.34', family: 4 }];
        return [{ address: '10.0.0.1', family: 4 }];
      },
      fetcher: (async (url: string) => {
        if (url === 'https://public.example/post') {
          return new Response(
            '<html><head><title>公开文章</title><script>alert(1)</script></head><body><h1>正文</h1><p>核心结论在这里。</p></body></html>',
            { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
          );
        }
        throw new Error(`Private host must never be fetched: ${url}`);
      }) as typeof fetch,
    },
  );
  assert.equal(res.entries.length, 3);
  assert.equal(res.entries[0]!.ok, false);
  assert.equal(res.entries[1]!.ok, false);
  assert.equal(res.entries[2]!.ok, true);
  assert.equal(res.entries[2]!.title, '公开文章');
  assert.ok(res.entries[2]!.text?.includes('核心结论在这里'));
  assert.ok(!res.entries[2]!.text?.includes('alert(1)'));

  // 302 redirect to private IP is blocked before second hop
  const redirRes = await fetchWechatLinks('https://redir.example/start', {
    bypassCache: true,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetcher: (async (url: string) => {
      if (url === 'https://redir.example/start') {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/internal' } });
      }
      throw new Error(`Redirect target must not be fetched: ${url}`);
    }) as typeof fetch,
  });
  assert.equal(redirRes.entries[0]!.ok, false);
  assert.match(redirRes.entries[0]!.error ?? '', /内网|本机/);
});

test('inbound poll end-to-end: video frames feed Vision, voice text & quotes enter chat, and unauthorized senders trigger zero fetches', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-enrich-e2e-'));
  const store = new Store(home);
  const oldFetch = globalThis.fetch;

  // Check if local ffmpeg is available; generate a real tiny 1.5s mp4 fixture
  let mp4Bytes: Buffer | undefined;
  try {
    const mp4Path = join(home, 'fixture.mp4');
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1.5',
      '-pix_fmt', 'yuv420p', mp4Path,
    ]);
    mp4Bytes = await readFile(mp4Path);
  } catch {
    mp4Bytes = undefined;
  }

  const aesKey = Buffer.alloc(16, 11);
  const chatCalls: Array<{ text: string; paths: string[]; attachments: any[] }> = [];
  const gateway = new ImGateway({
    store,
    chat(requestId: string, text: string, paths: string[], origin: any, attachments: any[]) {
      chatCalls.push({ text, paths, attachments });
      return store.conversation.create({
        id: requestId, requestId, role: 'user', text, paths, origin, attachments, status: 'queued', mode: 'real',
      });
    },
  } as any);

  const encryptedVideo = mp4Bytes ? encryptAesEcb(mp4Bytes, aesKey) : Buffer.alloc(0);
  const encryptedVoice = encryptAesEcb(Buffer.from('not-real-silk'), aesKey);
  const encryptedDoc = encryptAesEcb(Buffer.from('文档第一行\n文档第二行'), aesKey);

  let cdnRequests = 0;
  let linkRequests = 0;
  const pollQueue: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.endsWith('/ilink/bot/getupdates')) {
      return Response.json({ ret: 0, msgs: pollQueue.splice(0) });
    }
    if (u.startsWith('https://novac2c.cdn.weixin.qq.com/c2c/download')) {
      cdnRequests++;
      if (u.includes('video-param')) return new Response(new Uint8Array(encryptedVideo));
      if (u.includes('voice-param')) return new Response(new Uint8Array(encryptedVoice));
      if (u.includes('doc-param')) return new Response(new Uint8Array(encryptedDoc));
    }
    if (u.startsWith('https://public-test.example/')) {
      linkRequests++;
      return new Response('<html><title>Test</title><body><p>Hello</p></body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as typeof fetch;

  try {
    store.saveImChannel({
      id: 'wx-enrich',
      platform: 'wechat',
      name: 'wx-enrich',
      enabled: true,
      notifyAll: false,
      botToken: 'tok-enrich',
      accountId: 'bot-enrich',
      apiBase: 'https://wechat.invalid',
      allowedSenders: ['owner@im.wechat'],
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 1. Unauthorized stranger with media + URL triggers ZERO CDN or link fetches
    pollQueue.push({
      message_id: 1001,
      from_user_id: 'stranger@im.wechat',
      item_list: [
        { type: 1, text_item: { text: '点开 https://public-test.example/evil' } },
        { type: 3, voice_item: { media: { encrypt_query_param: 'voice-param', aes_key: aesKey.toString('base64') } } },
      ],
    });
    await (gateway as any).pollChannel('wx-enrich');
    assert.equal(cdnRequests, 0);
    assert.equal(linkRequests, 0);
    assert.equal(chatCalls.length, 0);

    // 2. Authorized voice + quote falls back cleanly to voice_item.text when silk isn't valid audio
    pollQueue.push({
      message_id: 1002,
      from_user_id: 'owner@im.wechat',
      context_token: 'ctx-1002',
      item_list: [
        {
          type: 3,
          voice_item: {
            text: '帮我总结一下刚才那份文件',
            media: { encrypt_query_param: 'voice-param', aes_key: aesKey.toString('base64') },
          },
          refermsg: { displayname: '小王', content: '周报在附件里' },
        },
      ],
    });
    await (gateway as any).pollChannel('wx-enrich');
    assert.equal(chatCalls.length, 1);
    assert.match(chatCalls[0]!.text, /【引用 小王】/);
    assert.match(chatCalls[0]!.text, /帮我总结一下刚才那份文件/);
    assert.equal(chatCalls[0]!.attachments[0]?.kind, 'voice');
    assert.equal(chatCalls[0]!.attachments[0]?.transcript, '帮我总结一下刚才那份文件');

    // 3. Authorized document excerpts enter prompt
    pollQueue.push({
      message_id: 1003,
      from_user_id: 'owner@im.wechat',
      context_token: 'ctx-1003',
      item_list: [
        {
          type: 4,
          file_item: {
            file_name: 'notes.txt',
            media: { encrypt_query_param: 'doc-param', aes_key: aesKey.toString('base64') },
          },
        },
      ],
    });
    await (gateway as any).pollChannel('wx-enrich');
    assert.equal(chatCalls.length, 2);
    assert.match(chatCalls[1]!.text, /文档第一行/);

    // 4. Real ffmpeg video frame extraction feeds messageImages() Vision blocks
    if (mp4Bytes) {
      pollQueue.push({
        message_id: 1004,
        from_user_id: 'owner@im.wechat',
        context_token: 'ctx-1004',
        item_list: [
          { type: 1, text_item: { text: '这个视频里有什么' } },
          {
            type: 5,
            video_item: {
              media: { encrypt_query_param: 'video-param', aes_key: aesKey.toString('base64') },
            },
          },
        ],
      });
      await (gateway as any).pollChannel('wx-enrich');
      assert.equal(chatCalls.length, 3);
      const savedMsg = store.conversation.history(undefined, 1).items[0]!;
      assert.equal(savedMsg.attachments?.[0]?.kind, 'video');
      const frameImages = savedMsg.attachments?.filter(a => a.kind === 'image' && a.status === 'ready') ?? [];
      assert.equal(frameImages.length, 3);
      const vision = await messageImages(JSON.stringify({ kind: 'CHAT', message: savedMsg }), true);
      assert.equal(vision.images.length, 3);
      assert.equal(vision.images[0]?.mimeType, 'image/png');
    }

    // Also test error handling of extractWechatVideoFrames with mocked failing ffmpeg
    const badFfmpeg = await extractWechatVideoFrames({
      videoPath: join(home, 'missing.mp4'),
      outputDir: join(home, 'inbound-media'),
      runFfmpeg: async () => ({ stderr: '', exitCode: 1, errorCode: 'ENOENT' }),
    });
    assert.equal(badFfmpeg.frames.length, 0);
    assert.equal(badFfmpeg.error, 'ffmpeg unavailable');
  } finally {
    await gateway.close();
    globalThis.fetch = oldFetch;
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('resolvePartialQuote handles global/relative indices and quotemd5 disambiguation', () => {
  const full = '第一段话：红斗鱼很漂亮；第二段话：红斗鱼吃饱了。';
  const expected = '红斗鱼吃饱了';
  const md5 = createHash('md5').update(expected, 'utf8').digest('hex');

  // "红斗鱼" appears twice; startindex=1 selects the second occurrence; "了" appears once after start (relative=0, global=0 here; test repeated end char)
  const text2 = 'foo bar foo bar baz';
  const globalMatch = resolvePartialQuote(text2, {
    start: 'foo',
    startindex: 1,
    end: 'bar',
    endindex: 1,
  });
  assert.equal(globalMatch.fallback, false);
  assert.equal(globalMatch.resolved, 'foo bar');

  // Relative vs global disambiguation using quotemd5
  const text3 = 'alpha mid beta alpha mid gamma mid';
  const relExcerpt = 'alpha mid gamma mid';
  const relMd5 = createHash('md5').update(relExcerpt, 'utf8').digest('hex');
  const disambiguated = resolvePartialQuote(text3, {
    start: 'alpha',
    startindex: 1,
    end: 'mid',
    endindex: 1,
    quotemd5: relMd5,
  });
  assert.equal(disambiguated.fallback, false);
  assert.equal(disambiguated.resolved, relExcerpt);

  const simple = resolvePartialQuote(full, {
    start: '红斗鱼',
    startindex: 1,
    end: '了',
    endindex: 0,
    quotemd5: md5,
  });
  assert.equal(simple.fallback, false);
  assert.equal(simple.resolved, expected);
});

test('WeChat ID-only svr_id quote cache resolves outbound/inbound text, partial_text, quoted images into Vision, legacy fallback, and isolation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'wx-quote-cache-'));
  const store = new Store(home);
  const oldFetch = globalThis.fetch;

  const aesKey = Buffer.alloc(16, 21);
  const validPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  const encryptedPng = encryptAesEcb(validPng, aesKey);
  const encryptedInlinePng = encryptAesEcb(validPng, aesKey);

  const chatCalls: Array<{ text: string; attachments: any[] }> = [];
  const gateway = new ImGateway({
    store,
    chat(requestId: string, text: string, paths: string[], origin: any, attachments: any[]) {
      chatCalls.push({ text, attachments });
      return store.conversation.create({
        id: requestId, requestId, role: 'user', text, paths, origin, attachments, status: 'queued', mode: 'real',
      });
    },
  } as any);

  let cdnDownloads = 0;
  const pollQueue: Array<Record<string, unknown>> = [];

  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.endsWith('/ilink/bot/sendmessage')) {
      // Return raw JSON with uint64 (> MAX_SAFE_INTEGER) message_id to also test lossless precision
      return new Response('{"ret":0,"message_id":7529101430245766280}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.endsWith('/ilink/bot/getupdates')) {
      return Response.json({ ret: 0, msgs: pollQueue.splice(0) });
    }
    if (u.startsWith('https://novac2c.cdn.weixin.qq.com/c2c/download')) {
      cdnDownloads++;
      if (u.includes('img-cache-param')) return new Response(new Uint8Array(encryptedPng));
      if (u.includes('inline-ref-img')) return new Response(new Uint8Array(encryptedInlinePng));
    }
    throw new Error(`Unexpected fetch: ${u}`);
  }) as typeof fetch;

  try {
    store.saveImChannel({
      id: 'wx-q',
      platform: 'wechat',
      name: 'wx-q',
      enabled: true,
      notifyAll: false,
      botToken: 'tok-q',
      accountId: 'bot-q@im.bot',
      apiBase: 'https://wechat.invalid',
      allowedSenders: ['owner@im.wechat', 'peer2@im.wechat'],
      contextTokens: { 'owner@im.wechat': 'ctx-owner', 'peer2@im.wechat': 'ctx-peer2' },
      inboundCount: 0,
      outboundCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 1. Bot sends a message; server returns uint64 message_id 7529101430245766280 -> cached automatically
    const botReplyText = '第一部分：今天天气不错。第二部分：建议给红斗鱼换水。';
    await gateway.sendToChannel('wx-q', botReplyText, { target: 'owner@im.wechat', contextToken: 'ctx-owner' });

    // User quotes that uint64 svr_id with NO inline text + partial_text selection
    const partialTarget = '建议给红斗鱼换水';
    const partialMd5 = createHash('md5').update(partialTarget, 'utf8').digest('hex');
    pollQueue.push({
      message_id: '8800001',
      from_user_id: 'owner@im.wechat',
      context_token: 'ctx-q1',
      item_list: [
        {
          type: 1,
          text_item: { text: '就按你说的这句办' },
          ref_msg: {
            svr_id: '7529101430245766280',
            partial_text: {
              start: '建议',
              end: '换水',
              startindex: 0,
              endindex: 0,
              quotemd5: partialMd5,
            },
          },
        },
      ],
    });
    await (gateway as any).pollChannel('wx-q');
    assert.equal(chatCalls.length, 1);
    assert.match(chatCalls[0]!.text, /【引用 F\.R\.I\.D\.A\.Y\. 的消息】/);
    assert.match(chatCalls[0]!.text, /划词引用：建议给红斗鱼换水/);
    assert.match(chatCalls[0]!.text, /完整原文：第一部分：今天天气不错。第二部分：建议给红斗鱼换水。/);

    // 2. Inbound user image is cached; later ID-only quote brings that image back into Vision attachments
    pollQueue.push({
      message_id: '8800002',
      from_user_id: 'owner@im.wechat',
      context_token: 'ctx-q2',
      item_list: [
        {
          type: 2,
          image_item: { media: { encrypt_query_param: 'img-cache-param', aes_key: aesKey.toString('base64') } },
        },
      ],
    });
    await (gateway as any).pollChannel('wx-q');
    assert.equal(chatCalls.length, 2);

    pollQueue.push({
      message_id: '8800003',
      from_user_id: 'owner@im.wechat',
      context_token: 'ctx-q3',
      item_list: [
        {
          type: 1,
          text_item: { text: '重新看一下我引用里的那张图' },
          ref_msg: { svr_id: '8800002' },
        },
      ],
    });
    await (gateway as any).pollChannel('wx-q');
    assert.equal(chatCalls.length, 3);
    assert.match(chatCalls[2]!.text, /【引用你之前的消息】/);
    const quotedImgMsg = store.conversation.history(undefined, 1).items[0]!;
    const visionRes = await messageImages(JSON.stringify({ kind: 'CHAT', message: quotedImgMsg }), true);
    assert.equal(visionRes.images.length, 1);
    assert.equal(visionRes.images[0]?.mimeType, 'image/png');

    // 3. Historical fallback from pre-cache conversation.byRequest + strict cross-sender isolation
    const legacyId = '7529000000000000999';
    const legacyReqId = createHash('sha256').update(`im:wx-q:${legacyId}`).digest('hex');
    store.conversation.create({
      id: legacyReqId,
      requestId: legacyReqId,
      role: 'user',
      text: '一条升级前的旧斗鱼记录',
      paths: [],
      status: 'completed',
      mode: 'real',
      origin: {
        channel: 'wechat',
        channelId: 'wx-q',
        accountId: 'bot-q@im.bot',
        conversationId: 'owner@im.wechat',
        senderId: 'owner@im.wechat',
      },
    });
    pollQueue.push({
      message_id: '8800004',
      from_user_id: 'owner@im.wechat',
      context_token: 'ctx-q4',
      item_list: [
        {
          type: 1,
          text_item: { text: '能读出旧记录吗' },
          ref_msg: { svr_id: legacyId },
        },
      ],
    });
    await (gateway as any).pollChannel('wx-q');
    assert.equal(chatCalls.length, 4);
    assert.match(chatCalls[3]!.text, /一条升级前的旧斗鱼记录/);

    // Different sender (peer2) quoting owner's svr_id must NOT see owner's message
    pollQueue.push({
      message_id: '8800005',
      from_user_id: 'peer2@im.wechat',
      context_token: 'ctx-p2',
      item_list: [
        {
          type: 1,
          text_item: { text: '偷看别人消息' },
          ref_msg: { svr_id: '7529101430245766280' },
        },
      ],
    });
    await (gateway as any).pollChannel('wx-q');
    assert.equal(chatCalls.length, 5);
    assert.doesNotMatch(chatCalls[4]!.text, /红斗鱼/);
    assert.match(chatCalls[4]!.text, /引用的历史消息未缓存/);

    // 4. Unauthorized stranger with inline ref_msg image must trigger ZERO CDN downloads
    const cdnBeforeStranger = cdnDownloads;
    pollQueue.push({
      message_id: '8800006',
      from_user_id: 'stranger@im.wechat',
      item_list: [
        {
          type: 1,
          text_item: { text: '坏人引用' },
          ref_msg: {
            message_item: {
              type: 2,
              image_item: { media: { encrypt_query_param: 'inline-ref-img', aes_key: aesKey.toString('base64') } },
            },
          },
        },
      ],
    });
    await (gateway as any).pollChannel('wx-q');
    assert.equal(cdnDownloads, cdnBeforeStranger);
  } finally {
    await gateway.close();
    globalThis.fetch = oldFetch;
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

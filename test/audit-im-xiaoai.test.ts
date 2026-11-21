import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ImGateway } from '../src/im.js';
import { DingtalkChannelAdapter } from '../src/im/channels/dingtalk.js';
import { WechatIlinkAdapter } from '../src/im/channels/wechat-ilink.js';
import { WechatWebhookAdapter } from '../src/im/channels/wechat-webhook.js';
import { isPrivateOrLocalHostname, runBoundedMediaTask } from '../src/im/types.js';
import { Store, type ImChannelConfig } from '../src/store.js';
import { fetchWechatLinks, isPrivateOrLocalIp } from '../src/wechat/media-enrich.js';
import { XiaoaiKwsMonitor } from '../src/xiaoai/kws-monitor.js';
import { XiaoaiSpeakerManager } from '../src/xiaoai/speaker-verify.js';
import { markXiaoaiSpeakingGuard, resetXiaoaiRuntimeState } from '../src/xiaoai/tts-player.js';

const execFileAsync = promisify(execFile);

function makeChannel(overrides: Partial<ImChannelConfig> = {}): ImChannelConfig {
  const now = Date.now();
  return {
    id: overrides.id ?? 'ch-audit',
    platform: overrides.platform ?? 'wechat',
    name: overrides.name ?? '审计通道',
    enabled: overrides.enabled ?? true,
    notifyAll: overrides.notifyAll ?? false,
    allowedSenders: overrides.allowedSenders ?? [],
    inboundCount: overrides.inboundCount ?? 0,
    outboundCount: overrides.outboundCount ?? 0,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    ...overrides,
  };
}

test('runBoundedMediaTask strictly enforces MAX_CONCURRENT_MEDIA_TASKS=2 under waiter wakeup races', async () => {
  let current = 0;
  let maxObserved = 0;
  const order: number[] = [];

  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });

  const t1 = runBoundedMediaTask(async () => {
    current++;
    maxObserved = Math.max(maxObserved, current);
    order.push(1);
    await firstGate;
    current--;
    return 1;
  });

  const t2 = runBoundedMediaTask(async () => {
    current++;
    maxObserved = Math.max(maxObserved, current);
    order.push(2);
    await delay(30);
    current--;
    return 2;
  });

  const t3 = runBoundedMediaTask(async () => {
    current++;
    maxObserved = Math.max(maxObserved, current);
    order.push(3);
    await delay(20);
    current--;
    return 3;
  });

  // Release t1 (waking t3 via microtask) and immediately enqueue t4 in the same tick.
  releaseFirst();
  const t4 = runBoundedMediaTask(async () => {
    current++;
    maxObserved = Math.max(maxObserved, current);
    order.push(4);
    await delay(10);
    current--;
    return 4;
  });

  const results = await Promise.all([t1, t2, t3, t4]);
  assert.deepEqual(results, [1, 2, 3, 4]);
  assert.equal(maxObserved, 2, `Expected max 2 concurrent media tasks, observed ${maxObserved}`);
  assert.deepEqual(order, [1, 2, 3, 4]);
});

test('IPv6 link-local fe80::/10 (fe81::..febf::) is blocked in both isPrivateOrLocalIp and fetchWechatLinks', async () => {
  for (const addr of ['fe80::1', 'fe81::1', 'fe9f::abcd', 'fea5::1', 'febf::1', 'ff02::1']) {
    assert.equal(isPrivateOrLocalIp(addr), true, `Expected private/local for ${addr}`);
    assert.equal(isPrivateOrLocalHostname(addr), true, `Expected private/local hostname for ${addr}`);
  }
  assert.equal(isPrivateOrLocalIp('2606:4700:4700::1111'), false);

  let fetched = false;
  const res = await fetchWechatLinks('https://linklocal.example/test', {
    bypassCache: true,
    lookup: async () => [{ address: 'fe81::1234', family: 6 }],
    fetcher: (async () => {
      fetched = true;
      return new Response('should not fetch');
    }) as typeof fetch,
  });
  assert.equal(fetched, false);
  assert.equal(res.entries[0]?.ok, false);
  assert.match(res.entries[0]?.error ?? '', /内网|保留/);
});

test('WechatIlinkAdapter.pollQrLogin picks active session over LRU-promoted expired session and tolerates malformed redirect_host', async t => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-audit-qr-'));
  const store = new Store(home);
  const gateway = new ImGateway({ store, homeDir: home } as any);
  let qrSeq = 0;

  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/get_bot_qrcode')) {
      qrSeq++;
      return Response.json({
        qrcode: `qr-code-${qrSeq}`,
        qrcode_img_content: `https://liteapp.weixin.qq.com/q/test-${qrSeq}`,
      });
    }
    if (u.pathname.endsWith('/get_qrcode_status')) {
      return Response.json({ status: 'scaned_but_redirect', redirect_host: 'bad:host:name' });
    }
    throw new Error(`Unexpected URL: ${u.pathname}`);
  });

  try {
    const qr1 = await gateway.startWechatQrLogin({ id: 'wx-lru', apiBase: 'https://ilink.invalid' });
    const qr2 = await gateway.startWechatQrLogin({ id: 'wx-lru', apiBase: 'https://ilink.invalid' });

    // Polling old session by sessionId triggers BoundedMap.get() LRU promotion.
    const oldStatus = await gateway.pollWechatQrLogin(qr1.sessionId);
    assert.equal(oldStatus.status, 'expired');

    // Polling by channelId must still resolve qr2 (active) rather than LRU-promoted qr1 (expired).
    const activeByChannel = await gateway.pollWechatQrLogin('wx-lru');
    assert.equal(activeByChannel.sessionId, qr2.sessionId);
    assert.equal(activeByChannel.status, 'scaned');
  } finally {
    await gateway.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('ImGateway.sendToChannel survives channel removal mid-flight on both success and failure', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-audit-send-rm-'));
  const store = new Store(home);
  const gateway = new ImGateway({ store, homeDir: home } as any);

  let finishSend!: () => void;
  let failSend!: (err: Error) => void;
  const origFetch = globalThis.fetch;

  try {
    gateway.saveChannel({
      id: 'tg-rm-ok',
      platform: 'telegram',
      name: 'TG Remove OK',
      botToken: '111:TOKEN_RM',
      defaultTarget: '9001',
      webhookUrl: 'http://127.0.0.1:9999/hook',
    });

    globalThis.fetch = (() => new Promise<Response>((resolve) => {
      finishSend = () => resolve(Response.json({ ok: true, result: { message_id: 1 } }));
    })) as typeof fetch;

    const sendOkPromise = gateway.sendToChannel('tg-rm-ok', 'hello');
    await delay(10);
    gateway.removeChannel('tg-rm-ok');
    finishSend();
    await sendOkPromise;

    gateway.saveChannel({
      id: 'tg-rm-err',
      platform: 'telegram',
      name: 'TG Remove Err',
      botToken: '111:TOKEN_RM',
      defaultTarget: '9001',
      webhookUrl: 'http://127.0.0.1:9999/hook',
    });

    globalThis.fetch = (() => new Promise<Response>((_resolve, reject) => {
      failSend = reject;
    })) as typeof fetch;

    const sendErrPromise = gateway.sendToChannel('tg-rm-err', 'hello');
    await delay(10);
    gateway.removeChannel('tg-rm-err');
    failSend(new Error('upstream down'));
    await assert.rejects(sendErrPromise, /upstream down/);
  } finally {
    globalThis.fetch = origFetch;
    await gateway.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('WechatWebhookAdapter and DingtalkChannelAdapter handle empty webhookUrl, senderId, target, and msgId safely', async t => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-audit-wh-empty-'));
  const store = new Store(home);
  const ingested: Array<{ senderId: string; target?: string; externalId: string }> = [];
  const postedUrls: string[] = [];

  t.mock.method(globalThis, 'fetch', async (url: string | URL) => {
    postedUrls.push(String(url));
    return Response.json({ ok: true });
  });

  try {
    const ctx = {
      homeDir: home,
      coordinator: { store },
      shutdownSignal: new AbortController().signal,
      isClosing: () => false,
      markMessageDelivered: () => {},
      clearMessageDelivered: () => {},
      getSeenMessageVersion: () => -1,
      sendToChannel: async () => {},
      ingestMessage: async (msg: { senderId: string; target?: string; externalId: string }) => {
        ingested.push(msg);
        return { ok: true, action: 'routed_to_chat', messageId: 'm1' };
      },
      markTrustedWechatInbound: () => {},
      scheduleChannelPoll: () => {},
      runVoiceFastpath: async () => undefined,
    } as any;

    const wx = new WechatWebhookAdapter(ctx);
    const wxCh = makeChannel({
      id: 'wx-empty-wh',
      platform: 'wechat',
      webhookUrl: '   ',
      apiBase: 'https://wx-bridge.invalid/api/',
      secret: 'wx-sec',
    });
    await wx.send(wxCh, 'ping');
    assert.equal(postedUrls[0], 'https://wx-bridge.invalid/api/send');

    await wx.handleWebhook(
      wxCh,
      'POST',
      new URLSearchParams(),
      { 'x-wechat-secret': 'wx-sec' },
      '<xml><FromUserName></FromUserName><Content>hi</Content><MsgId></MsgId></xml>',
    );
    await wx.handleWebhook(
      wxCh,
      'POST',
      new URLSearchParams(),
      { 'x-wechat-secret': 'wx-sec' },
      JSON.stringify({ from: '', chatId: '', msgId: '', text: 'hello' }),
    );
    assert.equal(ingested[0]?.senderId, 'wechat-user');
    assert.equal(ingested[0]?.target, 'wechat-user');
    assert.ok((ingested[0]?.externalId ?? '').length > 0);
    assert.equal(ingested[1]?.senderId, 'wechat-user');
    assert.equal(ingested[1]?.target, 'wechat-user');
    assert.ok((ingested[1]?.externalId ?? '').length > 0);
    assert.notEqual(ingested[0]?.externalId, ingested[1]?.externalId);

    const ding = new DingtalkChannelAdapter(ctx);
    const ts = String(Date.now());
    const sign = createHmac('sha256', 'ding-sec').update(`${ts}\nding-sec`).digest('base64');
    await ding.handleWebhook(
      makeChannel({ id: 'ding-empty', platform: 'dingtalk', secret: 'ding-sec' }),
      'POST',
      new URLSearchParams(),
      { timestamp: ts, sign },
      JSON.stringify({ senderStaffId: '', conversationId: '', msgId: '', text: { content: 'ping' } }),
    );
    assert.equal(ingested[2]?.senderId, 'dingtalk-user');
    assert.equal(ingested[2]?.target, 'dingtalk-user');
    assert.ok((ingested[2]?.externalId ?? '').length > 0);
  } finally {
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoaiKwsMonitor breaks self-echo re-wake loop during follow-up capture and catches speakerGate/ASR errors in transcribeAndEmit', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-audit-kws-'));
  resetXiaoaiRuntimeState();

  try {
    let stream!: PassThrough;
    let spotterResetCalls = 0;
    const errors: unknown[] = [];
    const cancels: Array<{ reason: string }> = [];
    let throwOnVerify = false;

    const monitor = new XiaoaiKwsMonitor({
      homeDir: home,
      cooldownMs: 10,
      probeDurationMs: 20,
      chimeDiscardMs: 0,
      maxWaitSpeechMs: 1_200,
      endSilenceMs: 40,
      asrWakeRescue: false,
      idleEnergyGate: false,
      streamFactory: () => {
        stream = new PassThrough();
        return { stdout: stream, sampleFormat: 's16le', kill: () => stream.end(), onClose: () => {} };
      },
      spotterFactory: () => {
        let ready = false;
        return {
          createStream: () => ({}),
          acceptWaveform: (_s, samples) => {
            if (samples.some(v => Math.abs(v) >= 0.5)) ready = true;
          },
          isReady: () => ready,
          decode: () => {},
          getResult: () => (ready ? '星期五' : ''),
          reset: () => {
            ready = false;
            spotterResetCalls++;
          },
        };
      },
      recognizerFactory: () => ({ transcribe: async () => '测试' }),
      vadFactory: () => ({
        isSpeech: (samples) => samples.some(v => Math.abs(v) >= 0.05 && Math.abs(v) < 0.4),
        reset: () => {},
      }),
      speakerGate: {
        isActive: () => throwOnVerify,
        verifyUtteranceAsync: async () => {
          throw new Error('speaker verify boom');
        },
        verifyUtterance: () => ({ matched: true, score: 1, threshold: 0.4 }),
      },
      onError: (_ch, err) => errors.push(err),
      onCaptureCancel: (ev) => { cancels.push({ reason: ev.reason }); },
    });

    monitor.sync([makeChannel({ id: 'xa-loop', platform: 'xiaoai', apiBase: 'ssh://lx06=root@192.0.2.10?kws=1' })]);
    await delay(15);

    const writeAmp = (amp: number, ms: number) => {
      const count = Math.round((ms / 1000) * 16_000);
      const buf = Buffer.alloc(count * 2);
      const val = Math.round(amp * 32767);
      for (let i = 0; i < count; i++) buf.writeInt16LE(val, i * 2);
      stream.write(buf);
    };

    // 1. Self-echo during follow-up capture must reset spotter and exit loop instead of hanging
    markXiaoaiSpeakingGuard('xa-loop', 'lx06', 5_000, true);
    assert.equal(monitor.enterFollowUpCapture('xa-loop', 'lx06', { waitMs: 1_200, discardMs: 0 }), true);
    const resetsBefore = spotterResetCalls;
    writeAmp(0.75, 20);
    await delay(20);
    assert.ok(spotterResetCalls > resetsBefore, 'Self-echo in follow-up capture must reset spotter and break');
    assert.equal(monitor.isCapturing('xa-loop', 'lx06'), true);

    // 2. Async rejection inside verifyUtteranceAsync in transcribeAndEmit is caught cleanly
    throwOnVerify = true;
    writeAmp(0.15, 80);
    writeAmp(0, 80);
    await delay(40);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /speaker verify boom/);
    assert.deepEqual(cancels.at(-1), { reason: 'error' });

    monitor.close();
  } finally {
    resetXiaoaiRuntimeState();
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoaiSpeakerManager.ensureExtractor clears stale freed extractor if factory throws', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-audit-ext-'));
  try {
    let freed = 0;
    let shouldThrow = false;
    const mgr = new XiaoaiSpeakerManager({
      homeDir: home,
      extractorFactory: () => {
        if (shouldThrow) throw new Error('factory fail');
        return {
          dim: 2,
          extract: () => new Float32Array([1, 0]),
          free: () => { freed++; },
        };
      },
    });
    const ext1 = mgr.ensureExtractor();
    assert.ok(ext1);

    // Simulate model switch failure after freeing ext1
    (mgr as any).extractorModelPath = 'other-model';
    shouldThrow = true;
    assert.throws(() => mgr.ensureExtractor(), /factory fail/);
    assert.equal(freed, 1);
    assert.equal((mgr as any).extractor, undefined);
    assert.equal((mgr as any).extractorModelPath, undefined);
    mgr.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('XiaoaiChannelAdapter reschedules TV remote expiry watch on newer user message and fails enrollment cleanly on save error', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-audit-xa-'));
  const store = new Store(home);
  const ttsTexts: string[] = [];
  let seq = 0;

  const coordinator = {
    store,
    homeDir: home,
  } as any;
  let onFirstTts: (() => void) | undefined;
  let playStatusCount = 0;
  const gateway = new ImGateway(coordinator);
  gateway.xiaoaiDeps = {
    sshRunner: async (_t, cmd) => {
      if (cmd.includes('text_to_speech')) {
        ttsTexts.push(cmd);
        onFirstTts?.();
        onFirstTts = undefined;
      }
      if (cmd.includes('player_get_play_status')) {
        playStatusCount += 1;
        const status = playStatusCount === 1 ? 1 : 0;
        return { stdout: `{"code":0,"info":"{ \\"status\\": ${status} }"}`, stderr: '', code: 0 };
      }
      return { stdout: '{"code":0,"info":"{ \\"status\\": 0 }"}', stderr: '', code: 0 };
    },
    kwsSpotterFactory: () => ({
      createStream: () => ({}),
      acceptWaveform: () => {},
      isReady: () => false,
      decode: () => {},
      getResult: () => '',
      reset: () => {},
    }),
    kwsStreamFactory: () => ({
      stdout: new PassThrough(),
      kill: () => {},
      onClose: () => {},
    }),
    speakerExtractorFactory: () => ({
      dim: 2,
      extract: () => new Float32Array([1, 0]),
      free: () => {},
    }),
  };

  try {
    gateway.saveChannel({
      id: 'xa-audit',
      platform: 'xiaoai',
      name: '小爱审计',
      apiBase: 'ssh://lx06=root@192.0.2.10?kws=1',
      defaultTarget: 'lx06',
    });

    const adapter = (gateway as any).xiaoaiAdapter;
    const origin = {
      channel: 'xiaoai' as const,
      channelId: 'xa-audit',
      conversationId: 'lx06',
      senderId: 'lx06',
    };
    const msg1 = store.conversation.create({ id: `m-${++seq}`, role: 'user', text: '遥控', status: 'completed', mode: 'offline', paths: [], origin } as any);
    const reply1 = store.conversation.create({ id: `m-${++seq}`, replyTo: msg1.id, role: 'assistant', text: '好的', status: 'completed', mode: 'offline', paths: [], origin } as any);

    adapter.fastpathSessions.set('xa-audit:lx06', {
      pluginName: 'tv-ir',
      state: { continuous: true, tvRemoteActive: true, idleTtlMs: 10_000 },
      idleTtlMs: 10_000,
      expiresAt: Date.now() + 10_000,
    });
    // Newer speaker message arrives mid-TTS (after clearFastpathExpiryTimer, before armContinuousCapture)
    onFirstTts = () => {
      store.conversation.create({ id: `m-${++seq}`, role: 'user', text: '继续', status: 'completed', mode: 'offline', paths: [], origin } as any);
    };
    adapter.enqueueOutbound('xa-audit', reply1, '好的', origin);
    for (let i = 0; i < 80 && !adapter.fastpathExpiryTimers.has('xa-audit:lx06'); i++) {
      await delay(25);
    }
    assert.ok(adapter.fastpathExpiryTimers.has('xa-audit:lx06'), 'TV remote expiry timer must be rescheduled on early return');
    adapter.clearFastpathExpiryTimer('xa-audit:lx06');

    // Enrollment failure in enrollEmbeddings must transition session to failed instead of leaving it active
    const started = await gateway.startVoiceprintEnrollment({ name: '测试员', channelId: 'xa-audit', targetId: 'lx06' });
    const manager = adapter.getSpeakerManager();
    manager.enrollEmbeddings = () => { throw new Error('disk full'); };
    const sampleBuf = new Float32Array(16_000);
    for (let step = 0; step < started.session.totalSteps; step++) {
      await gateway.ingestMessage({
        channelId: 'xa-audit',
        externalId: `enr-${step}`,
        senderId: 'lx06',
        target: 'lx06',
        text: '测试声纹句子',
        samples: sampleBuf,
        sampleRate: 16_000,
      });
    }
    const statusAfterErr = gateway.getVoiceprintEnrollmentStatus(started.session.sessionId);
    assert.equal(statusAfterErr.status, 'failed');
    assert.match(statusAfterErr.error ?? '', /disk full/);
  } finally {
    await gateway.close();
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('scripts/xiaoai-router-bridge.sh builds exact 102-byte WOL magic packet and preserves IFS after prefix matching', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-audit-bridge-'));
  try {
    const mockBin = join(home, 'mock-bin');
    const wolBin = join(home, 'wol-bin');
    await mkdir(mockBin, { recursive: true });
    await mkdir(wolBin, { recursive: true });
    const wolHexOut = join(home, 'wol.hex');
    const logFile = join(home, 'instruction.log');
    await writeFile(logFile, '');

    await writeFile(join(wolBin, 'nc'), `#!/bin/sh
od -An -tx1 | tr -d ' \\n' > "${wolHexOut}"
`);
    await writeFile(join(mockBin, 'curl'), '#!/bin/sh\nexit 0\n');
    await chmod(join(wolBin, 'nc'), 0o755);
    await chmod(join(mockBin, 'curl'), 0o755);

    const bridgeScript = join(process.cwd(), 'scripts/xiaoai-router-bridge.sh');
    const shellCmd = `
      PATH="${mockBin}:$PATH"
      export FRIDAY_BRIDGE_LIB_ONLY=1
      export FRIDAY_WEBHOOK_URL="http://127.0.0.1:9/hook"
      export FRIDAY_TRIGGER_PREFIX="星期五,Friday"
      export FRIDAY_XIAOAI_LOG_FILE="${logFile}"
      . "${bridgeScript}"
      init_log_cursor
      printf '%s\\n' '{"header":{"namespace":"SpeechRecognizer","name":"RecognizeResult"},"payload":{"is_final":true,"results":[{"text":"星期五，测试"}]}}' >> "${logFile}"
      poll_log_once
      set -- alpha beta gamma
      printf 'ARGC=%s\\n' "$#"
      for tool in tr cut od; do
        tool_path=$(command -v "$tool")
        ln -sf "$tool_path" "${wolBin}/$tool"
      done
      PATH="${wolBin}"
      send_wol_packet "aa:bb:cc:dd:ee:ff"
    `;
    const { stdout } = await execFileAsync('sh', ['-c', shellCmd]);
    assert.match(stdout, /ARGC=3/, 'IFS must remain intact (space splitting preserved) after poll_log_once + matches_prefix');

    const hex = await readFile(wolHexOut, 'utf8');
    const expected = 'ffffffffffff' + 'aabbccddeeff'.repeat(16);
    assert.equal(hex.length, 204);
    assert.equal(hex, expected);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

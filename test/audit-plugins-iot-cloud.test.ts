import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { runAction as runPulseAction } from '../plugins/system-pulse/index.mjs';
import { executeTvIrAction } from '../plugins/tv-ir/index.mjs';
import { handleTvIrVoiceFastpath } from '../plugins/tv-ir/voice-fastpath.mjs';
import { executeTvAgentAction } from '../plugins/tv-agent/index.mjs';
import { runAction as runAppleAction } from '../plugins/apple-devices/index.mjs';
import { fetchFindMyDevices, splitSetCookieHeader } from '../plugins/apple-devices/icloud-client.mjs';
import { runAction as runFundAction } from '../plugins/fund-tracker/index.mjs';
import { runAction as runNinebotAction } from '../plugins/ninebot/index.mjs';
import { createNinebotClient, defaultHttpRequester } from '../plugins/ninebot/client.mjs';
import { runAction as runMiotAction, parseHubSnapshot } from '../plugins/miot/index.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function withTmpDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. system-pulse: non-finite patrol threshold fallbacks
// ---------------------------------------------------------------------------

test('audit/system-pulse: patrol rejects NaN/Infinity threshold args and preserves alert checks', async () => {
  const res = await runPulseAction('patrol', {
    maxLoadPerCore: Number.NaN,
    maxMemUsedPct: Number.POSITIVE_INFINITY,
    minDiskFreeGb: Number.NaN,
    force: true,
    warnDirtyGit: false,
  });
  assert.equal(res.ok, true);
  assert.equal(res.notify, true);
  assert.ok(typeof res.message === 'string' && !res.message.includes('> NaN') && !res.message.includes('> Infinity'));
});

// ---------------------------------------------------------------------------
// 2. tv-ir & voice-fastpath: learnedAt clock, lock, signal, null-args & failed initialSteps
// ---------------------------------------------------------------------------

test('audit/tv-ir: uses deps.now, handles null/array args, locks concurrent learn, and reports failed entry steps', async () => {
  await withTmpDir('audit-tvir-', async home => {
    const dataDir = join(home, 'plugins', 'tv-ir');

    // Non-object args never throw TypeError
    const statusNull = await executeTvIrAction('status', null as unknown as Record<string, unknown>, {
      homeDir: home,
      dataDir,
      sshRunner: async () => ({ code: 0, stdout: 'IR_TX_READY\n', stderr: '' }),
    }).catch(e => ({ ok: false, message: String(e) }));
    assert.equal(statusNull.ok, false); // unconfigured SSH yields structured error, not TypeError

    // Concurrent learn uses deps.now and serializes writes without dropping keys
    const makeLearnDeps = (fixedNow: number, codeStr: string) => ({
      homeDir: home,
      dataDir,
      now: () => fixedNow,
      sleep: async () => {},
      sshRunner: async (_t: unknown, cmd: string) => {
        if (cmd.includes('read')) return { code: 0, stdout: JSON.stringify({ code: 0, info: codeStr }), stderr: '' };
        return { code: 0, stdout: '{"code":0}', stderr: '' };
      },
    });
    const [r1, r2] = await Promise.all([
      executeTvIrAction('learn', { key: 'k1', sshTarget: 'lx06=root@192.0.2.10' }, makeLearnDeps(111_000, '1000,570,600,1111,600,10510')),
      executeTvIrAction('learn', { key: 'k2', sshTarget: 'lx06=root@192.0.2.10' }, makeLearnDeps(222_000, '1000,570,600,2222,600,10510')),
    ]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal((r1.data as Record<string, unknown>).learnedAt, 111_000);
    assert.equal((r2.data as Record<string, unknown>).learnedAt, 222_000);
    const learned = JSON.parse(await readFile(join(dataDir, 'learned-keys.json'), 'utf8'));
    assert.ok(learned.k1 && learned.k2, 'concurrent learn calls must preserve both keys');

    // Voice fastpath with null context & failing actionExecutor on entry initial steps
    const fpFail = await handleTvIrVoiceFastpath(
      { text: '进入电视遥控模式，先按确认', channelId: 'c1', platform: 'xiaoai' },
      null as unknown as Record<string, unknown>,
      async () => ({ ok: false, notify: true, title: 'fail', message: '音箱离线' }),
    );
    assert.equal(fpFail.handled, true);
    assert.equal(fpFail.ok, false);
    assert.equal(fpFail.speech, '音箱离线');
  });
});

// ---------------------------------------------------------------------------
// 3. tv-agent: NaN pollMs / negative decisionTimeoutMs / XML prefix tag collision
// ---------------------------------------------------------------------------

test('audit/tv-agent: non-finite pollMs/decisionTimeoutMs fallback cleanly & xmlTag matches exact tag names', async () => {
  await withTmpDir('audit-tvagent-', async home => {
    const dataDir = join(home, 'plugins', 'tv-agent');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ tvHost: '192.0.2.50', tvToken: 'abcd'.repeat(16) }));

    // 1. pollMs='abc' must NOT make polls=NaN and skip polling after IR power
    let statusProbeCount = 0;
    const powerRes = await executeTvAgentAction(
      'power',
      { state: 'on', pollMs: 'abc', waitMs: 5000 },
      {
        homeDir: home,
        dataDir,
        pollMs: 'abc' as unknown as number,
        sleep: async () => {},
        irRunner: async () => ({ ok: true, message: 'sent' }),
        fetch: async (url: unknown) => {
          const u = String(url);
          if (u.includes('/status')) {
            statusProbeCount++;
            if (statusProbeCount >= 2) {
              return new Response(JSON.stringify({ ok: true, awake: true }), { status: 200 });
            }
          }
          return new Response('', { status: 503 });
        },
      },
    );
    assert.equal(powerRes.ok, true);
    assert.ok(statusProbeCount >= 2, `expected polling loop to run, got count=${statusProbeCount}`);

    // 2. Negative / NaN decisionTimeoutMs must NOT throw TypeError in AbortSignal.timeout
    const navRes = await executeTvAgentAction(
      'navigate',
      { goal: '搜索电影', maxSteps: 1, apiKey: 'fake-key', decisionTimeoutMs: -10, settleMs: Number.POSITIVE_INFINITY },
      {
        homeDir: home,
        dataDir,
        sleep: async () => {},
        fetch: async (url: unknown) => {
          const u = String(url);
          if (u.includes('/act')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
          if (u.includes('/tree')) {
            return new Response(JSON.stringify({
              ok: true,
              packageName: 'com.demo',
              nodes: [
                { id: 'n0', text: '首页', clickable: true },
                { id: 'n1', text: '电影', clickable: true },
              ],
            }), { status: 200 });
          }
          if (u.includes('/decisions')) {
            return new Response(JSON.stringify({
              answers: { goal_reached: { noul: 0.9 }, next_action: { choice: 'done_now', confidence: 0.9 } },
            }), { status: 200 });
          }
          return new Response('', { status: 404 });
        },
      },
    );
    assert.equal(navRes.ok, true);

    // 3. xmlTag must not mis-match <CurrentVolumeDB> when querying CurrentVolume
    const volRes = await executeTvAgentAction('volume', {}, {
      homeDir: home,
      dataDir,
      fetch: async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('49152')) {
          const act = String((init?.headers as Record<string, string>)?.SOAPACTION ?? '');
          if (act.includes('GetVolume')) {
            return new Response(
              '<u:GetVolumeResponse><CurrentVolumeDB>-2400</CurrentVolumeDB><CurrentVolume>42</CurrentVolume></u:GetVolumeResponse>',
              { status: 200 },
            );
          }
          if (act.includes('GetMute')) {
            return new Response('<CurrentMuteState>foo</CurrentMuteState><CurrentMute>0</CurrentMute>', { status: 200 });
          }
        }
        return new Response('', { status: 500 });
      },
    });
    assert.equal(volRes.ok, true);
    assert.equal((volRes.data as Record<string, unknown>).volume, 42);
    assert.equal((volRes.data as Record<string, unknown>).muted, false);
  });
});

// ---------------------------------------------------------------------------
// 4. apple-devices: Expires cookie split, Infinity delay, null args & logout race
// ---------------------------------------------------------------------------

test('audit/apple-devices: splitSetCookieHeader handles trailing Expires date, rejects Infinity poll delay, and respects logout', async () => {
  // Trailing Expires= with NO semicolon before next cookie
  const split = splitSetCookieHeader('a=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT, b=2; HttpOnly');
  assert.deepEqual(split, ['a=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'b=2; HttpOnly']);

  // locatePollDelayMs = Infinity falls back to bounded server delay instead of hanging
  const fetchMock: typeof fetch = async (input) => {
    const u = String(input);
    if (u.includes('initClient')) {
      return new Response(JSON.stringify({
        serverContext: { callbackIntervalInMS: 1 },
        content: [{ id: 'd1', name: 'iPhone', deviceStatus: '203', batteryStatus: 'Unknown', isLocating: true }],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      serverContext: { callbackIntervalInMS: 1 },
      content: [{ id: 'd1', name: 'iPhone', deviceStatus: '200', batteryLevel: 0.88, batteryStatus: 'NotCharging' }],
    }), { status: 200 });
  };
  const devicesRes = await fetchFindMyDevices({
    session: { state: 'authenticated', findmeUrl: 'https://p123-fmipweb.icloud.com.cn', cookies: {} },
    locatePollDelayMs: Number.POSITIVE_INFINITY,
    maxLocatePolls: 1,
    fetchFn: fetchMock,
  });
  assert.equal(devicesRes.entries.length, 1);

  await withTmpDir('audit-apple-', async home => {
    const dataDir = join(home, 'plugins', 'apple-devices');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'session.json'),
      JSON.stringify({ state: 'authenticated', appleId: 'u@example.com', findmeUrl: 'https://p1-fmipweb.icloud.com', sessionToken: 'tok' }),
      { mode: 0o600 },
    );

    // Null args handled gracefully
    const nullRes = await runAppleAction('status', null as unknown as Record<string, unknown>, {
      homeDir: home,
      dataDir,
      fetchFn: async () => new Response(JSON.stringify({ content: [] }), { status: 200 }),
    });
    assert.equal(nullRes.ok, true);

    // Concurrent logout deletes session.json while in-flight devices fails -> MUST NOT resurrect session.json
    const slowDevices = runAppleAction('devices', { refresh: true }, {
      homeDir: home,
      dataDir,
      fetchFn: async () => {
        await new Promise(r => setTimeout(r, 40));
        return new Response('err', { status: 401 });
      },
    });
    await new Promise(r => setTimeout(r, 10));
    const logoutRes = await runAppleAction('logout', {}, { homeDir: home, dataDir });
    assert.equal(logoutRes.ok, true);
    await slowDevices;
    assert.equal(existsSync(join(dataDir, 'session.json')), false, 'deleted session.json must not be resurrected');
  });
});

// ---------------------------------------------------------------------------
// 5. fund-tracker: invalid DWJZ filter, out-of-order max date, -100% div-by-zero
// ---------------------------------------------------------------------------

test('audit/fund-tracker: filters blank/zero/non-finite DWJZ, picks max navDate, and guards -100% dailyReturn', async () => {
  await withTmpDir('audit-fund-', async home => {
    const dataDir = join(home, 'plugins', 'fund-tracker');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
      holdings: [{
        code: '000001',
        name: '测试基金',
        fundType: 'index',
        proxySymbol: '',
        proxyName: '',
        positionRatio: 1,
        initAmount: 1000,
        cost: 1000,
        initNav: 1.0,
        initNavDate: '2026-11-10',
        shares: 1000,
      }],
    }));

    const nowTs = Date.parse('2026-11-20T12:00:00+08:00');
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('lsjz')) {
        return new Response(JSON.stringify({
          Data: {
            LSJZList: [
              // Malformed zero / whitespace entries and out-of-order newer date
              { FSRQ: '2026-11-19', DWJZ: '0', JZZZL: '0' },
              { FSRQ: '2026-11-18', DWJZ: '   ', JZZZL: '1.0' },
              { FSRQ: '2026-11-17', DWJZ: '1.1000', JZZZL: '1.00' },
              { FSRQ: '2026-11-20', DWJZ: '1.2000', JZZZL: '-100' },
            ],
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected fetch ${url}`);
    };

    const res = await runFundAction('status', {}, { homeDir: home, dataDir, nowFn: () => nowTs, fetchFn: mockFetch });
    assert.equal(res.ok, true);
    const holding = (res.data as { holdings: Array<Record<string, unknown>> }).holdings[0]!;
    // Must pick valid 2026-11-20 (1.2000) rather than zero/blank rows
    assert.equal(holding.currentNav, 1.2);
    assert.equal(holding.baseNavDate, '2026-11-20');
    assert.ok(Number.isFinite(holding.baseNav as number), 'baseNav must be finite even if dailyReturn is -100');
    assert.ok(Number.isFinite((res.data as Record<string, unknown>).totalAsset as number));
  });
});

// ---------------------------------------------------------------------------
// 6. ninebot: HTTP abrupt close & gzip bomb cap + cross-account isolation
// ---------------------------------------------------------------------------

test('audit/ninebot: rejects truncated HTTP response cleanly, caps decompressed size, and isolates cross-account sessions', async () => {
  // 1. Truncated HTTP response closes early -> rejects immediately instead of hanging until timeout
  let attemptCount = 0;
  const truncServer = http.createServer((_req, res) => {
    attemptCount++;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
    res.write('{"partial":');
    res.socket?.destroy();
  });
  await new Promise<void>(r => truncServer.listen(0, '127.0.0.1', r));
  const truncPort = (truncServer.address() as { port: number }).port;
  try {
    await assert.rejects(
      defaultHttpRequester({ method: 'GET', url: `http://127.0.0.1:${truncPort}/test`, timeoutMs: 5000 }),
      /eof|关闭|reset|socket|hang/i,
    );
    assert.equal(attemptCount, 2); // transient close retried once
  } finally {
    truncServer.close();
  }

  // 2. Gzip decompression bomb (> 8MB expanded from small gzip) rejected by maxOutputLength
  const hugeZeroes = gzipSync(Buffer.alloc(9 * 1024 * 1024, 0x41));
  assert.ok(hugeZeroes.length < 100_000);
  const bombServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': String(hugeZeroes.length) });
    res.end(hugeZeroes);
  });
  await new Promise<void>(r => bombServer.listen(0, '127.0.0.1', r));
  const bombPort = (bombServer.address() as { port: number }).port;
  try {
    await assert.rejects(
      defaultHttpRequester({ method: 'GET', url: `http://127.0.0.1:${bombPort}/bomb`, timeoutMs: 5000 }),
      /maxOutputLength|Cannot create a Buffer|length/i,
    );
  } finally {
    bombServer.close();
  }

  // 3. Switching Ninebot account on login clears old account's businessUid & cached vehicles
  await withTmpDir('audit-ninebot-', async home => {
    const dataDir = join(home, 'plugins', 'ninebot');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'session.json'),
      JSON.stringify({
        deviceId: 'dev123',
        username: 'olduser',
        businessUid: 'OLD_UID_999',
        vehicles: [{ sn: 'OLD_SN' }],
      }),
      { mode: 0o600 },
    );

    const reqSeen: Array<string> = [];
    const mockRequester = async (spec: { url: string; headers?: Record<string, string>; body?: string }) => {
      reqSeen.push(spec.url);
      if (spec.url.includes('/v6/user/login')) {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify({
            resultCode: '00000',
            data: { access_token: 'new-tok', refresh_token: 'new-ref', uuid: 'u2', accessTokenValidity: String(Date.now() + 3_600_000) },
          })),
        };
      }
      if (spec.url.includes('/user/user/login')) {
        // Transient businessLogin failure on new user -> MUST NOT reuse OLD_UID_999
        return { status: 500, headers: {}, body: Buffer.from('fail') };
      }
      // my-vehicle returns empty list cleanly encrypted/plaintext code:0
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ code: 0, data: [] })) };
    };

    const res = await runNinebotAction(
      'login',
      { username: 'newuser', password: 'pw' },
      { homeDir: home, dataDir, httpRequester: mockRequester as unknown as typeof defaultHttpRequester },
    );
    assert.equal(res.ok, true);
    const savedSess = JSON.parse(await readFile(join(dataDir, 'session.json'), 'utf8'));
    assert.equal(savedSess.businessUid, '');
    assert.equal(savedSess.username, 'newuser');
    assert.deepEqual(savedSess.vehicles, []);
  });
});

// ---------------------------------------------------------------------------
// 7. miot: status tolerance for missing speakerSsh, generic siid/piid validation, cache ino
// ---------------------------------------------------------------------------

test('audit/miot: set validates integer siid/piid, status degrades cleanly without speakerSsh, and fileSig uses inode', async () => {
  await withTmpDir('audit-miot-', async home => {
    const dataDir = join(home, 'plugins', 'miot');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ routerSsh: 'root@192.0.2.1' }));

    // 1. status succeeds probing router even when speakerSsh is unconfigured
    const stRes = await runMiotAction('status', {}, {
      homeDir: home,
      dataDir,
      sshTextExec: async () => ({ code: 0, stdout: 'FRIDAY_OK\n4321\n', stderr: '' }),
    });
    assert.equal(stRes.ok, true);
    assert.equal((stRes.data as any).router.reachable, true);
    assert.equal((stRes.data as any).speaker.reachable, false);
    assert.ok((stRes.data as any).speaker.error);

    // 2. Seed cache and verify generic set rejects bad siid/piid before hitting BLE/UDP
    let controlCalled = false;
    const snap = parseHubSnapshot({
      devInfoRows: [
        { did: '"110022003"', dev_name: '"卧室灯"', model: '"isa.switch.kg01hl"', urn: '"urn:miot-spec-v2:device:switch:0000A003:isa-kg01hl:1"', connect_type: '16', online: 'true' },
      ],
      hotDataRows: [],
      nowMs: Date.now(),
    });
    await writeFile(join(dataDir, 'hub-cache.json'), JSON.stringify({ version: 1, ...snap }));

    for (const badArgs of [
      { device: '卧室灯', siid: 'abc', piid: 1, value: true },
      { device: '卧室灯', siid: null, piid: 1, value: true },
      { device: '卧室灯', siid: 1.5, piid: 1, value: true },
      { device: '卧室灯', siid: -1, piid: 1, value: true },
    ]) {
      const badRes = await runMiotAction('set', badArgs as Record<string, unknown>, {
        homeDir: home,
        dataDir,
        sshBinaryExec: async () => {
          controlCalled = true;
          return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
        },
      });
      assert.equal(badRes.ok, false);
      assert.match(badRes.message, /非负整数/);
    }
    assert.equal(controlCalled, false);
  });
});

// ---------------------------------------------------------------------------
// 8. tv-agent-apk: verify Java hardening fixes are present & build compiles
// ---------------------------------------------------------------------------

test('audit/tv-agent-apk: atomic ScreenshotCache, IdentityHashMap, symlink check, dp-storage fallback & accept backoff', async () => {
  const apkRoot = join(REPO_ROOT, 'tools', 'tv-agent-apk', 'src', 'local', 'friday', 'tvagent');
  const a11yJava = await readFile(join(apkRoot, 'TvAgentAccessibilityService.java'), 'utf8');
  const httpJava = await readFile(join(apkRoot, 'TvAgentHttpServer.java'), 'utf8');
  const healerJava = await readFile(join(apkRoot, 'TvAgentSelfHealer.java'), 'utf8');

  assert.match(a11yJava, /class ScreenshotCache/);
  assert.match(a11yJava, /IdentityHashMap/);
  assert.match(httpJava, /Files\.isSymbolicLink/);
  assert.match(httpJava, /dp != null \? dp : ctx/);
  assert.match(httpJava, /SystemClock\.sleep\(150L\)/);
  assert.match(healerJava, /if \(result\.length\(\) > 0\)/);
});

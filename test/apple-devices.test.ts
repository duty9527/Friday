import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  completeSrpClientChallenge,
  createMockSrpServerSession,
  createSrpClientEphemeral,
} from '../plugins/apple-devices/icloud-srp.mjs';
import { saveSystemGeoConfig, wgs84ToGcj02 } from '../plugins/_shared/amap-geo.mjs';
import { runAction as runAppleAction, maskAppleId } from '../plugins/apple-devices/index.mjs';
import { listPluginsSync, runPlugin, tryPluginVoiceFastpath } from '../src/plugin.js';
import { serve } from '../src/server.js';
import { startWeb } from '../src/web-server.js';

function makeMockResponse(status: number, body: unknown, headers: Record<string, string | string[]> = {}): Response {
  const hdrs = new Headers();
  hdrs.set('content-type', 'application/json');
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) {
      for (const item of v) hdrs.append(k, item);
    } else {
      hdrs.set(k, v);
    }
  }
  const nullBodyStatus = status === 204 || status === 205 || status === 304;
  const raw = nullBodyStatus ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Response(raw, { status, headers: hdrs });
}

interface MockAppleServerOptions {
  appleId: string;
  password: string;
  protocol?: 's2k' | 's2k_fo';
  region?: 'cn' | 'global';
  code?: string;
  require2fa?: boolean;
  return409ValidOn2fa?: boolean;
  expireFirstFmipWith450?: boolean;
  devices?: Array<Record<string, unknown>>;
  fmipResponder?: (path: '/initClient' | '/refreshClient', body: any, fmipCallIdx: number) => {
    content: Array<Record<string, unknown>>;
    userInfo?: Record<string, unknown>;
    serverContext?: Record<string, unknown>;
  };
  validateHandler?: (reqHeaders: Record<string, string>) => Response | Promise<Response>;
  accountLoginHandler?: (reqBody: any, reqHeaders: Record<string, string>) => Response | Promise<Response>;
  initClientHandler?: (reqBody: any, reqHeaders: Record<string, string>) => Response | Promise<Response>;
  refreshClientHandler?: (reqBody: any, reqHeaders: Record<string, string>) => Response | Promise<Response>;
  playSoundHandler?: (reqBody: any, reqHeaders: Record<string, string>) => Response | Promise<Response>;
  signinCompleteHandler?: (reqBody: any, reqHeaders: Record<string, string>) => Response | Promise<Response>;
}

function createMockAppleFetch(opts: MockAppleServerOptions) {
  const region = opts.region ?? 'cn';
  const expectedAuthHost = 'idmsa.apple.com';
  const expectedHomeOrigin = region === 'cn' ? 'https://www.icloud.com.cn' : 'https://www.icloud.com';
  const expectedSetupHost = region === 'cn' ? 'setup.icloud.com.cn' : 'setup.icloud.com';
  const expectedFindmeHost = region === 'cn' ? 'p123-fmipweb.icloud.com.cn' : 'p123-fmipweb.icloud.com';
  const code = opts.code ?? '654321';

  let srpServer: ReturnType<typeof createMockSrpServerSession> | undefined;
  let lastInitA = '';
  let currentDevices = opts.devices ?? [];
  let expiredOnce = false;
  let fmipCallIdx = 0;

  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: any }> = [];

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const reqHeaders: Record<string, string> = {};
    if (init?.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        reqHeaders[k.toLowerCase()] = String(v);
      }
    }
    const reqBody = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, headers: reqHeaders, body: reqBody });

    if (parsed.hostname === expectedAuthHost && parsed.pathname === '/appleauth/auth/authorize/signin') {
      assert.equal(method, 'GET');
      assert.match(parsed.searchParams.get('frame_id') ?? '', /^[0-9a-f-]{36}$/);
      assert.equal(parsed.searchParams.get('redirect_uri'), expectedHomeOrigin);
      assert.equal(reqHeaders.origin, expectedHomeOrigin);
      return makeMockResponse(200, '{}', {
        scnt: 'scnt-auth-boot',
        'x-apple-auth-attributes': 'auth-attr-boot-1',
        'set-cookie': ['dslang=CN-ZH; Path=/'],
      });
    }

    if (parsed.hostname === expectedAuthHost && parsed.pathname === '/appleauth/auth/signin/init') {
      assert.equal(reqHeaders.origin, expectedHomeOrigin);
      assert.equal(reqHeaders['x-apple-oauth-redirect-uri'], expectedHomeOrigin);
      assert.equal(reqHeaders['x-apple-auth-attributes'], 'auth-attr-boot-1');
      assert.equal(reqBody.accountName, opts.appleId);
      assert.deepEqual(reqBody.protocols, ['s2k', 's2k_fo']);
      lastInitA = String(reqBody.a);
      srpServer = createMockSrpServerSession({
        accountName: opts.appleId,
        password: opts.password,
        protocol: opts.protocol ?? 's2k_fo',
        iterations: 20_000,
      });
      return makeMockResponse(200, {
        iteration: srpServer.iterations,
        salt: srpServer.saltBase64,
        b: srpServer.bBase64,
        protocol: srpServer.protocol,
        c: 'challenge-c-token',
      }, {
        scnt: 'scnt-init-1',
        'x-apple-id-session-id': 'session-id-1',
      });
    }

    if (parsed.hostname === expectedAuthHost && parsed.pathname === '/appleauth/auth/signin/complete') {
      if (!srpServer) return makeMockResponse(400, { error: 'no init' });
      assert.equal(reqHeaders['x-apple-auth-attributes'], 'auth-attr-boot-1');
      const verified = srpServer.verifyClient({
        aBase64: lastInitA,
        m1Base64: reqBody.m1,
        m2Base64: reqBody.m2,
      });
      if (!verified.ok) {
        return makeMockResponse(401, { serviceErrors: [{ message: 'Invalid credentials' }] });
      }
      if (opts.signinCompleteHandler) {
        return await opts.signinCompleteHandler(reqBody, reqHeaders);
      }
      const trustHeader = reqBody.trustTokens?.[0];
      if (opts.require2fa === false || trustHeader === 'trusted-token-xyz') {
        return makeMockResponse(200, { authType: 'hsa2' }, {
          scnt: 'scnt-ok',
          'x-apple-id-session-id': 'session-id-1',
          'x-apple-session-token': 'session-token-abc',
          'x-apple-twosv-trust-token': 'trusted-token-xyz',
          'set-cookie': ['myacinfo=MYAC_COOKIE_1; Path=/; HttpOnly', 'dslang=CN-ZH; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/'],
        });
      }
      return makeMockResponse(409, { authType: 'hsa2' }, {
        scnt: 'scnt-409',
        'x-apple-id-session-id': 'session-id-409',
        'x-apple-session-token': 'session-token-pre2fa',
        'set-cookie': ['aasp=AASP_1; Path=/; HttpOnly'],
      });
    }

    if (parsed.hostname === expectedAuthHost && parsed.pathname === '/appleauth/auth') {
      return makeMockResponse(200, {
        trustedPhoneNumbers: [
          { id: 2, numberWithDialCode: '+86 ••• •••• 8899', pushMode: 'sms' },
        ],
      });
    }

    if (parsed.hostname === expectedAuthHost && parsed.pathname === '/appleauth/auth/verify/phone') {
      assert.equal(method, 'PUT');
      assert.equal(reqHeaders.scnt, 'scnt-409');
      assert.equal(reqHeaders['x-apple-id-session-id'], 'session-id-409');
      assert.equal(reqBody.mode, 'sms');
      assert.equal(reqBody.phoneNumber.id, 2);
      return makeMockResponse(200, { mode: 'sms' }, { scnt: 'scnt-sms' });
    }

    if (
      parsed.hostname === expectedAuthHost
      && (parsed.pathname === '/appleauth/auth/verify/phone/securitycode'
        || parsed.pathname === '/appleauth/auth/verify/trusteddevice/securitycode')
    ) {
      if (reqBody?.securityCode?.code !== code) {
        return makeMockResponse(400, { serviceErrors: [{ message: 'Incorrect verification code' }] });
      }
      if (opts.return409ValidOn2fa) {
        return makeMockResponse(409, { securityCode: { valid: true } });
      }
      return makeMockResponse(204, '');
    }

    if (parsed.hostname === expectedAuthHost && parsed.pathname === '/appleauth/auth/2sv/trust') {
      return makeMockResponse(204, '', {
        'x-apple-session-token': 'session-token-trusted',
        'x-apple-twosv-trust-token': 'trusted-token-xyz',
        'set-cookie': ['myacinfo=MYAC_TRUSTED; Path=/; HttpOnly'],
      });
    }

    if (parsed.hostname === expectedSetupHost && parsed.pathname === '/setup/ws/1/validate') {
      if (opts.validateHandler) {
        return await opts.validateHandler(reqHeaders);
      }
      if (!(reqHeaders.cookie ?? '').includes('X-APPLE-WEBAUTH-TOKEN=')) {
        return makeMockResponse(421, { success: false, error: 'Missing X-APPLE-WEBAUTH-TOKEN cookie' });
      }
      return makeMockResponse(200, {
        hsaTrustedBrowser: true,
        dsInfo: { appleId: opts.appleId, dsid: '123456789' },
        webservices: {
          findme: { url: `https://${expectedFindmeHost}:443`, status: 'active' },
        },
      }, {
        'set-cookie': [
          'X-APPLE-WEBAUTH-USER=USER_SECRET_COOKIE; Domain=.icloud.com.cn; Path=/; HttpOnly',
          'X-APPLE-WEBAUTH-TOKEN=TOKEN_SECRET_COOKIE; Domain=.icloud.com.cn; Path=/; HttpOnly',
        ],
      });
    }

    if (parsed.hostname === expectedSetupHost && parsed.pathname === '/setup/ws/1/accountLogin') {
      if (opts.accountLoginHandler) {
        return await opts.accountLoginHandler(reqBody, reqHeaders);
      }
      assert.ok(reqBody.dsWebAuthToken);
      assert.equal(reqBody.extended_login, true);
      return makeMockResponse(200, {
        hsaTrustedBrowser: Boolean(reqBody.trustToken),
        dsInfo: { appleId: opts.appleId, dsid: '123456789' },
        webservices: {
          findme: { url: `https://${expectedFindmeHost}:443`, status: 'active' },
        },
      }, {
        'set-cookie': [
          'X-APPLE-WEBAUTH-USER=USER_SECRET_COOKIE; Domain=.icloud.com.cn; Path=/; HttpOnly',
          'X-APPLE-WEBAUTH-TOKEN=TOKEN_SECRET_COOKIE; Domain=.icloud.com.cn; Path=/; HttpOnly',
        ],
      });
    }

    if (
      parsed.hostname === expectedFindmeHost
      && (parsed.pathname === '/fmipservice/client/web/initClient'
        || parsed.pathname === '/fmipservice/client/web/refreshClient')
    ) {
      if (parsed.pathname === '/fmipservice/client/web/initClient' && opts.initClientHandler) {
        return await opts.initClientHandler(reqBody, reqHeaders);
      }
      if (parsed.pathname === '/fmipservice/client/web/refreshClient' && opts.refreshClientHandler) {
        return await opts.refreshClientHandler(reqBody, reqHeaders);
      }
      if (opts.expireFirstFmipWith450 && !expiredOnce) {
        expiredOnce = true;
        return makeMockResponse(450, { error: 'Session expired' });
      }
      assert.equal(parsed.searchParams.get('dsid'), '123456789');
      assert.ok((reqHeaders.cookie ?? '').includes('X-APPLE-WEBAUTH-TOKEN=TOKEN_SECRET_COOKIE'));
      const subPath = parsed.pathname.endsWith('/initClient') ? '/initClient' : '/refreshClient';
      const custom = opts.fmipResponder ? opts.fmipResponder(subPath, reqBody, fmipCallIdx++) : undefined;
      return makeMockResponse(200, {
        statusCode: '200',
        serverContext: {
          serverTimestamp: 1_760_000_000_000,
          callbackIntervalInMS: 2000,
          sessionLifespan: 900_000,
          theftLoss: { info: 'strip-me' },
          ...(custom?.serverContext ?? {}),
        },
        ...(custom?.userInfo ? { userInfo: custom.userInfo } : {}),
        content: custom?.content ?? currentDevices,
      });
    }

    if (parsed.hostname === expectedFindmeHost && parsed.pathname === '/fmipservice/client/web/playSound') {
      if (opts.playSoundHandler) {
        return await opts.playSoundHandler(reqBody, reqHeaders);
      }
      assert.equal(parsed.searchParams.get('dsid'), '123456789');
      return makeMockResponse(200, { statusCode: '200' });
    }

    return makeMockResponse(404, { error: `Unexpected mock call: ${method} ${url}` });
  }) as typeof fetch;

  return {
    fetchFn,
    calls,
    setDevices(next: Array<Record<string, unknown>>) {
      currentDevices = next;
    },
  };
}

test('1. icloud-srp.mjs matches RFC 5054 2048-bit SRP-6a for both s2k and s2k_fo', () => {
  for (const protocol of ['s2k', 's2k_fo'] as const) {
    const server = createMockSrpServerSession({
      accountName: 'test-cn@icloud.com',
      password: 'MyStr0ng!ApplePassword',
      protocol,
      iterations: 15_000,
    });
    const { aHex, aBase64 } = createSrpClientEphemeral();
    assert.equal(Buffer.from(aBase64, 'base64').length, 256, 'A must be exactly 256 bytes');

    const { m1Base64, m2Base64 } = completeSrpClientChallenge({
      accountName: 'test-cn@icloud.com',
      password: 'MyStr0ng!ApplePassword',
      aHex,
      saltBase64: server.saltBase64,
      bBase64: server.bBase64,
      iterations: server.iterations,
      protocol,
    });

    const verified = server.verifyClient({ aBase64, m1Base64, m2Base64 });
    assert.equal(verified.ok, true, `${protocol} proof must verify`);

    const wrongPass = completeSrpClientChallenge({
      accountName: 'test-cn@icloud.com',
      password: 'WrongPassword',
      aHex,
      saltBase64: server.saltBase64,
      bBase64: server.bBase64,
      iterations: server.iterations,
      protocol,
    });
    assert.equal(server.verifyClient({ aBase64, m1Base64: wrongPass.m1Base64 }).ok, false);

    const wrongProto = completeSrpClientChallenge({
      accountName: 'test-cn@icloud.com',
      password: 'MyStr0ng!ApplePassword',
      aHex,
      saltBase64: server.saltBase64,
      bBase64: server.bBase64,
      iterations: server.iterations,
      protocol: protocol === 's2k' ? 's2k_fo' : 's2k',
    });
    assert.equal(server.verifyClient({ aBase64, m1Base64: wrongProto.m1Base64 }).ok, false);
  }

  // Exact byte-for-byte cross-check against upstream pysrp (rfc5054_enable + no_username_in_x)
  const golden = completeSrpClientChallenge({
    accountName: 'golden@icloud.com',
    password: 'Golden#Pass2026',
    aHex: `81${'22'.repeat(255)}`,
    saltBase64: Buffer.from('0123456789abcdeffedcba9876543210', 'hex').toString('base64'),
    bBase64: 'n16aTCkV9XZyfUzm2/Mu520MVYcVRNPPf15g5xZYMsFoc9B7/CkvRBy1e6FJvDjxxngDr+wWCP5sKIL7dhS8mDVXejDIPDI8OPtWNH1dCqOuRtf3Gtq+EwTQK3erg/yUIIrXVK+vG8DPhUulZ6GJZ7wn8r9UF8B5F5comH0TzIeHzeWhXePYdzCZw1jqCW+gCcv/HW0zJH+EYUO1P7rcn7xNAa4W6zhVAd/MyJIRRZRE4QnPKbD4UpKhlxBXqQVK4TBmOnVC0HIp2fdKR5t59ylM6ZjqZDezcxMfTp3GySSv5d11rQ/qxLgpZX3bECh8sDaQXbpKc5GYtoN/GFWkfA==',
    iterations: 1000,
    protocol: 's2k',
  });
  assert.equal(golden.m1Base64, 'R77LapdZddvfgEC9oqPE8TQz7FEpC07gnFDo/+rl4C4=');
  assert.equal(golden.m2Base64, '9HAYLVBhX7DKIK2i8y1a5uWOtpHTlQn8va7LD6kJUOQ=');
});

test('2. China mainland two-step 2FA login, SMS fallback, trust token reuse, and 450 silent refresh', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'friday-apple-auth-'));
  try {
    const sampleDevices = [
      {
        id: 'RAW-APPLE-IPHONE-SECRET-ID-001',
        name: '我的 iPhone 16 Pro',
        deviceDisplayName: 'iPhone 16 Pro',
        rawDeviceModel: 'iPhone17,1',
        deviceClass: 'iPhone',
        deviceStatus: '200',
        batteryLevel: 0.78,
        batteryStatus: 'NotCharging',
        lowPowerMode: false,
        lostModeCapable: true,
        location: { latitude: 31.2304, longitude: 121.4737, horizontalAccuracy: 12, positionType: 'GPS', timeStamp: 1_760_000_000_000 },
      },
    ];
    const mock = createMockAppleFetch({
      appleId: 'zhangsan@icloud.com',
      password: 'Correct#Password1',
      region: 'cn',
      protocol: 's2k_fo',
      code: '246810',
      return409ValidOn2fa: true,
      expireFirstFmipWith450: true,
      devices: sampleDevices,
    });

    // Wrong password rejected cleanly
    const badLogin = await runAppleAction('auth-login', {
      appleId: 'zhangsan@icloud.com',
      password: 'WrongPassword',
      region: 'cn',
    }, { dataDir, fetchFn: mock.fetchFn });
    assert.equal(badLogin.ok, false);
    assert.match(badLogin.message ?? '', /密码不正确|App 专用密码/);

    // Correct password triggers 409 pending_2fa against idmsa.apple.com with www.icloud.com.cn redirect
    const loginRes = await runAppleAction('auth-login', {
      appleId: 'zhangsan@icloud.com',
      password: 'Correct#Password1',
      region: 'cn',
    }, { dataDir, fetchFn: mock.fetchFn });
    assert.equal(loginRes.ok, true);
    assert.equal(loginRes.data.authState, 'pending_2fa');
    assert.equal(loginRes.data.region, 'cn');
    assert.equal(loginRes.data.appleId, 'z***n@icloud.com');
    assert.equal(loginRes.data.trustedPhones[0].numberWithDialCode, '+86 ••• •••• 8899');
    assert.ok(mock.calls.some(c => c.url.startsWith('https://idmsa.apple.com/appleauth/auth/authorize/signin')));

    // Password must NEVER be persisted on disk
    const sessionDisk = readFileSync(join(dataDir, 'session.json'), 'utf8');
    assert.equal(sessionDisk.includes('Correct#Password1'), false);

    // Trigger SMS fallback
    const smsRes = await runAppleAction('auth-sms', {}, { dataDir, fetchFn: mock.fetchFn });
    assert.equal(smsRes.ok, true);

    // Wrong 2FA code rejected
    const badVerify = await runAppleAction('auth-verify', { code: '000000', mode: 'sms' }, { dataDir, fetchFn: mock.fetchFn });
    assert.equal(badVerify.ok, false);

    // Valid 2FA code (accepting 409 securityCode.valid=true) completes trust + setup.icloud.com.cn accountLogin + initClient/refreshClient (including 450 auto-refresh!)
    const verifyRes = await runAppleAction('auth-verify', { code: '246810', mode: 'sms' }, { dataDir, fetchFn: mock.fetchFn });
    assert.equal(verifyRes.ok, true);
    assert.equal(verifyRes.data.authState, 'authenticated');
    assert.equal(verifyRes.data.trustedSession, true);
    assert.equal(verifyRes.data.devices.length, 1);
    assert.equal(verifyRes.data.devices[0].batteryPercent, 78);
    assert.ok(mock.calls.some(c => c.url.startsWith('https://setup.icloud.com.cn/setup/ws/1/accountLogin')));
    assert.ok(mock.calls.some(c => c.url.startsWith('https://p123-fmipweb.icloud.com.cn/fmipservice/client/web/initClient')));
    assert.ok(mock.calls.some(c => c.url.startsWith('https://p123-fmipweb.icloud.com.cn/fmipservice/client/web/refreshClient')));

    // Subsequent login with saved trustToken succeeds without 2FA
    const fastLogin = await runAppleAction('auth-login', {
      appleId: 'zhangsan@icloud.com',
      password: 'Correct#Password1',
      region: 'cn',
    }, { dataDir, fetchFn: mock.fetchFn });
    assert.equal(fastLogin.ok, true);
    assert.equal(fastLogin.data.requires2fa, false);
    assert.equal(fastLogin.data.authState, 'authenticated');

    // Logout removes session & cache files
    const outRes = await runAppleAction('logout', {}, { dataDir, fetchFn: mock.fetchFn });
    assert.equal(outRes.ok, true);
    assert.equal(existsSync(join(dataDir, 'session.json')), false);
    assert.equal(existsSync(join(dataDir, 'devices-cache.json')), false);

    // One-factor Find My bypass2fa flow works from pending_2fa without a 6-digit code
    const pendingAgain = await runAppleAction('auth-login', {
      appleId: 'zhangsan@icloud.com',
      password: 'Correct#Password1',
      region: 'cn',
    }, { dataDir, fetchFn: mock.fetchFn });
    assert.equal(pendingAgain.data.authState, 'pending_2fa');
    const bypassRes = await runAppleAction('auth-verify', { bypass2fa: true }, { dataDir, fetchFn: mock.fetchFn });
    assert.equal(bypassRes.ok, true);
    assert.equal(bypassRes.data.authState, 'authenticated');
    assert.equal(bypassRes.data.trustedSession, false);
    assert.equal(bypassRes.data.devices.length, 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('3. devices, locate geofence, play-sound dryRun/live, and patrol low-battery alerting', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'friday-apple-ops-'));
  let now = 1_760_000_000_000;
  try {
    const devicesPayload = [
      {
        id: 'RAW-IPHONE-001',
        name: '我的 iPhone',
        deviceDisplayName: 'iPhone 16',
        rawDeviceModel: 'iPhone17,3',
        deviceClass: 'iPhone',
        deviceStatus: '200',
        batteryLevel: 0.18,
        batteryStatus: 'NotCharging',
        lowPowerMode: true,
        lostModeCapable: true,
        location: { latitude: 31.2305, longitude: 121.4738, horizontalAccuracy: 10, positionType: 'GPS', timeStamp: now },
      },
      {
        id: 'RAW-IPAD-002',
        name: '书房 iPad Air',
        deviceDisplayName: 'iPad Air',
        rawDeviceModel: 'iPad14,8',
        deviceClass: 'iPad',
        deviceStatus: '200',
        batteryLevel: 0.14,
        batteryStatus: 'Charging',
        lowPowerMode: false,
        lostModeCapable: true,
        location: { latitude: 31.3000, longitude: 121.5000, horizontalAccuracy: 20, positionType: 'Wifi', timeStamp: now },
      },
      {
        id: 'RAW-AIRPODS-003',
        name: 'AirPods Pro',
        deviceDisplayName: 'AirPods Pro 2',
        rawDeviceModel: 'AirPodsPro2,1',
        deviceClass: 'Audio',
        deviceStatus: '201',
        batteryLevel: 0,
        batteryStatus: 'Unknown',
        lowPowerMode: false,
        lostModeCapable: false,
        location: null,
      },
    ];
    const mock = createMockAppleFetch({
      appleId: 'owner@icloud.com',
      password: 'Password123!',
      require2fa: false,
      devices: devicesPayload,
    });

    await runAppleAction('config', {
      region: 'cn',
      minBatteryPct: 25,
      customAliases: { 主力机: '我的 iPhone' },
      places: { 家: { lat: 31.2304, lng: 121.4737, radiusMeters: 250 } },
    }, { dataDir, nowFn: () => now });

    await runAppleAction('auth-login', {
      appleId: 'owner@icloud.com',
      password: 'Password123!',
    }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });

    const listRes = await runAppleAction('devices', {}, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
    assert.equal(listRes.ok, true);
    assert.equal(listRes.data.devices.length, 3);
    const iphone = listRes.data.devices.find((d: any) => d.category === 'iphone');
    const airpods = listRes.data.devices.find((d: any) => d.category === 'airpods');
    assert.equal(iphone.batteryPercent, 18);
    assert.equal(iphone.place.name, '家');
    assert.equal(iphone.place.inside, true);
    assert.equal(airpods.online, false);
    assert.equal(airpods.batteryPercent, null, 'Unknown 0 battery must normalize to null');

    // Locate by custom alias + redactCoords
    const locateRes = await runAppleAction('locate', { device: '主力机', redactCoords: true }, {
      dataDir,
      fetchFn: mock.fetchFn,
      nowFn: () => now,
    });
    assert.equal(locateRes.ok, true);
    assert.equal(locateRes.data.device.place.inside, true);
    assert.equal('latitude' in locateRes.data.device.location, false);

    // Play sound dryRun and live
    const dryRes = await runAppleAction('play-sound', { device: '主力机', dryRun: true }, {
      dataDir,
      fetchFn: mock.fetchFn,
      nowFn: () => now,
    });
    assert.equal(dryRes.ok, true);
    assert.equal(mock.calls.some(c => c.url.includes('/playSound')), false);

    const ringRes = await runAppleAction('play-sound', { device: iphone.id }, {
      dataDir,
      fetchFn: mock.fetchFn,
      nowFn: () => now,
    });
    assert.equal(ringRes.ok, true);
    const playCall = mock.calls.find(c => c.url.includes('/playSound'));
    assert.ok(playCall);
    assert.equal(playCall.body.device, 'RAW-IPHONE-001');
    assert.equal(JSON.stringify(ringRes).includes('RAW-IPHONE-001'), false);

    // Patrol alerts ONLY for 18% NotCharging iPhone (Charging 14% iPad is ignored)
    now += 40_000;
    const alertPatrol = await runAppleAction('patrol', {}, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
    assert.equal(alertPatrol.ok, true);
    assert.equal(alertPatrol.notify, true);
    assert.equal(alertPatrol.data.lowBatteryDevices.length, 1);
    assert.equal(alertPatrol.data.lowBatteryDevices[0].name, '我的 iPhone');

    // Once iPhone is charging, patrol stays silent (notify: false)
    now += 40_000;
    mock.setDevices([
      { ...devicesPayload[0]!, batteryLevel: 0.65, batteryStatus: 'Charging' },
      devicesPayload[1]!,
      devicesPayload[2]!,
    ]);
    const okPatrol = await runAppleAction('patrol', {}, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
    assert.equal(okPatrol.ok, true);
    assert.equal(okPatrol.notify, false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('4. Anti-drain cacheTtlSec and minRefreshIntervalSec cooldown throttle live refreshes', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'friday-apple-cache-'));
  let now = 1_760_000_000_000;
  try {
    const mock = createMockAppleFetch({
      appleId: 'cache@icloud.com',
      password: 'Password123!',
      require2fa: false,
      devices: [{
        id: 'RAW-DEV-1',
        name: '我的 iPhone',
        deviceDisplayName: 'iPhone 16',
        deviceClass: 'iPhone',
        deviceStatus: '200',
        batteryLevel: 0.9,
        batteryStatus: 'NotCharging',
      }],
    });
    await runAppleAction('config', { cacheTtlSec: 300, minRefreshIntervalSec: 30 }, { dataDir, nowFn: () => now });
    await runAppleAction('auth-login', { appleId: 'cache@icloud.com', password: 'Password123!' }, {
      dataDir,
      fetchFn: mock.fetchFn,
      nowFn: () => now,
    });
    const refreshCalls = () => mock.calls.filter(c => c.url.includes('/refreshClient')).length;
    assert.equal(refreshCalls(), 1);

    // +60s without refresh hits cache
    now += 60_000;
    const cachedRes = await runAppleAction('devices', {}, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
    assert.equal(cachedRes.data.fromCache, true);
    assert.equal(refreshCalls(), 1);

    // refresh: true within minRefreshIntervalSec (when cache was just populated 10s ago) is cooled down
    now += 310_000; // exceed TTL so we trigger a live refresh
    await runAppleAction('devices', {}, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
    assert.equal(refreshCalls(), 2);

    now += 10_000; // only 10s since last live pull (< 30s cooldown)
    const cooledRes = await runAppleAction('devices', { refresh: true }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
    assert.equal(cooledRes.data.fromCache, true);
    assert.equal(cooledRes.data.cooldownActive, true);
    assert.equal(refreshCalls(), 2);

    now += 25_000; // now 35s since last live pull (> 30s cooldown)
    const liveRes = await runAppleAction('devices', { refresh: true }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
    assert.equal(liveRes.data.fromCache, false);
    assert.equal(liveRes.data.cooldownActive, false);
    assert.equal(refreshCalls(), 3);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('5. Security hardening: ignores args.dataDir, locks 0600 permissions, redacts secrets, and blocks member voice fastpath', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-apple-sec-home-'));
  const rogueDir = mkdtempSync(join(tmpdir(), 'friday-apple-sec-rogue-'));
  try {
    const pluginDataDir = join(home, 'plugins', 'apple-devices');
    const cfgRes = await runAppleAction('config', {
      dataDir: rogueDir,
      minBatteryPct: 30,
    }, { homeDir: home, pluginDataDir });
    assert.equal(cfgRes.ok, true);
    assert.equal(existsSync(join(rogueDir, 'config.json')), false, 'args.dataDir must never redirect writes');
    assert.equal(existsSync(join(pluginDataDir, 'config.json')), true);
    assert.equal(statSync(pluginDataDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(pluginDataDir, 'config.json')).mode & 0o777, 0o600);
    assert.equal('configPath' in (cfgRes.data ?? {}), false);
    assert.equal(JSON.stringify(cfgRes).includes(home), false);

    // Host discovers built-in apple-devices plugin
    const manifests = listPluginsSync(home);
    const meta = manifests.find(m => m.name === 'apple-devices');
    assert.ok(meta, 'apple-devices must be discovered by host');
    assert.equal(meta.runtime, 'in-process');
    assert.equal(meta.voiceFastpath, true);

    // Member role MUST NOT access apple-devices via voice fastpath
    const memberTry = await tryPluginVoiceFastpath(home, {
      text: '我的手机还有多少电',
      channelId: 'xiaoai-1',
      platform: 'xiaoai',
      speakerRole: 'member',
    });
    assert.equal(memberTry, undefined, 'member role must be blocked from apple-devices voice fastpath');

    // Owner role CAN access apple-devices via voice fastpath (returns unauthenticated guidance cleanly)
    const ownerTry = await tryPluginVoiceFastpath(home, {
      text: '我的手机还有多少电',
      channelId: 'xiaoai-1',
      platform: 'xiaoai',
      speakerRole: 'owner',
    });
    assert.ok(ownerTry?.handled);
    assert.equal(ownerTry.plugin, 'apple-devices');

    // Also verify runPlugin in-process works and redacts secrets when session exists
    const mock = createMockAppleFetch({
      appleId: 'sec@icloud.com',
      password: 'VerySecretPassword!',
      require2fa: false,
      devices: [{
        id: 'RAW-SECRET-DEVICE-999',
        name: '我的 iPhone',
        deviceDisplayName: 'iPhone 16',
        deviceClass: 'iPhone',
        deviceStatus: '200',
        batteryLevel: 0.55,
        batteryStatus: 'NotCharging',
      }],
    });
    await runAppleAction('auth-login', { appleId: 'sec@icloud.com', password: 'VerySecretPassword!' }, {
      homeDir: home,
      pluginDataDir,
      fetchFn: mock.fetchFn,
    });
    assert.equal(statSync(join(pluginDataDir, 'session.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(pluginDataDir, 'devices-cache.json')).mode & 0o777, 0o600);

    const statusViaHost = await runPlugin(home, 'apple-devices', 'status', {});
    const serialized = JSON.stringify(statusViaHost);
    for (const secret of [
      home,
      'VerySecretPassword!',
      'TOKEN_SECRET_COOKIE',
      'trusted-token-xyz',
      'session-token-abc',
      'RAW-SECRET-DEVICE-999',
      'sec@icloud.com',
    ]) {
      assert.equal(serialized.includes(secret), false, `status output must redact ${secret}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(rogueDir, { recursive: true, force: true });
  }
});

test('6. Voice fastpath handles Chinese battery, ring, and location intents while bailing out on negations/timers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-apple-voice-'));
  try {
    const dataDir = join(home, 'plugins', 'apple-devices');
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const mock = createMockAppleFetch({
      appleId: 'voice@icloud.com',
      password: 'VoicePassword1!',
      require2fa: false,
      devices: [
        {
          id: 'RAW-IPHONE-V1',
          name: '主力 iPhone',
          deviceDisplayName: 'iPhone 16',
          deviceClass: 'iPhone',
          deviceStatus: '200',
          batteryLevel: 0.42,
          batteryStatus: 'NotCharging',
          location: { latitude: 31.2304, longitude: 121.4737, horizontalAccuracy: 8, positionType: 'GPS', timeStamp: Date.now() },
        },
        {
          id: 'RAW-IPAD-V2',
          name: '客厅 iPad',
          deviceDisplayName: 'iPad Pro',
          deviceClass: 'iPad',
          deviceStatus: '200',
          batteryLevel: 0.99,
          batteryStatus: 'Charged',
        },
      ],
    });
    await runAppleAction('config', {
      places: { 家: { lat: 31.2304, lng: 121.4737, radiusMeters: 250 } },
    }, { homeDir: home, pluginDataDir: dataDir });
    await runAppleAction('auth-login', { appleId: 'voice@icloud.com', password: 'VoicePassword1!' }, {
      homeDir: home,
      pluginDataDir: dataDir,
      fetchFn: mock.fetchFn,
    });

    const batRes = await tryPluginVoiceFastpath(home, {
      text: '<|zh|>小爱同学，我的手机还有多少电？',
      channelId: 'xiaoai-1',
      platform: 'xiaoai',
      speakerRole: 'owner',
    });
    assert.equal(batRes?.handled, true);
    assert.match(batRes?.speech ?? '', /42%/);

    const allBatRes = await tryPluginVoiceFastpath(home, {
      text: '星期五，所有苹果设备还有多少电',
      channelId: 'xiaoai-1',
      platform: 'xiaoai',
      speakerRole: 'owner',
    });
    assert.equal(allBatRes?.handled, true);
    assert.match(allBatRes?.speech ?? '', /主力 iPhone/);
    assert.match(allBatRes?.speech ?? '', /客厅 iPad/);

    const locRes = await tryPluginVoiceFastpath(home, {
      text: '我的手机现在在家吗',
      channelId: 'xiaoai-1',
      platform: 'xiaoai',
      speakerRole: 'owner',
    });
    assert.equal(locRes?.handled, true);
    assert.match(locRes?.speech ?? '', /在家附近/);

    const ringRes = await tryPluginVoiceFastpath(home, {
      text: '帮我让手机响一下',
      channelId: 'xiaoai-1',
      platform: 'xiaoai',
      speakerRole: 'owner',
    });
    assert.equal(ringRes?.handled, true);
    assert.equal(ringRes?.action, 'play-sound');

    for (const bailout of [
      '别让手机响',
      '10分钟后提醒我看手机电量',
      '帮我登录苹果账号',
      '如果手机电量低就发微信给我',
    ]) {
      const res = await tryPluginVoiceFastpath(home, {
        text: bailout,
        channelId: 'xiaoai-1',
        platform: 'xiaoai',
        speakerRole: 'owner',
      });
      assert.equal(res, undefined, `"${bailout}" must bail out to Router`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('7. Web console lazy-loads apple-devices-ui.js, renders panel cleanly, and handles /api/plugin-run', { timeout: 15000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-apple-web-'));
  const daemon = await serve({ home, mode: 'offline', offlineDelayMs: 30 });
  const web = await startWeb({ home });
  try {
    const entry = new URL(web.url);
    const base = entry.origin;
    const token = new URLSearchParams(entry.hash.slice(1)).get('token')!;
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

    const html = await (await fetch(`${base}/legacy`)).text();
    assert.match(html, /id="plugin-tab-apple-devices"/);
    assert.match(html, /id="plugin-panel-apple-devices"/);
    assert.match(html, /id="apple-cfg-include-family"/);
    assert.match(html, /id="apple-geo-status-hint"/);
    assert.match(html, /id="apple-open-geo-btn"/);
    assert.doesNotMatch(html, /\sstyle="/i);

    const clientJs = await (await fetch(`${base}/client.js`)).text();
    assert.match(clientJs, /import\(\s*['"]\.\/plugins\/apple-devices-ui\.js['"]\s*\)/);

    const appleUiResp = await fetch(`${base}/plugins/apple-devices-ui.js`);
    assert.equal(appleUiResp.status, 200);
    assert.match(appleUiResp.headers.get('content-type') ?? '', /javascript/);
    const appleUiJs = await appleUiResp.text();
    assert.match(appleUiJs, /initAppleDevicesUi/);
    assert.match(appleUiJs, /cacheOnly:\s*true/);
    assert.doesNotMatch(appleUiJs, /\.style\./);
    assert.doesNotMatch(appleUiJs, /\.innerHTML\b/);

    const statusRes = await (await fetch(`${base}/api/plugin-run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ plugin: 'apple-devices', action: 'status', args: {} }),
    })).json() as { ok: boolean; plugin: string; data?: { authState: string; region: string } };
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.plugin, 'apple-devices');
    assert.equal(statusRes.data?.authState, 'unauthenticated');
    assert.equal(statusRes.data?.region, 'cn');
    assert.equal(JSON.stringify(statusRes).includes(home), false);
  } finally {
    await web.close();
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('8. Wake-settling 203->200 poll, cached battery preservation on sleep, pending cooldown bypass, and family sharing default', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'friday-apple-wake-'));
  let now = 1_760_000_000_000;
  try {
    let phase: 'settling' | 'sleeping' = 'settling';
    let expectedFmly = true;
    const personalPending = {
      id: 'RAW-OWN-IPHONE',
      name: '我的主手机',
      deviceDisplayName: 'iPhone 17 Pro',
      rawDeviceModel: 'iPhone18,4',
      deviceClass: 'iPhone',
      deviceStatus: '203',
      batteryLevel: 0,
      batteryStatus: 'Unknown',
      isLocating: true,
      features: { SND: true, LOC: true },
    };
    const personalSettled = {
      ...personalPending,
      deviceStatus: '200',
      batteryLevel: 0.62,
      batteryStatus: 'Charging',
      isLocating: false,
      location: { latitude: 31.2304, longitude: 121.4737, horizontalAccuracy: 10, positionType: 'GPS', timeStamp: now },
    };
    const familySettled = {
      id: 'RAW-FMLY-IPHONE',
      name: '家人 iPhone',
      deviceDisplayName: 'iPhone 16',
      rawDeviceModel: 'iPhone17,2',
      deviceClass: 'iPhone',
      deviceStatus: '200',
      batteryLevel: 0.14,
      batteryStatus: 'NotCharging',
      isLocating: false,
      fmlyShare: true,
      features: { SND: true, LOC: true },
    };

    let refreshAttemptsThisCycle = 0;
    const mock = createMockAppleFetch({
      appleId: 'wake@icloud.com',
      password: 'Password123!',
      require2fa: false,
      fmipResponder: (path, body) => {
        assert.equal(body.clientContext.fmly, expectedFmly);
        if (phase === 'sleeping') {
          return {
            content: [{ ...personalPending, isLocating: false }, familySettled],
          };
        }
        if (path === '/initClient') {
          refreshAttemptsThisCycle = 0;
          return {
            userInfo: { hasMembers: true, membersInfo: { m1: { deviceFetchStatus: 'LOADING' } } },
            content: [personalPending],
          };
        }
        refreshAttemptsThisCycle += 1;
        if (refreshAttemptsThisCycle === 1) {
          // Immediate refresh still reports 203/LOADING
          return {
            userInfo: { hasMembers: true, membersInfo: { m1: { deviceFetchStatus: 'LOADING' } } },
            content: [personalPending],
          };
        }
        // Poll 1 after wake settling returns settled 200 personal + family devices
        return {
          userInfo: { hasMembers: true, membersInfo: { m1: { deviceFetchStatus: 'DONE' } } },
          content: [personalSettled, familySettled],
        };
      },
    });

    await runAppleAction('config', { minBatteryPct: 25, minRefreshIntervalSec: 30 }, { dataDir, nowFn: () => now });
    const loginRes = await runAppleAction('auth-login', {
      appleId: 'wake@icloud.com',
      password: 'Password123!',
    }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now, locatePollDelayMs: 5 });

    assert.equal(loginRes.ok, true);
    assert.equal(loginRes.data.devices.length, 2, 'default includeFamily=true must include family-shared devices');
    const own = loginRes.data.devices.find((d: any) => !d.isFamily);
    const fmly = loginRes.data.devices.find((d: any) => d.isFamily);
    assert.equal(own.online, true);
    assert.equal(own.batteryPercent, 62);
    assert.equal(own.batteryIsCached, false);
    assert.equal(own.soundCapable, true);
    assert.equal(fmly.online, true);
    assert.equal(fmly.batteryPercent, 14);
    assert.equal(fmly.isFamily, true);

    // Category locate "手机" resolves unambiguously to personal iPhone instead of failing with ambiguous family iPhone
    const locateOwn = await runAppleAction('locate', { device: '手机' }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
    assert.equal(locateOwn.ok, true);
    assert.equal(locateOwn.data.device.name, '我的主手机');

    // play-sound sends fmly: true and works
    const ringRes = await runAppleAction('play-sound', { device: fmly.id }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
    assert.equal(ringRes.ok, true);
    const soundCall = mock.calls.find(c => c.url.includes('/playSound'));
    assert.equal(soundCall?.body?.clientContext?.fmly, true);

    // Personal device later enters 203 Unknown -> preserves last known 62% battery with batteryIsCached=true
    now += 40_000;
    phase = 'sleeping';
    const sleepRes = await runAppleAction('devices', { refresh: true }, {
      dataDir,
      fetchFn: mock.fetchFn,
      nowFn: () => now,
      locatePollDelayMs: 5,
    });
    assert.equal(sleepRes.ok, true);
    const sleepingOwn = sleepRes.data.devices.find((d: any) => !d.isFamily);
    assert.equal(sleepingOwn.online, false);
    assert.equal(sleepingOwn.deviceStatus, 'pending');
    assert.equal(sleepingOwn.deviceStatusLabel, '待机');
    assert.equal(sleepingOwn.batteryPercent, 62);
    assert.equal(sleepingOwn.batteryIsCached, true);

    // cacheOnly status must perform zero HTTP calls
    const callCountBeforeCacheOnly = mock.calls.length;
    now += 600_000; // even far past cacheTtlSec
    const cacheOnlyRes = await runAppleAction('status', { cacheOnly: true }, {
      dataDir,
      fetchFn: mock.fetchFn,
      nowFn: () => now,
    });
    assert.equal(cacheOnlyRes.ok, true);
    assert.equal(cacheOnlyRes.data.fromCache, true);
    assert.equal(mock.calls.length, callCountBeforeCacheOnly, 'cacheOnly status must not make network calls');

    // Regular status (without cacheOnly) auto-syncs expired cache and respects includeFamily toggling
    phase = 'settling';
    expectedFmly = false;
    await runAppleAction('config', { includeFamily: false }, { dataDir, nowFn: () => now });
    const autoSyncRes = await runAppleAction('status', {}, {
      dataDir,
      fetchFn: mock.fetchFn,
      nowFn: () => now,
      locatePollDelayMs: 5,
    });
    assert.equal(autoSyncRes.ok, true);
    assert.equal(autoSyncRes.data.fromCache, false);
    assert.equal(mock.calls.at(-1)?.body?.clientContext?.fmly, false);
    expectedFmly = true;

    // Pending-only cache (all offline & null battery) bypasses 30s cooldown after >= 3s
    const pendingDir = mkdtempSync(join(tmpdir(), 'friday-apple-pend-'));
    try {
      let pNow = 1_760_000_000_000;
      let pOnline = false;
      const pMock = createMockAppleFetch({
        appleId: 'pend@icloud.com',
        password: 'Password123!',
        require2fa: false,
        fmipResponder: () => ({
          content: [pOnline ? personalSettled : { ...personalPending, isLocating: false }],
        }),
      });
      await runAppleAction('auth-login', { appleId: 'pend@icloud.com', password: 'Password123!' }, {
        dataDir: pendingDir,
        fetchFn: pMock.fetchFn,
        nowFn: () => pNow,
        locatePollDelayMs: 5,
      });
      // Only 5s later (< 30s cooldown): incomplete pending cache still allows manual refresh!
      pNow += 5_000;
      pOnline = true;
      const retryRes = await runAppleAction('devices', { refresh: true }, {
        dataDir: pendingDir,
        fetchFn: pMock.fetchFn,
        nowFn: () => pNow,
        locatePollDelayMs: 5,
      });
      assert.equal(retryRes.data.cooldownActive, false, 'incomplete cache must bypass 30s cooldown');
      assert.equal(retryRes.data.fromCache, false);
      assert.equal(retryRes.data.devices[0].online, true);
      assert.equal(retryRes.data.devices[0].batteryPercent, 62);
    } finally {
      rmSync(pendingDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('9. System Base AMap regeo converts WGS-84->GCJ-02, shares 22m grid cache, redacts safely, and matches GCJ-02 geofences', async () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'friday-apple-geo-'));
  let now = 1_760_100_000_000;
  try {
    const savedGeo = await saveSystemGeoConfig({ homeDir, amapKey: 'test_system_amap_key_9988' });
    assert.equal(savedGeo.configured, true);
    assert.equal(savedGeo.source, 'system');
    assert.equal(savedGeo.maskedKey, 'test****9988');
    const geoCfgMode = statSync(join(homeDir, 'geo-config.json')).mode & 0o777;
    assert.equal(geoCfgMode, 0o600);

    // Device 1 & Device 2 are ~10m apart (same ~22m grid cell after WGS-84 -> GCJ-02);
    // Device 3 is in another district matching a user-pasted GCJ-02 home coordinate.
    const wgsOfficeLat = 31.23041;
    const wgsOfficeLon = 121.47371;
    const wgsHomeLat = 31.1955;
    const wgsHomeLon = 121.4388;
    const gcjHome = wgs84ToGcj02(wgsHomeLat, wgsHomeLon);
    assert.equal(gcjHome.inChina, true);
    assert.ok(Math.abs(gcjHome.lat - wgsHomeLat) > 0.0005 || Math.abs(gcjHome.lon - wgsHomeLon) > 0.0005);

    const amapCalls: string[] = [];
    const amapRequester = async (url: string) => {
      amapCalls.push(url);
      const parsedUrl = new URL(url);
      assert.equal(parsedUrl.searchParams.get('key'), 'test_system_amap_key_9988');
      const locParam = parsedUrl.searchParams.get('location') || '';
      const [lonStr, latStr] = locParam.split(',');
      const qLon = Number(lonStr);
      const qLat = Number(latStr);
      // Verify WGS-84 coordinates were converted to GCJ-02 before calling AMap
      assert.notEqual(locParam, `${wgsOfficeLon.toFixed(6)},${wgsOfficeLat.toFixed(6)}`);
      const isHome = Math.abs(qLat - gcjHome.lat) < 0.01;
      return {
        status: 200,
        body: JSON.stringify({
          status: '1',
          info: 'OK',
          regeocode: {
            formatted_address: isHome
              ? '上海市徐汇区漕溪北路398号百脑汇'
              : '上海市黄浦区南京东路街道人民广场200号',
            addressComponent: {
              district: isHome ? '徐汇区' : '黄浦区',
              streetNumber: {
                street: isHome ? '漕溪北路' : '人民大道',
                number: isHome ? '398号' : '200号',
              },
            },
            aois: [{ name: isHome ? '徐家汇商圈' : '人民广场' }],
            pois: [],
          },
        }),
      };
    };

    const mock = createMockAppleFetch({
      appleId: 'geo@icloud.com',
      password: 'Password123!',
      require2fa: false,
      devices: [
        {
          id: 'DEV-IPHONE-OFFICE',
          name: 'iPhone 17 Pro',
          deviceDisplayName: 'iPhone 17 Pro',
          rawDeviceModel: 'iPhone18,4',
          deviceClass: 'iPhone',
          deviceStatus: '200',
          batteryLevel: 0.88,
          batteryStatus: 'NotCharging',
          location: { latitude: wgsOfficeLat, longitude: wgsOfficeLon, horizontalAccuracy: 12, positionType: 'GPS', timeStamp: now },
          features: { SND: true, LOC: true },
        },
        {
          id: 'DEV-IPAD-OFFICE',
          name: 'iPad Pro',
          deviceDisplayName: 'iPad Pro',
          rawDeviceModel: 'iPad16,3',
          deviceClass: 'iPad',
          deviceStatus: '200',
          batteryLevel: 0.77,
          batteryStatus: 'NotCharging',
          location: { latitude: 31.23042, longitude: 121.47372, horizontalAccuracy: 18, positionType: 'Wifi', timeStamp: now },
          features: { SND: true, LOC: true },
        },
        {
          id: 'DEV-MAC-HOME',
          name: 'Mac mini',
          deviceDisplayName: 'Mac mini',
          rawDeviceModel: 'Mac15,12',
          deviceClass: 'Mac',
          deviceStatus: '200',
          batteryLevel: 1,
          batteryStatus: 'Charged',
          location: { latitude: wgsHomeLat, longitude: wgsHomeLon, horizontalAccuracy: 20, positionType: 'Wifi', timeStamp: now },
          features: { SND: true, LOC: true },
        },
      ],
    });

    // Configure geofence using AMap GCJ-02 coordinates even though Apple returns WGS-84
    const cfgRes = await runAppleAction('config', {
      places: { 家: { lat: gcjHome.lat, lng: gcjHome.lon, radiusMeters: 150 } },
    }, { homeDir, nowFn: () => now });
    assert.equal(cfgRes.ok, true);
    assert.equal(cfgRes.data.geoConfigured, true);

    const loginRes = await runAppleAction('auth-login', {
      appleId: 'geo@icloud.com',
      password: 'Password123!',
    }, { homeDir, fetchFn: mock.fetchFn, nowFn: () => now, amapRequester });
    assert.equal(loginRes.ok, true);
    assert.equal(loginRes.data.geoConfigured, true);

    // Shared ~22m grid cache means iPhone & iPad at office only triggered 1 AMap request + 1 for Mac at home = 2 total!
    assert.equal(amapCalls.length, 2);

    const iphone = loginRes.data.devices.find((d: any) => d.name === 'iPhone 17 Pro');
    const ipad = loginRes.data.devices.find((d: any) => d.name === 'iPad Pro');
    const mac = loginRes.data.devices.find((d: any) => d.name === 'Mac mini');
    assert.equal(iphone.location.shortAddress, '黄浦区人民大道200号 · 人民广场');
    assert.equal(ipad.location.shortAddress, '黄浦区人民大道200号 · 人民广场');
    assert.equal(mac.place?.name, '家');
    assert.equal(mac.place?.inside, true);
    assert.ok((mac.place?.distanceMeters ?? 999) <= 5, `dual-coordinate geofence must match within 5m, got ${mac.place?.distanceMeters}`);

    // locate with redactCoords=true preserves Chinese shortAddress while redacting numeric coordinates
    const locRedacted = await runAppleAction('locate', { device: 'iPhone', redactCoords: true }, {
      homeDir,
      fetchFn: mock.fetchFn,
      nowFn: () => now,
      amapRequester,
    });
    assert.equal(locRedacted.ok, true);
    assert.equal(locRedacted.data.device.location.latitude, undefined);
    assert.equal(locRedacted.data.device.location.longitude, undefined);
    assert.equal(locRedacted.data.device.location.gcjLat, undefined);
    assert.equal(locRedacted.data.device.location.gcjLon, undefined);
    assert.equal(locRedacted.data.device.location.shortAddress, '黄浦区人民大道200号 · 人民广场');
    assert.match(locRedacted.message ?? '', /人民广场/);
    assert.equal((locRedacted.message ?? '').includes('undefined'), false);
    assert.equal(amapCalls.length, 2, 'cached status/locate must reuse shared geo-cache.sqlite without extra AMap requests');
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('10. FMiP recovery after 15m sessionLifespan, /setup/ws/1/validate renewal, transient error preservation, expiry logging, playSound recovery, and DES trust cookie persistence', async () => {
  const sampleDev = {
    id: 'RAW-APPLE-RECOVERY-001',
    name: '主力 iPhone',
    deviceDisplayName: 'iPhone 17 Pro',
    rawDeviceModel: 'iPhone18,4',
    deviceClass: 'iPhone',
    deviceStatus: '200',
    batteryLevel: 0.85,
    batteryStatus: 'NotCharging',
    features: { SND: true, LOC: true },
  };

  // 10a. Proactive FMiP re-init after 15m sessionLifespan & reactive /refreshClient 450 -> /initClient 200 recovery
  {
    const dataDir = mkdtempSync(join(tmpdir(), 'friday-apple-proactive-'));
    let now = 1_760_200_000_000;
    let rejectNextRefresh = false;
    try {
      const mock = createMockAppleFetch({
        appleId: 'recover@icloud.com',
        password: 'Password123!',
        require2fa: false,
        devices: [sampleDev],
        initClientHandler: (_body, headers) => {
          assert.equal((headers.cookie ?? '').includes('X-APPLE-WEBAUTH-FMIP='), false, 'stale FMIP cookie must be cleared before /initClient');
          return makeMockResponse(200, {
            statusCode: '200',
            serverContext: { serverTimestamp: now, callbackIntervalInMS: 2000, sessionLifespan: 900_000 },
            content: [sampleDev],
          }, {
            'set-cookie': ['X-APPLE-WEBAUTH-FMIP=FMIP_COOKIE_FRESH; Domain=.icloud.com.cn; Path=/; HttpOnly'],
          });
        },
        refreshClientHandler: (_body, headers) => {
          if (rejectNextRefresh) {
            rejectNextRefresh = false;
            return makeMockResponse(450, { error: 'FMiP subsession expired' });
          }
          assert.ok((headers.cookie ?? '').includes('X-APPLE-WEBAUTH-FMIP=FMIP_COOKIE_FRESH'));
          return makeMockResponse(200, {
            statusCode: '200',
            serverContext: { serverTimestamp: now, callbackIntervalInMS: 2000, sessionLifespan: 900_000 },
            content: [sampleDev],
          });
        },
      });

      const loginRes = await runAppleAction('auth-login', {
        appleId: 'recover@icloud.com',
        password: 'Password123!',
      }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
      assert.equal(loginRes.ok, true);

      // Advance +60 min (past 15m sessionLifespan) -> proactively clears FMIP cookie and calls /initClient directly
      const callsBefore = mock.calls.length;
      now += 3_600_000;
      const proactiveRes = await runAppleAction('status', { refresh: true }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
      assert.equal(proactiveRes.ok, true);
      assert.equal(proactiveRes.data.authState, 'authenticated');
      const proactiveSlice = mock.calls.slice(callsBefore);
      assert.ok(proactiveSlice.some(c => c.url.includes('/initClient')), 'must proactively call /initClient after sessionLifespan');
      assert.equal(proactiveSlice.some(c => c.url.includes('/accountLogin')), false, 'must NOT hit /accountLogin when /initClient succeeds');

      // Within 5 min (<15m) reactive /refreshClient 450 recovers directly via /initClient without calling /accountLogin
      now += 360_000;
      rejectNextRefresh = true;
      const callsBeforeReactive = mock.calls.length;
      const reactiveRes = await runAppleAction('devices', { refresh: true }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
      assert.equal(reactiveRes.ok, true);
      assert.equal(reactiveRes.data.authState, 'authenticated');
      const reactiveSlice = mock.calls.slice(callsBeforeReactive);
      assert.ok(reactiveSlice.some(c => c.url.includes('/refreshClient')));
      assert.ok(reactiveSlice.some(c => c.url.includes('/initClient')));
      assert.equal(reactiveSlice.some(c => c.url.includes('/accountLogin')), false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  // 10b-1. Live 196 behavior: /refreshClient 450 -> /initClient 450 -> /accountLogin 200 -> /initClient 200 (even when /validate alone does not re-authorize FMiP)
  {
    const dataDir = mkdtempSync(join(tmpdir(), 'friday-apple-acctlogin-'));
    let now = 1_760_250_000_000;
    let needAccountLogin = false;
    try {
      const mock = createMockAppleFetch({
        appleId: 'live196@icloud.com',
        password: 'Password123!',
        require2fa: false,
        devices: [sampleDev],
        accountLoginHandler: (reqBody) => {
          assert.ok(reqBody.dsWebAuthToken);
          needAccountLogin = false;
          return makeMockResponse(200, {
            hsaTrustedBrowser: true,
            dsInfo: { appleId: 'live196@icloud.com', dsid: '123456789' },
            webservices: { findme: { url: 'https://p123-fmipweb.icloud.com.cn:443', status: 'active' } },
          }, {
            'set-cookie': [
              'X-APPLE-WEBAUTH-USER=USER_1; Domain=.icloud.com.cn; Path=/; HttpOnly',
              'X-APPLE-WEBAUTH-TOKEN=WEBAUTH_MINTED; Domain=.icloud.com.cn; Path=/; HttpOnly',
            ],
          });
        },
        validateHandler: () => makeMockResponse(200, {
          hsaTrustedBrowser: true,
          dsInfo: { appleId: 'live196@icloud.com', dsid: '123456789' },
          webservices: { findme: { url: 'https://p123-fmipweb.icloud.com.cn:443', status: 'active' } },
        }),
        initClientHandler: () => {
          if (needAccountLogin) return makeMockResponse(450, { error: 'FMiP auth needs accountLogin' });
          return makeMockResponse(200, {
            statusCode: '200',
            serverContext: { serverTimestamp: now, callbackIntervalInMS: 2000, sessionLifespan: 900_000 },
            content: [sampleDev],
          }, {
            'set-cookie': ['X-APPLE-WEBAUTH-FMIP=FMIP_COOKIE_MINTED; Domain=.icloud.com.cn; Path=/; HttpOnly'],
          });
        },
        refreshClientHandler: () => {
          if (needAccountLogin) return makeMockResponse(450, { error: 'FMiP subsession expired' });
          return makeMockResponse(200, {
            statusCode: '200',
            serverContext: { serverTimestamp: now, callbackIntervalInMS: 2000, sessionLifespan: 900_000 },
            content: [sampleDev],
          });
        },
      });

      await runAppleAction('auth-login', {
        appleId: 'live196@icloud.com',
        password: 'Password123!',
      }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });

      const sessPath = join(dataDir, 'session.json');
      const savedSess = JSON.parse(readFileSync(sessPath, 'utf8'));
      delete savedSess.fmipContextUpdatedAt;
      savedSess.lastError = { at: now, action: 'devices', stage: 'fmip_init', code: 'AUTH_EXPIRED', status: 450, message: 'old' };
      const { writeFileSync } = await import('node:fs');
      writeFileSync(sessPath, JSON.stringify(savedSess), { mode: 0o600 });

      now += 1_860_000; // +31m (matches 196 timing)
      needAccountLogin = true;
      const callsBefore = mock.calls.length;
      const recovered = await runAppleAction('status', { refresh: true }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.data.authState, 'authenticated');
      assert.equal(recovered.data.devices.length, 1);

      const slice = mock.calls.slice(callsBefore);
      const acctIdx = slice.findIndex(c => c.url.includes('/setup/ws/1/accountLogin'));
      const valIdx = slice.findIndex(c => c.url.includes('/setup/ws/1/validate'));
      assert.ok(acctIdx >= 0, 'Stage A must call /setup/ws/1/accountLogin');
      assert.equal(valIdx, -1, 'must NOT need /validate once accountLogin + initClient succeeds');

      const postSess = JSON.parse(readFileSync(sessPath, 'utf8'));
      assert.equal(postSess.state, 'authenticated');
      assert.equal(postSess.cookies['X-APPLE-WEBAUTH-FMIP'], 'FMIP_COOKIE_MINTED');
      assert.equal(postSess.lastError, undefined);
      assert.equal(typeof postSess.fmipContextUpdatedAt, 'number');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  // 10b-2. Stage B fallback: /refreshClient 450 -> /initClient 450 -> /accountLogin 421 -> /validate 200 -> /initClient 200
  {
    const dataDir = mkdtempSync(join(tmpdir(), 'friday-apple-validate-'));
    let now = 1_760_300_000_000;
    let failUntilValidated = false;
    try {
      const mock = createMockAppleFetch({
        appleId: 'prod196@icloud.com',
        password: 'Password123!',
        require2fa: false,
        devices: [sampleDev],
        accountLoginHandler: (reqBody) => {
          // Allow initial login; reject any subsequent renewal attempt (simulating short-lived dsWebAuthToken expiry)
          if (failUntilValidated) {
            return makeMockResponse(421, { error: 'dsWebAuthToken expired' });
          }
          assert.ok(reqBody.dsWebAuthToken);
          return makeMockResponse(200, {
            hsaTrustedBrowser: true,
            dsInfo: { appleId: 'prod196@icloud.com', dsid: '123456789' },
            webservices: { findme: { url: 'https://p123-fmipweb.icloud.com.cn:443', status: 'active' } },
          }, {
            'set-cookie': [
              'X-APPLE-WEBAUTH-USER=USER_1; Domain=.icloud.com.cn; Path=/; HttpOnly',
              'X-APPLE-WEBAUTH-TOKEN=WEBAUTH_INITIAL; Domain=.icloud.com.cn; Path=/; HttpOnly',
            ],
          });
        },
        validateHandler: (headers) => {
          assert.ok((headers.cookie ?? '').includes('X-APPLE-WEBAUTH-TOKEN=WEBAUTH_INITIAL'));
          failUntilValidated = false;
          return makeMockResponse(200, {
            hsaTrustedBrowser: true,
            dsInfo: { appleId: 'prod196@icloud.com', dsid: '123456789' },
            webservices: { findme: { url: 'https://p205-fmipweb.icloud.com.cn:443', status: 'active' } },
          }, {
            'set-cookie': ['X-APPLE-WEBAUTH-TOKEN=WEBAUTH_RENEWED; Domain=.icloud.com.cn; Path=/; HttpOnly'],
          });
        },
        initClientHandler: () => {
          if (failUntilValidated) return makeMockResponse(450, { error: 'Need validate' });
          return makeMockResponse(200, {
            statusCode: '200',
            serverContext: { serverTimestamp: now, callbackIntervalInMS: 2000, sessionLifespan: 900_000 },
            content: [sampleDev],
          });
        },
        refreshClientHandler: () => {
          if (failUntilValidated) return makeMockResponse(450, { error: 'FMiP expired' });
          return makeMockResponse(200, {
            statusCode: '200',
            serverContext: { serverTimestamp: now, callbackIntervalInMS: 2000, sessionLifespan: 900_000 },
            content: [sampleDev],
          });
        },
      });
      // Also allow p205 host in validate scenario by handling it cleanly via custom fetch wrapper
      const p205Fetch: typeof fetch = async (input, init) => {
        const u = String(input);
        if (u.startsWith('https://p205-fmipweb.icloud.com.cn/')) {
          return makeMockResponse(200, {
            statusCode: '200',
            serverContext: { serverTimestamp: now, callbackIntervalInMS: 2000, sessionLifespan: 900_000 },
            content: [sampleDev],
          });
        }
        return mock.fetchFn(input, init);
      };

      await runAppleAction('auth-login', {
        appleId: 'prod196@icloud.com',
        password: 'Password123!',
      }, { dataDir, fetchFn: p205Fetch, nowFn: () => now });

      // Simulate legacy session (without fmipContextUpdatedAt) + short-lived dsWebAuthToken already dead
      const sessPath = join(dataDir, 'session.json');
      const savedSess = JSON.parse(readFileSync(sessPath, 'utf8'));
      delete savedSess.fmipContextUpdatedAt;
      savedSess.lastError = { at: now, action: 'devices', stage: 'fmip_refresh', code: 'OLD', status: 450, message: 'old' };
      const { writeFileSync } = await import('node:fs');
      writeFileSync(sessPath, JSON.stringify(savedSess), { mode: 0o600 });

      now += 3_600_000;
      failUntilValidated = true;
      const recovered = await runAppleAction('status', { refresh: true }, { dataDir, fetchFn: p205Fetch, nowFn: () => now });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.data.authState, 'authenticated');
      assert.equal(recovered.data.devices.length, 1);
      assert.ok(mock.calls.some(c => c.url.includes('/setup/ws/1/validate')), 'must fallback to /setup/ws/1/validate when accountLogin returns 421');
      const postSess = JSON.parse(readFileSync(sessPath, 'utf8'));
      assert.equal(postSess.state, 'authenticated');
      assert.equal(postSess.findmeUrl, 'https://p205-fmipweb.icloud.com.cn');
      assert.equal(postSess.cookies['X-APPLE-WEBAUTH-TOKEN'], 'WEBAUTH_RENEWED');
      assert.equal(postSess.lastError, undefined);
      assert.equal(typeof postSess.fmipContextUpdatedAt, 'number');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  // 10c. Transient 503 on /accountLogin or /validate must NOT mark session expired; confirmed 421 on both marks expired + writes redacted error.log
  {
    const dataDir = mkdtempSync(join(tmpdir(), 'friday-apple-expiry-'));
    let now = 1_760_400_000_000;
    let mode: 'ok' | 'acct503' | 'val503' | 'dead421' = 'ok';
    try {
      const mock = createMockAppleFetch({
        appleId: 'secretuser99@icloud.com',
        password: 'Password123!',
        require2fa: false,
        devices: [sampleDev],
        validateHandler: () => {
          if (mode === 'val503') return makeMockResponse(503, { error: 'Apple validate unavailable secretuser99@icloud.com' });
          if (mode === 'dead421') return makeMockResponse(421, { error: 'Missing X-APPLE-WEBAUTH-TOKEN for secretuser99@icloud.com' });
          return makeMockResponse(200, {
            hsaTrustedBrowser: true,
            dsInfo: { appleId: 'secretuser99@icloud.com', dsid: '123456789' },
            webservices: { findme: { url: 'https://p123-fmipweb.icloud.com.cn:443', status: 'active' } },
          });
        },
        accountLoginHandler: (reqBody) => {
          if (mode === 'acct503') return makeMockResponse(503, { error: 'Apple accountLogin unavailable secretuser99@icloud.com' });
          if (mode === 'val503' || mode === 'dead421') return makeMockResponse(421, { error: 'Session expired' });
          assert.ok(reqBody.dsWebAuthToken);
          return makeMockResponse(200, {
            hsaTrustedBrowser: true,
            dsInfo: { appleId: 'secretuser99@icloud.com', dsid: '123456789' },
            webservices: { findme: { url: 'https://p123-fmipweb.icloud.com.cn:443', status: 'active' } },
          }, {
            'set-cookie': ['X-APPLE-WEBAUTH-TOKEN=TOKEN_SECRET_COOKIE; Domain=.icloud.com.cn; Path=/; HttpOnly'],
          });
        },
        initClientHandler: () => {
          if (mode !== 'ok') return makeMockResponse(450, { error: 'FMiP expired' });
          return makeMockResponse(200, {
            statusCode: '200',
            serverContext: { serverTimestamp: now, callbackIntervalInMS: 2000, sessionLifespan: 900_000 },
            content: [sampleDev],
          });
        },
        refreshClientHandler: () => {
          if (mode !== 'ok') return makeMockResponse(450, { error: 'FMiP expired' });
          return makeMockResponse(200, {
            statusCode: '200',
            serverContext: { serverTimestamp: now, callbackIntervalInMS: 2000, sessionLifespan: 900_000 },
            content: [sampleDev],
          });
        },
      });

      await runAppleAction('auth-login', {
        appleId: 'secretuser99@icloud.com',
        password: 'Password123!',
      }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });

      // Transient 503 on /accountLogin keeps state=authenticated
      now += 3_600_000;
      mode = 'acct503';
      const acct503Res = await runAppleAction('status', { refresh: true }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
      assert.equal(acct503Res.ok, false);
      assert.equal(acct503Res.data.authState, 'authenticated', '503 on /accountLogin must NOT mark session expired');
      assert.equal(acct503Res.data.lastError?.stage, 'account_login');
      assert.equal(acct503Res.data.lastError?.status, 503);

      // Transient 503 on /validate (after /accountLogin 421) keeps state=authenticated
      now += 60_000;
      mode = 'val503';
      const val503Res = await runAppleAction('status', { refresh: true }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
      assert.equal(val503Res.ok, false);
      assert.equal(val503Res.data.authState, 'authenticated', '503 on /validate must NOT mark session expired');
      assert.equal(val503Res.data.lastError?.stage, 'validate');
      assert.equal(val503Res.data.lastError?.status, 503);

      // Confirmed 421 on both /accountLogin and /validate marks expired + records expiredAt & redacted error.log
      now += 60_000;
      mode = 'dead421';
      const deadRes = await runAppleAction('status', { refresh: true }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
      assert.equal(deadRes.ok, false);
      assert.equal(deadRes.data.authState, 'expired');
      assert.equal(deadRes.data.expiredAt, now);

      const errLogPath = join(dataDir, 'error.log');
      assert.equal(existsSync(errLogPath), true);
      assert.equal(statSync(errLogPath).mode & 0o777, 0o600);
      const logContent = readFileSync(errLogPath, 'utf8');
      assert.match(logContent, /\[apple-devices\].*action=devices.*stage=account_login.*http=503/);
      assert.match(logContent, /\[apple-devices\].*action=devices.*stage=validate.*http=503/);
      assert.match(logContent, /\[apple-devices\].*action=devices.*code=AUTH_EXPIRED/);
      assert.equal(logContent.includes('secretuser99@icloud.com'), false, 'raw email must be redacted in error.log');
      assert.equal(logContent.includes(dataDir), false, 'raw dataDir path must be redacted in error.log');
      assert.equal(logContent.includes('TOKEN_SECRET_COOKIE'), false, 'raw cookies must never appear in error.log');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  // 10d. play-sound recovers from FMiP 450 via /initClient + /validate and retries with fresh serverContext
  {
    const dataDir = mkdtempSync(join(tmpdir(), 'friday-apple-playsound-'));
    let now = 1_760_500_000_000;
    let playAttempts = 0;
    let initVersion = 1;
    try {
      const mock = createMockAppleFetch({
        appleId: 'ring@icloud.com',
        password: 'Password123!',
        require2fa: false,
        devices: [sampleDev],
        initClientHandler: () => {
          const ver = initVersion++;
          return makeMockResponse(200, {
            statusCode: '200',
            serverContext: { serverTimestamp: now, callbackIntervalInMS: 2000, sessionLifespan: 900_000, gen: ver },
            content: [sampleDev],
          });
        },
        playSoundHandler: (reqBody) => {
          playAttempts += 1;
          if (playAttempts === 1) {
            return makeMockResponse(450, { error: 'FMiP playSound expired' });
          }
          assert.equal(reqBody.serverContext?.gen, 2, 'retry playSound must send refreshed serverContext');
          return makeMockResponse(200, { statusCode: '200' });
        },
      });

      const loginRes = await runAppleAction('auth-login', {
        appleId: 'ring@icloud.com',
        password: 'Password123!',
      }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
      const devId = loginRes.data.devices[0].id;

      now += 60_000;
      const ringRes = await runAppleAction('play-sound', { device: devId }, { dataDir, fetchFn: mock.fetchFn, nowFn: () => now });
      assert.equal(ringRes.ok, true);
      assert.equal(playAttempts, 2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }

  // 10e. startAppleLogin preserves existing DES* trust cookies when re-logging in with trustToken
  {
    const dataDir = mkdtempSync(join(tmpdir(), 'friday-apple-descookie-'));
    try {
      let seenTrustCookieOnSignin = false;
      const mock = createMockAppleFetch({
        appleId: 'trustcookie@icloud.com',
        password: 'Password123!',
        require2fa: false,
        devices: [sampleDev],
        signinCompleteHandler: (reqBody, reqHeaders) => {
          const cookie = reqHeaders.cookie ?? '';
          if (reqBody.trustTokens?.[0] === 'trusted-token-xyz' && cookie.includes('DES5162f8ffe76c=TRUST_COOKIE_VAL')) {
            seenTrustCookieOnSignin = true;
          }
          return makeMockResponse(200, { authType: 'hsa2' }, {
            scnt: 'scnt-ok',
            'x-apple-id-session-id': 'session-id-1',
            'x-apple-session-token': 'session-token-abc',
            'x-apple-twosv-trust-token': 'trusted-token-xyz',
            'set-cookie': [
              'DES5162f8ffe76c=TRUST_COOKIE_VAL; Path=/; HttpOnly',
              'X-APPLE-WEBAUTH-TOKEN=TOKEN_SECRET_COOKIE; Path=/; HttpOnly',
            ],
          });
        },
      });

      await runAppleAction('auth-login', {
        appleId: 'trustcookie@icloud.com',
        password: 'Password123!',
      }, { dataDir, fetchFn: mock.fetchFn });

      await runAppleAction('auth-login', {
        appleId: 'trustcookie@icloud.com',
        password: 'Password123!',
      }, { dataDir, fetchFn: mock.fetchFn });

      assert.equal(seenTrustCookieOnSignin, true, 're-login for same account must preserve DES* trust cookies');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
});

import assert from 'node:assert/strict';
import {
  constants as cryptoConstants,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
} from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listPluginsSync, runPlugin, tryPluginVoiceFastpath } from '../src/plugin.js';

type NinebotCryptoModule = {
  PASSPORT_CLIENT_KEY: string;
  passportSign(urlPath: string, params: Record<string, unknown>): string;
  genNonce(): string;
  deriveKey(kd1: Buffer | string, kd2: Buffer | string, kd3: Buffer | string, kd4: Buffer | string): Buffer;
  androidB64(data: Buffer | string): string;
  buildInner(entriesOrObj: Array<[string, unknown]> | Record<string, unknown>): string;
  buildWrapper(
    innerBytes: Buffer | string,
    keyData: { kd1: string; kd2: string; kd3: string; kd4: string },
    platform?: number,
    timestampSec?: number,
  ): string;
  aesCbcEncrypt(key16: Buffer, plaintext: Buffer): Buffer;
  aesCbcDecrypt(key16: Buffer, ciphertext: Buffer): Buffer;
  buildRequest(
    innerBytes: Buffer | string,
    options?: {
      aesKey?: Buffer;
      keyData?: { kd1: string; kd2: string; kd3: string; kd4: string };
      platform?: number;
      timestampSec?: number;
      rsaPublicKeyPem?: string;
    },
  ): {
    body: { d: string; h: string; k: string; p: string; t: string };
    secrets: { aesKey: Buffer; kd1: string; kd2: string; kd3: string; kd4: string };
  };
  decryptWireResponse(
    respObj: { r?: unknown },
    secrets: { kd1: string; kd2: string; kd3: string; kd4: string },
  ): Record<string, unknown>;
  wgs84ToGcj02(lat: number, lon: number): { lat: number; lon: number };
};

type NinebotPluginModule = {
  ACTIONS: string[];
  DEFAULT_CONFIG: Record<string, unknown>;
  runAction(action: string, args?: Record<string, unknown>, deps?: Record<string, unknown>): Promise<Record<string, unknown>>;
  handleVoiceFastpath(request: Record<string, unknown>, context?: Record<string, unknown>): Promise<Record<string, unknown>>;
};

async function loadCryptoModule(): Promise<NinebotCryptoModule> {
  return await import('../plugins/ninebot/crypto.mjs') as unknown as NinebotCryptoModule;
}

async function loadPluginModule(): Promise<NinebotPluginModule> {
  return await import('../plugins/ninebot/index.mjs') as unknown as NinebotPluginModule;
}

function parseRawHeaders(rawHeaders: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    pairs.push([rawHeaders[i]!, rawHeaders[i + 1]!]);
  }
  return pairs;
}

function readReqBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

test('crypto primitives match Ninebot Passport & Netease unicorn-verified vectors', async () => {
  const c = await loadCryptoModule();

  // 1) Passport Sign test vector
  const sign = c.passportSign('/v6/user/login', {
    app_version: '610063322',
    areaCode: '86',
    device: 'ANDROID',
    os: 'Android',
    os_language: 'zh-hans-cn',
    os_version: '13',
    password: 'endtoendpw1',
    timestamp: '1786095783403',
    username: 'e2etest',
  });
  assert.equal(sign, '04c80df86771240724e875c511ef0d0af7511d74dea5d929d356c5a0302761a6');

  // 2) DeriveKey unicorn-verified test vector
  const dk = c.deriveKey(
    Buffer.from('abcdefghijklm'),
    Buffer.from('0123456789ab'),
    Buffer.from('XYZ'),
    Buffer.from('ninebot!'),
  );
  assert.equal(dk.toString('hex'), '82ffe6a8cbb9a4ffdbf791a74e37176e');

  // 3) AndroidB64
  assert.equal(c.androidB64(''), '');
  assert.equal(c.androidB64('hello'), 'aGVsbG8=\n');
  const longB64 = c.androidB64('x'.repeat(58));
  assert.equal((longB64.match(/\n/g) ?? []).length, 2);
  assert.equal(longB64.length, 82);

  // 4) GenNonce casing: 2 lowercase + 30 uppercase
  for (let i = 0; i < 15; i++) {
    const n = c.genNonce();
    assert.equal(n.length, 32);
    assert.equal(n.slice(0, 2), n.slice(0, 2).toLowerCase());
    assert.equal(n.slice(2), n.slice(2).toUpperCase());
  }

  // 5) BuildInner preserves tuple order, preserves <>&/UTF-8, and computes MD5 checkcode
  const inner = c.buildInner([
    ['sys_language', 'zh-hans-cn'],
    ['client_ver', '610063322'],
    ['note', 'a&b<c>九号'],
  ]);
  assert.ok(inner.startsWith('{"sys_language":"zh-hans-cn","client_ver":"610063322","note":"a&b<c>九号","checkcode":"'));
  const parsedInner = JSON.parse(inner) as Record<string, string>;
  const expectedNoCc = '{"sys_language":"zh-hans-cn","client_ver":"610063322","note":"a&b<c>九号"}';
  assert.equal(parsedInner.checkcode, createHash('md5').update(expectedNoCc).digest('hex').toUpperCase());

  // 6) BuildRequest -> DecryptWireResponse full round-trip (using real embedded RSA-1024 key for wire encryption)
  const sampleBiz = Buffer.from('{"wnumber":"M95C001","month":"202611"}', 'utf8');
  const { body, secrets } = c.buildRequest(sampleBiz, { timestampSec: 1_790_000_000 });
  assert.deepEqual(Object.keys(body).sort(), ['d', 'h', 'k', 'p', 't']);
  assert.equal(body.p, '101');
  assert.equal(body.t, '0');
  assert.equal(Buffer.from(body.k, 'base64').length, 128);

  const serverWrapperPlain = c.aesCbcDecrypt(secrets.aesKey, Buffer.from(body.d, 'base64'));
  assert.equal(createHash('md5').update(serverWrapperPlain).digest('hex'), body.h);
  const serverWrapper = JSON.parse(serverWrapperPlain.toString('utf8')) as Record<string, unknown>;
  assert.equal(serverWrapper.platform, 2);
  assert.equal(serverWrapper.timeStamp, 1_790_000_000);
  assert.equal(serverWrapper.keyDataOne, secrets.kd1);

  const respKey = c.deriveKey(secrets.kd1, secrets.kd2, secrets.kd3, secrets.kd4);
  const respWrapper = Buffer.from(
    JSON.stringify({
      data: c.androidB64(JSON.stringify({ code: 1, desc: '成功', data: { electricity: 88 } })),
      platform: 2,
      timeStamp: 1_790_000_001,
    }),
    'utf8',
  );
  const encryptedResp = { r: c.aesCbcEncrypt(respKey, respWrapper).toString('base64') };
  const decodedResp = c.decryptWireResponse(encryptedResp, secrets);
  assert.equal(decodedResp.code, 1);
  assert.deepEqual(decodedResp.data, { electricity: 88 });

  // 7) WGS-84 -> GCJ-02 conversion
  const bj = c.wgs84ToGcj02(39.9087, 116.3975);
  assert.ok(bj.lat > 39.909 && bj.lat < 39.915);
  assert.ok(bj.lon > 116.400 && bj.lon < 116.410);
  const zero = c.wgs84ToGcj02(0, 0);
  assert.deepEqual(zero, { lat: 0, lon: 0 });
  const sf = c.wgs84ToGcj02(37.7749, -122.4194);
  assert.deepEqual(sf, { lat: 37.7749, lon: -122.4194 });
});

test('loopback HTTP wire test verifies exact header casing, M-series routing, token refresh, trips, geo cache & official fallback', async () => {
  const c = await loadCryptoModule();
  const plugin = await loadPluginModule();

  const { publicKey: pubPem, privateKey: privPem } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  let nowMs = 1_790_000_000_000;
  let forceTokenExpiredNextBizCall = false;
  let motorFailsForFallback = false;
  let amapCallCount = 0;
  const recordedCalls: Array<{
    hostTag: string;
    path: string;
    rawHeaders: Array<[string, string]>;
    innerParams?: Record<string, unknown>;
  }> = [];

  function decryptIncomingWire(rawBody: string): {
    innerParams: Record<string, unknown>;
    kd1: string;
    kd2: string;
    kd3: string;
    kd4: string;
  } {
    const body = JSON.parse(rawBody) as { d: string; h: string; k: string; p: string; t: string };
    assert.equal(body.p, '101');
    assert.equal(body.t, '0');
    const aesKey = privateDecrypt(
      { key: privPem, padding: cryptoConstants.RSA_PKCS1_PADDING },
      Buffer.from(body.k, 'base64'),
    );
    const wrapperBuf = c.aesCbcDecrypt(aesKey, Buffer.from(body.d, 'base64'));
    assert.equal(createHash('md5').update(wrapperBuf).digest('hex'), body.h);
    const wrapper = JSON.parse(wrapperBuf.toString('utf8')) as Record<string, string>;
    const innerStr = Buffer.from(wrapper.data!.replace(/\s+/g, ''), 'base64').toString('utf8');
    const innerObj = JSON.parse(innerStr) as Record<string, unknown>;

    // Verify checkcode MD5 matches inner object excluding trailing checkcode
    const cc = innerObj.checkcode;
    const withoutCc: Array<[string, unknown]> = [];
    for (const [k, v] of Object.entries(innerObj)) {
      if (k !== 'checkcode') withoutCc.push([k, v]);
    }
    const rebuilt = JSON.parse(c.buildInner(withoutCc)) as Record<string, unknown>;
    assert.equal(cc, rebuilt.checkcode);

    return {
      innerParams: innerObj,
      kd1: wrapper.keyDataOne!,
      kd2: wrapper.keyDataTwo!,
      kd3: wrapper.keyDataThree!,
      kd4: wrapper.keyDataFour!,
    };
  }

  function encryptOutgoingWire(
    payload: Record<string, unknown>,
    keys: { kd1: string; kd2: string; kd3: string; kd4: string },
  ): string {
    const respKey = c.deriveKey(keys.kd1, keys.kd2, keys.kd3, keys.kd4);
    const wrapper = JSON.stringify({
      data: c.androidB64(JSON.stringify(payload)),
      platform: 2,
      timeStamp: Math.floor(nowMs / 1000),
    });
    return JSON.stringify({
      v: 101,
      r: c.aesCbcEncrypt(respKey, Buffer.from(wrapper, 'utf8')).toString('base64'),
    });
  }

  function startGatewayServer(hostTag: string) {
    const server = http.createServer(async (req, res) => {
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      const rawBody = await readReqBody(req);
      const rawHeaders = parseRawHeaders(req.rawHeaders);
      const path = urlObj.pathname;

      if (hostTag === 'amap' && path === '/regeo') {
        amapCallCount += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: '1',
            regeocode: {
              formatted_address: '北京市东城区东长安街1号',
              addressComponent: {
                district: '东城区',
                township: '东华门街道',
                streetNumber: { street: '东长安街', number: '1号' },
              },
            },
          }),
        );
        return;
      }

      if (hostTag === 'passport') {
        const parsed = JSON.parse(rawBody) as Record<string, string>;
        recordedCalls.push({ hostTag, path, rawHeaders });
        if (path === '/v6/user/login') {
          assert.equal(parsed.password, 'secret-pass-1');
          const expectedSign = c.passportSign('/v6/user/login', {
            app_version: '610063322',
            areaCode: '86',
            device: 'ANDROID',
            os: 'Android',
            os_language: 'zh-hans-cn',
            os_version: '13',
            password: parsed.password,
            timestamp: rawHeaders.find(([k]) => k === 'Timestamp')?.[1],
            username: parsed.username,
          });
          assert.equal(rawHeaders.find(([k]) => k === 'Sign')?.[1], expectedSign);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              resultCode: '00000',
              resultDesc: 'success',
              data: {
                uuid: '1900000000000000001',
                access_token: 'tok-v1',
                refresh_token: 'ref-v1',
                accessTokenValidity: Math.floor((nowMs + 3600_000) / 1000),
                region: 'bj',
              },
            }),
          );
          return;
        }
        if (path === '/v3/user/refresh') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              resultCode: '90000',
              resultDesc: 'success',
              data: {
                access_token: 'tok-v2',
                refresh_token: 'ref-v2',
                accessTokenValidity: String(nowMs + 7200_000),
              },
            }),
          );
          return;
        }
      }

      if (hostTag === 'travel' && path.startsWith('/ai-skill/api/device/info/')) {
        recordedCalls.push({ hostTag, path, rawHeaders });
        const authHdr = rawHeaders.find(([k]) => k === 'Authorization')?.[1];
        assert.equal(authHdr, 'Bearer official-demo-key');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (path.endsWith('/get-device-list')) {
          res.end(JSON.stringify({ code: 0, data: [{ sn: 'OFFICIAL-M95C', deviceName: '官方M95C' }] }));
          return;
        }
        res.end(
          JSON.stringify({
            code: 0,
            data: {
              dumpEnergy: 76,
              powerStatus: 'OFF',
              chargingState: 0,
              estimateMileage: 64.5,
              locationInfo: { locationDesc: '官方地址描述' },
            },
          }),
        );
        return;
      }

      // Encrypted business endpoints
      const wire = decryptIncomingWire(rawBody);
      recordedCalls.push({ hostTag, path, rawHeaders, innerParams: wire.innerParams });

      const respondBiz = (payload: Record<string, unknown>) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(encryptOutgoingWire(payload, wire));
      };

      if (forceTokenExpiredNextBizCall && path !== '/user/user/login') {
        forceTokenExpiredNextBizCall = false;
        respondBiz({ code: 401905, message: 'token expired' });
        return;
      }

      if (path === '/user/user/login') {
        respondBiz({ code: 0, data: { uid: '987654321' } });
        return;
      }

      if (path === '/vehicle/binding/my-vehicle') {
        if (hostTag === 'motor') {
          respondBiz({
            code: 1,
            desc: '成功',
            data: [
              {
                wnumber: 'M95C-SN-001',
                ble_name: '我的九号M95C',
                vehicle_name_zh: '九号 M95C 电摩',
                vehicle_type: 118,
                is_common_user: 1,
                smart_service_surplus_days: 120,
              },
            ],
          });
          return;
        }
        respondBiz({ code: 1, desc: '成功', data: [] });
        return;
      }

      if (hostTag === 'motor' && motorFailsForFallback) {
        respondBiz({ code: 500, message: 'motor gateway temporary miss' });
        return;
      }

      if (path === '/vehicle/vehicle/desktop-component') {
        respondBiz({
          code: 1,
          desc: '成功',
          data: {
            sn: wire.innerParams.sn_str,
            ble_name: '我的九号M95C',
            dump_energy: '80',
            charging: 1,
            estimate_mileage: 89.6,
            precise_estimate_mileage: 99.6,
            ai_estimate_mileage: 0,
            pwr: 0,
            barrel_lock_status: 0,
            is_common_user: 1,
            is_smart_service_expired: 0,
            remain_charge_time: '1小时20分',
            loc: { lat: '39.9087', lon: '116.3975', lock: 1 },
          },
        });
        return;
      }

      if (path === '/vehicle/vehicle/vehicle-info') {
        respondBiz({
          code: 1,
          desc: '成功',
          data: {
            wnumber: wire.innerParams.wnumber,
            total_mileage: 1234.5,
            vehicle_name_zh: '九号 M95C 电摩',
          },
        });
        return;
      }

      if (path === '/v6/vehicle/battery-info') {
        respondBiz({
          code: 1,
          desc: '成功',
          data: {
            battery_type: '2',
            charging: 1,
            charging_power: 310,
            electricity: 80,
            have_bms_cycle_support: false,
            remain_charge_time: '1小时20分',
            battery_main: { electricity: '93' },
            battery_list: [
              { bat_temp: '26', bms_cycle: '100', bms_volt: '75.3', electricity: '80', score: 98 },
            ],
          },
        });
        return;
      }

      if (path === '/vehicle/vehicle/vehicle-status') {
        respondBiz({
          code: 1,
          desc: '成功',
          data: { gsm_signal: 4, gnss_signal: 12 },
        });
        return;
      }

      if (path === '/app-api/travel/v6/travel-list2') {
        const bizHdr = rawHeaders.find(([k]) => k.toLowerCase() === 'business-type')?.[1];
        if (bizHdr !== '1') {
          respondBiz({ code: 1, desc: '成功', data: { times: 0, duration: 0, total_mileages: '0.0', list: [] } });
          return;
        }
        assert.equal(wire.innerParams.month, '202611');
        const page = String(wire.innerParams.page || '1');
        const list =
          page === '2'
            ? [
                {
                  travel_id: 'ride-3',
                  start_time: Math.floor(nowMs / 1000) - 8200,
                  end_time: Math.floor(nowMs / 1000) - 8000,
                  end_time_format: '2026-11-20 18:00:00',
                  duration: 200,
                  mileages: '2.00',
                  speed: '39.00',
                  used_electricity: '3.0',
                },
              ]
            : [
                {
                  travel_id: 'ride-1',
                  start_time: Math.floor(nowMs / 1000) - 2000,
                  end_time: Math.floor(nowMs / 1000) - 760,
                  end_time_format: '2026-11-21 01:00:00',
                  duration: 1240,
                  mileages: '12.40',
                  speed: '68.00',
                  used_electricity: '14.0',
                },
                {
                  travel_id: 'ride-2',
                  start_time: Math.floor(nowMs / 1000) - 4360,
                  end_time: Math.floor(nowMs / 1000) - 4000,
                  end_time_format: '2026-11-21 00:00:00',
                  duration: 360,
                  mileages: '3.60',
                  speed: '42.00',
                  used_electricity: '5.0',
                },
              ];
        respondBiz({
          code: 1,
          desc: '成功',
          data: {
            times: 3,
            total_mileages: '18.0',
            duration: 1800,
            ec: 320,
            list,
          },
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    return new Promise<{ server: http.Server; baseUrl: string }>(resolve => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
      });
    });
  }

  const passportSrv = await startGatewayServer('passport');
  const bizSrv = await startGatewayServer('biz');
  const motorSrv = await startGatewayServer('motor');
  const ebikeSrv = await startGatewayServer('ebike');
  const travelSrv = await startGatewayServer('travel');
  const amapSrv = await startGatewayServer('amap');

  const dataDir = mkdtempSync(join(tmpdir(), 'ninebot-wire-test-'));
  const hosts = {
    passport: passportSrv.baseUrl,
    biz: bizSrv.baseUrl,
    motor: motorSrv.baseUrl,
    ebike: ebikeSrv.baseUrl,
    travel: travelSrv.baseUrl,
    amap: `${amapSrv.baseUrl}/regeo`,
  };

  try {
    const deps = { dataDir, nowFn: () => nowMs, hosts, rsaPublicKeyPem: pubPem };

    // 1) Config AMap key
    await plugin.runAction('config', { amapKey: 'test-amap-key' }, deps);

    // 2) Login
    const loginRes = await plugin.runAction(
      'login',
      { username: '13800138000', password: 'secret-pass-1' },
      deps,
    );
    assert.equal(loginRes.ok, true);
    assert.match(String(loginRes.message), /M95C-SN-001/);

    // Verify exact header casing on Passport
    const passportLoginCall = recordedCalls.find(x => x.hostTag === 'passport' && x.path === '/v6/user/login');
    assert.ok(passportLoginCall);
    const pHeaderNames = passportLoginCall.rawHeaders.map(([k]) => k);
    assert.ok(pHeaderNames.includes('App_version'));
    assert.ok(pHeaderNames.includes('Os_language'));
    assert.ok(pHeaderNames.includes('Os_version'));

    // Verify motor gateway was queried BEFORE ebike gateway during vehicle discovery
    const vehicleCalls = recordedCalls.filter(x => x.path === '/vehicle/binding/my-vehicle').map(x => x.hostTag);
    assert.deepEqual(vehicleCalls, ['motor', 'ebike']);

    // 3) Live M-series status
    const statusRes = await plugin.runAction('status', {}, deps);
    assert.equal(statusRes.ok, true);
    const snap = (statusRes.data as Record<string, any>).snapshot;
    assert.equal(snap.sn, 'M95C-SN-001');
    assert.equal(snap.businessLine, 'motor');
    assert.equal(snap.battery, 80);
    assert.equal(snap.auxBattery, 93);
    assert.equal(snap.voltageV, 75.3);
    assert.equal(snap.temperatureC, 26);
    assert.equal(snap.cycles, null, 'placeholder bms_cycle must be dropped when have_bms_cycle_support is false');
    assert.equal(snap.charging, true);
    assert.equal(snap.chargingPowerW, 310);
    assert.equal(snap.effectiveRangeKm, 99.6);
    assert.equal(snap.odometerKm, 1234.5);
    assert.equal(snap.locked, true);
    assert.equal(snap.location.address, '北京市东城区东长安街1号');
    assert.equal(amapCallCount, 1);

    // Verify exact header casing on business wire calls
    const desktopCall = recordedCalls.find(x => x.path === '/vehicle/vehicle/desktop-component');
    assert.ok(desktopCall);
    const bHeaderNames = desktopCall.rawHeaders.map(([k]) => k);
    assert.ok(bHeaderNames.includes('Need_decrypt'));
    assert.ok(bHeaderNames.includes('Uid'));
    assert.equal(desktopCall.rawHeaders.find(([k]) => k === 'Uid')?.[1], '987654321');
    assert.equal(desktopCall.rawHeaders.find(([k]) => k === 'Business-Type')?.[1], '2');

    // 4) Second status call hits SQLite geo_cache (AMap not called again)
    await plugin.runAction('status', {}, deps);
    assert.equal(amapCallCount, 1, 'AMap geocoder must use 24h SQLite geo_cache');

    // 5) Expired token auto-refresh & M-series -> ebike fallback
    forceTokenExpiredNextBizCall = true;
    motorFailsForFallback = true;
    const refreshedStatus = await plugin.runAction('status', {}, deps);
    assert.equal(refreshedStatus.ok, true);
    assert.ok(recordedCalls.some(x => x.hostTag === 'passport' && x.path === '/v3/user/refresh'));
    assert.equal((refreshedStatus.data as Record<string, any>).snapshot.businessLine, 'ebike');
    motorFailsForFallback = false;

    // 6) Trips query + YYYY-MM normalization + multi-page aggregation + avg speed calculation
    const tripsRes = await plugin.runAction('trips', { month: '2026-11' }, deps);
    assert.equal(tripsRes.ok, true);
    const tData = tripsRes.data as Record<string, any>;
    assert.equal(tData.month, '202611');
    assert.equal(tData.tripCount, 3);
    assert.equal(tData.maxSpeedKmh, 68);
    assert.equal(tData.totalDistanceKm, 18);
    assert.equal(tData.overallAvgSpeedKmh, 36);

    const travelCalls = recordedCalls.filter(x => x.path === '/app-api/travel/v6/travel-list2');
    assert.equal(travelCalls.length, 2);
    const travelCall = travelCalls[0]!;
    const tHeaders = travelCall.rawHeaders.map(([k]) => k);
    assert.ok(tHeaders.includes('Access_token'));
    assert.ok(tHeaders.includes('Rn-Module'));
    assert.ok(tHeaders.includes('Rn-Ver'));
    assert.equal(travelCall.rawHeaders.find(([k]) => k === 'Business-Type')?.[1], '1');

    // 7) Official DeviceService backend via NINEBOT_DEVICESERVICE_KEY
    const officialRes = await plugin.runAction(
      'status',
      { backend: 'official', sn: 'OFFICIAL-M95C' },
      { ...deps, env: { NINEBOT_DEVICESERVICE_KEY: 'official-demo-key' } },
    );
    assert.equal(officialRes.ok, true);
    const offSnap = (officialRes.data as Record<string, any>).snapshot;
    assert.equal(offSnap.backend, 'official');
    assert.equal(offSnap.battery, 76);
    assert.equal(offSnap.location.address, '官方地址描述');
  } finally {
    await Promise.all([
      new Promise(r => passportSrv.server.close(r)),
      new Promise(r => bizSrv.server.close(r)),
      new Promise(r => motorSrv.server.close(r)),
      new Promise(r => ebikeSrv.server.close(r)),
      new Promise(r => travelSrv.server.close(r)),
      new Promise(r => amapSrv.server.close(r)),
    ]);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('proactive patrol handles low battery cooldown, 10% drop re-alert, charge-complete one-shot, unlocked & idle warnings', async () => {
  const c = await loadCryptoModule();
  const plugin = await loadPluginModule();
  const dataDir = mkdtempSync(join(tmpdir(), 'ninebot-patrol-test-'));

  let nowMs = 1_790_000_000_000;
  let state = {
    battery: 82,
    charging: 0,
    pwr: 1,
    acc: 0,
    lock: 1,
    rangeKm: 75.0,
    trips: [] as Array<Record<string, unknown>>,
  };

  const mockRequester = async (req: { url: string; body?: string }) => {
    const u = new URL(req.url);
    if (u.pathname === '/v6/user/login') {
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            code: 0,
            data: {
              uuid: 'u-1',
              access_token: 'tok-patrol',
              refresh_token: 'ref-patrol',
              accessTokenValidity: String(nowMs + 86400_000 * 30),
            },
          }),
        ),
      };
    }

    const body = JSON.parse(req.body || '{}') as { d: string; k: string };
    // We don't need RSA private key in mockRequester when decrypting via injected key? No — we don't know aesKey unless we pass custom pubkey OR wait:
    // Generate RSA pair isn't even needed if mockRequester uses privateKey generated in this test!
    void body;
    return { status: 500, headers: {}, body: Buffer.from('{}') };
  };

  const { publicKey: pubPem, privateKey: privPem } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const requester = async (req: { url: string; body?: string }) => {
    const u = new URL(req.url);
    if (u.pathname === '/v6/user/login') {
      return mockRequester(req);
    }
    const body = JSON.parse(req.body || '{}') as { d: string; k: string };
    const aesKey = privateDecrypt({ key: privPem, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(body.k, 'base64'));
    const wrapper = JSON.parse(c.aesCbcDecrypt(aesKey, Buffer.from(body.d, 'base64')).toString('utf8')) as Record<string, string>;
    const respKey = c.deriveKey(wrapper.keyDataOne!, wrapper.keyDataTwo!, wrapper.keyDataThree!, wrapper.keyDataFour!);

    let payload: Record<string, unknown> = { code: 1, data: {} };
    if (u.pathname === '/user/user/login') {
      payload = { code: 0, data: { uid: '555666777' } };
    } else if (u.pathname === '/vehicle/binding/my-vehicle') {
      payload = u.hostname.includes('steeldust')
        ? { code: 1, data: [{ wnumber: 'M95C-PATROL', ble_name: '巡检电摩', is_common_user: 1 }] }
        : { code: 1, data: [] };
    } else if (u.pathname === '/vehicle/vehicle/desktop-component') {
      payload = {
        code: 1,
        data: {
          sn: 'M95C-PATROL',
          ble_name: '巡检电摩',
          dump_energy: String(state.battery),
          charging: state.charging,
          estimate_mileage: state.rangeKm,
          precise_estimate_mileage: state.rangeKm,
          pwr: state.pwr,
          battery_exist: 1,
          loc: { lat: '0', lon: '0', acc: state.acc, lock: state.lock },
        },
      };
    } else if (u.pathname === '/vehicle/vehicle/vehicle-info') {
      payload = { code: 1, data: { wnumber: 'M95C-PATROL', total_mileage: 500 } };
    } else if (u.pathname === '/v6/vehicle/battery-info') {
      payload = {
        code: 1,
        data: {
          electricity: state.battery,
          charging: state.charging,
          battery_list: [{ bms_volt: '72.1', bat_temp: '24', electricity: String(state.battery) }],
        },
      };
    } else if (u.pathname === '/vehicle/vehicle/vehicle-status') {
      payload = { code: 1, data: { power_status: state.acc, gsm_signal: 4 } };
    } else if (u.pathname === '/app-api/travel/v6/travel-list2') {
      payload = { code: 1, data: { duration: 600, ec: 100, list: state.trips } };
    }

    const respWrapper = JSON.stringify({ data: c.androidB64(JSON.stringify(payload)), platform: 2, timeStamp: Math.floor(nowMs / 1000) });
    return {
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({ r: c.aesCbcEncrypt(respKey, Buffer.from(respWrapper, 'utf8')).toString('base64') })),
    };
  };

  const deps = { dataDir, nowFn: () => nowMs, httpRequester: requester, rsaPublicKeyPem: pubPem };

  try {
    await plugin.runAction('login', { username: '13800138001', password: 'pw' }, deps);

    // 1) Healthy state (M-series battery online pwr: 1 while acc: 0, lock: 1) -> silent, locked, powered off
    const healthy = await plugin.runAction('patrol', {}, deps);
    assert.equal(healthy.ok, true);
    assert.equal(healthy.notify, false);
    const hData = healthy.data as Record<string, any>;
    assert.equal(hData.triggered, false);
    assert.equal(hData.snapshot.locked, true);
    assert.equal(hData.snapshot.powerOn, false);
    assert.equal(hData.snapshot.batteryPresent, true);

    // 2) Low battery (24%) + low range (12km) -> notify: true
    state.battery = 24;
    state.rangeKm = 12;
    const low1 = await plugin.runAction('patrol', {}, deps);
    assert.equal(low1.ok, true);
    assert.equal(low1.notify, true);
    assert.match(String(low1.message), /电量偏低 \(24%\)/);

    // 3) 1h later at 22% -> suppressed by cooldown (notify: false)
    nowMs += 3600_000;
    state.battery = 22;
    state.rangeKm = 11;
    const low2 = await plugin.runAction('patrol', {}, deps);
    assert.equal(low2.notify, false);

    // 4) 1h later drops to 12% (>= 10% drop from 24%) -> re-notifies immediately!
    nowMs += 3600_000;
    state.battery = 12;
    state.rangeKm = 6;
    const low3 = await plugin.runAction('charge-check', {}, deps);
    assert.equal(low3.notify, true);
    assert.match(String(low3.message), /12%/);

    // 5) force: true bypasses cooldown
    const forced = await plugin.runAction('patrol', { force: true }, deps);
    assert.equal(forced.notify, true);

    // 6) Charge completion transition: charging 88% (silent) -> unplugged 100% (one-shot notify) -> repeat (silent)
    nowMs += 3600_000;
    state.charging = 1;
    state.battery = 88;
    state.rangeKm = 80;
    const chargingRes = await plugin.runAction('patrol', {}, deps);
    assert.equal(chargingRes.notify, false);

    nowMs += 3600_000;
    state.charging = 0;
    state.battery = 100;
    state.rangeKm = 95;
    const fullRes = await plugin.runAction('patrol', {}, deps);
    assert.equal(fullRes.notify, true);
    assert.match(String(fullRes.message), /充电已完成/);

    nowMs += 3600_000;
    const fullRepeat = await plugin.runAction('patrol', {}, deps);
    assert.equal(fullRepeat.notify, false);

    // 7) Unlocked / powered-on parked warning
    nowMs += 3600_000;
    state.battery = 80;
    state.acc = 1;
    state.lock = 0;
    const unlockedRes = await plugin.runAction('patrol', {}, deps);
    assert.equal(unlockedRes.notify, true);
    assert.match(String(unlockedRes.message), /未关电门/);

    // Lock again -> resets active flag
    nowMs += 3600_000;
    state.acc = 0;
    state.lock = 1;
    assert.equal((await plugin.runAction('patrol', {}, deps)).notify, false);

    // 8) Idle discharge warning (last trip 10 days ago, battery 42%)
    state.trips = [
      {
        travel_id: 'old-ride',
        start_time: Math.floor((nowMs - 10 * 86400_000) / 1000) - 600,
        end_time: Math.floor((nowMs - 10 * 86400_000) / 1000),
        duration: 600,
        mileages: '5.0',
        speed: '40',
      },
    ];
    await plugin.runAction('trips', {}, deps);
    nowMs += 13 * 3600_000; // past cooldown
    state.battery = 42;
    state.rangeKm = 35;
    const idleRes = await plugin.runAction('patrol', {}, deps);
    assert.equal(idleRes.notify, true);
    assert.match(String(idleRes.message), /久置低电提醒/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('security hardening, host discovery, redaction, and voice fastpath safety guardrails', async () => {
  const c = await loadCryptoModule();
  const plugin = await loadPluginModule();
  const home = mkdtempSync(join(tmpdir(), 'ninebot-host-home-'));
  const rogueDir = mkdtempSync(join(tmpdir(), 'ninebot-rogue-dir-'));

  const { publicKey: pubPem, privateKey: privPem } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const nowMs = 1_790_000_000_000;
  const requester = async (req: { url: string; body?: string }) => {
    const u = new URL(req.url);
    if (u.pathname === '/v6/user/login') {
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            code: 0,
            data: {
              uuid: 'u-sec',
              access_token: 'SECRET-ACCESS-TOKEN-XYZ',
              refresh_token: 'SECRET-REFRESH-TOKEN-XYZ',
              accessTokenValidity: String(nowMs + 86400_000),
            },
          }),
        ),
      };
    }
    const body = JSON.parse(req.body || '{}') as { d: string; k: string };
    const aesKey = privateDecrypt({ key: privPem, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(body.k, 'base64'));
    const wrapper = JSON.parse(c.aesCbcDecrypt(aesKey, Buffer.from(body.d, 'base64')).toString('utf8')) as Record<string, string>;
    const respKey = c.deriveKey(wrapper.keyDataOne!, wrapper.keyDataTwo!, wrapper.keyDataThree!, wrapper.keyDataFour!);
    let payload: Record<string, unknown> = { code: 1, data: {} };
    if (u.pathname === '/user/user/login') payload = { code: 0, data: { uid: '112233445' } };
    else if (u.pathname === '/vehicle/binding/my-vehicle') {
      payload = u.hostname.includes('steeldust')
        ? { code: 1, data: [{ wnumber: 'M95C-SEC', ble_name: '保密电摩', is_common_user: 1 }] }
        : { code: 1, data: [] };
    } else if (u.pathname === '/vehicle/vehicle/desktop-component') {
      payload = {
        code: 1,
        data: {
          sn: 'M95C-SEC',
          ble_name: '保密电摩',
          dump_energy: '80',
          charging: 0,
          estimate_mileage: 70,
          pwr: 0,
          loc: { lat: '39.9087', lon: '116.3975', lock: 1, desc: '地下车库B2' },
        },
      };
    } else if (u.pathname === '/vehicle/vehicle/vehicle-info') {
      payload = { code: 1, data: { total_mileage: 888 } };
    } else if (u.pathname === '/v6/vehicle/battery-info') {
      payload = { code: 1, data: { electricity: 80, battery_list: [{ bms_volt: '75.0', electricity: '80' }] } };
    } else if (u.pathname === '/vehicle/vehicle/vehicle-status') {
      payload = { code: 1, data: { gsm_signal: 4 } };
    } else if (u.pathname === '/app-api/travel/v6/travel-list2') {
      payload = {
        code: 1,
        data: {
          duration: 900,
          ec: 200,
          list: [
            {
              travel_id: 'sec-ride-1',
              start_time: Math.floor(nowMs / 1000) - 1000,
              end_time: Math.floor(nowMs / 1000) - 100,
              duration: 900,
              mileages: '12.40',
              speed: '55.00',
            },
          ],
        },
      };
    }
    const respWrapper = JSON.stringify({ data: c.androidB64(JSON.stringify(payload)), platform: 2, timeStamp: Math.floor(nowMs / 1000) });
    return {
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({ r: c.aesCbcEncrypt(respKey, Buffer.from(respWrapper, 'utf8')).toString('base64') })),
    };
  };

  const safeDataDir = join(home, 'plugins', 'ninebot');
  const deps = { dataDir: safeDataDir, nowFn: () => nowMs, httpRequester: requester, rsaPublicKeyPem: pubPem };

  try {
    // 1) Host plugin discovery
    const discovered = listPluginsSync(home);
    const meta = discovered.find(p => p.name === 'ninebot');
    assert.ok(meta, 'ninebot plugin must be discovered by host');
    assert.equal(meta.runtime, 'in-process');
    assert.equal(meta.voiceFastpath, true);
    assert.equal(meta.enabled, true);
    assert.deepEqual(meta.actions, ['status', 'patrol', 'charge-check', 'trips', 'vehicles', 'login', 'config', 'dashboard']);

    // 2) Path isolation + secret redaction across actions
    const cfgRes = await plugin.runAction(
      'config',
      {
        dataDir: rogueDir,
        pluginDataDir: rogueDir,
        homeDir: rogueDir,
        amapKey: 'SECRET-AMAP-KEY-999',
        deviceServiceKey: 'SECRET-DS-KEY-999',
      },
      deps,
    );
    assert.equal(cfgRes.ok, true);
    assert.equal(existsSync(join(safeDataDir, 'ninebot.sqlite')), true);
    assert.equal(existsSync(join(rogueDir, 'ninebot.sqlite')), false);
    assert.equal(existsSync(join(rogueDir, 'config.json')), false);

    const loginRes = await plugin.runAction(
      'login',
      { username: '13800138999', password: 'SUPER-SECRET-PASSWORD-999' },
      deps,
    );
    assert.equal(loginRes.ok, true);

    const statusRes = await plugin.runAction('status', {}, deps);
    const tripsRes = await plugin.runAction('trips', {}, deps);
    const dashRes = await plugin.runAction('dashboard', {}, deps);

    // Check file permissions (0o700 dir, 0o600 config & session)
    assert.equal(statSync(safeDataDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(safeDataDir, 'config.json')).mode & 0o777, 0o600);
    assert.equal(statSync(join(safeDataDir, 'session.json')).mode & 0o777, 0o600);

    // Ensure zero secrets and zero host paths appear anywhere in serialized outputs
    const forbiddenStrings = [
      safeDataDir,
      home,
      'configPath',
      'sessionPath',
      'SUPER-SECRET-PASSWORD-999',
      'SECRET-ACCESS-TOKEN-XYZ',
      'SECRET-REFRESH-TOKEN-XYZ',
      'SECRET-AMAP-KEY-999',
      'SECRET-DS-KEY-999',
    ];
    for (const res of [cfgRes, loginRes, statusRes, tripsRes, dashRes]) {
      const serialized = JSON.stringify(res);
      for (const secret of forbiddenStrings) {
        assert.equal(serialized.includes(secret), false, `Output leaked forbidden string: ${secret}`);
      }
    }

    // 3) Voice fastpath guardrails (directly on host tryPluginVoiceFastpath + plugin handler)
    const unrelated = await tryPluginVoiceFastpath(home, {
      text: '今天天气怎么样',
      channelId: 'xiaoai:test',
      platform: 'xiaoai',
    });
    assert.equal(unrelated, undefined);

    const scheduled = await tryPluginVoiceFastpath(home, {
      text: '每天晚上九点提醒我检查九号电动车电量',
      channelId: 'xiaoai:test',
      platform: 'xiaoai',
    });
    assert.equal(scheduled, undefined, 'Timer intent must fall through to Router');

    const controlBlocked = await tryPluginVoiceFastpath(home, {
      text: '小爱同学帮我把九号电摩解锁',
      channelId: 'xiaoai:test',
      platform: 'xiaoai',
    });
    assert.ok(controlBlocked?.handled);
    assert.equal(controlBlocked.ok, false);
    assert.match(String(controlBlocked.speech), /只读守护模式/);

    // Note: voice fastpath via host tryPluginVoiceFastpath calls plugin without deps.httpRequester,
    // so test live query voice fastpath directly with context carrying deps.
    const lockQuery = await plugin.handleVoiceFastpath(
      { text: '星期五，九号电摩锁好没', channelId: 'xiaoai:test', platform: 'xiaoai' },
      deps,
    );
    assert.equal(lockQuery.handled, true);
    assert.equal(lockQuery.ok, true);
    assert.equal(lockQuery.action, 'status');
    assert.match(String(lockQuery.speech), /已经上锁/);

    const batteryQuery = await plugin.handleVoiceFastpath(
      { text: '九号电摩还有多少电', channelId: 'xiaoai:test', platform: 'xiaoai' },
      deps,
    );
    assert.equal(batteryQuery.handled, true);
    assert.equal(batteryQuery.ok, true);
    assert.equal(batteryQuery.action, 'status');
    assert.match(String(batteryQuery.speech), /百分之 80/);

    const tripsQuery = await plugin.handleVoiceFastpath(
      { text: '九号电摩这个月骑了多少公里', channelId: 'xiaoai:test', platform: 'xiaoai' },
      deps,
    );
    assert.equal(tripsQuery.handled, true);
    assert.equal(tripsQuery.ok, true);
    assert.equal(tripsQuery.action, 'trips');
    assert.match(String(tripsQuery.speech), /12\.4 公里/);

    // Also verify host runPlugin succeeds on offline dashboard
    const hostDash = await runPlugin(home, 'ninebot', 'dashboard', {});
    assert.equal(hostDash.ok, true);
    assert.equal((hostDash.data as Record<string, any>).snapshot.sn, 'M95C-SEC');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(rogueDir, { recursive: true, force: true });
  }
});

test('passport resultCode envelope, missing accessTokenValidity, and redacted error.log work cleanly', async () => {
  const c = await loadCryptoModule();
  const plugin = await loadPluginModule();
  const home = mkdtempSync(join(tmpdir(), 'ninebot-passport-home-'));
  const dataDir = join(home, 'plugins', 'ninebot');

  const { publicKey: pubPem, privateKey: privPem } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const nowMs = 1_790_000_000_000;
  let passportLoginCalls = 0;
  let forceBadCreds = false;
  let forcePathLeakError = false;

  const requester = async (req: { url: string; body?: string }) => {
    const u = new URL(req.url);
    if (u.pathname === '/v6/user/login') {
      passportLoginCalls += 1;
      if (forceBadCreds) {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(
            JSON.stringify({
              resultCode: '90014',
              resultDesc: 'username or password incorrect',
              data: null,
            }),
          ),
        };
      }
      // Simulate real Ninebot Passport response: resultCode "00000" (no `code`, no `accessTokenValidity`)
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            resultCode: '00000',
            resultDesc: 'success',
            data: {
              uuid: '1900000000000000099',
              access_token: 'tok-live-no-expiry',
              refresh_token: 'ref-live-no-expiry',
              region: 'bj',
            },
          }),
        ),
      };
    }

    if (forcePathLeakError) {
      throw new Error(
        `socket failed for ${dataDir} user=13800138999 Bearer tok-live-no-expiry password=SUPER-SECRET-PASSWORD-999`,
      );
    }

    const body = JSON.parse(req.body || '{}') as { d: string; k: string };
    const aesKey = privateDecrypt({ key: privPem, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(body.k, 'base64'));
    const wrapper = JSON.parse(c.aesCbcDecrypt(aesKey, Buffer.from(body.d, 'base64')).toString('utf8')) as Record<string, string>;
    const respKey = c.deriveKey(wrapper.keyDataOne!, wrapper.keyDataTwo!, wrapper.keyDataThree!, wrapper.keyDataFour!);

    let payload: Record<string, unknown> = { code: 1, data: {} };
    if (u.pathname === '/user/user/login') payload = { code: 0, data: { uid: '88776655' } };
    else if (u.pathname === '/vehicle/binding/my-vehicle') {
      payload = u.hostname.includes('steeldust')
        ? { code: 1, data: [{ wnumber: 'M95C-LIVE', ble_name: '九号M95C', is_common_user: 1 }] }
        : { code: 1, data: [] };
    } else if (u.pathname === '/vehicle/vehicle/desktop-component') {
      payload = {
        code: 1,
        data: { sn: 'M95C-LIVE', ble_name: '九号M95C', dump_energy: '86', charging: 0, estimate_mileage: 72, pwr: 0, loc: { lock: 1 } },
      };
    } else if (u.pathname === '/vehicle/vehicle/vehicle-info') {
      payload = { code: 1, data: { total_mileage: 512 } };
    } else if (u.pathname === '/v6/vehicle/battery-info') {
      payload = { code: 1, data: { electricity: 86, battery_list: [{ bms_volt: '75.8', electricity: '86' }] } };
    }

    const respWrapper = JSON.stringify({ data: c.androidB64(JSON.stringify(payload)), platform: 2, timeStamp: Math.floor(nowMs / 1000) });
    return {
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({ r: c.aesCbcEncrypt(respKey, Buffer.from(respWrapper, 'utf8')).toString('base64') })),
    };
  };

  const deps = { homeDir: home, dataDir, nowFn: () => nowMs, httpRequester: requester, rsaPublicKeyPem: pubPem };

  try {
    // 1) resultCode: "00000" login without `code` or `accessTokenValidity` succeeds
    const loginRes = await plugin.runAction(
      'login',
      { username: '13800138999', password: 'SUPER-SECRET-PASSWORD-999' },
      deps,
    );
    assert.equal(loginRes.ok, true);
    assert.equal(passportLoginCalls, 1);

    const dash = await plugin.runAction('dashboard', {}, deps);
    assert.equal(dash.ok, true);
    assert.equal((dash.data as Record<string, any>).config.sessionValid, true);

    // 2) Subsequent `status` reuses cached session instead of repeating password login
    const statusRes = await plugin.runAction('status', {}, deps);
    assert.equal(statusRes.ok, true);
    assert.equal((statusRes.data as Record<string, any>).snapshot.battery, 86);
    assert.equal(passportLoginCalls, 1);

    // 3) 90014 login failure surfaces helpful password hint & writes 0600 error.log
    forceBadCreds = true;
    const failLogin = await plugin.runAction(
      'login',
      { username: '13800138999', password: 'SUPER-SECRET-PASSWORD-999' },
      deps,
    );
    assert.equal(failLogin.ok, false);
    assert.match(String(failLogin.message), /账号或登录密码错误/);
    forceBadCreds = false;

    // 4) Error message redaction in error.log (no paths, phones, tokens, passwords)
    forcePathLeakError = true;
    const leakedErrStatus = await plugin.runAction('status', {}, deps);
    assert.equal(leakedErrStatus.ok, false);

    const logPath = join(dataDir, 'error.log');
    assert.equal(existsSync(logPath), true);
    assert.equal(statSync(logPath).mode & 0o777, 0o600);
    const logText = readFileSync(logPath, 'utf8');
    assert.match(logText, /action=login .*code=90014/);
    assert.match(logText, /138\*\*\*\*8999/);
    assert.match(logText, /<redacted-path>/);
    assert.equal(logText.includes('13800138999'), false);
    assert.equal(logText.includes('SUPER-SECRET-PASSWORD-999'), false);
    assert.equal(logText.includes('tok-live-no-expiry'), false);
    assert.equal(logText.includes(dataDir), false);
    assert.equal(logText.includes(home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('M95C lock/power_status semantics, indexed desktop unwrap, sanitizeNinebotImageUrl & 0600 PNG caching', async () => {
  const c = await loadCryptoModule();
  const plugin = await loadPluginModule();
  const clientMod = await import('../plugins/ninebot/client.mjs') as { sanitizeNinebotImageUrl(u: unknown): string | null };

  assert.equal(
    clientMod.sanitizeNinebotImageUrl('https://oms-oss-public.ninebot.com/device-config/M95C_green_2_dark.png?nbchecksignv1=abc=='),
    'https://oms-oss-public.ninebot.com/device-config/M95C_green_2_dark.png?nbchecksignv1=abc==',
  );
  assert.equal(clientMod.sanitizeNinebotImageUrl('http://oms-oss-public.ninebot.com/a.png'), null);
  assert.equal(clientMod.sanitizeNinebotImageUrl('https://evil.example/M95C.png'), null);
  assert.equal(clientMod.sanitizeNinebotImageUrl('https://oms-oss-public.ninebot.com/../secret.png'), null);
  assert.equal(clientMod.sanitizeNinebotImageUrl('https://oms-oss-public.ninebot.com/M95C.jpg'), null);

  const home = mkdtempSync(join(tmpdir(), 'ninebot-img-test-'));
  const dataDir = join(home, 'plugins', 'ninebot');
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const nowMs = 1_795_241_800_000;

  const fakePng = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(96, 0x42),
  ]);
  const darkUrl = 'https://oms-oss-public.ninebot.com/device-config/M95C_green_2_dark.png?nbchecksignv1=ZGFyaw==';
  const lightUrl = 'https://oms-oss-public.ninebot.com/device-config/M95C_green_2_light.png?nbchecksignv1=bGlnaHQ=';

  const requester = async (req: { method?: string; url: string; body?: string }) => {
    const u = new URL(req.url);
    if (req.method === 'GET' && u.hostname === 'oms-oss-public.ninebot.com') {
      return { status: 200, headers: { 'content-type': 'image/png' }, body: fakePng };
    }
    if (u.pathname === '/v6/user/login') {
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            resultCode: '00000',
            data: {
              uuid: 'u-m95c',
              access_token: 'tok-m95c',
              refresh_token: 'ref-m95c',
              accessTokenValidity: String(nowMs + 86400_000),
            },
          }),
        ),
      };
    }
    const body = JSON.parse(req.body || '{}') as { d: string; k: string };
    const aesKey = privateDecrypt({ key: privPem, padding: cryptoConstants.RSA_PKCS1_PADDING }, Buffer.from(body.k, 'base64'));
    const wrapper = JSON.parse(c.aesCbcDecrypt(aesKey, Buffer.from(body.d, 'base64')).toString('utf8')) as Record<string, string>;
    const respKey = c.deriveKey(wrapper.keyDataOne!, wrapper.keyDataTwo!, wrapper.keyDataThree!, wrapper.keyDataFour!);

    let payload: Record<string, unknown> = { code: 1, data: {} };
    if (u.pathname === '/user/user/login') payload = { code: 0, data: { uid: '88776655' } };
    else if (u.pathname === '/vehicle/binding/my-vehicle') {
      payload = u.hostname.includes('steeldust')
        ? {
            code: 1,
            data: [{
              wnumber: 'M95C-LOCK-01',
              ble_name: '小9',
              vehicle_name_zh: '九号电动M95C',
              color: '英伦绿',
              v6_dark_img_url: darkUrl,
              v6_light_img_url: lightUrl,
              is_common_user: 1,
            }],
          }
        : { code: 1, data: [] };
    } else if (u.pathname === '/vehicle/vehicle/desktop-component') {
      // Simulate indexed object `{"0": {...}}` returned with pwr=1 & acc=0 & lock=1
      payload = {
        code: 1,
        data: {
          '0': {
            sn: 'M95C-LOCK-01',
            ble_name: '小9',
            dump_energy: '12',
            battery_exist: 1,
            pwr: 1,
            charging: 0,
            precise_estimate_mileage: 11.5,
            estimate_mileage: 16.4,
            v6_dark_img_url: darkUrl,
            v6_light_img_url: lightUrl,
            loc: { lat: '34.181928', lon: '108.823510', acc: 0, lock: 1 },
          },
        },
      };
    } else if (u.pathname === '/vehicle/vehicle/vehicle-info') {
      payload = { code: 1, data: { total_mileage: 16529.8, pwr: '1', gnss_time: Math.floor(nowMs / 1000) } };
    } else if (u.pathname === '/v6/vehicle/battery-info') {
      payload = {
        code: 1,
        data: {
          electricity: 12,
          battery_main: { electricity: '100' },
          battery_list: [{ bms_volt: '71.3', bat_temp: '12', electricity: '12' }],
        },
      };
    } else if (u.pathname === '/vehicle/vehicle/vehicle-status') {
      payload = {
        code: 1,
        data: {
          power_status: 0,
          SQ: { GSM: 23, GNSS: 33, loc_delay_seconds: 120 },
        },
      };
    }

    const respWrapper = JSON.stringify({ data: c.androidB64(JSON.stringify(payload)), platform: 2, timeStamp: Math.floor(nowMs / 1000) });
    return {
      status: 200,
      headers: {},
      body: Buffer.from(JSON.stringify({ r: c.aesCbcEncrypt(respKey, Buffer.from(respWrapper, 'utf8')).toString('base64') })),
    };
  };

  const deps = { homeDir: home, dataDir, nowFn: () => nowMs, httpRequester: requester, rsaPublicKeyPem: pubPem };
  try {
    const loginRes = await plugin.runAction('login', { username: '13800138999', password: 'pw' }, deps);
    assert.equal(loginRes.ok, true);

    const patrolRes = await plugin.runAction('patrol', {}, deps);
    assert.equal(patrolRes.ok, true);
    const pData = patrolRes.data as Record<string, any>;
    assert.equal(pData.snapshot.locked, true);
    assert.equal(pData.snapshot.powerOn, false);
    assert.equal(pData.snapshot.batteryPresent, true);
    assert.equal(pData.snapshot.color, '英伦绿');
    assert.equal(pData.snapshot.gsmSignal, 23);
    assert.equal(pData.snapshot.gnssSignal, 33);
    assert.equal(pData.snapshot.effectiveRangeKm, 11.5);
    assert.equal(pData.alerts.some((a: any) => a.key === 'low_battery'), true);
    assert.equal(pData.alerts.some((a: any) => a.key === 'unlocked_warning'), false);

    assert.equal(existsSync(join(dataDir, 'vehicle-dark.png')), true);
    assert.equal(existsSync(join(dataDir, 'vehicle-light.png')), true);
    assert.equal(statSync(join(dataDir, 'vehicle-dark.png')).mode & 0o777, 0o600);
    assert.equal(statSync(join(dataDir, 'vehicle-light.png')).mode & 0o777, 0o600);

    const dash = await plugin.runAction('dashboard', {}, deps);
    assert.equal(dash.ok, true);
    const dData = dash.data as Record<string, any>;
    assert.match(String(dData.vehicleImages?.darkDataUrl), /^data:image\/png;base64,/);
    assert.match(String(dData.vehicleImages?.lightDataUrl), /^data:image\/png;base64,/);
    assert.equal(JSON.stringify(dData).includes(dataDir), false, 'dashboard must not expose host filesystem paths');
    assert.equal(dData.activeAlerts.some((a: any) => a.key === 'unlocked_warning'), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

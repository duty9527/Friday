import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import dgram from 'node:dgram';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  ACTIONS,
  DEFAULT_CONFIG,
  FRYER_STATUS_MAP,
  PRESET_RECIPES,
  buildAcInstructions,
  buildFryerGetParams,
  buildFryerStartInputs,
  buildMibrainCommand,
  buildMipsRemoteScript,
  buildSshArgs,
  classifyCategory,
  decryptMiioPacket,
  defaultFetchHubRawRows,
  discoverSpeakerSsh,
  encryptMiioPacket,
  handleVoiceFastpath,
  packMipsFrame,
  parseHubSnapshot,
  parseSshSpec,
  parseSshTargets,
  resolveDevice,
  resolveRecipe,
  runAction,
  sanitizeOutput,
  summarizeFryerProps,
  udpCall,
  unpackMipsFrame,
  unquoteDbVal,
} from '../plugins/miot/index.mjs';
import { listPlugins, runPlugin, runPluginInProcess } from '../src/plugin.js';

// ---------------------------------------------------------------------------
// Realistic 10-device BE6500 Pro Hub Fixture
// ---------------------------------------------------------------------------

const TOKENS = Object.freeze({
  fryer: '51908c7a3d24b4f825c5dc269a0b1234',
  lx06: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  oh2p: 'f0e1d2c3b4a5968778695a4b3c2d1e0f',
  fish: '11223344556677889900aabbccddeeff',
  turtle: 'ffeeddccbbaa00998877665544332211',
  bedroomLight: '0123456789abcdef0123456789abcdef',
  router: 'deadbeefcafebabe0123456789abcdef',
});

const ALL_TOKENS = Object.values(TOKENS);
const HEX32_ANY_RE = /(?<![0-9a-zA-Z])[0-9a-fA-F]{32}(?![0-9a-zA-Z])/;

function assertNoTokenLeak(value: unknown, label = 'output') {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const tok of ALL_TOKENS) {
    assert.equal(serialized.includes(tok), false, `${label} leaked token ${tok}`);
  }
  assert.doesNotMatch(serialized, HEX32_ANY_RE, `${label} contained a 32-hex string: ${serialized}`);
}

function q(val: unknown): string {
  return JSON.stringify(val);
}

function createHubFixtureRows() {
  const homeid = q('778899001122');
  const devInfoRows = [
    // 1. BE6500 Pro Router (connect_type = 0)
    {
      did: q('miwifi.be6500pro'),
      uid: q('100001'),
      token: q(TOKENS.router),
      dev_name: q('小米路由器BE6500 Pro'),
      model: q('xiaomi.router.rd08'),
      model_name: q('Xiaomi路由器BE6500 Pro'),
      urn: q('urn:miot-spec-v2:device:router:0000A036:xiaomi-rd08:1'),
      ip: q('192.0.2.1'),
      connect_type: q(0),
      online: q(true),
      homeid,
      roomid: q('r_living'),
      room_name: q('客厅'),
      parent: null,
      fw_ver: q('1.1.26'),
    },
    // 2. Wi-Fi Air Fryer (connect_type = 8)
    {
      did: q('881122334'),
      uid: q('100001'),
      token: q(TOKENS.fryer),
      dev_name: q('米家智能空气炸锅3.5L'),
      model: q('careli.fryer.maf01'),
      model_name: q('米家智能空气炸锅3.5L'),
      urn: q('urn:miot-spec-v2:device:air-fryer:0000A0A4:careli-maf01:1'),
      ip: q('192.0.2.216'),
      connect_type: q(8),
      online: q(true),
      homeid,
      roomid: q('r_kitchen'),
      room_name: q('厨房'),
      parent: null,
      fw_ver: q('2.0.8_0030'),
    },
    // 3. LX06 Smart Speaker (connect_type = 8)
    {
      did: q('60000104'),
      uid: q('100001'),
      token: q(TOKENS.lx06),
      dev_name: q('小爱音箱Pro'),
      model: q('xiaomi.wifispeaker.lx06'),
      model_name: q('小米AI音箱第二代'),
      urn: q('urn:miot-spec-v2:device:speaker:0000A015:xiaomi-lx06:1'),
      ip: q('192.0.2.104'),
      connect_type: q(8),
      online: q(true),
      homeid,
      roomid: q('r_living'),
      room_name: q('客厅'),
      parent: null,
      fw_ver: q('1.86.10'),
    },
    // 4. OH2P Smart Speaker (connect_type = 8)
    {
      did: q('60000208'),
      uid: q('100001'),
      token: q(TOKENS.oh2p),
      dev_name: q('Xiaomi Sound'),
      model: q('xiaomi.wifispeaker.oh2p'),
      model_name: q('Xiaomi Sound'),
      urn: q('urn:miot-spec-v2:device:speaker:0000A015:xiaomi-oh2p:1'),
      ip: q('192.0.2.155'),
      connect_type: q(8),
      online: q(true),
      homeid,
      roomid: q('r_bedroom'),
      room_name: q('卧室'),
      parent: null,
      fw_ver: q('1.72.4'),
    },
    // 5. BT Mesh Outlet 水草补光灯 (connect_type = 16)
    {
      did: q('110022001'),
      uid: q('100001'),
      token: q(TOKENS.fish),
      dev_name: q('水草补光灯'),
      model: q('cuco.plug.v3'),
      model_name: q('米家智能插座蓝牙网关版'),
      urn: q('urn:miot-spec-v2:device:outlet:0000A002:cuco-v3:1'),
      ip: q(''),
      connect_type: q(16),
      online: q(true),
      homeid,
      roomid: q('r_living'),
      room_name: q('客厅'),
      parent: q('miwifi.be6500pro'),
      fw_ver: q('1.3.0'),
    },
    // 6. BT Mesh Outlet 阳台夜灯 (connect_type = 16)
    {
      did: q('110022002'),
      uid: q('100001'),
      token: q(TOKENS.turtle),
      dev_name: q('阳台夜灯'),
      model: q('cuco.plug.v2'),
      model_name: q('米家智能插座3'),
      urn: q('urn:miot-spec-v2:device:outlet:0000A002:cuco-v2:1'),
      ip: q(''),
      connect_type: q(16),
      online: q(true),
      homeid,
      roomid: q('r_balcony'),
      room_name: q('阳台'),
      parent: q('miwifi.be6500pro'),
      fw_ver: q('1.2.4'),
    },
    // 7. BT Mesh Switch 卧室灯 (connect_type = 16)
    {
      did: q('110022003'),
      uid: q('100001'),
      token: q(TOKENS.bedroomLight),
      dev_name: q('卧室灯'),
      model: q('isa.switch.kg01hl'),
      model_name: q('米家智能开关'),
      urn: q('urn:miot-spec-v2:device:switch:0000A003:isa-kg01hl:1'),
      ip: q(''),
      connect_type: q(16),
      online: q(true),
      homeid,
      roomid: q('r_bedroom'),
      room_name: q('卧室'),
      parent: q('miwifi.be6500pro'),
      fw_ver: q('2.1.0'),
    },
    // 8. IR Virtual TV (connect_type = 15)
    {
      did: q('ir.190000001'),
      uid: q('100001'),
      token: q(''),
      dev_name: q('电视'),
      model: q('miir.tv.ir01'),
      model_name: q('小米电视红外遥控'),
      urn: q('urn:miot-spec-v2:device:television:0000A010:miir-ir01:1'),
      ip: q(''),
      connect_type: q(15),
      online: q(true),
      homeid,
      roomid: q('r_living'),
      room_name: q('客厅'),
      parent: q('60000104'),
      fw_ver: q('1.0.0'),
    },
    // 9. IR Virtual AC in 客厅 (connect_type = 15)
    {
      did: q('ir.190000002'),
      uid: q('100001'),
      token: q(''),
      dev_name: q('空调'),
      model: q('miir.aircondition.ir01'),
      model_name: q('格力空调红外'),
      urn: q('urn:miot-spec-v2:device:air-conditioner:0000A004:miir-ir01:1'),
      ip: q(''),
      connect_type: q(15),
      online: q(true),
      homeid,
      roomid: q('r_living'),
      room_name: q('客厅'),
      parent: q('60000104'),
      fw_ver: q('1.0.0'),
    },
    // 10. IR Virtual AC in 卧室 (connect_type = 15)
    {
      did: q('ir.190000003'),
      uid: q('100001'),
      token: q(''),
      dev_name: q('空调'),
      model: q('miir.aircondition.ir02'),
      model_name: q('美的空调红外'),
      urn: q('urn:miot-spec-v2:device:air-conditioner:0000A004:miir-ir02:1'),
      ip: q(''),
      connect_type: q(15),
      online: q(true),
      homeid,
      roomid: q('r_bedroom'),
      room_name: q('卧室'),
      parent: q('60000208'),
      fw_ver: q('1.0.0'),
    },
  ];

  const hotDataRows = [
    { key: '110022001😂2.1', value: JSON.stringify({ value: true, ts: 1700000100 }) },
    { key: '110022002😂2.1', value: JSON.stringify({ value: false, ts: 1700000200 }) },
    { key: '110022003😂2.1', value: JSON.stringify({ value: true, ts: 1700000300 }) },
    { key: '110022003😂online', value: JSON.stringify({ value: 1, ts: 1700000305 }) },
    // Secret-like hot keys must never leak into cachedState.rawKeys
    { key: '110022003😂bind_key', value: JSON.stringify(TOKENS.bedroomLight) },
    { key: '881122334😂token', value: JSON.stringify(TOKENS.fryer) },
  ];

  return { devInfoRows, hotDataRows };
}

function makeFryerPropsResult(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    '2.1': 1, // 待机
    '2.2': 0, // fault
    '2.3': 15, // targetTimeMin
    '2.4': 180, // targetTempC
    '2.5': 12, // leftTimeMin
    '3.1': 'M1', // recipeId
    '3.2': '\\u85af\\u6761', // 薯条
    '3.5': 0, // appointMinutes
    '3.6': 2, // foodQuantity
    '3.7': 1, // preheatSwitch
    '3.8': 0, // appointLeftMin
    '3.10': 1, // turnPot
    ...overrides,
  };
  return buildFryerGetParams('881122334').map(({ did, siid, piid }) => ({
    did,
    siid,
    piid,
    code: 0,
    value: defaults[`${siid}.${piid}`],
  }));
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'miot-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

interface MockHarnessOptions {
  dir: string;
  nowMs?: number;
  protectedDevices?: string[];
  bleProps?: Record<string, boolean | number | undefined>;
  bleWriteCode?: number;
  fryerReadQueue?: Array<Record<string, unknown>>;
  fryerActionCode?: number;
  routerReachable?: boolean;
  speakerReachable?: boolean;
  tvPowerResult?: Record<string, unknown>;
  tvStatusResult?: Record<string, unknown>;
}

function createMockHarness(opts: MockHarnessOptions) {
  let currentNow = opts.nowMs ?? 1_700_000_000_000;
  let fetchHubCount = 0;
  const bleState: Record<string, boolean | number | undefined> = {
    '110022001': true,
    '110022002': false,
    '110022003': false,
    ...(opts.bleProps ?? {}),
  };
  const fryerQueue = [...(opts.fryerReadQueue ?? [{ '2.1': 1 }])];
  const sshBinCalls: Array<{ target: any; cmd: string; input?: Buffer; decoded?: any }> = [];
  const sshTextCalls: Array<{ target: any; cmd: string; timeoutMs?: number }> = [];
  const udpCalls: Array<{ ip: string; tokenHex: string; method: string; params: any; timeoutMs?: number }> = [];
  const tvCalls: Array<{ action: string; args: any }> = [];
  const sleeps: number[] = [];

  const dataDir = join(opts.dir, 'plugins', 'miot');
  if ((opts as { seedConfig?: boolean }).seedConfig !== false) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dataDir, 'config.json'),
      JSON.stringify({
        routerSsh: 'root@192.0.2.1',
        speakerSsh: 'lx06=root@192.0.2.104',
        protectedDevices: opts.protectedDevices ?? [],
        customAliases: {
          水草补光灯: ['水草灯'],
          阳台夜灯: ['夜灯'],
        },
      }) + '\n',
      { mode: 0o600 },
    );
  }
  const deps = {
    homeDir: opts.dir,
    dataDir,
    env: { SUPER_AGENT_HOME: opts.dir, PLUGIN_DATA_DIR: dataDir },
    nowFn: () => currentNow,
    sleepFn: async (ms: number) => {
      sleeps.push(ms);
    },
    fetchHubRawRows: async () => {
      fetchHubCount++;
      return createHubFixtureRows();
    },
    sshBinaryExec: async (target: any, cmd: string, callOpts: { input?: Buffer; timeoutMs?: number } = {}) => {
      const decoded = callOpts.input ? unpackMipsFrame(callOpts.input) : undefined;
      sshBinCalls.push({ target, cmd, input: callOpts.input, decoded });
      const reqId = decoded?.reqId ?? 1;
      const returnTopic = decoded?.returnTopic ?? 'local/friday/rpcReply_test';
      const payload: any = decoded?.payload ?? {};
      if (payload.method === 'get_properties') {
        const result = (payload.params ?? []).map((p: any) => {
          const val = bleState[String(p.did)];
          if (val === undefined) return { did: p.did, siid: p.siid, piid: p.piid, code: -4004 };
          return { did: p.did, siid: p.siid, piid: p.piid, code: 0, value: val };
        });
        return {
          stdout: packMipsFrame(reqId, returnTopic, { id: reqId, result }),
          stderr: '',
          code: 0,
        };
      }
      if (payload.method === 'set_properties') {
        const code = opts.bleWriteCode ?? 0;
        const result = (payload.params ?? []).map((p: any) => {
          if (code === 0) bleState[String(p.did)] = p.value;
          return { did: p.did, siid: p.siid, piid: p.piid, code };
        });
        return {
          stdout: packMipsFrame(reqId, returnTopic, { id: reqId, result }),
          stderr: '',
          code: 0,
        };
      }
      if (payload.method === 'action') {
        const p = payload.params ?? {};
        return {
          stdout: packMipsFrame(reqId, returnTopic, {
            id: reqId,
            result: { did: p.did, siid: p.siid, aiid: p.aiid, code: opts.bleWriteCode ?? 0, out: [] },
          }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: Buffer.alloc(0), stderr: 'unknown method', code: 1 };
    },
    sshTextExec: async (target: any, cmd: string, timeoutMs?: number) => {
      sshTextCalls.push({ target, cmd, timeoutMs });
      if (cmd.includes('central_service')) {
        if (opts.routerReachable === false) return { stdout: '', stderr: 'Connection refused', code: 255 };
        return { stdout: 'FRIDAY_OK\n4321\n', stderr: '', code: 0 };
      }
      if (cmd.includes('ubus list')) {
        if (opts.speakerReachable === false) return { stdout: '', stderr: 'Host unreachable', code: 255 };
        return { stdout: 'FRIDAY_OK\n1\n', stderr: '', code: 0 };
      }
      if (cmd.includes('ubus -t 5 call mibrain ai_service')) {
        if (opts.speakerReachable === false) return { stdout: '', stderr: 'ssh failed', code: 255 };
        return { stdout: '{"code":0}', stderr: '', code: 0 };
      }
      return { stdout: 'FRIDAY_OK\n', stderr: '', code: 0 };
    },
    udpCall: async (call: { ip: string; tokenHex: string; method: string; params: any; timeoutMs?: number }) => {
      udpCalls.push(call);
      if (call.method === 'get_properties') {
        const nextOverride = fryerQueue.length > 1 ? fryerQueue.shift()! : (fryerQueue[0] ?? {});
        return { id: 1, result: makeFryerPropsResult(nextOverride) };
      }
      if (call.method === 'action') {
        return { id: 1, result: { did: call.params?.did, siid: call.params?.siid, aiid: call.params?.aiid, code: opts.fryerActionCode ?? 0, out: [] } };
      }
      if (call.method === 'set_properties') {
        return {
          id: 1,
          result: (call.params ?? []).map((p: any) => ({ did: p.did, siid: p.siid, piid: p.piid, code: 0 })),
        };
      }
      return { id: 1, result: [] };
    },
    tvAgentRunner: async (action: string, args: any) => {
      tvCalls.push({ action, args });
      if (action === 'power') {
        return opts.tvPowerResult ?? { ok: true, message: `电视已执行 ${args.state}`, data: { powerState: args.state === 'off' ? 'standby_or_off' : 'online', state: args.state } };
      }
      return opts.tvStatusResult ?? { ok: true, message: '电视在线', data: { powerState: 'online', volume: 22, appName: '哔哩哔哩', apps: [{ package: 'x', label: 'X' }] } };
    },
  };

  return {
    deps,
    bleState,
    sshBinCalls,
    sshTextCalls,
    udpCalls,
    tvCalls,
    sleeps,
    getFetchHubCount: () => fetchHubCount,
    advanceTime: (ms: number) => {
      currentNow += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. unquoteDbVal
// ---------------------------------------------------------------------------

test('1. unquoteDbVal parses JSON-encoded strings, booleans, numbers, null, and preserves plain/malformed values', () => {
  assert.equal(unquoteDbVal('"客厅"'), '客厅');
  assert.equal(unquoteDbVal('"小米路由器BE6500 Pro"'), '小米路由器BE6500 Pro');
  assert.equal(unquoteDbVal('true'), true);
  assert.equal(unquoteDbVal('false'), false);
  assert.equal(unquoteDbVal('16'), 16);
  assert.equal(unquoteDbVal('0'), 0);
  assert.equal(unquoteDbVal('null'), null);
  assert.equal(unquoteDbVal(null), null);
  assert.equal(unquoteDbVal(undefined), undefined);
  assert.equal(unquoteDbVal(42), 42);
  assert.equal(unquoteDbVal(true), true);
  assert.equal(unquoteDbVal('plain-unquoted-string'), 'plain-unquoted-string');
  assert.equal(unquoteDbVal('"unterminated json'), '"unterminated json');
  assert.equal(unquoteDbVal('{bad json'), '{bad json');
});

// ---------------------------------------------------------------------------
// 2. packMipsFrame, unpackMipsFrame & buildMipsRemoteScript
// ---------------------------------------------------------------------------

test('2. packMipsFrame & unpackMipsFrame verify exact TLV binary wire layout [uint32LE(len)][uint8(tag)][bytes] and round-trip', () => {
  const reqId = 0x12345678;
  const returnTopic = 'local/friday/rpcReply_a1b2c3d4e5f6';
  const payloadObj = { id: reqId, method: 'get_properties', params: [{ did: '110022003', siid: 2, piid: 1 }] };

  const buf = packMipsFrame(reqId, returnTopic, payloadObj);
  assert.ok(Buffer.isBuffer(buf));

  // Tag 0: [len=4 (uint32LE)][tag=0 (uint8)][reqId (uint32LE)] -> 9 bytes (0..9)
  assert.equal(buf.readUInt32LE(0), 4);
  assert.equal(buf.readUInt8(4), 0);
  assert.equal(buf.readUInt32LE(5), reqId);

  // Tag 3: [len=6][tag=3]["local\0"] -> 11 bytes (9..20)
  let offset = 9;
  assert.equal(buf.readUInt32LE(offset), 6);
  assert.equal(buf.readUInt8(offset + 4), 3);
  assert.deepEqual(buf.subarray(offset + 5, offset + 11), Buffer.from('local\0', 'utf8'));

  // Tag 1: [len=returnTopic.length+1][tag=1]["<returnTopic>\0"]
  offset += 11;
  const expectedTopicBuf = Buffer.from(`${returnTopic}\0`, 'utf8');
  assert.equal(buf.readUInt32LE(offset), expectedTopicBuf.length);
  assert.equal(buf.readUInt8(offset + 4), 1);
  assert.deepEqual(buf.subarray(offset + 5, offset + 5 + expectedTopicBuf.length), expectedTopicBuf);

  // Tag 2: [len=json.length][tag=2][JSON without trailing NUL]
  offset += 5 + expectedTopicBuf.length;
  const expectedJsonBuf = Buffer.from(JSON.stringify(payloadObj), 'utf8');
  assert.equal(buf.readUInt32LE(offset), expectedJsonBuf.length);
  assert.equal(buf.readUInt8(offset + 4), 2);
  const jsonSlice = buf.subarray(offset + 5, offset + 5 + expectedJsonBuf.length);
  assert.deepEqual(jsonSlice, expectedJsonBuf);
  assert.notEqual(jsonSlice[jsonSlice.length - 1], 0, 'tag 2 JSON must not have trailing NUL');
  assert.equal(offset + 5 + expectedJsonBuf.length, buf.length);

  // Round-trip via unpackMipsFrame
  const unpacked = unpackMipsFrame(buf);
  assert.equal(unpacked.reqId, reqId);
  assert.equal(unpacked.realm, 'local');
  assert.equal(unpacked.returnTopic, returnTopic);
  assert.deepEqual(unpacked.payload, payloadObj);
});

test('3. unpackMipsFrame handles empty, truncated, and non-JSON tag 2 buffers safely', () => {
  assert.deepEqual(unpackMipsFrame(Buffer.alloc(0)), {
    reqId: undefined,
    realm: undefined,
    returnTopic: undefined,
    payload: undefined,
  });
  assert.deepEqual(unpackMipsFrame(Buffer.from([1, 2, 3])), {
    reqId: undefined,
    realm: undefined,
    returnTopic: undefined,
    payload: undefined,
  });

  // Truncated frame mid-tag-2: tags 0, 3, 1 still recovered cleanly
  const valid = packMipsFrame(99, 'local/friday/rpcReply_abcd1234', { id: 99, ok: true });
  const truncated = valid.subarray(0, valid.length - 5);
  const partial = unpackMipsFrame(truncated);
  assert.equal(partial.reqId, 99);
  assert.equal(partial.realm, 'local');
  assert.equal(partial.returnTopic, 'local/friday/rpcReply_abcd1234');
  assert.equal(partial.payload, undefined);

  // Non-JSON payload in tag 2 sets rawPayload and leaves payload undefined
  const badJsonBytes = Buffer.from('{not-valid-json', 'utf8');
  const badHeader = Buffer.alloc(5);
  badHeader.writeUInt32LE(badJsonBytes.length, 0);
  badHeader.writeUInt8(2, 4);
  const badFrame = Buffer.concat([badHeader, badJsonBytes]);
  const badUnpacked = unpackMipsFrame(badFrame) as any;
  assert.equal(badUnpacked.payload, undefined);
  assert.equal(badUnpacked.rawPayload, '{not-valid-json');
});

test('4. buildMipsRemoteScript generates chroot mosquitto script for hex nonces and rejects unsafe nonces', () => {
  const script = buildMipsRemoteScript('a1b2c3d4e5f6');
  assert.match(script, /local\/friday\/rpcReply_a1b2c3d4e5f6/);
  assert.match(script, /local\/bt\/rpcReq/);
  assert.match(script, /trap 'rm -f "\$IN" "\$OUT"' EXIT/);
  for (const invalidNonce of ['', '12', 'xyz123', 'abcd; rm -rf /', '0123456789abcdef0123456789abcdef00']) {
    assert.throws(() => buildMipsRemoteScript(invalidNonce), /invalid nonce/);
  }
});

// ---------------------------------------------------------------------------
// 3. encryptMiioPacket, decryptMiioPacket & udpCall
// ---------------------------------------------------------------------------

test('5. encryptMiioPacket & decryptMiioPacket round-trip AES-128-CBC + MD5 0x2131 header and preserve stamp', () => {
  const devId = 881122334;
  const stamp = 0x00abcdef;
  const tokenHex = TOKENS.fryer;
  const payloadObj = { id: 77, method: 'get_properties', params: [{ did: '881122334', siid: 2, piid: 1 }] };

  const packet = encryptMiioPacket({ devId, stamp, tokenHex, payloadObj });
  assert.ok(packet.length > 32);
  assert.equal(packet.readUInt16BE(0), 0x2131);
  assert.equal(packet.readUInt16BE(2), packet.length);
  assert.equal(packet.readUInt32BE(4), 0);
  assert.equal(packet.readUInt32BE(8), devId);
  assert.equal(packet.readUInt32BE(12), stamp);
  assert.equal((packet.length - 32) % 16, 0, 'AES-128-CBC ciphertext is 16-byte aligned');

  const dec = decryptMiioPacket({ packet, tokenHex });
  assert.equal(dec.devId, devId);
  assert.equal(dec.stamp, stamp);
  assert.deepEqual(dec.payload, payloadObj);
  assert.equal(dec.text, JSON.stringify(payloadObj));

  // 32-byte hello/ack packet returns empty payload with devId and stamp
  const helloAck = Buffer.alloc(32);
  helloAck.writeUInt16BE(0x2131, 0);
  helloAck.writeUInt16BE(32, 2);
  helloAck.writeUInt32BE(devId, 8);
  helloAck.writeUInt32BE(stamp, 12);
  const ackDec = decryptMiioPacket({ packet: helloAck, tokenHex });
  assert.equal(ackDec.devId, devId);
  assert.equal(ackDec.stamp, stamp);
  assert.equal(ackDec.payload, undefined);
  assert.equal(ackDec.text, '');
});

test('6. encryptMiioPacket & decryptMiioPacket reject invalid tokens, wrong-token MD5 checksums, and bad headers', () => {
  const packet = encryptMiioPacket({
    devId: 881122334,
    stamp: 1234,
    tokenHex: TOKENS.fryer,
    payloadObj: { id: 1, method: 'get_properties', params: [] },
  });

  // Wrong token fails MD5 checksum
  assert.throws(() => decryptMiioPacket({ packet, tokenHex: TOKENS.lx06 }), /校验和不匹配/);

  // Tampered ciphertext fails MD5 checksum
  const tampered = Buffer.from(packet);
  const lastIdx = tampered.length - 1;
  tampered[lastIdx] = (tampered[lastIdx] ?? 0) ^ 0xff;
  assert.throws(() => decryptMiioPacket({ packet: tampered, tokenHex: TOKENS.fryer }), /校验和不匹配/);

  // Invalid token format rejected
  assert.throws(
    () => encryptMiioPacket({ devId: 1, stamp: 1, tokenHex: 'not-a-hex-token', payloadObj: {} }),
    /缺少有效的设备 token/,
  );

  // Invalid packet magic/size rejected
  assert.throws(() => decryptMiioPacket({ packet: Buffer.alloc(10), tokenHex: TOKENS.fryer }), /无效的 MiIO 数据包头/);
});

test('7. udpCall performs MiIO hello handshake + encrypted request/response against local UDP socket', async () => {
  const server = dgram.createSocket('udp4');
  const devId = 881122334;
  const serverStamp = 500;
  const tokenHex = TOKENS.fryer;
  let receivedPayload: any;

  server.on('message', (msg, rinfo) => {
    if (msg.length === 32 && msg.readUInt16BE(0) === 0x2131 && msg.readUInt32BE(8) === 0xffffffff) {
      const helloReply = Buffer.alloc(32);
      helloReply.writeUInt16BE(0x2131, 0);
      helloReply.writeUInt16BE(32, 2);
      helloReply.writeUInt32BE(0, 4);
      helloReply.writeUInt32BE(devId, 8);
      helloReply.writeUInt32BE(serverStamp, 12);
      server.send(helloReply, rinfo.port, rinfo.address);
      return;
    }
    const dec = decryptMiioPacket({ packet: msg, tokenHex });
    receivedPayload = dec.payload;
    assert.equal(dec.stamp, serverStamp + 1);
    const reply = encryptMiioPacket({
      devId,
      stamp: serverStamp + 2,
      tokenHex,
      payloadObj: { id: dec.payload?.id, result: [{ did: '881122334', siid: 2, piid: 1, code: 0, value: 4 }] },
    });
    server.send(reply, rinfo.port, rinfo.address);
  });

  await new Promise<void>(resolve => server.bind(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    const res = await udpCall({
      ip: '127.0.0.1',
      port,
      tokenHex,
      method: 'get_properties',
      params: [{ did: '881122334', siid: 2, piid: 1 }],
      timeoutMs: 1500,
    });
    assert.equal(receivedPayload.method, 'get_properties');
    assert.deepEqual(res.result, [{ did: '881122334', siid: 2, piid: 1, code: 0, value: 4 }]);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// 4. parseHubSnapshot (10-device fixture + token redaction)
// ---------------------------------------------------------------------------

test('8. parseHubSnapshot classifies all 10 realistic devices (category, categories with light, controlChannel, controllable)', () => {
  const snap = parseHubSnapshot({ ...createHubFixtureRows(), nowMs: 1_700_000_000_000 });
  assert.equal(snap.homeId, '778899001122');
  assert.equal(snap.fetchedAt, 1_700_000_000_000);
  assert.equal(snap.devices.length, 10);

  const byDid = new Map(snap.devices.map((d: any) => [d.did, d]));

  const router = byDid.get('miwifi.be6500pro');
  assert.equal(router.category, 'router');
  assert.equal(router.controlChannel, 'router');
  assert.equal(router.controllable, false);

  const fryer = byDid.get('881122334');
  assert.equal(fryer.category, 'air_fryer');
  assert.equal(fryer.controlChannel, 'miio_udp');
  assert.equal(fryer.controllable, true);
  assert.equal(fryer.ip, '192.0.2.216');

  const lx06 = byDid.get('60000104');
  const oh2p = byDid.get('60000208');
  assert.equal(lx06.category, 'speaker');
  assert.equal(lx06.controlChannel, 'miio_udp');
  assert.equal(oh2p.category, 'speaker');
  assert.equal(oh2p.room, '卧室');

  // Outlets & switches named with '灯' include 'light' in categories
  const fish = byDid.get('110022001');
  assert.equal(fish.category, 'outlet');
  assert.deepEqual(fish.categories, ['outlet', 'light']);
  assert.equal(fish.controlChannel, 'bt_mesh');

  const turtle = byDid.get('110022002');
  assert.equal(turtle.category, 'outlet');
  assert.deepEqual(turtle.categories, ['outlet', 'light']);
  assert.equal(turtle.controlChannel, 'bt_mesh');

  const bedLight = byDid.get('110022003');
  assert.equal(bedLight.category, 'switch');
  assert.deepEqual(bedLight.categories, ['switch', 'light']);
  assert.equal(bedLight.controlChannel, 'bt_mesh');

  const tv = byDid.get('ir.190000001');
  assert.equal(tv.category, 'tv');
  assert.equal(tv.controlChannel, 'tv_agent');
  assert.equal(tv.controllable, true);

  const livingAc = byDid.get('ir.190000002');
  const bedAc = byDid.get('ir.190000003');
  assert.equal(livingAc.category, 'air_conditioner');
  assert.equal(livingAc.controlChannel, 'xiaoai_nlp');
  assert.equal(livingAc.room, '客厅');
  assert.equal(bedAc.category, 'air_conditioner');
  assert.equal(bedAc.controlChannel, 'xiaoai_nlp');
  assert.equal(bedAc.room, '卧室');
});

test('9. parseHubSnapshot merges appMsg cached state and enforces strict token redaction on devices while retaining tokenByDid', () => {
  const snap = parseHubSnapshot(createHubFixtureRows());

  for (const dev of snap.devices) {
    assert.equal('token' in dev, false, `device ${dev.did} must not have token property`);
  }
  assertNoTokenLeak(snap.devices, 'snap.devices');

  // tokenByDid retains valid 32-hex tokens internally
  assert.equal(snap.tokenByDid['881122334'], TOKENS.fryer);
  assert.equal(snap.tokenByDid['60000104'], TOKENS.lx06);
  assert.equal(snap.tokenByDid['60000208'], TOKENS.oh2p);
  assert.equal(snap.tokenByDid['110022001'], TOKENS.fish);
  assert.equal(snap.tokenByDid['ir.190000001'], undefined);

  const byDid = new Map(snap.devices.map((d: any) => [d.did, d]));
  assert.equal(byDid.get('881122334').hasToken, true);
  assert.equal(byDid.get('ir.190000001').hasToken, false);
  assert.deepEqual(byDid.get('110022001').cachedState.properties['2.1'], { value: true, ts: 1700000100 });
  assert.deepEqual(byDid.get('110022002').cachedState.properties['2.1'], { value: false, ts: 1700000200 });
  assert.deepEqual(byDid.get('110022003').cachedState.properties['2.1'], { value: true, ts: 1700000300 });
  assert.deepEqual(byDid.get('110022003').cachedState.rawKeys, { online: { value: 1, ts: 1700000305 } });
  assert.equal('bind_key' in (byDid.get('110022003').cachedState.rawKeys ?? {}), false);
  assert.equal(byDid.get('881122334').cachedState.rawKeys, undefined);
});

// ---------------------------------------------------------------------------
// 5. resolveDevice
// ---------------------------------------------------------------------------

test('10. resolveDevice matches exact did, exact dev_name, room+dev_name, customAliases, and built-in aliases', () => {
  const { devices } = parseHubSnapshot(createHubFixtureRows());
  const customAliases = { 水草补光灯: ['水草灯'], 阳台夜灯: ['夜灯'] };

  assert.equal(resolveDevice(devices, { did: '881122334' }).dev_name, '米家智能空气炸锅3.5L');
  assert.equal(resolveDevice(devices, { device: '卧室灯' }).did, '110022003');
  assert.equal(resolveDevice(devices, { device: '水草补光灯' }).did, '110022001');
  assert.equal(resolveDevice(devices, { device: '阳台夜灯' }).did, '110022002');
  assert.equal(resolveDevice(devices, { device: '客厅空调' }).did, 'ir.190000002');
  assert.equal(resolveDevice(devices, { device: '卧室空调' }).did, 'ir.190000003');
  assert.equal(resolveDevice(devices, { device: '卧室的空调' }).did, 'ir.190000003');
  assert.equal(resolveDevice(devices, { device: '卧室的灯' }).did, '110022003');
  assert.equal(resolveDevice(devices, { device: '炸锅' }).did, '881122334');
  assert.equal(resolveDevice(devices, { device: '空气炸锅' }).did, '881122334');
  assert.equal(resolveDevice(devices, { device: '水草灯', customAliases }).did, '110022001');
  assert.equal(resolveDevice(devices, { device: '夜灯', customAliases }).did, '110022002');
  assert.equal(resolveDevice(devices, { device: '电视' }).did, 'ir.190000001');
});

test('11. resolveDevice disambiguates by room filter and throws AMBIGUOUS_DEVICE on bare "空调"', () => {
  const { devices } = parseHubSnapshot(createHubFixtureRows());

  assert.equal(resolveDevice(devices, { device: '空调', room: '客厅' }).did, 'ir.190000002');
  assert.equal(resolveDevice(devices, { device: '空调', room: '卧室' }).did, 'ir.190000003');

  assert.throws(
    () => resolveDevice(devices, { device: '空调' }),
    (err: any) => {
      assert.equal(err.code, 'AMBIGUOUS_DEVICE');
      assert.match(err.message, /客厅空调/);
      assert.match(err.message, /卧室空调/);
      assert.equal(err.data?.candidates?.length, 2);
      return true;
    },
  );

  assert.throws(() => resolveDevice(devices, {}), (err: any) => err.code === 'DEVICE_REQUIRED');
  assert.throws(() => resolveDevice(devices, { did: '999999999' }), (err: any) => err.code === 'DEVICE_NOT_FOUND');
  assert.throws(() => resolveDevice(devices, { device: '不存在的洗衣机' }), (err: any) => err.code === 'DEVICE_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// 6. devices, status, config + cache TTL + 0600 permissions + zero token leak
// ---------------------------------------------------------------------------

test('12. devices action filters by room, category (灯 includes 水草补光灯/阳台夜灯/卧室灯), and controllableOnly', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({ dir });

    const all = await runAction('devices', { live: false }, h.deps);
    assert.equal(all.ok, true);
    assert.equal(all.data.count, 10);
    assertNoTokenLeak(all, 'devices (all)');

    const bedroom = await runAction('devices', { room: '卧室', live: false }, h.deps);
    assert.deepEqual(bedroom.data.devices.map((d: any) => d.fullName).sort(), ['卧室Xiaomi Sound', '卧室灯', '卧室空调'].sort());

    const lights = await runAction('devices', { category: '灯', live: false }, h.deps);
    assert.deepEqual(lights.data.devices.map((d: any) => d.name).sort(), ['卧室灯', '水草补光灯', '阳台夜灯']);

    const outlets = await runAction('devices', { category: '插座', live: false }, h.deps);
    assert.deepEqual(outlets.data.devices.map((d: any) => d.name).sort(), ['水草补光灯', '阳台夜灯']);

    const controllable = await runAction('devices', { controllableOnly: true, live: false }, h.deps);
    assert.equal(controllable.data.count, 9);
    assert.equal(controllable.data.devices.some((d: any) => d.category === 'router'), false);
  });
});

test('13. devices action honours cacheTtlMs, refresh:true bypass, 0600 hub-cache.json permissions, and stale cache fallback', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({ dir });

    const first = await runAction('devices', { live: false }, h.deps);
    assert.equal(first.data.source, 'hub');
    assert.equal(h.getFetchHubCount(), 1);

    const cachePath = join(dir, 'plugins', 'miot', 'hub-cache.json');
    const cacheStat = await stat(cachePath);
    assert.equal(cacheStat.mode & 0o777, 0o600);

    // Within 15s TTL -> served from cache
    h.advanceTime(5_000);
    const second = await runAction('devices', { live: false }, h.deps);
    assert.equal(second.data.source, 'cache');
    assert.equal(second.data.ageMs, 5_000);
    assert.equal(h.getFetchHubCount(), 1);

    // refresh: true bypasses cache
    const refreshed = await runAction('devices', { refresh: true, live: false }, h.deps);
    assert.equal(refreshed.data.source, 'hub');
    assert.equal(h.getFetchHubCount(), 2);

    // Expired TTL + hub SSH failure -> falls back to stale cache
    h.advanceTime(30_000);
    h.deps.fetchHubRawRows = async () => {
      throw new Error('SSH connection timed out');
    };
    const stale = await runAction('devices', { live: false }, h.deps);
    assert.equal(stale.ok, true);
    assert.equal(stale.data.source, 'stale');
    assert.match(stale.data.staleReason, /SSH connection timed out/);
    assertNoTokenLeak(stale, 'devices (stale)');
  });
});

test('14. devices with live:true performs batch BLE Mesh get_properties RPC and Air Fryer UDP query', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({
      dir,
      bleProps: { '110022001': true, '110022002': false, '110022003': true },
      fryerReadQueue: [{ '2.1': 4, '2.4': 200, '2.3': 15, '2.5': 9, '3.1': 'M1', '3.2': '薯条' }],
    });

    const res = await runAction('devices', { live: true }, h.deps);
    assert.equal(res.ok, true);
    assert.equal(res.data.live, true);
    assert.equal(h.sshBinCalls.length, 1);
    assert.equal(h.sshBinCalls[0]!.decoded.payload.method, 'get_properties');
    assert.equal(h.sshBinCalls[0]!.decoded.payload.params.length, 3);
    assert.equal(h.udpCalls.length, 1);
    assert.equal(h.udpCalls[0]!.method, 'get_properties');
    assert.equal(h.udpCalls[0]!.params.length, 12);

    const bedLight = res.data.devices.find((d: any) => d.did === '110022003');
    assert.deepEqual(bedLight.state, { on: true, source: 'live' });
    const fryer = res.data.devices.find((d: any) => d.did === '881122334');
    assert.equal(fryer.fryer.statusText, '烹饪中');
    assert.equal(fryer.fryer.targetTempC, 200);
    assertNoTokenLeak(res, 'devices (live)');
  });
});

test('15. status action probes router central_service PID and speaker mibrain, and reports failure when router unreachable', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({ dir });
    await runAction('devices', { live: false }, h.deps);

    const st = await runAction('status', {}, h.deps);
    assert.equal(st.ok, true);
    assert.equal(st.data.router.reachable, true);
    assert.equal(st.data.router.centralServicePid, '4321');
    assert.equal(st.data.speaker.reachable, true);
    assert.equal(st.data.speaker.mibrain, true);
    assert.equal(st.data.cache.exists, true);
    assert.equal(st.data.cache.deviceCount, 10);
    assertNoTokenLeak(st, 'status');

    const hDown = createMockHarness({ dir, routerReachable: false });
    const stDown = await runAction('status', {}, hDown.deps);
    assert.equal(stDown.ok, false);
    assert.equal(stDown.title, '米家中枢不可达');
  });
});

test('16. config action persists 0600 config.json in PLUGIN_DATA_DIR and validates SSH targets & numeric bounds', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({ dir });

    const cfgRes = await runAction(
      'config',
      { routerSsh: 'hub=root@192.0.2.1:22', speakerSsh: 'lx06=root@192.0.2.104', cacheTtlMs: 20_000, udpTimeoutMs: 4_000 },
      h.deps,
    );
    assert.equal(cfgRes.ok, true);
    assert.equal(cfgRes.data.config.cacheTtlMs, 20_000);
    assert.equal(cfgRes.data.config.udpTimeoutMs, 4_000);
    const cfgStat = await stat(join(dir, 'plugins', 'miot', 'config.json'));
    assert.equal(cfgStat.mode & 0o777, 0o600);
    assertNoTokenLeak(cfgRes, 'config');

    const badCfg = await runAction('config', { routerSsh: 'invalid-target-without-at' }, h.deps);
    assert.equal(badCfg.ok, false);
  });
});

test('17. sanitizeOutput strips secret keys and masks any 32-hex string anywhere in nested objects/arrays/strings', () => {
  const dirty = {
    token: TOKENS.fryer,
    tokenByDid: { a: TOKENS.lx06 },
    bind_key: TOKENS.fish,
    nested: {
      msg: `leaked ${TOKENS.bedroomLight} in string`,
      arr: [`another ${TOKENS.oh2p} here`],
      buf: Buffer.from('abc'),
    },
  };
  const cleaned = sanitizeOutput(dirty) as any;
  assert.equal('token' in cleaned, false);
  assert.equal('tokenByDid' in cleaned, false);
  assert.equal('bind_key' in cleaned, false);
  assert.equal(cleaned.nested.msg, 'leaked [redacted] in string');
  assert.deepEqual(cleaned.nested.arr, ['another [redacted] here']);
  assert.equal(cleaned.nested.buf, '[buffer 3B]');
  assertNoTokenLeak(cleaned, 'sanitizeOutput');
});

// ---------------------------------------------------------------------------
// 7. BLE Mesh get, set (on: true/false), toggle: true, dryRun: true
// ---------------------------------------------------------------------------

test('18. BLE Mesh get and set (on: true/false and generic siid/piid/value) on 卧室灯 & 水草补光灯, including offline fallback', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({ dir, bleProps: { '110022003': false, '110022001': true } });

    const g1 = await runAction('get', { device: '卧室灯' }, h.deps);
    assert.equal(g1.ok, true);
    assert.equal(g1.data.on, false);
    assert.equal(g1.data.live, true);
    assert.match(g1.message, /卧室灯：已关闭/);
    assertNoTokenLeak(g1, 'ble get');

    const s1 = await runAction('set', { device: '卧室灯', on: true }, h.deps);
    assert.equal(s1.ok, true);
    assert.equal(s1.data.on, true);
    assert.equal(h.bleState['110022003'], true);
    assert.deepEqual(h.sshBinCalls.at(-1)!.decoded.payload.params, [{ did: '110022003', siid: 2, piid: 1, value: true }]);
    assertNoTokenLeak(s1, 'ble set on');

    // Generic siid/piid/value write on BLE Mesh
    const sGen = await runAction('set', { device: '水草补光灯', siid: 2, piid: 2, value: 1 }, h.deps);
    assert.equal(sGen.ok, true);
    assert.deepEqual(h.sshBinCalls.at(-1)!.decoded.payload.params, [{ did: '110022001', siid: 2, piid: 2, value: 1 }]);

    // Offline BLE device returns code=-4004 and surfaces cached state in message
    h.bleState['110022001'] = undefined;
    const gOffline = await runAction('get', { device: '水草补光灯' }, h.deps);
    assert.equal(gOffline.ok, false);
    assert.match(gOffline.message, /中枢缓存显示开/);
  });
});

test('19. BLE Mesh toggle:true reads live 2.1 first then writes !current, and dryRun:true makes zero SSH/UDP calls', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({ dir, bleProps: { '110022001': true, '110022003': false } });

    const callsBeforeToggle = h.sshBinCalls.length;
    const tog = await runAction('set', { device: '水草补光灯', toggle: true }, h.deps);
    assert.equal(tog.ok, true);
    assert.equal(tog.data.previous, true);
    assert.equal(tog.data.on, false);
    assert.equal(h.bleState['110022001'], false);
    assert.equal(h.sshBinCalls.length - callsBeforeToggle, 2);
    assert.equal(h.sshBinCalls[callsBeforeToggle]!.decoded.payload.method, 'get_properties');
    assert.equal(h.sshBinCalls[callsBeforeToggle + 1]!.decoded.payload.method, 'set_properties');
    assert.deepEqual(h.sshBinCalls[callsBeforeToggle + 1]!.decoded.payload.params, [
      { did: '110022001', siid: 2, piid: 1, value: false },
    ]);

    const callsBeforeDry = h.sshBinCalls.length;
    const dry = await runAction('set', { device: '卧室灯', on: false, dryRun: true }, h.deps);
    assert.equal(dry.ok, true);
    assert.equal(dry.data.dryRun, true);
    assert.equal(dry.data.transport, 'bt_mesh');
    assert.equal(h.sshBinCalls.length, callsBeforeDry);
    assert.equal(h.udpCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 8. Air Fryer (careli.fryer.maf01)
// ---------------------------------------------------------------------------

test('20. Air Fryer buildFryerGetParams has 12 properties without siid:1, and get decodes FRYER_STATUS_MAP & turnPot', async () => {
  const params = buildFryerGetParams('881122334');
  assert.equal(params.length, 12);
  assert.equal(params.some((p: any) => p.siid === 1), false, 'MUST NOT contain siid: 1');

  await withTmp(async dir => {
    const h = createMockHarness({
      dir,
      fryerReadQueue: [
        {
          '2.1': 4, // 烹饪中
          '2.2': 0,
          '2.3': 18,
          '2.4': 185,
          '2.5': 11,
          '3.1': 'M2',
          '3.2': '\\u9e21\\u7fc5', // 鸡翅
          '3.5': 0,
          '3.6': 3,
          '3.7': 2,
          '3.8': 0,
          '3.10': 2,
        },
      ],
    });

    const g = await runAction('get', { device: '空气炸锅' }, h.deps);
    assert.equal(g.ok, true);
    assert.equal(g.data.fryer.statusCode, 4);
    assert.equal(g.data.fryer.statusText, '烹饪中');
    assert.equal(g.data.fryer.targetTempC, 185);
    assert.equal(g.data.fryer.targetTimeMin, 18);
    assert.equal(g.data.fryer.leftTimeMin, 11);
    assert.equal(g.data.fryer.recipeId, 'M2');
    assert.equal(g.data.fryer.recipeName, '鸡翅');
    assert.equal(g.data.fryer.turnPot, 2);
    assertNoTokenLeak(g, 'fryer get');
  });
});

test('21. Air Fryer cook start ignites via action(3,1) start-custom-cook with 7 inputs, clamps temp/minutes, resolves PRESET_RECIPES, and verifies readback', async () => {
  assert.equal(resolveRecipe('薯条')?.id, 'M1');
  assert.equal(resolveRecipe('鸡翅')?.id, 'M2');
  assert.equal(resolveRecipe('红薯')?.id, 'M3');
  assert.equal(resolveRecipe('蛋挞')?.id, 'M4');
  assert.equal(resolveRecipe('解冻')?.id, 'M5');
  assert.equal(resolveRecipe('果干')?.id, 'M6');
  assert.equal(resolveRecipe('M7')?.name, '酸奶');
  assert.equal(resolveRecipe('M0')?.name, '手动模式');
  assert.equal(resolveRecipe('未知黑暗料理'), undefined);

  await withTmp(async dir => {
    const h = createMockHarness({
      dir,
      fryerReadQueue: [
        { '2.1': 1 },
        { '2.1': 4, '2.4': 200, '2.3': 1, '2.5': 1, '3.1': 'M1', '3.2': '薯条' },
      ],
    });

    const start = await runAction(
      'cook',
      { op: 'start', recipe: '薯条', tempC: 250, minutes: 0, preheat: true, appointMinutes: 10, foodQuantity: 2 },
      h.deps,
    );
    assert.equal(start.ok, true);
    assert.equal(start.data.tempC, 200);
    assert.equal(start.data.minutes, 1);
    assert.equal(start.data.clamped, true);
    assert.equal(start.data.after.statusCode, 4);
    assert.equal(start.data.after.statusText, '烹饪中');
    assert.deepEqual(h.sleeps, [220]);

    assert.equal(h.udpCalls.length, 3);
    const actionCall = h.udpCalls[1]!;
    assert.equal(actionCall.method, 'action');
    assert.equal(actionCall.params.siid, 3);
    assert.equal(actionCall.params.aiid, 1);
    assert.deepEqual(actionCall.params.in, [
      { piid: 1, value: 'M1' },
      { piid: 2, value: '薯条' },
      { piid: 3, value: 1 },
      { piid: 4, value: 200 },
      { piid: 5, value: 10 },
      { piid: 6, value: 2 },
      { piid: 7, value: 2 },
    ]);
    assertNoTokenLeak(start, 'fryer cook start');
  });
});

test('22. Air Fryer cook start blocks on statusCode===9 (抽锅暂停 safety interlock) and fails if readback is not in {3,4,5}', async () => {
  await withTmp(async dir => {
    const hPotOut = createMockHarness({
      dir,
      fryerReadQueue: [{ '2.1': 9 }],
    });
    const blocked = await runAction('cook', { op: 'start', recipe: '鸡翅' }, hPotOut.deps);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.title, '空气炸锅抽锅暂停');
    assert.match(blocked.message, /物理互锁/);
    assert.equal(hPotOut.udpCalls.length, 1, 'must only read status and never send action(3,1)');

    const hNoHeat = createMockHarness({
      dir,
      fryerReadQueue: [{ '2.1': 1 }, { '2.1': 1 }],
    });
    const noHeat = await runAction('cook', { op: 'start', recipe: '蛋挞' }, hNoHeat.deps);
    assert.equal(noHeat.ok, false);
    assert.equal(noHeat.title, '空气炸锅未进入烹饪');
  });
});

test('23. Air Fryer cook pause/resume/stop/cancel map to action(2,3), action(3,2), action(2,2) and dryRun sends no UDP packets', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({
      dir,
      fryerReadQueue: [{ '2.1': 2 }, { '2.1': 4 }, { '2.1': 1 }, { '2.1': 1 }],
    });

    const dry = await runAction('cook', { op: 'start', recipe: '蛋挞', dryRun: true }, h.deps);
    assert.equal(dry.ok, true);
    assert.equal(dry.data.dryRun, true);
    assert.equal(dry.data.plan.params.siid, 3);
    assert.equal(dry.data.plan.params.aiid, 1);
    assert.equal(h.udpCalls.length, 0);

    const pause = await runAction('cook', { op: 'pause' }, h.deps);
    assert.equal(pause.ok, true);
    assert.deepEqual(h.udpCalls[0]!.params, { did: '881122334', siid: 2, aiid: 3, in: [] });

    const resume = await runAction('cook', { op: 'resume' }, h.deps);
    assert.equal(resume.ok, true);
    assert.deepEqual(h.udpCalls[2]!.params, { did: '881122334', siid: 3, aiid: 2, in: [] });

    const cancel = await runAction('cook', { op: 'cancel' }, h.deps);
    assert.equal(cancel.ok, true);
    assert.equal(cancel.data.op, 'stop');
    assert.deepEqual(h.udpCalls[4]!.params, { did: '881122334', siid: 2, aiid: 2, in: [] });

    // set on:false on air fryer delegates to cook stop
    const setOff = await runAction('set', { device: '空气炸锅', on: false }, h.deps);
    assert.equal(setOff.ok, true);
    assert.equal(setOff.data.op, 'stop');
  });
});

// ---------------------------------------------------------------------------
// 9. IR & Cross-Plugin Control (AC, TV, command, action, discoverSpeakerSsh)
// ---------------------------------------------------------------------------

test('24. IR AC set builds room-prefixed Chinese instructions and invokes silent/spoken mibrain ai_service over SSH', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({ dir });

    const acSet = await runAction(
      'set',
      { device: '卧室空调', on: true, temperature: 26, mode: 'cool', fanSpeed: 'low' },
      h.deps,
    );
    assert.equal(acSet.ok, true);
    assert.equal(acSet.data.transport, 'xiaoai_nlp');
    assert.equal(acSet.data.sent.length, 4);
    assert.deepEqual(
      acSet.data.sent.map((s: any) => s.text),
      ['打开卧室空调', '把卧室空调调到26度', '卧室空调设为制冷模式', '把卧室空调风速调到低档'],
    );
    assert.equal(h.sshTextCalls.length, 4);
    assert.match(h.sshTextCalls[0]!.cmd, /"nlp_text":"打开卧室空调","tts":0,"tts_play":0/);

    const spoken = await runAction('set', { device: '客厅空调', on: false, speakReply: true }, h.deps);
    assert.equal(spoken.ok, true);
    assert.match(h.sshTextCalls.at(-1)!.cmd, /"nlp_text":"关闭客厅空调","tts":1,"tts_play":1/);
    assertNoTokenLeak(acSet, 'ir ac set');
  });
});

test('25. IR AC rejects toggle:true, disambiguates bare "空调" with 设备指代不明, and explains virtual IR status on get', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({ dir });

    const amb = await runAction('set', { device: '空调', on: true }, h.deps);
    assert.equal(amb.ok, false);
    assert.equal(amb.title, '设备指代不明');
    assert.equal(amb.data.needsClarification, true);
    assert.equal(amb.data.candidates.length, 2);
    assert.equal(h.sshTextCalls.length, 0);

    const tog = await runAction('set', { device: '卧室空调', toggle: true }, h.deps);
    assert.equal(tog.ok, false);
    assert.match(tog.message, /不支持 toggle/);

    const acGet = await runAction('get', { device: '卧室空调' }, h.deps);
    assert.equal(acGet.ok, true);
    assert.equal(acGet.data.note, 'ir_virtual_device');
  });
});

test('26. TV get & set delegate to tvAgentRunner for status and power (on/off/toggle) and support dryRun', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({ dir });

    const tvDry = await runAction('set', { device: '电视', on: true, dryRun: true }, h.deps);
    assert.equal(tvDry.ok, true);
    assert.equal(tvDry.data.dryRun, true);
    assert.equal(h.tvCalls.length, 0);

    const tvOn = await runAction('set', { device: '电视', on: true }, h.deps);
    assert.equal(tvOn.ok, true);
    assert.equal(tvOn.data.transport, 'tv_agent');
    assert.equal(tvOn.data.state, 'on');

    const tvOff = await runAction('set', { device: '电视', on: false }, h.deps);
    assert.equal(tvOff.ok, true);
    assert.equal(tvOff.data.state, 'off');

    const tvTog = await runAction('set', { device: '电视', toggle: true }, h.deps);
    assert.equal(tvTog.ok, true);
    assert.equal(tvTog.data.state, 'toggle');

    const tvGet = await runAction('get', { device: '电视' }, h.deps);
    assert.equal(tvGet.ok, true);
    assert.equal(tvGet.data.tv.powerState, 'online');
    assert.equal(tvGet.data.tv.apps, undefined);

    assert.deepEqual(h.tvCalls, [
      { action: 'power', args: { state: 'on' } },
      { action: 'power', args: { state: 'off' } },
      { action: 'power', args: { state: 'toggle' } },
      { action: 'status', args: {} },
    ]);
  });
});

test('27. command & low-level action route to LX06 ai_service, BLE Mesh, and MiIO UDP with dryRun and fryer (2,1) warning', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({ dir });

    const cmdDry = await runAction('command', { text: '查询今天天气', dryRun: true }, h.deps);
    assert.equal(cmdDry.ok, true);
    assert.equal(cmdDry.data.dryRun, true);
    assert.equal(h.sshTextCalls.length, 0);

    const cmdLive = await runAction('command', { text: '打开客厅空调', speakReply: false }, h.deps);
    assert.equal(cmdLive.ok, true);
    assert.equal(h.sshTextCalls.length, 1);
    assert.match(h.sshTextCalls[0]!.cmd, /打开客厅空调/);

    const cmdEmpty = await runAction('command', { text: '   ' }, h.deps);
    assert.equal(cmdEmpty.ok, false);

    const actDryFryer = await runAction('action', { device: '空气炸锅', siid: 2, aiid: 1, dryRun: true }, h.deps);
    assert.equal(actDryFryer.ok, true);
    assert.match(actDryFryer.data.warning, /action\(3,1\)/);

    const actBle = await runAction('action', { device: '卧室灯', siid: 2, aiid: 1, in: [] }, h.deps);
    assert.equal(actBle.ok, true);
    assert.equal(h.sshBinCalls.at(-1)!.decoded.payload.method, 'action');

    const actUdp = await runAction('action', { device: '空气炸锅', siid: 2, aiid: 3, in: [] }, h.deps);
    assert.equal(actUdp.ok, true);
    assert.equal(h.udpCalls.at(-1)!.method, 'action');
  });
});

test('28. discoverSpeakerSsh follows priority: args -> config.json -> state.sqlite (preferring enabled lx06) -> rejects unconfigured', async () => {
  await withTmp(async dir => {
    const dataDir = join(dir, 'plugins', 'miot');

    await assert.rejects(() => discoverSpeakerSsh({ homeDir: dir, dataDir }), /未找到小爱音箱/);

    const dbPath = join(dir, 'state.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE im_channels (
        id TEXT PRIMARY KEY,
        platform TEXT,
        body TEXT,
        updated_at INTEGER
      );
    `);
    const ins = db.prepare('INSERT INTO im_channels (id, platform, body, updated_at) VALUES (?, ?, ?, ?)');
    ins.run(
      'xiaoai-bedroom',
      'xiaoai',
      JSON.stringify({ enabled: true, apiBase: 'oh2p=root@192.0.2.155,lx06=root@192.0.2.199:2222' }),
      100,
    );
    db.close();

    const fromSqlite = await discoverSpeakerSsh({ homeDir: dir, dataDir });
    assert.equal(fromSqlite.source, 'sqlite');
    assert.equal(fromSqlite.id, 'lx06');
    assert.equal(fromSqlite.userHost, 'root@192.0.2.199');
    assert.equal(fromSqlite.port, 2222);

    await runAction('config', { speakerSsh: 'cfgspk=root@192.0.2.188:2022' }, { homeDir: dir, dataDir });
    const fromCfg = await discoverSpeakerSsh({ homeDir: dir, dataDir });
    assert.deepEqual(fromCfg, { id: 'cfgspk', userHost: 'root@192.0.2.188', port: 2022, source: 'config' });

    const fromArg = await discoverSpeakerSsh({ speakerSsh: 'argspk=root@192.0.2.177', homeDir: dir, dataDir });
    assert.deepEqual(fromArg, { id: 'argspk', userHost: 'root@192.0.2.177', source: 'args' });
  });
});

test('29. defaultFetchHubRawRows unpacks streamed tar of devInfo.db + hot_data_v2.db and reads SQLite tables', async () => {
  await withTmp(async dir => {
    const devDir = join(dir, 'share', 'custom', 'devInfo');
    const hotDir = join(dir, 'local', 'hotdatasync');
    await mkdir(devDir, { recursive: true });
    await mkdir(hotDir, { recursive: true });

    const devDb = new DatabaseSync(join(devDir, 'devInfo.db'));
    devDb.exec('CREATE TABLE device_v4 (did TEXT, dev_name TEXT, token TEXT, connect_type TEXT, model TEXT, urn TEXT, room_name TEXT, online TEXT)');
    devDb.prepare('INSERT INTO device_v4 VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      q('110022003'),
      q('卧室灯'),
      q(TOKENS.bedroomLight),
      q(16),
      q('isa.switch.kg01hl'),
      q('urn:miot-spec-v2:device:switch:0000A003:isa-kg01hl:1'),
      q('卧室'),
      q(true),
    );
    devDb.close();

    const hotDb = new DatabaseSync(join(hotDir, 'hot_data_v2.db'));
    hotDb.exec('CREATE TABLE appMsg (key TEXT, value TEXT)');
    hotDb.prepare('INSERT INTO appMsg VALUES (?, ?)').run('110022003😂2.1', JSON.stringify({ value: true, ts: 123 }));
    hotDb.close();

    const tarBuf = execFileSync('tar', ['-C', dir, '-cf', '-', 'share/custom/devInfo', 'local/hotdatasync']);
    const rows = await defaultFetchHubRawRows({
      target: { id: 'router', userHost: 'root@192.0.2.1' },
      sshBinaryExec: async () => ({ stdout: tarBuf, stderr: '', code: 0 }),
    });
    assert.equal(rows.devInfoRows.length, 1);
    assert.equal(rows.hotDataRows.length, 1);
    const snap = parseHubSnapshot(rows);
    assert.equal(snap.devices[0]!.did, '110022003');
    assert.equal(snap.tokenByDid['110022003'], TOKENS.bedroomLight);
    assertNoTokenLeak(snap.devices, 'defaultFetchHubRawRows devices');
  });
});

// ---------------------------------------------------------------------------
// 10. Host Integration (listPlugins + runPlugin via src/plugin.ts)
// ---------------------------------------------------------------------------

test('30. Host listPlugins & runPlugin discover miot, work with env stripping, and never leak tokens', async () => {
  await withTmp(async home => {
    const plugins = await listPlugins(home);
    const miot = plugins.find(p => p.name === 'miot');
    assert.ok(miot, 'miot plugin must be discovered by listPlugins');
    assert.deepEqual(miot.actions, ACTIONS);
    assert.equal(miot.actionSpecs!.length, ACTIONS.length);

    const snap = parseHubSnapshot({ ...createHubFixtureRows(), nowMs: Date.now() });
    const dataDir = join(home, 'plugins', 'miot');
    await runAction('config', { cacheTtlMs: 3_600_000 }, { homeDir: home, dataDir });
    await writeFile(join(dataDir, 'hub-cache.json'), JSON.stringify({ version: 1, ...snap }, null, 2), { mode: 0o600 });

    const prevApiKey = process.env.SUPER_AGENT_API_KEY;
    const prevToken = process.env.SUPER_AGENT_SECRET_TOKEN;
    process.env.SUPER_AGENT_API_KEY = 'secret-parent-api-key';
    process.env.SUPER_AGENT_SECRET_TOKEN = TOKENS.fryer;
    try {
      const setRes = await runPlugin(home, 'miot', 'set', { device: '卧室灯', on: true, dryRun: true });
      assert.equal(setRes.ok, true);
      assert.equal(setRes.plugin, 'miot');
      assert.equal(setRes.action, 'set');
      assert.equal((setRes.data as any).dryRun, true);
      assertNoTokenLeak(setRes, 'runPlugin set');

      const devRes = await runPlugin(home, 'miot', 'devices', { live: false });
      assert.equal(devRes.ok, true);
      assert.equal((devRes.data as any).count, 10);
      assertNoTokenLeak(devRes, 'runPlugin devices');

      const cookRes = await runPlugin(home, 'miot', 'cook', { op: 'start', recipe: '薯条', dryRun: true });
      assert.equal(cookRes.ok, true);
      assert.equal((cookRes.data as any).plan.params.siid, 3);
      assert.equal((cookRes.data as any).plan.params.aiid, 1);
      assertNoTokenLeak(cookRes, 'runPlugin cook');
    } finally {
      if (prevApiKey === undefined) delete process.env.SUPER_AGENT_API_KEY;
      else process.env.SUPER_AGENT_API_KEY = prevApiKey;
      if (prevToken === undefined) delete process.env.SUPER_AGENT_SECRET_TOKEN;
      else process.env.SUPER_AGENT_SECRET_TOKEN = prevToken;
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Turbo Optimizations: topologyTtlMs, Auto-Refresh, ASR Aliases, Fast Polling, In-Process Runner
// ---------------------------------------------------------------------------

test('31. topologyTtlMs (600_000ms) skips SSH on repeated set/cook >15s apart while devices honours cacheTtlMs (hotDataFetchedAt vs fetchedAt)', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({ dir });
    const fetchCalls: Array<{ includeHotData?: boolean }> = [];
    h.deps.fetchHubRawRows = async (opts: any = {}) => {
      fetchCalls.push({ includeHotData: opts.includeHotData });
      const rows = createHubFixtureRows();
      return {
        devInfoRows: rows.devInfoRows,
        hotDataRows: opts.includeHotData === false ? [] : rows.hotDataRows,
      };
    };

    assert.equal(DEFAULT_CONFIG.topologyTtlMs, 600_000);

    // 1. Initial devices call (t = 0) fetches both devInfo and hotData
    const dev1 = await runAction('devices', { live: false }, h.deps);
    assert.equal(dev1.ok, true);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]!.includeHotData, true);

    // 2. Advance 30s (> 15s cacheTtlMs, < 600s topologyTtlMs): set and cook skip SSH completely!
    h.advanceTime(30_000);
    const set1 = await runAction('set', { device: '卧室灯', on: true }, h.deps);
    assert.equal(set1.ok, true);
    assert.equal(fetchCalls.length, 1, 'set after 30s must use topology cache (0 hub SSH calls)');

    h.advanceTime(45_000); // now at t = 75s
    const cook1 = await runAction('cook', { op: 'status' }, h.deps);
    assert.equal(cook1.ok, true);
    assert.equal(fetchCalls.length, 1, 'cook after 75s must use topology cache (0 hub SSH calls)');

    // 3. Advance past 600s topologyTtlMs (t = 610s): set fetches devInfo ONLY (includeHotData: false)
    // and preserves previously cached BLE state properties
    h.advanceTime(535_000); // now at t = 610_000
    const set2 = await runAction('set', { device: '卧室灯', on: false }, h.deps);
    assert.equal(set2.ok, true);
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[1]!.includeHotData, false);

    const cacheAfterTopoOnly = JSON.parse(await readFile(join(dir, 'plugins', 'miot', 'hub-cache.json'), 'utf8'));
    assert.equal(cacheAfterTopoOnly.fetchedAt, 1_700_000_610_000);
    assert.equal(cacheAfterTopoOnly.hotDataFetchedAt, 1_700_000_000_000);
    const fishCached = cacheAfterTopoOnly.devices.find((d: any) => d.did === '110022001');
    assert.deepEqual(fishCached.cachedState.properties['2.1'], { value: true, ts: 1700000100 });

    // 4. Calling devices 1s later (t = 611s) sees hotDataFetchedAt is >15s old and fetches includeHotData: true
    h.advanceTime(1_000);
    const dev2 = await runAction('devices', { live: false }, h.deps);
    assert.equal(dev2.ok, true);
    assert.equal(fetchCalls.length, 3);
    assert.equal(fetchCalls[2]!.includeHotData, true);
  });
});

test('32. Auto-refresh on DEVICE_NOT_FOUND and miioCall UDP failure when snapshot came from cache (ageMs > 5_000)', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({ dir });
    let includeNewDevice = false;
    let fryerIp = '192.0.2.216';
    h.deps.fetchHubRawRows = async () => {
      const rows = createHubFixtureRows();
      const fryerRow = rows.devInfoRows.find(r => r.did === q('881122334'));
      if (fryerRow) fryerRow.ip = q(fryerIp);
      if (includeNewDevice) {
        rows.devInfoRows.push({
          did: q('110022999'),
          uid: q('100001'),
          token: q(TOKENS.bedroomLight),
          dev_name: q('书房台灯'),
          model: q('isa.switch.kg01hl'),
          model_name: q('米家智能开关'),
          urn: q('urn:miot-spec-v2:device:light:0000A001:isa-kg01hl:1'),
          ip: q(''),
          connect_type: q(16),
          online: q(true),
          homeid: q('778899001122'),
          roomid: q('r_study'),
          room_name: q('书房'),
          parent: q('miwifi.be6500pro'),
          fw_ver: q('2.1.0'),
        });
      }
      return rows;
    };

    // Prime cache at t = 0 without 书房台灯
    await runAction('set', { device: '卧室灯', on: true }, h.deps);

    // Advance 10s (> 5_000ms), add 书房台灯 on hub, and control it without explicit refresh:true
    h.advanceTime(10_000);
    includeNewDevice = true;
    const resNew = await runAction('set', { device: '书房台灯', on: true }, h.deps);
    assert.equal(resNew.ok, true);
    assert.equal(resNew.data.device.did, '110022999');

    // Advance another 10s, simulate fryer DHCP IP change (old cached IP 192.0.2.216 times out, new IP 192.0.2.219 works)
    h.advanceTime(10_000);
    fryerIp = '192.0.2.219';
    const origUdp = h.deps.udpCall;
    h.deps.udpCall = async (call: any) => {
      if (call.ip === '192.0.2.216') {
        throw new Error('UDP timeout on old IP');
      }
      return origUdp(call);
    };
    const cookStatus = await runAction('cook', { op: 'status' }, h.deps);
    assert.equal(cookStatus.ok, true);
    assert.equal(h.udpCalls.at(-1)!.ip, '192.0.2.219');
  });
});

test('33. ASR homophone aliases ("空气炸播", "空气炸国", "空炸", "炸播", "空气炸锅机") resolve to air_fryer', () => {
  const { devices } = parseHubSnapshot(createHubFixtureRows());
  for (const alias of ['空气炸播', '空气炸国', '空炸', '炸播', '空气炸锅机', '厨房空气炸播']) {
    const resolved = resolveDevice(devices, { device: alias });
    assert.equal(resolved.did, '881122334', `alias "${alias}" must resolve to air_fryer`);
    assert.equal(resolved.category, 'air_fryer');
  }
});

test('34. Fast fryer polling breaks after single 220ms sleep when statusCode:4 on poll 1, and retries [220, 320, 460] when poll 1-2 report statusCode:1', async () => {
  await withTmp(async dir => {
    // Case A: Poll 1 already reports statusCode: 4 -> single 220ms sleep
    const hFast = createMockHarness({
      dir,
      fryerReadQueue: [
        { '2.1': 1 }, // before
        { '2.1': 4, '2.4': 200, '2.3': 5, '2.5': 5 }, // poll 1 -> breaks immediately
      ],
    });
    const resFast = await runAction('cook', { device: '空气炸播', op: 'start', tempC: 200, minutes: 5 }, hFast.deps);
    assert.equal(resFast.ok, true);
    assert.deepEqual(hFast.sleeps, [220]);

    // Case B: Poll 1 and Poll 2 report statusCode: 1, Poll 3 reports statusCode: 4 -> sleeps [220, 320, 460]
    const hSlow = createMockHarness({
      dir,
      fryerReadQueue: [
        { '2.1': 1 }, // before
        { '2.1': 1 }, // poll 1 (220ms)
        { '2.1': 1 }, // poll 2 (320ms)
        { '2.1': 4, '2.4': 180, '2.3': 10, '2.5': 10 }, // poll 3 (460ms) -> succeeds
      ],
    });
    const resSlow = await runAction('cook', { op: 'start', tempC: 180, minutes: 10 }, hSlow.deps);
    assert.equal(resSlow.ok, true);
    assert.equal(resSlow.data.after.statusCode, 4);
    assert.deepEqual(hSlow.sleeps, [220, 320, 460]);

    // Case C: Stop polls [180, 260] when poll 1 is still cooking (4) and poll 2 is standby (1)
    const hStop = createMockHarness({
      dir,
      fryerReadQueue: [
        { '2.1': 4 }, // poll 1 (180ms) still cooking
        { '2.1': 1 }, // poll 2 (260ms) standby -> breaks
      ],
    });
    const resStop = await runAction('cook', { op: 'stop' }, hStop.deps);
    assert.equal(resStop.ok, true);
    assert.equal(resStop.data.after.statusCode, 1);
    assert.deepEqual(hStop.sleeps, [180, 260]);
  });
});

test('35. runPluginInProcess & runPlugin execute miot in-process without child_process cold start', async () => {
  await withTmp(async home => {
    const snap = parseHubSnapshot({ ...createHubFixtureRows(), nowMs: Date.now() });
    const dataDir = join(home, 'plugins', 'miot');
    await runAction('config', { cacheTtlMs: 3_600_000, topologyTtlMs: 600_000 }, { homeDir: home, dataDir });
    await writeFile(join(dataDir, 'hub-cache.json'), JSON.stringify({ version: 1, ...snap }, null, 2), { mode: 0o600 });

    const t0 = Date.now();
    const inProc = await runPluginInProcess(home, 'miot', 'cook', { device: '空气炸播', op: 'start', tempC: 200, minutes: 5, dryRun: true });
    const elapsedMs = Date.now() - t0;
    assert.equal(inProc.ok, true);
    assert.equal(inProc.plugin, 'miot');
    assert.equal(inProc.action, 'cook');
    assert.equal((inProc.data as any).tempC, 200);
    assert.equal((inProc.data as any).minutes, 5);
    assert.ok(elapsedMs < 100, `in-process execution should be fast (<100ms), got ${elapsedMs}ms`);
    assertNoTokenLeak(inProc, 'runPluginInProcess');

    const viaRunPlugin = await runPlugin(home, 'miot', 'set', { device: '水草补光灯', on: true, dryRun: true });
    assert.equal(viaRunPlugin.ok, true);
    assert.equal((viaRunPlugin.data as any).device.did, '110022001');
    assertNoTokenLeak(viaRunPlugin, 'runPlugin in-process');
  });
});

test('36. DEFAULT_CONFIG is neutral/empty, buildAcInstructions supports 16..31°C consistently, and TV delegates via callPlugin("tv-agent")', async () => {
  assert.equal(DEFAULT_CONFIG.routerSsh, '');
  assert.equal(DEFAULT_CONFIG.speakerSsh, '');
  assert.deepEqual(DEFAULT_CONFIG.protectedDevices, []);
  assert.deepEqual(DEFAULT_CONFIG.customAliases, {});

  assert.deepEqual(
    buildAcInstructions({ name: '空调', room_name: '卧室' }, { temperature: 31 }),
    ['把卧室空调调到31度'],
  );
  assert.deepEqual(
    buildAcInstructions({ name: '空调', room_name: '卧室' }, { temperature: 32 }),
    ['把卧室空调调到31度'],
  );
  assert.throws(
    () => buildAcInstructions({ name: '空调', room_name: '卧室' }, { temperature: 'abc' }),
    /16-31/,
  );

  await withTmp(async dir => {
    const h = createMockHarness({ dir });
    const tvCalls: Array<{ plugin: string; action: string; args: Record<string, unknown> }> = [];
    const depsWithCallPlugin = {
      ...h.deps,
      tvAgentRunner: undefined,
      callPlugin: async (plugin: string, action: string, args: Record<string, unknown>) => {
        tvCalls.push({ plugin, action, args });
        return { ok: true, message: '电视在线', data: { online: true } };
      },
    };
    const tvGet = await runAction('get', { device: '客厅电视' }, depsWithCallPlugin);
    assert.equal(tvGet.ok, true);
    assert.deepEqual(tvCalls[0], { plugin: 'tv-agent', action: 'status', args: {} });
  });
});

test('37. handleVoiceFastpath executes AC (16..31°C), fryer, switches, enforces protectedDevices, and yields for TV commands', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({ dir, bleProps: { '110022003': false } });
    const ctx = {
      pluginDataDir: join(dir, 'plugins', 'miot'),
      ...h.deps,
    };

    const ac31 = await handleVoiceFastpath({ text: '把卧室空调调到31度' }, ctx);
    assert.equal(ac31.handled, true);
    assert.equal((ac31.data as any)?.ok, true);

    const ac32 = await handleVoiceFastpath({ text: '把卧室空调调到32度' }, ctx);
    assert.equal(ac32.handled, true);
    assert.equal((ac32.data as any)?.ok, false);
    assert.match(ac32.speech || '', /16 到 31 度/);

    const fryerStatus = await handleVoiceFastpath({ text: '空气炸锅状态怎么样' }, ctx);
    assert.equal(fryerStatus.handled, true);
    assert.match(fryerStatus.speech || '', /空气炸锅：待机/);

    const lightOn = await handleVoiceFastpath({ text: '打开卧室灯' }, ctx);
    assert.equal(lightOn.handled, true);
    assert.equal(h.bleState['110022003'], true);

    // Configure protectedDevices -> blocks voice power off
    await runAction('config', { protectedDevices: ['水草补光灯'] }, h.deps);
    const sshCountBefore = h.sshBinCalls.length;
    const blocked = await handleVoiceFastpath({ text: '关掉水草补光灯' }, ctx);
    assert.equal(blocked.handled, true);
    assert.equal((blocked.data as any)?.blocked, true);
    assert.equal((blocked.data as any)?.reason, 'protected_device');
    assert.equal(h.sshBinCalls.length, sshCountBefore);

    // Yields on TV commands or while TV remote continuous mode is active
    const yieldTv = await handleVoiceFastpath({ text: '打开电视' }, ctx);
    assert.equal(yieldTv.handled, false);

    const yieldRemote = await handleVoiceFastpath({
      text: '打开卧室灯',
      sessionState: { tvRemoteActive: true },
    }, ctx);
    assert.equal(yieldRemote.handled, false);

    // Yields on UI/media phrases, unknown non-device targets (using disk hub-cache without SSH), and DEVICE_NOT_FOUND
    const yieldHistory = await handleVoiceFastpath({ text: '打开历史记录。' }, { pluginDataDir: ctx.pluginDataDir });
    assert.equal(yieldHistory.handled, false);

    const yieldAppHistory = await handleVoiceFastpath({ text: '打开尹志仓的历史播放记录。' }, ctx);
    assert.equal(yieldAppHistory.handled, false);

    const yieldUnknownApp = await handleVoiceFastpath(
      { text: '打开小众播放器' },
      { pluginDataDir: ctx.pluginDataDir },
    );
    assert.equal(yieldUnknownApp.handled, false);

    const yieldMissingFan = await handleVoiceFastpath({ text: '打开不存在的卧室风扇' }, ctx);
    assert.equal(yieldMissingFan.handled, false);
  });
});

test('38. devices with live:true persists BLE Mesh on state and liveFetchedAt to hub-cache.json without clobbering fryer 2.1 or leaking tokens', async () => {
  await withTmp(async dir => {
    const h = createMockHarness({
      dir,
      bleProps: { '110022001': false, '110022002': true, '110022003': true },
      fryerReadQueue: [{ '2.1': 4, '2.4': 195, '2.3': 12 }],
    });

    const liveRes = await runAction('devices', { refresh: true, live: true }, h.deps);
    assert.equal(liveRes.ok, true);
    assert.equal(liveRes.data.liveFetchedAt, 1_700_000_000_000);

    const cachePath = join(dir, 'plugins', 'miot', 'hub-cache.json');
    const cache1 = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(cache1.liveFetchedAt, 1_700_000_000_000);
    const fish1 = cache1.devices.find((d: any) => d.did === '110022001');
    const balcony1 = cache1.devices.find((d: any) => d.did === '110022002');
    const fryer1 = cache1.devices.find((d: any) => d.did === '881122334');
    assert.equal(fish1.cachedState.properties['2.1'].value, false);
    assert.equal(fish1.cachedState.properties['2.1'].ts, 1_700_000_000_000);
    assert.equal(balcony1.cachedState.properties['2.1'].value, true);
    assert.notEqual(typeof fryer1.cachedState?.properties?.['2.1']?.value, 'boolean');
    assertNoTokenLeak(cache1, 'hub-cache after live');

    // Subsequent hub-only refresh (live: false) preserves liveFetchedAt
    h.advanceTime(60_000);
    const hubOnly = await runAction('devices', { refresh: true, live: false }, h.deps);
    assert.equal(hubOnly.ok, true);
    assert.equal(hubOnly.data.liveFetchedAt, 1_700_000_000_000);
    const cache2 = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(cache2.hotDataFetchedAt, 1_700_000_060_000);
    assert.equal(cache2.liveFetchedAt, 1_700_000_000_000);
  });
});

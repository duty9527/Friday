import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { listPluginsSync, runPlugin } from '../src/plugin.js';

const execFileAsync = promisify(execFile);

type LaifenModule = {
  DEFAULT_MAC: string;
  ACTIONS: string[];
  PRESETS: Record<string, Record<string, unknown>>;
  LaifenProtocol: {
    xorChecksum(bytes: Buffer | number[]): number;
    verifyV1Ack(hexOrBytes: Buffer | string, expectedCmd?: number): {
      valid: boolean;
      ok: boolean;
      cmd: number | null;
      statusByte: number | null;
      checksumMode: string;
    };
    buildV1ModeSettings(mode: number, strength: number, range: number, speed: number): Buffer;
    buildV1Duration(seconds: number): Buffer;
    buildV1HighFrequency(enabled: boolean): Buffer;
    buildV1Reminder30s(enabled: boolean): Buffer;
    buildV1AirplaneMode(enabled: boolean): Buffer;
    buildV1Power(on: boolean): Buffer;
    buildV1Calibration(action: string): Buffer;
    buildV2ProCommand(cmd16: number, payload?: number[]): Buffer;
    buildV2ProOverPressureCommand(enabled: boolean, level?: string): Buffer;
    parsePacket(hexOrBytes: Buffer | string, prev?: Record<string, unknown>): Record<string, unknown> | null;
  };
  runAction(action: string, args?: Record<string, unknown>, deps?: Record<string, unknown>): Promise<Record<string, unknown>>;
  handleVoiceFastpath(request: Record<string, unknown>, context?: Record<string, unknown>): Promise<Record<string, unknown>>;
};

async function loadPluginModule(): Promise<LaifenModule> {
  return await import('../plugins/laifen/index.mjs') as unknown as LaifenModule;
}

function buildV1StatusHex(opts: {
  modeIndex?: number;
  m1?: [number, number, number];
  m2?: [number, number, number];
  m3?: [number, number, number];
  m4?: [number, number, number];
  airplane?: boolean;
  battery?: number;
  reminder30s?: boolean;
  durationSec?: number;
  highFrequency?: boolean;
  running?: boolean;
} = {}): string {
  const bytes = [
    0xaa, 0x0a, 0x02, 0x17,
    opts.modeIndex ?? 2,
    ...(opts.m1 ?? [2, 4, 4]),
    ...(opts.m2 ?? [4, 6, 6]),
    ...(opts.m3 ?? [8, 9, 9]),
    ...(opts.m4 ?? [14, 6, 6]),
    opts.airplane ? 1 : 0,
    opts.battery ?? 82,
    opts.reminder30s === false ? 0 : 1,
    ((opts.durationSec ?? 180) >> 8) & 0xff,
    (opts.durationSec ?? 180) & 0xff,
    opts.highFrequency === false ? 0 : 1,
    opts.running ? 1 : 0,
    0x00, 0x00, 0x01,
  ];
  let cs = 0;
  for (const b of bytes) cs ^= b;
  return Buffer.from([...bytes, cs]).toString('hex').toUpperCase();
}

function buildV2ProStatusHex(opts: {
  battery?: number;
  durationSec?: number;
  runningCode?: number;
  deepClean?: boolean;
  antiSplash?: boolean;
  rampUp?: boolean;
  spinDry?: boolean;
  overPressure?: boolean;
  overPressureLevelBytes?: [number, number];
  bristle?: boolean;
  liftToWake?: boolean;
} = {}): string {
  const payload = new Array<number>(36).fill(0);
  payload[2] = opts.battery ?? 91;
  const dur = opts.durationSec ?? 150;
  payload[5] = dur & 0xff;
  payload[6] = (dur >> 8) & 0xff;
  payload[13] = opts.runningCode ?? 0;
  payload[15] = opts.deepClean ? 1 : 0;
  payload[16] = opts.antiSplash ? 1 : 0;
  payload[24] = opts.rampUp ? 1 : 0;
  payload[25] = opts.spinDry ? 1 : 0;
  payload[26] = opts.overPressure ? 1 : 0;
  const op = opts.overPressureLevelBytes ?? [0x01, 0x4a];
  payload[27] = op[0];
  payload[28] = op[1];
  payload[30] = opts.bristle ? 1 : 0;
  payload[32] = opts.liftToWake ? 1 : 0;
  const frame = [0x5a, 0xc1, 0x03, 0x01, 0x00, payload.length, ...payload];
  let cs = 0;
  for (const b of frame) cs ^= b;
  return Buffer.from([...frame, cs]).toString('hex').toUpperCase();
}

test('LaifenProtocol parses V1 20B/28B frames, V2 Pro status/telemetry, inverted-XOR ACKs, and builds commands', async () => {
  const { LaifenProtocol } = await loadPluginModule();

  // 1. V1 28-byte frame decode
  const v1Hex = buildV1StatusHex({
    modeIndex: 2,
    m1: [1, 4, 4],
    m2: [4, 6, 6],
    m3: [10, 10, 10],
    m4: [11, 6, 6],
    battery: 74,
    durationSec: 180,
    highFrequency: true,
    reminder30s: true,
  });
  const parsedV1 = LaifenProtocol.parsePacket(v1Hex)!;
  assert.equal(parsedV1.type, 'status');
  assert.equal(parsedV1.protocol, 'v1');
  assert.equal(parsedV1.checksumOk, true);
  assert.equal(parsedV1.activeMode, 3);
  assert.equal(parsedV1.activeStrength, 10);
  assert.equal(parsedV1.batteryPct, 74);
  assert.equal(parsedV1.durationSec, 180);
  assert.equal(parsedV1.highFrequency, true);
  assert.equal(parsedV1.reminder30s, true);

  // 2. V1 20-byte compact frame decode preserves optimistic reminder/duration
  const compactBytes = [0xaa, 0x0a, 0x02, 0x0f, 1, 2, 5, 5, 6, 7, 8, 9, 9, 9, 12, 6, 6, 0, 65];
  const compactCs = LaifenProtocol.xorChecksum(compactBytes);
  const compactParsed = LaifenProtocol.parsePacket(Buffer.from([...compactBytes, compactCs]), parsedV1)!;
  assert.equal(compactParsed.protocol, 'v1');
  assert.equal(compactParsed.activeMode, 2);
  assert.equal(compactParsed.activeStrength, 6);
  assert.equal(compactParsed.batteryPct, 65);
  assert.equal(compactParsed.durationSec, 180);

  // 3. V2 Pro 36-byte payload + 0x0C pressure telemetry
  const v2Hex = buildV2ProStatusHex({
    battery: 88,
    durationSec: 300,
    runningCode: 1,
    deepClean: true,
    antiSplash: true,
    overPressure: true,
    overPressureLevelBytes: [0x01, 0xb8],
  });
  const parsedV2 = LaifenProtocol.parsePacket(v2Hex)!;
  assert.equal(parsedV2.protocol, 'v2pro');
  assert.equal(parsedV2.batteryPct, 88);
  assert.equal(parsedV2.durationSec, 300);
  assert.equal(parsedV2.status, 'Running');
  const feats = parsedV2.features as Record<string, unknown>;
  assert.equal(feats.deepClean, true);
  assert.equal(feats.antiSplash, true);
  assert.equal(feats.overPressureLevel, 'Hard');

  const pressureTele = LaifenProtocol.parsePacket('5A820C010004030101A000')!;
  assert.equal(pressureTele.type, 'telemetry');
  assert.equal(pressureTele.overPressureActive, true);

  // 4. ACK verification: standard XOR & hardware inverted-XOR
  const ackXor = LaifenProtocol.verifyV1Ack('AA04020100AD', 0x04);
  assert.equal(ackXor.valid, true);
  assert.equal(ackXor.ok, true);
  assert.equal(ackXor.checksumMode, 'xor');

  const ackInv = LaifenProtocol.verifyV1Ack('AA0402010052', 0x04);
  assert.equal(ackInv.valid, true);
  assert.equal(ackInv.ok, true);
  assert.equal(ackInv.checksumMode, 'inverted_xor');

  const ackErr = LaifenProtocol.verifyV1Ack('AA04020101AC', 0x04);
  assert.equal(ackErr.valid, true);
  assert.equal(ackErr.ok, false);

  // 5. Command frame builders
  assert.equal(LaifenProtocol.buildV1Power(true).toString('hex').toUpperCase(), 'AA0F010101A4');
  assert.equal(LaifenProtocol.buildV1Power(false).toString('hex').toUpperCase(), 'AA0F010100A5');
  assert.equal(LaifenProtocol.buildV1Duration(180).toString('hex').toUpperCase(), 'AA05010200B418');
  assert.equal(LaifenProtocol.buildV1ModeSettings(4, 5, 8, 9)[5], 11, 'Mode 4 clamps strength to 11..20');
  assert.equal(LaifenProtocol.buildV1Calibration('limp').toString('hex').toUpperCase(), 'AA06010101AD');
  assert.equal(LaifenProtocol.buildV1Calibration('calibrate').toString('hex').toUpperCase(), 'AA06010103AF');
  assert.equal(LaifenProtocol.buildV2ProCommand(0x0108, [0x01]).toString('hex').toUpperCase(), 'AA010800000101A3');
});

test('laifen plugin actions support scan/bind, sync, set, power, sessions/streaks, brushhead reset, and monitor lifecycle', async () => {
  const mod = await loadPluginModule();
  const dataDir = mkdtempSync(join(tmpdir(), 'laifen-plugin-test-'));
  const dayMs = 86_400_000;
  let fakeNow = new Date('2026-11-21T09:00:00+08:00').getTime();

  try {
    // 1. Scan & bind MAC
    const scanRes = await mod.runAction(
      'scan',
      { timeoutSec: 3, bind: true },
      {
        dataDir,
        nowFn: () => fakeNow,
        bleRunner: async () => ({
          ok: true,
          scannedAt: fakeNow,
          adapter: { path: '/org/bluez/hci0', address: '00:11:22:33:44:55', name: 'host' },
          devices: [{ address: 'C0:00:00:AA:BB:CC', name: 'LFTB01-P-TEST', rssi: -64 }],
        }),
      },
    );
    assert.equal(scanRes.ok, true);
    const cfgAfterScan = (await mod.runAction('config', {}, { dataDir, nowFn: () => fakeNow })).data as Record<string, unknown>;
    assert.equal(cfgAfterScan.targetMac, 'C0:00:00:AA:BB:CC');

    // 2. Sync status
    const syncHex = buildV1StatusHex({ modeIndex: 2, battery: 79, durationSec: 180 });
    const syncRes = await mod.runAction(
      'sync',
      {},
      {
        dataDir,
        nowFn: () => fakeNow,
        bleRunner: async (args: string[]) => {
          assert.equal(args[0], 'sync');
          return {
            ok: true,
            syncedAt: fakeNow,
            device: { address: 'C0:00:00:AA:BB:CC', name: 'LFTB01-P-TEST', rssi: -63 },
            statusHex: syncHex,
            infoHex: 'AA01021302010006585858540001420000590404030003A9',
          };
        },
      },
    );
    assert.equal(syncRes.ok, true);
    const syncedDev = (syncRes.data as { device: Record<string, unknown> }).device;
    assert.equal(syncedDev.batteryPct, 79);
    assert.equal(syncedDev.activeMode, 3);

    // 3. Set mode + preset + sliders + duration
    const afterSetHex = buildV1StatusHex({
      modeIndex: 3,
      m4: [14, 8, 8],
      battery: 78,
      durationSec: 210,
      highFrequency: true,
      reminder30s: false,
    });
    let capturedWriteOps: Record<string, unknown> | null = null;
    const setRes = await mod.runAction(
      'set',
      { preset: 'whitening', durationSec: 210, reminder30s: false },
      {
        dataDir,
        nowFn: () => fakeNow,
        bleRunner: async (args: string[]) => {
          assert.equal(args[0], 'write');
          const opsIdx = args.indexOf('--ops-json');
          capturedWriteOps = JSON.parse(args[opsIdx + 1]!) as Record<string, unknown>;
          return {
            ok: true,
            protocol: 'v1',
            device: { address: 'C0:00:00:AA:BB:CC', name: 'LFTB01-P-TEST', rssi: -62 },
            baselineHex: syncHex,
            afterHex: afterSetHex,
            txLog: [{ label: 'v1_mode_4_settings', txHex: 'AA040104030E0808A3' }],
          };
        },
      },
    );
    assert.equal(setRes.ok, true);
    assert.equal((capturedWriteOps as { patch?: { mode?: number } } | null)?.patch?.mode, 4);
    const updatedDev = (setRes.data as { device: Record<string, unknown> }).device;
    assert.equal(updatedDev.activeMode, 4);
    assert.equal(updatedDev.durationSec, 210);
    assert.equal(updatedDev.reminder30s, false);

    // 4. Power & calibration validation
    const badPower = await mod.runAction('power', {}, { dataDir, bleRunner: async () => ({ ok: true }) });
    assert.equal(badPower.ok, false);
    const calRes = await mod.runAction(
      'power',
      { calibration: 'limp' },
      {
        dataDir,
        nowFn: () => fakeNow,
        bleRunner: async (args: string[]) => {
          const ops = JSON.parse(args[args.indexOf('--ops-json') + 1]!) as { patch: Record<string, unknown>; refreshStatus: boolean };
          assert.equal(ops.patch.calibration, 'limp');
          assert.equal(ops.refreshStatus, false);
          return { ok: true, protocol: 'v1', device: { address: 'C0:00:00:AA:BB:CC', name: 'LFTB01-P-TEST' }, txLog: [] };
        },
      },
    );
    assert.equal(calRes.ok, true);

    // 5. Brushhead reset & lifespan check (10 days later -> 80 days left)
    await mod.runAction('brushhead-reset', { replacedAt: fakeNow - 10 * dayMs }, { dataDir, nowFn: () => fakeNow });

    // 6. Manual brushing sessions across yesterday + today (morning & evening) -> streakDays = 2
    const yesterdayTs = fakeNow - dayMs;
    const morningTs = new Date('2026-11-21T07:30:00+08:00').getTime();
    const eveningTs = new Date('2026-11-21T21:45:00+08:00').getTime();
    await mod.runAction('session-add', { brushedAt: yesterdayTs, durationSec: 180, mode: 2 }, { dataDir, nowFn: () => fakeNow });
    const mRes = await mod.runAction('session-add', { brushedAt: morningTs, durationSec: 180, mode: 3 }, { dataDir, nowFn: () => fakeNow });
    await mod.runAction('session-add', { brushedAt: eveningTs, durationSec: 180, mode: 3 }, { dataDir, nowFn: () => fakeNow });
    const createdMorningId = (mRes.data as { session: { id: string } }).session.id;

    // 7. Monitor start, ingestion on monitor-status, and monitor-stop safety on unrelated PID
    let spawnedStateFile = '';
    let spawnedSessionId = '';
    const monStart = await mod.runAction(
      'monitor-start',
      { timeoutSec: 120 },
      {
        dataDir,
        nowFn: () => fakeNow,
        spawnMonitor: (args: string[]) => {
          spawnedStateFile = args[args.indexOf('--state-file') + 1]!;
          spawnedSessionId = args[args.indexOf('--session-id') + 1]!;
          return process.pid; // non-ble_helper PID should NOT be killed on monitor-stop
        },
      },
    );
    assert.equal(monStart.ok, true);
    assert.equal(existsSync(spawnedStateFile), true);

    // Stop should leave process.pid alive and mark session stopped cleanly
    const monStop = await mod.runAction('monitor-stop', {}, { dataDir, nowFn: () => fakeNow });
    assert.equal(monStop.ok, true);

    // Simulate a completed monitor session file and verify automatic ingestion + dedup
    const monDoneHex = buildV1StatusHex({ modeIndex: 2, battery: 76, durationSec: 180, running: false });
    writeFileSync(
      spawnedStateFile,
      JSON.stringify({
        sessionId: spawnedSessionId,
        pid: null,
        phase: 'completed',
        startedAt: fakeNow - 140_000,
        updatedAt: fakeNow,
        timeoutSec: 120,
        message: '检测到本次刷牙结束，已自动记录',
        device: { address: 'C0:00:00:AA:BB:CC', name: 'LFTB01-P-TEST', rssi: -64 },
        firstStatusHex: syncHex,
        latestStatusHex: monDoneHex,
        runningStartedAt: fakeNow - 135_000,
        activeBrushingSec: 135,
        overPressureEvents: 2,
        notifications: [],
      }),
    );

    const monStatus = await mod.runAction('monitor-status', {}, { dataDir, nowFn: () => fakeNow });
    assert.equal(monStatus.ok, true);
    const dash = (monStatus.data as { dashboard: Record<string, unknown> }).dashboard;
    const stats = dash.stats as Record<string, unknown>;
    const bh = stats.brushHead as Record<string, unknown>;
    assert.equal(stats.todayCount, 3);
    assert.equal(stats.morningDone, true);
    assert.equal(stats.eveningDone, true);
    assert.equal(stats.streakDays, 2);
    assert.equal(bh.daysUsed, 10);
    assert.equal(bh.daysLeft, 80);
    assert.equal(dash.batteryPct, 76);

    // Calling dashboard again must NOT duplicate the ingested monitor session
    const dash2Res = await mod.runAction('dashboard', {}, { dataDir, nowFn: () => fakeNow });
    const dash2 = dash2Res.data as { device: { name: string }; stats: { totalSessions: number } };
    assert.equal(dash2.stats.totalSessions, 4);
    assert.equal(dash2.device.name, 'LFTB01-P-TEST');
    assert.ok(String(dash2Res.message).includes('徕芬电动牙刷'));
    assert.equal(String(dash2Res.message).includes('LFTB01-P-TEST'), false);

    const statusRes = await mod.runAction('status', {}, { dataDir, nowFn: () => fakeNow });
    assert.equal(statusRes.ok, true);
    assert.ok(String(statusRes.message).includes('徕芬电动牙刷'));
    assert.equal(String(statusRes.message).includes('LFTB01-P-TEST'), false);
    assert.equal((statusRes.data as { device: { name: string } }).device.name, 'LFTB01-P-TEST');

    // Delete one session and verify count drops
    const delRes = await mod.runAction('session-delete', { id: createdMorningId }, { dataDir, nowFn: () => fakeNow });
    assert.equal(delRes.ok, true);
    const dash3 = (await mod.runAction('dashboard', {}, { dataDir, nowFn: () => fakeNow })).data as { stats: { totalSessions: number } };
    assert.equal(dash3.stats.totalSessions, 3);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('laifen handleVoiceFastpath handles status/head/today queries, check-in, and ignores unrelated utterances', async () => {
  const mod = await loadPluginModule();
  const dataDir = mkdtempSync(join(tmpdir(), 'laifen-fastpath-'));
  const fakeNow = new Date('2026-11-21T09:30:00+08:00').getTime();

  try {
    const unrelated = await mod.handleVoiceFastpath({ text: '明天上海天气怎么样', channelId: 'xiaoai:1', platform: 'xiaoai' }, { dataDir });
    assert.equal(unrelated.handled, false);

    // Seed check-in via fastpath
    const checkin = await mod.handleVoiceFastpath({ text: '帮我手动打卡一次刷牙', channelId: 'xiaoai:1', platform: 'xiaoai' }, { dataDir, nowFn: () => fakeNow });
    assert.equal(checkin.handled, true);
    assert.equal(checkin.action, 'session-add');
    assert.match(String(checkin.speech), /今天已完成 1 次/);

    const headQuery = await mod.handleVoiceFastpath({ text: '我的牙刷刷头还能用多久', channelId: 'xiaoai:1', platform: 'xiaoai' }, { dataDir, nowFn: () => fakeNow });
    assert.equal(headQuery.handled, true);
    assert.equal(headQuery.action, 'status');
    assert.match(String(headQuery.speech), /还能用 \d+ 天/);

    const todayQuery = await mod.handleVoiceFastpath({ text: '今天刷牙几次了', channelId: 'xiaoai:1', platform: 'xiaoai' }, { dataDir, nowFn: () => fakeNow });
    assert.equal(todayQuery.handled, true);
    assert.match(String(todayQuery.speech), /今天已经刷牙 1 次/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Friday plugin registry discovers laifen and runs dashboard in-process', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-laifen-reg-'));
  try {
    const plugins = listPluginsSync(home, { platform: 'linux' });
    const found = plugins.find(p => p.name === 'laifen');
    assert.ok(found, 'laifen plugin must be discovered');
    assert.equal(found.runtime, 'in-process');
    assert.equal(found.voiceFastpath, true);
    assert.equal(found.enabled, true);

    const res = await runPlugin(home, 'laifen', 'dashboard', {});
    assert.equal(res.ok, true);
    assert.equal(res.plugin, 'laifen');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('laifen supports autoWakeSync watch lifecycle, watch-outbox ingestion, and pending-patch queue/flush', async () => {
  const mod = await loadPluginModule();
  const dataDir = mkdtempSync(join(tmpdir(), 'laifen-watch-queue-'));
  let fakeNow = new Date('2026-11-21T20:10:00+08:00').getTime();

  try {
    // 1. Bind device MAC via config
    await mod.runAction('config', { targetMac: 'C0:00:00:AA:BB:CC' }, { dataDir, nowFn: () => fakeNow });

    // 2. watch-start toggles autoWakeSync and invokes spawnWatch with expected args
    let watchArgs: string[] = [];
    const watchStartRes = await mod.runAction(
      'watch-start',
      {},
      {
        dataDir,
        nowFn: () => fakeNow,
        spawnWatch: (args: string[]) => {
          watchArgs = args;
          return process.pid;
        },
      },
    );
    assert.equal(watchStartRes.ok, true);
    assert.equal(watchArgs[0], 'watch');
    assert.ok(watchArgs.includes('--state-file'));
    assert.ok(watchArgs.includes('--outbox-dir'));
    assert.ok(watchArgs.includes('--pending-file'));
    assert.ok(watchArgs.includes('--yield-lock-file'));
    assert.ok(watchArgs.includes('--peer-session-file'));

    const watchStartData = watchStartRes.data as {
      watchStatus: { enabled: boolean; running: boolean };
      dashboard: { config: { autoWakeSync: boolean }; watchStatus: { enabled: boolean; running: boolean } };
    };
    assert.equal(watchStartData.watchStatus.enabled, true);
    assert.equal(watchStartData.watchStatus.running, true);
    assert.equal(watchStartData.dashboard.config.autoWakeSync, true);

    const stateFile = watchArgs[watchArgs.indexOf('--state-file') + 1]!;
    const outboxDir = watchArgs[watchArgs.indexOf('--outbox-dir') + 1]!;
    const pendingFile = watchArgs[watchArgs.indexOf('--pending-file') + 1]!;
    assert.equal(existsSync(stateFile), true);
    assert.equal(existsSync(outboxDir), true);

    // 3. Offline queueOnly + merge + pending-clear
    const q1 = await mod.runAction(
      'set',
      { mode: 2, strength: 7, queueOnly: true },
      { dataDir, nowFn: () => fakeNow, spawnWatch: () => process.pid },
    );
    assert.equal(q1.ok, true);
    assert.equal((q1.data as { queued: boolean }).queued, true);
    assert.equal(existsSync(pendingFile), true);

    const q2 = await mod.runAction(
      'set',
      { durationSec: 210, queueOnly: true },
      { dataDir, nowFn: () => fakeNow, spawnWatch: () => process.pid },
    );
    const pending2 = (q2.data as { pendingPatch: { patchId: string; patch: Record<string, unknown> } }).pendingPatch;
    assert.equal(pending2.patch.mode, 2);
    assert.equal(pending2.patch.strength, 7);
    assert.equal(pending2.patch.durationSec, 210);

    const clrRes = await mod.runAction('pending-clear', {}, { dataDir, nowFn: () => fakeNow, spawnWatch: () => process.pid });
    assert.equal(clrRes.ok, true);
    assert.equal((clrRes.data as { cleared: boolean; dashboard: { pendingPatch: unknown } }).cleared, true);
    assert.equal((clrRes.data as { dashboard: { pendingPatch: unknown } }).dashboard.pendingPatch, null);
    assert.equal(existsSync(pendingFile), false);

    // 4. Re-queue via queueIfAsleep on asleep timeout, then flush automatically during `sync`
    const asleepRes = await mod.runAction(
      'set',
      { mode: 1, strength: 3, range: 4, speed: 4, durationSec: 150, queueIfAsleep: true },
      {
        dataDir,
        nowFn: () => fakeNow,
        bleRunner: async () => ({ ok: false, error: '等待超时：未检测到唤醒中的徕芬牙刷', txLog: [] }),
      },
    );
    assert.equal(asleepRes.ok, true);
    assert.equal((asleepRes.data as { queued: boolean }).queued, true);
    assert.equal(existsSync(pendingFile), true);

    const afterFlushHex = buildV1StatusHex({ modeIndex: 0, m1: [3, 4, 4], battery: 73, durationSec: 150 });
    let flushCmdArgs: string[] = [];
    const syncFlushRes = await mod.runAction(
      'sync',
      {},
      {
        dataDir,
        nowFn: () => fakeNow,
        bleRunner: async (args: string[]) => {
          flushCmdArgs = args;
          return {
            ok: true,
            writtenAt: fakeNow,
            protocol: 'v1',
            device: { address: 'C0:00:00:AA:BB:CC', name: 'LFTB01-P-TEST', rssi: -68 },
            baselineHex: buildV1StatusHex({ modeIndex: 2, battery: 74, durationSec: 180 }),
            afterHex: afterFlushHex,
            txLog: [{ label: 'v1_mode_1_settings', txHex: 'AA04010400030404AD' }],
          };
        },
      },
    );
    assert.equal(syncFlushRes.ok, true);
    assert.equal(flushCmdArgs[0], 'write', 'sync should automatically upgrade to write when pendingPatch exists');
    assert.equal(existsSync(pendingFile), false, 'pending-patch.json must be cleared once flushed');
    assert.equal((syncFlushRes.data as { device: { activeMode: number; durationSec: number } }).device.activeMode, 1);
    assert.equal((syncFlushRes.data as { device: { durationSec: number } }).device.durationSec, 150);

    // 5. Watch-outbox ingestion for both 'sync' (clearing matching pendingPatch) and 'session' ('ble_auto')
    const q3 = await mod.runAction('set', { mode: 3, strength: 9, queueOnly: true }, { dataDir, nowFn: () => fakeNow, spawnWatch: () => process.pid });
    const q3Id = (q3.data as { pendingPatch: { patchId: string } }).pendingPatch.patchId;

    mkdirSync(outboxDir, { recursive: true });
    const ev1Hex = buildV1StatusHex({ modeIndex: 2, m3: [9, 9, 9], battery: 72, durationSec: 150 });
    const ev2Hex = buildV1StatusHex({ modeIndex: 2, m3: [9, 9, 9], battery: 71, durationSec: 150 });
    const ev1Path = join(outboxDir, 'ev-001.json');
    const ev2Path = join(outboxDir, 'ev-002.json');

    writeFileSync(ev1Path, JSON.stringify({
      eventId: 'ev-001',
      kind: 'sync',
      at: fakeNow + 5000,
      device: { address: 'C0:00:00:AA:BB:CC', name: 'LFTB01-P-TEST', rssi: -67 },
      firstStatusHex: ev1Hex,
      latestStatusHex: ev1Hex,
      infoHex: 'AA01021302010006585858540001420000590404030003A9',
      appliedPatchId: q3Id,
    }));
    writeFileSync(ev2Path, JSON.stringify({
      eventId: 'ev-002',
      kind: 'session',
      at: fakeNow + 140_000,
      device: { address: 'C0:00:00:AA:BB:CC', name: 'LFTB01-P-TEST', rssi: -66 },
      firstStatusHex: ev1Hex,
      latestStatusHex: ev2Hex,
      runningStartedAt: fakeNow + 10_000,
      activeBrushingSec: 130,
      overPressureEvents: 1,
      dedupKey: 'watch:cycle-test-1',
    }));

    const dashAfterOutbox = await mod.runAction('dashboard', {}, { dataDir, nowFn: () => fakeNow + 140_000, spawnWatch: () => process.pid });
    assert.equal(dashAfterOutbox.ok, true);
    const outboxDash = dashAfterOutbox.data as {
      batteryPct: number;
      activeMode: number;
      pendingPatch: unknown;
      stats: { todayCount: number; totalSessions: number };
      sessions: Array<{ source: string; durationSec: number; overPressureCount: number }>;
    };
    assert.equal(outboxDash.batteryPct, 71);
    assert.equal(outboxDash.activeMode, 3);
    assert.equal(outboxDash.pendingPatch, null, 'appliedPatchId from outbox must clear pending-patch.json');
    assert.equal(outboxDash.stats.todayCount, 1);
    assert.equal(outboxDash.sessions[0]?.source, 'ble_auto');
    assert.equal(outboxDash.sessions[0]?.durationSec, 130);
    assert.equal(outboxDash.sessions[0]?.overPressureCount, 1);
    assert.equal(existsSync(ev1Path), false);
    assert.equal(existsSync(ev2Path), false);

    // 6. watch-stop disables autoWakeSync
    const stopRes = await mod.runAction('watch-stop', {}, { dataDir, nowFn: () => fakeNow, spawnWatch: () => process.pid });
    assert.equal(stopRes.ok, true);
    const stopData = stopRes.data as { watchStatus: { enabled: boolean; running: boolean } };
    assert.equal(stopData.watchStatus.enabled, false);
    assert.equal(stopData.watchStatus.running, false);

    if (process.platform !== 'linux') {
      const noStubStart = await mod.runAction('watch-start', {}, { dataDir });
      assert.equal(noStubStart.ok, false);
      const noStubStop = await mod.runAction('watch-stop', {}, { dataDir });
      assert.equal(noStubStop.ok, false);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('laifen WatchSession._check_yield respects fresh netlea ble-active.lock and ignores removed or stale locks', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-laifen-peer-lock-'));
  try {
    const laifenDir = join(home, 'plugins', 'laifen');
    const netleaDir = join(home, 'plugins', 'netlea');
    mkdirSync(laifenDir, { recursive: true });
    mkdirSync(netleaDir, { recursive: true });
    const stateFile = join(laifenDir, 'watch-state.json');
    const netleaLock = join(netleaDir, 'ble-active.lock');

    const pyScript = [
      'import importlib.util, json, os, sys, time, types',
      'for mod in ["dbus", "dbus.mainloop", "dbus.mainloop.glib", "gi", "gi.repository"]:',
      '    sys.modules[mod] = types.ModuleType(mod)',
      'sys.modules["dbus.mainloop.glib"].DBusGMainLoop = lambda **kw: None',
      'sys.modules["gi.repository"].GLib = types.SimpleNamespace()',
      `spec = importlib.util.spec_from_file_location("lfh", ${JSON.stringify(join(process.cwd(), 'plugins/laifen/ble_helper.py'))})`,
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'ws = object.__new__(m.WatchSession)',
      `ws.state_file = ${JSON.stringify(stateFile)}`,
      'ws.yield_lock_file = ""',
      'ws.peer_session_file = ""',
      'assert ws._check_yield() == (False, "")',
      `lock_path = ${JSON.stringify(netleaLock)}`,
      'with open(lock_path, "w") as f: json.dump({"pid": 1234}, f)',
      'yielding, reason = ws._check_yield()',
      'assert yielding is True and "水草灯" in reason, (yielding, reason)',
      'old = time.time() - 60.0',
      'os.utime(lock_path, (old, old))',
      'assert ws._check_yield() == (False, ""), "stale >40s lock must be ignored"',
      'os.unlink(lock_path)',
      'assert ws._check_yield() == (False, "")',
    ].join('\n');
    await execFileAsync('python3', ['-c', pyScript]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('ble_helper.py MonitorSession & WatchSession handle mid-brush reconnect, pause accumulation, idle sleep, and parser defaults', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'friday-laifen-py-sm-'));
  try {
    const idleHex = buildV1StatusHex({ modeIndex: 2, battery: 74, durationSec: 180, running: false });
    const runHex = buildV1StatusHex({ modeIndex: 2, battery: 74, durationSec: 180, running: true });
    const helperPath = join(process.cwd(), 'plugins/laifen/ble_helper.py');
    const monState = join(dir, 'monitor-state.json');
    const watchDir = join(dir, 'watch');
    const outboxDir = join(watchDir, 'outbox');
    mkdirSync(outboxDir, { recursive: true });
    const watchState = join(watchDir, 'watch-state.json');

    const pyScript = [
      'import importlib.util, json, os, sys, types',
      'timers = []',
      'next_tid = 1',
      'class FakeGLib:',
      '    PRIORITY_DEFAULT = 0',
      '    @staticmethod',
      '    def timeout_add(ms, cb, *a):',
      '        global next_tid',
      '        tid = next_tid',
      '        next_tid += 1',
      '        timers.append((tid, ms, cb))',
      '        return tid',
      '    @staticmethod',
      '    def source_remove(tid): pass',
      '    @staticmethod',
      '    def idle_add(*a): return 1',
      'class FakeBus:',
      '    def get_object(self, *a): return object()',
      '    def add_signal_receiver(self, *a, **kw): return types.SimpleNamespace(remove=lambda: None)',
      'dbus_mod = types.ModuleType("dbus")',
      'dbus_mod.SystemBus = lambda: FakeBus()',
      'dbus_mod.Interface = lambda obj, iface: types.SimpleNamespace(StopDiscovery=lambda: None, StartDiscovery=lambda: None, SetDiscoveryFilter=lambda *a: None, StopNotify=lambda **kw: None, Disconnect=lambda: None, RemoveDevice=lambda *a: None)',
      'dbus_mod.ObjectPath = lambda p: p',
      'dbus_mod.String = lambda s: s',
      'dbus_mod.Boolean = lambda b: b',
      'dbus_mod.Dictionary = lambda d, **kw: d',
      'dbus_mod.DBusException = Exception',
      'for mod in ["dbus.mainloop", "dbus.mainloop.glib", "gi", "gi.repository"]:',
      '    sys.modules[mod] = types.ModuleType(mod)',
      'sys.modules["dbus"] = dbus_mod',
      'sys.modules["dbus.mainloop.glib"].DBusGMainLoop = lambda **kw: None',
      'sys.modules["gi.repository"].GLib = FakeGLib',
      `spec = importlib.util.spec_from_file_location("lfh2", ${JSON.stringify(helperPath)})`,
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'fake_ms = [1_000_000]',
      'm.now_ms = lambda: fake_ms[0]',
      'm.time.monotonic = lambda: fake_ms[0] / 1000.0',
      '',
      '# 1. Parser defaults',
      'p = m.build_parser()',
      'mon_args = p.parse_args(["monitor", "--state-file", "/tmp/s.json"])',
      'assert mon_args.timeout == 360.0',
      'w_args = p.parse_args(["watch", "--state-file", "/tmp/w.json", "--outbox-dir", "/tmp/o"])',
      'assert w_args.idle_hold_sec == 25.0 and w_args.cooldown_sec == 15.0',
      '',
      '# 2. BaseBleSession._merge_device_snapshot preserves RSSI and name',
      'def make_monitor(state_path, timeout_sec=360.0):',
      '    ms = object.__new__(m.MonitorSession)',
      '    ms.bus = FakeBus()',
      '    ms.loop = types.SimpleNamespace(quit=lambda: None)',
      '    ms.adapter_path = "/org/bluez/hci0"',
      '    ms.adapter_props = {"Address": "B4:D5:BD:F0:B4:FE"}',
      '    ms.adapter = dbus_mod.Interface(None, None)',
      '    ms.target_mac = "C0:00:00:06:64:0A"; ms.name_prefix = "LFTB"; ms.target_dev_suffix = "/DEV_C0_00_00_06_64_0A"',
      '    ms.ignored_paths = set(); ms.timeout_sec = timeout_sec; ms.started_at = fake_ms[0]; ms.start_mono = m.time.monotonic()',
      '    ms.has_deadline = True; ms.allow_warm_cache = True; ms.deadline = ms.start_mono + timeout_sec; ms.max_attempts = 0',
      '    ms.connect_attempts = 0; ms.attempt_errors = []; ms.stopping = False; ms.finished = False',
      '    ms.initial_cleanup_done = True; ms.warm_cache_fast_try = False; ms.discovery_active = False',
      '    ms.settling_match = False; ms.connecting = False; ms.direct_retried_for_current_adv = False; ms.services_handled = True',
      '    ms.device_path = "/dev/1"; ms.device_snapshot = {"address": "C0:00:00:06:64:0A", "name": "LFTB01-P-640A", "rawName": "LFTB01-P-640A", "alias": "LFTB01-P-640A", "rssi": -72}',
      '    ms.ff02_path = "/ff02"; ms.gap_name_path = None; ms.connected = True; ms.notify_active = True',
      '    for a in ("overall_timer_id","scan_rsp_timer_id","settle_timer_id","connect_timer_id","resolve_timer_id","retry_timer_id","grace_timer_id","tick_timer_id","reconnect_grace_timer_id"):',
      '        setattr(ms, a, None)',
      '    ms.receivers = []; ms.notifications = []; ms.status_frames = []; ms.info_frames = []; ms.ack_frames = []; ms.status_seq = 0',
      '    ms.state_file = state_path; ms.target_duration_sec = 180; ms.connected_at = fake_ms[0]',
      '    ms.running_started_at = None; ms.first_running_started_at = None; ms.segment_started_at = None',
      '    ms.accumulated_active_ms = 0; ms.last_running = False; ms.brushing_ever_started = False',
      '    ms.reconnecting_brushing = False; ms.disconnect_while_running_at = None; ms.reconnect_count = 0',
      '    ms.over_pressure_events = 0; ms.over_pressure_active = False',
      '    ms.first_status_hex = None; ms.latest_status_hex = None; ms.info_hex = None',
      '    ms.state = {"sessionId": "brush-py-1", "pid": os.getpid(), "phase": "monitoring", "startedAt": fake_ms[0], "updatedAt": fake_ms[0], "timeoutSec": 360.0, "message": "", "device": ms.device_snapshot, "notifications": [], "error": None}',
      '    return ms',
      '',
      'ms_snap = make_monitor(' + JSON.stringify(monState) + ')',
      'ms_snap._merge_device_snapshot("/dev/1", {"Address": "C0:00:00:06:64:0A", "Connected": True})',
      'assert ms_snap.device_snapshot["rssi"] == -72',
      'assert ms_snap.device_snapshot["name"] == "LFTB01-P-640A"',
      '',
      `idle_bytes = bytes.fromhex(${JSON.stringify(idleHex)})`,
      `run_bytes = bytes.fromhex(${JSON.stringify(runHex)})`,
      '',
      '# 3. MonitorSession mid-brush disconnect -> reconnect bridges gap to full 180s (and extends short deadline)',
      'timers.clear()',
      'ms1 = make_monitor(' + JSON.stringify(monState) + ', timeout_sec=180.0)',
      `ms1.on_ff02_packet(idle_bytes, ${JSON.stringify(idleHex)})`,
      'fake_ms[0] += 5_000',
      `ms1.on_ff02_packet(run_bytes, ${JSON.stringify(runHex)})`,
      'assert ms1.deadline >= ms1.start_mono + 270.0, "starting brush must extend 180s deadline"',
      'fake_ms[0] += 23_000',
      'ms1.on_device_disconnected()',
      'assert ms1.finished is False',
      'assert ms1.reconnecting_brushing is True',
      'assert ms1.state["phase"] == "reconnecting"',
      'assert ms1.state["activeBrushingSec"] == 23',
      'assert ms1.reconnect_grace_timer_id is not None',
      'fake_ms[0] += 12_000',
      'ms1.services_handled = True; ms1.connected = True',
      `ms1.on_ff02_packet(run_bytes, ${JSON.stringify(runHex)})`,
      'assert ms1.reconnecting_brushing is False',
      'assert ms1.state["phase"] == "monitoring"',
      'fake_ms[0] += 145_000',
      `ms1.on_ff02_packet(idle_bytes, ${JSON.stringify(idleHex)})`,
      'assert ms1.finished is False, "12s pause grace must not finish immediately"',
      'assert timers[-1][1] == 12000',
      'ms1.on_device_disconnected()',
      'assert ms1.finished is True',
      'assert ms1.state["phase"] == "completed"',
      'assert ms1.state["activeBrushingSec"] == 180',
      '',
      '# 4. MonitorSession mid-brush disconnect that never reconnects keeps pre-disconnect 23s without dead-air inflation',
      'fake_ms[0] = 2_000_000',
      'ms2 = make_monitor(' + JSON.stringify(monState) + ')',
      `ms2.on_ff02_packet(run_bytes, ${JSON.stringify(runHex)})`,
      'fake_ms[0] += 23_000',
      'ms2.on_device_disconnected()',
      'assert ms2.finished is False and ms2.reconnecting_brushing is True',
      'fake_ms[0] += 60_000',
      'ms2._on_reconnect_grace_timeout()',
      'assert ms2.finished is True and ms2.state["phase"] == "completed"',
      'assert ms2.state["activeBrushingSec"] == 23',
      '',
      '# 5. MonitorSession pause 5s + resume excludes paused time',
      'fake_ms[0] = 3_000_000',
      'ms3 = make_monitor(' + JSON.stringify(monState) + ')',
      `ms3.on_ff02_packet(run_bytes, ${JSON.stringify(runHex)})`,
      'fake_ms[0] += 15_000',
      `ms3.on_ff02_packet(idle_bytes, ${JSON.stringify(idleHex)})`,
      'assert ms3.finished is False and ms3.state["activeBrushingSec"] == 15',
      'fake_ms[0] += 5_000',
      `ms3.on_ff02_packet(run_bytes, ${JSON.stringify(runHex)})`,
      'fake_ms[0] += 20_000',
      `ms3.on_ff02_packet(idle_bytes, ${JSON.stringify(idleHex)})`,
      'ms3._on_idle_grace()',
      'assert ms3.finished is True and ms3.state["activeBrushingSec"] == 35',
      '',
      '# 6. MonitorSession idle disconnect BEFORE brushing does not abort session',
      'fake_ms[0] = 4_000_000',
      'ms4 = make_monitor(' + JSON.stringify(monState) + ')',
      'ms4.connected_at = 4_000_000',
      `ms4.on_ff02_packet(idle_bytes, ${JSON.stringify(idleHex)})`,
      'fake_ms[0] += 15_000',
      'ms4.on_device_disconnected()',
      'assert ms4.finished is False',
      '',
      '# 7. WatchSession mid-brush disconnect preserves cycle across begin_scan & bridges gap into outbox session',
      'ws = object.__new__(m.WatchSession)',
      'ws.bus = FakeBus(); ws.adapter = dbus_mod.Interface(None, None); ws.target_mac = "C0:00:00:06:64:0A"; ws.name_prefix = "LFTB"',
      'ws.target_dev_suffix = "/DEV_C0_00_00_06_64_0A"; ws.ignored_paths = set(); ws.has_deadline = False',
      'ws.started_at = 5_000_000; ws.connect_attempts = 0; ws.attempt_errors = []',
      'ws.stopping = False; ws.finished = False; ws.services_handled = True; ws.connected = True; ws.connecting = False',
      'ws.settling_match = False; ws.discovery_active = False; ws.notify_active = True; ws.direct_retried_for_current_adv = False',
      'ws.device_path = "/dev/1"; ws.ff02_path = "/ff02"; ws.gap_name_path = None',
      'ws.device_snapshot = {"address": "C0:00:00:06:64:0A", "name": "LFTB01-P-640A", "rssi": -68}',
      'ws.notifications = []; ws.status_frames = []; ws.info_frames = []; ws.ack_frames = []; ws.status_seq = 0',
      `ws.state_file = ${JSON.stringify(watchState)}; ws.outbox_dir = ${JSON.stringify(outboxDir)}`,
      'ws.pending_file = ""; ws.yield_lock_file = ""; ws.peer_session_file = ""',
      'ws.cooldown_sec = 15.0; ws.idle_hold_sec = 25.0; ws.outbox_seq = 0; ws.cycle_seq = 0',
      'ws.cooldown_until = 0.0; ws.last_applied_patch_id = None; ws.last_flush_mono = 0.0; ws._last_flushed_sig = None',
      'for a in ("tick_timer_id","scan_rsp_timer_id","settle_timer_id","connect_timer_id","resolve_timer_id","retry_timer_id","idle_release_timer_id","sync_emit_timer_id","status_wait_timer_id","grace_timer_id","reconnect_grace_timer_id","ack_timer_id","write_delay_timer_id","refresh_timer_id","cycle_timer_id"):',
      '    setattr(ws, a, None)',
      'ws.state = {"phase": "watching", "message": "", "error": None}',
      'ws._reset_cycle_state()',
      'ws.cycle_phase = "waiting_status"',
      'fake_ms[0] = 5_000_000',
      `ws.on_ff02_packet(run_bytes, ${JSON.stringify(runHex)})`,
      'fake_ms[0] += 30_000',
      'ws.on_device_disconnected()',
      'assert ws.cycle_reconnecting_brushing is True',
      'assert ws.state["phase"] == "reconnecting"',
      'assert ws.cooldown_until == 0.0',
      'ws.on_connecting_started({"address": "C0:00:00:06:64:0A", "name": "LFTB01-P-640A", "rssi": -70})',
      'assert ws.cycle_reconnecting_brushing is True',
      'assert ws.cycle_accumulated_ms == 30_000',
      'fake_ms[0] += 10_000',
      'ws.services_handled = True; ws.connected = True',
      `ws.on_ff02_packet(run_bytes, ${JSON.stringify(runHex)})`,
      'fake_ms[0] += 140_000',
      `ws.on_ff02_packet(idle_bytes, ${JSON.stringify(idleHex)})`,
      'ws._on_brushing_idle_grace()',
      `ev_files = sorted(f for f in os.listdir(${JSON.stringify(outboxDir)}) if f.startswith("ev-") and f.endswith(".json"))`,
      `sessions = [json.load(open(os.path.join(${JSON.stringify(outboxDir)}, f))) for f in ev_files]`,
      'sess_evs = [s for s in sessions if s.get("kind") == "session"]',
      'assert len(sess_evs) == 1 and sess_evs[0]["activeBrushingSec"] == 180, sess_evs',
    ].join('\n');

    await execFileAsync('python3', ['-c', pyScript]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('laifen ingestMonitorSessionIfReady avoids active write race, resets status to Idle on end, and ignores short-tap inflation', async () => {
  const mod = await loadPluginModule();
  const dataDir = mkdtempSync(join(tmpdir(), 'friday-laifen-ingest-'));
  const now = new Date('2026-11-22T18:00:00+08:00').getTime();

  try {
    const sPath = join(dataDir, 'live-session.json');
    const runHex = buildV1StatusHex({ modeIndex: 2, battery: 74, durationSec: 180, running: true });
    const idleHex = buildV1StatusHex({ modeIndex: 2, battery: 74, durationSec: 180, running: false });

    // 1. Active monitoring with alive PID must NOT mutate or rewrite live-session.json
    const activePayload = JSON.stringify({
      sessionId: 'brush-race-1',
      pid: process.pid,
      phase: 'monitoring',
      startedAt: now - 20_000,
      updatedAt: now - 1_000,
      timeoutSec: 360,
      message: '正在刷牙中',
      device: { address: 'C0:00:00:06:64:0A', name: 'LFTB01-P-640A', rssi: -72 },
      firstStatusHex: idleHex,
      latestStatusHex: runHex,
      runningStartedAt: now - 15_000,
      segmentStartedAt: now - 15_000,
      accumulatedActiveSec: 0,
      activeBrushingSec: 14,
      brushingActive: true,
      overPressureEvents: 0,
      notifications: [],
    });
    writeFileSync(sPath, activePayload);

    const d1 = await mod.runAction('dashboard', {}, { dataDir, nowFn: () => now });
    assert.equal(d1.ok, true);
    assert.equal(readFileSync(sPath, 'utf8'), activePayload, 'live-session.json must not be overwritten while helper PID is alive');
    assert.equal((d1.data as { device: { status: string } }).device.status, 'Running');

    // 2. Reconnecting with alive PID also leaves live-session.json untouched
    const reconnPayload = JSON.stringify({
      ...JSON.parse(activePayload) as Record<string, unknown>,
      phase: 'reconnecting',
      brushingActive: false,
      accumulatedActiveSec: 23,
      activeBrushingSec: 23,
    });
    writeFileSync(sPath, reconnPayload);
    await mod.runAction('dashboard', {}, { dataDir, nowFn: () => now + 1000 });
    assert.equal(readFileSync(sPath, 'utf8'), reconnPayload);

    // 3. Completed short-tap (4s active, 25s wall-clock elapsed, latestStatusHex still Running) must reset status to Idle and NOT record a 25s session
    writeFileSync(sPath, JSON.stringify({
      sessionId: 'brush-race-1',
      pid: null,
      phase: 'completed',
      startedAt: now - 30_000,
      updatedAt: now,
      timeoutSec: 360,
      message: '牙刷已断开',
      device: { address: 'C0:00:00:06:64:0A', name: 'LFTB01-P-640A', rssi: -72 },
      firstStatusHex: idleHex,
      latestStatusHex: runHex,
      runningStartedAt: now - 25_000,
      segmentStartedAt: null,
      accumulatedActiveSec: 4,
      activeBrushingSec: 4,
      brushingActive: false,
      overPressureEvents: 0,
      notifications: [],
    }));
    const d3 = await mod.runAction('dashboard', {}, { dataDir, nowFn: () => now + 2000 });
    const d3Data = d3.data as { device: { status: string }; stats: { totalSessions: number } };
    assert.equal(d3Data.device.status, 'Idle');
    assert.equal(d3Data.stats.totalSessions, 0, '4s short tap must not be inflated by wall clock to 25s');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('laifen handleVoiceFastpath covers monitor-start phrases, assistant_reply, brushing_poll, and completion speech', async () => {
  const mod = await loadPluginModule();
  const dataDir = mkdtempSync(join(tmpdir(), 'friday-laifen-fp-watch-'));
  let now = new Date('2026-11-22T18:10:00+08:00').getTime();

  try {
    const startPhrases = ['记录刷牙', '记录刷牙愧不敢。', '我要刷牙了', '我去刷牙了', '刷牙监听'];
    for (const phrase of startPhrases) {
      const res = await mod.handleVoiceFastpath(
        { text: phrase, channelId: 'xiaoai:1', platform: 'xiaoai' },
        {
          dataDir,
          nowFn: () => now,
          spawnMonitor: () => process.pid,
        },
      );
      assert.equal(res.handled, true, `phrase should be handled: ${phrase}`);
      assert.equal(res.action, 'monitor-start', `phrase should start monitor: ${phrase}`);
      const d = res.data as { watchBrushSessionId?: string; timeoutSec?: number };
      assert.ok(d.watchBrushSessionId?.startsWith('brush-'), `must return watchBrushSessionId for ${phrase}`);
      assert.equal(d.timeoutSec, 360);
      await mod.runAction('monitor-stop', {}, { dataDir, nowFn: () => now });
      now += 1000;
    }

    // Query phrases must NOT start monitor
    for (const query of ['今天刷牙几次了', '查看刷牙记录']) {
      const res = await mod.handleVoiceFastpath(
        { text: query, channelId: 'xiaoai:1', platform: 'xiaoai' },
        { dataDir, nowFn: () => now, spawnMonitor: () => process.pid },
      );
      assert.notEqual(res.action, 'monitor-start', `query must not start monitor: ${query}`);
    }

    // "连接来分" phonetic match triggers sync
    const syncHex = buildV1StatusHex({ modeIndex: 2, battery: 74, durationSec: 180 });
    const laifenSync = await mod.handleVoiceFastpath(
      { text: '连接来分', channelId: 'xiaoai:1', platform: 'xiaoai' },
      {
        dataDir,
        nowFn: () => now,
        bleRunner: async () => ({
          ok: true,
          syncedAt: now,
          device: { address: 'C0:00:00:06:64:0A', name: 'LFTB01-P-640A', rssi: -70 },
          statusHex: syncHex,
        }),
      },
    );
    assert.equal(laifenSync.handled, true);
    assert.equal(laifenSync.action, 'sync');

    // assistant_reply hook detects fresh brush-* session and brushing_poll completes with speech
    const sPath = join(dataDir, 'live-session.json');
    const started = await mod.handleVoiceFastpath(
      { text: '记录刷牙', channelId: 'xiaoai:1', platform: 'xiaoai' },
      { dataDir, nowFn: () => now, spawnMonitor: () => process.pid },
    );
    const sid = (started.data as { watchBrushSessionId: string }).watchBrushSessionId;

    const hook = await mod.handleVoiceFastpath(
      { text: '', channelId: 'xiaoai:1', platform: 'xiaoai', sessionState: { event: 'assistant_reply', assistantReply: 'ok' } },
      { dataDir, nowFn: () => now + 1000 },
    );
    assert.equal(hook.handled, true);
    assert.equal((hook.data as { watchBrushSessionId?: string }).watchBrushSessionId, sid);

    // Poll during reconnecting stays active
    writeFileSync(sPath, JSON.stringify({
      sessionId: sid,
      pid: process.pid,
      phase: 'reconnecting',
      startedAt: now,
      updatedAt: now + 5000,
      timeoutSec: 420,
      message: '重连中',
      activeBrushingSec: 23,
      notifications: [],
    }));
    const pRecon = await mod.handleVoiceFastpath(
      { text: '', channelId: 'xiaoai:1', platform: 'xiaoai', sessionState: { event: 'brushing_poll', watchBrushSessionId: sid } },
      { dataDir, nowFn: () => now + 6000 },
    );
    assert.equal(pRecon.handled, true);
    assert.equal((pRecon.data as { phase?: string; timeoutSec?: number }).phase, 'reconnecting');
    assert.equal((pRecon.data as { timeoutSec?: number }).timeoutSec, 420);

    // Complete with 180s session
    const doneHex = buildV1StatusHex({ modeIndex: 2, battery: 73, durationSec: 180, running: false });
    writeFileSync(sPath, JSON.stringify({
      sessionId: sid,
      pid: null,
      phase: 'completed',
      startedAt: now,
      updatedAt: now + 185_000,
      timeoutSec: 420,
      message: '已完成',
      device: { address: 'C0:00:00:06:64:0A', name: 'LFTB01-P-640A', rssi: -70 },
      firstStatusHex: syncHex,
      latestStatusHex: doneHex,
      runningStartedAt: now + 3_000,
      accumulatedActiveSec: 180,
      activeBrushingSec: 180,
      brushingActive: false,
      overPressureEvents: 0,
      notifications: [],
    }));
    const pDone = await mod.handleVoiceFastpath(
      { text: '', channelId: 'xiaoai:1', platform: 'xiaoai', sessionState: { event: 'brushing_poll', watchBrushSessionId: sid } },
      { dataDir, nowFn: () => now + 186_000 },
    );
    assert.equal(pDone.handled, true);
    assert.equal(pDone.action, 'monitor-completed');
    assert.match(String(pDone.speech), /刷牙已记录.*3 分钟.*Mode 3.*百分之 73/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

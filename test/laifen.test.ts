import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

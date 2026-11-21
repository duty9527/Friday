import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { haversineMeters, probeAmapKey, reverseGeocodeWithCache } from '../plugins/_shared/amap-geo.mjs';
import {
  execSshBinary,
  execSshText,
  parseSshTargets,
  resolvePrivateRunDir,
} from '../plugins/_shared/ssh.mjs';
import { runAction as runHealthAction } from '../plugins/health-scale/index.mjs';
import { runAction as runLaifenAction } from '../plugins/laifen/index.mjs';
import { buildControlFrame, runAction as runNetleaAction } from '../plugins/netlea/index.mjs';

const execFileAsync = promisify(execFileCb);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function expectData<T = Record<string, unknown>>(res: unknown): T {
  assert.ok(res && typeof res === 'object' && 'data' in res && res.data && typeof res.data === 'object');
  return res.data as T;
}

function buildV2ProStatusHex(opts: {
  battery?: number;
  durationSec?: number;
  runningCode?: number;
} = {}): string {
  const payload = new Array<number>(36).fill(0);
  payload[2] = opts.battery ?? 85;
  const dur = opts.durationSec ?? 180;
  payload[5] = dur & 0xff;
  payload[6] = (dur >> 8) & 0xff;
  payload[13] = opts.runningCode ?? 0;
  const frame = [0x5a, 0xc1, 0x03, 0x01, 0x00, payload.length, ...payload];
  let cs = 0;
  for (const b of frame) cs ^= b;
  return Buffer.from([...frame, cs]).toString('hex').toUpperCase();
}

function buildV1StatusHex(battery = 75, modeIndex = 1): string {
  const bytes = [
    0xaa, 0x0a, 0x02, 0x17,
    modeIndex,
    2, 4, 4,
    4, 6, 6,
    8, 9, 9,
    14, 6, 6,
    0,
    battery,
    1,
    0x00, 0xb4,
    0, 0,
    0, 0, 1,
  ];
  let cs = 0;
  for (const b of bytes) cs ^= b;
  return Buffer.from([...bytes, cs]).toString('hex').toUpperCase();
}

test('audit _shared/amap-geo: antipodal haversineMeters, no empty sqlite on unconfigured cache read, and gzip bomb guard', async () => {
  // 1. Antipodal coordinates must not produce NaN from floating-point overshoot > 1.0
  const antipodal = haversineMeters(0, 0, 0, 180);
  assert.equal(Number.isFinite(antipodal), true);
  assert.ok(antipodal > 20_000_000 && antipodal < 20_100_000);

  const antipodal2 = haversineMeters(31.23041, 121.47371, -31.23041, -58.52629);
  assert.equal(Number.isFinite(antipodal2), true);

  // 2. Unconfigured reverseGeocodeWithCache must not create an empty geo-cache.sqlite
  const home = mkdtempSync(join(tmpdir(), 'friday-audit-geo-'));
  try {
    const res = await reverseGeocodeWithCache({
      homeDir: home,
      env: {},
      lat: 31.23041,
      lon: 121.47371,
    });
    assert.equal(res.valid, true);
    assert.equal(res.address, null);
    assert.equal(existsSync(join(home, 'geo-cache.sqlite')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  // 3. Decompression bomb (> 1MB inflated from small gzip) is rejected cleanly by defaultGetRequester
  const hugeZeros = Buffer.alloc(1_200_000, 0x41);
  const gzPayload = gzipSync(hugeZeros);
  assert.ok(gzPayload.length < 10_000);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    });
    res.end(gzPayload);
  });
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', () => resolveListen()));
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const probeRes = await probeAmapKey({
      amapKey: 'dummy_key_1234',
      amapUrl: `http://127.0.0.1:${addr.port}/regeo`,
    });
    assert.equal(probeRes.ok, false);
    assert.match(probeRes.message, /请求高德接口失败/);
  } finally {
    await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
});

test('audit _shared/ssh: strict decimal ports, dangling symlink rejection, abort rethrow, timeout stderr, and no bogus mux retry', async () => {
  // 1. Hex/scientific port notation must not be parsed as numeric port
  assert.deepEqual(parseSshTargets('root@192.0.2.10:0x16'), []);
  assert.deepEqual(parseSshTargets('root@192.0.2.10:1e2'), []);
  const okTargets = parseSshTargets('spk=root@192.0.2.10:2222');
  assert.equal(okTargets.length, 1);
  assert.equal(okTargets[0]?.port, 2222);

  // 2. Dangling symlink at <home>/run must be rejected instead of falling through to mkdir EEXIST
  const root = mkdtempSync(join(tmpdir(), 'friday-audit-ssh-'));
  const origPath = process.env.PATH ?? '';
  try {
    const danglingHome = join(root, 'dangling-home');
    mkdirSync(danglingHome, { recursive: true });
    symlinkSync(join(root, 'does-not-exist-target'), join(danglingHome, 'run'));
    assert.throws(() => resolvePrivateRunDir(danglingHome), /real directory/i);

    // Mock ssh executable to test timeout stderr, normal exit-1 empty stderr, and long-home mux retry skip
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    const countFile = join(root, 'ssh-calls.txt');
    writeFileSync(
      join(binDir, 'ssh'),
      `#!/bin/sh
echo "call" >> ${JSON.stringify(countFile)}
mode="\${AUDIT_SSH_MODE:-sleep}"
if [ "$mode" = "sleep" ]; then
  sleep 2
  exit 0
fi
if [ "$mode" = "quiet1" ]; then
  exit 1
fi
if [ "$mode" = "muxtext255" ]; then
  echo "ControlPath mentioned by remote" >&2
  exit 255
fi
exit 0
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${binDir}:${origPath}`;

    // 3. Custom AbortError reason must rethrow rather than returning { code: 1 }
    const ac = new AbortController();
    ac.abort(new Error('custom abort reason'));
    process.env.AUDIT_SSH_MODE = 'sleep';
    await assert.rejects(
      execSshText({ id: 'a1', userHost: 'root@192.0.2.1' }, 'echo hi', { signal: ac.signal, useControlMaster: false }),
      (err: unknown) => {
        const e = err as { name?: string; message?: string; cause?: { message?: string } };
        return e?.name === 'AbortError' && /custom abort reason/.test(`${e?.message ?? ''} ${e?.cause?.message ?? ''}`);
      },
    );
    const acBin = new AbortController();
    acBin.abort(new Error('binary abort reason'));
    await assert.rejects(
      execSshBinary({ id: 'a2', userHost: 'root@192.0.2.1' }, 'echo hi', { signal: acBin.signal, useControlMaster: false }),
      (err: unknown) => {
        const e = err as { name?: string; message?: string; cause?: { message?: string } };
        return e?.name === 'AbortError' && /binary abort reason/.test(`${e?.message ?? ''} ${e?.cause?.message ?? ''}`);
      },
    );

    // 4. Timeout kill with empty stderr must preserve error details instead of ""
    const timedOutText = await execSshText({ id: 't1', userHost: 'root@192.0.2.1' }, 'sleep 2', {
      timeoutMs: 80,
      useControlMaster: false,
    });
    assert.notEqual(timedOutText.code, 0);
    assert.ok(timedOutText.stderr.length > 0, 'timeout stderr must not be empty');

    const timedOutBin = await execSshBinary({ id: 't2', userHost: 'root@192.0.2.1' }, 'sleep 2', {
      timeoutMs: 80,
      useControlMaster: false,
    });
    assert.notEqual(timedOutBin.code, 0);
    assert.ok(timedOutBin.stderr.length > 0, 'binary timeout stderr must not be empty');

    // 5. Normal remote exit 1 with quiet stderr preserves empty stderr
    process.env.AUDIT_SSH_MODE = 'quiet1';
    const quiet1 = await execSshText({ id: 'q1', userHost: 'root@192.0.2.1' }, 'false', { useControlMaster: false });
    assert.equal(quiet1.code, 1);
    assert.equal(quiet1.stderr, '');

    // 6. Long homeDir (>100B sun_path) falls back to ControlMaster=no and must NOT retry on remote 255
    const longHome = join(root, 'long-segment-'.repeat(8));
    mkdirSync(longHome, { recursive: true });
    writeFileSync(countFile, '');
    process.env.AUDIT_SSH_MODE = 'muxtext255';
    const noMuxRes = await execSshText({ id: 'm1', userHost: 'root@192.0.2.1' }, 'probe', {
      homeDir: longHome,
      useControlMaster: true,
    });
    assert.equal(noMuxRes.code, 255);
    assert.equal(readFileSync(countFile, 'utf8').trim().split('\n').length, 1);
  } finally {
    process.env.PATH = origPath;
    delete process.env.AUDIT_SSH_MODE;
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit health-scale: ADC-before-stable-weight preserves 550ms completion, sex:null partial update works, and empty lock race is safe', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'friday-audit-health-'));
  try {
    // 1. Python MeasureSession: ADC arriving before stable PACKET_WEIGHT keeps 550ms completion timer
    const pyScript = [
      'import importlib.util, sys, types',
      'timers = []',
      'cancelled = []',
      'next_id = [10]',
      'class FakeGLib:',
      '    PRIORITY_DEFAULT = 0',
      '    @staticmethod',
      '    def timeout_add(ms, fn, *args):',
      '        tid = next_id[0]; next_id[0] += 1',
      '        timers.append((tid, ms, getattr(fn, "__name__", "<lambda>")))',
      '        return tid',
      '    @staticmethod',
      '    def source_remove(tid): cancelled.append(tid)',
      '    @staticmethod',
      '    def idle_add(fn): return 1',
      '    class MainLoop:',
      '        def quit(self): pass',
      'for mod in ["dbus", "dbus.mainloop", "dbus.mainloop.glib", "gi", "gi.repository"]:',
      '    sys.modules[mod] = types.ModuleType(mod)',
      'sys.modules["dbus"].SystemBus = lambda: None',
      'sys.modules["dbus"].Interface = lambda *a, **kw: None',
      'sys.modules["dbus.mainloop.glib"].DBusGMainLoop = lambda **kw: None',
      'sys.modules["gi.repository"].GLib = FakeGLib',
      `spec = importlib.util.spec_from_file_location("hsbh", ${JSON.stringify(join(REPO_ROOT, 'plugins/health-scale/ble_helper.py'))})`,
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'sess = object.__new__(m.MeasureSession)',
      `sess.state_file = ${JSON.stringify(join(dataDir, 'py-meas.json'))}`,
      'sess.stopping = False; sess.finished = False; sess.notifications = []',
      'sess.seen_stable_weight = False; sess.seen_adc = False',
      'sess.grace_timer_id = None; sess.profile_id = "owner"',
      'sess.state = {"phase": "measuring", "notifications": sess.notifications}',
      'def mk_pkt(ptype, body16):',
      '    b = bytearray(20); b[0] = 0xAC; b[1] = 0x27',
      '    b[2:18] = bytes(body16[:16]); b[18] = ptype',
      '    b[19] = (sum(b[2:19]) & 0x1F) | 0x20',
      '    return bytes(b)',
      'adc_body = [1, 0, 0x01, 0xF4] + [0]*12',
      'w_body = [(0x80 | 0x01), 0x00, 0x0B, 0x94] + [0]*12',
      'sess.handle_notification(mk_pkt(214, adc_body))',
      'assert sess.seen_adc is True',
      'assert len(timers) == 1 and timers[0][1] == 550, timers',
      'sess.handle_notification(mk_pkt(213, w_body))',
      'assert sess.seen_stable_weight is True',
      'assert len(timers) == 1, f"must NOT replace 550ms completion with 8500ms grace: {timers}"',
      'assert cancelled == [], cancelled',
    ].join('\n');
    await execFileAsync('python3', ['-c', pyScript]);

    // 2. Partial profile update with sex: null (from defaultArgs) does not throw validation error
    const createRes = await runHealthAction('profile-save', {
      id: 'owner',
      name: 'Alice',
      sex: 'female',
      age: 28,
      heightCm: 165,
      setDefault: true,
    }, { dataDir, nowFn: () => 1_700_000_000_000 });
    assert.equal(createRes.ok, true);

    const updateRes = await runHealthAction('profile-save', {
      id: 'owner',
      name: 'Alice2',
      sex: null,
    }, { dataDir, nowFn: () => 1_700_000_010_000 });
    assert.equal(updateRes.ok, true);
    const active = (updateRes.data as { activeProfile: { name: string; sex: string } }).activeProfile;
    assert.equal(active.name, 'Alice2');
    assert.equal(active.sex, 'female');

    // 3. Fresh empty live-session.lock (< 2s old) is not falsely broken as stale
    const lockPath = join(dataDir, 'live-session.lock');
    writeFileSync(lockPath, '');
    const busyRes = await runHealthAction('measure-start', {}, {
      dataDir,
      spawnMeasure: () => 0,
    });
    assert.equal(busyRes.ok, false);
    assert.match(String(busyRes.message), /已有另一路/);

    // Old (> 2s) corrupt empty lock IS recovered cleanly
    const oldSec = Date.now() / 1000 - 10;
    utimesSync(lockPath, oldSec, oldSec);
    const recoveredRes = await runHealthAction('measure-start', {}, {
      dataDir,
      spawnMeasure: () => 0,
    });
    assert.equal(recoveredRes.ok, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('audit laifen: V2 Pro set preserves mode/strength/range/speed, lock token isolation, config string booleans, and WatchSession cycle safety', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'friday-audit-laifen-'));
  let now = 1_760_500_000_000;
  try {
    // 1. V2 Pro set merges mode, strength, range, speed even when afterHex is 5A C1 03 status packet
    const v2Status = buildV2ProStatusHex({ battery: 89, durationSec: 180 });
    const setV2 = await runLaifenAction(
      'set',
      { mode: 2, strength: 8, range: 7, speed: 9 },
      {
        dataDir,
        nowFn: () => now,
        bleRunner: async () => ({
          ok: true,
          protocol: 'v2pro',
          device: { address: 'C0:00:00:11:22:33', name: 'LFTB02-PRO', rssi: -60 },
          baselineHex: v2Status,
          afterHex: v2Status,
          txLog: [{ label: 'v2pro_mode_params', txHex: 'AA010900000401080709A4' }],
        }),
      },
    );
    assert.equal(setV2.ok, true);
    const v2Dev = expectData<{ device: Record<string, unknown> }>(setV2).device;
    assert.equal(v2Dev.activeMode, 2);
    assert.equal(v2Dev.activeStrength, 8);
    assert.equal(v2Dev.activeRange, 7);
    assert.equal(v2Dev.activeSpeed, 9);

    // 2. handlePower with baselineHex only (refreshStatus: false) preserves baseline batteryPct
    const v1Base = buildV1StatusHex(67, 2);
    const calRes = await runLaifenAction(
      'power',
      { calibration: 'limp' },
      {
        dataDir,
        nowFn: () => now + 1000,
        bleRunner: async () => ({
          ok: true,
          protocol: 'v1',
          device: { address: 'C0:00:00:11:22:33', name: 'LFTB01-P', rssi: -61 },
          baselineHex: v1Base,
          afterHex: null,
          txLog: [],
        }),
      },
    );
    assert.equal(calRes.ok, true);
    assert.equal(expectData<{ device: { batteryPct: number } }>(calRes).device.batteryPct, 67);

    // 3. config with string autoWakeSync: 'true' / 'false' triggers watch start/stop
    let spawnedWatchCount = 0;
    const cfgOn = await runLaifenAction(
      'config',
      { autoWakeSync: 'true' },
      {
        dataDir,
        nowFn: () => now + 2000,
        spawnWatch: () => { spawnedWatchCount += 1; return process.pid; },
      },
    );
    assert.equal(cfgOn.ok, true);
    assert.equal(spawnedWatchCount, 1);
    assert.equal(expectData<{ autoWakeSync: boolean }>(cfgOn).autoWakeSync, true);

    // 4. Failed sync cleans up stale active live-session.json matching its sessionId
    const sPath = join(dataDir, 'live-session.json');
    const failedSync = await runLaifenAction(
      'sync',
      {},
      {
        dataDir,
        nowFn: () => now + 3000,
        bleRunner: async (cmdArgs: string[]) => {
          const sid = cmdArgs[cmdArgs.indexOf('--session-id') + 1]!;
          writeFileSync(sPath, JSON.stringify({
            sessionId: sid,
            pid: 999999,
            phase: 'monitoring',
            startedAt: now,
            updatedAt: now,
          }));
          return { ok: false, error: 'simulated timeout' };
        },
      },
    );
    assert.equal(failedSync.ok, false);
    const cleanedSession = JSON.parse(readFileSync(sPath, 'utf8')) as { phase: string };
    assert.equal(cleanedSession.phase, 'error');

    // 5. withManualBleYieldLock token isolation: first concurrent caller must NOT unlink second caller's ble-manual.lock
    const lockPath = join(dataDir, 'ble-manual.lock');
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstDone = new Promise<void>(r => { releaseFirst = r; });
    const secondDone = new Promise<void>(r => { releaseSecond = r; });
    let firstStarted!: () => void;
    let secondStarted!: () => void;
    const waitFirstStart = new Promise<void>(r => { firstStarted = r; });
    const waitSecondStart = new Promise<void>(r => { secondStarted = r; });

    const p1 = runLaifenAction('scan', {}, {
      dataDir,
      bleRunner: async () => {
        firstStarted();
        await firstDone;
        return { ok: true, devices: [] };
      },
    });
    await waitFirstStart;
    const p2 = runLaifenAction('scan', {}, {
      dataDir,
      bleRunner: async () => {
        secondStarted();
        await secondDone;
        return { ok: true, devices: [] };
      },
    });
    await waitSecondStart;
    releaseFirst();
    await p1;
    assert.equal(existsSync(lockPath), true, 'first call must NOT remove second call ble-manual.lock');
    releaseSecond();
    await p2;
    assert.equal(existsSync(lockPath), false, 'second call removes its own ble-manual.lock');

    // 6. Python ble_helper WatchSession: V2Pro None params & disconnect during refreshing_pending & StartNotify error cleanup
    const watchDir = join(dataDir, 'watch-py');
    const outboxDir = join(watchDir, 'watch-outbox');
    mkdirSync(outboxDir, { recursive: true });
    const pendingPath = join(watchDir, 'pending-patch.json');
    writeFileSync(pendingPath, JSON.stringify({ patchId: 'p-123', patch: { mode: 2 } }));

    const pyScript = [
      'import importlib.util, json, os, sys, types',
      'class FakeGLib:',
      '    PRIORITY_DEFAULT = 0',
      '    @staticmethod',
      '    def timeout_add(*a, **kw): return 1',
      '    @staticmethod',
      '    def source_remove(*a): pass',
      '    @staticmethod',
      '    def idle_add(*a): return 1',
      'for mod in ["dbus", "dbus.mainloop", "dbus.mainloop.glib", "gi", "gi.repository"]:',
      '    sys.modules[mod] = types.ModuleType(mod)',
      'sys.modules["dbus.mainloop.glib"].DBusGMainLoop = lambda **kw: None',
      'sys.modules["gi.repository"].GLib = FakeGLib',
      `spec = importlib.util.spec_from_file_location("lfbh", ${JSON.stringify(join(REPO_ROOT, 'plugins/laifen/ble_helper.py'))})`,
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'cmds = m.build_commands_from_patch("v2pro", {"mode": 2, "strength": None, "range": None, "speed": None}, None)',
      'assert len(cmds) == 1',
      'ws = object.__new__(m.WatchSession)',
      `ws.state_file = ${JSON.stringify(join(watchDir, 'watch-state.json'))}`,
      `ws.outbox_dir = ${JSON.stringify(outboxDir)}`,
      `ws.pending_file = ${JSON.stringify(pendingPath)}`,
      'ws.yield_lock_file = ""; ws.peer_session_file = ""',
      'ws.adapter = None; ws.device_path = "/dev/test"; ws.ff02_path = "/char/ff02"; ws.gap_name_path = None',
      'ws.device_snapshot = {"address": "C0:00:00:11:22:33", "name": "LFTB01-P"}',
      'ws.cooldown_sec = 45.0; ws.idle_hold_sec = 6.0; ws.outbox_seq = 0; ws.cycle_seq = 1; ws.started_at = 1000',
      'ws.cooldown_until = 0.0; ws.last_applied_patch_id = None; ws.last_flush_mono = 0.0; ws._last_flushed_sig = None',
      'ws.stopping = False; ws.finished = False; ws.services_handled = True; ws.connected = False; ws.connecting = False',
      'ws.settling_match = False; ws.discovery_active = False',
      'ws.notifications = []; ws.status_frames = []; ws.info_frames = []; ws.ack_frames = []; ws.status_seq = 0',
      'ws.state = {"phase": "syncing", "message": "", "error": None}',
      'for attr in ("scan_rsp_timer_id","settle_timer_id","connect_timer_id","resolve_timer_id","retry_timer_id","idle_release_timer_id","sync_emit_timer_id","status_wait_timer_id","grace_timer_id","ack_timer_id","write_delay_timer_id","refresh_timer_id","cycle_timer_id"):',
      '    setattr(ws, attr, None)',
      'ws._reset_cycle_state()',
      'ws.cycle_phase = "refreshing_pending"',
      'ws.cycle_pending_patch_id = "p-123"',
      `ws.cycle_latest_status_hex = ${JSON.stringify(v1Base)}`,
      'ws.cycle_baseline_raw = bytes.fromhex(ws.cycle_latest_status_hex)',
      'ws.cycle_cycling_notify = True',
      'ws._on_watch_cycle_start_notify()',
      'assert ws.cycle_cycling_notify is False',
      `assert not os.path.exists(${JSON.stringify(pendingPath)}), "pending patch must be consumed"`,
      'assert ws.last_applied_patch_id == "p-123"',
      'assert ws.state["phase"] == "cooldown"',
    ].join('\n');
    await execFileAsync('python3', ['-c', pyScript]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('audit netlea: scene+fan preserved, failed mode:temp-config/preset does not mutate config, clock tzHours=null & ISO timestamp, and clear metadata', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'friday-audit-netlea-'));
  try {
    // 1. modeCode + gear + fan preserves scene modeCode instead of falling back to custom modeCode 12
    const onSceneFan = await runNetleaAction(
      'on',
      { modeCode: 0, gear: 8, fan: 3, dryRun: true },
      { pluginDataDir: dataDir, platform: 'linux' },
    );
    assert.ok(onSceneFan);
    assert.equal(onSceneFan.ok, true);
    const onSceneData = expectData<{ meta: { modeCode: number; gear: number }; tx: string }>(onSceneFan);
    assert.equal(onSceneData.meta.modeCode, 0);
    assert.equal(onSceneData.meta.gear, 8);
    const expectedFrame = buildControlFrame({
      on: true,
      permanent: false,
      modeCode: 0,
      gear: 8,
      fan: 3,
      restoreSeconds: 20 * 60,
    });
    assert.equal(onSceneData.tx, expectedFrame);

    // 2. Failed mode:temp-config and schedule:preset must NOT mutate config.json
    const failRunner = async () => ({ ok: false, code: 'NOT_FOUND', error: 'lamp missing' });
    const tempFail = await runNetleaAction(
      'mode',
      { mode: 'temp-config', onMinutes: 99, offMinutes: 88, red: 10, green: 20, white: 30, blue: 40 },
      { pluginDataDir: dataDir, platform: 'linux', bleRunner: failRunner },
    );
    assert.ok(tempFail);
    assert.equal(tempFail.ok, false);

    const presetFail = await runNetleaAction(
      'schedule',
      { op: 'preset', preset: 'red_plant', lengthCm: 120, widthCm: 50, heightCm: 50 },
      { pluginDataDir: dataDir, platform: 'linux', bleRunner: failRunner },
    );
    assert.ok(presetFail);
    assert.equal(presetFail.ok, false);

    const cfgAfter = await runNetleaAction('config', {}, { pluginDataDir: dataDir, platform: 'linux' });
    const cfg = expectData<{ config: { tempOnMinutes: number; tempOffMinutes: number; tankSize: { lengthCm: number } } }>(cfgAfter).config;
    assert.equal(cfg.tempOnMinutes, 20);
    assert.equal(cfg.tempOffMinutes, 20);
    assert.equal(cfg.tankSize.lengthCm, 60);

    // 3. clock handles tzHours: null without forcing UTC+0 and preserves ISO timestamp in meta.syncedAt
    const isoTs = '2026-11-21T07:04:09.000Z';
    const clkDry = await runNetleaAction(
      'clock',
      { timestamp: isoTs, tzHours: null, dryRun: true },
      { pluginDataDir: dataDir, platform: 'linux' },
    );
    assert.ok(clkDry);
    assert.equal(clkDry.ok, true);
    assert.equal(expectData<{ meta: { syncedAt: string } }>(clkDry).meta.syncedAt, isoTs);

    // 4. schedule:clear reflects travelModel & sunrise/sunset in returned schedule
    const clrDry = await runNetleaAction(
      'schedule',
      { op: 'clear', travelModel: 1, sunriseMinutes: 15, sunsetMinutes: 25 },
      {
        pluginDataDir: dataDir,
        platform: 'linux',
        bleRunner: async () => ({
          ok: true,
          device: { address: 'AA:BB:CC:11:22:33', name: 'SG-X-PRO-60w11', rssi: -60 },
          replies: [],
        }),
      },
    );
    assert.ok(clrDry);
    assert.equal(clrDry.ok, true);
    const clearedSched = expectData<{ schedule: { travelModel: number; sunriseMinutes: number; sunsetMinutes: number } }>(clrDry).schedule;
    assert.equal(clearedSched.travelModel, 1);
    assert.equal(clearedSched.sunriseMinutes, 15);
    assert.equal(clearedSched.sunsetMinutes, 25);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

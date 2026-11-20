import assert from 'node:assert/strict';
import { execFile as execFileCb } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { listPluginsSync, listPluginViews, runPlugin } from '../src/plugin.js';

const execFileAsync = promisify(execFileCb);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type NetleaModule = {
  ACTIONS: string[];
  DEFAULT_CONFIG: {
    targetMac: string;
    namePrefix: string;
    fadeSeconds: number;
    defaultChannels: { red: number; green: number; white: number; blue: number; fan: number };
  };
  crc(bytes: number[]): number;
  buildAppFrame(deviceType: number, command: number, payload?: number[]): string;
  buildQueryStateFrame(): string;
  buildTempLightFrame(on: boolean, opts?: Record<string, unknown>): string;
  buildResumeScheduleFrame(lampStateHint?: number | boolean): string;
  decodeLampsStateFrame(hex: unknown): {
    rawHex: string;
    on: boolean;
    channels: { red: number; green: number; white: number; blue: number; fan: number };
    master: Record<string, number>;
    spot: Record<string, number>;
    atmosphere: Record<string, number>;
  } | null;
  decodeManufacturerData(mfgMap: Record<string, unknown> | null | undefined): {
    rtc: string;
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    flags: number;
    deviceType: number;
    realAddress: string;
    mac: string;
  } | null;
  normalizeMac(raw: unknown): string | null;
  resolveChannelsForOn(
    args?: Record<string, unknown>,
    defaultChannels?: { red: number; green: number; white: number; blue: number; fan: number },
  ): { red: number; green: number; white: number; blue: number; fan: number };
  runAction(
    action: string,
    args?: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};

async function loadPluginModule(): Promise<NetleaModule> {
  return await import('../plugins/netlea/index.mjs') as unknown as NetleaModule;
}

const GOLDEN_0X14_ON = '5A260114000001000001000145366236000000020000000002000000010000010001000000B2';
const GOLDEN_0X14_OFF = '5A2601140000010000000001000000000000000100000000020000000100000100010000009D';

test('Netlea 0x5A protocol frames, 0x14 decoding, and ManufacturerData RTC decoding match golden captures', async () => {
  const mod = await loadPluginModule();

  assert.equal(mod.buildQueryStateFrame(), '5A070113000075');
  assert.equal(mod.buildTempLightFrame(false, { onSeconds: 20, offSeconds: 20 }), '5A13011A0000140014000000000000000000B0');
  assert.equal(mod.buildResumeScheduleFrame(1), '5A17011000000100000000000000000000000000000083');
  assert.equal(mod.buildResumeScheduleFrame(0), '5A17011000000000000000000000000000000000000082');

  const customOnHex = mod.buildTempLightFrame(true, {
    red: 120,
    green: -5,
    white: 80,
    blue: 55,
    fan: 9,
    fadeSeconds: 2,
  });
  assert.equal(customOnHex.length, 38); // 19 bytes
  assert.equal(customOnHex.slice(0, 12), '5A13011A0000');
  // onSeconds=2 (0200), offSeconds=2 (0200), red=100(64), green=0(00), white=80(50), blue=55(37), fan=5(05), mode=1, grade=9
  assert.equal(customOnHex.slice(12, 36), '020002006400503705010900');

  const decodedOn = mod.decodeLampsStateFrame(GOLDEN_0X14_ON);
  assert.ok(decodedOn);
  assert.equal(decodedOn.on, true);
  assert.deepEqual(decodedOn.channels, { red: 69, green: 54, white: 98, blue: 54, fan: 0 });
  assert.equal(decodedOn.master.stateType, 1);

  const decodedOff = mod.decodeLampsStateFrame(GOLDEN_0X14_OFF);
  assert.ok(decodedOff);
  assert.equal(decodedOff.on, false);
  assert.deepEqual(decodedOff.channels, { red: 0, green: 0, white: 0, blue: 0, fan: 0 });

  // Bad checksum or truncated frame returns null
  assert.equal(mod.decodeLampsStateFrame(`${GOLDEN_0X14_ON.slice(0, -2)}00`), null);
  assert.equal(mod.decodeLampsStateFrame('5A070114000076'), null);

  const adv = mod.decodeManufacturerData({ '0x0000': '1a0b15011b398101aabbccddeeff' });
  assert.ok(adv);
  assert.equal(adv.rtc, '2026-11-21 01:27:57');
  assert.equal(adv.deviceType, 1);
  assert.equal(adv.mac, 'AA:BB:CC:DD:EE:FF');
  assert.equal(adv.realAddress, 'AABBCCDDEEFF');
});

test('Netlea plugin actions work end-to-end with mocked bleRunner and file persistence', async () => {
  const mod = await loadPluginModule();
  const dataDir = mkdtempSync(join(tmpdir(), 'netlea-plugin-test-'));

  try {
    const calls: string[][] = [];
    let currentStateHex = GOLDEN_0X14_OFF;

    const mockBleRunner = async (cmdArgs: string[]) => {
      calls.push(cmdArgs);
      if (cmdArgs[0] === 'scan') {
        return {
          ok: true,
          devices: [
            {
              address: 'AA:BB:CC:11:22:33',
              name: 'SG-X-PRO-60w11',
              rssi: -62,
              uuids: ['0000faff-0000-1000-8000-00805f9b34fb'],
              manufacturerData: { '0x0000': '1a0b15011b398101aabbcc112233' },
              connected: false,
            },
          ],
        };
      }
      if (cmdArgs[0] === 'command') {
        const txIdx = cmdArgs.indexOf('--tx');
        const tx = txIdx >= 0 ? cmdArgs[txIdx + 1] ?? '' : '';
        if (tx.startsWith('5A13011A')) {
          const isZero = tx.slice(20, 30) === '0000000000';
          currentStateHex = isZero ? GOLDEN_0X14_OFF : GOLDEN_0X14_ON;
        } else if (tx.startsWith('5A170110')) {
          currentStateHex = tx.slice(12, 14) === '01' ? GOLDEN_0X14_ON : GOLDEN_0X14_OFF;
        }
        return {
          ok: true,
          device: {
            address: 'AA:BB:CC:11:22:33',
            name: 'SG-X-PRO-60w11',
            rssi: -61,
            uuids: ['0000faff-0000-1000-8000-00805f9b34fb'],
            manufacturerData: { '0x0000': '1a0b15011b398101aabbcc112233' },
          },
          tx,
          replies: [{ char: 'char0029', hex: currentStateHex, at: 1795195800000 }],
          stateHex: currentStateHex,
        };
      }
      throw new Error(`Unexpected bleRunner subcommand: ${cmdArgs[0]}`);
    };

    const deps = {
      pluginDataDir: dataDir,
      platform: 'linux',
      bleRunner: mockBleRunner,
      nowFn: () => 1_795_195_800_000,
    };

    // 1. config normalizes MAC and rejects invalid MAC
    const badCfg = await mod.runAction('config', { targetMac: 'not-a-mac' }, deps);
    assert.equal(badCfg.ok, false);

    const okCfg = await mod.runAction(
      'config',
      { targetMac: 'aabbcc112233', fadeSeconds: 5, defaultChannels: { red: 60, green: 50, white: 80, blue: 40, fan: 1 } },
      deps,
    );
    assert.equal(okCfg.ok, true);
    const cfgData = (okCfg.data as { config: Record<string, unknown> }).config;
    assert.equal(cfgData.targetMac, 'AA:BB:CC:11:22:33');
    assert.equal(cfgData.fadeSeconds, 5);

    // 2. scan discovers device & caches lastAddress
    const scanRes = await mod.runAction('scan', { timeoutSec: 3 }, deps);
    assert.equal(scanRes.ok, true);
    const scannedDevs = (scanRes.data as { devices: Array<Record<string, unknown>> }).devices;
    assert.equal(scannedDevs.length, 1);
    assert.equal((scannedDevs[0]?.advertisement as Record<string, unknown>)?.rtc, '2026-11-21 01:27:57');

    // 3. status live: true sends 5A070113000075
    const statusRes = await mod.runAction('status', {}, deps);
    assert.equal(statusRes.ok, true);
    const lastCmdArgs = calls.at(-1) ?? [];
    assert.equal(lastCmdArgs[0], 'command');
    assert.equal(lastCmdArgs[lastCmdArgs.indexOf('--tx') + 1], '5A070113000075');

    // 4. dryRun on with brightness=50 scales defaultChannels without calling bleRunner
    const callsBeforeDry = calls.length;
    const dryOn = await mod.runAction('on', { brightness: 50, dryRun: true }, deps);
    assert.equal(dryOn.ok, true);
    assert.equal(calls.length, callsBeforeDry);
    assert.deepEqual((dryOn.data as Record<string, unknown>).channels, {
      red: 30,
      green: 25,
      white: 40,
      blue: 20,
      fan: 1,
    });

    // 5. on with explicit overrides
    const onRes = await mod.runAction('on', { red: 69, green: 54, white: 98, blue: 54, fan: 0 }, deps);
    assert.equal(onRes.ok, true);
    assert.equal((onRes.data as { state: { on: boolean } }).state.on, true);

    // 6. status live: false and dashboard (default) read cached last-state.json without bleRunner
    const callsBeforeCache = calls.length;
    const cachedRes = await mod.runAction('status', { live: false }, deps);
    assert.equal(cachedRes.ok, true);
    assert.equal(calls.length, callsBeforeCache);
    assert.equal((cachedRes.data as { state: { on: boolean } }).state.on, true);

    const dashCached = await mod.runAction('dashboard', {}, deps);
    assert.equal(dashCached.ok, true);
    assert.equal(dashCached.notify, false);
    assert.equal(calls.length, callsBeforeCache);
    const dashData = dashCached.data as Record<string, unknown>;
    assert.equal(dashData['状态'], '开启 · W98%');
    assert.equal(dashData['光谱'], 'R69 G54 W98 B54');
    assert.equal(dashData['灯内时钟'], '01:27:57');
    assert.equal(dashData.refreshed, false);

    // 6b. dashboard refresh: true runs live BLE query and updates cache
    const dashRefresh = await mod.runAction('dashboard', { refresh: true }, deps);
    assert.equal(dashRefresh.ok, true);
    assert.equal(dashRefresh.notify, false);
    assert.equal(calls.length, callsBeforeCache + 1);
    assert.equal((dashRefresh.data as Record<string, unknown>).refreshed, true);

    // 7. off turns light off and brightness=0 delegates to off
    const offRes = await mod.runAction('off', {}, deps);
    assert.equal(offRes.ok, true);
    assert.equal((offRes.data as { state: { on: boolean } }).state.on, false);

    const zeroOnRes = await mod.runAction('on', { brightness: 0, dryRun: true }, deps);
    assert.equal(zeroOnRes.ok, true);
    assert.equal((zeroOnRes.data as Record<string, unknown>).action, 'off');

    // 8. resume sends 0x10 frame
    const resRes = await mod.runAction('resume', { lampStateHint: 1 }, deps);
    assert.equal(resRes.ok, true);
    assert.equal((resRes.data as Record<string, unknown>).tx, '5A17011000000100000000000000000000000000000083');

    // 9. NOT_FOUND surfaces friendly occupancy guidance
    const notFoundRes = await mod.runAction('status', {}, {
      ...deps,
      bleRunner: async () => ({ ok: false, code: 'NOT_FOUND', error: 'missing' }),
    });
    assert.equal(notFoundRes.ok, false);
    assert.match(String(notFoundRes.message), /App/);

    // 10. Non-linux platform without bleRunner disables BLE cleanly
    const darwinRes = await mod.runAction('status', {}, { pluginDataDir: dataDir, platform: 'darwin' });
    assert.equal(darwinRes.ok, false);
    assert.equal(darwinRes.title, '当前系统已关闭尼特利蓝牙控制');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Friday plugin registry discovers netlea, toggles by platform, and enforces storage & path hardening', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-netlea-home-'));
  const rogueDir = mkdtempSync(join(tmpdir(), 'friday-netlea-rogue-'));
  try {
    const darwinManifest = listPluginsSync(home, { platform: 'darwin' }).find(p => p.name === 'netlea');
    assert.ok(darwinManifest, 'netlea must be discovered on darwin');
    assert.equal(darwinManifest.enabled, false, 'netlea must be disabled on darwin');
    assert.equal(darwinManifest.voiceFastpath, false);

    const darwinView = listPluginViews(home, { platform: 'darwin' }).find(p => p.name === 'netlea');
    assert.ok(darwinView);
    assert.equal(darwinView.enabled, false);

    const linuxManifest = listPluginsSync(home, { platform: 'linux' }).find(p => p.name === 'netlea');
    assert.ok(linuxManifest, 'netlea must be discovered on linux');
    assert.equal(linuxManifest.enabled, true, 'netlea must be enabled on linux');
    assert.equal(linuxManifest.runtime, 'in-process');
    assert.equal(linuxManifest.voiceFastpath, false);

    // Run config via host runPlugin and confirm args.dataDir/args.pluginDataDir cannot escape
    const cfgRes = await runPlugin(home, 'netlea', 'config', {
      dataDir: rogueDir,
      pluginDataDir: rogueDir,
      targetMac: '11:22:33:44:55:66',
    });
    assert.equal(cfgRes.ok, true);
    const safePluginDir = join(home, 'plugins', 'netlea');
    const cfgFile = join(safePluginDir, 'config.json');
    assert.equal(existsSync(cfgFile), true);
    assert.equal(existsSync(join(rogueDir, 'config.json')), false);
    assert.equal(statSync(cfgFile).mode & 0o777, 0o600);

    // Output must never expose host configPath or pluginDataDir
    const cfgData = cfgRes.data as Record<string, unknown>;
    assert.equal('configPath' in cfgData, false);
    assert.equal(String(cfgRes.message).includes(safePluginDir), false);
    assert.equal(JSON.stringify(cfgData).includes(home), false);

    const statusCacheRes = await runPlugin(home, 'netlea', 'status', { live: false });
    assert.equal(statusCacheRes.ok, true);
    assert.equal(JSON.stringify(statusCacheRes.data ?? {}).includes(home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(rogueDir, { recursive: true, force: true });
  }
});

test('Python ble_helper.py matching and 0x14/0x02 reply detection work correctly', async () => {
  const pyScript = [
    'import importlib.util, json, sys, types',
    'for mod in ["dbus", "dbus.mainloop", "dbus.mainloop.glib", "gi", "gi.repository"]:',
    '    sys.modules[mod] = types.ModuleType(mod)',
    'sys.modules["dbus.mainloop.glib"].DBusGMainLoop = lambda **kw: None',
    'sys.modules["gi.repository"].GLib = types.SimpleNamespace()',
    `spec = importlib.util.spec_from_file_location("nbh", ${JSON.stringify(join(REPO_ROOT, 'plugins/netlea/ble_helper.py'))})`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    'assert m.matches_netlea({"address": "AA:BB:CC:11:22:33", "name": "Other", "uuids": []}, "aa:bb:cc:11:22:33", "SG-")',
    'assert not m.matches_netlea({"address": "AA:BB:CC:11:22:34", "name": "SG-X-PRO-60w11", "uuids": [m.ADV_FAFF_UUID]}, "AA:BB:CC:11:22:33", "SG-")',
    'assert m.matches_netlea({"address": "AA:BB:CC:11:22:34", "name": "SG-X-PRO-60w11", "uuids": []}, "", "SG-")',
    'assert m.matches_netlea({"address": "AA:BB:CC:11:22:34", "name": "", "uuids": [m.ADV_FAFF_UUID]}, "", "SG-")',
    `assert m.is_expected_netlea_reply(bytes.fromhex(${JSON.stringify(GOLDEN_0X14_ON)})) == (True, True)`,
    'assert m.is_expected_netlea_reply(bytes.fromhex("5A0F0102000010000000000000007C")) == (True, False)',
    'assert m.is_expected_netlea_reply(bytes.fromhex("5A070114000076")) == (False, False)',
  ].join('\n');
  await execFileAsync('python3', ['-c', pyScript]);
});

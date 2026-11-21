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

type NetleaChannels = { red: number; green: number; white: number; blue: number; fan: number };
type NetleaPwmMap = { red: number; white: number; green: number; blue: number; fan: number };

type NetleaTrip = {
  enable: number;
  dayList: number[];
  startH: number;
  startM: number;
  endH: number;
  endM: number;
  modeCode: number;
  gear: number;
  red: number;
  green: number;
  white: number;
  blue: number;
  fan: number;
  pwm: number[];
  powerWatts: number;
  name: string;
  seriesName?: string;
  hasSunrise?: boolean;
  hasSunset?: boolean;
};

type NetleaSchedule = {
  rawHex: string;
  travelModel: number;
  sunEnable: number;
  sunriseMinutes: number;
  sunsetMinutes: number;
  trips: NetleaTrip[];
};

type NetleaModule = {
  ACTIONS: string[];
  DEFAULT_CONFIG: {
    targetMac: string;
    namePrefix: string;
    fadeSeconds: number;
    tempOnMinutes: number;
    tempOffMinutes: number;
    tankSize: { lengthCm: number; widthCm: number; heightCm: number; lampCount: number };
    defaultChannels: NetleaChannels;
    savedCustomPresets: unknown[];
  };
  crc(bytes: number[]): number;
  hexBytes(raw: unknown): number[];
  buildAppFrame(deviceType: number, command: number, payload?: number[], optByte4?: number, optByte5?: number): string;
  buildQueryStateFrame(): string;
  buildQueryStatusFrame(): string;
  buildQueryTempConfigFrame(): string;
  buildQueryScheduleFrame(): string;
  buildClockSyncFrame(dateInput?: Date | number | string, opts?: { groupId?: number; devId?: number; tzHours?: number }): string;
  buildControlFrame(opts?: Record<string, unknown>): string;
  buildResumeScheduleFrame(lampStateHint?: number | boolean, restoreSeconds?: number): string;
  buildTempConfigFrame(opts?: Record<string, unknown>): string;
  buildTempLightFrame(on: boolean, opts?: Record<string, unknown>): string;
  decodeTempConfigFrame(hex: unknown, modelName?: string): {
    rawHex: string;
    onMinutes: number;
    offMinutes: number;
    pwm: NetleaPwmMap;
    channels: NetleaChannels;
    powerWatts: number;
    modeCode: number;
    gear: number;
    matchedScene: { modeCode: number; seriesName: string; name: string; gear: number; powerWatts: number } | null;
  } | null;
  buildMainScheduleFrame(
    schedule: { travelModel?: number; sunriseMinutes?: number; sunsetMinutes?: number; trips?: unknown[] },
    modelName?: string,
  ): string;
  decodeMainScheduleFrame(hex: unknown, modelName?: string): NetleaSchedule | null;
  decodeLampsStateFrame(hex: unknown, modelName?: string): {
    rawHex: string;
    on: boolean;
    haveTravel: boolean;
    scheduleRunning: boolean;
    runMode: string;
    runModeLabel: string;
    pwm: NetleaPwmMap;
    channels: NetleaChannels;
    powerWatts: number;
    maxWatts: number;
    matchedScene: { modeCode: number; seriesName: string; name: string; gear: number; powerWatts: number } | null;
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
  resolveChannelsForOn(args?: Record<string, unknown>, defaultChannels?: NetleaChannels): NetleaChannels;
  runAction(
    action: string,
    args?: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};

type XproProfile = {
  key: string;
  maxWatts: number;
  limitWatts: number;
};

type XproProfilesModule = {
  CULTIVATION_PRESETS: Array<{ id: string; type: number; name: string }>;
  resolveXproProfile(modelOrDeviceName: unknown): XproProfile;
  encodeCustomChannelsPwm(
    profile: XproProfile,
    rawChannels: Record<string, unknown>,
    opts?: { clampToMaxPower?: boolean },
  ): {
    modeCode: number;
    gear: number;
    pwm: number[];
    channels: NetleaChannels;
    powerWatts: number;
    maxWatts: number;
    powerClamped: boolean;
  };
  encodeSceneGearPwm(
    profile: XproProfile,
    modeCode: number,
    gear: number,
    fan?: number,
  ): {
    modeCode: number;
    seriesName: string;
    sceneName: string;
    gear: number;
    pwm: number[];
    channels: NetleaChannels;
    powerWatts: number;
  };
  buildPresetSchedule(
    presetIdOrName: string,
    opts?: Record<string, unknown>,
    profile?: XproProfile,
  ): {
    presetId: string;
    presetName: string;
    travelModel: number;
    sunriseMinutes: number;
    sunsetMinutes: number;
    tankSize: { lengthCm: number; widthCm: number; heightCm: number; lampCount: number };
    targetBaseWatts: number;
    trips: NetleaTrip[];
  };
};

async function loadPluginModule(): Promise<NetleaModule> {
  return await import('../plugins/netlea/index.mjs') as unknown as NetleaModule;
}

async function loadProfilesModule(): Promise<XproProfilesModule> {
  return await import('../plugins/netlea/xpro-profiles.mjs') as unknown as XproProfilesModule;
}

const GOLDEN_0X14_ON = '5A260114000001000001000145366236000000020000000002000000010000010001000000B2';
const GOLDEN_0X14_OFF = '5A2601140000010000000001000000000000000100000000020000000100000100010000009D';
const GOLDEN_0X1A_TEMP = '5A13011A0000030003004536623600010900AB';

test('Netlea v2.90 0x5A frames, [R,W,G,B,F] calibration, 22W guard, 0x12 schedule & presets match golden specs', async () => {
  const mod = await loadPluginModule();
  const prof = await loadProfilesModule();

  // 1. Query frames
  assert.equal(mod.buildQueryStateFrame(), '5A070113000075');
  assert.equal(mod.buildQueryStatusFrame(), '5A070115000077');
  assert.equal(mod.buildQueryTempConfigFrame(), '5A07011B00007D');
  assert.equal(mod.buildQueryScheduleFrame(), '5A0801250000078F');

  // 2. 0x04 RTC clock sync frame (16B) with UTC+8 and negative timezone
  const clockHex = mod.buildClockSyncFrame(new Date(2026, 10, 21, 15, 4, 9), { tzHours: 8 });
  assert.equal(clockHex.length, 32);
  assert.equal(clockHex.slice(0, 30), '5A10010400000001081A0B150F0409');
  const clockBytes = mod.hexBytes(clockHex);
  assert.equal(mod.crc(clockBytes.slice(0, -1)), clockBytes[clockBytes.length - 1]);

  const negTzHex = mod.buildClockSyncFrame(new Date(2026, 10, 21, 15, 4, 9), { tzHours: -5 });
  assert.equal(negTzHex.slice(16, 18), '85'); // abs(-5) + 128 = 133 = 0x85

  // 3. 0x10 control & resume frames (23B)
  assert.equal(mod.buildResumeScheduleFrame(1), '5A17011000000100000000000000000100000000000084');
  assert.equal(mod.buildResumeScheduleFrame(0), '5A17011000000000000000000000000100000000000083');

  const manualSceneHex = mod.buildControlFrame({
    on: true,
    permanent: true,
    modeCode: 0,
    gear: 8,
    modelName: 'SG-X-PRO-60w11',
  });
  assert.equal(manualSceneHex.length, 46); // 23 bytes
  assert.equal(manualSceneHex.slice(12, 16), '0101'); // lampState=1, mainForever=1
  assert.equal(manualSceneHex.slice(20, 30), '4536623600'); // [69, 54, 98, 54, 0]

  // 4. 0x1A temp config decode (golden hardware capture) & roundtrip
  const goldenTemp = mod.decodeTempConfigFrame(GOLDEN_0X1A_TEMP, 'SG-X-PRO-60w11');
  assert.ok(goldenTemp);
  assert.equal(goldenTemp.onMinutes, 3);
  assert.equal(goldenTemp.offMinutes, 3);
  assert.deepEqual(goldenTemp.pwm, { red: 69, white: 54, green: 98, blue: 54, fan: 0 });
  assert.deepEqual(goldenTemp.channels, { red: 42, green: 60, white: 77, blue: 38, fan: 0 });
  assert.equal(goldenTemp.powerWatts, 18);

  const builtTempHex = mod.buildTempConfigFrame({
    on: true,
    onMinutes: 25,
    offMinutes: 15,
    modeCode: 0,
    gear: 8,
    modelName: 'SG-X-PRO-60w11',
  });
  assert.equal(builtTempHex.length, 38); // 19 bytes
  const decodedTemp = mod.decodeTempConfigFrame(builtTempHex, 'SG-X-PRO-60w11');
  assert.ok(decodedTemp);
  assert.equal(decodedTemp.onMinutes, 25);
  assert.equal(decodedTemp.offMinutes, 15);
  assert.equal(decodedTemp.modeCode, 0);
  assert.equal(decodedTemp.gear, 8);
  assert.equal(decodedTemp.powerWatts, 18);

  // 5. 0x14 lamp state decoding (hardware order [R, W, G, B, F])
  const decodedOn = mod.decodeLampsStateFrame(GOLDEN_0X14_ON, 'SG-X-PRO-60w11');
  assert.ok(decodedOn);
  assert.equal(decodedOn.on, true);
  assert.equal(decodedOn.haveTravel, false);
  assert.deepEqual(decodedOn.pwm, { red: 69, white: 54, green: 98, blue: 54, fan: 0 });
  assert.deepEqual(decodedOn.channels, { red: 42, green: 60, white: 77, blue: 38, fan: 0 });
  assert.equal(decodedOn.powerWatts, 18);
  assert.equal(decodedOn.maxWatts, 22);
  assert.ok(decodedOn.matchedScene);
  assert.equal(decodedOn.matchedScene.modeCode, 0);
  assert.equal(decodedOn.matchedScene.seriesName, '水草');
  assert.equal(decodedOn.matchedScene.name, '正白');
  assert.equal(decodedOn.matchedScene.gear, 8);
  assert.equal(decodedOn.master.stateType, 1);

  const decodedOff = mod.decodeLampsStateFrame(GOLDEN_0X14_OFF, 'SG-X-PRO-60w11');
  assert.ok(decodedOff);
  assert.equal(decodedOff.on, false);
  assert.deepEqual(decodedOff.channels, { red: 0, green: 0, white: 0, blue: 0, fan: 0 });
  assert.equal(decodedOff.powerWatts, 0);

  // Bad checksum or truncated frame returns null
  assert.equal(mod.decodeLampsStateFrame(`${GOLDEN_0X14_ON.slice(0, -2)}00`), null);
  assert.equal(mod.decodeLampsStateFrame('5A070114000076'), null);

  // 6. 22W power cap on SG-X-PRO-60 and 10W power cap on 52-point SG-X-PRO-30
  const profile60 = prof.resolveXproProfile('SG-X-PRO-60w11');
  assert.equal(profile60.maxWatts, 22);
  const clamped60 = prof.encodeCustomChannelsPwm(profile60, { red: 100, green: 100, white: 100, blue: 100, fan: 0 });
  assert.equal(clamped60.powerClamped, true);
  assert.ok(clamped60.powerWatts <= 22 && clamped60.powerWatts >= 18);

  const profile30 = prof.resolveXproProfile('SG-X-PRO-30');
  assert.equal(profile30.maxWatts, 10);
  const clamped30 = prof.encodeCustomChannelsPwm(profile30, { red: 100, green: 100, white: 100, blue: 100, fan: 0 });
  assert.equal(clamped30.powerClamped, true);
  assert.ok(clamped30.powerWatts <= 10 && clamped30.powerWatts >= 7);

  // 7. 0x12 152-byte schedule roundtrip + sunrise/sunset contiguous logic + overlap validation
  const schedHex = mod.buildMainScheduleFrame(
    {
      travelModel: 1,
      sunriseMinutes: 30,
      sunsetMinutes: 45,
      trips: [
        {
          enable: 1,
          dayList: [1, 1, 1, 1, 1, 0, 0],
          startH: 9,
          startM: 0,
          endH: 13,
          endM: 0,
          modeCode: 0,
          gear: 8,
        },
        {
          enable: 1,
          dayList: [1, 1, 1, 1, 1, 0, 0],
          startH: 13,
          startM: 0,
          endH: 17,
          endM: 0,
          modeCode: 12,
          red: 35,
          green: 50,
          white: 70,
          blue: 30,
        },
      ],
    },
    'SG-X-PRO-60w11',
  );
  assert.equal(schedHex.length, 304); // 152 bytes

  const decodedSched = mod.decodeMainScheduleFrame(schedHex, 'SG-X-PRO-60w11');
  assert.ok(decodedSched);
  assert.equal(decodedSched.travelModel, 1);
  assert.equal(decodedSched.sunEnable, 1);
  assert.equal(decodedSched.sunriseMinutes, 30);
  assert.equal(decodedSched.sunsetMinutes, 45);
  assert.equal(decodedSched.trips.length, 2);
  assert.deepEqual(decodedSched.trips[0]?.dayList, [1, 1, 1, 1, 1, 0, 0]);
  assert.equal(decodedSched.trips[0]?.modeCode, 0);
  assert.equal(decodedSched.trips[0]?.gear, 8);
  assert.equal(decodedSched.trips[0]?.hasSunrise, true);
  assert.equal(decodedSched.trips[0]?.hasSunset, false);
  assert.equal(decodedSched.trips[1]?.modeCode, 12);
  assert.equal(decodedSched.trips[1]?.hasSunrise, false);
  assert.equal(decodedSched.trips[1]?.hasSunset, true);
  // White PWM only has 68 discrete levels across 0..100%, so decoded % may quantize by <= 1% while PWM bytes match identically.
  assert.equal(decodedSched.trips[1]?.red, 35);
  assert.equal(decodedSched.trips[1]?.green, 50);
  assert.ok(Math.abs((decodedSched.trips[1]?.white ?? 0) - 70) <= 1);
  assert.equal(decodedSched.trips[1]?.blue, 30);

  // Reject overlapping intervals on same weekday & identical start/end
  assert.throws(
    () =>
      mod.buildMainScheduleFrame({
        trips: [
          { enable: 1, dayList: [1, 0, 0, 0, 0, 0, 0], startH: 9, startM: 0, endH: 13, endM: 0, modeCode: 0, gear: 8 },
          { enable: 1, dayList: [1, 0, 0, 0, 0, 0, 0], startH: 12, startM: 30, endH: 16, endM: 0, modeCode: 1, gear: 6 },
        ],
      }),
    /重叠/,
  );
  assert.throws(
    () =>
      mod.buildMainScheduleFrame({
        trips: [{ enable: 1, dayList: [1, 1, 1, 1, 1, 1, 1], startH: 10, startM: 0, endH: 10, endM: 0, modeCode: 0, gear: 8 }],
      }),
    /相同/,
  );

  // 8. All 6 official cultivation presets build valid 152B schedules
  assert.equal(prof.CULTIVATION_PRESETS.length, 6);
  for (const p of prof.CULTIVATION_PRESETS) {
    const built = prof.buildPresetSchedule(
      p.id,
      { lengthCm: 60, widthCm: 30, heightCm: 36, lampCount: 1, startHour: 9, startMinute: 0, sunriseMinutes: 20, sunsetMinutes: 20 },
      profile60,
    );
    assert.ok(built.trips.length >= 1 && built.trips.length <= 10);
    const presetHex = mod.buildMainScheduleFrame(built, profile60.key);
    assert.equal(presetHex.length, 304);
  }

  // 9. ManufacturerData RTC decoding
  const adv = mod.decodeManufacturerData({ '0x0000': '1a0b15011b398101aabbccddeeff' });
  assert.ok(adv);
  assert.equal(adv.rtc, '2026-11-21 01:27:57');
  assert.equal(adv.deviceType, 1);
  assert.equal(adv.mac, 'AA:BB:CC:DD:EE:FF');
  assert.equal(adv.realAddress, 'AABBCCDDEEFF');
});

test('Netlea plugin all 10 actions work end-to-end with mocked bleRunner and file persistence', async () => {
  const mod = await loadPluginModule();
  const dataDir = mkdtempSync(join(tmpdir(), 'netlea-plugin-test-'));

  try {
    const calls: string[][] = [];
    let currentStateHex = GOLDEN_0X14_OFF;
    let currentTempHex = GOLDEN_0X1A_TEMP;
    let currentScheduleHex = '';
    let transientConnectFailures = 0;

    const buildStateHexFromPwm = (on: boolean, manualMode: boolean, haveTravel: boolean, pwmBytes: number[]) => {
      const payload = [
        1, 0, 0, on ? 1 : 0, manualMode ? 1 : 0, haveTravel ? 2 : 1,
        pwmBytes[0] ?? 0, pwmBytes[1] ?? 0, pwmBytes[2] ?? 0, pwmBytes[3] ?? 0, pwmBytes[4] ?? 0,
        0, 0,
        2, 0, 0, 0, 0, 2, 0, 0, 0,
        1, 0, 0, 1, 0, 1, 0, 0, 0,
      ];
      return mod.buildAppFrame(0x01, 0x14, payload);
    };

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
        if (transientConnectFailures > 0) {
          transientConnectFailures -= 1;
          return { ok: false, code: 'CONNECT_FAILED', error: 'transient le-connection-abort-by-local' };
        }
        const txIdx = cmdArgs.indexOf('--tx');
        const txRaw = txIdx >= 0 ? cmdArgs[txIdx + 1] ?? '' : '';
        const frames = txRaw.split(',').filter(Boolean);
        const replies: Array<{ char: string; hex: string; at: number }> = [];

        for (const frame of frames) {
          const bytes = mod.hexBytes(frame);
          const cmd = bytes[3];
          if (cmd === 0x10) {
            const on = bytes[6] === 1;
            const forever = bytes[7] === 1;
            const pwm = [bytes[10] ?? 0, bytes[11] ?? 0, bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0];
            const restoreSec = (bytes[15] ?? 0) | ((bytes[16] ?? 0) << 8);
            const isResume = restoreSec === 1 && pwm.every(b => b === 0);
            if (isResume) {
              currentStateHex = buildStateHexFromPwm(true, false, Boolean(currentScheduleHex), [69, 54, 98, 54, 0]);
            } else {
              currentStateHex = buildStateHexFromPwm(on, forever, Boolean(currentScheduleHex), pwm);
            }
          } else if (cmd === 0x1a) {
            currentTempHex = frame;
          } else if (cmd === 0x12) {
            const hasTrip = mod.decodeMainScheduleFrame(frame, 'SG-X-PRO-60w11')?.trips.length ?? 0;
            currentScheduleHex = hasTrip > 0 ? frame : '';
            currentStateHex = buildStateHexFromPwm(true, false, hasTrip > 0, [69, 54, 98, 54, 0]);
          } else if (cmd === 0x04) {
            replies.push({ char: '0000ff01-0000-1000-8000-00805f9b34fb', hex: '5A0F0102000010000000000000007C', at: 1_795_195_800_000 });
          }
        }

        replies.push({ char: '0000ff01-0000-1000-8000-00805f9b34fb', hex: currentStateHex, at: 1_795_195_800_010 });
        const wantsTemp = frames.some(f => {
          const c = mod.hexBytes(f)[3];
          return c === 0x1a || c === 0x1b;
        });
        const wantsSched = frames.some(f => mod.hexBytes(f)[3] === 0x25) && Boolean(currentScheduleHex);
        if (wantsTemp) {
          replies.push({ char: '0000ff01-0000-1000-8000-00805f9b34fb', hex: currentTempHex, at: 1_795_195_800_020 });
        }
        if (wantsSched) {
          replies.push({ char: '0000ff01-0000-1000-8000-00805f9b34fb', hex: currentScheduleHex, at: 1_795_195_800_030 });
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
          tx: txRaw,
          replies,
          stateHex: currentStateHex,
          ...(wantsTemp ? { tempConfigHex: currentTempHex } : {}),
          ...(wantsSched ? { scheduleHex: currentScheduleHex } : {}),
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

    // 1. config normalizes MAC, temp minutes, tankSize & savedCustomPresets, and rejects invalid MAC
    const badCfg = await mod.runAction('config', { targetMac: 'not-a-mac' }, deps);
    assert.equal(badCfg.ok, false);

    const okCfg = await mod.runAction(
      'config',
      {
        targetMac: 'aabbcc112233',
        tempOnMinutes: 15,
        tempOffMinutes: 10,
        tankSize: { lengthCm: 60, widthCm: 30, heightCm: 36, lampCount: 1 },
        defaultChannels: { red: 60, green: 50, white: 80, blue: 40, fan: 1 },
        savedCustomPresets: [{ name: '夜间微光', red: 10, green: 15, white: 20, blue: 15, fan: 0 }],
      },
      deps,
    );
    assert.equal(okCfg.ok, true);
    const cfgData = (okCfg.data as { config: Record<string, unknown> }).config;
    assert.equal(cfgData.targetMac, 'AA:BB:CC:11:22:33');
    assert.equal(cfgData.tempOnMinutes, 15);
    assert.equal(cfgData.tempOffMinutes, 10);
    assert.equal((cfgData.savedCustomPresets as Array<Record<string, unknown>>)[0]?.name, '夜间微光');

    // 2. scan discovers device & caches lastAddress
    const scanRes = await mod.runAction('scan', { timeoutSec: 3 }, deps);
    assert.equal(scanRes.ok, true);
    const scannedDevs = (scanRes.data as { devices: Array<Record<string, unknown>> }).devices;
    assert.equal(scannedDevs.length, 1);
    assert.equal((scannedDevs[0]?.advertisement as Record<string, unknown>)?.rtc, '2026-11-21 01:27:57');

    // 3. status live: true sends batch 0x15,0x1B,0x25 (or 0x15 minimal)
    const statusRes = await mod.runAction('status', {}, deps);
    assert.equal(statusRes.ok, true);
    const lastCmdArgs = calls.at(-1) ?? [];
    assert.equal(lastCmdArgs[0], 'command');
    assert.equal(lastCmdArgs[lastCmdArgs.indexOf('--tx') + 1], '5A070115000077,5A07011B00007D,5A0801250000078F');

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

    // 5. on with factory scene modeCode=0, gear=8 -> 18W
    const onSceneRes = await mod.runAction('on', { modeCode: 0, gear: 8 }, deps);
    assert.equal(onSceneRes.ok, true);
    const onSceneState = (onSceneRes.data as { state: { on: boolean; powerWatts: number; channels: NetleaChannels } }).state;
    assert.equal(onSceneState.on, true);
    assert.equal(onSceneState.powerWatts, 18);
    assert.deepEqual(onSceneState.channels, { red: 42, green: 60, white: 77, blue: 38, fan: 0 });

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
    assert.equal(dashData['灯内时钟'], '01:27:57');
    assert.equal(dashData.refreshed, false);
    assert.ok(dashData.catalog && typeof dashData.catalog === 'object');
    assert.ok(dashData.tempConfig && typeof dashData.tempConfig === 'object');

    // 6b. dashboard refresh: true sends 0x15,0x1B,0x25 batch and updates cache
    const dashRefresh = await mod.runAction('dashboard', { refresh: true }, deps);
    assert.equal(dashRefresh.ok, true);
    assert.equal(dashRefresh.notify, false);
    assert.equal(calls.length, callsBeforeCache + 1);
    assert.equal((dashRefresh.data as Record<string, unknown>).refreshed, true);
    const refreshTx = (calls.at(-1) ?? [])[(calls.at(-1) ?? []).indexOf('--tx') + 1];
    assert.equal(refreshTx, '5A070115000077,5A07011B00007D,5A0801250000078F');

    // 7. mode: manual (permanent) & mode: temp-config (0x1A)
    const manualRes = await mod.runAction('mode', { mode: 'manual', modeCode: 2, gear: 7 }, deps);
    assert.equal(manualRes.ok, true);
    assert.equal((manualRes.data as { state: { runMode: string; powerWatts: number } }).state.runMode, 'manual');
    assert.equal((manualRes.data as { state: { powerWatts: number } }).state.powerWatts, 15);

    const tempCfgRes = await mod.runAction('mode', { mode: 'temp-config', onMinutes: 30, offMinutes: 25, modeCode: 0, gear: 8 }, deps);
    assert.equal(tempCfgRes.ok, true);
    assert.equal((tempCfgRes.data as { tempConfig: { onMinutes: number; offMinutes: number } }).tempConfig.onMinutes, 30);
    assert.equal((tempCfgRes.data as { tempConfig: { offMinutes: number } }).tempConfig.offMinutes, 25);

    // 8. schedule: preset previewOnly works offline on darwin without BLE calls
    const callsBeforePreview = calls.length;
    const presetPreview = await mod.runAction(
      'schedule',
      { op: 'preset', preset: 'open_tank', previewOnly: true, lengthCm: 60, widthCm: 30, heightCm: 36 },
      { pluginDataDir: dataDir, platform: 'darwin' },
    );
    assert.equal(presetPreview.ok, true);
    assert.equal(presetPreview.notify, false);
    assert.equal(calls.length, callsBeforePreview);
    assert.equal((presetPreview.data as { schedule: NetleaSchedule }).schedule.trips.length, 6);

    // 9. schedule: set, get, clear
    const setSchedRes = await mod.runAction(
      'schedule',
      {
        op: 'set',
        travelModel: 1,
        sunriseMinutes: 20,
        sunsetMinutes: 20,
        trips: [
          { enable: 1, dayList: [1, 1, 1, 1, 1, 1, 1], startH: 9, startM: 0, endH: 13, endM: 0, modeCode: 0, gear: 8 },
          { enable: 1, dayList: [1, 1, 1, 1, 1, 1, 1], startH: 13, startM: 0, endH: 17, endM: 0, modeCode: 12, red: 40, green: 55, white: 75, blue: 35 },
        ],
      },
      deps,
    );
    assert.equal(setSchedRes.ok, true);
    assert.equal((setSchedRes.data as { schedule: NetleaSchedule }).schedule.trips.length, 2);

    const getSchedRes = await mod.runAction('schedule', { op: 'get' }, deps);
    assert.equal(getSchedRes.ok, true);
    assert.equal((getSchedRes.data as { schedule: NetleaSchedule }).schedule.trips.length, 2);

    const clearSchedRes = await mod.runAction('schedule', { op: 'clear' }, deps);
    assert.equal(clearSchedRes.ok, true);
    assert.equal((clearSchedRes.data as { schedule: NetleaSchedule }).schedule.trips.length, 0);

    // 10. clock sends 0x04,0x15 & retries once on transient CONNECT_FAILED
    transientConnectFailures = 1;
    const clockRes = await mod.runAction('clock', { tzHours: 8 }, deps);
    assert.equal(clockRes.ok, true);
    assert.equal(transientConnectFailures, 0);

    // 11. off, brightness=0 -> off, resume (restoreSeconds=1)
    const offRes = await mod.runAction('off', {}, deps);
    assert.equal(offRes.ok, true);
    assert.equal((offRes.data as { state: { on: boolean } }).state.on, false);

    const zeroOnRes = await mod.runAction('on', { brightness: 0, dryRun: true }, deps);
    assert.equal(zeroOnRes.ok, true);
    assert.equal((zeroOnRes.data as Record<string, unknown>).action, 'off');

    const resRes = await mod.runAction('resume', { lampStateHint: 1 }, deps);
    assert.equal(resRes.ok, true);
    assert.equal((resRes.data as Record<string, unknown>).tx, '5A17011000000100000000000000000100000000000084');

    // 12. NOT_FOUND surfaces friendly occupancy guidance
    const notFoundRes = await mod.runAction('status', {}, {
      ...deps,
      bleRunner: async () => ({ ok: false, code: 'NOT_FOUND', error: 'missing' }),
    });
    assert.equal(notFoundRes.ok, false);
    assert.match(String(notFoundRes.message), /App/);

    // 13. Non-linux platform without bleRunner disables BLE cleanly
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

test('Python ble_helper.py matching and 0x14/0x1A/0x12/0x02 reply detection work correctly', async () => {
  const mod = await loadPluginModule();
  const sampleScheduleHex = mod.buildMainScheduleFrame({
    sunriseMinutes: 20,
    sunsetMinutes: 20,
    trips: [{ enable: 1, dayList: [1, 1, 1, 1, 1, 1, 1], startH: 9, startM: 0, endH: 17, endM: 0, modeCode: 0, gear: 8 }],
  });

  const pyScript = [
    'import importlib.util, sys, types',
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
    `assert m.is_expected_netlea_reply(bytes.fromhex(${JSON.stringify(GOLDEN_0X1A_TEMP)})) == (True, False)`,
    `assert m.is_expected_netlea_reply(bytes.fromhex(${JSON.stringify(sampleScheduleHex)})) == (True, False)`,
    'assert m.is_expected_netlea_reply(bytes.fromhex("5A0F0102000010000000000000007C")) == (True, False)',
    'assert m.is_expected_netlea_reply(bytes.fromhex("5A070114000076")) == (False, False)',
    `assert m.is_expected_netlea_reply(bytes.fromhex(${JSON.stringify(`${GOLDEN_0X14_ON.slice(0, -2)}00`)})) == (False, False)`,
  ].join('\n');
  await execFileAsync('python3', ['-c', pyScript]);
});

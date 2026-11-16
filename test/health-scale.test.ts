import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listPluginsSync, runPlugin } from '../src/plugin.js';

type HealthModule = {
  DEFAULT_SCALE_MAC: string;
  PACKET_WEIGHT: number;
  PACKET_ADC: number;
  PACKET_HISTORY: number;
  PACKET_SETTING: number;
  Scale27Protocol: new () => { feed(pkt: Buffer | string): { status: string; frame: string | null; events: Record<string, unknown>[] } };
  parseScaleAdvertisement(raw: Record<string, unknown>): Record<string, unknown> | undefined;
  encodeTimeAndUserInfo27(opts: Record<string, unknown>): Buffer;
  computeFullHealthReport(opts: Record<string, unknown>): Record<string, unknown> | null;
  runAction(action: string, args?: Record<string, unknown>, deps?: Record<string, unknown>): Promise<Record<string, unknown>>;
};

// Dynamic import of ESM plugin module (same pattern as test/miot.test.ts)
async function loadPluginModule(): Promise<HealthModule> {
  return await import('../plugins/health-scale/index.mjs') as unknown as HealthModule;
}

function buildScale27Packet(packetType: number, deviceType: number, body16: number[], groupIndex = 1): Buffer {
  const pkt = Buffer.alloc(20, 0);
  pkt[0] = 0xac;
  pkt[1] = deviceType & 0x7f;
  for (let i = 0; i < 16; i++) {
    pkt[2 + i] = body16[i] ?? 0;
  }
  pkt[18] = packetType & 0xff; // body18[16]
  let calc = 0;
  for (let i = 0; i < 17; i++) {
    calc += pkt[2 + i] ?? 0;
  }
  pkt[19] = ((groupIndex & 0x07) << 5) | (calc & 0x1f); // body18[17]
  return pkt;
}

function encodeWeightU32(grams: number, { stable = true, dianji = 1, kgDiv = 1 } = {}): number {
  let u = grams & 0x3ffff;
  u |= (kgDiv & 0x07) << 18;
  u |= (kgDiv & 0x07) << 21;
  if (dianji) u |= 1 << 24;
  if (stable) u |= 1 << 31;
  return u >>> 0;
}

test('parseScaleAdvertisement decodes real AFU-WL-TZ-A1 ManufacturerData and ServiceData 0x27ac', async () => {
  const mod = await loadPluginModule();
  const parsed = mod.parseScaleAdvertisement({
    address: 'AA:BB:CC:DD:EE:FF',
    name: 'AFU-WL-TZ-A1',
    rssi: -76,
    uuids: ['0000ffb0-0000-1000-8000-00805f9b34fb', '000027ac-0000-1000-8000-00805f9b34fb'],
    manufacturerData: { '0x27ac': 'ffeeddccbbaa01' },
    serviceData: { '000027ac-0000-1000-8000-00805f9b34fb': 'ffeeddccbbaa01' },
  });
  assert.ok(parsed);
  assert.equal(parsed.mac, 'AA:BB:CC:DD:EE:FF');
  assert.equal(parsed.name, 'AFU-WL-TZ-A1');
  assert.equal(parsed.rssi, -76);
  assert.equal(parsed.communicationType, 'connect');
  assert.equal(parsed.deviceSubtype, 7);
  assert.equal(parsed.protocolVer, 1);

  // Even when rotating Apple iBeacon 0x004c replaces ManufacturerData, 0x27ac ServiceData keeps MAC accurate
  const ibeaconTurn = mod.parseScaleAdvertisement({
    address: 'AA:BB:CC:DD:EE:FF',
    name: 'AFU-WL-TZ-A1',
    rssi: -79,
    manufacturerData: { '0x004c': '0215aabb' },
    serviceData: { '000027ac-0000-1000-8000-00805f9b34fb': 'ffeeddccbbaa01' },
  });
  assert.ok(ibeaconTurn);
  assert.equal(ibeaconTurn.mac, 'AA:BB:CC:DD:EE:FF');
  assert.equal(ibeaconTurn.protocolVer, 1);
});

test('encodeTimeAndUserInfo27 builds valid 20-byte checksummed frame with user biometrics', async () => {
  const mod = await loadPluginModule();
  const frame = mod.encodeTimeAndUserInfo27({
    deviceType: 0x27,
    protocolVer: 1,
    user: { sex: 'female', age: 29, heightCm: 165, unit: 'jin' },
    nowMs: 1_700_000_000_000,
  });
  assert.equal(frame.length, 20);
  assert.equal(frame[0], 0xac);
  assert.equal(frame[1], 0x27);
  assert.equal(frame.readUInt32BE(2), 1_700_000_000);
  assert.equal(frame[7], 3); // jin unit code
  assert.equal(frame[9], 165);
  assert.equal(frame[12], 29);
  assert.equal(frame[13], 2); // female
  assert.equal(frame[16]! & 0x03, 0x03); // BIA enabled
  let sum = 0;
  for (let i = 2; i < 19; i++) sum += frame[i] ?? 0;
  assert.equal(frame[19], sum & 0xff);
});

test('Scale27Protocol decodes live weight (213), dual ADC/impedance (214), and offline history (216)', async () => {
  const mod = await loadPluginModule();
  const proto = new mod.Scale27Protocol();

  // 1) PACKET_WEIGHT (213) -> 68.50 kg, mode=1, battery=88%
  const weightBody = new Array<number>(16).fill(0);
  const wBuf = Buffer.alloc(4);
  wBuf.writeUInt32BE(encodeWeightU32(68500, { stable: true, dianji: 1 }), 0);
  weightBody[0] = wBuf[0]!;
  weightBody[1] = wBuf[1]!;
  weightBody[2] = wBuf[2]!;
  weightBody[3] = wBuf[3]!;
  weightBody[4] = 1; // mode 1
  weightBody[5] = 0; // calibration
  weightBody[6] = 88; // battery 88%, charging 0
  weightBody[7] = 0; // overWeight
  weightBody[14] = 1; // algType

  const wRes = proto.feed(buildScale27Packet(mod.PACKET_WEIGHT, 0x27, weightBody));
  assert.equal(wRes.status, 'perfect');
  assert.equal(wRes.events.length, 1);
  assert.equal(wRes.events[0]?.kind, 'weight');
  assert.equal(wRes.events[0]?.weightKg, 68.5);
  assert.equal(wRes.events[0]?.battery, 88);
  assert.equal(wRes.events[0]?.stable, true);

  // 2) PACKET_ADC (214) -> 2 ADCs (500, 460), mode=1, 68.50 kg
  const adcBody = new Array<number>(16).fill(0);
  adcBody[0] = 2; // count
  adcBody[1] = 0;
  adcBody[2] = 0x01; adcBody[3] = 0xf4; // 500
  adcBody[4] = 0x01; adcBody[5] = 0xcc; // 460
  adcBody[6] = 1; // mode 1
  adcBody[7] = wBuf[0]!;
  adcBody[8] = wBuf[1]!;
  adcBody[9] = wBuf[2]!;
  adcBody[10] = wBuf[3]!;
  const adcRes = proto.feed(buildScale27Packet(mod.PACKET_ADC, 0x27, adcBody));
  assert.equal(adcRes.status, 'perfect');
  assert.equal(adcRes.events[0]?.kind, 'adc');
  assert.equal(adcRes.events[0]?.weightKg, 68.5);
  assert.deepEqual(adcRes.events[0]?.adcs, [500, 460]);
  assert.deepEqual(adcRes.events[0]?.impedances, [500, 460]);

  // 3) PACKET_HISTORY (216) -> historyType=2, ts=1710000000, weight=67.20 kg, adc=512
  const histBody = new Array<number>(16).fill(0);
  histBody[0] = 2; // historyType=2
  const tsBuf = Buffer.alloc(4);
  tsBuf.writeUInt32BE(1_710_000_000, 0);
  histBody[1] = tsBuf[0]!; histBody[2] = tsBuf[1]!; histBody[3] = tsBuf[2]!; histBody[4] = tsBuf[3]!;
  const hwBuf = Buffer.alloc(4);
  hwBuf.writeUInt32BE(encodeWeightU32(67200, { stable: true }), 0);
  histBody[5] = hwBuf[0]!; histBody[6] = hwBuf[1]!; histBody[7] = hwBuf[2]!; histBody[8] = hwBuf[3]!;
  histBody[9] = 3; // remainHistoryCount
  histBody[10] = 1; // adc count
  histBody[11] = 0x02; histBody[12] = 0x00; // 512
  const hRes = proto.feed(buildScale27Packet(mod.PACKET_HISTORY, 0x27, histBody));
  assert.equal(hRes.status, 'perfect');
  assert.equal(hRes.events[0]?.kind, 'history');
  assert.equal((hRes.events[0]?.weight as Record<string, unknown>)?.weightKg, 67.2);
  assert.deepEqual(hRes.events[0]?.impedances, [512]);
});

test('computeFullHealthReport produces complete BIA & BMI-fallback reports with 16+ rated items', async () => {
  const mod = await loadPluginModule();

  const biaMale = mod.computeFullHealthReport({
    weightKg: 68.5,
    heightCm: 175,
    age: 30,
    sex: 'male',
    targetWeightKg: 66,
    impedances: [500, 455],
    heartRate: 68,
  });
  assert.ok(biaMale);
  assert.equal(biaMale.estimationMode, 'bia');
  assert.ok(String(biaMale.formulaModel).startsWith('segal_3'));
  assert.equal(biaMale.resistanceOhm, 500);
  assert.equal(biaMale.secondaryOhm, 455);
  assert.ok(Number(biaMale.bodyScore) >= 35 && Number(biaMale.bodyScore) <= 100);
  assert.ok((biaMale.items as unknown[]).length >= 16);

  const bmiOnlyFemale = mod.computeFullHealthReport({
    weightKg: 54.0,
    heightCm: 164,
    age: 26,
    sex: 'female',
  });
  assert.ok(bmiOnlyFemale);
  assert.equal(bmiOnlyFemale.estimationMode, 'bmi_only');
  assert.equal(bmiOnlyFemale.formulaModel, 'deurenberg_bmi_fallback');
  assert.equal(bmiOnlyFemale.weightJin, 108);
});

test('health-scale plugin actions handle profiles, manual records, mocked BLE scan/measure lifecycle, and SQLite dedup', async () => {
  const mod = await loadPluginModule();
  assert.equal(mod.DEFAULT_SCALE_MAC, '');
  const dataDir = mkdtempSync(join(tmpdir(), 'health-scale-test-'));

  try {
    // 1) Initial dashboard starts empty (no hardcoded personal profile) and measure-start prompts to create one
    const initRes = await mod.runAction('dashboard', {}, { dataDir, nowFn: () => 1_700_000_000_000 });
    assert.equal(initRes.ok, true);
    const initData = initRes.data as Record<string, unknown>;
    assert.equal((initData.profiles as unknown[]).length, 0);

    const noProfileMeas = await mod.runAction('measure-start', { timeoutSec: 30 }, { dataDir, spawnMeasure: () => 0 });
    assert.equal(noProfileMeas.ok, false);
    assert.equal((noProfileMeas.data as Record<string, unknown>).needsProfile, true);

    // Seed primary profile via profile-save
    const ownerSave = await mod.runAction('profile-save', {
      id: 'owner',
      name: '默认成员',
      sex: 'male',
      age: 30,
      heightCm: 175,
      targetWeightKg: 68,
      unit: 'kg',
      setDefault: true,
    }, { dataDir, nowFn: () => 1_700_000_050_000 });
    assert.equal(ownerSave.ok, true);

    // 2) Save second profile and delete later
    const pSave = await mod.runAction('profile-save', {
      name: '家庭成员B',
      sex: 'female',
      age: 27,
      heightCm: 163,
      targetWeightKg: 52,
      unit: 'jin',
      setDefault: false,
    }, { dataDir, nowFn: () => 1_700_000_100_000 });
    assert.equal(pSave.ok, true);
    const secondProfileId = ((pSave.data as Record<string, unknown>).activeProfile as Record<string, unknown>).id as string;

    // 3) Manual add in jin -> converts accurately to kg & computes full report
    const addRes = await mod.runAction('record-add', {
      profileId: secondProfileId,
      weight: 108,
      unit: 'jin',
      impedanceOhm: 525,
      heartRate: 70,
      note: '晨起测试',
    }, { dataDir, nowFn: () => 1_700_000_200_000 });
    assert.equal(addRes.ok, true);
    const addData = addRes.data as Record<string, unknown>;
    const addedRec = addData.latest as Record<string, unknown>;
    assert.equal(addedRec.weightKg, 54);
    assert.equal(addedRec.weightJin, 108);
    assert.equal((addedRec.metrics as Record<string, unknown>).estimationMode, 'bia');

    // 4) Mock scan updates devices table
    const scanRes = await mod.runAction('scan', {}, {
      dataDir,
      nowFn: () => 1_700_000_300_000,
      bleRunner: async () => ({
        ok: true,
        devices: [{
          address: 'AA:BB:CC:DD:EE:FF',
          name: 'AFU-WL-TZ-A1',
          rssi: -77,
          uuids: ['000027ac-0000-1000-8000-00805f9b34fb'],
          manufacturerData: { '0x27ac': 'ffeeddccbbaa01' },
          serviceData: { '000027ac-0000-1000-8000-00805f9b34fb': 'ffeeddccbbaa01' },
        }],
      }),
    });
    assert.equal(scanRes.ok, true);

    // 5) Mock measure-start + measure-status writes completed Scale27 notifications -> ingests live + history deduplicated
    const wBuf = Buffer.alloc(4);
    wBuf.writeUInt32BE(encodeWeightU32(68500, { stable: true, dianji: 1 }), 0);
    const weightBody = new Array<number>(16).fill(0);
    weightBody[0] = wBuf[0]!; weightBody[1] = wBuf[1]!; weightBody[2] = wBuf[2]!; weightBody[3] = wBuf[3]!;
    weightBody[4] = 1; weightBody[6] = 92;
    const adcBody = new Array<number>(16).fill(0);
    adcBody[0] = 2;
    adcBody[2] = 0x01; adcBody[3] = 0xf4;
    adcBody[4] = 0x01; adcBody[5] = 0xcc;
    adcBody[6] = 1;
    adcBody[7] = wBuf[0]!; adcBody[8] = wBuf[1]!; adcBody[9] = wBuf[2]!; adcBody[10] = wBuf[3]!;
    const histBody = new Array<number>(16).fill(0);
    histBody[0] = 2;
    const tsBuf = Buffer.alloc(4);
    tsBuf.writeUInt32BE(1_710_000_000, 0);
    histBody[1] = tsBuf[0]!; histBody[2] = tsBuf[1]!; histBody[3] = tsBuf[2]!; histBody[4] = tsBuf[3]!;
    const hwBuf = Buffer.alloc(4);
    hwBuf.writeUInt32BE(encodeWeightU32(67200, { stable: true }), 0);
    histBody[5] = hwBuf[0]!; histBody[6] = hwBuf[1]!; histBody[7] = hwBuf[2]!; histBody[8] = hwBuf[3]!;
    histBody[10] = 1; histBody[11] = 0x02; histBody[12] = 0x00;

    let sessionFileWritten = '';
    const startRes = await mod.runAction('measure-start', { timeoutSec: 30 }, {
      dataDir,
      nowFn: () => 1_700_000_400_000,
      spawnMeasure: (spawnArgs: string[]) => {
        const idx = spawnArgs.indexOf('--state-file');
        const statePath = spawnArgs[idx + 1]!;
        const sidIdx = spawnArgs.indexOf('--session-id');
        const sessionId = spawnArgs[sidIdx + 1]!;
        sessionFileWritten = statePath;
        writeFileSync(statePath, JSON.stringify({
          sessionId,
          profileId: 'owner',
          pid: null,
          phase: 'completed',
          startedAt: 1_700_000_400_000,
          updatedAt: 1_700_000_410_000,
          message: '已完成测量与历史同步',
          device: { address: 'AA:BB:CC:DD:EE:FF', name: 'AFU-WL-TZ-A1', rssi: -75 },
          deviceInfo: { model: 'AFU-WL-TZ-A1', software: '1.2.3' },
          notifications: [
            { hex: buildScale27Packet(mod.PACKET_WEIGHT, 0x27, weightBody).toString('hex').toUpperCase() },
            { hex: buildScale27Packet(mod.PACKET_ADC, 0x27, adcBody).toString('hex').toUpperCase() },
            { hex: buildScale27Packet(mod.PACKET_HISTORY, 0x27, histBody).toString('hex').toUpperCase() },
          ],
          error: null,
        }));
        return 999999;
      },
    });
    assert.equal(startRes.ok, true);
    assert.ok(sessionFileWritten);

    // Poll once -> ingests both live (68.5) and offline history (67.2)
    const poll1 = await mod.runAction('measure-status', {}, { dataDir, nowFn: () => 1_700_000_411_000 });
    assert.equal(poll1.ok, true);
    const poll1Data = poll1.data as { dashboard: { records: Record<string, unknown>[]; device: Record<string, unknown> } };
    assert.equal(poll1Data.dashboard.records.length, 2);
    assert.equal(poll1Data.dashboard.device.battery, 92);

    // Polling again must NOT duplicate records (dedup_key guard)
    const poll2 = await mod.runAction('measure-status', {}, { dataDir, nowFn: () => 1_700_000_412_000 });
    const poll2Data = poll2.data as { dashboard: { records: Record<string, unknown>[] } };
    assert.equal(poll2Data.dashboard.records.length, 2);

    // Delete manual record & non-default profile
    const delRec = await mod.runAction('record-delete', { id: addData.insertedId, profileId: secondProfileId }, { dataDir });
    assert.equal(delRec.ok, true);
    const delProf = await mod.runAction('profile-delete', { id: secondProfileId }, { dataDir });
    assert.equal(delProf.ok, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('health-scale config loads external targetMac/defaultProfile and measure-stop ignores unrelated non-ble_helper PID', async () => {
  const mod = await loadPluginModule();
  const dataDir = mkdtempSync(join(tmpdir(), 'health-scale-cfg-'));
  try {
    const cfgRes = await mod.runAction('config', {
      targetMac: 'AA:BB:CC:DD:EE:FF',
      namePrefix: 'AFU-WL',
      defaultProfile: {
        id: 'owner',
        name: '配置成员',
        sex: 'female',
        age: 26,
        heightCm: 165,
        targetWeightKg: 53,
        unit: 'kg',
      },
    }, { dataDir, nowFn: () => 1_700_000_000_000 });
    assert.equal(cfgRes.ok, true);

    const dash = await mod.runAction('dashboard', {}, { dataDir, nowFn: () => 1_700_000_001_000 });
    assert.equal(dash.ok, true);
    const profiles = ((dash.data as Record<string, unknown>).profiles as Array<Record<string, unknown>>);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]?.name, '配置成员');

    // Write session file pointing to current test-runner PID (not ble_helper.py); measure-stop must NOT kill it!
    writeFileSync(join(dataDir, 'live-session.json'), JSON.stringify({
      sessionId: 'fake-non-ble',
      profileId: 'owner',
      pid: process.pid,
      phase: 'scanning',
      startedAt: 1_700_000_001_000,
      updatedAt: 1_700_000_001_000,
    }));
    const stopRes = await mod.runAction('measure-stop', {}, { dataDir, nowFn: () => 1_700_000_002_000 });
    assert.equal(stopRes.ok, true);
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Friday plugin registry discovers health-scale and runs dashboard in-process', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-health-plugin-home-'));
  try {
    const plugins = listPluginsSync(home);
    const found = plugins.find(p => p.name === 'health-scale');
    assert.ok(found, 'health-scale plugin should be discovered');
    assert.ok(found.actions.includes('dashboard'));
    assert.ok(found.actions.includes('measure-start'));

    const res = await runPlugin(home, 'health-scale', 'dashboard', {});
    assert.equal(res.ok, true);
    assert.equal(res.plugin, 'health-scale');
    assert.equal(res.action, 'dashboard');
    const data = res.data as Record<string, unknown>;
    assert.ok(Array.isArray(data.profiles));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

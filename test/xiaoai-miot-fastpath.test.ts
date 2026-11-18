import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import {
  findProtectedMatch,
  handleMiotVoiceFastpath,
  parseChineseNumber,
  parseMiotVoiceUtterance,
} from '../plugins/miot/fastpath.mjs';
import {
  handleVoiceFastpath as handleMiotPluginVoiceFastpath,
} from '../plugins/miot/index.mjs';
import { resolvePluginDataDir } from '../src/paths.js';
import { ImGateway } from '../src/im.js';
import { Store, type ImChannelConfig } from '../src/store.js';
import type { XiaoaiSshRunner } from '../src/xiaoai.js';
import { SPEAKER_SAMPLE_RATE, XiaoaiSpeakerManager, type XiaoaiSpeakerExtractor } from '../src/xiaoai-speaker.js';

// ---------------------------------------------------------------------------
// Parser (exercises real production plugins/miot/fastpath.mjs)
// ---------------------------------------------------------------------------

const fryerAction = (action: 'status' | 'pause' | 'resume' | 'stop') => ([
  { kind: 'fryer_action', device: '空气炸锅', action },
]);

test('parseChineseNumber handles Arabic and Chinese numerals', () => {
  assert.equal(parseChineseNumber('200'), 200);
  assert.equal(parseChineseNumber('两百'), 200);
  assert.equal(parseChineseNumber('二百'), 200);
  assert.equal(parseChineseNumber('一百八'), 180);
  assert.equal(parseChineseNumber('一百八十'), 180);
  assert.equal(parseChineseNumber('一百'), 100);
  assert.equal(parseChineseNumber('五'), 5);
  assert.equal(parseChineseNumber('十五'), 15);
  assert.equal(parseChineseNumber('二十六'), 26);
  assert.equal(parseChineseNumber('三十'), 30);
  assert.equal(parseChineseNumber('半'), 0.5);
  assert.equal(parseChineseNumber('哈哈'), undefined);
});

test('parser: air fryer cook / stop / pause / resume / status incl. ASR homophones & Friday wake words', () => {
  assert.deepEqual(parseMiotVoiceUtterance('空气炸锅200度5分钟'), [
    { kind: 'cook', device: '空气炸锅', tempC: 200, minutes: 5 },
  ]);
  assert.deepEqual(parseMiotVoiceUtterance('请帮我把空气炸锅调到两百度五分钟'), [
    { kind: 'cook', device: '空气炸锅', tempC: 200, minutes: 5 },
  ]);
  assert.deepEqual(parseMiotVoiceUtterance('空炸一百八十度半小时'), [
    { kind: 'cook', device: '空气炸锅', tempC: 180, minutes: 30 },
  ]);
  assert.deepEqual(parseMiotVoiceUtterance('炸锅180度十五分钟。'), [
    { kind: 'cook', device: '空气炸锅', tempC: 180, minutes: 15 },
  ]);
  assert.deepEqual(parseMiotVoiceUtterance('空气炸锅做薯条'), [
    { kind: 'cook', device: '空气炸锅', recipe: 'fries' },
  ]);
  assert.deepEqual(parseMiotVoiceUtterance('空气炸锅烤地瓜'), [
    { kind: 'cook', device: '空气炸锅', recipe: 'sweet_potato' },
  ]);
  assert.deepEqual(parseMiotVoiceUtterance('空气炸锅烤鸡翅200度20分钟'), [
    { kind: 'cook', device: '空气炸锅', recipe: 'wings', tempC: 200, minutes: 20 },
  ]);

  for (const t of [
    '关闭空气炸播',
    '关掉空气炸国',
    '停止空气炸果',
    '星期五，关闭空气炸锅。',
    '你好星期五，关闭空气炸锅。',
    'Friday，关闭空气炸锅',
    '取消炸锅',
    '把空气炸锅关了',
  ]) {
    assert.deepEqual(parseMiotVoiceUtterance(t), fryerAction('stop'), t);
  }
  assert.deepEqual(parseMiotVoiceUtterance('暂停空气炸锅'), fryerAction('pause'));
  assert.deepEqual(parseMiotVoiceUtterance('空气炸锅继续'), fryerAction('resume'));
  assert.deepEqual(parseMiotVoiceUtterance('恢复空气炸锅'), fryerAction('resume'));
  for (const t of ['空气炸锅还剩多久', '空气炸锅还要几分钟', '空气炸锅开着吗', '空气炸锅做好没', '空气炸锅关了吗', '空气炸锅在工作吗']) {
    assert.deepEqual(parseMiotVoiceUtterance(t), fryerAction('status'), t);
  }
});

test('parser: air conditioner room / power / temperature / mode / fan', () => {
  assert.deepEqual(parseMiotVoiceUtterance('打开客厅空调'), [
    { kind: 'ac_set', device: '客厅空调', room: '客厅', needsRoomCheck: false, on: true },
  ]);
  assert.deepEqual(parseMiotVoiceUtterance('关闭卧室空调'), [
    { kind: 'ac_set', device: '卧室空调', room: '卧室', needsRoomCheck: false, on: false },
  ]);
  assert.deepEqual(parseMiotVoiceUtterance('把空调调到26度'), [
    { kind: 'ac_set', device: '空调', needsRoomCheck: true, temperature: 26 },
  ]);
  assert.deepEqual(parseMiotVoiceUtterance('客厅空调制冷二十六度低风'), [
    { kind: 'ac_set', device: '客厅空调', room: '客厅', needsRoomCheck: false, temperature: 26, mode: 'cool', fanSpeed: 'low' },
  ]);
  assert.deepEqual(parseMiotVoiceUtterance('空调开到除湿'), [
    { kind: 'ac_set', device: '空调', needsRoomCheck: true, on: true, mode: 'dry' },
  ]);
  assert.deepEqual(parseMiotVoiceUtterance('主卧空调自动风'), [
    { kind: 'ac_set', device: '主卧空调', room: '主卧', needsRoomCheck: false, fanSpeed: 'auto' },
  ]);
  assert.deepEqual(parseMiotVoiceUtterance('客厅空调开着吗'), [
    { kind: 'get', device: '客厅空调', room: '客厅' },
  ]);
  // relative adjustments, multi-room, bare "空调" -> Router
  assert.equal(parseMiotVoiceUtterance('客厅空调调高一点'), null);
  assert.equal(parseMiotVoiceUtterance('客厅和卧室空调'), null);
  assert.equal(parseMiotVoiceUtterance('空调'), null);
});

test('parser: lights batch / query and outlet device set/get', () => {
  for (const t of ['全屋关灯', '把家里灯都关了', '关掉所有灯', '关闭全部灯']) {
    assert.deepEqual(parseMiotVoiceUtterance(t), [{ kind: 'lights_batch', on: false }], t);
  }
  assert.deepEqual(parseMiotVoiceUtterance('打开客厅所有灯'), [{ kind: 'lights_batch', room: '客厅', on: true }]);
  assert.deepEqual(parseMiotVoiceUtterance('全屋开灯'), [{ kind: 'lights_batch', on: true }]);
  for (const t of ['家里哪些灯开着', '还有什么灯没关', '看看哪些灯亮着']) {
    assert.deepEqual(parseMiotVoiceUtterance(t), [{ kind: 'lights_query' }], t);
  }
  assert.deepEqual(parseMiotVoiceUtterance('打开生态灯'), [{ kind: 'set_power', device: '生态灯', on: true }]);
  assert.deepEqual(parseMiotVoiceUtterance('把植物灯关掉'), [{ kind: 'set_power', device: '植物灯', on: false }]);
  assert.deepEqual(parseMiotVoiceUtterance('关闭客厅灯'), [{ kind: 'set_power', device: '客厅灯', on: false }]);
  assert.deepEqual(parseMiotVoiceUtterance('关闭客厅开关'), [{ kind: 'set_power', device: '客厅开关', on: false }]);
  assert.deepEqual(parseMiotVoiceUtterance('切换书房插座'), [{ kind: 'set_power', device: '书房插座', toggle: true }]);
  assert.deepEqual(parseMiotVoiceUtterance('生态灯开着吗'), [{ kind: 'get', device: '生态灯' }]);
  assert.deepEqual(parseMiotVoiceUtterance('植物灯关了吗'), [{ kind: 'get', device: '植物灯' }]);
  // A bare "灯" is never guessed (could hit a protected outlet)
  assert.equal(parseMiotVoiceUtterance('关灯'), null);
  assert.equal(parseMiotVoiceUtterance('开灯'), null);
  assert.equal(parseMiotVoiceUtterance('关掉所有灯生态灯除外'), null);
  // Protected device names passed by caller/plugin are excluded from batch intents
  assert.notEqual(
    parseMiotVoiceUtterance('关掉全部生态灯', undefined, { protectedKeywords: ['生态灯'] })?.[0]?.kind,
    'lights_batch',
  );
});

test('parser bailouts: negation, timers, multi-step, TV/voiceprint, unsafe numbers, non-smart-home', () => {
  const bail = [
    '5分钟后关空气炸锅', '预约30分钟空气炸锅', '半小时后关闭空气炸锅', '定时关灯', '明天早上七点开空调', '过一会关空气炸锅',
    '三分钟之后关掉空气炸锅', '提醒我关火', '八点关灯', '稍后关闭空气炸锅', '等会打开客厅灯',
    '如果下雨就关灯', '关灯然后开空调', '顺便把空调打开', '空气炸锅怎么回事', '把空气炸锅状态发给微信',
    '打开电视', '关闭投影', '录入我的声纹', '电视遥控模式',
    '空气炸锅250度5分钟',     // above fryer limit
    '空气炸锅250',            // bare above fryer limit
    '别关空气炸锅', '不要关灯', '勿打开客厅灯', '没让你关空气炸锅',
    '你好', '今天天气怎么样', '',
    '空气炸锅' + '二百度五分钟'.repeat(12), // > 60 chars
  ];
  for (const t of bail) assert.equal(parseMiotVoiceUtterance(t), null, `should bail: "${t}"`);
  // ...whereas a plain duration without 后/之后/定时/预约 is a cook command
  assert.deepEqual(parseMiotVoiceUtterance('空气炸锅200度5分钟'), [
    { kind: 'cook', device: '空气炸锅', tempC: 200, minutes: 5 },
  ]);
});

test('parser & executor: partial air fryer utterances clarify locally and merge follow-up slots', async () => {
  assert.deepEqual(parseMiotVoiceUtterance('空气炸锅。'), [{ kind: 'cook_clarify', device: '空气炸锅' }]);
  assert.deepEqual(parseMiotVoiceUtterance('打开空气炸锅'), [{ kind: 'cook_clarify', device: '空气炸锅' }]);
  assert.deepEqual(parseMiotVoiceUtterance('空气炸锅200。'), [{ kind: 'cook_clarify', device: '空气炸锅', tempC: 200 }]);
  assert.deepEqual(parseMiotVoiceUtterance('空气炸锅两百'), [{ kind: 'cook_clarify', device: '空气炸锅', tempC: 200 }]);
  assert.deepEqual(parseMiotVoiceUtterance('空气炸锅200度'), [{ kind: 'cook_clarify', device: '空气炸锅', tempC: 200 }]);
  assert.deepEqual(parseMiotVoiceUtterance('空气炸锅15分钟'), [{ kind: 'cook_clarify', device: '空气炸锅', minutes: 15 }]);

  // Slot continuation merges missing temp or duration without repeating "空气炸锅"
  assert.deepEqual(
    parseMiotVoiceUtterance('5分钟', { tempC: 200 }),
    [{ kind: 'cook', device: '空气炸锅', tempC: 200, minutes: 5 }],
  );
  assert.deepEqual(
    parseMiotVoiceUtterance('180度', { minutes: 15 }),
    [{ kind: 'cook', device: '空气炸锅', tempC: 180, minutes: 15 }],
  );
  assert.deepEqual(
    parseMiotVoiceUtterance('十', { tempC: 200 }),
    [{ kind: 'cook', device: '空气炸锅', tempC: 200, minutes: 10 }],
  );
  // Open questions never falsely merge into fryer slots
  assert.equal(parseMiotVoiceUtterance('现在房间几度', { tempC: 200 }), null);

  const req = (text: string, sessionState?: Record<string, unknown>) => ({
    text,
    channelId: 'xiaoai-1',
    platform: 'xiaoai',
    ...(sessionState ? { sessionState } : {}),
  });

  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-miot-slot-exec-'));
  try {
    const dataDir = resolvePluginDataDir(home, 'miot');
    const { runner, calls } = makeRunner([]);
    const ctx = { homeDir: home, dataDir, devices: [] as Dev[] };

    const askAll = await handleMiotVoiceFastpath(req('打开空气炸锅'), ctx, runner);
    assert.equal(askAll.handled, true);
    assert.equal(askAll.followUp, true);
    assert.equal(askAll.speech, '空气炸锅要设多少度、几分钟？');
    assert.deepEqual(askAll.sessionState, { pendingFryer: {} });

    const askMin = await handleMiotVoiceFastpath(req('空气炸锅两百'), ctx, runner);
    assert.equal(askMin.speech, '200度要烤几分钟？');
    assert.equal(askMin.followUp, true);
    assert.deepEqual(askMin.sessionState, { pendingFryer: { tempC: 200 } });

    const askTemp = await handleMiotVoiceFastpath(req('空气炸锅15分钟'), ctx, runner);
    assert.equal(askTemp.speech, '15分钟要设多少度？');
    assert.equal(askTemp.followUp, true);
    assert.deepEqual(askTemp.sessionState, { pendingFryer: { minutes: 15 } });
    assert.equal(calls.length, 0);

    // Turn 2 merges pendingFryer and dispatches cook action cleanly
    const merged = await handleMiotVoiceFastpath(
      req('五分钟', askMin.sessionState),
      ctx,
      makeRunner([], {
        cook: args => ({ ok: true, message: `空气炸锅已启动：手动，${args.tempC}℃，${args.minutes} 分钟`, data: args }),
      }).runner,
    );
    assert.equal(merged.handled, true);
    assert.equal(merged.clearSessionState, true);
    assert.match(merged.speech ?? '', /200℃.*5 分钟/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Executor with real plugins/miot/fastpath.mjs & plugins/miot/index.mjs
// ---------------------------------------------------------------------------

const voiceReq = (text: string, sessionState?: Record<string, unknown>) => ({
  text,
  channelId: 'xiaoai-1',
  platform: 'xiaoai',
  ...(sessionState ? { sessionState } : {}),
});

type Dev = Record<string, unknown>;
const light = (did: string, room: string, name: string, on = false): Dev => ({
  did, name, room, fullName: `${room}${name}`, category: 'light', categories: ['light'],
  controlChannel: 'bt_mesh', controllable: true, state: { on, source: 'live' },
});
const lifeSupport = (did: string, name: string): Dev => ({
  did, name, room: '客厅', fullName: `客厅${name}`, category: 'outlet', categories: ['outlet', 'light'],
  controlChannel: 'bt_mesh', controllable: true, state: { on: true, source: 'live' },
});
const ac = (did: string, room: string): Dev => ({
  did, name: '空调', room, fullName: `${room}空调`, category: 'air_conditioner', categories: ['air_conditioner'],
  controlChannel: 'xiaoai_nlp', controllable: true,
});
const fryerDevice = (): Dev => ({
  did: 'fryer-1', name: '空气炸锅', room: '厨房', fullName: '厨房空气炸锅',
  category: 'air_fryer', categories: ['air_fryer'],
  model: 'careli.fryer.maf01', controlChannel: 'miio_udp', controllable: true,
  ip: '192.0.2.55', hasToken: true,
});

type StubActionResult = { ok: boolean; message: string; data?: Record<string, unknown> };

function makeRunner(devices: Dev[], overrides: Partial<Record<string, (args: Record<string, unknown>) => StubActionResult>> = {}) {
  const calls: Array<{ action: string; args: Record<string, unknown> }> = [];
  const runner = async (action: string, args: Record<string, unknown>): Promise<StubActionResult> => {
    calls.push({ action, args });
    const override = overrides[action];
    if (override) return override(args);
    if (action === 'devices') {
      const category = String(args.category ?? '');
      const room = args.room ? String(args.room) : '';
      const list = devices.filter(d =>
        (!category || (d.categories as string[]).includes(category)) && (!room || String(d.room).includes(room)));
      return { ok: true, message: `共 ${list.length} 台`, data: { devices: list } };
    }
    if (action === 'set') {
      const dev = devices.find(d => d.did === args.did || d.fullName === args.device || d.name === args.device);
      if (!dev) return { ok: false, message: `未找到设备 "${String(args.device)}"。`, data: { code: 'DEVICE_NOT_FOUND' } };
      return { ok: true, message: args.toggle ? `已切换${dev.fullName || dev.name}` : `已${args.on ? '打开' : '关闭'}${dev.fullName || dev.name}。`, data: { device: dev, on: args.on } };
    }
    if (action === 'get') {
      const dev = devices.find(d => d.fullName === args.device || d.name === args.device);
      if (!dev) return { ok: false, message: `未找到设备 "${String(args.device)}"。`, data: { code: 'DEVICE_NOT_FOUND' } };
      return { ok: true, message: `${dev.fullName || dev.name}开着。`, data: { device: dev, on: true } };
    }
    return { ok: true, message: 'ok', data: {} };
  };
  return { runner, calls };
}

test('executor: fryer stop/pause/resume always route to cook action (not generic action) + real miot udpCall integration', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-miot-fryer-exec-'));
  try {
    const dataDir = resolvePluginDataDir(home, 'miot');
    const ctx = { homeDir: home, dataDir, devices: [fryerDevice()] };

    for (const [text, expectedOp, msg] of [
      ['关闭空气炸锅', 'stop', '已停止空气炸锅烹饪'],
      ['暂停空气炸锅', 'pause', '已暂停空气炸锅烹饪'],
      ['继续空气炸锅', 'resume', '已继续空气炸锅烹饪'],
      ['空气炸锅还剩多久', 'status', '空气炸锅正在烹饪，剩余 5 分钟。'],
    ] as const) {
      const { runner, calls } = makeRunner([], {
        cook: args => ({ ok: true, message: msg, data: { op: args.op } }),
      });
      const res = await handleMiotVoiceFastpath(voiceReq(text), ctx, runner);
      assert.equal(res.handled, true, text);
      assert.equal(res.speech, msg, text);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.action, 'cook', `must invoke cook for ${text}, never action`);
      assert.deepEqual(calls[0]!.args, { device: '空气炸锅', op: expectedOp });
    }

    // End-to-end through plugins/miot/index.mjs handleVoiceFastpath + real MiIO cook action
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'hub-cache.json'), JSON.stringify({
      version: 1,
      fetchedAt: Date.now(),
      hotDataFetchedAt: Date.now(),
      rooms: { 'room-k': '厨房' },
      devices: [{
        did: 'fryer-1',
        name: '空气炸锅',
        room: '厨房',
        roomId: 'room-k',
        fullName: '厨房空气炸锅',
        category: 'air_fryer',
        categories: ['air_fryer'],
        model: 'careli.fryer.maf01',
        ip: '192.0.2.55',
        mac: 'aa:bb:cc:dd:ee:01',
        online: true,
        controlChannel: 'miio_udp',
        controllable: true,
        hasToken: true,
      }],
    }));
    await writeFile(join(dataDir, 'hub-tokens.json'), JSON.stringify({
      'fryer-1': '00112233445566778899aabbccddeeff',
    }), { mode: 0o600 });

    const udpCalls: Array<{ method: string; params: unknown }> = [];
    const e2eRes = await handleMiotPluginVoiceFastpath(
      voiceReq('星期五，暂停空气炸锅'),
      {
        homeDir: home,
        dataDir,
        sleepFn: async () => {},
        udpCall: async (req: { method: string; params: unknown }) => {
          udpCalls.push({ method: req.method, params: req.params });
          if (req.method === 'action') return { result: { code: 0 } };
          if (req.method === 'get_properties') {
            return {
              result: [
                { siid: 2, piid: 1, code: 0, value: 6 },
                { siid: 2, piid: 2, code: 0, value: 0 },
                { siid: 2, piid: 3, code: 0, value: 180 },
                { siid: 2, piid: 4, code: 0, value: 8 },
                { siid: 2, piid: 5, code: 0, value: 0 },
              ],
            };
          }
          return { result: [] };
        },
      } as never,
    );
    assert.equal(e2eRes.handled, true);
    assert.match(e2eRes.speech ?? '', /已暂停空气炸锅烹饪/);
    assert.ok(udpCalls.some(u => u.method === 'action' && (u.params as Record<string, unknown>).siid === 2 && (u.params as Record<string, unknown>).aiid === 3));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('executor: DEVICE_NOT_FOUND falls back to Router; out-of-range AC / protectedDevices handled cleanly', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-miot-fallback-'));
  try {
    const dataDir = resolvePluginDataDir(home, 'miot');
    const ctx = { homeDir: home, dataDir, devices: [] as Dev[] };

    const notFound = await handleMiotVoiceFastpath(voiceReq('打开生态灯'), ctx, makeRunner([]).runner);
    assert.deepEqual(notFound, { handled: false });

    const coded = await handleMiotVoiceFastpath(
      voiceReq('关闭空气炸锅'),
      ctx,
      async () => ({ ok: false, message: 'nope', data: { code: 'DEVICE_NOT_FOUND' } }),
    );
    assert.deepEqual(coded, { handled: false });

    // Protected device matched via customAliases + 的 particle before any action fires
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({
      protectedDevices: ['水草补光灯'],
      customAliases: { '水草补光灯': ['生态灯', '草缸灯'] },
    }));
    const spy = makeRunner([lifeSupport('o1', '水草补光灯')]);
    const blocked = await handleMiotVoiceFastpath(voiceReq('关闭客厅的生态灯'), ctx, spy.runner);
    assert.equal(blocked.handled, true);
    assert.equal((blocked.data as Record<string, unknown>)?.blocked, true);
    assert.equal(spy.calls.length, 0);
    assert.ok(findProtectedMatch(['水草补光灯'], {
      query: '的生态灯',
      room: '客厅',
      customAliases: { '水草补光灯': ['生态灯'] },
    }));

    // Out-of-range AC temp reports range error without calling set
    const badAc = makeRunner([ac('ac1', '客厅')]);
    const acOut = await handleMiotVoiceFastpath(voiceReq('把客厅空调调到35度'), ctx, badAc.runner);
    assert.equal(acOut.handled, true);
    assert.match(acOut.speech ?? '', /16 到 31 度/);
    assert.equal(badAc.calls.some(c => c.action === 'set'), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('executor: AC without a room asks for one when several ACs exist; unique AC executes', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-miot-ac-'));
  try {
    const dataDir = resolvePluginDataDir(home, 'miot');
    const ctx = { homeDir: home, dataDir, devices: [ac('ac1', '客厅'), ac('ac2', '卧室')] };

    const multi = makeRunner([ac('ac1', '客厅'), ac('ac2', '卧室')]);
    const asked = await handleMiotVoiceFastpath(voiceReq('把空调调到26度'), ctx, multi.runner);
    assert.equal(asked.handled, true);
    assert.equal(asked.speech, '家里有多台空调，请说具体房间，比如客厅空调。');
    assert.equal(asked.followUp, true);
    assert.equal(multi.calls.some(c => c.action === 'set'), false, 'must not guess an AC');
    assert.deepEqual(multi.calls[0], { action: 'devices', args: { category: 'air_conditioner', live: false } });

    const withRoom = makeRunner([ac('ac1', '客厅'), ac('ac2', '卧室')], {
      set: args => ({ ok: true, message: `${args.device}已调到${args.temperature}度，切到制冷。`, data: args }),
    });
    const done = await handleMiotVoiceFastpath(voiceReq('客厅空调制冷26度'), ctx, withRoom.runner);
    assert.equal(done.speech, '客厅空调已调到26度，切到制冷。');
    assert.deepEqual(withRoom.calls.find(c => c.action === 'set')?.args, {
      device: '客厅空调', room: '客厅', temperature: 26, mode: 'cool',
    });

    const single = makeRunner([ac('ac1', '客厅')], {
      set: args => ({ ok: true, message: `${args.device}已调到${args.temperature}度。`, data: args }),
    });
    const one = await handleMiotVoiceFastpath(
      voiceReq('把空调调到26度'),
      { homeDir: home, dataDir, devices: [ac('ac1', '客厅')] },
      single.runner,
    );
    assert.equal(one.handled, true);
    assert.deepEqual(single.calls.find(c => c.action === 'set')?.args, {
      did: 'ac1', device: '客厅空调', temperature: 26,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('executor: whole-home lights-off only touches real BT-mesh lights, never life-support outlets', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-miot-lights-'));
  try {
    const dataDir = resolvePluginDataDir(home, 'miot');
    const devices = [
      light('l1', '客厅', '灯', true), light('l2', '卧室', '灯', true),
      { ...light('l3', '书房', '灯'), controllable: false },
      { ...light('l4', '餐厅', '灯'), controlChannel: 'miio_udp' },
      lifeSupport('outlet1', '生态灯'), lifeSupport('outlet2', '植物灯'),
    ];
    const ctx = { homeDir: home, dataDir, devices };

    const { runner, calls } = makeRunner(devices);
    const res = await handleMiotVoiceFastpath(voiceReq('全屋关灯'), ctx, runner);
    assert.equal(res.handled, true);
    assert.equal(res.speech, '已关闭2盏灯。');
    assert.equal(res.followUp, undefined);
    const switched = calls.filter(c => c.action === 'set').map(c => c.args);
    assert.deepEqual(switched, [{ did: 'l1', on: false }, { did: 'l2', on: false }]);
    assert.ok(!switched.some(a => a.did === 'outlet1' || a.did === 'outlet2'));
    assert.deepEqual(calls[0], { action: 'devices', args: { category: 'light', live: false } });

    // protected outlet in room never gets touched
    const onlyProtected = makeRunner([lifeSupport('outlet1', '生态灯')]);
    const skipped = await handleMiotVoiceFastpath(
      voiceReq('关掉客厅所有灯'),
      { homeDir: home, dataDir, devices: [lifeSupport('outlet1', '生态灯')] },
      onlyProtected.runner,
    );
    assert.equal(skipped.handled, false);
    assert.equal(onlyProtected.calls.some(c => c.action === 'set'), false);

    // partial failure reported honestly
    const flaky = makeRunner([light('l1', '客厅', '灯'), light('l2', '卧室', '灯')], {
      set: args => (args.did === 'l2' ? { ok: false, message: '离线' } : { ok: true, message: 'ok', data: {} }),
    });
    const partial = await handleMiotVoiceFastpath(voiceReq('全屋开灯'), ctx, flaky.runner);
    assert.equal(partial.speech, '已打开1盏灯，1盏没响应。');
    assert.equal((partial.data as Record<string, unknown>)?.ok, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('executor: lights query uses live state; device_set / device_get speech', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-miot-query-'));
  try {
    const dataDir = resolvePluginDataDir(home, 'miot');
    const devices = [light('l1', '客厅', '灯', true), light('l2', '卧室', '灯', false), lifeSupport('outlet1', '生态灯')];
    const ctx = { homeDir: home, dataDir, devices };

    const q = makeRunner(devices);
    const res = await handleMiotVoiceFastpath(voiceReq('家里哪些灯开着'), ctx, q.runner);
    assert.equal(res.speech, '开着的灯有：客厅灯、客厅生态灯。');
    assert.ok((res.speech ?? '').length <= 35);
    assert.deepEqual(q.calls[0], { action: 'devices', args: { category: 'light', live: true } });

    const allOff = makeRunner([light('l1', '客厅', '灯', false)]);
    assert.equal((await handleMiotVoiceFastpath(voiceReq('家里哪些灯开着'), ctx, allOff.runner)).speech, '现在没有灯开着。');

    const set = makeRunner(devices);
    const on = await handleMiotVoiceFastpath(voiceReq('打开客厅生态灯'), ctx, set.runner);
    assert.equal(on.speech, '已打开客厅生态灯。');
    assert.deepEqual(set.calls[0], { action: 'set', args: { device: '客厅生态灯', on: true } });
    const off = await handleMiotVoiceFastpath(voiceReq('关闭客厅灯'), ctx, set.runner);
    assert.equal(off.speech, '已关闭客厅灯。');

    const get = await handleMiotVoiceFastpath(voiceReq('客厅灯开着吗'), ctx, set.runner);
    assert.equal(get.speech, '客厅灯开着。');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ImGateway end-to-end with real built-in plugins/miot & plugins/tv-ir
// ---------------------------------------------------------------------------

async function until(predicate: () => boolean | Promise<boolean>, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await delay(15);
  }
  throw new Error('Timed out waiting for condition');
}

function makeChannel(id: string): ImChannelConfig {
  const now = Date.now();
  return {
    id, platform: 'xiaoai', name: id, enabled: true, notifyAll: false, allowedSenders: [],
    inboundCount: 0, outboundCount: 0, createdAt: now, updatedAt: now,
    apiBase: 'ssh://lx06=root@192.0.2.104', pollIntervalMs: 60_000,
  };
}

async function seedMiotPluginCache(home: string, devices: Dev[], config: Record<string, unknown> = {}) {
  const miotDataDir = resolvePluginDataDir(home, 'miot');
  await mkdir(miotDataDir, { recursive: true });
  await writeFile(join(miotDataDir, 'config.json'), JSON.stringify(config));
  await writeFile(join(miotDataDir, 'hub-cache.json'), JSON.stringify({
    version: 1,
    fetchedAt: Date.now(),
    hotDataFetchedAt: Date.now(),
    rooms: { r1: '客厅', r2: '卧室' },
    devices,
  }));
}

/** Real SQLite Store + ImGateway exercising genuine built-in REPO_ROOT/plugins/* via src/plugin.ts. */
async function makeGatewayHarness(home: string, channelId: string) {
  const store = new Store(home);
  const routed: Array<{ requestId: string; text: string }> = [];
  const sessionIds = new Map<string, string>();
  const coordinator = {
    homeDir: home,
    store,
    view: () => ({ mode: 'offline' }),
    subscribeOutbound: () => () => {},
    recordFastpathTurn: (input: {
      channelId: string;
      senderId: string;
      senderName?: string;
      userText: string;
      replyText: string;
      pluginName: string;
      action: string;
      latencyMs?: number;
      sessionId?: string;
      requestId?: string;
      replyId?: string;
      origin?: Record<string, unknown>;
    }) => {
      const now = Date.now();
      const key = `${input.channelId}:${input.senderId}`;
      const sessionId = input.sessionId ?? sessionIds.get(key) ?? randomUUID();
      sessionIds.set(key, sessionId);
      const userId = randomUUID();
      const userMessage = store.conversation.create({
        id: userId,
        requestId: input.requestId,
        role: 'user',
        text: input.userText,
        origin: input.origin as never,
        status: 'completed',
        paths: [],
        mode: 'offline',
        sessionId,
        routing: {
          at: now,
          status: 'completed',
          context: { execution: 'native', cwd: home, totalWorks: 0, truncated: false, works: [], messages: [] },
          actions: [{ id: randomUUID(), kind: 'plugin', status: 'accepted', at: now, summary: input.pluginName }],
        },
        at: now,
      });
      const replyMessage = store.conversation.create({
        id: input.replyId ?? randomUUID(),
        role: 'assistant',
        text: input.replyText,
        replyTo: userId,
        origin: input.origin as never,
        status: 'completed',
        paths: [],
        mode: 'offline',
        sessionId,
        at: now + 1,
      });
      return { userMessage, replyMessage };
    },
    chat: (requestId: string, text: string, _paths: string[], origin: Record<string, unknown>) => {
      routed.push({ requestId, text });
      return store.conversation.create({
        id: `routed-${routed.length}`, requestId, role: 'user', text, origin: origin as never,
        status: 'queued', paths: [], mode: 'offline',
      });
    },
  };
  const sshCalls: string[] = [];
  const sshRunner: XiaoaiSshRunner = async (_target, remoteCommand) => {
    sshCalls.push(remoteCommand);
    return { stdout: '', stderr: '', code: 0 };
  };
  store.saveImChannel(makeChannel(channelId));
  const gateway = new ImGateway(coordinator as never);
  gateway.xiaoaiDeps = { sshRunner };
  gateway.start();
  const close = async () => {
    await gateway.close();
    store.close();
  };
  return { store, gateway, sshCalls, routed, close };
}

const isTts = (cmd: string) => cmd.includes('text_to_speech') || cmd.includes('tts_play.sh');

test('ImGateway + real built-in plugins/miot: cook_clarify, AC follow-up, protectedDevices, and Router bailouts', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-miot-real-'));
  await seedMiotPluginCache(
    home,
    [
      { ...ac('ac1', '客厅'), online: true },
      { ...ac('ac2', '卧室'), online: true },
      { ...light('l1', '客厅', '灯', true), online: true },
      { ...lifeSupport('o1', '水草补光灯'), online: true },
    ],
    {
      protectedDevices: ['水草补光灯'],
      customAliases: { '水草补光灯': ['生态灯'] },
    },
  );
  const h = await makeGatewayHarness(home, 'xiaoai-fast');
  try {
    await delay(30);
    h.sshCalls.length = 0;

    // 1. Ambiguous AC utterance resolved by real plugins/miot via cache -> [[LISTEN]]
    const acRes = await h.gateway.ingestMessage({
      channelId: 'xiaoai-fast', externalId: 'fast-1', senderId: 'lx06', target: 'lx06', text: '把空调调到26度',
    });
    assert.equal(acRes.ok, true);
    assert.ok(acRes.messageId);
    assert.equal(h.routed.length, 0, 'Router must not be involved');

    const items = h.store.conversation.history(undefined, 10).items;
    assert.equal(items.length, 2);
    const user = items.find(m => m.role === 'user')!;
    const reply = items.find(m => m.role === 'assistant')!;
    assert.equal(user.routing?.actions[0]?.summary, 'miot');
    assert.equal(reply.replyTo, user.id);
    assert.equal(reply.text, '家里有多台空调，请说具体房间，比如客厅空调。 [[LISTEN]]');

    const seen = (h.gateway as unknown as { seenMessageVersions: Map<string, number> }).seenMessageVersions;
    assert.equal(seen.get(reply.id), Number.MAX_SAFE_INTEGER);
    await until(() => h.sshCalls.some(isTts));
    await delay(300);
    const spoken = h.sshCalls.filter(isTts);
    assert.equal(spoken.length, 1);
    assert.match(spoken[0]!, /多台空调/);

    // 2. Redelivery deduplicated by requestId
    const again = await h.gateway.ingestMessage({
      channelId: 'xiaoai-fast', externalId: 'fast-1', senderId: 'lx06', target: 'lx06', text: '把空调调到26度',
    });
    assert.equal(again.messageId, user.id);

    // 3. Protected device via customAlias + 的 particle blocked by real plugins/miot without Router
    h.sshCalls.length = 0;
    const protRes = await h.gateway.ingestMessage({
      channelId: 'xiaoai-fast', externalId: 'fast-2', senderId: 'lx06', target: 'lx06', text: '关闭客厅的生态灯',
    });
    assert.equal(protRes.ok, true);
    assert.equal(h.routed.length, 0);
    await until(() => h.sshCalls.some(c => isTts(c) && c.includes('保护设备')));

    // 4. Air fryer partial utterance persists pendingFryer & speaks [[LISTEN]]
    h.sshCalls.length = 0;
    const clarifyRes = await h.gateway.ingestMessage({
      channelId: 'xiaoai-fast', externalId: 'fast-3', senderId: 'lx06', target: 'lx06', text: '空气炸锅200。',
    });
    assert.equal(clarifyRes.ok, true);
    assert.equal(h.routed.length, 0);
    await until(() => h.sshCalls.some(c => isTts(c) && c.includes('200度要烤几分钟')));

    // 5. Negation & delayed utterances bail out cleanly to Router even in MiOT domain
    for (const [extId, utterance] of [
      ['bail-neg', '别关空气炸锅'],
      ['bail-delay', '5分钟后关闭客厅灯'],
      ['bail-chat', '今天天气怎么样'],
    ] as const) {
      const r = await h.gateway.ingestMessage({
        channelId: 'xiaoai-fast', externalId: extId, senderId: 'lx06', target: 'lx06', text: utterance,
      });
      assert.equal(r.action, 'routed_to_chat', utterance);
    }
    assert.deepEqual(h.routed.map(r => r.text), ['别关空气炸锅', '5分钟后关闭客厅灯', '今天天气怎么样']);
  } finally {
    await h.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('ImGateway + real plugins/tv-ir & plugins/miot: TV remote continuous session suppresses MiOT; missing device routes to Router', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-miot-tv-'));
  await seedMiotPluginCache(home, [{ ...ac('ac1', '客厅'), online: true }]);
  const tvIrDataDir = resolvePluginDataDir(home, 'tv-ir');
  await mkdir(tvIrDataDir, { recursive: true });
  await writeFile(join(tvIrDataDir, 'config.json'), JSON.stringify({ sshTarget: 'root@192.0.2.104' }));

  const h = await makeGatewayHarness(home, 'xiaoai-tv-gate');
  try {
    await delay(30);
    // Enter real TV remote continuous mode via plugins/tv-ir
    const enterTv = await h.gateway.ingestMessage({
      channelId: 'xiaoai-tv-gate', externalId: 'tv-1', senderId: 'lx06', target: 'lx06', text: '遥控电视模式',
    });
    assert.equal(enterTv.action, 'tv_remote_enter');
    assert.equal(h.routed.length, 0);

    // While continuous TV remote session owns the dialog, MiOT utterance is suppressed
    const tvTurn = await h.gateway.ingestMessage({
      channelId: 'xiaoai-tv-gate', externalId: 'tv-2', senderId: 'lx06', target: 'lx06', text: '关闭客厅空调',
    });
    assert.equal(tvTurn.action, 'voice_fastpath_ignored');
    assert.equal(h.routed.length, 0);

    // Exit TV remote mode with "好了"
    const exitTv = await h.gateway.ingestMessage({
      channelId: 'xiaoai-tv-gate', externalId: 'tv-3', senderId: 'lx06', target: 'lx06', text: '好了',
    });
    assert.equal(exitTv.action, 'tv_remote_exit');

    // Unknown device not in MiOT cache falls through seamlessly to Router
    const miss = await h.gateway.ingestMessage({
      channelId: 'xiaoai-tv-gate', externalId: 'fb-1', senderId: 'lx06', target: 'lx06', text: '打开未知咖啡机',
    });
    assert.equal(miss.action, 'routed_to_chat');
    assert.deepEqual(h.routed.map(r => r.text), ['打开未知咖啡机']);
  } finally {
    await h.close();
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Short-clip voiceprint relief
// ---------------------------------------------------------------------------

test('verifyAndTrimUtterance relaxes the threshold for ≤2.0s clips but still rejects strangers and honours overrides', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-xiaoai-spk-short-'));
  try {
    let score = 1;
    const factory = (): XiaoaiSpeakerExtractor => ({
      dim: 2,
      extract: () => new Float32Array([score, Math.sqrt(Math.max(0, 1 - score * score))]),
      free() {},
    });
    const manager = new XiaoaiSpeakerManager({ homeDir: home, extractorFactory: factory });
    score = 1;
    manager.enrollEmbeddings({ name: '主人', role: 'owner', embeddings: [new Float32Array([1, 0])] });
    manager.configure({ threshold: 0.39 });
    const clip = (seconds: number) => new Float32Array(Math.round(SPEAKER_SAMPLE_RATE * seconds)).fill(0.1);

    // short wake+command clip: 0.363 < 0.39 but ≥ max(0.32, 0.39-0.04)=0.35 → accepted
    score = 0.363;
    const shortOk = manager.verifyAndTrimUtterance(clip(1.5), SPEAKER_SAMPLE_RATE);
    assert.equal(shortOk.matched, true);
    assert.equal(shortOk.speaker?.name, '主人');
    assert.ok(Math.abs(shortOk.threshold - 0.35) < 1e-9, `threshold ${shortOk.threshold}`);
    assert.equal(manager.verifyAndTrimUtterance(clip(2.0), SPEAKER_SAMPLE_RATE).matched, true);

    // 2.0s < len ≤ 2.2s still uses the full threshold
    assert.equal(manager.verifyAndTrimUtterance(clip(2.1), SPEAKER_SAMPLE_RATE).matched, false);

    // explicit override is honoured exactly (no extra relief)
    assert.equal(manager.verifyAndTrimUtterance(clip(1.5), SPEAKER_SAMPLE_RATE, { thresholdOverride: 0.39 }).matched, false);
    assert.equal(manager.verifyAndTrimUtterance(clip(1.5), SPEAKER_SAMPLE_RATE, { thresholdOverride: 0.36 }).matched, true);

    // non-members stay rejected
    for (const stranger of [0.03, 0.25, 0.31]) {
      score = stranger;
      assert.equal(manager.verifyAndTrimUtterance(clip(1.5), SPEAKER_SAMPLE_RATE).matched, false, `score ${stranger}`);
    }

    // floor of 0.32 for low configured thresholds
    manager.configure({ threshold: 0.30 });
    score = 0.31;
    assert.equal(manager.verifyAndTrimUtterance(clip(1.5), SPEAKER_SAMPLE_RATE).matched, false);
    score = 0.33;
    assert.equal(manager.verifyAndTrimUtterance(clip(1.5), SPEAKER_SAMPLE_RATE).matched, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

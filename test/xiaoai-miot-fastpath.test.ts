import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createDefaultMiotRunner,
  executeXiaoaiMiotFastpath,
  parseChineseNumber,
  parseXiaoaiMiotUtterance,
  type XiaoaiMiotFastIntent,
  type XiaoaiMiotRunner,
} from '../src/xiaoai-miot-fastpath.js';
import { ImGateway } from '../src/im.js';
import { Store, type ImChannelConfig } from '../src/store.js';
import type { XiaoaiSshRunner } from '../src/xiaoai.js';
import { SPEAKER_SAMPLE_RATE, XiaoaiSpeakerManager, type XiaoaiSpeakerExtractor } from '../src/xiaoai-speaker.js';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const cook = (op: string, extra: Record<string, unknown> = {}): XiaoaiMiotFastIntent =>
  ({ kind: 'cook', args: { device: '空气炸锅', op, ...extra } }) as XiaoaiMiotFastIntent;

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
  assert.equal(parseChineseNumber('哈哈'), undefined);
});

test('parser: air fryer cook / stop / pause / resume / status incl. ASR homophones', () => {
  assert.deepEqual(parseXiaoaiMiotUtterance('空气炸锅200度5分钟'), cook('start', { tempC: 200, minutes: 5 }));
  assert.deepEqual(parseXiaoaiMiotUtterance('请帮我把空气炸锅调到两百度五分钟'), cook('start', { tempC: 200, minutes: 5 }));
  assert.deepEqual(parseXiaoaiMiotUtterance('空炸一百八十度半小时'), cook('start', { tempC: 180, minutes: 30 }));
  assert.deepEqual(parseXiaoaiMiotUtterance('炸锅180度十五分钟。'), cook('start', { tempC: 180, minutes: 15 }));
  assert.deepEqual(parseXiaoaiMiotUtterance('空气炸锅做薯条'), cook('start', { recipe: '薯条' }));
  assert.deepEqual(parseXiaoaiMiotUtterance('空气炸锅烤地瓜'), cook('start', { recipe: '红薯' }));
  assert.deepEqual(parseXiaoaiMiotUtterance('空气炸锅烤鸡翅200度20分钟'), cook('start', { tempC: 200, minutes: 20, recipe: '鸡翅' }));

  for (const t of ['关闭空气炸播', '关掉空气炸国', '停止空气炸果', '星期五，关闭空气炸锅。', '取消炸锅', '把空气炸锅关了']) {
    assert.deepEqual(parseXiaoaiMiotUtterance(t), cook('stop'), t);
  }
  assert.deepEqual(parseXiaoaiMiotUtterance('暂停空气炸锅'), cook('pause'));
  assert.deepEqual(parseXiaoaiMiotUtterance('空气炸锅继续'), cook('resume'));
  assert.deepEqual(parseXiaoaiMiotUtterance('恢复空气炸锅'), cook('resume'));
  for (const t of ['空气炸锅还剩多久', '空气炸锅还要几分钟', '空气炸锅开着吗', '空气炸锅做好没', '空气炸锅关了吗', '空气炸锅在工作吗']) {
    assert.deepEqual(parseXiaoaiMiotUtterance(t), cook('status'), t);
  }
});

test('parser: air conditioner room / power / temperature / mode / fan', () => {
  assert.deepEqual(parseXiaoaiMiotUtterance('打开客厅空调'), { kind: 'ac_control', room: '客厅', needsRoomCheck: false, on: true });
  assert.deepEqual(parseXiaoaiMiotUtterance('关闭卧室空调'), { kind: 'ac_control', room: '卧室', needsRoomCheck: false, on: false });
  assert.deepEqual(parseXiaoaiMiotUtterance('把空调调到26度'), { kind: 'ac_control', needsRoomCheck: true, temperature: 26 });
  assert.deepEqual(parseXiaoaiMiotUtterance('客厅空调制冷二十六度低风'), {
    kind: 'ac_control', room: '客厅', needsRoomCheck: false, temperature: 26, mode: 'cool', fanSpeed: 'low',
  });
  assert.deepEqual(parseXiaoaiMiotUtterance('空调开到除湿'), { kind: 'ac_control', needsRoomCheck: true, on: true, mode: 'dry' });
  assert.deepEqual(parseXiaoaiMiotUtterance('主卧空调自动风'), { kind: 'ac_control', room: '主卧', needsRoomCheck: false, fanSpeed: 'auto' });
  // out-of-range temperature, relative adjustments, queries, multi-room → Router
  assert.equal(parseXiaoaiMiotUtterance('客厅空调调到35度'), undefined);
  assert.equal(parseXiaoaiMiotUtterance('客厅空调调高一点'), undefined);
  assert.equal(parseXiaoaiMiotUtterance('客厅空调开着吗'), undefined);
  assert.equal(parseXiaoaiMiotUtterance('客厅和卧室空调'), undefined);
  assert.equal(parseXiaoaiMiotUtterance('空调'), undefined);
});

test('parser: lights batch / query and outlet device set/get', () => {
  for (const t of ['全屋关灯', '把家里灯都关了', '关掉所有灯', '关闭全部灯']) {
    assert.deepEqual(parseXiaoaiMiotUtterance(t), { kind: 'lights_batch', on: false }, t);
  }
  assert.deepEqual(parseXiaoaiMiotUtterance('打开客厅所有灯'), { kind: 'lights_batch', room: '客厅', on: true });
  assert.deepEqual(parseXiaoaiMiotUtterance('全屋开灯'), { kind: 'lights_batch', on: true });
  for (const t of ['家里哪些灯开着', '还有什么灯没关', '看看哪些灯亮着']) {
    assert.deepEqual(parseXiaoaiMiotUtterance(t), { kind: 'lights_query' }, t);
  }
  assert.deepEqual(parseXiaoaiMiotUtterance('打开鱼缸灯'), { kind: 'device_set', device: '鱼缸灯', on: true });
  assert.deepEqual(parseXiaoaiMiotUtterance('把乌龟灯关掉'), { kind: 'device_set', device: '乌龟灯', on: false });
  assert.deepEqual(parseXiaoaiMiotUtterance('关闭客厅灯'), { kind: 'device_set', device: '客厅灯', on: false });
  assert.deepEqual(parseXiaoaiMiotUtterance('关闭客厅开关'), { kind: 'device_set', device: '客厅开关', on: false });
  assert.deepEqual(parseXiaoaiMiotUtterance('切换书房插座'), { kind: 'device_set', device: '书房插座', toggle: true });
  assert.deepEqual(parseXiaoaiMiotUtterance('鱼缸灯开着吗'), { kind: 'device_get', device: '鱼缸灯' });
  assert.deepEqual(parseXiaoaiMiotUtterance('乌龟灯关了吗'), { kind: 'device_get', device: '乌龟灯' });
  // A bare "灯" is never guessed (could hit a life-support light)
  assert.equal(parseXiaoaiMiotUtterance('关灯'), undefined);
  assert.equal(parseXiaoaiMiotUtterance('开灯'), undefined);
  assert.equal(parseXiaoaiMiotUtterance('关掉所有灯鱼缸灯除外'), undefined);
  // The life-support lights are never part of a batch intent
  assert.notEqual(parseXiaoaiMiotUtterance('关掉全部鱼缸灯')?.kind, 'lights_batch');
});

test('parser bailouts: timers, multi-step, TV/voiceprint, unsafe numbers, non-smart-home', () => {
  const bail = [
    '5分钟后关空气炸锅', '预约30分钟空气炸锅', '半小时后关闭空气炸锅', '定时关灯', '明天早上七点开空调', '过一会关空气炸锅',
    '三分钟之后关掉空气炸锅', '提醒我关火', '八点关灯',
    '如果下雨就关灯', '关灯然后开空调', '顺便把空调打开', '空气炸锅怎么回事', '把空气炸锅状态发给微信',
    '打开电视', '关闭投影', '录入我的声纹', '电视遥控模式',
    '空气炸锅250度5分钟',     // above fryer limit
    '空气炸锅250',            // bare above fryer limit
    '别关空气炸锅', '不要关灯', '你好', '今天天气怎么样', '',
    '空气炸锅' + '二百度五分钟'.repeat(8), // > 36 chars
  ];
  for (const t of bail) assert.equal(parseXiaoaiMiotUtterance(t), undefined, `should bail: "${t}"`);
  // ...whereas a plain duration without 后/之后/定时/预约 is a cook command
  assert.deepEqual(parseXiaoaiMiotUtterance('空气炸锅200度5分钟'), cook('start', { tempC: 200, minutes: 5 }));
});

test('parser & executor: partial air fryer utterances clarify locally and merge follow-up slots', async () => {
  assert.deepEqual(parseXiaoaiMiotUtterance('空气炸锅。'), { kind: 'cook_clarify' });
  assert.deepEqual(parseXiaoaiMiotUtterance('打开空气炸锅'), { kind: 'cook_clarify' });
  assert.deepEqual(parseXiaoaiMiotUtterance('空气炸锅200。'), { kind: 'cook_clarify', tempC: 200 });
  assert.deepEqual(parseXiaoaiMiotUtterance('空气炸锅两百'), { kind: 'cook_clarify', tempC: 200 });
  assert.deepEqual(parseXiaoaiMiotUtterance('空气炸锅200度'), { kind: 'cook_clarify', tempC: 200 });
  assert.deepEqual(parseXiaoaiMiotUtterance('空气炸锅15分钟'), { kind: 'cook_clarify', minutes: 15 });

  // Slot continuation merges missing temp or duration without repeating "空气炸锅"
  assert.deepEqual(
    parseXiaoaiMiotUtterance('5分钟', { tempC: 200 }),
    cook('start', { tempC: 200, minutes: 5 }),
  );
  assert.deepEqual(
    parseXiaoaiMiotUtterance('180度', { minutes: 15 }),
    cook('start', { tempC: 180, minutes: 15 }),
  );
  assert.deepEqual(
    parseXiaoaiMiotUtterance('十', { tempC: 200 }),
    cook('start', { tempC: 200, minutes: 10 }),
  );
  // Open questions never falsely merge into fryer slots
  assert.equal(parseXiaoaiMiotUtterance('现在房间几度', { tempC: 200 }), undefined);

  const { runner, calls } = makeRunner([]);
  const askAll = await executeXiaoaiMiotFastpath({ kind: 'cook_clarify' }, { runMiot: runner });
  assert.equal(askAll.handled, true);
  assert.equal(askAll.followUp, true);
  assert.equal(askAll.speech, '空气炸锅要设多少度、几分钟？');

  const askMin = await executeXiaoaiMiotFastpath({ kind: 'cook_clarify', tempC: 200 }, { runMiot: runner });
  assert.equal(askMin.speech, '200度要烤几分钟？');
  assert.equal(askMin.followUp, true);

  const askTemp = await executeXiaoaiMiotFastpath({ kind: 'cook_clarify', minutes: 15 }, { runMiot: runner });
  assert.equal(askTemp.speech, '15分钟要设多少度？');
  assert.equal(askTemp.followUp, true);
  assert.equal(calls.length, 0);

  // End-to-end ImGateway two-turn slot continuation: "空气炸锅200。" -> asks minutes -> "五分钟" -> starts fryer
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-xiaoai-miot-slot-'));
  const gw = makeRunner([], {
    cook: args => ({ ok: true, message: 'x', data: { tempC: args.tempC, minutes: args.minutes } }),
  });
  const h = makeGatewayHarness(home, 'xiaoai-slot', gw.runner);
  try {
    await delay(30);
    h.sshCalls.length = 0;

    const turn1 = await h.gateway.ingestMessage({
      channelId: 'xiaoai-slot', externalId: 'slot-1', senderId: 'lx06', target: 'lx06', text: '空气炸锅200。',
    });
    assert.equal(turn1.action, 'xiaoai_miot_fastpath');
    assert.equal(h.routed.length, 0);
    assert.equal(gw.calls.length, 0);
    await until(() => h.sshCalls.some(c => isTts(c) && c.includes('200度要烤几分钟')));

    h.sshCalls.length = 0;
    const turn2 = await h.gateway.ingestMessage({
      channelId: 'xiaoai-slot', externalId: 'slot-2', senderId: 'lx06', target: 'lx06', text: '五分钟',
    });
    assert.equal(turn2.action, 'xiaoai_miot_fastpath');
    assert.equal(h.routed.length, 0);
    assert.deepEqual(gw.calls, [{ action: 'cook', args: { device: '空气炸锅', op: 'start', tempC: 200, minutes: 5 } }]);
    await until(() => h.sshCalls.some(c => isTts(c) && c.includes('200度5分钟')));
  } finally {
    await h.close();
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Executor with a stub MiOT runner
// ---------------------------------------------------------------------------

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

function makeRunner(devices: Dev[], overrides: Partial<Record<string, (args: Record<string, unknown>) => Record<string, unknown>>> = {}) {
  const calls: Array<{ action: string; args: Record<string, unknown> }> = [];
  const runner: XiaoaiMiotRunner = async (action, args) => {
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
      if (!dev) return { ok: false, message: `未找到设备 "${String(args.device)}"。` };
      return { ok: true, message: 'ok', data: { device: dev, on: args.on, ...(args.toggle ? { on: true } : {}) } };
    }
    if (action === 'get') {
      const dev = devices.find(d => d.fullName === args.device || d.name === args.device);
      if (!dev) return { ok: false, message: `未找到设备 "${String(args.device)}"。` };
      return { ok: true, message: 'ok', data: { device: dev, on: true } };
    }
    return { ok: true, message: 'ok', data: {} };
  };
  return { runner, calls };
}

test('executor: cook start / stop / pause / resume / status speech is crisp', async () => {
  const fryer = (statusCode: number, statusText: string, leftTimeMin?: number) => ({
    ok: true, message: 'x', data: { fryer: { statusCode, statusText, leftTimeMin } },
  });
  const run = async (intent: XiaoaiMiotFastIntent, result: Record<string, unknown>) => {
    const { runner, calls } = makeRunner([], { cook: () => result });
    const res = await executeXiaoaiMiotFastpath(intent, { runMiot: runner });
    return { res, calls };
  };

  const start = await run(cook('start', { tempC: 200, minutes: 5 }), { ok: true, message: 'x', data: { tempC: 200, minutes: 5 } });
  assert.deepEqual(start.res, { handled: true, ok: true, speech: '空气炸锅已启动，200度5分钟。', followUp: false, actionName: 'cook' });
  assert.deepEqual(start.calls[0], { action: 'cook', args: { device: '空气炸锅', op: 'start', tempC: 200, minutes: 5 } });

  const recipe = await run(cook('start', { recipe: '薯条' }), { ok: true, message: 'x', data: { tempC: 180, minutes: 15 } });
  assert.equal(recipe.res.speech, '空气炸锅已启动，薯条，180度15分钟。');

  assert.equal((await run(cook('stop'), { ok: true, message: 'x', data: {} })).res.speech, '空气炸锅已关闭。');
  assert.equal((await run(cook('pause'), { ok: true, message: 'x', data: {} })).res.speech, '空气炸锅已暂停。');
  assert.equal((await run(cook('resume'), { ok: true, message: 'x', data: {} })).res.speech, '空气炸锅已继续烹饪。');
  assert.equal((await run(cook('status'), fryer(4, '烹饪中', 5))).res.speech, '空气炸锅正在烹饪，剩余5分钟。');
  assert.equal((await run(cook('status'), fryer(1, '待机'))).res.speech, '空气炸锅现在没有在工作。');
  for (const r of ['空气炸锅已关闭。', '空气炸锅正在烹饪，剩余5分钟。', '空气炸锅已启动，200度5分钟。']) assert.ok(r.length <= 30);

  const failed = await run(cook('start', { tempC: 200, minutes: 5 }), {
    ok: false, message: '空气炸锅处于「抽锅暂停」：炸篮被拉出，物理互锁会切断加热回路', data: {},
  });
  assert.equal(failed.res.handled, true);
  assert.equal(failed.res.ok, false);
  assert.match(failed.res.speech ?? '', /炸篮/);
});

test('executor: AMBIGUOUS_DEVICE speaks a clarification; DEVICE_NOT_FOUND / crashes fall back to Router', async () => {
  const intent = cook('stop');
  const ambiguous = await executeXiaoaiMiotFastpath(intent, {
    runMiot: makeRunner([], { cook: () => ({ ok: false, message: '"x" 匹配到多个设备：a、b。', data: { needsClarification: true } }) }).runner,
  });
  assert.deepEqual(ambiguous, {
    handled: true, ok: true, speech: '匹配到多个设备，请带上具体房间名称再说一次。', followUp: true, actionName: 'cook',
  });

  const notFound = await executeXiaoaiMiotFastpath({ kind: 'device_set', device: '鱼缸灯', on: true }, {
    runMiot: makeRunner([]).runner,
  });
  assert.deepEqual(notFound, { handled: false });

  const coded = await executeXiaoaiMiotFastpath(intent, {
    runMiot: async () => ({ ok: false, code: 'DEVICE_NOT_FOUND', message: 'nope' }),
  });
  assert.deepEqual(coded, { handled: false });

  const thrown = await executeXiaoaiMiotFastpath(intent, { runMiot: async () => { throw new Error('boom'); } });
  assert.deepEqual(thrown, { handled: false });

  const thrownAmbiguous = await executeXiaoaiMiotFastpath(intent, {
    runMiot: async () => { throw Object.assign(new Error('multi'), { code: 'AMBIGUOUS_DEVICE' }); },
  });
  assert.equal(thrownAmbiguous.handled, true);
  assert.equal(thrownAmbiguous.followUp, true);
});

test('executor: AC without a room asks for one when several ACs exist; unique AC executes', async () => {
  const intent = parseXiaoaiMiotUtterance('把空调调到26度')!;
  assert.equal(intent.kind, 'ac_control');

  const multi = makeRunner([ac('ac1', '客厅'), ac('ac2', '卧室')]);
  const asked = await executeXiaoaiMiotFastpath(intent, { runMiot: multi.runner });
  assert.equal(asked.handled, true);
  assert.equal(asked.ok, true);
  assert.equal(asked.speech, '家里有多台空调，请说具体房间，比如客厅空调。');
  assert.equal(asked.followUp, true);
  assert.equal(multi.calls.some(c => c.action === 'set'), false, 'must not guess an AC');
  assert.deepEqual(multi.calls[0], { action: 'devices', args: { category: 'air_conditioner' } });

  const withRoom = makeRunner([ac('ac1', '客厅'), ac('ac2', '卧室')]);
  const done = await executeXiaoaiMiotFastpath(parseXiaoaiMiotUtterance('客厅空调制冷26度')!, { runMiot: withRoom.runner });
  assert.equal(done.speech, '客厅空调已调到26度，切到制冷。');
  assert.deepEqual(withRoom.calls.find(c => c.action === 'set')?.args, { did: 'ac1', temperature: 26, mode: 'cool' });

  const single = makeRunner([ac('ac1', '客厅')]);
  const one = await executeXiaoaiMiotFastpath(intent, { runMiot: single.runner });
  assert.equal(one.handled, true);
  assert.deepEqual(single.calls.find(c => c.action === 'set')?.args, { did: 'ac1', temperature: 26 });

  const none = await executeXiaoaiMiotFastpath(intent, { runMiot: makeRunner([]).runner });
  assert.deepEqual(none, { handled: false });
});

test('executor: whole-home lights-off only touches real BT-mesh lights, never 鱼缸灯/乌龟灯 outlets', async () => {
  const devices = [
    light('l1', '客厅', '灯', true), light('l2', '卧室', '灯', true),
    { ...light('l3', '书房', '灯'), controllable: false },       // not controllable
    { ...light('l4', '餐厅', '灯'), controlChannel: 'miio_udp' }, // not BT mesh
    lifeSupport('fish', '鱼缸灯'), lifeSupport('turtle', '乌龟灯'),
  ];
  const { runner, calls } = makeRunner(devices);
  const res = await executeXiaoaiMiotFastpath({ kind: 'lights_batch', on: false }, { runMiot: runner });
  assert.deepEqual(res, { handled: true, ok: true, speech: '已关闭2盏灯。', followUp: false, actionName: 'set' });
  const switched = calls.filter(c => c.action === 'set').map(c => c.args);
  assert.deepEqual(switched, [{ did: 'l1', on: false }, { did: 'l2', on: false }]);
  assert.ok(!switched.some(a => a.did === 'fish' || a.did === 'turtle'));
  assert.deepEqual(calls[0], { action: 'devices', args: { category: 'light' } });

  // room-scoped + only life-support devices in scope → nothing to do, Router decides
  const only = makeRunner([lifeSupport('fish', '鱼缸灯')]);
  assert.deepEqual(await executeXiaoaiMiotFastpath({ kind: 'lights_batch', room: '客厅', on: false }, { runMiot: only.runner }), { handled: false });
  assert.equal(only.calls.some(c => c.action === 'set'), false);

  // partial failure is reported honestly
  const flaky = makeRunner([light('l1', '客厅', '灯'), light('l2', '卧室', '灯')], {
    set: args => (args.did === 'l2' ? { ok: false, message: '离线' } : { ok: true, message: 'ok', data: {} }),
  });
  const partial = await executeXiaoaiMiotFastpath({ kind: 'lights_batch', on: true }, { runMiot: flaky.runner });
  assert.equal(partial.speech, '已打开1盏灯，1盏没响应。');
  assert.equal(partial.ok, false);
});

test('executor: lights query uses live state; device_set / device_get speech', async () => {
  const devices = [light('l1', '客厅', '灯', true), light('l2', '卧室', '灯', false), lifeSupport('fish', '鱼缸灯')];
  const q = makeRunner(devices);
  const res = await executeXiaoaiMiotFastpath({ kind: 'lights_query' }, { runMiot: q.runner });
  assert.equal(res.speech, '开着的灯有：客厅灯、客厅鱼缸灯。');
  assert.ok((res.speech ?? '').length <= 35);
  assert.deepEqual(q.calls[0], { action: 'devices', args: { category: 'light', live: true } });

  const allOff = makeRunner([light('l1', '客厅', '灯', false)]);
  assert.equal((await executeXiaoaiMiotFastpath({ kind: 'lights_query' }, { runMiot: allOff.runner })).speech, '现在没有灯开着。');

  const set = makeRunner(devices);
  const on = await executeXiaoaiMiotFastpath({ kind: 'device_set', device: '客厅鱼缸灯', on: true }, { runMiot: set.runner });
  assert.equal(on.speech, '已打开客厅鱼缸灯。');
  assert.deepEqual(set.calls[0], { action: 'set', args: { device: '客厅鱼缸灯', on: true } });
  const off = await executeXiaoaiMiotFastpath({ kind: 'device_set', device: '客厅灯', on: false }, { runMiot: set.runner });
  assert.equal(off.speech, '已关闭客厅灯。');

  const get = await executeXiaoaiMiotFastpath({ kind: 'device_get', device: '客厅灯' }, { runMiot: set.runner });
  assert.equal(get.speech, '客厅灯开着。');
});

test('createDefaultMiotRunner lazily imports the plugin once and passes homeDir/dataDir', async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'sa-miot-runner-'));
  try {
    await mkdir(join(dir, 'p'), { recursive: true });
    const entry = join(dir, 'p', 'index.mjs');
    await writeFile(entry, `
globalThis.__miotLoads = (globalThis.__miotLoads ?? 0) + 1;
export async function runAction(action, args, deps) { return { ok: true, message: action, data: { args, deps } }; }
`);
    const runner = createDefaultMiotRunner({ homeDir: dir, entryPath: entry });
    const a = await runner('status', { x: 1 });
    const b = await runner('cook', {});
    assert.equal(a.ok, true);
    assert.deepEqual((a.data as { deps: unknown }).deps, { homeDir: dir, dataDir: join(dir, 'plugins', 'miot') });
    assert.equal(b.message, 'cook');
    assert.equal((globalThis as unknown as { __miotLoads: number }).__miotLoads, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ImGateway end-to-end
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
    apiBase: 'ssh://lx06=root@192.168.31.104', pollIntervalMs: 60_000,
  };
}

/** Real SQLite Store + minimal Coordinator surface (the full Coordinator spawns a compiled executor child). */
function makeGatewayHarness(home: string, channelId: string, miotRunner: XiaoaiMiotRunner) {
  const store = new Store(home);
  const routed: Array<{ requestId: string; text: string }> = [];
  const coordinator = {
    store,
    view: () => ({ mode: 'offline' }),
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
  gateway.xiaoaiDeps = { sshRunner, miotRunner };
  gateway.start();
  const close = async () => {
    await gateway.close();
    store.close();
  };
  return { store, gateway, sshCalls, routed, close };
}

const isTts = (cmd: string) => cmd.includes('text_to_speech') || cmd.includes('tts_play.sh');

test('ImGateway: MiOT fast path persists history, speaks exactly once, and never wakes the Router', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-xiaoai-miot-'));
  const { runner, calls } = makeRunner([], {
    cook: args => (args.op === 'status'
      ? { ok: true, message: 'x', data: { fryer: { statusCode: 4, statusText: '烹饪中', leftTimeMin: 5 } } }
      : { ok: true, message: 'x', data: { tempC: args.tempC, minutes: args.minutes } }),
  });
  const h = makeGatewayHarness(home, 'xiaoai-fast', runner);
  try {
    await delay(30);
    h.sshCalls.length = 0;

    const res = await h.gateway.ingestMessage({
      channelId: 'xiaoai-fast', externalId: 'fast-1', senderId: 'lx06', target: 'lx06', text: '空气炸锅200度5分钟',
    });
    assert.equal(res.ok, true);
    assert.equal(res.action, 'xiaoai_miot_fastpath');
    assert.ok(res.messageId);
    assert.deepEqual(calls.filter(c => c.action === 'cook').map(c => c.args), [{ device: '空气炸锅', op: 'start', tempC: 200, minutes: 5 }]);
    assert.equal(h.routed.length, 0, 'Router must not be involved');

    // Both turns persisted
    const items = h.store.conversation.history(undefined, 10).items;
    assert.equal(items.length, 2);
    const user = items.find(m => m.role === 'user')!;
    const reply = items.find(m => m.role === 'assistant')!;
    assert.equal(user.id, res.messageId);
    assert.equal(user.status, 'completed');
    assert.equal(user.text, '空气炸锅200度5分钟');
    assert.equal(user.origin?.channel, 'xiaoai');
    assert.equal(user.origin?.channelId, 'xiaoai-fast');
    assert.ok(user.sessionId);
    assert.equal(user.routing?.actions[0]?.kind, 'plugin');
    assert.equal(user.routing?.actions[0]?.status, 'accepted');
    assert.equal(reply.replyTo, user.id);
    assert.equal(reply.status, 'completed');
    assert.equal(reply.text, '空气炸锅已启动，200度5分钟。 [[END]]');
    assert.equal(reply.sessionId, user.sessionId);
    assert.equal(h.store.list().length, 0);

    // seenMessageVersions pre-marked so flushOutboundUpdates() cannot replay the reply
    const seen = (h.gateway as unknown as { seenMessageVersions: Map<string, number> }).seenMessageVersions;
    assert.equal(seen.get(reply.id), Number.MAX_SAFE_INTEGER);

    // Exactly one spoken reply, even after several outbound flush ticks (150ms interval)
    await until(() => h.sshCalls.some(isTts));
    await delay(600);
    const spoken = h.sshCalls.filter(isTts);
    assert.equal(spoken.length, 1, `expected a single TTS, got ${spoken.length}`);
    assert.match(spoken[0]!, /空气炸锅已启动/);

    // Redelivery with the same externalId is deduplicated by requestId
    const again = await h.gateway.ingestMessage({
      channelId: 'xiaoai-fast', externalId: 'fast-1', senderId: 'lx06', target: 'lx06', text: '空气炸锅200度5分钟',
    });
    assert.equal(again.messageId, user.id);
    assert.equal(calls.filter(c => c.action === 'cook').length, 1);

    // Status query speaks the remaining time
    h.sshCalls.length = 0;
    const status = await h.gateway.ingestMessage({
      channelId: 'xiaoai-fast', externalId: 'fast-2', senderId: 'lx06', target: 'lx06', text: '空气炸锅还剩多久',
    });
    assert.equal(status.action, 'xiaoai_miot_fastpath');
    await until(() => h.sshCalls.some(c => isTts(c) && c.includes('剩余5分钟')));
  } finally {
    await h.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('ImGateway: ambiguous fast path replies with [[LISTEN]] follow-up; TV remote mode and unrelated chatter skip it', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-xiaoai-miot-amb-'));
  const { runner, calls } = makeRunner([ac('ac1', '客厅'), ac('ac2', '卧室')]);
  const h = makeGatewayHarness(home, 'xiaoai-amb', runner);
  try {
    await delay(30);
    const res = await h.gateway.ingestMessage({
      channelId: 'xiaoai-amb', externalId: 'amb-1', senderId: 'lx06', target: 'lx06', text: '把空调调到26度',
    });
    assert.equal(res.action, 'xiaoai_miot_fastpath');
    const reply = h.store.conversation.history(undefined, 10).items.find(m => m.role === 'assistant')!;
    assert.equal(reply.text, '家里有多台空调，请说具体房间，比如客厅空调。 [[LISTEN]]');
    assert.equal(calls.some(c => c.action === 'set'), false);

    const chat = await h.gateway.ingestMessage({
      channelId: 'xiaoai-amb', externalId: 'amb-2', senderId: 'lx06', target: 'lx06', text: '今天天气怎么样',
    });
    assert.equal(chat.action, 'routed_to_chat');
    assert.deepEqual(h.routed.map(r => r.text), ['今天天气怎么样']);
    assert.equal(calls.length, 1, 'non smart-home chatter never reaches the MiOT runner');

    // While the TV remote mode owns the dialog the fast path stays out of the way
    const tv = (h.gateway as unknown as { xiaoaiTvRemote: { isActive: (c: string, t: string) => boolean } }).xiaoaiTvRemote;
    tv.isActive = () => true;
    const callsBefore = calls.length;
    const tvTurn = await h.gateway.ingestMessage({
      channelId: 'xiaoai-amb', externalId: 'amb-3', senderId: 'lx06', target: 'lx06', text: '关闭客厅空调',
    }).catch(() => undefined);
    assert.equal(calls.length, callsBefore, 'MiOT runner untouched while TV remote mode is active');
    void tvTurn;
  } finally {
    await h.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('ImGateway: DEVICE_NOT_FOUND falls through to the Router seamlessly', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-xiaoai-miot-fb-'));
  const { runner, calls } = makeRunner([], { cook: () => ({ ok: false, message: '未找到设备 "空气炸锅"。可用设备：（无）。' }) });
  const h = makeGatewayHarness(home, 'xiaoai-fb', runner);
  try {
    await delay(30);
    const miss = await h.gateway.ingestMessage({
      channelId: 'xiaoai-fb', externalId: 'fb-1', senderId: 'lx06', target: 'lx06', text: '空气炸锅200度5分钟',
    });
    assert.equal(miss.action, 'routed_to_chat');
    assert.equal(calls.length, 1);
    assert.deepEqual(h.routed.map(r => r.text), ['空气炸锅200度5分钟']);
    // nothing was persisted by the fast path itself
    assert.equal(h.store.conversation.history(undefined, 10).items.filter(m => m.role === 'assistant').length, 0);

    // A crashing runner also degrades to the Router
    const crashHome = await mkdtemp(join(await realpath(tmpdir()), 'sa-xiaoai-miot-fb2-'));
    const crash = makeGatewayHarness(crashHome, 'xiaoai-crash', async () => { throw new Error('plugin exploded'); });
    try {
      await delay(30);
      const r = await crash.gateway.ingestMessage({
        channelId: 'xiaoai-crash', externalId: 'c-1', senderId: 'lx06', target: 'lx06', text: '关闭空气炸播',
      });
      assert.equal(r.action, 'routed_to_chat');
      assert.equal(crash.routed.length, 1);
    } finally {
      await crash.close();
      await rm(crashHome, { recursive: true, force: true });
    }
  } finally {
    await h.close();
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Short-clip voiceprint relief
// ---------------------------------------------------------------------------

test('verifyAndTrimUtterance relaxes the threshold for ≤2.0s clips but still rejects strangers and honours overrides', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-xiaoai-spk-short-'));
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

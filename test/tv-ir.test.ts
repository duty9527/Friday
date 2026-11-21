import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { listPlugins, runPlugin } from '../src/plugin.js';
import {
  encodeXiaomiIrFrame,
  executeTvIrAction,
  discoverSpeakerSsh,
  handleVoiceFastpath,
  parseSequenceSteps,
  resolveKeySpec,
} from '../plugins/tv-ir/index.mjs';
import {
  isAssistantTvRemoteActivation,
  parseTvRemoteEntryUtterance,
  parseTvRemoteInModeUtterance,
} from '../src/xiaoai-tv-remote.js';
import {
  isAssistantTvRemoteActivation as isPluginTvRemoteActivation,
  parseTvRemoteEntryPhrase,
  parseTvRemoteStepsPhrase,
} from '../plugins/tv-ir/voice-fastpath.mjs';

const LX06_POWER_IR_PLAY0 =
  '1000,570,600,570,600,1470,600,1470,600,570,600,1470,600,570,600,1470,600,570,600,1470,600,1470,600,10510,' +
  '1000,570,600,570,600,1470,600,1470,600,570,600,1470,600,570,600,1470,600,570,600,1470,600,1470,600,10510,' +
  '1000,570,600,570,600,1470,600,1470,600,570,600,1470,600,570,600,1470,600,570,600,1470,600,1470,600,10510,' +
  '1000,570,600,570,600,1470,600,1470,600,570,600,1470,600,570,600,1470,600,570,600,1470,600,1470,600,10510';

test('tv-ir encodes Xiaomi 20-bit 4-PPM IR frames accurately (matching LX06 ir_play0 byte-for-byte)', () => {
  const power = encodeXiaomiIrFrame(0x3c, 0xcc, 4);
  assert.equal(power.hex20, '0x3CCCF');
  assert.equal(power.checksum, 0xf);
  assert.equal(power.code, LX06_POWER_IR_PLAY0);
  assert.equal(Buffer.byteLength(power.code) + 1, 420);

  const expectedHex = {
    menu: '0x8604A',
    up: '0x8605B',
    down: '0x86068',
    back: '0x86079',
    home: '0x86086',
    left: '0x860B5',
    right: '0x860C2',
    ok: '0x860D3',
    vol_up: '0x860E0',
    vol_down: '0x860F1',
  };
  for (const [key, hex20] of Object.entries(expectedHex)) {
    const resolved = resolveKeySpec(key);
    assert.equal(resolved.hex20, hex20, `hex20 mismatch for ${key}`);
    assert.equal(resolved.source, 'preset');
  }

  assert.equal(resolveKeySpec('向上').key, 'up');
  assert.equal(resolveKeySpec('往下').key, 'down');
  assert.equal(resolveKeySpec('向左').key, 'left');
  assert.equal(resolveKeySpec('右移').key, 'right');
  assert.equal(resolveKeySpec('点击').key, 'ok');
  assert.equal(resolveKeySpec('回车').key, 'ok');
  assert.equal(resolveKeySpec('返回').key, 'back');
  assert.equal(resolveKeySpec('菜单').key, 'menu');
  assert.equal(resolveKeySpec('设置').key, 'menu');
  assert.equal(resolveKeySpec('首页').key, 'home');
  assert.equal(resolveKeySpec('调大音量').key, 'vol_up');
  assert.equal(resolveKeySpec('小声一点').key, 'vol_down');
  assert.equal(resolveKeySpec('开关机').key, 'power');
});

test('tv-ir auto-discovers LX06 speaker SSH target from SQLite im_channels', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-tvir-db-'));
  try {
    const store = new Store(home);
    const now = Date.now();
    store.saveImChannel({
      id: 'xiaoai-lx06',
      platform: 'xiaoai',
      name: '小爱音箱Pro (LX06)',
      enabled: true,
      notifyAll: false,
      allowedSenders: [],
      apiBase: 'ssh://oh2p=root@192.0.2.101,lx06=root@192.0.2.104?prefix=星期五,Friday',
      defaultTarget: 'oh2p',
      inboundCount: 0,
      outboundCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    store.close();

    const discovered = await discoverSpeakerSsh({ homeDir: home, dataDir: join(home, 'plugins', 'tv-ir') });
    assert.equal(discovered.source, 'sqlite');
    assert.equal(discovered.channelId, 'xiaoai-lx06');
    assert.equal(discovered.target.id, 'lx06');
    assert.equal(discovered.target.userHost, 'root@192.0.2.104');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('tv-ir executes status, press, sequence, config, and learn with mock SSH and safe inter-step delays', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-tvir-mock-'));
  const dataDir = join(home, 'plugins', 'tv-ir');
  try {
    const store = new Store(home);
    const now = Date.now();
    store.saveImChannel({
      id: 'xiaoai-lx06',
      platform: 'xiaoai',
      name: 'LX06',
      enabled: true,
      notifyAll: false,
      allowedSenders: [],
      apiBase: 'ssh://lx06=root@192.0.2.104?prefix=星期五',
      defaultTarget: 'lx06',
      inboundCount: 0,
      outboundCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    store.close();

    const commands: Array<{ host?: string; cmd: string }> = [];
    const sleeps: number[] = [];
    let readAttempts = 0;

    const sshRunner = async (target: { userHost: string }, cmd: string) => {
      commands.push({ host: target.userHost, cmd });
      if (cmd.includes('ubus list ir_agent')) {
        return { stdout: 'IR_TX_READY\nIR_RX_READY\n', stderr: '', code: 0 };
      }
      if (cmd.includes('call ir_agent play')) {
        return { stdout: '{"code":0,"info":""}\n', stderr: '', code: 0 };
      }
      if (cmd.includes('call ir_agent learn ')) {
        return { stdout: '{"code":0,"info":""}\n', stderr: '', code: 0 };
      }
      if (cmd.includes('call ir_agent read ')) {
        readAttempts++;
        if (readAttempts < 2) {
          return { stdout: '{"code":-1,"info":"waiting"}\n', stderr: '', code: 0 };
        }
        return {
          stdout: '{"code":0,"info":"1000,570,600,870,600,1470,600,10510"}\n',
          stderr: '',
          code: 0,
        };
      }
      if (cmd.includes('call ir_agent learn_stop')) {
        return { stdout: '{"code":0,"info":""}\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: 'unexpected command', code: 1 };
    };

    const deps = {
      homeDir: home,
      dataDir,
      sshRunner,
      sleep: async (ms: number) => { sleeps.push(ms); },
    };

    // 1. status
    const statusRes = await executeTvIrAction('status', {}, deps);
    assert.equal(statusRes.ok, true);
    assert.equal(statusRes.data.txReady, true);
    assert.equal(statusRes.data.rxReady, true);

    // 2. press with repeat count
    const pressRes = await executeTvIrAction('press', { key: '向下', count: 3, intervalMs: 220 }, deps);
    assert.equal(pressRes.ok, true);
    assert.equal(pressRes.data.key, 'down');
    assert.equal(pressRes.data.count, 3);
    assert.equal(pressRes.data.deliveries.length, 3);
    assert.deepEqual(sleeps, [220, 220]);

    // 3. sequence mixing repeat shorthand and Chinese aliases
    sleeps.length = 0;
    const seqRes = await executeTvIrAction(
      'sequence',
      { keys: ['down*2', '向右', { key: '确认', delayMs: 310 }] },
      deps,
    );
    assert.equal(seqRes.ok, true);
    assert.equal(seqRes.data.stepCount, 4);
    assert.deepEqual(
      seqRes.data.steps.map((s: { key: string }) => s.key),
      ['down', 'down', 'right', 'ok'],
    );
    assert.deepEqual(sleeps, [240, 240, 240]);

    // 4. learn captures code on 2nd poll, saves learned-keys.json, and runs learn_stop
    const learnRes = await executeTvIrAction('learn', { key: 'source', label: '信号源', timeoutMs: 5000, pollIntervalMs: 100 }, deps);
    assert.equal(learnRes.ok, true);
    assert.equal(learnRes.data.key, 'source');
    assert.equal(existsSync(join(dataDir, 'learned-keys.json')), true);
    assert.ok(commands.some(c => c.cmd.includes('call ir_agent learn_stop')));

    // Press learned custom key
    const learnedPress = await executeTvIrAction('press', { key: 'source' }, deps);
    assert.equal(learnedPress.ok, true);
    assert.equal(learnedPress.data.source, 'learned');
    assert.equal(learnedPress.data.code, '1000,570,600,870,600,1470,600,10510');

    // Learn overriding a preset key takes precedence unless usePreset: true
    readAttempts = 0;
    const overrideLearn = await executeTvIrAction('learn', { key: '菜单', timeoutMs: 5000, pollIntervalMs: 100 }, deps);
    assert.equal(overrideLearn.ok, true);
    assert.equal(overrideLearn.data.key, 'menu');
    const learnedMenu = await executeTvIrAction('press', { key: 'menu' }, deps);
    assert.equal(learnedMenu.data.source, 'learned');
    const presetMenu = await executeTvIrAction('press', { key: 'menu', usePreset: true }, deps);
    assert.equal(presetMenu.data.source, 'preset');
    assert.equal(presetMenu.data.hex20, '0x8604A');

    // 5. Timeout still executes learn_stop cleanup
    commands.length = 0;
    const timeoutRunner = async (_target: unknown, cmd: string) => {
      commands.push({ cmd });
      if (cmd.includes('learn_stop') || cmd.includes('learn ')) {
        return { stdout: '{"code":0,"info":""}\n', stderr: '', code: 0 };
      }
      return { stdout: '{"code":-1,"info":"waiting"}\n', stderr: '', code: 0 };
    };
    let fakeNow = 1_000_000;
    const timeoutRes = await executeTvIrAction(
      'learn',
      { key: 'mute', timeoutMs: 2000, pollIntervalMs: 500 },
      { ...deps, sshRunner: timeoutRunner, now: () => fakeNow, sleep: async (ms: number) => { fakeNow += ms; } },
    );
    assert.equal(timeoutRes.ok, false);
    assert.match(timeoutRes.message ?? '', /未检测到/);
    assert.ok(commands.some(c => c.cmd.includes('call ir_agent learn_stop')));

    // Error on non-zero ir_agent play response
    await assert.rejects(
      () => executeTvIrAction('press', { key: 'ok' }, {
        ...deps,
        sshRunner: async () => ({ stdout: '{"code":-1,"info":"driver busy"}\n', stderr: '', code: 0 }),
      }),
      /driver busy/,
    );

    // 6. config updates config.json and overrides discovery
    const cfgRes = await executeTvIrAction('config', { sshTarget: 'custom=root@192.0.2.200:2222', defaultIntervalMs: 280 }, deps);
    assert.equal(cfgRes.ok, true);
    const savedCfg = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'));
    assert.equal(savedCfg.sshTarget, 'custom=root@192.0.2.200:2222');
    assert.equal(savedCfg.defaultIntervalMs, 280);
    const customDiscovery = await discoverSpeakerSsh({ homeDir: home, dataDir });
    assert.equal(customDiscovery.target!.userHost, 'root@192.0.2.200');
    assert.equal(customDiscovery.target!.port, 2222);

    // 7. Sequence validation rejects > 30 steps
    assert.throws(() => parseSequenceSteps('down*15, ok*16'), /30/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('tv-ir plugin is discovered and executable via host runPlugin (dryRun)', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-tvir-host-'));
  try {
    const store = new Store(home);
    const now = Date.now();
    store.saveImChannel({
      id: 'xiaoai-lx06',
      platform: 'xiaoai',
      name: 'LX06',
      enabled: true,
      notifyAll: false,
      allowedSenders: [],
      apiBase: 'ssh://lx06=root@192.0.2.104',
      inboundCount: 0,
      outboundCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    store.close();

    const plugins = await listPlugins(home);
    const tvIr = plugins.find(p => p.name === 'tv-ir');
    assert.ok(tvIr, 'tv-ir plugin should be discovered');
    assert.deepEqual(tvIr.actions, ['status', 'keys', 'press', 'sequence', 'learn', 'config']);

    const keysRes = await runPlugin(home, 'tv-ir', 'keys');
    assert.equal(keysRes.ok, true);
    assert.match(keysRes.message, /菜单/);

    const pressDry = await runPlugin(home, 'tv-ir', 'press', { key: '菜单', dryRun: true });
    assert.equal(pressDry.ok, true);
    assert.equal((pressDry.data as any).key, 'menu');
    assert.equal((pressDry.data as any).hex20, '0x8604A');

    const directKeyDry = await runPlugin(home, 'tv-ir', 'menu', { dryRun: true });
    assert.equal(directKeyDry.ok, true);
    assert.equal((directKeyDry.data as any).key, 'menu');

    const seqDry = await runPlugin(home, 'tv-ir', 'sequence', { keys: ['下*2', '确认'], dryRun: true });
    assert.equal(seqDry.ok, true);
    assert.equal((seqDry.data as any).stepCount, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('tv-remote deterministic voice parsers handle entry, directions, counts, combos, homophones, learned keys, exit, and noise', () => {
  // 1. Entry detection (including 操控/操纵/操作/控制 phrasings)
  assert.deepEqual(parseTvRemoteEntryUtterance('遥控电视模式').matched, true);
  assert.deepEqual(parseTvRemoteEntryUtterance('电视操纵模式').matched, true);
  assert.deepEqual(parseTvRemoteEntryUtterance('进入电视操控模式').matched, true);
  assert.deepEqual(parseTvRemoteEntryUtterance('进入遥控电视模式').initialSteps, []);
  assert.equal(parseTvRemoteEntryUtterance('打开电视遥控模式').matched, true);

  const entryWithStep = parseTvRemoteEntryUtterance('进入遥控电视模式，先按一下菜单');
  assert.equal(entryWithStep.matched, true);
  assert.deepEqual(entryWithStep.initialSteps.map(s => s.key), ['menu']);

  const entryWithCombo = parseTvRemoteEntryUtterance('遥控电视，往下两下再确认');
  assert.equal(entryWithCombo.matched, true);
  assert.deepEqual(entryWithCombo.initialSteps.map(s => s.key), ['down', 'down', 'ok']);

  // Single-shot or questions must NOT enter continuous remote mode
  assert.equal(parseTvRemoteEntryUtterance('呃，电视往下按一个。').matched, false);
  assert.equal(parseTvRemoteEntryUtterance('遥控电视是什么功能？').matched, false);
  assert.equal(parseTvRemoteEntryUtterance('打开电视').matched, false);

  // 2. In-mode fixed keys & repeat counts
  const singleCases: Array<[string, string[]]> = [
    ['上', ['up']],
    ['往上', ['up']],
    ['网上', ['up']],
    ['往下', ['down']],
    ['向下。', ['down']],
    ['向左', ['left']],
    ['往右', ['right']],
    ['确认', ['ok']],
    ['点一下', ['ok']],
    ['点击', ['ok']],
    ['回车', ['ok']],
    ['暂停', ['ok']],
    ['返回', ['back']],
    ['上一页', ['back']],
    ['菜单', ['menu']],
    ['设置', ['menu']],
    ['主页', ['home']],
    ['回首页', ['home']],
    ['大声一点', ['vol_up']],
    ['音量加3格', ['vol_up', 'vol_up', 'vol_up']],
    ['小声一点', ['vol_down']],
    ['关电视', ['power']],
    ['往下三下', ['down', 'down', 'down']],
    ['往右2格', ['right', 'right']],
    ['下下下', ['down', 'down', 'down']],
    ['往下按一个', ['down']],
    ['按两下左', ['left', 'left']],
    ['往下两下再确认', ['down', 'down', 'ok']],
    ['返回然后主页', ['back', 'home']],
  ];
  for (const [phrase, expectedKeys] of singleCases) {
    const res = parseTvRemoteInModeUtterance(phrase);
    assert.equal(res.kind, 'press', `Expected "press" for "${phrase}", got ${res.kind}`);
    assert.deepEqual(res.steps.map(s => s.key), expectedKeys, `Key mismatch for "${phrase}"`);
  }

  // 3. Learned custom keys work inside remote mode
  const learnedRes = parseTvRemoteInModeUtterance('按一下信号源', {
    source: { key: 'source', label: '信号源', code: '1000,570,600,10510' },
  });
  assert.equal(learnedRes.kind, 'press');
  assert.deepEqual(learnedRes.steps.map(s => s.key), ['source']);

  // 3b. Real SenseVoice homophones & concatenated multi-commands from 13:28 live LX06 session
  const inModeRegressionCases: Array<[string, string[]]> = [
    ['网友网友。', ['right', 'right']],
    ['晚上。', ['up']],
    ['慢有。', ['right']],
    ['网友。', ['right']],
    ['呃，往右往上。', ['right', 'up']],
    ['放一。', ['back']],
    ['打开彩蛋', ['menu']],
    ['往右两下确认', ['right', 'right', 'ok']],
    ['返回主页', ['home']],
    ['马上。', ['up']],
    ['打上。', ['up']],
    ['哪下啊。', ['down']],
  ];
  for (const [phrase, expectedKeys] of inModeRegressionCases) {
    const res = parseTvRemoteInModeUtterance(phrase);
    assert.equal(res.kind, 'press', `Expected "press" for "${phrase}", got ${res.kind}`);
    assert.deepEqual(res.steps.map(s => s.key), expectedKeys, `Key mismatch for "${phrase}"`);
  }
  assert.equal(
    isAssistantTvRemoteActivation('好，电视已经能直接控制，刚才往下按了一个，红外码发送成功。要试别的键就说。[[END]]'),
    true,
  );
  assert.equal(
    isAssistantTvRemoteActivation('老板，电视遥控我已经切到支持模式了。你说“方向”或“确认”，我听你的。'),
    true,
  );
  assert.equal(isAssistantTvRemoteActivation('已退出电视遥控模式。'), false);
  assert.equal(isAssistantTvRemoteActivation('已往下按了一下。 [[END]]'), false);

  // 4. Exit vs unrecognized background speech
  for (const exitPhrase of ['退出', '退出遥控', '退出遥控模式', '退出电视操纵模式', '退出操控模式', '好了', '不用了', '退一下吧。', '停', '不控了', '不要了']) {
    assert.equal(parseTvRemoteInModeUtterance(exitPhrase).kind, 'exit', `Expected exit for "${exitPhrase}"`);
  }
  for (const noise of ['今天天气不错', '这不是我写的字。', '今天晚上吃什么', '网友们好']) {
    assert.equal(parseTvRemoteInModeUtterance(noise).kind, 'unrecognized', `Expected unrecognized for "${noise}"`);
  }
});

test('tv-ir handleVoiceFastpath manages continuous remote mode, noise filtering, assistant_reply activation, and explicitWake yield', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tv-ir-fp-'));
  const sentCmds: string[] = [];
  const ctx: Record<string, unknown> = {
    homeDir,
    pluginDataDir: join(homeDir, 'plugins', 'tv-ir'),
    sshTarget: 'speaker=root@192.0.2.104',
    sleep: async () => {},
    sshRunner: async (_target: unknown, cmd: string) => {
      sentCmds.push(cmd);
      return { code: 0, stdout: '{}', stderr: '' };
    },
  };

  try {
    const enter = await handleVoiceFastpath({ text: '遥控电视模式' }, ctx);
    assert.equal(enter.handled, true);
    assert.equal(enter.followUp, true);
    assert.equal(enter.sessionState?.tvRemoteActive, true);

    const enterWithStep = await handleVoiceFastpath({ text: '星期五，进入遥控电视模式，先按一下菜单' }, ctx);
    assert.equal(enterWithStep.handled, true);
    assert.equal(enterWithStep.followUp, true);
    assert.equal(sentCmds.length, 1);

    const stepRes = await handleVoiceFastpath({
      text: '向左两下再确认',
      sessionState: { tvRemoteActive: true },
    }, ctx);
    assert.equal(stepRes.handled, true);
    assert.equal(stepRes.followUp, true);
    // Continuous mode must use zero-TTS passthrough (speech === '')
    assert.equal(stepRes.speech, '');
    assert.equal((stepRes.data as Record<string, unknown>)?.suppressSpeech, true);
    assert.equal((stepRes.data as Record<string, unknown>)?.recordTurn, false);
    assert.equal(sentCmds.length, 4);
    assert.equal((stepRes.data as Record<string, unknown>)?.extendTtl, true);

    // Verify leading '下' is never swallowed and '右，下，确认' / '下两下' work accurately
    const downRes = await handleVoiceFastpath({
      text: '下',
      sessionState: { tvRemoteActive: true },
    }, ctx);
    assert.equal(downRes.handled, true);
    assert.equal(downRes.speech, '');
    assert.equal(sentCmds.length, 5);

    const comboDown = await handleVoiceFastpath({
      text: '右，下，确认',
      sessionState: { tvRemoteActive: true },
    }, ctx);
    assert.equal(comboDown.handled, true);
    assert.deepEqual(
      ((comboDown.data as Record<string, unknown>)?.steps as Array<{ key: string }>).map(s => s.key),
      ['right', 'down', 'ok'],
    );
    assert.equal(sentCmds.length, 8);

    // Learned custom keys from learned-keys.json are recognized in fastpath
    await mkdir(join(homeDir, 'plugins', 'tv-ir'), { recursive: true });
    await writeFile(
      join(homeDir, 'plugins', 'tv-ir', 'learned-keys.json'),
      JSON.stringify({ source: { key: 'source', label: '信号源', code: '1000,570,600,10510', freq: 38000, frames: 1 } }),
      { mode: 0o600 },
    );
    const learnedStep = await handleVoiceFastpath({
      text: '切换信号源',
      sessionState: { tvRemoteActive: true },
    }, ctx);
    assert.equal(learnedStep.handled, true);
    assert.equal(learnedStep.speech, '');
    assert.equal(sentCmds.length, 9);

    // Unlearned mute without tv-agent does not throw and preserves continuous session
    const unlearnedMute = await handleVoiceFastpath({
      text: '静音',
      sessionState: { tvRemoteActive: true },
    }, ctx);
    assert.equal(unlearnedMute.handled, true);
    assert.equal(unlearnedMute.ok, false);
    assert.equal(unlearnedMute.followUp, true);

    const noiseRes = await handleVoiceFastpath({
      text: '今天晚饭吃什么',
      sessionState: { tvRemoteActive: true },
    }, ctx);
    assert.equal(noiseRes.handled, true);
    assert.equal(noiseRes.action, 'voice_fastpath_ignored');
    assert.equal(noiseRes.speech, '');
    assert.equal((noiseRes.data as Record<string, unknown>)?.extendTtl, false);
    assert.equal((noiseRes.data as Record<string, unknown>)?.recordTurn, false);
    assert.equal(sentCmds.length, 9);

    const wakeRes = await handleVoiceFastpath({
      text: '小爱同学打开台灯',
      explicitWake: true,
      sessionState: { tvRemoteActive: true },
    }, ctx);
    assert.equal(wakeRes.handled, false);

    // Both "退出遥控" and docs exit word "好了" must exit cleanly
    for (const exitWord of ['退出遥控', '好了']) {
      const exitRes = await handleVoiceFastpath({
        text: exitWord,
        sessionState: { tvRemoteActive: true },
      }, ctx);
      assert.equal(exitRes.handled, true);
      assert.equal(exitRes.clearSessionState, true);
      assert.equal(exitRes.followUp, false);
      assert.equal(exitRes.sessionState, null);
    }

    // Verify production parser functions directly on edge cases
    assert.deepEqual(
      parseTvRemoteStepsPhrase('下两下')?.steps,
      [{ key: 'down', label: '下', count: 2 }],
    );
    assert.deepEqual(
      parseTvRemoteStepsPhrase('按电视下键')?.steps,
      [{ key: 'down', label: '下', count: 1 }],
    );
    assert.equal(parseTvRemoteEntryPhrase('遥控电视模式').matched, true);
    assert.equal(parseTvRemoteEntryPhrase('电视操纵模式。').matched, true);
    assert.equal(parseTvRemoteEntryPhrase('进入电视操控模式').matched, true);
    assert.equal(isPluginTvRemoteActivation('好，电视已经能直接控制，要试别的键就说。[[END]]'), true);
    assert.equal(isPluginTvRemoteActivation('老板，电视遥控我已经切到支持模式了。你说“方向”或“确认”，我听你的。'), true);
    assert.equal(isPluginTvRemoteActivation('已退出电视遥控模式。'), false);

    const manipExit = await handleVoiceFastpath({
      text: '退出电视操纵模式',
      sessionState: { tvRemoteActive: true },
    }, ctx);
    assert.equal(manipExit.handled, true);
    assert.equal(manipExit.clearSessionState, true);
    assert.equal(manipExit.speech, '已退出电视遥控模式。');

    const replyRes = await handleVoiceFastpath({
      text: '',
      sessionState: { event: 'assistant_reply', assistantReply: '已进入电视遥控模式，请直接说按键指令。' },
    }, ctx);
    assert.equal(replyRes.handled, true);
    assert.equal(replyRes.followUp, true);
    assert.equal(replyRes.sessionState?.tvRemoteActive, true);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test('tv-ir handleVoiceFastpath resolves TV power conflict: prefers tv-agent when available and falls back to IR without peeking ../tv-agent/config.json', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'tv-ir-power-'));
  try {
    const irCalls: string[] = [];
    const agentCalls: Array<{ plugin: string; action: string; args: Record<string, unknown> }> = [];

    const resPreferAgent = await handleVoiceFastpath({ text: '星期五，打开电视' }, {
      homeDir,
      pluginDataDir: join(homeDir, 'plugins', 'tv-ir'),
      sshTarget: 'speaker=root@192.0.2.104',
      sleep: async () => {},
      sshRunner: async (_t: unknown, cmd: string) => {
        irCalls.push(cmd);
        return { code: 0, stdout: '{}', stderr: '' };
      },
      callPlugin: async (plugin: string, action: string, args: Record<string, unknown>) => {
        agentCalls.push({ plugin, action, args });
        return { ok: true, message: '电视已唤醒', data: { irSent: false } };
      },
    });
    assert.equal(resPreferAgent.handled, true);
    assert.equal(agentCalls.length, 1);
    assert.deepEqual(agentCalls[0], { plugin: 'tv-agent', action: 'power', args: { state: 'on' } });
    assert.equal(irCalls.length, 0);
    assert.equal((resPreferAgent.data as Record<string, unknown>)?.backend, 'tv-agent');

    // Fallback to IR when tv-agent call throws
    const resFallbackErr = await handleVoiceFastpath({ text: '关电视' }, {
      homeDir,
      pluginDataDir: join(homeDir, 'plugins', 'tv-ir'),
      sshTarget: 'speaker=root@192.0.2.104',
      sleep: async () => {},
      sshRunner: async (_t: unknown, cmd: string) => {
        irCalls.push(cmd);
        return { code: 0, stdout: '{}', stderr: '' };
      },
      callPlugin: async () => {
        throw new Error('tv-agent unreachable');
      },
    });
    assert.equal(resFallbackErr.handled, true);
    assert.equal(irCalls.length, 1);
    assert.equal((resFallbackErr.data as Record<string, unknown>)?.backend, 'tv-ir');

    // Fallback cleanly to IR when tv-agent returns ok=false (e.g. unconfigured) or callPlugin is absent
    const resUnconfigured = await handleVoiceFastpath({ text: '打开电视' }, {
      homeDir,
      pluginDataDir: join(homeDir, 'plugins', 'tv-ir'),
      sshTarget: 'speaker=root@192.0.2.104',
      sleep: async () => {},
      sshRunner: async (_t: unknown, cmd: string) => {
        irCalls.push(cmd);
        return { code: 0, stdout: '{}', stderr: '' };
      },
      callPlugin: async () => ({ ok: false, message: '未配置 tvHost' }),
    });
    assert.equal(resUnconfigured.handled, true);
    assert.equal(irCalls.length, 2);
    assert.equal((resUnconfigured.data as Record<string, unknown>)?.backend, 'tv-ir');

    const resNoCallPlugin = await handleVoiceFastpath({ text: '打开电视' }, {
      homeDir,
      pluginDataDir: join(homeDir, 'plugins', 'tv-ir'),
      sshTarget: 'speaker=root@192.0.2.104',
      sleep: async () => {},
      sshRunner: async (_t: unknown, cmd: string) => {
        irCalls.push(cmd);
        return { code: 0, stdout: '{}', stderr: '' };
      },
    });
    assert.equal(resNoCallPlugin.handled, true);
    assert.equal(irCalls.length, 3);
    assert.equal((resNoCallPlugin.data as Record<string, unknown>)?.backend, 'tv-ir');
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

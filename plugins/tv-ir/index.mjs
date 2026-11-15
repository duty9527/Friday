import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  clampInt as sharedClampInt,
  errMsg,
  readConfig,
  readJsonSafe,
  resolvePluginPaths,
  writeJsonAtomic,
} from '../_shared/config-store.mjs';
import {
  discoverOptionalXiaoaiSshFromSqlite,
  execSshText,
  parseSshTargets,
  shellQuote,
} from '../_shared/ssh.mjs';
import { handleTvIrVoiceFastpath } from './voice-fastpath.mjs';

const DEFAULT_FREQ_HZ = 38_000;
const DEFAULT_INTERVAL_MS = 240;
const DEFAULT_LEARN_TIMEOUT_MS = 12_000;
const LEARN_POLL_INTERVAL_MS = 400;
const MAX_PRESS_COUNT = 20;
const MAX_SEQUENCE_STEPS = 30;
const VALID_LEARN_KEY_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5+-]{1,32}$/;

/**
 * Standard Xiaomi / Redmi TV 20-bit 4-PPM IR key map (Device 0x86, Power 0x3C).
 * @type {Record<string, { device: number; func: number; frames: number; label: string; aliases: string[] }>}
 */
export const PRESET_KEYS = {
  power: {
    device: 0x3c,
    func: 0xcc,
    frames: 4,
    label: '电源',
    aliases: ['电源', '开关', '开关机', '开机', '关机', '待机', 'power', 'tv_power'],
  },
  power_alt: {
    device: 0x86,
    func: 0x03,
    frames: 4,
    label: '备用电源',
    aliases: ['备用电源', '电源2', 'power_alt', 'power2'],
  },
  menu: {
    device: 0x86,
    func: 0x04,
    frames: 2,
    label: '菜单',
    aliases: ['菜单', '设置', '选项', '更多', 'menu', 'settings', 'options'],
  },
  up: {
    device: 0x86,
    func: 0x05,
    frames: 2,
    label: '上',
    aliases: ['上', '向上', '往上', '上移', '方向上', 'up'],
  },
  down: {
    device: 0x86,
    func: 0x06,
    frames: 2,
    label: '下',
    aliases: ['下', '向下', '往下', '下移', '方向下', 'down'],
  },
  back: {
    device: 0x86,
    func: 0x07,
    frames: 2,
    label: '返回',
    aliases: ['返回', '后退', '上一页', '上一步', '回退', '取消', 'back', 'return', 'esc'],
  },
  home: {
    device: 0x86,
    func: 0x08,
    frames: 2,
    label: '主页',
    aliases: ['主页', '首页', '桌面', '主界面', 'home'],
  },
  left: {
    device: 0x86,
    func: 0x0b,
    frames: 2,
    label: '左',
    aliases: ['左', '向左', '往左', '左移', '方向左', '快退', 'left'],
  },
  right: {
    device: 0x86,
    func: 0x0c,
    frames: 2,
    label: '右',
    aliases: ['右', '向右', '往右', '右移', '方向右', '快进', 'right'],
  },
  ok: {
    device: 0x86,
    func: 0x0d,
    frames: 2,
    label: '确认',
    aliases: ['确认', '确定', '点击', '回车', '选择', '点一下', '暂停', '播放', '播放暂停', 'ok', 'enter', 'select', 'click', 'confirm'],
  },
  vol_up: {
    device: 0x86,
    func: 0x0e,
    frames: 2,
    label: '音量+',
    aliases: ['音量+', '音量加', '声音+', '声音加', '调大音量', '音量大一点', '声音大一点', '大声一点', '大声点', 'vol_up', 'vol+', 'volume_up', 'volume+'],
  },
  vol_down: {
    device: 0x86,
    func: 0x0f,
    frames: 2,
    label: '音量-',
    aliases: ['音量-', '音量减', '声音-', '声音减', '调小音量', '音量小一点', '声音小一点', '小声一点', '小声点', 'vol_down', 'vol-', 'volume_down', 'volume-'],
  },
};

const PRESET_ALIAS_MAP = new Map();
for (const [canonical, spec] of Object.entries(PRESET_KEYS)) {
  const candidates = [canonical, spec.label, ...spec.aliases];
  for (const alias of candidates) {
    const lower = alias.trim().toLowerCase();
    PRESET_ALIAS_MAP.set(lower, canonical);
    PRESET_ALIAS_MAP.set(lower.replace(/\s+/g, ''), canonical);
  }
}

/**
 * Encode a Xiaomi 20-bit 4-PPM IR frame sequence into microsecond pulse durations.
 */
export function encodeXiaomiIrFrame(deviceByte, funcByte, frames = 2) {
  const d = Number(deviceByte) & 0xff;
  const f = Number(funcByte) & 0xff;
  const repeat = Math.max(1, Math.min(16, Math.round(Number(frames) || 1)));
  const checksum = ((d >> 4) & 0xf) ^ (d & 0xf) ^ ((f >> 4) & 0xf) ^ (f & 0xf);
  const value20 = (d << 12) | (f << 4) | (checksum & 0xf);
  const hex20 = `0x${value20.toString(16).toUpperCase().padStart(5, '0')}`;

  const singleFrame = [1000, 570];
  for (let shift = 18; shift >= 0; shift -= 2) {
    const sym = (value20 >> shift) & 0x3;
    singleFrame.push(600, 570 + sym * 300);
  }
  singleFrame.push(600, 10510);

  const pulses = [];
  for (let i = 0; i < repeat; i++) {
    pulses.push(...singleFrame);
  }
  return {
    code: pulses.join(','),
    hex20,
    checksum,
    frames: repeat,
  };
}

function escapeShellSingleQuote(value) {
  return shellQuote(value).slice(1, -1);
}

function clampInt(value, fallback, min, max) {
  return sharedClampInt(value, min, max) ?? fallback;
}

function writeJsonPrivate(filePath, payload) {
  writeJsonAtomic(filePath, payload, { mode: 0o600 });
}

function getRuntimePaths(deps = {}) {
  return resolvePluginPaths('tv-ir', deps, {
    learnedPath: 'learned-keys.json',
  });
}

function loadConfig(configPath) {
  return readConfig(configPath, {});
}

function loadLearnedKeys(learnedPath) {
  const raw = readJsonSafe(learnedPath, {});
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (v && typeof v === 'object' && typeof v.code === 'string' && v.code.trim()) {
      out[k] = v;
    }
  }
  return out;
}

function findLearnedEntry(learnedKeys, candidates) {
  const lowerIndex = new Map();
  for (const [k, v] of Object.entries(learnedKeys || {})) {
    lowerIndex.set(k.trim().toLowerCase(), { name: k, entry: v });
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    const direct = learnedKeys?.[candidate];
    if (direct && typeof direct.code === 'string' && direct.code.trim()) {
      return { name: candidate, entry: direct };
    }
    const ci = lowerIndex.get(String(candidate).trim().toLowerCase());
    if (ci && typeof ci.entry.code === 'string' && ci.entry.code.trim()) {
      return ci;
    }
  }
  return undefined;
}

/**
 * Resolve a key name or Chinese/English alias against learned overrides and built-in presets.
 */
export function resolveKeySpec(rawKey, learnedKeys = {}, options = {}) {
  if (typeof rawKey !== 'string' || !rawKey.trim()) {
    throw new Error('请提供电视遥控按键名称（如 up、down、left、right、ok、back、menu、home、vol_up、vol_down、power）');
  }
  const trimmed = rawKey.trim();
  const lower = trimmed.toLowerCase();
  const compact = lower.replace(/\s+/g, '');
  const canonical = PRESET_ALIAS_MAP.get(lower) ?? PRESET_ALIAS_MAP.get(compact);

  if (options?.usePreset !== true) {
    const learnedMatch = findLearnedEntry(
      learnedKeys,
      canonical ? [canonical, trimmed] : [trimmed],
    );
    if (learnedMatch) {
      const entry = learnedMatch.entry;
      const preset = canonical ? PRESET_KEYS[canonical] : undefined;
      return {
        key: canonical ?? learnedMatch.name,
        label: typeof entry.label === 'string' && entry.label.trim()
          ? entry.label.trim()
          : (preset?.label ?? learnedMatch.name),
        source: 'learned',
        code: entry.code.trim(),
        freq: clampInt(options.freq ?? entry.freq, DEFAULT_FREQ_HZ, 20_000, 60_000),
        frames: clampInt(options.frames ?? entry.frames, 1, 1, 8),
      };
    }
  }

  if (canonical) {
    const preset = PRESET_KEYS[canonical];
    const frames = clampInt(options.frames ?? options.defaultFrames, preset.frames, 1, 8);
    const encoded = encodeXiaomiIrFrame(preset.device, preset.func, frames);
    return {
      key: canonical,
      label: preset.label,
      source: 'preset',
      code: encoded.code,
      hex20: encoded.hex20,
      freq: clampInt(options.freq, DEFAULT_FREQ_HZ, 20_000, 60_000),
      frames: encoded.frames,
    };
  }

  const supported = Object.entries(PRESET_KEYS).map(([k, v]) => `${k}(${v.label})`).join('、');
  throw new Error(`未识别的电视按键 "${trimmed}"。支持预设按键：${supported}；也可用 learn 动作学习新按键。`);
}

function parseStepToken(token) {
  const trimmed = String(token).trim();
  if (!trimmed) return [];
  const repeatMatch = /^(.+?)\s*[*×]\s*(\d+)$/.exec(trimmed);
  if (repeatMatch) {
    const key = repeatMatch[1].trim();
    const count = clampInt(repeatMatch[2], 1, 1, MAX_PRESS_COUNT);
    return Array.from({ length: count }, () => ({ key }));
  }
  return [{ key: trimmed }];
}

/**
 * Parse a sequence specification (array or delimited string) into expanded press steps.
 */
export function parseSequenceSteps(rawKeys) {
  const steps = [];
  const pushSteps = items => {
    for (const item of items) {
      steps.push(item);
      if (steps.length > MAX_SEQUENCE_STEPS) {
        throw new Error(`组合按键序列步数不能超过 ${MAX_SEQUENCE_STEPS} 步`);
      }
    }
  };

  if (typeof rawKeys === 'string') {
    const trimmed = rawKeys.trim();
    if (!trimmed) throw new Error('组合按键序列不能为空');
    const hasExplicitDelimiter = /[,，;；、>→\n]/.test(trimmed);
    if (!hasExplicitDelimiter && (PRESET_ALIAS_MAP.has(trimmed.toLowerCase()) || /^.+?\s*[*×]\s*\d+$/.test(trimmed))) {
      pushSteps(parseStepToken(trimmed));
    } else {
      const parts = hasExplicitDelimiter
        ? trimmed.split(/[,，;；、>→\n]+/)
        : trimmed.split(/\s+/);
      for (const part of parts) {
        pushSteps(parseStepToken(part));
      }
    }
  } else if (Array.isArray(rawKeys)) {
    for (const item of rawKeys) {
      if (typeof item === 'string') {
        pushSteps(parseStepToken(item));
      } else if (item && typeof item === 'object' && !Array.isArray(item)) {
        const key = typeof item.key === 'string' ? item.key.trim() : '';
        if (!key) throw new Error('组合按键对象元素缺少有效的 key 字段');
        const count = clampInt(item.count, 1, 1, MAX_PRESS_COUNT);
        const delayMs = item.delayMs === undefined ? undefined : clampInt(item.delayMs, DEFAULT_INTERVAL_MS, 50, 5000);
        const frames = item.frames === undefined ? undefined : clampInt(item.frames, 2, 1, 8);
        const usePreset = typeof item.usePreset === 'boolean' ? item.usePreset : undefined;
        for (let i = 0; i < count; i++) {
          pushSteps([{ key, delayMs, frames, usePreset }]);
        }
      } else {
        throw new Error('组合按键序列元素必须为按键字符串或 {key, count?, delayMs?} 对象');
      }
    }
  } else {
    throw new Error('请通过 keys 参数提供组合按键序列（如 ["down","down","ok"] 或 "下,下,确认"）');
  }

  if (steps.length === 0) {
    throw new Error('组合按键序列不能为空');
  }
  return steps;
}

/**
 * Parse `ssh://id=user@host:port,...?query` entries compatible with src/xiaoai.ts.
 */
export function parseXiaoaiSshTargets(apiBase) {
  return parseSshTargets(apiBase, 'default');
}

/**
 * Discover the target speaker SSH connection from explicit override, config.json, or optional state.sqlite.
 */
export async function discoverSpeakerSsh({ sshTarget, pluginDataDir, dataDir, homeDir } = {}) {
  const paths = getRuntimePaths({ pluginDataDir, dataDir, homeDir });
  const config = loadConfig(paths.configPath);
  const candidateSpec = typeof sshTarget === 'string' && sshTarget.trim()
    ? sshTarget.trim()
    : typeof config.sshTarget === 'string' && config.sshTarget.trim()
      ? config.sshTarget.trim()
      : '';

  if (candidateSpec && (candidateSpec.includes('@') || candidateSpec.startsWith('ssh://'))) {
    const parsed = parseXiaoaiSshTargets(candidateSpec);
    if (parsed.length > 0) {
      return {
        target: parsed[0],
        source: sshTarget ? 'args' : 'config',
      };
    }
  }

  const preferredId = candidateSpec || 'lx06';
  const discovered = discoverOptionalXiaoaiSshFromSqlite({ homeDir: paths.homeDir }, preferredId);
  if (discovered) {
    return {
      target: discovered.target,
      source: 'sqlite',
      channelId: discovered.channelId,
    };
  }

  throw new Error(
    `未找到小爱音箱 SSH 目标（home=${paths.homeDir}）。请先绑定 xiaoai SSH 通道，或调用 config 动作设置 sshTarget（如 "speaker=root@192.0.2.10"）。`,
  );
}

export async function defaultSshRunner(target, remoteCommand, timeoutMs = 8_000, options = {}) {
  return execSshText(target, remoteCommand, {
    timeoutMs,
    homeDir: options.homeDir,
    signal: options.signal,
    controlPersistSec: 60,
    allowLegacyRsa: true,
    useControlMaster: options.useControlMaster ?? Boolean(options.homeDir),
  });
}

function parseUbusJson(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = /\{[\s\S]*\}/.exec(trimmed);
    if (!match) return undefined;
    try {
      return JSON.parse(match[0]);
    } catch {
      return undefined;
    }
  }
}

function buildPlayCommand(code, freq) {
  const payload = JSON.stringify({ freq, code });
  return `ubus -t 3 call ir_agent play '${escapeShellSingleQuote(payload)}'`;
}

function buildLearnStartCommand(key) {
  const payload = JSON.stringify({ key });
  return `ubus -t 3 call ir_agent learn '${escapeShellSingleQuote(payload)}'`;
}

function buildLearnReadCommand(key) {
  const payload = JSON.stringify({ key });
  return `ubus -t 3 call ir_agent read '${escapeShellSingleQuote(payload)}'`;
}

function buildLearnStopCommand(key) {
  const payload = JSON.stringify({ key });
  return `ubus -t 3 call ir_agent learn_stop '${escapeShellSingleQuote(payload)}'`;
}

function computeStepDelayMs(intervalMs, frames) {
  // Single worker thread in mico_ir_agent can drop or overwrite buffered IR if called back-to-back too fast.
  return Math.max(140, intervalMs, frames * 30 + 140);
}

async function emitIrOnce(sshRunner, target, spec, dryRun) {
  const command = buildPlayCommand(spec.code, spec.freq);
  if (dryRun) {
    return { command, ubus: { code: 0, info: 'dryRun' } };
  }
  const res = await sshRunner(target, command, 8_000);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || res.stdout.trim() || `红外发射 SSH 执行失败 (exit=${res.code})`);
  }
  const parsed = parseUbusJson(res.stdout);
  if (parsed && typeof parsed.code === 'number' && parsed.code !== 0) {
    throw new Error(`ir_agent play 返回失败 (code=${parsed.code}, info=${String(parsed.info ?? '')})`);
  }
  return { command, ubus: parsed ?? { raw: res.stdout.trim() } };
}

function formatKeySummary(learnedKeys) {
  const presets = Object.entries(PRESET_KEYS).map(([key, spec]) => {
    const encoded = encodeXiaomiIrFrame(spec.device, spec.func, spec.frames);
    return {
      key,
      label: spec.label,
      hex20: encoded.hex20,
      defaultFrames: spec.frames,
      aliases: spec.aliases,
      overriddenByLearned: Boolean(learnedKeys[key]),
    };
  });
  const learned = Object.entries(learnedKeys).map(([key, entry]) => ({
    key,
    label: entry.label || key,
    freq: entry.freq ?? DEFAULT_FREQ_HZ,
    frames: entry.frames ?? 1,
    pulseCount: entry.code.split(',').filter(Boolean).length,
    learnedAt: entry.learnedAt,
  }));
  return { presets, learned };
}

async function handleStatus(args, deps, paths, sshRunner) {
  const learnedKeys = loadLearnedKeys(paths.learnedPath);
  const config = loadConfig(paths.configPath);
  const discovery = await discoverSpeakerSsh({
    sshTarget: args.sshTarget,
    dataDir: paths.dataDir,
    homeDir: paths.homeDir,
  });

  if (args.dryRun === true) {
    return {
      ok: true,
      notify: true,
      title: '电视红外状态 (预演)',
      message: `📺 已解析音箱 ${discovery.target.id} (${discovery.target.userHost})，预演模式未连接硬件。`,
      data: {
        dryRun: true,
        target: discovery.target,
        discoverySource: discovery.source,
        channelId: discovery.channelId,
        config,
        ...formatKeySummary(learnedKeys),
      },
    };
  }

  const probeCmd =
    'ubus list ir_agent >/dev/null 2>&1 && [ -e /sys/ir_tx_gpio/ir_data ] && echo IR_TX_READY; [ -e /sys/ir_rx_power/rx_power ] && echo IR_RX_READY || true';
  const res = await sshRunner(discovery.target, probeCmd, 8_000);
  const txReady = res.code === 0 && res.stdout.includes('IR_TX_READY');
  const rxReady = res.code === 0 && res.stdout.includes('IR_RX_READY');

  if (!txReady) {
    return {
      ok: false,
      notify: true,
      title: '电视红外状态异常',
      message: `⚠️ 音箱 ${discovery.target.id} (${discovery.target.userHost}) 红外发射服务未就绪：${res.stderr.trim() || res.stdout.trim() || `exit=${res.code}`}`,
      data: {
        txReady,
        rxReady,
        target: discovery.target,
        discoverySource: discovery.source,
      },
    };
  }

  const learnedCount = Object.keys(learnedKeys).length;
  return {
    ok: true,
    notify: true,
    title: '电视红外遥控就绪',
    message: `📺 红米/小米电视红外遥控已就绪：音箱 ${discovery.target.id} (${discovery.target.userHost}) · 发射 ${txReady ? '正常' : '异常'} · 学习接收 ${rxReady ? '正常' : '不可用'} · 预设 ${Object.keys(PRESET_KEYS).length} 键 / 已学习 ${learnedCount} 键。`,
    data: {
      txReady,
      rxReady,
      target: discovery.target,
      discoverySource: discovery.source,
      channelId: discovery.channelId,
      config,
      ...formatKeySummary(learnedKeys),
    },
  };
}

function handleKeys(paths) {
  const learnedKeys = loadLearnedKeys(paths.learnedPath);
  const summary = formatKeySummary(learnedKeys);
  const presetDesc = summary.presets.map(p => `${p.key}(${p.label})`).join('、');
  const learnedDesc = summary.learned.length
    ? summary.learned.map(l => `${l.key}(${l.label})`).join('、')
    : '无';
  return {
    ok: true,
    notify: true,
    title: '红米/小米电视红外按键列表',
    message: `📺 支持预设按键：${presetDesc}。已学习按键：${learnedDesc}。`,
    data: summary,
  };
}

function handleConfig(args, paths) {
  const current = loadConfig(paths.configPath);
  const next = { ...current };
  let updated = false;

  if (args.sshTarget !== undefined) {
    const val = String(args.sshTarget).trim();
    if (!val) {
      delete next.sshTarget;
    } else {
      next.sshTarget = val;
    }
    updated = true;
  }
  if (args.defaultIntervalMs !== undefined) {
    next.defaultIntervalMs = clampInt(args.defaultIntervalMs, DEFAULT_INTERVAL_MS, 50, 5000);
    updated = true;
  }
  if (args.defaultFrames !== undefined) {
    next.defaultFrames = clampInt(args.defaultFrames, 2, 1, 8);
    updated = true;
  }

  if (updated) {
    writeJsonPrivate(paths.configPath, next);
  }
  return {
    ok: true,
    notify: true,
    title: updated ? '电视红外配置已更新' : '电视红外当前配置',
    message: updated
      ? `✅ 已保存配置：sshTarget=${next.sshTarget ?? '(自动发现)'}, defaultIntervalMs=${next.defaultIntervalMs ?? DEFAULT_INTERVAL_MS}, defaultFrames=${next.defaultFrames ?? '(按按键默认)'}`
      : `⚙️ 当前配置：sshTarget=${next.sshTarget ?? '(自动发现)'}, defaultIntervalMs=${next.defaultIntervalMs ?? DEFAULT_INTERVAL_MS}, defaultFrames=${next.defaultFrames ?? '(按按键默认)'}`,
    data: { configPath: paths.configPath, config: next, updated },
  };
}

async function handlePress(args, deps, paths, sshRunner, sleepFn) {
  const config = loadConfig(paths.configPath);
  const learnedKeys = loadLearnedKeys(paths.learnedPath);
  const dryRun = args.dryRun === true;
  const count = clampInt(args.count, 1, 1, MAX_PRESS_COUNT);
  const intervalMs = clampInt(args.intervalMs ?? config.defaultIntervalMs, DEFAULT_INTERVAL_MS, 50, 5000);

  let spec;
  if (typeof args.rawCode === 'string' && args.rawCode.trim()) {
    const cleanCode = args.rawCode.trim();
    if (!/^\d+(,\d+)+$/.test(cleanCode)) {
      throw new Error('rawCode 必须为逗号分隔的正整数微秒脉冲串（如 "1000,570,..."）');
    }
    spec = {
      key: typeof args.key === 'string' && args.key.trim() ? args.key.trim() : 'raw',
      label: typeof args.key === 'string' && args.key.trim() ? args.key.trim() : '自定义脉冲',
      source: 'raw',
      code: cleanCode,
      freq: clampInt(args.freq, DEFAULT_FREQ_HZ, 20_000, 60_000),
      frames: clampInt(args.frames, 1, 1, 8),
    };
  } else {
    spec = resolveKeySpec(args.key, learnedKeys, {
      frames: args.frames,
      defaultFrames: config.defaultFrames,
      freq: args.freq,
      usePreset: args.usePreset === true,
    });
  }

  const discovery = await discoverSpeakerSsh({
    sshTarget: args.sshTarget,
    dataDir: paths.dataDir,
    homeDir: paths.homeDir,
  });

  const stepDelayMs = computeStepDelayMs(intervalMs, spec.frames);
  const deliveries = [];
  for (let i = 0; i < count; i++) {
    const out = await emitIrOnce(sshRunner, discovery.target, spec, dryRun);
    deliveries.push(out);
    if (i < count - 1 && !dryRun) {
      await sleepFn(stepDelayMs);
    }
  }

  const countSuffix = count > 1 ? ` × ${count}` : '';
  return {
    ok: true,
    notify: true,
    title: dryRun ? '电视按键预演' : '电视按键已发送',
    message: dryRun
      ? `🧪 预演发送电视「${spec.label}」(${spec.key})${countSuffix} → 音箱 ${discovery.target.id}`
      : `📺 已发送电视「${spec.label}」(${spec.key})${countSuffix}`,
    data: {
      dryRun,
      target: discovery.target,
      key: spec.key,
      label: spec.label,
      source: spec.source,
      hex20: spec.hex20,
      freq: spec.freq,
      frames: spec.frames,
      count,
      stepDelayMs,
      code: spec.code,
      command: deliveries[0]?.command,
      deliveries,
    },
  };
}

async function handleSequence(args, deps, paths, sshRunner, sleepFn) {
  const config = loadConfig(paths.configPath);
  const learnedKeys = loadLearnedKeys(paths.learnedPath);
  const dryRun = args.dryRun === true;
  const baseIntervalMs = clampInt(args.intervalMs ?? config.defaultIntervalMs, DEFAULT_INTERVAL_MS, 50, 5000);
  const rawSteps = parseSequenceSteps(args.keys ?? args.sequence);

  const resolvedSteps = rawSteps.map(step => ({
    ...step,
    spec: resolveKeySpec(step.key, learnedKeys, {
      frames: step.frames ?? args.frames,
      defaultFrames: config.defaultFrames,
      freq: args.freq,
      usePreset: step.usePreset ?? (args.usePreset === true),
    }),
  }));

  const discovery = await discoverSpeakerSsh({
    sshTarget: args.sshTarget,
    dataDir: paths.dataDir,
    homeDir: paths.homeDir,
  });

  const trace = [];
  for (let i = 0; i < resolvedSteps.length; i++) {
    const item = resolvedSteps[i];
    const out = await emitIrOnce(sshRunner, discovery.target, item.spec, dryRun);
    const delayAfterMs = i < resolvedSteps.length - 1
      ? computeStepDelayMs(item.delayMs ?? baseIntervalMs, item.spec.frames)
      : 0;
    trace.push({
      index: i,
      key: item.spec.key,
      label: item.spec.label,
      source: item.spec.source,
      hex20: item.spec.hex20,
      frames: item.spec.frames,
      delayAfterMs,
      command: out.command,
    });
    if (delayAfterMs > 0 && !dryRun) {
      await sleepFn(delayAfterMs);
    }
  }

  const labelSeq = trace.map(t => t.label).join(' → ');
  return {
    ok: true,
    notify: true,
    title: dryRun ? '电视组合按键预演' : '电视组合按键已执行',
    message: dryRun
      ? `🧪 预演电视序列（${trace.length} 步）：${labelSeq}`
      : `📺 已执行电视组合按键：${labelSeq}`,
    data: {
      dryRun,
      target: discovery.target,
      stepCount: trace.length,
      steps: trace,
    },
  };
}

async function handleLearn(args, deps, paths, sshRunner, sleepFn) {
  const rawKey = typeof args.key === 'string' ? args.key.trim() : '';
  if (!rawKey || !VALID_LEARN_KEY_RE.test(rawKey)) {
    throw new Error('请提供合法的学习按键名 key（1-32 位字母/数字/中文/_/+/-，如 "menu" 或 "source"）');
  }
  const lower = rawKey.toLowerCase();
  const canonical = PRESET_ALIAS_MAP.get(lower) ?? PRESET_ALIAS_MAP.get(lower.replace(/\s+/g, ''));
  const targetKey = canonical ?? rawKey;
  const label = typeof args.label === 'string' && args.label.trim()
    ? args.label.trim()
    : (canonical ? PRESET_KEYS[canonical].label : rawKey);
  const timeoutMs = clampInt(args.timeoutMs, DEFAULT_LEARN_TIMEOUT_MS, 2_000, 25_000);
  const pollIntervalMs = clampInt(args.pollIntervalMs, LEARN_POLL_INTERVAL_MS, 100, 2_000);
  const freq = clampInt(args.freq, DEFAULT_FREQ_HZ, 20_000, 60_000);

  const discovery = await discoverSpeakerSsh({
    sshTarget: args.sshTarget,
    dataDir: paths.dataDir,
    homeDir: paths.homeDir,
  });

  if (args.dryRun === true) {
    return {
      ok: true,
      notify: true,
      title: '电视红外学习 (预演)',
      message: `🧪 预演学习按键「${label}」(${targetKey}) → 音箱 ${discovery.target.id}`,
      data: {
        dryRun: true,
        target: discovery.target,
        key: targetKey,
        label,
        learnCommand: buildLearnStartCommand(targetKey),
        readCommand: buildLearnReadCommand(targetKey),
        stopCommand: buildLearnStopCommand(targetKey),
      },
    };
  }

  const startRes = await sshRunner(discovery.target, buildLearnStartCommand(targetKey), 6_000);
  if (startRes.code !== 0) {
    throw new Error(startRes.stderr.trim() || `启动红外学习失败 (exit=${startRes.code})`);
  }
  const startJson = parseUbusJson(startRes.stdout);
  if (startJson && typeof startJson.code === 'number' && startJson.code !== 0) {
    throw new Error(`ir_agent learn 启动失败 (code=${startJson.code}, info=${String(startJson.info ?? '')})`);
  }

  const nowFn = deps.now ?? Date.now;
  const deadline = nowFn() + timeoutMs;
  let capturedCode = '';
  try {
    while (nowFn() < deadline) {
      await sleepFn(pollIntervalMs);
      const readRes = await sshRunner(discovery.target, buildLearnReadCommand(targetKey), 5_000);
      if (readRes.code !== 0) continue;
      const readJson = parseUbusJson(readRes.stdout);
      if (
        readJson
        && typeof readJson.code === 'number'
        && readJson.code === 0
        && typeof readJson.info === 'string'
        && readJson.info.includes(',')
        && readJson.info.trim().length >= 15
      ) {
        capturedCode = readJson.info.trim();
        break;
      }
    }
  } finally {
    await sshRunner(discovery.target, buildLearnStopCommand(targetKey), 4_000).catch(() => {});
  }

  if (!capturedCode) {
    return {
      ok: false,
      notify: true,
      title: '电视红外学习超时',
      message: `⏱️ ${Math.round(timeoutMs / 1000)} 秒内未检测到物理遥控器按键信号（按键 ${targetKey}），已自动关闭学习接收。`,
      data: {
        key: targetKey,
        label,
        target: discovery.target,
        timeoutMs,
      },
    };
  }

  const learnedKeys = loadLearnedKeys(paths.learnedPath);
  const learnedAt = Date.now();
  learnedKeys[targetKey] = {
    key: targetKey,
    label,
    code: capturedCode,
    freq,
    frames: 1,
    learnedAt,
  };
  writeJsonPrivate(paths.learnedPath, learnedKeys);

  const pulseCount = capturedCode.split(',').filter(Boolean).length;
  return {
    ok: true,
    notify: true,
    title: '电视红外学习成功',
    message: `✅ 已学习并保存电视按键「${label}」(${targetKey}，共 ${pulseCount} 段脉冲)。`,
    data: {
      key: targetKey,
      label,
      target: discovery.target,
      freq,
      pulseCount,
      code: capturedCode,
      learnedAt,
      learnedPath: paths.learnedPath,
    },
  };
}

/**
 * Execute a tv-ir plugin action with optional injected dependencies for unit tests.
 */
/**
 * Execute a tv-ir plugin action.
 * @param {string} [action]
 * @param {Record<string, any>} [args]
 * @param {Record<string, any>} [deps]
 * @returns {Promise<import('../_shared/types.d.ts').PluginActionResult>}
 */
export async function executeTvIrAction(action = 'status', args = {}, deps = {}) {
  const paths = getRuntimePaths(deps);
  const sshRunner = deps.sshRunner ?? ((target, cmd, timeoutMs) => defaultSshRunner(target, cmd, timeoutMs, {
    homeDir: paths.homeDir,
    signal: deps.signal,
  }));
  const sleepFn = deps.sleep ?? delay;
  const normalizedAction = String(action || 'status').trim();

  if (normalizedAction === 'status') {
    return handleStatus(args, deps, paths, sshRunner);
  }
  if (normalizedAction === 'keys') {
    return handleKeys(paths);
  }
  if (normalizedAction === 'config') {
    return handleConfig(args, paths);
  }
  if (normalizedAction === 'learn') {
    return handleLearn(args, deps, paths, sshRunner, sleepFn);
  }
  if (normalizedAction === 'sequence') {
    return handleSequence(args, deps, paths, sshRunner, sleepFn);
  }
  if (normalizedAction === 'press') {
    return handlePress(args, deps, paths, sshRunner, sleepFn);
  }

  // Allow direct key name as action (e.g. pluginAction: "menu" or "back" in timers / shortcuts)
  const lowerAction = normalizedAction.toLowerCase();
  const learnedKeys = loadLearnedKeys(paths.learnedPath);
  const isDirectKey = PRESET_ALIAS_MAP.has(lowerAction)
    || PRESET_ALIAS_MAP.has(lowerAction.replace(/\s+/g, ''))
    || Boolean(findLearnedEntry(learnedKeys, [normalizedAction]));
  if (isDirectKey) {
    return handlePress(
      { ...args, key: args.key ?? normalizedAction },
      deps,
      paths,
      sshRunner,
      sleepFn,
    );
  }

  return {
    ok: false,
    notify: true,
    title: '电视红外操作失败',
    message: `不支持的 tv-ir 动作 "${normalizedAction}"，可用动作：status、keys、press、sequence、learn、config。`,
  };
}

export async function runAction(action = 'status', args = {}, context = {}) {
  return executeTvIrAction(action, args, context);
}

export async function handleVoiceFastpath(request, context = {}) {
  return handleTvIrVoiceFastpath(request, context, (action, args, ctx) => executeTvIrAction(action, args, ctx ?? context));
}

async function main() {
  const action = process.argv[2] || 'status';
  let args = {};
  try {
    args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  } catch {
    args = {};
  }
  try {
    const result = await executeTvIrAction(action, args);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      notify: true,
      title: '电视红外遥控失败',
      message: errMsg(err),
    }) + '\n');
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  await main();
}

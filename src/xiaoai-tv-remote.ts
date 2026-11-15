import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ImChannelConfig } from './store.js';
import {
  buildXiaoaiLedCommand,
  parseXiaoaiSshTargets,
  setXiaoaiSpeakerLed,
  stripXiaoaiDialogDirective,
  type XiaoaiSshRunner,
  type XiaoaiSshTarget,
} from './xiaoai.js';

const DEFAULT_FREQ_HZ = 38_000;
const DEFAULT_INTERVAL_MS = 240;
export const DEFAULT_TV_REMOTE_IDLE_TTL_MS = 60_000;
export const MAX_TV_REMOTE_SEQUENCE_STEPS = 20;

export interface TvIrPresetSpec {
  device: number;
  func: number;
  frames: number;
  label: string;
  aliases: string[];
}

export interface TvIrLearnedKeyEntry {
  key: string;
  label?: string;
  code: string;
  freq?: number;
  frames?: number;
  learnedAt?: number;
}

export interface TvIrRuntimeConfig {
  sshTarget?: string;
  defaultIntervalMs?: number;
  defaultFrames?: number;
}

export interface TvIrRuntimeSettings {
  config: TvIrRuntimeConfig;
  learnedKeys: Record<string, TvIrLearnedKeyEntry>;
}

export interface ResolvedTvIrKeySpec {
  key: string;
  label: string;
  source: 'preset' | 'learned';
  code: string;
  hex20?: string;
  freq: number;
  frames: number;
}

export interface TvRemoteKeyStep {
  key: string;
  spec: ResolvedTvIrKeySpec;
}

export type TvRemoteInModeParseResult =
  | { kind: 'exit' }
  | { kind: 'reenter'; steps: TvRemoteKeyStep[] }
  | { kind: 'press'; steps: TvRemoteKeyStep[] }
  | { kind: 'unrecognized' };

export interface TvRemoteEntryParseResult {
  matched: boolean;
  initialSteps: TvRemoteKeyStep[];
}

export interface TvRemoteSession {
  channelId: string;
  targetId: string;
  speakerTarget: XiaoaiSshTarget;
  irTarget: XiaoaiSshTarget;
  activatedAt: number;
  expiresAt: number;
}

/**
 * Standard Xiaomi / Redmi TV 20-bit 4-PPM IR key map (Device 0x86, Power 0x3C).
 * Note: "退出" is intentionally NOT aliased to `back` here because in continuous TV remote mode
 * "退出" exits the remote-control session while "返回" triggers TV `back`.
 */
export const TV_IR_PRESET_KEYS: Record<string, TvIrPresetSpec> = {
  power: {
    device: 0x3c,
    func: 0xcc,
    frames: 4,
    label: '电源',
    aliases: [
      '电源', '电源键', '开关', '开关机', '开机', '关机',
      '开电视', '打开电视', '关电视', '关闭电视', '关掉电视', '电视开机', '电视关机', '开关电视',
      '待机', 'power', 'tv_power',
    ],
  },
  power_alt: {
    device: 0x86,
    func: 0x03,
    frames: 4,
    label: '备用电源',
    aliases: ['备用电源', '电源2', '电源二', 'power_alt', 'power2'],
  },
  menu: {
    device: 0x86,
    func: 0x04,
    frames: 2,
    label: '菜单',
    aliases: ['菜单', '菜单键', '设置', '选项', '更多', '打开菜单', '打开设置', 'menu', 'settings', 'options'],
  },
  up: {
    device: 0x86,
    func: 0x05,
    frames: 2,
    label: '上',
    aliases: [
      '上', '向上', '往上', '上移', '方向上', '上面', '往上边', '向上边',
      '往上走', '向上走', '往上翻', '向上翻', '上键', 'up',
      '网上', '像上', '相上', '望上', '忘上',
    ],
  },
  down: {
    device: 0x86,
    func: 0x06,
    frames: 2,
    label: '下',
    aliases: [
      '下', '向下', '往下', '下移', '方向下', '下面', '往下边', '向下边',
      '往下走', '向下走', '往下翻', '向下翻', '下键', 'down',
      '像下', '相下', '网下', '望下', '忘下',
    ],
  },
  back: {
    device: 0x86,
    func: 0x07,
    frames: 2,
    label: '返回',
    aliases: [
      '返回', '返回键', '后退', '回退', '上一页', '上一步',
      '返回上一页', '返回上一级', '退回', '退回去', '反回', '返回去',
      'back', 'return', 'esc',
    ],
  },
  home: {
    device: 0x86,
    func: 0x08,
    frames: 2,
    label: '主页',
    aliases: [
      '主页', '主页键', '首页', '桌面', '主界面',
      '回主页', '回首页', '回桌面', '回到主页', '回到首页', '回到桌面',
      '返回主页', '返回首页', '返回桌面',
      '打开主页', '打开首页', 'home',
    ],
  },
  left: {
    device: 0x86,
    func: 0x0b,
    frames: 2,
    label: '左',
    aliases: [
      '左', '向左', '往左', '左移', '方向左', '左边', '往左边',
      '往左走', '向左走', '快退', '左键', 'left',
      '像左', '相左', '网左', '望左', '忘左',
    ],
  },
  right: {
    device: 0x86,
    func: 0x0c,
    frames: 2,
    label: '右',
    aliases: [
      '右', '向右', '往右', '右移', '方向右', '右边', '往右边',
      '往右走', '向右走', '快进', '右键', 'right',
      '像右', '相右', '网右', '望右', '忘右', '往有', '网有',
    ],
  },
  ok: {
    device: 0x86,
    func: 0x0d,
    frames: 2,
    label: '确认',
    aliases: [
      '确认', '确定', '确认键', '确定键', '点击', '点一下', '按一下',
      '回车', '选择', '选定', '选这个', '就这个', '进去', '点进去',
      '打开', '打开它', '播放', '暂停', '继续播放', '暂停播放', '播放暂停',
      'ok', 'enter', 'select', 'click', 'confirm',
    ],
  },
  vol_up: {
    device: 0x86,
    func: 0x0e,
    frames: 2,
    label: '音量+',
    aliases: [
      '音量+', '音量加', '声音+', '声音加', '加音量', '加声音',
      '调大音量', '调大声音', '音量调大', '声音调大',
      '音量大一点', '声音大一点', '音量大点', '声音大点',
      '大声一点', '大声点', '再大声点', '大声',
      'vol_up', 'vol+', 'volume_up', 'volume+',
    ],
  },
  vol_down: {
    device: 0x86,
    func: 0x0f,
    frames: 2,
    label: '音量-',
    aliases: [
      '音量-', '音量减', '声音-', '声音减', '减音量', '减声音',
      '调小音量', '调小声音', '音量调小', '声音调小',
      '音量小一点', '声音小一点', '音量小点', '声音小点',
      '小声一点', '小声点', '再小声点', '小声',
      'vol_down', 'vol-', 'volume_down', 'volume-',
    ],
  },
};

const PRESET_ALIAS_MAP = new Map<string, string>();
for (const [canonical, spec] of Object.entries(TV_IR_PRESET_KEYS)) {
  const candidates = [canonical, spec.label, ...spec.aliases];
  for (const alias of candidates) {
    const lower = alias.trim().toLowerCase();
    PRESET_ALIAS_MAP.set(lower, canonical);
    PRESET_ALIAS_MAP.set(lower.replace(/\s+/g, ''), canonical);
  }
}

// Context-free SenseVoice homophones observed on LX06; enabled only inside continuous TV remote mode.
const IN_MODE_ASR_HOMOPHONE_GROUPS: Record<string, string[]> = {
  up: ['晚上', '王上', '马上', '打上'],
  down: ['晚下', '王下', '哪下', '拿下'],
  left: ['往座', '网座', '晚左', '王左'],
  right: ['网友', '慢有', '漫游', '慢右', '王右', '往又', '往佑'],
  menu: ['彩蛋', '打开彩蛋', '菜当'],
  back: ['放一', '放回', '范回', '防回'],
  ok: ['缺人', '却定'],
  home: ['竹叶', '守夜', '主业'],
};

const IN_MODE_ASR_HOMOPHONE_MAP = new Map<string, string>();
for (const [canonical, aliases] of Object.entries(IN_MODE_ASR_HOMOPHONE_GROUPS)) {
  for (const alias of aliases) {
    const lower = alias.trim().toLowerCase();
    IN_MODE_ASR_HOMOPHONE_MAP.set(lower, canonical);
    IN_MODE_ASR_HOMOPHONE_MAP.set(lower.replace(/\s+/g, ''), canonical);
  }
}

const EXIT_REMOTE_MODE_RE = /^(?:退出(?:(?:电视)?遥控(?:模式)?)?(?:吧)?|退出去(?:吧)?|结束(?:(?:电视)?遥控(?:模式)?)?(?:吧)?|关闭(?:(?:电视)?遥控(?:模式)?)|关掉(?:(?:电视)?遥控(?:模式)?)|停止(?:(?:电视)?遥控(?:模式)?)?|停下?|停一下|停了|不(?:要|用)?(?:遥控|控)了?|别(?:遥控|控)了?|取消(?:(?:电视)?遥控(?:模式)?)?(?:吧)?|好了|好啦|可以了|行了|搞定了|不用了?|不要了|不玩了|算了(?:吧)?|没事了?|退一?下(?:吧)?|闭嘴|先这样(?:吧)?)$/;

const ENTRY_REMOTE_MODE_RE = /^(?:(?:请|帮我|我想|我要|现在)?(?:进入|开启|打开|启动|开始|切换到)?(?:(?:红米|小米)?电视遥控|遥控(?:红米|小米)?电视|连续(?:遥控|操作)电视)(?:模式)?|(?:请|帮我|我想|我要|现在)?(?:进入|开启|打开|启动|开始|切换到)遥控(?:模式)?)(.*)$/;

const REDUPLICATION_KEY_MAP: Record<string, string> = {
  上: 'up',
  下: 'down',
  左: 'left',
  右: 'right',
};

const CHINESE_NUMERALS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  俩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function escapeShellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function runTvIrSshOnce(
  target: XiaoaiSshTarget,
  remoteCommand: string,
  timeoutMs: number,
  useControlMaster: boolean,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const controlArgs = useControlMaster
      ? [
          '-o', 'ControlMaster=auto',
          '-o', 'ControlPath=/tmp/friday-xiaoai-%C',
          '-o', 'ControlPersist=600',
        ]
      : [
          '-o', 'ControlMaster=no',
          '-o', 'ControlPath=none',
        ];
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=5',
      '-o', 'HostKeyAlgorithms=+ssh-rsa',
      '-o', 'PubkeyAcceptedKeyTypes=+ssh-rsa',
      ...controlArgs,
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=2',
      ...(target.port ? ['-p', String(target.port)] : []),
      target.userHost,
      remoteCommand,
    ];
    execFile('ssh', args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const errWithCode = error as Error & { code?: number | string };
        if (typeof errWithCode.code === 'number') {
          resolvePromise({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            code: errWithCode.code,
          });
          return;
        }
        rejectPromise(error);
        return;
      }
      resolvePromise({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        code: 0,
      });
    });
  });
}

const defaultTvIrSshRunner: XiaoaiSshRunner = async (target, remoteCommand, options) => {
  const timeoutMs = options?.timeoutMs ?? 8_000;
  const startedAt = Date.now();
  const first = await runTvIrSshOnce(target, remoteCommand, timeoutMs, true);
  if (first.code === 255 && Date.now() - startedAt < 2_000) {
    return runTvIrSshOnce(target, remoteCommand, timeoutMs, false);
  }
  return first;
};

/**
 * Encode a Xiaomi 20-bit 4-PPM IR frame sequence into microsecond pulse durations.
 */
export function encodeXiaomiTvIrFrame(
  deviceByte: number,
  funcByte: number,
  frames = 2,
): { code: string; hex20: string; checksum: number; frames: number } {
  const d = Number(deviceByte) & 0xff;
  const f = Number(funcByte) & 0xff;
  const repeat = clampInt(frames, 2, 1, 16);
  const checksum = ((d >> 4) & 0xf) ^ (d & 0xf) ^ ((f >> 4) & 0xf) ^ (f & 0xf);
  const value20 = (d << 12) | (f << 4) | (checksum & 0xf);
  const hex20 = `0x${value20.toString(16).toUpperCase().padStart(5, '0')}`;

  const singleFrame = [1000, 570];
  for (let shift = 18; shift >= 0; shift -= 2) {
    const sym = (value20 >> shift) & 0x3;
    singleFrame.push(600, 570 + sym * 300);
  }
  singleFrame.push(600, 10510);

  const pulses: number[] = [];
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

function readJsonObjectSafe(filePath: string): Record<string, unknown> {
  if (!filePath || !existsSync(filePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Ignore malformed plugin data files
  }
  return {};
}

/**
 * Load persisted tv-ir config and learned keys from `${homeDir}/plugins/tv-ir/` when present.
 */
export function loadTvIrRuntimeSettings(homeDir: string): TvIrRuntimeSettings {
  const dataDir = join(homeDir, 'plugins', 'tv-ir');
  const rawConfig = readJsonObjectSafe(join(dataDir, 'config.json'));
  const rawLearned = readJsonObjectSafe(join(dataDir, 'learned-keys.json'));

  const config: TvIrRuntimeConfig = {
    ...(typeof rawConfig.sshTarget === 'string' && rawConfig.sshTarget.trim()
      ? { sshTarget: rawConfig.sshTarget.trim() }
      : {}),
    ...(typeof rawConfig.defaultIntervalMs === 'number' && Number.isFinite(rawConfig.defaultIntervalMs)
      ? { defaultIntervalMs: clampInt(rawConfig.defaultIntervalMs, DEFAULT_INTERVAL_MS, 50, 5000) }
      : {}),
    ...(typeof rawConfig.defaultFrames === 'number' && Number.isFinite(rawConfig.defaultFrames)
      ? { defaultFrames: clampInt(rawConfig.defaultFrames, 2, 1, 8) }
      : {}),
  };

  const learnedKeys: Record<string, TvIrLearnedKeyEntry> = {};
  for (const [k, v] of Object.entries(rawLearned)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const obj = v as Record<string, unknown>;
    if (typeof obj.code !== 'string' || !obj.code.trim()) continue;
    learnedKeys[k] = {
      key: typeof obj.key === 'string' && obj.key.trim() ? obj.key.trim() : k,
      ...(typeof obj.label === 'string' && obj.label.trim() ? { label: obj.label.trim() } : {}),
      code: obj.code.trim(),
      ...(typeof obj.freq === 'number' && Number.isFinite(obj.freq) ? { freq: obj.freq } : {}),
      ...(typeof obj.frames === 'number' && Number.isFinite(obj.frames) ? { frames: obj.frames } : {}),
      ...(typeof obj.learnedAt === 'number' ? { learnedAt: obj.learnedAt } : {}),
    };
  }

  return { config, learnedKeys };
}

function findLearnedMatch(
  learnedKeys: Record<string, TvIrLearnedKeyEntry>,
  candidates: string[],
): { name: string; entry: TvIrLearnedKeyEntry } | undefined {
  const index = new Map<string, { name: string; entry: TvIrLearnedKeyEntry }>();
  for (const [k, entry] of Object.entries(learnedKeys)) {
    index.set(k.trim().toLowerCase(), { name: k, entry });
    if (entry.label?.trim()) {
      index.set(entry.label.trim().toLowerCase(), { name: k, entry });
    }
  }
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const direct = learnedKeys[trimmed];
    if (direct && direct.code.trim()) {
      return { name: trimmed, entry: direct };
    }
    const matched = index.get(trimmed.toLowerCase());
    if (matched && matched.entry.code.trim()) {
      return matched;
    }
  }
  return undefined;
}

/**
 * Resolve a canonical key name or alias into an executable IR payload.
 */
export function resolveTvIrKeySpec(
  rawKey: string,
  learnedKeys: Record<string, TvIrLearnedKeyEntry> = {},
  options?: { defaultFrames?: number; allowFuzzyHomophones?: boolean },
): ResolvedTvIrKeySpec | undefined {
  const trimmed = rawKey.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  const compact = lower.replace(/\s+/g, '');
  const canonical =
    PRESET_ALIAS_MAP.get(lower)
    ?? PRESET_ALIAS_MAP.get(compact)
    ?? (options?.allowFuzzyHomophones
      ? (IN_MODE_ASR_HOMOPHONE_MAP.get(lower) ?? IN_MODE_ASR_HOMOPHONE_MAP.get(compact))
      : undefined);

  const learnedMatch = findLearnedMatch(
    learnedKeys,
    canonical ? [canonical, trimmed, compact] : [trimmed, compact],
  );
  if (learnedMatch) {
    const preset = canonical ? TV_IR_PRESET_KEYS[canonical] : undefined;
    return {
      key: canonical ?? learnedMatch.name,
      label: learnedMatch.entry.label?.trim() || preset?.label || learnedMatch.name,
      source: 'learned',
      code: learnedMatch.entry.code.trim(),
      freq: clampInt(learnedMatch.entry.freq, DEFAULT_FREQ_HZ, 20_000, 60_000),
      frames: clampInt(learnedMatch.entry.frames, 1, 1, 8),
    };
  }

  if (canonical) {
    const preset = TV_IR_PRESET_KEYS[canonical];
    if (!preset) return undefined;
    const frames = clampInt(options?.defaultFrames, preset.frames, 1, 8);
    const encoded = encodeXiaomiTvIrFrame(preset.device, preset.func, frames);
    return {
      key: canonical,
      label: preset.label,
      source: 'preset',
      code: encoded.code,
      hex20: encoded.hex20,
      freq: DEFAULT_FREQ_HZ,
      frames: encoded.frames,
    };
  }

  return undefined;
}

export function buildTvIrPlayCommand(code: string, freq = DEFAULT_FREQ_HZ): string {
  const payload = JSON.stringify({ freq, code });
  return `ubus -t 3 call ir_agent play '${escapeShellSingleQuote(payload)}'`;
}

function parseRepeatCountToken(token: string): number | undefined {
  const t = token.trim();
  if (!t) return undefined;
  if (/^\d+$/.test(t)) {
    const num = Number(t);
    return num >= 1 && num <= MAX_TV_REMOTE_SEQUENCE_STEPS ? num : undefined;
  }
  if (t in CHINESE_NUMERALS) {
    return CHINESE_NUMERALS[t];
  }
  if (t.length === 2 && t.startsWith('十') && t[1]! in CHINESE_NUMERALS) {
    return 10 + CHINESE_NUMERALS[t[1]!]!;
  }
  if (t === '二十') return 20;
  return undefined;
}

function stripUtteranceFiller(raw: string): string {
  let text = raw.trim();
  // Strip leading interjections ("呃，", "嗯，", "啊 ", "那个，")
  text = text.replace(/^(?:(?:呃+|嗯+|啊+|哦+|噢+|诶+|那个)[，,、\s。！!？?]*)+/, '');
  // Strip trailing punctuation and harmless modal endings
  text = text.replace(/[。，,！!？?、；;\s]+$/g, '');
  text = text.replace(/^(?:的|呢|呀|吧)+$/, '');
  return text.trim();
}

function parseSingleKeyClause(
  rawClause: string,
  learnedKeys: Record<string, TvIrLearnedKeyEntry>,
  options?: { defaultFrames?: number; allowFuzzyHomophones?: boolean },
): TvRemoteKeyStep[] | undefined {
  let clause = rawClause
    .trim()
    .replace(/^[，,、；;。！!？?\s]+|[，,、；;。！!？?\s]+$/g, '')
    .trim();
  if (!clause) return undefined;

  // Strip benign polite/order prefixes and trailing modal particles ("先...", "帮我...", "...吧")
  clause = clause
    .replace(/^(?:呃|嗯|啊|哦|诶|请|麻烦|帮我|先|再|然后|接着|之后|把?电视)+/g, '')
    .trim();
  clause = clause.replace(/(?:呀|啦|吧|啊|哦)+$/g, '').trim();
  if (!clause) return undefined;

  // 1. Exact alias or learned match BEFORE stripping count suffixes (protects "点一下", "按一下", "大声一点", "小声点")
  const direct = resolveTvIrKeySpec(clause, learnedKeys, options);
  if (direct) {
    return [{ key: direct.key, spec: direct }];
  }

  // Strip leading "按/点" verb phrase when remainder resolves directly to a preset or learned key (e.g. "按一下菜单", "按一下信号源")
  const strippedLeadingSingle = clause.replace(
    /^(?:按|点|轻按|轻点)一?(?:下|次|个)?/,
    '',
  ).trim();
  if (strippedLeadingSingle && strippedLeadingSingle !== clause) {
    const matchAfterLead = resolveTvIrKeySpec(strippedLeadingSingle, learnedKeys, options);
    if (matchAfterLead) {
      return [{ key: matchAfterLead.key, spec: matchAfterLead }];
    }
    if (/^(?:菜单|设置|选项|主页|首页|桌面|返回|后退|上一页|上一步|确认|确定|电源|开关机?|开电视|关电视|音量|声音|方向|上|下|左|右)/.test(strippedLeadingSingle)) {
      clause = strippedLeadingSingle;
    }
  }

  // 2. Leading repeat prefix ("按两下左" -> left * 2)
  const leadCountMatch = /^(?:按|点|往|向)?([一二两俩三四五六七八九十\d]{1,2})\s*(?:下|次|格|步|个|遍)(?:的)?(.+)$/.exec(clause);
  if (leadCountMatch?.[1] && leadCountMatch[2]) {
    const count = parseRepeatCountToken(leadCountMatch[1]);
    const spec = resolveTvIrKeySpec(leadCountMatch[2], learnedKeys, options);
    if (count && spec) {
      return Array.from({ length: count }, () => ({ key: spec.key, spec }));
    }
  }

  // 3. Directional reduplication ("上上", "下下下", "左左", "右右")
  if (/^([上下左右])\1{1,9}$/.test(clause)) {
    const char = clause[0]!;
    const key = REDUPLICATION_KEY_MAP[char];
    const spec = key ? resolveTvIrKeySpec(key, learnedKeys, options) : undefined;
    if (spec) {
      return Array.from({ length: clause.length }, () => ({ key: spec.key, spec }));
    }
  }

  // 4. Trailing count suffix ("往下三下", "向下按两下", "往右2格", "往下按一个", "音量加3格")
  const trailCountMatch = /^(.+?)(?:按键?|按|点|走|移|翻|调)?\s*([一二两俩三四五六七八九十\d]{1,2})\s*(?:下|次|步|格|个|遍|点)$/.exec(clause);
  if (trailCountMatch?.[1] && trailCountMatch[2]) {
    const count = parseRepeatCountToken(trailCountMatch[2]);
    let basePart = trailCountMatch[1].trim();
    // Handle "音量大一点" -> fell into direct already; handle "音量加3格" or "音量调大两格"
    basePart = basePart.replace(/^[按点](?=.+)/, '').trim();
    const spec = resolveTvIrKeySpec(basePart, learnedKeys, options);
    if (count && spec) {
      return Array.from({ length: count }, () => ({ key: spec.key, spec }));
    }
  }

  // 5. Fallback trailing "一下/个" after key ("返回一下", "菜单一个", "向下按一个")
  const trailOneMatch = /^(.+?)(?:按|点|走|移|调)?(?:一下|一次|一步|一格|一个)$/.exec(clause);
  if (trailOneMatch?.[1]) {
    const spec = resolveTvIrKeySpec(trailOneMatch[1], learnedKeys, options);
    if (spec) {
      return [{ key: spec.key, spec }];
    }
  }

  return undefined;
}

function segmentConcatenatedKeyClause(
  clause: string,
  learnedKeys: Record<string, TvIrLearnedKeyEntry>,
  options?: { defaultFrames?: number; allowFuzzyHomophones?: boolean },
): TvRemoteKeyStep[] | undefined {
  const trimmed = clause.trim();
  if (trimmed.length < 2 || trimmed.length > 40) return undefined;

  const failedPos = new Set<number>();
  const scan = (pos: number, countSoFar: number): TvRemoteKeyStep[] | undefined => {
    if (pos === trimmed.length) return [];
    if (failedPos.has(pos)) return undefined;

    let start = pos;
    if (pos > 0) {
      const conn = /^[，,、\s]*(?:然后再?|然后|接着|之后|再(?=\S))/.exec(trimmed.slice(pos));
      if (conn) {
        start += conn[0].length;
      }
    }
    if (start >= trimmed.length) return pos > 0 ? [] : undefined;

    const maxEnd = Math.min(trimmed.length, start + 12);
    for (let end = maxEnd; end > start; end--) {
      if (pos === 0 && end === trimmed.length) continue;
      const head = parseSingleKeyClause(trimmed.slice(start, end), learnedKeys, options);
      if (!head || head.length === 0) continue;
      if (countSoFar + head.length > MAX_TV_REMOTE_SEQUENCE_STEPS) continue;
      const tail = scan(end, countSoFar + head.length);
      if (tail !== undefined) {
        return [...head, ...tail];
      }
    }

    failedPos.add(pos);
    return undefined;
  };

  const result = scan(0, 0);
  return result && result.length > 0 ? result : undefined;
}

/**
 * Parse a spoken TV control phrase (single or multi-step like "往下两下再确认") into resolved key steps.
 */
export function parseTvRemoteStepsPhrase(
  rawText: string,
  learnedKeys: Record<string, TvIrLearnedKeyEntry> = {},
  options?: { defaultFrames?: number; allowFuzzyHomophones?: boolean },
): TvRemoteKeyStep[] | undefined {
  const cleaned = stripUtteranceFiller(rawText);
  if (!cleaned) return undefined;

  const rawClauses = cleaned
    .split(/[,，;；、>→]+|(?:然后|接着|之后|\s+|然后再?)|\b再(?=(?:往|向|按|点|轻按|轻点|上|下|左|右|确|定|返|回|退|菜|设|主|首|音|声|开|关|晚|网|望|忘|王|慢|漫|彩|放|反|竹|守|缺|却))/)
    .map(part => part.trim())
    .filter(Boolean);

  // Also split inline Chinese "再" between two action phrases ("往下两下再确认" where \b doesn't trigger between CJK chars)
  const clauses: string[] = [];
  for (const chunk of rawClauses) {
    const subParts = chunk
      .split(/再(?=(?:往|向|按|点|轻按|轻点|上|下|左|右|确|定|返|回|退|菜|设|主|首|音|声|开|关|晚|网|望|忘|王|慢|漫|彩|放|反|竹|守|缺|却))/)
      .map(s => s.trim())
      .filter(Boolean);
    clauses.push(...subParts);
  }

  if (clauses.length === 0) return undefined;

  const steps: TvRemoteKeyStep[] = [];
  for (const clause of clauses) {
    const parsed = parseSingleKeyClause(clause, learnedKeys, options)
      ?? segmentConcatenatedKeyClause(clause, learnedKeys, options);
    if (!parsed || parsed.length === 0) {
      return undefined;
    }
    for (const step of parsed) {
      steps.push(step);
      if (steps.length > MAX_TV_REMOTE_SEQUENCE_STEPS) {
        return undefined;
      }
    }
  }
  return steps.length > 0 ? steps : undefined;
}

/**
 * Detect whether a user utterance explicitly asks to enter continuous TV remote-control mode.
 */
export function parseTvRemoteEntryUtterance(
  rawText: string,
  learnedKeys: Record<string, TvIrLearnedKeyEntry> = {},
  options?: { defaultFrames?: number },
): TvRemoteEntryParseResult {
  const cleaned = stripUtteranceFiller(rawText);
  if (!cleaned) return { matched: false, initialSteps: [] };

  const match = ENTRY_REMOTE_MODE_RE.exec(cleaned);
  if (!match) return { matched: false, initialSteps: [] };

  const tail = (match[1] ?? '')
    .replace(/^[，,、；;。！!？?\s]*(?:吧|啦|啊|哦)?[，,、；;。！!？?\s]*/g, '')
    .trim();
  if (!tail) {
    return { matched: true, initialSteps: [] };
  }

  const initialSteps = parseTvRemoteStepsPhrase(tail, learnedKeys, options);
  if (initialSteps && initialSteps.length > 0) {
    return { matched: true, initialSteps };
  }

  // If the utterance ends in trailing text that isn't a valid command (e.g. a question), let Router handle it.
  return { matched: false, initialSteps: [] };
}

/**
 * Deterministically parse an utterance spoken while already inside TV remote-control mode.
 */
export function parseTvRemoteInModeUtterance(
  rawText: string,
  learnedKeys: Record<string, TvIrLearnedKeyEntry> = {},
  options?: { defaultFrames?: number },
): TvRemoteInModeParseResult {
  const cleaned = stripUtteranceFiller(rawText);
  if (!cleaned) return { kind: 'unrecognized' };

  if (EXIT_REMOTE_MODE_RE.test(cleaned)) {
    return { kind: 'exit' };
  }

  const entryCheck = parseTvRemoteEntryUtterance(cleaned, learnedKeys, options);
  if (entryCheck.matched) {
    return { kind: 'reenter', steps: entryCheck.initialSteps };
  }

  const steps = parseTvRemoteStepsPhrase(cleaned, learnedKeys, {
    ...options,
    allowFuzzyHomophones: true,
  });
  if (steps && steps.length > 0) {
    return { kind: 'press', steps };
  }

  return { kind: 'unrecognized' };
}

export function isAssistantTvRemoteActivation(text: string): boolean {
  const clean = stripXiaoaiDialogDirective(text).text.trim();
  if (/进入.*(?:(?:电视)?遥控(?:模式)?|遥控电视)/.test(clean)) {
    return true;
  }
  if (
    /(?:电视|红外|遥控)/.test(clean)
    && /(?:(?:要|想|还要|还想)?(?:试|按|测)(?:别的|其他|什么|哪个)?键|(?:试|按)(?:别的|其他)).{0,8}(?:就说|直说|直接说|尽管说|告诉我)/.test(clean)
  ) {
    return true;
  }
  return false;
}

function parseUbusJson(stdout: string): { code?: number; info?: string } | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as { code?: number; info?: string };
  } catch {
    const match = /\{[\s\S]*?\}/.exec(trimmed);
    if (!match) return undefined;
    try {
      return JSON.parse(match[0]) as { code?: number; info?: string };
    } catch {
      return undefined;
    }
  }
}

export function computeTvIrStepDelayMs(
  intervalMs: number,
  frames: number,
  explicitOverrideMs?: number,
): number {
  if (explicitOverrideMs !== undefined) {
    return Math.max(0, explicitOverrideMs);
  }
  return Math.max(140, intervalMs, frames * 30 + 140);
}

/**
 * Manages active per-speaker continuous TV remote-control sessions and serialized IR execution.
 */
export class XiaoaiTvRemoteController {
  private readonly sessions = new Map<string, TvRemoteSession>();
  private readonly emitQueues = new Map<string, Promise<void>>();
  private readonly lastEmitAt = new Map<string, number>();

  private sessionKey(channelId: string, targetId: string): string {
    return `${channelId}:${targetId}`;
  }

  isActive(channelId: string, targetId: string, now = Date.now()): boolean {
    const key = this.sessionKey(channelId, targetId);
    const session = this.sessions.get(key);
    if (!session) return false;
    if (session.expiresAt <= now) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  remainingMs(channelId: string, targetId: string, now = Date.now()): number {
    const key = this.sessionKey(channelId, targetId);
    const session = this.sessions.get(key);
    if (!session) return 0;
    const rem = session.expiresAt - now;
    if (rem <= 0) {
      this.sessions.delete(key);
      return 0;
    }
    return rem;
  }

  get(channelId: string, targetId: string, now = Date.now()): TvRemoteSession | undefined {
    if (!this.isActive(channelId, targetId, now)) return undefined;
    return this.sessions.get(this.sessionKey(channelId, targetId));
  }

  activate(params: {
    channelId: string;
    targetId: string;
    speakerTarget: XiaoaiSshTarget;
    irTarget: XiaoaiSshTarget;
    idleTtlMs?: number;
    now?: number;
  }): TvRemoteSession {
    const now = params.now ?? Date.now();
    const ttlMs = Math.max(100, params.idleTtlMs ?? DEFAULT_TV_REMOTE_IDLE_TTL_MS);
    const key = this.sessionKey(params.channelId, params.targetId);
    const existing = this.sessions.get(key);
    const session: TvRemoteSession = {
      channelId: params.channelId,
      targetId: params.targetId,
      speakerTarget: params.speakerTarget,
      irTarget: params.irTarget,
      activatedAt: existing?.activatedAt ?? now,
      expiresAt: now + ttlMs,
    };
    this.sessions.set(key, session);
    return session;
  }

  touch(
    channelId: string,
    targetId: string,
    idleTtlMs = DEFAULT_TV_REMOTE_IDLE_TTL_MS,
    now = Date.now(),
  ): TvRemoteSession | undefined {
    const key = this.sessionKey(channelId, targetId);
    const session = this.sessions.get(key);
    if (!session || session.expiresAt <= now) {
      this.sessions.delete(key);
      return undefined;
    }
    session.expiresAt = now + Math.max(100, idleTtlMs);
    return session;
  }

  deactivate(channelId: string, targetId: string): boolean {
    return this.sessions.delete(this.sessionKey(channelId, targetId));
  }

  clear(): void {
    this.sessions.clear();
    this.emitQueues.clear();
    this.lastEmitAt.clear();
  }

  resolveIrTarget(
    channel: ImChannelConfig,
    speakerTarget: XiaoaiSshTarget | undefined,
    allChannels: ImChannelConfig[],
    config?: TvIrRuntimeConfig,
  ): XiaoaiSshTarget | undefined {
    if (config?.sshTarget) {
      const configured = parseXiaoaiSshTargets(
        config.sshTarget.startsWith('ssh://') ? config.sshTarget : `ssh://${config.sshTarget}`,
      );
      if (configured[0]) return configured[0];
    }
    if (speakerTarget && /lx06/i.test(speakerTarget.id)) {
      return speakerTarget;
    }
    const channelTargets = parseXiaoaiSshTargets(channel.apiBase);
    const sameChLx06 = channelTargets.find(t => /lx06/i.test(t.id));
    if (sameChLx06) return sameChLx06;

    for (const ch of allChannels) {
      if (!ch.enabled || ch.platform !== 'xiaoai') continue;
      const found = parseXiaoaiSshTargets(ch.apiBase).find(t => /lx06/i.test(t.id));
      if (found) return found;
    }
    return speakerTarget ?? channelTargets[0];
  }

  async emitSteps(params: {
    session: TvRemoteSession;
    steps: TvRemoteKeyStep[];
    settings: TvIrRuntimeSettings;
    sshRunner?: XiaoaiSshRunner;
    stepIntervalMs?: number;
    refreshListenLed?: boolean;
  }): Promise<void> {
    const { session, steps, settings, refreshListenLed } = params;
    if (steps.length === 0) return;

    const sshRunner = params.sshRunner ?? defaultTvIrSshRunner;
    const hostKey = session.irTarget.userHost;
    const configuredIntervalMs = settings.config.defaultIntervalMs ?? DEFAULT_INTERVAL_MS;
    const sameSpeakerAndIr = session.irTarget.userHost === session.speakerTarget.userHost;

    const prev = this.emitQueues.get(hostKey) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        const minGapMs = computeTvIrStepDelayMs(
          configuredIntervalMs,
          step.spec.frames,
          params.stepIntervalMs,
        );
        const lastAt = this.lastEmitAt.get(hostKey) ?? 0;
        const waitMs = lastAt > 0 ? Math.max(0, lastAt + minGapMs - Date.now()) : 0;
        if (waitMs > 0) {
          await delay(waitMs);
        }

        const playCmd = buildTvIrPlayCommand(step.spec.code, step.spec.freq);
        const cmd = refreshListenLed && i === 0 && sameSpeakerAndIr
          ? `${playCmd}; rc=$?; ${buildXiaoaiLedCommand('listen')}; exit $rc`
          : playCmd;

        const res = await sshRunner(session.irTarget, cmd, { timeoutMs: 6_000 });
        this.lastEmitAt.set(hostKey, Date.now());
        if (res.code !== 0) {
          throw new Error(res.stderr.trim() || res.stdout.trim() || `红外发射失败 (exit=${res.code})`);
        }
        const parsed = parseUbusJson(res.stdout);
        if (parsed && typeof parsed.code === 'number' && parsed.code !== 0) {
          throw new Error(`ir_agent play 返回失败 (code=${parsed.code}, info=${String(parsed.info ?? '')})`);
        }
      }

      if (refreshListenLed && !sameSpeakerAndIr) {
        await setXiaoaiSpeakerLed(session.speakerTarget, 'listen', sshRunner);
      }
    }).finally(() => {
      if (this.emitQueues.get(hostKey) === run) {
        this.emitQueues.delete(hostKey);
      }
    });

    this.emitQueues.set(hostKey, run);
    return run;
  }
}

/**
 * @deprecated Lightweight pure phrase-parsing shim kept for backward compatibility.
 * Production TV IR execution and session state live in the `tv-ir` plugin invoked via `tryPluginVoiceFastpath`.
 */
import { parseChineseNumber, stripXiaoaiDialogDirective } from './xiaoai/utterance-utils.js';

const DEFAULT_FREQ_HZ = 38_000;
const MAX_TV_REMOTE_SEQUENCE_STEPS = 20;

export interface TvIrLearnedKeyEntry {
  key: string;
  label?: string;
  code: string;
  freq?: number;
  frames?: number;
  learnedAt?: number;
}

export interface ResolvedTvIrKeySpec {
  key: string;
  label: string;
  source: 'preset' | 'learned';
  code: string;
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

const PRESET_KEY_ALIASES: Record<string, { label: string; frames: number; aliases: string[] }> = {
  power: {
    label: '电源',
    frames: 4,
    aliases: [
      '电源', '电源键', '开关', '开关机', '开机', '关机',
      '开电视', '打开电视', '关电视', '关闭电视', '关掉电视', '电视开机', '电视关机', '开关电视',
      '待机', 'power', 'tv_power',
    ],
  },
  power_alt: {
    label: '备用电源',
    frames: 4,
    aliases: ['备用电源', '电源2', '电源二', 'power_alt', 'power2'],
  },
  menu: {
    label: '菜单',
    frames: 2,
    aliases: ['菜单', '菜单键', '设置', '选项', '更多', '打开菜单', '打开设置', 'menu', 'settings', 'options'],
  },
  up: {
    label: '上',
    frames: 2,
    aliases: [
      '上', '向上', '往上', '上移', '方向上', '上面', '往上边', '向上边',
      '往上走', '向上走', '往上翻', '向上翻', '上键', 'up',
      '网上', '像上', '相上', '望上', '忘上',
    ],
  },
  down: {
    label: '下',
    frames: 2,
    aliases: [
      '下', '向下', '往下', '下移', '方向下', '下面', '往下边', '向下边',
      '往下走', '向下走', '往下翻', '向下翻', '下键', 'down',
      '像下', '相下', '网下', '望下', '忘下',
    ],
  },
  back: {
    label: '返回',
    frames: 2,
    aliases: [
      '返回', '返回键', '后退', '回退', '上一页', '上一步',
      '返回上一页', '返回上一级', '退回', '退回去', '反回', '返回去',
      'back', 'return', 'esc',
    ],
  },
  home: {
    label: '主页',
    frames: 2,
    aliases: [
      '主页', '主页键', '首页', '桌面', '主界面',
      '回主页', '回首页', '回桌面', '回到主页', '回到首页', '回到桌面',
      '返回主页', '返回首页', '返回桌面',
      '打开主页', '打开首页', 'home',
    ],
  },
  left: {
    label: '左',
    frames: 2,
    aliases: [
      '左', '向左', '往左', '左移', '方向左', '左边', '往左边',
      '往左走', '向左走', '快退', '左键', 'left',
      '像左', '相左', '网左', '望左', '忘左',
    ],
  },
  right: {
    label: '右',
    frames: 2,
    aliases: [
      '右', '向右', '往右', '右移', '方向右', '右边', '往右边',
      '往右走', '向右走', '快进', '右键', 'right',
      '像右', '相右', '网右', '望右', '忘右', '往有', '网有',
    ],
  },
  ok: {
    label: '确认',
    frames: 2,
    aliases: [
      '确认', '确定', '确认键', '确定键', '点击', '点一下', '按一下',
      '回车', '选择', '选定', '选这个', '就这个', '进去', '点进去',
      '打开', '打开它', '播放', '暂停', '继续播放', '暂停播放', '播放暂停',
      'ok', 'enter', 'select', 'click', 'confirm',
    ],
  },
  vol_up: {
    label: '音量+',
    frames: 2,
    aliases: [
      '音量+', '音量加', '声音+', '声音加', '加音量', '加声音',
      '调大音量', '调大声音', '音量调大', '声音调大',
      '音量大一点', '声音大一点', '音量大点', '声音大点',
      '大声一点', '大声点', '再大声点', '大声',
      'vol_up', 'vol+', 'volume_up', 'volume+',
    ],
  },
  vol_down: {
    label: '音量-',
    frames: 2,
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
for (const [canonical, spec] of Object.entries(PRESET_KEY_ALIASES)) {
  for (const alias of [canonical, spec.label, ...spec.aliases]) {
    const lower = alias.trim().toLowerCase();
    PRESET_ALIAS_MAP.set(lower, canonical);
    PRESET_ALIAS_MAP.set(lower.replace(/\s+/g, ''), canonical);
  }
}

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
const REDUPLICATION_KEY_MAP: Record<string, string> = { 上: 'up', 下: 'down', 左: 'left', 右: 'right' };

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
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

function resolveKeyAlias(
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
    const preset = canonical ? PRESET_KEY_ALIASES[canonical] : undefined;
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
    const preset = PRESET_KEY_ALIASES[canonical];
    if (!preset) return undefined;
    return {
      key: canonical,
      label: preset.label,
      source: 'preset',
      code: '',
      freq: DEFAULT_FREQ_HZ,
      frames: clampInt(options?.defaultFrames, preset.frames, 1, 8),
    };
  }

  return undefined;
}

function parseRepeatCountToken(token: string): number | undefined {
  const normalized = token.trim().replace(/俩/g, '两');
  const num = parseChineseNumber(normalized);
  return num !== undefined && num >= 1 && num <= MAX_TV_REMOTE_SEQUENCE_STEPS ? num : undefined;
}

function stripUtteranceFiller(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:(?:呃+|嗯+|啊+|哦+|噢+|诶+|那个)[，,、\s。！!？?]*)+/, '')
    .replace(/[。，,！!？?、；;\s]+$/g, '')
    .replace(/^(?:的|呢|呀|吧)+$/, '')
    .trim();
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

  clause = clause
    .replace(/^(?:呃|嗯|啊|哦|诶|请|麻烦|帮我|先|再|然后|接着|之后|把?电视)+/g, '')
    .trim();
  clause = clause.replace(/(?:呀|啦|吧|啊|哦)+$/g, '').trim();
  if (!clause) return undefined;

  const direct = resolveKeyAlias(clause, learnedKeys, options);
  if (direct) {
    return [{ key: direct.key, spec: direct }];
  }

  const strippedLeadingSingle = clause.replace(/^(?:按|点|轻按|轻点)一?(?:下|次|个)?/, '').trim();
  if (strippedLeadingSingle && strippedLeadingSingle !== clause) {
    const matchAfterLead = resolveKeyAlias(strippedLeadingSingle, learnedKeys, options);
    if (matchAfterLead) {
      return [{ key: matchAfterLead.key, spec: matchAfterLead }];
    }
    if (/^(?:菜单|设置|选项|主页|首页|桌面|返回|后退|上一页|上一步|确认|确定|电源|开关机?|开电视|关电视|音量|声音|方向|上|下|左|右)/.test(strippedLeadingSingle)) {
      clause = strippedLeadingSingle;
    }
  }

  const leadCountMatch = /^(?:按|点|往|向)?([一二两俩三四五六七八九十\d]{1,2})\s*(?:下|次|格|步|个|遍)(?:的)?(.+)$/.exec(clause);
  if (leadCountMatch?.[1] && leadCountMatch[2]) {
    const count = parseRepeatCountToken(leadCountMatch[1]);
    const spec = resolveKeyAlias(leadCountMatch[2], learnedKeys, options);
    if (count && spec) {
      return Array.from({ length: count }, () => ({ key: spec.key, spec }));
    }
  }

  if (/^([上下左右])\1{1,9}$/.test(clause)) {
    const char = clause[0];
    const key = char ? REDUPLICATION_KEY_MAP[char] : undefined;
    const spec = key ? resolveKeyAlias(key, learnedKeys, options) : undefined;
    if (spec) {
      return Array.from({ length: clause.length }, () => ({ key: spec.key, spec }));
    }
  }

  const trailCountMatch = /^(.+?)(?:按键?|按|点|走|移|翻|调)?\s*([一二两俩三四五六七八九十\d]{1,2})\s*(?:下|次|步|格|个|遍|点)$/.exec(clause);
  if (trailCountMatch?.[1] && trailCountMatch[2]) {
    const count = parseRepeatCountToken(trailCountMatch[2]);
    const basePart = trailCountMatch[1].trim().replace(/^[按点](?=.+)/, '').trim();
    const spec = resolveKeyAlias(basePart, learnedKeys, options);
    if (count && spec) {
      return Array.from({ length: count }, () => ({ key: spec.key, spec }));
    }
  }

  const trailOneMatch = /^(.+?)(?:按|点|走|移|调)?(?:一下|一次|一步|一格|一个)$/.exec(clause);
  if (trailOneMatch?.[1]) {
    const spec = resolveKeyAlias(trailOneMatch[1], learnedKeys, options);
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

function parseStepsPhrase(
  rawText: string,
  learnedKeys: Record<string, TvIrLearnedKeyEntry> = {},
  options?: { defaultFrames?: number; allowFuzzyHomophones?: boolean },
): TvRemoteKeyStep[] | undefined {
  const cleaned = stripUtteranceFiller(rawText);
  if (!cleaned) return undefined;

  const rawClauses = cleaned
    .split(/[,，;；、>→]+|(?:然后|接着|之后|\s+|然后再?)|\b再(?=(?:往|向|按|点|轻按|轻点|上|下|左|右|确|定|返|回|退|菜|设|主|首|音|声|开|关|晚|网|望|忘|王|慢|漫|彩|放|反|竹|守|缺|却))/)
    .map((part) => part.trim())
    .filter(Boolean);

  const clauses: string[] = [];
  for (const chunk of rawClauses) {
    const subParts = chunk
      .split(/再(?=(?:往|向|按|点|轻按|轻点|上|下|左|右|确|定|返|回|退|菜|设|主|首|音|声|开|关|晚|网|望|忘|王|慢|漫|彩|放|反|竹|守|缺|却))/)
      .map((s) => s.trim())
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

const TV_REMOTE_GUARD_RE = /(?:别|不要|不用|不能|不可以|先不|不必|没必要|稍后|等一?会(?:儿)?|(?:\d+|[一二两三四五六七八九十半]+)\s*(?:秒|分钟|小时)(?:之?后|以后|后)|明天|今晚|为什么|怎么)/;

/**
 * @deprecated Pure phrase parser shim for TV remote entry detection.
 */
export function parseTvRemoteEntryUtterance(
  rawText: string,
  learnedKeys: Record<string, TvIrLearnedKeyEntry> = {},
  options?: { defaultFrames?: number },
): TvRemoteEntryParseResult {
  const cleaned = stripUtteranceFiller(rawText);
  if (!cleaned || TV_REMOTE_GUARD_RE.test(cleaned)) return { matched: false, initialSteps: [] };

  const match = ENTRY_REMOTE_MODE_RE.exec(cleaned);
  if (!match) return { matched: false, initialSteps: [] };

  const tail = (match[1] ?? '')
    .replace(/^[，,、；;。！!？?\s]*(?:吧|啦|啊|哦)?[，,、；;。！!？?\s]*/g, '')
    .trim();
  if (!tail) {
    return { matched: true, initialSteps: [] };
  }

  const initialSteps = parseStepsPhrase(tail, learnedKeys, options);
  if (initialSteps && initialSteps.length > 0) {
    return { matched: true, initialSteps };
  }

  return { matched: false, initialSteps: [] };
}

/**
 * @deprecated Pure phrase parser shim for in-mode TV remote phrases.
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

  if (TV_REMOTE_GUARD_RE.test(cleaned)) {
    return { kind: 'unrecognized' };
  }

  const entryCheck = parseTvRemoteEntryUtterance(cleaned, learnedKeys, options);
  if (entryCheck.matched) {
    return { kind: 'reenter', steps: entryCheck.initialSteps };
  }

  const steps = parseStepsPhrase(cleaned, learnedKeys, {
    ...options,
    allowFuzzyHomophones: true,
  });
  if (steps && steps.length > 0) {
    return { kind: 'press', steps };
  }

  return { kind: 'unrecognized' };
}

/**
 * @deprecated Pure activation check shim for TV remote phrases.
 */
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

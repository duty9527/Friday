/**
 * @deprecated Lightweight pure phrase-parsing shim for XiaoAI smart-home intents.
 * Production plugin fastpath routing goes through `tryPluginVoiceFastpath` (`./plugin.js`) and `plugins/miot/`.
 * This shim contains zero plugin imports, zero disk reads, and zero hardcoded device names.
 */
import {
  parseChineseNumber,
  stripLeadingAssistantWake,
  stripTrailingPunctuation,
} from './xiaoai/utterance-utils.js';

export type XiaoaiMiotRunner = (action: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export type XiaoaiMiotCookOp = 'start' | 'stop' | 'pause' | 'resume' | 'status';

export interface XiaoaiFryerPendingSlot {
  tempC?: number;
  minutes?: number;
}

export type XiaoaiMiotFastIntent =
  | {
      kind: 'cook';
      args: { device: '空气炸锅'; op: XiaoaiMiotCookOp; tempC?: number; minutes?: number; recipe?: string };
    }
  | { kind: 'cook_clarify'; tempC?: number; minutes?: number }
  | {
      kind: 'ac_control';
      room?: string;
      needsRoomCheck: boolean;
      on?: boolean;
      temperature?: number;
      mode?: 'cool' | 'heat' | 'dry' | 'fan' | 'auto';
      fanSpeed?: 'auto' | 'low' | 'medium' | 'high' | 'max';
    }
  | { kind: 'lights_batch'; room?: string; on: boolean }
  | { kind: 'lights_query'; room?: string }
  | { kind: 'device_set'; device: string; on?: boolean; toggle?: boolean }
  | { kind: 'device_get'; device: string };

export interface XiaoaiMiotFastResult {
  handled: boolean;
  ok?: boolean;
  speech?: string;
  followUp?: boolean;
  actionName?: string;
  pendingFryer?: XiaoaiFryerPendingSlot;
}

export const MIOT_AMBIGUOUS_SPEECH = '匹配到多个设备，请带上具体房间名称再说一次。';
export const MIOT_AC_ROOM_SPEECH = '家里有多台空调，请说具体房间，比如客厅空调。';

export { parseChineseNumber };

const MAX_UTTERANCE_CHARS = 36;
const ROOM_NAMES = '客厅|主卧|次卧|大卧|小卧|卧室|书房|儿童房|客房|餐厅';
const ROOM_RE = new RegExp(ROOM_NAMES, 'g');
const FRYER_ALIAS_TEST_RE = /空气炸[锅播国果]|空炸|炸[锅播]/;
const FRYER_ALIAS_RE = /空气炸[锅播国果]|空炸|炸[锅播]/g;
const FILLER_RE = /请|帮我|帮忙|麻烦|把|给|一下|吧|呗|哈|呀|呢|啦/g;

const DELAYED_RE = /(?:\d+|[一二两三四五六七八九十半]+)\s*(?:秒|分钟|分|小时|钟头|个?小时|刻钟)(?:之?后|以后|后)|定时|预约|提醒|每天|每晚|明早|明天|今晚|待会|过一?会|\d+\s*点|[一二两三四五六七八九十]+点/;
const COMPLEX_RE = /如果|要是|假如|顺便|然后|并且|接着|同时|再把|再开|再关|微信|网页|发给|报告|为什么|怎么回事|怎么办|能控制|支持哪些|有哪些功能/;
const OTHER_DOMAIN_RE = /电视|投影|声纹|遥控|B站|哔哩|投屏|油管|YouTube|节目|电影|动画/i;
const NEGATION_RE = /别|不要|不用|不能|不可以|能不能|可不可以|是否|除了|除外/;

const CN_NUM = '一二两三四五六七八九十百';
const NUM_PATTERN = `(?:\\d+|[${CN_NUM}]+)`;

const RECIPES: Array<{ re: RegExp; name: string }> = [
  { re: /薯条/, name: '薯条' },
  { re: /鸡翅/, name: '鸡翅' },
  { re: /红薯|地瓜/, name: '红薯' },
  { re: /蛋挞/, name: '蛋挞' },
  { re: /解冻/, name: '解冻' },
  { re: /果干/, name: '果干' },
  { re: /酸奶/, name: '酸奶' },
];

const SMART_NOUN_RE = /灯|插座|插排|开关|通断器|水泵|过滤|加热棒|风扇|加湿器|净化器|热水器|窗帘/;
const BARE_NOUN_RE = /^(?:灯|插座|插排|开关|通断器)$/;

function uniqueRooms(text: string): string[] {
  return [...new Set(text.match(ROOM_RE) ?? [])];
}

function normalizeUtterance(raw: string): string {
  const withoutWake = stripLeadingAssistantWake(raw);
  return stripTrailingPunctuation(withoutWake)
    .replace(/\s+/g, '')
    .replace(/^[,，。.、！!？?~…；;：:]+|[,，。.、！!？?~…；;：:]+$/g, '')
    .replace(FILLER_RE, '')
    .replace(/的/g, '');
}

function extractFryerParams(text: string): { tempC?: number; minutes?: number; recipe?: string } {
  const tempMatch = new RegExp(`(${NUM_PATTERN})\\s*(?:摄氏度|度|℃)`).exec(text);
  const tempC = tempMatch ? parseChineseNumber(tempMatch[1] ?? '') : undefined;
  let minutes: number | undefined;
  const minMatch = new RegExp(`(${NUM_PATTERN})\\s*(?:分钟|分)`).exec(text);
  if (minMatch) minutes = parseChineseNumber(minMatch[1] ?? '');
  else if (/半个?小时/.test(text)) minutes = 30;
  else {
    const hourMatch = new RegExp(`(${NUM_PATTERN})\\s*个?小时`).exec(text);
    const hours = hourMatch ? parseChineseNumber(hourMatch[1] ?? '') : undefined;
    if (hours !== undefined) minutes = hours * 60;
  }
  const recipe = RECIPES.find((r) => r.re.test(text))?.name;
  return { tempC, minutes, recipe };
}

function parseFryer(t: string): XiaoaiMiotFastIntent | undefined {
  if (!FRYER_ALIAS_TEST_RE.test(t)) return undefined;
  const s = t.replace(FRYER_ALIAS_RE, '空气炸锅');
  if (/预热|保温/.test(s)) return undefined;

  const { tempC, minutes, recipe } = extractFryerParams(s);
  const hasParams = tempC !== undefined || minutes !== undefined || recipe !== undefined;
  const device = '空气炸锅' as const;

  let bareTempC: number | undefined;
  if (!hasParams) {
    if (/关掉|关闭|关上|关了|停下|停止|取消/.test(s) && !/(?:吗|么|了没|没有)$/.test(s)) {
      return { kind: 'cook', args: { device, op: 'stop' } };
    }
    if (/暂停/.test(s)) return { kind: 'cook', args: { device, op: 'pause' } };
    if (/继续|恢复/.test(s)) return { kind: 'cook', args: { device, op: 'resume' } };
    if (/还剩|还要|剩多少|几分钟|多久|状态|做好没|熟了没|好了没|开着吗|在工作吗|吗$|么$|了没$|没有$/.test(s)) {
      return { kind: 'cook', args: { device, op: 'status' } };
    }
    const bareTempMatch = new RegExp(`^.*?空气炸锅(?:调到|调成|设为|设置到|设置成|开到|烤|开)?(${NUM_PATTERN})$`).exec(s);
    if (bareTempMatch) {
      const parsed = parseChineseNumber(bareTempMatch[1] ?? '');
      if (parsed === undefined || parsed < 40 || parsed > 200) return undefined;
      bareTempC = parsed;
    } else if (/^(?:打开|开启|启动|开)?空气炸锅$/.test(s)) {
      return { kind: 'cook_clarify' };
    } else {
      return undefined;
    }
  }

  if (hasParams && /关掉|关闭|关上|关了|停下|停止|取消|暂停|继续|恢复|吗$|么$/.test(s)) return undefined;
  const effectiveTemp = tempC ?? bareTempC;
  if (effectiveTemp !== undefined && (effectiveTemp < 40 || effectiveTemp > 200)) return undefined;
  if (minutes !== undefined && (minutes < 1 || minutes > 1440)) return undefined;
  if ((tempC !== undefined && minutes !== undefined) || recipe !== undefined) {
    return {
      kind: 'cook',
      args: {
        device,
        op: 'start',
        ...(tempC !== undefined ? { tempC } : {}),
        ...(minutes !== undefined ? { minutes } : {}),
        ...(recipe ? { recipe } : {}),
      },
    };
  }
  if (effectiveTemp !== undefined) return { kind: 'cook_clarify', tempC: effectiveTemp };
  if (minutes !== undefined) return { kind: 'cook_clarify', minutes };
  return undefined;
}

function parseFryerFollowUp(
  t: string,
  pending: XiaoaiFryerPendingSlot,
  partialDirect?: Extract<XiaoaiMiotFastIntent, { kind: 'cook_clarify' }>,
): XiaoaiMiotFastIntent | undefined {
  if (!partialDirect && /天气|多少|几度|什么|怎么|为什么|谁|哪/.test(t)) return undefined;
  const extracted = extractFryerParams(t);
  let tempC = extracted.tempC ?? partialDirect?.tempC;
  let minutes = extracted.minutes ?? partialDirect?.minutes;
  const recipe = extracted.recipe;

  if (tempC === undefined && minutes === undefined && !recipe) {
    const bareMatch = new RegExp(`^(?:设成|设为|设置成|设置到|调成|调到|改为|改成|就|要|烤|开)?(${NUM_PATTERN})$`).exec(t);
    if (bareMatch) {
      const bare = parseChineseNumber(bareMatch[1] ?? '');
      if (bare === undefined) return undefined;
      if (pending.tempC === undefined) {
        if (bare < 40 || bare > 200) return undefined;
        tempC = bare;
      } else if (pending.minutes === undefined) {
        if (bare < 1 || bare > 120) return undefined;
        minutes = bare;
      }
    }
  }

  if (tempC === undefined && minutes === undefined && !recipe) return undefined;
  const mergedTemp = tempC ?? pending.tempC;
  const mergedMin = minutes ?? pending.minutes;
  if (mergedTemp !== undefined && (mergedTemp < 40 || mergedTemp > 200)) return undefined;
  if (mergedMin !== undefined && (mergedMin < 1 || mergedMin > 1440)) return undefined;

  if ((mergedTemp !== undefined && mergedMin !== undefined) || recipe !== undefined) {
    return {
      kind: 'cook',
      args: {
        device: '空气炸锅',
        op: 'start',
        ...(mergedTemp !== undefined ? { tempC: mergedTemp } : {}),
        ...(mergedMin !== undefined ? { minutes: mergedMin } : {}),
        ...(recipe ? { recipe } : {}),
      },
    };
  }
  return {
    kind: 'cook_clarify',
    ...(mergedTemp !== undefined ? { tempC: mergedTemp } : {}),
    ...(mergedMin !== undefined ? { minutes: mergedMin } : {}),
  };
}

const AC_FAN_MAP: Array<{ re: RegExp; value: 'auto' | 'low' | 'medium' | 'high' | 'max' }> = [
  { re: /自动风/, value: 'auto' },
  { re: /最大风/, value: 'max' },
  { re: /低风/, value: 'low' },
  { re: /中风/, value: 'medium' },
  { re: /高风/, value: 'high' },
];
const AC_MODE_MAP: Array<{ re: RegExp; value: 'cool' | 'heat' | 'dry' | 'fan' | 'auto' }> = [
  { re: /制冷|冷风/, value: 'cool' },
  { re: /制热|暖风/, value: 'heat' },
  { re: /除湿/, value: 'dry' },
  { re: /送风/, value: 'fan' },
  { re: /自动/, value: 'auto' },
];

function parseAc(t: string): XiaoaiMiotFastIntent | undefined {
  if (!t.includes('空调')) return undefined;
  if (/吗|么|没有?$|多少|几度|状态|所有|全部|全屋|都/.test(t)) return undefined;
  if (/调高|调低|高一点|低一点|高点|低点|升高|降低|太热|太冷|热了|冷了|凉快|暖和/.test(t)) return undefined;
  const rooms = uniqueRooms(t);
  if (rooms.length > 1) return undefined;
  const room = rooms[0];

  let rest = t;
  let fanSpeed: 'auto' | 'low' | 'medium' | 'high' | 'max' | undefined;
  for (const f of AC_FAN_MAP) {
    if (f.re.test(rest)) {
      fanSpeed = f.value;
      rest = rest.replace(f.re, '');
      break;
    }
  }
  const mode = AC_MODE_MAP.find((m) => m.re.test(rest))?.value;

  let temperature: number | undefined;
  const tempMatch = new RegExp(`(${NUM_PATTERN})\\s*度`).exec(rest)
    ?? /(?:调到|调成|设为|设置到|设置成|到)(\d{2})(?!\d)/.exec(rest);
  if (tempMatch) {
    temperature = parseChineseNumber(tempMatch[1] ?? '');
    if (temperature === undefined || temperature < 16 || temperature > 31) return undefined;
  }

  const wantsOff = /关/.test(rest);
  const wantsOn = /打开|开启|开机|启动|开/.test(rest);
  if (wantsOff && wantsOn) return undefined;
  const on = wantsOff ? false : wantsOn ? true : undefined;
  if (on === undefined && temperature === undefined && !mode && !fanSpeed) return undefined;
  if (on === false && (temperature !== undefined || mode || fanSpeed)) return undefined;

  return {
    kind: 'ac_control',
    ...(room ? { room } : {}),
    needsRoomCheck: !room,
    ...(on !== undefined ? { on } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(mode ? { mode } : {}),
    ...(fanSpeed ? { fanSpeed } : {}),
  };
}

function parseLights(t: string, protectedKeywords: string[] = []): XiaoaiMiotFastIntent | undefined {
  if (!t.includes('灯')) return undefined;
  if (protectedKeywords.some((kw) => kw && t.includes(kw))) return undefined;
  const rooms = uniqueRooms(t);
  if (rooms.length > 1) return undefined;
  const room = rooms[0];

  const isQuery = (/(?:哪些|哪个|哪盏|什么|啥|有没有|有哪些)灯/.test(t) && /开着|亮着|没关|没有关|开了|亮了|亮|开启/.test(t))
    || (/灯都?关(?:了|好了|上了|掉了)?(?:吗|没|没有)$/.test(t) && /家里|全屋|全家|所有|全部|都/.test(t))
    || (/灯(?:都)?(?:开着|亮着)(?:吗|没|没有)$/.test(t) && /家里|全屋|全家|所有|全部|都/.test(t));
  if (isQuery) return { kind: 'lights_query', ...(room ? { room } : {}) };

  if (/吗|么|没有?$/.test(t)) return undefined;
  const scoped = /全屋|全家|整个家|家里|家中|所有|全部|每个房间|灯都|灯全|都关|都开|全关|全开/.test(t);
  if (!scoped) return undefined;
  // Bail out if a specific non-room qualifier precedes "灯" (e.g. "关掉全部生态灯").
  const nonRoomQualifier = t
    .replace(new RegExp(ROOM_NAMES, 'g'), '')
    .replace(/(?:全屋|全家|整个家|家里|家中|每个房间|所有|全部|都|全|关掉|关闭|关上|关了|打开|开启|开|关|熄|亮|了|盏|个|把)/g, '');
  if (nonRoomQualifier !== '灯') return undefined;

  const swapped = t.replace(/开关/g, '');
  const off = /关|熄/.test(swapped);
  const on = /开|亮/.test(swapped);
  if (off === on) return undefined;
  return { kind: 'lights_batch', ...(room ? { room } : {}), on };
}

function parseDeviceTarget(t: string): { verb?: 'on' | 'off' | 'toggle'; target: string } | undefined {
  const protectedText = t.replace(/开关/g, '§SW§');
  const hasToggle = /切换/.test(protectedText);
  const off = /关闭|关掉|关上|关了|关|熄灭|熄/.test(protectedText);
  const on = /打开|开启|开|点亮|启动/.test(protectedText);
  if ([off, on, hasToggle].filter(Boolean).length !== 1) return undefined;
  const verb = hasToggle ? 'toggle' : off ? 'off' : 'on';
  const target = protectedText
    .replace(/切换|打开|开启|关闭|关掉|关上|关了|熄灭|点亮|启动|开|关|熄|了|着/g, '')
    .replace(/§SW§/g, '开关');
  return { verb, target };
}

function validDeviceTarget(target: string): boolean {
  if (!target || target.length > 12) return false;
  if (!SMART_NOUN_RE.test(target)) return false;
  if (BARE_NOUN_RE.test(target)) return false;
  if (/空调|空气炸锅|所有|全部|全屋|家里|全家|都|每|哪/.test(target)) return false;
  return true;
}

function parseDevice(t: string): XiaoaiMiotFastIntent | undefined {
  if (!SMART_NOUN_RE.test(t)) return undefined;
  const queryMatch = /^(.*?)(?:是不是)?(?:开着|关着|亮着|开了|关了|打开了|关闭了|关掉了)(?:吗|么|没有?)$|^(.*?)(?:开没开|关没关)$/.exec(t);
  if (queryMatch) {
    const target = (queryMatch[1] ?? queryMatch[2] ?? '').replace(/还|现在|目前/g, '');
    return validDeviceTarget(target) ? { kind: 'device_get', device: target } : undefined;
  }
  if (/吗|么|没有?$|哪/.test(t)) return undefined;
  const parsed = parseDeviceTarget(t);
  if (!parsed?.verb || !validDeviceTarget(parsed.target)) return undefined;
  if (parsed.verb === 'toggle') return { kind: 'device_set', device: parsed.target, toggle: true };
  return { kind: 'device_set', device: parsed.target, on: parsed.verb === 'on' };
}

/**
 * @deprecated Pure MiOT fastpath phrase parser shim.
 */
export function parseXiaoaiMiotUtterance(
  rawText: string,
  pendingFryer?: XiaoaiFryerPendingSlot,
  options?: { protectedKeywords?: string[] },
): XiaoaiMiotFastIntent | undefined {
  const trimmed = (rawText ?? '').trim();
  if (!trimmed || trimmed.length > MAX_UTTERANCE_CHARS) return undefined;
  const compact = trimmed.replace(/\s+/g, '');
  if (DELAYED_RE.test(compact) || COMPLEX_RE.test(compact) || OTHER_DOMAIN_RE.test(compact) || NEGATION_RE.test(compact)) {
    return undefined;
  }
  const t = normalizeUtterance(trimmed);
  if (!t) return undefined;
  const direct = parseFryer(t)
    ?? parseAc(t)
    ?? parseLights(t, options?.protectedKeywords)
    ?? parseDevice(t);
  if (direct && direct.kind !== 'cook_clarify') return direct;
  if (pendingFryer) {
    const merged = parseFryerFollowUp(t, pendingFryer, direct);
    if (merged) return merged;
  }
  return direct;
}

type MiotRecord = Record<string, unknown>;
type MiotClass = 'ok' | 'ambiguous' | 'not_found' | 'failed';

function asRecord(value: unknown): MiotRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as MiotRecord : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function classify(result: MiotRecord): MiotClass {
  if (result.ok === true) return 'ok';
  const data = asRecord(result.data);
  const message = str(result.message) ?? '';
  const code = str(result.code) ?? str(data?.code);
  if (code === 'AMBIGUOUS_DEVICE' || data?.needsClarification === true || /匹配到多个设备/.test(message)) return 'ambiguous';
  if (code === 'DEVICE_NOT_FOUND' || code === 'DEVICE_REQUIRED' || /未找到设备|未找到 did|请通过 device/.test(message)) return 'not_found';
  return 'failed';
}

class MiotThrown extends Error {
  constructor(readonly kind: 'ambiguous' | 'not_found' | 'error') { super(kind); }
}

async function call(run: XiaoaiMiotRunner, action: string, args: MiotRecord): Promise<{ cls: MiotClass; result: MiotRecord }> {
  let result: MiotRecord;
  try {
    result = await run(action, args);
  } catch (error) {
    const code = (error as { code?: unknown } | undefined)?.code;
    if (code === 'AMBIGUOUS_DEVICE') throw new MiotThrown('ambiguous');
    if (code === 'DEVICE_NOT_FOUND' || code === 'DEVICE_REQUIRED') throw new MiotThrown('not_found');
    throw new MiotThrown('error');
  }
  const record = asRecord(result) ?? { ok: false };
  return { cls: classify(record), result: record };
}

function deviceList(result: MiotRecord): MiotRecord[] {
  const data = asRecord(result.data);
  return Array.isArray(data?.devices) ? data.devices.map(asRecord).filter((d): d is MiotRecord => Boolean(d)) : [];
}

function deviceLabel(d: MiotRecord | undefined, fallback: string): string {
  return str(d?.fullName) ?? str(d?.name) ?? fallback;
}

const HANDLED_AMBIGUOUS = (actionName: string): XiaoaiMiotFastResult => ({
  handled: true, ok: true, speech: MIOT_AMBIGUOUS_SPEECH, followUp: true, actionName,
});
const NOT_HANDLED: XiaoaiMiotFastResult = { handled: false };

function failureSpeech(result: MiotRecord, fallback: string): string {
  const message = str(result.message) ?? '';
  if (/抽锅暂停|炸篮/.test(message)) return '炸篮没推到位，请先推好再试。';
  if (/未进入烹饪/.test(str(result.title) ?? '') || /可能未开始加热/.test(message)) return '指令已发送，但锅没有开始加热，请检查炸篮。';
  return fallback;
}

function cookSpeech(op: XiaoaiMiotCookOp, result: MiotRecord, args: { tempC?: number; minutes?: number; recipe?: string }): string {
  const data = asRecord(result.data);
  if (op === 'stop') return '空气炸锅已关闭。';
  if (op === 'pause') return '空气炸锅已暂停。';
  if (op === 'resume') return '空气炸锅已继续烹饪。';
  if (op === 'start') {
    const tempC = Number(data?.tempC ?? args.tempC);
    const minutes = Number(data?.minutes ?? args.minutes);
    const parts = [
      args.recipe,
      Number.isFinite(tempC) && Number.isFinite(minutes) ? `${tempC}度${minutes}分钟` : undefined,
    ].filter((p): p is string => Boolean(p));
    return `空气炸锅已启动${parts.length ? `，${parts.join('，')}` : ''}。`;
  }
  const fryer = asRecord(data?.fryer);
  const code = Number(fryer?.statusCode);
  const left = Number(fryer?.leftTimeMin);
  const statusText = str(fryer?.statusText);
  const leftPart = Number.isFinite(left) && left >= 0 ? `，剩余${left}分钟` : '';
  if (code === 4) return `空气炸锅正在烹饪${leftPart}。`;
  if (code === 5) return `空气炸锅正在预热${leftPart}。`;
  if (code === 2 || code === 8 || code === 9) return `空气炸锅已暂停${leftPart}。`;
  if (code === 6) return '空气炸锅烹饪已完成。';
  if (code === 7) return '空气炸锅预热完成。';
  if (code === 0 || code === 1) return '空气炸锅现在没有在工作。';
  return statusText ? `空气炸锅${statusText}。` : '空气炸锅状态已读取。';
}

function roomMatches(d: MiotRecord, room: string): boolean {
  const dr = str(d.room) ?? '';
  const full = str(d.fullName) ?? '';
  if (!dr && !full) return false;
  if (dr && (dr.includes(room) || room.includes(dr))) return true;
  if (full.includes(room)) return true;
  const bedroom = /卧/;
  return bedroom.test(room) && (bedroom.test(dr) || bedroom.test(full)) && (room === '卧室' || dr === '卧室');
}

const AC_MODE_ZH: Record<string, string> = { cool: '制冷', heat: '制热', dry: '除湿', fan: '送风', auto: '自动' };
const AC_FAN_ZH: Record<string, string> = { auto: '自动风', low: '低风', medium: '中风', high: '高风', max: '最大风' };

async function execAc(intent: Extract<XiaoaiMiotFastIntent, { kind: 'ac_control' }>, run: XiaoaiMiotRunner): Promise<XiaoaiMiotFastResult> {
  const listed = await call(run, 'devices', { category: 'air_conditioner' });
  if (listed.cls !== 'ok') return NOT_HANDLED;
  const acs = deviceList(listed.result).filter((d) => d.controllable !== false);
  const pool = intent.room ? acs.filter((d) => roomMatches(d, intent.room as string)) : acs;
  if (pool.length === 0) return NOT_HANDLED;
  if (pool.length > 1) {
    return intent.room
      ? HANDLED_AMBIGUOUS('set')
      : { handled: true, ok: true, speech: MIOT_AC_ROOM_SPEECH, followUp: true, actionName: 'devices' };
  }
  const target = pool[0];
  if (!target) return NOT_HANDLED;
  const did = str(target.did);
  const label = deviceLabel(target, `${intent.room ?? ''}空调`);
  const setArgs: MiotRecord = {
    ...(did ? { did } : { device: label }),
    ...(intent.on !== undefined ? { on: intent.on } : {}),
    ...(intent.temperature !== undefined ? { temperature: intent.temperature } : {}),
    ...(intent.mode ? { mode: intent.mode } : {}),
    ...(intent.fanSpeed ? { fanSpeed: intent.fanSpeed } : {}),
  };
  const res = await call(run, 'set', setArgs);
  if (res.cls === 'ambiguous') return HANDLED_AMBIGUOUS('set');
  if (res.cls === 'not_found') return NOT_HANDLED;
  if (res.cls === 'failed') {
    return { handled: true, ok: false, speech: `${label}控制失败，请稍后再试。`, followUp: false, actionName: 'set' };
  }
  const segments: string[] = [];
  if (intent.on === true) segments.push('打开');
  if (intent.on === false) segments.push('关闭');
  if (intent.temperature !== undefined) segments.push(`调到${intent.temperature}度`);
  if (intent.mode) segments.push(`切到${AC_MODE_ZH[intent.mode] ?? intent.mode}`);
  if (intent.fanSpeed) segments.push(`风速${AC_FAN_ZH[intent.fanSpeed] ?? intent.fanSpeed}`);
  return { handled: true, ok: true, speech: `${label}已${segments.join('，')}。`, followUp: false, actionName: 'set' };
}

async function execLightsBatch(intent: Extract<XiaoaiMiotFastIntent, { kind: 'lights_batch' }>, run: XiaoaiMiotRunner): Promise<XiaoaiMiotFastResult> {
  const listed = await call(run, 'devices', { category: 'light', ...(intent.room ? { room: intent.room } : {}) });
  if (listed.cls !== 'ok') return NOT_HANDLED;
  // Only toggle direct controllable BT-mesh lights, never outlets/switches categorized under light.
  const targets = deviceList(listed.result).filter((d) =>
    d.controllable === true && d.controlChannel === 'bt_mesh' && d.category === 'light' && str(d.did));
  if (targets.length === 0) return NOT_HANDLED;
  let okCount = 0;
  let failCount = 0;
  for (const d of targets) {
    try {
      const res = await call(run, 'set', { did: str(d.did), on: intent.on });
      if (res.cls === 'ok') okCount++;
      else failCount++;
    } catch {
      failCount++;
    }
  }
  const verb = intent.on ? '打开' : '关闭';
  const scope = intent.room ?? '';
  if (okCount === 0) {
    return { handled: true, ok: false, speech: `${scope}灯没能${verb}，请稍后再试。`, followUp: false, actionName: 'set' };
  }
  const tail = failCount ? `，${failCount}盏没响应` : '';
  return { handled: true, ok: failCount === 0, speech: `已${verb}${scope}${okCount}盏灯${tail}。`, followUp: false, actionName: 'set' };
}

async function execLightsQuery(intent: Extract<XiaoaiMiotFastIntent, { kind: 'lights_query' }>, run: XiaoaiMiotRunner): Promise<XiaoaiMiotFastResult> {
  const listed = await call(run, 'devices', { category: 'light', live: true, ...(intent.room ? { room: intent.room } : {}) });
  if (listed.cls !== 'ok') return NOT_HANDLED;
  const lights = deviceList(listed.result);
  if (lights.length === 0) return NOT_HANDLED;
  const known = lights.filter((d) => typeof asRecord(d.state)?.on === 'boolean');
  if (known.length === 0) {
    return { handled: true, ok: false, speech: '暂时读不到灯的状态，请稍后再试。', followUp: false, actionName: 'devices' };
  }
  const scope = intent.room ?? '';
  const on = known.filter((d) => asRecord(d.state)?.on === true).map((d) => deviceLabel(d, '未命名灯'));
  let speech: string;
  if (on.length === 0) speech = `${scope || '现在'}没有灯开着。`;
  else {
    const joined = on.join('、');
    speech = joined.length <= 22
      ? `${scope}开着的灯有：${joined}。`
      : `${scope}有${on.length}盏灯开着，包括${on.slice(0, 3).join('、')}等。`;
  }
  return { handled: true, ok: true, speech, followUp: false, actionName: 'devices' };
}

/**
 * @deprecated Pure execution adapter shim for injected MiOT runners.
 */
export async function executeXiaoaiMiotFastpath(
  intent: XiaoaiMiotFastIntent,
  deps: { runMiot: XiaoaiMiotRunner },
): Promise<XiaoaiMiotFastResult> {
  const run = deps.runMiot;
  const actionName = intent.kind === 'cook' ? 'cook'
    : intent.kind === 'cook_clarify' ? 'cook_clarify'
    : intent.kind === 'device_get' ? 'get'
    : intent.kind === 'lights_query' ? 'devices' : 'set';
  try {
    switch (intent.kind) {
      case 'cook': {
        const res = await call(run, 'cook', intent.args);
        if (res.cls === 'ambiguous') return HANDLED_AMBIGUOUS('cook');
        if (res.cls === 'not_found') return NOT_HANDLED;
        if (res.cls === 'failed') {
          return {
            handled: true, ok: false, followUp: false, actionName: 'cook',
            speech: failureSpeech(res.result, '空气炸锅没有响应，请稍后再试。'),
          };
        }
        return { handled: true, ok: true, followUp: false, actionName: 'cook', speech: cookSpeech(intent.args.op, res.result, intent.args) };
      }
      case 'cook_clarify': {
        const speech = intent.tempC !== undefined && intent.minutes === undefined
          ? `${intent.tempC}度要烤几分钟？`
          : intent.minutes !== undefined && intent.tempC === undefined
            ? `${intent.minutes}分钟要设多少度？`
            : '空气炸锅要设多少度、几分钟？';
        return {
          handled: true,
          ok: true,
          speech,
          followUp: true,
          actionName: 'cook_clarify',
          pendingFryer: {
            ...(intent.tempC !== undefined ? { tempC: intent.tempC } : {}),
            ...(intent.minutes !== undefined ? { minutes: intent.minutes } : {}),
          },
        };
      }
      case 'ac_control':
        return await execAc(intent, run);
      case 'lights_batch':
        return await execLightsBatch(intent, run);
      case 'lights_query':
        return await execLightsQuery(intent, run);
      case 'device_set': {
        const res = await call(run, 'set', {
          device: intent.device,
          ...(intent.toggle ? { toggle: true } : { on: intent.on === true }),
        });
        if (res.cls === 'ambiguous') return HANDLED_AMBIGUOUS('set');
        if (res.cls === 'not_found') return NOT_HANDLED;
        const data = asRecord(res.result.data);
        const label = deviceLabel(asRecord(data?.device), intent.device);
        if (res.cls === 'failed') {
          return { handled: true, ok: false, speech: `${label}控制失败，请稍后再试。`, followUp: false, actionName };
        }
        const on = intent.toggle ? data?.on === true : intent.on === true;
        return { handled: true, ok: true, speech: `已${on ? '打开' : '关闭'}${label}。`, followUp: false, actionName };
      }
      case 'device_get': {
        const res = await call(run, 'get', { device: intent.device });
        if (res.cls === 'ambiguous') return HANDLED_AMBIGUOUS('get');
        if (res.cls === 'not_found') return NOT_HANDLED;
        const data = asRecord(res.result.data);
        const label = deviceLabel(asRecord(data?.device), intent.device);
        if (res.cls === 'failed') {
          return { handled: true, ok: false, speech: `${label}状态读取失败，请稍后再试。`, followUp: false, actionName };
        }
        if (typeof data?.on === 'boolean') {
          return { handled: true, ok: true, speech: `${label}${data.on ? '开着' : '关着'}。`, followUp: false, actionName };
        }
        return NOT_HANDLED;
      }
    }
  } catch (error) {
    if (error instanceof MiotThrown && error.kind === 'ambiguous') return HANDLED_AMBIGUOUS(actionName);
    return NOT_HANDLED;
  }
}

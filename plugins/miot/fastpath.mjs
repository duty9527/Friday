import { existsSync } from 'node:fs';
import {
  clampInt,
  errMsg,
  readConfig,
  readJsonSafe,
  resolvePluginPaths,
} from '../_shared/config-store.mjs';

const MAX_UTTERANCE_CHARS = 60;
const TV_EXCLUDE_RE = /(?:电视机?|遥控器?)/i;
const ASR_TAG_RE = /<\|[^|]*\|>/g;
const ASSISTANT_WAKE_PREFIX_RE = /^(?:(?:小爱同学|小爱|(?:(?:你好|您好|嗨|嘿|喂|诶|唉|欸|黑|呼叫)\s*(?:星期[五武午舞屋吾无物务]|新期[五武午舞吾无]|心期[五武午舞吾无]|星[七奇期][五武午舞]|行期[五武午舞]|星期的五|friday)|(?:星期五|friday))(?=$|[\s，,。！!？?、：:]))[\s，,。！!？?、：:]*)+/i;
const TRAILING_PUNCT_RE = /[。！!？?，,、；;\s]+$/g;

const NON_MIOT_TARGET_RE = /(?:音乐|歌|歌曲|故事|相声|新闻|天气|闹钟|提醒|蓝牙|wifi|无线网|计时器|手机|电脑|影视仓|饮食仓|尹志仓|tvbox|b站|哔哩|爱奇艺|优酷|腾讯视频|芒果tv|浏览器|历史记录|播放记录|观看记录|记录|选集|详情|弹幕|字幕|全屏|菜单|设置|应用|软件|app|网页|页面|窗口)/i;
const SMART_DEVICE_NOUN_RE = /(?:灯|照明|台灯|吸顶灯|筒灯|射灯|灯带|开关|插座|插排|排插|插头|通断器|风扇|加湿器|净化器|窗帘|扫地机|饮水机|浴霸|空调|空气炸锅|炸锅|水泵|过滤|加热棒|热水器)/;
const BARE_NOUN_RE = /^(?:灯|插座|插排|开关|通断器)$/;

const ROOM_NAMES = '客厅|主卧|次卧|大卧|小卧|卧室|书房|儿童房|客房|餐厅|阳台|厨房|卫生间';
const ROOM_RE = new RegExp(ROOM_NAMES, 'g');
const CN_NUM = '一二两三四五六七八九十百零〇壹贰叁肆伍陆柒捌玖';
const NUM_PATTERN = `(?:\\d+|[${CN_NUM}]+)`;

const DELAYED_RE = new RegExp(
  `(?:\\d+|[${CN_NUM}半]+)\\s*(?:秒钟?|分钟|分|小时|钟头|个?小时|刻钟)(?:之?后|以后|后)|(?:稍后|待会|等会|等一?[会下]|过一?会|一会儿?[之以]?后|定时|预约|提醒|每天|每晚|明早|明天|今晚|\\d+\\s*点|[一二两三四五六七八九十]+点)`,
);
const COMPLEX_RE = /如果|要是|假如|顺便|然后|并且|接着|同时|再把|再开|再关|微信|网页|发给|报告|为什么|怎么回事|怎么办|能控制|支持哪些|有哪些功能/;
const OTHER_DOMAIN_RE = /电视|投影|声纹|遥控|B站|哔哩|投屏|油管|YouTube|节目|电影|动画/i;
const NEGATION_EXPLICIT_RE = /别|不要|不用|不能|不可以|勿|切莫|休想|能不能|可不可以|是否|除了|除外|没让你|没叫你|没说要|没要|没想|没打算|没准备|还是没|真没/;
const ALLOWED_MEI_QUERY_RE = /(?:哪些|什么|啥|还有).*灯.*没关|(?:开没开|关没关|没关(?:吗|么)?|没开(?:吗|么)?|做好没|熟了没|好了没|了没|没有)$/;

const CHINESE_NUMERAL_DIGITS = {
  零: 0, 〇: 0,
  一: 1, 壹: 1,
  二: 2, 两: 2, 俩: 2, 贰: 2,
  三: 3, 叁: 3,
  四: 4, 肆: 4,
  五: 5, 伍: 5,
  六: 6, 陆: 6,
  七: 7, 柒: 7,
  八: 8, 捌: 8,
  九: 9, 玖: 9,
};

/**
 * Parse Arabic digits (`200`) or Chinese numerals (`两百`, `一百八十`, `二十六`, `十`, `半`).
 * @param {string} raw
 * @returns {number | undefined}
 */
export function parseChineseNumber(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  if (s === '半') return 0.5;
  if (s.length === 1 && CHINESE_NUMERAL_DIGITS[s] !== undefined) {
    return CHINESE_NUMERAL_DIGITS[s];
  }
  const m = /^(?:([一二两三四五六七八九壹贰叁肆伍陆柒捌玖])百)?(?:([零〇一二三四五六七八九])?十([一二三四五六七八九])?|([零〇])([一二三四五六七八九])|([一二三四五六七八九]))?$/.exec(s);
  if (!m) return undefined;
  const [, hundreds, tens, ones, zeroJoin, zeroOnes, tailColloquial] = m;
  let total = 0;
  let matched = false;
  if (hundreds) {
    total += (CHINESE_NUMERAL_DIGITS[hundreds] ?? 0) * 100;
    matched = true;
  }
  if (s.includes('十')) {
    const tenDigit = tens && tens !== '零' && tens !== '〇' ? (CHINESE_NUMERAL_DIGITS[tens] ?? 0) : 1;
    total += tenDigit * 10;
    matched = true;
    if (ones) total += CHINESE_NUMERAL_DIGITS[ones] ?? 0;
  } else if (zeroJoin && zeroOnes) {
    total += CHINESE_NUMERAL_DIGITS[zeroOnes] ?? 0;
    matched = true;
  } else if (tailColloquial && hundreds) {
    total += (CHINESE_NUMERAL_DIGITS[tailColloquial] ?? 0) * 10;
    matched = true;
  }
  return matched ? total : undefined;
}

function cleanUtterance(raw) {
  let text = String(raw || '').replace(ASR_TAG_RE, '').trim();
  text = text.replace(ASSISTANT_WAKE_PREFIX_RE, '').trim();
  text = text.replace(TRAILING_PUNCT_RE, '').trim();
  return text;
}

function hasDisallowedNegation(compact) {
  if (NEGATION_EXPLICIT_RE.test(compact)) return true;
  if (compact.includes('没') && !ALLOWED_MEI_QUERY_RE.test(compact)) {
    return true;
  }
  return false;
}

function shouldBailOut(cleaned) {
  const compact = cleaned.replace(/\s+/g, '');
  if (!compact || compact.length > MAX_UTTERANCE_CHARS) return true;
  if (DELAYED_RE.test(compact) || COMPLEX_RE.test(compact) || OTHER_DOMAIN_RE.test(compact)) {
    return true;
  }
  if (hasDisallowedNegation(compact)) return true;
  return false;
}

function normalizeProtectedKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/的/g, '')
    .replace(/\s+/g, '');
}

/** @param {string} normKey */
function splitRoomPrefix(normKey) {
  const m = new RegExp(`^(${ROOM_NAMES})(.+)$`).exec(normKey);
  return m ? { room: m[1], name: m[2] } : { room: '', name: normKey };
}

/**
 * Check if a target query, resolved device, or custom alias matches `config.protectedDevices`.
 * @param {string[]} protectedDevices
 * @param {{
 *   query?: string;
 *   room?: string;
 *   resolved?: { did?: unknown; dev_name?: string; name?: string; room_name?: string; room?: string };
 *   customAliases?: Record<string, string | string[]>;
 * }} info
 * @returns {string | null}
 */
export function findProtectedMatch(protectedDevices, info = {}) {
  const list = Array.isArray(protectedDevices)
    ? protectedDevices.map(x => String(x ?? '').trim()).filter(Boolean)
    : [];
  if (list.length === 0) return null;

  const candidates = new Set();
  const bareCandidates = [];
  const addQueryParts = (rawVal, explicitRoom = '') => {
    const qNorm = normalizeProtectedKey(rawVal);
    if (!qNorm) return;
    candidates.add(qNorm);
    const split = splitRoomPrefix(qNorm);
    const effRoom = explicitRoom ? normalizeProtectedKey(explicitRoom) : split.room;
    bareCandidates.push({ room: effRoom, name: split.name });
    if (effRoom && split.name && !qNorm.startsWith(effRoom)) {
      candidates.add(`${effRoom}${split.name}`);
    }
  };

  if (info.query) addQueryParts(info.query, info.room ?? '');
  if (info.resolved) {
    const r = info.resolved;
    if (r.did !== undefined && r.did !== null) candidates.add(normalizeProtectedKey(String(r.did)));
    const devName = String(r.dev_name ?? r.name ?? '').trim();
    const roomName = String(r.room_name ?? r.room ?? '').trim();
    if (devName) {
      candidates.add(normalizeProtectedKey(devName));
      bareCandidates.push({ room: normalizeProtectedKey(roomName), name: normalizeProtectedKey(devName) });
    }
    if (roomName && devName) candidates.add(normalizeProtectedKey(`${roomName}${devName}`));
  }

  const matchesKeyOrBare = (normTarget) => {
    if (!normTarget) return false;
    if (candidates.has(normTarget)) return true;
    const tSplit = splitRoomPrefix(normTarget);
    return bareCandidates.some(b =>
      b.name === tSplit.name && (!tSplit.room || !b.room || tSplit.room === b.room));
  };

  // Expand customAliases in both directions so alias queries & protected aliases are covered.
  const customAliases = info.customAliases;
  if (customAliases && typeof customAliases === 'object' && !Array.isArray(customAliases)) {
    for (const [aliasKey, aliasVal] of Object.entries(customAliases)) {
      const kNorm = normalizeProtectedKey(aliasKey);
      if (!kNorm) continue;
      const valList = Array.isArray(aliasVal)
        ? aliasVal.map(v => normalizeProtectedKey(v)).filter(Boolean)
        : (typeof aliasVal === 'string' && normalizeProtectedKey(aliasVal) ? [normalizeProtectedKey(aliasVal)] : []);
      if (matchesKeyOrBare(kNorm) || valList.some(vn => matchesKeyOrBare(vn))) {
        candidates.add(kNorm);
        for (const vn of valList) candidates.add(vn);
      }
    }
  }

  for (const entry of list) {
    const normEntry = normalizeProtectedKey(entry);
    if (!normEntry) continue;
    if (matchesKeyOrBare(normEntry)) {
      return entry;
    }
  }
  return null;
}

const FRYER_ALIAS_RE = /(?:空气炸锅|空气炸播|空气炸国|空气炸果|空炸|炸锅)/g;
/** @type {Array<[string, RegExp]>} */
const RECIPE_RULES = [
  ['fries', /(?:薯条|炸薯条)/],
  ['wings', /(?:鸡翅|烤鸡翅)/],
  ['sweet_potato', /(?:红薯|烤红薯|地瓜)/],
  ['egg_tart', /(?:蛋挞|烤蛋挞)/],
  ['defrost', /(?:解冻)/],
  ['dried_fruit', /(?:果干|烘干)/],
  ['yogurt', /(?:酸奶)/],
];

function extractFryerParams(text) {
  const tempMatch = new RegExp(`(${NUM_PATTERN})\\s*(?:摄氏度|度|℃|°c)`, 'i').exec(text);
  const tempC = tempMatch ? parseChineseNumber(tempMatch[1]) : undefined;
  let minutes;
  const minMatch = new RegExp(`(${NUM_PATTERN})\\s*(?:分钟|分|min)`, 'i').exec(text);
  if (minMatch) {
    minutes = parseChineseNumber(minMatch[1]);
  } else if (/半个?小时/.test(text)) {
    minutes = 30;
  } else {
    const hourMatch = new RegExp(`(${NUM_PATTERN})\\s*个?小时`).exec(text);
    const hours = hourMatch ? parseChineseNumber(hourMatch[1]) : undefined;
    if (hours !== undefined) minutes = Math.round(hours * 60);
  }
  let recipe;
  for (const [id, re] of RECIPE_RULES) {
    if (re.test(text)) {
      recipe = id;
      break;
    }
  }
  return { tempC, minutes, recipe };
}

function parseAirFryerIntent(text) {
  if (!FRYER_ALIAS_RE.test(text)) return null;
  FRYER_ALIAS_RE.lastIndex = 0;
  const s = text.replace(FRYER_ALIAS_RE, '空气炸锅').replace(/的/g, '');
  if (/预热|保温/.test(s)) return null;

  const { tempC, minutes, recipe } = extractFryerParams(s);
  const hasParams = tempC !== undefined || minutes !== undefined || recipe !== undefined;

  if (!hasParams) {
    if (/(?:状态|怎么样|还剩|还要|还有多久|剩余时间|剩多少|几分钟|多久|温度多少|开着吗|开了吗|关了吗|关了没|开没开|关没关|在工作吗|做好没|熟了没|好了没|工作吗)/.test(s)) {
      return { kind: 'fryer_action', device: '空气炸锅', action: 'status' };
    }
    if (/(?:暂停|先停一下)/.test(s)) {
      return { kind: 'fryer_action', device: '空气炸锅', action: 'pause' };
    }
    if (/(?:继续|恢复)/.test(s)) {
      return { kind: 'fryer_action', device: '空气炸锅', action: 'resume' };
    }
    if (/(?:关闭|关掉|关上|关了|停止|停下|取消)/.test(s) && !/(?:吗|么|了没|没有)$/.test(s)) {
      return { kind: 'fryer_action', device: '空气炸锅', action: 'stop' };
    }
    const bareTempMatch = new RegExp(`^.*?空气炸锅(?:调到|调成|设为|设置到|设置成|开到|烤|开)?(${NUM_PATTERN})$`).exec(s);
    if (bareTempMatch) {
      const bareTempC = parseChineseNumber(bareTempMatch[1]);
      if (bareTempC === undefined || bareTempC < 40 || bareTempC > 200) return null;
      return { kind: 'cook_clarify', device: '空气炸锅', tempC: bareTempC };
    }
    if (/^(?:请|帮我|帮忙|麻烦|把|给)*(?:打开|开启|启动|开)?空气炸锅$/.test(s.replace(/请|帮我|帮忙|麻烦|一下|吧/g, ''))) {
      return { kind: 'cook_clarify', device: '空气炸锅' };
    }
    return null;
  }

  if (/关闭|关掉|关上|关了|停止|停下|取消|暂停|继续|恢复|吗$|么$/.test(s)) {
    return null;
  }
  if (tempC !== undefined && (tempC < 40 || tempC > 200)) return null;
  if (minutes !== undefined && (minutes < 1 || minutes > 1440)) return null;

  if ((tempC !== undefined && minutes !== undefined) || recipe !== undefined) {
    return {
      kind: 'cook',
      device: '空气炸锅',
      ...(recipe ? { recipe } : {}),
      ...(tempC !== undefined ? { tempC } : {}),
      ...(minutes !== undefined ? { minutes } : {}),
    };
  }
  return {
    kind: 'cook_clarify',
    device: '空气炸锅',
    ...(tempC !== undefined ? { tempC } : {}),
    ...(minutes !== undefined ? { minutes } : {}),
  };
}

function parseFryerFollowUp(text, pending, partialDirect) {
  if (!pending || typeof pending !== 'object') return null;
  if (!partialDirect && /天气|多少|几度|什么|怎么|为什么|谁|哪/.test(text)) return null;
  const extracted = extractFryerParams(text);
  let tempC = extracted.tempC ?? partialDirect?.tempC;
  let minutes = extracted.minutes ?? partialDirect?.minutes;
  const recipe = extracted.recipe;

  if (tempC === undefined && minutes === undefined && !recipe) {
    const cleanSlot = text.replace(/的/g, '').trim();
    const bareMatch = new RegExp(`^(?:设成|设为|设置成|设置到|调成|调到|改为|改成|就|要|烤|开)?(${NUM_PATTERN})$`).exec(cleanSlot);
    if (bareMatch) {
      const bare = parseChineseNumber(bareMatch[1]);
      if (bare === undefined) return null;
      if (pending.tempC === undefined) {
        if (bare < 40 || bare > 200) return null;
        tempC = bare;
      } else if (pending.minutes === undefined) {
        if (bare < 1 || bare > 120) return null;
        minutes = bare;
      }
    }
  }

  if (tempC === undefined && minutes === undefined && !recipe) return null;
  const mergedTemp = tempC ?? pending.tempC;
  const mergedMin = minutes ?? pending.minutes;
  if (mergedTemp !== undefined && (mergedTemp < 40 || mergedTemp > 200)) return null;
  if (mergedMin !== undefined && (mergedMin < 1 || mergedMin > 1440)) return null;

  if ((mergedTemp !== undefined && mergedMin !== undefined) || recipe !== undefined) {
    return {
      kind: 'cook',
      device: '空气炸锅',
      ...(mergedTemp !== undefined ? { tempC: mergedTemp } : {}),
      ...(mergedMin !== undefined ? { minutes: mergedMin } : {}),
      ...(recipe ? { recipe } : {}),
    };
  }
  return {
    kind: 'cook_clarify',
    device: '空气炸锅',
    ...(mergedTemp !== undefined ? { tempC: mergedTemp } : {}),
    ...(mergedMin !== undefined ? { minutes: mergedMin } : {}),
  };
}

function parseAcIntent(text) {
  if (!/空调/.test(text)) return null;
  if (/调高|调低|高一点|低一点|高点|低点|升高|降低|太热|太冷|热了|冷了|凉快|暖和/.test(text)) return null;
  if (/所有|全部|全屋|都/.test(text)) return null;

  const rooms = [...new Set(text.match(ROOM_RE) ?? [])];
  if (rooms.length > 1) return null;

  const statusRe = /(?:状态|开着吗|开了吗|多少度|现在几度)/;
  const prefixMatch = text.match(/^(?:(?:请|帮我|麻烦|能不能|可以|把|将|给)?(?:打开|开启|开一下|关闭|关掉|关了|开启|调低|调高|设置|设定|把|将|调)?)*([^\s把将给开关闭调设到为]+?)(?:的)?空调/);
  let room = rooms[0];
  if (!room && prefixMatch?.[1]) {
    const candidate = prefixMatch[1]
      .replace(/^(?:请|帮我|麻烦|把|将|给|打开|开启|关闭|关掉|关|调|设|设置|看下|查看|查一下)+/g, '')
      .replace(/的$/, '')
      .trim();
    if (candidate && !/^(?:一下|我的|家里|房间)$/.test(candidate)) {
      room = candidate;
    }
  }
  const device = room ? `${room}空调` : '空调';

  if (statusRe.test(text)) {
    return { kind: 'get', device, ...(room ? { room } : {}) };
  }

  let on;
  if (/(?:打开|开启|开一下|开机|开到)/.test(text)) on = true;
  if (/(?:关闭|关掉|关了|关机)/.test(text) && !/(?:打开|开启)/.test(text)) on = false;

  const tempMatch = new RegExp(`(${NUM_PATTERN})\\s*(?:度|℃|°c)`, 'i').exec(text)
    ?? /(?:调到|调成|设为|设置到|设置成|到)(\d{2})(?!\d)/.exec(text);
  let temperature;
  if (tempMatch) {
    temperature = parseChineseNumber(tempMatch[1]);
  }

  let mode;
  if (/制冷|冷风/.test(text)) mode = 'cool';
  else if (/制热|暖风/.test(text)) mode = 'heat';
  else if (/除湿/.test(text)) mode = 'dry';
  else if (/送风/.test(text)) mode = 'fan';
  else if (/自动模式/.test(text)) mode = 'auto';

  let fanSpeed;
  if (/低速|低风|小风/.test(text)) fanSpeed = 'low';
  else if (/中速|中风/.test(text)) fanSpeed = 'medium';
  else if (/高速|高风|大风|强风/.test(text)) fanSpeed = 'high';
  else if (/最大风/.test(text)) fanSpeed = 'max';
  else if (/自动风/.test(text)) fanSpeed = 'auto';

  if (on === undefined && temperature === undefined && mode === undefined && fanSpeed === undefined) {
    if (/^开(?:一下)?空调$/.test(text)) on = true;
    else if (/^关(?:一下)?空调$/.test(text)) on = false;
    else return null;
  }

  return {
    kind: 'ac_set',
    device,
    ...(room ? { room } : {}),
    needsRoomCheck: !room,
    ...(on !== undefined ? { on } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(fanSpeed !== undefined ? { fanSpeed } : {}),
  };
}

function parseLightsIntent(text, protectedKeywords = []) {
  const s = text.replace(/\s+/g, '').replace(/(?:请|帮我|帮忙|麻烦|一下|吧|呗|哈|呀|呢|啦|的)/g, '');
  if (!s.includes('灯')) return null;
  if (protectedKeywords.some(kw => kw && normalizeProtectedKey(s).includes(normalizeProtectedKey(kw)))) {
    return null;
  }
  const rooms = [...new Set(s.match(ROOM_RE) ?? [])];
  if (rooms.length > 1) return null;
  const room = rooms[0];

  const isQuery =
    (/(?:哪些|哪个|哪盏|什么|啥|有没有|有哪些)灯/.test(s) && /开着|亮着|没关|没有关|开了|亮了|亮|开启/.test(s)) ||
    (/灯都?关(?:了|好了|上了|掉了)?(?:吗|没|没有)$/.test(s) && /家里|全屋|全家|所有|全部|都/.test(s)) ||
    (/灯(?:都)?(?:开着|亮着)(?:吗|没|没有)$/.test(s) && /家里|全屋|全家|所有|全部|都/.test(s));
  if (isQuery) {
    return { kind: 'lights_query', ...(room ? { room } : {}) };
  }

  if (/吗|么|没有?$/.test(s)) return null;
  const scoped = /全屋|全家|整个家|家里|家中|所有|全部|每个房间|灯都|灯全|都关|都开|全关|全开/.test(s);
  if (!scoped) return null;

  const nonRoomQualifier = s
    .replace(new RegExp(ROOM_NAMES, 'g'), '')
    .replace(/(?:全屋|全家|整个家|家里|家中|每个房间|所有|全部|都|全|关掉|关闭|关上|关了|打开|开启|开|关|熄|亮|了|盏|个|把|看下|看看)/g, '');
  if (nonRoomQualifier !== '灯') return null;

  const swapped = s.replace(/开关/g, '');
  const off = /关|熄/.test(swapped);
  const on = /开|亮/.test(swapped);
  if (off === on) return null;
  return { kind: 'lights_batch', ...(room ? { room } : {}), on };
}

function parseGenericSwitchIntent(text) {
  const queryMatch = text.match(/^(?:请|帮我|麻烦)?(?:查询|查看|查一下|看看|看下)?\s*(.+?)(?:是)?(?:开着吗|开了吗|关着吗|关了吗|开没开|关没关|状态(?:怎么样)?)[吗嘛呢]?$/);
  if (queryMatch?.[1]) {
    const dev = queryMatch[1].replace(/^(?:请|帮我|麻烦|把|将|给)+/, '').replace(/^我的/, '').trim();
    if (dev && dev.length <= 32 && !BARE_NOUN_RE.test(dev) && !TV_EXCLUDE_RE.test(dev) && !NON_MIOT_TARGET_RE.test(dev)) {
      return { kind: 'get', device: dev };
    }
  }

  let actionWord = '';
  let target = '';

  const baMatch = text.match(/^(?:请|帮我|麻烦|现在)?(?:把|将|给)\s*(.+?)\s*(打开|开启|开一下|开|关闭|关掉|关了|关一下|关|切换|反转)(?:吧|一下|咯|了)?$/);
  if (baMatch?.[1] && baMatch?.[2]) {
    target = baMatch[1].trim();
    actionWord = baMatch[2];
  } else {
    const verbFirstMatch = text.match(/^(?:请|帮我|麻烦|现在)?(打开|开启|开一下|关闭|关掉|关了|关一下|切换|反转|开|关)\s*(?:一下)?\s*(.+?)(?:吧|一下|咯|了)?$/);
    if (verbFirstMatch?.[1] && verbFirstMatch?.[2]) {
      actionWord = verbFirstMatch[1];
      target = verbFirstMatch[2].trim();
    }
  }

  if (!actionWord || !target) return null;
  target = target.replace(/^我的/, '').trim();
  if (!target || BARE_NOUN_RE.test(target) || TV_EXCLUDE_RE.test(target) || NON_MIOT_TARGET_RE.test(target)) {
    return null;
  }
  if (/所有|全部|全屋|家里|全家|都/.test(target)) return null;
  if (!SMART_DEVICE_NOUN_RE.test(target) && target.length > 16) {
    return null;
  }

  const isToggle = /^(?:切换|反转)/.test(actionWord);
  const isOn = /^(?:打开|开启|开一下|开)/.test(actionWord);
  const isOff = /^(?:关闭|关掉|关了|关一下|关)/.test(actionWord);
  if (!isToggle && !isOn && !isOff) return null;

  return {
    kind: 'set_power',
    device: target,
    ...(isToggle ? { toggle: true } : { on: isOn }),
  };
}

/**
 * Parse a Chinese smart-home voice utterance into structured MiOT intent(s).
 * Returns `null` for negation, delayed/scheduled, conditional/multi-step, or non-MiOT utterances.
 * @param {string} rawText
 * @param {{ tempC?: number; minutes?: number }} [pendingFryer]
 * @param {{ protectedKeywords?: string[] }} [options]
 * @returns {Array<Record<string, any>> | null}
 */
export function parseMiotVoiceUtterance(rawText, pendingFryer, options = {}) {
  const cleaned = cleanUtterance(rawText);
  if (!cleaned || shouldBailOut(cleaned)) return null;
  if (TV_EXCLUDE_RE.test(cleaned)) return null;

  const direct =
    parseAirFryerIntent(cleaned) ||
    parseAcIntent(cleaned) ||
    parseLightsIntent(cleaned, options?.protectedKeywords) ||
    parseGenericSwitchIntent(cleaned);

  if (direct && direct.kind !== 'cook_clarify') {
    return [direct];
  }
  if (pendingFryer) {
    const merged = parseFryerFollowUp(cleaned, pendingFryer, direct ?? undefined);
    if (merged) return [merged];
  }
  return direct ? [direct] : null;
}

async function resolveTargetForProtection(intent, runActionFn, deps) {
  try {
    const devListRes = await runActionFn('devices', { live: false }, deps);
    const devices = Array.isArray(devListRes?.data?.devices) ? devListRes.data.devices : [];
    const q = normalizeProtectedKey(intent.device);
    return devices.find(d => {
      const name = normalizeProtectedKey(d.name || d.dev_name || '');
      const room = normalizeProtectedKey(d.room || d.room_name || '');
      const full = `${room}${name}`;
      return name === q || full === q || String(d.did) === String(intent.device);
    });
  } catch {
    return null;
  }
}

async function executeSingleIntent(intent, cfg, deps, runActionFn) {
  const isMutation =
    intent.kind !== 'get' &&
    intent.kind !== 'lights_query' &&
    intent.kind !== 'cook_clarify' &&
    !(intent.kind === 'fryer_action' && intent.action === 'status');

  if (isMutation && Array.isArray(cfg.protectedDevices) && cfg.protectedDevices.length > 0 && intent.device) {
    const preMatch = findProtectedMatch(cfg.protectedDevices, {
      query: intent.device,
      room: intent.room,
      customAliases: cfg.customAliases,
    });
    if (preMatch) {
      return {
        ok: false,
        protectedBlocked: true,
        speech: `设备「${preMatch}」已设为语音保护设备，禁止通过语音控制。`,
      };
    }
    const matched = await resolveTargetForProtection(intent, runActionFn, deps);
    if (matched) {
      const postMatch = findProtectedMatch(cfg.protectedDevices, {
        query: intent.device,
        room: intent.room,
        resolved: matched,
        customAliases: cfg.customAliases,
      });
      if (postMatch) {
        return {
          ok: false,
          protectedBlocked: true,
          speech: `设备「${matched.room ? `${matched.room}${matched.name}` : matched.name || postMatch}」已设为语音保护设备，禁止通过语音控制。`,
        };
      }
    }
  }

  if (intent.kind === 'get') {
    const res = await runActionFn('get', {
      device: intent.device,
      ...(intent.room ? { room: intent.room } : {}),
    }, deps);
    return {
      ok: Boolean(res?.ok),
      speech: res?.message || '已查询设备状态。',
      result: res,
    };
  }

  if (intent.kind === 'fryer_action') {
    const op = intent.action === 'start' ? 'resume' : intent.action;
    const res = await runActionFn('cook', {
      device: intent.device,
      op,
    }, deps);
    return {
      ok: Boolean(res?.ok),
      speech: res?.message || '空气炸锅操作已执行。',
      result: res,
    };
  }

  if (intent.kind === 'cook_clarify') {
    const tempC = intent.tempC;
    const minutes = intent.minutes;
    const speech =
      tempC !== undefined && minutes === undefined
        ? `${tempC}度要烤几分钟？`
        : minutes !== undefined && tempC === undefined
          ? `${minutes}分钟要设多少度？`
          : '空气炸锅要设多少度、几分钟？';
    return {
      ok: true,
      followUp: true,
      pendingFryer: {
        ...(tempC !== undefined ? { tempC } : {}),
        ...(minutes !== undefined ? { minutes } : {}),
      },
      speech,
      result: { ok: true, action: 'cook_clarify' },
    };
  }

  if (intent.kind === 'cook') {
    const res = await runActionFn('cook', {
      device: intent.device,
      op: 'start',
      ...(intent.recipe ? { recipe: intent.recipe } : {}),
      ...(intent.tempC !== undefined ? { tempC: intent.tempC } : {}),
      ...(intent.minutes !== undefined ? { minutes: intent.minutes } : {}),
    }, deps);
    return {
      ok: Boolean(res?.ok),
      clearPendingFryer: true,
      speech: res?.message || '已启动空气炸锅。',
      result: res,
    };
  }

  if (intent.kind === 'ac_set') {
    if (intent.temperature !== undefined) {
      const clamped = clampInt(intent.temperature, 16, 31);
      if (clamped === undefined || intent.temperature < 16 || intent.temperature > 31) {
        return {
          ok: false,
          speech: `空调温度需要在 16 到 31 度之间，${intent.temperature}度超出范围。`,
        };
      }
    }
    /** @type {Record<string, any>} */
    let setTargetArgs = {
      device: intent.device,
      ...(intent.room ? { room: intent.room } : {}),
    };
    if (intent.needsRoomCheck) {
      try {
        const listed = await runActionFn('devices', { category: 'air_conditioner', live: false }, deps);
        const acs = Array.isArray(listed?.data?.devices)
          ? listed.data.devices.filter(d => d.controllable !== false)
          : [];
        if (acs.length > 1) {
          return {
            ok: true,
            followUp: true,
            speech: '家里有多台空调，请说具体房间，比如客厅空调。',
            result: listed,
          };
        }
        if (acs.length === 1 && acs[0]?.did) {
          setTargetArgs = { did: String(acs[0].did), device: String(acs[0].fullName || acs[0].name || intent.device) };
        }
      } catch {
        // Fall through to direct set
      }
    }
    const res = await runActionFn('set', {
      ...setTargetArgs,
      ...(intent.on !== undefined ? { on: intent.on } : {}),
      ...(intent.temperature !== undefined ? { temperature: intent.temperature } : {}),
      ...(intent.mode !== undefined ? { mode: intent.mode } : {}),
      ...(intent.fanSpeed !== undefined ? { fanSpeed: intent.fanSpeed } : {}),
    }, deps);
    return {
      ok: Boolean(res?.ok),
      speech: res?.message || '空调已设置。',
      result: res,
    };
  }

  if (intent.kind === 'lights_batch') {
    const listed = await runActionFn('devices', {
      category: 'light',
      live: false,
      ...(intent.room ? { room: intent.room } : {}),
    }, deps);
    if (!listed?.ok) {
      return { ok: false, speech: listed?.message || '无法读取灯光列表。', result: listed };
    }
    const devices = Array.isArray(listed?.data?.devices) ? listed.data.devices : [];
    const candidates = devices.filter(
      d => d.controllable === true && d.controlChannel === 'bt_mesh' && d.category === 'light' && d.did,
    );
    const targets = candidates.filter(
      d => !findProtectedMatch(cfg.protectedDevices, { resolved: d, customAliases: cfg.customAliases }),
    );
    if (targets.length === 0) {
      return {
        ok: false,
        protectedBlocked: candidates.length > 0,
        notFound: candidates.length === 0,
        speech: candidates.length > 0 ? '所有匹配的灯都已设为保护设备，禁止批量控制。' : '未找到可控制的蓝牙灯设备。',
      };
    }
    let okCount = 0;
    let failCount = 0;
    for (const d of targets) {
      try {
        const res = await runActionFn('set', { did: String(d.did), on: Boolean(intent.on) }, deps);
        if (res?.ok) okCount++;
        else failCount++;
      } catch {
        failCount++;
      }
    }
    const verb = intent.on ? '打开' : '关闭';
    const scope = intent.room ?? '';
    if (okCount === 0) {
      return { ok: false, speech: `${scope}灯没能${verb}，请稍后再试。` };
    }
    const tail = failCount ? `，${failCount}盏没响应` : '';
    return {
      ok: failCount === 0,
      speech: `已${verb}${scope}${okCount}盏灯${tail}。`,
    };
  }

  if (intent.kind === 'lights_query') {
    const listed = await runActionFn('devices', {
      category: 'light',
      live: true,
      ...(intent.room ? { room: intent.room } : {}),
    }, deps);
    if (!listed?.ok) {
      return { ok: false, speech: listed?.message || '无法查询灯状态。', result: listed };
    }
    const lights = Array.isArray(listed?.data?.devices) ? listed.data.devices : [];
    if (lights.length === 0) {
      return { ok: false, notFound: true, speech: '未找到灯设备。' };
    }
    const known = lights.filter(d => typeof d?.state?.on === 'boolean');
    if (known.length === 0) {
      return { ok: false, speech: '暂时读不到灯的状态，请稍后再试。' };
    }
    const scope = intent.room ?? '';
    const on = known.filter(d => d.state.on === true).map(d => d.fullName || d.name || '未命名灯');
    let speech;
    if (on.length === 0) {
      speech = `${scope || '现在'}没有灯开着。`;
    } else {
      const joined = on.join('、');
      speech = joined.length <= 22
        ? `${scope}开着的灯有：${joined}。`
        : `${scope}有${on.length}盏灯开着，包括${on.slice(0, 3).join('、')}等。`;
    }
    return { ok: true, speech, result: listed };
  }

  if (intent.kind === 'set_power') {
    const res = await runActionFn('set', {
      device: intent.device,
      ...(intent.toggle ? { toggle: true } : { on: Boolean(intent.on) }),
    }, deps);
    return {
      ok: Boolean(res?.ok),
      ...(res?.data?.blocked ? { protectedBlocked: true } : {}),
      speech: res?.message || '设备已操作。',
      result: res,
    };
  }

  return { ok: false, speech: '未识别的米家语音指令。' };
}

function matchesCustomAlias(customAliases, intent) {
  if (!customAliases || typeof customAliases !== 'object') return false;
  const queries = new Set();
  const q = normalizeProtectedKey(intent?.device);
  if (q) queries.add(q);
  if (intent?.room && intent?.device) {
    const rq = normalizeProtectedKey(`${intent.room}${intent.device}`);
    if (rq) queries.add(rq);
  }
  if (queries.size === 0) return false;
  for (const [key, val] of Object.entries(customAliases)) {
    if (Array.isArray(val)) {
      if (val.some(alias => queries.has(normalizeProtectedKey(alias)))) return true;
    } else if (typeof val === 'string' && queries.has(normalizeProtectedKey(key))) {
      return true;
    }
  }
  return false;
}

function deviceMatchesQuery(device, query, room) {
  if (!device || typeof device !== 'object') return false;
  const q = normalizeProtectedKey(query);
  if (!q) return false;
  const rq = room ? normalizeProtectedKey(`${room}${query}`) : '';
  const did = normalizeProtectedKey(device.did);
  if (did && (did === q || (rq && did === rq))) return true;
  const name = normalizeProtectedKey(device.dev_name ?? device.name);
  const roomName = normalizeProtectedKey(device.room_name ?? device.room);
  const fullName = normalizeProtectedKey(device.fullName) || (roomName && name ? `${roomName}${name}` : '');
  const modelName = normalizeProtectedKey(device.model_name ?? device.modelName);
  const fields = [name, fullName, modelName].filter(Boolean);
  return fields.some(
    field => field.includes(q) || q.includes(field) || (rq && (field.includes(rq) || rq.includes(field))),
  );
}

function isDeviceNotFoundOutcome(outcome) {
  if (!outcome || outcome.ok || outcome.protectedBlocked) return false;
  if (outcome.notFound) return true;
  const code = outcome.result?.data?.code;
  if (code === 'DEVICE_NOT_FOUND' || code === 'DEVICE_REQUIRED') {
    return true;
  }
  const speech = String(outcome.speech ?? '');
  return speech.includes('未找到') || speech.includes('找不到');
}

/**
 * Handle MiOT voice fastpath queries/commands inside plugins/miot.
 * @param {import('../_shared/types.d.ts').VoiceFastpathRequest} request
 * @param {import('../_shared/types.d.ts').PluginExecutionContext & Record<string, any>} context
 * @param {(action: string, args: Record<string, any>, deps?: any) => Promise<import('../_shared/types.d.ts').PluginActionResult>} runActionFn
 * @returns {Promise<import('../_shared/types.d.ts').VoiceFastpathResult>}
 */
export async function handleMiotVoiceFastpath(request, context = {}, runActionFn) {
  const sessionState = request?.sessionState && typeof request.sessionState === 'object'
    ? request.sessionState
    : null;

  if (sessionState?.event === 'assistant_reply') {
    return { handled: false };
  }
  if (sessionState?.tvRemoteActive || sessionState?.continuous) {
    return { handled: false };
  }

  const paths = resolvePluginPaths('miot', context, {
    cachePath: 'hub-cache.json',
  });
  const rawCfg = readConfig(paths.configPath, {
    routerSsh: '',
    speakerSsh: '',
    protectedDevices: [],
    customAliases: {},
  });
  const protectedDevices = Array.isArray(rawCfg.protectedDevices) ? rawCfg.protectedDevices : [];
  const customAliases = /** @type {Record<string, string | string[]>} */ (
    rawCfg.customAliases && typeof rawCfg.customAliases === 'object' && !Array.isArray(rawCfg.customAliases)
      ? rawCfg.customAliases
      : {}
  );

  const pendingFryer =
    sessionState?.pendingFryer && typeof sessionState.pendingFryer === 'object'
      ? sessionState.pendingFryer
      : undefined;

  const intents = parseMiotVoiceUtterance(request?.text, pendingFryer, {
    protectedKeywords: protectedDevices,
  });
  if (!intents || intents.length === 0) {
    return { handled: false };
  }

  const hasHubInjection = Boolean(
    context?.fetchHubRawRows || context?.sshTextExec || context?.sshBinaryExec || context?.devices,
  );
  const hasRouterConfig = typeof rawCfg.routerSsh === 'string' && rawCfg.routerSsh.trim().length > 0;
  const hasCache = existsSync(paths.cachePath);

  const preProtected = intents.find(
    i =>
      i.kind !== 'get' &&
      i.kind !== 'lights_query' &&
      i.kind !== 'cook_clarify' &&
      !(i.kind === 'fryer_action' && i.action === 'status') &&
      i.device &&
      findProtectedMatch(protectedDevices, { query: i.device, room: i.room, customAliases }),
  );
  if (preProtected) {
    const hit = findProtectedMatch(protectedDevices, {
      query: preProtected.device,
      room: preProtected.room,
      customAliases,
    });
    return {
      handled: true,
      speech: `设备「${hit}」已设为语音保护设备，禁止通过语音控制。`,
      data: { blocked: true, reason: 'protected_device', device: hit },
    };
  }

  if (!hasRouterConfig && !hasCache && !hasHubInjection) {
    return { handled: false };
  }

  if (typeof runActionFn !== 'function') {
    return { handled: false };
  }

  const unverifiedGenericIntents = intents.filter(
    i => (i.kind === 'set_power' || i.kind === 'get') && !SMART_DEVICE_NOUN_RE.test(i.device),
  );
  if (unverifiedGenericIntents.length > 0) {
    const needsLookup = unverifiedGenericIntents.some(i => !matchesCustomAlias(customAliases, i));
    if (needsLookup) {
      let candidateDevices = Array.isArray(context?.devices) ? context.devices : null;
      if (!candidateDevices) {
        const cachedSnapshot = readJsonSafe(paths.cachePath, null);
        if (Array.isArray(cachedSnapshot?.devices)) {
          candidateDevices = cachedSnapshot.devices;
        }
      }
      if (!candidateDevices) {
        try {
          const devRes = await runActionFn('devices', { live: false }, context);
          if (Array.isArray(devRes?.data?.devices)) {
            candidateDevices = devRes.data.devices;
          }
        } catch {
          candidateDevices = null;
        }
      }
      if (Array.isArray(candidateDevices)) {
        const missing = unverifiedGenericIntents.some(
          i => !matchesCustomAlias(customAliases, i) && !candidateDevices.some(d => deviceMatchesQuery(d, i.device, i.room)),
        );
        if (missing) {
          return { handled: false };
        }
      }
    }
  }

  const speeches = [];
  const results = [];
  let allOk = true;
  let followUp = false;
  let nextPendingFryer;
  let clearSessionState = false;
  for (const intent of intents) {
    try {
      const outcome = await executeSingleIntent(
        intent,
        { protectedDevices, customAliases },
        context,
        runActionFn,
      );
      if (!outcome.ok) allOk = false;
      if (outcome.followUp) followUp = true;
      if (outcome.pendingFryer !== undefined) nextPendingFryer = outcome.pendingFryer;
      if (outcome.clearPendingFryer && pendingFryer) clearSessionState = true;
      speeches.push(outcome.speech);
      results.push(outcome);
    } catch (err) {
      allOk = false;
      speeches.push(errMsg(err));
    }
  }

  if (results.length > 0 && results.length === intents.length && results.every(isDeviceNotFoundOutcome)) {
    return { handled: false };
  }

  return {
    handled: true,
    speech: speeches.join(' '),
    ...(followUp ? { followUp: true } : {}),
    ...(nextPendingFryer !== undefined ? { sessionState: { pendingFryer: nextPendingFryer } } : {}),
    ...(clearSessionState && !followUp ? { clearSessionState: true } : {}),
    data: {
      ok: allOk,
      intents,
      results,
    },
  };
}

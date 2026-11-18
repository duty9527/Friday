import {
  errMsg,
  readJsonSafe,
  resolvePluginPaths,
} from '../_shared/config-store.mjs';

export const TV_REMOTE_IDLE_TTL_MS = 60_000;
export const TV_REMOTE_FOLLOW_UP_WAIT_MS = 3_500;
export const MAX_COUNT_PER_STEP = 10;
export const MAX_TOTAL_PRESSES = 20;

const ASR_TAG_RE = /<\|[^|]*\|>/g;
const ASSISTANT_WAKE_PREFIX_RE = /^(?:(?:小爱同学|小爱|(?:(?:你好|您好|嗨|嘿|喂|诶|唉|欸|黑|呼叫)\s*(?:星期[五武午舞屋吾无物务]|新期[五武午舞吾无]|心期[五武午舞吾无]|星[七奇期][五武午舞]|行期[五武午舞]|星期的五|friday)|(?:星期五|friday))(?=$|[\s，,。！!？?、：:]))[\s，,。！!？?、：:]*)+/i;
const PRESET_CAPABLE_KEYS = new Set([
  'power', 'power_alt', 'menu', 'up', 'down', 'back', 'home', 'left', 'right', 'ok', 'vol_up', 'vol_down',
]);

const CHINESE_NUMERALS = new Map([
  ['一', 1],
  ['两', 2],
  ['二', 2],
  ['三', 3],
  ['四', 4],
  ['五', 5],
  ['六', 6],
  ['七', 7],
  ['八', 8],
  ['九', 9],
  ['十', 10],
]);

/**
 * Built-in voice step aliases sorted longest-first during greedy tokenization.
 * @type {Array<[string, string, string]>}
 */
const VOICE_KEY_PATTERNS = [
  ['音量调大一点', 'vol_up', '音量+'],
  ['音量调小一点', 'vol_down', '音量-'],
  ['声音大一点', 'vol_up', '音量+'],
  ['声音小一点', 'vol_down', '音量-'],
  ['调大音量', 'vol_up', '音量+'],
  ['调高音量', 'vol_up', '音量+'],
  ['调小音量', 'vol_down', '音量-'],
  ['调低音量', 'vol_down', '音量-'],
  ['音量调大', 'vol_up', '音量+'],
  ['音量调小', 'vol_down', '音量-'],
  ['声音调大', 'vol_up', '音量+'],
  ['声音调小', 'vol_down', '音量-'],
  ['声音大点', 'vol_up', '音量+'],
  ['声音小点', 'vol_down', '音量-'],
  ['大声一点', 'vol_up', '音量+'],
  ['小声一点', 'vol_down', '音量-'],
  ['取消静音', 'unmute', '取消静音'],
  ['切换信号源', 'source', '信号源'],
  ['vol_down', 'vol_down', '音量-'],
  ['vol_up', 'vol_up', '音量+'],
  ['音量减', 'vol_down', '音量-'],
  ['音量加', 'vol_up', '音量+'],
  ['加音量', 'vol_up', '音量+'],
  ['减音量', 'vol_down', '音量-'],
  ['音量+', 'vol_up', '音量+'],
  ['音量-', 'vol_down', '音量-'],
  ['大声点', 'vol_up', '音量+'],
  ['小声点', 'vol_down', '音量-'],
  ['vol+', 'vol_up', '音量+'],
  ['vol-', 'vol_down', '音量-'],
  ['返回主页', 'home', '主页'],
  ['返回首页', 'home', '主页'],
  ['回主页', 'home', '主页'],
  ['回首页', 'home', '主页'],
  ['回桌面', 'home', '主页'],
  ['主界面', 'home', '主页'],
  ['方向上', 'up', '上'],
  ['方向下', 'down', '下'],
  ['方向左', 'left', '左'],
  ['方向右', 'right', '右'],
  ['上一页', 'back', '返回'],
  ['上一级', 'back', '返回'],
  ['上一步', 'back', '返回'],
  ['信号源', 'source', '信号源'],
  ['输入源', 'source', '信号源'],
  ['开关机', 'power', '电源'],
  ['点确认', 'ok', '确认'],
  ['点确定', 'ok', '确认'],
  ['点一下', 'ok', '确认'],
  ['select', 'ok', '确认'],
  ['return', 'back', '返回'],
  ['source', 'source', '信号源'],
  ['power', 'power', '电源'],
  ['enter', 'ok', '确认'],
  ['right', 'right', '右'],
  ['向上', 'up', '上'],
  ['往上', 'up', '上'],
  ['上键', 'up', '上'],
  ['向下', 'down', '下'],
  ['往下', 'down', '下'],
  ['下键', 'down', '下'],
  ['向左', 'left', '左'],
  ['往左', 'left', '左'],
  ['左键', 'left', '左'],
  ['向右', 'right', '右'],
  ['往右', 'right', '右'],
  ['右键', 'right', '右'],
  ['确认', 'ok', '确认'],
  ['确定', 'ok', '确认'],
  ['选中', 'ok', '确认'],
  ['点击', 'ok', '确认'],
  ['回车', 'ok', '确认'],
  ['暂停', 'ok', '确认'],
  ['返回', 'back', '返回'],
  ['后退', 'back', '返回'],
  ['退回', 'back', '返回'],
  ['回退', 'back', '返回'],
  ['主页', 'home', '主页'],
  ['首页', 'home', '主页'],
  ['桌面', 'home', '主页'],
  ['菜单', 'menu', '菜单'],
  ['设置', 'menu', '菜单'],
  ['选项', 'menu', '菜单'],
  ['静音', 'mute', '静音'],
  ['电源', 'power', '电源'],
  ['开关', 'power', '电源'],
  ['待机', 'power', '电源'],
  ['开机', 'power', '电源'],
  ['关机', 'power', '电源'],
  ['down', 'down', '下'],
  ['left', 'left', '左'],
  ['back', 'back', '返回'],
  ['home', 'home', '主页'],
  ['menu', 'menu', '菜单'],
  ['mute', 'mute', '静音'],
  ['hdmi', 'source', '信号源'],
  ['上', 'up', '上'],
  ['下', 'down', '下'],
  ['左', 'left', '左'],
  ['右', 'right', '右'],
  ['ok', 'ok', '确认'],
  ['up', 'up', '上'],
];

/**
 * SenseVoice ASR homophones enabled only inside continuous TV remote mode
 * (never matched globally to avoid colliding with everyday speech).
 * @type {Array<[string, string, string]>}
 */
const IN_MODE_HOMOPHONE_PATTERNS = [
  ['打开彩蛋', 'menu', '菜单'],
  ['晚上', 'up', '上'],
  ['网上', 'up', '上'],
  ['王上', 'up', '上'],
  ['马上', 'up', '上'],
  ['打上', 'up', '上'],
  ['晚下', 'down', '下'],
  ['王下', 'down', '下'],
  ['哪下', 'down', '下'],
  ['拿下', 'down', '下'],
  ['往座', 'left', '左'],
  ['网座', 'left', '左'],
  ['晚左', 'left', '左'],
  ['王左', 'left', '左'],
  ['网友', 'right', '右'],
  ['慢有', 'right', '右'],
  ['漫游', 'right', '右'],
  ['慢右', 'right', '右'],
  ['王右', 'right', '右'],
  ['往又', 'right', '右'],
  ['往佑', 'right', '右'],
  ['彩蛋', 'menu', '菜单'],
  ['菜当', 'menu', '菜单'],
  ['放一', 'back', '返回'],
  ['放回', 'back', '返回'],
  ['范回', 'back', '返回'],
  ['防回', 'back', '返回'],
  ['缺人', 'ok', '确认'],
  ['却定', 'ok', '确认'],
  ['竹叶', 'home', '主页'],
  ['守夜', 'home', '主页'],
  ['主业', 'home', '主页'],
];

const ENTRY_MODE_RE = /^(?:(?:请|帮我|麻烦|我想|我要|现在)?(?:进入|开启|打开|启动|开始|切到|切换到|用)(?:一下)?(?:(?:红米|小米)?电视遥控|遥控(?:红米|小米)?电视|连续(?:遥控|操作)电视)(?:模式)?|(?:请|帮我|麻烦|我想|我要|现在)?(?:进入|开启|打开|启动|开始|切到|切换到)遥控(?:器)?(?:模式)?|(?:(?:红米|小米)?电视遥控|遥控(?:红米|小米)?电视)(?:模式)?)(.*)$/i;
const EXIT_MODE_RE = /^(?:(?:帮我|请|麻烦)?(?:退出|离开|关闭|关掉|结束|停止|取消)(?:一下)?(?:电视)?遥控(?:器)?(?:模式)?|退出去(?:吧)?|退出|退一?下(?:吧)?|停下?|停一下|停了|不(?:要|用)?(?:遥控|控)了?|别(?:遥控|控)了?|好了|好啦|可以了|行了|搞定了|不用了?|不要了|不玩了|算了(?:吧)?|没事了?|闭嘴|先这样(?:吧)?)$/i;
const FILLER_NOISE_RE = /^[嗯啊哦呃唔唉喂哈呀呢嘛吧]+$/;
const TV_POWER_RE = /^(?:(?:帮我|请|麻烦|现在|立即|马上|先)?(?:把)?电视(?:机)?(打开|开启|开一下|开机|关闭|关掉|关了|关机)|(打开|开启|开一下|关闭|关掉|关了)电视(?:机)?)(?:吧|一下|咯|了)?$/;
const TV_POWER_SHORT_RE = /^(开|关)电视(?:吧|一下)?$/;

function stripWakeAndPunct(raw) {
  let text = String(raw || '').replace(ASR_TAG_RE, '').trim();
  text = text.replace(ASSISTANT_WAKE_PREFIX_RE, '').trim();
  text = text.replace(/^(?:(?:嗯|呃|啊|哦|唉|唔)[，,、\s]*)+/, '').trim();
  text = text.replace(/[。！!？?]+$/g, '').trim();
  return text;
}

/**
 * Parse a Chinese or Arabic count token in range 1..MAX_COUNT_PER_STEP.
 * @param {string} rawCount
 * @returns {number | null}
 */
function parseVoiceCount(rawCount) {
  if (!rawCount) return null;
  if (/^\d+$/.test(rawCount)) {
    const n = Number.parseInt(rawCount, 10);
    return n >= 1 && n <= MAX_COUNT_PER_STEP ? n : null;
  }
  return CHINESE_NUMERALS.get(rawCount) ?? null;
}

/**
 * Recognize direct voice requests to power the TV on or off.
 * @param {string} text
 * @returns {{ state: 'on' | 'off' } | null}
 */
export function parseTvPowerPhrase(text) {
  const cleaned = stripWakeAndPunct(text);
  if (!cleaned) return null;
  const shortMatch = cleaned.match(TV_POWER_SHORT_RE);
  if (shortMatch) {
    return { state: shortMatch[1] === '开' ? 'on' : 'off' };
  }
  const m = cleaned.match(TV_POWER_RE);
  if (!m) return null;
  const verb = m[1] || m[2] || '';
  if (/^(开|打开|开启)/.test(verb)) return { state: 'on' };
  if (/^(关|关闭|关掉)/.test(verb)) return { state: 'off' };
  return null;
}

/**
 * Check whether an assistant reply indicates entering TV remote continuous mode.
 * @param {string} assistantReply
 * @returns {boolean}
 */
export function isAssistantTvRemoteActivation(assistantReply) {
  const text = String(assistantReply || '').replace(/\[\[(?:LISTEN|END)\]\]/g, '').trim();
  if (!text) return false;
  if (/已?(?:进入|开启|切换到|处于).{0,10}(?:电视)?遥控(?:器)?(?:模式)?/.test(text)) {
    return true;
  }
  if (/进入.*(?:(?:电视)?遥控(?:模式)?|遥控电视)/.test(text)) {
    return true;
  }
  if (/请直接说.{0,12}(?:遥控|按键)指令/.test(text)) {
    return true;
  }
  if (
    /(?:电视|红外|遥控)/.test(text) &&
    /(?:(?:要|想|还要|还想)?(?:试|按|测)(?:别的|其他|什么|哪个)?键|(?:试|按)(?:别的|其他)).{0,8}(?:就说|直说|直接说|尽管说|告诉我)/.test(text)
  ) {
    return true;
  }
  return false;
}

/**
 * Build combined key alias patterns including dynamically learned keys.
 * @param {Record<string, { key?: string; label?: string; code?: string }>} [learnedKeys]
 * @param {{ allowFuzzyHomophones?: boolean }} [options]
 * @returns {Array<[string, string, string]>}
 */
function buildCombinedPatterns(learnedKeys = {}, options = {}) {
  /** @type {Array<[string, string, string]>} */
  const dynamic = [];
  if (learnedKeys && typeof learnedKeys === 'object' && !Array.isArray(learnedKeys)) {
    for (const [k, entry] of Object.entries(learnedKeys)) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.code !== 'string' || !entry.code.trim()) continue;
      const canonical = String(entry.key || k).trim();
      const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : canonical;
      if (canonical) {
        dynamic.push([canonical.toLowerCase(), canonical, label]);
      }
      if (label && label.toLowerCase() !== canonical.toLowerCase()) {
        dynamic.push([label.toLowerCase(), canonical, label]);
      }
    }
  }
  const combined = [...dynamic, ...VOICE_KEY_PATTERNS];
  if (options.allowFuzzyHomophones) {
    combined.push(...IN_MODE_HOMOPHONE_PATTERNS);
  }
  // Longer aliases win first so "返回主页" precedes "返回" and "取消静音" precedes "静音".
  combined.sort((a, b) => b[0].length - a[0].length);
  return combined;
}

/**
 * Parse a phrase into ordered IR remote `{ key, label, count }` steps.
 * Returns null if the phrase contains unknown non-filler tokens.
 * @param {string} rawPhrase
 * @param {Record<string, { key?: string; label?: string; code?: string }>} [learnedKeys]
 * @param {{ allowFuzzyHomophones?: boolean }} [options]
 * @returns {{ steps: Array<{ key: string, label: string, count: number }>, hasTvContext: boolean } | null}
 */
export function parseTvRemoteStepsPhrase(rawPhrase, learnedKeys = {}, options = {}) {
  let text = stripWakeAndPunct(rawPhrase);
  if (!text) return null;

  let hasTvContext = /(?:电视机?|遥控器?)/.test(text);

  text = text
    .replace(/^(?:请问|请|麻烦|能不能|可以|帮我|给我|先|首先|把|用|对着)+/g, '')
    .replace(/(?:帮我|给我|请|麻烦)?(?:按一下|按下|按|点击|点一下)?(?:电视机?|遥控器?)(?:的)?/g, () => {
      hasTvContext = true;
      return ' ';
    })
    .replace(/(?:按一下|按下|按(?=[上左右下回菜主静电音大确]|$|\s|[0-9一两二三四五六七八九十])|点击(?![，,。！!]?$)|点一下(?![，,。！!]?$)|调一下|切换到|切到|打开(?![，,。！!]?$))/g, ' ')
    .replace(/(?:然后|接着|之后|再|还有|并且|以及|和|跟|,|，|、|;|；)/g, ' ')
    .replace(/(?:键|按钮|按键)(?=\s|$|[0-9一两二三四五六七八九十]+[下遍次格步])/g, '')
    .replace(/(?:键|按钮|按键)$/g, '')
    .replace(/(?:[吧啊哦呢嘛呀啦]+)$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return null;

  const patterns = buildCombinedPatterns(learnedKeys, options);
  const lower = text.toLowerCase();
  /** @type {Array<{ key: string, label: string, count: number }>} */
  const steps = [];
  let totalPresses = 0;
  let pos = 0;

  while (pos < lower.length) {
    // Skip delimiters only — never swallow direction word '下' here!
    while (pos < lower.length && (lower[pos] === ' ' || lower[pos] === '的')) {
      pos++;
    }
    if (pos >= lower.length) break;

    let pendingPrefixCount;
    const prefixCountMatch = lower
      .slice(pos)
      .match(/^([0-9]{1,2}|[一两二三四五六七八九十])(?:\s*)(?:下|次|遍|格|步|个)(?:\s*)/);
    if (prefixCountMatch && pos + prefixCountMatch[0].length < lower.length) {
      const parsedPrefix = parseVoiceCount(prefixCountMatch[1]);
      if (parsedPrefix !== null) {
        pendingPrefixCount = parsedPrefix;
        pos += prefixCountMatch[0].length;
      }
    }

    let matched = false;
    for (const [alias, canonical, label] of patterns) {
      if (!lower.startsWith(alias, pos)) continue;
      const prevCh = pos > 0 ? lower[pos - 1] : '';
      const nextCh = pos + alias.length < lower.length ? lower[pos + alias.length] : '';
      if (/^[a-z0-9_+-]+$/.test(alias)) {
        if ((prevCh && /[a-z0-9_]/.test(prevCh)) || (nextCh && /[a-z0-9_]/.test(nextCh))) {
          continue;
        }
      }

      pos += alias.length;
      while (pos < lower.length && lower[pos] === ' ') pos++;

      let count = pendingPrefixCount ?? 1;
      if (pendingPrefixCount === undefined) {
        const countMatch = lower
          .slice(pos)
          .match(/^([0-9]{1,2}|[一两二三四五六七八九十])(?:\s*)(?:下|次|遍|格|步|个)?/);
        if (countMatch) {
          const parsedCount = parseVoiceCount(countMatch[1]);
          if (parsedCount === null) return null;
          count = parsedCount;
          pos += countMatch[0].length;
        } else if (lower.startsWith('一下', pos) || lower.startsWith('一个', pos)) {
          pos += 2;
        }
      }

      // Trim trailing conversational modal particle if at end of phrase.
      if (pos < lower.length && /^[吧啊哦呢嘛呀啦]+$/.test(lower.slice(pos))) {
        pos = lower.length;
      }

      totalPresses += count;
      if (totalPresses > MAX_TOTAL_PRESSES) {
        return null;
      }
      const prev = steps[steps.length - 1];
      if (prev && prev.key === canonical && prev.count + count <= MAX_COUNT_PER_STEP) {
        prev.count += count;
      } else {
        steps.push({ key: canonical, label, count });
      }
      matched = true;
      break;
    }

    if (!matched) {
      return null;
    }
  }

  if (steps.length === 0) return null;
  return { steps, hasTvContext };
}

/**
 * Parse TV remote mode entry phrases such as `"遥控电视模式"` or `"进入遥控电视模式，先按一下菜单"`.
 * @param {string} rawText
 * @param {Record<string, { key?: string; label?: string; code?: string }>} [learnedKeys]
 * @returns {{ matched: boolean, initialSteps: Array<{ key: string, label: string, count: number }> }}
 */
export function parseTvRemoteEntryPhrase(rawText, learnedKeys = {}) {
  const cleaned = stripWakeAndPunct(rawText);
  if (!cleaned) return { matched: false, initialSteps: [] };

  const match = ENTRY_MODE_RE.exec(cleaned);
  if (!match) return { matched: false, initialSteps: [] };

  const tail = (match[1] ?? '')
    .replace(/^[，,、；;。！!？?\s]*(?:吧|啦|啊|哦)?[，,、；;。！!？?\s]*/g, '')
    .trim();
  if (!tail) {
    return { matched: true, initialSteps: [] };
  }

  const parsedTail = parseTvRemoteStepsPhrase(tail, learnedKeys);
  if (parsedTail && parsedTail.steps.length > 0) {
    return { matched: true, initialSteps: parsedTail.steps };
  }
  return { matched: false, initialSteps: [] };
}

function formatStepsSpeech(steps) {
  return steps
    .map(step => (step.count > 1 ? `${step.label}${step.count}下` : step.label))
    .join('、');
}

function buildRemoteSessionState() {
  return {
    tvRemoteActive: true,
    continuous: true,
    idleTtlMs: TV_REMOTE_IDLE_TTL_MS,
  };
}

async function tryTvAgentPower(state, context) {
  if (typeof context?.callPlugin !== 'function') {
    return { used: false, reason: 'tv-agent callPlugin unavailable' };
  }
  try {
    const res = await context.callPlugin('tv-agent', 'power', { state });
    if (res && res.ok !== false) {
      return { used: true, result: res };
    }
    return {
      used: false,
      reason: res?.message || 'tv-agent power returned ok=false',
    };
  } catch (err) {
    return { used: false, reason: errMsg(err) };
  }
}

async function tryTvAgentMute(muteFlag, context) {
  if (typeof context?.callPlugin !== 'function') {
    return { used: false, reason: 'tv-agent callPlugin unavailable' };
  }
  try {
    const res = await context.callPlugin('tv-agent', 'volume', { mute: muteFlag });
    if (res && res.ok !== false) {
      return { used: true, result: res };
    }
    return {
      used: false,
      reason: res?.message || 'tv-agent volume(mute) returned ok=false',
    };
  } catch (err) {
    return { used: false, reason: errMsg(err) };
  }
}

function isKeySupported(key, learnedKeys) {
  if (PRESET_CAPABLE_KEYS.has(key)) return true;
  if (learnedKeys && typeof learnedKeys === 'object') {
    const direct = learnedKeys[key];
    if (direct && typeof direct.code === 'string' && direct.code.trim()) return true;
    for (const entry of Object.values(learnedKeys)) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof entry.code === 'string' &&
        entry.code.trim() &&
        (String(entry.key ?? '').toLowerCase() === key.toLowerCase() ||
          String(entry.label ?? '').toLowerCase() === key.toLowerCase())
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Handle TV remote voice fastpath and continuous remote mode.
 * @param {import('../_shared/types.d.ts').VoiceFastpathRequest} request
 * @param {import('../_shared/types.d.ts').PluginExecutionContext & { sshTarget?: string }} [context]
 * @param {(action: string, args: Record<string, any>, ctx?: any) => Promise<import('../_shared/types.d.ts').PluginActionResult>} [actionExecutor]
 * @returns {Promise<import('../_shared/types.d.ts').VoiceFastpathResult>}
 */
export async function handleTvIrVoiceFastpath(request, context = {}, actionExecutor) {
  const paths = resolvePluginPaths('tv-ir', context, {
    learnedPath: 'learned-keys.json',
  });
  const learnedKeys = readJsonSafe(paths.learnedPath, {});
  const sessionState = request?.sessionState && typeof request.sessionState === 'object'
    ? request.sessionState
    : null;

  // 1. Assistant reply activation hook from XiaoAi router.
  if (sessionState?.event === 'assistant_reply') {
    if (isAssistantTvRemoteActivation(String(sessionState.assistantReply ?? ''))) {
      return {
        handled: true,
        action: 'tv_remote_enter',
        followUp: true,
        followUpWaitMs: TV_REMOTE_FOLLOW_UP_WAIT_MS,
        sessionState: buildRemoteSessionState(),
        data: { suppressSpeech: true, activatedByAssistantReply: true },
      };
    }
    return { handled: false };
  }

  const inRemoteMode = Boolean(sessionState?.tvRemoteActive);
  const cleaned = stripWakeAndPunct(request?.text);

  // 2. Exit remote mode (supports "好了", "退出", "不用了", etc.).
  if (inRemoteMode && EXIT_MODE_RE.test(cleaned)) {
    return {
      handled: true,
      action: 'tv_remote_exit',
      speech: '已退出电视遥控模式。',
      clearSessionState: true,
      followUp: false,
      sessionState: null,
      data: { exitedRemoteMode: true },
    };
  }

  // 3. Explicit entry into TV remote mode (optionally with initial steps).
  const entryCheck = parseTvRemoteEntryPhrase(cleaned, learnedKeys);
  if (entryCheck.matched) {
    let initialSpeech = '';
    let initialIrResult = null;
    if (entryCheck.initialSteps.length > 0 && typeof actionExecutor === 'function') {
      const expanded = [];
      for (const step of entryCheck.initialSteps) {
        const execKey = step.key === 'unmute' ? 'mute' : step.key;
        if (!isKeySupported(execKey, learnedKeys)) {
          return {
            handled: true,
            action: 'tv_remote_enter',
            ok: false,
            speech: `按键「${step.label}」暂未学习红外码，请先用 learn 学习 ${execKey} 按键。`,
            followUp: true,
            followUpWaitMs: TV_REMOTE_FOLLOW_UP_WAIT_MS,
            sessionState: buildRemoteSessionState(),
          };
        }
        for (let i = 0; i < step.count; i++) expanded.push({ key: execKey });
      }
      const baseArgs = context.sshTarget ? { sshTarget: context.sshTarget } : {};
      try {
        const execRes = expanded.length === 1
          ? await actionExecutor('press', { ...baseArgs, key: expanded[0].key }, context)
          : await actionExecutor('sequence', { ...baseArgs, keys: expanded }, context);
        initialIrResult = execRes?.data ?? null;
        initialSpeech = `已进入电视遥控模式，并已按${formatStepsSpeech(entryCheck.initialSteps)}。`;
      } catch (err) {
        initialSpeech = `已进入电视遥控模式，但执行初始按键失败：${errMsg(err)}`;
      }
    }
    return {
      handled: true,
      action: 'tv_remote_enter',
      speech: initialSpeech || '已进入电视遥控模式，请直接说按键指令，如向左两下、确认、返回。说好了或退出即可结束。',
      followUp: true,
      followUpWaitMs: TV_REMOTE_FOLLOW_UP_WAIT_MS,
      sessionState: buildRemoteSessionState(),
      data: {
        enteredRemoteMode: true,
        ...(entryCheck.initialSteps.length > 0 ? { steps: entryCheck.initialSteps, irResult: initialIrResult } : {}),
      },
    };
  }

  // 4. Direct TV power on/off ("打开电视" / "关闭电视"): prefer tv-agent power when available, fallback to IR.
  const powerIntent = parseTvPowerPhrase(cleaned);
  if (powerIntent) {
    const agentAttempt = await tryTvAgentPower(powerIntent.state, context);
    if (agentAttempt.used) {
      const res = agentAttempt.result;
      return {
        handled: true,
        action: 'tv_remote_power',
        speech: res.message || (powerIntent.state === 'on' ? '电视已打开。' : '电视已关闭。'),
        ...(inRemoteMode
          ? {
              followUp: true,
              followUpWaitMs: TV_REMOTE_FOLLOW_UP_WAIT_MS,
              sessionState: buildRemoteSessionState(),
            }
          : { followUp: false }),
        data: {
          backend: 'tv-agent',
          state: powerIntent.state,
          tvAgentResult: res.data ?? null,
          extendTtl: true,
        },
      };
    }

    if (typeof actionExecutor === 'function') {
      try {
        const irRes = await actionExecutor(
          'press',
          {
            key: 'power',
            ...(context.sshTarget ? { sshTarget: context.sshTarget } : {}),
          },
          context,
        );
        return {
          handled: true,
          action: 'tv_remote_power',
          speech: powerIntent.state === 'on' ? '已发送电视电源红外指令。' : '已发送电视关机红外指令。',
          ...(inRemoteMode
            ? {
                followUp: true,
                followUpWaitMs: TV_REMOTE_FOLLOW_UP_WAIT_MS,
                sessionState: buildRemoteSessionState(),
              }
            : { followUp: false }),
          data: {
            backend: 'tv-ir',
            fallbackReason: agentAttempt.reason,
            state: powerIntent.state,
            irResult: irRes.data ?? null,
            extendTtl: true,
          },
        };
      } catch (err) {
        return {
          handled: true,
          action: 'tv_remote_power',
          ok: false,
          speech: `电视电源控制失败：${errMsg(err)}`,
          ...(inRemoteMode
            ? {
                followUp: true,
                followUpWaitMs: TV_REMOTE_FOLLOW_UP_WAIT_MS,
                sessionState: buildRemoteSessionState(),
              }
            : { followUp: false }),
        };
      }
    }
  }

  // 5. Parse key / sequence commands (with learned keys and in-mode homophone recovery).
  const parsed = parseTvRemoteStepsPhrase(cleaned, learnedKeys, {
    allowFuzzyHomophones: inRemoteMode,
  });
  if (parsed && (inRemoteMode || parsed.hasTvContext)) {
    const keepInMode = inRemoteMode
      ? {
          followUp: true,
          followUpWaitMs: TV_REMOTE_FOLLOW_UP_WAIT_MS,
          sessionState: buildRemoteSessionState(),
        }
      : { followUp: false };

    // Handle single unlearned mute/unmute cleanly via tv-agent fallback or friendly hint.
    if (parsed.steps.length === 1 && (parsed.steps[0].key === 'mute' || parsed.steps[0].key === 'unmute')) {
      const step = parsed.steps[0];
      const hasLearnedMute = isKeySupported('mute', learnedKeys);
      if (!hasLearnedMute) {
        const isUnmute = step.key === 'unmute';
        const muteAgent = await tryTvAgentMute(!isUnmute, context);
        if (muteAgent.used) {
          return {
            handled: true,
            action: 'tv_remote_key',
            ok: true,
            speech: inRemoteMode ? '' : (isUnmute ? '已取消电视静音。' : '电视已静音。'),
            ...keepInMode,
            data: {
              backend: 'tv-agent',
              steps: parsed.steps,
              suppressSpeech: inRemoteMode,
              recordTurn: !inRemoteMode,
              extendTtl: true,
            },
          };
        }
        return {
          handled: true,
          action: 'tv_remote_key',
          ok: false,
          speech: '电视静音按键暂未学习红外码，请先使用 learn 动作学习 mute 按键或配置电视 Agent。',
          ...keepInMode,
          data: { backend: 'tv-ir', steps: parsed.steps, unlearnedKey: 'mute', extendTtl: true },
        };
      }
    }

    // Check any unlearned custom/un-preset keys (e.g. "source") before invoking executor so we fail safely.
    const unlearned = parsed.steps.find(step => !isKeySupported(step.key === 'unmute' ? 'mute' : step.key, learnedKeys));
    if (unlearned) {
      const targetKey = unlearned.key === 'unmute' ? 'mute' : unlearned.key;
      return {
        handled: true,
        action: 'tv_remote_key',
        ok: false,
        speech: `按键「${unlearned.label}」(${targetKey}) 暂未学习红外码，请先使用 learn 动作学习后再控制。`,
        ...keepInMode,
        data: { backend: 'tv-ir', steps: parsed.steps, unlearnedKey: targetKey, extendTtl: true },
      };
    }

    if (typeof actionExecutor !== 'function') {
      return { handled: false };
    }
    const expanded = [];
    for (const step of parsed.steps) {
      const execKey = step.key === 'unmute' ? 'mute' : step.key;
      for (let i = 0; i < step.count; i++) {
        expanded.push({ key: execKey });
      }
    }
    const baseArgs = context.sshTarget ? { sshTarget: context.sshTarget } : {};
    try {
      const execResult = expanded.length === 1
        ? await actionExecutor('press', { ...baseArgs, key: expanded[0].key }, context)
        : await actionExecutor('sequence', { ...baseArgs, keys: expanded }, context);

      const stepOk = execResult?.ok !== false;
      // Docs contract: continuous TV remote mode suppresses TTS on key execution (zero-TTS passthrough).
      const speech = inRemoteMode && stepOk ? '' : (stepOk ? `已按${formatStepsSpeech(parsed.steps)}。` : (execResult?.message || '电视按键发送失败。'));

      return {
        handled: true,
        action: 'tv_remote_key',
        ok: stepOk,
        speech,
        ...keepInMode,
        data: {
          backend: 'tv-ir',
          steps: parsed.steps,
          irResult: execResult?.data ?? null,
          suppressSpeech: inRemoteMode && stepOk,
          recordTurn: !inRemoteMode,
          extendTtl: true,
        },
      };
    } catch (err) {
      return {
        handled: true,
        action: 'tv_remote_key',
        ok: false,
        speech: `电视遥控发送失败：${errMsg(err)}`,
        ...keepInMode,
        data: { backend: 'tv-ir', steps: parsed.steps, error: errMsg(err), extendTtl: true },
      };
    }
  }

  // 6. While in continuous remote mode: explicit wake yields to normal chat; un-woken noise keeps listening without extending TTL.
  if (inRemoteMode) {
    if (request?.explicitWake) {
      return { handled: false };
    }
    if (!cleaned || FILLER_NOISE_RE.test(cleaned) || cleaned.length <= 24) {
      return {
        handled: true,
        action: 'voice_fastpath_ignored',
        speech: '',
        followUp: true,
        followUpWaitMs: TV_REMOTE_FOLLOW_UP_WAIT_MS,
        sessionState: buildRemoteSessionState(),
        data: {
          suppressSpeech: true,
          extendTtl: false,
          recordTurn: false,
          ledRefreshed: false,
          ignoredNoise: true,
        },
      };
    }
  }

  return { handled: false };
}

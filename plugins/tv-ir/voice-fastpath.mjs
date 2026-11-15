import { dirname, join } from 'node:path';
import {
  errMsg,
  readJsonSafe,
  resolvePluginPaths,
} from '../_shared/config-store.mjs';

export const TV_REMOTE_IDLE_TTL_MS = 60_000;
export const TV_REMOTE_FOLLOW_UP_WAIT_MS = 3_500;
export const MAX_COUNT_PER_STEP = 10;
export const MAX_TOTAL_PRESSES = 20;

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
  ['取消静音', 'mute', '静音'],
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
  ['方向上', 'up', '上'],
  ['方向下', 'down', '下'],
  ['方向左', 'left', '左'],
  ['方向右', 'right', '右'],
  ['上一级', 'back', '返回'],
  ['回主页', 'home', '主页'],
  ['回桌面', 'home', '主页'],
  ['主界面', 'home', '主页'],
  ['信号源', 'source', '信号源'],
  ['输入源', 'source', '信号源'],
  ['开关机', 'power', '电源'],
  ['点确认', 'ok', '确认'],
  ['点确定', 'ok', '确认'],
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

const ENTRY_MODE_RE = /^(?:帮我|请|麻烦|我想|我要|现在)?(?:进入|开启|打开|切到|切换到|用)(?:一下)?(?:电视)?遥控(?:器)?(?:模式)?$|^电视遥控(?:模式)?$|^遥控电视$/i;
const EXIT_MODE_RE = /^(?:帮我|请|麻烦)?(?:退出|关闭|结束|停止|取消)(?:一下)?(?:电视)?遥控(?:器)?(?:模式)?$|^不用遥控了$|^不用了$|^退出$/i;
const FILLER_NOISE_RE = /^[嗯啊哦呃唔唉喂哈呀呢嘛吧]+$/;
const TV_POWER_RE = /^(?:(?:帮我|请|麻烦|现在|立即|马上|先)?(?:把)?电视(?:机)?(打开|开启|开一下|开机|关闭|关掉|关了|关机)|(打开|开启|开一下|关闭|关掉|关了)电视(?:机)?)(?:吧|一下|咯|了)?$/;
const TV_POWER_SHORT_RE = /^(开|关)电视(?:吧|一下)?$/;

function stripWakeAndPunct(raw) {
  let text = String(raw || '').trim();
  text = text.replace(/^(?:小爱同学|小爱)[,，。!！?？\s]*/i, '');
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
  const text = String(assistantReply || '').trim();
  if (!text) return false;
  if (/已?(?:进入|开启|切换到|处于).{0,10}(?:电视)?遥控(?:器)?模式/.test(text)) {
    return true;
  }
  if (/请直接说.{0,12}(?:遥控|按键)指令/.test(text)) {
    return true;
  }
  return false;
}

/**
 * Parse a phrase into ordered IR remote `{ key, label, count }` steps.
 * Returns null if the phrase contains unknown non-filler tokens.
 * @param {string} rawPhrase
 * @returns {{ steps: Array<{ key: string, label: string, count: number }>, hasTvContext: boolean } | null}
 */
export function parseTvRemoteStepsPhrase(rawPhrase) {
  let text = stripWakeAndPunct(rawPhrase);
  if (!text) return null;

  let hasTvContext = /(?:电视机?|遥控器?)/.test(text);

  // Strip polite prefixes & TV noun wrappers while preserving order of key tokens.
  text = text
    .replace(/^(?:请问|请|麻烦|能不能|可以|帮我|给我|把|用|对着)+/g, '')
    .replace(/(?:帮我|给我|请|麻烦)?(?:按一下|按|点击|点一下|按下)?(?:电视机?|遥控器?)(?:的)?/g, (full) => {
      hasTvContext = true;
      return full.includes('按') ? ' ' : ' ';
    })
    .replace(/(?:按一下|按下|按|点击|点一下|调一下|切换到|切换到|切到|打开)/g, ' ')
    .replace(/(?:然后|接着|之后|再|还有|并且|以及|和|跟|,|，|、|;|；)/g, ' ')
    .replace(/(?:键|按钮|按键)(?=\s|$|[0-9一两二三四五六七八九十]+[下遍次])/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return null;

  const lower = text.toLowerCase();
  /** @type {Array<{ key: string, label: string, count: number }>} */
  const steps = [];
  let totalPresses = 0;
  let pos = 0;

  while (pos < lower.length) {
    while (pos < lower.length && (lower[pos] === ' ' || lower[pos] === '的' || lower[pos] === '下')) {
      pos++;
    }
    if (pos >= lower.length) break;

    let matched = false;
    for (const [alias, canonical, label] of VOICE_KEY_PATTERNS) {
      if (!lower.startsWith(alias, pos)) continue;
      // Avoid splitting ASCII identifiers mid-word.
      const prevCh = pos > 0 ? lower[pos - 1] : '';
      const nextCh = pos + alias.length < lower.length ? lower[pos + alias.length] : '';
      if (/^[a-z0-9_+-]+$/.test(alias)) {
        if ((prevCh && /[a-z0-9_]/.test(prevCh)) || (nextCh && /[a-z0-9_]/.test(nextCh))) {
          continue;
        }
      }

      pos += alias.length;
      while (pos < lower.length && lower[pos] === ' ') pos++;

      let count = 1;
      const countMatch = lower
        .slice(pos)
        .match(/^([0-9]{1,2}|[一两二三四五六七八九十])(?:\s*)(?:下|次|遍|格|步)?/);
      if (countMatch) {
        const parsedCount = parseVoiceCount(countMatch[1]);
        if (parsedCount === null) return null;
        count = parsedCount;
        pos += countMatch[0].length;
      } else if (lower.startsWith('一下', pos)) {
        pos += 2;
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

/**
 * Inspect whether tv-agent has a configured `tvHost` under the active home/plugin root.
 * @param {{ homeDir: string, dataDir: string }} paths
 * @returns {boolean}
 */
function isTvAgentConfigured(paths) {
  const candidates = [
    join(paths.homeDir, 'plugins', 'tv-agent', 'config.json'),
    join(dirname(paths.dataDir), 'tv-agent', 'config.json'),
  ];
  for (const cfgPath of candidates) {
    const cfg = readJsonSafe(cfgPath, null);
    if (cfg && typeof cfg.tvHost === 'string' && cfg.tvHost.trim().length > 0) {
      return true;
    }
  }
  return false;
}

async function tryTvAgentPower(state, context, paths) {
  if (!isTvAgentConfigured(paths) || typeof context?.callPlugin !== 'function') {
    return { used: false, reason: 'tv-agent unconfigured' };
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

/**
 * Handle TV remote voice fastpath and continuous remote mode.
 * @param {import('../_shared/types.d.ts').VoiceFastpathRequest} request
 * @param {import('../_shared/types.d.ts').PluginActionContext & { sshTarget?: string }} [context]
 * @param {(action: string, args: Record<string, any>, ctx?: any) => Promise<import('../_shared/types.d.ts').PluginActionResult>} [actionExecutor]
 * @returns {Promise<import('../_shared/types.d.ts').VoiceFastpathResult>}
 */
export async function handleTvIrVoiceFastpath(request, context = {}, actionExecutor) {
  const paths = resolvePluginPaths('tv-ir', context);
  const sessionState = request?.sessionState && typeof request.sessionState === 'object'
    ? request.sessionState
    : null;

  // 1. Assistant reply activation hook from XiaoAi router.
  if (sessionState?.event === 'assistant_reply') {
    if (isAssistantTvRemoteActivation(sessionState.assistantReply)) {
      return {
        handled: true,
        followUp: true,
        followUpWaitMs: TV_REMOTE_FOLLOW_UP_WAIT_MS,
        sessionState: buildRemoteSessionState(),
        data: { suppressSpeech: true, activatedByAssistantReply: true },
      };
    }
    return { handled: false };
  }

  const inRemoteMode = Boolean(sessionState?.tvRemoteActive || sessionState?.continuous);
  const cleaned = stripWakeAndPunct(request?.text);

  // 2. Exit remote mode.
  if (inRemoteMode && EXIT_MODE_RE.test(cleaned)) {
    return {
      handled: true,
      speech: '已退出电视遥控模式。',
      clearSessionState: true,
      followUp: false,
      sessionState: null,
      data: { exitedRemoteMode: true },
    };
  }

  // 3. Explicit entry into TV remote mode.
  if (ENTRY_MODE_RE.test(cleaned)) {
    return {
      handled: true,
      speech: '已进入电视遥控模式，请直接说按键指令，如向左两下、确认、返回。说退出即可结束。',
      followUp: true,
      followUpWaitMs: TV_REMOTE_FOLLOW_UP_WAIT_MS,
      sessionState: buildRemoteSessionState(),
      data: { enteredRemoteMode: true },
    };
  }

  // 4. Direct TV power on/off ("打开电视" / "关闭电视"): prefer tv-agent power when configured.
  const powerIntent = parseTvPowerPhrase(cleaned);
  if (powerIntent) {
    const agentAttempt = await tryTvAgentPower(powerIntent.state, context, paths);
    if (agentAttempt.used) {
      const res = agentAttempt.result;
      return {
        handled: true,
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
    }
  }

  // 5. Parse key / sequence commands.
  const parsed = parseTvRemoteStepsPhrase(cleaned);
  if (parsed && (inRemoteMode || parsed.hasTvContext)) {
    if (typeof actionExecutor !== 'function') {
      return { handled: false };
    }
    const expanded = [];
    for (const step of parsed.steps) {
      for (let i = 0; i < step.count; i++) {
        expanded.push({ key: step.key });
      }
    }
    const baseArgs = context.sshTarget ? { sshTarget: context.sshTarget } : {};
    const execResult = expanded.length === 1
      ? await actionExecutor('press', { ...baseArgs, key: expanded[0].key }, context)
      : await actionExecutor('sequence', { ...baseArgs, keys: expanded }, context);

    return {
      handled: true,
      speech: `已按${formatStepsSpeech(parsed.steps)}。`,
      ...(inRemoteMode
        ? {
            followUp: true,
            followUpWaitMs: TV_REMOTE_FOLLOW_UP_WAIT_MS,
            sessionState: buildRemoteSessionState(),
          }
        : { followUp: false }),
      data: {
        backend: 'tv-ir',
        steps: parsed.steps,
        irResult: execResult.data ?? null,
        extendTtl: true,
      },
    };
  }

  // 6. While in continuous remote mode: explicit wake yields to normal chat; un-woken noise keeps listening without extending TTL.
  if (inRemoteMode) {
    if (request?.explicitWake) {
      return { handled: false };
    }
    if (!cleaned || FILLER_NOISE_RE.test(cleaned) || cleaned.length <= 24) {
      return {
        handled: true,
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

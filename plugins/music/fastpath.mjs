const ASR_TAG_RE = /<\|[^|]*\|>/g;
const ASSISTANT_WAKE_PREFIX_RE = /^(?:(?:小爱同学|小爱|(?:(?:你好|您好|嗨|嘿|喂|诶|唉|欸|黑|呼叫)\s*(?:星期[五武午舞屋吾无物务]|新期[五武午舞吾无]|心期[五武午舞吾无]|星[七奇期][五武午舞]|行期[五武午舞]|星期的五|friday)|(?:星期五|friday))(?=$|[\s，,。！!？?、：:]))[\s，,。！!？?、：:]*)+/i;
const TRAILING_PUNCT_RE = /[。！!？?，,、；;\s]+$/g;
const MAX_UTTERANCE_CHARS = 60;

const OTHER_DOMAIN_RE = /电视|投影|遥控|频道|电影|电视剧|动画|空调|灯|插座|开关|牙刷|体脂|体重|鱼缸|基金|九号|电动车|苹果|iphone|ipad|mac|watch|airpods/i;
const DOWNLOAD_SEARCH_RE = /下载|搜一首|搜一曲|搜一下|搜索|帮我找/;
const COMPLEX_RE = /如果|要是|假如|顺便|然后|并且|接着|同时|微信|网页|发给|报告|为什么|怎么回事|怎么办|配置|设置|删除|删掉/;
const DELAYED_RE = /(?:\d+|[一二两三四五六七八九十半]+)\s*(?:秒钟?|分钟|分|小时|钟头|个?小时|刻钟)(?:之?后|以后|后)|(?:稍后|待会|等会|等一?[会下]|过一?会|一会儿?[之以]?后|定时|预约|提醒|每天|每晚|明早|明天|今晚|\d+\s*点|[一二两三四五六七八九十]+点)/;
const NEGATION_RE = /别|不要|不用|不能|不可以|勿|切莫|休想|没让你|没叫你/;

const STOP_RE = /^(?:(?:停止|关闭|关掉|停掉|结束)(?:放歌|播放|放音乐|音乐)|(?:别|不要)(?:放歌|播放|放音乐|音乐|放|唱)(?:了)?|停下音乐|音乐关闭|音乐停止)$/;
const PAUSE_RE = /^(?:暂停|先暂停|暂停播放|暂停音乐|暂停放歌|音乐暂停)$/;
const RESUME_RE = /^(?:继续|恢复)(?:播放|放歌|听歌|音乐)$/;
const NEXT_RE = /^(?:下[一1](?:首|曲)|切歌|换[一1]?(?:首|曲)(?:歌)?|跳到下[一1]首|切下一首)$/;
const PREV_RE = /^(?:上[一1](?:首|曲)|返回上[一1]首|切回上[一1]首)$/;
const GENERIC_PLAY_RE = /^(?:放首歌|放一首歌|放点?音乐|放点?歌|播放音乐|来首歌|听歌|随便放[一]?首歌|随便放点歌|随机放歌|随机播放音乐|放歌吧|放音乐|播放歌曲)$/;
const FAVORITES_PLAY_RE = /^(?:播放|放一下|放一首|听|放)(?:歌单|列表)?[《「]?(?:我喜欢的音乐|收藏|红心)[》」]?$/;
const SPECIFIC_PLAY_RE = /^(?:帮我)?(?:播放|放一首|放首|放一下|来一首|来首|我想听|我要听|听一首|听一下|点一首|点播|放|听)\s*(.+)$/;
const STATUS_RE = /^(?:现在|当前)?(?:放的|播放的|在放)(?:是)?什么歌$|^这首歌叫什么(?:名字)?$|^现在在放什么$|^曲库有(?:多少|几)首歌$/;

const TIMER_CANCEL_RE = /^(?:取消|关闭|删掉)(?:音乐|放歌)?(?:睡眠)?定时$/;
const TIMER_MIN_RE = /^(?:(?:音乐|放歌)?定时\s*([0-9一二两三四五六七八九十百半]+)\s*(分钟|分|小时|个小时)(?:关闭|停止|关掉)?|([0-9一二两三四五六七八九十百半]+)\s*(分钟|分|小时|个小时)(?:之?后|以后)(?:关闭|停止|关掉)(?:音乐|放歌|播放))$/;

const VOLUME_SET_RE = /^(?:把)?(?:音乐|小爱)?(?:音量|声音)(?:调到|调至|设为|设置成|调整到|开到|改成)\s*([0-9一二三四五六七八九十百]+)%?$/;
const VOLUME_DELTA_RE = /^(?:(?:把)?(?:音乐|声音)(?:调|开|弄)?(大|高|小|低)(?:一?[点些])?|(?:大声|小声)(?:一?[点些]))$/;

const LOOP_MAP = new Map([
  ['单曲循环', 'single'],
  ['列表循环', 'list'],
  ['顺序循环', 'list'],
  ['循环播放', 'list'],
  ['随机播放', 'shuffle'],
  ['随机循环', 'shuffle'],
  ['乱序播放', 'shuffle'],
  ['单次播放', 'once'],
  ['顺序播放', 'once'],
]);

const NON_MUSIC_PLAY_NOUN_RE = /^(?:声音|提示音|闹钟|广播|新闻|相声|评书|故事|视频|电影|电视|动画片|儿歌视频)$/;

/**
 * @param {string} raw
 * @returns {number | undefined}
 */
function parseSimpleCnNumber(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '半') return 0.5;
  const digits = new Map([['零', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9]]);
  if (s === '十') return 10;
  if (s === '一百' || s === '百') return 100;
  if (s.startsWith('十') && s.length === 2 && digits.has(s[1])) {
    return 10 + (digits.get(s[1]) ?? 0);
  }
  if (s.endsWith('十') && s.length === 2 && digits.has(s[0])) {
    return (digits.get(s[0]) ?? 0) * 10;
  }
  if (s.length === 3 && s[1] === '十' && digits.has(s[0]) && digits.has(s[2])) {
    return (digits.get(s[0]) ?? 0) * 10 + (digits.get(s[2]) ?? 0);
  }
  if (s.length === 1 && digits.has(s)) return digits.get(s);
  return undefined;
}

/**
 * @param {string} raw
 * @returns {string}
 */
function cleanUtterance(raw) {
  let out = String(raw ?? '').replace(ASR_TAG_RE, '').trim();
  out = out.replace(ASSISTANT_WAKE_PREFIX_RE, '').trim();
  out = out.replace(TRAILING_PUNCT_RE, '').trim();
  return out;
}

/**
 * @param {string} text
 * @returns {{
 *   kind: 'stop' | 'pause' | 'resume' | 'next' | 'prev' | 'play' | 'volume' | 'loop' | 'timer' | 'status';
 *   query?: string;
 *   shuffle?: boolean;
 *   playlistId?: string;
 *   volume?: number;
 *   delta?: number;
 *   mode?: string;
 *   minutes?: number;
 *   cancel?: boolean;
 * } | undefined}
 */
export function parseMusicVoiceUtterance(text) {
  const cleaned = cleanUtterance(text);
  const compact = cleaned.replace(/\s+/g, '');
  if (!compact || compact.length > MAX_UTTERANCE_CHARS) return undefined;
  if (OTHER_DOMAIN_RE.test(compact)) return undefined;
  if (DOWNLOAD_SEARCH_RE.test(compact)) return undefined;
  if (COMPLEX_RE.test(compact)) return undefined;

  if (TIMER_CANCEL_RE.test(compact)) {
    return { kind: 'timer', cancel: true };
  }
  const timerMatch = TIMER_MIN_RE.exec(compact);
  if (timerMatch) {
    const numStr = timerMatch[1] || timerMatch[3] || '';
    const unitStr = timerMatch[2] || timerMatch[4] || '';
    const num = parseSimpleCnNumber(numStr);
    if (num !== undefined && num > 0) {
      const minutes = unitStr.includes('小时') ? Math.round(num * 60) : Math.round(num);
      return { kind: 'timer', minutes: Math.max(1, Math.min(240, minutes)) };
    }
  }

  if (DELAYED_RE.test(compact)) return undefined;
  if (STOP_RE.test(compact)) return { kind: 'stop' };
  if (NEGATION_RE.test(compact)) return undefined;

  if (PAUSE_RE.test(compact)) return { kind: 'pause' };
  if (RESUME_RE.test(compact)) return { kind: 'resume' };
  if (NEXT_RE.test(compact)) return { kind: 'next' };
  if (PREV_RE.test(compact)) return { kind: 'prev' };

  const loopMode = LOOP_MAP.get(compact);
  if (loopMode) return { kind: 'loop', mode: loopMode };

  if (STATUS_RE.test(compact)) return { kind: 'status' };

  const volSet = VOLUME_SET_RE.exec(compact);
  if (volSet) {
    const val = parseSimpleCnNumber(volSet[1] ?? '');
    if (val !== undefined) {
      return { kind: 'volume', volume: Math.max(0, Math.min(100, Math.round(val))) };
    }
  }
  const volDelta = VOLUME_DELTA_RE.exec(compact);
  if (volDelta) {
    const up = volDelta[1] === '大' || volDelta[1] === '高' || compact.includes('大声');
    return { kind: 'volume', delta: up ? 10 : -10 };
  }

  if (GENERIC_PLAY_RE.test(compact)) {
    return { kind: 'play', shuffle: true };
  }
  if (FAVORITES_PLAY_RE.test(compact)) {
    return { kind: 'play', playlistId: 'favorites' };
  }

  const spec = SPECIFIC_PLAY_RE.exec(cleaned);
  if (spec) {
    let query = String(spec[1] ?? '')
      .trim()
      .replace(/^[《「『"']+|[》」』"']+$/g, '')
      .replace(/(?:这首歌|这曲|吧|哈)$/g, '')
      .trim();
    if (!query || NON_MUSIC_PLAY_NOUN_RE.test(query)) return undefined;
    return { kind: 'play', query };
  }

  return undefined;
}

/**
 * @param {import('../_shared/types.d.ts').VoiceFastpathRequest} request
 * @param {import('../_shared/types.d.ts').PluginExecutionContext} context
 * @param {(action: string, args?: Record<string, unknown>, context?: import('../_shared/types.d.ts').PluginExecutionContext) => Promise<import('../_shared/types.d.ts').PluginActionResult>} runAction
 * @returns {Promise<import('../_shared/types.d.ts').VoiceFastpathResult>}
 */
export async function handleMusicVoiceFastpath(request, context, runAction) {
  const intent = parseMusicVoiceUtterance(request?.text ?? '');
  if (!intent) return { handled: false };

  if (intent.kind === 'stop') {
    const res = await runAction('stop', {}, context);
    return {
      handled: true,
      plugin: 'music',
      action: 'stop',
      ok: Boolean(res.ok),
      speech: res.ok ? '已停止播放' : (res.message || '停止播放失败'),
      clearSessionState: true,
      data: { recordTurn: false },
    };
  }

  if (intent.kind === 'pause') {
    const res = await runAction('pause', {}, context);
    return {
      handled: true,
      plugin: 'music',
      action: 'pause',
      ok: Boolean(res.ok),
      speech: res.ok ? '已暂停播放' : (res.message || '暂停播放失败'),
      clearSessionState: true,
      data: { recordTurn: false },
    };
  }

  if (intent.kind === 'resume') {
    const res = await runAction('resume', {}, context);
    return {
      handled: true,
      plugin: 'music',
      action: 'resume',
      ok: Boolean(res.ok),
      ...(res.ok ? {} : { speech: res.message || '当前没有暂停的音乐' }),
      clearSessionState: true,
      data: { recordTurn: false },
    };
  }

  if (intent.kind === 'next' || intent.kind === 'prev') {
    const res = await runAction(intent.kind, {}, context);
    return {
      handled: true,
      plugin: 'music',
      action: intent.kind,
      ok: Boolean(res.ok),
      ...(res.ok ? {} : { speech: res.message || '切歌失败' }),
      clearSessionState: true,
      data: { recordTurn: false },
    };
  }

  if (intent.kind === 'play') {
    const res = await runAction('play', {
      ...(intent.query ? { query: intent.query } : {}),
      ...(intent.shuffle ? { shuffle: true } : {}),
      ...(intent.playlistId ? { playlistId: intent.playlistId } : {}),
    }, context);
    if (!res.ok && res.data?.miss === true) {
      if (res.data?.autoDownloadOnVoiceMiss === true) {
        return { handled: false };
      }
      return {
        handled: true,
        plugin: 'music',
        action: 'play',
        ok: false,
        speech: intent.query
          ? `本地曲库还没找到${intent.query}，你可以说帮我下载${intent.query}`
          : '曲库还是空的，可以在网页上传或让我帮你搜歌下载',
        clearSessionState: true,
      };
    }
    return {
      handled: true,
      plugin: 'music',
      action: 'play',
      ok: Boolean(res.ok),
      ...(res.ok ? {} : { speech: res.message || '播放音乐失败' }),
      clearSessionState: true,
      data: { recordTurn: false },
    };
  }

  if (intent.kind === 'volume') {
    const res = await runAction('volume', {
      ...(intent.volume !== undefined ? { volume: intent.volume } : {}),
      ...(intent.delta !== undefined ? { delta: intent.delta } : {}),
    }, context);
    const playingNow = res.data?.status === 'playing';
    return {
      handled: true,
      plugin: 'music',
      action: 'volume',
      ok: Boolean(res.ok),
      ...(playingNow && res.ok ? {} : { speech: res.message || '音量调整失败' }),
      clearSessionState: true,
      data: { recordTurn: false },
    };
  }

  if (intent.kind === 'loop') {
    const res = await runAction('loop', { mode: intent.mode }, context);
    const playingNow = res.data?.status === 'playing';
    return {
      handled: true,
      plugin: 'music',
      action: 'loop',
      ok: Boolean(res.ok),
      ...(playingNow && res.ok ? {} : { speech: res.message || '切换循环模式失败' }),
      clearSessionState: true,
      data: { recordTurn: false },
    };
  }

  if (intent.kind === 'timer') {
    const res = await runAction('timer', {
      ...(intent.cancel ? { cancel: true } : { minutes: intent.minutes }),
    }, context);
    return {
      handled: true,
      plugin: 'music',
      action: 'timer',
      ok: Boolean(res.ok),
      speech: res.message || '定时设置完成',
      clearSessionState: true,
      data: { recordTurn: false },
    };
  }

  if (intent.kind === 'status') {
    const res = await runAction('status', { live: false }, context);
    const d = res.data || {};
    const track = d.currentTrack;
    let speech = `曲库共有 ${Number(d.trackCount ?? 0)} 首歌`;
    if (track && (d.status === 'playing' || d.status === 'paused')) {
      const prefix = d.status === 'paused' ? '当前已暂停' : '正在播放';
      const by = track.artist ? `，${track.artist}演唱` : '';
      speech = `${prefix} ${track.title}${by}`;
    } else if (track) {
      speech = `上次播放的是 ${track.title}，当前未在播放`;
    }
    return {
      handled: true,
      plugin: 'music',
      action: 'status',
      ok: true,
      speech,
      clearSessionState: true,
      data: { readonly: true },
    };
  }

  return { handled: false };
}

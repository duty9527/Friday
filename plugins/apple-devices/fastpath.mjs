const ASR_TAG_RE = /<\|[^|]*\|>/g;
const ASSISTANT_WAKE_PREFIX_RE = /^(?:(?:小爱同学|小爱|(?:(?:你好|您好|嗨|嘿|喂|诶|唉|欸|黑|呼叫)\s*(?:星期[五武午舞屋吾无物务]|新期[五武午舞吾无]|心期[五武午舞吾无]|星[七奇期][五武午舞]|行期[五武午舞]|星期的五|friday)|(?:星期五|friday))(?=$|[\s，,。！!？?、：:]))[\s，,。！!？?、：:]*)+/i;
const TRAILING_PUNCT_RE = /[。！!？?，,、；;\s]+$/g;
const MAX_UTTERANCE_CHARS = 60;

const DELAYED_RE = /(?:\d+|[一二两三四五六七八九十百半]+)\s*(?:秒钟?|分钟|分|小时|钟头|个?小时|刻钟)(?:之?后|以后|后)|(?:稍后|待会|等会|等一?[会下]|过一?会|一会儿?[之以]?后|定时|预约|提醒|每天|每晚|明早|明天|今晚|\d+\s*点|[一二两三四五六七八九十]+点)/;
const COMPLEX_RE = /如果|要是|假如|顺便|然后|并且|接着|同时|微信|网页|发给|报告|为什么|怎么回事|怎么办|绑定|登录|退出|配置|设置/;
const NEGATION_RE = /别|不要|不用|不能|不可以|勿|切莫|休想|没让你|没叫你/;
const ALLOWED_MEI_RE = /(?:充满没|还有电没|在家没|在哪|有没有电)/;

const DEVICE_TARGET_PATTERNS = [
  { re: /(?:苹果)?(?:手表|apple\s*watch|iwatch|watch)/i, target: '手表' },
  { re: /(?:airpods|苹果耳机|耳机)/i, target: '耳机' },
  { re: /(?:ipad|苹果平板|平板)/i, target: 'iPad' },
  { re: /(?:macbook|mac|imac|苹果电脑|电脑|笔记本)/i, target: 'Mac' },
  { re: /(?:iphone|苹果手机|手机)/i, target: '手机' },
];

const BATTERY_QUERY_RE = /(?:多少电|电量|还有电|剩多少电|充满没|充好了吗|充了多少|在充电吗|耗电)/i;
const ALL_BATTERY_RE = /(?:所有|全部|几个|哪些)?(?:苹果设备|设备|apple设备).*(?:电量|多少电)|(?:电量|多少电).*(?:苹果设备|全部设备)/i;
const PLAY_SOUND_RE = /(?:(?:找一下|找找|呼叫|响一下|响铃|播放提示音|响铃定位|beep|ping).*(?:iphone|ipad|mac|apple\s*watch|airpods|苹果手机|手机|平板|手表|耳机|电脑))|(?:(?:iphone|ipad|mac|apple\s*watch|airpods|苹果手机|手机|平板|手表|耳机|电脑).*(?:响一下|响铃|播放提示音|放声音|叫一下))/i;
const LOCATION_QUERY_RE = /(?:iphone|ipad|mac|apple\s*watch|airpods|苹果手机|手机|平板|手表|电脑).*(?:在哪|在哪里|在什么地方|在什么位置|在家吗|在家没|位置在哪)|(?:哪儿|哪里).*(?:iphone|ipad|apple\s*watch|苹果手机|手机|平板|手表)/i;

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
 * @param {string} compact
 * @returns {boolean}
 */
function shouldBailOut(compact) {
  if (!compact || compact.length > MAX_UTTERANCE_CHARS) return true;
  if (DELAYED_RE.test(compact) || COMPLEX_RE.test(compact)) return true;
  if (NEGATION_RE.test(compact)) return true;
  if (compact.includes('没') && !ALLOWED_MEI_RE.test(compact)) return true;
  return false;
}

/**
 * @param {string} text
 * @returns {string | undefined}
 */
function extractDeviceTarget(text) {
  for (const { re, target } of DEVICE_TARGET_PATTERNS) {
    if (re.test(text)) return target;
  }
  return undefined;
}

/**
 * @param {string} text
 * @returns {{ kind: 'battery_all' | 'battery_one' | 'play_sound' | 'locate'; target?: string; refresh: boolean } | undefined}
 */
export function parseAppleVoiceUtterance(text) {
  const cleaned = cleanUtterance(text);
  const compact = cleaned.replace(/\s+/g, '');
  if (shouldBailOut(compact)) return undefined;

  const refresh = /(?:实时|最新|刷新|现在|重新)/.test(compact);
  const target = extractDeviceTarget(cleaned);

  if (PLAY_SOUND_RE.test(cleaned)) {
    return { kind: 'play_sound', target: target ?? '手机', refresh: false };
  }
  if (ALL_BATTERY_RE.test(cleaned)) {
    return { kind: 'battery_all', refresh };
  }
  if (BATTERY_QUERY_RE.test(cleaned) && target) {
    return { kind: 'battery_one', target, refresh };
  }
  if (LOCATION_QUERY_RE.test(cleaned) && target) {
    return { kind: 'locate', target, refresh };
  }
  return undefined;
}

/**
 * @param {any} dev
 * @returns {string}
 */
function formatBatterySpeech(dev) {
  const name = dev?.name || dev?.displayName || '设备';
  const pct = typeof dev?.batteryPercent === 'number' ? `电量 ${dev.batteryPercent}%` : '暂无电量读数';
  const chargeText = dev?.batteryStatus === 'Charging'
    ? '，正在充电'
    : dev?.batteryStatus === 'Charged'
      ? '，已充满'
      : '';
  return `${name}${pct}${chargeText}`;
}

/**
 * Fastpath entry for XiaoAI / IM quick voice commands targeting Apple devices.
 * Restricted to owner role via host allowlist (not in member plugin allowlist).
 * @param {import('../_shared/types.d.ts').VoiceFastpathRequest} request
 * @param {import('../_shared/types.d.ts').PluginExecutionContext} context
 * @param {(action: string, args?: Record<string, unknown>, deps?: Record<string, unknown>) => Promise<import('../_shared/types.d.ts').PluginActionResult>} runAction
 * @returns {Promise<import('../_shared/types.d.ts').VoiceFastpathResult>}
 */
export async function handleAppleVoiceFastpath(request, context, runAction) {
  const intent = parseAppleVoiceUtterance(request?.text ?? '');
  if (!intent) {
    return { handled: false };
  }

  if (intent.kind === 'play_sound') {
    const res = await runAction('play-sound', { device: intent.target }, context);
    return {
      handled: true,
      plugin: 'apple-devices',
      action: 'play-sound',
      ok: Boolean(res.ok),
      speech: res.ok ? `好的，已让${res.data?.device?.name || intent.target}播放查找提示音。` : (res.message || '发送响铃指令失败。'),
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }

  if (intent.kind === 'battery_all') {
    const res = await runAction('devices', { refresh: intent.refresh }, context);
    if (!res.ok) {
      return {
        handled: true,
        plugin: 'apple-devices',
        action: 'devices',
        ok: false,
        speech: res.message || '暂时无法获取苹果设备电量。',
        followUp: false,
        clearSessionState: true,
        data: res.data,
      };
    }
    const list = Array.isArray(res.data?.devices) ? res.data.devices : [];
    const summary = list.length > 0
      ? list.slice(0, 5).map(formatBatterySpeech).join('；')
      : '当前账号下没有查询到苹果设备。';
    return {
      handled: true,
      plugin: 'apple-devices',
      action: 'devices',
      ok: true,
      speech: summary,
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }

  const res = await runAction('locate', { device: intent.target, refresh: intent.refresh }, context);
  if (!res.ok) {
    return {
      handled: true,
      plugin: 'apple-devices',
      action: 'locate',
      ok: false,
      speech: res.message || `查询${intent.target}状态失败。`,
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }
  const dev = res.data?.device;
  if (!dev) {
    return {
      handled: true,
      plugin: 'apple-devices',
      action: 'locate',
      ok: false,
      speech: `没有找到${intent.target}。`,
      followUp: false,
      clearSessionState: true,
    };
  }
  if (intent.kind === 'battery_one') {
    return {
      handled: true,
      plugin: 'apple-devices',
      action: 'locate',
      ok: true,
      speech: formatBatterySpeech(dev),
      followUp: false,
      clearSessionState: true,
      data: res.data,
    };
  }

  const place = dev.place;
  let locSpeech;
  if (place?.inside) {
    locSpeech = `${dev.name}目前在${place.name}附近`;
  } else if (place) {
    locSpeech = `${dev.name}当前不在${place.name}，距离约${place.distanceMeters}米`;
  } else if (dev.location) {
    locSpeech = `${dev.name}已获取最近定位（精度约${dev.location.horizontalAccuracy ?? '未知'}米）`;
  } else {
    locSpeech = `${dev.name}暂无可用定位坐标`;
  }
  const suffix = typeof dev.batteryPercent === 'number' ? `，电量${dev.batteryPercent}%。` : '。';
  return {
    handled: true,
    plugin: 'apple-devices',
    action: 'locate',
    ok: true,
    speech: `${locSpeech}${suffix}`,
    followUp: false,
    clearSessionState: true,
    data: res.data,
  };
}

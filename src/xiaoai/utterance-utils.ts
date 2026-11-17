const CHINESE_NUMERAL_DIGITS: Record<string, number> = {
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

/** Parse Arabic digits (`200`) or Chinese numerals (`两百`, `一百八十`, `二十六`, `五`, `半`). */
export function parseChineseNumber(raw: string): number | undefined {
  const s = raw.trim();
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

const ASR_TAG_RE = /<\|[^|]*\|>/g;
const LEADING_PUNCT_RE = /^[\s，,。！!？?、：:]+/;
const TRAILING_PUNCT_RE = /[。，,！!？?、；;\s]+$/g;
const NATIVE_XIAOAI_PREFIX_RE = /^(?:小爱同学[\s，,。！!？?、：:]*|小爱[\s，,。！!？?、：:]+)/i;

/** Strip SenseVoice / ASR control markers (`<|zh|>`, `<|NEUTRAL|>`, etc.). */
export function stripLeadingAsrControlTags(rawText: string): string {
  return rawText ? rawText.replace(ASR_TAG_RE, '').trim() : '';
}

export function stripTrailingPunctuation(rawText: string): string {
  return rawText.trim().replace(TRAILING_PUNCT_RE, '').trim();
}

export function hasLeadingXiaoaiWakeWord(rawText: string): boolean {
  if (!rawText) return false;
  const text = stripLeadingAsrControlTags(rawText);
  return /^(?:(?:你好|您好|嗨|嘿|喂|诶|唉|欸|黑|呼叫)\s*(?:星期五|friday)|(?:星期五|friday))[\s，,。！!？?、：:]*/i.test(text);
}

/**
 * Strip leading wake words, chime echoes (`在。`/`我在`), filler sounds (`嗯`/`呃`), and native XiaoAI handoffs.
 */
export function cleanXiaoaiAsrUtterance(rawText: string): string {
  if (!rawText) return '';
  let text = stripLeadingAsrControlTags(rawText);
  if (!text) return '';

  // User switched mid-capture to native XiaoAI: never intercept.
  if (NATIVE_XIAOAI_PREFIX_RE.test(text)) {
    return '';
  }

  text = text
    .replace(
      /^(?:(?:(?:你好|您好|嗨|嘿|喂|诶|唉|欸|黑|呼叫)\s*(?:星期[五武午舞屋吾无物务]|新期[五武午舞吾无]|心期[五武午舞吾无]|星[七奇期][五武午舞]|行期[五武午舞]|星期的五|friday)|(?:星期五|friday)|(?:星期[武午舞屋吾无物务]|新期[五武午舞吾无]|心期[五武午舞吾无]|星[七奇期][五武午舞]|行期[五武午舞]|星期的五)(?=$|[\s，,。！!？?、：:]))[\s，,。！!？?、：:]*)+/i,
      '',
    )
    .trim();

  if (/^(?:在|我在|诶)[。，,！!？?\s]*$/.test(text)) {
    return '';
  }
  text = text.replace(/^(?:在|我在)[，,。！!？?]+\s*/, '').trim();

  const bare = text.replace(/[。，,！!？?、：:；;\s."'`~—\-()（）【】《》]+/g, '');
  if (!bare || /^(?:嗯+|啊+|哦+|呃+|哈+|噢+|诶+)$/.test(bare)) {
    return '';
  }
  return text;
}

export function extractLeadingXiaoaiWakeKeyword(
  rawText: string,
): { keyword: string; remainder: string } | undefined {
  if (!rawText) return undefined;
  const text = stripLeadingAsrControlTags(rawText).replace(LEADING_PUNCT_RE, '').trim();
  if (!text) return undefined;

  const m = text.match(
    /^(?:(你好|您好|嗨|嘿|喂|诶|唉|欸|黑|呼叫)\s*)?(?:(星期五|friday)|(星期[武午舞屋吾无物务]|新期[五武午舞吾无]|心期[五武午舞吾无]|星[七奇期][五武午舞]|行期[五武午舞]|星期的五))([\s\S]*)$/i,
  );
  if (!m) return undefined;

  const prefix = m[1];
  const exactCore = m[2];
  const afterRaw = (m[4] ?? '').replace(LEADING_PUNCT_RE, '');
  const remainder = cleanXiaoaiAsrUtterance(afterRaw);

  if (!exactCore && !prefix && remainder) {
    return undefined;
  }

  let keyword = '星期五';
  if (prefix === '你好' || prefix === '您好') keyword = '你好星期五';
  else if (prefix === '嘿' || prefix === '诶' || prefix === '欸' || prefix === '黑') keyword = '嘿星期五';
  else if (prefix === '嗨' || prefix === '唉') keyword = '嗨星期五';
  else if (prefix === '喂') keyword = '喂星期五';
  else if (prefix === '呼叫') keyword = '呼叫星期五';

  return { keyword, remainder };
}

/**
 * Strip generic leading assistant wake greeting (`"你好星期五，..."` / `"小爱同学，..."`) for voice command parsers.
 */
export function stripLeadingAssistantWake(rawText: string): string {
  return stripTrailingPunctuation(
    stripLeadingAsrControlTags(rawText)
      .replace(/^(?:(?:你好|您好|嗨|嘿|喂)[，,\s]*)?(?:星期五|小爱同学?|friday)[，,。！!？?、：\s]*/i, '')
      .trim(),
  );
}

/**
 * Unified cancel-phrase recognizer shared by KWS follow-up capture and speaker enrollment cancellation.
 */
export function isXiaoaiFollowUpCancel(
  text: string,
  options?: { includeEnrollVariants?: boolean },
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return !options?.includeEnrollVariants;
  if (options?.includeEnrollVariants) {
    const cleaned = stripTrailingPunctuation(trimmed);
    if (!cleaned) return false;
    return /^(?:(?:不用了?|不要了?|算了(?:吧)?)[，,\s]*)?(?:取消|退出|算了(?:吧)?|不录了?|停止录入|取消录入|退出录入|不用了?|不要了?|没事了?|退一?下|闭嘴|结束(?:录入)?)(?:吧|呗|啦|咯|呀|啊)?$/.test(
      cleaned,
    );
  }
  return /^(?:不用了?(?:吧|呗|啦|咯|呀)?|算了?(?:吧|呗|啦|咯|呀)?|没事了?(?:吧|呗|啦|咯|呀)?|取消(?:对话)?(?:吧|呗|啦)?|退出(?:对话)?(?:吧|呗|啦)?|结束(?:对话)?(?:吧|呗|啦)?|退一?下(?:吧|呗|啦|咯|呀|啊)?|闭嘴(?:吧|呗|啦)?|没别的事了?(?:吧|呗|啦)?|先这样(?:吧|呗|啦)?)[。，,！!？?\s]*$/i.test(
    trimmed,
  );
}

const WECHAT_EMOJI_TAGS = new Set([
  '微笑', '撇嘴', '色', '发呆', '得意', '流泪', '害羞', '闭嘴', '睡', '大哭',
  '尴尬', '发怒', '调皮', '呲牙', '惊讶', '难过', '囧', '抓狂', '吐', '偷笑',
  '愉快', '白眼', '傲慢', '困', '惊恐', '憨笑', '悠闲', '咒骂', '疑问', '嘘',
  '晕', '衰', '骷髅', '敲打', '再见', '擦汗', '抠鼻', '鼓掌', '坏笑', '右哼哼',
  '左哼哼', '鄙视', '委屈', '快哭了', '阴险', '亲亲', '可怜', '笑脸', '生病', '脸红',
  '破涕为笑', '恐惧', '失望', '无语', '嘿哈', '捂脸', '奸笑', '机智', '皱眉', '耶',
  '吃瓜', '加油', '汗', '天啊', 'emm', '社会社会', '旺柴', '好的', '打脸', '哇',
  '翻白眼', '666', '让我看看', '叹气', '苦涩', '裂开', '嘴唇', '爱心', '心碎', '拥抱',
  '强', '弱', '握手', '胜利', '抱拳', '勾引', '拳头', 'ok', '合十', '啤酒',
  '咖啡', '蛋糕', '玫瑰', '凋谢', '菜刀', '西瓜', '炸弹', '便便', '月亮', '太阳',
  '庆祝', '礼物', '红包', '發', '福', '烟花', '爆竹', '猪头', '跳跳', '发抖',
  '转圈', '磕头', '回头', '跳绳', '激动', '街舞', '献吻', '左太极', '右太极', '哈欠',
  '吓', '酷', '饥饿', '疯了', '闪电', '刀', '足球', '饭', '示爱', '爱你', 'no',
  '差劲', '敬礼', '笑哭', '点赞', '比心', '大笑', '开心', '哭笑', '流汗', '斜眼笑',
  '狗头',
]);

const NATIVE_CONTROL_PATTERNS: RegExp[] = [
  /^(?:请)?(?:闭嘴|退下|停止(?:播放)?|暂停(?:播放)?|继续(?:播放)?|恢复播放|下一[首曲集]|上一[首曲集]|切歌|关机|静音|取消静音|打开静音)(?:吧|呗|啦|咯|呀|一下)?$/,
  /^(?:请|帮我|把)?(?:打开|关闭|关掉|开启|调亮|调暗).{1,15}(?:灯|空调|风扇|窗帘|插座|电视|加湿器|净化器|除湿机|扫地机|开关)(?:吧|啦|一下)?$/,
  /^(?:把)?(?:音量|声音).{0,8}(?:调?[大小高低]|加|减)(?:[一]?点(?:儿)?|些|一些)?$/,
  /^(?:把)?(?:音量|声音)(?:调到|设为|设置成?|调成)?\s*\d{1,3}%?$/,
  /^(?:调[大小高低]|增大|减小|加大|降低)(?:一下|一点)?(?:音量|声音)$/,
  /^(?:再)?(?:大声|小声)[一]?点(?:儿)?$/,
  /^(?:最大|最小)(?:音量|声音)$/,
  /^(?:帮我)?(?:定|设|设置|建|添加|取消|关闭|删除|关掉)(?:一个|个)?.{0,14}闹钟$/,
  /^(?:定|设|设置|取消|关闭|删除)闹钟$/,
];

function splitKeepingDelimiters(text: string, pattern: RegExp): string[] {
  const matches = text.match(pattern);
  if (!matches) return [];
  return matches.map(part => part.trim()).filter(Boolean);
}

export function stripXiaoaiDialogDirective(text: string): {
  text: string;
  directive?: 'listen' | 'end';
} {
  if (!text) return { text: '' };
  let directive: 'listen' | 'end' | undefined;
  const directiveRe =
    /\s*(?:\[\s*\[\s*(LISTEN|CONTINUE_DIALOG|END|END_DIALOG)\s*\]\s*\]|【\s*(?:【|\[)?\s*(LISTEN|CONTINUE_DIALOG|END|END_DIALOG)\s*(?:】|\])?\s*】|\[\s*(LISTEN|CONTINUE_DIALOG|END|END_DIALOG)\s*\](?!\s*[(\[]))\s*/gi;
  const stripped = text
    .replace(
      directiveRe,
      (
        fullMatch: string,
        dblTag: string | undefined,
        fwTag: string | undefined,
        sglTag: string | undefined,
        offset: number,
        fullStr: string,
      ) => {
        const rawTag = dblTag ?? fwTag ?? sglTag ?? '';
        const upper = rawTag.toUpperCase();
        if (sglTag && upper !== 'CONTINUE_DIALOG' && upper !== 'END_DIALOG') {
          const isExactUppercase = sglTag === upper;
          const after = fullStr.slice(offset + fullMatch.length);
          const isAtTail = /^[。！!？?.,;；\s]*$/.test(after);
          if (!isExactUppercase && !isAtTail) {
            return fullMatch;
          }
        }
        directive = upper.startsWith('LISTEN') || upper.startsWith('CONTINUE') ? 'listen' : 'end';
        return '';
      },
    )
    .trim();
  return { text: stripped, ...(directive ? { directive } : {}) };
}

const IMMEDIATE_SPEAK_INVITE_RE =
  /(?:(?:要|想|还要|还想)(?:试|按|调|听|看|查|选|换|用|测).{0,10}(?:就说|直说|直接说|尽管说|跟我说|告诉我)|(?:别的|其他|什么|哪个)(?:键|功能|歌|操作)?.{0,6}(?:就说|直说|直接说|尽管说)|(?:你|请)?(?:直接说|直说|尽管说|接着说|继续说|说吧|讲吧)(?:就行|就好|吧)?|告诉我.{1,18}(?:就行|就好|吧))$/;

export function shouldContinueXiaoaiDialog(
  rawText: string,
  options?: { hasPendingWorkerQuestion?: boolean },
): boolean {
  const { text, directive } = stripXiaoaiDialogDirective(rawText);
  if (directive === 'listen') return true;
  const clean = sanitizeForSpeech(text);
  const sentences = clean ? clean.split(/[。！!;；]+/).map(s => s.trim()).filter(Boolean) : [];
  const tail = sentences.at(-1) ?? clean;
  const hasImmediateInvite =
    Boolean(tail)
    && !/(?:以后|下次|回头|随时)/.test(tail)
    && IMMEDIATE_SPEAK_INVITE_RE.test(tail);
  if (directive === 'end') return hasImmediateInvite;
  if (options?.hasPendingWorkerQuestion) return true;
  if (!clean) return false;
  if (hasImmediateInvite) return true;
  if (/[？?]\s*$/.test(clean)) return true;
  const lastQIdx = Math.max(clean.lastIndexOf('？'), clean.lastIndexOf('?'));
  if (lastQIdx >= 0) {
    const afterQ = clean.slice(lastQIdx + 1).replace(/[。！!;；，,、\s]+/g, '');
    if (afterQ.length <= 32 && !/(?:不用回|无需回|不必回)/.test(afterQ)) {
      return true;
    }
  }
  const recentTail = sentences.slice(-2).join('，');
  if (/[？?]/.test(tail)) return true;
  if (/(?:吗|呢|么|好不好|行不行|可不可以|对不对|是不是|要哪个|选哪个|哪一个|发到哪(?:里|儿)?|转到哪(?:里|儿)?|请说|请讲|请确认|告诉我)$/.test(tail)) {
    return true;
  }
  if (/(?:帮我确认|请确认|确认一下|给(?:我)?(?:一?点|个)?线索|给点提示|跟我说一下|再说一下)/.test(recentTail)) {
    return true;
  }
  if (/(?:要不要|需要我|想发|发(?:给你?|你|到|去)|转到|用哪个|选|确认|请问|是.{0,8}还是|放.{0,8}还是).*(?:还是|或者)/.test(tail) && !/(?:无论|不管)/.test(tail)) {
    return true;
  }
  return false;
}

export function sanitizeForSpeech(text: string): string {
  if (!text) return '';
  let result = stripXiaoaiDialogDirective(text).text.replace(/\r\n?/g, '\n');

  result = result.replace(/```[\s\S]*?```/g, '（代码详情已同步至控制台）');
  result = result.replace(/```[\s\S]*$/g, '（代码详情已同步至控制台）');

  result = result.replace(/!?\[([^\]]*)\]\((?:[^()\s]+|\([^)]*\))+\)/g, (_m, label: string) => label);
  result = result.replace(/[\[【]+[\s[\]【】]*(?:LISTEN|CONTINUE_DIALOG|END|END_DIALOG)[\s[\]【】]*[\]】]+/gi, '');
  result = result.replace(/\[\s*\]|【\s*】/g, '');
  result = result.replace(/https?:\/\/[^\s，。！？；、（）【】《》"'<>]+/gi, '（链接见控制台）');

  result = result.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s+[^<>]*)?\/?>/g, '');
  result = result.replace(/\[\[\s*sticker:[^\[\]\s]{1,24}\s*\]\]/gi, '');
  result = result.replace(/\[bot:[^\[\]\s]{1,24}\]/gi, '');
  result = result.replace(/\[([^\[\]\s]{1,12})\]/g, (full, tag: string) =>
    WECHAT_EMOJI_TAGS.has(tag.toLowerCase()) ? '' : full,
  );
  result = result.replace(/\p{Extended_Pictographic}/gu, '');
  result = result.replace(/[\uFE0E\uFE0F\u200D\u20E3]/gu, '');

  result = result.replace(/^#+\s*/gm, '');
  result = result.replace(/^[•\-*]\s+/gm, '');
  result = result.replace(/\*\*|__|\*/g, '');
  result = result.replace(/`/g, '');

  result = result.replace(/([。！？；：.!?;:，,、])[ \t]*\n+\s*/g, '$1');
  result = result.replace(/[ \t]*\n{2,}\s*/g, '。');
  result = result.replace(/[ \t]*\n\s*/g, '，');

  result = result.replace(/[。]{2,}/g, '。');
  result = result.replace(/[，]{2,}/g, '，');
  result = result.replace(/[，,]([。！？；!?;])/g, '$1');
  result = result.replace(/([。！？；!?;])[，,]+/g, '$1');
  result = result.replace(/[ \t]+/g, ' ');
  result = result.replace(/\s*([。！？；：，、])\s*/g, '$1');

  return result.trim();
}

/**
 * Smooths overly fragmented comma pauses in short conversational Chinese TTS replies
 * (especially around "老板" and short acknowledgements) while keeping natural breaks before long clauses.
 */
export function smoothXiaoaiTtsProsody(segment: string): string {
  if (!segment) return '';
  let out = segment;
  out = out.replace(
    /(^|[。！？；!?;，,]\s*)([\u4e00-\u9fa5A-Za-z0-9]{1,6})[，,]\s*老板(?=$|[。！？；!?;，,]|[\u4e00-\u9fa5])/g,
    '$1$2老板',
  );
  out = out.replace(
    /(^|[。！？；!?;]\s*)老板[，,]\s*(?=[\u4e00-\u9fa5A-Za-z0-9]{1,12}(?:$|[。！？；!?;，,]))/g,
    '$1老板',
  );
  out = out.replace(
    /(^|[。！？；!?;]\s*)((?:好的|好嘞|好哒|好|行|行的|可以|明白|收到|没问题|妥了|搞定|稍等|抱歉|不好意思|对不起|放心|是的|没错|对|嗯|噢|哦|诶)(?:老板)?)[，,]\s*(?=[^，,。！？；!?;、：:\s]{1,10}(?:$|[。！？；!?;，,]))/g,
    '$1$2',
  );
  return out;
}

export function splitSpeechSegments(text: string, maxSegmentChars = 160): string[] {
  const clean = sanitizeForSpeech(text);
  if (!clean) return [];
  const limit = Math.max(1, Math.floor(maxSegmentChars));
  if (clean.length <= limit) return [clean];

  const sentences = splitKeepingDelimiters(clean, /[^。！？；!?;]*[。！？；!?;]+|[^。！？；!?;]+/g);
  const units: string[] = [];

  for (const sentence of sentences) {
    if (sentence.length <= limit) {
      units.push(sentence);
      continue;
    }
    const clauses = splitKeepingDelimiters(sentence, /[^，、,：:]*[，、,：:]+|[^，、,：:]+/g);
    for (const clause of clauses) {
      if (clause.length <= limit) {
        units.push(clause);
        continue;
      }
      for (let i = 0; i < clause.length; i += limit) {
        const slice = clause.slice(i, i + limit).trim();
        if (slice) units.push(slice);
      }
    }
  }

  const segments: string[] = [];
  let current = '';
  for (const unit of units) {
    if (!current) {
      current = unit;
      continue;
    }
    const needsSpace = /[A-Za-z0-9.!?;,:]$/.test(current) && /^[A-Za-z0-9]/.test(unit);
    const joiner = needsSpace ? ' ' : '';
    if (current.length + joiner.length + unit.length <= limit) {
      current = `${current}${joiner}${unit}`;
    } else {
      segments.push(current.trim());
      current = unit;
    }
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

export function shouldInterceptXiaoaiQuery(
  rawText: string,
  options?: { prefix?: string; passthroughNative?: boolean },
): { intercept: boolean; query: string } {
  const cleaned = rawText
    .trim()
    .replace(/^(?:小爱同学[\s，,。！!？?、：:]*|小爱[\s，,。！!？?、：:]+)+/i, '')
    .trim();
  if (!cleaned) return { intercept: false, query: '' };

  const prefixRaw = options?.prefix?.trim();
  if (prefixRaw) {
    const prefixes = prefixRaw
      .split(/[,，]/)
      .map(p => p.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (prefixes.length > 0) {
      const lower = cleaned.toLowerCase();
      for (const prefix of prefixes) {
        if (!lower.startsWith(prefix.toLowerCase())) continue;
        const lastChar = prefix.slice(-1);
        const nextChar = cleaned.charAt(prefix.length);
        if (/[a-zA-Z]/.test(lastChar) && /[a-zA-Z]/.test(nextChar)) continue;
        const rest = cleaned
          .slice(prefix.length)
          .replace(LEADING_PUNCT_RE, '')
          .trim();
        if (!rest) return { intercept: false, query: '' };
        return { intercept: true, query: rest };
      }
      return { intercept: false, query: '' };
    }
  }

  if (options?.passthroughNative !== false) {
    const normalized = cleaned.replace(/[。！!？?，,\s]+$/g, '').trim();
    if (!normalized) return { intercept: false, query: '' };
    if (NATIVE_CONTROL_PATTERNS.some(pattern => pattern.test(normalized))) {
      return { intercept: false, query: '' };
    }
  }

  return { intercept: true, query: cleaned };
}

export type BotExpression =
  | 'neutral'
  | 'happy'
  | 'calm'
  | 'surprised'
  | 'inspecting'
  | 'squinted'
  | 'sleepy'
  | 'confused'
  | 'sad';

export const BOT_EXPRESSIONS: readonly BotExpression[] = [
  'neutral',
  'happy',
  'calm',
  'surprised',
  'inspecting',
  'squinted',
  'sleepy',
  'confused',
  'sad',
] as const;

export const BOT_EXPRESSION_META: Record<
  BotExpression,
  { label: string; wechatFallback: string; plainEmoji: string }
> = {
  neutral: { label: '默认', wechatFallback: '🫡', plainEmoji: '🤖' },
  happy: { label: '开心', wechatFallback: '[庆祝]', plainEmoji: '😄' },
  calm: { label: '柔和', wechatFallback: '[合十]', plainEmoji: '😌' },
  surprised: { label: '惊讶', wechatFallback: '👀', plainEmoji: '😮' },
  inspecting: { label: '打量', wechatFallback: '[机智]', plainEmoji: '🧐' },
  squinted: { label: '专注', wechatFallback: '[奸笑]', plainEmoji: '😑' },
  sleepy: { label: '犯困', wechatFallback: '[困]', plainEmoji: '😴' },
  confused: { label: '疑惑', wechatFallback: '[捂脸]', plainEmoji: '🤔' },
  sad: { label: '叹气', wechatFallback: '[叹气]', plainEmoji: '😮‍💨' },
};

const EXPRESSION_ALIAS_MAP: Record<string, BotExpression> = {
  neutral: 'neutral',
  default: 'neutral',
  idle: 'neutral',
  '默认': 'neutral',
  '待机': 'neutral',
  happy: 'happy',
  wink: 'happy',
  smile: 'happy',
  celebrate: 'happy',
  '开心': 'happy',
  '高兴': 'happy',
  '笑': 'happy',
  '庆祝': 'happy',
  calm: 'calm',
  gentle: 'calm',
  '柔和': 'calm',
  '平静': 'calm',
  '淡定': 'calm',
  surprised: 'surprised',
  wow: 'surprised',
  '惊讶': 'surprised',
  '震惊': 'surprised',
  inspecting: 'inspecting',
  curious: 'inspecting',
  inspect: 'inspecting',
  '打量': 'inspecting',
  '好奇': 'inspecting',
  '机智': 'inspecting',
  squinted: 'squinted',
  squint: 'squinted',
  focus: 'squinted',
  '专注': 'squinted',
  '眯眼': 'squinted',
  sleepy: 'sleepy',
  drowsy: 'sleepy',
  sleep: 'sleepy',
  '犯困': 'sleepy',
  '困': 'sleepy',
  '打盹': 'sleepy',
  confused: 'confused',
  puzzle: 'confused',
  '疑惑': 'confused',
  '懵': 'confused',
  '尴尬': 'confused',
  sad: 'sad',
  sigh: 'sad',
  '难过': 'sad',
  '叹气': 'sad',
  '裂开': 'sad',
};

export function normalizeBotExpression(raw: string): BotExpression | undefined {
  const key = raw.trim().toLowerCase();
  return key ? EXPRESSION_ALIAS_MAP[key] : undefined;
}

export type BotTextToken =
  | { kind: 'text'; value: string }
  | { kind: 'emote'; expr: BotExpression; raw: string }
  | { kind: 'sticker'; expr: BotExpression; raw: string };

const BOT_TAG_RE = /\[\[\s*sticker:([^\[\]\s]{1,24})\s*\]\]|\[bot:([^\[\]\s]{1,24})\]/gi;

function pushTextToken(tokens: BotTextToken[], value: string): void {
  if (!value) return;
  const last = tokens.at(-1);
  if (last && last.kind === 'text') {
    last.value += value;
  } else {
    tokens.push({ kind: 'text', value });
  }
}

/**
 * Safely splits message text into plain text segments and recognized `[bot:<expr>]` / `[[sticker:<expr>]]` tokens.
 */
export function tokenizeBotMessageText(input: string): BotTextToken[] {
  if (!input) return [];
  const tokens: BotTextToken[] = [];
  BOT_TAG_RE.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = BOT_TAG_RE.exec(input)) !== null) {
    if (match.index > lastIndex) {
      pushTextToken(tokens, input.slice(lastIndex, match.index));
    }
    const stickerArg = match[1];
    const emoteArg = match[2];
    const expr = normalizeBotExpression(stickerArg ?? emoteArg ?? '');
    if (expr) {
      tokens.push({
        kind: stickerArg !== undefined ? 'sticker' : 'emote',
        expr,
        raw: match[0],
      });
    } else {
      pushTextToken(tokens, match[0]);
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < input.length) {
    pushTextToken(tokens, input.slice(lastIndex));
  }
  return tokens;
}

/**
 * Infers an appropriate BotExpression from inline bot tags or common WeChat native emoji tags in an assistant message.
 */
export function inferMessageBotExpression(text: string): BotExpression | undefined {
  if (!text) return undefined;
  for (const token of tokenizeBotMessageText(text)) {
    if (token.kind === 'emote' || token.kind === 'sticker') {
      return token.expr;
    }
  }
  if (/\[(?:庆祝|愉快)\]/.test(text)) return 'happy';
  if (/\[(?:机智|吃瓜)\]/.test(text)) return 'inspecting';
  if (/\[(?:捂脸|破涕为笑)\]/.test(text)) return 'confused';
  if (/\[(?:叹气|裂开)\]/.test(text)) return 'sad';
  if (/\[奸笑\]/.test(text)) return 'squinted';
  if (/\[困\]/.test(text)) return 'sleepy';
  if (/\[合十\]/.test(text)) return 'calm';
  return undefined;
}

/**
 * Transforms `[bot:<expr>]` and `[[sticker:<expr>]]` tags for IM channels.
 * Ordinary text without bot/sticker tags is returned byte-for-byte unchanged.
 */
export function transformOutboundBotExpressions(
  text: string,
  platform: 'wechat' | 'telegram' | 'dingtalk' | 'xiaoai',
  maxStickers = 3,
): { text: string; stickers: BotExpression[] } {
  if (!text || !/\[\[\s*sticker:|\[bot:/i.test(text)) {
    return { text, stickers: [] };
  }

  const tokens = tokenizeBotMessageText(text);
  const stickers: BotExpression[] = [];
  const pieces: string[] = [];
  let removedSticker = false;

  for (const token of tokens) {
    if (token.kind === 'text') {
      pieces.push(token.value);
      continue;
    }
    if (token.kind === 'sticker') {
      removedSticker = true;
      if (platform === 'wechat' && stickers.length < maxStickers && !stickers.includes(token.expr)) {
        stickers.push(token.expr);
      }
      continue;
    }
    const meta = BOT_EXPRESSION_META[token.expr];
    if (platform === 'wechat') {
      pieces.push(meta.wechatFallback);
    } else if (platform === 'xiaoai') {
      pieces.push('');
    } else {
      pieces.push(meta.plainEmoji);
    }
  }

  let out = pieces.join('');
  if (removedSticker) {
    out = out
      .replace(/ {2,}/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .trim();
  }
  return { text: out, stickers };
}

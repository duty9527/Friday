import { createHash } from 'node:crypto';
import { sanitizeImError } from '../im/types.js';

export const WECHAT_ILINK_CHANNEL_VERSION = '2.4.10';
export const WECHAT_ILINK_APP_ID = 'bot';
export const DEFAULT_WECHAT_CDN_ORIGIN = 'https://novac2c.cdn.weixin.qq.com';

const LOSSLESS_ID_FIELDS = new Set(['message_id', 'msg_id', 'svr_id', 'svrid', 'refer_msg_id']);

export interface WechatPartialText {
  start: string;
  end: string;
  startindex: number;
  endindex: number;
  quotemd5?: string;
}

export interface WechatQuote {
  title?: string;
  text: string;
  sender?: string;
  refId?: string;
  partialText?: WechatPartialText;
  selectedExcerpt?: string;
  direction?: 'inbound' | 'outbound';
  inlineMediaItem?: Record<string, unknown>;
  mediaName?: string;
  mediaPath?: string;
  mediaMime?: string;
  cacheMissing?: boolean;
}

/** Encode semver string `"M.N.P"` into uint32 decimal string `(M << 16) | (N << 8) | P`. */
export function encodeClientVersion(version: string): string {
  const parts = version.split('.').map(part => Number.parseInt(part, 10));
  const major = Number.isFinite(parts[0]) ? (parts[0]! & 0xff) : 0;
  const minor = Number.isFinite(parts[1]) ? (parts[1]! & 0xff) : 0;
  const patch = Number.isFinite(parts[2]) ? (parts[2]! & 0xff) : 0;
  return String(((major << 16) | (minor << 8) | patch) >>> 0);
}

/** Build the `base_info` envelope sent in iLink Bot API requests. */
export function buildWechatBaseInfo(botAgent = 'Friday/1.0.0'): {
  channel_version: string;
  bot_agent: string;
} {
  return {
    channel_version: WECHAT_ILINK_CHANNEL_VERSION,
    bot_agent: botAgent,
  };
}

/**
 * Quote uint64 message identifiers (`message_id`, `msg_id`, `svr_id`) before `JSON.parse`
 * sees them so precision is never lost. Only rewrites object property values whose value
 * is a bare integer literal, never altering text inside JSON strings.
 */
export function parseWeixinApiJson<T = unknown>(rawText: string): T {
  let output = '';
  let index = 0;

  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++];
      continue;
    }

    const stringStart = index;
    index++;
    let escaped = false;
    while (index < rawText.length) {
      const ch = rawText[index++];
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        break;
      }
    }

    const stringToken = rawText.slice(stringStart, index);
    output += stringToken;

    let cursor = index;
    while (/\s/.test(rawText[cursor] ?? '')) cursor++;
    if (rawText[cursor] !== ':') continue;

    let key: unknown;
    try {
      key = JSON.parse(stringToken);
    } catch {
      continue;
    }
    if (typeof key !== 'string' || !LOSSLESS_ID_FIELDS.has(key)) continue;

    output += rawText.slice(index, cursor + 1);
    cursor++;
    while (/\s/.test(rawText[cursor] ?? '')) {
      output += rawText[cursor++];
    }

    const numberStart = cursor;
    if (rawText[cursor] === '-') cursor++;
    while (/\d/.test(rawText[cursor] ?? '')) cursor++;

    const nextChar = rawText[cursor] ?? '';
    const isBareInteger =
      cursor > numberStart
      && !(cursor === numberStart + 1 && rawText[numberStart] === '-')
      && nextChar !== '.'
      && nextChar !== 'e'
      && nextChar !== 'E';

    if (isBareInteger) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else {
      index = numberStart;
    }
  }

  return JSON.parse(output) as T;
}

function isTrustedWechatCdnHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'novac2c.cdn.weixin.qq.com' || lower.endsWith('.cdn.weixin.qq.com');
}

/** Validate a configured CDN origin/base URL and return its canonical HTTPS origin. */
export function validateWechatCdnOrigin(rawBase: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawBase.trim());
  } catch {
    throw new Error('Untrusted CDN');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.port !== ''
    || parsed.username !== ''
    || parsed.password !== ''
    || !isTrustedWechatCdnHostname(parsed.hostname)
  ) {
    throw new Error('Untrusted CDN');
  }
  const path = parsed.pathname;
  if (path !== '' && path !== '/' && path !== '/c2c' && path !== '/c2c/') {
    throw new Error('Untrusted CDN');
  }
  return parsed.origin;
}

/** Strictly validate a full WeChat CDN download/upload URL (`/c2c/` path on trusted HTTPS CDN host). */
export function validateWechatCdnUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Untrusted CDN');
  }
  if (
    url.protocol !== 'https:'
    || url.port !== ''
    || url.username !== ''
    || url.password !== ''
    || !isTrustedWechatCdnHostname(url.hostname)
    || !url.pathname.startsWith('/c2c/')
  ) {
    throw new Error('Untrusted CDN');
  }
  return url;
}

function cleanQuoteField(value: unknown): string {
  if (typeof value !== 'string') return '';
  return sanitizeImError(value)
    .replace(/\s+/g, ' ')
    .trim();
}

const MAX_QUOTE_TITLE_CHARS = 120;
const MAX_QUOTE_TEXT_CHARS = 1500;

function nthIndexOf(text: string, value: string, occurrence: number, fromIndex = 0): number {
  if (!value || !Number.isInteger(occurrence) || occurrence < 0) return -1;
  let position = fromIndex;
  for (let current = 0; current <= occurrence; current++) {
    position = text.indexOf(value, position);
    if (position < 0) return -1;
    if (current < occurrence) position += value.length;
  }
  return position;
}

function partialQuoteCandidate(
  fullText: string,
  partial: WechatPartialText,
  endSearchMode: 'global' | 'relative',
): string | null {
  const start = nthIndexOf(fullText, partial.start, partial.startindex);
  if (start < 0) return null;
  const end =
    endSearchMode === 'global'
      ? nthIndexOf(fullText, partial.end, partial.endindex)
      : nthIndexOf(fullText, partial.end, partial.endindex, start + partial.start.length);
  if (end < start) return null;
  return fullText.slice(start, end + partial.end.length);
}

/**
 * Resolve a WeChat `partial_text` substring selection against the full quoted message body,
 * trying both global and relative `endindex` interpretations and disambiguating via `quotemd5`.
 */
export function resolvePartialQuote(
  fullText: string,
  partial: WechatPartialText,
): { resolved: string | null; fallback: boolean } {
  if (!fullText || !partial.start || !partial.end) {
    return { resolved: null, fallback: true };
  }
  const candidates = [
    partialQuoteCandidate(fullText, partial, 'global'),
    partialQuoteCandidate(fullText, partial, 'relative'),
  ].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);

  if (!partial.quotemd5) {
    return candidates[0]
      ? { resolved: candidates[0], fallback: false }
      : { resolved: null, fallback: true };
  }
  const expected = partial.quotemd5.trim().toLowerCase();
  const resolved = candidates.find(value =>
    createHash('md5').update(value, 'utf8').digest('hex') === expected,
  ) ?? null;
  return { resolved, fallback: resolved === null };
}

function cleanScalarId(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function parsePartialTextField(raw: unknown): WechatPartialText | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const start = typeof obj.start === 'string' ? obj.start : '';
  const end = typeof obj.end === 'string' ? obj.end : '';
  const startindex = typeof obj.startindex === 'number' ? obj.startindex : Number(obj.startindex);
  const endindex = typeof obj.endindex === 'number' ? obj.endindex : Number(obj.endindex);
  if (!start || !end || !Number.isInteger(startindex) || startindex < 0 || !Number.isInteger(endindex) || endindex < 0) {
    return undefined;
  }
  const quotemd5 = typeof obj.quotemd5 === 'string' && obj.quotemd5.trim() ? obj.quotemd5.trim() : undefined;
  return { start, end, startindex, endindex, ...(quotemd5 ? { quotemd5 } : {}) };
}

function hasDownloadableMediaObj(media: unknown): boolean {
  if (!media || typeof media !== 'object') return false;
  const rec = media as Record<string, unknown>;
  return Boolean(
    (typeof rec.encrypt_query_param === 'string' && rec.encrypt_query_param.trim())
    || (typeof rec.full_url === 'string' && rec.full_url.trim()),
  );
}

function extractInlineMediaItem(item: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!item) return undefined;
  const type = Number(item.type);
  if (type === 2 && hasDownloadableMediaObj((item.image_item as Record<string, unknown> | undefined)?.media)) return item;
  if (type === 3 && hasDownloadableMediaObj((item.voice_item as Record<string, unknown> | undefined)?.media)) return item;
  if (type === 4 && hasDownloadableMediaObj((item.file_item as Record<string, unknown> | undefined)?.media)) return item;
  if (type === 5 && hasDownloadableMediaObj((item.video_item as Record<string, unknown> | undefined)?.media)) return item;
  return undefined;
}

function buildQuoteFromRecord(raw: Record<string, unknown>): WechatQuote | undefined {
  const nestedMsg = raw.message_item && typeof raw.message_item === 'object'
    ? (raw.message_item as Record<string, unknown>)
    : undefined;
  const nestedTextItem = nestedMsg?.text_item && typeof nestedMsg.text_item === 'object'
    ? (nestedMsg.text_item as Record<string, unknown>)
    : undefined;
  const nestedVoiceItem = nestedMsg?.voice_item && typeof nestedMsg.voice_item === 'object'
    ? (nestedMsg.voice_item as Record<string, unknown>)
    : undefined;
  const nestedFileItem = nestedMsg?.file_item && typeof nestedMsg.file_item === 'object'
    ? (nestedMsg.file_item as Record<string, unknown>)
    : undefined;

  const refId =
    cleanScalarId(raw.svr_id)
    || cleanScalarId(nestedMsg?.msg_id)
    || cleanScalarId(raw.msg_id)
    || cleanScalarId(raw.svrid)
    || cleanScalarId(raw.refer_msg_id)
    || undefined;

  const inlineMediaItem = extractInlineMediaItem(nestedMsg);
  const partialText = parsePartialTextField(raw.partial_text);

  const fileNameLabel = cleanQuoteField(nestedFileItem?.file_name);
  const rawText = cleanQuoteField(
    raw.content ?? raw.des ?? raw.text ?? nestedTextItem?.text ?? nestedVoiceItem?.text ?? fileNameLabel,
  );
  const title = cleanQuoteField(raw.title ?? nestedMsg?.title);
  const sender = cleanQuoteField(raw.displayname ?? raw.fromusr ?? raw.sender ?? raw.from_user_name);

  if (!rawText && !title && !refId && !inlineMediaItem) return undefined;

  const clippedText = rawText.length > MAX_QUOTE_TEXT_CHARS
    ? `${rawText.slice(0, MAX_QUOTE_TEXT_CHARS)}…`
    : rawText;
  const clippedTitle = title.length > MAX_QUOTE_TITLE_CHARS
    ? `${title.slice(0, MAX_QUOTE_TITLE_CHARS)}…`
    : title;

  return {
    ...(clippedTitle ? { title: clippedTitle } : {}),
    text: clippedText,
    ...(sender ? { sender } : {}),
    ...(refId ? { refId } : {}),
    ...(partialText ? { partialText } : {}),
    ...(inlineMediaItem ? { inlineMediaItem } : {}),
    ...(fileNameLabel ? { mediaName: fileNameLabel } : {}),
  };
}

/**
 * Extract a quoted reply (`refermsg` / `appmsg.refermsg` / `quote` / `ref_msg`)
 * from an inbound iLink `item_list` or top-level message envelope, including ID-only
 * `svr_id` references and `partial_text` selections.
 */
export function parseWechatQuote(
  items: unknown,
  topLevelMsg?: Record<string, unknown>,
): WechatQuote | undefined {
  const candidates: Array<Record<string, unknown>> = [];
  if (Array.isArray(items)) {
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== 'object') continue;
      const item = rawItem as Record<string, unknown>;
      const appmsg = item.appmsg && typeof item.appmsg === 'object'
        ? (item.appmsg as Record<string, unknown>)
        : undefined;
      const quoteObj = item.quote && typeof item.quote === 'object'
        ? (item.quote as Record<string, unknown>)
        : undefined;
      const textObj = item.text_item && typeof item.text_item === 'object'
        ? (item.text_item as Record<string, unknown>)
        : undefined;

      for (const candidate of [
        item.refermsg,
        appmsg?.refermsg,
        quoteObj?.refermsg,
        quoteObj,
        item.ref_msg,
        textObj?.ref_msg,
      ]) {
        if (candidate && typeof candidate === 'object') {
          candidates.push(candidate as Record<string, unknown>);
        }
      }
    }
  }
  if (topLevelMsg && typeof topLevelMsg === 'object') {
    for (const candidate of [topLevelMsg.ref_msg, topLevelMsg.refermsg, topLevelMsg.quote]) {
      if (candidate && typeof candidate === 'object') {
        candidates.push(candidate as Record<string, unknown>);
      }
    }
  }

  for (const rec of candidates) {
    const parsed = buildQuoteFromRecord(rec);
    if (parsed) return parsed;
  }
  return undefined;
}

function collapseQuoteLineBreaks(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/** Format a parsed quote block to prepend to an inbound message prompt. */
export function formatWechatQuoteBlock(quote: WechatQuote): string {
  const head = quote.sender
    ? `【引用 ${quote.sender}】`
    : quote.direction === 'outbound'
      ? '【引用 F.R.I.D.A.Y. 的消息】'
      : quote.direction === 'inbound'
        ? '【引用你之前的消息】'
        : '【引用】';
  const lines = [head];
  const title = quote.title ? collapseQuoteLineBreaks(quote.title) : '';
  const selected = quote.selectedExcerpt ? collapseQuoteLineBreaks(quote.selectedExcerpt) : '';
  const body = quote.text ? collapseQuoteLineBreaks(quote.text) : '';
  if (title && title !== body) lines.push(title);
  if (selected) {
    lines.push(`划词引用：${selected}`);
    if (body && body !== selected) {
      lines.push(`完整原文：${body}`);
    }
  } else if (body) {
    lines.push(body);
  } else if (quote.cacheMissing) {
    lines.push(`[引用的历史消息未缓存${quote.refId ? ` (ID: ${quote.refId})` : ''}]`);
  }
  return lines.join('\n');
}

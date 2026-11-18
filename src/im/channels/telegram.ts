import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { ImChannelConfig } from '../../store.js';
import { resolveBotStickerPath } from '../../wechat-file.js';
import { imageMime, MEDIA_LIMIT, type ReceivedAttachment } from '../../wechat-inbound.js';
import {
  BOT_EXPRESSION_META,
  tokenizeBotMessageText,
  transformOutboundBotExpressions,
  type BotExpression,
} from '../../web/shared/bot-expressions.js';
import { TELEGRAM_BOT_COMMANDS } from '../commands.js';
import {
  buildRequestSignal,
  DEFAULT_NETWORK_TIMEOUT_MS,
  finalizeWebhookInbound,
  jsonWebhookResponse,
  readHeaderValue,
  safeEqual,
  type ImChannelAdapter,
  type ImGatewayContext,
  type ImInboundMessage,
  type ImSendOptions,
  type ImWebhookResponse,
  type TelegramMediaItem,
} from '../types.js';

const TELEGRAM_MAX_TEXT_LEN = 4_000;
const TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function redactBotToken(input: string, botToken?: string): string {
  let out = input.replace(/\/bot[^/\s?]+/gi, '/bot[REDACTED]');
  if (botToken) {
    out = out.split(botToken).join('[REDACTED]');
  }
  return out;
}

function normalizeTelegramApiBase(apiBase?: string): string {
  const raw = (apiBase?.trim() || 'https://api.telegram.org').replace(/\/$/, '');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Telegram apiBase URL 格式无效');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Telegram apiBase 仅支持 http/https 协议');
  }
  return raw;
}

function validateBotTokenFormat(botToken: string): string {
  const token = botToken.trim();
  if (!token || !token.includes(':') || /\s/.test(token)) {
    throw new Error('Telegram Bot Token 格式无效（应包含 ":" 且不含空白字符）');
  }
  return token;
}

function isImageDocument(fileName: string, mimeType?: string): boolean {
  if (mimeType && /^image\/(?:png|jpe?g|gif|webp)$/i.test(mimeType)) {
    return true;
  }
  return /\.(?:png|jpe?g|gif|webp)$/i.test(fileName);
}

function safeDownloadExtension(kind: 'image' | 'file', rawName: string, mimeType?: string): string {
  if (kind === 'image' && mimeType && MIME_EXT[mimeType]) {
    return MIME_EXT[mimeType];
  }
  const ext = extname(rawName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

function pickLargestPhoto(photos: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  let best: Record<string, unknown> | undefined;
  let bestScore = -1;
  for (const photo of photos) {
    if (!photo || typeof photo.file_id !== 'string' || !photo.file_id) continue;
    const width = Number(photo.width ?? 0);
    const height = Number(photo.height ?? 0);
    const size = Number(photo.file_size ?? 0);
    const score = width > 0 && height > 0 ? width * height : size;
    if (score >= bestScore) {
      bestScore = score;
      best = photo;
    }
  }
  return best;
}

function splitTelegramTokens(input: string, maxStickers = 3): { text: string; stickers: BotExpression[] } {
  if (!input || !/\[\[\s*sticker:|\[bot:/i.test(input)) {
    return { text: input, stickers: [] };
  }
  const tokens = tokenizeBotMessageText(input);
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
      if (stickers.length < maxStickers && !stickers.includes(token.expr)) {
        stickers.push(token.expr);
      }
      continue;
    }
    pieces.push(BOT_EXPRESSION_META[token.expr].plainEmoji);
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

/** Split long outbound Telegram text cleanly on paragraph, line, or sentence boundaries under 4096 chars. */
export function splitTelegramText(text: string, maxLen = TELEGRAM_MAX_TEXT_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  const minSplit = Math.max(1, Math.floor(maxLen * 0.4));

  while (remaining.length > maxLen) {
    const window = remaining.slice(0, maxLen);
    let splitAt = -1;

    const paraIdx = window.lastIndexOf('\n\n');
    if (paraIdx >= minSplit) {
      splitAt = paraIdx;
    } else {
      const lineIdx = window.lastIndexOf('\n');
      if (lineIdx >= minSplit) {
        splitAt = lineIdx;
      } else {
        for (let i = window.length - 1; i >= minSplit; i--) {
          const ch = window[i]!;
          if (ch === '。' || ch === '！' || ch === '？' || ch === '；') {
            splitAt = i + 1;
            break;
          }
          if ((ch === '.' || ch === '!' || ch === '?') && (i + 1 >= window.length || /\s/.test(window[i + 1]!))) {
            splitAt = i + 1;
            break;
          }
        }
        if (splitAt < minSplit) {
          const spaceIdx = window.lastIndexOf(' ');
          if (spaceIdx >= minSplit) {
            splitAt = spaceIdx + 1;
          }
        }
      }
    }

    if (splitAt <= 0 || splitAt > maxLen) {
      splitAt = maxLen;
      const prevCode = remaining.charCodeAt(splitAt - 1);
      if (prevCode >= 0xd800 && prevCode <= 0xdbff && splitAt > 1) {
        splitAt -= 1;
      }
    }

    const chunk = remaining.slice(0, splitAt).replace(/\s+$/, '');
    chunks.push(chunk.length > 0 ? chunk : remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks.length > 0 ? chunks : [text.slice(0, maxLen)];
}

/** Parse a Telegram Bot API update payload (`message`, `edited_message`, `callback_query`) into a normalized inbound message. */
export function parseTelegramUpdate(channelId: string, update: Record<string, unknown>): ImInboundMessage | undefined {
  const cq = update.callback_query as Record<string, unknown> | undefined;
  if (cq && typeof cq === 'object') {
    const cqId = (typeof cq.id === 'string' || typeof cq.id === 'number') ? String(cq.id).trim() : '';
    const data = typeof cq.data === 'string' ? cq.data.trim() : '';
    if (!cqId || !data) return undefined;
    const from = (cq.from ?? {}) as Record<string, unknown>;
    const cqMsg = (cq.message ?? {}) as Record<string, unknown>;
    const chat = (cqMsg.chat ?? {}) as Record<string, unknown>;
    const senderId = String(from.id ?? chat.id ?? 'tg-user');
    const senderUsername = typeof from.username === 'string' && from.username.trim() ? from.username.trim() : undefined;
    const senderName = [from.first_name, from.last_name].filter(Boolean).join(' ') || senderUsername || senderId;
    const target = String(chat.id ?? from.id ?? senderId);
    return {
      channelId,
      externalId: `cq:${cqId}`,
      senderId,
      senderName,
      senderUsername,
      target,
      text: data,
      callbackQueryId: cqId,
    };
  }

  const msg = (update.message ?? update.edited_message) as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== 'object') return undefined;

  const telegramMedia: TelegramMediaItem[] = [];
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const bestPhoto = pickLargestPhoto(msg.photo as Array<Record<string, unknown>>);
    if (bestPhoto && typeof bestPhoto.file_id === 'string') {
      telegramMedia.push({
        kind: 'image',
        fileId: bestPhoto.file_id,
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        ...(typeof bestPhoto.file_size === 'number' ? { fileSize: bestPhoto.file_size } : {}),
      });
    }
  }
  if (msg.document && typeof msg.document === 'object') {
    const doc = msg.document as Record<string, unknown>;
    if (typeof doc.file_id === 'string' && doc.file_id) {
      const fileName = typeof doc.file_name === 'string' && doc.file_name.trim() ? doc.file_name.trim() : 'document';
      const mimeType = typeof doc.mime_type === 'string' && doc.mime_type.trim() ? doc.mime_type.trim() : undefined;
      const fileSize = typeof doc.file_size === 'number' ? doc.file_size : undefined;
      telegramMedia.push({
        kind: isImageDocument(fileName, mimeType) ? 'image' : 'file',
        fileId: doc.file_id,
        fileName,
        ...(mimeType ? { mimeType } : {}),
        ...(fileSize !== undefined ? { fileSize } : {}),
      });
    }
  }

  const rawText = String(msg.text ?? msg.caption ?? '').trim();
  if (!rawText && telegramMedia.length === 0) return undefined;
  const text = rawText || '请查看收到的附件。';

  const from = (msg.from ?? {}) as Record<string, unknown>;
  const chat = (msg.chat ?? {}) as Record<string, unknown>;
  const senderId = String(from.id ?? chat.id ?? 'tg-user');
  const senderUsername = typeof from.username === 'string' && from.username.trim() ? from.username.trim() : undefined;
  const senderName = [from.first_name, from.last_name].filter(Boolean).join(' ') || senderUsername || senderId;
  const target = String(chat.id ?? senderId);
  const externalId = String(msg.message_id ?? update.update_id ?? randomUUID());
  return {
    channelId,
    externalId,
    senderId,
    senderName,
    senderUsername,
    target,
    text,
    ...(telegramMedia.length ? { telegramMedia } : {}),
  };
}

/** Channel adapter for Telegram Bot API (`getMe`, `setMyCommands`, `sendMessage`, `sendAnimation`, `sendDocument`, `getUpdates`, media & webhook). */
export class TelegramChannelAdapter implements ImChannelAdapter {
  readonly platform = 'telegram' as const;

  constructor(private readonly ctx: ImGatewayContext) {}

  async verifyBot(
    botToken: string,
    apiBase?: string,
  ): Promise<{ id: number; username?: string; firstName: string }> {
    const token = validateBotTokenFormat(botToken);
    const base = normalizeTelegramApiBase(apiBase);
    let res: Response;
    try {
      res = await fetch(`${base}/bot${token}/getMe`, {
        method: 'GET',
        signal: buildRequestSignal(DEFAULT_NETWORK_TIMEOUT_MS, this.ctx.shutdownSignal),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Network error';
      throw new Error(`Telegram getMe 请求失败: ${redactBotToken(msg, token)}`);
    }
    const payload = await res.json().catch(() => ({})) as {
      ok?: boolean;
      description?: string;
      result?: { id?: number; first_name?: string; username?: string };
    };
    if (!res.ok || !payload.ok || !payload.result || typeof payload.result.id !== 'number') {
      const detail = payload.description
        ? redactBotToken(payload.description, token)
        : `HTTP ${res.status}`;
      throw new Error(`Telegram Bot 校验失败: ${detail}`);
    }
    return {
      id: payload.result.id,
      firstName: String(payload.result.first_name ?? payload.result.username ?? 'Telegram Bot'),
      ...(typeof payload.result.username === 'string' && payload.result.username.trim()
        ? { username: payload.result.username.trim() }
        : {}),
    };
  }

  async deleteWebhook(botToken: string, apiBase?: string): Promise<void> {
    const token = validateBotTokenFormat(botToken);
    const base = normalizeTelegramApiBase(apiBase);
    await this.postBotApi(base, token, 'deleteWebhook', { drop_pending_updates: false });
  }

  async setMyCommands(botToken: string, apiBase?: string): Promise<void> {
    const token = validateBotTokenFormat(botToken);
    const base = normalizeTelegramApiBase(apiBase);
    await this.postBotApi(base, token, 'setMyCommands', { commands: TELEGRAM_BOT_COMMANDS });
  }

  async answerCallbackQuery(channel: ImChannelConfig, callbackQueryId: string, text?: string): Promise<void> {
    if (!channel.botToken || channel.webhookUrl || !callbackQueryId) return;
    try {
      const base = normalizeTelegramApiBase(channel.apiBase);
      await fetch(`${base}/bot${channel.botToken}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          ...(text ? { text } : {}),
        }),
        signal: buildRequestSignal(5_000, this.ctx.shutdownSignal),
      });
    } catch { /* best-effort */ }
  }

  async sendTyping(channel: ImChannelConfig, chatId: string): Promise<void> {
    if (!channel.botToken || channel.webhookUrl || !chatId) return;
    try {
      const base = normalizeTelegramApiBase(channel.apiBase);
      await fetch(`${base}/bot${channel.botToken}/sendChatAction`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
        signal: buildRequestSignal(5_000, this.ctx.shutdownSignal),
      });
    } catch { /* best-effort; silent on minimal mocks or transient failures */ }
  }

  async downloadMedia(
    channel: ImChannelConfig,
    item: TelegramMediaItem,
    destRoot: string,
  ): Promise<ReceivedAttachment> {
    const cleanName = item.fileName.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 255)
      || (item.kind === 'image' ? 'photo.jpg' : 'file');
    const result: ReceivedAttachment = { kind: item.kind, name: cleanName, status: 'failed' };
    const token = channel.botToken;
    try {
      if (!token) throw new Error('Telegram 通道缺少 botToken');
      if (item.fileSize !== undefined && item.fileSize > MEDIA_LIMIT) {
        throw new Error('文件超过 16 MiB 限制');
      }
      const base = normalizeTelegramApiBase(channel.apiBase);
      const getFileRes = await fetch(
        `${base}/bot${token}/getFile?file_id=${encodeURIComponent(item.fileId)}`,
        { signal: buildRequestSignal(DEFAULT_NETWORK_TIMEOUT_MS, this.ctx.shutdownSignal) },
      );
      if (!getFileRes.ok) {
        throw new Error(`getFile HTTP ${getFileRes.status}`);
      }
      const getFileData = await getFileRes.json() as {
        ok?: boolean;
        result?: { file_path?: string; file_size?: number };
        description?: string;
      };
      if (!getFileData.ok || typeof getFileData.result?.file_path !== 'string' || !getFileData.result.file_path) {
        throw new Error(getFileData.description ?? 'getFile 返回结果缺少 file_path');
      }
      if (typeof getFileData.result.file_size === 'number' && getFileData.result.file_size > MEDIA_LIMIT) {
        throw new Error('文件超过 16 MiB 限制');
      }
      const remotePath = getFileData.result.file_path.replace(/^\/+/, '');
      if (!remotePath || remotePath.includes('..') || /^[a-z]+:\/\//i.test(remotePath)) {
        throw new Error('非法的 Telegram 文件路径');
      }

      const fileRes = await fetch(`${base}/file/bot${token}/${remotePath}`, {
        redirect: 'error',
        signal: buildRequestSignal(20_000, this.ctx.shutdownSignal),
      });
      if (!fileRes.ok || !fileRes.body) {
        throw new Error(`下载失败 HTTP ${fileRes.status}`);
      }
      const contentLen = Number(fileRes.headers.get('content-length'));
      if (Number.isFinite(contentLen) && contentLen > MEDIA_LIMIT) {
        throw new Error('文件超过 16 MiB 限制');
      }

      const reader = fileRes.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MEDIA_LIMIT) {
            throw new Error('文件超过 16 MiB 限制');
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }

      const bytes = Buffer.concat(chunks);
      const detectedMime = item.kind === 'image' ? imageMime(bytes) : undefined;
      if (item.kind === 'image' && !detectedMime) {
        throw new Error('不支持的图片格式');
      }

      await mkdir(destRoot, { recursive: true, mode: 0o700 });
      let stat = await lstat(destRoot);
      if (stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077)) {
        await chmod(destRoot, 0o700).catch(() => {});
        stat = await lstat(destRoot);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
        throw new Error('媒体存储目录权限不安全');
      }

      const ext = safeDownloadExtension(item.kind, cleanName, detectedMime);
      const destPath = join(destRoot, `${randomUUID()}${ext}`);
      const handle = await open(
        destPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }

      const finalMime = detectedMime ?? item.mimeType;
      return {
        ...result,
        status: 'ready',
        path: destPath,
        ...(finalMime ? { mimeType: finalMime } : {}),
        bytes: bytes.length,
      };
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : 'unknown error';
      const safeMsg = redactBotToken(rawMsg, token).replace(/https?:\/\/\S+/g, '[url]');
      return { ...result, error: `附件接收失败（${safeMsg}）；请重新发送。` };
    }
  }

  async sendAttachment(
    channel: ImChannelConfig,
    filePathOrBytes: string | Buffer,
    fileName: string,
    options: {
      target: string;
      replyToMessageId?: string;
      caption?: string;
      animation?: boolean;
      replyMarkup?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!channel.botToken) {
      throw new Error('Telegram 通道缺少 botToken');
    }
    if (!options.target) {
      throw new Error('Telegram 通道缺少目标 Chat ID');
    }
    const bytes = typeof filePathOrBytes === 'string'
      ? await readFile(filePathOrBytes)
      : filePathOrBytes;
    if (bytes.length < 1 || bytes.length > TELEGRAM_MAX_UPLOAD_BYTES) {
      throw new Error('Telegram 附件大小必须在 1 字节至 50 MiB 之间');
    }
    const isAnimation = Boolean(options.animation && fileName.toLowerCase().endsWith('.gif'));
    const method = isAnimation ? 'sendAnimation' : 'sendDocument';
    const fieldName = isAnimation ? 'animation' : 'document';
    const mimeType = isAnimation ? 'image/gif' : 'application/octet-stream';

    const form = new FormData();
    form.append('chat_id', options.target);
    if (options.replyToMessageId && /^\d+$/.test(options.replyToMessageId)) {
      form.append('reply_to_message_id', options.replyToMessageId);
    }
    if (options.caption) {
      form.append('caption', options.caption.slice(0, 1024));
    }
    if (options.replyMarkup) {
      form.append('reply_markup', JSON.stringify(options.replyMarkup));
    }
    form.append(fieldName, new Blob([new Uint8Array(bytes)], { type: mimeType }), fileName);

    const base = normalizeTelegramApiBase(channel.apiBase);
    let res: Response;
    try {
      res = await fetch(`${base}/bot${channel.botToken}/${method}`, {
        method: 'POST',
        body: form,
        signal: buildRequestSignal(30_000, this.ctx.shutdownSignal),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Network error';
      throw new Error(`Telegram ${method} 失败: ${redactBotToken(msg, channel.botToken)}`);
    }
    if (!res.ok) {
      throw new Error(`Telegram ${method} 失败: HTTP ${res.status}`);
    }
    const rawText = await res.text().catch(() => '');
    if (rawText) {
      try {
        const parsed = JSON.parse(rawText) as { ok?: boolean; description?: string };
        if (parsed.ok === false) {
          throw new Error(redactBotToken(parsed.description ?? `Telegram ${method} 返回失败`, channel.botToken));
        }
      } catch (err) {
        if (err instanceof SyntaxError) return;
        throw err;
      }
    }
  }

  async send(channel: ImChannelConfig, text: string, options?: ImSendOptions): Promise<void> {
    if (!channel.botToken && !channel.webhookUrl) {
      throw new Error('Telegram 通道缺少 botToken 或 webhookUrl');
    }
    if (!options?.target && !channel.webhookUrl) {
      throw new Error('Telegram 通道缺少目标 Chat ID（可先向机器人发送一条消息自动绑定，或配置 defaultTarget）');
    }

    const useBotApi = Boolean(channel.botToken && !channel.webhookUrl);
    if (useBotApi) {
      const base = normalizeTelegramApiBase(channel.apiBase);
      const sendUrl = `${base}/bot${channel.botToken}/sendMessage`;
      const { text: cleanText, stickers } = splitTelegramTokens(text);

      if (cleanText.length > 0 || stickers.length === 0) {
        const chunks = splitTelegramText(cleanText, TELEGRAM_MAX_TEXT_LEN);
        for (let i = 0; i < chunks.length; i++) {
          const payload: Record<string, unknown> = {
            chat_id: options?.target,
            text: chunks[i],
          };
          if (i === 0 && options?.replyToMessageId && /^\d+$/.test(options.replyToMessageId)) {
            payload.reply_to_message_id = Number(options.replyToMessageId);
          }
          if (i === chunks.length - 1 && options?.replyMarkup) {
            payload.reply_markup = options.replyMarkup;
          }
          await this.postSendMessage(sendUrl, channel.botToken, payload);
        }
      }

      for (let i = 0; i < stickers.length; i++) {
        const expr = stickers[i]!;
        const attachReplyMarkup = cleanText.length === 0 && i === stickers.length - 1 ? options?.replyMarkup : undefined;
        try {
          await this.sendAttachment(
            channel,
            resolveBotStickerPath(expr),
            `bot-${expr}.gif`,
            {
              target: options!.target!,
              replyToMessageId: i === 0 && cleanText.length === 0 ? options?.replyToMessageId : undefined,
              animation: true,
              ...(attachReplyMarkup ? { replyMarkup: attachReplyMarkup } : {}),
            },
          );
        } catch {
          const fallbackPayload: Record<string, unknown> = {
            chat_id: options?.target,
            text: BOT_EXPRESSION_META[expr].plainEmoji,
          };
          if (i === 0 && cleanText.length === 0 && options?.replyToMessageId && /^\d+$/.test(options.replyToMessageId)) {
            fallbackPayload.reply_to_message_id = Number(options.replyToMessageId);
          }
          if (attachReplyMarkup) {
            fallbackPayload.reply_markup = attachReplyMarkup;
          }
          await this.postSendMessage(sendUrl, channel.botToken, fallbackPayload);
        }
      }
      return;
    }

    const mapped = transformOutboundBotExpressions(text, 'telegram');
    let outText = mapped.text;
    if (!outText.trim()) {
      const fallback = splitTelegramTokens(text);
      if (fallback.stickers.length > 0) {
        outText = fallback.stickers.map(expr => BOT_EXPRESSION_META[expr].plainEmoji).join(' ');
      }
    }
    const chunks = splitTelegramText(outText, TELEGRAM_MAX_TEXT_LEN);
    const webhookUrl = channel.webhookUrl!;
    for (let i = 0; i < chunks.length; i++) {
      const payload: Record<string, unknown> = {
        chat_id: options?.target,
        text: chunks[i],
      };
      if (i === 0 && options?.replyToMessageId && /^\d+$/.test(options.replyToMessageId)) {
        payload.reply_to_message_id = Number(options.replyToMessageId);
      }
      if (i === chunks.length - 1 && options?.replyMarkup) {
        payload.reply_markup = options.replyMarkup;
      }
      await this.postSendMessage(webhookUrl, channel.botToken, payload);
    }
  }

  async poll(channel: ImChannelConfig): Promise<{ receivedAny: boolean }> {
    if (!channel.botToken) return { receivedAny: false };
    const base = normalizeTelegramApiBase(channel.apiBase);
    const params = new URLSearchParams({ timeout: '0' });
    if (channel.pollOffset !== undefined) {
      params.set('offset', String(channel.pollOffset));
    }
    let res: Response;
    try {
      res = await fetch(`${base}/bot${channel.botToken}/getUpdates?${params}`, {
        signal: buildRequestSignal(DEFAULT_NETWORK_TIMEOUT_MS, this.ctx.shutdownSignal),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Network error';
      throw new Error(`Telegram getUpdates 失败: ${redactBotToken(msg, channel.botToken)}`);
    }
    if (!res.ok) {
      throw new Error(`Telegram getUpdates HTTP ${res.status}`);
    }
    const data = await res.json() as { ok?: boolean; result?: Array<Record<string, unknown>> };
    if (!data.ok || !Array.isArray(data.result)) {
      return { receivedAny: false };
    }
    const receivedAny = data.result.length > 0;
    for (const update of data.result) {
      const updateId = Number(update.update_id);
      if (Number.isSafeInteger(updateId)) {
        const current = this.ctx.coordinator.store.getImChannel(channel.id);
        current.pollOffset = Math.max(current.pollOffset ?? 0, updateId + 1);
        this.ctx.coordinator.store.saveImChannel(current);
      }
      const inbound = parseTelegramUpdate(channel.id, update);
      if (inbound) {
        await this.ctx.ingestMessage(inbound);
      }
    }
    return { receivedAny };
  }

  async handleWebhook(
    channel: ImChannelConfig,
    method: string,
    _query: URLSearchParams,
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<ImWebhookResponse> {
    if (method !== 'POST') {
      return jsonWebhookResponse(405, { error: 'Method not allowed' });
    }
    if (channel.secret) {
      const tokenHeader = readHeaderValue(headers, 'x-telegram-bot-api-secret-token') ?? '';
      if (!tokenHeader || !safeEqual(tokenHeader, channel.secret)) {
        return jsonWebhookResponse(403, { error: 'Invalid Telegram secret token' });
      }
    }
    const update = JSON.parse(rawBody || '{}') as Record<string, unknown>;
    return finalizeWebhookInbound(this.ctx, parseTelegramUpdate(channel.id, update));
  }

  private async postSendMessage(
    url: string,
    botToken: string | undefined,
    payload: Record<string, unknown>,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: buildRequestSignal(DEFAULT_NETWORK_TIMEOUT_MS, this.ctx.shutdownSignal),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Network error';
      throw new Error(`Telegram 发送失败: ${redactBotToken(msg, botToken)}`);
    }
    if (!res.ok) {
      throw new Error(`Telegram 发送失败: HTTP ${res.status}`);
    }
    const rawText = await res.text().catch(() => '');
    if (rawText) {
      try {
        const data = JSON.parse(rawText) as { ok?: boolean; description?: string };
        if (data.ok === false) {
          throw new Error(`Telegram 发送失败: ${redactBotToken(data.description ?? 'API error', botToken)}`);
        }
      } catch (err) {
        if (err instanceof SyntaxError) return;
        throw err;
      }
    }
  }

  private async postBotApi(
    base: string,
    token: string,
    method: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: buildRequestSignal(DEFAULT_NETWORK_TIMEOUT_MS, this.ctx.shutdownSignal),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Network error';
      throw new Error(`Telegram ${method} 请求失败: ${redactBotToken(msg, token)}`);
    }
    const payload = await res.json().catch(() => ({})) as { ok?: boolean; description?: string };
    if (!res.ok || payload.ok === false) {
      const detail = payload.description
        ? redactBotToken(payload.description, token)
        : `HTTP ${res.status}`;
      throw new Error(`Telegram ${method} 失败: ${detail}`);
    }
  }
}

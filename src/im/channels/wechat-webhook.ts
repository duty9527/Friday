import { createHash, randomUUID } from 'node:crypto';
import type { ImChannelConfig } from '../../store.js';
import {
  buildRequestSignal,
  DEFAULT_NETWORK_TIMEOUT_MS,
  finalizeWebhookInbound,
  isAllowedReplyWebhook,
  jsonWebhookResponse,
  parseJsonObjectBody,
  readHeaderValue,
  safeEqual,
  sanitizeImError,
  type ImChannelAdapter,
  type ImGatewayContext,
  type ImInboundMessage,
  type ImSendOptions,
  type ImWebhookResponse,
} from '../types.js';
import { parseWechatIlinkMessage } from './wechat-ilink.js';
import { BOT_EXPRESSION_META, transformOutboundBotExpressions } from '../../web/shared/bot-expressions.js';

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&#(\d+);/g, (m, code) => {
      const n = Number(code);
      return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => {
      const n = Number.parseInt(hex, 16);
      return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    })
    .replace(/&amp;/g, '&');
}

function extractXmlTag(xml: string, tag: string): string | undefined {
  const cdata = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i').exec(xml);
  if (cdata) return cdata[1];
  const plain = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  return plain?.[1] !== undefined ? decodeXmlEntities(plain[1]) : undefined;
}

function computeWechatSha1(secret: string, timestamp: string, nonce: string): string {
  return createHash('sha1').update([secret, timestamp, nonce].sort().join('')).digest('hex');
}

/** Channel adapter for Enterprise WeChat bot webhooks, Official Accounts, and XML/JSON bridges. */
export class WechatWebhookAdapter implements ImChannelAdapter {
  readonly platform = 'wechat' as const;

  constructor(private readonly ctx: ImGatewayContext) {}

  async send(channel: ImChannelConfig, text: string, options?: ImSendOptions): Promise<void> {
    const requestedReplyWebhook = options?.replyWebhook?.trim();
    if (requestedReplyWebhook && !isAllowedReplyWebhook('wechat', requestedReplyWebhook, channel)) {
      throw new Error('拒绝向未授权的微信回调地址发送消息');
    }
    const configuredUrl = channel.webhookUrl?.trim()
      || (channel.apiBase?.trim() ? `${channel.apiBase.trim().replace(/\/$/, '')}/send` : undefined);
    const url = requestedReplyWebhook || configuredUrl;
    if (!url) {
      throw new Error('微信通道缺少扫码绑定凭证(botToken)或 webhookUrl');
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // Never forward botToken Bearer credentials to an inbound-supplied dynamic replyWebhook.
    const sameAsConfiguredWebhook = Boolean(channel.webhookUrl?.trim() && url === channel.webhookUrl.trim());
    if (channel.botToken && (!requestedReplyWebhook || sameAsConfiguredWebhook)) {
      headers.authorization = `Bearer ${channel.botToken}`;
    }
    const mapped = transformOutboundBotExpressions(text, 'wechat');
    const finalText = (!mapped.text.trim() && mapped.stickers.length > 0)
      ? mapped.stickers.map(expr => BOT_EXPRESSION_META[expr].wechatFallback).join(' ')
      : mapped.text;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        redirect: 'error',
        signal: buildRequestSignal(DEFAULT_NETWORK_TIMEOUT_MS, this.ctx.shutdownSignal),
        body: JSON.stringify({
          msgtype: 'text',
          touser: options?.target,
          text: { content: finalText },
          content: finalText,
        }),
      });
    } catch (err) {
      throw new Error(sanitizeImError(err, [channel.botToken, channel.secret]));
    }
    if (!res.ok) {
      throw new Error(`微信发送失败: HTTP ${res.status}`);
    }
  }

  async handleWebhook(
    channel: ImChannelConfig,
    method: string,
    query: URLSearchParams,
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<ImWebhookResponse> {
    const secret = channel.secret?.trim();
    if (method === 'GET') {
      if (!secret) {
        return { status: 403, body: 'WeChat webhook secret is required', contentType: 'text/plain; charset=utf-8' };
      }
      const echostr = query.get('echostr') ?? 'ok';
      const signature = query.get('signature') ?? query.get('msg_signature') ?? '';
      const timestamp = query.get('timestamp') ?? '';
      const nonce = query.get('nonce') ?? '';
      const expected = computeWechatSha1(secret, timestamp, nonce);
      if (!signature || !safeEqual(signature, expected)) {
        return { status: 403, body: 'Invalid WeChat signature', contentType: 'text/plain; charset=utf-8' };
      }
      return { status: 200, body: echostr, contentType: 'text/plain; charset=utf-8' };
    }

    if (method !== 'POST') {
      return jsonWebhookResponse(405, { error: 'Method not allowed' });
    }

    if (!secret) {
      return jsonWebhookResponse(403, { error: 'WeChat webhook secret is required' });
    }

    const headerSecret = readHeaderValue(headers, 'x-wechat-secret')
      ?? readHeaderValue(headers, 'x-openclaw-secret')
      ?? query.get('secret')
      ?? '';
    const signature = query.get('signature') ?? '';
    const timestamp = query.get('timestamp') ?? '';
    const nonce = query.get('nonce') ?? '';
    const expectedSha1 = computeWechatSha1(secret, timestamp, nonce);
    const validHeader = Boolean(headerSecret) && safeEqual(headerSecret, secret);
    const validSha1 = Boolean(signature) && safeEqual(signature, expectedSha1);
    if (!validHeader && !validSha1) {
      return jsonWebhookResponse(403, { error: 'Invalid WeChat webhook secret or signature' });
    }

    const trimmed = rawBody.trim();
    let inbound: ImInboundMessage | undefined;
    if (trimmed.startsWith('<')) {
      const content = (extractXmlTag(trimmed, 'Content') ?? '').trim();
      const fromUser = extractXmlTag(trimmed, 'FromUserName')?.trim() || 'wechat-user';
      const msgId = extractXmlTag(trimmed, 'MsgId')?.trim() || randomUUID();
      if (content) {
        inbound = { channelId: channel.id, externalId: msgId, senderId: fromUser, target: fromUser, text: content };
      }
    } else {
      const parsed = parseJsonObjectBody(trimmed || '{}');
      if (!parsed.ok) {
        return jsonWebhookResponse(400, { error: 'Invalid JSON payload' });
      }
      const payload = parsed.data;
      const ilinkParsed = parseWechatIlinkMessage(channel.id, payload, channel.accountId);
      if (ilinkParsed) {
        inbound = ilinkParsed;
      } else {
        const textObj = payload.text as Record<string, unknown> | undefined;
        const content = String(
          (typeof payload.text === 'string' ? payload.text : textObj?.content)
          ?? payload.content
          ?? payload.Content
          ?? '',
        ).trim();
        const senderId = String(payload.from ?? payload.senderId ?? payload.FromUserName ?? '').trim() || 'wechat-user';
        const senderName = typeof payload.senderName === 'string' ? payload.senderName.trim() : undefined;
        const externalId = String(payload.msgId ?? payload.MsgId ?? payload.id ?? '').trim() || randomUUID();
        const target = String(payload.chatId ?? payload.roomId ?? '').trim() || senderId;
        const rawReplyWebhook = typeof payload.replyWebhook === 'string'
          ? payload.replyWebhook.trim()
          : typeof payload.sessionWebhook === 'string' ? payload.sessionWebhook.trim() : undefined;
        if (rawReplyWebhook && !isAllowedReplyWebhook('wechat', rawReplyWebhook, channel)) {
          return jsonWebhookResponse(400, { error: 'Untrusted replyWebhook URL' });
        }
        const contextToken = typeof payload.context_token === 'string' ? payload.context_token : undefined;
        if (content) {
          inbound = { channelId: channel.id, externalId, senderId, senderName, target, text: content, replyWebhook: rawReplyWebhook, contextToken };
        }
      }
    }

    return finalizeWebhookInbound(this.ctx, inbound);
  }
}

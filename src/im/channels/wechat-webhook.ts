import { createHash, randomUUID } from 'node:crypto';
import type { ImChannelConfig } from '../../store.js';
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
} from '../types.js';
import { parseWechatIlinkMessage } from './wechat-ilink.js';
import { BOT_EXPRESSION_META, transformOutboundBotExpressions } from '../../web/shared/bot-expressions.js';

function extractXmlTag(xml: string, tag: string): string | undefined {
  const cdata = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i').exec(xml);
  if (cdata) return cdata[1];
  const plain = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml);
  return plain?.[1];
}

function computeWechatSha1(secret: string, timestamp: string, nonce: string): string {
  return createHash('sha1').update([secret, timestamp, nonce].sort().join('')).digest('hex');
}

/** Channel adapter for Enterprise WeChat bot webhooks, Official Accounts, and XML/JSON bridges. */
export class WechatWebhookAdapter implements ImChannelAdapter {
  readonly platform = 'wechat' as const;

  constructor(private readonly ctx: ImGatewayContext) {}

  async send(channel: ImChannelConfig, text: string, options?: ImSendOptions): Promise<void> {
    const url = options?.replyWebhook
      ?? channel.webhookUrl
      ?? (channel.apiBase ? `${channel.apiBase.replace(/\/$/, '')}/send` : undefined);
    if (!url) {
      throw new Error('微信通道缺少扫码绑定凭证(botToken)或 webhookUrl');
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (channel.botToken) {
      headers.authorization = `Bearer ${channel.botToken}`;
    }
    const mapped = transformOutboundBotExpressions(text, 'wechat');
    const finalText = (!mapped.text.trim() && mapped.stickers.length > 0)
      ? mapped.stickers.map(expr => BOT_EXPRESSION_META[expr].wechatFallback).join(' ')
      : mapped.text;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: buildRequestSignal(DEFAULT_NETWORK_TIMEOUT_MS, this.ctx.shutdownSignal),
      body: JSON.stringify({
        msgtype: 'text',
        touser: options?.target,
        text: { content: finalText },
        content: finalText,
      }),
    });
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
    if (method === 'GET') {
      const echostr = query.get('echostr') ?? 'ok';
      if (channel.secret) {
        const signature = query.get('signature') ?? query.get('msg_signature') ?? '';
        const timestamp = query.get('timestamp') ?? '';
        const nonce = query.get('nonce') ?? '';
        const expected = computeWechatSha1(channel.secret, timestamp, nonce);
        if (!signature || !safeEqual(signature, expected)) {
          return { status: 403, body: 'Invalid WeChat signature', contentType: 'text/plain; charset=utf-8' };
        }
      }
      return { status: 200, body: echostr, contentType: 'text/plain; charset=utf-8' };
    }

    if (method !== 'POST') {
      return jsonWebhookResponse(405, { error: 'Method not allowed' });
    }

    if (channel.secret) {
      const headerSecret = readHeaderValue(headers, 'x-wechat-secret')
        ?? readHeaderValue(headers, 'x-openclaw-secret')
        ?? query.get('secret')
        ?? '';
      const signature = query.get('signature') ?? '';
      const timestamp = query.get('timestamp') ?? '';
      const nonce = query.get('nonce') ?? '';
      const expectedSha1 = computeWechatSha1(channel.secret, timestamp, nonce);
      const validHeader = Boolean(headerSecret) && safeEqual(headerSecret, channel.secret);
      const validSha1 = Boolean(signature) && safeEqual(signature, expectedSha1);
      if (!validHeader && !validSha1) {
        return jsonWebhookResponse(403, { error: 'Invalid WeChat webhook secret or signature' });
      }
    }

    const trimmed = rawBody.trim();
    let inbound: ImInboundMessage | undefined;
    if (trimmed.startsWith('<')) {
      const content = (extractXmlTag(trimmed, 'Content') ?? '').trim();
      const fromUser = (extractXmlTag(trimmed, 'FromUserName') ?? 'wechat-user').trim();
      const msgId = (extractXmlTag(trimmed, 'MsgId') ?? randomUUID()).trim();
      if (content) {
        inbound = { channelId: channel.id, externalId: msgId, senderId: fromUser, target: fromUser, text: content };
      }
    } else {
      const payload = JSON.parse(trimmed || '{}') as Record<string, unknown>;
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
        const senderId = String(payload.from ?? payload.senderId ?? payload.FromUserName ?? 'wechat-user').trim();
        const senderName = typeof payload.senderName === 'string' ? payload.senderName.trim() : undefined;
        const externalId = String(payload.msgId ?? payload.MsgId ?? payload.id ?? randomUUID());
        const target = String(payload.chatId ?? payload.roomId ?? senderId);
        const replyWebhook = typeof payload.replyWebhook === 'string'
          ? payload.replyWebhook
          : typeof payload.sessionWebhook === 'string' ? payload.sessionWebhook : undefined;
        const contextToken = typeof payload.context_token === 'string' ? payload.context_token : undefined;
        if (content) {
          inbound = { channelId: channel.id, externalId, senderId, senderName, target, text: content, replyWebhook, contextToken };
        }
      }
    }

    return finalizeWebhookInbound(this.ctx, inbound);
  }
}

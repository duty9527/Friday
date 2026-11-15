import { createHmac, randomUUID } from 'node:crypto';
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

/** Compute Base64 HMAC-SHA256 signature required by DingTalk webhook bots. */
function signDingtalkPayload(timestamp: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}\n${secret}`)
    .digest('base64');
}

/** Channel adapter for DingTalk custom & enterprise robot webhooks. */
export class DingtalkChannelAdapter implements ImChannelAdapter {
  readonly platform = 'dingtalk' as const;

  constructor(private readonly ctx: ImGatewayContext) {}

  async send(channel: ImChannelConfig, text: string, options?: ImSendOptions): Promise<void> {
    let url = options?.replyWebhook ?? channel.webhookUrl;
    if (!url) {
      throw new Error('钉钉通道缺少 webhookUrl 或 sessionWebhook');
    }
    if (!options?.replyWebhook && channel.secret) {
      const timestamp = String(Date.now());
      const sign = signDingtalkPayload(timestamp, channel.secret);
      const parsed = new URL(url);
      parsed.searchParams.set('timestamp', timestamp);
      parsed.searchParams.set('sign', sign);
      url = parsed.toString();
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'text',
        text: { content: text },
      }),
      signal: buildRequestSignal(DEFAULT_NETWORK_TIMEOUT_MS, this.ctx.shutdownSignal),
    });
    if (!res.ok) {
      throw new Error(`钉钉发送失败: HTTP ${res.status}`);
    }
  }

  async handleWebhook(
    channel: ImChannelConfig,
    method: string,
    query: URLSearchParams,
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<ImWebhookResponse> {
    if (method !== 'POST') {
      return jsonWebhookResponse(405, { error: 'Method not allowed' });
    }
    if (channel.secret) {
      const timestamp = readHeaderValue(headers, 'timestamp') ?? query.get('timestamp') ?? '';
      const sign = readHeaderValue(headers, 'sign') ?? query.get('sign') ?? '';
      const expected = signDingtalkPayload(timestamp, channel.secret);
      if (!timestamp || !sign || !safeEqual(sign, expected)) {
        return jsonWebhookResponse(403, { error: 'Invalid DingTalk signature' });
      }
    }
    const payload = JSON.parse(rawBody || '{}') as Record<string, unknown>;
    const textObj = payload.text as Record<string, unknown> | undefined;
    const content = String(textObj?.content ?? payload.content ?? '').trim();
    let inbound: ImInboundMessage | undefined;
    if (content) {
      const senderId = String(payload.senderStaffId ?? payload.senderId ?? 'dingtalk-user').trim();
      const senderName = typeof payload.senderNick === 'string' ? payload.senderNick.trim() : undefined;
      const externalId = String(payload.msgId ?? randomUUID());
      const target = String(payload.conversationId ?? senderId);
      const replyWebhook = typeof payload.sessionWebhook === 'string' ? payload.sessionWebhook : undefined;
      inbound = { channelId: channel.id, externalId, senderId, senderName, target, text: content, replyWebhook };
    }
    return finalizeWebhookInbound(this.ctx, inbound);
  }
}

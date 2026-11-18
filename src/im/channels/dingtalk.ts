import { createHmac, randomUUID } from 'node:crypto';
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

const DINGTALK_TIMESTAMP_WINDOW_MS = 3_600_000;

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
    if (options?.replyWebhook && !isAllowedReplyWebhook('dingtalk', options.replyWebhook, channel)) {
      throw new Error('拒绝向未授权的钉钉 sessionWebhook 发送消息');
    }
    let url = options?.replyWebhook?.trim() || channel.webhookUrl?.trim();
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
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: text },
        }),
        redirect: 'error',
        signal: buildRequestSignal(DEFAULT_NETWORK_TIMEOUT_MS, this.ctx.shutdownSignal),
      });
    } catch (err) {
      throw new Error(sanitizeImError(err, [channel.secret]));
    }
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
    const secret = channel.secret?.trim();
    if (!secret) {
      return jsonWebhookResponse(403, { error: 'DingTalk webhook secret is required' });
    }
    const timestamp = readHeaderValue(headers, 'timestamp') ?? query.get('timestamp') ?? '';
    const sign = readHeaderValue(headers, 'sign') ?? query.get('sign') ?? '';
    const tsNum = Number(timestamp);
    if (!timestamp || !Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > DINGTALK_TIMESTAMP_WINDOW_MS) {
      return jsonWebhookResponse(403, { error: 'Expired or invalid DingTalk timestamp' });
    }
    const expected = signDingtalkPayload(timestamp, secret);
    if (!sign || !safeEqual(sign, expected)) {
      return jsonWebhookResponse(403, { error: 'Invalid DingTalk signature' });
    }
    const parsed = parseJsonObjectBody(rawBody || '{}');
    if (!parsed.ok) {
      return jsonWebhookResponse(400, { error: 'Invalid JSON payload' });
    }
    const payload = parsed.data;
    const rawSessionWebhook = typeof payload.sessionWebhook === 'string' ? payload.sessionWebhook.trim() : undefined;
    if (rawSessionWebhook && !isAllowedReplyWebhook('dingtalk', rawSessionWebhook, channel)) {
      return jsonWebhookResponse(400, { error: 'Untrusted sessionWebhook URL' });
    }
    const textObj = payload.text as Record<string, unknown> | undefined;
    const content = String(textObj?.content ?? payload.content ?? '').trim();
    let inbound: ImInboundMessage | undefined;
    if (content) {
      const senderId = String(payload.senderStaffId ?? payload.senderId ?? 'dingtalk-user').trim();
      const senderName = typeof payload.senderNick === 'string' ? payload.senderNick.trim() : undefined;
      const externalId = String(payload.msgId ?? randomUUID());
      const target = String(payload.conversationId ?? senderId);
      inbound = { channelId: channel.id, externalId, senderId, senderName, target, text: content, replyWebhook: rawSessionWebhook };
    }
    return finalizeWebhookInbound(this.ctx, inbound);
  }
}

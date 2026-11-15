import { randomUUID } from 'node:crypto';
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

/** Parse a Telegram Bot API update payload into a normalized inbound message. */
export function parseTelegramUpdate(channelId: string, update: Record<string, unknown>): ImInboundMessage | undefined {
  const msg = (update.message ?? update.edited_message) as Record<string, unknown> | undefined;
  if (!msg) return undefined;
  const text = String(msg.text ?? msg.caption ?? '').trim();
  if (!text) return undefined;
  const from = (msg.from ?? {}) as Record<string, unknown>;
  const chat = (msg.chat ?? {}) as Record<string, unknown>;
  const senderId = String(from.id ?? chat.id ?? 'tg-user');
  const senderUsername = typeof from.username === 'string' ? from.username : undefined;
  const senderName = [from.first_name, from.last_name].filter(Boolean).join(' ') || senderUsername || senderId;
  const target = String(chat.id ?? senderId);
  const externalId = String(msg.message_id ?? update.update_id ?? randomUUID());
  return { channelId, externalId, senderId, senderName, senderUsername, target, text };
}

/** Channel adapter for Telegram Bot API (`sendMessage`, `getUpdates` polling, and webhook). */
export class TelegramChannelAdapter implements ImChannelAdapter {
  readonly platform = 'telegram' as const;

  constructor(private readonly ctx: ImGatewayContext) {}

  async send(channel: ImChannelConfig, text: string, options?: ImSendOptions): Promise<void> {
    if (!channel.botToken && !channel.webhookUrl) {
      throw new Error('Telegram 通道缺少 botToken 或 webhookUrl');
    }
    if (!options?.target && !channel.webhookUrl) {
      throw new Error('Telegram 通道缺少目标 Chat ID（可先向机器人发送一条消息自动绑定，或配置 defaultTarget）');
    }
    const url = channel.webhookUrl
      ? channel.webhookUrl
      : `${(channel.apiBase ?? 'https://api.telegram.org').replace(/\/$/, '')}/bot${channel.botToken}/sendMessage`;
    const payload: Record<string, unknown> = {
      chat_id: options?.target,
      text,
    };
    if (options?.replyToMessageId && /^\d+$/.test(options.replyToMessageId)) {
      payload.reply_to_message_id = Number(options.replyToMessageId);
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: buildRequestSignal(DEFAULT_NETWORK_TIMEOUT_MS, this.ctx.shutdownSignal),
    });
    if (!res.ok) {
      throw new Error(`Telegram 发送失败: HTTP ${res.status}`);
    }
  }

  async poll(channel: ImChannelConfig): Promise<{ receivedAny: boolean }> {
    if (!channel.botToken) return { receivedAny: false };
    const base = (channel.apiBase ?? 'https://api.telegram.org').replace(/\/$/, '');
    const params = new URLSearchParams({ timeout: '0' });
    if (channel.pollOffset !== undefined) {
      params.set('offset', String(channel.pollOffset));
    }
    const res = await fetch(`${base}/bot${channel.botToken}/getUpdates?${params}`, {
      signal: buildRequestSignal(DEFAULT_NETWORK_TIMEOUT_MS, this.ctx.shutdownSignal),
    });
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
}

import type { DatabaseSync } from 'node:sqlite';
import type { ImChannelView, ImPlatform, MessageOrigin, QuietHoursConfig, RejectedStrangerView, TimerRunStatus } from '../view.js';

export interface Timer {
  id: string;
  name: string;
  instruction: string;
  intervalMs: number;
  dailyAt?: string;
  once?: boolean;
  plugin?: string;
  pluginAction?: string;
  deliverChannelId?: string;
  deliverTarget?: string;
  cwd?: string;
  enabled: boolean;
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  activeTaskId?: string;
  pendingCatchup?: boolean;
  missedRuns: number;
  origin?: MessageOrigin;
  goalCondition?: string;
  goalMetAt?: number;
  goalSummary?: string;
  maxFailures?: number;
  consecutiveFailures?: number;
  fatiguePaused?: boolean;
  lastRunStatus?: TimerRunStatus;
  lastError?: string;
  firstFailureNotified?: boolean;
}

export interface ImChannelConfig {
  id: string;
  platform: ImPlatform;
  name: string;
  enabled: boolean;
  notifyAll: boolean;
  botToken?: string;
  accountId?: string;
  syncBuf?: string;
  contextTokens?: Record<string, string>;
  contextTokenUpdatedAt?: Record<string, number>;
  webhookUrl?: string;
  secret?: string;
  defaultTarget?: string;
  allowedSenders: string[];
  /** Telegram group chat IDs, optionally followed by `:messageThreadId`. */
  telegramMentionExempt?: string[];
  apiBase?: string;
  cdnBaseUrl?: string;
  readLinks?: boolean;
  quietHours?: QuietHoursConfig;
  rejectedSenders?: RejectedStrangerView[];
  pollIntervalMs?: number;
  pollOffset?: number;
  inboundCount: number;
  outboundCount: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface WechatQuoteRecord {
  channelId: string;
  accountId?: string;
  conversationId: string;
  messageId: string;
  direction: 'inbound' | 'outbound';
  body: string;
  mediaPath?: string;
  mediaMime?: string;
  mediaName?: string;
  createdAt?: number;
}

const QUOTE_CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const QUOTE_CACHE_MAX_PER_ACCOUNT = 10_000;
const QUOTE_CACHE_PRUNE_INTERVAL = 100;
const QUOTE_CACHE_MAX_BODY_CHARS = 8_000;

function parseJsonSafe<T>(raw: unknown): T | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return undefined;
  }
}

function maskUrlCredentials(raw?: string): string | undefined {
  if (!raw) return raw;
  return raw.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/:@\s,;]+):[^@\s,;]+@/g, '$1:***@');
}

/**
 * Persistence for scheduled timers and external IM channel configurations.
 */
export class RuntimeOpsStore {
  private quoteCacheWritesSincePrune = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly atomic: <T>(run: () => T) => T = run => run(),
  ) {}

  saveTimer(timer: Timer): void {
    this.atomic(() => {
      this.db.prepare('INSERT INTO timers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
        .run(timer.id, JSON.stringify(timer));
    });
  }

  getTimer(id: string): Timer {
    const row = this.db.prepare('SELECT body FROM timers WHERE id=?').get(id);
    if (!row) throw new Error('Timer not found');
    const parsed = parseJsonSafe<Timer>(row.body);
    if (!parsed) throw new Error('Corrupt timer record');
    return parsed;
  }

  listTimers(): Timer[] {
    const out: Timer[] = [];
    for (const row of this.db.prepare('SELECT body FROM timers ORDER BY rowid').all()) {
      const parsed = parseJsonSafe<Timer>(row.body);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  deleteTimer(id: string): boolean {
    return this.atomic(() => this.db.prepare('DELETE FROM timers WHERE id=?').run(id).changes > 0);
  }

  saveImChannel(channel: ImChannelConfig): ImChannelConfig {
    this.atomic(() => {
      this.db.prepare(
        'INSERT INTO im_channels(id,platform,updated_at,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET platform=excluded.platform,updated_at=excluded.updated_at,body=excluded.body',
      ).run(channel.id, channel.platform, channel.updatedAt, JSON.stringify(channel));
    });
    return channel;
  }

  getImChannel(id: string): ImChannelConfig {
    const row = this.db.prepare('SELECT body FROM im_channels WHERE id=?').get(id);
    if (!row) throw new Error('IM channel not found');
    const parsed = parseJsonSafe<ImChannelConfig>(row.body);
    if (!parsed) throw new Error('Corrupt IM channel record');
    return parsed;
  }

  listImChannels(): ImChannelConfig[] {
    const out: ImChannelConfig[] = [];
    for (const row of this.db.prepare('SELECT body FROM im_channels ORDER BY rowid').all()) {
      const parsed = parseJsonSafe<ImChannelConfig>(row.body);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  toImChannelView(channel: ImChannelConfig): ImChannelView {
    let webhookUrlMasked: string | undefined;
    if (channel.webhookUrl) {
      try {
        const u = new URL(channel.webhookUrl);
        webhookUrlMasked = `${u.origin}${u.pathname.slice(0, 24)}${u.pathname.length > 24 || u.search ? '…' : ''}`;
      } catch {
        const masked = maskUrlCredentials(channel.webhookUrl) ?? channel.webhookUrl;
        webhookUrlMasked = masked.slice(0, 24) + '…';
      }
    }
    return {
      id: channel.id,
      platform: channel.platform,
      name: channel.name,
      enabled: channel.enabled,
      notifyAll: channel.notifyAll,
      hasBotToken: Boolean(channel.botToken),
      hasSecret: Boolean(channel.secret),
      accountId: channel.accountId,
      loginStatus: channel.platform === 'wechat'
        ? (channel.botToken ? 'bound' : 'unbound')
        : channel.platform === 'telegram'
          ? ((channel.botToken || channel.webhookUrl) ? 'bound' : 'unbound')
          : channel.platform === 'xiaoai'
            ? (Boolean(channel.botToken || channel.webhookUrl || channel.apiBase?.startsWith('ssh://')) ? 'bound' : 'unbound')
            : undefined,
      webhookUrlMasked,
      defaultTarget: channel.defaultTarget,
      allowedSenders: channel.allowedSenders,
      ...(channel.telegramMentionExempt !== undefined ? { telegramMentionExempt: channel.telegramMentionExempt } : {}),
      apiBase: maskUrlCredentials(channel.apiBase),
      cdnBaseUrl: maskUrlCredentials(channel.cdnBaseUrl),
      readLinks: channel.readLinks,
      quietHours: channel.quietHours,
      rejectedSenders: channel.rejectedSenders,
      pollIntervalMs: channel.pollIntervalMs,
      inboundCount: channel.inboundCount,
      outboundCount: channel.outboundCount,
      lastInboundAt: channel.lastInboundAt,
      lastOutboundAt: channel.lastOutboundAt,
      lastError: channel.lastError,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    };
  }

  listImChannelViews(): ImChannelView[] {
    return this.listImChannels().map(channel => this.toImChannelView(channel));
  }

  saveWechatQuoteRecord(record: WechatQuoteRecord): void {
    const channelId = record.channelId.trim();
    const conversationId = record.conversationId.trim();
    const messageId = record.messageId.trim();
    if (!channelId || !conversationId || !messageId) return;
    const accountId = (record.accountId ?? '').trim();
    const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
      ? record.createdAt
      : Date.now();
    const body = record.body.length > QUOTE_CACHE_MAX_BODY_CHARS
      ? record.body.slice(0, QUOTE_CACHE_MAX_BODY_CHARS)
      : record.body;

    this.atomic(() => {
      this.db.prepare(
        `INSERT INTO wechat_quote_cache(
          channel_id, account_id, conversation_id, message_id,
          direction, body, media_path, media_mime, media_name, created_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(channel_id, account_id, conversation_id, message_id) DO UPDATE SET
          direction=excluded.direction,
          body=CASE WHEN excluded.body != '' THEN excluded.body ELSE wechat_quote_cache.body END,
          media_path=COALESCE(excluded.media_path, wechat_quote_cache.media_path),
          media_mime=COALESCE(excluded.media_mime, wechat_quote_cache.media_mime),
          media_name=COALESCE(excluded.media_name, wechat_quote_cache.media_name),
          created_at=MAX(excluded.created_at, wechat_quote_cache.created_at)`,
      ).run(
        channelId,
        accountId,
        conversationId,
        messageId,
        record.direction,
        body,
        record.mediaPath ?? null,
        record.mediaMime ?? null,
        record.mediaName ?? null,
        createdAt,
      );

      this.quoteCacheWritesSincePrune += 1;
      if (this.quoteCacheWritesSincePrune >= QUOTE_CACHE_PRUNE_INTERVAL) {
        this.quoteCacheWritesSincePrune = 0;
        const cutoff = createdAt - QUOTE_CACHE_RETENTION_MS;
        this.db.prepare(
          'DELETE FROM wechat_quote_cache WHERE channel_id=? AND account_id=? AND created_at < ?',
        ).run(channelId, accountId, cutoff);
        this.db.prepare(
          `DELETE FROM wechat_quote_cache
           WHERE channel_id=? AND account_id=? AND message_id IN (
             SELECT message_id FROM wechat_quote_cache
             WHERE channel_id=? AND account_id=?
             ORDER BY created_at DESC
             LIMIT -1 OFFSET ?
           )`,
        ).run(channelId, accountId, channelId, accountId, QUOTE_CACHE_MAX_PER_ACCOUNT);
      }
    });
  }

  findWechatQuoteRecord(
    channelId: string,
    accountId: string | undefined,
    conversationId: string,
    messageId: string,
  ): WechatQuoteRecord | undefined {
    const cleanChannel = channelId.trim();
    const cleanConv = conversationId.trim();
    const cleanMsg = messageId.trim();
    if (!cleanChannel || !cleanConv || !cleanMsg) return undefined;
    const cleanAcc = (accountId ?? '').trim();
    const row = this.db.prepare(
      `SELECT channel_id, account_id, conversation_id, message_id, direction, body, media_path, media_mime, media_name, created_at
       FROM wechat_quote_cache
       WHERE channel_id=? AND account_id=? AND conversation_id=? AND message_id=?`,
    ).get(cleanChannel, cleanAcc, cleanConv, cleanMsg) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      channelId: String(row.channel_id),
      ...(row.account_id ? { accountId: String(row.account_id) } : {}),
      conversationId: String(row.conversation_id),
      messageId: String(row.message_id),
      direction: row.direction === 'outbound' ? 'outbound' : 'inbound',
      body: String(row.body ?? ''),
      ...(typeof row.media_path === 'string' && row.media_path ? { mediaPath: row.media_path } : {}),
      ...(typeof row.media_mime === 'string' && row.media_mime ? { mediaMime: row.media_mime } : {}),
      ...(typeof row.media_name === 'string' && row.media_name ? { mediaName: row.media_name } : {}),
      ...(typeof row.created_at === 'number' ? { createdAt: row.created_at } : {}),
    };
  }

  deleteImChannel(id: string): boolean {
    return this.atomic(() => {
      this.db.prepare('DELETE FROM wechat_quote_cache WHERE channel_id=?').run(id);
      return this.db.prepare('DELETE FROM im_channels WHERE id=?').run(id).changes > 0;
    });
  }
}

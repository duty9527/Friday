import type { DatabaseSync } from 'node:sqlite';
import type { ImChannelView, ImPlatform, MessageOrigin } from '../view.js';

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
  apiBase?: string;
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

/**
 * Persistence for scheduled timers and external IM channel configurations.
 */
export class RuntimeOpsStore {
  constructor(private readonly db: DatabaseSync) {}

  saveTimer(timer: Timer): void {
    this.db.prepare('INSERT INTO timers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(timer.id, JSON.stringify(timer));
  }

  getTimer(id: string): Timer {
    const row = this.db.prepare('SELECT body FROM timers WHERE id=?').get(id);
    if (!row) throw new Error('Timer not found');
    return JSON.parse(String(row.body)) as Timer;
  }

  listTimers(): Timer[] {
    return this.db.prepare('SELECT body FROM timers ORDER BY rowid').all()
      .map(row => JSON.parse(String(row.body)) as Timer);
  }

  deleteTimer(id: string): boolean {
    return this.db.prepare('DELETE FROM timers WHERE id=?').run(id).changes > 0;
  }

  saveImChannel(channel: ImChannelConfig): ImChannelConfig {
    this.db.prepare(
      'INSERT INTO im_channels(id,platform,updated_at,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET platform=excluded.platform,updated_at=excluded.updated_at,body=excluded.body',
    ).run(channel.id, channel.platform, channel.updatedAt, JSON.stringify(channel));
    return channel;
  }

  getImChannel(id: string): ImChannelConfig {
    const row = this.db.prepare('SELECT body FROM im_channels WHERE id=?').get(id);
    if (!row) throw new Error('IM channel not found');
    return JSON.parse(String(row.body)) as ImChannelConfig;
  }

  listImChannels(): ImChannelConfig[] {
    return this.db.prepare('SELECT body FROM im_channels ORDER BY rowid').all()
      .map(row => JSON.parse(String(row.body)) as ImChannelConfig);
  }

  toImChannelView(channel: ImChannelConfig): ImChannelView {
    let webhookUrlMasked: string | undefined;
    if (channel.webhookUrl) {
      try {
        const u = new URL(channel.webhookUrl);
        webhookUrlMasked = `${u.origin}${u.pathname.slice(0, 24)}${u.pathname.length > 24 || u.search ? '…' : ''}`;
      } catch {
        webhookUrlMasked = channel.webhookUrl.slice(0, 24) + '…';
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
        : channel.platform === 'xiaoai'
          ? (Boolean(channel.botToken || channel.webhookUrl || channel.apiBase?.startsWith('ssh://')) ? 'bound' : 'unbound')
          : undefined,
      webhookUrlMasked,
      defaultTarget: channel.defaultTarget,
      allowedSenders: channel.allowedSenders,
      apiBase: channel.apiBase,
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

  deleteImChannel(id: string): boolean {
    return this.db.prepare('DELETE FROM im_channels WHERE id=?').run(id).changes > 0;
  }
}

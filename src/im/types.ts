import { timingSafeEqual } from 'node:crypto';
import type { Coordinator } from '../coordinator.js';
import type { VoiceFastpathRequest, VoiceFastpathResult } from '../plugin.js';
import type { ImChannelConfig } from '../store.js';
import type { ChatMessage, ImChannelView, ImPlatform, MessageOrigin } from '../view.js';
import type { ReceivedAttachment } from '../wechat-inbound.js';
import type { XiaoaiSshRunner } from '../xiaoai/ssh.js';
import type { XiaoaiKwsMonitorOptions } from '../xiaoai/kws-monitor.js';
import type { XiaoaiSpeakerExtractor } from '../xiaoai/speaker-verify.js';

export const DEFAULT_WECHAT_ILINK_BASE = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_NETWORK_TIMEOUT_MS = 15_000;

export interface XiaoaiMatchedSpeaker {
  id: string;
  name: string;
  role: 'owner' | 'member';
  score: number;
}

export interface TelegramMediaItem {
  kind: 'image' | 'file';
  fileId: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
}

export interface TelegramQuickConnectView {
  ok: boolean;
  bot: {
    id: number;
    username?: string;
    firstName: string;
  };
  commandsRegistered: boolean;
  commandsError?: string;
  webhookCleared: boolean;
  channel: ImChannelView;
}

export interface TelegramSyncCommandsView {
  ok: boolean;
  count: number;
  channel: ImChannelView;
}

export interface ImInboundMessage {
  channelId: string;
  externalId: string;
  senderId: string;
  senderName?: string;
  senderUsername?: string;
  target?: string;
  text: string;
  explicitWake?: boolean;
  speaker?: XiaoaiMatchedSpeaker;
  samples?: Float32Array;
  sampleRate?: number;
  replyWebhook?: string;
  contextToken?: string;
  mediaItems?: Record<string, unknown>[];
  telegramMedia?: TelegramMediaItem[];
  callbackQueryId?: string;
}

export interface ImWebhookResponse {
  status: number;
  body: string;
  contentType: string;
}

export interface ImSendOptions {
  target?: string;
  replyToMessageId?: string;
  replyWebhook?: string;
  contextToken?: string;
  waitForCompletion?: boolean;
  replyMarkup?: Record<string, unknown>;
}

export interface FastpathTurnInput {
  channelId: string;
  senderId: string;
  senderName?: string;
  userText: string;
  replyText: string;
  pluginName: string;
  action: string;
  latencyMs?: number;
  sessionId?: string;
  requestId?: string;
  replyId?: string;
  origin?: MessageOrigin;
}

export interface FastpathTurnResult {
  userMessage?: ChatMessage;
  replyMessage?: ChatMessage;
}

export type CoordinatorWithHooks = Coordinator & {
  homeDir?: string;
  subscribeOutbound?: (listener: () => void) => () => void;
  recordFastpathTurn?: (input: FastpathTurnInput) => FastpathTurnResult | Promise<FastpathTurnResult>;
};

export interface ImGatewayContext {
  readonly homeDir: string;
  readonly coordinator: CoordinatorWithHooks;
  readonly shutdownSignal: AbortSignal;
  isClosing(): boolean;
  markMessageDelivered(messageId: string, version?: number): void;
  clearMessageDelivered(messageId: string): void;
  getSeenMessageVersion(messageId: string): number;
  sendToChannel(channelId: string, text: string, options?: ImSendOptions): Promise<void>;
  ingestMessage(inbound: ImInboundMessage): Promise<{ ok: boolean; action: string; messageId?: string; reason?: string }>;
  markTrustedWechatInbound(inbound: ImInboundMessage): void;
  markTrustedTelegramInbound?(inbound: ImInboundMessage): void;
  scheduleChannelPoll(channelId: string, delayMs: number): void;
  runVoiceFastpath(request: VoiceFastpathRequest): Promise<VoiceFastpathResult | undefined>;
}

export interface ImChannelAdapter {
  readonly platform: ImPlatform;
  send(channel: ImChannelConfig, text: string, options?: ImSendOptions): Promise<void>;
  poll?(channel: ImChannelConfig): Promise<{ receivedAny?: boolean } | void>;
  handleWebhook?(
    channel: ImChannelConfig,
    method: string,
    query: URLSearchParams,
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<ImWebhookResponse>;
  sync?(channels: ImChannelConfig[]): void;
  close?(): Promise<void> | void;
}

/** Constant-time string comparison for webhook tokens and HMAC signatures. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Extract a single lowercase HTTP header value cleanly. */
export function readHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const val = headers[name.toLowerCase()];
  return Array.isArray(val) ? val[0] : val;
}

/** Dependency injection hooks for XiaoAI transport, KWS, speaker verification, and fast-path testing. */
export interface XiaoaiDeps {
  sshRunner?: XiaoaiSshRunner;
  fetchImpl?: typeof fetch;
  kwsStreamFactory?: XiaoaiKwsMonitorOptions['streamFactory'];
  kwsSpotterFactory?: XiaoaiKwsMonitorOptions['spotterFactory'];
  kwsRecognizerFactory?: XiaoaiKwsMonitorOptions['recognizerFactory'];
  kwsVadFactory?: XiaoaiKwsMonitorOptions['vadFactory'];
  kwsModelsDir?: string;
  kwsKeywordsFile?: string;
  kwsAsrModelsDir?: string;
  kwsVadModelPath?: string;
  kwsCooldownMs?: number;
  kwsProbeDurationMs?: number;
  kwsChimeDiscardMs?: number;
  kwsMaxWaitSpeechMs?: number;
  kwsEndSilenceMs?: number;
  speakerModelsDir?: string;
  speakerRegistryPath?: string;
  speakerExtractorFactory?: (config: { modelPath: string }) => XiaoaiSpeakerExtractor;
  speakerMinEnrollMs?: number;
  speakerEnrollWaitMs?: number;
}

/** Build a standard UTF-8 JSON webhook response. */
export function jsonWebhookResponse(status: number, payload: unknown): ImWebhookResponse {
  return {
    status,
    body: JSON.stringify(payload),
    contentType: 'application/json; charset=utf-8',
  };
}

/** Ingest a parsed webhook inbound message, returning `empty_message` if missing/blank. */
export async function finalizeWebhookInbound(
  ctx: ImGatewayContext,
  inbound: ImInboundMessage | undefined,
): Promise<ImWebhookResponse> {
  if (!inbound || !inbound.text.trim()) {
    return jsonWebhookResponse(200, { ok: true, ignored: 'empty_message' });
  }
  const result = await ctx.ingestMessage(inbound);
  return jsonWebhookResponse(200, result);
}

/** Combine a bounded per-request timeout with the gateway's shutdown AbortSignal. */
export function buildRequestSignal(timeoutMs = DEFAULT_NETWORK_TIMEOUT_MS, parentSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return parentSignal ? AbortSignal.any([timeoutSignal, parentSignal]) : timeoutSignal;
}

/** Bounded FIFO/LRU cache backed by Map insertion order. */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly maxEntries: number) {
    super();
  }

  override set(key: K, value: V): this {
    if (super.has(key)) {
      super.delete(key);
    }
    super.set(key, value);
    while (this.size > this.maxEntries) {
      const oldest = this.keys().next();
      if (oldest.done) break;
      super.delete(oldest.value);
    }
    return this;
  }

  override get(key: K): V | undefined {
    const val = super.get(key);
    if (val !== undefined) {
      super.delete(key);
      super.set(key, val);
    }
    return val;
  }
}

export type InboundAttachmentContext = {
  channel: ImChannelConfig;
  rawText: string;
  attachments: ReceivedAttachment[];
  replyOpts: ImSendOptions;
  requestId: string;
  msg: ChatMessage;
};

const MAX_CONCURRENT_MEDIA_TASKS = 2;
let activeMediaTasks = 0;
const mediaTaskWaiters: Array<() => void> = [];

/** Process-wide FIFO concurrency limiter for inbound/outbound IM attachment transfers. */
export async function runBoundedMediaTask<T>(fn: () => Promise<T>): Promise<T> {
  if (activeMediaTasks >= MAX_CONCURRENT_MEDIA_TASKS) {
    await new Promise<void>(resolve => mediaTaskWaiters.push(resolve));
  }
  activeMediaTasks++;
  try {
    return await fn();
  } finally {
    activeMediaTasks--;
    const next = mediaTaskWaiters.shift();
    next?.();
  }
}

/** Parse a webhook JSON body strictly into a non-null plain object record. */
export function parseJsonObjectBody(rawBody: string): { ok: true; data: Record<string, unknown> } | { ok: false } {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

/** Reject obvious browser cross-origin CSRF attempts while allowing server-to-server webhook callers. */
export function isSuspiciousBrowserWebhookRequest(headers: Record<string, string | string[] | undefined>): boolean {
  const secFetchSite = readHeaderValue(headers, 'sec-fetch-site')?.trim().toLowerCase();
  if (secFetchSite === 'cross-site' || secFetchSite === 'same-site') {
    return true;
  }
  const origin = readHeaderValue(headers, 'origin')?.trim();
  if (origin) {
    return true;
  }
  return false;
}

function isPrivateOrLocalHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (host === '::1' || host === '::' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }
  const v4 = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host;
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  // Single-label internal hostnames (e.g. `redis`, `metadata`) without a dot
  if (!host.includes('.')) return true;
  return false;
}

/**
 * Validate dynamic replyWebhook / sessionWebhook URLs to block SSRF and credential exfiltration.
 * Allows either exact origin match against the operator-configured `channel.webhookUrl`, or
 * official platform HTTPS domains on non-private hosts.
 */
export function isAllowedReplyWebhook(
  platform: ImPlatform | string,
  rawUrl: string | undefined,
  channel?: Pick<ImChannelConfig, 'webhookUrl'>,
): boolean {
  if (!rawUrl || !rawUrl.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

  const configuredRaw = channel?.webhookUrl?.trim();
  if (configuredRaw) {
    try {
      const configured = new URL(configuredRaw);
      if (parsed.origin === configured.origin) {
        return true;
      }
    } catch {
      // Ignore malformed configured URL; fall through to strict public HTTPS check.
    }
  }

  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (isPrivateOrLocalHostname(host)) return false;

  switch (platform) {
    case 'dingtalk':
      return host === 'oapi.dingtalk.com' || host.endsWith('.dingtalk.com');
    case 'wechat':
      return host === 'qyapi.weixin.qq.com' || host === 'ilinkai.weixin.qq.com' || host.endsWith('.weixin.qq.com');
    case 'telegram':
      return host === 'api.telegram.org';
    case 'xiaoai':
      return false;
    default:
      return false;
  }
}

/** Strip tokens, credentials, and raw endpoint URLs from error strings persisted in channel status/logs. */
export function sanitizeImError(error: unknown, secrets?: Array<string | undefined>): string {
  let msg = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  if (secrets) {
    for (const secret of secrets) {
      if (secret && secret.length >= 4 && msg.includes(secret)) {
        msg = msg.split(secret).join('<redacted>');
      }
    }
  }
  msg = msg
    .replace(/\bbot\d+:[A-Za-z0-9_-]{8,}/g, 'bot<redacted>')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@')
    .replace(/([?&](?:token|secret|sign|signature|access_token|botToken|password|ssecurity|passToken|serviceToken|cUserId|cookie|auth)=)[^&\s"'<>]+/gi, '$1<redacted>')
    .replace(/(https?:\/\/[^/?#\s"'<>]+)(?:\/[^\s"'<>]*)?/gi, (_, origin: string) => `${origin}/<redacted>`);
  return msg;
}

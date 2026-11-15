import { timingSafeEqual } from 'node:crypto';
import type { Coordinator } from '../coordinator.js';
import type { VoiceFastpathRequest, VoiceFastpathResult } from '../plugin.js';
import type { ImChannelConfig } from '../store.js';
import type { ChatMessage, ImPlatform, MessageOrigin } from '../view.js';
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

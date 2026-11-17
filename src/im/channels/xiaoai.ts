import { randomUUID } from 'node:crypto';
import type { VoiceFastpathRequest, VoiceFastpathResult } from '../../plugin.js';
import type { ImChannelConfig } from '../../store.js';
import type { ChatMessage, MessageOrigin } from '../../view.js';
import {
  isXiaoaiPollable,
  parseXiaoaiWebhookPayload,
  pollXiaoaiChannel,
} from '../../xiaoai/cloud-auth.js';
import { XiaoaiKwsMonitor } from '../../xiaoai/kws-monitor.js';
import {
  parseSpeakerVoiceCommand,
  XiaoaiSpeakerEnrollController,
  type XiaoaiEnrollSessionSnapshot,
} from '../../xiaoai/speaker-enroll.js';
import { XiaoaiSpeakerManager, type XiaoaiSpeakerStatus } from '../../xiaoai/speaker-verify.js';
import {
  closeXiaoaiSshConnections,
  parseXiaoaiApiOptions,
  parseXiaoaiSshTargets,
  setXiaoaiSpeakerLed,
  type XiaoaiSshTarget,
} from '../../xiaoai/ssh.js';
import {
  bumpXiaoaiSpeechEpoch,
  DEFAULT_OWNER_WAKE_GREETINGS,
  handleXiaoaiKeywordWake,
  prewarmXiaoaiWakeGreetings,
  sendXiaoaiSpeech,
} from '../../xiaoai/tts-player.js';
import {
  shouldContinueXiaoaiDialog,
  stripXiaoaiDialogDirective,
} from '../../xiaoai/utterance-utils.js';
import {
  BoundedMap,
  finalizeWebhookInbound,
  jsonWebhookResponse,
  readHeaderValue,
  safeEqual,
  type ImChannelAdapter,
  type ImGatewayContext,
  type ImInboundMessage,
  type ImSendOptions,
  type ImWebhookResponse,
  type XiaoaiDeps,
} from '../types.js';

const DEFAULT_CONTINUOUS_IDLE_TTL_MS = 60_000;
const DEFAULT_CONTINUOUS_CAPTURE_WAIT_MS = 10_000;
const DEFAULT_CONTINUOUS_MAX_UTTERANCE_MS = 2_800;

interface FastpathSessionEntry {
  pluginName?: string;
  state: Record<string, unknown>;
  idleTtlMs: number;
  expiresAt: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function resolveSshTarget(channel: ImChannelConfig, targetId?: string): XiaoaiSshTarget | undefined {
  const targets = parseXiaoaiSshTargets(channel.apiBase);
  if (!targets.length) return undefined;
  return targets.find(t => t.id === targetId || t.userHost === targetId) ?? targets[0];
}

/** Channel adapter for Xiaomi XiaoAI speakers (MiNA cloud, SSH, KWS, voiceprint, and plugin fastpaths). */
export class XiaoaiChannelAdapter implements ImChannelAdapter {
  readonly platform = 'xiaoai' as const;

  deps?: XiaoaiDeps;
  private kwsMonitor?: XiaoaiKwsMonitor;
  private kwsDepsRef?: XiaoaiDeps;
  private speakerManager?: XiaoaiSpeakerManager;
  private speakerDepsRef?: XiaoaiDeps;
  private readonly speakerEnroll = new XiaoaiSpeakerEnrollController();
  private readonly fastpathSessions = new BoundedMap<string, FastpathSessionEntry>(128);
  private readonly outboundChains = new Map<string, Promise<void>>();
  private readonly prewarmedTargets = new Set<string>();

  constructor(private readonly ctx: ImGatewayContext) {}

  async close(): Promise<void> {
    this.kwsMonitor?.close();
    this.kwsMonitor = undefined;
    this.kwsDepsRef = undefined;
    this.speakerManager?.close();
    this.speakerManager = undefined;
    this.speakerDepsRef = undefined;
    this.speakerEnroll.clear();
    this.fastpathSessions.clear();
    this.outboundChains.clear();
    this.prewarmedTargets.clear();
    await closeXiaoaiSshConnections().catch(() => {});
  }

  getKwsStatus(channelId?: string, targetId?: string): ReturnType<XiaoaiKwsMonitor['getStatus']> | undefined {
    return this.kwsMonitor?.getStatus(channelId, targetId);
  }

  enterFollowUpCapture(
    channelId: string,
    targetId: string,
    options?: {
      waitMs?: number;
      discardMs?: number;
      endSilenceMs?: number;
      maxUtteranceMs?: number;
      allowDuringTranscribe?: boolean;
    },
  ): boolean {
    return this.kwsMonitor?.enterFollowUpCapture(channelId, targetId, options) ?? false;
  }

  async send(channel: ImChannelConfig, text: string, options?: ImSendOptions): Promise<void> {
    await sendXiaoaiSpeech(channel, text, {
      target: options?.target,
      replyToMessageId: options?.replyToMessageId,
      replyWebhook: options?.replyWebhook,
      waitForCompletion: options?.waitForCompletion,
      ...this.deps,
      shutdownSignal: this.ctx.shutdownSignal,
    });
  }

  async poll(channel: ImChannelConfig): Promise<{ receivedAny: boolean }> {
    if (!isXiaoaiPollable(channel)) return { receivedAny: false };
    const suppressUnverifiedPoll = parseXiaoaiSshTargets(channel.apiBase).length > 0
      && parseXiaoaiApiOptions(channel.apiBase).kws
      && Boolean(this.kwsMonitor?.hasActiveWorker(channel.id))
      && this.isSpeakerGateEnforced(channel);
    if (suppressUnverifiedPoll) {
      return { receivedAny: false };
    }
    const result = await pollXiaoaiChannel(channel, this.deps);
    if (
      (result.nextPollOffset !== undefined && result.nextPollOffset !== channel.pollOffset)
      || (result.nextSyncBuf !== undefined && result.nextSyncBuf !== channel.syncBuf)
      || channel.lastError !== undefined
    ) {
      const current = this.ctx.coordinator.store.getImChannel(channel.id);
      if (result.nextPollOffset !== undefined) current.pollOffset = result.nextPollOffset;
      if (result.nextSyncBuf !== undefined) current.syncBuf = result.nextSyncBuf;
      current.lastError = undefined;
      this.ctx.coordinator.store.saveImChannel(current);
    }
    for (const inbound of result.messages) {
      await this.ctx.ingestMessage(inbound);
    }
    return { receivedAny: result.messages.length > 0 };
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
      const headerSecret = readHeaderValue(headers, 'x-xiaoai-secret')
        ?? readHeaderValue(headers, 'authorization')?.replace(/^Bearer\s+/i, '').trim()
        ?? query.get('secret')
        ?? '';
      if (!headerSecret || !safeEqual(headerSecret, channel.secret)) {
        return jsonWebhookResponse(403, { error: 'Invalid XiaoAI webhook secret' });
      }
    }
    return finalizeWebhookInbound(this.ctx, parseXiaoaiWebhookPayload(channel.id, rawBody));
  }

  sync(channels: ImChannelConfig[]): void {
    const skipRealKwsForMockSsh = Boolean(this.deps?.sshRunner && !this.deps?.kwsStreamFactory);
    const hasActiveKwsTarget = channels.some(ch =>
      ch.enabled
      && ch.platform === 'xiaoai'
      && parseXiaoaiSshTargets(ch.apiBase).length > 0
      && parseXiaoaiApiOptions(ch.apiBase).kws,
    );
    if (skipRealKwsForMockSsh || !hasActiveKwsTarget) {
      this.kwsMonitor?.close();
      this.kwsMonitor = undefined;
      this.kwsDepsRef = undefined;
      return;
    }

    if (this.kwsMonitor && this.kwsDepsRef !== this.deps) {
      this.kwsMonitor.close();
      this.kwsMonitor = undefined;
    }

    if (!this.kwsMonitor) {
      this.kwsDepsRef = this.deps;
      this.kwsMonitor = new XiaoaiKwsMonitor({
        homeDir: this.ctx.homeDir,
        modelsDir: this.deps?.kwsModelsDir,
        keywordsFile: this.deps?.kwsKeywordsFile,
        asrModelsDir: this.deps?.kwsAsrModelsDir,
        vadModelPath: this.deps?.kwsVadModelPath,
        cooldownMs: this.deps?.kwsCooldownMs,
        probeDurationMs: this.deps?.kwsProbeDurationMs,
        chimeDiscardMs: this.deps?.kwsChimeDiscardMs,
        maxWaitSpeechMs: this.deps?.kwsMaxWaitSpeechMs,
        endSilenceMs: this.deps?.kwsEndSilenceMs,
        sshRunner: this.deps?.sshRunner,
        streamFactory: this.deps?.kwsStreamFactory,
        spotterFactory: this.deps?.kwsSpotterFactory,
        recognizerFactory: this.deps?.kwsRecognizerFactory,
        vadFactory: this.deps?.kwsVadFactory,
        speakerGate: {
          isActive: ch => this.isSpeakerGateEnforced(ch),
          isBypassed: (chId, targetId) => this.speakerEnroll.isActive(chId, targetId),
          verifyWake: ({ channel, keyword, samples, sampleRate }) => {
            const opts = parseXiaoaiApiOptions(channel.apiBase);
            return this.getSpeakerManager().verifyWakeSlice(samples, sampleRate, keyword, {
              speakerVerify: opts.speakerVerify,
              thresholdOverride: opts.speakerThreshold,
            });
          },
          verifyUtterance: ({ channel, samples, sampleRate }) => {
            const opts = parseXiaoaiApiOptions(channel.apiBase);
            return this.getSpeakerManager().verifyAndTrimUtterance(samples, sampleRate, {
              speakerVerify: opts.speakerVerify,
              thresholdOverride: opts.speakerThreshold,
            });
          },
          verifyUtteranceAsync: ({ channel, samples, sampleRate }) => {
            const opts = parseXiaoaiApiOptions(channel.apiBase);
            return this.getSpeakerManager().verifyAndTrimUtteranceAsync(samples, sampleRate, {
              speakerVerify: opts.speakerVerify,
              thresholdOverride: opts.speakerThreshold,
            });
          },
        },
        onWake: async (event) => {
          if (event.reWake) {
            this.fastpathSessions.delete(`${event.channel.id}:${event.target.id}`);
          }
          return handleXiaoaiKeywordWake({
            channel: event.channel,
            target: event.target,
            keyword: event.keyword,
            chime: event.chime,
            wakeDurationMs: event.wakeDurationMs,
            urgent: event.urgent,
            speaker: event.speaker,
            sshRunner: this.deps?.sshRunner,
          });
        },
        onTranscribing: async (event) => {
          if (this.isContinuousFastpathActive(event.channel.id, event.target.id)) {
            return;
          }
          await setXiaoaiSpeakerLed(event.target, 'think', this.deps?.sshRunner);
        },
        shouldBypassFollowUpCancel: (channelId, targetId) => {
          return this.isContinuousFastpathActive(channelId, targetId)
            || this.speakerEnroll.isActive(channelId, targetId);
        },
        onCaptureCancel: async (event) => {
          await this.handleKwsCaptureCancel(event);
        },
        onUtterance: async (event) => {
          if (this.ctx.isClosing()) return;
          try {
            const latest = this.ctx.coordinator.store.getImChannel(event.channel.id);
            if (latest.lastError !== undefined) {
              latest.lastError = undefined;
              latest.updatedAt = Date.now();
              this.ctx.coordinator.store.saveImChannel(latest);
            }
          } catch {
            // Channel may have been deleted
          }
          bumpXiaoaiSpeechEpoch(event.channel.id, event.target.id);
          const res = await this.ctx.ingestMessage({
            channelId: event.channel.id,
            externalId: `${event.target.id}:kws-${randomUUID()}`,
            senderId: event.target.id,
            senderName: event.target.id,
            target: event.target.id,
            text: event.text,
            explicitWake: event.explicitWake,
            ...(event.speaker ? { speaker: event.speaker } : {}),
            ...(event.samples ? { samples: event.samples, sampleRate: event.sampleRate } : {}),
          });
          if (!res.ok) {
            await setXiaoaiSpeakerLed(event.target, 'off', this.deps?.sshRunner);
          }
        },
        onError: (channelId, error) => {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(`[xiaoai-kws] ${channelId}: ${msg}`);
        },
      });
    }
    this.kwsMonitor.sync(channels);
    if (!this.deps?.sshRunner) {
      for (const ch of channels) {
        if (!ch.enabled || ch.platform !== 'xiaoai') continue;
        const apiOpts = parseXiaoaiApiOptions(ch.apiBase);
        if (!apiOpts.kws || !apiOpts.kwsChime) continue;
        for (const target of parseXiaoaiSshTargets(ch.apiBase)) {
          const targetKey = `${ch.id}:${target.id}:${target.userHost}:${target.port ?? 22}`;
          if (this.prewarmedTargets.has(targetKey)) continue;
          this.prewarmedTargets.add(targetKey);
          void prewarmXiaoaiWakeGreetings(target, DEFAULT_OWNER_WAKE_GREETINGS).catch(() => {});
        }
      }
    }
  }

  /** Handle speaker voiceprint enrollment/commands and plugin voice fastpaths before routing to Coordinator. */
  async tryHandleInbound(
    channel: ImChannelConfig,
    inbound: ImInboundMessage,
    requestId: string,
  ): Promise<{ ok: boolean; action: string; messageId?: string } | undefined> {
    if (inbound.mediaItems?.length) return undefined;
    const voiceResult = await this.tryHandleSpeakerVoice(channel, inbound);
    if (voiceResult) return voiceResult;
    return this.tryHandleVoiceFastpath(channel, inbound, requestId);
  }

  enqueueNotice(
    channelId: string,
    targetId: string,
    noticeText: string,
    route?: MessageOrigin,
  ): void {
    const text = stripXiaoaiDialogDirective(noticeText).text;
    if (!text) return;
    this.enqueueTargetTask(channelId, targetId, async ({ channel, sshTarget }) => {
      const continuous = this.isContinuousFastpathActive(channel.id, targetId);
      await this.ctx.sendToChannel(channel.id, text, {
        target: targetId,
        replyWebhook: route?.replyWebhook,
        waitForCompletion: continuous,
      });
      if (!this.ctx.isClosing() && continuous && sshTarget) {
        await this.armContinuousCapture(channel.id, sshTarget, {
          discardMs: 120,
          refreshLed: true,
          allowDuringTranscribe: true,
        });
      }
    });
  }

  enqueueOutbound(
    channelId: string,
    msg: ChatMessage,
    bodyText: string,
    route: MessageOrigin,
  ): void {
    const targetId = route.conversationId ?? route.senderId;
    if (!targetId) return;
    this.enqueueTargetTask(channelId, targetId, async ({ channel, sshTarget }) => {
      if (channel.platform !== route.channel || channel.accountId !== route.accountId) return;
      if (this.hasNewerSpeakerUserMessage(msg) && !this.isBackgroundTaskDeliveryMessage(msg)) return;

      const hasPendingWorkerQuestion = this.hasPendingWorkerQuestion(msg);
      const cleanBody = stripXiaoaiDialogDirective(bodyText).text;
      if (!cleanBody) return;

      const hookResult = msg.status === 'completed'
        ? await this.runAssistantReplyHook(channel, targetId, cleanBody)
        : undefined;
      const hookData = asRecord(hookResult?.data);
      const continuous = this.isContinuousFastpathActive(channel.id, targetId);
      const expectFollowUp = (msg.status === 'completed'
        && (shouldContinueXiaoaiDialog(bodyText, { hasPendingWorkerQuestion }) || Boolean(hookResult?.followUp)))
        || continuous;

      if (!hookData?.suppressSpeech) {
        await this.ctx.sendToChannel(channel.id, cleanBody, {
          target: targetId,
          replyToMessageId: route.replyToMessageId,
          replyWebhook: route.replyWebhook,
          contextToken: route.contextToken,
          waitForCompletion: expectFollowUp,
        });
      }

      if (this.ctx.isClosing() || this.hasNewerSpeakerUserMessage(msg) || !sshTarget || !this.kwsMonitor) {
        return;
      }
      if (hookResult?.followUp) {
        this.touchContinuousFastpathSession(channel.id, sshTarget.id);
      }
      if (this.isContinuousFastpathActive(channel.id, sshTarget.id)) {
        await this.armContinuousCapture(channel.id, sshTarget, {
          discardMs: 120,
          refreshLed: hookData?.ledRefreshed !== true,
          allowDuringTranscribe: true,
        });
      } else if (expectFollowUp) {
        const entered = this.kwsMonitor.enterFollowUpCapture(channel.id, sshTarget.id, {
          waitMs: hookResult?.followUpWaitMs ?? 8_000,
          discardMs: 150,
          allowDuringTranscribe: true,
        });
        if (entered && hookData?.ledRefreshed !== true) {
          await setXiaoaiSpeakerLed(sshTarget, 'listen', this.deps?.sshRunner);
        }
      }
    });
  }

  getVoiceprintStatus(): XiaoaiSpeakerStatus {
    return this.getSpeakerManager().getStatus();
  }

  configureVoiceprint(patch: {
    enabled?: boolean;
    threshold?: number;
    wakePrecheck?: boolean;
    rename?: { target: string; name: string };
    role?: { target: string; role: 'owner' | 'member' };
  }): XiaoaiSpeakerStatus {
    return this.getSpeakerManager().configure(patch);
  }

  removeVoiceprint(target: string): { removed: boolean; name?: string; id?: string; remaining: number } {
    const res = this.getSpeakerManager().removeSpeaker(target);
    return {
      removed: res.removed,
      ...(res.profile ? { name: res.profile.name, id: res.profile.id } : {}),
      remaining: res.remaining,
    };
  }

  clearVoiceprints(): { cleared: number } {
    return this.getSpeakerManager().clearSpeakers();
  }

  async startVoiceprintEnrollment(input: {
    name?: string;
    role?: 'owner' | 'member';
    mode?: 'replace' | 'append';
    channelId?: string;
    targetId?: string;
  }): Promise<{
    session: XiaoaiEnrollSessionSnapshot;
    channelId: string;
    targetId: string;
  }> {
    const channels = this.ctx.coordinator.store.listImChannels().filter(ch => ch.enabled && ch.platform === 'xiaoai');
    const channel = input.channelId
      ? channels.find(ch => ch.id === input.channelId)
      : channels.find(ch => parseXiaoaiSshTargets(ch.apiBase).length > 0 && parseXiaoaiApiOptions(ch.apiBase).kws)
        ?? channels.find(ch => parseXiaoaiSshTargets(ch.apiBase).length > 0)
        ?? channels[0];
    if (!channel) {
      throw new Error(input.channelId ? `未找到已启用的小爱频道 ${input.channelId}` : '当前没有已启用的小爱音箱频道');
    }
    const targets = parseXiaoaiSshTargets(channel.apiBase);
    if (targets.length === 0 || !parseXiaoaiApiOptions(channel.apiBase).kws) {
      throw new Error(`小爱频道 ${channel.id} 未启用本地语音流（需要配置 SSH 且 ?kws=1）`);
    }
    const target = input.targetId
      ? targets.find(t => t.id === input.targetId || t.userHost === input.targetId)
      : targets[0];
    if (!target) {
      throw new Error(`未找到音箱目标 ${input.targetId}`);
    }

    this.fastpathSessions.delete(`${channel.id}:${target.id}`);

    const manager = this.getSpeakerManager();
    const status = manager.getStatus();
    const speakerName = (
      input.name?.trim()
      || (status.profiles.length === 0 ? '主人' : `成员${status.profiles.length + 1}`)
    ).slice(0, 40);
    const existing = manager.findProfile(speakerName);
    const role: 'owner' | 'member' = input.role
      ?? existing?.role
      ?? (status.profiles.length === 0 || speakerName === '主人' ? 'owner' : 'member');
    const mode: 'replace' | 'append' = input.mode === 'append' && existing ? 'append' : 'replace';

    const preparing = this.speakerEnroll.createPreparingSession({
      channelId: channel.id,
      targetId: target.id,
      speakerName,
      role,
      mode,
    });
    const session = this.launchEnrollmentSession(channel, target.id, preparing.sessionId, !manager.isModelReady());
    return {
      session,
      channelId: channel.id,
      targetId: target.id,
    };
  }

  getVoiceprintEnrollmentStatus(sessionId: string): XiaoaiEnrollSessionSnapshot {
    const snap = this.speakerEnroll.getStatus(sessionId);
    if (!snap) {
      throw new Error(`未找到声纹录入会话 ${sessionId}`);
    }
    return snap;
  }

  cancelVoiceprintEnrollment(sessionId?: string): XiaoaiEnrollSessionSnapshot | { cancelled: false } {
    const cancelled = this.speakerEnroll.cancelByIdOrTarget(
      sessionId ? { sessionId } : undefined,
    );
    if (!cancelled) {
      return { cancelled: false };
    }
    this.enqueueDirectSpeech(cancelled.channelId, cancelled.targetId, '已取消声纹录入。');
    return cancelled;
  }

  /** Unified per-target serial speech queue eliminating duplicate outbound chains. */
  private enqueueTargetTask(
    channelId: string,
    targetId: string,
    task: (ctx: { channel: ImChannelConfig; sshTarget?: XiaoaiSshTarget }) => Promise<void>,
  ): void {
    const key = `${channelId}:${targetId}`;
    const prev = this.outboundChains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      if (this.ctx.isClosing()) return;
      await this.waitForCaptureIdle(channelId, targetId);
      if (this.ctx.isClosing()) return;
      try {
        const channel = this.ctx.coordinator.store.getImChannel(channelId);
        if (!channel.enabled || channel.platform !== 'xiaoai') return;
        const sshTarget = resolveSshTarget(channel, targetId);
        await task({ channel, sshTarget });
      } catch {
        // Channel send errors are persisted on channel.lastError by sendToChannel
      }
    }).finally(() => {
      if (this.outboundChains.get(key) === next) {
        this.outboundChains.delete(key);
      }
    });
    this.outboundChains.set(key, next);
  }

  private enqueueDirectSpeech(
    channelId: string,
    targetId: string,
    speechText: string,
    options?: {
      followUpWaitMs?: number;
      discardMs?: number;
      endSilenceMs?: number;
      maxUtteranceMs?: number;
      continuous?: boolean;
      ledRefreshed?: boolean;
      replyToMessageId?: string;
      replyWebhook?: string;
      contextToken?: string;
    },
  ): void {
    const cleanText = stripXiaoaiDialogDirective(speechText).text;
    if (!cleanText) return;
    this.enqueueTargetTask(channelId, targetId, async ({ channel, sshTarget }) => {
      const keepOpen = Boolean(options?.followUpWaitMs || options?.continuous);
      try {
        await this.ctx.sendToChannel(channel.id, cleanText, {
          target: targetId,
          replyToMessageId: options?.replyToMessageId,
          replyWebhook: options?.replyWebhook,
          contextToken: options?.contextToken,
          waitForCompletion: keepOpen,
        });
      } catch (error) {
        if (!this.ctx.isClosing() && sshTarget && !keepOpen && !this.isContinuousFastpathActive(channelId, sshTarget.id)) {
          await setXiaoaiSpeakerLed(sshTarget, 'off', this.deps?.sshRunner).catch(() => {});
        }
        throw error;
      }
      if (this.ctx.isClosing() || !sshTarget) return;
      if (options?.continuous) {
        this.touchContinuousFastpathSession(channel.id, sshTarget.id);
      }
      if (options?.continuous || this.isContinuousFastpathActive(channel.id, sshTarget.id)) {
        await this.armContinuousCapture(channel.id, sshTarget, {
          discardMs: options?.discardMs ?? 120,
          refreshLed: options?.ledRefreshed !== true,
          allowDuringTranscribe: true,
        });
      } else if (options?.followUpWaitMs && this.kwsMonitor) {
        const entered = this.kwsMonitor.enterFollowUpCapture(channel.id, sshTarget.id, {
          waitMs: options.followUpWaitMs,
          discardMs: options.discardMs ?? 120,
          endSilenceMs: options.endSilenceMs,
          maxUtteranceMs: options.maxUtteranceMs,
          allowDuringTranscribe: true,
        });
        if (entered && options?.ledRefreshed !== true) {
          await setXiaoaiSpeakerLed(sshTarget, 'listen', this.deps?.sshRunner);
        }
      } else {
        await setXiaoaiSpeakerLed(sshTarget, 'off', this.deps?.sshRunner);
      }
    });
  }

  private getActiveFastpathSession(channelId: string, targetId: string): FastpathSessionEntry | undefined {
    const key = `${channelId}:${targetId}`;
    const entry = this.fastpathSessions.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.fastpathSessions.delete(key);
      return undefined;
    }
    return entry;
  }

  private isContinuousFastpathActive(channelId: string, targetId: string): boolean {
    const entry = this.getActiveFastpathSession(channelId, targetId);
    if (!entry) return false;
    return Boolean(entry.state.continuous || entry.state.tvRemoteActive);
  }

  private async armContinuousCapture(
    channelId: string,
    sshTarget: XiaoaiSshTarget,
    options?: { discardMs?: number; refreshLed?: boolean; allowDuringTranscribe?: boolean },
  ): Promise<boolean> {
    if (this.ctx.isClosing() || !this.kwsMonitor) return false;
    const entry = this.getActiveFastpathSession(channelId, sshTarget.id);
    if (!entry || (!entry.state.continuous && !entry.state.tvRemoteActive)) return false;

    const remainingMs = entry.expiresAt - Date.now();
    if (remainingMs <= 0) {
      this.fastpathSessions.delete(`${channelId}:${sshTarget.id}`);
      return false;
    }

    const configuredWaitMs = Number(entry.state.captureWaitMs ?? DEFAULT_CONTINUOUS_CAPTURE_WAIT_MS);
    const waitMs = Math.max(200, Math.min(configuredWaitMs, remainingMs));
    const endSilenceMs = Math.min(this.deps?.kwsEndSilenceMs ?? 280, 280);
    const maxUtteranceMs = Number(entry.state.maxUtteranceMs ?? DEFAULT_CONTINUOUS_MAX_UTTERANCE_MS);
    const entered = this.kwsMonitor.enterFollowUpCapture(channelId, sshTarget.id, {
      waitMs,
      discardMs: options?.discardMs ?? 0,
      endSilenceMs,
      maxUtteranceMs,
      allowDuringTranscribe: options?.allowDuringTranscribe ?? true,
    });
    if (!entered) return false;
    if (options?.refreshLed) {
      await setXiaoaiSpeakerLed(sshTarget, 'listen', this.deps?.sshRunner);
    }
    return true;
  }

  private applyFastpathResultState(
    channelId: string,
    targetId: string,
    prevEntry: FastpathSessionEntry | undefined,
    result: VoiceFastpathResult,
  ): void {
    const key = `${channelId}:${targetId}`;
    if (result.clearSessionState) {
      this.fastpathSessions.delete(key);
      return;
    }
    if (!result.sessionState) return;
    const dataObj = asRecord(result.data);
    const extendTtl = dataObj?.extendTtl !== false;
    const ttlMs = Number(
      result.sessionState.idleTtlMs
      ?? result.followUpWaitMs
      ?? prevEntry?.state.idleTtlMs
      ?? DEFAULT_CONTINUOUS_IDLE_TTL_MS,
    );
    const resolvedTtlMs = Math.max(200, Number.isFinite(ttlMs) ? ttlMs : DEFAULT_CONTINUOUS_IDLE_TTL_MS);
    const expiresAt = !extendTtl && prevEntry
      ? prevEntry.expiresAt
      : Date.now() + resolvedTtlMs;
    this.fastpathSessions.set(key, {
      pluginName: result.plugin ?? prevEntry?.pluginName,
      state: result.sessionState,
      idleTtlMs: resolvedTtlMs,
      expiresAt,
    });
  }

  private touchContinuousFastpathSession(channelId: string, targetId: string): void {
    const entry = this.fastpathSessions.get(`${channelId}:${targetId}`);
    if (!entry || (!entry.state.continuous && !entry.state.tvRemoteActive)) return;
    entry.expiresAt = Date.now() + entry.idleTtlMs;
  }

  private async runAssistantReplyHook(
    channel: ImChannelConfig,
    targetId: string,
    assistantReply: string,
  ): Promise<VoiceFastpathResult | undefined> {
    const prevEntry = this.getActiveFastpathSession(channel.id, targetId);
    const request: VoiceFastpathRequest = {
      text: '',
      channelId: channel.id,
      platform: channel.platform,
      targetId,
      sessionState: {
        ...(prevEntry?.state ?? {}),
        event: 'assistant_reply',
        assistantReply,
      },
    };
    try {
      const result = await this.ctx.runVoiceFastpath(request);
      if (!result?.handled) return undefined;
      this.applyFastpathResultState(channel.id, targetId, prevEntry, result);
      return result;
    } catch {
      return undefined;
    }
  }

  private async tryHandleVoiceFastpath(
    channel: ImChannelConfig,
    inbound: ImInboundMessage,
    requestId: string,
  ): Promise<{ ok: boolean; action: string; messageId?: string } | undefined> {
    const targetId = inbound.target ?? inbound.senderId;
    if (this.speakerEnroll.isActive(channel.id, targetId)) {
      return undefined;
    }

    const sessionKey = `${channel.id}:${targetId}`;
    const prevEntry = this.getActiveFastpathSession(channel.id, targetId);
    // [[LISTEN]] follow-up capture without explicit wake word belongs to Router's active dialog
    // unless a continuous plugin fastpath session (e.g., tv-ir) is already active.
    if (inbound.explicitWake === false && !prevEntry) {
      return undefined;
    }
    const wasContinuous = Boolean(prevEntry?.state.continuous || prevEntry?.state.tvRemoteActive);
    const sshTarget = resolveSshTarget(channel, targetId);

    const request: VoiceFastpathRequest = {
      text: inbound.text,
      channelId: channel.id,
      platform: channel.platform,
      targetId,
      senderId: inbound.senderId,
      ...(inbound.speaker ? { speakerId: inbound.speaker.id, speakerName: inbound.speaker.name } : {}),
      explicitWake: inbound.explicitWake,
      ...(prevEntry ? { sessionState: prevEntry.state } : {}),
    };

    const startedAt = Date.now();
    let result: VoiceFastpathResult | undefined;
    try {
      result = await this.ctx.runVoiceFastpath(request);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[xiaoai-fastpath] ${channel.id}/${targetId}: ${msg}`);
      return undefined;
    }

    if (this.ctx.isClosing()) return undefined;

    if (!result?.handled) {
      if (wasContinuous && inbound.explicitWake) {
        this.fastpathSessions.delete(sessionKey);
        if (sshTarget) {
          await setXiaoaiSpeakerLed(sshTarget, 'think', this.deps?.sshRunner).catch(() => {});
        }
        return undefined;
      }
      if (wasContinuous && !inbound.explicitWake) {
        if (sshTarget) {
          await this.armContinuousCapture(channel.id, sshTarget, {
            discardMs: 0,
            refreshLed: true,
            allowDuringTranscribe: true,
          });
        }
        return { ok: true, action: 'voice_fastpath_ignored' };
      }
      if (prevEntry && !wasContinuous) {
        this.fastpathSessions.delete(sessionKey);
      }
      return undefined;
    }

    this.applyFastpathResultState(channel.id, targetId, prevEntry, result);

    const dataObj = asRecord(result.data);
    const speech = result.speech?.trim() || undefined;
    const isContinuousNow = !result.clearSessionState && this.isContinuousFastpathActive(channel.id, targetId);
    const followUp = Boolean(result.followUp || isContinuousNow);

    let recordedMessageId: string | undefined;
    const shouldRecord = dataObj?.recordTurn !== false && Boolean(speech);
    if (shouldRecord && speech && this.ctx.coordinator.recordFastpathTurn) {
      const replyId = randomUUID();
      this.ctx.markMessageDelivered(replyId, Number.MAX_SAFE_INTEGER);
      const inboundOrigin: MessageOrigin = {
        channel: channel.platform,
        channelId: channel.id,
        accountId: channel.accountId,
        conversationId: targetId,
        senderId: inbound.senderId,
        ...(inbound.speaker ? { speakerId: inbound.speaker.id, speakerName: inbound.speaker.name } : {}),
        replyToMessageId: inbound.externalId,
        replyWebhook: inbound.replyWebhook,
        contextToken: inbound.contextToken,
      };
      try {
        const recorded = await Promise.resolve(this.ctx.coordinator.recordFastpathTurn({
          channelId: channel.id,
          senderId: inbound.senderId,
          senderName: inbound.senderName,
          userText: inbound.text,
          replyText: `${speech} ${followUp ? '[[LISTEN]]' : '[[END]]'}`,
          pluginName: result.plugin ?? prevEntry?.pluginName ?? 'voice-fastpath',
          action: result.action ?? 'handled',
          latencyMs: Math.max(0, Date.now() - startedAt),
          requestId,
          replyId,
          origin: inboundOrigin,
        }));
        if (recorded?.replyMessage?.id) {
          this.ctx.markMessageDelivered(recorded.replyMessage.id, Number.MAX_SAFE_INTEGER);
        }
        recordedMessageId = recorded?.userMessage?.id;
      } catch {
        this.ctx.clearMessageDelivered(replyId);
      }
    }

    const followUpWaitMs = result.followUpWaitMs ?? (isContinuousNow ? DEFAULT_CONTINUOUS_CAPTURE_WAIT_MS : 10_000);
    if (speech) {
      this.enqueueDirectSpeech(channel.id, targetId, speech, {
        followUpWaitMs: followUp ? followUpWaitMs : undefined,
        discardMs: 150,
        endSilenceMs: isContinuousNow ? Math.min(this.deps?.kwsEndSilenceMs ?? 280, 280) : undefined,
        maxUtteranceMs: isContinuousNow ? DEFAULT_CONTINUOUS_MAX_UTTERANCE_MS : undefined,
        continuous: isContinuousNow,
        ledRefreshed: dataObj?.ledRefreshed === true,
        replyToMessageId: inbound.externalId,
        replyWebhook: inbound.replyWebhook,
        contextToken: inbound.contextToken,
      });
    } else if (followUp && sshTarget) {
      if (isContinuousNow) {
        await this.armContinuousCapture(channel.id, sshTarget, {
          discardMs: 0,
          refreshLed: dataObj?.ledRefreshed !== true,
          allowDuringTranscribe: true,
        });
      } else if (this.kwsMonitor) {
        const entered = this.kwsMonitor.enterFollowUpCapture(channel.id, sshTarget.id, {
          waitMs: followUpWaitMs,
          discardMs: 0,
          allowDuringTranscribe: true,
        });
        if (entered && dataObj?.ledRefreshed !== true) {
          await setXiaoaiSpeakerLed(sshTarget, 'listen', this.deps?.sshRunner);
        }
      }
    } else if (result.clearSessionState && sshTarget) {
      await setXiaoaiSpeakerLed(sshTarget, 'off', this.deps?.sshRunner).catch(() => {});
    }

    return {
      ok: result.ok ?? true,
      action: result.action ?? 'voice_fastpath',
      ...(recordedMessageId ? { messageId: recordedMessageId } : {}),
    };
  }

  private async handleKwsCaptureCancel(event: {
    channel: ImChannelConfig;
    target: XiaoaiSshTarget;
    reason: 'cancel' | 'timeout' | 'empty' | 'speaker_rejected' | 'error';
    explicitWake?: boolean;
  }): Promise<void> {
    if ((event.reason === 'cancel' || event.reason === 'timeout') && !this.isContinuousFastpathActive(event.channel.id, event.target.id)) {
      this.fastpathSessions.delete(`${event.channel.id}:${event.target.id}`);
    }
    if (!this.ctx.isClosing() && this.speakerEnroll.isActive(event.channel.id, event.target.id)) {
      const enrollAction = this.speakerEnroll.handleCaptureTimeoutOrEmpty(
        event.channel.id,
        event.target.id,
        event.reason === 'empty' ? 'empty' : 'timeout',
      );
      if (enrollAction.action === 'rearm') {
        const enrollWaitMs = this.deps?.speakerEnrollWaitMs ?? 15_000;
        if (enrollAction.speakHint) {
          this.enqueueDirectSpeech(event.channel.id, event.target.id, enrollAction.speakHint, {
            followUpWaitMs: enrollWaitMs,
            discardMs: 120,
          });
          return;
        }
        const entered = this.kwsMonitor?.enterFollowUpCapture(event.channel.id, event.target.id, {
          waitMs: enrollWaitMs,
          discardMs: 0,
          allowDuringTranscribe: true,
        });
        if (entered) {
          await setXiaoaiSpeakerLed(event.target, 'listen', this.deps?.sshRunner);
          return;
        }
      } else if (enrollAction.action === 'cancelled') {
        this.enqueueDirectSpeech(event.channel.id, event.target.id, enrollAction.prompt);
        return;
      }
    }
    if (!this.ctx.isClosing() && this.isContinuousFastpathActive(event.channel.id, event.target.id)) {
      if (event.explicitWake && event.reason !== 'speaker_rejected') {
        this.fastpathSessions.delete(`${event.channel.id}:${event.target.id}`);
        await handleXiaoaiKeywordWake({
          channel: event.channel,
          target: event.target,
          keyword: '你好星期五',
          chime: true,
          sshRunner: this.deps?.sshRunner,
        });
        this.kwsMonitor?.enterFollowUpCapture(event.channel.id, event.target.id, {
          waitMs: this.deps?.kwsMaxWaitSpeechMs ?? 4_500,
          discardMs: this.deps?.kwsChimeDiscardMs ?? 320,
        });
        return;
      }
      const armed = await this.armContinuousCapture(event.channel.id, event.target, {
        discardMs: 0,
        refreshLed: event.reason !== 'speaker_rejected',
        allowDuringTranscribe: true,
      });
      if (armed) return;
    }
    await setXiaoaiSpeakerLed(event.target, 'off', this.deps?.sshRunner);
  }

  private getSpeakerManager(): XiaoaiSpeakerManager {
    if (this.speakerManager && this.speakerDepsRef !== this.deps) {
      this.speakerManager.close();
      this.speakerManager = undefined;
    }
    if (!this.speakerManager) {
      this.speakerDepsRef = this.deps;
      this.speakerManager = new XiaoaiSpeakerManager({
        homeDir: this.ctx.homeDir,
        speakerModelsDir: this.deps?.speakerModelsDir,
        registryPath: this.deps?.speakerRegistryPath,
        extractorFactory: this.deps?.speakerExtractorFactory,
        fetchImpl: this.deps?.fetchImpl,
      });
    }
    return this.speakerManager;
  }

  private isSpeakerGateEnforced(channel: ImChannelConfig): boolean {
    const opts = parseXiaoaiApiOptions(channel.apiBase);
    return this.getSpeakerManager().isVerificationActive({ speakerVerify: opts.speakerVerify });
  }

  private launchEnrollmentSession(
    channel: ImChannelConfig,
    targetId: string,
    sessionId: string,
    needsDownload: boolean,
  ): XiaoaiEnrollSessionSnapshot {
    const enrollWaitMs = this.deps?.speakerEnrollWaitMs ?? 15_000;
    const manager = this.getSpeakerManager();
    if (!needsDownload) {
      const activated = this.speakerEnroll.activateSession(sessionId);
      if (activated) {
        this.enqueueDirectSpeech(channel.id, targetId, activated.prompt, {
          followUpWaitMs: enrollWaitMs,
          discardMs: 120,
        });
        return activated.snapshot;
      }
    }

    const snapshot = this.speakerEnroll.getStatus(sessionId)!;
    this.enqueueDirectSpeech(channel.id, targetId, snapshot.message);
    void (async () => {
      try {
        await manager.ensureModelReady();
        if (this.ctx.isClosing()) return;
        const current = this.speakerEnroll.getStatus(sessionId);
        if (!current || current.status !== 'preparing_model') return;
        const activated = this.speakerEnroll.activateSession(sessionId);
        if (activated) {
          this.enqueueDirectSpeech(channel.id, targetId, activated.prompt, {
            followUpWaitMs: enrollWaitMs,
            discardMs: 120,
          });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : '声纹模型下载失败';
        const failed = this.speakerEnroll.failSession(sessionId, msg);
        if (!this.ctx.isClosing() && failed) {
          this.enqueueDirectSpeech(
            channel.id,
            targetId,
            '声纹模型下载失败，请检查网络或用命令行下载后再试。',
          );
        }
      }
    })();
    return snapshot;
  }

  private async tryHandleSpeakerVoice(
    channel: ImChannelConfig,
    inbound: ImInboundMessage,
  ): Promise<{ ok: boolean; action: string } | undefined> {
    const targetId = inbound.target ?? inbound.senderId;
    const manager = this.getSpeakerManager();

    if (this.speakerEnroll.isActive(channel.id, targetId)) {
      const enrollWaitMs = this.deps?.speakerEnrollWaitMs ?? 15_000;
      const activeSnap = this.speakerEnroll.getActive(channel.id, targetId);
      const existingProfile = activeSnap ? manager.findProfile(activeSnap.speakerName) : undefined;
      const stepRes = this.speakerEnroll.processSample({
        channelId: channel.id,
        targetId,
        samples: inbound.samples,
        sampleRate: inbound.sampleRate,
        transcript: inbound.text,
        extractor: (s, sr) => manager.extractEmbedding(s, sr),
        existingProfile,
        minEnrollDurationMs: this.deps?.speakerMinEnrollMs,
      });

      if (stepRes.outcome === 'cancelled' || stepRes.outcome === 'failed') {
        this.enqueueDirectSpeech(channel.id, targetId, stepRes.prompt);
        return {
          ok: true,
          action: stepRes.outcome === 'cancelled' ? 'voice_enroll_cancelled' : 'voice_enroll_failed',
        };
      }
      if (stepRes.outcome === 'retry' || stepRes.outcome === 'next_step') {
        this.enqueueDirectSpeech(channel.id, targetId, stepRes.prompt, {
          followUpWaitMs: enrollWaitMs,
          discardMs: 120,
        });
        return {
          ok: true,
          action: stepRes.outcome === 'retry' ? 'voice_enroll_retry' : 'voice_enroll_next_step',
        };
      }
      if (stepRes.outcome === 'ready_to_save') {
        const saved = manager.enrollEmbeddings({
          name: stepRes.session.speakerName,
          role: stepRes.session.role,
          mode: stepRes.session.mode,
          embeddings: stepRes.embeddings,
        });
        const status = manager.getStatus();
        const doneMsg = `已保存${saved.name}的声纹，当前共有${status.profiles.length}个已录入声纹。`;
        this.speakerEnroll.completeSession(stepRes.session.sessionId, saved.id, doneMsg);
        this.enqueueDirectSpeech(channel.id, targetId, doneMsg);
        return { ok: true, action: 'voice_enroll_completed' };
      }
    }

    const cmd = parseSpeakerVoiceCommand(inbound.text);
    if (!cmd) return undefined;

    if (cmd.kind === 'enroll') {
      const targets = parseXiaoaiSshTargets(channel.apiBase);
      const apiOpts = parseXiaoaiApiOptions(channel.apiBase);
      if (targets.length === 0 || !apiOpts.kws) {
        this.enqueueDirectSpeech(
          channel.id,
          targetId,
          '当前小爱频道还没有开启本地语音识别（kws=1），暂时不能直接通过语音录入声纹。',
        );
        return { ok: true, action: 'voice_enroll_unsupported' };
      }
      this.fastpathSessions.delete(`${channel.id}:${targetId}`);

      const profiles = manager.listProfiles();
      const speakerName = (
        cmd.targetName?.trim()
        || inbound.speaker?.name
        || (profiles.length === 0 ? '主人' : `成员${profiles.length + 1}`)
      ).slice(0, 40);
      const existing = manager.findProfile(speakerName);
      if (existing?.role === 'owner' && inbound.speaker && inbound.speaker.role !== 'owner') {
        this.enqueueDirectSpeech(channel.id, targetId, '只有主人本人或命令行可以重新录入主人声纹。');
        return { ok: true, action: 'voice_enroll_denied' };
      }
      const role: 'owner' | 'member' = existing?.role
        ?? (profiles.length === 0 || speakerName === '主人' ? 'owner' : 'member');
      const effectiveMode: 'replace' | 'append' = cmd.mode === 'append' && existing ? 'append' : 'replace';

      const preparing = this.speakerEnroll.createPreparingSession({
        channelId: channel.id,
        targetId,
        speakerName,
        role,
        mode: effectiveMode,
      });
      this.launchEnrollmentSession(channel, targetId, preparing.sessionId, !manager.isModelReady());
      return { ok: true, action: 'voice_enroll_started' };
    }

    if (cmd.kind === 'whoami') {
      const status = manager.getStatus();
      let reply: string;
      if (inbound.speaker) {
        reply = `你是${inbound.speaker.name}。`;
      } else if (status.profiles.length === 0) {
        reply = '目前还没有录入任何声纹，你可以说录入我的声纹。';
      } else if (!status.enabled) {
        reply = '声纹识别当前已暂停，你可以说开启声纹识别。';
      } else {
        reply = '当前暂未匹配到你的声纹，你可以说录入声纹。';
      }
      this.enqueueDirectSpeech(channel.id, targetId, reply);
      return { ok: true, action: 'voice_whoami' };
    }

    if (cmd.kind === 'list') {
      const status = manager.getStatus();
      const reply = status.profiles.length === 0
        ? '当前还没有录入任何声纹。'
        : `已录入${status.profiles.length}个声纹：${status.profiles.map(p => (p.role === 'owner' ? `${p.name}（主人）` : p.name)).join('、')}。声纹识别当前已${status.active ? '开启' : '暂停'}。`;
      this.enqueueDirectSpeech(channel.id, targetId, reply);
      return { ok: true, action: 'voice_list' };
    }

    if (cmd.kind === 'remove') {
      const targetName = cmd.targetName?.trim() || inbound.speaker?.name;
      if (!targetName) {
        this.enqueueDirectSpeech(channel.id, targetId, '请说出要删除谁的声纹，比如删除小明的声纹。');
        return { ok: true, action: 'voice_remove_missing_target' };
      }
      const found = manager.findProfile(targetName);
      if (!found) {
        this.enqueueDirectSpeech(channel.id, targetId, `没有找到名为${targetName}的声纹。`);
        return { ok: true, action: 'voice_remove_not_found' };
      }
      if (found.role === 'owner' && inbound.speaker && inbound.speaker.role !== 'owner') {
        this.enqueueDirectSpeech(channel.id, targetId, '只有主人本人或命令行可以删除主人声纹。');
        return { ok: true, action: 'voice_remove_denied' };
      }
      const res = manager.removeSpeaker(found.id);
      const reply = res.remaining === 0
        ? `已删除${found.name}的声纹，当前已没有已录入声纹。`
        : `已删除${found.name}的声纹，还剩${res.remaining}个声纹。`;
      this.enqueueDirectSpeech(channel.id, targetId, reply);
      return { ok: true, action: 'voice_removed' };
    }

    if (cmd.kind === 'clear') {
      if (inbound.speaker && inbound.speaker.role !== 'owner') {
        this.enqueueDirectSpeech(channel.id, targetId, '只有主人或命令行可以清空全部声纹。');
        return { ok: true, action: 'voice_clear_denied' };
      }
      const res = manager.clearSpeakers();
      const reply = res.cleared === 0
        ? '当前本来就没有录入声纹。'
        : `已清空全部${res.cleared}个声纹。`;
      this.enqueueDirectSpeech(channel.id, targetId, reply);
      return { ok: true, action: 'voice_cleared' };
    }

    if (cmd.kind === 'toggle') {
      if (!cmd.enabled && inbound.speaker && inbound.speaker.role !== 'owner') {
        this.enqueueDirectSpeech(channel.id, targetId, '只有主人或命令行可以暂停声纹识别。');
        return { ok: true, action: 'voice_toggle_denied' };
      }
      const status = manager.configure({ enabled: cmd.enabled });
      let reply: string;
      if (!cmd.enabled) {
        reply = '已暂停声纹识别。';
      } else if (status.profiles.length === 0) {
        reply = '声纹开关已打开，但还没有录入声纹，你可以说录入我的声纹。';
      } else if (!status.modelReady) {
        reply = '声纹开关已打开，首次录入时会自动下载声纹模型。';
      } else {
        reply = '已开启声纹识别。';
      }
      this.enqueueDirectSpeech(channel.id, targetId, reply);
      return { ok: true, action: 'voice_toggled' };
    }

    return undefined;
  }

  private async waitForCaptureIdle(channelId: string, targetId: string, maxWaitMs = 10_000): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    while (!this.ctx.isClosing() && this.kwsMonitor?.isCapturing(channelId, targetId) && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 60);
        timer.unref();
      });
    }
  }

  private hasNewerSpeakerUserMessage(msg: ChatMessage): boolean {
    const route = msg.origin;
    if (!route?.channelId || !route.conversationId) return false;
    let replyToSeq = msg.seq;
    if (msg.replyTo) {
      try {
        replyToSeq = this.ctx.coordinator.store.conversation.get(msg.replyTo).seq;
      } catch {
        replyToSeq = msg.seq;
      }
    }
    const items = this.ctx.coordinator.store.conversation.history(undefined, 16).items;
    return items.some((item) =>
      item.role === 'user'
      && item.seq > replyToSeq
      && item.origin?.channel === 'xiaoai'
      && item.origin.channelId === route.channelId
      && item.origin.conversationId === route.conversationId);
  }

  private isBackgroundTaskDeliveryMessage(msg: ChatMessage): boolean {
    if (!msg.taskIds?.length) return false;
    return msg.taskIds.some((taskId) => {
      try {
        const task = this.ctx.coordinator.store.get(taskId);
        return ['completed', 'failed', 'paused', 'cancelled'].includes(task.status) || Boolean(task.pendingQuestion);
      } catch {
        return false;
      }
    });
  }

  private hasPendingWorkerQuestion(msg: ChatMessage): boolean {
    if (!msg.taskIds?.length) return false;
    return msg.taskIds.some((taskId) => {
      try {
        return Boolean(this.ctx.coordinator.store.get(taskId).pendingQuestion);
      } catch {
        return false;
      }
    });
  }
}

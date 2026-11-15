import { setTimeout as delay } from 'node:timers/promises';
import { BoundedMap, buildRequestSignal } from '../im/types.js';
import type { ImChannelConfig } from '../store.js';
import {
  callMinaRemoteUbus,
  fetchMinaDeviceList,
  getCloudBases,
  resolveCloudSession,
  selectTargetMinaDevices,
} from './cloud-auth.js';
import {
  buildXiaoaiWakeCommand,
  defaultSshRunner,
  escapeShellSingleQuote,
  parseXiaoaiApiOptions,
  parseXiaoaiSshTargets,
  SSH_PLAY_STATUS_COMMAND,
  type XiaoaiSshRunner,
  type XiaoaiSshTarget,
} from './ssh.js';
import { splitSpeechSegments } from './utterance-utils.js';

export interface XiaoaiSendOptions {
  target?: string;
  replyToMessageId?: string;
  replyWebhook?: string;
  waitForCompletion?: boolean;
  sshRunner?: XiaoaiSshRunner;
  fetchImpl?: typeof fetch;
  shutdownSignal?: AbortSignal;
}

const MAX_RUNTIME_ENTRIES = 64;
const xiaoaiSpeakingGuards = new BoundedMap<string, { until: number }>(MAX_RUNTIME_ENTRIES);
const xiaoaiSpeechEpochs = new BoundedMap<string, number>(MAX_RUNTIME_ENTRIES);

function xiaoaiRuntimeKey(channelId: string, targetId: string): string {
  return `${channelId}:${targetId}`;
}

export function bumpXiaoaiSpeechEpoch(channelId: string, targetId: string): number {
  const key = xiaoaiRuntimeKey(channelId, targetId);
  xiaoaiSpeakingGuards.delete(key);
  const next = (xiaoaiSpeechEpochs.get(key) ?? 0) + 1;
  xiaoaiSpeechEpochs.set(key, next);
  return next;
}

function getXiaoaiSpeechEpoch(channelId: string, targetId: string): number {
  return xiaoaiSpeechEpochs.get(xiaoaiRuntimeKey(channelId, targetId)) ?? 0;
}

export function markXiaoaiSpeakingGuard(
  channelId: string,
  targetId: string,
  durationMs: number,
  overwrite = false,
): void {
  const key = xiaoaiRuntimeKey(channelId, targetId);
  const nextUntil = Date.now() + Math.max(0, durationMs);
  const prev = xiaoaiSpeakingGuards.get(key);
  xiaoaiSpeakingGuards.set(key, {
    until: !overwrite && prev ? Math.max(prev.until, nextUntil) : nextUntil,
  });
}

/**
 * Suppress bare `"星期五"` self-echo while Friday is speaking on this speaker,
 * while still allowing explicit wake phrases for barge-in.
 */
export function isXiaoaiSpeakingSelfEcho(
  channelId: string,
  targetId: string,
  keyword: string,
  now = Date.now(),
): boolean {
  const key = xiaoaiRuntimeKey(channelId, targetId);
  const guard = xiaoaiSpeakingGuards.get(key);
  if (!guard) return false;
  if (guard.until <= now) {
    xiaoaiSpeakingGuards.delete(key);
    return false;
  }
  return keyword.trim() === '星期五';
}

export function resetXiaoaiRuntimeState(): void {
  xiaoaiSpeakingGuards.clear();
  xiaoaiSpeechEpochs.clear();
}

export async function handleXiaoaiKeywordWake(params: {
  channel: ImChannelConfig;
  target: XiaoaiSshTarget;
  keyword: string;
  chime?: boolean;
  sshRunner?: XiaoaiSshRunner;
}): Promise<{ woken: boolean; suppressed: boolean }> {
  const { channel, target, keyword } = params;
  if (isXiaoaiSpeakingSelfEcho(channel.id, target.id, keyword)) {
    return { woken: false, suppressed: true };
  }
  bumpXiaoaiSpeechEpoch(channel.id, target.id);
  const apiOptions = parseXiaoaiApiOptions(channel.apiBase);
  const sshRunner = params.sshRunner ?? defaultSshRunner;
  const useChime = params.chime !== undefined ? params.chime : apiOptions.kwsChime;
  const res = await sshRunner(
    target,
    buildXiaoaiWakeCommand({ chime: useChime }),
    { timeoutMs: 8_000 },
  );
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || `小爱唤醒触发失败 (exit=${res.code})`);
  }
  return { woken: true, suppressed: false };
}

function isXiaoaiPlayerPlaying(stdout: string): boolean {
  return /\\?"status\\?"\s*:\s*1\b/i.test(stdout) || /\\?"state\\?"\s*:\s*\\?"playing\\?"/i.test(stdout);
}

async function waitForXiaoaiSegmentPlayback(
  target: XiaoaiSshTarget,
  sshRunner: XiaoaiSshRunner,
  segmentLength: number,
  isCancelled?: () => boolean,
): Promise<void> {
  if (isCancelled?.()) return;
  const probe = await sshRunner(target, SSH_PLAY_STATUS_COMMAND, { timeoutMs: 4_000 }).catch(() => undefined);
  if (!probe || probe.code !== 0 || !probe.stdout.trim()) return;

  const startedAt = Date.now();
  let sawPlaying = isXiaoaiPlayerPlaying(probe.stdout);
  const startGraceMs = 1_200;
  const maxWaitMs = Math.min(45_000, Math.max(6_000, segmentLength * 350));

  while (Date.now() - startedAt < maxWaitMs) {
    if (isCancelled?.()) return;
    if (sawPlaying || Date.now() - startedAt >= startGraceMs) {
      if (!sawPlaying) return;
    }
    await delay(220);
    if (isCancelled?.()) return;
    const res = await sshRunner(target, SSH_PLAY_STATUS_COMMAND, { timeoutMs: 4_000 }).catch(() => undefined);
    if (!res || res.code !== 0 || !res.stdout.trim()) return;
    const playing = isXiaoaiPlayerPlaying(res.stdout);
    if (playing) {
      sawPlaying = true;
      continue;
    }
    if (sawPlaying) return;
  }
}

export async function sendXiaoaiSpeech(
  channel: ImChannelConfig,
  rawText: string,
  options?: XiaoaiSendOptions,
): Promise<{ segments: string[]; mode: 'webhook' | 'ssh' | 'cloud' }> {
  const sshTargets = parseXiaoaiSshTargets(channel.apiBase);
  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  const webhookUrl = options?.replyWebhook?.trim()
    || (sshTargets.length === 0 ? channel.webhookUrl?.trim() : undefined);

  if (webhookUrl) {
    const segments = splitSpeechSegments(rawText);
    if (segments.length === 0) return { segments: [], mode: 'webhook' };

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (channel.botToken) {
      headers.authorization = `Bearer ${channel.botToken}`;
    }
    const res = await fetchFn(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        msgtype: 'tts',
        target: options?.target ?? channel.defaultTarget ?? 'default',
        text: segments.join(' '),
        segments,
        rawText,
      }),
      signal: buildRequestSignal(15_000, options?.shutdownSignal),
    });
    if (!res.ok) {
      throw new Error(`小爱 Webhook 发送失败: HTTP ${res.status}`);
    }
    return { segments, mode: 'webhook' };
  }

  if (sshTargets.length > 0) {
    const segments = splitSpeechSegments(rawText);
    if (segments.length === 0) return { segments: [], mode: 'ssh' };

    const requestedTarget = options?.target?.trim() || channel.defaultTarget?.trim();
    const matched = requestedTarget
      ? sshTargets.find(t => t.id === requestedTarget || t.userHost === requestedTarget)
      : undefined;
    const target = matched ?? sshTargets[0];
    if (!target) {
      throw new Error('小爱 SSH 目标列表为空');
    }

    const sshRunner = options?.sshRunner ?? defaultSshRunner;
    const speechEpoch = getXiaoaiSpeechEpoch(channel.id, target.id);
    const isEpochCancelled = () => getXiaoaiSpeechEpoch(channel.id, target.id) !== speechEpoch;
    for (let i = 0; i < segments.length; i++) {
      if (isEpochCancelled()) break;
      const seg = segments[i]!;
      const estimatedSpeechMs = Math.min(18_000, Math.max(2_200, seg.length * 190 + 900));
      markXiaoaiSpeakingGuard(channel.id, target.id, estimatedSpeechMs);
      const jsonPayload = JSON.stringify({ text: seg, save: 0 });
      const cmd = `rm -f /tmp/friday_led_tok; touch /tmp/friday_speaking; (/bin/shut_led 1 >/dev/null 2>&1; /bin/shut_led 2 >/dev/null 2>&1 || true); ubus call mibrain text_to_speech '${escapeShellSingleQuote(jsonPayload)}' >/dev/null 2>&1 || /usr/sbin/tts_play.sh '${escapeShellSingleQuote(seg)}'`;
      const res = await sshRunner(target, cmd, { timeoutMs: 12_000 });
      if (res.code !== 0) {
        throw new Error(res.stderr.trim() || `小爱 SSH TTS 失败 (exit=${res.code})`);
      }
      if (i < segments.length - 1 || options?.waitForCompletion) {
        await waitForXiaoaiSegmentPlayback(target, sshRunner, seg.length, isEpochCancelled);
        if (i === segments.length - 1 && !isEpochCancelled()) {
          markXiaoaiSpeakingGuard(channel.id, target.id, 350, true);
        }
      } else {
        markXiaoaiSpeakingGuard(channel.id, target.id, estimatedSpeechMs);
      }
    }
    return { segments, mode: 'ssh' };
  }

  if (channel.accountId && channel.botToken) {
    const segments = splitSpeechSegments(rawText);
    if (segments.length === 0) return { segments: [], mode: 'cloud' };

    const { accountBase, minaBase } = getCloudBases(channel.apiBase);
    const resolved = await resolveCloudSession(channel, accountBase, minaBase, fetchFn, false);
    let targetDeviceId = options?.target?.trim()
      || channel.defaultTarget?.trim()
      || resolved.session.deviceId;

    if (!targetDeviceId) {
      const { devices } = await fetchMinaDeviceList(minaBase, resolved.session, fetchFn);
      const selected = selectTargetMinaDevices(devices, undefined, undefined)[0];
      targetDeviceId = selected?.deviceID;
    }
    if (!targetDeviceId) {
      throw new Error('小米云模式下未找到可用的小爱音箱设备ID');
    }

    for (const seg of segments) {
      await callMinaRemoteUbus(
        minaBase,
        resolved.session,
        targetDeviceId,
        'mibrain',
        'text_to_speech',
        JSON.stringify({ text: seg, save: 0 }),
        fetchFn,
      );
    }
    return { segments, mode: 'cloud' };
  }

  throw new Error('小爱音箱通道未配置发送方式（需要 SSH 地址、webhookUrl 或小米云账号凭证）');
}

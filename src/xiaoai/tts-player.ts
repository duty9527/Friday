import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { notifyCs80Scene } from '../cs80-scene.js';
import { BoundedMap, buildRequestSignal, isAllowedReplyWebhook, sanitizeImError } from '../im/types.js';
import type { ImChannelConfig } from '../store.js';
import {
  callMinaRemoteUbus,
  fetchMinaDeviceList,
  getCloudBases,
  resolveCloudSession,
  selectTargetMinaDevices,
} from './cloud-auth.js';
import {
  buildXiaoaiSshArgs,
  buildXiaoaiWakeCommand,
  buildXiaoaiWakePrewarmCommand,
  defaultSshRunner,
  escapeShellSingleQuote,
  getXiaoaiWakeCacheFileName,
  parseXiaoaiApiOptions,
  parseXiaoaiSshTargets,
  resolveXiaoaiSshControlPath,
  SSH_PLAY_STATUS_COMMAND,
  type XiaoaiSshRunner,
  type XiaoaiSshTarget,
} from './ssh.js';
import { smoothXiaoaiTtsProsody, splitSpeechSegments } from './utterance-utils.js';

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
const MAX_BINARY_CHILD_STDOUT_BYTES = 4 * 1024 * 1024;
const xiaoaiSpeakingGuards = new BoundedMap<string, { until: number }>(MAX_RUNTIME_ENTRIES);
const xiaoaiSpeechEpochs = new BoundedMap<string, number>(MAX_RUNTIME_ENTRIES);
const xiaoaiPendingWakes = new BoundedMap<string, Promise<void>>(MAX_RUNTIME_ENTRIES);

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

export const XIAOAI_URGENT_WAKE_MAX_MS = 900;

export const DEFAULT_OWNER_WAKE_GREETINGS = [
  '在的老板',
  '早上好老板',
  '中午好老板',
  '下午好老板',
  '晚上好老板',
] as const;

export function resolveXiaoaiWakeGreeting(params?: {
  keyword?: string;
  wakeDurationMs?: number;
  urgent?: boolean;
  now?: Date | number;
  speaker?: { name?: string; role?: 'owner' | 'member' };
}): string {
  const title = params?.speaker?.role === 'member' && params.speaker.name?.trim()
    ? params.speaker.name.trim()
    : '老板';
  let isUrgent: boolean;
  if (params?.urgent === true) {
    isUrgent = true;
  } else if (params?.urgent === false) {
    isUrgent = false;
  } else if (typeof params?.wakeDurationMs === 'number' && Number.isFinite(params.wakeDurationMs) && params.wakeDurationMs > 0) {
    isUrgent = params.wakeDurationMs < XIAOAI_URGENT_WAKE_MAX_MS;
  } else {
    const kwLen = params?.keyword?.trim().length ?? 0;
    isUrgent = kwLen > 0 && kwLen <= 3;
  }
  if (isUrgent) {
    return `在的${title}`;
  }
  const date = params?.now instanceof Date
    ? params.now
    : typeof params?.now === 'number'
      ? new Date(params.now)
      : new Date();
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return `早上好${title}`;
  if (hour >= 11 && hour < 14) return `中午好${title}`;
  if (hour >= 14 && hour < 18) return `下午好${title}`;
  return `晚上好${title}`;
}

function runBinaryChild(
  cmd: string,
  args: readonly string[],
  input?: Buffer,
  timeoutMs = 10_000,
): Promise<{ code: number; stdout: Buffer }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (code: number, empty = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: empty ? Buffer.alloc(0) : Buffer.concat(chunks) });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(124);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > MAX_BINARY_CHILD_STDOUT_BYTES) {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        chunks.length = 0;
        finish(1, true);
        return;
      }
      chunks.push(buf);
    });
    child.stdin.on('error', () => {});
    child.once('error', () => finish(1));
    child.once('close', (code) => finish(typeof code === 'number' ? code : 1));
    if (input) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

export async function tightenWakeMp3BufferWithFfmpeg(inputMp3: Buffer): Promise<Buffer | undefined> {
  if (inputMp3.length < 400) return undefined;
  const res = await runBinaryChild(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-f', 'mp3', '-i', 'pipe:0',
      '-af', 'silenceremove=start_periods=1:start_silence=0.01:start_threshold=-42dB:stop_periods=-1:stop_duration=0.045:stop_silence=0.035:stop_threshold=-42dB',
      '-ar', '16000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k', '-f', 'mp3', 'pipe:1',
    ],
    inputMp3,
    10_000,
  );
  if (res.code !== 0 || res.stdout.length < 400 || res.stdout.length > inputMp3.length * 1.5) {
    return undefined;
  }
  return res.stdout;
}

export async function tightenWakeAudioToWavBufferWithFfmpeg(inputMp3: Buffer): Promise<Buffer | undefined> {
  if (inputMp3.length < 400) return undefined;
  const res = await runBinaryChild(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error', '-f', 'mp3', '-i', 'pipe:0',
      '-af', 'silenceremove=start_periods=1:start_silence=0.01:start_threshold=-40dB:stop_periods=-1:stop_duration=0.045:stop_silence=0.03:stop_threshold=-42dB',
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1',
    ],
    inputMp3,
    10_000,
  );
  if (
    res.code !== 0
    || res.stdout.length < 800
    || res.stdout.length > 256_000
    || res.stdout.subarray(0, 4).toString('ascii') !== 'RIFF'
  ) {
    return undefined;
  }
  return res.stdout;
}

export async function prewarmXiaoaiWakeGreetings(
  target: XiaoaiSshTarget,
  phrases: readonly string[] = DEFAULT_OWNER_WAKE_GREETINGS,
  sshRunner: XiaoaiSshRunner = defaultSshRunner,
): Promise<void> {
  const cmd = buildXiaoaiWakePrewarmCommand(phrases);
  const res = await sshRunner(target, cmd, { timeoutMs: 25_000 }).catch(() => undefined);
  if (res && res.code !== 0 && res.stderr.trim()) {
    console.warn(`[xiaoai-ssh] wake greeting prewarm warning for ${target.id}: ${res.stderr.trim()}`);
  }
  if (sshRunner !== defaultSshRunner) {
    return;
  }
  let controlPath: string | undefined;
  try {
    controlPath = resolveXiaoaiSshControlPath();
  } catch {
    controlPath = undefined;
  }
  const uniquePhrases = [...new Set(phrases.map(p => p.replace(/["\\$`\r\n]/g, '').trim()).filter(Boolean))];
  for (const phrase of uniquePhrases) {
    const cacheFile = getXiaoaiWakeCacheFileName(phrase);
    const readCmd = `for d in /data/friday_wake_cache /tmp/friday_wake_cache; do if [ -s "$d/${cacheFile}" ] && { [ ! -s "$d/${cacheFile}.wav" ] || [ ! -f "$d/${cacheFile}.tight" ]; }; then cat "$d/${cacheFile}"; break; fi; done`;
    const readRes = await runBinaryChild('ssh', ['-T', ...buildXiaoaiSshArgs(target, readCmd, controlPath)], undefined, 10_000);
    if (readRes.code !== 0 || readRes.stdout.length < 400) continue;
    const tightenedWav = await tightenWakeAudioToWavBufferWithFfmpeg(readRes.stdout);
    if (tightenedWav) {
      const writeWavCmd = `CDIR=/data/friday_wake_cache; [ -d "$CDIR" ] || CDIR=/tmp/friday_wake_cache; WF="$CDIR/${cacheFile}.wav"; cat > "$WF.tmp" && [ -s "$WF.tmp" ] && mv -f "$WF.tmp" "$WF"; rm -f "$WF.tmp" 2>/dev/null || true`;
      await runBinaryChild('ssh', ['-T', ...buildXiaoaiSshArgs(target, writeWavCmd, controlPath)], tightenedWav, 10_000);
    }
    const tightened = await tightenWakeMp3BufferWithFfmpeg(readRes.stdout);
    if (tightened) {
      const writeCmd = `CDIR=/data/friday_wake_cache; [ -d "$CDIR" ] || CDIR=/tmp/friday_wake_cache; CF="$CDIR/${cacheFile}"; if [ ! -f "$CF.tight" ]; then cat > "$CF.tmp" && [ -s "$CF.tmp" ] && mv -f "$CF.tmp" "$CF" && : > "$CF.tight"; rm -f "$CF.tmp" 2>/dev/null || true; fi`;
      await runBinaryChild('ssh', ['-T', ...buildXiaoaiSshArgs(target, writeCmd, controlPath)], tightened, 10_000);
    }
  }
}

export async function handleXiaoaiKeywordWake(params: {
  channel: ImChannelConfig;
  target: XiaoaiSshTarget;
  keyword: string;
  chime?: boolean;
  wakeDurationMs?: number;
  urgent?: boolean;
  speaker?: { name?: string; role?: 'owner' | 'member' };
  now?: Date | number;
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
  const greetingText = useChime
    ? resolveXiaoaiWakeGreeting({
        keyword,
        wakeDurationMs: params.wakeDurationMs,
        urgent: params.urgent,
        speaker: params.speaker,
        now: params.now,
      })
    : undefined;
  const runtimeKey = xiaoaiRuntimeKey(channel.id, target.id);
  const wakePromise = sshRunner(
    target,
    buildXiaoaiWakeCommand({ chime: useChime, greetingText }),
    { timeoutMs: 12_000 },
  );
  const trackedWake = wakePromise.then(() => {}, () => {});
  xiaoaiPendingWakes.set(runtimeKey, trackedWake);
  let res: { stdout: string; stderr: string; code: number };
  try {
    res = await wakePromise;
  } finally {
    if (xiaoaiPendingWakes.get(runtimeKey) === trackedWake) {
      xiaoaiPendingWakes.delete(runtimeKey);
    }
  }
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || `小爱唤醒触发失败 (exit=${res.code})`);
  }
  if (useChime) {
    markXiaoaiSpeakingGuard(channel.id, target.id, 450, true);
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
  shutdownSignal?: AbortSignal,
): Promise<'completed' | 'unknown' | 'cancelled'> {
  if (isCancelled?.() || shutdownSignal?.aborted) return 'cancelled';
  const probe = await sshRunner(target, SSH_PLAY_STATUS_COMMAND, { timeoutMs: 4_000 }).catch(() => undefined);
  if (!probe || probe.code !== 0 || !probe.stdout.trim()) return 'unknown';

  const startedAt = Date.now();
  let sawPlaying = isXiaoaiPlayerPlaying(probe.stdout);
  const startGraceMs = 1_200;
  const maxWaitMs = Math.min(45_000, Math.max(6_000, segmentLength * 350));

  while (Date.now() - startedAt < maxWaitMs) {
    if (isCancelled?.() || shutdownSignal?.aborted) return 'cancelled';
    if (!sawPlaying && Date.now() - startedAt >= startGraceMs) {
      return 'unknown';
    }
    try {
      await delay(220, undefined, shutdownSignal ? { signal: shutdownSignal } : undefined);
    } catch {
      return 'cancelled';
    }
    if (isCancelled?.() || shutdownSignal?.aborted) return 'cancelled';
    const res = await sshRunner(target, SSH_PLAY_STATUS_COMMAND, { timeoutMs: 4_000 }).catch(() => undefined);
    if (!res || res.code !== 0 || !res.stdout.trim()) return sawPlaying ? 'completed' : 'unknown';
    const playing = isXiaoaiPlayerPlaying(res.stdout);
    if (playing) {
      sawPlaying = true;
      continue;
    }
    if (sawPlaying) return 'completed';
  }
  return sawPlaying ? 'completed' : 'unknown';
}

export async function sendXiaoaiSpeech(
  channel: ImChannelConfig,
  rawText: string,
  options?: XiaoaiSendOptions,
): Promise<{ segments: string[]; mode: 'webhook' | 'ssh' | 'cloud' }> {
  const sshTargets = parseXiaoaiSshTargets(channel.apiBase);
  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  const requestedReplyWebhook = options?.replyWebhook?.trim();
  if (requestedReplyWebhook && !isAllowedReplyWebhook('xiaoai', requestedReplyWebhook, channel)) {
    throw new Error('拒绝向未授权的小爱回调地址发送语音');
  }
  const webhookUrl = requestedReplyWebhook
    || (sshTargets.length === 0 ? channel.webhookUrl?.trim() : undefined);
  const cs80Opts = { skipWhenMocked: Boolean(options?.sshRunner || options?.fetchImpl) };
  const estimateTotalSpeechSec = (segs: readonly string[]) => {
    const ms = segs.reduce((sum, s) => sum + Math.min(18_000, Math.max(2_200, s.length * 190 + 900)), 0);
    return Math.min(45, Math.max(3.5, ms / 1000 + 1.2));
  };

  if (webhookUrl) {
    const segments = splitSpeechSegments(rawText);
    if (segments.length === 0) return { segments: [], mode: 'webhook' };
    const estHoldSec = estimateTotalSpeechSec(segments);
    notifyCs80Scene(
      { scene: 'speaking', phase: 'start', channel: 'xiaoai', holdSec: estHoldSec, caption: '小爱音箱正在播报回复…' },
      cs80Opts,
    );

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const sameAsConfiguredWebhook = Boolean(channel.webhookUrl?.trim() && webhookUrl === channel.webhookUrl.trim());
    if (channel.botToken && sameAsConfiguredWebhook) {
      headers.authorization = `Bearer ${channel.botToken}`;
    }
    let res: Response;
    try {
      res = await fetchFn(webhookUrl, {
        method: 'POST',
        headers,
        redirect: 'error',
        body: JSON.stringify({
          msgtype: 'tts',
          target: options?.target ?? channel.defaultTarget ?? 'default',
          text: segments.join(' '),
          segments,
          rawText,
        }),
        signal: buildRequestSignal(15_000, options?.shutdownSignal),
      });
    } catch (err) {
      notifyCs80Scene({ scene: 'speaking', phase: 'end', tailSec: 0 }, cs80Opts);
      throw new Error(sanitizeImError(err, [channel.botToken, channel.secret]));
    }
    if (!res.ok) {
      notifyCs80Scene({ scene: 'speaking', phase: 'end', tailSec: 0 }, cs80Opts);
      throw new Error(`小爱 Webhook 发送失败: HTTP ${res.status}`);
    }
    notifyCs80Scene(
      { scene: 'speaking', phase: 'pulse', channel: 'xiaoai', holdSec: Math.min(15, estHoldSec), caption: '小爱音箱正在播报回复…' },
      cs80Opts,
    );
    return { segments, mode: 'webhook' };
  }

  if (sshTargets.length > 0) {
    const segments = splitSpeechSegments(rawText);
    if (segments.length === 0) return { segments: [], mode: 'ssh' };

    const requestedTarget = options?.target?.trim() || channel.defaultTarget?.trim();
    const matched = requestedTarget && requestedTarget !== 'default'
      ? sshTargets.find(t => t.id === requestedTarget || t.userHost === requestedTarget)
      : undefined;
    if (requestedTarget && requestedTarget !== 'default' && !matched) {
      throw new Error(`未找到匹配的小爱 SSH 目标设备: ${requestedTarget}`);
    }
    const target = matched ?? sshTargets[0];
    if (!target) {
      throw new Error('小爱 SSH 目标列表为空');
    }

    const sshRunner = options?.sshRunner ?? defaultSshRunner;
    const runtimeKey = xiaoaiRuntimeKey(channel.id, target.id);
    const pendingWake = xiaoaiPendingWakes.get(runtimeKey);
    if (pendingWake) {
      const wakeWaitController = new AbortController();
      const wakeSignal = options?.shutdownSignal
        ? AbortSignal.any([wakeWaitController.signal, options.shutdownSignal])
        : wakeWaitController.signal;
      try {
        await Promise.race([
          pendingWake,
          delay(1_500, undefined, { signal: wakeSignal }).catch(() => {}),
        ]);
      } finally {
        wakeWaitController.abort();
      }
    }
    const speechEpoch = getXiaoaiSpeechEpoch(channel.id, target.id);
    const isEpochCancelled = () => getXiaoaiSpeechEpoch(channel.id, target.id) !== speechEpoch;
    const estHoldSec = estimateTotalSpeechSec(segments);
    notifyCs80Scene(
      { scene: 'speaking', phase: 'start', channel: 'xiaoai', holdSec: estHoldSec, caption: '小爱音箱正在播报回复…' },
      cs80Opts,
    );
    let lastEstimatedMs = 3_000;
    let waitedLastSegment = false;
    try {
      for (let i = 0; i < segments.length; i++) {
        if (isEpochCancelled() || options?.shutdownSignal?.aborted) break;
        const seg = segments[i]!;
        const spokenSeg = smoothXiaoaiTtsProsody(seg) || seg;
        const estimatedSpeechMs = Math.min(18_000, Math.max(2_200, spokenSeg.length * 190 + 900));
        lastEstimatedMs = estimatedSpeechMs;
        const segStartedAt = Date.now();
        markXiaoaiSpeakingGuard(channel.id, target.id, estimatedSpeechMs);
        const jsonPayload = JSON.stringify({ text: spokenSeg, save: 0 });
        const cmd = `rm -f /tmp/friday_led_tok; touch /tmp/friday_speaking; (/bin/shut_led 1 >/dev/null 2>&1; /bin/shut_led 2 >/dev/null 2>&1 || true); ubus call mibrain text_to_speech '${escapeShellSingleQuote(jsonPayload)}' >/dev/null 2>&1 || /usr/sbin/tts_play.sh '${escapeShellSingleQuote(spokenSeg)}'`;
        const res = await sshRunner(target, cmd, { timeoutMs: 12_000 });
        if (res.code !== 0) {
          throw new Error(res.stderr.trim() || `小爱 SSH TTS 失败 (exit=${res.code})`);
        }
        if (i < segments.length - 1 || options?.waitForCompletion) {
          const outcome = await waitForXiaoaiSegmentPlayback(
            target,
            sshRunner,
            spokenSeg.length,
            isEpochCancelled,
            options?.shutdownSignal,
          );
          if (outcome === 'completed') {
            if (i === segments.length - 1) waitedLastSegment = true;
            if (i === segments.length - 1 && !isEpochCancelled()) {
              markXiaoaiSpeakingGuard(channel.id, target.id, 350, true);
            }
          } else if (outcome === 'unknown' && !isEpochCancelled()) {
            // Playback status could not be confirmed: preserve remaining estimated speech guard
            // (do NOT shrink to 350ms), and wait remainingMs before starting any subsequent segment.
            const remainingMs = Math.max(0, estimatedSpeechMs - (Date.now() - segStartedAt));
            if (i < segments.length - 1 && remainingMs > 0) {
              await delay(
                Math.min(remainingMs, 15_000),
                undefined,
                options?.shutdownSignal ? { signal: options.shutdownSignal } : undefined,
              ).catch(() => {});
            }
            if (i === segments.length - 1) {
              lastEstimatedMs = Math.max(350, remainingMs);
              markXiaoaiSpeakingGuard(channel.id, target.id, lastEstimatedMs, true);
            }
          }
        } else {
          markXiaoaiSpeakingGuard(channel.id, target.id, estimatedSpeechMs);
        }
      }
      if (isEpochCancelled() || options?.shutdownSignal?.aborted) {
        notifyCs80Scene({ scene: 'speaking', phase: 'end', tailSec: 0 }, cs80Opts);
      } else if (waitedLastSegment) {
        notifyCs80Scene({ scene: 'speaking', phase: 'end', tailSec: 0.35 }, cs80Opts);
      } else {
        notifyCs80Scene(
          { scene: 'speaking', phase: 'pulse', channel: 'xiaoai', holdSec: Math.max(2.2, lastEstimatedMs / 1000), caption: '小爱音箱正在播报回复…' },
          cs80Opts,
        );
      }
      return { segments, mode: 'ssh' };
    } catch (err) {
      notifyCs80Scene({ scene: 'speaking', phase: 'end', tailSec: 0 }, cs80Opts);
      throw err;
    }
  }

  if (channel.accountId && channel.botToken) {
    const segments = splitSpeechSegments(rawText);
    if (segments.length === 0) return { segments: [], mode: 'cloud' };

    const { accountBase, minaBase } = getCloudBases(channel.apiBase);
    const resolved = await resolveCloudSession(channel, accountBase, minaBase, fetchFn, false, options?.shutdownSignal);
    const explicitTarget = options?.target?.trim() && options.target.trim() !== 'default'
      ? options.target.trim()
      : channel.defaultTarget?.trim();
    let targetDeviceId = explicitTarget || resolved.session.deviceId;

    if (!targetDeviceId) {
      const { devices } = await fetchMinaDeviceList(minaBase, resolved.session, fetchFn, options?.shutdownSignal);
      const selected = selectTargetMinaDevices(devices, explicitTarget, resolved.session.deviceId)[0];
      targetDeviceId = selected?.deviceID;
    }
    if (!targetDeviceId) {
      throw new Error('小米云模式下未找到可用的小爱音箱设备ID');
    }

    const speechEpoch = getXiaoaiSpeechEpoch(channel.id, targetDeviceId);
    const isEpochCancelled = () => getXiaoaiSpeechEpoch(channel.id, targetDeviceId) !== speechEpoch;
    const estHoldSec = estimateTotalSpeechSec(segments);
    notifyCs80Scene(
      { scene: 'speaking', phase: 'start', channel: 'xiaoai', holdSec: estHoldSec, caption: '小爱音箱正在播报回复…' },
      cs80Opts,
    );
    let lastCloudMs = 2_500;
    try {
      for (let i = 0; i < segments.length; i++) {
        if (isEpochCancelled() || options?.shutdownSignal?.aborted) break;
        const seg = segments[i]!;
        const spokenSeg = smoothXiaoaiTtsProsody(seg) || seg;
        const estimatedSpeechMs = Math.min(18_000, Math.max(1_800, spokenSeg.length * 190 + 700));
        lastCloudMs = estimatedSpeechMs;
        markXiaoaiSpeakingGuard(channel.id, targetDeviceId, estimatedSpeechMs);
        await callMinaRemoteUbus(
          minaBase,
          resolved.session,
          targetDeviceId,
          'mibrain',
          'text_to_speech',
          JSON.stringify({ text: spokenSeg, save: 0 }),
          fetchFn,
          options?.shutdownSignal,
        );
        if (i < segments.length - 1 && !isEpochCancelled() && !options?.shutdownSignal?.aborted) {
          await delay(
            estimatedSpeechMs,
            undefined,
            options?.shutdownSignal ? { signal: options.shutdownSignal } : undefined,
          ).catch(() => {});
        }
      }
      if (isEpochCancelled() || options?.shutdownSignal?.aborted) {
        notifyCs80Scene({ scene: 'speaking', phase: 'end', tailSec: 0 }, cs80Opts);
      } else {
        notifyCs80Scene(
          { scene: 'speaking', phase: 'pulse', channel: 'xiaoai', holdSec: Math.max(2.2, lastCloudMs / 1000), caption: '小爱音箱正在播报回复…' },
          cs80Opts,
        );
      }
      return { segments, mode: 'cloud' };
    } catch (err) {
      notifyCs80Scene({ scene: 'speaking', phase: 'end', tailSec: 0 }, cs80Opts);
      throw err;
    }
  }

  throw new Error('小爱音箱通道未配置发送方式（需要 SSH 地址、webhookUrl 或小米云账号凭证）');
}

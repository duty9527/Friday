import { spawn } from 'node:child_process';
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
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks) });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(124);
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
    const readCmd = `for d in /data/friday_wake_cache /tmp/friday_wake_cache; do if [ -s "$d/${cacheFile}" ] && [ ! -f "$d/${cacheFile}.tight" ]; then cat "$d/${cacheFile}"; break; fi; done`;
    const readRes = await runBinaryChild('ssh', ['-T', ...buildXiaoaiSshArgs(target, readCmd, controlPath)], undefined, 10_000);
    if (readRes.code !== 0 || readRes.stdout.length < 400) continue;
    const tightened = await tightenWakeMp3BufferWithFfmpeg(readRes.stdout);
    if (!tightened) continue;
    const writeCmd = `CDIR=/data/friday_wake_cache; [ -d "$CDIR" ] || CDIR=/tmp/friday_wake_cache; CF="$CDIR/${cacheFile}"; cat > "$CF.tmp" && [ -s "$CF.tmp" ] && mv -f "$CF.tmp" "$CF" && : > "$CF.tight"; rm -f "$CF.tmp" 2>/dev/null || true`;
    await runBinaryChild('ssh', ['-T', ...buildXiaoaiSshArgs(target, writeCmd, controlPath)], tightened, 10_000);
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
  const res = await sshRunner(
    target,
    buildXiaoaiWakeCommand({ chime: useChime, greetingText }),
    { timeoutMs: 12_000 },
  );
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
      const spokenSeg = smoothXiaoaiTtsProsody(seg) || seg;
      const estimatedSpeechMs = Math.min(18_000, Math.max(2_200, spokenSeg.length * 190 + 900));
      markXiaoaiSpeakingGuard(channel.id, target.id, estimatedSpeechMs);
      const jsonPayload = JSON.stringify({ text: spokenSeg, save: 0 });
      const cmd = `rm -f /tmp/friday_led_tok; touch /tmp/friday_speaking; (/bin/shut_led 1 >/dev/null 2>&1; /bin/shut_led 2 >/dev/null 2>&1 || true); ubus call mibrain text_to_speech '${escapeShellSingleQuote(jsonPayload)}' >/dev/null 2>&1 || /usr/sbin/tts_play.sh '${escapeShellSingleQuote(spokenSeg)}'`;
      const res = await sshRunner(target, cmd, { timeoutMs: 12_000 });
      if (res.code !== 0) {
        throw new Error(res.stderr.trim() || `小爱 SSH TTS 失败 (exit=${res.code})`);
      }
      if (i < segments.length - 1 || options?.waitForCompletion) {
        await waitForXiaoaiSegmentPlayback(target, sshRunner, spokenSeg.length, isEpochCancelled);
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
      const spokenSeg = smoothXiaoaiTtsProsody(seg) || seg;
      await callMinaRemoteUbus(
        minaBase,
        resolved.session,
        targetDeviceId,
        'mibrain',
        'text_to_speech',
        JSON.stringify({ text: spokenSeg, save: 0 }),
        fetchFn,
      );
    }
    return { segments, mode: 'cloud' };
  }

  throw new Error('小爱音箱通道未配置发送方式（需要 SSH 地址、webhookUrl 或小米云账号凭证）');
}

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { ImChannelConfig } from '../store.js';
import type { XiaoaiMatchedSpeaker } from '../im/types.js';
import {
  escapeShellSingleQuote,
  parseXiaoaiApiOptions,
  parseXiaoaiSshTargets,
  setDefaultXiaoaiSshHome,
  setXiaoaiSpeakerLed,
  type XiaoaiSshRunner,
  type XiaoaiSshTarget,
} from './ssh.js';
import { handleXiaoaiKeywordWake, isXiaoaiSpeakingSelfEcho } from './tts-player.js';
import {
  cleanXiaoaiAsrUtterance,
  extractLeadingXiaoaiWakeKeyword,
  hasLeadingXiaoaiWakeWord,
  isXiaoaiFollowUpCancel,
} from './utterance-utils.js';

export const XIAOAI_KEYWORDS_VERSION = 'v4';

export const DEFAULT_XIAOAI_KEYWORDS = [
  // 星期五 (bare wake word + universal catch-all when prefix is slurred)
  'x īng q ī w ǔ :1.35 #0.19 @星期五',
  'x īng q ì w ǔ :1.35 #0.19 @星期五',
  'x īng q í w ǔ :1.35 #0.19 @星期五',
  'x īng q ǐ w ǔ :1.30 #0.20 @星期五',
  'x īng q i w ǔ :1.30 #0.20 @星期五',
  'x íng q ī w ǔ :1.30 #0.20 @星期五',
  'x íng q í w ǔ :1.30 #0.20 @星期五',
  'x īn q ī w ǔ :1.35 #0.19 @星期五',
  'x īn q ì w ǔ :1.35 #0.19 @星期五',
  'x īn q í w ǔ :1.35 #0.19 @星期五',
  'x īn q ǐ w ǔ :1.30 #0.20 @星期五',
  'x īn q i w ǔ :1.30 #0.20 @星期五',
  'x ìn q ī w ǔ :1.30 #0.20 @星期五',
  'x ìn q ì w ǔ :1.30 #0.20 @星期五',
  'x ìn q í w ǔ :1.30 #0.20 @星期五',
  'x īng q ī w ù :1.30 #0.20 @星期五',
  'x īn q ī w ù :1.30 #0.20 @星期五',
  'x īn q ì w ù :1.30 #0.20 @星期五',
  'x īng q ī w ú :1.30 #0.20 @星期五',
  'x īn q ī w ú :1.30 #0.20 @星期五',
  'x īng q í w ú :1.30 #0.20 @星期五',
  'x īn q í w ú :1.30 #0.20 @星期五',
  // 你好星期五
  'n ǐ h ǎo x īng q ī w ǔ :1.4 #0.18 @你好星期五',
  'n í h ǎo x īng q ī w ǔ :1.4 #0.18 @你好星期五',
  'n í h ǎo x īng q ì w ǔ :1.4 #0.18 @你好星期五',
  'n í h ǎo x īng q i w ǔ :1.4 #0.18 @你好星期五',
  'n ǐ h ǎo x īn q ī w ǔ :1.4 #0.18 @你好星期五',
  'n ǐ h ǎo x īn q ì w ǔ :1.4 #0.18 @你好星期五',
  'n í h ǎo x īn q ī w ǔ :1.4 #0.18 @你好星期五',
  'n ǐ h ǎo x īn q ì w ù :1.4 #0.18 @你好星期五',
  // 嘿星期五 / 诶星期五
  'h ēi x īng q ī w ǔ :1.5 #0.18 @嘿星期五',
  'h éi x īng q ī w ǔ :1.5 #0.18 @嘿星期五',
  'h èi x īng q ī w ǔ :1.5 #0.18 @嘿星期五',
  'h ěi x īng q ī w ǔ :1.5 #0.18 @嘿星期五',
  'h ēi x īng q ì w ǔ :1.5 #0.18 @嘿星期五',
  'h éi x īng q ì w ǔ :1.5 #0.18 @嘿星期五',
  'h èi x īng q ì w ǔ :1.5 #0.18 @嘿星期五',
  'h ēi x īng q i w ǔ :1.5 #0.18 @嘿星期五',
  'h éi x īng q i w ǔ :1.5 #0.18 @嘿星期五',
  'h ēi x íng q ī w ǔ :1.5 #0.18 @嘿星期五',
  'h ēi x īn q ī w ǔ :1.5 #0.18 @嘿星期五',
  'h ēi x īn q ì w ǔ :1.5 #0.18 @嘿星期五',
  'h ēi x ìn q ī w ǔ :1.5 #0.18 @嘿星期五',
  'h ēi x ìn q ì w ǔ :1.5 #0.18 @嘿星期五',
  'h éi x īn q ī w ǔ :1.5 #0.18 @嘿星期五',
  'h èi x īn q ī w ǔ :1.5 #0.18 @嘿星期五',
  'ēi x īng q ī w ǔ :1.5 #0.18 @嘿星期五',
  'éi x īng q ī w ǔ :1.5 #0.18 @嘿星期五',
  'èi x īng q ī w ǔ :1.5 #0.18 @嘿星期五',
  'ēi x īng q ì w ǔ :1.5 #0.18 @嘿星期五',
  'éi x īng q ì w ǔ :1.5 #0.18 @嘿星期五',
  'èi x īng q ì w ǔ :1.5 #0.18 @嘿星期五',
  'ēi x īn q ī w ǔ :1.5 #0.18 @嘿星期五',
  'éi x īn q ī w ǔ :1.5 #0.18 @嘿星期五',
  'èi x īn q ī w ǔ :1.5 #0.18 @嘿星期五',
  // 嗨星期五 / 唉星期五
  'h āi x īng q ī w ǔ :1.5 #0.18 @嗨星期五',
  'h ái x īng q ī w ǔ :1.5 #0.18 @嗨星期五',
  'h ài x īng q ī w ǔ :1.5 #0.18 @嗨星期五',
  'h āi x īng q ì w ǔ :1.5 #0.18 @嗨星期五',
  'h ái x īng q ì w ǔ :1.5 #0.18 @嗨星期五',
  'h ài x īng q ì w ǔ :1.5 #0.18 @嗨星期五',
  'h āi x īn q ī w ǔ :1.5 #0.18 @嗨星期五',
  'h ái x īn q ī w ǔ :1.5 #0.18 @嗨星期五',
  'h ài x īn q ī w ǔ :1.5 #0.18 @嗨星期五',
  'āi x īng q ī w ǔ :1.5 #0.18 @嗨星期五',
  'ài x īng q ī w ǔ :1.5 #0.18 @嗨星期五',
  'āi x īng q ì w ǔ :1.5 #0.18 @嗨星期五',
  'ài x īng q ì w ǔ :1.5 #0.18 @嗨星期五',
  // 喂星期五
  'w èi x īng q ī w ǔ :1.5 #0.18 @喂星期五',
  'w éi x īng q ī w ǔ :1.5 #0.18 @喂星期五',
  'w èi x īng q ì w ǔ :1.5 #0.18 @喂星期五',
  'w éi x īng q ì w ǔ :1.5 #0.18 @喂星期五',
  'w èi x īn q ī w ǔ :1.5 #0.18 @喂星期五',
  'w éi x īn q ī w ǔ :1.5 #0.18 @喂星期五',
  // 呼叫星期五
  'h ū j iào x īng q ī w ǔ :1.3 #0.20 @呼叫星期五',
  'h ū j iào x īng q ì w ǔ :1.3 #0.20 @呼叫星期五',
  'h ū j iāo x īng q ī w ǔ :1.3 #0.20 @呼叫星期五',
  'h ù j iāo x īn q ī w ǔ :1.3 #0.20 @呼叫星期五',
];

const SAMPLE_RATE = 16_000;
const DEFAULT_COOLDOWN_MS = 1_200;
const DEFAULT_PROBE_DURATION_MS = 160;
const DEFAULT_CHIME_DISCARD_MS = 320;
const DEFAULT_MAX_WAIT_SPEECH_MS = 4_500;
const DEFAULT_FOLLOWUP_WAIT_SPEECH_MS = 8_000;
export const DEFAULT_END_SILENCE_MS = 900;
export const DEFAULT_SHORT_UTTERANCE_END_SILENCE_MS = 1_350;
export const SHORT_UTTERANCE_SPEECH_MS = 1_800;
const DEFAULT_MAX_UTTERANCE_MS = 10_000;
const DEFAULT_PRE_ROLL_MS = 240;
const DEFAULT_SPEECH_RMS_THRESHOLD = 0.008;
const STREAM_KILL_ESCALATION_MS = 1_500;

let nextStreamSessionSeq = 0;

function msToSamples(ms: number): number {
  return Math.max(0, Math.round((ms / 1000) * SAMPLE_RATE));
}

export interface XiaoaiKwsStreamHandle {
  stdout: Readable;
  stderr?: Readable | null;
  sampleFormat?: 's16le' | 's32le';
  kill: () => void;
  onClose: (cb: (code: number | null) => void) => void;
}

export interface XiaoaiKwsSpotter {
  createStream: () => unknown;
  acceptWaveform: (stream: unknown, samples: Float32Array, sampleRate: number) => void;
  isReady: (stream: unknown) => boolean;
  decode: (stream: unknown) => void;
  getResult: (stream: unknown) => string;
  reset: (stream: unknown) => void;
  free?: () => void;
}

export interface XiaoaiAsrRecognizer {
  transcribe: (samples: Float32Array, sampleRate: number) => Promise<string>;
  free?: () => void;
}

export interface XiaoaiSpeechDetector {
  isSpeech: (samples: Float32Array, sampleRate: number) => boolean;
  observeAmbient?: (samples: Float32Array, precomputedRms?: number) => void;
  markWake?: (wakeRms: number) => void;
  reset: () => void;
  free?: () => void;
}

export interface XiaoaiKwsSpeakerGate {
  isActive: (channel: ImChannelConfig, target: XiaoaiSshTarget) => boolean;
  isBypassed?: (channelId: string, targetId: string) => boolean;
  verifyWake?: (params: {
    channel: ImChannelConfig;
    target: XiaoaiSshTarget;
    keyword: string;
    samples: Float32Array;
    sampleRate: number;
  }) => { matched: boolean; speaker?: XiaoaiMatchedSpeaker; score: number; threshold: number };
  verifyUtterance: (params: {
    channel: ImChannelConfig;
    target: XiaoaiSshTarget;
    keyword: string;
    samples: Float32Array;
    sampleRate: number;
  }) => {
    matched: boolean;
    speaker?: XiaoaiMatchedSpeaker;
    score: number;
    threshold: number;
    samples?: Float32Array;
    trimmed?: boolean;
  };
  verifyUtteranceAsync?: (params: {
    channel: ImChannelConfig;
    target: XiaoaiSshTarget;
    keyword: string;
    samples: Float32Array;
    sampleRate: number;
  }) => Promise<{
    matched: boolean;
    speaker?: XiaoaiMatchedSpeaker;
    score: number;
    threshold: number;
    samples?: Float32Array;
    trimmed?: boolean;
  }>;
}

export interface XiaoaiKwsWakeEvent {
  channel: ImChannelConfig;
  target: XiaoaiSshTarget;
  keyword: string;
  chime?: boolean;
}

export interface XiaoaiKwsUtteranceEvent {
  channel: ImChannelConfig;
  target: XiaoaiSshTarget;
  keyword: string;
  text: string;
  explicitWake?: boolean;
  speaker?: XiaoaiMatchedSpeaker;
  samples?: Float32Array;
  sampleRate?: number;
}

export type XiaoaiKwsWorkerMode = 'kws' | 'probing' | 'chime_wait' | 'capturing';

export interface XiaoaiKwsWorkerStatus {
  channelId: string;
  targetId: string;
  mode: XiaoaiKwsWorkerMode;
  capturing: boolean;
  transcribing: boolean;
  activeKeyword: string;
  isFollowUpCapture: boolean;
}

export interface XiaoaiKwsMonitorOptions {
  homeDir: string;
  modelsDir?: string;
  keywordsFile?: string;
  asrModelsDir?: string;
  vadModelPath?: string;
  cooldownMs?: number;
  probeDurationMs?: number;
  chimeDiscardMs?: number;
  maxWaitSpeechMs?: number;
  endSilenceMs?: number;
  maxUtteranceMs?: number;
  speechRmsThreshold?: number;
  asrWakeRescue?: boolean;
  idleEnergyGate?: boolean;
  sshRunner?: XiaoaiSshRunner;
  speakerGate?: XiaoaiKwsSpeakerGate;
  onWake?: (event: XiaoaiKwsWakeEvent) => Promise<{ woken: boolean; suppressed: boolean }>;
  onTranscribing?: (event: { channel: ImChannelConfig; target: XiaoaiSshTarget; keyword: string }) => Promise<void> | void;
  onCaptureCancel?: (event: {
    channel: ImChannelConfig;
    target: XiaoaiSshTarget;
    keyword: string;
    reason: 'timeout' | 'empty' | 'cancel' | 'error' | 'speaker_rejected';
    text?: string;
    explicitWake?: boolean;
  }) => Promise<void> | void;
  shouldBypassFollowUpCancel?: (channelId: string, targetId: string, text: string) => boolean;
  onUtterance?: (event: XiaoaiKwsUtteranceEvent) => Promise<void> | void;
  onError?: (channelId: string, error: unknown) => void;
  streamSpawn?: typeof spawn;
  streamFactory?: (target: XiaoaiSshTarget, device: string) => XiaoaiKwsStreamHandle;
  spotterFactory?: (config: { modelsDir: string; keywordsFile: string }) => XiaoaiKwsSpotter;
  recognizerFactory?: (config: { asrModelsDir: string }) => Promise<XiaoaiAsrRecognizer> | XiaoaiAsrRecognizer;
  vadFactory?: (config: { vadModelPath: string; speechRmsThreshold: number }) => XiaoaiSpeechDetector;
}

interface SherpaOnlineStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
}

interface SherpaKeywordSpotterCtor {
  new (config: {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
      transducer: { encoder: string; decoder: string; joiner: string };
      tokens: string;
      numThreads: number;
      provider: string;
      debug: number;
    };
    maxActivePaths: number;
    numTrailingBlanks: number;
    keywordsScore: number;
    keywordsThreshold: number;
    keywordsFile: string;
  }): {
    createStream(): SherpaOnlineStream;
    isReady(stream: SherpaOnlineStream): boolean;
    decode(stream: SherpaOnlineStream): void;
    getResult(stream: SherpaOnlineStream): { keyword?: string } | undefined;
    reset(stream: SherpaOnlineStream): void;
  };
}

interface SherpaOfflineStream {
  acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
}

interface SherpaOfflineRecognizer {
  createStream(): SherpaOfflineStream;
  decodeAsync(stream: SherpaOfflineStream): Promise<{ text?: string } | undefined>;
}

interface SherpaOfflineRecognizerCtor {
  createAsync(config: {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
      senseVoice?: { model: string; language: string; useInverseTextNormalization: number };
      paraformer?: { model: string };
      tokens: string;
      numThreads: number;
      provider: string;
      debug: number;
    };
  }): Promise<SherpaOfflineRecognizer>;
}

interface SherpaVadCtor {
  new (
    config: {
      sileroVad: {
        model: string;
        threshold: number;
        minSilenceDuration: number;
        minSpeechDuration: number;
        windowSize: number;
        maxSpeechDuration: number;
      };
      sampleRate: number;
      numThreads: number;
      provider: string;
      debug: number;
    },
    bufferSizeInSeconds: number,
  ): {
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    pop(): void;
    reset(): void;
  };
}

interface DcBlockerState {
  prevX: number;
  prevY: number;
}

interface ActiveWorker {
  key: string;
  channel: ImChannelConfig;
  target: XiaoaiSshTarget;
  device: string;
  stopped: boolean;
  mode: XiaoaiKwsWorkerMode;
  captureEpoch: number;
  stream?: XiaoaiKwsStreamHandle;
  kwsStream?: unknown;
  vad?: XiaoaiSpeechDetector;
  leftoverByte: number | null;
  leftoverBytes: Buffer;
  dcState: DcBlockerState;
  ambientRms: number;
  recentKwsRms: number[];
  kwsRingChunks: Float32Array[];
  kwsRingSamples: number;
  kwsPrevSample: number;
  kwsGateActive: boolean;
  kwsGateHoldSamples: number;
  kwsIdlePreRoll: Float32Array[];
  kwsIdlePreRollSamples: number;
  kwsBurstPreRoll: Float32Array[];
  kwsBurstPreRollSamples: number;
  kwsBurstChunks: Float32Array[];
  kwsBurstSamples: number;
  kwsBurstSpeechSamples: number;
  kwsBurstSilenceSamples: number;
  kwsBurstMaxRms: number;
  kwsRescueId: number;
  kwsRescueInFlight: boolean;
  kwsPostRescueChunks: Float32Array[];
  kwsPostRescueSpeech: boolean;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempt: number;
  lastWakeAt: number;
  activeKeyword: string;
  isFollowUpCapture: boolean;
  captureDeadlineAt: number;
  sawOwnerInLiveCapture: boolean;
  liveNonOwnerStreak: number;
  lastLiveCheckSamples: number;
  probeChunks: Float32Array[];
  probeSamples: number;
  probeSkipSamplesRemaining: number;
  probeSawSpeech: boolean;
  chimeDiscardSamples: number;
  preRollChunks: Float32Array[];
  preRollSamples: number;
  audioChunks: Float32Array[];
  speechStarted: boolean;
  waitSamples: number;
  currentMaxWaitMs: number;
  currentEndSilenceMs: number;
  currentMaxUtteranceMs: number;
  silenceSamples: number;
  utteranceSamples: number;
  transcribingCount: number;
  captureMaxRms: number;
  lastSpeechRms: number;
}

interface CaptureMeta {
  isFollowUp: boolean;
  deadlineAt: number;
  endSilenceMs: number;
  maxUtteranceMs: number;
}

export function decodePcm16leToFloat32(
  chunk: Buffer,
  leftoverByte: number | null,
): { samples: Float32Array; leftoverByte: number | null } {
  const buf = leftoverByte !== null
    ? Buffer.concat([Buffer.from([leftoverByte & 0xff]), chunk])
    : chunk;
  const usablePairs = Math.floor(buf.length / 2);
  const lastByte = buf.length % 2 === 1 ? buf[buf.length - 1] : undefined;
  const nextLeftover = lastByte !== undefined ? lastByte : null;
  if (usablePairs === 0) {
    return { samples: new Float32Array(0), leftoverByte: nextLeftover };
  }
  const samples = new Float32Array(usablePairs);
  for (let i = 0; i < usablePairs; i++) {
    samples[i] = buf.readInt16LE(i * 2) / 32768;
  }
  return { samples, leftoverByte: nextLeftover };
}

export function decodePcm32leToFloat32(
  chunk: Buffer,
  leftover: Buffer,
  dcState?: DcBlockerState,
): { samples: Float32Array; leftover: Buffer } {
  const buf = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
  const usableFrames = Math.floor(buf.length / 4);
  const remainder = buf.length % 4;
  const nextLeftover = remainder > 0
    ? Buffer.from(buf.subarray(usableFrames * 4))
    : Buffer.alloc(0);
  if (usableFrames === 0) {
    return { samples: new Float32Array(0), leftover: nextLeftover };
  }
  const samples = new Float32Array(usableFrames);
  for (let i = 0; i < usableFrames; i++) {
    const x = buf.readInt32LE(i * 4) / 2147483648;
    if (dcState) {
      const y = x - dcState.prevX + 0.995 * dcState.prevY;
      dcState.prevX = x;
      dcState.prevY = y;
      samples[i] = y;
    } else {
      samples[i] = x;
    }
  }
  return { samples, leftover: nextLeftover };
}

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sumSq += v * v;
  }
  return Math.sqrt(sumSq / samples.length);
}

/**
 * Software AGC for local ASR: boosts ultra-quiet speaker captures
 * into `[-0.45, 0.45]` before feature extraction while ignoring isolated click spikes.
 */
export function normalizeUtteranceSamples(samples: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i] ?? 0);
    if (abs > peak) peak = abs;
  }
  if (peak <= 1e-5) {
    return samples;
  }

  let refPeak = peak;
  if (samples.length >= 512) {
    const windowSize = 256;
    const windowPeaks: number[] = [];
    for (let start = 0; start < samples.length; start += windowSize) {
      const end = Math.min(samples.length, start + windowSize);
      let wPeak = 0;
      for (let i = start; i < end; i++) {
        const abs = Math.abs(samples[i] ?? 0);
        if (abs > wPeak) wPeak = abs;
      }
      if (wPeak > 0) windowPeaks.push(wPeak);
    }
    if (windowPeaks.length > 0) {
      windowPeaks.sort((a, b) => a - b);
      const p95Idx = windowPeaks.length >= 4
        ? Math.min(windowPeaks.length - 2, Math.floor(windowPeaks.length * 0.95))
        : windowPeaks.length - 1;
      const p95 = windowPeaks[p95Idx];
      if (p95 !== undefined && p95 > 1e-5) {
        refPeak = p95;
      }
    }
  }

  if (refPeak >= 0.25) {
    return samples;
  }

  const gain = Math.min(180, 0.45 / refPeak);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] ?? 0) * gain;
    const abs = Math.abs(v);
    if (abs <= 0.6) {
      out[i] = v;
    } else {
      const sign = v < 0 ? -1 : 1;
      out[i] = sign * (0.6 + 0.38 * Math.tanh((abs - 0.6) / 0.38));
    }
  }
  return out;
}

function pushBoundedSamples(
  chunks: Float32Array[],
  currentSamples: number,
  chunk: Float32Array,
  limitSamples: number,
): number {
  chunks.push(chunk);
  let total = currentSamples + chunk.length;
  while (total > limitSamples && chunks.length > 1) {
    const removed = chunks.shift();
    if (removed) total -= removed.length;
  }
  return total;
}

function concatFloat32Arrays(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function concatTrailingSamples(chunks: Float32Array[], maxSamples: number): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  if (total <= maxSamples) return concatFloat32Arrays(chunks);
  const out = new Float32Array(maxSamples);
  let remaining = maxSamples;
  for (let i = chunks.length - 1; i >= 0 && remaining > 0; i--) {
    const chunk = chunks[i];
    if (!chunk) continue;
    if (chunk.length <= remaining) {
      remaining -= chunk.length;
      out.set(chunk, remaining);
    } else {
      out.set(chunk.subarray(chunk.length - remaining), 0);
      remaining = 0;
    }
  }
  return out;
}

function buildStreamSshBaseArgs(target: XiaoaiSshTarget): string[] {
  return [
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=5',
    '-o', 'LogLevel=ERROR',
    '-o', 'HostKeyAlgorithms=+ssh-rsa',
    '-o', 'PubkeyAcceptedKeyTypes=+ssh-rsa',
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    ...(target.port ? ['-p', String(target.port)] : []),
    target.userHost,
  ];
}

function defaultStreamFactory(
  target: XiaoaiSshTarget,
  device: string,
  spawnImpl: typeof spawn = spawn,
): XiaoaiKwsStreamHandle {
  const safeDevice = /^[a-zA-Z0-9_.:,-]+$/.test(device) ? device : 'noop';
  const safeKey = `${target.id}_${safeDevice}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const pidFile = `/tmp/friday_arecord_${safeKey}.pid`;
  const sessionTag = `${process.pid}_${Date.now()}_${++nextStreamSessionSeq}`;
  const qPidFile = `'${escapeShellSingleQuote(pidFile)}'`;
  const qTag = `'${escapeShellSingleQuote(sessionTag)}'`;
  // Track per-session remote `arecord` PID so cleanup never kills unrelated `arecord` processes.
  const killPrevSession = [
    `PIDFILE=${qPidFile};`,
    `if [ -f "$PIDFILE" ] && [ ! -L "$PIDFILE" ]; then`,
    `set -- $(cat "$PIDFILE" 2>/dev/null || true);`,
    `case "$1" in ''|*[!0-9]*) ;; *) [ "$1" != "$$" ] && kill "$1" 2>/dev/null || true ;; esac;`,
    `fi`,
  ].join(' ');
  const recordPid = `if [ ! -L "$PIDFILE" ]; then printf '%s %s\\n' "$$" ${qTag} > "$PIDFILE"; fi`;
  const singleMicCmd = `if [ "${safeDevice}" = "noop" ] && [ -r /usr/share/alsa/alsa.conf ] && grep -q 'pcm.Capture' /etc/asound.conf 2>/dev/null; then printf '%s\\n' '</usr/share/alsa/alsa.conf>' 'pcm.friday_mic {' '  type plug' '  slave {' '    pcm "Capture"' '    channels 8' '  }' '  ttable.0.0 0.34' '  ttable.0.2 0.33' '  ttable.0.4 0.33' '}' >/tmp/friday_asound.conf && ALSA_CONFIG_PATH=/tmp/friday_asound.conf exec arecord -D friday_mic -f S32_LE -r ${SAMPLE_RATE} -c 1 -t raw -q; fi`;
  const fallbackCmd = `exec arecord -D ${safeDevice} -f S32_LE -r ${SAMPLE_RATE} -c 1 -t raw -q`;
  const remoteCmd = [killPrevSession, recordPid, singleMicCmd, fallbackCmd].join('; ');

  const args = [...buildStreamSshBaseArgs(target), remoteCmd];
  const child = spawnImpl('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;
  let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;
  let remoteCleanupStarted = false;

  const markExited = () => {
    exited = true;
    if (killEscalationTimer) {
      clearTimeout(killEscalationTimer);
      killEscalationTimer = undefined;
    }
  };
  child.once('exit', markExited);
  child.once('close', markExited);

  return {
    stdout: child.stdout,
    stderr: child.stderr,
    sampleFormat: 's32le',
    kill: () => {
      if (!exited) {
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore already-exited process
        }
        if (!killEscalationTimer) {
          killEscalationTimer = setTimeout(() => {
            killEscalationTimer = undefined;
            if (!exited) {
              try {
                child.kill('SIGKILL');
              } catch {
                // Ignore
              }
            }
          }, STREAM_KILL_ESCALATION_MS);
          killEscalationTimer.unref();
        }
      }
      if (!remoteCleanupStarted && child.pid) {
        remoteCleanupStarted = true;
        const cleanupCmd = [
          `PIDFILE=${qPidFile};`,
          `if [ -f "$PIDFILE" ] && [ ! -L "$PIDFILE" ]; then`,
          `set -- $(cat "$PIDFILE" 2>/dev/null || true);`,
          `if [ "$2" = ${qTag} ]; then rm -f "$PIDFILE"; case "$1" in ''|*[!0-9]*) ;; *) kill "$1" 2>/dev/null || true ;; esac; fi;`,
          `fi`,
        ].join(' ');
        try {
          const cleanup = spawnImpl('ssh', [...buildStreamSshBaseArgs(target), cleanupCmd], { stdio: 'ignore' });
          cleanup.on('error', () => {});
          cleanup.unref();
        } catch {
          // Best-effort remote cleanup
        }
      }
    },
    onClose: (cb) => {
      child.once('close', (code) => cb(code));
      child.once('error', () => cb(1));
    },
  };
}

function defaultSpotterFactory(config: { modelsDir: string; keywordsFile: string }): XiaoaiKwsSpotter {
  const req = createRequire(import.meta.url);
  const sherpa = req('sherpa-onnx-node') as { KeywordSpotter: SherpaKeywordSpotterCtor };
  const spotter = new sherpa.KeywordSpotter({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(config.modelsDir, 'encoder.onnx'),
        decoder: join(config.modelsDir, 'decoder.onnx'),
        joiner: join(config.modelsDir, 'joiner.onnx'),
      },
      tokens: join(config.modelsDir, 'tokens.txt'),
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    maxActivePaths: 8,
    numTrailingBlanks: 0,
    keywordsScore: 1.35,
    keywordsThreshold: 0.19,
    keywordsFile: config.keywordsFile,
  });
  return {
    createStream: () => spotter.createStream(),
    acceptWaveform: (stream, samples, sampleRate) => {
      (stream as SherpaOnlineStream).acceptWaveform({ samples, sampleRate });
    },
    isReady: (stream) => spotter.isReady(stream as SherpaOnlineStream),
    decode: (stream) => spotter.decode(stream as SherpaOnlineStream),
    getResult: (stream) => spotter.getResult(stream as SherpaOnlineStream)?.keyword ?? '',
    reset: (stream) => spotter.reset(stream as SherpaOnlineStream),
  };
}

function resolveAsrModelFile(asrModelsDir: string): string | undefined {
  const int8 = join(asrModelsDir, 'model.int8.onnx');
  if (existsSync(int8)) return int8;
  const fp32 = join(asrModelsDir, 'model.onnx');
  if (existsSync(fp32)) return fp32;
  return undefined;
}

async function defaultRecognizerFactory(config: { asrModelsDir: string }): Promise<XiaoaiAsrRecognizer> {
  const req = createRequire(import.meta.url);
  const sherpa = req('sherpa-onnx-node') as { OfflineRecognizer: SherpaOfflineRecognizerCtor };
  const modelPath = resolveAsrModelFile(config.asrModelsDir);
  const tokensPath = join(config.asrModelsDir, 'tokens.txt');
  if (!modelPath || !existsSync(tokensPath)) {
    throw new Error(`本地 ASR 模型缺失 (${config.asrModelsDir})`);
  }
  const useParaformer = existsSync(join(config.asrModelsDir, 'paraformer.flag'));
  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      ...(useParaformer
        ? { paraformer: { model: modelPath } }
        : {
            senseVoice: {
              model: modelPath,
              language: 'zh',
              useInverseTextNormalization: 1,
            },
          }),
      tokens: tokensPath,
      numThreads: Math.min(4, Math.max(1, Math.floor(cpus().length / 2))),
      provider: 'cpu',
      debug: 0,
    },
  });
  return {
    transcribe: async (samples, sampleRate) => {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: normalizeUtteranceSamples(samples), sampleRate });
      const res = await recognizer.decodeAsync(stream);
      return res?.text ?? '';
    },
  };
}

export function computeKwsGain(samples: Float32Array, ambientRms: number): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i] ?? 0);
    if (abs > peak) peak = abs;
  }
  const ambientGain = Math.min(80, Math.max(1, 0.045 / Math.max(ambientRms || 0.0006, 0.00018)));
  const peakCap = peak > 0.001 ? 0.55 / peak : 80;
  return Math.max(1, Math.min(ambientGain, peakCap));
}

export function updateAmbientNoiseRms(currentNoiseRms: number, chunkRms: number): number {
  if (chunkRms <= 0) return currentNoiseRms > 0 ? currentNoiseRms : 0.0004;
  const clampedInit = Math.min(0.02, Math.max(0.00008, chunkRms));
  if (currentNoiseRms <= 0) return clampedInit;
  let next: number;
  if (chunkRms <= currentNoiseRms) {
    next = currentNoiseRms * 0.90 + chunkRms * 0.10;
  } else if (chunkRms <= currentNoiseRms * 3.0) {
    next = currentNoiseRms * 0.96 + chunkRms * 0.04;
  } else {
    next = currentNoiseRms * 0.995 + Math.min(chunkRms, currentNoiseRms * 5.0) * 0.005;
  }
  return Math.min(0.025, Math.max(0.00008, next));
}

export function computeForegroundSpeechGate(noiseRms: number, wakeRefRms: number): number {
  const safeNoise = Math.max(0.00008, noiseRms);
  const wakeFloor = wakeRefRms > 0 ? Math.min(safeNoise * 6.0, wakeRefRms * 0.20) : 0;
  return Math.max(safeNoise * 1.65, wakeFloor);
}

export function computeKwsIdleGateRms(
  ambientRms: number,
  sampleFormat?: 's16le' | 's32le',
  speechRmsThreshold = DEFAULT_SPEECH_RMS_THRESHOLD,
): number {
  if (sampleFormat === 's32le') {
    const safeAmbient = Math.max(0.00025, ambientRms || 0.00035);
    return Math.max(0.00075, Math.min(0.0020, safeAmbient * 1.45));
  }
  const safeAmbient = Math.max(0.0004, ambientRms || 0.0008);
  return Math.max(
    Math.min(speechRmsThreshold * 0.45, 0.004),
    Math.min(speechRmsThreshold * 0.85, safeAmbient * 1.50),
  );
}

function defaultVadFactory(config: { vadModelPath: string; speechRmsThreshold: number }): XiaoaiSpeechDetector {
  if (!existsSync(config.vadModelPath)) {
    return {
      isSpeech: (samples) => computeRms(samples) >= config.speechRmsThreshold,
      reset: () => {},
    };
  }
  const req = createRequire(import.meta.url);
  const sherpa = req('sherpa-onnx-node') as { Vad: SherpaVadCtor };
  const vad = new sherpa.Vad(
    {
      sileroVad: {
        model: config.vadModelPath,
        threshold: 0.38,
        minSilenceDuration: 0.25,
        minSpeechDuration: 0.06,
        windowSize: 512,
        maxSpeechDuration: 12,
      },
      sampleRate: SAMPLE_RATE,
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
    30,
  );
  let noiseRms = 0;
  let wakeRefRms = 0;
  const trailingSilenceFlushSamples = msToSamples(320);
  let trailingZeroFlushedSamples = trailingSilenceFlushSamples;
  return {
    observeAmbient: (samples, precomputedRms) => {
      noiseRms = updateAmbientNoiseRms(noiseRms, precomputedRms ?? computeRms(samples));
    },
    markWake: (wakeRms) => {
      wakeRefRms = Math.max(0, wakeRms);
    },
    isSpeech: (samples) => {
      const rawRms = computeRms(samples);
      if (noiseRms <= 0) noiseRms = updateAmbientNoiseRms(0, rawRms);
      const vadActive = vad.isDetected();
      // Enforce a minimum RMS floor so thermal room hiss (~0.0003) never latches Silero VAD
      const minSpeechRms = Math.max(0.0011, computeForegroundSpeechGate(noiseRms, wakeRefRms));
      const lowGateFactor = vadActive ? 0.52 : 0.75;
      if (rawRms < minSpeechRms * lowGateFactor) {
        if (vadActive || trailingZeroFlushedSamples < trailingSilenceFlushSamples) {
          vad.acceptWaveform(new Float32Array(samples.length));
          while (!vad.isEmpty()) {
            vad.pop();
          }
          trailingZeroFlushedSamples += samples.length;
          if (!vad.isDetected() && trailingZeroFlushedSamples >= trailingSilenceFlushSamples) {
            vad.reset();
          }
        }
        if (rawRms > 0 && rawRms <= noiseRms * 2.0) {
          noiseRms = updateAmbientNoiseRms(noiseRms, rawRms);
        }
        return false;
      }

      trailingZeroFlushedSamples = 0;
      const gain = Math.min(28, Math.max(1, 0.012 / Math.max(noiseRms, 0.00030)));
      let vadInput = samples;
      if (gain > 1.05) {
        const boosted = new Float32Array(samples.length);
        for (let i = 0; i < samples.length; i++) {
          boosted[i] = Math.tanh((samples[i] ?? 0) * gain);
        }
        vadInput = boosted;
      }
      vad.acceptWaveform(vadInput);
      let sawSegment = !vad.isEmpty();
      while (!vad.isEmpty()) {
        vad.pop();
        sawSegment = true;
      }
      const detected = vad.isDetected()
        || sawSegment
        || (samples.length < 512 && computeRms(vadInput) >= 0.045);
      return detected && rawRms >= (vadActive ? minSpeechRms * 0.75 : minSpeechRms);
    },
    reset: () => {
      vad.reset();
      trailingZeroFlushedSamples = trailingSilenceFlushSamples;
    },
  };
}

export class XiaoaiKwsMonitor {
  private readonly kwsDir: string;
  private readonly modelsDir: string;
  private readonly keywordsFile: string;
  private readonly asrModelsDir: string;
  private readonly vadModelPath: string;
  private readonly cooldownMs: number;
  private readonly probeDurationMs: number;
  private readonly chimeDiscardMs: number;
  private readonly maxWaitSpeechMs: number;
  private readonly endSilenceMs: number;
  private readonly maxUtteranceMs: number;
  private readonly speechRmsThreshold: number;
  private readonly asrWakeRescue: boolean;
  private readonly idleEnergyGate: boolean;
  private readonly options: XiaoaiKwsMonitorOptions;
  private readonly workers = new Map<string, ActiveWorker>();
  private spotter?: XiaoaiKwsSpotter;
  private recognizer?: XiaoaiAsrRecognizer;
  private recognizerPromise?: Promise<XiaoaiAsrRecognizer | undefined>;
  private closed = false;
  private warnedMissingModels = false;
  private warnedMissingAsr = false;

  constructor(options: XiaoaiKwsMonitorOptions) {
    this.options = options;
    setDefaultXiaoaiSshHome(options.homeDir);
    this.kwsDir = join(options.homeDir, 'xiaoai-kws');
    this.modelsDir = options.modelsDir ?? join(this.kwsDir, 'models');
    this.keywordsFile = options.keywordsFile ?? join(this.kwsDir, 'keywords.txt');
    this.asrModelsDir = options.asrModelsDir ?? join(this.kwsDir, 'asr');
    this.vadModelPath = options.vadModelPath ?? join(this.kwsDir, 'silero_vad.onnx');
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.probeDurationMs = options.probeDurationMs ?? DEFAULT_PROBE_DURATION_MS;
    this.chimeDiscardMs = options.chimeDiscardMs ?? DEFAULT_CHIME_DISCARD_MS;
    this.maxWaitSpeechMs = options.maxWaitSpeechMs ?? DEFAULT_MAX_WAIT_SPEECH_MS;
    this.endSilenceMs = options.endSilenceMs ?? DEFAULT_END_SILENCE_MS;
    this.maxUtteranceMs = options.maxUtteranceMs ?? DEFAULT_MAX_UTTERANCE_MS;
    this.speechRmsThreshold = options.speechRmsThreshold ?? DEFAULT_SPEECH_RMS_THRESHOLD;
    this.asrWakeRescue = options.asrWakeRescue ?? !options.spotterFactory;
    this.idleEnergyGate = options.idleEnergyGate ?? !options.spotterFactory;
  }

  getStatus(channelId?: string, targetId?: string): {
    active: boolean;
    capturing: boolean;
    workers: XiaoaiKwsWorkerStatus[];
  } {
    const workers: XiaoaiKwsWorkerStatus[] = [];
    for (const worker of this.workers.values()) {
      if (channelId && worker.channel.id !== channelId) continue;
      if (targetId && worker.target.id !== targetId) continue;
      const capturing = !worker.stopped && (worker.mode !== 'kws' || worker.transcribingCount > 0);
      workers.push({
        channelId: worker.channel.id,
        targetId: worker.target.id,
        mode: worker.mode,
        capturing,
        transcribing: worker.transcribingCount > 0,
        activeKeyword: worker.activeKeyword,
        isFollowUpCapture: worker.isFollowUpCapture,
      });
    }
    return {
      active: workers.length > 0,
      capturing: workers.some((w) => w.capturing),
      workers,
    };
  }

  isCapturing(channelId: string, targetId?: string): boolean {
    for (const worker of this.workers.values()) {
      if (worker.channel.id !== channelId) continue;
      if (targetId && worker.target.id !== targetId) continue;
      if (worker.mode !== 'kws' || worker.transcribingCount > 0) return true;
    }
    return false;
  }

  private isReadyOnDisk(): boolean {
    const required = [
      join(this.modelsDir, 'encoder.onnx'),
      join(this.modelsDir, 'decoder.onnx'),
      join(this.modelsDir, 'joiner.onnx'),
      join(this.modelsDir, 'tokens.txt'),
    ];
    if (!this.options.spotterFactory && !required.every((file) => existsSync(file))) {
      return false;
    }
    const expectedKeywords = `${DEFAULT_XIAOAI_KEYWORDS.join('\n')}\n`;
    if (!this.options.keywordsFile) {
      const versionFile = join(this.kwsDir, 'keywords.version');
      const currentVersion = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '';
      if (!existsSync(this.keywordsFile) || currentVersion !== XIAOAI_KEYWORDS_VERSION) {
        mkdirSync(this.kwsDir, { recursive: true });
        writeFileSync(this.keywordsFile, expectedKeywords, 'utf8');
        writeFileSync(versionFile, `${XIAOAI_KEYWORDS_VERSION}\n`, 'utf8');
      }
    } else if (!existsSync(this.keywordsFile)) {
      mkdirSync(this.kwsDir, { recursive: true });
      writeFileSync(this.keywordsFile, expectedKeywords, 'utf8');
    }
    return true;
  }

  private isAsrReadyOnDisk(): boolean {
    if (this.options.recognizerFactory) return true;
    return Boolean(resolveAsrModelFile(this.asrModelsDir)) && existsSync(join(this.asrModelsDir, 'tokens.txt'));
  }

  private ensureSpotter(): XiaoaiKwsSpotter | undefined {
    if (this.spotter) return this.spotter;
    if (!this.isReadyOnDisk()) {
      if (!this.warnedMissingModels) {
        this.warnedMissingModels = true;
        this.options.onError?.(
          'xiaoai-kws',
          new Error(`KWS 模型未就绪 (${this.modelsDir})，跳过常驻唤醒监听`),
        );
      }
      return undefined;
    }
    const factory = this.options.spotterFactory ?? defaultSpotterFactory;
    this.spotter = factory({ modelsDir: this.modelsDir, keywordsFile: this.keywordsFile });
    return this.spotter;
  }

  private ensureRecognizer(): Promise<XiaoaiAsrRecognizer | undefined> {
    if (this.recognizer) return Promise.resolve(this.recognizer);
    if (this.recognizerPromise) return this.recognizerPromise;
    if (!this.isAsrReadyOnDisk()) {
      if (!this.warnedMissingAsr) {
        this.warnedMissingAsr = true;
        this.options.onError?.(
          'xiaoai-kws',
          new Error(`本地 ASR 模型未就绪 (${this.asrModelsDir})，无法进行直连语音识别`),
        );
      }
      return Promise.resolve(undefined);
    }
    const factory = this.options.recognizerFactory ?? defaultRecognizerFactory;
    this.recognizerPromise = Promise.resolve(factory({ asrModelsDir: this.asrModelsDir }))
      .then((rec) => {
        if (this.closed) {
          rec.free?.();
          return undefined;
        }
        this.recognizer = rec;
        return rec;
      })
      .catch((error) => {
        this.recognizerPromise = undefined;
        this.options.onError?.('xiaoai-kws', error);
        return undefined;
      });
    return this.recognizerPromise;
  }

  private createWorkerVad(): XiaoaiSpeechDetector {
    const factory = this.options.vadFactory ?? defaultVadFactory;
    return factory({
      vadModelPath: this.vadModelPath,
      speechRmsThreshold: this.speechRmsThreshold,
    });
  }

  sync(channels: ImChannelConfig[]): void {
    if (this.closed) return;

    const desired = new Map<string, { channel: ImChannelConfig; target: XiaoaiSshTarget; device: string }>();
    for (const channel of channels) {
      if (!channel.enabled || channel.platform !== 'xiaoai') continue;
      const targets = parseXiaoaiSshTargets(channel.apiBase);
      if (targets.length === 0) continue;
      const apiOptions = parseXiaoaiApiOptions(channel.apiBase);
      if (!apiOptions.kws) continue;

      for (const target of targets) {
        desired.set(`${channel.id}:${target.id}`, {
          channel,
          target,
          device: apiOptions.kwsDevice,
        });
      }
    }

    for (const [key, worker] of this.workers.entries()) {
      const next = desired.get(key);
      if (
        !next
        || next.target.userHost !== worker.target.userHost
        || next.target.port !== worker.target.port
        || next.device !== worker.device
      ) {
        this.stopWorker(worker);
        this.workers.delete(key);
      } else {
        worker.channel = next.channel;
      }
    }

    if (desired.size === 0) return;

    const spotter = this.ensureSpotter();
    if (!spotter) return;
    void this.ensureRecognizer();

    for (const [key, spec] of desired.entries()) {
      if (this.workers.has(key)) continue;
      const worker: ActiveWorker = {
        key,
        channel: spec.channel,
        target: spec.target,
        device: spec.device,
        stopped: false,
        mode: 'kws',
        captureEpoch: 0,
        leftoverByte: null,
        leftoverBytes: Buffer.alloc(0),
        dcState: { prevX: 0, prevY: 0 },
        ambientRms: 0,
        recentKwsRms: [],
        kwsRingChunks: [],
        kwsRingSamples: 0,
        kwsPrevSample: 0,
        kwsGateActive: false,
        kwsGateHoldSamples: 0,
        kwsIdlePreRoll: [],
        kwsIdlePreRollSamples: 0,
        kwsBurstPreRoll: [],
        kwsBurstPreRollSamples: 0,
        kwsBurstChunks: [],
        kwsBurstSamples: 0,
        kwsBurstSpeechSamples: 0,
        kwsBurstSilenceSamples: 0,
        kwsBurstMaxRms: 0,
        kwsRescueId: 0,
        kwsRescueInFlight: false,
        kwsPostRescueChunks: [],
        kwsPostRescueSpeech: false,
        reconnectAttempt: 0,
        lastWakeAt: 0,
        activeKeyword: '',
        isFollowUpCapture: false,
        captureDeadlineAt: 0,
        sawOwnerInLiveCapture: false,
        liveNonOwnerStreak: 0,
        lastLiveCheckSamples: 0,
        probeChunks: [],
        probeSamples: 0,
        probeSkipSamplesRemaining: 0,
        probeSawSpeech: false,
        chimeDiscardSamples: 0,
        preRollChunks: [],
        preRollSamples: 0,
        audioChunks: [],
        speechStarted: false,
        waitSamples: 0,
        currentMaxWaitMs: this.maxWaitSpeechMs,
        currentEndSilenceMs: this.endSilenceMs,
        currentMaxUtteranceMs: this.maxUtteranceMs,
        silenceSamples: 0,
        utteranceSamples: 0,
        transcribingCount: 0,
        captureMaxRms: 0,
        lastSpeechRms: 0,
      };
      this.workers.set(key, worker);
      this.startWorkerStream(worker, spotter);
    }
  }

  hasActiveWorker(channelId: string, targetId?: string): boolean {
    if (this.closed) return false;
    for (const worker of this.workers.values()) {
      if (worker.channel.id === channelId && !worker.stopped && (!targetId || worker.target.id === targetId)) {
        return true;
      }
    }
    return false;
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
    if (this.closed) return false;
    const worker = this.workers.get(`${channelId}:${targetId}`);
    if (!worker || worker.stopped || !worker.stream || !worker.kwsStream) return false;
    if (worker.mode !== 'kws' || (worker.transcribingCount > 0 && !options?.allowDuringTranscribe)) return false;

    worker.captureEpoch++;
    this.resetKwsBurst(worker, true);
    this.resetKwsIdleGate(worker);
    worker.mode = 'capturing';
    worker.activeKeyword = '连续对话';
    worker.isFollowUpCapture = true;
    worker.probeChunks = [];
    worker.probeSamples = 0;
    worker.probeSkipSamplesRemaining = 0;
    worker.probeSawSpeech = false;
    worker.preRollChunks = [];
    worker.preRollSamples = 0;
    worker.audioChunks = [];
    worker.speechStarted = false;
    worker.waitSamples = 0;
    worker.currentMaxWaitMs = Math.max(200, options?.waitMs ?? DEFAULT_FOLLOWUP_WAIT_SPEECH_MS);
    worker.currentEndSilenceMs = Math.max(30, options?.endSilenceMs ?? this.endSilenceMs);
    worker.currentMaxUtteranceMs = Math.max(400, options?.maxUtteranceMs ?? this.maxUtteranceMs);
    worker.captureDeadlineAt = Date.now() + worker.currentMaxWaitMs;
    worker.sawOwnerInLiveCapture = false;
    worker.liveNonOwnerStreak = 0;
    worker.lastLiveCheckSamples = 0;
    worker.silenceSamples = 0;
    worker.utteranceSamples = 0;
    worker.captureMaxRms = 0;
    worker.chimeDiscardSamples = options?.discardMs === 0 ? 0 : msToSamples(options?.discardMs ?? 180);
    worker.vad?.reset();
    const refRms = worker.lastSpeechRms > 0
      ? Math.max(0.004, worker.lastSpeechRms * 0.75)
      : (worker.stream?.sampleFormat === 's32le' ? 0.0045 : 0);
    worker.vad?.markWake?.(refRms);
    console.log(
      `[xiaoai-kws] ${worker.channel.id}/${worker.target.id}: follow-up listening (${worker.currentMaxWaitMs}ms)`,
    );
    return true;
  }

  private rearmRemainingCaptureWindow(
    worker: ActiveWorker,
    spotter: XiaoaiKwsSpotter | undefined,
    remainingMs: number,
    meta?: CaptureMeta,
  ): boolean {
    if (this.closed || worker.stopped || !worker.kwsStream || remainingMs < 350) {
      return false;
    }
    worker.captureEpoch++;
    this.resetKwsBurst(worker, true);
    this.resetKwsIdleGate(worker);
    worker.mode = 'capturing';
    worker.activeKeyword = '连续对话';
    worker.isFollowUpCapture = true;
    worker.captureDeadlineAt = Date.now() + remainingMs;
    worker.sawOwnerInLiveCapture = false;
    worker.liveNonOwnerStreak = 0;
    worker.lastLiveCheckSamples = 0;
    worker.probeChunks = [];
    worker.probeSamples = 0;
    worker.probeSkipSamplesRemaining = 0;
    worker.probeSawSpeech = false;
    worker.preRollChunks = [];
    worker.preRollSamples = 0;
    worker.audioChunks = [];
    worker.speechStarted = false;
    worker.waitSamples = 0;
    worker.currentMaxWaitMs = Math.max(350, remainingMs);
    if (meta) {
      worker.currentEndSilenceMs = meta.endSilenceMs;
      worker.currentMaxUtteranceMs = meta.maxUtteranceMs;
    }
    worker.silenceSamples = 0;
    worker.utteranceSamples = 0;
    worker.captureMaxRms = 0;
    worker.chimeDiscardSamples = 0;
    worker.vad?.reset();
    spotter?.reset(worker.kwsStream);
    console.log(
      `[xiaoai-kws] ${worker.channel.id}/${worker.target.id}: re-arm follow-up after non-member rejection (${worker.currentMaxWaitMs}ms remaining)`,
    );
    return true;
  }

  private resetKwsIdleGate(worker: ActiveWorker): void {
    worker.kwsGateActive = false;
    worker.kwsGateHoldSamples = 0;
    worker.kwsIdlePreRoll = [];
    worker.kwsIdlePreRollSamples = 0;
    worker.kwsPrevSample = 0;
  }

  private resetKwsBurst(worker: ActiveWorker, abortInFlight = false): void {
    worker.kwsBurstPreRoll = [];
    worker.kwsBurstPreRollSamples = 0;
    worker.kwsBurstChunks = [];
    worker.kwsBurstSamples = 0;
    worker.kwsBurstSpeechSamples = 0;
    worker.kwsBurstSilenceSamples = 0;
    worker.kwsBurstMaxRms = 0;
    if (abortInFlight) {
      worker.kwsRescueId++;
      worker.kwsRescueInFlight = false;
      worker.kwsPostRescueChunks = [];
      worker.kwsPostRescueSpeech = false;
    }
  }

  private resetWorkerCapture(worker: ActiveWorker, spotter?: XiaoaiKwsSpotter): void {
    worker.mode = 'kws';
    worker.activeKeyword = '';
    worker.isFollowUpCapture = false;
    worker.captureDeadlineAt = 0;
    worker.sawOwnerInLiveCapture = false;
    worker.liveNonOwnerStreak = 0;
    worker.lastLiveCheckSamples = 0;
    worker.probeChunks = [];
    worker.kwsRingChunks = [];
    worker.kwsRingSamples = 0;
    this.resetKwsBurst(worker, true);
    this.resetKwsIdleGate(worker);
    worker.probeSamples = 0;
    worker.probeSkipSamplesRemaining = 0;
    worker.probeSawSpeech = false;
    worker.chimeDiscardSamples = 0;
    worker.preRollChunks = [];
    worker.preRollSamples = 0;
    worker.audioChunks = [];
    worker.speechStarted = false;
    worker.waitSamples = 0;
    worker.currentMaxWaitMs = this.maxWaitSpeechMs;
    worker.currentEndSilenceMs = this.endSilenceMs;
    worker.currentMaxUtteranceMs = this.maxUtteranceMs;
    worker.silenceSamples = 0;
    worker.utteranceSamples = 0;
    worker.captureMaxRms = 0;
    worker.vad?.reset();
    worker.vad?.markWake?.(0);
    if (spotter && worker.kwsStream) {
      spotter.reset(worker.kwsStream);
    }
  }

  private startWorkerStream(worker: ActiveWorker, spotter: XiaoaiKwsSpotter): void {
    if (this.closed || worker.stopped) return;

    const streamFactory = this.options.streamFactory
      ?? ((target: XiaoaiSshTarget, device: string) =>
        defaultStreamFactory(target, device, this.options.streamSpawn));
    let streamHandle: XiaoaiKwsStreamHandle;
    try {
      streamHandle = streamFactory(worker.target, worker.device);
      worker.kwsStream = spotter.createStream();
      worker.vad = worker.vad ?? this.createWorkerVad();
      worker.leftoverByte = null;
      worker.leftoverBytes = Buffer.alloc(0);
      worker.dcState = { prevX: 0, prevY: 0 };
      worker.ambientRms = 0;
      worker.recentKwsRms = [];
      worker.kwsRingChunks = [];
      worker.kwsRingSamples = 0;
      worker.kwsPrevSample = 0;
      this.resetWorkerCapture(worker, spotter);
    } catch (error) {
      this.options.onError?.(worker.channel.id, error);
      this.scheduleReconnect(worker, spotter);
      return;
    }

    worker.stream = streamHandle;
    const startedAt = Date.now();
    let stderrTail = '';

    streamHandle.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stderrTail = `${stderrTail}${text}`.slice(-400);
    });

    streamHandle.stdout.on('data', (rawChunk: Buffer | string) => {
      if (this.closed || worker.stopped || !worker.kwsStream) return;
      const buf = typeof rawChunk === 'string' ? Buffer.from(rawChunk) : rawChunk;
      if (buf.length === 0) return;

      let samples: Float32Array;
      if (streamHandle.sampleFormat === 's32le') {
        const decoded = decodePcm32leToFloat32(buf, worker.leftoverBytes, worker.dcState);
        worker.leftoverBytes = decoded.leftover;
        samples = decoded.samples;
      } else {
        const decoded = decodePcm16leToFloat32(buf, worker.leftoverByte);
        worker.leftoverByte = decoded.leftoverByte;
        samples = decoded.samples;
      }
      if (samples.length === 0) return;

      try {
        this.processWorkerSamples(worker, spotter, samples);
      } catch (error) {
        this.options.onError?.(worker.channel.id, error);
      }
    });

    streamHandle.onClose((code) => {
      worker.stream = undefined;
      worker.kwsStream = undefined;
      worker.captureEpoch++;
      this.resetWorkerCapture(worker);
      if (this.closed || worker.stopped) return;
      if (Date.now() - startedAt > 5_000) {
        worker.reconnectAttempt = 0;
      }
      if (code !== 0 && stderrTail.trim()) {
        this.options.onError?.(
          worker.channel.id,
          new Error(`KWS 音频流退出 (code=${code ?? 'null'}): ${stderrTail.trim()}`),
        );
      }
      this.scheduleReconnect(worker, spotter);
    });
  }

  private prepareKwsSamples(worker: ActiveWorker, samples: Float32Array): Float32Array {
    if (worker.stream?.sampleFormat !== 's32le') {
      return samples;
    }
    const kwsGain = computeKwsGain(samples, worker.ambientRms);
    const blend = Math.max(0, Math.min(1, (kwsGain - 1.25) / 0.75));
    const alpha = 0.50 * blend;
    const scale = kwsGain * (1 + 0.15 * blend);
    let prev = worker.kwsPrevSample;
    const boosted = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const cur = samples[i] ?? 0;
      const hp = cur - alpha * prev;
      prev = cur;
      boosted[i] = Math.tanh(hp * scale);
    }
    worker.kwsPrevSample = prev;
    return boosted;
  }

  private processWorkerSamples(
    worker: ActiveWorker,
    spotter: XiaoaiKwsSpotter,
    samples: Float32Array,
  ): void {
    if (worker.mode === 'chime_wait') {
      // Discard microphone frames while chime playback/SSH trigger executes
      return;
    }

    if (worker.mode === 'probing') {
      this.handleProbeSamples(worker, spotter, samples);
      return;
    }

    if (worker.mode === 'capturing') {
      this.handleCaptureSamples(worker, spotter, samples);
      return;
    }

    // 'kws' mode
    const chunkRms = computeRms(samples);
    worker.recentKwsRms.push(chunkRms);
    if (worker.recentKwsRms.length > 16) {
      worker.recentKwsRms.shift();
    }
    this.pushKwsRingSamples(worker, samples);

    if (this.idleEnergyGate && !worker.kwsRescueInFlight) {
      const gateRms = computeKwsIdleGateRms(worker.ambientRms, worker.stream?.sampleFormat, this.speechRmsThreshold);
      const aboveGate = chunkRms >= (worker.kwsGateActive ? gateRms * 0.85 : gateRms);
      if (!worker.kwsGateActive && !aboveGate) {
        worker.ambientRms = updateAmbientNoiseRms(worker.ambientRms, chunkRms);
        worker.vad?.observeAmbient?.(samples, chunkRms);
        worker.kwsIdlePreRollSamples = pushBoundedSamples(
          worker.kwsIdlePreRoll,
          worker.kwsIdlePreRollSamples,
          samples,
          msToSamples(400),
        );
        if (this.asrWakeRescue && worker.kwsBurstSpeechSamples === 0) {
          worker.kwsBurstPreRollSamples = pushBoundedSamples(
            worker.kwsBurstPreRoll,
            worker.kwsBurstPreRollSamples,
            samples,
            msToSamples(200),
          );
        }
        return;
      }

      if (!worker.kwsGateActive) {
        worker.kwsGateActive = true;
        worker.kwsGateHoldSamples = msToSamples(900);
        worker.kwsPrevSample = 0;
        spotter.reset(worker.kwsStream);
        const preRoll = worker.kwsIdlePreRoll;
        worker.kwsIdlePreRoll = [];
        worker.kwsIdlePreRollSamples = 0;
        for (const preChunk of preRoll) {
          if (this.feedSpotterAndCheckWake(worker, spotter, this.prepareKwsSamples(worker, preChunk), computeRms(preChunk))) {
            return;
          }
        }
      } else if (aboveGate) {
        worker.kwsGateHoldSamples = msToSamples(900);
      } else {
        worker.kwsGateHoldSamples -= samples.length;
      }
    }

    const isFgSpeech = this.asrWakeRescue
      ? (worker.vad?.isSpeech(samples, SAMPLE_RATE) ?? (chunkRms >= this.speechRmsThreshold))
      : false;
    if (isFgSpeech && worker.kwsGateActive) {
      worker.kwsGateHoldSamples = msToSamples(900);
    }
    if (worker.ambientRms <= 0 || !isFgSpeech) {
      worker.ambientRms = updateAmbientNoiseRms(worker.ambientRms, chunkRms);
      worker.vad?.observeAmbient?.(samples, chunkRms);
    }

    if (this.feedSpotterAndCheckWake(worker, spotter, this.prepareKwsSamples(worker, samples), chunkRms)) {
      return;
    }

    if (worker.kwsRescueInFlight) {
      let postLen = 0;
      for (const c of worker.kwsPostRescueChunks) postLen += c.length;
      if (postLen < msToSamples(2_500)) {
        worker.kwsPostRescueChunks.push(samples);
      }
      if (isFgSpeech) {
        worker.kwsPostRescueSpeech = true;
      }
      return;
    }

    if (this.asrWakeRescue) {
      this.updateAsrWakeRescueBurst(worker, spotter, samples, chunkRms, isFgSpeech);
    }

    this.maybeHibernateKwsAfterChunk(worker, spotter, chunkRms);
  }

  private feedSpotterAndCheckWake(
    worker: ActiveWorker,
    spotter: XiaoaiKwsSpotter,
    preparedSamples: Float32Array,
    chunkRms: number,
  ): boolean {
    spotter.acceptWaveform(worker.kwsStream, preparedSamples, SAMPLE_RATE);
    while (spotter.isReady(worker.kwsStream)) {
      spotter.decode(worker.kwsStream);
      const keyword = spotter.getResult(worker.kwsStream).trim();
      if (!keyword) continue;

      const now = Date.now();
      if (now - worker.lastWakeAt < this.cooldownMs) {
        spotter.reset(worker.kwsStream);
        this.resetKwsBurst(worker, true);
        this.resetKwsIdleGate(worker);
        return true;
      }
      if (isXiaoaiSpeakingSelfEcho(worker.channel.id, worker.target.id, keyword, now)) {
        worker.lastWakeAt = Math.max(worker.lastWakeAt, now - Math.max(0, this.cooldownMs - 500));
        spotter.reset(worker.kwsStream);
        this.resetKwsBurst(worker, true);
        this.resetKwsIdleGate(worker);
        return true;
      }
      if (!this.passesWakeSpeakerGate(worker, keyword)) {
        spotter.reset(worker.kwsStream);
        worker.kwsRingChunks = [];
        worker.kwsRingSamples = 0;
        this.resetKwsBurst(worker, true);
        this.resetKwsIdleGate(worker);
        return true;
      }
      const wakeRms = Math.max(chunkRms, ...worker.recentKwsRms);
      worker.lastSpeechRms = wakeRms;
      worker.vad?.markWake?.(wakeRms);
      spotter.reset(worker.kwsStream);
      this.resetKwsBurst(worker, true);
      this.resetKwsIdleGate(worker);
      this.beginWakeProbe(worker, spotter, keyword);
      return true;
    }
    return false;
  }

  private updateAsrWakeRescueBurst(
    worker: ActiveWorker,
    spotter: XiaoaiKwsSpotter,
    samples: Float32Array,
    chunkRms: number,
    isFgSpeech: boolean,
  ): void {
    if (worker.kwsBurstSpeechSamples === 0) {
      if (!isFgSpeech) {
        worker.kwsBurstPreRollSamples = pushBoundedSamples(
          worker.kwsBurstPreRoll,
          worker.kwsBurstPreRollSamples,
          samples,
          msToSamples(200),
        );
        return;
      }
      worker.kwsBurstChunks = [...worker.kwsBurstPreRoll, samples];
      worker.kwsBurstSamples = worker.kwsBurstPreRollSamples + samples.length;
      worker.kwsBurstSpeechSamples = samples.length;
      worker.kwsBurstSilenceSamples = 0;
      worker.kwsBurstMaxRms = chunkRms;
      worker.kwsBurstPreRoll = [];
      worker.kwsBurstPreRollSamples = 0;
      return;
    }

    worker.kwsBurstChunks.push(samples);
    worker.kwsBurstSamples += samples.length;
    if (chunkRms > worker.kwsBurstMaxRms) {
      worker.kwsBurstMaxRms = chunkRms;
    }
    if (isFgSpeech) {
      worker.kwsBurstSpeechSamples += samples.length;
      worker.kwsBurstSilenceSamples = 0;
    } else {
      worker.kwsBurstSilenceSamples += samples.length;
    }

    if (worker.kwsBurstSamples > msToSamples(3_800)) {
      this.resetKwsBurst(worker);
      return;
    }

    if (worker.kwsBurstSilenceSamples >= msToSamples(300)) {
      const speechLen = worker.kwsBurstSpeechSamples;
      const silenceLen = worker.kwsBurstSilenceSamples;
      const maxRms = worker.kwsBurstMaxRms;
      const rawBurst = concatFloat32Arrays(worker.kwsBurstChunks);
      this.resetKwsBurst(worker);

      const keep = Math.max(msToSamples(320), rawBurst.length - Math.max(0, silenceLen - msToSamples(160)));
      const burstSamples = keep < rawBurst.length ? rawBurst.subarray(0, keep) : rawBurst;
      if (
        speechLen >= msToSamples(300)
        && Date.now() - worker.lastWakeAt >= this.cooldownMs
        && (worker.stream?.sampleFormat !== 's32le' || maxRms >= 0.0013)
      ) {
        const rescueId = ++worker.kwsRescueId;
        worker.kwsRescueInFlight = true;
        worker.kwsPostRescueChunks = [];
        worker.kwsPostRescueSpeech = false;
        void this.tryAsrWakeRescue(worker, spotter, burstSamples, maxRms, rescueId);
      }
    }
  }

  private maybeHibernateKwsAfterChunk(
    worker: ActiveWorker,
    spotter: XiaoaiKwsSpotter,
    chunkRms: number,
  ): void {
    if (
      !this.idleEnergyGate
      || !worker.kwsGateActive
      || worker.kwsGateHoldSamples > 0
      || worker.kwsRescueInFlight
      || worker.kwsBurstSpeechSamples > 0
    ) {
      return;
    }
    // Flush Transducer right-context lookahead frames once before entering hibernation
    if (this.feedSpotterAndCheckWake(worker, spotter, new Float32Array(msToSamples(160)), chunkRms)) {
      return;
    }
    spotter.reset(worker.kwsStream);
    worker.vad?.reset();
    this.resetKwsIdleGate(worker);
  }

  private pushKwsRingSamples(worker: ActiveWorker, samples: Float32Array): void {
    worker.kwsRingSamples = pushBoundedSamples(worker.kwsRingChunks, worker.kwsRingSamples, samples, msToSamples(1_800));
  }

  private passesWakeSpeakerGate(
    worker: ActiveWorker,
    keyword: string,
    customSlice?: Float32Array,
    silentLog = false,
  ): boolean {
    const gate = this.options.speakerGate;
    if (!gate?.verifyWake || !gate.isActive(worker.channel, worker.target)) {
      return true;
    }
    if (gate.isBypassed?.(worker.channel.id, worker.target.id)) {
      return true;
    }
    const wakeSlice = customSlice ?? concatFloat32Arrays(worker.kwsRingChunks);
    const verdict = gate.verifyWake({
      channel: worker.channel,
      target: worker.target,
      keyword,
      samples: wakeSlice,
      sampleRate: SAMPLE_RATE,
    });
    if (!verdict.matched) {
      if (!silentLog) {
        console.log(
          `[xiaoai-kws] ${worker.channel.id}/${worker.target.id}: wake="${keyword}" rejected by speaker gate (score=${verdict.score.toFixed(3)} < ${verdict.threshold.toFixed(3)}, dur=${(wakeSlice.length / SAMPLE_RATE).toFixed(2)}s)`,
        );
      }
      return false;
    }
    return true;
  }

  private async tryAsrWakeRescue(
    worker: ActiveWorker,
    spotter: XiaoaiKwsSpotter,
    burstSamples: Float32Array,
    burstMaxRms: number,
    rescueId: number,
  ): Promise<void> {
    try {
      if (this.closed || worker.stopped || worker.mode !== 'kws' || worker.kwsRescueId !== rescueId) {
        return;
      }
      if (!this.passesWakeSpeakerGate(worker, '星期五', burstSamples, true)) {
        return;
      }
      const recognizer = await this.ensureRecognizer();
      if (!recognizer || this.closed || worker.stopped || worker.mode !== 'kws' || worker.kwsRescueId !== rescueId) {
        return;
      }
      const rawText = await recognizer.transcribe(burstSamples, SAMPLE_RATE);
      if (this.closed || worker.stopped || worker.mode !== 'kws' || worker.kwsRescueId !== rescueId) {
        return;
      }
      const match = extractLeadingXiaoaiWakeKeyword(rawText);
      if (!match) {
        return;
      }
      const now = Date.now();
      if (
        now - worker.lastWakeAt < this.cooldownMs
        || isXiaoaiSpeakingSelfEcho(worker.channel.id, worker.target.id, match.keyword, now)
      ) {
        return;
      }

      if (!match.remainder) {
        const postChunks = [...worker.kwsPostRescueChunks];
        const postSawSpeech = worker.kwsPostRescueSpeech;
        const apiOptions = parseXiaoaiApiOptions(worker.channel.apiBase);
        console.log(
          `[xiaoai-kws] ${worker.channel.id}/${worker.target.id}: wake="${match.keyword}" mode=${postSawSpeech ? 'asr-rescue-live' : 'asr-rescue'} (maxRms=${burstMaxRms.toFixed(5)}, raw=${JSON.stringify(rawText)})`,
        );

        const epoch = ++worker.captureEpoch;
        worker.activeKeyword = match.keyword;
        worker.currentMaxWaitMs = this.maxWaitSpeechMs;
        worker.currentEndSilenceMs = this.endSilenceMs;
        worker.currentMaxUtteranceMs = this.maxUtteranceMs;
        worker.lastSpeechRms = burstMaxRms;
        worker.vad?.reset();
        worker.vad?.markWake?.(burstMaxRms);
        spotter.reset(worker.kwsStream);
        this.resetKwsIdleGate(worker);

        if (postSawSpeech) {
          let postTotal = 0;
          for (const c of postChunks) postTotal += c.length;
          worker.lastWakeAt = Date.now();
          worker.mode = 'capturing';
          this.resetLiveCaptureTracking(worker, false);
          worker.speechStarted = true;
          worker.audioChunks = postChunks;
          worker.utteranceSamples = postTotal;
          worker.silenceSamples = 0;
          worker.waitSamples = 0;
          worker.chimeDiscardSamples = 0;
          worker.captureMaxRms = burstMaxRms;
          void this.invokeWake(worker, match.keyword, false)
            .then((res) => {
              if (res.suppressed && worker.captureEpoch === epoch && worker.mode === 'capturing') {
                worker.captureEpoch++;
                this.resetWorkerCapture(worker, spotter);
              }
            })
            .catch((err) => this.options.onError?.(worker.channel.id, err));
          return;
        }

        worker.probeChunks = [];
        worker.probeSamples = 0;
        worker.preRollChunks = [];
        worker.preRollSamples = 0;
        worker.audioChunks = [];
        worker.speechStarted = false;
        worker.waitSamples = 0;
        worker.silenceSamples = 0;
        worker.utteranceSamples = 0;
        worker.captureMaxRms = 0;

        if (!apiOptions.kwsChime) {
          worker.lastWakeAt = Date.now();
          worker.mode = 'capturing';
          this.resetLiveCaptureTracking(worker, false);
          worker.chimeDiscardSamples = 0;
          void this.invokeWake(worker, match.keyword, false).catch((err) => {
            this.options.onError?.(worker.channel.id, err);
          });
          return;
        }

        worker.mode = 'chime_wait';
        void this.invokeWake(worker, match.keyword, true)
          .then((res) => {
            if (this.closed || worker.stopped || worker.captureEpoch !== epoch || worker.mode !== 'chime_wait') {
              return;
            }
            if (!res.woken) {
              if (res.suppressed) {
                worker.lastWakeAt = Math.max(worker.lastWakeAt, Date.now() - Math.max(0, this.cooldownMs - 500));
              }
              worker.captureEpoch++;
              this.resetWorkerCapture(worker, spotter);
              return;
            }
            worker.lastWakeAt = Date.now();
            worker.mode = 'capturing';
            this.resetLiveCaptureTracking(worker, false);
            worker.chimeDiscardSamples = msToSamples(this.chimeDiscardMs);
            worker.vad?.reset();
          })
          .catch((error) => {
            this.options.onError?.(worker.channel.id, error);
            if (!this.closed && !worker.stopped && worker.captureEpoch === epoch) {
              worker.captureEpoch++;
              this.resetWorkerCapture(worker, spotter);
            }
          });
        return;
      }

      let matchedSpeaker: XiaoaiMatchedSpeaker | undefined;
      const gate = this.options.speakerGate;
      const gateBypassed = gate?.isBypassed?.(worker.channel.id, worker.target.id) ?? false;
      if (gate && !gateBypassed && gate.isActive(worker.channel, worker.target)) {
        const verdict = gate.verifyUtterance({
          channel: worker.channel,
          target: worker.target,
          keyword: match.keyword,
          samples: burstSamples,
          sampleRate: SAMPLE_RATE,
        });
        if (!verdict.matched) {
          console.log(
            `[xiaoai-kws] ${worker.channel.id}/${worker.target.id}: utterance rejected by speaker gate (wake="${match.keyword}", score=${verdict.score.toFixed(3)} < ${verdict.threshold.toFixed(3)})`,
          );
          return;
        }
        matchedSpeaker = verdict.speaker;
      }

      const bypassCancel = this.options.shouldBypassFollowUpCancel?.(
        worker.channel.id,
        worker.target.id,
        match.remainder,
      ) ?? false;
      if (!bypassCancel && isXiaoaiFollowUpCancel(match.remainder)) {
        console.log(
          `[xiaoai-kws] ${worker.channel.id}/${worker.target.id}: wake="${match.keyword}" dismissed (${JSON.stringify(match.remainder)})`,
        );
        this.cancelSpeakerLed(worker, match.keyword, 'cancel', match.remainder);
        return;
      }

      console.log(
        `[xiaoai-kws] ${worker.channel.id}/${worker.target.id}: wake="${match.keyword}" mode=asr-rescue-utterance dur=${(burstSamples.length / SAMPLE_RATE).toFixed(2)}s maxRms=${burstMaxRms.toFixed(5)} raw=${JSON.stringify(rawText)} clean=${JSON.stringify(match.remainder)}`,
      );
      worker.lastWakeAt = Date.now();
      worker.lastSpeechRms = burstMaxRms;
      spotter.reset(worker.kwsStream);
      this.resetKwsIdleGate(worker);
      await this.invokeWake(worker, match.keyword, false).catch((err) => {
        this.options.onError?.(worker.channel.id, err);
      });
      this.notifySpeakerTranscribing(worker, match.keyword);
      if (this.options.onUtterance) {
        await this.options.onUtterance({
          channel: worker.channel,
          target: worker.target,
          keyword: match.keyword,
          text: match.remainder,
          explicitWake: true,
          ...(matchedSpeaker ? { speaker: matchedSpeaker } : {}),
          ...(gateBypassed ? { samples: burstSamples, sampleRate: SAMPLE_RATE } : {}),
        });
      }
    } catch (error) {
      this.options.onError?.(worker.channel.id, error);
    } finally {
      if (worker.kwsRescueId === rescueId) {
        worker.kwsRescueInFlight = false;
        worker.kwsPostRescueChunks = [];
        worker.kwsPostRescueSpeech = false;
      }
    }
  }

  private resetLiveCaptureTracking(worker: ActiveWorker, isFollowUp: boolean): void {
    worker.isFollowUpCapture = isFollowUp;
    worker.captureDeadlineAt = Date.now() + worker.currentMaxWaitMs;
    worker.sawOwnerInLiveCapture = false;
    worker.liveNonOwnerStreak = 0;
    worker.lastLiveCheckSamples = 0;
  }

  private invokeWake(
    worker: ActiveWorker,
    keyword: string,
    chime: boolean,
  ): Promise<{ woken: boolean; suppressed: boolean }> {
    const wakeFn = this.options.onWake
      ?? ((ev: XiaoaiKwsWakeEvent) => handleXiaoaiKeywordWake({
        channel: ev.channel,
        target: ev.target,
        keyword: ev.keyword,
        chime: ev.chime,
        sshRunner: this.options.sshRunner,
      }));
    return wakeFn({
      channel: worker.channel,
      target: worker.target,
      keyword,
      chime,
    });
  }

  private cancelSpeakerLed(
    worker: ActiveWorker,
    keyword: string,
    reason: 'timeout' | 'empty' | 'cancel' | 'error' | 'speaker_rejected' = 'cancel',
    text?: string,
    explicitWake?: boolean,
  ): void {
    if (this.options.onCaptureCancel) {
      void Promise.resolve(this.options.onCaptureCancel({
        channel: worker.channel,
        target: worker.target,
        keyword,
        reason,
        ...(text ? { text } : {}),
        ...(explicitWake !== undefined ? { explicitWake } : {}),
      })).catch((err) => this.options.onError?.(worker.channel.id, err));
      return;
    }
    void setXiaoaiSpeakerLed(worker.target, 'off', this.options.sshRunner);
  }

  private notifySpeakerTranscribing(worker: ActiveWorker, keyword: string): void {
    if (this.options.onTranscribing) {
      void Promise.resolve(this.options.onTranscribing({
        channel: worker.channel,
        target: worker.target,
        keyword,
      })).catch((err) => this.options.onError?.(worker.channel.id, err));
      return;
    }
    void setXiaoaiSpeakerLed(worker.target, 'think', this.options.sshRunner);
  }

  private beginWakeProbe(worker: ActiveWorker, spotter: XiaoaiKwsSpotter, keyword: string): void {
    const now = Date.now();
    if (now - worker.lastWakeAt < this.cooldownMs) {
      return;
    }
    if (isXiaoaiSpeakingSelfEcho(worker.channel.id, worker.target.id, keyword, now)) {
      worker.lastWakeAt = Math.max(worker.lastWakeAt, now - Math.max(0, this.cooldownMs - 500));
      return;
    }

    const probeTarget = msToSamples(this.probeDurationMs);
    worker.captureEpoch++;
    worker.mode = 'probing';
    worker.activeKeyword = keyword;
    worker.currentMaxWaitMs = this.maxWaitSpeechMs;
    worker.probeChunks = [];
    worker.probeSamples = 0;
    worker.probeSkipSamplesRemaining = Math.min(msToSamples(60), Math.floor(probeTarget / 3));
    worker.probeSawSpeech = false;
    worker.vad?.reset();
    void spotter;
  }

  private handleProbeSamples(
    worker: ActiveWorker,
    spotter: XiaoaiKwsSpotter,
    samples: Float32Array,
  ): void {
    worker.probeChunks.push(samples);
    worker.probeSamples += samples.length;

    let checkSlice = samples;
    if (worker.probeSkipSamplesRemaining > 0) {
      if (samples.length <= worker.probeSkipSamplesRemaining) {
        worker.probeSkipSamplesRemaining -= samples.length;
        checkSlice = new Float32Array(0);
      } else {
        checkSlice = samples.subarray(worker.probeSkipSamplesRemaining);
        worker.probeSkipSamplesRemaining = 0;
      }
    }

    if (checkSlice.length > 0 && worker.vad?.isSpeech(checkSlice, SAMPLE_RATE)) {
      worker.probeSawSpeech = true;
    }

    if (worker.probeSamples < msToSamples(this.probeDurationMs)) {
      return;
    }

    const keyword = worker.activeKeyword;
    const epoch = ++worker.captureEpoch;
    const apiOptions = parseXiaoaiApiOptions(worker.channel.apiBase);
    console.log(
      `[xiaoai-kws] ${worker.channel.id}/${worker.target.id}: wake="${keyword}" mode=${worker.probeSawSpeech ? 'one-breath' : 'two-step'}`,
    );

    if (worker.probeSawSpeech) {
      // One-breath speech ("你好星期五现在几点了"): skip audible chime so speaker doesn't talk over user
      worker.lastWakeAt = Date.now();
      worker.mode = 'capturing';
      this.resetLiveCaptureTracking(worker, false);
      worker.speechStarted = true;
      worker.audioChunks = [...worker.probeChunks];
      worker.utteranceSamples = worker.probeSamples;
      worker.silenceSamples = 0;
      worker.waitSamples = 0;
      worker.chimeDiscardSamples = 0;
      worker.probeChunks = [];
      worker.probeSamples = 0;

      void this.invokeWake(worker, keyword, false)
        .then((res) => {
          if (res.suppressed && worker.captureEpoch === epoch && worker.mode === 'capturing') {
            worker.captureEpoch++;
            this.resetWorkerCapture(worker, spotter);
          }
        })
        .catch((error) => {
          this.options.onError?.(worker.channel.id, error);
        });
      return;
    }

    // Two-step wake: silent pause after wake phrase
    worker.probeChunks = [];
    worker.probeSamples = 0;
    worker.preRollChunks = [];
    worker.preRollSamples = 0;
    worker.audioChunks = [];
    worker.speechStarted = false;
    worker.waitSamples = 0;
    worker.silenceSamples = 0;
    worker.utteranceSamples = 0;

    if (!apiOptions.kwsChime) {
      worker.lastWakeAt = Date.now();
      worker.mode = 'capturing';
      this.resetLiveCaptureTracking(worker, false);
      worker.chimeDiscardSamples = 0;
      worker.vad?.reset();
      void this.invokeWake(worker, keyword, false).catch((error) => {
        this.options.onError?.(worker.channel.id, error);
      });
      return;
    }

    worker.mode = 'chime_wait';
    void this.invokeWake(worker, keyword, true)
      .then((res) => {
        if (this.closed || worker.stopped || worker.captureEpoch !== epoch || worker.mode !== 'chime_wait') {
          return;
        }
        if (!res.woken) {
          if (res.suppressed) {
            worker.lastWakeAt = Math.max(worker.lastWakeAt, Date.now() - Math.max(0, this.cooldownMs - 500));
          }
          worker.captureEpoch++;
          this.resetWorkerCapture(worker, spotter);
          return;
        }
        worker.lastWakeAt = Date.now();
        worker.mode = 'capturing';
        this.resetLiveCaptureTracking(worker, false);
        worker.chimeDiscardSamples = msToSamples(this.chimeDiscardMs);
        worker.vad?.reset();
      })
      .catch((error) => {
        this.options.onError?.(worker.channel.id, error);
        if (!this.closed && !worker.stopped && worker.captureEpoch === epoch) {
          worker.captureEpoch++;
          this.resetWorkerCapture(worker, spotter);
        }
      });
  }

  private pushPreRoll(worker: ActiveWorker, samples: Float32Array): void {
    worker.preRollSamples = pushBoundedSamples(worker.preRollChunks, worker.preRollSamples, samples, msToSamples(DEFAULT_PRE_ROLL_MS));
  }

  private handleCaptureSamples(
    worker: ActiveWorker,
    spotter: XiaoaiKwsSpotter,
    rawSamples: Float32Array,
  ): void {
    let samples = rawSamples;
    if (worker.chimeDiscardSamples > 0) {
      if (samples.length <= worker.chimeDiscardSamples) {
        worker.chimeDiscardSamples -= samples.length;
        return;
      }
      samples = samples.subarray(worker.chimeDiscardSamples);
      worker.chimeDiscardSamples = 0;
    }
    if (samples.length === 0) return;

    const rms = computeRms(samples);
    if (rms > worker.captureMaxRms) {
      worker.captureMaxRms = rms;
    }
    const speech = worker.vad?.isSpeech(samples, SAMPLE_RATE) ?? (rms >= this.speechRmsThreshold);

    if (!worker.speechStarted) {
      this.pushPreRoll(worker, samples);
      if (speech) {
        worker.speechStarted = true;
        worker.audioChunks = [...worker.preRollChunks];
        worker.utteranceSamples = worker.preRollSamples;
        worker.preRollChunks = [];
        worker.preRollSamples = 0;
        worker.silenceSamples = 0;
      } else {
        worker.ambientRms = updateAmbientNoiseRms(worker.ambientRms, rms);
        worker.vad?.observeAmbient?.(samples);
        if (worker.kwsStream && (worker.activeKeyword === '连续对话' || worker.waitSamples >= msToSamples(500))) {
          this.pushKwsRingSamples(worker, samples);
          spotter.acceptWaveform(worker.kwsStream, this.prepareKwsSamples(worker, samples), SAMPLE_RATE);
          while (spotter.isReady(worker.kwsStream)) {
            spotter.decode(worker.kwsStream);
            const reWakeKeyword = spotter.getResult(worker.kwsStream).trim();
            if (reWakeKeyword && !isXiaoaiSpeakingSelfEcho(worker.channel.id, worker.target.id, reWakeKeyword)) {
              if (!this.passesWakeSpeakerGate(worker, reWakeKeyword)) {
                spotter.reset(worker.kwsStream);
                worker.kwsRingChunks = [];
                worker.kwsRingSamples = 0;
                break;
              }
              worker.lastSpeechRms = rms;
              worker.vad?.markWake?.(rms);
              spotter.reset(worker.kwsStream);
              worker.lastWakeAt = 0;
              this.beginWakeProbe(worker, spotter, reWakeKeyword);
              return;
            }
          }
        }
        worker.waitSamples += samples.length;
        if (worker.waitSamples >= msToSamples(worker.currentMaxWaitMs)) {
          const keyword = worker.activeKeyword;
          console.log(
            `[xiaoai-kws] ${worker.channel.id}/${worker.target.id}: wake="${keyword}" wait timeout (${worker.currentMaxWaitMs}ms, maxRms=${worker.captureMaxRms.toFixed(5)})`,
          );
          worker.captureEpoch++;
          this.resetWorkerCapture(worker, spotter);
          this.cancelSpeakerLed(worker, keyword, 'timeout');
        }
        return;
      }
    } else {
      worker.audioChunks.push(samples);
      worker.utteranceSamples += samples.length;
      if (speech) {
        worker.silenceSamples = 0;
      } else {
        worker.silenceSamples += samples.length;
      }
    }

    let forceEndCapture = false;
    const gate = this.options.speakerGate;
    if (
      worker.speechStarted
      && speech
      && gate
      && gate.isActive(worker.channel, worker.target)
      && !gate.isBypassed?.(worker.channel.id, worker.target.id)
      && worker.utteranceSamples >= msToSamples(1_600)
      && worker.utteranceSamples - worker.lastLiveCheckSamples >= msToSamples(800)
    ) {
      worker.lastLiveCheckSamples = worker.utteranceSamples;
      const checkSamples = worker.sawOwnerInLiveCapture
        ? concatTrailingSamples(worker.audioChunks, msToSamples(1_100))
        : concatFloat32Arrays(worker.audioChunks);
      const liveCheck = gate.verifyUtterance({
        channel: worker.channel,
        target: worker.target,
        keyword: worker.activeKeyword,
        samples: checkSamples,
        sampleRate: SAMPLE_RATE,
      });
      if (liveCheck.matched) {
        worker.sawOwnerInLiveCapture = true;
        worker.liveNonOwnerStreak = liveCheck.trimmed ? 1 : 0;
      } else {
        worker.liveNonOwnerStreak++;
        if (!worker.sawOwnerInLiveCapture && worker.isFollowUpCapture && worker.liveNonOwnerStreak >= 1) {
          const remaining = worker.captureDeadlineAt - Date.now();
          const savedMeta: CaptureMeta = {
            isFollowUp: worker.isFollowUpCapture,
            deadlineAt: worker.captureDeadlineAt,
            endSilenceMs: worker.currentEndSilenceMs,
            maxUtteranceMs: worker.currentMaxUtteranceMs,
          };
          if (this.rearmRemainingCaptureWindow(worker, spotter, remaining, savedMeta)) {
            return;
          }
          const keyword = worker.activeKeyword;
          worker.captureEpoch++;
          this.resetWorkerCapture(worker, spotter);
          this.cancelSpeakerLed(worker, keyword, 'speaker_rejected');
          return;
        }
        if (worker.sawOwnerInLiveCapture && worker.liveNonOwnerStreak >= 2) {
          console.log(
            `[xiaoai-kws] ${worker.channel.id}/${worker.target.id}: continuous non-member audio after member speech, endpointing early`,
          );
          forceEndCapture = true;
        }
      }
    }

    const activeSpeechSamples = Math.max(0, worker.utteranceSamples - worker.silenceSamples);
    const effectiveEndSilenceMs =
      worker.currentEndSilenceMs >= DEFAULT_END_SILENCE_MS && activeSpeechSamples < msToSamples(SHORT_UTTERANCE_SPEECH_MS)
        ? Math.max(worker.currentEndSilenceMs, DEFAULT_SHORT_UTTERANCE_END_SILENCE_MS)
        : worker.currentEndSilenceMs;

    if (
      forceEndCapture
      || worker.silenceSamples >= msToSamples(effectiveEndSilenceMs)
      || worker.utteranceSamples >= msToSamples(worker.currentMaxUtteranceMs)
    ) {
      const keyword = worker.activeKeyword;
      const maxRms = worker.captureMaxRms;
      const savedMeta: CaptureMeta = {
        isFollowUp: worker.isFollowUpCapture,
        deadlineAt: worker.captureDeadlineAt,
        endSilenceMs: worker.currentEndSilenceMs,
        maxUtteranceMs: worker.currentMaxUtteranceMs,
      };
      const rawCaptured = concatFloat32Arrays(worker.audioChunks);
      const excessSilence = forceEndCapture ? 0 : Math.max(0, worker.silenceSamples - msToSamples(180));
      const keepLength = rawCaptured.length - excessSilence;
      const captured = excessSilence > 0 && keepLength >= msToSamples(280)
        ? rawCaptured.subarray(0, keepLength)
        : rawCaptured;
      worker.lastWakeAt = Date.now();
      worker.captureEpoch++;
      this.resetWorkerCapture(worker, spotter);
      void this.transcribeAndEmit(worker, keyword, captured, maxRms, savedMeta);
    }
  }

  private async transcribeAndEmit(
    worker: ActiveWorker,
    keyword: string,
    samples: Float32Array,
    maxRms = 0,
    captureMeta?: CaptureMeta,
  ): Promise<void> {
    worker.transcribingCount++;
    try {
      if (this.closed || worker.stopped) return;
      if (worker.stream?.sampleFormat === 's32le' && maxRms > 0 && maxRms < 0.0010) {
        this.cancelSpeakerLed(worker, keyword, 'empty');
        return;
      }

      let audioForAsr = samples;
      let matchedSpeaker: XiaoaiMatchedSpeaker | undefined;
      const gate = this.options.speakerGate;
      const gateBypassed = gate?.isBypassed?.(worker.channel.id, worker.target.id) ?? false;
      if (gate && !gateBypassed && gate.isActive(worker.channel, worker.target)) {
        const gateParams = {
          channel: worker.channel,
          target: worker.target,
          keyword,
          samples: audioForAsr,
          sampleRate: SAMPLE_RATE,
        };
        const verdict = await (gate.verifyUtteranceAsync
          ? gate.verifyUtteranceAsync(gateParams)
          : gate.verifyUtterance(gateParams));
        if (this.closed || worker.stopped) return;
        if (!verdict.matched) {
          console.log(
            `[xiaoai-kws] ${worker.channel.id}/${worker.target.id}: utterance rejected by speaker gate (wake="${keyword}", score=${verdict.score.toFixed(3)} < ${verdict.threshold.toFixed(3)})`,
          );
          if (
            captureMeta?.isFollowUp
            && !this.closed
            && !worker.stopped
            && worker.mode === 'kws'
            && worker.kwsStream
          ) {
            const remaining = captureMeta.deadlineAt - Date.now();
            if (this.rearmRemainingCaptureWindow(worker, this.spotter, remaining, captureMeta)) {
              return;
            }
          }
          this.cancelSpeakerLed(worker, keyword, 'speaker_rejected');
          return;
        }
        matchedSpeaker = verdict.speaker;
        if (verdict.samples && verdict.samples.length > 0) {
          audioForAsr = verdict.samples;
          if (verdict.trimmed) {
            console.log(
              `[xiaoai-kws] ${worker.channel.id}/${worker.target.id}: trimmed trailing non-member audio ${(samples.length / SAMPLE_RATE).toFixed(2)}s -> ${(audioForAsr.length / SAMPLE_RATE).toFixed(2)}s`,
            );
          }
        }
      }

      this.notifySpeakerTranscribing(worker, keyword);
      try {
        const recognizer = await this.ensureRecognizer();
        if (this.closed || worker.stopped) return;
        if (!recognizer) {
          this.cancelSpeakerLed(worker, keyword, 'error');
          return;
        }
        const rawText = await recognizer.transcribe(audioForAsr, SAMPLE_RATE);
        const explicitWake = keyword !== '连续对话' || hasLeadingXiaoaiWakeWord(rawText);
        const cleanText = cleanXiaoaiAsrUtterance(rawText);
        const durationSec = (audioForAsr.length / SAMPLE_RATE).toFixed(2);
        console.log(
          `[xiaoai-kws] ${worker.channel.id}/${worker.target.id}: wake="${keyword}" dur=${durationSec}s maxRms=${maxRms.toFixed(5)} raw=${JSON.stringify(rawText)} clean=${JSON.stringify(cleanText)}`,
        );
        if (this.closed || worker.stopped) return;
        if (!cleanText) {
          this.cancelSpeakerLed(worker, keyword, 'empty', rawText, explicitWake);
          return;
        }
        if (maxRms > 0) {
          worker.lastSpeechRms = maxRms;
        }
        const bypassCancel = this.options.shouldBypassFollowUpCancel?.(
          worker.channel.id,
          worker.target.id,
          cleanText,
        ) ?? false;
        if (!bypassCancel && isXiaoaiFollowUpCancel(cleanText)) {
          console.log(
            `[xiaoai-kws] ${worker.channel.id}/${worker.target.id}: dismissed (${JSON.stringify(cleanText)})`,
          );
          this.cancelSpeakerLed(worker, keyword, 'cancel', cleanText);
          return;
        }
        if (this.options.onUtterance) {
          await this.options.onUtterance({
            channel: worker.channel,
            target: worker.target,
            keyword,
            text: cleanText,
            explicitWake,
            ...(matchedSpeaker ? { speaker: matchedSpeaker } : {}),
            ...(gateBypassed ? { samples: audioForAsr, sampleRate: SAMPLE_RATE } : {}),
          });
        }
      } catch (error) {
        this.options.onError?.(worker.channel.id, error);
        this.cancelSpeakerLed(worker, keyword, 'error');
      }
    } finally {
      worker.transcribingCount = Math.max(0, worker.transcribingCount - 1);
    }
  }

  private scheduleReconnect(worker: ActiveWorker, spotter: XiaoaiKwsSpotter): void {
    if (this.closed || worker.stopped || worker.reconnectTimer) return;
    const delayMs = Math.min(15_000, 1_500 * (2 ** Math.min(worker.reconnectAttempt, 4)));
    worker.reconnectAttempt++;
    const timer = setTimeout(() => {
      worker.reconnectTimer = undefined;
      this.startWorkerStream(worker, spotter);
    }, delayMs);
    timer.unref();
    worker.reconnectTimer = timer;
  }

  private stopWorker(worker: ActiveWorker): void {
    worker.stopped = true;
    worker.captureEpoch++;
    if (worker.reconnectTimer) {
      clearTimeout(worker.reconnectTimer);
      worker.reconnectTimer = undefined;
    }
    worker.stream?.kill();
    worker.stream = undefined;
    worker.kwsStream = undefined;
    worker.vad?.free?.();
    worker.vad = undefined;
    this.resetWorkerCapture(worker);
  }

  close(): void {
    this.closed = true;
    for (const worker of this.workers.values()) {
      this.stopWorker(worker);
    }
    this.workers.clear();
    this.spotter?.free?.();
    this.spotter = undefined;
    this.recognizer?.free?.();
    this.recognizer = undefined;
    this.recognizerPromise = undefined;
  }
}

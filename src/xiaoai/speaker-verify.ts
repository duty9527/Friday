import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { cosineSimilarity, l2Normalize } from '../semantic.js';
import { normalizeUtteranceSamples } from './kws-monitor.js';

export const SPEAKER_SAMPLE_RATE = 16_000;
export const DEFAULT_SPEAKER_THRESHOLD = 0.45;
const MIN_SPEAKER_VERIFY_SAMPLES = Math.round(SPEAKER_SAMPLE_RATE * 0.25);
export const MAX_STORED_SAMPLES_PER_SPEAKER = 8;
export const SPEAKER_MODEL_FILENAME = '3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx';

export const DEFAULT_SPEAKER_MODEL_URLS = [
  'https://hf-mirror.com/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
  'https://huggingface.co/csukuangfj/speaker-embedding-models/resolve/main/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx',
] as const;

export interface XiaoaiSpeakerExtractor {
  readonly dim: number;
  extract: (samples: Float32Array, sampleRate: number) => Float32Array | undefined;
  free?: () => void;
}

export interface XiaoaiSpeakerProfile {
  id: string;
  name: string;
  role: 'owner' | 'member';
  dim: number;
  centroid: number[];
  samples: number[][];
  sampleCount: number;
  createdAt: number;
  updatedAt: number;
}

export type XiaoaiSpeakerProfileSummary = Omit<XiaoaiSpeakerProfile, 'centroid' | 'samples'>;

export interface XiaoaiSpeakerRegistryData {
  version: 1;
  enabled: boolean;
  threshold: number;
  wakePrecheck: boolean;
  profiles: XiaoaiSpeakerProfile[];
}

export interface XiaoaiSpeakerStatus {
  enabled: boolean;
  threshold: number;
  wakePrecheck: boolean;
  active: boolean;
  modelReady: boolean;
  modelPath?: string;
  profiles: XiaoaiSpeakerProfileSummary[];
}

export interface XiaoaiSpeakerMatchResult {
  matched: boolean;
  speaker?: { id: string; name: string; role: 'owner' | 'member'; score: number };
  score: number;
  threshold: number;
  reason?: 'no_profiles' | 'disabled' | 'model_missing' | 'registry_corrupt' | 'too_short' | 'extract_failed' | 'below_threshold';
}

export interface XiaoaiSpeakerUtteranceCheck extends XiaoaiSpeakerMatchResult {
  samples: Float32Array;
  trimmed: boolean;
}

export interface XiaoaiSpeakerManagerOptions {
  homeDir: string;
  speakerModelsDir?: string;
  registryPath?: string;
  extractorFactory?: (config: { modelPath: string }) => XiaoaiSpeakerExtractor;
  fetchImpl?: typeof fetch;
}

interface SherpaSpeakerEmbeddingExtractorInstance {
  readonly dim: number;
  createStream(): {
    acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
    inputFinished(): void;
  };
  isReady(stream: unknown): boolean;
  compute(stream: unknown): Float32Array;
}

const inFlightModelDownloads = new Map<string, Promise<string>>();

/** Internal helper shared with `speaker-enroll.ts`. */
export function computeCentroid(embeddings: Array<ArrayLike<number>>): Float32Array | undefined {
  if (embeddings.length === 0) return undefined;
  const dim = embeddings[0]?.length ?? 0;
  if (dim === 0) return undefined;
  const sum = new Float64Array(dim);
  let validCount = 0;
  for (const raw of embeddings) {
    const norm = l2Normalize(raw);
    if (!norm || norm.length !== dim) continue;
    for (let i = 0; i < dim; i++) {
      sum[i] = (sum[i] ?? 0) + (norm[i] ?? 0);
    }
    validCount++;
  }
  if (validCount === 0) return undefined;
  return l2Normalize(sum);
}

function resolveSpeakerModelFile(speakerModelsDir: string): string | undefined {
  if (!speakerModelsDir || !existsSync(speakerModelsDir)) return undefined;
  const preferred = join(speakerModelsDir, SPEAKER_MODEL_FILENAME);
  if (existsSync(preferred)) return preferred;
  const generic = join(speakerModelsDir, 'model.onnx');
  if (existsSync(generic)) return generic;
  try {
    const files = readdirSync(speakerModelsDir)
      .filter((name) => name.endsWith('.onnx') && !name.endsWith('.part'))
      .sort();
    return files[0] ? join(speakerModelsDir, files[0]) : undefined;
  } catch (err) {
    console.warn('[xiaoai-speaker] 扫描声纹模型目录失败:', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

const MAX_SPEAKER_MODEL_BYTES = 80 * 1024 * 1024;

export async function ensureXiaoaiSpeakerModel(options: {
  homeDir: string;
  speakerModelsDir?: string;
  fetchImpl?: typeof fetch;
  minBytes?: number;
  signal?: AbortSignal;
  onProgress?: (downloadedBytes: number, totalBytes?: number) => void;
}): Promise<string> {
  const dir = options.speakerModelsDir ?? join(options.homeDir, 'xiaoai-kws', 'speaker');
  const existing = resolveSpeakerModelFile(dir);
  if (existing) return existing;

  const inflight = inFlightModelDownloads.get(dir);
  if (inflight) return inflight;

  const task = (async () => {
    const again = resolveSpeakerModelFile(dir);
    if (again) return again;

    mkdirSync(dir, { recursive: true });
    const targetPath = join(dir, SPEAKER_MODEL_FILENAME);
    const partPath = `${targetPath}.part.${process.pid}`;
    const minBytes = options.minBytes ?? 1_000_000;
    const fetchFn = options.fetchImpl ?? globalThis.fetch;
    const customUrl = process.env.FRIDAY_SPEAKER_MODEL_URL?.trim();
    const urls = customUrl ? [customUrl, ...DEFAULT_SPEAKER_MODEL_URLS] : [...DEFAULT_SPEAKER_MODEL_URLS];

    let lastError: unknown;
    for (const url of urls) {
      rmSync(partPath, { force: true });
      try {
        const timeoutSignal = AbortSignal.timeout(90_000);
        const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
        const res = await fetchFn(url, {
          method: 'GET',
          redirect: 'follow',
          signal,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const totalHeader = Number(res.headers.get('content-length') ?? 0);
        const totalBytes = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined;
        if (totalBytes !== undefined && totalBytes > MAX_SPEAKER_MODEL_BYTES) {
          throw new Error(`模型文件体积超出上限 (${totalBytes} > ${MAX_SPEAKER_MODEL_BYTES})`);
        }

        let chunks: Buffer[] = [];
        let downloaded = 0;
        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value && value.byteLength > 0) {
                downloaded += value.byteLength;
                if (downloaded > MAX_SPEAKER_MODEL_BYTES) {
                  throw new Error(`模型下载流超出上限 (${MAX_SPEAKER_MODEL_BYTES} bytes)`);
                }
                const buf = Buffer.from(value);
                chunks.push(buf);
                options.onProgress?.(downloaded, totalBytes);
              }
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        } else {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.byteLength > MAX_SPEAKER_MODEL_BYTES) {
            throw new Error(`模型文件体积超出上限 (${buf.byteLength} > ${MAX_SPEAKER_MODEL_BYTES})`);
          }
          chunks = [buf];
          downloaded = buf.byteLength;
          options.onProgress?.(downloaded, totalBytes);
        }

        if (downloaded < minBytes) {
          throw new Error(`下载文件过小 (${downloaded} bytes < ${minBytes})`);
        }
        const firstChunk = chunks[0];
        const data = chunks.length === 1 && firstChunk ? firstChunk : Buffer.concat(chunks);
        writeFileSync(partPath, data);
        renameSync(partPath, targetPath);
        return targetPath;
      } catch (error) {
        lastError = error;
        rmSync(partPath, { force: true });
      }
    }
    throw new Error(
      `声纹模型下载失败: ${lastError instanceof Error ? lastError.message : String(lastError ?? '未知错误')}`,
    );
  })().finally(() => {
    inFlightModelDownloads.delete(dir);
  });

  inFlightModelDownloads.set(dir, task);
  return task;
}

function defaultSpeakerExtractorFactory(config: { modelPath: string }): XiaoaiSpeakerExtractor {
  const req = createRequire(import.meta.url);
  const sherpa = req('sherpa-onnx-node') as {
    SpeakerEmbeddingExtractor: new (cfg: {
      model: string;
      numThreads: number;
      provider: string;
      debug: number;
    }) => SherpaSpeakerEmbeddingExtractorInstance;
  };
  const extractor = new sherpa.SpeakerEmbeddingExtractor({
    model: config.modelPath,
    numThreads: Math.min(2, Math.max(1, cpus().length)),
    provider: 'cpu',
    debug: 0,
  });
  return {
    dim: extractor.dim,
    extract: (samples, sampleRate) => {
      if (samples.length < Math.round(sampleRate * 0.35)) return undefined;
      const normalized = normalizeUtteranceSamples(samples);
      const stream = extractor.createStream();
      stream.acceptWaveform({ samples: normalized, sampleRate });
      stream.inputFinished();
      if (!extractor.isReady(stream)) return undefined;
      const raw = extractor.compute(stream);
      return l2Normalize(raw);
    },
  };
}

function clampThreshold(value: unknown, fallback = DEFAULT_SPEAKER_THRESHOLD): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0.20, Math.min(0.90, Math.round(n * 1000) / 1000));
}

function makeSpeakerId(name: string): string {
  const normalized = name.trim().toLowerCase();
  const asciiSlug = normalized.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  return asciiSlug ? `${asciiSlug}-${hash}` : `spk-${hash}`;
}

function defaultRegistryData(): XiaoaiSpeakerRegistryData {
  return {
    version: 1,
    enabled: true,
    threshold: DEFAULT_SPEAKER_THRESHOLD,
    wakePrecheck: true,
    profiles: [],
  };
}

function scoreEmbeddingAgainstProfile(emb: Float32Array, profile: XiaoaiSpeakerProfile): number {
  if (profile.dim !== emb.length || profile.centroid.length !== emb.length) return -1;
  const centroidScore = cosineSimilarity(emb, profile.centroid);
  let maxSampleScore = -1;
  for (const sample of profile.samples) {
    if (sample.length !== emb.length) continue;
    const s = cosineSimilarity(emb, sample) * 0.98;
    if (s > maxSampleScore) maxSampleScore = s;
  }
  return Math.max(centroidScore, maxSampleScore);
}

function percentileValue(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)));
  return sorted[idx] ?? 0;
}

/**
 * Extracts the trailing speech burst from a KWS ring-buffer slice (where the wake word
 * always ends right before detection), stripping long leading room silence/noise that would
 * otherwise dilute CAM++ statistics pooling on short wake phrases like `"星期五"`.
 */
export function trimWakeSpeechWindow(
  samples: Float32Array,
  sampleRate = SPEAKER_SAMPLE_RATE,
): Float32Array {
  if (samples.length <= Math.round(sampleRate * 0.85)) {
    return samples;
  }

  const frameLen = Math.max(1, Math.round(sampleRate * 0.025));
  const numFrames = Math.ceil(samples.length / frameLen);
  const frameRms: number[] = [];
  for (let f = 0; f < numFrames; f++) {
    const start = f * frameLen;
    const end = Math.min(samples.length, start + frameLen);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const v = samples[i] ?? 0;
      sumSq += v * v;
    }
    frameRms.push(Math.sqrt(sumSq / Math.max(1, end - start)));
  }

  const p10Rms = percentileValue(frameRms, 0.10);
  const tailStart = Math.max(0, numFrames - Math.ceil(0.90 / 0.025));
  const p90Rms = percentileValue(frameRms.slice(tailStart), 0.90);

  if (p90Rms <= 1e-6 || p90Rms <= p10Rms * 1.35) {
    const keep = Math.min(samples.length, Math.round(sampleRate * 1.20));
    return samples.subarray(samples.length - keep);
  }

  const activeGate = Math.max(p10Rms * 2.2, p90Rms * 0.20);
  let endFrame = numFrames - 1;
  for (let i = numFrames - 1; i >= 0; i--) {
    if ((frameRms[i] ?? 0) >= activeGate) {
      endFrame = i;
      break;
    }
  }

  let startFrame = endFrame;
  let belowStreak = 0;
  const maxGapFrames = 9;
  const maxSpanFrames = Math.ceil(1.35 / 0.025);
  for (let i = endFrame; i >= 0; i--) {
    if (endFrame - i + 1 > maxSpanFrames) {
      break;
    }
    if ((frameRms[i] ?? 0) >= activeGate) {
      startFrame = i;
      belowStreak = 0;
    } else {
      belowStreak++;
      if (belowStreak > maxGapFrames) {
        break;
      }
    }
  }

  const endSampleInitial = Math.min(samples.length, (endFrame + 3) * frameLen);
  let startSample = Math.max(0, startFrame * frameLen - Math.round(sampleRate * 0.08));
  let endSample = endSampleInitial;
  const minKeep = Math.min(samples.length, Math.round(sampleRate * 0.65));
  if (endSample - startSample < minKeep) {
    startSample = Math.max(0, endSample - minKeep);
    if (endSample - startSample < minKeep) {
      endSample = Math.min(samples.length, startSample + minKeep);
    }
  }
  return samples.subarray(startSample, endSample);
}

/**
 * Measures the active speech duration (ms) of the trailing wake phrase inside a KWS slice,
 * stripping leading/trailing room noise so short urgent wakes can be distinguished from relaxed ones.
 */
export function measureWakeSpeechDurationMs(
  samples: Float32Array,
  sampleRate = SPEAKER_SAMPLE_RATE,
): number {
  if (samples.length === 0 || sampleRate <= 0) {
    return 0;
  }

  const frameLen = Math.max(1, Math.round(sampleRate * 0.025));
  const numFrames = Math.ceil(samples.length / frameLen);
  const frameRms: number[] = [];
  for (let f = 0; f < numFrames; f++) {
    const start = f * frameLen;
    const end = Math.min(samples.length, start + frameLen);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const v = samples[i] ?? 0;
      sumSq += v * v;
    }
    frameRms.push(Math.sqrt(sumSq / Math.max(1, end - start)));
  }

  const p10Rms = percentileValue(frameRms, 0.10);
  const tailStart = Math.max(0, numFrames - Math.ceil(1.50 / 0.025));
  const p90Rms = percentileValue(frameRms.slice(tailStart), 0.90);

  if (p90Rms <= 1e-6) {
    return 0;
  }
  if (p90Rms <= p10Rms * 1.35) {
    return p90Rms < 0.0005 ? 0 : Math.round((samples.length / sampleRate) * 1000);
  }

  const activeGate = Math.max(p10Rms * 2.2, p90Rms * 0.18);
  let endFrame = numFrames - 1;
  for (let i = numFrames - 1; i >= 0; i--) {
    if ((frameRms[i] ?? 0) >= activeGate) {
      endFrame = i;
      break;
    }
  }

  let startFrame = endFrame;
  let belowStreak = 0;
  const maxGapFrames = 10;
  const maxSpanFrames = Math.ceil(1.70 / 0.025);
  for (let i = endFrame; i >= 0; i--) {
    if (endFrame - i + 1 > maxSpanFrames) {
      break;
    }
    if ((frameRms[i] ?? 0) >= activeGate) {
      startFrame = i;
      belowStreak = 0;
    } else {
      belowStreak++;
      if (belowStreak > maxGapFrames) {
        break;
      }
    }
  }

  return Math.max(25, Math.round((((endFrame - startFrame + 1) * frameLen) / sampleRate) * 1000));
}

/**
 * Strips leading/trailing room silence from short captured utterances before speaker embedding
 * extraction so pre-roll and endpointing tail silence do not dilute short commands.
 */
export function trimShortUtteranceSilence(
  samples: Float32Array,
  sampleRate = SPEAKER_SAMPLE_RATE,
): Float32Array {
  const minSamples = sampleRate === SPEAKER_SAMPLE_RATE
    ? MIN_SPEAKER_VERIFY_SAMPLES
    : Math.round(sampleRate * 0.25);
  if (samples.length <= minSamples || sampleRate <= 0) {
    return samples;
  }

  const frameLen = Math.max(1, Math.round(sampleRate * 0.025));
  const numFrames = Math.ceil(samples.length / frameLen);
  const frameRms: number[] = [];
  for (let f = 0; f < numFrames; f++) {
    const start = f * frameLen;
    const end = Math.min(samples.length, start + frameLen);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const v = samples[i] ?? 0;
      sumSq += v * v;
    }
    frameRms.push(Math.sqrt(sumSq / Math.max(1, end - start)));
  }

  const p10Rms = percentileValue(frameRms, 0.10);
  const p90Rms = percentileValue(frameRms, 0.90);
  if (p90Rms <= 1e-6 || p90Rms <= p10Rms * 1.4) {
    return samples;
  }

  const gate = Math.max(p10Rms * 2.0, p90Rms * 0.16);
  let firstFrame = -1;
  let lastFrame = -1;
  for (let i = 0; i < numFrames; i++) {
    if ((frameRms[i] ?? 0) >= gate) {
      if (firstFrame < 0) firstFrame = i;
      lastFrame = i;
    }
  }
  if (firstFrame < 0 || lastFrame < firstFrame) {
    return samples;
  }

  const start = Math.max(0, (firstFrame - 1) * frameLen);
  const end = Math.min(samples.length, (lastFrame + 2) * frameLen);
  return end - start >= minSamples ? samples.subarray(start, end) : samples;
}

function yieldEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function buildUtteranceWindowPlan(samplesLength: number, sampleRate: number): {
  winLen: number;
  earlyLimit: number;
  starts: number[];
} {
  // Sliding-window scan to catch "user spoke first, then TV dialogue kept VAD open"
  const winLen = Math.round(sampleRate * 1.2);
  const hop = Math.round(sampleRate * 0.5);
  const earlyLimit = Math.round(sampleRate * 1.5);
  const starts: number[] = [];
  for (let start = 0; start + winLen <= samplesLength; start += hop) {
    starts.push(start);
  }
  const lastPossible = samplesLength - winLen;
  const prevLast = starts.at(-1);
  if (lastPossible > 0 && (prevLast === undefined || lastPossible - prevLast >= Math.round(hop * 0.5))) {
    starts.push(lastPossible);
  }
  return { winLen, earlyLimit, starts };
}

function isFullAndTailConsistentMatch(
  fullRes: XiaoaiSpeakerMatchResult,
  tailRes: XiaoaiSpeakerMatchResult,
): boolean {
  return Boolean(
    fullRes.matched
    && tailRes.matched
    && (!fullRes.speaker || !tailRes.speaker || fullRes.speaker.role === tailRes.speaker.role),
  );
}

function enforceLeastPrivilegeOnMixedRoles(
  fullRes: XiaoaiSpeakerMatchResult,
  tailRes: XiaoaiSpeakerMatchResult,
  result: XiaoaiSpeakerUtteranceCheck,
): XiaoaiSpeakerUtteranceCheck {
  if (
    result.matched
    && !result.trimmed
    && fullRes.matched
    && tailRes.matched
    && fullRes.speaker
    && tailRes.speaker
    && fullRes.speaker.role !== tailRes.speaker.role
  ) {
    const memberSpeaker = fullRes.speaker.role === 'member' ? fullRes.speaker : tailRes.speaker;
    if (memberSpeaker.role === 'member' && result.speaker?.role !== 'member') {
      return { ...result, speaker: memberSpeaker };
    }
  }
  return result;
}

function finalizeTrimmedUtterance(params: {
  samples: Float32Array;
  sampleRate: number;
  threshold: number;
  starts: number[];
  winLen: number;
  anchorProfile: XiaoaiSpeakerProfile;
  anchorStartIdx: number;
  bestAnchorScore: number;
  windowScores: number[];
}): XiaoaiSpeakerUtteranceCheck {
  const {
    samples,
    sampleRate,
    threshold,
    starts,
    winLen,
    anchorProfile,
    anchorStartIdx,
    bestAnchorScore,
    windowScores,
  } = params;
  const sustainFloor = Math.max(0.22, threshold - 0.05);
  const anchorStart = starts[anchorStartIdx] ?? 0;
  let lastGoodWindowEnd = anchorStart + winLen;
  let lowStreak = 0;
  for (let offset = 1; offset < windowScores.length; offset++) {
    const score = windowScores[offset] ?? 0;
    const start = starts[anchorStartIdx + offset];
    if (start === undefined) break;
    if (score >= sustainFloor) {
      lowStreak = 0;
      lastGoodWindowEnd = start + winLen;
      continue;
    }
    lowStreak++;
    const nextScore = offset + 1 < windowScores.length ? (windowScores[offset + 1] ?? 0) : 0;
    if (lowStreak === 1 && nextScore >= sustainFloor) {
      lastGoodWindowEnd = start + winLen;
      continue;
    }
    break;
  }

  const cutEnd = Math.min(samples.length, lastGoodWindowEnd + Math.round(sampleRate * 0.15));
  const trimmed = cutEnd < samples.length - Math.round(sampleRate * 0.35);
  const finalSamples = trimmed ? samples.subarray(0, cutEnd) : samples;

  return {
    matched: true,
    speaker: {
      id: anchorProfile.id,
      name: anchorProfile.name,
      role: anchorProfile.role,
      score: bestAnchorScore,
    },
    score: bestAnchorScore,
    threshold,
    samples: finalSamples,
    trimmed,
  };
}

export class XiaoaiSpeakerManager {
  readonly kwsDir: string;
  readonly speakerModelsDir: string;
  readonly registryPath: string;
  private readonly options: XiaoaiSpeakerManagerOptions;
  private extractor?: XiaoaiSpeakerExtractor;
  private extractorModelPath?: string;
  private cachedMtimeMs = -1;
  private cachedData?: XiaoaiSpeakerRegistryData;
  private registryCorrupt = false;

  constructor(options: XiaoaiSpeakerManagerOptions) {
    this.options = options;
    this.kwsDir = join(options.homeDir, 'xiaoai-kws');
    this.speakerModelsDir = options.speakerModelsDir ?? join(this.kwsDir, 'speaker');
    this.registryPath = options.registryPath ?? join(this.kwsDir, 'speakers.json');
  }

  private loadRegistry(): XiaoaiSpeakerRegistryData {
    if (!existsSync(this.registryPath)) {
      this.cachedMtimeMs = -1;
      this.registryCorrupt = false;
      this.cachedData = defaultRegistryData();
      return this.cachedData;
    }
    try {
      const st = statSync(this.registryPath);
      if (this.cachedData && st.mtimeMs === this.cachedMtimeMs) {
        return this.cachedData;
      }
      const raw = JSON.parse(readFileSync(this.registryPath, 'utf8')) as Partial<XiaoaiSpeakerRegistryData>;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Speaker registry must be a JSON object');
      }
      const profiles: XiaoaiSpeakerProfile[] = [];
      if (Array.isArray(raw.profiles)) {
        for (const item of raw.profiles) {
          if (!item || typeof item !== 'object') continue;
          const p = item as Partial<XiaoaiSpeakerProfile>;
          if (typeof p.id !== 'string' || typeof p.name !== 'string' || !Array.isArray(p.centroid)) continue;
          const centroid = l2Normalize(p.centroid);
          if (!centroid) continue;
          const samples = Array.isArray(p.samples)
            ? p.samples
                .map((s) => (Array.isArray(s) ? l2Normalize(s) : undefined))
                .filter((s): s is Float32Array => Boolean(s && s.length === centroid.length))
                .map((s) => Array.from(s))
            : [Array.from(centroid)];
          profiles.push({
            id: p.id,
            name: p.name.trim(),
            role: p.role === 'owner' ? 'owner' : 'member',
            dim: centroid.length,
            centroid: Array.from(centroid),
            samples: samples.length > 0 ? samples : [Array.from(centroid)],
            sampleCount: typeof p.sampleCount === 'number' && p.sampleCount > 0 ? p.sampleCount : Math.max(1, samples.length),
            createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
            updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : Date.now(),
          });
        }
        if (raw.profiles.length > 0 && profiles.length === 0) {
          throw new Error('All speaker profiles in registry are malformed');
        }
      }
      this.registryCorrupt = false;
      this.cachedData = {
        version: 1,
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
        threshold: clampThreshold(raw.threshold, DEFAULT_SPEAKER_THRESHOLD),
        wakePrecheck: typeof raw.wakePrecheck === 'boolean' ? raw.wakePrecheck : true,
        profiles,
      };
      this.cachedMtimeMs = st.mtimeMs;
      return this.cachedData;
    } catch (err) {
      console.warn(
        '[xiaoai-speaker] 声纹档案加载失败，进入 Fail-Closed 拦截状态:',
        err instanceof Error ? err.message : String(err),
      );
      this.cachedMtimeMs = -1;
      this.registryCorrupt = true;
      this.cachedData = defaultRegistryData();
      return this.cachedData;
    }
  }

  private saveRegistry(data: XiaoaiSpeakerRegistryData): void {
    mkdirSync(join(this.registryPath, '..'), { recursive: true });
    const tmpPath = `${this.registryPath}.tmp.${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmpPath, this.registryPath);
    try {
      this.cachedMtimeMs = statSync(this.registryPath).mtimeMs;
    } catch {
      this.cachedMtimeMs = -1;
    }
    this.registryCorrupt = false;
    this.cachedData = data;
  }

  isModelReady(): boolean {
    if (this.options.extractorFactory) return true;
    return Boolean(resolveSpeakerModelFile(this.speakerModelsDir));
  }

  async ensureModelReady(signal?: AbortSignal): Promise<string> {
    if (this.options.extractorFactory) return 'custom';
    return ensureXiaoaiSpeakerModel({
      homeDir: this.options.homeDir,
      speakerModelsDir: this.speakerModelsDir,
      fetchImpl: this.options.fetchImpl,
      signal,
    });
  }

  ensureExtractor(): XiaoaiSpeakerExtractor | undefined {
    const modelPath = this.options.extractorFactory
      ? 'custom'
      : resolveSpeakerModelFile(this.speakerModelsDir);
    if (!modelPath) return undefined;
    if (this.extractor && this.extractorModelPath === modelPath) {
      return this.extractor;
    }
    this.extractor?.free?.();
    const factory = this.options.extractorFactory ?? defaultSpeakerExtractorFactory;
    this.extractor = factory({ modelPath });
    this.extractorModelPath = modelPath;
    return this.extractor;
  }

  isVerificationActive(channelOpts?: { speakerVerify?: boolean }): boolean {
    if (channelOpts?.speakerVerify === false) return false;
    const data = this.loadRegistry();
    return Boolean(this.registryCorrupt || (data.enabled && data.profiles.length > 0));
  }

  getStatus(): XiaoaiSpeakerStatus {
    const data = this.loadRegistry();
    const modelPath = resolveSpeakerModelFile(this.speakerModelsDir);
    return {
      enabled: data.enabled,
      threshold: data.threshold,
      wakePrecheck: data.wakePrecheck,
      active: Boolean(this.registryCorrupt || (data.enabled && data.profiles.length > 0)),
      modelReady: Boolean(this.options.extractorFactory || modelPath),
      ...(modelPath ? { modelPath } : {}),
      profiles: data.profiles.map(({ centroid: _c, samples: _s, ...meta }) => meta),
    };
  }

  findProfile(idOrName: string): XiaoaiSpeakerProfile | undefined {
    const needle = idOrName.trim().toLowerCase();
    if (!needle) return undefined;
    const data = this.loadRegistry();
    return data.profiles.find((p) => p.id.toLowerCase() === needle || p.name.toLowerCase() === needle);
  }

  listProfiles(): XiaoaiSpeakerProfileSummary[] {
    return this.getStatus().profiles;
  }

  configure(patch: {
    enabled?: boolean;
    threshold?: number;
    wakePrecheck?: boolean;
    rename?: { target: string; name: string };
    role?: { target: string; role: 'owner' | 'member' };
  }): XiaoaiSpeakerStatus {
    const data = this.loadRegistry();
    const next: XiaoaiSpeakerRegistryData = {
      ...data,
      profiles: data.profiles.map((p) => ({ ...p, centroid: [...p.centroid], samples: p.samples.map((s) => [...s]) })),
    };

    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (patch.threshold !== undefined) next.threshold = clampThreshold(patch.threshold, next.threshold);
    if (patch.wakePrecheck !== undefined) next.wakePrecheck = Boolean(patch.wakePrecheck);

    if (patch.rename) {
      const targetNeedle = patch.rename.target.trim().toLowerCase();
      const newName = patch.rename.name.trim().slice(0, 40);
      if (!newName) throw new Error('说话人名称不能为空');
      const idx = next.profiles.findIndex((p) => p.id.toLowerCase() === targetNeedle || p.name.toLowerCase() === targetNeedle);
      const targetProfile = idx >= 0 ? next.profiles[idx] : undefined;
      if (!targetProfile) throw new Error(`未找到说话人 "${patch.rename.target}"`);
      const dup = next.profiles.find((p, i) => i !== idx && p.name.toLowerCase() === newName.toLowerCase());
      if (dup) throw new Error(`已存在名为 "${newName}" 的声纹档案`);
      targetProfile.name = newName;
      targetProfile.updatedAt = Date.now();
    }

    if (patch.role) {
      const targetNeedle = patch.role.target.trim().toLowerCase();
      const idx = next.profiles.findIndex((p) => p.id.toLowerCase() === targetNeedle || p.name.toLowerCase() === targetNeedle);
      const targetProfile = idx >= 0 ? next.profiles[idx] : undefined;
      if (!targetProfile) throw new Error(`未找到说话人 "${patch.role.target}"`);
      targetProfile.role = patch.role.role;
      targetProfile.updatedAt = Date.now();
    }

    this.saveRegistry(next);
    return this.getStatus();
  }

  enrollEmbeddings(input: {
    name: string;
    role?: 'owner' | 'member';
    mode?: 'replace' | 'append';
    embeddings: Float32Array[];
  }): XiaoaiSpeakerProfile {
    const name = input.name.trim().slice(0, 40);
    if (!name) throw new Error('说话人名称不能为空');

    const normalized = input.embeddings
      .map((e) => l2Normalize(e))
      .filter((e): e is Float32Array => Boolean(e));
    const first = normalized[0];
    if (!first) {
      throw new Error('缺少有效的声纹向量样本');
    }
    const dim = first.length;
    const sameDim = normalized.filter((e) => e.length === dim);
    if (sameDim.length === 0) {
      throw new Error('声纹向量维度无效');
    }

    const data = this.loadRegistry();
    const now = Date.now();
    const lowerName = name.toLowerCase();
    const existingIdx = data.profiles.findIndex(
      (p) => p.name.toLowerCase() === lowerName || p.id.toLowerCase() === lowerName,
    );
    const existing = existingIdx >= 0 ? data.profiles[existingIdx] : undefined;

    const role: 'owner' | 'member' = input.role
      ?? existing?.role
      ?? (data.profiles.length === 0 ? 'owner' : 'member');

    let combined: Float32Array[];
    let sampleCount: number;
    if (input.mode === 'append' && existing && existing.dim === dim) {
      const prevSamples = existing.samples
        .map((s) => l2Normalize(s))
        .filter((s): s is Float32Array => Boolean(s && s.length === dim));
      combined = [...prevSamples, ...sameDim].slice(-MAX_STORED_SAMPLES_PER_SPEAKER);
      sampleCount = existing.sampleCount + sameDim.length;
    } else {
      combined = sameDim.slice(-MAX_STORED_SAMPLES_PER_SPEAKER);
      sampleCount = sameDim.length;
    }

    const centroid = computeCentroid(combined);
    if (!centroid) throw new Error('计算声纹中心向量失败');

    const saved: XiaoaiSpeakerProfile = {
      id: existing?.id ?? makeSpeakerId(name),
      name,
      role,
      dim,
      centroid: Array.from(centroid),
      samples: combined.map((v) => Array.from(v)),
      sampleCount,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const nextProfiles = [...data.profiles];
    if (existingIdx >= 0) {
      nextProfiles[existingIdx] = saved;
    } else {
      nextProfiles.push(saved);
    }

    this.saveRegistry({
      ...data,
      enabled: true,
      profiles: nextProfiles,
    });
    return saved;
  }

  removeSpeaker(idOrName: string): { removed: boolean; profile?: XiaoaiSpeakerProfile; remaining: number } {
    const needle = idOrName.trim().toLowerCase();
    if (!needle) return { removed: false, remaining: this.loadRegistry().profiles.length };
    const data = this.loadRegistry();
    const idx = data.profiles.findIndex(
      (p) => p.id.toLowerCase() === needle || p.name.toLowerCase() === needle,
    );
    const removedProfile = idx >= 0 ? data.profiles[idx] : undefined;
    if (!removedProfile) {
      return { removed: false, remaining: data.profiles.length };
    }
    const remainingProfiles = data.profiles
      .filter((_, i) => i !== idx)
      .map((p) => ({ ...p, centroid: [...p.centroid], samples: p.samples.map((s) => [...s]) }));

    if (remainingProfiles.length > 0 && !remainingProfiles.some((p) => p.role === 'owner')) {
      let oldest = remainingProfiles[0];
      if (oldest) {
        for (const p of remainingProfiles) {
          if (p.createdAt < oldest.createdAt) oldest = p;
        }
        oldest.role = 'owner';
        oldest.updatedAt = Date.now();
      }
    }

    this.saveRegistry({
      ...data,
      profiles: remainingProfiles,
    });
    return {
      removed: true,
      profile: removedProfile,
      remaining: remainingProfiles.length,
    };
  }

  clearSpeakers(): { cleared: number } {
    const data = this.loadRegistry();
    const cleared = data.profiles.length;
    if (cleared > 0) {
      this.saveRegistry({
        ...data,
        profiles: [],
      });
    }
    return { cleared };
  }

  extractEmbedding(samples: Float32Array, sampleRate = SPEAKER_SAMPLE_RATE): Float32Array | undefined {
    const extractor = this.ensureExtractor();
    if (!extractor) return undefined;
    try {
      return extractor.extract(samples, sampleRate);
    } catch (err) {
      console.warn('[xiaoai-speaker] 声纹特征提取异常:', err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  matchSamples(
    samples: Float32Array,
    sampleRate = SPEAKER_SAMPLE_RATE,
    opts?: {
      speakerVerify?: boolean;
      thresholdOverride?: number;
      allowShortPass?: boolean;
      ignoreDisabled?: boolean;
    },
  ): XiaoaiSpeakerMatchResult {
    const data = this.loadRegistry();
    const threshold = clampThreshold(opts?.thresholdOverride ?? data.threshold, data.threshold);

    if (opts?.speakerVerify === false) {
      return { matched: true, score: 1, threshold, reason: 'disabled' };
    }
    if (this.registryCorrupt) {
      return { matched: false, score: 0, threshold, reason: 'registry_corrupt' };
    }
    if (!opts?.ignoreDisabled && !data.enabled) {
      return { matched: true, score: 1, threshold, reason: 'disabled' };
    }
    if (data.profiles.length === 0) {
      return { matched: !opts?.ignoreDisabled, score: opts?.ignoreDisabled ? 0 : 1, threshold, reason: 'no_profiles' };
    }
    if (!this.isModelReady()) {
      return { matched: false, score: 0, threshold, reason: 'model_missing' };
    }
    const minSamples = sampleRate === SPEAKER_SAMPLE_RATE
      ? MIN_SPEAKER_VERIFY_SAMPLES
      : Math.round(sampleRate * 0.25);
    if (samples.length < minSamples) {
      return {
        matched: Boolean(opts?.allowShortPass),
        score: opts?.allowShortPass ? 1 : 0,
        threshold,
        reason: 'too_short',
      };
    }

    const emb = this.extractEmbedding(samples, sampleRate);
    if (!emb) {
      return { matched: false, score: 0, threshold, reason: 'extract_failed' };
    }

    let bestProfile: XiaoaiSpeakerProfile | undefined;
    let bestScore = -1;
    for (const profile of data.profiles) {
      const score = scoreEmbeddingAgainstProfile(emb, profile);
      if (score > bestScore) {
        bestScore = score;
        bestProfile = profile;
      }
    }

    const safeScore = bestScore > -1 ? bestScore : 0;
    if (bestProfile && safeScore >= threshold) {
      return {
        matched: true,
        speaker: {
          id: bestProfile.id,
          name: bestProfile.name,
          role: bestProfile.role,
          score: safeScore,
        },
        score: safeScore,
        threshold,
      };
    }
    return {
      matched: false,
      score: safeScore,
      threshold,
      reason: 'below_threshold',
    };
  }

  verifyWakeSlice(
    samples: Float32Array,
    sampleRate: number,
    keyword: string,
    opts?: { speakerVerify?: boolean; thresholdOverride?: number },
  ): XiaoaiSpeakerMatchResult {
    const data = this.loadRegistry();
    const baseThreshold = clampThreshold(opts?.thresholdOverride ?? data.threshold, data.threshold);
    if (opts?.speakerVerify === false) {
      return { matched: true, score: 1, threshold: baseThreshold, reason: 'disabled' };
    }
    if (this.registryCorrupt) {
      return { matched: false, score: 0, threshold: baseThreshold, reason: 'registry_corrupt' };
    }
    if (!this.isVerificationActive(opts) || !data.wakePrecheck) {
      return { matched: true, score: 1, threshold: baseThreshold, reason: 'disabled' };
    }
    if (!this.isModelReady()) {
      return { matched: false, score: 0, threshold: baseThreshold, reason: 'model_missing' };
    }
    if (samples.length < Math.round(sampleRate * 0.45)) {
      return { matched: true, score: 1, threshold: baseThreshold, reason: 'too_short' };
    }
    const wakeAudio = trimWakeSpeechWindow(samples, sampleRate);
    const isBareWake = keyword.trim() === '星期五';
    const isUltraShortWake = wakeAudio.length <= Math.round(sampleRate * 0.95);
    const wakeThreshold = isBareWake
      ? Math.max(0.26, baseThreshold - (isUltraShortWake ? 0.17 : 0.14))
      : Math.max(0.24, baseThreshold - 0.13);
    return this.matchSamples(wakeAudio, sampleRate, {
      speakerVerify: opts?.speakerVerify,
      thresholdOverride: wakeThreshold,
      allowShortPass: true,
    });
  }

  private verifyShortOrInactiveUtterance(
    threshold: number,
    samples: Float32Array,
    sampleRate: number,
    opts?: { speakerVerify?: boolean; thresholdOverride?: number },
  ): XiaoaiSpeakerUtteranceCheck | undefined {
    if (!this.isVerificationActive(opts)) {
      return { matched: true, score: 1, threshold, samples, trimmed: false };
    }

    const longClipThreshold = Math.round(sampleRate * 2.2);
    if (samples.length <= longClipThreshold) {
      // Short wake+command clips ("星期五，关闭空气炸锅") carry little speech, so genuine
      // members score a bit lower than on long clips. Relax slightly unless the caller
      // explicitly pinned a threshold; non-members (~0.03-0.25) are still rejected.
      const isShortClip = samples.length <= Math.round(sampleRate * 2.0);
      const effectiveThreshold = isShortClip && opts?.thresholdOverride === undefined
        ? Math.max(0.32, threshold - 0.04)
        : threshold;
      const evalSamples = isShortClip ? trimShortUtteranceSilence(samples, sampleRate) : samples;
      const res = this.matchSamples(evalSamples, sampleRate, {
        speakerVerify: opts?.speakerVerify,
        thresholdOverride: effectiveThreshold,
      });
      return { ...res, samples, trimmed: false };
    }
    return undefined;
  }

  private matchTailSlice(
    samples: Float32Array,
    sampleRate: number,
    threshold: number,
    opts?: { speakerVerify?: boolean },
  ): XiaoaiSpeakerMatchResult {
    const tailLen = Math.round(sampleRate * 1.2);
    const tailSlice = samples.subarray(Math.max(0, samples.length - tailLen));
    const tailThreshold = Math.max(0.22, threshold - 0.06);
    return this.matchSamples(tailSlice, sampleRate, {
      speakerVerify: opts?.speakerVerify,
      thresholdOverride: tailThreshold,
    });
  }

  verifyAndTrimUtterance(
    samples: Float32Array,
    sampleRate = SPEAKER_SAMPLE_RATE,
    opts?: { speakerVerify?: boolean; thresholdOverride?: number },
  ): XiaoaiSpeakerUtteranceCheck {
    const data = this.loadRegistry();
    const threshold = clampThreshold(opts?.thresholdOverride ?? data.threshold, data.threshold);
    const quick = this.verifyShortOrInactiveUtterance(threshold, samples, sampleRate, opts);
    if (quick) return quick;

    const fullRes = this.matchSamples(samples, sampleRate, {
      speakerVerify: opts?.speakerVerify,
      thresholdOverride: threshold,
    });
    const tailRes = this.matchTailSlice(samples, sampleRate, threshold, opts);
    if (isFullAndTailConsistentMatch(fullRes, tailRes)) {
      return { ...fullRes, samples, trimmed: false };
    }

    const { winLen, earlyLimit, starts } = buildUtteranceWindowPlan(samples.length, sampleRate);
    let anchorProfile: XiaoaiSpeakerProfile | undefined;
    let anchorStartIdx = -1;
    let bestAnchorScore = 0;

    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      if (start === undefined) continue;
      if (start > earlyLimit) break;
      const slice = samples.subarray(start, start + winLen);
      const winMatch = this.matchSamples(slice, sampleRate, {
        speakerVerify: opts?.speakerVerify,
        thresholdOverride: threshold,
      });
      if (winMatch.matched && winMatch.speaker) {
        const matchedSpeakerId = winMatch.speaker.id;
        const found = data.profiles.find((p) => p.id === matchedSpeakerId);
        if (found) {
          anchorProfile = found;
          anchorStartIdx = i;
          bestAnchorScore = winMatch.score;
          break;
        }
      }
    }

    if (!anchorProfile || anchorStartIdx < 0) {
      return {
        ...fullRes,
        speaker: undefined,
        matched: false,
        samples,
        trimmed: false,
        reason: fullRes.reason ?? 'below_threshold',
      };
    }

    const sustainFloor = Math.max(0.22, threshold - 0.05);
    const windowScores: number[] = [bestAnchorScore];
    let lowStreak = 0;
    for (let i = anchorStartIdx + 1; i < starts.length; i++) {
      const start = starts[i];
      if (start === undefined) continue;
      const slice = samples.subarray(start, start + winLen);
      const emb = this.extractEmbedding(slice, sampleRate);
      const score = emb ? scoreEmbeddingAgainstProfile(emb, anchorProfile) : 0;
      if (score > bestAnchorScore) bestAnchorScore = score;
      windowScores.push(score);
      if (score < sustainFloor) {
        lowStreak++;
        if (lowStreak >= 2) break;
      } else {
        lowStreak = 0;
      }
    }

    return enforceLeastPrivilegeOnMixedRoles(
      fullRes,
      tailRes,
      finalizeTrimmedUtterance({
        samples,
        sampleRate,
        threshold,
        starts,
        winLen,
        anchorProfile,
        anchorStartIdx,
        bestAnchorScore,
        windowScores,
      }),
    );
  }

  async verifyAndTrimUtteranceAsync(
    samples: Float32Array,
    sampleRate = SPEAKER_SAMPLE_RATE,
    opts?: { speakerVerify?: boolean; thresholdOverride?: number },
  ): Promise<XiaoaiSpeakerUtteranceCheck> {
    const data = this.loadRegistry();
    const threshold = clampThreshold(opts?.thresholdOverride ?? data.threshold, data.threshold);
    const quick = this.verifyShortOrInactiveUtterance(threshold, samples, sampleRate, opts);
    if (quick) return quick;

    await yieldEventLoop();
    const fullRes = this.matchSamples(samples, sampleRate, {
      speakerVerify: opts?.speakerVerify,
      thresholdOverride: threshold,
    });
    await yieldEventLoop();
    const tailRes = this.matchTailSlice(samples, sampleRate, threshold, opts);
    if (isFullAndTailConsistentMatch(fullRes, tailRes)) {
      await yieldEventLoop();
      return { ...fullRes, samples, trimmed: false };
    }

    const { winLen, earlyLimit, starts } = buildUtteranceWindowPlan(samples.length, sampleRate);
    let anchorProfile: XiaoaiSpeakerProfile | undefined;
    let anchorStartIdx = -1;
    let bestAnchorScore = 0;

    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      if (start === undefined) continue;
      if (start > earlyLimit) break;
      await yieldEventLoop();
      const slice = samples.subarray(start, start + winLen);
      const winMatch = this.matchSamples(slice, sampleRate, {
        speakerVerify: opts?.speakerVerify,
        thresholdOverride: threshold,
      });
      if (winMatch.matched && winMatch.speaker) {
        const matchedSpeakerId = winMatch.speaker.id;
        const found = data.profiles.find((p) => p.id === matchedSpeakerId);
        if (found) {
          anchorProfile = found;
          anchorStartIdx = i;
          bestAnchorScore = winMatch.score;
          break;
        }
      }
    }

    if (!anchorProfile || anchorStartIdx < 0) {
      await yieldEventLoop();
      return {
        ...fullRes,
        speaker: undefined,
        matched: false,
        samples,
        trimmed: false,
        reason: fullRes.reason ?? 'below_threshold',
      };
    }

    const sustainFloor = Math.max(0.22, threshold - 0.05);
    const windowScores: number[] = [bestAnchorScore];
    let lowStreak = 0;
    for (let i = anchorStartIdx + 1; i < starts.length; i++) {
      const start = starts[i];
      if (start === undefined) continue;
      await yieldEventLoop();
      const slice = samples.subarray(start, start + winLen);
      const emb = this.extractEmbedding(slice, sampleRate);
      const score = emb ? scoreEmbeddingAgainstProfile(emb, anchorProfile) : 0;
      if (score > bestAnchorScore) bestAnchorScore = score;
      windowScores.push(score);
      if (score < sustainFloor) {
        lowStreak++;
        if (lowStreak >= 2) break;
      } else {
        lowStreak = 0;
      }
    }

    await yieldEventLoop();
    return enforceLeastPrivilegeOnMixedRoles(
      fullRes,
      tailRes,
      finalizeTrimmedUtterance({
        samples,
        sampleRate,
        threshold,
        starts,
        winLen,
        anchorProfile,
        anchorStartIdx,
        bestAnchorScore,
        windowScores,
      }),
    );
  }

  close(): void {
    this.extractor?.free?.();
    this.extractor = undefined;
    this.extractorModelPath = undefined;
  }
}

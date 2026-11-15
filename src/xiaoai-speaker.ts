import { createHash, randomUUID } from 'node:crypto';
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
import { join } from 'node:path';
import { normalizeUtteranceSamples } from './xiaoai-kws.js';

export const SPEAKER_SAMPLE_RATE = 16_000;
export const DEFAULT_SPEAKER_THRESHOLD = 0.45;
export const MIN_SPEAKER_VERIFY_SAMPLES = Math.round(SPEAKER_SAMPLE_RATE * 0.25);
export const DEFAULT_MIN_ENROLL_DURATION_MS = 900;
export const DEFAULT_ENROLL_UTTERANCES = 3;
export const APPEND_ENROLL_UTTERANCES = 2;
export const MAX_STORED_SAMPLES_PER_SPEAKER = 8;
export const DEFAULT_ENROLL_STEP_TTL_MS = 45_000;
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
  reason?: 'no_profiles' | 'disabled' | 'model_missing' | 'too_short' | 'extract_failed' | 'below_threshold';
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

export type SpeakerVoiceCommand =
  | { kind: 'enroll'; targetName?: string; mode: 'replace' | 'append' }
  | { kind: 'whoami' }
  | { kind: 'list' }
  | { kind: 'remove'; targetName?: string }
  | { kind: 'clear' }
  | { kind: 'toggle'; enabled: boolean };

export interface XiaoaiEnrollSessionSnapshot {
  sessionId: string;
  channelId: string;
  targetId: string;
  speakerName: string;
  role: 'owner' | 'member';
  mode: 'replace' | 'append';
  status: 'preparing_model' | 'collecting' | 'completed' | 'cancelled' | 'failed';
  step: number;
  totalSteps: number;
  message: string;
  error?: string;
  profileId?: string;
  updatedAt: number;
}

interface ActiveEnrollSession {
  sessionId: string;
  channelId: string;
  targetId: string;
  speakerName: string;
  role: 'owner' | 'member';
  mode: 'replace' | 'append';
  status: 'preparing_model' | 'collecting';
  step: number;
  totalSteps: number;
  message: string;
  collectedEmbeddings: Float32Array[];
  retryCount: number;
  emptyRetryCount: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

const inFlightModelDownloads = new Map<string, Promise<string>>();

export function l2Normalize(vec: ArrayLike<number>): Float32Array | undefined {
  if (!vec || vec.length === 0) return undefined;
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = Number(vec[i]);
    if (!Number.isFinite(v)) return undefined;
    normSq += v * v;
  }
  const norm = Math.sqrt(normSq);
  if (!Number.isFinite(norm) || norm <= 1e-8) return undefined;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = Number(vec[i]) / norm;
  }
  return out;
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normASq = 0;
  let normBSq = 0;
  for (let i = 0; i < a.length; i++) {
    const va = Number(a[i]);
    const vb = Number(b[i]);
    dot += va * vb;
    normASq += va * va;
    normBSq += vb * vb;
  }
  const denom = Math.sqrt(normASq) * Math.sqrt(normBSq);
  if (!Number.isFinite(denom) || denom <= 1e-8) return 0;
  const sim = dot / denom;
  return Number.isFinite(sim) ? Math.max(-1, Math.min(1, sim)) : 0;
}

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
      sum[i] = (sum[i] ?? 0) + norm[i]!;
    }
    validCount++;
  }
  if (validCount === 0) return undefined;
  return l2Normalize(sum);
}

export function resolveSpeakerModelFile(speakerModelsDir: string): string | undefined {
  if (!speakerModelsDir || !existsSync(speakerModelsDir)) return undefined;
  const preferred = join(speakerModelsDir, SPEAKER_MODEL_FILENAME);
  if (existsSync(preferred)) return preferred;
  const generic = join(speakerModelsDir, 'model.onnx');
  if (existsSync(generic)) return generic;
  try {
    const files = readdirSync(speakerModelsDir)
      .filter(name => name.endsWith('.onnx') && !name.endsWith('.part'))
      .sort();
    return files[0] ? join(speakerModelsDir, files[0]) : undefined;
  } catch {
    return undefined;
  }
}

export async function ensureXiaoaiSpeakerModel(options: {
  homeDir: string;
  speakerModelsDir?: string;
  fetchImpl?: typeof fetch;
  minBytes?: number;
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
        const res = await fetchFn(url, {
          method: 'GET',
          redirect: 'follow',
          signal: AbortSignal.timeout(90_000),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const totalHeader = Number(res.headers.get('content-length') ?? 0);
        const totalBytes = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined;

        let chunks: Buffer[] = [];
        let downloaded = 0;
        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              const buf = Buffer.from(value);
              chunks.push(buf);
              downloaded += buf.byteLength;
              options.onProgress?.(downloaded, totalBytes);
            }
          }
        } else {
          const buf = Buffer.from(await res.arrayBuffer());
          chunks = [buf];
          downloaded = buf.byteLength;
          options.onProgress?.(downloaded, totalBytes);
        }

        if (downloaded < minBytes) {
          throw new Error(`下载文件过小 (${downloaded} bytes < ${minBytes})`);
        }
        const data = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
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

interface SherpaSpeakerEmbeddingExtractorInstance {
  readonly dim: number;
  createStream(): {
    acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void;
    inputFinished(): void;
  };
  isReady(stream: unknown): boolean;
  compute(stream: unknown): Float32Array;
}

export function defaultSpeakerExtractorFactory(config: { modelPath: string }): XiaoaiSpeakerExtractor {
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
    numThreads: 2,
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
  return sorted[idx]!;
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
      const v = samples[i]!;
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
    if (frameRms[i]! >= activeGate) {
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
    if (frameRms[i]! >= activeGate) {
      startFrame = i;
      belowStreak = 0;
    } else {
      belowStreak++;
      if (belowStreak > maxGapFrames) {
        break;
      }
    }
  }

  let endSample = Math.min(samples.length, (endFrame + 3) * frameLen);
  let startSample = Math.max(0, startFrame * frameLen - Math.round(sampleRate * 0.08));
  const minKeep = Math.min(samples.length, Math.round(sampleRate * 0.65));
  if (endSample - startSample < minKeep) {
    startSample = Math.max(0, endSample - minKeep);
    if (endSample - startSample < minKeep) {
      endSample = Math.min(samples.length, startSample + minKeep);
    }
  }
  return samples.subarray(startSample, endSample);
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

  constructor(options: XiaoaiSpeakerManagerOptions) {
    this.options = options;
    this.kwsDir = join(options.homeDir, 'xiaoai-kws');
    this.speakerModelsDir = options.speakerModelsDir ?? join(this.kwsDir, 'speaker');
    this.registryPath = options.registryPath ?? join(this.kwsDir, 'speakers.json');
  }

  private loadRegistry(): XiaoaiSpeakerRegistryData {
    if (!existsSync(this.registryPath)) {
      this.cachedMtimeMs = -1;
      this.cachedData = defaultRegistryData();
      return this.cachedData;
    }
    try {
      const st = statSync(this.registryPath);
      if (this.cachedData && st.mtimeMs === this.cachedMtimeMs) {
        return this.cachedData;
      }
      const raw = JSON.parse(readFileSync(this.registryPath, 'utf8')) as Partial<XiaoaiSpeakerRegistryData>;
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
                .map(s => (Array.isArray(s) ? l2Normalize(s) : undefined))
                .filter((s): s is Float32Array => Boolean(s && s.length === centroid.length))
                .map(s => Array.from(s))
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
      }
      this.cachedData = {
        version: 1,
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
        threshold: clampThreshold(raw.threshold, DEFAULT_SPEAKER_THRESHOLD),
        wakePrecheck: typeof raw.wakePrecheck === 'boolean' ? raw.wakePrecheck : true,
        profiles,
      };
      this.cachedMtimeMs = st.mtimeMs;
      return this.cachedData;
    } catch {
      this.cachedMtimeMs = -1;
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
    this.cachedData = data;
  }

  isModelReady(): boolean {
    if (this.options.extractorFactory) return true;
    return Boolean(resolveSpeakerModelFile(this.speakerModelsDir));
  }

  async ensureModelReady(): Promise<string> {
    if (this.options.extractorFactory) return 'custom';
    return ensureXiaoaiSpeakerModel({
      homeDir: this.options.homeDir,
      speakerModelsDir: this.speakerModelsDir,
      fetchImpl: this.options.fetchImpl,
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
    return Boolean(data.enabled && data.profiles.length > 0 && this.isModelReady());
  }

  getStatus(): XiaoaiSpeakerStatus {
    const data = this.loadRegistry();
    const modelPath = resolveSpeakerModelFile(this.speakerModelsDir);
    return {
      enabled: data.enabled,
      threshold: data.threshold,
      wakePrecheck: data.wakePrecheck,
      active: Boolean(data.enabled && data.profiles.length > 0 && (this.options.extractorFactory || modelPath)),
      modelReady: Boolean(this.options.extractorFactory || modelPath),
      ...(modelPath ? { modelPath } : {}),
      profiles: data.profiles.map(({ centroid: _c, samples: _s, ...meta }) => meta),
    };
  }

  findProfile(idOrName: string): XiaoaiSpeakerProfile | undefined {
    const needle = idOrName.trim().toLowerCase();
    if (!needle) return undefined;
    const data = this.loadRegistry();
    return data.profiles.find(p => p.id.toLowerCase() === needle || p.name.toLowerCase() === needle);
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
      profiles: data.profiles.map(p => ({ ...p, centroid: [...p.centroid], samples: p.samples.map(s => [...s]) })),
    };

    if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
    if (patch.threshold !== undefined) next.threshold = clampThreshold(patch.threshold, next.threshold);
    if (patch.wakePrecheck !== undefined) next.wakePrecheck = Boolean(patch.wakePrecheck);

    if (patch.rename) {
      const targetNeedle = patch.rename.target.trim().toLowerCase();
      const newName = patch.rename.name.trim().slice(0, 40);
      if (!newName) throw new Error('说话人名称不能为空');
      const idx = next.profiles.findIndex(p => p.id.toLowerCase() === targetNeedle || p.name.toLowerCase() === targetNeedle);
      if (idx < 0) throw new Error(`未找到说话人 "${patch.rename.target}"`);
      const dup = next.profiles.find((p, i) => i !== idx && p.name.toLowerCase() === newName.toLowerCase());
      if (dup) throw new Error(`已存在名为 "${newName}" 的声纹档案`);
      next.profiles[idx]!.name = newName;
      next.profiles[idx]!.updatedAt = Date.now();
    }

    if (patch.role) {
      const targetNeedle = patch.role.target.trim().toLowerCase();
      const idx = next.profiles.findIndex(p => p.id.toLowerCase() === targetNeedle || p.name.toLowerCase() === targetNeedle);
      if (idx < 0) throw new Error(`未找到说话人 "${patch.role.target}"`);
      next.profiles[idx]!.role = patch.role.role;
      next.profiles[idx]!.updatedAt = Date.now();
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
      .map(e => l2Normalize(e))
      .filter((e): e is Float32Array => Boolean(e));
    if (normalized.length === 0) {
      throw new Error('缺少有效的声纹向量样本');
    }
    const dim = normalized[0]!.length;
    const sameDim = normalized.filter(e => e.length === dim);
    if (sameDim.length === 0) {
      throw new Error('声纹向量维度无效');
    }

    const data = this.loadRegistry();
    const now = Date.now();
    const lowerName = name.toLowerCase();
    const existingIdx = data.profiles.findIndex(
      p => p.name.toLowerCase() === lowerName || p.id.toLowerCase() === lowerName,
    );
    const existing = existingIdx >= 0 ? data.profiles[existingIdx] : undefined;

    const role: 'owner' | 'member' = input.role
      ?? existing?.role
      ?? (data.profiles.length === 0 ? 'owner' : 'member');

    let combined: Float32Array[];
    let sampleCount: number;
    if (input.mode === 'append' && existing && existing.dim === dim) {
      const prevSamples = existing.samples
        .map(s => l2Normalize(s))
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
      samples: combined.map(v => Array.from(v)),
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
      p => p.id.toLowerCase() === needle || p.name.toLowerCase() === needle,
    );
    if (idx < 0) {
      return { removed: false, remaining: data.profiles.length };
    }
    const removedProfile = data.profiles[idx]!;
    const remainingProfiles = data.profiles
      .filter((_, i) => i !== idx)
      .map(p => ({ ...p, centroid: [...p.centroid], samples: p.samples.map(s => [...s]) }));

    if (remainingProfiles.length > 0 && !remainingProfiles.some(p => p.role === 'owner')) {
      let oldest = remainingProfiles[0]!;
      for (const p of remainingProfiles) {
        if (p.createdAt < oldest.createdAt) oldest = p;
      }
      oldest.role = 'owner';
      oldest.updatedAt = Date.now();
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
    } catch {
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
    if (!opts?.ignoreDisabled && !data.enabled) {
      return { matched: true, score: 1, threshold, reason: 'disabled' };
    }
    if (data.profiles.length === 0) {
      return { matched: !opts?.ignoreDisabled, score: opts?.ignoreDisabled ? 0 : 1, threshold, reason: 'no_profiles' };
    }
    if (!this.isModelReady()) {
      return { matched: !opts?.ignoreDisabled, score: opts?.ignoreDisabled ? 0 : 1, threshold, reason: 'model_missing' };
    }
    const minSamples = Math.round(sampleRate * 0.25);
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
      ...(bestProfile
        ? { speaker: { id: bestProfile.id, name: bestProfile.name, role: bestProfile.role, score: safeScore } }
        : {}),
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
    if (!this.isVerificationActive(opts) || !data.wakePrecheck) {
      return { matched: true, score: 1, threshold: baseThreshold, reason: 'disabled' };
    }
    if (samples.length < Math.round(sampleRate * 0.45)) {
      return { matched: true, score: 1, threshold: baseThreshold, reason: 'too_short' };
    }
    const wakeAudio = trimWakeSpeechWindow(samples, sampleRate);
    const isBareWake = keyword.trim() === '星期五';
    const wakeThreshold = isBareWake
      ? Math.max(0.26, baseThreshold - 0.13)
      : Math.max(0.24, baseThreshold - 0.12);
    return this.matchSamples(wakeAudio, sampleRate, {
      speakerVerify: opts?.speakerVerify,
      thresholdOverride: wakeThreshold,
      allowShortPass: true,
    });
  }

  verifyAndTrimUtterance(
    samples: Float32Array,
    sampleRate = SPEAKER_SAMPLE_RATE,
    opts?: { speakerVerify?: boolean; thresholdOverride?: number },
  ): XiaoaiSpeakerUtteranceCheck {
    const data = this.loadRegistry();
    const threshold = clampThreshold(opts?.thresholdOverride ?? data.threshold, data.threshold);
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
      const res = this.matchSamples(samples, sampleRate, {
        speakerVerify: opts?.speakerVerify,
        thresholdOverride: effectiveThreshold,
      });
      return { ...res, samples, trimmed: false };
    }

    const fullRes = this.matchSamples(samples, sampleRate, {
      speakerVerify: opts?.speakerVerify,
      thresholdOverride: threshold,
    });
    const tailLen = Math.round(sampleRate * 1.2);
    const tailSlice = samples.subarray(Math.max(0, samples.length - tailLen));
    const tailThreshold = Math.max(0.22, threshold - 0.06);
    const tailRes = this.matchSamples(tailSlice, sampleRate, {
      speakerVerify: opts?.speakerVerify,
      thresholdOverride: tailThreshold,
    });

    if (
      fullRes.matched
      && tailRes.matched
      && (!fullRes.speaker || !tailRes.speaker || fullRes.speaker.id === tailRes.speaker.id)
    ) {
      return { ...fullRes, samples, trimmed: false };
    }

    // Sliding-window scan to catch "user spoke first, then TV dialogue kept VAD open"
    const winLen = Math.round(sampleRate * 1.2);
    const hop = Math.round(sampleRate * 0.5);
    const earlyLimit = Math.round(sampleRate * 1.5);
    const starts: number[] = [];
    for (let start = 0; start + winLen <= samples.length; start += hop) {
      starts.push(start);
    }
    const lastPossible = samples.length - winLen;
    if (lastPossible > 0 && (starts.length === 0 || lastPossible - starts.at(-1)! >= Math.round(hop * 0.5))) {
      starts.push(lastPossible);
    }

    let anchorProfile: XiaoaiSpeakerProfile | undefined;
    let anchorStartIdx = -1;
    let bestAnchorScore = 0;

    for (let i = 0; i < starts.length; i++) {
      const start = starts[i]!;
      if (start > earlyLimit) break;
      const slice = samples.subarray(start, start + winLen);
      const winMatch = this.matchSamples(slice, sampleRate, {
        speakerVerify: opts?.speakerVerify,
        thresholdOverride: threshold,
      });
      if (winMatch.matched && winMatch.speaker) {
        const found = data.profiles.find(p => p.id === winMatch.speaker!.id);
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
        matched: false,
        samples,
        trimmed: false,
        reason: fullRes.reason ?? 'below_threshold',
      };
    }

    const sustainFloor = Math.max(0.22, threshold - 0.05);
    const windowScores: number[] = [];
    for (let i = anchorStartIdx; i < starts.length; i++) {
      const start = starts[i]!;
      const slice = samples.subarray(start, start + winLen);
      const emb = this.extractEmbedding(slice, sampleRate);
      const score = emb ? scoreEmbeddingAgainstProfile(emb, anchorProfile) : 0;
      if (score > bestAnchorScore) bestAnchorScore = score;
      windowScores.push(score);
    }

    let lastGoodWindowEnd = starts[anchorStartIdx]! + winLen;
    for (let offset = 1; offset < windowScores.length; offset++) {
      const score = windowScores[offset]!;
      const start = starts[anchorStartIdx + offset]!;
      if (score >= sustainFloor) {
        lastGoodWindowEnd = start + winLen;
        continue;
      }
      const nextScore = offset + 1 < windowScores.length ? windowScores[offset + 1]! : 0;
      if (nextScore >= threshold) {
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

  close(): void {
    this.extractor?.free?.();
    this.extractor = undefined;
    this.extractorModelPath = undefined;
  }
}

function normalizeSpeakerTargetToken(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .trim()
    .replace(/^[的给帮为]+/, '')
    .replace(/(?:的|一下)+$/g, '')
    .trim();
  if (!cleaned || /^(?:我|本人|自己|我的|咱|咱们)$/.test(cleaned)) {
    return undefined;
  }
  return cleaned.slice(0, 24);
}

export function parseSpeakerVoiceCommand(rawText: string): SpeakerVoiceCommand | undefined {
  const cleaned = rawText
    .trim()
    .replace(/^(?:(?:你好|嗨|嘿|喂)[，,\s]*)?(?:星期五|小爱同学?)[，,\s]*/i, '')
    .replace(/[。，,！!？?、；;\s]+$/g, '')
    .trim();
  if (!cleaned) return undefined;

  // 1. Toggle verification on/off
  if (/^(?:请|帮我|麻烦)?(?:暂停|关闭|停用|关掉)(?:声纹|音色)(?:识别|过滤|验证|保护|门禁)?$/.test(cleaned)) {
    return { kind: 'toggle', enabled: false };
  }
  if (/^(?:请|帮我|麻烦)?(?:开启|打开|恢复|启用)(?:声纹|音色)(?:识别|过滤|验证|保护|门禁)?$/.test(cleaned)) {
    return { kind: 'toggle', enabled: true };
  }

  // 2. Clear all voiceprints
  if (/^(?:请|帮我|麻烦)?(?:清空|删除|清除|重置)(?:所有|全部)(?:人的?)?(?:声纹|音色)(?:档案|信息|记录)?$/.test(cleaned)) {
    return { kind: 'clear' };
  }

  // 3. Who am I / voice test
  if (
    /^(?:请问)?(?:我是谁|听听我是谁|猜猜我是谁|你能听出我是谁吗|听得出我是谁吗|识别(?:一下)?我的(?:声纹|音色)|测试(?:一下)?(?:我的)?(?:声纹|音色)|声纹自检|音色自检)$/.test(
      cleaned,
    )
  ) {
    return { kind: 'whoami' };
  }

  // 4. List / status
  if (
    /^(?:请|帮我|麻烦)?(?:查看|查询|看看|列出|播报)?(?:已录入的?|现有的?|当前的?)?(?:声纹|音色)(?:列表|名单|状态|管理|情况|成员|档案)$/.test(
      cleaned,
    )
    || /^(?:请|帮我|麻烦)?(?:查看|查询|看看|列出|播报)(?:已录入的?)?(?:声纹|音色)$/.test(cleaned)
    || /^(?:家里|目前|现在)?(?:有|录了)(?:哪些|几个|谁的)(?:声纹|音色|声音)(?:啊|吗|呢)?$/.test(cleaned)
  ) {
    return { kind: 'list' };
  }

  // 5. Remove single speaker
  let match = /^(?:请|帮我|麻烦)?(?:删除|移除|清除|删掉)(.{1,16}?)的(?:声纹|音色)(?:档案|记录)?$/.exec(cleaned);
  if (match) {
    const rawTarget = match[1]?.trim() ?? '';
    if (!/^(?:所有|全部)/.test(rawTarget)) {
      const targetName = normalizeSpeakerTargetToken(rawTarget);
      return targetName ? { kind: 'remove', targetName } : { kind: 'remove' };
    }
  }
  match = /^(?:请|帮我|麻烦)?(?:删除|移除|清除)(?:声纹|音色)[:：,\s，]+(.{1,16})$/.exec(cleaned);
  if (match) {
    const targetName = normalizeSpeakerTargetToken(match[1]);
    return targetName ? { kind: 'remove', targetName } : { kind: 'remove' };
  }

  // 6. Append / supplement existing voiceprint
  match = /^(?:请|帮我|麻烦)?(?:帮|给|为)(.{1,16}?)(?:补充|追加|完善|加强)(?:一下)?(?:声纹|音色)$/.exec(cleaned);
  if (match) {
    const targetName = normalizeSpeakerTargetToken(match[1]);
    return targetName ? { kind: 'enroll', targetName, mode: 'append' } : { kind: 'enroll', mode: 'append' };
  }
  match = /^(?:请|帮我|麻烦)?(?:补充|追加|完善|加强)(?:一下)?(?:(.{1,16}?)的)?(?:声纹|音色)$/.exec(cleaned);
  if (match) {
    const targetName = normalizeSpeakerTargetToken(match[1]);
    return targetName ? { kind: 'enroll', targetName, mode: 'append' } : { kind: 'enroll', mode: 'append' };
  }

  // 7. Enroll / register / re-record voiceprint
  match = /^(?:请|帮我|麻烦)?(?:帮|给|为)(.{1,16}?)(?:重新)?(?:录入|注册|添加|新增|采集|重录)(?:一下)?(?:声纹|音色|声音)$/.exec(cleaned);
  if (match) {
    const targetName = normalizeSpeakerTargetToken(match[1]);
    return targetName ? { kind: 'enroll', targetName, mode: 'replace' } : { kind: 'enroll', mode: 'replace' };
  }
  match = /^(?:请|帮我|麻烦)?(?:重新)?(?:录入|注册|添加|新增|采集|保存|记住|重录)(?:一下)?(?:(.{1,16}?)的)?(?:声纹|音色|声音)$/.exec(cleaned);
  if (match) {
    const targetName = normalizeSpeakerTargetToken(match[1]);
    return targetName ? { kind: 'enroll', targetName, mode: 'replace' } : { kind: 'enroll', mode: 'replace' };
  }
  match = /^(?:请|帮我|麻烦)?(?:录入|注册|添加|新增)(?:家人|家庭|成员)?(?:声纹|音色)[:：,\s，]+(.{1,16})$/.exec(cleaned);
  if (match) {
    const targetName = normalizeSpeakerTargetToken(match[1]);
    return targetName ? { kind: 'enroll', targetName, mode: 'replace' } : { kind: 'enroll', mode: 'replace' };
  }

  return undefined;
}

export function isEnrollCancelPhrase(rawText: string): boolean {
  const cleaned = rawText
    .trim()
    .replace(/[。，,！!？?、\s]+$/g, '')
    .trim();
  if (!cleaned) return false;
  return /^(?:(?:不用了?|不要了?|算了(?:吧)?)[，,\s]*)?(?:取消|退出|算了(?:吧)?|不录了?|停止录入|取消录入|退出录入|不用了?|不要了?|结束(?:录入)?)(?:吧|啦)?$/.test(cleaned);
}

function buildStepPrompt(step: number, totalSteps: number, speakerName: string, mode: 'replace' | 'append'): string {
  const examples = [
    '星期五，今天天气怎么样',
    '帮我看一下家里哪些灯开着',
    '请把客厅的电视声音调小一点',
    '明天早上八点记得叫我起床',
  ];
  const example = examples[(step - 1) % examples.length]!;
  if (step === 1) {
    const prefix = mode === 'append' ? `开始为${speakerName}补充声纹` : `好的，开始为${speakerName}录入声纹`;
    return `${prefix}，共 ${totalSteps} 句。请先自然说第 1 句，比如：${example}。`;
  }
  return `第 ${step - 1} 句已收到。请说第 ${step} 句，例如：${example}。`;
}

export class XiaoaiSpeakerEnrollController {
  private readonly active = new Map<string, ActiveEnrollSession>();
  private readonly history = new Map<string, XiaoaiEnrollSessionSnapshot>();
  private readonly stepTtlMs: number;

  constructor(options?: { stepTtlMs?: number }) {
    this.stepTtlMs = options?.stepTtlMs ?? DEFAULT_ENROLL_STEP_TTL_MS;
  }

  private key(channelId: string, targetId: string): string {
    return `${channelId}:${targetId}`;
  }

  private toSnapshot(session: ActiveEnrollSession): XiaoaiEnrollSessionSnapshot {
    return {
      sessionId: session.sessionId,
      channelId: session.channelId,
      targetId: session.targetId,
      speakerName: session.speakerName,
      role: session.role,
      mode: session.mode,
      status: session.status,
      step: session.step,
      totalSteps: session.totalSteps,
      message: session.message,
      updatedAt: session.updatedAt,
    };
  }

  private saveHistory(snapshot: XiaoaiEnrollSessionSnapshot): void {
    this.history.set(snapshot.sessionId, snapshot);
    if (this.history.size > 32) {
      const oldestKey = this.history.keys().next().value;
      if (oldestKey) this.history.delete(oldestKey);
    }
  }

  isActive(channelId: string, targetId: string, now = Date.now()): boolean {
    const k = this.key(channelId, targetId);
    const session = this.active.get(k);
    if (!session) return false;
    if (session.expiresAt <= now) {
      this.active.delete(k);
      this.saveHistory({
        ...this.toSnapshot(session),
        status: 'failed',
        error: '声纹录入已超时',
        message: '声纹录入已超时，请重新开始。',
        updatedAt: now,
      });
      return false;
    }
    return true;
  }

  getActive(channelId: string, targetId: string): XiaoaiEnrollSessionSnapshot | undefined {
    if (!this.isActive(channelId, targetId)) return undefined;
    const session = this.active.get(this.key(channelId, targetId));
    return session ? this.toSnapshot(session) : undefined;
  }

  getStatus(sessionId: string): XiaoaiEnrollSessionSnapshot | undefined {
    for (const session of this.active.values()) {
      if (session.sessionId === sessionId) {
        if (!this.isActive(session.channelId, session.targetId)) break;
        return this.toSnapshot(session);
      }
    }
    return this.history.get(sessionId);
  }

  createPreparingSession(params: {
    channelId: string;
    targetId: string;
    speakerName: string;
    role: 'owner' | 'member';
    mode: 'replace' | 'append';
  }): XiaoaiEnrollSessionSnapshot {
    const k = this.key(params.channelId, params.targetId);
    const prev = this.active.get(k);
    if (prev) {
      this.saveHistory({
        ...this.toSnapshot(prev),
        status: 'cancelled',
        message: '已被新的声纹录入任务取代',
        updatedAt: Date.now(),
      });
    }
    const now = Date.now();
    const totalSteps = params.mode === 'append' ? APPEND_ENROLL_UTTERANCES : DEFAULT_ENROLL_UTTERANCES;
    const session: ActiveEnrollSession = {
      sessionId: `enroll_${randomUUID().slice(0, 12)}`,
      channelId: params.channelId,
      targetId: params.targetId,
      speakerName: params.speakerName,
      role: params.role,
      mode: params.mode,
      status: 'preparing_model',
      step: 0,
      totalSteps,
      message: '正在准备声纹模型，请稍候。',
      collectedEmbeddings: [],
      retryCount: 0,
      emptyRetryCount: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + Math.max(this.stepTtlMs, 95_000),
    };
    this.active.set(k, session);
    const snap = this.toSnapshot(session);
    this.saveHistory(snap);
    return snap;
  }

  activateSession(sessionId: string): { snapshot: XiaoaiEnrollSessionSnapshot; prompt: string } | undefined {
    for (const session of this.active.values()) {
      if (session.sessionId !== sessionId) continue;
      const now = Date.now();
      session.status = 'collecting';
      session.step = 1;
      session.updatedAt = now;
      session.expiresAt = now + this.stepTtlMs;
      const prompt = buildStepPrompt(1, session.totalSteps, session.speakerName, session.mode);
      session.message = prompt;
      const snap = this.toSnapshot(session);
      this.saveHistory(snap);
      return { snapshot: snap, prompt };
    }
    return undefined;
  }

  failSession(sessionId: string, errorMessage: string): XiaoaiEnrollSessionSnapshot | undefined {
    for (const [k, session] of this.active.entries()) {
      if (session.sessionId !== sessionId) continue;
      this.active.delete(k);
      const snap: XiaoaiEnrollSessionSnapshot = {
        ...this.toSnapshot(session),
        status: 'failed',
        error: errorMessage,
        message: errorMessage,
        updatedAt: Date.now(),
      };
      this.saveHistory(snap);
      return snap;
    }
    const existing = this.history.get(sessionId);
    if (existing) {
      const snap: XiaoaiEnrollSessionSnapshot = {
        ...existing,
        status: 'failed',
        error: errorMessage,
        message: errorMessage,
        updatedAt: Date.now(),
      };
      this.saveHistory(snap);
      return snap;
    }
    return undefined;
  }

  cancelByIdOrTarget(idOrChannel?: { sessionId?: string; channelId?: string; targetId?: string }): XiaoaiEnrollSessionSnapshot | undefined {
    const now = Date.now();
    for (const [k, session] of this.active.entries()) {
      const matchesSession = idOrChannel?.sessionId && session.sessionId === idOrChannel.sessionId;
      const matchesTarget = idOrChannel?.channelId && idOrChannel?.targetId
        && session.channelId === idOrChannel.channelId && session.targetId === idOrChannel.targetId;
      const matchesAny = !idOrChannel?.sessionId && !idOrChannel?.channelId;
      if (!matchesSession && !matchesTarget && !matchesAny) continue;
      this.active.delete(k);
      const snap: XiaoaiEnrollSessionSnapshot = {
        ...this.toSnapshot(session),
        status: 'cancelled',
        message: '已取消声纹录入。',
        updatedAt: now,
      };
      this.saveHistory(snap);
      return snap;
    }
    return idOrChannel?.sessionId ? this.history.get(idOrChannel.sessionId) : undefined;
  }

  processSample(params: {
    channelId: string;
    targetId: string;
    samples?: Float32Array;
    sampleRate?: number;
    transcript: string;
    extractor: (samples: Float32Array, sampleRate: number) => Float32Array | undefined;
    existingProfile?: XiaoaiSpeakerProfile;
    minEnrollDurationMs?: number;
  }):
    | { outcome: 'inactive' }
    | { outcome: 'cancelled'; prompt: string; snapshot: XiaoaiEnrollSessionSnapshot }
    | { outcome: 'retry'; prompt: string; snapshot: XiaoaiEnrollSessionSnapshot }
    | { outcome: 'failed'; prompt: string; snapshot: XiaoaiEnrollSessionSnapshot }
    | { outcome: 'next_step'; prompt: string; snapshot: XiaoaiEnrollSessionSnapshot }
    | { outcome: 'ready_to_save'; embeddings: Float32Array[]; session: XiaoaiEnrollSessionSnapshot } {
    const k = this.key(params.channelId, params.targetId);
    if (!this.isActive(params.channelId, params.targetId)) {
      return { outcome: 'inactive' };
    }
    const session = this.active.get(k)!;
    const now = Date.now();

    if (isEnrollCancelPhrase(params.transcript)) {
      this.active.delete(k);
      const prompt = '好的，已取消声纹录入。';
      const snap: XiaoaiEnrollSessionSnapshot = {
        ...this.toSnapshot(session),
        status: 'cancelled',
        message: prompt,
        updatedAt: now,
      };
      this.saveHistory(snap);
      return { outcome: 'cancelled', prompt, snapshot: snap };
    }

    if (session.status !== 'collecting') {
      return {
        outcome: 'retry',
        prompt: '声纹模型还在准备中，请稍等片刻。',
        snapshot: this.toSnapshot(session),
      };
    }

    const sampleRate = params.sampleRate ?? SPEAKER_SAMPLE_RATE;
    const minDurationMs = params.minEnrollDurationMs ?? DEFAULT_MIN_ENROLL_DURATION_MS;
    const minSamples = Math.max(Math.round(sampleRate * 0.35), Math.round((sampleRate * minDurationMs) / 1000));
    if (!params.samples || params.samples.length < minSamples) {
      session.retryCount++;
      session.emptyRetryCount = 0;
      if (session.retryCount > 4) {
        this.active.delete(k);
        const prompt = '连续几次句子太短，声纹录入已退出。';
        const snap: XiaoaiEnrollSessionSnapshot = {
          ...this.toSnapshot(session),
          status: 'failed',
          error: prompt,
          message: prompt,
          updatedAt: now,
        };
        this.saveHistory(snap);
        return { outcome: 'failed', prompt, snapshot: snap };
      }
      session.updatedAt = now;
      session.expiresAt = now + this.stepTtlMs;
      const prompt = '刚才这句话太短了，请靠近音箱自然多说几个字。';
      session.message = prompt;
      const snap = this.toSnapshot(session);
      this.saveHistory(snap);
      return { outcome: 'retry', prompt, snapshot: snap };
    }

    const emb = params.extractor(params.samples, sampleRate);
    if (!emb) {
      session.retryCount++;
      session.emptyRetryCount = 0;
      if (session.retryCount > 4) {
        this.active.delete(k);
        const prompt = '未能提取到有效声纹，已退出录入。';
        const snap: XiaoaiEnrollSessionSnapshot = {
          ...this.toSnapshot(session),
          status: 'failed',
          error: prompt,
          message: prompt,
          updatedAt: now,
        };
        this.saveHistory(snap);
        return { outcome: 'failed', prompt, snapshot: snap };
      }
      session.updatedAt = now;
      session.expiresAt = now + this.stepTtlMs;
      const prompt = '刚才没听清您的音色，请清晰再说一句。';
      session.message = prompt;
      const snap = this.toSnapshot(session);
      this.saveHistory(snap);
      return { outcome: 'retry', prompt, snapshot: snap };
    }

    let consistent = true;
    if (session.collectedEmbeddings.length > 0) {
      const centroid = computeCentroid(session.collectedEmbeddings);
      if (centroid && cosineSimilarity(emb, centroid) < 0.28) {
        consistent = false;
      }
    }
    if (consistent && session.mode === 'append' && params.existingProfile && params.existingProfile.dim === emb.length) {
      if (cosineSimilarity(emb, params.existingProfile.centroid) < 0.28) {
        consistent = false;
      }
    }

    if (!consistent) {
      session.retryCount++;
      session.emptyRetryCount = 0;
      if (session.retryCount > 4) {
        this.active.delete(k);
        const prompt = '多次采集到的音色差异过大，已退出声纹录入。';
        const snap: XiaoaiEnrollSessionSnapshot = {
          ...this.toSnapshot(session),
          status: 'failed',
          error: prompt,
          message: prompt,
          updatedAt: now,
        };
        this.saveHistory(snap);
        return { outcome: 'failed', prompt, snapshot: snap };
      }
      session.updatedAt = now;
      session.expiresAt = now + this.stepTtlMs;
      const prompt = '这句话和前面音色不太一致，可能是电视或他人干扰，请本人清晰再说一句。';
      session.message = prompt;
      const snap = this.toSnapshot(session);
      this.saveHistory(snap);
      return { outcome: 'retry', prompt, snapshot: snap };
    }

    session.collectedEmbeddings.push(emb);
    session.retryCount = 0;
    session.emptyRetryCount = 0;
    session.updatedAt = now;
    session.expiresAt = now + this.stepTtlMs;

    if (session.collectedEmbeddings.length < session.totalSteps) {
      session.step = session.collectedEmbeddings.length + 1;
      const prompt = buildStepPrompt(session.step, session.totalSteps, session.speakerName, session.mode);
      session.message = prompt;
      const snap = this.toSnapshot(session);
      this.saveHistory(snap);
      return { outcome: 'next_step', prompt, snapshot: snap };
    }

    return {
      outcome: 'ready_to_save',
      embeddings: [...session.collectedEmbeddings],
      session: this.toSnapshot(session),
    };
  }

  completeSession(sessionId: string, profileId: string, message: string): XiaoaiEnrollSessionSnapshot | undefined {
    for (const [k, session] of this.active.entries()) {
      if (session.sessionId !== sessionId) continue;
      this.active.delete(k);
      const snap: XiaoaiEnrollSessionSnapshot = {
        ...this.toSnapshot(session),
        status: 'completed',
        step: session.totalSteps,
        message,
        profileId,
        updatedAt: Date.now(),
      };
      this.saveHistory(snap);
      return snap;
    }
    return undefined;
  }

  handleCaptureTimeoutOrEmpty(
    channelId: string,
    targetId: string,
    reason: 'timeout' | 'empty',
  ):
    | { action: 'inactive' }
    | { action: 'rearm'; speakHint?: string }
    | { action: 'cancelled'; prompt: string; snapshot: XiaoaiEnrollSessionSnapshot } {
    const k = this.key(channelId, targetId);
    if (!this.isActive(channelId, targetId)) {
      return { action: 'inactive' };
    }
    const session = this.active.get(k)!;
    if (session.status === 'preparing_model') {
      return { action: 'rearm' };
    }
    session.emptyRetryCount++;
    const now = Date.now();
    if (session.emptyRetryCount <= 2) {
      session.updatedAt = now;
      session.expiresAt = now + this.stepTtlMs;
      this.saveHistory(this.toSnapshot(session));
      return {
        action: 'rearm',
        speakHint: reason === 'timeout' && session.emptyRetryCount === 1
          ? '我还在听，请直接说话，或说取消退出。'
          : undefined,
      };
    }
    this.active.delete(k);
    const prompt = '未检测到有效说话声，已退出声纹录入。';
    const snap: XiaoaiEnrollSessionSnapshot = {
      ...this.toSnapshot(session),
      status: 'cancelled',
      message: prompt,
      updatedAt: now,
    };
    this.saveHistory(snap);
    return { action: 'cancelled', prompt, snapshot: snap };
  }

  clear(): void {
    this.active.clear();
    this.history.clear();
  }
}

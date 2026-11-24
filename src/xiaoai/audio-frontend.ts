import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

export const FRONTEND_SAMPLE_RATE = 16_000;
export const AUDIO_STREAM_MAGIC_8CH_S16 = 'FRPCM8S2';
export const AUDIO_STREAM_MAGIC_1CH_S16 = 'FRPCM1S2';
export const AUDIO_STREAM_MAGIC_1CH_S32 = 'FRPCM1S4';

export const DENOISER_MODEL_FILENAME = 'gtcrn_simple.onnx';
export const DEFAULT_DENOISER_MODEL_URLS = [
  'https://hf-mirror.com/csukuangfj/speech-enhancement-models/resolve/main/gtcrn_simple.onnx',
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/gtcrn_simple.onnx',
] as const;

/** Exact LX06 6-mic circular hexagon coordinates (meters, radius 3.6 cm) from `/data/mipns/mds.conf`. */
export const LX06_HEX_MIC_COORDS: readonly (readonly [number, number])[] = [
  [-0.0312, -0.018],
  [-0.0312, 0.018],
  [0.0, 0.036],
  [0.0312, 0.018],
  [0.0312, -0.018],
  [0.0, -0.036],
];

const SPEED_OF_SOUND_MPS = 343;
const MAX_DENOISER_MODEL_BYTES = 20 * 1024 * 1024;
const MIN_DENOISER_MODEL_BYTES = 50_000;
const HEX_ADJACENT_AND_DIAMETRIC_PAIRS: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0],
  [0, 3], [1, 4], [2, 5],
];

export interface DcBlockerState {
  prevX: number;
  prevY: number;
}

export interface MultiChannelAudioChunk {
  mics: Float32Array[];
  ref: Float32Array;
  refRms: number;
}

export interface XiaoaiAudioDenoiser {
  denoise: (samples: Float32Array, sampleRate: number) => Float32Array;
  free?: () => void;
}

export type AudioStreamHeaderResult =
  | { channels: number; sampleFormat: 's16le' | 's32le'; consumed: number }
  | 'need_more'
  | 'none';

const STREAM_HEADER_MAGICS: ReadonlyArray<{
  magic: string;
  channels: number;
  sampleFormat: 's16le' | 's32le';
}> = [
  { magic: AUDIO_STREAM_MAGIC_8CH_S16, channels: 8, sampleFormat: 's16le' },
  { magic: AUDIO_STREAM_MAGIC_1CH_S16, channels: 1, sampleFormat: 's16le' },
  { magic: AUDIO_STREAM_MAGIC_1CH_S32, channels: 1, sampleFormat: 's32le' },
];

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

function calcRms(samples: Float32Array): number {
  return computeRms(samples);
}

/**
 * Inspect the leading 8 bytes of an audio stream to detect Friday's framed PCM header
 * (`FRPCM8S2`, `FRPCM1S2`, `FRPCM1S4`), falling back cleanly to `'none'` for raw headerless PCM.
 */
export function parseAudioStreamHeader(buf: Buffer): AudioStreamHeaderResult {
  if (buf.length === 0) return 'need_more';
  if (buf.length < 8) {
    const prefix = buf.toString('latin1');
    return STREAM_HEADER_MAGICS.some(entry => entry.magic.startsWith(prefix)) ? 'need_more' : 'none';
  }
  const head = buf.subarray(0, 8).toString('latin1');
  for (const entry of STREAM_HEADER_MAGICS) {
    if (head === entry.magic) {
      return {
        channels: entry.channels,
        sampleFormat: entry.sampleFormat,
        consumed: 8,
      };
    }
  }
  return 'none';
}

/**
 * Decode interleaved `S16_LE` PCM into separate normalized mic channels and speaker loopback reference,
 * applying an optional 1st-order DC blocker per mic channel.
 */
export function decodeInterleavedPcm16le(
  chunk: Buffer,
  leftover: Buffer,
  numChannels: number,
  dcStates?: DcBlockerState[],
): { mics: Float32Array[]; ref: Float32Array; refRms: number; leftover: Buffer } {
  const safeChannels = Math.max(1, Math.trunc(numChannels));
  const micCount = safeChannels === 8 || safeChannels >= 6
    ? 6
    : safeChannels === 1
      ? 1
      : safeChannels - 1;

  const buf = leftover.length > 0 ? Buffer.concat([leftover, chunk]) : chunk;
  const frameBytes = safeChannels * 2;
  const usableFrames = Math.floor(buf.length / frameBytes);
  const remainder = buf.length % frameBytes;
  const nextLeftover = remainder > 0
    ? Buffer.from(buf.subarray(usableFrames * frameBytes))
    : Buffer.alloc(0);

  if (usableFrames === 0) {
    return {
      mics: Array.from({ length: micCount }, () => new Float32Array(0)),
      ref: new Float32Array(0),
      refRms: 0,
      leftover: nextLeftover,
    };
  }

  if (dcStates) {
    while (dcStates.length < micCount) {
      dcStates.push({ prevX: 0, prevY: 0 });
    }
  }

  const mics = Array.from({ length: micCount }, () => new Float32Array(usableFrames));
  const hasStereoRef = safeChannels >= 8;
  const hasMonoRef = safeChannels === 2 || safeChannels === 7 || (safeChannels >= 3 && safeChannels <= 5);
  const ref = (hasStereoRef || hasMonoRef) ? new Float32Array(usableFrames) : new Float32Array(0);
  let refSumSq = 0;

  for (let f = 0; f < usableFrames; f++) {
    const baseByte = f * frameBytes;
    for (let m = 0; m < micCount; m++) {
      const x = buf.readInt16LE(baseByte + m * 2) / 32768;
      const dc = dcStates?.[m];
      if (dc) {
        const y = x - dc.prevX + 0.995 * dc.prevY;
        dc.prevX = x;
        dc.prevY = y;
        mics[m]![f] = y;
      } else {
        mics[m]![f] = x;
      }
    }
    if (hasStereoRef) {
      const r0 = buf.readInt16LE(baseByte + 6 * 2) / 32768;
      const r1 = buf.readInt16LE(baseByte + 7 * 2) / 32768;
      const r = 0.5 * (r0 + r1);
      ref[f] = r;
      refSumSq += r * r;
    } else if (hasMonoRef) {
      const refCh = safeChannels >= 6 ? 6 : safeChannels - 1;
      const r = buf.readInt16LE(baseByte + refCh * 2) / 32768;
      ref[f] = r;
      refSumSq += r * r;
    }
  }

  const refRms = ref.length > 0 ? Math.sqrt(refSumSq / ref.length) : 0;
  return { mics, ref, refRms, leftover: nextLeftover };
}

interface FftPlan {
  n: number;
  bitRev: Uint32Array;
  cosTable: Float64Array;
  sinTable: Float64Array;
}

const fftPlanCache = new Map<number, FftPlan>();

function getFftPlan(n: number): FftPlan {
  const cached = fftPlanCache.get(n);
  if (cached) return cached;
  if (n < 2 || (n & (n - 1)) !== 0) {
    throw new Error(`FFT size must be a power of 2 >= 2, got ${n}`);
  }
  const bits = Math.round(Math.log2(n));
  const bitRev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i;
    let rev = 0;
    for (let b = 0; b < bits; b++) {
      rev = (rev << 1) | (x & 1);
      x >>= 1;
    }
    bitRev[i] = rev;
  }
  const half = n >> 1;
  const cosTable = new Float64Array(half);
  const sinTable = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    const angle = (-2 * Math.PI * k) / n;
    cosTable[k] = Math.cos(angle);
    sinTable[k] = Math.sin(angle);
  }
  const plan: FftPlan = { n, bitRev, cosTable, sinTable };
  fftPlanCache.set(n, plan);
  return plan;
}

/** In-place iterative Radix-2 complex FFT/IFFT (`1/N` scaling applied on inverse). */
export function fftRadix2(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n !== im.length) {
    throw new Error('FFT real and imaginary buffers must have equal length');
  }
  if (n <= 1) return;
  const { bitRev, cosTable, sinTable } = getFftPlan(n);

  for (let i = 0; i < n; i++) {
    const j = bitRev[i]!;
    if (i < j) {
      const tr = re[i]!;
      const ti = im[i]!;
      re[i] = re[j]!;
      im[i] = im[j]!;
      re[j] = tr;
      im[j] = ti;
    }
  }

  const sign = inverse ? -1 : 1;
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let start = 0; start < n; start += len) {
      for (let k = 0; k < half; k++) {
        const idx = k * step;
        const wr = cosTable[idx]!;
        const wi = sign * sinTable[idx]!;
        const i1 = start + k;
        const i2 = i1 + half;
        const r2 = re[i2]!;
        const im2 = im[i2]!;
        const tr = wr * r2 - wi * im2;
        const ti = wr * im2 + wi * r2;
        const r1 = re[i1]!;
        const im1 = im[i1]!;
        re[i1] = r1 + tr;
        im[i1] = im1 + ti;
        re[i2] = r1 - tr;
        im[i2] = im1 - ti;
      }
    }
  }

  if (inverse) {
    const invN = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! * invN;
      im[i] = im[i]! * invN;
    }
  }
}

export interface PartitionedBlockAecOptions {
  blockSize?: number;
  numPartitions?: number;
  stepSize?: number;
  reg?: number;
  refActiveThreshold?: number;
}

/**
 * Partitioned Block Frequency-Domain Adaptive Filter (PBFDAF / Overlap-Save NLMS)
 * for acoustic echo cancellation with double-talk guard, gradient constraint, safety clamp,
 * and automatic 0-CPU bypass when speaker reference is silent.
 */
export class PartitionedBlockAec {
  readonly blockSize: number;
  readonly fftSize: number;
  readonly numPartitions: number;
  private readonly stepSize: number;
  private readonly reg: number;
  private readonly refActiveThreshold: number;

  private prevRefBlock: Float32Array;
  private refRing: Float32Array;
  private refRingWritePos = 0;
  private refSpecRe: Float64Array[];
  private refSpecIm: Float64Array[];
  private refHead = 0;
  private weightsRe: Float64Array[];
  private weightsIm: Float64Array[];
  private smoothPx: Float64Array;

  private wTime: Float64Array;
  private wTimeDirty = true;
  private pendMic: Float32Array;
  private pendRef: Float32Array;
  private pendErr: Float32Array;
  private pendLen = 0;

  private silentBlocks = 999;
  private activeBlocks = 0;
  private smoothMicEnergy = 0;
  private smoothErrEnergy = 0;

  private readonly tmpRe: Float64Array;
  private readonly tmpIm: Float64Array;
  private readonly yRe: Float64Array;
  private readonly yIm: Float64Array;
  private readonly eRe: Float64Array;
  private readonly eIm: Float64Array;
  private readonly gRe: Float64Array;
  private readonly gIm: Float64Array;

  constructor(options?: PartitionedBlockAecOptions) {
    this.blockSize = options?.blockSize ?? 256;
    this.fftSize = this.blockSize * 2;
    this.numPartitions = options?.numPartitions ?? 6;
    this.stepSize = options?.stepSize ?? 0.45;
    this.reg = options?.reg ?? 1e-6;
    this.refActiveThreshold = options?.refActiveThreshold ?? 1e-4;

    this.prevRefBlock = new Float32Array(this.blockSize);
    this.refRing = new Float32Array(this.numPartitions * this.blockSize);
    this.refSpecRe = Array.from({ length: this.numPartitions }, () => new Float64Array(this.fftSize));
    this.refSpecIm = Array.from({ length: this.numPartitions }, () => new Float64Array(this.fftSize));
    this.weightsRe = Array.from({ length: this.numPartitions }, () => new Float64Array(this.fftSize));
    this.weightsIm = Array.from({ length: this.numPartitions }, () => new Float64Array(this.fftSize));
    this.smoothPx = new Float64Array(this.fftSize);

    this.wTime = new Float64Array(this.numPartitions * this.blockSize);
    this.pendMic = new Float32Array(this.blockSize);
    this.pendRef = new Float32Array(this.blockSize);
    this.pendErr = new Float32Array(this.blockSize);

    this.tmpRe = new Float64Array(this.fftSize);
    this.tmpIm = new Float64Array(this.fftSize);
    this.yRe = new Float64Array(this.fftSize);
    this.yIm = new Float64Array(this.fftSize);
    this.eRe = new Float64Array(this.fftSize);
    this.eIm = new Float64Array(this.fftSize);
    this.gRe = new Float64Array(this.fftSize);
    this.gIm = new Float64Array(this.fftSize);
  }

  reset(options?: { keepWeights?: boolean }): void {
    this.prevRefBlock.fill(0);
    this.refRing.fill(0);
    this.refRingWritePos = 0;
    for (let p = 0; p < this.numPartitions; p++) {
      this.refSpecRe[p]!.fill(0);
      this.refSpecIm[p]!.fill(0);
      if (!options?.keepWeights) {
        this.weightsRe[p]!.fill(0);
        this.weightsIm[p]!.fill(0);
      }
    }
    this.refHead = 0;
    this.smoothPx.fill(0);
    if (!options?.keepWeights) {
      this.wTime.fill(0);
    }
    this.wTimeDirty = true;
    this.pendLen = 0;
    this.silentBlocks = 999;
    this.activeBlocks = 0;
    this.smoothMicEnergy = 0;
    this.smoothErrEnergy = 0;
  }

  private refreshWTimeIfNeeded(): void {
    if (!this.wTimeDirty) return;
    const b = this.blockSize;
    const n = this.fftSize;
    for (let p = 0; p < this.numPartitions; p++) {
      const wRe = this.weightsRe[p]!;
      const wIm = this.weightsIm[p]!;
      this.tmpRe.set(wRe);
      this.tmpIm.set(wIm);
      fftRadix2(this.tmpRe, this.tmpIm, true);
      const offset = p * b;
      for (let i = 0; i < b; i++) {
        this.wTime[offset + i] = this.tmpRe[i]!;
      }
    }
    void n;
    this.wTimeDirty = false;
  }

  private pushRefHistoryBlock(refBlock: Float32Array, refOffset: number): void {
    const b = this.blockSize;
    const total = this.refRing.length;
    for (let i = 0; i < b; i++) {
      this.refRing[this.refRingWritePos] = refBlock[refOffset + i]!;
      this.refRingWritePos = (this.refRingWritePos + 1) % total;
    }
  }

  private updateWeightsFromBlock(
    micBlock: Float32Array,
    micOffset: number,
    refBlock: Float32Array,
    refOffset: number,
    errBlock: Float32Array,
    errOffset: number,
    refEnergy: number,
    micEnergy: number,
    errEnergy: number,
  ): void {
    const b = this.blockSize;
    const n = this.fftSize;
    const pCount = this.numPartitions;

    // 1. Shift partition head & compute 512-pt FFT of [prevRefBlock, refBlock]
    this.refHead = (this.refHead + pCount - 1) % pCount;
    const xRe = this.refSpecRe[this.refHead]!;
    const xIm = this.refSpecIm[this.refHead]!;
    for (let i = 0; i < b; i++) {
      xRe[i] = this.prevRefBlock[i]!;
      xRe[b + i] = refBlock[refOffset + i]!;
      xIm[i] = 0;
      xIm[b + i] = 0;
      this.prevRefBlock[i] = refBlock[refOffset + i]!;
    }
    fftRadix2(xRe, xIm, false);

    // 2. Update per-bin total reference power across partitions
    for (let k = 0; k < n; k++) {
      let px = 0;
      for (let p = 0; p < pCount; p++) {
        const idx = (this.refHead + p) % pCount;
        const sr = this.refSpecRe[idx]![k]!;
        const si = this.refSpecIm[idx]![k]!;
        px += sr * sr + si * si;
      }
      this.smoothPx[k] = 0.72 * this.smoothPx[k]! + 0.28 * px;
    }

    if (refEnergy <= 1e-10) return;

    this.smoothMicEnergy = this.smoothMicEnergy > 0
      ? 0.75 * this.smoothMicEnergy + 0.25 * micEnergy
      : micEnergy;
    this.smoothErrEnergy = this.smoothErrEnergy > 0
      ? 0.75 * this.smoothErrEnergy + 0.25 * errEnergy
      : errEnergy;

    // Double-talk / divergence guard
    if (this.activeBlocks > 8 && this.smoothErrEnergy > 1.25 * this.smoothMicEnergy) {
      for (let p = 0; p < pCount; p++) {
        const wRe = this.weightsRe[p]!;
        const wIm = this.weightsIm[p]!;
        for (let k = 0; k < n; k++) {
          wRe[k] = wRe[k]! * 0.96;
          wIm[k] = wIm[k]! * 0.96;
        }
      }
      this.wTimeDirty = true;
      return;
    }

    const doubleTalk = this.activeBlocks > 10 && this.smoothErrEnergy > 0.85 * this.smoothMicEnergy;
    const effMu = doubleTalk ? this.stepSize * 0.15 : this.stepSize;

    // 3. Error spectrum E(k) = FFT([zeros(B), err])
    for (let i = 0; i < b; i++) {
      this.eRe[i] = 0;
      this.eIm[i] = 0;
      this.eRe[b + i] = errBlock[errOffset + i]!;
      this.eIm[b + i] = 0;
    }
    fftRadix2(this.eRe, this.eIm, false);

    // 4. Constrained frequency-domain gradient update per partition
    const denomFloor = pCount * this.reg * n;
    for (let p = 0; p < pCount; p++) {
      const idx = (this.refHead + p) % pCount;
      const sr = this.refSpecRe[idx]!;
      const si = this.refSpecIm[idx]!;
      for (let k = 0; k < n; k++) {
        const norm = effMu / (this.smoothPx[k]! + denomFloor);
        const er = this.eRe[k]!;
        const ei = this.eIm[k]!;
        const xr = sr[k]!;
        const xi = si[k]!;
        // conj(X) * E
        this.gRe[k] = (xr * er + xi * ei) * norm;
        this.gIm[k] = (xr * ei - xi * er) * norm;
      }
      fftRadix2(this.gRe, this.gIm, true);
      for (let i = b; i < n; i++) {
        this.gRe[i] = 0;
        this.gIm[i] = 0;
      }
      for (let i = 0; i < b; i++) {
        this.gIm[i] = 0;
      }
      fftRadix2(this.gRe, this.gIm, false);
      const wRe = this.weightsRe[p]!;
      const wIm = this.weightsIm[p]!;
      for (let k = 0; k < n; k++) {
        wRe[k] = wRe[k]! + this.gRe[k]!;
        wIm[k] = wIm[k]! + this.gIm[k]!;
      }
    }
    this.wTimeDirty = true;
    void micBlock;
    void micOffset;
  }

  private processAlignedBlock(
    mic: Float32Array,
    micOffset: number,
    ref: Float32Array,
    refOffset: number,
    out: Float32Array,
    outOffset: number,
  ): void {
    const b = this.blockSize;
    const n = this.fftSize;
    const pCount = this.numPartitions;

    let refEnergy = 0;
    let micEnergy = 0;
    for (let i = 0; i < b; i++) {
      const r = ref[refOffset + i]!;
      const m = mic[micOffset + i]!;
      refEnergy += r * r;
      micEnergy += m * m;
    }
    const blockRefRms = Math.sqrt(refEnergy / b);
    if (blockRefRms < this.refActiveThreshold) {
      this.silentBlocks++;
    } else {
      this.silentBlocks = 0;
    }

    if (this.silentBlocks > 2) {
      for (let i = 0; i < b; i++) {
        out[outOffset + i] = mic[micOffset + i]!;
        this.prevRefBlock[i] = ref[refOffset + i]!;
      }
      this.pushRefHistoryBlock(ref, refOffset);
      return;
    }

    this.activeBlocks++;

    // Shift partition ring and compute FFT([prevRefBlock, refCurrBlock])
    this.refHead = (this.refHead + pCount - 1) % pCount;
    const xRe = this.refSpecRe[this.refHead]!;
    const xIm = this.refSpecIm[this.refHead]!;
    for (let i = 0; i < b; i++) {
      xRe[i] = this.prevRefBlock[i]!;
      xRe[b + i] = ref[refOffset + i]!;
      xIm[i] = 0;
      xIm[b + i] = 0;
      this.prevRefBlock[i] = ref[refOffset + i]!;
    }
    fftRadix2(xRe, xIm, false);
    this.pushRefHistoryBlock(ref, refOffset);

    // Predict echo Y(k) = sum_p W_p(k) * X_{n-p}(k)
    this.yRe.fill(0);
    this.yIm.fill(0);
    for (let p = 0; p < pCount; p++) {
      const idx = (this.refHead + p) % pCount;
      const wRe = this.weightsRe[p]!;
      const wIm = this.weightsIm[p]!;
      const sr = this.refSpecRe[idx]!;
      const si = this.refSpecIm[idx]!;
      for (let k = 0; k < n; k++) {
        const wr = wRe[k]!;
        const wi = wIm[k]!;
        const xr = sr[k]!;
        const xi = si[k]!;
        this.yRe[k] = this.yRe[k]! + (wr * xr - wi * xi);
        this.yIm[k] = this.yIm[k]! + (wr * xi + wi * xr);
      }
    }
    fftRadix2(this.yRe, this.yIm, true);

    let errEnergy = 0;
    for (let i = 0; i < b; i++) {
      const e = mic[micOffset + i]! - this.yRe[b + i]!;
      out[outOffset + i] = e;
      errEnergy += e * e;
    }

    // Update power normalization
    for (let k = 0; k < n; k++) {
      let px = 0;
      for (let p = 0; p < pCount; p++) {
        const idx = (this.refHead + p) % pCount;
        const sr = this.refSpecRe[idx]![k]!;
        const si = this.refSpecIm[idx]![k]!;
        px += sr * sr + si * si;
      }
      this.smoothPx[k] = 0.72 * this.smoothPx[k]! + 0.28 * px;
    }

    this.smoothMicEnergy = this.smoothMicEnergy > 0
      ? 0.75 * this.smoothMicEnergy + 0.25 * micEnergy
      : micEnergy;
    this.smoothErrEnergy = this.smoothErrEnergy > 0
      ? 0.75 * this.smoothErrEnergy + 0.25 * errEnergy
      : errEnergy;

    // Safety clamp against divergence
    const micRms = Math.sqrt(micEnergy / b);
    const errRms = Math.sqrt(errEnergy / b);
    const diverged = this.activeBlocks > 8 && this.smoothErrEnergy > 1.25 * this.smoothMicEnergy;
    if (diverged) {
      for (let p = 0; p < pCount; p++) {
        const wRe = this.weightsRe[p]!;
        const wIm = this.weightsIm[p]!;
        for (let k = 0; k < n; k++) {
          wRe[k] = wRe[k]! * 0.96;
          wIm[k] = wIm[k]! * 0.96;
        }
      }
      this.wTimeDirty = true;
    } else if (refEnergy > 1e-10) {
      const doubleTalk = this.activeBlocks > 10 && this.smoothErrEnergy > 0.85 * this.smoothMicEnergy;
      const effMu = doubleTalk ? this.stepSize * 0.15 : this.stepSize;
      for (let i = 0; i < b; i++) {
        this.eRe[i] = 0;
        this.eIm[i] = 0;
        this.eRe[b + i] = out[outOffset + i]!;
        this.eIm[b + i] = 0;
      }
      fftRadix2(this.eRe, this.eIm, false);
      const denomFloor = pCount * this.reg * n;
      for (let p = 0; p < pCount; p++) {
        const idx = (this.refHead + p) % pCount;
        const sr = this.refSpecRe[idx]!;
        const si = this.refSpecIm[idx]!;
        for (let k = 0; k < n; k++) {
          const norm = effMu / (this.smoothPx[k]! + denomFloor);
          const er = this.eRe[k]!;
          const ei = this.eIm[k]!;
          const xr = sr[k]!;
          const xi = si[k]!;
          this.gRe[k] = (xr * er + xi * ei) * norm;
          this.gIm[k] = (xr * ei - xi * er) * norm;
        }
        fftRadix2(this.gRe, this.gIm, true);
        for (let i = b; i < n; i++) {
          this.gRe[i] = 0;
          this.gIm[i] = 0;
        }
        for (let i = 0; i < b; i++) {
          this.gIm[i] = 0;
        }
        fftRadix2(this.gRe, this.gIm, false);
        const wRe = this.weightsRe[p]!;
        const wIm = this.weightsIm[p]!;
        for (let k = 0; k < n; k++) {
          wRe[k] = wRe[k]! + this.gRe[k]!;
          wIm[k] = wIm[k]! + this.gIm[k]!;
        }
      }
      this.wTimeDirty = true;
    }

    if (errRms > micRms * 1.08 && micRms > 1e-6) {
      for (let i = 0; i < b; i++) {
        out[outOffset + i] = mic[micOffset + i]!;
      }
    }
  }

  private processSampleWithFir(micVal: number, refVal: number): number {
    const total = this.refRing.length;
    this.refRing[this.refRingWritePos] = refVal;
    const writePos = this.refRingWritePos;
    this.refRingWritePos = (this.refRingWritePos + 1) % total;

    if (Math.abs(refVal) < this.refActiveThreshold && this.silentBlocks > 2) {
      this.pendMic[this.pendLen] = micVal;
      this.pendRef[this.pendLen] = refVal;
      this.pendErr[this.pendLen] = micVal;
      this.pendLen++;
      if (this.pendLen === this.blockSize) {
        this.flushPendingBlock();
      }
      return micVal;
    }

    this.refreshWTimeIfNeeded();
    let echo = 0;
    for (let d = 0; d < total; d++) {
      const idx = (writePos - d + total) % total;
      echo += this.wTime[d]! * this.refRing[idx]!;
    }
    const err = micVal - echo;
    this.pendMic[this.pendLen] = micVal;
    this.pendRef[this.pendLen] = refVal;
    this.pendErr[this.pendLen] = err;
    this.pendLen++;
    if (this.pendLen === this.blockSize) {
      this.flushPendingBlock();
    }
    return err;
  }

  private flushPendingBlock(): void {
    const b = this.blockSize;
    let refEnergy = 0;
    let micEnergy = 0;
    let errEnergy = 0;
    for (let i = 0; i < b; i++) {
      const r = this.pendRef[i]!;
      const m = this.pendMic[i]!;
      const e = this.pendErr[i]!;
      refEnergy += r * r;
      micEnergy += m * m;
      errEnergy += e * e;
    }
    const blockRefRms = Math.sqrt(refEnergy / b);
    if (blockRefRms < this.refActiveThreshold) {
      this.silentBlocks++;
    } else {
      this.silentBlocks = 0;
    }
    if (this.silentBlocks <= 2) {
      this.activeBlocks++;
      this.updateWeightsFromBlock(
        this.pendMic,
        0,
        this.pendRef,
        0,
        this.pendErr,
        0,
        refEnergy,
        micEnergy,
        errEnergy,
      );
    } else {
      this.prevRefBlock.set(this.pendRef);
    }
    this.pendLen = 0;
  }

  /**
   * Process an arbitrary-length microphone chunk against its aligned speaker loopback reference,
   * returning an echo-cancelled `Float32Array` of identical length with zero buffering latency.
   */
  process(mic: Float32Array, ref: Float32Array): Float32Array {
    const len = mic.length;
    if (len === 0 || ref.length === 0) return mic;
    const usable = Math.min(len, ref.length);

    if (this.silentBlocks > 2 && calcRms(ref.subarray(0, usable)) < this.refActiveThreshold) {
      return mic;
    }

    const out = new Float32Array(len);
    let offset = 0;

    while (offset < usable && this.pendLen > 0) {
      out[offset] = this.processSampleWithFir(mic[offset]!, ref[offset]!);
      offset++;
    }

    while (offset + this.blockSize <= usable) {
      this.processAlignedBlock(mic, offset, ref, offset, out, offset);
      offset += this.blockSize;
    }

    while (offset < usable) {
      out[offset] = this.processSampleWithFir(mic[offset]!, ref[offset]!);
      offset++;
    }

    for (let i = usable; i < len; i++) {
      out[i] = mic[i]!;
    }
    return out;
  }
}

/**
 * Two-pass offline AEC for captured utterances: Pass 1 adapts the echo filter across the clip;
 * Pass 2 replays from sample 0 with learned weights preserved for full-clip echo cancellation.
 */
export function runOfflineAec(
  mic: Float32Array,
  ref: Float32Array,
  options?: PartitionedBlockAecOptions,
): { samples: Float32Array; echoReductionDb: number } {
  const usable = Math.min(mic.length, ref.length);
  if (usable === 0 || calcRms(ref.subarray(0, usable)) < (options?.refActiveThreshold ?? 1e-4)) {
    return { samples: mic, echoReductionDb: 0 };
  }
  const aec = new PartitionedBlockAec(options);
  aec.process(mic, ref);
  aec.reset({ keepWeights: true });
  const cleaned = aec.process(mic, ref);

  const inRms = calcRms(mic);
  const outRms = calcRms(cleaned);
  const echoReductionDb = inRms > 1e-7 && outRms > 1e-8
    ? Math.max(0, 20 * Math.log10(inRms / outRms))
    : 0;
  return { samples: cleaned, echoReductionDb };
}

function medianNumber(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

const ONLINE_BEAM_ANGLES_DEG = [0, 60, 120, 180, 240, 300] as const;
const ONLINE_BEAM_HISTORY = 4;
const ONLINE_BEAM_CROSSFADE_SAMPLES = 64;

/**
 * Lightweight causal 6-beam hexagonal shift-and-sum beamformer for always-on streaming KWS & VAD.
 * Evaluates 6 cardinal azimuths (60° spacing), tracks per-beam noise floors,
 * and smoothly switches toward higher-SNR speech directions while ignoring dead channels.
 */
export class OnlineHexBeamformer {
  private readonly micCount: number;
  private readonly delayInt: Int32Array[];
  private readonly delayFrac: Float64Array[];
  private readonly micHist: Float32Array[];
  private readonly prevBeamSample = new Float64Array(ONLINE_BEAM_ANGLES_DEG.length);
  private readonly beamAmbientRms = new Float64Array(ONLINE_BEAM_ANGLES_DEG.length);
  private readonly beamSnrBuf = new Float64Array(ONLINE_BEAM_ANGLES_DEG.length);
  private activeBeam = 0;

  private paddedMics: Float32Array[] = [];
  private beamOutputs: Float32Array[] = [];

  constructor(
    sampleRate = FRONTEND_SAMPLE_RATE,
    coords = LX06_HEX_MIC_COORDS,
  ) {
    this.micCount = coords.length;
    this.micHist = Array.from({ length: this.micCount }, () => new Float32Array(ONLINE_BEAM_HISTORY));
    this.delayInt = [];
    this.delayFrac = [];

    for (let b = 0; b < ONLINE_BEAM_ANGLES_DEG.length; b++) {
      const rad = (ONLINE_BEAM_ANGLES_DEG[b]! * Math.PI) / 180;
      const cosT = Math.cos(rad);
      const sinT = Math.sin(rad);
      const rawTau = coords.map(([xm, ym]) => ((xm * cosT + ym * sinT) / SPEED_OF_SOUND_MPS) * sampleRate);
      let minTau = Infinity;
      for (const t of rawTau) {
        if (t < minTau) minTau = t;
      }
      const dInt = new Int32Array(this.micCount);
      const dFrac = new Float64Array(this.micCount);
      for (let m = 0; m < this.micCount; m++) {
        // Wavefront from +u reaches closer mics earlier -> delay closer mics more so all align at tau_min
        const d = Math.max(0, Math.min(ONLINE_BEAM_HISTORY - 0.001, rawTau[m]! - minTau));
        const k = Math.floor(d);
        dInt[m] = k;
        dFrac[m] = d - k;
      }
      this.delayInt.push(dInt);
      this.delayFrac.push(dFrac);
    }
  }

  reset(): void {
    for (const h of this.micHist) h.fill(0);
    this.prevBeamSample.fill(0);
    this.beamAmbientRms.fill(0);
    this.beamSnrBuf.fill(0);
    this.activeBeam = 0;
  }

  process(mics: readonly Float32Array[]): { samples: Float32Array; activeBeam: number; azimuthDeg: number } {
    const numSamples = mics[0]?.length ?? 0;
    if (numSamples === 0 || mics.length === 0) {
      return {
        samples: new Float32Array(0),
        activeBeam: this.activeBeam,
        azimuthDeg: ONLINE_BEAM_ANGLES_DEG[this.activeBeam] ?? 0,
      };
    }

    const activeMics = Math.min(mics.length, this.micCount);
    if (activeMics < 2) {
      return {
        samples: new Float32Array(mics[0]!),
        activeBeam: this.activeBeam,
        azimuthDeg: ONLINE_BEAM_ANGLES_DEG[this.activeBeam] ?? 0,
      };
    }

    const rmsList: number[] = [];
    for (let m = 0; m < activeMics; m++) {
      rmsList.push(calcRms(mics[m]!));
    }
    const medRms = medianNumber(rmsList);
    const healthyIndices: number[] = [];
    for (let m = 0; m < activeMics; m++) {
      const r = rmsList[m]!;
      if (r > 1e-6 && (medRms <= 0 || (r >= medRms * 0.2 && r <= medRms * 5.0))) {
        healthyIndices.push(m);
      }
    }

    const paddedLen = ONLINE_BEAM_HISTORY + numSamples;
    while (this.paddedMics.length < activeMics) {
      this.paddedMics.push(new Float32Array(paddedLen));
    }
    for (let m = 0; m < activeMics; m++) {
      if (this.paddedMics[m]!.length < paddedLen) {
        this.paddedMics[m] = new Float32Array(paddedLen);
      }
      const dst = this.paddedMics[m]!;
      const hist = this.micHist[m]!;
      const src = mics[m]!;
      dst.set(hist, 0);
      dst.set(src, ONLINE_BEAM_HISTORY);
      if (numSamples >= ONLINE_BEAM_HISTORY) {
        hist.set(src.subarray(numSamples - ONLINE_BEAM_HISTORY));
      } else {
        hist.copyWithin(0, numSamples);
        hist.set(src, ONLINE_BEAM_HISTORY - numSamples);
      }
    }

    if (healthyIndices.length < 2) {
      return {
        samples: new Float32Array(mics[0]!),
        activeBeam: this.activeBeam,
        azimuthDeg: ONLINE_BEAM_ANGLES_DEG[this.activeBeam] ?? 0,
      };
    }

    while (this.beamOutputs.length < ONLINE_BEAM_ANGLES_DEG.length) {
      this.beamOutputs.push(new Float32Array(numSamples));
    }

    const invM = 1 / healthyIndices.length;
    for (let b = 0; b < ONLINE_BEAM_ANGLES_DEG.length; b++) {
      if (this.beamOutputs[b]!.length !== numSamples) {
        this.beamOutputs[b] = new Float32Array(numSamples);
      }
      const out = this.beamOutputs[b]!;
      out.fill(0);
      const dInt = this.delayInt[b]!;
      const dFrac = this.delayFrac[b]!;
      for (let hPos = 0; hPos < healthyIndices.length; hPos++) {
        const m = healthyIndices[hPos]!;
        const pad = this.paddedMics[m]!;
        const k = dInt[m]!;
        const f = dFrac[m]!;
        const w0 = (1 - f) * invM;
        const w1 = f * invM;
        const base = ONLINE_BEAM_HISTORY - k;
        for (let t = 0; t < numSamples; t++) {
          out[t] = out[t]! + pad[base + t]! * w0 + pad[base + t - 1]! * w1;
        }
      }

      // Score beam directivity after pre-emphasis so sub-800Hz omnidirectional rumble
      // does not mask crisp 1.5-4.5kHz array directivity when selecting active beam.
      let hpSumSq = 0;
      let prev = this.prevBeamSample[b]!;
      for (let t = 0; t < numSamples; t++) {
        const s = out[t]!;
        const hp = s - 0.85 * prev;
        prev = s;
        hpSumSq += hp * hp;
      }
      this.prevBeamSample[b] = prev;
      const rms = Math.sqrt(hpSumSq / numSamples);
      const amb = this.beamAmbientRms[b]!;
      if (amb <= 0) {
        this.beamAmbientRms[b] = Math.max(0.00012, rms);
      } else if (rms < amb) {
        this.beamAmbientRms[b] = 0.85 * amb + 0.15 * rms;
      } else if (rms <= amb * 2.2) {
        this.beamAmbientRms[b] = 0.97 * amb + 0.03 * rms;
      }
      this.beamSnrBuf[b] = rms / Math.max(0.00012, this.beamAmbientRms[b]!);
    }

    let bestBeam = 0;
    let bestSnr = -1;
    for (let b = 0; b < ONLINE_BEAM_ANGLES_DEG.length; b++) {
      const snr = this.beamSnrBuf[b]!;
      if (snr > bestSnr) {
        bestSnr = snr;
        bestBeam = b;
      }
    }

    const prevBeam = this.activeBeam;
    const prevSnr = this.beamSnrBuf[prevBeam] ?? 0;
    if (
      bestBeam !== prevBeam
      && bestSnr >= 1.35
      && bestSnr > prevSnr * 1.18
    ) {
      this.activeBeam = bestBeam;
      const prevArr = this.beamOutputs[prevBeam]!;
      const nextArr = this.beamOutputs[bestBeam]!;
      const out = new Float32Array(nextArr);
      const fadeLen = Math.min(ONLINE_BEAM_CROSSFADE_SAMPLES, numSamples);
      for (let i = 0; i < fadeLen; i++) {
        const alpha = (i + 1) / (fadeLen + 1);
        out[i] = prevArr[i]! * (1 - alpha) + nextArr[i]! * alpha;
      }
      return {
        samples: out,
        activeBeam: bestBeam,
        azimuthDeg: ONLINE_BEAM_ANGLES_DEG[bestBeam]!,
      };
    }

    return {
      samples: new Float32Array(this.beamOutputs[this.activeBeam]!),
      activeBeam: this.activeBeam,
      azimuthDeg: ONLINE_BEAM_ANGLES_DEG[this.activeBeam] ?? 0,
    };
  }
}

/**
 * 6-mic GCC-PHAT DOA estimation + STFT Delay-and-Sum beamforming using LX06 hexagonal geometry.
 * Eliminates high-frequency comb filtering across arbitrary azimuths while rejecting dead channels.
 */
export function beamformHexArray(
  mics: readonly Float32Array[],
  sampleRate = FRONTEND_SAMPLE_RATE,
  coords = LX06_HEX_MIC_COORDS,
): { samples: Float32Array; azimuthDeg: number; usedChannels: number } {
  if (mics.length === 0) {
    return { samples: new Float32Array(0), azimuthDeg: 0, usedChannels: 0 };
  }
  const numSamples = mics[0]?.length ?? 0;
  if (mics.length < 2 || numSamples < 512) {
    return { samples: mics[0] ?? new Float32Array(0), azimuthDeg: 0, usedChannels: mics.length };
  }

  // Filter healthy mic channels with similar gain
  const rmsList = mics.map(m => calcRms(m));
  const medRms = medianNumber(rmsList);
  const healthyIndices: number[] = [];
  for (let i = 0; i < mics.length && i < coords.length; i++) {
    const r = rmsList[i] ?? 0;
    if (r > 1e-6 && (medRms <= 0 || (r >= medRms * 0.2 && r <= medRms * 5.0))) {
      healthyIndices.push(i);
    }
  }
  if (healthyIndices.length < 2) {
    return { samples: mics[0]!, azimuthDeg: 0, usedChannels: healthyIndices.length || 1 };
  }

  const fftSize = 512;
  const hop = 256;
  const halfBins = fftSize / 2 + 1; // 0..256
  const kMin = Math.max(1, Math.floor((300 * fftSize) / sampleRate));
  const kMax = Math.min(halfBins - 1, Math.ceil((4000 * fftSize) / sampleRate));

  const hann = new Float64Array(fftSize);
  for (let n = 0; n < fftSize; n++) {
    hann[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / fftSize));
  }

  const frameStarts: number[] = [];
  for (let start = 0; start < numSamples; start += hop) {
    frameStarts.push(start);
    if (start + fftSize >= numSamples) break;
  }
  if (frameStarts.length === 0) frameStarts.push(0);

  // Measure reference energy on first healthy channel to select active speech frames for DOA
  const refMic = mics[healthyIndices[0]!]!;
  const frameRms = frameStarts.map((start) => {
    const end = Math.min(numSamples, start + fftSize);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const v = refMic[i] ?? 0;
      sumSq += v * v;
    }
    return Math.sqrt(sumSq / Math.max(1, end - start));
  });
  const sortedRms = [...frameRms].sort((a, b) => a - b);
  const p90Rms = sortedRms[Math.min(sortedRms.length - 1, Math.floor(sortedRms.length * 0.9))] ?? 0;
  const activeGate = p90Rms * 0.25;

  const healthySet = new Set(healthyIndices);
  const activePairs = HEX_ADJACENT_AND_DIAMETRIC_PAIRS.filter(([a, b]) => healthySet.has(a) && healthySet.has(b));
  const pairs = activePairs.length > 0
    ? activePairs
    : healthyIndices.slice(1).map((idx) => [healthyIndices[0]!, idx] as const);

  // Accumulate PHAT-weighted cross-spectra on active frames
  const pairGRe = pairs.map(() => new Float64Array(kMax + 1));
  const pairGIm = pairs.map(() => new Float64Array(kMax + 1));

  // Precompute per-frame STFT spectra across healthy channels so we only run FFT once per frame per channel
  const channelSpectraRe = healthyIndices.map(() => frameStarts.map(() => new Float64Array(halfBins)));
  const channelSpectraIm = healthyIndices.map(() => frameStarts.map(() => new Float64Array(halfBins)));
  const fftRe = new Float64Array(fftSize);
  const fftIm = new Float64Array(fftSize);

  const healthyPosByChannel = new Map<number, number>();
  healthyIndices.forEach((chIdx, pos) => healthyPosByChannel.set(chIdx, pos));

  for (let f = 0; f < frameStarts.length; f++) {
    const start = frameStarts[f]!;
    const isActiveFrame = (frameRms[f] ?? 0) >= activeGate && activeGate > 1e-7;
    for (let hPos = 0; hPos < healthyIndices.length; hPos++) {
      const chIdx = healthyIndices[hPos]!;
      const micArr = mics[chIdx]!;
      fftRe.fill(0);
      fftIm.fill(0);
      const copyLen = Math.min(fftSize, numSamples - start);
      for (let n = 0; n < copyLen; n++) {
        fftRe[n] = micArr[start + n]! * hann[n]!;
      }
      fftRadix2(fftRe, fftIm, false);
      const outRe = channelSpectraRe[hPos]![f]!;
      const outIm = channelSpectraIm[hPos]![f]!;
      for (let k = 0; k < halfBins; k++) {
        outRe[k] = fftRe[k]!;
        outIm[k] = fftIm[k]!;
      }
    }

    if (isActiveFrame) {
      for (let pIdx = 0; pIdx < pairs.length; pIdx++) {
        const [chA, chB] = pairs[pIdx]!;
        const posA = healthyPosByChannel.get(chA)!;
        const posB = healthyPosByChannel.get(chB)!;
        const aRe = channelSpectraRe[posA]![f]!;
        const aIm = channelSpectraIm[posA]![f]!;
        const bRe = channelSpectraRe[posB]![f]!;
        const bIm = channelSpectraIm[posB]![f]!;
        const gRe = pairGRe[pIdx]!;
        const gIm = pairGIm[pIdx]!;
        for (let k = kMin; k <= kMax; k++) {
          const ar = aRe[k]!;
          const ai = aIm[k]!;
          const br = bRe[k]!;
          const bi = bIm[k]!;
          // Cross-spectrum X_a * conj(X_b) with PHAT normalization
          const cr = ar * br + ai * bi;
          const ci = ai * br - ar * bi;
          const mag = Math.hypot(cr, ci);
          if (mag > 1e-12) {
            gRe[k] = gRe[k]! + cr / mag;
            gIm[k] = gIm[k]! + ci / mag;
          }
        }
      }
    }
  }

  const scoreCandidate = (azDeg: number, elevScale: number): number => {
    const rad = (azDeg * Math.PI) / 180;
    const cosT = Math.cos(rad);
    const sinT = Math.sin(rad);
    let score = 0;
    for (let pIdx = 0; pIdx < pairs.length; pIdx++) {
      const [chA, chB] = pairs[pIdx]!;
      const [xa, ya] = coords[chA]!;
      const [xb, yb] = coords[chB]!;
      const deltaSamples = elevScale * (((xa - xb) * cosT + (ya - yb) * sinT) / SPEED_OF_SOUND_MPS) * sampleRate;
      const gRe = pairGRe[pIdx]!;
      const gIm = pairGIm[pIdx]!;
      const omegaStep = (-2 * Math.PI * deltaSamples) / fftSize;
      // Recurrence for e^{j * k * omegaStep} avoids per-bin trig calls
      const stepRe = Math.cos(omegaStep);
      const stepIm = Math.sin(omegaStep);
      let phasorRe = Math.cos(kMin * omegaStep);
      let phasorIm = Math.sin(kMin * omegaStep);
      for (let k = kMin; k <= kMax; k++) {
        score += gRe[k]! * phasorRe - gIm[k]! * phasorIm;
        const nextRe = phasorRe * stepRe - phasorIm * stepIm;
        phasorIm = phasorRe * stepIm + phasorIm * stepRe;
        phasorRe = nextRe;
      }
    }
    return score;
  };

  // Coarse SRP-PHAT grid search across azimuths and elevation projections without broadside zero collapse
  let bestAz = 0;
  let bestElev = 1.0;
  let bestScore = -Infinity;

  for (const elevScale of [1.0, 0.78]) {
    for (let az = 0; az < 360; az += 15) {
      const s = scoreCandidate(az, elevScale);
      if (s > bestScore) {
        bestScore = s;
        bestAz = az;
        bestElev = elevScale;
      }
    }
  }
  if (!Number.isFinite(bestScore)) {
    bestAz = 0;
    bestElev = 0;
  }

  // Fine azimuth refinement around coarse peak
  if (bestElev > 0) {
    const centerAz = bestAz;
    for (let offset = -10; offset <= 10; offset += 2) {
      const az = (centerAz + offset + 360) % 360;
      const s = scoreCandidate(az, bestElev);
      if (s > bestScore) {
        bestScore = s;
        bestAz = az;
      }
    }
  }

  // Precompute steering phase shifts e^{-j 2 pi k tau_m / N} per healthy mic
  const rad = (bestAz * Math.PI) / 180;
  const cosT = Math.cos(rad);
  const sinT = Math.sin(rad);
  const steerRe = healthyIndices.map(() => new Float64Array(halfBins));
  const steerIm = healthyIndices.map(() => new Float64Array(halfBins));
  for (let hPos = 0; hPos < healthyIndices.length; hPos++) {
    const chIdx = healthyIndices[hPos]!;
    const [xm, ym] = coords[chIdx]!;
    const tauSamples = bestElev * ((xm * cosT + ym * sinT) / SPEED_OF_SOUND_MPS) * sampleRate;
    const sRe = steerRe[hPos]!;
    const sIm = steerIm[hPos]!;
    for (let k = 0; k < halfBins; k++) {
      const phase = (-2 * Math.PI * k * tauSamples) / fftSize;
      sRe[k] = Math.cos(phase);
      sIm[k] = Math.sin(phase);
    }
  }

  // STFT Delay-and-Sum synthesis with exact COLA Hann^2 normalization
  const out = new Float32Array(numSamples);
  const norm = new Float64Array(numSamples);
  const invM = 1 / healthyIndices.length;
  const fullRe = new Float64Array(fftSize);
  const fullIm = new Float64Array(fftSize);

  for (let f = 0; f < frameStarts.length; f++) {
    fullRe.fill(0);
    fullIm.fill(0);
    for (let hPos = 0; hPos < healthyIndices.length; hPos++) {
      const specRe = channelSpectraRe[hPos]![f]!;
      const specIm = channelSpectraIm[hPos]![f]!;
      const wRe = steerRe[hPos]!;
      const wIm = steerIm[hPos]!;
      for (let k = 0; k < halfBins; k++) {
        const xr = specRe[k]!;
        const xi = specIm[k]!;
        const wr = wRe[k]!;
        const wi = wIm[k]!;
        fullRe[k] = fullRe[k]! + (xr * wr - xi * wi) * invM;
        fullIm[k] = fullIm[k]! + (xr * wi + xi * wr) * invM;
      }
    }
    // Reconstruct Hermitian conjugate bins for real time-domain output
    fullIm[0] = 0;
    fullIm[fftSize / 2] = 0;
    for (let k = 1; k < fftSize / 2; k++) {
      fullRe[fftSize - k] = fullRe[k]!;
      fullIm[fftSize - k] = -fullIm[k]!;
    }
    fftRadix2(fullRe, fullIm, true);

    const start = frameStarts[f]!;
    const copyLen = Math.min(fftSize, numSamples - start);
    for (let n = 0; n < copyLen; n++) {
      const w = hann[n]!;
      out[start + n] = out[start + n]! + fullRe[n]! * w;
      norm[start + n] = norm[start + n]! + w * w;
    }
  }

  for (let i = 0; i < numSamples; i++) {
    const denom = norm[i]!;
    if (denom > 1e-6) {
      out[i] = out[i]! / denom;
    }
  }

  return {
    samples: out,
    azimuthDeg: bestAz,
    usedChannels: healthyIndices.length,
  };
}

/**
 * Full multi-channel utterance front-end: 6-channel offline AEC (when speaker loopback is active)
 * followed by 6-mic GCC-PHAT DOA + STFT Delay-and-Sum beamforming.
 */
export function processMultiChannelUtterance(
  mics: readonly Float32Array[],
  ref: Float32Array | undefined,
  sampleRate = FRONTEND_SAMPLE_RATE,
): { samples: Float32Array; azimuthDeg: number; aecApplied: boolean; echoReductionDb: number } {
  if (mics.length === 0) {
    return { samples: new Float32Array(0), azimuthDeg: 0, aecApplied: false, echoReductionDb: 0 };
  }

  let processedMics: readonly Float32Array[] = mics;
  let aecApplied = false;
  let echoReductionDb = 0;

  if (ref && ref.length > 0 && calcRms(ref) >= 1e-4) {
    aecApplied = true;
    let totalDb = 0;
    const cleanedMics: Float32Array[] = [];
    for (const ch of mics) {
      const res = runOfflineAec(ch, ref);
      cleanedMics.push(res.samples);
      totalDb += res.echoReductionDb;
    }
    processedMics = cleanedMics;
    echoReductionDb = totalDb / Math.max(1, mics.length);
  }

  const beamformed = beamformHexArray(processedMics, sampleRate);
  return {
    samples: beamformed.samples,
    azimuthDeg: beamformed.azimuthDeg,
    aecApplied,
    echoReductionDb,
  };
}

const inFlightDenoiserDownloads = new Map<string, Promise<string>>();

function resolveDenoiserModelFile(denoiserModelsDir: string): string | undefined {
  if (!denoiserModelsDir || !existsSync(denoiserModelsDir)) return undefined;
  const preferred = join(denoiserModelsDir, DENOISER_MODEL_FILENAME);
  if (existsSync(preferred)) return preferred;
  try {
    const files = readdirSync(denoiserModelsDir)
      .filter(name => name.endsWith('.onnx') && !name.endsWith('.part'))
      .sort();
    return files[0] ? join(denoiserModelsDir, files[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** Download `gtcrn_simple.onnx` atomically with single-flight deduplication. */
export async function ensureXiaoaiDenoiserModel(options: {
  homeDir: string;
  denoiserModelsDir?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<string> {
  const dir = options.denoiserModelsDir ?? join(options.homeDir, 'xiaoai-kws', 'denoiser');
  const existing = resolveDenoiserModelFile(dir);
  if (existing) return existing;

  const inflight = inFlightDenoiserDownloads.get(dir);
  if (inflight) return inflight;

  const task = (async () => {
    const again = resolveDenoiserModelFile(dir);
    if (again) return again;

    mkdirSync(dir, { recursive: true });
    const targetPath = join(dir, DENOISER_MODEL_FILENAME);
    const partPath = `${targetPath}.part.${process.pid}`;
    const fetchFn = options.fetchImpl ?? globalThis.fetch;
    const customUrl = process.env.FRIDAY_DENOISER_MODEL_URL?.trim();
    const urls = customUrl ? [customUrl, ...DEFAULT_DENOISER_MODEL_URLS] : [...DEFAULT_DENOISER_MODEL_URLS];

    let lastError: unknown;
    for (const url of urls) {
      rmSync(partPath, { force: true });
      try {
        const timeoutSignal = AbortSignal.timeout(45_000);
        const signal = options.signal ? AbortSignal.any([timeoutSignal, options.signal]) : timeoutSignal;
        const res = await fetchFn(url, { method: 'GET', redirect: 'follow', signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const totalHeader = Number(res.headers.get('content-length') ?? 0);
        if (Number.isFinite(totalHeader) && totalHeader > MAX_DENOISER_MODEL_BYTES) {
          throw new Error(`降噪模型体积超出上限 (${totalHeader} > ${MAX_DENOISER_MODEL_BYTES})`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > MAX_DENOISER_MODEL_BYTES) {
          throw new Error(`降噪模型体积超出上限 (${buf.byteLength} > ${MAX_DENOISER_MODEL_BYTES})`);
        }
        if (buf.byteLength < MIN_DENOISER_MODEL_BYTES) {
          throw new Error(`下载文件过小 (${buf.byteLength} bytes < ${MIN_DENOISER_MODEL_BYTES})`);
        }
        writeFileSync(partPath, buf);
        renameSync(partPath, targetPath);
        return targetPath;
      } catch (err) {
        lastError = err;
        rmSync(partPath, { force: true });
      }
    }
    throw new Error(
      `降噪模型下载失败: ${lastError instanceof Error ? lastError.message : String(lastError ?? '未知错误')}`,
    );
  })().finally(() => {
    inFlightDenoiserDownloads.delete(dir);
  });

  inFlightDenoiserDownloads.set(dir, task);
  return task;
}

function defaultDenoiserFactory(config: { modelPath: string }): XiaoaiAudioDenoiser {
  const req = createRequire(import.meta.url);
  const sherpa = req('sherpa-onnx-node') as {
    OfflineSpeechDenoiser: new (cfg: {
      model: {
        gtcrn: { model: string };
        numThreads: number;
        provider: string;
        debug: number;
      };
    }) => {
      sampleRate: number;
      run: (input: { samples: Float32Array; sampleRate: number }) => { samples?: Float32Array; sampleRate?: number };
    };
  };
  const denoiser = new sherpa.OfflineSpeechDenoiser({
    model: {
      gtcrn: { model: config.modelPath },
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
  });
  return {
    denoise: (samples, sampleRate) => {
      const out = denoiser.run({ samples, sampleRate });
      if (!out?.samples || out.samples.length === 0) return samples;
      return out.samples;
    },
  };
}

/** Lazy GTCRN neural speech denoiser wrapper with non-fatal fallback to raw input on failure. */
export class XiaoaiSpeechDenoiserManager {
  readonly denoiserModelsDir: string;
  private denoiser?: XiaoaiAudioDenoiser;
  private loadedModelPath?: string;
  private disabledAfterError = false;

  constructor(private readonly options: {
    homeDir: string;
    denoiserModelsDir?: string;
    denoiserFactory?: (config: { modelPath: string }) => XiaoaiAudioDenoiser;
  }) {
    this.denoiserModelsDir = options.denoiserModelsDir ?? join(options.homeDir, 'xiaoai-kws', 'denoiser');
  }

  isModelReady(): boolean {
    if (this.options.denoiserFactory) return true;
    return Boolean(resolveDenoiserModelFile(this.denoiserModelsDir));
  }

  private ensureDenoiser(): XiaoaiAudioDenoiser | undefined {
    if (this.disabledAfterError) return undefined;
    const modelPath = this.options.denoiserFactory
      ? 'custom'
      : resolveDenoiserModelFile(this.denoiserModelsDir);
    if (!modelPath) return undefined;
    if (this.denoiser && this.loadedModelPath === modelPath) {
      return this.denoiser;
    }
    try {
      this.denoiser?.free?.();
      const factory = this.options.denoiserFactory ?? defaultDenoiserFactory;
      this.denoiser = factory({ modelPath });
      this.loadedModelPath = modelPath;
      return this.denoiser;
    } catch (err) {
      this.disabledAfterError = true;
      console.warn('[xiaoai-denoiser] 初始化 GTCRN 失败，自动回退原始波形:', err instanceof Error ? err.message : String(err));
      return undefined;
    }
  }

  denoise(samples: Float32Array, sampleRate = FRONTEND_SAMPLE_RATE): Float32Array {
    if (samples.length < 320) return samples;
    const denoiser = this.ensureDenoiser();
    if (!denoiser) return samples;
    try {
      const inputRms = calcRms(samples);
      const out = denoiser.denoise(samples, sampleRate);
      if (!out || out.length === 0) return samples;
      const outRms = calcRms(out);
      if (!Number.isFinite(outRms) || (inputRms > 1e-4 && outRms < 1e-6)) {
        return samples;
      }
      return out;
    } catch {
      return samples;
    }
  }

  async denoiseAsync(samples: Float32Array, sampleRate = FRONTEND_SAMPLE_RATE): Promise<Float32Array> {
    await new Promise<void>(resolve => setImmediate(resolve));
    return this.denoise(samples, sampleRate);
  }

  close(): void {
    this.denoiser?.free?.();
    this.denoiser = undefined;
    this.loadedModelPath = undefined;
  }
}

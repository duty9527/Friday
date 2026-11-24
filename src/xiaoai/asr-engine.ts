import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_GEMINI_DECISION_BASE_URL } from '../decision.js';
import { buildRequestSignal, sanitizeImError } from '../im/types.js';
import { resolveEnv } from '../paths.js';
import { normalizeUtteranceSamples } from './audio-frontend.js';
import { stripLeadingAsrControlTags } from './utterance-utils.js';

export const DEFAULT_GEMINI_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe';
export const DEFAULT_GEMINI_LIVE_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live';
export const DEFAULT_GEMINI_TRANSCRIBE_TIMEOUT_MS = 6_500;
export const DEFAULT_GEMINI_LIVE_FINISH_TIMEOUT_MS = 1_800;
const HOTWORD_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_HOTWORDS = 100;

const CURATED_DEFAULT_HOTWORDS: readonly string[] = [
  '星期五',
  '你好星期五',
  'Friday',
  '尼特利',
  '尼特利鱼缸灯',
  '鱼缸灯',
  '乌龟灯',
  '徕芬',
  '徕芬牙刷',
  '九号',
  '小九',
  '九号电动车',
  '体脂秤',
  '称体重',
  '测量体重',
  '空气炸锅',
  '小爱音箱',
  '电视遥控模式',
  '遥控电视模式',
  '退出遥控',
  '录入我的声纹',
  '声纹列表',
  '客厅灯',
  '卧室灯',
  '书房灯',
  '客厅空调',
  '卧室空调',
  '打开B站',
  '打印机',
  '刷牙',
  '听歌',
  '播放音乐',
  '停止播放',
  '切歌',
  '下一首',
  '上一首',
];

const hotwordCache = new Map<string, { at: number; terms: string[] }>();

export interface AsrTranscribeOptions {
  localOnly?: boolean;
  preferFastLocal?: boolean;
  hotwords?: readonly string[];
}

export interface AsrRecognizerHandle {
  transcribe: (samples: Float32Array, sampleRate: number, options?: AsrTranscribeOptions) => Promise<string>;
  free?: () => void;
}

export interface GoogleApiCredentials {
  apiKey: string;
  baseUrl?: string;
}

export interface LiveAsrWebSocketLike {
  readonly readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  addEventListener?: (
    type: 'open' | 'message' | 'error' | 'close',
    listener: (event: unknown) => void,
  ) => void;
  onopen?: ((event: unknown) => void) | null;
  onmessage?: ((event: unknown) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  onclose?: ((event: unknown) => void) | null;
}

export interface LiveAsrResult {
  text: string;
  latencyMs: number;
  interimFallback?: boolean;
}

export interface LiveAsrSession {
  pushSamples: (samples: Float32Array) => void;
  finish: (options?: { timeoutMs?: number }) => Promise<LiveAsrResult | undefined>;
  abort: () => void;
  isUsable: () => boolean;
}

/** Encode normalized `[-1, 1]` Float32 mono audio into a 44-byte RIFF/WAVE `pcm_s16le` Buffer. */
export function encodeFloat32ToWavBuffer(samples: Float32Array, sampleRate = 16_000): Buffer {
  const safeRate = Math.max(8_000, Math.round(sampleRate));
  const dataBytes = samples.length * 2;
  const buf = Buffer.allocUnsafe(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(safeRate, 24);
  buf.writeUInt32LE(safeRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    const clamped = Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
    const intVal = Math.max(-32768, Math.min(32767, Math.round(clamped * 32767)));
    buf.writeInt16LE(intVal, 44 + i * 2);
  }
  return buf;
}

/** Resolve the Gemini Interactions endpoint for `gemini-3.5-transcribe`. */
export function resolveGeminiTranscribeEndpoint(baseUrl?: string): string {
  const clean = (baseUrl?.trim() || DEFAULT_GEMINI_DECISION_BASE_URL).replace(/\/+$/, '');
  if (clean.endsWith('/interactions')) return clean;
  if (/\/v\d+(?:alpha|beta)?$/i.test(clean)) return `${clean}/interactions`;
  return `${clean}/v1beta/interactions`;
}

/** Resolve the Gemini Live BidiGenerateContent WebSocket URL for `gemini-3.5-transcribe-live`. */
export function resolveGeminiLiveTranscribeWsUrl(baseUrl?: string, apiKey?: string): string {
  const raw = (baseUrl?.trim() || DEFAULT_GEMINI_DECISION_BASE_URL).replace(/\/+$/, '');
  const withScheme = raw.includes('://') ? raw : `https://${raw}`;
  let host = 'generativelanguage.googleapis.com';
  let wsProto = 'wss:';
  try {
    const parsed = new URL(withScheme);
    if (parsed.host) host = parsed.host;
    wsProto = parsed.protocol === 'http:' || parsed.protocol === 'ws:' ? 'ws:' : 'wss:';
  } catch {
    wsProto = withScheme.startsWith('http://') || withScheme.startsWith('ws://') ? 'ws:' : 'wss:';
  }
  const baseWs = `${wsProto}//${host}/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
  const trimmedKey = apiKey?.trim();
  return trimmedKey ? `${baseWs}?key=${encodeURIComponent(trimmedKey)}` : baseWs;
}

function readJsonFileSafe(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function pushHotword(out: string[], seen: Set<string>, raw: unknown, maxTerms: number): void {
  if (out.length >= maxTerms || typeof raw !== 'string') return;
  const term = raw.trim();
  if (term.length < 2 || term.length > 24) return;
  if (/[\uFFFD\u0000-\u001F]/.test(term)) return;
  const key = term.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(term);
}

/**
 * Collect prioritized domain hotwords (user overrides, voiceprint names, health-scale profiles,
 * MIoT devices/rooms, Ninebot/Netlea names, curated defaults, and music artists) with 60s caching.
 */
export function collectVoiceHotwords(
  homeDir: string,
  options?: { forceRefresh?: boolean; maxTerms?: number },
): string[] {
  const maxTerms = Math.max(1, Math.min(1000, Math.floor(options?.maxTerms ?? DEFAULT_MAX_HOTWORDS)));
  const envRaw = resolveEnv('FRIDAY_ASR_HOTWORDS') ?? '';
  const cacheKey = `${homeDir}::${maxTerms}::${envRaw}`;
  const now = Date.now();
  if (!options?.forceRefresh) {
    const cached = hotwordCache.get(cacheKey);
    if (cached && now - cached.at < HOTWORD_CACHE_TTL_MS) {
      return cached.terms;
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();

  // 1. Explicit hotwords file + env overrides (highest priority)
  const hotwordsFile = join(homeDir, 'xiaoai-kws', 'hotwords.txt');
  if (existsSync(hotwordsFile)) {
    try {
      const lines = readFileSync(hotwordsFile, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const clean = line.replace(/#.*$/, '').trim();
        pushHotword(out, seen, clean, maxTerms);
      }
    } catch {
      // Ignore unreadable custom hotwords
    }
  }
  if (envRaw.trim()) {
    for (const part of envRaw.split(/[,，]/)) {
      pushHotword(out, seen, part, maxTerms);
    }
  }

  // 2. Enrolled voiceprint speaker names
  const speakersDoc = readJsonFileSafe(join(homeDir, 'xiaoai-kws', 'speakers.json'));
  if (Array.isArray(speakersDoc?.profiles)) {
    for (const prof of speakersDoc.profiles) {
      if (prof && typeof prof === 'object') {
        pushHotword(out, seen, (prof as { name?: unknown }).name, maxTerms);
      }
    }
  }

  // 3. Health-scale user profiles (SQLite + config fallback)
  const healthDbPath = join(homeDir, 'plugins', 'health-scale', 'health.db');
  if (existsSync(healthDbPath)) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(healthDbPath, { readOnly: true });
      const rows = db.prepare('SELECT name FROM profiles').all() as Array<{ name?: unknown }>;
      for (const row of rows) {
        pushHotword(out, seen, row.name, maxTerms);
      }
    } catch {
      // Ignore SQLite read issues
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
  const healthCfg = readJsonFileSafe(join(homeDir, 'plugins', 'health-scale', 'config.json'));
  if (healthCfg?.defaultProfile && typeof healthCfg.defaultProfile === 'object') {
    pushHotword(out, seen, (healthCfg.defaultProfile as { name?: unknown }).name, maxTerms);
  }

  // 4. MIoT device and room names
  const hubCache = readJsonFileSafe(join(homeDir, 'plugins', 'miot', 'hub-cache.json'));
  if (Array.isArray(hubCache?.devices)) {
    for (const dev of hubCache.devices) {
      if (!dev || typeof dev !== 'object') continue;
      const rec = dev as { name?: unknown; room?: unknown; room_name?: unknown };
      if (typeof rec.name === 'string') {
        const trimmed = rec.name.trim();
        if (!/^[A-Za-z0-9_-]{8,}$/.test(trimmed)) {
          pushHotword(out, seen, trimmed, maxTerms);
        }
      }
      pushHotword(out, seen, rec.room, maxTerms);
      pushHotword(out, seen, rec.room_name, maxTerms);
    }
  }

  // 5. Ninebot vehicle name & Netlea preset names
  const ninebotCfg = readJsonFileSafe(join(homeDir, 'plugins', 'ninebot', 'config.json'));
  pushHotword(out, seen, ninebotCfg?.deviceName, maxTerms);

  const netleaCfg = readJsonFileSafe(join(homeDir, 'plugins', 'netlea', 'config.json'));
  const presets = netleaCfg?.savedCustomPresets;
  if (Array.isArray(presets)) {
    for (const p of presets) {
      if (p && typeof p === 'object') {
        pushHotword(out, seen, (p as { name?: unknown }).name, maxTerms);
      }
    }
  } else if (presets && typeof presets === 'object') {
    for (const key of Object.keys(presets)) {
      pushHotword(out, seen, key, maxTerms);
    }
  }

  // 6. Curated core domain terms
  for (const term of CURATED_DEFAULT_HOTWORDS) {
    pushHotword(out, seen, term, maxTerms);
  }

  // 7. Music artists (up to 15 unique artists)
  const musicLib = readJsonFileSafe(join(homeDir, 'plugins', 'music', 'library.json'));
  if (Array.isArray(musicLib?.tracks)) {
    let addedArtists = 0;
    for (const track of musicLib.tracks) {
      if (addedArtists >= 15 || out.length >= maxTerms) break;
      if (!track || typeof track !== 'object') continue;
      const artistRaw = (track as { artist?: unknown }).artist;
      if (typeof artistRaw !== 'string') continue;
      for (const part of artistRaw.split(/[/,&、]/)) {
        const clean = part.trim();
        if (clean.length < 2 || /^[A-Za-z0-9\s]{1,2}$/.test(clean)) continue;
        const before = out.length;
        pushHotword(out, seen, clean, maxTerms);
        if (out.length > before) {
          addedArtists++;
          if (addedArtists >= 15) break;
        }
      }
    }
  }

  hotwordCache.set(cacheKey, { at: now, terms: out });
  return out;
}

function extractGeminiTranscribeText(payload: unknown): {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
} {
  if (!payload || typeof payload !== 'object') {
    return { text: '' };
  }
  const obj = payload as {
    output_text?: unknown;
    steps?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }>;
    outputs?: Array<{ type?: unknown; text?: unknown }>;
    usage?: { total_input_tokens?: unknown; total_output_tokens?: unknown };
  };

  let text = '';
  if (Array.isArray(obj.steps)) {
    const parts: string[] = [];
    for (const step of obj.steps) {
      if (!step || !Array.isArray(step.content)) continue;
      for (const block of step.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
    }
    text = parts.join('');
  }
  if (!text && typeof obj.output_text === 'string') {
    text = obj.output_text;
  }
  if (!text && Array.isArray(obj.outputs)) {
    const parts: string[] = [];
    for (const block of obj.outputs) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
    text = parts.join('');
  }

  const inputTokens = typeof obj.usage?.total_input_tokens === 'number'
    ? obj.usage.total_input_tokens
    : undefined;
  const outputTokens = typeof obj.usage?.total_output_tokens === 'number'
    ? obj.usage.total_output_tokens
    : undefined;

  return {
    text: stripLeadingAsrControlTags(text),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

/**
 * Transcribe mono PCM audio inline via Google `gemini-3.5-transcribe` (`verbatim` mode + hotwords).
 */
export async function transcribeWithGemini(params: {
  samples: Float32Array;
  sampleRate: number;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  hotwords?: readonly string[];
  languageCodes?: readonly string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ text: string; latencyMs: number; inputTokens?: number; outputTokens?: number }> {
  const normalized = normalizeUtteranceSamples(params.samples);
  const wavBuf = encodeFloat32ToWavBuffer(normalized, params.sampleRate);
  const audioB64 = wavBuf.toString('base64');
  const endpoint = resolveGeminiTranscribeEndpoint(params.baseUrl);
  const model = params.model?.trim() || DEFAULT_GEMINI_TRANSCRIBE_MODEL;
  const languageCodes = params.languageCodes?.length ? [...params.languageCodes] : ['cmn-Hans-CN'];
  const hotwords = (params.hotwords ?? []).map(h => h.trim()).filter(Boolean).slice(0, 1000);

  const transcriptionConfig: Record<string, unknown> = {
    language_codes: languageCodes,
    mode: 'verbatim',
    ...(hotwords.length > 0 ? { custom_vocabulary: hotwords } : {}),
  };

  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const startedAt = performance.now();
  let res: Response;
  try {
    res = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'x-goog-api-key': params.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: [
          {
            type: 'audio',
            data: audioB64,
            mime_type: 'audio/wav',
          },
        ],
        generation_config: {
          transcription_config: transcriptionConfig,
        },
      }),
      signal: buildRequestSignal(params.timeoutMs ?? DEFAULT_GEMINI_TRANSCRIBE_TIMEOUT_MS, params.signal),
    });
  } catch (err) {
    throw new Error(`Gemini Transcribe 请求失败: ${sanitizeImError(err, [params.apiKey])}`);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Gemini Transcribe HTTP ${res.status}: ${sanitizeImError(errBody.slice(0, 240), [params.apiKey])}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error(`Gemini Transcribe 响应解析失败: ${sanitizeImError(err, [params.apiKey])}`);
  }

  const parsed = extractGeminiTranscribeText(json);
  const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
  return {
    text: parsed.text,
    latencyMs,
    ...(parsed.inputTokens !== undefined ? { inputTokens: parsed.inputTokens } : {}),
    ...(parsed.outputTokens !== undefined ? { outputTokens: parsed.outputTokens } : {}),
  };
}

function resolveAsrProviderMode(): 'auto' | 'gemini' | 'local' {
  const raw = resolveEnv('FRIDAY_ASR_PROVIDER')?.trim().toLowerCase();
  if (raw === 'local' || raw === 'gemini') return raw;
  return 'auto';
}

function resolveAsrTimeoutMs(): number {
  const raw = Number(resolveEnv('FRIDAY_ASR_TIMEOUT_MS'));
  return Number.isFinite(raw) && raw >= 1000 && raw <= 30_000
    ? Math.round(raw)
    : DEFAULT_GEMINI_TRANSCRIBE_TIMEOUT_MS;
}

/**
 * Create a hybrid ASR recognizer using `gemini-3.5-transcribe` with dynamic hotwords and
 * seamless local SenseVoice fallback (or local-first routing for wake rescue / TV remote fastpaths).
 */
export function createHybridAsrRecognizer(options: {
  homeDir: string;
  resolveGoogleCredentials?: () => Promise<GoogleApiCredentials | undefined>;
  localRecognizerFactory: () => Promise<AsrRecognizerHandle | undefined>;
  fetchImpl?: typeof fetch;
}): AsrRecognizerHandle {
  let localRecognizer: AsrRecognizerHandle | undefined;
  let localRecognizerPromise: Promise<AsrRecognizerHandle | undefined> | undefined;
  let closed = false;

  const getLocalRecognizer = async (): Promise<AsrRecognizerHandle | undefined> => {
    if (closed) return undefined;
    if (localRecognizer) return localRecognizer;
    if (!localRecognizerPromise) {
      localRecognizerPromise = options.localRecognizerFactory()
        .then((rec) => {
          if (closed) {
            rec?.free?.();
            return undefined;
          }
          localRecognizer = rec;
          return rec;
        })
        .catch(() => {
          localRecognizerPromise = undefined;
          return undefined;
        });
    }
    return localRecognizerPromise;
  };

  const runLocal = async (samples: Float32Array, sampleRate: number): Promise<string | undefined> => {
    const rec = await getLocalRecognizer();
    if (!rec || closed) return undefined;
    const t0 = performance.now();
    const raw = await rec.transcribe(samples, sampleRate, { localOnly: true });
    const latencyMs = Math.max(0, Math.round(performance.now() - t0));
    const durSec = (samples.length / Math.max(1, sampleRate)).toFixed(2);
    console.log(`[xiaoai-asr] engine=local-sensevoice dur=${durSec}s ms=${latencyMs}`);
    return stripLeadingAsrControlTags(raw);
  };

  return {
    transcribe: async (samples, sampleRate, transcribeOpts) => {
      if (closed) return '';
      const providerMode = resolveAsrProviderMode();
      const model = resolveEnv('FRIDAY_ASR_MODEL')?.trim() || DEFAULT_GEMINI_TRANSCRIBE_MODEL;
      const timeoutMs = resolveAsrTimeoutMs();
      const durSec = (samples.length / Math.max(1, sampleRate)).toFixed(2);

      if (transcribeOpts?.localOnly) {
        return (await runLocal(samples, sampleRate)) ?? '';
      }

      if (transcribeOpts?.preferFastLocal || providerMode === 'local') {
        const localText = await runLocal(samples, sampleRate);
        if (localText !== undefined) return localText;
        if (providerMode === 'local') return '';
      }

      if (options.resolveGoogleCredentials) {
        let creds: GoogleApiCredentials | undefined;
        try {
          creds = await options.resolveGoogleCredentials();
        } catch {
          creds = undefined;
        }
        if (creds?.apiKey) {
          try {
            const hotwords = transcribeOpts?.hotwords ?? collectVoiceHotwords(options.homeDir);
            const result = await transcribeWithGemini({
              samples,
              sampleRate,
              apiKey: creds.apiKey,
              baseUrl: creds.baseUrl,
              model,
              hotwords,
              timeoutMs,
              fetchImpl: options.fetchImpl,
            });
            console.log(
              `[xiaoai-asr] engine=${model} dur=${durSec}s ms=${result.latencyMs} in=${result.inputTokens ?? '-'} out=${result.outputTokens ?? '-'}`,
            );
            return result.text;
          } catch (err) {
            const msg = sanitizeImError(err, [creds.apiKey]);
            console.warn(`[xiaoai-asr] cloud failed (${msg}), falling back to local ASR`);
          }
        }
      }

      return (await runLocal(samples, sampleRate)) ?? '';
    },
    free: () => {
      closed = true;
      localRecognizer?.free?.();
      localRecognizer = undefined;
      localRecognizerPromise = undefined;
    },
  };
}

class StreamingPcmEncoder {
  private readonly chunkBytes: number;
  private envPeak = 0;
  private initialized = false;
  private tail: Buffer = Buffer.alloc(0);

  constructor(chunkSamples = 1600) {
    this.chunkBytes = Math.max(320, Math.trunc(chunkSamples) * 2);
  }

  push(samples: Float32Array): Buffer[] {
    if (samples.length === 0) return [];
    let chunkPeak = 0;
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i] ?? 0);
      if (abs > chunkPeak) chunkPeak = abs;
    }
    if (!this.initialized) {
      if (chunkPeak >= 1e-4) {
        this.envPeak = chunkPeak;
        this.initialized = true;
      }
    } else if (chunkPeak > this.envPeak) {
      this.envPeak = 0.65 * chunkPeak + 0.35 * this.envPeak;
    } else {
      this.envPeak = Math.max(0.001, 0.96 * this.envPeak + 0.04 * chunkPeak);
    }

    const effectivePeak = this.initialized ? Math.max(0.001, this.envPeak) : 0.006;
    const gain = Math.min(180, Math.max(1, 0.45 / effectivePeak));
    const pcm = Buffer.allocUnsafe(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      const raw = samples[i] ?? 0;
      const safe = Number.isFinite(raw) ? raw : 0;
      const limited = Math.tanh((safe * gain) / 0.92) * 0.92;
      const intVal = Math.max(-32768, Math.min(32767, Math.round(limited * 32767)));
      pcm.writeInt16LE(intVal, i * 2);
    }

    const merged = this.tail.length > 0 ? Buffer.concat([this.tail, pcm]) : pcm;
    const out: Buffer[] = [];
    let offset = 0;
    while (offset + this.chunkBytes <= merged.length) {
      out.push(Buffer.from(merged.subarray(offset, offset + this.chunkBytes)));
      offset += this.chunkBytes;
    }
    this.tail = offset < merged.length ? Buffer.from(merged.subarray(offset)) : Buffer.alloc(0);
    return out;
  }

  flushRemaining(): Buffer | undefined {
    if (this.tail.length === 0) return undefined;
    const rem = this.tail;
    this.tail = Buffer.alloc(0);
    return rem;
  }
}

async function decodeWsMessageData(data: unknown): Promise<string | undefined> {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (data && typeof (data as { text?: unknown }).text === 'function') {
    return await (data as { text: () => Promise<string> }).text();
  }
  return undefined;
}

function createNoopLiveAsrSession(): LiveAsrSession {
  return {
    pushSamples: () => {},
    finish: async () => undefined,
    abort: () => {},
    isUsable: () => false,
  };
}

/**
 * Open a streaming `gemini-3.5-transcribe-live` WebSocket session with causal AGC, pre-handshake
 * audio queueing, live interim/final transcript tracking, and bounded post-speech timeout.
 */
export function createGeminiLiveTranscribeSession(params: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  hotwords?: readonly string[];
  languageCodes?: readonly string[];
  sampleRate?: number;
  connectTimeoutMs?: number;
  webSocketFactory?: (url: string) => LiveAsrWebSocketLike;
  onLogError?: (message: string) => void;
}): LiveAsrSession {
  const apiKey = params.apiKey?.trim();
  const WsCtor = (globalThis as { WebSocket?: new (url: string) => LiveAsrWebSocketLike }).WebSocket;
  const createWs = params.webSocketFactory ?? (WsCtor ? (url: string) => new WsCtor(url) : undefined);
  if (!apiKey || !createWs) {
    return createNoopLiveAsrSession();
  }

  const secrets = [apiKey];
  const sanitize = (err: unknown): string => sanitizeImError(err, secrets);
  const sampleRate = Math.max(8_000, Math.round(params.sampleRate ?? 16_000));
  const mimeType = `audio/pcm;rate=${sampleRate}`;
  const rawModel = params.model?.trim() || DEFAULT_GEMINI_LIVE_TRANSCRIBE_MODEL;
  const modelPath = rawModel.startsWith('models/') ? rawModel : `models/${rawModel}`;
  const languageCodes = params.languageCodes?.length ? [...params.languageCodes] : ['cmn-Hans-CN'];
  const hotwords = (params.hotwords ?? []).map(h => h.trim()).filter(Boolean).slice(0, 100);
  const connectTimeoutMs = Math.max(250, params.connectTimeoutMs ?? 3_000);

  let ws: LiveAsrWebSocketLike;
  try {
    ws = createWs(resolveGeminiLiveTranscribeWsUrl(params.baseUrl, apiKey));
  } catch (err) {
    params.onLogError?.(`Live ASR 连接创建失败: ${sanitize(err)}`);
    return createNoopLiveAsrSession();
  }

  const encoder = new StreamingPcmEncoder(Math.round(sampleRate * 0.1));
  const pendingChunks: string[] = [];
  const finalSegments: string[] = [];
  let latestInterim = '';
  let setupComplete = false;
  let audioEndSent = false;
  let sawTurnDone = false;
  let aborted = false;
  let errored = false;
  let closed = false;
  let finishing = false;
  let finishPromise: Promise<LiveAsrResult | undefined> | undefined;
  let msgChain: Promise<void> = Promise.resolve();
  let setupWaiters: Array<() => void> = [];
  let turnWaiters: Array<() => void> = [];
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const notifySetupWaiters = () => {
    const waiters = setupWaiters;
    setupWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const notifyTurnWaiters = () => {
    if (graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
    const waiters = turnWaiters;
    turnWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const closeWsQuietly = () => {
    try {
      if (ws.readyState === 0 || ws.readyState === 1) {
        ws.close(1000, 'done');
      }
    } catch {
      // Ignore close errors
    }
  };

  const safeSend = (payload: unknown): boolean => {
    if (aborted || errored || closed || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (err) {
      errored = true;
      params.onLogError?.(`Live ASR 发送失败: ${sanitize(err)}`);
      notifySetupWaiters();
      notifyTurnWaiters();
      return false;
    }
  };

  const sendAudioB64 = (b64: string) => {
    safeSend({
      realtimeInput: {
        audio: {
          data: b64,
          mimeType,
        },
      },
    });
  };

  const flushPendingChunks = () => {
    while (pendingChunks.length > 0 && !aborted && !errored && !closed && ws.readyState === 1) {
      const b64 = pendingChunks.shift();
      if (b64) sendAudioB64(b64);
    }
  };

  const abort = () => {
    if (aborted) return;
    aborted = true;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    pendingChunks.length = 0;
    notifySetupWaiters();
    notifyTurnWaiters();
    closeWsQuietly();
  };

  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    if (!finishing && !aborted) {
      abort();
    }
  }, 25_000);
  idleTimer.unref?.();

  const handleOpen = () => {
    if (aborted || errored || closed) return;
    const transcriptionSetup: Record<string, unknown> = {
      languageCodes,
      ...(hotwords.length > 0 ? { customVocabulary: hotwords } : {}),
    };
    safeSend({
      setup: {
        model: modelPath,
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: transcriptionSetup,
      },
    });
  };

  const handleParsedMessage = (raw: string) => {
    if (aborted || !raw) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.error !== undefined) {
      errored = true;
      const errDetail = typeof msg.error === 'string'
        ? msg.error
        : JSON.stringify(msg.error).slice(0, 240);
      params.onLogError?.(`Live ASR 服务端错误: ${sanitize(errDetail)}`);
      notifySetupWaiters();
      notifyTurnWaiters();
      return;
    }

    if (msg.setupComplete !== undefined && !setupComplete) {
      setupComplete = true;
      flushPendingChunks();
      notifySetupWaiters();
    }

    const sc = msg.serverContent as {
      inputTranscription?: { text?: unknown };
      interimInputTranscription?: { text?: unknown };
      generationComplete?: unknown;
      turnComplete?: unknown;
    } | undefined;
    if (!sc || typeof sc !== 'object') return;

    if (typeof sc.inputTranscription?.text === 'string' && sc.inputTranscription.text.length > 0) {
      finalSegments.push(sc.inputTranscription.text);
      latestInterim = '';
    }
    if (typeof sc.interimInputTranscription?.text === 'string') {
      latestInterim = sc.interimInputTranscription.text;
    }
    if (sc.generationComplete === true || sc.turnComplete === true) {
      sawTurnDone = true;
    }

    if (audioEndSent && sawTurnDone) {
      if (finalSegments.length > 0) {
        notifyTurnWaiters();
      } else if (!graceTimer) {
        graceTimer = setTimeout(() => {
          graceTimer = undefined;
          notifyTurnWaiters();
        }, 35);
        graceTimer.unref?.();
      }
    }
  };

  const handleMessage = (ev: unknown) => {
    const rawData = (ev as { data?: unknown })?.data ?? ev;
    msgChain = msgChain
      .then(async () => {
        const text = await decodeWsMessageData(rawData);
        if (text !== undefined) handleParsedMessage(text);
      })
      .catch(() => {});
  };

  const handleError = (ev: unknown) => {
    if (errored) return;
    errored = true;
    const rawErr = (ev as { error?: unknown; message?: unknown })?.error
      ?? (ev as { message?: unknown })?.message
      ?? 'WebSocket error';
    params.onLogError?.(`Live ASR 连接异常: ${sanitize(rawErr)}`);
    notifySetupWaiters();
    notifyTurnWaiters();
  };

  const handleClose = (ev: unknown) => {
    closed = true;
    const closeEv = ev as { code?: unknown; reason?: unknown } | undefined;
    if (!aborted && !finishing && typeof closeEv?.code === 'number' && closeEv.code !== 1000) {
      const reason = typeof closeEv.reason === 'string' && closeEv.reason ? ` ${closeEv.reason}` : '';
      params.onLogError?.(`Live ASR 连接关闭 (code=${closeEv.code}${sanitize(reason)})`);
    }
    notifySetupWaiters();
    notifyTurnWaiters();
  };

  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener('open', handleOpen);
    ws.addEventListener('message', handleMessage);
    ws.addEventListener('error', handleError);
    ws.addEventListener('close', handleClose);
  } else {
    ws.onopen = handleOpen;
    ws.onmessage = handleMessage;
    ws.onerror = handleError;
    ws.onclose = handleClose;
  }

  return {
    isUsable: () => !aborted && !errored && !closed,
    pushSamples: (samples) => {
      if (aborted || errored || closed || finishing || audioEndSent) return;
      const packets = encoder.push(samples);
      for (const packet of packets) {
        const b64 = packet.toString('base64');
        if (setupComplete && ws.readyState === 1) {
          sendAudioB64(b64);
        } else {
          if (pendingChunks.length >= 150) {
            pendingChunks.shift();
          }
          pendingChunks.push(b64);
        }
      }
    },
    finish: (options) => {
      if (finishPromise) return finishPromise;
      finishing = true;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }

      finishPromise = (async (): Promise<LiveAsrResult | undefined> => {
        const timeoutMs = Math.max(200, options?.timeoutMs ?? DEFAULT_GEMINI_LIVE_FINISH_TIMEOUT_MS);
        const startedAt = performance.now();

        if (!setupComplete && !aborted && !errored && !closed) {
          const setupWaitBudget = Math.min(timeoutMs, connectTimeoutMs, 800);
          await new Promise<void>((resolve) => {
            if (setupComplete || aborted || errored || closed) {
              resolve();
              return;
            }
            const timer = setTimeout(() => {
              setupWaiters = setupWaiters.filter(fn => fn !== done);
              done();
            }, setupWaitBudget);
            timer.unref?.();
            const done = () => {
              clearTimeout(timer);
              resolve();
            };
            setupWaiters.push(done);
          });
          await msgChain;
        }

        if (!setupComplete || aborted || errored || closed || ws.readyState !== 1) {
          await msgChain;
          abort();
          return undefined;
        }

        flushPendingChunks();
        const tailPcm = encoder.flushRemaining();
        if (tailPcm && tailPcm.length > 0) {
          sendAudioB64(tailPcm.toString('base64'));
        }
        if (finalSegments.length === 0) {
          sawTurnDone = false;
        }
        audioEndSent = true;
        if (!safeSend({ realtimeInput: { audioStreamEnd: true } })) {
          abort();
          return undefined;
        }

        await new Promise<void>((resolve) => {
          if (aborted || errored || closed || (sawTurnDone && finalSegments.length > 0)) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            turnWaiters = turnWaiters.filter(fn => fn !== done);
            done();
          }, timeoutMs);
          timer.unref?.();
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          turnWaiters.push(done);
          if (sawTurnDone && !graceTimer) {
            graceTimer = setTimeout(() => {
              graceTimer = undefined;
              notifyTurnWaiters();
            }, 35);
            graceTimer.unref?.();
          }
        });

        await msgChain;
        if (graceTimer) {
          clearTimeout(graceTimer);
          graceTimer = undefined;
        }
        closeWsQuietly();

        const finalText = stripLeadingAsrControlTags(finalSegments.join('')).trim();
        const interimText = stripLeadingAsrControlTags(latestInterim).trim();
        const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
        if (finalText) {
          return { text: finalText, latencyMs };
        }
        if (interimText) {
          return { text: interimText, latencyMs, interimFallback: true };
        }
        return undefined;
      })();

      return finishPromise;
    },
    abort,
  };
}

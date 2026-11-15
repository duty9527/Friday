import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';

export const DEFAULT_SEMANTIC_MODEL_REPO = 'Xenova/bge-small-zh-v1.5';
export const DEFAULT_SEMANTIC_DIM = 512;
export const DEFAULT_SEMANTIC_MAX_LENGTH = 512;
export const DEFAULT_SEMANTIC_CACHE_ENTRIES = 512;
export const BGE_QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章：';

export const SEMANTIC_MIRROR_BASES = [
  'https://modelscope.cn',
  'https://hf-mirror.com',
  'https://huggingface.co',
] as const;

export type EmbeddingPurpose = 'query' | 'document';

export interface SemanticEmbedder {
  readonly modelId: string;
  readonly dim: number;
  isReady(): boolean;
  ensureReady?(signal?: AbortSignal): Promise<boolean>;
  embed(text: string, purpose?: EmbeddingPurpose): Promise<Float32Array | undefined>;
  embedBatch?(texts: string[], purpose?: EmbeddingPurpose): Promise<Array<Float32Array | undefined>>;
  close?(): Promise<void> | void;
}

export interface SemanticTokenizerEncoding {
  ids: number[];
  tokens?: string[];
  attention_mask: number[];
  token_type_ids?: number[];
}

export interface SemanticTokenizerLike {
  encode(
    text: string,
    options?: {
      text_pair?: string | null;
      add_special_tokens?: boolean;
      return_token_type_ids?: boolean | null;
    },
  ): SemanticTokenizerEncoding;
  token_to_id?(token: string): number | undefined;
}

export interface SemanticTensorLike {
  readonly dims: readonly number[];
  readonly type: string;
  readonly data: ArrayLike<number> | BigInt64Array;
}

export interface SemanticSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, SemanticTensorLike>>;
  release?(): Promise<void> | void;
}

export interface SemanticEngineOptions {
  homeDir: string;
  modelsDir?: string;
  modelRepo?: string;
  dim?: number;
  maxLength?: number;
  maxCacheEntries?: number;
  autoDownload?: boolean;
  disabled?: boolean;
  fetchImpl?: typeof fetch;
  tokenizerFactory?: (paths: { tokenizerPath: string; tokenizerConfigPath?: string }) => Promise<SemanticTokenizerLike> | SemanticTokenizerLike;
  sessionFactory?: (paths: { modelPath: string }) => Promise<SemanticSessionLike> | SemanticSessionLike;
}

type OrtModule = typeof import('onnxruntime-node');

const inFlightFileDownloads = new Map<string, Promise<string>>();

const EN_STOPWORDS = new Set([
  'about', 'after', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'done', 'down', 'during',
  'each', 'even', 'few', 'for', 'from', 'further',
  'get', 'give', 'go', 'good', 'got',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how',
  'if', 'in', 'into', 'is', 'it', 'its', 'just',
  'know', 'let', 'like', 'look',
  'made', 'make', 'many', 'may', 'me', 'more', 'most', 'much', 'must', 'my',
  'new', 'no', 'nor', 'not', 'now',
  'of', 'off', 'old', 'on', 'once', 'one', 'only', 'onto', 'or', 'other', 'our', 'out', 'over', 'own',
  'put', 'same', 'say', 'see', 'she', 'should', 'so', 'some', 'such',
  'take', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'time', 'to', 'too',
  'under', 'until', 'up', 'upon', 'us', 'use', 'used', 'using',
  'very', 'want', 'was', 'way', 'we', 'well', 'were', 'what', 'when', 'where', 'which', 'while',
  'who', 'whom', 'why', 'will', 'with', 'would',
  'you', 'your',
]);

const ZH_STOPWORDS = new Set([
  '我们', '你们', '他们', '她们', '它们', '自己', '大家',
  '这个', '那个', '这些', '那些', '这里', '那里', '这样', '那样',
  '什么', '怎么', '怎样', '如何', '为何', '为什么', '哪里', '哪个', '哪些',
  '可以', '可能', '应该', '需要', '必须', '能够', '愿意',
  '没有', '不是', '就是', '还是', '或者', '以及', '并且', '而且', '然后', '接着',
  '因为', '所以', '如果', '假如', '虽然', '但是', '不过', '然而', '即使',
  '已经', '正在', '将要', '曾经', '一直', '依然', '仍然',
  '一个', '一些', '一样', '一般', '一下', '一起', '一种',
  '进行', '通过', '使用', '采用', '利用', '实现', '完成',
  '相关', '关于', '对于', '由于', '作为', '根据', '按照', '围绕',
  '问题', '情况', '时候', '方面', '内容', '结果', '方式',
  '现在', '目前', '当前', '之前', '之后', '以上', '以下', '其中',
]);

const ZH_PARTICLE_CHARS = new Set(['的', '了', '吗', '呢', '吧', '啊', '呀', '哇', '嘛', '哦']);

function parseFalseLike(value: string | undefined): boolean {
  if (!value) return false;
  return ['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

function parseTrueLike(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function isSemanticDisabled(options: SemanticEngineOptions): boolean {
  if (options.disabled) return true;
  if (parseTrueLike(process.env.FRIDAY_SEMANTIC_DISABLED)) return true;
  if (parseFalseLike(process.env.FRIDAY_SEMANTIC)) return true;
  return false;
}

function resolveAutoDownload(options: SemanticEngineOptions): boolean {
  if (options.autoDownload !== undefined) return options.autoDownload;
  const envVal = process.env.FRIDAY_SEMANTIC_AUTO_DOWNLOAD;
  if (envVal === undefined) return true;
  return envVal.trim() !== '0' && !parseFalseLike(envVal);
}

function sanitizeRepoDirName(repo: string): string {
  const cleaned = repo
    .trim()
    .replace(/[\\/]+/g, '--')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return cleaned || 'default';
}

function inferModelDim(modelRepo: string, explicitDim?: number): number {
  if (typeof explicitDim === 'number' && Number.isInteger(explicitDim) && explicitDim > 0) {
    return explicitDim;
  }
  const lower = modelRepo.toLowerCase();
  if (lower.includes('bge-small-en') || lower.includes('minilm')) return 384;
  if (lower.includes('bge-base-')) return 768;
  if (lower.includes('bge-large-') || lower.includes('bge-m3')) return 1024;
  return DEFAULT_SEMANTIC_DIM;
}

function isBgeModel(modelRepo: string): boolean {
  const lower = modelRepo.toLowerCase();
  return /(?:^|\/|[_-])bge(?:$|[-_])/.test(lower) || lower.includes('bge-');
}

function buildMirrorUrls(modelRepo: string, relativePath: string): string[] {
  const encodedRepo = modelRepo
    .trim()
    .split('/')
    .filter(Boolean)
    .map(seg => encodeURIComponent(seg))
    .join('/');
  const cleanRel = relativePath.replace(/^\/+/, '');
  return SEMANTIC_MIRROR_BASES.map(base => {
    if (base === 'https://modelscope.cn') {
      return `https://modelscope.cn/api/v1/models/${encodedRepo}/repo?Revision=master&FilePath=${encodeURIComponent(cleanRel)}`;
    }
    return `${base}/${encodedRepo}/resolve/main/${cleanRel}`;
  });
}

async function readResponseBytes(res: Response): Promise<Uint8Array> {
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    if (chunks.length === 1) return chunks[0]!;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function downloadFileWithMirrors(params: {
  urls: string[];
  destPath: string;
  fetchImpl: typeof fetch;
  validateJson?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const { urls, destPath, fetchImpl, validateJson, signal } = params;
  if (existsSync(destPath)) return destPath;

  const existing = inFlightFileDownloads.get(destPath);
  if (existing) return existing;

  const task = (async () => {
    if (existsSync(destPath)) return destPath;
    await mkdir(dirname(destPath), { recursive: true });

    let lastError: unknown;
    for (const url of urls) {
      if (signal?.aborted) {
        throw new Error('Download aborted');
      }
      const tmpPath = `${destPath}.tmp.${process.pid}.${randomUUID()}`;
      try {
        const timeoutSignal = AbortSignal.timeout(120_000);
        const reqSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        const res = await fetchImpl(url, {
          method: 'GET',
          redirect: 'follow',
          signal: reqSignal,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const bytes = await readResponseBytes(res);
        if (bytes.byteLength === 0) {
          throw new Error('Empty response body');
        }
        if (validateJson) {
          const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Invalid JSON object');
          }
        }
        await writeFile(tmpPath, bytes);
        await rename(tmpPath, destPath);
        return destPath;
      } catch (err) {
        lastError = err;
        await rm(tmpPath, { force: true }).catch(() => {});
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Download failed'));
  })().finally(() => {
    inFlightFileDownloads.delete(destPath);
  });

  inFlightFileDownloads.set(destPath, task);
  return task;
}

async function defaultTokenizerFactory(paths: {
  tokenizerPath: string;
  tokenizerConfigPath?: string;
}): Promise<SemanticTokenizerLike> {
  const rawTokenizer = await readFile(paths.tokenizerPath, 'utf8');
  const parsed = JSON.parse(rawTokenizer) as Record<string, unknown>;
  const normalizedTokenizerJson = {
    normalizer: null,
    pre_tokenizer: null,
    post_processor: null,
    decoder: null,
    added_tokens: [],
    ...parsed,
  };
  let config: Record<string, unknown> = {};
  if (paths.tokenizerConfigPath && existsSync(paths.tokenizerConfigPath)) {
    try {
      const rawCfg = await readFile(paths.tokenizerConfigPath, 'utf8');
      const parsedCfg = JSON.parse(rawCfg) as unknown;
      if (parsedCfg && typeof parsedCfg === 'object' && !Array.isArray(parsedCfg)) {
        config = parsedCfg as Record<string, unknown>;
      }
    } catch {
      config = {};
    }
  }
  return new Tokenizer(normalizedTokenizerJson, config);
}

let cachedOrtPromise: Promise<OrtModule | undefined> | undefined;

async function tryImportOrt(): Promise<OrtModule | undefined> {
  if (!cachedOrtPromise) {
    cachedOrtPromise = import('onnxruntime-node')
      .then(mod => mod)
      .catch(() => undefined);
  }
  return cachedOrtPromise;
}

async function defaultSessionFactory(paths: { modelPath: string }): Promise<SemanticSessionLike> {
  const ort = await tryImportOrt();
  if (!ort?.InferenceSession) {
    throw new Error('onnxruntime-node is unavailable');
  }
  const session = await ort.InferenceSession.create(paths.modelPath, {
    executionProviders: ['cpu'],
  });
  return session as unknown as SemanticSessionLike;
}

function createInt64Tensor(
  ort: OrtModule | undefined,
  data: BigInt64Array,
  dims: [number, number],
): unknown {
  if (ort?.Tensor) {
    return new ort.Tensor('int64', data, dims);
  }
  return { type: 'int64', data, dims };
}

function poolOutputToVectors(params: {
  tensor: SemanticTensorLike;
  batchSize: number;
  seqLen: number;
  attentionMasks: BigInt64Array;
  useClsPooling: boolean;
  preferMeanPooling: boolean;
}): Array<Float32Array | undefined> {
  const { tensor, batchSize, seqLen, attentionMasks, useClsPooling, preferMeanPooling } = params;
  const dims = tensor.dims;
  const raw = tensor.data as ArrayLike<number>;
  const results: Array<Float32Array | undefined> = new Array(batchSize).fill(undefined);

  if (dims.length === 1 && batchSize === 1) {
    const dim = dims[0] ?? raw.length;
    if (dim > 0 && raw.length >= dim) {
      const slice = new Float32Array(dim);
      for (let d = 0; d < dim; d++) {
        slice[d] = Number(raw[d]);
      }
      results[0] = l2Normalize(slice);
    }
    return results;
  }

  if (dims.length === 2) {
    const hiddenDim = dims[1] ?? 0;
    if (hiddenDim <= 0) return results;
    for (let b = 0; b < batchSize; b++) {
      const start = b * hiddenDim;
      if (start + hiddenDim > raw.length) break;
      const slice = new Float32Array(hiddenDim);
      for (let d = 0; d < hiddenDim; d++) {
        slice[d] = Number(raw[start + d]);
      }
      results[b] = l2Normalize(slice);
    }
    return results;
  }

  if (dims.length === 3) {
    const outSeqLen = dims[1] ?? seqLen;
    const hiddenDim = dims[2] ?? 0;
    if (outSeqLen <= 0 || hiddenDim <= 0) return results;

    for (let b = 0; b < batchSize; b++) {
      const batchOffset = b * outSeqLen * hiddenDim;
      if (useClsPooling && !preferMeanPooling) {
        if (batchOffset + hiddenDim > raw.length) break;
        const slice = new Float32Array(hiddenDim);
        for (let d = 0; d < hiddenDim; d++) {
          slice[d] = Number(raw[batchOffset + d]);
        }
        results[b] = l2Normalize(slice);
      } else {
        const sum = new Float64Array(hiddenDim);
        let activeTokens = 0;
        const limitT = Math.min(outSeqLen, seqLen);
        for (let t = 0; t < limitT; t++) {
          const maskVal = attentionMasks[b * seqLen + t] ?? 0n;
          if (maskVal <= 0n) continue;
          const tokenOffset = batchOffset + t * hiddenDim;
          if (tokenOffset + hiddenDim > raw.length) break;
          activeTokens++;
          for (let d = 0; d < hiddenDim; d++) {
            sum[d] = (sum[d] ?? 0) + Number(raw[tokenOffset + d]);
          }
        }
        if (activeTokens > 0) {
          for (let d = 0; d < hiddenDim; d++) {
            sum[d] = (sum[d] ?? 0) / activeTokens;
          }
          results[b] = l2Normalize(sum);
        }
      }
    }
    return results;
  }

  return results;
}

class SemanticEngine implements SemanticEmbedder {
  readonly modelId: string;
  readonly dim: number;
  private readonly options: SemanticEngineOptions;
  private readonly modelDir: string;
  private readonly tokenizerPath: string;
  private readonly tokenizerConfigPath: string;
  private readonly modelPath: string;
  private readonly maxLength: number;
  private readonly maxCacheEntries: number;
  private readonly bgeModel: boolean;

  private tokenizer: SemanticTokenizerLike | undefined;
  private session: SemanticSessionLike | undefined;
  private ortMod: OrtModule | undefined;
  private ready = false;
  private closed = false;
  private readyAttempt: { promise: Promise<boolean>; controller: AbortController; waiters: number } | undefined;
  private runQueue: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<string, Float32Array>();

  constructor(options: SemanticEngineOptions) {
    this.options = options;
    this.modelId = options.modelRepo?.trim() || process.env.FRIDAY_SEMANTIC_MODEL?.trim() || DEFAULT_SEMANTIC_MODEL_REPO;
    this.dim = inferModelDim(this.modelId, options.dim);
    this.maxLength = Math.max(1, Math.min(DEFAULT_SEMANTIC_MAX_LENGTH, options.maxLength ?? DEFAULT_SEMANTIC_MAX_LENGTH));
    this.maxCacheEntries = Math.max(0, options.maxCacheEntries ?? DEFAULT_SEMANTIC_CACHE_ENTRIES);
    this.bgeModel = isBgeModel(this.modelId);

    const baseModelsDir = options.modelsDir ?? join(options.homeDir, 'models', 'semantic');
    this.modelDir = join(baseModelsDir, sanitizeRepoDirName(this.modelId));
    this.tokenizerPath = join(this.modelDir, 'tokenizer.json');
    this.tokenizerConfigPath = join(this.modelDir, 'tokenizer_config.json');
    this.modelPath = join(this.modelDir, 'onnx', 'model_quantized.onnx');
  }

  isReady(): boolean {
    if (this.closed || isSemanticDisabled(this.options)) return false;
    return this.ready && Boolean(this.tokenizer && this.session);
  }

  async ensureReady(signal?: AbortSignal): Promise<boolean> {
    if (this.closed || isSemanticDisabled(this.options)) return false;
    if (this.isReady()) return true;
    if (signal?.aborted) return false;

    if (!this.readyAttempt) {
      const controller = new AbortController();
      const attempt = {
        controller,
        waiters: 0,
        promise: this.initialize(controller.signal).finally(() => {
          if (this.readyAttempt === attempt) {
            this.readyAttempt = undefined;
          }
        }),
      };
      this.readyAttempt = attempt;
    }

    const attempt = this.readyAttempt;
    attempt.waiters++;

    if (!signal) {
      try {
        return await attempt.promise;
      } finally {
        attempt.waiters = Math.max(0, attempt.waiters - 1);
      }
    }

    return new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        attempt.waiters = Math.max(0, attempt.waiters - 1);
        if (!value && attempt.waiters === 0) {
          attempt.controller.abort();
        }
        resolve(value);
      };
      const onAbort = () => finish(false);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      attempt.promise.then(
        ok => finish(ok && !signal.aborted),
        () => finish(false),
      );
    });
  }

  private async initialize(signal?: AbortSignal): Promise<boolean> {
    try {
      if (this.closed || isSemanticDisabled(this.options) || signal?.aborted) return false;

      const autoDownload = resolveAutoDownload(this.options);
      const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
      const customFetchExplicit = Boolean(this.options.fetchImpl);

      const needTokenizerDownload =
        !existsSync(this.tokenizerPath)
        && (!this.options.tokenizerFactory || (autoDownload && customFetchExplicit));
      const needModelDownload =
        !existsSync(this.modelPath)
        && (!this.options.sessionFactory || (autoDownload && customFetchExplicit));

      if ((needTokenizerDownload || needModelDownload) && !autoDownload) {
        return false;
      }

      if (needTokenizerDownload) {
        await downloadFileWithMirrors({
          urls: buildMirrorUrls(this.modelId, 'tokenizer.json'),
          destPath: this.tokenizerPath,
          fetchImpl,
          validateJson: true,
          signal,
        });
      }

      if (needModelDownload) {
        await downloadFileWithMirrors({
          urls: buildMirrorUrls(this.modelId, 'onnx/model_quantized.onnx'),
          destPath: this.modelPath,
          fetchImpl,
          validateJson: false,
          signal,
        });
      }

      if (this.closed || isSemanticDisabled(this.options) || signal?.aborted) return false;

      const tokFactory = this.options.tokenizerFactory ?? defaultTokenizerFactory;
      const sessFactory = this.options.sessionFactory ?? defaultSessionFactory;

      if (!this.ortMod && !this.options.sessionFactory) {
        this.ortMod = await tryImportOrt();
      } else if (!this.ortMod) {
        this.ortMod = await tryImportOrt();
      }

      const tokenizer = await tokFactory({
        tokenizerPath: this.tokenizerPath,
        ...(existsSync(this.tokenizerConfigPath) ? { tokenizerConfigPath: this.tokenizerConfigPath } : {}),
      });
      if (this.closed || signal?.aborted) return false;

      const session = await sessFactory({ modelPath: this.modelPath });
      if (this.closed || signal?.aborted) {
        await Promise.resolve(session.release?.()).catch(() => {});
        return false;
      }

      this.tokenizer = tokenizer;
      this.session = session;
      this.ready = true;
      return true;
    } catch {
      this.ready = false;
      this.tokenizer = undefined;
      if (this.session) {
        await Promise.resolve(this.session.release?.()).catch(() => {});
        this.session = undefined;
      }
      return false;
    }
  }

  private getCached(key: string): Float32Array | undefined {
    if (this.maxCacheEntries <= 0) return undefined;
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    this.cache.delete(key);
    this.cache.set(key, hit);
    return new Float32Array(hit);
  }

  private setCached(key: string, vec: Float32Array): void {
    if (this.maxCacheEntries <= 0) return;
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, new Float32Array(vec));
  }

  private prepareInputText(trimmed: string, purpose: EmbeddingPurpose): string {
    if (this.bgeModel && purpose === 'query') {
      return `${BGE_QUERY_INSTRUCTION}${trimmed}`;
    }
    return trimmed;
  }

  private encodeTruncated(text: string): {
    ids: number[];
    attentionMask: number[];
    tokenTypeIds?: number[];
  } | undefined {
    const tokenizer = this.tokenizer;
    if (!tokenizer) return undefined;

    const encoded = tokenizer.encode(text, { return_token_type_ids: true });
    if (!encoded.ids || encoded.ids.length === 0) return undefined;

    const maxLen = this.maxLength;
    const rawIds = encoded.ids;
    const rawMask = encoded.attention_mask ?? new Array(rawIds.length).fill(1);
    const rawTypes = encoded.token_type_ids;

    if (rawIds.length <= maxLen) {
      return {
        ids: [...rawIds],
        attentionMask: [...rawMask],
        ...(rawTypes ? { tokenTypeIds: [...rawTypes] } : {}),
      };
    }

    const ids = rawIds.slice(0, maxLen);
    const attentionMask = rawMask.slice(0, maxLen);
    const tokenTypeIds = rawTypes ? rawTypes.slice(0, maxLen) : undefined;

    const lastId = rawIds[rawIds.length - 1];
    const lastTok = encoded.tokens?.[encoded.tokens.length - 1];
    const sepId = tokenizer.token_to_id?.('[SEP]') ?? tokenizer.token_to_id?.('</s>');
    const isTrailingSpecial =
      lastTok === '[SEP]'
      || lastTok === '</s>'
      || (sepId !== undefined && lastId === sepId);

    if (isTrailingSpecial && lastId !== undefined && maxLen >= 2) {
      ids[maxLen - 1] = lastId;
      attentionMask[maxLen - 1] = rawMask[rawIds.length - 1] ?? 1;
      if (tokenTypeIds && rawTypes) {
        tokenTypeIds[maxLen - 1] = rawTypes[rawIds.length - 1] ?? 0;
      }
    }

    return {
      ids,
      attentionMask,
      ...(tokenTypeIds ? { tokenTypeIds } : {}),
    };
  }

  private enqueueRun<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.runQueue.then(fn, fn);
    this.runQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async embed(text: string, purpose: EmbeddingPurpose = 'document'): Promise<Float32Array | undefined> {
    const res = await this.embedBatch([text], purpose);
    return res[0];
  }

  async embedBatch(
    texts: string[],
    purpose: EmbeddingPurpose = 'document',
  ): Promise<Array<Float32Array | undefined>> {
    const out: Array<Float32Array | undefined> = new Array(texts.length).fill(undefined);
    if (texts.length === 0 || !this.isReady()) return out;

    const pending: Array<{ index: number; cacheKey: string; inputText: string }> = [];
    const seenPending = new Map<string, number[]>();

    for (let i = 0; i < texts.length; i++) {
      const raw = texts[i];
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;

      const cacheKey = `${purpose}:${trimmed}`;
      const cached = this.getCached(cacheKey);
      if (cached) {
        out[i] = cached;
        continue;
      }

      const existingIndices = seenPending.get(cacheKey);
      if (existingIndices) {
        existingIndices.push(i);
      } else {
        seenPending.set(cacheKey, [i]);
        pending.push({
          index: i,
          cacheKey,
          inputText: this.prepareInputText(trimmed, purpose),
        });
      }
    }

    if (pending.length === 0) return out;

    const MINI_BATCH_SIZE = 16;
    for (let start = 0; start < pending.length; start += MINI_BATCH_SIZE) {
      if (!this.isReady()) break;
      const chunk = pending.slice(start, start + MINI_BATCH_SIZE);
      try {
        const vectors = await this.runInferenceBatch(chunk.map(item => item.inputText));
        for (let k = 0; k < chunk.length; k++) {
          const item = chunk[k]!;
          const vec = vectors[k];
          if (vec) {
            this.setCached(item.cacheKey, vec);
            const indices = seenPending.get(item.cacheKey) ?? [item.index];
            for (const idx of indices) {
              out[idx] = new Float32Array(vec);
            }
          }
        }
      } catch {
        // Graceful degradation: leave unresolved items as undefined
      }
    }

    return out;
  }

  private async runInferenceBatch(inputTexts: string[]): Promise<Array<Float32Array | undefined>> {
    const session = this.session;
    const tokenizer = this.tokenizer;
    if (!session || !tokenizer || !this.isReady()) {
      return new Array(inputTexts.length).fill(undefined);
    }

    const encodedItems: Array<{
      ids: number[];
      attentionMask: number[];
      tokenTypeIds?: number[];
    } | undefined> = [];
    const validPositions: number[] = [];

    for (let i = 0; i < inputTexts.length; i++) {
      const enc = this.encodeTruncated(inputTexts[i]!);
      encodedItems.push(enc);
      if (enc) validPositions.push(i);
    }

    const results: Array<Float32Array | undefined> = new Array(inputTexts.length).fill(undefined);
    if (validPositions.length === 0) return results;

    let maxSeqLen = 0;
    for (const pos of validPositions) {
      const len = encodedItems[pos]!.ids.length;
      if (len > maxSeqLen) maxSeqLen = len;
    }
    if (maxSeqLen <= 0) return results;

    const batchSize = validPositions.length;
    const padId = tokenizer.token_to_id?.('[PAD]') ?? tokenizer.token_to_id?.('<pad>') ?? 0;
    const inputIds = new BigInt64Array(batchSize * maxSeqLen);
    const attentionMask = new BigInt64Array(batchSize * maxSeqLen);
    const wantsTokenTypeIds = session.inputNames.includes('token_type_ids');
    const tokenTypeIds = wantsTokenTypeIds ? new BigInt64Array(batchSize * maxSeqLen) : undefined;

    for (let b = 0; b < batchSize; b++) {
      const enc = encodedItems[validPositions[b]!]!;
      const rowOffset = b * maxSeqLen;
      for (let t = 0; t < maxSeqLen; t++) {
        if (t < enc.ids.length) {
          inputIds[rowOffset + t] = BigInt(enc.ids[t]!);
          attentionMask[rowOffset + t] = BigInt(enc.attentionMask[t] ?? 1);
          if (tokenTypeIds) {
            tokenTypeIds[rowOffset + t] = BigInt(enc.tokenTypeIds?.[t] ?? 0);
          }
        } else {
          inputIds[rowOffset + t] = BigInt(padId);
          attentionMask[rowOffset + t] = 0n;
          if (tokenTypeIds) tokenTypeIds[rowOffset + t] = 0n;
        }
      }
    }

    const feeds: Record<string, unknown> = {
      input_ids: createInt64Tensor(this.ortMod, inputIds, [batchSize, maxSeqLen]),
      attention_mask: createInt64Tensor(this.ortMod, attentionMask, [batchSize, maxSeqLen]),
    };
    if (wantsTokenTypeIds && tokenTypeIds) {
      feeds.token_type_ids = createInt64Tensor(this.ortMod, tokenTypeIds, [batchSize, maxSeqLen]);
    }

    const outputs = await this.enqueueRun(async () => {
      if (!this.isReady() || !this.session) return undefined;
      return this.session.run(feeds);
    });
    if (!outputs) return results;

    const sentenceEmbedding = outputs.sentence_embedding;
    if (sentenceEmbedding) {
      const pooled = poolOutputToVectors({
        tensor: sentenceEmbedding,
        batchSize,
        seqLen: maxSeqLen,
        attentionMasks: attentionMask,
        useClsPooling: true,
        preferMeanPooling: false,
      });
      for (let b = 0; b < batchSize; b++) {
        results[validPositions[b]!] = pooled[b];
      }
      return results;
    }

    const firstOutputName = session.outputNames[0];
    const outputTensor =
      outputs.last_hidden_state
      ?? (firstOutputName ? outputs[firstOutputName] : undefined)
      ?? Object.values(outputs)[0];

    if (!outputTensor) return results;

    const pooled = poolOutputToVectors({
      tensor: outputTensor,
      batchSize,
      seqLen: maxSeqLen,
      attentionMasks: attentionMask,
      useClsPooling: this.bgeModel,
      preferMeanPooling: !this.bgeModel,
    });
    for (let b = 0; b < batchSize; b++) {
      results[validPositions[b]!] = pooled[b];
    }
    return results;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.ready = false;
    this.readyAttempt?.controller.abort();
    this.tokenizer = undefined;
    this.cache.clear();
    const sess = this.session;
    this.session = undefined;
    if (sess?.release) {
      await Promise.resolve(sess.release()).catch(() => {});
    }
  }
}

export function createSemanticEngine(options: SemanticEngineOptions): SemanticEmbedder {
  return new SemanticEngine(options);
}

export function l2Normalize(vec: ArrayLike<number>): Float32Array | undefined {
  if (!vec || vec.length === 0) return undefined;
  let normSq = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = Number(vec[i]);
    if (!Number.isFinite(v)) return undefined;
    normSq += v * v;
  }
  const norm = Math.sqrt(normSq);
  if (!Number.isFinite(norm) || norm <= 1e-12) return undefined;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = Number(vec[i]) / norm;
  }
  return out;
}

export function cosineSimilarity(
  a: ArrayLike<number> | undefined,
  b: ArrayLike<number> | undefined,
): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normASq = 0;
  let normBSq = 0;
  for (let i = 0; i < a.length; i++) {
    const va = Number(a[i]);
    const vb = Number(b[i]);
    if (!Number.isFinite(va) || !Number.isFinite(vb)) return 0;
    dot += va * vb;
    normASq += va * va;
    normBSq += vb * vb;
  }
  const denom = Math.sqrt(normASq) * Math.sqrt(normBSq);
  if (!Number.isFinite(denom) || denom <= 1e-12) return 0;
  const sim = dot / denom;
  return Number.isFinite(sim) ? Math.max(-1, Math.min(1, sim)) : 0;
}

export function serializeEmbedding(vec: Float32Array): Uint8Array {
  const buf = new Uint8Array(vec.length * 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < vec.length; i++) {
    view.setFloat32(i * 4, vec[i]!, true);
  }
  return buf;
}

export function deserializeEmbedding(
  blob: Uint8Array | ArrayBufferView,
  expectedDim?: number,
): Float32Array | undefined {
  if (!blob || !ArrayBuffer.isView(blob)) return undefined;
  if (blob.byteLength === 0 || blob.byteLength % 4 !== 0) return undefined;
  const dim = blob.byteLength / 4;
  if (expectedDim !== undefined && dim !== expectedDim) return undefined;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    const val = view.getFloat32(i * 4, true);
    if (!Number.isFinite(val)) return undefined;
    out[i] = val;
  }
  return out;
}

export function computeSemanticContentHash(text: string): string {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function normalizeTopicForDedup(topic: string): string {
  return topic
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[·•‧・:：\-—–_/\\|,，.。;；!！?？()（）[\]【】{}<>《》「」『』"'“”‘’`~～+*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractConceptTerms(text: string): Set<string> {
  const terms = new Set<string>();
  const normalized = text.normalize('NFKC').toLowerCase();

  const enMatches = normalized.match(/[a-z0-9]{2,}/g) ?? [];
  for (const token of enMatches) {
    if (!EN_STOPWORDS.has(token)) {
      terms.add(token);
    }
  }

  const cjkRuns = normalized.match(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) {
      const a = run[i]!;
      const b = run[i + 1]!;
      const bigram = `${a}${b}`;
      if ((ZH_PARTICLE_CHARS.has(a) || ZH_PARTICLE_CHARS.has(b)) && bigram !== '目的' && bigram !== '了解') continue;
      if (!ZH_STOPWORDS.has(bigram)) {
        terms.add(bigram);
      }
    }
  }

  return terms;
}

export function computeLexicalConceptOverlap(
  textA: string,
  textB: string,
): { jaccard: number; sharedTerms: number } {
  const termsA = extractConceptTerms(textA);
  const termsB = extractConceptTerms(textB);
  if (termsA.size === 0 || termsB.size === 0) {
    return { jaccard: 0, sharedTerms: 0 };
  }

  let sharedTerms = 0;
  for (const term of termsA) {
    if (termsB.has(term)) sharedTerms++;
  }
  if (sharedTerms === 0) {
    return { jaccard: 0, sharedTerms: 0 };
  }

  const union = termsA.size + termsB.size - sharedTerms;
  return {
    jaccard: union > 0 ? sharedTerms / union : 0,
    sharedTerms,
  };
}

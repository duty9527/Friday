import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { normalizeProviderId, parseModelSpec as parseCatalogModelSpec, splitModelAndLevel } from '../models/catalog.js';
import {
  calculateModelCallCost,
  computeCacheSavingsUsd,
  DEFAULT_USD_TO_CNY_RATE,
  FALLBACK_PRICES_VERSION,
  normalizeSdkUsage,
  resolveModelUnitPrice,
  roundSignedUsd,
  roundUsd,
  type CatalogCostRateInput,
  type UsageCostSource,
} from '../models/pricing.js';

export type UsageGranularity = 'day' | 'week' | 'month';
export type UsageCurrency = 'CNY' | 'USD';
export type UsageActor = 'router' | 'worker' | 'decision' | 'distiller' | 'dreamer' | 'probe' | 'compaction';
export type UsageStatus = 'completed' | 'failed' | 'interrupted';
export type { UsageCostSource };

export interface UsagePreferences {
  currency: UsageCurrency;
  usdToCnyRate: number;
}

export interface UsageTotalsView {
  calls: number;
  successCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cacheHitRate: number;
  costUsd: number;
  costCny: number;
  cacheSavingsUsd: number;
  cacheSavingsCny: number;
}

export interface UsageTodaySummary {
  date: string;
  calls: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number;
  costUsd: number;
  costCny: number;
  cacheSavingsUsd: number;
  cacheSavingsCny: number;
  currency: UsageCurrency;
  usdToCnyRate: number;
}

export interface UsageModelBreakdownView extends UsageTotalsView {
  spec: string;
  provider: string;
  model: string;
  tokenShare: number;
  costShare: number;
  unitInputUsdPer1M: number;
  unitOutputUsdPer1M: number;
  unitCacheReadUsdPer1M: number;
  unitCacheWriteUsdPer1M: number;
  costSource: UsageCostSource;
  actors: Partial<Record<UsageActor, number>>;
  lastUsedAt: number;
}

export interface UsageBucketView {
  key: string;
  label: string;
  startAt: number;
  endAt: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  costCny: number;
}

export interface UsagePeriodSummaryView {
  key: string;
  anchorDate: string;
  label: string;
  isCurrent: boolean;
  calls: number;
  totalTokens: number;
  costUsd: number;
  costCny: number;
}

export interface UsageReportView {
  granularity: UsageGranularity;
  anchorDate: string;
  periodLabel: string;
  prevAnchorDate: string;
  nextAnchorDate: string;
  todayDate: string;
  startAt: number;
  endAt: number;
  tzOffsetMin: number;
  prefs: UsagePreferences;
  totals: UsageTotalsView;
  byModel: UsageModelBreakdownView[];
  byActor: Partial<Record<UsageActor, UsageTotalsView>>;
  buckets: UsageBucketView[];
  recentPeriods: UsagePeriodSummaryView[];
}

export interface UsageRecordInput {
  id?: string;
  at?: number;
  actor: UsageActor;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  providerReportedTotalUsd?: number;
  totalFromProvider?: boolean;
  catalogRate?: CatalogCostRateInput;
  usage?: unknown;
  status?: UsageStatus;
  taskId?: string;
  messageId?: string;
}

export interface UsageQueryOptions {
  granularity?: UsageGranularity;
  anchorDate?: string;
  tzOffsetMin?: number;
}

export interface UsagePrefsPatch {
  currency?: UsageCurrency;
  usdToCnyRate?: number;
}

interface UsageBackfillMeta {
  version: number;
  lastSeq: number;
  cutoffSeq?: number;
  defaultProvider?: string;
  defaultRouterModel?: string;
  insertedCount: number;
  updatedAt: number;
}

interface RawUsageRow {
  id: string;
  at: number;
  actor: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_write_1h_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  cost_usd: number;
  unit_input_usd: number;
  unit_output_usd: number;
  unit_cache_read_usd: number;
  unit_cache_write_usd: number;
  cost_source: string;
  status: string;
}

interface MutableTotals {
  calls: number;
  successCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  costUsd: number;
  cacheSavingsUsd: number;
}

const PREFS_META_KEY = 'usage_prefs_v1';
const BACKFILL_META_KEY = 'usage_backfill_v1';
const REPRICE_META_KEY = 'usage_reprice_version';
const CACHE_REPRICE_META_KEY = 'usage_cache_reprice_version';
const CACHE_REPRICE_VERSION = 'cache-pricing-v1';
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEKDAY_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;
const VALID_ACTORS = new Set<UsageActor>([
  'router',
  'worker',
  'decision',
  'distiller',
  'dreamer',
  'probe',
  'compaction',
]);
const VALID_COST_SOURCES = new Set<UsageCostSource>([
  'provider',
  'catalog',
  'estimated',
  'free',
  'unknown',
]);

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sanitizeTokenInt(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : 0;
}

function emptyMutableTotals(): MutableTotals {
  return {
    calls: 0,
    successCalls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    cacheSavingsUsd: 0,
  };
}

function resolveRowCacheRates(row: {
  provider: string;
  model: string;
  unit_input_usd: number;
  unit_output_usd: number;
  unit_cache_read_usd?: number;
  unit_cache_write_usd?: number;
}): { unitCacheRead: number; unitCacheWrite: number } {
  const unitIn = Number(row.unit_input_usd ?? 0);
  if (!Number.isFinite(unitIn) || unitIn <= 0) {
    return { unitCacheRead: 0, unitCacheWrite: 0 };
  }
  const storedCr = Number(row.unit_cache_read_usd ?? 0);
  const storedCw = Number(row.unit_cache_write_usd ?? 0);
  if (storedCr > 0 && storedCw > 0) {
    return { unitCacheRead: storedCr, unitCacheWrite: storedCw };
  }
  const resolved = resolveModelUnitPrice(row.provider, row.model, {
    costInput: unitIn,
    costOutput: Number(row.unit_output_usd ?? 0),
    ...(storedCr > 0 ? { costCacheRead: storedCr } : {}),
    ...(storedCw > 0 ? { costCacheWrite: storedCw } : {}),
  });
  return {
    unitCacheRead: storedCr > 0 ? storedCr : resolved.cacheReadUsdPer1M,
    unitCacheWrite: storedCw > 0 ? storedCw : resolved.cacheWriteUsdPer1M,
  };
}

function addRowToTotals(acc: MutableTotals, row: RawUsageRow): void {
  acc.calls += 1;
  if (row.status === 'completed') acc.successCalls += 1;
  else acc.failedCalls += 1;
  const inputTokens = Number(row.input_tokens ?? 0);
  const outputTokens = Number(row.output_tokens ?? 0);
  const cacheReadTokens = Number(row.cache_read_tokens ?? 0);
  const cacheWriteTokens = Number(row.cache_write_tokens ?? 0);
  const cacheWrite1hTokens = Number(row.cache_write_1h_tokens ?? 0);
  acc.inputTokens += inputTokens;
  acc.outputTokens += outputTokens;
  acc.cacheReadTokens += cacheReadTokens;
  acc.cacheWriteTokens += cacheWriteTokens;
  acc.cacheWrite1hTokens += cacheWrite1hTokens;
  acc.reasoningTokens += Number(row.reasoning_tokens ?? 0);
  acc.totalTokens += Number(row.total_tokens ?? 0);
  acc.costUsd += Number(row.cost_usd ?? 0);
  if (cacheReadTokens > 0 || cacheWriteTokens > 0) {
    const { unitCacheRead, unitCacheWrite } = resolveRowCacheRates(row);
    acc.cacheSavingsUsd += computeCacheSavingsUsd({
      cacheReadTokens,
      cacheWriteTokens,
      cacheWrite1hTokens,
      unitInputUsdPer1M: Number(row.unit_input_usd ?? 0),
      unitCacheReadUsdPer1M: unitCacheRead,
      unitCacheWriteUsdPer1M: unitCacheWrite,
    });
  }
}

function finalizeTotals(acc: MutableTotals, usdToCnyRate: number): UsageTotalsView {
  const costUsd = roundUsd(acc.costUsd);
  const totalPromptTokens = acc.inputTokens + acc.cacheReadTokens + acc.cacheWriteTokens;
  const cacheHitRate = totalPromptTokens > 0
    ? Math.min(1, Math.max(0, Number((acc.cacheReadTokens / totalPromptTokens).toFixed(6))))
    : 0;
  const cacheSavingsUsd = roundSignedUsd(acc.cacheSavingsUsd);
  return {
    calls: acc.calls,
    successCalls: acc.successCalls,
    failedCalls: acc.failedCalls,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
    cacheWrite1hTokens: acc.cacheWrite1hTokens,
    reasoningTokens: acc.reasoningTokens,
    totalTokens: acc.totalTokens,
    cacheHitRate,
    costUsd,
    costCny: roundUsd(costUsd * usdToCnyRate),
    cacheSavingsUsd,
    cacheSavingsCny: roundSignedUsd(cacheSavingsUsd * usdToCnyRate),
  };
}

function createLocalFormatter(): Intl.DateTimeFormat {
  const tz = process.env.TZ?.trim() || undefined;
  return new Intl.DateTimeFormat('en-US', {
    ...(tz ? { timeZone: tz } : {}),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

function getZonedParts(epochMs: number, dtf: Intl.DateTimeFormat): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = dtf.formatToParts(new Date(epochMs));
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
    else if (part.type === 'hour') hour = Number(part.value) % 24;
    else if (part.type === 'minute') minute = Number(part.value);
    else if (part.type === 'second') second = Number(part.value);
  }
  return { year, month, day, hour, minute, second };
}

function getZonedOffsetMinAt(epochMs: number, dtf: Intl.DateTimeFormat): number {
  const secMs = Math.floor(epochMs / 1000) * 1000;
  const p = getZonedParts(secMs, dtf);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const offsetMin = Math.round((secMs - asUtc) / 60_000);
  return offsetMin === 0 ? 0 : offsetMin;
}

function resolveTzOffsetMin(tzOffsetMin?: number, atMs = Date.now(), dtf?: Intl.DateTimeFormat): number {
  if (tzOffsetMin === undefined) {
    return getZonedOffsetMinAt(atMs, dtf ?? createLocalFormatter());
  }
  if (
    typeof tzOffsetMin !== 'number'
    || !Number.isFinite(tzOffsetMin)
    || !Number.isInteger(tzOffsetMin)
    || tzOffsetMin < -840
    || tzOffsetMin > 840
  ) {
    throw new Error('tzOffsetMin 必须是 -840 到 840 之间的整数');
  }
  return tzOffsetMin === 0 ? 0 : tzOffsetMin;
}

function formatUtcYmd(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function epochToShiftedYmd(at: number, explicitTzOffsetMin: number | undefined, dtf?: Intl.DateTimeFormat): string {
  if (explicitTzOffsetMin !== undefined) {
    return formatUtcYmd(new Date(at - explicitTzOffsetMin * 60_000));
  }
  const p = getZonedParts(at, dtf ?? createLocalFormatter());
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function parseYmd(ymd: string): { year: number; month: number; day: number; utcMidnightMs: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) {
    throw new Error(`无效的日期格式 "${ymd}"，请使用 YYYY-MM-DD`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const utc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (
    utc.getUTCFullYear() !== year
    || utc.getUTCMonth() !== month - 1
    || utc.getUTCDate() !== day
  ) {
    throw new Error(`无效的日历日期 "${ymd}"`);
  }
  return { year, month, day, utcMidnightMs: utc.getTime() };
}

function addDaysUtc(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
): { year: number; month: number; day: number; ymd: string; utcMidnightMs: number } {
  const d = new Date(Date.UTC(year, month - 1, day + deltaDays, 0, 0, 0, 0));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    ymd: formatUtcYmd(d),
    utcMidnightMs: d.getTime(),
  };
}

function shiftedMidnightToEpoch(
  year: number,
  monthIndex0: number,
  day: number,
  explicitTzOffsetMin: number | undefined,
  dtf?: Intl.DateTimeFormat,
): number {
  const utcWall = Date.UTC(year, monthIndex0, day, 0, 0, 0, 0);
  if (explicitTzOffsetMin !== undefined) {
    return utcWall + explicitTzOffsetMin * 60_000;
  }
  const formatter = dtf ?? createLocalFormatter();
  const off1 = getZonedOffsetMinAt(utcWall, formatter);
  const pass1 = utcWall + off1 * 60_000;
  const off2 = getZonedOffsetMinAt(pass1, formatter);
  return utcWall + off2 * 60_000;
}

function isoWeekInfo(utcMidnightMs: number): { year: number; week: number } {
  const target = new Date(utcMidnightMs);
  const dayNum = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return { year: target.getUTCFullYear(), week };
}

function splitProviderAndModel(
  rawProvider: string,
  rawModel: string,
): { provider: string; model: string } {
  const trimmedProv = rawProvider.trim();
  const normProv = normalizeProviderId(trimmedProv) ?? trimmedProv;
  const cleanedModel = splitModelAndLevel(rawModel.trim()).model;
  if (!normProv) {
    const parsed = parseCatalogModelSpec(cleanedModel);
    return { provider: parsed.providerId, model: parsed.modelId };
  }
  const parsed = parseCatalogModelSpec(cleanedModel, {
    fallbackProvider: trimmedProv,
    preferFallbackProvider: true,
  });
  return {
    provider: parsed.providerId || 'unknown',
    model: parsed.modelId || 'unknown',
  };
}

function parseModelSpec(
  rawSpec: string | undefined,
  fallbackProvider?: string,
): { provider: string; model: string } | undefined {
  if (!rawSpec || !rawSpec.trim()) return undefined;
  const parsed = parseCatalogModelSpec(rawSpec, { fallbackProvider });
  return {
    provider: parsed.providerId,
    model: parsed.modelId,
  };
}

/**
 * SQLite-backed persistence and calendar-aligned reporting engine for all model calls.
 */
export class UsageStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly atomic: <T>(run: () => T) => T,
  ) {}

  private readMeta<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
    if (!row) return undefined;
    try {
      return JSON.parse(String(row.value)) as T;
    } catch {
      return undefined;
    }
  }

  private writeMeta(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO metadata(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }

  getUsagePrefs(): UsagePreferences {
    const saved = this.readMeta<Partial<UsagePreferences>>(PREFS_META_KEY);
    const currency: UsageCurrency = saved?.currency === 'USD' ? 'USD' : 'CNY';
    const rate = typeof saved?.usdToCnyRate === 'number'
      && Number.isFinite(saved.usdToCnyRate)
      && saved.usdToCnyRate > 0.1
      && saved.usdToCnyRate <= 100
      ? saved.usdToCnyRate
      : DEFAULT_USD_TO_CNY_RATE;
    return { currency, usdToCnyRate: rate };
  }

  setUsagePrefs(patch: UsagePrefsPatch): UsagePreferences {
    const current = this.getUsagePrefs();
    let currency = current.currency;
    let usdToCnyRate = current.usdToCnyRate;

    if (patch.currency !== undefined) {
      if (patch.currency !== 'CNY' && patch.currency !== 'USD') {
        throw new Error('currency 必须为 CNY 或 USD');
      }
      currency = patch.currency;
    }
    if (patch.usdToCnyRate !== undefined) {
      if (
        typeof patch.usdToCnyRate !== 'number'
        || !Number.isFinite(patch.usdToCnyRate)
        || patch.usdToCnyRate <= 0.1
        || patch.usdToCnyRate > 100
      ) {
        throw new Error('usdToCnyRate 必须在 (0.1, 100] 范围内');
      }
      usdToCnyRate = Number(patch.usdToCnyRate.toFixed(6));
    }

    const next: UsagePreferences = { currency, usdToCnyRate };
    this.writeMeta(PREFS_META_KEY, next);
    return next;
  }

  recordUsage(input: UsageRecordInput): void {
    const parsedFromUsage = input.usage !== undefined ? normalizeSdkUsage(input.usage) : undefined;
    const inputTokens = input.inputTokens !== undefined
      ? sanitizeTokenInt(input.inputTokens)
      : (parsedFromUsage?.inputTokens ?? 0);
    const cacheReadTokens = input.cacheReadTokens !== undefined
      ? sanitizeTokenInt(input.cacheReadTokens)
      : (parsedFromUsage?.cacheReadTokens ?? 0);
    const cacheWriteTokens = input.cacheWriteTokens !== undefined
      ? sanitizeTokenInt(input.cacheWriteTokens)
      : (parsedFromUsage?.cacheWriteTokens ?? 0);
    const cacheWrite1hTokens = Math.min(
      cacheWriteTokens,
      input.cacheWrite1hTokens !== undefined
        ? sanitizeTokenInt(input.cacheWrite1hTokens)
        : (parsedFromUsage?.cacheWrite1hTokens ?? 0),
    );
    const reasoningTokens = input.reasoningTokens !== undefined
      ? sanitizeTokenInt(input.reasoningTokens)
      : (parsedFromUsage?.reasoningTokens ?? 0);
    const rawTotal = input.totalTokens !== undefined
      ? sanitizeTokenInt(input.totalTokens)
      : (parsedFromUsage?.totalTokens ?? 0);
    const outputTokens = input.outputTokens !== undefined
      ? sanitizeTokenInt(input.outputTokens)
      : (parsedFromUsage
          ? parsedFromUsage.outputTokens
          : Math.max(0, rawTotal - inputTokens - cacheReadTokens - cacheWriteTokens));

    const componentSum = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    const totalTokens = rawTotal > 0 ? Math.max(rawTotal, componentSum) : componentSum;

    const providerReportedTotalUsd = input.providerReportedTotalUsd ?? parsedFromUsage?.providerReportedTotalUsd;
    const totalFromProvider = input.totalFromProvider ?? parsedFromUsage?.totalFromProvider;
    const sdkCatalogTotalUsd = parsedFromUsage?.sdkCatalogTotalUsd;

    const { provider, model } = splitProviderAndModel(input.provider, input.model);
    const cost = calculateModelCallCost({
      provider,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheWrite1hTokens,
      reasoningTokens,
      providerReportedTotalUsd,
      totalFromProvider,
      sdkCatalogTotalUsd,
      catalogRate: input.catalogRate,
    });

    const id = input.id?.trim() || randomUUID();
    const at = typeof input.at === 'number' && Number.isFinite(input.at) ? Math.round(input.at) : Date.now();
    const actor: UsageActor = VALID_ACTORS.has(input.actor) ? input.actor : 'worker';
    const status: UsageStatus = input.status === 'failed' || input.status === 'interrupted' ? input.status : 'completed';

    this.db.prepare(`
      INSERT OR IGNORE INTO model_usage(
        id, at, actor, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens, total_tokens,
        cost_usd, unit_input_usd, unit_output_usd, unit_cache_read_usd, unit_cache_write_usd, cost_source, status, task_id, message_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      at,
      actor,
      provider,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheWrite1hTokens,
      reasoningTokens,
      totalTokens,
      cost.costUsd,
      cost.unitInputUsdPer1M,
      cost.unitOutputUsdPer1M,
      cost.unitCacheReadUsdPer1M,
      cost.unitCacheWriteUsdPer1M,
      cost.costSource,
      status,
      input.taskId ?? null,
      input.messageId ?? null,
    );
  }

  /**
   * Idempotently backfills historical model calls recorded in `journal` into `model_usage`.
   * Re-runs once if initial startup lacked `defaultProvider` and a subsequent init supplies it.
   */
  backfillFromJournalIfNeeded(defaultProvider?: string, defaultRouterModel?: string): number {
    const cleanDefaultProvider = defaultProvider?.trim() || undefined;
    const cleanDefaultRouterModel = defaultRouterModel?.trim()
      ? splitModelAndLevel(defaultRouterModel.trim()).model
      : undefined;

    const meta = this.readMeta<UsageBackfillMeta>(BACKFILL_META_KEY);
    if (meta && (!cleanDefaultProvider || Boolean(meta.defaultProvider))) {
      this.repriceUnknownUsageIfNeeded();
      this.repriceCacheUsageIfNeeded();
      return 0;
    }

    const cleanRouterSpec = cleanDefaultRouterModel?.includes('/')
      ? parseModelSpec(cleanDefaultRouterModel, cleanDefaultProvider)
      : cleanDefaultProvider || cleanDefaultRouterModel
        ? {
            provider: cleanDefaultProvider ?? 'unknown',
            model: cleanDefaultRouterModel ?? 'unknown',
          }
        : undefined;

    return this.atomic(() => {
      const taskModelCache = new Map<string, string | undefined>();
      const getTaskWorkerModel = (taskId: string | undefined): string | undefined => {
        if (!taskId) return undefined;
        if (taskModelCache.has(taskId)) return taskModelCache.get(taskId);
        const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(taskId);
        if (!row) {
          taskModelCache.set(taskId, undefined);
          return undefined;
        }
        try {
          const parsed = JSON.parse(String(row.body)) as { workerModel?: unknown };
          const wm = typeof parsed.workerModel === 'string' && parsed.workerModel.trim()
            ? parsed.workerModel.trim()
            : undefined;
          taskModelCache.set(taskId, wm);
          return wm;
        } catch {
          taskModelCache.set(taskId, undefined);
          return undefined;
        }
      };

      const cutoffRow = this.db.prepare('SELECT coalesce(max(seq), 0) AS max_seq FROM journal').get() as { max_seq?: number } | undefined;
      const cutoffSeq = meta?.cutoffSeq ?? Number(cutoffRow?.max_seq ?? 0);

      const pageStmt = this.db.prepare(`
        SELECT seq, root_id, task_id, message_id, body
        FROM journal
        WHERE seq > ? AND seq <= ?
          AND (
            (CASE WHEN json_valid(body) THEN json_extract(body, '$.label') END) IN ('模型推理调用', '上下文压缩（SDK）')
            OR (CASE WHEN json_valid(body) THEN json_extract(body, '$.label') END) LIKE 'Gemini Decision 1%'
          )
        ORDER BY seq ASC
        LIMIT ?
      `);

      const existingBackfillStmt = this.db.prepare(
        'SELECT provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens FROM model_usage WHERE id=?',
      );
      const insertStmt = this.db.prepare(`
        INSERT OR IGNORE INTO model_usage(
          id, at, actor, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens, total_tokens,
          cost_usd, unit_input_usd, unit_output_usd, unit_cache_read_usd, unit_cache_write_usd, cost_source, status, task_id, message_id
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      const updateUnknownStmt = this.db.prepare(`
        UPDATE model_usage
        SET provider=?, model=?, cost_usd=?, unit_input_usd=?, unit_output_usd=?, unit_cache_read_usd=?, unit_cache_write_usd=?, cost_source=?
        WHERE id=?
      `);

      let changed = 0;
      let maxSeq = meta?.lastSeq ?? 0;
      let afterSeq = 0;
      const pageSize = 500;

      while (true) {
        const rows = pageStmt.all(afterSeq, cutoffSeq, pageSize) as Array<{
          seq: number;
          root_id: string | null;
          task_id: string | null;
          message_id: string | null;
          body: string;
        }>;
        if (!rows.length) break;

        for (const row of rows) {
          afterSeq = row.seq;
          if (row.seq > maxSeq) maxSeq = row.seq;
          let event: {
            actor?: string;
            label?: string;
            status?: string;
            at?: number;
            rootId?: string;
            spanId?: string;
            taskId?: string;
            messageId?: string;
            data?: unknown;
          };
          try {
            event = JSON.parse(String(row.body)) as typeof event;
          } catch {
            continue;
          }
          if (event.status === 'started') continue;

          const label = typeof event.label === 'string' ? event.label : '';
          const data = asRecord(event.data);
          const detail = asRecord(data?.detail) ?? data;
          const taskId = typeof event.taskId === 'string' && event.taskId ? event.taskId : (row.task_id ?? undefined);
          const messageId = typeof event.messageId === 'string' && event.messageId ? event.messageId : (row.message_id ?? undefined);
          const sessionId = typeof detail?.sessionId === 'string'
            ? detail.sessionId
            : typeof data?.sessionId === 'string'
              ? data.sessionId
              : undefined;
          const isDreamSpan = Boolean(
            event.actor === 'dreamer'
            || sessionId?.startsWith('dream-')
            || event.spanId?.startsWith('dream-')
            || event.rootId?.startsWith('dream-')
            || row.root_id?.startsWith('dream-')
            || taskId?.startsWith('dream-'),
          );

          let actor: UsageActor;
          let rawUsage: unknown;
          let resolvedSpec: { provider: string; model: string } | undefined;
          let status: UsageStatus;

          if (label === '模型推理调用') {
            rawUsage = detail?.usage ?? data?.usage;
            actor = event.actor === 'router'
              ? 'router'
              : (event.actor === 'dreamer' || isDreamSpan)
                ? 'dreamer'
                : event.actor === 'distiller'
                  ? 'distiller'
                  : 'worker';
            if (typeof detail?.provider === 'string' && detail.provider.trim() && typeof detail?.model === 'string' && detail.model.trim()) {
              resolvedSpec = splitProviderAndModel(detail.provider, detail.model);
            } else if (actor === 'worker') {
              resolvedSpec = parseModelSpec(getTaskWorkerModel(taskId), cleanDefaultProvider);
            } else {
              resolvedSpec = cleanRouterSpec;
            }
            status = event.status === 'failed' ? 'failed' : event.status === 'interrupted' ? 'interrupted' : 'completed';
          } else if (label === '上下文压缩（SDK）') {
            rawUsage = detail?.usage ?? data?.usage;
            actor = isDreamSpan ? 'dreamer' : 'compaction';
            if (typeof detail?.provider === 'string' && detail.provider.trim() && typeof detail?.model === 'string' && detail.model.trim()) {
              resolvedSpec = splitProviderAndModel(detail.provider, detail.model);
            } else {
              resolvedSpec = (isDreamSpan ? undefined : parseModelSpec(getTaskWorkerModel(taskId), cleanDefaultProvider)) ?? cleanRouterSpec;
            }
            status = event.status === 'failed' ? 'failed' : event.status === 'interrupted' ? 'interrupted' : 'completed';
          } else if (label.startsWith('Gemini Decision 1')) {
            rawUsage = data?.usage ?? detail?.usage;
            actor = 'decision';
            const req = asRecord(data?.request);
            const decisionModel = typeof req?.decisionModel === 'string' && req.decisionModel.trim()
              ? req.decisionModel.trim()
              : 'gemini-decision-1';
            resolvedSpec = { provider: 'google', model: decisionModel };
            status = event.status === 'failed' ? 'failed' : 'completed';
          } else {
            continue;
          }

          const usage = normalizeSdkUsage(rawUsage);
          if (!usage) continue;

          const { provider, model } = splitProviderAndModel(
            resolvedSpec?.provider ?? cleanDefaultProvider ?? 'unknown',
            resolvedSpec?.model ?? 'unknown',
          );
          const backfillId = `backfill:${row.seq}`;

          const existing = existingBackfillStmt.get(backfillId) as
            | {
                provider: string;
                model: string;
                input_tokens: number;
                output_tokens: number;
                cache_read_tokens: number;
                cache_write_tokens: number;
                cache_write_1h_tokens: number;
                reasoning_tokens: number;
              }
            | undefined;

          if (existing) {
            if (
              (existing.provider === 'unknown' || existing.model === 'unknown')
              && (provider !== 'unknown' || model !== 'unknown')
            ) {
              const nextProvider = existing.provider === 'unknown' ? provider : existing.provider;
              const nextModel = existing.model === 'unknown' ? model : existing.model;
              const cost = calculateModelCallCost({
                provider: nextProvider,
                model: nextModel,
                inputTokens: Number(existing.input_tokens ?? 0),
                outputTokens: Number(existing.output_tokens ?? 0),
                cacheReadTokens: Number(existing.cache_read_tokens ?? 0),
                cacheWriteTokens: Number(existing.cache_write_tokens ?? 0),
                cacheWrite1hTokens: Number(existing.cache_write_1h_tokens ?? 0),
                reasoningTokens: Number(existing.reasoning_tokens ?? 0),
                providerReportedTotalUsd: usage.providerReportedTotalUsd,
                totalFromProvider: usage.totalFromProvider,
                sdkCatalogTotalUsd: usage.sdkCatalogTotalUsd,
              });
              const res = updateUnknownStmt.run(
                nextProvider,
                nextModel,
                cost.costUsd,
                cost.unitInputUsdPer1M,
                cost.unitOutputUsdPer1M,
                cost.unitCacheReadUsdPer1M,
                cost.unitCacheWriteUsdPer1M,
                cost.costSource,
                backfillId,
              );
              if (res.changes > 0) changed += 1;
            }
            continue;
          }

          const cost = calculateModelCallCost({
            provider,
            model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            cacheWrite1hTokens: usage.cacheWrite1hTokens,
            reasoningTokens: usage.reasoningTokens,
            providerReportedTotalUsd: usage.providerReportedTotalUsd,
            totalFromProvider: usage.totalFromProvider,
            sdkCatalogTotalUsd: usage.sdkCatalogTotalUsd,
          });
          const at = typeof event.at === 'number' && Number.isFinite(event.at) ? Math.round(event.at) : Date.now();
          const res = insertStmt.run(
            backfillId,
            at,
            actor,
            provider,
            model,
            usage.inputTokens,
            usage.outputTokens,
            usage.cacheReadTokens,
            usage.cacheWriteTokens,
            usage.cacheWrite1hTokens ?? 0,
            usage.reasoningTokens,
            usage.totalTokens,
            cost.costUsd,
            cost.unitInputUsdPer1M,
            cost.unitOutputUsdPer1M,
            cost.unitCacheReadUsdPer1M,
            cost.unitCacheWriteUsdPer1M,
            cost.costSource,
            status,
            taskId ?? null,
            messageId ?? null,
          );
          if (res.changes > 0) changed += 1;
        }
        if (rows.length < pageSize) break;
      }

      const nextMeta: UsageBackfillMeta = {
        version: 1,
        lastSeq: maxSeq,
        cutoffSeq,
        ...(cleanDefaultProvider ? { defaultProvider: cleanDefaultProvider } : {}),
        ...(cleanDefaultRouterModel ? { defaultRouterModel: cleanDefaultRouterModel } : {}),
        insertedCount: (meta?.insertedCount ?? 0) + changed,
        updatedAt: Date.now(),
      };
      this.writeMeta(BACKFILL_META_KEY, nextMeta);
      this.repriceUnknownUsageIfNeeded();
      this.repriceCacheUsageIfNeeded();
      return changed;
    });
  }

  /**
   * Reprices historical `model_usage` rows whose `cost_source = 'unknown'` whenever
   * the built-in fallback pricing snapshot updates (`FALLBACK_PRICES_VERSION`).
   */
  repriceUnknownUsageIfNeeded(force = false): number {
    if (!force && this.readMeta<string>(REPRICE_META_KEY) === FALLBACK_PRICES_VERSION) {
      return 0;
    }
    return this.atomic(() => {
      if (!force && this.readMeta<string>(REPRICE_META_KEY) === FALLBACK_PRICES_VERSION) {
        return 0;
      }
      const rows = this.db.prepare(`
        SELECT id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens
        FROM model_usage
        WHERE cost_source = 'unknown'
      `).all() as Array<{
        id: string;
        provider: string;
        model: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        cache_write_1h_tokens: number;
        reasoning_tokens: number;
      }>;

      const updateStmt = this.db.prepare(`
        UPDATE model_usage
        SET cost_usd=?, unit_input_usd=?, unit_output_usd=?, unit_cache_read_usd=?, unit_cache_write_usd=?, cost_source=?
        WHERE id=?
      `);
      const journalStmt = this.db.prepare('SELECT body FROM journal WHERE seq=?');

      let updated = 0;
      for (const row of rows) {
        let sdkCatalogTotalUsd: number | undefined;
        let cost = calculateModelCallCost({
          provider: row.provider,
          model: row.model,
          inputTokens: Number(row.input_tokens ?? 0),
          outputTokens: Number(row.output_tokens ?? 0),
          cacheReadTokens: Number(row.cache_read_tokens ?? 0),
          cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
          cacheWrite1hTokens: Number(row.cache_write_1h_tokens ?? 0),
          reasoningTokens: Number(row.reasoning_tokens ?? 0),
        });
        if (cost.costSource === 'unknown' && row.id.startsWith('backfill:')) {
          const seq = Number(row.id.slice('backfill:'.length));
          if (Number.isSafeInteger(seq) && seq > 0) {
            const jRow = journalStmt.get(seq) as { body?: string } | undefined;
            if (jRow?.body) {
              try {
                const ev = JSON.parse(String(jRow.body)) as { data?: unknown };
                const data = asRecord(ev.data);
                const detail = asRecord(data?.detail) ?? data;
                const parsed = normalizeSdkUsage(detail?.usage ?? data?.usage);
                sdkCatalogTotalUsd = parsed?.sdkCatalogTotalUsd;
                if (sdkCatalogTotalUsd && sdkCatalogTotalUsd > 0) {
                  cost = calculateModelCallCost({
                    provider: row.provider,
                    model: row.model,
                    inputTokens: Number(row.input_tokens ?? 0),
                    outputTokens: Number(row.output_tokens ?? 0),
                    cacheReadTokens: Number(row.cache_read_tokens ?? 0),
                    cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
                    cacheWrite1hTokens: Number(row.cache_write_1h_tokens ?? 0),
                    reasoningTokens: Number(row.reasoning_tokens ?? 0),
                    sdkCatalogTotalUsd,
                  });
                }
              } catch { /* ignore malformed journal body */ }
            }
          }
        }
        if (cost.costSource !== 'unknown') {
          const res = updateStmt.run(
            cost.costUsd,
            cost.unitInputUsdPer1M,
            cost.unitOutputUsdPer1M,
            cost.unitCacheReadUsdPer1M,
            cost.unitCacheWriteUsdPer1M,
            cost.costSource,
            row.id,
          );
          if (res.changes > 0) updated += 1;
        }
      }

      this.writeMeta(REPRICE_META_KEY, FALLBACK_PRICES_VERSION);
      return updated;
    });
  }

  /**
   * One-time idempotent migration that backfills missing cache unit prices and repairs
   * historical cache cost calculations ONLY for `cost_source IN ('catalog', 'estimated')`.
   * Provider-billed rows (`cost_source = 'provider'`) are strictly left untouched.
   */
  repriceCacheUsageIfNeeded(force = false): number {
    if (!force && this.readMeta<string>(CACHE_REPRICE_META_KEY) === CACHE_REPRICE_VERSION) {
      return 0;
    }
    return this.atomic(() => {
      if (!force && this.readMeta<string>(CACHE_REPRICE_META_KEY) === CACHE_REPRICE_VERSION) {
        return 0;
      }
      const rows = this.db.prepare(`
        SELECT
          id, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens,
          cost_usd, unit_input_usd, unit_output_usd, unit_cache_read_usd, unit_cache_write_usd, cost_source
        FROM model_usage
        WHERE cost_source IN ('catalog', 'estimated')
          AND (
            cache_read_tokens > 0
            OR cache_write_tokens > 0
            OR (unit_input_usd > 0 AND (unit_cache_read_usd <= 0 OR unit_cache_write_usd <= 0))
          )
      `).all() as Array<{
        id: string;
        provider: string;
        model: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        cache_write_1h_tokens: number;
        reasoning_tokens: number;
        cost_usd: number;
        unit_input_usd: number;
        unit_output_usd: number;
        unit_cache_read_usd: number;
        unit_cache_write_usd: number;
        cost_source: string;
      }>;

      const updateStmt = this.db.prepare(`
        UPDATE model_usage
        SET cost_usd=?, unit_input_usd=?, unit_output_usd=?, unit_cache_read_usd=?, unit_cache_write_usd=?
        WHERE id=? AND cost_source IN ('catalog', 'estimated')
      `);

      let updated = 0;
      for (const row of rows) {
        const storedIn = Number(row.unit_input_usd ?? 0);
        const storedOut = Number(row.unit_output_usd ?? 0);
        const useStoredCatalog = row.cost_source === 'catalog' && (storedIn > 0 || storedOut > 0);
        const nextCost = calculateModelCallCost({
          provider: row.provider,
          model: row.model,
          inputTokens: Number(row.input_tokens ?? 0),
          outputTokens: Number(row.output_tokens ?? 0),
          cacheReadTokens: Number(row.cache_read_tokens ?? 0),
          cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
          cacheWrite1hTokens: Number(row.cache_write_1h_tokens ?? 0),
          reasoningTokens: Number(row.reasoning_tokens ?? 0),
          ...(useStoredCatalog ? { catalogRate: { costInput: storedIn, costOutput: storedOut } } : {}),
        });
        if (nextCost.costSource === 'unknown') continue;
        const res = updateStmt.run(
          nextCost.costUsd,
          nextCost.unitInputUsdPer1M,
          nextCost.unitOutputUsdPer1M,
          nextCost.unitCacheReadUsdPer1M,
          nextCost.unitCacheWriteUsdPer1M,
          row.id,
        );
        if (res.changes > 0) updated += 1;
      }

      this.writeMeta(CACHE_REPRICE_META_KEY, CACHE_REPRICE_VERSION);
      return updated;
    });
  }

  todayUsageSummary(tzOffsetMin?: number): UsageTodaySummary {
    const explicitTz = tzOffsetMin !== undefined ? resolveTzOffsetMin(tzOffsetMin) : undefined;
    const dtf = explicitTz === undefined ? createLocalFormatter() : undefined;
    const nowMs = Date.now();
    const todayDate = epochToShiftedYmd(nowMs, explicitTz, dtf);
    const parsed = parseYmd(todayDate);
    const tomorrow = addDaysUtc(parsed.year, parsed.month, parsed.day, 1);
    const startAt = shiftedMidnightToEpoch(parsed.year, parsed.month - 1, parsed.day, explicitTz, dtf);
    const endAt = shiftedMidnightToEpoch(tomorrow.year, tomorrow.month - 1, tomorrow.day, explicitTz, dtf);

    const rows = this.db.prepare(`
      SELECT
        id, at, actor, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens, total_tokens,
        cost_usd, unit_input_usd, unit_output_usd, unit_cache_read_usd, unit_cache_write_usd, cost_source, status
      FROM model_usage
      WHERE at >= ? AND at < ?
    `).all(startAt, endAt) as unknown as RawUsageRow[];

    const prefs = this.getUsagePrefs();
    const acc = emptyMutableTotals();
    for (const row of rows) {
      addRowToTotals(acc, row);
    }
    const fin = finalizeTotals(acc, prefs.usdToCnyRate);
    return {
      date: todayDate,
      calls: fin.calls,
      totalTokens: fin.totalTokens,
      cacheReadTokens: fin.cacheReadTokens,
      cacheWriteTokens: fin.cacheWriteTokens,
      cacheHitRate: fin.cacheHitRate,
      costUsd: fin.costUsd,
      costCny: fin.costCny,
      cacheSavingsUsd: fin.cacheSavingsUsd,
      cacheSavingsCny: fin.cacheSavingsCny,
      currency: prefs.currency,
      usdToCnyRate: prefs.usdToCnyRate,
    };
  }

  queryUsage(options?: UsageQueryOptions): UsageReportView {
    const granularity: UsageGranularity = options?.granularity ?? 'day';
    if (granularity !== 'day' && granularity !== 'week' && granularity !== 'month') {
      throw new Error(`无效的统计粒度 "${String(granularity)}"，请使用 day / week / month`);
    }
    const explicitTz = options?.tzOffsetMin !== undefined ? resolveTzOffsetMin(options?.tzOffsetMin) : undefined;
    const dtf = explicitTz === undefined ? createLocalFormatter() : undefined;
    const nowMs = Date.now();
    const todayDate = epochToShiftedYmd(nowMs, explicitTz, dtf);
    const anchorDate = options?.anchorDate?.trim() || todayDate;
    const anchorParts = parseYmd(anchorDate);
    const todayParts = parseYmd(todayDate);
    const tzOffsetMin = resolveTzOffsetMin(
      explicitTz,
      shiftedMidnightToEpoch(anchorParts.year, anchorParts.month - 1, anchorParts.day, explicitTz, dtf),
      dtf,
    );
    const prefs = this.getUsagePrefs();
    const rate = prefs.usdToCnyRate;

    let startAt = 0;
    let endAt = 0;
    let prevAnchorDate = anchorDate;
    let nextAnchorDate = anchorDate;
    let periodLabel = anchorDate;
    let currentPeriodKey = anchorDate;
    const buckets: UsageBucketView[] = [];

    interface PeriodWindow {
      key: string;
      anchorDate: string;
      label: string;
      startAt: number;
      endAt: number;
      calls: number;
      totalTokens: number;
      costUsd: number;
    }
    const recentWindows: PeriodWindow[] = [];

    if (granularity === 'day') {
      const nextDay = addDaysUtc(anchorParts.year, anchorParts.month, anchorParts.day, 1);
      startAt = shiftedMidnightToEpoch(anchorParts.year, anchorParts.month - 1, anchorParts.day, explicitTz, dtf);
      endAt = shiftedMidnightToEpoch(nextDay.year, nextDay.month - 1, nextDay.day, explicitTz, dtf);
      prevAnchorDate = addDaysUtc(anchorParts.year, anchorParts.month, anchorParts.day, -1).ymd;
      nextAnchorDate = nextDay.ymd;
      periodLabel = anchorDate === todayDate ? `${anchorDate} (今天)` : anchorDate;
      currentPeriodKey = anchorDate;

      if (explicitTz !== undefined) {
        for (let h = 0; h < 24; h++) {
          const key = pad2(h);
          buckets.push({
            key,
            label: `${key}:00`,
            startAt: startAt + h * HOUR_MS,
            endAt: startAt + (h + 1) * HOUR_MS,
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            costCny: 0,
          });
        }
      } else {
        for (let bStart = startAt; bStart < endAt; bStart += HOUR_MS) {
          const bEnd = Math.min(endAt, bStart + HOUR_MS);
          const localHour = getZonedParts(bStart, dtf!).hour;
          const key = pad2(localHour);
          buckets.push({
            key,
            label: `${key}:00`,
            startAt: bStart,
            endAt: bEnd,
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            costCny: 0,
          });
        }
      }

      const todayStartUtc = todayParts.utcMidnightMs;
      const anchorStartUtc = anchorParts.utcMidnightMs;
      const windowEnd = (anchorStartUtc >= todayStartUtc - 6 * DAY_MS && anchorStartUtc <= todayStartUtc)
        ? todayParts
        : anchorParts;
      for (let offset = -6; offset <= 0; offset++) {
        const d = addDaysUtc(windowEnd.year, windowEnd.month, windowEnd.day, offset);
        const nd = addDaysUtc(d.year, d.month, d.day, 1);
        const pStart = shiftedMidnightToEpoch(d.year, d.month - 1, d.day, explicitTz, dtf);
        const pEnd = shiftedMidnightToEpoch(nd.year, nd.month - 1, nd.day, explicitTz, dtf);
        recentWindows.push({
          key: d.ymd,
          anchorDate: d.ymd,
          label: `${pad2(d.month)}/${pad2(d.day)}`,
          startAt: pStart,
          endAt: pEnd,
          calls: 0,
          totalTokens: 0,
          costUsd: 0,
        });
      }
    } else if (granularity === 'week') {
      const anchorMonOffset = (new Date(anchorParts.utcMidnightMs).getUTCDay() + 6) % 7;
      const anchorMon = addDaysUtc(anchorParts.year, anchorParts.month, anchorParts.day, -anchorMonOffset);
      const anchorSun = addDaysUtc(anchorMon.year, anchorMon.month, anchorMon.day, 6);
      const nextMon = addDaysUtc(anchorMon.year, anchorMon.month, anchorMon.day, 7);
      const prevMon = addDaysUtc(anchorMon.year, anchorMon.month, anchorMon.day, -7);

      startAt = shiftedMidnightToEpoch(anchorMon.year, anchorMon.month - 1, anchorMon.day, explicitTz, dtf);
      endAt = shiftedMidnightToEpoch(nextMon.year, nextMon.month - 1, nextMon.day, explicitTz, dtf);
      prevAnchorDate = prevMon.ymd;
      nextAnchorDate = nextMon.ymd;
      const iso = isoWeekInfo(anchorMon.utcMidnightMs);
      periodLabel = `${iso.year}年第${iso.week}周 (${pad2(anchorMon.month)}/${pad2(anchorMon.day)} ~ ${pad2(anchorSun.month)}/${pad2(anchorSun.day)})`;
      currentPeriodKey = `${iso.year}-W${pad2(iso.week)}`;

      for (let i = 0; i < 7; i++) {
        const d = addDaysUtc(anchorMon.year, anchorMon.month, anchorMon.day, i);
        const nd = addDaysUtc(d.year, d.month, d.day, 1);
        const bStart = shiftedMidnightToEpoch(d.year, d.month - 1, d.day, explicitTz, dtf);
        const bEnd = shiftedMidnightToEpoch(nd.year, nd.month - 1, nd.day, explicitTz, dtf);
        buckets.push({
          key: d.ymd,
          label: `${WEEKDAY_ZH[i]!} ${pad2(d.month)}/${pad2(d.day)}`,
          startAt: bStart,
          endAt: bEnd,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          costCny: 0,
        });
      }

      const todayMonOffset = (new Date(todayParts.utcMidnightMs).getUTCDay() + 6) % 7;
      const todayMon = addDaysUtc(todayParts.year, todayParts.month, todayParts.day, -todayMonOffset);
      const windowEndMon = (
        anchorMon.utcMidnightMs >= todayMon.utcMidnightMs - 7 * 7 * DAY_MS
        && anchorMon.utcMidnightMs <= todayMon.utcMidnightMs
      )
        ? todayMon
        : anchorMon;
      for (let w = -7; w <= 0; w++) {
        const mon = addDaysUtc(windowEndMon.year, windowEndMon.month, windowEndMon.day, w * 7);
        const sun = addDaysUtc(mon.year, mon.month, mon.day, 6);
        const nextWMon = addDaysUtc(mon.year, mon.month, mon.day, 7);
        const wIso = isoWeekInfo(mon.utcMidnightMs);
        const pStart = shiftedMidnightToEpoch(mon.year, mon.month - 1, mon.day, explicitTz, dtf);
        const pEnd = shiftedMidnightToEpoch(nextWMon.year, nextWMon.month - 1, nextWMon.day, explicitTz, dtf);
        recentWindows.push({
          key: `${wIso.year}-W${pad2(wIso.week)}`,
          anchorDate: mon.ymd,
          label: `第${wIso.week}周 (${pad2(mon.month)}/${pad2(mon.day)}~${pad2(sun.month)}/${pad2(sun.day)})`,
          startAt: pStart,
          endAt: pEnd,
          calls: 0,
          totalTokens: 0,
          costUsd: 0,
        });
      }
    } else {
      const daysInMonth = new Date(Date.UTC(anchorParts.year, anchorParts.month, 0)).getUTCDate();
      startAt = shiftedMidnightToEpoch(anchorParts.year, anchorParts.month - 1, 1, explicitTz, dtf);
      endAt = shiftedMidnightToEpoch(anchorParts.year, anchorParts.month, 1, explicitTz, dtf);
      prevAnchorDate = formatUtcYmd(new Date(Date.UTC(anchorParts.year, anchorParts.month - 2, 1)));
      nextAnchorDate = formatUtcYmd(new Date(Date.UTC(anchorParts.year, anchorParts.month, 1)));
      periodLabel = `${anchorParts.year}年${anchorParts.month}月`;
      currentPeriodKey = `${anchorParts.year}-${pad2(anchorParts.month)}`;

      for (let day = 1; day <= daysInMonth; day++) {
        const bStart = shiftedMidnightToEpoch(anchorParts.year, anchorParts.month - 1, day, explicitTz, dtf);
        const bEnd = shiftedMidnightToEpoch(anchorParts.year, anchorParts.month - 1, day + 1, explicitTz, dtf);
        buckets.push({
          key: `${anchorParts.year}-${pad2(anchorParts.month)}-${pad2(day)}`,
          label: `${day}日`,
          startAt: bStart,
          endAt: bEnd,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          costCny: 0,
        });
      }

      const todayMonthIdx = todayParts.year * 12 + (todayParts.month - 1);
      const anchorMonthIdx = anchorParts.year * 12 + (anchorParts.month - 1);
      const windowEndIdx = (anchorMonthIdx >= todayMonthIdx - 5 && anchorMonthIdx <= todayMonthIdx)
        ? todayMonthIdx
        : anchorMonthIdx;
      for (let mOff = -5; mOff <= 0; mOff++) {
        const idx = windowEndIdx + mOff;
        const yr = Math.floor(idx / 12);
        const mo = (idx % 12) + 1;
        const pStart = shiftedMidnightToEpoch(yr, mo - 1, 1, explicitTz, dtf);
        const pEnd = shiftedMidnightToEpoch(yr, mo, 1, explicitTz, dtf);
        recentWindows.push({
          key: `${yr}-${pad2(mo)}`,
          anchorDate: `${yr}-${pad2(mo)}-01`,
          label: `${yr}年${mo}月`,
          startAt: pStart,
          endAt: pEnd,
          calls: 0,
          totalTokens: 0,
          costUsd: 0,
        });
      }
    }

    const periodRows = this.db.prepare(`
      SELECT
        id, at, actor, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens, reasoning_tokens, total_tokens,
        cost_usd, unit_input_usd, unit_output_usd, unit_cache_read_usd, unit_cache_write_usd, cost_source, status
      FROM model_usage
      WHERE at >= ? AND at < ?
      ORDER BY at ASC, rowid ASC
    `).all(startAt, endAt) as unknown as RawUsageRow[];

    const totalsAcc = emptyMutableTotals();
    const actorAccMap = new Map<UsageActor, MutableTotals>();
    const modelAccMap = new Map<string, {
      spec: string;
      provider: string;
      model: string;
      totals: MutableTotals;
      actors: Partial<Record<UsageActor, number>>;
      unitInputUsdPer1M: number;
      unitOutputUsdPer1M: number;
      unitCacheReadUsdPer1M: number;
      unitCacheWriteUsdPer1M: number;
      costSource: UsageCostSource;
      lastUsedAt: number;
    }>();

    const bucketStepMs = granularity === 'day' ? HOUR_MS : DAY_MS;

    for (const row of periodRows) {
      addRowToTotals(totalsAcc, row);

      const actor: UsageActor = VALID_ACTORS.has(row.actor as UsageActor) ? (row.actor as UsageActor) : 'worker';
      let actorAcc = actorAccMap.get(actor);
      if (!actorAcc) {
        actorAcc = emptyMutableTotals();
        actorAccMap.set(actor, actorAcc);
      }
      addRowToTotals(actorAcc, row);

      const spec = `${row.provider}/${row.model}`;
      let modelAcc = modelAccMap.get(spec);
      const rowCostSource: UsageCostSource = VALID_COST_SOURCES.has(row.cost_source as UsageCostSource)
        ? (row.cost_source as UsageCostSource)
        : 'unknown';
      const { unitCacheRead, unitCacheWrite } = resolveRowCacheRates(row);
      if (!modelAcc) {
        modelAcc = {
          spec,
          provider: row.provider,
          model: row.model,
          totals: emptyMutableTotals(),
          actors: {},
          unitInputUsdPer1M: Number(row.unit_input_usd ?? 0),
          unitOutputUsdPer1M: Number(row.unit_output_usd ?? 0),
          unitCacheReadUsdPer1M: unitCacheRead,
          unitCacheWriteUsdPer1M: unitCacheWrite,
          costSource: rowCostSource,
          lastUsedAt: row.at,
        };
        modelAccMap.set(spec, modelAcc);
      }
      addRowToTotals(modelAcc.totals, row);
      modelAcc.actors[actor] = (modelAcc.actors[actor] ?? 0) + 1;
      if (row.at >= modelAcc.lastUsedAt) {
        modelAcc.lastUsedAt = row.at;
        modelAcc.unitInputUsdPer1M = Number(row.unit_input_usd ?? 0);
        modelAcc.unitOutputUsdPer1M = Number(row.unit_output_usd ?? 0);
        modelAcc.unitCacheReadUsdPer1M = unitCacheRead;
        modelAcc.unitCacheWriteUsdPer1M = unitCacheWrite;
        modelAcc.costSource = rowCostSource;
      }

      let bIdx = Math.min(buckets.length - 1, Math.max(0, Math.floor((row.at - startAt) / bucketStepMs)));
      while (bIdx > 0 && row.at < buckets[bIdx]!.startAt) bIdx--;
      while (bIdx + 1 < buckets.length && row.at >= buckets[bIdx]!.endAt) bIdx++;
      const bucket = buckets[bIdx];
      if (bucket && row.at >= bucket.startAt && row.at < bucket.endAt) {
        bucket.calls += 1;
        bucket.inputTokens += Number(row.input_tokens ?? 0);
        bucket.outputTokens += Number(row.output_tokens ?? 0);
        bucket.cacheReadTokens += Number(row.cache_read_tokens ?? 0);
        bucket.cacheWriteTokens += Number(row.cache_write_tokens ?? 0);
        bucket.totalTokens += Number(row.total_tokens ?? 0);
        bucket.costUsd += Number(row.cost_usd ?? 0);
      }
    }

    const totals = finalizeTotals(totalsAcc, rate);
    for (const bucket of buckets) {
      bucket.costUsd = roundUsd(bucket.costUsd);
      bucket.costCny = roundUsd(bucket.costUsd * rate);
    }

    const byActor: Partial<Record<UsageActor, UsageTotalsView>> = {};
    for (const [actor, acc] of actorAccMap.entries()) {
      byActor[actor] = finalizeTotals(acc, rate);
    }

    const byModel: UsageModelBreakdownView[] = [...modelAccMap.values()]
      .map(entry => {
        const fin = finalizeTotals(entry.totals, rate);
        return {
          ...fin,
          spec: entry.spec,
          provider: entry.provider,
          model: entry.model,
          tokenShare: totals.totalTokens > 0
            ? Math.min(1, Math.max(0, Number((fin.totalTokens / totals.totalTokens).toFixed(6))))
            : 0,
          costShare: totals.costUsd > 0
            ? Math.min(1, Math.max(0, Number((fin.costUsd / totals.costUsd).toFixed(6))))
            : 0,
          unitInputUsdPer1M: entry.unitInputUsdPer1M,
          unitOutputUsdPer1M: entry.unitOutputUsdPer1M,
          unitCacheReadUsdPer1M: entry.unitCacheReadUsdPer1M,
          unitCacheWriteUsdPer1M: entry.unitCacheWriteUsdPer1M,
          costSource: entry.costSource,
          actors: entry.actors,
          lastUsedAt: entry.lastUsedAt,
        };
      })
      .sort((a, b) =>
        b.costUsd - a.costUsd
        || b.totalTokens - a.totalTokens
        || b.calls - a.calls
        || a.spec.localeCompare(b.spec));

    if (recentWindows.length > 0) {
      const rangeStart = recentWindows[0]!.startAt;
      const rangeEnd = recentWindows.at(-1)!.endAt;
      const recentRows = this.db.prepare(`
        SELECT at, total_tokens, cost_usd
        FROM model_usage
        WHERE at >= ? AND at < ?
      `).all(rangeStart, rangeEnd) as Array<{ at: number; total_tokens: number; cost_usd: number }>;

      for (const r of recentRows) {
        for (const win of recentWindows) {
          if (r.at >= win.startAt && r.at < win.endAt) {
            win.calls += 1;
            win.totalTokens += Number(r.total_tokens ?? 0);
            win.costUsd += Number(r.cost_usd ?? 0);
            break;
          }
        }
      }
    }

    const recentPeriods: UsagePeriodSummaryView[] = recentWindows.map(win => {
      const costUsd = roundUsd(win.costUsd);
      return {
        key: win.key,
        anchorDate: win.anchorDate,
        label: win.label,
        isCurrent: win.key === currentPeriodKey,
        calls: win.calls,
        totalTokens: win.totalTokens,
        costUsd,
        costCny: roundUsd(costUsd * rate),
      };
    });

    return {
      granularity,
      anchorDate,
      periodLabel,
      prevAnchorDate,
      nextAnchorDate,
      todayDate,
      startAt,
      endAt,
      tzOffsetMin,
      prefs,
      totals,
      byModel,
      byActor,
      buckets,
      recentPeriods,
    };
  }
}

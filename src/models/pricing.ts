import { normalizeProviderId, splitModelAndLevel } from './catalog.js';
import {
  FALLBACK_BARE_MODEL_PRICES,
  FALLBACK_PRICES_VERSION,
  FALLBACK_PROVIDER_MODEL_PRICES,
  type CompactPriceTuple,
} from './fallback-prices.js';

export { FALLBACK_PRICES_VERSION };
export const DEFAULT_USD_TO_CNY_RATE = 7.25;

export type UsageCostSource = 'provider' | 'catalog' | 'estimated' | 'free' | 'unknown';

export interface ModelCostTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelUnitPrice {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cacheReadUsdPer1M: number;
  cacheWriteUsdPer1M: number;
  source: UsageCostSource;
}

export interface CatalogCostRateInput {
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  tiers?: readonly ModelCostTier[];
}

export interface NormalizedSdkUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
  reasoningTokens: number;
  totalTokens: number;
  providerReportedTotalUsd?: number;
  totalFromProvider?: boolean;
  sdkCatalogTotalUsd?: number;
}

export interface UsageCostCalculationInput {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  providerReportedTotalUsd?: number;
  totalFromProvider?: boolean;
  sdkCatalogTotalUsd?: number;
  catalogRate?: CatalogCostRateInput;
}

export interface UsageCostCalculationResult {
  costUsd: number;
  unitInputUsdPer1M: number;
  unitOutputUsdPer1M: number;
  unitCacheReadUsdPer1M: number;
  unitCacheWriteUsdPer1M: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  cacheSavingsUsd: number;
  costSource: UsageCostSource;
}

interface PricingRule {
  pattern: RegExp;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cacheReadUsdPer1M?: number;
  cacheWriteUsdPer1M?: number;
  free?: boolean;
}

// Ordered from most specific to least specific within each model family (wildcard net for dated variants).
const FALLBACK_UNIT_PRICES: readonly PricingRule[] = [
  // OpenAI
  { pattern: /^gpt-6\.2-astra(?=$|[-_.])/i, inputUsdPer1M: 8, outputUsdPer1M: 40, cacheReadUsdPer1M: 0.4, cacheWriteUsdPer1M: 10 },
  { pattern: /^gpt-6\.2(?=$|[-_.])/i, inputUsdPer1M: 2, outputUsdPer1M: 10, cacheReadUsdPer1M: 0.1, cacheWriteUsdPer1M: 2.5 },
  { pattern: /^gpt-6\.1-terra(?=$|[-_.])/i, inputUsdPer1M: 1, outputUsdPer1M: 5, cacheReadUsdPer1M: 0.05, cacheWriteUsdPer1M: 1.25 },
  { pattern: /^gpt-6\.1(?=$|[-_.])/i, inputUsdPer1M: 2, outputUsdPer1M: 10, cacheReadUsdPer1M: 0.1, cacheWriteUsdPer1M: 2.5 },
  { pattern: /^gpt-6-luna(?=$|[-_.])/i, inputUsdPer1M: 0.1, outputUsdPer1M: 0.5, cacheReadUsdPer1M: 0.01, cacheWriteUsdPer1M: 0.125 },
  { pattern: /^gpt-6-astra(?=$|[-_.])/i, inputUsdPer1M: 10, outputUsdPer1M: 50, cacheReadUsdPer1M: 1, cacheWriteUsdPer1M: 12.5 },
  { pattern: /^gpt-6(?=$|[-_.])/i, inputUsdPer1M: 2, outputUsdPer1M: 10, cacheReadUsdPer1M: 0.2, cacheWriteUsdPer1M: 2.5 },
  { pattern: /^gpt-5\.6-luna(?=$|[-_.])/i, inputUsdPer1M: 0.2, outputUsdPer1M: 1.2, cacheReadUsdPer1M: 0.02, cacheWriteUsdPer1M: 0.25 },
  { pattern: /^gpt-5\.6-terra(?=$|[-_.])/i, inputUsdPer1M: 2, outputUsdPer1M: 12, cacheReadUsdPer1M: 0.2, cacheWriteUsdPer1M: 2.5 },
  { pattern: /^gpt-5\.6(?=$|[-_.])/i, inputUsdPer1M: 4, outputUsdPer1M: 20, cacheReadUsdPer1M: 0.4, cacheWriteUsdPer1M: 5 },
  { pattern: /^gpt-5(?=$|[-_.])/i, inputUsdPer1M: 1.25, outputUsdPer1M: 10, cacheReadUsdPer1M: 0.125, cacheWriteUsdPer1M: 1.25 },
  { pattern: /^gpt-4\.1-mini(?=$|[-_.])/i, inputUsdPer1M: 0.4, outputUsdPer1M: 1.6, cacheReadUsdPer1M: 0.1, cacheWriteUsdPer1M: 0.4 },
  { pattern: /^gpt-4\.1-nano(?=$|[-_.])/i, inputUsdPer1M: 0.1, outputUsdPer1M: 0.4, cacheReadUsdPer1M: 0.025, cacheWriteUsdPer1M: 0.1 },
  { pattern: /^gpt-4\.1(?=$|[-_.])/i, inputUsdPer1M: 2, outputUsdPer1M: 8, cacheReadUsdPer1M: 0.5, cacheWriteUsdPer1M: 2 },
  { pattern: /^gpt-4o-mini(?=$|[-_.])/i, inputUsdPer1M: 0.15, outputUsdPer1M: 0.6, cacheReadUsdPer1M: 0.075, cacheWriteUsdPer1M: 0.15 },
  { pattern: /^gpt-4o(?=$|[-_.])/i, inputUsdPer1M: 2.5, outputUsdPer1M: 10, cacheReadUsdPer1M: 1.25, cacheWriteUsdPer1M: 2.5 },
  { pattern: /^o4-mini(?=$|[-_.])/i, inputUsdPer1M: 1.1, outputUsdPer1M: 4.4, cacheReadUsdPer1M: 0.275, cacheWriteUsdPer1M: 1.1 },
  { pattern: /^o3-mini(?=$|[-_.])/i, inputUsdPer1M: 1.1, outputUsdPer1M: 4.4, cacheReadUsdPer1M: 0.55, cacheWriteUsdPer1M: 1.1 },
  { pattern: /^o3(?=$|[-_.])/i, inputUsdPer1M: 2, outputUsdPer1M: 8, cacheReadUsdPer1M: 0.5, cacheWriteUsdPer1M: 2 },
  { pattern: /^o1(?=$|[-_.])/i, inputUsdPer1M: 15, outputUsdPer1M: 60, cacheReadUsdPer1M: 7.5, cacheWriteUsdPer1M: 15 },

  // Anthropic
  { pattern: /^claude-(?:opus-4|4-opus)(?=$|[-_.])/i, inputUsdPer1M: 15, outputUsdPer1M: 75, cacheReadUsdPer1M: 1.5, cacheWriteUsdPer1M: 18.75 },
  { pattern: /^claude-(?:sonnet-4|4-sonnet|3[-.]7-sonnet|3[-.]5-sonnet)(?=$|[-_.])/i, inputUsdPer1M: 3, outputUsdPer1M: 15, cacheReadUsdPer1M: 0.3, cacheWriteUsdPer1M: 3.75 },
  { pattern: /^claude-(?:haiku-4[-.]5|4[-.]5-haiku)(?=$|[-_.])/i, inputUsdPer1M: 1, outputUsdPer1M: 5, cacheReadUsdPer1M: 0.1, cacheWriteUsdPer1M: 1.25 },
  { pattern: /^claude-(?:3[-.]5-haiku|haiku-3[-.]5)(?=$|[-_.])/i, inputUsdPer1M: 0.8, outputUsdPer1M: 4, cacheReadUsdPer1M: 0.08, cacheWriteUsdPer1M: 1 },

  // Google
  { pattern: /^gemini-4-hydrogen(?=$|[-_.])/i, inputUsdPer1M: 1.5, outputUsdPer1M: 7.5, cacheReadUsdPer1M: 0.075, cacheWriteUsdPer1M: 1.5 },
  { pattern: /^gemini-4(?=$|[-_.])/i, inputUsdPer1M: 2, outputUsdPer1M: 10, cacheReadUsdPer1M: 0.1, cacheWriteUsdPer1M: 2 },
  { pattern: /^gemini-omni(?=$|[-_.])/i, inputUsdPer1M: 1.5, outputUsdPer1M: 9, cacheReadUsdPer1M: 0.15, cacheWriteUsdPer1M: 1.5 },
  { pattern: /^gemini-3\.[678]-flash(?=$|[-_.])/i, inputUsdPer1M: 0.75, outputUsdPer1M: 3.75, cacheReadUsdPer1M: 0.075, cacheWriteUsdPer1M: 0.75 },
  { pattern: /^gemini-3\.5-flash-lite(?=$|[-_.])/i, inputUsdPer1M: 0.3, outputUsdPer1M: 2.5, cacheReadUsdPer1M: 0.03, cacheWriteUsdPer1M: 0.3 },
  { pattern: /^gemini-3\.5-flash(?=$|[-_.])/i, inputUsdPer1M: 1.5, outputUsdPer1M: 9, cacheReadUsdPer1M: 0.15, cacheWriteUsdPer1M: 1.5 },
  { pattern: /^gemini-3\.1-pro(?=$|[-_.])/i, inputUsdPer1M: 2, outputUsdPer1M: 12, cacheReadUsdPer1M: 0.2, cacheWriteUsdPer1M: 2 },
  { pattern: /^gemini-3\.1-flash-lite(?=$|[-_.])/i, inputUsdPer1M: 0.25, outputUsdPer1M: 1.5, cacheReadUsdPer1M: 0.025, cacheWriteUsdPer1M: 0.25 },
  { pattern: /^gemini-3-flash(?=$|[-_.])/i, inputUsdPer1M: 0.5, outputUsdPer1M: 3, cacheReadUsdPer1M: 0.05, cacheWriteUsdPer1M: 0.5 },
  { pattern: /^gemini-2\.5-pro(?=$|[-_.])/i, inputUsdPer1M: 1.25, outputUsdPer1M: 10, cacheReadUsdPer1M: 0.125, cacheWriteUsdPer1M: 1.25 },
  { pattern: /^gemini-2\.5-flash-lite(?=$|[-_.])/i, inputUsdPer1M: 0.1, outputUsdPer1M: 0.4, cacheReadUsdPer1M: 0.01, cacheWriteUsdPer1M: 0.1 },
  { pattern: /^gemini-2\.5-flash(?=$|[-_.])/i, inputUsdPer1M: 0.3, outputUsdPer1M: 2.5, cacheReadUsdPer1M: 0.03, cacheWriteUsdPer1M: 0.3 },
  { pattern: /^gemini-2\.0-flash(?=$|[-_.])/i, inputUsdPer1M: 0.1, outputUsdPer1M: 0.4, cacheReadUsdPer1M: 0.025, cacheWriteUsdPer1M: 0.1 },
  { pattern: /^gemini-decision-1(?=$|[-_.])/i, inputUsdPer1M: 0.1, outputUsdPer1M: 0.4, cacheReadUsdPer1M: 0.025, cacheWriteUsdPer1M: 0.1 },

  // DeepSeek
  { pattern: /^deepseek-v4\.1-flash(?=$|[-_.])/i, inputUsdPer1M: 0.15, outputUsdPer1M: 0.6, cacheReadUsdPer1M: 0.003, cacheWriteUsdPer1M: 0.15 },
  { pattern: /^deepseek-v4-pro(?=$|[-_.])/i, inputUsdPer1M: 0.66, outputUsdPer1M: 1.98, cacheReadUsdPer1M: 0.022, cacheWriteUsdPer1M: 0.66 },
  { pattern: /^deepseek-v4(?=$|[-_.])/i, inputUsdPer1M: 0.15, outputUsdPer1M: 0.6, cacheReadUsdPer1M: 0.003, cacheWriteUsdPer1M: 0.15 },
  { pattern: /^deepseek-(?:reasoner|r1)(?=$|[-_.])/i, inputUsdPer1M: 0.55, outputUsdPer1M: 2.19, cacheReadUsdPer1M: 0.14, cacheWriteUsdPer1M: 0.55 },
  { pattern: /^deepseek-(?:chat|v3)(?=$|[-_.])/i, inputUsdPer1M: 0.27, outputUsdPer1M: 1.1, cacheReadUsdPer1M: 0.07, cacheWriteUsdPer1M: 0.27 },

  // DashScope / Qwen (check qwen-vl before qwen-max so qwen-vl-max matches VL pricing)
  { pattern: /^qwen-vl(?=$|[-_.])/i, inputUsdPer1M: 0.8, outputUsdPer1M: 2.4, cacheReadUsdPer1M: 0.16, cacheWriteUsdPer1M: 1 },
  { pattern: /^qwen-max(?=$|[-_.])/i, inputUsdPer1M: 1.6, outputUsdPer1M: 6.4, cacheReadUsdPer1M: 0.32, cacheWriteUsdPer1M: 2 },
  { pattern: /^qwen-(?:coder|plus)(?=$|[-_.])/i, inputUsdPer1M: 0.5, outputUsdPer1M: 1.5, cacheReadUsdPer1M: 0.1, cacheWriteUsdPer1M: 0.625 },
  { pattern: /^qwen-(?:turbo|flash)(?=$|[-_.])/i, inputUsdPer1M: 0.05, outputUsdPer1M: 0.2, cacheReadUsdPer1M: 0.01, cacheWriteUsdPer1M: 0.0625 },
  { pattern: /^qwen3(?=$|[-_.])/i, inputUsdPer1M: 0.4, outputUsdPer1M: 1.2, cacheReadUsdPer1M: 0.08, cacheWriteUsdPer1M: 0.5 },

  // Moonshot
  { pattern: /^kimi-k2(?=$|[-_.])/i, inputUsdPer1M: 1, outputUsdPer1M: 3, cacheReadUsdPer1M: 0.2, cacheWriteUsdPer1M: 1 },
  { pattern: /^moonshot-v1-128k(?=$|[-_.])/i, inputUsdPer1M: 1, outputUsdPer1M: 3, cacheReadUsdPer1M: 0.2, cacheWriteUsdPer1M: 1 },
  { pattern: /^moonshot-v1-32k(?=$|[-_.])/i, inputUsdPer1M: 0.2, outputUsdPer1M: 0.6, cacheReadUsdPer1M: 0.04, cacheWriteUsdPer1M: 0.2 },
  { pattern: /^moonshot-v1-8k(?=$|[-_.])/i, inputUsdPer1M: 0.15, outputUsdPer1M: 0.5, cacheReadUsdPer1M: 0.03, cacheWriteUsdPer1M: 0.15 },

  // Zhipu
  { pattern: /^glm-4-flash(?=$|[-_.])/i, inputUsdPer1M: 0, outputUsdPer1M: 0, free: true },
  { pattern: /^glm-4\.5-air(?=$|[-_.])/i, inputUsdPer1M: 0.2, outputUsdPer1M: 1.1, cacheReadUsdPer1M: 0.05, cacheWriteUsdPer1M: 0.2 },
  { pattern: /^glm-(?:4\.5|4v?|4)(?=$|[-_.])/i, inputUsdPer1M: 0.8, outputUsdPer1M: 2, cacheReadUsdPer1M: 0.16, cacheWriteUsdPer1M: 0.8 },

  // xAI
  { pattern: /^grok-4(?=$|[-_.])/i, inputUsdPer1M: 3, outputUsdPer1M: 15, cacheReadUsdPer1M: 0.75, cacheWriteUsdPer1M: 3 },
  { pattern: /^grok-3-mini(?=$|[-_.])/i, inputUsdPer1M: 0.3, outputUsdPer1M: 0.5, cacheReadUsdPer1M: 0.075, cacheWriteUsdPer1M: 0.3 },
  { pattern: /^grok-3(?=$|[-_.])/i, inputUsdPer1M: 3, outputUsdPer1M: 15, cacheReadUsdPer1M: 0.75, cacheWriteUsdPer1M: 3 },
];

const ZERO_FREE_PRICE: ModelUnitPrice = {
  inputUsdPer1M: 0,
  outputUsdPer1M: 0,
  cacheReadUsdPer1M: 0,
  cacheWriteUsdPer1M: 0,
  source: 'free',
};

const ZERO_UNKNOWN_PRICE: ModelUnitPrice = {
  inputUsdPer1M: 0,
  outputUsdPer1M: 0,
  cacheReadUsdPer1M: 0,
  cacheWriteUsdPer1M: 0,
  source: 'unknown',
};

function sanitizeNonNeg(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function sanitizePositive(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

function sanitizeTokenInt(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function roundUsd(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number(amount.toFixed(10));
}

export function roundSignedUsd(amount: number): number {
  if (!Number.isFinite(amount) || amount === 0) return 0;
  const rounded = Number(amount.toFixed(10));
  return rounded === 0 ? 0 : rounded;
}

function roundRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Number(rate.toFixed(6));
}

function deriveDefaultCacheReadRate(inputUsdPer1M: number, normProvider: string, normalizedModel: string): number {
  if (inputUsdPer1M <= 0) return 0;
  if (normProvider === 'anthropic' || /^claude[-_.]/i.test(normalizedModel)) {
    return roundRate(inputUsdPer1M * 0.1);
  }
  if (normProvider === 'google' || normProvider === 'google-vertex' || /^gemini[-_.]/i.test(normalizedModel)) {
    return roundRate(inputUsdPer1M * 0.1);
  }
  if (/^gpt-[56](?=$|[-_.])/i.test(normalizedModel)) {
    return roundRate(inputUsdPer1M * 0.1);
  }
  if (/^gpt-4o(?=$|[-_.])/i.test(normalizedModel)) {
    return roundRate(inputUsdPer1M * 0.5);
  }
  if (normProvider === 'deepseek' || /^deepseek[-_.]/i.test(normalizedModel)) {
    return roundRate(inputUsdPer1M * 0.1);
  }
  if (
    normProvider === 'dashscope'
    || normProvider === 'alibaba'
    || normProvider === 'moonshot'
    || normProvider === 'moonshotai'
    || normProvider === 'zhipu'
    || normProvider === 'zai'
    || normProvider === 'minimax'
    || /^(?:qwen|kimi|moonshot|glm|minimax)[-_.\d]/i.test(normalizedModel)
  ) {
    return roundRate(inputUsdPer1M * 0.2);
  }
  return roundRate(inputUsdPer1M * 0.25);
}

function deriveDefaultCacheWriteRate(inputUsdPer1M: number, normProvider: string, normalizedModel: string): number {
  if (inputUsdPer1M <= 0) return 0;
  if (normProvider === 'anthropic' || /^claude[-_.]/i.test(normalizedModel)) {
    return roundRate(inputUsdPer1M * 1.25);
  }
  // Paid models without an explicit cache-write surcharge still bill written prompt tokens at 1.0x input
  // because `inputTokens` already excludes `cacheWriteTokens`.
  return roundRate(inputUsdPer1M);
}

function tupleToUnitPrice(
  tuple: CompactPriceTuple,
  normProvider: string,
  normalizedModel: string,
): ModelUnitPrice {
  const [inp, out, cr, cw] = tuple;
  if (inp === 0 && out === 0 && cr === 0 && cw === 0) {
    return { ...ZERO_FREE_PRICE };
  }
  return {
    inputUsdPer1M: inp,
    outputUsdPer1M: out,
    cacheReadUsdPer1M: cr > 0 ? cr : deriveDefaultCacheReadRate(inp, normProvider, normalizedModel),
    cacheWriteUsdPer1M: cw > 0 ? cw : deriveDefaultCacheWriteRate(inp, normProvider, normalizedModel),
    source: 'estimated',
  };
}

/** Strips `@thinkingLevel` and any `provider/` prefix, returning a lowercase bare model ID. */
export function normalizeModelIdForPricing(model: string): string {
  const withoutLevel = splitModelAndLevel(model.trim()).model;
  const slashIdx = withoutLevel.lastIndexOf('/');
  const bare = slashIdx >= 0 ? withoutLevel.slice(slashIdx + 1) : withoutLevel;
  return bare.trim().toLowerCase();
}

function resolveFallbackUnitPrice(
  normProvider: string,
  cleanedFull: string,
  normalizedModel: string,
): ModelUnitPrice {
  if (normProvider && cleanedFull) {
    const exactProvTuple = FALLBACK_PROVIDER_MODEL_PRICES[`${normProvider}/${cleanedFull}`]
      ?? (normalizedModel ? FALLBACK_PROVIDER_MODEL_PRICES[`${normProvider}/${normalizedModel}`] : undefined);
    if (exactProvTuple) {
      return tupleToUnitPrice(exactProvTuple, normProvider, normalizedModel);
    }
  }

  if (normalizedModel) {
    const exactBareTuple = (cleanedFull ? FALLBACK_BARE_MODEL_PRICES[cleanedFull] : undefined)
      ?? FALLBACK_BARE_MODEL_PRICES[normalizedModel];
    if (exactBareTuple) {
      return tupleToUnitPrice(exactBareTuple, normProvider, normalizedModel);
    }

    if (/(?::free|-free)$/i.test(normalizedModel)) {
      return { ...ZERO_FREE_PRICE };
    }

    // Try stripping common trailing date suffixes (e.g. -20260401 / -0731) on synced bare table
    const undate = normalizedModel.replace(/-(?:20\d{6}|\d{4})$/, '');
    if (undate !== normalizedModel) {
      const undateTuple = (normProvider ? FALLBACK_PROVIDER_MODEL_PRICES[`${normProvider}/${undate}`] : undefined)
        ?? FALLBACK_BARE_MODEL_PRICES[undate];
      if (undateTuple) {
        return tupleToUnitPrice(undateTuple, normProvider, undate);
      }
    }

    for (const rule of FALLBACK_UNIT_PRICES) {
      if (rule.pattern.test(normalizedModel)) {
        if (rule.free) {
          return { ...ZERO_FREE_PRICE };
        }
        return {
          inputUsdPer1M: rule.inputUsdPer1M,
          outputUsdPer1M: rule.outputUsdPer1M,
          cacheReadUsdPer1M: rule.cacheReadUsdPer1M ?? deriveDefaultCacheReadRate(rule.inputUsdPer1M, normProvider, normalizedModel),
          cacheWriteUsdPer1M: rule.cacheWriteUsdPer1M ?? deriveDefaultCacheWriteRate(rule.inputUsdPer1M, normProvider, normalizedModel),
          source: 'estimated',
        };
      }
    }
  }

  return { ...ZERO_UNKNOWN_PRICE };
}

/** Resolves USD per 1M token unit pricing for a provider/model pair. */
export function resolveModelUnitPrice(
  provider: string,
  model: string,
  catalogRate?: CatalogCostRateInput,
): ModelUnitPrice {
  const normProvider = (normalizeProviderId(provider) ?? provider.trim()).toLowerCase();
  const trimmedModel = model.trim().toLowerCase();
  if (
    normProvider === 'offline'
    || normProvider === 'ollama'
    || trimmedModel.startsWith('offline/')
    || trimmedModel.startsWith('ollama/')
  ) {
    return { ...ZERO_FREE_PRICE };
  }

  const cleanedFull = splitModelAndLevel(model.trim()).model.trim().toLowerCase();
  const normalizedModel = normalizeModelIdForPricing(model);

  const catalogInput = sanitizeNonNeg(catalogRate?.costInput);
  const catalogOutput = sanitizeNonNeg(catalogRate?.costOutput);
  if (catalogInput > 0 || catalogOutput > 0) {
    const explicitCr = sanitizePositive(catalogRate?.costCacheRead);
    const explicitCw = sanitizePositive(catalogRate?.costCacheWrite);
    const fallback = (explicitCr === undefined || explicitCw === undefined)
      ? resolveFallbackUnitPrice(normProvider, cleanedFull, normalizedModel)
      : undefined;

    let cacheRead: number;
    if (explicitCr !== undefined) {
      cacheRead = explicitCr;
    } else if (catalogInput <= 0) {
      cacheRead = 0;
    } else if (fallback && fallback.source === 'estimated' && fallback.inputUsdPer1M > 0 && fallback.cacheReadUsdPer1M > 0) {
      cacheRead = catalogInput === fallback.inputUsdPer1M
        ? fallback.cacheReadUsdPer1M
        : roundRate(catalogInput * (fallback.cacheReadUsdPer1M / fallback.inputUsdPer1M));
    } else {
      cacheRead = deriveDefaultCacheReadRate(catalogInput, normProvider, normalizedModel);
    }

    let cacheWrite: number;
    if (explicitCw !== undefined) {
      cacheWrite = explicitCw;
    } else if (catalogInput <= 0) {
      cacheWrite = 0;
    } else if (fallback && fallback.source === 'estimated' && fallback.inputUsdPer1M > 0 && fallback.cacheWriteUsdPer1M > 0) {
      cacheWrite = catalogInput === fallback.inputUsdPer1M
        ? fallback.cacheWriteUsdPer1M
        : roundRate(catalogInput * (fallback.cacheWriteUsdPer1M / fallback.inputUsdPer1M));
    } else {
      cacheWrite = deriveDefaultCacheWriteRate(catalogInput, normProvider, normalizedModel);
    }

    return {
      inputUsdPer1M: catalogInput,
      outputUsdPer1M: catalogOutput,
      cacheReadUsdPer1M: cacheRead,
      cacheWriteUsdPer1M: cacheWrite,
      source: 'catalog',
    };
  }

  return resolveFallbackUnitPrice(normProvider, cleanedFull, normalizedModel);
}

function applyPricingTier(
  unitPrice: ModelUnitPrice,
  totalPromptTokens: number,
  tiers: readonly ModelCostTier[] | undefined,
  normProvider: string,
  normalizedModel: string,
): ModelUnitPrice {
  if (!tiers?.length || totalPromptTokens <= 0 || unitPrice.source === 'free' || unitPrice.source === 'unknown') {
    return unitPrice;
  }
  let matched: ModelCostTier | undefined;
  for (const tier of tiers) {
    if (
      typeof tier.inputTokensAbove === 'number'
      && Number.isFinite(tier.inputTokensAbove)
      && totalPromptTokens > tier.inputTokensAbove
      && (!matched || tier.inputTokensAbove > matched.inputTokensAbove)
    ) {
      matched = tier;
    }
  }
  if (!matched) return unitPrice;
  const nextInput = sanitizeNonNeg(matched.input);
  const nextOutput = sanitizeNonNeg(matched.output);
  if (nextInput <= 0 && nextOutput <= 0) return unitPrice;

  const scale = unitPrice.inputUsdPer1M > 0 ? nextInput / unitPrice.inputUsdPer1M : 1;
  const tierCr = sanitizePositive(matched.cacheRead);
  const tierCw = sanitizePositive(matched.cacheWrite);
  return {
    inputUsdPer1M: nextInput,
    outputUsdPer1M: nextOutput,
    cacheReadUsdPer1M: tierCr !== undefined
      ? tierCr
      : (unitPrice.cacheReadUsdPer1M > 0
          ? roundRate(unitPrice.cacheReadUsdPer1M * scale)
          : deriveDefaultCacheReadRate(nextInput, normProvider, normalizedModel)),
    cacheWriteUsdPer1M: tierCw !== undefined
      ? tierCw
      : (unitPrice.cacheWriteUsdPer1M > 0
          ? roundRate(unitPrice.cacheWriteUsdPer1M * scale)
          : deriveDefaultCacheWriteRate(nextInput, normProvider, normalizedModel)),
    source: unitPrice.source,
  };
}

/**
 * Computes net USD saved (positive) or net surcharge (negative, e.g. write-only turn)
 * relative to billing all prompt tokens at the base input rate.
 */
export function computeCacheSavingsUsd(input: {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens?: number;
  unitInputUsdPer1M: number;
  unitCacheReadUsdPer1M: number;
  unitCacheWriteUsdPer1M: number;
}): number {
  const unitIn = sanitizeNonNeg(input.unitInputUsdPer1M);
  if (unitIn <= 0) return 0;
  const cacheRead = sanitizeTokenInt(input.cacheReadTokens);
  const cacheWrite = sanitizeTokenInt(input.cacheWriteTokens);
  if (cacheRead === 0 && cacheWrite === 0) return 0;
  const longWrite = Math.min(cacheWrite, sanitizeTokenInt(input.cacheWrite1hTokens));
  const shortWrite = cacheWrite - longWrite;
  const unitCr = sanitizeNonNeg(input.unitCacheReadUsdPer1M);
  const unitCw = sanitizeNonNeg(input.unitCacheWriteUsdPer1M);
  // Anthropic 1h cache writes are billed at 2x base input price.
  const readDelta = cacheRead * (unitIn - unitCr);
  const shortWriteDelta = shortWrite * (unitIn - unitCw);
  const longWriteDelta = longWrite * (unitIn - unitIn * 2);
  return roundSignedUsd((readDelta + shortWriteDelta + longWriteDelta) / 1_000_000);
}

/**
 * Calculates single-call USD cost.
 * Note: `@earendil-works/pi-ai` `usage.output` ALREADY includes `usage.reasoning`,
 * `usage.input` excludes `usage.cacheRead` and `usage.cacheWrite`,
 * and `totalTokens = input + output + cacheRead + cacheWrite`, so neither reasoning
 * nor cached tokens are double-counted.
 */
export function calculateModelCallCost(input: UsageCostCalculationInput): UsageCostCalculationResult {
  const inputTokens = sanitizeTokenInt(input.inputTokens);
  const outputTokens = sanitizeTokenInt(input.outputTokens);
  const cacheReadTokens = sanitizeTokenInt(input.cacheReadTokens);
  const cacheWriteTokens = sanitizeTokenInt(input.cacheWriteTokens);
  const longWriteTokens = Math.min(cacheWriteTokens, sanitizeTokenInt(input.cacheWrite1hTokens));
  const shortWriteTokens = cacheWriteTokens - longWriteTokens;

  const normProvider = (normalizeProviderId(input.provider) ?? input.provider.trim()).toLowerCase();
  const normalizedModel = normalizeModelIdForPricing(input.model);
  const baseUnitPrice = resolveModelUnitPrice(input.provider, input.model, input.catalogRate);
  const totalPromptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
  const unitPrice = applyPricingTier(
    baseUnitPrice,
    totalPromptTokens,
    input.catalogRate?.tiers,
    normProvider,
    normalizedModel,
  );

  const cacheReadCostUsd = roundUsd((cacheReadTokens * unitPrice.cacheReadUsdPer1M) / 1_000_000);
  const cacheWriteCostUsd = roundUsd(
    (shortWriteTokens * unitPrice.cacheWriteUsdPer1M + longWriteTokens * unitPrice.inputUsdPer1M * 2) / 1_000_000,
  );
  const cacheSavingsUsd = computeCacheSavingsUsd({
    cacheReadTokens,
    cacheWriteTokens,
    cacheWrite1hTokens: longWriteTokens,
    unitInputUsdPer1M: unitPrice.inputUsdPer1M,
    unitCacheReadUsdPer1M: unitPrice.cacheReadUsdPer1M,
    unitCacheWriteUsdPer1M: unitPrice.cacheWriteUsdPer1M,
  });

  if (
    input.totalFromProvider === true
    && typeof input.providerReportedTotalUsd === 'number'
    && Number.isFinite(input.providerReportedTotalUsd)
    && input.providerReportedTotalUsd > 0
    && unitPrice.source !== 'free'
  ) {
    return {
      costUsd: roundUsd(input.providerReportedTotalUsd),
      unitInputUsdPer1M: unitPrice.inputUsdPer1M,
      unitOutputUsdPer1M: unitPrice.outputUsdPer1M,
      unitCacheReadUsdPer1M: unitPrice.cacheReadUsdPer1M,
      unitCacheWriteUsdPer1M: unitPrice.cacheWriteUsdPer1M,
      cacheReadCostUsd,
      cacheWriteCostUsd,
      cacheSavingsUsd,
      costSource: 'provider',
    };
  }

  if (
    unitPrice.source === 'unknown'
    && typeof input.sdkCatalogTotalUsd === 'number'
    && Number.isFinite(input.sdkCatalogTotalUsd)
    && input.sdkCatalogTotalUsd > 0
  ) {
    return {
      costUsd: roundUsd(input.sdkCatalogTotalUsd),
      unitInputUsdPer1M: 0,
      unitOutputUsdPer1M: 0,
      unitCacheReadUsdPer1M: 0,
      unitCacheWriteUsdPer1M: 0,
      cacheReadCostUsd: 0,
      cacheWriteCostUsd: 0,
      cacheSavingsUsd: 0,
      costSource: 'catalog',
    };
  }

  const rawUsd = (
    inputTokens * unitPrice.inputUsdPer1M
    + outputTokens * unitPrice.outputUsdPer1M
    + cacheReadTokens * unitPrice.cacheReadUsdPer1M
    + shortWriteTokens * unitPrice.cacheWriteUsdPer1M
    + longWriteTokens * unitPrice.inputUsdPer1M * 2
  ) / 1_000_000;

  return {
    costUsd: roundUsd(rawUsd),
    unitInputUsdPer1M: unitPrice.inputUsdPer1M,
    unitOutputUsdPer1M: unitPrice.outputUsdPer1M,
    unitCacheReadUsdPer1M: unitPrice.cacheReadUsdPer1M,
    unitCacheWriteUsdPer1M: unitPrice.cacheWriteUsdPer1M,
    cacheReadCostUsd,
    cacheWriteCostUsd,
    cacheSavingsUsd,
    costSource: unitPrice.source,
  };
}

/**
 * Normalizes SDK `AssistantMessage.usage`, `CompactionResult.usage`, Decision API usage,
 * or raw provider usage payloads (OpenAI Chat/Responses, Anthropic, Google Gemini, DeepSeek/Kimi)
 * into canonical exclusive token counts without double-counting cached or reasoning tokens.
 */
export function normalizeSdkUsage(rawUsage: unknown): NormalizedSdkUsage | undefined {
  const u = asRecord(rawUsage);
  if (!u) return undefined;

  const promptDetails = asRecord(u.prompt_tokens_details);
  const completionDetails = asRecord(u.completion_tokens_details);
  const inputDetails = asRecord(u.input_tokens_details);
  const outputDetails = asRecord(u.output_tokens_details);
  const cacheCreation = asRecord(u.cache_creation);

  const hasField = (obj: Record<string, unknown> | undefined, key: string): boolean =>
    Boolean(obj && obj[key] !== undefined && obj[key] !== null);

  const hasAnyTokenField = [
    'input',
    'output',
    'cacheRead',
    'cacheWrite',
    'cacheWrite1h',
    'reasoning',
    'totalTokens',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'cacheWrite1hTokens',
    'reasoningTokens',
    'total_input_tokens',
    'total_output_tokens',
    'total_cached_tokens',
    'cached_input_tokens',
    'total_tokens',
    'prompt_tokens',
    'completion_tokens',
    'prompt_cache_hit_tokens',
    'prompt_cache_miss_tokens',
    'cached_tokens',
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'promptTokenCount',
    'candidatesTokenCount',
    'cachedContentTokenCount',
    'thoughtsTokenCount',
    'totalTokenCount',
  ].some(key => hasField(u, key))
    || hasField(promptDetails, 'cached_tokens')
    || hasField(promptDetails, 'cache_write_tokens')
    || hasField(inputDetails, 'cached_tokens')
    || hasField(inputDetails, 'cache_write_tokens')
    || hasField(cacheCreation, 'ephemeral_1h_input_tokens')
    || hasField(cacheCreation, 'ephemeral_5m_input_tokens');
  if (!hasAnyTokenField) return undefined;

  const hasCanonicalFields = hasField(u, 'input')
    || hasField(u, 'output')
    || hasField(u, 'cacheRead')
    || hasField(u, 'cacheWrite')
    || hasField(u, 'cacheWrite1h')
    || hasField(u, 'inputTokens')
    || hasField(u, 'outputTokens')
    || hasField(u, 'cacheReadTokens')
    || hasField(u, 'cacheWriteTokens')
    || hasField(u, 'cacheWrite1hTokens');

  const isGeminiRaw = !hasCanonicalFields && (
    hasField(u, 'promptTokenCount')
    || hasField(u, 'candidatesTokenCount')
    || hasField(u, 'cachedContentTokenCount')
    || hasField(u, 'thoughtsTokenCount')
    || hasField(u, 'totalTokenCount')
  );

  const isOpenAiChatRaw = !hasCanonicalFields && !isGeminiRaw && (
    hasField(u, 'prompt_tokens')
    || hasField(u, 'completion_tokens')
    || hasField(u, 'prompt_cache_hit_tokens')
    || hasField(u, 'prompt_cache_miss_tokens')
    || Boolean(promptDetails)
    || Boolean(completionDetails)
  );

  const isAnthropicRaw = !hasCanonicalFields && !isGeminiRaw && !isOpenAiChatRaw && (
    hasField(u, 'cache_read_input_tokens')
    || hasField(u, 'cache_creation_input_tokens')
    || Boolean(cacheCreation)
  );

  const isOpenAiResponsesRaw = !hasCanonicalFields && !isGeminiRaw && !isOpenAiChatRaw && !isAnthropicRaw && (
    hasField(u, 'input_tokens')
    || hasField(u, 'output_tokens')
    || Boolean(inputDetails)
    || Boolean(outputDetails)
  );

  const isDecisionRaw = !hasCanonicalFields && !isGeminiRaw && !isOpenAiChatRaw && !isAnthropicRaw && !isOpenAiResponsesRaw && (
    hasField(u, 'total_input_tokens')
    || hasField(u, 'total_output_tokens')
    || hasField(u, 'total_cached_tokens')
    || hasField(u, 'cached_input_tokens')
  );

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cacheWrite1hTokens = 0;
  let reasoningTokens = 0;
  let rawTotal = 0;

  if (hasCanonicalFields) {
    // pi-ai & internal canonical format: input is ALREADY exclusive of cacheRead/cacheWrite.
    inputTokens = sanitizeTokenInt(u.input ?? u.inputTokens);
    cacheReadTokens = sanitizeTokenInt(u.cacheRead ?? u.cacheReadTokens);
    cacheWriteTokens = sanitizeTokenInt(u.cacheWrite ?? u.cacheWriteTokens);
    cacheWrite1hTokens = sanitizeTokenInt(u.cacheWrite1h ?? u.cacheWrite1hTokens);
    reasoningTokens = sanitizeTokenInt(u.reasoning ?? u.reasoningTokens);
    rawTotal = sanitizeTokenInt(u.totalTokens ?? u.total_tokens);
    const hasExplicitOutput = hasField(u, 'output') || hasField(u, 'outputTokens');
    outputTokens = hasExplicitOutput
      ? sanitizeTokenInt(u.output ?? u.outputTokens)
      : Math.max(0, rawTotal - inputTokens - cacheReadTokens - cacheWriteTokens);
  } else if (isGeminiRaw) {
    // Google Gemini usageMetadata: promptTokenCount INCLUDES cachedContentTokenCount.
    cacheReadTokens = sanitizeTokenInt(u.cachedContentTokenCount);
    inputTokens = Math.max(0, sanitizeTokenInt(u.promptTokenCount) - cacheReadTokens);
    reasoningTokens = sanitizeTokenInt(u.thoughtsTokenCount);
    outputTokens = sanitizeTokenInt(u.candidatesTokenCount) + reasoningTokens;
    rawTotal = sanitizeTokenInt(u.totalTokenCount);
  } else if (isOpenAiChatRaw) {
    // OpenAI Chat / DeepSeek / Kimi / OpenRouter / DashScope: prompt_tokens INCLUDES cached tokens.
    cacheReadTokens = sanitizeTokenInt(
      promptDetails?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens,
    );
    const promptCacheCreation = asRecord(promptDetails?.cache_creation);
    cacheWrite1hTokens = sanitizeTokenInt(promptCacheCreation?.ephemeral_1h_input_tokens);
    cacheWriteTokens = sanitizeTokenInt(
      promptDetails?.cache_write_tokens
        ?? promptDetails?.cache_creation_input_tokens
        ?? u.cache_creation_input_tokens,
    );
    inputTokens = hasField(u, 'prompt_cache_miss_tokens')
      ? sanitizeTokenInt(u.prompt_cache_miss_tokens)
      : Math.max(0, sanitizeTokenInt(u.prompt_tokens) - cacheReadTokens - cacheWriteTokens);
    reasoningTokens = sanitizeTokenInt(completionDetails?.reasoning_tokens);
    rawTotal = sanitizeTokenInt(u.total_tokens);
    outputTokens = hasField(u, 'completion_tokens')
      ? sanitizeTokenInt(u.completion_tokens)
      : Math.max(0, rawTotal - inputTokens - cacheReadTokens - cacheWriteTokens);
  } else if (isAnthropicRaw) {
    // Anthropic Messages API: input_tokens EXCLUDES cache_read_input_tokens & cache_creation_input_tokens.
    inputTokens = sanitizeTokenInt(u.input_tokens);
    cacheReadTokens = sanitizeTokenInt(u.cache_read_input_tokens);
    cacheWrite1hTokens = sanitizeTokenInt(cacheCreation?.ephemeral_1h_input_tokens);
    const ephemeral5m = sanitizeTokenInt(cacheCreation?.ephemeral_5m_input_tokens);
    cacheWriteTokens = hasField(u, 'cache_creation_input_tokens')
      ? sanitizeTokenInt(u.cache_creation_input_tokens)
      : (ephemeral5m + cacheWrite1hTokens);
    reasoningTokens = sanitizeTokenInt(outputDetails?.thinking_tokens ?? outputDetails?.reasoning_tokens);
    outputTokens = sanitizeTokenInt(u.output_tokens);
    rawTotal = sanitizeTokenInt(u.total_tokens);
  } else if (isOpenAiResponsesRaw) {
    // OpenAI Responses API: input_tokens INCLUDES input_tokens_details.cached_tokens & cache_write_tokens.
    cacheReadTokens = sanitizeTokenInt(inputDetails?.cached_tokens ?? u.cached_tokens);
    cacheWriteTokens = sanitizeTokenInt(inputDetails?.cache_write_tokens);
    inputTokens = Math.max(0, sanitizeTokenInt(u.input_tokens) - cacheReadTokens - cacheWriteTokens);
    reasoningTokens = sanitizeTokenInt(outputDetails?.reasoning_tokens);
    rawTotal = sanitizeTokenInt(u.total_tokens);
    outputTokens = hasField(u, 'output_tokens')
      ? sanitizeTokenInt(u.output_tokens)
      : Math.max(0, rawTotal - inputTokens - cacheReadTokens - cacheWriteTokens);
  } else if (isDecisionRaw) {
    // Gemini Decision API: total_input_tokens includes any cached tokens if reported.
    cacheReadTokens = sanitizeTokenInt(u.total_cached_tokens ?? u.cached_input_tokens ?? u.cached_tokens);
    inputTokens = Math.max(0, sanitizeTokenInt(u.total_input_tokens) - cacheReadTokens);
    rawTotal = sanitizeTokenInt(u.total_tokens);
    outputTokens = hasField(u, 'total_output_tokens')
      ? sanitizeTokenInt(u.total_output_tokens)
      : Math.max(0, rawTotal - inputTokens - cacheReadTokens);
  } else {
    rawTotal = sanitizeTokenInt(u.totalTokens ?? u.total_tokens);
    cacheReadTokens = sanitizeTokenInt(u.cached_tokens);
    reasoningTokens = sanitizeTokenInt(u.reasoning ?? u.reasoningTokens);
    outputTokens = Math.max(0, rawTotal - cacheReadTokens);
  }

  cacheWrite1hTokens = Math.min(cacheWriteTokens, cacheWrite1hTokens);
  const componentSum = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const totalTokens = rawTotal > 0 ? Math.max(rawTotal, componentSum) : componentSum;

  const costObj = asRecord(u.cost);
  const totalFromProvider = costObj?.totalFromProvider === true;
  const rawTotalCost = costObj?.total !== undefined ? Number(costObj.total) : undefined;
  const hasPositiveCostTotal = typeof rawTotalCost === 'number' && Number.isFinite(rawTotalCost) && rawTotalCost > 0;
  const providerReportedTotalUsd = totalFromProvider && hasPositiveCostTotal ? rawTotalCost : undefined;
  const sdkCatalogTotalUsd = !totalFromProvider && hasPositiveCostTotal ? rawTotalCost : undefined;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(cacheWrite1hTokens > 0 ? { cacheWrite1hTokens } : {}),
    reasoningTokens,
    totalTokens,
    ...(providerReportedTotalUsd !== undefined ? { providerReportedTotalUsd, totalFromProvider: true } : {}),
    ...(sdkCatalogTotalUsd !== undefined ? { sdkCatalogTotalUsd } : {}),
  };
}

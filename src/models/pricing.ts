import { normalizeProviderId, splitModelAndLevel } from './catalog.js';

export const DEFAULT_USD_TO_CNY_RATE = 7.25;

export type UsageCostSource = 'provider' | 'catalog' | 'estimated' | 'free' | 'unknown';

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
}

export interface NormalizedSdkUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  providerReportedTotalUsd?: number;
  totalFromProvider?: boolean;
}

export interface UsageCostCalculationInput {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  providerReportedTotalUsd?: number;
  totalFromProvider?: boolean;
  catalogRate?: CatalogCostRateInput;
}

export interface UsageCostCalculationResult {
  costUsd: number;
  unitInputUsdPer1M: number;
  unitOutputUsdPer1M: number;
  costSource: UsageCostSource;
}

interface PricingRule {
  pattern: RegExp;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  free?: boolean;
}

// Ordered from most specific to least specific within each model family.
const FALLBACK_UNIT_PRICES: readonly PricingRule[] = [
  // OpenAI
  { pattern: /^gpt-5(?=$|[-_.])/i, inputUsdPer1M: 1.25, outputUsdPer1M: 10 },
  { pattern: /^gpt-4\.1-mini(?=$|[-_.])/i, inputUsdPer1M: 0.4, outputUsdPer1M: 1.6 },
  { pattern: /^gpt-4\.1-nano(?=$|[-_.])/i, inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 },
  { pattern: /^gpt-4\.1(?=$|[-_.])/i, inputUsdPer1M: 2, outputUsdPer1M: 8 },
  { pattern: /^gpt-4o-mini(?=$|[-_.])/i, inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  { pattern: /^gpt-4o(?=$|[-_.])/i, inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
  { pattern: /^o4-mini(?=$|[-_.])/i, inputUsdPer1M: 1.1, outputUsdPer1M: 4.4 },
  { pattern: /^o3-mini(?=$|[-_.])/i, inputUsdPer1M: 1.1, outputUsdPer1M: 4.4 },
  { pattern: /^o3(?=$|[-_.])/i, inputUsdPer1M: 2, outputUsdPer1M: 8 },
  { pattern: /^o1(?=$|[-_.])/i, inputUsdPer1M: 15, outputUsdPer1M: 60 },

  // Anthropic
  { pattern: /^claude-(?:opus-4|4-opus)(?=$|[-_.])/i, inputUsdPer1M: 15, outputUsdPer1M: 75 },
  { pattern: /^claude-(?:sonnet-4|4-sonnet|3[-.]7-sonnet|3[-.]5-sonnet)(?=$|[-_.])/i, inputUsdPer1M: 3, outputUsdPer1M: 15 },
  { pattern: /^claude-(?:haiku-4[-.]5|4[-.]5-haiku)(?=$|[-_.])/i, inputUsdPer1M: 1, outputUsdPer1M: 5 },
  { pattern: /^claude-(?:3[-.]5-haiku|haiku-3[-.]5)(?=$|[-_.])/i, inputUsdPer1M: 0.8, outputUsdPer1M: 4 },

  // Google
  { pattern: /^gemini-2\.5-pro(?=$|[-_.])/i, inputUsdPer1M: 1.25, outputUsdPer1M: 10 },
  { pattern: /^gemini-2\.5-flash-lite(?=$|[-_.])/i, inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 },
  { pattern: /^gemini-2\.5-flash(?=$|[-_.])/i, inputUsdPer1M: 0.3, outputUsdPer1M: 2.5 },
  { pattern: /^gemini-2\.0-flash(?=$|[-_.])/i, inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 },
  { pattern: /^gemini-decision-1(?=$|[-_.])/i, inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 },

  // DeepSeek
  { pattern: /^deepseek-(?:reasoner|r1)(?=$|[-_.])/i, inputUsdPer1M: 0.55, outputUsdPer1M: 2.19 },
  { pattern: /^deepseek-(?:chat|v3)(?=$|[-_.])/i, inputUsdPer1M: 0.27, outputUsdPer1M: 1.1 },

  // DashScope / Qwen (check qwen-vl before qwen-max so qwen-vl-max matches VL pricing)
  { pattern: /^qwen-vl(?=$|[-_.])/i, inputUsdPer1M: 0.8, outputUsdPer1M: 2.4 },
  { pattern: /^qwen-max(?=$|[-_.])/i, inputUsdPer1M: 1.6, outputUsdPer1M: 6.4 },
  { pattern: /^qwen-(?:coder|plus)(?=$|[-_.])/i, inputUsdPer1M: 0.5, outputUsdPer1M: 1.5 },
  { pattern: /^qwen-(?:turbo|flash)(?=$|[-_.])/i, inputUsdPer1M: 0.05, outputUsdPer1M: 0.2 },
  { pattern: /^qwen3(?=$|[-_.])/i, inputUsdPer1M: 0.4, outputUsdPer1M: 1.2 },

  // Moonshot
  { pattern: /^kimi-k2(?=$|[-_.])/i, inputUsdPer1M: 1, outputUsdPer1M: 3 },
  { pattern: /^moonshot-v1-128k(?=$|[-_.])/i, inputUsdPer1M: 1, outputUsdPer1M: 3 },
  { pattern: /^moonshot-v1-32k(?=$|[-_.])/i, inputUsdPer1M: 0.2, outputUsdPer1M: 0.6 },
  { pattern: /^moonshot-v1-8k(?=$|[-_.])/i, inputUsdPer1M: 0.15, outputUsdPer1M: 0.5 },

  // Zhipu
  { pattern: /^glm-4-flash(?=$|[-_.])/i, inputUsdPer1M: 0, outputUsdPer1M: 0, free: true },
  { pattern: /^glm-4\.5-air(?=$|[-_.])/i, inputUsdPer1M: 0.2, outputUsdPer1M: 1.1 },
  { pattern: /^glm-(?:4\.5|4v?|4)(?=$|[-_.])/i, inputUsdPer1M: 0.8, outputUsdPer1M: 2 },

  // xAI
  { pattern: /^grok-4(?=$|[-_.])/i, inputUsdPer1M: 3, outputUsdPer1M: 15 },
  { pattern: /^grok-3-mini(?=$|[-_.])/i, inputUsdPer1M: 0.3, outputUsdPer1M: 0.5 },
  { pattern: /^grok-3(?=$|[-_.])/i, inputUsdPer1M: 3, outputUsdPer1M: 15 },
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

function sanitizeTokenInt(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? Math.round(num) : 0;
}

export function roundUsd(amount: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Number(amount.toFixed(10));
}

/** Strips `@thinkingLevel` and any `provider/` prefix, returning a lowercase bare model ID. */
export function normalizeModelIdForPricing(model: string): string {
  const withoutLevel = splitModelAndLevel(model.trim()).model;
  const slashIdx = withoutLevel.lastIndexOf('/');
  const bare = slashIdx >= 0 ? withoutLevel.slice(slashIdx + 1) : withoutLevel;
  return bare.trim().toLowerCase();
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

  const catalogInput = sanitizeNonNeg(catalogRate?.costInput);
  const catalogOutput = sanitizeNonNeg(catalogRate?.costOutput);
  if (catalogInput > 0 || catalogOutput > 0) {
    const cacheRead = catalogRate?.costCacheRead !== undefined
      && Number.isFinite(catalogRate.costCacheRead)
      && catalogRate.costCacheRead >= 0
      ? catalogRate.costCacheRead
      : Number((catalogInput * 0.25).toFixed(6));
    const cacheWrite = catalogRate?.costCacheWrite !== undefined
      && Number.isFinite(catalogRate.costCacheWrite)
      && catalogRate.costCacheWrite >= 0
      ? catalogRate.costCacheWrite
      : catalogInput;
    return {
      inputUsdPer1M: catalogInput,
      outputUsdPer1M: catalogOutput,
      cacheReadUsdPer1M: cacheRead,
      cacheWriteUsdPer1M: cacheWrite,
      source: 'catalog',
    };
  }

  const normalizedModel = normalizeModelIdForPricing(model);
  if (normalizedModel) {
    for (const rule of FALLBACK_UNIT_PRICES) {
      if (rule.pattern.test(normalizedModel)) {
        if (rule.free) {
          return { ...ZERO_FREE_PRICE };
        }
        return {
          inputUsdPer1M: rule.inputUsdPer1M,
          outputUsdPer1M: rule.outputUsdPer1M,
          cacheReadUsdPer1M: Number((rule.inputUsdPer1M * 0.25).toFixed(6)),
          cacheWriteUsdPer1M: rule.inputUsdPer1M,
          source: 'estimated',
        };
      }
    }
  }

  return { ...ZERO_UNKNOWN_PRICE };
}

/**
 * Calculates single-call USD cost.
 * Note: `@earendil-works/pi-ai` `usage.output` ALREADY includes `usage.reasoning`,
 * and `totalTokens = input + output + cacheRead + cacheWrite`, so `reasoningTokens`
 * is never added on top of `outputTokens`.
 */
export function calculateModelCallCost(input: UsageCostCalculationInput): UsageCostCalculationResult {
  const unitPrice = resolveModelUnitPrice(input.provider, input.model, input.catalogRate);
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
      costSource: 'provider',
    };
  }

  const inputTokens = sanitizeTokenInt(input.inputTokens);
  const outputTokens = sanitizeTokenInt(input.outputTokens);
  const cacheReadTokens = sanitizeTokenInt(input.cacheReadTokens);
  const cacheWriteTokens = sanitizeTokenInt(input.cacheWriteTokens);

  const rawUsd = (
    inputTokens * unitPrice.inputUsdPer1M
    + outputTokens * unitPrice.outputUsdPer1M
    + cacheReadTokens * unitPrice.cacheReadUsdPer1M
    + cacheWriteTokens * unitPrice.cacheWriteUsdPer1M
  ) / 1_000_000;

  return {
    costUsd: roundUsd(rawUsd),
    unitInputUsdPer1M: unitPrice.inputUsdPer1M,
    unitOutputUsdPer1M: unitPrice.outputUsdPer1M,
    costSource: unitPrice.source,
  };
}

/**
 * Normalizes SDK `AssistantMessage.usage`, `CompactionResult.usage`, or Decision API usage payloads
 * into canonical token counts without double-counting `reasoning` tokens.
 */
export function normalizeSdkUsage(rawUsage: unknown): NormalizedSdkUsage | undefined {
  if (!rawUsage || typeof rawUsage !== 'object' || Array.isArray(rawUsage)) {
    return undefined;
  }
  const u = rawUsage as Record<string, unknown>;
  const hasAnyTokenField = [
    'input',
    'output',
    'cacheRead',
    'cacheWrite',
    'reasoning',
    'totalTokens',
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens',
    'total_input_tokens',
    'total_output_tokens',
    'total_tokens',
  ].some(key => u[key] !== undefined && u[key] !== null);
  if (!hasAnyTokenField) return undefined;

  const inputTokens = sanitizeTokenInt(u.input ?? u.inputTokens ?? u.total_input_tokens);
  const cacheReadTokens = sanitizeTokenInt(u.cacheRead ?? u.cacheReadTokens);
  const cacheWriteTokens = sanitizeTokenInt(u.cacheWrite ?? u.cacheWriteTokens);
  const reasoningTokens = sanitizeTokenInt(u.reasoning ?? u.reasoningTokens);
  const rawTotal = sanitizeTokenInt(u.totalTokens ?? u.total_tokens);

  const hasExplicitOutput = (u.output !== undefined && u.output !== null)
    || (u.outputTokens !== undefined && u.outputTokens !== null)
    || (u.total_output_tokens !== undefined && u.total_output_tokens !== null);
  const outputTokens = hasExplicitOutput
    ? sanitizeTokenInt(u.output ?? u.outputTokens ?? u.total_output_tokens)
    : Math.max(0, rawTotal - inputTokens - cacheReadTokens - cacheWriteTokens);

  const componentSum = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const totalTokens = rawTotal > 0 ? Math.max(rawTotal, componentSum) : componentSum;

  const costObj = u.cost && typeof u.cost === 'object' && !Array.isArray(u.cost)
    ? (u.cost as Record<string, unknown>)
    : undefined;
  const totalFromProvider = costObj?.totalFromProvider === true;
  const rawProviderTotal = costObj?.total !== undefined ? Number(costObj.total) : undefined;
  const providerReportedTotalUsd = totalFromProvider
    && typeof rawProviderTotal === 'number'
    && Number.isFinite(rawProviderTotal)
    && rawProviderTotal > 0
    ? rawProviderTotal
    : undefined;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    ...(providerReportedTotalUsd !== undefined ? { providerReportedTotalUsd, totalFromProvider: true } : {}),
  };
}

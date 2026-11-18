#!/usr/bin/env node
/**
 * Syncs built-in fallback model pricing (USD per 1M tokens) into `src/models/fallback-prices.ts`
 * from `https://models.dev/api.json` and the bundled `@earendil-works/pi-coding-agent` SDK catalog,
 * preserving Friday's canonical baseline rates.
 */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const outPath = join(repoRoot, 'src/models/fallback-prices.ts');

/**
 * Canonical baseline tuples `[input, output, cacheRead, cacheWrite]` (-1 = derive default cache rate)
 * preserving Friday's authoritative baseline prices against third-party reseller overrides.
 */
const CANONICAL_BASE_PRICES = {
  // OpenAI baseline
  'gpt-5': [1.25, 10, 0.125, -1],
  'gpt-4.1-mini': [0.4, 1.6, 0.1, -1],
  'gpt-4.1-nano': [0.1, 0.4, 0.025, -1],
  'gpt-4.1': [2, 8, 0.5, -1],
  'gpt-4o-mini': [0.15, 0.6, 0.075, -1],
  'gpt-4o': [2.5, 10, 1.25, -1],
  'o4-mini': [1.1, 4.4, 0.275, -1],
  'o3-mini': [1.1, 4.4, 0.55, -1],
  'o3': [2, 8, 0.5, -1],
  'o1': [15, 60, 7.5, -1],

  // Anthropic baseline
  'claude-opus-4-20250514': [15, 75, 1.5, 18.75],
  'claude-sonnet-4-20250514': [3, 15, 0.3, 3.75],
  'claude-sonnet-4': [3, 15, 0.3, 3.75],
  'claude-3-7-sonnet-latest': [3, 15, 0.3, 3.75],
  'claude-haiku-4-5': [1, 5, 0.1, 1.25],
  'claude-3-5-haiku-latest': [0.8, 4, 0.08, 1],

  // Google baseline
  'gemini-2.5-pro': [1.25, 10, 0.125, 0],
  'gemini-2.5-flash-lite': [0.1, 0.4, 0.01, 0],
  'gemini-2.5-flash': [0.3, 2.5, 0.03, 0],
  'gemini-2.0-flash': [0.1, 0.4, 0.025, 0],
  'gemini-decision-1': [0.1, 0.4, 0.025, 0],
  'gemini-omni-1.2-flash': [1.5, 9, 0.15, 0],

  // DeepSeek official baseline
  'deepseek-reasoner': [0.55, 2.19, 0.14, 0],
  'deepseek-r1': [0.55, 2.19, 0.14, 0],
  'deepseek-chat': [0.27, 1.1, 0.07, 0],
  'deepseek-chat-v3-0324': [0.27, 1.1, 0.07, 0],
  'deepseek-v3': [0.2, 0.8, -1, -1],

  // DashScope / Qwen baseline
  'qwen-max-latest': [1.6, 6.4, -1, -1],
  'qwen-coder-plus-latest': [0.5, 1.5, -1, -1],
  'qwen-vl-max-latest': [0.8, 2.4, -1, -1],
  'qwen-turbo-latest': [0.05, 0.2, -1, -1],
  'qwen3-32b': [0.4, 1.2, -1, -1],

  // Moonshot baseline
  'kimi-k2-0711-preview': [1, 3, -1, -1],
  'moonshot-v1-128k-vision-preview': [1, 3, -1, -1],
  'moonshot-v1-32k': [0.2, 0.6, -1, -1],
  'moonshot-v1-8k': [0.15, 0.5, -1, -1],

  // Zhipu baseline
  'glm-4-flash': [0, 0, 0, 0],
  'glm-4.5-air': [0.2, 1.1, 0.05, -1],
  'glm-4.5': [0.8, 2, -1, -1],
  'glm-4v-plus': [0.8, 2, -1, -1],

  // xAI baseline
  'grok-4': [3, 15, -1, -1],
  'grok-3-mini': [0.3, 0.5, -1, -1],
  'grok-3': [3, 15, -1, -1],
};

const CANONICAL_PROVIDER_PRICES = {
  'zhipu/glm-4.5': [0.8, 2, -1, -1],
  'zhipu/glm-4.5-air': [0.2, 1.1, 0.05, -1],
  'zhipu/glm-4-flash': [0, 0, 0, 0],
  'openrouter/anthropic/claude-sonnet-4': [3, 15, 0.3, 3.75],
  'openrouter/deepseek/deepseek-chat-v3-0324': [0.27, 1.1, 0.07, 0],
};

const AUTHORITATIVE_PROVIDERS = [
  'openai',
  'openai-codex',
  'google',
  'google-vertex',
  'anthropic',
  'deepseek',
  'xai',
  'zai',
  'zhipu',
  'moonshotai',
  'moonshot',
  'alibaba',
  'dashscope',
  'opencode-go',
  'opencode',
  'minimax',
  'mistral',
  'groq',
];

const PROVIDER_ALIASES = {
  zai: ['zai', 'zhipu'],
  moonshotai: ['moonshotai', 'moonshot'],
  alibaba: ['alibaba', 'dashscope'],
  gemini: ['google'],
};

const FRIDAY_PROVIDER_SET = new Set([
  'openai',
  'openai-codex',
  'google',
  'google-vertex',
  'anthropic',
  'deepseek',
  'opencode-go',
  'opencode',
  'openrouter',
  'dashscope',
  'alibaba',
  'moonshot',
  'moonshotai',
  'zhipu',
  'zai',
  'siliconflow',
  'xai',
  'minimax',
  'mistral',
  'groq',
]);

function roundRate(v) {
  return Number(Number(v).toFixed(6));
}

function toTuple(cost, modelId) {
  if (!cost || typeof cost !== 'object') return undefined;
  const inp = Number(cost.input ?? 0);
  const out = Number(cost.output ?? 0);
  const crRaw = cost.cache_read ?? cost.cacheRead;
  const cwRaw = cost.cache_write ?? cost.cacheWrite;
  const cr = crRaw !== undefined && Number.isFinite(Number(crRaw)) && Number(crRaw) >= 0 ? roundRate(crRaw) : -1;
  const cw = cwRaw !== undefined && Number.isFinite(Number(cwRaw)) && Number(cwRaw) >= 0 ? roundRate(cwRaw) : -1;

  if (!Number.isFinite(inp) || !Number.isFinite(out) || inp < 0 || out < 0) return undefined;
  if (inp === 0 && out === 0) {
    if (/(?:^|[-_/:])free(?:$|[-_:])/i.test(modelId)) {
      return [0, 0, 0, 0];
    }
    return undefined;
  }
  return [roundRate(inp), roundRate(out), cr, cw];
}

function bareModelKey(modelId) {
  const lower = String(modelId).trim().toLowerCase();
  const slash = lower.lastIndexOf('/');
  return slash >= 0 ? lower.slice(slash + 1) : lower;
}

async function fetchModelsDevCatalog() {
  try {
    const res = await fetch('https://models.dev/api.json', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.warn(`[sync-model-prices] models.dev HTTP ${res.status}; falling back to SDK catalog only`);
      return {};
    }
    return await res.json();
  } catch (err) {
    console.warn(`[sync-model-prices] Failed to fetch models.dev (${err instanceof Error ? err.message : String(err)}); falling back to SDK catalog only`);
    return {};
  }
}

async function main() {
  const modelsDev = await fetchModelsDevCatalog();
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });

  const barePrices = new Map();
  const providerModelPrices = new Map();

  const recordBare = (rawId, tuple) => {
    const bare = bareModelKey(rawId);
    if (!bare || barePrices.has(bare)) return;
    barePrices.set(bare, tuple);
  };

  const recordProvider = (providerId, rawId, tuple) => {
    const normProv = String(providerId).trim().toLowerCase();
    const normModel = String(rawId).trim().toLowerCase();
    if (!normProv || !normModel) return;
    const targets = PROVIDER_ALIASES[normProv] ?? [normProv];
    for (const p of targets) {
      if (!FRIDAY_PROVIDER_SET.has(p)) continue;
      const fullKey = `${p}/${normModel}`;
      if (!providerModelPrices.has(fullKey)) {
        providerModelPrices.set(fullKey, tuple);
      }
      const bare = bareModelKey(normModel);
      if (bare && bare !== normModel) {
        const bareKey = `${p}/${bare}`;
        if (!providerModelPrices.has(bareKey)) {
          providerModelPrices.set(bareKey, tuple);
        }
      }
    }
  };

  // 1) Seed canonical baseline prices first
  for (const [id, tuple] of Object.entries(CANONICAL_BASE_PRICES)) {
    recordBare(id, tuple);
  }
  for (const [key, tuple] of Object.entries(CANONICAL_PROVIDER_PRICES)) {
    const slash = key.indexOf('/');
    if (slash > 0) recordProvider(key.slice(0, slash), key.slice(slash + 1), tuple);
  }

  // 2) Authoritative providers from models.dev (both provider-qualified and bare fallback)
  for (const pid of AUTHORITATIVE_PROVIDERS) {
    const prov = modelsDev[pid];
    if (!prov?.models) continue;
    for (const [mid, model] of Object.entries(prov.models)) {
      const tuple = toTuple(model?.cost, mid);
      if (!tuple) continue;
      recordProvider(pid, mid, tuple);
      recordBare(mid, tuple);
    }
  }

  // 3) Bundled @earendil-works/pi-coding-agent SDK catalog (authoritative providers first, then rest)
  const sdkProviderIds = runtime.getProviders().map(p => p.id);
  const orderedSdkProviders = [
    ...AUTHORITATIVE_PROVIDERS.filter(p => sdkProviderIds.includes(p)),
    ...sdkProviderIds.filter(p => !AUTHORITATIVE_PROVIDERS.includes(p)),
  ];
  for (const pid of orderedSdkProviders) {
    for (const model of runtime.getModels(pid)) {
      const tuple = toTuple(model.cost, model.id);
      if (!tuple) continue;
      recordProvider(pid, model.id, tuple);
      recordBare(model.id, tuple);
    }
  }

  // 4) Remaining providers from models.dev (e.g. openrouter, together, etc.)
  for (const [pid, prov] of Object.entries(modelsDev)) {
    if (AUTHORITATIVE_PROVIDERS.includes(pid) || !prov?.models) continue;
    for (const [mid, model] of Object.entries(prov.models)) {
      const tuple = toTuple(model?.cost, mid);
      if (!tuple) continue;
      if (FRIDAY_PROVIDER_SET.has(pid.toLowerCase())) {
        recordProvider(pid, mid, tuple);
      }
      recordBare(mid, tuple);
    }
  }

  const sortedProviders = Object.fromEntries(
    [...providerModelPrices.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  );
  const sortedBare = Object.fromEntries(
    [...barePrices.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  );

  const digest = createHash('sha256')
    .update(JSON.stringify({ sortedProviders, sortedBare }))
    .digest('hex')
    .slice(0, 12);
  const version = `prices-v2-${digest}`;

  const formatRecord = (entries) => Object.entries(entries)
    .map(([k, v]) => `  ${JSON.stringify(k)}: [${v.join(', ')}],`)
    .join('\n');

  const content = `// Auto-generated by scripts/sync-model-prices.mjs — do not edit manually.
// Refresh via: npm run sync:prices

export type CompactPriceTuple = readonly [input: number, output: number, cacheRead: number, cacheWrite: number];

export const FALLBACK_PRICES_VERSION = ${JSON.stringify(version)};

/** Provider-scoped fallback prices (USD per 1M tokens; -1 = derive default cache rate). */
export const FALLBACK_PROVIDER_MODEL_PRICES: Readonly<Record<string, CompactPriceTuple>> = {
${formatRecord(sortedProviders)}
};

/** Bare model ID fallback prices (USD per 1M tokens; -1 = derive default cache rate). */
export const FALLBACK_BARE_MODEL_PRICES: Readonly<Record<string, CompactPriceTuple>> = {
${formatRecord(sortedBare)}
};
`;

  await writeFile(outPath, content, 'utf8');
  console.log(`Synced fallback prices (${version}): ${Object.keys(sortedProviders).length} provider/model entries, ${Object.keys(sortedBare).length} bare model entries -> ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

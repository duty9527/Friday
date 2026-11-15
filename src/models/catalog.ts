import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  classifyModelSpecialties,
  inferTaskComplexityTier,
  isThinkingLevel,
  type ThinkingLevel,
} from '../decision.js';
import type { ModelCatalogEntry, ModelTier, ModelTierConfig, WorkerProfile } from '../view.js';

export interface WorkerModelResolutionInput {
  model?: string;
  tier?: ModelTier;
  thinkingLevel?: ThinkingLevel;
  instruction?: string;
  contextBrief?: string;
  profile?: WorkerProfile;
  fileCount?: number;
  hasImages?: boolean;
  isTimer?: boolean;
  excludedSpecs?: string[];
  excludedProviders?: string[];
}

export interface PersistedProviderConfig {
  name?: string;
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  customModels?: string[];
  /** 用户显式勾选进入 Worker 模型池的模型（保留各自原生思考等级） */
  selectedModels?: SelectedModelConfig[];
  fetchedModels?: ModelCatalogEntry[];
  modelsFetchedAt?: number;
  fetchError?: string;
}

export interface SelectedModelConfig {
  id: string;
  thinkingLevels?: ThinkingLevel[];
}

export type SelectedModelInput = string | (SelectedModelConfig & { tier?: unknown });

export interface ModelEffectStats {
  successCount: number;
  failCount: number;
  lastLatencyMs?: number;
  lastProbeOk?: boolean;
  qualityScoreSum?: number;
  qualityCount?: number;
  avgQualityScore?: number;
  updatedAt: number;
}

export interface PersistedDecisionConfig {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
}

export interface PersistedModelHubState {
  routerProvider?: string;
  routerModel?: string;
  workerProvider?: string;
  fastModel?: string;
  balancedModel?: string;
  strongModel?: string;
  decision?: PersistedDecisionConfig;
  providers: Record<string, PersistedProviderConfig>;
  modelStats?: Record<string, ModelEffectStats>;
  statsEpoch?: string;
  lastProbe?: import('../view.js').ModelProbeResult;
}

export interface ModelHubConfigureInput {
  providerId?: string;
  providerName?: string;
  enabled?: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
  baseUrl?: string;
  customModels?: string[];
  selectedModels?: SelectedModelInput[];
  routerProvider?: string;
  routerModel?: string;
  workerProvider?: string;
  fastModel?: string;
  balancedModel?: string;
  strongModel?: string;
  decisionEnabled?: boolean;
  decisionApiKey?: string;
  clearDecisionApiKey?: boolean;
  decisionBaseUrl?: string;
}

export interface ModelHubFetchInput {
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface ModelHubProbeInput {
  provider?: string;
  model: string;
  prompt?: string;
  apiKey?: string;
  baseUrl?: string;
}

export const MODEL_TIER_VALUES: readonly ModelTier[] = ['fast', 'balanced', 'strong'];
export const MAX_SELECTED_MODELS = 64;
export const DECISION_STATS_EPOCH = 'jev-era-v1';

export const FEATURED_PROVIDERS: Array<{ id: string; name: string }> = [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'openai-codex', name: 'OpenAI Codex' },
  { id: 'anthropic', name: 'Anthropic Claude' },
  { id: 'google', name: 'Google Gemini' },
  { id: 'opencode-go', name: 'OpenCode Go' },
  { id: 'opencode', name: 'OpenCode Zen' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'dashscope', name: '阿里云百炼 (Qwen)' },
  { id: 'moonshot', name: 'Moonshot (Kimi)' },
  { id: 'zhipu', name: '智谱 (GLM)' },
  { id: 'siliconflow', name: 'SiliconFlow (硅基流动)' },
  { id: 'xai', name: 'xAI (Grok)' },
  { id: 'ollama', name: 'Ollama (本地)' },
];

export const DEFAULT_PROVIDER_ENDPOINTS: Record<string, string> = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  'openai-codex': 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  anthropic: 'https://api.anthropic.com',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
  opencode: 'https://opencode.ai/zen/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  siliconflow: 'https://api.siliconflow.cn/v1',
  xai: 'https://api.x.ai/v1',
  ollama: 'http://127.0.0.1:11434/v1',
};

const FICTIONAL_SDK_MODEL_IDS = new Set([
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-6-astra',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-daybreak-blue-latest',
  'gpt-daybreak-red-latest',
  'deepseek-flash',
  'deepseek-v4-pro',
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-haiku-5-5',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-opus-5',
  'claude-opus-5-5',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-4-argon',
]);

export const REAL_PROVIDER_DEFAULTS: Record<string, { fast: string[]; balanced: string[]; strong: string[] }> = {
  openai: {
    fast: ['gpt-4.1-mini', 'gpt-4o-mini'],
    balanced: ['gpt-4.1', 'gpt-4o'],
    strong: ['o4-mini', 'o3', 'gpt-4.1'],
  },
  'openai-codex': {
    fast: ['gpt-4.1-mini'],
    balanced: ['gpt-4.1'],
    strong: ['o4-mini', 'gpt-4.1'],
  },
  deepseek: {
    fast: ['deepseek-chat'],
    balanced: ['deepseek-chat'],
    strong: ['deepseek-reasoner', 'deepseek-chat'],
  },
  anthropic: {
    fast: ['claude-haiku-4-5'],
    balanced: ['claude-sonnet-4-20250514', 'claude-sonnet-4-5', 'claude-sonnet-4-6'],
    strong: ['claude-opus-4-20250514', 'claude-opus-4-5', 'claude-opus-4-6'],
  },
  google: {
    fast: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    balanced: ['gemini-2.5-flash'],
    strong: ['gemini-2.5-pro'],
  },
  'google-vertex': {
    fast: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    balanced: ['gemini-2.5-flash'],
    strong: ['gemini-2.5-pro'],
  },
  gemini: {
    fast: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    balanced: ['gemini-2.5-flash'],
    strong: ['gemini-2.5-pro'],
  },
};

export const FALLBACK_PROVIDER_MODELS: Record<string, ModelCatalogEntry[]> = {
  deepseek: [
    {
      id: 'deepseek-chat',
      name: 'DeepSeek Chat',
      supportsImages: false,
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 8_192,
      costInput: 0.27,
      costOutput: 1.1,
      thinkingLevels: ['off'],
    },
    {
      id: 'deepseek-reasoner',
      name: 'DeepSeek Reasoner',
      supportsImages: false,
      reasoning: true,
      contextWindow: 128_000,
      maxTokens: 64_000,
      costInput: 0.55,
      costOutput: 2.19,
      thinkingLevels: ['off', 'low', 'high', 'max'],
    },
  ],
  anthropic: [
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', supportsImages: true, reasoning: true, contextWindow: 200_000, maxTokens: 64_000, costInput: 1, costOutput: 5 },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', supportsImages: true, reasoning: true, contextWindow: 200_000, maxTokens: 64_000, costInput: 3, costOutput: 15 },
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', supportsImages: true, reasoning: true, contextWindow: 200_000, maxTokens: 32_000, costInput: 15, costOutput: 75 },
  ],
  openai: [
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', supportsImages: true, reasoning: false, contextWindow: 1_047_576, maxTokens: 32_768, costInput: 0.4, costOutput: 1.6 },
    { id: 'gpt-4.1', name: 'GPT-4.1', supportsImages: true, reasoning: false, contextWindow: 1_047_576, maxTokens: 32_768, costInput: 2, costOutput: 8 },
    { id: 'o4-mini', name: 'o4-mini', supportsImages: true, reasoning: true, contextWindow: 200_000, maxTokens: 100_000, costInput: 1.1, costOutput: 4.4 },
  ],
  'openai-codex': [
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini (Codex)', supportsImages: true, reasoning: false, contextWindow: 1_047_576, maxTokens: 32_768, costInput: 0.4, costOutput: 1.6 },
    { id: 'gpt-4.1', name: 'GPT-4.1 (Codex)', supportsImages: true, reasoning: false, contextWindow: 1_047_576, maxTokens: 32_768, costInput: 2, costOutput: 8 },
    { id: 'o4-mini', name: 'o4-mini (Codex)', supportsImages: true, reasoning: true, contextWindow: 200_000, maxTokens: 100_000, costInput: 1.1, costOutput: 4.4 },
  ],
  google: [
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', supportsImages: true, reasoning: true, contextWindow: 1_048_576, maxTokens: 65_536, costInput: 0.3, costOutput: 2.5 },
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', supportsImages: true, reasoning: true, contextWindow: 1_048_576, maxTokens: 65_536, costInput: 1.25, costOutput: 10 },
  ],
  openrouter: [
    { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4 (OR)', supportsImages: true, reasoning: true, contextWindow: 200_000, costInput: 3, costOutput: 15 },
    { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro (OR)', supportsImages: true, reasoning: true, contextWindow: 1_048_576, costInput: 1.25, costOutput: 10 },
    { id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek V3 (OR)', supportsImages: false, reasoning: false, contextWindow: 128_000, costInput: 0.2, costOutput: 0.8 },
  ],
  dashscope: [
    { id: 'qwen-max-latest', name: 'Qwen Max', supportsImages: false, reasoning: true, contextWindow: 131_072, costInput: 1.6, costOutput: 6.4 },
    { id: 'qwen-coder-plus-latest', name: 'Qwen Coder Plus', supportsImages: false, reasoning: false, contextWindow: 131_072, costInput: 0.5, costOutput: 1.5 },
    { id: 'qwen-vl-max-latest', name: 'Qwen VL Max', supportsImages: true, reasoning: false, contextWindow: 131_072, costInput: 0.8, costOutput: 2.4 },
    { id: 'qwen-turbo-latest', name: 'Qwen Turbo', supportsImages: false, reasoning: false, contextWindow: 1_000_000, costInput: 0.05, costOutput: 0.2 },
  ],
  moonshot: [
    { id: 'kimi-k2-0711-preview', name: 'Kimi K2', supportsImages: false, reasoning: true, contextWindow: 131_072, costInput: 1, costOutput: 3 },
    { id: 'moonshot-v1-128k-vision-preview', name: 'Moonshot 128K Vision', supportsImages: true, reasoning: false, contextWindow: 128_000, costInput: 1, costOutput: 3 },
    { id: 'moonshot-v1-32k', name: 'Moonshot 32K', supportsImages: false, reasoning: false, contextWindow: 32_768, costInput: 0.2, costOutput: 0.6 },
  ],
  zhipu: [
    { id: 'glm-4.5', name: 'GLM-4.5', supportsImages: false, reasoning: true, contextWindow: 128_000, costInput: 0.8, costOutput: 2 },
    { id: 'glm-4v-plus', name: 'GLM-4V Plus', supportsImages: true, reasoning: false, contextWindow: 128_000, costInput: 0.8, costOutput: 2 },
    { id: 'glm-4-flash', name: 'GLM-4 Flash', supportsImages: false, reasoning: false, contextWindow: 128_000, costInput: 0, costOutput: 0 },
  ],
  siliconflow: [
    { id: 'deepseek-ai/DeepSeek-R1', name: 'DeepSeek R1 (SF)', supportsImages: false, reasoning: true, contextWindow: 128_000, costInput: 0.5, costOutput: 2 },
    { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3 (SF)', supportsImages: false, reasoning: false, contextWindow: 128_000, costInput: 0.2, costOutput: 0.8 },
    { id: 'Qwen/Qwen2.5-Coder-32B-Instruct', name: 'Qwen2.5 Coder 32B', supportsImages: false, reasoning: false, contextWindow: 128_000, costInput: 0.15, costOutput: 0.15 },
  ],
  xai: [
    { id: 'grok-4', name: 'Grok 4', supportsImages: true, reasoning: true, contextWindow: 256_000, costInput: 3, costOutput: 15 },
    { id: 'grok-3-mini', name: 'Grok 3 Mini', supportsImages: false, reasoning: true, contextWindow: 131_072, costInput: 0.3, costOutput: 0.5 },
  ],
  ollama: [
    { id: 'qwen2.5-coder:latest', name: 'Qwen2.5 Coder (Local)', supportsImages: false, reasoning: false, contextWindow: 128_000, costInput: 0, costOutput: 0 },
    { id: 'deepseek-r1:latest', name: 'DeepSeek R1 (Local)', supportsImages: false, reasoning: true, contextWindow: 128_000, costInput: 0, costOutput: 0 },
  ],
};

type RuntimeModelList = ReturnType<ModelRuntime['getModels']>;
type RuntimeModelItem = RuntimeModelList[number];

const PROVIDERS_TO_NORMALIZE = ['deepseek', 'anthropic', 'openai', 'openai-codex', 'google'] as const;

/** Augments the SDK runtime catalog with real upstream model IDs and prunes fictional codenames. */
export function ensureRealProviderCatalog(runtime: ModelRuntime, targetProviderId?: string): void {
  if (typeof runtime.getModels !== 'function' || typeof runtime.registerProvider !== 'function') return;
  const normalizedTarget = normalizeProviderId(targetProviderId);
  const targets = normalizedTarget ? [normalizedTarget] : [...PROVIDERS_TO_NORMALIZE];
  for (const providerId of targets) {
    if (!PROVIDERS_TO_NORMALIZE.includes(providerId as typeof PROVIDERS_TO_NORMALIZE[number])) continue;
    const existing = runtime.getModels(providerId);
    const template = existing[0];
    if (!template) continue;
    const defaults = FALLBACK_PROVIDER_MODELS[providerId] ?? [];
    const existingById = new Map(existing.map(m => [m.id, m]));
    const filtered = existing.filter(m => !FICTIONAL_SDK_MODEL_IDS.has(m.id));
    const filteredSet = new Set(filtered.map(m => m.id));
    let changed = filtered.length !== existing.length;

    const merged: RuntimeModelItem[] = [...filtered];
    for (const def of defaults) {
      if (filteredSet.has(def.id)) continue;
      changed = true;
      const base = (existingById.get(def.id) ?? template) as RuntimeModelItem & {
        thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
      };
      const entry = {
        ...base,
        id: def.id,
        name: def.name,
        api: template.api,
        baseUrl: template.baseUrl,
        provider: providerId,
        reasoning: def.reasoning,
        input: def.supportsImages ? (['text', 'image'] as Array<'text' | 'image'>) : (['text'] as Array<'text' | 'image'>),
        cost: {
          input: def.costInput,
          output: def.costOutput,
          cacheRead: base.cost?.cacheRead ?? 0,
          cacheWrite: base.cost?.cacheWrite ?? 0,
        },
        contextWindow: def.contextWindow,
        maxTokens: def.maxTokens ?? base.maxTokens ?? 16_384,
      };
      if (providerId === 'deepseek') {
        if (def.id === 'deepseek-reasoner') {
          entry.thinkingLevelMap = { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' };
        } else {
          delete entry.thinkingLevelMap;
        }
      }
      merged.push(entry as RuntimeModelItem);
    }

    if (changed && merged.length > 0) {
      runtime.registerProvider(providerId, {
        baseUrl: template.baseUrl,
        api: template.api,
        models: merged,
      });
    }
  }
}

export function inferModelTier(input: WorkerModelResolutionInput): ModelTier {
  return inferTaskComplexityTier({
    model: input.model,
    tier: input.tier,
    instruction: input.instruction,
    profile: input.profile,
    fileCount: input.fileCount,
    isTimer: input.isTimer,
  });
}

export function resolveWorkerModelFromTiers(
  tiers: ModelTierConfig,
  input: WorkerModelResolutionInput,
): { model: string; tier: ModelTier } {
  const rawModel = input.model?.trim();
  if (rawModel && MODEL_TIER_VALUES.includes(rawModel as ModelTier)) {
    const tier = rawModel as ModelTier;
    return { model: tiers[tier], tier };
  }
  if (rawModel) {
    const tier: ModelTier = rawModel === tiers.fast && tiers.fast !== tiers.balanced ? 'fast'
      : rawModel === tiers.strong && tiers.strong !== tiers.balanced ? 'strong'
      : rawModel === tiers.balanced ? 'balanced'
      : inferModelTier(input);
    return { model: rawModel, tier };
  }
  const tier = inferModelTier(input);
  return { model: tiers[tier], tier };
}

export function buildModelTiers(
  runtime: ModelRuntime,
  provider: string,
  routerModelId: string,
  defaultWorkerModelId: string,
  overrides?: { fastModel?: string; balancedModel?: string; strongModel?: string; explicitWorkerModel?: boolean; hasCustomBaseUrl?: boolean },
): ModelTierConfig {
  const catalog = runtime.getModels(provider);
  const available = catalog.map(m => m.id);
  const availableSet = new Set(available);
  const pick = (candidates: Array<string | undefined>, fallback: string): string => {
    for (const c of candidates) {
      if (c && availableSet.has(c)) return c;
    }
    return fallback;
  };
  const preset = overrides?.hasCustomBaseUrl ? undefined : REAL_PROVIDER_DEFAULTS[provider];
  let costFast: string | undefined;
  let costBalanced: string | undefined;
  let costStrong: string | undefined;
  if (!preset && !overrides?.hasCustomBaseUrl && catalog.length >= 2) {
    const priced = [...catalog].filter(m => (m.cost?.input ?? 0) > 0).sort((a, b) => (a.cost?.input ?? 0) - (b.cost?.input ?? 0));
    if (priced.length >= 2) {
      costFast = priced[0]?.id;
      costBalanced = priced[Math.floor(priced.length / 2)]?.id;
      costStrong = priced.at(-1)?.id;
    }
  }
  const fast = overrides?.fastModel
    ?? pick([...(preset?.fast ?? []), costFast], defaultWorkerModelId);
  const balanced = overrides?.balancedModel
    ?? pick([...(preset?.balanced ?? []), costBalanced], defaultWorkerModelId);
  const strong = overrides?.strongModel
    ?? (overrides?.explicitWorkerModel ? defaultWorkerModelId : pick([...(preset?.strong ?? []), costStrong, defaultWorkerModelId], defaultWorkerModelId));
  return {
    provider,
    router: routerModelId,
    fast,
    balanced,
    strong,
    available: available.slice(0, 32),
  };
}

export function classifyModelEntry(
  providerId: string,
  model: ModelCatalogEntry,
  sampleTiers?: { fast?: string; balanced?: string; strong?: string },
): { tier: ModelTier; specialties: string[] } {
  return classifyModelSpecialties(providerId, model.id, {
    reasoning: model.reasoning,
    supportsImages: model.supportsImages,
    contextWindow: model.contextWindow,
    sampleTiers,
  });
}

export function normalizeSelectedModels(input: unknown): SelectedModelConfig[] {
  if (!Array.isArray(input)) throw new Error('selectedModels 必须是数组');
  const result: SelectedModelConfig[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const item = typeof raw === 'string'
      ? { id: raw }
      : (raw ?? {}) as { id?: unknown; thinkingLevels?: unknown };
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) throw new Error('selectedModels 中的模型 ID 不能为空');
    if (id.length > 128) throw new Error(`模型 ID 过长: ${id.slice(0, 32)}…`);
    let thinkingLevels: ThinkingLevel[] | undefined;
    if (item.thinkingLevels !== undefined) {
      if (!Array.isArray(item.thinkingLevels) || !item.thinkingLevels.every(isThinkingLevel)) {
        throw new Error(`模型 "${id}" 的原生思考等级无效`);
      }
      const dedup = [...new Set(item.thinkingLevels)];
      if (dedup.length) thinkingLevels = dedup;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      ...(thinkingLevels ? { thinkingLevels } : {}),
    });
  }
  if (result.length > MAX_SELECTED_MODELS) {
    throw new Error(`每个提供方最多勾选 ${MAX_SELECTED_MODELS} 个模型，当前 ${result.length} 个`);
  }
  return result;
}

export function tierToPreferredThinkingLevel(tier: ModelTier | undefined): ThinkingLevel | undefined {
  if (tier === 'fast') return 'low';
  if (tier === 'balanced') return 'medium';
  if (tier === 'strong') return 'high';
  return undefined;
}

export function thinkingLevelToTier(level: ThinkingLevel): ModelTier {
  if (level === 'off' || level === 'minimal' || level === 'low') return 'fast';
  if (level === 'high' || level === 'xhigh' || level === 'max') return 'strong';
  return 'balanced';
}

export function splitModelAndLevel(raw: string): { model: string; explicitLevel?: ThinkingLevel } {
  const at = raw.lastIndexOf('@');
  if (at > 0) {
    const suffix = raw.slice(at + 1).trim();
    if (isThinkingLevel(suffix)) {
      return { model: raw.slice(0, at).trim(), explicitLevel: suffix };
    }
  }
  return { model: raw.trim() };
}

export function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const trimmed = key.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

export function normalizeProviderId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const trimmed = id.trim();
  if (!trimmed) return undefined;
  return trimmed === 'gemini' ? 'google' : trimmed;
}

export function isOpenCodeProvider(providerId: string, baseUrl?: string): boolean {
  if (providerId === 'opencode' || providerId === 'opencode-go') return true;
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === 'opencode.ai';
  } catch {
    return /opencode\.ai/i.test(baseUrl);
  }
}

export function isOfficialOpenCodeUrl(providerId: string, baseUrl?: string): boolean {
  if (providerId !== 'opencode' && providerId !== 'opencode-go') return false;
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).hostname === 'opencode.ai';
  } catch {
    return false;
  }
}

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { buildModelTiers, inferModelTier, resolveWorkerModelFromTiers, type WorkerModelResolutionInput } from './agent.js';
import type { ModelCatalogEntry, ModelHubView, ModelProbeResult, ModelProviderView, ModelTier, ModelTierConfig, PooledModelEntry } from './view.js';

export interface PersistedProviderConfig {
  name?: string;
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  customModels?: string[];
  /** 用户显式勾选进入 Worker 模型池的模型及其等级 */
  selectedModels?: SelectedModelConfig[];
  fetchedModels?: ModelCatalogEntry[];
  modelsFetchedAt?: number;
  fetchError?: string;
}

export interface SelectedModelConfig {
  id: string;
  tier: ModelTier;
}

const MODEL_TIER_VALUES: readonly ModelTier[] = ['fast', 'balanced', 'strong'];
const MAX_SELECTED_MODELS = 64;

export interface ModelEffectStats {
  successCount: number;
  failCount: number;
  lastLatencyMs?: number;
  lastProbeOk?: boolean;
  updatedAt: number;
}

export interface PersistedModelHubState {
  routerProvider?: string;
  routerModel?: string;
  workerProvider?: string;
  fastModel?: string;
  balancedModel?: string;
  strongModel?: string;
  providers: Record<string, PersistedProviderConfig>;
  modelStats?: Record<string, ModelEffectStats>;
  lastProbe?: ModelProbeResult;
}

export interface ModelHubConfigureInput {
  providerId?: string;
  providerName?: string;
  enabled?: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
  baseUrl?: string;
  customModels?: string[];
  selectedModels?: SelectedModelConfig[];
  routerProvider?: string;
  routerModel?: string;
  workerProvider?: string;
  fastModel?: string;
  balancedModel?: string;
  strongModel?: string;
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

const FEATURED_PROVIDERS: Array<{ id: string; name: string }> = [
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

const DEFAULT_PROVIDER_ENDPOINTS: Record<string, string> = {
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

const FALLBACK_PROVIDER_MODELS: Record<string, ModelCatalogEntry[]> = {
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

function classifyModelEntry(
  providerId: string,
  model: ModelCatalogEntry,
  sampleTiers?: { fast?: string; balanced?: string; strong?: string },
): { tier: ModelTier; specialties: string[] } {
  const id = model.id.toLowerCase();
  let tier: ModelTier = 'balanced';
  if (sampleTiers?.strong === model.id && sampleTiers?.strong !== sampleTiers?.fast) {
    tier = 'strong';
  } else if (sampleTiers?.fast === model.id && sampleTiers?.fast !== sampleTiers?.balanced) {
    tier = 'fast';
  } else if (/(?:opus|sol|astra|argon|o1|o3|reasoner|deepseek-r1|grok-4|qwen-max|glm-4\.5|pro)/i.test(id)) {
    tier = 'strong';
  } else if (/(?:flash|mini|luna|haiku|turbo|nano|lite)/i.test(id)) {
    tier = 'fast';
  }

  const specialties: string[] = [];
  if (/(?:claude|codex|gpt-6|gpt-5|gpt-4\.1|o3|coder|deepseek|glm-4\.5|kimi-k2)/i.test(id) || providerId === 'anthropic' || providerId === 'openai-codex') {
    specialties.push('代码工程');
  }
  if (model.reasoning || /(?:opus|sol|argon|o1|o3|reasoner|r1|thinking|grok-4|qwen-max)/i.test(id)) {
    specialties.push('深度推理');
  }
  if (model.contextWindow >= 256_000) {
    specialties.push('超长上下文');
  }
  if (model.supportsImages) {
    specialties.push('多模态看图');
  }
  if (tier === 'fast') {
    specialties.push('极速响应');
  }
  if (!specialties.length) {
    specialties.push('通用执行');
  }
  return { tier, specialties };
}

function normalizeSelectedModels(input: unknown): SelectedModelConfig[] {
  if (!Array.isArray(input)) throw new Error('selectedModels 必须是数组');
  const result: SelectedModelConfig[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const item = (raw ?? {}) as { id?: unknown; tier?: unknown };
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) throw new Error('selectedModels 中的模型 ID 不能为空');
    if (id.length > 128) throw new Error(`模型 ID 过长: ${id.slice(0, 32)}…`);
    if (typeof item.tier !== 'string' || !MODEL_TIER_VALUES.includes(item.tier as ModelTier)) {
      throw new Error(`模型 "${id}" 的等级无效：${String(item.tier)}（应为 fast / balanced / strong）`);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ id, tier: item.tier as ModelTier });
  }
  if (result.length > MAX_SELECTED_MODELS) {
    throw new Error(`每个提供方最多勾选 ${MAX_SELECTED_MODELS} 个模型，当前 ${result.length} 个`);
  }
  return result;
}

function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const trimmed = key.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}***${trimmed.slice(-2)}`;
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function normalizeProviderId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const trimmed = id.trim();
  if (!trimmed) return undefined;
  return trimmed === 'gemini' ? 'google' : trimmed;
}

function isOpenCodeProvider(providerId: string, baseUrl?: string): boolean {
  if (providerId === 'opencode' || providerId === 'opencode-go') return true;
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === 'opencode.ai';
  } catch {
    return /opencode\.ai/i.test(baseUrl);
  }
}

function isOfficialOpenCodeUrl(providerId: string, baseUrl?: string): boolean {
  if (providerId !== 'opencode' && providerId !== 'opencode-go') return false;
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).hostname === 'opencode.ai';
  } catch {
    return false;
  }
}

export class ModelHub {
  private readonly sdkDir: string;
  private readonly statePath: string;
  private state: PersistedModelHubState = { providers: {}, modelStats: {} };
  private runtime?: ModelRuntime;
  private readonly baseModelsByProvider = new Map<string, ReturnType<ModelRuntime['getModels']>>();
  private cachedPool: PooledModelEntry[] = [];
  /** 所有已配置且启用的 provider 的完整模型目录（仅用于禁用 provider 时的回退选择，不作为 Worker 模型池） */
  private cachedCatalog: PooledModelEntry[] = [];

  constructor(
    private readonly home: string,
    private readonly mode: 'real' | 'offline',
    private currentTiers: ModelTierConfig,
    private currentRouterProvider: string,
    private readonly suppliedRuntime?: ModelRuntime,
    private readonly onTiersUpdated?: (tiers: ModelTierConfig, routerProvider: string, routerModel: string, disabledProviders: string[]) => void,
  ) {
    this.sdkDir = join(home, 'sdk');
    this.statePath = join(this.sdkDir, 'model-hub.json');
  }

  isProviderEnabled(providerId: string | undefined): boolean {
    const norm = normalizeProviderId(providerId);
    if (!norm) return true;
    return this.state.providers[norm]?.enabled !== false;
  }

  disabledProviders(): string[] {
    return Object.entries(this.state.providers)
      .filter(([, cfg]) => cfg?.enabled === false)
      .map(([id]) => id);
  }

  async init(initialProviderKeys?: Record<string, string | undefined>): Promise<void> {
    await mkdir(this.sdkDir, { recursive: true, mode: 0o700 });
    if (existsSync(this.statePath)) {
      try {
        const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<PersistedModelHubState>;
        this.state = {
          routerProvider: raw.routerProvider,
          routerModel: raw.routerModel,
          workerProvider: raw.workerProvider,
          fastModel: raw.fastModel,
          balancedModel: raw.balancedModel,
          strongModel: raw.strongModel,
          providers: raw.providers && typeof raw.providers === 'object' ? raw.providers : {},
          modelStats: raw.modelStats && typeof raw.modelStats === 'object' ? raw.modelStats : {},
          lastProbe: raw.lastProbe,
        };
      } catch {
        this.state = { providers: {}, modelStats: {} };
      }
    }
    if (initialProviderKeys) {
      for (const [prov, key] of Object.entries(initialProviderKeys)) {
        const norm = normalizeProviderId(prov);
        if (norm && key?.trim() && !this.state.providers[norm]?.apiKey) {
          this.state.providers[norm] = { ...this.state.providers[norm], apiKey: key.trim() };
        }
      }
    }
    const runtime = await this.ensureRuntime();
    if (this.mode === 'real') {
      const creds = await runtime.listCredentials();
      const candidateIds = new Set<string>([
        ...FEATURED_PROVIDERS.map(p => p.id),
        ...Object.keys(this.state.providers),
      ]);
      const syncTasks: Array<Promise<void>> = [];
      for (const provId of candidateIds) {
        const cfg = this.state.providers[provId];
        if (cfg?.enabled === false) continue;
        const hasCred = Boolean(
          cfg?.apiKey
          || cfg?.baseUrl
          || creds.some(c => c.providerId === provId)
          || runtime.getProviderAuthStatus(provId).configured,
        );
        if (hasCred && (!cfg?.fetchedModels?.length || cfg?.fetchError)) {
          syncTasks.push(
            this.syncProviderModelsFromApi(runtime, provId).then(() => {}, () => {}),
          );
        }
      }
      if (syncTasks.length) {
        await Promise.all(syncTasks);
        await this.saveState();
      }
    }
    await this.applyStateToRuntime(runtime);
  }

  private async ensureRuntime(): Promise<ModelRuntime> {
    if (this.runtime) return this.runtime;
    this.runtime = this.suppliedRuntime ?? await ModelRuntime.create({
      authPath: join(this.sdkDir, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(this.sdkDir, 'models-cache.json'),
      refreshOnCreate: false,
    });
    for (const p of FEATURED_PROVIDERS) {
      if (!this.baseModelsByProvider.has(p.id)) {
        this.baseModelsByProvider.set(p.id, [...this.runtime.getModels(p.id)]);
      }
    }
    return this.runtime;
  }

  private getBaseModels(runtime: ModelRuntime, providerId: string) {
    let base = this.baseModelsByProvider.get(providerId);
    if (!base) {
      base = [...runtime.getModels(providerId)];
      this.baseModelsByProvider.set(providerId, base);
    }
    return base;
  }

  private async resolveProviderApiKey(runtime: ModelRuntime, providerId: string, inlineApiKey?: string): Promise<string | undefined> {
    if (inlineApiKey?.trim()) return inlineApiKey.trim();
    const persistedKey = this.state.providers[providerId]?.apiKey?.trim();
    if (persistedKey) return persistedKey;
    try {
      const auth = await runtime.getAuth(providerId) as { auth?: { apiKey?: string }; apiKey?: string } | undefined;
      const key = auth?.auth?.apiKey ?? auth?.apiKey;
      if (key?.trim()) return key.trim();
    } catch {
      // ignore
    }
    return undefined;
  }

  private async fetchRemoteModelsFromEndpoint(
    providerId: string,
    apiKey: string | undefined,
    baseUrl: string | undefined,
    baseModels: ReturnType<ModelRuntime['getModels']>,
  ): Promise<ModelCatalogEntry[]> {
    const baseById = new Map(baseModels.map(m => [m.id, m]));
    const cleanBase = (baseUrl?.trim() || DEFAULT_PROVIDER_ENDPOINTS[providerId] || '').replace(/\/+$/, '');
    if (!cleanBase) {
      throw new Error(`提供方 "${providerId}" 未配置可用的模型列表接口地址 (Base URL)`);
    }

    if (providerId === 'google' && !baseUrl?.trim()) {
      if (!apiKey) throw new Error('拉取 Google Gemini 模型列表需要先提供 API Key');
      const url = `${cleanBase}/models?pageSize=100&key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Google /models 接口返回 HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const data = await res.json() as {
        models?: Array<{
          name?: string;
          displayName?: string;
          inputTokenLimit?: number;
          outputTokenLimit?: number;
          supportedGenerationMethods?: string[];
          thinking?: boolean;
        }>;
      };
      const rawList = Array.isArray(data.models) ? data.models : [];
      const entries: ModelCatalogEntry[] = [];
      for (const item of rawList) {
        if (!item.name) continue;
        const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
        if (!methods.includes('generateContent')) continue;
        const id = item.name.replace(/^models\//, '');
        if (/(?:tts|image-generation|embedding|aqa|imagen|veo|robotics|computer-use|audio)/i.test(id)) continue;
        const baseModel = baseById.get(id);
        entries.push({
          id,
          name: item.displayName || baseModel?.name || id,
          supportsImages: baseModel ? baseModel.input.includes('image') : true,
          reasoning: Boolean(item.thinking ?? baseModel?.reasoning ?? false),
          contextWindow: typeof item.inputTokenLimit === 'number' && item.inputTokenLimit > 0
            ? item.inputTokenLimit
            : (baseModel?.contextWindow ?? 1_048_576),
          maxTokens: typeof item.outputTokenLimit === 'number' && item.outputTokenLimit > 0
            ? item.outputTokenLimit
            : (baseModel?.maxTokens ?? 65_536),
          costInput: baseModel?.cost?.input ?? 0,
          costOutput: baseModel?.cost?.output ?? 0,
        });
      }
      if (!entries.length) {
        throw new Error('Google /models 接口未返回支持 generateContent 的对话模型');
      }
      return entries;
    }

    if (providerId === 'anthropic' && !baseUrl?.trim()) {
      if (!apiKey) throw new Error('拉取 Anthropic 模型列表需要先提供 API Key');
      const url = cleanBase.endsWith('/v1') ? `${cleanBase}/models` : `${cleanBase}/v1/models`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Anthropic /v1/models 接口返回 HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const data = await res.json() as {
        data?: Array<{ id?: string; display_name?: string }>;
      };
      const rawList = Array.isArray(data.data) ? data.data : [];
      const entries: ModelCatalogEntry[] = [];
      for (const item of rawList) {
        if (!item.id) continue;
        const baseModel = baseById.get(item.id);
        entries.push({
          id: item.id,
          name: item.display_name || baseModel?.name || item.id,
          supportsImages: baseModel ? baseModel.input.includes('image') : true,
          reasoning: Boolean(baseModel?.reasoning ?? true),
          contextWindow: baseModel?.contextWindow ?? 200_000,
          maxTokens: baseModel?.maxTokens ?? 16_384,
          costInput: baseModel?.cost?.input ?? 0,
          costOutput: baseModel?.cost?.output ?? 0,
        });
      }
      if (!entries.length) {
        throw new Error('Anthropic /v1/models 接口返回为空');
      }
      return entries;
    }

    // Standard OpenAI-compatible GET /models (DeepSeek, OpenAI, OpenAI Codex, OpenCode, or custom gateway)
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (isOpenCodeProvider(providerId, cleanBase)) {
      headers['x-opencode-session'] = randomUUID();
      headers['x-opencode-client'] = 'pi';
    }
    const url = `${cleanBase}/models`;
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`${providerId} /models 接口 (${url}) 返回 HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await res.json() as {
      data?: Array<{
        id?: string;
        slug?: string;
        name?: string;
         title?: string;
        display_name?: string;
        context_window?: number;
        max_context_window?: number;
        max_output_tokens?: number;
        input_modalities?: string[];
        reasoning?: boolean;
        supports_reasoning_effort_updates?: boolean;
      }>;
      models?: Array<{
        id?: string;
        slug?: string;
        name?: string;
        title?: string;
        display_name?: string;
        context_window?: number;
        max_context_window?: number;
        max_output_tokens?: number;
        input_modalities?: string[];
        reasoning?: boolean;
        supports_reasoning_effort_updates?: boolean;
      }>;
    };
    const rawList = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.models)
        ? data.models
        : [];
    const entries: ModelCatalogEntry[] = [];
    for (const item of rawList) {
      const id = (item.id || item.slug || '').trim();
      if (!id) continue;
      if (/^(?:tts-|whisper-|dall-e-|text-embedding-|omni-moderation-|babbage-|davinci-)/i.test(id)) continue;
      const baseModel = baseById.get(id);
      const supportsImages = Array.isArray(item.input_modalities)
        ? item.input_modalities.includes('image')
        : Boolean(baseModel?.input.includes('image'));
      const ctxWin = typeof item.context_window === 'number' && item.context_window > 0
        ? item.context_window
        : typeof item.max_context_window === 'number' && item.max_context_window > 0
          ? item.max_context_window
          : (baseModel?.contextWindow ?? 128_000);
      entries.push({
        id,
        name: item.name || item.display_name || item.title || baseModel?.name || id,
        supportsImages,
        reasoning: Boolean(item.reasoning ?? item.supports_reasoning_effort_updates ?? baseModel?.reasoning ?? false),
        contextWindow: ctxWin,
        maxTokens: typeof item.max_output_tokens === 'number' && item.max_output_tokens > 0
          ? item.max_output_tokens
          : (baseModel?.maxTokens ?? 16_384),
        costInput: baseModel?.cost?.input ?? 0,
        costOutput: baseModel?.cost?.output ?? 0,
      });
    }
    if (!entries.length) {
      throw new Error(`${providerId} /models 接口未返回可用模型`);
    }
    return entries;
  }

  private async syncProviderModelsFromApi(
    runtime: ModelRuntime,
    providerId: string,
    inline?: { apiKey?: string; baseUrl?: string },
  ): Promise<ModelCatalogEntry[]> {
    const baseModels = this.getBaseModels(runtime, providerId);
    const persisted = this.state.providers[providerId] ?? {};
    const apiKey = await this.resolveProviderApiKey(runtime, providerId, inline?.apiKey);
    const baseUrl = inline?.baseUrl !== undefined
      ? (inline.baseUrl.trim() || undefined)
      : persisted.baseUrl;
    try {
      const fetched = await this.fetchRemoteModelsFromEndpoint(providerId, apiKey, baseUrl, baseModels);
      this.state.providers[providerId] = {
        ...this.state.providers[providerId],
        fetchedModels: fetched,
        modelsFetchedAt: Date.now(),
        fetchError: undefined,
      };
      return fetched;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.state.providers[providerId] = {
        ...this.state.providers[providerId],
        fetchError: msg,
      };
      throw error;
    }
  }

  async fetchModels(input: ModelHubFetchInput): Promise<ModelHubView> {
    const runtime = await this.ensureRuntime();
    const providerId = normalizeProviderId(input.providerId);
    if (!providerId) throw new Error('请指定提供方 ID');
    if (!this.isProviderEnabled(providerId)) {
      throw new Error(`提供方 "${providerId}" 已禁用，无法拉取模型；请先启用该提供方`);
    }
    await this.syncProviderModelsFromApi(runtime, providerId, {
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
    });
    await this.applyStateToRuntime(runtime);
    await this.saveState();
    return this.getView();
  }

  private async applyStateToRuntime(runtime: ModelRuntime): Promise<void> {
    const allProviderIds = new Set<string>([
      ...FEATURED_PROVIDERS.map(p => p.id),
      ...Object.keys(this.state.providers),
    ]);
    for (const providerId of allProviderIds) {
      const cfg = this.state.providers[providerId] ?? {};
      const baseModels = this.getBaseModels(runtime, providerId);
      const baseById = new Map(baseModels.map(m => [m.id, m]));
      const defaultSample = baseModels[0];
      const fallbackModels = FALLBACK_PROVIDER_MODELS[providerId] ?? [];

      if (cfg.fetchedModels?.length || cfg.baseUrl || cfg.customModels?.length || (!baseModels.length && fallbackModels.length)) {
        const catalogMap = new Map<string, ModelCatalogEntry>();
        for (const m of cfg.fetchedModels ?? []) {
          catalogMap.set(m.id, m);
        }
        if (!catalogMap.size) {
          for (const bm of baseModels) {
            catalogMap.set(bm.id, {
              id: bm.id,
              name: bm.name || bm.id,
              supportsImages: bm.input.includes('image'),
              reasoning: Boolean(bm.reasoning),
              contextWindow: bm.contextWindow ?? 128_000,
              maxTokens: bm.maxTokens ?? 16_384,
              costInput: bm.cost?.input ?? 0,
              costOutput: bm.cost?.output ?? 0,
            });
          }
          for (const fm of fallbackModels) {
            if (!catalogMap.has(fm.id)) catalogMap.set(fm.id, fm);
          }
        }
        for (const customId of cfg.customModels ?? []) {
          if (customId && !catalogMap.has(customId)) {
            const bm = baseById.get(customId);
            catalogMap.set(customId, {
              id: customId,
              name: bm?.name ?? customId,
              supportsImages: Boolean(bm?.input.includes('image')),
              reasoning: Boolean(bm?.reasoning),
              contextWindow: bm?.contextWindow ?? 128_000,
              maxTokens: bm?.maxTokens ?? 16_384,
              costInput: bm?.cost?.input ?? 0,
              costOutput: bm?.cost?.output ?? 0,
            });
          }
        }

        const effectiveBaseUrl = cfg.baseUrl || defaultSample?.baseUrl || DEFAULT_PROVIDER_ENDPOINTS[providerId] || 'https://api.openai.com/v1';
        const effectiveApi = cfg.baseUrl ? 'openai-completions' : (defaultSample?.api ?? 'openai-completions');

        if (catalogMap.size > 0) {
          const officialOpenCode = isOfficialOpenCodeUrl(providerId, cfg.baseUrl);
          runtime.registerProvider(providerId, {
            baseUrl: effectiveBaseUrl,
            api: effectiveApi,
            ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
            models: [...catalogMap.values()].map(entry => {
              const bm = baseById.get(entry.id);
              const preserveBuiltinProtocol = Boolean(bm && officialOpenCode);
              return {
                ...(bm ?? {}),
                id: entry.id,
                name: entry.name || bm?.name || entry.id,
                api: preserveBuiltinProtocol ? bm!.api : (cfg.baseUrl ? 'openai-completions' : (bm?.api ?? effectiveApi)),
                baseUrl: preserveBuiltinProtocol ? bm!.baseUrl : (cfg.baseUrl || bm?.baseUrl || effectiveBaseUrl),
                reasoning: entry.reasoning ?? Boolean(bm?.reasoning),
                input: entry.supportsImages ? ['text', 'image'] : ['text'],
                cost: bm?.cost ?? { input: entry.costInput, output: entry.costOutput, cacheRead: 0, cacheWrite: 0 },
                contextWindow: entry.contextWindow || bm?.contextWindow || 128_000,
                maxTokens: entry.maxTokens || bm?.maxTokens || 16_384,
              };
            }),
          });
        }
      }
      if (cfg.apiKey) {
        await runtime.setRuntimeApiKey(providerId, cfg.apiKey);
      }
    }
    await this.rebuildPoolCache(runtime);
    let workerProvider = normalizeProviderId(this.state.workerProvider) ?? this.currentTiers.provider;
    let routerProvider = normalizeProviderId(this.state.routerProvider) ?? this.currentRouterProvider;
    let routerModel = this.state.routerModel ?? this.currentTiers.router;
    if (workerProvider !== 'offline' && !this.isProviderEnabled(workerProvider) && this.cachedCatalog.length > 0) {
      workerProvider = this.cachedCatalog[0]!.providerId;
      this.state.workerProvider = workerProvider;
      delete this.state.fastModel;
      delete this.state.balancedModel;
      delete this.state.strongModel;
    }
    if (routerProvider !== 'offline' && !this.isProviderEnabled(routerProvider) && this.cachedCatalog.length > 0) {
      routerProvider = this.cachedCatalog[0]!.providerId;
      routerModel = this.cachedCatalog.find(p => p.providerId === routerProvider && p.tier === 'balanced')?.modelId ?? this.cachedCatalog[0]!.modelId;
      this.state.routerProvider = routerProvider;
      this.state.routerModel = routerModel;
    }
    if (workerProvider !== 'offline') {
      const workerPoolDefault = this.cachedCatalog.find(p => p.providerId === workerProvider)?.modelId;
      const defaultWorker = this.state.strongModel ?? this.state.balancedModel ?? workerPoolDefault ?? this.currentTiers.strong;
      this.currentTiers = buildModelTiers(runtime, workerProvider, routerModel, defaultWorker, {
        fastModel: this.state.fastModel,
        balancedModel: this.state.balancedModel,
        strongModel: this.state.strongModel,
        hasCustomBaseUrl: Boolean(this.state.providers[workerProvider]?.baseUrl),
      });
    } else {
      this.currentTiers = {
        ...this.currentTiers,
        router: routerModel,
        fast: this.state.fastModel ?? this.currentTiers.fast,
        balanced: this.state.balancedModel ?? this.currentTiers.balanced,
        strong: this.state.strongModel ?? this.currentTiers.strong,
      };
    }
    this.currentRouterProvider = routerProvider;
    // 模型池依赖最新的 Worker 档位，档位更新后重建一次
    await this.rebuildPoolCache(runtime);
    this.onTiersUpdated?.(this.currentTiers, this.currentRouterProvider, this.currentTiers.router, this.disabledProviders());
  }

  private async rebuildPoolCache(runtime: ModelRuntime): Promise<PooledModelEntry[]> {
    const creds = await runtime.listCredentials();
    const oauthSet = new Set(creds.filter(c => c.type === 'oauth').map(c => c.providerId));
    const providerIds = new Set<string>(FEATURED_PROVIDERS.map(p => p.id));
    for (const id of Object.keys(this.state.providers)) providerIds.add(id);
    if (this.currentTiers.provider && this.currentTiers.provider !== 'offline') providerIds.add(this.currentTiers.provider);
    if (this.currentRouterProvider && this.currentRouterProvider !== 'offline') providerIds.add(this.currentRouterProvider);

    const pool: PooledModelEntry[] = [];
    const catalog: PooledModelEntry[] = [];
    for (const id of providerIds) {
      const featured = FEATURED_PROVIDERS.find(p => p.id === id);
      const catalogProvider = runtime.getProvider(id);
      const persisted = this.state.providers[id];
      if (persisted?.enabled === false) continue;
      const authStatus = runtime.getProviderAuthStatus(id);
      const hasOAuth = oauthSet.has(id);
      const hasApiKey = Boolean(persisted?.apiKey || authStatus.source === 'runtime' || authStatus.source === 'stored');
      const configured = hasOAuth || hasApiKey || authStatus.configured || Boolean(persisted?.baseUrl);
      if (!configured) continue;

      const providerName = persisted?.name ?? featured?.name ?? catalogProvider?.name ?? id;
      const hasRemoteModels = Boolean(persisted?.fetchedModels?.length);
      const rawModels = runtime.getModels(id);
      const models: ModelCatalogEntry[] = hasRemoteModels
        ? persisted!.fetchedModels!
        : rawModels.length
          ? rawModels.map(m => ({
              id: m.id,
              name: m.name || m.id,
              supportsImages: m.input.includes('image'),
              reasoning: Boolean(m.reasoning),
              contextWindow: m.contextWindow ?? 128_000,
              maxTokens: m.maxTokens ?? 16_384,
              costInput: m.cost?.input ?? 0,
              costOutput: m.cost?.output ?? 0,
            }))
          : (FALLBACK_PROVIDER_MODELS[id] ?? []);
      const sampleDefault = models[0]?.id ?? 'default';
      const sampleTiers = buildModelTiers(runtime, id, sampleDefault, sampleDefault, {
        hasCustomBaseUrl: Boolean(persisted?.baseUrl),
      });

      const toEntry = (m: ModelCatalogEntry, tier: ModelTier, specialties: string[]): PooledModelEntry => {
        const spec = `${id}/${m.id}`;
        const stats = this.state.modelStats?.[spec];
        return {
          spec,
          providerId: id,
          providerName,
          modelId: m.id,
          modelName: m.name || m.id,
          tier,
          specialties,
          supportsImages: m.supportsImages,
          reasoning: m.reasoning,
          contextWindow: m.contextWindow,
          latencyMs: stats?.lastLatencyMs,
          successCount: stats?.successCount,
          failCount: stats?.failCount,
        };
      };
      const lookup = (modelId: string): ModelCatalogEntry => models.find(m => m.id === modelId) ?? {
        id: modelId,
        name: modelId,
        supportsImages: false,
        reasoning: false,
        contextWindow: 128_000,
        costInput: 0,
        costOutput: 0,
      };

      for (const m of models) {
        const { tier, specialties } = classifyModelEntry(id, m, sampleTiers);
        catalog.push(toEntry(m, tier, specialties));
      }

      // Worker 模型池：仅包含用户显式勾选的模型（等级由用户指定）+ 当前 Worker provider 的三档模型
      const added = new Set<string>();
      const addToPool = (modelId: string, tier: ModelTier) => {
        if (!modelId || added.has(modelId)) return;
        added.add(modelId);
        const m = lookup(modelId);
        const inferred = classifyModelEntry(id, m, sampleTiers).specialties.filter(s => s !== '极速响应');
        if (tier === 'fast') inferred.push('极速响应');
        pool.push(toEntry(m, tier, inferred.length ? inferred : ['通用执行']));
      };
      for (const sel of persisted?.selectedModels ?? []) {
        if (typeof sel?.id === 'string' && MODEL_TIER_VALUES.includes(sel.tier)) addToPool(sel.id, sel.tier);
      }
      if (id === this.currentTiers.provider) {
        // 同一模型占据多个档位时优先视为 balanced（与 classifyModelEntry 的约定一致）
        for (const tierName of ['balanced', 'strong', 'fast'] as const) addToPool(this.currentTiers[tierName], tierName);
      }
    }
    this.cachedCatalog = catalog;
    this.cachedPool = pool;
    return pool;
  }

  getModelPool(): PooledModelEntry[] {
    return this.cachedPool;
  }

  recordTaskOutcome(workerModel: string | undefined, ok: boolean, durationMs?: number): void {
    if (!workerModel) return;
    let spec = workerModel.trim();
    if (!spec) return;
    if (!spec.includes('/')) {
      const matched = this.cachedPool.find(item => item.modelId === spec);
      spec = matched ? matched.spec : `${this.currentTiers.provider}/${spec}`;
    }
    const stats = this.state.modelStats ?? (this.state.modelStats = {});
    const prev = stats[spec] ?? { successCount: 0, failCount: 0, updatedAt: Date.now() };
    const updated: ModelEffectStats = {
      ...prev,
      successCount: prev.successCount + (ok ? 1 : 0),
      failCount: prev.failCount + (ok ? 0 : 1),
      ...(durationMs && durationMs > 0 ? { lastLatencyMs: Math.round(durationMs) } : {}),
      updatedAt: Date.now(),
    };
    stats[spec] = updated;
    const poolEntry = this.cachedPool.find(item => item.spec === spec);
    if (poolEntry) {
      poolEntry.successCount = updated.successCount;
      poolEntry.failCount = updated.failCount;
      if (updated.lastLatencyMs) poolEntry.latencyMs = updated.lastLatencyMs;
    }
    void this.saveState().catch(() => {});
  }

  private modelNotInPoolError(rawModel: string): Error {
    const limit = 12;
    const specs = this.cachedPool.map(p => p.spec);
    const listed = specs.slice(0, limit).join(', ') + (specs.length > limit ? ` 等 ${specs.length} 个` : '');
    return new Error(`模型 "${rawModel}" 未在模型中心启用；当前可用：${listed || '无'}`);
  }

  selectWorkerModel(input: WorkerModelResolutionInput): { model: string; tier: ModelTier } {
    const rawModel = input.model?.trim();
    const tier = inferModelTier(input);

    // 1. Explicit model specification from F. (e.g. "anthropic/claude-sonnet-5-5" or "gemini-4-argon")
    if (rawModel && !['fast', 'balanced', 'strong'].includes(rawModel)) {
      if (rawModel.includes('/')) {
        const slash = rawModel.indexOf('/');
        const explicitProv = normalizeProviderId(rawModel.slice(0, slash));
        if (explicitProv && !this.isProviderEnabled(explicitProv)) {
          throw new Error(`提供方 "${explicitProv}" 已禁用，无法调用模型 "${rawModel}"`);
        }
        const normalizedSpec = `${explicitProv}/${rawModel.slice(slash + 1)}`;
        const entry = this.cachedPool.find(p => p.spec === rawModel || p.spec === normalizedSpec);
        if (!entry && this.cachedPool.length > 0) throw this.modelNotInPoolError(rawModel);
        return { model: rawModel, tier: entry?.tier ?? tier };
      }
      const poolHit = this.cachedPool.find(p => p.modelId === rawModel);
      if (poolHit) {
        const readyProviders = new Set(this.cachedPool.map(p => p.providerId));
        return {
          model: readyProviders.size > 1 ? poolHit.spec : poolHit.modelId,
          tier: poolHit.tier,
        };
      }
      for (const disProv of this.disabledProviders()) {
        const disCfg = this.state.providers[disProv];
        const inDisabled = Boolean(
          this.runtime?.getModel(disProv, rawModel)
          || disCfg?.fetchedModels?.some(m => m.id === rawModel)
          || disCfg?.customModels?.includes(rawModel),
        );
        if (inDisabled) {
          throw new Error(`提供方 "${disProv}" 已禁用，无法调用模型 "${rawModel}"`);
        }
      }
      if (!this.isProviderEnabled(this.currentTiers.provider)) {
        throw new Error(`提供方 "${this.currentTiers.provider}" 已禁用，无法调用模型 "${rawModel}"`);
      }
      if (this.cachedPool.length > 0) throw this.modelNotInPoolError(rawModel);
      return resolveWorkerModelFromTiers(this.currentTiers, input);
    }

    // 2. If fewer than 2 providers are in the pool and no custom multi-provider pool is active, use standard tier resolution
    const readyProviders = new Set(this.cachedPool.map(p => p.providerId));
    if (this.cachedPool.length === 0) {
      if (!this.isProviderEnabled(this.currentTiers.provider)) {
        throw new Error(`提供方 "${this.currentTiers.provider}" 已禁用，当前无可用模型提供方`);
      }
      return resolveWorkerModelFromTiers(this.currentTiers, input);
    }
    if (readyProviders.size === 1 && readyProviders.has(this.currentTiers.provider) && !Object.keys(this.state.modelStats ?? {}).length) {
      return resolveWorkerModelFromTiers(this.currentTiers, input);
    }

    // 3. Cross-provider intelligent scoring based on task content, model capabilities, and empirical effect
    const text = (input.instruction ?? '').trim();
    const needsVision = /图片|截图|看图|视觉|二维码|照片|设计稿|OCR|image|screenshot|vision|photo|diagram/i.test(text);
    const needsDeepReasoning = input.profile === 'review'
      || tier === 'strong'
      || /重构|架构|根因|并发|竞态|死锁|安全|漏洞|审计|复杂|迁移|设计|证明|性能瓶颈|refactor|architecture|root\s*cause|security|vulnerability|audit|concurrency|race|deadlock/i.test(text);
    const needsCoding = input.profile === 'coding'
      || /代码|实现|修改|组件|接口|函数|测试|构建|修复|报错|脚本|编译|类型|bug|fix|implement|code|typescript|javascript|python|rust|go|css|html/i.test(text);
    const needsLongContext = input.profile === 'research'
      || (input.fileCount ?? 0) >= 4
      || /调研|搜索|全局|通读|多文件|汇总|对比|长文|文档|全库|research|investigate|summarize\s+all/i.test(text);
    const needsFast = tier === 'fast' || Boolean(input.isTimer);

    let bestEntry = this.cachedPool[0]!;
    let bestScore = -Infinity;

    for (const entry of this.cachedPool) {
      let score = 0;
      if (entry.tier === tier) score += 45;
      else if (tier === 'balanced' && entry.tier === 'strong') score += 20;
      else if (tier === 'balanced' && entry.tier === 'fast') score += 15;

      if (needsVision) {
        score += entry.supportsImages ? 55 : -120;
      }
      if (needsDeepReasoning) {
        if (entry.reasoning) score += 35;
        if (entry.tier === 'strong') score += 25;
        if (entry.specialties.includes('深度推理')) score += 20;
      }
      if (needsCoding) {
        if (entry.specialties.includes('代码工程')) score += 30;
        if (/(?:claude-sonnet|claude-opus|gpt-6|gpt-5|gpt-4\.1|codex|deepseek|qwen.*coder)/i.test(entry.modelId)) score += 20;
      }
      if (needsLongContext) {
        if (entry.contextWindow >= 500_000) score += 35;
        else if (entry.contextWindow >= 200_000) score += 20;
      }
      if (needsFast) {
        if (entry.tier === 'fast') score += 40;
        if (entry.tier === 'strong') score -= 20;
      }

      const stats = this.state.modelStats?.[entry.spec];
      if (stats) {
        if (stats.lastProbeOk === true) score += 15;
        if (stats.lastProbeOk === false) score -= 70;
        if (stats.successCount > 0) score += Math.min(24, stats.successCount * 4);
        if (stats.failCount > stats.successCount) score -= 45;
        if (stats.lastLatencyMs && stats.lastLatencyMs < 2500) score += 10;
      }

      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }

    const useQualifiedSpec = readyProviders.size > 1 || bestEntry.providerId !== this.currentTiers.provider;
    return {
      model: useQualifiedSpec ? bestEntry.spec : bestEntry.modelId,
      tier,
    };
  }

  private async saveState(): Promise<void> {
    await mkdir(this.sdkDir, { recursive: true, mode: 0o700 });
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await chmod(this.statePath, 0o600).catch(() => {});
  }

  async getView(): Promise<ModelHubView> {
    const runtime = await this.ensureRuntime();
    const creds = await runtime.listCredentials();
    const oauthSet = new Set(creds.filter(c => c.type === 'oauth').map(c => c.providerId));

    const providerIds = new Set<string>(FEATURED_PROVIDERS.map(p => p.id));
    for (const id of Object.keys(this.state.providers)) providerIds.add(id);
    if (this.currentTiers.provider && this.currentTiers.provider !== 'offline') providerIds.add(this.currentTiers.provider);
    if (this.currentRouterProvider && this.currentRouterProvider !== 'offline') providerIds.add(this.currentRouterProvider);

    const providers: ModelProviderView[] = [];
    for (const id of providerIds) {
      const featured = FEATURED_PROVIDERS.find(p => p.id === id);
      const catalogProvider = runtime.getProvider(id);
      const persisted = this.state.providers[id];
      const authStatus = runtime.getProviderAuthStatus(id);
      const hasOAuth = oauthSet.has(id);
      const hasApiKey = Boolean(persisted?.apiKey || authStatus.source === 'runtime' || authStatus.source === 'stored');
      const authType: ModelProviderView['authType'] = hasOAuth
        ? 'oauth'
        : hasApiKey
          ? 'api_key'
          : authStatus.configured
            ? 'environment'
            : 'none';
      const configured = authType !== 'none' || Boolean(persisted?.baseUrl);
      const hasRemoteModels = Boolean(persisted?.fetchedModels?.length);
      const rawModels = runtime.getModels(id);
      const models: ModelCatalogEntry[] = hasRemoteModels
        ? persisted!.fetchedModels!
        : rawModels.length
          ? rawModels.map(m => ({
              id: m.id,
              name: m.name || m.id,
              supportsImages: m.input.includes('image'),
              reasoning: Boolean(m.reasoning),
              contextWindow: m.contextWindow ?? 128_000,
              maxTokens: m.maxTokens ?? 16_384,
              costInput: m.cost?.input ?? 0,
              costOutput: m.cost?.output ?? 0,
            }))
          : (FALLBACK_PROVIDER_MODELS[id] ?? []);
      const sampleDefault = models[0]?.id ?? 'default';
      const sampleTiers = buildModelTiers(runtime, id, sampleDefault, sampleDefault, {
        hasCustomBaseUrl: Boolean(persisted?.baseUrl),
      });
      providers.push({
        id,
        name: persisted?.name ?? featured?.name ?? catalogProvider?.name ?? id,
        enabled: persisted?.enabled !== false,
        configured,
        authType,
        keyHint: maskKey(persisted?.apiKey),
        baseUrl: persisted?.baseUrl,
        supportsOAuth: Boolean(catalogProvider?.auth?.oauth),
        modelSource: hasRemoteModels ? 'remote_api' : 'sdk_catalog',
        modelsFetchedAt: persisted?.modelsFetchedAt,
        fetchError: persisted?.fetchError,
        defaultFast: sampleTiers.fast,
        defaultBalanced: sampleTiers.balanced,
        defaultStrong: sampleTiers.strong,
        models,
        selectedModels: persisted?.selectedModels ?? [],
        suggestedTiers: Object.fromEntries(models.map(m => [m.id, classifyModelEntry(id, m, sampleTiers).tier])),
      });
    }

    await this.rebuildPoolCache(runtime);

    return {
      mode: this.mode,
      routerProvider: this.currentRouterProvider,
      routerModel: this.currentTiers.router,
      workerProvider: this.currentTiers.provider,
      tiers: this.currentTiers,
      providers,
      modelPool: this.cachedPool,
      lastProbe: this.state.lastProbe,
    };
  }

  async configure(input: ModelHubConfigureInput): Promise<ModelHubView> {
    const runtime = await this.ensureRuntime();
    const targetProvider = normalizeProviderId(input.providerId);
    if (targetProvider) {
      const prev = this.state.providers[targetProvider] ?? {};
      const next: PersistedProviderConfig = { ...prev };
      if (input.providerName !== undefined && input.providerName.trim()) {
        next.name = input.providerName.trim();
      }
      if (input.enabled !== undefined) {
        next.enabled = Boolean(input.enabled);
      }
      if (input.clearApiKey) {
        delete next.apiKey;
        delete next.fetchedModels;
        delete next.modelsFetchedAt;
        delete next.fetchError;
        await runtime.removeRuntimeApiKey(targetProvider).catch(() => {});
      } else if (input.apiKey !== undefined && input.apiKey.trim()) {
        next.apiKey = input.apiKey.trim();
      }
      if (input.baseUrl !== undefined) {
        const trimmedUrl = input.baseUrl.trim();
        if (trimmedUrl) {
          let parsed: URL;
          try { parsed = new URL(trimmedUrl); } catch { throw new Error(`无效的 Base URL: ${trimmedUrl}`); }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Base URL 必须使用 http 或 https');
          next.baseUrl = trimmedUrl;
        } else {
          delete next.baseUrl;
        }
      }
      if (Array.isArray(input.customModels)) {
        next.customModels = input.customModels.map(m => m.trim()).filter(Boolean);
      }
      if (input.selectedModels !== undefined) {
        const selected = normalizeSelectedModels(input.selectedModels);
        if (selected.length) next.selectedModels = selected;
        else delete next.selectedModels;
      }
      this.state.providers[targetProvider] = next;
      if (this.mode === 'real' && next.enabled !== false && !input.clearApiKey && (next.apiKey || next.baseUrl)) {
        await this.syncProviderModelsFromApi(runtime, targetProvider).catch(() => {});
      }
    }

    if (input.workerProvider !== undefined && input.workerProvider.trim()) {
      const nextWorkerProv = normalizeProviderId(input.workerProvider)!;
      if (!this.isProviderEnabled(nextWorkerProv)) {
        throw new Error(`提供方 "${nextWorkerProv}" 已禁用，无法设为 Worker 提供方；请先启用该提供方`);
      }
      const switchedProvider = nextWorkerProv !== this.currentTiers.provider;
      this.state.workerProvider = nextWorkerProv;
      this.currentTiers.provider = nextWorkerProv;
      if (switchedProvider && input.fastModel === undefined && input.balancedModel === undefined && input.strongModel === undefined) {
        delete this.state.fastModel;
        delete this.state.balancedModel;
        delete this.state.strongModel;
      }
    }
    if (input.routerProvider !== undefined && input.routerProvider.trim()) {
      const nextRouterProv = normalizeProviderId(input.routerProvider)!;
      if (!this.isProviderEnabled(nextRouterProv)) {
        throw new Error(`提供方 "${nextRouterProv}" 已禁用，无法设为 F.R.I.D.A.Y. 主控提供方；请先启用该提供方`);
      }
      this.state.routerProvider = nextRouterProv;
      this.currentRouterProvider = this.state.routerProvider;
    }
    if (input.routerModel !== undefined && input.routerModel.trim()) {
      const rawRouter = input.routerModel.trim();
      if (rawRouter.includes('/')) {
        const slash = rawRouter.indexOf('/');
        const nextRouterProv = normalizeProviderId(rawRouter.slice(0, slash));
        if (nextRouterProv && !this.isProviderEnabled(nextRouterProv)) {
          throw new Error(`提供方 "${nextRouterProv}" 已禁用，无法设为 F.R.I.D.A.Y. 主控模型；请先启用该提供方`);
        }
        this.state.routerProvider = nextRouterProv;
        this.state.routerModel = rawRouter.slice(slash + 1);
      } else {
        this.state.routerModel = rawRouter;
      }
    }
    if (input.fastModel !== undefined) {
      this.state.fastModel = input.fastModel.trim() || undefined;
    }
    if (input.balancedModel !== undefined) {
      this.state.balancedModel = input.balancedModel.trim() || undefined;
    }
    if (input.strongModel !== undefined) {
      this.state.strongModel = input.strongModel.trim() || undefined;
    }

    await this.applyStateToRuntime(runtime);
    await this.saveState();
    return this.getView();
  }

  async probe(input: ModelHubProbeInput): Promise<ModelProbeResult> {
    const runtime = await this.ensureRuntime();
    let provider = normalizeProviderId(input.provider) ?? this.currentTiers.provider;
    let modelId = input.model.trim();
    if (modelId.includes('/')) {
      const slash = modelId.indexOf('/');
      provider = normalizeProviderId(modelId.slice(0, slash)) ?? provider;
      modelId = modelId.slice(slash + 1);
    } else if (provider === 'offline' || (!runtime.getModel(provider, modelId) && runtime.getModel('deepseek', modelId))) {
      if (runtime.getModel('deepseek', modelId)) provider = 'deepseek';
      else if (runtime.getModel('openai', modelId)) provider = 'openai';
      else if (runtime.getModel('google', modelId)) provider = 'google';
    }

    const start = Date.now();
    if (!this.isProviderEnabled(provider)) {
      const result: ModelProbeResult = {
        ok: false,
        provider,
        model: modelId,
        mode: this.mode,
        latencyMs: 1,
        supportsImages: false,
        error: `提供方 "${provider}" 已禁用，无法调用。请先在模型管理中启用该提供方。`,
        testedAt: Date.now(),
      };
      this.state.lastProbe = result;
      await this.saveState();
      return result;
    }
    const inlineApiKey = input.apiKey?.trim() || undefined;
    const inlineBaseUrl = input.baseUrl?.trim() || undefined;
    if (inlineBaseUrl) {
      let parsed: URL;
      try { parsed = new URL(inlineBaseUrl); } catch {
        return {
          ok: false, provider, model: modelId, mode: 'real', latencyMs: 1,
          supportsImages: false, error: `无效的 Base URL: ${inlineBaseUrl}`, testedAt: Date.now(),
        };
      }
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const baseModels = this.getBaseModels(runtime, provider);
        const baseById = new Map(baseModels.map(m => [m.id, m]));
        const officialOpenCode = isOfficialOpenCodeUrl(provider, inlineBaseUrl);
        const existing = runtime.getModels(provider).map(m => m.id);
        const ids = [...new Set([...existing, modelId])];
        runtime.registerProvider(provider, {
          baseUrl: inlineBaseUrl,
          api: 'openai-completions',
          ...(inlineApiKey ?? this.state.providers[provider]?.apiKey ? { apiKey: inlineApiKey ?? this.state.providers[provider]?.apiKey } : {}),
          models: ids.map(id => {
            const bm = baseById.get(id);
            const existingModel = runtime.getModel(provider, id) ?? bm;
            const preserveBuiltinProtocol = Boolean(bm && officialOpenCode);
            return {
              ...(existingModel ?? {}),
              id,
              name: existingModel?.name ?? id,
              api: preserveBuiltinProtocol ? bm!.api : 'openai-completions',
              baseUrl: preserveBuiltinProtocol ? bm!.baseUrl : inlineBaseUrl,
              reasoning: Boolean(existingModel?.reasoning),
              input: existingModel?.input.includes('image') ? ['text', 'image'] : ['text'],
              cost: existingModel?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: existingModel?.contextWindow ?? 128_000,
              maxTokens: existingModel?.maxTokens ?? 16_384,
            };
          }),
        });
      }
    }
    const catalogModel = runtime.getModel(provider, modelId);
    const supportsImages = Boolean(catalogModel?.input.includes('image'));
    const contextWindow = catalogModel?.contextWindow;

    const creds = await runtime.listCredentials();
    const hasOAuth = creds.some(c => c.type === 'oauth' && c.providerId === provider);
    const authStatus = runtime.getProviderAuthStatus(provider);
    const hasPersistedKey = Boolean(this.state.providers[provider]?.apiKey);
    const hasBaseUrl = Boolean(inlineBaseUrl || this.state.providers[provider]?.baseUrl);
    const hasRealAuth = Boolean(inlineApiKey || hasOAuth || authStatus.configured || hasPersistedKey || hasBaseUrl);

    if (this.mode === 'offline' && !hasRealAuth) {
      const result: ModelProbeResult = {
        ok: true,
        provider,
        model: modelId,
        mode: 'offline',
        latencyMs: Math.max(1, Date.now() - start),
        supportsImages,
        contextWindow,
        reply: `[离线模拟探针] ${provider}/${modelId} 路由与神经链路就绪（未配置真实凭据，当前为本地模拟响应；填入真实 API Key 后可在此直接实测上游接口）。`,
        testedAt: Date.now(),
      };
      this.state.lastProbe = result;
      await this.saveState();
      return result;
    }

    if (!hasRealAuth) {
      const result: ModelProbeResult = {
        ok: false,
        provider,
        model: modelId,
        mode: 'real',
        latencyMs: Math.max(1, Date.now() - start),
        supportsImages,
        contextWindow,
        error: `提供方 "${provider}" 尚未配置 API Key 或 OAuth 授权，请先在上方保存凭据后再测试。`,
        testedAt: Date.now(),
      };
      this.state.lastProbe = result;
      await this.saveState();
      return result;
    }

    if (!catalogModel) {
      const result: ModelProbeResult = {
        ok: false,
        provider,
        model: modelId,
        mode: 'real',
        latencyMs: Math.max(1, Date.now() - start),
        supportsImages,
        error: `在提供方 "${provider}" 目录中未找到模型 "${modelId}"，请先点击「🔄 从接口拉取模型」同步最新模型列表。`,
        testedAt: Date.now(),
      };
      this.state.lastProbe = result;
      await this.saveState();
      return result;
    }

    try {
      const promptText = input.prompt?.trim() || '请用简短一句话回复：确认你的模型名称并报告连接正常。';
      const probeSessionId = randomUUID();
      const openCodeHeaders = isOpenCodeProvider(provider, catalogModel.baseUrl)
        ? { 'x-opencode-session': probeSessionId, 'x-opencode-client': 'pi' }
        : undefined;
      const res = await runtime.completeSimple(
        catalogModel,
        {
          systemPrompt: 'You are F.R.I.D.A.Y. (also known as Friday / 星期五) running a quick connectivity probe. Address the human as "老板" and reply in 1 short sentence in Simplified Chinese.',
          messages: [{ role: 'user', content: promptText, timestamp: Date.now() }],
        },
        {
          maxTokens: 512,
          sessionId: probeSessionId,
          ...(openCodeHeaders ? { headers: openCodeHeaders } : {}),
          ...(inlineApiKey ? { apiKey: inlineApiKey } : {}),
          signal: AbortSignal.timeout(15_000),
        },
      );
      const latencyMs = Math.max(1, Date.now() - start);
      if (res.stopReason === 'error' || res.stopReason === 'aborted') {
        const result: ModelProbeResult = {
          ok: false,
          provider,
          model: modelId,
          mode: 'real',
          latencyMs,
          supportsImages,
          contextWindow,
          error: res.errorMessage?.trim() || `模型请求返回状态: ${res.stopReason}`,
          testedAt: Date.now(),
        };
        this.state.lastProbe = result;
        await this.saveState();
        return result;
      }
      const reply = res.content
        .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
        .map(item => item.text)
        .join('\n')
        .trim();
      const result: ModelProbeResult = {
        ok: true,
        provider,
        model: modelId,
        mode: 'real',
        latencyMs,
        supportsImages,
        contextWindow,
        reply: reply || '(模型已成功响应，无文本内容)',
        testedAt: Date.now(),
      };
      this.recordProbeStats(`${provider}/${modelId}`, true, latencyMs);
      this.state.lastProbe = result;
      await this.saveState();
      return result;
    } catch (error) {
      const latencyMs = Math.max(1, Date.now() - start);
      const result: ModelProbeResult = {
        ok: false,
        provider,
        model: modelId,
        mode: 'real',
        latencyMs,
        supportsImages,
        contextWindow,
        error: error instanceof Error ? error.message : String(error),
        testedAt: Date.now(),
      };
      this.recordProbeStats(`${provider}/${modelId}`, false, latencyMs);
      this.state.lastProbe = result;
      await this.saveState();
      return result;
    }
  }

  private recordProbeStats(spec: string, ok: boolean, latencyMs: number) {
    const stats = this.state.modelStats ?? (this.state.modelStats = {});
    const prev = stats[spec] ?? { successCount: 0, failCount: 0, updatedAt: Date.now() };
    stats[spec] = {
      ...prev,
      lastLatencyMs: latencyMs,
      lastProbeOk: ok,
      updatedAt: Date.now(),
    };
    const poolEntry = this.cachedPool.find(item => item.spec === spec);
    if (poolEntry) {
      poolEntry.latencyMs = latencyMs;
    }
  }
}

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  clampNativeThinkingLevel,
  decideWorkerRoute,
  DEFAULT_GEMINI_DECISION_BASE_URL,
  evaluateSessionContinuity,
  evaluateWorkCompletion,
  GEMINI_DECISION_MODEL,
  getNativeThinkingLevels,
  selectHeuristicRoute,
  type CompletionEvaluationInput,
  type CompletionEvaluationResult,
  type DecisionCredentials,
  type DecisionSource,
  type SessionContinuityInput,
  type SessionContinuityResult,
  type ThinkingLevel,
} from './decision.js';
import { resolveEnv } from './paths.js';
import type {
  DecisionEngineView,
  ModelCatalogEntry,
  ModelHubView,
  ModelProbeResult,
  ModelProviderView,
  ModelTier,
  ModelTierConfig,
  PooledModelEntry,
} from './view.js';
import {
  assertSafeBaseUrlForCredentials,
  buildModelTiers,
  classifyModelEntry,
  computeEffectiveFailCount,
  DECISION_STATS_EPOCH,
  DEFAULT_PROVIDER_ENDPOINTS,
  ensureRealProviderCatalog,
  FALLBACK_PROVIDER_MODELS,
  FEATURED_PROVIDERS,
  getKnownProviderIds,
  getPristineSdkModel,
  isOfficialOpenCodeUrl,
  isOpenCodeProvider,
  maskKey,
  MODEL_TIER_VALUES,
  normalizeProviderId,
  normalizeSelectedModels,
  parseModelSpec,
  resolveWorkerModelFromTiers,
  sanitizeCredentialLeakText,
  splitModelAndLevel,
  thinkingLevelToTier,
  tierToPreferredThinkingLevel,
  type ModelEffectStats,
  type ModelHubConfigureInput,
  type ModelHubFetchInput,
  type ModelHubProbeInput,
  type PersistedDecisionConfig,
  type PersistedModelHubState,
  type PersistedProviderConfig,
  type SelectedModelConfig,
  type SelectedModelInput,
  type WorkerModelResolutionInput,
} from './models/catalog.js';
import { fetchRemoteModelsFromEndpoint } from './models/discovery.js';
import { resolveModelUnitPrice } from './models/pricing.js';
import {
  accumulateDecisionEraStats,
  formatModelNotInPoolError,
  toDecisionCandidates,
  type DecisionEraTaskRecord,
} from './models/pool-selector.js';

export type {
  ModelEffectStats,
  ModelHubConfigureInput,
  ModelHubFetchInput,
  ModelHubProbeInput,
  PersistedDecisionConfig,
  PersistedModelHubState,
  PersistedProviderConfig,
  SelectedModelConfig,
  SelectedModelInput,
  WorkerModelResolutionInput,
};

export interface ModelUsageEvent {
  actor: 'decision' | 'probe';
  provider: string;
  model: string;
  status: 'completed' | 'failed' | 'interrupted';
  usage: unknown;
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
  private cachedCosts = new Map<string, { costInput: number; costOutput: number }>();
  private usageListener?: (entry: ModelUsageEvent) => void;
  private saveQueue: Promise<void> = Promise.resolve();
  private runtimePromise?: Promise<ModelRuntime>;
  private closed = false;
  private readonly envProviderKeys = new Map<string, string>();
  private readonly explicitSessionKeys = new Set<string>();
  private readonly overriddenProviders = new Set<string>();

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

  setUsageListener(listener?: (entry: ModelUsageEvent) => void): void {
    this.usageListener = listener;
  }

  private emitUsage(entry: ModelUsageEvent): void {
    if (!this.usageListener) return;
    try {
      this.usageListener(entry);
    } catch {
      // Never allow usage telemetry errors to affect model hub operations.
    }
  }

  private emitDecisionUsage(usage: { inputTokens: number; outputTokens?: number; totalTokens: number } | undefined): void {
    if (!usage) return;
    this.emitUsage({
      actor: 'decision',
      provider: 'google',
      model: GEMINI_DECISION_MODEL,
      status: 'completed',
      usage,
    });
  }

  getModelCostRates(
    provider: string,
    model: string,
  ): { costInput: number; costOutput: number; costCacheRead?: number; costCacheWrite?: number } | undefined {
    const knownProviders = this.getKnownProviders();
    const parsed = parseModelSpec(model, {
      fallbackProvider: provider,
      preferFallbackProvider: Boolean(provider.trim()),
      knownProviders,
    });
    const rawProvider = provider.trim();
    const normProvider = parsed.providerId;
    const cleanModel = parsed.modelId;

    const cached = this.cachedCosts.get(`${normProvider}/${cleanModel}`)
      ?? (rawProvider && rawProvider !== normProvider ? this.cachedCosts.get(`${rawProvider}/${cleanModel}`) : undefined);
    const runtimeModel = this.runtime?.getModel(normProvider, cleanModel)
      ?? (rawProvider && rawProvider !== normProvider ? this.runtime?.getModel(rawProvider, cleanModel) : undefined);
    const pristine = getPristineSdkModel(normProvider, cleanModel)
      ?? (rawProvider && rawProvider !== normProvider ? getPristineSdkModel(rawProvider, cleanModel) : undefined);

    const hasPositive = (r?: { costInput?: number; costOutput?: number }) =>
      Boolean(r && ((r.costInput ?? 0) > 0 || (r.costOutput ?? 0) > 0));
    const hasSdkPositive = (m?: { cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }) =>
      Boolean(m?.cost && ((m.cost.input ?? 0) > 0 || (m.cost.output ?? 0) > 0));

    if (hasPositive(cached)) {
      const cacheReadSource = (runtimeModel?.cost?.cacheRead ?? 0) > 0
        ? runtimeModel
        : (pristine?.cost?.cacheRead ?? 0) > 0
          ? pristine
          : undefined;
      const cacheWriteSource = (runtimeModel?.cost?.cacheWrite ?? 0) > 0
        ? runtimeModel
        : (pristine?.cost?.cacheWrite ?? 0) > 0
          ? pristine
          : undefined;
      return {
        costInput: cached!.costInput,
        costOutput: cached!.costOutput,
        ...(cacheReadSource?.cost?.cacheRead !== undefined ? { costCacheRead: cacheReadSource.cost.cacheRead } : {}),
        ...(cacheWriteSource?.cost?.cacheWrite !== undefined ? { costCacheWrite: cacheWriteSource.cost.cacheWrite } : {}),
      };
    }
    if (hasSdkPositive(runtimeModel)) {
      return {
        costInput: runtimeModel!.cost.input,
        costOutput: runtimeModel!.cost.output,
        costCacheRead: runtimeModel!.cost.cacheRead,
        costCacheWrite: runtimeModel!.cost.cacheWrite,
      };
    }
    if (hasSdkPositive(pristine)) {
      return {
        costInput: pristine!.cost.input,
        costOutput: pristine!.cost.output,
        costCacheRead: pristine!.cost.cacheRead,
        costCacheWrite: pristine!.cost.cacheWrite,
      };
    }
    return undefined;
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
          decision: raw.decision && typeof raw.decision === 'object' ? raw.decision : undefined,
          providers: raw.providers && typeof raw.providers === 'object' ? raw.providers : {},
          modelStats: raw.modelStats && typeof raw.modelStats === 'object' ? raw.modelStats : {},
          statsEpoch: typeof raw.statsEpoch === 'string' ? raw.statsEpoch : undefined,
          lastProbe: raw.lastProbe,
        };
      } catch {
        this.state = { providers: {}, modelStats: {} };
      }
    }
    this.envProviderKeys.clear();
    if (initialProviderKeys) {
      for (const [prov, key] of Object.entries(initialProviderKeys)) {
        const norm = normalizeProviderId(prov);
        if (norm && key?.trim()) {
          this.envProviderKeys.set(norm, key.trim());
        }
      }
    }
    const runtime = await this.ensureRuntime();
    if (this.mode === 'real') {
      const creds = await runtime.listCredentials();
      const candidateIds = new Set<string>([
        ...FEATURED_PROVIDERS.map(p => p.id),
        ...Object.keys(this.state.providers),
        ...this.envProviderKeys.keys(),
      ]);
      const syncTasks: Array<Promise<void>> = [];
      for (const provId of candidateIds) {
        const cfg = this.state.providers[provId];
        if (cfg?.enabled === false) continue;
        const hasCred = Boolean(
          this.getEffectiveProviderKey(provId).key
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

  private getKnownProviders(): Set<string> {
    return getKnownProviderIds([
      ...FEATURED_PROVIDERS.map(p => p.id),
      ...Object.keys(this.state.providers),
      ...this.envProviderKeys.keys(),
      this.currentTiers.provider,
      this.currentRouterProvider,
    ]);
  }

  private getEffectiveProviderKey(providerId: string): { key?: string; source: 'persisted' | 'environment' | 'none' } {
    const persisted = this.state.providers[providerId]?.apiKey?.trim() || undefined;
    const envKey = this.envProviderKeys.get(providerId)?.trim() || undefined;
    if (this.explicitSessionKeys.has(providerId)) {
      return persisted ? { key: persisted, source: 'persisted' } : { source: 'none' };
    }
    if (envKey) return { key: envKey, source: 'environment' };
    if (persisted) return { key: persisted, source: 'persisted' };
    return { source: 'none' };
  }

  private isSameOriginInlineBaseUrl(runtime: ModelRuntime, providerId: string, inlineBaseUrl: string | undefined): boolean {
    const cleanInline = inlineBaseUrl?.trim();
    if (!cleanInline) return true;
    const baseModels = this.getBaseModels(runtime, providerId);
    const baseline = this.state.providers[providerId]?.baseUrl?.trim()
      || baseModels[0]?.baseUrl?.trim()
      || DEFAULT_PROVIDER_ENDPOINTS[providerId];
    if (!baseline) return false;
    try {
      return new URL(cleanInline).origin === new URL(baseline).origin;
    } catch {
      return false;
    }
  }

  private async ensureRuntime(): Promise<ModelRuntime> {
    if (this.runtime) return this.runtime;
    if (!this.runtimePromise) {
      this.runtimePromise = (async () => {
        const runtime = this.suppliedRuntime ?? await ModelRuntime.create({
          authPath: join(this.sdkDir, 'auth.json'),
          modelsPath: null,
          modelsStorePath: join(this.sdkDir, 'models-cache.json'),
          refreshOnCreate: false,
        });
        ensureRealProviderCatalog(runtime);
        for (const p of FEATURED_PROVIDERS) {
          if (!this.baseModelsByProvider.has(p.id)) {
            this.baseModelsByProvider.set(p.id, [...runtime.getModels(p.id)]);
          }
        }
        this.runtime = runtime;
        return runtime;
      })().finally(() => {
        this.runtimePromise = undefined;
      });
    }
    return this.runtimePromise;
  }

  private getBaseModels(runtime: ModelRuntime, providerId: string) {
    let base = this.baseModelsByProvider.get(providerId);
    if (!base) {
      base = [...runtime.getModels(providerId)];
      this.baseModelsByProvider.set(providerId, base);
    }
    return base;
  }

  private findReferenceModel(runtime: ModelRuntime, providerId: string, modelId: string) {
    return this.getBaseModels(runtime, providerId).find(m => m.id === modelId)
      ?? getPristineSdkModel(providerId, modelId);
  }

  private async resolveProviderApiKey(runtime: ModelRuntime, providerId: string, inlineApiKey?: string): Promise<string | undefined> {
    if (inlineApiKey?.trim()) return inlineApiKey.trim();
    const effective = this.getEffectiveProviderKey(providerId);
    if (effective.key) return effective.key;
    if (this.explicitSessionKeys.has(providerId)) return undefined;
    try {
      const auth = await runtime.getAuth(providerId) as { auth?: { apiKey?: string }; apiKey?: string } | undefined;
      const key = auth?.auth?.apiKey ?? auth?.apiKey;
      if (key?.trim()) return key.trim();
    } catch {
      // ignore
    }
    return undefined;
  }

  private async syncProviderModelsFromApi(
    runtime: ModelRuntime,
    providerId: string,
    inline?: { apiKey?: string; baseUrl?: string },
  ): Promise<ModelCatalogEntry[]> {
    const baseModels = this.getBaseModels(runtime, providerId);
    const persisted = this.state.providers[providerId] ?? {};
    const allowStoredKey = !inline?.baseUrl?.trim() || this.isSameOriginInlineBaseUrl(runtime, providerId, inline.baseUrl);
    const apiKey = inline?.apiKey?.trim()
      || (allowStoredKey ? await this.resolveProviderApiKey(runtime, providerId) : undefined);
    const baseUrl = inline?.baseUrl !== undefined
      ? (inline.baseUrl.trim() || undefined)
      : persisted.baseUrl;
    try {
      const fetched = await fetchRemoteModelsFromEndpoint(providerId, apiKey, baseUrl, baseModels);
      this.state.providers[providerId] = {
        ...this.state.providers[providerId],
        fetchedModels: fetched,
        modelsFetchedAt: Date.now(),
        fetchError: undefined,
      };
      return fetched;
    } catch (error) {
      const rawMsg = error instanceof Error ? error.message : String(error);
      const safeMsg = sanitizeCredentialLeakText(rawMsg, [
        apiKey,
        persisted.apiKey,
        this.envProviderKeys.get(providerId),
      ]) ?? rawMsg;
      this.state.providers[providerId] = {
        ...this.state.providers[providerId],
        fetchError: safeMsg,
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
      ...this.envProviderKeys.keys(),
    ]);
    for (const providerId of allProviderIds) {
      const cfg = this.state.providers[providerId] ?? {};
      const effectiveKey = this.getEffectiveProviderKey(providerId).key;
      const baseModels = this.getBaseModels(runtime, providerId);
      const baseById = new Map(baseModels.map(m => [m.id, m]));
      const defaultSample = baseModels[0];
      const fallbackModels = FALLBACK_PROVIDER_MODELS[providerId] ?? [];

      const activeRouterProv = normalizeProviderId(this.state.routerProvider) ?? this.currentRouterProvider;
      const customRouterModelId = cfg.baseUrl && providerId === activeRouterProv
        ? this.state.routerModel?.trim()
        : undefined;
      const selectedModelIds = Array.isArray(cfg.selectedModels)
        ? normalizeSelectedModels(cfg.selectedModels).map(s => s.id)
        : [];
      if (
        cfg.fetchedModels?.length
        || cfg.baseUrl
        || cfg.customModels?.length
        || selectedModelIds.length
        || Boolean(customRouterModelId)
        || (!baseModels.length && fallbackModels.length)
      ) {
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
        const extraModelIds = [
          ...(cfg.customModels ?? []),
          ...selectedModelIds,
          ...(customRouterModelId ? [customRouterModelId] : []),
        ];
        for (const customId of extraModelIds) {
          if (customId && !catalogMap.has(customId)) {
            const bm = baseById.get(customId) ?? getPristineSdkModel(providerId, customId);
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
          this.overriddenProviders.add(providerId);
          const officialOpenCode = isOfficialOpenCodeUrl(providerId, cfg.baseUrl);
          runtime.registerProvider(providerId, {
            baseUrl: effectiveBaseUrl,
            api: effectiveApi,
            ...(effectiveKey ? { apiKey: effectiveKey } : {}),
            models: [...catalogMap.values()].map(entry => {
              const bm = baseById.get(entry.id) ?? getPristineSdkModel(providerId, entry.id);
              const preserveBuiltinProtocol = Boolean(bm && officialOpenCode);
              const effectiveReasoning = entry.reasoning ?? Boolean(bm?.reasoning);
              const resolvedApi = preserveBuiltinProtocol ? bm!.api : (cfg.baseUrl ? 'openai-completions' : (bm?.api ?? effectiveApi));
              const existingMap = (bm as { thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> } | undefined)?.thinkingLevelMap;
              const thinkingLevelMap = existingMap
                ?? (effectiveReasoning && (resolvedApi === 'openai-responses' || resolvedApi === 'openai-codex-responses')
                  ? { off: null, minimal: null }
                  : undefined);
              const fallbackUnit = !cfg.baseUrl ? resolveModelUnitPrice(providerId, entry.id) : undefined;
              const fallbackKnown = Boolean(fallbackUnit && fallbackUnit.source !== 'unknown');
              const sdkCacheRead = bm?.cost?.cacheRead && bm.cost.cacheRead > 0
                ? bm.cost.cacheRead
                : fallbackKnown ? fallbackUnit!.cacheReadUsdPer1M : 0;
              const sdkCacheWrite = bm?.cost?.cacheWrite && bm.cost.cacheWrite > 0
                ? bm.cost.cacheWrite
                : fallbackKnown ? fallbackUnit!.cacheWriteUsdPer1M : 0;
              const cost = (entry.costInput > 0 || entry.costOutput > 0)
                ? { input: entry.costInput, output: entry.costOutput, cacheRead: sdkCacheRead, cacheWrite: sdkCacheWrite }
                : (!cfg.baseUrl && bm?.cost && (bm.cost.input > 0 || bm.cost.output > 0))
                  ? bm.cost
                  : fallbackKnown
                    ? { input: fallbackUnit!.inputUsdPer1M, output: fallbackUnit!.outputUsdPer1M, cacheRead: sdkCacheRead, cacheWrite: sdkCacheWrite }
                    : { input: entry.costInput, output: entry.costOutput, cacheRead: 0, cacheWrite: 0 };
              const maxTokens = (!cfg.baseUrl && bm?.maxTokens && (!entry.maxTokens || (entry.maxTokens === 16_384 && bm.maxTokens > 16_384)))
                ? bm.maxTokens
                : (entry.maxTokens || bm?.maxTokens || 16_384);
              return {
                ...(bm ?? {}),
                id: entry.id,
                name: entry.name || bm?.name || entry.id,
                api: resolvedApi,
                baseUrl: preserveBuiltinProtocol ? bm!.baseUrl : (cfg.baseUrl || bm?.baseUrl || effectiveBaseUrl),
                reasoning: effectiveReasoning,
                ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
                input: entry.supportsImages ? ['text', 'image'] : ['text'],
                cost,
                contextWindow: entry.contextWindow || bm?.contextWindow || 128_000,
                maxTokens,
              };
            }),
          });
        }
      } else if (this.overriddenProviders.has(providerId) && baseModels.length > 0 && defaultSample) {
        runtime.registerProvider(providerId, {
          baseUrl: defaultSample.baseUrl,
          api: defaultSample.api,
          models: baseModels.map(m => ({ ...m })),
        });
        this.overriddenProviders.delete(providerId);
      }
      if (effectiveKey) {
        await runtime.setRuntimeApiKey(providerId, effectiveKey);
      } else if (this.explicitSessionKeys.has(providerId)) {
        await runtime.removeRuntimeApiKey(providerId).catch(() => {});
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
    if (routerProvider !== 'offline') {
      const persistedRouterCfg = this.state.providers[routerProvider];
      if (!this.isRouterModelAvailableInProvider(runtime, routerProvider, routerModel, persistedRouterCfg)) {
        const aligned = this.pickDefaultRouterModelForProvider(runtime, routerProvider, persistedRouterCfg);
        if (aligned) {
          routerModel = aligned;
          if (this.state.routerProvider !== undefined || this.state.routerModel !== undefined) {
            this.state.routerModel = aligned;
          }
        }
      }
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

  private isRouterModelAvailableInProvider(
    runtime: ModelRuntime,
    providerId: string,
    modelId: string | undefined,
    persisted?: PersistedProviderConfig,
  ): boolean {
    const clean = modelId?.trim();
    if (!clean) return false;
    if (runtime.getModel(providerId, clean) || getPristineSdkModel(providerId, clean)) return true;
    if (persisted?.customModels?.includes(clean)) return true;
    if (Array.isArray(persisted?.selectedModels) && normalizeSelectedModels(persisted.selectedModels).some(s => s.id === clean)) return true;
    return this.buildProviderCatalogModels(runtime, providerId, persisted).some(m => m.id === clean);
  }

  private pickDefaultRouterModelForProvider(
    runtime: ModelRuntime,
    providerId: string,
    persisted?: PersistedProviderConfig,
  ): string | undefined {
    const catalog = this.buildProviderCatalogModels(runtime, providerId, persisted);
    const sampleDefault = catalog[0]?.id ?? 'default';
    const tiers = buildModelTiers(runtime, providerId, sampleDefault, sampleDefault, {
      hasCustomBaseUrl: Boolean(persisted?.baseUrl),
    });
    if (catalog.some(m => m.id === tiers.balanced)) return tiers.balanced;
    if (catalog.length > 0) return catalog[0]!.id;
    const firstRuntime = runtime.getModels(providerId)[0]?.id;
    if (firstRuntime) return firstRuntime;
    const customFirst = persisted?.customModels?.map(m => m.trim()).find(Boolean);
    if (customFirst) return customFirst;
    const selectedFirst = Array.isArray(persisted?.selectedModels)
      ? normalizeSelectedModels(persisted.selectedModels)[0]?.id
      : undefined;
    return selectedFirst || undefined;
  }

  private resolveCatalogThinkingLevels(
    runtime: ModelRuntime,
    providerId: string,
    modelId: string,
    reasoning: boolean,
  ): ThinkingLevel[] {
    const sdkModel = this.findReferenceModel(runtime, providerId, modelId)
      ?? runtime.getModel(providerId, modelId);
    if (sdkModel) {
      return getNativeThinkingLevels(sdkModel as { reasoning?: boolean; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> });
    }
    if (reasoning && (providerId === 'openai' || providerId === 'openai-codex')) {
      return getNativeThinkingLevels({ reasoning: true, thinkingLevelMap: { off: null, minimal: null } });
    }
    return getNativeThinkingLevels({ reasoning });
  }

  private async resolveDecisionInfo(runtime: ModelRuntime): Promise<{ credentials?: DecisionCredentials; view: DecisionEngineView }> {
    const enabled = this.state.decision?.enabled !== false;
    const baseUrl = this.state.decision?.baseUrl?.trim()
      || resolveEnv('FRIDAY_DECISION_BASE_URL', 'SUPER_AGENT_DECISION_BASE_URL')
      || DEFAULT_GEMINI_DECISION_BASE_URL;
    if (!enabled) {
      return {
        view: {
          model: GEMINI_DECISION_MODEL,
          enabled: false,
          configured: false,
          credentialSource: 'none',
          baseUrl,
        },
      };
    }

    const explicitKey = this.state.decision?.apiKey?.trim();
    const envDecisionKey = resolveEnv('FRIDAY_DECISION_API_KEY', 'SUPER_AGENT_DECISION_API_KEY');
    const googleEnabled = this.isProviderEnabled('google');
    const googleProviderKey = googleEnabled ? await this.resolveProviderApiKey(runtime, 'google') : undefined;
    const envGoogleKey = googleEnabled ? resolveEnv('GEMINI_API_KEY', 'GOOGLE_API_KEY') : undefined;

    let apiKey: string | undefined;
    let credentialSource: DecisionEngineView['credentialSource'] = 'none';
    if (explicitKey) {
      apiKey = explicitKey;
      credentialSource = 'decision_config';
    } else if (envDecisionKey) {
      apiKey = envDecisionKey;
      credentialSource = 'environment';
    } else if (googleProviderKey) {
      apiKey = googleProviderKey;
      credentialSource = 'google_provider';
    } else if (envGoogleKey) {
      apiKey = envGoogleKey;
      credentialSource = 'environment';
    }

    // 离线模式下默认不发外网请求；仅当显式配置了独立 decisionApiKey / decisionBaseUrl（如测试桩）时才启用远端决策请求
    const allowInCurrentMode = this.mode === 'real' || Boolean(explicitKey || this.state.decision?.baseUrl?.trim());
    let safeDecisionUrl = true;
    try {
      assertSafeBaseUrlForCredentials(baseUrl, Boolean(apiKey));
    } catch {
      safeDecisionUrl = false;
    }
    const configured = Boolean(apiKey && allowInCurrentMode && safeDecisionUrl);

    return {
      credentials: configured && apiKey ? { apiKey, baseUrl } : undefined,
      view: {
        model: GEMINI_DECISION_MODEL,
        enabled: true,
        configured,
        credentialSource: configured ? credentialSource : 'none',
        keyHint: configured ? maskKey(apiKey) : undefined,
        baseUrl,
      },
    };
  }

  hasDecisionEngine(): boolean {
    if (this.state.decision?.enabled === false) return false;
    if (this.state.decision?.apiKey?.trim()) return true;
    if (this.mode === 'offline' && !this.state.decision?.baseUrl?.trim()) return false;
    return Boolean(
      resolveEnv('FRIDAY_DECISION_API_KEY', 'SUPER_AGENT_DECISION_API_KEY')
      || (this.isProviderEnabled('google') && (
        this.getEffectiveProviderKey('google').key
        || resolveEnv('GEMINI_API_KEY', 'GOOGLE_API_KEY')
        || this.runtime?.getProviderAuthStatus('google').configured
      )),
    );
  }

  private buildProviderCatalogModels(runtime: ModelRuntime, providerId: string, persisted?: PersistedProviderConfig): ModelCatalogEntry[] {
    const hasRemoteModels = Boolean(persisted?.fetchedModels?.length);
    const rawModels = runtime.getModels(providerId);
    const entries = hasRemoteModels
      ? persisted!.fetchedModels!.map((m): ModelCatalogEntry => {
          if (persisted?.baseUrl) return m;
          const ref = this.findReferenceModel(runtime, providerId, m.id);
          const refIn = ref?.cost?.input ?? 0;
          const refOut = ref?.cost?.output ?? 0;
          let costInput = (m.costInput ?? 0) > 0 ? m.costInput : refIn;
          let costOutput = (m.costOutput ?? 0) > 0 ? m.costOutput : refOut;
          if (costInput <= 0 && costOutput <= 0) {
            const fallback = resolveModelUnitPrice(providerId, m.id);
            if (fallback.source !== 'unknown') {
              costInput = fallback.inputUsdPer1M;
              costOutput = fallback.outputUsdPer1M;
            }
          }
          if (!ref) {
            return { ...m, costInput, costOutput };
          }
          return {
            ...m,
            costInput,
            costOutput,
            maxTokens: (m.maxTokens && !(m.maxTokens === 16_384 && (ref.maxTokens ?? 0) > 16_384))
              ? m.maxTokens
              : (ref.maxTokens ?? m.maxTokens),
          };
        })
      : rawModels.length
        ? rawModels.map((m): ModelCatalogEntry => {
            let costInput = m.cost?.input ?? 0;
            let costOutput = m.cost?.output ?? 0;
            if (!persisted?.baseUrl && costInput <= 0 && costOutput <= 0) {
              const fallback = resolveModelUnitPrice(providerId, m.id);
              if (fallback.source !== 'unknown') {
                costInput = fallback.inputUsdPer1M;
                costOutput = fallback.outputUsdPer1M;
              }
            }
            return {
              id: m.id,
              name: m.name || m.id,
              supportsImages: m.input.includes('image'),
              reasoning: Boolean(m.reasoning),
              contextWindow: m.contextWindow ?? 128_000,
              maxTokens: m.maxTokens ?? 16_384,
              costInput,
              costOutput,
            };
          })
        : (FALLBACK_PROVIDER_MODELS[providerId] ?? []);
    return entries.map(m => ({
      ...m,
      thinkingLevels: m.thinkingLevels?.length
        ? m.thinkingLevels
        : this.resolveCatalogThinkingLevels(runtime, providerId, m.id, m.reasoning),
    }));
  }

  private async rebuildPoolCache(runtime: ModelRuntime): Promise<PooledModelEntry[]> {
    const creds = await runtime.listCredentials();
    const oauthSet = new Set(creds.filter(c => c.type === 'oauth').map(c => c.providerId));
    const providerIds = new Set<string>(FEATURED_PROVIDERS.map(p => p.id));
    for (const id of Object.keys(this.state.providers)) providerIds.add(id);
    for (const id of this.envProviderKeys.keys()) providerIds.add(id);
    if (this.currentTiers.provider && this.currentTiers.provider !== 'offline') providerIds.add(this.currentTiers.provider);
    if (this.currentRouterProvider && this.currentRouterProvider !== 'offline') providerIds.add(this.currentRouterProvider);

    const pool: PooledModelEntry[] = [];
    const catalog: PooledModelEntry[] = [];
    const costs = new Map<string, { costInput: number; costOutput: number }>();
    for (const id of providerIds) {
      const featured = FEATURED_PROVIDERS.find(p => p.id === id);
      const catalogProvider = runtime.getProvider(id);
      const persisted = this.state.providers[id];
      if (persisted?.enabled === false) continue;
      const authStatus = runtime.getProviderAuthStatus(id);
      const hasOAuth = oauthSet.has(id);
      const hasEffectiveKey = Boolean(this.getEffectiveProviderKey(id).key);
      const hasApiKey = Boolean(hasEffectiveKey || authStatus.source === 'runtime' || authStatus.source === 'stored');
      const configured = hasOAuth || hasApiKey || authStatus.configured || Boolean(persisted?.baseUrl);
      if (!configured) continue;

      const providerName = persisted?.name ?? featured?.name ?? catalogProvider?.name ?? id;
      const models = this.buildProviderCatalogModels(runtime, id, persisted);
      const sampleDefault = models[0]?.id ?? 'default';
      const sampleTiers = buildModelTiers(runtime, id, sampleDefault, sampleDefault, {
        hasCustomBaseUrl: Boolean(persisted?.baseUrl),
      });

      const toEntry = (
        m: ModelCatalogEntry,
        tier: ModelTier,
        specialties: string[],
        overrideLevels?: ThinkingLevel[],
      ): PooledModelEntry => {
        const spec = `${id}/${m.id}`;
        const stats = this.state.modelStats?.[spec];
        const nativeLevels = m.thinkingLevels?.length
          ? m.thinkingLevels
          : this.resolveCatalogThinkingLevels(runtime, id, m.id, m.reasoning);
        const filteredLevels = overrideLevels?.length
          ? nativeLevels.filter(lvl => overrideLevels.includes(lvl))
          : nativeLevels;
        const thinkingLevels = filteredLevels.length ? filteredLevels : nativeLevels;
        costs.set(spec, { costInput: m.costInput ?? 0, costOutput: m.costOutput ?? 0 });
        return {
          spec,
          providerId: id,
          providerName,
          modelId: m.id,
          modelName: m.name || m.id,
          tier,
          thinkingLevels,
          specialties,
          supportsImages: m.supportsImages,
          reasoning: m.reasoning,
          contextWindow: m.contextWindow,
          latencyMs: stats?.lastLatencyMs,
          successCount: stats?.successCount,
          failCount: stats ? computeEffectiveFailCount(stats) : undefined,
          avgQualityScore: stats?.avgQualityScore,
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
        thinkingLevels: ['off'],
      };

      for (const m of models) {
        const { tier, specialties } = classifyModelEntry(id, m, sampleTiers);
        catalog.push(toEntry(m, tier, specialties));
      }

      // Worker 模型池：保留各模型的原生思考等级，不锁死人工自定义单一等级
      const added = new Set<string>();
      const addToPool = (modelId: string, overrideLevels?: ThinkingLevel[]) => {
        if (!modelId || added.has(modelId)) return;
        added.add(modelId);
        const m = lookup(modelId);
        const classified = classifyModelEntry(id, m, sampleTiers);
        pool.push(toEntry(m, classified.tier, classified.specialties, overrideLevels));
      };
      for (const sel of persisted?.selectedModels ?? []) {
        const selId = typeof sel === 'string' ? sel : sel?.id;
        const selLevels = typeof sel === 'string' ? undefined : sel?.thinkingLevels;
        if (typeof selId === 'string' && selId.trim()) addToPool(selId.trim(), selLevels);
      }
      const hasExplicitSelection = (persisted?.selectedModels ?? []).some(sel =>
        Boolean((typeof sel === 'string' ? sel : sel?.id)?.trim()),
      );
      if (id === this.currentTiers.provider && !hasExplicitSelection) {
        for (const tierName of ['balanced', 'strong', 'fast'] as const) addToPool(this.currentTiers[tierName]);
      }
    }
    this.cachedCatalog = catalog;
    this.cachedPool = pool;
    this.cachedCosts = costs;
    return pool;
  }

  getModelPool(): PooledModelEntry[] {
    return this.cachedPool;
  }

  recordTaskOutcome(workerModel: string | undefined, ok: boolean, durationMs?: number, qualityScore?: number): void {
    if (!workerModel) return;
    const rawSpec = splitModelAndLevel(workerModel).model;
    if (!rawSpec) return;
    const poolHit = this.cachedPool.find(item => item.spec === rawSpec || item.modelId === rawSpec);
    const spec = poolHit
      ? poolHit.spec
      : parseModelSpec(rawSpec, {
          fallbackProvider: this.currentTiers.provider,
          knownProviders: this.getKnownProviders(),
        }).spec;
    const now = Date.now();
    const stats = this.state.modelStats ?? (this.state.modelStats = {});
    const prev = stats[spec] ?? { successCount: 0, failCount: 0, updatedAt: now };
    const decayedPrevFail = computeEffectiveFailCount(prev, now);
    let qualityScoreSum = prev.qualityScoreSum ?? 0;
    let qualityCount = prev.qualityCount ?? 0;
    if (typeof qualityScore === 'number' && Number.isFinite(qualityScore)) {
      qualityScoreSum += Math.max(0, Math.min(3, qualityScore));
      qualityCount += 1;
    }
    const avgQualityScore = qualityCount > 0
      ? Number((qualityScoreSum / qualityCount).toFixed(2))
      : prev.avgQualityScore;
    const updated: ModelEffectStats = {
      ...prev,
      successCount: prev.successCount + (ok ? 1 : 0),
      failCount: ok ? decayedPrevFail : decayedPrevFail + 1,
      ...(durationMs && durationMs > 0 ? { lastLatencyMs: Math.round(durationMs) } : {}),
      ...(qualityCount > 0 ? { qualityScoreSum: Number(qualityScoreSum.toFixed(2)), qualityCount, avgQualityScore } : {}),
      updatedAt: now,
    };
    stats[spec] = updated;
    const poolEntry = this.cachedPool.find(item => item.spec === spec);
    if (poolEntry) {
      poolEntry.successCount = updated.successCount;
      poolEntry.failCount = updated.failCount;
      if (updated.lastLatencyMs) poolEntry.latencyMs = updated.lastLatencyMs;
      if (updated.avgQualityScore !== undefined) poolEntry.avgQualityScore = updated.avgQualityScore;
    }
    void this.saveState().catch(() => {});
  }

  async syncDecisionEraStats(tasks: readonly DecisionEraTaskRecord[]): Promise<void> {
    if (this.state.statsEpoch === DECISION_STATS_EPOCH) return;
    const nextStats = accumulateDecisionEraStats(tasks, this.cachedPool, this.currentTiers.provider);
    this.state.modelStats = nextStats;
    this.state.statsEpoch = DECISION_STATS_EPOCH;
    for (const entry of [...this.cachedPool, ...this.cachedCatalog]) {
      const st = nextStats[entry.spec];
      entry.successCount = st?.successCount;
      entry.failCount = st ? computeEffectiveFailCount(st) : undefined;
      entry.latencyMs = st?.lastLatencyMs;
      entry.avgQualityScore = st?.avgQualityScore;
    }
    await this.saveState();
  }

  private validateExplicitModel(rawModelInput: string): {
    poolEntry?: PooledModelEntry;
    spec: string;
    explicitLevel?: ThinkingLevel;
  } {
    const { model: rawModel, explicitLevel } = splitModelAndLevel(rawModelInput);
    const directPoolHit = this.cachedPool.find(p => p.spec === rawModel || p.modelId === rawModel);
    if (directPoolHit) {
      const readyProviders = new Set(this.cachedPool.map(p => p.providerId));
      const useQualifiedSpec = readyProviders.size > 1
        || directPoolHit.providerId !== this.currentTiers.provider
        || directPoolHit.modelId.includes('/');
      return {
        poolEntry: directPoolHit,
        spec: useQualifiedSpec ? directPoolHit.spec : directPoolHit.modelId,
        explicitLevel,
      };
    }
    if (rawModel.includes('/')) {
      const parsed = parseModelSpec(rawModel, {
        fallbackProvider: this.currentTiers.provider,
        knownProviders: this.getKnownProviders(),
      });
      const explicitProv = parsed.providerId !== 'unknown' ? parsed.providerId : undefined;
      if (explicitProv && !this.isProviderEnabled(explicitProv)) {
        throw new Error(`提供方 "${explicitProv}" 已禁用，无法调用模型 "${rawModel}"`);
      }
      const entry = this.cachedPool.find(p => p.spec === rawModel || p.spec === parsed.spec);
      if (!entry && this.cachedPool.length > 0) throw formatModelNotInPoolError(rawModel, this.cachedPool);
      return { poolEntry: entry, spec: parsed.spec, explicitLevel };
    }
    const poolHit = this.cachedPool.find(p => p.modelId === rawModel);
    if (poolHit) {
      const readyProviders = new Set(this.cachedPool.map(p => p.providerId));
      return {
        poolEntry: poolHit,
        spec: readyProviders.size > 1 ? poolHit.spec : poolHit.modelId,
        explicitLevel,
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
    if (this.cachedPool.length > 0) throw formatModelNotInPoolError(rawModel, this.cachedPool);
    return { spec: rawModel, explicitLevel };
  }

  selectWorkerModel(input: WorkerModelResolutionInput): { model: string; tier: ModelTier; thinkingLevel: ThinkingLevel } {
    const rawModel = input.model?.trim();
    const isTierAlias = Boolean(rawModel && MODEL_TIER_VALUES.includes(rawModel as ModelTier));

    if (rawModel && !isTierAlias) {
      const { poolEntry, spec, explicitLevel } = this.validateExplicitModel(rawModel);
      if (poolEntry) {
        const picked = selectHeuristicRoute(toDecisionCandidates([poolEntry], this.cachedCosts), {
          instruction: input.instruction ?? '',
          contextBrief: input.contextBrief,
          profile: input.profile,
          fileCount: input.fileCount,
          hasImages: input.hasImages,
          isTimer: input.isTimer,
          preferredLevel: explicitLevel ?? input.thinkingLevel ?? tierToPreferredThinkingLevel(input.tier),
        });
        return {
          model: spec,
          tier: poolEntry.tier,
          thinkingLevel: explicitLevel ?? picked.thinkingLevel,
        };
      }
      const fallback = resolveWorkerModelFromTiers(this.currentTiers, { ...input, model: spec });
      return {
        model: fallback.model,
        tier: fallback.tier,
        thinkingLevel: explicitLevel ?? input.thinkingLevel ?? tierToPreferredThinkingLevel(fallback.tier) ?? 'medium',
      };
    }

    if (this.cachedPool.length === 0) {
      if (!this.isProviderEnabled(this.currentTiers.provider)) {
        throw new Error(`提供方 "${this.currentTiers.provider}" 已禁用，当前无可用模型提供方`);
      }
      const resolved = resolveWorkerModelFromTiers(this.currentTiers, input);
      return {
        model: resolved.model,
        tier: resolved.tier,
        thinkingLevel: input.thinkingLevel ?? tierToPreferredThinkingLevel(resolved.tier) ?? 'medium',
      };
    }

    const preferredTier = input.tier ?? (isTierAlias ? rawModel as ModelTier : undefined);
    const heuristic = selectHeuristicRoute(toDecisionCandidates(this.cachedPool, this.cachedCosts), {
      instruction: input.instruction ?? '',
      contextBrief: input.contextBrief,
      profile: input.profile,
      fileCount: input.fileCount,
      hasImages: input.hasImages,
      isTimer: input.isTimer,
      preferredLevel: input.thinkingLevel ?? tierToPreferredThinkingLevel(preferredTier),
      excludedSpecs: input.excludedSpecs,
      excludedProviders: input.excludedProviders,
    });
    const readyProviders = new Set(this.cachedPool.map(p => p.providerId));
    const useQualifiedSpec = readyProviders.size > 1
      || heuristic.candidate.providerId !== this.currentTiers.provider
      || heuristic.candidate.modelId.includes('/');
    return {
      model: useQualifiedSpec ? heuristic.candidate.spec : heuristic.candidate.modelId,
      tier: thinkingLevelToTier(heuristic.thinkingLevel),
      thinkingLevel: heuristic.thinkingLevel,
    };
  }

  async decideWorkerModel(input: WorkerModelResolutionInput): Promise<{
    model: string;
    thinkingLevel: ThinkingLevel;
    tier: ModelTier;
    confidence?: number;
    needsQualityGate?: boolean;
    needsQualityGateProb?: number;
    source: DecisionSource;
    attempted: boolean;
    usage?: { inputTokens: number; outputTokens?: number; totalTokens: number };
    fallbackReason?: string;
  }> {
    const runtime = await this.ensureRuntime();
    const { credentials } = await this.resolveDecisionInfo(runtime);
    const rawModel = input.model?.trim();
    const isTierAlias = Boolean(rawModel && MODEL_TIER_VALUES.includes(rawModel as ModelTier));

    if (rawModel && !isTierAlias) {
      const { poolEntry, spec, explicitLevel } = this.validateExplicitModel(rawModel);
      if (explicitLevel) {
        const clamped = poolEntry
          ? clampNativeThinkingLevel(poolEntry.thinkingLevels, explicitLevel)
          : explicitLevel;
        return {
          model: spec,
          thinkingLevel: clamped,
          tier: poolEntry?.tier ?? thinkingLevelToTier(clamped),
          source: 'heuristic',
          attempted: false,
        };
      }
      if (poolEntry) {
        const picked = await decideWorkerRoute(
          toDecisionCandidates([poolEntry], this.cachedCosts),
          {
            instruction: input.instruction ?? '',
            contextBrief: input.contextBrief,
            profile: input.profile,
            fileCount: input.fileCount,
            hasImages: input.hasImages,
            isTimer: input.isTimer,
            preferredLevel: input.thinkingLevel ?? tierToPreferredThinkingLevel(input.tier),
          },
          credentials,
        );
        this.emitDecisionUsage(picked.usage);
        return {
          model: spec,
          thinkingLevel: picked.thinkingLevel,
          tier: poolEntry.tier,
          confidence: picked.confidence,
          needsQualityGate: picked.needsQualityGate,
          needsQualityGateProb: picked.needsQualityGateProb,
          source: picked.source,
          attempted: picked.attempted,
          usage: picked.usage,
          fallbackReason: picked.fallbackReason,
        };
      }
      const fallback = resolveWorkerModelFromTiers(this.currentTiers, { ...input, model: spec });
      const level = input.thinkingLevel ?? tierToPreferredThinkingLevel(fallback.tier) ?? 'medium';
      return {
        model: fallback.model,
        thinkingLevel: level,
        tier: fallback.tier,
        source: 'heuristic',
        attempted: false,
      };
    }

    if (this.cachedPool.length === 0) {
      if (!this.isProviderEnabled(this.currentTiers.provider)) {
        throw new Error(`提供方 "${this.currentTiers.provider}" 已禁用，当前无可用模型提供方`);
      }
      const resolved = resolveWorkerModelFromTiers(this.currentTiers, input);
      const level = input.thinkingLevel ?? tierToPreferredThinkingLevel(resolved.tier) ?? 'medium';
      return {
        model: resolved.model,
        thinkingLevel: level,
        tier: resolved.tier,
        source: 'heuristic',
        attempted: false,
      };
    }

    const preferredTier = input.tier ?? (isTierAlias ? rawModel as ModelTier : undefined);
    const picked = await decideWorkerRoute(
      toDecisionCandidates(this.cachedPool, this.cachedCosts),
      {
        instruction: input.instruction ?? '',
        contextBrief: input.contextBrief,
        profile: input.profile,
        fileCount: input.fileCount,
        hasImages: input.hasImages,
        isTimer: input.isTimer,
        preferredLevel: input.thinkingLevel ?? tierToPreferredThinkingLevel(preferredTier),
        excludedSpecs: input.excludedSpecs,
        excludedProviders: input.excludedProviders,
      },
      credentials,
    );
    this.emitDecisionUsage(picked.usage);
    const readyProviders = new Set(this.cachedPool.map(p => p.providerId));
    const useQualifiedSpec = readyProviders.size > 1
      || picked.providerId !== this.currentTiers.provider
      || picked.modelId.includes('/');
    return {
      model: useQualifiedSpec ? picked.spec : picked.modelId,
      thinkingLevel: picked.thinkingLevel,
      tier: thinkingLevelToTier(picked.thinkingLevel),
      confidence: picked.confidence,
      needsQualityGate: picked.needsQualityGate,
      needsQualityGateProb: picked.needsQualityGateProb,
      source: picked.source,
      attempted: picked.attempted,
      usage: picked.usage,
      fallbackReason: picked.fallbackReason,
    };
  }

  async evaluateCompletion(input: CompletionEvaluationInput): Promise<CompletionEvaluationResult> {
    const runtime = await this.ensureRuntime();
    const { credentials } = await this.resolveDecisionInfo(runtime);
    const res = await evaluateWorkCompletion(input, credentials);
    this.emitDecisionUsage(res.usage);
    return res;
  }

  async decideSessionContinuity(input: SessionContinuityInput): Promise<SessionContinuityResult> {
    const runtime = await this.ensureRuntime();
    const { credentials } = await this.resolveDecisionInfo(runtime);
    const res = await evaluateSessionContinuity(input, credentials);
    this.emitDecisionUsage(res.usage);
    return res;
  }

  private saveState(): Promise<void> {
    if (this.closed) return this.saveQueue;
    const run = this.saveQueue.then(async () => {
      if (this.closed) return;
      await mkdir(this.sdkDir, { recursive: true, mode: 0o700 });
      const tmpPath = `${this.statePath}.${randomUUID()}.tmp`;
      const payload = JSON.stringify(this.state, null, 2);
      try {
        await writeFile(tmpPath, payload, { mode: 0o600 });
        await chmod(tmpPath, 0o600).catch(() => {});
        await rename(tmpPath, this.statePath);
      } catch (err) {
        await rm(tmpPath, { force: true }).catch(() => {});
        throw err;
      }
    });
    // Swallowing rejection on the tail chain prevents one I/O error from wedging future saves
    this.saveQueue = run.catch(() => {});
    return run;
  }

  /** Wait for all queued model-hub state writes to settle. */
  async flush(): Promise<void> {
    await this.saveQueue.catch(() => {});
  }

  /** Drain pending writes and prevent late background saves during teardown. */
  async close(): Promise<void> {
    await this.runtimePromise?.catch(() => {});
    await this.saveQueue.catch(() => {});
    this.closed = true;
    await this.saveQueue.catch(() => {});
  }

  async getView(): Promise<ModelHubView> {
    const runtime = await this.ensureRuntime();
    const creds = await runtime.listCredentials();
    const oauthSet = new Set(creds.filter(c => c.type === 'oauth').map(c => c.providerId));

    const providerIds = new Set<string>(FEATURED_PROVIDERS.map(p => p.id));
    for (const id of Object.keys(this.state.providers)) providerIds.add(id);
    for (const id of this.envProviderKeys.keys()) providerIds.add(id);
    if (this.currentTiers.provider && this.currentTiers.provider !== 'offline') providerIds.add(this.currentTiers.provider);
    if (this.currentRouterProvider && this.currentRouterProvider !== 'offline') providerIds.add(this.currentRouterProvider);

    const providers: ModelProviderView[] = [];
    for (const id of providerIds) {
      const featured = FEATURED_PROVIDERS.find(p => p.id === id);
      const catalogProvider = runtime.getProvider(id);
      const persisted = this.state.providers[id];
      const authStatus = runtime.getProviderAuthStatus(id);
      const hasOAuth = oauthSet.has(id);
      const effectiveKeyInfo = this.getEffectiveProviderKey(id);
      const hasPersistedOrRuntimeKey = effectiveKeyInfo.source === 'persisted'
        || authStatus.source === 'stored'
        || (!effectiveKeyInfo.key && authStatus.source === 'runtime');
      const authType: ModelProviderView['authType'] = hasOAuth
        ? 'oauth'
        : effectiveKeyInfo.source === 'persisted'
          ? 'api_key'
          : effectiveKeyInfo.source === 'environment'
            ? 'environment'
            : hasPersistedOrRuntimeKey
              ? 'api_key'
              : authStatus.configured
                ? 'environment'
                : 'none';
      const configured = authType !== 'none' || Boolean(persisted?.baseUrl);
      const hasRemoteModels = Boolean(persisted?.fetchedModels?.length);
      const models = this.buildProviderCatalogModels(runtime, id, persisted);
      const sampleDefault = models[0]?.id ?? 'default';
      const sampleTiers = buildModelTiers(runtime, id, sampleDefault, sampleDefault, {
        hasCustomBaseUrl: Boolean(persisted?.baseUrl),
      });
      const selectedEntries = (persisted?.selectedModels ?? [])
        .map(sel => (typeof sel === 'string'
          ? { id: sel }
          : { id: sel.id, ...(sel.thinkingLevels?.length ? { thinkingLevels: sel.thinkingLevels } : {}) }))
        .filter(sel => typeof sel.id === 'string' && Boolean(sel.id));
      providers.push({
        id,
        name: persisted?.name ?? featured?.name ?? catalogProvider?.name ?? id,
        enabled: persisted?.enabled !== false,
        configured,
        authType,
        keyHint: maskKey(effectiveKeyInfo.key),
        baseUrl: persisted?.baseUrl,
        supportsOAuth: Boolean(catalogProvider?.auth?.oauth),
        modelSource: hasRemoteModels ? 'remote_api' : 'sdk_catalog',
        modelsFetchedAt: persisted?.modelsFetchedAt,
        fetchError: sanitizeCredentialLeakText(persisted?.fetchError, [effectiveKeyInfo.key]),
        defaultFast: sampleTiers.fast,
        defaultBalanced: sampleTiers.balanced,
        defaultStrong: sampleTiers.strong,
        models,
        selectedModels: selectedEntries,
        suggestedTiers: Object.fromEntries(models.map(m => [m.id, classifyModelEntry(id, m, sampleTiers).tier])),
      });
    }

    await this.rebuildPoolCache(runtime);
    const { view: decisionEngine } = await this.resolveDecisionInfo(runtime);

    return {
      mode: this.mode,
      routerProvider: this.currentRouterProvider,
      routerModel: this.currentTiers.router,
      workerProvider: this.currentTiers.provider,
      tiers: this.currentTiers,
      providers,
      modelPool: this.cachedPool,
      decisionEngine,
      lastProbe: this.state.lastProbe,
    };
  }

  async configure(input: ModelHubConfigureInput): Promise<ModelHubView> {
    const runtime = await this.ensureRuntime();
    let nextDecision: PersistedDecisionConfig | undefined = this.state.decision
      ? { ...this.state.decision }
      : undefined;
    if (
      input.decisionEnabled !== undefined
      || input.decisionApiKey !== undefined
      || input.clearDecisionApiKey
      || input.decisionBaseUrl !== undefined
    ) {
      nextDecision = { ...(this.state.decision ?? {}) };
      if (input.decisionEnabled !== undefined) {
        nextDecision.enabled = Boolean(input.decisionEnabled);
      }
      if (input.clearDecisionApiKey) {
        delete nextDecision.apiKey;
      } else if (input.decisionApiKey !== undefined && input.decisionApiKey.trim()) {
        nextDecision.apiKey = input.decisionApiKey.trim();
      }
      if (input.decisionBaseUrl !== undefined) {
        const trimmedUrl = input.decisionBaseUrl.trim();
        if (trimmedUrl) {
          assertSafeBaseUrlForCredentials(
            trimmedUrl,
            Boolean(nextDecision.apiKey || resolveEnv('FRIDAY_DECISION_API_KEY', 'SUPER_AGENT_DECISION_API_KEY') || this.getEffectiveProviderKey('google').key),
          );
          nextDecision.baseUrl = trimmedUrl;
        } else {
          delete nextDecision.baseUrl;
        }
      } else if (nextDecision.baseUrl && nextDecision.apiKey) {
        assertSafeBaseUrlForCredentials(nextDecision.baseUrl, true);
      }
    }

    const nextProviders: Record<string, PersistedProviderConfig> = { ...this.state.providers };
    const targetProvider = normalizeProviderId(input.providerId);
    let nextProviderEntry: PersistedProviderConfig | undefined;
    let shouldClearRuntimeKey = false;
    let baseUrlModified = false;

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
        shouldClearRuntimeKey = true;
      } else if (input.apiKey !== undefined && input.apiKey.trim()) {
        next.apiKey = input.apiKey.trim();
      }
      if (input.baseUrl !== undefined) {
        const trimmedUrl = input.baseUrl.trim();
        const effectiveNextKey = input.clearApiKey
          ? undefined
          : (next.apiKey || this.envProviderKeys.get(targetProvider));
        if (trimmedUrl) {
          assertSafeBaseUrlForCredentials(trimmedUrl, Boolean(effectiveNextKey));
          next.baseUrl = trimmedUrl;
        } else {
          delete next.baseUrl;
        }
        if ((next.baseUrl ?? '') !== (prev.baseUrl ?? '')) {
          baseUrlModified = true;
          delete next.fetchedModels;
          delete next.modelsFetchedAt;
          delete next.fetchError;
        }
      } else if (next.baseUrl && next.apiKey) {
        assertSafeBaseUrlForCredentials(next.baseUrl, true);
      }
      if (Array.isArray(input.customModels)) {
        next.customModels = input.customModels.map(m => m.trim()).filter(Boolean);
      }
      if (input.selectedModels !== undefined) {
        const selected = normalizeSelectedModels(input.selectedModels);
        if (selected.length) next.selectedModels = selected;
        else delete next.selectedModels;
      }
      nextProviders[targetProvider] = next;
      nextProviderEntry = next;
    }

    const isPendingProviderEnabled = (providerId: string): boolean => nextProviders[providerId]?.enabled !== false;

    let nextWorkerProvider = this.state.workerProvider;
    let nextCurrentWorkerProvider = this.currentTiers.provider;
    let clearWorkerTierModels = false;
    if (input.workerProvider !== undefined && input.workerProvider.trim()) {
      const candidateWorkerProv = normalizeProviderId(input.workerProvider)!;
      if (!isPendingProviderEnabled(candidateWorkerProv)) {
        throw new Error(`提供方 "${candidateWorkerProv}" 已禁用，无法设为 Worker 提供方；请先启用该提供方`);
      }
      const switchedProvider = candidateWorkerProv !== this.currentTiers.provider;
      nextWorkerProvider = candidateWorkerProv;
      nextCurrentWorkerProvider = candidateWorkerProv;
      if (switchedProvider && input.fastModel === undefined && input.balancedModel === undefined && input.strongModel === undefined) {
        clearWorkerTierModels = true;
      }
    }

    let nextRouterProvider = normalizeProviderId(this.state.routerProvider) ?? this.currentRouterProvider;
    let explicitRouterProvider = false;
    if (input.routerProvider !== undefined && input.routerProvider.trim()) {
      const candidateRouterProv = normalizeProviderId(input.routerProvider)!;
      if (!isPendingProviderEnabled(candidateRouterProv)) {
        throw new Error(`提供方 "${candidateRouterProv}" 已禁用，无法设为 F.R.I.D.A.Y. 主控提供方；请先启用该提供方`);
      }
      nextRouterProvider = candidateRouterProv;
      explicitRouterProvider = true;
    }

    let nextRouterModel = this.state.routerModel;
    let routerModelAligned = false;
    if (input.routerModel !== undefined && input.routerModel.trim()) {
      const rawRouter = input.routerModel.trim();
      const parsedRouter = parseModelSpec(rawRouter, {
        fallbackProvider: nextRouterProvider,
        preferFallbackProvider: explicitRouterProvider,
        knownProviders: getKnownProviderIds([
          ...this.getKnownProviders(),
          ...Object.keys(nextProviders),
        ]),
      });
      const resolvedProv = parsedRouter.providerId !== 'unknown' ? parsedRouter.providerId : nextRouterProvider;
      if (resolvedProv && !isPendingProviderEnabled(resolvedProv)) {
        throw new Error(`提供方 "${resolvedProv}" 已禁用，无法设为 F.R.I.D.A.Y. 主控模型；请先启用该提供方`);
      }
      if (resolvedProv && resolvedProv !== 'offline') {
        const pendingCfg = nextProviders[resolvedProv];
        const available = this.isRouterModelAvailableInProvider(runtime, resolvedProv, parsedRouter.modelId, pendingCfg);
        if (!available && !pendingCfg?.baseUrl) {
          throw new Error(`在提供方 "${resolvedProv}" 目录中未找到主控模型 "${parsedRouter.modelId}"`);
        }
      }
      nextRouterProvider = resolvedProv;
      nextRouterModel = parsedRouter.modelId;
    } else if (explicitRouterProvider && nextRouterProvider !== 'offline') {
      const pendingCfg = nextProviders[nextRouterProvider];
      const currentCandidate = nextRouterModel ?? this.currentTiers.router;
      if (!this.isRouterModelAvailableInProvider(runtime, nextRouterProvider, currentCandidate, pendingCfg)) {
        const aligned = this.pickDefaultRouterModelForProvider(runtime, nextRouterProvider, pendingCfg);
        if (!aligned) {
          throw new Error(`提供方 "${nextRouterProvider}" 当前没有可用的主控模型，请先配置模型或拉取模型列表`);
        }
        nextRouterModel = aligned;
        routerModelAligned = true;
      }
    }

    // Commit validated changes atomically to memory before syncing / persisting.
    this.state.decision = nextDecision;
    this.state.providers = nextProviders;
    if (targetProvider) {
      if (input.clearApiKey || (input.apiKey !== undefined && input.apiKey.trim())) {
        this.explicitSessionKeys.add(targetProvider);
      }
      if (shouldClearRuntimeKey) {
        await runtime.removeRuntimeApiKey(targetProvider).catch(() => {});
      }
      if (baseUrlModified && shouldClearRuntimeKey === false) {
        // Ensure stale runtime override is cleared if baseUrl changed without sync
        this.overriddenProviders.add(targetProvider);
      }
      if (this.mode === 'real' && nextProviderEntry?.enabled !== false && !input.clearApiKey) {
        const effKey = this.getEffectiveProviderKey(targetProvider).key;
        if (effKey || nextProviderEntry?.baseUrl) {
          await this.syncProviderModelsFromApi(runtime, targetProvider).catch(() => {});
        }
      }
    }
    this.state.workerProvider = nextWorkerProvider;
    this.currentTiers.provider = nextCurrentWorkerProvider;
    if (clearWorkerTierModels) {
      delete this.state.fastModel;
      delete this.state.balancedModel;
      delete this.state.strongModel;
    }
    if ((input.routerProvider !== undefined && input.routerProvider.trim()) || (input.routerModel !== undefined && input.routerModel.trim())) {
      this.state.routerProvider = nextRouterProvider;
      this.currentRouterProvider = nextRouterProvider;
    }
    if ((input.routerModel !== undefined && input.routerModel.trim()) || routerModelAligned) {
      this.state.routerModel = nextRouterModel;
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
    const hasExplicitProvider = Boolean(input.provider?.trim());
    const parsedProbe = parseModelSpec(input.model, {
      fallbackProvider: hasExplicitProvider ? input.provider : this.currentTiers.provider,
      preferFallbackProvider: hasExplicitProvider,
      knownProviders: this.getKnownProviders(),
    });
    let provider = parsedProbe.providerId;
    const modelId = parsedProbe.modelId;
    if (!hasExplicitProvider && !input.model.includes('/') && (provider === 'offline' || (!runtime.getModel(provider, modelId) && runtime.getModel('deepseek', modelId)))) {
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
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return {
          ok: false, provider, model: modelId, mode: 'real', latencyMs: 1,
          supportsImages: false, error: `Base URL 必须使用 http 或 https: ${inlineBaseUrl}`, testedAt: Date.now(),
        };
      }
    }

    const baseModel = this.findReferenceModel(runtime, provider, modelId);
    const runtimeModel = runtime.getModel(provider, modelId) ?? baseModel;
    const fallbackCatalogEntry = FALLBACK_PROVIDER_MODELS[provider]?.find(m => m.id === modelId);

    // Clone into a probe-local descriptor so live runtime state is never mutated during probe.
    type RuntimeModelType = NonNullable<ReturnType<ModelRuntime['getModel']>>;
    type ProbeRuntimeModel = RuntimeModelType & { thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> };
    let probeModel: ProbeRuntimeModel | undefined;
    if (inlineBaseUrl) {
      const preserveBuiltinProtocol = Boolean(baseModel && isOfficialOpenCodeUrl(provider, inlineBaseUrl));
      const sourceInput = runtimeModel?.input ?? (fallbackCatalogEntry?.supportsImages ? ['text', 'image'] : ['text']);
      probeModel = {
        ...(runtimeModel ?? {}),
        id: modelId,
        name: runtimeModel?.name ?? fallbackCatalogEntry?.name ?? modelId,
        provider,
        api: preserveBuiltinProtocol ? baseModel!.api : 'openai-completions',
        baseUrl: preserveBuiltinProtocol ? baseModel!.baseUrl : inlineBaseUrl,
        reasoning: Boolean(runtimeModel?.reasoning ?? fallbackCatalogEntry?.reasoning),
        input: sourceInput.includes('image') ? ['text', 'image'] : ['text'],
        cost: runtimeModel?.cost ?? {
          input: fallbackCatalogEntry?.costInput ?? 0,
          output: fallbackCatalogEntry?.costOutput ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: runtimeModel?.contextWindow ?? fallbackCatalogEntry?.contextWindow ?? 128_000,
        maxTokens: runtimeModel?.maxTokens ?? fallbackCatalogEntry?.maxTokens ?? 16_384,
      } as ProbeRuntimeModel;
    } else if (runtimeModel) {
      probeModel = { ...runtimeModel } as ProbeRuntimeModel;
    }
    if (
      probeModel?.reasoning
      && !probeModel.thinkingLevelMap
      && (probeModel.api === 'openai-responses' || probeModel.api === 'openai-codex-responses')
    ) {
      probeModel.thinkingLevelMap = { off: null, minimal: null };
    }

    const supportsImages = Boolean(probeModel?.input.includes('image'));
    const contextWindow = probeModel?.contextWindow;

    const creds = await runtime.listCredentials();
    const hasOAuth = creds.some(c => c.type === 'oauth' && c.providerId === provider);
    const authStatus = runtime.getProviderAuthStatus(provider);
    const hasPersistedKey = Boolean(this.getEffectiveProviderKey(provider).key);
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

    if (!probeModel) {
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

    let resolvedKey: string | undefined;
    try {
      const promptText = input.prompt?.trim() || '请用简短一句话回复：确认你的模型名称并报告连接正常。';
      const probeSessionId = randomUUID();
      const openCodeHeaders = isOpenCodeProvider(provider, probeModel.baseUrl)
        ? { 'x-opencode-session': probeSessionId, 'x-opencode-client': 'pi' }
        : undefined;
      const allowStoredKey = !inlineBaseUrl || this.isSameOriginInlineBaseUrl(runtime, provider, inlineBaseUrl);
      resolvedKey = inlineApiKey ?? (allowStoredKey ? await this.resolveProviderApiKey(runtime, provider) : undefined);
      assertSafeBaseUrlForCredentials(inlineBaseUrl ?? probeModel.baseUrl, Boolean(resolvedKey));
      // Use an isolated runtime if this provider isn't registered on the live runtime yet.
      let callRuntime = runtime;
      if (!runtime.getProvider(provider) || inlineBaseUrl) {
        callRuntime = await ModelRuntime.create({
          authPath: join(this.sdkDir, 'auth.json'),
          modelsPath: null,
          modelsStorePath: join(this.sdkDir, 'models-cache.json'),
          refreshOnCreate: false,
        });
        callRuntime.registerProvider(provider, {
          baseUrl: probeModel.baseUrl,
          api: probeModel.api,
          ...(resolvedKey ? { apiKey: resolvedKey } : {}),
          models: [probeModel],
        });
      }
      const probeLevels = getNativeThinkingLevels(probeModel);
      const pickedLevel = probeModel.reasoning && !probeLevels.includes('off')
        ? clampNativeThinkingLevel(probeLevels, 'low')
        : undefined;
      const probeReasoning: Exclude<ThinkingLevel, 'off'> | undefined =
        pickedLevel && pickedLevel !== 'off' ? pickedLevel : undefined;
      const runProbe = (reasoning?: Exclude<ThinkingLevel, 'off'>) => callRuntime.completeSimple(
        probeModel!,
        {
          systemPrompt: 'You are F.R.I.D.A.Y. (also known as Friday / 星期五) running a quick connectivity probe. Address the human as "老板" and reply in 1 short sentence in Simplified Chinese.',
          messages: [{ role: 'user', content: promptText, timestamp: Date.now() }],
        },
        {
          maxTokens: probeModel!.reasoning ? 1024 : 512,
          ...(reasoning ? { reasoning } : {}),
          sessionId: probeSessionId,
          ...(openCodeHeaders ? { headers: openCodeHeaders } : {}),
          ...(resolvedKey ? { apiKey: resolvedKey } : {}),
          signal: AbortSignal.timeout(15_000),
        },
      );
      let res = await runProbe(probeReasoning);
      if (
        res.stopReason === 'error'
        && probeModel.reasoning
        && probeReasoning !== 'low'
        && /reasoning\.effort|unsupported_value.*'none'/i.test(res.errorMessage ?? '')
      ) {
        if (res.usage && res.usage.totalTokens > 0) {
          this.emitUsage({
            actor: 'probe',
            provider,
            model: modelId,
            status: 'failed',
            usage: res.usage,
          });
        }
        res = await runProbe('low');
      }
      const latencyMs = Math.max(1, Date.now() - start);
      if (res.usage) {
        this.emitUsage({
          actor: 'probe',
          provider,
          model: modelId,
          status: res.stopReason === 'error' ? 'failed' : res.stopReason === 'aborted' ? 'interrupted' : 'completed',
          usage: res.usage,
        });
      }
      if (res.stopReason === 'error' || res.stopReason === 'aborted') {
        const rawErr = res.errorMessage?.trim() || `模型请求返回状态: ${res.stopReason}`;
        const safeErr = sanitizeCredentialLeakText(rawErr, [resolvedKey, inlineApiKey]) ?? rawErr;
        const result: ModelProbeResult = {
          ok: false,
          provider,
          model: modelId,
          mode: 'real',
          latencyMs,
          supportsImages,
          contextWindow,
          error: safeErr,
          testedAt: Date.now(),
        };
        if (res.stopReason === 'error') {
          this.recordProbeStats(`${provider}/${modelId}`, false, latencyMs);
        }
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
      const rawErr = error instanceof Error ? error.message : String(error);
      const safeErr = sanitizeCredentialLeakText(rawErr, [resolvedKey, inlineApiKey]) ?? rawErr;
      const result: ModelProbeResult = {
        ok: false,
        provider,
        model: modelId,
        mode: 'real',
        latencyMs,
        supportsImages,
        contextWindow,
        error: safeErr,
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
      ...(ok ? { failCount: 0 } : {}),
      lastLatencyMs: latencyMs,
      lastProbeOk: ok,
      updatedAt: Date.now(),
    };
    const poolEntry = this.cachedPool.find(item => item.spec === spec);
    if (poolEntry) {
      poolEntry.latencyMs = latencyMs;
      if (ok) poolEntry.failCount = 0;
    }
  }
}

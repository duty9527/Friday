import { randomUUID } from 'node:crypto';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ModelCatalogEntry } from '../view.js';
import {
  assertSafeBaseUrlForCredentials,
  DEFAULT_PROVIDER_ENDPOINTS,
  getPristineSdkModel,
  isOpenCodeProvider,
  sanitizeCredentialLeakText,
} from './catalog.js';
import { resolveModelUnitPrice } from './pricing.js';

interface RemoteModelPricing {
  prompt?: string | number;
  completion?: string | number;
  input_cache_read?: string | number;
  input_cache_write?: string | number;
}

function parsePerTokenRateToPer1M(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) return undefined;
  return Number((num * 1_000_000).toFixed(6));
}

function resolveDiscoveryCost(
  providerId: string,
  modelId: string,
  baseModel?: { cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } },
  remotePricing?: RemoteModelPricing,
): { costInput: number; costOutput: number; costCacheRead?: number; costCacheWrite?: number } {
  const remoteIn = parsePerTokenRateToPer1M(remotePricing?.prompt);
  const remoteOut = parsePerTokenRateToPer1M(remotePricing?.completion);
  const remoteCr = parsePerTokenRateToPer1M(remotePricing?.input_cache_read);
  const remoteCw = parsePerTokenRateToPer1M(remotePricing?.input_cache_write);
  if (remoteIn !== undefined && remoteOut !== undefined && (remoteIn > 0 || remoteOut > 0 || (remoteIn === 0 && remoteOut === 0 && /(?::free|-free)$/i.test(modelId)))) {
    const resolved = resolveModelUnitPrice(providerId, modelId, {
      costInput: remoteIn,
      costOutput: remoteOut,
      ...(remoteCr !== undefined && remoteCr > 0 ? { costCacheRead: remoteCr } : {}),
      ...(remoteCw !== undefined && remoteCw > 0 ? { costCacheWrite: remoteCw } : {}),
    });
    return {
      costInput: resolved.inputUsdPer1M,
      costOutput: resolved.outputUsdPer1M,
      costCacheRead: resolved.cacheReadUsdPer1M,
      costCacheWrite: resolved.cacheWriteUsdPer1M,
    };
  }

  const sdkIn = baseModel?.cost?.input ?? 0;
  const sdkOut = baseModel?.cost?.output ?? 0;
  if (sdkIn > 0 || sdkOut > 0) {
    const resolved = resolveModelUnitPrice(providerId, modelId, {
      costInput: sdkIn,
      costOutput: sdkOut,
      ...((baseModel?.cost?.cacheRead ?? 0) > 0 ? { costCacheRead: baseModel!.cost!.cacheRead } : {}),
      ...((baseModel?.cost?.cacheWrite ?? 0) > 0 ? { costCacheWrite: baseModel!.cost!.cacheWrite } : {}),
    });
    return {
      costInput: resolved.inputUsdPer1M,
      costOutput: resolved.outputUsdPer1M,
      costCacheRead: resolved.cacheReadUsdPer1M,
      costCacheWrite: resolved.cacheWriteUsdPer1M,
    };
  }
  const fallback = resolveModelUnitPrice(providerId, modelId);
  if (fallback.source !== 'unknown') {
    return {
      costInput: fallback.inputUsdPer1M,
      costOutput: fallback.outputUsdPer1M,
      costCacheRead: fallback.cacheReadUsdPer1M,
      costCacheWrite: fallback.cacheWriteUsdPer1M,
    };
  }
  return { costInput: 0, costOutput: 0 };
}

/** Fetches available chat models from a provider's remote /models HTTP endpoint. */
export async function fetchRemoteModelsFromEndpoint(
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
  assertSafeBaseUrlForCredentials(cleanBase, Boolean(apiKey?.trim()));

  if (providerId === 'google' && !baseUrl?.trim()) {
    if (!apiKey) throw new Error('拉取 Google Gemini 模型列表需要先提供 API Key');
    const url = `${cleanBase}/models?pageSize=100`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'x-goog-api-key': apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const errBody = sanitizeCredentialLeakText(await res.text().catch(() => ''), [apiKey]) ?? '';
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
    const rawList = data && typeof data === 'object' && Array.isArray(data.models) ? data.models : [];
    const entries: ModelCatalogEntry[] = [];
    for (const item of rawList) {
      if (!item.name) continue;
      const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
      if (!methods.includes('generateContent')) continue;
      const id = item.name.replace(/^models\//, '');
      if (/(?:tts|image-generation|embedding|aqa|imagen|veo|robotics|computer-use|audio)/i.test(id)) continue;
      const baseModel = baseById.get(id) ?? getPristineSdkModel(providerId, id);
      const { costInput, costOutput, costCacheRead, costCacheWrite } = resolveDiscoveryCost(providerId, id, baseModel);
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
        costInput,
        costOutput,
        ...(costCacheRead !== undefined ? { costCacheRead } : {}),
        ...(costCacheWrite !== undefined ? { costCacheWrite } : {}),
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
      const errBody = sanitizeCredentialLeakText(await res.text().catch(() => ''), [apiKey]) ?? '';
      throw new Error(`Anthropic /v1/models 接口返回 HTTP ${res.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await res.json() as {
      data?: Array<{ id?: string; display_name?: string }>;
    };
    const rawList = data && typeof data === 'object' && Array.isArray(data.data) ? data.data : [];
    const entries: ModelCatalogEntry[] = [];
    for (const item of rawList) {
      if (!item.id) continue;
      const baseModel = baseById.get(item.id) ?? getPristineSdkModel(providerId, item.id);
      const { costInput, costOutput, costCacheRead, costCacheWrite } = resolveDiscoveryCost(providerId, item.id, baseModel);
      entries.push({
        id: item.id,
        name: item.display_name || baseModel?.name || item.id,
        supportsImages: baseModel ? baseModel.input.includes('image') : true,
        reasoning: Boolean(baseModel?.reasoning ?? true),
        contextWindow: baseModel?.contextWindow ?? 200_000,
        maxTokens: baseModel?.maxTokens ?? 16_384,
        costInput,
        costOutput,
        ...(costCacheRead !== undefined ? { costCacheRead } : {}),
        ...(costCacheWrite !== undefined ? { costCacheWrite } : {}),
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
    const errBody = sanitizeCredentialLeakText(await res.text().catch(() => ''), [apiKey]) ?? '';
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
      pricing?: RemoteModelPricing;
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
      pricing?: RemoteModelPricing;
    }>;
  };
  const rawList = data && typeof data === 'object'
    ? (Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.models)
        ? data.models
        : [])
    : [];
  const entries: ModelCatalogEntry[] = [];
  for (const item of rawList) {
    const id = (item.id || item.slug || '').trim();
    if (!id) continue;
    if (/^(?:tts-|whisper-|dall-e-|text-embedding-|omni-moderation-|babbage-|davinci-)/i.test(id)) continue;
    const baseModel = baseById.get(id) ?? getPristineSdkModel(providerId, id);
    const supportsImages = Array.isArray(item.input_modalities)
      ? item.input_modalities.includes('image')
      : Boolean(baseModel?.input.includes('image'));
    const ctxWin = typeof item.context_window === 'number' && item.context_window > 0
      ? item.context_window
      : typeof item.max_context_window === 'number' && item.max_context_window > 0
        ? item.max_context_window
        : (baseModel?.contextWindow ?? 128_000);
    const { costInput, costOutput, costCacheRead, costCacheWrite } = resolveDiscoveryCost(providerId, id, baseModel, item.pricing);
    entries.push({
      id,
      name: item.name || item.display_name || item.title || baseModel?.name || id,
      supportsImages,
      reasoning: Boolean(item.reasoning ?? item.supports_reasoning_effort_updates ?? baseModel?.reasoning ?? false),
      contextWindow: ctxWin,
      maxTokens: typeof item.max_output_tokens === 'number' && item.max_output_tokens > 0
        ? item.max_output_tokens
        : (baseModel?.maxTokens ?? 16_384),
      costInput,
      costOutput,
      ...(costCacheRead !== undefined ? { costCacheRead } : {}),
      ...(costCacheWrite !== undefined ? { costCacheWrite } : {}),
    });
  }
  if (!entries.length) {
    throw new Error(`${providerId} /models 接口未返回可用模型`);
  }
  return entries;
}

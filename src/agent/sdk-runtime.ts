import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { obj, opt, str } from '@earendil-works/pi-schema';
import { clampNativeThinkingLevel, getNativeThinkingLevels, type ThinkingLevel } from '../decision.js';
import { messageImages } from '../message-images.js';
import {
  buildModelTiers,
  ensureRealProviderCatalog,
  FALLBACK_PROVIDER_MODELS,
  normalizeProviderId,
  normalizeSelectedModels,
  REAL_PROVIDER_DEFAULTS,
  resolveWorkerModelFromTiers,
  type PersistedModelHubState,
  type WorkerModelResolutionInput,
} from '../models/catalog.js';
import { NativeCommandInterrupted, nativeShellOperations } from '../native-shell.js';
import { resolveEnv } from '../paths.js';
import type { ModelTier, ModelTierConfig, WorkerProfile } from '../view.js';
import { buildAgentSystemPrompts, resourceLoader, type Role } from './prompts.js';
import { isHostEventUserMessage, transformAgentContextMessages } from './router-diet.js';

export interface AgentTool {
  name: string;
  description: string;
  execute(input: string, callId?: string): Promise<string>;
}
export interface AgentObservation {
  kind: 'text_delta' | 'turn_start' | 'turn_end' | 'tool_start' | 'tool_end' | 'compaction_start' | 'compaction_end' | 'retry_start' | 'retry_end';
  id?: string;
  parentId?: string;
  text?: string;
  toolName?: string;
  data?: unknown;
  error?: boolean;
}
export interface AgentOptions {
  onEvent?: (event: AgentObservation) => void;
  restore?: { sessionFile: string; leafId: string };
  execution?: 'native' | 'snapshot';
  cwd?: string;
  profile?: WorkerProfile;
  model?: string;
  tier?: ModelTier;
  thinkingLevel?: ThinkingLevel;
  nativeTool?: (event: { id: string; name: string; phase: 'start' | 'end'; error?: boolean; interrupted?: boolean }) => void;
}
export interface AgentPort {
  sessionFile?: string;
  checkpoint?: { sessionFile: string; leafId: string };
  leafId?: string | null;
  rewind?(leafId: string | null): void;
  prompt(text: string, signal: AbortSignal): Promise<string>;
  close(): void;
}
export interface AgentFactory {
  mode: 'real' | 'offline';
  nativeTools?: boolean;
  modelTiers?: ModelTierConfig;
  routerProvider?: string;
  initialApiKey?: string;
  runtime?: ModelRuntime;
  resolveWorkerModel?: (input: WorkerModelResolutionInput) => { model: string; tier: ModelTier };
  updateModelConfig?: (tiers: ModelTierConfig, nextRouterProvider: string, nextRouterModelId: string, disabledProviders?: string[]) => void;
  onModelUsage?: (entry: {
    actor: Role | 'compaction';
    sessionId: string;
    provider: string;
    model: string;
    status: 'completed' | 'failed' | 'interrupted';
    usage: unknown;
  }) => void;
  create(role: Role, id: string, tools: AgentTool[], options?: AgentOptions): Promise<AgentPort>;
}

export type AuthInteraction = Parameters<ModelRuntime['login']>[2];

const MAX_LISTED = 12;
const REAL_CONFIG_ERROR =
  'Real mode requires SUPER_AGENT_PROVIDER (or FRIDAY_PROVIDER), SUPER_AGENT_MODEL (or FRIDAY_MODEL) and SUPER_AGENT_API_KEY (or FRIDAY_API_KEY, or OAuth login via "friday login"); use --mode offline explicitly for simulation';

export function prepareRouterSessionModel<
  T extends {
    id: string;
    api?: string;
    reasoning?: boolean;
    contextWindow?: number;
    thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
    compat?: object;
  },
>(model: T): T & { contextWindow: number } {
  const effectiveWindow = typeof model.contextWindow === 'number' && Number.isFinite(model.contextWindow) && model.contextWindow > 0
    ? model.contextWindow
    : 128_000;
  const base = (model.contextWindow === effectiveWindow
    ? model
    : { ...model, contextWindow: effectiveWindow }) as T & { contextWindow: number };
  if (!base.reasoning || base.api !== 'openai-completions') {
    return base;
  }
  const compat = (base.compat ?? {}) as Record<string, unknown>;
  const fmt = typeof compat.thinkingFormat === 'string' ? compat.thinkingFormat : undefined;
  if (fmt === 'deepseek' || fmt === 'zai' || (!fmt && /^(?:deepseek|glm|mimo)/i.test(base.id))) {
    return {
      ...base,
      compat: {
        ...compat,
        thinkingFormat: fmt ?? 'deepseek',
      },
      thinkingLevelMap: {
        ...(base.thinkingLevelMap ?? {}),
        off: base.thinkingLevelMap?.off || 'off',
      },
    } as T & { contextWindow: number };
  }
  return base;
}

/** Explains a failed catalog lookup with the IDs that would have worked. */
function modelLookupError(runtime: ModelRuntime, provider: string, model: string): string {
  if (/^[a-z]+:\/\//i.test(provider)) {
    return `SUPER_AGENT_PROVIDER is a provider ID from the SDK catalog, not a base URL: use "deepseek" (not "${provider}"). `
      + `The endpoint is already part of the catalog entry, so no base URL needs to be set. Requested model: ${model}`;
  }
  const providers = runtime.getProviders().map(item => item.id);
  if (!providers.includes(provider)) {
    const listed = providers.slice(0, MAX_LISTED).join(', ');
    return `Unknown SDK provider "${provider}". Providers in this SDK catalog include: ${listed}`
      + `${providers.length > MAX_LISTED ? `, and ${providers.length - MAX_LISTED} more` : ''}. Unknown SDK model: ${provider}/${model}`;
  }
  const models = runtime.getModels(provider).map(item => item.id);
  const listed = models.slice(0, MAX_LISTED).join(', ');
  return `Unknown model "${model}" for provider "${provider}". This catalog offers: ${listed}`
    + `${models.length > MAX_LISTED ? `, and ${models.length - MAX_LISTED} more` : ''}. Unknown SDK model: ${provider}/${model}`;
}

function resolveProviderAndModelSpec(
  runtime: ModelRuntime,
  rawSpec: string,
  fallbackProvider: string,
  persistedProviders?: PersistedModelHubState['providers'],
  disabledProviders?: Set<string>,
): { provider: string; modelId: string; explicitlyPrefixed: boolean } {
  const raw = rawSpec.trim();
  const slash = raw.indexOf('/');
  if (slash <= 0) {
    return { provider: fallbackProvider, modelId: raw, explicitlyPrefixed: false };
  }
  if (runtime.getModel(fallbackProvider, raw)) {
    return { provider: fallbackProvider, modelId: raw, explicitlyPrefixed: false };
  }
  const head = raw.slice(0, slash);
  const tail = raw.slice(slash + 1);
  const normHead = normalizeProviderId(head) ?? head;
  if (head === fallbackProvider || normHead === fallbackProvider) {
    return { provider: fallbackProvider, modelId: tail, explicitlyPrefixed: true };
  }
  const knownProviders = new Set<string>(runtime.getProviders().map(item => item.id));
  if (persistedProviders) {
    for (const id of Object.keys(persistedProviders)) knownProviders.add(id);
  }
  const matchedProvider = knownProviders.has(head)
    ? head
    : knownProviders.has(normHead)
      ? normHead
      : undefined;
  if (!matchedProvider) {
    return { provider: fallbackProvider, modelId: raw, explicitlyPrefixed: false };
  }
  if (disabledProviders?.has(matchedProvider) || runtime.getModel(matchedProvider, tail) || persistedProviders?.[matchedProvider]) {
    return { provider: matchedProvider, modelId: tail, explicitlyPrefixed: true };
  }
  return { provider: fallbackProvider, modelId: raw, explicitlyPrefixed: false };
}

export async function loginOAuth(
  home: string,
  provider = 'openai',
  interaction: AuthInteraction,
  suppliedRuntime?: ModelRuntime,
): Promise<{ provider: string; authPath: string; models: string[] }> {
  const sdkDir = join(home, 'sdk');
  await mkdir(sdkDir, { recursive: true, mode: 0o700 });
  const authPath = join(sdkDir, 'auth.json');
  const runtime = suppliedRuntime ?? await ModelRuntime.create({
    authPath, modelsPath: null,
    modelsStorePath: join(sdkDir, 'models-cache.json'), refreshOnCreate: false,
  });
  ensureRealProviderCatalog(runtime);
  const target = runtime.getProvider(provider);
  const oauthProviders = () => runtime.getProviders().filter(item => item.auth.oauth).map(item => item.id).join(', ');
  if (!target) throw new Error(`Unknown SDK provider "${provider}". OAuth providers include: ${oauthProviders()}`);
  if (!target.auth.oauth) throw new Error(`Provider "${provider}" does not support OAuth login. OAuth providers include: ${oauthProviders()}`);
  const settings = SettingsManager.create(sdkDir, sdkDir);
  const deviceId = settings.getOrCreateDeviceId();
  await settings.flush();
  await runtime.login(provider, 'oauth', interaction, { getDeviceId: () => deviceId });
  return { provider, authPath, models: runtime.getModels(provider).map(item => item.id) };
}

export async function logoutOAuth(
  home: string,
  provider = 'openai',
  suppliedRuntime?: ModelRuntime,
): Promise<{ provider: string; authPath: string }> {
  const sdkDir = join(home, 'sdk');
  await mkdir(sdkDir, { recursive: true, mode: 0o700 });
  const authPath = join(sdkDir, 'auth.json');
  const runtime = suppliedRuntime ?? await ModelRuntime.create({
    authPath, modelsPath: null,
    modelsStorePath: join(sdkDir, 'models-cache.json'), refreshOnCreate: false,
  });
  await runtime.logout(provider);
  return { provider, authPath };
}

export const NATIVE_TOOL_NAMES = ['read', 'ls', 'find', 'grep', 'bash', 'edit', 'write'];
export const READONLY_TOOL_NAMES = ['read', 'ls', 'find', 'grep'];

export function readonlyDefinitions(cwd: string): ToolDefinition[] {
  const definitions: ToolDefinition[] = [
    createReadToolDefinition(cwd),
    createLsToolDefinition(cwd),
    createFindToolDefinition(cwd),
    createGrepToolDefinition(cwd),
  ].map(({ renderCall: _call, renderResult: _result, ...definition }) => definition);
  return definitions.map((definition): ToolDefinition => ({
    ...definition,
    execute: async (id, args, signal, update, context) => {
      signal?.throwIfAborted();
      return definition.execute(id, args, signal, update, context);
    },
  }));
}

export function nativeDefinitions(cwd: string, options?: AgentOptions): ToolDefinition[] {
  const definitions: ToolDefinition[] = [
    createReadToolDefinition(cwd), createLsToolDefinition(cwd), createFindToolDefinition(cwd),
    createGrepToolDefinition(cwd), createEditToolDefinition(cwd), createWriteToolDefinition(cwd),
    createBashToolDefinition(cwd, {
      operations: nativeShellOperations(),
      exposeSessionEnvironment: false,
      spawnHook: context => {
        const env = { ...context.env };
        for (const key of Object.keys(env)) {
          if (
            /(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|PRIVATE_KEY|AUTHORIZATION|WEBHOOK|CONNECTION_STRING|DATABASE_URL|REDIS_URL|MONGO(?:DB)?_UR[IL]|POSTGRES(?:QL)?_URL|MYSQL_URL|AMQP_URL)|(?:^|_)(?:PASS|AUTH|DSN)(?:$|_)/i.test(key)
            || (typeof env[key] === 'string' && /(?:URL|URI)$/i.test(key) && /:\/\/[^:/@\s]+:[^/@\s]+@/.test(env[key]!))
          ) {
            delete env[key];
          }
        }
        return { ...context, env };
      },
    }),
  ].map(({ renderCall: _call, renderResult: _result, ...definition }) => definition);
  return definitions.map((definition): ToolDefinition => ({
    ...definition,
    execute: async (id, args, signal, update, context) => {
      signal?.throwIfAborted();
      options?.nativeTool?.({ id, name: definition.name, phase: 'start' });
      try {
        const result = await definition.execute(id, args, signal, update, context);
        options?.nativeTool?.({ id, name: definition.name, phase: 'end', error: 'isError' in result && result.isError === true, interrupted: signal?.aborted });
        return result;
      } catch (error) {
        options?.nativeTool?.({ id, name: definition.name, phase: 'end', error: true, interrupted: signal?.aborted || error instanceof NativeCommandInterrupted });
        throw error;
      }
    },
  }));
}

/** Transient provider-side failures (overload, rate limit, 5xx, timeouts) that another model may not share. */
export function isRetryableModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(?:429|500|502|503|504|529)\b|overload|rate.?limit|too many requests|server_error|temporarily unavailable|timed? ?out|ECONNRESET|ETIMEDOUT/i.test(message);
}

type TurnAssistantLike = {
  role?: string;
  stopReason?: string;
  errorMessage?: unknown;
  content?: unknown;
};

function throwIfModelRequestFailed(message: TurnAssistantLike): void {
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    const detail = typeof message.errorMessage === 'string' && message.errorMessage.trim()
      ? `: ${message.errorMessage.trim()}`
      : '; check provider configuration and service logs';
    throw new Error(`Model request ${message.stopReason}${detail}`);
  }
}

function extractTextFromAssistantContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const item of content) {
    if (
      item
      && typeof item === 'object'
      && (item as { type?: unknown }).type === 'text'
      && typeof (item as { text?: unknown }).text === 'string'
    ) {
      text += (item as { text: string }).text;
    }
  }
  return text.trim();
}

export function extractCurrentTurnAssistantText(
  messages: ReadonlyArray<TurnAssistantLike>,
  observedTurnAssistants?: ReadonlyArray<TurnAssistantLike>,
): string {
  let lastUserIdx = messages.findLastIndex(msg => isHostEventUserMessage(msg as { role?: string; content?: unknown }));
  if (lastUserIdx < 0) {
    lastUserIdx = messages.findLastIndex(msg => msg.role === 'user');
  }
  const turnMessages = lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages;
  const last = [...turnMessages].reverse().find((msg) => {
    if (msg.role !== 'assistant') return false;
    if (msg.stopReason === 'aborted' && Array.isArray(msg.content) && msg.content.length === 0) return false;
    return true;
  });
  if (!last) {
    const observed = observedTurnAssistants?.at(-1);
    if (observed) {
      throwIfModelRequestFailed(observed);
      if (observed.stopReason === 'length') {
        throw new Error('Model response truncated before producing valid output (stopReason=length)');
      }
    }
    throw new Error('Model returned no report');
  }
  throwIfModelRequestFailed(last);
  const text = extractTextFromAssistantContent(last.content);
  if (!text) {
    if (last.stopReason === 'length') {
      throw new Error('Model response truncated before producing valid output (stopReason=length)');
    }
    throw new Error('Model returned no report');
  }
  return text;
}

/** Normalizes tool call arguments from either `{ input }` string wrappers or direct object fields. */
export function normalizeCustomToolInput(args: unknown): string {
  if (typeof args === 'string') return args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('Tool input must be a string or JSON object');
  }
  const { input: rawInput, ...rest } = args as Record<string, unknown>;
  const hasRest = Object.keys(rest).length > 0;
  if (typeof rawInput === 'string') {
    if (!hasRest) return rawInput;
    try {
      const parsed: unknown = JSON.parse(rawInput.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return JSON.stringify({ ...rest, ...(parsed as Record<string, unknown>) });
      }
    } catch {
      return rawInput;
    }
    return rawInput;
  }
  if (rawInput !== undefined && rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    return JSON.stringify({ ...rest, ...(rawInput as Record<string, unknown>) });
  }
  if (rawInput === undefined) {
    return JSON.stringify(rest);
  }
  throw new Error('Tool input must be a string or JSON object');
}

export class SdkAgent implements AgentPort {
  private readonly unsubscribe: () => void;
  private readonly configuredModel: AgentSession['model'];
  private activeTurnAssistants?: TurnAssistantLike[];

  constructor(
    private readonly session: AgentSession,
    onEvent?: (event: AgentObservation) => void,
    private readonly checkDisabled?: () => string | undefined,
    private readonly fallbackModel?: () => NonNullable<AgentSession['model']> | undefined,
    private readonly role: Role = 'worker',
    private readonly primaryModel?: () => NonNullable<AgentSession['model']> | undefined,
    private readonly onModelUsage?: (entry: {
      actor: Role | 'compaction';
      provider: string;
      model: string;
      status: 'completed' | 'failed' | 'interrupted';
      usage: unknown;
    }) => void,
  ) {
    this.configuredModel = session.model;
    let turn: string | undefined;
    const transform = session.agent.transformContext;
    session.agent.transformContext = async (messages, signal) => {
      const context = transform ? await transform(messages, signal) : messages;
      return transformAgentContextMessages(context, this.role);
    };
    let compaction: string | undefined;
    let retry: string | undefined;
    this.unsubscribe = session.subscribe(event => {
      if (event.type === 'turn_end' && event.message.role === 'assistant') {
        this.activeTurnAssistants?.push(event.message);
        if (event.message.usage) {
          const usageStatus = event.message.stopReason === 'error'
            ? 'failed'
            : event.message.stopReason === 'aborted'
              ? 'interrupted'
              : 'completed';
          try {
            this.onModelUsage?.({
              actor: this.role,
              provider: event.message.provider || this.session.model?.provider || this.configuredModel?.provider || 'unknown',
              model: event.message.model || this.session.model?.id || this.configuredModel?.id || 'unknown',
              status: usageStatus,
              usage: event.message.usage,
            });
          } catch {
            // Never allow usage collection errors to disrupt live agent turns.
          }
        }
      } else if (event.type === 'compaction_end' && event.result?.usage) {
        const compStatus = event.aborted ? 'interrupted' : event.errorMessage ? 'failed' : 'completed';
        try {
          this.onModelUsage?.({
            actor: this.role === 'dreamer' ? 'dreamer' : 'compaction',
            provider: this.session.model?.provider || this.configuredModel?.provider || 'unknown',
            model: this.session.model?.id || this.configuredModel?.id || 'unknown',
            status: compStatus,
            usage: event.result.usage,
          });
        } catch {
          // Never allow usage collection errors to disrupt SDK compaction.
        }
      }
      if (!onEvent) return;
      if (event.type === 'turn_start') {
        turn = randomUUID();
        onEvent({
          kind: 'turn_start',
          id: turn,
          data: {
            provider: this.session.model?.provider || this.configuredModel?.provider,
            model: this.session.model?.id || this.configuredModel?.id,
          },
        });
      }
      else if (event.type === 'turn_end') {
        const message = event.message;
        const content = message.role === 'assistant' && Array.isArray(message.content) ? message.content : [];
        const publicText = message.role === 'assistant' ? content.filter(item => item.type === 'text').map(item => item.text).join('\n') : '';
        const toolCalls = content
          .map(item => item as unknown as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown; input?: unknown })
          .filter(item => item && (item.type === 'toolCall' || item.type === 'tool_use'))
          .slice(0, 12)
          .map(item => {
            const rawArgs = item.arguments ?? item.input;
            let argsStr = '';
            if (typeof rawArgs === 'string') {
              argsStr = rawArgs;
            } else if (rawArgs !== undefined) {
              try {
                argsStr = JSON.stringify(rawArgs) ?? '';
              } catch {
                argsStr = String(rawArgs);
              }
            }
            return {
              id: typeof item.id === 'string' ? item.id : String(item.id ?? ''),
              name: typeof item.name === 'string' ? item.name : String(item.name ?? ''),
              argsPreview: argsStr.slice(0, 240),
            };
          });
        const errorMessage = message.role === 'assistant' && 'errorMessage' in message && typeof message.errorMessage === 'string'
          ? message.errorMessage.slice(0, 600)
          : undefined;
        onEvent({
          kind: 'turn_end',
          id: turn,
          data: message.role === 'assistant'
            ? {
                stopReason: message.stopReason,
                ...(errorMessage ? { errorMessage } : {}),
                ...(message.provider ? { provider: message.provider } : {}),
                ...(message.model ? { model: message.model } : {}),
                usage: message.usage,
                publicText: publicText.slice(0, 1600),
                publicTextTruncated: publicText.length > 1600,
                ...(toolCalls.length > 0 ? { toolCalls } : {}),
              }
            : undefined,
        });
      } else if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        onEvent({ kind: 'text_delta', id: turn, text: event.assistantMessageEvent.delta });
      } else if (event.type === 'tool_execution_start') {
        onEvent({ kind: 'tool_start', id: event.toolCallId, parentId: turn, toolName: event.toolName, data: event.args });
      } else if (event.type === 'tool_execution_end') {
        onEvent({ kind: 'tool_end', id: event.toolCallId, parentId: turn, toolName: event.toolName, data: event.result, error: event.isError });
      } else if (event.type === 'compaction_start') {
        compaction = randomUUID();
        onEvent({ kind: 'compaction_start', id: compaction, parentId: turn, data: { reason: event.reason } });
      } else if (event.type === 'compaction_end') {
        onEvent({
          kind: 'compaction_end',
          id: compaction ?? randomUUID(),
          parentId: turn,
          error: Boolean(event.errorMessage) && !event.aborted,
          data: {
            reason: event.reason,
            aborted: event.aborted,
            willRetry: event.willRetry,
            error: event.errorMessage,
            tokensBefore: event.result?.tokensBefore,
            estimatedTokensAfter: event.result?.estimatedTokensAfter,
            usage: event.result?.usage,
          },
        });
        compaction = undefined;
      } else if (event.type === 'auto_retry_start') {
        retry = randomUUID();
        onEvent({
          kind: 'retry_start',
          id: retry,
          parentId: turn,
          error: true,
          data: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, error: event.errorMessage },
        });
      } else if (event.type === 'auto_retry_end') {
        onEvent({ kind: 'retry_end', id: retry ?? randomUUID(), parentId: turn, error: !event.success, data: { success: event.success, finalError: event.finalError } });
        retry = undefined;
      }
    });
  }

  get sessionFile() { return this.session.sessionFile; }
  get leafId() { return this.session.sessionManager.getLeafId(); }
  get checkpoint() {
    const sessionFile = this.session.sessionFile;
    const leafId = this.session.sessionManager.getLeafId();
    return sessionFile && leafId && existsSync(sessionFile) ? { sessionFile, leafId } : undefined;
  }

  rewind(leafId: string | null) {
    if (leafId === null) {
      this.session.sessionManager.resetLeaf();
    } else if (this.session.sessionManager.getEntry(leafId)) {
      this.session.sessionManager.branch(leafId);
    }
    this.session.refreshContext();
  }

  async prompt(text: string, signal: AbortSignal): Promise<string> {
    const startLeaf = this.session.sessionManager.getLeafId();
    const startCount = this.session.messages.length;
    const restoreTarget = this.primaryModel?.() ?? this.session.model ?? this.configuredModel;
    try {
      return await this.promptOnce(text, signal);
    } catch (error) {
      // Router only: primary model overloaded / rate limited even after SDK retries.
      // Re-run once on fallback model (only if no tool executed yet), then always restore configured primary model.
      const fallback = this.fallbackModel?.();
      const current = this.session.model;
      if (!fallback || signal.aborted || !isRetryableModelError(error)) throw error;
      if (current && fallback.provider === current.provider && fallback.id === current.id) throw error;
      if (this.session.messages.slice(startCount).some(message => message.role === 'toolResult')) throw error;
      this.rewind(startLeaf);
      try {
        await this.session.setModel(fallback);
        return await this.promptOnce(text, signal);
      } finally {
        if (restoreTarget) {
          await this.session.setModel(restoreTarget).catch(() => {});
        }
      }
    }
  }

  private async promptOnce(text: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const disabledProv = this.checkDisabled?.();
    if (disabledProv) throw new Error(`提供方 "${disabledProv}" 已禁用，无法调用`);
    let abortPromise: Promise<void> | undefined;
    const abort = () => { abortPromise = this.session.abort().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    this.activeTurnAssistants = [];
    try {
      const input = await messageImages(text, this.session.model?.input.includes('image') ?? false);
      signal.throwIfAborted();
      await this.session.prompt(`HOST_EVENT\n${input.text}`, { images: input.images });
      if (abortPromise) await abortPromise;
      signal.throwIfAborted();
      return extractCurrentTurnAssistantText(this.session.messages, this.activeTurnAssistants);
    } finally {
      this.activeTurnAssistants = undefined;
      signal.removeEventListener('abort', abort);
      if (abortPromise) await abortPromise;
    }
  }

  close() {
    this.unsubscribe();
    this.session.dispose();
  }
}

function extractSelectedModelIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  try {
    return normalizeSelectedModels(raw).map(item => item.id);
  } catch {
    return [];
  }
}

export async function realFactory(home: string, config: {
  provider?: string; model?: string; apiKey?: string;
  baseUrl?: string; routerModel?: string; workerModel?: string;
  fastModel?: string; balancedModel?: string; strongModel?: string;
  retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number; maxAgentDelayMs?: number };
}, suppliedRuntime?: ModelRuntime): Promise<AgentFactory> {
  const sdkDir = join(home, 'sdk');
  const authPath = join(sdkDir, 'auth.json');
  const hubPath = join(sdkDir, 'model-hub.json');
  let persistedHub: PersistedModelHubState | undefined;
  if (existsSync(hubPath)) {
    try {
      const parsed = JSON.parse(await readFile(hubPath, 'utf8')) as Partial<PersistedModelHubState>;
      if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
        persistedHub = { ...parsed, providers: parsed.providers };
      }
    } catch {
      // Ignore malformed model-hub.json while resolving startup fallback
    }
  }
  const enabledPersistedEntry = (prov?: string) => {
    if (!prov || !persistedHub) return undefined;
    const exact = persistedHub.providers[prov];
    if (exact && exact.enabled !== false && exact.apiKey?.trim()) return { id: prov, cfg: exact };
    const norm = normalizeProviderId(prov);
    const normalized = norm ? persistedHub.providers[norm] : undefined;
    if (norm && normalized && normalized.enabled !== false && normalized.apiKey?.trim()) return { id: norm, cfg: normalized };
    return undefined;
  };
  const firstPersistedEntry = () => {
    if (!persistedHub) return undefined;
    for (const candidate of [
      persistedHub.routerProvider,
      persistedHub.workerProvider,
      ...Object.keys(persistedHub.providers),
    ]) {
      const entry = enabledPersistedEntry(candidate);
      if (entry) return entry;
    }
    return undefined;
  };
  const fallbackEntry = config.provider ? enabledPersistedEntry(config.provider) : firstPersistedEntry();
  const effectiveConfigProvider = config.provider ?? fallbackEntry?.id;
  const effectiveConfigApiKey = config.apiKey ?? fallbackEntry?.cfg.apiKey?.trim();
  const effectiveConfigBaseUrl = config.baseUrl ?? fallbackEntry?.cfg.baseUrl?.trim();
  const persistedDefaultModel = fallbackEntry
    ? (REAL_PROVIDER_DEFAULTS[fallbackEntry.id]?.balanced?.[0] ?? FALLBACK_PROVIDER_MODELS[fallbackEntry.id]?.[0]?.id)
    : undefined;
  const persistedFallbackModel = (fallbackEntry ? extractSelectedModelIds(fallbackEntry.cfg.selectedModels)[0] : undefined)
    ?? fallbackEntry?.cfg.customModels?.[0]
    ?? fallbackEntry?.cfg.fetchedModels?.[0]?.id
    ?? persistedDefaultModel;
  const effectiveConfigModel = config.model
    ?? persistedHub?.routerModel
    ?? persistedHub?.balancedModel
    ?? persistedHub?.strongModel
    ?? persistedHub?.fastModel
    ?? persistedFallbackModel;
  const hasDefaultModelProvider = effectiveConfigProvider === 'deepseek'
    || effectiveConfigProvider === 'google'
    || effectiveConfigProvider === 'google-vertex'
    || effectiveConfigProvider === 'gemini';
  if (
    (!effectiveConfigProvider || (!effectiveConfigModel && !hasDefaultModelProvider) || !effectiveConfigApiKey)
    && !suppliedRuntime
    && !existsSync(authPath)
  ) {
    throw new Error(REAL_CONFIG_ERROR);
  }
  await mkdir(sdkDir, { recursive: true, mode: 0o700 });
  const runtime = suppliedRuntime ?? await ModelRuntime.create({
    authPath, modelsPath: null,
    modelsStorePath: join(sdkDir, 'models-cache.json'), refreshOnCreate: false,
  });
  ensureRealProviderCatalog(runtime);

  const disabledProviderSet = new Set<string>(
    Object.entries(persistedHub?.providers ?? {})
      .filter(([, cfg]) => cfg?.enabled === false)
      .map(([id]) => id),
  );
  const inferModelInput = (id: string, provId = 'openai'): Array<'text' | 'image'> => {
    const catalogModel = runtime.getModel(provId, id);
    if (catalogModel?.input.includes('image')) return ['text', 'image'];
    if (
      resolveEnv('FRIDAY_VISION', 'SUPER_AGENT_VISION') === '1'
      || /(?:gpt-4o|gpt-4\.1|gpt-5|claude-|gemini|vl|vision|omni|pixtral|qvq|glm-4v|kimi|minimax)/i.test(id)
    ) {
      return ['text', 'image'];
    }
    return ['text'];
  };

  const stripProviderPrefix = (raw: string | undefined, provId: string): string | undefined => {
    const trimmed = raw?.trim();
    if (!trimmed) return undefined;
    if (!trimmed.includes('/')) return trimmed;
    const slash = trimmed.indexOf('/');
    const head = trimmed.slice(0, slash);
    const tail = trimmed.slice(slash + 1);
    const normProv = normalizeProviderId(provId) ?? provId;
    if (head === provId || (normalizeProviderId(head) ?? head) === normProv) {
      return tail || undefined;
    }
    return undefined;
  };
  const normRouterHubProv = normalizeProviderId(persistedHub?.routerProvider) ?? persistedHub?.routerProvider;
  const normWorkerHubProv = normalizeProviderId(persistedHub?.workerProvider) ?? persistedHub?.workerProvider;

  // Pre-register persisted provider custom URLs / custom & fetched models so startup resolves
  // multi-slash and UI-configured providers cleanly even before Coordinator calls modelHub.init().
  for (const [provId, cfg] of Object.entries(persistedHub?.providers ?? {})) {
    if (!cfg || cfg.enabled === false) continue;
    const baseUrl = cfg.baseUrl?.trim();
    const existingModels = runtime.getModels(provId);
    const extraModelIds = [...new Set([
      ...(cfg.customModels ?? []),
      ...(cfg.fetchedModels ?? []).map(m => m.id),
      ...extractSelectedModelIds(cfg.selectedModels),
      ...(provId === persistedHub?.routerProvider || provId === normRouterHubProv
        ? [stripProviderPrefix(persistedHub?.routerModel, provId)]
        : []),
      ...(provId === persistedHub?.workerProvider || provId === normWorkerHubProv
        ? [
            stripProviderPrefix(persistedHub?.fastModel, provId),
            stripProviderPrefix(persistedHub?.balancedModel, provId),
            stripProviderPrefix(persistedHub?.strongModel, provId),
          ]
        : []),
    ].filter((id): id is string => Boolean(id && id.trim())))];
    const toCustomModelEntry = (id: string, fallbackBaseUrl: string, fallbackApi: string) => {
      const fetched = cfg.fetchedModels?.find(m => m.id === id);
      return {
        id,
        name: fetched?.name ?? id,
        api: fallbackApi,
        baseUrl: fallbackBaseUrl,
        reasoning: fetched?.reasoning ?? false,
        input: fetched?.supportsImages ? (['text', 'image'] as Array<'text' | 'image'>) : inferModelInput(id, provId),
        cost: {
          input: fetched?.costInput ?? 0,
          output: fetched?.costOutput ?? 0,
          cacheRead: fetched?.costCacheRead ?? 0,
          cacheWrite: fetched?.costCacheWrite ?? 0,
        },
        contextWindow: fetched?.contextWindow ?? 128_000,
        maxTokens: fetched?.maxTokens ?? 8192,
      };
    };

    if (baseUrl) {
      let parsedUrl: URL | undefined;
      try { parsedUrl = new URL(baseUrl); } catch { parsedUrl = undefined; }
      if (parsedUrl && (parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:')) {
        const modelIds = [...new Set([...existingModels.map(m => m.id), ...extraModelIds])];
        if (modelIds.length > 0) {
          runtime.registerProvider(provId, {
            baseUrl,
            api: 'openai-completions',
            ...(cfg.apiKey?.trim() ? { apiKey: cfg.apiKey.trim() } : {}),
            models: modelIds.map(id => toCustomModelEntry(id, baseUrl, 'openai-completions')),
          });
        }
      }
    } else if (existingModels.length > 0) {
      const existingIds = new Set(existingModels.map(m => m.id));
      const missingIds = extraModelIds.filter(id => !existingIds.has(id));
      const sample = existingModels[0]!;
      if (missingIds.length > 0) {
        runtime.registerProvider(provId, {
          baseUrl: sample.baseUrl,
          api: sample.api,
          ...(cfg.apiKey?.trim() ? { apiKey: cfg.apiKey.trim() } : {}),
          models: [
            ...existingModels.map(m => ({ ...m })),
            ...missingIds.map(id => toCustomModelEntry(id, sample.baseUrl, sample.api)),
          ],
        });
      }
    }
    if (cfg.apiKey?.trim()) {
      await runtime.setRuntimeApiKey(provId, cfg.apiKey.trim());
    }
  }

  const oauthProviders = (await runtime.listCredentials()).filter(item => item.type === 'oauth').map(item => item.providerId);
  const rawProvider = effectiveConfigProvider ?? (oauthProviders.includes('openai') ? 'openai' : oauthProviders.length === 1 ? oauthProviders[0] : undefined);
  const provider = rawProvider === 'gemini' && !effectiveConfigBaseUrl && runtime.getModels('gemini').length === 0 ? 'google' : rawProvider;
  const hasOAuth = Boolean(provider && oauthProviders.includes(provider));
  const model = effectiveConfigModel
    ?? ((provider === 'openai' || provider === 'openai-codex') && hasOAuth ? 'gpt-4.1'
      : provider === 'deepseek' ? 'deepseek-chat'
      : (provider === 'google' || provider === 'google-vertex' || provider === 'gemini') ? 'gemini-2.5-flash'
      : undefined);
  if (!provider || !model || (!effectiveConfigApiKey && !hasOAuth)) {
    throw new Error(REAL_CONFIG_ERROR);
  }
  const rawRouterModel = config.routerModel ?? persistedHub?.routerModel ?? model;
  const rawWorkerModel = config.workerModel ?? persistedHub?.balancedModel ?? persistedHub?.strongModel ?? persistedHub?.fastModel ?? model;
  const fastOverride = config.fastModel ?? persistedHub?.fastModel ?? resolveEnv('FRIDAY_FAST_MODEL', 'SUPER_AGENT_FAST_MODEL');
  const balancedOverride = config.balancedModel ?? persistedHub?.balancedModel ?? resolveEnv('FRIDAY_BALANCED_MODEL', 'SUPER_AGENT_BALANCED_MODEL');
  const strongOverride = config.strongModel ?? persistedHub?.strongModel ?? resolveEnv('FRIDAY_STRONG_MODEL', 'SUPER_AGENT_STRONG_MODEL');

  if (effectiveConfigBaseUrl) {
    let parsedUrl: URL;
    try { parsedUrl = new URL(effectiveConfigBaseUrl); } catch { throw new Error(`Invalid SUPER_AGENT_BASE_URL: ${effectiveConfigBaseUrl}`); }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') throw new Error('SUPER_AGENT_BASE_URL must use http or https');
    const preIds = [model, rawRouterModel, rawWorkerModel, fastOverride, balancedOverride, strongOverride]
      .filter((x): x is string => Boolean(x))
      .map(spec => {
        const resolved = resolveProviderAndModelSpec(runtime, spec, provider, persistedHub?.providers, disabledProviderSet);
        return resolved.provider === provider ? resolved.modelId : spec.includes('/') && !runtime.getModel(resolved.provider, resolved.modelId) ? spec : undefined;
      })
      .filter((x): x is string => Boolean(x));
    const ids = [...new Set([...runtime.getModels(provider).map(m => m.id), ...preIds])];
    runtime.registerProvider(provider, {
      baseUrl: effectiveConfigBaseUrl, api: 'openai-completions', ...(effectiveConfigApiKey ? { apiKey: effectiveConfigApiKey } : {}),
      models: ids.map(id => {
        const existing = runtime.getModel(provider, id);
        return {
          id,
          name: existing?.name ?? id,
          reasoning: existing?.reasoning ?? false,
          input: existing?.input ?? inferModelInput(id, provider),
          cost: existing?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: existing?.contextWindow ?? 128_000,
          maxTokens: existing?.maxTokens ?? 8192,
          ...(existing && 'compat' in existing && existing.compat ? { compat: existing.compat } : {}),
        };
      }),
    });
  }

  let routerSpec = resolveProviderAndModelSpec(runtime, rawRouterModel, provider, persistedHub?.providers, disabledProviderSet);
  if (!routerSpec.explicitlyPrefixed && !effectiveConfigBaseUrl && !runtime.getModel(routerSpec.provider, routerSpec.modelId) && runtime.getModel('deepseek', rawRouterModel)) {
    routerSpec = { provider: 'deepseek', modelId: rawRouterModel, explicitlyPrefixed: false };
  }
  let routerProvider = routerSpec.provider;
  let routerModelId = routerSpec.modelId;
  const workerFallbackProvider = !config.workerModel
    && normWorkerHubProv
    && normWorkerHubProv !== 'offline'
    && !disabledProviderSet.has(normWorkerHubProv)
    && persistedHub?.providers?.[normWorkerHubProv]
    ? normWorkerHubProv
    : provider;
  const workerSpec = resolveProviderAndModelSpec(runtime, rawWorkerModel, workerFallbackProvider, persistedHub?.providers, disabledProviderSet);
  const workerProvider = workerSpec.provider;
  const workerModelId = workerSpec.modelId;

  if (!effectiveConfigApiKey) {
    await runtime.refresh({ allowNetwork: false, providers: [...new Set([provider, routerProvider, workerProvider])] });
  }
  const routerModel = runtime.getModel(routerProvider, routerModelId);
  if (!routerModel) throw new Error(modelLookupError(runtime, routerProvider, routerModelId));
  const workerModel = runtime.getModel(workerProvider, workerModelId);
  if (!workerModel) throw new Error(modelLookupError(runtime, workerProvider, workerModelId));
  if (effectiveConfigApiKey) {
    await runtime.setRuntimeApiKey(provider, effectiveConfigApiKey);
  }
  if (routerProvider !== provider) {
    const routerKey = resolveEnv('FRIDAY_ROUTER_API_KEY', 'SUPER_AGENT_ROUTER_API_KEY')
      ?? persistedHub?.providers[routerProvider]?.apiKey?.trim()
      ?? (routerProvider === 'deepseek' ? resolveEnv('DEEPSEEK_API_KEY') : undefined)
      ?? effectiveConfigApiKey;
    if (routerKey) await runtime.setRuntimeApiKey(routerProvider, routerKey);
  }
  let activeProvider = provider;
  let activeRouterModel = routerModel;
  let activeWorkerModel = workerModel;
  let currentDisabledProviders = disabledProviderSet;
  let currentModelTiers = buildModelTiers(runtime, provider, routerModelId, workerModelId, {
    fastModel: fastOverride,
    balancedModel: balancedOverride,
    strongModel: strongOverride,
    explicitWorkerModel: Boolean(config.workerModel),
    hasCustomBaseUrl: Boolean(effectiveConfigBaseUrl),
  });
  const factoryObj: AgentFactory = {
    mode: 'real', nativeTools: true,
    modelTiers: currentModelTiers,
    routerProvider,
    initialApiKey: config.apiKey,
    runtime,
    resolveWorkerModel: input => resolveWorkerModelFromTiers(currentModelTiers, input),
    updateModelConfig(tiers, nextRouterProvider, nextRouterModelId, disabledProviders) {
      const nextDisabled = disabledProviders ? new Set(disabledProviders) : currentDisabledProviders;
      const switchingRouter = nextRouterProvider !== routerProvider || nextRouterModelId !== routerModelId;
      if (switchingRouter && nextDisabled.has(nextRouterProvider)) {
        throw new Error(`提供方 "${nextRouterProvider}" 已禁用，无法切换 Router 模型`);
      }
      const nextR = runtime.getModel(nextRouterProvider, nextRouterModelId);
      if (!nextR) {
        throw new Error(modelLookupError(runtime, nextRouterProvider, nextRouterModelId));
      }
      const balancedSpec = resolveProviderAndModelSpec(runtime, tiers.balanced, tiers.provider, persistedHub?.providers, nextDisabled);
      const strongSpec = resolveProviderAndModelSpec(runtime, tiers.strong, tiers.provider, persistedHub?.providers, nextDisabled);
      const nextW = runtime.getModel(balancedSpec.provider, balancedSpec.modelId)
        ?? runtime.getModel(strongSpec.provider, strongSpec.modelId);
      currentDisabledProviders = nextDisabled;
      currentModelTiers = tiers;
      factoryObj.modelTiers = tiers;
      factoryObj.routerProvider = nextRouterProvider;
      routerProvider = nextRouterProvider;
      routerModelId = nextRouterModelId;
      activeProvider = tiers.provider;
      activeRouterModel = nextR;
      if (nextW) activeWorkerModel = nextW;
    },
    async create(role, id, tools, options) {
      let selectedModel = role === 'router' ? activeRouterModel : activeWorkerModel;
      let effectiveProvider = role === 'router' ? routerProvider : activeProvider;
      const requestedWorkerModel = (role === 'worker' || role === 'dreamer' || role === 'distiller')
        ? (options?.model || options?.tier
            ? resolveWorkerModelFromTiers(currentModelTiers, { model: options.model, tier: options.tier, profile: options.profile }).model
            : undefined)
        : undefined;
      if ((role === 'worker' || role === 'dreamer' || role === 'distiller') && requestedWorkerModel) {
        try {
          const spec = resolveProviderAndModelSpec(
            runtime,
            requestedWorkerModel,
            activeProvider,
            persistedHub?.providers,
            currentDisabledProviders,
          );
          let targetProvider = spec.provider;
          const targetModelId = spec.modelId;
          if (currentDisabledProviders.has(targetProvider)) {
            throw new Error(`提供方 "${targetProvider}" 已禁用，无法调用`);
          }
          let custom = !currentDisabledProviders.has(targetProvider) ? runtime.getModel(targetProvider, targetModelId) : undefined;
          if (!custom && !spec.explicitlyPrefixed) {
            for (const prov of runtime.getProviders()) {
              if (currentDisabledProviders.has(prov.id)) continue;
              const found = runtime.getModel(prov.id, targetModelId);
              if (found) {
                custom = found;
                targetProvider = prov.id;
                break;
              }
            }
            if (!custom) {
              for (const prov of runtime.getProviders()) {
                if (currentDisabledProviders.has(prov.id) && runtime.getModel(prov.id, targetModelId)) {
                  throw new Error(`提供方 "${prov.id}" 已禁用，无法调用`);
                }
              }
            }
          }
          if (!custom && effectiveConfigBaseUrl && targetProvider === activeProvider && !currentDisabledProviders.has(activeProvider)) {
            const existing = runtime.getModels(activeProvider).map(item => item.id);
            const ids = [...new Set([...existing, targetModelId])];
            runtime.registerProvider(activeProvider, {
              baseUrl: effectiveConfigBaseUrl, api: 'openai-completions', ...(effectiveConfigApiKey ? { apiKey: effectiveConfigApiKey } : {}),
              models: ids.map(item => ({ id: item, name: item, reasoning: false, input: inferModelInput(item, activeProvider), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192 })),
            });
            custom = runtime.getModel(activeProvider, targetModelId);
          }
          if (currentDisabledProviders.has(targetProvider)) {
            throw new Error(`提供方 "${targetProvider}" 已禁用，无法调用`);
          }
          if (!custom) throw new Error(modelLookupError(runtime, targetProvider, targetModelId));
          selectedModel = custom;
          effectiveProvider = targetProvider;
        } catch (err) {
          if (role !== 'distiller' || currentDisabledProviders.has(routerProvider)) throw err;
          selectedModel = activeRouterModel;
          effectiveProvider = routerProvider;
        }
      }
      if (currentDisabledProviders.has(effectiveProvider)) {
        if (role === 'distiller' && !currentDisabledProviders.has(routerProvider)) {
          selectedModel = activeRouterModel;
          effectiveProvider = routerProvider;
        } else {
          throw new Error(`提供方 "${effectiveProvider}" 已禁用，无法调用`);
        }
      }
      const sessionDir = join(sdkDir, id);
      if (role !== 'dreamer' && role !== 'distiller') await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      const native = role === 'worker' && options?.execution === 'native';
      const dreamerReadonly = role === 'dreamer' && options?.execution === 'native';
      const cwd = (native || role === 'dreamer' || role === 'distiller') ? options?.cwd ?? process.cwd() : sessionDir;
      const customTools: ToolDefinition[] = tools.map(tool => ({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: obj({ input: opt(str({ description: 'Exact file ID for reads; structured JSON for Router work tools, as specified by the tool description' })) }, { open: true }),
        execute: async (_id, args, signal) => {
          signal?.throwIfAborted();
          const normalized = normalizeCustomToolInput(args);
          return { content: [{ type: 'text', text: await tool.execute(normalized, _id) }], details: {} };
        },
      }));
      if (native) customTools.push(...nativeDefinitions(cwd, options));
      if (dreamerReadonly) customTools.push(...readonlyDefinitions(cwd));
      const { systemPrompt, promptSuffix } = buildAgentSystemPrompts({ home, role, native, profile: options?.profile });
      const hasPersistedRestore = Boolean(options?.restore && existsSync(options.restore.sessionFile));
      if (options?.restore && !hasPersistedRestore && role !== 'dreamer' && role !== 'distiller') {
        console.warn('[sdk-runtime] ignoring unpersisted checkpoint session file; starting fresh session');
      }
      const manager = (role === 'dreamer' || role === 'distiller')
        ? SessionManager.inMemory(cwd)
        : hasPersistedRestore && options?.restore
          ? SessionManager.open(options.restore.sessionFile, undefined, cwd)
          : SessionManager.create(cwd, join(sessionDir, 'sessions'));
      if (hasPersistedRestore && options?.restore && role !== 'dreamer' && role !== 'distiller') {
        if (!manager.getEntry(options.restore.leafId)) throw new Error('Router checkpoint not found; refusing unsafe session replay');
        manager.branch(options.restore.leafId);
      }
      const effectiveThinkingLevel: ThinkingLevel = role === 'router'
        ? 'off'
        : clampNativeThinkingLevel(
            getNativeThinkingLevels(selectedModel as { reasoning?: boolean; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>> }),
            options?.thinkingLevel ?? (role === 'distiller' ? 'low' : selectedModel.reasoning ? 'medium' : 'off'),
          );
      const sessionModel = role === 'router' ? prepareRouterSessionModel(selectedModel) : selectedModel;
      const { session } = await createAgentSession({
        cwd,
        agentDir: sdkDir,
        modelRuntime: runtime,
        model: sessionModel,
        thinkingLevel: effectiveThinkingLevel,
        resourceLoader: resourceLoader(
          role === 'router'
            ? () => `${buildAgentSystemPrompts({ home, role, native, profile: options?.profile }).systemPrompt}${promptSuffix}`
            : `${systemPrompt}${promptSuffix}`,
        ),
        tools: customTools.map(tool => tool.name),
        customTools,
        sessionManager: manager,
        settingsManager: SettingsManager.inMemory({
          retry: {
            enabled: config.retry?.enabled ?? true,
            maxRetries: config.retry?.maxRetries ?? 3,
            baseDelayMs: config.retry?.baseDelayMs ?? 2000,
            maxAgentDelayMs: config.retry?.maxAgentDelayMs ?? 30000,
          },
          compaction: { enabled: role !== 'router' && role !== 'distiller' },
        }),
      });
      const active = session.getActiveToolNames().sort();
      const allowed = customTools.map(tool => tool.name).sort();
      if (JSON.stringify(active) !== JSON.stringify(allowed)) {
        session.dispose();
        throw new Error('SDK tool allowlist validation failed');
      }
      return new SdkAgent(
        session,
        options?.onEvent,
        () => (currentDisabledProviders.has(effectiveProvider) ? effectiveProvider : undefined),
        role === 'router'
          ? () => (currentDisabledProviders.has(activeWorkerModel.provider) ? undefined : prepareRouterSessionModel(activeWorkerModel))
          : undefined,
        role,
        role === 'router' ? () => prepareRouterSessionModel(activeRouterModel) : undefined,
        entry => {
          factoryObj.onModelUsage?.({
            ...entry,
            sessionId: id,
          });
        },
      );
    },
  };
  return factoryObj;
}

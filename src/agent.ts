export type { Role } from './agent/prompts.js';
export { buildAgentSystemPrompts, buildPluginCapabilitiesPrompt, resourceLoader } from './agent/prompts.js';
export {
  compactHostEventText,
  pruneRouterContextMessages,
  ROUTER_CONTEXT_KEEP_MAX,
  ROUTER_CONTEXT_PRUNE_STEP,
  ROUTER_HISTORICAL_ASSISTANT_TEXT_MAX_CHARS,
  ROUTER_HISTORICAL_TOOL_ARG_MAX_CHARS,
  ROUTER_HISTORICAL_TOOL_RESULT_MAX_CHARS,
  transformAgentContextMessages,
} from './agent/router-diet.js';
export {
  extractCurrentTurnAssistantText,
  isRetryableModelError,
  loginOAuth,
  logoutOAuth,
  NATIVE_TOOL_NAMES,
  nativeDefinitions,
  prepareRouterSessionModel,
  READONLY_TOOL_NAMES,
  readonlyDefinitions,
  realFactory,
  SdkAgent,
  type AgentFactory,
  type AgentObservation,
  type AgentOptions,
  type AgentPort,
  type AgentTool,
  type AuthInteraction,
} from './agent/sdk-runtime.js';
export { abortableDelay, offlineFactory } from './agent/offline-simulator.js';
export {
  buildModelTiers,
  inferModelTier,
  resolveWorkerModelFromTiers,
  type WorkerModelResolutionInput,
} from './models/catalog.js';

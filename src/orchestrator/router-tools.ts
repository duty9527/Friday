import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import type { AgentTool } from '../agent.js';
import { publicData } from '../conversation.js';
import type { ImGateway } from '../im.js';
import { resolveEnv } from '../paths.js';
import { listPluginsSync, listPluginViews, runPlugin, type PluginRunResult } from '../plugin.js';
import { integer, text } from '../protocol.js';
import { reconcileRuntimeSessionAfterTool } from '../session.js';
import type { Store, Task } from '../store.js';
import type { PromptTrace } from '../trace.js';
import type {
  AttachmentView,
  ChatMessage,
  MessageOrigin,
  ModelTier,
  RouteAction,
  RouteKind,
  ThinkingLevel,
  WorkerProfile,
} from '../view.js';
import {
  accrueChatRun,
  imSessionKey,
  resolveRecentSessionImages,
  type BoundedCounterMap,
  type ChatRun,
} from './chat-coalescer.js';
import {
  CHAT_MIN_RECURRING_LLM_INTERVAL_MS,
  CHAT_MIN_RECURRING_PLUGIN_INTERVAL_MS,
  DEFAULT_TIMER_MAX_FAILURES,
  MAX_TIMER_INTERVAL_MS,
  MAX_TIMER_MAX_FAILURES,
  type AddTimerOptions,
} from './timer-scheduler.js';
import { dedupeAttachments, resolveMessageAttachments, resolveTaskAttachments, type Run } from './worker-runner.js';

export const WORKER_PROFILES = new Set<WorkerProfile>(['general', 'coding', 'research', 'review']);
export const MODEL_TIERS = new Set<ModelTier>(['fast', 'balanced', 'strong']);
const BINARY_ATTACHMENT_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.heic', '.avif',
  '.mp4', '.mov', '.avi', '.mkv', '.webm',
  '.mp3', '.wav', '.m4a', '.ogg', '.silk',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.gz', '.tar', '.7z', '.rar',
]);
export const READONLY_ROUTER_TOOLS = new Set(['recall_messages', 'search_memory', 'inspect_work']);
export const MEMBER_ALLOWED_PLUGINS = new Set(['miot', 'tv-ir', 'tv-agent']);

export interface RouterToolsOptions {
  allowedPlugins?: ReadonlySet<string>;
  toolNames?: ReadonlySet<string>;
}

export interface RouterTurnScope {
  chatContext?: ChatRun;
  reportChatContext?: ChatRun;
  activeReportTask?: Task;
  activeFailureTask?: { id: string; reason: string; workerModel?: string; originMessageId?: string };
  dispatch?: () => Promise<string>;
  routerTrace?: PromptTrace;
  reportTurnDispatched: boolean;
  reportTurnSentFile: boolean;
  reportTurnSavedMemory: boolean;
}

export function createRouterTurnScope(init?: Partial<RouterTurnScope>): RouterTurnScope {
  return {
    reportTurnDispatched: false,
    reportTurnSentFile: false,
    reportTurnSavedMemory: false,
    ...init,
  };
}

export function compactRouterChatWorks(knownWorks: Task[], maxSettledLimit = 3) {
  const isActive = (task: Task) =>
    task.status === 'queued'
    || task.status === 'running'
    || task.status === 'paused'
    || Boolean(task.pendingQuestion);
  const activeWorks = knownWorks.filter(isActive);
  const settledWorks = knownWorks.filter(task => !isActive(task));
  const maxSettled = Math.max(0, Math.min(maxSettledLimit, 12 - activeWorks.length));
  const selectedIds = new Set<string>([
    ...activeWorks.map(task => task.id),
    ...settledWorks.slice(-maxSettled).map(task => task.id),
  ]);
  return knownWorks
    .filter(task => selectedIds.has(task.id))
    .map(task => {
      const active = isActive(task);
      const {
        id, prompt, status, revision, mode, reason, report, files,
        originMessageId, execution, cwd, profile, workerModel, modelTier, thinkingLevel, pendingQuestion,
      } = task;
      return {
        execution: execution ?? 'snapshot',
        cwd,
        id,
        prompt: prompt.slice(0, active ? 360 : 160),
        status,
        revision,
        mode,
        reason,
        ...(active && report ? { reportPreview: report.slice(0, 300) } : {}),
        fileCount: files.length,
        originMessageId,
        ...(profile ? { profile } : {}),
        ...(modelTier ? { modelTier } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(workerModel ? { workerModel } : {}),
        ...(pendingQuestion ? { pendingQuestion } : {}),
      };
    });
}

export function compactRouterChatMemoryDirectory(
  dir: { totalActive: number; truncated: boolean; items: unknown[] },
) {
  return {
    totalActive: dir.totalActive,
    truncated: dir.truncated,
    items: dir.items.map(item => {
      const {
        synapses: _synapses,
        preview: _preview,
        summary: _summary,
        content: _content,
        ...rest
      } = item as Record<string, unknown>;
      return rest;
    }),
  };
}

export function compactRouterChatRecentContext(recentContext: unknown, maxItems = 4): unknown {
  const limit = Math.max(1, maxItems);
  const compactItem = (entry: unknown): unknown => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.text === 'string' && rec.text.length > 280) {
      return {
        ...rec,
        text: rec.text.slice(-280),
        truncated: true,
      };
    }
    return entry;
  };
  if (Array.isArray(recentContext)) {
    return recentContext.slice(-limit).map(compactItem);
  }
  if (recentContext && typeof recentContext === 'object') {
    const obj = recentContext as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      return { ...obj, items: obj.items.slice(-limit).map(compactItem) };
    }
    if (Array.isArray(obj.recentMessages)) {
      return { ...obj, recentMessages: obj.recentMessages.slice(-limit).map(compactItem) };
    }
  }
  return recentContext;
}

export function toolInput(input: string, keys: string[]): Record<string, unknown> {
  const value: unknown = JSON.parse(text(input, 'tool input', 65_536));
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('Unexpected Router tool fields');
  }
  return value as Record<string, unknown>;
}

export function parseWorkerProfile(value: unknown): WorkerProfile | undefined {
  if (value === undefined) return undefined;
  const profile = text(value, 'profile', 32) as WorkerProfile;
  if (!WORKER_PROFILES.has(profile)) {
    throw new Error('Invalid worker profile: use "general", "coding", "research" or "review"');
  }
  return profile;
}

export function parseModelTier(value: unknown): ModelTier | undefined {
  if (value === undefined) return undefined;
  const tier = text(value, 'tier', 32) as ModelTier;
  if (!MODEL_TIERS.has(tier)) {
    throw new Error('Invalid model tier: use "fast", "balanced" or "strong"');
  }
  return tier;
}

export function parseStringArray(value: unknown, label: string, maxItems = 16, maxLen = 128): string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      value = JSON.parse(value.trim());
    } catch {
      // Fall through to validation error below.
    }
  }
  if (!Array.isArray(value) || value.length > maxItems || !value.every(item => typeof item === 'string')) {
    throw new Error(`${label} must be an array of at most ${maxItems} strings`);
  }
  return value.map(item => text(item, label, maxLen));
}

export function buildRunPluginDescription(home: string, allowedPlugins?: ReadonlySet<string>): string {
  const plugins = listPluginViews(home)
    .filter(p => p.enabled !== false && (!allowedPlugins || allowedPlugins.has(p.name)));
  const pluginList = plugins.length
    ? `Available plugins: ${plugins.map(p => {
        const detail = p.promptHint?.trim() || (p.actions.length ? p.actions.join(', ') : p.description.trim());
        return `"${p.name}"${detail ? ` (${detail})` : ''}`;
      }).join('; ')}.`
    : 'Call {action:"list"} to inspect available plugins under plugins/ or <home>/plugins/.';
  return `List or run local Node script plugins. Input JSON {action?: "list"|"run", plugin?, pluginAction?, args?}. ${pluginList}`;
}

export function buildVoiceTurnHint(
  home: string,
  deliveryChannel: string,
  allowedPlugins?: ReadonlySet<string>,
): { voiceModeConstraint?: string } {
  if (deliveryChannel !== 'xiaoai') return {};
  const enabledPlugins = listPluginViews(home)
    .filter(p => p.enabled !== false && (!allowedPlugins || allowedPlugins.has(p.name)) && (p.voiceFastpath || p.promptHint || p.actions.length))
    .map(p => `"${p.name}"${p.promptHint ? `(${p.promptHint})` : p.actions.length ? `[${p.actions.slice(0, 6).join(',')}]` : ''}`);
  const pluginClause = enabledPlugins.length
    ? `(4) 设备控制、定时提醒或即时查询优先直接调用匹配插件的 run_plugin（避免派发缓慢的 start_work Worker），已知可用插件：${enabledPlugins.join('；')}。闭合确认加 [[END]]，仅需消歧追问时加 [[LISTEN]]。`
    : '(4) 即时控制或状态查询优先直接调用匹配的 run_plugin，并在闭合确认后加 [[END]]，仅需追问确认时加 [[LISTEN]]。';
  const switchClause = allowedPlugins
    ? '1句话报核心结论'
    : '1句话报核心结论并询问切换到文字端，或按要求调用 switch_channel';
  return {
    voiceModeConstraint:
      `当前直连语音音箱TTS外放：(1) 普通回复与任务派发确认必须极致简短口语（<=25字）；(2) 期待用户继续说话/确认/追问时结尾必须加 [[LISTEN]]，严禁同时使用 [[END]]；本轮彻底结束时才以“。”结尾并加 [[END]]（控制标记必须紧贴写成双层方括号 [[END]] 或 [[LISTEN]]，严禁写成单括号 [END] 或带空格 [ [END] ]）；(3) 长篇内容或复杂报告严禁在音箱朗读，${switchClause}；${pluginClause}`,
  };
}

function stripHealthScaleRecordItems(record: unknown): unknown {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const rec = record as Record<string, unknown>;
  const { adcs: _adcs, rawPayload: _rawPayload, rawMeta: _rawMeta, ...rest } = rec;
  if (rest.metrics && typeof rest.metrics === 'object' && !Array.isArray(rest.metrics)) {
    const { items: _items, ...scalarMetrics } = rest.metrics as Record<string, unknown>;
    rest.metrics = scalarMetrics;
  }
  return rest;
}

function compactHealthScaleDashboard(dashboard: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...dashboard };
  if (next.latest !== undefined) {
    next.latest = stripHealthScaleRecordItems(next.latest);
  }
  if (Array.isArray(next.records)) {
    next.recordsCount = next.records.length;
    next.recentRecords = next.records.slice(0, 3).map(stripHealthScaleRecordItems);
    delete next.records;
  }
  return next;
}

/** Strips verbose per-indicator arrays and full measurement history from `health-scale` tool outputs for Router context efficiency. */
export function compactPluginResultForRouter(
  result: PluginRunResult,
  subAction: string,
  pluginArgs: Record<string, unknown>,
): PluginRunResult {
  if (
    result.plugin !== 'health-scale'
    || subAction === 'dashboard'
    || pluginArgs.includeRecords === true
    || !result.data
    || typeof result.data !== 'object'
    || Array.isArray(result.data)
  ) {
    return result;
  }
  const data = { ...(result.data as Record<string, unknown>) };
  if (data.session && typeof data.session === 'object' && !Array.isArray(data.session)) {
    const { notifications: _notifications, ...restSession } = data.session as Record<string, unknown>;
    data.session = restSession;
  }
  if (data.dashboard && typeof data.dashboard === 'object' && !Array.isArray(data.dashboard)) {
    data.dashboard = compactHealthScaleDashboard(data.dashboard as Record<string, unknown>);
    return { ...result, data };
  }
  return {
    ...result,
    data: compactHealthScaleDashboard(data),
  };
}

export interface RouterToolsHost {
  home: string;
  store: Store;
  im: ImGateway;
  isClosing: () => boolean;
  getTurn: () => RouterTurnScope | undefined;
  hasInboundHold: (origin?: MessageOrigin) => boolean;
  runs: Map<string, Run>;
  reportAutoDispatches: BoundedCounterMap;
  concurrentTasksInCwd: (cwd: string | undefined, excludeTaskId: string) => string[];
  newChatWork: (
    context: ChatRun,
    instruction: string,
    paths: string[],
    callId?: string,
    source?: Task,
    cwd?: string,
    extra?: {
      contextBrief?: string;
      memoryIds?: string[];
      profile?: WorkerProfile;
      modelTier?: ModelTier;
      workerModel?: string;
      attachments?: AttachmentView[];
    },
  ) => Promise<Task>;
  followup: (id: string, requestId: string, text: string) => Task;
  stop: (id: string) => Task;
  resume: (id: string, extendMs?: number) => Task;
  addTimer: (
    name: string,
    instruction: string,
    intervalMs?: number,
    cwd?: string,
    origin?: MessageOrigin,
    options?: AddTimerOptions,
  ) => import('../store.js').Timer;
  toggleTimer: (id: string, enabled: boolean) => import('../store.js').Timer;
  completeTimer?: (id: string, summary?: string) => import('../store.js').Timer;
  removeTimer: (id: string) => boolean;
  resolveChannelOrigin: (channelSpec: string, deliverTarget?: string) => MessageOrigin | undefined;
}

const ROUTE_TOOL_KINDS: Record<string, RouteKind> = {
  start_work: 'new_work',
  continue_work: 'followup',
  inspect_work: 'inspect',
  stop_work: 'stop',
  resume_work: 'resume',
  recall_messages: 'recall',
  search_memory: 'search_memory',
  save_memory: 'save_memory',
  manage_timer: 'timer',
  run_plugin: 'plugin',
  send_file: 'send_file',
  switch_channel: 'switch_channel',
};

function requireActiveChat(host: RouterToolsHost): ChatRun {
  const turn = host.getTurn();
  const context = turn?.chatContext ?? turn?.reportChatContext;
  if (!context || context.controller.signal.aborted || host.isClosing()) {
    throw new Error('No active main conversation request');
  }
  return context;
}

export function isOriginAccessible(
  callerOrigin?: MessageOrigin,
  targetOrigin?: MessageOrigin,
): boolean {
  if (!callerOrigin?.channel || callerOrigin.channel === 'local') return true;
  if (!targetOrigin?.channel || targetOrigin.channel === 'local') return false;
  if (targetOrigin.channel !== callerOrigin.channel) return false;
  if (callerOrigin.channelId && targetOrigin.channelId !== callerOrigin.channelId) return false;
  // The same Telegram sender may speak in private and in several shared chats.
  // Do not include private/other group history when preparing a group reply.
  if (callerOrigin.channel === 'telegram'
    && [callerOrigin.conversationId, targetOrigin.conversationId].some(id => id?.startsWith('-'))
    && callerOrigin.conversationId !== targetOrigin.conversationId) return false;
  if (callerOrigin.speakerRole === 'member' && targetOrigin.speakerRole !== 'member') return false;
  if (callerOrigin.speakerId && targetOrigin.speakerId && callerOrigin.speakerId !== targetOrigin.speakerId) {
    return false;
  }
  const callerPeer = callerOrigin.senderId ?? callerOrigin.conversationId;
  const targetPeer = targetOrigin.senderId ?? targetOrigin.conversationId;
  if (callerPeer && targetPeer) {
    return callerPeer === targetPeer;
  }
  if (callerPeer || targetPeer) return false;
  return Boolean(callerOrigin.channelId && callerOrigin.channelId === targetOrigin.channelId);
}

export function resolveReportChainKey(store: Store, task: Task): string {
  let cur: Task | undefined = task;
  const visited = new Set<string>();
  while (cur && !visited.has(cur.id)) {
    if (cur.originMessageId) return cur.originMessageId;
    visited.add(cur.id);
    if (!cur.parentTaskId) return cur.id;
    const parentId = cur.parentTaskId;
    try {
      cur = store.get(parentId);
    } catch {
      return parentId;
    }
  }
  return task.originMessageId ?? task.id;
}

function getCallerOrigin(host: RouterToolsHost, context: ChatRun): MessageOrigin | undefined {
  const turn = host.getTurn();
  return turn?.chatContext?.message.origin
    ?? turn?.activeReportTask?.origin
    ?? turn?.reportChatContext?.message.origin
    ?? context.message.origin;
}

function assertOriginAccessible(
  callerOrigin: MessageOrigin | undefined,
  targetOrigin: MessageOrigin | undefined,
  resourceLabel = '该任务或会话资源',
): void {
  if (!isOriginAccessible(callerOrigin, targetOrigin)) {
    throw new Error(`权限不足：当前 IM 会话无权访问或操作其他会话的${resourceLabel}`);
  }
}

function getValidatedWork(store: Store, context: ChatRun, id: string, callerOrigin?: MessageOrigin): Task {
  const task = store.get(id);
  assertOriginAccessible(callerOrigin, task.origin, '任务');
  if (context.revisions.get(task.id) !== task.revision) {
    throw new Error('Work changed or was stopped while Router was responding; inspect its current state before retrying');
  }
  return task;
}

export function buildToolRequestId(
  turn: RouterTurnScope | undefined,
  messageId: string,
  callId: string | undefined,
  kind: string,
): string {
  const scope = turn?.activeReportTask ? `${messageId}:report:${turn.activeReportTask.id}` : messageId;
  return createHash('sha256').update(JSON.stringify([scope, callId ?? randomUUID(), kind])).digest('hex');
}

export function createRouterTools(
  host: RouterToolsHost,
  requestIdFn: (messageId: string, callId: string | undefined, kind: string) => string,
  options?: RouterToolsOptions,
): AgentTool[] {
  const allowedPlugins = options?.allowedPlugins;
  const toolNames = options?.toolNames;
  const routeTool = async (name: string, input: string, callId: string, execute: () => Promise<string>): Promise<string> => {
    const turn = host.getTurn();
    if (turn?.chatContext) accrueChatRun(turn.chatContext);
    const context = turn?.chatContext
      ?? (turn?.reportChatContext && turn.activeReportTask?.originMessageId && name !== 'save_memory'
        ? turn.reportChatContext
        : undefined);
    const kind = ROUTE_TOOL_KINDS[name];
    if (!context || !kind) {
      const res = await execute();
      if (name === 'save_memory' && turn?.activeReportTask) {
        try {
          const parsed = JSON.parse(res) as { action?: string };
          if (!parsed.action || parsed.action === 'save') turn.reportTurnSavedMemory = true;
        } catch {
          turn.reportTurnSavedMemory = true;
        }
      }
      return res;
    }
    if (turn?.chatContext && !READONLY_ROUTER_TOOLS.has(name)) {
      const ctx = turn.chatContext;
      if (ctx.activeAttemptVersion !== undefined
        && (ctx.mergeVersion !== ctx.activeAttemptVersion || host.hasInboundHold(ctx.message.origin))) {
        throw new Error('Superseded by incoming message in same IM session');
      }
      ctx.hasSideEffectTool = true;
    }
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(input); } catch { /* Original tool validates its input. */ }
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
    const action: RouteAction = {
      id: randomUUID(),
      kind,
      status: 'pending',
      at: Date.now(),
      taskId: typeof args.taskId === 'string' ? args.taskId : undefined,
      searchQuery: name === 'search_memory' && typeof args.query === 'string' ? String(publicData(args.query.trim().slice(0, 160))) : undefined,
      workerProfile: typeof args.profile === 'string' && WORKER_PROFILES.has(args.profile as WorkerProfile) ? args.profile as WorkerProfile : undefined,
      modelTier: typeof args.tier === 'string' && MODEL_TIERS.has(args.tier as ModelTier) ? args.tier as ModelTier : undefined,
      workerModel: typeof args.model === 'string' && args.model.trim() ? String(publicData(args.model.trim().slice(0, 120))) : undefined,
    };
    if (action.taskId) {
      try {
        const targetTask = host.store.get(action.taskId);
        if (isOriginAccessible(getCallerOrigin(host, context), targetTask.origin)) {
          action.taskLabel = String(publicData(targetTask.prompt.slice(0, 240)));
        }
      } catch { /* The original tool reports unknown or invalid targets. */ }
    }
    const routeParent = turn?.routerTrace?.toolSpan(callId);
    if (typeof args.summary === 'string' && args.summary.trim()) {
      action.summary = String(publicData(args.summary.trim().slice(0, 240)));
    }
    host.store.conversation.routeAction(context.message.id, action, routeParent);
    try {
      const result = await execute();
      const value = JSON.parse(result) as Record<string, unknown>;
      action.status = 'accepted';
      action.taskId = typeof value.taskId === 'string' ? value.taskId : typeof value.id === 'string' && name === 'inspect_work' ? value.id : action.taskId;
      if (action.taskId) action.taskLabel = String(publicData(host.store.get(action.taskId).prompt.slice(0, 240)));
      if (typeof value.parentTaskId === 'string' || (name === 'start_work' && args.sourceTaskId)) {
        action.kind = 'related_work';
        action.parentTaskId = String(value.parentTaskId ?? args.sourceTaskId);
      }
      if (typeof value.profile === 'string' && WORKER_PROFILES.has(value.profile as WorkerProfile)) {
        action.workerProfile = value.profile as WorkerProfile;
      }
      if (typeof value.modelTier === 'string' && MODEL_TIERS.has(value.modelTier as ModelTier)) {
        action.modelTier = value.modelTier as ModelTier;
      }
      if (typeof value.thinkingLevel === 'string') {
        action.thinkingLevel = value.thinkingLevel as ThinkingLevel;
      }
      if (value.decisionSource === 'gemini-decision-1' || value.decisionSource === 'heuristic') {
        action.decisionSource = value.decisionSource;
      }
      if (typeof value.workerModel === 'string') action.workerModel = value.workerModel;
      if (Array.isArray(value.memoryIds)) {
        action.memoryIds = value.memoryIds.map(id => String(id)).filter(Boolean);
      }
      if (name === 'continue_work' && value.state === 'followup_accepted' && action.taskId) {
        action.followupId = requestIdFn(context.message.id, callId, 'followup');
        action.delivery = host.store.events(action.taskId).find(event => event.id === action.followupId)?.state ?? 'pending';
      }
      if (name === 'recall_messages') {
        action.messageIds = typeof value.id === 'string' ? [value.id] : Array.isArray(value.items)
          ? value.items.map(item => item && typeof item === 'object' && 'id' in item ? String((item as Record<string, unknown>).id) : '').filter(Boolean) : [];
      }
      if (name === 'search_memory' && Array.isArray(value.hits)) {
        const hits = value.hits as Array<Record<string, unknown>>;
        const memoryIds = hits.filter(hit => hit.kind === 'memory' && typeof hit.memoryId === 'string').map(hit => String(hit.memoryId));
        const messageIds = hits.filter(hit => hit.kind === 'message' && typeof hit.messageId === 'string').map(hit => String(hit.messageId));
        if (memoryIds.length) action.memoryIds = memoryIds;
        if (messageIds.length) action.messageIds = messageIds;
      }
      if (name === 'save_memory') {
        const memory = value.memory && typeof value.memory === 'object' ? value.memory as Record<string, unknown> : undefined;
        const id = typeof memory?.id === 'string' ? memory.id : typeof value.removedId === 'string' ? value.removedId : undefined;
        if (id) action.memoryIds = [id];
      }
      host.store.conversation.routeAction(context.message.id, action, routeParent);
      if (turn?.chatContext?.message.id === context.message.id) {
        reconcileRuntimeSessionAfterTool(host.store, context.message.id, name, action);
        turn.chatContext.message = host.store.conversation.get(context.message.id);
      }
      return result;
    } catch (error) {
      action.status = context.controller.signal.aborted ? 'interrupted' : 'failed';
      action.error = String(publicData(error instanceof Error ? error.message : 'Router tool failed'));
      host.store.conversation.routeAction(context.message.id, action, routeParent);
      throw error;
    }
  };

  const tools: AgentTool[] = [{
    name: 'dispatch_worker',
    description: 'Dispatch the host-selected task to its isolated Worker. Input is a confirmation, not a replacement task.',
    execute: async () => {
      const dispatch = host.getTurn()?.dispatch;
      if (!dispatch) throw new Error('No task is eligible for dispatch');
      return dispatch();
    },
  }, {
    name: 'start_work',
    description: 'Start an isolated background task; returns immediately. Input JSON: {instruction, cwd?, sourceMessageId?, sourceTaskId?, contextBrief?, memoryIds?, profile?: "general"|"coding"|"research"|"review"}. Omit cwd to reuse source/hint/service cwd; named host paths are enough without attachments. Pass contextBrief/memoryIds to supply recalled memories and profile for specialist Workers; Gemini Decision selects model/thinkingLevel. Native Workers have full local tools; snapshot/offline uses source files.',
    execute: async (input, callId) => {
      const turn = host.getTurn();
      const context = requireActiveChat(host);
      const callerOrigin = getCallerOrigin(host, context);
      const inReportTurn = !turn?.chatContext && Boolean(turn?.activeReportTask);
      const reportChainKey = inReportTurn ? resolveReportChainKey(host.store, turn!.activeReportTask!) : undefined;
      if (reportChainKey && host.reportAutoDispatches.get(reportChainKey) >= 2) {
        throw new Error('Autonomous supplementary dispatch limit (2) reached for this request; deliver current findings to the Boss before starting further tasks');
      }
      const args = toolInput(input, ['instruction', 'cwd', 'sourceMessageId', 'sourceTaskId', 'contextBrief', 'memoryIds', 'profile', 'tier', 'model', 'summary']);
      const instruction = text(args.instruction, 'instruction');
      if (args.sourceMessageId && args.sourceTaskId) throw new Error('Use one authorized source');
      const source = args.sourceTaskId
        ? getValidatedWork(host.store, context, text(args.sourceTaskId, 'sourceTaskId', 128), callerOrigin)
        : (inReportTurn && !args.sourceMessageId ? turn!.activeReportTask : undefined);
      if (source && ['queued', 'running'].includes(source.status) && source.id !== turn?.activeReportTask?.id) {
        throw new Error('Work is still active: use continue_work to append a follow-up instead of copying it');
      }
      if (source?.status === 'paused') throw new Error('Paused work cannot be automatically continued; ask the user to provide inputs for a new independent execution');
      let paths: string[] = context.message.paths;
      let attachments = resolveMessageAttachments(host.store, context.message);
      if (args.sourceMessageId) {
        const message = host.store.conversation.get(text(args.sourceMessageId, 'sourceMessageId', 128));
        assertOriginAccessible(callerOrigin, message.origin, '消息');
        if (message.role !== 'user') throw new Error('Only user messages authorize file paths');
        paths = message.paths;
        attachments = resolveMessageAttachments(host.store, message);
      } else if (!attachments.length && source) {
        attachments = resolveTaskAttachments(host.store, source);
      }
      const task = await host.newChatWork(
        context,
        instruction,
        paths,
        callId,
        source,
        args.cwd === undefined ? undefined : text(args.cwd, 'cwd', 4096),
        {
          contextBrief: args.contextBrief === undefined ? undefined : text(args.contextBrief, 'contextBrief', 16_384),
          memoryIds: parseStringArray(args.memoryIds, 'memoryIds'),
          profile: parseWorkerProfile(args.profile),
          modelTier: parseModelTier(args.tier),
          workerModel: args.model === undefined ? undefined : text(args.model, 'model', 160),
          attachments: attachments.length ? attachments : undefined,
        },
      );
      if (reportChainKey && turn) {
        host.reportAutoDispatches.increment(reportChainKey);
        turn.reportTurnDispatched = true;
      }
      const concurrentTaskIds = host.concurrentTasksInCwd(task.cwd, task.id);
      return JSON.stringify({
        taskId: task.id,
        ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
        state: task.status,
        execution: task.execution,
        cwd: task.cwd,
        ...(task.profile ? { profile: task.profile } : {}),
        ...(task.modelTier ? { modelTier: task.modelTier } : {}),
        ...(task.thinkingLevel ? { thinkingLevel: task.thinkingLevel } : {}),
        ...(task.decisionSource ? { decisionSource: task.decisionSource } : {}),
        ...(task.workerModel ? { workerModel: task.workerModel } : {}),
        ...(task.memoryIds?.length ? { memoryIds: task.memoryIds } : {}),
        ...(concurrentTaskIds.length ? { concurrentTaskIds, warning: 'Another active native work is operating in the same cwd' } : {}),
        note: 'Background work accepted, not completed',
      });
    },
  }, {
    name: 'continue_work',
    description: 'Append a follow-up to queued/running work, or start a related isolated execution from completed/failed/cancelled work (using current capabilities and prior report; Gemini Decision chooses model/thinkingLevel). Input JSON {taskId, instruction, cwd?, contextBrief?, memoryIds?, profile?: "general"|"coding"|"research"|"review"}. Paused/unknown work cannot be resumed automatically.',
    execute: async (input, callId) => {
      const turn = host.getTurn();
      const context = requireActiveChat(host);
      const callerOrigin = getCallerOrigin(host, context);
      const inReportTurn = !turn?.chatContext && Boolean(turn?.activeReportTask);
      const reportChainKey = inReportTurn ? resolveReportChainKey(host.store, turn!.activeReportTask!) : undefined;
      if (reportChainKey && host.reportAutoDispatches.get(reportChainKey) >= 2) {
        throw new Error('Autonomous supplementary dispatch limit (2) reached for this request; deliver current findings to the Boss before starting further tasks');
      }
      const args = toolInput(input, ['taskId', 'instruction', 'cwd', 'contextBrief', 'memoryIds', 'profile', 'tier', 'model', 'summary']);
      const task = getValidatedWork(host.store, context, text(args.taskId, 'taskId', 128), callerOrigin);
      const instruction = text(args.instruction, 'instruction');
      const contextBrief = args.contextBrief === undefined ? undefined : text(args.contextBrief, 'contextBrief', 16_384);
      const memoryIds = parseStringArray(args.memoryIds, 'memoryIds');
      const hasRealMessage = Boolean(turn?.chatContext || turn?.activeReportTask?.originMessageId);
      const inboundAttachments = resolveMessageAttachments(host.store, context.message);
      if (['queued', 'running'].includes(task.status)) {
        const compiledFollowup = contextBrief ? `${instruction}\n\n[Compiled Memory Context]: ${contextBrief}` : instruction;
        if (inboundAttachments.length) {
          const activeRun = host.runs.get(task.id);
          if (activeRun) {
            activeRun.attachments = dedupeAttachments([...(activeRun.attachments ?? []), ...inboundAttachments]);
            activeRun.pendingFollowupAttachments = dedupeAttachments([...(activeRun.pendingFollowupAttachments ?? []), ...inboundAttachments]);
          }
        }
        host.store.transaction(() => {
          if (memoryIds?.length) {
            const current = host.store.get(task.id);
            current.memoryIds = [...new Set([...(current.memoryIds ?? []), ...memoryIds])];
            host.store.save(current);
          }
          host.followup(task.id, requestIdFn(context.message.id, callId, 'followup'), compiledFollowup);
          if (hasRealMessage) host.store.conversation.link(context.message.id, task.id);
        });
        if (reportChainKey && turn) {
          host.reportAutoDispatches.increment(reportChainKey);
          turn.reportTurnDispatched = true;
        }
        return JSON.stringify({ taskId: task.id, state: 'followup_accepted', ...(memoryIds?.length ? { memoryIds } : {}) });
      }
      if (task.status === 'paused') throw new Error('Work is paused with unconfirmed progress; no automatic replay or resume');
      const resolvedAttachments = inboundAttachments.length ? inboundAttachments : resolveTaskAttachments(host.store, task);
      const next = await host.newChatWork(
        context,
        instruction,
        context.message.paths,
        callId,
        task,
        args.cwd === undefined ? undefined : text(args.cwd, 'cwd', 4096),
        {
          contextBrief: contextBrief ?? task.contextBrief,
          memoryIds: memoryIds ?? task.memoryIds,
          profile: parseWorkerProfile(args.profile) ?? task.profile,
          modelTier: parseModelTier(args.tier),
          workerModel: args.model === undefined ? undefined : text(args.model, 'model', 160),
          attachments: resolvedAttachments.length ? resolvedAttachments : undefined,
        },
      );
      if (reportChainKey && turn) {
        host.reportAutoDispatches.increment(reportChainKey);
        turn.reportTurnDispatched = true;
      }
      const concurrentTaskIds = host.concurrentTasksInCwd(next.cwd, next.id);
      return JSON.stringify({
        taskId: next.id,
        parentTaskId: task.id,
        state: next.status,
        execution: next.execution,
        cwd: next.cwd,
        ...(next.profile ? { profile: next.profile } : {}),
        ...(next.modelTier ? { modelTier: next.modelTier } : {}),
        ...(next.thinkingLevel ? { thinkingLevel: next.thinkingLevel } : {}),
        ...(next.decisionSource ? { decisionSource: next.decisionSource } : {}),
        ...(next.workerModel ? { workerModel: next.workerModel } : {}),
        ...(next.memoryIds?.length ? { memoryIds: next.memoryIds } : {}),
        ...(concurrentTaskIds.length ? { concurrentTaskIds, warning: 'Another active native work is operating in the same cwd' } : {}),
      });
    },
  }, {
    name: 'inspect_work',
    description: 'Read persisted work status and prior report. Input JSON {taskId}. This does not run a Worker or read new host files.',
    execute: async input => {
      const turn = host.getTurn();
      const context = requireActiveChat(host);
      const callerOrigin = getCallerOrigin(host, context);
      const args = toolInput(input, ['taskId', 'summary']);
      const task = host.store.get(text(args.taskId, 'taskId', 128));
      assertOriginAccessible(callerOrigin, task.origin, '任务');
      context.revisions.set(task.id, task.revision);
      if (turn?.chatContext || turn?.activeReportTask?.originMessageId) {
        host.store.conversation.link(context.message.id, task.id);
      }
      return JSON.stringify({
        id: task.id,
        prompt: task.prompt,
        status: task.status,
        mode: task.mode,
        reason: task.reason,
        report: task.report,
        execution: task.execution ?? 'snapshot',
        cwd: task.cwd,
        paths: task.paths,
        profile: task.profile,
        modelTier: task.modelTier,
        thinkingLevel: task.thinkingLevel,
        decisionSource: task.decisionSource,
        workerModel: task.workerModel,
        qualityGate: task.qualityGate,
        contextBrief: task.contextBrief,
        memoryIds: task.memoryIds,
        ...(task.pendingQuestion ? { pendingQuestion: task.pendingQuestion } : {}),
        files: task.files,
        followups: host.store.events(task.id).map(({ id, text, state }) => ({ id, text, state })),
      });
    },
  }, {
    name: 'recall_messages',
    description: 'Read older pages of the current transcript without starting a new session. Input JSON {beforeSeq?} for a truncated page, or {messageId} for full text.',
    execute: async input => {
      const context = requireActiveChat(host);
      const callerOrigin = getCallerOrigin(host, context);
      const args = toolInput(input, ['beforeSeq', 'messageId', 'summary']);
      const compact = (message: ChatMessage, full: boolean) => ({
        id: message.id,
        seq: message.seq,
        role: message.role,
        mode: message.mode,
        status: message.status,
        text: full ? message.text : message.text.slice(0, 4096),
        truncated: !full && message.text.length > 4096,
        taskIds: message.taskIds,
        fileCount: message.paths.length,
      });
      if (args.messageId) {
        const msg = host.store.conversation.get(text(args.messageId, 'messageId', 128));
        assertOriginAccessible(callerOrigin, msg.origin, '消息');
        return JSON.stringify(compact(msg, true));
      }
      const page = host.store.conversation.history(args.beforeSeq === undefined ? undefined : integer(args.beforeSeq, 0, 1, Number.MAX_SAFE_INTEGER));
      const visibleItems = callerOrigin?.channel && callerOrigin.channel !== 'local'
        ? page.items.filter(message => isOriginAccessible(callerOrigin, message.origin))
        : page.items;
      return JSON.stringify({ ...page, items: visibleItems.map(message => compact(message, false)) });
    },
  }, {
    name: 'search_memory',
    description: 'Search global context across semantic memories, work reports, and conversation history. Input JSON {query, scope?: "all"|"memories"|"works"|"messages", cwd?, limit?, includeSuperseded?}. Returns ranked hits with IDs for inspect_work/recall_messages.',
    execute: async input => {
      if (host.isClosing()) throw new Error('Service is shutting down');
      const args = toolInput(input, ['query', 'scope', 'cwd', 'limit', 'includeSuperseded', 'summary']);
      const query = text(args.query, 'query', 512);
      const scopeRaw = args.scope === undefined ? 'all' : text(args.scope, 'scope', 32);
      if (!['all', 'memories', 'works', 'messages'].includes(scopeRaw)) {
        throw new Error('Invalid search_memory scope: use "all", "memories", "works" or "messages"');
      }
      const result = await host.store.searchContextAsync({
        query,
        scope: scopeRaw as 'all' | 'memories' | 'works' | 'messages',
        cwd: args.cwd === undefined ? undefined : text(args.cwd, 'cwd', 4096),
        limit: integer(args.limit, 10, 1, 40),
        includeSuperseded: Boolean(args.includeSuperseded),
        touch: true,
      });
      return JSON.stringify(result);
    },
  }, {
    name: 'save_memory',
    description: 'Save durable knowledge/preferences/decisions to global memory (superseding matching outdated cards and linking synapses), or link/forget/pin cards. Input JSON {action?: "save"|"link"|"forget"|"pin"|"unpin", id?, targetId?, linkedMemoryIds?, topic?, content?, tags?, cwd?, sourceTaskId?, supersedeId?, pinned?}.',
    execute: async input => {
      if (host.isClosing()) throw new Error('Service is shutting down');
      const turn = host.getTurn();
      const args = toolInput(input, ['action', 'id', 'targetId', 'linkedMemoryIds', 'topic', 'content', 'tags', 'cwd', 'sourceTaskId', 'supersedeId', 'pinned', 'summary']);
      const action = args.action === undefined ? 'save' : text(args.action, 'action', 32);
      if (action === 'forget') {
        const id = text(args.id, 'id', 128);
        const removed = host.store.deleteMemory(id);
        return JSON.stringify({ action: 'forget', removedId: id, removed });
      }
      if (action === 'pin' || action === 'unpin') {
        const id = text(args.id, 'id', 128);
        const card = host.store.pinMemory(id, action === 'pin');
        return JSON.stringify({ action, memory: card });
      }
      if (action === 'link') {
        const id = text(args.id, 'id', 128);
        const targetId = text(args.targetId, 'targetId', 128);
        const linked = host.store.linkMemories(id, targetId, 'explicit');
        return JSON.stringify({ action: 'link', memory: linked.source, target: linked.target, memoryIds: [linked.source.id, linked.target.id] });
      }
      if (action !== 'save') throw new Error(`Unknown save_memory action: ${action}`);
      const card = await host.store.saveMemoryAsync({
        id: args.id === undefined ? undefined : text(args.id, 'id', 128),
        topic: text(args.topic, 'topic', 160),
        content: text(args.content, 'content', 8192),
        tags: parseStringArray(args.tags, 'tags', 16, 64),
        cwd: args.cwd === undefined ? undefined : text(args.cwd, 'cwd', 4096),
        sourceMessageId: turn?.chatContext?.message.id,
        sourceTaskId: args.sourceTaskId === undefined ? undefined : text(args.sourceTaskId, 'sourceTaskId', 128),
        supersedeId: args.supersedeId === undefined ? undefined : text(args.supersedeId, 'supersedeId', 128),
        pinned: args.pinned === undefined ? undefined : Boolean(args.pinned),
        linkedMemoryIds: parseStringArray(args.linkedMemoryIds, 'linkedMemoryIds', 12, 128),
      });
      return JSON.stringify({ action: 'save', memory: card });
    },
  }, {
    name: 'stop_work',
    description: 'Request cancellation of a specific work. Input JSON {taskId}. A stop request is not proof of completed cancellation; report the returned state faithfully.',
    execute: async input => {
      const turn = host.getTurn();
      const context = requireActiveChat(host);
      const callerOrigin = getCallerOrigin(host, context);
      const args = toolInput(input, ['taskId', 'summary']);
      const selected = getValidatedWork(host.store, context, text(args.taskId, 'taskId', 128), callerOrigin);
      if (turn?.chatContext || turn?.activeReportTask?.originMessageId) {
        host.store.conversation.link(context.message.id, selected.id);
      }
      const task = host.stop(selected.id);
      return JSON.stringify({ taskId: task.id, state: task.status, reason: task.reason });
    },
  }, {
    name: 'resume_work',
    description: 'Resume a paused work after explicit user confirmation. Input JSON {taskId, extendMs?}. Acknowledges unsettled prior operations, extends active execution budget, and resumes the Worker.',
    execute: async input => {
      const turn = host.getTurn();
      const context = requireActiveChat(host);
      const callerOrigin = getCallerOrigin(host, context);
      const args = toolInput(input, ['taskId', 'extendMs', 'summary']);
      const selected = getValidatedWork(host.store, context, text(args.taskId, 'taskId', 128), callerOrigin);
      if (turn?.chatContext || turn?.activeReportTask?.originMessageId) {
        host.store.conversation.link(context.message.id, selected.id);
      }
      const task = host.resume(selected.id, integer(args.extendMs, 600_000, 100, 86_400_000));
      context.revisions.set(task.id, task.revision);
      return JSON.stringify({ taskId: task.id, state: task.status, limitMs: task.limitMs, reason: task.reason });
    },
  }, {
    name: 'manage_timer',
    description: 'Manage persistent schedules, one-shot reminders, and goal-oriented routines. Input JSON {action: "add"|"list"|"toggle"|"complete"|"remove", id?, name?, instruction?, intervalMs?, delayMs?, dailyAt?, once?, plugin?, pluginAction?, deliverChannelId?, deliverTarget?, cwd?, enabled?, goalCondition?, maxFailures?, summary?}. Use delayMs (>=5000) or dailyAt ("HH:mm", +once:true) for timers, plugin/pluginAction for 0-token runs (>=60000ms), recurring AI timers require >=300000ms (max 20 enabled), and deliverChannelId/deliverTarget for IM. Set goalCondition for end-state goals (mutually exclusive with once) and call action="complete" (or emit [[GOAL_MET: summary]]) once verified.',
    execute: async input => {
      const turn = host.getTurn();
      const context = requireActiveChat(host);
      const callerOrigin = getCallerOrigin(host, context);
      const args = toolInput(input, ['action', 'id', 'name', 'instruction', 'intervalMs', 'delayMs', 'dailyAt', 'once', 'plugin', 'pluginAction', 'deliverChannelId', 'deliverTarget', 'cwd', 'enabled', 'goalCondition', 'maxFailures', 'summary']);
      const action = text(args.action, 'action', 32);
      if (action === 'list') {
        const timers = host.store.listTimers().filter(t => isOriginAccessible(callerOrigin, t.origin));
        return JSON.stringify({ timers });
      }
      if (action === 'add') {
        const deliverChannelId = args.deliverChannelId === undefined ? undefined : text(args.deliverChannelId, 'deliverChannelId', 128);
        const deliverTarget = args.deliverTarget === undefined ? undefined : text(args.deliverTarget, 'deliverTarget', 128);
        if (callerOrigin?.channel && callerOrigin.channel !== 'local' && (deliverChannelId || deliverTarget)) {
          const targetOrigin = host.resolveChannelOrigin(deliverChannelId ?? callerOrigin.channel, deliverTarget);
          assertOriginAccessible(callerOrigin, targetOrigin, '定时投递目标');
        }
        const pluginArg = args.plugin === undefined ? undefined : text(args.plugin, 'plugin', 64);
        const pluginActionArg = args.pluginAction === undefined ? undefined : text(args.pluginAction, 'pluginAction', 64);
        const onceArg = args.once === undefined ? undefined : Boolean(args.once);
        const dailyAtArg = args.dailyAt === undefined ? undefined : text(args.dailyAt, 'dailyAt', 16);
        const goalConditionArg = args.goalCondition === undefined ? undefined : text(args.goalCondition, 'goalCondition', 500);
        const maxFailuresArg = args.maxFailures === undefined
          ? undefined
          : integer(args.maxFailures, DEFAULT_TIMER_MAX_FAILURES, 1, MAX_TIMER_MAX_FAILURES);
        const defaultIntervalMs = (onceArg || args.delayMs !== undefined || dailyAtArg !== undefined)
          ? 60_000
          : (pluginArg ? CHAT_MIN_RECURRING_PLUGIN_INTERVAL_MS : CHAT_MIN_RECURRING_LLM_INTERVAL_MS);
        const intervalMs = integer(args.intervalMs, defaultIntervalMs, 1, MAX_TIMER_INTERVAL_MS);
        const delayMs = args.delayMs === undefined ? undefined : integer(args.delayMs, 60_000, 1, MAX_TIMER_INTERVAL_MS);
        const timer = host.addTimer(
          text(args.name ?? (onceArg || delayMs !== undefined ? '定时提醒' : '定时任务'), 'name', 120),
          text(args.instruction ?? (pluginArg ? `执行插件 ${pluginArg}/${pluginActionArg ?? 'status'}` : '定时巡检'), 'instruction'),
          intervalMs,
          args.cwd === undefined ? undefined : text(args.cwd, 'cwd', 4096),
          turn?.chatContext?.deliveryOrigin ?? turn?.chatContext?.message.origin ?? turn?.activeReportTask?.origin ?? context.message.origin,
          {
            dailyAt: dailyAtArg,
            delayMs,
            once: onceArg,
            plugin: pluginArg,
            pluginAction: pluginActionArg,
            deliverChannelId,
            deliverTarget,
            goalCondition: goalConditionArg,
            maxFailures: maxFailuresArg,
            enforceChatGuardrails: true,
          },
        );
        return JSON.stringify({ timer });
      }
      if (action === 'toggle') {
        const id = text(args.id, 'id', 128);
        const existing = host.store.getTimer(id);
        assertOriginAccessible(callerOrigin, existing.origin, '定时器');
        return JSON.stringify({ timer: host.toggleTimer(id, Boolean(args.enabled)) });
      }
      if (action === 'complete') {
        if (!host.completeTimer) {
          throw new Error('Timer completion is not supported by this host');
        }
        const id = text(args.id, 'id', 128);
        const existing = host.store.getTimer(id);
        assertOriginAccessible(callerOrigin, existing.origin, '定时器');
        const summary = args.summary === undefined ? undefined : text(args.summary, 'summary', 1000);
        return JSON.stringify({ timer: host.completeTimer(id, summary) });
      }
      if (action === 'remove') {
        const id = text(args.id, 'id', 128);
        const existing = host.store.getTimer(id);
        assertOriginAccessible(callerOrigin, existing.origin, '定时器');
        return JSON.stringify({ removed: host.removeTimer(id) });
      }
      throw new Error(`Unknown timer action: ${action}`);
    },
  }, {
    name: 'run_plugin',
    description: buildRunPluginDescription(host.home, allowedPlugins),
    execute: async input => {
      if (host.isClosing()) throw new Error('Service is shutting down');
      const args = toolInput(input, ['action', 'plugin', 'pluginAction', 'args', 'summary']);
      const rawAction = args.action === undefined ? undefined : text(args.action, 'action', 64).trim();
      const hasPlugin = args.plugin !== undefined;
      let mode: 'list' | 'run';
      let inferredSubAction: string | undefined;
      let inferredArgAction: string | undefined;
      if (rawAction === undefined) {
        mode = hasPlugin ? 'run' : 'list';
      } else if (rawAction === 'list' || rawAction === 'run') {
        mode = rawAction;
      } else if (hasPlugin) {
        mode = 'run';
        if (args.pluginAction === undefined) {
          inferredSubAction = rawAction;
        } else {
          inferredArgAction = rawAction;
        }
      } else {
        throw new Error(`Unknown run_plugin action: ${rawAction}`);
      }
      if (mode === 'list') {
        const plugins = listPluginViews(host.home)
          .filter(p => !allowedPlugins || allowedPlugins.has(p.name));
        return JSON.stringify({ plugins });
      }
      const pluginName = text(args.plugin, 'plugin', 64);
      if (allowedPlugins && !allowedPlugins.has(pluginName)) {
        throw new Error(`家庭成员会话无权调用插件 "${pluginName}"；仅允许公共智能家居插件`);
      }
      const manifest = listPluginsSync(host.home).find(p => p.name === pluginName);
      if (manifest && manifest.enabled === false) {
        throw new Error(`插件 "${pluginName}" 在当前平台或配置下已被禁用`);
      }
      const subAction = args.pluginAction === undefined
        ? (inferredSubAction ?? 'status')
        : text(args.pluginAction, 'pluginAction', 64);
      const pluginArgs = args.args && typeof args.args === 'object' && !Array.isArray(args.args)
        ? { ...(args.args as Record<string, unknown>) }
        : {};
      if (inferredArgAction && pluginArgs.action === undefined) {
        pluginArgs.action = inferredArgAction;
      }
      const turn = host.getTurn();
      const signal = turn?.chatContext?.attemptController?.signal ?? turn?.chatContext?.controller.signal;
      const result = await runPlugin(host.home, pluginName, subAction, pluginArgs, undefined, { signal });
      return JSON.stringify(compactPluginResultForRouter(result, subAction, pluginArgs));
    },
  }, {
    name: 'send_file',
    description: 'Send a file attachment via an authenticated IM attachment channel (WeChat or Telegram). Input JSON {name, content?}. Pass UTF-8 text/Markdown in content to stage and send directly without a Worker; omit content to send an existing staged file (1B..16MiB) from FRIDAY_WECHAT_ATTACHMENT_DIR or <home>/wechat-files. Never pass text/placeholder content for binary files (.jpg/.png/.mp4/.pdf/.xlsx etc.); omit content and pass the exact staged filename. On WeChat, images (.png/.jpg/.gif/.webp) and videos (.mp4/.mov) are automatically delivered as native image/video bubbles, while other extensions are sent as file attachments.',
    execute: async input => {
      if (host.isClosing()) throw new Error('Service is shutting down');
      const turn = host.getTurn();
      const args = toolInput(input, ['name', 'content', 'summary']);
      const fileName = text(args.name, 'name', 255);
      if (!fileName || fileName === '.' || fileName === '..' || basename(fileName) !== fileName || /[\\/\x00-\x1f]/.test(fileName)) {
        throw new Error('Invalid attachment name');
      }
      const currentOrigin = turn?.chatContext?.deliveryOrigin
        ?? turn?.chatContext?.message.origin
        ?? turn?.reportChatContext?.deliveryOrigin
        ?? turn?.reportChatContext?.message.origin
        ?? (turn?.activeReportTask ? host.runs.get(turn.activeReportTask.id)?.deliveryOrigin : undefined)
        ?? turn?.activeReportTask?.origin;
      const origin = (currentOrigin?.channel === 'wechat' || currentOrigin?.channel === 'telegram')
        ? currentOrigin
        : (!currentOrigin?.channel || currentOrigin.channel === 'local' || currentOrigin.channel === 'xiaoai')
          ? (host.resolveChannelOrigin('wechat') ?? host.resolveChannelOrigin('telegram'))
          : undefined;
      const target = origin?.channel === 'telegram'
        ? (origin.conversationId ?? origin.senderId)
        : origin?.senderId;
      if (!origin || (origin.channel !== 'wechat' && origin.channel !== 'telegram') || !origin.channelId || !target) {
        throw new Error('当前未找到可用的微信或 Telegram 会话/绑定通道，无法发送附件');
      }
      const outboxRoot = resolve(resolveEnv('FRIDAY_WECHAT_ATTACHMENT_DIR', 'SUPER_AGENT_WECHAT_ATTACHMENT_DIR') || join(host.home, 'wechat-files'));
      const targetPath = resolve(outboxRoot, fileName);
      if (!targetPath.startsWith(`${outboxRoot}${sep}`)) {
        throw new Error('Invalid attachment path');
      }
      if (args.content !== undefined) {
        if (BINARY_ATTACHMENT_EXTS.has(extname(fileName).toLowerCase())) {
          throw new Error(`禁止用纯文本 content 生成二进制附件 "${fileName}"（图片/视频/文档等必须由 Worker 写入真实二进制文件后，再仅传 {name} 发送）。`);
        }
        const contentText = text(args.content, 'content', 65_536);
        await mkdir(outboxRoot, { recursive: true, mode: 0o700 });
        const rootStat = await lstat(outboxRoot);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
          throw new Error('Outbox directory cannot be a symbolic link');
        }
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          handle = await open(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          await handle.writeFile(contentText, 'utf8');
        } catch (err) {
          const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
          if (code === 'EEXIST') throw new Error(`暂存区已存在同名文件 "${fileName}"，拒绝静默覆盖`);
          if (code === 'ELOOP') throw new Error('Outbox target cannot be a symbolic link');
          throw err;
        } finally {
          await handle?.close();
        }
      } else {
        try {
          await lstat(targetPath);
        } catch (err) {
          const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
          if (code === 'ENOENT') {
            let available: string[] = [];
            try {
              const entries = await readdir(outboxRoot, { withFileTypes: true });
              const filesWithMtime = await Promise.all(
                entries
                  .filter(entry => !entry.name.startsWith('.'))
                  .map(async entry => {
                    try {
                      const st = await lstat(join(outboxRoot, entry.name));
                      return { name: entry.name, mtimeMs: st.mtimeMs };
                    } catch {
                      return { name: entry.name, mtimeMs: 0 };
                    }
                  }),
              );
              available = filesWithMtime
                .sort((a, b) => b.mtimeMs - a.mtimeMs)
                .slice(0, 20)
                .map(item => item.name);
            } catch {
              available = [];
            }
            const listed = available.length > 0 ? available.join(', ') : '目录为空';
            throw new Error(`暂存目录中不存在 "${fileName}"。当前可用文件：${listed}。请直接使用准确文件名重试，不要虚构文件名或传 content 占位符。`);
          }
        }
      }
      if (origin.channel === 'telegram') {
        await host.im.sendTelegramAttachment(origin.channelId, fileName, {
          target,
          ...(origin.replyToMessageId ? { replyToMessageId: origin.replyToMessageId } : {}),
          ...(origin.messageThreadId !== undefined ? { messageThreadId: origin.messageThreadId } : {}),
        });
      } else {
        let currentChannelAccountId: string | undefined;
        let hasStoredChannel = false;
        try {
          currentChannelAccountId = host.store.getImChannel(origin.channelId).accountId;
          hasStoredChannel = true;
        } catch {
          hasStoredChannel = false;
        }
        if (hasStoredChannel && origin.accountId !== undefined && origin.accountId !== currentChannelAccountId) {
          throw new Error('微信账号已换绑，拒绝向旧会话发送附件；请从当前微信会话重新请求');
        }
        await host.im.sendWechatAttachment(origin.channelId, fileName, {
          target,
          contextToken: origin.contextToken,
        });
      }
      if (turn && !turn.chatContext && turn.activeReportTask) turn.reportTurnSentFile = true;
      return JSON.stringify({ sent: true, name: fileName, channel: origin.channel, target });
    },
  }, {
    name: 'switch_channel',
    description: 'Route the current turn reply and new tasks to another configured endpoint. Input JSON {channel, target?, voiceNotice?}.',
    execute: async input => {
      if (host.isClosing()) throw new Error('Service is shutting down');
      const turn = host.getTurn();
      const args = toolInput(input, ['channel', 'target', 'voiceNotice', 'summary']);
      const channelSpec = text(args.channel, 'channel', 128).trim();
      const targetSpec = args.target === undefined ? undefined : text(args.target, 'target', 128).trim();
      const prevOrigin = turn?.chatContext?.deliveryOrigin
        ?? turn?.chatContext?.message.origin
        ?? (turn?.activeReportTask ? host.runs.get(turn.activeReportTask.id)?.deliveryOrigin : undefined)
        ?? turn?.activeReportTask?.origin
        ?? turn?.reportChatContext?.deliveryOrigin
        ?? turn?.reportChatContext?.message.origin;
      const nextOrigin = host.resolveChannelOrigin(channelSpec, targetSpec);
      if (!nextOrigin) {
        throw new Error(`未找到已启用且匹配的 IM 通道: ${channelSpec}`);
      }
      if (turn?.chatContext) {
        turn.chatContext.hasSideEffectTool = true;
        turn.chatContext.deliveryOrigin = nextOrigin;
        if (turn.chatContext.replyId) {
          host.store.conversation.update(turn.chatContext.replyId, { origin: nextOrigin });
        }
      }
      if (turn?.reportChatContext) {
        turn.reportChatContext.deliveryOrigin = nextOrigin;
        if (turn.reportChatContext.replyId) {
          host.store.conversation.update(turn.reportChatContext.replyId, { origin: nextOrigin });
        }
      }
      if (turn?.activeReportTask) {
        const activeRun = host.runs.get(turn.activeReportTask.id);
        if (activeRun) {
          activeRun.deliveryOrigin = nextOrigin;
          if (activeRun.replyId) {
            host.store.conversation.update(activeRun.replyId, { origin: nextOrigin });
          }
        }
      }
      if (
        prevOrigin?.channel === 'xiaoai'
        && prevOrigin.channelId
        && prevOrigin.conversationId
        && (nextOrigin.channel !== 'xiaoai' || nextOrigin.channelId !== prevOrigin.channelId || nextOrigin.conversationId !== prevOrigin.conversationId)
      ) {
        const customNotice = args.voiceNotice === undefined ? '' : text(args.voiceNotice, 'voiceNotice', 200).trim();
        const defaultNotice = nextOrigin.channel === 'local'
          ? '好的，详细内容已转到网页端。'
          : nextOrigin.channel === 'wechat'
            ? '好的，详细内容已发到微信。'
            : '好的，详细内容已转到其他终端。';
        host.im.enqueueXiaoaiNotice?.(
          prevOrigin.channelId,
          prevOrigin.conversationId,
          customNotice || defaultNotice,
          prevOrigin,
        );
      }
      return JSON.stringify({
        switched: true,
        channel: nextOrigin.channel,
        channelId: nextOrigin.channelId,
        target: nextOrigin.conversationId,
      });
    },
  }];

  const selectedTools = toolNames ? tools.filter(tool => toolNames.has(tool.name)) : tools;
  return selectedTools.map(tool => ({
    ...tool,
    description: `${tool.description} Optional summary: one short public explanation of this action, not private reasoning.`,
    execute: (input: string, callId?: string) => {
      const stableId = callId ?? randomUUID();
      return routeTool(tool.name, input, stableId, () => tool.execute(input, stableId));
    },
  }));
}

export { imSessionKey, resolveRecentSessionImages };

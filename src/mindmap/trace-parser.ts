import type {
  MindmapJevQualityGateItem,
  MindmapJevRouteInfo,
  MindmapRouterToolCall,
  MindmapRouterTurn,
  MindmapTaskDetail,
  MindmapWorkerPhase,
  MindmapWorkerStep,
} from '../mindmap-types.js';
import type { Store, Task } from '../store.js';
import type { DecisionSource, MemoryCard, MessageOrigin, MissingAspect, ThinkingLevel, TraceEvent } from '../view.js';

const IMAGE_FILE_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i;
const SDK_META_SPANS = new Set(['Agent 请求', '模型推理调用', '上下文压缩（SDK）', '模型请求重试（SDK）']);

export function clipText(value: unknown, maxLen: number): { text: string; truncated: boolean } {
  const raw = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
  if (raw.length <= maxLen) return { text: raw, truncated: false };
  return { text: `${raw.slice(0, maxLen)}…`, truncated: true };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function unwrapJsonString(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try { return JSON.parse(trimmed); } catch { return raw; }
  }
  return raw;
}

export function formatToolInputPreview(rawData: unknown): string | undefined {
  const rec = asRecord(rawData);
  const detail = asRecord(rec?.detail) ?? rec;
  let input = detail?.input;
  const unwrapped = unwrapJsonString(input);
  const inner = asRecord(unwrapped);
  if (inner && typeof inner.input === 'string' && Object.keys(inner).length <= 2) {
    input = unwrapJsonString(inner.input);
  } else if (inner && typeof inner.command === 'string') {
    return clipText(inner.command, 420).text;
  } else if (inner && typeof inner.path === 'string') {
    const lineInfo = inner.offset || inner.limit ? ` (offset=${inner.offset ?? 1}, limit=${inner.limit ?? ''})` : '';
    return clipText(`${inner.path}${lineInfo}`, 300).text;
  } else if (unwrapped !== undefined) {
    input = unwrapped;
  }
  if (input === undefined) return undefined;
  return clipText(input, 420).text;
}

export function formatToolOutputPreview(rawData: unknown): string | undefined {
  const rec = asRecord(rawData);
  const detail = asRecord(rec?.detail) ?? rec;
  const rawPreview = detail?.preview ?? detail?.output;
  if (rawPreview === undefined) {
    const summary = asRecord(rec?.summary);
    return summary ? clipText(summary, 420).text : undefined;
  }
  const parsed = unwrapJsonString(rawPreview);
  const parsedRec = asRecord(parsed);
  if (parsedRec?.output && asRecord(parsedRec.output)?.content && Array.isArray(asRecord(parsedRec.output)?.content)) {
    const items = (asRecord(parsedRec.output)!.content as Array<Record<string, unknown>>)
      .map(c => (typeof c?.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
    if (items) return clipText(items, 520).text;
  }
  if (parsedRec?.content && Array.isArray(parsedRec.content)) {
    const items = (parsedRec.content as Array<Record<string, unknown>>)
      .map(c => (typeof c?.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
    if (items) return clipText(items, 520).text;
  }
  return clipText(parsed, 520).text;
}

function readUsageNumbers(
  rawUsage: unknown,
): { input: number; output: number; cacheRead: number; reasoning: number; totalTokens: number } | undefined {
  const u = asRecord(rawUsage);
  if (!u) return undefined;
  const input = Number(u.input ?? u.inputTokens ?? 0) || 0;
  const output = Number(u.output ?? u.outputTokens ?? 0) || 0;
  const cacheRead = Number(u.cacheRead ?? 0) || 0;
  const cacheWrite = Number(u.cacheWrite ?? 0) || 0;
  const reasoning = Number(u.reasoning ?? 0) || 0;
  const totalTokens = Number(u.totalTokens ?? input + output + cacheRead + cacheWrite) || 0;
  if (!totalTokens && !input && !output) return undefined;
  return { input, output, cacheRead, reasoning, totalTokens };
}

export function sanitizeOrigin(origin?: MessageOrigin): Omit<MessageOrigin, 'contextToken' | 'replyWebhook'> | undefined {
  if (!origin) return undefined;
  return {
    channel: origin.channel,
    ...(origin.channelId ? { channelId: origin.channelId } : {}),
    ...(origin.accountId ? { accountId: origin.accountId } : {}),
    ...(origin.conversationId ? { conversationId: origin.conversationId } : {}),
    ...(origin.senderId ? { senderId: origin.senderId } : {}),
    ...(origin.speakerId ? { speakerId: origin.speakerId } : {}),
    ...(origin.speakerName ? { speakerName: origin.speakerName } : {}),
    ...(origin.speakerRole ? { speakerRole: origin.speakerRole } : {}),
    ...(origin.replyToMessageId ? { replyToMessageId: origin.replyToMessageId } : {}),
  };
}

export function parseTimerTriggerName(text: string): string | undefined {
  const match = /^\[定时触发\s*·\s*([^\]]+)\]/.exec(text.trim());
  return match?.[1]?.trim();
}

export function extractTaskHeadline(prompt: string): string | undefined {
  const m = /【任务：([^】\n]+)】/.exec(prompt);
  const title = m?.[1]?.trim();
  if (!title) return undefined;
  return title.length <= 36 ? title : `${title.slice(0, 35)}…`;
}

/**
 * Reconstructs ordered Router reasoning/tool-call turns from a message flow's journal events.
 */
export function buildRouterTurns(events: TraceEvent[]): MindmapRouterTurn[] {
  const reqSpans = new Map<string, { start?: TraceEvent; end?: TraceEvent }>();
  const llmSpans = new Map<string, { start?: TraceEvent; end?: TraceEvent }>();
  const toolSpans = new Map<string, { start?: TraceEvent; end?: TraceEvent }>();
  const orderedReqIds: string[] = [];

  for (const ev of events) {
    if (ev.actor !== 'router' || ev.type !== 'trace' || ev.kind !== 'span' || !ev.spanId) continue;
    if (ev.label === 'Agent 请求') {
      const entry = reqSpans.get(ev.spanId) ?? {};
      if (ev.status === 'started') {
        if (!reqSpans.has(ev.spanId)) orderedReqIds.push(ev.spanId);
        entry.start = ev;
      } else {
        if (!reqSpans.has(ev.spanId)) orderedReqIds.push(ev.spanId);
        entry.end = ev;
      }
      reqSpans.set(ev.spanId, entry);
    } else if (ev.label === '模型推理调用') {
      const entry = llmSpans.get(ev.spanId) ?? {};
      if (ev.status === 'started') entry.start = ev; else entry.end = ev;
      llmSpans.set(ev.spanId, entry);
    } else if (!SDK_META_SPANS.has(ev.label)) {
      const entry = toolSpans.get(ev.spanId) ?? {};
      if (ev.status === 'started') entry.start = ev; else entry.end = ev;
      toolSpans.set(ev.spanId, entry);
    }
  }

  const turnsById = new Map<string, MindmapRouterTurn>();
  for (const reqId of orderedReqIds) {
    const pair = reqSpans.get(reqId)!;
    const startData = asRecord(pair.start?.data);
    const trigger = asRecord(startData?.trigger);
    const endData = asRecord(pair.end?.data);
    const startedAt = pair.start?.at ?? pair.end?.at ?? 0;
    const endedAt = pair.end?.at;
    const triggerTaskId = typeof trigger?.taskId === 'string' && trigger.taskId
      ? trigger.taskId
      : (pair.start?.taskId ?? pair.end?.taskId);
    turnsById.set(reqId, {
      spanId: reqId,
      triggerKind: typeof trigger?.kind === 'string' ? trigger.kind : 'CHAT',
      ...(triggerTaskId ? { triggerTaskId } : {}),
      startedAt,
      endedAt,
      durationMs: endedAt && startedAt ? Math.max(0, endedAt - startedAt) : undefined,
      status: pair.end?.status ?? pair.start?.status ?? 'started',
      llmTurns: 0,
      usage: undefined,
      outputPreview: typeof endData?.output === 'string' ? clipText(endData.output, 360).text : undefined,
      tools: [],
    });
  }

  // Associate LLM turn metrics with their parent Agent 请求
  for (const pair of llmSpans.values()) {
    const parentId = pair.end?.parentSpanId ?? pair.start?.parentSpanId;
    const turn = parentId ? turnsById.get(parentId) : undefined;
    if (!turn) continue;
    turn.llmTurns += 1;
    const detail = asRecord(asRecord(pair.end?.data)?.detail);
    const u = readUsageNumbers(detail?.usage);
    if (u) {
      const cur = turn.usage ?? { input: 0, output: 0, cacheRead: 0, reasoning: 0, totalTokens: 0 };
      turn.usage = {
        input: cur.input + u.input,
        output: cur.output + u.output,
        cacheRead: cur.cacheRead + u.cacheRead,
        reasoning: cur.reasoning + u.reasoning,
        totalTokens: cur.totalTokens + u.totalTokens,
      };
    }
  }

  // Map LLM spanId -> Agent 请求 spanId so tool calls resolve to their owning Router turn
  const llmToReq = new Map<string, string>();
  for (const [lid, pair] of llmSpans.entries()) {
    const pid = pair.end?.parentSpanId ?? pair.start?.parentSpanId;
    if (pid && turnsById.has(pid)) llmToReq.set(lid, pid);
  }

  for (const [tid, pair] of toolSpans.entries()) {
    const first = pair.start ?? pair.end!;
    const last = pair.end ?? pair.start!;
    const parentId = first.parentSpanId ?? '';
    const reqId = turnsById.has(parentId) ? parentId : llmToReq.get(parentId) ?? orderedReqIds[0];
    const turn = reqId ? turnsById.get(reqId) : undefined;
    const startAt = pair.start?.at ?? last.at;
    const endAt = pair.end?.at;
    const toolCall: MindmapRouterToolCall = {
      spanId: tid,
      toolName: first.label,
      status: last.status,
      at: startAt,
      durationMs: endAt && startAt ? Math.max(0, endAt - startAt) : undefined,
      inputPreview: formatToolInputPreview(pair.start?.data),
      outputPreview: formatToolOutputPreview(pair.end?.data),
    };
    if (turn) {
      turn.tools.push(toolCall);
    } else {
      const syntheticId = `synthetic:${first.at}`;
      const existing = turnsById.get(syntheticId);
      if (existing) {
        existing.tools.push(toolCall);
        existing.status = last.status;
      } else {
        const synthetic: MindmapRouterTurn = {
          spanId: syntheticId,
          triggerKind: 'CHAT',
          startedAt: startAt,
          status: last.status,
          llmTurns: 0,
          tools: [toolCall],
        };
        turnsById.set(syntheticId, synthetic);
      }
    }
  }

  return [...turnsById.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Reconstructs detailed JEV routing, execution phases, worker steps, and quality-gate
 * telemetry for a single background task.
 */
export function buildTaskDetail(
  store: Store,
  task: Task,
  taskEvents: TraceEvent[],
  routerTurns: MindmapRouterTurn[],
  claimedReportSpans: Set<string>,
  memoryById: Map<string, MemoryCard>,
): MindmapTaskDetail {
  const ops = store.operations(task.id);
  const opsById = new Map(ops.map(op => [op.id, op]));
  const followups = store.events(task.id);
  const succeededOps = ops.filter(op => op.status === 'succeeded').length;
  const failedOps = ops.filter(op => op.status === 'failed' || op.status === 'unknown').length;

  // 1) JEV 选模信息
  const routeSpan = taskEvents.find(ev => ev.spanId === `${task.id}:decision:route` || ev.label === 'Gemini Decision 1 选模定级');
  const routeData = asRecord(routeSpan?.data);
  const routeReq = asRecord(routeData?.request);
  const hasImages = (task.paths ?? []).some(p => IMAGE_FILE_RE.test(p))
    || task.files.some(f => IMAGE_FILE_RE.test(f.name))
    || IMAGE_FILE_RE.test(task.prompt);

  const jevRoute: MindmapJevRouteInfo | undefined = (routeSpan || task.decisionSource || task.workerModel)
    ? {
        called: Boolean(routeSpan || task.decisionSource),
        source: (routeData?.source as DecisionSource | undefined) ?? task.decisionSource ?? 'tier-config',
        status: routeSpan?.status === 'fallback'
          ? 'fallback'
          : (routeData?.source === 'gemini-decision-1' || task.decisionSource === 'gemini-decision-1')
            ? 'completed'
            : (routeData?.source === 'heuristic' || task.decisionSource === 'heuristic')
              ? 'fallback'
              : 'static',
        at: routeSpan?.at ?? task.createdAt,
        request: {
          endpoint: typeof routeReq?.endpoint === 'string' ? routeReq.endpoint : '/v1beta/decisions',
          decisionModel: typeof routeReq?.decisionModel === 'string' ? routeReq.decisionModel : 'gemini-decision-1',
          profile: typeof routeReq?.profile === 'string' ? routeReq.profile : (task.profile ?? 'general'),
          ...(typeof routeReq?.preferredTier === 'string' ? { preferredTier: routeReq.preferredTier } : task.modelTier ? { preferredTier: task.modelTier } : {}),
          ...(typeof routeReq?.preferredLevel === 'string' ? { preferredLevel: routeReq.preferredLevel } : {}),
          fileCount: typeof routeReq?.fileCount === 'number' ? routeReq.fileCount : (task.paths?.length || task.files.length),
          hasImages: typeof routeReq?.hasImages === 'boolean' ? routeReq.hasImages : hasImages,
          isTimer: typeof routeReq?.isTimer === 'boolean' ? routeReq.isTimer : task.requestId.startsWith('timer:'),
          ...(typeof routeReq?.candidateCount === 'number' ? { candidateCount: routeReq.candidateCount } : {}),
          ...(Array.isArray(routeReq?.excludedSpecs) ? { excludedSpecs: routeReq.excludedSpecs.map(String) } : {}),
          ...(Array.isArray(routeReq?.excludedProviders) ? { excludedProviders: routeReq.excludedProviders.map(String) } : {}),
          instructionPreview: typeof routeReq?.instructionPreview === 'string'
            ? routeReq.instructionPreview
            : clipText(task.prompt, 240).text,
        },
        response: {
          selectedModel: (typeof routeData?.model === 'string' ? routeData.model : undefined) ?? task.workerModel,
          modelTier: task.modelTier,
          thinkingLevel: (routeData?.thinkingLevel as ThinkingLevel | undefined) ?? task.thinkingLevel,
          confidence: typeof routeData?.confidence === 'number' ? routeData.confidence : task.decisionConfidence,
          needsQualityGate: typeof routeData?.needsQualityGate === 'boolean'
            ? routeData.needsQualityGate
            : (task.skipQualityGate ? false : undefined),
          needsQualityGateProb: typeof routeData?.needsQualityGateProb === 'number' ? routeData.needsQualityGateProb : undefined,
          usage: asRecord(routeData?.usage)
            ? {
                inputTokens: Number(asRecord(routeData?.usage)?.inputTokens ?? 0),
                totalTokens: Number(asRecord(routeData?.usage)?.totalTokens ?? 0),
              }
            : undefined,
          fallbackReason: typeof routeData?.fallbackReason === 'string' ? routeData.fallbackReason : undefined,
        },
      }
    : undefined;

  // 2) JEV 完成度质检 Spans（支持同一任务多轮质检）
  const qualitySpans = taskEvents.filter(ev => ev.spanId === `${task.id}:decision:quality` || ev.label === 'Gemini Decision 1 完成度评估');
  const jevQualityGates: MindmapJevQualityGateItem[] = [];
  if (qualitySpans.length) {
    qualitySpans.forEach((qs, idx) => {
      const d = asRecord(qs.data);
      const qReq = asRecord(d?.request);
      const src = (d?.source as DecisionSource | undefined) ?? 'heuristic';
      jevQualityGates.push({
        index: idx + 1,
        at: qs.at,
        source: src,
        status: qs.status === 'fallback' ? 'fallback' : d?.skippedByRoute ? 'skipped' : 'completed',
        request: {
          endpoint: typeof qReq?.endpoint === 'string' ? qReq.endpoint : '/v1beta/decisions',
          decisionModel: typeof qReq?.decisionModel === 'string' ? qReq.decisionModel : 'gemini-decision-1',
          profile: typeof qReq?.profile === 'string' ? qReq.profile : (task.profile ?? 'general'),
          succeededOps: typeof qReq?.succeededOps === 'number' ? qReq.succeededOps : succeededOps,
          failedOps: typeof qReq?.failedOps === 'number' ? qReq.failedOps : failedOps,
          followupCount: typeof qReq?.followupCount === 'number' ? qReq.followupCount : followups.length,
          reportLength: typeof qReq?.reportLength === 'number' ? qReq.reportLength : (task.report?.length ?? 0),
          skipRemote: typeof qReq?.skipRemote === 'boolean' ? qReq.skipRemote : Boolean(task.skipQualityGate),
        },
        response: {
          score: Number(d?.score ?? 0),
          maxScore: Number(d?.maxScore ?? 3),
          confidence: Number(d?.confidence ?? 0),
          supplementProbability: Number(d?.supplementProbability ?? 0),
          shouldSupplement: Boolean(d?.shouldSupplement),
          missingAspect: (d?.missingAspect as MissingAspect | undefined) ?? 'none',
          ...(d?.skippedByRoute ? { skippedByRoute: true } : {}),
          usage: asRecord(d?.usage)
            ? {
                inputTokens: Number(asRecord(d?.usage)?.inputTokens ?? 0),
                totalTokens: Number(asRecord(d?.usage)?.totalTokens ?? 0),
              }
            : undefined,
          fallbackReason: typeof d?.fallbackReason === 'string' ? d.fallbackReason : undefined,
        },
      });
    });
  } else if (task.qualityGate) {
    const qg = task.qualityGate;
    jevQualityGates.push({
      index: 1,
      at: qg.evaluatedAt,
      source: qg.source,
      status: qg.skippedByRoute ? 'skipped' : qg.source === 'gemini-decision-1' ? 'completed' : 'fallback',
      request: {
        endpoint: '/v1beta/decisions',
        decisionModel: 'gemini-decision-1',
        profile: task.profile ?? 'general',
        succeededOps,
        failedOps,
        followupCount: followups.length,
        reportLength: task.report?.length ?? 0,
        skipRemote: Boolean(task.skipQualityGate),
      },
      response: {
        score: qg.score,
        maxScore: qg.maxScore,
        confidence: qg.confidence,
        supplementProbability: qg.supplementProbability,
        shouldSupplement: qg.shouldSupplement,
        missingAspect: qg.missingAspect,
        ...(qg.skippedByRoute ? { skippedByRoute: true } : {}),
      },
    });
  }

  // 3) Worker 执行阶段与步骤：推理轮次 + 工具操作 + ASK_BOSS + Followup
  const workerPhaseSpans = new Map<string, { spanId: string; start?: TraceEvent; end?: TraceEvent }>();
  const allSteps: MindmapWorkerStep[] = [];
  const workerLlm = new Map<string, { start?: TraceEvent; end?: TraceEvent }>();
  const workerTools = new Map<string, { start?: TraceEvent; end?: TraceEvent }>();

  for (const ev of taskEvents) {
    if (ev.actor === 'worker' && ev.type === 'trace' && ev.kind === 'span' && ev.spanId) {
      if (ev.label === 'Agent 请求') {
        const entry = workerPhaseSpans.get(ev.spanId) ?? { spanId: ev.spanId };
        if (ev.status === 'started') entry.start = ev; else entry.end = ev;
        workerPhaseSpans.set(ev.spanId, entry);
      } else if (ev.label === '模型推理调用') {
        const entry = workerLlm.get(ev.spanId) ?? {};
        if (ev.status === 'started') entry.start = ev; else entry.end = ev;
        workerLlm.set(ev.spanId, entry);
      } else if (!SDK_META_SPANS.has(ev.label)) {
        const entry = workerTools.get(ev.spanId) ?? {};
        if (ev.status === 'started') entry.start = ev; else entry.end = ev;
        workerTools.set(ev.spanId, entry);
      }
    } else if (ev.kind === 'task_state' && (ev.status === 'waiting_decision' || ev.status === 'decision_received')) {
      const d = asRecord(ev.data);
      allSteps.push({
        id: ev.id,
        kind: 'ask_boss',
        at: ev.at,
        status: ev.status,
        title: ev.status === 'waiting_decision' ? 'ASK_BOSS 挂起请示老板' : '收到老板拍板继续推进',
        outputPreview: typeof d?.reason === 'string'
          ? clipText(d.reason, 400).text
          : typeof d?.text === 'string'
            ? clipText(d.text, 400).text
            : undefined,
      });
    }
  }

  const rawPhases = [...workerPhaseSpans.values()]
    .map(p => ({
      spanId: p.spanId,
      startedAt: p.start?.at ?? p.end?.at ?? task.createdAt,
      endedAt: p.end?.at,
      status: p.end?.status ?? p.start?.status ?? task.status,
    }))
    .sort((a, b) => a.startedAt - b.startedAt);

  let llmIdx = 0;
  const sortedLlm = [...workerLlm.values()].sort((a, b) => (a.start?.at ?? a.end?.at ?? 0) - (b.start?.at ?? b.end?.at ?? 0));
  for (const pair of sortedLlm) {
    llmIdx += 1;
    const first = pair.start ?? pair.end!;
    const last = pair.end ?? pair.start!;
    const detail = asRecord(asRecord(pair.end?.data)?.detail);
    const summary = asRecord(asRecord(pair.end?.data)?.summary);
    const usage = readUsageNumbers(detail?.usage);
    const stopReason = typeof detail?.stopReason === 'string' ? detail.stopReason : undefined;
    const pubText = typeof summary?.publicText === 'string' ? summary.publicText : undefined;
    allSteps.push({
      id: last.spanId ?? last.id,
      kind: 'llm_turn',
      at: first.at,
      durationMs: pair.end && pair.start ? Math.max(0, pair.end.at - pair.start.at) : undefined,
      status: last.status,
      title: `Worker 第 ${llmIdx} 轮推理`,
      usage,
      stopReason,
      outputPreview: pubText ? clipText(pubText, 320).text : undefined,
    });
  }

  const sortedTools = [...workerTools.values()].sort((a, b) => (a.start?.at ?? a.end?.at ?? 0) - (b.start?.at ?? b.end?.at ?? 0));
  for (const pair of sortedTools) {
    const first = pair.start ?? pair.end!;
    const last = pair.end ?? pair.start!;
    const callSuffix = first.spanId?.includes(':') ? first.spanId.slice(first.spanId.indexOf(':') + 1) : '';
    const candidateOpId = callSuffix ? `${task.id}:${callSuffix}` : '';
    const matchedOp = opsById.get(candidateOpId)
      ?? ops.find(o => o.parentSpanId && o.parentSpanId === first.spanId);
    allSteps.push({
      id: first.spanId ?? first.id,
      kind: 'tool_call',
      at: first.at,
      durationMs: pair.end && pair.start ? Math.max(0, pair.end.at - pair.start.at) : undefined,
      status: last.status,
      title: `工具 · ${first.label}`,
      toolName: first.label,
      operationId: matchedOp?.id,
      hasFullOperation: Boolean(matchedOp?.result),
      inputPreview: formatToolInputPreview(pair.start?.data),
      outputPreview: formatToolOutputPreview(pair.end?.data) ?? (matchedOp?.result ? clipText(matchedOp.result, 520).text : undefined) ?? matchedOp?.error,
    });
  }

  if (sortedTools.length === 0 && ops.length > 0) {
    ops.forEach((op, idx) => {
      allSteps.push({
        id: op.id,
        kind: 'tool_call',
        at: task.createdAt + idx + 1,
        status: op.status,
        title: op.fileId.startsWith('native:') ? `工具 · ${op.fileId.slice(7)}` : `读取文件 · ${op.fileId}`,
        toolName: op.fileId.startsWith('native:') ? op.fileId.slice(7) : 'read_file',
        operationId: op.id,
        hasFullOperation: Boolean(op.result),
        inputPreview: task.files.find(f => f.id === op.fileId)?.name ?? op.fileId,
        outputPreview: op.result ? clipText(op.result, 420).text : op.error,
      });
    });
  }

  followups.forEach((f, idx) => {
    const targetPhase = rawPhases[idx + 1];
    allSteps.push({
      id: `followup:${f.id}`,
      kind: 'followup',
      at: targetPhase ? Math.max(task.createdAt + 1, targetPhase.startedAt - 1) : task.createdAt + 1,
      status: f.state,
      title: '追加补充指令 (Follow-up)',
      inputPreview: clipText(f.text, 400).text,
    });
  });

  allSteps.sort((a, b) => a.at - b.at);

  const executionPhases: MindmapWorkerPhase[] = [];
  if (rawPhases.length > 0) {
    rawPhases.forEach((rp, pIdx) => {
      const phaseIndex = pIdx + 1;
      const winStart = pIdx === 0 ? Number.NEGATIVE_INFINITY : rp.startedAt;
      const nextPhaseStart = rawPhases[pIdx + 1]?.startedAt ?? Number.POSITIVE_INFINITY;
      let llmCount = 0;
      let toolCount = 0;
      for (const step of allSteps) {
        if (step.at >= winStart && step.at < nextPhaseStart) {
          step.phaseIndex = phaseIndex;
          if (step.kind === 'llm_turn') llmCount += 1;
          else if (step.kind === 'tool_call') toolCount += 1;
        }
      }
      const matchedQg = jevQualityGates.find(qg => qg.at >= (pIdx === 0 ? rp.startedAt : winStart) - 500 && qg.at < nextPhaseStart);
      const phaseEndBoundary = rp.endedAt ?? matchedQg?.at ?? rp.startedAt;
      const matchedReportTurn = routerTurns.find(rt => {
        if (claimedReportSpans.has(rt.spanId)) return false;
        if (rt.triggerKind !== 'WORKER_REPORT') return false;
        if (rt.triggerTaskId) return rt.triggerTaskId === task.id;
        return rt.startedAt >= phaseEndBoundary - 1500 && rt.startedAt <= nextPhaseStart + 2500;
      });
      if (matchedReportTurn) claimedReportSpans.add(matchedReportTurn.spanId);

      const followupForPhase = pIdx > 0 ? followups[pIdx - 1] : undefined;
      executionPhases.push({
        index: phaseIndex,
        spanId: rp.spanId,
        isFollowup: pIdx > 0,
        ...(followupForPhase ? { followupPrompt: clipText(followupForPhase.text, 320).text } : {}),
        startedAt: rp.startedAt,
        ...(rp.endedAt !== undefined ? { endedAt: rp.endedAt, durationMs: Math.max(0, rp.endedAt - rp.startedAt) } : {}),
        status: rp.status,
        llmCount,
        toolCount,
        ...(matchedQg ? { qualityGateIndex: matchedQg.index } : {}),
        ...(matchedReportTurn ? { routerReportSpanId: matchedReportTurn.spanId } : {}),
      });
    });
  } else {
    let llmCount = 0;
    let toolCount = 0;
    for (const step of allSteps) {
      step.phaseIndex = 1;
      if (step.kind === 'llm_turn') llmCount += 1;
      else if (step.kind === 'tool_call') toolCount += 1;
    }
    const fallbackEnd = allSteps.at(-1)?.at ?? (task.createdAt + Math.round(task.activeMs));
    const matchedReportTurn = routerTurns.find(rt => {
      if (claimedReportSpans.has(rt.spanId)) return false;
      if (rt.triggerKind !== 'WORKER_REPORT') return false;
      if (rt.triggerTaskId) return rt.triggerTaskId === task.id;
      return true;
    });
    if (matchedReportTurn) claimedReportSpans.add(matchedReportTurn.spanId);
    executionPhases.push({
      index: 1,
      isFollowup: false,
      startedAt: task.createdAt,
      endedAt: fallbackEnd,
      durationMs: Math.max(0, Math.round(task.activeMs)),
      status: task.status,
      llmCount,
      toolCount,
      ...(jevQualityGates[0] ? { qualityGateIndex: jevQualityGates[0].index } : {}),
      ...(matchedReportTurn ? { routerReportSpanId: matchedReportTurn.spanId } : {}),
    });
  }

  const MAX_STEPS = 45;
  const omittedSteps = Math.max(0, allSteps.length - MAX_STEPS);
  const visibleSteps = omittedSteps > 0 ? [...allSteps.slice(0, 12), ...allSteps.slice(-(MAX_STEPS - 12))] : allSteps;

  const compiledMemories = (task.memoryIds ?? [])
    .map(id => memoryById.get(id))
    .filter((c): c is MemoryCard => Boolean(c))
    .map(c => ({ id: c.id, topic: c.topic, tags: c.tags, preview: clipText(c.content, 200).text }));

  const clippedPrompt = clipText(task.prompt, 1600);
  const clippedReport = task.report ? clipText(task.report, 1600) : undefined;

  return {
    id: task.id,
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    prompt: clippedPrompt.text,
    ...(clippedPrompt.truncated ? { promptTruncated: true } : {}),
    status: task.status,
    ...(task.reason ? { reason: clipText(task.reason, 400).text } : {}),
    ...(task.profile ? { profile: task.profile } : {}),
    ...(task.execution ? { execution: task.execution } : {}),
    ...(task.cwd ? { cwd: task.cwd } : {}),
    createdAt: task.createdAt,
    activeMs: Math.round(task.activeMs),
    limitMs: task.limitMs,
    ...(task.contextBrief ? { contextBrief: clipText(task.contextBrief, 800).text } : {}),
    compiledMemories,
    jevRoute,
    executionPhases,
    workerSteps: visibleSteps,
    totalSteps: allSteps.length,
    omittedSteps,
    succeededOps,
    failedOps,
    jevQualityGates,
    ...(clippedReport ? { reportPreview: clippedReport.text, ...(clippedReport.truncated ? { reportTruncated: true } : {}) } : {}),
  };
}

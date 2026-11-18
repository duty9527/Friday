import type { Coordinator } from '../coordinator.js';
import type {
  MindmapConsolidatedMemory,
  MindmapDeliveryItem,
  MindmapRecalledItem,
  MindmapSession,
  MindmapSessionTurnSummary,
  MindmapSnapshot,
  MindmapTaskFlow,
} from '../mindmap-types.js';
import type { Task } from '../store.js';
import type { ChatMessage, MemoryCard, MessageOrigin, TraceEvent } from '../view.js';
import {
  asRecord,
  buildRouterTurns,
  buildTaskDetail,
  clipText,
  extractTaskHeadline,
  parseTimerTriggerName,
  sanitizeOrigin,
  unwrapJsonString,
} from './trace-parser.js';

const SAFE_PAYLOAD_BYTES = 2_100_000;

function synthesizeSessionTitle(turns: MindmapTaskFlow[]): string {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    for (const t of turns[i]!.tasks) {
      const headline = extractTaskHeadline(t.prompt);
      if (headline) return headline;
    }
  }
  const first = turns[0]!;
  if (first.ingress.timerInfo?.name) return `⏱️ ${first.ingress.timerInfo.name}`;
  const cleanFirst = first.ingress.text.replace(/\s+/g, ' ').trim();
  if (turns.length > 1 && cleanFirst.length < 10) {
    const cleanSecond = turns[1]!.ingress.text.replace(/\s+/g, ' ').trim();
    const combined = `${cleanFirst} · ${cleanSecond}`;
    return combined.length <= 36 ? combined : `${combined.slice(0, 35)}…`;
  }
  return cleanFirst.length <= 36 ? cleanFirst : `${cleanFirst.slice(0, 35)}…`;
}

/**
 * Pure read-only session grouping from persisted `sessionId` markers.
 * Performs zero network calls, zero auth-file reads, and zero database writes.
 */
export function groupFlowsIntoSessions(flowsNewestFirst: MindmapTaskFlow[]): MindmapSession[] {
  const chronological = [...flowsNewestFirst].sort((a, b) => (a.createdAt - b.createdAt) || (a.seq - b.seq));
  const groups = new Map<string, MindmapTaskFlow[]>();
  for (const flow of chronological) {
    const key = flow.sessionPersisted && flow.sessionId ? flow.sessionId : `session:${flow.id}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(flow);
    groups.set(key, bucket);
  }

  const sessions: MindmapSession[] = [...groups.values()].map(turns => {
    turns.sort((a, b) => (a.createdAt - b.createdAt) || (a.seq - b.seq));
    const first = turns[0]!;
    const last = turns[turns.length - 1]!;
    const sessionId = first.sessionPersisted && first.sessionId ? first.sessionId : `session:${first.id}`;
    const kind: MindmapSession['kind'] = first.ingress.sourceKind === 'timer'
      ? 'timer'
      : first.ingress.sourceKind === 'standalone'
        ? 'standalone'
        : 'human';

    const channels: MindmapSession['channels'] = [];
    for (const t of turns) {
      if (!channels.includes(t.ingress.sourceKind)) channels.push(t.ingress.sourceKind);
    }

    let taskCount = 0;
    let jevCallCount = 0;
    let recalledMemoryCount = 0;
    let consolidatedMemoryCount = 0;
    let aiManagedContext = turns.some((t, idx) => idx > 0 && Boolean(t.sessionLink));
    const seenTaskIds = new Set<string>();

    const turnSummaries: MindmapSessionTurnSummary[] = turns.map((t, idx) => {
      t.sessionId = sessionId;
      t.turnIndex = idx + 1;
      t.turnCount = turns.length;
      recalledMemoryCount += t.memoryRecall.recalledItems.length;
      consolidatedMemoryCount += t.consolidatedMemories.length;
      if (t.sessionLink?.source === 'gemini-decision-1') jevCallCount += 1;
      for (const task of t.tasks) {
        if (!seenTaskIds.has(task.id)) {
          seenTaskIds.add(task.id);
          taskCount += 1;
          if (task.jevRoute?.called) jevCallCount += 1;
          jevCallCount += task.jevQualityGates.length;
        }
        if (task.contextBrief || task.compiledMemories.length > 0) aiManagedContext = true;
      }
      if (t.memoryRecall.recalledItems.length > 0 || t.consolidatedMemories.length > 0) aiManagedContext = true;
      return {
        flowId: t.id,
        seq: t.seq,
        at: t.createdAt,
        sourceKind: t.ingress.sourceKind,
        channelLabel: t.ingress.channelLabel,
        textPreview: clipText(t.ingress.text.replace(/\s+/g, ' ').trim(), 120).text,
        status: t.status,
        taskIds: t.tasks.map(tk => tk.id),
        ...(t.sessionLink ? { link: t.sessionLink } : {}),
      };
    });

    const updatedAt = Math.max(
      ...turns.map(t => Math.max(t.createdAt, t.completedAt ?? 0, ...(t.deliveries.map(d => d.at)))),
    );

    return {
      id: sessionId,
      title: synthesizeSessionTitle(turns),
      kind,
      status: last.status,
      startedAt: first.createdAt,
      updatedAt,
      channels,
      primaryChannelLabel: first.ingress.channelLabel,
      turnCount: turns.length,
      taskCount,
      jevCallCount,
      recalledMemoryCount,
      consolidatedMemoryCount,
      aiManagedContext,
      turnFlowIds: turns.map(t => t.id),
      turnSummaries,
    };
  });

  sessions.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.startedAt - a.startedAt));
  return sessions;
}

/**
 * Builds a strictly read-only Mindmap snapshot for the Web UI without mutating SQLite or
 * issuing outbound API/credential requests.
 */
export async function buildMindmapSnapshot(
  coordinator: Coordinator,
  options?: { home?: string; beforeSeq?: number; limit?: number },
): Promise<MindmapSnapshot> {
  const store = coordinator.store;
  const limit = Math.max(1, Math.min(options?.limit ?? 120, 200));
  const cursor = store.conversation.latestSeq();
  const page = store.conversation.userTurnsPage(options?.beforeSeq, limit);

  const includeOrphans = options?.beforeSeq === undefined;
  const userMessageIds = page.items.map(m => m.id);
  const linkedTaskIds = page.items.flatMap(m => m.taskIds);
  const totalTasks = store.countTasks();
  const totalOrphans = store.countOrphanTasks();
  const orphanTasks = includeOrphans ? store.listOrphanTasks(200) : [];
  const scopedTasks = store.listTasksForMindmap(userMessageIds, linkedTaskIds);

  const tasksById = new Map<string, Task>();
  const tasksByOriginMsg = new Map<string, Task[]>();
  for (const task of scopedTasks) {
    tasksById.set(task.id, task);
    if (task.originMessageId) {
      const bucket = tasksByOriginMsg.get(task.originMessageId) ?? [];
      bucket.push(task);
      tasksByOriginMsg.set(task.originMessageId, bucket);
    }
  }

  const replies = store.conversation.repliesForMessages(userMessageIds);
  const repliesByParent = new Map<string, ChatMessage[]>();
  for (const r of replies) {
    if (!r.replyTo) continue;
    const bucket = repliesByParent.get(r.replyTo) ?? [];
    bucket.push(r);
    repliesByParent.set(r.replyTo, bucket);
  }

  // Gather all task IDs linked via either originMessageId or message_tasks join table
  const flowTaskMap = new Map<string, Task[]>();
  const scopeTaskIds = new Set<string>();
  const scopeMsgIds = new Set<string>([...userMessageIds, ...replies.map(r => r.id)]);

  for (const msg of page.items) {
    const combined = new Map<string, Task>();
    for (const t of tasksByOriginMsg.get(msg.id) ?? []) combined.set(t.id, t);
    for (const tid of msg.taskIds) {
      const found = tasksById.get(tid);
      // Do not duplicate tasks owned by another user message onto follow-up turns.
      if (found && (!found.originMessageId || found.originMessageId === msg.id)) {
        combined.set(found.id, found);
      }
    }
    const sorted = [...combined.values()].sort((a, b) => a.createdAt - b.createdAt);
    flowTaskMap.set(msg.id, sorted);
    for (const t of sorted) scopeTaskIds.add(t.id);
  }
  if (includeOrphans) {
    for (const t of orphanTasks) scopeTaskIds.add(t.id);
  }

  const journalEvents = store.conversation.structuredJournalForScopes([...scopeMsgIds], [...scopeTaskIds]);
  const eventsByRoot = new Map<string, TraceEvent[]>();
  const eventsByMessage = new Map<string, TraceEvent[]>();
  const eventsByTask = new Map<string, TraceEvent[]>();
  const pushEvent = (map: Map<string, TraceEvent[]>, key: string | undefined, ev: TraceEvent) => {
    if (!key) return;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = [];
      map.set(key, bucket);
    }
    bucket.push(ev);
  };
  for (const ev of journalEvents) {
    pushEvent(eventsByRoot, ev.rootId, ev);
    pushEvent(eventsByMessage, ev.messageId, ev);
    pushEvent(eventsByTask, ev.taskId, ev);
  }
  const collectFlowEvents = (msgId: string, replyIds: string[], taskIds: string[]): TraceEvent[] => {
    const seen = new Map<number, TraceEvent>();
    for (const ev of eventsByRoot.get(msgId) ?? []) seen.set(ev.seq, ev);
    for (const ev of eventsByMessage.get(msgId) ?? []) seen.set(ev.seq, ev);
    for (const rid of replyIds) {
      for (const ev of eventsByMessage.get(rid) ?? []) seen.set(ev.seq, ev);
    }
    for (const tid of taskIds) {
      for (const ev of eventsByTask.get(tid) ?? []) seen.set(ev.seq, ev);
    }
    return [...seen.values()].sort((a, b) => a.seq - b.seq);
  };

  const allMemories = store.listMemories({ includeSuperseded: true, limit: 500 });
  const memoryById = new Map<string, MemoryCard>(allMemories.map(c => [c.id, c]));
  const memoriesBySourceMsg = new Map<string, MemoryCard[]>();
  const memoriesBySourceTask = new Map<string, MemoryCard[]>();
  for (const card of allMemories) {
    if (card.sourceMessageId) {
      const bucket = memoriesBySourceMsg.get(card.sourceMessageId) ?? [];
      bucket.push(card);
      memoriesBySourceMsg.set(card.sourceMessageId, bucket);
    }
    if (card.sourceTaskId) {
      const bucket = memoriesBySourceTask.get(card.sourceTaskId) ?? [];
      bucket.push(card);
      memoriesBySourceTask.set(card.sourceTaskId, bucket);
    }
  }
  const activeMemoriesCount = store.memoryDirectory(1).totalActive;
  const imChannels = store.listImChannelViews();
  const channelById = new Map(imChannels.map(ch => [ch.id, ch]));
  const timers = store.listTimers();
  const modelHubView = await coordinator.modelHub.getView();

  const messageFlows: MindmapTaskFlow[] = [];

  for (const userMsg of page.items) {
    const flowTasks = flowTaskMap.get(userMsg.id) ?? [];
    const flowReplies = repliesByParent.get(userMsg.id) ?? [];
    const flowEvents = collectFlowEvents(
      userMsg.id,
      flowReplies.map(r => r.id),
      flowTasks.map(t => t.id),
    );

    const timerName = userMsg.source === 'system' ? parseTimerTriggerName(userMsg.text) : undefined;
    const isTimer = Boolean(timerName);
    const matchedTimer = timerName ? timers.find(t => t.name === timerName) : undefined;
    const rawChannel = userMsg.origin?.channel ?? 'local';
    const sourceKind: MindmapTaskFlow['ingress']['sourceKind'] = isTimer ? 'timer' : rawChannel;

    const boundChannel = userMsg.origin?.channelId ? channelById.get(userMsg.origin.channelId) : undefined;
    const channelPlatformLabel = rawChannel === 'wechat' ? '微信'
      : rawChannel === 'telegram' ? 'Telegram'
        : rawChannel === 'dingtalk' ? '钉钉'
          : rawChannel === 'xiaoai' ? '小爱音箱'
            : '本地控制台';
    const channelLabel = isTimer
      ? `定时触发${rawChannel !== 'local' ? ` → ${boundChannel?.name ?? channelPlatformLabel}` : ''}`
      : boundChannel
        ? `${channelPlatformLabel} · ${boundChannel.name}`
        : channelPlatformLabel;

    const recalledItems: MindmapRecalledItem[] = (userMsg.routing?.context?.autoRecalled ?? []).map(hit => ({
      kind: hit.kind,
      id: hit.id,
      title: hit.title,
      score: hit.score,
      snippet: clipText(hit.snippet, 360).text,
      ...(hit.tags?.length ? { tags: hit.tags } : {}),
      ...(hit.cwd ? { cwd: hit.cwd } : {}),
      ...(hit.activatedVia ? { activatedVia: hit.activatedVia } : {}),
    }));

    const routerTurns = buildRouterTurns(flowEvents);
    const routeActions = userMsg.routing?.actions ?? [];
    const directPlugin = isTimer && routerTurns.length === 0 && flowTasks.length === 0 && matchedTimer?.plugin
      ? { timerName: matchedTimer.name, plugin: matchedTimer.plugin, pluginAction: matchedTimer.pluginAction ?? 'status' }
      : undefined;

    const claimedReportSpans = new Set<string>();
    const taskDetails = flowTasks.map(task => {
      const taskSpecificEvents = eventsByTask.get(task.id) ?? [];
      return buildTaskDetail(store, task, taskSpecificEvents, routerTurns, claimedReportSpans, memoryById);
    });

    // Memories created/saved in this flow (via save_memory or distiller)
    const consolidatedById = new Map<string, MemoryCard>();
    for (const card of memoriesBySourceMsg.get(userMsg.id) ?? []) {
      consolidatedById.set(card.id, card);
    }
    for (const t of flowTasks) {
      for (const card of memoriesBySourceTask.get(t.id) ?? []) {
        consolidatedById.set(card.id, card);
      }
    }
    for (const act of routeActions) {
      if (act.kind === 'save_memory') {
        for (const mid of act.memoryIds ?? []) {
          const card = memoryById.get(mid);
          if (card) consolidatedById.set(card.id, card);
        }
      }
    }
    const consolidatedMemories: MindmapConsolidatedMemory[] = [...consolidatedById.values()]
      .map(card => ({
        id: card.id,
        topic: card.topic,
        tags: card.tags,
        pinned: Boolean(card.pinned),
        autoConsolidated: card.tags.includes('auto-consolidated'),
        contentPreview: clipText(card.content, 360).text,
        synapseCount: card.synapses?.length ?? 0,
        createdAt: card.createdAt,
      }));

    const deliveries: MindmapDeliveryItem[] = flowReplies.map((r, idx) => {
      const clipped = clipText(r.text || r.reason || '', 1600);
      const isLast = idx === flowReplies.length - 1;
      const roleLabel = r.source === 'system'
        ? (isTimer ? '定时插件直报' : '系统状态通知')
        : flowReplies.length > 1 && !isLast
          ? `阶段回复 #${idx + 1}`
          : '最终交付回复';
      return {
        messageId: r.id,
        seq: r.seq,
        at: r.at,
        roleLabel,
        status: r.status,
        text: clipped.text,
        ...(clipped.truncated ? { textTruncated: true } : {}),
        ...(r.reason ? { reason: clipText(r.reason, 280).text } : {}),
        ...(r.source ? { source: r.source } : {}),
      };
    });

    // Sent files from Router send_file calls
    const sentFiles: Array<{ name: string; target?: string; at: number }> = [];
    for (const turn of routerTurns) {
      for (const tool of turn.tools) {
        if (tool.toolName !== 'send_file') continue;
        const parsedOut = unwrapJsonString(tool.outputPreview);
        const outRec = asRecord(parsedOut);
        const parsedIn = unwrapJsonString(tool.inputPreview);
        const inRec = asRecord(parsedIn);
        const fileName = typeof outRec?.name === 'string'
          ? outRec.name
          : typeof inRec?.name === 'string'
            ? inRec.name
            : '微信附件';
        sentFiles.push({
          name: fileName,
          target: typeof outRec?.target === 'string' ? outRec.target : userMsg.origin?.senderId,
          at: tool.at,
        });
      }
    }

    const replyOrigins = flowReplies.map(r => r.origin).filter((o): o is MessageOrigin => Boolean(o));
    const finalOrigin = replyOrigins.at(-1) ?? userMsg.origin;
    const imChannel = finalOrigin?.channel ?? 'local';
    const imBound = finalOrigin?.channelId ? channelById.get(finalOrigin.channelId) : undefined;
    const imChannelName = imChannel === 'local'
      ? '本地 Web 控制台'
      : imBound?.name ?? (imChannel === 'wechat' ? '微信 iLink' : imChannel === 'telegram' ? 'Telegram' : imChannel === 'xiaoai' ? '小爱音箱' : '钉钉');
    const deliveredReplies = flowReplies.filter(r => ['completed', 'failed', 'interrupted'].includes(r.status) && Boolean((r.text || r.reason || '').trim()));

    const hasRunningTask = flowTasks.some(t => t.status === 'running' || t.status === 'queued');
    const hasPausedTask = flowTasks.some(t => t.status === 'paused');
    const hasFailedTask = flowTasks.some(t => t.status === 'failed');
    const flowStatus: MindmapTaskFlow['status'] = hasRunningTask
      ? 'running'
      : (userMsg.status === 'queued' || userMsg.status === 'processing' || userMsg.status === 'streaming')
        ? userMsg.status
        : hasFailedTask || userMsg.status === 'failed'
          ? 'failed'
          : hasPausedTask
            ? 'paused'
            : userMsg.status === 'interrupted'
              ? 'interrupted'
              : 'completed';

    const clippedMsg = clipText(userMsg.text, 1600);
    const completedAt = flowReplies.at(-1)?.at ?? taskDetails.at(-1)?.createdAt;

    messageFlows.push({
      id: `flow:msg:${userMsg.id}`,
      seq: userMsg.seq,
      createdAt: userMsg.at,
      completedAt,
      status: flowStatus,
      ...(userMsg.sessionId ? { sessionId: userMsg.sessionId, sessionPersisted: true } : {}),
      ...(userMsg.sessionLink ? { sessionLink: userMsg.sessionLink } : {}),
      ingress: {
        sourceKind,
        channelLabel,
        origin: sanitizeOrigin(userMsg.origin),
        messageId: userMsg.id,
        text: clippedMsg.text,
        ...(clippedMsg.truncated ? { textTruncated: true } : {}),
        attachments: (userMsg.attachments ?? []).map(a => ({
          kind: a.kind,
          name: a.name,
          status: a.status,
          ...(a.path ? { path: a.path } : {}),
          ...(a.mimeType ? { mimeType: a.mimeType } : {}),
          ...(a.error ? { error: a.error } : {}),
        })),
        paths: userMsg.paths ?? [],
        ...(matchedTimer
          ? {
              timerInfo: {
                id: matchedTimer.id,
                name: matchedTimer.name,
                plugin: matchedTimer.plugin,
                pluginAction: matchedTimer.pluginAction,
                dailyAt: matchedTimer.dailyAt,
                intervalMs: matchedTimer.intervalMs,
                once: matchedTimer.once,
              },
            }
          : {}),
      },
      memoryRecall: {
        directoryTotal: userMsg.routing?.context?.memoryDirectory?.totalActive,
        visibleWorksCount: userMsg.routing?.context?.totalWorks,
        executionMode: userMsg.routing?.context?.execution,
        cwd: userMsg.routing?.context?.cwd,
        recalledItems,
      },
      routerTurns,
      routeActions,
      ...(directPlugin ? { directPlugin } : {}),
      tasks: taskDetails,
      consolidatedMemories,
      deliveries,
      imPush: {
        channel: imChannel,
        channelName: imChannelName,
        target: finalOrigin?.conversationId ?? finalOrigin?.senderId,
        delivered: deliveredReplies.length > 0,
        deliveryCount: deliveredReplies.length,
        sentFiles,
      },
    });
  }

  // Append any standalone tasks submitted directly without a user message (e.g. CLI submit)
  const orphanFlows: MindmapTaskFlow[] = [];
  if (includeOrphans) {
    for (const task of [...orphanTasks].sort((a, b) => b.createdAt - a.createdAt)) {
      const seenTaskEv = new Map<number, TraceEvent>();
      for (const ev of eventsByTask.get(task.id) ?? []) seenTaskEv.set(ev.seq, ev);
      for (const ev of eventsByRoot.get(task.id) ?? []) seenTaskEv.set(ev.seq, ev);
      const taskEvents = [...seenTaskEv.values()].sort((a, b) => a.seq - b.seq);
      const orphanRouterTurns = buildRouterTurns(taskEvents);
      const detail = buildTaskDetail(store, task, taskEvents, orphanRouterTurns, new Set<string>(), memoryById);
      const imChannel = task.origin?.channel ?? 'local';
      const imBound = task.origin?.channelId ? channelById.get(task.origin.channelId) : undefined;
      orphanFlows.push({
        id: `flow:task:${task.id}`,
        seq: 0,
        createdAt: task.createdAt,
        status: task.status === 'cancelled' ? 'interrupted' : task.status,
        ...(task.sessionId ? { sessionId: task.sessionId, sessionPersisted: true } : {}),
        ingress: {
          sourceKind: 'standalone',
          channelLabel: '独立后台提交 (Submit)',
          origin: sanitizeOrigin(task.origin),
          text: detail.prompt,
          ...(detail.promptTruncated ? { textTruncated: true } : {}),
          attachments: [],
          paths: task.paths ?? [],
        },
        memoryRecall: {
          executionMode: task.execution,
          cwd: task.cwd,
          recalledItems: [],
        },
        routerTurns: orphanRouterTurns,
        routeActions: [],
        tasks: [detail],
        consolidatedMemories: (memoriesBySourceTask.get(task.id) ?? [])
          .map(card => ({
            id: card.id,
            topic: card.topic,
            tags: card.tags,
            pinned: Boolean(card.pinned),
            autoConsolidated: card.tags.includes('auto-consolidated'),
            contentPreview: clipText(card.content, 360).text,
            synapseCount: card.synapses?.length ?? 0,
            createdAt: card.createdAt,
          })),
        deliveries: [],
        imPush: {
          channel: imChannel,
          channelName: imBound?.name ?? (imChannel === 'local' ? '本地 Web 控制台' : imChannel),
          target: task.origin?.conversationId ?? task.origin?.senderId,
          delivered: task.status === 'completed',
          deliveryCount: task.status === 'completed' ? 1 : 0,
          sentFiles: [],
        },
      });
    }
  }

  // Enforce safe Unix socket payload limit (< 2.4 MB) while preserving orphanTasks
  // and ensuring `hasMore` never emits an infinite-pagination cursor (`beforeSeq: undefined`).
  const boundedOrphans: Array<{ flow: MindmapTaskFlow; size: number }> = [];
  const orphanCapBytes = messageFlows.length > 0 ? Math.floor(SAFE_PAYLOAD_BYTES * 0.5) : SAFE_PAYLOAD_BYTES;
  let orphanReservedBytes = 0;
  for (const oFlow of orphanFlows) {
    const oSize = Buffer.byteLength(JSON.stringify(oFlow), 'utf8');
    if (boundedOrphans.length > 0 && orphanReservedBytes + oSize > orphanCapBytes) break;
    boundedOrphans.push({ flow: oFlow, size: oSize });
    orphanReservedBytes += oSize;
  }

  let runningBytes = 2048;
  const boundedFlows: MindmapTaskFlow[] = [];
  let truncatedMessageFlows = false;
  let lastMessageSeq: number | undefined;
  for (const flow of messageFlows) {
    const chunkSize = Buffer.byteLength(JSON.stringify(flow), 'utf8');
    if (boundedFlows.length > 0 && runningBytes + orphanReservedBytes + chunkSize > SAFE_PAYLOAD_BYTES) {
      truncatedMessageFlows = true;
      break;
    }
    boundedFlows.push(flow);
    runningBytes += chunkSize;
    if (flow.seq > 0) lastMessageSeq = flow.seq;
  }
  for (const { flow: oFlow, size: oSize } of boundedOrphans) {
    if (boundedFlows.length > 0 && runningBytes + oSize > SAFE_PAYLOAD_BYTES) {
      break;
    }
    boundedFlows.push(oFlow);
    runningBytes += oSize;
  }

  let wechatFlows = 0;
  let localFlows = 0;
  let timerFlows = 0;
  let jevCalls = 0;
  const seenJevTaskIds = new Set<string>();
  for (const flow of boundedFlows) {
    if (flow.ingress.sourceKind === 'timer') timerFlows += 1;
    else if (flow.ingress.sourceKind === 'wechat') wechatFlows += 1;
    else if (flow.ingress.sourceKind === 'local') localFlows += 1;
    if (flow.sessionLink?.source === 'gemini-decision-1') jevCalls += 1;
    for (const t of flow.tasks) {
      if (seenJevTaskIds.has(t.id)) continue;
      seenJevTaskIds.add(t.id);
      if (t.jevRoute?.called) jevCalls += 1;
      jevCalls += t.jevQualityGates.length;
    }
  }

  const candidateBeforeSeq = lastMessageSeq ?? (page.before && page.before > 0 ? page.before : undefined);
  const hasMore = Boolean((page.hasMore || truncatedMessageFlows) && candidateBeforeSeq !== undefined && candidateBeforeSeq > 0);
  const beforeSeq = hasMore ? candidateBeforeSeq : undefined;

  const sessions = groupFlowsIntoSessions(boundedFlows);
  const multiTurnSessions = sessions.filter(s => s.turnCount >= 2).length;

  return {
    generatedAt: Date.now(),
    cursor,
    mode: modelHubView.mode,
    hasMore,
    ...(hasMore && beforeSeq !== undefined ? { beforeSeq } : {}),
    summary: {
      totalFlows: page.totalUsers + totalOrphans,
      loadedFlows: boundedFlows.length,
      totalSessions: sessions.length,
      multiTurnSessions,
      wechatFlows,
      localFlows,
      timerFlows,
      totalTasks,
      jevCalls,
      totalMemories: activeMemoriesCount,
      routerProvider: modelHubView.routerProvider,
      routerModel: modelHubView.routerModel,
      decisionModel: modelHubView.decisionEngine?.model ?? 'gemini-decision-1',
      decisionEnabled: Boolean(modelHubView.decisionEngine?.enabled),
      decisionConfigured: Boolean(modelHubView.decisionEngine?.configured),
    },
    sessions,
    flows: boundedFlows,
  };
}

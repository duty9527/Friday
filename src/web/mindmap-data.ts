import type {
  FlowCategory,
  FlowNodeKind,
  FlowchartEdge,
  FlowchartEdgeKind,
  FlowchartEdgeTone,
  FlowchartFrame,
  FlowchartGraph,
  FlowchartNode,
  FlowchartShape,
  InspectorPayload,
  MindmapConsolidatedMemory,
  MindmapDeliveryItem,
  MindmapIngressOrigin,
  MindmapJevQualityGateItem,
  MindmapJevRouteInfo,
  MindmapRecalledItem,
  MindmapRouterToolCall,
  MindmapRouterTurn,
  MindmapSession,
  MindmapSessionLinkKind,
  MindmapSessionTurnSummary,
  MindmapSnapshot,
  MindmapTaskDetail,
  MindmapTaskFlow,
  MindmapTurnLink,
  MindmapWorkerPhase,
  MindmapWorkerStep,
  RouteActionSummary,
} from '../mindmap-types.js';

export type {
  FlowCategory,
  FlowNodeKind,
  FlowchartEdge,
  FlowchartEdgeKind,
  FlowchartEdgeTone,
  FlowchartFrame,
  FlowchartGraph,
  FlowchartNode,
  FlowchartShape,
  InspectorPayload,
  MindmapConsolidatedMemory,
  MindmapDeliveryItem,
  MindmapIngressOrigin,
  MindmapJevQualityGateItem,
  MindmapJevRouteInfo,
  MindmapRecalledItem,
  MindmapRouterToolCall,
  MindmapRouterTurn,
  MindmapSession,
  MindmapSessionLinkKind,
  MindmapSessionTurnSummary,
  MindmapSnapshot,
  MindmapTaskDetail,
  MindmapTaskFlow,
  MindmapTurnLink,
  MindmapWorkerPhase,
  MindmapWorkerStep,
  RouteActionSummary,
} from '../mindmap-types.js';

export function shortText(raw: string | undefined, max = 38): string {
  if (!raw) return '（空）';
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

export function formatTimeShort(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

export function sourceIcon(kind: MindmapTaskFlow['ingress']['sourceKind']): string {
  switch (kind) {
    case 'wechat': return '💬';
    case 'telegram': return '✈️';
    case 'dingtalk': return '🔔';
    case 'xiaoai': return '🔊';
    case 'timer': return '⏱️';
    case 'standalone': return '⚡';
    default: return '🖥️';
  }
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    completed: '已完成',
    succeeded: '成功',
    accepted: '已受理',
    running: '执行中',
    processing: '推理中',
    streaming: '输出中',
    queued: '排队中',
    paused: '已暂停',
    failed: '失败',
    interrupted: '已中断',
    fallback: '规则回退',
    static: '静态配置',
    skipped: 'JEV免检',
    done: '已送达',
    pending: '待执行',
    waiting_decision: '待老板拍板',
    decision_received: '已获拍板',
  };
  return map[status] ?? status;
}

const TRIGGER_LABELS: Record<string, string> = {
  CHAT: '首次接单分析 (CHAT)',
  WORKER_REPORT: 'Worker 报告验收 (WORKER_REPORT)',
  WORKER_QUESTION: '转达请示拍板 (WORKER_QUESTION)',
  WORKER_FAILED: 'Worker 失败兜底 (WORKER_FAILED)',
  NEW_TASK: '独立任务调度 (NEW_TASK)',
};

// ---------------- 真·流程图布局引擎 (Flowchart Layout Engine) ----------------

export function resolveSessionTurns(session: MindmapSession, flowsById: Map<string, MindmapTaskFlow>): MindmapTaskFlow[] {
  const turns: MindmapTaskFlow[] = [];
  for (const fid of session.turnFlowIds) {
    const found = flowsById.get(fid);
    if (found) turns.push(found);
  }
  return turns;
}

function cloneSession(session: MindmapSession): MindmapSession {
  return {
    ...session,
    channels: [...session.channels],
    turnFlowIds: [...session.turnFlowIds],
    turnSummaries: session.turnSummaries.map(summary => ({ ...summary, taskIds: [...summary.taskIds] })),
  };
}

function summarizeFlowTurn(flow: MindmapTaskFlow): MindmapSessionTurnSummary {
  return {
    flowId: flow.id,
    seq: flow.seq,
    at: flow.createdAt,
    sourceKind: flow.ingress.sourceKind,
    channelLabel: flow.ingress.channelLabel,
    textPreview: shortText(flow.ingress.text, 120),
    status: flow.status,
    taskIds: flow.tasks.map(t => t.id),
  };
}

function mergeSessionInto(target: MindmapSession, incoming: MindmapSession): void {
  const existingIds = new Set(target.turnFlowIds);
  for (const summary of incoming.turnSummaries) {
    if (!existingIds.has(summary.flowId)) {
      existingIds.add(summary.flowId);
      target.turnSummaries.push({ ...summary, taskIds: [...summary.taskIds] });
    }
  }
  target.turnSummaries.sort((a, b) => (a.seq - b.seq) || (a.at - b.at));
  const summaryById = new Set(target.turnSummaries.map(s => s.flowId));
  for (const fid of incoming.turnFlowIds) {
    if (!summaryById.has(fid) && !target.turnFlowIds.includes(fid)) {
      target.turnFlowIds.push(fid);
    }
  }
  const orderedIds = target.turnSummaries.map(s => s.flowId);
  for (const fid of target.turnFlowIds) {
    if (!summaryById.has(fid)) orderedIds.push(fid);
  }
  target.turnFlowIds = orderedIds;
  target.turnCount = Math.max(target.turnCount, target.turnFlowIds.length, incoming.turnCount);
  target.taskCount = Math.max(target.taskCount, incoming.taskCount);
  target.jevCallCount = Math.max(target.jevCallCount, incoming.jevCallCount);
  target.recalledMemoryCount = Math.max(target.recalledMemoryCount, incoming.recalledMemoryCount);
  target.consolidatedMemoryCount = Math.max(target.consolidatedMemoryCount, incoming.consolidatedMemoryCount);
  target.aiManagedContext = target.aiManagedContext || incoming.aiManagedContext;
  for (const channel of incoming.channels) {
    if (!target.channels.includes(channel)) target.channels.push(channel);
  }
  target.startedAt = Math.min(target.startedAt, incoming.startedAt);
  if (incoming.updatedAt >= target.updatedAt) {
    target.updatedAt = incoming.updatedAt;
    target.status = incoming.status;
    target.primaryChannelLabel = incoming.primaryChannelLabel;
  }
}

export function mergeSessionLists(
  primary: readonly MindmapSession[] | undefined,
  secondary: readonly MindmapSession[] | undefined,
): MindmapSession[] {
  const byId = new Map<string, MindmapSession>();
  for (const session of primary ?? []) {
    const existing = byId.get(session.id);
    if (existing) mergeSessionInto(existing, session);
    else byId.set(session.id, cloneSession(session));
  }
  for (const session of secondary ?? []) {
    const existing = byId.get(session.id);
    if (existing) mergeSessionInto(existing, session);
    else byId.set(session.id, cloneSession(session));
  }
  return [...byId.values()].sort((a, b) => (b.updatedAt - a.updatedAt) || (b.startedAt - a.startedAt));
}

export function getEffectiveSessions(snapshot: MindmapSnapshot | null, loadedFlows: MindmapTaskFlow[]): MindmapSession[] {
  const flowsById = new Map(loadedFlows.map(f => [f.id, f]));
  const byId = new Map<string, MindmapSession>();
  const coveredFlowIds = new Set<string>();

  for (const raw of snapshot?.sessions ?? []) {
    const cloned = cloneSession(raw);
    const existing = byId.get(cloned.id);
    if (existing) mergeSessionInto(existing, cloned);
    else byId.set(cloned.id, cloned);
    for (const fid of cloned.turnFlowIds) {
      if (flowsById.has(fid)) coveredFlowIds.add(fid);
    }
  }

  // Group older flows uncovered by initial snapshot.sessions by session ID so we never emit duplicate session IDs.
  const uncoveredGroups = new Map<string, MindmapTaskFlow[]>();
  for (const flow of loadedFlows) {
    if (coveredFlowIds.has(flow.id)) continue;
    coveredFlowIds.add(flow.id);
    const key = flow.sessionId ?? `session:${flow.id}`;
    const group = uncoveredGroups.get(key);
    if (group) group.push(flow);
    else uncoveredGroups.set(key, [flow]);
  }

  for (const [sessionId, flows] of uncoveredGroups) {
    const ordered = [...flows].sort((a, b) => (a.seq - b.seq) || (a.createdAt - b.createdAt));
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    const channels: MindmapSession['channels'] = [];
    for (const f of ordered) {
      if (!channels.includes(f.ingress.sourceKind)) channels.push(f.ingress.sourceKind);
    }
    const aggregated: MindmapSession = {
      id: sessionId,
      title: shortText(first.ingress.text, 34),
      kind: first.ingress.sourceKind === 'timer' ? 'timer' : first.ingress.sourceKind === 'standalone' ? 'standalone' : 'human',
      status: last.status,
      startedAt: first.createdAt,
      updatedAt: Math.max(...ordered.map(f => Math.max(f.createdAt, f.completedAt ?? 0, ...(f.deliveries.map(d => d.at))))),
      channels,
      primaryChannelLabel: last.ingress.channelLabel,
      turnCount: ordered.length,
      taskCount: ordered.reduce((sum, f) => sum + f.tasks.length, 0),
      jevCallCount: ordered.reduce((sum, f) => sum + f.tasks.reduce((s, t) => s + (t.jevRoute?.called ? 1 : 0) + t.jevQualityGates.length, 0), 0),
      recalledMemoryCount: ordered.reduce((sum, f) => sum + f.memoryRecall.recalledItems.length, 0),
      consolidatedMemoryCount: ordered.reduce((sum, f) => sum + f.consolidatedMemories.length, 0),
      aiManagedContext: ordered.some(f => f.memoryRecall.recalledItems.length > 0 || f.tasks.some(t => Boolean(t.contextBrief))),
      turnFlowIds: ordered.map(f => f.id),
      turnSummaries: ordered.map(summarizeFlowTurn),
    };
    const existing = byId.get(sessionId);
    if (existing) {
      mergeSessionInto(existing, aggregated);
      existing.taskCount = existing.turnFlowIds.reduce((sum, fid) => sum + (flowsById.get(fid)?.tasks.length ?? 0), 0);
    } else {
      byId.set(sessionId, aggregated);
    }
  }

  return [...byId.values()].sort((a, b) => (b.updatedAt - a.updatedAt) || (b.startedAt - a.startedAt));
}

const FC_FRAME_X = 24;
const FC_FRAME_W = 1024;
const FC_HEADER_H = 52;
const FC_SPINE_X = 90;
const FC_SPINE_W = 306;
const FC_SPINE_CX = FC_SPINE_X + FC_SPINE_W / 2; // 243
const FC_SPINE_H = 74;
const FC_SIDE_TRUNK_X = 432;
const FC_SIDE1_X = 468;
const FC_SIDE_W = 258;
const FC_SIDE2_X = 758;
const FC_SIDE_H = 66;
const FC_LOOP_X = 46;
const FC_SIDE_ROW_GAP = 18;
const FC_SIDE_BUS_GAP = 22;

function nodeSearchBlob(badge: string, title: string, subtitle: string, extra?: string): string {
  return `${badge} ${title} ${subtitle} ${extra ?? ''}`.toLowerCase();
}

export function buildSessionFlowchart(
  session: MindmapSession,
  flowsById: Map<string, MindmapTaskFlow>,
  snapshot: MindmapSnapshot | null,
  collapseMap: Map<string, boolean>,
  searchTerm: string,
): FlowchartGraph {
  const turns = resolveSessionTurns(session, flowsById);
  const needle = searchTerm.trim().toLowerCase();
  const frames: FlowchartFrame[] = [];
  const nodes: FlowchartNode[] = [];
  const edges: FlowchartEdge[] = [];

  if (turns.length === 0) {
    return { mode: 'session', width: FC_FRAME_X * 2 + FC_FRAME_W, height: 220, frames, nodes, edges };
  }

  const pushNode = (raw: Omit<FlowchartNode, 'searchText' | 'match'>, extraSearch?: string): FlowchartNode => {
    const searchText = nodeSearchBlob(raw.badge, raw.title, raw.subtitle, `${raw.metric ?? ''} ${extraSearch ?? ''}`);
    const match = Boolean(needle) && searchText.includes(needle);
    const node: FlowchartNode = { ...raw, searchText, match };
    nodes.push(node);
    return node;
  };

  let globalY = 20;
  let prevTurnTailNode: FlowchartNode | undefined;
  let edgeSeq = 0;
  const nextEdgeId = (prefix: string) => `${prefix}:${++edgeSeq}`;

  turns.forEach((flow, turnIdx) => {
    const frameKey = `turn:${flow.id}`;
    const defaultTurnCollapsed = turns.length > 4
      && turnIdx > 0
      && turnIdx < turns.length - 2
      && flow.tasks.length === 0;
    const isTurnCollapsed = collapseMap.has(frameKey) ? Boolean(collapseMap.get(frameKey)) : defaultTurnCollapsed;

    const frameTopY = globalY;
    const firstTurnTitle = shortText(flow.ingress.text, 44);
    const linkBadge = flow.sessionLink?.label;

    if (isTurnCollapsed) {
      const compactNode = pushNode({
        id: `${flow.id}:collapsed-turn`,
        flowId: flow.id,
        sessionId: session.id,
        kind: 'flow_root',
        category: flow.ingress.sourceKind === 'wechat' || flow.ingress.sourceKind === 'xiaoai' ? 'im' : 'ingress',
        shape: 'pill',
        icon: sourceIcon(flow.ingress.sourceKind),
        badge: `第 ${turnIdx + 1}/${turns.length} 轮 (已折叠)`,
        title: shortText(flow.ingress.text, 34),
        subtitle: flow.deliveries.at(-1)?.text ? `回复: ${shortText(flow.deliveries.at(-1)!.text, 32)}` : '点击标题或展开看本轮思路',
        metric: formatTimeShort(flow.createdAt),
        status: flow.status,
        x: FC_SPINE_X,
        y: frameTopY + FC_HEADER_H + 12,
        w: FC_SPINE_W,
        h: 64,
        toggleKey: frameKey,
        collapsed: true,
        inspector: { flow, snapshot: snapshot ?? undefined, session },
      }, flow.ingress.text);

      if (prevTurnTailNode) {
        const y1 = prevTurnTailNode.y + prevTurnTailNode.h;
        const y2 = compactNode.y;
        edges.push({
          id: nextEdgeId('bridge'),
          fromId: prevTurnTailNode.id,
          toId: compactNode.id,
          kind: 'session_bridge',
          tone: 'accent',
          points: [{ x: FC_SPINE_CX, y: y1 }, { x: FC_SPINE_CX, y: y2 }],
          label: linkBadge ?? '🔗 会话上下文延续',
          labelX: FC_SPINE_CX,
          labelY: Math.round((y1 + y2) / 2),
        });
      }

      const frameH = FC_HEADER_H + 88;
      frames.push({
        id: `frame:${flow.id}`,
        sessionId: session.id,
        flowId: flow.id,
        turnIndex: turnIdx + 1,
        turnCount: turns.length,
        title: `第 ${turnIdx + 1}/${turns.length} 轮 · ${flow.ingress.channelLabel} · #${flow.seq || '独立'}`,
        subtitle: firstTurnTitle,
        badge: linkBadge ?? statusLabel(flow.status),
        status: flow.status,
        x: FC_FRAME_X,
        y: frameTopY,
        w: FC_FRAME_W,
        h: frameH,
        collapsed: true,
        toggleKey: frameKey,
      });

      prevTurnTailNode = compactNode;
      globalY = frameTopY + frameH + (turnIdx < turns.length - 1 ? 66 : 24);
      return;
    }

    let curY = frameTopY + FC_HEADER_H + 18;
    let prevSpine: FlowchartNode | undefined;

    const advanceGap = (label?: string) => (label ? 46 : 30);

    const connectDown = (fromNode: FlowchartNode | undefined, toNode: FlowchartNode, label?: string, tone: FlowchartEdgeTone = 'default', kind: FlowchartEdgeKind = 'spine') => {
      if (!fromNode) return;
      const y1 = fromNode.y + fromNode.h;
      const y2 = toNode.y;
      edges.push({
        id: nextEdgeId(kind),
        fromId: fromNode.id,
        toId: toNode.id,
        kind,
        tone,
        points: [{ x: FC_SPINE_CX, y: y1 }, { x: FC_SPINE_CX, y: y2 }],
        ...(label ? { label, labelX: FC_SPINE_CX, labelY: Math.round((y1 + y2) / 2) } : {}),
      });
    };

    const emitSidePair = (spineNode: FlowchartNode, leftCard: FlowchartNode, rightCard: FlowchartNode, branchLabel: string, tone: FlowchartEdgeTone = 'accent') => {
      const sy = Math.round(spineNode.y + spineNode.h / 2);
      const ly = Math.round(leftCard.y + leftCard.h / 2);
      const ry = Math.round(rightCard.y + rightCard.h / 2);
      edges.push({
        id: nextEdgeId('branch'),
        fromId: spineNode.id,
        toId: leftCard.id,
        kind: 'branch',
        tone,
        points: sy === ly
          ? [{ x: spineNode.x + spineNode.w, y: sy }, { x: leftCard.x, y: ly }]
          : [{ x: spineNode.x + spineNode.w, y: sy }, { x: FC_SIDE_TRUNK_X, y: sy }, { x: FC_SIDE_TRUNK_X, y: ly }, { x: leftCard.x, y: ly }],
        label: branchLabel,
        labelX: Math.round((spineNode.x + spineNode.w + leftCard.x) / 2),
        labelY: sy - 11,
      });
      edges.push({
        id: nextEdgeId('pair'),
        fromId: leftCard.id,
        toId: rightCard.id,
        kind: 'branch',
        tone,
        points: [{ x: leftCard.x + leftCard.w, y: ly }, { x: rightCard.x, y: ry }],
      });
    };

    const emitSideGrid = (spineNode: FlowchartNode, cards: FlowchartNode[], twoCols: boolean, branchLabel?: string) => {
      if (cards.length === 0) return;
      const sy = Math.round(spineNode.y + spineNode.h / 2);
      cards.forEach((card, i) => {
        const isCol2 = twoCols && (i % 2 === 1);
        if (!isCol2) {
          const cy = Math.round(card.y + card.h / 2);
          edges.push({
            id: nextEdgeId('branch'),
            fromId: spineNode.id,
            toId: card.id,
            kind: 'branch',
            tone: 'default',
            points: sy === cy
              ? [{ x: spineNode.x + spineNode.w, y: sy }, { x: card.x, y: cy }]
              : [{ x: spineNode.x + spineNode.w, y: sy }, { x: FC_SIDE_TRUNK_X, y: sy }, { x: FC_SIDE_TRUNK_X, y: cy }, { x: card.x, y: cy }],
            ...(i === 0 && branchLabel ? { label: branchLabel, labelX: Math.round((spineNode.x + spineNode.w + FC_SIDE_TRUNK_X) / 2), labelY: sy - 11 } : {}),
          });
        } else {
          // Route cleanly via top bus above row so no line crosses col-1 card
          const busY = card.y - 11;
          const targetTopX = card.x + 28;
          edges.push({
            id: nextEdgeId('branch'),
            fromId: spineNode.id,
            toId: card.id,
            kind: 'branch',
            tone: 'default',
            points: [
              { x: spineNode.x + spineNode.w, y: sy },
              { x: FC_SIDE_TRUNK_X, y: sy },
              { x: FC_SIDE_TRUNK_X, y: busY },
              { x: targetTopX, y: busY },
              { x: targetTopX, y: card.y },
            ],
          });
        }
      });
    };

    // ① Ingress (Pill)
    const attachNote = flow.ingress.attachments.length ? ` · 附件 ${flow.ingress.attachments.length}` : '';
    const pathNote = flow.ingress.paths.length ? ` · 目录 ${flow.ingress.paths.length}` : '';
    const ingressNode = pushNode({
      id: `${flow.id}:fc:ingress`,
      flowId: flow.id,
      sessionId: session.id,
      kind: 'ingress',
      category: 'ingress',
      shape: 'pill',
      icon: sourceIcon(flow.ingress.sourceKind),
      badge: `① ${flow.ingress.sourceKind === 'timer' ? '定时入口' : `${flow.ingress.channelLabel}接入`}`,
      title: shortText(flow.ingress.text, 34),
      subtitle: `${formatTimeShort(flow.createdAt)}${attachNote}${pathNote}`,
      metric: `#${flow.seq || '独立'}`,
      status: flow.status,
      x: FC_SPINE_X,
      y: curY,
      w: FC_SPINE_W,
      h: FC_SPINE_H,
      inspector: { flow, snapshot: snapshot ?? undefined, session },
    }, flow.ingress.text);

    if (prevTurnTailNode) {
      const y1 = prevTurnTailNode.y + prevTurnTailNode.h;
      const y2 = ingressNode.y;
      edges.push({
        id: nextEdgeId('bridge'),
        fromId: prevTurnTailNode.id,
        toId: ingressNode.id,
        kind: 'session_bridge',
        tone: 'accent',
        points: [{ x: FC_SPINE_CX, y: y1 }, { x: FC_SPINE_CX, y: y2 }],
        label: linkBadge ?? '🔗 AI 会话上下文延续',
        labelX: FC_SPINE_CX,
        labelY: Math.round((y1 + y2) / 2),
      });
    }
    prevSpine = ingressNode;
    curY += FC_SPINE_H + advanceGap();

    // ② Memory recall + session context loading
    const memToggleKey = `${flow.id}:fc:mem`;
    const allRecalled = flow.memoryRecall.recalledItems;
    const memDefaultCollapsed = allRecalled.length > 6;
    const memExpanded = collapseMap.has(memToggleKey) ? !collapseMap.get(memToggleKey) : !memDefaultCollapsed;
    const visibleRecalled = allRecalled.length === 0 ? [] : (memExpanded ? allRecalled : allRecalled.slice(0, 4));
    const memRows = visibleRecalled.length ? Math.ceil(visibleRecalled.length / 2) : 0;
    const memSideHeight = memRows > 0 ? memRows * FC_SIDE_H + (memRows - 1) * FC_SIDE_BUS_GAP : 0;
    const memBandStartY = curY;

    const contextPrefix = turnIdx > 0 ? `携带前 ${turnIdx} 轮对话上下文 · ` : '';
    const memNode = pushNode({
      id: `${flow.id}:fc:memory`,
      flowId: flow.id,
      sessionId: session.id,
      kind: 'memory_group',
      category: 'memory',
      shape: 'process',
      icon: '🧠',
      badge: '② 记忆联想与上下文装载',
      title: allRecalled.length
        ? `${contextPrefix}召回 ${allRecalled.length} 条记忆`
        : `${contextPrefix}加载工作空间上下文`,
      subtitle: `${flow.memoryRecall.executionMode === 'native' ? '本地直访模式' : 'Snapshot 模式'} · 目录记忆 ${flow.memoryRecall.directoryTotal ?? 0}`,
      metric: allRecalled.length > 4 ? (memExpanded ? '已全部展开' : `+${allRecalled.length - 4} 折叠`) : (allRecalled.length ? `${allRecalled.length} 命中` : '0 命中'),
      status: 'completed',
      x: FC_SPINE_X,
      y: memBandStartY,
      w: FC_SPINE_W,
      h: FC_SPINE_H,
      ...(allRecalled.length > 0 ? { toggleKey: memToggleKey, collapsed: !memExpanded, hiddenCount: memExpanded ? 0 : allRecalled.length - visibleRecalled.length } : {}),
      inspector: { flow, session },
    }, allRecalled.map(m => `${m.title} ${m.snippet}`).join(' '));

    connectDown(prevSpine, memNode, turnIdx > 0 ? '注入会话上下文' : undefined);

    if (visibleRecalled.length > 0) {
      const memCards = visibleRecalled.map((item, mIdx) => {
        const col = mIdx % 2;
        const row = Math.floor(mIdx / 2);
        return pushNode({
          id: `${flow.id}:fc:mem:${mIdx}`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'memory_item',
          category: 'memory',
          shape: 'process',
          icon: item.activatedVia ? '✨' : item.kind === 'memory' ? '🗂️' : '📜',
          badge: item.activatedVia ? `突触激活 (${item.activatedVia.weight.toFixed(1)})` : `关联度 ${item.score.toFixed(2)}`,
          title: shortText(item.title, 26),
          subtitle: shortText(item.snippet, 30),
          status: 'completed',
          x: col === 0 ? FC_SIDE1_X : FC_SIDE2_X,
          y: memBandStartY + row * (FC_SIDE_H + FC_SIDE_BUS_GAP),
          w: FC_SIDE_W,
          h: FC_SIDE_H,
          inspector: { flow, memoryItem: item, session },
        }, `${item.title} ${item.snippet}`);
      });
      emitSideGrid(memNode, memCards, true, '联想记忆');
    }

    prevSpine = memNode;
    curY = memBandStartY + Math.max(FC_SPINE_H, memSideHeight) + advanceGap(flow.tasks.length ? '进入主控路由' : undefined);

    // ③ Execution spine: Direct Plugin OR Chat Router Turns OR Task Lifecycle
    if (flow.directPlugin) {
      const dpNode = pushNode({
        id: `${flow.id}:fc:direct-plugin`,
        flowId: flow.id,
        sessionId: session.id,
        kind: 'direct_plugin',
        category: 'router',
        shape: 'subprocess',
        icon: '🔌',
        badge: '③ 零 Token 插件直跑',
        title: `${flow.directPlugin.plugin}.${flow.directPlugin.pluginAction}`,
        subtitle: `定时规则: ${flow.directPlugin.timerName}`,
        metric: '直达推送',
        status: 'completed',
        x: FC_SPINE_X,
        y: curY,
        w: FC_SPINE_W,
        h: FC_SPINE_H,
        inspector: { flow, session },
      }, flow.directPlugin.plugin);
      connectDown(prevSpine, dpNode, '免 LLM 推理');
      prevSpine = dpNode;
      curY += FC_SPINE_H + advanceGap('发送执行结果');
    } else if (flow.tasks.length === 0) {
      const turnsToShow = flow.routerTurns.length ? flow.routerTurns : [{
        spanId: `${flow.id}:synth-router`,
        triggerKind: 'CHAT',
        startedAt: flow.createdAt,
        status: flow.status === 'failed' ? 'failed' : 'completed',
        llmTurns: 1,
        tools: [],
      }];

      turnsToShow.forEach((rt, rtIdx) => {
        const bandY = curY;
        const sideCardsCount = rt.tools.length;
        const sideH = sideCardsCount > 0 ? sideCardsCount * FC_SIDE_H + (sideCardsCount - 1) * FC_SIDE_ROW_GAP : 0;
        const toolNames = rt.tools.map(t => t.toolName).join(' · ');
        const rNode = pushNode({
          id: `${flow.id}:fc:rt:${rtIdx}`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'router_turn',
          category: 'router',
          shape: 'decision',
          icon: '◆',
          badge: `③ Router 思考决策${turnsToShow.length > 1 ? ` #${rtIdx + 1}` : ''}`,
          title: rt.tools.length ? `调用 ${toolNames} 后直回` : '直接回答 / 追问澄清',
          subtitle: `${rt.llmTurns} 轮推理 · ${formatDuration(rt.durationMs)}${rt.usage ? ` · ${rt.usage.totalTokens} tok` : ''}`,
          metric: statusLabel(rt.status),
          status: rt.status,
          x: FC_SPINE_X,
          y: bandY,
          w: FC_SPINE_W,
          h: FC_SPINE_H,
          inspector: { flow, routerTurn: rt, session },
        }, `${rt.outputPreview ?? ''} ${toolNames}`);
        connectDown(prevSpine, rNode, rtIdx === 0 ? '主控判断意图' : '继续推理');

        const toolCards = rt.tools.map((tool, tIdx) => pushNode({
          id: `${flow.id}:fc:rt:${rtIdx}:tool:${tIdx}`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'router_tool',
          category: 'router',
          shape: 'process',
          icon: '🛠️',
          badge: `Router 工具 · ${tool.toolName}`,
          title: shortText(tool.inputPreview || tool.toolName, 26),
          subtitle: shortText(tool.outputPreview || formatDuration(tool.durationMs), 30),
          status: tool.status,
          x: FC_SIDE1_X,
          y: bandY + tIdx * (FC_SIDE_H + FC_SIDE_ROW_GAP),
          w: FC_SIDE_W,
          h: FC_SIDE_H,
          inspector: { flow, routerTurn: rt, routerTool: tool, session },
        }, `${tool.toolName} ${tool.inputPreview ?? ''} ${tool.outputPreview ?? ''}`));
        emitSideGrid(rNode, toolCards, false, '主控工具');

        prevSpine = rNode;
        curY = bandY + Math.max(FC_SPINE_H, sideH) + advanceGap();
      });
    } else {
      // Flow with Worker task(s): chronological causal order!
      const usedDeliveryIds = new Set<string>();
      const usedRouterSpans = new Set<string>();
      const firstTaskAt = flow.tasks[0]!.createdAt;
      const initialTurn = flow.routerTurns[0];
      if (initialTurn) {
        usedRouterSpans.add(initialTurn.spanId);
        const bandY = curY;
        const earlyReply = flow.deliveries.find((d, idx) => idx < flow.deliveries.length - 1 && d.at <= firstTaskAt + 6000);
        if (earlyReply) usedDeliveryIds.add(earlyReply.messageId);
        const startTool = initialTurn.tools.find(t => t.toolName === 'start_work' || t.toolName === 'spawn_task') ?? initialTurn.tools[0];
        const initNode = pushNode({
          id: `${flow.id}:fc:rt:init`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'router_turn',
          category: 'router',
          shape: 'decision',
          icon: '◆',
          badge: '③ Router 接单与意图决策',
          title: `决定派发 ${flow.tasks.length} 个后台 Worker 任务`,
          subtitle: `${TRIGGER_LABELS[initialTurn.triggerKind] ?? initialTurn.triggerKind} · ${formatDuration(initialTurn.durationMs)}`,
          metric: `${initialTurn.llmTurns} 轮推理`,
          status: initialTurn.status,
          x: FC_SPINE_X,
          y: bandY,
          w: FC_SPINE_W,
          h: FC_SPINE_H,
          inspector: { flow, routerTurn: initialTurn, routerTool: startTool, session },
        }, initialTurn.outputPreview);
        connectDown(prevSpine, initNode, '分析任务需求');

        const sideCards: FlowchartNode[] = [];
        if (startTool) {
          sideCards.push(pushNode({
            id: `${flow.id}:fc:rt:init-tool`,
            flowId: flow.id,
            sessionId: session.id,
            kind: 'router_tool',
            category: 'router',
            shape: 'process',
            icon: '🚀',
            badge: `指令 · ${startTool.toolName}`,
            title: shortText(startTool.inputPreview || flow.tasks[0]!.prompt, 26),
            subtitle: shortText(startTool.outputPreview || `Profile: ${flow.tasks[0]!.profile ?? 'general'}`, 28),
            status: startTool.status,
            x: FC_SIDE1_X,
            y: bandY,
            w: FC_SIDE_W,
            h: FC_SIDE_H,
            inspector: { flow, routerTurn: initialTurn, routerTool: startTool, task: flow.tasks[0], session },
          }, startTool.inputPreview));
        }
        if (earlyReply) {
          sideCards.push(pushNode({
            id: `${flow.id}:fc:early-reply`,
            flowId: flow.id,
            sessionId: session.id,
            kind: 'reply_item',
            category: 'im',
            shape: 'io',
            icon: '💬',
            badge: earlyReply.roleLabel,
            title: shortText(earlyReply.text, 26),
            subtitle: `${formatTimeShort(earlyReply.at)} · 先回老板安抚`,
            status: earlyReply.status,
            x: startTool ? FC_SIDE2_X : FC_SIDE1_X,
            y: bandY,
            w: FC_SIDE_W,
            h: FC_SIDE_H,
            inspector: { flow, delivery: earlyReply, session },
          }, earlyReply.text));
        }
        if (sideCards.length === 2) {
          emitSidePair(initNode, sideCards[0]!, sideCards[1]!, '派单并回执');
        } else if (sideCards.length === 1) {
          emitSideGrid(initNode, sideCards, false, '接单动作');
        }

        prevSpine = initNode;
        curY = bandY + Math.max(FC_SPINE_H, sideCards.length ? FC_SIDE_H : 0) + advanceGap('触发选模');
      }

      // Render each task's causal execution chain
      for (let tIdx = 0; tIdx < flow.tasks.length; tIdx += 1) {
        const task = flow.tasks[tIdx]!;
        const taskTag = flow.tasks.length > 1 ? `任务${tIdx + 1} · ` : '';

        // ④ JEV Model Selection Decision + Req -> Res pair
        if (task.jevRoute) {
          const jr = task.jevRoute;
          const selModel = shortText((jr.response.selectedModel ?? '默认模型').split('/').pop(), 22);
          const selLevel = jr.response.thinkingLevel ?? 'medium';
          const bandY = curY;
          const jevRouteNode = pushNode({
            id: `${flow.id}:fc:t:${task.id}:jev-route`,
            flowId: flow.id,
            sessionId: session.id,
            kind: 'jev_route',
            category: 'jev',
            shape: 'decision',
            icon: '🎯',
            badge: `④ ${taskTag}JEV 选模决策`,
            title: `${selModel} @ ${selLevel}`,
            subtitle: jr.response.confidence !== undefined
              ? `置信度 ${(jr.response.confidence * 100).toFixed(0)}% · ${jr.response.needsQualityGate === false ? '可免质检' : '开启质检门禁'}`
              : (jr.source === 'gemini-decision-1' ? 'Gemini Decision 1 选定' : statusLabel(jr.status)),
            metric: jr.source === 'gemini-decision-1' ? 'JEV-1' : statusLabel(jr.source),
            status: jr.status,
            x: FC_SPINE_X,
            y: bandY,
            w: FC_SPINE_W,
            h: FC_SPINE_H,
            inspector: { flow, task, jevRoute: jr, session },
          }, `${jr.response.selectedModel ?? ''} ${jr.request.instructionPreview}`);
          connectDown(prevSpine, jevRouteNode, `${taskTag}请求 JEV 选模`, 'accent');

          const reqCard = pushNode({
            id: `${flow.id}:fc:t:${task.id}:jev-req`,
            flowId: flow.id,
            sessionId: session.id,
            kind: 'jev_route_req',
            category: 'jev',
            shape: 'process',
            icon: '📤',
            badge: '怎么调用的 JEV (Request)',
            title: jr.called ? `POST ${jr.request.endpoint}` : '未调用远端 JEV',
            subtitle: `profile:${jr.request.profile} · 候选:${jr.request.candidateCount ?? '全量'} · 图:${jr.request.hasImages ? '是' : '否'}`,
            status: jr.status,
            x: FC_SIDE1_X,
            y: bandY,
            w: FC_SIDE_W,
            h: FC_SIDE_H,
            inspector: { flow, task, jevRoute: jr, session },
          }, jr.request.instructionPreview);

          const resCard = pushNode({
            id: `${flow.id}:fc:t:${task.id}:jev-res`,
            flowId: flow.id,
            sessionId: session.id,
            kind: 'jev_route_res',
            category: 'jev',
            shape: 'process',
            icon: '📥',
            badge: 'JEV 响应 (Response)',
            title: `选定 ${selModel} · ${selLevel}`,
            subtitle: jr.response.fallbackReason
              ? `回退: ${shortText(jr.response.fallbackReason, 26)}`
              : `${jr.response.usage ? `${jr.response.usage.totalTokens} tok · ` : ''}质检:${jr.response.needsQualityGate === false ? '跳过' : '开启'}`,
            status: jr.status,
            x: FC_SIDE2_X,
            y: bandY,
            w: FC_SIDE_W,
            h: FC_SIDE_H,
            inspector: { flow, task, jevRoute: jr, session },
          });

          emitSidePair(jevRouteNode, reqCard, resCard, '调用入参/响应', 'accent');
          prevSpine = jevRouteNode;
          curY = bandY + Math.max(FC_SPINE_H, FC_SIDE_H) + advanceGap(`派发 ${selModel}`);
        }

        // ⑤ Iterative Worker Phases -> JEV Quality Gate -> Router Evaluation & Loopback!
        const phases: MindmapWorkerPhase[] = task.executionPhases?.length
          ? task.executionPhases
          : [{
              index: 1,
              isFollowup: false,
              startedAt: task.createdAt,
              durationMs: task.activeMs,
              status: task.status,
              llmCount: task.workerSteps.filter(s => s.kind === 'llm_turn').length,
              toolCount: task.workerSteps.filter(s => s.kind === 'tool_call').length,
              ...(task.jevQualityGates[0] ? { qualityGateIndex: task.jevQualityGates[0].index } : {}),
            }];

        let pendingLoopSourceNode: FlowchartNode | undefined;

        phases.forEach((phase, pIdx) => {
          const bandY = curY;
          const phaseStepsAll = task.workerSteps.filter(s =>
            s.kind !== 'followup' && (s.phaseIndex ? s.phaseIndex === phase.index : pIdx === 0),
          );
          const stepsKey = `${flow.id}:t:${task.id}:p:${phase.index}:steps`;
          const stepsExpanded = collapseMap.has(stepsKey) ? !collapseMap.get(stepsKey) : false;
          const MAX_PHASE_SIDE = 6;
          const visibleSteps = stepsExpanded ? phaseStepsAll : phaseStepsAll.slice(0, MAX_PHASE_SIDE);
          const hasHiddenSteps = !stepsExpanded && phaseStepsAll.length > MAX_PHASE_SIDE;
          const totalGridCells = visibleSteps.length + (hasHiddenSteps ? 1 : 0);
          const gridRows = totalGridCells > 0 ? Math.ceil(totalGridCells / 2) : 0;
          const sideH = gridRows > 0 ? gridRows * FC_SIDE_H + (gridRows - 1) * FC_SIDE_BUS_GAP : 0;

          const phaseTag = phases.length > 1 ? ` #${phase.index}` : '';
          const workerNode = pushNode({
            id: `${flow.id}:fc:t:${task.id}:phase:${phase.index}`,
            flowId: flow.id,
            sessionId: session.id,
            kind: 'worker_phase',
            category: 'worker',
            shape: 'subprocess',
            icon: phase.isFollowup ? '🔁' : '⚙️',
            badge: `⑤ ${taskTag}${phase.isFollowup ? `Worker 补充执行${phaseTag}` : `Worker 自主执行${phaseTag}`}`,
            title: phase.followupPrompt
              ? shortText(phase.followupPrompt, 32)
              : shortText(task.prompt, 32),
            subtitle: `${phase.llmCount} 轮推理 · ${phase.toolCount} 次工具 · ${formatDuration(phase.durationMs)}`,
            metric: `${phase.llmCount + phase.toolCount} 步`,
            status: phase.status,
            x: FC_SPINE_X,
            y: bandY,
            w: FC_SPINE_W,
            h: FC_SPINE_H,
            ...(phaseStepsAll.length > MAX_PHASE_SIDE ? {
              toggleKey: stepsKey,
              collapsed: !stepsExpanded,
              hiddenCount: stepsExpanded ? 0 : phaseStepsAll.length - MAX_PHASE_SIDE,
            } : {}),
            inspector: { flow, task, phase, session },
          }, phaseStepsAll.map(s => `${s.title} ${s.inputPreview ?? ''} ${s.outputPreview ?? ''}`).join(' '));

          connectDown(
            prevSpine,
            workerNode,
            pIdx > 0 ? '🔁 continue_work 补充执行' : (task.jevRoute ? '启动 Worker 阶段 #1' : `${taskTag}启动 Worker`),
            pIdx > 0 ? 'warn' : 'default',
          );

          // Left-margin Loopback dashed arrow from previous Router evaluation node!
          if (pendingLoopSourceNode) {
            const sy = Math.round(pendingLoopSourceNode.y + pendingLoopSourceNode.h / 2);
            const ty = Math.round(workerNode.y + workerNode.h / 2);
            edges.push({
              id: nextEdgeId('loopback'),
              fromId: pendingLoopSourceNode.id,
              toId: workerNode.id,
              kind: 'loopback',
              tone: 'warn',
              points: [
                { x: pendingLoopSourceNode.x, y: sy },
                { x: FC_LOOP_X, y: sy },
                { x: FC_LOOP_X, y: ty },
                { x: workerNode.x, y: ty },
              ],
              label: '↺ 打回补查',
              labelX: FC_LOOP_X + 18,
              labelY: Math.round((sy + ty) / 2),
            });
            pendingLoopSourceNode = undefined;
          }

          // Side grid for Worker execution steps in this phase
          const stepCards: FlowchartNode[] = visibleSteps.map((step, sIdx) => {
            const col = sIdx % 2;
            const row = Math.floor(sIdx / 2);
            const icon = step.kind === 'llm_turn' ? '💭' : step.kind === 'ask_boss' ? '🙋' : '🔧';
            return pushNode({
              id: `${flow.id}:fc:t:${task.id}:p:${phase.index}:step:${step.id}`,
              flowId: flow.id,
              sessionId: session.id,
              kind: 'worker_step',
              category: 'worker',
              shape: 'process',
              icon,
              badge: step.toolName ? `${step.toolName} · ${formatDuration(step.durationMs)}` : `推理 · ${formatDuration(step.durationMs)}`,
              title: shortText(step.inputPreview || step.title, 26),
              subtitle: shortText(step.outputPreview || statusLabel(step.status), 30),
              status: step.status,
              x: col === 0 ? FC_SIDE1_X : FC_SIDE2_X,
              y: bandY + row * (FC_SIDE_H + FC_SIDE_BUS_GAP),
              w: FC_SIDE_W,
              h: FC_SIDE_H,
              inspector: { flow, task, phase, workerStep: step, session },
            }, `${step.title} ${step.inputPreview ?? ''} ${step.outputPreview ?? ''}`);
          });
          if (hasHiddenSteps) {
            const mIdx = visibleSteps.length;
            const col = mIdx % 2;
            const row = Math.floor(mIdx / 2);
            stepCards.push(pushNode({
              id: `${flow.id}:fc:t:${task.id}:p:${phase.index}:more`,
              flowId: flow.id,
              sessionId: session.id,
              kind: 'worker_more',
              category: 'worker',
              shape: 'process',
              icon: '➕',
              badge: '点击展开剩余步骤',
              title: `还有 ${phaseStepsAll.length - MAX_PHASE_SIDE} 个执行步骤`,
              subtitle: '点击此卡展开本阶段完整推演与命令',
              status: 'completed',
              x: col === 0 ? FC_SIDE1_X : FC_SIDE2_X,
              y: bandY + row * (FC_SIDE_H + FC_SIDE_BUS_GAP),
              w: FC_SIDE_W,
              h: FC_SIDE_H,
              toggleKey: stepsKey,
              collapsed: true,
              hiddenCount: phaseStepsAll.length - MAX_PHASE_SIDE,
              inspector: { flow, task, phase, session },
            }));
          }
          emitSideGrid(workerNode, stepCards, true, `阶段#${phase.index}步骤`);

          const matchedQg = phase.qualityGateIndex
            ? task.jevQualityGates.find(q => q.index === phase.qualityGateIndex)
            : undefined;
          const matchedReportTurn = phase.routerReportSpanId
            ? flow.routerTurns.find(rt => rt.spanId === phase.routerReportSpanId)
            : undefined;
          if (matchedReportTurn) usedRouterSpans.add(matchedReportTurn.spanId);

          prevSpine = workerNode;
          curY = bandY + Math.max(FC_SPINE_H, sideH) + advanceGap(matchedQg ? '提交 JEV 质检' : matchedReportTurn ? '汇报主控验收' : undefined);

          // ⑥ JEV Quality Gate for this phase
          let nextEdgeFromQgLabel: string | undefined;
          let nextEdgeFromQgTone: FlowchartEdgeTone = 'default';
          if (matchedQg) {
            const qBandY = curY;
            const supp = matchedQg.response.shouldSupplement;
            const scoreStr = `${matchedQg.response.score.toFixed(2)}/${matchedQg.response.maxScore}`;
            const qgNode = pushNode({
              id: `${flow.id}:fc:t:${task.id}:qg:${matchedQg.index}`,
              flowId: flow.id,
              sessionId: session.id,
              kind: 'jev_quality',
              category: 'quality',
              shape: 'decision',
              icon: supp ? '⚠️' : '✅',
              badge: `⑥ JEV 质检门禁 #${matchedQg.index}`,
              title: supp ? `建议打回补充 · ${scoreStr}` : `质检通过 · ${scoreStr}`,
              subtitle: `缺失项:${matchedQg.response.missingAspect} · 补充概率:${(matchedQg.response.supplementProbability * 100).toFixed(0)}%`,
              metric: scoreStr,
              status: supp ? 'paused' : matchedQg.status,
              x: FC_SPINE_X,
              y: qBandY,
              w: FC_SPINE_W,
              h: FC_SPINE_H,
              inspector: { flow, task, jevQuality: matchedQg, session },
            }, `${matchedQg.response.missingAspect} ${scoreStr}`);
            connectDown(prevSpine, qgNode, `阶段#${phase.index}完工交卷`);

            const qReqCard = pushNode({
              id: `${flow.id}:fc:t:${task.id}:qg:${matchedQg.index}:req`,
              flowId: flow.id,
              sessionId: session.id,
              kind: 'jev_quality_req',
              category: 'quality',
              shape: 'process',
              icon: '📤',
              badge: '怎么调用的 JEV 质检',
              title: `POST ${matchedQg.request.endpoint}`,
              subtitle: `成功:${matchedQg.request.succeededOps} · 失败:${matchedQg.request.failedOps} · 报告:${matchedQg.request.reportLength}字`,
              status: matchedQg.status,
              x: FC_SIDE1_X,
              y: qBandY,
              w: FC_SIDE_W,
              h: FC_SIDE_H,
              inspector: { flow, task, jevQuality: matchedQg, session },
            });
            const qResCard = pushNode({
              id: `${flow.id}:fc:t:${task.id}:qg:${matchedQg.index}:res`,
              flowId: flow.id,
              sessionId: session.id,
              kind: 'jev_quality_res',
              category: 'quality',
              shape: 'process',
              icon: '📥',
              badge: 'JEV 质检响应',
              title: `${scoreStr} · ${supp ? 'shouldSupplement=true' : '验收合格'}`,
              subtitle: `置信 ${(matchedQg.response.confidence * 100).toFixed(0)}% · ${matchedQg.source}`,
              status: supp ? 'paused' : matchedQg.status,
              x: FC_SIDE2_X,
              y: qBandY,
              w: FC_SIDE_W,
              h: FC_SIDE_H,
              inspector: { flow, task, jevQuality: matchedQg, session },
            });
            emitSidePair(qgNode, qReqCard, qResCard, '质检入参/评分', supp ? 'warn' : 'success');

            nextEdgeFromQgLabel = supp
              ? `⚠️ 得分 ${scoreStr} · 建议补充`
              : `✅ 得分 ${scoreStr} · 质检通过`;
            nextEdgeFromQgTone = supp ? 'warn' : 'success';
            prevSpine = qgNode;
            curY = qBandY + Math.max(FC_SPINE_H, FC_SIDE_H) + advanceGap(nextEdgeFromQgLabel);
          }

          // Router验收轮次（决定 continue_work 还是终审交付）
          if (matchedReportTurn) {
            const hasMorePhases = pIdx < phases.length - 1;
            const rBandY = curY;
            const contTool = matchedReportTurn.tools.find(t => t.toolName === 'continue_work') ?? matchedReportTurn.tools[0];
            const stageReply = hasMorePhases
              ? flow.deliveries.find((d, idx) =>
                  !usedDeliveryIds.has(d.messageId)
                  && idx < flow.deliveries.length - 1
                  && d.at >= matchedReportTurn.startedAt - 1000
                  && d.at <= (matchedReportTurn.endedAt ?? matchedReportTurn.startedAt) + 5000)
              : undefined;
            if (stageReply) usedDeliveryIds.add(stageReply.messageId);

            const evalNode = pushNode({
              id: `${flow.id}:fc:t:${task.id}:eval:${phase.index}`,
              flowId: flow.id,
              sessionId: session.id,
              kind: 'router_turn',
              category: 'router',
              shape: 'decision',
              icon: hasMorePhases ? '🔁' : '◆',
              badge: hasMorePhases ? 'Router 验收 · 决定打回补充' : 'Router 终审 · 汇总交付',
              title: hasMorePhases ? '采纳质检建议 · 追加 continue_work' : '审核结果合格 · 整理回复老板',
              subtitle: `${matchedReportTurn.llmTurns} 轮推理 · ${formatDuration(matchedReportTurn.durationMs)}${matchedReportTurn.usage ? ` · ${matchedReportTurn.usage.totalTokens} tok` : ''}`,
              metric: statusLabel(matchedReportTurn.status),
              status: matchedReportTurn.status,
              x: FC_SPINE_X,
              y: rBandY,
              w: FC_SPINE_W,
              h: FC_SPINE_H,
              inspector: { flow, routerTurn: matchedReportTurn, routerTool: contTool, task, session },
            }, matchedReportTurn.outputPreview);

            connectDown(prevSpine, evalNode, nextEdgeFromQgLabel, nextEdgeFromQgTone);
            nextEdgeFromQgLabel = undefined;

            const sideCards: FlowchartNode[] = [];
            if (contTool) {
              sideCards.push(pushNode({
                id: `${flow.id}:fc:t:${task.id}:eval-tool:${phase.index}`,
                flowId: flow.id,
                sessionId: session.id,
                kind: 'router_tool',
                category: 'router',
                shape: 'process',
                icon: hasMorePhases ? '🔁' : '🛠️',
                badge: `指令 · ${contTool.toolName}`,
                title: shortText(contTool.inputPreview || contTool.toolName, 26),
                subtitle: shortText(contTool.outputPreview || formatDuration(contTool.durationMs), 28),
                status: contTool.status,
                x: FC_SIDE1_X,
                y: rBandY,
                w: FC_SIDE_W,
                h: FC_SIDE_H,
                inspector: { flow, routerTurn: matchedReportTurn, routerTool: contTool, task, session },
              }, contTool.inputPreview));
            }
            if (stageReply) {
              sideCards.push(pushNode({
                id: `${flow.id}:fc:t:${task.id}:eval-reply:${phase.index}`,
                flowId: flow.id,
                sessionId: session.id,
                kind: 'reply_item',
                category: 'im',
                shape: 'io',
                icon: '💬',
                badge: stageReply.roleLabel,
                title: shortText(stageReply.text, 26),
                subtitle: `${formatTimeShort(stageReply.at)} · 同步阶段进展`,
                status: stageReply.status,
                x: contTool ? FC_SIDE2_X : FC_SIDE1_X,
                y: rBandY,
                w: FC_SIDE_W,
                h: FC_SIDE_H,
                inspector: { flow, delivery: stageReply, session },
              }, stageReply.text));
            }
            if (sideCards.length === 2) emitSidePair(evalNode, sideCards[0]!, sideCards[1]!, '同步并打回');
            else if (sideCards.length === 1) emitSideGrid(evalNode, sideCards, false, '验收动作');

            if (hasMorePhases) pendingLoopSourceNode = evalNode;
            prevSpine = evalNode;
            curY = rBandY + Math.max(FC_SPINE_H, sideCards.length ? FC_SIDE_H : 0) + advanceGap(hasMorePhases ? '准备补充指令' : undefined);
          } else if (nextEdgeFromQgLabel && prevSpine) {
            // Preserve loop origin when this quality-gate pass hands directly into the next phase
            if (pIdx < phases.length - 1) pendingLoopSourceNode = prevSpine;
          }
        });
      }

      // Any leftover unclaimed router turns
      const leftoverTurns = flow.routerTurns.filter(rt => !usedRouterSpans.has(rt.spanId));
      leftoverTurns.forEach((rt, idx) => {
        const extraNode = pushNode({
          id: `${flow.id}:fc:rt:extra:${idx}`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'router_turn',
          category: 'router',
          shape: 'decision',
          icon: '◆',
          badge: `Router 补充汇报轮 #${idx + 1}`,
          title: TRIGGER_LABELS[rt.triggerKind] ?? rt.triggerKind,
          subtitle: `${rt.llmTurns} 轮推理 · ${formatDuration(rt.durationMs)}`,
          status: rt.status,
          x: FC_SPINE_X,
          y: curY,
          w: FC_SPINE_W,
          h: FC_SPINE_H,
          inspector: { flow, routerTurn: rt, session },
        });
        connectDown(prevSpine, extraNode);
        prevSpine = extraNode;
        curY += FC_SPINE_H + advanceGap();
      });
    }

    // ④ Memory Consolidation (Process)
    if (flow.consolidatedMemories.length > 0) {
      const mBandY = curY;
      const cards = flow.consolidatedMemories.slice(0, 4);
      const rows = Math.ceil(cards.length / 2);
      const sideH = rows * FC_SIDE_H + (rows - 1) * FC_SIDE_BUS_GAP;
      const consNode = pushNode({
        id: `${flow.id}:fc:consolidate`,
        flowId: flow.id,
        sessionId: session.id,
        kind: 'memory_consolidate',
        category: 'memory',
        shape: 'process',
        icon: '💾',
        badge: '⑦ 海马体记忆沉淀',
        title: `新沉淀 ${flow.consolidatedMemories.length} 张经验记忆`,
        subtitle: shortText(flow.consolidatedMemories[0]!.topic, 34),
        metric: `${flow.consolidatedMemories.reduce((s, m) => s + m.synapseCount, 0)} 突触`,
        status: 'completed',
        x: FC_SPINE_X,
        y: mBandY,
        w: FC_SPINE_W,
        h: FC_SPINE_H,
        inspector: { flow, consolidatedMemory: flow.consolidatedMemories[0], session },
      }, flow.consolidatedMemories.map(m => m.topic).join(' '));
      connectDown(prevSpine, consNode, '提炼长期记忆');

      const cardNodes = cards.map((mem, mIdx) => {
        const col = mIdx % 2;
        const row = Math.floor(mIdx / 2);
        return pushNode({
          id: `${flow.id}:fc:cons:${mem.id}`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'memory_consolidate',
          category: 'memory',
          shape: 'process',
          icon: mem.pinned ? '📌' : '🗂️',
          badge: mem.autoConsolidated ? '自动巩固' : '主动记忆',
          title: shortText(mem.topic, 26),
          subtitle: shortText(mem.contentPreview, 28),
          status: 'completed',
          x: col === 0 ? FC_SIDE1_X : FC_SIDE2_X,
          y: mBandY + row * (FC_SIDE_H + FC_SIDE_BUS_GAP),
          w: FC_SIDE_W,
          h: FC_SIDE_H,
          inspector: { flow, consolidatedMemory: mem, session },
        }, `${mem.topic} ${mem.contentPreview}`);
      });
      emitSideGrid(consNode, cardNodes, true, '写入记忆库');
      prevSpine = consNode;
      curY = mBandY + Math.max(FC_SPINE_H, sideH) + advanceGap();
    }

    // ⑤ Final Delivery & IM Push (I/O Parallelogram)
    const finalDelivery = flow.deliveries.at(-1);
    const delBandY = curY;
    const imTargetNote = flow.imPush.sentFiles.length ? ` (+${flow.imPush.sentFiles.length} 附件)` : '';
    const imNode = pushNode({
      id: `${flow.id}:fc:im`,
      flowId: flow.id,
      sessionId: session.id,
      kind: 'im_delivery',
      category: 'im',
      shape: 'io',
      icon: flow.imPush.channel === 'wechat' ? '📲' : flow.imPush.channel === 'xiaoai' ? '🔊' : flow.imPush.channel === 'local' ? '📩' : '📡',
      badge: `⑧ 最终交付 → ${flow.imPush.channelName}`,
      title: finalDelivery
        ? `${shortText(finalDelivery.text || finalDelivery.reason, 30)}${imTargetNote}`
        : `${flow.imPush.delivered ? '已原路送达' : '等待生成回复'}${imTargetNote}`,
      subtitle: `${formatTimeShort(finalDelivery?.at ?? flow.completedAt)} · 共 ${flow.deliveries.length} 条回复`,
      metric: flow.imPush.delivered ? '已送达' : statusLabel(flow.status),
      status: flow.imPush.delivered ? 'completed' : flow.status,
      x: FC_SPINE_X,
      y: delBandY,
      w: FC_SPINE_W,
      h: FC_SPINE_H,
      inspector: { flow, delivery: finalDelivery, session },
    }, flow.deliveries.map(d => d.text).join(' '));
    connectDown(prevSpine, imNode, `推送 ${flow.imPush.channel === 'wechat' ? '微信' : flow.imPush.channel === 'xiaoai' ? '小爱音箱' : flow.imPush.channel === 'local' ? '控制台' : flow.imPush.channel}`, flow.imPush.delivered ? 'success' : 'default');

    // Side card if files sent or multiple replies exist
    const sideDeliveries: FlowchartNode[] = [];
    if (flow.deliveries.length > 1 || flow.imPush.sentFiles.length > 0) {
      if (finalDelivery) {
        sideDeliveries.push(pushNode({
          id: `${flow.id}:fc:final-del-card`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'reply_item',
          category: 'im',
          shape: 'io',
          icon: '✉️',
          badge: finalDelivery.roleLabel,
          title: shortText(finalDelivery.text, 26),
          subtitle: `${formatTimeShort(finalDelivery.at)} · 点击看完整原文`,
          status: finalDelivery.status,
          x: FC_SIDE1_X,
          y: delBandY,
          w: FC_SIDE_W,
          h: FC_SIDE_H,
          inspector: { flow, delivery: finalDelivery, session },
        }, finalDelivery.text));
      }
      if (flow.imPush.sentFiles.length > 0) {
        sideDeliveries.push(pushNode({
          id: `${flow.id}:fc:sent-files`,
          flowId: flow.id,
          sessionId: session.id,
          kind: 'im_delivery',
          category: 'im',
          shape: 'process',
          icon: '📎',
          badge: `发送微信/IM 附件 (${flow.imPush.sentFiles.length})`,
          title: shortText(flow.imPush.sentFiles.map(f => f.name).join(', '), 26),
          subtitle: flow.imPush.target ?? flow.imPush.channelName,
          status: 'completed',
          x: sideDeliveries.length ? FC_SIDE2_X : FC_SIDE1_X,
          y: delBandY,
          w: FC_SIDE_W,
          h: FC_SIDE_H,
          inspector: { flow, delivery: finalDelivery, session },
        }));
      }
      if (sideDeliveries.length === 2) emitSidePair(imNode, sideDeliveries[0]!, sideDeliveries[1]!, '正文与附件', 'success');
      else if (sideDeliveries.length === 1) emitSideGrid(imNode, sideDeliveries, false, '交付内容');
    }

    const frameBottomY = delBandY + Math.max(FC_SPINE_H, sideDeliveries.length ? FC_SIDE_H : 0) + 22;
    const frameH = frameBottomY - frameTopY;
    frames.push({
      id: `frame:${flow.id}`,
      sessionId: session.id,
      flowId: flow.id,
      turnIndex: turnIdx + 1,
      turnCount: turns.length,
      title: `第 ${turnIdx + 1}/${turns.length} 轮 · ${flow.ingress.channelLabel} · #${flow.seq || '独立'}`,
      subtitle: firstTurnTitle,
      badge: linkBadge ?? statusLabel(flow.status),
      status: flow.status,
      x: FC_FRAME_X,
      y: frameTopY,
      w: FC_FRAME_W,
      h: frameH,
      collapsed: false,
      toggleKey: turns.length > 1 ? frameKey : undefined,
    });

    prevTurnTailNode = imNode;
    globalY = frameBottomY + (turnIdx < turns.length - 1 ? 66 : 28);
  });

  return {
    mode: 'session',
    width: FC_FRAME_X * 2 + FC_FRAME_W,
    height: Math.max(globalY, 320),
    frames,
    nodes,
    edges,
  };
}

export function buildOverviewFlowchart(
  sessions: MindmapSession[],
  flowsById: Map<string, MindmapTaskFlow>,
  snapshot: MindmapSnapshot | null,
  searchTerm: string,
): FlowchartGraph {
  const needle = searchTerm.trim().toLowerCase();
  const frames: FlowchartFrame[] = [];
  const nodes: FlowchartNode[] = [];
  const edges: FlowchartEdge[] = [];

  const PIPE_FRAME_X = 24;
  const PIPE_FRAME_W = 1480;
  const STAGE_W = 248;
  const STAGE_H = 74;
  const STAGE_GAP = 42;
  const START_X = PIPE_FRAME_X + 24;
  const ROW_STEP = 166;
  let y = 20;
  let edgeId = 0;

  sessions.forEach((session, sIdx) => {
    const turns = resolveSessionTurns(session, flowsById);
    const primaryFlow = turns[turns.length - 1] ?? null;
    const frameY = y;
    const nodeY = frameY + 56;
    const totalTasks = session.taskCount;
    const totalJev = session.jevCallCount;

    const addStage = (col: number, raw: Omit<FlowchartNode, 'x' | 'y' | 'w' | 'h' | 'searchText' | 'match'>, extra?: string) => {
      const searchText = nodeSearchBlob(raw.badge, raw.title, raw.subtitle, `${session.title} ${extra ?? ''}`);
      const match = Boolean(needle) && searchText.includes(needle);
      const node: FlowchartNode = {
        ...raw,
        x: START_X + col * (STAGE_W + STAGE_GAP),
        y: nodeY,
        w: STAGE_W,
        h: STAGE_H,
        searchText,
        match,
      };
      nodes.push(node);
      return node;
    };

    const s0 = addStage(0, {
      id: `${session.id}:ov:0`,
      flowId: primaryFlow?.id ?? session.id,
      sessionId: session.id,
      kind: 'session_summary',
      category: session.channels.includes('wechat') || session.channels.includes('xiaoai') ? 'im' : session.kind === 'timer' ? 'router' : 'ingress',
      shape: 'pill',
      icon: session.turnCount > 1 ? '🗂️' : sourceIcon(turns[0]?.ingress.sourceKind ?? 'local'),
      badge: `${session.turnCount > 1 ? `多轮会话 (${session.turnCount}轮)` : '单轮对话'} · ${session.primaryChannelLabel}`,
      title: shortText(session.title, 26),
      subtitle: `${formatTimeShort(session.startedAt)} ~ ${formatTimeShort(session.updatedAt)}`,
      status: session.status,
      inspector: { flow: primaryFlow, snapshot: snapshot ?? undefined, session },
    }, turns.map(t => t.ingress.text).join(' '));

    const s1 = addStage(1, {
      id: `${session.id}:ov:1`,
      flowId: primaryFlow?.id ?? session.id,
      sessionId: session.id,
      kind: 'memory_group',
      category: 'memory',
      shape: 'process',
      icon: '🧠',
      badge: 'AI 上下文 & 记忆召回',
      title: `召回 ${session.recalledMemoryCount} 条 · 沉淀 ${session.consolidatedMemoryCount} 条`,
      subtitle: session.turnCount > 1 ? '跨轮语义上下文连贯管理' : '工作空间目录记忆联想',
      status: 'completed',
      inspector: { flow: primaryFlow, snapshot: snapshot ?? undefined, session },
    });

    const firstTask = turns.flatMap(t => t.tasks)[0];
    const s2 = addStage(2, {
      id: `${session.id}:ov:2`,
      flowId: primaryFlow?.id ?? session.id,
      sessionId: session.id,
      kind: 'router_turn',
      category: 'router',
      shape: 'decision',
      icon: '◆',
      badge: 'Router & JEV 决策',
      title: totalTasks > 0
        ? `派发 ${totalTasks} 任务 · JEV ${totalJev} 次`
        : '主控直回 / 插件调度',
      subtitle: firstTask?.jevRoute?.response.selectedModel
        ? `选模 ${shortText(firstTask.jevRoute.response.selectedModel.split('/').pop(), 20)}@${firstTask.jevRoute.response.thinkingLevel ?? 'med'}`
        : `${snapshot?.summary.routerModel ?? '主控模型'}`,
      status: session.status,
      inspector: { flow: primaryFlow, task: firstTask, snapshot: snapshot ?? undefined, session },
    });

    const totalPhases = turns.flatMap(t => t.tasks).reduce((sum, t) => sum + (t.executionPhases?.length || 1), 0);
    const totalSteps = turns.flatMap(t => t.tasks).reduce((sum, t) => sum + t.totalSteps, 0);
    const lastQg = turns.flatMap(t => t.tasks).flatMap(t => t.jevQualityGates).at(-1);
    const s3 = addStage(3, {
      id: `${session.id}:ov:3`,
      flowId: primaryFlow?.id ?? session.id,
      sessionId: session.id,
      kind: 'worker_exec',
      category: totalTasks ? 'worker' : 'router',
      shape: 'subprocess',
      icon: totalTasks ? '⚙️' : '⚡',
      badge: totalTasks ? 'Worker 执行 & 质检' : '轻量化执行路径',
      title: totalTasks
        ? `${totalPhases} 轮执行 · ${totalSteps} 个步骤`
        : (turns[0]?.directPlugin ? `插件 ${turns[0].directPlugin.plugin}` : '无后台重型任务'),
      subtitle: lastQg
        ? `终检得分 ${lastQg.response.score.toFixed(2)}/${lastQg.response.maxScore}`
        : (totalTasks ? 'Worker 完成全部操作' : '即时响应完毕'),
      status: session.status,
      inspector: { flow: primaryFlow, task: firstTask, snapshot: snapshot ?? undefined, session },
    });

    const lastTurn = turns.at(-1);
    const s4 = addStage(4, {
      id: `${session.id}:ov:4`,
      flowId: primaryFlow?.id ?? session.id,
      sessionId: session.id,
      kind: 'im_delivery',
      category: 'im',
      shape: 'io',
      icon: lastTurn?.imPush.channel === 'wechat' ? '📲' : lastTurn?.imPush.channel === 'xiaoai' ? '🔊' : '📩',
      badge: `IM 交付 · ${lastTurn?.imPush.channelName ?? '控制台'}`,
      title: lastTurn?.deliveries.at(-1)?.text
        ? shortText(lastTurn.deliveries.at(-1)!.text, 26)
        : '点击进入完整思考流程图',
      subtitle: lastTurn?.imPush.delivered ? '已送达 · 双击查看全链路' : statusLabel(session.status),
      status: session.status,
      inspector: { flow: primaryFlow, delivery: lastTurn?.deliveries.at(-1), snapshot: snapshot ?? undefined, session },
    });

    const rowStages = [s0, s1, s2, s3, s4];
    for (let i = 0; i < rowStages.length - 1; i += 1) {
      const a = rowStages[i]!;
      const b = rowStages[i + 1]!;
      edges.push({
        id: `ov-edge:${++edgeId}`,
        fromId: a.id,
        toId: b.id,
        kind: 'spine',
        tone: i === 2 && totalJev > 0 ? 'accent' : i === 3 && lastTurn?.imPush.delivered ? 'success' : 'default',
        points: [{ x: a.x + a.w, y: Math.round(a.y + a.h / 2) }, { x: b.x, y: Math.round(b.y + b.h / 2) }],
      });
    }

    frames.push({
      id: `ov-frame:${session.id}`,
      sessionId: session.id,
      title: `会话 #${sIdx + 1} · ${session.title}`,
      subtitle: turns.map((t, idx) => `#${t.seq || idx + 1}:${shortText(t.ingress.text, 16)}`).join('  ➔  '),
      badge: `${session.turnCount} 轮 · 点击切换详解`,
      status: session.status,
      x: PIPE_FRAME_X,
      y: frameY,
      w: PIPE_FRAME_W,
      h: 146,
    });

    y += ROW_STEP;
  });

  return {
    mode: 'overview',
    width: PIPE_FRAME_X * 2 + PIPE_FRAME_W,
    height: Math.max(y + 20, 320),
    frames,
    nodes,
    edges,
  };
}

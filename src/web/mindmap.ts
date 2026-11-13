import {
  buildOverviewFlowchart,
  buildSessionFlowchart,
  formatDuration,
  formatTimeShort,
  getEffectiveSessions,
  resolveSessionTurns,
  shortText,
  sourceIcon,
  statusLabel,
  type FlowchartEdge,
  type FlowchartFrame,
  type FlowchartGraph,
  type FlowchartNode,
  type InspectorPayload,
  type MindmapDeliveryItem,
  type MindmapJevQualityGateItem,
  type MindmapJevRouteInfo,
  type MindmapRecalledItem,
  type MindmapRouterToolCall,
  type MindmapRouterTurn,
  type MindmapSession,
  type MindmapSnapshot,
  type MindmapTaskDetail,
  type MindmapTaskFlow,
  type MindmapWorkerPhase,
  type MindmapWorkerStep,
} from './mindmap-data.js';

const TOKEN_STORAGE_KEY = 'super-agent.local-access-token';
const SVG_NS = 'http://www.w3.org/2000/svg';

type ViewMode = 'session' | 'overview' | 'list';
type SidebarMode = 'sessions' | 'turns';
type FilterKind = 'all' | 'multiturn' | 'wechat' | 'local' | 'timer' | 'jev';

function el<T extends Element = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as unknown as T;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function domEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function extractBootstrapToken(): string {
  const hash = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash);
  const hashToken = hash.get('token')?.trim();
  if (hashToken) {
    try { sessionStorage.setItem(TOKEN_STORAGE_KEY, hashToken); } catch { /* ignore */ }
    hash.delete('token');
    const cleanHash = hash.toString();
    history.replaceState(null, '', `${location.pathname}${location.search}${cleanHash ? `#${cleanHash}` : ''}`);
    return hashToken;
  }
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

let accessToken = extractBootstrapToken();
let snapshot: MindmapSnapshot | null = null;
let loadedFlows: MindmapTaskFlow[] = [];
let viewMode: ViewMode = 'session';
let sidebarMode: SidebarMode = 'sessions';
let filterKind: FilterKind = 'all';
let searchTerm = '';
let selectedSessionId = '';
let selectedFlowId = '';
let selectedNodeId = '';
let sseAbort: AbortController | null = null;
let sseCursor = 0;
let refreshTimer: number | undefined;

const collapseOverride = new Map<string, boolean>();
let currentGraph: FlowchartGraph | null = null;
let panX = 24;
let panY = 18;
let zoom = 1;
let isDragging = false;
let dragMoved = false;
let dragStartX = 0;
let dragStartY = 0;
let dragPanStartX = 0;
let dragPanStartY = 0;

const workspaceEl = el<HTMLElement>('mm-canvas-panel').parentElement!;
const backLinkEl = el<HTMLAnchorElement>('mm-back-link');
const toggleSidebarBtn = el<HTMLButtonElement>('mm-toggle-sidebar');
const viewSessionBtn = el<HTMLButtonElement>('view-session-btn');
const viewOverviewBtn = el<HTMLButtonElement>('view-overview-btn');
const viewListBtn = el<HTMLButtonElement>('view-list-btn');
const searchInput = el<HTMLInputElement>('mm-search-input');
const searchClearBtn = el<HTMLButtonElement>('mm-search-clear');
const expandAllBtn = el<HTMLButtonElement>('mm-expand-all');
const collapseAllBtn = el<HTMLButtonElement>('mm-collapse-all');
const zoomOutBtn = el<HTMLButtonElement>('mm-zoom-out');
const zoomInBtn = el<HTMLButtonElement>('mm-zoom-in');
const zoomLabelEl = el<HTMLSpanElement>('mm-zoom-label');
const fitWidthBtn = el<HTMLButtonElement>('mm-fit-width-btn');
const fitBtn = el<HTMLButtonElement>('mm-fit-btn');
const refreshBtn = el<HTMLButtonElement>('mm-refresh-btn');
const connPillEl = el<HTMLSpanElement>('mm-conn-pill');
const canvasControlsEl = el<HTMLElement>('mm-canvas-controls');

const kpiSessionsEl = el<HTMLElement>('kpi-sessions');
const kpiFlowsEl = el<HTMLElement>('kpi-flows');
const kpiWechatEl = el<HTMLElement>('kpi-wechat');
const kpiLocalEl = el<HTMLElement>('kpi-local');
const kpiTimerEl = el<HTMLElement>('kpi-timer');
const kpiTasksEl = el<HTMLElement>('kpi-tasks');
const kpiJevEl = el<HTMLElement>('kpi-jev');
const kpiMemoriesEl = el<HTMLElement>('kpi-memories');
const kpiModelBadgeEl = el<HTMLElement>('kpi-model-badge');

const sidebarModeSessionsBtn = el<HTMLButtonElement>('sidebar-mode-sessions');
const sidebarModeTurnsBtn = el<HTMLButtonElement>('sidebar-mode-turns');
const filterPillsEl = el<HTMLElement>('mm-filter-pills');
const sidebarCountEl = el<HTMLElement>('mm-sidebar-count');
const flowListEl = el<HTMLElement>('mm-flow-list');
const loadMoreWrapEl = el<HTMLElement>('mm-load-more-wrap');
const loadMoreBtn = el<HTMLButtonElement>('mm-load-more-btn');

const canvasPanelEl = el<HTMLElement>('mm-canvas-panel');
const listPanelEl = el<HTMLElement>('mm-list-panel');
const matrixSubtitleEl = el<HTMLElement>('mm-matrix-subtitle');
const matrixGridEl = el<HTMLElement>('mm-matrix-grid');
const authBannerEl = el<HTMLElement>('mm-auth-banner');

const svgElRoot = el<SVGSVGElement>('mm-svg');
const viewportEl = el<SVGGElement>('mm-viewport');
const framesLayerEl = el<SVGGElement>('mm-frames');
const edgesLayerEl = el<SVGGElement>('mm-edges');
const nodesLayerEl = el<SVGGElement>('mm-nodes');
const inspectorBodyEl = el<HTMLElement>('mm-inspector-body');

async function apiGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const res = await fetch(path, { headers });
  if (res.status === 401) {
    authBannerEl.hidden = false;
    connPillEl.textContent = '需要令牌认证';
    connPillEl.className = 'mm-conn-pill error';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${errText}`);
  }
  return res.json() as Promise<T>;
}

function setConnState(state: 'live' | 'error' | 'loading', label: string) {
  connPillEl.textContent = label;
  connPillEl.className = `mm-conn-pill${state === 'live' ? ' live' : state === 'error' ? ' error' : ''}`;
}

function flowMatchesSearchText(flow: MindmapTaskFlow, q: string): boolean {
  const hay = [
    String(flow.seq),
    flow.ingress.channelLabel,
    flow.ingress.text,
    ...flow.memoryRecall.recalledItems.map(m => `${m.title} ${m.snippet}`),
    ...flow.routerTurns.flatMap(rt => rt.tools.map(tl => `${tl.toolName} ${tl.inputPreview ?? ''}`)),
    ...flow.tasks.flatMap(t => [
      t.prompt,
      t.jevRoute?.response.selectedModel ?? '',
      t.jevRoute?.response.thinkingLevel ?? '',
      t.jevRoute?.source ?? '',
      ...t.workerSteps.map(s => `${s.title} ${s.inputPreview ?? ''} ${s.outputPreview ?? ''}`),
      ...t.jevQualityGates.map(g => `${g.response.missingAspect} ${g.response.score}`),
    ]),
    ...flow.deliveries.map(d => d.text),
  ].join('\n').toLowerCase();
  return hay.includes(q);
}

function flowMatchesFilter(flow: MindmapTaskFlow): boolean {
  if (filterKind === 'multiturn' && (flow.turnCount ?? 1) < 2) return false;
  if (filterKind === 'wechat' && flow.ingress.sourceKind !== 'wechat' && flow.imPush.channel !== 'wechat') return false;
  if (filterKind === 'local' && flow.ingress.sourceKind !== 'local') return false;
  if (filterKind === 'timer' && flow.ingress.sourceKind !== 'timer') return false;
  if (filterKind === 'jev' && !flow.tasks.some(t => Boolean(t.jevRoute?.called) || t.jevQualityGates.length > 0)) return false;
  if (!searchTerm) return true;
  return flowMatchesSearchText(flow, searchTerm.toLowerCase());
}

function sessionMatchesFilter(session: MindmapSession, flowsById: Map<string, MindmapTaskFlow>): boolean {
  const turns = resolveSessionTurns(session, flowsById);
  if (!turns.length) return false;
  if (filterKind === 'multiturn' && session.turnCount < 2) return false;
  if (filterKind === 'wechat' && !turns.some(t => t.ingress.sourceKind === 'wechat' || t.imPush.channel === 'wechat')) return false;
  if (filterKind === 'local' && !turns.some(t => t.ingress.sourceKind === 'local')) return false;
  if (filterKind === 'timer' && session.kind !== 'timer') return false;
  if (filterKind === 'jev' && !turns.some(t => t.tasks.some(tk => Boolean(tk.jevRoute?.called) || tk.jevQualityGates.length > 0))) return false;
  if (!searchTerm) return true;
  const q = searchTerm.toLowerCase();
  return session.title.toLowerCase().includes(q) || turns.some(t => flowMatchesSearchText(t, q));
}

function getFilteredFlows(): MindmapTaskFlow[] {
  return loadedFlows.filter(flowMatchesFilter);
}

function getAllSessions(): { all: MindmapSession[]; filtered: MindmapSession[]; flowsById: Map<string, MindmapTaskFlow> } {
  const flowsById = new Map(loadedFlows.map(f => [f.id, f]));
  const all = getEffectiveSessions(snapshot, loadedFlows);
  const filtered = all.filter(s => sessionMatchesFilter(s, flowsById));
  return { all, filtered, flowsById };
}

function findSessionForFlow(flowId: string, sessions: MindmapSession[]): MindmapSession | undefined {
  return sessions.find(s => s.turnFlowIds.includes(flowId));
}

function applyViewportTransform() {
  viewportEl.setAttribute('transform', `translate(${panX.toFixed(1)},${panY.toFixed(1)}) scale(${zoom.toFixed(3)})`);
  zoomLabelEl.textContent = `${Math.round(zoom * 100)}%`;
}

function fitWidthTop() {
  if (!currentGraph) return;
  const rect = svgElRoot.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const availW = Math.max(300, rect.width - 40);
  zoom = Math.max(0.45, Math.min(1.0, availW / Math.max(1, currentGraph.width)));
  panX = Math.max(14, (rect.width - currentGraph.width * zoom) / 2);
  panY = 18;
  applyViewportTransform();
}

function fitToCanvas() {
  if (!currentGraph) return;
  const rect = svgElRoot.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const availW = Math.max(300, rect.width - 44);
  const availH = Math.max(260, rect.height - 76);
  zoom = Math.max(0.22, Math.min(1.05, Math.min(availW / Math.max(1, currentGraph.width), availH / Math.max(1, currentGraph.height))));
  panX = Math.max(16, (rect.width - currentGraph.width * zoom) / 2);
  panY = Math.max(18, (rect.height - 50 - currentGraph.height * zoom) / 2);
  applyViewportTransform();
}

function scrollToFrame(frameId: string) {
  if (!currentGraph) return;
  const frame = currentGraph.frames.find(f => f.id === frameId);
  if (!frame) return;
  const rect = svgElRoot.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  zoom = Math.max(zoom, 0.78);
  panX = Math.max(14, (rect.width - currentGraph.width * zoom) / 2);
  panY = Math.min(28, 28 - frame.y * zoom);
  applyViewportTransform();
}

function renderKpis() {
  if (!snapshot) return;
  const s = snapshot.summary;
  const { all } = getAllSessions();
  const totalSessions = s.totalSessions ?? all.length;
  const multiTurn = s.multiTurnSessions ?? all.filter(sess => sess.turnCount >= 2).length;
  kpiSessionsEl.textContent = multiTurn > 0 ? `${totalSessions} (${multiTurn} 多轮)` : String(totalSessions);
  kpiFlowsEl.textContent = String(s.totalFlows);
  kpiWechatEl.textContent = String(s.wechatFlows);
  kpiLocalEl.textContent = String(s.localFlows);
  kpiTimerEl.textContent = String(s.timerFlows);
  kpiTasksEl.textContent = String(s.totalTasks);
  kpiJevEl.textContent = String(s.jevCalls);
  kpiMemoriesEl.textContent = String(s.totalMemories);
  kpiModelBadgeEl.textContent = `主控: ${s.routerProvider}/${s.routerModel} · 决策: ${s.decisionModel}${s.decisionConfigured ? ' ✓' : ' (启发式)'}`;
}

function renderSidebar() {
  const { all, filtered, flowsById } = getAllSessions();
  const filteredFlows = getFilteredFlows();

  if (sidebarMode === 'sessions') {
    const multiCount = filtered.filter(s => s.turnCount >= 2).length;
    sidebarCountEl.textContent = snapshot
      ? `显示 ${filtered.length} 个会话 (多轮 ${multiCount}) / 已载 ${all.length} 会话`
      : '等待数据…';
  } else {
    sidebarCountEl.textContent = snapshot
      ? `显示 ${filteredFlows.length} / 已加载 ${loadedFlows.length} (全库 ${snapshot.summary.totalFlows} 条)`
      : '等待数据…';
  }
  loadMoreWrapEl.hidden = !snapshot?.hasMore;

  flowListEl.replaceChildren();
  if (sidebarMode === 'sessions') {
    if (!filtered.length) {
      flowListEl.appendChild(domEl('p', 'mm-muted', '当前筛选条件下没有匹配的 AI 会话。'));
      return;
    }
    for (const session of filtered) {
      const turns = resolveSessionTurns(session, flowsById);
      const first = turns[0]!;
      const last = turns[turns.length - 1]!;
      const srcClass = session.channels.includes('wechat')
        ? 'src-wechat'
        : session.kind === 'timer'
          ? 'src-timer'
          : 'src-local';
      const item = domEl('button', `mm-flow-item ${srcClass}${session.id === selectedSessionId ? ' active' : ''}`);
      item.type = 'button';

      const top = domEl('div', 'mm-flow-item-top');
      const timeRange = session.turnCount > 1
        ? `${sourceIcon(first.ingress.sourceKind)} ${formatTimeShort(session.startedAt)} ~ ${formatTimeShort(session.updatedAt).slice(6)}`
        : `${sourceIcon(first.ingress.sourceKind)} #${first.seq || '后台'} · ${formatTimeShort(session.startedAt)}`;
      top.appendChild(domEl('span', undefined, timeRange));
      const badgeGroup = domEl('div', 'mm-insp-badges');
      if (session.turnCount > 1) {
        badgeGroup.appendChild(domEl('span', 'mm-session-turns-badge', `${session.turnCount} 轮`));
      }
      badgeGroup.appendChild(domEl('span', `mm-badge st-${session.status}`, statusLabel(session.status)));
      top.appendChild(badgeGroup);

      const textEl = domEl('div', 'mm-flow-item-text', session.title);

      const chain = domEl('div', 'mm-flow-item-chain');
      if (session.recalledMemoryCount) chain.appendChild(domEl('span', 'mm-mini-tag', `🧠${session.recalledMemoryCount}`));
      if (session.taskCount) {
        const firstTask = turns.flatMap(t => t.tasks)[0];
        const modelShort = firstTask?.jevRoute?.response.selectedModel?.split('/').pop() ?? 'Worker';
        chain.appendChild(domEl('span', 'mm-mini-tag jev', `🎯${shortText(modelShort, 16)}`));
        const lastQg = turns.flatMap(t => t.tasks).flatMap(t => t.jevQualityGates).at(-1);
        if (lastQg && lastQg.status !== 'skipped') {
          chain.appendChild(domEl('span', 'mm-mini-tag quality', `⚖️${lastQg.response.score.toFixed(1)}/${lastQg.response.maxScore}`));
        }
      }
      if (session.channels.includes('wechat')) chain.appendChild(domEl('span', 'mm-mini-tag wechat', '📲微信'));

      item.append(top, textEl, chain);
      if (session.turnCount > 1) {
        const previewList = domEl('div', 'mm-flow-turn-pills');
        session.turnSummaries.slice(-3).forEach((ts, idx) => {
          const prefix = ts.link ? '↳ ' : `${idx + 1}. `;
          previewList.appendChild(domEl('div', 'mm-flow-turn-line', `${prefix}#${ts.seq} ${shortText(ts.textPreview, 28)}`));
        });
        item.appendChild(previewList);
      }

      item.addEventListener('click', () => {
        selectedSessionId = session.id;
        selectedFlowId = last.id;
        selectedNodeId = '';
        renderSidebar();
        if (viewMode === 'list') {
          renderListMatrix();
          renderInspectorForPayload({ flow: last, snapshot: snapshot ?? undefined, session });
        } else if (viewMode === 'overview') {
          rebuildAndRenderCanvas(false);
          scrollToFrame(`ov-frame:${session.id}`);
        } else {
          rebuildAndRenderCanvas(true);
        }
      });
      flowListEl.appendChild(item);
    }
    return;
  }

  // Turn-by-turn fallback sidebar mode
  if (!filteredFlows.length) {
    flowListEl.appendChild(domEl('p', 'mm-muted', '当前筛选条件下没有匹配的消息记录。'));
    return;
  }
  for (const flow of filteredFlows) {
    const item = domEl('button', `mm-flow-item src-${flow.ingress.sourceKind}${flow.id === selectedFlowId ? ' active' : ''}`);
    item.type = 'button';

    const top = domEl('div', 'mm-flow-item-top');
    const turnTag = flow.turnCount && flow.turnCount > 1 ? ` · 第${flow.turnIndex}/${flow.turnCount}轮` : '';
    top.appendChild(domEl('span', undefined, `${sourceIcon(flow.ingress.sourceKind)} #${flow.seq || '后台'}${turnTag} · ${formatTimeShort(flow.createdAt)}`));
    top.appendChild(domEl('span', `mm-badge st-${flow.status}`, statusLabel(flow.status)));

    const textEl = domEl('div', 'mm-flow-item-text', shortText(flow.ingress.text, 56));
    const chain = domEl('div', 'mm-flow-item-chain');
    if (flow.sessionLink) chain.appendChild(domEl('span', 'mm-mini-tag', shortText(flow.sessionLink.label, 22)));
    if (flow.memoryRecall.recalledItems.length) chain.appendChild(domEl('span', 'mm-mini-tag', `🧠${flow.memoryRecall.recalledItems.length}`));
    if (flow.tasks.length) {
      const t = flow.tasks[0]!;
      const modelShort = t.jevRoute?.response.selectedModel?.split('/').pop() ?? 'Worker';
      chain.appendChild(domEl('span', 'mm-mini-tag jev', `🎯${shortText(modelShort, 16)}`));
    }
    if (flow.imPush.channel === 'wechat') chain.appendChild(domEl('span', 'mm-mini-tag wechat', '📲微信'));

    item.append(top, textEl, chain);
    item.addEventListener('click', () => {
      const owner = findSessionForFlow(flow.id, all);
      if (owner) selectedSessionId = owner.id;
      selectedFlowId = flow.id;
      selectedNodeId = `${flow.id}:fc:ingress`;
      renderSidebar();
      if (viewMode === 'list') {
        renderListMatrix();
        renderInspectorForPayload({ flow, snapshot: snapshot ?? undefined, session: owner });
      } else {
        rebuildAndRenderCanvas(false);
        scrollToFrame(viewMode === 'overview' && owner ? `ov-frame:${owner.id}` : `frame:${flow.id}`);
      }
    });
    flowListEl.appendChild(item);
  }
}

function pointsToRoundedOrthogonalPath(pts: Array<{ x: number; y: number }>, radius = 8): string {
  if (pts.length < 2) return '';
  if (pts.length === 2) {
    return `M ${pts[0]!.x} ${pts[0]!.y} L ${pts[1]!.x} ${pts[1]!.y}`;
  }
  const cmds: string[] = [`M ${pts[0]!.x} ${pts[0]!.y}`];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1]!;
    const dx1 = cur.x - prev.x;
    const dy1 = cur.y - prev.y;
    const dx2 = next.x - cur.x;
    const dy2 = next.y - cur.y;
    const len1 = Math.hypot(dx1, dy1);
    const len2 = Math.hypot(dx2, dy2);
    if (len1 < 1 || len2 < 1) {
      cmds.push(`L ${cur.x} ${cur.y}`);
      continue;
    }
    const r = Math.min(radius, len1 / 2, len2 / 2);
    const xBefore = cur.x - (dx1 / len1) * r;
    const yBefore = cur.y - (dy1 / len1) * r;
    const xAfter = cur.x + (dx2 / len2) * r;
    const yAfter = cur.y + (dy2 / len2) * r;
    cmds.push(`L ${xBefore.toFixed(1)} ${yBefore.toFixed(1)} Q ${cur.x} ${cur.y} ${xAfter.toFixed(1)} ${yAfter.toFixed(1)}`);
  }
  const last = pts[pts.length - 1]!;
  cmds.push(`L ${last.x} ${last.y}`);
  return cmds.join(' ');
}

function renderFlowchartNodeShape(g: SVGGElement, n: FlowchartNode) {
  const { w, h, shape } = n;
  if (shape === 'pill') {
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: h, rx: Math.round(h / 2), ry: Math.round(h / 2), class: 'mm-node-box fc-shape-pill' }));
  } else if (shape === 'decision') {
    const inset = 18;
    const pts = `${inset},0 ${w - inset},0 ${w},${h / 2} ${w - inset},${h} ${inset},${h} 0,${h / 2}`;
    g.appendChild(svgEl('polygon', { points: pts, class: 'mm-node-box fc-shape-decision' }));
  } else if (shape === 'io') {
    const skew = 14;
    const pts = `${skew},0 ${w},0 ${w - skew},${h} 0,${h}`;
    g.appendChild(svgEl('polygon', { points: pts, class: 'mm-node-box fc-shape-io' }));
  } else if (shape === 'subprocess') {
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: h, rx: 8, ry: 8, class: 'mm-node-box fc-shape-subprocess' }));
    g.appendChild(svgEl('line', { x1: 10, y1: 0, x2: 10, y2: h, class: 'fc-sub-bar' }));
    g.appendChild(svgEl('line', { x1: w - 10, y1: 0, x2: w - 10, y2: h, class: 'fc-sub-bar' }));
  } else {
    g.appendChild(svgEl('rect', { x: 0, y: 0, width: w, height: h, rx: 8, ry: 8, class: 'mm-node-box fc-shape-process' }));
    g.appendChild(svgEl('rect', { x: 0, y: 10, width: 4, height: h - 20, rx: 2, class: 'mm-node-accent' }));
  }

  const padLeft = shape === 'decision' || shape === 'pill' ? 24 : shape === 'io' ? 20 : shape === 'subprocess' ? 18 : 13;
  const padRight = shape === 'decision' || shape === 'pill' ? 24 : shape === 'io' ? 22 : shape === 'subprocess' ? 18 : 14;

  const badgeText = svgEl('text', { x: padLeft, y: 20, class: 'mm-node-badge-text' });
  badgeText.textContent = `${n.icon} ${shortText(n.badge, w < 270 ? 24 : 30)}`;
  g.appendChild(badgeText);

  if (n.status) {
    g.appendChild(svgEl('circle', {
      cx: w - padRight + 4,
      cy: 16,
      r: 4,
      class: `mm-status-dot st-${n.status}`,
    }));
  }

  if (n.metric) {
    const metricText = svgEl('text', {
      x: w - padRight - 6,
      y: 20,
      'text-anchor': 'end',
      class: 'mm-node-metric',
    });
    metricText.textContent = shortText(n.metric, 14);
    g.appendChild(metricText);
  }

  const titleMaxChars = Math.floor((w - padLeft - padRight) / 11);
  const titleText = svgEl('text', { x: padLeft, y: 41, class: 'mm-node-title' });
  titleText.textContent = shortText(n.title, Math.max(18, titleMaxChars));

  const subText = svgEl('text', { x: padLeft, y: 59, class: 'mm-node-sub' });
  subText.textContent = shortText(n.subtitle, Math.max(22, titleMaxChars + 5));

  g.append(titleText, subText);
}

function renderFlowchartCanvas() {
  if (!currentGraph) return;
  framesLayerEl.replaceChildren();
  edgesLayerEl.replaceChildren();
  nodesLayerEl.replaceChildren();

  const { all } = getAllSessions();
  const anyMatch = Boolean(searchTerm && currentGraph.nodes.some(n => n.match));

  // 1) Frames (Turn or Session swimlane containers)
  for (const frame of currentGraph.frames) {
    const fg = svgEl('g', { class: `fc-turn-frame st-${frame.status}` });
    fg.appendChild(svgEl('rect', {
      x: frame.x,
      y: frame.y,
      width: frame.w,
      height: frame.h,
      rx: 12,
      class: 'fc-frame-box',
    }));
    fg.appendChild(svgEl('rect', {
      x: frame.x,
      y: frame.y,
      width: frame.w,
      height: 42,
      rx: 12,
      class: 'fc-frame-header',
    }));

    const tText = svgEl('text', { x: frame.x + 16, y: frame.y + 18, class: 'fc-frame-title' });
    tText.textContent = frame.title;
    const sText = svgEl('text', { x: frame.x + 16, y: frame.y + 34, class: 'fc-frame-sub' });
    sText.textContent = shortText(frame.subtitle, 82);
    const bText = svgEl('text', {
      x: frame.toggleKey ? frame.x + frame.w - 94 : frame.x + frame.w - 16,
      y: frame.y + 25,
      'text-anchor': 'end',
      class: 'fc-frame-badge',
    });
    bText.textContent = shortText(frame.badge, 36);
    fg.append(tText, sText, bText);

    if (frame.toggleKey) {
      const btnG = svgEl('g', {
        transform: `translate(${frame.x + frame.w - 84}, ${frame.y + 10})`,
        class: 'mm-toggle-btn',
      });
      btnG.appendChild(svgEl('rect', { x: 0, y: 0, width: 70, height: 22, rx: 6, class: 'fc-frame-toggle-rect' }));
      const btnLabel = svgEl('text', { x: 35, y: 11, class: 'fc-frame-toggle-text' });
      btnLabel.textContent = frame.collapsed ? '展开本轮' : '收起本轮';
      btnG.appendChild(btnLabel);
      btnG.addEventListener('click', ev => {
        ev.stopPropagation();
        collapseOverride.set(frame.toggleKey!, !frame.collapsed);
        rebuildAndRenderCanvas(false);
      });
      fg.appendChild(btnG);
    }

    fg.addEventListener('click', () => {
      if (currentGraph?.mode === 'overview') {
        selectedSessionId = frame.sessionId;
        switchViewMode('session');
        return;
      }
      if (frame.flowId) {
        selectedFlowId = frame.flowId;
        const foundNode = currentGraph?.nodes.find(n => n.flowId === frame.flowId);
        if (foundNode) {
          selectedNodeId = foundNode.id;
          renderFlowchartCanvas();
          renderInspectorForPayload(foundNode.inspector);
        }
      }
    });

    framesLayerEl.appendChild(fg);
  }

  // 2) Edges (orthogonal rounded arrows + pill labels)
  const nodesById = new Map(currentGraph.nodes.map(n => [n.id, n]));
  for (const edge of currentGraph.edges) {
    const fromN = nodesById.get(edge.fromId);
    const toN = nodesById.get(edge.toId);
    const dim = anyMatch && !fromN?.match && !toN?.match;
    const kindClass = edge.kind === 'loopback'
      ? ' fc-edge-loopback'
      : edge.kind === 'session_bridge'
        ? ' fc-edge-bridge'
        : '';
    const path = svgEl('path', {
      d: pointsToRoundedOrthogonalPath(edge.points, 8),
      class: `fc-edge tone-${edge.tone}${kindClass}${dim ? ' edge-dim' : ''}`,
    });
    edgesLayerEl.appendChild(path);

    if (edge.label && edge.labelX !== undefined && edge.labelY !== undefined) {
      const estW = Math.min(276, Math.max(74, edge.label.length * 10.5 + 22));
      const hPill = 22;
      const lg = svgEl('g', {
        transform: `translate(${edge.labelX - estW / 2}, ${edge.labelY - hPill / 2})`,
        class: `fc-edge-label tone-${edge.tone}${dim ? ' edge-dim' : ''}`,
      });
      lg.appendChild(svgEl('rect', { x: 0, y: 0, width: estW, height: hPill, rx: 11, class: 'fc-edge-label-bg' }));
      const lt = svgEl('text', { x: estW / 2, y: hPill / 2, class: 'fc-edge-label-text' });
      lt.textContent = shortText(edge.label, 28);
      lg.appendChild(lt);
      edgesLayerEl.appendChild(lg);
    }
  }

  // 3) Flowchart Shape Nodes
  for (const n of currentGraph.nodes) {
    const selected = n.id === selectedNodeId;
    const dim = anyMatch && !n.match;
    const g = svgEl('g', {
      transform: `translate(${n.x},${n.y})`,
      class: `mm-node-group cat-${n.category}${selected ? ' node-selected' : ''}${n.match ? ' node-match' : ''}${dim ? ' node-dim' : ''}`,
    });
    renderFlowchartNodeShape(g, n);

    if (n.toggleKey && n.kind !== 'worker_more') {
      const btnW = n.collapsed ? 64 : 52;
      const tg = svgEl('g', {
        transform: `translate(${n.w - btnW - 10}, ${n.h - 11})`,
        class: 'mm-toggle-btn',
      });
      tg.appendChild(svgEl('rect', { x: 0, y: 0, width: btnW, height: 20, rx: 10, class: 'mm-toggle-pill-rect' }));
      const tt = svgEl('text', { x: btnW / 2, y: 10, class: 'mm-toggle-text' });
      tt.textContent = n.collapsed ? `展开 +${n.hiddenCount ?? 0}` : '收起 −';
      tg.appendChild(tt);
      tg.addEventListener('click', ev => {
        ev.stopPropagation();
        collapseOverride.set(n.toggleKey!, !n.collapsed);
        selectedNodeId = n.id;
        renderSidebar();
        rebuildAndRenderCanvas(false);
      });
      g.appendChild(tg);
    }

    g.addEventListener('click', ev => {
      ev.stopPropagation();
      if (n.kind === 'worker_more' && n.toggleKey) {
        collapseOverride.set(n.toggleKey, false);
        rebuildAndRenderCanvas(false);
        return;
      }
      selectedNodeId = n.id;
      if (n.flowId) selectedFlowId = n.flowId;
      if (n.sessionId) selectedSessionId = n.sessionId;
      else {
        const owner = findSessionForFlow(n.flowId, all);
        if (owner) selectedSessionId = owner.id;
      }
      renderSidebar();
      renderFlowchartCanvas();
      renderInspectorForNode(n);
    });

    g.addEventListener('dblclick', ev => {
      ev.stopPropagation();
      if (viewMode === 'overview' && n.sessionId) {
        selectedSessionId = n.sessionId;
        switchViewMode('session');
      }
    });

    nodesLayerEl.appendChild(g);
  }
}

function rebuildAndRenderCanvas(shouldFit: boolean) {
  if (!snapshot) return;
  const { all, filtered, flowsById } = getAllSessions();
  if (!filtered.length) {
    currentGraph = null;
    framesLayerEl.replaceChildren();
    edgesLayerEl.replaceChildren();
    nodesLayerEl.replaceChildren();
    inspectorBodyEl.replaceChildren(domEl('p', 'mm-muted', '暂无匹配的 AI 会话或任务流。'));
    return;
  }

  if (!selectedSessionId || !filtered.some(s => s.id === selectedSessionId)) {
    const owner = selectedFlowId ? findSessionForFlow(selectedFlowId, filtered) : undefined;
    selectedSessionId = owner?.id ?? filtered[0]!.id;
  }

  const activeSession = filtered.find(s => s.id === selectedSessionId) ?? all.find(s => s.id === selectedSessionId) ?? filtered[0]!;
  if (viewMode === 'overview') {
    currentGraph = buildOverviewFlowchart(filtered, flowsById, snapshot, searchTerm);
  } else {
    currentGraph = buildSessionFlowchart(activeSession, flowsById, snapshot, collapseOverride, searchTerm);
  }

  const activeNode = (selectedNodeId && currentGraph.nodes.find(n => n.id === selectedNodeId)) ?? currentGraph.nodes[0];
  if (activeNode) selectedNodeId = activeNode.id;

  renderFlowchartCanvas();
  if (shouldFit) fitWidthTop();
  if (activeNode) renderInspectorForNode(activeNode);
}

function renderListMatrix() {
  const { filtered, flowsById } = getAllSessions();
  matrixSubtitleEl.textContent = `共筛选出 ${filtered.length} 个 AI 会话`;
  matrixGridEl.replaceChildren();
  if (!filtered.length) {
    matrixGridEl.appendChild(domEl('p', 'mm-muted', '暂无匹配的会话。'));
    return;
  }
  for (const session of filtered) {
    const turns = resolveSessionTurns(session, flowsById);
    const card = domEl('article', 'mm-matrix-card');
    const head = domEl('div', 'mm-matrix-card-head');
    const title = domEl('strong', undefined, `${session.turnCount > 1 ? `🗂️ [${session.turnCount}轮会话]` : sourceIcon(turns[0]?.ingress.sourceKind ?? 'local')} ${session.title}`);
    const right = domEl('div', 'mm-insp-actions');
    right.appendChild(domEl('span', `mm-badge st-${session.status}`, `${formatTimeShort(session.startedAt)} · ${statusLabel(session.status)}`));
    const openBtn = domEl('button', 'mm-mini-btn', '🔀 查看完整思考流程图');
    openBtn.type = 'button';
    openBtn.addEventListener('click', () => {
      selectedSessionId = session.id;
      selectedFlowId = turns.at(-1)?.id ?? '';
      switchViewMode('session');
    });
    right.appendChild(openBtn);
    head.append(title, right);

    const stepsGrid = domEl('div', 'mm-matrix-steps');
    const box1 = domEl('div', 'mm-matrix-step-box');
    box1.append(domEl('strong', undefined, `① 对话脉络 (${session.turnCount} 轮)`), domEl('div', undefined, turns.map((t, i) => `R${i + 1}: ${shortText(t.ingress.text, 28)}`).join('\n')));

    const box2 = domEl('div', 'mm-matrix-step-box');
    box2.append(domEl('strong', undefined, '② 记忆联想与沉淀'), domEl('div', undefined, `召回 ${session.recalledMemoryCount} 条记忆 · 沉淀 ${session.consolidatedMemoryCount} 条长期记忆`));

    const firstTask = turns.flatMap(t => t.tasks)[0];
    const box3 = domEl('div', 'mm-matrix-step-box');
    box3.append(domEl('strong', undefined, '③ JEV 选模与质检'), domEl('div', undefined, firstTask?.jevRoute
      ? `${firstTask.jevRoute.response.selectedModel ?? '—'} @ ${firstTask.jevRoute.response.thinkingLevel ?? '—'}${firstTask.jevQualityGates.length ? ` · 质检 ${firstTask.jevQualityGates.at(-1)!.response.score.toFixed(2)}/${firstTask.jevQualityGates.at(-1)!.response.maxScore}` : ''}`
      : (turns[0]?.directPlugin ? `零Token插件 ${turns[0].directPlugin.plugin}` : '主控直接决策回复')));

    const lastTurn = turns.at(-1);
    const box4 = domEl('div', 'mm-matrix-step-box');
    box4.append(domEl('strong', undefined, '④ 最终交付与推送'), domEl('div', undefined, `${lastTurn?.imPush.channelName ?? '控制台'}\n${shortText(lastTurn?.deliveries.at(-1)?.text ?? '—', 48)}`));

    stepsGrid.append(box1, box2, box3, box4);
    card.append(head, stepsGrid);
    matrixGridEl.appendChild(card);
  }
}

/* ==================== 右侧详情检视器 ==================== */

function makeKvSection(title: string, pairs: Array<[string, string | undefined]>, extraClass?: string): HTMLElement {
  const sec = domEl('section', `mm-section${extraClass ? ` ${extraClass}` : ''}`);
  sec.appendChild(domEl('h3', 'mm-section-title', title));
  const grid = domEl('div', 'mm-kv-grid');
  for (const [k, v] of pairs) {
    if (v === undefined || v === '') continue;
    grid.append(domEl('span', 'mm-kv-k', k), domEl('span', 'mm-kv-v', v));
  }
  sec.appendChild(grid);
  return sec;
}

function makeProgressRow(label: string, valueText: string, pct: number, tone?: 'ok' | 'warn'): HTMLElement {
  const row = domEl('div', 'mm-progress-row');
  const head = domEl('div', 'mm-progress-label');
  head.append(domEl('span', undefined, label), domEl('strong', undefined, valueText));
  const bar = document.createElement('progress');
  bar.className = `mm-progress${tone ? ` ${tone}` : ''}`;
  bar.max = 100;
  bar.value = Math.max(0, Math.min(100, Math.round(pct)));
  row.append(head, bar);
  return row;
}

function appendJevRouteSections(container: HTMLElement, jr: MindmapJevRouteInfo) {
  container.appendChild(makeKvSection('📤 怎么调用的 JEV（选模定级请求入参）', [
    ['调用接口', `POST ${jr.request.endpoint}`],
    ['决策模型', jr.request.decisionModel],
    ['调用时间', formatTimeShort(jr.at)],
    ['任务画像', jr.request.profile],
    ['候选池规模', jr.request.candidateCount !== undefined ? `${jr.request.candidateCount} 个候选条目` : '全量配置池'],
    ['包含图片', jr.request.hasImages ? '是 (需视觉能力过滤)' : '否'],
    ['文件数量', String(jr.request.fileCount)],
    ['定时触发', jr.request.isTimer ? '是' : '否'],
    ['偏好档位', jr.request.preferredTier],
    ['熔断排除模型', jr.request.excludedSpecs?.join(', ')],
    ['熔断排除提供方', jr.request.excludedProviders?.join(', ')],
    ['任务指令摘要', jr.request.instructionPreview],
  ], 'sec-jev'));

  const resSec = domEl('section', 'mm-section sec-jev');
  resSec.appendChild(domEl('h3', 'mm-section-title', '📥 JEV 的响应结果（选模与门禁预判）'));
  const grid = domEl('div', 'mm-kv-grid');
  const rows: Array<[string, string | undefined]> = [
    ['决策来源', jr.source === 'gemini-decision-1' ? 'gemini-decision-1 (远端决策)' : jr.source === 'heuristic' ? 'heuristic (本地规则回退)' : '静态模型档位配置'],
    ['选中模型', jr.response.selectedModel ?? '—'],
    ['思考深度', jr.response.thinkingLevel ?? '—'],
    ['所属档位', jr.response.modelTier],
    ['质检开关建议', jr.response.needsQualityGate === undefined ? '默认开启' : jr.response.needsQualityGate ? '需要 JEV 质检门禁' : '简单任务，可免检直通'],
    ['Token 消耗', jr.response.usage ? `输入 ${jr.response.usage.inputTokens} / 总计 ${jr.response.usage.totalTokens}` : undefined],
    ['回退原因', jr.response.fallbackReason],
  ];
  for (const [k, v] of rows) {
    if (!v) continue;
    grid.append(domEl('span', 'mm-kv-k', k), domEl('span', 'mm-kv-v', v));
  }
  resSec.appendChild(grid);
  if (jr.response.confidence !== undefined) {
    resSec.appendChild(makeProgressRow('决策置信度 (confidence)', `${(jr.response.confidence * 100).toFixed(1)}%`, jr.response.confidence * 100));
  }
  if (jr.response.needsQualityGateProb !== undefined) {
    resSec.appendChild(makeProgressRow('需要质检概率 (needsQualityGateProb)', `${(jr.response.needsQualityGateProb * 100).toFixed(1)}%`, jr.response.needsQualityGateProb * 100, jr.response.needsQualityGate ? 'warn' : 'ok'));
  }
  container.appendChild(resSec);
}

function appendJevQualitySections(container: HTMLElement, qg: MindmapJevQualityGateItem) {
  container.appendChild(makeKvSection(`📤 第 ${qg.index} 次 JEV 质检调用入参`, [
    ['调用接口', `POST ${qg.request.endpoint}`],
    ['决策模型', qg.request.decisionModel],
    ['评估时间', formatTimeShort(qg.at)],
    ['任务画像', qg.request.profile],
    ['成功工具数', String(qg.request.succeededOps)],
    ['失败/未知工具', String(qg.request.failedOps)],
    ['盘中补充轮数', String(qg.request.followupCount)],
    ['Worker 报告字数', `${qg.request.reportLength} 字`],
    ['免检直通标志', qg.request.skipRemote ? '是 (skipRemote)' : '否'],
  ], 'sec-quality'));

  const resSec = domEl('section', 'mm-section sec-quality');
  resSec.appendChild(domEl('h3', 'mm-section-title', `📥 第 ${qg.index} 次 JEV 质检响应`));
  const grid = domEl('div', 'mm-kv-grid');
  const pairs: Array<[string, string | undefined]> = [
    ['评估来源', qg.source],
    ['完成度评分', `${qg.response.score.toFixed(2)} / ${qg.response.maxScore}`],
    ['是否建议补充', qg.response.skippedByRoute ? '已由选模免检直通' : qg.response.shouldSupplement ? '⚠️ 建议打回/补充调研 (shouldSupplement=true)' : '✅ 完成度达标 (shouldSupplement=false)'],
    ['缺失维度', qg.response.missingAspect],
    ['Token 消耗', qg.response.usage ? `输入 ${qg.response.usage.inputTokens} / 总计 ${qg.response.usage.totalTokens}` : undefined],
    ['回退原因', qg.response.fallbackReason],
  ];
  for (const [k, v] of pairs) {
    if (!v) continue;
    grid.append(domEl('span', 'mm-kv-k', k), domEl('span', 'mm-kv-v', v));
  }
  resSec.appendChild(grid);
  resSec.appendChild(makeProgressRow('完成度得分', `${qg.response.score.toFixed(2)} / ${qg.response.maxScore}`, (qg.response.score / Math.max(1, qg.response.maxScore)) * 100, qg.response.shouldSupplement ? 'warn' : 'ok'));
  resSec.appendChild(makeProgressRow('建议补充概率 (supplementProbability)', `${(qg.response.supplementProbability * 100).toFixed(1)}%`, qg.response.supplementProbability * 100, qg.response.shouldSupplement ? 'warn' : 'ok'));
  resSec.appendChild(makeProgressRow('评估置信度 (confidence)', `${(qg.response.confidence * 100).toFixed(1)}%`, qg.response.confidence * 100));
  container.appendChild(resSec);
}

function appendIngressSection(container: HTMLElement, flow: MindmapTaskFlow) {
  const sec = domEl('section', 'mm-section');
  sec.appendChild(domEl('h3', 'mm-section-title', '① 接入渠道与老板原始消息'));
  const grid = domEl('div', 'mm-kv-grid');
  const pairs: Array<[string, string | undefined]> = [
    ['来源渠道', flow.ingress.channelLabel],
    ['渠道类型', flow.ingress.sourceKind],
    ['发送者 ID', flow.ingress.origin?.senderId],
    ['通道会话 ID', flow.ingress.origin?.conversationId],
    ['原生会话 ID', flow.sessionId],
    ['归属时机', flow.sessionPersisted ? '⚡ 接收执行期实时落库 (messages/tasks)' : '🗂️ 读取时动态聚合'],
    ['归并原因', flow.sessionLink ? `${flow.sessionLink.label}${flow.sessionLink.detail ? `（${flow.sessionLink.detail}）` : ''}` : '会话首轮消息（新开会话）'],
    ['JEV 判定置信度', flow.sessionLink?.confidence !== undefined ? `${Math.round(flow.sessionLink.confidence * 100)}% (${flow.sessionLink.source})` : undefined],
    ['JEV 会话 Token', flow.sessionLink?.usage ? `输入 ${flow.sessionLink.usage.inputTokens} / 总计 ${flow.sessionLink.usage.totalTokens}` : undefined],
    ['时间', formatTimeShort(flow.createdAt)],
    ['消息序号', flow.seq ? `#${flow.seq}` : '独立任务'],
    ['授权本地路径', flow.ingress.paths.length ? flow.ingress.paths.join('\n') : undefined],
  ];
  for (const [k, v] of pairs) {
    if (!v) continue;
    grid.append(domEl('span', 'mm-kv-k', k), domEl('span', 'mm-kv-v', v));
  }
  sec.appendChild(grid);

  if (flow.ingress.attachments.length) {
    const list = domEl('div', 'mm-card-list');
    for (const att of flow.ingress.attachments) {
      const c = domEl('div', 'mm-sub-card');
      c.appendChild(domEl('div', 'mm-sub-card-head', `📎 [${att.kind}] ${att.name} (${att.status})`));
      if (att.path || att.error) c.appendChild(domEl('div', 'mm-muted', att.path ?? att.error ?? ''));
      list.appendChild(c);
    }
    sec.appendChild(list);
  }

  const pre = domEl('pre', 'mm-pre', flow.ingress.text);
  sec.appendChild(pre);

  if (flow.ingress.textTruncated && flow.ingress.messageId) {
    const loadFullBtn = domEl('button', 'mm-mini-btn', '查看未截断原始消息全文');
    loadFullBtn.type = 'button';
    loadFullBtn.addEventListener('click', async () => {
      loadFullBtn.disabled = true;
      loadFullBtn.textContent = '正在加载全文…';
      try {
        const full = await apiGet<{ text: string }>(`/api/message?messageId=${encodeURIComponent(flow.ingress.messageId!)}`);
        pre.textContent = full.text;
        loadFullBtn.remove();
      } catch {
        loadFullBtn.textContent = '加载失败';
      }
    });
    sec.appendChild(loadFullBtn);
  }
  container.appendChild(sec);
}

function appendMemorySection(container: HTMLElement, flow: MindmapTaskFlow, focusItem?: MindmapRecalledItem) {
  const sec = domEl('section', 'mm-section');
  sec.appendChild(domEl('h3', 'mm-section-title', `② 记忆加载与联想闪回 (${flow.memoryRecall.recalledItems.length} 条)`));
  const items = focusItem ? [focusItem] : flow.memoryRecall.recalledItems;
  if (!items.length) {
    sec.appendChild(domEl('p', 'mm-muted', '该回合未命中额外潜意识闪回记忆，基于当前连续窗口与 L0 元记忆目录运行。'));
  } else {
    const list = domEl('div', 'mm-card-list');
    for (const hit of items) {
      const card = domEl('div', 'mm-sub-card');
      const head = domEl('div', 'mm-sub-card-head');
      head.append(domEl('span', undefined, hit.title), domEl('span', 'mm-badge', `分数 ${hit.score}`));
      card.appendChild(head);
      if (hit.activatedVia) {
        card.appendChild(domEl('p', 'mm-muted', `⚡ 赫布突触扩散激活：经「${hit.activatedVia.topic}」(权重 ${hit.activatedVia.weight}, 关系 ${hit.activatedVia.relation})`));
      }
      if (hit.tags?.length) {
        card.appendChild(domEl('p', 'mm-muted', `标签: ${hit.tags.join(', ')}`));
      }
      card.appendChild(domEl('pre', 'mm-pre', hit.snippet));
      list.appendChild(card);
    }
    sec.appendChild(list);
  }
  container.appendChild(sec);
}

function appendWorkerStepSection(container: HTMLElement, task: MindmapTaskDetail, step: MindmapWorkerStep) {
  const sec = domEl('section', 'mm-section');
  sec.appendChild(domEl('h3', 'mm-section-title', `⑤ Worker 步骤明细 · ${step.title}`));
  const pairs: Array<[string, string | undefined]> = [
    ['步骤类型', step.kind],
    ['工具名称', step.toolName],
    ['状态', statusLabel(step.status)],
    ['开始时间', formatTimeShort(step.at)],
    ['耗时', step.durationMs ? formatDuration(step.durationMs) : undefined],
    ['停止原因', step.stopReason],
    ['Token 消耗', step.usage ? `输入 ${step.usage.input} / 缓存读取 ${step.usage.cacheRead} / 推理 ${step.usage.reasoning} / 输出 ${step.usage.output} (总 ${step.usage.totalTokens})` : undefined],
  ];
  const grid = domEl('div', 'mm-kv-grid');
  for (const [k, v] of pairs) {
    if (!v) continue;
    grid.append(domEl('span', 'mm-kv-k', k), domEl('span', 'mm-kv-v', v));
  }
  sec.appendChild(grid);

  if (step.inputPreview) {
    sec.appendChild(domEl('strong', 'mm-kv-k', '调用入参 / 命令：'));
    sec.appendChild(domEl('pre', 'mm-pre', step.inputPreview));
  }
  const outPre = domEl('pre', 'mm-pre', step.outputPreview ?? '（无文本输出）');
  if (step.outputPreview) {
    sec.appendChild(domEl('strong', 'mm-kv-k', '执行结果输出：'));
    sec.appendChild(outPre);
  }
  if (step.operationId && step.hasFullOperation) {
    const btn = domEl('button', 'mm-mini-btn', '从后台拉取完整工具原始输出');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '拉取中…';
      try {
        const op = await apiGet<{ result?: string; error?: string }>(`/api/operation?taskId=${encodeURIComponent(task.id)}&operationId=${encodeURIComponent(step.operationId!)}`);
        outPre.textContent = op.result ?? op.error ?? '（空）';
        if (!step.outputPreview) sec.appendChild(outPre);
        btn.remove();
      } catch {
        btn.textContent = '拉取失败';
      }
    });
    sec.appendChild(btn);
  }
  container.appendChild(sec);
}

function appendDeliverySection(container: HTMLElement, flow: MindmapTaskFlow, focusDelivery?: MindmapDeliveryItem) {
  const pushSec = makeKvSection('⑧ IM 渠道精确推送结果 (Exact-Origin)', [
    ['目标渠道', flow.imPush.channelName],
    ['渠道平台', flow.imPush.channel],
    ['目标会话/用户', flow.imPush.target ?? '本机控制台实时流'],
    ['投递状态', flow.imPush.delivered ? `✅ 已推送 (${flow.imPush.deliveryCount} 条回复)` : '⏳ 未推送或等待完成'],
    ['发送文件附件', flow.imPush.sentFiles.length ? flow.imPush.sentFiles.map(f => `${f.name} → ${f.target ?? ''}`).join('\n') : undefined],
  ]);
  container.appendChild(pushSec);

  const dels = focusDelivery ? [focusDelivery] : flow.deliveries;
  if (dels.length) {
    const repSec = domEl('section', 'mm-section');
    repSec.appendChild(domEl('h3', 'mm-section-title', `公开回复正文 (${dels.length} 条)`));
    for (const del of dels) {
      const card = domEl('div', 'mm-sub-card');
      const head = domEl('div', 'mm-sub-card-head');
      head.append(domEl('span', undefined, `${del.roleLabel} · #${del.seq}`), domEl('span', 'mm-badge', `${formatTimeShort(del.at)} · ${statusLabel(del.status)}`));
      card.appendChild(head);
      const pre = domEl('pre', 'mm-pre', del.text || del.reason || '（空）');
      card.appendChild(pre);
      if (del.textTruncated) {
        const btn = domEl('button', 'mm-mini-btn', '查看完整回复正文');
        btn.type = 'button';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const full = await apiGet<{ text: string }>(`/api/message?messageId=${encodeURIComponent(del.messageId)}`);
            pre.textContent = full.text;
            btn.remove();
          } catch { btn.textContent = '加载失败'; }
        });
        card.appendChild(btn);
      }
      repSec.appendChild(card);
    }
    container.appendChild(repSec);
  }
}

function appendTaskOverviewSection(container: HTMLElement, task: MindmapTaskDetail) {
  const sec = makeKvSection(`🤖 Worker 任务概要 · ${task.id.slice(0, 8)}`, [
    ['任务状态', statusLabel(task.status)],
    ['任务画像', task.profile ?? 'general'],
    ['执行模式', task.execution ?? 'native'],
    ['工作目录', task.cwd],
    ['活跃用时 / 上限', `${formatDuration(task.activeMs)} / ${formatDuration(task.limitMs)}`],
    ['编译上下文', task.contextBrief],
    ['状态说明', task.reason],
  ]);
  sec.appendChild(domEl('strong', 'mm-kv-k', '下发给 Worker 的任务指令：'));
  sec.appendChild(domEl('pre', 'mm-pre', task.prompt));
  if (task.reportPreview) {
    sec.appendChild(domEl('strong', 'mm-kv-k', 'Worker 提交的成果报告：'));
    const repPre = domEl('pre', 'mm-pre', task.reportPreview);
    sec.appendChild(repPre);
    if (task.reportTruncated) {
      const btn = domEl('button', 'mm-mini-btn', '查看未截断 Worker 完整报告');
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const full = await apiGet<{ report?: string }>(`/api/work?taskId=${encodeURIComponent(task.id)}`);
          if (full.report) repPre.textContent = full.report;
          btn.remove();
        } catch { btn.textContent = '加载失败'; }
      });
      sec.appendChild(btn);
    }
  }
  container.appendChild(sec);
}

function appendSessionTimelineSection(container: HTMLElement, session: MindmapSession, activeFlowId?: string) {
  const sec = domEl('section', 'mm-section');
  sec.appendChild(domEl('h3', 'mm-section-title', `🗂️ AI 会话上下文脉络 (${session.turnCount} 轮)`));
  const list = domEl('div', 'mm-card-list');
  session.turnSummaries.forEach((ts, idx) => {
    const btn = domEl('button', `mm-session-turn-card${ts.flowId === activeFlowId ? ' active' : ''}`);
    btn.type = 'button';
    if (ts.link) {
      const linkText = ts.link.source === 'gemini-decision-1'
        ? `${ts.link.label} [gemini-decision-1]`
        : ts.link.label;
      btn.appendChild(domEl('span', 'mm-turn-link-chip', linkText));
    }
    const head = domEl('div', 'mm-sub-card-head');
    head.append(
      domEl('span', undefined, `第 ${idx + 1} 轮 · ${sourceIcon(ts.sourceKind)} #${ts.seq || '独立'}`),
      domEl('span', `mm-badge st-${ts.status}`, formatTimeShort(ts.at)),
    );
    const body = domEl('div', 'mm-muted', ts.textPreview);
    btn.append(head, body);
    btn.addEventListener('click', () => {
      selectedSessionId = session.id;
      selectedFlowId = ts.flowId;
      if (viewMode !== 'session') switchViewMode('session');
      scrollToFrame(`frame:${ts.flowId}`);
    });
    list.appendChild(btn);
  });
  sec.appendChild(list);
  container.appendChild(sec);
}

function appendWorkerPhaseSection(container: HTMLElement, task: MindmapTaskDetail, phase: MindmapWorkerPhase) {
  const sec = domEl('section', 'mm-section');
  sec.appendChild(domEl('h3', 'mm-section-title', `⚙️ Worker 执行阶段 #${phase.index}${phase.isFollowup ? ' (打回补充)' : ''}`));
  const grid = domEl('div', 'mm-kv-grid');
  const pairs: Array<[string, string | undefined]> = [
    ['阶段状态', statusLabel(phase.status)],
    ['开始时间', formatTimeShort(phase.startedAt)],
    ['阶段耗时', phase.durationMs ? formatDuration(phase.durationMs) : undefined],
    ['本阶段推理', `${phase.llmCount} 轮`],
    ['本阶段工具', `${phase.toolCount} 次`],
  ];
  for (const [k, v] of pairs) {
    if (!v) continue;
    grid.append(domEl('span', 'mm-kv-k', k), domEl('span', 'mm-kv-v', v));
  }
  sec.appendChild(grid);
  if (phase.followupPrompt) {
    sec.appendChild(domEl('strong', 'mm-kv-k', '本阶段补充指令：'));
    sec.appendChild(domEl('pre', 'mm-pre', phase.followupPrompt));
  }
  const steps = task.workerSteps.filter(s => s.phaseIndex === phase.index && s.kind !== 'followup');
  if (steps.length) {
    const list = domEl('div', 'mm-card-list');
    for (const st of steps) {
      const card = domEl('div', 'mm-sub-card');
      card.appendChild(domEl('div', 'mm-sub-card-head', `${st.title} (${formatDuration(st.durationMs)})`));
      if (st.inputPreview) card.appendChild(domEl('pre', 'mm-pre', st.inputPreview));
      if (st.outputPreview) card.appendChild(domEl('pre', 'mm-pre', st.outputPreview));
      list.appendChild(card);
    }
    sec.appendChild(list);
  }
  container.appendChild(sec);
}

function renderInspectorForPayload(payload: InspectorPayload, headerInfo?: { icon: string; badge: string; title: string; subtitle: string; status?: string; metric?: string; kind?: string }) {
  const synth: FlowchartNode = {
    id: payload.flow?.id ?? payload.session?.id ?? 'summary',
    flowId: payload.flow?.id ?? '',
    sessionId: payload.session?.id,
    kind: (headerInfo?.kind as FlowchartNode['kind']) ?? 'flow_root',
    category: 'core',
    shape: 'process',
    icon: headerInfo?.icon ?? (payload.flow ? sourceIcon(payload.flow.ingress.sourceKind) : '🗂️'),
    badge: headerInfo?.badge ?? (payload.session ? `会话 · ${payload.session.turnCount} 轮` : '节点详情'),
    title: headerInfo?.title ?? payload.session?.title ?? payload.flow?.ingress.text ?? '详情',
    subtitle: headerInfo?.subtitle ?? (payload.flow ? formatTimeShort(payload.flow.createdAt) : ''),
    status: headerInfo?.status ?? payload.flow?.status,
    metric: headerInfo?.metric,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    searchText: '',
    inspector: payload,
  };
  renderInspectorForNode(synth);
}

function renderInspectorForNode(node: FlowchartNode) {
  inspectorBodyEl.replaceChildren();
  const payload = node.inspector;
  const flow = payload.flow;
  const session = payload.session;

  const header = domEl('div', 'mm-insp-header');
  const badges = domEl('div', 'mm-insp-badges');
  badges.appendChild(domEl('span', 'mm-badge', `${node.icon} ${node.badge}`));
  if (node.status) badges.appendChild(domEl('span', `mm-badge st-${node.status}`, statusLabel(node.status)));
  if (node.metric) badges.appendChild(domEl('span', 'mm-badge', node.metric));
  header.appendChild(badges);
  header.appendChild(domEl('h2', 'mm-insp-title', node.title));
  header.appendChild(domEl('p', 'mm-insp-sub', node.subtitle));

  if (session) {
    const actions = domEl('div', 'mm-insp-actions');
    if (viewMode !== 'session') {
      const focusBtn = domEl('button', 'mm-mini-btn', '🔀 进入完整会话思考流程图');
      focusBtn.type = 'button';
      focusBtn.addEventListener('click', () => {
        selectedSessionId = session.id;
        switchViewMode('session');
      });
      actions.appendChild(focusBtn);
    } else {
      const backOverviewBtn = domEl('button', 'mm-mini-btn', '🗺️ 返回全局会话脉络图');
      backOverviewBtn.type = 'button';
      backOverviewBtn.addEventListener('click', () => switchViewMode('overview'));
      actions.appendChild(backOverviewBtn);
    }
    header.appendChild(actions);
  }
  inspectorBodyEl.appendChild(header);

  if (session && (session.turnCount > 1 || node.kind === 'session_summary' || node.kind === 'flow_root')) {
    appendSessionTimelineSection(inspectorBodyEl, session, flow?.id);
  }

  if (!flow) {
    if (payload.snapshot) {
      inspectorBodyEl.appendChild(makeKvSection('🌐 系统运行全貌', [
        ['已聚合会话数', `${payload.snapshot.summary.totalSessions ?? 0} 个 (多轮 ${payload.snapshot.summary.multiTurnSessions ?? 0})`],
        ['已加载原始消息', `${payload.snapshot.summary.loadedFlows} / ${payload.snapshot.summary.totalFlows}`],
        ['微信任务流', String(payload.snapshot.summary.wechatFlows)],
        ['本地控制台流', String(payload.snapshot.summary.localFlows)],
        ['定时触发流', String(payload.snapshot.summary.timerFlows)],
        ['后台 Worker 任务总数', String(payload.snapshot.summary.totalTasks)],
        ['JEV 决策引擎调用次数', String(payload.snapshot.summary.jevCalls)],
        ['主控模型', `${payload.snapshot.summary.routerProvider}/${payload.snapshot.summary.routerModel}`],
        ['决策模型', `${payload.snapshot.summary.decisionModel} (${payload.snapshot.summary.decisionConfigured ? '已配置密钥 ✓' : '回退启发式'})`],
      ]));
    }
    return;
  }

  switch (node.kind) {
    case 'ingress':
      appendIngressSection(inspectorBodyEl, flow);
      break;
    case 'memory_group':
    case 'memory_item':
      appendMemorySection(inspectorBodyEl, flow, payload.memoryItem);
      break;
    case 'router_turn':
    case 'router_tool': {
      const rt = payload.routerTurn;
      if (rt) {
        inspectorBodyEl.appendChild(makeKvSection('🎛️ Router 主控推理轮次', [
          ['触发类型', rt.triggerKind],
          ['状态', statusLabel(rt.status)],
          ['开始时间', formatTimeShort(rt.startedAt)],
          ['总耗时', rt.durationMs ? formatDuration(rt.durationMs) : undefined],
          ['模型思考轮数', `${rt.llmTurns} 轮`],
          ['Token 用量', rt.usage ? `输入 ${rt.usage.input} / 缓存 ${rt.usage.cacheRead} / 推理 ${rt.usage.reasoning} / 输出 ${rt.usage.output}` : undefined],
        ]));
        if (payload.routerTool) {
          const tl = payload.routerTool;
          const tSec = makeKvSection(`🧭 工具调用 · ${tl.toolName}`, [
            ['工具名', tl.toolName],
            ['状态', statusLabel(tl.status)],
            ['调用时间', formatTimeShort(tl.at)],
            ['耗时', tl.durationMs ? formatDuration(tl.durationMs) : undefined],
          ]);
          if (tl.inputPreview) { tSec.appendChild(domEl('strong', 'mm-kv-k', '调用入参：')); tSec.appendChild(domEl('pre', 'mm-pre', tl.inputPreview)); }
          if (tl.outputPreview) { tSec.appendChild(domEl('strong', 'mm-kv-k', '工具返回：')); tSec.appendChild(domEl('pre', 'mm-pre', tl.outputPreview)); }
          inspectorBodyEl.appendChild(tSec);
        } else if (rt.tools.length) {
          const sec = domEl('section', 'mm-section');
          sec.appendChild(domEl('h3', 'mm-section-title', `本轮调用的 Router 工具 (${rt.tools.length})`));
          for (const tl of rt.tools) {
            const c = domEl('div', 'mm-sub-card');
            c.appendChild(domEl('div', 'mm-sub-card-head', `${tl.toolName} (${statusLabel(tl.status)})`));
            if (tl.inputPreview) c.appendChild(domEl('pre', 'mm-pre', tl.inputPreview));
            if (tl.outputPreview) c.appendChild(domEl('pre', 'mm-pre', tl.outputPreview));
            sec.appendChild(c);
          }
          inspectorBodyEl.appendChild(sec);
        }
      }
      break;
    }
    case 'direct_plugin':
      inspectorBodyEl.appendChild(makeKvSection('🔌 零 Token 定时插件直跑', [
        ['定时器名称', flow.directPlugin?.timerName],
        ['插件', flow.directPlugin?.plugin],
        ['执行动作', flow.directPlugin?.pluginAction],
        ['执行模式', 'Node 子脚本直跑 (0 LLM Token 消耗)'],
      ]));
      appendDeliverySection(inspectorBodyEl, flow);
      break;
    case 'jev_route':
    case 'jev_route_req':
    case 'jev_route_res':
      if (payload.jevRoute) appendJevRouteSections(inspectorBodyEl, payload.jevRoute);
      break;
    case 'jev_quality':
    case 'jev_quality_req':
    case 'jev_quality_res':
      if (payload.jevQuality) appendJevQualitySections(inspectorBodyEl, payload.jevQuality);
      break;
    case 'worker_phase':
      if (payload.task && payload.phase) appendWorkerPhaseSection(inspectorBodyEl, payload.task, payload.phase);
      if (payload.task) appendTaskOverviewSection(inspectorBodyEl, payload.task);
      break;
    case 'worker_step':
      if (payload.task && payload.workerStep) appendWorkerStepSection(inspectorBodyEl, payload.task, payload.workerStep);
      break;
    case 'task_root':
    case 'worker_exec':
      if (payload.task) {
        appendTaskOverviewSection(inspectorBodyEl, payload.task);
        if (payload.task.jevRoute) appendJevRouteSections(inspectorBodyEl, payload.task.jevRoute);
        for (const qg of payload.task.jevQualityGates) appendJevQualitySections(inspectorBodyEl, qg);
      }
      break;
    case 'memory_consolidate': {
      const mems = payload.consolidatedMemory ? [payload.consolidatedMemory] : flow.consolidatedMemories;
      const sec = domEl('section', 'mm-section');
      sec.appendChild(domEl('h3', 'mm-section-title', `🧬 记忆沉淀详情 (${mems.length} 张)`));
      for (const m of mems) {
        const card = domEl('div', 'mm-sub-card');
        card.appendChild(domEl('div', 'mm-sub-card-head', `${m.pinned ? '📌 ' : ''}${m.topic} (${m.synapseCount} 突触)`));
        card.appendChild(domEl('p', 'mm-muted', `标签: ${m.tags.join(', ')} · ${formatTimeShort(m.createdAt)}`));
        card.appendChild(domEl('pre', 'mm-pre', m.contentPreview));
        sec.appendChild(card);
      }
      inspectorBodyEl.appendChild(sec);
      break;
    }
    case 'im_delivery':
    case 'reply_item':
      appendDeliverySection(inspectorBodyEl, flow, payload.delivery);
      break;
    default: {
      appendIngressSection(inspectorBodyEl, flow);
      if (flow.memoryRecall.recalledItems.length) appendMemorySection(inspectorBodyEl, flow);
      for (const task of flow.tasks) {
        appendTaskOverviewSection(inspectorBodyEl, task);
        if (task.jevRoute) appendJevRouteSections(inspectorBodyEl, task.jevRoute);
        for (const qg of task.jevQualityGates) appendJevQualitySections(inspectorBodyEl, qg);
      }
      appendDeliverySection(inspectorBodyEl, flow);
      break;
    }
  }
}

function switchViewMode(next: ViewMode) {
  viewMode = next;
  viewSessionBtn.classList.toggle('active', next === 'session');
  viewOverviewBtn.classList.toggle('active', next === 'overview');
  viewListBtn.classList.toggle('active', next === 'list');
  viewSessionBtn.setAttribute('aria-selected', String(next === 'session'));
  viewOverviewBtn.setAttribute('aria-selected', String(next === 'overview'));
  viewListBtn.setAttribute('aria-selected', String(next === 'list'));

  canvasPanelEl.hidden = next === 'list';
  listPanelEl.hidden = next !== 'list';
  canvasControlsEl.hidden = next === 'list';

  if (next === 'list') {
    renderListMatrix();
    const { filtered, flowsById } = getAllSessions();
    const activeSession = filtered.find(s => s.id === selectedSessionId) ?? filtered[0];
    if (activeSession) {
      const turns = resolveSessionTurns(activeSession, flowsById);
      renderInspectorForPayload({ flow: turns.at(-1) ?? null, snapshot: snapshot ?? undefined, session: activeSession });
    }
  } else {
    selectedNodeId = '';
    rebuildAndRenderCanvas(true);
  }
}

async function refreshMindmap(fitOnFirst = false) {
  try {
    setConnState('loading', '同步中…');
    const data = await apiGet<MindmapSnapshot>('/api/mindmap?limit=120');
    authBannerEl.hidden = true;
    snapshot = data;
    loadedFlows = data.flows;
    const sessCount = data.summary.totalSessions ?? getEffectiveSessions(data, data.flows).length;
    setConnState('live', `已连接实时库 (${sessCount} 会话 · ${data.summary.totalFlows} 句)`);
    renderKpis();
    renderSidebar();
    if (viewMode === 'list') renderListMatrix();
    else rebuildAndRenderCanvas(fitOnFirst);
    ensureSseConnected(data.cursor);
  } catch (err) {
    if ((err as Error).message !== 'Unauthorized') {
      setConnState('error', '读取失败');
    }
  }
}

async function loadMoreFlows() {
  if (!snapshot?.hasMore || !snapshot.beforeSeq) return;
  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = '加载中…';
  try {
    const older = await apiGet<MindmapSnapshot>(`/api/mindmap?limit=100&before=${snapshot.beforeSeq}`);
    const seen = new Set(loadedFlows.map(f => f.id));
    for (const f of older.flows) {
      if (!seen.has(f.id)) loadedFlows.push(f);
    }
    snapshot = {
      ...snapshot,
      hasMore: older.hasMore,
      beforeSeq: older.beforeSeq,
    };
    renderSidebar();
    if (viewMode === 'list') renderListMatrix();
    else rebuildAndRenderCanvas(false);
  } finally {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = '加载更早的历史会话消息…';
  }
}

function ensureSseConnected(initialCursor: number) {
  sseCursor = Math.max(sseCursor, initialCursor);
  if (sseAbort || !accessToken) return;
  const startStream = async () => {
    const controller = new AbortController();
    sseAbort = controller;
    try {
      const response = await fetch(`/api/stream?after=${sseCursor}`, {
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${accessToken}`,
          Accept: 'text/event-stream',
        },
      });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = 'message';
      let dataLines: string[] = [];
      const dispatch = () => {
        const raw = dataLines.join('\n');
        dataLines = [];
        const kind = eventName;
        eventName = 'message';
        if (kind === 'updates' && raw) {
          try {
            const batch = JSON.parse(raw) as { cursor?: number };
            if (typeof batch.cursor === 'number') sseCursor = Math.max(sseCursor, batch.cursor);
          } catch { /* ignore */ }
          if (refreshTimer) clearTimeout(refreshTimer);
          refreshTimer = window.setTimeout(() => { void refreshMindmap(false); }, 450);
        }
      };
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);
            if (!line) dispatch();
            else if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    } catch {
      if (sseAbort === controller) sseAbort = null;
      if (!controller.signal.aborted && accessToken) {
        window.setTimeout(() => ensureSseConnected(sseCursor), 3000);
      }
    }
  };
  void startStream();
}

/* ==================== 交互事件绑定 ==================== */

if (accessToken) {
  backLinkEl.href = `/#token=${encodeURIComponent(accessToken)}`;
}

toggleSidebarBtn.addEventListener('click', () => {
  workspaceEl.classList.toggle('sidebar-collapsed');
  window.setTimeout(() => { if (viewMode !== 'list') fitWidthTop(); }, 80);
});

sidebarModeSessionsBtn.addEventListener('click', () => {
  sidebarMode = 'sessions';
  sidebarModeSessionsBtn.classList.add('active');
  sidebarModeTurnsBtn.classList.remove('active');
  renderSidebar();
});

sidebarModeTurnsBtn.addEventListener('click', () => {
  sidebarMode = 'turns';
  sidebarModeTurnsBtn.classList.add('active');
  sidebarModeSessionsBtn.classList.remove('active');
  renderSidebar();
});

viewSessionBtn.addEventListener('click', () => switchViewMode('session'));
viewOverviewBtn.addEventListener('click', () => switchViewMode('overview'));
viewListBtn.addEventListener('click', () => switchViewMode('list'));

filterPillsEl.addEventListener('click', ev => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-filter]');
  if (!btn) return;
  filterKind = (btn.dataset.filter as FilterKind) ?? 'all';
  for (const elBtn of filterPillsEl.querySelectorAll<HTMLButtonElement>('button[data-filter]')) {
    elBtn.classList.toggle('active', elBtn === btn);
  }
  renderSidebar();
  if (viewMode === 'list') renderListMatrix();
  else rebuildAndRenderCanvas(true);
});

searchInput.addEventListener('input', () => {
  searchTerm = searchInput.value.trim();
  searchClearBtn.hidden = !searchTerm;
  renderSidebar();
  if (viewMode === 'list') renderListMatrix();
  else rebuildAndRenderCanvas(false);
});

searchClearBtn.addEventListener('click', () => {
  searchInput.value = '';
  searchTerm = '';
  searchClearBtn.hidden = true;
  renderSidebar();
  if (viewMode === 'list') renderListMatrix();
  else rebuildAndRenderCanvas(true);
});

expandAllBtn.addEventListener('click', () => {
  if (!currentGraph) return;
  for (const frame of currentGraph.frames) {
    if (frame.toggleKey) collapseOverride.set(frame.toggleKey, false);
  }
  for (const node of currentGraph.nodes) {
    if (node.toggleKey) collapseOverride.set(node.toggleKey, false);
  }
  rebuildAndRenderCanvas(false);
});

collapseAllBtn.addEventListener('click', () => {
  if (!currentGraph) return;
  for (const node of currentGraph.nodes) {
    if (node.toggleKey && node.kind !== 'worker_more') collapseOverride.set(node.toggleKey, true);
  }
  rebuildAndRenderCanvas(true);
});

zoomOutBtn.addEventListener('click', () => { zoom = Math.max(0.25, zoom * 0.85); applyViewportTransform(); });
zoomInBtn.addEventListener('click', () => { zoom = Math.min(2.2, zoom * 1.18); applyViewportTransform(); });
fitWidthBtn.addEventListener('click', fitWidthTop);
fitBtn.addEventListener('click', fitToCanvas);
refreshBtn.addEventListener('click', () => { void refreshMindmap(false); });
loadMoreBtn.addEventListener('click', () => { void loadMoreFlows(); });

svgElRoot.addEventListener('mousedown', ev => {
  if (ev.button !== 0) return;
  isDragging = true;
  dragMoved = false;
  dragStartX = ev.clientX;
  dragStartY = ev.clientY;
  dragPanStartX = panX;
  dragPanStartY = panY;
});

window.addEventListener('mousemove', ev => {
  if (!isDragging) return;
  const dx = ev.clientX - dragStartX;
  const dy = ev.clientY - dragStartY;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
  panX = dragPanStartX + dx;
  panY = dragPanStartY + dy;
  applyViewportTransform();
});

window.addEventListener('mouseup', () => {
  isDragging = false;
});

svgElRoot.addEventListener('wheel', ev => {
  ev.preventDefault();
  if (ev.ctrlKey || ev.metaKey) {
    const rect = svgElRoot.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const factor = ev.deltaY < 0 ? 1.12 : 0.89;
    const nextZoom = Math.max(0.22, Math.min(2.4, zoom * factor));
    const scaleChange = nextZoom / zoom;
    panX = mx - (mx - panX) * scaleChange;
    panY = my - (my - panY) * scaleChange;
    zoom = nextZoom;
  } else {
    panX -= ev.deltaX;
    panY -= ev.deltaY;
  }
  applyViewportTransform();
}, { passive: false });

if (!accessToken) {
  authBannerEl.hidden = false;
  setConnState('error', '未携带访问令牌');
} else {
  void refreshMindmap(true);
}

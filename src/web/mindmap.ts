import {
  buildOverviewFlowchartAsync,
  buildSessionFlowchartAsync,
  compareTextLocale,
  formatClockShort,
  formatCount,
  formatDuration,
  formatTimeShort,
  getEffectiveSessions,
  mergeSessionLists,
  resolveSessionTurns,
  shortText,
  sourceIcon,
  statusLabel,
  type FlowchartGraph,
  type FlowchartNode,
  type InspectorPayload,
  type MindmapDeliveryItem,
  type MindmapJevQualityGateItem,
  type MindmapJevRouteInfo,
  type MindmapRecalledItem,
  type MindmapSession,
  type MindmapSnapshot,
  type MindmapTaskDetail,
  type MindmapTaskFlow,
  type MindmapWorkerPhase,
  type MindmapWorkerStep,
} from './mindmap-data.js';
import { ApiError, createHttpClient, resolveBootstrapToken, type ApiRequestOptions, type FetchPriority } from './shared/auth-http.js';
import { createSharedSseHub, type SseUpdateBatch } from './shared/sse-hub.js';
import { bindThemeButtons } from './shared/theme.js';
import { initMobileViewport } from './shared/mobile-viewport.js';
import {
  announceStatus,
  bindRovingTablist,
  copyTextWithFeedback,
  isImeComposing,
  onReducedMotionChange,
  prefersReducedMotion,
  safeFocus,
  syncRovingTablist,
  yieldToMain,
} from './shared/ui-primitives.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DOM_DELTA_LINE = typeof WheelEvent !== 'undefined' && typeof WheelEvent.DOM_DELTA_LINE === 'number' ? WheelEvent.DOM_DELTA_LINE : 1;
const DOM_DELTA_PAGE = typeof WheelEvent !== 'undefined' && typeof WheelEvent.DOM_DELTA_PAGE === 'number' ? WheelEvent.DOM_DELTA_PAGE : 2;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function scrollElementIntoViewRespectingMotion(target: Element): void {
  const scrollFn = (target as { scrollIntoView?: (arg?: ScrollIntoViewOptions | boolean) => void }).scrollIntoView;
  if (typeof scrollFn !== 'function') return;
  try {
    scrollFn.call(target, {
      block: 'nearest',
      inline: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  } catch {
    try {
      scrollFn.call(target, { block: 'nearest' });
    } catch {
      // Ignore scroll errors in minimal stubs
    }
  }
}

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

const accessToken = resolveBootstrapToken().token;
let authExpired = false;
let snapshot: MindmapSnapshot | null = null;
let loadedFlows: MindmapTaskFlow[] = [];
let viewMode: ViewMode = 'session';
let sidebarMode: SidebarMode = 'sessions';
let filterKind: FilterKind = 'all';
let searchTerm = '';
let selectedSessionId = '';
let selectedFlowId = '';
let selectedNodeId = '';
let sseCursor = 0;
let sseStarted = false;
let refreshTimer: number | undefined;
let refreshSeq = 0;
let dbEpoch = 0;
let pendingDbReset = false;
const expandedTextCache = new Map<string, string>();

function rememberExpandedText(key: string, value: string): void {
  if (expandedTextCache.size >= 200) {
    const oldest = expandedTextCache.keys().next().value;
    if (oldest !== undefined) expandedTextCache.delete(oldest);
  }
  expandedTextCache.set(key, value);
}

const collapseOverride = new Map<string, boolean>();
let currentGraph: FlowchartGraph | null = null;
let panX = 24;
let panY = 18;
let zoom = 1;
let viewportAnimRaf = 0;
let viewportRenderRaf = 0;
let viewportTargetPanX = panX;
let viewportTargetPanY = panY;
let viewportTargetZoom = zoom;
let isDragging = false;
let dragMoved = false;
let suppressNextClick = false;
let lastDragEndedAt = 0;
let dragStartX = 0;
let dragStartY = 0;
let dragPanStartX = 0;
let dragPanStartY = 0;
const activePointers = new Map<number, { x: number; y: number }>();
let pinchStartDist = 0;
let pinchStartZoom = 1;
let pinchStartPanX = 0;
let pinchStartPanY = 0;
let pinchStartMidX = 0;
let pinchStartMidY = 0;
let lastRenderedInspectorKey = '';
let sidebarRenderSeq = 0;
let canvasBuildSeq = 0;
let canvasRenderSeq = 0;
let listRenderSeq = 0;
let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
let isSearchComposing = false;
let pendingSidebarRefit = false;
let lastConnAnnouncement = '';

const workspaceEl = el<HTMLElement>('mm-canvas-panel').parentElement!;
const toggleSidebarBtn = el<HTMLButtonElement>('mm-toggle-sidebar');
const viewSessionBtn = el<HTMLButtonElement>('view-session-btn');
const viewOverviewBtn = el<HTMLButtonElement>('view-overview-btn');
const viewListBtn = el<HTMLButtonElement>('view-list-btn');
const viewTabsEl = (typeof document !== 'undefined' && typeof document.querySelector === 'function'
  ? document.querySelector<HTMLElement>('.mm-view-tabs')
  : null) ?? viewSessionBtn.parentElement;
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
bindThemeButtons(
  el<HTMLButtonElement>('mm-theme-spatial'),
  el<HTMLButtonElement>('mm-theme-industrial'),
  el<HTMLButtonElement>('mm-theme-system'),
);
initMobileViewport();

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
svgElRoot.setAttribute('aria-description', '使用方向键平移画布，加号或等号放大，减号缩小，数字键 0 重置视图');
const viewportEl = el<SVGGElement>('mm-viewport');
const framesLayerEl = el<SVGGElement>('mm-frames');
const edgesLayerEl = el<SVGGElement>('mm-edges');
const nodesLayerEl = el<SVGGElement>('mm-nodes');
const inspectorEl = el<HTMLElement>('mm-inspector');
const inspectorBodyEl = el<HTMLElement>('mm-inspector-body');

function markAuthExpired() {
  authExpired = true;
  sseHub.stop();
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
  authBannerEl.hidden = false;
  setConnState('error', '需要令牌认证');
}

const http = createHttpClient({
  token: accessToken,
  isExpired: () => authExpired,
  onAuthExpired: markAuthExpired,
  missingTokenMessage: 'Unauthorized',
});

async function apiGet<T>(path: string, init?: ApiRequestOptions): Promise<T> {
  return http.api<T>(path, undefined, init);
}

function setConnState(state: 'live' | 'error' | 'loading', label: string) {
  connPillEl.textContent = label;
  connPillEl.className = `mm-conn-pill${state === 'live' ? ' live' : state === 'error' ? ' error' : ''}`;
  if (state === 'error' && label !== lastConnAnnouncement) {
    lastConnAnnouncement = label;
    announceStatus(label, authExpired ? 'assertive' : 'polite');
  } else if (state === 'live' && lastConnAnnouncement && lastConnAnnouncement !== '已连接实时库') {
    lastConnAnnouncement = '已连接实时库';
    announceStatus(label, 'polite');
  } else if (state === 'live' && !lastConnAnnouncement) {
    lastConnAnnouncement = '已连接实时库';
  }
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

async function filterFlowsChunked(shouldAbort: () => boolean): Promise<MindmapTaskFlow[] | null> {
  const out: MindmapTaskFlow[] = [];
  let deadline = nowMs() + 50;
  for (let i = 0; i < loadedFlows.length; i += 1) {
    const flow = loadedFlows[i]!;
    if (flowMatchesFilter(flow)) out.push(flow);
    if (i < loadedFlows.length - 1 && nowMs() >= deadline) {
      await yieldToMain();
      if (shouldAbort()) return null;
      deadline = nowMs() + 50;
    }
  }
  return out;
}

function getAllSessions(): { all: MindmapSession[]; filtered: MindmapSession[]; flowsById: Map<string, MindmapTaskFlow> } {
  const flowsById = new Map(loadedFlows.map(f => [f.id, f]));
  const all = getEffectiveSessions(snapshot, loadedFlows);
  const filtered = all.filter(s => sessionMatchesFilter(s, flowsById));
  return { all, filtered, flowsById };
}

async function getAllSessionsAsync(
  shouldAbort: () => boolean,
): Promise<{ all: MindmapSession[]; filtered: MindmapSession[]; flowsById: Map<string, MindmapTaskFlow> } | null> {
  const flowsById = new Map(loadedFlows.map(f => [f.id, f]));
  const all = getEffectiveSessions(snapshot, loadedFlows);
  const filtered: MindmapSession[] = [];
  let deadline = nowMs() + 50;
  for (let i = 0; i < all.length; i += 1) {
    const s = all[i]!;
    if (sessionMatchesFilter(s, flowsById)) filtered.push(s);
    if (i < all.length - 1 && nowMs() >= deadline) {
      await yieldToMain();
      if (shouldAbort()) return null;
      deadline = nowMs() + 50;
    }
  }
  return { all, filtered, flowsById };
}

function findSessionForFlow(flowId: string, sessions: MindmapSession[]): MindmapSession | undefined {
  return sessions.find(s => s.turnFlowIds.includes(flowId));
}

function applyViewportTransform() {
  viewportEl.setAttribute('transform', `translate(${panX.toFixed(1)},${panY.toFixed(1)}) scale(${zoom.toFixed(3)})`);
  zoomLabelEl.textContent = `${Math.round(zoom * 100)}%`;
}

function scheduleViewportRender(): void {
  if (typeof requestAnimationFrame !== 'function') {
    applyViewportTransform();
    return;
  }
  if (viewportRenderRaf) return;
  viewportRenderRaf = requestAnimationFrame(() => {
    viewportRenderRaf = 0;
    applyViewportTransform();
  });
}

function cancelViewportAnimation(): void {
  if (viewportAnimRaf && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(viewportAnimRaf);
  }
  viewportAnimRaf = 0;
  if (viewportRenderRaf && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(viewportRenderRaf);
  }
  viewportRenderRaf = 0;
}

onReducedMotionChange(reduced => {
  if (reduced && viewportAnimRaf) {
    cancelViewportAnimation();
    panX = viewportTargetPanX;
    panY = viewportTargetPanY;
    zoom = viewportTargetZoom;
    applyViewportTransform();
  }
});

function springEase(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - Math.exp(-4.8 * t) * Math.cos(1.5 * Math.PI * t);
}

function animateViewportTo(targetPanX: number, targetPanY: number, targetZoom: number, durationMs = 440): void {
  cancelViewportAnimation();
  viewportTargetPanX = targetPanX;
  viewportTargetPanY = targetPanY;
  viewportTargetZoom = targetZoom;
  if (
    prefersReducedMotion()
    || typeof requestAnimationFrame !== 'function'
    || durationMs <= 0
    || (Math.abs(targetPanX - panX) < 0.5 && Math.abs(targetPanY - panY) < 0.5 && Math.abs(targetZoom - zoom) < 0.002)
  ) {
    panX = targetPanX;
    panY = targetPanY;
    zoom = targetZoom;
    applyViewportTransform();
    return;
  }
  const startPanX = panX;
  const startPanY = panY;
  const startZoom = zoom;
  const startAt = nowMs();
  const step = (now: number) => {
    const elapsed = now - startAt;
    const t = Math.min(1, Math.max(0, elapsed / durationMs));
    const eased = springEase(t);
    panX = startPanX + (targetPanX - startPanX) * eased;
    panY = startPanY + (targetPanY - startPanY) * eased;
    zoom = Math.max(0.12, startZoom + (targetZoom - startZoom) * eased);
    applyViewportTransform();
    if (t < 1) {
      viewportAnimRaf = requestAnimationFrame(step);
    } else {
      viewportAnimRaf = 0;
    }
  };
  viewportAnimRaf = requestAnimationFrame(step);
}

function fitWidthTop(animate = false) {
  if (!currentGraph) return;
  const rect = svgElRoot.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const availW = Math.max(300, rect.width - 40);
  const nextZoom = Math.max(0.45, Math.min(1.0, availW / Math.max(1, currentGraph.width)));
  const nextPanX = Math.max(14, (rect.width - currentGraph.width * nextZoom) / 2);
  const nextPanY = 18;
  animateViewportTo(nextPanX, nextPanY, nextZoom, animate ? 440 : 0);
}

function fitToCanvas(animate = false) {
  if (!currentGraph) return;
  const rect = svgElRoot.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const availW = Math.max(300, rect.width - 44);
  const availH = Math.max(260, rect.height - 76);
  const nextZoom = Math.max(0.22, Math.min(1.05, Math.min(availW / Math.max(1, currentGraph.width), availH / Math.max(1, currentGraph.height))));
  const nextPanX = Math.max(16, (rect.width - currentGraph.width * nextZoom) / 2);
  const nextPanY = Math.max(18, (rect.height - 50 - currentGraph.height * nextZoom) / 2);
  animateViewportTo(nextPanX, nextPanY, nextZoom, animate ? 480 : 0);
}

function scrollToFrame(frameId: string) {
  if (!currentGraph) return;
  const frame = currentGraph.frames.find(f => f.id === frameId);
  if (!frame) return;
  const rect = svgElRoot.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const nextZoom = Math.max(zoom, 0.78);
  const nextPanX = Math.max(14, (rect.width - currentGraph.width * nextZoom) / 2);
  const nextPanY = Math.min(28, 28 - frame.y * nextZoom);
  animateViewportTo(nextPanX, nextPanY, nextZoom, 500);
}

function renderKpis() {
  if (!snapshot) return;
  const s = snapshot.summary;
  const { all } = getAllSessions();
  const totalSessions = s.totalSessions ?? all.length;
  const multiTurn = s.multiTurnSessions ?? all.filter(sess => sess.turnCount >= 2).length;
  kpiSessionsEl.textContent = multiTurn > 0 ? `${formatCount(totalSessions)} (${formatCount(multiTurn)} 多轮)` : formatCount(totalSessions);
  kpiFlowsEl.textContent = formatCount(s.totalFlows);
  kpiWechatEl.textContent = formatCount(s.wechatFlows);
  kpiLocalEl.textContent = formatCount(s.localFlows);
  kpiTimerEl.textContent = formatCount(s.timerFlows);
  kpiTasksEl.textContent = formatCount(s.totalTasks);
  kpiJevEl.textContent = formatCount(s.jevCalls);
  kpiMemoriesEl.textContent = formatCount(s.totalMemories);
  kpiModelBadgeEl.textContent = `主控: ${s.routerProvider}/${s.routerModel} · 决策: ${s.decisionModel}${s.decisionConfigured ? ' ✓' : ' (启发式)'}`;
}

function getFocusedSidebarKey(): { kind: 'session' | 'flow'; id: string } | null {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement as Element | null;
  if (!active || !flowListEl.contains?.(active)) return null;
  const item = typeof active.closest === 'function' ? active.closest('.mm-flow-item') : active;
  if (!item) return null;
  const sid = item.getAttribute?.('data-session-id');
  if (sid) return { kind: 'session', id: sid };
  const fid = item.getAttribute?.('data-flow-id');
  if (fid) return { kind: 'flow', id: fid };
  return null;
}

function restoreSidebarFocus(key: { kind: 'session' | 'flow'; id: string } | null): void {
  if (!key) return;
  const attr = key.kind === 'session' ? 'data-session-id' : 'data-flow-id';
  let fallback: HTMLElement | null = null;
  for (const child of flowListEl.children) {
    if (!fallback && child.tagName === 'BUTTON') fallback = child as HTMLElement;
    if (child.getAttribute?.(attr) === key.id) {
      safeFocus(child as HTMLElement, { preventScroll: true });
      return;
    }
  }
  if (fallback) safeFocus(fallback, { preventScroll: true });
}

function syncSidebarSelectionInPlace(): void {
  for (const child of flowListEl.children) {
    const sid = child.getAttribute?.('data-session-id') ?? '';
    const fid = child.getAttribute?.('data-flow-id') ?? '';
    const active = sidebarMode === 'sessions'
      ? Boolean(sid && sid === selectedSessionId)
      : Boolean(fid && fid === selectedFlowId);
    child.classList?.toggle('active', active);
    if (active) child.setAttribute?.('aria-current', 'true');
    else child.removeAttribute?.('aria-current');
  }
}

async function renderSidebar(announceSummary = false): Promise<void> {
  const seq = ++sidebarRenderSeq;
  const shouldAbort = () => seq !== sidebarRenderSeq;
  const sessionData = await getAllSessionsAsync(shouldAbort);
  if (!sessionData || shouldAbort()) return;
  const { all, filtered, flowsById } = sessionData;
  const filteredFlows = await filterFlowsChunked(shouldAbort);
  if (!filteredFlows || shouldAbort()) return;

  if (sidebarMode === 'sessions') {
    const multiCount = filtered.filter(s => s.turnCount >= 2).length;
    sidebarCountEl.textContent = snapshot
      ? `显示 ${formatCount(filtered.length)} 个会话 (多轮 ${formatCount(multiCount)}) / 已载 ${formatCount(all.length)} 会话`
      : '等待数据…';
  } else {
    sidebarCountEl.textContent = snapshot
      ? `显示 ${formatCount(filteredFlows.length)} / 已加载 ${formatCount(loadedFlows.length)} (全库 ${formatCount(snapshot.summary.totalFlows)} 条)`
      : '等待数据…';
  }
  loadMoreWrapEl.hidden = !snapshot?.hasMore;

  const focusedKey = getFocusedSidebarKey();
  const nextChildren: Element[] = [];
  let deadline = nowMs() + 50;

  if (sidebarMode === 'sessions') {
    if (!filtered.length) {
      const emptyEl = domEl('p', 'mm-muted', '当前筛选条件下没有匹配的 AI 会话。');
      emptyEl.setAttribute('role', 'status');
      flowListEl.replaceChildren(emptyEl);
      if (announceSummary) announceStatus('当前筛选条件下没有匹配的 AI 会话。');
      return;
    }
    for (let i = 0; i < filtered.length; i += 1) {
      const session = filtered[i]!;
      const turns = resolveSessionTurns(session, flowsById);
      const first = turns[0]!;
      const last = turns[turns.length - 1]!;
      const srcClass = session.channels.includes('wechat')
        ? 'src-wechat'
        : session.kind === 'timer'
          ? 'src-timer'
          : 'src-local';
      const isActive = session.id === selectedSessionId;
      const item = domEl('button', `mm-flow-item ${srcClass}${isActive ? ' active' : ''}`);
      item.type = 'button';
      item.setAttribute('data-session-id', session.id);
      if (isActive) item.setAttribute('aria-current', 'true');

      const top = domEl('div', 'mm-flow-item-top');
      const timeRange = session.turnCount > 1
        ? `${sourceIcon(first.ingress.sourceKind)} ${formatTimeShort(session.startedAt)} ~ ${formatClockShort(session.updatedAt)}`
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
        syncSidebarSelectionInPlace();
        if (viewMode === 'list') {
          void renderListMatrix();
          renderInspectorForPayload({ flow: last, snapshot: snapshot ?? undefined, session });
        } else if (viewMode === 'overview') {
          void rebuildAndRenderCanvas(false).then(() => {
            scrollToFrame(`ov-frame:${session.id}`);
          });
        } else {
          void rebuildAndRenderCanvas(true);
        }
      });
      nextChildren.push(item);

      if (i < filtered.length - 1 && nowMs() >= deadline) {
        await yieldToMain();
        if (shouldAbort()) return;
        deadline = nowMs() + 50;
      }
    }
    flowListEl.replaceChildren(...nextChildren);
    restoreSidebarFocus(focusedKey);
    if (announceSummary && snapshot) announceStatus(sidebarCountEl.textContent ?? '');
    return;
  }

  // Turn-by-turn fallback sidebar mode
  if (!filteredFlows.length) {
    const emptyEl = domEl('p', 'mm-muted', '当前筛选条件下没有匹配的消息记录。');
    emptyEl.setAttribute('role', 'status');
    flowListEl.replaceChildren(emptyEl);
    if (announceSummary) announceStatus('当前筛选条件下没有匹配的消息记录。');
    return;
  }
  for (let i = 0; i < filteredFlows.length; i += 1) {
    const flow = filteredFlows[i]!;
    const isActive = flow.id === selectedFlowId;
    const item = domEl('button', `mm-flow-item src-${flow.ingress.sourceKind}${isActive ? ' active' : ''}`);
    item.type = 'button';
    item.setAttribute('data-flow-id', flow.id);
    if (isActive) item.setAttribute('aria-current', 'true');

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
      syncSidebarSelectionInPlace();
      if (viewMode === 'list') {
        void renderListMatrix();
        renderInspectorForPayload({ flow, snapshot: snapshot ?? undefined, session: owner });
      } else {
        void rebuildAndRenderCanvas(false).then(() => {
          scrollToFrame(viewMode === 'overview' && owner ? `ov-frame:${owner.id}` : `frame:${flow.id}`);
        });
      }
    });
    nextChildren.push(item);

    if (i < filteredFlows.length - 1 && nowMs() >= deadline) {
      await yieldToMain();
      if (shouldAbort()) return;
      deadline = nowMs() + 50;
    }
  }
  flowListEl.replaceChildren(...nextChildren);
  restoreSidebarFocus(focusedKey);
  if (announceSummary && snapshot) announceStatus(sidebarCountEl.textContent ?? '');
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
  const titleEl = svgEl('title');
  const fullMetric = n.metric ? ` · ${n.metric}` : '';
  const fullStatus = n.status ? ` [${statusLabel(n.status)}]` : '';
  titleEl.textContent = `${n.badge}：${n.title}\n${n.subtitle}${fullMetric}${fullStatus}`;
  g.appendChild(titleEl);

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

function bindSvgButtonActivation(target: SVGElement, onActivate: (ev: Event) => void): void {
  let spacePressed = false;
  target.addEventListener('keydown', ev => {
    const ke = ev as KeyboardEvent;
    if (ke.key === 'Enter') {
      if (isImeComposing(ke) || ke.isComposing || ke.keyCode === 229) return;
      ke.preventDefault();
      ke.stopPropagation();
      onActivate(ev);
    } else if (ke.key === ' ') {
      ke.preventDefault();
      ke.stopPropagation();
      spacePressed = true;
    } else if (ke.key === 'Escape') {
      ke.stopPropagation();
      safeFocus(svgElRoot as unknown as HTMLElement);
    }
  });
  target.addEventListener('keyup', ev => {
    const ke = ev as KeyboardEvent;
    if (ke.key === ' ') {
      ke.preventDefault();
      ke.stopPropagation();
      if (spacePressed) {
        spacePressed = false;
        onActivate(ev);
      }
    }
  });
  target.addEventListener('blur', () => {
    spacePressed = false;
  });
}

function getFocusedCanvasKey(): string {
  if (typeof document === 'undefined') return '';
  const active = document.activeElement as Element | null;
  if (!active || active === svgElRoot || !svgElRoot.contains?.(active)) return '';
  return active.getAttribute?.('data-focus-key') ?? '';
}

function restoreCanvasFocus(focusKey: string): void {
  if (!focusKey) return;
  const candidates = svgElRoot.querySelectorAll?.('[data-focus-key]') ?? [];
  for (const elNode of candidates) {
    if (elNode.getAttribute?.('data-focus-key') === focusKey) {
      safeFocus(elNode as unknown as HTMLElement, { preventScroll: true });
      return;
    }
  }
  safeFocus(svgElRoot as unknown as HTMLElement, { preventScroll: true });
}

function selectNodeInPlace(n: FlowchartNode): void {
  const prevNodeId = selectedNodeId;
  const prevSessionId = selectedSessionId;
  const prevFlowId = selectedFlowId;
  selectedNodeId = n.id;
  if (n.flowId) selectedFlowId = n.flowId;
  if (n.sessionId) selectedSessionId = n.sessionId;
  else {
    const { all } = getAllSessions();
    const owner = findSessionForFlow(n.flowId, all);
    if (owner) selectedSessionId = owner.id;
  }

  if (prevNodeId !== selectedNodeId) {
    for (const child of nodesLayerEl.children) {
      const gid = child.getAttribute?.('data-node-id') ?? '';
      const isSel = gid === selectedNodeId;
      child.classList?.toggle('node-selected', isSel);
      const hitEl = child.querySelector?.('.mm-node-hit') ?? child;
      if (isSel) hitEl.setAttribute?.('aria-current', 'true');
      else hitEl.removeAttribute?.('aria-current');
    }
  }

  if (prevSessionId !== selectedSessionId || prevFlowId !== selectedFlowId) {
    syncSidebarSelectionInPlace();
  }

  renderInspectorForNode(n);
  announceStatus(`已选中节点：${n.title}`);
}

async function renderFlowchartCanvas(): Promise<void> {
  if (!currentGraph) return;
  const seq = ++canvasRenderSeq;
  const shouldAbort = () => seq !== canvasRenderSeq;
  const focusedKey = getFocusedCanvasKey();
  const anyMatch = Boolean(searchTerm && currentGraph.nodes.some(n => n.match));

  const frameEls: SVGElement[] = [];
  const edgeEls: SVGElement[] = [];
  const nodeEls: SVGElement[] = [];
  let deadline = nowMs() + 50;

  // 1) Frames (Turn or Session swimlane containers)
  for (let fIdx = 0; fIdx < currentGraph.frames.length; fIdx += 1) {
    const frame = currentGraph.frames[fIdx]!;
    const fg = svgEl('g', { class: `fc-turn-frame st-${frame.status}` });
    const frameHitG = svgEl('g', {
      class: 'fc-frame-hit',
      role: 'button',
      tabindex: '0',
      'data-focus-key': `frame:${frame.id}`,
      'aria-label': `${frame.title}，${frame.subtitle}，状态 ${statusLabel(frame.status)}`,
    });
    const frameTitle = svgEl('title');
    frameTitle.textContent = `${frame.title}\n${frame.subtitle} (${frame.badge})`;
    frameHitG.appendChild(frameTitle);
    frameHitG.appendChild(svgEl('rect', {
      x: frame.x,
      y: frame.y,
      width: frame.w,
      height: frame.h,
      rx: 12,
      class: 'fc-frame-box',
    }));
    frameHitG.appendChild(svgEl('rect', {
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
    frameHitG.append(tText, sText, bText);

    const activateFrame = () => {
      if (currentGraph?.mode === 'overview') {
        selectedSessionId = frame.sessionId;
        switchViewMode('session');
        return;
      }
      if (frame.flowId) {
        selectedFlowId = frame.flowId;
        const foundNode = currentGraph?.nodes.find(n => n.flowId === frame.flowId);
        if (foundNode) {
          selectNodeInPlace(foundNode);
        }
      }
    };
    frameHitG.addEventListener('click', () => {
      if (dragMoved) return;
      activateFrame();
    });
    bindSvgButtonActivation(frameHitG, activateFrame);
    fg.appendChild(frameHitG);

    if (frame.toggleKey) {
      const btnG = svgEl('g', {
        transform: `translate(${frame.x + frame.w - 84}, ${frame.y + 10})`,
        class: 'mm-toggle-btn',
        role: 'button',
        tabindex: '0',
        'aria-expanded': String(!frame.collapsed),
        'aria-label': frame.collapsed ? `展开${frame.title}` : `收起${frame.title}`,
        'data-focus-key': `frame-toggle:${frame.toggleKey}`,
      });
      btnG.appendChild(svgEl('rect', { x: 0, y: 0, width: 70, height: 22, rx: 6, class: 'fc-frame-toggle-rect' }));
      const btnLabel = svgEl('text', { x: 35, y: 11, class: 'fc-frame-toggle-text' });
      btnLabel.textContent = frame.collapsed ? '展开本轮' : '收起本轮';
      btnG.appendChild(btnLabel);
      const toggleFrame = () => {
        collapseOverride.set(frame.toggleKey!, !frame.collapsed);
        announceStatus(frame.collapsed ? `已展开${frame.title}` : `已收起${frame.title}`);
        void rebuildAndRenderCanvas(false);
      };
      btnG.addEventListener('click', ev => {
        ev.stopPropagation();
        if (dragMoved) return;
        toggleFrame();
      });
      bindSvgButtonActivation(btnG, toggleFrame);
      fg.appendChild(btnG);
    }

    frameEls.push(fg);
    if (fIdx < currentGraph.frames.length - 1 && nowMs() >= deadline) {
      await yieldToMain();
      if (shouldAbort()) return;
      deadline = nowMs() + 50;
    }
  }

  // 2) Edges (orthogonal rounded arrows + pill labels)
  const nodesById = new Map(currentGraph.nodes.map(n => [n.id, n]));
  for (let eIdx = 0; eIdx < currentGraph.edges.length; eIdx += 1) {
    const edge = currentGraph.edges[eIdx]!;
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
    edgeEls.push(path);

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
      edgeEls.push(lg);
    }

    if (eIdx < currentGraph.edges.length - 1 && nowMs() >= deadline) {
      await yieldToMain();
      if (shouldAbort()) return;
      deadline = nowMs() + 50;
    }
  }

  // 3) Flowchart Shape Nodes
  for (let nIdx = 0; nIdx < currentGraph.nodes.length; nIdx += 1) {
    const n = currentGraph.nodes[nIdx]!;
    const selected = n.id === selectedNodeId;
    const dim = anyMatch && !n.match;
    const g = svgEl('g', {
      transform: `translate(${n.x},${n.y})`,
      'data-node-id': n.id,
      class: `mm-node-group cat-${n.category}${selected ? ' node-selected' : ''}${n.match ? ' node-match' : ''}${dim ? ' node-dim' : ''}`,
    });
    const nodeHitG = svgEl('g', {
      class: 'mm-node-hit',
      role: 'button',
      tabindex: '0',
      'data-focus-key': `node:${n.id}`,
      'aria-label': `${n.badge}：${n.title}，${n.subtitle}${n.status ? `，状态 ${statusLabel(n.status)}` : ''}`,
      ...(n.kind === 'worker_more' ? { 'aria-expanded': 'false' } : {}),
      ...(selected ? { 'aria-current': 'true' } : {}),
    });
    renderFlowchartNodeShape(nodeHitG, n);

    const activateNode = () => {
      if (n.kind === 'worker_more' && n.toggleKey) {
        collapseOverride.set(n.toggleKey, false);
        announceStatus(`已展开剩余 ${n.hiddenCount ?? 0} 个执行步骤`);
        void rebuildAndRenderCanvas(false);
        return;
      }
      selectNodeInPlace(n);
    };

    nodeHitG.addEventListener('click', ev => {
      ev.stopPropagation();
      if (dragMoved) return;
      activateNode();
    });
    nodeHitG.addEventListener('dblclick', ev => {
      ev.stopPropagation();
      if (viewMode === 'overview' && n.sessionId) {
        selectedSessionId = n.sessionId;
        switchViewMode('session');
      }
    });
    bindSvgButtonActivation(nodeHitG, activateNode);
    g.appendChild(nodeHitG);

    if (n.toggleKey && n.kind !== 'worker_more') {
      const btnW = n.collapsed ? 64 : 52;
      const tg = svgEl('g', {
        transform: `translate(${n.w - btnW - 10}, ${n.h - 11})`,
        class: 'mm-toggle-btn',
        role: 'button',
        tabindex: '0',
        'aria-expanded': String(!n.collapsed),
        'aria-label': n.collapsed
          ? `展开${n.title}的 ${n.hiddenCount ?? 0} 个隐藏项`
          : `收起${n.title}的展开项`,
        'data-focus-key': `node-toggle:${n.toggleKey}`,
      });
      tg.appendChild(svgEl('rect', { x: 0, y: 0, width: btnW, height: 20, rx: 10, class: 'mm-toggle-pill-rect' }));
      const tt = svgEl('text', { x: btnW / 2, y: 10, class: 'mm-toggle-text' });
      tt.textContent = n.collapsed ? `展开 +${n.hiddenCount ?? 0}` : '收起 −';
      tg.appendChild(tt);
      const toggleNode = () => {
        collapseOverride.set(n.toggleKey!, !n.collapsed);
        selectedNodeId = n.id;
        announceStatus(n.collapsed ? `已展开${n.title}` : `已收起${n.title}`);
        void rebuildAndRenderCanvas(false);
      };
      tg.addEventListener('click', ev => {
        ev.stopPropagation();
        if (dragMoved) return;
        toggleNode();
      });
      bindSvgButtonActivation(tg, toggleNode);
      g.appendChild(tg);
    }

    nodeEls.push(g);
    if (nIdx < currentGraph.nodes.length - 1 && nowMs() >= deadline) {
      await yieldToMain();
      if (shouldAbort()) return;
      deadline = nowMs() + 50;
    }
  }

  if (shouldAbort()) return;
  framesLayerEl.replaceChildren(...frameEls);
  edgesLayerEl.replaceChildren(...edgeEls);
  nodesLayerEl.replaceChildren(...nodeEls);
  restoreCanvasFocus(focusedKey);
}

async function rebuildAndRenderCanvas(shouldFit: boolean): Promise<void> {
  if (!snapshot) return;
  const seq = ++canvasBuildSeq;
  const shouldAbort = () => seq !== canvasBuildSeq;
  const sessionData = await getAllSessionsAsync(shouldAbort);
  if (!sessionData || shouldAbort()) return;
  const { all, filtered, flowsById } = sessionData;
  if (!filtered.length) {
    currentGraph = null;
    framesLayerEl.replaceChildren();
    edgesLayerEl.replaceChildren();
    nodesLayerEl.replaceChildren();
    const emptyEl = domEl('p', 'mm-muted', '暂无匹配的 AI 会话或任务流。');
    emptyEl.setAttribute('role', 'status');
    inspectorBodyEl.replaceChildren(emptyEl);
    return;
  }

  if (!selectedSessionId || !filtered.some(s => s.id === selectedSessionId)) {
    const owner = selectedFlowId ? findSessionForFlow(selectedFlowId, filtered) : undefined;
    selectedSessionId = owner?.id ?? filtered[0]!.id;
  }

  const activeSession = filtered.find(s => s.id === selectedSessionId) ?? all.find(s => s.id === selectedSessionId) ?? filtered[0]!;
  const nextGraph = viewMode === 'overview'
    ? await buildOverviewFlowchartAsync(filtered, flowsById, snapshot, searchTerm, shouldAbort)
    : await buildSessionFlowchartAsync(activeSession, flowsById, snapshot, collapseOverride, searchTerm, shouldAbort);
  if (!nextGraph || shouldAbort()) return;
  currentGraph = nextGraph;

  const prevSelected = selectedNodeId;
  const prevScrollTop = inspectorEl.scrollTop;
  const activeNode = (selectedNodeId && currentGraph.nodes.find(n => n.id === selectedNodeId)) ?? currentGraph.nodes[0];
  if (activeNode) selectedNodeId = activeNode.id;

  await renderFlowchartCanvas();
  if (shouldAbort()) return;
  if (shouldFit) fitWidthTop();
  if (activeNode) {
    renderInspectorForNode(activeNode);
    if (activeNode.id === prevSelected) inspectorEl.scrollTop = prevScrollTop;
  }
}

async function renderListMatrix(): Promise<void> {
  const seq = ++listRenderSeq;
  const shouldAbort = () => seq !== listRenderSeq;
  const sessionData = await getAllSessionsAsync(shouldAbort);
  if (!sessionData || shouldAbort()) return;
  const { filtered, flowsById } = sessionData;
  matrixSubtitleEl.textContent = `共筛选出 ${formatCount(filtered.length)} 个 AI 会话`;
  if (!filtered.length) {
    const emptyEl = domEl('p', 'mm-muted', '暂无匹配的会话。');
    emptyEl.setAttribute('role', 'status');
    matrixGridEl.replaceChildren(emptyEl);
    return;
  }
  const cards: Element[] = [];
  let deadline = nowMs() + 50;
  for (let sIdx = 0; sIdx < filtered.length; sIdx += 1) {
    const session = filtered[sIdx]!;
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
    cards.push(card);

    if (sIdx < filtered.length - 1 && nowMs() >= deadline) {
      await yieldToMain();
      if (shouldAbort()) return;
      deadline = nowMs() + 50;
    }
  }
  if (shouldAbort()) return;
  matrixGridEl.replaceChildren(...cards);
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
  bar.setAttribute('aria-label', `${label}: ${valueText}`);
  row.append(head, bar);
  return row;
}

interface CodePayloadBlock {
  headerEl: HTMLElement;
  pre: HTMLPreElement;
  code: HTMLElement;
  setText: (next: string) => void;
  appendTo: (container: HTMLElement) => void;
}

function createCodePayloadBlock(
  titleLabel: string,
  regionLabel: string,
  initialText: string,
): CodePayloadBlock {
  const headerEl = domEl('div', 'mm-sub-card-head');
  headerEl.appendChild(domEl('span', 'mm-kv-k', titleLabel));
  const actionWrap = domEl('span', 'mm-insp-actions');
  const copyBtn = domEl('button', 'mm-mini-btn', '复制');
  copyBtn.type = 'button';
  copyBtn.setAttribute('aria-label', `复制${regionLabel}`);
  const statusEl = domEl('span', 'visually-hidden');
  statusEl.setAttribute('role', 'status');
  actionWrap.append(copyBtn, statusEl);
  headerEl.appendChild(actionWrap);

  const pre = domEl('pre', 'mm-pre');
  pre.setAttribute('tabindex', '0');
  pre.setAttribute('role', 'region');
  pre.setAttribute('aria-label', regionLabel);
  const code = domEl('code', undefined, initialText);
  pre.appendChild(code);

  copyBtn.addEventListener('click', () => {
    void copyTextWithFeedback(copyBtn, code.textContent ?? '', {
      statusEl,
      defaultLabel: '复制',
      successLabel: '已复制',
      failLabel: '复制失败',
    });
  });

  return {
    headerEl,
    pre,
    code,
    setText(next: string) {
      code.textContent = next;
    },
    appendTo(container: HTMLElement) {
      container.append(headerEl, pre);
    },
  };
}

function moveFocusBeforeRemovingButton(btn: HTMLButtonElement, targetEl: HTMLElement, statusMsg: string): void {
  const wasFocused = typeof document !== 'undefined' && document.activeElement === btn;
  btn.remove();
  if (wasFocused) {
    safeFocus(targetEl, { preventScroll: true });
  }
  announceStatus(statusMsg);
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

  const ingressCacheKey = flow.ingress.messageId ? `ingress:${flow.ingress.messageId}` : '';
  const cachedIngressText = ingressCacheKey ? expandedTextCache.get(ingressCacheKey) : undefined;
  const ingressBlock = createCodePayloadBlock(
    '原始消息正文：',
    '老板原始消息正文',
    cachedIngressText ?? flow.ingress.text,
  );
  ingressBlock.appendTo(sec);

  if (flow.ingress.textTruncated && flow.ingress.messageId && cachedIngressText === undefined) {
    const loadFullBtn = domEl('button', 'mm-mini-btn', '查看未截断原始消息全文');
    loadFullBtn.type = 'button';
    loadFullBtn.addEventListener('click', async () => {
      loadFullBtn.disabled = true;
      loadFullBtn.textContent = '正在加载全文…';
      try {
        const full = await apiGet<{ text: string }>(`/api/message?messageId=${encodeURIComponent(flow.ingress.messageId!)}`);
        rememberExpandedText(ingressCacheKey, full.text);
        ingressBlock.setText(full.text);
        moveFocusBeforeRemovingButton(loadFullBtn, ingressBlock.pre, '已加载原始消息全文');
      } catch {
        loadFullBtn.disabled = false;
        loadFullBtn.textContent = '加载失败，重试';
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
        card.appendChild(domEl('p', 'mm-muted', `标签: ${hit.tags.toSorted(compareTextLocale).join(', ')}`));
      }
      createCodePayloadBlock('记忆片段：', `记忆内容：${hit.title}`, hit.snippet).appendTo(card);
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
    ['Token 消耗', step.usage ? `输入 ${formatCount(step.usage.input)} / 缓存读取 ${formatCount(step.usage.cacheRead)} / 推理 ${formatCount(step.usage.reasoning)} / 输出 ${formatCount(step.usage.output)} (总 ${formatCount(step.usage.totalTokens)})` : undefined],
  ];
  const grid = domEl('div', 'mm-kv-grid');
  for (const [k, v] of pairs) {
    if (!v) continue;
    grid.append(domEl('span', 'mm-kv-k', k), domEl('span', 'mm-kv-v', v));
  }
  sec.appendChild(grid);

  if (step.inputPreview) {
    createCodePayloadBlock('调用入参 / 命令：', `Worker 工具调用入参：${step.toolName ?? step.title}`, step.inputPreview).appendTo(sec);
  }
  const opCacheKey = step.operationId ? `op:${task.id}:${step.operationId}` : '';
  const cachedOpOut = opCacheKey ? expandedTextCache.get(opCacheKey) : undefined;
  const outBlock = createCodePayloadBlock(
    '执行结果输出：',
    `Worker 工具执行结果：${step.toolName ?? step.title}`,
    cachedOpOut ?? step.outputPreview ?? '（无文本输出）',
  );
  if (cachedOpOut !== undefined || step.outputPreview) {
    outBlock.appendTo(sec);
  }
  if (step.operationId && step.hasFullOperation && cachedOpOut === undefined) {
    const btn = domEl('button', 'mm-mini-btn', '从后台拉取完整工具原始输出');
    btn.type = 'button';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '拉取中…';
      try {
        const op = await apiGet<{ result?: string; error?: string }>(`/api/operation?taskId=${encodeURIComponent(task.id)}&operationId=${encodeURIComponent(step.operationId!)}`);
        const text = op.result ?? op.error ?? '（空）';
        rememberExpandedText(opCacheKey, text);
        outBlock.setText(text);
        if (!step.outputPreview) {
          outBlock.appendTo(sec);
        }
        moveFocusBeforeRemovingButton(btn, outBlock.pre, '已加载完整工具输出');
      } catch {
        btn.disabled = false;
        btn.textContent = '拉取失败，重试';
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
      const delCacheKey = `del:${del.messageId}`;
      const cachedDel = expandedTextCache.get(delCacheKey);
      const delBlock = createCodePayloadBlock(
        '回复内容：',
        `第 ${del.seq} 条公开回复正文`,
        cachedDel ?? (del.text || del.reason || '（空）'),
      );
      delBlock.appendTo(card);
      if (del.textTruncated && cachedDel === undefined) {
        const btn = domEl('button', 'mm-mini-btn', '查看完整回复正文');
        btn.type = 'button';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const full = await apiGet<{ text: string }>(`/api/message?messageId=${encodeURIComponent(del.messageId)}`);
            rememberExpandedText(delCacheKey, full.text);
            delBlock.setText(full.text);
            moveFocusBeforeRemovingButton(btn, delBlock.pre, '已加载完整回复正文');
          } catch {
            btn.disabled = false;
            btn.textContent = '加载失败，重试';
          }
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
  createCodePayloadBlock('下发给 Worker 的任务指令：', 'Worker 任务指令', task.prompt).appendTo(sec);
  if (task.reportPreview) {
    const workCacheKey = `work:${task.id}`;
    const cachedReport = expandedTextCache.get(workCacheKey);
    const repBlock = createCodePayloadBlock(
      'Worker 提交的成果报告：',
      'Worker 成果报告',
      cachedReport ?? task.reportPreview,
    );
    repBlock.appendTo(sec);
    if (task.reportTruncated && cachedReport === undefined) {
      const btn = domEl('button', 'mm-mini-btn', '查看未截断 Worker 完整报告');
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const full = await apiGet<{ report?: string }>(`/api/work?taskId=${encodeURIComponent(task.id)}`);
          if (full.report) {
            rememberExpandedText(workCacheKey, full.report);
            repBlock.setText(full.report);
          }
          moveFocusBeforeRemovingButton(btn, repBlock.pre, '已加载完整 Worker 报告');
        } catch {
          btn.disabled = false;
          btn.textContent = '加载失败，重试';
        }
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
    const isActive = ts.flowId === activeFlowId;
    const btn = domEl('button', `mm-session-turn-card${isActive ? ' active' : ''}`);
    btn.type = 'button';
    if (isActive) btn.setAttribute('aria-current', 'true');
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
      if (viewMode !== 'session') {
        void switchViewMode('session').then(() => {
          scrollToFrame(`frame:${ts.flowId}`);
        });
      } else {
        scrollToFrame(`frame:${ts.flowId}`);
      }
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
    createCodePayloadBlock('本阶段补充指令：', `Worker 阶段 #${phase.index} 补充指令`, phase.followupPrompt).appendTo(sec);
  }
  const steps = task.workerSteps.filter(s => s.phaseIndex === phase.index && s.kind !== 'followup');
  if (steps.length) {
    const list = domEl('div', 'mm-card-list');
    for (const st of steps) {
      const card = domEl('div', 'mm-sub-card');
      card.appendChild(domEl('div', 'mm-sub-card-head', `${st.title} (${formatDuration(st.durationMs)})`));
      if (st.inputPreview) {
        createCodePayloadBlock('调用入参：', `${st.title} 调用入参`, st.inputPreview).appendTo(card);
      }
      if (st.outputPreview) {
        createCodePayloadBlock('执行输出：', `${st.title} 执行输出`, st.outputPreview).appendTo(card);
      }
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
  const inspKey = `${node.id}|${node.kind}|${node.flowId}|${node.sessionId ?? ''}`;
  const switched = lastRenderedInspectorKey !== '' && lastRenderedInspectorKey !== inspKey;
  lastRenderedInspectorKey = inspKey;
  inspectorBodyEl.replaceChildren();
  try {
    renderInspectorNodeContents(node);
  } finally {
    if (switched && !prefersReducedMotion()) {
      for (const child of inspectorBodyEl.children) {
        child.classList.add('mm-insp-enter');
      }
    }
  }
}

function renderInspectorNodeContents(node: FlowchartNode) {
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
          if (tl.inputPreview) {
            createCodePayloadBlock('调用入参：', `${tl.toolName} 调用入参`, tl.inputPreview).appendTo(tSec);
          }
          if (tl.outputPreview) {
            createCodePayloadBlock('工具返回：', `${tl.toolName} 工具返回`, tl.outputPreview).appendTo(tSec);
          }
          inspectorBodyEl.appendChild(tSec);
        } else if (rt.tools.length) {
          const sec = domEl('section', 'mm-section');
          sec.appendChild(domEl('h3', 'mm-section-title', `本轮调用的 Router 工具 (${rt.tools.length})`));
          for (const tl of rt.tools) {
            const c = domEl('div', 'mm-sub-card');
            c.appendChild(domEl('div', 'mm-sub-card-head', `${tl.toolName} (${statusLabel(tl.status)})`));
            if (tl.inputPreview) {
              createCodePayloadBlock('调用入参：', `${tl.toolName} 调用入参`, tl.inputPreview).appendTo(c);
            }
            if (tl.outputPreview) {
              createCodePayloadBlock('工具返回：', `${tl.toolName} 工具返回`, tl.outputPreview).appendTo(c);
            }
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
        card.appendChild(domEl('p', 'mm-muted', `标签: ${m.tags.toSorted(compareTextLocale).join(', ')} · ${formatTimeShort(m.createdAt)}`));
        createCodePayloadBlock('记忆正文：', `沉淀记忆内容：${m.topic}`, m.contentPreview).appendTo(card);
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

async function switchViewMode(next: ViewMode): Promise<void> {
  viewMode = next;
  viewSessionBtn.classList.toggle('active', next === 'session');
  viewOverviewBtn.classList.toggle('active', next === 'overview');
  viewListBtn.classList.toggle('active', next === 'list');
  const nextTabBtn = next === 'overview' ? viewOverviewBtn : next === 'list' ? viewListBtn : viewSessionBtn;
  if (viewTabsEl && typeof viewTabsEl.querySelectorAll === 'function') {
    syncRovingTablist(viewTabsEl, nextTabBtn);
  } else {
    viewSessionBtn.setAttribute('aria-selected', String(next === 'session'));
    viewOverviewBtn.setAttribute('aria-selected', String(next === 'overview'));
    viewListBtn.setAttribute('aria-selected', String(next === 'list'));
  }

  canvasPanelEl.hidden = next === 'list';
  listPanelEl.hidden = next !== 'list';
  canvasControlsEl.hidden = next === 'list';

  if (next === 'list') {
    await renderListMatrix();
    const { filtered, flowsById } = getAllSessions();
    const activeSession = filtered.find(s => s.id === selectedSessionId) ?? filtered[0];
    if (activeSession) {
      const turns = resolveSessionTurns(activeSession, flowsById);
      renderInspectorForPayload({ flow: turns.at(-1) ?? null, snapshot: snapshot ?? undefined, session: activeSession });
    }
  } else {
    selectedNodeId = '';
    await rebuildAndRenderCanvas(true);
  }
}

const sseHub = createSharedSseHub({
  token: accessToken,
  request: http.request,
  isStopped: () => authExpired,
  onConnected: viaLeader => {
    if (!snapshot) return;
    const sessCount = snapshot.summary.totalSessions ?? getEffectiveSessions(snapshot, loadedFlows).length;
    setConnState('live', `已连接实时库${viaLeader ? '（共享流）' : ''} (${formatCount(sessCount)} 会话 · ${formatCount(snapshot.summary.totalFlows)} 句)`);
  },
  onError: err => {
    if (authExpired) return;
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      markAuthExpired();
      return;
    }
    setConnState('error', '实时流重连中…');
  },
  onUpdates: (batch: SseUpdateBatch) => {
    if (authExpired) return;
    const cursorReset = Boolean(batch.reset) || batch.cursor < sseCursor;
    if (cursorReset) {
      pendingDbReset = true;
      dbEpoch += 1;
      sseCursor = batch.cursor;
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = undefined; }
      void refreshMindmap(false, 'low');
      return;
    }
    if (typeof batch.cursor === 'number') {
      sseCursor = Math.max(sseCursor, batch.cursor);
    }
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refreshMindmap(false, 'low');
    }, 450) as unknown as number;
  },
});

let sidebarRefitSettleTimer: ReturnType<typeof setTimeout> | undefined;
let lastObservedCanvasWidth = 0;
const canvasResizeObserver = typeof ResizeObserver === 'function'
  ? new ResizeObserver(entries => {
      const entry = entries[0];
      const nextWidth = entry ? entry.contentRect.width : canvasPanelEl.getBoundingClientRect().width;
      if (!pendingSidebarRefit || nextWidth <= 0) {
        lastObservedCanvasWidth = nextWidth;
        return;
      }
      if (Math.abs(nextWidth - lastObservedCanvasWidth) < 1) return;
      lastObservedCanvasWidth = nextWidth;
      if (viewMode !== 'list') {
        fitWidthTop(false);
      }
      if (sidebarRefitSettleTimer !== undefined) clearTimeout(sidebarRefitSettleTimer);
      sidebarRefitSettleTimer = setTimeout(() => {
        sidebarRefitSettleTimer = undefined;
        pendingSidebarRefit = false;
      }, 120);
    })
  : null;
canvasResizeObserver?.observe(canvasPanelEl);

window.addEventListener('pagehide', ev => {
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = undefined; }
  if (searchDebounceTimer !== undefined) { clearTimeout(searchDebounceTimer); searchDebounceTimer = undefined; }
  if (sidebarRefitSettleTimer !== undefined) { clearTimeout(sidebarRefitSettleTimer); sidebarRefitSettleTimer = undefined; }
  cancelViewportAnimation();
  const persisted = (ev as PageTransitionEvent).persisted;
  if (persisted) {
    sseHub.pause();
  } else {
    canvasResizeObserver?.disconnect();
    sseHub.stop();
  }
});

window.addEventListener('pageshow', ev => {
  const persisted = (ev as PageTransitionEvent).persisted;
  if (persisted && !authExpired && sseStarted) {
    sseHub.resume();
  }
});

async function refreshMindmap(fitOnFirst = false, priority: FetchPriority = 'auto') {
  if (authExpired) return;
  const seq = ++refreshSeq;
  const hadPendingReset = pendingDbReset;
  const epochAtStart = dbEpoch;
  try {
    setConnState('loading', '同步中…');
    const data = await apiGet<MindmapSnapshot>('/api/mindmap?limit=120', { priority });
    if (seq !== refreshSeq || authExpired) return;
    if (hadPendingReset && dbEpoch === epochAtStart) {
      pendingDbReset = false;
    }
    authBannerEl.hidden = true;
    const dbReset = hadPendingReset || Boolean(snapshot && data.cursor < snapshot.cursor);
    const prevIds = new Set(loadedFlows.map(flow => flow.id));
    const latestIds = new Set(data.flows.map(flow => flow.id));
    const olderPreserved = dbReset ? [] : loadedFlows.filter(flow => !latestIds.has(flow.id));
    const hasOverlapWithLoaded = data.flows.some(flow => prevIds.has(flow.id));
    const hasPaginationGap = !dbReset && olderPreserved.length > 0 && data.hasMore && !hasOverlapWithLoaded;

    if (dbReset) {
      dbEpoch += 1;
      collapseOverride.clear();
      expandedTextCache.clear();
      sseCursor = data.cursor;
      sseHub.setCursor(data.cursor);
    }

    if (dbReset || hasPaginationGap || olderPreserved.length === 0) {
      loadedFlows = data.flows;
      snapshot = data;
    } else {
      loadedFlows = [...data.flows, ...olderPreserved];
      snapshot = snapshot
        ? {
            ...data,
            flows: loadedFlows,
            sessions: mergeSessionLists(data.sessions, snapshot.sessions),
            hasMore: snapshot.hasMore,
            beforeSeq: snapshot.beforeSeq,
          }
        : data;
    }

    const sessCount = data.summary.totalSessions ?? getEffectiveSessions(snapshot, loadedFlows).length;
    setConnState('live', `已连接实时库 (${formatCount(sessCount)} 会话 · ${formatCount(data.summary.totalFlows)} 句)`);
    renderKpis();
    await renderSidebar();
    if (seq !== refreshSeq || authExpired) return;
    if (viewMode === 'list') await renderListMatrix();
    else await rebuildAndRenderCanvas(fitOnFirst);
    ensureSseConnected(data.cursor);
  } catch (err) {
    if (seq !== refreshSeq) return;
    if (!(err instanceof ApiError && err.status === 401)) {
      setConnState('error', '读取失败');
    }
  }
}

async function loadMoreFlows() {
  if (!snapshot?.hasMore || snapshot.beforeSeq === undefined || authExpired || loadMoreBtn.disabled) return;
  const epoch = dbEpoch;
  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = '加载中…';
  try {
    const older = await apiGet<MindmapSnapshot>(`/api/mindmap?limit=100&before=${snapshot.beforeSeq}`);
    if (authExpired || epoch !== dbEpoch || !snapshot) return;
    const seen = new Set(loadedFlows.map(f => f.id));
    for (const f of older.flows) {
      if (!seen.has(f.id)) loadedFlows.push(f);
    }
    snapshot = {
      ...snapshot,
      flows: loadedFlows,
      sessions: mergeSessionLists(snapshot.sessions, older.sessions),
      hasMore: older.hasMore,
      beforeSeq: older.beforeSeq,
    };
    await renderSidebar();
    if (epoch !== dbEpoch) return;
    if (viewMode === 'list') await renderListMatrix();
    else await rebuildAndRenderCanvas(false);
    announceStatus(`已加载更多历史，当前共 ${formatCount(loadedFlows.length)} 条消息记录`);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) {
      setConnState('error', '加载历史失败');
    }
  } finally {
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = '加载更早的历史会话消息…';
  }
}

function ensureSseConnected(initialCursor: number) {
  sseCursor = sseStarted ? Math.max(sseCursor, initialCursor) : initialCursor;
  if (!accessToken || authExpired) return;
  if (!sseStarted) {
    sseStarted = true;
    sseHub.start(sseCursor);
  } else {
    sseHub.setCursor(sseCursor);
  }
}

/* ==================== 交互事件绑定 ==================== */

toggleSidebarBtn.setAttribute('aria-expanded', String(!workspaceEl.classList.contains('sidebar-collapsed')));
toggleSidebarBtn.addEventListener('click', () => {
  const collapsed = workspaceEl.classList.toggle('sidebar-collapsed');
  toggleSidebarBtn.setAttribute('aria-expanded', String(!collapsed));
  if (canvasResizeObserver) {
    pendingSidebarRefit = true;
  } else if (viewMode !== 'list') {
    fitWidthTop(false);
  }
});

sidebarModeSessionsBtn.setAttribute('aria-pressed', 'true');
sidebarModeTurnsBtn.setAttribute('aria-pressed', 'false');

sidebarModeSessionsBtn.addEventListener('click', () => {
  sidebarMode = 'sessions';
  sidebarModeSessionsBtn.classList.add('active');
  sidebarModeTurnsBtn.classList.remove('active');
  sidebarModeSessionsBtn.setAttribute('aria-pressed', 'true');
  sidebarModeTurnsBtn.setAttribute('aria-pressed', 'false');
  void renderSidebar(true);
});

sidebarModeTurnsBtn.addEventListener('click', () => {
  sidebarMode = 'turns';
  sidebarModeTurnsBtn.classList.add('active');
  sidebarModeSessionsBtn.classList.remove('active');
  sidebarModeTurnsBtn.setAttribute('aria-pressed', 'true');
  sidebarModeSessionsBtn.setAttribute('aria-pressed', 'false');
  void renderSidebar(true);
});

if (viewTabsEl && typeof viewTabsEl.querySelectorAll === 'function') {
  bindRovingTablist(viewTabsEl, {
    onActivate: tab => {
      const next: ViewMode = tab === viewOverviewBtn ? 'overview' : tab === viewListBtn ? 'list' : 'session';
      if (next !== viewMode) void switchViewMode(next);
    },
  });
} else {
  viewSessionBtn.addEventListener('click', () => { void switchViewMode('session'); });
  viewOverviewBtn.addEventListener('click', () => { void switchViewMode('overview'); });
  viewListBtn.addEventListener('click', () => { void switchViewMode('list'); });
}

for (const elBtn of filterPillsEl.querySelectorAll<HTMLButtonElement>('button[data-filter]')) {
  const isInitActive = (elBtn.dataset.filter ?? 'all') === filterKind;
  elBtn.setAttribute('aria-pressed', String(isInitActive));
}

filterPillsEl.addEventListener('click', ev => {
  const btn = (ev.target as HTMLElement | null)?.closest?.<HTMLButtonElement>('button[data-filter]');
  if (!btn) return;
  filterKind = (btn.dataset.filter as FilterKind) ?? 'all';
  for (const elBtn of filterPillsEl.querySelectorAll<HTMLButtonElement>('button[data-filter]')) {
    const active = elBtn === btn;
    elBtn.classList.toggle('active', active);
    elBtn.setAttribute('aria-pressed', String(active));
  }
  void applySearchOrFilterUpdate(true, true);
});

async function applySearchOrFilterUpdate(shouldFit: boolean, announceSummary: boolean): Promise<void> {
  await renderSidebar(announceSummary);
  if (viewMode === 'list') await renderListMatrix();
  else await rebuildAndRenderCanvas(shouldFit);
}

function scheduleSearchApply(immediate = false): void {
  if (searchDebounceTimer !== undefined) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = undefined;
  }
  const apply = () => {
    searchDebounceTimer = undefined;
    searchTerm = searchInput.value.trim();
    searchClearBtn.hidden = !searchTerm;
    void applySearchOrFilterUpdate(false, true);
  };
  if (immediate) {
    apply();
    return;
  }
  searchDebounceTimer = setTimeout(apply, 150);
}

searchInput.addEventListener('compositionstart', () => {
  isSearchComposing = true;
});

searchInput.addEventListener('compositionend', () => {
  isSearchComposing = false;
  scheduleSearchApply(false);
});

searchInput.addEventListener('input', ev => {
  const rawValue = searchInput.value.trim();
  searchClearBtn.hidden = !rawValue;
  if (isSearchComposing || (ev as InputEvent).isComposing) return;
  scheduleSearchApply(false);
});

searchInput.addEventListener('keydown', ev => {
  const ke = ev as KeyboardEvent;
  if (ke.key !== 'Enter') return;
  if (isImeComposing(ke) || isSearchComposing) return;
  ke.preventDefault();
  scheduleSearchApply(true);
});

searchClearBtn.addEventListener('click', () => {
  if (searchDebounceTimer !== undefined) {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = undefined;
  }
  isSearchComposing = false;
  searchInput.value = '';
  searchTerm = '';
  searchClearBtn.hidden = true;
  void applySearchOrFilterUpdate(true, true);
  safeFocus(searchInput, { preventScroll: true });
});

expandAllBtn.addEventListener('click', () => {
  if (!currentGraph) return;
  for (const frame of currentGraph.frames) {
    if (frame.toggleKey) collapseOverride.set(frame.toggleKey, false);
  }
  for (const node of currentGraph.nodes) {
    if (node.toggleKey) collapseOverride.set(node.toggleKey, false);
  }
  announceStatus('已展开当前流程图全部折叠节点');
  void rebuildAndRenderCanvas(false);
});

collapseAllBtn.addEventListener('click', () => {
  if (!currentGraph) return;
  for (const frame of currentGraph.frames) {
    if (frame.toggleKey) collapseOverride.set(frame.toggleKey, true);
  }
  for (const node of currentGraph.nodes) {
    if (node.toggleKey && node.kind !== 'worker_more') collapseOverride.set(node.toggleKey, true);
  }
  announceStatus('已收起至流程主干视图');
  void rebuildAndRenderCanvas(true);
});

function zoomAroundCenter(factor: number, announce = false) {
  const baseZoom = viewportAnimRaf ? viewportTargetZoom : zoom;
  const basePanX = viewportAnimRaf ? viewportTargetPanX : panX;
  const basePanY = viewportAnimRaf ? viewportTargetPanY : panY;
  const nextZoom = Math.max(0.25, Math.min(2.2, baseZoom * factor));
  const rect = svgElRoot.getBoundingClientRect();
  if (rect.width && rect.height) {
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const scaleChange = nextZoom / baseZoom;
    animateViewportTo(
      cx - (cx - basePanX) * scaleChange,
      cy - (cy - basePanY) * scaleChange,
      nextZoom,
      320,
    );
  } else {
    animateViewportTo(basePanX, basePanY, nextZoom, 320);
  }
  if (announce) {
    announceStatus(`画布缩放至 ${Math.round(nextZoom * 100)}%`);
  }
}

zoomOutBtn.addEventListener('click', () => zoomAroundCenter(0.85, true));
zoomInBtn.addEventListener('click', () => zoomAroundCenter(1.18, true));
fitWidthBtn.addEventListener('click', () => {
  fitWidthTop(true);
  announceStatus(`画布已适宽置顶 (${Math.round(viewportTargetZoom * 100)}%)`);
});
fitBtn.addEventListener('click', () => {
  fitToCanvas(true);
  announceStatus(`画布已适应全图 (${Math.round(viewportTargetZoom * 100)}%)`);
});
refreshBtn.addEventListener('click', () => { void refreshMindmap(false); });
loadMoreBtn.addEventListener('click', () => { void loadMoreFlows(); });

svgElRoot.addEventListener('keydown', ev => {
  const ke = ev as KeyboardEvent;
  if (ke.ctrlKey || ke.metaKey || ke.altKey) return;
  const onCanvasRoot = ke.target === svgElRoot || ke.target === viewportEl;
  const step = ke.shiftKey ? 120 : 60;

  if (onCanvasRoot) {
    if (ke.key === 'ArrowUp') {
      ke.preventDefault();
      cancelViewportAnimation();
      panY += step;
      scheduleViewportRender();
      announceStatus('画布向上平移');
      return;
    }
    if (ke.key === 'ArrowDown') {
      ke.preventDefault();
      cancelViewportAnimation();
      panY -= step;
      scheduleViewportRender();
      announceStatus('画布向下平移');
      return;
    }
    if (ke.key === 'ArrowLeft') {
      ke.preventDefault();
      cancelViewportAnimation();
      panX += step;
      scheduleViewportRender();
      announceStatus('画布向左平移');
      return;
    }
    if (ke.key === 'ArrowRight') {
      ke.preventDefault();
      cancelViewportAnimation();
      panX -= step;
      scheduleViewportRender();
      announceStatus('画布向右平移');
      return;
    }
  }

  if (ke.key === '+' || ke.key === '=') {
    ke.preventDefault();
    zoomAroundCenter(1.18, true);
  } else if (ke.key === '-' || ke.key === '_') {
    ke.preventDefault();
    zoomAroundCenter(0.85, true);
  } else if (ke.key === '0') {
    ke.preventDefault();
    fitWidthTop(true);
    announceStatus(`画布视图已重置 (${Math.round(viewportTargetZoom * 100)}%)`);
  }
});

svgElRoot.addEventListener('click', ev => {
  if (suppressNextClick && nowMs() - lastDragEndedAt < 400) {
    suppressNextClick = false;
    ev.preventDefault();
    ev.stopPropagation();
    return;
  }
  suppressNextClick = false;
}, true);

function resetPointerDragState(): void {
  activePointers.clear();
  isDragging = false;
  dragMoved = false;
  pinchStartDist = 0;
  svgElRoot.classList?.remove('dragging');
}

function finishPointerInteraction(ev: PointerEvent, isCancel: boolean): void {
  const pointerId = ev.pointerId ?? 0;
  const hadPointer = activePointers.delete(pointerId);
  try {
    if (svgElRoot.hasPointerCapture?.(pointerId)) {
      svgElRoot.releasePointerCapture?.(pointerId);
    }
  } catch {
    // Ignore pointer capture release errors on synthetic events
  }
  if (!hadPointer && activePointers.size === 0) return;

  if (activePointers.size === 1) {
    const remaining = activePointers.values().next().value;
    if (remaining) {
      dragStartX = remaining.x;
      dragStartY = remaining.y;
      dragPanStartX = panX;
      dragPanStartY = panY;
      isDragging = true;
    }
    pinchStartDist = 0;
    return;
  }

  if (activePointers.size === 0) {
    if (dragMoved && !isCancel) {
      suppressNextClick = true;
      lastDragEndedAt = nowMs();
    } else {
      suppressNextClick = false;
    }
    resetPointerDragState();
  }
}

svgElRoot.addEventListener('pointerdown', ev => {
  const pe = ev as PointerEvent;
  if (pe.pointerType === 'mouse' && pe.button !== 0) return;
  if (typeof pe.button === 'number' && pe.button > 0) return;

  cancelViewportAnimation();
  suppressNextClick = false;
  const pointerId = pe.pointerId ?? 0;
  activePointers.set(pointerId, { x: pe.clientX, y: pe.clientY });

  const targetClosest = (pe.target as { closest?: (sel: string) => unknown } | null)?.closest?.bind(pe.target);
  const hitInteractiveChild = Boolean(targetClosest?.('.mm-node-hit, .fc-frame-hit, .mm-toggle-btn'));

  if (activePointers.size === 1) {
    isDragging = true;
    dragMoved = false;
    dragStartX = pe.clientX;
    dragStartY = pe.clientY;
    dragPanStartX = panX;
    dragPanStartY = panY;
    if (!hitInteractiveChild) {
      try { svgElRoot.setPointerCapture?.(pointerId); } catch {}
    }
  } else if (activePointers.size === 2) {
    dragMoved = true;
    svgElRoot.classList?.add('dragging');
    for (const pid of activePointers.keys()) {
      try {
        if (!svgElRoot.hasPointerCapture?.(pid)) svgElRoot.setPointerCapture?.(pid);
      } catch {}
    }
    const pts = Array.from(activePointers.values());
    const p1 = pts[0]!;
    const p2 = pts[1]!;
    const rect = svgElRoot.getBoundingClientRect();
    pinchStartDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    pinchStartMidX = (p1.x + p2.x) / 2 - rect.left;
    pinchStartMidY = (p1.y + p2.y) / 2 - rect.top;
    pinchStartZoom = zoom;
    pinchStartPanX = panX;
    pinchStartPanY = panY;
  }
});

svgElRoot.addEventListener('pointermove', ev => {
  const pe = ev as PointerEvent;
  const pointerId = pe.pointerId ?? 0;
  if (!activePointers.has(pointerId)) return;
  activePointers.set(pointerId, { x: pe.clientX, y: pe.clientY });

  if (activePointers.size >= 2 && pinchStartDist > 0) {
    const pts = Array.from(activePointers.values());
    const p1 = pts[0]!;
    const p2 = pts[1]!;
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (dist <= 0) return;
    const rect = svgElRoot.getBoundingClientRect();
    const midX = (p1.x + p2.x) / 2 - rect.left;
    const midY = (p1.y + p2.y) / 2 - rect.top;
    const nextZoom = Math.max(0.22, Math.min(2.4, pinchStartZoom * (dist / pinchStartDist)));
    const worldX = (pinchStartMidX - pinchStartPanX) / pinchStartZoom;
    const worldY = (pinchStartMidY - pinchStartPanY) / pinchStartZoom;
    panX = midX - worldX * nextZoom;
    panY = midY - worldY * nextZoom;
    zoom = nextZoom;
    scheduleViewportRender();
    return;
  }

  if (!isDragging) return;
  const dx = pe.clientX - dragStartX;
  const dy = pe.clientY - dragStartY;
  if (!dragMoved && Math.hypot(dx, dy) >= 4) {
    dragMoved = true;
    svgElRoot.classList?.add('dragging');
    try {
      if (!svgElRoot.hasPointerCapture?.(pointerId)) svgElRoot.setPointerCapture?.(pointerId);
    } catch {}
  }
  if (dragMoved) {
    panX = dragPanStartX + dx;
    panY = dragPanStartY + dy;
    scheduleViewportRender();
  }
});

svgElRoot.addEventListener('pointerup', ev => finishPointerInteraction(ev as PointerEvent, false));
svgElRoot.addEventListener('pointercancel', ev => finishPointerInteraction(ev as PointerEvent, true));
svgElRoot.addEventListener('lostpointercapture', ev => finishPointerInteraction(ev as PointerEvent, true));

window.addEventListener('blur', () => {
  suppressNextClick = false;
  resetPointerDragState();
});

svgElRoot.addEventListener('wheel', ev => {
  ev.preventDefault();
  cancelViewportAnimation();
  const rect = svgElRoot.getBoundingClientRect();
  const containerHeight = rect.height > 0 ? rect.height : 600;
  const scaleMultiplier = ev.deltaMode === DOM_DELTA_LINE
    ? 16
    : ev.deltaMode === DOM_DELTA_PAGE
      ? containerHeight
      : 1;
  const deltaX = ev.deltaX * scaleMultiplier;
  const deltaY = ev.deltaY * scaleMultiplier;

  if (ev.ctrlKey || ev.metaKey) {
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const clampedY = Math.max(-120, Math.min(120, deltaY));
    if (clampedY !== 0) {
      const factor = clampedY < 0
        ? Math.min(1.25, 1 + (-clampedY / 450))
        : Math.max(0.8, 1 - (clampedY / 500));
      const nextZoom = Math.max(0.22, Math.min(2.4, zoom * factor));
      const scaleChange = nextZoom / zoom;
      panX = mx - (mx - panX) * scaleChange;
      panY = my - (my - panY) * scaleChange;
      zoom = nextZoom;
    }
  } else {
    panX -= deltaX;
    panY -= deltaY;
  }
  scheduleViewportRender();
}, { passive: false });

if (!accessToken) {
  authBannerEl.hidden = false;
  setConnState('error', '未携带访问令牌');
} else {
  void refreshMindmap(true);
}

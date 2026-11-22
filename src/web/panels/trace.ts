import type { ChatMessage, TraceEvent, WorkView } from '../../view.js';
import { activeStatus as active, mergeTraceWindow, record } from '../model.js';
import { button, element, node } from '../shared/dom.js';
import { errorText, formatNumber, profileBadges, statusText, tierBadges, timestamp } from '../shared/format.js';
import { collapseRightDrawer, ensureRightDrawerOpen } from '../shared/theme.js';
import {
  copyTextWithFeedback,
  prefersReducedMotion,
  safeFocus,
  setInertElements,
  yieldToMain,
} from '../shared/ui-primitives.js';
import { api, appState, hooks, type Selection } from '../state.js';
import {
  buildExecutionChain,
  buildFallbackBundleFromAppState,
  extractReadableOperationOutput,
  type ChainActionNode,
  type ChainCategory,
  type ChainParamItem,
  type ExecutionChainView,
  type ExecutionTraceBundle,
  type ExecutionTraceMemoryBrief,
  type ExecutionTraceTaskSummary,
} from '../trace-chain.js';

export interface TracePanelController {
  renderWorks: () => void;
  stopWork: (target?: string) => Promise<void>;
  showPanel: (trace: boolean, opts?: { restoreFocus?: boolean }) => void;
  isTraceVisible: () => boolean;
  closeSidebar: (restoreFocus?: boolean) => void;
  isSidebarOpen: () => boolean;
  focusSidebarToggle: () => void;
  selectTrace: (next: Selection, pin?: boolean) => void;
  loadTrace: (direction?: 'live' | 'earlier' | 'recent') => Promise<void>;
  loadWork: (id: string, generation: number, background?: boolean) => Promise<void>;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHAIN_CHUNK_SIZE = 80;
const CHAIN_SYNC_THRESHOLD = 120;

const zhClockFormatter = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function'
  ? new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
  : undefined;

interface DurationFormatLike {
  format(duration: { hours?: number; minutes?: number; seconds?: number }): string;
}

const DurationFormatCtor = typeof Intl !== 'undefined' && 'DurationFormat' in Intl
  ? (Intl as unknown as { DurationFormat?: new (locale: string, opts: { style: 'narrow' | 'short' | 'long' }) => DurationFormatLike }).DurationFormat
  : undefined;

const zhNarrowDurationFormatter = DurationFormatCtor
  ? new DurationFormatCtor('zh-CN', { style: 'narrow' })
  : undefined;

function formatClock(at: number): string {
  if (!Number.isFinite(at)) return '—';
  if (zhClockFormatter) return zhClockFormatter.format(at);
  return new Date(at).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatOffset(offsetMs: number): string {
  if (!Number.isFinite(offsetMs) || offsetMs <= 0) return '+0.0s';
  if (offsetMs < 60_000) return `+${(offsetMs / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(offsetMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return `+${mins}m${secs.toString().padStart(2, '0')}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `+${hours}h${remMins.toString().padStart(2, '0')}m`;
}

function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const totalSec = Math.round(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) {
    if (zhNarrowDurationFormatter) {
      return zhNarrowDurationFormatter.format(secs ? { minutes: mins, seconds: secs } : { minutes: mins });
    }
    return secs ? `${mins}m${secs}s` : `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (zhNarrowDurationFormatter) {
    return zhNarrowDurationFormatter.format(remMins ? { hours, minutes: remMins } : { hours });
  }
  return remMins ? `${hours}h${remMins}m` : `${hours}h`;
}

function formatTokens(count?: number): string {
  if (count === undefined || !Number.isFinite(count)) return '0';
  return formatNumber(count);
}

function statusTone(status: string, hasPendingQuestion = false): ChainActionNode['tone'] {
  if (hasPendingQuestion || status === 'paused' || status === 'waiting_decision' || status === 'interrupted') {
    return 'warn';
  }
  if (status === 'failed' || status === 'cancelled' || status === 'stopped' || status === 'unknown') {
    return 'err';
  }
  if (active(status)) return 'run';
  if (status === 'completed' || status === 'succeeded' || status === 'accepted' || status === 'done') {
    return 'ok';
  }
  return 'neutral';
}

function isNarrowViewport(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 767px)').matches;
}

function isMobileTraceViewport(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 730px)').matches;
}

function isSidebarDrawerViewport(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 1100px)').matches;
}

function runWithViewTransition(updateDom: () => void, afterFinish?: () => void): void {
  const docWithVt = typeof document !== 'undefined'
    ? (document as Document & {
        startViewTransition?: (cb: () => void) => {
          ready?: Promise<void>;
          updateCallbackDone?: Promise<void>;
          finished?: Promise<void>;
        };
      })
    : undefined;
  if (docWithVt && typeof docWithVt.startViewTransition === 'function' && !prefersReducedMotion()) {
    try {
      const vt = docWithVt.startViewTransition(updateDom);
      if (vt?.ready && typeof vt.ready.catch === 'function') {
        void vt.ready.catch(() => {});
      }
      if (vt?.updateCallbackDone && typeof vt.updateCallbackDone.catch === 'function') {
        void vt.updateCallbackDone.catch(() => {});
      }
      if (vt?.finished && typeof vt.finished.then === 'function') {
        void (afterFinish ? vt.finished.then(afterFinish, afterFinish) : vt.finished.catch(() => {}));
      } else {
        afterFinish?.();
      }
      return;
    } catch {
      // Fall back to direct DOM update if transition is skipped/unavailable
    }
  }
  updateDom();
  afterFinish?.();
}

function createCopyButton(label: string, textToCopy: string, ariaLabel?: string): HTMLElement {
  const wrap = node('span', '', 'md-copy-wrap');
  const btn = node('button', label, 'copy-mini-btn mini-button');
  btn.type = 'button';
  btn.setAttribute('aria-label', ariaLabel ?? label);
  const statusEl = node('span', '', 'md-copy-status visually-hidden');
  statusEl.setAttribute('role', 'status');
  btn.addEventListener('click', () => {
    void copyTextWithFeedback(btn, textToCopy, { statusEl });
  });
  wrap.append(btn, statusEl);
  return wrap;
}

function createCodePreBlock(text: string, className: string, ariaLabel: string): HTMLPreElement {
  const pre = node('pre', '', className);
  pre.setAttribute('tabindex', '0');
  pre.setAttribute('role', 'region');
  pre.setAttribute('aria-label', ariaLabel);
  pre.append(node('code', text));
  return pre;
}

function createWaterfallBar(
  startPermille: number,
  widthPermille: number,
  tone: ChainActionNode['tone'],
): HTMLElement | SVGElement {
  const start = Math.max(0, Math.min(982, Math.round(startPermille)));
  const width = Math.max(18, Math.min(1000 - start, Math.round(widthPermille)));
  if (typeof document.createElementNS !== 'function') {
    const fallback = node('span', '', `chain-waterfall chain-waterfall-fallback tone-${tone}`);
    fallback.setAttribute('aria-hidden', 'true');
    return fallback;
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'chain-waterfall');
  svg.setAttribute('viewBox', '0 0 1000 6');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(SVG_NS, 'rect');
  track.setAttribute('x', '0');
  track.setAttribute('y', '0');
  track.setAttribute('width', '1000');
  track.setAttribute('height', '6');
  track.setAttribute('rx', '3');
  track.setAttribute('class', 'wf-track');
  const bar = document.createElementNS(SVG_NS, 'rect');
  bar.setAttribute('x', String(start));
  bar.setAttribute('y', '0');
  bar.setAttribute('width', String(width));
  bar.setAttribute('height', '6');
  bar.setAttribute('rx', '3');
  bar.setAttribute('class', `wf-bar tone-${tone}`);
  svg.append(track, bar);
  return svg;
}

function pickSmartDefaultNode(nodes: readonly ChainActionNode[]): ChainActionNode | undefined {
  if (!nodes.length) return undefined;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const candidate = nodes[i]!;
    if (candidate.tone === 'run' || active(candidate.status)) return candidate;
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    const candidate = nodes[i]!;
    if (candidate.tone === 'err') return candidate;
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    const candidate = nodes[i]!;
    if (candidate.category === 'tool' || candidate.category === 'llm') return candidate;
  }
  return nodes.at(-1);
}

function asTaskSummary(value: unknown): Partial<ExecutionTraceTaskSummary> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Partial<ExecutionTraceTaskSummary>;
}

function asExecutionBundle(value: unknown): ExecutionTraceBundle | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ExecutionTraceBundle>;
  if (!Array.isArray(candidate.events) || !candidate.scope) return undefined;
  return candidate as ExecutionTraceBundle;
}

/**
 * Initializes the background-work sidebar and Execution Chain Studio panel.
 */
export function initTracePanel(): TracePanelController {
  const worksEl = element('works');
  const workFilterEl = element<HTMLSelectElement>('work-filter');
  const sidebarEl = element('work-sidebar');
  const workToggleBtn = element<HTMLButtonElement>('work-toggle');
  const panelsEl = element('panels');
  const showChatBtn = element<HTMLButtonElement>('show-chat');
  const showTraceBtn = element<HTMLButtonElement>('show-trace');
  const traceScopeEl = element('trace-scope');
  const traceContentEl = element('trace-content');
  const traceMoreBtn = element<HTMLButtonElement>('trace-more');
  const traceErrorEl = element('trace-error');
  const traceRetryBtn = element<HTMLButtonElement>('trace-retry');
  const graphModeBtn = element<HTMLButtonElement>('graph-mode');
  const timelineModeBtn = element<HTMLButtonElement>('timeline-mode');
  const stepModeBtn = element<HTMLButtonElement>('step-mode');
  const eventDetailEl = element('event-detail');
  const workDetailEl = element('work-detail');
  const clearFilterBtn = element('clear-filter');

  const traceWideToggleBtn = document.getElementById('trace-wide-toggle') as HTMLButtonElement | null;
  const traceCloseBtn = document.getElementById('trace-close-btn') as HTMLButtonElement | null;
  const filterMsgBtn = document.getElementById('filter-msg-mode') as HTMLButtonElement | null;
  const filterRouteBtn = document.getElementById('filter-route-mode') as HTMLButtonElement | null;
  const mobileTraceBtn = document.getElementById('mobile-trace-btn') as HTMLButtonElement | null;
  const mobileTraceScrim = document.getElementById('mobile-trace-scrim');
  const mobileSidebarScrim = document.getElementById('mobile-sidebar-scrim');
  const workSidebarCloseBtn = document.getElementById('work-sidebar-close') as HTMLButtonElement | null;
  const tracePanelEl = document.getElementById('trace-panel');
  const mainContentEl = document.getElementById('main-content');
  const appTopbarEl = document.getElementById('app-topbar');
  const mobileNavBtn = document.getElementById('mobile-nav-btn') as HTMLButtonElement | null;
  const desktopTraceFoldBtn = document.getElementById('desktop-trace-fold') as HTMLButtonElement | null;
  const conversationEl = typeof document.querySelector === 'function' ? document.querySelector<HTMLElement>('.conversation') : null;
  const panelNavEl = typeof document.querySelector === 'function' ? document.querySelector<HTMLElement>('.panel-nav') : null;

  const categoryTabs: ReadonlyArray<{ cat: ChainCategory; label: string; btn: HTMLButtonElement | null }> = [
    { cat: 'all', label: '全部链路', btn: stepModeBtn },
    { cat: 'message', label: '📨 消息', btn: filterMsgBtn },
    { cat: 'llm', label: '🧠 模型调用', btn: graphModeBtn },
    { cat: 'tool', label: '🔧 工具执行', btn: timelineModeBtn },
    { cat: 'routing', label: '🧭 路由质检', btn: filterRouteBtn },
  ];

  const openWorkDocs = new Set<string>();
  let activeTracePromise: Promise<void> | undefined;
  let traceRunSeq = 0;
  let bundleRequestSeq = 0;
  let bundleRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let bundleAbort: AbortController | undefined;
  let workAbort: AbortController | undefined;
  let traceAbort: AbortController | undefined;
  let chainRenderSeq = 0;
  let userPickedNode = false;
  let userClearedSelection = false;
  let autoSelectedSource: 'none' | 'fallback' | 'bundle' = 'none';
  let lastChainView: ExecutionChainView | undefined;
  let lastInspectorNodeId: string | undefined;
  const seenChainNodeIds = new Set<string>();
  let lastChainScopeKey = '';
  let activeInspectorOperationKey: string | undefined;
  let lastSidebarTrigger: HTMLElement | null = null;
  let lastTraceTrigger: HTMLElement | null = null;

  function focusInspectorHeading(): void {
    const titleEl = eventDetailEl.querySelector?.('h3.inspector-title') as HTMLElement | null | undefined;
    if (titleEl) {
      if (!titleEl.hasAttribute?.('tabindex')) titleEl.setAttribute?.('tabindex', '-1');
      safeFocus(titleEl);
    }
  }

  function focusChainCard(nodeId?: string): void {
    const cards = Array.from(traceContentEl.querySelectorAll?.('.chain-card') ?? []) as HTMLElement[];
    const match = (nodeId ? cards.find(card => card.dataset?.nodeId === nodeId) : undefined) ?? cards[0];
    if (match) {
      safeFocus(match);
      return;
    }
    if (!traceContentEl.hasAttribute?.('tabindex')) traceContentEl.setAttribute?.('tabindex', '-1');
    safeFocus(traceContentEl);
  }

  function focusSidebarToggle(): void {
    if (isMobileTraceViewport() && mobileNavBtn) {
      safeFocus(mobileNavBtn);
      return;
    }
    if (lastSidebarTrigger && (!('isConnected' in lastSidebarTrigger) || lastSidebarTrigger.isConnected !== false) && !sidebarEl.contains?.(lastSidebarTrigger)) {
      safeFocus(lastSidebarTrigger);
      return;
    }
    safeFocus(workToggleBtn);
  }

  function showPanel(trace: boolean, opts?: { restoreFocus?: boolean }): void {
    const wasVisible = panelsEl.classList.contains('trace-visible');
    const mobileViewport = isMobileTraceViewport();

    if (wasVisible === trace) {
      showChatBtn.setAttribute('aria-pressed', String(!trace));
      showTraceBtn.setAttribute('aria-pressed', String(trace));
      mobileTraceBtn?.setAttribute('aria-expanded', String(trace));
      mobileTraceBtn?.classList.toggle('active', trace);
      if (!trace) {
        tracePanelEl?.removeAttribute?.('role');
        tracePanelEl?.removeAttribute?.('aria-modal');
        setInertElements([conversationEl, panelNavEl, appTopbarEl, sidebarEl], false);
      }
      return;
    }

    if (trace && mobileViewport && typeof document !== 'undefined') {
      const activeEl = document.activeElement;
      lastTraceTrigger = activeEl && typeof (activeEl as HTMLElement).focus === 'function' && !tracePanelEl?.contains?.(activeEl) && activeEl !== document.body
        ? (activeEl as HTMLElement)
        : (mobileTraceBtn ?? showTraceBtn);
    }

    const applyUpdate = () => {
      panelsEl.classList.toggle('trace-visible', trace);
      showChatBtn.setAttribute('aria-pressed', String(!trace));
      showTraceBtn.setAttribute('aria-pressed', String(trace));
      mobileTraceBtn?.setAttribute('aria-expanded', String(trace));
      mobileTraceBtn?.classList.toggle('active', trace);

      if (trace && mobileViewport) {
        tracePanelEl?.setAttribute?.('role', 'dialog');
        tracePanelEl?.setAttribute?.('aria-modal', 'true');
        setInertElements([conversationEl, panelNavEl, appTopbarEl, sidebarEl], true);
      } else {
        tracePanelEl?.removeAttribute?.('role');
        tracePanelEl?.removeAttribute?.('aria-modal');
        setInertElements([conversationEl, panelNavEl, appTopbarEl, sidebarEl], false);
      }
    };

    const afterFinish = () => {
      if (trace && mobileViewport) {
        safeFocus(traceCloseBtn ?? clearFilterBtn);
      } else if (!trace && mobileViewport) {
        const trigger = lastTraceTrigger;
        lastTraceTrigger = null;
        if (opts?.restoreFocus !== false) {
          const target = trigger && (!('isConnected' in trigger) || trigger.isConnected !== false) && !tracePanelEl?.contains?.(trigger)
            ? trigger
            : (mobileTraceBtn ?? showTraceBtn);
          safeFocus(target);
        }
      } else if (!trace) {
        lastTraceTrigger = null;
      }
    };

    if (mobileViewport) {
      runWithViewTransition(applyUpdate, afterFinish);
    } else {
      applyUpdate();
    }
  }

  function setSidebarOpen(open: boolean, restoreFocus = true): void {
    const isOpen = sidebarEl.classList.contains('open');
    if (open === isOpen) return;

    if (open && typeof document !== 'undefined') {
      const activeEl = document.activeElement;
      lastSidebarTrigger = activeEl && typeof (activeEl as HTMLElement).focus === 'function' && !sidebarEl.contains?.(activeEl) && activeEl !== document.body
        ? (activeEl as HTMLElement)
        : workToggleBtn;
    }

    sidebarEl.classList.toggle('open', open);
    workToggleBtn.setAttribute('aria-expanded', String(open));
    if (mobileSidebarScrim) mobileSidebarScrim.hidden = !open;

    if (open) {
      sidebarEl.setAttribute?.('role', 'dialog');
      sidebarEl.setAttribute?.('aria-modal', 'true');
      if (isSidebarDrawerViewport()) {
        setInertElements([mainContentEl, appTopbarEl], true);
      }
      safeFocus(workFilterEl);
    } else {
      sidebarEl.removeAttribute?.('role');
      sidebarEl.removeAttribute?.('aria-modal');
      setInertElements([mainContentEl, appTopbarEl], false);
      if (restoreFocus) {
        focusSidebarToggle();
      }
      lastSidebarTrigger = null;
    }
  }

  function closeSidebar(restoreFocus = true): void {
    setSidebarOpen(false, restoreFocus);
  }

  function syncWideToggle(): void {
    panelsEl.classList.toggle('trace-wide', appState.traceWide);
    if (traceWideToggleBtn) {
      traceWideToggleBtn.classList.toggle('active', appState.traceWide);
      traceWideToggleBtn.setAttribute('aria-pressed', String(appState.traceWide));
      traceWideToggleBtn.textContent = appState.traceWide ? '⤡ 退出宽屏' : '⤢ 宽屏双栏';
    }
  }

  function syncCategoryTabs(stats?: ExecutionChainView['stats']): void {
    for (const { cat, label, btn } of categoryTabs) {
      if (!btn) continue;
      const isActive = appState.traceCategory === cat;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
      if (stats) {
        const count = cat === 'all' ? stats.total : stats[cat];
        btn.replaceChildren(node('span', label), node('span', String(count), 'trace-tab-count'));
      } else {
        btn.textContent = label;
      }
    }
  }

  function syncTraceMore(): void {
    traceMoreBtn.hidden = !appState.traceHasEarlier && !appState.traceHasMore;
    traceMoreBtn.textContent = appState.traceHasEarlier ? '加载更早记录' : '加载更多事件';
  }

  function currentActiveBundle(): ExecutionTraceBundle {
    const loaded = asExecutionBundle(appState.traceBundle);
    if (loaded) return loaded;
    const works = (appState.view?.works ?? []) as WorkView[];
    const messages = [...appState.messages.values()] as ChatMessage[];
    return buildFallbackBundleFromAppState({
      selection: appState.selection,
      events: appState.traceEvents,
      messages,
      works,
      workData: appState.workData,
      traceAfter: appState.traceAfter,
    });
  }

  function scheduleExecutionBundleRefresh(): void {
    if (bundleRefreshTimer || !appState.ready || appState.authExpired) return;
    bundleRefreshTimer = setTimeout(() => {
      bundleRefreshTimer = undefined;
      void loadExecutionBundle(true);
    }, 240);
  }

  async function loadExecutionBundle(background = false): Promise<void> {
    if (!appState.ready || appState.authExpired) return;
    const generation = appState.selectionGeneration;
    const reqSeq = ++bundleRequestSeq;
    bundleAbort?.abort();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    bundleAbort = ac;
    const params = new URLSearchParams();
    if (appState.selection.type === 'task') params.set('taskId', appState.selection.id);
    else if (appState.selection.type === 'message') params.set('messageId', appState.selection.id);
    try {
      const query = params.toString();
      const useLowPriority = background || !appState.selectionPinned;
      const bundle = await api<ExecutionTraceBundle>(
        `/api/execution-trace${query ? `?${query}` : ''}`,
        undefined,
        {
          ...(ac ? { signal: ac.signal } : {}),
          ...(useLowPriority ? { priority: 'low' as const } : {}),
        },
      );
      if (generation !== appState.selectionGeneration || reqSeq !== bundleRequestSeq || ac?.signal.aborted) return;
      appState.traceBundle = bundle;
      renderTrace();
    } catch {
      if (generation !== appState.selectionGeneration || reqSeq !== bundleRequestSeq || ac?.signal.aborted) return;
      if (!background) {
        renderTrace();
      }
    }
  }

  async function loadOperationOutput(
    taskId: string,
    operationId: string,
    cacheKey: string,
    generation: number,
  ): Promise<void> {
    if (!appState.ready || appState.authExpired) return;
    if (appState.operationTextCache.size >= 200) {
      for (const [k, v] of appState.operationTextCache) {
        if (!v.loading) {
          appState.operationTextCache.delete(k);
          if (appState.operationTextCache.size < 200) break;
        }
      }
    }
    appState.operationTextCache.set(cacheKey, { loading: true });
    try {
      const raw = await api<unknown>(
        `/api/operation?${new URLSearchParams({ taskId, operationId })}`,
        undefined,
        { priority: 'low' },
      );
      const extracted = extractReadableOperationOutput(raw);
      appState.operationTextCache.set(cacheKey, {
        loading: false,
        text: extracted.text,
        error: extracted.error,
      });
    } catch (error) {
      appState.operationTextCache.set(cacheKey, {
        loading: false,
        error: errorText(error),
      });
    }
    if (generation === appState.selectionGeneration || activeInspectorOperationKey === cacheKey) {
      renderTrace();
    }
  }

  function selectNodeById(nodeId: string, ensureVisible = false, focusHeading = true): void {
    appState.selectedNodeId = nodeId;
    userPickedNode = true;
    userClearedSelection = false;
    if (ensureVisible && lastChainView) {
      const target = lastChainView.nodes.find(item => item.id === nodeId);
      if (target && appState.traceCategory !== 'all' && appState.traceCategory !== target.category) {
        appState.traceCategory = 'all';
      }
    }
    runWithViewTransition(
      () => renderTrace(),
      focusHeading ? focusInspectorHeading : undefined,
    );
  }

  function renderWorks(): void {
    const filter = workFilterEl.value;
    const works = (appState.view?.works ?? []).filter(
      work => filter === 'all' || (filter === 'active' ? active(work.status) : !active(work.status)),
    );
    const contents = document.createDocumentFragment();
    for (const work of works) {
      const selected = appState.selection.type === 'task' && appState.selection.id === work.id;
      const entry = node('div', '', `work-row${selected ? ' selected' : ''}`);

      const mainBtn = node('button', '', 'work-row-main');
      mainBtn.type = 'button';
      mainBtn.setAttribute('aria-pressed', String(selected));
      mainBtn.title = work.prompt;
      mainBtn.addEventListener('click', () => {
        selectTrace({ type: 'task', id: work.id, label: work.prompt });
        closeSidebar(false);
        showPanel(true);
      });
      mainBtn.append(node('span', work.prompt || '后台工作', 'work-title'));
      const modelLabel = work.workerModel
        ? `${work.workerModel}${work.thinkingLevel ? `@${work.thinkingLevel}` : ''}`
        : (work.modelTier ? (tierBadges[work.modelTier] ?? work.modelTier) : undefined);
      const initiatorPrefix = work.initiator?.kind === 'timer'
        ? `⏱ 定时${work.initiator.label ? `(${work.initiator.label})` : ''} · `
        : '';
      const profilePrefix = (work.profile || modelLabel)
        ? `${profileBadges[work.profile ?? 'general'] ?? (work.profile || '子 AI')}${modelLabel ? ` (${modelLabel})` : ''} · `
        : '';
      const statusLabel = work.pendingQuestion ? '⏳ 等待拍板' : statusText(work.status);
      mainBtn.append(node('span', `${initiatorPrefix}${profilePrefix}${statusLabel} · ${timestamp(work.createdAt)}`, `meta${active(work.status) ? ' running' : ''}`));
      entry.append(mainBtn);

      if (active(work.status)) {
        const requested = appState.stopRequests.has(`task:${work.id}`);
        const workLabel = (work.prompt || '后台工作').replace(/\s+/g, ' ').trim().slice(0, 28);
        const stopBtn = node('button', requested ? '停止中…' : '■ 停止', 'work-stop-btn mini-button danger-btn');
        stopBtn.type = 'button';
        stopBtn.disabled = requested || appState.authExpired;
        stopBtn.title = requested ? '已请求停止，等待结算' : '停止该任务';
        stopBtn.setAttribute('aria-label', requested ? `正在请求停止工作：${workLabel}` : `停止工作：${workLabel}`);
        stopBtn.addEventListener('click', () => {
          void stopWork(work.id);
        });
        entry.append(stopBtn);
      }

      contents.append(entry);
    }
    if (!works.length) contents.append(node('p', appState.view ? '暂无符合筛选的后台工作。' : '尚未读取后台工作。', 'empty'));
    worksEl.replaceChildren(contents);
  }

  function makeDocDetails(key: string, summaryText: string, defaultOpen = false): HTMLDetailsElement {
    const details = node('details', '', 'work-doc-details');
    details.open = openWorkDocs.has(key) || defaultOpen;
    details.addEventListener('toggle', () => {
      if (details.open) openWorkDocs.add(key);
      else openWorkDocs.delete(key);
    });
    details.append(node('summary', summaryText));
    return details;
  }

  function renderWorkDetail(chainView?: ExecutionChainView): void {
    workDetailEl.hidden = appState.selection.type !== 'task';
    if (appState.selection.type !== 'task') return;

    const taskId = appState.selection.id;
    const generation = appState.selectionGeneration;
    const bundle = asExecutionBundle(appState.traceBundle);
    const bundleTask = bundle?.scope.type === 'task' && bundle.scope.id === taskId ? bundle.task : undefined;
    const workDataRec = appState.workData ? record(appState.workData) : undefined;
    const workObj = asTaskSummary(appState.workData);
    const viewWork = appState.view?.works.find(item => item.id === taskId);

    const status = bundleTask?.status ?? (typeof workObj?.status === 'string' ? workObj.status : undefined) ?? viewWork?.status;
    if (!status) {
      workDetailEl.replaceChildren(node('p', '正在读取任务执行总览…', 'meta'));
      return;
    }

    const prompt = bundleTask?.prompt ?? (typeof workObj?.prompt === 'string' ? workObj.prompt : undefined) ?? viewWork?.prompt ?? appState.selection.label;
    const cwd = bundleTask?.cwd ?? (typeof workObj?.cwd === 'string' ? workObj.cwd : undefined) ?? viewWork?.cwd;
    const profile = bundleTask?.profile ?? (typeof workObj?.profile === 'string' ? workObj.profile : undefined) ?? viewWork?.profile;
    const workerModel = bundleTask?.workerModel ?? (typeof workObj?.workerModel === 'string' ? workObj.workerModel : undefined) ?? viewWork?.workerModel;
    const modelTier = bundleTask?.modelTier ?? (typeof workObj?.modelTier === 'string' ? workObj.modelTier : undefined) ?? viewWork?.modelTier;
    const thinkingLevel = bundleTask?.thinkingLevel ?? (typeof workObj?.thinkingLevel === 'string' ? workObj.thinkingLevel : undefined) ?? viewWork?.thinkingLevel;
    const decisionSource = bundleTask?.decisionSource ?? (typeof workObj?.decisionSource === 'string' ? workObj.decisionSource : undefined) ?? viewWork?.decisionSource;
    const skipQualityGate = bundleTask?.skipQualityGate ?? workObj?.skipQualityGate ?? viewWork?.skipQualityGate;
    const qualityGate = bundleTask?.qualityGate
      ?? (workDataRec?.qualityGate && typeof workDataRec.qualityGate === 'object' ? record(workDataRec.qualityGate) : undefined)
      ?? (viewWork?.qualityGate as Record<string, unknown> | undefined);
    const activeMs = bundleTask?.activeMs ?? (typeof workObj?.activeMs === 'number' ? workObj.activeMs : undefined) ?? viewWork?.activeMs;
    const limitMs = bundleTask?.limitMs ?? (typeof workObj?.limitMs === 'number' ? workObj.limitMs : undefined) ?? viewWork?.limitMs;
    const pendingQuestion = bundleTask?.pendingQuestion ?? workObj?.pendingQuestion ?? viewWork?.pendingQuestion;
    const reason = bundleTask?.reason ?? (typeof workObj?.reason === 'string' ? workObj.reason : undefined) ?? viewWork?.reason;
    const report = bundleTask?.report ?? (typeof workObj?.report === 'string' ? workObj.report : undefined);
    const contextBrief = bundleTask?.contextBrief ?? (typeof workObj?.contextBrief === 'string' ? workObj.contextBrief : undefined);
    const memories: ExecutionTraceMemoryBrief[] = bundleTask?.memories ?? [];
    const memoryIds = Array.isArray(workDataRec?.memoryIds) ? workDataRec.memoryIds.map(String) : [];
    const followups = bundleTask?.followups ?? (Array.isArray(workObj?.followups) ? workObj.followups : []);

    const frag = document.createDocumentFragment();

    // Header row
    const head = node('div', '', 'work-overview-head');
    const titleWrap = node('div', '', 'work-overview-title');
    titleWrap.append(node('h3', prompt || '后台工作'));
    if (cwd) {
      titleWrap.append(node('p', cwd, 'meta work-overview-cwd'));
    }

    const actions = node('div', '', 'work-overview-actions');
    if (status === 'paused') {
      const resumeBtn = button('确认继续运行此工作', () => {
        resumeBtn.disabled = true;
        void api<unknown>('/api/resume', { taskId }).then(updated => {
          if (generation === appState.selectionGeneration) {
            appState.workData = updated;
            renderWorkDetail(lastChainView);
            void loadExecutionBundle(true);
          }
          hooks.connection('已确认恢复运行工作。');
          hooks.scheduleRefresh();
        }).catch(error => {
          resumeBtn.disabled = false;
          hooks.connection(`恢复工作失败：${errorText(error)}`, true);
        });
      }, 'mini-button');
      actions.append(resumeBtn);
    }
    if (active(status)) {
      const requested = appState.stopRequests.has(`task:${taskId}`);
      const stopBtn = button(requested ? '停止中…' : '■ 停止', () => {
        void stopWork(taskId);
      }, 'mini-button danger-btn');
      stopBtn.disabled = requested || appState.authExpired;
      stopBtn.setAttribute('aria-label', requested ? `正在请求停止：${prompt || '当前任务'}` : `停止任务：${prompt || '当前任务'}`);
      actions.append(stopBtn);
    }
    const refreshBtn = button('🔄 刷新', () => {
      void loadWork(taskId, generation);
      void loadExecutionBundle();
    }, 'mini-button');
    refreshBtn.setAttribute('aria-label', `刷新任务详情：${prompt || '当前任务'}`);
    actions.append(refreshBtn);

    head.append(titleWrap, actions);
    frag.append(head);

    // Metrics strip
    const strip = node('div', '', 'work-metrics-strip');
    const stTone = statusTone(status, Boolean(pendingQuestion));
    const statusLabel = pendingQuestion ? '⏳ 等待老板拍板' : statusText(status);
    strip.append(node('span', statusLabel, `work-metric-pill tone-${stTone}`));

    const profileLabel = profile ? (profileBadges[profile] ?? profile) : undefined;
    const modelLabel = workerModel
      ? `${workerModel}${thinkingLevel ? `@${thinkingLevel}` : ''}`
      : (modelTier ? (tierBadges[modelTier] ?? modelTier) : undefined);
    const jevLabel = decisionSource === 'gemini-decision-1' ? 'Jev 选模' : undefined;
    const modelPillText = [profileLabel, modelLabel, jevLabel].filter(Boolean).join(' · ');
    if (modelPillText) {
      strip.append(node('span', `🧠 ${modelPillText}`, 'work-metric-pill'));
    }

    if (activeMs !== undefined) {
      const durStr = limitMs && limitMs > 0
        ? `⏱ ${formatDuration(activeMs)} / ${formatDuration(limitMs)}`
        : `⏱ ${formatDuration(activeMs)}`;
      strip.append(node('span', durStr, 'work-metric-pill'));
    }

    if (chainView) {
      const { stats } = chainView;
      strip.append(
        node('span', `📨 消息 ${stats.message}`, 'work-metric-pill'),
        node('span', `🧠 模型调用 ${stats.llm}`, 'work-metric-pill'),
        node('span', `🔧 工具执行 ${stats.tool}`, 'work-metric-pill'),
      );
      if (stats.totalTokens > 0) {
        strip.append(node('span', `🪙 总 Token ${formatTokens(stats.totalTokens)}`, 'work-metric-pill'));
      }
    }

    if (skipQualityGate || qualityGate) {
      if (qualityGate?.skippedByRoute === true || skipQualityGate) {
        strip.append(node('span', '🎯 质检 免评直通', 'work-metric-pill tone-info'));
      } else if (qualityGate) {
        const score = typeof qualityGate.score === 'number' ? qualityGate.score.toFixed(2) : String(qualityGate.score ?? '—');
        const maxScore = typeof qualityGate.maxScore === 'number' ? qualityGate.maxScore : 3;
        const conf = typeof qualityGate.confidence === 'number' ? ` · ${Math.round(qualityGate.confidence * 100)}%` : '';
        const pass = qualityGate.shouldSupplement ? '建议补做' : '达标';
        const qgTone = qualityGate.shouldSupplement ? 'tone-warn' : 'tone-ok';
        strip.append(node('span', `🎯 质检 ${score}/${maxScore}${conf} · ${pass}`, `work-metric-pill ${qgTone}`));
      }
    }
    frag.append(strip);

    // Pending question alert
    if (pendingQuestion && typeof pendingQuestion.question === 'string') {
      const qBox = node('div', '', 'work-question-box');
      qBox.append(node('strong', '⏳ ASK_BOSS 盘中请示（不计入活跃耗时）'));
      qBox.append(node('p', pendingQuestion.question, 'work-question-text'));
      if (Array.isArray(pendingQuestion.options) && pendingQuestion.options.length) {
        const opts = node('div', '', 'token-pills');
        for (const opt of pendingQuestion.options) {
          opts.append(node('span', String(opt), 'token-pill'));
        }
        qBox.append(opts);
      }
      frag.append(qBox);
    }

    // Reason note
    if (reason) {
      frag.append(node('p', reason, 'message-reason'));
    }

    // Collapsible report (clean readable text, no raw JSON)
    if (typeof report === 'string' && report.trim()) {
      const reportDetails = makeDocDetails('report', '📄 已交付总结报告');
      const body = node('div', '', 'work-doc-body');
      body.append(node('p', report, 'work-doc-text'));
      reportDetails.append(body);
      frag.append(reportDetails);
    }

    // Background brief & mounted memories
    if ((typeof contextBrief === 'string' && contextBrief.trim()) || memories.length || memoryIds.length) {
      const memCount = memories.length || memoryIds.length;
      const title = memCount ? `🧭 背景简报 & 挂载记忆卡片 (${memCount})` : '🧭 背景简报';
      const ctxDetails = makeDocDetails('context', title);
      const body = node('div', '', 'work-doc-body');
      if (typeof contextBrief === 'string' && contextBrief.trim()) {
        body.append(node('p', contextBrief, 'work-doc-text'));
      }
      if (memories.length) {
        const list = node('div', '', 'memory-chip-list');
        for (const mem of memories) {
          const card = node('div', '', 'memory-chip-card');
          const memHead = node('div', '', 'memory-chip-head');
          memHead.append(node('strong', mem.topic || '未命名记忆', 'memory-chip-topic'));
          if (Array.isArray(mem.tags) && mem.tags.length) {
            const tagsRow = node('div', '', 'memory-chip-tags');
            for (const tag of mem.tags) {
              tagsRow.append(node('span', tag, 'memory-chip-tag'));
            }
            memHead.append(tagsRow);
          }
          card.append(memHead);
          if (mem.preview) {
            card.append(node('p', mem.preview, 'memory-chip-preview'));
          }
          list.append(card);
        }
        body.append(list);
      } else if (memoryIds.length) {
        body.append(node('p', `已挂载 ${memoryIds.length} 条记忆卡片`, 'meta'));
      }
      ctxDetails.append(body);
      frag.append(ctxDetails);
    }

    // Follow-up instructions
    if (followups.length) {
      const fDetails = makeDocDetails('followups', `💬 补充指令记录 (${followups.length})`);
      const body = node('div', '', 'work-doc-body');
      for (const item of followups) {
        const row = node('div', '', 'detail-row');
        row.append(
          node('span', item.text || '（无正文）'),
          node('span', statusText(String(item.state ?? '')), item.state === 'failed' ? 'state-failed' : 'meta'),
        );
        body.append(row);
      }
      fDetails.append(body);
      frag.append(fDetails);
    }

    workDetailEl.replaceChildren(frag);
  }

  function appendMetaCell(grid: HTMLElement, label: string, value: string): void {
    const cell = node('div', '', 'inspector-meta-cell');
    cell.append(node('span', label, 'inspector-meta-label'), node('span', value, 'inspector-meta-value'));
    grid.append(cell);
  }

  function appendSection(parent: HTMLElement, title: string): HTMLElement {
    const sec = node('section', '', 'inspector-section');
    sec.append(node('h4', title, 'inspector-section-title'));
    parent.append(sec);
    return sec;
  }

  function renderToolParams(sec: HTMLElement, params: readonly ChainParamItem[]): void {
    if (!params.length) {
      sec.append(node('p', '本工具调用未传入额外参数。', 'meta'));
      return;
    }
    const list = node('div', '', 'param-list');
    for (let i = 0; i < params.length; i++) {
      const param = params[i]!;
      const card = node('div', '', 'param-card');

      if (param.kind === 'diff_old' || param.kind === 'diff_new') {
        const next = params[i + 1];
        const block = node('div', '', 'diff-block');
        if (param.kind === 'diff_old' && next?.kind === 'diff_new') {
          card.append(node('span', '文本变更对比', 'param-label'));
          block.append(
            node('div', `- ${param.label}`, 'diff-tag-old'),
            createCodePreBlock(param.value, 'diff-old', `变更前：${param.label}`),
            node('div', `+ ${next.label}`, 'diff-tag-new'),
            createCodePreBlock(next.value, 'diff-new', `变更后：${next.label}`),
          );
          i += 1;
        } else if (param.kind === 'diff_old') {
          card.append(node('span', param.label, 'param-label'));
          block.append(createCodePreBlock(param.value, 'diff-old', `变更前：${param.label}`));
        } else {
          card.append(node('span', param.label, 'param-label'));
          block.append(createCodePreBlock(param.value, 'diff-new', `变更后：${param.label}`));
        }
        card.append(block);
        list.append(card);
        continue;
      }

      if (param.kind === 'code') {
        const head = node('div', '', 'param-head');
        head.append(node('span', param.label, 'param-label'), createCopyButton('复制', param.value, `复制参数：${param.label}`));
        card.append(head, createCodePreBlock(param.value, 'param-code', `参数代码：${param.label}`));
      } else if (param.kind === 'path') {
        card.append(node('span', param.label, 'param-label'), node('div', param.value, 'param-path'));
      } else if (param.kind === 'badge') {
        card.append(node('span', param.label, 'param-label'), node('span', param.value, 'chain-badge tone-info'));
      } else {
        card.append(node('span', param.label, 'param-label'), node('div', param.value, 'param-text'));
      }
      list.append(card);
    }
    sec.append(list);
  }

  function renderToolInspector(body: HTMLElement, selectedNode: ChainActionNode): void {
    const tool = selectedNode.toolDetail;
    if (!tool) return;

    // 1. 调用工具
    const callSec = appendSection(body, '调用工具');
    const identityRow = node('div', '', 'inspector-actions');
    identityRow.append(
      node('strong', tool.displayName, 'inspector-tool-name'),
      node('span', tool.toolName, 'chain-badge tone-info'),
      node('span', tool.categoryLabel, 'chain-badge tone-neutral'),
    );
    if (tool.exitCode !== undefined) {
      identityRow.append(node('span', `退出码 ${tool.exitCode}`, `chain-badge ${tool.exitCode === 0 ? 'tone-ok' : 'tone-err'}`));
    }
    callSec.append(identityRow);

    // 2. 使用参数
    const paramSec = appendSection(body, '使用参数');
    renderToolParams(paramSec, tool.params);

    // 3. 获取结果
    const resSec = appendSection(body, '获取结果');
    if (tool.errorText) {
      resSec.append(node('p', tool.errorText, 'error inspector-error-box'));
    }

    const opTaskId = tool.taskId ?? selectedNode.taskId ?? (appState.selection.type === 'task' ? appState.selection.id : undefined);
    const opId = tool.operationId;
    if (opId && opTaskId) {
      const cacheKey = `${opTaskId}:${opId}`;
      activeInspectorOperationKey = cacheKey;
      let cached = appState.operationTextCache.get(cacheKey);
      if (!cached && appState.ready && !appState.authExpired) {
        const generation = appState.selectionGeneration;
        void loadOperationOutput(opTaskId, opId, cacheKey, generation);
        cached = appState.operationTextCache.get(cacheKey);
      }

      if (cached?.loading) {
        resSec.append(node('p', '正在读取完整执行结果…', 'meta'));
        if (tool.resultText) {
          resSec.append(createCodePreBlock(tool.resultText, 'result-box', `${tool.displayName} 执行输出片段`));
        }
        return;
      }

      if (cached?.error) {
        const errWrap = node('div', '', 'inspector-op-error');
        errWrap.append(
          node('p', `完整结果读取失败：${cached.error}`, 'error'),
          button('重试读取', () => {
            appState.operationTextCache.delete(cacheKey);
            renderTrace();
          }, 'mini-button'),
        );
        resSec.append(errWrap);
      }

      const finalOutput = (cached?.text && cached.text.trim().length > 0) ? cached.text : tool.resultText;
      if (finalOutput) {
        const head = node('div', '', 'param-head');
        const label = cached?.text
          ? '完整执行输出'
          : (tool.resultTruncated ? '执行输出（已截取片段）' : '执行输出');
        head.append(node('span', label, 'param-label'), createCopyButton('复制结果', finalOutput, `复制${tool.displayName}${label}`));
        resSec.append(head, createCodePreBlock(finalOutput, 'result-box', `${tool.displayName} ${label}`));
        return;
      }
      if (!tool.errorText && !cached?.error) {
        resSec.append(node('p', active(selectedNode.status) ? '工具仍在执行中，等待返回结果…' : '工具已完成，无额外文本输出。', 'meta'));
      }
      return;
    }

    if (tool.resultText) {
      const head = node('div', '', 'param-head');
      head.append(
        node('span', tool.resultTruncated ? '执行输出（已截取）' : '执行输出', 'param-label'),
        createCopyButton('复制结果', tool.resultText, `复制${tool.displayName}执行输出`),
      );
      resSec.append(head, createCodePreBlock(tool.resultText, 'result-box', `${tool.displayName} 执行输出`));
    } else if (!tool.errorText) {
      resSec.append(node('p', active(selectedNode.status) ? '工具仍在执行中，等待返回结果…' : '本工具执行无文本输出。', 'meta'));
    }
  }

  function renderLlmInspector(body: HTMLElement, selectedNode: ChainActionNode, chainView: ExecutionChainView): void {
    const llm = selectedNode.llmDetail;
    if (!llm) return;

    // 1. 模型与 Token 消耗
    const modelSec = appendSection(body, '模型与 Token 消耗');
    const infoBadges = node('div', '', 'inspector-actions');
    infoBadges.append(node('strong', llm.model ?? '未记录模型', 'inspector-tool-name'));
    if (llm.provider) infoBadges.append(node('span', llm.provider, 'chain-badge tone-neutral'));
    if (llm.thinkingLevel) infoBadges.append(node('span', `思考等级 ${llm.thinkingLevel}`, 'chain-badge tone-info'));
    const stopTone = llm.stopReason === 'error' || llm.stopReason === 'aborted'
      ? 'tone-err'
      : llm.stopReason === 'length'
        ? 'tone-warn'
        : 'tone-ok';
    infoBadges.append(node('span', llm.stopReasonLabel, `chain-badge ${stopTone}`));
    modelSec.append(infoBadges);

    if (llm.usage) {
      const u = llm.usage;
      const pills = node('div', '', 'token-pills');
      if (u.input !== undefined) pills.append(node('span', `输入 ${formatTokens(u.input)}`, 'token-pill'));
      if (u.cacheRead !== undefined && u.cacheRead > 0) {
        pills.append(node('span', `缓存读取 ${formatTokens(u.cacheRead)}`, 'token-pill'));
      }
      if (u.reasoning !== undefined && u.reasoning > 0) {
        pills.append(node('span', `推理 ${formatTokens(u.reasoning)}`, 'token-pill'));
      }
      if (u.output !== undefined) pills.append(node('span', `输出 ${formatTokens(u.output)}`, 'token-pill'));
      if (u.totalTokens !== undefined) pills.append(node('span', `总计 ${formatTokens(u.totalTokens)}`, 'token-pill'));
      if (u.costUsd !== undefined && u.costUsd > 0) {
        pills.append(node('span', `估算费用 $${u.costUsd.toFixed(4)}`, 'token-pill'));
      }
      if (pills.childNodes.length) modelSec.append(pills);
    }

    if (llm.errorText) {
      modelSec.append(node('p', llm.errorText, 'error inspector-error-box'));
    }

    // 2. 输入触发上下文
    if (llm.inputContext) {
      const ctxSec = appendSection(body, '输入触发上下文');
      ctxSec.append(node('div', llm.inputContext, 'inspector-prose-card'));
    }

    // 3. 思考摘要
    if (llm.thinkingText) {
      const thinkSec = appendSection(body, '思考摘要');
      const head = node('div', '', 'param-head');
      head.append(node('span', '模型内部推理片段', 'param-label'), createCopyButton('复制', llm.thinkingText, `复制${selectedNode.title}思考摘要`));
      thinkSec.append(head, node('div', llm.thinkingText, 'inspector-text-card thinking-card'));
    }

    // 4. 本轮模型输出
    if (llm.publicText) {
      const outSec = appendSection(body, llm.publicTextTruncated ? '本轮模型输出（已截取）' : '本轮模型输出');
      const head = node('div', '', 'param-head');
      head.append(node('span', '公开文本回复', 'param-label'), createCopyButton('复制', llm.publicText, `复制${selectedNode.title}公开文本回复`));
      outSec.append(head, node('div', llm.publicText, 'inspector-prose-card'));
    }

    // 5. 本轮工具调用决策
    if (llm.toolDecisions.length) {
      const decSec = appendSection(body, `本轮工具调用决策 (${llm.toolDecisions.length})`);
      const list = node('div', '', 'tool-decision-list');
      for (const dec of llm.toolDecisions) {
        const targetNode = dec.spanId
          ? (chainView.nodes.find(n => n.id === dec.spanId) ?? chainView.nodes.find(n => n.id.endsWith(`:${dec.spanId}`)))
          : undefined;
        const btn = node('button', '', 'tool-decision-btn');
        btn.type = 'button';
        if (!targetNode) btn.disabled = true;
        const head = node('div', '', 'inspector-actions');
        head.append(
          node('strong', dec.displayName),
          node('span', dec.toolName, 'chain-badge tone-info'),
        );
        if (targetNode) {
          head.append(node('span', '跳转检视 →', 'chain-badge tone-neutral'));
        }
        btn.append(head);
        if (dec.summary) {
          btn.append(node('p', dec.summary, 'meta'));
        }
        if (targetNode) {
          btn.addEventListener('click', () => {
            selectNodeById(targetNode.id, true);
          });
        }
        list.append(btn);
      }
      decSec.append(list);
    }
  }

  function renderMessageInspector(body: HTMLElement, selectedNode: ChainActionNode): void {
    const msg = selectedNode.messageDetail;
    if (!msg) return;

    const infoSec = appendSection(body, '消息来源与归属');
    const badges = node('div', '', 'inspector-actions');
    badges.append(
      node('span', msg.channelLabel, 'chain-badge tone-info'),
      node('span', msg.senderLabel, 'chain-badge tone-neutral'),
    );
    if (msg.speakerLabel) {
      badges.append(node('span', `🎙️ ${msg.speakerLabel}`, 'chain-badge tone-ok'));
    }
    infoSec.append(badges);
    if (msg.sessionNote) {
      infoSec.append(node('div', msg.sessionNote, 'inspector-prose-card'));
    }
    const actionsRow = node('div', '', 'inspector-actions');
    actionsRow.append(button('定位到主对话', () => {
      void hooks.jumpMessage(msg.messageId);
    }, 'mini-button'));
    infoSec.append(actionsRow);

    const textSec = appendSection(body, '消息完整正文');
    const textContent = msg.text || '（无公开文本）';
    if (msg.text) {
      const head = node('div', '', 'param-head');
      head.append(node('span', '正文内容', 'param-label'), createCopyButton('复制正文', msg.text, `复制${msg.senderLabel}消息正文`));
      textSec.append(head);
    }
    textSec.append(node('div', textContent, 'inspector-prose-card'));

    if (msg.attachments.length || msg.paths.length) {
      const attSec = appendSection(body, '附件与授权路径');
      if (msg.attachments.length) {
        const list = node('div', '', 'token-pills');
        for (const att of msg.attachments) {
          list.append(node('span', `${att.name} (${att.kind} · ${statusText(att.status)})`, 'token-pill'));
        }
        attSec.append(list);
      }
      for (const path of msg.paths) {
        attSec.append(node('div', path, 'param-path'));
      }
    }
  }

  function renderRoutingInspector(body: HTMLElement, selectedNode: ChainActionNode): void {
    const rt = selectedNode.routingDetail;
    if (!rt) return;

    const summarySec = appendSection(body, rt.kindLabel || '路由与质检详情');
    if (rt.targetTaskId && (appState.selection.type !== 'task' || appState.selection.id !== rt.targetTaskId)) {
      const jumpWrap = node('div', '', 'inspector-actions');
      jumpWrap.append(button(`打开关联工作：${rt.targetTaskLabel ?? '关联工作'}`, () => {
        selectTrace({ type: 'task', id: rt.targetTaskId!, label: rt.targetTaskLabel ?? '关联工作' });
      }, 'mini-button'));
      summarySec.append(jumpWrap);
    }

    if (rt.summaryItems.length) {
      const kv = node('div', '', 'inspector-kv-list');
      for (const item of rt.summaryItems) {
        const row = node('div', '', 'detail-row');
        row.append(node('span', item.label), node('span', item.value));
        kv.append(row);
      }
      summarySec.append(kv);
    }

    if (rt.errorText) {
      summarySec.append(node('p', rt.errorText, 'error inspector-error-box'));
    }

    if (rt.promptText) {
      const sec = appendSection(body, '任务指令正文');
      sec.append(node('div', rt.promptText, 'inspector-prose-card'));
    }

    if (rt.contextBrief) {
      const sec = appendSection(body, '背景简报');
      sec.append(node('div', rt.contextBrief, 'inspector-prose-card'));
    }

    if (rt.options?.length) {
      const sec = appendSection(body, '请示备选方案');
      const pills = node('div', '', 'token-pills');
      for (const opt of rt.options) {
        pills.append(node('span', opt, 'token-pill'));
      }
      sec.append(pills);
    }

    if (rt.memories?.length) {
      const sec = appendSection(body, `挂载记忆卡片 (${rt.memories.length})`);
      const list = node('div', '', 'memory-chip-list');
      for (const mem of rt.memories) {
        const card = node('div', '', 'memory-chip-card');
        const memHead = node('div', '', 'memory-chip-head');
        memHead.append(node('strong', mem.topic || '未命名记忆', 'memory-chip-topic'));
        if (mem.tags.length) {
          const tags = node('div', '', 'memory-chip-tags');
          for (const tag of mem.tags) tags.append(node('span', tag, 'memory-chip-tag'));
          memHead.append(tags);
        }
        card.append(memHead);
        if (mem.preview) card.append(node('p', mem.preview, 'memory-chip-preview'));
        list.append(card);
      }
      sec.append(list);
    }

    if (rt.reportText) {
      const sec = appendSection(body, '汇报正文');
      const head = node('div', '', 'param-head');
      head.append(node('span', '交付内容', 'param-label'), createCopyButton('复制汇报', rt.reportText, `复制${rt.kindLabel}汇报正文`));
      sec.append(head, node('div', rt.reportText, 'inspector-prose-card'));
    }
  }

  function renderInspector(chainView: ExecutionChainView, visibleNodes: readonly ChainActionNode[]): void {
    const selectedNode = appState.selectedNodeId
      ? chainView.nodes.find(item => item.id === appState.selectedNodeId)
      : undefined;

    activeInspectorOperationKey = undefined;
    if (!selectedNode) {
      lastInspectorNodeId = undefined;
      eventDetailEl.replaceChildren();
      eventDetailEl.hidden = true;
      panelsEl.classList.remove('has-inspector');
      return;
    }

    const sameNode = lastInspectorNodeId === selectedNode.id;
    const prevScrollTop = sameNode ? eventDetailEl.scrollTop : 0;
    lastInspectorNodeId = selectedNode.id;

    eventDetailEl.hidden = false;
    panelsEl.classList.add('has-inspector');

    const navNodes = visibleNodes.some(item => item.id === selectedNode.id) ? visibleNodes : chainView.nodes;
    const idx = navNodes.findIndex(item => item.id === selectedNode.id);
    const prevNode = idx > 0 ? navNodes[idx - 1] : undefined;
    const nextNode = idx >= 0 && idx < navNodes.length - 1 ? navNodes[idx + 1] : undefined;

    const toolbar = node('div', '', 'inspector-toolbar');
    const titleGroup = node('div', '', 'inspector-title-group');
    const titleEl = node('h3', selectedNode.title, 'inspector-title');
    titleEl.setAttribute('tabindex', '-1');
    titleGroup.append(
      node('span', selectedNode.icon, 'inspector-icon'),
      titleEl,
      node('span', selectedNode.statusLabel, `chain-badge inspector-status-badge tone-${selectedNode.tone}`),
    );

    const navGroup = node('div', '', 'inspector-nav-group');
    const prevBtn = button('↑ 上一步', () => {
      if (prevNode) selectNodeById(prevNode.id);
    }, 'mini-button');
    prevBtn.disabled = !prevNode;
    const nextBtn = button('↓ 下一步', () => {
      if (nextNode) selectNodeById(nextNode.id);
    }, 'mini-button');
    nextBtn.disabled = !nextNode;
    const closeBtn = button('✕', () => {
      const closedNodeId = appState.selectedNodeId;
      appState.selectedNodeId = undefined;
      userClearedSelection = true;
      runWithViewTransition(
        () => renderTrace(),
        () => focusChainCard(closedNodeId),
      );
    }, 'mini-button inspector-close-btn');
    closeBtn.title = '关闭语义详情';
    closeBtn.setAttribute('aria-label', '关闭语义详情');
    navGroup.append(prevBtn, nextBtn, closeBtn);
    toolbar.append(titleGroup, navGroup);

    const body = node('div', '', `inspector-body${sameNode ? '' : ' is-switching'}`);
    const metaGrid = node('div', '', 'inspector-meta-grid');
    appendMetaCell(metaGrid, '精确时间', timestamp(selectedNode.at));
    appendMetaCell(metaGrid, '相对起点偏移', formatOffset(selectedNode.offsetMs));
    appendMetaCell(metaGrid, '耗时', formatDuration(selectedNode.durationMs));
    const subject = selectedNode.llmDetail?.model
      ? `${selectedNode.actorLabel} · ${selectedNode.llmDetail.model}`
      : selectedNode.toolDetail
        ? `${selectedNode.actorLabel} · ${selectedNode.toolDetail.displayName}`
        : selectedNode.actorLabel;
    appendMetaCell(metaGrid, '执行主体', subject);
    body.append(metaGrid);

    if (selectedNode.toolDetail) renderToolInspector(body, selectedNode);
    if (selectedNode.llmDetail) renderLlmInspector(body, selectedNode, chainView);
    if (selectedNode.messageDetail) renderMessageInspector(body, selectedNode);
    if (selectedNode.routingDetail) renderRoutingInspector(body, selectedNode);

    if (!selectedNode.toolDetail && !selectedNode.llmDetail && !selectedNode.messageDetail && !selectedNode.routingDetail && selectedNode.preview) {
      const sec = appendSection(body, '动作摘要');
      sec.append(node('div', selectedNode.preview, 'inspector-prose-card'));
    }

    eventDetailEl.replaceChildren(toolbar, body);
    eventDetailEl.scrollTop = prevScrollTop;
  }

  function buildChainListItem(item: ChainActionNode, isEntering: boolean): HTMLLIElement {
    const isSelected = item.id === appState.selectedNodeId;
    const isLive = item.tone === 'run' || active(item.status);
    const li = node('li', '', `chain-item${isEntering ? ' is-entering' : ''}`);
    const card = node(
      'button',
      '',
      `chain-card cat-${item.category}${isSelected ? ' is-selected' : ''}${isLive ? ' is-live' : ''}`,
    );
    card.type = 'button';
    card.setAttribute('aria-pressed', String(isSelected));
    if (card.dataset) card.dataset.nodeId = item.id;
    card.addEventListener('click', () => {
      selectNodeById(item.id);
    });

    const timeCol = node('div', '', 'chain-time-col');
    timeCol.append(
      node('span', formatClock(item.at), 'chain-clock'),
      node('span', formatOffset(item.offsetMs), 'chain-offset'),
      node('span', '', `chain-dot tone-${item.tone}`),
    );

    const bodyCol = node('div', '', 'chain-body-col');
    const headRow = node('div', '', 'chain-head-row');
    const badges = node('span', '', 'chain-badges');
    badges.append(node('span', item.actorLabel, 'chain-badge tone-neutral'));
    if (item.durationMs !== undefined) {
      badges.append(node('span', formatDuration(item.durationMs), 'chain-badge tone-neutral'));
    }
    badges.append(node('span', item.statusLabel, `chain-badge tone-${item.tone}`));
    headRow.append(
      node('span', item.icon, 'chain-icon'),
      node('span', item.title, 'chain-title'),
      badges,
    );
    bodyCol.append(headRow);

    if (item.subtitle) {
      bodyCol.append(node('div', item.subtitle, 'chain-subtitle meta'));
    }
    if (item.preview) {
      bodyCol.append(node('p', item.preview, 'chain-preview'));
    }
    bodyCol.append(createWaterfallBar(item.waterfallStartPermille, item.waterfallWidthPermille, item.tone));

    card.append(timeCol, bodyCol);
    li.append(card);
    return li;
  }

  async function appendRemainingChainChunks(
    seq: number,
    listEl: HTMLUListElement,
    visibleNodes: readonly ChainActionNode[],
    startIndex: number,
    isInitialBatchForScope: boolean,
    scroller: HTMLElement | null | undefined,
    pinned: boolean,
  ): Promise<void> {
    let cursor = startIndex;
    while (cursor < visibleNodes.length) {
      await yieldToMain();
      if (seq !== chainRenderSeq) return;
      const end = Math.min(visibleNodes.length, cursor + CHAIN_CHUNK_SIZE);
      const frag = document.createDocumentFragment();
      for (let i = cursor; i < end; i++) {
        const item = visibleNodes[i]!;
        const isEntering = !isInitialBatchForScope && !seenChainNodeIds.has(item.id);
        seenChainNodeIds.add(item.id);
        frag.append(buildChainListItem(item, isEntering));
      }
      listEl.append(frag);
      cursor = end;
      if (scroller && pinned) scroller.scrollTop = scroller.scrollHeight;
    }
  }

  function renderChainList(chainView: ExecutionChainView): readonly ChainActionNode[] {
    const seq = ++chainRenderSeq;
    const scroller = typeof traceContentEl.closest === 'function'
      ? traceContentEl.closest<HTMLElement>('.trace-chain-pane')
      : undefined;
    const pinned = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120 : false;

    const visibleNodes = appState.traceCategory === 'all'
      ? chainView.nodes
      : chainView.nodes.filter(item => item.category === appState.traceCategory);

    const hasRealBundle = Boolean(asExecutionBundle(appState.traceBundle));
    const selectedVisible = Boolean(appState.selectedNodeId && visibleNodes.some(item => item.id === appState.selectedNodeId));
    const shouldAutoSelect = !userClearedSelection
      && !isNarrowViewport()
      && visibleNodes.length > 0
      && (
        !appState.selectedNodeId
        || (!userPickedNode && !selectedVisible)
        || (!userPickedNode && hasRealBundle && autoSelectedSource === 'fallback')
      );

    if (shouldAutoSelect) {
      const picked = pickSmartDefaultNode(visibleNodes);
      if (picked) {
        appState.selectedNodeId = picked.id;
        autoSelectedSource = hasRealBundle ? 'bundle' : 'fallback';
      }
    } else if (!userPickedNode && !visibleNodes.length) {
      appState.selectedNodeId = undefined;
    }

    const scopeKey = `${appState.selection.type}:${appState.selection.type === 'all' ? '' : appState.selection.id}:${appState.traceCategory}`;
    const scopeSwitched = scopeKey !== lastChainScopeKey;
    if (scopeSwitched) {
      lastChainScopeKey = scopeKey;
      seenChainNodeIds.clear();
    }
    const isInitialBatchForScope = seenChainNodeIds.size === 0;

    const contents = document.createDocumentFragment();
    if (!visibleNodes.length) {
      const emptyMsg = !chainView.nodes.length
        ? (appState.selection.type === 'task' ? '此工作暂未采集到可执行链路。' : '此范围尚无可展示的执行链路。')
        : '当前筛选分类下暂无动作记录，可切换「全部链路」查看完整过程。';
      contents.append(node('p', emptyMsg, 'empty'));
      traceContentEl.replaceChildren(contents);
    } else {
      const list = node('ul', '', `chain-list${isInitialBatchForScope ? ' is-fresh-list' : ''}`);
      const syncLimit = visibleNodes.length > CHAIN_SYNC_THRESHOLD ? CHAIN_CHUNK_SIZE : visibleNodes.length;
      for (let i = 0; i < syncLimit; i++) {
        const item = visibleNodes[i]!;
        const isEntering = !isInitialBatchForScope && !seenChainNodeIds.has(item.id);
        seenChainNodeIds.add(item.id);
        list.append(buildChainListItem(item, isEntering));
      }
      contents.append(list);
      traceContentEl.replaceChildren(contents);
      if (syncLimit < visibleNodes.length) {
        void appendRemainingChainChunks(seq, list, visibleNodes, syncLimit, isInitialBatchForScope, scroller, pinned);
      }
    }

    syncTraceMore();
    if (scroller && pinned) scroller.scrollTop = scroller.scrollHeight;
    return visibleNodes;
  }

  function renderTrace(): void {
    const activeBundle = currentActiveBundle();
    const chainView = buildExecutionChain(activeBundle);
    lastChainView = chainView;
    syncCategoryTabs(chainView.stats);
    renderWorkDetail(chainView);
    const visibleNodes = renderChainList(chainView);
    renderInspector(chainView, visibleNodes);
  }

  function queueDirection(direction: 'live' | 'earlier' | 'recent'): void {
    const priority = { live: 1, earlier: 2, recent: 3 } as const;
    if (!appState.traceQueuedDirection || priority[direction] >= priority[appState.traceQueuedDirection]) {
      appState.traceQueuedDirection = direction;
    }
  }

  async function loadTrace(direction: 'live' | 'earlier' | 'recent' = 'live'): Promise<void> {
    if (!appState.ready || appState.authExpired) return;
    if (appState.traceBusy) {
      queueDirection(direction);
      return;
    }
    const generation = appState.selectionGeneration;
    const runSeq = ++traceRunSeq;
    const latest = direction === 'live';
    const anchor = direction === 'earlier' ? appState.traceEvents[0]?.seq : latest ? appState.traceAfter : undefined;
    const params = new URLSearchParams();
    if (anchor !== undefined) params.set(direction === 'earlier' ? 'before' : 'after', String(anchor));
    if (appState.selection.type !== 'all') params.set(appState.selection.type === 'task' ? 'taskId' : 'messageId', appState.selection.id);
    traceAbort?.abort();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    traceAbort = ac;
    appState.traceBusy = true;
    traceMoreBtn.disabled = true;
    traceErrorEl.textContent = '';
    traceRetryBtn.hidden = true;
    let failed = false;
    const run = (async () => {
      try {
        const events = await api<TraceEvent[]>(
          `/api/trace?${params}`,
          undefined,
          {
            ...(ac ? { signal: ac.signal } : {}),
            ...(latest ? { priority: 'low' as const } : {}),
          },
        );
        if (generation !== appState.selectionGeneration || ac?.signal.aborted) return;
        const win = mergeTraceWindow(appState.traceEvents, events, direction);
        appState.traceEvents = win.events;
        appState.traceAfter = Math.max(appState.traceAfter, events.at(-1)?.seq ?? 0);
        if (direction === 'live') appState.traceHasMore = events.length === 60;
        const full = events.length === 60;
        if (direction === 'recent' || direction === 'earlier') appState.traceHasEarlier = full;
        else if (win.trimmedEarlier) appState.traceHasEarlier = true;
        renderTrace();
        if (direction === 'live' && events.length > 0) {
          scheduleExecutionBundleRefresh();
        }
      } catch (error) {
        if (generation !== appState.selectionGeneration || ac?.signal.aborted) return;
        failed = true;
        traceErrorEl.textContent = `链路读取失败：${errorText(error)}`;
        traceRetryBtn.hidden = false;
      } finally {
        if (generation === appState.selectionGeneration) {
          appState.traceBusy = false;
          traceMoreBtn.disabled = false;
          if (traceRunSeq === runSeq) activeTracePromise = undefined;
          syncTraceMore();
          const queued = appState.traceQueuedDirection;
          appState.traceQueuedDirection = undefined;
          if (!failed && !appState.authExpired) {
            if (queued) {
              void loadTrace(queued);
            } else if (appState.selection.type !== 'all' && appState.traceHasMore) {
              void loadTrace('live');
            }
          }
        }
      }
    })();
    activeTracePromise = run;
    return run;
  }

  async function loadWork(id: string, generation: number, background = false): Promise<void> {
    const requestNumber = ++appState.workRequest;
    workAbort?.abort();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    workAbort = ac;
    workDetailEl.hidden = false;
    if (!background && !appState.workData && !appState.traceBundle) {
      workDetailEl.replaceChildren(node('p', '正在读取任务执行总览…', 'meta'));
    }
    try {
      const task = await api<unknown>(
        `/api/work?${new URLSearchParams({ taskId: id })}`,
        undefined,
        {
          ...(ac ? { signal: ac.signal } : {}),
          ...(background ? { priority: 'low' as const } : {}),
        },
      );
      if (generation !== appState.selectionGeneration || requestNumber !== appState.workRequest || ac?.signal.aborted) return;
      appState.workData = task;
      renderWorkDetail(lastChainView);
      if (background) {
        void loadExecutionBundle(true);
      }
    } catch (error) {
      if (generation !== appState.selectionGeneration || requestNumber !== appState.workRequest || ac?.signal.aborted) return;
      if (!appState.traceBundle) {
        workDetailEl.replaceChildren(
          node('p', `任务详情读取失败：${errorText(error)}`, 'error'),
          button('重试任务详情', () => { void loadWork(id, generation); }, 'mini-button'),
        );
      }
    }
  }

  function selectTrace(next: Selection, pin = true): void {
    if (pin) {
      appState.selectionPinned = true;
      ensureRightDrawerOpen();
    }
    if (next.type === 'message') appState.followedMessage = next.id;
    appState.selection = next;
    appState.selectionGeneration++;
    if (bundleRefreshTimer) {
      clearTimeout(bundleRefreshTimer);
      bundleRefreshTimer = undefined;
    }
    bundleAbort?.abort();
    workAbort?.abort();
    traceAbort?.abort();
    appState.traceEvents = [];
    appState.traceAfter = 0;
    appState.traceHasMore = false;
    appState.traceHasEarlier = false;
    appState.traceBusy = false;
    appState.traceQueuedDirection = undefined;
    activeTracePromise = undefined;
    appState.selectedEvent = undefined;
    appState.selectedSpan = undefined;
    appState.workData = undefined;
    appState.traceBundle = undefined;
    appState.selectedNodeId = undefined;
    appState.traceCategory = 'all';
    userPickedNode = false;
    userClearedSelection = false;
    autoSelectedSource = 'none';
    lastChainView = undefined;

    panelsEl.classList.toggle('trace-task-active', next.type === 'task');
    panelsEl.classList.remove('has-inspector');
    syncWideToggle();
    syncCategoryTabs();
    syncTraceMore();

    traceScopeEl.textContent = next.type === 'all'
      ? '全部已记录执行链路'
      : `${next.type === 'task' ? '后台工作' : '消息'} · ${next.label}`;
    traceScopeEl.title = traceScopeEl.textContent;
    traceContentEl.replaceChildren(node('p', '正在读取执行链路…', 'empty'));
    eventDetailEl.replaceChildren();
    eventDetailEl.hidden = true;

    renderWorks();
    renderWorkDetail();
    hooks.renderRoutingDetail();
    void loadTrace('recent');
    void loadExecutionBundle();
    if (next.type === 'task') void loadWork(next.id, appState.selectionGeneration);
  }

  async function stopWork(target?: string): Promise<void> {
    const id = target ?? (appState.selection.type === 'task' ? appState.selection.id : undefined);
    if (!id) return;
    const key = `task:${id}`;
    appState.stopRequests.add(key);
    renderWorks();
    renderWorkDetail(lastChainView);
    hooks.renderMessages();
    try {
      const task = await api<unknown>('/api/stop', { taskId: id });
      if (appState.selection.type === 'task' && appState.selection.id === id) {
        appState.workData = task;
        renderWorkDetail(lastChainView);
        void loadExecutionBundle(true);
      }
      hooks.connection('已请求停止选中工作，尚不代表确认取消；请查看最终状态与原因。');
      hooks.scheduleRefresh();
    } catch (error) {
      appState.stopRequests.delete(key);
      renderWorks();
      renderWorkDetail(lastChainView);
      hooks.connection(`停止请求未确认：${errorText(error)}。可再次请求。`, true);
    }
  }

  function setTraceCategory(cat: ChainCategory, clickedBtn?: HTMLButtonElement | null): void {
    if (appState.traceCategory === cat) return;
    appState.traceCategory = cat;
    runWithViewTransition(() => {
      renderTrace();
      if (clickedBtn && typeof clickedBtn.scrollIntoView === 'function') {
        try {
          clickedBtn.scrollIntoView({
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
            block: 'nearest',
            inline: 'nearest',
          });
        } catch {
          // Ignore scrollIntoView errors in stub environments
        }
      }
    });
  }

  workFilterEl.addEventListener('change', renderWorks);
  traceMoreBtn.addEventListener('click', () => {
    void loadTrace(appState.traceHasEarlier ? 'earlier' : 'live');
  });
  traceRetryBtn.addEventListener('click', () => {
    void loadTrace(appState.traceEvents.length ? 'live' : 'recent');
  });
  clearFilterBtn.addEventListener('click', () => selectTrace({ type: 'all' }));

  for (const { cat, btn } of categoryTabs) {
    btn?.addEventListener('click', () => setTraceCategory(cat, btn));
  }

  traceWideToggleBtn?.addEventListener('click', () => {
    appState.traceWide = !appState.traceWide;
    runWithViewTransition(syncWideToggle);
  });

  eventDetailEl.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || eventDetailEl.hidden) return;
    event.stopPropagation?.();
    const closedNodeId = appState.selectedNodeId;
    appState.selectedNodeId = undefined;
    userClearedSelection = true;
    runWithViewTransition(
      () => renderTrace(),
      () => focusChainCard(closedNodeId),
    );
  });

  traceCloseBtn?.addEventListener('click', () => {
    if (isMobileTraceViewport()) {
      showPanel(false);
    } else {
      collapseRightDrawer();
      if (desktopTraceFoldBtn) safeFocus(desktopTraceFoldBtn);
    }
  });

  showChatBtn.addEventListener('click', () => showPanel(false));
  showTraceBtn.addEventListener('click', () => showPanel(true));
  mobileTraceBtn?.addEventListener('click', () => {
    showPanel(!panelsEl.classList.contains('trace-visible'));
  });
  mobileTraceScrim?.addEventListener('click', () => showPanel(false));
  workSidebarCloseBtn?.addEventListener('click', () => closeSidebar(true));
  mobileSidebarScrim?.addEventListener('click', () => closeSidebar(true));
  workToggleBtn.addEventListener('click', () => {
    const open = !sidebarEl.classList.contains('open');
    setSidebarOpen(open, true);
  });
  document.addEventListener('click', event => {
    if (!sidebarEl.classList.contains('open')) return;
    if (event.target instanceof Node && !sidebarEl.contains(event.target) && !workToggleBtn.contains(event.target)) {
      const activeInSidebar = typeof document !== 'undefined' && document.activeElement
        ? sidebarEl.contains(document.activeElement)
        : false;
      closeSidebar(activeInSidebar);
    }
  });

  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      const mobileTraceMql = window.matchMedia('(max-width: 730px)');
      mobileTraceMql.addEventListener?.('change', e => {
        if (!e.matches) {
          tracePanelEl?.removeAttribute?.('role');
          tracePanelEl?.removeAttribute?.('aria-modal');
          setInertElements([conversationEl, panelNavEl, appTopbarEl, sidebarEl], false);
          lastTraceTrigger = null;
        }
      });
      const sidebarDrawerMql = window.matchMedia('(max-width: 1100px)');
      sidebarDrawerMql.addEventListener?.('change', e => {
        if (!e.matches && sidebarEl.classList.contains('open')) {
          closeSidebar(false);
        }
      });
    } catch {
      // Ignore matchMedia errors in stub environments
    }
  }

  syncWideToggle();
  syncCategoryTabs();

  return {
    renderWorks,
    stopWork,
    showPanel,
    isTraceVisible: () => panelsEl.classList.contains('trace-visible'),
    closeSidebar,
    isSidebarOpen: () => sidebarEl.classList.contains('open'),
    focusSidebarToggle,
    selectTrace,
    loadTrace,
    loadWork,
  };
}

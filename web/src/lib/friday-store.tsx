import type { ChatMessage, MainView, MessagePage, TraceEvent, WorkView } from '@friday/view.js';
import {
  activeStatus,
  MAX_TRACE_EVENTS,
  mergeMessages as mergeMessagesIntoMap,
  mergeTraceWindow,
  orderConversation,
} from '@friday/web/model.js';
import {
  ApiError,
  createHttpClient,
  resolveBootstrapToken,
  type ApiRequestOptions,
} from '@friday/web/shared/auth-http.js';
import { deriveFridayBotState, type BotStateId } from '@friday/web/shared/bot-avatar.js';
import type { ChatChannelFilter } from '@friday/web/shared/chat-view.js';
import { errorText, makeRequestId } from '@friday/web/shared/format.js';
import { createSharedSseHub, type SseUpdateBatch } from '@friday/web/shared/sse-hub.js';
import {
  buildExecutionChain,
  buildFallbackBundleFromAppState,
  extractReadableOperationOutput,
  type ChainActionNode,
  type ChainCategory,
  type ExecutionChainView,
  type ExecutionTraceBundle,
} from '@friday/web/trace-chain.js';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type Selection = { type: 'all' } | { type: 'task' | 'message'; id: string; label: string };
export type HubKey = 'memory' | 'timer' | 'plugin' | 'im' | 'system';
export type SystemHubTab = 'models' | 'usage' | 'services';
export type MemoryHubTab = 'matrix' | 'notes' | 'diary';

export interface Submission {
  requestId: string;
  text: string;
  files: string[];
}

export interface OperationCacheEntry {
  loading?: boolean;
  text?: string;
  error?: string;
}

const STORAGE_CHANNEL = 'friday.chat-channel-filter';
const STORAGE_HIDE_SYSTEM = 'friday.chat-hide-system';
const STORAGE_DETAIL_MODE = 'friday.chat-detail-mode';
const STORAGE_LEFT_COLLAPSED = 'friday.ui-left-collapsed';
const STORAGE_RIGHT_COLLAPSED = 'friday.ui-right-collapsed';

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
  } catch {
    // ignore
  }
  return fallback;
}

function writeString(key: string, val: string): void {
  try {
    localStorage.setItem(key, val);
  } catch {
    // ignore
  }
}

function normalizeChannel(raw: string | null): ChatChannelFilter {
  if (raw === 'local' || raw === 'wechat' || raw === 'telegram' || raw === 'xiaoai' || raw === 'dingtalk') {
    return raw;
  }
  return 'all';
}

function findLatestUserMessage(map: ReadonlyMap<string, ChatMessage>): ChatMessage | undefined {
  let latest: ChatMessage | undefined;
  for (const msg of map.values()) {
    if (msg.role === 'user' && (!latest || msg.seq > latest.seq)) latest = msg;
  }
  return latest;
}

function scopeKey(sel: Selection): string {
  return sel.type === 'all' ? 'all' : `${sel.type}:${sel.id}`;
}

export interface FridayContextValue {
  token: string;
  storageUnavailable: boolean;
  authExpired: boolean;
  ready: boolean;
  view: MainView | undefined;
  connectionText: string;
  connectionStale: boolean;
  srStatusText: string;
  srAlertText: string;
  announceStatus: (text: string, priority?: 'polite' | 'assertive') => void;
  reconnect: () => void;

  messagesMap: ReadonlyMap<string, ChatMessage>;
  orderedMessages: ChatMessage[];
  historyHasMore: boolean;
  historyBusy: boolean;
  historyError: string;
  loadOlder: (trigger?: 'auto' | 'manual') => Promise<number>;

  sending: boolean;
  uncertain: boolean;
  pending: Submission | undefined;
  sendFeedback: { text: string; tone: 'error' | 'status' | 'clear' };
  sendDraft: (text: string) => Promise<boolean>;
  sendDirectText: (text: string) => Promise<void>;
  stopMessage: (id: string) => Promise<void>;
  stopRequests: ReadonlySet<string>;
  setDraftTyping: (activeFlag: boolean) => void;

  channelFilter: ChatChannelFilter;
  setChannelFilter: (next: ChatChannelFilter) => void;
  hideSystem: boolean;
  setHideSystem: (next: boolean) => void;
  detailMode: boolean;
  setDetailMode: (next: boolean) => void;

  works: WorkView[];
  workFilter: 'all' | 'active' | 'settled';
  setWorkFilter: (next: 'all' | 'active' | 'settled') => void;
  stopWork: (taskId?: string) => Promise<void>;
  resumeWork: (taskId: string) => Promise<void>;

  selection: Selection;
  selectionPinned: boolean;
  selectTrace: (next: Selection, pin?: boolean) => void;
  unpinTraceToLatest: () => void;
  traceCategory: ChainCategory;
  setTraceCategory: (cat: ChainCategory) => void;
  traceWide: boolean;
  setTraceWide: (next: boolean) => void;
  traceBundle: ExecutionTraceBundle;
  chainView: ExecutionChainView;
  selectedNodeId: string | undefined;
  setSelectedNodeId: (id: string | undefined) => void;
  workData: unknown;
  traceHasMore: boolean;
  traceBusy: boolean;
  loadEarlierTrace: () => Promise<void>;
  refreshSelectedWork: () => void;
  operationCache: ReadonlyMap<string, OperationCacheEntry>;
  loadOperationOutput: (taskId: string, operationId: string) => Promise<void>;

  botState: BotStateId;
  leftCollapsed: boolean;
  setLeftCollapsed: (next: boolean) => void;
  rightCollapsed: boolean;
  setRightCollapsed: (next: boolean) => void;
  mobilePanel: 'chat' | 'trace';
  setMobilePanel: (next: 'chat' | 'trace') => void;
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;
  mobileWorksOpen: boolean;
  setMobileWorksOpen: (open: boolean) => void;

  activeHub: HubKey | null;
  setActiveHub: (hub: HubKey | null) => void;
  systemTab: SystemHubTab;
  setSystemTab: (tab: SystemHubTab) => void;
  openSystemHub: (tab?: SystemHubTab) => void;
  memoryTab: MemoryHubTab;
  setMemoryTab: (tab: MemoryHubTab) => void;
  openMemoryHub: (tab?: MemoryHubTab) => void;
  pluginSurface: string;
  setPluginSurface: (surface: string) => void;
  openPluginHub: (target?: string) => void;
  api: <T>(path: string, body?: unknown, init?: ApiRequestOptions) => Promise<T>;
  refreshView: (initial?: boolean) => Promise<void>;
  scheduleRefresh: () => void;
  routingDetailMessageId: string | null;
  setRoutingDetailMessageId: (id: string | null) => void;
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;

  jumpTarget: { id: string; seq: number } | null;
  jumpMessage: (id: string) => Promise<void>;
}

const FridayContext = createContext<FridayContextValue | null>(null);

export function useFriday(): FridayContextValue {
  const ctx = useContext(FridayContext);
  if (!ctx) throw new Error('useFriday must be used inside <FridayProvider>');
  return ctx;
}

export function FridayProvider({ children }: { children: ReactNode }) {
  const [bootstrap] = useState(() => resolveBootstrapToken());
  const [authExpired, setAuthExpired] = useState(false);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<MainView | undefined>(undefined);
  const [connectionText, setConnectionText] = useState(() =>
    bootstrap.token
      ? '正在连接本机服务…'
      : '缺少有效的本机访问链接。请从当前服务生成的本地启动链接进入；无需在页面输入 API 密钥。',
  );
  const [connectionStale, setConnectionStale] = useState(() => !bootstrap.token);
  const [srStatusText, setSrStatusText] = useState('');
  const [srAlertText, setSrAlertText] = useState('');

  const [messagesMap, setMessagesMap] = useState<Map<string, ChatMessage>>(() => new Map());
  const [historyBefore, setHistoryBefore] = useState<number | undefined>(undefined);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');

  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<Submission | undefined>(undefined);
  const [uncertain, setUncertain] = useState(false);
  const [sendFeedback, setSendFeedback] = useState<{ text: string; tone: 'error' | 'status' | 'clear' }>({
    text: '',
    tone: 'clear',
  });
  const [stopRequests, setStopRequests] = useState<Set<string>>(() => new Set());
  const [draftTyping, setDraftTyping] = useState(false);

  const [channelFilter, setChannelFilterState] = useState<ChatChannelFilter>(() => {
    try {
      return normalizeChannel(localStorage.getItem(STORAGE_CHANNEL));
    } catch {
      return 'all';
    }
  });
  const [hideSystem, setHideSystemState] = useState<boolean>(() => readBool(STORAGE_HIDE_SYSTEM, false));
  const [detailMode, setDetailModeState] = useState<boolean>(() => readBool(STORAGE_DETAIL_MODE, false));

  const [workFilter, setWorkFilter] = useState<'all' | 'active' | 'settled'>('all');
  const [selection, setSelection] = useState<Selection>({ type: 'all' });
  const [selectionPinned, setSelectionPinned] = useState(false);
  const [followedMessage, setFollowedMessage] = useState<string | undefined>(undefined);
  const [traceCategory, setTraceCategory] = useState<ChainCategory>('all');
  const [traceWide, setTraceWide] = useState(false);
  const [rawTraceBundle, setRawTraceBundle] = useState<ExecutionTraceBundle | undefined>(undefined);
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
  const [traceAfter, setTraceAfter] = useState(0);
  const [traceHasMore, setTraceHasMore] = useState(false);
  const [traceBusy, setTraceBusy] = useState(false);
  const [workData, setWorkData] = useState<unknown>(undefined);
  const [selectedNodeId, setSelectedNodeId] = useState<string | undefined>(undefined);
  const [operationCache, setOperationCache] = useState<Map<string, OperationCacheEntry>>(() => new Map());

  const [transientBotState, setTransientBotState] = useState<'finished' | 'failed' | undefined>(undefined);
  const [leftCollapsed, setLeftCollapsedState] = useState<boolean>(() => readBool(STORAGE_LEFT_COLLAPSED, false));
  const [rightCollapsed, setRightCollapsedState] = useState<boolean>(() => readBool(STORAGE_RIGHT_COLLAPSED, false));
  const [mobilePanel, setMobilePanel] = useState<'chat' | 'trace'>('chat');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileWorksOpen, setMobileWorksOpen] = useState(false);
  const [activeHub, setActiveHub] = useState<HubKey | null>(null);
  const [systemTab, setSystemTab] = useState<SystemHubTab>('models');
  const [memoryTab, setMemoryTab] = useState<MemoryHubTab>('matrix');
  const [pluginSurface, setPluginSurface] = useState<string>('catalog');
  const [routingDetailMessageId, setRoutingDetailMessageId] = useState<string | null>(null);

  const openSystemHub = useCallback((tab?: SystemHubTab) => {
    if (tab) setSystemTab(tab);
    setActiveHub('system');
  }, []);

  const openMemoryHub = useCallback((tab?: MemoryHubTab) => {
    if (tab) setMemoryTab(tab);
    setActiveHub('memory');
  }, []);

  const openPluginHub = useCallback((target?: string) => {
    if (target) setPluginSurface(target);
    setActiveHub('plugin');
  }, []);
  const [commandOpen, setCommandOpen] = useState(false);
  const [jumpTarget, setJumpTarget] = useState<{ id: string; seq: number } | null>(null);

  const refs = useRef({
    authExpired: false,
    ready: false,
    cursor: 0,
    view: undefined as MainView | undefined,
    messages: new Map<string, ChatMessage>(),
    historyBefore: undefined as number | undefined,
    historyHasMore: false,
    historyBusy: false,
    selection: { type: 'all' } as Selection,
    selectionGeneration: 0,
    selectionPinned: false,
    followedMessage: undefined as string | undefined,
    traceAfter: 0,
    traceHasMore: false,
    traceBusy: false,
    traceEvents: [] as TraceEvent[],
    connectionGeneration: 0,
    reconnectTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    refreshTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    retryDelay: 500,
    activeRefresh: undefined as Promise<void> | undefined,
    refreshAgain: false,
    refreshRunSeq: 0,
    pendingCursorReset: false,
    cursorResetEpoch: 0,
    sseStarted: false,
    olderAbort: undefined as AbortController | undefined,
    bundleSeq: 0,
    workSeq: 0,
    trackedMessages: new Set<string>(),
    trackedWorks: new Set<string>(),
    transientTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    lastConnectionAnnouncement: '',
    lastConnectionWasStale: false,
    jumpSeq: 0,
  });

  useEffect(() => {
    document.body.classList.toggle('desktop-left-collapsed', leftCollapsed);
    document.body.classList.toggle('desktop-right-collapsed', rightCollapsed);
  }, [leftCollapsed, rightCollapsed]);

  const setLeftCollapsed = useCallback((next: boolean) => {
    setLeftCollapsedState(next);
    writeString(STORAGE_LEFT_COLLAPSED, next ? '1' : '0');
  }, []);

  const setRightCollapsed = useCallback((next: boolean) => {
    setRightCollapsedState(next);
    writeString(STORAGE_RIGHT_COLLAPSED, next ? '1' : '0');
  }, []);

  const setChannelFilter = useCallback((next: ChatChannelFilter) => {
    setChannelFilterState(next);
    writeString(STORAGE_CHANNEL, next);
  }, []);

  const setHideSystem = useCallback((next: boolean) => {
    setHideSystemState(next);
    writeString(STORAGE_HIDE_SYSTEM, next ? 'true' : 'false');
  }, []);

  const setDetailMode = useCallback((next: boolean) => {
    setDetailModeState(next);
    writeString(STORAGE_DETAIL_MODE, next ? 'true' : 'false');
  }, []);

  const announceStatus = useCallback((text: string, priority: 'polite' | 'assertive' = 'polite') => {
    if (!text) return;
    if (priority === 'assertive') setSrAlertText(text);
    else setSrStatusText(text);
  }, []);

  const setConnection = useCallback((text: string, stale = false) => {
    if (refs.current.authExpired) {
      text = '访问链接已失效。请从当前服务的本地启动链接重新进入（服务重启后需使用新链接）。';
      stale = true;
    }
    setConnectionStale(stale);
    setConnectionText(stale ? text : '');
    if (stale) {
      if (text !== refs.current.lastConnectionAnnouncement || !refs.current.lastConnectionWasStale) {
        refs.current.lastConnectionAnnouncement = text;
        refs.current.lastConnectionWasStale = true;
        announceStatus(text, 'assertive');
      }
    } else if (refs.current.lastConnectionWasStale) {
      refs.current.lastConnectionAnnouncement = text;
      refs.current.lastConnectionWasStale = false;
      announceStatus(text, 'polite');
    }
  }, [announceStatus]);

  const expireAuthRef = useRef<() => void>(() => {});
  const httpClient = useMemo(
    () =>
      createHttpClient({
        token: bootstrap.token,
        isExpired: () => refs.current.authExpired,
        onAuthExpired: () => expireAuthRef.current(),
      }),
    [bootstrap.token],
  );
  const api = httpClient.api;
  const request = httpClient.request;

  const fetchMessagesBatch = useCallback(
    async (ids: readonly string[], init?: ApiRequestOptions): Promise<ChatMessage[]> => {
      const unique = [...new Set(ids.filter(Boolean))];
      if (!unique.length) return [];
      const items: ChatMessage[] = [];
      for (let offset = 0; offset < unique.length; offset += 50) {
        const params = new URLSearchParams({ ids: unique.slice(offset, offset + 50).join(',') });
        const res = await api<{ items?: ChatMessage[] }>(`/api/messages?${params}`, undefined, init);
        if (Array.isArray(res.items)) items.push(...res.items);
      }
      return items;
    },
    [api],
  );

  const commitMessages = useCallback((incoming: ChatMessage[]) => {
    if (!incoming.length) return;
    const map = refs.current.messages;
    mergeMessagesIntoMap(map, incoming);
    setMessagesMap(new Map(map));
  }, []);

  const hydrateParents = useCallback(async () => {
    const missing = [...refs.current.messages.values()]
      .map(m => m.replyTo)
      .filter((id): id is string => Boolean(id && !refs.current.messages.has(id)));
    if (!missing.length) return;
    const fetched = await fetchMessagesBatch(missing, { priority: 'low' });
    if (refs.current.authExpired) return;
    commitMessages(fetched);
  }, [commitMessages, fetchMessagesBatch]);

  const trackCompanionTransitions = useCallback((initial: boolean, nextView?: MainView) => {
    let completedNow = false;
    let failedNow = false;
    if (!initial) {
      for (const id of refs.current.trackedMessages) {
        const msg = refs.current.messages.get(id);
        if (!msg || activeStatus(msg.status)) continue;
        if (msg.status === 'failed') failedNow = true;
        else if (msg.status === 'completed' && msg.role === 'assistant') completedNow = true;
      }
      for (const id of refs.current.trackedWorks) {
        const work = nextView?.works.find(w => w.id === id);
        if (!work || work.status === 'queued' || work.status === 'running') continue;
        if (work.status === 'failed') failedNow = true;
        else if (work.status === 'completed') completedNow = true;
      }
    }
    refs.current.trackedMessages.clear();
    for (const msg of refs.current.messages.values()) {
      if (activeStatus(msg.status)) refs.current.trackedMessages.add(msg.id);
    }
    refs.current.trackedWorks.clear();
    for (const work of nextView?.works ?? []) {
      if (work.status === 'queued' || work.status === 'running') refs.current.trackedWorks.add(work.id);
    }
    if (failedNow || completedNow) {
      if (refs.current.transientTimer) clearTimeout(refs.current.transientTimer);
      const nextState = failedNow ? 'failed' : 'finished';
      setTransientBotState(nextState);
      refs.current.transientTimer = setTimeout(() => {
        refs.current.transientTimer = undefined;
        setTransientBotState(undefined);
      }, failedNow ? 2500 : 2300);
    }
  }, []);

  const loadExecutionBundle = useCallback(async (sel: Selection, generation: number) => {
    const reqSeq = ++refs.current.bundleSeq;
    const params = new URLSearchParams();
    if (sel.type === 'task') params.set('taskId', sel.id);
    if (sel.type === 'message') params.set('messageId', sel.id);
    try {
      const bundle = await api<ExecutionTraceBundle>(
        `/api/execution-trace${params.size ? `?${params}` : ''}`,
        undefined,
        { priority: 'low' },
      );
      if (reqSeq !== refs.current.bundleSeq || generation !== refs.current.selectionGeneration) return;
      setRawTraceBundle(bundle);
    } catch {
      // Fallback bundle stays active cleanly
    }
  }, [api]);

  const loadTrace = useCallback(async (direction: 'live' | 'earlier' | 'recent', sel: Selection, generation: number) => {
    if (refs.current.traceBusy || refs.current.authExpired) return;
    refs.current.traceBusy = true;
    setTraceBusy(true);
    try {
      const cursorAtStart = refs.current.cursor;
      const params = new URLSearchParams();
      if (sel.type === 'task') params.set('taskId', sel.id);
      if (sel.type === 'message') params.set('messageId', sel.id);
      if (direction === 'live' && refs.current.traceAfter > 0) params.set('after', String(refs.current.traceAfter));
      if (direction === 'earlier' && refs.current.traceEvents.length) params.set('before', String(refs.current.traceEvents[0]!.seq));
      const events = await api<TraceEvent[]>(`/api/trace${params.size ? `?${params}` : ''}`, undefined, { priority: 'low' });
      if (generation !== refs.current.selectionGeneration || refs.current.cursor < cursorAtStart) return;
      const merged = mergeTraceWindow(refs.current.traceEvents, events, direction);
      refs.current.traceEvents = merged.events;
      setTraceEvents(merged.events);
      if (events.length) {
        const nextAfter = Math.max(refs.current.traceAfter, ...events.map(e => e.seq));
        refs.current.traceAfter = nextAfter;
        setTraceAfter(nextAfter);
      }
      if (direction === 'earlier') {
        const more = events.length >= 200;
        refs.current.traceHasMore = more;
        setTraceHasMore(more);
      } else if (direction === 'recent') {
        const more = events.length >= 200 || merged.trimmedEarlier;
        refs.current.traceHasMore = more;
        setTraceHasMore(more);
      }
    } catch {
      // ignore trace polling errors
    } finally {
      refs.current.traceBusy = false;
      setTraceBusy(false);
    }
  }, [api]);

  const loadWork = useCallback(async (id: string, generation: number) => {
    const reqSeq = ++refs.current.workSeq;
    try {
      const task = await api<unknown>(`/api/work?${new URLSearchParams({ taskId: id })}`, undefined, { priority: 'low' });
      if (reqSeq !== refs.current.workSeq || generation !== refs.current.selectionGeneration) return;
      setWorkData(task);
    } catch {
      // ignore
    }
  }, [api]);

  const selectTrace = useCallback((next: Selection, pin = true) => {
    const sameScope = scopeKey(refs.current.selection) === scopeKey(next);
    refs.current.selectionPinned = pin;
    setSelectionPinned(pin);
    if (next.type === 'message' && !pin) {
      refs.current.followedMessage = next.id;
      setFollowedMessage(next.id);
    }
    if (pin && next.type !== 'all') {
      setRightCollapsed(false);
    }
    if (sameScope) {
      setSelection(next);
      return;
    }
    const gen = ++refs.current.selectionGeneration;
    refs.current.selection = next;
    refs.current.traceAfter = 0;
    refs.current.traceEvents = [];
    refs.current.traceHasMore = false;
    setSelection(next);
    setTraceAfter(0);
    setTraceEvents([]);
    setTraceHasMore(false);
    setRawTraceBundle(undefined);
    setWorkData(undefined);
    setSelectedNodeId(undefined);
    void loadExecutionBundle(next, gen);
    void loadTrace('recent', next, gen);
    if (next.type === 'task') {
      void loadWork(next.id, gen);
    }
  }, [loadExecutionBundle, loadTrace, loadWork, setRightCollapsed]);

  const unpinTraceToLatest = useCallback(() => {
    const latest = findLatestUserMessage(refs.current.messages);
    selectTrace(
      latest ? { type: 'message', id: latest.id, label: latest.text.slice(0, 80) } : { type: 'all' },
      false,
    );
  }, [selectTrace]);

  const scheduleRefreshRef = useRef<() => void>(() => {});
  const sseHubRef = useRef<ReturnType<typeof createSharedSseHub> | null>(null);

  const refreshView = useCallback(async (initial = false): Promise<void> => {
    if (refs.current.activeRefresh) {
      refs.current.refreshAgain = true;
      await refs.current.activeRefresh;
      if (!initial || refs.current.view || refs.current.authExpired) return;
    }
    const runSeq = ++refs.current.refreshRunSeq;
    const run = (async () => {
      try {
        const resetEpochAtStart = refs.current.cursorResetEpoch;
        const hadPendingReset = refs.current.pendingCursorReset;
        const result = await api<MainView>('/api/view', undefined, initial ? undefined : { priority: 'low' });
        const selectedTaskId = refs.current.selection.type === 'task' ? refs.current.selection.id : undefined;
        const prevWorkStatus = refs.current.view?.works.find(w => w.id === selectedTaskId)?.status;
        const cursorReset = !initial && (hadPendingReset || result.cursor < refs.current.cursor);
        if (hadPendingReset && refs.current.cursorResetEpoch === resetEpochAtStart) {
          refs.current.pendingCursorReset = false;
        }
        refs.current.view = result;
        setView(result);

        if (cursorReset) {
          refs.current.messages.clear();
          setMessagesMap(new Map());
          refs.current.followedMessage = undefined;
          setFollowedMessage(undefined);
          refs.current.selectionPinned = false;
          setSelectionPinned(false);
          refs.current.traceAfter = 0;
          refs.current.traceEvents = [];
          refs.current.traceHasMore = false;
          setTraceAfter(0);
          setTraceEvents([]);
          setTraceHasMore(false);
          setRawTraceBundle(undefined);
          setWorkData(undefined);
          setOperationCache(new Map());
          setStopRequests(new Set());
          refs.current.historyBefore = result.messages.before;
          refs.current.historyHasMore = result.messages.hasMore;
          setHistoryBefore(result.messages.before);
          setHistoryHasMore(result.messages.hasMore);
          refs.current.cursor = result.cursor;
          sseHubRef.current?.setCursor(result.cursor);
        }

        setStopRequests(prev => {
          const next = new Set(prev);
          for (const w of result.works) {
            if (!activeStatus(w.status)) next.delete(`task:${w.id}`);
          }
          for (const m of result.messages.items) {
            if (!activeStatus(m.status)) next.delete(`message:${m.id}`);
          }
          return next.size === prev.size ? prev : next;
        });

        refs.current.ready = true;
        setReady(true);
        commitMessages(result.messages.items);
        await hydrateParents();

        if (initial || refs.current.historyBefore === undefined) {
          refs.current.historyBefore = result.messages.before;
          refs.current.historyHasMore = result.messages.hasMore;
          setHistoryBefore(result.messages.before);
          setHistoryHasMore(result.messages.hasMore);
        }
        if (initial) {
          refs.current.cursor = result.cursor;
          sseHubRef.current?.setCursor(result.cursor);
        }

        if (!refs.current.selectionPinned) {
          const latest = findLatestUserMessage(refs.current.messages);
          if (latest && latest.id !== refs.current.followedMessage) {
            selectTrace({ type: 'message', id: latest.id, label: latest.text.slice(0, 80) }, false);
          } else if (cursorReset) {
            selectTrace({ type: 'all' }, false);
          }
        }

        trackCompanionTransitions(initial, result);
        if (!initial) {
          void loadExecutionBundle(refs.current.selection, refs.current.selectionGeneration);
          if (refs.current.selection.type === 'task' && result.works.find(w => w.id === selectedTaskId)?.status !== prevWorkStatus) {
            void loadWork(refs.current.selection.id, refs.current.selectionGeneration);
          }
        }
      } finally {
        if (refs.current.refreshRunSeq === runSeq) refs.current.activeRefresh = undefined;
        if (refs.current.refreshAgain && !refs.current.authExpired) {
          refs.current.refreshAgain = false;
          scheduleRefreshRef.current();
        }
      }
    })();
    refs.current.activeRefresh = run;
    return run;
  }, [api, commitMessages, hydrateParents, loadExecutionBundle, loadWork, selectTrace, trackCompanionTransitions]);

  const scheduleRefresh = useCallback(() => {
    if (refs.current.refreshTimer || refs.current.authExpired) return;
    refs.current.refreshTimer = setTimeout(() => {
      refs.current.refreshTimer = undefined;
      void refreshView().catch(error => {
        setConnection(`数据可能已过时：${errorText(error)}。后台工作不会因页面断开而停止。`, true);
      });
      if (!refs.current.traceHasMore) {
        void loadTrace('live', refs.current.selection, refs.current.selectionGeneration);
      }
    }, 150);
  }, [loadTrace, refreshView, setConnection]);

  scheduleRefreshRef.current = scheduleRefresh;

  useEffect(() => {
    expireAuthRef.current = () => {
      refs.current.authExpired = true;
      refs.current.ready = false;
      setAuthExpired(true);
      setReady(false);
      sseHubRef.current?.stop();
      if (refs.current.reconnectTimer) {
        clearTimeout(refs.current.reconnectTimer);
        refs.current.reconnectTimer = undefined;
      }
      if (refs.current.refreshTimer) {
        clearTimeout(refs.current.refreshTimer);
        refs.current.refreshTimer = undefined;
      }
      setConnection('访问链接已失效。请从当前服务的本地启动链接重新进入（服务重启后需使用新链接）。', true);
    };

    const sseHub = createSharedSseHub({
      token: bootstrap.token,
      request,
      isStopped: () => refs.current.authExpired,
      onConnected: viaLeader => {
        const runtimeStatus = refs.current.view?.health.executorAvailable === false ? '执行器不可用，服务降级' : '后台服务持续运行';
        const prefix = viaLeader ? '本机已连接（共享流）' : '本机已连接';
        setConnection(`${prefix} · ${runtimeStatus}${bootstrap.storageUnavailable ? ' · 当前标签页无法保存访问链接' : ''}`);
      },
      onError: error => {
        if (refs.current.authExpired) return;
        setConnection(`连接已断开 / 数据可能过时：${errorText(error)}。后台工作继续；消息不会自动重发。`, true);
      },
      onUpdates: async (batch: SseUpdateBatch) => {
        if (refs.current.authExpired) return;
        const cursorReset = Boolean(batch.reset) || batch.cursor < refs.current.cursor;
        if (cursorReset) {
          refs.current.pendingCursorReset = true;
          refs.current.cursorResetEpoch += 1;
          refs.current.messages.clear();
          setMessagesMap(new Map());
          refs.current.followedMessage = undefined;
          setFollowedMessage(undefined);
          refs.current.selectionPinned = false;
          setSelectionPinned(false);
          refs.current.traceAfter = 0;
          refs.current.traceEvents = [];
          refs.current.traceHasMore = false;
          setTraceAfter(0);
          setTraceEvents([]);
          setTraceHasMore(false);
          setRawTraceBundle(undefined);
          setWorkData(undefined);
          setOperationCache(new Map());
          refs.current.historyBefore = undefined;
          refs.current.historyHasMore = false;
          setHistoryBefore(undefined);
          setHistoryHasMore(false);
          setStopRequests(new Set());
          refs.current.cursor = batch.cursor;
          scheduleRefreshRef.current();
          return;
        }
        const fresh = batch.events.filter(event => event.seq > refs.current.cursor);
        const ids = [...new Set(
          fresh
            .filter(event => event.type === 'message' || event.kind === 'work_linked')
            .map(event => event.messageId)
            .filter((id): id is string => Boolean(id)),
        )];
        const changed = ids.length ? await fetchMessagesBatch(ids, { priority: 'low' }) : [];
        if (refs.current.authExpired) return;
        commitMessages(changed);
        await hydrateParents();
        if (changed.length) {
          trackCompanionTransitions(false, refs.current.view);
        }
        refs.current.cursor = Math.max(refs.current.cursor, batch.cursor);
        if (fresh.length) scheduleRefreshRef.current();
      },
    });
    sseHubRef.current = sseHub;

    const connect = async (forceReconnect = false): Promise<void> => {
      if (!bootstrap.token || refs.current.authExpired) return;
      const gen = ++refs.current.connectionGeneration;
      if (refs.current.reconnectTimer) {
        clearTimeout(refs.current.reconnectTimer);
        refs.current.reconnectTimer = undefined;
      }
      setConnection(refs.current.ready ? '正在恢复连接，保留上次数据…' : '正在连接本机服务…', refs.current.ready);
      try {
        const initial = !refs.current.view;
        await refreshView(initial);
        if (gen !== refs.current.connectionGeneration || refs.current.authExpired) return;
        if (initial && refs.current.selectionGeneration === 0) {
          const latest = findLatestUserMessage(refs.current.messages);
          selectTrace(latest ? { type: 'message', id: latest.id, label: latest.text.slice(0, 80) } : { type: 'all' }, false);
        } else if (!refs.current.traceHasMore) {
          void loadTrace('live', refs.current.selection, refs.current.selectionGeneration);
        }
        refs.current.retryDelay = 500;
        if (forceReconnect && refs.current.sseStarted) {
          sseHub.reconnect(refs.current.cursor);
        } else {
          refs.current.sseStarted = true;
          sseHub.start(refs.current.cursor);
        }
      } catch (error) {
        if (gen !== refs.current.connectionGeneration || refs.current.authExpired) return;
        setConnection(`连接已断开 / 数据可能过时：${errorText(error)}。后台工作继续；消息不会自动重发。`, true);
        refs.current.reconnectTimer = setTimeout(() => {
          void connect(forceReconnect);
        }, refs.current.retryDelay);
        refs.current.retryDelay = Math.min(refs.current.retryDelay * 2, 5000);
      }
    };

    const onPageHide = () => {
      if (refs.current.refreshTimer) {
        clearTimeout(refs.current.refreshTimer);
        refs.current.refreshTimer = undefined;
      }
      sseHub.pause();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || refs.current.authExpired) return;
      if (refs.current.sseStarted) {
        sseHub.resume();
        scheduleRefreshRef.current();
      } else if (bootstrap.token) {
        void connect(true);
      }
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);

    if (bootstrap.token) {
      void connect(false);
    }

    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      sseHub.stop();
      if (refs.current.reconnectTimer) clearTimeout(refs.current.reconnectTimer);
      if (refs.current.refreshTimer) clearTimeout(refs.current.refreshTimer);
      if (refs.current.transientTimer) clearTimeout(refs.current.transientTimer);
    };
    // Run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reconnect = useCallback(() => {
    if (!bootstrap.token || refs.current.authExpired) return;
    refs.current.retryDelay = 500;
    void refreshView(!refs.current.view)
      .then(() => {
        if (refs.current.sseStarted) sseHubRef.current?.reconnect(refs.current.cursor);
        else {
          refs.current.sseStarted = true;
          sseHubRef.current?.start(refs.current.cursor);
        }
      })
      .catch(error => {
        setConnection(`连接已断开 / 数据可能过时：${errorText(error)}。后台工作继续；消息不会自动重发。`, true);
      });
  }, [bootstrap.token, refreshView, setConnection]);

  const loadOlder = useCallback(async (trigger: 'auto' | 'manual' = 'manual'): Promise<number> => {
    if (refs.current.historyBusy || refs.current.historyBefore === undefined) return 0;
    if (trigger === 'auto' && !refs.current.historyHasMore) return 0;
    const beforeAtStart = refs.current.historyBefore;
    const cursorAtStart = refs.current.cursor;
    refs.current.historyBusy = true;
    setHistoryBusy(true);
    setHistoryError('');
    refs.current.olderAbort?.abort();
    const controller = new AbortController();
    refs.current.olderAbort = controller;
    try {
      const page = await api<MessagePage>(`/api/history?before=${beforeAtStart}`, undefined, {
        signal: controller.signal,
        ...(trigger === 'auto' ? { priority: 'low' as const } : {}),
      });
      if (
        controller.signal.aborted
        || refs.current.authExpired
        || refs.current.cursor < cursorAtStart
        || refs.current.historyBefore !== beforeAtStart
      ) {
        return 0;
      }
      commitMessages(page.items);
      refs.current.historyBefore = page.before;
      refs.current.historyHasMore = page.hasMore;
      setHistoryBefore(page.before);
      setHistoryHasMore(page.hasMore);
      return page.items.length;
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return 0;
      setHistoryError(`更早消息读取失败：${errorText(error)}。可点击上方重试。`);
      return 0;
    } finally {
      if (refs.current.olderAbort === controller) refs.current.olderAbort = undefined;
      refs.current.historyBusy = false;
      setHistoryBusy(false);
    }
  }, [api, commitMessages]);

  const sendDraft = useCallback(async (rawText: string): Promise<boolean> => {
    if (sending || !refs.current.ready || refs.current.authExpired) return false;
    let submitted: Submission | undefined = uncertain ? pending : undefined;
    if (!uncertain) {
      const trimmed = rawText.trim();
      if (!trimmed) return false;
      try {
        submitted = { requestId: makeRequestId(), text: trimmed, files: [] };
        setPending(submitted);
      } catch (error) {
        setSendFeedback({ text: `发送失败，草稿已保留：${errorText(error)}`, tone: 'error' });
        return false;
      }
    }
    if (!submitted) return false;
    setSending(true);
    setSendFeedback({ text: '', tone: 'clear' });
    try {
      const accepted = await api<ChatMessage>('/api/chat', submitted);
      commitMessages([accepted]);
      setPending(undefined);
      setUncertain(false);
      setDraftTyping(false);
      selectTrace({ type: 'message', id: accepted.id, label: submitted.text.slice(0, 80) }, true);
      scheduleRefresh();
      return true;
    } catch (error) {
      const confirmed = [...refs.current.messages.values()].some(m => m.requestId === submitted.requestId);
      if (confirmed) {
        setPending(undefined);
        setUncertain(false);
        setDraftTyping(false);
        setSendFeedback({ text: '已从持久记录确认接收，无需重发。', tone: 'status' });
        return true;
      }
      const nextUncertain = !(error instanceof ApiError) || error.status >= 500;
      setUncertain(nextUncertain);
      if (!nextUncertain) setPending(undefined);
      setSendFeedback({
        text: nextUncertain
          ? `接收结果未确认：${errorText(error)}。草稿已保留并锁定；点击“重试原请求”会使用同一请求标识，不自动重发。`
          : `发送失败，草稿已保留：${errorText(error)}`,
        tone: 'error',
      });
      return false;
    } finally {
      setSending(false);
    }
  }, [api, commitMessages, pending, scheduleRefresh, selectTrace, sending, uncertain]);

  const sendDirectText = useCallback(async (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed || sending || !refs.current.ready || refs.current.authExpired || uncertain) return;
    let payload: Submission;
    try {
      payload = { requestId: makeRequestId(), text: trimmed, files: [] };
    } catch (error) {
      setSendFeedback({ text: `发送失败：${errorText(error)}`, tone: 'error' });
      return;
    }
    setSending(true);
    setSendFeedback({ text: '', tone: 'clear' });
    try {
      const accepted = await api<ChatMessage>('/api/chat', payload);
      commitMessages([accepted]);
      selectTrace({ type: 'message', id: accepted.id, label: trimmed.slice(0, 80) }, true);
      scheduleRefresh();
    } catch (error) {
      setSendFeedback({ text: `快捷回复发送失败：${errorText(error)}`, tone: 'error' });
    } finally {
      setSending(false);
    }
  }, [api, commitMessages, scheduleRefresh, selectTrace, sending, uncertain]);

  const stopMessage = useCallback(async (id: string) => {
    const key = `message:${id}`;
    setStopRequests(prev => new Set(prev).add(key));
    try {
      await api<unknown>('/api/chat-stop', { messageId: id });
      setConnection('已请求停止本轮回复；以最终记录为准。其他后台工作不受影响。');
      scheduleRefresh();
    } catch (error) {
      setStopRequests(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setConnection(`停止请求未确认：${errorText(error)}。可再次请求；本轮回复不一定已停止。`, true);
    }
  }, [api, scheduleRefresh, setConnection]);

  const stopWork = useCallback(async (target?: string) => {
    const id = target ?? (refs.current.selection.type === 'task' ? refs.current.selection.id : undefined);
    if (!id) return;
    const key = `task:${id}`;
    setStopRequests(prev => new Set(prev).add(key));
    try {
      const updated = await api<unknown>('/api/stop', { taskId: id });
      if (refs.current.selection.type === 'task' && refs.current.selection.id === id) {
        setWorkData(updated);
      }
      setConnection('已请求停止工作；以最终状态为准。');
      scheduleRefresh();
    } catch (error) {
      setStopRequests(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      setConnection(`停止请求未确认：${errorText(error)}。可再次请求；工作不一定已停止。`, true);
    }
  }, [api, scheduleRefresh, setConnection]);

  const resumeWork = useCallback(async (taskId: string) => {
    try {
      const updated = await api<unknown>('/api/resume', { taskId });
      if (refs.current.selection.type === 'task' && refs.current.selection.id === taskId) {
        setWorkData(updated);
        void loadExecutionBundle(refs.current.selection, refs.current.selectionGeneration);
      }
      setConnection('已确认恢复运行工作。');
      scheduleRefresh();
    } catch (error) {
      setConnection(`恢复工作失败：${errorText(error)}`, true);
    }
  }, [api, loadExecutionBundle, scheduleRefresh, setConnection]);

  const loadEarlierTrace = useCallback(async () => {
    await loadTrace('earlier', refs.current.selection, refs.current.selectionGeneration);
  }, [loadTrace]);

  const refreshSelectedWork = useCallback(() => {
    if (refs.current.selection.type === 'task') {
      void loadWork(refs.current.selection.id, refs.current.selectionGeneration);
    }
    void loadExecutionBundle(refs.current.selection, refs.current.selectionGeneration);
  }, [loadExecutionBundle, loadWork]);

  const loadOperationOutput = useCallback(async (taskId: string, operationId: string) => {
    const key = `${taskId}:${operationId}`;
    const existing = operationCache.get(key);
    if (existing?.loading || existing?.text || existing?.error) return;
    setOperationCache(prev => new Map(prev).set(key, { loading: true }));
    try {
      const raw = await api<unknown>(
        `/api/operation?${new URLSearchParams({ taskId, operationId })}`,
        undefined,
        { priority: 'low' },
      );
      const parsed = extractReadableOperationOutput(raw);
      setOperationCache(prev =>
        new Map(prev).set(key, {
          text: parsed.text || (parsed.error ? '' : '（该后台操作未记录输出文本）'),
          ...(parsed.error ? { error: parsed.error } : {}),
        }),
      );
    } catch (error) {
      setOperationCache(prev => new Map(prev).set(key, { error: errorText(error) }));
    }
  }, [api, operationCache]);

  const jumpMessage = useCallback(async (id: string) => {
    try {
      if (!refs.current.messages.has(id)) {
        const fetched = await api<ChatMessage>(`/api/message?${new URLSearchParams({ messageId: id })}`);
        commitMessages([fetched]);
      }
      setChannelFilter('all');
      setHideSystem(false);
      setMobilePanel('chat');
      setJumpTarget({ id, seq: ++refs.current.jumpSeq });
    } catch (error) {
      setConnection(`来源消息读取失败：${errorText(error)}`, true);
    }
  }, [api, commitMessages, setChannelFilter, setConnection, setHideSystem]);

  const orderedMessages = useMemo(() => orderConversation(messagesMap.values()), [messagesMap]);
  const works = useMemo(() => view?.works ?? [], [view]);

  const traceBundle = useMemo<ExecutionTraceBundle>(() => {
    if (rawTraceBundle) return rawTraceBundle;
    return buildFallbackBundleFromAppState({
      selection,
      cursor: refs.current.cursor,
      traceEvents,
      messages: messagesMap.values(),
      works,
      workData,
    });
  }, [messagesMap, rawTraceBundle, selection, traceEvents, workData, works]);

  const chainView = useMemo(() => buildExecutionChain(traceBundle), [traceBundle]);

  const botState = useMemo<BotStateId>(() => {
    if (transientBotState && ready && !authExpired) return transientBotState;
    return deriveFridayBotState({
      ready,
      authExpired,
      staleConnection: connectionStale,
      sending,
      draftTyping,
      voiceListening: Boolean(view?.voiceListening?.capturing && !view?.voiceListening?.transcribing),
      voiceTranscribing: Boolean(view?.voiceListening?.transcribing),
      subconsciousSleeping: Boolean(view?.subconscious?.sleeping),
      messages: messagesMap.values(),
      works,
    });
  }, [authExpired, connectionStale, draftTyping, messagesMap, ready, sending, transientBotState, view, works]);

  // Keep selected node cleared if it disappears from chainView
  useEffect(() => {
    if (selectedNodeId && !chainView.nodes.some((n: ChainActionNode) => n.id === selectedNodeId)) {
      setSelectedNodeId(undefined);
    }
  }, [chainView, selectedNodeId]);

  const value: FridayContextValue = {
    token: bootstrap.token,
    storageUnavailable: bootstrap.storageUnavailable,
    authExpired,
    ready,
    view,
    connectionText,
    connectionStale,
    srStatusText,
    srAlertText,
    announceStatus,
    reconnect,
    messagesMap,
    orderedMessages,
    historyHasMore,
    historyBusy,
    historyError,
    loadOlder,
    sending,
    uncertain,
    pending,
    sendFeedback,
    sendDraft,
    sendDirectText,
    stopMessage,
    stopRequests,
    setDraftTyping,
    channelFilter,
    setChannelFilter,
    hideSystem,
    setHideSystem,
    detailMode,
    setDetailMode,
    works,
    workFilter,
    setWorkFilter,
    stopWork,
    resumeWork,
    selection,
    selectionPinned,
    selectTrace,
    unpinTraceToLatest,
    traceCategory,
    setTraceCategory,
    traceWide,
    setTraceWide,
    traceBundle,
    chainView,
    selectedNodeId,
    setSelectedNodeId,
    workData,
    traceHasMore,
    traceBusy,
    loadEarlierTrace,
    refreshSelectedWork,
    operationCache,
    loadOperationOutput,
    botState,
    leftCollapsed,
    setLeftCollapsed,
    rightCollapsed,
    setRightCollapsed,
    mobilePanel,
    setMobilePanel,
    mobileNavOpen,
    setMobileNavOpen,
    mobileWorksOpen,
    setMobileWorksOpen,
    activeHub,
    setActiveHub,
    systemTab,
    setSystemTab,
    openSystemHub,
    memoryTab,
    setMemoryTab,
    openMemoryHub,
    pluginSurface,
    setPluginSurface,
    openPluginHub,
    api,
    refreshView,
    scheduleRefresh,
    routingDetailMessageId,
    setRoutingDetailMessageId,
    commandOpen,
    setCommandOpen,
    jumpTarget,
    jumpMessage,
  };

  return <FridayContext.Provider value={value}>{children}</FridayContext.Provider>;
}

export { MAX_TRACE_EVENTS };

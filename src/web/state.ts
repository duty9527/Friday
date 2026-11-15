import type { ChatMessage, MainView, TraceEvent, VoiceprintStatusView } from '../view.js';
import { createHttpClient, resolveBootstrapToken } from './shared/auth-http.js';

export type Selection = { type: 'all' } | { type: 'task' | 'message'; id: string; label: string };
export type ModalKey = 'memory' | 'timer' | 'plugin' | 'im' | 'model' | 'health';

export interface Submission {
  requestId: string;
  text: string;
  files: string[];
}

export interface AppHooks {
  connection: (text: string, stale?: boolean) => void;
  expireAuthentication: () => void;
  refreshView: (initial?: boolean) => Promise<void>;
  scheduleRefresh: () => void;
  updateComposer: () => void;
  renderMessages: () => void;
  renderRoutingDetail: () => void;
  jumpMessage: (id: string) => Promise<void>;
  renderWorks: () => void;
  stopWork: (target?: string) => Promise<void>;
  showPanel: (trace: boolean) => void;
  closeSidebar: () => void;
  selectTrace: (next: Selection, pin?: boolean) => void;
  loadTrace: (direction?: 'live' | 'earlier' | 'recent') => Promise<void>;
  loadWork: (id: string, generation: number, background?: boolean) => Promise<void>;
  openPluginHubModal: (pluginName?: string, expandSource?: boolean) => void;
  closeAllHubModals: () => void;
}

const bootstrap = resolveBootstrapToken();

export const appState = {
  token: bootstrap.token,
  storageUnavailable: bootstrap.storageUnavailable,
  authExpired: false,
  ready: false,
  view: undefined as MainView | undefined,
  messages: new Map<string, ChatMessage>(),
  historyBefore: undefined as number | undefined,
  historyHasMore: false,
  historyBusy: false,
  sending: false,
  pending: undefined as Submission | undefined,
  uncertain: false,
  stopRequests: new Set<string>(),
  cursor: 0,
  connectionGeneration: 0,
  streamController: undefined as AbortController | undefined,
  reconnectTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  retryDelay: 500,
  refreshTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  refreshBusy: false,
  refreshAgain: false,
  selection: { type: 'all' } as Selection,
  selectionGeneration: 0,
  selectionPinned: false,
  followedMessage: undefined as string | undefined,
  traceEvents: [] as TraceEvent[],
  traceAfter: 0,
  traceHasMore: false,
  traceHasEarlier: false,
  traceBusy: false,
  traceAgain: false,
  traceMode: 'steps' as 'steps' | 'graph' | 'events',
  selectedEvent: undefined as number | undefined,
  selectedSpan: undefined as string | undefined,
  workData: undefined as unknown,
  workRequest: 0,
  voiceprintState: undefined as VoiceprintStatusView | undefined,
  dirtyModals: new Set<ModalKey>(),
};

export const hooks: AppHooks = {
  connection: () => {},
  expireAuthentication: () => {},
  refreshView: async () => {},
  scheduleRefresh: () => {},
  updateComposer: () => {},
  renderMessages: () => {},
  renderRoutingDetail: () => {},
  jumpMessage: async () => {},
  renderWorks: () => {},
  stopWork: async () => {},
  showPanel: () => {},
  closeSidebar: () => {},
  selectTrace: () => {},
  loadTrace: async () => {},
  loadWork: async () => {},
  openPluginHubModal: () => {},
  closeAllHubModals: () => {},
};

export const http = createHttpClient({
  token: appState.token,
  isExpired: () => appState.authExpired,
  onAuthExpired: () => hooks.expireAuthentication(),
});

export const api = http.api;
export const request = http.request;

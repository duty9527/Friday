import type { TraceEvent } from '../../view.js';
import { consumeSseStream } from './auth-http.js';

export interface SseUpdateBatch {
  events: TraceEvent[];
  cursor: number;
  head: number;
  reset?: boolean;
}

export interface BroadcastChannelLike {
  postMessage: (message: unknown) => void;
  close: () => void;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface SharedSseHubOptions {
  token: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  isStopped: () => boolean;
  onUpdates: (batch: SseUpdateBatch) => void | Promise<void>;
  onConnected?: (viaLeader: boolean) => void;
  onError?: (error: unknown) => void;
  createChannel?: (name: string) => BroadcastChannelLike | undefined;
  tabId?: string;
  disconnectMessage?: string;
}

export interface SharedSseHub {
  start: (initialCursor: number) => void;
  reconnect: (cursor: number) => void;
  setCursor: (cursor: number) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  isLeader: () => boolean;
}

type HubMessage =
  | { type: 'hello'; tabId: string; cursor: number }
  | { type: 'leader-ack'; leaderId: string; cursor: number; connected: boolean }
  | { type: 'leader-bye'; leaderId: string }
  | { type: 'ping'; tabId: string }
  | { type: 'reconnect-request'; tabId: string; cursor: number }
  | { type: 'heartbeat'; leaderId: string; cursor: number; connected: boolean }
  | { type: 'sse-updates'; leaderId: string; batch: SseUpdateBatch }
  | { type: 'sse-status'; leaderId: string; connected: boolean; errorText?: string };

const ELECTION_DELAY_MS = 120;
const HEARTBEAT_INTERVAL_MS = 4000;
const LEADER_STALE_MS = 12_000;
const PING_TIMEOUT_MS = 450;

function makeTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function defaultCreateChannel(name: string): BroadcastChannelLike | undefined {
  if (typeof BroadcastChannel !== 'function') return undefined;
  const native = new BroadcastChannel(name);
  let listener: ((event: { data: unknown }) => void) | null = null;
  return {
    postMessage(message: unknown) {
      native.postMessage(message);
    },
    close() {
      native.close();
    },
    get onmessage() {
      return listener;
    },
    set onmessage(next) {
      listener = next;
      native.onmessage = next ? (event: MessageEvent) => next({ data: event.data }) : null;
    },
  };
}

function safeChannelTag(token: string): string {
  // Derive a short non-secret tag so distinct server sessions on the same port do not collide.
  let hash = 2166136261;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function messageErrorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' && error ? error : '事件流已断开';
}

export function createSharedSseHub(options: SharedSseHubOptions): SharedSseHub {
  const tabId = options.tabId ?? makeTabId();
  const channelFactory = options.createChannel ?? defaultCreateChannel;
  const channelName = `friday.sse-stream.v1:${safeChannelTag(options.token)}`;
  let channel = channelFactory(channelName);

  let active = false;
  let paused = false;
  let stopped = false;
  let role: 'stopped' | 'electing' | 'leader' | 'follower' = 'stopped';
  let currentLeaderId: string | undefined;
  let localCursor = 0;
  let leaderConnected = false;
  let lastLeaderSeenAt = 0;
  let retryDelay = 500;
  let streamGeneration = 0;

  let streamController: AbortController | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let electionTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let monitorTimer: ReturnType<typeof setInterval> | undefined;
  let pingTimer: ReturnType<typeof setTimeout> | undefined;
  let pingPending = false;
  const seenCandidates = new Map<string, number>();

  let updateQueue: Promise<void> = Promise.resolve();

  function post(message: HubMessage): void {
    if (!channel) return;
    try {
      channel.postMessage(message);
    } catch {
      // Channel might already be closing during page teardown.
    }
  }

  function clearLeaderTimers(): void {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
  }

  function clearElectionAndFollowerTimers(): void {
    if (electionTimer) { clearTimeout(electionTimer); electionTimer = undefined; }
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = undefined; }
    if (pingTimer) { clearTimeout(pingTimer); pingTimer = undefined; }
    pingPending = false;
  }

  function enqueueUpdates(batch: SseUpdateBatch): void {
    updateQueue = updateQueue
      .then(async () => {
        if (!active || options.isStopped()) return;
        await options.onUpdates(batch);
      })
      .catch(error => {
        options.onError?.(error);
      });
  }

  function abortStream(): void {
    streamGeneration += 1;
    streamController?.abort();
    streamController = undefined;
    leaderConnected = false;
  }

  async function runLeaderStream(generation: number): Promise<void> {
    if (!active || role !== 'leader' || generation !== streamGeneration || options.isStopped()) return;
    const controller = new AbortController();
    streamController = controller;
    try {
      const response = await options.request(`/api/stream?after=${localCursor}`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      });
      if (!active || role !== 'leader' || generation !== streamGeneration || options.isStopped()) return;
      leaderConnected = true;
      retryDelay = 500;
      options.onConnected?.(false);
      post({ type: 'sse-status', leaderId: tabId, connected: true });
      await consumeSseStream(response, {
        shouldContinue: () => active && role === 'leader' && generation === streamGeneration && !options.isStopped(),
        disconnectMessage: options.disconnectMessage,
        signal: controller.signal,
        onEvent: async (eventName, rawData) => {
          if (eventName !== 'updates' || !active || role !== 'leader' || generation !== streamGeneration) return;
          let batch: SseUpdateBatch;
          try {
            batch = JSON.parse(rawData) as SseUpdateBatch;
          } catch (cause) {
            throw new Error('事件流消息格式错误', { cause });
          }
          const cursorReset = Boolean(batch.reset) || (typeof batch.cursor === 'number' && batch.cursor < localCursor);
          if (cursorReset) localCursor = 0;
          if (typeof batch.cursor === 'number') {
            localCursor = cursorReset ? batch.cursor : Math.max(localCursor, batch.cursor);
          }
          retryDelay = 500;
          post({ type: 'sse-updates', leaderId: tabId, batch });
          enqueueUpdates(batch);
        },
      });
    } catch (error) {
      if (!active || role !== 'leader' || generation !== streamGeneration || controller.signal.aborted || options.isStopped()) {
        return;
      }
      leaderConnected = false;
      const errText = messageErrorText(error);
      options.onError?.(error);
      post({ type: 'sse-status', leaderId: tabId, connected: false, errorText: errText });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void runLeaderStream(generation);
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 5000);
    }
  }

  function enterFollower(leaderId: string, connected: boolean): void {
    clearLeaderTimers();
    abortStream();
    if (electionTimer) { clearTimeout(electionTimer); electionTimer = undefined; }
    role = 'follower';
    currentLeaderId = leaderId;
    lastLeaderSeenAt = Date.now();
    pingPending = false;
    if (pingTimer) { clearTimeout(pingTimer); pingTimer = undefined; }
    if (connected) options.onConnected?.(true);
    if (!monitorTimer && channel) {
      monitorTimer = setInterval(() => {
        if (!active || role !== 'follower' || options.isStopped()) return;
        if (Date.now() - lastLeaderSeenAt < LEADER_STALE_MS || pingPending) return;
        pingPending = true;
        post({ type: 'ping', tabId });
        pingTimer = setTimeout(() => {
          pingTimer = undefined;
          if (!active || role !== 'follower' || !pingPending || options.isStopped()) return;
          pingPending = false;
          startElection(0);
        }, PING_TIMEOUT_MS);
      }, 3000);
    }
  }

  function enterLeader(): void {
    clearElectionAndFollowerTimers();
    clearLeaderTimers();
    role = 'leader';
    currentLeaderId = tabId;
    retryDelay = 500;
    post({ type: 'leader-ack', leaderId: tabId, cursor: localCursor, connected: leaderConnected });
    if (channel) {
      heartbeatTimer = setInterval(() => {
        if (!active || role !== 'leader' || options.isStopped()) return;
        post({ type: 'heartbeat', leaderId: tabId, cursor: localCursor, connected: leaderConnected });
      }, HEARTBEAT_INTERVAL_MS);
    }
    const gen = ++streamGeneration;
    void runLeaderStream(gen);
  }

  function startElection(delayMs = ELECTION_DELAY_MS): void {
    if (!active || options.isStopped()) return;
    if (!channel) {
      enterLeader();
      return;
    }
    clearLeaderTimers();
    clearElectionAndFollowerTimers();
    abortStream();
    role = 'electing';
    currentLeaderId = undefined;
    seenCandidates.clear();
    seenCandidates.set(tabId, Date.now());
    post({ type: 'hello', tabId, cursor: localCursor });
    const finalize = () => {
      electionTimer = undefined;
      if (!active || role !== 'electing' || options.isStopped()) return;
      const now = Date.now();
      const liveCandidates = [...seenCandidates.entries()]
        .filter(([, at]) => now - at < 2000)
        .map(([id]) => id)
        .sort();
      const winner = liveCandidates[0] ?? tabId;
      if (winner === tabId) {
        enterLeader();
      } else {
        // Wait briefly for the winning candidate to assert leadership; retry if it vanishes.
        electionTimer = setTimeout(() => {
          electionTimer = undefined;
          if (active && role === 'electing' && !options.isStopped()) {
            enterLeader();
          }
        }, ELECTION_DELAY_MS * 2);
      }
    };
    if (delayMs <= 0) {
      finalize();
    } else {
      electionTimer = setTimeout(finalize, delayMs);
    }
  }

  function bindChannel(ch: BroadcastChannelLike | undefined): void {
    if (!ch) return;
    ch.onmessage = event => {
      if (!active || options.isStopped()) return;
      const raw = event.data;
      if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
      const msg = raw as HubMessage;
      switch (msg.type) {
        case 'hello': {
          if (msg.tabId === tabId) return;
          seenCandidates.set(msg.tabId, Date.now());
          if (role === 'leader') {
            post({ type: 'leader-ack', leaderId: tabId, cursor: localCursor, connected: leaderConnected });
          }
          break;
        }
        case 'leader-ack': {
          if (msg.leaderId === tabId) return;
          if (role === 'leader' && msg.leaderId > tabId) {
            post({ type: 'leader-ack', leaderId: tabId, cursor: localCursor, connected: leaderConnected });
            return;
          }
          enterFollower(msg.leaderId, msg.connected);
          break;
        }
        case 'heartbeat': {
          if (msg.leaderId === tabId) return;
          if (role === 'leader' && msg.leaderId > tabId) {
            post({ type: 'leader-ack', leaderId: tabId, cursor: localCursor, connected: leaderConnected });
            return;
          }
          if (role !== 'follower' || currentLeaderId !== msg.leaderId) {
            enterFollower(msg.leaderId, msg.connected);
          } else {
            lastLeaderSeenAt = Date.now();
            if (pingPending) {
              pingPending = false;
              if (pingTimer) { clearTimeout(pingTimer); pingTimer = undefined; }
            }
          }
          break;
        }
        case 'ping': {
          if (msg.tabId === tabId) return;
          if (role === 'leader') {
            post({ type: 'leader-ack', leaderId: tabId, cursor: localCursor, connected: leaderConnected });
          }
          break;
        }
        case 'reconnect-request': {
          if (role === 'leader') {
            clearLeaderTimers();
            abortStream();
            retryDelay = 500;
            if (msg.cursor < localCursor) localCursor = msg.cursor;
            enterLeader();
          }
          break;
        }
        case 'leader-bye': {
          if (role === 'follower' && currentLeaderId === msg.leaderId) {
            const jitter = 20 + Math.floor(Math.random() * 60);
            startElection(jitter);
          }
          break;
        }
        case 'sse-updates': {
          if (msg.leaderId === tabId) return;
          if (role !== 'follower') enterFollower(msg.leaderId, true);
          lastLeaderSeenAt = Date.now();
          const cursorReset = Boolean(msg.batch.reset) || (typeof msg.batch.cursor === 'number' && msg.batch.cursor < localCursor);
          if (cursorReset) localCursor = 0;
          if (typeof msg.batch.cursor === 'number') {
            localCursor = cursorReset ? msg.batch.cursor : Math.max(localCursor, msg.batch.cursor);
          }
          enqueueUpdates(msg.batch);
          break;
        }
        case 'sse-status': {
          if (msg.leaderId === tabId) return;
          if (role !== 'follower') enterFollower(msg.leaderId, msg.connected);
          lastLeaderSeenAt = Date.now();
          if (msg.connected) {
            options.onConnected?.(true);
          } else {
            options.onError?.(new Error(msg.errorText ?? '事件流已断开', { cause: msg }));
          }
          break;
        }
      }
    };
  }

  bindChannel(channel);

  function ensureChannelOpen(): void {
    if (!channel) {
      channel = channelFactory(channelName);
      bindChannel(channel);
    }
  }

  function suspendTransport(): void {
    const wasLeader = role === 'leader';
    active = false;
    role = 'stopped';
    clearLeaderTimers();
    clearElectionAndFollowerTimers();
    abortStream();
    if (wasLeader) {
      post({ type: 'leader-bye', leaderId: tabId });
    }
    channel?.close();
    channel = undefined;
  }

  return {
    start(initialCursor: number) {
      if (stopped) return;
      paused = false;
      ensureChannelOpen();
      localCursor = initialCursor;
      active = true;
      if (role === 'leader') {
        clearLeaderTimers();
        abortStream();
        retryDelay = 500;
        const gen = ++streamGeneration;
        void runLeaderStream(gen);
        return;
      }
      if (role === 'follower') {
        post({ type: 'ping', tabId });
        return;
      }
      startElection(ELECTION_DELAY_MS);
    },
    reconnect(cursor: number) {
      if (stopped) return;
      paused = false;
      ensureChannelOpen();
      localCursor = cursor;
      active = true;
      retryDelay = 500;
      if (!channel || role === 'leader') {
        enterLeader();
        return;
      }
      if (role === 'follower') {
        post({ type: 'reconnect-request', tabId, cursor });
        if (!pingPending) {
          pingPending = true;
          post({ type: 'ping', tabId });
          pingTimer = setTimeout(() => {
            pingTimer = undefined;
            if (!active || role !== 'follower' || !pingPending || options.isStopped()) return;
            pingPending = false;
            startElection(0);
          }, PING_TIMEOUT_MS);
        }
        return;
      }
      startElection(ELECTION_DELAY_MS);
    },
    setCursor(cursor: number) {
      localCursor = cursor;
    },
    pause() {
      if (stopped || paused) return;
      paused = true;
      suspendTransport();
    },
    resume() {
      if (stopped || !paused || options.isStopped()) return;
      paused = false;
      ensureChannelOpen();
      active = true;
      retryDelay = 500;
      startElection(ELECTION_DELAY_MS);
    },
    stop() {
      stopped = true;
      paused = false;
      suspendTransport();
    },
    isLeader() {
      return role === 'leader';
    },
  };
}

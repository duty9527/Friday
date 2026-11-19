import { record } from '../model.js';

export const TOKEN_STORAGE_KEY = 'friday.local-access-token';
export const LEGACY_TOKEN_STORAGE_KEY = 'super-agent.local-access-token';
export const OPEN_AUTH_COOKIE_NAME = 'friday_auth_mode';
export const OPEN_AUTH_SENTINEL_TOKEN = '0'.repeat(64);
const TOKEN_PATTERN = /^[a-f\d]{64}$/i;
const DEFAULT_MAX_SSE_BUFFER_BYTES = 4_300_000;

export interface BootstrapTokenState {
  token: string;
  storageUnavailable: boolean;
}

export function isValidAccessToken(candidate: string): boolean {
  return TOKEN_PATTERN.test(candidate);
}

/**
 * Returns true when the server has signaled no-auth LAN mode via a SameSite cookie.
 */
export function hasOpenAuthCookie(): boolean {
  if (typeof document === 'undefined' || typeof document.cookie !== 'string') return false;
  return /(?:^|;\s*)friday_auth_mode=none(?:;|$)/.test(document.cookie);
}

/**
 * Extracts and validates `#token=...` from the URL fragment (always stripping the fragment
 * from browser history), with read-and-migrate fallback from the legacy storage key.
 */
export function resolveBootstrapToken(): BootstrapTokenState {
  let token = '';
  let storageUnavailable = false;
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has('token')) {
    const candidate = fragment.get('token') ?? '';
    // Consume even an invalid fragment; it must not leak through copied links or referrers.
    history.replaceState(null, '', location.pathname + location.search);
    try {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      sessionStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
      if (isValidAccessToken(candidate)) sessionStorage.setItem(TOKEN_STORAGE_KEY, candidate);
    } catch {
      storageUnavailable = true;
    }
    if (isValidAccessToken(candidate)) token = candidate;
  } else {
    try {
      const current = sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
      if (isValidAccessToken(current)) {
        token = current;
        sessionStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
      } else {
        const legacy = sessionStorage.getItem(LEGACY_TOKEN_STORAGE_KEY) ?? '';
        sessionStorage.removeItem(LEGACY_TOKEN_STORAGE_KEY);
        if (isValidAccessToken(legacy)) {
          token = legacy;
          sessionStorage.setItem(TOKEN_STORAGE_KEY, legacy);
        }
      }
    } catch {
      storageUnavailable = true;
    }
    if (!isValidAccessToken(token) && hasOpenAuthCookie()) {
      return { token: OPEN_AUTH_SENTINEL_TOKEN, storageUnavailable };
    }
  }
  return { token: isValidAccessToken(token) ? token : '', storageUnavailable };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface HttpClientOptions {
  token: string;
  isExpired?: () => boolean;
  onAuthExpired?: () => void;
  missingTokenMessage?: string;
}

export interface HttpClient {
  request: (path: string, init?: RequestInit) => Promise<Response>;
  api: <T>(path: string, body?: unknown) => Promise<T>;
}

/**
 * Creates authenticated JSON/HTTP helpers bound to a local access token.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const missingMessage = options.missingTokenMessage ?? '请使用当前服务生成的本地启动链接进入。';

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!options.token || options.isExpired?.()) throw new ApiError(missingMessage, 401);
    const headers = new Headers(init.headers);
    if (!(options.token === OPEN_AUTH_SENTINEL_TOKEN && hasOpenAuthCookie())) {
      headers.set('Authorization', `Bearer ${options.token}`);
    }
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...init, headers, credentials: 'omit', cache: 'no-store' });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => ({}));
      if (response.status === 401) options.onAuthExpired?.();
      const message = record(body).error;
      throw new ApiError(typeof message === 'string' ? message : `本机服务返回 ${response.status}`, response.status);
    }
    return response;
  }

  async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return response.json() as Promise<T>;
  }

  return { request, api };
}

export interface SseStreamOptions {
  shouldContinue: () => boolean;
  onEvent: (eventName: string, rawData: string) => void | Promise<void>;
  maxBufferBytes?: number;
  disconnectMessage?: string;
}

/**
 * Reads an SSE response stream and invokes `onEvent` per dispatched frame.
 * Throws on `problem` frames, oversized buffers, or unexpected stream termination.
 */
export async function consumeSseStream(response: Response, options: SseStreamOptions): Promise<void> {
  if (!response.body) throw new Error('浏览器未提供流式响应');
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_SSE_BUFFER_BYTES;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let data: string[] = [];

  async function dispatch(): Promise<void> {
    if (!data.length) {
      eventName = '';
      return;
    }
    const raw = data.join('\n');
    data = [];
    const name = eventName;
    eventName = '';
    if (name === 'problem') {
      let message = '事件流暂不可用';
      try {
        const parsed = record(JSON.parse(raw));
        if (typeof parsed.error === 'string' && parsed.error) message = parsed.error;
      } catch { /* fall back to default */ }
      throw new Error(message);
    }
    await options.onEvent(name, raw);
  }

  try {
    while (options.shouldContinue()) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > maxBufferBytes) throw new Error('事件流记录超过可处理长度');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line) {
          await dispatch();
        } else if (line.startsWith('event:')) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
        // SSE comments are heartbeats, not activity or invented counters.
      }
    }
    if (options.shouldContinue()) throw new Error(options.disconnectMessage ?? '事件流已断开');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Socket } from 'node:net';
import { integer, request, REQUEST_LIMIT } from './protocol.js';
import type { TraceEvent } from './view.js';

class HttpFailure extends Error { constructor(readonly status: number, message: string) { super(message); } }
const staticRoutes: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/mindmap': 'mindmap.html',
  '/mindmap.html': 'mindmap.html',
  '/favicon.ico': 'logo.png',
};
const staticMimeTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};
const adjacentWebRoot = resolve(fileURLToPath(new URL('./web/', import.meta.url)));
const webRoot = existsSync(resolve(adjacentWebRoot, 'client.js'))
  ? adjacentWebRoot
  : resolve(fileURLToPath(new URL('../dist/web/', import.meta.url)));
const webRootPrefix = `${webRoot}${sep}`;

function resolveStaticAsset(pathname: string): { filePath: string; mime: string } | undefined {
  const mapped = Object.hasOwn(staticRoutes, pathname) ? staticRoutes[pathname] : undefined;
  let relative: string;
  if (mapped) {
    relative = mapped;
  } else {
    let decoded: string;
    try { decoded = decodeURIComponent(pathname); }
    catch { return undefined; }
    if (!decoded || decoded.includes('\0') || decoded.includes('\\')) return undefined;
    const stripped = decoded.replace(/^\/+/, '');
    const segments = stripped.split('/');
    if (!stripped || segments.some(segment => !segment || segment === '.' || segment === '..')) return undefined;
    relative = segments.join('/');
  }
  const filePath = resolve(webRoot, relative);
  if (!filePath.startsWith(webRootPrefix)) return undefined;
  const ext = extname(filePath).toLowerCase();
  const mime = Object.hasOwn(staticMimeTypes, ext) ? staticMimeTypes[ext] : undefined;
  return mime ? { filePath, mime } : undefined;
}
const policy = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
function send(
  response: ServerResponse,
  status: number,
  result: unknown,
  options?: { close?: boolean; incoming?: IncomingMessage },
) {
  if (response.destroyed) {
    if (options?.close) options.incoming?.destroy();
    return;
  }
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
  if (options?.close) headers.connection = 'close';
  response.writeHead(status, headers);
  response.end(JSON.stringify(result), () => {
    if (options?.close) options.incoming?.destroy();
  });
}
async function rawBytes(request: IncomingMessage): Promise<Buffer> {
  if (Number(request.headers['content-length']) > REQUEST_LIMIT) throw new HttpFailure(413, 'Request exceeds 64 KiB limit');
  return new Promise<Buffer>((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    const cleanup = () => { request.off('data', onData); request.off('end', onEnd); request.off('error', onError); request.off('aborted', onAborted); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onAborted = () => onError(new HttpFailure(400, 'Request aborted before acceptance'));
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > REQUEST_LIMIT) { cleanup(); request.pause(); reject(new HttpFailure(413, 'Request exceeds 64 KiB limit')); }
      else chunks.push(chunk);
    };
    request.on('data', onData); request.once('end', onEnd); request.once('error', onError); request.once('aborted', onAborted);
  });
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new HttpFailure(415, 'Use application/json');
  const bytes = await rawBytes(request);
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new HttpFailure(400, 'Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpFailure(400, 'Expected a JSON object');
  return value as Record<string, unknown>;
}
async function bridge(home: string, command: unknown): Promise<unknown> {
  const encoded = JSON.stringify(command);
  if (encoded === undefined || Buffer.byteLength(`${encoded}\n`, 'utf8') > REQUEST_LIMIT) {
    throw new HttpFailure(413, 'Request exceeds 64 KiB IPC limit');
  }
  try { return await request(home, command); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(String(code)) || (error instanceof Error && /^(Service request timed out|Service closed without a response|Response too large|Response exceeds limit|Invalid service response)/.test(error.message))) throw new HttpFailure(503, '协调服务连接不可用；已记录的内容不会因断线而重发。');
    if (error instanceof Error && error.message === 'Request is too large') throw new HttpFailure(413, 'Request exceeds 64 KiB IPC limit');
    throw new HttpFailure(400, error instanceof Error ? error.message : 'Service request failed');
  }
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]!);
    }
  }));
  return results;
}

function isValidHttpHostHeader(rawHost: unknown): rawHost is string {
  if (typeof rawHost !== 'string' || !rawHost || rawHost.length > 255 || /[\s\\/@]/.test(rawHost)) {
    return false;
  }
  try {
    const parsed = new URL(`http://${rawHost}`);
    return Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && parsed.pathname === '/'
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

interface SseClient {
  response: ServerResponse;
  cursor: number;
  heartbeat: number;
  draining: boolean;
  drainingSince: number;
  cleanup: () => void;
}

function createSseBroadcaster(home: string) {
  const clients = new Set<SseClient>();
  let loopController: AbortController | undefined;
  let sleepController: AbortController | undefined;
  let running: Promise<void> | undefined;
  let lastHead = 0;
  let closed = false;

  const wake = () => {
    sleepController?.abort();
  };

  const removeClient = (client: SseClient) => {
    if (!clients.delete(client)) return;
    client.cleanup();
    if (!client.response.destroyed && !client.response.writableEnded) {
      client.response.end();
    }
    if (clients.size === 0) {
      loopController?.abort();
      wake();
    }
  };

  const writeClient = (client: SseClient, chunk: string): boolean => {
    if (client.response.destroyed || client.response.writableEnded) {
      removeClient(client);
      return false;
    }
    if (client.draining) {
      if (Date.now() - client.drainingSince > 15_000) removeClient(client);
      return false;
    }
    const writable = client.response.write(chunk);
    if (!writable) {
      client.draining = true;
      client.drainingSince = Date.now();
    }
    return true;
  };

  const startLoop = () => {
    if (running || closed) return;
    const controller = new AbortController();
    loopController = controller;
    let currentRun: Promise<void> | undefined;
    currentRun = (async () => {
      try {
        while (!controller.signal.aborted && clients.size > 0 && !closed) {
          let minCursor = Number.MAX_SAFE_INTEGER;
          for (const client of clients) {
            if (!client.draining && client.cursor < minCursor) minCursor = client.cursor;
          }
          if (minCursor === Number.MAX_SAFE_INTEGER) {
            for (const client of clients) {
              if (Date.now() - client.drainingSince > 15_000) removeClient(client);
            }
            if (clients.size === 0) break;
            const sleep = new AbortController();
            sleepController = sleep;
            const onLoopAbort = () => sleep.abort();
            controller.signal.addEventListener('abort', onLoopAbort, { once: true });
            try { await delay(300, undefined, { signal: sleep.signal, ref: false }); }
            catch { /* woken or aborted */ }
            finally {
              controller.signal.removeEventListener('abort', onLoopAbort);
              if (sleepController === sleep) sleepController = undefined;
            }
            continue;
          }

          const batch = await bridge(home, { command: 'updates', after: minCursor }) as { events: TraceEvent[]; cursor: number; head: number };
          if (controller.signal.aborted || clients.size === 0) break;
          lastHead = batch.head < lastHead ? batch.head : Math.max(lastHead, batch.head);
          const now = Date.now();

          for (const client of [...clients]) {
            if (client.draining) {
              if (now - client.drainingSince > 15_000) removeClient(client);
              continue;
            }
            const cursorRolledBack = batch.head < client.cursor;
            if (cursorRolledBack) {
              client.cursor = 0;
            }
            const relevant = batch.events.length
              ? batch.events.filter(event => event.seq > client.cursor)
              : [];
            if (relevant.length) {
              const clientCursor = relevant.at(-1)?.seq ?? client.cursor;
              const payload = relevant.length === batch.events.length
                ? batch
                : { events: relevant, cursor: clientCursor, head: batch.head };
              if (writeClient(client, `event: updates\ndata: ${JSON.stringify(payload)}\n\n`)) {
                client.cursor = clientCursor;
                client.heartbeat = now;
              }
            } else if (cursorRolledBack) {
              if (writeClient(client, `event: updates\ndata: ${JSON.stringify({ events: [], cursor: 0, head: batch.head, reset: true })}\n\n`)) {
                client.heartbeat = now;
              }
            } else {
              if (batch.cursor > client.cursor && batch.events.length === 0) {
                client.cursor = batch.cursor;
              }
              if (now - client.heartbeat >= 5000) {
                if (writeClient(client, ': heartbeat\n\n')) client.heartbeat = now;
              }
            }
          }

          let nextMinCursor = Number.MAX_SAFE_INTEGER;
          for (const client of clients) {
            if (!client.draining && client.cursor < nextMinCursor) nextMinCursor = client.cursor;
          }
          if (nextMinCursor >= batch.head && clients.size > 0 && !controller.signal.aborted) {
            const sleep = new AbortController();
            sleepController = sleep;
            const onLoopAbort = () => sleep.abort();
            controller.signal.addEventListener('abort', onLoopAbort, { once: true });
            try { await delay(300, undefined, { signal: sleep.signal, ref: false }); }
            catch { /* woken or aborted */ }
            finally {
              controller.signal.removeEventListener('abort', onLoopAbort);
              if (sleepController === sleep) sleepController = undefined;
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : 'Event stream unavailable';
          for (const client of [...clients]) {
            if (!client.response.destroyed && !client.response.writableEnded) {
              client.response.write(`event: problem\ndata: ${JSON.stringify({ error: message })}\n\n`);
            }
            removeClient(client);
          }
        }
      } finally {
        if (loopController === controller) loopController = undefined;
        if (currentRun && running === currentRun) running = undefined;
        if (clients.size > 0 && !closed) startLoop();
      }
    })();
    running = currentRun;
  };

  return {
    get clientCount() { return clients.size; },
    add(response: ServerResponse, after: number) {
      if (closed) { response.end(); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' });
      response.flushHeaders();
      const onClose = () => removeClient(client);
      const onDrain = () => {
        client.draining = false;
        if (client.cursor < lastHead) wake();
      };
      const client: SseClient = {
        response,
        cursor: after,
        heartbeat: 0,
        draining: false,
        drainingSince: 0,
        cleanup: () => {
          response.off('close', onClose);
          response.off('drain', onDrain);
        },
      };
      response.once('close', onClose);
      response.on('drain', onDrain);
      clients.add(client);
      if (!running) startLoop();
      else if (after < lastHead) wake();
    },
    closeAll() {
      closed = true;
      loopController?.abort();
      wake();
      for (const client of [...clients]) removeClient(client);
    },
  };
}

export interface StartWebOptions {
  home: string;
  port?: number;
  host?: string;
  allowHosts?: readonly string[];
  auth?: boolean;
  token?: string;
}

export async function startWeb(options: StartWebOptions): Promise<{ url: string; home: string; close(): Promise<void> }> {
  const home = resolve(options.home);
  const port = integer(options.port, 0, 0, 65535);
  const bindHost = options.host?.trim() || '127.0.0.1';
  const requireAuth = options.auth !== false;
  if (options.token !== undefined && !/^[a-f\d]{64}$/i.test(options.token)) {
    throw new Error('Web token must be a 64-character hex string');
  }
  const normalizedAllowHosts: string[] = [];
  for (const rawEntry of options.allowHosts ?? []) {
    for (const part of rawEntry.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (!isValidHttpHostHeader(trimmed)) {
        throw new Error(`Invalid allowed Host: ${trimmed}`);
      }
      normalizedAllowHosts.push(trimmed.toLowerCase());
    }
  }
  await bridge(home, { command: 'health' });
  const assetCache = new Map<string, Buffer>();
  const loadAsset = async (filePath: string) => {
    let cached = assetCache.get(filePath);
    if (!cached) {
      try { cached = await readFile(filePath); }
      catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') throw new HttpFailure(404, 'Not found');
        throw error;
      }
      assetCache.set(filePath, cached);
    }
    return cached;
  };
  const indexAsset = resolveStaticAsset('/');
  if (!indexAsset) throw new Error('Missing web entrypoint');
  await loadAsset(indexAsset.filePath);
  const sseBroadcaster = createSseBroadcaster(home);
  const token = requireAuth ? (options.token ?? randomBytes(32).toString('hex')) : '';
  const credential = requireAuth ? Buffer.from(`Bearer ${token}`) : undefined;
  let host = '';
  const allowedHosts = new Set<string>();
  const connections = new Set<Socket>();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, (incoming, response) => {
    response.setHeader('content-security-policy', policy);
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    response.setHeader('cross-origin-opener-policy', 'same-origin');
    void (async () => {
      if (!isValidHttpHostHeader(incoming.headers.host)) throw new HttpFailure(403, 'Invalid local Host');
      const reqHost = incoming.headers.host.toLowerCase();
      const reqOrigin = new URL(`http://${reqHost}`).origin;
      let url: URL;
      try {
        url = new URL(incoming.url ?? '/', reqOrigin);
      } catch {
        throw new HttpFailure(400, 'Malformed request URL');
      }
      if (url.origin !== reqOrigin) throw new HttpFailure(403, 'Invalid request origin');
      if (url.pathname.startsWith('/im/webhook/')) {
        if ('origin' in incoming.headers || 'sec-fetch-site' in incoming.headers) {
          throw new HttpFailure(403, 'Cross-site browser webhook access is forbidden');
        }
        let channelId: string;
        try {
          channelId = decodeURIComponent(url.pathname.slice('/im/webhook/'.length));
        } catch {
          throw new HttpFailure(400, 'Malformed IM webhook channel ID');
        }
        if (!channelId) throw new HttpFailure(404, 'Missing IM channel ID');
        if (channelId.includes('/') || channelId.includes('\0')) {
          throw new HttpFailure(400, 'Invalid IM channel ID');
        }
        const method = incoming.method ?? 'POST';
        const raw = method === 'GET' || method === 'HEAD' ? '' : (await rawBytes(incoming)).toString('utf8');
        const result = await bridge(home, {
          command: 'im-webhook',
          channelId,
          method,
          query: url.searchParams.toString(),
          headers: incoming.headers,
          rawBody: raw,
        }) as { status: number; body: string; contentType: string };
        response.writeHead(result.status, { 'content-type': result.contentType });
        response.end(method === 'HEAD' ? undefined : result.body);
        return;
      }
      if (!allowedHosts.has(reqHost)) throw new HttpFailure(403, 'Invalid local Host');
      if (!url.pathname.startsWith('/api/')) {
        if (!['GET', 'HEAD'].includes(incoming.method ?? '')) throw new HttpFailure(404, 'Not found');
        const rawPath = (incoming.url ?? '/').split('?')[0] ?? '/';
        if (rawPath.includes('..') || rawPath.toLowerCase().includes('%2e%2e')) throw new HttpFailure(404, 'Not found');
        const asset = resolveStaticAsset(url.pathname);
        if (!asset) throw new HttpFailure(404, 'Not found');
        const bytes = await loadAsset(asset.filePath);
        const headers: Record<string, string> = { 'content-type': asset.mime };
        if (asset.mime.startsWith('text/html')) {
          if (!requireAuth) {
            headers['set-cookie'] = 'friday_auth_mode=none; Path=/; SameSite=Strict';
          } else if (typeof incoming.headers.cookie === 'string' && incoming.headers.cookie.includes('friday_auth_mode=')) {
            headers['set-cookie'] = 'friday_auth_mode=; Path=/; Max-Age=0; SameSite=Strict';
          }
        }
        response.writeHead(200, headers);
        response.end(incoming.method === 'HEAD' ? undefined : bytes);
        return;
      }
      const secFetchSite = incoming.headers['sec-fetch-site'];
      if (
        (incoming.headers.origin && incoming.headers.origin.toLowerCase() !== reqOrigin)
        || (typeof secFetchSite === 'string' && secFetchSite !== 'same-origin' && secFetchSite !== 'none')
      ) {
        throw new HttpFailure(403, 'Cross-origin API access is forbidden');
      }
      if (credential) {
        const authorization = incoming.headers.authorization;
        const supplied = Buffer.from(typeof authorization === 'string' ? authorization : '');
        if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) throw new HttpFailure(401, '请使用 web 命令输出的本地访问链接；访问令牌缺失或已失效。');
      }
      const search = url.searchParams;
      const numeric = (name: string) => {
        if (!search.has(name)) return undefined;
        try { return integer(Number(search.get(name)), 0, 0, Number.MAX_SAFE_INTEGER); }
        catch { throw new HttpFailure(400, `Invalid ${name} cursor`); }
      };
      const sanitizeVoiceprint = (raw: unknown): unknown => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
        const { modelPath: _omit, ...rest } = raw as Record<string, unknown>;
        return rest;
      };
      if (incoming.method === 'GET') {
        if (url.pathname === '/api/stream') { sseBroadcaster.add(response, numeric('after') ?? 0); return; }
        if (url.pathname === '/api/voiceprints') {
          send(response, 200, sanitizeVoiceprint(await bridge(home, { command: 'voice-status' })));
          return;
        }
        if (url.pathname === '/api/messages') {
          const ids: string[] = [];
          const seen = new Set<string>();
          for (const rawParam of search.getAll('ids')) {
            for (const part of rawParam.split(',')) {
              const id = part.trim();
              if (!id) continue;
              if (id.length > 128) throw new HttpFailure(400, 'Invalid message ID');
              if (seen.has(id)) continue;
              seen.add(id);
              ids.push(id);
              if (ids.length > 200) throw new HttpFailure(400, 'Too many message IDs requested');
            }
          }
          if (ids.length === 0) {
            send(response, 200, { items: [] });
            return;
          }
          let items: unknown[];
          try {
            const res = await bridge(home, { command: 'messages', ids });
            items = Array.isArray(res)
              ? res
              : (res && typeof res === 'object' && 'items' in res && Array.isArray((res as { items: unknown }).items)
                ? (res as { items: unknown[] }).items
                : []);
          } catch (error) {
            if (!(error instanceof HttpFailure) || error.status !== 400 || !/Unknown command/i.test(error.message)) {
              throw error;
            }
            const fetched = await mapWithConcurrency(ids, 8, async messageId => {
              try {
                return await bridge(home, { command: 'message', messageId });
              } catch (itemError) {
                if (itemError instanceof HttpFailure && itemError.status === 503) throw itemError;
                return undefined;
              }
            });
            items = fetched.filter(item => item !== undefined && item !== null);
          }
          send(response, 200, { items });
          return;
        }
        let command: Record<string, unknown>;
        switch (url.pathname) {
          case '/api/view': command = { command: 'view' }; break;
          case '/api/mindmap': command = { command: 'mindmap', before: numeric('before'), limit: numeric('limit') }; break;
          case '/api/message': command = { command: 'message', messageId: search.get('messageId') }; break;
          case '/api/history': command = { command: 'history', before: numeric('before') }; break;
          case '/api/trace': command = { command: 'trace', messageId: search.get('messageId') ?? undefined, taskId: search.get('taskId') ?? undefined, after: numeric('after'), before: numeric('before') }; break;
          case '/api/execution-trace': command = { command: 'execution-trace', taskId: search.get('taskId') ?? undefined, messageId: search.get('messageId') ?? undefined, limit: numeric('limit') }; break;
          case '/api/work': command = { command: 'get', taskId: search.get('taskId') }; break;
          case '/api/timers': command = { command: 'timer-list' }; break;
          case '/api/plugins': command = { command: 'plugin-list' }; break;
          case '/api/im-channels': command = { command: 'im-list' }; break;
          case '/api/models': command = { command: 'model-hub' }; break;
          case '/api/usage': {
            let tzOffsetMin: number | undefined;
            if (search.has('tzOffsetMin')) {
              const rawTz = search.get('tzOffsetMin') ?? '';
              if (!rawTz.trim()) throw new HttpFailure(400, 'Invalid tzOffsetMin');
              try { tzOffsetMin = integer(Number(rawTz), 0, -840, 840); }
              catch { throw new HttpFailure(400, 'Invalid tzOffsetMin'); }
            }
            const granularity = search.get('granularity') || undefined;
            const anchorDate = search.get('anchorDate') || undefined;
            command = {
              command: 'model-usage',
              ...(granularity !== undefined ? { granularity } : {}),
              ...(anchorDate !== undefined ? { anchorDate } : {}),
              ...(tzOffsetMin !== undefined ? { tzOffsetMin } : {}),
            };
            break;
          }
          case '/api/memories':
            command = search.get('query')
              ? { command: 'memory-search', query: search.get('query'), scope: search.get('scope') ?? undefined, cwd: search.get('cwd') ?? undefined, limit: numeric('limit') }
              : { command: 'memory-list', cwd: search.get('cwd') ?? undefined, topic: search.get('topic') ?? undefined, limit: numeric('limit') };
            break;
          case '/api/operation': command = { command: 'operation', taskId: search.get('taskId'), operationId: search.get('operationId') }; break;
          default: throw new HttpFailure(404, 'Unknown API endpoint');
        }
        send(response, 200, await bridge(home, command));
      } else if (incoming.method === 'POST') {
        const commands: Record<string, string> = {
          '/api/chat': 'chat', '/api/stop': 'stop', '/api/resume': 'resume', '/api/chat-stop': 'chat-stop',
          '/api/memory-save': 'memory-save', '/api/memory-link': 'memory-link', '/api/memory-pin': 'memory-pin', '/api/memory-remove': 'memory-remove',
          '/api/timer-add': 'timer-add', '/api/timer-toggle': 'timer-toggle', '/api/timer-complete': 'timer-complete', '/api/timer-remove': 'timer-remove',
          '/api/plugin-run': 'plugin-run',
          '/api/im-save': 'im-save', '/api/im-toggle': 'im-toggle', '/api/im-remove': 'im-remove', '/api/im-test': 'im-test',
          '/api/im-allow-sender': 'im-allow-sender', '/api/im-dismiss-stranger': 'im-dismiss-stranger',
          '/api/im-wechat-qr-start': 'im-wechat-qr-start', '/api/im-wechat-qr-status': 'im-wechat-qr-status',
          '/api/im-telegram-quick': 'im-telegram-quick', '/api/im-telegram-sync': 'im-telegram-sync-commands',
          '/api/voice-remove': 'voice-remove', '/api/voice-clear': 'voice-clear', '/api/voice-config': 'voice-config',
          '/api/model-configure': 'model-configure', '/api/model-probe': 'model-probe', '/api/model-fetch': 'model-fetch',
          '/api/usage-prefs': 'model-usage-prefs',
        };
        const command = Object.hasOwn(commands, url.pathname) ? commands[url.pathname] : undefined;
        if (!command) throw new HttpFailure(404, 'Unknown API endpoint');
        const input = await body(incoming);
        const res = await bridge(home, { ...input, command });
        send(response, 200, command === 'voice-config' ? sanitizeVoiceprint(res) : res);
      } else throw new HttpFailure(405, 'Method not allowed');
    })().catch(error => {
      const status = error instanceof HttpFailure ? error.status : 500;
      const shouldClose = [401, 403, 413, 415].includes(status) || !incoming.complete;
      if (response.headersSent) {
        response.end(() => {
          if (shouldClose) incoming.destroy();
        });
        return;
      }
      if (!shouldClose) incoming.resume();
      send(
        response,
        status,
        { error: error instanceof HttpFailure ? error.message : 'Web request failed' },
        shouldClose ? { close: true, incoming } : undefined,
      );
    });
  });
  server.maxConnections = 64;
  server.maxHeadersCount = 40;
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, bindHost, () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { server.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Local Web address unavailable'); }
  if (bindHost === '0.0.0.0' || bindHost === '::') {
    host = `127.0.0.1:${address.port}`;
  } else if (bindHost.includes(':') && !bindHost.startsWith('[')) {
    host = `[${bindHost}]:${address.port}`;
  } else {
    host = `${bindHost}:${address.port}`;
  }
  allowedHosts.add(host.toLowerCase());
  if (address.port === 80) {
    allowedHosts.add(new URL(`http://${host}`).host.toLowerCase());
  }
  if (bindHost === '0.0.0.0' || bindHost === '::') {
    allowedHosts.add(`127.0.0.1:${address.port}`);
    allowedHosts.add(`localhost:${address.port}`);
    if (address.port === 80) {
      allowedHosts.add('127.0.0.1');
      allowedHosts.add('localhost');
    }
  }
  for (const allowed of normalizedAllowHosts) {
    allowedHosts.add(allowed);
  }
  let closing: Promise<void> | undefined;
  return { home, url: requireAuth ? `http://${host}/#token=${token}` : `http://${host}/`, close: () => closing ??= (async () => {
    sseBroadcaster.closeAll();
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const socket of connections) socket.destroy();
    await closed;
  })() };
}

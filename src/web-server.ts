import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Socket } from 'node:net';
import { integer, request, REQUEST_LIMIT } from './protocol.js';
import type { TraceEvent } from './view.js';

class HttpFailure extends Error { constructor(readonly status: number, message: string) { super(message); } }
const assets: Record<string, { file: string; mime: string }> = {
  '/': { file: 'index.html', mime: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', mime: 'text/html; charset=utf-8' },
  '/mindmap': { file: 'mindmap.html', mime: 'text/html; charset=utf-8' },
  '/mindmap.html': { file: 'mindmap.html', mime: 'text/html; charset=utf-8' },
  '/mindmap.css': { file: 'mindmap.css', mime: 'text/css; charset=utf-8' },
  '/mindmap.js': { file: 'mindmap.js', mime: 'application/javascript; charset=utf-8' },
  '/mindmap-data.js': { file: 'mindmap-data.js', mime: 'application/javascript; charset=utf-8' },
  '/client.js': { file: 'client.js', mime: 'application/javascript; charset=utf-8' },
  '/model.js': { file: 'model.js', mime: 'application/javascript; charset=utf-8' },
  '/brain.js': { file: 'brain.js', mime: 'application/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', mime: 'text/css; charset=utf-8' },
  '/plex-sans.woff2': { file: 'plex-sans.woff2', mime: 'font/woff2' },
  '/plex-mono.woff2': { file: 'plex-mono.woff2', mime: 'font/woff2' },
  '/logo.png': { file: 'logo.png', mime: 'image/png' },
  '/favicon.ico': { file: 'logo.png', mime: 'image/png' },
  '/avatar.png': { file: 'avatar.png', mime: 'image/png' },
};
const policy = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
function send(response: ServerResponse, status: number, result: unknown) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(result));
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
  try { return await request(home, command); }
  catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(String(code)) || (error instanceof Error && /^(Service request timed out|Service closed without a response|Response too large|Invalid service response)/.test(error.message))) throw new HttpFailure(503, '协调服务连接不可用；已记录的内容不会因断线而重发。');
    throw new HttpFailure(400, error instanceof Error ? error.message : 'Service request failed');
  }
}
async function stream(home: string, response: ServerResponse, after: number) {
  const controller = new AbortController();
  const close = () => controller.abort();
  response.once('close', close);
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'x-accel-buffering': 'no' });
  response.flushHeaders();
  let cursor = after; let heartbeat = 0;
  try {
    while (!controller.signal.aborted) {
      const batch = await bridge(home, { command: 'updates', after: cursor }) as { events: TraceEvent[]; cursor: number; head: number };
      if (controller.signal.aborted) break;
      if (batch.events.length) {
        const writable = response.write(`event: updates\ndata: ${JSON.stringify(batch)}\n\n`);
        cursor = batch.cursor;
        if (!writable) await new Promise<void>(resolve => {
          const done = () => { response.off('drain', done); response.off('close', done); resolve(); };
          response.once('drain', done); response.once('close', done);
        });
      } else if (Date.now() - heartbeat >= 5000) { response.write(': heartbeat\n\n'); heartbeat = Date.now(); }
      if (cursor >= batch.head) await delay(300, undefined, { signal: controller.signal, ref: false });
    }
  } catch (error) {
    if (!controller.signal.aborted && !response.destroyed) response.write(`event: problem\ndata: ${JSON.stringify({ error: error instanceof Error ? error.message : 'Event stream unavailable' })}\n\n`);
  } finally { response.off('close', close); response.end(); }
}

export async function startWeb(options: { home: string; port?: number }): Promise<{ url: string; home: string; close(): Promise<void> }> {
  const home = resolve(options.home);
  const port = integer(options.port, 0, 0, 65535);
  await bridge(home, { command: 'health' });
  const assetCache = new Map<string, Buffer>();
  const loadAsset = async (file: string) => {
    let cached = assetCache.get(file);
    if (!cached) { cached = await readFile(new URL(`./web/${file}`, import.meta.url)); assetCache.set(file, cached); }
    return cached;
  };
  await loadAsset('index.html');
  const token = randomBytes(32).toString('hex');
  const credential = Buffer.from(`Bearer ${token}`);
  let host = '';
  const connections = new Set<Socket>();
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, (incoming, response) => {
    response.setHeader('content-security-policy', policy);
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    response.setHeader('cross-origin-opener-policy', 'same-origin');
    void (async () => {
      if (incoming.headers.host !== host) throw new HttpFailure(403, 'Invalid local Host');
      const origin = `http://${host}`;
      const url = new URL(incoming.url ?? '/', origin);
      if (url.origin !== origin) throw new HttpFailure(403, 'Invalid request origin');
      if (url.pathname.startsWith('/im/webhook/')) {
        const channelId = decodeURIComponent(url.pathname.slice('/im/webhook/'.length));
        if (!channelId) throw new HttpFailure(404, 'Missing IM channel ID');
        const raw = incoming.method === 'GET' ? '' : (await rawBytes(incoming)).toString('utf8');
        const result = await bridge(home, {
          command: 'im-webhook',
          channelId,
          method: incoming.method ?? 'POST',
          query: url.searchParams.toString(),
          headers: incoming.headers,
          rawBody: raw,
        }) as { status: number; body: string; contentType: string };
        response.writeHead(result.status, { 'content-type': result.contentType });
        response.end(result.body);
        return;
      }
      if (!url.pathname.startsWith('/api/')) {
        const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : undefined;
        if (!asset || !['GET', 'HEAD'].includes(incoming.method ?? '')) throw new HttpFailure(404, 'Not found');
        const bytes = await loadAsset(asset.file);
        response.writeHead(200, { 'content-type': asset.mime });
        response.end(incoming.method === 'HEAD' ? undefined : bytes);
        return;
      }
      if ((incoming.headers.origin && incoming.headers.origin !== origin) || incoming.headers['sec-fetch-site'] === 'cross-site') throw new HttpFailure(403, 'Cross-origin API access is forbidden');
      const authorization = incoming.headers.authorization;
      const supplied = Buffer.from(typeof authorization === 'string' ? authorization : '');
      if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) throw new HttpFailure(401, '请使用 web 命令输出的本地访问链接；访问令牌缺失或已失效。');
      const search = url.searchParams;
      const numeric = (name: string) => {
        if (!search.has(name)) return undefined;
        try { return integer(Number(search.get(name)), 0, 0, Number.MAX_SAFE_INTEGER); }
        catch { throw new HttpFailure(400, `Invalid ${name} cursor`); }
      };
      if (incoming.method === 'GET') {
        if (url.pathname === '/api/stream') { await stream(home, response, numeric('after') ?? 0); return; }
        let command: Record<string, unknown>;
        switch (url.pathname) {
          case '/api/view': command = { command: 'view' }; break;
          case '/api/mindmap': command = { command: 'mindmap', before: numeric('before'), limit: numeric('limit') }; break;
          case '/api/message': command = { command: 'message', messageId: search.get('messageId') }; break;
          case '/api/history': command = { command: 'history', before: numeric('before') }; break;
          case '/api/trace': command = { command: 'trace', messageId: search.get('messageId') ?? undefined, taskId: search.get('taskId') ?? undefined, after: numeric('after'), before: numeric('before') }; break;
          case '/api/work': command = { command: 'get', taskId: search.get('taskId') }; break;
          case '/api/timers': command = { command: 'timer-list' }; break;
          case '/api/plugins': command = { command: 'plugin-list' }; break;
          case '/api/im-channels': command = { command: 'im-list' }; break;
          case '/api/models': command = { command: 'model-hub' }; break;
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
          '/api/timer-add': 'timer-add', '/api/timer-toggle': 'timer-toggle', '/api/timer-remove': 'timer-remove',
          '/api/plugin-run': 'plugin-run',
          '/api/im-save': 'im-save', '/api/im-toggle': 'im-toggle', '/api/im-remove': 'im-remove', '/api/im-test': 'im-test',
          '/api/im-wechat-qr-start': 'im-wechat-qr-start', '/api/im-wechat-qr-status': 'im-wechat-qr-status',
          '/api/model-configure': 'model-configure', '/api/model-probe': 'model-probe', '/api/model-fetch': 'model-fetch',
        };
        const command = Object.hasOwn(commands, url.pathname) ? commands[url.pathname] : undefined;
        if (!command) throw new HttpFailure(404, 'Unknown API endpoint');
        const input = await body(incoming);
        send(response, 200, await bridge(home, { ...input, command }));
      } else throw new HttpFailure(405, 'Method not allowed');
    })().catch(error => {
      if (response.headersSent) { response.end(); return; }
      incoming.resume();
      send(response, error instanceof HttpFailure ? error.status : 500,
        { error: error instanceof HttpFailure ? error.message : 'Web request failed' });
    });
  });
  server.maxConnections = 64;
  server.maxHeadersCount = 40;
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { server.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Local Web address unavailable'); }
  host = `127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return { home, url: `http://${host}/#token=${token}`, close: () => closing ??= (async () => {
    const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const socket of connections) socket.destroy();
    await closed;
  })() };
}

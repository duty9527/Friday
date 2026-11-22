import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer, createConnection, type Socket } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { serve } from '../src/server.js';
import { startWeb } from '../src/web-server.js';
import { REQUEST_LIMIT, socketPath } from '../src/protocol.js';
import type { ChatMessage, TraceEvent } from '../src/view.js';
import { mergeTraceWindow, routeLabel, routeState } from '../src/web/model.js';
import { getEffectiveSessions, mergeSessionLists, type MindmapSession, type MindmapSnapshot, type MindmapTaskFlow } from '../src/web/mindmap-data.js';
import { createSharedSseHub, type BroadcastChannelLike, type SseUpdateBatch } from '../src/web/shared/sse-hub.js';

async function fixture() {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-web-harden-'));
  const daemon = await serve({ home, mode: 'offline', offlineDelayMs: 30 });
  const web = await startWeb({ home });
  const entry = new URL(web.url);
  const base = entry.origin;
  const token = new URLSearchParams(entry.hash.slice(1)).get('token')!;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return {
    home,
    daemon,
    web,
    base,
    token,
    headers,
    close: async () => {
      await web.close();
      await daemon.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function rawHttp(url: string, headers: Record<string, string>, method = 'GET') {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, text }));
    });
    req.once('error', reject);
    req.end();
  });
}

async function mockIpcFixture(handler: (command: Record<string, unknown>) => unknown) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-ipc-mock-'));
  const sock = socketPath(home);
  const sockets = new Set<Socket>();
  const ipcServer = createNetServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const cmd = JSON.parse(line) as Record<string, unknown>;
          const result = handler(cmd);
          socket.write(`${JSON.stringify({ ok: true, result })}\n`);
        } catch (err) {
          socket.write(`${JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    ipcServer.once('error', reject);
    ipcServer.listen(sock, () => { ipcServer.off('error', reject); resolve(); });
  });
  let web: Awaited<ReturnType<typeof startWeb>>;
  try {
    web = await startWeb({ home });
  } catch (err) {
    for (const s of sockets) s.destroy();
    await new Promise<void>(resolve => ipcServer.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
    throw err;
  }
  const entry = new URL(web.url);
  const token = new URLSearchParams(entry.hash.slice(1)).get('token')!;
  return {
    home,
    base: entry.origin,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    close: async () => {
      await web.close();
      for (const s of sockets) s.destroy();
      await new Promise<void>(resolve => ipcServer.close(() => resolve()));
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

test('IM webhook rejects malformed URLs (400) and browser headers (403) while allowing LAN Host and keeping API/static Host locked', async () => {
  const f = await fixture();
  try {
    // Configure a Telegram webhook channel with a secret token so legitimate callbacks reach gateway logic.
    const saved = await fetch(`${f.base}/api/im-save`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({
        platform: 'telegram',
        name: 'Webhook Guard Test',
        secret: 'tg-secret-42',
      }),
    });
    assert.equal(saved.status, 200);
    const channel = await saved.json() as { id: string };

    // Malformed percent-encoding in webhook channel ID -> clean 400 (never 500)
    const malformed = await rawHttp(`${f.base}/im/webhook/%E0%A4%A`, { host: new URL(f.base).host }, 'POST');
    assert.equal(malformed.status, 400);

    // Encoded slash or null byte -> 400
    const slashEncoded = await rawHttp(`${f.base}/im/webhook/foo%2Fbar`, { host: new URL(f.base).host }, 'POST');
    assert.equal(slashEncoded.status, 400);

    // Browser cross-origin / same-origin Fetch Metadata -> 403 before bridge
    const withOrigin = await fetch(`${f.base}/im/webhook/${encodeURIComponent(channel.id)}`, {
      method: 'POST',
      headers: {
        origin: 'https://malicious.example',
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'tg-secret-42',
      },
      body: '{}',
    });
    assert.equal(withOrigin.status, 403);
    assert.match(await withOrigin.text(), /Cross-site browser webhook/);

    const withFetchMeta = await fetch(`${f.base}/im/webhook/${encodeURIComponent(channel.id)}`, {
      method: 'POST',
      headers: {
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'tg-secret-42',
      },
      body: '{}',
    });
    assert.equal(withFetchMeta.status, 403);
    assert.match(await withFetchMeta.text(), /Cross-site browser webhook/);

    // Invalid Host header syntax -> 403
    const badHost = await rawHttp(`${f.base}/im/webhook/${encodeURIComponent(channel.id)}`, { host: 'evil.com/path' }, 'POST');
    assert.equal(badHost.status, 403);

    // Non-browser reverse-proxy / LAN Host reaches coordinator IM gateway & fails secret check there (Invalid Telegram secret token)
    const lanBadSecret = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const target = new URL(`${f.base}/im/webhook/${encodeURIComponent(channel.id)}`);
      const req = httpRequest(target, {
        method: 'POST',
        headers: {
          host: '192.168.1.50:8443',
          'content-type': 'application/json',
          'content-length': '2',
          'x-telegram-bot-api-secret-token': 'wrong',
        },
      }, res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      req.once('error', reject);
      req.end('{}');
    });
    assert.equal(lanBadSecret.status, 403);
    assert.match(lanBadSecret.body, /Invalid Telegram secret token/);

    const lanValidSecret = await new Promise<{ status: number }>((resolve, reject) => {
      const target = new URL(`${f.base}/im/webhook/${encodeURIComponent(channel.id)}`);
      const req = httpRequest(target, {
        method: 'POST',
        headers: {
          host: 'friday-bridge.lan:8443',
          'content-type': 'application/json',
          'content-length': '2',
          'x-telegram-bot-api-secret-token': 'tg-secret-42',
        },
      }, res => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode! }));
      });
      req.once('error', reject);
      req.end('{}');
    });
    assert.equal(lanValidSecret.status, 200);

    // Static assets & /api/* must STILL lock Host strictly to loopback host:port
    assert.equal((await rawHttp(`${f.base}/`, { host: '192.168.1.50:8443' })).status, 403);
    assert.equal((await rawHttp(`${f.base}/api/view`, { ...f.headers, host: '192.168.1.50:8443' })).status, 403);

    // /api/* must block same-site as well as cross-site while allowing same-origin and none
    assert.equal((await rawHttp(`${f.base}/api/view`, { ...f.headers, 'sec-fetch-site': 'same-site' })).status, 403);
    assert.equal((await rawHttp(`${f.base}/api/view`, { ...f.headers, 'sec-fetch-site': 'same-origin' })).status, 200);
    assert.equal((await rawHttp(`${f.base}/api/view`, { ...f.headers, 'sec-fetch-site': 'none' })).status, 200);
  } finally {
    await f.close();
  }
});

test('Static server and dist/web block .map source maps and .txt files', async () => {
  const f = await fixture();
  try {
    for (const forbidden of ['/client.js.map', '/mindmap.js.map', '/web-server.js.map', '/FONT-LICENSE.txt']) {
      const res = await fetch(`${f.base}${forbidden}`);
      assert.equal(res.status, 404, `${forbidden} must not be served`);
    }
    const distWebDir = fileURLToPath(new URL('../dist/web/', import.meta.url));
    const files = await walkFiles(distWebDir);
    const leaked = files.filter(file => /\.(?:map|txt)$/i.test(file));
    assert.deepEqual(leaked, [], 'dist/web must not retain .map or .txt artifacts');
  } finally {
    await f.close();
  }
});

test('413 closes socket cleanly without draining huge bodies; IPC limit & Response exceeds limit map properly', async () => {
  const f = await fixture();
  try {
    // 1. Raw socket sends declared Content-Length > REQUEST_LIMIT + partial chunk without closing write side;
    // server must respond 413 with Connection: close and destroy socket cleanly without waiting for 10 MB drain.
    const url = new URL(`${f.base}/api/chat`);
    const hugeOutcome = await new Promise<{ head: string; body: string; closedQuickly: boolean }>((resolve, reject) => {
      const socket = createConnection({ host: url.hostname, port: Number(url.port) }, () => {
        socket.write(
          `POST /api/chat HTTP/1.1\r\n`
          + `Host: ${url.host}\r\n`
          + `Authorization: ${f.headers.authorization}\r\n`
          + `Content-Type: application/json\r\n`
          + `Content-Length: 10485760\r\n`
          + `\r\n`
          + `{"text":"partial`,
        );
      });
      let raw = '';
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('413 socket stayed open waiting for body drain'));
      }, 2000);
      socket.on('data', chunk => { raw += chunk.toString('utf8'); });
      socket.on('close', () => {
        clearTimeout(timer);
        const [head = '', body = ''] = raw.split('\r\n\r\n');
        resolve({ head, body, closedQuickly: true });
      });
      socket.once('error', () => {});
    });
    assert.equal(hugeOutcome.closedQuickly, true);
    assert.match(hugeOutcome.head, /^HTTP\/1\.1 413 /);
    assert.match(hugeOutcome.head, /connection:\s*close/i);

    // 2. Body right at HTTP REQUEST_LIMIT whose serialized bridge envelope `{ ...input, command }` exceeds 64 KiB IPC limit -> 413
    const padLength = REQUEST_LIMIT - '{"text":""}'.length - 2;
    const edgeRes = await fetch(`${f.base}/api/chat`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ text: 'a'.repeat(padLength) }),
    });
    assert.equal(edgeRes.status, 413);
  } finally {
    await f.close();
  }

  // 3. IPC daemon returning "Response exceeds limit" must map to 503 (not 400)
  const mock = await mockIpcFixture(cmd => {
    if (cmd.command === 'health') return { status: 'ready' };
    throw new Error('Response exceeds limit');
  });
  try {
    const res = await fetch(`${mock.base}/api/view`, { headers: mock.headers });
    assert.equal(res.status, 503);
  } finally {
    await mock.close();
  }
});

test('/api/messages supports direct bulk IPC command and falls back cleanly on Unknown command', async () => {
  // 1. Direct IPC `messages` command returning ChatMessage[]
  const calls: Array<{ command: unknown; ids?: unknown }> = [];
  const sampleMsg = (id: string, seq: number): ChatMessage => ({
    id,
    seq,
    at: 1_700_000_000_000 + seq,
    role: 'user',
    text: `msg-${id}`,
    mode: 'offline',
    paths: [],
    taskIds: [],
    status: 'completed',
    version: 1,
  });
  const directMock = await mockIpcFixture(cmd => {
    if (cmd.command === 'health') return { status: 'ready' };
    calls.push({ command: cmd.command, ids: cmd.ids });
    if (cmd.command === 'messages' && Array.isArray(cmd.ids)) {
      const items = (cmd.ids as string[]).map((id, idx) => sampleMsg(id, idx + 1));
      return calls.length % 2 === 0 ? { items } : items;
    }
    throw new Error('Unknown command');
  });
  try {
    const res = await fetch(`${directMock.base}/api/messages?ids=m1,m2,m1,m3`, { headers: directMock.headers });
    assert.equal(res.status, 200);
    const body = await res.json() as { items: ChatMessage[] };
    assert.deepEqual(body.items.map(m => m.id), ['m1', 'm2', 'm3']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, 'messages');

    // Also verifies repeated ?ids=a&ids=b query style and `{ items }` IPC response format
    const res2 = await fetch(`${directMock.base}/api/messages?ids=m4&ids=m5`, { headers: directMock.headers });
    assert.equal(res2.status, 200);
    const body2 = await res2.json() as { items: ChatMessage[] };
    assert.deepEqual(body2.items.map(m => m.id), ['m4', 'm5']);
    assert.equal(calls.length, 2);

    // Empty ids -> 200 { items: [] } without hitting IPC
    const emptyRes = await fetch(`${directMock.base}/api/messages?ids=`, { headers: directMock.headers });
    assert.equal(emptyRes.status, 200);
    assert.deepEqual(await emptyRes.json(), { items: [] });

    // >200 IDs -> 400
    const manyIds = Array.from({ length: 201 }, (_, i) => `id-${i}`).join(',');
    assert.equal((await fetch(`${directMock.base}/api/messages?ids=${manyIds}`, { headers: directMock.headers })).status, 400);

    // >128 char ID -> 400
    assert.equal((await fetch(`${directMock.base}/api/messages?ids=${'x'.repeat(129)}`, { headers: directMock.headers })).status, 400);
  } finally {
    await directMock.close();
  }

  // 2. Fallback path against real daemon (or IPC without `messages` command throwing Unknown command)
  const f = await fixture();
  try {
    const send1 = await fetch(`${f.base}/api/chat`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ requestId: randomUUID(), text: 'first bulk message', files: [] }),
    });
    const send2 = await fetch(`${f.base}/api/chat`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ requestId: randomUUID(), text: 'second bulk message', files: [] }),
    });
    const msg1 = await send1.json() as ChatMessage;
    const msg2 = await send2.json() as ChatMessage;
    const batchRes = await fetch(
      `${f.base}/api/messages?ids=${encodeURIComponent(`${msg1.id},${msg2.id}`)}`,
      { headers: f.headers },
    );
    assert.equal(batchRes.status, 200);
    const batchBody = await batchRes.json() as { items: ChatMessage[] };
    assert.deepEqual(batchBody.items.map(m => m.id), [msg1.id, msg2.id]);
  } finally {
    await f.close();
  }
});

test('SSE broadcaster recovers when daemon cursor rolls back after DB reset', async () => {
  let dbReset = false;
  const mock = await mockIpcFixture(cmd => {
    if (cmd.command !== 'updates') return {};
    if (!dbReset) {
      dbReset = true;
      // Initially client has after=40; DB just reset so head=2 while after=40 yields empty events.
      return { events: [], cursor: 40, head: 2 };
    }
    const after = Number(cmd.after ?? 0);
    const all: TraceEvent[] = [
      { id: 'ev-1', rootId: 'r1', actor: 'user', seq: 1, at: 1000, type: 'message', kind: 'user', label: 'u1', status: 'completed' },
      { id: 'ev-2', rootId: 'r1', actor: 'router', seq: 2, at: 1001, type: 'message', kind: 'assistant', label: 'a1', status: 'completed' },
    ];
    const events = all.filter(ev => ev.seq > after);
    return { events, cursor: events.at(-1)?.seq ?? after, head: 2 };
  });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const frames: Array<{ events: TraceEvent[]; cursor: number; head: number; reset?: boolean }> = [];
    try {
      const response = await fetch(`${mock.base}/api/stream?after=40`, {
        headers: mock.headers,
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (frames.every(frame => frame.events.length === 0)) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (;;) {
          const end = buf.indexOf('\n\n');
          if (end < 0) break;
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          if (block.startsWith('event: updates')) {
            frames.push(JSON.parse(block.split('\ndata: ')[1]!) as { events: TraceEvent[]; cursor: number; head: number; reset?: boolean });
          }
        }
      }
      await reader.cancel().catch(() => {});
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    assert.ok(frames.some(frame => frame.reset === true), 'must emit reset marker on rollback');
    const recovered = frames.find(frame => frame.events.length > 0);
    assert.ok(recovered, 'must deliver post-reset events');
    assert.deepEqual(recovered.events.map(e => e.seq), [1, 2]);
  } finally {
    await mock.close();
  }
});

test('SharedSseHub shares one /api/stream across 8 tabs and fails over cleanly on leader close', async () => {
  const peers = new Set<MockChannel>();
  class MockChannel implements BroadcastChannelLike {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    closed = false;
    constructor() { peers.add(this); }
    postMessage(message: unknown): void {
      if (this.closed) return;
      queueMicrotask(() => {
        for (const peer of [...peers]) {
          if (peer !== this && !peer.closed) peer.onmessage?.({ data: message });
        }
      });
    }
    close(): void {
      this.closed = true;
      peers.delete(this);
    }
  }

  let openStreams = 0;
  let totalStreamRequests = 0;
  let pushBatch: ((batch: SseUpdateBatch) => void) | undefined;
  const receivedByTab = Array.from({ length: 8 }, () => [] as SseUpdateBatch[]);

  const makeMockRequest = () => async (_path: string, init?: RequestInit): Promise<Response> => {
    totalStreamRequests += 1;
    openStreams += 1;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const sendBatch = (batch: SseUpdateBatch) => {
          controller.enqueue(encoder.encode(`event: updates\ndata: ${JSON.stringify(batch)}\n\n`));
        };
        pushBatch = sendBatch;
        const onAbort = () => {
          openStreams -= 1;
          try { controller.close(); } catch { /* already closed */ }
        };
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener('abort', onAbort, { once: true });
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const hubs = Array.from({ length: 8 }, (_, idx) => createSharedSseHub({
    token: 'a'.repeat(64),
    tabId: `tab-0${idx + 1}`,
    createChannel: () => new MockChannel(),
    request: makeMockRequest(),
    isStopped: () => false,
    onUpdates: batch => { receivedByTab[idx]!.push(batch); },
  }));

  try {
    for (const hub of hubs) hub.start(0);
    await new Promise(resolve => setTimeout(resolve, 260));
    assert.equal(totalStreamRequests, 1, '8 same-origin tabs must open at most 1 SSE connection');
    assert.equal(openStreams, 1);
    assert.equal(hubs.filter(h => h.isLeader()).length, 1);

    pushBatch!({ events: [{ id: 'ev-10', rootId: 'r10', actor: 'user', seq: 10, at: 1, type: 'message', kind: 'user', label: 'x', status: 'completed' }], cursor: 10, head: 10 });
    await new Promise(resolve => setTimeout(resolve, 60));
    for (let i = 0; i < 8; i++) {
      assert.equal(receivedByTab[i]!.length, 1, `tab ${i + 1} must receive broadcasted update`);
      assert.equal(receivedByTab[i]![0]!.cursor, 10);
    }

    // Stop current leader -> exactly one remaining tab takes over SSE stream
    const leaderIdx = hubs.findIndex(h => h.isLeader());
    hubs[leaderIdx]!.stop();
    await new Promise(resolve => setTimeout(resolve, 260));
    const remainingLeaders = hubs.filter((h, i) => i !== leaderIdx && h.isLeader());
    assert.equal(remainingLeaders.length, 1);
    assert.equal(totalStreamRequests, 2);

    pushBatch!({ events: [{ id: 'ev-11', rootId: 'r11', actor: 'router', seq: 11, at: 2, type: 'message', kind: 'assistant', label: 'y', status: 'completed' }], cursor: 11, head: 11 });
    await new Promise(resolve => setTimeout(resolve, 60));
    for (let i = 0; i < 8; i++) {
      if (i === leaderIdx) continue;
      assert.equal(receivedByTab[i]!.at(-1)?.cursor, 11);
    }
  } finally {
    for (const hub of hubs) hub.stop();
  }

  // Fallback without BroadcastChannel opens direct stream cleanly
  let fallbackOpened = 0;
  let fallbackReceived = 0;
  const fallbackHub = createSharedSseHub({
    token: 'b'.repeat(64),
    createChannel: () => undefined,
    request: async (_path, init) => {
      fallbackOpened += 1;
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('event: updates\ndata: {"events":[],"cursor":5,"head":5}\n\n'));
          init?.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
        },
      }), { status: 200 });
    },
    isStopped: () => false,
    onUpdates: () => { fallbackReceived += 1; },
  });
  fallbackHub.start(0);
  await new Promise(resolve => setTimeout(resolve, 40));
  fallbackHub.stop();
  assert.equal(fallbackOpened, 1);
  assert.equal(fallbackReceived, 1);
});

test('model helpers provide safe fallbacks & bounded trace window; mindmap deduplicates paginated sessions', () => {
  // Unknown enum fallbacks in routeLabel & routeState never yield undefined
  const weirdLabel = routeLabel({ kind: 'future_action' as never });
  assert.equal(typeof weirdLabel, 'string');
  assert.doesNotMatch(weirdLabel, /undefined/);
  const weirdState = routeState({ kind: 'new_work', status: 'retrying' as never });
  assert.equal(typeof weirdState, 'string');
  assert.doesNotMatch(weirdState, /undefined/);

  // mergeTraceWindow caps size on live/recent and sets trimmedEarlier
  const existing: TraceEvent[] = Array.from({ length: 10 }, (_, i) => ({
    id: `ev-${i + 1}`,
    rootId: 'r1',
    actor: 'worker',
    seq: i + 1,
    at: 1000 + i,
    type: 'trace',
    kind: 'span',
    label: `s${i + 1}`,
    status: 'completed',
  }));
  const incoming: TraceEvent[] = Array.from({ length: 5 }, (_, i) => ({
    id: `ev-${i + 11}`,
    rootId: 'r1',
    actor: 'worker',
    seq: i + 11,
    at: 1010 + i,
    type: 'trace',
    kind: 'span',
    label: `s${i + 11}`,
    status: 'completed',
  }));
  const capped = mergeTraceWindow(existing, incoming, 'live', 12);
  assert.equal(capped.events.length, 12);
  assert.equal(capped.events[0]!.seq, 4);
  assert.equal(capped.events.at(-1)!.seq, 15);
  assert.equal(capped.trimmedEarlier, true);

  // Mindmap session aggregation across paginated older flows sharing a sessionId
  const makeFlow = (id: string, seq: number, sessionId: string, text: string): MindmapTaskFlow => ({
    id,
    seq,
    sessionId,
    sessionPersisted: true,
    createdAt: 1000 + seq * 100,
    completedAt: 1050 + seq * 100,
    status: 'completed',
    ingress: {
      messageId: `msg-${id}`,
      channelLabel: 'Web',
      sourceKind: 'local',
      text,
      textTruncated: false,
      paths: [],
      attachments: [],
    },
    memoryRecall: { recalledItems: [] },
    routerTurns: [],
    routeActions: [],
    tasks: [],
    consolidatedMemories: [],
    deliveries: [],
    imPush: { channel: 'local', channelName: 'Web', delivered: true, deliveryCount: 1, sentFiles: [] },
  });
  const f1 = makeFlow('f1', 1, 'sess-shared', 'turn 1');
  const f2 = makeFlow('f2', 2, 'sess-shared', 'turn 2');
  const f3 = makeFlow('f3', 3, 'sess-shared', 'turn 3');
  const initialSession: MindmapSession = {
    id: 'sess-shared',
    title: 'turn 3',
    kind: 'human',
    status: 'completed',
    startedAt: f3.createdAt,
    updatedAt: f3.completedAt!,
    channels: ['local'],
    primaryChannelLabel: 'Web',
    turnCount: 1,
    taskCount: 0,
    jevCallCount: 0,
    recalledMemoryCount: 0,
    consolidatedMemoryCount: 0,
    aiManagedContext: false,
    turnFlowIds: ['f3'],
    turnSummaries: [{
      flowId: 'f3',
      seq: 3,
      at: f3.createdAt,
      sourceKind: 'local',
      channelLabel: 'Web',
      textPreview: 'turn 3',
      status: 'completed',
      taskIds: [],
    }],
  };
  const snap: MindmapSnapshot = {
    generatedAt: 2000,
    cursor: 10,
    mode: 'offline',
    hasMore: true,
    beforeSeq: 1,
    summary: {
      totalFlows: 3,
      loadedFlows: 3,
      totalSessions: 1,
      multiTurnSessions: 1,
      wechatFlows: 0,
      localFlows: 3,
      timerFlows: 0,
      totalTasks: 0,
      jevCalls: 0,
      totalMemories: 0,
      routerProvider: 'deepseek',
      routerModel: 'deepseek-chat',
      decisionModel: 'gemini',
      decisionEnabled: false,
      decisionConfigured: false,
    },
    sessions: [initialSession],
    flows: [f3, f2, f1],
  };
  const sessions = getEffectiveSessions(snap, [f3, f2, f1]);
  assert.equal(new Set(sessions.map(s => s.id)).size, sessions.length, 'effective sessions must never have duplicate IDs');
  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0]!.turnFlowIds, ['f1', 'f2', 'f3']);

  const mergedSessions = mergeSessionLists([initialSession], [
    { ...initialSession, turnFlowIds: ['f1', 'f2'], turnSummaries: [
      { flowId: 'f1', seq: 1, at: f1.createdAt, sourceKind: 'local', channelLabel: 'Web', textPreview: 'turn 1', status: 'completed', taskIds: [] },
      { flowId: 'f2', seq: 2, at: f2.createdAt, sourceKind: 'local', channelLabel: 'Web', textPreview: 'turn 2', status: 'completed', taskIds: [] },
    ] },
  ]);
  assert.equal(mergedSessions.length, 1);
  assert.deepEqual(mergedSessions[0]!.turnFlowIds, ['f1', 'f2', 'f3']);
});

test('loadTrace halts after a failed fetch even when traceHasMore is true (no 0ms retry storm)', async () => {
  const prevGlobals = {
    document: globalThis.document,
    location: globalThis.location,
    history: globalThis.history,
    sessionStorage: globalThis.sessionStorage,
    fetch: globalThis.fetch,
    Node: globalThis.Node,
  };
  const makeStubEl = () => {
    const classSet = new Set<string>();
    const el: Record<string, unknown> = {
      value: 'all',
      hidden: true,
      disabled: false,
      textContent: '',
      title: '',
      innerText: '',
      scrollHeight: 0,
      scrollTop: 0,
      clientHeight: 100,
      parentElement: null,
      closest: () => undefined,
      classList: {
        add: (...names: string[]) => names.forEach(n => classSet.add(n)),
        remove: (...names: string[]) => names.forEach(n => classSet.delete(n)),
        toggle: (name: string, force?: boolean) => {
          if (force === undefined) {
            if (classSet.has(name)) { classSet.delete(name); return false; }
            classSet.add(name); return true;
          }
          if (force) classSet.add(name); else classSet.delete(name);
          return force;
        },
        contains: (name: string) => classSet.has(name),
      },
      setAttribute: () => {},
      addEventListener: () => {},
      replaceChildren: () => {},
      append: () => {},
      focus: () => {},
      contains: () => false,
    };
    return el;
  };
  const elements = new Map<string, Record<string, unknown>>();
  const getEl = (id: string) => {
    let el = elements.get(id);
    if (!el) { el = makeStubEl(); elements.set(id, el); }
    return el;
  };

  Object.assign(globalThis, {
    location: { hash: `#token=${'a'.repeat(64)}`, pathname: '/', search: '' },
    history: { replaceState: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    Node: class {},
    document: {
      getElementById: (id: string) => getEl(id),
      createElement: () => makeStubEl(),
      createDocumentFragment: () => makeStubEl(),
      addEventListener: () => {},
    },
  });

  try {
    const { appState } = await import('../src/web/state.js');
    const { initTracePanel } = await import('../src/web/panels/trace.js');
    appState.ready = true;
    appState.authExpired = false;
    appState.selection = { type: 'message', id: 'm1', label: 'm1' };
    appState.traceMode = 'steps';
    appState.traceHasMore = true;

    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ error: 'simulated 500' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    };

    const panel = initTracePanel();
    await panel.loadTrace('live');
    await new Promise(resolve => setTimeout(resolve, 40));

    assert.equal(fetchCount, 1, 'failed loadTrace must NOT auto-loop when traceHasMore is true');
    assert.equal(appState.traceBusy, false);
    assert.equal(getEl('trace-retry').hidden, false);

    // Direction queueing: calling loadTrace('earlier') while a 'live' request is in flight must queue 'earlier'
    let releaseFirst!: () => void;
    const requestedUrls: string[] = [];
    globalThis.fetch = (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requestedUrls.push(url);
      if (requestedUrls.length === 1) {
        return new Promise<Response>(resolve => {
          releaseFirst = () => resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
        });
      }
      return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    };

    appState.traceEvents = [{ id: 'ev-50', rootId: 'r1', actor: 'worker', seq: 50, at: 1, type: 'trace', kind: 'span', label: 's', status: 'completed' }];
    appState.traceHasMore = false;
    const first = panel.loadTrace('live');
    const queued = panel.loadTrace('earlier');
    await queued;
    releaseFirst();
    await first;
    await new Promise(resolve => setTimeout(resolve, 40));

    assert.equal(requestedUrls.length, 2);
    assert.match(requestedUrls[0]!, /after=/);
    assert.match(requestedUrls[1]!, /before=50/);
  } finally {
    Object.assign(globalThis, prevGlobals);
  }
});

test('src/web and dist/web uphold zero inline styles and light-theme WCAG contrast for health badges', async () => {
  const srcWebDir = fileURLToPath(new URL('../src/web/', import.meta.url));
  const css = await readFile(join(srcWebDir, 'style.css'), 'utf8');
  assert.doesNotMatch(css, /\.health-status-banner\.tone-ok\s*\{[^}]*#86efac/i);
  assert.doesNotMatch(css, /\.health-status-banner\.tone-warn\s*\{[^}]*#fcd34d/i);
  assert.doesNotMatch(css, /\.health-status-banner\.tone-err\s*\{[^}]*#fca5a5/i);
  assert.doesNotMatch(css, /\.rating-badge-(?:excellent|normal|low|high|critical)[^}]*(?:#4ade80|#7dd3fc|#fcd34d|#fdba74|#fca5a5)/i);

  for (const token of ['--ease-out', '--dur-modal', 'prefers-reduced-motion', '@keyframes modalFloatIn', '@keyframes messageEnter']) {
    assert.ok(css.includes(token), `style.css must define ${token}`);
  }

  const mindmapCss = await readFile(join(srcWebDir, 'mindmap.css'), 'utf8');
  for (const token of ['--mm-ease-out', '--mm-dur-panel', 'prefers-reduced-motion', '@keyframes mmInspEnter', '@keyframes mmStatusDotPulse']) {
    assert.ok(mindmapCss.includes(token), `mindmap.css must define ${token}`);
  }

  const srcScripts = (await walkFiles(srcWebDir)).filter(f => f.endsWith('.ts') || f.endsWith('.js'));
  for (const file of srcScripts) {
    const content = await readFile(file, 'utf8');
    assert.doesNotMatch(content, /\.style\./, `${file} must not use inline .style.`);
    assert.doesNotMatch(content, /\.innerHTML/, `${file} must not use .innerHTML`);
  }
});

test('Static assets & API routes enforce Trusted Types CSP, security headers, compression, ETag/304, and Cache-Control split', async () => {
  const f = await fixture();
  try {
    const host = new URL(f.base).host;
    const htmlRes = await rawHttp(`${f.base}/`, { host, 'accept-encoding': 'identity' });
    assert.equal(htmlRes.status, 200);
    const csp = String(htmlRes.headers['content-security-policy'] ?? '');
    assert.match(csp, /require-trusted-types-for 'script'/);
    assert.match(csp, /trusted-types 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.equal(htmlRes.headers['x-frame-options'], 'DENY');
    assert.match(String(htmlRes.headers['permissions-policy'] ?? ''), /camera=\(\)/);
    assert.match(String(htmlRes.headers['permissions-policy'] ?? ''), /geolocation=\(\)/);
    assert.equal(htmlRes.headers['cache-control'], 'no-cache');
    assert.equal(htmlRes.headers.vary, 'Accept-Encoding');
    const idEtag = String(htmlRes.headers.etag ?? '');
    assert.match(idEtag, /^"[^"]+"$/);

    const brRes = await rawHttp(`${f.base}/`, { host, 'accept-encoding': 'br, gzip' });
    assert.equal(brRes.status, 200);
    assert.equal(brRes.headers['content-encoding'], 'br');
    assert.notEqual(brRes.headers.etag, idEtag);

    const gzRes = await rawHttp(`${f.base}/`, { host, 'accept-encoding': 'gzip' });
    assert.equal(gzRes.status, 200);
    assert.equal(gzRes.headers['content-encoding'], 'gzip');
    assert.notEqual(gzRes.headers.etag, idEtag);
    assert.notEqual(gzRes.headers.etag, brRes.headers.etag);

    const revalRes = await rawHttp(`${f.base}/`, { host, 'accept-encoding': 'br', 'if-none-match': String(brRes.headers.etag) });
    assert.equal(revalRes.status, 304);
    assert.equal(revalRes.text, '');

    const fontRes = await rawHttp(`${f.base}/plex-sans.woff2`, { host, 'accept-encoding': 'identity' });
    assert.equal(fontRes.status, 200);
    assert.equal(fontRes.headers['cache-control'], 'public, max-age=604800');

    const apiRes = await rawHttp(`${f.base}/api/view`, { host, authorization: f.headers.authorization });
    assert.equal(apiRes.status, 200);
    assert.equal(apiRes.headers['cache-control'], 'no-store');
    assert.equal(apiRes.headers['x-frame-options'], 'DENY');
    assert.match(String(apiRes.headers['permissions-policy'] ?? ''), /microphone=\(\)/);
    assert.equal(apiRes.headers.vary, 'Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site');
  } finally {
    await f.close();
  }
});

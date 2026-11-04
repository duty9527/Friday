import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '../dist/server.js';
import { startWeb } from '../dist/web-server.js';
import { request } from '../src/protocol.js';
import type { MainView, TraceEvent } from '../src/view.js';

async function fixture() {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-web-'));
  const daemon = await serve({ home, mode: 'offline', offlineDelayMs: 40 });
  const web = await startWeb({ home });
  const entry = new URL(web.url);
  const base = entry.origin;
  const token = new URLSearchParams(entry.hash.slice(1)).get('token')!;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return { home, daemon, web, base, headers, close: async () => { await web.close(); await daemon.close(); await rm(home, { recursive: true, force: true }); } };
}
async function raw(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = httpRequest(url, { headers }, response => {
      let text = ''; response.on('data', bytes => { text += bytes; });
      response.on('end', () => resolve({ status: response.statusCode!, text }));
    });
    req.once('error', reject); req.end();
  });
}
async function batch(base: string, headers: Record<string, string>, after: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${base}/api/stream?after=${after}`, { headers, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    let buffer = ''; const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read(); if (done) throw new Error('Stream ended without updates');
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (frame.startsWith('event: updates')) return JSON.parse(frame.split('\ndata: ')[1]!) as { events: TraceEvent[]; cursor: number; head: number };
        if (frame.startsWith('event: problem')) throw new Error(frame);
      }
    }
  } finally { clearTimeout(timeout); controller.abort(); }
}

test('Web is authenticated, same-origin and loopback only with restrictive static content policy', async () => {
  const f = await fixture();
  try {
    assert.match(f.base, /^http:\/\/127\.0\.0\.1:\d+$/);
    const page = await fetch(f.base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.doesNotMatch(await page.text(), new RegExp(f.home));
    assert.equal((await fetch(`${f.base}/api/view`)).status, 401);
    assert.equal((await fetch(`${f.base}/api/view?token=${f.web.url.split('token=')[1]}`)).status, 401);
    assert.equal((await fetch(`${f.base}/api/view`, { headers: { ...f.headers, origin: 'https://malicious.example' } })).status, 403);
    assert.equal((await fetch(`${f.base}/api/view`, { headers: { ...f.headers, 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await raw(`${f.base}/api/view`, { ...f.headers, host: 'rebound.example' })).status, 403);
    const authorized = await fetch(`${f.base}/api/view`, { headers: f.headers });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get('access-control-allow-origin'), null);
    assert.equal((await fetch(`${f.base}/api/shutdown`, { method: 'POST', headers: f.headers, body: '{}' })).status, 404);
    assert.equal((await fetch(`${f.base}/api/chat`, { method: 'POST', headers: { authorization: f.headers.authorization }, body: '{}' })).status, 415);
    const huge = await fetch(`${f.base}/api/chat`, { method: 'POST', headers: f.headers, body: JSON.stringify({ text: 'x'.repeat(70000) }) });
    assert.equal(huge.status, 413);
    assert.equal((await fetch(`${f.base}/api/trace?after=-1`, { headers: f.headers })).status, 400);
    const send = await fetch(`${f.base}/api/chat`, { method: 'POST', headers: f.headers, body: JSON.stringify({ command: 'shutdown', requestId: randomUUID(), text: '<script>not HTML</script>', files: [] }) });
    assert.equal(send.status, 200);
    assert.equal((await request(f.home, { command: 'health' }) as { status: string }).status, 'ready');
  } finally { await f.close(); }
});

test('SSE replays persisted events from a cursor; bridge and browser disconnect do not cancel background work', async () => {
  const f = await fixture();
  let bridgeClosed = false;
  try {
    const initial = await (await fetch(`${f.base}/api/view`, { headers: f.headers })).json() as MainView;
    const file = join(f.home, 'authorized.txt'); await writeFile(file, 'only explicit file paths are readable');
    const sent = await fetch(`${f.base}/api/chat`, { method: 'POST', headers: f.headers, body: JSON.stringify({ requestId: 'web-idempotent', text: '分析文件', files: [file] }) });
    assert.equal(sent.status, 200);
    const first = await batch(f.base, f.headers, initial.cursor);
    assert.ok(first.events.every(event => event.seq > initial.cursor));
    assert.ok(first.cursor > initial.cursor);
    await fetch(`${f.base}/api/chat`, { method: 'POST', headers: f.headers, body: JSON.stringify({ requestId: 'second-message', text: '我继续在同一个对话中', files: [] }) });
    const next = await batch(f.base, f.headers, first.cursor);
    assert.ok(next.events.every(event => event.seq > first.cursor));
    await f.web.close(); bridgeClosed = true;
    let state: MainView | undefined;
    for (let i = 0; i < 150; i++) {
      state = await request(f.home, { command: 'view' }) as MainView;
      if (state.works.length === 1 && state.works[0]!.status === 'completed') break;
      await delay(20);
    }
    assert.equal(state!.works[0]?.status, 'completed');
    const another = await startWeb({ home: f.home });
    try {
      const entry = new URL(another.url);
      const restored = await (await fetch(`${entry.origin}/api/view`, { headers: { authorization: `Bearer ${entry.hash.split('token=')[1]}` } })).json() as MainView;
      assert.equal(restored.messages.items.filter(message => message.role === 'user').length, 2);
      assert.equal(restored.works[0]?.status, 'completed');
    } finally { await another.close(); }
  } finally { if (!bridgeClosed) await f.web.close(); await f.daemon.close(); await rm(f.home, { recursive: true, force: true }); }
});

test('Web reports unavailable daemon rather than fabricating successful responses or replaying requests', async () => {
  const f = await fixture();
  try {
    await f.daemon.close();
    const response = await fetch(`${f.base}/api/view`, { headers: f.headers });
    assert.equal(response.status, 503);
    assert.match((await response.json() as { error: string }).error, /连接不可用/);
  } finally { await f.close(); }
});

test('every module the page imports is actually served, so the UI cannot silently fail to boot', async () => {
  const f = await fixture();
  try {
    const client = await (await fetch(`${f.base}/client.js`)).text();
    const imported = [...client.matchAll(/from\s+'(\.[^']+)'/g)].map(match => match[1]!);
    assert.ok(imported.length >= 1, 'the client imports its shared view logic');
    for (const path of new Set(imported)) {
      const response = await fetch(`${f.base}/${path.replace(/^\.\//, '')}`);
      assert.equal(response.status, 200, `module ${path} must be served to the browser`);
      assert.match(response.headers.get('content-type') ?? '', /javascript/);
    }
    assert.equal((await fetch(`${f.base}/../src/agent.ts`)).status, 404, 'the asset map is a fixed allowlist');
  } finally { await f.close(); }
});



test('Web chat accepts a folder path and completes reads for every nested file', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const folder = join(f.home, 'authorized');
    await mkdir(join(folder, 'src'), { recursive: true });
    await writeFile(join(folder, 'README.md'), 'folder readme');
    await writeFile(join(folder, 'src', 'app.ts'), 'nested authorized code');
    const response = await fetch(`${f.base}/api/chat`, { method: 'POST', headers: f.headers,
      body: JSON.stringify({ requestId: randomUUID(), text: '分析这个文件夹', files: [folder + '/'] }) });
    assert.equal(response.status, 200);
    let view: MainView | undefined;
    for (let i = 0; i < 200; i++) {
      view = await (await fetch(`${f.base}/api/view`, { headers: f.headers })).json() as MainView;
      if (view.works[0]?.status === 'completed') break;
      await delay(30);
    }
    assert.equal(view?.works[0]?.status, 'completed');
    const work = await (await fetch(`${f.base}/api/work?taskId=${view!.works[0]!.id}`, { headers: f.headers })).json();
    assert.deepEqual(work.files.map((file: { name: string }) => file.name), ['authorized/README.md', 'authorized/src/app.ts']);
    assert.equal(work.operations.length, 2);
    assert.ok(work.operations.every((operation: { status: string }) => operation.status === 'succeeded'));
    const html = await (await fetch(f.base)).text();
    assert.match(html, /文件或文件夹/);
    assert.doesNotMatch(html, /不接受目录/);
  } finally { await f.close(); }
});

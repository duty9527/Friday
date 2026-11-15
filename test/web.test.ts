import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { serve } from '../dist/server.js';
import { startWeb } from '../dist/web-server.js';
import { XiaoaiSpeakerManager } from '../dist/xiaoai-speaker.js';
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
    for (const icon of ['/logo.png', '/favicon.ico', '/avatar.png']) {
      const res = await fetch(`${f.base}${icon}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/png');
    }
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

async function collectDistWebJsFiles(): Promise<Array<{ rel: string; text: string }>> {
  const webRoot = fileURLToPath(new URL('../dist/web/', import.meta.url));
  const out: Array<{ rel: string; text: string }> = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push({ rel, text: await readFile(full, 'utf8') });
    }
  }
  await walk(webRoot, '');
  return out;
}

test('every nested module the page or mindmap imports is served and path escapes are rejected', async () => {
  const f = await fixture();
  try {
    const visited = new Set<string>();
    const queue = ['/client.js', '/mindmap.js'];
    while (queue.length) {
      const modPath = queue.shift()!;
      if (visited.has(modPath)) continue;
      visited.add(modPath);
      const response = await fetch(`${f.base}${modPath}`);
      assert.equal(response.status, 200, `module ${modPath} must be served to the browser`);
      assert.match(response.headers.get('content-type') ?? '', /javascript/);
      const source = await response.text();
      const baseDir = posix.dirname(modPath);
      const specs = [
        ...[...source.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)].map(m => m[1]!),
        ...[...source.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g)].map(m => m[1]!),
      ];
      for (const relSpec of specs) {
        const resolved = posix.normalize(posix.join(baseDir, relSpec));
        if (!resolved.startsWith('..')) queue.push(resolved.startsWith('/') ? resolved : `/${resolved}`);
      }
    }
    assert.ok(visited.has('/shared/auth-http.js'), 'nested shared module must be reached and served');
    assert.ok(visited.has('/hubs/memory-hub.js'), 'nested hub module must be reached and served');
    assert.ok(visited.has('/panels/chat.js'), 'nested panel module must be reached and served');
    assert.ok(visited.has('/plugins/health-scale-ui.js'), 'lazy plugin UI module must be reached and served');
    assert.equal((await fetch(`${f.base}/../src/agent.ts`)).status, 404, 'path escape must return 404');
    assert.equal((await fetch(`${f.base}/shared/%2e%2e/%2e%2e/package.json`)).status, 404, 'encoded traversal must return 404');
    assert.equal((await fetch(`${f.base}/client.ts`)).status, 404, 'non-allowlisted extension must return 404');
  } finally { await f.close(); }
});

test('SSE broadcaster coalesces concurrent clients cleanly without per-client daemon stalls', async () => {
  const f = await fixture();
  const c1 = new AbortController();
  const c2 = new AbortController();
  const readNextUpdate = async (response: Response) => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error('Stream ended unexpectedly');
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.startsWith('event: updates')) {
            return JSON.parse(frame.split('\ndata: ')[1]!) as { events: TraceEvent[]; cursor: number; head: number };
          }
          if (frame.startsWith('event: problem')) throw new Error(frame);
        }
      }
    } finally {
      reader.releaseLock();
    }
  };
  try {
    const initial = await (await fetch(`${f.base}/api/view`, { headers: f.headers })).json() as MainView;
    const [r1, r2] = await Promise.all([
      fetch(`${f.base}/api/stream?after=${initial.cursor}`, { headers: f.headers, signal: c1.signal }),
      fetch(`${f.base}/api/stream?after=${initial.cursor}`, { headers: f.headers, signal: c2.signal }),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);

    const p1 = readNextUpdate(r1);
    const p2 = readNextUpdate(r2);
    const sent = await fetch(`${f.base}/api/chat`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ requestId: randomUUID(), text: '广播聚合测试', files: [] }),
    });
    assert.equal(sent.status, 200);
    const [u1, u2] = await Promise.all([p1, p2]);
    assert.ok(u1.cursor > initial.cursor && u2.cursor > initial.cursor);

    // Closing the first SSE client leaves the second client actively receiving further batches
    c1.abort();
    const r2Again = await fetch(`${f.base}/api/stream?after=${u2.cursor}`, { headers: f.headers, signal: c2.signal });
    assert.equal(r2Again.status, 200);
    const p2Again = readNextUpdate(r2Again);
    await fetch(`${f.base}/api/chat`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ requestId: randomUUID(), text: '第二个流继续收包', files: [] }),
    });
    const u2Again = await p2Again;
    assert.ok(u2Again.cursor > u2.cursor);
  } finally {
    c1.abort();
    c2.abort();
    await f.close();
  }
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

test('Mindmap standalone page serves strict CSP assets and aggregates real task flows via /api/mindmap', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const indexHtml = await (await fetch(f.base)).text();
    assert.match(indexHtml, /href="\/mindmap"/, 'main page links to /mindmap');

    for (const route of ['/mindmap', '/mindmap.html']) {
      const page = await fetch(`${f.base}${route}`);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
      const csp = page.headers.get('content-security-policy') ?? '';
      assert.match(csp, /script-src 'self'/);
      assert.match(csp, /style-src 'self'/);
      const html = await page.text();
      assert.match(html, /F\.R\.I\.D\.A\.Y\. · 会话思考流程图/);
      assert.doesNotMatch(html, /id="mm-flow-sidebar"/, 'dead #mm-flow-sidebar removed');
      assert.doesNotMatch(html, /\sstyle="/i, 'strict CSP forbids inline style attributes');
      assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'strict CSP forbids inline script tags');
    }

    const css = await fetch(`${f.base}/mindmap.css`);
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');

    const mindmapJsRes = await fetch(`${f.base}/mindmap.js`);
    assert.equal(mindmapJsRes.status, 200);
    assert.match(mindmapJsRes.headers.get('content-type') ?? '', /javascript/);
    const mindmapJs = await mindmapJsRes.text();
    assert.doesNotMatch(mindmapJs, /\.style\./, 'mindmap.ts must not mutate element.style under strict CSP');
    assert.doesNotMatch(mindmapJs, /setAttribute\(\s*['"]style['"]/, 'mindmap.ts must not set style attributes');

    const imported = [...mindmapJs.matchAll(/from\s+'(\.[^']+)'/g)].map(match => match[1]!);
    assert.ok(imported.includes('./mindmap-data.js'), 'mindmap.js imports mindmap-data.js');
    assert.ok(imported.includes('./shared/auth-http.js'), 'mindmap.js imports shared/auth-http.js');
    assert.doesNotMatch(mindmapJs, /#token=/, 'mindmap must not rewrite back links with #token=');
    for (const path of new Set(imported)) {
      const modRes = await fetch(`${f.base}/${path.replace(/^\.\//, '')}`);
      assert.equal(modRes.status, 200, `module ${path} must be served to the browser`);
      assert.match(modRes.headers.get('content-type') ?? '', /javascript/);
    }

    const dataJs = await (await fetch(`${f.base}/mindmap-data.js`)).text();
    for (const symbol of ['buildSessionFlowchart', 'buildOverviewFlowchart']) {
      assert.ok(dataJs.includes(symbol), `mindmap-data.js must export ${symbol}`);
    }
    for (const dead of ['buildAllTasksTree', 'buildSingleTaskTree', 'buildTaskFlowSubtree']) {
      assert.ok(!dataJs.includes(dead), `dead v1 tree builder ${dead} must be removed`);
    }

    // 未认证请求应返回 401
    assert.equal((await fetch(`${f.base}/api/mindmap`)).status, 401);

    // 发起一条触发后台工作的真实对话，随后紧跟一条关联追问并验证 /api/mindmap 会话聚合与阶段流程
    const folder = join(f.home, 'mm-sample');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'spec.md'), 'mindmap verification file');
    const chatRes = await fetch(`${f.base}/api/chat`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ requestId: randomUUID(), text: '请分析这个思维导图样本目录', files: [folder + '/'] }),
    });
    assert.equal(chatRes.status, 200);

    let view: MainView | undefined;
    for (let i = 0; i < 200; i++) {
      view = await (await fetch(`${f.base}/api/view`, { headers: f.headers })).json() as MainView;
      if (view.works[0]?.status === 'completed' && view.messages.items.some(m => m.role === 'assistant' && m.status === 'completed')) break;
      await delay(30);
    }
    assert.equal(view?.works[0]?.status, 'completed');

    const followupRes = await fetch(`${f.base}/api/chat`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ requestId: randomUUID(), text: '刚才那个目录里的 spec.md 具体写了什么？' }),
    });
    assert.equal(followupRes.status, 200);
    for (let i = 0; i < 200; i++) {
      const latestView = await (await fetch(`${f.base}/api/view`, { headers: f.headers })).json() as MainView;
      const userCount = latestView.messages.items.filter(m => m.role === 'user').length;
      const doneAssistantCount = latestView.messages.items.filter(m => m.role === 'assistant' && m.status === 'completed').length;
      if (userCount >= 2 && doneAssistantCount >= 2) break;
      await delay(30);
    }

    const mmRes = await fetch(`${f.base}/api/mindmap`, { headers: f.headers });
    assert.equal(mmRes.status, 200);
    const snapshot = await mmRes.json() as {
      summary: { totalFlows: number; totalTasks: number; totalSessions: number; multiTurnSessions: number };
      sessions: Array<{
        id: string;
        turnCount: number;
        turnFlowIds: string[];
        turnSummaries: Array<{ textPreview: string; link?: { kind: string; source: string; label: string } }>;
      }>;
      flows: Array<{
        id: string;
        sessionId?: string;
        turnIndex?: number;
        turnCount?: number;
        sessionLink?: { kind: string; source: string; label: string };
        ingress: { sourceKind: string; text: string };
        routerTurns: unknown[];
        tasks: Array<{
          id: string;
          status: string;
          executionPhases: Array<{ index: number; isFollowup: boolean; llmCount: number; toolCount: number }>;
          jevRoute?: { request: { decisionModel: string; fileCount: number }; response: Record<string, unknown> };
          workerSteps: Array<{ kind: string; phaseIndex?: number }>;
        }>;
        deliveries: Array<{ text: string; status: string }>;
        imPush: { channel: string; delivered: boolean };
      }>;
    };
    assert.ok(snapshot.summary.totalFlows >= 2);
    assert.ok(snapshot.summary.totalTasks >= 1);
    assert.ok(snapshot.summary.totalSessions >= 1);
    assert.ok(snapshot.sessions.length >= 1);
    const flow = snapshot.flows.find(item => item.ingress.text.includes('请分析这个思维导图样本目录'));
    const followupFlow = snapshot.flows.find(item => item.ingress.text.includes('刚才那个目录里的 spec.md'));
    assert.ok(flow && followupFlow, 'both related user turns must be present in snapshot.flows');
    assert.equal(flow.ingress.sourceKind, 'local');
    assert.ok(flow.routerTurns.length >= 1, 'flow includes router decision turns');
    assert.equal(flow.tasks.length, 1);
    assert.equal(flow.tasks[0]!.status, 'completed');
    assert.ok(flow.tasks[0]!.executionPhases.length >= 1, 'task includes executionPhases breakdown');
    assert.ok(flow.tasks[0]!.jevRoute?.request.decisionModel, 'task includes JEV route request info');
    assert.ok(flow.tasks[0]!.workerSteps.length >= 1, 'task includes worker execution steps');
    assert.ok(flow.deliveries.length >= 1 && flow.imPush.delivered, 'flow includes final delivery and IM push target');

    assert.equal(flow.sessionId, followupFlow.sessionId, 'consecutive related turns must aggregate into the same AI session');
    assert.ok((followupFlow.turnCount ?? 0) >= 2 && followupFlow.turnIndex === 2);
    assert.ok(followupFlow.sessionLink?.label, 'followup turn records contextual session link');
    const groupedSession = snapshot.sessions.find(s => s.id === flow.sessionId);
    assert.ok(groupedSession && groupedSession.turnCount >= 2 && groupedSession.turnFlowIds.includes(flow.id) && groupedSession.turnFlowIds.includes(followupFlow.id));
  } finally { await f.close(); }
});

test('Web console exposes XiaoAI voiceprint status, listing, gate toggling, removal, and strict CSP compliance across all dist/web/*.js', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.base}/api/voiceprints`)).status, 401);
    assert.equal((await fetch(`${f.base}/api/voice-remove`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);

    const html = await (await fetch(f.base)).text();
    assert.match(html, /id="im-voice-list"/);
    assert.match(html, /id="im-voice-toggle-btn"/);
    assert.match(html, /id="im-voice-clear-btn"/);
    assert.doesNotMatch(html, /\sstyle="/i, 'strict CSP forbids inline style attributes in index.html');

    const css = await (await fetch(`${f.base}/style.css`)).text();
    assert.ok(css.includes('.voiceprint-hero-card') && css.includes('.origin-speaker-badge') && css.includes('.badge-purple'));

    const allWebJs = await collectDistWebJsFiles();
    assert.ok(allWebJs.length >= 10, 'modular build emits client, panels, hubs, shared, plugins, and mindmap modules');
    for (const file of allWebJs) {
      assert.doesNotMatch(file.text, /\.style\./, `${file.rel} must not mutate element.style under strict CSP`);
      assert.doesNotMatch(file.text, /setAttribute\(\s*['"]style['"]/, `${file.rel} must not set style attributes`);
      assert.doesNotMatch(file.text, /\.innerHTML\b/, `${file.rel} must not assign innerHTML`);
    }

    const manager = new XiaoaiSpeakerManager({ homeDir: f.home });
    manager.enrollEmbeddings({ name: '主人', role: 'owner', embeddings: [new Float32Array([1, 0, 0, 0])] });
    manager.enrollEmbeddings({ name: '老婆', role: 'member', embeddings: [new Float32Array([0, 1, 0, 0])] });

    const viewRes = await (await fetch(`${f.base}/api/view`, { headers: f.headers })).json() as MainView;
    assert.equal(viewRes.voiceprint?.enabled, true);
    assert.equal(viewRes.voiceprint?.profiles.length, 2);
    assert.equal(viewRes.voiceprint?.profiles[0]?.name, '主人');
    assert.equal(viewRes.voiceprint?.profiles[0]?.role, 'owner');
    assert.doesNotMatch(JSON.stringify(viewRes.voiceprint), new RegExp(f.home));

    const listRes = await (await fetch(`${f.base}/api/voiceprints`, { headers: f.headers })).json() as Record<string, unknown>;
    assert.equal((listRes.profiles as Array<{ name: string }>).length, 2);
    assert.equal('modelPath' in listRes, false);
    assert.doesNotMatch(JSON.stringify(listRes), new RegExp(f.home));

    const pauseRes = await (await fetch(`${f.base}/api/voice-config`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ enabled: false }),
    })).json() as Record<string, unknown>;
    assert.equal(pauseRes.enabled, false);
    assert.equal(pauseRes.active, false);
    assert.equal('modelPath' in pauseRes, false);

    const resumeRes = await (await fetch(`${f.base}/api/voice-config`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ enabled: true }),
    })).json() as Record<string, unknown>;
    assert.equal(resumeRes.enabled, true);

    const removeRes = await (await fetch(`${f.base}/api/voice-remove`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ target: '主人' }),
    })).json() as { removed: boolean; name?: string; remaining: number };
    assert.equal(removeRes.removed, true);
    assert.equal(removeRes.name, '主人');
    assert.equal(removeRes.remaining, 1);

    const afterRemove = await (await fetch(`${f.base}/api/voiceprints`, { headers: f.headers })).json() as { profiles: Array<{ name: string; role: string }> };
    assert.equal(afterRemove.profiles.length, 1);
    assert.equal(afterRemove.profiles[0]?.name, '老婆');
    assert.equal(afterRemove.profiles[0]?.role, 'owner');

    const clearRes = await (await fetch(`${f.base}/api/voice-clear`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({}),
    })).json() as { cleared: number };
    assert.equal(clearRes.cleared, 1);

    const afterClear = await (await fetch(`${f.base}/api/voiceprints`, { headers: f.headers })).json() as { profiles: unknown[] };
    assert.equal(afterClear.profiles.length, 0);
  } finally { await f.close(); }
});

test('Web console lazy-loads health-scale UI, serves redacted PluginView metadata, and completes profile-save + record-add', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const html = await (await fetch(f.base)).text();
    assert.match(html, /id="open-health-hub-top"/);
    assert.match(html, /id="health-hub-modal"/);
    assert.match(html, /id="health-trend-canvas"/);
    assert.doesNotMatch(html, /\sstyle="/i);
    assert.doesNotMatch(html, /<input[^>]+type=["']file["']/i);
    assert.doesNotMatch(html, /018168|192\.168\./, 'index.html must not contain hardcoded personal samples');

    const clientJs = await (await fetch(`${f.base}/client.js`)).text();
    assert.match(clientJs, /import\(\s*['"]\.\/plugins\/health-scale-ui\.js['"]\s*\)/, 'client.js must dynamically lazy-load health-scale-ui.js');
    assert.doesNotMatch(clientJs, /healthDashboard/, 'health-scale dashboard logic must not be eagerly bundled into client.js');

    const healthUiJs = await (await fetch(`${f.base}/plugins/health-scale-ui.js`)).text();
    assert.match(healthUiJs, /initHealthScaleUi/);

    const viewRes = await (await fetch(`${f.base}/api/view`, { headers: f.headers })).json() as MainView;
    for (const plugin of viewRes.plugins ?? []) {
      const rec = plugin as unknown as Record<string, unknown>;
      assert.equal('entryPath' in rec, false, 'redacted PluginView must not expose entryPath');
      assert.equal('dir' in rec, false, 'redacted PluginView must not expose dir');
      assert.equal('dataDir' in rec, false, 'redacted PluginView must not expose dataDir');
      assert.equal('sourceCode' in rec, false, 'redacted PluginView must not expose sourceCode');
    }

    const profileRes = await (await fetch(`${f.base}/api/plugin-run`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({
        plugin: 'health-scale',
        action: 'profile-save',
        args: { name: '测试成员', sex: 'male', age: 29, heightCm: 175, setDefault: true },
      }),
    })).json() as { ok: boolean; data?: { activeProfile?: { name: string } } };
    assert.equal(profileRes.ok, true);
    assert.equal(profileRes.data?.activeProfile?.name, '测试成员');

    const addRes = await (await fetch(`${f.base}/api/plugin-run`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({
        plugin: 'health-scale',
        action: 'record-add',
        args: { weightKg: 68.4, impedanceOhm: 495, note: 'web-test' },
      }),
    })).json() as { ok: boolean; plugin: string; data?: { latest?: { weightKg: number; metrics?: { estimationMode: string; items: unknown[] } } } };
    assert.equal(addRes.ok, true);
    assert.equal(addRes.plugin, 'health-scale');
    assert.equal(addRes.data?.latest?.weightKg, 68.4);
    assert.equal(addRes.data?.latest?.metrics?.estimationMode, 'bia');
    assert.ok((addRes.data?.latest?.metrics?.items.length ?? 0) >= 16);

    const dashRes = await (await fetch(`${f.base}/api/plugin-run`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ plugin: 'health-scale', action: 'dashboard', args: {} }),
    })).json() as { ok: boolean; data?: { records: unknown[] } };
    assert.equal(dashRes.ok, true);
    assert.equal(dashRes.data?.records.length, 1);
  } finally { await f.close(); }
});

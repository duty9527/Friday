import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createNetServer, type Socket } from 'node:net';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWeb } from '../src/web-server.js';
import { socketPath } from '../src/protocol.js';
import type { ChatMessage, TraceEvent } from '../src/view.js';
import { summarizeSystemNotice } from '../src/web/shared/chat-view.js';
import { renderMarkdownContent } from '../src/web/shared/markdown.js';
import { initMobileViewport, isIosStandaloneClipped } from '../src/web/shared/mobile-viewport.js';
import { createSharedSseHub, type BroadcastChannelLike, type SseUpdateBatch } from '../src/web/shared/sse-hub.js';
import { buildExecutionChain } from '../src/web/trace-chain.js';
import type { MindmapSnapshot, MindmapTaskFlow } from '../src/web/mindmap-data.js';

interface ListenerEntry {
  fn: (event: unknown) => void;
}

class MockElement {
  nodeType = 1;
  tagName: string;
  id = '';
  value = '';
  textContent = '';
  title = '';
  type = 'button';
  hidden = false;
  disabled = false;
  open = false;
  readOnly = false;
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 100;
  scrollWidth = 100;
  clientWidth = 100;
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  parentElement: MockElement | null = null;
  parentNode: MockElement | null = null;
  children: MockElement[] = [];
  childNodes: MockElement[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, ListenerEntry[]>();
  private classes = new Set<string>();
  dataset = new Proxy<Record<string, string>>({}, {
    get: (_target, prop) => typeof prop === 'string' ? this.attributes.get(`data-${prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`) : undefined,
    set: (_target, prop, val) => {
      if (typeof prop === 'string') {
        this.attributes.set(`data-${prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`, String(val));
      }
      return true;
    },
    deleteProperty: (_target, prop) => {
      if (typeof prop === 'string') {
        this.attributes.delete(`data-${prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`);
      }
      return true;
    },
  });

  constructor(tag = 'div', nodeType = 1, text = '') {
    this.tagName = tag.toUpperCase();
    this.nodeType = nodeType;
    this.textContent = text;
  }

  get className(): string {
    return [...this.classes].join(' ');
  }

  set className(val: string) {
    this.classes.clear();
    for (const part of val.split(/\s+/).filter(Boolean)) this.classes.add(part);
  }

  get isConnected(): boolean {
    return true;
  }

  get firstElementChild(): MockElement | null {
    return this.children[0] ?? null;
  }

  get lastElementChild(): MockElement | null {
    return this.children.at(-1) ?? null;
  }

  get innerText(): string {
    return this.collectText();
  }

  collectText(): string {
    if (this.nodeType === 3 || this.children.length === 0) return this.textContent;
    return this.children.map(c => c.collectText()).join('');
  }

  classList = {
    add: (...names: string[]) => { names.forEach(n => this.classes.add(n)); },
    remove: (...names: string[]) => { names.forEach(n => this.classes.delete(n)); },
    toggle: (name: string, force?: boolean) => {
      if (force === undefined) {
        if (this.classes.has(name)) { this.classes.delete(name); return false; }
        this.classes.add(name);
        return true;
      }
      if (force) this.classes.add(name);
      else this.classes.delete(name);
      return force;
    },
    contains: (name: string) => this.classes.has(name),
  };

  setAttribute(name: string, val: string): void {
    this.attributes.set(name, String(val));
    if (name === 'id') this.id = String(val);
    if (name === 'class') this.className = String(val);
  }

  getAttribute(name: string): string | null {
    if (name === 'id') return this.id || null;
    return this.attributes.get(name) ?? null;
  }

  append(...items: Array<MockElement | string>): void {
    for (const item of items) {
      if (typeof item === 'string') {
        this.appendChild(new MockElement('#text', 3, item));
      } else {
        this.appendChild(item);
      }
    }
  }

  appendChild(child: MockElement): MockElement {
    if (child.nodeType === 11) {
      for (const nested of [...child.children]) this.appendChild(nested);
      child.children = [];
      child.childNodes = [];
      return child;
    }
    child.remove();
    child.parentElement = this;
    child.parentNode = this;
    this.children.push(child);
    this.childNodes.push(child);
    return child;
  }

  insertBefore(newNode: MockElement, refNode: MockElement | null): MockElement {
    if (newNode.nodeType === 11) {
      for (const nested of [...newNode.children]) this.insertBefore(nested, refNode);
      newNode.children = [];
      newNode.childNodes = [];
      return newNode;
    }
    newNode.remove();
    newNode.parentElement = this;
    newNode.parentNode = this;
    const idx = refNode ? this.children.indexOf(refNode) : -1;
    if (idx >= 0) {
      this.children.splice(idx, 0, newNode);
      this.childNodes.splice(idx, 0, newNode);
    } else {
      this.children.push(newNode);
      this.childNodes.push(newNode);
    }
    return newNode;
  }

  replaceChildren(...items: Array<MockElement | string>): void {
    for (const existing of [...this.children]) {
      existing.parentElement = null;
      existing.parentNode = null;
    }
    this.children = [];
    this.childNodes = [];
    this.append(...items);
  }

  remove(): void {
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx >= 0) {
      this.parentNode.children.splice(idx, 1);
      this.parentNode.childNodes.splice(idx, 1);
    }
    this.parentElement = null;
    this.parentNode = null;
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ fn });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type);
    if (!list) return;
    this.listeners.set(type, list.filter(item => item.fn !== fn));
  }

  dispatchEvent(event: Record<string, unknown>): boolean {
    event.target ??= this;
    let prevented = false;
    event.preventDefault ??= () => {
      if (event.cancelable !== false) {
        prevented = true;
        event.defaultPrevented = true;
      }
    };
    event.stopPropagation ??= () => {};
    let cur: MockElement | null = this;
    while (cur) {
      for (const entry of [...(cur.listeners.get(String(event.type)) ?? [])]) {
        entry.fn(event);
      }
      cur = cur.parentElement;
    }
    return !prevented;
  }

  matches(selector: string): boolean {
    const parts = selector.split(',').map(s => s.trim()).filter(Boolean);
    return parts.some(part => {
      const tokens = part.match(/(?:#[^\s.#[\]]+|\.[^\s.#[\]]+|\[[^\]]+\]|^[a-zA-Z0-9_-]+)/g);
      if (!tokens || tokens.join('') !== part) return false;
      return tokens.every(tok => {
        if (tok.startsWith('#')) return this.id === tok.slice(1);
        if (tok.startsWith('.')) return this.classes.has(tok.slice(1));
        if (tok.startsWith('[')) {
          const inner = tok.slice(1, -1).split('=')[0]!;
          return this.attributes.has(inner);
        }
        return this.tagName === tok.toUpperCase();
      });
    });
  }

  closest(selector: string): MockElement | null {
    let cur: MockElement | null = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const out: MockElement[] = [];
    const walk = (node: MockElement) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): MockElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  contains(other: MockElement | null): boolean {
    let cur = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  focus(): void {}
  scrollTo(): void {}
  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight };
  }
}

function createDomEnv(initialHash = `#token=${'a'.repeat(64)}`) {
  const saved: Record<string, PropertyDescriptor | undefined> = {};
  const keys = [
    'window', 'document', 'location', 'history', 'sessionStorage', 'localStorage',
    'fetch', 'Node', 'Element', 'HTMLElement', 'navigator', 'performance', 'requestAnimationFrame',
    'cancelAnimationFrame',
  ];
  for (const key of keys) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  }

  const rootBody = new MockElement('body');
  const docEl = new MockElement('html');
  docEl.appendChild(rootBody);
  const byId = new Map<string, MockElement>();
  const getOrCreateEl = (id: string): MockElement => {
    let el = byId.get(id);
    if (!el) {
      el = new MockElement('div');
      el.id = id;
      byId.set(id, el);
    }
    return el;
  };

  const docListeners = new Map<string, ListenerEntry[]>();
  const winListeners = new Map<string, ListenerEntry[]>();
  const storage = new Map<string, string>();

  const dispatchTargetListeners = (map: Map<string, ListenerEntry[]>, event: Record<string, unknown>) => {
    for (const entry of [...(map.get(String(event.type)) ?? [])]) {
      entry.fn(event);
    }
  };

  const documentMock = {
    hidden: false,
    cookie: '',
    body: rootBody,
    documentElement: docEl,
    activeElement: null,
    getElementById: (id: string) => getOrCreateEl(id),
    createElement: (tag: string) => new MockElement(tag),
    createElementNS: (_ns: string, tag: string) => new MockElement(tag),
    createTextNode: (text: string) => new MockElement('#text', 3, text),
    createDocumentFragment: () => new MockElement('#fragment', 11),
    querySelector: () => null,
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      const list = docListeners.get(type) ?? [];
      list.push({ fn });
      docListeners.set(type, list);
    },
    removeEventListener: (type: string, fn: (ev: unknown) => void) => {
      const list = docListeners.get(type);
      if (list) docListeners.set(type, list.filter(e => e.fn !== fn));
    },
    dispatchEvent: (event: Record<string, unknown>) => {
      let defaultPrevented = false;
      event.defaultPrevented = false;
      event.preventDefault = () => {
        if (event.cancelable !== false) {
          defaultPrevented = true;
          event.defaultPrevented = true;
        }
      };
      event.stopPropagation = () => {};
      dispatchTargetListeners(docListeners, event);
      return !defaultPrevented;
    },
  };

  const windowMock = {
    scrollX: 0,
    scrollY: 0,
    scrollTo: () => {},
    matchMedia: (_q: string) => ({ matches: false }),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: (type: string, fn: (ev: unknown) => void) => {
      const list = winListeners.get(type) ?? [];
      list.push({ fn });
      winListeners.set(type, list);
    },
    removeEventListener: (type: string, fn: (ev: unknown) => void) => {
      const list = winListeners.get(type);
      if (list) winListeners.set(type, list.filter(e => e.fn !== fn));
    },
    dispatchEvent: (event: Record<string, unknown>) => {
      dispatchTargetListeners(winListeners, event);
      return true;
    },
  };

  const storageMock = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v); },
    removeItem: (k: string) => { storage.delete(k); },
  };

  const assign = (name: string, value: unknown) => {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  assign('window', windowMock);
  assign('document', documentMock);
  assign('location', { hash: initialHash, pathname: '/', search: '' });
  assign('history', { replaceState: () => {} });
  assign('sessionStorage', storageMock);
  assign('localStorage', storageMock);
  assign('Node', MockElement);
  assign('Element', MockElement);
  assign('HTMLElement', MockElement);

  const restore = () => {
    for (const key of keys) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]!);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };

  return {
    rootBody,
    getOrCreateEl,
    documentMock,
    windowMock,
    assign,
    restore,
  };
}

async function mockIpcFixture(handler: (command: Record<string, unknown>) => unknown) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-audit-ipc-'));
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

test('summarizeSystemNotice falls back cleanly when line 1 only contains [系统通知] prefix', () => {
  const baseMsg: ChatMessage = {
    id: 'sys-1',
    seq: 1,
    version: 1,
    at: 1_700_000_000_000,
    role: 'assistant',
    source: 'system',
    text: '[系统通知]\n磁盘空间异常：剩余不足 5%',
    status: 'completed',
    mode: 'offline',
    paths: [],
    taskIds: [],
  };
  const withBodyOnLine2 = summarizeSystemNotice(baseMsg);
  assert.equal(withBodyOnLine2.title, '磁盘空间异常：剩余不足 5%');
  assert.equal(withBodyOnLine2.badge, '状态告警');
  assert.equal(withBodyOnLine2.expandable, true);

  const prefixOnly = summarizeSystemNotice({ ...baseMsg, text: '系统消息:' });
  assert.equal(prefixOnly.title, '系统状态更新');
});

test('markdown code copy button cancels earlier reset timer on rapid double-click', async () => {
  const env = createDomEnv();
  try {
    let clipboardWrites = 0;
    env.assign('navigator', {
      clipboard: {
        writeText: async (_text: string) => {
          clipboardWrites += 1;
        },
      },
    });
    const doc = env.documentMock as unknown as Document;
    const frag = renderMarkdownContent('```js\nconst x = 1;\n```', {
      doc,
      createEmote: () => new MockElement('span') as unknown as Node,
      createSticker: () => new MockElement('span') as unknown as Node,
    }) as unknown as MockElement;
    const copyBtn = frag.querySelector('.md-code-copy');
    assert.ok(copyBtn, 'rendered code block must include copy button');

    copyBtn.dispatchEvent({ type: 'click' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(clipboardWrites, 1);
    assert.equal(copyBtn.textContent, '✓ 已复制');
    assert.equal(copyBtn.classList.contains('is-copied'), true);

    await new Promise(resolve => setTimeout(resolve, 900));
    copyBtn.dispatchEvent({ type: 'click' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(clipboardWrites, 2);

    // 700ms after 2nd click (> 1500ms after 1st click): 1st click's timer MUST have been cancelled.
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(copyBtn.textContent, '✓ 已复制');
    assert.equal(copyBtn.classList.contains('is-copied'), true);

    // After 2nd click's 1500ms window passes, label & class reset cleanly.
    await new Promise(resolve => setTimeout(resolve, 900));
    assert.equal(copyBtn.textContent, '复制');
    assert.equal(copyBtn.classList.contains('is-copied'), false);
  } finally {
    env.restore();
  }
});

test('buildExecutionChain uses span label fallback preview for SDK maintenance spans without metrics or errors', () => {
  const chain = buildExecutionChain({
    scope: { type: 'all' },
    cursor: 1,
    streamedTextBySpan: {},
    messages: [],
    linkedTasks: [],
    events: [{
      id: 'ev-sdk-1',
      rootId: 'r1',
      actor: 'worker',
      seq: 1,
      at: 1_700_000_000_000,
      type: 'trace',
      kind: 'span',
      spanId: 'sdk-compact-1',
      label: '上下文压缩（SDK）',
      status: 'completed',
      data: { detail: {} },
    }],
  });
  const node = chain.nodes.find(n => n.id === 'sdk-compact-1');
  assert.ok(node);
  assert.equal(node.preview, '上下文压缩（SDK）');
});

test('SharedSseHub rolls back localCursor on cursor regression even when reset flag is omitted', async () => {
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

  const streamUrls: string[] = [];
  let pushLeaderBatch: ((batch: SseUpdateBatch) => void) | undefined;

  const makeMockRequest = () => async (path: string, init?: RequestInit): Promise<Response> => {
    streamUrls.push(path);
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        pushLeaderBatch = batch => {
          controller.enqueue(encoder.encode(`event: updates\ndata: ${JSON.stringify(batch)}\n\n`));
        };
        init?.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const tab1 = createSharedSseHub({
    token: 'a'.repeat(64),
    tabId: 'tab-a',
    createChannel: () => new MockChannel(),
    request: makeMockRequest(),
    isStopped: () => false,
    onUpdates: () => {},
  });
  const tab2 = createSharedSseHub({
    token: 'a'.repeat(64),
    tabId: 'tab-b',
    createChannel: () => new MockChannel(),
    request: makeMockRequest(),
    isStopped: () => false,
    onUpdates: () => {},
  });

  try {
    tab1.start(40);
    tab2.start(40);
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(tab1.isLeader(), true);

    pushLeaderBatch!({
      events: [{ id: 'ev-3', rootId: 'r1', actor: 'user', seq: 3, at: 100, type: 'message', kind: 'user', label: 'u', status: 'completed' }],
      cursor: 3,
      head: 3,
    });
    await new Promise(resolve => setTimeout(resolve, 50));

    // Closing leader promotes tab2, whose follow-up stream must start from rolled-back cursor 3, never stale 40.
    tab1.stop();
    await new Promise(resolve => setTimeout(resolve, 220));
    assert.equal(tab2.isLeader(), true);
    assert.equal(streamUrls.at(-1), '/api/stream?after=3');
  } finally {
    tab1.stop();
    tab2.stop();
  }
});

test('web-server rejects blank numeric query parameters (400) and sends reset:true to trailing clients on SSE rollback', async () => {
  const mock = await mockIpcFixture(cmd => {
    if (cmd.command === 'health') return { status: 'ready' };
    if (cmd.command !== 'updates') return {};
    const evs: TraceEvent[] = [
      { id: 'ev-1', rootId: 'r1', actor: 'user', seq: 1, at: 1000, type: 'message', kind: 'user', label: 'u1', status: 'completed' },
      { id: 'ev-2', rootId: 'r1', actor: 'router', seq: 2, at: 1001, type: 'message', kind: 'assistant', label: 'a1', status: 'completed' },
    ];
    return { events: evs, cursor: 2, head: 2 };
  });

  try {
    for (const url of [
      `${mock.base}/api/history?before=`,
      `${mock.base}/api/history?before=%20`,
      `${mock.base}/api/trace?after=`,
      `${mock.base}/api/mindmap?limit=`,
      `${mock.base}/api/stream?after=`,
    ]) {
      const res = await fetch(url, { headers: mock.headers });
      assert.equal(res.status, 400, `${url} must return 400 on blank numeric parameter`);
    }

    const c1 = new AbortController();
    const c2 = new AbortController();
    const readUpdate = async (res: Response) => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) throw new Error('Stream ended prematurely');
          buf += decoder.decode(value, { stream: true });
          const idx = buf.indexOf('\n\n');
          if (idx >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (block.startsWith('event: updates')) {
              return JSON.parse(block.split('\ndata: ')[1]!) as { events: TraceEvent[]; cursor: number; head: number; reset?: boolean };
            }
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    };

    try {
      const [r1, r2] = await Promise.all([
        fetch(`${mock.base}/api/stream?after=0`, { headers: mock.headers, signal: c1.signal }),
        fetch(`${mock.base}/api/stream?after=40`, { headers: mock.headers, signal: c2.signal }),
      ]);
      const [u1, u2] = await Promise.all([readUpdate(r1), readUpdate(r2)]);
      assert.equal(u1.reset, undefined);
      assert.equal(u2.reset, true, 'trailing client with cursor 40 > head 2 must receive reset: true alongside recovered events');
      assert.deepEqual(u2.events.map(e => e.seq), [1, 2]);
    } finally {
      c1.abort();
      c2.abort();
    }
  } finally {
    await mock.close();
  }
});

test('initTracePanel renders tool operation output after switching away and back while /api/operation is in flight', async () => {
  const env = createDomEnv();
  try {
    const { appState } = await import('../src/web/state.js');
    const { initTracePanel } = await import('../src/web/panels/trace.js');
    Object.assign(appState, {
      ready: true,
      authExpired: false,
      traceMode: 'steps',
      traceEvents: [],
      traceAfter: 0,
      traceHasMore: false,
      traceHasEarlier: false,
      selectedNodeId: undefined,
      selectionPinned: false,
      traceCategory: 'all',
      workData: undefined,
      traceBundle: undefined,
    });
    appState.operationTextCache.clear();
    appState.stopRequests.clear();

    let opFetchCount = 0;
    let resolveOp!: (res: Response) => void;
    env.assign('fetch', (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/operation')) {
        opFetchCount += 1;
        return new Promise<Response>(resolve => { resolveOp = resolve; });
      }
      if (url.includes('/api/execution-trace') || url.includes('/api/work')) {
        const body = url.includes('/api/execution-trace')
          ? {
              scope: { type: 'task', id: 'task-1' },
              cursor: 2,
              streamedTextBySpan: {},
              messages: [],
              linkedTasks: [],
              events: [{
                id: 'ev-tool-1',
                rootId: 'm1',
                taskId: 'task-1',
                actor: 'worker',
                seq: 1,
                at: 1000,
                type: 'trace',
                kind: 'span',
                spanId: 'wturn:call-1',
                label: 'bash',
                status: 'completed',
                data: { detail: { input: { command: 'echo hi' } } },
              }, {
                id: 'ev-op-1',
                rootId: 'm1',
                taskId: 'task-1',
                actor: 'executor',
                seq: 2,
                at: 1010,
                type: 'trace',
                kind: 'operation',
                spanId: 'op-1',
                parentSpanId: 'wturn:call-1',
                label: '执行命令',
                status: 'succeeded',
                data: { operationId: 'op-1', preview: 'short...', truncated: true, hasFullResult: true },
              }],
            }
          : { id: 'task-1', prompt: 'run check', status: 'completed', createdAt: 1000, activeMs: 10, limitMs: 60_000, operations: [] };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    });

    const panel = initTracePanel();
    panel.selectTrace({ type: 'task', id: 'task-1', label: 'task 1' }, true);
    await new Promise(resolve => setTimeout(resolve, 25));

    const toolCard = env.getOrCreateEl('trace-content').querySelector('.chain-card.cat-tool');
    assert.ok(toolCard, 'tool node card should be rendered');
    toolCard.dispatchEvent({ type: 'click' });
    assert.equal(opFetchCount, 1);
    assert.match(env.getOrCreateEl('event-detail').innerText, /正在读取完整执行结果/);

    // Switch away to task-2 then immediately back to task-1 before /api/operation settles.
    panel.selectTrace({ type: 'task', id: 'task-2', label: 'task 2' }, true);
    panel.selectTrace({ type: 'task', id: 'task-1', label: 'task 1' }, true);
    await new Promise(resolve => setTimeout(resolve, 25));

    const toolCardAgain = env.getOrCreateEl('trace-content').querySelector('.chain-card.cat-tool');
    assert.ok(toolCardAgain);
    toolCardAgain.dispatchEvent({ type: 'click' });
    assert.equal(opFetchCount, 1, 'should reuse in-flight operation fetch');
    assert.match(env.getOrCreateEl('event-detail').innerText, /正在读取完整执行结果/);

    // Resolve original fetch from earlier generation: inspector must update automatically!
    resolveOp(new Response(JSON.stringify({ result: 'FULL_OP_OUTPUT_VERIFIED' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.match(env.getOrCreateEl('event-detail').innerText, /FULL_OP_OUTPUT_VERIFIED/);

    // selectTrace hides #trace-more even when !appState.ready
    appState.traceHasMore = true;
    env.getOrCreateEl('trace-more').hidden = false;
    appState.ready = false;
    panel.selectTrace({ type: 'all' }, false);
    assert.equal(env.getOrCreateEl('trace-more').hidden, true);
  } finally {
    env.restore();
  }
});

test('initChatPanel clears draftTyping on confirmed send error, guards loadOlder across DB reset, allows mobile modal scroll, and updates quote links', async () => {
  const env = createDomEnv();
  try {
    // Enable mobile media query so touchmove handler runs
    env.assign('window', {
      ...env.windowMock,
      matchMedia: (q: string) => ({ matches: q.includes('max-width: 730px') }),
    });

    const { appState, hooks } = await import('../src/web/state.js');
    const { initChatPanel } = await import('../src/web/panels/chat.js');
    appState.messages.clear();
    appState.ready = true;
    appState.authExpired = false;
    appState.sending = false;
    appState.uncertain = false;
    appState.pending = undefined;
    appState.cursor = 50;
    appState.historyBefore = 25;
    appState.historyHasMore = true;
    appState.historyBusy = false;
    appState.selection = { type: 'all' };
    appState.selectionPinned = false;
    appState.stopRequests.clear();

    let releaseHistory!: (res: Response) => void;
    let lastSendRequestId = '';
    env.assign('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/chat')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { requestId: string };
        lastSendRequestId = body.requestId;
        // Simulate SSE delivering the accepted message before /api/chat fails
        appState.messages.set('m-confirmed', {
          id: 'm-confirmed',
          seq: 51,
          version: 1,
          requestId: lastSendRequestId,
          at: 1000,
          role: 'user',
          text: 'draft check',
          status: 'completed',
          mode: 'offline',
          paths: [],
          taskIds: [],
        });
        return Promise.resolve(new Response(JSON.stringify({ error: 'network timeout' }), {
          status: 504,
          headers: { 'content-type': 'application/json' },
        }));
      }
      if (url.includes('/api/history')) {
        return new Promise<Response>(resolve => { releaseHistory = resolve; });
      }
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    });

    const draftEl = env.getOrCreateEl('draft');
    const composerEl = env.getOrCreateEl('composer');
    const olderBtn = env.getOrCreateEl('older');
    const messagesEl = env.getOrCreateEl('messages');
    const scrollEl = env.getOrCreateEl('messages-scroll');
    scrollEl.scrollHeight = 400;
    scrollEl.clientHeight = 400;
    Object.assign(hooks, {
      connection: () => {},
      selectTrace: () => {},
      showPanel: () => {},
      scheduleRefresh: () => {},
      stopWork: async () => {},
    });

    const panel = initChatPanel();

    // 1. Confirmed error branch must clear draftTyping
    draftEl.value = 'draft check';
    draftEl.dispatchEvent({ type: 'input' });
    assert.equal(panel.isDraftTyping(), true);
    composerEl.dispatchEvent({ type: 'submit' });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(draftEl.value, '');
    assert.equal(panel.isDraftTyping(), false, 'confirmed send error must stop typing indicator');

    // 2. Quoted user message gets upgraded from static div to clickable jump button when earlier quoted message arrives via loadOlder
    const olderMsg: ChatMessage = {
      id: 'm-orig',
      seq: 10,
      version: 1,
      at: 900,
      role: 'user',
      text: '原始需要引用的关键内容',
      status: 'completed',
      mode: 'offline',
      paths: [],
      taskIds: [],
    };
    const quoteMsg: ChatMessage = {
      id: 'm-quote',
      seq: 60,
      version: 1,
      at: 1200,
      role: 'user',
      text: '【引用你之前的消息】\n原始需要引用的关键内容\n\n再确认一下',
      status: 'completed',
      mode: 'offline',
      paths: [],
      taskIds: [],
    };
    panel.mergeMessages([quoteMsg]);
    panel.renderMessages();
    const initialQuoteBtn = messagesEl.querySelector('.user-reply-quote');
    assert.ok(initialQuoteBtn && initialQuoteBtn.tagName === 'DIV' && initialQuoteBtn.classList.contains('is-static'));

    // Now click loadOlder and deliver olderMsg without cursor reset
    appState.cursor = 60;
    appState.historyBefore = 60;
    olderBtn.dispatchEvent({ type: 'click' });
    releaseHistory(new Response(JSON.stringify({ items: [olderMsg], before: 10, hasMore: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await new Promise(resolve => setTimeout(resolve, 25));
    const upgradedQuoteBtn = messagesEl.querySelector('.user-reply-quote');
    assert.ok(upgradedQuoteBtn && upgradedQuoteBtn.tagName === 'BUTTON', 'signature update must upgrade quote reference to clickable button');

    // 3. loadOlder aborts cleanly if DB resets while request is in flight
    appState.historyHasMore = true;
    appState.historyBefore = 10;
    olderBtn.dispatchEvent({ type: 'click' });
    appState.messages.clear();
    appState.cursor = 2;
    appState.historyBefore = 1;
    releaseHistory(new Response(JSON.stringify({
      items: [{ ...olderMsg, id: 'm-stale-pre-reset', seq: 5 }],
      before: 1,
      hasMore: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(appState.messages.has('m-stale-pre-reset'), false, 'stale pre-reset history must not pollute post-reset state');

    // 4. Mobile touchmove allows scrolling inside newly added modal/stage containers
    const notebookBody = new MockElement('div');
    notebookBody.className = 'notebook-modal-body';
    notebookBody.scrollHeight = 600;
    notebookBody.clientHeight = 300;
    notebookBody.scrollTop = 50;
    env.rootBody.appendChild(notebookBody);

    env.documentMock.dispatchEvent({ type: 'touchstart', touches: [{ clientX: 0, clientY: 120 }] });
    const touchMoveEv: Record<string, unknown> = {
      type: 'touchmove',
      target: notebookBody,
      touches: [{ clientX: 0, clientY: 80 }],
      cancelable: true,
    };
    const allowed = env.documentMock.dispatchEvent(touchMoveEv);
    assert.equal(allowed, true, 'notebook-modal-body vertical scroll must not be blocked on <=730px viewports');
    assert.notEqual(touchMoveEv.defaultPrevented, true);

    notebookBody.scrollTop = 300;
    env.documentMock.dispatchEvent({ type: 'touchstart', touches: [{ clientX: 0, clientY: 120 }] });
    const touchMoveAtBottomEv: Record<string, unknown> = {
      type: 'touchmove',
      target: notebookBody,
      touches: [{ clientX: 0, clientY: 80 }],
      cancelable: true,
    };
    const allowedAtBottom = env.documentMock.dispatchEvent(touchMoveAtBottomEv);
    assert.equal(allowedAtBottom, true, 'upward touchmove at bottom boundary must not be prevented on iOS');
    assert.notEqual(touchMoveAtBottomEv.defaultPrevented, true);
  } finally {
    env.restore();
  }
});

test('mindmap preserves #mm-inspector scrollTop across refreshes and drops stale loadMoreFlows after DB reset', async () => {
  const env = createDomEnv();
  try {
    const makeFlow = (id: string, seq: number): MindmapTaskFlow => ({
      id,
      seq,
      sessionId: `sess-${id}`,
      sessionPersisted: true,
      createdAt: 1000 + seq * 100,
      completedAt: 1050 + seq * 100,
      status: 'completed',
      ingress: {
        messageId: `msg-${id}`,
        channelLabel: 'Web',
        sourceKind: 'local',
        text: `turn ${id}`,
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
    const makeSnap = (cursor: number, flows: MindmapTaskFlow[], hasMore = true, beforeSeq = 50): MindmapSnapshot => ({
      generatedAt: 2000,
      cursor,
      mode: 'offline',
      hasMore,
      beforeSeq,
      summary: {
        totalFlows: flows.length,
        loadedFlows: flows.length,
        totalSessions: flows.length,
        multiTurnSessions: 0,
        wechatFlows: 0,
        localFlows: flows.length,
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
      sessions: flows.map(f => ({
        id: f.sessionId!,
        title: f.ingress.text,
        kind: 'human',
        status: 'completed',
        startedAt: f.createdAt,
        updatedAt: f.completedAt!,
        channels: ['local'],
        primaryChannelLabel: 'Web',
        turnCount: 1,
        taskCount: 0,
        jevCallCount: 0,
        recalledMemoryCount: 0,
        consolidatedMemoryCount: 0,
        aiManagedContext: false,
        turnFlowIds: [f.id],
        turnSummaries: [{
          flowId: f.id,
          seq: f.seq,
          at: f.createdAt,
          sourceKind: 'local',
          channelLabel: 'Web',
          textPreview: f.ingress.text,
          status: 'completed',
          taskIds: [],
        }],
      })),
      flows,
    });

    const canvasPanel = env.getOrCreateEl('mm-canvas-panel');
    const workspace = new MockElement('main');
    workspace.appendChild(canvasPanel);
    const inspectorEl = env.getOrCreateEl('mm-inspector');
    inspectorEl.appendChild(env.getOrCreateEl('mm-inspector-body'));

    let currentSnap = makeSnap(100, [makeFlow('f-cur', 100)], true, 50);
    let releaseLoadMore!: (res: Response) => void;
    let resolveStream!: () => void;

    env.assign('fetch', (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/stream')) {
        return new Promise<Response>(resolve => {
          resolveStream = () => resolve(new Response(new ReadableStream({
            start(controller) { controller.close(); },
          }), { status: 200 }));
        });
      }
      if (url.includes('before=')) {
        return new Promise<Response>(resolve => { releaseLoadMore = resolve; });
      }
      return Promise.resolve(new Response(JSON.stringify(currentSnap), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });

    await import(`../src/web/mindmap.js?audit=${Date.now()}`);
    await new Promise(resolve => setTimeout(resolve, 25));

    // Scroll #mm-inspector down, refresh same selection, and verify scrollTop is preserved.
    inspectorEl.scrollTop = 185;
    env.getOrCreateEl('mm-refresh-btn').dispatchEvent({ type: 'click' });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(inspectorEl.scrollTop, 185, '#mm-inspector scrollTop must be preserved across refreshes');

    // Start loadMoreFlows, trigger DB reset via refresh, then resolve old loadMoreFlows: stale flow must be dropped!
    env.getOrCreateEl('mm-load-more-btn').dispatchEvent({ type: 'click' });
    currentSnap = makeSnap(2, [makeFlow('f-post-reset', 2)], false, undefined);
    env.getOrCreateEl('mm-refresh-btn').dispatchEvent({ type: 'click' });
    await new Promise(resolve => setTimeout(resolve, 25));

    releaseLoadMore(new Response(JSON.stringify(makeSnap(100, [makeFlow('f-stale-old', 10)], false, 1)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await new Promise(resolve => setTimeout(resolve, 25));

    assert.equal(env.getOrCreateEl('mm-flow-list').innerText.includes('turn f-stale-old'), false, 'stale loadMoreFlows must not resurrect pre-reset flows');
    assert.equal(env.getOrCreateEl('mm-flow-list').innerText.includes('turn f-post-reset'), true);

    env.windowMock.dispatchEvent({ type: 'pagehide' });
    resolveStream?.();
  } finally {
    env.restore();
  }
});

test('isIosStandaloneClipped accurately isolates legacy iOS standalone clipped mode', () => {
  const base = {
    standalone: true,
    narrowMobile: true,
    keyboardOpen: false,
    screenWidth: 420,
    screenHeight: 912,
    layoutWidth: 420,
    layoutHeight: 844,
    safeTop: 68,
    safeBottom: 34,
  };

  assert.equal(isIosStandaloneClipped(base), true);
  assert.equal(isIosStandaloneClipped({ ...base, layoutHeight: 912 }), false);
  assert.equal(isIosStandaloneClipped({ ...base, safeTop: 0, safeBottom: 0 }), false);
  assert.equal(isIosStandaloneClipped({ ...base, keyboardOpen: true }), false);
  assert.equal(isIosStandaloneClipped({ ...base, standalone: false }), false);
  assert.equal(isIosStandaloneClipped({ ...base, screenWidth: 820, screenHeight: 1180, layoutWidth: 500, layoutHeight: 1112 }), false);
});

test('initMobileViewport creates safe-area probe, syncs clipped & keyboard classes, resets blur scroll, and disposes cleanly', async () => {
  const env = createDomEnv();
  try {
    let scrollCalls = 0;
    let vvHeight = 844;
    const vvListeners = new Map<string, ListenerEntry[]>();
    const vvMock = {
      get height() { return vvHeight; },
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        const list = vvListeners.get(type) ?? [];
        list.push({ fn });
        vvListeners.set(type, list);
      },
      removeEventListener: (type: string, fn: (ev: unknown) => void) => {
        const list = vvListeners.get(type);
        if (list) vvListeners.set(type, list.filter(item => item.fn !== fn));
      },
      dispatchEvent: (event: Record<string, unknown>) => {
        for (const entry of [...(vvListeners.get(String(event.type)) ?? [])]) {
          entry.fn(event);
        }
        return true;
      },
    };

    Object.assign(env.windowMock, {
      innerWidth: 420,
      innerHeight: 844,
      screen: { width: 420, height: 912 },
      visualViewport: vvMock,
      matchMedia: (query: string) => ({
        matches: query.includes('max-width: 730px') || query.includes('display-mode: standalone'),
      }),
      getComputedStyle: (el: MockElement) => (
        el.id === 'safe-area-probe'
          ? { paddingTop: '68px', paddingBottom: '34px' }
          : { paddingTop: '0px', paddingBottom: '0px' }
      ),
      scrollTo: () => {
        scrollCalls += 1;
        env.windowMock.scrollX = 0;
        env.windowMock.scrollY = 0;
      },
    });
    env.assign('navigator', { standalone: true });

    const ctrl = initMobileViewport();
    const probe = env.rootBody.querySelector('#safe-area-probe');
    assert.ok(probe, 'safe-area probe must be appended to document.body');
    assert.equal(probe.classList.contains('safe-area-probe'), true);
    assert.equal(probe.getAttribute('aria-hidden'), 'true');

    const root = env.documentMock.documentElement;
    assert.equal(root.classList.contains('pwa-standalone'), true);
    assert.equal(root.classList.contains('ios-standalone-clipped'), true);
    assert.equal(root.classList.contains('mobile-keyboard-open'), false);

    const inputEl = new MockElement('input');
    inputEl.type = 'text';
    (env.documentMock as { activeElement: MockElement | null }).activeElement = inputEl;
    vvHeight = 520;
    env.documentMock.dispatchEvent({ type: 'focusin' });
    assert.equal(root.classList.contains('mobile-keyboard-open'), true);
    assert.equal(root.classList.contains('ios-standalone-clipped'), false);

    (env.documentMock as { activeElement: MockElement | null }).activeElement = null;
    vvHeight = 844;
    env.windowMock.scrollY = 44;
    env.documentMock.dispatchEvent({ type: 'focusout' });
    await new Promise(resolve => setTimeout(resolve, 90));

    assert.equal(scrollCalls, 1, 'focusout on narrow mobile must reset window scroll');
    assert.equal(root.classList.contains('mobile-keyboard-open'), false);
    assert.equal(root.classList.contains('ios-standalone-clipped'), true);

    ctrl.dispose();
    vvHeight = 500;
    (env.documentMock as { activeElement: MockElement | null }).activeElement = inputEl;
    vvMock.dispatchEvent({ type: 'resize' });
    assert.equal(root.classList.contains('mobile-keyboard-open'), false, 'disposed controller must ignore subsequent events');
  } finally {
    env.restore();
  }
});

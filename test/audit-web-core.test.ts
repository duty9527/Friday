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
import { createSharedSseHub, type BroadcastChannelLike, type SseUpdateBatch } from '../src/web/shared/sse-hub.js';
import { buildExecutionChain } from '../src/web/trace-chain.js';

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
  returnValue = '';
  closedBy = '';
  inert = false;
  popover: string | null = null;
  isPopoverOpen = false;
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
    const lower = name.toLowerCase();
    const str = String(val);
    this.attributes.set(lower, str);
    if (lower === 'id') this.id = str;
    if (lower === 'class') this.className = str;
    if (lower === 'hidden') this.hidden = true;
    if (lower === 'disabled') this.disabled = true;
    if (lower === 'open') this.open = true;
    if (lower === 'inert') this.inert = true;
    if (lower === 'closedby') this.closedBy = str;
    if (lower === 'popover') this.popover = str;
  }

  getAttribute(name: string): string | null {
    const lower = name.toLowerCase();
    if (lower === 'id') return this.id || null;
    if (lower === 'hidden') return this.hidden ? '' : null;
    if (lower === 'disabled') return this.disabled ? '' : null;
    if (lower === 'open') return this.open ? '' : null;
    if (lower === 'inert') return this.inert ? '' : null;
    return this.attributes.get(lower) ?? null;
  }

  removeAttribute(name: string): void {
    const lower = name.toLowerCase();
    this.attributes.delete(lower);
    if (lower === 'hidden') this.hidden = false;
    if (lower === 'disabled') this.disabled = false;
    if (lower === 'open') this.open = false;
    if (lower === 'inert') this.inert = false;
    if (lower === 'popover') this.popover = null;
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
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
    if (event.target == null) {
      try {
        event.target = this;
      } catch {
        // Native Event objects expose a getter-only target property.
      }
    }
    let prevented = false;
    if (typeof event.preventDefault !== 'function') {
      event.preventDefault = () => {
        if (event.cancelable !== false) {
          prevented = true;
          event.defaultPrevented = true;
        }
      };
    }
    if (typeof event.stopPropagation !== 'function') {
      event.stopPropagation = () => {};
    }
    let cur: MockElement | null = this;
    while (cur) {
      for (const entry of [...(cur.listeners.get(String(event.type)) ?? [])]) {
        entry.fn(event);
      }
      cur = cur.parentElement;
    }
    return !prevented && event.defaultPrevented !== true;
  }

  matches(selector: string): boolean {
    const parts = selector.split(',').map(s => s.trim()).filter(Boolean);
    return parts.some(part => {
      const needsPopoverOpen = part.includes(':popover-open');
      if (needsPopoverOpen && !this.isPopoverOpen) return false;
      const cleanPart = part.replace(/:popover-open/g, '');
      if (!cleanPart) return needsPopoverOpen;
      const tokens = cleanPart.match(/(?:#[^\s.#[\]]+|\.[^\s.#[\]]+|\[[^\]]+\]|^[a-zA-Z0-9_-]+)/g);
      if (!tokens || tokens.join('') !== cleanPart) return false;
      return tokens.every(tok => {
        if (tok.startsWith('#')) return this.id === tok.slice(1);
        if (tok.startsWith('.')) return this.classes.has(tok.slice(1));
        if (tok.startsWith('[')) {
          const expr = tok.slice(1, -1);
          const eqIdx = expr.indexOf('=');
          if (eqIdx === -1) return this.hasAttribute(expr.trim());
          const attrName = expr.slice(0, eqIdx).trim();
          const rawVal = expr.slice(eqIdx + 1).trim();
          const expectedVal = rawVal.replace(/^(['"])(.*)\1$/, '$2');
          return this.getAttribute(attrName) === expectedVal;
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
  getContext(): null { return null; }
  showModal(): void {
    this.hidden = false;
    this.open = true;
    this.setAttribute('open', '');
  }
  close(returnValue?: string): void {
    if (returnValue !== undefined) this.returnValue = returnValue;
    const wasOpen = this.open;
    this.open = false;
    this.removeAttribute('open');
    if (wasOpen) {
      this.dispatchEvent({ type: 'close', bubbles: false, cancelable: false });
    }
  }
  showPopover(): void {
    this.hidden = false;
    this.isPopoverOpen = true;
    this.dispatchEvent({ type: 'toggle', newState: 'open', oldState: 'closed', bubbles: false });
  }
  hidePopover(): void {
    const wasOpen = this.isPopoverOpen;
    this.isPopoverOpen = false;
    if (wasOpen) {
      this.dispatchEvent({ type: 'toggle', newState: 'closed', oldState: 'open', bubbles: false });
    }
  }
  togglePopover(force?: boolean): boolean {
    const next = force !== undefined ? force : !this.isPopoverOpen;
    if (next) this.showPopover();
    else this.hidePopover();
    return next;
  }
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
    'fetch', 'Node', 'Element', 'HTMLElement', 'ResizeObserver', 'navigator', 'performance', 'requestAnimationFrame',
    'cancelAnimationFrame',
  ];
  for (const key of keys) {
    saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  }

  const rootHead = new MockElement('head');
  const rootBody = new MockElement('body');
  const docEl = new MockElement('html');
  docEl.append(rootHead, rootBody);
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
    head: rootHead,
    body: rootBody,
    documentElement: docEl,
    activeElement: null,
    getElementById: (id: string) => getOrCreateEl(id),
    createElement: (tag: string) => new MockElement(tag),
    createElementNS: (_ns: string, tag: string) => new MockElement(tag),
    createTextNode: (text: string) => new MockElement('#text', 3, text),
    createDocumentFragment: () => new MockElement('#fragment', 11),
    querySelector: (selector: string) => docEl.querySelector(selector),
    querySelectorAll: (selector: string) => docEl.querySelectorAll(selector),
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

  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  assign('window', windowMock);
  assign('document', documentMock);
  assign('location', { hash: initialHash, pathname: '/', search: '' });
  assign('history', { replaceState: () => {} });
  assign('sessionStorage', storageMock);
  assign('localStorage', storageMock);
  assign('Node', MockElement);
  assign('Element', MockElement);
  assign('HTMLElement', MockElement);
  assign('ResizeObserver', MockResizeObserver);

  const restore = () => {
    for (const key of keys) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]!);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };

  return {
    rootHead,
    rootBody,
    getOrCreateEl,
    documentMock,
    windowMock,
    getDocListenerCount: (type: string) => docListeners.get(type)?.length ?? 0,
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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DiaryEntry, MainView, MemoryCard, ModelHubView, NoteItem, PluginView, TimerView, UsageReportView, WechatQrLoginSession } from '../src/view.js';

type WebModules = {
  initImVoiceHub: typeof import('../src/web/hubs/im-voice-hub.js').initImVoiceHub;
  initMemoryHub: typeof import('../src/web/hubs/memory-hub.js').initMemoryHub;
  initModelHub: typeof import('../src/web/hubs/model-hub.js').initModelHub;
  initNotebookHub: typeof import('../src/web/hubs/notebook-hub.js').initNotebookHub;
  initServicesHub: typeof import('../src/web/hubs/services-hub.js').initServicesHub;
  initTimerPluginHub: typeof import('../src/web/hubs/timer-plugin-hub.js').initTimerPluginHub;
  initUsageHub: typeof import('../src/web/hubs/usage-hub.js').initUsageHub;
  initAppleDevicesUi: typeof import('../src/web/plugins/apple-devices-ui.js').initAppleDevicesUi;
  initCs80FaceUi: typeof import('../src/web/plugins/cs80-face-ui.js').initCs80FaceUi;
  initFundTrackerUi: typeof import('../src/web/plugins/fund-tracker-ui.js').initFundTrackerUi;
  initHealthScaleUi: typeof import('../src/web/plugins/health-scale-ui.js').initHealthScaleUi;
  initLaifenUi: typeof import('../src/web/plugins/laifen-ui.js').initLaifenUi;
  initMiotUi: typeof import('../src/web/plugins/miot-ui.js').initMiotUi;
  initNetleaUi: typeof import('../src/web/plugins/netlea-ui.js').initNetleaUi;
  initNinebotUi: typeof import('../src/web/plugins/ninebot-ui.js').initNinebotUi;
  appState: typeof import('../src/web/state.js').appState;
  hooks: typeof import('../src/web/state.js').hooks;
};

let cachedModulesPromise: Promise<WebModules> | undefined;

async function getWebModules(): Promise<WebModules> {
  if (!cachedModulesPromise) {
    cachedModulesPromise = (async () => {
      const [
        imVoice,
        memory,
        model,
        notebook,
        services,
        timerPlugin,
        usage,
        apple,
        cs80,
        fund,
        health,
        laifen,
        miot,
        netlea,
        ninebot,
        state,
      ] = await Promise.all([
        import('../src/web/hubs/im-voice-hub.js'),
        import('../src/web/hubs/memory-hub.js'),
        import('../src/web/hubs/model-hub.js'),
        import('../src/web/hubs/notebook-hub.js'),
        import('../src/web/hubs/services-hub.js'),
        import('../src/web/hubs/timer-plugin-hub.js'),
        import('../src/web/hubs/usage-hub.js'),
        import('../src/web/plugins/apple-devices-ui.js'),
        import('../src/web/plugins/cs80-face-ui.js'),
        import('../src/web/plugins/fund-tracker-ui.js'),
        import('../src/web/plugins/health-scale-ui.js'),
        import('../src/web/plugins/laifen-ui.js'),
        import('../src/web/plugins/miot-ui.js'),
        import('../src/web/plugins/netlea-ui.js'),
        import('../src/web/plugins/ninebot-ui.js'),
        import('../src/web/state.js'),
      ]);
      return {
        initImVoiceHub: imVoice.initImVoiceHub,
        initMemoryHub: memory.initMemoryHub,
        initModelHub: model.initModelHub,
        initNotebookHub: notebook.initNotebookHub,
        initServicesHub: services.initServicesHub,
        initTimerPluginHub: timerPlugin.initTimerPluginHub,
        initUsageHub: usage.initUsageHub,
        initAppleDevicesUi: apple.initAppleDevicesUi,
        initCs80FaceUi: cs80.initCs80FaceUi,
        initFundTrackerUi: fund.initFundTrackerUi,
        initHealthScaleUi: health.initHealthScaleUi,
        initLaifenUi: laifen.initLaifenUi,
        initMiotUi: miot.initMiotUi,
        initNetleaUi: netlea.initNetleaUi,
        initNinebotUi: ninebot.initNinebotUi,
        appState: state.appState,
        hooks: state.hooks,
      };
    })();
  }
  return cachedModulesPromise;
}

const INDEX_HTML = readFileSync(fileURLToPath(new URL('../src/web/index.html', import.meta.url)), 'utf8');

function toCamelCase(kebab: string): string {
  return kebab.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function toKebabCase(camel: string): string {
  return camel.replace(/[A-Z]/g, ch => `-${ch.toLowerCase()}`);
}

class FakeEvent {
  type: string;
  target: unknown = null;
  currentTarget: unknown = null;
  defaultPrevented = false;
  propagationStopped = false;
  key = '';
  metaKey = false;
  ctrlKey = false;
  altKey = false;
  isComposing = false;
  pointerType = 'mouse';
  pointerId = 1;
  clientX = 0;
  clientY = 0;

  constructor(type: string, init: Record<string, unknown> = {}) {
    this.type = type;
    Object.assign(this, init);
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }
}

class FakeClassList {
  private readonly owner: FakeElement;

  constructor(owner: FakeElement) {
    this.owner = owner;
  }

  private tokens(): string[] {
    return this.owner.className.split(/\s+/).filter(Boolean);
  }

  contains(name: string): boolean {
    return this.tokens().includes(name);
  }

  add(...names: string[]): void {
    const set = new Set(this.tokens());
    for (const n of names) {
      if (n) set.add(n);
    }
    this.owner.className = [...set].join(' ');
  }

  remove(...names: string[]): void {
    const drop = new Set(names);
    this.owner.className = this.tokens().filter(t => !drop.has(t)).join(' ');
  }

  toggle(name: string, force?: boolean): boolean {
    const has = this.contains(name);
    const next = force !== undefined ? force : !has;
    if (next) this.add(name);
    else this.remove(name);
    return next;
  }
}

function makeCanvas2dContext() {
  return {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    shadowColor: '',
    shadowBlur: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    save() {},
    restore() {},
    scale() {},
    translate() {},
    rotate() {},
    setTransform() {},
    clearRect() {},
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    quadraticCurveTo() {},
    bezierCurveTo() {},
    rect() {},
    roundRect() {},
    fillRect() {},
    strokeRect() {},
    fill() {},
    stroke() {},
    fillText() {},
    strokeText() {},
    drawImage() {},
    arcTo() {},
    ellipse() {},
    clip() {},
    setLineDash() {},
    createImageData(w = 1, h = 1) {
      return { width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) };
    },
    putImageData() {},
    measureText(text: string) {
      return { width: text.length * 7 };
    },
    createLinearGradient() {
      return { addColorStop() {} };
    },
    createRadialGradient() {
      return { addColorStop() {} };
    },
  };
}

class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  private _textContent = '';

  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }

  get textContent(): string {
    if (this.childNodes.length === 0) return this._textContent;
    return this.childNodes.map(c => c.textContent).join('');
  }

  set textContent(val: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this._textContent = val ?? '';
  }

  protected insertChild(node: FakeNode, ref: FakeNode | null): void {
    if (node instanceof FakeFragment) {
      const items = [...node.childNodes];
      for (const item of items) {
        this.insertChild(item, ref);
      }
      return;
    }
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
    node.parentNode = this;
    if (ref) {
      const idx = this.childNodes.indexOf(ref);
      if (idx >= 0) {
        this.childNodes.splice(idx, 0, node);
        return;
      }
    }
    this.childNodes.push(node);
  }

  appendChild<T extends FakeNode>(node: T): T {
    this.insertChild(node, null);
    return node;
  }

  removeChild(node: FakeNode): void {
    const idx = this.childNodes.indexOf(node);
    if (idx >= 0) {
      this.childNodes.splice(idx, 1);
      node.parentNode = null;
    }
  }

  append(...nodes: Array<FakeNode | string>): void {
    for (const item of nodes) {
      this.insertChild(typeof item === 'string' ? new FakeText(item) : item, null);
    }
  }

  prepend(...nodes: Array<FakeNode | string>): void {
    const first = this.childNodes[0] ?? null;
    for (const item of nodes) {
      this.insertChild(typeof item === 'string' ? new FakeText(item) : item, first);
    }
  }

  insertBefore(newNode: FakeNode, refNode: FakeNode | null): FakeNode {
    this.insertChild(newNode, refNode);
    return newNode;
  }

  replaceChildren(...nodes: Array<FakeNode | string>): void {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this._textContent = '';
    this.append(...nodes);
  }

  contains(target: FakeNode | null): boolean {
    let cur: FakeNode | null = target;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
}

class FakeText extends FakeNode {
  constructor(text: string) {
    super();
    this.textContent = text;
  }
}

class FakeFragment extends FakeNode {}

function matchesSimpleSelector(el: FakeElement, selector: string): boolean {
  const parts = selector.trim().split(/\s+/);
  const tail = parts[parts.length - 1]!;
  if (!matchesSingleCompound(el, tail)) return false;
  if (parts.length === 1) return true;
  let ancestor = el.parentElement;
  for (let i = parts.length - 2; i >= 0; i--) {
    const part = parts[i]!;
    while (ancestor && !matchesSingleCompound(ancestor, part)) {
      ancestor = ancestor.parentElement;
    }
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

function matchesSingleCompound(el: FakeElement, compound: string): boolean {
  const attrMatches = [...compound.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
  const stripped = compound.replace(/\[[^\]]+\]/g, '');
  const dotParts = stripped.split('.');
  const tagPart = dotParts[0]?.trim();
  const classParts = dotParts.slice(1).filter(Boolean);

  if (tagPart && tagPart !== '*' && el.tagName.toLowerCase() !== tagPart.toLowerCase()) {
    return false;
  }
  for (const cls of classParts) {
    if (!el.classList.contains(cls)) return false;
  }
  for (const m of attrMatches) {
    const attrName = m[1]!;
    const attrVal = m[2];
    const actual = el.getAttribute(attrName);
    if (actual === null) return false;
    if (attrVal !== undefined && actual !== attrVal) return false;
  }
  return true;
}

class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly doc: FakeDocument;
  readonly classList: FakeClassList;
  readonly dataset: Record<string, string>;
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(ev: FakeEvent) => void>>();
  private _className = '';
  private _value = '';
  private _selected = false;
  private _rect = { left: 0, top: 0, width: 0, height: 0 };
  private _scrollCount = 0;

  hidden = false;
  disabled = false;
  open = false;
  checked = false;
  type = '';
  src = '';
  href = '';
  title = '';
  placeholder = '';
  tabIndex = 0;
  width = 0;
  height = 0;
  clientWidth = 0;
  clientHeight = 0;
  selectionStart = 0;
  selectionEnd = 0;
  max = '';

  constructor(tagName: string, doc: FakeDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.doc = doc;
    this.classList = new FakeClassList(this);
    const attrs = this.attrs;
    this.dataset = new Proxy<Record<string, string>>({}, {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined;
        return attrs.get(`data-${toKebabCase(prop)}`);
      },
      set(_t, prop, val) {
        if (typeof prop !== 'string') return true;
        attrs.set(`data-${toKebabCase(prop)}`, String(val));
        return true;
      },
      deleteProperty(_t, prop) {
        if (typeof prop !== 'string') return true;
        attrs.delete(`data-${toKebabCase(prop)}`);
        return true;
      },
    });
  }

  get id(): string {
    return this.attrs.get('id') ?? '';
  }

  set id(val: string) {
    const prev = this.attrs.get('id');
    if (prev) this.doc.unregisterId(prev, this);
    if (val) {
      this.attrs.set('id', val);
      this.doc.registerId(val, this);
    } else {
      this.attrs.delete('id');
    }
  }

  get className(): string {
    return this._className;
  }

  set className(val: string) {
    this._className = val;
    this.attrs.set('class', val);
  }

  get value(): string {
    if (this.tagName === 'SELECT' && !this._value) {
      const opts = this.options;
      const sel = opts.find(o => o.selected) ?? opts[0];
      return sel ? sel.value : '';
    }
    return this._value;
  }

  set value(val: string) {
    this._value = String(val ?? '');
    if (this.tagName === 'SELECT') {
      for (const opt of this.options) {
        opt._selected = opt.value === this._value;
      }
    }
  }

  get selected(): boolean {
    return this._selected;
  }

  set selected(val: boolean) {
    this._selected = Boolean(val);
    if (val && this.parentElement?.tagName === 'SELECT') {
      this.parentElement._value = this.value;
    }
  }

  get options(): FakeElement[] {
    return this.querySelectorAll('option');
  }

  override replaceChildren(...nodes: Array<FakeNode | string>): void {
    super.replaceChildren(...nodes);
    if (this.tagName === 'SELECT') {
      const opts = this.options;
      const sel = opts.find(o => o.selected) ?? opts[0];
      this._value = sel ? sel.value : '';
    }
  }

  setAttribute(name: string, val: string): void {
    const lower = name.toLowerCase();
    const str = String(val);
    this.attrs.set(lower, str);
    if (lower === 'id') {
      this.id = str;
    } else if (lower === 'class') {
      this._className = str;
    } else if (lower === 'hidden') {
      this.hidden = true;
    } else if (lower === 'disabled') {
      this.disabled = true;
    } else if (lower === 'open') {
      this.open = true;
    } else if (lower === 'checked') {
      this.checked = true;
    } else if (lower === 'type') {
      this.type = str;
    } else if (lower === 'value') {
      this._value = str;
    } else if (lower === 'src') {
      this.src = str;
    } else if (lower === 'href') {
      this.href = str;
    } else if (lower === 'width') {
      this.width = Number(str) || 0;
    } else if (lower === 'height') {
      this.height = Number(str) || 0;
    } else if (lower.startsWith('data-')) {
      this.dataset[toCamelCase(lower.slice(5))] = str;
    }
  }

  getAttribute(name: string): string | null {
    const lower = name.toLowerCase();
    if (lower === 'hidden') return this.hidden ? '' : null;
    if (lower === 'disabled') return this.disabled ? '' : null;
    if (lower === 'class') return this._className || null;
    if (lower === 'src') return this.src || null;
    if (lower === 'href') return this.href || null;
    return this.attrs.get(lower) ?? null;
  }

  removeAttribute(name: string): void {
    const lower = name.toLowerCase();
    this.attrs.delete(lower);
    if (lower === 'hidden') this.hidden = false;
    else if (lower === 'disabled') this.disabled = false;
    else if (lower === 'src') this.src = '';
    else if (lower === 'href') this.href = '';
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  replaceWith(...nodes: Array<FakeNode | string>): void {
    const parent = this.parentNode;
    if (!parent) return;
    for (const item of nodes) {
      const node = typeof item === 'string' ? new FakeText(item) : item;
      parent.insertBefore(node, this);
    }
    parent.removeChild(this);
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const groups = selector.split(',').map(s => s.trim()).filter(Boolean);
    const out: FakeElement[] = [];
    const walk = (root: FakeNode) => {
      for (const child of root.children) {
        if (groups.some(g => matchesSimpleSelector(child, g))) {
          out.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  closest(selector: string): FakeElement | null {
    const groups = selector.split(',').map(s => s.trim()).filter(Boolean);
    let cur: FakeElement | null = this;
    while (cur) {
      if (groups.some(g => matchesSimpleSelector(cur!, g))) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  addEventListener(type: string, fn: (ev: FakeEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: (ev: FakeEvent) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(ev: FakeEvent): boolean {
    if (!ev.target) ev.target = this;
    let cur: FakeElement | null = this;
    while (cur) {
      ev.currentTarget = cur;
      const set = cur.listeners.get(ev.type);
      if (set) {
        for (const fn of [...set]) {
          fn(ev);
        }
      }
      if (ev.propagationStopped) break;
      cur = cur.parentElement;
    }
    return !ev.defaultPrevented;
  }

  click(): void {
    if (this.disabled) return;
    this.dispatchEvent(new FakeEvent('click'));
  }

  focus(): void {
    this.doc.activeElement = this;
  }

  blur(): void {
    if (this.doc.activeElement === this) {
      this.doc.activeElement = null;
    }
  }

  setPointerCapture(): void {}

  scrollIntoView(): void {
    this._scrollCount++;
  }

  setBoundingRect(rect: { left?: number; top?: number; width?: number; height?: number }): void {
    this._rect = {
      left: rect.left ?? 0,
      top: rect.top ?? 0,
      width: rect.width ?? 0,
      height: rect.height ?? 0,
    };
  }

  getBoundingClientRect() {
    return {
      left: this._rect.left,
      top: this._rect.top,
      width: this._rect.width,
      height: this._rect.height,
      right: this._rect.left + this._rect.width,
      bottom: this._rect.top + this._rect.height,
    };
  }

  getContext(kind: string) {
    return kind === '2d' ? makeCanvas2dContext() : null;
  }
}

class FakeDocument {
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  private readonly byId = new Map<string, FakeElement>();
  private readonly listeners = new Map<string, Set<(ev: FakeEvent) => void>>();
  activeElement: FakeElement | null = null;
  fullscreenElement: FakeElement | null = null;
  hidden = false;
  cookie = '';
  elementFromPointImpl: ((x: number, y: number) => FakeElement | null) | undefined;

  constructor() {
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
    this.documentElement.append(this.body);
  }

  registerId(id: string, el: FakeElement): void {
    this.byId.set(id, el);
  }

  unregisterId(id: string, el: FakeElement): void {
    if (this.byId.get(id) === el) {
      this.byId.delete(id);
    }
  }

  getElementById(id: string): FakeElement | null {
    return this.byId.get(id) ?? null;
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  createElementNS(_ns: string, tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  createDocumentFragment(): FakeFragment {
    return new FakeFragment();
  }

  createTextNode(text: string): FakeText {
    return new FakeText(text);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.documentElement.querySelectorAll(selector);
  }

  querySelector(selector: string): FakeElement | null {
    return this.documentElement.querySelector(selector);
  }

  addEventListener(type: string, fn: (ev: FakeEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: (ev: FakeEvent) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  dispatchEvent(ev: FakeEvent): void {
    const set = this.listeners.get(ev.type);
    if (set) {
      for (const fn of [...set]) fn(ev);
    }
  }

  exitFullscreen(): Promise<void> {
    this.fullscreenElement = null;
    return Promise.resolve();
  }

  elementFromPoint(x: number, y: number): FakeElement | null {
    return this.elementFromPointImpl ? this.elementFromPointImpl(x, y) : null;
  }
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function populateDocumentFromHtml(doc: FakeDocument, html: string): void {
  const stack: FakeElement[] = [doc.body];
  const tagRe = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z0-9-]+)([^>]*)>/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = tagRe.exec(html)) !== null) {
    if (match.index > lastIndex) {
      const txt = html.slice(lastIndex, match.index).trim();
      const top = stack[stack.length - 1]!;
      if (txt && top.tagName === 'OPTION') {
        top.textContent = txt;
      }
    }
    lastIndex = tagRe.lastIndex;
    if (match[0].startsWith('<!--')) continue;

    const isClose = match[1] === '/';
    const tag = match[2]!.toLowerCase();
    const rawAttrs = match[3] ?? '';
    if (tag === '!doctype' || tag === 'html' || tag === 'head' || tag === 'body' || tag === 'script' || tag === 'style' || tag === 'title') {
      continue;
    }

    if (isClose) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tagName.toLowerCase() === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const el = doc.createElement(tag);
    const attrRe = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(rawAttrs)) !== null) {
      const name = am[1]!;
      if (name === '/') continue;
      const val = am[2] ?? am[3] ?? am[4] ?? '';
      el.setAttribute(name, val);
    }
    stack[stack.length - 1]!.append(el);
    const selfClosing = rawAttrs.trimEnd().endsWith('/') || VOID_TAGS.has(tag);
    if (!selfClosing) {
      stack.push(el);
    }
  }
}

interface HarnessContext {
  mods: WebModules;
  doc: FakeDocument;
  winListeners: Map<string, Set<(ev: FakeEvent) => void>>;
  dispatchWindowEvent: (type: string, init?: Record<string, unknown>) => void;
  setFetchHandler: (fn: (url: string, init?: RequestInit) => Promise<Response>) => void;
  setClipboardImpl: (fn: (text: string) => Promise<void>) => void;
  setPromptImpl: (fn: (msg?: string, def?: string) => string | null) => void;
  connectionMessages: Array<{ text: string; isError: boolean }>;
  getRefreshCount: () => number;
}

function deferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

const TEST_VALID_TOKEN = 'a'.repeat(64);

async function withWebHarness(run: (ctx: HarnessContext) => Promise<void>): Promise<void> {
  const g = globalThis as Record<string, unknown>;
  const origDocument = g.document;
  const origWindow = g.window;
  const origHTMLElement = g.HTMLElement;
  const origElement = g.Element;
  const origLocation = g.location;
  const origHistory = g.history;
  const origNavigator = g.navigator;
  const origFetch = g.fetch;
  const origEvent = g.Event;
  const origLocalStorage = g.localStorage;
  const origSessionStorage = g.sessionStorage;
  const origMatchMedia = g.matchMedia;
  const origMutationObserver = g.MutationObserver;
  const origBroadcastChannel = g.BroadcastChannel;
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;

  const trackedIntervals = new Set<ReturnType<typeof setInterval>>();
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const id = origSetInterval(...args);
    trackedIntervals.add(id);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
    if (id !== undefined) trackedIntervals.delete(id);
    origClearInterval(id);
  }) as typeof clearInterval;

  const doc = new FakeDocument();
  populateDocumentFromHtml(doc, INDEX_HTML);

  const winListeners = new Map<string, Set<(ev: FakeEvent) => void>>();
  const localStorageMap = new Map<string, string>();
  const sessionStorageMap = new Map<string, string>();
  const connectionMessages: Array<{ text: string; isError: boolean }> = [];
  let refreshCount = 0;

  let fetchHandler: (url: string, init?: RequestInit) => Promise<Response> = async () => jsonResponse({ ok: true });
  let clipboardImpl: (text: string) => Promise<void> = async () => {};
  let promptImpl: (msg?: string, def?: string) => string | null = () => null;

  class MockMutationObserver {
    observe() {}
    disconnect() {}
  }

  const fakeLocation = {
    origin: 'http://127.0.0.1:4312',
    href: `http://127.0.0.1:4312/#token=${TEST_VALID_TOKEN}`,
    hash: `#token=${TEST_VALID_TOKEN}`,
    pathname: '/',
    search: '',
  };
  const fakeHistory = {
    replaceState() {},
  };
  const fakeLocalStorage = {
    getItem: (k: string) => localStorageMap.get(k) ?? null,
    setItem: (k: string, v: string) => { localStorageMap.set(k, v); },
    removeItem: (k: string) => { localStorageMap.delete(k); },
  };
  const fakeSessionStorage = {
    getItem: (k: string) => sessionStorageMap.get(k) ?? null,
    setItem: (k: string, v: string) => { sessionStorageMap.set(k, v); },
    removeItem: (k: string) => { sessionStorageMap.delete(k); },
  };

  const fakeWindow = {
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 2,
    location: fakeLocation,
    history: fakeHistory,
    localStorage: fakeLocalStorage,
    sessionStorage: fakeSessionStorage,
    addEventListener(type: string, fn: (ev: FakeEvent) => void) {
      let set = winListeners.get(type);
      if (!set) {
        set = new Set();
        winListeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type: string, fn: (ev: FakeEvent) => void) {
      winListeners.get(type)?.delete(fn);
    },
    dispatchEvent(ev: FakeEvent) {
      const set = winListeners.get(ev.type);
      if (set) {
        for (const fn of [...set]) fn(ev);
      }
      return true;
    },
    requestAnimationFrame(cb: () => void) {
      return setTimeout(cb, 0) as unknown as number;
    },
    cancelAnimationFrame(id: number) {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    },
    prompt(msg?: string, def?: string) {
      return promptImpl(msg, def);
    },
  };

  g.document = doc;
  g.window = fakeWindow;
  g.HTMLElement = FakeElement;
  g.Element = FakeElement;
  g.location = fakeLocation;
  g.history = fakeHistory;
  g.localStorage = fakeLocalStorage;
  g.sessionStorage = fakeSessionStorage;
  g.Event = FakeEvent;
  g.MutationObserver = MockMutationObserver;
  g.BroadcastChannel = undefined;
  g.matchMedia = () => ({
    matches: false,
    media: '',
    addEventListener() {},
    removeEventListener() {},
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        writeText: (text: string) => clipboardImpl(text),
      },
    },
  });
  g.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return fetchHandler(url, init);
  };

  const mods = await getWebModules();
  const savedAppState = {
    token: mods.appState.token,
    ready: mods.appState.ready,
    authExpired: mods.appState.authExpired,
    view: mods.appState.view,
    voiceprintState: mods.appState.voiceprintState,
  };
  const savedHooks = { ...mods.hooks };

  mods.appState.token = TEST_VALID_TOKEN;
  mods.appState.ready = true;
  mods.appState.authExpired = false;
  mods.appState.voiceprintState = undefined;
  mods.appState.view = undefined;

  mods.hooks.refreshView = async () => {
    refreshCount++;
  };
  mods.hooks.connection = (text: string, isError = false) => {
    connectionMessages.push({ text, isError });
  };
  mods.hooks.closeAllHubModals = () => {};
  mods.hooks.closeSidebar = () => {};
  mods.hooks.jumpMessage = async () => {};
  mods.hooks.selectTrace = () => {};
  mods.hooks.showPanel = () => {};
  mods.hooks.openSystemHubModal = () => {};

  const dispatchWindowEvent = (type: string, init: Record<string, unknown> = {}) => {
    fakeWindow.dispatchEvent(new FakeEvent(type, init));
  };

  try {
    await run({
      mods,
      doc,
      winListeners,
      dispatchWindowEvent,
      setFetchHandler: fn => { fetchHandler = fn; },
      setClipboardImpl: fn => { clipboardImpl = fn; },
      setPromptImpl: fn => { promptImpl = fn; },
      connectionMessages,
      getRefreshCount: () => refreshCount,
    });
  } finally {
    // Trigger pagehide so hubs clean up BroadcastChannel / timers cleanly before teardown.
    dispatchWindowEvent('pagehide');
    for (const id of trackedIntervals) {
      origClearInterval(id);
    }
    trackedIntervals.clear();
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
    g.document = origDocument;
    g.window = origWindow;
    g.HTMLElement = origHTMLElement;
    g.Element = origElement;
    g.location = origLocation;
    g.history = origHistory;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: origNavigator,
    });
    g.fetch = origFetch;
    g.Event = origEvent;
    g.localStorage = origLocalStorage;
    g.sessionStorage = origSessionStorage;
    g.matchMedia = origMatchMedia;
    g.MutationObserver = origMutationObserver;
    g.BroadcastChannel = origBroadcastChannel;
    Object.assign(mods.appState, savedAppState);
    Object.assign(mods.hooks, savedHooks);
  }
}

test('services-hub ignores stale refreshStatus after config save and disables controls on authExpired', async () => {
  await withWebHarness(async ctx => {
    const {
      initImVoiceHub,
      initMemoryHub,
      initModelHub,
      initNotebookHub,
      initServicesHub,
      initTimerPluginHub,
      initUsageHub,
      initAppleDevicesUi,
      initCs80FaceUi,
      initFundTrackerUi,
      initHealthScaleUi,
      initLaifenUi,
      initNetleaUi,
      initNinebotUi,
    } = ctx.mods;
    const statusDeferred = deferred<Response>();
    let statusCalls = 0;

    ctx.setFetchHandler(async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.endsWith('/api/geo-config')) {
        if (!init?.body) {
          statusCalls++;
          if (statusCalls === 1) return statusDeferred.promise;
          return jsonResponse({ configured: true, source: 'system', maskedKey: 'new***key', cacheEntries: 0 });
        }
        return jsonResponse({ configured: true, source: 'system', maskedKey: 'new***key', cacheEntries: 0 });
      }
      if (url.endsWith('/api/geo-probe')) {
        void body;
        throw new Error('配额超限');
      }
      return jsonResponse({ ok: true });
    });

    const ctrl = initServicesHub({ isVisible: () => true });
    ctrl.activate();
    await flushMicrotasks();

    const keyInput = ctx.doc.getElementById('geo-amap-key-input')!;
    const saveBtn = ctx.doc.getElementById('geo-save-btn')!;
    const testBtn = ctx.doc.getElementById('geo-probe-btn')!;
    const clearBtn = ctx.doc.getElementById('geo-clear-btn')!;
    const badge = ctx.doc.getElementById('geo-status-badge')!;
    const statusBox = ctx.doc.getElementById('geo-probe-result')!;

    keyInput.value = 'real-amap-secret-key';
    saveBtn.click();
    await flushMicrotasks();

    // Save succeeded and probe failed -> separate error banner without contradicting save.
    assert.match(statusBox.textContent, /Key 已保存，但连通性测试失败：配额超限/);

    // Now the stale initial status (unconfigured) resolves late; it must be ignored.
    statusDeferred.resolve(jsonResponse({ configured: false, source: 'none', cacheEntries: 0 }));
    await flushMicrotasks();
    assert.equal(badge.textContent, '● 已配置生效');

    // Expiring auth disables all action buttons during render().
    ctx.mods.appState.authExpired = true;
    ctrl.render(true);
    assert.equal(saveBtn.disabled, true);
    assert.equal(testBtn.disabled, true);
    assert.equal(clearBtn.disabled, true);
  });
});

test('memory-hub drops stale search response when superseded or cleared and disables controls on authExpired', async () => {
  await withWebHarness(async ctx => {
    const {
      initImVoiceHub,
      initMemoryHub,
      initModelHub,
      initNotebookHub,
      initServicesHub,
      initTimerPluginHub,
      initUsageHub,
      initAppleDevicesUi,
      initCs80FaceUi,
      initFundTrackerUi,
      initHealthScaleUi,
      initLaifenUi,
      initNetleaUi,
      initNinebotUi,
    } = ctx.mods;
    const firstSearch = deferred<Response>();
    ctx.setFetchHandler(async url => {
      if (url.startsWith('/api/memories?')) {
        if (url.includes('query=old')) return firstSearch.promise;
        return jsonResponse([{ kind: 'memory', id: 'm2', topic: '新结果', title: '新结果', snippet: 'fresh' }]);
      }
      return jsonResponse([]);
    });

    const card: MemoryCard = {
      id: 'm1',
      topic: '旧记忆',
      content: '正文',
      tags: ['t1'],
      createdAt: 100,
      updatedAt: 1000,
      synapses: [{ targetId: 'm2', relation: 'semantic' as unknown as NonNullable<MemoryCard['synapses']>[number]['relation'], weight: 0.8, updatedAt: 1000 }],
    };
    const m2: MemoryCard = {
      id: 'm2',
      topic: '目标主题',
      content: '目标内容',
      tags: [],
      createdAt: 100,
      updatedAt: 900,
    };
    ctx.mods.appState.view = {
      memoryDirectory: { totalActive: 2, items: [card, m2] },
    } as unknown as MainView;

    const hub = initMemoryHub();
    const searchInput = ctx.doc.getElementById('memory-search-input')!;
    const searchBtn = ctx.doc.getElementById('memory-search-btn')!;
    const saveBtn = ctx.doc.getElementById('memory-save-btn')!;
    const resultsBox = ctx.doc.getElementById('memory-search-results')!;

    // Trigger old search, then immediately trigger empty clear.
    searchInput.value = 'old';
    searchBtn.click();
    searchInput.value = '';
    searchBtn.click();
    assert.equal(resultsBox.hidden, true);

    firstSearch.resolve(jsonResponse([{ kind: 'memory', id: 'm1', title: '旧结果', snippet: 'stale' }]));
    await flushMicrotasks();
    assert.equal(resultsBox.hidden, true);
    assert.equal(resultsBox.textContent, '');

    ctx.mods.appState.authExpired = true;
    hub.render(true);
    assert.equal(searchBtn.disabled, true);
    assert.equal(saveBtn.disabled, true);
  });
});

test('model-hub preserves new tab key input during in-flight save and keeps buttons disabled on authExpired', async () => {
  await withWebHarness(async ctx => {
    const {
      initImVoiceHub,
      initMemoryHub,
      initModelHub,
      initNotebookHub,
      initServicesHub,
      initTimerPluginHub,
      initUsageHub,
      initAppleDevicesUi,
      initCs80FaceUi,
      initFundTrackerUi,
      initHealthScaleUi,
      initLaifenUi,
      initNetleaUi,
      initNinebotUi,
    } = ctx.mods;
    const configureDeferred = deferred<Response>();
    const modelHubData: ModelHubView = {
      mode: 'real',
      routerProvider: 'deepseek',
      workerProvider: 'deepseek',
      routerModel: 'deepseek-chat',
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          authType: 'api_key',
          supportsOAuth: false,
          modelSource: 'remote_api',
          configured: true,
          enabled: true,
          models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 64000, costInput: 1, costOutput: 2, supportsImages: false, reasoning: false }],
        },
        {
          id: 'openai',
          name: 'OpenAI',
          authType: 'api_key',
          supportsOAuth: false,
          modelSource: 'remote_api',
          configured: false,
          enabled: true,
          models: [{ id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, costInput: 5, costOutput: 15, supportsImages: false, reasoning: false }],
        },
      ],
      modelPool: [],
      tiers: { router: 'deepseek-chat' } as ModelHubView['tiers'],
    };

    ctx.setFetchHandler(async (url, init) => {
      if (url.endsWith('/api/model-configure')) return configureDeferred.promise;
      if (url.endsWith('/api/model-probe')) {
        return jsonResponse({ ok: true, provider: 'deepseek', model: 'deepseek-chat', latencyMs: 12 });
      }
      void init;
      return jsonResponse({ ok: true });
    });

    ctx.mods.appState.view = { modelHub: modelHubData } as unknown as MainView;
    const hub = initModelHub({ isVisible: () => true });
    hub.activate('deepseek');

    const keyInput = ctx.doc.getElementById('modal-auth-key-input')!;
    const saveTestBtn = ctx.doc.getElementById('modal-auth-save-test-btn')!;
    const tabsBox = ctx.doc.getElementById('modal-provider-tabs')!;
    const probeBox = ctx.doc.getElementById('modal-auth-probe-result')!;

    keyInput.value = 'sk-deepseek-123';
    saveTestBtn.click();

    // User switches to OpenAI tab and begins typing new key while DeepSeek configure is in flight.
    const openaiTab = tabsBox.querySelectorAll('button').find(b => b.textContent.includes('OpenAI'))!;
    openaiTab.click();
    keyInput.value = 'sk-openai-typing';

    ctx.mods.appState.authExpired = true;
    configureDeferred.resolve(jsonResponse(modelHubData));
    await flushMicrotasks();

    assert.equal(keyInput.value, 'sk-openai-typing');
    assert.equal(probeBox.hidden, true);
    assert.equal(saveTestBtn.disabled, true);
    assert.equal(ctx.doc.getElementById('modal-save-routing-btn')!.disabled, true);
  });
});

test('usage-hub clears chart subtitle when buckets are empty and handles unknown actor safely', async () => {
  await withWebHarness(async ctx => {
    const {
      initImVoiceHub,
      initMemoryHub,
      initModelHub,
      initNotebookHub,
      initServicesHub,
      initTimerPluginHub,
      initUsageHub,
      initAppleDevicesUi,
      initCs80FaceUi,
      initFundTrackerUi,
      initHealthScaleUi,
      initLaifenUi,
      initNetleaUi,
      initNinebotUi,
    } = ctx.mods;
    const zeroTotals = {
      calls: 0,
      successCalls: 0,
      failedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      costCny: 0,
      cacheHitRate: 0,
      cacheSavingsUsd: 0,
      cacheSavingsCny: 0,
    } as unknown as UsageReportView['totals'];
    const emptyReport = {
      granularity: 'day',
      anchorDate: '2026-11-22',
      todayDate: '2026-11-22',
      tzOffsetMin: 480,
      periodLabel: '2026-11-22',
      startAt: 0,
      endAt: 86_400_000,
      prefs: { currency: 'CNY', usdToCnyRate: 7.2 },
      totals: zeroTotals,
      byActor: { router: zeroTotals, worker: zeroTotals, memory: zeroTotals, decision: zeroTotals, voice: zeroTotals, custom_unknown: zeroTotals },
      byModel: [],
      buckets: [],
      recentPeriods: [],
      availableModels: [],
    } as unknown as UsageReportView;
    const nonEmptyReport = {
      ...emptyReport,
      buckets: [{ key: '00', startAt: 0, endAt: 1, label: '00:00', calls: 1, inputTokens: 50, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 100, costUsd: 0.01, costCny: 0.072 }],
    } as unknown as UsageReportView;

    let usageCalls = 0;
    ctx.setFetchHandler(async url => {
      if (url.startsWith('/api/usage')) {
        usageCalls++;
        return jsonResponse(usageCalls === 1 ? nonEmptyReport : emptyReport);
      }
      return jsonResponse({});
    });

    const hub = initUsageHub({ isVisible: () => true });
    hub.activate();
    await flushMicrotasks();
    const subtitle = ctx.doc.getElementById('usage-chart-subtitle')!;
    assert.notEqual(subtitle.textContent, '');

    ctx.doc.getElementById('usage-refresh-btn')!.click();
    await flushMicrotasks();
    assert.equal(subtitle.textContent, '');
  });
});

test('im-voice-hub cancels stale QR start/status requests on close and catches clipboard errors', async () => {
  await withWebHarness(async ctx => {
    const {
      initImVoiceHub,
      initMemoryHub,
      initModelHub,
      initNotebookHub,
      initServicesHub,
      initTimerPluginHub,
      initUsageHub,
      initAppleDevicesUi,
      initCs80FaceUi,
      initFundTrackerUi,
      initHealthScaleUi,
      initLaifenUi,
      initNetleaUi,
      initNinebotUi,
    } = ctx.mods;
    const qrStartDeferred = deferred<Response>();
    let rejectedClipboard = 0;
    ctx.setClipboardImpl(async () => {
      rejectedClipboard++;
      throw new Error('NotAllowedError');
    });
    ctx.setFetchHandler(async url => {
      if (url.endsWith('/api/im-wechat-qr-start')) return qrStartDeferred.promise;
      return jsonResponse({ ok: true });
    });

    ctx.mods.appState.view = {
      imChannels: [
        {
          id: 'ch-webhook',
          platform: 'dingtalk',
          name: '钉钉测试',
          enabled: true,
          inboundCount: 0,
          outboundCount: 0,
          allowedSenders: [],
        },
      ],
    } as unknown as MainView;

    const hub = initImVoiceHub();
    hub.openModal();

    // Clipboard error in webhook copy button must not trigger unhandledRejection.
    let unhandled: unknown = null;
    const onUnhandled = (err: unknown) => { unhandled = err; };
    process.on('unhandledRejection', onUnhandled);
    try {
      const copyBtn = ctx.doc.getElementById('im-list')!.querySelectorAll('button').find(b => b.textContent.includes('复制地址'))!;
      copyBtn.click();
      await flushMicrotasks();
      assert.equal(rejectedClipboard, 1);
      assert.equal(unhandled, null);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    // Start WeChat QR then close QR modal before start resolves.
    ctx.doc.getElementById('im-wechat-qr-btn')!.click();
    ctx.doc.getElementById('im-wechat-qr-close')!.click();

    const qrSession: WechatQrLoginSession = {
      sessionId: 'qr-stale',
      channelId: 'wechat-1',
      channelName: '微信',
      qrcode: 'qr-1',
      qrTerminal: '',
      status: 'wait',
      qrSvgDataUrl: 'data:image/png;base64,AAAA',
      qrcodeContent: 'https://weixin.qq.com/x/1',
    };
    qrStartDeferred.resolve(jsonResponse(qrSession));
    await flushMicrotasks();

    assert.equal(ctx.doc.getElementById('im-wechat-qr-box')!.hidden, true);
    assert.equal(ctx.doc.getElementById('im-wechat-qr-refresh')!.disabled, false);
    hub.stopWechatQrPoll();
  });
});

test('notebook-hub serializes overlapping saves, preserves mid-flight edits, and handles unknown diary moods', async () => {
  await withWebHarness(async ctx => {
    const {
      initImVoiceHub,
      initMemoryHub,
      initModelHub,
      initNotebookHub,
      initServicesHub,
      initTimerPluginHub,
      initUsageHub,
      initAppleDevicesUi,
      initCs80FaceUi,
      initFundTrackerUi,
      initHealthScaleUi,
      initLaifenUi,
      initNetleaUi,
      initNinebotUi,
    } = ctx.mods;
    const save1Deferred = deferred<Response>();
    let saveCalls = 0;
    const noteA: NoteItem = {
      id: 'n1',
      title: '笔记 A',
      content: '初始内容',
      tags: ['dev'],
      pinned: false,
      author: 'user',
      updatedBy: 'user',
      createdAt: 100,
      updatedAt: 100,
    };
    const noteB: NoteItem = {
      id: 'n2',
      title: '笔记 B',
      content: 'B 内容',
      tags: [],
      pinned: false,
      author: 'user',
      updatedBy: 'user',
      createdAt: 90,
      updatedAt: 90,
    };
    const unknownMoodDiary: DiaryEntry = {
      id: 'd1',
      date: '2026-11-22',
      title: '随笔',
      content: '今天调试',
      mood: 'mystic_unknown' as unknown as DiaryEntry['mood'],
      source: 'reflection' as unknown as DiaryEntry['source'],
      tags: [],
      createdAt: 100,
      updatedAt: 100,
    };

    ctx.setFetchHandler(async (url, init) => {
      if (url.startsWith('/api/notes')) {
        return jsonResponse({ items: [noteA, noteB], tags: [], summary: { noteCount: 2, pinnedNoteCount: 0, diaryCount: 1 } });
      }
      if (url.startsWith('/api/diary')) {
        return jsonResponse({ items: [unknownMoodDiary], summary: { noteCount: 2, pinnedNoteCount: 0, diaryCount: 1 } });
      }
      if (url.endsWith('/api/note-save')) {
        saveCalls++;
        const payload = JSON.parse(String(init?.body)) as { title: string; content: string };
        if (saveCalls === 1) return save1Deferred.promise;
        return jsonResponse({
          note: { ...noteA, title: payload.title, content: payload.content, updatedAt: 300 },
          summary: { noteCount: 2, pinnedNoteCount: 0, diaryCount: 1 },
        });
      }
      return jsonResponse({});
    });

    const nb = initNotebookHub();
    nb.openModal('notes');
    await flushMicrotasks();

    // Type edit 1 and trigger Save Now -> blocks on save1Deferred.
    const contentEl = ctx.doc.getElementById('note-content-input')!;
    contentEl.value = '第一次修改';
    contentEl.dispatchEvent(new FakeEvent('input'));
    ctx.doc.getElementById('note-save-now-btn')!.click();

    // User types a second edit while save 1 is in flight, then switches to Note B.
    contentEl.value = '第二次修改';
    contentEl.dispatchEvent(new FakeEvent('input'));
    const listButtons = ctx.doc.getElementById('note-list')!.querySelectorAll('button');
    const noteBItem = listButtons.find(b => b.textContent.includes('笔记 B'))!;
    noteBItem.click();

    // Note B must NOT be active yet while Note A saves finish!
    assert.equal(ctx.doc.getElementById('note-title-input')!.value, '笔记 A');

    // Resolve save 1: flushPendingSave sees mid-flight edit and automatically performs save 2 before switching to Note B.
    save1Deferred.resolve(jsonResponse({
      note: { ...noteA, content: '第一次修改', updatedAt: 200 },
      summary: { noteCount: 2, pinnedNoteCount: 0, diaryCount: 1 },
    }));
    await flushMicrotasks(12);

    assert.equal(saveCalls, 2);
    assert.equal(ctx.doc.getElementById('note-title-input')!.value, '笔记 B');
    assert.equal(ctx.doc.getElementById('note-content-input')!.value, 'B 内容');

    // Switching to diary with an unknown mood must render without throwing.
    ctx.doc.getElementById('notebook-tab-diary')!.click();
    await flushMicrotasks();
    assert.equal(ctx.doc.getElementById('diary-title-display')!.textContent, '随笔');
  });
});

test('timer-plugin-hub keeps run/save buttons disabled on authExpired and cleans up modal drag state on close', async () => {
  await withWebHarness(async ctx => {
    const {
      initImVoiceHub,
      initMemoryHub,
      initModelHub,
      initNotebookHub,
      initServicesHub,
      initTimerPluginHub,
      initUsageHub,
      initAppleDevicesUi,
      initCs80FaceUi,
      initFundTrackerUi,
      initHealthScaleUi,
      initLaifenUi,
      initNetleaUi,
      initNinebotUi,
    } = ctx.mods;
    const plugins: PluginView[] = [
      {
        name: 'demo-ext',
        title: 'demo-ext',
        description: 'demo',
        entry: 'index.mjs',
        enabled: true,
        runtime: 'node',
        actions: ['status'],
        actionSpecs: [{ name: 'status', label: '状态检查', safeQuickRun: true }],
      } as unknown as PluginView,
    ];
    const timers: TimerView[] = [];
    ctx.mods.appState.view = { plugins, timers } as unknown as MainView;

    const hub = initTimerPluginHub({ pluginSurfaces: [] });
    hub.openPluginModal('demo-ext', false, 'catalog');

    ctx.mods.appState.authExpired = true;
    hub.renderTimers(true);
    hub.renderPlugins(false);

    assert.equal(ctx.doc.getElementById('timer-save-btn')!.disabled, true);
    const detailBtns = ctx.doc.getElementById('plugin-catalog-detail')!.querySelectorAll('button')
      .filter(b => !b.textContent.includes('返回') && !b.dataset.subTab);
    assert.ok(detailBtns.length > 0);
    assert.ok(detailBtns.every(b => b.disabled === true));

    // Safe when document.elementFromPoint is unavailable + close resets state cleanly.
    ctx.doc.elementFromPointImpl = undefined;
    hub.closePluginModal();
    assert.equal(ctx.doc.getElementById('plugin-hub-backdrop')!.hidden, true);
  });
});

test('apple-devices-ui preserves logout/config status messages and prevents stale refreshBadge overwrite', async () => {
  await withWebHarness(async ctx => {
    const {
      initImVoiceHub,
      initMemoryHub,
      initModelHub,
      initNotebookHub,
      initServicesHub,
      initTimerPluginHub,
      initUsageHub,
      initAppleDevicesUi,
      initCs80FaceUi,
      initFundTrackerUi,
      initHealthScaleUi,
      initLaifenUi,
      initNetleaUi,
      initNinebotUi,
    } = ctx.mods;
    const badgeDeferred = deferred<Response>();
    let badgeStatusCalls = 0;

    ctx.setFetchHandler(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
      if (body.action === 'status') {
        badgeStatusCalls++;
        if (badgeStatusCalls === 1) return badgeDeferred.promise;
        return jsonResponse({ ok: true, message: 'ok', data: { authState: 'unauthenticated', devices: [], config: {} } });
      }
      if (body.action === 'logout') {
        return jsonResponse({ ok: true, message: '已退出当前 Apple ID 会话' });
      }
      if (body.action === 'config') {
        return jsonResponse({ ok: true, message: '配置已写入本地' });
      }
      return jsonResponse({ ok: true, data: { authState: 'authenticated', devices: [{ id: 'd1', name: 'iPhone', category: 'iphone', batteryPercent: 88, online: true }], config: {} } });
    });

    const visible = { flag: false };
    const ctrl = initAppleDevicesUi({ isVisible: () => visible.flag });

    // Start slow refreshBadge while inactive, then activate & resolve stale badge later.
    const badgePromise = ctrl.refreshBadge();
    visible.flag = true;
    ctrl.activate();
    await flushMicrotasks();

    badgeDeferred.resolve(jsonResponse({
      ok: true,
      data: { authState: 'authenticated', devices: [{ id: 'old', name: 'Old', category: 'iphone', batteryPercent: 12, online: true }], config: {} },
    }));
    await badgePromise;
    await flushMicrotasks();
    assert.notEqual(ctx.doc.getElementById('apple-top-badge')!.textContent, '12%');

    // Logout must preserve logout message rather than overwriting with "已加载本地缓存快照".
    ctx.doc.getElementById('apple-logout-btn')!.click();
    await flushMicrotasks();
    assert.equal(ctx.doc.getElementById('apple-action-status')!.textContent, '已退出当前 Apple ID 会话');

    // Save config must preserve config save message rather than clearing banner.
    ctx.doc.getElementById('apple-cfg-save-btn')!.click();
    await flushMicrotasks();
    assert.equal(ctx.doc.getElementById('apple-action-status')!.textContent, '配置已写入本地');
  });
});

test('cs80-face-ui catches failed async actions, protects weatherCityInput, and rejects unsafe preview URLs', async () => {
  await withWebHarness(async ctx => {
    const {
      initImVoiceHub,
      initMemoryHub,
      initModelHub,
      initNotebookHub,
      initServicesHub,
      initTimerPluginHub,
      initUsageHub,
      initAppleDevicesUi,
      initCs80FaceUi,
      initFundTrackerUi,
      initHealthScaleUi,
      initLaifenUi,
      initNetleaUi,
      initNinebotUi,
    } = ctx.mods;
    const layout1Deferred = deferred<Response>();
    const layoutPayload = {
      version: 1,
      gridRows: 2,
      marqueeMode: 'auto_pause',
      marqueeSpeed: 2,
      pageRotateSec: 0,
      autoTaskOverlay: true,
      activePage: 0,
      weatherCity: '上海',
      weatherLat: 31.2,
      weatherLon: 121.4,
      pages: [{ id: 'p1', name: '主页', cards: [] }],
    };

    ctx.setFetchHandler(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; args?: Record<string, unknown> };
      if (body.action === 'dashboard') {
        return jsonResponse({
          ok: true,
          data: {
            ok: true,
            status: { ok: true, device: 'up', brightness: 90 },
            layout: layoutPayload,
            catalog: [],
            widgets: {},
            previewDataUrl: 'javascript:alert(1)',
          },
        });
      }
      if (body.action === 'screen') {
        throw new Error('CS80 USB disconnected');
      }
      if (body.action === 'layout') {
        if (body.args?.gridRows === 3) return layout1Deferred.promise;
        return jsonResponse({ ok: true, data: { layout: { ...layoutPayload, ...body.args } } });
      }
      return jsonResponse({ ok: true });
    });

    const ctrl = initCs80FaceUi({ isVisible: () => true });
    ctrl.activate();
    await flushMicrotasks();

    // Unsafe previewDataUrl must not be assigned to img.src.
    const previewImg = ctx.doc.getElementById('cs80-live-preview')!;
    assert.equal(previewImg.src, '');

    // Failed async action must set error banner without unhandledRejection.
    let unhandled: unknown = null;
    const onUnhandled = (err: unknown) => { unhandled = err; };
    process.on('unhandledRejection', onUnhandled);
    try {
      ctx.doc.getElementById('cs80-force-full-btn')!.click();
      await flushMicrotasks();
      assert.match(ctx.doc.getElementById('cs80-action-status')!.textContent, /CS80 USB disconnected/);
      assert.equal(unhandled, null);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    // Typing weatherCityInput marks weatherCityDirty and partial layout sync must not erase it.
    const cityInput = ctx.doc.getElementById('cs80-weather-city')!;
    cityInput.value = '杭州';
    cityInput.dispatchEvent(new FakeEvent('input'));

    const rows3Btn = ctx.doc.getElementById('cs80-grid-rows-pills')!.querySelector('button[data-grid-rows="3"]')!;
    rows3Btn.click();
    layout1Deferred.resolve(jsonResponse({ ok: true, data: { layout: { ...layoutPayload, gridRows: 3, weatherCity: '上海' } } }));
    await flushMicrotasks();
    assert.equal(cityInput.value, '杭州');

    ctrl.deactivate();
  });
});

test('laifen-ui preserves config inputs via draftDirty and drops stale refreshBadge updates', async () => {
  await withWebHarness(async ctx => {
    const {
      initImVoiceHub,
      initMemoryHub,
      initModelHub,
      initNotebookHub,
      initServicesHub,
      initTimerPluginHub,
      initUsageHub,
      initAppleDevicesUi,
      initCs80FaceUi,
      initFundTrackerUi,
      initHealthScaleUi,
      initLaifenUi,
      initNetleaUi,
      initNinebotUi,
    } = ctx.mods;
    const badgeDeferred = deferred<Response>();
    ctx.setFetchHandler(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
      if (body.action === 'status') return badgeDeferred.promise;
      return jsonResponse({
        ok: true,
        data: {
          liveSession: null,
          watchStatus: { enabled: false, intervalMs: 5000, lastTickAt: null },
          pendingWrite: null,
          device: null,
          presets: [],
          sessions: [],
          stats: { todayCount: 1, dailyGoalCount: 2, totalSessions: 1, avgDurationSec: 120, brushHeadDaysRemaining: 80, last7Days: [] },
          config: { targetMac: 'AA:BB', namePrefix: 'LFTB', brushHeadLifespanDays: 90, dailyGoalCount: 2 },
        },
      });
    });

    const ctrl = initLaifenUi({ isVisible: () => true });
    const badgePromise = ctrl.refreshBadge();
    ctrl.activate();
    await flushMicrotasks();

    // Edit config MAC and blur -> draftDirty prevents poll/refresh overwrite.
    const macInput = ctx.doc.getElementById('laifen-cfg-mac')!;
    macInput.value = 'CC:DD:EE';
    macInput.dispatchEvent(new FakeEvent('input'));
    macInput.blur();

    // Triggering dashboard refresh indirectly must keep typed MAC while draftDirty is true.
    ctx.doc.getElementById('laifen-checkin-btn')!.click();
    await flushMicrotasks();
    assert.equal(macInput.value, 'CC:DD:EE');

    badgeDeferred.resolve(jsonResponse({
      ok: true,
      data: {
        device: { batteryPct: 99, activeMode: 1, activeStrength: 5, activeRange: 5, activeSpeed: 5, modes: {}, durationSec: 120, highFrequency: false, reminder30s: false, airplaneMode: false, status: 'idle', lastSyncedAt: null, mac: 'OLD', address: 'OLD', name: 'Old', protocol: 'v2', rssi: -50 },
        stats: { todayCount: 0, dailyGoalCount: 2, totalSessions: 0, avgDurationSec: 0, brushHeadDaysRemaining: 90, last7Days: [] },
        config: { targetMac: '', namePrefix: 'LFTB', brushHeadLifespanDays: 90, dailyGoalCount: 2 },
        presets: [],
        sessions: [],
        liveSession: null,
        watchStatus: { enabled: false, intervalMs: 5000, lastTickAt: null },
        pendingWrite: null,
      },
    }));
    await badgePromise;
    await flushMicrotasks();
    assert.notEqual(ctx.doc.getElementById('laifen-top-badge')!.textContent, '99%');
    ctrl.deactivate();
  });
});

test('ninebot-ui, fund-tracker-ui, and health-scale-ui avoid canvas DPR width explosion and stale race bugs', async () => {
  await withWebHarness(async ctx => {
    const {
      initImVoiceHub,
      initMemoryHub,
      initModelHub,
      initNotebookHub,
      initServicesHub,
      initTimerPluginHub,
      initUsageHub,
      initAppleDevicesUi,
      initCs80FaceUi,
      initFundTrackerUi,
      initHealthScaleUi,
      initLaifenUi,
      initNetleaUi,
      initNinebotUi,
    } = ctx.mods;
    // 1) Ninebot DPR stability when rect.width is 0 and clientWidth is fallback
    const ninebotCanvas = ctx.doc.getElementById('ninebot-trend-canvas')!;
    ninebotCanvas.width = 520;
    ninebotCanvas.height = 156;
    ninebotCanvas.clientWidth = 520;
    ninebotCanvas.clientHeight = 156;

    const fundStaleRefresh = deferred<Response>();
    let fundDashCalls = 0;

    ctx.setFetchHandler(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { plugin?: string; action?: string; args?: Record<string, unknown> };
      if (body.plugin === 'ninebot') {
        return jsonResponse({
          ok: true,
          data: {
            configured: true,
            snapshot: { sn: 'SN1', name: 'N90C', modelName: 'N90C', backend: 'account', businessLine: 'motor', capturedAt: 1000, battery: 80, charging: false, powerOn: false, locked: true, gsm: 4, gsmDesc: 'ok', effectiveRangeKm: 40, odoKm: 100, speedKmh: 0, remainChargeMin: 0, location: { valid: false, wgsLat: null, wgsLon: null, gcjLat: null, gcjLon: null, address: null, shortAddress: null, source: null }, alerts: [] },
            vehicles: [],
            history: [{ capturedAt: 1000, battery: 80, effectiveRangeKm: 40 }],
            monthStats: { yearMonth: '2026-11', tripCount: 0, totalDistanceKm: 0, totalDurationSec: 0, avgSpeedKmh: 0, maxSpeedKmh: 0, trips: [] },
            config: { backend: 'account', defaultSn: 'SN1', lowBatteryThreshold: 20, minRangeAlertKm: 15, offlineAlertDays: 3, pollCooldownSec: 60, alertOnUnlockedPark: false, geoConfigured: false },
          },
        });
      }
      if (body.plugin === 'fund-tracker') {
        if (body.action === 'remove-holding') {
          return jsonResponse({ ok: true, message: '已移除' });
        }
        fundDashCalls++;
        if (fundDashCalls === 1) return fundStaleRefresh.promise;
        return jsonResponse({
          ok: true,
          data: {
            today: '2026-11-22',
            updatedAt: 2000,
            modeLabel: 'live',
            summary: { totalAsset: 100, totalCost: 90, totalDailyPnl: 1, dailyPnlPct: 1, totalPnl: 10, totalPnlPct: 10, stocks: { count: 0, totalAsset: 0, totalCost: 0, totalDailyPnl: 0, dailyPnlPct: 0, totalPnl: 0, totalPnlPct: 0 }, funds: { count: 0, totalAsset: 0, totalCost: 0, totalDailyPnl: 0, dailyPnlPct: 0, totalPnl: 0, totalPnlPct: 0 }, holdings: [] },
            holdings: [],
            snapshots: [],
            navHistory: {},
          },
        });
      }
      return jsonResponse({ ok: true });
    });

    const ninebot = initNinebotUi({ isVisible: () => true });
    ninebot.activate();
    await flushMicrotasks();
    // Width must stay 520 * dpr(2) = 1040 across repeated resizes, NOT 1040 * 2 = 2080 -> 4160!
    assert.equal(ninebotCanvas.width, 1040);
    ctx.dispatchWindowEvent('resize');
    ctx.dispatchWindowEvent('resize');
    assert.equal(ninebotCanvas.width, 1040);
    ninebot.deactivate();

    // 2) Fund-tracker stale isRefresh response must not overwrite newer deleteHolding result
    const fundCanvas = ctx.doc.getElementById('fund-trend-canvas')!;
    fundCanvas.clientWidth = 900;
    fundCanvas.clientHeight = 220;
    let fundVisible = true;
    const fund = initFundTrackerUi({ isVisible: () => fundVisible });
    fund.activate(); // Starts call #1 (cached) -> wait, let's test refresh click (isRefresh: true) vs remove-holding
    await flushMicrotasks();

    // Wait: reset fundDashCalls to test slow isRefresh: true superseded by quick refresh/delete
    fundDashCalls = 0;
    ctx.doc.getElementById('fund-refresh-btn')!.click(); // #1 -> slow fundStaleRefresh (with isRefresh: true)
    ctx.doc.getElementById('fund-settle-btn')!.click(); // busy=true blocks while manual refresh runs; call delete after unlock or refreshBadge!
    // Trigger refreshBadge (requestSeq++) via activate() or simulate stale isRefresh resolving after settle completed:
    fundStaleRefresh.resolve(jsonResponse({
      ok: true,
      data: {
        today: '2026-11-22',
        updatedAt: 1000,
        modeLabel: 'stale-refresh',
        summary: { totalAsset: 999, totalCost: 90, totalDailyPnl: 1, dailyPnlPct: 1, totalPnl: 10, totalPnlPct: 10, stocks: { count: 0, totalAsset: 0, totalCost: 0, totalDailyPnl: 0, dailyPnlPct: 0, totalPnl: 0, totalPnlPct: 0 }, funds: { count: 0, totalAsset: 0, totalCost: 0, totalDailyPnl: 0, dailyPnlPct: 0, totalPnl: 0, totalPnlPct: 0 }, holdings: [] },
        holdings: [{ code: '000001', name: '旧基金', fundType: 'fund', share: 10, cost: 9, asset: 10, dailyPnl: 0, dailyPnlPct: 0, totalPnl: 1, totalPnlPct: 11, nav: 1, prevNav: 1, navDate: '2026-11-22', baseNav: 1, baseNavDate: '2026-11-21', navSource: '估', ratio: 1, proxyName: '', isAStock: false, hasTodayOfficialNav: false, quoteMissing: false, quoteStale: false, usMarketClosed: false }],
        snapshots: [],
        navHistory: {},
      },
    }));
    await flushMicrotasks();
    // Launch a slow isRefresh via fund-refresh-btn while testing requestSeq supersede by fund.activate():
    let secondRefreshRes = deferred<Response>();
    fundDashCalls = 10;
    ctx.setFetchHandler(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { args?: { refresh?: boolean } };
      if (body.args?.refresh) return secondRefreshRes.promise;
      return jsonResponse({
        ok: true,
        data: {
          today: '2026-11-22',
          updatedAt: 3000,
          modeLabel: 'newer',
          summary: { totalAsset: 777, totalCost: 700, totalDailyPnl: 0, dailyPnlPct: 0, totalPnl: 77, totalPnlPct: 11, stocks: { count: 0, totalAsset: 0, totalCost: 0, totalDailyPnl: 0, dailyPnlPct: 0, totalPnl: 0, totalPnlPct: 0 }, funds: { count: 0, totalAsset: 0, totalCost: 0, totalDailyPnl: 0, dailyPnlPct: 0, totalPnl: 0, totalPnlPct: 0 }, holdings: [] },
          holdings: [],
          snapshots: [],
          navHistory: {},
        },
      });
    });
    ctx.doc.getElementById('fund-refresh-btn')!.click();
    await fund.refreshBadge(); // increments requestSeq and resolves with totalAsset: 777
    assert.equal(ctx.doc.getElementById('fund-hero-asset')!.textContent, '¥777.00');
    secondRefreshRes.resolve(jsonResponse({
      ok: true,
      data: {
        today: '2026-11-22',
        updatedAt: 500,
        modeLabel: 'old-refresh',
        summary: { totalAsset: 111, totalCost: 100, totalDailyPnl: 0, dailyPnlPct: 0, totalPnl: 11, totalPnlPct: 11, stocks: { count: 0, totalAsset: 0, totalCost: 0, totalDailyPnl: 0, dailyPnlPct: 0, totalPnl: 0, totalPnlPct: 0 }, funds: { count: 0, totalAsset: 0, totalCost: 0, totalDailyPnl: 0, dailyPnlPct: 0, totalPnl: 0, totalPnlPct: 0 }, holdings: [] },
        holdings: [],
        snapshots: [],
        navHistory: {},
      },
    }));
    await flushMicrotasks();
    assert.equal(ctx.doc.getElementById('fund-hero-asset')!.textContent, '¥777.00');
    fundVisible = false;
    fund.deactivate();

    // 3) Health-scale DPR stability across repeated resizes
    const healthCanvas = ctx.doc.getElementById('health-trend-canvas')!;
    healthCanvas.clientWidth = 900;
    healthCanvas.clientHeight = 220;
    ctx.setFetchHandler(async () => jsonResponse({
      ok: true,
      data: {
        activeProfileId: 'p1',
        activeProfile: { id: 'p1', name: '主人', sex: 'male', age: 30, heightCm: 175, targetWeightKg: 70, unit: 'kg', isDefault: true, createdAt: 1, updatedAt: 1 },
        profiles: [{ id: 'p1', name: '主人', sex: 'male', age: 30, heightCm: 175, targetWeightKg: 70, unit: 'kg', isDefault: true, createdAt: 1, updatedAt: 1 }],
        records: [],
        latest: null,
        stats: { totalRecords: 0, latestWeightKg: null, deltaFromPrevKg: null, deltaFromTargetKg: null, latestBmi: null, latestBodyFatPct: null, avgWeight7dKg: null, minWeight30dKg: null, maxWeight30dKg: null, streakDays: 0 },
        device: null,
        liveSession: null,
      },
    }));
    const health = initHealthScaleUi({ isVisible: () => true });
    health.activate();
    await flushMicrotasks();
    assert.equal(healthCanvas.width, 1800);
    ctx.dispatchWindowEvent('resize');
    ctx.dispatchWindowEvent('resize');
    assert.equal(healthCanvas.width, 1800);
    health.deactivate();
  });
});

test('netlea-ui catches refreshAfterMutation errors, protects busy banner, shifts editingTripIndex on delete, and deduplicates previews', async () => {
  await withWebHarness(async ctx => {
    const {
      initImVoiceHub,
      initMemoryHub,
      initModelHub,
      initNotebookHub,
      initServicesHub,
      initTimerPluginHub,
      initUsageHub,
      initAppleDevicesUi,
      initCs80FaceUi,
      initFundTrackerUi,
      initHealthScaleUi,
      initLaifenUi,
      initNetleaUi,
      initNinebotUi,
    } = ctx.mods;
    const firstDash = {
      configured: true,
      device: null,
      state: {
        on: true,
        brightness: 80,
        channels: { red: 50, green: 50, white: 50, blue: 50, fan: 0 },
        runModeLabel: '手动',
        powerWatts: 12,
        maxWatts: 22,
        matchedScene: { model: 99, modeCode: 0, gear: 1 },
      },
      schedule: {
        sunriseMinutes: 10,
        sunsetMinutes: 10,
        travelModel: 0,
        trips: [
          { enable: 1, startH: 8, startM: 0, endH: 10, endM: 0, dayList: [1, 1, 1, 1, 1, 1, 1], model: 0, modeCode: 0, gear: 5, red: 50, green: 50, white: 50, blue: 50, fan: 0, name: 'T0' },
          { enable: 1, startH: 11, startM: 0, endH: 13, endM: 0, dayList: [1, 1, 1, 1, 1, 1, 1], model: 0, modeCode: 0, gear: 8, red: 60, green: 60, white: 60, blue: 60, fan: 0, name: 'T1' },
        ],
      },
      config: {
        targetMac: 'AA:BB',
        namePrefix: 'SG-',
        defaultChannels: { red: 50, green: 50, white: 50, blue: 50, fan: 0 },
        savedCustomPresets: [],
      },
      catalog: {
        maxWatts: 22,
        scenes: [
          {
            model: 0,
            seriesName: '水草',
            modeCode: 0,
            name: '正白',
            maxGear: 10,
            gears: [
              { gear: 5, powerWatts: 10, channels: { red: 50, green: 50, white: 50, blue: 50, fan: 0 } },
              { gear: 8, powerWatts: 16, channels: { red: 60, green: 60, white: 60, blue: 60, fan: 0 } },
            ],
          },
        ],
        cultivationPresets: [{ id: 'open_tank', name: '开缸', description: 'demo' }],
      },
    };

    const actionDeferred = deferred<Response>();
    let mutationDashShouldFail = false;

    ctx.setFetchHandler(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string };
      if (body.action === 'clock') return actionDeferred.promise;
      if (body.action === 'dashboard') {
        if (mutationDashShouldFail) throw new Error('BLE dashboard read failed');
        return jsonResponse({ ok: true, data: firstDash });
      }
      return jsonResponse({ ok: true, message: 'ok' });
    });

    const netlea = initNetleaUi({ isVisible: () => true });
    netlea.activate();
    await flushMicrotasks();

    // Deleting trip 0 while editing trip 1 must shift editingTripIndex to 0 so applying overwrites T1 instead of appending.
    const editButtons = ctx.doc.getElementById('netlea-trip-list')!.querySelectorAll('button').filter(b => b.textContent.includes('编辑'));
    editButtons[1]!.click();
    const deleteButtons = ctx.doc.getElementById('netlea-trip-list')!.querySelectorAll('button').filter(b => b.textContent.includes('删除'));
    deleteButtons[0]!.click();
    ctx.doc.getElementById('netlea-trip-apply-btn')!.click();
    assert.equal(ctx.doc.getElementById('netlea-trip-list')!.querySelectorAll('.netlea-trip-card').length, 1);

    // Clicking offBtn while clockBtn is busy must NOT overwrite statusBanner, and failing refreshAfterMutation must not reject.
    let unhandled: unknown = null;
    const onUnhandled = (err: unknown) => { unhandled = err; };
    process.on('unhandledRejection', onUnhandled);
    try {
      ctx.doc.getElementById('netlea-clock-btn')!.click();
      assert.match(ctx.doc.getElementById('netlea-action-status')!.textContent, /RTC/);
      ctx.doc.getElementById('netlea-off-btn')!.click();
      assert.match(ctx.doc.getElementById('netlea-action-status')!.textContent, /RTC/);

      mutationDashShouldFail = true;
      actionDeferred.resolve(jsonResponse({ ok: true, message: '时钟已同步' }));
      await flushMicrotasks();

      assert.match(ctx.doc.getElementById('netlea-action-status')!.textContent, /BLE dashboard read failed/);
      assert.equal(unhandled, null);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    netlea.deactivate();
  });
});

test('miot-ui renders Mesh/Geek/Scenes, prevents stale refreshBadge overwrite, rejects unsafe geekUrl, and preserves mutation status', async () => {
  await withWebHarness(async ctx => {
    const { initMiotUi } = ctx.mods;
    const badgeDeferred = deferred<Response>();
    let dashCount = 0;

    ctx.setFetchHandler(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { action?: string; args?: Record<string, unknown> };
      if (body.action === 'dashboard') {
        dashCount++;
        if (dashCount === 1) return badgeDeferred.promise;
        return jsonResponse({
          ok: true,
          message: 'ok',
          data: {
            configured: true,
            gateway: { online: true, roleLabel: '主中枢', homeName: 'Demo Home', ip: '192.0.2.1', geekPort: 8086 },
            btService: { version: '3.1.7' },
            geekReady: true,
            geekUrl: 'http://192.0.2.1:8086',
            devices: [
              { did: 'd1', name: '卧室灯', room: '卧室', fullName: '卧室灯', category: 'light', categories: ['light'], controlChannel: 'bt_mesh', controllable: true, online: true, model: 'test.light', state: { on: true, source: 'live' } },
            ],
            geekGraphs: [
              { id: 'g1', name: '晚间定时', enable: true, nodeCount: 2, nodeTypes: ['alarmClock', 'deviceOutput'], summary: '每天 22:00 → 关闭卧室灯' },
            ],
            geekLogs: [
              { ts: 1_700_000_000_000, type: 'node', graphId: 'g1', graphName: '晚间定时', ok: true, summary: '节点 n2 执行成功' },
            ],
            scenes: [
              { id: 's1', summary: '打开卧室灯', turnsOffProtected: false },
            ],
            variables: [
              { scope: 'friday', id: 'mode1', type: 'number', value: 1 },
            ],
            config: {
              routerSsh: 'root@192.0.2.1',
              speakerSsh: '',
              protectedDevices: [],
              customAliases: {},
              cacheTtlMs: 15000,
              topologyTtlMs: 600000,
              udpTimeoutMs: 3500,
            },
          },
        });
      }
      if (body.action === 'config') {
        return jsonResponse({ ok: true, message: '配置已保存到本地' });
      }
      return jsonResponse({ ok: true, message: 'ok' });
    });

    const visible = { flag: false };
    const ctrl = initMiotUi({ isVisible: () => visible.flag });

    // Start slow cacheOnly refreshBadge while inactive, then activate & resolve stale badge later.
    const badgePromise = ctrl.refreshBadge();
    visible.flag = true;
    ctrl.activate();
    await flushMicrotasks();

    badgeDeferred.resolve(jsonResponse({
      ok: true,
      data: {
        configured: true,
        devices: Array.from({ length: 99 }, (_, idx) => ({
          did: `old-${idx}`, name: 'Old', room: '客厅', fullName: 'Old', category: 'light', categories: ['light'],
          controlChannel: 'bt_mesh', controllable: true, online: true, model: 'm',
        })),
      },
    }));
    await badgePromise;
    await flushMicrotasks();

    assert.equal(ctx.doc.getElementById('miot-top-badge')!.textContent, '1 Mesh');
    assert.equal(ctx.doc.getElementById('miot-open-geek-link')!.href, 'http://192.0.2.1:8086');
    assert.equal(ctx.doc.getElementById('miot-open-geek-link')!.hidden, false);
    assert.equal(ctx.doc.getElementById('miot-geek-list')!.querySelectorAll('.miot-geek-card').length, 1);

    // Config save preserves banner message instead of clearing it during reload.
    ctx.doc.getElementById('miot-cfg-save-btn')!.click();
    await flushMicrotasks();
    assert.equal(ctx.doc.getElementById('miot-action-status')!.textContent, '配置已保存到本地');

    ctrl.deactivate();
  });
});

test('miot-ui rejects unsafe javascript: geekUrl', async () => {
  await withWebHarness(async ctx => {
    const { initMiotUi } = ctx.mods;
    ctx.setFetchHandler(async () => jsonResponse({
      ok: true,
      data: {
        configured: true,
        geekUrl: 'javascript:alert(1)',
        devices: [],
        geekGraphs: [],
      },
    }));
    const ctrl = initMiotUi({ isVisible: () => true });
    ctrl.activate();
    await flushMicrotasks();
    const link = ctx.doc.getElementById('miot-open-geek-link')!;
    assert.equal(link.hidden, true);
    assert.equal(link.getAttribute('href'), null);
    ctrl.deactivate();
  });
});

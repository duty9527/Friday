export type UiTheme = 'spatial' | 'industrial';

const THEME_STORAGE_KEY = 'friday.ui-theme';
const LEFT_DRAWER_STORAGE_KEY = 'friday.ui-left-collapsed';
const RIGHT_DRAWER_STORAGE_KEY = 'friday.ui-right-collapsed';
const THEME_CHANNEL_NAME = 'friday.ui-theme';
const THEME_CHANGE_EVENT = 'friday:themechange';

const LEFT_OPEN_LABEL = '◧ 任务舱';
const LEFT_COLLAPSED_LABEL = '◨ 任务舱';
const RIGHT_OPEN_LABEL = '执行链路 ◨';
const RIGHT_COLLAPSED_LABEL = '执行链路 ◧';
const THEME_COLOR_MEDIA_QUERIES = [
  '(prefers-color-scheme: light)',
  '(prefers-color-scheme: dark)',
] as const;

const themeListeners = new Set<(theme: UiTheme) => void>();
const boundThemeButtons = new Map<HTMLButtonElement, UiTheme>();
const wiredButtons = new WeakSet<HTMLButtonElement>();

let channel: BroadcastChannel | undefined;
let boundWindow: (Window & typeof globalThis) | undefined;
let boundRightBtn: HTMLButtonElement | null = null;
let lastWriteSucceeded = true;
let themeTransitionTimer: ReturnType<typeof setTimeout> | undefined;
let chromeSyncRaf: number | undefined;

function getThemeMetaColors(theme: UiTheme): { scheme: 'light' | 'dark'; themeColor: string } {
  return theme === 'industrial'
    ? { scheme: 'light', themeColor: '#f7f4ed' }
    : { scheme: 'dark', themeColor: '#111520' };
}

function syncMetaTag(name: string, content: string, replaceNode: boolean): void {
  if (typeof document === 'undefined') return;
  const existing = typeof document.querySelector === 'function'
    ? document.querySelector(`meta[name="${name}"]`)
    : null;
  if (existing) {
    if (replaceNode && existing.parentNode && typeof document.createElement === 'function') {
      const fresh = document.createElement('meta');
      fresh.setAttribute('name', name);
      fresh.setAttribute('content', content);
      if (typeof existing.replaceWith === 'function') {
        existing.replaceWith(fresh);
      } else {
        existing.parentNode.insertBefore(fresh, existing);
        existing.remove();
      }
      return;
    }
    existing.setAttribute('content', content);
    return;
  }
  if (document.head && typeof document.createElement === 'function') {
    const fresh = document.createElement('meta');
    fresh.setAttribute('name', name);
    fresh.setAttribute('content', content);
    document.head.appendChild(fresh);
  }
}

function appendThemeColorMeta(themeColor: string, media?: string): void {
  if (!document.head || typeof document.createElement !== 'function') return;
  const fresh = document.createElement('meta');
  fresh.setAttribute('name', 'theme-color');
  if (media) fresh.setAttribute('media', media);
  fresh.setAttribute('content', themeColor);
  document.head.appendChild(fresh);
}

function syncThemeColorMetas(themeColor: string, replaceNode: boolean): void {
  if (typeof document === 'undefined') return;
  let existingList: Element[] = [];
  if (typeof document.querySelectorAll === 'function') {
    existingList = Array.from(document.querySelectorAll('meta[name="theme-color"]'));
  } else if (typeof document.querySelector === 'function') {
    const single = document.querySelector('meta[name="theme-color"]');
    if (single) existingList = [single];
  }

  if (existingList.length > 0) {
    const seenMedia = new Set<string>();
    let hasAttached = false;
    for (const existing of existingList) {
      const media = existing.getAttribute?.('media') ?? undefined;
      if (media) seenMedia.add(media);
      existing.setAttribute('content', themeColor);
      if (existing.parentNode) {
        hasAttached = true;
        if (replaceNode && typeof document.createElement === 'function') {
          const fresh = document.createElement('meta');
          fresh.setAttribute('name', 'theme-color');
          if (media) fresh.setAttribute('media', media);
          fresh.setAttribute('content', themeColor);
          existing.parentNode.insertBefore(fresh, existing);
          existing.remove();
        }
      }
    }
    if (hasAttached && seenMedia.size > 0) {
      for (const mq of THEME_COLOR_MEDIA_QUERIES) {
        if (!seenMedia.has(mq)) {
          appendThemeColorMeta(themeColor, mq);
        }
      }
    }
    return;
  }

  for (const mq of THEME_COLOR_MEDIA_QUERIES) {
    appendThemeColorMeta(themeColor, mq);
  }
}

export function syncThemeChrome(theme: UiTheme = getUiTheme()): void {
  const { scheme, themeColor } = getThemeMetaColors(theme);
  syncMetaTag('color-scheme', scheme, false);
  syncThemeColorMetas(themeColor, true);
}

function triggerThemeTransition(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root?.classList) return;
  root.classList.add('theme-transitioning');
  if (themeTransitionTimer !== undefined) {
    clearTimeout(themeTransitionTimer);
  }
  themeTransitionTimer = setTimeout(() => {
    themeTransitionTimer = undefined;
    root.classList.remove('theme-transitioning');
  }, 460);
  (themeTransitionTimer as { unref?: () => void }).unref?.();
}

function normalizeTheme(value: unknown): UiTheme {
  return value === 'industrial' ? 'industrial' : 'spatial';
}

function tryReadStorage(key: string): { ok: boolean; value: string | null } {
  try {
    if (typeof localStorage === 'undefined') return { ok: false, value: null };
    return { ok: true, value: localStorage.getItem(key) };
  } catch {
    return { ok: false, value: null };
  }
}

function writeStorage(key: string, value: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function readInitialTheme(): UiTheme {
  const stored = tryReadStorage(THEME_STORAGE_KEY);
  if (stored.ok && (stored.value === 'spatial' || stored.value === 'industrial')) {
    return stored.value;
  }
  if (typeof document !== 'undefined') {
    const attr = document.documentElement?.dataset?.theme;
    if (attr === 'spatial' || attr === 'industrial') return attr;
  }
  return 'spatial';
}

let currentTheme: UiTheme = readInitialTheme();

function syncThemeButtons(theme: UiTheme): void {
  for (const [btn, targetTheme] of boundThemeButtons) {
    const active = targetTheme === theme;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
}

function applyThemeToDom(theme: UiTheme): void {
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (root) {
      if (root.dataset) root.dataset.theme = theme;
      else if (typeof root.setAttribute === 'function') root.setAttribute('data-theme', theme);
    }
    syncThemeChrome(theme);
    if (typeof requestAnimationFrame === 'function') {
      if (chromeSyncRaf !== undefined && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(chromeSyncRaf);
      }
      chromeSyncRaf = requestAnimationFrame(() => {
        chromeSyncRaf = undefined;
        if (currentTheme === theme) {
          syncThemeColorMetas(getThemeMetaColors(theme).themeColor, true);
        }
      });
    }
  }
  syncThemeButtons(theme);
}

function notifyThemeChange(theme: UiTheme): void {
  for (const listener of themeListeners) {
    try {
      listener(theme);
    } catch {
      // Isolate listener errors so one subscriber never breaks theme updates.
    }
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent<{ theme: UiTheme }>(THEME_CHANGE_EVENT, { detail: { theme } }));
  }
}

function handleExternalThemeUpdate(rawTheme: unknown): void {
  const next = normalizeTheme(rawTheme);
  if (next === currentTheme) {
    applyThemeToDom(next);
    return;
  }
  triggerThemeTransition();
  currentTheme = next;
  applyThemeToDom(next);
  notifyThemeChange(next);
}

function ensureCrossTabSync(): void {
  if (!channel && typeof BroadcastChannel === 'function') {
    try {
      const bc = new BroadcastChannel(THEME_CHANNEL_NAME);
      const unref = (bc as unknown as { unref?: () => void }).unref;
      if (typeof unref === 'function') unref.call(bc);
      bc.onmessage = (event: MessageEvent) => {
        const data = event?.data as unknown;
        const rawTheme = typeof data === 'string'
          ? data
          : (data && typeof data === 'object' ? (data as { theme?: unknown }).theme : undefined);
        if (rawTheme === 'spatial' || rawTheme === 'industrial') {
          handleExternalThemeUpdate(rawTheme);
        }
      };
      channel = bc;
    } catch {
      // Ignore BroadcastChannel failures in restricted environments.
    }
  }

  if (typeof window !== 'undefined' && boundWindow !== window && typeof window.addEventListener === 'function') {
    boundWindow = window;
    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) {
        handleExternalThemeUpdate(event.newValue);
      } else if (event.key === null) {
        const stored = tryReadStorage(THEME_STORAGE_KEY);
        handleExternalThemeUpdate(stored.ok ? stored.value : 'spatial');
      }
    });
    window.addEventListener('pageshow', () => {
      syncThemeChrome();
    });
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) syncThemeChrome();
      });
    }
    if (typeof window.matchMedia === 'function') {
      try {
        const mql = window.matchMedia('(prefers-color-scheme: dark)');
        if (mql && typeof mql.addEventListener === 'function') {
          mql.addEventListener('change', () => {
            syncThemeChrome();
          });
        }
      } catch {
        // Ignore matchMedia listener errors in restricted environments.
      }
    }
  }
}

export function getUiTheme(): UiTheme {
  const stored = tryReadStorage(THEME_STORAGE_KEY);
  if (stored.ok) {
    if (stored.value === 'spatial' || stored.value === 'industrial') {
      currentTheme = stored.value;
      return stored.value;
    }
    if (lastWriteSucceeded) {
      currentTheme = 'spatial';
      return 'spatial';
    }
  }
  return currentTheme;
}

export function setUiTheme(next: UiTheme): UiTheme {
  ensureCrossTabSync();
  const theme = normalizeTheme(next);
  const prev = getUiTheme();
  if (prev !== theme) {
    triggerThemeTransition();
  }
  currentTheme = theme;
  lastWriteSucceeded = writeStorage(THEME_STORAGE_KEY, theme);
  applyThemeToDom(theme);
  if (channel) {
    try {
      channel.postMessage({ theme });
    } catch {
      // Ignore channel errors if closed or unavailable.
    }
  }
  if (prev !== theme) {
    notifyThemeChange(theme);
  }
  return theme;
}

export function onUiThemeChange(listener: (theme: UiTheme) => void): () => void {
  ensureCrossTabSync();
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

export function bindThemeButtons(
  spatialBtn: HTMLButtonElement | null,
  industrialBtn: HTMLButtonElement | null,
): void {
  ensureCrossTabSync();
  const pairs: Array<[HTMLButtonElement | null, UiTheme]> = [
    [spatialBtn, 'spatial'],
    [industrialBtn, 'industrial'],
  ];
  for (const [btn, targetTheme] of pairs) {
    if (!btn) continue;
    boundThemeButtons.set(btn, targetTheme);
    if (!wiredButtons.has(btn)) {
      wiredButtons.add(btn);
      btn.addEventListener('click', () => {
        setUiTheme(targetTheme);
      });
    }
  }
  const active = getUiTheme();
  currentTheme = active;
  applyThemeToDom(active);
}

function readDrawerState(key: string): boolean {
  const stored = tryReadStorage(key);
  return stored.ok && (stored.value === 'true' || stored.value === '1');
}

function applyDrawerState(
  side: 'left' | 'right',
  btn: HTMLButtonElement | null,
  collapsed: boolean,
): void {
  const className = side === 'left' ? 'desktop-left-collapsed' : 'desktop-right-collapsed';
  if (typeof document !== 'undefined') {
    document.body?.classList.toggle(className, collapsed);
  }
  if (btn) {
    btn.setAttribute('aria-pressed', String(collapsed));
    btn.textContent = side === 'left'
      ? (collapsed ? LEFT_COLLAPSED_LABEL : LEFT_OPEN_LABEL)
      : (collapsed ? RIGHT_COLLAPSED_LABEL : RIGHT_OPEN_LABEL);
  }
}

export function initDesktopDrawers(options: {
  leftBtn?: HTMLButtonElement | null;
  rightBtn?: HTMLButtonElement | null;
}): void {
  const leftBtn = options?.leftBtn ?? null;
  const rightBtn = options?.rightBtn ?? null;
  boundRightBtn = rightBtn;

  let leftCollapsed = readDrawerState(LEFT_DRAWER_STORAGE_KEY);
  let rightCollapsed = readDrawerState(RIGHT_DRAWER_STORAGE_KEY);

  applyDrawerState('left', leftBtn, leftCollapsed);
  applyDrawerState('right', rightBtn, rightCollapsed);

  if (leftBtn && !wiredButtons.has(leftBtn)) {
    wiredButtons.add(leftBtn);
    leftBtn.addEventListener('click', () => {
      const current = typeof document !== 'undefined' && document.body?.classList
        ? document.body.classList.contains('desktop-left-collapsed')
        : leftCollapsed;
      leftCollapsed = !current;
      writeStorage(LEFT_DRAWER_STORAGE_KEY, String(leftCollapsed));
      applyDrawerState('left', leftBtn, leftCollapsed);
    });
  }

  if (rightBtn && !wiredButtons.has(rightBtn)) {
    wiredButtons.add(rightBtn);
    rightBtn.addEventListener('click', () => {
      const current = typeof document !== 'undefined' && document.body?.classList
        ? document.body.classList.contains('desktop-right-collapsed')
        : rightCollapsed;
      rightCollapsed = !current;
      writeStorage(RIGHT_DRAWER_STORAGE_KEY, String(rightCollapsed));
      applyDrawerState('right', rightBtn, rightCollapsed);
    });
  }
}

export function ensureRightDrawerOpen(): void {
  const collapsed = typeof document !== 'undefined' && document.body?.classList
    ? document.body.classList.contains('desktop-right-collapsed')
    : readDrawerState(RIGHT_DRAWER_STORAGE_KEY);
  if (!collapsed) return;
  writeStorage(RIGHT_DRAWER_STORAGE_KEY, 'false');
  const rightBtn = boundRightBtn
    ?? (typeof document !== 'undefined' && typeof document.getElementById === 'function'
      ? document.getElementById('desktop-trace-fold') as HTMLButtonElement | null
      : null);
  applyDrawerState('right', rightBtn, false);
}

export function collapseRightDrawer(): void {
  const collapsed = typeof document !== 'undefined' && document.body?.classList
    ? document.body.classList.contains('desktop-right-collapsed')
    : readDrawerState(RIGHT_DRAWER_STORAGE_KEY);
  if (collapsed) return;
  writeStorage(RIGHT_DRAWER_STORAGE_KEY, 'true');
  const rightBtn = boundRightBtn
    ?? (typeof document !== 'undefined' && typeof document.getElementById === 'function'
      ? document.getElementById('desktop-trace-fold') as HTMLButtonElement | null
      : null);
  applyDrawerState('right', rightBtn, true);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  ensureCrossTabSync();
  applyThemeToDom(getUiTheme());
}

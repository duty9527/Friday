export type UiTheme = 'spatial' | 'industrial';
export type ThemePreference = 'system' | UiTheme;

const THEME_STORAGE_KEY = 'friday.ui-theme';
const LEFT_DRAWER_STORAGE_KEY = 'friday.ui-left-collapsed';
const RIGHT_DRAWER_STORAGE_KEY = 'friday.ui-right-collapsed';
const THEME_CHANNEL_NAME = 'friday.ui-theme';
const THEME_CHANGE_EVENT = 'friday:themechange';

const LEFT_OPEN_LABEL = '◧ 任务舱';
const LEFT_COLLAPSED_LABEL = '◨ 任务舱';
const RIGHT_OPEN_LABEL = '执行链路 ◨';
const RIGHT_COLLAPSED_LABEL = '执行链路 ◧';

const themeListeners = new Set<(theme: UiTheme) => void>();
const boundThemeButtons = new Map<HTMLButtonElement, ThemePreference>();
const wiredButtons = new WeakSet<HTMLButtonElement>();

let channel: BroadcastChannel | undefined;
let boundWindow: (Window & typeof globalThis) | undefined;
let boundRightBtn: HTMLButtonElement | null = null;
let lastWriteSucceeded = true;
let themeTransitionTimer: ReturnType<typeof setTimeout> | undefined;

function prefersLightScheme(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return Boolean(window.matchMedia('(prefers-color-scheme: light)')?.matches);
  } catch {
    return false;
  }
}

function getThemeMetaColors(theme: UiTheme, pref: ThemePreference = getUiThemePreference()): {
  scheme: 'light dark' | 'light' | 'dark';
  themeColor: string;
} {
  const themeColor = theme === 'industrial' ? '#f7f4ed' : '#111520';
  const scheme = pref === 'system'
    ? 'light dark'
    : (theme === 'industrial' ? 'light' : 'dark');
  return { scheme, themeColor };
}

function syncMetaTagInPlace(name: string, content: string): void {
  if (typeof document === 'undefined') return;
  let existingList: Element[] = [];
  if (typeof document.querySelectorAll === 'function') {
    existingList = Array.from(document.querySelectorAll(`meta[name="${name}"]`));
  }
  if (existingList.length === 0 && typeof document.querySelector === 'function') {
    const single = document.querySelector(`meta[name="${name}"]`);
    if (single) existingList = [single];
  }

  const primary = existingList[0];
  if (primary) {
    primary.setAttribute('content', content);
    if (name === 'theme-color') primary.removeAttribute?.('media');
    for (let i = 1; i < existingList.length; i++) {
      existingList[i]?.remove?.();
    }
    return;
  }

  if (document.head && typeof document.createElement === 'function') {
    const fresh = document.createElement('meta');
    fresh.setAttribute('name', name);
    fresh.setAttribute('content', content);
    document.head.appendChild(fresh);
  }
}

export function syncThemeChrome(theme: UiTheme = getUiTheme(), pref: ThemePreference = getUiThemePreference()): void {
  const { scheme, themeColor } = getThemeMetaColors(theme, pref);
  syncMetaTagInPlace('color-scheme', scheme);
  syncMetaTagInPlace('theme-color', themeColor);
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

function normalizePreference(value: unknown): ThemePreference {
  if (value === 'industrial' || value === 'spatial' || value === 'system') return value;
  return 'system';
}

function resolveThemeFromPreference(pref: ThemePreference): UiTheme {
  if (pref === 'system') return prefersLightScheme() ? 'industrial' : 'spatial';
  return pref;
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

function removeStorage(key: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function readInitialPreference(): ThemePreference {
  const stored = tryReadStorage(THEME_STORAGE_KEY);
  if (stored.ok) {
    if (stored.value === 'spatial' || stored.value === 'industrial') return stored.value;
    return 'system';
  }
  if (typeof document !== 'undefined') {
    const prefAttr = document.documentElement?.dataset?.themePref;
    if (prefAttr === 'spatial' || prefAttr === 'industrial' || prefAttr === 'system') return prefAttr;
    const themeAttr = document.documentElement?.dataset?.theme;
    if (themeAttr === 'spatial' || themeAttr === 'industrial') return themeAttr;
  }
  return 'system';
}

let currentPreference: ThemePreference = readInitialPreference();
let currentTheme: UiTheme = resolveThemeFromPreference(currentPreference);

function syncThemeButtons(theme: UiTheme, pref: ThemePreference): void {
  let hasSystemButton = false;
  for (const targetPref of boundThemeButtons.values()) {
    if (targetPref === 'system') {
      hasSystemButton = true;
      break;
    }
  }
  for (const [btn, targetPref] of boundThemeButtons) {
    const active = hasSystemButton
      ? targetPref === pref
      : targetPref === theme;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
}

function applyThemeToDom(theme: UiTheme, pref: ThemePreference): void {
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (root) {
      if (root.dataset) {
        root.dataset.theme = theme;
        root.dataset.themePref = pref;
      } else if (typeof root.setAttribute === 'function') {
        root.setAttribute('data-theme', theme);
        root.setAttribute('data-theme-pref', pref);
      }
    }
    syncThemeChrome(theme, pref);
  }
  syncThemeButtons(theme, pref);
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

function handleExternalThemeUpdate(rawPreference: unknown): void {
  const nextPref = normalizePreference(rawPreference);
  const nextTheme = resolveThemeFromPreference(nextPref);
  const themeChanged = nextTheme !== currentTheme;
  if (themeChanged) triggerThemeTransition();
  currentPreference = nextPref;
  currentTheme = nextTheme;
  applyThemeToDom(nextTheme, nextPref);
  if (themeChanged) notifyThemeChange(nextTheme);
}

function ensureCrossTabSync(): void {
  if (!channel && typeof BroadcastChannel === 'function') {
    try {
      const bc = new BroadcastChannel(THEME_CHANNEL_NAME);
      const unref = (bc as unknown as { unref?: () => void }).unref;
      if (typeof unref === 'function') unref.call(bc);
      bc.onmessage = (event: MessageEvent) => {
        const data = event?.data as unknown;
        const rawPref = typeof data === 'string'
          ? data
          : (data && typeof data === 'object'
              ? ((data as { preference?: unknown; theme?: unknown }).preference ?? (data as { theme?: unknown }).theme)
              : undefined);
        if (rawPref === 'system' || rawPref === 'spatial' || rawPref === 'industrial') {
          handleExternalThemeUpdate(rawPref);
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
        handleExternalThemeUpdate(event.newValue ?? 'system');
      } else if (event.key === null) {
        const stored = tryReadStorage(THEME_STORAGE_KEY);
        handleExternalThemeUpdate(stored.ok ? (stored.value ?? 'system') : 'system');
      }
    });
    window.addEventListener('pageshow', () => {
      syncThemeChrome(currentTheme, currentPreference);
    });
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) syncThemeChrome(currentTheme, currentPreference);
      });
    }
    if (typeof window.matchMedia === 'function') {
      try {
        const mql = window.matchMedia('(prefers-color-scheme: light)');
        if (mql && typeof mql.addEventListener === 'function') {
          mql.addEventListener('change', () => {
            const pref = getUiThemePreference();
            if (pref === 'system') {
              const resolved = resolveThemeFromPreference('system');
              const changed = resolved !== currentTheme;
              if (changed) triggerThemeTransition();
              currentTheme = resolved;
              applyThemeToDom(resolved, pref);
              if (changed) notifyThemeChange(resolved);
            } else {
              syncThemeChrome(currentTheme, pref);
            }
          });
        }
      } catch {
        // Ignore matchMedia listener errors in restricted environments.
      }
    }
  }
}

export function getUiThemePreference(): ThemePreference {
  const stored = tryReadStorage(THEME_STORAGE_KEY);
  if (stored.ok) {
    if (stored.value === 'spatial' || stored.value === 'industrial') {
      currentPreference = stored.value;
      return stored.value;
    }
    if (lastWriteSucceeded) {
      currentPreference = 'system';
      return 'system';
    }
  }
  return currentPreference;
}

export function getUiTheme(): UiTheme {
  const resolved = resolveThemeFromPreference(getUiThemePreference());
  currentTheme = resolved;
  return resolved;
}

export function setUiTheme(next: ThemePreference): UiTheme {
  ensureCrossTabSync();
  const pref = normalizePreference(next);
  const prevTheme = getUiTheme();
  const resolved = resolveThemeFromPreference(pref);
  if (prevTheme !== resolved) {
    triggerThemeTransition();
  }
  currentPreference = pref;
  currentTheme = resolved;
  lastWriteSucceeded = pref === 'system'
    ? removeStorage(THEME_STORAGE_KEY)
    : writeStorage(THEME_STORAGE_KEY, pref);
  applyThemeToDom(resolved, pref);
  if (channel) {
    try {
      channel.postMessage({ preference: pref, theme: resolved });
    } catch {
      // Ignore channel errors if closed or unavailable.
    }
  }
  if (prevTheme !== resolved) {
    notifyThemeChange(resolved);
  }
  return resolved;
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
  systemBtn: HTMLButtonElement | null = null,
): void {
  ensureCrossTabSync();
  const fallbackSystemId = spatialBtn?.id === 'mm-theme-spatial' ? 'mm-theme-system' : 'theme-system-btn';
  const resolvedSystemBtn = systemBtn
    ?? (typeof document !== 'undefined' && typeof document.getElementById === 'function'
      ? (document.getElementById(fallbackSystemId) as HTMLButtonElement | null)
      : null);
  const pairs: Array<[HTMLButtonElement | null, ThemePreference]> = [
    [resolvedSystemBtn, 'system'],
    [spatialBtn, 'spatial'],
    [industrialBtn, 'industrial'],
  ];
  for (const [btn, targetPref] of pairs) {
    if (!btn) continue;
    boundThemeButtons.set(btn, targetPref);
    if (!wiredButtons.has(btn)) {
      wiredButtons.add(btn);
      btn.addEventListener('click', () => {
        setUiTheme(targetPref);
      });
    }
  }
  const pref = getUiThemePreference();
  const active = resolveThemeFromPreference(pref);
  currentPreference = pref;
  currentTheme = active;
  applyThemeToDom(active, pref);
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
  const pref = getUiThemePreference();
  applyThemeToDom(resolveThemeFromPreference(pref), pref);
}

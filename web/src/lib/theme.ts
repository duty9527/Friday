import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark';
export type ThemePreference = 'system' | ThemeMode;

const THEME_STORAGE_KEY = 'friday.ui-theme';
const THEME_CHANNEL_NAME = 'friday.ui-theme';

function prefersLightScheme(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    return false;
  }
}

export function normalizeThemePreference(raw: string | null | undefined): ThemePreference {
  if (raw === 'light' || raw === 'industrial') return 'light';
  if (raw === 'dark' || raw === 'spatial') return 'dark';
  return 'system';
}

export function resolveThemeMode(pref: ThemePreference): ThemeMode {
  if (pref === 'light' || pref === 'dark') return pref;
  return prefersLightScheme() ? 'light' : 'dark';
}

export function readStoredThemePreference(): ThemePreference {
  try {
    return normalizeThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

function syncMetaTag(name: string, content: string): void {
  if (typeof document === 'undefined') return;
  const existing = Array.from(document.querySelectorAll(`meta[name="${name}"]`));
  const primary = existing[0];
  if (primary) {
    primary.setAttribute('content', content);
    if (name === 'theme-color') primary.removeAttribute('media');
    for (let i = 1; i < existing.length; i++) existing[i]?.remove();
    return;
  }
  if (document.head) {
    const meta = document.createElement('meta');
    meta.setAttribute('name', name);
    meta.setAttribute('content', content);
    document.head.appendChild(meta);
  }
}

export function applyThemeToDocument(pref: ThemePreference): ThemeMode {
  const mode = resolveThemeMode(pref);
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.classList.toggle('dark', mode === 'dark');
    root.dataset.theme = mode;
    root.dataset.themePref = pref;
    syncMetaTag('color-scheme', pref === 'system' ? 'light dark' : mode);
    syncMetaTag('theme-color', mode === 'light' ? '#ffffff' : '#0a0a0a');
  }
  return mode;
}

export function useTheme(): {
  theme: ThemeMode;
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
} {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredThemePreference());
  const [theme, setTheme] = useState<ThemeMode>(() => applyThemeToDocument(readStoredThemePreference()));

  const applyAndStore = useCallback((next: ThemePreference, broadcast: boolean) => {
    setPreferenceState(next);
    const mode = applyThemeToDocument(next);
    setTheme(mode);
    if (broadcast) {
      try {
        if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
        else localStorage.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // Ignore storage errors
      }
      try {
        if (typeof BroadcastChannel === 'function') {
          const ch = new BroadcastChannel(THEME_CHANNEL_NAME);
          ch.postMessage({ pref: next });
          ch.close();
        }
      } catch {
        // Ignore BroadcastChannel errors
      }
    }
  }, []);

  useEffect(() => {
    setTheme(applyThemeToDocument(preference));
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const onSchemeChange = () => {
      setTheme(applyThemeToDocument(readStoredThemePreference()));
    };
    mql.addEventListener?.('change', onSchemeChange);

    let channel: BroadcastChannel | undefined;
    try {
      if (typeof BroadcastChannel === 'function') {
        channel = new BroadcastChannel(THEME_CHANNEL_NAME);
        channel.addEventListener('message', (event: MessageEvent<{ pref?: string }>) => {
          applyAndStore(normalizeThemePreference(event.data?.pref), false);
        });
      }
    } catch {
      // Ignore
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY) {
        applyAndStore(normalizeThemePreference(event.newValue), false);
      }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      mql.removeEventListener?.('change', onSchemeChange);
      channel?.close();
      window.removeEventListener('storage', onStorage);
    };
  }, [preference, applyAndStore]);

  const setPreference = useCallback((next: ThemePreference) => {
    applyAndStore(next, true);
  }, [applyAndStore]);

  return { theme, preference, setPreference };
}

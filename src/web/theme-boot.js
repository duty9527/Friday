(() => {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('friday.ui-theme') : null;
    const root = document.documentElement;
    const prefersLight = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;

    let pref = 'system';
    if (saved === 'light' || saved === 'industrial') pref = 'light';
    else if (saved === 'dark' || saved === 'spatial') pref = 'dark';
    const mode = pref === 'system' ? (prefersLight ? 'light' : 'dark') : pref;
    const scheme = pref === 'system' ? 'light dark' : mode;
    const color = mode === 'light' ? '#ffffff' : '#0a0a0a';

    if (root) {
      root.classList.toggle('dark', mode === 'dark');
      if (root.dataset) {
        root.dataset.theme = mode;
        root.dataset.themePref = pref;
      }
    }

    const cs = document.querySelector('meta[name="color-scheme"]');
    if (cs) cs.setAttribute('content', scheme);
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', color);
  } catch {
    // Ignore storage or DOM restrictions during pre-paint bootstrap.
  }
})();

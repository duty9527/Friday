(() => {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('friday.ui-theme') : null;
    const root = document.documentElement;
    const isCoss = Boolean(root && root.dataset && root.dataset.app === 'coss');
    const prefersLight = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;

    let scheme = 'dark light';
    let color = '#111520';

    if (isCoss) {
      let pref = 'system';
      if (saved === 'light' || saved === 'industrial') pref = 'light';
      else if (saved === 'dark' || saved === 'spatial') pref = 'dark';
      const mode = pref === 'system' ? (prefersLight ? 'light' : 'dark') : pref;
      scheme = pref === 'system' ? 'light dark' : mode;
      color = mode === 'light' ? '#ffffff' : '#0a0a0a';
      root.classList.toggle('dark', mode === 'dark');
      root.dataset.theme = mode;
      root.dataset.themePref = pref;
    } else {
      let explicit = null;
      if (saved === 'industrial' || saved === 'light') explicit = 'industrial';
      else if (saved === 'spatial' || saved === 'dark') explicit = 'spatial';
      const theme = explicit ?? (prefersLight ? 'industrial' : 'spatial');
      scheme = explicit ? (theme === 'industrial' ? 'light' : 'dark') : 'dark light';
      color = theme === 'industrial' ? '#f7f4ed' : '#111520';
      if (root) {
        if (root.dataset) root.dataset.theme = theme;
        else if (typeof root.setAttribute === 'function') root.setAttribute('data-theme', theme);
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

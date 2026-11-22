(() => {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('friday.ui-theme') : null;
    const explicit = saved === 'industrial' || saved === 'spatial' ? saved : null;
    const prefersLight = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;
    const theme = explicit ?? (prefersLight ? 'industrial' : 'spatial');
    const scheme = explicit ? (theme === 'industrial' ? 'light' : 'dark') : 'dark light';
    const color = theme === 'industrial' ? '#f7f4ed' : '#111520';
    const root = document.documentElement;
    if (root) {
      if (root.dataset) root.dataset.theme = theme;
      else if (typeof root.setAttribute === 'function') root.setAttribute('data-theme', theme);
    }
    const cs = document.querySelector('meta[name="color-scheme"]');
    if (cs) cs.setAttribute('content', scheme);
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', color);
  } catch {
    // Ignore storage or DOM restrictions during pre-paint bootstrap.
  }
})();

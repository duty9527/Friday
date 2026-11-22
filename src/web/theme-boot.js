(() => {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('friday.ui-theme') : null;
    const industrial = saved === 'industrial';
    const theme = industrial ? 'industrial' : 'spatial';
    const scheme = industrial ? 'light' : 'dark';
    const color = industrial ? '#f7f4ed' : '#111520';
    const root = document.documentElement;
    if (root) {
      if (root.dataset) root.dataset.theme = theme;
      else if (typeof root.setAttribute === 'function') root.setAttribute('data-theme', theme);
    }
    const cs = document.querySelector('meta[name="color-scheme"]');
    if (cs) cs.setAttribute('content', scheme);
    const metas = document.querySelectorAll('meta[name="theme-color"]');
    for (let i = 0; i < metas.length; i++) {
      metas[i].setAttribute('content', color);
    }
  } catch {
    // Ignore storage or DOM restrictions during pre-paint bootstrap.
  }
})();

export interface MobileViewportMetrics {
  standalone: boolean;
  iosStandalone?: boolean;
  narrowMobile: boolean;
  keyboardOpen: boolean;
  screenWidth: number;
  screenHeight: number;
  layoutWidth: number;
  layoutHeight: number;
  safeTop: number;
  safeBottom: number;
}

export interface MobileViewportController {
  sync: () => void;
  dispose: () => void;
}

const PROBE_ID = 'safe-area-probe';
const MOBILE_MEDIA_QUERY = '(max-width: 730px)';
const STANDALONE_MEDIA_QUERY = '(display-mode: standalone)';
const CLIPPED_CLASS = 'ios-standalone-clipped';
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isEditableTextElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') {
    const textarea = el as HTMLTextAreaElement;
    return !textarea.readOnly && !textarea.disabled;
  }
  if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    if (input.readOnly || input.disabled) return false;
    const rawType = input.type || input.getAttribute?.('type') || 'text';
    return !NON_TEXT_INPUT_TYPES.has(String(rawType).toLowerCase());
  }
  const contentEditable = el.getAttribute?.('contenteditable');
  return contentEditable === '' || contentEditable === 'true' || (el as HTMLElement).isContentEditable === true;
}

export function isIosStandaloneClipped(metrics: MobileViewportMetrics): boolean {
  const iosStandalone = metrics.iosStandalone ?? metrics.standalone;
  if (!iosStandalone || !metrics.narrowMobile || metrics.keyboardOpen) {
    return false;
  }
  const { screenWidth, screenHeight, layoutWidth, layoutHeight, safeTop, safeBottom } = metrics;
  if (
    !isFinitePositive(screenWidth)
    || !isFinitePositive(screenHeight)
    || !isFinitePositive(layoutWidth)
    || !isFinitePositive(layoutHeight)
    || !Number.isFinite(safeTop)
    || !Number.isFinite(safeBottom)
  ) {
    return false;
  }

  const portrait = layoutWidth <= layoutHeight;
  const expectedW = portrait ? Math.min(screenWidth, screenHeight) : Math.max(screenWidth, screenHeight);
  const expectedH = portrait ? Math.max(screenWidth, screenHeight) : Math.min(screenWidth, screenHeight);

  if (Math.abs(expectedW - layoutWidth) > 16) {
    return false;
  }

  const shortfall = expectedH - layoutHeight;
  if (shortfall < 40 || shortfall > 120) {
    return false;
  }

  return safeTop >= 16 && Math.abs(shortfall - safeTop) <= 16;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

export function initMobileViewport(): MobileViewportController {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { sync: () => {}, dispose: () => {} };
  }

  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const cleanups: Array<() => void> = [];
  let rafId: number | undefined;
  let disposed = false;

  const ensureProbe = (): HTMLElement | null => {
    let probe = typeof document.getElementById === 'function'
      ? document.getElementById(PROBE_ID)
      : null;
    if (!probe && typeof document.createElement === 'function') {
      probe = document.createElement('div');
      probe.id = PROBE_ID;
    }
    if (!probe) return null;
    probe.classList?.add('safe-area-probe');
    probe.setAttribute?.('aria-hidden', 'true');
    if (!probe.parentElement && document.body?.appendChild) {
      document.body.appendChild(probe);
    }
    return probe;
  };

  const isNarrowMobile = (layoutW: number): boolean => {
    if (typeof window.matchMedia === 'function') {
      try {
        return Boolean(window.matchMedia(MOBILE_MEDIA_QUERY)?.matches);
      } catch {
        // Ignore matchMedia failures in minimal environments.
      }
    }
    return layoutW > 0 && layoutW <= 730;
  };

  const isIosStandalone = (): boolean => {
    const nav = typeof navigator !== 'undefined'
      ? (navigator as Navigator & { standalone?: boolean })
      : undefined;
    return nav?.standalone === true;
  };

  const isStandalone = (): boolean => {
    if (isIosStandalone()) return true;
    if (typeof window.matchMedia === 'function') {
      try {
        return Boolean(window.matchMedia(STANDALONE_MEDIA_QUERY)?.matches);
      } catch {
        // Ignore matchMedia failures in minimal environments.
      }
    }
    return false;
  };

  const readSafeInsets = (probe: HTMLElement | null): { safeTop: number; safeBottom: number } => {
    if (!probe || typeof window.getComputedStyle !== 'function') {
      return { safeTop: 0, safeBottom: 0 };
    }
    try {
      const cs = window.getComputedStyle(probe);
      return {
        safeTop: Number.parseFloat(cs.paddingTop || '0') || 0,
        safeBottom: Number.parseFloat(cs.paddingBottom || '0') || 0,
      };
    } catch {
      return { safeTop: 0, safeBottom: 0 };
    }
  };

  const resetScrollIfNeeded = (narrowMobile: boolean): void => {
    if (!narrowMobile || typeof window.scrollTo !== 'function') return;
    if (isEditableTextElement(document.activeElement)) return;
    if ((window.scrollY || 0) !== 0 || (window.scrollX || 0) !== 0) {
      window.scrollTo(0, 0);
    }
  };

  const scheduleSync = (): void => {
    if (disposed) return;
    if (typeof requestAnimationFrame !== 'function') {
      sync();
      return;
    }
    if (rafId !== undefined) return;
    rafId = requestAnimationFrame(() => {
      rafId = undefined;
      sync();
    });
  };

  const sync = (): void => {
    if (disposed) return;
    const root = document.documentElement;
    if (!root?.classList) return;

    const layoutW = isFinitePositive(window.innerWidth)
      ? window.innerWidth
      : (root.clientWidth || 0);
    const narrowMobile = isNarrowMobile(layoutW);
    if (!narrowMobile) {
      root.classList.toggle('mobile-keyboard-open', false);
      root.classList.toggle(CLIPPED_CLASS, false);
      return;
    }

    const iosStandalone = isIosStandalone();
    let safeTop = 0;
    let safeBottom = 0;
    if (iosStandalone) {
      const probe = ensureProbe();
      ({ safeTop, safeBottom } = readSafeInsets(probe));
    }

    const layoutH = isFinitePositive(window.innerHeight)
      ? window.innerHeight
      : (root.clientHeight || 0);
    const screenW = window.screen && isFinitePositive(window.screen.width)
      ? window.screen.width
      : 0;
    const screenH = window.screen && isFinitePositive(window.screen.height)
      ? window.screen.height
      : 0;

    const standalone = iosStandalone || isStandalone();

    const vv = window.visualViewport;
    const vvH = vv && isFinitePositive(vv.height) ? vv.height : layoutH;

    const portrait = layoutW <= layoutH;
    const expectedW = (isFinitePositive(screenW) && isFinitePositive(screenH))
      ? (portrait ? Math.min(screenW, screenH) : Math.max(screenW, screenH))
      : 0;
    const expectedH = (isFinitePositive(screenW) && isFinitePositive(screenH))
      ? (portrait ? Math.max(screenW, screenH) : Math.min(screenW, screenH))
      : 0;
    const fullWidthMobile = expectedW > 0 && layoutW > 0 && Math.abs(expectedW - layoutW) <= 16;

    const keyboardOpen = narrowMobile
      && isEditableTextElement(document.activeElement)
      && (
        (layoutH > 0 && vvH > 0 && layoutH - vvH >= 110)
        || (
          fullWidthMobile
          && expectedH > 0
          && ((vvH > 0 && expectedH - vvH >= 180) || (layoutH > 0 && expectedH - layoutH >= 160))
        )
      );

    const clipped = isIosStandaloneClipped({
      standalone,
      iosStandalone,
      narrowMobile,
      keyboardOpen,
      screenWidth: screenW,
      screenHeight: screenH,
      layoutWidth: layoutW,
      layoutHeight: layoutH,
      safeTop,
      safeBottom,
    });

    root.classList.toggle('mobile-keyboard-open', keyboardOpen);
    root.classList.toggle(CLIPPED_CLASS, clipped);
  };

  const scheduleDelayedSync = (delayMs: number, resetScroll = false): void => {
    if (disposed) return;
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      if (disposed) return;
      if (resetScroll) {
        const layoutW = isFinitePositive(window.innerWidth)
          ? window.innerWidth
          : (document.documentElement?.clientWidth || 0);
        resetScrollIfNeeded(isNarrowMobile(layoutW));
      }
      sync();
    }, delayMs);
    pendingTimers.add(timer);
    unrefTimer(timer);
  };

  const listen = (
    target: {
      addEventListener?: (type: string, fn: () => void, opts?: boolean | AddEventListenerOptions) => void;
      removeEventListener?: (type: string, fn: () => void) => void;
    } | null | undefined,
    type: string,
    handler: () => void,
    opts?: boolean | AddEventListenerOptions,
  ): void => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, opts);
    cleanups.push(() => {
      target.removeEventListener?.(type, handler);
    });
  };

  listen(window, 'resize', scheduleSync, { passive: true });
  listen(window, 'orientationchange', () => {
    scheduleSync();
    scheduleDelayedSync(120);
  }, { passive: true });
  listen(window, 'pageshow', scheduleSync, { passive: true });

  listen(document, 'visibilitychange', () => {
    if (!document.hidden) scheduleSync();
  });
  listen(document, 'focusin', () => {
    sync();
    scheduleDelayedSync(60);
  });
  listen(document, 'focusout', () => {
    scheduleDelayedSync(60, true);
  });

  if (window.visualViewport) {
    listen(window.visualViewport, 'resize', scheduleSync, { passive: true });
  }

  sync();
  scheduleSync();
  scheduleDelayedSync(120);
  scheduleDelayedSync(450);

  const dispose = (): void => {
    disposed = true;
    for (const timer of pendingTimers) {
      clearTimeout(timer);
    }
    pendingTimers.clear();
    if (rafId !== undefined && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafId);
      rafId = undefined;
    }
    for (const fn of cleanups.splice(0)) {
      fn();
    }
  };

  return { sync, dispose };
}

/**
 * Shared modern Web Platform UI, accessibility, scheduling, and form primitives
 * for F.R.I.D.A.Y. Web Console (`strict: true`, ES2023 NodeNext, FakeDOM-safe).
 */

export interface ConfirmActionOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface PromptInputOptions {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface CopyFeedbackOptions {
  statusEl?: HTMLElement | null;
  successLabel?: string;
  failLabel?: string;
  defaultLabel?: string;
}

export interface RovingTablistOptions {
  onActivate?: (tab: HTMLElement) => void;
  signal?: AbortSignal;
}

interface DialogElementLike extends HTMLElement {
  open?: boolean;
  returnValue?: string;
  showModal?: () => void;
  close?: (returnValue?: string) => void;
}

interface SchedulerLike {
  yield?: () => Promise<void>;
  postTask?: (callback: () => void, options?: { priority?: 'user-blocking' | 'user-visible' | 'background'; signal?: AbortSignal }) => Promise<unknown>;
}

interface AriaNotifyDocument {
  ariaNotify?: (message: string, options?: { priority?: 'high' | 'normal' }) => void;
}

interface LegacyMediaQueryList {
  addListener?: (cb: (e: MediaQueryListEvent) => void) => void;
  removeListener?: (cb: (e: MediaQueryListEvent) => void) => void;
}

interface ValidatableField extends HTMLElement {
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  validity?: { valid: boolean };
  labels?: ArrayLike<HTMLElement> | null;
  checkValidity?: () => boolean;
}

interface DialogTriggerRecord {
  trigger: HTMLElement | null;
  explicit: boolean;
}

const dialogTriggerMap = new WeakMap<HTMLElement, DialogTriggerRecord>();
const dialogFakeCloseCallbacks = new WeakMap<HTMLElement, Set<() => void>>();
const copyFeedbackTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();
const tablistAbortMap = new WeakMap<HTMLElement, AbortController>();
const tablistActivateMap = new WeakMap<HTMLElement, ((tab: HTMLElement) => void) | undefined>();

let lastStatusAnnouncement = '';
let lastCopyAnnouncement = '';
let confirmQueue: Promise<unknown> = Promise.resolve();

function hasDomDocument(): boolean {
  return typeof document !== 'undefined' && document !== null;
}

function isHtmlElement(node: unknown): node is HTMLElement {
  if (!node || typeof node !== 'object') return false;
  if (typeof HTMLElement !== 'undefined') return node instanceof HTMLElement;
  return 'focus' in node && typeof (node as { focus?: unknown }).focus === 'function';
}

function toggleAttr(el: HTMLElement, name: string, present: boolean, value = ''): void {
  if (present) el.setAttribute?.(name, value);
  else el.removeAttribute?.(name);
}

function addDomListener(
  target: EventTarget,
  type: string,
  handler: EventListener,
  signal?: AbortSignal,
  extra?: { passive?: boolean; capture?: boolean },
): void {
  if (signal?.aborted) return;
  if (signal || extra?.passive !== undefined || extra?.capture !== undefined) {
    const opts: AddEventListenerOptions = {};
    if (signal) opts.signal = signal;
    if (extra?.passive !== undefined) opts.passive = extra.passive;
    if (extra?.capture !== undefined) opts.capture = extra.capture;
    target.addEventListener(type, handler, opts);
  } else {
    target.addEventListener(type, handler);
  }
}

function getRecordedActiveTrigger(): HTMLElement | null {
  if (!hasDomDocument()) return null;
  const active = document.activeElement;
  if (!isHtmlElement(active)) return null;
  if (typeof document.body !== 'undefined' && active === document.body) return null;
  return active;
}

function restoreDialogFocus(dialog: HTMLElement): void {
  const record = dialogTriggerMap.get(dialog);
  dialogTriggerMap.delete(dialog);
  if (!record?.trigger) return;
  if ('isConnected' in record.trigger && record.trigger.isConnected === false) return;
  if (record.explicit) {
    safeFocus(record.trigger);
    return;
  }
  if (!hasDomDocument()) {
    safeFocus(record.trigger);
    return;
  }
  const active = document.activeElement;
  if (!active || (typeof document.body !== 'undefined' && active === document.body) || dialog.contains?.(active)) {
    safeFocus(record.trigger);
  }
}

/**
 * Focuses a target element safely in both real DOM browsers and Node FakeDOM environments.
 */
export function safeFocus(el: HTMLElement | null | undefined, opts?: FocusOptions): void {
  if (!el || typeof el.focus !== 'function') return;
  if ((el as { hidden?: unknown }).hidden === true) return;
  try {
    if (opts) el.focus(opts);
    else el.focus();
  } catch {
    try {
      el.focus();
    } catch {
      // Ignore focus failures in stub environments
    }
  }
}

/**
 * Returns true when a native `<dialog>` or FakeDOM dialog stub is currently open.
 */
export function isDialogOpen(dialog: HTMLElement | null): boolean {
  if (!dialog) return false;
  const dlg = dialog as DialogElementLike;
  const hasNativeShowModal = typeof dlg.showModal === 'function';
  if (hasNativeShowModal) {
    return dlg.open === true || dialog.hasAttribute?.('open') === true;
  }
  if ((dlg as { hidden?: unknown }).hidden === true && dlg.open !== true) {
    return false;
  }
  return dlg.open === true || dialog.hasAttribute?.('open') === true;
}

/**
 * Opens a modal `<dialog>` using `showModal()` (with FakeDOM fallback) and tracks its return-focus trigger.
 */
export function openModalDialog(dialog: HTMLElement | null, trigger?: HTMLElement | null): void {
  if (!dialog) return;
  const dlg = dialog as DialogElementLike;
  const explicitTrigger = trigger !== undefined ? trigger : undefined;
  const resolvedTrigger = explicitTrigger !== undefined ? explicitTrigger : getRecordedActiveTrigger();
  dialogTriggerMap.set(dialog, {
    trigger: resolvedTrigger ?? null,
    explicit: explicitTrigger !== undefined && explicitTrigger !== null,
  });

  dialog.removeAttribute?.('hidden');
  if (typeof dlg.showModal === 'function') {
    (dialog as { hidden?: boolean }).hidden = false;
    if (!isDialogOpen(dialog)) {
      try {
        dlg.showModal();
      } catch {
        dlg.open = true;
        dialog.setAttribute?.('open', '');
      }
    }
    return;
  }

  dlg.open = true;
  dialog.setAttribute?.('open', '');
  (dialog as { hidden?: boolean }).hidden = false;
}

/**
 * Closes a modal `<dialog>` cleanly (with FakeDOM fallback) and restores focus if needed.
 */
export function closeModalDialog(dialog: HTMLElement | null): void {
  if (!dialog) return;
  const dlg = dialog as DialogElementLike;
  if (typeof dlg.close === 'function') {
    if (isDialogOpen(dialog)) {
      try {
        dlg.close();
      } catch {
        dlg.open = false;
        dialog.removeAttribute?.('open');
      }
    }
    restoreDialogFocus(dialog);
    return;
  }

  const wasOpen = isDialogOpen(dialog);
  dlg.open = false;
  dialog.removeAttribute?.('open');
  (dialog as { hidden?: boolean }).hidden = true;
  if (wasOpen) {
    if (typeof Event === 'function' && typeof dialog.dispatchEvent === 'function') {
      dialog.dispatchEvent(new Event('close'));
    } else {
      restoreDialogFocus(dialog);
      const callbacks = dialogFakeCloseCallbacks.get(dialog);
      if (callbacks) {
        for (const cb of [...callbacks]) cb();
      }
    }
  } else {
    restoreDialogFocus(dialog);
  }
}

/**
 * Binds `close` synchronization, trigger focus restoration, and Safari `<dialog closedby="any">`
 * outside-rect `pointerdown`+`pointerup` light-dismiss fallback.
 */
export function bindDialogLightDismiss(
  dialog: HTMLElement | null,
  onClose?: () => void,
  signal?: AbortSignal,
): void {
  if (!dialog || signal?.aborted) return;

  const handleClose = () => {
    restoreDialogFocus(dialog);
    onClose?.();
  };

  addDomListener(dialog, 'close', handleClose, signal);

  if (typeof (dialog as DialogElementLike).close !== 'function' && typeof dialog.dispatchEvent !== 'function') {
    let callbacks = dialogFakeCloseCallbacks.get(dialog);
    if (!callbacks) {
      callbacks = new Set();
      dialogFakeCloseCallbacks.set(dialog, callbacks);
    }
    callbacks.add(handleClose);
    signal?.addEventListener('abort', () => {
      callbacks?.delete(handleClose);
    }, { once: true });
  }

  const supportsClosedBy = typeof HTMLDialogElement !== 'undefined' && 'closedBy' in HTMLDialogElement.prototype;
  if (!supportsClosedBy) {
    let pressedOutside = false;
    const isOutside = (e: Event): boolean => {
      if (typeof dialog.getBoundingClientRect !== 'function') return false;
      const pe = e as PointerEvent;
      if (!Number.isFinite(pe.clientX) || !Number.isFinite(pe.clientY)) return false;
      const rect = dialog.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return pe.clientX < rect.left || pe.clientX > rect.right || pe.clientY < rect.top || pe.clientY > rect.bottom;
    };

    addDomListener(dialog, 'pointerdown', (e) => {
      if (!isDialogOpen(dialog) || dialog.getAttribute?.('closedby') !== 'any') {
        pressedOutside = false;
        return;
      }
      pressedOutside = isOutside(e);
    }, signal);

    addDomListener(dialog, 'pointerup', (e) => {
      const shouldDismiss =
        pressedOutside
        && isDialogOpen(dialog)
        && dialog.getAttribute?.('closedby') === 'any'
        && isOutside(e);
      pressedOutside = false;
      if (shouldDismiss) closeModalDialog(dialog);
    }, signal);

    addDomListener(dialog, 'pointercancel', () => {
      pressedOutside = false;
    }, signal);
  }
}

function enqueueSharedDialog<T>(task: () => Promise<T>): Promise<T> {
  const next = confirmQueue.then(task, task);
  confirmQueue = next.then(() => undefined, () => undefined);
  return next;
}

function runSharedConfirmOrPrompt(
  mode: 'confirm' | 'prompt',
  opts: ConfirmActionOptions | PromptInputOptions,
): Promise<{ confirmed: boolean; value: string }> {
  return enqueueSharedDialog(() => new Promise(resolve => {
    if (!hasDomDocument()) {
      resolve({ confirmed: false, value: '' });
      return;
    }
    const dialog = document.getElementById('app-confirm-dialog');
    if (!dialog) {
      resolve({ confirmed: false, value: '' });
      return;
    }

    const dlg = dialog as DialogElementLike;
    const titleEl = dialog.querySelector?.('#app-confirm-title') ?? document.getElementById('app-confirm-title');
    const messageEl = dialog.querySelector?.('#app-confirm-message') ?? document.getElementById('app-confirm-message');
    const inputWrapEl = dialog.querySelector?.('#app-confirm-input-wrap') ?? document.getElementById('app-confirm-input-wrap');
    const inputEl = (dialog.querySelector?.('#app-confirm-input') ?? document.getElementById('app-confirm-input')) as HTMLInputElement | null;
    const formEl = dialog.querySelector?.('form') ?? null;
    const closeBtn = dialog.querySelector?.('#app-confirm-close-btn') as HTMLButtonElement | null ?? null;
    const cancelBtn = dialog.querySelector?.('button[value="cancel"]') as HTMLButtonElement | null ?? null;
    const confirmBtn = dialog.querySelector?.('button[value="confirm"]') as HTMLButtonElement | null ?? null;

    if (titleEl) titleEl.textContent = opts.title;
    if (messageEl) {
      const msg = opts.message ?? '';
      messageEl.textContent = msg;
      (messageEl as HTMLElement).hidden = !msg;
    }

    const isPrompt = mode === 'prompt';
    const promptOpts = opts as PromptInputOptions;
    const confirmOpts = opts as ConfirmActionOptions;
    const isDanger = !isPrompt && Boolean(confirmOpts.danger);

    if (inputWrapEl) (inputWrapEl as HTMLElement).hidden = !isPrompt;
    if (inputEl) {
      inputEl.value = isPrompt ? (promptOpts.defaultValue ?? '') : '';
      inputEl.placeholder = isPrompt ? (promptOpts.placeholder ?? '') : '';
      inputEl.required = false;
      toggleAttr(inputEl, 'autofocus', isPrompt);
    }

    if (cancelBtn) {
      cancelBtn.textContent = opts.cancelLabel ?? '取消';
      toggleAttr(cancelBtn, 'autofocus', isDanger);
    }
    if (confirmBtn) {
      confirmBtn.textContent = opts.confirmLabel ?? (isDanger ? '确认删除' : '确定');
      toggleAttr(confirmBtn, 'autofocus', !isPrompt && !isDanger);
      if (confirmBtn.classList) {
        if (isDanger) {
          confirmBtn.classList.add('btn-danger');
          confirmBtn.classList.remove('btn-primary');
        } else {
          confirmBtn.classList.remove('btn-danger');
          confirmBtn.classList.add('btn-primary');
        }
      }
    }
    toggleAttr(dialog, 'data-danger', isDanger);
    dlg.returnValue = '';

    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const signal = ac?.signal;
    let settled = false;

    const finish = (explicitOutcome?: 'confirm' | 'cancel') => {
      if (settled) return;
      settled = true;
      const rawRv = explicitOutcome ?? dlg.returnValue ?? '';
      dlg.returnValue = '';
      ac?.abort();
      const confirmed = rawRv === 'confirm';
      const val = inputEl ? inputEl.value : '';
      if (inputEl) inputEl.value = '';
      resolve({ confirmed, value: confirmed ? val : '' });
    };

    bindDialogLightDismiss(dialog, () => finish(), signal);

    if (closeBtn) {
      addDomListener(closeBtn, 'click', () => {
        dlg.returnValue = 'cancel';
        closeModalDialog(dialog);
      }, signal);
    }
    if (cancelBtn) {
      addDomListener(cancelBtn, 'click', () => {
        dlg.returnValue = 'cancel';
        if (typeof dlg.close !== 'function') closeModalDialog(dialog);
      }, signal);
    }
    if (confirmBtn) {
      addDomListener(confirmBtn, 'click', () => {
        dlg.returnValue = 'confirm';
        if (typeof dlg.close !== 'function') closeModalDialog(dialog);
      }, signal);
    }
    if (formEl) {
      addDomListener(formEl, 'submit', (e) => {
        if (typeof dlg.close !== 'function') {
          e.preventDefault?.();
          closeModalDialog(dialog);
        }
      }, signal);
    }
    if (isPrompt && inputEl) {
      addDomListener(inputEl, 'keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.key !== 'Enter') return;
        if (isImeComposing(ke)) return;
        ke.preventDefault?.();
        dlg.returnValue = 'confirm';
        closeModalDialog(dialog);
      }, signal);
    }

    const activeTrigger = getRecordedActiveTrigger();
    openModalDialog(dialog, activeTrigger);

    if (isPrompt && inputEl) {
      safeFocus(inputEl);
      try {
        inputEl.select?.();
      } catch {
        // Ignore select errors in stub environments
      }
    } else if (isDanger && cancelBtn) {
      safeFocus(cancelBtn);
    } else if (confirmBtn) {
      safeFocus(confirmBtn);
    }
  }));
}

/**
 * Displays a modal confirmation dialog using `#app-confirm-dialog`, placing `autofocus` on Cancel
 * when `danger` is true and failing closed (`false`) if the dialog is unavailable.
 */
export async function confirmAction(opts: ConfirmActionOptions): Promise<boolean> {
  const result = await runSharedConfirmOrPrompt('confirm', opts);
  return result.confirmed;
}

/**
 * Displays a modal text-input prompt dialog using `#app-confirm-dialog`, returning the entered
 * string on confirmation or `null` when dismissed/cancelled.
 */
export async function promptInput(opts: PromptInputOptions): Promise<string | null> {
  const result = await runSharedConfirmOrPrompt('prompt', opts);
  return result.confirmed ? result.value : null;
}

/**
 * Announces status updates via persistent `#sr-status-live` / `#sr-alert-live` regions
 * (with VoiceOver `\u00A0` deduplication) and `document.ariaNotify` when supported.
 */
export function announceStatus(text: string, priority: 'polite' | 'assertive' = 'polite'): void {
  const normalized = text.trim();
  if (!normalized || !hasDomDocument()) return;

  let deduped = normalized;
  if (deduped === lastStatusAnnouncement) deduped += '\u00A0';
  lastStatusAnnouncement = deduped;

  const targetId = priority === 'assertive' ? 'sr-alert-live' : 'sr-status-live';
  const liveEl = document.getElementById?.(targetId)
    ?? (priority === 'assertive' ? document.getElementById?.('sr-status-live') : null);
  if (liveEl) {
    liveEl.textContent = deduped;
  }

  const docNotify = (document as unknown as AriaNotifyDocument).ariaNotify;
  if (typeof docNotify === 'function') {
    try {
      docNotify.call(document, normalized, { priority: priority === 'assertive' ? 'high' : 'normal' });
    } catch {
      // Ignore experimental API option mismatches
    }
  }
}

/**
 * Returns true when an Enter keydown belongs to an active CJK IME composition session,
 * pairing `event.isComposing` with Safari WebKit bug 165004 `keyCode === 229` fallback.
 */
export function isImeComposing(event: KeyboardEvent): boolean {
  return Boolean(event.isComposing || event.keyCode === 229);
}

function legacyExecCommandCopy(text: string): boolean {
  if (!hasDomDocument() || typeof document.createElement !== 'function') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.className = 'visually-hidden';
  textarea.setAttribute?.('readonly', '');
  textarea.setAttribute?.('aria-hidden', 'true');
  textarea.tabIndex = -1;
  const prevFocus = getRecordedActiveTrigger();
  const host = document.body ?? document.documentElement;
  if (!host?.appendChild) return false;
  host.appendChild(textarea);
  try {
    textarea.focus?.({ preventScroll: true });
    textarea.select?.();
    const exec = (document as unknown as { execCommand?: (cmd: string) => boolean }).execCommand;
    return typeof exec === 'function' ? Boolean(exec.call(document, 'copy')) : false;
  } catch {
    return false;
  } finally {
    textarea.remove?.();
    if (prevFocus && prevFocus !== document.activeElement) {
      safeFocus(prevFocus, { preventScroll: true });
    }
  }
}

/**
 * Copies text with Async Clipboard API (falling back to temporary `<textarea>` + `execCommand('copy')`
 * only when `navigator.clipboard` is missing or rejected on non-HTTPS LAN), resetting overlapping
 * timers via `WeakMap` and updating external `statusEl` without clobbering the button's accessible name.
 */
export async function copyTextWithFeedback(
  button: HTMLButtonElement,
  text: string,
  opts?: CopyFeedbackOptions,
): Promise<boolean> {
  if (!text) return false;
  let ok = false;
  const writeText = typeof navigator !== 'undefined' ? navigator.clipboard?.writeText : undefined;
  if (typeof writeText === 'function') {
    try {
      await writeText.call(navigator.clipboard, text);
      ok = true;
    } catch {
      ok = legacyExecCommandCopy(text);
    }
  } else {
    ok = legacyExecCommandCopy(text);
  }

  const prevTimer = copyFeedbackTimers.get(button);
  if (prevTimer !== undefined) clearTimeout(prevTimer);

  button.removeAttribute?.('data-copied');
  button.removeAttribute?.('data-failed');
  if ('offsetWidth' in button) void (button as HTMLElement).offsetWidth;

  button.setAttribute?.(ok ? 'data-copied' : 'data-failed', '');
  if (button.classList) {
    if (ok) button.classList.add('is-copied');
    else button.classList.remove('is-copied');
  }

  const rawStatus = ok ? (opts?.successLabel ?? '已复制') : (opts?.failLabel ?? '复制失败');
  if (opts?.defaultLabel !== undefined && (ok ? opts.successLabel !== undefined : opts.failLabel !== undefined)) {
    button.textContent = rawStatus;
  }

  let dedupedStatus = rawStatus.trim() || (ok ? '已复制' : '复制失败');
  if (dedupedStatus === lastCopyAnnouncement) dedupedStatus += '\u00A0';
  lastCopyAnnouncement = dedupedStatus;

  const statusEl = opts?.statusEl;
  const statusHasLiveRegion = Boolean(
    statusEl
    && (statusEl.getAttribute?.('role') === 'status' || statusEl.hasAttribute?.('aria-live')),
  );
  if (statusEl && statusEl !== button && !button.contains?.(statusEl)) {
    statusEl.textContent = dedupedStatus;
  }
  if (!statusHasLiveRegion) {
    announceStatus(rawStatus, ok ? 'polite' : 'assertive');
  }

  const timer = setTimeout(() => {
    copyFeedbackTimers.delete(button);
    button.removeAttribute?.('data-copied');
    button.removeAttribute?.('data-failed');
    button.classList?.remove('is-copied');
    if (opts?.defaultLabel !== undefined) {
      button.textContent = opts.defaultLabel;
    }
    if (statusEl && statusEl !== button && !button.contains?.(statusEl)) {
      statusEl.textContent = '';
    }
  }, 1500);
  copyFeedbackTimers.set(button, timer);

  return ok;
}

function getTablistTabs(tablist: HTMLElement): HTMLElement[] {
  const fromQuery = tablist.querySelectorAll?.('[role="tab"]');
  const rawList: Element[] = fromQuery && fromQuery.length > 0
    ? Array.from(fromQuery)
    : Array.from(tablist.children ?? []).filter(el => el.tagName === 'BUTTON' || el.getAttribute?.('role') === 'tab');

  return rawList.filter((el): el is HTMLElement => {
    const disabled = (el as { disabled?: unknown }).disabled === true
      || el.hasAttribute?.('disabled') === true
      || el.getAttribute?.('aria-disabled') === 'true'
      || (el as { hidden?: unknown }).hidden === true
      || el.hasAttribute?.('hidden') === true;
    return !disabled;
  });
}

function resolveTabContainerElement(tablist: HTMLElement, target: EventTarget | null): HTMLElement | null {
  let cursor = target as HTMLElement | null;
  while (cursor && cursor !== tablist) {
    if (cursor.getAttribute?.('role') === 'tab' || cursor.tagName === 'BUTTON') {
      return cursor;
    }
    cursor = cursor.parentElement;
  }
  return null;
}

/**
 * Synchronizes `aria-selected`, `focusgroupstart`, and fallback roving `tabindex` across a tablist's tabs.
 */
export function syncRovingTablist(tablist: HTMLElement, activeTab?: HTMLElement): void {
  const tabs = getTablistTabs(tablist);
  if (!tabs.length) return;
  const active = activeTab && tabs.includes(activeTab)
    ? activeTab
    : (tabs.find(t => t.getAttribute?.('aria-selected') === 'true' || t.hasAttribute?.('focusgroupstart')) ?? tabs[0]!);
  const hasNativeFocusGroup = typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'focusGroup');

  for (const tab of tabs) {
    const selected = tab === active;
    tab.setAttribute?.('aria-selected', String(selected));
    toggleAttr(tab, 'focusgroupstart', selected);
    if (!hasNativeFocusGroup) {
      tab.setAttribute?.('tabindex', selected ? '0' : '-1');
    }
  }
}

/**
 * Binds accessible roving-tabindex / arrow-key navigation (when native `focusgroup` is absent),
 * keeps `focusgroupstart` + `aria-selected` synchronized, and listens for `beforematch` on
 * `hidden="until-found"` tab panels.
 */
export function bindRovingTablist(tablist: HTMLElement, opts?: RovingTablistOptions): void {
  if (!tablist || opts?.signal?.aborted) return;

  tablistAbortMap.get(tablist)?.abort();
  const internalAc = typeof AbortController !== 'undefined' ? new AbortController() : null;
  if (internalAc) tablistAbortMap.set(tablist, internalAc);
  tablistActivateMap.set(tablist, opts?.onActivate);

  let signal: AbortSignal | undefined = opts?.signal;
  if (internalAc) {
    if (opts?.signal) {
      opts.signal.addEventListener('abort', () => internalAc.abort(), { once: true });
    }
    signal = internalAc.signal;
  }

  syncRovingTablist(tablist);

  const hasNativeFocusGroup = typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'focusGroup');
  let pointerClicking = false;

  const activateTab = (tab: HTMLElement, scrollIntoView = true) => {
    syncRovingTablist(tablist, tab);
    if (scrollIntoView && typeof tab.scrollIntoView === 'function') {
      try {
        tab.scrollIntoView({ block: 'nearest', inline: 'nearest', container: 'nearest' } as ScrollIntoViewOptions);
      } catch {
        try {
          tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch {
          // Ignore scroll failures in minimal stubs
        }
      }
    }
    tablistActivateMap.get(tablist)?.(tab);
  };

  addDomListener(tablist, 'pointerdown', () => {
    pointerClicking = true;
    queueMicrotask(() => { pointerClicking = false; });
  }, signal);

  addDomListener(tablist, 'pointercancel', () => {
    pointerClicking = false;
  }, signal);

  addDomListener(tablist, 'click', (e) => {
    pointerClicking = false;
    const tabs = getTablistTabs(tablist);
    const tab = resolveTabContainerElement(tablist, e.target);
    if (!tab || !tabs.includes(tab)) return;
    activateTab(tab, true);
  }, signal);

  addDomListener(tablist, 'focusin', (e) => {
    if (pointerClicking) return;
    const tabs = getTablistTabs(tablist);
    const tab = resolveTabContainerElement(tablist, e.target);
    if (!tab || !tabs.includes(tab)) return;
    if (tab.getAttribute?.('aria-selected') !== 'true') {
      activateTab(tab, true);
    }
  }, signal);

  if (!hasNativeFocusGroup) {
    addDomListener(tablist, 'keydown', (e) => {
      const ke = e as KeyboardEvent;
      const tabs = getTablistTabs(tablist);
      if (!tabs.length) return;
      const current = resolveTabContainerElement(tablist, ke.target)
        ?? (hasDomDocument() ? resolveTabContainerElement(tablist, document.activeElement) : null);
      const currentIdx = current ? tabs.indexOf(current) : -1;
      if (currentIdx === -1) return;

      const isVertical = tablist.getAttribute?.('aria-orientation') === 'vertical';
      const prevKey = isVertical ? 'ArrowUp' : 'ArrowLeft';
      const nextKey = isVertical ? 'ArrowDown' : 'ArrowRight';

      let targetIdx = -1;
      if (ke.key === nextKey) targetIdx = (currentIdx + 1) % tabs.length;
      else if (ke.key === prevKey) targetIdx = (currentIdx - 1 + tabs.length) % tabs.length;
      else if (ke.key === 'Home') targetIdx = 0;
      else if (ke.key === 'End') targetIdx = tabs.length - 1;
      else return;

      const targetTab = tabs[targetIdx];
      if (!targetTab) return;
      ke.preventDefault?.();
      safeFocus(targetTab);
      activateTab(targetTab, true);
    }, signal);
  }

  const panelScope: EventTarget | null = hasDomDocument()
    ? (tablist.closest?.('.model-modal-body, .tabs, .hub-stage, .plugin-stage') ?? tablist.parentElement ?? document)
    : tablist.parentElement;

  if (panelScope) {
    addDomListener(panelScope, 'beforematch', (e) => {
      let panel = e.target as HTMLElement | null;
      if (panel && typeof panel.closest === 'function') {
        panel = panel.closest('[role="tabpanel"][aria-labelledby]') ?? panel;
      }
      const labelledBy = panel?.getAttribute?.('aria-labelledby');
      if (!labelledBy) return;
      const tabs = getTablistTabs(tablist);
      const matchedTab = tabs.find(t => t.id === labelledBy);
      if (!matchedTab) return;
      activateTab(matchedTab, true);
    }, signal);
  }
}

/**
 * Atomically relocates a connected DOM node using `Element.prototype.moveBefore` when available
 * (preserving focus, CSS animations, and media state) with `insertBefore` fallback.
 */
export function moveElementPreservingState(
  parent: Element,
  node: Element,
  referenceNode: Node | null,
): void {
  const parentWithMove = parent as Element & {
    moveBefore?: (node: Node, child: Node | null) => void;
  };
  if (
    typeof Element !== 'undefined'
    && 'moveBefore' in Element.prototype
    && typeof parentWithMove.moveBefore === 'function'
    && node.isConnected
    && parent.isConnected
  ) {
    try {
      parentWithMove.moveBefore(node, referenceNode);
      return;
    } catch {
      // Fallback to standard insertion if cross-root or unattached
    }
  }
  parent.insertBefore(node, referenceNode);
}

/**
 * Yields control to the browser main thread using `scheduler.yield()` when supported,
 * falling back to `setTimeout(..., 0)` in Safari and Node runtimes.
 */
export function yieldToMain(): Promise<void> {
  const sched = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  if (sched && typeof sched.yield === 'function') {
    return sched.yield();
  }
  return new Promise<void>(resolve => setTimeout(resolve, 0));
}

/**
 * Defers low-urgency background work using `scheduler.postTask(..., { priority: 'background' })`
 * when available, degrading gracefully to abort-aware `setTimeout(..., 0)`.
 */
export function scheduleBackgroundTask(fn: () => void, signal?: AbortSignal): void {
  if (signal?.aborted) return;
  const sched = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  if (sched && typeof sched.postTask === 'function') {
    sched.postTask(() => {
      if (!signal?.aborted) fn();
    }, { priority: 'background', ...(signal ? { signal } : {}) }).catch(() => {
      // Prevent unhandled rejection when task is cancelled by AbortSignal
    });
    return;
  }

  const timer = setTimeout(() => {
    if (!signal?.aborted) fn();
  }, 0);
  signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
}

/**
 * Invokes `cb` when scrolling rests using native `scrollend` when supported,
 * falling back to debounced passive `scroll` events elsewhere.
 */
export function onScrollEnd(
  el: EventTarget,
  cb: () => void,
  signal?: AbortSignal,
  debounceMs = 120,
): void {
  if (signal?.aborted) return;
  const supportsScrollEnd = 'onscrollend' in globalThis
    || (typeof HTMLElement !== 'undefined' && 'onscrollend' in HTMLElement.prototype);

  if (supportsScrollEnd) {
    addDomListener(el, 'scrollend', () => cb(), signal);
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  addDomListener(el, 'scroll', () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!signal?.aborted) cb();
    }, debounceMs);
  }, signal, { passive: true });

  signal?.addEventListener('abort', () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }, { once: true });
}

/**
 * Applies or clears the HTML `inert` state on a list of sibling/background containers cleanly.
 */
export function setInertElements(elements: Array<HTMLElement | null>, inert: boolean): void {
  for (const el of elements) {
    if (!el) continue;
    if ('inert' in el) {
      (el as HTMLElement & { inert: boolean }).inert = inert;
    }
    toggleAttr(el, 'inert', inert);
  }
}

/**
 * Returns true when the user agent prefers reduced motion (`(prefers-reduced-motion: reduce)`).
 */
export function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return Boolean(matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    return false;
  }
}

/**
 * Subscribes to live `(prefers-reduced-motion: reduce)` preference updates with `AbortSignal` cleanup.
 */
export function onReducedMotionChange(cb: (reduced: boolean) => void, signal?: AbortSignal): void {
  if (signal?.aborted || typeof matchMedia !== 'function') return;
  let mql: MediaQueryList;
  try {
    mql = matchMedia('(prefers-reduced-motion: reduce)');
  } catch {
    return;
  }

  const handler = (event?: MediaQueryListEvent) => {
    cb(Boolean(event ? event.matches : mql.matches));
  };

  if (typeof mql.addEventListener === 'function') {
    addDomListener(mql, 'change', handler as EventListener, signal);
    return;
  }

  const legacy = mql as unknown as LegacyMediaQueryList;
  if (typeof legacy.addListener === 'function') {
    legacy.addListener(handler);
    signal?.addEventListener('abort', () => legacy.removeListener?.(handler), { once: true });
  }
}

function isValidatableField(target: EventTarget | null): target is ValidatableField {
  if (!target || typeof target !== 'object') return false;
  const tag = (target as { tagName?: string }).tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

function getFormControls(form: HTMLFormElement): ValidatableField[] {
  const fromQuery = form.querySelectorAll?.('input, select, textarea');
  if (fromQuery) return Array.from(fromQuery).filter(isValidatableField);
  if (form.elements) return Array.from(form.elements).filter(isValidatableField);
  return [];
}

function isFieldValidNow(field: ValidatableField): boolean {
  if (field.disabled) return true;
  if (field.validity && typeof field.validity.valid === 'boolean') return field.validity.valid;
  if (typeof field.checkValidity === 'function') return field.checkValidity();
  if (field.hasAttribute?.('required')) {
    return Boolean(String(field.value ?? '').trim());
  }
  return true;
}

function syncFieldErrorLink(field: ValidatableField, shown: boolean): void {
  const errorId = field.getAttribute?.('data-error') ?? field.dataset?.error;
  if (!errorId) return;
  const existing = (field.getAttribute?.('aria-describedby') ?? '')
    .split(/\s+/)
    .filter(id => id && id !== errorId);
  if (shown) existing.push(errorId);
  if (existing.length > 0) {
    field.setAttribute?.('aria-describedby', existing.join(' '));
  } else {
    field.removeAttribute?.('aria-describedby');
  }
}

/**
 * Synchronizes `aria-invalid` and `data-error` `aria-describedby` links with user interaction
 * (`:user-invalid`, `blur`, `change`, `input`, `invalid`, `submit`, `reset`), starting at `"false"`
 * and moving focus to the first invalid control on failed form submission.
 */
export function attachDelayedFormValidation(form: HTMLFormElement, signal?: AbortSignal): void {
  if (!form || signal?.aborted) return;

  const interacted = new WeakSet<ValidatableField>();
  const flaggedByScript = new WeakSet<ValidatableField>();

  const syncField = (field: ValidatableField, mode: 'init' | 'blur' | 'change' | 'input' | 'submit' | 'reset'): boolean => {
    if (mode === 'reset') {
      interacted.delete(field);
      flaggedByScript.delete(field);
      field.setAttribute?.('aria-invalid', 'false');
      syncFieldErrorLink(field, false);
      return true;
    }

    const valid = isFieldValidNow(field);
    let matchesUserInvalid = false;
    try {
      matchesUserInvalid = typeof field.matches === 'function' ? field.matches(':user-invalid') : false;
    } catch {
      matchesUserInvalid = false;
    }

    const shouldMarkInvalid = !valid && (
      mode === 'submit'
      || matchesUserInvalid
      || ((mode === 'blur' || mode === 'change') && interacted.has(field))
    );

    if (shouldMarkInvalid) {
      field.setAttribute?.('aria-invalid', 'true');
      syncFieldErrorLink(field, true);
      flaggedByScript.add(field);
      return false;
    }

    if (valid || mode === 'init') {
      if (flaggedByScript.has(field) || field.getAttribute?.('aria-invalid') !== 'true') {
        field.setAttribute?.('aria-invalid', 'false');
        syncFieldErrorLink(field, false);
        flaggedByScript.delete(field);
      }
      return true;
    }

    return valid;
  };

  for (const field of getFormControls(form)) {
    syncField(field, 'init');
  }

  addDomListener(form, 'input', (e) => {
    if (!isValidatableField(e.target)) return;
    interacted.add(e.target);
    if (e.target.getAttribute?.('aria-invalid') === 'true' && isFieldValidNow(e.target)) {
      syncField(e.target, 'input');
    }
  }, signal);

  addDomListener(form, 'change', (e) => {
    if (!isValidatableField(e.target)) return;
    interacted.add(e.target);
    syncField(e.target, 'change');
  }, signal);

  addDomListener(form, 'blur', (e) => {
    if (!isValidatableField(e.target)) return;
    syncField(e.target, 'blur');
  }, signal, { capture: true });

  addDomListener(form, 'invalid', (e) => {
    if (!isValidatableField(e.target)) return;
    interacted.add(e.target);
    syncField(e.target, 'submit');
  }, signal, { capture: true });

  addDomListener(form, 'submit', (e) => {
    const controls = getFormControls(form);
    let firstInvalid: ValidatableField | null = null;
    for (const control of controls) {
      interacted.add(control);
      const ok = syncField(control, 'submit');
      if (!ok && !firstInvalid) firstInvalid = control;
    }
    if (firstInvalid) {
      e.preventDefault?.();
      safeFocus(firstInvalid);
      const errorId = firstInvalid.getAttribute?.('data-error') ?? firstInvalid.dataset?.error;
      const errorText = errorId && hasDomDocument()
        ? (document.getElementById?.(errorId)?.textContent ?? '').trim()
        : '';
      if (errorText) announceStatus(errorText, 'polite');
    }
  }, signal);

  addDomListener(form, 'reset', () => {
    setTimeout(() => {
      if (signal?.aborted) return;
      for (const field of getFormControls(form)) {
        syncField(field, 'reset');
      }
    }, 0);
  }, signal);
}

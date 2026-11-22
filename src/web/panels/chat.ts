import type { AttachmentView, ChatMessage, MessagePage, RouteAction, WorkView } from '../../view.js';
import {
  activeStatus as active,
  mergeMessages as mergeInto,
  orderConversation,
  routeLabel,
  routeState,
} from '../model.js';
import { ApiError } from '../shared/auth-http.js';
import {
  createLiveBotAvatar,
  createStaticBotSvg,
  type BotAvatarController,
  type BotStateId,
} from '../shared/bot-avatar.js';
import {
  BOT_EXPRESSIONS,
  BOT_EXPRESSION_META,
  inferMessageBotExpression,
} from '../shared/bot-expressions.js';
import {
  channelMeta,
  classifyRoutingDisplay,
  collectAvailableChannels,
  deriveCompanionStatus,
  extractLeadingQuote,
  filterConversationMessages,
  formatActionShortLabel,
  formatByteSize,
  formatShortClock,
  formatTimeDivider,
  isGroupedWithPrevious,
  resolveMessageChannel,
  shouldShowReplyReference,
  shouldShowTimeDivider,
  stripLeadingQuoteForPreview,
  summarizeSystemNotice,
  type ChatChannelFilter,
} from '../shared/chat-view.js';
import { button, element, node } from '../shared/dom.js';
import { errorText, formatNumber, makeRequestId, statusText, timestamp } from '../shared/format.js';
import { renderMarkdownContent, renderUserMessageContent, type MarkdownRenderOptions } from '../shared/markdown.js';
import {
  announceStatus,
  attachDelayedFormValidation,
  copyTextWithFeedback,
  isImeComposing,
  moveElementPreservingState,
  onScrollEnd,
  prefersReducedMotion,
  safeFocus,
} from '../shared/ui-primitives.js';
import { api, appState, fetchMessagesBatch, hooks } from '../state.js';

export interface ChatPanelController {
  updateComposer: () => void;
  mergeMessages: (items: ChatMessage[]) => void;
  hydrateParents: () => Promise<void>;
  renderMessages: () => void;
  renderRoutingDetail: () => void;
  jumpMessage: (id: string) => Promise<void>;
  isDraftTyping: () => boolean;
  updateCompanionStatus: (botState: BotStateId) => void;
  renderBossDecisionDock: () => void;
}

const STORAGE_KEY_CHANNEL = 'friday.chat-channel-filter';
const STORAGE_KEY_HIDE_SYSTEM = 'friday.chat-hide-system';
const STORAGE_KEY_DETAIL_MODE = 'friday.chat-detail-mode';
const LONG_MESSAGE_COLLAPSE_CHARS = 4800;
const AUTO_LOAD_OLDER_THRESHOLD_PX = 140;
const AUTO_LOAD_OLDER_COOLDOWN_MS = 350;
const PULL_TO_LOAD_MIN_DY_PX = 56;

function domSafeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function safeRemoveAttr(el: Element | null | undefined, name: string): void {
  if (!el) return;
  if (typeof el.removeAttribute === 'function') {
    el.removeAttribute(name);
    return;
  }
  (el as unknown as { attributes?: Map<string, string> }).attributes?.delete(name);
}

function safeHasAttr(el: Element | null | undefined, name: string): boolean {
  if (!el) return false;
  if (typeof el.hasAttribute === 'function') return el.hasAttribute(name);
  return el.getAttribute?.(name) !== null && el.getAttribute?.(name) !== undefined;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function readStoredString(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeStoredString(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Ignore storage write errors in private or sandboxed tabs.
  }
}

function normalizeStoredChannel(raw: string | null): ChatChannelFilter {
  if (raw === 'local' || raw === 'wechat' || raw === 'telegram' || raw === 'xiaoai' || raw === 'dingtalk') {
    return raw;
  }
  return 'all';
}

function createClipboardButton(
  label: string,
  getText: () => string,
  opts?: { className?: string; ariaLabel?: string; actionKey?: string },
): HTMLElement {
  const wrap = node('span', '', 'md-copy-wrap');
  const btn = node('button', label, opts?.className ?? 'mini-button copy-msg-btn msg-action-btn');
  btn.type = 'button';
  btn.title = '复制正文';
  btn.setAttribute('aria-label', opts?.ariaLabel ?? label);
  if (opts?.actionKey) btn.dataset.actionKey = opts.actionKey;
  const statusEl = node('span', '', 'md-copy-status visually-hidden');
  statusEl.setAttribute('role', 'status');
  btn.addEventListener('click', () => {
    void copyTextWithFeedback(btn, getText(), { statusEl });
  });
  wrap.append(btn, statusEl);
  return wrap;
}

function actionToneClass(action: RouteAction): string {
  if (action.status === 'failed' || action.status === 'interrupted' || action.delivery === 'failed') {
    return 'tone-err';
  }
  if (action.status === 'pending' || action.delivery === 'pending' || action.delivery === 'processing') {
    return 'tone-run';
  }
  return 'tone-ok';
}

interface IndexedQuoteCandidate {
  id: string;
  seq: number;
  role: ChatMessage['role'];
  clean: string;
}

interface QuoteLookupIndex {
  allDesc: IndexedQuoteCandidate[];
  byRoleDesc: Map<ChatMessage['role'], IndexedQuoteCandidate[]>;
  exactByClean: Map<string, IndexedQuoteCandidate[]>;
}

function buildQuoteLookupIndex(orderedAsc: readonly ChatMessage[]): QuoteLookupIndex {
  const allDesc: IndexedQuoteCandidate[] = [];
  const byRoleDesc = new Map<ChatMessage['role'], IndexedQuoteCandidate[]>();
  const exactByClean = new Map<string, IndexedQuoteCandidate[]>();

  for (let i = orderedAsc.length - 1; i >= 0; i--) {
    const cand = orderedAsc[i]!;
    if (cand.source === 'system') continue;
    const clean = singleLine(stripLeadingQuoteForPreview(cand.text));
    if (!clean) continue;
    const item: IndexedQuoteCandidate = { id: cand.id, seq: cand.seq, role: cand.role, clean };
    allDesc.push(item);

    let roleBucket = byRoleDesc.get(cand.role);
    if (!roleBucket) {
      roleBucket = [];
      byRoleDesc.set(cand.role, roleBucket);
    }
    roleBucket.push(item);

    let exactBucket = exactByClean.get(clean);
    if (!exactBucket) {
      exactBucket = [];
      exactByClean.set(clean, exactBucket);
    }
    exactBucket.push(item);
  }

  return { allDesc, byRoleDesc, exactByClean };
}

function firstEarlierIndexDesc(list: readonly IndexedQuoteCandidate[], currentSeq: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (list[mid]!.seq >= currentSeq) low = mid + 1;
    else high = mid;
  }
  return low;
}

function scanQuoteBucket(
  list: readonly IndexedQuoteCandidate[] | undefined,
  current: ChatMessage,
  needle: string,
  excludedRole?: ChatMessage['role'],
): string | undefined {
  if (!list || !list.length) return undefined;
  const start = firstEarlierIndexDesc(list, current.seq);
  for (let i = start; i < list.length; i++) {
    const cand = list[i]!;
    if (cand.id === current.id) continue;
    if (excludedRole && cand.role === excludedRole) continue;
    if (cand.clean === needle) return cand.id;
    if (needle.length >= 6 && (cand.clean.includes(needle) || needle.startsWith(cand.clean))) return cand.id;
  }
  return undefined;
}

function findQuotedJumpTargetId(
  current: ChatMessage,
  label: string,
  preview: string,
  index?: QuoteLookupIndex,
): string | undefined {
  const needle = singleLine(preview);
  if (!needle || needle.length < 2) return undefined;
  const preferredRole = label === '回复 F.R.I.D.A.Y.'
    ? 'assistant'
    : label === '回复你'
      ? 'user'
      : undefined;
  const lookup = index ?? buildQuoteLookupIndex(orderConversation(appState.messages.values()));

  if (needle.length < 6) {
    const exactList = lookup.exactByClean.get(needle);
    if (!exactList || !exactList.length) return undefined;
    const start = firstEarlierIndexDesc(exactList, current.seq);
    if (preferredRole) {
      for (let i = start; i < exactList.length; i++) {
        const cand = exactList[i]!;
        if (cand.id !== current.id && cand.role === preferredRole) return cand.id;
      }
    }
    for (let i = start; i < exactList.length; i++) {
      const cand = exactList[i]!;
      if (cand.id !== current.id) return cand.id;
    }
    return undefined;
  }

  if (preferredRole) {
    const preferredHit = scanQuoteBucket(lookup.byRoleDesc.get(preferredRole), current, needle);
    if (preferredHit) return preferredHit;
    return scanQuoteBucket(lookup.allDesc, current, needle, preferredRole);
  }
  return scanQuoteBucket(lookup.allDesc, current, needle);
}

function isMessageMatchedByTraceSelection(message: ChatMessage): boolean {
  if (!appState.selectionPinned) return false;
  const sel = appState.selection;
  if (sel.type === 'message') {
    return message.id === sel.id || message.replyTo === sel.id;
  }
  if (sel.type === 'task') {
    if (message.taskIds.includes(sel.id)) return true;
    return Boolean(message.routing?.actions.some(a => a.taskId === sel.id));
  }
  return false;
}

/**
 * Initializes the redesigned main conversation panel, channel filters, Markdown renderer,
 * compact routing pills, boss decision dock, and keyed incremental DOM synchronization.
 */
export function initChatPanel(options?: { onDraftActivity?: () => void }): ChatPanelController {
  const messagesEl = element('messages');
  const scrollEl = element('messages-scroll');
  const olderBtn = element<HTMLButtonElement>('older');
  const historyErrorEl = element('history-error');
  const composerEl = element<HTMLFormElement>('composer');
  const draftEl = element<HTMLTextAreaElement>('draft');
  const sendBtn = element<HTMLButtonElement>('send');
  const emoteToggleBtn = element<HTMLButtonElement>('emote-toggle');
  const emoteTrayEl = element('bot-emote-tray');
  const sendErrorEl = element('send-error');
  const routingDetailEl = element('routing-detail');

  const statusPillEl = element('companion-status-pill');
  safeRemoveAttr(statusPillEl, 'aria-live');
  safeRemoveAttr(statusPillEl, 'role');
  const activeWorksBtn = element<HTMLButtonElement>('conv-active-works-btn');
  const channelFiltersEl = element('conv-channel-filters');
  const hideSystemBtn = element<HTMLButtonElement>('conv-hide-system-btn');
  const detailModeBtn = element<HTMLButtonElement>('conv-detail-mode-btn');
  const filterBannerEl = element('conv-filter-banner');
  safeRemoveAttr(filterBannerEl, 'role');
  safeRemoveAttr(filterBannerEl, 'aria-live');
  const scrollBottomBtn = element<HTMLButtonElement>('scroll-bottom-btn');
  const bossDecisionDockEl = element('boss-decision-dock');
  const convControlsEl = document.getElementById('conv-controls');
  const mobileFilterBtn = document.getElementById('mobile-filter-btn') as HTMLButtonElement | null;
  const mobileFilterDot = document.getElementById('mobile-filter-dot');
  const mobileTraceDot = document.getElementById('mobile-trace-dot');
  if (!safeHasAttr(scrollEl, 'tabindex')) {
    scrollEl.setAttribute('tabindex', '-1');
  }

  let channelFilter: ChatChannelFilter = normalizeStoredChannel(readStoredString(STORAGE_KEY_CHANNEL));
  let hideSystem = readStoredString(STORAGE_KEY_HIDE_SYSTEM) === 'true';
  let detailMode = readStoredString(STORAGE_KEY_DETAIL_MODE) === 'true';
  let lastBotState: BotStateId = 'sleeping';

  let routingDetailRequest = 0;
  let routingDetailAbort: AbortController | undefined;
  let hydrateParentsAbort: AbortController | undefined;
  let draftTypingActive = false;
  let draftTypingTimer: ReturnType<typeof setTimeout> | undefined;
  let unreadWhileScrolledUp = 0;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let resizePinned = true;
  let hasRenderedMessages = false;
  let emptyStateNotice: HTMLElement | undefined;
  let programmaticScrollTop: number | undefined;
  let programmaticScrollUntil = 0;
  let suppressAutoLoadUntil = 0;
  let historyAutoLoadPaused = false;
  let lastOlderAutoLoadAt = 0;

  function setScrollTopProgrammatic(nextTop: number): void {
    scrollEl.scrollTop = nextTop;
    programmaticScrollTop = scrollEl.scrollTop;
    programmaticScrollUntil = Date.now() + 300;
  }

  function syncOlderButton(state: 'idle' | 'loading' | 'error' = 'idle'): void {
    olderBtn.hidden = !appState.historyHasMore;
    if (state === 'loading' || appState.historyBusy) {
      olderBtn.disabled = true;
      olderBtn.textContent = '正在加载更早消息…';
      olderBtn.classList.add('is-loading');
      return;
    }
    olderBtn.disabled = false;
    olderBtn.classList.remove('is-loading');
    olderBtn.textContent = state === 'error' || historyAutoLoadPaused
      ? '加载失败，点击重试'
      : '上滑自动加载更早消息';
  }

  const liveMessageAvatars = new Map<string, BotAvatarController>();
  const knownMessageIds = new Set<string>();
  const renderedArticles = new Map<string, { el: HTMLElement; sig: string }>();
  const renderedDividers = new Map<string, { el: HTMLElement; label: string }>();
  const expandedRoutingIds = new Set<string>();
  const expandedSystemIds = new Set<string>();
  const expandedLongTextIds = new Set<string>();

  const markdownOpts: MarkdownRenderOptions = {
    createEmote: expr => {
      const wrap = node('span', '', 'bot-inline-emote');
      wrap.title = `F.R.I.D.A.Y. 小表情：${BOT_EXPRESSION_META[expr].label}`;
      wrap.append(createStaticBotSvg({ size: 20, expr, interactivePoke: true }));
      return wrap;
    },
    createSticker: expr => {
      const wrap = node('span', '', 'bot-inline-sticker');
      wrap.title = `F.R.I.D.A.Y. 动态表情：${BOT_EXPRESSION_META[expr].label}`;
      wrap.append(createStaticBotSvg({ size: 46, expr, interactivePoke: true }));
      return wrap;
    },
  };

  function setDraftTyping(activeFlag: boolean): void {
    if (draftTypingTimer) {
      clearTimeout(draftTypingTimer);
      draftTypingTimer = undefined;
    }
    if (activeFlag) {
      const changed = !draftTypingActive;
      draftTypingActive = true;
      draftTypingTimer = setTimeout(() => {
        draftTypingTimer = undefined;
        draftTypingActive = false;
        options?.onDraftActivity?.();
      }, 2400);
      if (changed) options?.onDraftActivity?.();
    } else if (draftTypingActive) {
      draftTypingActive = false;
      options?.onDraftActivity?.();
    }
  }

  const supportsNativePopover = typeof HTMLElement !== 'undefined'
    && 'popover' in HTMLElement.prototype
    && typeof emoteTrayEl.showPopover === 'function'
    && typeof emoteTrayEl.hidePopover === 'function'
    && safeHasAttr(emoteTrayEl, 'popover');
  let emotePopoverOpen = false;
  if (supportsNativePopover) {
    emoteTrayEl.hidden = false;
  } else {
    emoteTrayEl.hidden = true;
  }

  function isEmoteTrayOpen(): boolean {
    if (!supportsNativePopover) return !emoteTrayEl.hidden;
    try {
      if (typeof emoteTrayEl.matches === 'function') {
        return emoteTrayEl.matches(':popover-open');
      }
    } catch {
      // Fall back to tracked popover state if :popover-open selector is unsupported.
    }
    return emotePopoverOpen;
  }

  function setEmoteTrayOpen(open: boolean): void {
    if (supportsNativePopover) {
      try {
        if (open && !isEmoteTrayOpen()) {
          emoteTrayEl.showPopover();
        } else if (!open && isEmoteTrayOpen()) {
          emoteTrayEl.hidePopover();
        }
      } catch {
        // Ignore popover state errors when disconnected or unsupported.
      }
      emotePopoverOpen = open;
    } else {
      emoteTrayEl.hidden = !open;
    }
    emoteToggleBtn.setAttribute('aria-expanded', String(open));
  }

  if (supportsNativePopover) {
    emoteTrayEl.addEventListener('toggle', event => {
      const nextState = (event as Event & { newState?: string }).newState;
      const open = nextState === 'open' || (nextState === undefined && isEmoteTrayOpen());
      emotePopoverOpen = open;
      emoteToggleBtn.setAttribute('aria-expanded', String(open));
    });
  }

  function insertBotEmote(tag: string): void {
    if (draftEl.disabled || draftEl.readOnly) return;
    const start = draftEl.selectionStart ?? draftEl.value.length;
    const end = draftEl.selectionEnd ?? start;
    const before = draftEl.value.slice(0, start);
    const after = draftEl.value.slice(end);
    const needLeadSpace = before.length > 0 && !/\s$/.test(before);
    const needTrailSpace = after.length > 0 && !/^\s/.test(after);
    const snippet = `${needLeadSpace ? ' ' : ''}${tag}${needTrailSpace ? ' ' : ''}`;
    draftEl.value = `${before}${snippet}${after}`;
    const caret = before.length + snippet.length;
    setEmoteTrayOpen(false);
    safeFocus(draftEl);
    draftEl.setSelectionRange(caret, caret);
    setDraftTyping(true);
    updateComposer();
  }

  for (const expr of BOT_EXPRESSIONS) {
    const meta = BOT_EXPRESSION_META[expr];
    const itemBtn = node('button', '', 'bot-emote-item');
    itemBtn.type = 'button';
    itemBtn.title = `插入 [bot:${expr}] (${meta.label})`;
    itemBtn.setAttribute('aria-label', `插入 ${meta.label} 表情`);
    itemBtn.append(createStaticBotSvg({ size: 20, expr }), node('span', meta.label));
    itemBtn.addEventListener('click', () => {
      insertBotEmote(`[bot:${expr}]`);
    });
    emoteTrayEl.append(itemBtn);
  }

  if (!supportsNativePopover || emoteToggleBtn.getAttribute('popovertarget') !== emoteTrayEl.id) {
    emoteToggleBtn.addEventListener('click', event => {
      event.stopPropagation();
      if (emoteToggleBtn.disabled) return;
      setEmoteTrayOpen(!isEmoteTrayOpen());
    });
  }

  function setMobileFilterOpen(open: boolean, opts?: { restoreFocus?: boolean }): void {
    if (!convControlsEl || !mobileFilterBtn) return;
    const wasOpen = convControlsEl.classList.contains('is-mobile-open');
    convControlsEl.classList.toggle('is-mobile-open', open);
    mobileFilterBtn.setAttribute('aria-expanded', String(open));
    if (open && !wasOpen) {
      const firstControl = convControlsEl.querySelector<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      safeFocus(firstControl);
    } else if (!open && wasOpen && opts?.restoreFocus !== false) {
      const activeInside = typeof document !== 'undefined'
        && typeof Node !== 'undefined'
        && document.activeElement instanceof Node
        && convControlsEl.contains(document.activeElement);
      if (activeInside || opts?.restoreFocus === true) {
        safeFocus(mobileFilterBtn);
      }
    }
  }

  mobileFilterBtn?.addEventListener('click', event => {
    event.stopPropagation();
    const isOpen = convControlsEl?.classList.contains('is-mobile-open') ?? false;
    setMobileFilterOpen(!isOpen, { restoreFocus: isOpen });
  });

  document.addEventListener('click', event => {
    if (!supportsNativePopover && isEmoteTrayOpen()) {
      if (!(typeof Node !== 'undefined' && event.target instanceof Node && (emoteTrayEl.contains(event.target) || emoteToggleBtn.contains(event.target)))) {
        setEmoteTrayOpen(false);
      }
    }
    if (convControlsEl?.classList.contains('is-mobile-open')) {
      if (!(typeof Node !== 'undefined' && event.target instanceof Node && (convControlsEl.contains(event.target) || mobileFilterBtn?.contains(event.target)))) {
        setMobileFilterOpen(false, { restoreFocus: false });
      }
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!supportsNativePopover && isEmoteTrayOpen()) {
      const activeInTray = typeof document !== 'undefined'
        && typeof Node !== 'undefined'
        && document.activeElement instanceof Node
        && emoteTrayEl.contains(document.activeElement);
      setEmoteTrayOpen(false);
      if (activeInTray) safeFocus(emoteToggleBtn);
    }
    if (convControlsEl?.classList.contains('is-mobile-open')) {
      setMobileFilterOpen(false, { restoreFocus: true });
    }
  });

  function updateComposer(): void {
    const locked = !appState.ready || appState.authExpired;
    draftEl.disabled = locked;
    draftEl.readOnly = appState.sending || appState.uncertain;
    const emoteLocked = locked || appState.sending || appState.uncertain;
    emoteToggleBtn.disabled = emoteLocked;
    if (emoteLocked && isEmoteTrayOpen()) {
      setEmoteTrayOpen(false);
    }
    sendBtn.disabled = locked || appState.sending || (!appState.uncertain && !draftEl.value.trim());
    const sendLabel = appState.sending ? '正在发送…' : appState.uncertain ? '重试原请求' : '发送消息';
    sendBtn.setAttribute('aria-label', sendLabel);
    sendBtn.title = sendLabel;
    sendBtn.classList.toggle('is-sending', appState.sending);
    sendBtn.classList.toggle('is-retry', appState.uncertain);
    renderBossDecisionDock();
  }

  function updateCompanionStatus(botState: BotStateId): void {
    lastBotState = botState;
    const works = appState.view?.works ?? [];
    const activeWorks = works.filter(work => active(work.status));
    const waitingWorks = works.filter(work => Boolean(work.pendingQuestion));
    const derived = deriveCompanionStatus(botState, activeWorks.length, waitingWorks.length);
    statusPillEl.textContent = derived.text;
    statusPillEl.className = `conv-status-pill tone-${derived.tone}`;

    if (waitingWorks.length > 0) {
      activeWorksBtn.hidden = false;
      activeWorksBtn.classList.add('is-waiting');
      activeWorksBtn.textContent = `⏳ ${waitingWorks.length} 项待拍板`;
      activeWorksBtn.title = '点击查看等待拍板的后台任务';
    } else if (activeWorks.length > 0) {
      activeWorksBtn.hidden = false;
      activeWorksBtn.classList.remove('is-waiting');
      activeWorksBtn.textContent = `⚡ ${activeWorks.length} 项进行中`;
      activeWorksBtn.title = '点击查看正在运行的后台任务';
    } else {
      activeWorksBtn.hidden = true;
      activeWorksBtn.classList.remove('is-waiting');
    }
    if (mobileTraceDot) {
      mobileTraceDot.hidden = activeWorks.length === 0 && waitingWorks.length === 0;
      mobileTraceDot.classList.toggle('is-waiting', waitingWorks.length > 0);
    }
  }

  activeWorksBtn.addEventListener('click', () => {
    const works = appState.view?.works ?? [];
    const target = works.find(w => Boolean(w.pendingQuestion)) ?? works.find(w => active(w.status));
    if (!target) return;
    hooks.selectTrace({ type: 'task', id: target.id, label: target.prompt || '后台工作' });
    hooks.showPanel(true);
  });

  function renderFilterControls(ordered: readonly ChatMessage[], hiddenSystemCount: number, hiddenChannelCount: number): void {
    const configuredPlatforms = (appState.view?.imChannels ?? [])
      .filter(ch => ch.enabled)
      .map(ch => ch.platform);
    const available = collectAvailableChannels(ordered, appState.messages, configuredPlatforms);
    if (channelFilter !== 'all' && !available.includes(channelFilter)) {
      available.push(channelFilter);
    }

    const frag = document.createDocumentFragment();
    for (const ch of available) {
      const meta = channelMeta(ch);
      const btn = button(`${meta.icon} ${meta.shortLabel}`, () => {
        if (channelFilter === ch) return;
        channelFilter = ch;
        writeStoredString(STORAGE_KEY_CHANNEL, ch);
        unreadWhileScrolledUp = 0;
        renderMessages();
        setScrollTopProgrammatic(scrollEl.scrollHeight);
        syncScrollBottomButton();
        announceStatus(`已切换会话筛选为「${meta.shortLabel}」`);
      }, `conv-channel-chip mini-button${channelFilter === ch ? ' active' : ''}`);
      btn.setAttribute('aria-pressed', String(channelFilter === ch));
      btn.title = meta.label;
      frag.append(btn);
    }
    channelFiltersEl.replaceChildren(frag);

    hideSystemBtn.classList.toggle('active', hideSystem);
    hideSystemBtn.setAttribute('aria-pressed', String(hideSystem));
    detailModeBtn.classList.toggle('active', detailMode);
    detailModeBtn.setAttribute('aria-pressed', String(detailMode));

    const hasMobileFilterBadge = channelFilter !== 'all' || hideSystem || detailMode;
    if (mobileFilterDot) mobileFilterDot.hidden = !hasMobileFilterBadge;
    mobileFilterBtn?.classList.toggle('has-active', hasMobileFilterBadge);

    const hasActiveFilter = channelFilter !== 'all' || hideSystem;
    if (!hasActiveFilter || (hiddenSystemCount === 0 && hiddenChannelCount === 0 && channelFilter === 'all')) {
      filterBannerEl.hidden = true;
      filterBannerEl.replaceChildren();
      return;
    }

    const parts: string[] = [];
    if (channelFilter !== 'all') {
      const meta = channelMeta(channelFilter);
      parts.push(`仅看「${meta.icon} ${meta.shortLabel}」渠道${hiddenChannelCount > 0 ? `（已滤除 ${hiddenChannelCount} 条其他渠道）` : ''}`);
    }
    if (hideSystem) {
      parts.push(hiddenSystemCount > 0 ? `已静默 ${hiddenSystemCount} 条系统/定时通知` : '已开启系统通知静默');
    }
    filterBannerEl.hidden = false;
    filterBannerEl.replaceChildren(
      node('span', parts.join(' · '), 'conv-filter-banner-text'),
      button('恢复全部', () => {
        channelFilter = 'all';
        hideSystem = false;
        writeStoredString(STORAGE_KEY_CHANNEL, 'all');
        writeStoredString(STORAGE_KEY_HIDE_SYSTEM, 'false');
        unreadWhileScrolledUp = 0;
        renderMessages();
        announceStatus('已恢复显示全部会话消息');
      }, 'mini-button'),
    );
  }

  hideSystemBtn.addEventListener('click', () => {
    hideSystem = !hideSystem;
    writeStoredString(STORAGE_KEY_HIDE_SYSTEM, String(hideSystem));
    unreadWhileScrolledUp = 0;
    renderMessages();
    announceStatus(hideSystem ? '已静默系统通知' : '已显示系统通知');
  });

  detailModeBtn.addEventListener('click', () => {
    detailMode = !detailMode;
    writeStoredString(STORAGE_KEY_DETAIL_MODE, String(detailMode));
    renderMessages();
    announceStatus(detailMode ? '已切换至详细模式' : '已切换至精简模式');
  });

  function syncScrollBottomButton(): void {
    const dist = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    const hasMessages = renderedArticles.size > 0;
    const show = hasMessages && (dist > 140 || unreadWhileScrolledUp > 0);
    const wasVisible = !scrollBottomBtn.hidden;
    const wasFocused = typeof document !== 'undefined' && document.activeElement === scrollBottomBtn;
    if (!show && wasVisible && wasFocused) {
      safeFocus(scrollEl, { preventScroll: true });
    }
    scrollBottomBtn.hidden = !show;
    scrollBottomBtn.classList.toggle('has-unread', unreadWhileScrolledUp > 0);
    scrollBottomBtn.textContent = unreadWhileScrolledUp > 0
      ? `↓ ${unreadWhileScrolledUp} 条新消息`
      : '↓ 回到底部';
  }

  scrollBottomBtn.addEventListener('click', () => {
    unreadWhileScrolledUp = 0;
    const finish = () => {
      syncScrollBottomButton();
      if (scrollBottomBtn.hidden && typeof document !== 'undefined' && document.activeElement === scrollBottomBtn) {
        safeFocus(scrollEl, { preventScroll: true });
      }
    };
    if (typeof scrollEl.scrollTo === 'function') {
      suppressAutoLoadUntil = Date.now() + 700;
      const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
      const ret = scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior }) as unknown;
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        void (ret as Promise<unknown>).then(finish, finish);
      } else {
        finish();
      }
    } else {
      setScrollTopProgrammatic(scrollEl.scrollHeight);
      finish();
    }
  });

  function setSendFeedback(text: string, tone: 'error' | 'status' | 'clear'): void {
    if (tone === 'clear') {
      safeRemoveAttr(sendErrorEl, 'role');
      sendErrorEl.className = 'error composer-error';
      sendErrorEl.textContent = '';
      return;
    }
    if (tone === 'status') {
      sendErrorEl.setAttribute('role', 'status');
      sendErrorEl.className = 'composer-error meta';
      sendErrorEl.textContent = text;
      announceStatus(text, 'polite');
      return;
    }
    sendErrorEl.setAttribute('role', 'alert');
    sendErrorEl.className = 'error composer-error';
    sendErrorEl.textContent = text;
  }

  function mergeMessages(items: ChatMessage[]): void {
    mergeInto(appState.messages, items);
    if (appState.uncertain && appState.pending && items.some(message => message.requestId === appState.pending?.requestId)) {
      appState.pending = undefined;
      appState.uncertain = false;
      draftEl.value = '';
      setDraftTyping(false);
      setEmoteTrayOpen(false);
      setSendFeedback('已从持久记录确认接收，无需重发。', 'status');
      updateComposer();
    }
  }

  async function hydrateParents(): Promise<void> {
    // A page of replies must never appear without the message that asked for it.
    const missing = [
      ...new Set(
        [...appState.messages.values()]
          .map(message => message.replyTo)
          .filter((id): id is string => Boolean(id) && !appState.messages.has(id!)),
      ),
    ];
    if (!missing.length) return;
    hydrateParentsAbort?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    hydrateParentsAbort = controller;
    const parents = await fetchMessagesBatch(missing.slice(0, 40), {
      signal: controller?.signal,
      priority: 'low',
    }).catch(() => []);
    if (controller?.signal.aborted) return;
    mergeMessages(parents);
  }

  function actionRow(action: RouteAction): HTMLElement {
    const row = node('div', '', 'route-action');
    const title = `${routeLabel(action)}${action.taskId ? ` · ${action.taskLabel ?? '目标工作名称未记录'}` : ''}`;
    if (action.taskId) {
      row.append(button(title, () => {
        hooks.selectTrace({ type: 'task', id: action.taskId!, label: action.taskLabel ?? '目标工作' });
        hooks.showPanel(true);
      }, 'route-target'));
    } else {
      row.append(node('strong', title));
    }
    row.append(node(
      'p',
      routeState(action),
      action.status === 'failed' || action.status === 'interrupted' || action.delivery === 'failed' ? 'error' : 'meta',
    ));
    if (action.parentTaskId) {
      row.append(button('来源工作：查看原执行（本次是新执行）', () => {
        hooks.selectTrace({ type: 'task', id: action.parentTaskId!, label: '来源工作' });
        hooks.showPanel(true);
      }, 'source-reference'));
    }
    if (action.messageIds?.length) row.append(node('p', `已读取 ${action.messageIds.length} 条历史消息引用`, 'meta'));
    if (action.searchQuery) row.append(node('p', `检索线索：${action.searchQuery}`, 'meta'));
    if (action.memoryIds?.length) row.append(node('p', `关联全局记忆：${action.memoryIds.length} 条`, 'meta'));
    if (action.workerProfile || action.workerModel || action.thinkingLevel || action.modelTier || action.decisionSource) {
      const tierName = !action.workerModel && action.modelTier
        ? ({ fast: '极速档', balanced: '均衡档', strong: '强力档' }[action.modelTier] ?? action.modelTier)
        : undefined;
      const modelSpec = action.workerModel
        ? `${action.workerModel}${action.thinkingLevel ? `@${action.thinkingLevel}` : ''}`
        : (action.thinkingLevel ? `@${action.thinkingLevel}` : undefined);
      const decisionTag = action.decisionSource === 'gemini-decision-1' ? 'Jev 决策' : undefined;
      row.append(node('p', `执行子 AI：${[action.workerProfile, modelSpec ?? tierName, decisionTag].filter(Boolean).join(' · ')}`, 'meta'));
    }
    if (action.summary) row.append(node('p', `F.R.I.D.A.Y. 公开说明：${action.summary}`, 'meta'));
    if (action.error) row.append(node('p', action.error, 'error'));
    return row;
  }

  function buildWorkMap(): Map<string, WorkView> {
    const workMap = new Map<string, WorkView>();
    for (const work of appState.view?.works ?? []) {
      workMap.set(work.id, work);
    }
    return workMap;
  }

  function buildRoutingSection(
    message: ChatMessage,
    workMap: Map<string, WorkView> = buildWorkMap(),
    onBeforeMatchReveal?: () => void,
  ): HTMLElement | undefined {
    const model = classifyRoutingDisplay(message, detailMode);
    if (!model.visible) return undefined;

    const area = node('div', '', `routing-summary is-${model.mode}`);
    const row = node('div', '', 'route-pills-row');

    if (model.pendingText) {
      const pending = node('span', '', 'route-pill tone-run is-pending');
      pending.append(node('span', '', 'route-pill-dot'), node('span', model.pendingText));
      row.append(pending);
    }

    for (const action of model.taskActions) {
      const work = action.taskId ? workMap.get(action.taskId) : undefined;
      const tone = work
        ? (work.status === 'failed' || work.status === 'cancelled' ? 'tone-err'
          : work.pendingQuestion ? 'tone-warn'
          : active(work.status) ? 'tone-run' : 'tone-ok')
        : actionToneClass(action);
      const pill = node('div', '', `route-pill ${tone}`);
      pill.append(node('span', '', 'route-pill-dot'));
      const label = singleLine(formatActionShortLabel(action));
      if (action.taskId) {
        const targetBtn = button(label, () => {
          hooks.selectTrace({ type: 'task', id: action.taskId!, label: action.taskLabel ?? '目标工作' });
          hooks.showPanel(true);
        }, 'route-target route-pill-btn');
        const stateLabel = work ? statusText(work.status) : routeState(action);
        targetBtn.title = `${label} · ${stateLabel}`;
        targetBtn.setAttribute('aria-label', `${label}（${stateLabel}），查看轨迹`);
        pill.append(targetBtn);
      } else {
        const textSpan = node('span', label, 'route-pill-text');
        textSpan.title = label;
        pill.append(textSpan);
      }

      const stateHint = work
        ? (work.pendingQuestion ? '待拍板' : statusText(work.status))
        : (action.kind === 'followup' || action.status !== 'accepted' ? routeState(action) : '');
      if (stateHint) {
        pill.append(node('span', stateHint, 'route-pill-state'));
      }

      if (work && active(work.status)) {
        const requested = appState.stopRequests.has(`task:${work.id}`);
        const stopPillBtn = button(requested ? '…' : '■', () => {
          void hooks.stopWork(work.id);
        }, 'route-pill-stop danger-btn mini-button');
        stopPillBtn.disabled = requested || appState.authExpired;
        stopPillBtn.title = requested ? '已请求停止' : '停止此后台任务';
        stopPillBtn.setAttribute(
          'aria-label',
          requested ? `已请求停止后台任务「${label}」` : `停止后台任务「${label}」`,
        );
        stopPillBtn.dataset.actionKey = `stop-pill-${message.id}-${work.id}`;
        pill.append(stopPillBtn);
      }
      row.append(pill);
    }

    for (const action of model.metaActions) {
      const pill = node('div', '', `route-pill is-meta ${actionToneClass(action)}`);
      const metaLabel = singleLine(formatActionShortLabel(action));
      const metaSpan = node('span', metaLabel, 'route-pill-text');
      metaSpan.title = metaLabel;
      pill.append(metaSpan);
      if (model.mode === 'detail' || action.status !== 'accepted' || action.error) {
        pill.append(node('span', routeState(action), 'route-pill-state'));
      }
      row.append(pill);
    }

    const isExpanded = expandedRoutingIds.has(message.id);
    const hasDrawer = Boolean(message.routing && (model.hasExpandableDetails || model.mode === 'detail'));
    const drawerId = `route-drawer-${domSafeId(message.id)}`;
    let expandBtn: HTMLButtonElement | undefined;
    if (model.hasExpandableDetails || model.mode === 'detail') {
      expandBtn = button(isExpanded ? '▴ 收起' : '▾ 详情', () => {
        if (expandedRoutingIds.has(message.id)) expandedRoutingIds.delete(message.id);
        else expandedRoutingIds.add(message.id);
        renderMessages();
      }, 'route-expand-btn mini-button');
      expandBtn.setAttribute('aria-expanded', String(isExpanded));
      expandBtn.setAttribute('aria-label', isExpanded ? '收起路由详情' : '展开路由详情');
      expandBtn.dataset.actionKey = `route-expand-${message.id}`;
      if (hasDrawer) expandBtn.setAttribute('aria-controls', drawerId);
      row.append(expandBtn);
    }

    if (row.childNodes.length) area.append(row);

    if (model.warningText) {
      area.append(node('p', model.warningText, 'route-warning-note'));
    }

    if (hasDrawer && message.routing) {
      const drawer = node('div', '', 'route-expanded-drawer');
      drawer.id = drawerId;
      for (const action of message.routing.actions) {
        drawer.append(actionRow(action));
      }
      if (!isExpanded) {
        drawer.setAttribute('hidden', 'until-found');
      }
      drawer.addEventListener('beforematch', () => {
        expandedRoutingIds.add(message.id);
        drawer.hidden = false;
        safeRemoveAttr(drawer, 'hidden');
        if (expandBtn) {
          expandBtn.textContent = '▴ 收起';
          expandBtn.setAttribute('aria-expanded', 'true');
          expandBtn.setAttribute('aria-label', '收起路由详情');
        }
        onBeforeMatchReveal?.();
      });
      area.append(drawer);
    }
    return area;
  }

  function renderAttachmentAndFooterChips(
    message: ChatMessage,
    options?: { skipRoutingCoveredTasks?: boolean },
    workMap: Map<string, WorkView> = buildWorkMap(),
  ): HTMLElement | undefined {
    const attachments: AttachmentView[] = message.attachments ?? [];
    const paths = message.paths ?? [];
    const routingTaskIds = new Set(
      (message.routing?.actions ?? [])
        .map(a => a.taskId)
        .filter((id): id is string => Boolean(id)),
    );
    const rawTaskIds = message.role === 'assistant' || !message.routing ? message.taskIds : [];
    const taskIds = options?.skipRoutingCoveredTasks
      ? rawTaskIds.filter(id => !routingTaskIds.has(id))
      : rawTaskIds;

    if (!attachments.length && !paths.length && !taskIds.length) return undefined;

    const wrap = node('div', '', 'message-footer-chips');

    for (const att of attachments) {
      const sizeStr = formatByteSize(att.bytes);
      const icon = att.kind === 'image' ? '🖼️' : att.kind === 'voice' ? '🎤' : att.kind === 'video' ? '🎬' : '📎';
      const statusSuffix = att.status === 'failed' ? ` · 失败${att.error ? `: ${att.error}` : ''}` : '';
      const label = `${icon} ${att.name}${sizeStr ? ` (${sizeStr})` : ''}${statusSuffix}`;
      const chip = node('span', label, `attachment-chip${att.status === 'failed' ? ' is-failed' : ''}`);
      if (att.path) chip.title = att.path;
      wrap.append(chip);
    }

    for (const p of paths) {
      wrap.append(node('span', p, 'message-path attachment-chip'));
    }

    const seenTasks = new Set<string>();
    for (const id of taskIds) {
      if (seenTasks.has(id)) continue;
      seenTasks.add(id);
      const work = workMap.get(id);
      const promptLine = work?.prompt ? singleLine(work.prompt) : '';
      const fullLabel = promptLine ? `🔗 关联工作：${promptLine}` : '🔗 关联工作：查看详情';
      const taskBtn = button('', () => {
        hooks.selectTrace({ type: 'task', id, label: work?.prompt ?? '关联工作' });
        hooks.showPanel(true);
      }, 'task-link-chip source-reference');
      taskBtn.title = fullLabel;
      taskBtn.append(node('span', fullLabel, 'task-link-label'));
      if (work) {
        taskBtn.append(node('span', statusText(work.status), `task-link-state${active(work.status) ? ' running' : ''}`));
      }
      wrap.append(taskBtn);
    }

    return wrap;
  }

  function syncSelectionHighlight(): void {
    for (const [id, entry] of renderedArticles) {
      const msg = appState.messages.get(id);
      const selected = msg ? isMessageMatchedByTraceSelection(msg) : false;
      entry.el.classList.toggle('is-trace-selected', selected);
    }
  }

  function renderRoutingDetail(): void {
    syncSelectionHighlight();
    routingDetailEl.hidden = appState.selection.type !== 'message';
    if (appState.selection.type !== 'message') {
      routingDetailAbort?.abort();
      routingDetailAbort = undefined;
      return;
    }
    const message = appState.messages.get(appState.selection.id);
    if (!message) {
      routingDetailAbort?.abort();
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      routingDetailAbort = controller;
      const requestSeq = ++routingDetailRequest;
      const generation = appState.selectionGeneration;
      const id = appState.selection.id;
      routingDetailEl.replaceChildren(node('p', '正在读取该消息的路由记录…', 'meta'));
      void api<ChatMessage>(`/api/message?${new URLSearchParams({ messageId: id })}`, undefined, {
        signal: controller?.signal,
        priority: 'low',
      }).then(fetched => {
        if (controller?.signal.aborted || requestSeq !== routingDetailRequest || generation !== appState.selectionGeneration) return;
        mergeMessages([fetched]);
        renderMessages();
      }).catch(error => {
        if (controller?.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        if (requestSeq === routingDetailRequest) routingDetailEl.replaceChildren(node('p', `读取路由记录失败：${errorText(error)}`, 'error'));
      });
      return;
    }
    routingDetailAbort?.abort();
    routingDetailAbort = undefined;
    const previous = routingDetailEl.querySelector<HTMLDetailsElement>('details.routing-facts');
    const factsOpen = previous?.open ?? false;
    const referencesOpen = previous?.querySelector<HTMLDetailsElement>('details.references')?.open ?? false;
    routingDetailEl.replaceChildren();
    if (!message.routing) {
      routingDetailEl.append(node('p', '此消息尚无已记录的路由上下文。旧历史不会补造。', 'meta'));
      return;
    }
    const routing = message.routing;
    const summary = routing.actions.length
      ? routing.actions.map(action => `${routeLabel(action)}${action.taskLabel ? ` · ${action.taskLabel}` : ''}`).join('；')
      : routing.status === 'processing' ? 'F.R.I.D.A.Y. 正在处理' : '没有已确认的分配动作';
    const wrap = node('details', '', 'routing-facts');
    wrap.open = factsOpen;
    const target = node('div', '', 'routing-facts-body');
    wrap.append(node('summary', `分配记录与当时上下文：${summary}`), target);
    routingDetailEl.append(wrap);
    target.append(node('p', `路由处理时：${timestamp(routing.at)} · ${statusText(routing.status)}`, 'meta'));
    target.append(node('h4', '当时可见的工作'));
    for (const work of routing.context.works) {
      const row = node('div', '', 'routing-work');
      row.append(
        button(work.prompt || '后台工作', () => {
          hooks.selectTrace({ type: 'task', id: work.id, label: work.prompt });
          hooks.showPanel(true);
        }, 'source-reference'),
        node('span', `当时${statusText(work.status)}`, 'meta'),
      );
      target.append(row);
    }
    if (!routing.context.works.length) target.append(node('p', '当时没有后台工作。', 'meta'));
    if (routing.context.truncated) {
      target.append(node('p', `当时共 ${routing.context.totalWorks} 项工作，F.R.I.D.A.Y. 仅收到最近 ${routing.context.works.length} 项摘要。`, 'meta'));
    }
    target.append(node('p', '以上是处理当时的状态，不随当前工作状态改写。', 'meta'), node('h4', '已记录动作'));
    for (const action of routing.actions) {
      target.append(actionRow(action));
      for (const [index, id] of (action.messageIds ?? []).entries()) {
        target.append(button(
          `召回引用 ${index + 1}：${appState.messages.get(id)?.text.slice(0, 60) ?? '读取原消息'}`,
          () => { void jumpMessage(id); },
          'source-reference',
        ));
      }
    }
    if (routing.omittedActions) target.append(node('p', '摘要只展示最近 40 条动作；完整动作记录请查看原始事件。', 'meta'));
    if (!routing.actions.length) target.append(node('p', '尚无已确认的路由动作。', 'meta'));
    const refs = node('details', '', 'references');
    refs.open = referencesOpen;
    refs.append(node('summary', '当时的近期对话引用'));
    for (const reference of routing.context.messages) {
      refs.append(button(
        `${reference.role === 'user' ? '你' : 'F.R.I.D.A.Y.'}：${reference.preview || '无公开文本'}`,
        () => { void jumpMessage(reference.id); },
        'source-reference',
      ));
    }
    if (routing.context.autoRecalled?.length) {
      target.append(node('h4', `潜意识记忆闪回（自动关联 ${routing.context.autoRecalled.length} 条）`));
      for (const hit of routing.context.autoRecalled) {
        const row = node('div', '', 'routing-work');
        const kindLabel = hit.kind === 'memory' ? '记忆神经元' : hit.kind === 'work' ? '历史工作' : '历史消息';
        const viaSuffix = hit.activatedVia
          ? ` · ⚡经由「${hit.activatedVia.topic}」突触扩散 (${Math.round(hit.activatedVia.weight * 100)}%)`
          : '';
        if (hit.kind === 'message' && hit.messageId) {
          row.append(button(`[${kindLabel}] ${hit.title}：${hit.snippet.slice(0, 60)}`, () => { void jumpMessage(hit.messageId!); }, 'source-reference'));
        } else if (hit.kind === 'work' && hit.taskId) {
          row.append(button(`[${kindLabel}] ${hit.title}：${hit.snippet.slice(0, 60)}`, () => {
            hooks.selectTrace({ type: 'task', id: hit.taskId!, label: hit.title });
            hooks.showPanel(true);
          }, 'source-reference'));
        } else {
          row.append(node('span', `[${kindLabel}] ${hit.title}${viaSuffix}：${hit.snippet.slice(0, 80)}`, 'meta'));
        }
        target.append(row);
      }
    }
    if (routing.context.memoryDirectory) {
      target.append(node('p', `全局记忆目录：当时共有 ${routing.context.memoryDirectory.totalActive} 条活跃记忆卡片`, 'meta'));
    }
    target.append(refs, node('p', `执行环境：${routing.context.execution} · ${routing.context.cwd}`, 'meta'));
  }

  function buildMessageSignature(
    message: ChatMessage,
    opts: {
      isLatestAssistant: boolean;
      isGrouped: boolean;
      showReplyRef: boolean;
      replySourcePreview: string;
      channel: ReturnType<typeof resolveMessageChannel>;
      quoteJumpId?: string;
      workMap?: Map<string, WorkView>;
    },
  ): string {
    const workMap = opts.workMap ?? buildWorkMap();
    const workStates = [
      ...message.taskIds,
      ...(message.routing?.actions.map(a => a.taskId).filter((id): id is string => Boolean(id)) ?? []),
    ]
      .map(id => {
        const w = workMap.get(id);
        return w ? `${id}:${w.status}:${w.pendingQuestion ? 1 : 0}:${appState.stopRequests.has(`task:${id}`) ? 1 : 0}` : id;
      })
      .join(',');

    return [
      message.version,
      message.status,
      message.text.length,
      message.text.slice(-32),
      message.mode,
      message.reason ?? '',
      message.paths.length,
      message.attachments?.length ?? 0,
      message.origin?.channel ?? '',
      message.origin?.speakerName ?? '',
      message.routing ? `${message.routing.status}:${message.routing.actions.length}:${message.routing.actions.map(a => `${a.kind}/${a.status}/${a.delivery ?? ''}`).join(';')}` : '-',
      opts.isLatestAssistant ? 'L' : 'S',
      opts.isGrouped ? 'G' : 'N',
      opts.showReplyRef ? `R:${opts.replySourcePreview}` : 'R0',
      opts.channel,
      opts.quoteJumpId ?? '',
      detailMode ? 'D' : 'C',
      expandedRoutingIds.has(message.id) ? 'ER' : '',
      expandedSystemIds.has(message.id) ? 'ES' : '',
      expandedLongTextIds.has(message.id) ? 'EL' : '',
      appState.stopRequests.has(`message:${message.id}`) ? 'SM' : '',
      appState.authExpired ? 'AX' : '',
      workStates,
    ].join('|');
  }

  function buildStopActionButton(
    message: ChatMessage,
    workMap: Map<string, WorkView> = buildWorkMap(),
  ): HTMLButtonElement | undefined {
    if (!active(message.status)) return undefined;
    let deliveryWork: WorkView | undefined;
    if (message.role === 'assistant') {
      for (const id of message.taskIds) {
        const cand = workMap.get(id);
        if (cand && active(cand.status)) {
          deliveryWork = cand;
          break;
        }
      }
    }
    const requested = appState.stopRequests.has(deliveryWork ? `task:${deliveryWork.id}` : `message:${message.id}`);
    const label = message.role === 'user' ? '取消' : deliveryWork ? '停止任务' : '停止回复';
    const timeLabel = formatShortClock(message.at);
    const stop = button(requested ? '已请求停止' : label, () => {
      if (deliveryWork) void hooks.stopWork(deliveryWork.id);
      else void stopMessage(message.id);
    }, 'mini-button danger-btn msg-stop-btn');
    stop.disabled = requested || appState.authExpired;
    stop.setAttribute('aria-label', requested ? `已请求停止（${timeLabel}）` : `${label}（${timeLabel}）`);
    stop.dataset.actionKey = `stop-${message.id}`;
    return stop;
  }

  function populateUserArticle(
    article: HTMLElement,
    message: ChatMessage,
    channel: ReturnType<typeof resolveMessageChannel>,
    isGrouped: boolean,
    parsedQuote = extractLeadingQuote(message.text),
    quoteJumpId = parsedQuote && !parsedQuote.uncached
      ? findQuotedJumpTargetId(message, parsedQuote.label, parsedQuote.preview)
      : undefined,
    workMap: Map<string, WorkView> = buildWorkMap(),
    onBeforeMatchReveal?: () => void,
  ): void {
    article.className = `message user-message${isGrouped ? ' is-grouped' : ''}${isMessageMatchedByTraceSelection(message) ? ' is-trace-selected' : ''}`;
    const children: Node[] = [];
    const displayBody = parsedQuote ? parsedQuote.body : message.text;
    const timeLabel = formatShortClock(message.at);

    const row = node('div', '', 'user-row');
    const actions = node('div', '', `message-actions${active(message.status) ? ' has-active-stop' : ''}`);
    actions.append(createClipboardButton('复制', () => displayBody || message.text, {
      ariaLabel: `复制我的消息（${timeLabel}）`,
      actionKey: `copy-${message.id}`,
    }));
    const traceBtn = button('路由', () => {
      hooks.selectTrace({ type: 'message', id: message.id, label: '本轮消息' });
      hooks.showPanel(true);
    }, 'mini-button');
    traceBtn.title = '查看本次路由与上下文';
    traceBtn.setAttribute('aria-label', `查看我的消息（${timeLabel}）的路由与上下文`);
    traceBtn.dataset.actionKey = `trace-${message.id}`;
    actions.append(traceBtn);
    const stopBtn = buildStopActionButton(message, workMap);
    if (stopBtn) actions.append(stopBtn);

    const bubble = node('div', '', 'user-bubble');
    if (parsedQuote) {
      const fullLine = `↩ ${parsedQuote.label}：${parsedQuote.preview}`;
      const jumpId = quoteJumpId;
      if (jumpId) {
        const quoteBtn = button('', () => {
          void jumpMessage(jumpId);
        }, 'reply-quote-btn user-reply-quote source-reference');
        quoteBtn.title = parsedQuote.fullText;
        quoteBtn.append(node('span', fullLine, 'reply-quote-text'));
        bubble.append(quoteBtn);
      } else {
        const quoteBox = node('div', '', 'reply-quote-btn user-reply-quote is-static');
        quoteBox.title = parsedQuote.fullText;
        quoteBox.append(node('span', fullLine, 'reply-quote-text'));
        bubble.append(quoteBox);
      }
    }
    const textEl = node('div', '', 'message-text');
    textEl.append(renderUserMessageContent(displayBody || (parsedQuote ? '（仅引用）' : '（空消息）'), markdownOpts));
    bubble.append(textEl);

    const footerChips = renderAttachmentAndFooterChips(message, { skipRoutingCoveredTasks: true }, workMap);
    if (footerChips) bubble.append(footerChips);

    row.append(actions, bubble);
    children.push(row);

    const speaker = node('div', '', 'speaker user-meta');
    if (channel !== 'local') {
      const chMeta = channelMeta(channel);
      speaker.append(node('span', `${chMeta.icon} ${chMeta.shortLabel}`, `origin-channel-badge ch-${channel}`));
    }
    if (message.origin?.speakerName) {
      speaker.append(node('span', `🎙️ ${channel === 'xiaoai' ? '小爱 · ' : ''}${message.origin.speakerName}`, 'origin-speaker-badge'));
    }
    if (message.mode === 'offline') speaker.append(node('span', '离线模拟', 'mode-chip'));

    if (active(message.status)) {
      speaker.append(node('span', statusText(message.status), 'status-chip running'));
    } else if (message.status === 'failed' || message.status === 'interrupted') {
      speaker.append(node('span', statusText(message.status), 'status-chip is-error'));
    } else if (detailMode && message.status === 'completed') {
      speaker.append(node('span', 'F.R.I.D.A.Y. 已处理', 'status-chip'));
    }

    const time = node('time', formatShortClock(message.at));
    time.title = timestamp(message.at);
    if (Number.isFinite(message.at)) {
      const parsedTime = new Date(message.at);
      if (!Number.isNaN(parsedTime.getTime())) time.dateTime = parsedTime.toISOString();
    }
    speaker.append(time);
    children.push(speaker);

    const routingSection = buildRoutingSection(message, workMap, onBeforeMatchReveal);
    if (routingSection) children.push(routingSection);

    article.replaceChildren(...children);
  }

  function populateSystemArticle(
    article: HTMLElement,
    message: ChatMessage,
    workMap: Map<string, WorkView> = buildWorkMap(),
    onBeforeMatchReveal?: () => void,
  ): void {
    article.className = `message router-message system-message${isMessageMatchedByTraceSelection(message) ? ' is-trace-selected' : ''}`;
    const summary = summarizeSystemNotice(message);
    const expanded = expandedSystemIds.has(message.id) || detailMode;
    const bodyId = `system-notice-body-${domSafeId(message.id)}`;

    const card = node('div', '', `system-notice-card${expanded ? ' is-expanded' : ''}`);
    const head = node('div', '', 'system-notice-head');
    head.append(
      node('span', summary.icon, 'system-notice-icon'),
      node('span', summary.badge, 'system-notice-badge'),
      node('span', summary.title, 'system-notice-title'),
    );
    const time = node('time', formatShortClock(message.at), 'system-notice-time meta');
    time.title = timestamp(message.at);
    head.append(time);

    let toggleBtn: HTMLButtonElement | undefined;
    if (summary.expandable && !detailMode) {
      toggleBtn = button(expanded ? '收起' : '详情', () => {
        if (expandedSystemIds.has(message.id)) expandedSystemIds.delete(message.id);
        else expandedSystemIds.add(message.id);
        renderMessages();
      }, 'mini-button system-notice-toggle');
      toggleBtn.setAttribute('aria-expanded', String(expanded));
      toggleBtn.setAttribute('aria-controls', bodyId);
      toggleBtn.setAttribute(
        'aria-label',
        expanded ? `收起系统通知「${summary.title}」详情` : `展开系统通知「${summary.title}」详情`,
      );
      toggleBtn.dataset.actionKey = `sys-toggle-${message.id}`;
      head.append(toggleBtn);
    }

    const traceBtn = button('链路', () => {
      hooks.selectTrace({ type: 'message', id: message.replyTo ?? message.id, label: '系统通知链路' });
      hooks.showPanel(true);
    }, 'mini-button system-notice-trace');
    traceBtn.setAttribute('aria-label', `查看系统通知「${summary.title}」的链路`);
    traceBtn.dataset.actionKey = `trace-${message.id}`;
    head.append(traceBtn);

    card.append(head);

    if (expanded || summary.expandable) {
      const body = node('div', '', 'system-notice-body');
      body.id = bodyId;
      const md = node('div', '', 'message-text md-content');
      md.append(renderMarkdownContent(message.text || '没有公开文本。', markdownOpts));
      body.append(md);
      const footerChips = renderAttachmentAndFooterChips(message, undefined, workMap);
      if (footerChips) body.append(footerChips);
      if (message.reason) body.append(node('p', message.reason, 'message-reason'));
      if (!expanded) {
        body.setAttribute('hidden', 'until-found');
      }
      body.addEventListener('beforematch', () => {
        expandedSystemIds.add(message.id);
        body.hidden = false;
        safeRemoveAttr(body, 'hidden');
        card.classList.add('is-expanded');
        if (toggleBtn) {
          toggleBtn.textContent = '收起';
          toggleBtn.setAttribute('aria-expanded', 'true');
          toggleBtn.setAttribute('aria-label', `收起系统通知「${summary.title}」详情`);
        }
        onBeforeMatchReveal?.();
      });
      card.append(body);
    }

    article.replaceChildren(card);
  }

  function populateAssistantArticle(
    article: HTMLElement,
    message: ChatMessage,
    opts: {
      isLatestAssistant: boolean;
      isGrouped: boolean;
      showReplyRef: boolean;
      replySourceText?: string;
      channel: ReturnType<typeof resolveMessageChannel>;
      workMap?: Map<string, WorkView>;
      onBeforeMatchReveal?: () => void;
    },
  ): void {
    article.className = `message router-message${opts.isGrouped ? ' is-grouped' : ''}${isMessageMatchedByTraceSelection(message) ? ' is-trace-selected' : ''}`;
    const workMap = opts.workMap ?? buildWorkMap();
    const timeLabel = formatShortClock(message.at);

    const row = node('div', '', 'assistant-row');
    const avatarCol = node('div', '', 'assistant-avatar-col');

    if (!opts.isGrouped || active(message.status) || opts.isLatestAssistant) {
      const avatar = node('span', '', 'speaker-avatar');
      const inferredExpr = inferMessageBotExpression(message.text);
      if (active(message.status) || opts.isLatestAssistant) {
        let ctrl = liveMessageAvatars.get(message.id);
        if (!ctrl) {
          ctrl = createLiveBotAvatar({
            size: 28,
            compact: true,
            interactive: true,
            idPrefix: `friday-msg-${message.id.replace(/[^a-zA-Z0-9_-]/g, '')}`,
          });
          liveMessageAvatars.set(message.id, ctrl);
        }
        if (message.status === 'streaming') {
          ctrl.setState('streaming');
          ctrl.setExpression(inferredExpr ?? 'auto');
        } else if (message.status === 'queued' || message.status === 'processing') {
          ctrl.setState('thinking');
          ctrl.setExpression('auto');
        } else if (message.status === 'failed' || message.status === 'interrupted') {
          ctrl.setState('idle');
          ctrl.setExpression(inferredExpr ?? 'sad');
        } else {
          ctrl.setState('idle');
          ctrl.setExpression(inferredExpr ?? 'auto');
        }
        avatar.append(
          typeof ctrl.createPokeButton === 'function'
            ? ctrl.createPokeButton('与 F.R.I.D.A.Y. 互动')
            : ctrl.svg,
        );
      } else {
        avatar.append(createStaticBotSvg({
          size: 28,
          expr: inferredExpr ?? 'neutral',
          interactivePoke: true,
        }));
      }
      avatarCol.append(avatar);
    } else {
      avatarCol.setAttribute('aria-hidden', 'true');
    }

    const bodyCol = node('div', '', 'assistant-body-col');

    const headRow = node('div', '', 'assistant-head-row');
    const speaker = node('div', '', 'speaker assistant-meta');
    if (!opts.isGrouped || detailMode || active(message.status) || message.status === 'failed' || message.status === 'interrupted') {
      speaker.append(node('span', 'F.R.I.D.A.Y.', 'speaker-name'));
      if (opts.channel !== 'local' && detailMode) {
        const chMeta = channelMeta(opts.channel);
        speaker.append(node('span', `${chMeta.icon} ${chMeta.shortLabel}`, `origin-channel-badge ch-${opts.channel}`));
      }
      if (active(message.status)) {
        speaker.append(node('span', statusText(message.status), 'status-chip running'));
      } else if (message.status === 'failed' || message.status === 'interrupted') {
        speaker.append(node('span', statusText(message.status), 'status-chip is-error'));
      } else if (detailMode) {
        speaker.append(node('span', statusText(message.status), 'status-chip'));
      }
      if (message.mode === 'offline') speaker.append(node('span', '离线模拟', 'mode-chip'));
    }
    const time = node('time', formatShortClock(message.at));
    time.title = timestamp(message.at);
    if (Number.isFinite(message.at)) {
      const parsedTime = new Date(message.at);
      if (!Number.isNaN(parsedTime.getTime())) time.dateTime = parsedTime.toISOString();
    }
    speaker.append(time);

    const actions = node('div', '', `message-actions${active(message.status) ? ' has-active-stop' : ''}`);
    actions.append(createClipboardButton('复制', () => message.text, {
      ariaLabel: `复制 F.R.I.D.A.Y. 回复（${timeLabel}）`,
      actionKey: `copy-${message.id}`,
    }));
    const traceBtn = button('链路', () => {
      hooks.selectTrace({ type: 'message', id: message.replyTo ?? message.id, label: '本轮消息' });
      hooks.showPanel(true);
    }, 'mini-button');
    traceBtn.title = '查看来源轨迹';
    traceBtn.setAttribute('aria-label', `查看 F.R.I.D.A.Y. 回复（${timeLabel}）的来源轨迹`);
    traceBtn.dataset.actionKey = `trace-${message.id}`;
    actions.append(traceBtn);
    const stopBtn = buildStopActionButton(message, workMap);
    if (stopBtn) actions.append(stopBtn);

    headRow.append(speaker, actions);
    bodyCol.append(headRow);

    if (opts.showReplyRef && message.replyTo) {
      const quoteText = opts.replySourceText ? singleLine(opts.replySourceText) : '查看原消息';
      const fullQuote = `↩ 回应：${quoteText || '查看原消息'}`;
      const replyBtn = button('', () => {
        void jumpMessage(message.replyTo!);
      }, 'reply-quote-btn source-reference');
      replyBtn.title = fullQuote;
      replyBtn.append(node('span', fullQuote, 'reply-quote-text'));
      bodyCol.append(replyBtn);
    }

    const fullText = message.text;
    const isLong = !active(message.status) && fullText.length > LONG_MESSAGE_COLLAPSE_CHARS;
    const isLongExpanded = expandedLongTextIds.has(message.id);
    const visibleText = isLong && !isLongExpanded ? fullText.slice(0, LONG_MESSAGE_COLLAPSE_CHARS) : fullText;

    const textBlock = node('div', '', `message-text md-content${isLong && !isLongExpanded ? ' is-long-truncated' : ''}`);
    if (!visibleText && active(message.status)) {
      const typing = node('div', '', 'typing-indicator');
      typing.append(
        node('span', '', 'typing-dot'),
        node('span', '', 'typing-dot'),
        node('span', '', 'typing-dot'),
        node('span', 'F.R.I.D.A.Y. 正在处理…', 'typing-label meta'),
      );
      textBlock.append(typing);
    } else if (!visibleText) {
      textBlock.append(node('p', '没有公开文本。', 'md-p meta'));
    } else {
      textBlock.append(renderMarkdownContent(visibleText, markdownOpts));
      if (message.status === 'streaming') {
        const cursor = node('span', '', 'streaming-cursor');
        cursor.setAttribute('aria-hidden', 'true');
        textBlock.append(cursor);
      }
    }
    bodyCol.append(textBlock);

    if (isLong) {
      const remaining = fullText.length - LONG_MESSAGE_COLLAPSE_CHARS;
      const tailId = `msg-long-tail-${domSafeId(message.id)}`;
      const tailText = fullText.slice(LONG_MESSAGE_COLLAPSE_CHARS);
      const toggleLongBtn = button(
        isLongExpanded ? '▴ 收起长文' : `▾ 展开全文（剩余 ${formatNumber(remaining)} 字）`,
        () => {
          if (expandedLongTextIds.has(message.id)) expandedLongTextIds.delete(message.id);
          else expandedLongTextIds.add(message.id);
          renderMessages();
        },
        'long-text-toggle mini-button',
      );
      toggleLongBtn.setAttribute('aria-expanded', String(isLongExpanded));
      toggleLongBtn.setAttribute('aria-label', isLongExpanded ? `收起长文（${timeLabel}）` : `展开全文（剩余 ${formatNumber(remaining)} 字，${timeLabel}）`);
      toggleLongBtn.dataset.actionKey = `long-toggle-${message.id}`;

      if (!isLongExpanded && tailText) {
        const longTailEl = node('div', '', 'message-text md-content msg-long-tail');
        longTailEl.id = tailId;
        longTailEl.setAttribute('hidden', 'until-found');
        longTailEl.append(renderMarkdownContent(tailText, markdownOpts));
        toggleLongBtn.setAttribute('aria-controls', tailId);
        longTailEl.addEventListener('beforematch', () => {
          expandedLongTextIds.add(message.id);
          longTailEl.hidden = false;
          safeRemoveAttr(longTailEl, 'hidden');
          textBlock.classList.remove('is-long-truncated');
          toggleLongBtn.textContent = '▴ 收起长文';
          toggleLongBtn.setAttribute('aria-expanded', 'true');
          toggleLongBtn.setAttribute('aria-label', `收起长文（${timeLabel}）`);
          opts.onBeforeMatchReveal?.();
        });
        bodyCol.append(longTailEl);
      }
      bodyCol.append(toggleLongBtn);
    }

    const footerChips = renderAttachmentAndFooterChips(message, undefined, workMap);
    if (footerChips) bodyCol.append(footerChips);
    if (message.reason) bodyCol.append(node('p', message.reason, 'message-reason'));

    row.append(avatarCol, bodyCol);
    article.replaceChildren(row);
  }

  function renderMessages(): void {
    const distFromBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    const nearBottom = distFromBottom < 90;
    const previousTop = scrollEl.scrollTop;
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.actionKey : undefined;

    const ordered = orderConversation(appState.messages.values());
    if (!ordered.length && appState.messages.size === 0) {
      knownMessageIds.clear();
      hasRenderedMessages = false;
    }
    const isInitialRender = !hasRenderedMessages;

    const filtered = filterConversationMessages(ordered, appState.messages, {
      channel: channelFilter,
      hideSystem,
    });
    renderFilterControls(ordered, filtered.hiddenSystemCount, filtered.hiddenChannelCount);

    let latestAssistantId: string | undefined;
    for (let i = ordered.length - 1; i >= 0; i--) {
      const candidate = ordered[i];
      if (candidate && candidate.role === 'assistant' && candidate.source !== 'system') {
        latestAssistantId = candidate.id;
        break;
      }
    }

    const workMap = buildWorkMap();
    const quoteIndex = buildQuoteLookupIndex(ordered);

    const keptLiveIds = new Set<string>();
    const usedArticleIds = new Set<string>();
    const usedDividerKeys = new Set<string>();
    const desiredNodes: HTMLElement[] = [];
    let newlyAddedVisible = 0;

    for (let i = 0; i < filtered.visible.length; i++) {
      const message = filtered.visible[i]!;
      const prevVisible = i > 0 ? filtered.visible[i - 1] : undefined;
      const systemNotice = message.source === 'system';

      if (shouldShowTimeDivider(prevVisible, message)) {
        const dividerKey = `div:${message.id}`;
        const label = formatTimeDivider(message.at);
        usedDividerKeys.add(dividerKey);
        let divEntry = renderedDividers.get(dividerKey);
        if (!divEntry) {
          const el = node('div', '', 'time-divider');
          el.append(node('span', label, 'time-divider-label'));
          divEntry = { el, label };
          renderedDividers.set(dividerKey, divEntry);
        } else if (divEntry.label !== label) {
          const labelSpan = divEntry.el.firstElementChild;
          if (labelSpan) labelSpan.textContent = label;
          divEntry.label = label;
        }
        desiredNodes.push(divEntry.el);
      }

      const isEntering = !isInitialRender && !knownMessageIds.has(message.id);
      if (isEntering) newlyAddedVisible++;
      knownMessageIds.add(message.id);

      const isLatestAssistant = message.id === latestAssistantId;
      if (message.role === 'assistant' && !systemNotice && (active(message.status) || isLatestAssistant)) {
        keptLiveIds.add(message.id);
      }

      const isGrouped = isGroupedWithPrevious(prevVisible, message);
      const showReplyRef = !systemNotice && shouldShowReplyReference(message, prevVisible, detailMode);
      const replySource = message.replyTo ? appState.messages.get(message.replyTo) : undefined;
      const replySourceClean = replySource ? stripLeadingQuoteForPreview(replySource.text) : '';
      const replySourcePreview = replySourceClean.slice(0, 72);
      const channel = resolveMessageChannel(message, appState.messages);
      const parsedQuote = !systemNotice && message.role === 'user' ? extractLeadingQuote(message.text) : undefined;
      const quoteJumpId = parsedQuote && !parsedQuote.uncached
        ? findQuotedJumpTargetId(message, parsedQuote.label, parsedQuote.preview, quoteIndex)
        : undefined;

      const sigOpts = {
        isLatestAssistant,
        isGrouped,
        showReplyRef,
        replySourcePreview,
        channel,
        quoteJumpId,
        workMap,
      };
      const sig = buildMessageSignature(message, sigOpts);
      const onBeforeMatchReveal = () => {
        const currentEntry = renderedArticles.get(message.id);
        if (currentEntry) {
          currentEntry.sig = buildMessageSignature(message, { ...sigOpts, workMap: buildWorkMap() });
        }
      };

      usedArticleIds.add(message.id);
      let entry = renderedArticles.get(message.id);
      if (!entry) {
        const el = node('article', '', 'message');
        el.dataset.messageId = message.id;
        el.dataset.seq = String(message.seq);
        if (message.replyTo) el.dataset.replyTo = message.replyTo;
        if (systemNotice) {
          populateSystemArticle(el, message, workMap, onBeforeMatchReveal);
        } else if (message.role === 'user') {
          populateUserArticle(el, message, channel, isGrouped, parsedQuote, quoteJumpId, workMap, onBeforeMatchReveal);
        } else {
          populateAssistantArticle(el, message, {
            isLatestAssistant,
            isGrouped,
            showReplyRef,
            replySourceText: replySourceClean,
            channel,
            workMap,
            onBeforeMatchReveal,
          });
        }
        if (isEntering) el.classList.add('is-entering');
        entry = { el, sig };
        renderedArticles.set(message.id, entry);
      } else if (entry.sig !== sig) {
        entry.el.dataset.seq = String(message.seq);
        if (message.replyTo) entry.el.dataset.replyTo = message.replyTo;
        else delete entry.el.dataset.replyTo;
        if (systemNotice) {
          populateSystemArticle(entry.el, message, workMap, onBeforeMatchReveal);
        } else if (message.role === 'user') {
          populateUserArticle(entry.el, message, channel, isGrouped, parsedQuote, quoteJumpId, workMap, onBeforeMatchReveal);
        } else {
          populateAssistantArticle(entry.el, message, {
            isLatestAssistant,
            isGrouped,
            showReplyRef,
            replySourceText: replySourceClean,
            channel,
            workMap,
            onBeforeMatchReveal,
          });
        }
        entry.sig = sig;
      }

      desiredNodes.push(entry.el);
    }

    // Reclaim obsolete cached articles, dividers, and live avatar timers.
    for (const [id, entry] of renderedArticles) {
      if (!usedArticleIds.has(id)) {
        entry.el.remove();
        renderedArticles.delete(id);
      }
    }
    for (const [key, div] of renderedDividers) {
      if (!usedDividerKeys.has(key)) {
        div.el.remove();
        renderedDividers.delete(key);
      }
    }
    for (const [id, ctrl] of liveMessageAvatars) {
      if (!keptLiveIds.has(id)) {
        ctrl.destroy();
        liveMessageAvatars.delete(id);
      }
    }

    if (ordered.length > 0) hasRenderedMessages = true;

    if (!desiredNodes.length) {
      emptyStateNotice = node('div', '', 'conv-empty-state');
      if (ordered.length === 0) {
        emptyStateNotice.append(node('p', '从这里开始。直接描述目标，F.R.I.D.A.Y. 会在同一个对话中持续回复。', 'empty'));
      } else {
        emptyStateNotice.append(
          node('p', '当前筛选条件下没有可显示的消息。', 'empty'),
          button('显示全部消息', () => {
            channelFilter = 'all';
            hideSystem = false;
            writeStoredString(STORAGE_KEY_CHANNEL, 'all');
            writeStoredString(STORAGE_KEY_HIDE_SYSTEM, 'false');
            renderMessages();
            announceStatus('已恢复显示全部会话消息');
          }, 'mini-button'),
        );
      }
      messagesEl.replaceChildren(emptyStateNotice);
    } else {
      if (emptyStateNotice && emptyStateNotice.parentNode === messagesEl) {
        emptyStateNotice.remove();
        emptyStateNotice = undefined;
      }
      for (let i = 0; i < desiredNodes.length; i++) {
        const expected = desiredNodes[i]!;
        const currentAt = messagesEl.children[i] ?? null;
        if (currentAt !== expected) {
          moveElementPreservingState(messagesEl, expected, currentAt);
        }
      }
      while (messagesEl.children.length > desiredNodes.length) {
        messagesEl.lastElementChild?.remove();
      }
    }

    syncOlderButton();
    if (focus) {
      const replacement = [...messagesEl.querySelectorAll<HTMLButtonElement>('button')].find(item => item.dataset.actionKey === focus);
      safeFocus(replacement, { preventScroll: true });
    }

    if (nearBottom) {
      setScrollTopProgrammatic(scrollEl.scrollHeight);
      unreadWhileScrolledUp = 0;
    } else {
      setScrollTopProgrammatic(previousTop);
      if (newlyAddedVisible > 0) {
        unreadWhileScrolledUp += newlyAddedVisible;
      }
    }
    syncScrollBottomButton();
    renderRoutingDetail();
    updateCompanionStatus(lastBotState);
  }

  function renderBossDecisionDock(): void {
    const pendingWorks = (appState.view?.works ?? []).filter(
      work => Boolean(work.pendingQuestion) && (active(work.status) || work.status === 'paused' || work.status === 'waiting_decision'),
    );
    if (!pendingWorks.length) {
      bossDecisionDockEl.hidden = true;
      bossDecisionDockEl.replaceChildren();
      return;
    }

    const frag = document.createDocumentFragment();
    for (const work of pendingWorks.slice(0, 2)) {
      const pq = work.pendingQuestion!;
      const card = node('div', '', 'boss-decision-card');
      const head = node('div', '', 'boss-decision-head');
      head.append(
        node('span', '⏳ 等待老板拍板', 'boss-decision-badge'),
        node('span', work.prompt || '后台任务请示', 'boss-decision-task'),
        button('查看任务 ↗', () => {
          hooks.selectTrace({ type: 'task', id: work.id, label: work.prompt || '后台任务' });
          hooks.showPanel(true);
        }, 'mini-button'),
      );
      card.append(head, node('p', pq.question, 'boss-decision-question'));

      if (pq.options?.length) {
        const optRow = node('div', '', 'boss-decision-options');
        for (const opt of pq.options) {
          const optBtn = button(opt, () => {
            void sendDirectText(opt);
          }, 'mini-button boss-decision-opt-btn');
          optBtn.disabled = !appState.ready || appState.authExpired || appState.sending || appState.uncertain;
          optRow.append(optBtn);
        }
        card.append(optRow);
      }
      frag.append(card);
    }

    bossDecisionDockEl.hidden = false;
    bossDecisionDockEl.replaceChildren(frag);
  }

  async function jumpMessage(id: string): Promise<void> {
    try {
      if (!appState.messages.has(id)) {
        mergeMessages([await api<ChatMessage>(`/api/message?${new URLSearchParams({ messageId: id })}`)]);
        renderMessages();
      }
      let target = [...messagesEl.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.dataset.messageId === id);
      if (!target && (channelFilter !== 'all' || hideSystem)) {
        channelFilter = 'all';
        hideSystem = false;
        writeStoredString(STORAGE_KEY_CHANNEL, 'all');
        writeStoredString(STORAGE_KEY_HIDE_SYSTEM, 'false');
        renderMessages();
        target = [...messagesEl.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.dataset.messageId === id);
      }
      hooks.showPanel(false);
      if (target) {
        suppressAutoLoadUntil = Date.now() + 700;
        const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth';
        if (typeof target.scrollIntoView === 'function') {
          const ret = target.scrollIntoView({ behavior, block: 'center' }) as unknown;
          if (ret && typeof (ret as Promise<unknown>).then === 'function') {
            await (ret as Promise<unknown>);
          }
        } else if (typeof target.getBoundingClientRect === 'function' && typeof scrollEl.getBoundingClientRect === 'function') {
          setScrollTopProgrammatic(
            scrollEl.scrollTop + target.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - 16,
          );
        }
        if (!safeHasAttr(target, 'tabindex')) {
          target.setAttribute('tabindex', '-1');
        }
        safeFocus(target, { preventScroll: true });
        target.classList.add('message-highlight');
        setTimeout(() => target?.classList.remove('message-highlight'), 2000);
      }
    } catch (error) {
      hooks.connection(`来源消息读取失败：${errorText(error)}`, true);
    }
  }

  function maybeAutoLoadOlder(allowUnscrollable = false): void {
    if (!appState.historyHasMore || appState.historyBusy || appState.historyBefore === undefined) return;
    if (appState.authExpired || !hasRenderedMessages || historyAutoLoadPaused) return;
    const now = Date.now();
    if (now < suppressAutoLoadUntil || now - lastOlderAutoLoadAt < AUTO_LOAD_OLDER_COOLDOWN_MS) return;
    const scrollable = scrollEl.scrollHeight > scrollEl.clientHeight + 24;
    if (!scrollable && !allowUnscrollable) return;
    if (scrollEl.scrollTop > AUTO_LOAD_OLDER_THRESHOLD_PX) return;
    void loadOlder('auto');
  }

  let olderAbort: AbortController | undefined;

  async function loadOlder(trigger: 'auto' | 'manual' = 'manual'): Promise<void> {
    if (appState.historyBusy || appState.historyBefore === undefined) return;
    if (trigger === 'auto' && !appState.historyHasMore) return;
    const beforeAtStart = appState.historyBefore;
    const cursorAtStart = appState.cursor;
    appState.historyBusy = true;
    historyAutoLoadPaused = false;
    syncOlderButton('loading');
    safeRemoveAttr(historyErrorEl, 'role');
    historyErrorEl.textContent = '';
    olderAbort?.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
    olderAbort = controller;
    try {
      const page = await api<MessagePage>(`/api/history?before=${beforeAtStart}`, undefined, {
        signal: controller?.signal,
        ...(trigger === 'auto' ? { priority: 'low' as const } : {}),
      });
      if (controller?.signal.aborted || appState.authExpired || appState.cursor < cursorAtStart || appState.historyBefore !== beforeAtStart) return;
      const preRenderHeight = scrollEl.scrollHeight;
      const preRenderTop = Math.max(0, scrollEl.scrollTop);
      for (const item of page.items) knownMessageIds.add(item.id);
      mergeMessages(page.items);
      appState.historyBefore = page.before;
      appState.historyHasMore = page.hasMore;
      historyAutoLoadPaused = false;
      renderMessages();
      const heightDelta = Math.max(0, scrollEl.scrollHeight - preRenderHeight);
      setScrollTopProgrammatic(preRenderTop + heightDelta);
      syncScrollBottomButton();
    } catch (error) {
      if (controller?.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
      historyAutoLoadPaused = true;
      historyErrorEl.setAttribute('role', 'alert');
      historyErrorEl.textContent = `更早消息读取失败：${errorText(error)}。可点击上方重试。`;
    } finally {
      if (olderAbort === controller) olderAbort = undefined;
      appState.historyBusy = false;
      lastOlderAutoLoadAt = Date.now();
      syncOlderButton(historyAutoLoadPaused ? 'error' : 'idle');
    }
  }

  async function sendDirectText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || appState.sending || !appState.ready || appState.authExpired || appState.uncertain) return;
    let payload: { requestId: string; text: string; files: string[] };
    try {
      payload = { requestId: makeRequestId(), text: trimmed, files: [] };
    } catch (error) {
      setSendFeedback(`发送失败：${errorText(error)}`, 'error');
      return;
    }
    appState.sending = true;
    setSendFeedback('', 'clear');
    updateComposer();
    try {
      const accepted = await api<ChatMessage>('/api/chat', payload);
      mergeMessages([accepted]);
      unreadWhileScrolledUp = 0;
      renderMessages();
      hooks.selectTrace({ type: 'message', id: accepted.id, label: trimmed.slice(0, 80) });
      setScrollTopProgrammatic(scrollEl.scrollHeight);
      syncScrollBottomButton();
      hooks.scheduleRefresh();
    } catch (error) {
      setSendFeedback(`快捷回复发送失败：${errorText(error)}`, 'error');
    } finally {
      appState.sending = false;
      updateComposer();
    }
  }

  async function send(): Promise<void> {
    if (appState.sending || !appState.ready || appState.authExpired) return;
    if (!appState.uncertain) {
      const text = draftEl.value.trim();
      if (!text) return;
      const files: string[] = [];
      try {
        appState.pending = { requestId: makeRequestId(), text, files };
      } catch (error) {
        setSendFeedback(`发送失败，草稿已保留：${errorText(error)}`, 'error');
        return;
      }
    }
    if (!appState.pending) return;
    const submitted = appState.pending;
    appState.sending = true;
    setSendFeedback('', 'clear');
    updateComposer();
    try {
      const accepted = await api<ChatMessage>('/api/chat', submitted);
      mergeMessages([accepted]);
      appState.pending = undefined;
      appState.uncertain = false;
      draftEl.value = '';
      setDraftTyping(false);
      setEmoteTrayOpen(false);
      unreadWhileScrolledUp = 0;
      renderMessages();
      hooks.selectTrace({ type: 'message', id: accepted.id, label: submitted.text.slice(0, 80) });
      setScrollTopProgrammatic(scrollEl.scrollHeight);
      syncScrollBottomButton();
      hooks.scheduleRefresh();
    } catch (error) {
      const confirmed = [...appState.messages.values()].some(message => message.requestId === submitted.requestId);
      if (confirmed) {
        appState.pending = undefined;
        appState.uncertain = false;
        draftEl.value = '';
        setDraftTyping(false);
        setEmoteTrayOpen(false);
        setSendFeedback('已从持久记录确认接收，无需重发。', 'status');
        return;
      }
      appState.uncertain = !(error instanceof ApiError) || error.status >= 500;
      if (!appState.uncertain) appState.pending = undefined;
      setSendFeedback(
        appState.uncertain
          ? `接收结果未确认：${errorText(error)}。草稿已保留并锁定；点击“重试原请求”会使用同一请求标识，不自动重发。`
          : `发送失败，草稿已保留：${errorText(error)}`,
        'error',
      );
    } finally {
      appState.sending = false;
      updateComposer();
    }
  }

  async function stopMessage(id: string): Promise<void> {
    const key = `message:${id}`;
    appState.stopRequests.add(key);
    renderMessages();
    try {
      await api<unknown>('/api/chat-stop', { messageId: id });
      hooks.connection('已请求停止本轮回复；以最终记录为准。其他后台工作不受影响。');
      hooks.scheduleRefresh();
    } catch (error) {
      appState.stopRequests.delete(key);
      renderMessages();
      hooks.connection(`停止请求未确认：${errorText(error)}。可再次请求；本轮回复不一定已停止。`, true);
    }
  }

  attachDelayedFormValidation(composerEl);
  sendBtn.addEventListener('pointerdown', event => {
    if (!sendBtn.disabled) event.preventDefault();
  });
  composerEl.addEventListener('submit', event => {
    event.preventDefault();
    void send();
  });
  draftEl.addEventListener('input', () => {
    setDraftTyping(draftEl.value.trim().length > 0);
    updateComposer();
  });
  draftEl.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !isImeComposing(event)) {
      event.preventDefault();
      if (typeof composerEl.requestSubmit === 'function') {
        composerEl.requestSubmit();
      } else {
        void send();
      }
    }
  });
  draftEl.addEventListener('blur', () => {
    setTimeout(() => {
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
      }
    }, 60);
  });

  scrollEl.addEventListener('scroll', () => {
    const near = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 90;
    resizePinned = near;
    if (near) {
      unreadWhileScrolledUp = 0;
      suppressAutoLoadUntil = 0;
    }
    syncScrollBottomButton();

    if (programmaticScrollTop !== undefined && Math.abs(scrollEl.scrollTop - programmaticScrollTop) > 2) {
      programmaticScrollTop = undefined;
      programmaticScrollUntil = 0;
    }
    if (historyAutoLoadPaused && scrollEl.scrollTop > AUTO_LOAD_OLDER_THRESHOLD_PX + 80) {
      historyAutoLoadPaused = false;
      syncOlderButton('idle');
    }
  }, { passive: true });

  onScrollEnd(scrollEl, () => {
    if (
      programmaticScrollTop !== undefined
      && Date.now() <= programmaticScrollUntil
      && Math.abs(scrollEl.scrollTop - programmaticScrollTop) <= 2
    ) {
      programmaticScrollTop = undefined;
      programmaticScrollUntil = 0;
      return;
    }
    programmaticScrollTop = undefined;
    programmaticScrollUntil = 0;
    maybeAutoLoadOlder(false);
  });
  window.addEventListener('resize', () => {
    // A viewport change must not leave the newest reply clipped under the composer when already near bottom.
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      if (resizePinned) setScrollTopProgrammatic(scrollEl.scrollHeight);
      syncScrollBottomButton();
    }, 120);
  });

  if (typeof window !== 'undefined' && window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (resizePinned) setScrollTopProgrammatic(scrollEl.scrollHeight);
      syncScrollBottomButton();
    }, { passive: true });
  }

  let pullStartX = 0;
  let pullStartY = 0;
  let pullStartedAtTop = false;
  scrollEl.addEventListener('touchstart', event => {
    if (!event.touches || event.touches.length !== 1 || scrollEl.scrollTop > 2) {
      pullStartedAtTop = false;
      return;
    }
    const touch = event.touches[0];
    if (!touch) {
      pullStartedAtTop = false;
      return;
    }
    pullStartX = touch.clientX;
    pullStartY = touch.clientY;
    pullStartedAtTop = true;
  }, { passive: true });

  scrollEl.addEventListener('touchend', event => {
    if (!pullStartedAtTop) return;
    pullStartedAtTop = false;
    const touch = event.changedTouches?.[0];
    if (!touch || (event.changedTouches?.length ?? 0) !== 1) return;
    const dy = touch.clientY - pullStartY;
    const dx = touch.clientX - pullStartX;
    if (dy >= PULL_TO_LOAD_MIN_DY_PX && Math.abs(dy) > Math.abs(dx) * 1.5 && scrollEl.scrollTop <= AUTO_LOAD_OLDER_THRESHOLD_PX) {
      maybeAutoLoadOlder(true);
    }
  }, { passive: true });

  scrollEl.addEventListener('wheel', event => {
    if (scrollEl.scrollHeight <= scrollEl.clientHeight + 24 && scrollEl.scrollTop <= 2 && event.deltaY < -24) {
      maybeAutoLoadOlder(true);
    }
  }, { passive: true });

  olderBtn.addEventListener('click', () => { void loadOlder('manual'); });

  return {
    updateComposer,
    mergeMessages,
    hydrateParents,
    renderMessages,
    renderRoutingDetail,
    jumpMessage,
    isDraftTyping: () => draftTypingActive,
    updateCompanionStatus,
    renderBossDecisionDock,
  };
}

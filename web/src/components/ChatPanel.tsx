import type { ChatMessage, RouteAction, WorkView } from '@friday/view.js';
import { activeStatus, routeLabel, routeState } from '@friday/web/model.js';
import { BOT_EXPRESSION_META, BOT_EXPRESSIONS, inferMessageBotExpression, type BotExpression } from '@friday/web/shared/bot-expressions.js';
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
} from '@friday/web/shared/chat-view.js';
import { statusText, timestamp } from '@friday/web/shared/format.js';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  CheckIcon,
  FilterIcon,
  GitBranchIcon,
  RotateCcwIcon,
  SmileIcon,
  SquareIcon,
  SlidersHorizontalIcon,
  EyeOffIcon,
  EyeIcon,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CompanionAvatar, StaticBotAvatar } from '@/components/CompanionAvatar';
import { MarkdownContent } from '@/components/MarkdownContent';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Composer,
  ComposerActionGroup,
  ComposerActions,
  ComposerInput,
  ComposerSubmit,
  type ComposerValue,
} from '@/components/ui/composer';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { useFriday } from '@/lib/friday-store';
import { cn } from '@/lib/utils';

const AUTO_LOAD_OLDER_THRESHOLD_PX = 80;
const AUTO_LOAD_OLDER_COOLDOWN_MS = 1200;

function MessageCopyBtn({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore
    }
  };
  return (
    <Button type="button" size="xs" variant="ghost" onClick={() => void handleCopy()}>
      {copied ? <CheckIcon className="size-3 text-success-foreground" /> : <CopyIcon className="size-3" />}
      <span>{copied ? '已复制' : label}</span>
    </Button>
  );
}

function RoutingSummaryBlock({
  message,
  detailMode,
  worksById,
  onSelectTask,
  onOpenRoutingDetail,
}: {
  message: ChatMessage;
  detailMode: boolean;
  worksById: ReadonlyMap<string, WorkView>;
  onSelectTask: (taskId: string, label: string) => void;
  onOpenRoutingDetail: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const model = classifyRoutingDisplay(message, detailMode);
  if (!model.visible) return null;

  const renderActionChip = (action: RouteAction) => {
    const label = formatActionShortLabel(action);
    const work = action.taskId ? worksById.get(action.taskId) : undefined;
    const isTaskTarget = Boolean(action.taskId);
    const isErr = action.status === 'failed' || action.status === 'interrupted';

    if (isTaskTarget) {
      return (
        <button
          key={action.id}
          type="button"
          className={cn(
            'route-target inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-accent',
            isErr
              ? 'border-destructive/30 bg-destructive/8 text-destructive-foreground'
              : 'border-border bg-background text-foreground',
          )}
          onClick={() => onSelectTask(action.taskId!, action.taskLabel || work?.prompt || label)}
        >
          <span>{label}</span>
          {work && <span className="text-muted-foreground">· {statusText(work.status)}</span>}
        </button>
      );
    }

    return (
      <Badge key={action.id} size="sm" variant={isErr ? 'error' : 'outline'}>
        {label}
      </Badge>
    );
  };

  return (
    <div className="routing-summary mt-2 flex flex-col gap-1.5 rounded-lg border bg-background/70 px-2.5 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        {model.taskActions.map(renderActionChip)}
        {model.metaActions.map(renderActionChip)}
        {model.pendingText && <span className="text-muted-foreground">{model.pendingText}</span>}
        {model.warningText && (
          <Badge size="sm" variant="warning">
            {model.warningText}
          </Badge>
        )}
        {model.hasExpandableDetails && (
          <button
            type="button"
            className="route-expand-btn ms-auto inline-flex cursor-pointer items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-expanded={expanded}
            onClick={() => setExpanded(prev => !prev)}
          >
            <span>{expanded ? '收起详情' : '详情'}</span>
            {expanded ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
          </button>
        )}
        {detailMode && (
          <button
            type="button"
            className="route-expand-btn inline-flex cursor-pointer items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onOpenRoutingDetail}
          >
            路由上下文
          </button>
        )}
      </div>

      {expanded && (
        <div className="space-y-1 border-t pt-1.5 text-[11px] text-muted-foreground">
          {[...model.taskActions, ...model.metaActions].map(action => (
            <div key={action.id} className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium text-foreground">{routeLabel(action)}</span>
              <span>· {routeState(action)}</span>
              {action.workerProfile && <span>· 画像:{action.workerProfile}</span>}
              {action.workerModel && <span>· 模型:{action.workerModel}</span>}
              {action.summary && <span className="text-foreground/80">— {action.summary}</span>}
              {action.error && <span className="text-destructive-foreground">— {action.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AttachmentAndPathChips({ message }: { message: ChatMessage }) {
  if (!message.attachments?.length && !message.paths.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {message.attachments?.map((att, idx) => (
        <Badge key={`att-${idx}`} size="sm" variant={att.status === 'failed' ? 'error' : 'secondary'}>
          <span>{att.name}</span>
          {att.bytes ? <span className="opacity-70">({formatByteSize(att.bytes)})</span> : null}
        </Badge>
      ))}
      {message.paths.map((p, idx) => (
        <Badge key={`path-${idx}`} size="sm" variant="outline" className="font-mono max-w-full truncate">
          {p}
        </Badge>
      ))}
    </div>
  );
}

function SystemMessageCard({
  message,
  onJump,
}: {
  message: ChatMessage;
  onJump: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = summarizeSystemNotice(message);
  return (
    <article
      data-message-id={message.id}
      data-seq={message.seq}
      data-reply-to={message.replyTo ?? ''}
      className="message system-message mx-auto w-full max-w-2xl rounded-lg border bg-muted/35 px-3 py-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden="true">{summary.icon}</span>
        <Badge size="sm" variant="outline">{summary.badge}</Badge>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{summary.title}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{formatShortClock(message.at)}</span>
        {summary.expandable && (
          <button
            type="button"
            className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setExpanded(prev => !prev)}
          >
            {expanded ? '收起' : '展开'}
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-2 border-t pt-2 space-y-1.5">
          <MarkdownContent text={message.text} mode="assistant" />
          <AttachmentAndPathChips message={message} />
          {message.replyTo && (
            <button
              type="button"
              className="source-reference text-[11px] text-info-foreground hover:underline"
              onClick={() => onJump(message.replyTo!)}
            >
              跳转来源消息 ↗
            </button>
          )}
        </div>
      )}
    </article>
  );
}

export function ChatPanel() {
  const {
    ready,
    authExpired,
    view,
    messagesMap,
    orderedMessages,
    historyHasMore,
    historyBusy,
    historyError,
    loadOlder,
    sending,
    uncertain,
    pending,
    sendFeedback,
    sendDraft,
    sendDirectText,
    stopMessage,
    stopRequests,
    setDraftTyping,
    channelFilter,
    setChannelFilter,
    hideSystem,
    setHideSystem,
    detailMode,
    setDetailMode,
    works,
    selection,
    selectTrace,
    setMobilePanel,
    setRoutingDetailMessageId,
    botState,
    activeHub,
    routingDetailMessageId,
    commandOpen,
    jumpTarget,
    jumpMessage,
  } = useFriday();

  const [composerValue, setComposerValue] = useState<ComposerValue>([]);
  const [emoteOpen, setEmoteOpen] = useState(false);
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nearBottom, setNearBottom] = useState(true);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const scrollElRef = useRef<HTMLDivElement>(null);
  const scrollStateRef = useRef({
    nearBottom: true,
    prevMsgCount: 0,
    pendingAnchorHeight: null as number | null,
    pendingAnchorTop: 0,
    lastOlderAutoAt: 0,
    suppressAutoLoadUntil: 0,
    programmaticScroll: false,
  });

  const worksById = useMemo(() => new Map(works.map(w => [w.id, w])), [works]);
  const activeWorksCount = useMemo(() => works.filter(w => activeStatus(w.status)).length, [works]);
  const pendingBossWorks = useMemo(
    () => works.filter(w => Boolean(w.pendingQuestion) && (activeStatus(w.status) || w.status === 'paused' || w.status === 'waiting_decision')),
    [works],
  );
  const companionPill = useMemo(
    () => deriveCompanionStatus(botState, activeWorksCount, pendingBossWorks.length),
    [activeWorksCount, botState, pendingBossWorks.length],
  );

  const configuredPlatforms = useMemo(() => view?.imChannels?.map(c => c.platform) ?? [], [view]);
  const availableChannels = useMemo(
    () => collectAvailableChannels(orderedMessages, messagesMap, configuredPlatforms),
    [configuredPlatforms, messagesMap, orderedMessages],
  );

  const { visible, hiddenSystemCount, hiddenChannelCount } = useMemo(
    () => filterConversationMessages(orderedMessages, messagesMap, { channel: channelFilter, hideSystem }),
    [channelFilter, hideSystem, messagesMap, orderedMessages],
  );

  // Sync draft when uncertain pending request exists
  useEffect(() => {
    if (uncertain && pending) {
      setComposerValue([{ type: 'text', text: pending.text }]);
    }
  }, [pending, uncertain]);

  const draftText = useMemo(
    () => composerValue.map(p => (p.type === 'text' ? p.text : p.text ?? '')).join(''),
    [composerValue],
  );

  useEffect(() => {
    setDraftTyping(draftText.trim().length > 0);
  }, [draftText, setDraftTyping]);

  // Trigger manual or auto loadOlder with scroll anchor preservation
  const handleLoadOlder = useCallback(async (trigger: 'auto' | 'manual') => {
    const scroller = scrollElRef.current;
    if (!scroller || historyBusy || !historyHasMore) return;
    scrollStateRef.current.pendingAnchorHeight = scroller.scrollHeight;
    scrollStateRef.current.pendingAnchorTop = Math.max(0, scroller.scrollTop);
    const loaded = await loadOlder(trigger);
    if (loaded === 0) {
      scrollStateRef.current.pendingAnchorHeight = null;
    }
  }, [historyBusy, historyHasMore, loadOlder]);

  // Restore scroll position after prepending older messages or stick to bottom on new messages
  useLayoutEffect(() => {
    const scroller = scrollElRef.current;
    if (!scroller) return;
    const state = scrollStateRef.current;
    if (state.pendingAnchorHeight !== null) {
      const delta = Math.max(0, scroller.scrollHeight - state.pendingAnchorHeight);
      state.programmaticScroll = true;
      scroller.scrollTop = state.pendingAnchorTop + delta;
      state.pendingAnchorHeight = null;
      requestAnimationFrame(() => { state.programmaticScroll = false; });
    } else if (visible.length > state.prevMsgCount) {
      if (state.prevMsgCount === 0 || state.nearBottom) {
        state.programmaticScroll = true;
        scroller.scrollTop = scroller.scrollHeight;
        setUnreadCount(0);
        requestAnimationFrame(() => { state.programmaticScroll = false; });
      } else {
        setUnreadCount(prev => prev + (visible.length - state.prevMsgCount));
      }
    }
    state.prevMsgCount = visible.length;
  }, [visible.length]);

  // Handle jumpMessage target
  useEffect(() => {
    if (!jumpTarget) return;
    const scroller = scrollElRef.current;
    if (!scroller) return;
    const target = scroller.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(jumpTarget.id)}"]`);
    if (!target) return;
    scrollStateRef.current.suppressAutoLoadUntil = Date.now() + 700;
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    setHighlightedId(jumpTarget.id);
    const timer = setTimeout(() => setHighlightedId(prev => (prev === jumpTarget.id ? null : prev)), 2000);
    return () => clearTimeout(timer);
  }, [jumpTarget, visible.length]);

  const handleScroll = () => {
    const scroller = scrollElRef.current;
    if (!scroller) return;
    const state = scrollStateRef.current;
    const isNear = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
    state.nearBottom = isNear;
    setNearBottom(isNear);
    if (isNear) {
      setUnreadCount(0);
      state.suppressAutoLoadUntil = 0;
    }
    if (
      !state.programmaticScroll
      && historyHasMore
      && !historyBusy
      && !historyError
      && scroller.scrollTop <= AUTO_LOAD_OLDER_THRESHOLD_PX
      && scroller.scrollHeight > scroller.clientHeight + 24
    ) {
      const now = Date.now();
      if (now >= state.suppressAutoLoadUntil && now - state.lastOlderAutoAt >= AUTO_LOAD_OLDER_COOLDOWN_MS) {
        state.lastOlderAutoAt = now;
        void handleLoadOlder('auto');
      }
    }
  };

  const handleComposerSubmit = async () => {
    const ok = await sendDraft(draftText);
    if (ok) {
      setComposerValue([]);
      setEmoteOpen(false);
      scrollStateRef.current.nearBottom = true;
      setNearBottom(true);
      setUnreadCount(0);
      requestAnimationFrame(() => {
        if (scrollElRef.current) {
          scrollElRef.current.scrollTop = scrollElRef.current.scrollHeight;
        }
      });
    }
  };

  const insertEmote = (expr: BotExpression) => {
    const tag = `[bot:${expr}]`;
    const draftEl = document.getElementById('draft') as HTMLTextAreaElement | null;
    if (draftEl && typeof draftEl.selectionStart === 'number') {
      const start = draftEl.selectionStart;
      const end = draftEl.selectionEnd ?? start;
      const next = `${draftText.slice(0, start)}${tag}${draftText.slice(end)}`;
      setComposerValue(next ? [{ type: 'text', text: next }] : []);
      requestAnimationFrame(() => {
        const pos = start + tag.length;
        draftEl.focus();
        draftEl.setSelectionRange(pos, pos);
      });
    } else {
      const next = `${draftText}${tag}`;
      setComposerValue([{ type: 'text', text: next }]);
    }
    setEmoteOpen(false);
  };

  const modalPaused = Boolean(activeHub || routingDetailMessageId || commandOpen);

  return (
    <main id="main-content" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {/* Chat Header */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <CompanionAvatar botState={botState} paused={modalPaused} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold tracking-tight text-foreground">持续对话</h1>
              <Badge
                size="sm"
                variant={
                  companionPill.tone === 'ok'
                    ? 'success'
                    : companionPill.tone === 'warn'
                      ? 'warning'
                      : companionPill.tone === 'err'
                        ? 'error'
                        : companionPill.tone === 'run'
                          ? 'info'
                          : 'secondary'
                }
              >
                {companionPill.text}
              </Badge>
            </div>
          </div>
        </div>

        {/* Desktop Channel & Mode Controls */}
        <div className="flex items-center gap-1.5">
          <div
            id="conv-channel-filters"
            className="hidden items-center gap-1 lg:flex"
            role="group"
            aria-label="渠道筛选"
          >
            {availableChannels.map(ch => {
              const meta = channelMeta(ch);
              const isActive = channelFilter === ch;
              return (
                <button
                  key={ch}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => setChannelFilter(ch)}
                  className={cn(
                    'conv-channel-chip inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border px-2 text-xs transition-colors',
                    isActive
                      ? 'active border-primary bg-primary text-primary-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <span>{meta.shortLabel}</span>
                </button>
              );
            })}
          </div>

          <Button
            id="conv-hide-system-btn"
            type="button"
            size="xs"
            variant={hideSystem ? 'secondary' : 'ghost'}
            aria-pressed={hideSystem}
            className="hidden sm:inline-flex"
            onClick={() => setHideSystem(!hideSystem)}
            title="隐藏系统通知消息"
          >
            {hideSystem ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
            <span>系统通知</span>
            {hiddenSystemCount > 0 && <Badge size="sm" variant="secondary">{hiddenSystemCount}</Badge>}
          </Button>

          <Button
            id="conv-detail-mode-btn"
            type="button"
            size="xs"
            variant={detailMode ? 'secondary' : 'ghost'}
            aria-pressed={detailMode}
            onClick={() => setDetailMode(!detailMode)}
            title="切换审计详情模式（展示路由与处理回执）"
          >
            <SlidersHorizontalIcon className="size-3.5" />
            <span>审计详情</span>
          </Button>

          <Popover open={filterPopoverOpen} onOpenChange={setFilterPopoverOpen}>
            <PopoverTrigger
              id="mobile-filter-btn"
              render={<Button type="button" size="xs" variant="outline" className="lg:hidden" />}
            >
              <FilterIcon className="size-3.5" />
              <span>筛选</span>
            </PopoverTrigger>
            <PopoverPopup align="end" className="w-64 space-y-3 p-3">
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted-foreground">消息渠道</div>
                <div className="flex flex-wrap gap-1">
                  {availableChannels.map(ch => {
                    const meta = channelMeta(ch);
                    const isActive = channelFilter === ch;
                    return (
                      <Button
                        key={ch}
                        type="button"
                        size="xs"
                        variant={isActive ? 'default' : 'outline'}
                        onClick={() => { setChannelFilter(ch); setFilterPopoverOpen(false); }}
                      >
                        {meta.shortLabel}
                      </Button>
                    );
                  })}
                </div>
              </div>
              <div className="flex items-center justify-between border-t pt-2">
                <span className="text-xs text-muted-foreground">隐藏系统通知</span>
                <Button size="xs" variant={hideSystem ? 'secondary' : 'outline'} onClick={() => setHideSystem(!hideSystem)}>
                  {hideSystem ? '已隐藏' : '显示中'}
                </Button>
              </div>
            </PopoverPopup>
          </Popover>
        </div>
      </div>

      {/* Scrollable Message Viewport */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollElRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto px-3 py-4 sm:px-6"
        >
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {/* Load older button */}
            <div className="flex flex-col items-center gap-1.5">
              <Button
                id="older"
                type="button"
                size="xs"
                variant="outline"
                hidden={!historyHasMore}
                disabled={historyBusy || authExpired}
                onClick={() => void handleLoadOlder('manual')}
              >
                <ArrowUpIcon className="size-3" />
                <span>{historyBusy ? '正在读取更早消息…' : '加载更早消息'}</span>
              </Button>
              {historyError && (
                <p role="alert" className="text-xs text-destructive-foreground">
                  {historyError}
                </p>
              )}
              {(hiddenChannelCount > 0 || hiddenSystemCount > 0) && (
                <p className="text-[11px] text-muted-foreground">
                  已筛选隐藏 {hiddenChannelCount + hiddenSystemCount} 条消息
                </p>
              )}
            </div>

            {/* Messages */}
            <div id="messages" className="flex flex-col gap-3">
              {visible.length === 0 ? (
                <Empty className="py-16">
                  <EmptyHeader>
                    <EmptyTitle className="text-base">
                      {ready ? '随时开始对话' : '连接本机服务中…'}
                    </EmptyTitle>
                    <EmptyDescription className="text-xs">
                      F.R.I.D.A.Y. 在单一持续对话中为你协同调度本地工具、记忆网络与并发子 AI。
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                visible.map((msg, idx) => {
                  const prev = idx > 0 ? visible[idx - 1] : undefined;
                  const showDivider = shouldShowTimeDivider(prev, msg);
                  const grouped = isGroupedWithPrevious(prev, msg);
                  const isHighlighted = highlightedId === msg.id;

                  return (
                    <div key={msg.id} className="flex flex-col gap-2">
                      {showDivider && (
                        <div className="my-1 flex items-center justify-center">
                          <span className="rounded-full border bg-muted/40 px-2.5 py-0.5 text-[11px] text-muted-foreground">
                            {formatTimeDivider(msg.at)}
                          </span>
                        </div>
                      )}

                      {msg.source === 'system' ? (
                        <div className={cn(isHighlighted && 'message-highlight')}>
                          <SystemMessageCard message={msg} onJump={id => void jumpMessage(id)} />
                        </div>
                      ) : msg.role === 'user' ? (
                        <UserMessageArticle
                          message={msg}
                          grouped={grouped}
                          detailMode={detailMode}
                          selected={selection.type === 'message' && selection.id === msg.id}
                          highlighted={isHighlighted}
                          worksById={worksById}
                          onSelectTrace={() => {
                            selectTrace({ type: 'message', id: msg.id, label: msg.text.slice(0, 80) }, true);
                            setMobilePanel('trace');
                          }}
                          onSelectTask={(taskId, label) => {
                            selectTrace({ type: 'task', id: taskId, label }, true);
                            setMobilePanel('trace');
                          }}
                          onOpenRoutingDetail={() => setRoutingDetailMessageId(msg.id)}
                        />
                      ) : (
                        <AssistantMessageArticle
                          message={msg}
                          prevVisible={prev}
                          grouped={grouped}
                          detailMode={detailMode}
                          highlighted={isHighlighted}
                          messagesMap={messagesMap}
                          stopRequested={stopRequests.has(`message:${msg.id}`)}
                          authExpired={authExpired}
                          onStop={() => void stopMessage(msg.id)}
                          onJump={id => void jumpMessage(id)}
                          onSelectTrace={() => {
                            selectTrace({ type: 'message', id: msg.replyTo ?? msg.id, label: msg.text.slice(0, 80) }, true);
                            setMobilePanel('trace');
                          }}
                        />
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Scroll-to-bottom floating button */}
        {!nearBottom && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <Button
              type="button"
              size="xs"
              variant="secondary"
              className="pointer-events-auto rounded-full border shadow-md"
              onClick={() => {
                if (scrollElRef.current) {
                  scrollElRef.current.scrollTop = scrollElRef.current.scrollHeight;
                }
                setUnreadCount(0);
                setNearBottom(true);
              }}
            >
              <ArrowDownIcon className="size-3.5" />
              <span>{unreadCount > 0 ? `${unreadCount} 条新消息` : '回到底部'}</span>
            </Button>
          </div>
        )}
      </div>

      {/* Bottom Dock: Boss Decision + coss Composer */}
      <div className="shrink-0 border-t bg-background/95 px-3 py-2.5 sm:px-6">
        <div className="mx-auto max-w-3xl space-y-2">
          {/* ASK_BOSS pending question cards */}
          {pendingBossWorks.length > 0 && (
            <div className="space-y-2">
              {pendingBossWorks.slice(0, 2).map(work => {
                const pq = work.pendingQuestion!;
                return (
                  <div
                    key={work.id}
                    className="rounded-xl border border-warning/40 bg-warning/8 p-3 text-xs space-y-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge size="sm" variant="warning">⏳ 等待老板拍板</Badge>
                        <span className="truncate font-medium text-foreground">{work.prompt || '后台任务请示'}</span>
                      </div>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          selectTrace({ type: 'task', id: work.id, label: work.prompt || '后台任务' }, true);
                          setMobilePanel('trace');
                        }}
                      >
                        查看任务 ↗
                      </Button>
                    </div>
                    <p className="whitespace-pre-wrap text-sm text-foreground">{pq.question}</p>
                    {pq.options && pq.options.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {pq.options.map((opt, idx) => (
                          <Button
                            key={idx}
                            type="button"
                            size="xs"
                            variant="secondary"
                            disabled={!ready || authExpired || sending || uncertain}
                            onClick={() => void sendDirectText(opt)}
                          >
                            {opt}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Feedback banner */}
          {sendFeedback.text && (
            <p
              role={sendFeedback.tone === 'error' ? 'alert' : 'status'}
              className={cn(
                'text-xs',
                sendFeedback.tone === 'error' ? 'text-destructive-foreground' : 'text-muted-foreground',
              )}
            >
              {sendFeedback.text}
            </p>
          )}

          {/* Authentic coss Composer with <textarea id="draft"> */}
          <Composer
            value={composerValue}
            onValueChange={next => {
              if (uncertain) return;
              setComposerValue(next);
            }}
            onSubmit={() => void handleComposerSubmit()}
            disabled={!ready || authExpired}
            readOnly={uncertain}
            submitDisabled={sending || (!uncertain && !draftText.trim())}
            allowEmpty={uncertain}
            submitOnEnter="always"
          >
            <ComposerInput
              placeholder={
                authExpired
                  ? '访问链接已失效，请重新打开启动链接'
                  : ready
                    ? '向 F.R.I.D.A.Y. 发送指令…（Enter 发送，Shift+Enter 换行）'
                    : '正在连接本机服务…'
              }
              render={<textarea id="draft" rows={2} aria-label="输入对话内容" />}
            />
            <ComposerActions>
              <ComposerActionGroup align="start">
                <Popover open={emoteOpen} onOpenChange={setEmoteOpen}>
                  <PopoverTrigger
                    id="emote-toggle"
                    render={
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        disabled={!ready || authExpired || uncertain}
                        aria-label="插入表情"
                        title="插入 F.R.I.D.A.Y. 表情"
                      />
                    }
                  >
                    <SmileIcon className="size-4" />
                  </PopoverTrigger>
                  <PopoverPopup id="bot-emote-tray" align="start" side="top" className="w-72 p-2">
                    <div className="mb-1.5 text-xs font-medium text-muted-foreground">选择心情贴纸</div>
                    <div className="grid grid-cols-5 gap-1">
                      {BOT_EXPRESSIONS.map(expr => {
                        const meta = BOT_EXPRESSION_META[expr];
                        return (
                          <button
                            key={expr}
                            type="button"
                            title={meta.label}
                            onClick={() => insertEmote(expr)}
                            className="flex flex-col items-center gap-0.5 rounded-md p-1.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
                          >
                            <StaticBotAvatar expr={expr} size={24} />
                            <span className="truncate max-w-full">{meta.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </PopoverPopup>
                </Popover>
              </ComposerActionGroup>

              <ComposerActionGroup align="end">
                <span className="hidden text-[11px] text-muted-foreground sm:inline">
                  {uncertain ? '已保留请求标识' : 'Enter 发送 · Shift+Enter 换行'}
                </span>
                <ComposerSubmit
                  id="send"
                  render={
                    <Button
                      size="sm"
                      variant={uncertain ? 'destructive' : 'default'}
                      loading={sending}
                    />
                  }
                >
                  {uncertain ? (
                    <>
                      <RotateCcwIcon className="size-3.5" />
                      <span>重试原请求</span>
                    </>
                  ) : (
                    <>
                      <ArrowUpIcon className="size-3.5 send-arrow-icon" />
                      <span>发送</span>
                    </>
                  )}
                </ComposerSubmit>
              </ComposerActionGroup>
            </ComposerActions>
          </Composer>
        </div>
      </div>
    </main>
  );
}

function UserMessageArticle({
  message,
  grouped,
  detailMode,
  selected,
  highlighted,
  worksById,
  onSelectTrace,
  onSelectTask,
  onOpenRoutingDetail,
}: {
  message: ChatMessage;
  grouped: boolean;
  detailMode: boolean;
  selected: boolean;
  highlighted: boolean;
  worksById: ReadonlyMap<string, WorkView>;
  onSelectTrace: () => void;
  onSelectTask: (taskId: string, label: string) => void;
  onOpenRoutingDetail: () => void;
}) {
  const ch = resolveMessageChannel(message);
  const chMeta = channelMeta(ch);
  const parsedQuote = extractLeadingQuote(message.text);
  const displayText = parsedQuote ? (parsedQuote.body || message.text) : message.text;
  const settledBadge = detailMode && !activeStatus(message.status) ? ' · F.R.I.D.A.Y. 已处理' : '';

  return (
    <article
      data-message-id={message.id}
      data-seq={message.seq}
      data-reply-to={message.replyTo ?? ''}
      className={cn(
        'message user-message ms-auto flex max-w-[88%] flex-col items-end sm:max-w-[78%]',
        grouped && '-mt-1.5',
        highlighted && 'message-highlight',
      )}
    >
      {(!grouped || detailMode) && (
        <div className="mb-1 flex flex-wrap items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
          {ch !== 'local' && <Badge size="sm" variant="outline">{chMeta.shortLabel}</Badge>}
          {message.origin?.speakerName && (
            <Badge size="sm" variant="secondary" className="origin-speaker-badge">
              {message.origin.speakerName}
            </Badge>
          )}
          <span className="speaker font-medium text-foreground/80">
            你{settledBadge}
          </span>
          <span className="font-mono" title={timestamp(message.at)}>{formatShortClock(message.at)}</span>
        </div>
      )}

      <div
        className={cn(
          'w-full rounded-2xl rounded-tr-sm border bg-secondary/80 px-3.5 py-2.5 text-foreground shadow-2xs',
          selected && 'ring-2 ring-ring/40',
        )}
      >
        {parsedQuote && (
          <div className="mb-2 rounded-lg border-s-2 border-primary/50 bg-background/60 px-2.5 py-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground me-1">{parsedQuote.label}:</span>
            <span>{parsedQuote.preview}</span>
          </div>
        )}

        <MarkdownContent text={displayText} mode="user" />
        <AttachmentAndPathChips message={message} />
        <RoutingSummaryBlock
          message={message}
          detailMode={detailMode}
          worksById={worksById}
          onSelectTask={onSelectTask}
          onOpenRoutingDetail={onOpenRoutingDetail}
        />

        <div className="message-actions mt-1.5 flex flex-wrap items-center justify-end gap-1">
          <Button type="button" size="xs" variant="ghost" onClick={onOpenRoutingDetail}>
            <GitBranchIcon className="size-3" />
            <span>路由</span>
          </Button>
          <Button type="button" size="xs" variant="ghost" onClick={onSelectTrace}>
            <span>链路</span>
          </Button>
          <MessageCopyBtn text={message.text} />
        </div>
      </div>
    </article>
  );
}

function AssistantMessageArticle({
  message,
  prevVisible,
  grouped,
  detailMode,
  highlighted,
  messagesMap,
  stopRequested,
  authExpired,
  onStop,
  onJump,
  onSelectTrace,
}: {
  message: ChatMessage;
  prevVisible: ChatMessage | undefined;
  grouped: boolean;
  detailMode: boolean;
  highlighted: boolean;
  messagesMap: ReadonlyMap<string, ChatMessage>;
  stopRequested: boolean;
  authExpired: boolean;
  onStop: () => void;
  onJump: (id: string) => void;
  onSelectTrace: () => void;
}) {
  const showRef = shouldShowReplyReference(message, prevVisible, detailMode);
  const parentMsg = message.replyTo ? messagesMap.get(message.replyTo) : undefined;
  const isActive = activeStatus(message.status);
  const expr = inferMessageBotExpression(message.text) ?? (message.status === 'failed' ? 'sad' : 'neutral');

  return (
    <article
      data-message-id={message.id}
      data-seq={message.seq}
      data-reply-to={message.replyTo ?? ''}
      className={cn(
        'message router-message flex max-w-[94%] items-start gap-2.5 sm:max-w-[85%]',
        grouped && '-mt-1.5',
        highlighted && 'message-highlight',
      )}
    >
      <div className={cn('mt-0.5 shrink-0', grouped && 'opacity-0 pointer-events-none')}>
        <StaticBotAvatar expr={expr} size={28} interactivePoke />
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        {!grouped && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="speaker font-semibold text-foreground">F.R.I.D.A.Y.</span>
            {isActive && <Badge size="sm" variant="info">{statusText(message.status)}</Badge>}
            {message.status === 'failed' && <Badge size="sm" variant="error">失败</Badge>}
            {message.status === 'interrupted' && <Badge size="sm" variant="warning">已中断</Badge>}
            <span className="font-mono" title={timestamp(message.at)}>{formatShortClock(message.at)}</span>
          </div>
        )}

        <div className="rounded-2xl rounded-tl-sm border bg-card px-3.5 py-2.5 text-card-foreground shadow-2xs">
          {showRef && message.replyTo && (
            <button
              type="button"
              className="source-reference mb-2 flex w-full cursor-pointer items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-start text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => onJump(message.replyTo!)}
            >
              <span className="shrink-0 font-medium text-foreground">回复</span>
              <span className="truncate">
                {parentMsg ? stripLeadingQuoteForPreview(parentMsg.text).slice(0, 72) : '查看原消息'}
              </span>
            </button>
          )}

          {message.text ? (
            <MarkdownContent text={message.text} mode="assistant" />
          ) : (
            <p className="message-text text-sm text-muted-foreground">
              {isActive ? '正在组织回复…' : '（无正文内容）'}
            </p>
          )}

          {message.reason && (
            <p className="mt-1.5 text-xs text-destructive-foreground">{message.reason}</p>
          )}

          <AttachmentAndPathChips message={message} />

          <div className="message-actions mt-1.5 flex flex-wrap items-center gap-1">
            {isActive && (
              <Button
                type="button"
                size="xs"
                variant="destructive-outline"
                disabled={stopRequested || authExpired}
                onClick={onStop}
              >
                <SquareIcon className="size-2.5 fill-current" />
                <span>{stopRequested ? '停止中…' : '停止本轮'}</span>
              </Button>
            )}
            <Button type="button" size="xs" variant="ghost" onClick={onSelectTrace}>
              <span>链路</span>
            </Button>
            {message.text && <MessageCopyBtn text={message.text} />}
          </div>
        </div>
      </div>
    </article>
  );
}

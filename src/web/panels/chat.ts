import type { ChatMessage, MessagePage, RouteAction } from '../../view.js';
import {
  activeStatus as active,
  mergeMessages as mergeInto,
  orderConversation,
  routeLabel,
  routeState,
} from '../model.js';
import { ApiError } from '../shared/auth-http.js';
import { button, element, node } from '../shared/dom.js';
import { errorText, statusText, timestamp } from '../shared/format.js';
import { api, appState, hooks } from '../state.js';

export interface ChatPanelController {
  updateComposer: () => void;
  mergeMessages: (items: ChatMessage[]) => void;
  hydrateParents: () => Promise<void>;
  renderMessages: () => void;
  renderRoutingDetail: () => void;
  jumpMessage: (id: string) => Promise<void>;
}

/**
 * Initializes the main conversation panel, message composer, and per-message routing inspector.
 */
export function initChatPanel(): ChatPanelController {
  const messagesEl = element('messages');
  const scrollEl = element('messages-scroll');
  const olderBtn = element<HTMLButtonElement>('older');
  const historyErrorEl = element('history-error');
  const composerEl = element<HTMLFormElement>('composer');
  const draftEl = element<HTMLTextAreaElement>('draft');
  const pathsEl = element<HTMLTextAreaElement>('paths');
  const sendBtn = element<HTMLButtonElement>('send');
  const sendErrorEl = element('send-error');
  const routingDetailEl = element('routing-detail');

  let routingDetailRequest = 0;

  function updateComposer(): void {
    const locked = !appState.ready || appState.authExpired;
    draftEl.disabled = locked;
    pathsEl.disabled = locked;
    draftEl.readOnly = appState.sending || appState.uncertain;
    pathsEl.readOnly = appState.sending || appState.uncertain;
    sendBtn.disabled = locked || appState.sending || (!appState.uncertain && !draftEl.value.trim());
    sendBtn.textContent = appState.sending ? '正在发送…' : appState.uncertain ? '重试原请求' : '发送 ↑';
  }

  function mergeMessages(items: ChatMessage[]): void {
    mergeInto(appState.messages, items);
    if (appState.uncertain && appState.pending && items.some(message => message.requestId === appState.pending?.requestId)) {
      appState.pending = undefined;
      appState.uncertain = false;
      draftEl.value = '';
      pathsEl.value = '';
      sendErrorEl.textContent = '已从持久记录确认接收，无需重发。';
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
    const parents = await Promise.all(
      missing.slice(0, 40).map(id => api<ChatMessage>(`/api/message?${new URLSearchParams({ messageId: id })}`).catch(() => undefined)),
    );
    mergeMessages(parents.filter((message): message is ChatMessage => Boolean(message)));
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

  function routingSummary(message: ChatMessage): HTMLElement {
    const area = node('div', '', 'routing-summary');
    if (!message.routing) {
      area.append(node('p', active(message.status) ? '等待 F.R.I.D.A.Y. 处理并记录分配结果…' : '此历史消息未采集路由摘要；不从回复正文猜测。', 'meta'));
      return area;
    }
    for (const action of message.routing.actions) area.append(actionRow(action));
    if (!message.routing.actions.length) {
      area.append(node('p', message.routing.status === 'processing' ? 'F.R.I.D.A.Y. 正在处理，尚无已受理动作。' : '本次路由未确认完成，没有可确认的分配动作。', 'meta'));
    }
    if (message.routing.omittedActions) area.append(node('p', '动作较多，摘要只展示最近 40 条；完整动作记录请在事件时间线查看。', 'meta'));
    if (message.routing.status === 'failed' || message.routing.status === 'interrupted') {
      area.append(node('p', 'F.R.I.D.A.Y. 处理未完成；已受理的动作保留，不代表已撤销。', 'meta'));
    }
    return area;
  }

  function renderRoutingDetail(): void {
    routingDetailEl.hidden = appState.selection.type !== 'message';
    if (appState.selection.type !== 'message') return;
    const message = appState.messages.get(appState.selection.id);
    if (!message) {
      // A message outside the loaded page still has a recorded routing decision; read it instead of claiming none.
      const requestSeq = ++routingDetailRequest;
      const generation = appState.selectionGeneration;
      const id = appState.selection.id;
      routingDetailEl.replaceChildren(node('p', '正在读取该消息的路由记录…', 'meta'));
      void api<ChatMessage>(`/api/message?${new URLSearchParams({ messageId: id })}`).then(fetched => {
        if (requestSeq !== routingDetailRequest || generation !== appState.selectionGeneration) return;
        mergeMessages([fetched]);
        renderMessages();
      }).catch(error => {
        if (requestSeq === routingDetailRequest) routingDetailEl.replaceChildren(node('p', `读取路由记录失败：${errorText(error)}`, 'error'));
      });
      return;
    }
    const previous = routingDetailEl.querySelector<HTMLDetailsElement>('details.routing-facts');
    const factsOpen = previous?.open ?? false;
    const referencesOpen = previous?.querySelector<HTMLDetailsElement>('details.references')?.open ?? false;
    routingDetailEl.replaceChildren();
    if (!message.routing) {
      routingDetailEl.append(node('p', '此消息尚无已记录的路由上下文。旧历史不会补造。', 'meta'));
      return;
    }
    const routing = message.routing;
    // The readable process leads; the recorded routing context stays available without crowding it.
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

  function renderMessages(): void {
    const nearBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 90;
    const previousTop = scrollEl.scrollTop;
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.actionKey : undefined;
    const contents = document.createDocumentFragment();
    const ordered = orderConversation(appState.messages.values());
    for (const message of ordered) {
      const systemNotice = message.source === 'system';
      const article = node('article', '', `message ${message.role === 'user' ? 'user-message' : 'router-message'}`);
      article.dataset.messageId = message.id;
      article.dataset.seq = String(message.seq);
      if (message.replyTo) article.dataset.replyTo = message.replyTo;
      const speaker = node('div', '', 'speaker');
      if (message.role === 'assistant' && !systemNotice) {
        const avatar = node('span', '', 'speaker-avatar');
        avatar.setAttribute('aria-hidden', 'true');
        speaker.append(avatar);
      }
      speaker.append(node('span', message.role === 'user' ? '你' : systemNotice ? '系统 · 工作状态（非模型回复）' : 'F.R.I.D.A.Y.'));
      if (message.role === 'user' && message.origin?.speakerName) {
        speaker.append(node('span', `🎙️ ${message.origin.channel === 'xiaoai' ? '小爱 · ' : ''}${message.origin.speakerName}`, 'origin-speaker-badge'));
      }
      speaker.append(node('span', message.role === 'user' && message.status === 'completed' ? 'F.R.I.D.A.Y. 已处理' : statusText(message.status), active(message.status) ? 'running' : ''));
      if (message.mode === 'offline') speaker.append(node('span', '离线模拟'));
      const time = node('time', timestamp(message.at));
      time.dateTime = new Date(message.at).toISOString();
      speaker.append(time);
      const full = message.text || (active(message.status) ? '等待公开回复…' : '没有公开文本。');
      const visible = full.slice(0, 4000);
      const textBlock = node('div', visible, 'message-text');
      article.append(speaker);
      if (message.replyTo) {
        const source = appState.messages.get(message.replyTo);
        article.append(button(`回应：${source?.text.slice(0, 80) ?? '查看原消息'}`, () => { void jumpMessage(message.replyTo!); }, 'source-reference'));
      }
      article.append(textBlock);
      if (message.role === 'user') article.append(routingSummary(message));
      for (const id of message.role === 'assistant' || !message.routing ? message.taskIds : []) {
        const work = appState.view?.works.find(item => item.id === id);
        article.append(button(`关联工作：${work?.prompt ?? '查看工作'}`, () => {
          hooks.selectTrace({ type: 'task', id, label: work?.prompt ?? '关联工作' });
          hooks.showPanel(true);
        }, 'source-reference'));
      }
      if (full.length > visible.length) {
        const more = node('details');
        more.append(node('summary', `展开剩余 ${full.length - visible.length} 个字符`), node('pre', full.slice(visible.length)));
        article.append(more);
      }
      for (const path of message.paths) article.append(node('span', path, 'message-path'));
      if (message.reason) article.append(node('p', message.reason, 'message-reason'));
      const actions = node('div', '', 'message-actions');
      const trace = button(message.role === 'user' ? '查看本次路由与上下文' : '查看来源轨迹', () => {
        hooks.selectTrace({ type: 'message', id: message.replyTo ?? message.id, label: '本轮消息' });
        hooks.showPanel(true);
      });
      trace.dataset.actionKey = `trace-${message.id}`;
      actions.append(trace);
      if (active(message.status)) {
        const deliveryWork = message.role === 'assistant'
          ? appState.view?.works.find(work => message.taskIds.includes(work.id) && active(work.status))
          : undefined;
        const requested = appState.stopRequests.has(deliveryWork ? `task:${deliveryWork.id}` : `message:${message.id}`);
        const label = message.role === 'user' ? '取消这条消息' : deliveryWork ? '停止这项工作' : '停止本轮回复';
        const stop = button(requested ? '已请求停止' : label, () => {
          if (deliveryWork) void hooks.stopWork(deliveryWork.id);
          else void stopMessage(message.id);
        });
        stop.disabled = requested || appState.authExpired;
        stop.dataset.actionKey = `stop-${message.id}`;
        actions.append(stop);
      }
      article.append(actions);
      contents.append(article);
    }
    if (!contents.childNodes.length) {
      contents.append(node('p', '从这里开始。直接描述目标，F.R.I.D.A.Y. 会在同一个对话中持续回复。', 'empty'));
    }
    messagesEl.replaceChildren(contents);
    olderBtn.hidden = !appState.historyHasMore;
    if (focus) {
      const replacement = [...messagesEl.querySelectorAll<HTMLButtonElement>('button')].find(item => item.dataset.actionKey === focus);
      replacement?.focus({ preventScroll: true });
    }
    scrollEl.scrollTop = nearBottom ? scrollEl.scrollHeight : previousTop;
    renderRoutingDetail();
  }

  async function jumpMessage(id: string): Promise<void> {
    try {
      if (!appState.messages.has(id)) {
        mergeMessages([await api<ChatMessage>(`/api/message?${new URLSearchParams({ messageId: id })}`)]);
        renderMessages();
      }
      hooks.showPanel(false);
      const target = [...messagesEl.querySelectorAll<HTMLElement>('[data-message-id]')].find(item => item.dataset.messageId === id);
      if (target) {
        scrollEl.scrollTop += target.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - 16;
        target.classList.add('message-highlight');
        setTimeout(() => target.classList.remove('message-highlight'), 2000);
      }
    } catch (error) {
      hooks.connection(`来源消息读取失败：${errorText(error)}`, true);
    }
  }

  async function loadOlder(): Promise<void> {
    if (appState.historyBusy || appState.historyBefore === undefined) return;
    appState.historyBusy = true;
    olderBtn.disabled = true;
    olderBtn.textContent = '正在读取…';
    historyErrorEl.textContent = '';
    const oldHeight = scrollEl.scrollHeight;
    const oldTop = scrollEl.scrollTop;
    try {
      const page = await api<MessagePage>(`/api/history?before=${appState.historyBefore}`);
      mergeMessages(page.items);
      appState.historyBefore = page.before;
      appState.historyHasMore = page.hasMore;
      renderMessages();
      scrollEl.scrollTop = oldTop + scrollEl.scrollHeight - oldHeight;
    } catch (error) {
      historyErrorEl.textContent = `更早消息读取失败：${errorText(error)}。可再次点击加载。`;
    } finally {
      appState.historyBusy = false;
      olderBtn.disabled = false;
      olderBtn.textContent = '加载更早消息';
    }
  }

  async function send(): Promise<void> {
    if (appState.sending || !appState.ready || appState.authExpired) return;
    if (!appState.uncertain) {
      const text = draftEl.value.trim();
      if (!text) return;
      const files = pathsEl.value.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
      if (files.length > 32 || files.some(path => path.length > 4096 || !path.startsWith('/') || path.includes('\0'))) {
        sendErrorEl.textContent = '最多提供 32 个本机绝对路径（文件或文件夹，以 / 开头、每个不超过 4096 字符）；用于提示工作位置，由服务进一步校验。';
        return;
      }
      appState.pending = { requestId: crypto.randomUUID(), text, files };
    }
    if (!appState.pending) return;
    const submitted = appState.pending;
    appState.sending = true;
    sendErrorEl.textContent = '';
    updateComposer();
    try {
      const accepted = await api<ChatMessage>('/api/chat', submitted);
      mergeMessages([accepted]);
      appState.pending = undefined;
      appState.uncertain = false;
      draftEl.value = '';
      pathsEl.value = '';
      renderMessages();
      hooks.selectTrace({ type: 'message', id: accepted.id, label: submitted.text.slice(0, 80) });
      scrollEl.scrollTop = scrollEl.scrollHeight;
      hooks.scheduleRefresh();
    } catch (error) {
      const confirmed = [...appState.messages.values()].some(message => message.requestId === submitted.requestId);
      if (confirmed) {
        appState.pending = undefined;
        appState.uncertain = false;
        draftEl.value = '';
        pathsEl.value = '';
        sendErrorEl.textContent = '已从持久记录确认接收，无需重发。';
        return;
      }
      appState.uncertain = !(error instanceof ApiError) || error.status >= 500;
      if (!appState.uncertain) appState.pending = undefined;
      sendErrorEl.textContent = appState.uncertain
        ? `接收结果未确认：${errorText(error)}。草稿已保留并锁定；点击“重试原请求”会使用同一请求标识，不自动重发。`
        : `发送失败，草稿已保留：${errorText(error)}`;
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

  composerEl.addEventListener('submit', event => {
    event.preventDefault();
    void send();
  });
  draftEl.addEventListener('input', updateComposer);
  let composing = false;
  draftEl.addEventListener('compositionstart', () => { composing = true; });
  draftEl.addEventListener('compositionend', () => { composing = false; });
  draftEl.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) {
      event.preventDefault();
      void send();
    }
  });

  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  let resizePinned = true;
  scrollEl.addEventListener('scroll', () => {
    resizePinned = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 90;
  }, { passive: true });
  window.addEventListener('resize', () => {
    // A viewport change must not leave the newest reply clipped under the composer when already near bottom.
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = undefined;
      if (resizePinned) scrollEl.scrollTop = scrollEl.scrollHeight;
    }, 120);
  });
  olderBtn.addEventListener('click', () => { void loadOlder(); });

  return {
    updateComposer,
    mergeMessages,
    hydrateParents,
    renderMessages,
    renderRoutingDetail,
    jumpMessage,
  };
}

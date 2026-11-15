import type { TraceEvent } from '../../view.js';
import {
  activeStatus as active,
  record,
  routeState,
  spanDuration,
  spanNodes as buildSpans,
  spanTree,
  timelineSteps,
  usageSummary,
  type SpanNode,
  type TimelineStep,
} from '../model.js';
import { button, element, node } from '../shared/dom.js';
import { errorText, json, profileBadges, statusText, tierBadges, timestamp } from '../shared/format.js';
import { api, appState, hooks, type Selection } from '../state.js';

export interface TracePanelController {
  renderWorks: () => void;
  stopWork: (target?: string) => Promise<void>;
  showPanel: (trace: boolean) => void;
  closeSidebar: () => void;
  isSidebarOpen: () => boolean;
  focusSidebarToggle: () => void;
  selectTrace: (next: Selection, pin?: boolean) => void;
  loadTrace: (direction?: 'live' | 'earlier' | 'recent') => Promise<void>;
  loadWork: (id: string, generation: number, background?: boolean) => Promise<void>;
}

const actorNames: Record<string, string> = {
  router: 'F.R.I.D.A.Y.',
  worker: 'Worker',
  executor: '执行器',
  system: '系统',
  user: '你',
};

/**
 * Initializes the background-work sidebar and causal trace / step inspector panel.
 */
export function initTracePanel(): TracePanelController {
  const worksEl = element('works');
  const workFilterEl = element<HTMLSelectElement>('work-filter');
  const stopWorkBtn = element<HTMLButtonElement>('stop-work');
  const sidebarEl = element('work-sidebar');
  const workToggleBtn = element<HTMLButtonElement>('work-toggle');
  const panelsEl = element('panels');
  const showChatBtn = element<HTMLButtonElement>('show-chat');
  const showTraceBtn = element<HTMLButtonElement>('show-trace');
  const traceScopeEl = element('trace-scope');
  const traceContentEl = element('trace-content');
  const traceMoreBtn = element<HTMLButtonElement>('trace-more');
  const traceErrorEl = element('trace-error');
  const traceRetryBtn = element<HTMLButtonElement>('trace-retry');
  const graphModeBtn = element<HTMLButtonElement>('graph-mode');
  const timelineModeBtn = element<HTMLButtonElement>('timeline-mode');
  const stepModeBtn = element<HTMLButtonElement>('step-mode');
  const eventDetailEl = element('event-detail');
  const workDetailEl = element('work-detail');
  const clearFilterBtn = element('clear-filter');

  const openSteps = new Set<string>();

  function showPanel(trace: boolean): void {
    panelsEl.classList.toggle('trace-visible', trace);
    showChatBtn.setAttribute('aria-pressed', String(!trace));
    showTraceBtn.setAttribute('aria-pressed', String(trace));
  }

  function closeSidebar(): void {
    sidebarEl.classList.remove('open');
    workToggleBtn.setAttribute('aria-expanded', 'false');
  }

  function renderWorks(): void {
    const filter = workFilterEl.value;
    const works = (appState.view?.works ?? []).filter(
      work => filter === 'all' || (filter === 'active' ? active(work.status) : !active(work.status)),
    );
    const contents = document.createDocumentFragment();
    for (const work of works) {
      const selected = appState.selection.type === 'task' && appState.selection.id === work.id;
      const entry = button('', () => {
        selectTrace({ type: 'task', id: work.id, label: work.prompt });
        closeSidebar();
        showPanel(true);
      }, `work-row${selected ? ' selected' : ''}`);
      entry.setAttribute('aria-pressed', String(selected));
      entry.title = work.prompt;
      entry.append(node('span', work.prompt || '后台工作', 'work-title'));
      const modelLabel = work.workerModel
        ? `${work.workerModel}${work.thinkingLevel ? `@${work.thinkingLevel}` : ''}`
        : (work.modelTier ? (tierBadges[work.modelTier] ?? work.modelTier) : undefined);
      const profilePrefix = (work.profile || modelLabel)
        ? `${profileBadges[work.profile ?? 'general'] ?? (work.profile || '子 AI')}${modelLabel ? ` (${modelLabel})` : ''} · `
        : '';
      const statusLabel = work.pendingQuestion ? '⏳ 等待拍板' : statusText(work.status);
      entry.append(node('span', `${profilePrefix}${statusLabel} · ${timestamp(work.createdAt)}`, `meta${active(work.status) ? ' running' : ''}`));
      contents.append(entry);
    }
    if (!works.length) contents.append(node('p', appState.view ? '暂无符合筛选的后台工作。' : '尚未读取后台工作。', 'empty'));
    worksEl.replaceChildren(contents);
    const selectedId = appState.selection.type === 'task' ? appState.selection.id : undefined;
    const selected = appState.view?.works.find(work => work.id === selectedId);
    const requested = appState.selection.type === 'task' && appState.stopRequests.has(`task:${appState.selection.id}`);
    stopWorkBtn.disabled = !selected || !active(selected.status) || requested || appState.authExpired;
    stopWorkBtn.textContent = requested ? '已请求停止，等待结算' : '停止选中的工作';
    stopWorkBtn.title = selected ? '停止请求不等于已确认取消，以持久状态为准' : '请先在后台工作列表选择工作';
  }

  function eventButton(event: TraceEvent, events: TraceEvent[], span?: string): HTMLButtonElement {
    const selected = span ? appState.selectedSpan === span : appState.selectedEvent === event.seq;
    const entry = button('', () => {
      appState.selectedEvent = event.seq;
      appState.selectedSpan = span;
      renderTrace();
    }, `node-button${active(event.status) ? ' running' : ''}${selected ? ' selected' : ''}`);
    entry.setAttribute('aria-pressed', String(selected));
    entry.append(node('span', `${event.actor} · ${event.label}`, 'node-title'));
    const measured = span ? spanDuration(events) : undefined;
    entry.append(node('span', `${statusText(event.status)} · ${measured ?? timestamp(events.at(-1)?.at ?? event.at)}`, 'meta'));
    return entry;
  }

  function workLabel(step: TimelineStep): string | undefined {
    if (step.taskLabel) return step.taskLabel;
    return step.taskId ? appState.view?.works.find(work => work.id === step.taskId)?.prompt : undefined;
  }

  function renderSteps(contents: DocumentFragment): void {
    const steps = timelineSteps(appState.traceEvents);
    if (appState.traceHasEarlier) contents.append(node('p', '从最近记录的步骤开始显示；更早的步骤可继续加载。', 'branch-note'));
    if (!steps.length) {
      contents.append(node(
        'p',
        appState.traceEvents.length
          ? '暂无已记录的执行步骤，请查看原始事件。'
          : appState.selection.type === 'task' ? '此历史工作未采集详细轨迹。' : '此范围尚无可阅读的执行步骤。',
        'empty',
      ));
      return;
    }
    const list = node('ul', '', 'timeline');
    for (const step of steps) {
      const item = node('li', '', `timeline-step ${step.actor}${active(step.status) ? ' live' : ''}`);
      const head = node('div', '', 'step-head');
      head.append(node('span', actorNames[step.actor] ?? step.actor, `step-role ${step.actor}`));
      const task = workLabel(step);
      if (task) {
        head.append(button(task, () => {
          if (!step.taskId) return;
          selectTrace({ type: 'task', id: step.taskId, label: task });
          showPanel(true);
        }, 'step-task'));
      }
      head.append(node('span', step.route ? routeState(step.route) : step.followupState
        ? `补充要求：${statusText(step.followupState)}` : statusText(step.status), 'step-state'));
      head.append(node('time', timestamp(step.at), 'step-time'));
      item.append(head, node('p', step.title, 'step-title'));
      if (step.trigger && step.title.startsWith('F.R.I.D.A.Y.')) item.append(node('p', `触发内容：${step.trigger}`, 'meta'));
      if (step.summary) {
        const text = step.summary.length > 1200 ? step.summary.slice(0, 1200) : step.summary;
        item.append(node(
          'p',
          `${step.summarySource === 'stream' ? '公开输出' : '公开说明'}：${text}${step.summaryTruncated || text.length < step.summary.length ? '…（已截断）' : ''}`,
          step.summarySource === 'stream' ? 'step-summary streaming' : 'step-summary',
        ));
      } else if (step.kind === 'span' && step.label === '模型推理调用') {
        item.append(node('p', active(step.status) ? '本轮尚无公开说明。' : '本轮未记录公开说明。', 'meta'));
      }
      if (step.input) {
        const lines = Object.entries(step.input).filter(([, value]) => value !== '').map(([key, value]) => `${key}: ${value}`);
        if (lines.length) item.append(node('pre', `${lines.join('\n')}${step.inputTruncated ? '\n…（已截断）' : ''}`, 'step-io input'));
      }
      if (step.output) {
        item.append(node('p', '已记录结果：', 'meta'), node('pre', `${step.output}${step.outputTruncated ? '\n…（已截断）' : ''}`, 'step-io'));
      }
      if (step.exitCode !== undefined) item.append(node('p', `退出码 ${step.exitCode}`, 'meta'));
      if (step.error) item.append(node('p', `错误：${step.error}`, 'error'));
      const raw = appState.traceEvents.filter(
        event => (event.spanId === step.id || event.parentSpanId === step.id || event.spanId === step.parentTool)
          && event.kind !== 'visible_text' && event.kind !== 'thinking',
      );
      const details = node('details', '', 'step-records');
      const records = node('pre');
      // Raw records are built only when opened: a live window can hold hundreds of events per step.
      const fillRecords = () => {
        if (!records.textContent) {
          records.textContent = json(raw.map(event => ({ seq: event.seq, label: event.label, status: event.status, at: event.at, data: event.data })));
        }
      };
      details.open = openSteps.has(step.id);
      if (details.open) fillRecords();
      details.addEventListener('toggle', () => {
        if (details.open) { openSteps.add(step.id); fillRecords(); }
        else openSteps.delete(step.id);
      });
      details.append(node('summary', `已记录的 ${raw.length} 条记录${appState.traceHasEarlier ? '（更早记录可能未加载）' : ''}`), records);
      item.append(details);
      list.append(item);
    }
    contents.append(list);
  }

  function syncTraceMore(): void {
    traceMoreBtn.hidden = appState.traceMode === 'steps' ? !appState.traceHasEarlier : !appState.traceHasMore;
    traceMoreBtn.textContent = appState.traceMode === 'steps' ? '加载更早记录' : '加载更多事件';
  }

  function detailRow(parent: HTMLElement, label: string, value: string): void {
    const row = node('div', '', 'detail-row');
    row.append(node('span', label), node('span', value));
    parent.append(row);
  }

  function renderEventDetail(): void {
    const events = appState.selectedSpan
      ? appState.traceEvents.filter(event => event.spanId === appState.selectedSpan && event.kind !== 'visible_text')
      : appState.traceEvents.filter(event => event.seq === appState.selectedEvent);
    const latest = events.at(-1);
    if (!latest) return;
    eventDetailEl.replaceChildren(node('h3', latest.label));
    detailRow(eventDetailEl, '调用方', latest.actor);
    detailRow(eventDetailEl, '状态', statusText(latest.status));
    detailRow(eventDetailEl, '首次记录', timestamp(events[0]?.at ?? latest.at));
    detailRow(eventDetailEl, '最后记录', timestamp(latest.at));
    detailRow(eventDetailEl, '记录耗时', spanDuration(events) ?? '—（未记录完整起止）');
    detailRow(eventDetailEl, 'Token 用量', usageSummary(events.at(-1)?.data));
    if (appState.selectedSpan) detailRow(eventDetailEl, 'Span', appState.selectedSpan);
    if (latest.parentSpanId) detailRow(eventDetailEl, '父 Span', latest.parentSpanId);
    eventDetailEl.append(node('pre', json(events.map(event => ({ seq: event.seq, kind: event.kind, status: event.status, at: event.at, data: event.data })))));
  }

  function renderTrace(): void {
    const contents = document.createDocumentFragment();
    const scroller = traceContentEl.closest<HTMLElement>('.trace-scroll');
    const pinned = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120 : false;
    if (appState.traceMode === 'steps') {
      renderSteps(contents);
    } else if (appState.traceMode === 'events') {
      const list = node('ul');
      for (const event of appState.traceEvents) {
        if (event.kind === 'thinking') continue;
        const item = node('li', '', 'trace-node');
        item.append(eventButton(event, [event]));
        list.append(item);
      }
      contents.append(list);
    } else {
      const spans = buildSpans(appState.traceEvents);
      const tree = spanTree(spans);
      const visited = new Set<string>();
      const appendSpan = (span: SpanNode, list: HTMLUListElement) => {
        if (visited.has(span.id)) return;
        visited.add(span.id);
        const latest = span.events.at(-1);
        if (!latest) return;
        const item = node('li', '', 'trace-node');
        item.append(eventButton(latest, span.events, span.id));
        const children = (tree.children.get(span.id) ?? []).filter(child => !visited.has(child.id));
        if (children.length) {
          if (children.filter(child => child.events.some(event => event.kind === 'task_state')).length > 1) {
            item.append(node('p', '↳ 多项后台工作分支', 'branch-note'));
          }
          const branch = node('ul');
          for (const child of children) appendSpan(child, branch);
          item.append(branch);
        }
        list.append(item);
      };
      const list = node('ul');
      for (const span of tree.roots) appendSpan(span, list);
      if (tree.detached.length) {
        list.append(node('p', `有 ${tree.detached.length} 个节点的父级不在本次读取的范围内（历史被截断或父节点未采集），单独列出以免误认为顶层事件。`, 'branch-note'));
        for (const span of tree.detached) appendSpan(span, list);
      }
      for (const span of spans) if (!visited.has(span.id)) appendSpan(span, list);
      contents.append(list);
      const unspanned = new Map<string, TraceEvent[]>();
      for (const event of appState.traceEvents.filter(event => !event.spanId && event.kind !== 'visible_text' && event.kind !== 'thinking' && event.kind !== 'work_linked')) {
        const key = event.type === 'message' ? `message:${event.messageId}` : `${event.kind}:${event.messageId}:${event.taskId}`;
        const group = unspanned.get(key) ?? [];
        group.push(event);
        unspanned.set(key, group);
      }
      for (const events of unspanned.values()) contents.append(eventButton(events.at(-1)!, events));
    }
    if (!appState.traceEvents.length) {
      contents.append(node('p', appState.selection.type === 'task' ? '此历史工作未采集详细轨迹' : '此范围尚无已记录轨迹。', 'empty'));
    } else if (appState.traceMode === 'graph' && !buildSpans(appState.traceEvents).length && appState.traceEvents.every(event => event.kind === 'visible_text')) {
      contents.append(node('p', '仅有公开文本增量，请在原始事件中查看。', 'empty'));
    }
    traceContentEl.replaceChildren(contents);
    syncTraceMore();
    eventDetailEl.hidden = appState.traceMode === 'steps' && appState.selectedEvent === undefined && !appState.selectedSpan;
    if (scroller && pinned) scroller.scrollTop = scroller.scrollHeight;
    if (appState.selectedEvent !== undefined || appState.selectedSpan) renderEventDetail();
  }

  async function fillProcessStart(): Promise<void> {
    if (appState.traceMode !== 'steps') return;
    const generation = appState.selectionGeneration;
    const starts = new Set(['F.R.I.D.A.Y. 处理新输入', 'F.R.I.D.A.Y. 派发任务', 'Worker 接收任务']);
    for (let page = 0; page < 4; page++) {
      if (generation !== appState.selectionGeneration || !appState.traceHasEarlier || appState.traceBusy) return;
      const steps = timelineSteps(appState.traceEvents);
      if (!steps.length || starts.has(steps[0]!.title)) return;
      await loadTrace('earlier');
    }
  }

  async function loadTrace(direction: 'live' | 'earlier' | 'recent' = 'live'): Promise<void> {
    if (!appState.ready || appState.authExpired) return;
    if (appState.traceBusy) { appState.traceAgain = true; return; }
    const generation = appState.selectionGeneration;
    const latest = direction === 'live';
    const anchor = direction === 'earlier' ? appState.traceEvents[0]?.seq : latest ? appState.traceAfter : undefined;
    const params = new URLSearchParams();
    if (anchor !== undefined) params.set(direction === 'earlier' ? 'before' : 'after', String(anchor));
    if (appState.selection.type !== 'all') params.set(appState.selection.type === 'task' ? 'taskId' : 'messageId', appState.selection.id);
    appState.traceBusy = true;
    traceMoreBtn.disabled = true;
    traceErrorEl.textContent = '';
    traceRetryBtn.hidden = true;
    try {
      const events = await api<TraceEvent[]>(`/api/trace?${params}`);
      if (generation !== appState.selectionGeneration) return;
      const merged = new Map(appState.traceEvents.map(event => [event.seq, event]));
      for (const event of events) merged.set(event.seq, event);
      appState.traceEvents = [...merged.values()].sort((a, b) => a.seq - b.seq);
      appState.traceAfter = Math.max(appState.traceAfter, events.at(-1)?.seq ?? 0);
      if (direction === 'live') appState.traceHasMore = events.length === 60;
      const full = events.length === 60;
      if (direction === 'recent' || direction === 'earlier') appState.traceHasEarlier = full;
      renderTrace();
    } catch (error) {
      if (generation === appState.selectionGeneration) {
        traceErrorEl.textContent = `轨迹读取失败：${errorText(error)}`;
        traceRetryBtn.hidden = false;
      }
    } finally {
      if (generation === appState.selectionGeneration) {
        appState.traceBusy = false;
        traceMoreBtn.disabled = false;
        syncTraceMore();
        if ((appState.traceMode !== 'events' && appState.selection.type !== 'all' && appState.traceHasMore) || (appState.traceAgain && !appState.traceHasMore)) {
          appState.traceAgain = false;
          void loadTrace('live');
        }
      }
    }
  }

  function renderWorkDetail(): void {
    workDetailEl.hidden = appState.selection.type !== 'task';
    if (appState.selection.type !== 'task' || !appState.workData) return;
    const taskId = appState.selection.id;
    const generation = appState.selectionGeneration;
    const task = record(appState.workData);
    workDetailEl.replaceChildren(node('h3', '工作详情 · 诊断'), button('刷新工作详情', () => { void loadWork(taskId, generation); }));
    if (task.status === 'paused') {
      const resumeBtn = button('确认继续运行此工作', () => {
        resumeBtn.disabled = true;
        void api<unknown>('/api/resume', { taskId }).then(updated => {
          if (generation === appState.selectionGeneration) {
            appState.workData = updated;
            renderWorkDetail();
          }
          hooks.connection('已确认恢复运行工作。');
          hooks.scheduleRefresh();
        }).catch(error => {
          resumeBtn.disabled = false;
          hooks.connection(`恢复工作失败：${errorText(error)}`, true);
        });
      });
      workDetailEl.append(resumeBtn);
    }
    if (typeof task.status === 'string') {
      detailRow(workDetailEl, '状态', task.pendingQuestion ? '⏳ 等待老板拍板（不计入活跃耗时）' : statusText(task.status));
    }
    if (task.pendingQuestion && typeof task.pendingQuestion === 'object') {
      const pq = record(task.pendingQuestion);
      if (typeof pq.question === 'string') detailRow(workDetailEl, '待拍板问题', pq.question);
      if (Array.isArray(pq.options) && pq.options.length) detailRow(workDetailEl, '可选方案', pq.options.map(String).join(' / '));
    }
    if (typeof task.profile === 'string') detailRow(workDetailEl, '子 AI 专精画像', profileBadges[task.profile] ?? task.profile);
    if (typeof task.modelTier === 'string') detailRow(workDetailEl, '动态模型档位', tierBadges[task.modelTier] ?? task.modelTier);
    if (typeof task.thinkingLevel === 'string' && task.thinkingLevel) detailRow(workDetailEl, '原生思考等级', task.thinkingLevel);
    if (typeof task.decisionSource === 'string' && task.decisionSource) {
      detailRow(workDetailEl, '选模决策来源', task.decisionSource === 'gemini-decision-1' ? 'Gemini Decision 1 (Jev)' : task.decisionSource);
    }
    if (typeof task.workerModel === 'string' && task.workerModel) detailRow(workDetailEl, '指定模型', task.workerModel);
    if (task.qualityGate && typeof task.qualityGate === 'object') {
      const qg = record(task.qualityGate);
      if (qg.skippedByRoute === true) {
        detailRow(workDetailEl, '任务完成度评估', '免评直通（Jev 选模预判轻量任务）');
      } else {
        const score = typeof qg.score === 'number' ? qg.score.toFixed(2) : String(qg.score ?? '—');
        const maxScore = typeof qg.maxScore === 'number' ? qg.maxScore : 3;
        const confidencePct = Math.round(Number(qg.confidence ?? 0) * 100);
        const gateStatus = qg.shouldSupplement ? `建议补做 (${String(qg.missingAspect ?? 'incomplete')})` : '达标';
        detailRow(workDetailEl, '任务完成度评估', `${score}/${maxScore} · 置信度 ${confidencePct}% · ${gateStatus}`);
      }
    }
    if (typeof task.contextBrief === 'string' && task.contextBrief) detailRow(workDetailEl, 'F.R.I.D.A.Y. 编译背景', task.contextBrief);
    if (Array.isArray(task.memoryIds) && task.memoryIds.length) detailRow(workDetailEl, '挂载记忆卡片', task.memoryIds.map(String).join(', '));
    if (typeof task.reason === 'string') workDetailEl.append(node('p', task.reason, 'message-reason'));
    if (task.report !== undefined) {
      const report = node('details');
      report.append(node('summary', '查看已交付报告（F.R.I.D.A.Y. 汇总）'), node('pre', typeof task.report === 'string' ? task.report : json(task.report)));
      workDetailEl.append(report);
    }
    if (Array.isArray(task.followups) && task.followups.length) {
      const area = node('div', '', 'followups');
      area.append(node('h3', '补充要求'));
      for (const value of task.followups) {
        const item = record(value);
        const row = node('div', '', 'detail-row');
        row.append(node('span', typeof item.text === 'string' ? item.text : '（无正文）'));
        row.append(node('span', statusText(String(item.state ?? '')), item.state === 'failed' ? 'state-failed' : 'meta'));
        area.append(row);
      }
      workDetailEl.append(area);
    }
    if (task.files !== undefined) {
      const files = node('details');
      files.append(node('summary', '查看文件记录'), node('pre', json(task.files)));
      workDetailEl.append(files);
    }
    if (Array.isArray(task.operations)) {
      for (const value of task.operations) {
        const operation = record(value);
        const id = operation.id;
        if (typeof id !== 'string') continue;
        const area = node('div', '', 'operation');
        const output = node('div');
        const load = button(`按需读取操作结果 · ${typeof operation.status === 'string' ? statusText(operation.status) : id}`, () => {
          load.disabled = true;
          output.replaceChildren(node('p', '正在读取完整操作结果…', 'meta'));
          void api<unknown>(`/api/operation?${new URLSearchParams({ taskId, operationId: id })}`).then(result => {
            if (generation === appState.selectionGeneration) output.replaceChildren(node('pre', json(result)));
          }).catch(error => {
            if (generation === appState.selectionGeneration) output.replaceChildren(node('p', `读取失败：${errorText(error)}。可再次点击重试。`, 'error'));
          }).finally(() => { load.disabled = false; });
        });
        area.append(load, output);
        workDetailEl.append(area);
      }
    }
    const metadata = node('details');
    const { report: _report, files: _files, ...rest } = task;
    metadata.append(node('summary', '查看工作与操作元数据'), node('pre', json(rest)));
    workDetailEl.append(metadata);
  }

  async function loadWork(id: string, generation: number, background = false): Promise<void> {
    const requestNumber = ++appState.workRequest;
    workDetailEl.hidden = false;
    if (!background || !appState.workData) workDetailEl.replaceChildren(node('h3', '工作详情'), node('p', '正在读取报告与文件记录…', 'meta'));
    try {
      const task = await api<unknown>(`/api/work?${new URLSearchParams({ taskId: id })}`);
      if (generation !== appState.selectionGeneration || requestNumber !== appState.workRequest) return;
      appState.workData = task;
      renderWorkDetail();
    } catch (error) {
      if (generation !== appState.selectionGeneration || requestNumber !== appState.workRequest) return;
      workDetailEl.replaceChildren(
        node('h3', '工作详情'),
        node('p', `读取失败：${errorText(error)}`, 'error'),
        button('重试工作详情', () => { void loadWork(id, generation); }),
      );
    }
  }

  function selectTrace(next: Selection, pin = true): void {
    if (pin) appState.selectionPinned = true;
    if (next.type === 'message') appState.followedMessage = next.id;
    appState.selection = next;
    appState.selectionGeneration++;
    appState.traceEvents = [];
    appState.traceAfter = 0;
    appState.traceHasMore = false;
    appState.traceHasEarlier = false;
    appState.traceBusy = false;
    appState.traceAgain = false;
    appState.selectedEvent = undefined;
    appState.selectedSpan = undefined;
    appState.workData = undefined;
    traceScopeEl.textContent = next.type === 'all' ? '全部已记录事件' : `${next.type === 'task' ? '后台工作' : '消息'} · ${next.label}`;
    traceScopeEl.title = traceScopeEl.textContent;
    traceContentEl.replaceChildren(node('p', '正在读取实际轨迹…', 'empty'));
    eventDetailEl.replaceChildren(node('h3', '节点详情'), node('p', '选择节点查看公开数据与记录时间。', 'meta'));
    eventDetailEl.hidden = true;
    renderWorks();
    renderWorkDetail();
    hooks.renderRoutingDetail();
    void loadTrace('recent').then(fillProcessStart);
    if (next.type === 'task') void loadWork(next.id, appState.selectionGeneration);
  }

  async function stopWork(target?: string): Promise<void> {
    const id = target ?? (appState.selection.type === 'task' ? appState.selection.id : undefined);
    if (!id) return;
    const key = `task:${id}`;
    appState.stopRequests.add(key);
    renderWorks();
    hooks.renderMessages();
    try {
      const task = await api<unknown>('/api/stop', { taskId: id });
      if (appState.selection.type === 'task' && appState.selection.id === id) {
        appState.workData = task;
        renderWorkDetail();
      }
      hooks.connection('已请求停止选中工作，尚不代表确认取消；请查看最终状态与原因。');
      hooks.scheduleRefresh();
    } catch (error) {
      appState.stopRequests.delete(key);
      renderWorks();
      hooks.connection(`停止请求未确认：${errorText(error)}。可再次请求。`, true);
    }
  }

  function setTraceMode(mode: 'steps' | 'graph' | 'events'): void {
    if (appState.traceMode === mode) return;
    appState.traceMode = mode;
    if (mode === 'steps') {
      appState.selectedEvent = undefined;
      appState.selectedSpan = undefined;
    }
    for (const [key, control] of [['steps', stepModeBtn], ['graph', graphModeBtn], ['events', timelineModeBtn]] as const) {
      control.classList.toggle('active', key === mode);
      control.setAttribute('aria-pressed', String(key === mode));
    }
    renderTrace();
    if (mode === 'steps' && appState.traceHasMore && appState.traceEvents.length) void loadTrace('recent');
  }

  workFilterEl.addEventListener('change', renderWorks);
  stopWorkBtn.addEventListener('click', () => { void stopWork(); });
  traceMoreBtn.addEventListener('click', () => { void loadTrace(appState.traceMode === 'steps' ? 'earlier' : 'live'); });
  traceRetryBtn.addEventListener('click', () => { void loadTrace(appState.traceEvents.length ? 'live' : 'recent'); });
  clearFilterBtn.addEventListener('click', () => selectTrace({ type: 'all' }));
  stepModeBtn.addEventListener('click', () => setTraceMode('steps'));
  graphModeBtn.addEventListener('click', () => setTraceMode('graph'));
  timelineModeBtn.addEventListener('click', () => setTraceMode('events'));
  showChatBtn.addEventListener('click', () => showPanel(false));
  showTraceBtn.addEventListener('click', () => showPanel(true));
  workToggleBtn.addEventListener('click', () => {
    const open = sidebarEl.classList.toggle('open');
    workToggleBtn.setAttribute('aria-expanded', String(open));
    if (open) workFilterEl.focus();
  });
  document.addEventListener('click', event => {
    if (event.target instanceof Node && !sidebarEl.contains(event.target) && !workToggleBtn.contains(event.target)) {
      closeSidebar();
    }
  });

  return {
    renderWorks,
    stopWork,
    showPanel,
    closeSidebar,
    isSidebarOpen: () => sidebarEl.classList.contains('open'),
    focusSidebarToggle: () => workToggleBtn.focus(),
    selectTrace,
    loadTrace,
    loadWork,
  };
}

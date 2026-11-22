import type { ContextSearchHit, MainView, MemoryCard } from '../../view.js';
import { GoldenBrainStage, type BrainMemoryItem } from '../brain.js';
import { button, element, kpiCard, node } from '../shared/dom.js';
import { errorText, synapseRelationNames, timestamp } from '../shared/format.js';
import {
  ensureInlineFormError,
  replaceChildrenPreservingFocus,
  setInlineFormError,
  wireHubForm,
} from '../shared/plugin-catalog.js';
import {
  announceStatus,
  bindDialogLightDismiss,
  bindRovingTablist,
  closeModalDialog,
  confirmAction,
  isDialogOpen,
  isImeComposing,
  onReducedMotionChange,
  openModalDialog,
  prefersReducedMotion,
  safeFocus,
  syncRovingTablist,
} from '../shared/ui-primitives.js';
import { api, appState, hooks } from '../state.js';

export type MemoryHubTab = 'matrix' | 'notes' | 'diary';

export interface MemoryHubOptions {
  onTabChange?: (tab: MemoryHubTab) => void;
}

export interface MemoryHubController {
  openModal: (tab?: MemoryHubTab) => void;
  closeModal: () => void;
  render: (force?: boolean) => void;
  isImmersive: () => boolean;
  exitImmersive: () => void;
}

export function initMemoryHub(options: MemoryHubOptions = {}): MemoryHubController {
  const memoryTopBadge = element<HTMLElement>('memory-top-badge');
  const openMemoryHubTop = element<HTMLButtonElement>('open-memory-hub-top');
  const memoryHubDialog = element<HTMLElement>('memory-hub-dialog');
  const memoryModalClose = element<HTMLButtonElement>('memory-modal-close');
  const memoryHubTabs = (typeof document !== 'undefined' ? document.getElementById('memory-hub-tabs') : null) as HTMLElement | null;
  const memoryTabMatrix = (typeof document !== 'undefined' ? document.getElementById('memory-tab-matrix') : null) as HTMLButtonElement | null;
  const notebookTabNotes = (typeof document !== 'undefined' ? document.getElementById('notebook-tab-notes') : null) as HTMLButtonElement | null;
  const notebookTabDiary = (typeof document !== 'undefined' ? document.getElementById('notebook-tab-diary') : null) as HTMLButtonElement | null;
  const memoryPanelMatrix = (typeof document !== 'undefined' ? document.getElementById('memory-panel-matrix') : null) as HTMLElement | null;
  const notebookPanelNotes = (typeof document !== 'undefined' ? document.getElementById('notebook-panel-notes') : null) as HTMLElement | null;
  const notebookPanelDiary = (typeof document !== 'undefined' ? document.getElementById('notebook-panel-diary') : null) as HTMLElement | null;
  const notebookRoleHint = (typeof document !== 'undefined' ? document.getElementById('notebook-role-hint') : null) as HTMLElement | null;
  const memoryBrainViewport = element<HTMLElement>('memory-brain-viewport');
  const memoryBrainCanvas = element<HTMLCanvasElement>('memory-brain-canvas');
  const memoryBrainSpinBtn = element<HTMLButtonElement>('memory-brain-spin-btn');
  const memoryBrainResetBtn = element<HTMLButtonElement>('memory-brain-reset-btn');
  const memoryBrainFullscreenBtn = element<HTMLButtonElement>('memory-brain-fullscreen-btn');
  const memoryBrainInspector = element<HTMLElement>('memory-brain-inspector');
  const memoryKpiGrid = element<HTMLElement>('memory-kpi-grid');
  const memorySearchScope = element<HTMLSelectElement>('memory-search-scope');
  const memorySearchInput = element<HTMLInputElement>('memory-search-input');
  const memorySearchBtn = element<HTMLButtonElement>('memory-search-btn');
  const memorySearchResults = element<HTMLElement>('memory-search-results');
  const memoryFilterAll = element<HTMLButtonElement>('memory-filter-all');
  const memoryFilterPinned = element<HTMLButtonElement>('memory-filter-pinned');
  const memoryFilterSynapse = element<HTMLButtonElement>('memory-filter-synapse');
  const memoryAddDetails = element<HTMLDetailsElement>('memory-add-details');
  const memoryComposeForm = (typeof document !== 'undefined' ? document.getElementById('memory-compose-form') : null) as HTMLFormElement | null;
  const memoryTopicInput = element<HTMLInputElement>('memory-topic-input');
  const memoryTagsInput = element<HTMLInputElement>('memory-tags-input');
  const memoryContentInput = element<HTMLTextAreaElement>('memory-content-input');
  const memoryPinnedInput = element<HTMLInputElement>('memory-pinned-input');
  const memoryCancelEditBtn = element<HTMLButtonElement>('memory-cancel-edit-btn');
  const memorySaveBtn = element<HTMLButtonElement>('memory-save-btn');
  const memoryListSubtitle = element<HTMLElement>('memory-list-subtitle');
  const memoriesList = element<HTMLElement>('memories-list');

  const lifecycleAc = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = lifecycleAc?.signal;
  let fullFetchAc: AbortController | null = null;
  let searchAc: AbortController | null = null;

  memoryTopicInput.required = true;
  memoryContentInput.required = true;
  const memoryComposeErrorEl = ensureInlineFormError(memoryComposeForm, 'memory-compose-error');

  let activeTab: MemoryHubTab = 'matrix';
  let suppressingExternalTabSync = false;
  let fullMemoriesCache: MemoryCard[] | undefined;
  let fullMemoriesSig: string | undefined;
  let lastBrainDataSig: string | undefined;
  let fullMemoriesBusy = false;
  let memorySaving = false;
  let searchSeq = 0;
  let memoryFilterMode: 'all' | 'pinned' | 'synapse' = 'all';
  let editingMemoryId: string | undefined;
  let searchMatchedMemoryIds: Set<string> | undefined;
  let enteredNativeFullscreen = false;
  let userSpinOverride: boolean | undefined;

  function directorySignature(dir: MainView['memoryDirectory'] | undefined): string {
    if (!dir) return '';
    const latestAt = dir.items.reduce((max, item) => Math.max(max, item.updatedAt ?? 0), 0);
    const itemsSig = dir.items
      .map(item => `${item.id}:${item.updatedAt ?? 0}:${item.pinned ? 1 : 0}:${item.accessCount ?? 0}`)
      .join('|');
    return `${dir.totalActive}:${latestAt}:${itemsSig}`;
  }

  function syncBrainCardSelectionClass(selectedId?: string) {
    for (const el of memoriesList.querySelectorAll<HTMLElement>('.memory-card')) {
      el.classList.toggle('is-brain-selected', Boolean(selectedId && el.dataset.memoryId === selectedId));
    }
  }

  function findMemoryCardEl(memoryId: string): HTMLElement | undefined {
    for (const el of memoriesList.querySelectorAll<HTMLElement>('.memory-card')) {
      if (el.dataset.memoryId === memoryId) return el;
    }
    return undefined;
  }

  function syncSpinButtonUi(spinning: boolean) {
    memoryBrainSpinBtn.classList.toggle('active', spinning);
    memoryBrainSpinBtn.setAttribute('aria-pressed', String(spinning));
    memoryBrainSpinBtn.textContent = spinning ? '⟳ 自转中' : '⏸ 已定格';
  }

  function applySpinPreference(reduced: boolean) {
    if (userSpinOverride !== undefined) return;
    const nextSpin = !reduced;
    if (brainStage.isAutoRotating() !== nextSpin) {
      brainStage.setAutoRotate(nextSpin);
    }
    syncSpinButtonUi(brainStage.isAutoRotating());
  }

  function editMemoryFromUi(item: {
    id: string;
    topic: string;
    content?: string;
    preview?: string;
    tags: string[];
    pinned?: boolean;
  }) {
    editingMemoryId = item.id;
    memoryTopicInput.value = item.topic;
    memoryTagsInput.value = item.tags.join(', ');
    memoryContentInput.value = item.content ?? item.preview ?? '';
    memoryPinnedInput.checked = Boolean(item.pinned);
    memoryCancelEditBtn.hidden = false;
    memorySaveBtn.textContent = '💾 更新记忆神经元';
    setInlineFormError(memoryComposeErrorEl, undefined, [memoryTopicInput, memoryContentInput]);
    memoryAddDetails.open = true;
    safeFocus(memoryTopicInput);
  }

  function resetMemoryForm() {
    editingMemoryId = undefined;
    memoryTopicInput.value = '';
    memoryTagsInput.value = '';
    memoryContentInput.value = '';
    memoryPinnedInput.checked = false;
    memoryCancelEditBtn.hidden = true;
    memorySaveBtn.textContent = '💾 刻印到全息记忆';
    setInlineFormError(memoryComposeErrorEl, undefined, [memoryTopicInput, memoryContentInput]);
  }

  async function fetchFullMemories() {
    if (!appState.ready || appState.authExpired || fullMemoriesBusy) return;
    const sig = directorySignature(appState.view?.memoryDirectory);
    fullMemoriesBusy = true;
    fullFetchAc?.abort();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    fullFetchAc = ac;
    try {
      const list = await api<MemoryCard[]>(
        '/api/memories',
        undefined,
        {
          ...(ac ? { signal: ac.signal } : {}),
          priority: 'low',
        },
      );
      if (appState.authExpired || !appState.ready || ac?.signal.aborted) return;
      if (Array.isArray(list)) {
        fullMemoriesCache = list;
        fullMemoriesSig = sig;
        render();
      }
    } catch {
      /* fallback to view.memoryDirectory */
    } finally {
      if (fullFetchAc === ac) fullFetchAc = null;
      fullMemoriesBusy = false;
    }
  }

  async function saveMemoryFromUi() {
    const topic = memoryTopicInput.value.trim();
    const content = memoryContentInput.value.trim();
    const tags = memoryTagsInput.value.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean);
    const pinned = memoryPinnedInput.checked;
    if (!topic) {
      setInlineFormError(memoryComposeErrorEl, '请填写记忆主题', [memoryTopicInput]);
      safeFocus(memoryTopicInput);
      return;
    }
    if (!content) {
      setInlineFormError(memoryComposeErrorEl, '请填写记忆内容', [memoryContentInput]);
      safeFocus(memoryContentInput);
      return;
    }
    setInlineFormError(memoryComposeErrorEl, undefined, [memoryTopicInput, memoryContentInput]);
    if (memorySaving || appState.authExpired || !appState.ready) return;
    memorySaving = true;
    memorySaveBtn.disabled = true;
    try {
      await api<MemoryCard>('/api/memory-save', {
        ...(editingMemoryId ? { id: editingMemoryId } : {}),
        topic,
        content,
        ...(tags.length ? { tags } : {}),
        pinned,
      });
      const wasEditing = Boolean(editingMemoryId);
      resetMemoryForm();
      memoryAddDetails.open = false;
      announceStatus(wasEditing ? `已更新记忆「${topic}」` : `已保存记忆「${topic}」`, 'polite');
      await hooks.refreshView();
      await fetchFullMemories();
    } catch (error) {
      const errMsg = `保存记忆失败：${errorText(error)}`;
      setInlineFormError(memoryComposeErrorEl, errMsg);
      hooks.connection(errMsg, true);
    } finally {
      memorySaving = false;
      memorySaveBtn.disabled = appState.authExpired || !appState.ready;
    }
  }

  async function pinMemoryFromUi(id: string, pinned: boolean, topic?: string) {
    try {
      await api<MemoryCard>('/api/memory-pin', { id, pinned });
      announceStatus(pinned ? `已置顶记忆「${topic ?? id}」` : `已取消置顶「${topic ?? id}」`, 'polite');
      await hooks.refreshView();
      await fetchFullMemories();
    } catch (error) {
      const errMsg = `置顶记忆失败：${errorText(error)}`;
      hooks.connection(errMsg, true);
      announceStatus(errMsg, 'assertive');
    }
  }

  async function removeMemoryFromUi(id: string, topic?: string) {
    const confirmed = await confirmAction({
      title: '遗忘记忆神经元',
      message: `确定要永久删除记忆「${topic ?? id}」吗？此操作无法撤销。`,
      confirmLabel: '确认遗忘',
      danger: true,
    });
    if (!confirmed || appState.authExpired || !appState.ready) return;
    try {
      await api<unknown>('/api/memory-remove', { id });
      if (editingMemoryId === id) {
        resetMemoryForm();
        memoryAddDetails.open = false;
      }
      announceStatus(`已遗忘记忆「${topic ?? id}」`, 'polite');
      await hooks.refreshView();
      await fetchFullMemories();
    } catch (error) {
      const errMsg = `移除记忆失败：${errorText(error)}`;
      hooks.connection(errMsg, true);
      announceStatus(errMsg, 'assertive');
    }
  }

  let lastInspectedMemoryId: string | undefined;

  function renderBrainInspector(item: BrainMemoryItem | undefined) {
    if (!item) {
      lastInspectedMemoryId = undefined;
      memoryBrainInspector.replaceChildren(
        node('p', '当前全息皮层暂无神经元，新增或对话沉淀后将自动点亮琥珀神经核。', 'brain-inspector-empty'),
      );
      syncBrainCardSelectionClass(undefined);
      return;
    }

    const switched = lastInspectedMemoryId !== undefined && lastInspectedMemoryId !== item.id;
    lastInspectedMemoryId = item.id;

    const frag = document.createDocumentFragment();
    const kicker = node('div', '', 'brain-insp-kicker');
    kicker.append(
      node('span', '记忆神经元'),
      node('span', `提取 ${item.accessCount ?? 0} 次`),
    );
    frag.append(kicker);

    const titleRow = node('div', '', 'brain-insp-title-row');
    if (item.pinned) titleRow.append(node('span', '★ 核心信条', 'brain-insp-pin-badge'));
    titleRow.append(node('strong', item.topic, 'brain-insp-title'));
    frag.append(titleRow);

    const scrollBody = node('div', '', `brain-insp-scroll${switched ? ' is-switching' : ''}`);
    const bodyText = 'content' in item ? item.content : item.preview;
    scrollBody.append(node('div', bodyText, 'brain-insp-body'));

    if (item.tags.length) {
      const tagsWrap = node('div', '', 'brain-insp-tags');
      for (const tag of item.tags) {
        tagsWrap.append(node('span', `#${tag}`, 'brain-tag-chip'));
      }
      scrollBody.append(tagsWrap);
    }

    const metaParts = [`更新于 ${timestamp(item.updatedAt)}`];
    if (item.cwd) metaParts.push(item.cwd);
    scrollBody.append(node('div', metaParts.join(' · '), 'brain-meta-line'));

    if (item.synapses?.length) {
      const synSec = node('div', '', 'brain-synapse-section');
      synSec.append(node('span', `⚡ 突触共振网络 (${item.synapses.length}) · 点击跃迁聚焦`, 'brain-synapse-heading'));
      const synList = node('div', '', 'brain-synapse-list');
      const basePool = fullMemoriesCache ?? appState.view?.memoryDirectory?.items ?? [];
      const basePoolMap = new Map(basePool.map(m => [m.id, m]));
      for (const syn of item.synapses.slice(0, 8)) {
        const targetMem = basePoolMap.get(syn.targetId);
        const targetTitle = syn.targetTopic ?? targetMem?.topic ?? '关联记忆';
        const relText = synapseRelationNames[syn.relation] ?? syn.relation;
        synList.append(button(
          `⚡ ${targetTitle} · ${Math.round(syn.weight * 100)}% (${relText})`,
          () => {
            if (basePoolMap.has(syn.targetId)) {
              brainStage.focusMemory(syn.targetId, true);
            } else {
              memorySearchInput.value = targetTitle;
              void searchMemories();
            }
          },
          'brain-synapse-jump',
        ));
      }
      synSec.append(synList);
      scrollBody.append(synSec);
    }
    frag.append(scrollBody);

    const actions = node('div', '', 'brain-insp-actions');
    const pinBtn = button(item.pinned ? '取消置顶' : '★ 置顶', () => { void pinMemoryFromUi(item.id, !item.pinned, item.topic); }, 'brain-action-btn');
    pinBtn.setAttribute('aria-pressed', String(Boolean(item.pinned)));
    pinBtn.setAttribute('aria-label', `${item.pinned ? '取消置顶' : '置顶'}记忆 ${item.topic}`);
    const editBtn = button('✏️ 编辑', () => { editMemoryFromUi(item); }, 'brain-action-btn');
    editBtn.setAttribute('aria-label', `编辑记忆 ${item.topic}`);
    const locateBtn = button('↓ 定位卡片', () => {
      findMemoryCardEl(item.id)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
    }, 'brain-action-btn');
    const forgetBtn = button('🗑️ 遗忘', () => { void removeMemoryFromUi(item.id, item.topic); }, 'brain-action-btn danger');
    forgetBtn.setAttribute('aria-label', `遗忘记忆 ${item.topic}`);
    pinBtn.disabled = appState.authExpired || !appState.ready;
    editBtn.disabled = appState.authExpired || !appState.ready;
    forgetBtn.disabled = appState.authExpired || !appState.ready;
    actions.append(pinBtn, editBtn, locateBtn, forgetBtn);
    frag.append(actions);

    memoryBrainInspector.replaceChildren(frag);
    syncBrainCardSelectionClass(item.id);
  }

  const brainStage = new GoldenBrainStage(memoryBrainCanvas, {
    onSelect: item => renderBrainInspector(item),
  });

  function setBrainImmersive(active: boolean, syncBrowserFullscreen = true) {
    memoryBrainViewport.classList.toggle('is-immersive', active);
    memoryBrainFullscreenBtn.classList.toggle('active', active);
    memoryBrainFullscreenBtn.setAttribute('aria-pressed', String(active));
    memoryBrainFullscreenBtn.textContent = active ? '✕ 退出全屏' : '⛶ 全屏大脑';
    brainStage.setImmersive(active);
    if (!syncBrowserFullscreen) return;
    if (active) {
      if (document.fullscreenElement !== memoryBrainViewport && typeof memoryBrainViewport.requestFullscreen === 'function') {
        void memoryBrainViewport.requestFullscreen()
          .then(() => { enteredNativeFullscreen = true; })
          .catch(() => { enteredNativeFullscreen = false; });
      }
    } else if (document.fullscreenElement) {
      enteredNativeFullscreen = false;
      void document.exitFullscreen().catch(() => {});
    }
  }

  function render(force = false) {
    const directory = appState.view?.memoryDirectory;
    const dirSig = directorySignature(directory);
    if (fullMemoriesCache && dirSig !== fullMemoriesSig) {
      fullMemoriesCache = undefined;
      fullMemoriesSig = undefined;
    }
    const baseItems = fullMemoriesCache ?? directory?.items ?? [];
    const total = directory?.totalActive ?? baseItems.length;
    memoryTopBadge.textContent = String(total);
    const blocked = appState.authExpired || !appState.ready;
    memorySaveBtn.disabled = blocked || memorySaving;
    memorySearchBtn.disabled = blocked;

    if ((!isDialogOpen(memoryHubDialog) || activeTab !== 'matrix') && !force) {
      return;
    }
    if (!fullMemoriesCache && !fullMemoriesBusy && appState.ready && !appState.authExpired) {
      void fetchFullMemories();
    }

    const pinnedCount = baseItems.filter(i => i.pinned).length;
    const synapseCount = baseItems.reduce((sum, i) => sum + (i.synapses?.length ?? 0), 0);
    const accessCountTotal = baseItems.reduce((sum, i) => sum + (i.accessCount ?? 0), 0);

    const kpiFrag = document.createDocumentFragment();
    kpiFrag.append(
      kpiCard('记忆总数', `${total}`, '', total > 0 ? 'accent' : 'default'),
      kpiCard('★ 置顶记忆', `${pinnedCount}`, '', pinnedCount > 0 ? 'positive' : 'default'),
      kpiCard('⚡ 突触连接', `${synapseCount}`, '', synapseCount > 0 ? 'accent' : 'default'),
      kpiCard('🔥 累计提取', `${accessCountTotal}`, '', 'default'),
    );
    memoryKpiGrid.replaceChildren(kpiFrag);

    const filtered = baseItems.filter(item => {
      if (memoryFilterMode === 'pinned') return Boolean(item.pinned);
      if (memoryFilterMode === 'synapse') return Boolean(item.synapses?.length);
      return true;
    });
    memoryListSubtitle.textContent = `${filtered.length} / ${baseItems.length}`;

    const hasFilterOrSearch = memoryFilterMode !== 'all' || Boolean(searchMatchedMemoryIds);
    const highlightedIds = searchMatchedMemoryIds
      ? [...searchMatchedMemoryIds]
      : memoryFilterMode !== 'all'
        ? filtered.map(i => i.id)
        : undefined;
    const nextBrainSig = `${dirSig}|full:${fullMemoriesSig ?? ''}|n:${baseItems.length}|hl:${highlightedIds ? highlightedIds.join(',') : ''}|f:${hasFilterOrSearch ? 1 : 0}`;
    if (nextBrainSig !== lastBrainDataSig) {
      lastBrainDataSig = nextBrainSig;
      brainStage.setData(baseItems, highlightedIds, hasFilterOrSearch);
    }

    const baseItemsMap = new Map(baseItems.map(m => [m.id, m]));
    const activeBrainId = brainStage.getSelectedId();
    const contents = document.createDocumentFragment();
    for (const item of filtered) {
      const bodyText = 'content' in item ? item.content : item.preview;
      const card = node(
        'article',
        '',
        `hub-entity-card memory-card${item.pinned ? ' is-pinned' : ''}${item.id === activeBrainId ? ' is-brain-selected' : ''}`,
      );
      card.dataset.memoryId = item.id;

      const head = node('div', '', 'hub-card-head');
      const titleWrap = node('div', '', 'hub-card-title-group');
      if (item.pinned) titleWrap.append(node('span', '★ 置顶', 'hub-badge badge-amber'));
      titleWrap.append(node('strong', item.topic, 'hub-card-title'));
      head.append(titleWrap);

      const actions = node('div', '', 'timer-actions');
      const focusBtn = button('🎯 全息聚焦', () => {
        brainStage.focusMemory(item.id, true);
        memoryBrainCanvas.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
      }, 'mini-button');
      focusBtn.dataset.focusKey = `mem-focus:${item.id}`;
      focusBtn.setAttribute('aria-label', `全息聚焦 ${item.topic}`);
      const pinBtn = button(item.pinned ? '取消置顶' : '★ 置顶', () => { void pinMemoryFromUi(item.id, !item.pinned, item.topic); }, 'mini-button');
      pinBtn.dataset.focusKey = `mem-pin:${item.id}`;
      pinBtn.setAttribute('aria-pressed', String(Boolean(item.pinned)));
      pinBtn.setAttribute('aria-label', `${item.pinned ? '取消置顶' : '置顶'} ${item.topic}`);
      const editBtn = button('✏️ 编辑', () => { editMemoryFromUi(item); }, 'mini-button');
      editBtn.dataset.focusKey = `mem-edit:${item.id}`;
      editBtn.setAttribute('aria-label', `编辑 ${item.topic}`);
      const forgetBtn = button('🗑️ 遗忘', () => { void removeMemoryFromUi(item.id, item.topic); }, 'mini-button danger-btn');
      forgetBtn.dataset.focusKey = `mem-forget:${item.id}`;
      forgetBtn.setAttribute('aria-label', `遗忘 ${item.topic}`);
      pinBtn.disabled = appState.authExpired || !appState.ready;
      editBtn.disabled = appState.authExpired || !appState.ready;
      forgetBtn.disabled = appState.authExpired || !appState.ready;
      actions.append(focusBtn, pinBtn, editBtn, forgetBtn);
      head.append(actions);
      card.append(head);

      card.append(node('div', bodyText, 'hub-card-body-text'));

      const badgesRow = node('div', '', 'hub-badges-row');
      for (const tag of item.tags) {
        badgesRow.append(node('span', `#${tag}`, 'hub-tag-chip'));
      }
      if (item.accessCount) {
        badgesRow.append(node('span', `🔥 强化提取 ${item.accessCount} 次`, 'hub-meta-chip'));
      }
      if (item.cwd) {
        badgesRow.append(node('span', `📁 ${item.cwd}`, 'hub-meta-chip mono-chip'));
      }
      badgesRow.append(node('span', `🕒 更新于 ${timestamp(item.updatedAt)}`, 'hub-meta-chip'));
      card.append(badgesRow);

      if (item.synapses?.length) {
        const synBox = node('div', '', 'hub-synapse-box');
        synBox.append(node('span', `⚡ 突触连接 (${item.synapses.length})：`, 'hub-synapse-label'));
        for (const syn of item.synapses.slice(0, 6)) {
          const targetTitle = syn.targetTopic ?? baseItemsMap.get(syn.targetId)?.topic ?? '关联记忆';
          const relText = synapseRelationNames[syn.relation] ?? syn.relation;
          const chip = button(
            `🔗 ${targetTitle} · ${Math.round(syn.weight * 100)}% (${relText})`,
            () => {
              memorySearchInput.value = targetTitle;
              void searchMemories();
            },
            'hub-synapse-chip',
          );
          chip.dataset.focusKey = `mem-syn:${item.id}:${syn.targetId}`;
          synBox.append(chip);
        }
        card.append(synBox);
      }

      contents.append(card);
    }
    if (!filtered.length) {
      const emptyMsg = appState.view
        ? (memoryFilterMode === 'all' ? '暂无记忆' : '无匹配记忆')
        : '未连接';
      contents.append(node('p', emptyMsg, 'empty hub-empty-state'));
    }
    replaceChildrenPreservingFocus(memoriesList, contents, () => memorySearchInput);
  }

  async function searchMemories() {
    const query = memorySearchInput.value.trim();
    const scope = memorySearchScope.value || 'all';
    if (!query) {
      ++searchSeq;
      searchAc?.abort();
      searchMatchedMemoryIds = undefined;
      memorySearchResults.hidden = true;
      memorySearchResults.replaceChildren();
      render();
      announceStatus('已清空记忆检索条件', 'polite');
      return;
    }
    if (appState.authExpired || !appState.ready) return;
    const seq = ++searchSeq;
    searchAc?.abort();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    searchAc = ac;
    memorySearchResults.hidden = false;
    memorySearchResults.replaceChildren(node('p', '⏳ 正在执行全息图谱检索与 1-Hop 突触扩散激活…', 'meta'));
    try {
      const res = await api<{ hits?: ContextSearchHit[] } | ContextSearchHit[]>(
        `/api/memories?${new URLSearchParams({ query, scope })}`,
        undefined,
        ac ? { signal: ac.signal } : undefined,
      );
      if (seq !== searchSeq || ac?.signal.aborted) return;
      const hits = Array.isArray(res) ? res : (res.hits ?? []);
      const matchedIds = hits
        .filter(h => h.kind === 'memory')
        .map(h => h.memoryId ?? h.id)
        .filter(Boolean);
      searchMatchedMemoryIds = new Set(matchedIds);
      render();
      if (matchedIds[0]) {
        brainStage.focusMemory(matchedIds[0], true);
      }
      const frag = document.createDocumentFragment();
      const header = node('div', '', 'hub-card-head');
      header.append(
        node('strong', `🔍 联想检索命中 ${hits.length} 条结果`, 'hub-card-title'),
        button('✕ 清空检索', () => {
          ++searchSeq;
          searchAc?.abort();
          memorySearchInput.value = '';
          searchMatchedMemoryIds = undefined;
          memorySearchResults.hidden = true;
          memorySearchResults.replaceChildren();
          render();
          safeFocus(memorySearchInput);
        }, 'mini-button'),
      );
      frag.append(header);
      const listWrap = node('div', '', 'hub-search-hits-grid');
      for (const hit of hits) {
        const row = node('div', '', 'hub-entity-card search-hit-card');
        const hitHead = node('div', '', 'hub-card-head');
        const kindBadge = hit.kind === 'memory'
          ? node('span', '🧠 记忆神经元', 'hub-badge badge-amber')
          : hit.kind === 'work'
            ? node('span', '🔧 历史工作', 'hub-badge badge-blue')
            : node('span', '💬 历史对话', 'hub-badge badge-slate');
        const titleGroup = node('div', '', 'hub-card-title-group');
        titleGroup.append(kindBadge, node('strong', hit.title, 'hub-card-title'));
        hitHead.append(titleGroup);

        if (hit.kind === 'memory') {
          const memId = hit.memoryId ?? hit.id;
          hitHead.append(button('🎯 全息聚焦', () => {
            brainStage.focusMemory(memId, true);
            memoryBrainCanvas.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
          }, 'mini-button'));
        } else if (hit.kind === 'message' && hit.messageId) {
          hitHead.append(button('↗ 定位到此对话', () => {
            hooks.closeAllHubModals();
            hooks.closeSidebar();
            void hooks.jumpMessage(hit.messageId!);
          }, 'mini-button'));
        } else if (hit.kind === 'work' && hit.taskId) {
          hitHead.append(button('↗ 查看执行轨迹', () => {
            hooks.closeAllHubModals();
            hooks.closeSidebar();
            hooks.selectTrace({ type: 'task', id: hit.taskId!, label: hit.title });
            hooks.showPanel(true);
          }, 'mini-button'));
        }
        row.append(hitHead);
        row.append(node('p', hit.snippet, 'hub-card-body-text'));
        if (hit.activatedVia) {
          const relLabel = synapseRelationNames[hit.activatedVia.relation] ?? hit.activatedVia.relation;
          row.append(node('div', `⚡ 经由神经元「${hit.activatedVia.topic}」突触扩散激活（连接权重 ${Math.round(hit.activatedVia.weight * 100)}% · ${relLabel}）`, 'hub-synapse-banner'));
        }
        listWrap.append(row);
      }
      if (!hits.length) listWrap.append(node('p', '未找到匹配的记忆、工作或对话。', 'empty hub-empty-state'));
      frag.append(listWrap);
      memorySearchResults.replaceChildren(frag);
      announceStatus(`联想检索完成，命中 ${hits.length} 条结果`, 'polite');
    } catch (error) {
      if (seq !== searchSeq || ac?.signal.aborted) return;
      const errMsg = `搜索失败：${errorText(error)}`;
      memorySearchResults.replaceChildren(node('p', errMsg, 'error'));
      announceStatus(errMsg, 'assertive');
    } finally {
      if (searchAc === ac) searchAc = null;
    }
  }

  function setMemoryFilter(mode: 'all' | 'pinned' | 'synapse') {
    memoryFilterMode = mode;
    for (const [key, btn] of [
      ['all', memoryFilterAll],
      ['pinned', memoryFilterPinned],
      ['synapse', memoryFilterSynapse],
    ] as const) {
      const active = key === mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
    render();
  }

  function tabButtonFor(tab: MemoryHubTab): HTMLButtonElement | null {
    if (tab === 'notes') return notebookTabNotes;
    if (tab === 'diary') return notebookTabDiary;
    return memoryTabMatrix;
  }

  function syncTabPanels(tab: MemoryHubTab): void {
    activeTab = tab;
    memoryHubDialog.dataset.activeTab = tab;
    memoryTabMatrix?.classList.toggle('active', tab === 'matrix');
    notebookTabNotes?.classList.toggle('active', tab === 'notes');
    notebookTabDiary?.classList.toggle('active', tab === 'diary');
    if (memoryPanelMatrix) memoryPanelMatrix.hidden = tab !== 'matrix';
    if (notebookPanelNotes) notebookPanelNotes.hidden = tab !== 'notes';
    if (notebookPanelDiary) notebookPanelDiary.hidden = tab !== 'diary';
    if (notebookRoleHint) {
      notebookRoleHint.hidden = tab === 'matrix';
      if (tab === 'notes') {
        notebookRoleHint.textContent = 'F.R.I.D.A.Y. 替你记事 · 支持 Markdown 编辑、预览与按需转存记忆';
      } else if (tab === 'diary') {
        notebookRoleHint.textContent = 'F.R.I.D.A.Y. 自己写的每日随笔与反思 · 纯净只读，记录与你的相处点滴';
      }
    }
    const activeTabEl = tabButtonFor(tab);
    if (memoryHubTabs && activeTabEl) {
      syncRovingTablist(memoryHubTabs, activeTabEl);
    }
  }

  function switchTab(tab: MemoryHubTab, broadcast = true): void {
    syncTabPanels(tab);
    if (tab === 'matrix') {
      if (isDialogOpen(memoryHubDialog)) {
        render(true);
        applySpinPreference(prefersReducedMotion());
        brainStage.start();
        void fetchFullMemories();
      }
    } else {
      if (brainStage.isImmersive()) setBrainImmersive(false);
      brainStage.stop();
    }
    if (broadcast && !suppressingExternalTabSync) {
      suppressingExternalTabSync = true;
      try {
        if (typeof Event === 'function' && typeof memoryHubDialog.dispatchEvent === 'function') {
          memoryHubDialog.dispatchEvent(new Event('friday:memory-tab-change'));
        }
        options.onTabChange?.(tab);
      } finally {
        suppressingExternalTabSync = false;
      }
    }
  }

  function handleDialogClosed(): void {
    if (brainStage.isImmersive()) setBrainImmersive(false);
    brainStage.stop();
  }

  function openModal(tab: MemoryHubTab = 'matrix') {
    if (!isDialogOpen(memoryHubDialog)) {
      hooks.closeAllHubModals();
      openModalDialog(memoryHubDialog);
    }
    switchTab(tab);
    safeFocus(tabButtonFor(tab) ?? memoryModalClose);
  }

  function closeModal() {
    handleDialogClosed();
    closeModalDialog(memoryHubDialog);
  }

  bindDialogLightDismiss(memoryHubDialog, handleDialogClosed, signal);
  if (memoryHubTabs) {
    memoryHubTabs.dataset.rovingOwner = 'memory-hub';
    bindRovingTablist(memoryHubTabs, {
      onActivate: tabEl => {
        const next = tabEl.dataset.memoryTab as MemoryHubTab | undefined;
        if (!next) return;
        switchTab(next);
      },
      signal,
    });
  }

  const listenerOpts = signal ? { signal } : undefined;
  memoryHubDialog.addEventListener('friday:memory-tab-change', () => {
    if (suppressingExternalTabSync) return;
    const extTab = memoryHubDialog.dataset.activeTab as MemoryHubTab | undefined;
    if (extTab === 'matrix' || extTab === 'notes' || extTab === 'diary') {
      switchTab(extTab, false);
    }
  }, listenerOpts);

  openMemoryHubTop.addEventListener('click', () => openModal('matrix'), listenerOpts);
  memoryModalClose.addEventListener('click', closeModal, listenerOpts);
  memorySearchBtn.addEventListener('click', () => { void searchMemories(); }, listenerOpts);
  memorySearchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !isImeComposing(event)) {
      event.preventDefault();
      void searchMemories();
    }
  }, listenerOpts);
  memoryFilterAll.addEventListener('click', () => setMemoryFilter('all'), listenerOpts);
  memoryFilterPinned.addEventListener('click', () => setMemoryFilter('pinned'), listenerOpts);
  memoryFilterSynapse.addEventListener('click', () => setMemoryFilter('synapse'), listenerOpts);
  memoryCancelEditBtn.addEventListener('click', () => {
    resetMemoryForm();
    memoryAddDetails.open = false;
  }, listenerOpts);
  wireHubForm(memoryComposeForm, memorySaveBtn, () => { void saveMemoryFromUi(); }, signal);
  memoryBrainSpinBtn.addEventListener('click', () => {
    const spinning = brainStage.setAutoRotate(!brainStage.isAutoRotating());
    userSpinOverride = spinning;
    syncSpinButtonUi(spinning);
  }, listenerOpts);
  memoryBrainResetBtn.addEventListener('click', () => {
    brainStage.resetView();
    userSpinOverride = undefined;
    applySpinPreference(prefersReducedMotion());
  }, listenerOpts);
  memoryBrainFullscreenBtn.addEventListener('click', () => {
    setBrainImmersive(!brainStage.isImmersive());
  }, listenerOpts);
  onReducedMotionChange(reduced => {
    applySpinPreference(reduced);
  }, signal);
  if (typeof document !== 'undefined') {
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && enteredNativeFullscreen) {
        enteredNativeFullscreen = false;
        setBrainImmersive(false, false);
      }
    }, listenerOpts);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      fullFetchAc?.abort();
      searchAc?.abort();
      lifecycleAc?.abort();
      brainStage.dispose();
    }, listenerOpts);
  }

  applySpinPreference(prefersReducedMotion());
  syncTabPanels('matrix');

  return {
    openModal,
    closeModal,
    render,
    isImmersive: () => brainStage.isImmersive(),
    exitImmersive: () => setBrainImmersive(false),
  };
}

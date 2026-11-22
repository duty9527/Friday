import type {
  DiaryEntry,
  DiaryMood,
  DiarySource,
  NotebookSummaryView,
  NoteItem,
  NoteTagCount,
} from '../../view.js';
import { ApiError } from '../shared/auth-http.js';
import { createStaticBotSvg } from '../shared/bot-avatar.js';
import { BOT_EXPRESSION_META } from '../shared/bot-expressions.js';
import { button, element, isEditingWithin, node } from '../shared/dom.js';
import { errorText, timestamp } from '../shared/format.js';
import { renderMarkdownContent, type MarkdownRenderOptions } from '../shared/markdown.js';
import { isDocumentHidden, replaceChildrenPreservingFocus } from '../shared/plugin-catalog.js';
import {
  announceStatus,
  bindDialogLightDismiss,
  closeModalDialog,
  confirmAction,
  isDialogOpen,
  openModalDialog,
  safeFocus,
  syncRovingTablist,
} from '../shared/ui-primitives.js';
import { api, appState, hooks } from '../state.js';

export type NotebookTab = 'notes' | 'diary';
type NoteViewMode = 'preview' | 'edit' | 'split';

export interface NotebookHubController {
  openModal: (tab?: NotebookTab) => void;
  closeModal: () => void;
  render: (force?: boolean) => void;
  isOpen: () => boolean;
}

interface NoteListApiResponse {
  items: NoteItem[];
  tags: NoteTagCount[];
  summary: NotebookSummaryView;
}

interface DiaryListApiResponse {
  items: DiaryEntry[];
  summary: NotebookSummaryView;
}

const NOTEBOOK_SYNC_CHANNEL = 'friday.notebook-sync';

const zhTagCollator = typeof Intl !== 'undefined'
  ? new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
  : null;

const DIARY_MOOD_OPTIONS: ReadonlyArray<{ id: DiaryMood | 'all'; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'calm', label: '😌 平静' },
  { id: 'happy', label: '😄 开心' },
  { id: 'inspecting', label: '🧐 思考' },
  { id: 'squinted', label: '😑 专注' },
  { id: 'sleepy', label: '😴 犯困' },
  { id: 'surprised', label: '😮 惊讶' },
  { id: 'confused', label: '🤔 疑惑' },
  { id: 'sad', label: '😮‍💨 叹气' },
];

const DIARY_SOURCE_LABELS: Record<DiarySource, string> = {
  chat: '对话随笔',
  sleep: '潜意识复盘',
  manual: '手动补录',
};

function parseTagsText(raw: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(/[,，]/)) {
    const clean = part.trim().slice(0, 32);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(clean);
    if (tags.length >= 12) break;
  }
  return tags;
}

function summarySignature(summary?: NotebookSummaryView): string {
  if (!summary) return '0:0:0:::';
  return [
    summary.noteCount,
    summary.pinnedNoteCount,
    summary.diaryCount,
    summary.latestNoteUpdatedAt ?? '',
    summary.latestDiaryDate ?? '',
    summary.latestDiaryUpdatedAt ?? '',
  ].join(':');
}

function compactPreview(content: string, max = 92): string {
  const clean = content
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[`*_>#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '（空白内容）';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function preferredEditMode(): NoteViewMode {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 820px)').matches) {
    return 'edit';
  }
  return 'split';
}

export function initNotebookHub(): NotebookHubController {
  const memoryHubDialog = element<HTMLElement>('memory-hub-dialog');
  const memoryHubTabs = (typeof document !== 'undefined' ? document.getElementById('memory-hub-tabs') : null) as HTMLElement | null;
  const memoryTabMatrix = (typeof document !== 'undefined' ? document.getElementById('memory-tab-matrix') : null) as HTMLButtonElement | null;
  const memoryPanelMatrix = (typeof document !== 'undefined' ? document.getElementById('memory-panel-matrix') : null) as HTMLElement | null;
  const notebookRoleHint = element<HTMLElement>('notebook-role-hint');
  const tabNotesBtn = element<HTMLButtonElement>('notebook-tab-notes');
  const tabDiaryBtn = element<HTMLButtonElement>('notebook-tab-diary');
  const notesTabBadge = element<HTMLElement>('notebook-notes-tab-badge');
  const diaryTabBadge = element<HTMLElement>('notebook-diary-tab-badge');
  const panelNotes = element<HTMLElement>('notebook-panel-notes');
  const panelDiary = element<HTMLElement>('notebook-panel-diary');

  // Notes elements
  const noteSearchInput = element<HTMLInputElement>('note-search-input');
  const noteNewBtn = element<HTMLButtonElement>('note-new-btn');
  const noteFilterAllBtn = element<HTMLButtonElement>('note-filter-all');
  const noteFilterPinnedBtn = element<HTMLButtonElement>('note-filter-pinned');
  const noteTagChipsEl = element<HTMLElement>('note-tag-chips');
  const noteListEl = element<HTMLElement>('note-list');
  const noteEmptyStateEl = element<HTMLElement>('note-empty-state');
  const noteEmptyNewBtn = element<HTMLButtonElement>('note-empty-new-btn');
  const noteWorkspaceEl = element<HTMLElement>('note-workspace');
  const noteConflictBarEl = element<HTMLElement>('note-conflict-bar');
  const noteConflictLoadBtn = element<HTMLButtonElement>('note-conflict-load-btn');
  const noteConflictKeepBtn = element<HTMLButtonElement>('note-conflict-keep-btn');
  const noteTitleInput = element<HTMLInputElement>('note-title-input');
  const noteModePreviewBtn = element<HTMLButtonElement>('note-mode-preview');
  const noteModeEditBtn = element<HTMLButtonElement>('note-mode-edit');
  const noteModeSplitBtn = element<HTMLButtonElement>('note-mode-split');
  const notePinBtn = element<HTMLButtonElement>('note-pin-btn');
  const notePromoteBtn = element<HTMLButtonElement>('note-promote-btn');
  const noteDeleteBtn = element<HTMLButtonElement>('note-delete-btn');
  const noteTagsInput = element<HTMLInputElement>('note-tags-input');
  const noteMetaInfoEl = element<HTMLElement>('note-meta-info');
  const noteSaveStatusEl = element<HTMLElement>('note-save-status');
  const noteMdToolbarEl = element<HTMLElement>('note-md-toolbar');
  const noteSaveNowBtn = element<HTMLButtonElement>('note-save-now-btn');
  const noteEditorBodyEl = element<HTMLElement>('note-editor-body');
  const noteContentInput = element<HTMLTextAreaElement>('note-content-input');
  const notePreviewPane = element<HTMLElement>('note-preview-pane');

  // Diary elements
  const diarySearchInput = element<HTMLInputElement>('diary-search-input');
  const diaryMoodFiltersEl = element<HTMLElement>('diary-mood-filters');
  const diaryListEl = element<HTMLElement>('diary-list');
  const diaryEmptyStateEl = element<HTMLElement>('diary-empty-state');
  const diaryReaderEl = element<HTMLElement>('diary-reader');
  const diaryAvatarSlot = element<HTMLElement>('diary-avatar-slot');
  const diaryDateDisplay = element<HTMLElement>('diary-date-display');
  const diaryBadgesRow = element<HTMLElement>('diary-badges-row');
  const diaryTitleDisplay = element<HTMLElement>('diary-title-display');
  const diaryTagsRow = element<HTMLElement>('diary-tags-row');
  const diaryContentBody = element<HTMLElement>('diary-content-body');
  const diaryPromoteBtn = element<HTMLButtonElement>('diary-promote-btn');
  const diaryDeleteBtn = element<HTMLButtonElement>('diary-delete-btn');

  const diaryStatusEl = node('span', '', 'meta');
  diaryStatusEl.id = 'diary-action-status';
  diaryStatusEl.hidden = true;
  diaryPromoteBtn.parentElement?.insertBefore(diaryStatusEl, diaryPromoteBtn);

  const lifecycleAc = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const signal = lifecycleAc?.signal;
  let notesLoadAc: AbortController | null = null;
  let diaryLoadAc: AbortController | null = null;

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

  let activeTab: NotebookTab = 'notes';
  let suppressingExternalTabSync = false;
  let lastSummarySig = '';
  let loadedNotesSig = '';
  let loadedDiarySig = '';
  let notesLoaded = false;
  let diaryLoaded = false;

  // Notes state
  let notes: NoteItem[] = [];
  let noteTags: NoteTagCount[] = [];
  let noteQuery = '';
  let noteFilterPinnedOnly = false;
  let noteFilterTag = '';
  let selectedNoteId: string | undefined;
  let isNewDraft = false;
  let noteMode: NoteViewMode = 'preview';
  let noteDirty = false;
  let noteBaseUpdatedAt: number | undefined;
  let pendingRemoteNote: NoteItem | undefined;
  let noteSaving = false;
  let activeSavePromise: Promise<boolean> | undefined;
  let noteEditRev = 0;
  let editorContextSeq = 0;
  let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
  let previewDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let searchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let noteLoadToken = 0;
  let suppressingInputSync = false;

  // Diary state
  let diaryEntries: DiaryEntry[] = [];
  let diaryQuery = '';
  let diaryMoodFilter: DiaryMood | 'all' = 'all';
  let selectedDiaryId: string | undefined;
  let diarySearchTimer: ReturnType<typeof setTimeout> | undefined;
  let diaryLoadToken = 0;

  let syncChannel: BroadcastChannel | undefined;
  try {
    if (typeof BroadcastChannel === 'function') {
      syncChannel = new BroadcastChannel(NOTEBOOK_SYNC_CHANNEL);
      (syncChannel as unknown as { unref?: () => void }).unref?.();
    }
  } catch {
    syncChannel = undefined;
  }

  function broadcastSync(tab: NotebookTab): void {
    try {
      syncChannel?.postMessage({ type: 'changed', tab, at: Date.now() });
    } catch {
      // Ignore closed BroadcastChannel instances.
    }
  }

  function applySummaryBadges(summary?: NotebookSummaryView): void {
    const noteCount = summary?.noteCount ?? 0;
    const diaryCount = summary?.diaryCount ?? 0;
    const pinnedCount = summary?.pinnedNoteCount ?? 0;
    notesTabBadge.textContent = String(noteCount);
    diaryTabBadge.textContent = String(diaryCount);
    tabNotesBtn.title = `记事本 ${noteCount} 篇（置顶 ${pinnedCount}）`;
    tabDiaryBtn.title = `F.R.I.D.A.Y. 日记 ${diaryCount} 篇`;
  }

  function setSaveStatus(label: string, tone: 'slate' | 'amber' | 'green' | 'red' = 'slate', announce = false): void {
    noteSaveStatusEl.textContent = label;
    noteSaveStatusEl.className = `hub-status-pill badge-${tone}`;
    if (announce) {
      announceStatus(label, tone === 'red' ? 'assertive' : 'polite');
    }
  }

  function setDiaryStatus(label?: string, tone: 'meta' | 'error' = 'meta'): void {
    if (!label) {
      diaryStatusEl.hidden = true;
      diaryStatusEl.textContent = '';
      diaryStatusEl.className = 'meta';
      return;
    }
    diaryStatusEl.hidden = false;
    diaryStatusEl.textContent = label;
    diaryStatusEl.className = tone;
    announceStatus(label, tone === 'error' ? 'assertive' : 'polite');
  }

  function clearPreviewTimer(): void {
    if (previewDebounceTimer) {
      clearTimeout(previewDebounceTimer);
      previewDebounceTimer = undefined;
    }
  }

  function updateConflictBanner(): void {
    noteConflictBarEl.hidden = !pendingRemoteNote;
  }

  function syncNoteModeUI(): void {
    noteModePreviewBtn.classList.toggle('active', noteMode === 'preview');
    noteModePreviewBtn.setAttribute('aria-pressed', String(noteMode === 'preview'));
    noteModeEditBtn.classList.toggle('active', noteMode === 'edit');
    noteModeEditBtn.setAttribute('aria-pressed', String(noteMode === 'edit'));
    noteModeSplitBtn.classList.toggle('active', noteMode === 'split');
    noteModeSplitBtn.setAttribute('aria-pressed', String(noteMode === 'split'));
    noteEditorBodyEl.className = `note-editor-body is-mode-${noteMode}`;
    noteMdToolbarEl.hidden = noteMode === 'preview';
    clearPreviewTimer();
    if (noteMode !== 'edit') {
      renderNotePreview();
    }
  }

  function renderNotePreview(): void {
    const raw = noteContentInput.value;
    if (!raw.trim()) {
      notePreviewPane.replaceChildren(node('p', '这篇笔记还没有正文内容，切换到「编辑」或让 F.R.I.D.A.Y. 帮你记录。', 'meta'));
      return;
    }
    notePreviewPane.replaceChildren(renderMarkdownContent(raw, markdownOpts));
  }

  function syncWorkspaceButtons(note?: NoteItem): void {
    const disabled = !appState.ready || appState.authExpired;
    notePinBtn.disabled = disabled || !note;
    notePromoteBtn.disabled = disabled || !note;
    noteDeleteBtn.disabled = disabled || (!note && !isNewDraft);
    noteSaveNowBtn.disabled = disabled;

    if (note) {
      notePinBtn.textContent = note.pinned ? '★ 已置顶' : '☆ 置顶';
      notePinBtn.classList.toggle('active', note.pinned);
      notePinBtn.setAttribute('aria-pressed', String(note.pinned));
      notePromoteBtn.textContent = note.promotedMemoryId ? '🧠 同步更新记忆' : '🧠 转存记忆';
    } else {
      notePinBtn.textContent = '☆ 置顶';
      notePinBtn.classList.remove('active');
      notePinBtn.setAttribute('aria-pressed', 'false');
      notePromoteBtn.textContent = '🧠 转存记忆';
    }
  }

  function populateNoteEditor(note: NoteItem, options?: { mode?: NoteViewMode }): void {
    ++editorContextSeq;
    clearPreviewTimer();
    suppressingInputSync = true;
    try {
      selectedNoteId = note.id;
      isNewDraft = false;
      noteDirty = false;
      noteBaseUpdatedAt = note.updatedAt;
      pendingRemoteNote = undefined;
      noteTitleInput.value = note.title;
      noteTagsInput.value = note.tags.join(', ');
      noteContentInput.value = note.content;

      const authorLabel = note.author === 'friday' ? 'F.R.I.D.A.Y. 创建' : '你创建';
      const editorLabel = note.updatedBy === 'friday' ? 'F.R.I.D.A.Y. 更新于' : '更新于';
      const promotedSuffix = note.promotedMemoryId ? ' · 已关联全息记忆' : '';
      noteMetaInfoEl.textContent = `${authorLabel} · ${editorLabel} ${timestamp(note.updatedAt)}${promotedSuffix}`;

      if (options?.mode) noteMode = options.mode;
      noteEmptyStateEl.hidden = true;
      noteWorkspaceEl.hidden = false;
      updateConflictBanner();
      syncWorkspaceButtons(note);
      syncNoteModeUI();
      setSaveStatus('已同步', 'green');
    } finally {
      suppressingInputSync = false;
    }
  }

  function startNewNoteDraft(): void {
    ++editorContextSeq;
    clearPreviewTimer();
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = undefined;
    }
    selectedNoteId = undefined;
    isNewDraft = true;
    noteDirty = false;
    noteBaseUpdatedAt = undefined;
    pendingRemoteNote = undefined;
    suppressingInputSync = true;
    try {
      noteTitleInput.value = '';
      noteTagsInput.value = noteFilterTag ? noteFilterTag : '';
      noteContentInput.value = '';
    } finally {
      suppressingInputSync = false;
    }
    noteMetaInfoEl.textContent = '新建草稿 · 输入后自动保存';
    noteMode = preferredEditMode();
    noteEmptyStateEl.hidden = true;
    noteWorkspaceEl.hidden = false;
    updateConflictBanner();
    syncWorkspaceButtons(undefined);
    syncNoteModeUI();
    setSaveStatus('草稿', 'slate');
    renderNotesList();
    safeFocus(noteTitleInput);
  }

  function clearNoteWorkspace(): void {
    ++editorContextSeq;
    clearPreviewTimer();
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = undefined;
    }
    selectedNoteId = undefined;
    isNewDraft = false;
    noteDirty = false;
    noteBaseUpdatedAt = undefined;
    pendingRemoteNote = undefined;
    noteWorkspaceEl.hidden = true;
    noteEmptyStateEl.hidden = false;
    updateConflictBanner();
  }

  function renderNoteTagChips(): void {
    if (!noteTags.length) {
      noteTagChipsEl.hidden = true;
      noteTagChipsEl.replaceChildren();
      return;
    }
    noteTagChipsEl.hidden = false;
    const chips: HTMLElement[] = [];
    if (noteFilterTag) {
      const clearBtn = button('✕ 清除标签', () => {
        noteFilterTag = '';
        void (async () => {
          if (noteDirty && !pendingRemoteNote) await flushPendingSave();
          await loadNotes(true);
        })();
      }, 'hub-filter-pill');
      clearBtn.dataset.focusKey = 'note-tag:__clear__';
      chips.push(clearBtn);
    }
    for (const item of noteTags.slice(0, 12)) {
      const active = noteFilterTag.toLowerCase() === item.tag.toLowerCase();
      const btn = button(`#${item.tag} (${item.count})`, () => {
        noteFilterTag = active ? '' : item.tag;
        void (async () => {
          if (noteDirty && !pendingRemoteNote) await flushPendingSave();
          await loadNotes(true);
        })();
      }, `hub-filter-pill${active ? ' active' : ''}`);
      btn.dataset.focusKey = `note-tag:${item.tag.toLowerCase()}`;
      btn.setAttribute('aria-pressed', String(active));
      chips.push(btn);
    }
    replaceChildrenPreservingFocus(noteTagChipsEl, chips, () => noteSearchInput);
  }

  function renderNotesList(): void {
    noteFilterAllBtn.classList.toggle('active', !noteFilterPinnedOnly);
    noteFilterAllBtn.setAttribute('aria-pressed', String(!noteFilterPinnedOnly));
    noteFilterPinnedBtn.classList.toggle('active', noteFilterPinnedOnly);
    noteFilterPinnedBtn.setAttribute('aria-pressed', String(noteFilterPinnedOnly));

    if (!notes.length) {
      replaceChildrenPreservingFocus(
        noteListEl,
        node(
          'p',
          noteQuery || noteFilterPinnedOnly || noteFilterTag ? '没有匹配的笔记。' : '暂无记事，可让 F.R.I.D.A.Y. 帮你记录或点击新建。',
          'empty',
        ),
        () => noteNewBtn,
      );
      return;
    }

    const items = notes.map(item => {
      const isSelected = !isNewDraft && item.id === selectedNoteId;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `notebook-list-item${isSelected ? ' active' : ''}`;
      card.dataset.noteId = item.id;
      card.dataset.focusKey = `note-item:${item.id}`;
      card.setAttribute('aria-pressed', String(isSelected));

      const head = node('div', '', 'notebook-list-head');
      const titleWrap = node('div', '', 'notebook-list-title-wrap');
      if (item.pinned) titleWrap.append(node('span', '★', 'notebook-pin-mark'));
      titleWrap.append(node('strong', item.title || '未命名笔记', 'notebook-list-title'));
      head.append(titleWrap);
      head.append(node('span', item.updatedBy === 'friday' ? 'F.' : '我', `notebook-author-dot ${item.updatedBy === 'friday' ? 'is-friday' : 'is-user'}`));

      const preview = node('p', compactPreview(item.content), 'notebook-list-preview');
      const foot = node('div', '', 'notebook-list-foot');
      foot.append(node('span', timestamp(item.updatedAt), 'meta'));
      if (item.tags.length) {
        const tagLine = node('span', item.tags.slice(0, 2).map(t => `#${t}`).join(' '), 'notebook-list-tags');
        foot.append(tagLine);
      }
      if (item.promotedMemoryId) {
        foot.append(node('span', '🧠', 'notebook-promoted-dot'));
      }

      card.append(head, preview, foot);
      card.addEventListener('click', () => {
        void selectNote(item.id);
      });
      return card;
    });
    replaceChildrenPreservingFocus(noteListEl, items, () => noteNewBtn);
  }

  async function selectNote(id: string): Promise<void> {
    if (!isNewDraft && selectedNoteId === id && !noteWorkspaceEl.hidden) return;
    if (noteDirty && !pendingRemoteNote) {
      await flushPendingSave();
      if (pendingRemoteNote) return;
    } else if (activeSavePromise) {
      await activeSavePromise;
    }
    const found = notes.find(item => item.id === id);
    if (!found) return;
    populateNoteEditor(found, { mode: 'preview' });
    renderNotesList();
  }

  async function loadNotes(selectFallback = false, background = false): Promise<void> {
    if (!appState.ready || appState.authExpired) return;
    const token = ++noteLoadToken;
    notesLoadAc?.abort();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    notesLoadAc = ac;
    const params = new URLSearchParams();
    if (noteQuery.trim()) params.set('query', noteQuery.trim());
    if (noteFilterTag.trim()) params.set('tag', noteFilterTag.trim());
    if (noteFilterPinnedOnly) params.set('pinned', '1');
    const url = params.toString() ? `/api/notes?${params}` : '/api/notes';

    try {
      const res = await api<NoteListApiResponse>(
        url,
        undefined,
        {
          ...(ac ? { signal: ac.signal } : {}),
          ...(background ? { priority: 'low' as const } : {}),
        },
      );
      if (token !== noteLoadToken || ac?.signal.aborted) return;
      notes = Array.isArray(res.items) ? res.items : [];
      noteTags = Array.isArray(res.tags) ? res.tags : [];
      notesLoaded = true;
      if (res.summary) {
        applySummaryBadges(res.summary);
        loadedNotesSig = summarySignature(res.summary);
      }

      renderNoteTagChips();
      renderNotesList();

      if (isNewDraft) return;
      if (selectedNoteId) {
        const remote = notes.find(item => item.id === selectedNoteId);
        if (remote) {
          if (noteDirty || isEditingWithin(noteWorkspaceEl)) {
            if (noteBaseUpdatedAt !== undefined && remote.updatedAt !== noteBaseUpdatedAt) {
              pendingRemoteNote = remote;
              updateConflictBanner();
              setSaveStatus('冲突待处理', 'amber', true);
            }
          } else if (remote.updatedAt !== noteBaseUpdatedAt) {
            populateNoteEditor(remote);
            renderNotesList();
          }
          return;
        }
        if (!noteQuery.trim() && !noteFilterPinnedOnly && !noteFilterTag.trim()) {
          clearNoteWorkspace();
        }
      }
      const preserveEditor = Boolean(
        selectedNoteId && (noteDirty || pendingRemoteNote || isEditingWithin(noteWorkspaceEl)),
      );
      if ((selectFallback || !selectedNoteId) && notes.length > 0 && !preserveEditor) {
        populateNoteEditor(notes[0]!, { mode: 'preview' });
        renderNotesList();
      } else if (!selectedNoteId && !preserveEditor) {
        clearNoteWorkspace();
      }
    } catch (err) {
      if (token !== noteLoadToken || ac?.signal.aborted) return;
      setSaveStatus(`加载失败：${errorText(err)}`, 'red', true);
    } finally {
      if (notesLoadAc === ac) notesLoadAc = null;
    }
  }

  function buildPendingNotePayload(forceOverwrite = false): Record<string, unknown> | undefined {
    if (!isNewDraft && !selectedNoteId) return undefined;
    const title = noteTitleInput.value;
    const content = noteContentInput.value;
    if (isNewDraft && !selectedNoteId && !title.trim() && !content.trim()) return undefined;
    const tags = parseTagsText(noteTagsInput.value);
    return {
      ...(selectedNoteId ? { id: selectedNoteId } : {}),
      title,
      content,
      tags,
      author: 'user',
      updatedBy: 'user',
      ...(!forceOverwrite && selectedNoteId && noteBaseUpdatedAt !== undefined
        ? { expectedUpdatedAt: noteBaseUpdatedAt }
        : {}),
    };
  }

  async function saveCurrentNote(forceOverwrite = false): Promise<boolean> {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = undefined;
    }
    while (activeSavePromise) {
      const prevOk = await activeSavePromise;
      if (!forceOverwrite && !noteDirty) return prevOk;
    }
    if (!appState.ready || appState.authExpired) return false;
    if (!isNewDraft && !selectedNoteId) return false;
    if (pendingRemoteNote && !forceOverwrite) return false;

    const ctxSeq = editorContextSeq;
    const targetId = selectedNoteId;
    const savedEditRev = noteEditRev;
    const title = noteTitleInput.value;
    const content = noteContentInput.value;
    const tags = parseTagsText(noteTagsInput.value);

    // Avoid persisting a completely empty brand-new draft automatically
    if (isNewDraft && !targetId && !title.trim() && !content.trim()) {
      noteDirty = false;
      return true;
    }

    const runSave = async (): Promise<boolean> => {
      noteSaving = true;
      setSaveStatus('保存中…', 'amber');
      try {
        const payload: Record<string, unknown> = {
          ...(targetId ? { id: targetId } : {}),
          title,
          content,
          tags,
          author: 'user',
          updatedBy: 'user',
          ...(!forceOverwrite && targetId && noteBaseUpdatedAt !== undefined ? { expectedUpdatedAt: noteBaseUpdatedAt } : {}),
        };
        const res = await api<{ note: NoteItem; summary: NotebookSummaryView }>('/api/note-save', payload);
        const saved = res.note;

        const idx = notes.findIndex(item => item.id === saved.id);
        if (idx >= 0) notes[idx] = saved;
        else notes.unshift(saved);
        notes = notes.toSorted((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt - a.updatedAt));

        if (res.summary) {
          applySummaryBadges(res.summary);
          loadedNotesSig = summarySignature(res.summary);
        }
        if (!noteQuery.trim() && !noteFilterPinnedOnly && !noteFilterTag.trim()) {
          const counts = new Map<string, { tag: string; count: number }>();
          for (const item of notes) {
            for (const tag of item.tags) {
              const key = tag.toLowerCase();
              const cur = counts.get(key);
              if (cur) cur.count++;
              else counts.set(key, { tag, count: 1 });
            }
          }
          noteTags = [...counts.values()].toSorted(
            (a, b) => b.count - a.count || (zhTagCollator ? zhTagCollator.compare(a.tag, b.tag) : a.tag.localeCompare(b.tag)),
          );
          renderNoteTagChips();
        }

        if (ctxSeq === editorContextSeq) {
          selectedNoteId = saved.id;
          isNewDraft = false;
          noteBaseUpdatedAt = saved.updatedAt;
          pendingRemoteNote = undefined;
          updateConflictBanner();

          if (noteEditRev === savedEditRev) {
            noteDirty = false;
            if (suppressingInputSync === false && !noteTitleInput.value.trim()) {
              noteTitleInput.value = saved.title;
            }
            setSaveStatus('已保存', 'green', true);
          } else {
            noteDirty = true;
            setSaveStatus('未保存…', 'amber');
          }
          const authorLabel = saved.author === 'friday' ? 'F.R.I.D.A.Y. 创建' : '你创建';
          const promotedSuffix = saved.promotedMemoryId ? ' · 已关联全息记忆' : '';
          noteMetaInfoEl.textContent = `${authorLabel} · 更新于 ${timestamp(saved.updatedAt)}${promotedSuffix}`;
          syncWorkspaceButtons(saved);
        }

        renderNotesList();
        broadcastSync('notes');
        void hooks.refreshView();
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && targetId) {
          if (ctxSeq === editorContextSeq) {
            try {
              const latest = await api<NoteItem>(`/api/note?id=${encodeURIComponent(targetId)}`);
              if (ctxSeq === editorContextSeq) {
                pendingRemoteNote = latest;
                updateConflictBanner();
                setSaveStatus('冲突待处理', 'amber', true);
              }
            } catch {
              if (ctxSeq === editorContextSeq) {
                setSaveStatus('保存冲突，请刷新重试', 'red', true);
              }
            }
          }
          return false;
        }
        if (ctxSeq === editorContextSeq) {
          setSaveStatus(`保存失败：${errorText(err)}`, 'red', true);
        }
        return false;
      } finally {
        noteSaving = false;
        activeSavePromise = undefined;
      }
    };

    const promise = runSave();
    activeSavePromise = promise;
    return await promise;
  }

  async function flushPendingSave(): Promise<void> {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = undefined;
    }
    while (activeSavePromise) {
      await activeSavePromise;
    }
    if (noteDirty && !pendingRemoteNote) {
      await saveCurrentNote(false);
    }
  }

  function markNoteDirty(): void {
    if (suppressingInputSync) return;
    ++noteEditRev;
    noteDirty = true;
    setSaveStatus('未保存…', 'amber');
    if (noteMode !== 'edit') {
      clearPreviewTimer();
      previewDebounceTimer = setTimeout(() => {
        previewDebounceTimer = undefined;
        if (noteMode !== 'edit') renderNotePreview();
      }, 150);
    }
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
      autoSaveTimer = undefined;
      void saveCurrentNote(false);
    }, 800);
  }

  function applyMarkdownSnippet(op: string): void {
    if (noteMode === 'preview') {
      noteMode = preferredEditMode();
      syncNoteModeUI();
    }
    const ta = noteContentInput;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const selected = ta.value.slice(start, end);
    let inserted = '';
    let cursorOffset = 0;

    switch (op) {
      case 'h2': {
        const body = selected || '小节标题';
        const prefix = start > 0 && ta.value[start - 1] !== '\n' ? '\n' : '';
        inserted = `${prefix}## ${body}`;
        cursorOffset = inserted.length;
        break;
      }
      case 'bold': {
        const body = selected || '重点内容';
        inserted = `**${body}**`;
        cursorOffset = selected ? inserted.length : inserted.length - 2;
        break;
      }
      case 'list': {
        const body = selected || '条目内容';
        const prefix = start > 0 && ta.value[start - 1] !== '\n' ? '\n' : '';
        inserted = `${prefix}- ${body}`;
        cursorOffset = inserted.length;
        break;
      }
      case 'check': {
        const body = selected || '待办事项';
        const prefix = start > 0 && ta.value[start - 1] !== '\n' ? '\n' : '';
        inserted = `${prefix}- [ ] ${body}`;
        cursorOffset = inserted.length;
        break;
      }
      case 'code': {
        const body = selected || '代码或命令';
        const prefix = start > 0 && ta.value[start - 1] !== '\n' ? '\n' : '';
        inserted = `${prefix}\`\`\`\n${body}\n\`\`\`\n`;
        cursorOffset = inserted.length;
        break;
      }
      default:
        return;
    }

    ta.value = `${ta.value.slice(0, start)}${inserted}${ta.value.slice(end)}`;
    ta.focus();
    ta.setSelectionRange(start + cursorOffset, start + cursorOffset);
    markNoteDirty();
  }

  // --- Diary helpers ---
  function renderDiaryMoodFilters(): void {
    const pills = DIARY_MOOD_OPTIONS.map(opt => {
      const active = diaryMoodFilter === opt.id;
      const btn = button(
        opt.label,
        () => {
          diaryMoodFilter = opt.id;
          void loadDiary(true);
        },
        `hub-filter-pill${active ? ' active' : ''}`,
      );
      btn.dataset.focusKey = `diary-mood:${opt.id}`;
      btn.setAttribute('aria-pressed', String(active));
      return btn;
    });
    replaceChildrenPreservingFocus(diaryMoodFiltersEl, pills, () => diarySearchInput);
  }

  function renderDiaryReader(entry?: DiaryEntry): void {
    setDiaryStatus(undefined);
    if (!entry) {
      selectedDiaryId = undefined;
      diaryReaderEl.hidden = true;
      diaryEmptyStateEl.hidden = false;
      return;
    }
    selectedDiaryId = entry.id;
    diaryEmptyStateEl.hidden = true;
    diaryReaderEl.hidden = false;

    diaryAvatarSlot.replaceChildren(
      createStaticBotSvg({
        size: 52,
        expr: entry.mood in BOT_EXPRESSION_META ? entry.mood : 'calm',
        interactivePoke: false,
      }),
    );
    diaryDateDisplay.textContent = entry.date;
    diaryTitleDisplay.textContent = entry.title;

    const moodMeta = BOT_EXPRESSION_META[entry.mood] ?? BOT_EXPRESSION_META.calm;
    const moodBadge = node('span', `${moodMeta.plainEmoji} ${moodMeta.label}`, 'hub-status-pill badge-amber');
    const sourceBadge = node('span', DIARY_SOURCE_LABELS[entry.source] ?? entry.source, 'hub-status-pill badge-slate');
    const timeEl = node('span', `写于 ${timestamp(entry.updatedAt)}`, 'meta');
    diaryBadgesRow.replaceChildren(moodBadge, sourceBadge, timeEl);

    if (entry.tags.length) {
      diaryTagsRow.hidden = false;
      diaryTagsRow.replaceChildren(...entry.tags.map(t => node('span', `#${t}`, 'hub-tag-chip')));
    } else {
      diaryTagsRow.hidden = true;
      diaryTagsRow.replaceChildren();
    }

    diaryContentBody.replaceChildren(renderMarkdownContent(entry.content, markdownOpts));
    diaryPromoteBtn.disabled = !appState.ready || appState.authExpired;
    diaryDeleteBtn.disabled = !appState.ready || appState.authExpired;
    diaryPromoteBtn.textContent = entry.promotedMemoryId ? '🧠 同步更新记忆' : '🧠 转存记忆';
    diaryDeleteBtn.textContent = '删除';
  }

  function renderDiaryList(): void {
    renderDiaryMoodFilters();
    if (!diaryEntries.length) {
      replaceChildrenPreservingFocus(
        diaryListEl,
        node(
          'p',
          diaryQuery || diaryMoodFilter !== 'all' ? '没有符合筛选条件的日记。' : 'F.R.I.D.A.Y. 还没有写下日记。',
          'empty',
        ),
        () => diarySearchInput,
      );
      return;
    }

    const cards = diaryEntries.map(entry => {
      const selected = entry.id === selectedDiaryId;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `notebook-list-item diary-list-item${selected ? ' active' : ''}`;
      card.dataset.diaryId = entry.id;
      card.dataset.focusKey = `diary-item:${entry.id}`;
      card.setAttribute('aria-pressed', String(selected));

      const head = node('div', '', 'notebook-list-head');
      const left = node('div', '', 'notebook-list-title-wrap');
      left.append(node('span', entry.date, 'diary-date-chip'));
      left.append(node('strong', entry.title, 'notebook-list-title'));
      head.append(left);
      const moodMeta = BOT_EXPRESSION_META[entry.mood] ?? BOT_EXPRESSION_META.calm;
      head.append(node('span', moodMeta.plainEmoji, 'diary-mood-emoji'));

      const preview = node('p', compactPreview(entry.content), 'notebook-list-preview');
      const foot = node('div', '', 'notebook-list-foot');
      foot.append(node('span', DIARY_SOURCE_LABELS[entry.source] ?? entry.source, 'meta'));
      if (entry.promotedMemoryId) {
        foot.append(node('span', '🧠', 'notebook-promoted-dot'));
      }

      card.append(head, preview, foot);
      card.addEventListener('click', () => {
        renderDiaryReader(entry);
        renderDiaryList();
      });
      return card;
    });
    replaceChildrenPreservingFocus(diaryListEl, cards, () => diarySearchInput);
  }

  async function loadDiary(selectFallback = false, background = false): Promise<void> {
    if (!appState.ready || appState.authExpired) return;
    const token = ++diaryLoadToken;
    diaryLoadAc?.abort();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    diaryLoadAc = ac;
    const params = new URLSearchParams();
    if (diaryQuery.trim()) params.set('query', diaryQuery.trim());
    if (diaryMoodFilter !== 'all') params.set('mood', diaryMoodFilter);
    const url = params.toString() ? `/api/diary?${params}` : '/api/diary';

    try {
      const res = await api<DiaryListApiResponse>(
        url,
        undefined,
        {
          ...(ac ? { signal: ac.signal } : {}),
          ...(background ? { priority: 'low' as const } : {}),
        },
      );
      if (token !== diaryLoadToken || ac?.signal.aborted) return;
      diaryEntries = Array.isArray(res.items) ? res.items : [];
      diaryLoaded = true;
      if (res.summary) {
        applySummaryBadges(res.summary);
        loadedDiarySig = summarySignature(res.summary);
      }
      renderDiaryList();

      if (selectedDiaryId) {
        const matched = diaryEntries.find(item => item.id === selectedDiaryId);
        if (matched) {
          renderDiaryReader(matched);
          return;
        }
      }
      if ((selectFallback || !selectedDiaryId) && diaryEntries.length > 0) {
        renderDiaryReader(diaryEntries[0]);
        renderDiaryList();
      } else if (!diaryEntries.length) {
        renderDiaryReader(undefined);
      }
    } catch {
      if (token !== diaryLoadToken || ac?.signal.aborted) return;
      diaryListEl.replaceChildren(node('p', '读取 F.R.I.D.A.Y. 日记失败，请稍后重试。', 'error'));
      announceStatus('读取 F.R.I.D.A.Y. 日记失败，请稍后重试。', 'assertive');
    } finally {
      if (diaryLoadAc === ac) diaryLoadAc = null;
    }
  }

  // --- Tab & Modal switching (inside #memory-hub-dialog) ---
  function syncTabState(broadcast = false): void {
    const isNotes = activeTab === 'notes';
    memoryHubDialog.dataset.activeTab = activeTab;
    memoryTabMatrix?.classList.remove('active');
    if (memoryPanelMatrix) memoryPanelMatrix.hidden = true;

    tabNotesBtn.classList.toggle('active', isNotes);
    panelNotes.hidden = !isNotes;

    tabDiaryBtn.classList.toggle('active', !isNotes);
    panelDiary.hidden = isNotes;

    notebookRoleHint.hidden = false;
    notebookRoleHint.textContent = isNotes
      ? 'F.R.I.D.A.Y. 替你记事 · 支持 Markdown 编辑、预览与按需转存记忆'
      : 'F.R.I.D.A.Y. 自己写的每日随笔与反思 · 纯净只读，记录与你的相处点滴';

    if (memoryHubTabs) {
      syncRovingTablist(memoryHubTabs, isNotes ? tabNotesBtn : tabDiaryBtn);
    }

    if (broadcast && !suppressingExternalTabSync) {
      suppressingExternalTabSync = true;
      try {
        if (typeof Event === 'function' && typeof memoryHubDialog.dispatchEvent === 'function') {
          memoryHubDialog.dispatchEvent(new Event('friday:memory-tab-change'));
        }
      } finally {
        suppressingExternalTabSync = false;
      }
    }
  }

  function switchTab(next: NotebookTab, broadcast = true): void {
    if (activeTab === 'notes' && next !== 'notes' && noteDirty && !pendingRemoteNote) {
      void flushPendingSave();
    }
    activeTab = next;
    syncTabState(broadcast);
    const currentSig = summarySignature(appState.view?.notebookSummary);
    if (next === 'notes') {
      if (!notesLoaded || loadedNotesSig !== currentSig) {
        void loadNotes(true);
      }
    } else if (!diaryLoaded || loadedDiarySig !== currentSig) {
      void loadDiary(true);
    }
  }

  function isNotebookOpen(tab?: NotebookTab): boolean {
    if (!isDialogOpen(memoryHubDialog)) return false;
    if (tab === 'notes') return !panelNotes.hidden;
    if (tab === 'diary') return !panelDiary.hidden;
    return !panelNotes.hidden || !panelDiary.hidden;
  }

  function openModal(tab: NotebookTab = 'notes'): void {
    if (!isDialogOpen(memoryHubDialog)) {
      hooks.closeAllHubModals();
      openModalDialog(memoryHubDialog);
    }
    activeTab = tab;
    syncTabState(true);
    if (appState.ready && !appState.authExpired) {
      if (tab === 'notes') void loadNotes(true);
      else void loadDiary(true);
    }
    safeFocus(tab === 'notes' ? tabNotesBtn : tabDiaryBtn);
  }

  function handleDialogClosed(): void {
    clearPreviewTimer();
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = undefined;
    }
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = undefined;
    }
    if (diarySearchTimer) {
      clearTimeout(diarySearchTimer);
      diarySearchTimer = undefined;
    }
    if ((noteDirty && !pendingRemoteNote) || activeSavePromise) {
      void flushPendingSave();
    }
  }

  function closeModal(): void {
    handleDialogClosed();
    if (isDialogOpen(memoryHubDialog)) {
      closeModalDialog(memoryHubDialog);
    }
  }

  function render(force = false): void {
    const summary = appState.view?.notebookSummary;
    applySummaryBadges(summary);
    const nextSig = summarySignature(summary);
    const sigChanged = nextSig !== lastSummarySig;
    lastSummarySig = nextSig;

    if (!appState.ready || appState.authExpired) {
      const currentNote = selectedNoteId ? notes.find(item => item.id === selectedNoteId) : undefined;
      syncWorkspaceButtons(currentNote);
      diaryPromoteBtn.disabled = true;
      diaryDeleteBtn.disabled = true;
      return;
    }
    if (!isNotebookOpen() && !force) return;
    if (!isDialogOpen(memoryHubDialog)) return;
    if (activeTab === 'notes' && (force || sigChanged || !notesLoaded || loadedNotesSig !== nextSig)) {
      void loadNotes(false, !force);
    } else if (activeTab === 'diary' && (force || sigChanged || !diaryLoaded || loadedDiarySig !== nextSig)) {
      void loadDiary(false, !force);
    }
  }

  // --- Event wiring ---
  const listenerOpts = signal ? { signal } : undefined;
  if (memoryHubTabs?.dataset.rovingOwner === 'memory-hub') {
    memoryHubDialog.addEventListener('close', handleDialogClosed, listenerOpts);
  } else {
    bindDialogLightDismiss(memoryHubDialog, handleDialogClosed, signal);
  }

  memoryHubDialog.addEventListener('friday:memory-tab-change', () => {
    if (suppressingExternalTabBroadcast()) return;
    const extTab = memoryHubDialog.dataset.activeTab;
    if (extTab === 'matrix') {
      clearPreviewTimer();
      if ((noteDirty && !pendingRemoteNote) || activeSavePromise) {
        void flushPendingSave();
      }
      return;
    }
    if (extTab === 'notes' || extTab === 'diary') {
      if (activeTab === 'notes' && extTab !== 'notes' && noteDirty && !pendingRemoteNote) {
        void flushPendingSave();
      }
      activeTab = extTab;
      const currentSig = summarySignature(appState.view?.notebookSummary);
      if (extTab === 'notes') {
        if (!notesLoaded || loadedNotesSig !== currentSig) void loadNotes(true);
      } else if (!diaryLoaded || loadedDiarySig !== currentSig) {
        void loadDiary(true);
      }
    }
  }, listenerOpts);

  function suppressingExternalTabBroadcast(): boolean {
    return suppressingExternalTabSync;
  }

  tabNotesBtn.addEventListener('click', () => {
    if (memoryHubTabs?.dataset.rovingOwner === 'memory-hub') return;
    switchTab('notes', false);
  }, listenerOpts);
  tabDiaryBtn.addEventListener('click', () => {
    if (memoryHubTabs?.dataset.rovingOwner === 'memory-hub') return;
    switchTab('diary', false);
  }, listenerOpts);

  noteNewBtn.addEventListener('click', () => {
    void (async () => {
      if ((noteDirty && !pendingRemoteNote) || activeSavePromise) await flushPendingSave();
      startNewNoteDraft();
    })();
  }, listenerOpts);
  noteEmptyNewBtn.addEventListener('click', startNewNoteDraft, listenerOpts);

  noteSearchInput.addEventListener('input', () => {
    noteQuery = noteSearchInput.value;
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = undefined;
      void (async () => {
        if ((noteDirty && !pendingRemoteNote) || activeSavePromise) await flushPendingSave();
        await loadNotes(true);
      })();
    }, 220);
  }, listenerOpts);

  noteFilterAllBtn.addEventListener('click', () => {
    if (!noteFilterPinnedOnly) return;
    noteFilterPinnedOnly = false;
    void (async () => {
      if ((noteDirty && !pendingRemoteNote) || activeSavePromise) await flushPendingSave();
      await loadNotes(true);
    })();
  }, listenerOpts);
  noteFilterPinnedBtn.addEventListener('click', () => {
    if (noteFilterPinnedOnly) return;
    noteFilterPinnedOnly = true;
    void (async () => {
      if ((noteDirty && !pendingRemoteNote) || activeSavePromise) await flushPendingSave();
      await loadNotes(true);
    })();
  }, listenerOpts);

  noteModePreviewBtn.addEventListener('click', () => { noteMode = 'preview'; syncNoteModeUI(); }, listenerOpts);
  noteModeEditBtn.addEventListener('click', () => { noteMode = 'edit'; syncNoteModeUI(); safeFocus(noteContentInput); }, listenerOpts);
  noteModeSplitBtn.addEventListener('click', () => { noteMode = 'split'; syncNoteModeUI(); safeFocus(noteContentInput); }, listenerOpts);

  noteTitleInput.addEventListener('input', markNoteDirty, listenerOpts);
  noteTagsInput.addEventListener('input', markNoteDirty, listenerOpts);
  noteContentInput.addEventListener('input', markNoteDirty, listenerOpts);

  noteWorkspaceEl.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void saveCurrentNote(false);
    }
  }, listenerOpts);

  noteSaveNowBtn.addEventListener('click', () => { void saveCurrentNote(false); }, listenerOpts);

  for (const btn of noteMdToolbarEl.querySelectorAll<HTMLButtonElement>('[data-md-op]')) {
    const labelHint = btn.getAttribute('aria-label') || btn.getAttribute('title') || btn.textContent?.trim() || '';
    if (!btn.getAttribute('aria-label') && labelHint) {
      btn.setAttribute('aria-label', labelHint);
    }
    btn.addEventListener('click', () => {
      const op = btn.dataset.mdOp;
      if (op) applyMarkdownSnippet(op);
    }, listenerOpts);
  }

  noteConflictLoadBtn.addEventListener('click', () => {
    if (!pendingRemoteNote) return;
    const latest = pendingRemoteNote;
    const idx = notes.findIndex(item => item.id === latest.id);
    if (idx >= 0) notes[idx] = latest;
    populateNoteEditor(latest);
    renderNotesList();
  }, listenerOpts);

  noteConflictKeepBtn.addEventListener('click', () => {
    if (!pendingRemoteNote) return;
    noteBaseUpdatedAt = pendingRemoteNote.updatedAt;
    pendingRemoteNote = undefined;
    updateConflictBanner();
    void saveCurrentNote(true);
  }, listenerOpts);

  notePinBtn.addEventListener('click', () => {
    if (!selectedNoteId || !appState.ready || appState.authExpired) return;
    const targetId = selectedNoteId;
    void (async () => {
      if ((noteDirty && !pendingRemoteNote) || activeSavePromise) await flushPendingSave();
      if (!appState.ready || appState.authExpired) return;
      const current = notes.find(item => item.id === targetId);
      if (!current) return;
      try {
        const res = await api<{ note: NoteItem; summary: NotebookSummaryView }>('/api/note-pin', {
          id: current.id,
          pinned: !current.pinned,
        });
        const idx = notes.findIndex(item => item.id === res.note.id);
        if (idx >= 0) notes[idx] = res.note;
        notes = notes.toSorted((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt - a.updatedAt));
        if (res.summary) {
          applySummaryBadges(res.summary);
          loadedNotesSig = summarySignature(res.summary);
        }
        if (selectedNoteId === res.note.id) {
          noteBaseUpdatedAt = res.note.updatedAt;
          syncWorkspaceButtons(res.note);
        }
        renderNotesList();
        announceStatus(res.note.pinned ? '已置顶笔记' : '已取消置顶', 'polite');
        broadcastSync('notes');
        void hooks.refreshView();
      } catch (err) {
        if (selectedNoteId === targetId) {
          setSaveStatus(`置顶失败：${errorText(err)}`, 'red', true);
        }
      }
    })();
  }, listenerOpts);

  notePromoteBtn.addEventListener('click', () => {
    if (!selectedNoteId || !appState.ready || appState.authExpired) return;
    const targetId = selectedNoteId;
    void (async () => {
      if ((noteDirty && !pendingRemoteNote) || activeSavePromise) await flushPendingSave();
      if (!appState.ready || appState.authExpired) return;
      if (selectedNoteId === targetId) setSaveStatus('转存记忆中…', 'amber');
      try {
        const res = await api<{ note: NoteItem; summary: NotebookSummaryView }>('/api/note-promote-memory', { id: targetId });
        const idx = notes.findIndex(item => item.id === res.note.id);
        if (idx >= 0) notes[idx] = res.note;
        if (res.summary) {
          applySummaryBadges(res.summary);
          loadedNotesSig = summarySignature(res.summary);
        }
        if (selectedNoteId === res.note.id) {
          if (!noteDirty) {
            populateNoteEditor(res.note);
          } else {
            noteBaseUpdatedAt = res.note.updatedAt;
            syncWorkspaceButtons(res.note);
          }
          setSaveStatus('✓ 已转存至全息记忆', 'green', true);
        }
        renderNotesList();
        broadcastSync('notes');
        void hooks.refreshView();
      } catch (err) {
        if (selectedNoteId === targetId) {
          setSaveStatus(`转存失败：${errorText(err)}`, 'red', true);
        }
      }
    })();
  }, listenerOpts);

  noteDeleteBtn.addEventListener('click', () => {
    if (isNewDraft && !selectedNoteId) {
      const hasDraftText = Boolean(noteTitleInput.value.trim() || noteContentInput.value.trim());
      void (async () => {
        if (hasDraftText) {
          const ok = await confirmAction({
            title: '放弃新建草稿',
            message: '当前草稿尚未保存，确定要放弃吗？',
            confirmLabel: '放弃草稿',
            danger: true,
          });
          if (!ok) return;
        }
        clearNoteWorkspace();
        if (notes.length > 0) {
          populateNoteEditor(notes[0]!, { mode: 'preview' });
          renderNotesList();
        }
      })();
      return;
    }
    if (!selectedNoteId) return;
    const deleteId = selectedNoteId;
    const titleLabel = noteTitleInput.value.trim() || '未命名笔记';
    void (async () => {
      const ok = await confirmAction({
        title: '删除笔记',
        message: `确定要删除笔记「${titleLabel}」吗？此操作无法撤销。`,
        confirmLabel: '确认删除',
        danger: true,
      });
      if (!ok || !appState.ready || appState.authExpired) return;
      try {
        const res = await api<{ removed: boolean; summary: NotebookSummaryView }>('/api/note-remove', { id: deleteId });
        notes = notes.filter(item => item.id !== deleteId);
        if (res.summary) {
          applySummaryBadges(res.summary);
          loadedNotesSig = summarySignature(res.summary);
        }
        if (selectedNoteId === deleteId) {
          clearNoteWorkspace();
          if (notes.length > 0) {
            populateNoteEditor(notes[0]!, { mode: 'preview' });
          }
        }
        renderNotesList();
        announceStatus(`已删除笔记「${titleLabel}」`, 'polite');
        broadcastSync('notes');
        void hooks.refreshView();
      } catch (err) {
        if (selectedNoteId === deleteId) {
          setSaveStatus(`删除失败：${errorText(err)}`, 'red', true);
        }
      }
    })();
  }, listenerOpts);

  diarySearchInput.addEventListener('input', () => {
    diaryQuery = diarySearchInput.value;
    if (diarySearchTimer) clearTimeout(diarySearchTimer);
    diarySearchTimer = setTimeout(() => {
      diarySearchTimer = undefined;
      void loadDiary(true);
    }, 220);
  }, listenerOpts);

  diaryPromoteBtn.addEventListener('click', () => {
    if (!selectedDiaryId || !appState.ready || appState.authExpired) return;
    const targetId = selectedDiaryId;
    diaryPromoteBtn.disabled = true;
    diaryPromoteBtn.textContent = '转存中…';
    setDiaryStatus('正在转存至全息记忆…');
    void (async () => {
      try {
        const res = await api<{ entry: DiaryEntry; summary: NotebookSummaryView }>('/api/diary-promote-memory', { id: targetId });
        const idx = diaryEntries.findIndex(item => item.id === res.entry.id);
        if (idx >= 0) diaryEntries[idx] = res.entry;
        if (res.summary) {
          applySummaryBadges(res.summary);
          loadedDiarySig = summarySignature(res.summary);
        }
        if (selectedDiaryId === res.entry.id) {
          renderDiaryReader(res.entry);
          setDiaryStatus('✓ 已转存至全息记忆');
        }
        renderDiaryList();
        broadcastSync('diary');
        void hooks.refreshView();
      } catch (err) {
        if (selectedDiaryId === targetId) {
          const current = diaryEntries.find(item => item.id === targetId);
          diaryPromoteBtn.textContent = current?.promotedMemoryId ? '🧠 同步更新记忆' : '🧠 转存记忆';
          setDiaryStatus(`转存失败：${errorText(err)}`, 'error');
        }
      } finally {
        diaryPromoteBtn.disabled = !appState.ready || appState.authExpired;
      }
    })();
  }, listenerOpts);

  diaryDeleteBtn.addEventListener('click', () => {
    if (!selectedDiaryId) return;
    const targetId = selectedDiaryId;
    const titleLabel = diaryTitleDisplay.textContent || '这篇日记';
    void (async () => {
      const ok = await confirmAction({
        title: '删除日记',
        message: `确定要删除日记「${titleLabel}」吗？此操作无法撤销。`,
        confirmLabel: '确认删除',
        danger: true,
      });
      if (!ok || !appState.ready || appState.authExpired) return;
      try {
        const res = await api<{ removed: boolean; summary: NotebookSummaryView }>('/api/diary-remove', { id: targetId });
        diaryEntries = diaryEntries.filter(item => item.id !== targetId);
        if (res.summary) {
          applySummaryBadges(res.summary);
          loadedDiarySig = summarySignature(res.summary);
        }
        if (selectedDiaryId === targetId) {
          renderDiaryReader(diaryEntries[0]);
        }
        renderDiaryList();
        announceStatus(`已删除日记「${titleLabel}」`, 'polite');
        broadcastSync('diary');
        void hooks.refreshView();
      } catch (err) {
        if (selectedDiaryId === targetId) {
          setDiaryStatus(`删除失败：${errorText(err)}`, 'error');
        }
      }
    })();
  }, listenerOpts);

  syncChannel?.addEventListener('message', event => {
    const payload = event.data as { type?: string; tab?: NotebookTab } | undefined;
    if (payload?.type !== 'changed') return;
    void hooks.refreshView();
    if (!isNotebookOpen() || !appState.ready || appState.authExpired) return;
    if (payload.tab === 'diary') void loadDiary(false, true);
    else void loadNotes(false, true);
  }, listenerOpts);

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (isDocumentHidden() || !isNotebookOpen() || !appState.ready || appState.authExpired) return;
      if (activeTab === 'notes') void loadNotes(false, true);
      else void loadDiary(false, true);
    }, listenerOpts);
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      const shouldFlushDirty = Boolean((autoSaveTimer || noteDirty) && !pendingRemoteNote && appState.ready && !appState.authExpired);
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = undefined;
      }
      if (shouldFlushDirty) {
        const payload = buildPendingNotePayload(false);
        if (payload) {
          noteDirty = false;
          void api('/api/note-save', payload, { keepalive: true }).catch(() => {});
        }
      }
      clearPreviewTimer();
      if (searchDebounceTimer) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = undefined;
      }
      if (diarySearchTimer) {
        clearTimeout(diarySearchTimer);
        diarySearchTimer = undefined;
      }
      notesLoadAc?.abort();
      diaryLoadAc?.abort();
      lifecycleAc?.abort();
      syncChannel?.close();
    }, listenerOpts);
  }

  renderDiaryMoodFilters();

  return {
    openModal,
    closeModal,
    render,
    isOpen: isNotebookOpen,
  };
}

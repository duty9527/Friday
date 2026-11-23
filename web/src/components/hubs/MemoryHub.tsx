import type {
  ContextSearchHit,
  DiaryEntry,
  DiaryMood,
  MemoryCard,
  MemoryDirectoryItem,
  NoteItem,
  NoteTagCount,
  NotebookSummaryView,
} from '@friday/view.js';
import { GoldenBrainStage, type BrainMemoryItem } from '@friday/web/brain.js';
import { ApiError } from '@friday/web/shared/auth-http.js';
import { BOT_EXPRESSION_META, normalizeBotExpression } from '@friday/web/shared/bot-expressions.js';
import { errorText, timestamp } from '@friday/web/shared/format.js';
import {
  BrainIcon,
  EyeIcon,
  Link2Icon,
  PencilIcon,
  PinIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StaticBotAvatar } from '@/components/CompanionAvatar';
import { MarkdownContent } from '@/components/MarkdownContent';
import { ConfirmActionDialog } from '@/components/shared/ConfirmActionDialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useFriday } from '@/lib/friday-store';
import { cn } from '@/lib/utils';

const DIARY_MOODS: readonly DiaryMood[] = [
  'neutral',
  'happy',
  'calm',
  'surprised',
  'inspecting',
  'squinted',
  'sleepy',
  'confused',
  'sad',
];

function safeDiaryMood(raw: string | undefined): DiaryMood {
  if (!raw) return 'neutral';
  if ((DIARY_MOODS as readonly string[]).includes(raw)) return raw as DiaryMood;
  return normalizeBotExpression(raw) ?? 'neutral';
}

function MemoryMatrixPanel() {
  const { view, ready, authExpired, api, refreshView, selectTrace, setActiveHub, setMobilePanel, jumpMessage } = useFriday();
  const directoryItems = view?.memoryDirectory?.items ?? [];

  const [fullMemories, setFullMemories] = useState<MemoryCard[] | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<'all' | 'memory' | 'work' | 'message'>('all');
  const [searchHits, setSearchHits] = useState<ContextSearchHit[] | null>(null);
  const [selectedMemId, setSelectedMemId] = useState<string | undefined>(undefined);
  const [filterMode, setFilterMode] = useState<'all' | 'pinned'>('all');
  const [autoRotate, setAutoRotate] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [topic, setTopic] = useState('');
  const [content, setContent] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [pinned, setPinned] = useState(false);
  const [linkTargetId, setLinkTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<BrainMemoryItem | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const brainRef = useRef<GoldenBrainStage | null>(null);
  const searchSeqRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);

  const loadMemories = useCallback(async () => {
    if (!ready || authExpired) return;
    try {
      const list = await api<MemoryCard[]>('/api/memories', undefined, { priority: 'low' });
      if (Array.isArray(list)) setFullMemories(list);
    } catch {
      // Fallback to directoryItems
    }
  }, [api, authExpired, ready]);

  useEffect(() => {
    void loadMemories();
  }, [loadMemories]);

  const items: BrainMemoryItem[] = useMemo(() => {
    const base: BrainMemoryItem[] = fullMemories ?? directoryItems;
    return filterMode === 'pinned' ? base.filter(m => m.pinned) : base;
  }, [directoryItems, filterMode, fullMemories]);

  const matchedMemoryIds = useMemo(() => {
    if (!searchHits) return undefined;
    return searchHits
      .filter(h => h.kind === 'memory')
      .map(h => h.memoryId ?? h.id)
      .filter(Boolean);
  }, [searchHits]);

  // Mount and clean up 3D GoldenBrainStage canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const stage = new GoldenBrainStage(canvas, {
      onSelect: item => {
        setSelectedMemId(item?.id);
      },
    });
    brainRef.current = stage;
    stage.start();
    return () => {
      stage.dispose();
      brainRef.current = null;
    };
  }, []);

  useEffect(() => {
    brainRef.current?.setData(items, matchedMemoryIds, Boolean(searchHits));
  }, [items, matchedMemoryIds, searchHits]);

  const runSearch = async () => {
    const q = searchQuery.trim();
    if (!q) {
      searchSeqRef.current += 1;
      searchAbortRef.current?.abort();
      setSearchHits(null);
      return;
    }
    if (!ready || authExpired) return;
    const seq = ++searchSeqRef.current;
    searchAbortRef.current?.abort();
    const ac = new AbortController();
    searchAbortRef.current = ac;
    setErrMsg('');
    try {
      const res = await api<{ hits?: ContextSearchHit[] } | ContextSearchHit[]>(
        `/api/memories?${new URLSearchParams({ query: q, scope: searchScope })}`,
        undefined,
        { signal: ac.signal },
      );
      if (seq !== searchSeqRef.current || ac.signal.aborted) return;
      const hits = Array.isArray(res) ? res : (res.hits ?? []);
      setSearchHits(hits);
      const firstId = hits.find(h => h.kind === 'memory')?.memoryId ?? hits.find(h => h.kind === 'memory')?.id;
      if (firstId) brainRef.current?.focusMemory(firstId, true);
    } catch (e) {
      if (seq === searchSeqRef.current && !(e instanceof Error && e.name === 'AbortError')) {
        setErrMsg(`检索失败：${errorText(e)}`);
      }
    }
  };

  const selectedItem = useMemo(
    () => items.find(m => m.id === selectedMemId) ?? items[0],
    [items, selectedMemId],
  );

  const openEdit = (item: BrainMemoryItem) => {
    setEditingId(item.id);
    setTopic(item.topic);
    setContent('content' in item ? item.content : item.preview);
    setTagsText(item.tags.join(', '));
    setPinned(Boolean(item.pinned));
    setShowForm(true);
  };

  const saveMemory = async () => {
    if (!topic.trim() || !content.trim()) {
      setErrMsg('请填写记忆主题和内容');
      return;
    }
    setBusy(true);
    setErrMsg('');
    try {
      const tags = tagsText.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean);
      await api<MemoryCard>('/api/memory-save', {
        ...(editingId ? { id: editingId } : {}),
        topic: topic.trim(),
        content: content.trim(),
        ...(tags.length ? { tags } : {}),
        pinned,
      });
      setShowForm(false);
      setEditingId(null);
      setTopic('');
      setContent('');
      setTagsText('');
      setPinned(false);
      await Promise.all([refreshView(), loadMemories()]);
    } catch (e) {
      setErrMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const disabled = !ready || authExpired || busy;

  return (
    <div className="space-y-3">
      {/* Search Bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Input
            id="memory-search-input"
            size="sm"
            disabled={disabled}
            placeholder="全息联想检索（支持语境与突触扩散）…"
            value={searchQuery}
            onChange={e => {
              const v = e.target.value;
              setSearchQuery(v);
              if (!v.trim()) {
                searchSeqRef.current += 1;
                searchAbortRef.current?.abort();
                setSearchHits(null);
              }
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                e.preventDefault();
                void runSearch();
              }
            }}
          />
        </div>
        <select
          value={searchScope}
          disabled={disabled}
          onChange={e => setSearchScope(e.target.value as typeof searchScope)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="all">全部维度</option>
          <option value="memory">仅语义记忆</option>
          <option value="work">历史工作</option>
          <option value="message">历史对话</option>
        </select>
        <Button size="xs" variant="outline" disabled={disabled} onClick={() => void runSearch()}>
          <SearchIcon className="size-3.5" />
          <span>检索</span>
        </Button>
        <Button
          size="xs"
          variant={filterMode === 'pinned' ? 'secondary' : 'outline'}
          onClick={() => setFilterMode(prev => (prev === 'all' ? 'pinned' : 'all'))}
        >
          <PinIcon className="size-3" />
          <span>仅置顶</span>
        </Button>
        <Button
          size="xs"
          variant="default"
          disabled={disabled}
          onClick={() => {
            setEditingId(null);
            setTopic('');
            setContent('');
            setTagsText('');
            setPinned(false);
            setShowForm(v => !v);
          }}
        >
          <PlusIcon className="size-3.5" />
          <span>沉淀记忆</span>
        </Button>
      </div>

      {errMsg && (
        <Alert variant="error">
          <AlertDescription className="text-xs">{errMsg}</AlertDescription>
        </Alert>
      )}

      {/* Search Hits */}
      {searchHits && (
        <Card className="p-3 space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-semibold">联想检索命中 {searchHits.length} 条</span>
            <Button size="xs" variant="ghost" onClick={() => { setSearchQuery(''); setSearchHits(null); }}>
              清空结果
            </Button>
          </div>
          {searchHits.length === 0 ? (
            <p className="text-muted-foreground">未命中相关条目。</p>
          ) : (
            <div className="grid gap-1.5 sm:grid-cols-2">
              {searchHits.slice(0, 8).map(hit => (
                <button
                  key={`${hit.kind}-${hit.id}`}
                  type="button"
                  onClick={() => {
                    if (hit.kind === 'memory') {
                      const memId = hit.memoryId ?? hit.id;
                      setSelectedMemId(memId);
                      brainRef.current?.focusMemory(memId, true);
                    } else if (hit.kind === 'work' && hit.taskId) {
                      selectTrace({ type: 'task', id: hit.taskId, label: hit.title }, true);
                      setMobilePanel('trace');
                      setActiveHub(null);
                    } else if (hit.kind === 'message' && hit.messageId) {
                      setActiveHub(null);
                      void jumpMessage(hit.messageId);
                    }
                  }}
                  className="flex flex-col items-start gap-0.5 rounded-lg border bg-background p-2 text-start hover:bg-accent cursor-pointer"
                >
                  <div className="flex items-center gap-1.5 font-medium text-foreground">
                    <Badge size="sm" variant="outline">{hit.kind}</Badge>
                    <span className="truncate">{hit.title}</span>
                  </div>
                  <p className="line-clamp-2 text-muted-foreground">{hit.snippet}</p>
                </button>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Create/Edit Memory Form */}
      {showForm && (
        <Card className="p-3 space-y-2 text-xs">
          <div className="font-semibold">{editingId ? '编辑记忆卡片' : '写入新记忆'}</div>
          <Input size="sm" placeholder="主题（如：项目构建规范）" value={topic} onChange={e => setTopic(e.target.value)} />
          <Textarea size="sm" rows={3} placeholder="记忆详情内容…" value={content} onChange={e => setContent(e.target.value)} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Input size="sm" className="max-w-xs" placeholder="标签（逗号分隔）" value={tagsText} onChange={e => setTagsText(e.target.value)} />
            <label className="flex items-center gap-1.5 cursor-pointer">
              <Checkbox checked={pinned} onCheckedChange={v => setPinned(Boolean(v))} />
              <span>置顶（免艾宾浩斯遗忘衰减）</span>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="ghost" onClick={() => setShowForm(false)}>取消</Button>
            <Button size="xs" disabled={disabled} onClick={() => void saveMemory()}>保存记忆</Button>
          </div>
        </Card>
      )}

      {/* 3D Brain Stage + Selected Inspector */}
      <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
        <div className="space-y-2">
          <div className="relative overflow-hidden rounded-xl border bg-neutral-950">
            <canvas ref={canvasRef} className="block h-72 w-full cursor-grab active:cursor-grabbing" />
            <div className="absolute bottom-2 end-2 flex gap-1">
              <Button
                size="xs"
                variant="secondary"
                onClick={() => {
                  const next = !autoRotate;
                  setAutoRotate(next);
                  brainRef.current?.setAutoRotate(next);
                }}
              >
                {autoRotate ? '暂停旋转' : '自动旋转'}
              </Button>
              <Button size="xs" variant="secondary" onClick={() => brainRef.current?.resetView()}>
                <RotateCcwIcon className="size-3" />
                <span>重置视角</span>
              </Button>
            </div>
          </div>

          {selectedItem && (
            <Card className="p-3 text-xs space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 font-semibold text-foreground">
                  <BrainIcon className="size-3.5 text-amber-500" />
                  <span>{selectedItem.topic}</span>
                  {selectedItem.pinned && <Badge size="sm" variant="warning">置顶</Badge>}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={async () => {
                      await api('/api/memory-pin', { id: selectedItem.id, pinned: !selectedItem.pinned });
                      await Promise.all([refreshView(), loadMemories()]);
                    }}
                  >
                    <PinIcon className="size-3" />
                    <span>{selectedItem.pinned ? '取消置顶' : '置顶'}</span>
                  </Button>
                  <Button size="xs" variant="ghost" disabled={disabled} onClick={() => openEdit(selectedItem)}>
                    <PencilIcon className="size-3" />
                  </Button>
                  <Button size="xs" variant="ghost" disabled={disabled} onClick={() => setDeleteTarget(selectedItem)}>
                    <Trash2Icon className="size-3 text-destructive-foreground" />
                  </Button>
                </div>
              </div>
              <p className="whitespace-pre-wrap text-muted-foreground">
                {'content' in selectedItem ? selectedItem.content : selectedItem.preview}
              </p>
              {selectedItem.synapses && selectedItem.synapses.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-1">
                  {selectedItem.synapses.map(syn => (
                    <Button
                      key={syn.targetId}
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        setSelectedMemId(syn.targetId);
                        brainRef.current?.focusMemory(syn.targetId, true);
                      }}
                    >
                      <Link2Icon className="size-3" />
                      <span>{syn.targetTopic ?? syn.targetId} ({syn.weight.toFixed(2)})</span>
                    </Button>
                  ))}
                </div>
              )}
              {items.length > 1 && (
                <div className="flex items-center gap-1.5 border-t pt-2">
                  <select
                    value={linkTargetId}
                    onChange={e => setLinkTargetId(e.target.value)}
                    className="h-7 flex-1 rounded border border-input bg-background px-2 text-xs"
                  >
                    <option value="">选择另一条记忆建立突触关联…</option>
                    {items.filter(m => m.id !== selectedItem.id).map(m => (
                      <option key={m.id} value={m.id}>{m.topic}</option>
                    ))}
                  </select>
                  <Button
                    size="xs"
                    variant="secondary"
                    disabled={!linkTargetId || disabled}
                    onClick={async () => {
                      await api('/api/memory-link', { sourceId: selectedItem.id, targetId: linkTargetId });
                      setLinkTargetId('');
                      await Promise.all([refreshView(), loadMemories()]);
                    }}
                  >
                    连接突触
                  </Button>
                </div>
              )}
            </Card>
          )}
        </div>

        {/* Memory Cards List */}
        <div className="max-h-112 space-y-1.5 overflow-y-auto pe-1">
          {items.length === 0 ? (
            <p className="py-10 text-center text-xs text-muted-foreground">暂无记忆条目。</p>
          ) : (
            items.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setSelectedMemId(item.id);
                  brainRef.current?.focusMemory(item.id, true);
                }}
                className={cn(
                  'w-full cursor-pointer rounded-lg border p-2.5 text-start text-xs transition-colors',
                  selectedItem?.id === item.id ? 'border-ring bg-accent' : 'bg-card hover:bg-accent/50',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground truncate">{item.topic}</span>
                  {item.pinned && <Badge size="sm" variant="warning">置顶</Badge>}
                </div>
                <p className="mt-1 line-clamp-2 text-muted-foreground">
                  {'content' in item ? item.content : item.preview}
                </p>
              </button>
            ))
          )}
        </div>
      </div>

      <ConfirmActionDialog
        open={Boolean(deleteTarget)}
        onOpenChange={o => { if (!o) setDeleteTarget(null); }}
        title="遗忘记忆神经元"
        description={`确定要永久删除记忆「${deleteTarget?.topic ?? ''}」吗？`}
        confirmLabel="确认遗忘"
        busy={busy}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setBusy(true);
          try {
            await api('/api/memory-remove', { id: deleteTarget.id });
            setDeleteTarget(null);
            await Promise.all([refreshView(), loadMemories()]);
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

function NotesPanel() {
  const { ready, authExpired, api, refreshView } = useFriday();
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [tagsList, setTagsList] = useState<NoteTagCount[]>([]);
  const [query, setQuery] = useState('');
  const [filterTag, setFilterTag] = useState('');
  const [pinnedOnly, setPinnedOnly] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tagsDraft, setTagsDraft] = useState('');
  const [baseUpdatedAt, setBaseUpdatedAt] = useState<number | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');
  const [conflictNote, setConflictNote] = useState<NoteItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NoteItem | null>(null);
  const [busy, setBusy] = useState(false);

  const seqRef = useRef(0);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const payloadRef = useRef<Record<string, unknown> | null>(null);
  payloadRef.current = (isNew || selectedId)
    ? {
        ...(selectedId ? { id: selectedId } : {}),
        title,
        content,
        tags: tagsDraft.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
        author: 'user',
        updatedBy: 'user',
        ...(selectedId && baseUpdatedAt !== undefined ? { expectedUpdatedAt: baseUpdatedAt } : {}),
      }
    : null;

  const populate = useCallback((item: NoteItem) => {
    setSelectedId(item.id);
    setIsNew(false);
    setTitle(item.title);
    setContent(item.content);
    setTagsDraft(item.tags.join(', '));
    setBaseUpdatedAt(item.updatedAt);
    setDirty(false);
    setConflictNote(null);
  }, []);

  const loadNotes = useCallback(async (selectFirst = false) => {
    if (!ready || authExpired) return;
    const seq = ++seqRef.current;
    const params = new URLSearchParams();
    if (query.trim()) params.set('query', query.trim());
    if (filterTag.trim()) params.set('tag', filterTag.trim());
    if (pinnedOnly) params.set('pinned', '1');
    try {
      const res = await api<{ items?: NoteItem[]; tags?: NoteTagCount[] }>(`/api/notes${params.size ? `?${params}` : ''}`);
      if (seq !== seqRef.current) return;
      const items = res.items ?? [];
      setNotes(items);
      setTagsList(res.tags ?? []);
      if (selectFirst && items[0] && !dirtyRef.current) populate(items[0]);
    } catch (e) {
      if (seq === seqRef.current) setSaveStatus(`加载失败：${errorText(e)}`);
    }
  }, [api, authExpired, filterTag, pinnedOnly, populate, query, ready]);

  useEffect(() => {
    void loadNotes(true);
  }, [loadNotes]);

  // Flush dirty note on pagehide with keepalive
  useEffect(() => {
    const onPageHide = () => {
      if (dirtyRef.current && payloadRef.current && ready && !authExpired) {
        dirtyRef.current = false;
        void api('/api/note-save', payloadRef.current, { keepalive: true }).catch(() => {});
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [api, authExpired, ready]);

  const saveNote = async (forceOverwrite = false) => {
    if (!isNew && !selectedId) return;
    setBusy(true);
    setSaveStatus('保存中…');
    try {
      const res = await api<{ note: NoteItem; summary: NotebookSummaryView }>('/api/note-save', {
        ...(selectedId ? { id: selectedId } : {}),
        title,
        content,
        tags: tagsDraft.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
        author: 'user',
        updatedBy: 'user',
        ...(!forceOverwrite && selectedId && baseUpdatedAt !== undefined ? { expectedUpdatedAt: baseUpdatedAt } : {}),
      });
      populate(res.note);
      setSaveStatus('已保存');
      await Promise.all([loadNotes(false), refreshView()]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && selectedId) {
        try {
          const latest = await api<NoteItem>(`/api/note?id=${encodeURIComponent(selectedId)}`);
          setConflictNote(latest);
          setSaveStatus('检测到冲突，请选择保留版本');
        } catch {
          setSaveStatus('保存冲突，请刷新重试');
        }
      } else {
        setSaveStatus(`保存失败：${errorText(err)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const selectedNote = notes.find(n => n.id === selectedId);
  const disabled = !ready || authExpired || busy;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          size="sm"
          className="min-w-44 flex-1"
          placeholder="检索记事本…"
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <Button size="xs" variant={pinnedOnly ? 'secondary' : 'outline'} onClick={() => setPinnedOnly(v => !v)}>
          <PinIcon className="size-3" />
          <span>仅置顶</span>
        </Button>
        <Button
          size="xs"
          variant="default"
          disabled={disabled}
          onClick={() => {
            setSelectedId(null);
            setIsNew(true);
            setTitle('');
            setContent('');
            setTagsDraft('');
            setBaseUpdatedAt(undefined);
            setDirty(false);
            setConflictNote(null);
            setPreviewMode(false);
          }}
        >
          <PlusIcon className="size-3.5" />
          <span>新建笔记</span>
        </Button>
      </div>

      {tagsList.length > 0 && (
        <div className="flex flex-wrap gap-1">
          <Button size="xs" variant={!filterTag ? 'secondary' : 'ghost'} onClick={() => setFilterTag('')}>全部标签</Button>
          {tagsList.slice(0, 10).map(t => (
            <Button
              key={t.tag}
              size="xs"
              variant={filterTag === t.tag ? 'secondary' : 'outline'}
              onClick={() => setFilterTag(prev => (prev === t.tag ? '' : t.tag))}
            >
              {t.tag} ({t.count})
            </Button>
          ))}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-[220px_1fr]">
        <div className="max-h-96 space-y-1.5 overflow-y-auto pe-1">
          {notes.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">暂无笔记。</p>
          ) : (
            notes.map(n => (
              <button
                key={n.id}
                type="button"
                onClick={() => { populate(n); setPreviewMode(false); }}
                className={cn(
                  'w-full cursor-pointer rounded-lg border p-2 text-start text-xs',
                  selectedId === n.id ? 'border-ring bg-accent' : 'bg-card hover:bg-accent/50',
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate font-medium">{n.title || '无标题笔记'}</span>
                  {n.pinned && <PinIcon className="size-3 shrink-0 text-amber-500" />}
                </div>
                <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{n.content}</p>
              </button>
            ))
          )}
        </div>

        <Card className="p-3 space-y-2.5 text-xs">
          {!isNew && !selectedId ? (
            <p className="py-12 text-center text-muted-foreground">选择左侧笔记或点击「新建笔记」开始记录。</p>
          ) : (
            <>
              {conflictNote && (
                <Alert variant="warning">
                  <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span>远端笔记已更新（{timestamp(conflictNote.updatedAt)}）。</span>
                    <div className="flex gap-1.5">
                      <Button size="xs" variant="outline" onClick={() => populate(conflictNote)}>加载远端版本</Button>
                      <Button size="xs" variant="destructive" onClick={() => void saveNote(true)}>覆盖保存</Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Input
                  size="sm"
                  className="min-w-44 flex-1 font-semibold"
                  placeholder="笔记标题…"
                  value={title}
                  onChange={e => { setTitle(e.target.value); setDirty(true); }}
                />
                <div className="flex items-center gap-1">
                  <Button size="xs" variant="outline" onClick={() => setPreviewMode(v => !v)}>
                    <EyeIcon className="size-3" />
                    <span>{previewMode ? '编辑' : '预览'}</span>
                  </Button>
                  <Button size="xs" variant="default" disabled={disabled} onClick={() => void saveNote(false)}>
                    保存
                  </Button>
                  {selectedNote && (
                    <>
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={disabled}
                        onClick={async () => {
                          const res = await api<{ note: NoteItem }>('/api/note-pin', { id: selectedNote.id, pinned: !selectedNote.pinned });
                          populate(res.note);
                          await Promise.all([loadNotes(false), refreshView()]);
                        }}
                      >
                        <PinIcon className="size-3" />
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={disabled}
                        onClick={async () => {
                          const res = await api<{ note: NoteItem }>('/api/note-promote-memory', { id: selectedNote.id });
                          populate(res.note);
                          setSaveStatus('已转存至全息记忆');
                          await Promise.all([loadNotes(false), refreshView()]);
                        }}
                      >
                        <SparklesIcon className="size-3" />
                        <span>转存记忆</span>
                      </Button>
                      <Button size="xs" variant="ghost" disabled={disabled} onClick={() => setDeleteTarget(selectedNote)}>
                        <Trash2Icon className="size-3 text-destructive-foreground" />
                      </Button>
                    </>
                  )}
                </div>
              </div>

              <Input
                size="sm"
                placeholder="标签（逗号分隔）"
                value={tagsDraft}
                onChange={e => { setTagsDraft(e.target.value); setDirty(true); }}
              />

              {previewMode ? (
                <div className="min-h-48 rounded-lg border bg-background p-3">
                  <MarkdownContent text={content || '*空笔记*'} mode="assistant" />
                </div>
              ) : (
                <Textarea
                  rows={10}
                  placeholder="支持 Markdown 格式编写…"
                  value={content}
                  onChange={e => { setContent(e.target.value); setDirty(true); }}
                />
              )}

              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{saveStatus || (dirty ? '有未保存更改' : '已同步')}</span>
                {selectedNote && <span>更新于 {timestamp(selectedNote.updatedAt)}</span>}
              </div>
            </>
          )}
        </Card>
      </div>

      <ConfirmActionDialog
        open={Boolean(deleteTarget)}
        onOpenChange={o => { if (!o) setDeleteTarget(null); }}
        title="删除笔记"
        description={`确定要删除笔记「${deleteTarget?.title || '未命名笔记'}」吗？`}
        busy={busy}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setBusy(true);
          try {
            await api('/api/note-remove', { id: deleteTarget.id });
            setDeleteTarget(null);
            setSelectedId(null);
            setIsNew(false);
            await Promise.all([loadNotes(true), refreshView()]);
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

function DiaryPanel() {
  const { ready, authExpired, api, refreshView } = useFriday();
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [moodFilter, setMoodFilter] = useState<'all' | DiaryMood>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DiaryEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const [showWrite, setShowWrite] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newMood, setNewMood] = useState<DiaryMood>('calm');

  const seqRef = useRef(0);

  const loadDiary = useCallback(async (selectFirst = false) => {
    if (!ready || authExpired) return;
    const seq = ++seqRef.current;
    const params = new URLSearchParams();
    if (query.trim()) params.set('query', query.trim());
    if (moodFilter !== 'all') params.set('mood', moodFilter);
    try {
      const res = await api<{ items?: DiaryEntry[] }>(`/api/diary${params.size ? `?${params}` : ''}`);
      if (seq !== seqRef.current) return;
      const items = res.items ?? [];
      setEntries(items);
      if (selectFirst && items[0]) setSelectedId(prev => (prev && items.some(i => i.id === prev) ? prev : items[0]!.id));
    } catch (e) {
      if (seq === seqRef.current) setStatusMsg(`加载失败：${errorText(e)}`);
    }
  }, [api, authExpired, moodFilter, query, ready]);

  useEffect(() => {
    void loadDiary(true);
  }, [loadDiary]);

  const selected = entries.find(e => e.id === selectedId) ?? entries[0];
  const disabled = !ready || authExpired || busy;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input size="sm" className="min-w-44 flex-1" placeholder="搜索 F.R.I.D.A.Y. 日记…" value={query} onChange={e => setQuery(e.target.value)} />
        <select
          value={moodFilter}
          onChange={e => setMoodFilter(e.target.value as 'all' | DiaryMood)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="all">全部心情</option>
          {DIARY_MOODS.map(m => (
            <option key={m} value={m}>{BOT_EXPRESSION_META[m].plainEmoji} {BOT_EXPRESSION_META[m].label}</option>
          ))}
        </select>
        <Button size="xs" variant="outline" onClick={() => setShowWrite(v => !v)}>
          <PlusIcon className="size-3.5" />
          <span>手动写一篇</span>
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void loadDiary(true)}>
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>

      {showWrite && (
        <Card className="p-3 space-y-2 text-xs">
          <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
            <Input size="sm" placeholder="日记标题" value={newTitle} onChange={e => setNewTitle(e.target.value)} />
            <select
              value={newMood}
              onChange={e => setNewMood(e.target.value as DiaryMood)}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              {DIARY_MOODS.map(m => (
                <option key={m} value={m}>{BOT_EXPRESSION_META[m].plainEmoji} {BOT_EXPRESSION_META[m].label}</option>
              ))}
            </select>
          </div>
          <Textarea size="sm" rows={4} placeholder="写点什么…" value={newContent} onChange={e => setNewContent(e.target.value)} />
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="ghost" onClick={() => setShowWrite(false)}>取消</Button>
            <Button
              size="xs"
              disabled={disabled || !newContent.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await api<{ entry: DiaryEntry }>('/api/diary-write', {
                    title: newTitle.trim() || '日常随记',
                    content: newContent.trim(),
                    mood: newMood,
                    source: 'manual',
                  });
                  setNewTitle('');
                  setNewContent('');
                  setShowWrite(false);
                  setSelectedId(res.entry.id);
                  await Promise.all([loadDiary(false), refreshView()]);
                } catch (e) {
                  setStatusMsg(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              写入日记
            </Button>
          </div>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-[220px_1fr]">
        <div className="max-h-96 space-y-1.5 overflow-y-auto pe-1">
          {entries.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">暂无日记记录。</p>
          ) : (
            entries.map(entry => {
              const mood = safeDiaryMood(entry.mood);
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSelectedId(entry.id)}
                  className={cn(
                    'w-full cursor-pointer rounded-lg border p-2 text-start text-xs',
                    selected?.id === entry.id ? 'border-ring bg-accent' : 'bg-card hover:bg-accent/50',
                  )}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-mono text-[11px] text-muted-foreground">{entry.date}</span>
                    <span>{BOT_EXPRESSION_META[mood].plainEmoji}</span>
                  </div>
                  <div className="mt-0.5 truncate font-medium">{entry.title}</div>
                </button>
              );
            })
          )}
        </div>

        <Card className="p-4 text-xs space-y-3">
          {!selected ? (
            <p className="py-12 text-center text-muted-foreground">暂无日记选中。</p>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-2 border-b pb-2.5">
                <div className="flex items-center gap-2.5">
                  <StaticBotAvatar expr={safeDiaryMood(selected.mood)} size={32} />
                  <div>
                    <h4 className="text-sm font-semibold">{selected.title}</h4>
                    <div className="text-[11px] text-muted-foreground">
                      {selected.date} · 来源 {selected.source} · {BOT_EXPRESSION_META[safeDiaryMood(selected.mood)].label}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disabled}
                    onClick={async () => {
                      await api('/api/diary-promote-memory', { id: selected.id });
                      setStatusMsg('已转存至全息记忆');
                      await Promise.all([loadDiary(false), refreshView()]);
                    }}
                  >
                    <SparklesIcon className="size-3" />
                    <span>{selected.promotedMemoryId ? '同步记忆' : '转存记忆'}</span>
                  </Button>
                  <Button size="xs" variant="ghost" disabled={disabled} onClick={() => setDeleteTarget(selected)}>
                    <Trash2Icon className="size-3 text-destructive-foreground" />
                  </Button>
                </div>
              </div>
              {statusMsg && <p className="text-muted-foreground">{statusMsg}</p>}
              <MarkdownContent text={selected.content} mode="assistant" />
            </>
          )}
        </Card>
      </div>

      <ConfirmActionDialog
        open={Boolean(deleteTarget)}
        onOpenChange={o => { if (!o) setDeleteTarget(null); }}
        title="删除日记"
        description={`确定要删除日记「${deleteTarget?.title ?? ''}」吗？`}
        busy={busy}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setBusy(true);
          try {
            await api('/api/diary-remove', { id: deleteTarget.id });
            setDeleteTarget(null);
            await Promise.all([loadDiary(true), refreshView()]);
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

export function MemoryHub() {
  const { view, memoryTab, setMemoryTab } = useFriday();

  return (
    <Tabs value={memoryTab} onValueChange={v => setMemoryTab(v as 'matrix' | 'notes' | 'diary')}>
      <TabsList activateOnFocus>
        <TabsTab id="memory-tab-matrix" value="matrix">
          全息突触矩阵 ({view?.memoryDirectory?.totalActive ?? 0})
        </TabsTab>
        <TabsTab id="notebook-tab-notes" value="notes">
          记事本 ({view?.notebookSummary?.noteCount ?? 0})
        </TabsTab>
        <TabsTab id="notebook-tab-diary" value="diary">
          F.R.I.D.A.Y. 日记 ({view?.notebookSummary?.diaryCount ?? 0})
        </TabsTab>
      </TabsList>

      <TabsPanel id="memory-panel-matrix" value="matrix" keepMounted className="mt-3">
        <MemoryMatrixPanel />
      </TabsPanel>
      <TabsPanel id="notebook-panel-notes" value="notes" keepMounted className="mt-3">
        <NotesPanel />
      </TabsPanel>
      <TabsPanel id="notebook-panel-diary" value="diary" keepMounted className="mt-3">
        <DiaryPanel />
      </TabsPanel>
    </Tabs>
  );
}

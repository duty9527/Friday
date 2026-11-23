import type {
  ContextSearchHit,
  DiaryEntry,
  DiaryMood,
  MemoryCard,
  NoteItem,
  NoteTagCount,
  NotebookSummaryView,
} from '@friday/view.js';
import { GoldenBrainStage, type BrainMemoryItem } from '@friday/web/brain.js';
import { ApiError } from '@friday/web/shared/auth-http.js';
import { BOT_EXPRESSION_META, normalizeBotExpression } from '@friday/web/shared/bot-expressions.js';
import { errorText, synapseRelationNames, timestamp } from '@friday/web/shared/format.js';
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
import {
  FullContentDialog,
  ViewFullButton,
  type FullContentPayload,
} from '@/components/shared/FullContentViewer';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
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

const SELECT_SM_CLASS =
  'h-8 sm:h-7 rounded-lg border border-input bg-background px-2.5 text-xs text-foreground shadow-xs/5 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 disabled:opacity-64 dark:bg-input/32';

const EDITOR_TEXTAREA_CLASS =
  'block size-full resize-none overflow-y-auto rounded-lg border border-input bg-background px-3 py-2.5 font-mono text-sm leading-relaxed text-foreground shadow-xs/5 outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 disabled:opacity-64 dark:bg-input/32';

const BRAIN_STAGE_BTN_CLASS =
  'inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-amber-400/25 bg-neutral-950/80 px-2 text-[11px] font-medium text-amber-100 backdrop-blur-sm transition-colors hover:border-amber-400/50 hover:bg-neutral-900 hover:text-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60';

function MemoryMatrixPanel({ active }: { active: boolean }) {
  const { view, ready, authExpired, api, refreshView, selectTrace, setActiveHub, setMobilePanel, jumpMessage } = useFriday();

  const [fullMemories, setFullMemories] = useState<MemoryCard[] | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScope, setSearchScope] = useState<'all' | 'memories' | 'works' | 'messages'>('all');
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
  const [showAllHits, setShowAllHits] = useState(false);
  const [viewerPayload, setViewerPayload] = useState<FullContentPayload | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const brainRef = useRef<GoldenBrainStage | null>(null);
  const lastBrainSigRef = useRef('');
  const memFetchSeqRef = useRef(0);
  const searchSeqRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);

  const directorySig = useMemo(() => {
    const dir = view?.memoryDirectory;
    if (!dir) return 'empty';
    return `${dir.totalActive}:${dir.items.map(i => `${i.id}:${i.updatedAt}:${i.pinned ? 1 : 0}:${i.synapses?.length ?? 0}`).join(',')}`;
  }, [view?.memoryDirectory]);

  const loadMemories = useCallback(async () => {
    if (!ready || authExpired) return;
    const seq = ++memFetchSeqRef.current;
    try {
      const list = await api<MemoryCard[]>('/api/memories', undefined, { priority: 'low' });
      if (seq === memFetchSeqRef.current && Array.isArray(list)) {
        setFullMemories(list);
      }
    } catch {
      // Fallback to directoryItems
    }
  }, [api, authExpired, ready]);

  useEffect(() => {
    void loadMemories();
  }, [loadMemories, directorySig]);

  const allItems: BrainMemoryItem[] = useMemo(
    () => fullMemories ?? view?.memoryDirectory?.items ?? [],
    [fullMemories, view?.memoryDirectory?.items],
  );

  const allItemsById = useMemo(
    () => new Map(allItems.map(m => [m.id, m])),
    [allItems],
  );

  const visibleItems = useMemo(
    () => (filterMode === 'pinned' ? allItems.filter(m => m.pinned) : allItems),
    [allItems, filterMode],
  );

  const stats = useMemo(() => {
    let pinnedCount = 0;
    let synapseTotal = 0;
    for (const m of allItems) {
      if (m.pinned) pinnedCount += 1;
      synapseTotal += m.synapses?.length ?? 0;
    }
    return { pinnedCount, synapseTotal };
  }, [allItems]);

  const highlightedIds = useMemo(() => {
    if (searchHits) {
      return searchHits
        .filter(h => h.kind === 'memory')
        .map(h => h.memoryId ?? h.id)
        .filter(Boolean);
    }
    if (filterMode === 'pinned') {
      return visibleItems.map(m => m.id);
    }
    return undefined;
  }, [filterMode, searchHits, visibleItems]);

  const filterActive = Boolean(searchHits) || filterMode === 'pinned';

  const brainDataSig = useMemo(() => {
    const itemSig = allItems
      .map(m => `${m.id}:${m.updatedAt}:${m.pinned ? 1 : 0}:${m.synapses?.length ?? 0}`)
      .join('|');
    const hlSig = highlightedIds ? highlightedIds.join(',') : '';
    return `${fullMemories ? 'full' : 'dir'}|${itemSig}|hl:${hlSig}|f:${filterActive ? 1 : 0}`;
  }, [allItems, filterActive, fullMemories, highlightedIds]);

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
    lastBrainSigRef.current = '';
    setAutoRotate(stage.isAutoRotating());
    stage.start();
    return () => {
      stage.dispose();
      brainRef.current = null;
      lastBrainSigRef.current = '';
    };
  }, []);

  // Re-measure canvas after switching back to Matrix tab
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() => {
      brainRef.current?.resize();
    });
    return () => cancelAnimationFrame(raf);
  }, [active]);

  useEffect(() => {
    if (lastBrainSigRef.current === brainDataSig) return;
    lastBrainSigRef.current = brainDataSig;
    brainRef.current?.setData(allItems, highlightedIds, filterActive);
  }, [allItems, brainDataSig, filterActive, highlightedIds]);

  const focusItem = useCallback((id: string) => {
    const target = allItemsById.get(id);
    if (filterMode === 'pinned' && target && !target.pinned) {
      setFilterMode('all');
    }
    setSelectedMemId(id);
    setShowForm(false);
    setLinkTargetId('');
    brainRef.current?.focusMemory(id, true);
  }, [allItemsById, filterMode]);

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
        `/api/memories?${new URLSearchParams({ query: q, scope: searchScope, limit: '36' })}`,
        undefined,
        { signal: ac.signal },
      );
      if (seq !== searchSeqRef.current || ac.signal.aborted) return;
      const hits = Array.isArray(res) ? res : (res.hits ?? []);
      setShowAllHits(false);
      setSearchHits(hits);
      const firstId = hits.find(h => h.kind === 'memory')?.memoryId ?? hits.find(h => h.kind === 'memory')?.id;
      if (firstId) {
        setSelectedMemId(firstId);
        brainRef.current?.focusMemory(firstId, true);
      }
    } catch (e) {
      if (seq === searchSeqRef.current && !(e instanceof Error && e.name === 'AbortError')) {
        setErrMsg(`检索失败：${errorText(e)}`);
      }
    }
  };

  const selectedItem = useMemo(
    () => (selectedMemId ? allItemsById.get(selectedMemId) : undefined) ?? visibleItems[0] ?? allItems[0],
    [allItems, allItemsById, selectedMemId, visibleItems],
  );

  useEffect(() => {
    setLinkTargetId('');
  }, [selectedItem?.id]);

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
      const saved = await api<MemoryCard>('/api/memory-save', {
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
      if (saved?.id) setSelectedMemId(saved.id);
      await Promise.all([refreshView(), loadMemories()]);
    } catch (e) {
      setErrMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const disabled = !ready || authExpired || busy;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      {/* Aligned Search & Action Bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1">
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
          aria-label="检索维度"
          value={searchScope}
          disabled={disabled}
          onChange={e => setSearchScope(e.target.value as typeof searchScope)}
          className={SELECT_SM_CLASS}
        >
          <option value="all">全部维度</option>
          <option value="memories">仅语义记忆</option>
          <option value="works">历史工作</option>
          <option value="messages">历史对话</option>
        </select>
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => void runSearch()}>
          <SearchIcon className="size-3.5" />
          <span>检索</span>
        </Button>
        <Button
          size="sm"
          variant={filterMode === 'pinned' ? 'secondary' : 'outline'}
          onClick={() => setFilterMode(prev => (prev === 'all' ? 'pinned' : 'all'))}
        >
          <PinIcon className="size-3.5" />
          <span>仅置顶</span>
        </Button>
        <Button
          size="sm"
          variant={showForm ? 'secondary' : 'default'}
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
        <Alert variant="error" className="shrink-0">
          <AlertDescription className="text-xs">{errMsg}</AlertDescription>
        </Alert>
      )}

      {/* Bounded Search Hits */}
      {searchHits && (
        <Card className="flex max-h-44 shrink-0 flex-col overflow-hidden text-xs">
          <div className="flex shrink-0 items-center justify-between border-b px-3 py-1.5">
            <span className="font-semibold text-foreground">联想检索命中 {searchHits.length} 条</span>
            <div className="flex items-center gap-1">
              {searchHits.length > 8 && (
                <Button size="xs" variant="ghost" onClick={() => setShowAllHits(v => !v)}>
                  {showAllHits ? '收起至前 8 条' : `显示全部 (${searchHits.length})`}
                </Button>
              )}
              <Button size="xs" variant="ghost" onClick={() => { setSearchQuery(''); setSearchHits(null); setShowAllHits(false); }}>
                清空结果
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {searchHits.length === 0 ? (
              <p className="py-2 text-center text-muted-foreground">未命中相关条目。</p>
            ) : (
              <div className="grid gap-1.5 sm:grid-cols-2">
                {(showAllHits ? searchHits : searchHits.slice(0, 8)).map(hit => {
                  const matchedMem = hit.kind === 'memory' ? allItemsById.get(hit.memoryId ?? hit.id) : undefined;
                  const memBody = matchedMem ? ('content' in matchedMem ? matchedMem.content : matchedMem.preview) : hit.snippet;
                  return (
                    <div
                      key={`${hit.kind}-${hit.id}`}
                      className="flex flex-col gap-1 rounded-lg border bg-background p-2 transition-colors hover:bg-accent/40"
                    >
                      <div className="flex items-start justify-between gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            if (hit.kind === 'memory') {
                              focusItem(hit.memoryId ?? hit.id);
                            } else if (hit.kind === 'work' && hit.taskId) {
                              selectTrace({ type: 'task', id: hit.taskId, label: hit.title }, true);
                              setMobilePanel('trace');
                              setActiveHub(null);
                            } else if (hit.kind === 'message' && hit.messageId) {
                              setActiveHub(null);
                              void jumpMessage(hit.messageId);
                            }
                          }}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-start font-medium text-foreground hover:underline"
                        >
                          <Badge size="sm" variant="outline" className="shrink-0">{hit.kind}</Badge>
                          <span className="truncate" title={hit.title}>{hit.title}</span>
                        </button>
                        <ViewFullButton
                          className="shrink-0"
                          onClick={() =>
                            setViewerPayload({
                              title: hit.title,
                              badges: [{ label: hit.kind, variant: 'outline' }],
                              content: memBody,
                              mode: 'markdown',
                              ...(hit.kind === 'message' && hit.messageId
                                ? {
                                    truncatedHint: '点击下方按钮可拉取该历史消息的完整未截断正文。',
                                    loadFull: async () => {
                                      const res = await api<Record<string, unknown>>(
                                        `/api/message?messageId=${encodeURIComponent(hit.messageId!)}`,
                                      );
                                      return String(res.text ?? hit.snippet);
                                    },
                                  }
                                : hit.kind === 'work' && hit.taskId
                                  ? {
                                      truncatedHint: '点击下方按钮可拉取该后台工作的完整指令与总结报告。',
                                      loadFull: async () => {
                                        const res = await api<Record<string, unknown>>(
                                          `/api/work?taskId=${encodeURIComponent(hit.taskId!)}`,
                                        );
                                        const p = res.prompt ? `## 任务指令\n\n${String(res.prompt)}` : '';
                                        const r = res.report ? `\n\n## 总结报告\n\n${String(res.report)}` : '';
                                        return (p + r) || hit.snippet;
                                      },
                                    }
                                  : {}),
                            })
                          }
                        />
                      </div>
                      <p className="line-clamp-2 text-muted-foreground">{hit.snippet}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Strictly Aligned Two-Column Stage & Directory */}
      <div className="grid min-h-0 flex-1 gap-3 overflow-hidden max-lg:flex max-lg:flex-col lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        {/* Left Column: 3D Brain Canvas + Selected Memory Inspector */}
        <div className="flex min-h-0 flex-col gap-3 overflow-hidden max-lg:flex-1">
          <div className="relative h-44 shrink-0 overflow-hidden rounded-xl border bg-black sm:h-56 lg:h-64">
            <canvas
              ref={canvasRef}
              className="block size-full cursor-grab active:cursor-grabbing"
              aria-label="F.R.I.D.A.Y. 金色全息记忆球体"
            />
            <div className="absolute bottom-2.5 end-2.5 flex items-center gap-1.5">
              <button
                type="button"
                className={BRAIN_STAGE_BTN_CLASS}
                onClick={() => {
                  const next = !autoRotate;
                  const applied = brainRef.current?.setAutoRotate(next) ?? next;
                  setAutoRotate(applied);
                }}
              >
                {autoRotate ? '暂停旋转' : '自动旋转'}
              </button>
              <button
                type="button"
                className={BRAIN_STAGE_BTN_CLASS}
                onClick={() => {
                  brainRef.current?.resetView();
                  setAutoRotate(brainRef.current?.isAutoRotating() ?? true);
                }}
              >
                <RotateCcwIcon className="size-3" />
                <span>重置视角</span>
              </button>
            </div>
          </div>

          <Card className="flex min-h-0 flex-1 flex-col overflow-hidden text-xs">
            {!selectedItem ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-1 p-4 text-center text-muted-foreground">
                <BrainIcon className="size-5 text-amber-500/70" />
                <span>选择神经元节点或右侧目录条目查看记忆详情</span>
              </div>
            ) : (
              <>
                <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3.5 py-2.5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <BrainIcon className="size-3.5 shrink-0 text-amber-500" />
                    <span title={selectedItem.topic} className="truncate text-sm font-semibold text-foreground">{selectedItem.topic}</span>
                    {selectedItem.pinned && <Badge size="sm" variant="warning" className="shrink-0">置顶</Badge>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <ViewFullButton
                      onClick={() =>
                        setViewerPayload({
                          title: selectedItem.topic,
                          badges: selectedItem.tags.map(tag => ({ label: tag, variant: 'secondary' as const })),
                          subtitle: `提取 ${selectedItem.accessCount ?? 0} 次 · 更新于 ${timestamp(selectedItem.updatedAt)}`,
                          content: 'content' in selectedItem ? selectedItem.content : selectedItem.preview,
                          mode: 'markdown',
                        })
                      }
                    />
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
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label="编辑记忆"
                      disabled={disabled}
                      onClick={() => openEdit(selectedItem)}
                    >
                      <PencilIcon className="size-3" />
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label="遗忘记忆"
                      disabled={disabled}
                      onClick={() => setDeleteTarget(selectedItem)}
                    >
                      <Trash2Icon className="size-3 text-destructive-foreground" />
                    </Button>
                  </div>
                </div>

                <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3.5 py-2.5">
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
                    {'content' in selectedItem ? selectedItem.content : selectedItem.preview}
                  </p>

                  {(selectedItem.tags.length > 0 || selectedItem.updatedAt) && (
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      {selectedItem.tags.map(tag => (
                        <Badge key={tag} size="sm" variant="secondary">{tag}</Badge>
                      ))}
                      <span>提取 {selectedItem.accessCount ?? 0} 次 · 更新于 {timestamp(selectedItem.updatedAt)}</span>
                    </div>
                  )}

                  {selectedItem.synapses && selectedItem.synapses.length > 0 && (
                    <div className="space-y-1.5 border-t pt-2">
                      <div className="text-[11px] font-medium text-muted-foreground">
                        突触关联 ({selectedItem.synapses.length})
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {selectedItem.synapses.map(syn => {
                          const targetTopic = syn.targetTopic ?? allItemsById.get(syn.targetId)?.topic ?? syn.targetId;
                          const relLabel = synapseRelationNames[syn.relation] ?? syn.relation;
                          return (
                            <Button
                              key={`${syn.targetId}-${syn.relation}`}
                              size="xs"
                              variant="outline"
                              title={`${targetTopic} · ${relLabel} (${syn.weight.toFixed(2)})`}
                              onClick={() => focusItem(syn.targetId)}
                            >
                              <Link2Icon className="size-3" />
                              <span className="max-w-44 truncate">{targetTopic}</span>
                              <span className="font-mono text-[10px] text-muted-foreground">({syn.weight.toFixed(2)})</span>
                            </Button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {allItems.length > 1 && (
                  <div className="flex shrink-0 items-center gap-1.5 border-t bg-muted/20 px-3.5 py-2">
                    <select
                      aria-label="选择目标记忆"
                      value={linkTargetId}
                      onChange={e => setLinkTargetId(e.target.value)}
                      className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring dark:bg-input/32"
                    >
                      <option value="">选择另一条记忆建立突触关联…</option>
                      {allItems.filter(m => m.id !== selectedItem.id).map(m => (
                        <option key={m.id} value={m.id}>{m.topic}</option>
                      ))}
                    </select>
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={!linkTargetId || disabled}
                      onClick={async () => {
                        await api('/api/memory-link', { id: selectedItem.id, targetId: linkTargetId });
                        setLinkTargetId('');
                        await Promise.all([refreshView(), loadMemories()]);
                      }}
                    >
                      连接突触
                    </Button>
                  </div>
                )}
              </>
            )}
          </Card>
        </div>

        {/* Right Column: Aligned Memory Directory or Create/Edit Form */}
        <Card className="flex min-h-0 flex-col overflow-hidden text-xs max-lg:h-36 max-lg:shrink-0">
          {showForm ? (
            <>
              <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3.5 py-2.5">
                <span className="font-semibold text-foreground">{editingId ? '编辑记忆卡片' : '写入新记忆'}</span>
                <Button size="xs" variant="ghost" onClick={() => setShowForm(false)}>返回目录</Button>
              </div>
              <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3.5">
                <Input size="sm" placeholder="主题（如：项目构建规范）" value={topic} onChange={e => setTopic(e.target.value)} />
                <textarea
                  aria-label="记忆详情内容"
                  placeholder="记忆详情内容…"
                  value={content}
                  onChange={e => setContent(e.target.value)}
                  className="block min-h-36 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground shadow-xs/5 outline-none placeholder:text-muted-foreground/72 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 dark:bg-input/32"
                />
                <Input size="sm" placeholder="标签（逗号分隔）" value={tagsText} onChange={e => setTagsText(e.target.value)} />
                <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
                  <Checkbox checked={pinned} onCheckedChange={v => setPinned(Boolean(v))} />
                  <span>置顶（免艾宾浩斯遗忘衰减）</span>
                </label>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-2 border-t bg-muted/20 px-3.5 py-2.5">
                <Button size="xs" variant="ghost" onClick={() => setShowForm(false)}>取消</Button>
                <Button size="xs" disabled={disabled} onClick={() => void saveMemory()}>保存记忆</Button>
              </div>
            </>
          ) : (
            <>
              <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3.5 py-2.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-foreground">记忆目录</span>
                  <Badge size="sm" variant="secondary">
                    {filterMode === 'pinned' ? `${visibleItems.length} / ${allItems.length}` : visibleItems.length}
                  </Badge>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  置顶 {stats.pinnedCount} · 突触 {stats.synapseTotal}
                </span>
              </div>
              <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2.5">
                {visibleItems.length === 0 ? (
                  <div className="flex h-full items-center justify-center py-8 text-center text-muted-foreground">
                    {filterMode === 'pinned' && allItems.length > 0 ? '暂无置顶记忆。' : '暂无记忆条目。'}
                  </div>
                ) : (
                  visibleItems.map(item => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => focusItem(item.id)}
                      className={cn(
                        'w-full cursor-pointer rounded-lg border p-2.5 text-start text-xs transition-colors',
                        selectedItem?.id === item.id ? 'border-ring bg-accent' : 'bg-card hover:bg-accent/50',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-foreground">{item.topic}</span>
                        {item.pinned && <Badge size="sm" variant="warning" className="shrink-0">置顶</Badge>}
                      </div>
                      <p className="mt-1 line-clamp-2 text-muted-foreground">
                        {'content' in item ? item.content : item.preview}
                      </p>
                      {(item.tags.length > 0 || (item.synapses?.length ?? 0) > 0) && (
                        <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                          <span className="truncate">{item.tags.slice(0, 3).join(' · ')}</span>
                          {(item.synapses?.length ?? 0) > 0 && (
                            <span className="shrink-0 font-mono">突触 {item.synapses?.length ?? 0}</span>
                          )}
                        </div>
                      )}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </Card>
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

      <FullContentDialog payload={viewerPayload} onClose={() => setViewerPayload(null)} />
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
  const [previewMode, setPreviewMode] = useState(true);
  const [saveStatus, setSaveStatus] = useState('');
  const [conflictNote, setConflictNote] = useState<NoteItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NoteItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAllTags, setShowAllTags] = useState(false);
  const [viewerPayload, setViewerPayload] = useState<FullContentPayload | null>(null);

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
  const parsedTags = useMemo(
    () => tagsDraft.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
    [tagsDraft],
  );
  const disabled = !ready || authExpired || busy;
  const inPreview = previewMode && !isNew;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      {/* Fixed Search & Create Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="min-w-44 flex-1">
          <Input
            size="sm"
            placeholder="检索记事本…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
        <Button size="sm" variant={pinnedOnly ? 'secondary' : 'outline'} onClick={() => setPinnedOnly(v => !v)}>
          <PinIcon className="size-3.5" />
          <span>仅置顶</span>
        </Button>
        <Button
          size="sm"
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

      {/* Fixed Optional Tag Strip */}
      {tagsList.length > 0 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto pb-0.5">
          <Button size="xs" variant={!filterTag ? 'secondary' : 'ghost'} onClick={() => setFilterTag('')}>
            全部标签
          </Button>
          {(showAllTags ? tagsList : tagsList.slice(0, 10)).map(t => (
            <Button
              key={t.tag}
              size="xs"
              variant={filterTag === t.tag ? 'secondary' : 'outline'}
              onClick={() => setFilterTag(prev => (prev === t.tag ? '' : t.tag))}
            >
              {t.tag} ({t.count})
            </Button>
          ))}
          {tagsList.length > 10 && (
            <Button size="xs" variant="ghost" onClick={() => setShowAllTags(v => !v)}>
              {showAllTags ? '收起标签' : `全部 (${tagsList.length})`}
            </Button>
          )}
        </div>
      )}

      {/* Split Sidebar + Fixed-Header Internal-Scroll Reader/Editor */}
      <div className="grid min-h-0 flex-1 gap-3 overflow-hidden max-md:flex max-md:flex-col md:grid-cols-[240px_1fr]">
        <Card className="flex min-h-0 flex-col overflow-hidden text-xs max-md:h-36 max-md:shrink-0">
          <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
            <span className="font-semibold text-foreground">笔记列表</span>
            <span className="text-[11px] text-muted-foreground">{notes.length} 篇</span>
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
            {notes.length === 0 ? (
              <div className="flex h-full items-center justify-center py-6 text-center text-muted-foreground">
                暂无笔记。
              </div>
            ) : (
              notes.map(n => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    populate(n);
                    setPreviewMode(true);
                  }}
                  className={cn(
                    'w-full cursor-pointer rounded-lg border p-2 text-start text-xs transition-colors',
                    selectedId === n.id ? 'border-ring bg-accent' : 'bg-card hover:bg-accent/50',
                  )}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate font-medium text-foreground">{n.title || '无标题笔记'}</span>
                    {n.pinned && <PinIcon className="size-3 shrink-0 text-amber-500" />}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{n.content}</p>
                </button>
              ))
            )}
          </div>
        </Card>

        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden text-xs">
          {!isNew && !selectedId ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground">
              选择左侧笔记或点击「新建笔记」开始记录。
            </div>
          ) : (
            <>
              {/* Fixed Note Header */}
              <div className="shrink-0 space-y-2 border-b px-4 py-3">
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

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  {inPreview ? (
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <h3 title={title || '无标题笔记'} className="line-clamp-2 text-base font-semibold text-foreground">{title || '无标题笔记'}</h3>
                      {selectedNote?.pinned && <Badge size="sm" variant="warning" className="shrink-0">置顶</Badge>}
                    </div>
                  ) : (
                    <Input
                      size="sm"
                      className="min-w-40 flex-1 font-semibold"
                      placeholder="笔记标题…"
                      value={title}
                      onChange={e => { setTitle(e.target.value); setDirty(true); }}
                    />
                  )}

                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    {inPreview ? (
                      <>
                        <ViewFullButton
                          label="全屏阅读"
                          onClick={() =>
                            setViewerPayload({
                              title: title || '无标题笔记',
                              badges: parsedTags.map(tag => ({ label: tag, variant: 'secondary' as const })),
                              subtitle: selectedNote ? `更新于 ${timestamp(selectedNote.updatedAt)}` : undefined,
                              content: content || '*空笔记*',
                              mode: 'markdown',
                            })
                          }
                        />
                        <Button size="xs" variant="outline" onClick={() => setPreviewMode(false)}>
                          <PencilIcon className="size-3" />
                          <span>编辑</span>
                        </Button>
                      </>
                    ) : (
                      <>
                        {!isNew && (
                          <Button size="xs" variant="outline" onClick={() => setPreviewMode(true)}>
                            <EyeIcon className="size-3" />
                            <span>预览</span>
                          </Button>
                        )}
                        <Button size="xs" variant="default" disabled={disabled} onClick={() => void saveNote(false)}>
                          保存
                        </Button>
                      </>
                    )}
                    {selectedNote && (
                      <>
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={selectedNote.pinned ? '取消置顶笔记' : '置顶笔记'}
                          disabled={disabled}
                          onClick={async () => {
                            const res = await api<{ note: NoteItem }>('/api/note-pin', { id: selectedNote.id, pinned: !selectedNote.pinned });
                            populate(res.note);
                            await Promise.all([loadNotes(false), refreshView()]);
                          }}
                        >
                          <PinIcon className={cn('size-3', selectedNote.pinned && 'text-amber-500')} />
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
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label="删除笔记"
                          disabled={disabled}
                          onClick={() => setDeleteTarget(selectedNote)}
                        >
                          <Trash2Icon className="size-3 text-destructive-foreground" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                {inPreview ? (
                  parsedTags.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      {parsedTags.map(tag => (
                        <Badge key={tag} size="sm" variant="secondary">{tag}</Badge>
                      ))}
                    </div>
                  )
                ) : (
                  <Input
                    size="sm"
                    placeholder="标签（逗号分隔）"
                    value={tagsDraft}
                    onChange={e => { setTagsDraft(e.target.value); setDirty(true); }}
                  />
                )}
              </div>

              {/* Internally Scrollable Markdown Preview or Editor */}
              <div className="min-h-0 flex-1 overflow-hidden">
                {inPreview ? (
                  <div className="h-full overflow-y-auto px-4 py-3.5" data-testid="note-markdown-scroll">
                    <MarkdownContent text={content || '*空笔记*'} mode="assistant" />
                  </div>
                ) : (
                  <div className="h-full p-3">
                    <textarea
                      aria-label="笔记 Markdown 正文"
                      placeholder="支持 Markdown 格式编写…"
                      value={content}
                      onChange={e => { setContent(e.target.value); setDirty(true); }}
                      className={EDITOR_TEXTAREA_CLASS}
                    />
                  </div>
                )}
              </div>

              {/* Fixed Status Footer */}
              <div className="flex shrink-0 items-center justify-between border-t bg-muted/20 px-4 py-2 text-[11px] text-muted-foreground">
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

      <FullContentDialog payload={viewerPayload} onClose={() => setViewerPayload(null)} />
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
  const [viewerPayload, setViewerPayload] = useState<FullContentPayload | null>(null);

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
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      {/* Fixed Search & Mood Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="min-w-44 flex-1">
          <Input
            size="sm"
            placeholder="搜索 F.R.I.D.A.Y. 日记…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
        <select
          aria-label="按心情筛选"
          value={moodFilter}
          onChange={e => setMoodFilter(e.target.value as 'all' | DiaryMood)}
          className={SELECT_SM_CLASS}
        >
          <option value="all">全部心情</option>
          {DIARY_MOODS.map(m => (
            <option key={m} value={m}>{BOT_EXPRESSION_META[m].plainEmoji} {BOT_EXPRESSION_META[m].label}</option>
          ))}
        </select>
        <Button
          size="sm"
          variant={showWrite ? 'secondary' : 'outline'}
          onClick={() => setShowWrite(v => !v)}
        >
          <PlusIcon className="size-3.5" />
          <span>手动写一篇</span>
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="刷新日记" onClick={() => void loadDiary(true)}>
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>

      {/* Split Diary Archive + Fixed-Header Internal-Scroll Reader/Writer */}
      <div className="grid min-h-0 flex-1 gap-3 overflow-hidden max-md:flex max-md:flex-col md:grid-cols-[240px_1fr]">
        <Card className="flex min-h-0 flex-col overflow-hidden text-xs max-md:h-36 max-md:shrink-0">
          <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
            <span className="font-semibold text-foreground">日记归档</span>
            <span className="text-[11px] text-muted-foreground">{entries.length} 篇</span>
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
            {entries.length === 0 ? (
              <div className="flex h-full items-center justify-center py-6 text-center text-muted-foreground">
                暂无日记记录。
              </div>
            ) : (
              entries.map(entry => {
                const mood = safeDiaryMood(entry.mood);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(entry.id);
                      setShowWrite(false);
                    }}
                    className={cn(
                      'w-full cursor-pointer rounded-lg border p-2 text-start text-xs transition-colors',
                      selected?.id === entry.id && !showWrite ? 'border-ring bg-accent' : 'bg-card hover:bg-accent/50',
                    )}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-mono text-[11px] text-muted-foreground">{entry.date}</span>
                      <span>{BOT_EXPRESSION_META[mood].plainEmoji}</span>
                    </div>
                    <div className="mt-0.5 truncate font-medium text-foreground">{entry.title}</div>
                  </button>
                );
              })
            )}
          </div>
        </Card>

        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden text-xs">
          {showWrite ? (
            <>
              <div className="shrink-0 space-y-2 border-b px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">写一篇新日记</span>
                  <div className="flex items-center gap-1.5">
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
                </div>
                <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
                  <Input size="sm" placeholder="日记标题" value={newTitle} onChange={e => setNewTitle(e.target.value)} />
                  <select
                    aria-label="日记心情"
                    value={newMood}
                    onChange={e => setNewMood(e.target.value as DiaryMood)}
                    className={SELECT_SM_CLASS}
                  >
                    {DIARY_MOODS.map(m => (
                      <option key={m} value={m}>{BOT_EXPRESSION_META[m].plainEmoji} {BOT_EXPRESSION_META[m].label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="min-h-0 flex-1 p-3">
                <textarea
                  aria-label="日记 Markdown 正文"
                  placeholder="写点什么（支持 Markdown）…"
                  value={newContent}
                  onChange={e => setNewContent(e.target.value)}
                  className={EDITOR_TEXTAREA_CLASS}
                />
              </div>
            </>
          ) : !selected ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-muted-foreground">
              暂无日记选中。
            </div>
          ) : (
            <>
              {/* Fixed Diary Header */}
              <div className="shrink-0 space-y-1.5 border-b px-4 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    <StaticBotAvatar expr={safeDiaryMood(selected.mood)} size={32} />
                    <div className="min-w-0 flex-1">
                      <h4 title={selected.title} className="line-clamp-2 text-base font-semibold text-foreground">{selected.title}</h4>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {selected.date} · 来源 {selected.source} · {BOT_EXPRESSION_META[safeDiaryMood(selected.mood)].label}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1">
                    <ViewFullButton
                      label="全屏阅读"
                      onClick={() =>
                        setViewerPayload({
                          title: selected.title,
                          subtitle: `${selected.date} · 来源 ${selected.source} · ${BOT_EXPRESSION_META[safeDiaryMood(selected.mood)].label}`,
                          content: selected.content,
                          mode: 'markdown',
                        })
                      }
                    />
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
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label="删除日记"
                      disabled={disabled}
                      onClick={() => setDeleteTarget(selected)}
                    >
                      <Trash2Icon className="size-3 text-destructive-foreground" />
                    </Button>
                  </div>
                </div>
                {statusMsg && <p className="text-[11px] text-muted-foreground">{statusMsg}</p>}
              </div>

              {/* Internally Scrollable Diary Markdown Body */}
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5" data-testid="diary-markdown-scroll">
                <MarkdownContent text={selected.content} mode="assistant" />
              </div>
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

      <FullContentDialog payload={viewerPayload} onClose={() => setViewerPayload(null)} />
    </div>
  );
}

export function MemoryHub() {
  const { view, memoryTab, setMemoryTab } = useFriday();

  return (
    <Tabs
      value={memoryTab}
      onValueChange={v => setMemoryTab(v as 'matrix' | 'notes' | 'diary')}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden"
    >
      <div className="max-w-full shrink-0 overflow-x-auto">
        <TabsList activateOnFocus>
          <TabsTab id="memory-tab-matrix" value="matrix" className="max-sm:px-2 max-sm:text-xs">
            全息突触矩阵 ({view?.memoryDirectory?.totalActive ?? 0})
          </TabsTab>
          <TabsTab id="notebook-tab-notes" value="notes" className="max-sm:px-2 max-sm:text-xs">
            记事本 ({view?.notebookSummary?.noteCount ?? 0})
          </TabsTab>
          <TabsTab id="notebook-tab-diary" value="diary" className="max-sm:px-2 max-sm:text-xs">
            F.R.I.D.A.Y. 日记 ({view?.notebookSummary?.diaryCount ?? 0})
          </TabsTab>
        </TabsList>
      </div>

      <TabsPanel
        id="memory-panel-matrix"
        value="matrix"
        keepMounted
        className="mt-0 min-h-0 flex-1 flex-col overflow-hidden [&:not([hidden])]:flex"
      >
        <MemoryMatrixPanel active={memoryTab === 'matrix'} />
      </TabsPanel>
      <TabsPanel
        id="notebook-panel-notes"
        value="notes"
        keepMounted
        className="mt-0 min-h-0 flex-1 flex-col overflow-hidden [&:not([hidden])]:flex"
      >
        <NotesPanel />
      </TabsPanel>
      <TabsPanel
        id="notebook-panel-diary"
        value="diary"
        keepMounted
        className="mt-0 min-h-0 flex-1 flex-col overflow-hidden [&:not([hidden])]:flex"
      >
        <DiaryPanel />
      </TabsPanel>
    </Tabs>
  );
}

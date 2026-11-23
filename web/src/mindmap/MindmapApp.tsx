import type {
  FlowCategory,
  FlowchartEdge,
  FlowchartGraph,
  FlowchartNode,
  InspectorPayload,
  MindmapConsolidatedMemory,
  MindmapDeliveryItem,
  MindmapJevQualityGateItem,
  MindmapJevRouteInfo,
  MindmapSession,
  MindmapSnapshot,
  MindmapTaskDetail,
  MindmapTaskFlow,
} from '@friday/mindmap-types.js';
import {
  buildOverviewFlowchart,
  buildSessionFlowchart,
  formatClockShort,
  formatDuration,
  formatTimeShort,
  getEffectiveSessions,
  mergeSessionLists,
  resolveSessionTurns,
  shortText,
  sourceIcon,
  statusLabel,
} from '@friday/web/mindmap-data.js';
import { ApiError, createHttpClient, resolveBootstrapToken } from '@friday/web/shared/auth-http.js';
import { errorText } from '@friday/web/shared/format.js';
import {
  ArrowLeftIcon,
  ArrowUpRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  GitBranchIcon,
  HistoryIcon,
  ListIcon,
  MapIcon,
  Maximize2Icon,
  MinusIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SunIcon,
  XIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTab } from '@/components/ui/tabs';
import { useTheme } from '@/lib/theme';

type ViewMode = 'session' | 'overview' | 'list';
type FilterKind = 'all' | 'multiturn' | 'wechat' | 'local' | 'timer' | 'jev';

const CATEGORY_COLORS: Record<FlowCategory, string> = {
  core: 'var(--primary)',
  ingress: '#3b82f6',
  memory: '#a855f7',
  router: '#0ea5e9',
  jev: '#f59e0b',
  worker: '#10b981',
  quality: '#ec4899',
  im: '#22c55e',
};

const FILTER_OPTIONS: Array<{ key: FilterKind; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'multiturn', label: '多轮' },
  { key: 'wechat', label: '微信' },
  { key: 'local', label: '本地' },
  { key: 'timer', label: '定时' },
  { key: 'jev', label: 'JEV' },
];

function edgeStrokeColor(tone: FlowchartEdge['tone']): string {
  switch (tone) {
    case 'accent': return '#f59e0b';
    case 'warn': return '#ef4444';
    case 'success': return '#22c55e';
    default: return 'var(--muted-foreground)';
  }
}

function pointsToRoundedPath(pts: Array<{ x: number; y: number }>, radius = 8): string {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M ${pts[0]!.x} ${pts[0]!.y} L ${pts[1]!.x} ${pts[1]!.y}`;
  const cmds: string[] = [`M ${pts[0]!.x} ${pts[0]!.y}`];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1]!;
    const len1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const len2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    if (len1 < 1 || len2 < 1) {
      cmds.push(`L ${cur.x} ${cur.y}`);
      continue;
    }
    const r = Math.min(radius, len1 / 2, len2 / 2);
    const xBefore = cur.x - ((cur.x - prev.x) / len1) * r;
    const yBefore = cur.y - ((cur.y - prev.y) / len1) * r;
    const xAfter = cur.x + ((next.x - cur.x) / len2) * r;
    const yAfter = cur.y + ((next.y - cur.y) / len2) * r;
    cmds.push(`L ${xBefore.toFixed(1)} ${yBefore.toFixed(1)} Q ${cur.x} ${cur.y} ${xAfter.toFixed(1)} ${yAfter.toFixed(1)}`);
  }
  const last = pts[pts.length - 1]!;
  cmds.push(`L ${last.x} ${last.y}`);
  return cmds.join(' ');
}

function flowMatchesSearch(flow: MindmapTaskFlow, q: string): boolean {
  const hay = [
    String(flow.seq),
    flow.ingress.channelLabel,
    flow.ingress.text,
    ...flow.memoryRecall.recalledItems.map(m => `${m.title} ${m.snippet}`),
    ...flow.routerTurns.flatMap(rt => rt.tools.map(tl => `${tl.toolName} ${tl.inputPreview ?? ''}`)),
    ...flow.tasks.flatMap(t => [
      t.prompt,
      t.jevRoute?.response.selectedModel ?? '',
      t.jevRoute?.response.thinkingLevel ?? '',
      ...t.workerSteps.map(s => `${s.title} ${s.inputPreview ?? ''} ${s.outputPreview ?? ''}`),
    ]),
    ...flow.deliveries.map(d => d.text),
  ].join('\n').toLowerCase();
  return hay.includes(q);
}

function sessionMatchesFilter(
  session: MindmapSession,
  flowsById: Map<string, MindmapTaskFlow>,
  filterKind: FilterKind,
  searchTerm: string,
): boolean {
  const turns = resolveSessionTurns(session, flowsById);
  if (!turns.length) return false;
  if (filterKind === 'multiturn' && session.turnCount < 2) return false;
  if (filterKind === 'wechat' && !turns.some(t => t.ingress.sourceKind === 'wechat' || t.imPush.channel === 'wechat')) return false;
  if (filterKind === 'local' && !turns.some(t => t.ingress.sourceKind === 'local')) return false;
  if (filterKind === 'timer' && session.kind !== 'timer') return false;
  if (filterKind === 'jev' && !turns.some(t => t.tasks.some(tk => Boolean(tk.jevRoute?.called) || tk.jevQualityGates.length > 0))) return false;
  if (!searchTerm.trim()) return true;
  const q = searchTerm.trim().toLowerCase();
  return session.title.toLowerCase().includes(q) || turns.some(t => flowMatchesSearch(t, q));
}

export function MindmapApp() {
  const { preference, setPreference } = useTheme();
  const [bootstrap] = useState(() => resolveBootstrapToken());
  const [authExpired, setAuthExpired] = useState(!bootstrap.token);
  const [snapshot, setSnapshot] = useState<MindmapSnapshot | null>(null);
  const [loadedFlows, setLoadedFlows] = useState<MindmapTaskFlow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errMsg, setErrMsg] = useState('');

  const [viewMode, setViewMode] = useState<ViewMode>('session');
  const [filterKind, setFilterKind] = useState<FilterKind>('all');
  const [draftSearch, setDraftSearch] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const composingRef = useRef(false);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [collapseMap, setCollapseMap] = useState<Map<string, boolean>>(() => new Map());

  // SVG Pan & Zoom transform state
  const [pan, setPan] = useState({ x: 24, y: 20 });
  const [zoom, setZoom] = useState(0.95);
  const dragStateRef = useRef<{ active: boolean; moved: boolean; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Expanded payload cache for truncated operation/message/work text
  const [expandedText, setExpandedText] = useState<Record<string, string>>({});
  const [expandingKey, setExpandingKey] = useState('');

  // Inspector scroll preservation per inspected key
  const inspectorScrollRef = useRef<HTMLDivElement | null>(null);
  const lastInspKeyRef = useRef('');

  const http = useMemo(
    () =>
      createHttpClient({
        token: bootstrap.token,
        isExpired: () => authExpired,
        onAuthExpired: () => setAuthExpired(true),
        missingTokenMessage: '缺少本地访问令牌，请从当前服务首页跳转进入。',
      }),
    [authExpired, bootstrap.token],
  );

  const refreshMindmap = useCallback(async () => {
    if (authExpired) return;
    setLoading(true);
    setErrMsg('');
    try {
      const data = await http.api<MindmapSnapshot>('/api/mindmap?limit=120');
      setSnapshot(data);
      setLoadedFlows(prev => {
        const dbReset = Boolean(snapshot && data.cursor < snapshot.cursor);
        if (dbReset || prev.length === 0) return data.flows;
        const latestIds = new Set(data.flows.map(f => f.id));
        const older = prev.filter(f => !latestIds.has(f.id));
        return [...data.flows, ...older];
      });
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) {
        setErrMsg(`加载流程图失败：${errorText(err)}`);
      }
    } finally {
      setLoading(false);
    }
  }, [authExpired, http, snapshot]);

  useEffect(() => {
    void refreshMindmap();
    // Initial load on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMoreHistory = async () => {
    if (!snapshot?.hasMore || snapshot.beforeSeq === undefined || loadingMore || authExpired) return;
    setLoadingMore(true);
    try {
      const older = await http.api<MindmapSnapshot>(`/api/mindmap?limit=100&before=${snapshot.beforeSeq}`);
      setLoadedFlows(prev => {
        const seen = new Set(prev.map(f => f.id));
        return [...prev, ...older.flows.filter(f => !seen.has(f.id))];
      });
      setSnapshot(prev =>
        prev
          ? {
              ...prev,
              sessions: mergeSessionLists(prev.sessions, older.sessions),
              hasMore: older.hasMore,
              beforeSeq: older.beforeSeq,
            }
          : older,
      );
    } catch (err) {
      setErrMsg(`加载历史会话失败：${errorText(err)}`);
    } finally {
      setLoadingMore(false);
    }
  };

  // IME-safe debounced search
  useEffect(() => {
    if (composingRef.current) return;
    const t = setTimeout(() => setSearchTerm(draftSearch.trim()), 150);
    return () => clearTimeout(t);
  }, [draftSearch]);

  const flowsById = useMemo(() => new Map(loadedFlows.map(f => [f.id, f])), [loadedFlows]);
  const allSessions = useMemo(() => getEffectiveSessions(snapshot, loadedFlows), [loadedFlows, snapshot]);
  const filteredSessions = useMemo(
    () => allSessions.filter(s => sessionMatchesFilter(s, flowsById, filterKind, searchTerm)),
    [allSessions, filterKind, flowsById, searchTerm],
  );

  const activeSession = useMemo(
    () => filteredSessions.find(s => s.id === selectedSessionId) ?? filteredSessions[0] ?? null,
    [filteredSessions, selectedSessionId],
  );

  // Build FlowchartGraph
  const graph = useMemo<FlowchartGraph | null>(() => {
    if (viewMode === 'list') return null;
    if (viewMode === 'overview') {
      return buildOverviewFlowchart(filteredSessions, flowsById, snapshot, searchTerm);
    }
    if (!activeSession) return null;
    return buildSessionFlowchart(activeSession, flowsById, snapshot, collapseMap, searchTerm);
  }, [activeSession, collapseMap, filteredSessions, flowsById, searchTerm, snapshot, viewMode]);

  const selectedNode = useMemo<FlowchartNode | null>(() => {
    if (!graph || !graph.nodes.length) return null;
    return graph.nodes.find(n => n.id === selectedNodeId) ?? graph.nodes[0] ?? null;
  }, [graph, selectedNodeId]);

  const fitToView = useCallback(() => {
    if (!graph || !svgRef.current) {
      setPan({ x: 24, y: 20 });
      setZoom(0.95);
      return;
    }
    const rect = svgRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || graph.width <= 0 || graph.height <= 0) {
      setPan({ x: 24, y: 20 });
      setZoom(0.95);
      return;
    }
    const nextZoom = Math.max(0.25, Math.min(1.2, Math.min((rect.width - 40) / graph.width, (rect.height - 40) / graph.height)));
    setZoom(nextZoom);
    setPan({ x: 20, y: 20 });
  }, [graph]);

  // Reset inspector scroll only when actually switching to a different inspected item
  useEffect(() => {
    const key = selectedNode ? `${selectedNode.id}:${selectedNode.kind}` : '';
    if (key && key !== lastInspKeyRef.current) {
      lastInspKeyRef.current = key;
      if (inspectorScrollRef.current) inspectorScrollRef.current.scrollTop = 0;
    }
  }, [selectedNode]);

  const fetchExpanded = async (key: string, url: string, extract: (raw: Record<string, unknown>) => string) => {
    if (expandingKey || authExpired) return;
    setExpandingKey(key);
    try {
      const res = await http.api<Record<string, unknown>>(url);
      setExpandedText(prev => ({ ...prev, [key]: extract(res) }));
    } catch {
      setExpandedText(prev => ({ ...prev, [key]: '拉取完整内容失败' }));
    } finally {
      setExpandingKey('');
    }
  };

  const toggleNodeCollapse = (toggleKey: string, currentlyCollapsed: boolean) => {
    setCollapseMap(prev => {
      const next = new Map(prev);
      next.set(toggleKey, !currentlyCollapsed);
      return next;
    });
  };

  const setAllCollapsed = (collapsed: boolean) => {
    if (!graph) return;
    setCollapseMap(prev => {
      const next = new Map(prev);
      for (const f of graph.frames) {
        if (f.toggleKey) next.set(f.toggleKey, collapsed);
      }
      for (const n of graph.nodes) {
        if (n.toggleKey && (!collapsed || n.kind !== 'worker_more')) {
          next.set(n.toggleKey, collapsed);
        }
      }
      return next;
    });
  };

  // Pointer drag pan handlers
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const hitChild = (e.target as Element | null)?.closest?.('[data-interactive="true"]');
    if (hitChild) return;
    dragStateRef.current = { active: true, moved: false, startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y };
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const st = dragStateRef.current;
    if (!st?.active) return;
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    if (!st.moved && Math.hypot(dx, dy) >= 4) st.moved = true;
    if (st.moved) setPan({ x: st.origX + dx, y: st.origY + dy });
  };

  const onPointerUp = () => {
    if (dragStateRef.current) dragStateRef.current.active = false;
  };

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      setZoom(z => Math.max(0.25, Math.min(2.2, Number((z * factor).toFixed(2)))));
    } else {
      setPan(p => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }
  };

  const summary = snapshot?.summary;

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground overflow-hidden">
      {/* Top Bar */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b bg-card px-3 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <Button size="xs" variant="outline" render={<a href="/" />}>
            <ArrowLeftIcon className="size-3.5" />
            <span>主控台</span>
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            onClick={() => setSidebarCollapsed(v => !v)}
            title="切换会话目录"
            aria-label="切换会话目录"
          >
            {sidebarCollapsed ? <ChevronRightIcon className="size-4" /> : <ChevronLeftIcon className="size-4" />}
          </Button>
          <div className="flex items-center gap-1.5">
            <GitBranchIcon className="size-4 text-primary" />
            <h1 className="text-sm font-semibold">会话思考流程图</h1>
          </div>
          <Badge variant={authExpired ? 'error' : snapshot ? 'success' : 'secondary'}>
            {authExpired
              ? '认证失效'
              : snapshot
                ? `${allSessions.length} 会话 · ${loadedFlows.length} 轮`
                : '加载中…'}
          </Badge>
        </div>

        <Tabs value={viewMode} onValueChange={v => setViewMode(v as ViewMode)}>
          <TabsList>
            <TabsTab value="session">
              <GitBranchIcon className="size-3.5" />
              <span>会话详解</span>
            </TabsTab>
            <TabsTab value="overview">
              <MapIcon className="size-3.5" />
              <span>全局脉络</span>
            </TabsTab>
            <TabsTab value="list">
              <ListIcon className="size-3.5" />
              <span>数据清单</span>
            </TabsTab>
          </TabsList>
        </Tabs>

        <div className="flex flex-wrap items-center gap-1.5">
          <div className="relative w-44 sm:w-56">
            <SearchIcon className="pointer-events-none absolute start-2 top-2 size-3.5 text-muted-foreground" />
            <Input
              size="sm"
              className="ps-7 pe-7 h-7 text-xs"
              placeholder="搜会话、JEV、工具…"
              value={draftSearch}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={e => {
                composingRef.current = false;
                setSearchTerm((e.currentTarget.value || '').trim());
              }}
              onChange={e => setDraftSearch(e.target.value)}
            />
            {draftSearch && (
              <button
                type="button"
                aria-label="清除搜索"
                onClick={() => { setDraftSearch(''); setSearchTerm(''); }}
                className="absolute end-1.5 top-1.5 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            )}
          </div>

          {viewMode !== 'list' && (
            <div className="flex items-center gap-0.5 rounded-md border p-0.5">
              <Button size="icon-xs" variant="ghost" onClick={() => setAllCollapsed(false)} title="全部展开" aria-label="全部展开">
                <ChevronsUpDownIcon className="size-3.5" />
              </Button>
              <Button size="icon-xs" variant="ghost" onClick={() => setAllCollapsed(true)} title="仅看主干" aria-label="仅看主干">
                <ChevronsDownUpIcon className="size-3.5" />
              </Button>
              <Separator orientation="vertical" className="h-4 mx-0.5" />
              <Button size="icon-xs" variant="ghost" onClick={() => setZoom(z => Math.max(0.25, Number((z - 0.1).toFixed(2))))} aria-label="缩小">
                <MinusIcon className="size-3" />
              </Button>
              <span className="w-10 text-center font-mono text-[11px]">{Math.round(zoom * 100)}%</span>
              <Button size="icon-xs" variant="ghost" onClick={() => setZoom(z => Math.min(2.2, Number((z + 0.1).toFixed(2))))} aria-label="放大">
                <PlusIcon className="size-3" />
              </Button>
              <Button size="icon-xs" variant="ghost" onClick={fitToView} title="适应窗口" aria-label="适应窗口">
                <Maximize2Icon className="size-3" />
              </Button>
            </div>
          )}

          {/* Theme Switcher */}
          <div className="flex items-center gap-0.5 rounded-md border p-0.5">
            <Button
              id="mm-theme-system"
              size="icon-xs"
              variant={preference === 'system' ? 'secondary' : 'ghost'}
              onClick={() => setPreference('system')}
              aria-label="跟随系统主题"
            >
              <MonitorIcon className="size-3.5" />
            </Button>
            <Button
              id="mm-theme-light"
              size="icon-xs"
              variant={preference === 'light' ? 'secondary' : 'ghost'}
              onClick={() => setPreference('light')}
              aria-label="浅色主题"
            >
              <SunIcon className="size-3.5" />
            </Button>
            <Button
              id="mm-theme-dark"
              size="icon-xs"
              variant={preference === 'dark' ? 'secondary' : 'ghost'}
              onClick={() => setPreference('dark')}
              aria-label="深色主题"
            >
              <MoonIcon className="size-3.5" />
            </Button>
          </div>

          <Button size="xs" variant="outline" disabled={loading || authExpired} onClick={() => void refreshMindmap()}>
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Button size="xs" variant="ghost" render={<a href="/mindmap-legacy" />}>
            <span>经典视图</span>
            <ArrowUpRightIcon className="size-3" />
          </Button>
        </div>
      </header>

      {authExpired && (
        <Alert variant="error" className="mx-3 mt-2 shrink-0">
          <AlertDescription className="text-xs">
            当前页面缺少或失效了访问令牌。请返回 <a href="/" className="underline font-medium">F.R.I.D.A.Y. 主控台</a> 或通过携带令牌的本地链接打开。
          </AlertDescription>
        </Alert>
      )}
      {errMsg && (
        <Alert variant="error" className="mx-3 mt-2 shrink-0">
          <AlertDescription className="text-xs">{errMsg}</AlertDescription>
        </Alert>
      )}

      {/* Main 3-Pane Workspace */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left Session Directory */}
        {!sidebarCollapsed && (
          <aside className="flex w-72 shrink-0 flex-col border-e bg-card/40">
            {summary && (
              <div className="grid grid-cols-4 gap-1 border-b p-2 text-center text-[11px]">
                <div className="rounded bg-muted/40 p-1">
                  <div className="font-mono font-semibold">{summary.totalSessions}</div>
                  <div className="text-[10px] text-muted-foreground">会话</div>
                </div>
                <div className="rounded bg-muted/40 p-1">
                  <div className="font-mono font-semibold">{summary.totalFlows}</div>
                  <div className="text-[10px] text-muted-foreground">轮次</div>
                </div>
                <div className="rounded bg-muted/40 p-1">
                  <div className="font-mono font-semibold">{summary.totalTasks}</div>
                  <div className="text-[10px] text-muted-foreground">任务</div>
                </div>
                <div className="rounded bg-muted/40 p-1">
                  <div className="font-mono font-semibold">{summary.jevCalls}</div>
                  <div className="text-[10px] text-muted-foreground">JEV</div>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-1 border-b p-2">
              {FILTER_OPTIONS.map(f => (
                <Button
                  key={f.key}
                  size="xs"
                  variant={filterKind === f.key ? 'default' : 'ghost'}
                  onClick={() => setFilterKind(f.key)}
                >
                  {f.label}
                </Button>
              ))}
            </div>

            <ScrollArea className="flex-1 min-h-0">
              <div className="space-y-1.5 p-2">
                {filteredSessions.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">暂无匹配的会话链路</p>
                ) : (
                  filteredSessions.map(s => {
                    const active = activeSession?.id === s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          setSelectedSessionId(s.id);
                          setSelectedNodeId('');
                        }}
                        className={`w-full rounded-lg border p-2 text-left transition-colors ${
                          active ? 'border-primary bg-primary/10' : 'bg-card hover:bg-accent/50'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1 text-[11px]">
                          <Badge size="sm" variant={s.kind === 'timer' ? 'warning' : 'outline'}>
                            {s.primaryChannelLabel} · {s.turnCount} 轮
                          </Badge>
                          <span className="font-mono text-[10px] text-muted-foreground">{formatClockShort(s.updatedAt)}</span>
                        </div>
                        <div className="mt-1 line-clamp-2 text-xs font-medium">{s.title}</div>
                        <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                          {s.taskCount > 0 && <span>Worker {s.taskCount}</span>}
                          {s.jevCallCount > 0 && <span>JEV {s.jevCallCount}</span>}
                          {s.recalledMemoryCount > 0 && <span>召回 {s.recalledMemoryCount}</span>}
                        </div>
                      </button>
                    );
                  })
                )}

                {snapshot?.hasMore && (
                  <Button
                    size="xs"
                    variant="outline"
                    className="w-full"
                    disabled={loadingMore}
                    onClick={() => void loadMoreHistory()}
                  >
                    <HistoryIcon className="size-3.5" />
                    <span>{loadingMore ? '加载中…' : '加载更早会话'}</span>
                  </Button>
                )}
              </div>
            </ScrollArea>
          </aside>
        )}

        {/* Center Canvas or Matrix List */}
        <main className="relative flex min-w-0 flex-1 flex-col bg-muted/10 overflow-hidden">
          {viewMode === 'list' ? (
            <ScrollArea className="flex-1 p-3">
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {filteredSessions.map(s => {
                  const turns = resolveSessionTurns(s, flowsById);
                  return (
                    <Card key={s.id}>
                      <CardHeader className="pb-1">
                        <div className="flex items-center justify-between gap-1">
                          <Badge variant="outline">{s.primaryChannelLabel} · {s.turnCount} 轮</Badge>
                          <Badge variant={s.status === 'completed' ? 'success' : 'secondary'}>{statusLabel(s.status)}</Badge>
                        </div>
                        <CardTitle className="text-xs font-semibold line-clamp-2">{s.title}</CardTitle>
                        <CardDescription className="text-[11px] font-mono">{formatTimeShort(s.updatedAt)}</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-1.5 text-xs">
                        {turns.slice(0, 3).map(t => (
                          <div key={t.id} className="truncate text-muted-foreground">
                            {sourceIcon(t.ingress.sourceKind)} {shortText(t.ingress.text, 44)}
                          </div>
                        ))}
                        <Button
                          size="xs"
                          variant="outline"
                          className="w-full mt-1"
                          onClick={() => {
                            setSelectedSessionId(s.id);
                            setViewMode('session');
                          }}
                        >
                          查看思考流程图
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </ScrollArea>
          ) : !graph || graph.nodes.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
              <GitBranchIcon className="size-8 opacity-40" />
              <p>当前筛选条件下没有可展示的会话思考流程图</p>
            </div>
          ) : (
            <svg
              ref={svgRef}
              className="h-full w-full cursor-grab active:cursor-grabbing select-none"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onWheel={onWheel}
              role="img"
              aria-label="F.R.I.D.A.Y. 会话思考流程图画布"
            >
              <defs>
                <marker id="mm-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--muted-foreground)" />
                </marker>
              </defs>
              <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
                {/* Frames */}
                {graph.frames.map(fr => (
                  <g
                    key={fr.id}
                    data-interactive="true"
                    onDoubleClick={() => {
                      if (viewMode === 'overview') {
                        setSelectedSessionId(fr.sessionId);
                        setViewMode('session');
                      }
                    }}
                  >
                    <rect
                      x={fr.x}
                      y={fr.y}
                      width={fr.w}
                      height={fr.h}
                      rx="12"
                      fill="var(--card)"
                      fillOpacity="0.65"
                      stroke="var(--border)"
                      strokeWidth="1.2"
                      strokeDasharray={fr.collapsed ? '5 4' : undefined}
                    />
                    <text x={fr.x + 14} y={fr.y + 20} fill="var(--foreground)" fontSize="12" fontWeight="600">
                      {shortText(fr.title, 48)}
                    </text>
                    <text x={fr.x + 14} y={fr.y + 36} fill="var(--muted-foreground)" fontSize="10.5">
                      {shortText(fr.subtitle, 64)}
                    </text>
                    {fr.toggleKey && (
                      <g
                        className="cursor-pointer"
                        onClick={() => toggleNodeCollapse(fr.toggleKey!, Boolean(fr.collapsed))}
                      >
                        <rect x={fr.x + fr.w - 88} y={fr.y + 10} width="76" height="22" rx="6" fill="var(--secondary)" stroke="var(--border)" />
                        <text x={fr.x + fr.w - 50} y={fr.y + 24} textAnchor="middle" fill="var(--foreground)" fontSize="10">
                          {fr.collapsed ? '展开明细' : '收起节点'}
                        </text>
                      </g>
                    )}
                  </g>
                ))}

                {/* Edges */}
                {graph.edges.map(edge => (
                  <g key={edge.id}>
                    <path
                      d={pointsToRoundedPath(edge.points)}
                      fill="none"
                      stroke={edgeStrokeColor(edge.tone)}
                      strokeWidth={edge.kind === 'spine' ? 2 : 1.4}
                      strokeDasharray={edge.kind === 'loopback' ? '5 4' : undefined}
                      markerEnd="url(#mm-arrow)"
                    />
                    {edge.label && edge.labelX !== undefined && edge.labelY !== undefined && (
                      <text x={edge.labelX} y={edge.labelY} textAnchor="middle" fill="var(--muted-foreground)" fontSize="10">
                        {shortText(edge.label, 20)}
                      </text>
                    )}
                  </g>
                ))}

                {/* Nodes */}
                {graph.nodes.map(n => {
                  const isSelected = selectedNode?.id === n.id;
                  const accent = CATEGORY_COLORS[n.category] ?? 'var(--primary)';
                  return (
                    <g
                      key={n.id}
                      data-interactive="true"
                      transform={`translate(${n.x}, ${n.y})`}
                      className="cursor-pointer"
                      onClick={() => setSelectedNodeId(n.id)}
                    >
                      <rect
                        x="0"
                        y="0"
                        width={n.w}
                        height={n.h}
                        rx={n.shape === 'pill' ? Math.round(n.h / 2) : 10}
                        fill="var(--card)"
                        stroke={isSelected ? 'var(--primary)' : n.match ? '#f59e0b' : 'var(--border)'}
                        strokeWidth={isSelected || n.match ? 2.2 : 1.1}
                      />
                      <rect x="0" y="10" width="4" height={Math.max(12, n.h - 20)} rx="2" fill={accent} />
                      <text x="14" y="20" fill="var(--muted-foreground)" fontSize="10.5" fontWeight="500">
                        {n.icon} {shortText(n.badge, 26)}
                      </text>
                      {n.metric && (
                        <text x={n.w - 12} y="20" textAnchor="end" fill={accent} fontSize="10" fontWeight="600">
                          {shortText(n.metric, 14)}
                        </text>
                      )}
                      <text x="14" y="40" fill="var(--foreground)" fontSize="12" fontWeight="600">
                        {shortText(n.title, Math.max(16, Math.floor((n.w - 28) / 11)))}
                      </text>
                      <text x="14" y="57" fill="var(--muted-foreground)" fontSize="10.5">
                        {shortText(n.subtitle, Math.max(20, Math.floor((n.w - 28) / 9)))}
                      </text>
                      {n.toggleKey && (
                        <g
                          onClick={ev => {
                            ev.stopPropagation();
                            toggleNodeCollapse(n.toggleKey!, Boolean(n.collapsed));
                          }}
                        >
                          <rect x={n.w - 54} y={n.h - 22} width="46" height="16" rx="4" fill="var(--secondary)" />
                          <text x={n.w - 31} y={n.h - 11} textAnchor="middle" fill="var(--foreground)" fontSize="9.5">
                            {n.collapsed ? `+${n.hiddenCount ?? ''}` : '收起'}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
        </main>

        {/* Right Inspector */}
        <aside className="hidden lg:flex w-88 xl:w-96 shrink-0 flex-col border-s bg-card/50">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-xs font-semibold">节点检视面板</span>
            {selectedNode && <Badge variant="outline">{selectedNode.badge}</Badge>}
          </div>
          <div ref={inspectorScrollRef} className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
            {!selectedNode ? (
              <p className="py-8 text-center text-muted-foreground">点击流程图任意节点查看详情</p>
            ) : (
              <InspectorDetails
                node={selectedNode}
                expandedText={expandedText}
                expandingKey={expandingKey}
                onFetchExpanded={fetchExpanded}
                onJumpSession={sid => {
                  setSelectedSessionId(sid);
                  setViewMode('session');
                }}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function InspectorDetails({
  node,
  expandedText,
  expandingKey,
  onFetchExpanded,
  onJumpSession,
}: {
  node: FlowchartNode;
  expandedText: Record<string, string>;
  expandingKey: string;
  onFetchExpanded: (key: string, url: string, extract: (raw: Record<string, unknown>) => string) => void;
  onJumpSession: (sessionId: string) => void;
}) {
  const payload: InspectorPayload = node.inspector;
  const flow = payload.flow;

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge>{node.icon} {node.badge}</Badge>
          {node.status && <Badge variant="secondary">{statusLabel(node.status)}</Badge>}
          {node.metric && <Badge variant="outline">{node.metric}</Badge>}
        </div>
        <h2 className="text-sm font-semibold">{node.title}</h2>
        <p className="text-muted-foreground">{node.subtitle}</p>
        {payload.session && (
          <Button size="xs" variant="outline" onClick={() => onJumpSession(payload.session!.id)}>
            聚焦该会话完整流程图
          </Button>
        )}
      </div>

      <Separator />

      {flow && (
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs">接入与消息上下文</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs">
            <div className="flex justify-between"><span className="text-muted-foreground">渠道</span><span>{flow.ingress.channelLabel}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">时间</span><span className="font-mono">{formatTimeShort(flow.createdAt)}</span></div>
            <pre className="mt-1.5 max-h-36 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap break-words">
              {flow.ingress.text}
            </pre>
          </CardContent>
        </Card>
      )}

      {payload.jevRoute && <JevRouteCard jr={payload.jevRoute} />}
      {payload.jevQuality && <JevQualityCard qg={payload.jevQuality} />}
      {payload.routerTurn && (
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-xs">Router 推理轮次 ({payload.routerTurn.llmTurns} 轮)</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">触发</span><span>{payload.routerTurn.triggerKind}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">耗时</span><span className="font-mono">{formatDuration(payload.routerTurn.durationMs)}</span></div>
            {payload.routerTool && (
              <div className="mt-1 rounded border p-2 space-y-1">
                <div className="font-mono font-medium">{payload.routerTool.toolName}</div>
                {payload.routerTool.inputPreview && (
                  <pre className="max-h-28 overflow-auto rounded bg-muted/40 p-1.5 font-mono text-[11px]">{payload.routerTool.inputPreview}</pre>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {payload.task && (
        <TaskCard
          task={payload.task}
          expandedText={expandedText}
          expandingKey={expandingKey}
          onFetchExpanded={onFetchExpanded}
        />
      )}

      {payload.workerStep && payload.task && (
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-xs">Worker 步骤 · {payload.workerStep.title}</CardTitle></CardHeader>
          <CardContent className="space-y-1.5">
            <div className="flex justify-between">
              <span className="text-muted-foreground">状态 / 耗时</span>
              <span className="font-mono">{statusLabel(payload.workerStep.status)} · {formatDuration(payload.workerStep.durationMs)}</span>
            </div>
            {payload.workerStep.inputPreview && (
              <pre className="max-h-28 overflow-auto rounded bg-muted/40 p-1.5 font-mono text-[11px]">{payload.workerStep.inputPreview}</pre>
            )}
            {(expandedText[`op:${payload.task.id}:${payload.workerStep.operationId ?? ''}`] ?? payload.workerStep.outputPreview) && (
              <pre className="max-h-40 overflow-auto rounded bg-muted/40 p-1.5 font-mono text-[11px] whitespace-pre-wrap">
                {expandedText[`op:${payload.task.id}:${payload.workerStep.operationId ?? ''}`] ?? payload.workerStep.outputPreview}
              </pre>
            )}
            {payload.workerStep.operationId && payload.workerStep.hasFullOperation && !expandedText[`op:${payload.task.id}:${payload.workerStep.operationId}`] && (
              <Button
                size="xs"
                variant="outline"
                disabled={expandingKey === `op:${payload.task.id}:${payload.workerStep.operationId}`}
                onClick={() =>
                  onFetchExpanded(
                    `op:${payload.task!.id}:${payload.workerStep!.operationId}`,
                    `/api/operation?taskId=${encodeURIComponent(payload.task!.id)}&operationId=${encodeURIComponent(payload.workerStep!.operationId!)}`,
                    raw => String(raw.result ?? raw.error ?? '（空）'),
                  )
                }
              >
                拉取完整工具输出
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {payload.consolidatedMemory && <ConsolidatedMemoryCard mem={payload.consolidatedMemory} />}
      {payload.delivery && (
        <DeliveryCard
          delivery={payload.delivery}
          expandedText={expandedText}
          expandingKey={expandingKey}
          onFetchExpanded={onFetchExpanded}
        />
      )}
    </div>
  );
}

function JevRouteCard({ jr }: { jr: MindmapJevRouteInfo }) {
  return (
    <Card>
      <CardHeader className="pb-1"><CardTitle className="text-xs">JEV 选模与定级</CardTitle></CardHeader>
      <CardContent className="space-y-1 text-xs">
        <div className="flex justify-between"><span className="text-muted-foreground">来源</span><span>{jr.source}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">选中模型</span><span className="font-mono">{jr.response.selectedModel ?? '—'}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">思考深度</span><span>{jr.response.thinkingLevel ?? '—'}</span></div>
        {jr.response.confidence !== undefined && (
          <div className="flex justify-between"><span className="text-muted-foreground">置信度</span><span className="font-mono">{(jr.response.confidence * 100).toFixed(1)}%</span></div>
        )}
      </CardContent>
    </Card>
  );
}

function JevQualityCard({ qg }: { qg: MindmapJevQualityGateItem }) {
  return (
    <Card>
      <CardHeader className="pb-1"><CardTitle className="text-xs">第 {qg.index} 次 JEV 质检门禁</CardTitle></CardHeader>
      <CardContent className="space-y-1 text-xs">
        <div className="flex justify-between"><span className="text-muted-foreground">得分</span><span className="font-mono">{qg.response.score.toFixed(2)} / {qg.response.maxScore}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">结论</span><span>{qg.response.shouldSupplement ? '建议补充' : '通过达标'}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">缺失维度</span><span>{qg.response.missingAspect}</span></div>
      </CardContent>
    </Card>
  );
}

function TaskCard({
  task,
  expandedText,
  expandingKey,
  onFetchExpanded,
}: {
  task: MindmapTaskDetail;
  expandedText: Record<string, string>;
  expandingKey: string;
  onFetchExpanded: (key: string, url: string, extract: (raw: Record<string, unknown>) => string) => void;
}) {
  const workKey = `work:${task.id}`;
  const fullReport = expandedText[workKey] ?? task.reportPreview;
  return (
    <Card>
      <CardHeader className="pb-1"><CardTitle className="text-xs">Worker 任务 · {task.id.slice(0, 8)}</CardTitle></CardHeader>
      <CardContent className="space-y-1.5 text-xs">
        <div className="flex justify-between"><span className="text-muted-foreground">状态</span><span>{statusLabel(task.status)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">用时</span><span className="font-mono">{formatDuration(task.activeMs)}</span></div>
        {fullReport && (
          <pre className="max-h-36 overflow-auto rounded bg-muted/40 p-1.5 font-mono text-[11px] whitespace-pre-wrap">{fullReport}</pre>
        )}
        {task.reportTruncated && !expandedText[workKey] && (
          <Button
            size="xs"
            variant="outline"
            disabled={expandingKey === workKey}
            onClick={() => onFetchExpanded(workKey, `/api/work?taskId=${encodeURIComponent(task.id)}`, raw => String(raw.report ?? '（空）'))}
          >
            拉取完整报告
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function ConsolidatedMemoryCard({ mem }: { mem: MindmapConsolidatedMemory }) {
  return (
    <Card>
      <CardHeader className="pb-1"><CardTitle className="text-xs">沉淀记忆 · {mem.topic}</CardTitle></CardHeader>
      <CardContent className="space-y-1 text-xs">
        <p className="text-muted-foreground">突触数 {mem.synapseCount} · 标签 {mem.tags.join(', ')}</p>
        <p className="whitespace-pre-wrap">{mem.contentPreview}</p>
      </CardContent>
    </Card>
  );
}

function DeliveryCard({
  delivery,
  expandedText,
  expandingKey,
  onFetchExpanded,
}: {
  delivery: MindmapDeliveryItem;
  expandedText: Record<string, string>;
  expandingKey: string;
  onFetchExpanded: (key: string, url: string, extract: (raw: Record<string, unknown>) => string) => void;
}) {
  const key = `del:${delivery.messageId}`;
  const text = expandedText[key] ?? (delivery.text || delivery.reason || '（空）');
  return (
    <Card>
      <CardHeader className="pb-1"><CardTitle className="text-xs">回复投递 · #{delivery.seq}</CardTitle></CardHeader>
      <CardContent className="space-y-1.5 text-xs">
        <pre className="max-h-40 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap">{text}</pre>
        {delivery.textTruncated && !expandedText[key] && (
          <Button
            size="xs"
            variant="outline"
            disabled={expandingKey === key}
            onClick={() => onFetchExpanded(key, `/api/message?messageId=${encodeURIComponent(delivery.messageId)}`, raw => String(raw.text ?? '（空）'))}
          >
            拉取完整回复正文
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

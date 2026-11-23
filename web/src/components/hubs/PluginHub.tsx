import type { PluginActionSpec, PluginView } from '@friday/view.js';
import { errorText } from '@friday/web/shared/format.js';
import {
  classifyPluginActions,
  clearPluginOrder,
  filterAndGroupPlugins,
  formatRuntimeLabel,
  getPluginDisplayTitle,
  getPluginDomainLabel,
  getPluginQuickCheckArgs,
  getPluginSpecs,
  getPluginStatusInfo,
  getPluginSummary,
  isCustomOrder,
  isSafeQuickRunAction,
  mergePluginOrder,
  movePluginStep,
  type PluginCatalogFilter,
  readPluginOrder,
  readSidebarCollapsed,
  resolvePluginActionLabel,
  summarizePluginRunMessage,
  writePluginOrder,
  writeSidebarCollapsed,
} from '@friday/web/shared/plugin-catalog.js';
import {
  ActivityIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  BikeIcon,
  BluetoothIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  HomeIcon,
  LayoutGridIcon,
  MonitorIcon,
  PlayIcon,
  PlugIcon,
  RotateCcwIcon,
  ScaleIcon,
  SearchIcon,
  SmartphoneIcon,
  SunIcon,
  TerminalIcon,
  TrendingUpIcon,
} from 'lucide-react';
import {
  Component,
  type ComponentType,
  type ErrorInfo,
  lazy,
  type ReactNode,
  Suspense,
  useMemo,
  useState,
} from 'react';
import {
  FullContentDialog,
  ViewFullButton,
  type FullContentPayload,
} from '@/components/shared/FullContentViewer';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useFriday } from '@/lib/friday-store';

interface SurfaceMeta {
  name: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  Component: ReturnType<typeof lazy<ComponentType>>;
}

const SURFACE_LIST: SurfaceMeta[] = [
  { name: 'health-scale', label: '健康管理 · 沃莱 A1', icon: ScaleIcon, Component: lazy(() => import('@/components/plugins/HealthScaleSurface')) },
  { name: 'fund-tracker', label: '投资管理 · 基金持仓', icon: TrendingUpIcon, Component: lazy(() => import('@/components/plugins/FundTrackerSurface')) },
  { name: 'miot', label: '米家中枢 · BE6500', icon: HomeIcon, Component: lazy(() => import('@/components/plugins/MiotSurface')) },
  { name: 'cs80-face', label: 'CS80 实体副屏', icon: MonitorIcon, Component: lazy(() => import('@/components/plugins/Cs80FaceSurface')) },
  { name: 'apple-devices', label: '苹果设备 · Find My', icon: SmartphoneIcon, Component: lazy(() => import('@/components/plugins/AppleDevicesSurface')) },
  { name: 'laifen', label: '口腔护理 · 徕芬牙刷', icon: BluetoothIcon, Component: lazy(() => import('@/components/plugins/LaifenSurface')) },
  { name: 'ninebot', label: '九号守护 · 智能电摩', icon: BikeIcon, Component: lazy(() => import('@/components/plugins/NinebotSurface')) },
  { name: 'netlea', label: '鱼缸灯光 · 尼特利', icon: SunIcon, Component: lazy(() => import('@/components/plugins/NetleaSurface')) },
];

const SURFACE_BY_NAME = new Map(SURFACE_LIST.map(s => [s.name, s]));
const SURFACE_NAMES = new Set(SURFACE_LIST.map(s => s.name));
const DEFAULT_SURFACE_ORDER = SURFACE_LIST.map(s => s.name);

interface RunResult {
  ok: boolean;
  action: string;
  title?: string;
  message?: string;
  data?: unknown;
}

class PluginSurfaceErrorBoundary extends Component<
  { surfaceName: string; onBack: () => void; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Error is rendered in fallback UI for user retry
  }

  render() {
    if (this.state.error) {
      return (
        <Alert variant="error">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span>插件面板 ({this.props.surfaceName}) 加载失败：{this.state.error.message}</span>
            <div className="flex gap-1.5">
              <Button size="xs" variant="outline" onClick={() => this.setState({ error: null })}>重试</Button>
              <Button size="xs" variant="ghost" onClick={this.props.onBack}>返回目录</Button>
            </div>
          </AlertDescription>
        </Alert>
      );
    }
    return this.props.children;
  }
}

export function PluginHub() {
  const { view, ready, authExpired, api, pluginSurface, setPluginSurface } = useFriday();
  const plugins = view?.plugins ?? [];
  const timers = view?.timers ?? [];

  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => readSidebarCollapsed() ?? false);
  const [savedOrder, setSavedOrder] = useState<string[]>(() => readPluginOrder());
  const [filter, setFilter] = useState<PluginCatalogFilter>('all');
  const [query, setQuery] = useState('');

  // Quick-check state per plugin
  const [quickChecks, setQuickChecks] = useState<
    Record<string, { busy?: boolean; ok?: boolean; summary?: string; fullMessage?: string; data?: unknown }>
  >({});

  // Detail & Developer runner view inside catalog
  const [detailPluginName, setDetailPluginName] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'overview' | 'dev'>('overview');
  const [devAction, setDevAction] = useState('status');
  const [devArgsText, setDevArgsText] = useState('{}');
  const [runBusy, setRunBusy] = useState(false);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [resultCopied, setResultCopied] = useState(false);
  const [viewerPayload, setViewerPayload] = useState<FullContentPayload | null>(null);

  const orderedSurfaceNames = useMemo(
    () => mergePluginOrder(savedOrder, DEFAULT_SURFACE_ORDER),
    [savedOrder],
  );
  const hasCustomOrder = useMemo(
    () => isCustomOrder(savedOrder, DEFAULT_SURFACE_ORDER),
    [savedOrder],
  );

  const filteredResult = useMemo(
    () =>
      filterAndGroupPlugins({
        plugins,
        timers,
        surfaceNames: SURFACE_NAMES,
        order: savedOrder,
        filter,
        query,
      }),
    [filter, plugins, query, savedOrder, timers],
  );

  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    writeSidebarCollapsed(next);
  };

  const moveSurface = (name: string, delta: -1 | 1) => {
    const next = movePluginStep(savedOrder, orderedSurfaceNames, name, delta);
    setSavedOrder(next);
    writePluginOrder(next);
  };

  const resetOrder = () => {
    setSavedOrder([]);
    clearPluginOrder();
  };

  const activeSurfaceMeta = pluginSurface !== 'catalog' ? SURFACE_BY_NAME.get(pluginSurface) : undefined;
  const activeSurfacePlugin = plugins.find(p => p.name === pluginSurface);

  const runQuickCheck = async (plugin: PluginView) => {
    if (!ready || authExpired) return;
    setQuickChecks(prev => ({ ...prev, [plugin.name]: { busy: true } }));
    try {
      const res = await api<RunResult>('/api/plugin-run', {
        plugin: plugin.name,
        action: 'status',
        args: getPluginQuickCheckArgs(plugin.name),
      });
      setQuickChecks(prev => ({
        ...prev,
        [plugin.name]: {
          busy: false,
          ok: res.ok,
          summary: summarizePluginRunMessage(res.message || ''),
          fullMessage: res.message || '',
          data: res.data,
        },
      }));
    } catch (err) {
      setQuickChecks(prev => ({
        ...prev,
        [plugin.name]: {
          busy: false,
          ok: false,
          summary: `自检失败：${errorText(err)}`,
        },
      }));
    }
  };

  const openDetail = (plugin: PluginView, initialTab: 'overview' | 'dev' = 'overview', actionName?: string) => {
    const specs = getPluginSpecs(plugin);
    const chosen = actionName && specs.some(s => s.name === actionName) ? actionName : (specs[0]?.name ?? 'status');
    const matched = specs.find(s => s.name === chosen);
    setDetailPluginName(plugin.name);
    setDetailTab(initialTab);
    setDevAction(chosen);
    setDevArgsText(JSON.stringify(matched?.defaultArgs ?? {}));
    setRunResult(null);
  };

  const executePluginAction = async (plugin: PluginView, action: string, args: Record<string, unknown>) => {
    if (!ready || authExpired || runBusy) return;
    setRunBusy(true);
    setRunResult(null);
    try {
      const res = await api<RunResult>('/api/plugin-run', { plugin: plugin.name, action, args });
      setRunResult({ ...res, action });
    } catch (err) {
      setRunResult({ ok: false, action, message: `执行失败：${errorText(err)}` });
    } finally {
      setRunBusy(false);
    }
  };

  const detailPlugin = detailPluginName ? plugins.find(p => p.name === detailPluginName) : undefined;
  const detailClassified = detailPlugin ? classifyPluginActions(detailPlugin) : undefined;
  const detailSpecs = detailPlugin ? getPluginSpecs(detailPlugin) : [];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden md:flex-row">
      {/* Left Collapsible Sidebar */}
      <aside
        className={`shrink-0 rounded-xl border bg-muted/20 p-2 flex flex-col justify-between gap-2 transition-[width] max-md:max-h-36 md:h-full md:min-h-0 md:overflow-hidden ${
          sidebarCollapsed ? 'md:w-14' : 'md:w-56'
        }`}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden">
          <div className="flex items-center justify-between px-1">
            {!sidebarCollapsed && <span className="text-[11px] font-medium text-muted-foreground">专属硬件与应用</span>}
            <div className="flex items-center gap-0.5">
              {!sidebarCollapsed && hasCustomOrder && (
                <Button size="icon-xs" variant="ghost" onClick={resetOrder} title="恢复默认排序" aria-label="恢复默认排序">
                  <RotateCcwIcon className="size-3" />
                </Button>
              )}
              <Button size="icon-xs" variant="ghost" onClick={toggleSidebar} title={sidebarCollapsed ? '展开侧栏' : '折叠侧栏'} aria-label="切换插件侧栏">
                {sidebarCollapsed ? <ChevronRightIcon className="size-3.5" /> : <ChevronLeftIcon className="size-3.5" />}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap gap-1 overflow-y-auto md:min-h-0 md:flex-1 md:flex-col md:flex-nowrap">
            {orderedSurfaceNames.map((name, idx) => {
              const meta = SURFACE_BY_NAME.get(name);
              if (!meta) return null;
              const Icon = meta.icon;
              const isSelected = pluginSurface === name;
              const plg = plugins.find(p => p.name === name);
              const disabledFlag = plg && plg.enabled === false;
              return (
                <div key={name} className="group flex items-center gap-0.5">
                  <Button
                    size="xs"
                    variant={isSelected ? 'default' : 'ghost'}
                    className={`flex-1 justify-start gap-2 ${sidebarCollapsed ? 'px-2 justify-center' : ''}`}
                    title={meta.label}
                    onClick={() => {
                      setDetailPluginName(null);
                      setPluginSurface(name);
                    }}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    {!sidebarCollapsed && (
                      <span className={`truncate text-xs ${disabledFlag ? 'opacity-50' : ''}`}>
                        {meta.label}
                      </span>
                    )}
                  </Button>
                  {!sidebarCollapsed && (
                    <div className="hidden md:flex opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      <Button size="icon-xs" variant="ghost" disabled={idx === 0} onClick={() => moveSurface(name, -1)} aria-label={`上移 ${meta.label}`}>
                        <ArrowUpIcon className="size-2.5" />
                      </Button>
                      <Button size="icon-xs" variant="ghost" disabled={idx === orderedSurfaceNames.length - 1} onClick={() => moveSurface(name, 1)} aria-label={`下移 ${meta.label}`}>
                        <ArrowDownIcon className="size-2.5" />
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Pinned Catalog Button */}
        <div className="shrink-0 border-t pt-2">
          <Button
            size="xs"
            variant={pluginSurface === 'catalog' || !activeSurfaceMeta ? 'default' : 'outline'}
            className={`w-full justify-start gap-2 ${sidebarCollapsed ? 'px-2 justify-center' : ''}`}
            onClick={() => {
              setDetailPluginName(null);
              setPluginSurface('catalog');
            }}
          >
            <LayoutGridIcon className="size-3.5 shrink-0" />
            {!sidebarCollapsed && (
              <span className="flex flex-1 items-center justify-between text-xs">
                <span>插件目录</span>
                <Badge size="sm" variant="secondary">{plugins.length}</Badge>
              </span>
            )}
          </Button>
        </div>
      </aside>

      {/* Right Main Stage */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {activeSurfaceMeta ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b pb-2">
              <div className="flex items-center gap-2">
                <Button size="xs" variant="ghost" onClick={() => setPluginSurface('catalog')}>
                  <ArrowLeftIcon className="size-3.5" />
                  <span>目录</span>
                </Button>
                <span className="text-xs font-medium text-muted-foreground">{activeSurfaceMeta.label}</span>
                {activeSurfacePlugin?.enabled === false && <Badge variant="warning">插件当前未启用</Badge>}
              </div>
              {activeSurfacePlugin && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setPluginSurface('catalog');
                    openDetail(activeSurfacePlugin, 'dev');
                  }}
                >
                  <TerminalIcon className="size-3.5" />
                  <span>调试参数</span>
                </Button>
              )}
            </div>
            <div data-testid="plugin-hub-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pe-1 pt-3">
              <PluginSurfaceErrorBoundary
                key={pluginSurface}
                surfaceName={pluginSurface}
                onBack={() => setPluginSurface('catalog')}
              >
                <Suspense
                  fallback={
                    <div className="flex h-64 items-center justify-center gap-2 text-xs text-muted-foreground">
                      <Spinner className="size-4" />
                      <span>正在加载 {activeSurfaceMeta.label}…</span>
                    </div>
                  }
                >
                  <activeSurfaceMeta.Component />
                </Suspense>
              </PluginSurfaceErrorBoundary>
            </div>
          </div>
        ) : detailPlugin ? (
          /* Plugin Detail + Dev Runner */
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b pb-2">
              <div className="flex items-center gap-2">
                <Button size="xs" variant="ghost" onClick={() => setDetailPluginName(null)}>
                  <ArrowLeftIcon className="size-3.5" />
                  <span>返回目录</span>
                </Button>
                <h3 className="text-sm font-semibold">{getPluginDisplayTitle(detailPlugin)}</h3>
                <Badge variant={detailPlugin.enabled === false ? 'secondary' : 'success'}>
                  {getPluginStatusInfo(detailPlugin).label}
                </Badge>
              </div>
              {SURFACE_NAMES.has(detailPlugin.name) && (
                <Button size="xs" onClick={() => setPluginSurface(detailPlugin.name)}>
                  打开专属 UI 面板
                </Button>
              )}
            </div>

            <div data-testid="plugin-hub-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-4 pe-1 pt-3">
              <p className="text-xs text-muted-foreground">{getPluginSummary(detailPlugin)}</p>

            <Tabs value={detailTab} onValueChange={v => setDetailTab(v as 'overview' | 'dev')}>
              <TabsList>
                <TabsTab value="overview">能力总览 ({detailSpecs.length})</TabsTab>
                <TabsTab value="dev">参数调试与运行</TabsTab>
              </TabsList>

              <TabsPanel value="overview" className="mt-3 space-y-3">
                {(detailClassified?.primary ?? []).map((spec: PluginActionSpec) => {
                  const actLabel = resolvePluginActionLabel(detailSpecs, spec.name);
                  return (
                    <Card key={spec.name}>
                      <CardContent className="flex flex-wrap items-center justify-between gap-2 pt-3 text-xs">
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{actLabel}</span>
                            <code className="font-mono text-[11px] text-muted-foreground">{spec.name}</code>
                          </div>
                          {spec.description && <p className="text-muted-foreground">{spec.description}</p>}
                        </div>
                        <div className="flex gap-1.5">
                          {detailPlugin.enabled !== false && isSafeQuickRunAction(spec.name) && (
                            <Button
                              size="xs"
                              disabled={runBusy}
                              onClick={() => {
                                const args = spec.name === 'status'
                                  ? { ...(spec.defaultArgs ?? {}), ...getPluginQuickCheckArgs(detailPlugin.name) }
                                  : { ...(spec.defaultArgs ?? {}) };
                                void executePluginAction(detailPlugin, spec.name, args);
                              }}
                            >
                              <PlayIcon className="size-3" />
                              <span>运行</span>
                            </Button>
                          )}
                          <Button size="xs" variant="outline" onClick={() => openDetail(detailPlugin, 'dev', spec.name)}>
                            调试
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
                {(detailClassified?.management.length ?? 0) > 0 && (
                  <p className="text-[11px] text-muted-foreground">
                    另有 {detailClassified?.management.length} 项配置 / 管理动作，请切换到「参数调试与运行」查看与执行。
                  </p>
                )}
              </TabsPanel>

              <TabsPanel value="dev" className="mt-3 space-y-3">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">动作与 JSON 参数调试台</CardTitle>
                    <CardDescription className="text-xs">
                      运行模式：{formatRuntimeLabel(detailPlugin.runtime)} · 入口：{detailPlugin.entry}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3 text-xs">
                    <div className="space-y-1">
                      <Label className="text-xs">选择动作</Label>
                      <select
                        value={devAction}
                        onChange={e => {
                          const next = e.target.value;
                          setDevAction(next);
                          const matched = detailSpecs.find(s => s.name === next);
                          setDevArgsText(JSON.stringify(matched?.defaultArgs ?? {}));
                        }}
                        className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
                      >
                        {detailSpecs.map(s => (
                          <option key={s.name} value={s.name}>{s.name}{s.label ? ` — ${s.label}` : ''}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">调试参数 (JSON 对象)</Label>
                      <Textarea
                        size="sm"
                        rows={3}
                        className="font-mono text-xs"
                        value={devArgsText}
                        onChange={e => setDevArgsText(e.target.value)}
                      />
                    </div>
                    <Button
                      size="sm"
                      disabled={runBusy || detailPlugin.enabled === false}
                      onClick={() => {
                        let parsed: Record<string, unknown> = {};
                        const raw = devArgsText.trim();
                        if (raw) {
                          try {
                            const val: unknown = JSON.parse(raw);
                            if (!val || typeof val !== 'object' || Array.isArray(val)) {
                              throw new Error('参数必须是 JSON 对象');
                            }
                            parsed = val as Record<string, unknown>;
                          } catch (err) {
                            setRunResult({ ok: false, action: devAction, message: `参数 JSON 解析失败：${errorText(err)}` });
                            return;
                          }
                        }
                        void executePluginAction(detailPlugin, devAction, parsed);
                      }}
                    >
                      <PlayIcon className="size-3.5" />
                      <span>立即运行该动作</span>
                    </Button>
                  </CardContent>
                </Card>
              </TabsPanel>
            </Tabs>

            {runResult && (() => {
              const formattedResult = [
                runResult.message ?? '',
                runResult.data !== undefined ? JSON.stringify(runResult.data, null, 2) : '',
              ].filter(Boolean).join('\n\n');
              return (
                <Card>
                  <CardHeader className="pb-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Badge variant={runResult.ok ? 'success' : 'error'}>{runResult.ok ? '成功' : '异常'}</Badge>
                        <span className="font-mono text-xs">{runResult.action}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {formattedResult && (
                          <>
                            <ViewFullButton
                              onClick={() =>
                                setViewerPayload({
                                  title: `动作执行完整返回 · ${runResult.action}`,
                                  badges: [{ label: runResult.ok ? '成功' : '异常', variant: runResult.ok ? 'success' : 'error' }],
                                  content: formattedResult,
                                  mode: 'code',
                                })
                              }
                            />
                            <Button
                              size="xs"
                              variant="ghost"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard?.writeText(formattedResult);
                                  setResultCopied(true);
                                  setTimeout(() => setResultCopied(false), 1600);
                                } catch {
                                  // ignore
                                }
                              }}
                            >
                              {resultCopied ? <CheckIcon className="size-3 text-success-foreground" /> : <CopyIcon className="size-3" />}
                              <span>{resultCopied ? '已复制' : '复制'}</span>
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2 text-xs">
                    {runResult.message && <p className="whitespace-pre-wrap break-words">{runResult.message}</p>}
                    {runResult.data !== undefined && (
                      <pre className="max-h-56 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px]">
                        {JSON.stringify(runResult.data, null, 2)}
                      </pre>
                    )}
                  </CardContent>
                </Card>
              );
            })()}
            </div>
          </div>
        ) : (
          /* Catalog View */
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
              <div className="relative flex-1 min-w-44">
                <SearchIcon className="pointer-events-none absolute start-2.5 top-2 size-3.5 text-muted-foreground" />
                <Input
                  size="sm"
                  className="ps-8"
                  placeholder="搜索插件名称、功能或动作…"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
              </div>
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    { k: 'all', l: `全部 (${filteredResult.counts.all})` },
                    { k: 'surface', l: `专属面板 (${filteredResult.counts.surface})` },
                    { k: 'extension', l: `扩展插件 (${filteredResult.counts.extension})` },
                    { k: 'voice', l: `语音快路 (${filteredResult.counts.voice})` },
                    { k: 'timer', l: `定时联动 (${filteredResult.counts.timer})` },
                  ] as const
                ).map(item => (
                  <Button
                    key={item.k}
                    size="xs"
                    variant={filter === item.k ? 'default' : 'outline'}
                    onClick={() => setFilter(item.k)}
                  >
                    {item.l}
                  </Button>
                ))}
              </div>
            </div>

            <div data-testid="plugin-hub-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pe-1">
              {filteredResult.items.length === 0 ? (
                <div className="flex h-40 flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-xs text-muted-foreground">
                  <PlugIcon className="size-5" />
                  <span>没有匹配条件的插件</span>
                </div>
              ) : (
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {filteredResult.items.map(p => {
                    const hasSurface = SURFACE_NAMES.has(p.name);
                    const qc = quickChecks[p.name];
                    const stInfo = getPluginStatusInfo(p);
                    return (
                      <Card key={p.name}>
                        <CardHeader className="pb-1">
                          <div className="flex items-center justify-between gap-2">
                            <CardTitle className="text-xs font-semibold truncate">{getPluginDisplayTitle(p)}</CardTitle>
                            <div className="flex shrink-0 items-center gap-1">
                              <Badge variant="outline">{getPluginDomainLabel(p, hasSurface)}</Badge>
                              <Badge variant={p.enabled === false ? 'secondary' : 'success'}>{stInfo.label}</Badge>
                            </div>
                          </div>
                          <CardDescription className="line-clamp-2 text-[11px]">{getPluginSummary(p)}</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-2 text-xs">
                          {qc?.summary && (
                            <div className={`flex items-start justify-between gap-2 rounded border px-2 py-1 text-[11px] ${qc.ok ? 'border-success/30 bg-success/5 text-foreground' : 'border-warning/30 bg-warning/5 text-muted-foreground'}`}>
                              <span className="min-w-0 flex-1 break-words">{qc.summary}</span>
                              {(qc.fullMessage || qc.data !== undefined) && (
                                <ViewFullButton
                                  className="shrink-0"
                                  onClick={() =>
                                    setViewerPayload({
                                      title: `${getPluginDisplayTitle(p)} · 快速自检完整结果`,
                                      badges: [{ label: qc.ok ? '通过' : '异常', variant: qc.ok ? 'success' : 'warning' }],
                                      content: [
                                        qc.fullMessage ?? qc.summary ?? '',
                                        qc.data !== undefined ? JSON.stringify(qc.data, null, 2) : '',
                                      ].filter(Boolean).join('\n\n'),
                                      mode: 'code',
                                    })
                                  }
                                />
                              )}
                            </div>
                          )}
                          <div className="flex flex-wrap items-center justify-between gap-1.5 pt-0.5">
                            <span className="font-mono text-[10px] text-muted-foreground">{p.actions.length} 个动作</span>
                            <div className="flex flex-wrap gap-1">
                              {p.enabled !== false && (
                                <Button size="xs" variant="ghost" disabled={qc?.busy} onClick={() => void runQuickCheck(p)}>
                                  <ActivityIcon className="size-3" />
                                  <span>{qc?.busy ? '自检中…' : '快速自检'}</span>
                                </Button>
                              )}
                              <Button size="xs" variant="outline" onClick={() => openDetail(p, 'overview')}>详情</Button>
                              {hasSurface && (
                                <Button size="xs" onClick={() => setPluginSurface(p.name)}>打开面板</Button>
                              )}
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <FullContentDialog payload={viewerPayload} onClose={() => setViewerPayload(null)} />
    </div>
  );
}

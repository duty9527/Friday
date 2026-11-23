import type {
  ModelHubView,
  ModelProbeResult,
  ModelProviderView,
  UsageActor,
  UsageCurrency,
  UsageGranularity,
  UsagePreferences,
  UsageReportView,
} from '@friday/view.js';
import { errorText, formatNumber } from '@friday/web/shared/format.js';
import {
  CheckCircle2Icon,
  CoinsIcon,
  CpuIcon,
  MapPinIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchCheckIcon,
  Trash2Icon,
  XCircleIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmActionDialog } from '@/components/shared/ConfirmActionDialog';
import { BarSeriesChart, type BarDatum } from '@/components/shared/MetricCharts';
import { isSafeHttpUrl } from '@/components/shared/safeUrl';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@/components/ui/tabs';
import { useFriday } from '@/lib/friday-store';

interface SystemGeoStatusView {
  configured: boolean;
  source: 'system' | 'env' | 'none';
  maskedKey: string;
  updatedAt: number | null;
  cacheEntries: number;
}

interface AmapProbeResultView {
  ok: boolean;
  message: string;
  sampleAddress?: string;
}

const ACTOR_LABELS: Record<UsageActor, string> = {
  router: '主控 (Router)',
  worker: 'Worker 执行',
  decision: '决策引擎',
  distiller: '记忆提炼',
  dreamer: '潜意识做梦',
  probe: '模型探针',
  compaction: '上下文压缩',
};

function formatMoney(val: number, curr: UsageCurrency): string {
  const sym = curr === 'USD' ? '$' : '¥';
  if (!Number.isFinite(val) || val === 0) return `${sym}0.00`;
  if (Math.abs(val) >= 0.01) return `${sym}${val.toFixed(2)}`;
  if (Math.abs(val) >= 0.0001) return `${sym}${val.toFixed(4)}`;
  return `< ${sym}0.0001`;
}

function ModelsTabPanel() {
  const { view, ready, authExpired, api, refreshView } = useFriday();
  const hub = view?.modelHub;
  const providers = hub?.providers ?? [];

  const [selectedProvId, setSelectedProvId] = useState<string>('deepseek');
  const activeProv = useMemo(
    () => providers.find(p => p.id === selectedProvId) ?? providers[0],
    [providers, selectedProvId],
  );

  // Router state
  const [routerProv, setRouterProv] = useState<string>(hub?.routerProvider || 'deepseek');
  const [routerModel, setRouterModel] = useState<string>(hub?.routerModel || '');
  const [routerProbe, setRouterProbe] = useState<ModelProbeResult | null>(null);
  const [routerErr, setRouterErr] = useState<string>('');
  const [routerBusy, setRouterBusy] = useState(false);

  // Provider credential / pool drafts (preserved across refreshes via dirty flags)
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [baseUrlDraft, setBaseUrlDraft] = useState('');
  const [baseUrlDirty, setBaseUrlDirty] = useState(false);
  const [customModelsDraft, setCustomModelsDraft] = useState('');
  const [testModelId, setTestModelId] = useState('');
  const [selectedPoolIds, setSelectedPoolIds] = useState<Set<string>>(() => new Set());
  const [poolDirty, setPoolDirty] = useState(false);

  const [provBusy, setProvBusy] = useState(false);
  const [provStatus, setProvStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [provProbe, setProvProbe] = useState<ModelProbeResult | null>(null);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  // Custom provider drawer
  const [showCustomProv, setShowCustomProv] = useState(false);
  const [newProvId, setNewProvId] = useState('');
  const [newProvName, setNewProvName] = useState('');
  const [newProvUrl, setNewProvUrl] = useState('');
  const [newProvKey, setNewProvKey] = useState('');
  const [newProvModels, setNewProvModels] = useState('');
  const [newProvErr, setNewProvErr] = useState('');

  useEffect(() => {
    if (!hub) return;
    setRouterProv(hub.routerProvider);
    setRouterModel(hub.routerModel);
  }, [hub?.routerProvider, hub?.routerModel]);

  useEffect(() => {
    if (!activeProv) return;
    if (!baseUrlDirty) setBaseUrlDraft(activeProv.baseUrl ?? '');
    if (!poolDirty) setSelectedPoolIds(new Set((activeProv.selectedModels ?? []).map(m => m.id)));
    const fallbackTest = activeProv.defaultBalanced ?? activeProv.models[0]?.id ?? '';
    setTestModelId(prev => (prev && activeProv.models.some(m => m.id === prev) ? prev : fallbackTest));
  }, [activeProv, baseUrlDirty, poolDirty]);

  const switchProvider = (id: string) => {
    setSelectedProvId(id);
    setApiKeyDraft('');
    setCustomModelsDraft('');
    setBaseUrlDirty(false);
    setPoolDirty(false);
    setProvStatus(null);
    setProvProbe(null);
  };

  const disabled = !ready || authExpired;
  const routerProvObj = providers.find(p => p.id === routerProv);

  const saveRouter = async () => {
    if (!routerModel) return;
    setRouterBusy(true);
    setRouterErr('');
    try {
      await api<ModelHubView>('/api/model-configure', {
        routerProvider: routerProv,
        routerModel: `${routerProv}/${routerModel}`,
      });
      await refreshView();
      setRouterErr('');
    } catch (e) {
      setRouterErr(errorText(e));
    } finally {
      setRouterBusy(false);
    }
  };

  const probeRouter = async () => {
    if (!routerModel) return;
    setRouterBusy(true);
    setRouterErr('');
    try {
      const res = await api<ModelProbeResult>('/api/model-probe', {
        provider: routerProv,
        model: routerModel,
      });
      setRouterProbe(res);
    } catch (e) {
      setRouterErr(errorText(e));
    } finally {
      setRouterBusy(false);
    }
  };

  const toggleProvEnabled = async (prov: ModelProviderView, enabled: boolean) => {
    setProvBusy(true);
    setProvStatus(null);
    try {
      await api<ModelHubView>('/api/model-configure', { providerId: prov.id, enabled });
      await refreshView();
      setProvStatus({ ok: true, text: enabled ? `已启用「${prov.name}」` : `已禁用「${prov.name}」` });
    } catch (e) {
      setProvStatus({ ok: false, text: errorText(e) });
    } finally {
      setProvBusy(false);
    }
  };

  const fetchProvModels = async () => {
    if (!activeProv) return;
    const baseUrl = baseUrlDraft.trim();
    if (baseUrl && !isSafeHttpUrl(baseUrl)) {
      setProvStatus({ ok: false, text: 'Base URL 须以 http:// 或 https:// 开头' });
      return;
    }
    setProvBusy(true);
    setProvStatus(null);
    try {
      const updated = await api<ModelHubView>('/api/model-fetch', {
        providerId: activeProv.id,
        ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft.trim() } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      });
      await refreshView();
      const nextProv = updated.providers.find(p => p.id === activeProv.id);
      setProvStatus({ ok: true, text: `已拉取 ${nextProv?.models.length ?? 0} 款模型` });
    } catch (e) {
      setProvStatus({ ok: false, text: `拉取失败：${errorText(e)}` });
    } finally {
      setProvBusy(false);
    }
  };

  const saveAndProbeProv = async (saveFirst: boolean) => {
    if (!activeProv) return;
    const baseUrl = baseUrlDraft.trim();
    if (baseUrl && !isSafeHttpUrl(baseUrl)) {
      setProvStatus({ ok: false, text: 'Base URL 须以 http:// 或 https:// 开头' });
      return;
    }
    const customModels = customModelsDraft.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
    setProvBusy(true);
    setProvStatus(null);
    setProvProbe(null);
    try {
      if (saveFirst) {
        await api<ModelHubView>('/api/model-configure', {
          providerId: activeProv.id,
          ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft.trim() } : {}),
          baseUrl,
          ...(customModels.length ? { customModels } : {}),
        });
        setApiKeyDraft('');
        setCustomModelsDraft('');
        setBaseUrlDirty(false);
        await refreshView();
      }
      if (testModelId) {
        const probe = await api<ModelProbeResult>('/api/model-probe', {
          provider: activeProv.id,
          model: testModelId,
          ...(apiKeyDraft.trim() ? { apiKey: apiKeyDraft.trim() } : {}),
          ...(baseUrl ? { baseUrl } : {}),
        });
        setProvProbe(probe);
      } else {
        setProvStatus({ ok: true, text: '已保存提供方配置' });
      }
    } catch (e) {
      setProvStatus({ ok: false, text: errorText(e) });
    } finally {
      setProvBusy(false);
    }
  };

  const savePoolSelection = async () => {
    if (!activeProv) return;
    setProvBusy(true);
    setProvStatus(null);
    try {
      const selectedModels = [...selectedPoolIds].map(id => ({ id }));
      await api<ModelHubView>('/api/model-configure', {
        providerId: activeProv.id,
        selectedModels,
      });
      setPoolDirty(false);
      await refreshView();
      setProvStatus({ ok: true, text: `已保存 Worker 模型池勾选（${selectedModels.length} 款）` });
    } catch (e) {
      setProvStatus({ ok: false, text: errorText(e) });
    } finally {
      setProvBusy(false);
    }
  };

  const clearProvKey = async () => {
    if (!activeProv) return;
    setProvBusy(true);
    try {
      await api<ModelHubView>('/api/model-configure', { providerId: activeProv.id, clearApiKey: true });
      setApiKeyDraft('');
      await refreshView();
      setProvStatus({ ok: true, text: `已清除「${activeProv.name}」的已存凭据` });
      setConfirmClearOpen(false);
    } catch (e) {
      setProvStatus({ ok: false, text: errorText(e) });
    } finally {
      setProvBusy(false);
    }
  };

  const addCustomProvider = async () => {
    const providerId = newProvId.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    const providerName = newProvName.trim() || providerId;
    const baseUrl = newProvUrl.trim();
    if (!providerId) {
      setNewProvErr('请填写提供方 ID（例如 groq）');
      return;
    }
    if (!isSafeHttpUrl(baseUrl)) {
      setNewProvErr('Base URL 须以 http:// 或 https:// 开头');
      return;
    }
    setNewProvErr('');
    setProvBusy(true);
    try {
      const customModels = newProvModels.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
      await api<ModelHubView>('/api/model-configure', {
        providerId,
        providerName,
        baseUrl,
        ...(newProvKey.trim() ? { apiKey: newProvKey.trim() } : {}),
        ...(customModels.length ? { customModels } : {}),
      });
      setNewProvId('');
      setNewProvName('');
      setNewProvUrl('');
      setNewProvKey('');
      setNewProvModels('');
      setShowCustomProv(false);
      switchProvider(providerId);
      await refreshView();
      setProvStatus({ ok: true, text: `已添加提供方「${providerName}」` });
    } catch (e) {
      setNewProvErr(errorText(e));
    } finally {
      setProvBusy(false);
    }
  };

  if (!hub) {
    return <p className="py-6 text-xs text-muted-foreground">正在加载模型中心数据…</p>;
  }

  return (
    <div className="space-y-4">
      {/* Router Model Selector */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <CpuIcon className="size-4" />
            <span>主控 Router 模型调度</span>
            <Badge size="sm" variant={hub.mode === 'real' ? 'success' : 'secondary'}>
              {hub.mode === 'real' ? 'REAL 模式' : 'OFFLINE 演示'}
            </Badge>
          </CardTitle>
          <CardDescription className="text-xs">
            当前：{hub.routerProvider}/{hub.routerModel} · Worker 调度池就绪 {hub.modelPool?.length ?? 0} 款模型
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">主控提供方</Label>
              <select
                value={routerProv}
                disabled={disabled || routerBusy}
                onChange={e => {
                  const nextProv = e.target.value;
                  setRouterProv(nextProv);
                  const provObj = providers.find(p => p.id === nextProv);
                  setRouterModel(provObj?.defaultBalanced ?? provObj?.models[0]?.id ?? '');
                }}
                className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {providers.map(p => (
                  <option key={p.id} value={p.id} disabled={p.enabled === false}>
                    {p.name}{p.enabled === false ? ' (已禁用)' : p.configured ? ' ✓' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">主控模型 ID</Label>
              <select
                value={routerModel}
                disabled={disabled || routerBusy}
                onChange={e => setRouterModel(e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {(routerProvObj?.models ?? []).map(m => (
                  <option key={m.id} value={m.id}>
                    {m.id} · {Math.round(m.contextWindow / 1000)}K
                  </option>
                ))}
                {routerModel && !(routerProvObj?.models ?? []).some(m => m.id === routerModel) && (
                  <option value={routerModel}>{routerModel}</option>
                )}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs" variant="default" disabled={disabled || routerBusy} onClick={() => void saveRouter()}>
              设为主控模型
            </Button>
            <Button size="xs" variant="outline" disabled={disabled || routerBusy} onClick={() => void probeRouter()}>
              <SearchCheckIcon className="size-3.5" />
              <span>实测主控连通性</span>
            </Button>
          </div>

          {routerErr && <p className="text-xs text-destructive-foreground">{routerErr}</p>}
          {routerProbe && (
            <div className="rounded-lg border bg-muted/30 p-2.5 text-xs space-y-1">
              <div className="flex items-center gap-2 font-medium">
                {routerProbe.ok ? <CheckCircle2Icon className="size-3.5 text-success-foreground" /> : <XCircleIcon className="size-3.5 text-destructive-foreground" />}
                <span>{routerProbe.provider}/{routerProbe.model} · {routerProbe.latencyMs}ms</span>
              </div>
              <p className="text-muted-foreground">{routerProbe.ok ? routerProbe.reply : routerProbe.error}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Provider Tabs + Credentials + Pool Selection */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">提供方凭据与 Worker 模型池</CardTitle>
              <CardDescription className="text-xs">勾选模型纳入 Worker 异构调度池</CardDescription>
            </div>
            <Button size="xs" variant="outline" onClick={() => setShowCustomProv(v => !v)}>
              <PlusIcon className="size-3.5" />
              <span>自定义网关</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {showCustomProv && (
            <div className="rounded-lg border bg-muted/25 p-3 space-y-2.5">
              <div className="text-xs font-semibold">新增 OpenAI 兼容提供方</div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Input size="sm" placeholder="ID (如 groq)" value={newProvId} onChange={e => setNewProvId(e.target.value)} />
                <Input size="sm" placeholder="显示名称" value={newProvName} onChange={e => setNewProvName(e.target.value)} />
                <Input size="sm" placeholder="Base URL (https://...)" value={newProvUrl} onChange={e => setNewProvUrl(e.target.value)} />
                <Input size="sm" type="password" placeholder="API Key (可选)" value={newProvKey} onChange={e => setNewProvKey(e.target.value)} />
              </div>
              <Input size="sm" placeholder="初始模型列表（逗号分隔）" value={newProvModels} onChange={e => setNewProvModels(e.target.value)} />
              {newProvErr && <p className="text-xs text-destructive-foreground">{newProvErr}</p>}
              <div className="flex justify-end gap-2">
                <Button size="xs" variant="ghost" onClick={() => setShowCustomProv(false)}>取消</Button>
                <Button size="xs" disabled={disabled || provBusy} onClick={() => void addCustomProvider()}>添加提供方</Button>
              </div>
            </div>
          )}

          {/* Provider selector pills */}
          <div className="flex flex-wrap gap-1">
            {providers.map(p => (
              <Button
                key={p.id}
                size="xs"
                variant={activeProv?.id === p.id ? 'default' : 'outline'}
                onClick={() => switchProvider(p.id)}
              >
                <span>{p.name}</span>
                <Badge size="sm" variant={p.enabled === false ? 'secondary' : p.configured ? 'success' : 'outline'}>
                  {p.models.length}
                </Badge>
              </Button>
            ))}
          </div>

          {activeProv && (
            <div className="space-y-3 rounded-lg border bg-background p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-sm">{activeProv.name}</span>
                  <Badge size="sm" variant={activeProv.configured ? 'success' : 'secondary'}>
                    {activeProv.authType === 'api_key' ? `Key (${activeProv.keyHint ?? '已存'})` : activeProv.authType}
                  </Badge>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{activeProv.enabled === false ? '已禁用' : '已启用'}</span>
                  <Switch
                    checked={activeProv.enabled !== false}
                    disabled={disabled || provBusy}
                    onCheckedChange={checked => void toggleProvEnabled(activeProv, checked)}
                  />
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">API Key（留空保持现有）</Label>
                  <Input
                    size="sm"
                    type="password"
                    disabled={disabled}
                    placeholder={activeProv.configured ? `已配置 ${activeProv.keyHint ?? ''}` : '输入 API Key'}
                    value={apiKeyDraft}
                    onChange={e => setApiKeyDraft(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Base URL</Label>
                  <Input
                    size="sm"
                    disabled={disabled}
                    placeholder="https://api.example.com/v1"
                    value={baseUrlDraft}
                    onChange={e => {
                      setBaseUrlDirty(true);
                      setBaseUrlDraft(e.target.value);
                    }}
                  />
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">追加自定义模型 ID（逗号分隔）</Label>
                  <Input
                    size="sm"
                    disabled={disabled}
                    placeholder="例如 model-a, model-b"
                    value={customModelsDraft}
                    onChange={e => setCustomModelsDraft(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">探针测试模型</Label>
                  <select
                    value={testModelId}
                    disabled={disabled}
                    onChange={e => setTestModelId(e.target.value)}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
                  >
                    {activeProv.models.map(m => (
                      <option key={m.id} value={m.id}>{m.id}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="xs" variant="default" disabled={disabled || provBusy} onClick={() => void saveAndProbeProv(true)}>
                  保存并测试
                </Button>
                <Button size="xs" variant="outline" disabled={disabled || provBusy || activeProv.enabled === false} onClick={() => void saveAndProbeProv(false)}>
                  仅测试连通性
                </Button>
                <Button size="xs" variant="outline" disabled={disabled || provBusy || activeProv.enabled === false} onClick={() => void fetchProvModels()}>
                  <RefreshCwIcon className="size-3" />
                  <span>拉取远端模型</span>
                </Button>
                <Button size="xs" variant="destructive-outline" disabled={disabled || provBusy} onClick={() => setConfirmClearOpen(true)}>
                  <Trash2Icon className="size-3" />
                  <span>清除凭据</span>
                </Button>
              </div>

              {provStatus && (
                <p className={`text-xs ${provStatus.ok ? 'text-success-foreground' : 'text-destructive-foreground'}`}>
                  {provStatus.text}
                </p>
              )}
              {provProbe && (
                <div className="rounded border bg-muted/30 p-2 text-xs">
                  <strong>{provProbe.ok ? '✅ 连通正常' : '❌ 失败'}</strong> · {provProbe.latencyMs}ms · {provProbe.ok ? provProbe.reply : provProbe.error}
                </div>
              )}

              {/* Worker Model Pool Checkboxes */}
              <div className="border-t pt-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Worker 模型池勾选（已选 {selectedPoolIds.size} 款）</span>
                  <Button size="xs" variant="secondary" disabled={disabled || provBusy || activeProv.models.length === 0} onClick={() => void savePoolSelection()}>
                    保存模型池勾选
                  </Button>
                </div>
                {activeProv.models.length === 0 ? (
                  <p className="text-xs text-muted-foreground">暂无可用模型，请先配置并拉取模型。</p>
                ) : (
                  <div className="grid max-h-48 gap-1.5 overflow-y-auto sm:grid-cols-2">
                    {activeProv.models.map(m => {
                      const checked = selectedPoolIds.has(m.id);
                      return (
                        <label key={m.id} className="flex cursor-pointer items-center justify-between gap-2 rounded border px-2 py-1.5 text-xs hover:bg-accent/50">
                          <span className="flex min-w-0 items-center gap-2">
                            <Checkbox
                              checked={checked}
                              disabled={disabled}
                              onCheckedChange={next => {
                                setPoolDirty(true);
                                setSelectedPoolIds(prev => {
                                  const copy = new Set(prev);
                                  if (next) copy.add(m.id);
                                  else copy.delete(m.id);
                                  return copy;
                                });
                              }}
                            />
                            <span className="truncate font-mono">{m.id}</span>
                          </span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {m.thinkingLevels?.length ? m.thinkingLevels.join('/') : 'off'}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmActionDialog
        open={confirmClearOpen}
        onOpenChange={setConfirmClearOpen}
        title="清除提供方凭据"
        description={`确定要清除「${activeProv?.name ?? ''}」已保存的 API Key 吗？清除后该提供方将无法继续调用。`}
        confirmLabel="确认清除"
        busy={provBusy}
        onConfirm={clearProvKey}
      />
    </div>
  );
}

function UsageTabPanel() {
  const { view, ready, authExpired, api, refreshView } = useFriday();
  const [granularity, setGranularity] = useState<UsageGranularity>('day');
  const [anchorDate, setAnchorDate] = useState<string>('');
  const [report, setReport] = useState<UsageReportView | null>(null);
  const [rateDraft, setRateDraft] = useState<string>('7.25');
  const [rateDirty, setRateDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const seqRef = useRef(0);

  const loadUsage = useCallback(async (g: UsageGranularity, anchor?: string) => {
    if (!ready || authExpired) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setErrorMsg('');
    try {
      const params = new URLSearchParams({
        granularity: g,
        tzOffsetMin: String(new Date().getTimezoneOffset()),
      });
      if (anchor) params.set('anchorDate', anchor);
      const data = await api<UsageReportView>(`/api/usage?${params}`);
      if (seq !== seqRef.current) return;
      setReport(data);
      setAnchorDate(data.anchorDate);
      if (!rateDirty) setRateDraft(String(data.prefs.usdToCnyRate));
    } catch (e) {
      if (seq !== seqRef.current) return;
      setErrorMsg(errorText(e));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [api, authExpired, rateDirty, ready]);

  useEffect(() => {
    void loadUsage(granularity, anchorDate || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [granularity, ready, authExpired]);

  const currency: UsageCurrency = report?.prefs.currency ?? view?.usageToday?.currency ?? 'CNY';

  const savePrefs = async (patch: { currency?: UsageCurrency; usdToCnyRate?: number }) => {
    setLoading(true);
    setErrorMsg('');
    try {
      const updated = await api<UsagePreferences>('/api/usage-prefs', patch);
      setRateDraft(String(updated.usdToCnyRate));
      setRateDirty(false);
      await loadUsage(granularity, anchorDate || undefined);
      await refreshView();
    } catch (e) {
      setErrorMsg(errorText(e));
      setLoading(false);
    }
  };

  const chartBars: BarDatum[] = useMemo(() => {
    if (!report?.buckets.length) return [];
    const hasCost = report.buckets.some(b => b.costUsd > 0);
    const hasTokens = report.buckets.some(b => b.totalTokens > 0);
    return report.buckets.map(b => {
      const v = hasCost ? (currency === 'USD' ? b.costUsd : b.costCny) : hasTokens ? b.totalTokens : b.calls;
      return {
        key: b.key,
        label: b.label,
        value: v,
        hint: `${b.calls}次 · ${formatNumber(b.totalTokens)} tok · ${formatMoney(currency === 'USD' ? b.costUsd : b.costCny, currency)}`,
      };
    });
  }, [currency, report]);

  const disabled = !ready || authExpired || loading;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {(['day', 'week', 'month'] as const).map(g => (
            <Button
              key={g}
              size="xs"
              variant={granularity === g ? 'default' : 'outline'}
              disabled={disabled}
              onClick={() => setGranularity(g)}
            >
              {g === 'day' ? '日' : g === 'week' ? '周' : '月'}
            </Button>
          ))}
          {report && (
            <>
              <Button size="xs" variant="ghost" disabled={disabled} onClick={() => void loadUsage(granularity, report.prevAnchorDate)}>
                ← 上期
              </Button>
              <Button size="xs" variant="ghost" disabled={disabled || report.anchorDate === report.todayDate} onClick={() => void loadUsage(granularity, report.todayDate)}>
                今天
              </Button>
              <Button size="xs" variant="ghost" disabled={disabled} onClick={() => void loadUsage(granularity, report.nextAnchorDate)}>
                下期 →
              </Button>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Button size="xs" variant={currency === 'CNY' ? 'secondary' : 'outline'} disabled={disabled} onClick={() => void savePrefs({ currency: 'CNY' })}>
            ¥ CNY
          </Button>
          <Button size="xs" variant={currency === 'USD' ? 'secondary' : 'outline'} disabled={disabled} onClick={() => void savePrefs({ currency: 'USD' })}>
            $ USD
          </Button>
          <Input
            size="sm"
            className="w-20 font-mono"
            value={rateDraft}
            disabled={disabled}
            aria-label="美元汇率"
            onChange={e => {
              setRateDirty(true);
              setRateDraft(e.target.value);
            }}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => {
              const rate = Number(rateDraft);
              if (!Number.isFinite(rate) || rate < 0.1 || rate > 100) {
                setErrorMsg('汇率须为 0.1 ~ 100 之间的数字');
                return;
              }
              void savePrefs({ usdToCnyRate: rate });
            }}
          >
            更新汇率
          </Button>
          <Button size="xs" variant="ghost" disabled={disabled} onClick={() => void loadUsage(granularity, anchorDate || undefined)}>
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {errorMsg && (
        <Alert variant="error">
          <AlertDescription className="text-xs">{errorMsg}</AlertDescription>
        </Alert>
      )}

      {report && (
        <>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>统计周期：{report.periodLabel}</span>
            <span>汇率 1 USD = {report.prefs.usdToCnyRate} CNY</span>
          </div>

          <div className="grid gap-2 sm:grid-cols-4">
            <Card className="p-3">
              <div className="text-[11px] text-muted-foreground">总调用</div>
              <div className="mt-1 font-mono text-lg font-semibold">{formatNumber(report.totals.calls)}</div>
              <div className="text-[11px] text-muted-foreground">成功 {report.totals.successCalls} / 失败 {report.totals.failedCalls}</div>
            </Card>
            <Card className="p-3">
              <div className="text-[11px] text-muted-foreground">总 Token</div>
              <div className="mt-1 font-mono text-lg font-semibold">{formatNumber(report.totals.totalTokens)}</div>
              <div className="text-[11px] text-muted-foreground">输入 {formatNumber(report.totals.inputTokens)} · 输出 {formatNumber(report.totals.outputTokens)}</div>
            </Card>
            <Card className="p-3">
              <div className="text-[11px] text-muted-foreground">缓存命中率</div>
              <div className="mt-1 font-mono text-lg font-semibold">{(report.totals.cacheHitRate * 100).toFixed(1)}%</div>
              <div className="text-[11px] text-muted-foreground">节省 {formatMoney(currency === 'USD' ? report.totals.cacheSavingsUsd : report.totals.cacheSavingsCny, currency)}</div>
            </Card>
            <Card className="p-3">
              <div className="text-[11px] text-muted-foreground flex items-center gap-1"><CoinsIcon className="size-3" /> 估算费用</div>
              <div className="mt-1 font-mono text-lg font-semibold">{formatMoney(currency === 'USD' ? report.totals.costUsd : report.totals.costCny, currency)}</div>
              <div className="text-[11px] text-muted-foreground">另计 {currency === 'USD' ? formatMoney(report.totals.costCny, 'CNY') : formatMoney(report.totals.costUsd, 'USD')}</div>
            </Card>
          </div>

          <BarSeriesChart items={chartBars} />

          {/* Model Breakdown Table */}
          {report.byModel.length > 0 && (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">模型</TableHead>
                    <TableHead className="text-xs text-end">调用</TableHead>
                    <TableHead className="text-xs text-end">Token</TableHead>
                    <TableHead className="text-xs text-end">命中率</TableHead>
                    <TableHead className="text-xs text-end">费用</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.byModel.map(m => (
                    <TableRow key={m.spec}>
                      <TableCell className="font-mono text-xs">{m.spec}</TableCell>
                      <TableCell className="text-end font-mono text-xs">{m.calls}</TableCell>
                      <TableCell className="text-end font-mono text-xs">{formatNumber(m.totalTokens)}</TableCell>
                      <TableCell className="text-end font-mono text-xs">{(m.cacheHitRate * 100).toFixed(1)}%</TableCell>
                      <TableCell className="text-end font-mono text-xs">{formatMoney(currency === 'USD' ? m.costUsd : m.costCny, currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {/* Actor Breakdown */}
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(report.byActor).map(([actor, totals]) => (
              totals && totals.calls > 0 ? (
                <Badge key={actor} size="sm" variant="outline">
                  {ACTOR_LABELS[actor as UsageActor] ?? actor}: {totals.calls}次 · {formatMoney(currency === 'USD' ? totals.costUsd : totals.costCny, currency)}
                </Badge>
              ) : null
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ServicesTabPanel() {
  const { ready, authExpired, api } = useFriday();
  const [status, setStatus] = useState<SystemGeoStatusView | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [probe, setProbe] = useState<AmapProbeResultView | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const seqRef = useRef(0);

  const loadGeo = useCallback(async () => {
    if (!ready || authExpired) return;
    const seq = ++seqRef.current;
    try {
      const res = await api<SystemGeoStatusView>('/api/geo-config');
      if (seq === seqRef.current) setStatus(res);
    } catch (e) {
      if (seq === seqRef.current) setProbe({ ok: false, message: errorText(e) });
    }
  }, [api, authExpired, ready]);

  useEffect(() => {
    void loadGeo();
  }, [loadGeo]);

  const disabled = !ready || authExpired || busy;

  const handleProbe = async () => {
    setBusy(true);
    try {
      const res = await api<AmapProbeResultView>('/api/geo-probe', keyDraft.trim() ? { amapKey: keyDraft.trim() } : {});
      setProbe(res);
    } catch (e) {
      setProbe({ ok: false, message: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    const raw = keyDraft.trim();
    if (!raw) {
      if (status?.configured) {
        await handleProbe();
        return;
      }
      setProbe({ ok: false, message: '请先输入高德「Web服务」API Key 后再保存。' });
      return;
    }
    setBusy(true);
    let savedOk = false;
    try {
      const saved = await api<SystemGeoStatusView>('/api/geo-config', { amapKey: raw });
      seqRef.current += 1;
      savedOk = true;
      setKeyDraft('');
      setStatus(saved);
      const probeRes = await api<AmapProbeResultView>('/api/geo-probe', {});
      setProbe(probeRes);
    } catch (e) {
      setProbe({ ok: false, message: `${savedOk ? 'Key 已保存，但连通性测试失败' : '保存失败'}：${errorText(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    try {
      const saved = await api<SystemGeoStatusView>('/api/geo-config', { clearAmapKey: true });
      seqRef.current += 1;
      setKeyDraft('');
      setStatus(saved);
      setProbe({ ok: true, message: '已清除系统底座保存的高德 API Key。' });
      setConfirmClearOpen(false);
    } catch (e) {
      setProbe({ ok: false, message: `清除失败：${errorText(e)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <MapPinIcon className="size-4" />
              <span>位置与地图底座（高德 Web 服务）</span>
            </CardTitle>
            <Badge size="sm" variant={status?.configured ? 'success' : 'secondary'}>
              {status?.configured ? `已配置 (${status.source})` : '未配置'}
            </Badge>
          </div>
          <CardDescription className="text-xs">
            为苹果设备定位、九号电动车轨迹等提供统一逆地理编码服务（共享 22m 网格缓存）。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {status && (
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <Badge size="sm" variant="outline" className="font-mono">掩码：{status.maskedKey || '无'}</Badge>
              <Badge size="sm" variant="outline" className="font-mono">网格缓存：{status.cacheEntries} 条</Badge>
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="geo-amap-key-input" className="text-xs">高德 Web 服务 API Key</Label>
            <Input
              id="geo-amap-key-input"
              type="password"
              size="sm"
              disabled={disabled}
              placeholder={status?.configured ? `当前 ${status.maskedKey}（留空可直接点测试）` : '请输入高德 Web 服务 Key'}
              value={keyDraft}
              onChange={e => setKeyDraft(e.target.value)}
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            <Button size="xs" variant="default" disabled={disabled} onClick={() => void handleSave()}>
              保存并测试
            </Button>
            <Button size="xs" variant="outline" disabled={disabled} onClick={() => void handleProbe()}>
              仅测试连通性
            </Button>
            <Button size="xs" variant="outline" disabled={disabled} onClick={() => void loadGeo()}>
              <RefreshCwIcon className="size-3" />
              <span>刷新状态</span>
            </Button>
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={disabled || !status?.configured || status.source === 'env'}
              onClick={() => setConfirmClearOpen(true)}
            >
              清除 Key
            </Button>
          </div>

          {probe && (
            <Alert variant={probe.ok ? 'success' : 'error'}>
              <AlertDescription className="text-xs space-y-1">
                <div>{probe.ok ? '✅' : '❌'} {probe.message}</div>
                {probe.sampleAddress && <div className="text-muted-foreground">示例逆地理：{probe.sampleAddress}</div>}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <ConfirmActionDialog
        open={confirmClearOpen}
        onOpenChange={setConfirmClearOpen}
        title="清除高德 API Key"
        description="确定要清除系统底座中保存的高德 Web 服务 API Key 吗？"
        confirmLabel="确认清除"
        busy={busy}
        onConfirm={handleClear}
      />
    </div>
  );
}

export function SystemHub() {
  const { systemTab, setSystemTab } = useFriday();

  return (
    <Tabs value={systemTab} onValueChange={v => setSystemTab(v as 'models' | 'usage' | 'services')}>
      <TabsList activateOnFocus>
        <TabsTab id="system-tab-models" value="models">模型与提供方</TabsTab>
        <TabsTab id="system-tab-usage" value="usage">用量账本</TabsTab>
        <TabsTab id="system-tab-services" value="services">位置与地图底座</TabsTab>
      </TabsList>

      <TabsPanel id="system-panel-models" value="models" keepMounted className="mt-3">
        <ModelsTabPanel />
      </TabsPanel>
      <TabsPanel id="system-panel-usage" value="usage" keepMounted className="mt-3">
        <UsageTabPanel />
      </TabsPanel>
      <TabsPanel id="system-panel-services" value="services" keepMounted className="mt-3">
        <ServicesTabPanel />
      </TabsPanel>
    </Tabs>
  );
}

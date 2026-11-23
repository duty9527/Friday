import { errorText, timestamp } from '@friday/web/shared/format.js';
import {
  EyeIcon,
  EyeOffIcon,
  MoonIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TrendingUpIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmActionDialog } from '@/components/shared/ConfirmActionDialog';
import { TrendLineChart, type TrendPoint } from '@/components/shared/MetricCharts';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useFriday } from '@/lib/friday-store';

interface FundHoldingRow {
  code: string;
  name: string;
  fundType?: string;
  proxySymbol?: string;
  proxyName?: string;
  positionRatio?: number;
  initNav?: number;
  initNavDate?: string;
  isAStock: boolean;
  shares: number;
  cost: number;
  baseNav: number;
  baseNavDate: string;
  currentNav: number;
  changePct: number;
  currentAsset: number;
  dailyPnl: number;
  totalPnl: number;
  totalPnlPct: number;
  navSource: string;
  hasTodayOfficialNav: boolean;
  usMarketClosed?: boolean;
  quoteMissing?: boolean;
  quoteStale?: boolean;
}

interface FundGroupSummary {
  count: number;
  cost: number;
  asset: number;
  dailyPnl: number;
  dailyPnlPct: number;
  totalPnl: number;
  totalPnlPct: number;
}

interface FundHoldingConfig {
  code: string;
  name: string;
  fundType: string;
  proxySymbol: string;
  proxyName: string;
  positionRatio: number;
  initAmount: number;
  initNav: number;
  initNavDate: string;
  shares: number;
}

interface FundSnapshotPoint {
  date: string;
  kind: string;
  totalAsset: number;
  totalPnl: number;
  dailyPnl: number;
}

interface FundNavPoint {
  navDate: string;
  nav: number;
  dailyReturn: number;
}

interface FundDashboardData {
  updatedAt: number;
  today: string;
  holdings: FundHoldingConfig[];
  summary: {
    totalCost: number;
    totalAsset: number;
    totalDailyPnl: number;
    dailyPnlPct: number;
    totalPnl: number;
    totalPnlPct: number;
    stocks: FundGroupSummary;
    funds: FundGroupSummary;
    holdings: FundHoldingRow[];
  };
  snapshots: FundSnapshotPoint[];
  navHistory: Record<string, FundNavPoint[]>;
}

interface FundPluginResponse<T = unknown> {
  ok: boolean;
  message: string;
  data?: T;
}

const PRIVACY_KEY = 'friday.fund.privacy';

const FUND_TYPES = [
  { value: 'a_index', label: 'A股指数基金 (a_index)' },
  { value: 'a_etf_feeder', label: 'A股ETF联接 (a_etf_feeder)' },
  { value: 'hk_etf_feeder', label: '港股ETF联接 QDII (hk_etf_feeder)' },
  { value: 'us_qdii', label: '美股QDII基金 (us_qdii)' },
  { value: 'gold_feeder', label: '黄金ETF联接 (gold_feeder)' },
  { value: 'a_stock', label: 'A股股票 (a_stock)' },
  { value: 'other', label: '其他混合/主动基金 (other)' },
];

type TrendMetric = 'asset' | 'totalPnl' | 'dailyPnl' | 'holdingNav';

function readPrivacy(): boolean {
  try {
    return window.localStorage.getItem(PRIVACY_KEY) === '1';
  } catch {
    return false;
  }
}

function fmtMoney(n: number, privacy: boolean): string {
  if (privacy) return '¥****';
  return `¥${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtSignedMoney(n: number, privacy: boolean): string {
  if (privacy) return '****';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n > 0 ? `+¥${abs}` : n < 0 ? `-¥${abs}` : '¥0.00';
}

function fmtSignedPct(n: number): string {
  const abs = Math.abs(n).toFixed(2);
  return n > 0 ? `+${abs}%` : n < 0 ? `-${abs}%` : '0.00%';
}

function pnlToneClass(n: number): string {
  return n > 0 ? 'text-destructive' : n < 0 ? 'text-success' : 'text-foreground';
}

function rowBadge(row: FundHoldingRow): { text: string; variant: 'success' | 'info' | 'warning' | 'secondary' } {
  if (row.quoteMissing) return { text: '行情缺失', variant: 'warning' };
  if (row.usMarketClosed) return { text: '美股休市', variant: 'secondary' };
  if (row.navSource.includes('休市/盘前')) return { text: '盘前/休市', variant: 'secondary' };
  if (row.quoteStale) return { text: '数据过期', variant: 'warning' };
  if (row.hasTodayOfficialNav) return { text: row.isAStock ? '收盘结算' : '正式净值', variant: 'success' };
  if (row.navSource.includes('盘中估值') || row.navSource.includes('腾讯行情')) return { text: '实时估值', variant: 'info' };
  if (row.navSource.includes('待更新')) return { text: '预估待结', variant: 'info' };
  return { text: '最近净值', variant: 'secondary' };
}

export default function FundTrackerSurface() {
  const { authExpired, api } = useFriday();
  const [dashboard, setDashboard] = useState<FundDashboardData | null>(null);
  const [privacyMode, setPrivacyMode] = useState<boolean>(readPrivacy);
  const [dataMode, setDataMode] = useState<'cached' | 'live' | 'settle'>('cached');
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('asset');
  const [trendLimit, setTrendLimit] = useState<number>(30);
  const [selectedNavCode, setSelectedNavCode] = useState<string>('');
  const [typeFilter, setTypeFilter] = useState<'all' | 'stock' | 'fund'>('all');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);

  // Edit / Add form
  const [formOpen, setFormOpen] = useState(false);
  const [editOriginalCode, setEditOriginalCode] = useState('');
  const [formCode, setFormCode] = useState('');
  const [formName, setFormName] = useState('');
  const [formType, setFormType] = useState('a_index');
  const [formCost, setFormCost] = useState('');
  const [formShares, setFormShares] = useState('');
  const [formProxy, setFormProxy] = useState('');
  const [formProxyName, setFormProxyName] = useState('');
  const [formRatio, setFormRatio] = useState('');
  const [formInitNav, setFormInitNav] = useState('');
  const [formInitDate, setFormInitDate] = useState('');

  const [removeTarget, setRemoveTarget] = useState<FundHoldingRow | null>(null);

  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runFund = useCallback(
    async <T,>(action: string, args: Record<string, unknown> = {}) => {
      return api<FundPluginResponse<T>>('/api/plugin-run', {
        plugin: 'fund-tracker',
        action,
        args,
      });
    },
    [api],
  );

  const loadDashboard = useCallback(
    async (opts: { refresh: boolean; mode: 'status' | 'settle'; quiet?: boolean; nextDataMode?: 'cached' | 'live' | 'settle' }) => {
      if (authExpired) return;
      const seq = ++seqRef.current;
      if (!opts.quiet) {
        setStatus({
          text: opts.mode === 'settle' ? '正在拉取最新正式净值进行结算…' : opts.refresh ? '正在刷新实时估值与行情…' : '正在加载投资看板…',
          tone: 'warn',
        });
      }
      try {
        const res = await runFund<FundDashboardData>('dashboard', { refresh: opts.refresh, mode: opts.mode });
        if (!mountedRef.current || seq !== seqRef.current || authExpired) return;
        if (!res.ok || !res.data) {
          if (!opts.quiet) setStatus({ text: res.message || '加载投资看板失败', tone: 'err' });
          return;
        }
        setDashboard(res.data);
        setDataMode(opts.nextDataMode ?? (opts.refresh ? (opts.mode === 'settle' ? 'settle' : 'live') : 'cached'));
        if (!opts.quiet) setStatus({ text: res.message || '数据已更新', tone: 'ok' });
      } catch (err) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        if (!opts.quiet) setStatus({ text: `加载投资看板失败：${errorText(err)}`, tone: 'err' });
      }
    },
    [authExpired, runFund],
  );

  useEffect(() => {
    void loadDashboard({ refresh: false, mode: 'status', quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep selectedNavCode valid
  useEffect(() => {
    const holdings = dashboard?.holdings ?? [];
    if (!holdings.length) return;
    if (!selectedNavCode || !holdings.some(h => h.code === selectedNavCode)) {
      const first = holdings.find(h => h.fundType !== 'a_stock') ?? holdings[0];
      if (first) setSelectedNavCode(first.code);
    }
  }, [dashboard?.holdings, selectedNavCode]);

  const togglePrivacy = () => {
    const next = !privacyMode;
    setPrivacyMode(next);
    try {
      window.localStorage.setItem(PRIVACY_KEY, next ? '1' : '0');
    } catch {
      // ignore storage errors
    }
  };

  const triggerRefresh = async (mode: 'status' | 'settle') => {
    if (busy || authExpired) return;
    setBusy(true);
    try {
      await loadDashboard({ refresh: true, mode, quiet: false, nextDataMode: mode === 'settle' ? 'settle' : 'live' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const resetForm = (openState = false) => {
    setEditOriginalCode('');
    setFormCode('');
    setFormName('');
    setFormType('a_index');
    setFormCost('');
    setFormShares('');
    setFormProxy('');
    setFormProxyName('');
    setFormRatio('');
    setFormInitNav('');
    setFormInitDate('');
    setFormOpen(openState);
  };

  const beginEdit = (row: FundHoldingRow) => {
    const cfg = dashboard?.holdings.find(h => h.code === row.code);
    setEditOriginalCode(row.code);
    setFormCode(row.code);
    setFormName(row.name);
    setFormType(cfg?.fundType ?? row.fundType ?? (row.isAStock ? 'a_stock' : 'other'));
    setFormCost(String(row.cost));
    setFormShares(String(row.shares));
    setFormProxy(cfg?.proxySymbol ?? row.proxySymbol ?? '');
    setFormProxyName(cfg?.proxyName ?? row.proxyName ?? '');
    setFormRatio(cfg?.positionRatio ? String(cfg.positionRatio) : '');
    setFormInitNav(cfg?.initNav ? String(cfg.initNav) : '');
    setFormInitDate(cfg?.initNavDate ?? '');
    setFormOpen(true);
  };

  const saveHolding = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = formCode.trim();
    const name = formName.trim();
    const cost = Number(formCost.trim());
    if (!code || !name || !Number.isFinite(cost) || cost < 0) {
      setStatus({ text: '请填写有效的标的代码、名称和总成本。', tone: 'warn' });
      return;
    }
    let parsedShares: number | undefined;
    if (formShares.trim()) {
      const v = Number(formShares.trim());
      if (!Number.isFinite(v) || v <= 0) {
        setStatus({ text: '持有份额必须大于 0', tone: 'warn' });
        return;
      }
      parsedShares = v;
    }
    let parsedRatio: number | undefined;
    if (formRatio.trim()) {
      const v = Number(formRatio.trim());
      if (!Number.isFinite(v) || v <= 0 || v > 1) {
        setStatus({ text: '仓位映射系数应在 (0, 1] 之间', tone: 'warn' });
        return;
      }
      parsedRatio = v;
    }
    let parsedInitNav: number | undefined;
    if (formInitNav.trim()) {
      const v = Number(formInitNav.trim());
      if (!Number.isFinite(v) || v <= 0) {
        setStatus({ text: '建仓基准净值必须大于 0', tone: 'warn' });
        return;
      }
      parsedInitNav = v;
    }

    setBusy(true);
    try {
      const isEdit = Boolean(editOriginalCode && editOriginalCode === code);
      const prevCfg = dashboard?.holdings.find(h => h.code === code);
      const baseArgs: Record<string, unknown> = {
        code,
        name,
        fundType: formType || 'other',
        cost,
        proxySymbol: formProxy.trim(),
        proxyName: formProxyName.trim() || (formType === 'a_stock' ? name : formProxy.trim() || name),
      };
      if (parsedRatio !== undefined) baseArgs.positionRatio = parsedRatio;
      if (parsedShares !== undefined) baseArgs.shares = parsedShares;
      if (parsedInitNav !== undefined) baseArgs.initNav = parsedInitNav;
      if (isEdit) {
        if (formInitDate.trim() && formInitDate.trim() !== prevCfg?.initNavDate && parsedShares === undefined) {
          baseArgs.navDate = formInitDate.trim();
        }
      } else if (formInitDate.trim()) {
        baseArgs.initNavDate = formInitDate.trim();
      }
      const res = await runFund(isEdit ? 'set-holding' : 'add-holding', baseArgs);
      if (!mountedRef.current) return;
      if (!res.ok) {
        setStatus({ text: res.message || '保存持仓失败', tone: 'err' });
        return;
      }
      resetForm(false);
      setStatus({ text: res.message || `已保存 ${name} (${code})`, tone: 'ok' });
      await loadDashboard({ refresh: true, mode: 'status', quiet: true, nextDataMode: 'live' });
    } catch (err) {
      setStatus({ text: `保存持仓失败：${errorText(err)}`, tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const confirmRemove = async () => {
    if (!removeTarget) return;
    setBusy(true);
    ++seqRef.current;
    try {
      const res = await runFund('remove-holding', { code: removeTarget.code });
      if (!mountedRef.current) return;
      if (!res.ok) {
        setStatus({ text: res.message || '移除持仓失败', tone: 'err' });
        return;
      }
      if (editOriginalCode === removeTarget.code) resetForm(false);
      setStatus({ text: res.message || `已移除 ${removeTarget.code}`, tone: 'ok' });
      setRemoveTarget(null);
      await loadDashboard({ refresh: false, mode: 'status', quiet: true, nextDataMode: dataMode });
    } catch (err) {
      setStatus({ text: `移除持仓失败：${errorText(err)}`, tone: 'err' });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const trendPoints = useMemo<TrendPoint[]>(() => {
    if (!dashboard) return [];
    if (trendMetric === 'holdingNav') {
      return (dashboard.navHistory[selectedNavCode] ?? []).slice(-trendLimit).map(n => ({
        label: n.navDate.slice(5),
        value: n.nav,
      }));
    }
    return dashboard.snapshots.slice(-trendLimit).map(s => ({
      label: s.date.slice(5),
      value: trendMetric === 'asset' ? s.totalAsset : trendMetric === 'totalPnl' ? s.totalPnl : s.dailyPnl,
    }));
  }, [dashboard, selectedNavCode, trendLimit, trendMetric]);

  const filteredHoldings = useMemo(() => {
    const rows = dashboard?.summary.holdings ?? [];
    if (typeFilter === 'stock') return rows.filter(r => r.isAStock);
    if (typeFilter === 'fund') return rows.filter(r => !r.isAStock);
    return rows;
  }, [dashboard?.summary.holdings, typeFilter]);

  const summary = dashboard?.summary;
  const totalAsset = summary?.totalAsset ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <TrendingUpIcon className="size-4 text-primary" />
          <h3 className="text-sm font-semibold">投资管理 · 股票与基金持仓监控</h3>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" variant={privacyMode ? 'secondary' : 'outline'} onClick={togglePrivacy}>
            {privacyMode ? <EyeIcon className="size-3.5" /> : <EyeOffIcon className="size-3.5" />}
            <span>{privacyMode ? '显示金额' : '隐藏金额'}</span>
          </Button>
          <Button size="xs" variant="outline" disabled={busy || authExpired} onClick={() => void triggerRefresh('status')}>
            <RefreshCwIcon className="size-3.5" />
            <span>实时估值</span>
          </Button>
          <Button size="xs" disabled={busy || authExpired} onClick={() => void triggerRefresh('settle')}>
            <MoonIcon className="size-3.5" />
            <span>净值结算</span>
          </Button>
        </div>
      </div>

      {status && (
        <Alert variant={status.tone === 'err' ? 'error' : status.tone === 'warn' ? 'warning' : 'success'}>
          <AlertDescription className="text-xs">{status.text}</AlertDescription>
        </Alert>
      )}

      {/* Hero Summary */}
      {summary && (
        <div className="grid gap-3 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-1">
              <div className="flex items-center justify-between gap-2">
                <Badge variant={dataMode === 'settle' ? 'success' : dataMode === 'live' ? 'info' : 'secondary'}>
                  {dataMode === 'settle' ? '晚间结算' : dataMode === 'live' ? '实时估值' : '缓存快照'}
                </Badge>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {dashboard?.today} · {timestamp(dashboard?.updatedAt)}
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-1">
              <div className="font-mono text-2xl font-bold">{fmtMoney(summary.totalAsset, privacyMode)}</div>
              <div className={`font-mono text-xs font-medium ${pnlToneClass(summary.totalDailyPnl)}`}>
                当日盈亏：{fmtSignedMoney(summary.totalDailyPnl, privacyMode)} ({fmtSignedPct(summary.dailyPnlPct)})
              </div>
              <p className="font-mono text-[11px] text-muted-foreground">
                投入 {fmtMoney(summary.totalCost, privacyMode)} · 累计 {fmtSignedMoney(summary.totalPnl, privacyMode)} ({fmtSignedPct(summary.totalPnlPct)})
              </p>
            </CardContent>
          </Card>

          {[
            { title: '股票仓位', grp: summary.stocks, empty: '暂无股票持仓' },
            { title: '基金仓位', grp: summary.funds, empty: '暂无基金持仓' },
          ].map(({ title, grp, empty }) => {
            const pct = totalAsset > 0 ? Math.min(100, Math.max(0, (grp.asset / totalAsset) * 100)) : 0;
            return (
              <Card key={title}>
                <CardHeader className="pb-1">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm">{title}</CardTitle>
                    <Badge variant="outline">{pct.toFixed(1)}% 仓位</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-1.5 text-xs">
                  {grp.count === 0 ? (
                    <p className="text-muted-foreground">{empty}</p>
                  ) : (
                    <>
                      <div className="font-mono text-base font-semibold">
                        {fmtMoney(grp.asset, privacyMode)} <span className="text-xs font-normal text-muted-foreground">({grp.count} 只)</span>
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-muted-foreground">当日：</span>
                        <span className={pnlToneClass(grp.dailyPnl)}>{fmtSignedMoney(grp.dailyPnl, privacyMode)} ({fmtSignedPct(grp.dailyPnlPct)})</span>
                      </div>
                      <div className="flex justify-between font-mono">
                        <span className="text-muted-foreground">累计：</span>
                        <span className={pnlToneClass(grp.totalPnl)}>{fmtSignedMoney(grp.totalPnl, privacyMode)} ({fmtSignedPct(grp.totalPnlPct)})</span>
                      </div>
                      <svg viewBox="0 0 100 6" className="h-1.5 w-full" aria-hidden="true">
                        <rect x="0" y="0" width="100" height="6" rx="3" fill="var(--muted)" />
                        <rect x="0" y="0" width={pct.toFixed(1)} height="6" rx="3" fill="var(--primary)" />
                      </svg>
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Trend Chart */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm">收益与净值走势</CardTitle>
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { k: 'asset', label: '总资产' },
                  { k: 'totalPnl', label: '累计收益' },
                  { k: 'dailyPnl', label: '单日盈亏' },
                  { k: 'holdingNav', label: '标的净值' },
                ] as const
              ).map(m => (
                <Button key={m.k} size="xs" variant={trendMetric === m.k ? 'default' : 'outline'} onClick={() => setTrendMetric(m.k)}>
                  {m.label}
                </Button>
              ))}
              {trendMetric === 'holdingNav' && (dashboard?.holdings.length ?? 0) > 0 && (
                <select
                  aria-label="选择净值标的"
                  value={selectedNavCode}
                  onChange={e => setSelectedNavCode(e.target.value)}
                  className="h-7 rounded-md border border-input bg-background px-2 text-xs outline-none"
                >
                  {dashboard?.holdings.map(h => (
                    <option key={h.code} value={h.code}>{h.name} ({h.code})</option>
                  ))}
                </select>
              )}
              <div className="flex gap-1">
                {[7, 30, 120].map(lim => (
                  <Button key={lim} size="xs" variant={trendLimit === lim ? 'secondary' : 'ghost'} onClick={() => setTrendLimit(lim)}>
                    {lim === 120 ? '全部' : `近${lim}次`}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <TrendLineChart
            points={trendPoints}
            primaryLabel={
              trendMetric === 'holdingNav'
                ? '单位净值'
                : trendMetric === 'asset'
                  ? '总资产'
                  : trendMetric === 'totalPnl'
                    ? '累计收益'
                    : '单日盈亏'
            }
            unit={trendMetric === 'holdingNav' ? '' : ' 元'}
            emptyText="暂无足够历史快照数据"
          />
        </CardContent>
      </Card>

      {/* Holdings Table */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">持仓明细</CardTitle>
              <CardDescription className="text-xs">共 {filteredHoldings.length} 只标的</CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { k: 'all', label: '全部' },
                  { k: 'stock', label: '股票' },
                  { k: 'fund', label: '基金' },
                ] as const
              ).map(f => (
                <Button key={f.k} size="xs" variant={typeFilter === f.k ? 'default' : 'outline'} onClick={() => setTypeFilter(f.k)}>
                  {f.label}
                </Button>
              ))}
              <Button size="xs" variant="outline" onClick={() => resetForm(true)}>
                <PlusIcon className="size-3.5" />
                <span>新增持仓</span>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filteredHoldings.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">尚无持仓记录。</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">标的</TableHead>
                  <TableHead className="text-xs">状态</TableHead>
                  <TableHead className="text-xs">净值 / 涨跌</TableHead>
                  <TableHead className="text-xs">市值 / 成本</TableHead>
                  <TableHead className="text-xs">当日 / 累计盈亏</TableHead>
                  <TableHead className="text-right text-xs">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredHoldings.map(r => {
                  const sb = rowBadge(r);
                  return (
                    <TableRow key={r.code}>
                      <TableCell>
                        <div className="text-xs font-medium">{r.name}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{r.code} · {r.shares.toFixed(2)}份</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={sb.variant}>{sb.text}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <div>{r.currentNav.toFixed(4)}</div>
                        <div className={pnlToneClass(r.changePct)}>{fmtSignedPct(r.changePct)}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <div>{fmtMoney(r.currentAsset, privacyMode)}</div>
                        <div className="text-muted-foreground">{fmtMoney(r.cost, privacyMode)}</div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <div className={pnlToneClass(r.dailyPnl)}>{fmtSignedMoney(r.dailyPnl, privacyMode)}</div>
                        <div className={pnlToneClass(r.totalPnl)}>
                          {fmtSignedMoney(r.totalPnl, privacyMode)} ({fmtSignedPct(r.totalPnlPct)})
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex gap-1">
                          <Button size="xs" variant="ghost" onClick={() => beginEdit(r)} aria-label={`编辑 ${r.name}`}>
                            <PencilIcon className="size-3.5" />
                          </Button>
                          <Button size="xs" variant="ghost" onClick={() => setRemoveTarget(r)} aria-label={`删除 ${r.name}`}>
                            <Trash2Icon className="size-3.5 text-destructive" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Edit / Add Collapsible Form */}
      <Collapsible open={formOpen} onOpenChange={setFormOpen}>
        <Card>
          <CardHeader className="pb-2">
            <CollapsibleTrigger render={<button type="button" className="flex w-full items-center justify-between text-left" />}>
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <PlusIcon className="size-4" />
                <span>{editOriginalCode ? `编辑持仓 (${editOriginalCode})` : '新增或修改股票 / 基金持仓'}</span>
              </span>
              <span className="text-xs text-muted-foreground">{formOpen ? '收起' : '展开'}</span>
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsiblePanel>
            <CardContent>
              <form onSubmit={e => void saveHolding(e)} className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs">标的代码</Label>
                  <Input size="sm" value={formCode} onChange={e => setFormCode(e.target.value)} placeholder="如：000300 / 600519" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">标的名称</Label>
                  <Input size="sm" value={formName} onChange={e => setFormName(e.target.value)} placeholder="如：沪深300指数A" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">资产类别</Label>
                  <select
                    value={formType}
                    onChange={e => setFormType(e.target.value)}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
                  >
                    {FUND_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">总成本 (元)</Label>
                  <Input size="sm" type="number" step="0.01" value={formCost} onChange={e => setFormCost(e.target.value)} placeholder="10000" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">持有份额/股数（可空）</Label>
                  <Input size="sm" type="number" step="0.0001" value={formShares} onChange={e => setFormShares(e.target.value)} placeholder="留空按基准日反推" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">跟踪指数/行情代码</Label>
                  <Input size="sm" value={formProxy} onChange={e => setFormProxy(e.target.value)} placeholder="如：sh000300" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">跟踪标的名称</Label>
                  <Input size="sm" value={formProxyName} onChange={e => setFormProxyName(e.target.value)} placeholder="如：沪深300" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">仓位映射系数 (0~1]</Label>
                  <Input size="sm" type="number" step="0.01" value={formRatio} onChange={e => setFormRatio(e.target.value)} placeholder="0.95" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">建仓基准净值（可选）</Label>
                  <Input size="sm" type="number" step="0.0001" value={formInitNav} onChange={e => setFormInitNav(e.target.value)} placeholder="1.0" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">基准净值日期（可选）</Label>
                  <Input size="sm" type="date" value={formInitDate} onChange={e => setFormInitDate(e.target.value)} />
                </div>
                <div className="sm:col-span-2 flex justify-end gap-2 pt-1">
                  <Button type="button" size="sm" variant="outline" onClick={() => resetForm(false)}>重置</Button>
                  <Button type="submit" size="sm" disabled={busy || authExpired}>保存持仓</Button>
                </div>
              </form>
            </CardContent>
          </CollapsiblePanel>
        </Card>
      </Collapsible>

      <ConfirmActionDialog
        open={Boolean(removeTarget)}
        onOpenChange={open => { if (!open) setRemoveTarget(null); }}
        title="移除持仓"
        description={`确定移除持仓「${removeTarget?.name ?? ''} (${removeTarget?.code ?? ''})」吗？`}
        confirmLabel="确认移除"
        busy={busy}
        onConfirm={confirmRemove}
      />
    </div>
  );
}

import { button, element, isEditingWithin, kpiCard, node } from '../shared/dom.js';
import { errorText, timestamp } from '../shared/format.js';
import { announceStatus, attachDelayedFormValidation, prefersReducedMotion, safeFocus } from '../shared/ui-primitives.js';
import { api, appState, type ApiRequestOptions } from '../state.js';

export interface FundTrackerUiOptions {
  isVisible: () => boolean;
}

export interface FundTrackerUiController {
  activate: () => void;
  deactivate: () => void;
  refreshBadge: () => Promise<void>;
  dispose: () => void;
}

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
  costPrice?: number;
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
  quoteDate?: string;
  quoteStamp?: string;
  quoteMissing?: boolean;
  quoteStale?: boolean;
}

interface FundGroupSummary {
  count: number;
  cost: number;
  totalCost: number;
  asset: number;
  totalAsset: number;
  dailyPnl: number;
  totalDailyPnl: number;
  dailyPnlPct: number;
  totalPnl: number;
  totalPnlPct: number;
  holdings: FundHoldingRow[];
}

interface FundValuationSummary {
  totalCost: number;
  totalAsset: number;
  totalDailyPnl: number;
  dailyPnlPct: number;
  totalPnl: number;
  totalPnlPct: number;
  stocks: FundGroupSummary;
  funds: FundGroupSummary;
  holdings: FundHoldingRow[];
}

interface FundHoldingConfig {
  code: string;
  name: string;
  fundType: string;
  proxySymbol: string;
  proxyName: string;
  positionRatio: number;
  initAmount: number;
  cost: number;
  initNav: number;
  initNavDate: string;
  shares: number;
  lastNav: number;
  lastNavDate: string;
  updatedAt: number;
}

interface FundSnapshotPoint {
  id: number;
  kind: string;
  date: string;
  totalCost: number;
  totalAsset: number;
  dailyPnl: number;
  totalPnl: number;
  createdAt: number;
}

interface FundNavPoint {
  navDate: string;
  nav: number;
  accNav: number;
  dailyReturn: number;
}

interface FundDashboardData {
  today: string;
  updatedAt: number;
  summary: FundValuationSummary;
  holdings: FundHoldingConfig[];
  snapshots: FundSnapshotPoint[];
  navHistory: Record<string, FundNavPoint[]>;
}

interface FundPluginResponse<T = unknown> {
  ok: boolean;
  plugin: string;
  action: string;
  notify: boolean;
  title?: string;
  message: string;
  data?: T;
}

type FundTrendMetricKey = 'asset' | 'totalPnl' | 'dailyPnl' | 'holdingNav';
type FundTypeFilterKey = 'all' | 'stock' | 'fund';

interface ChartPoint {
  x: number;
  y: number;
  value: number;
  dateLabel: string;
  subLabel: string;
}

const FUND_TYPE_LABELS: Record<string, string> = {
  a_stock: 'A股股票',
  a_index: 'A股指数',
  a_etf_feeder: 'ETF联接',
  hk_etf_feeder: '港股QDII',
  us_qdii: '美股QDII',
  gold_feeder: '黄金联接',
  other: '混合基金',
};

const PRIVACY_STORAGE_KEY = 'friday.fund.privacy';

function readPrivacyPref(): boolean {
  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(PRIVACY_STORAGE_KEY) === '1' : false;
  } catch {
    return false;
  }
}

function writePrivacyPref(value: boolean): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(PRIVACY_STORAGE_KEY, value ? '1' : '0');
  } catch {
    // Ignore storage quota / restriction errors
  }
}

function listenEvent(
  target: EventTarget,
  type: string,
  handler: EventListenerOrEventListenerObject,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) return;
  target.addEventListener(type, handler, signal ? { signal } : undefined);
  if (signal) {
    signal.addEventListener('abort', () => {
      target.removeEventListener(type, handler);
    }, { once: true });
  }
}

function bindFormSubmission(
  form: HTMLFormElement,
  submitBtn: HTMLButtonElement,
  onSubmit: () => void,
  signal?: AbortSignal,
): void {
  attachDelayedFormValidation(form, signal);
  listenEvent(form, 'submit', e => {
    e.preventDefault();
    onSubmit();
  }, signal);
  listenEvent(submitBtn, 'click', e => {
    if (typeof form.requestSubmit !== 'function') {
      e.preventDefault();
      onSubmit();
    }
  }, signal);
}

function scrollRespectingMotion(el: HTMLElement): void {
  el.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
}

function formatMoney(n: number, privacy: boolean): string {
  if (privacy) return '¥****';
  return `¥${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatSignedMoney(n: number, privacy: boolean): string {
  if (privacy) return '****';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n > 0 ? `+¥${abs}` : n < 0 ? `-¥${abs}` : '¥0.00';
}

function formatBadgeMoney(n: number): string {
  const abs = Math.abs(n).toFixed(2);
  return n > 0 ? `+${abs}` : n < 0 ? `-${abs}` : '0.00';
}

function formatSignedPct(n: number): string {
  const abs = Math.abs(n).toFixed(2);
  return n > 0 ? `+${abs}%` : n < 0 ? `-${abs}%` : '0.00%';
}

function pnlColorClass(n: number): string {
  return n > 0 ? 'fund-pos' : n < 0 ? 'fund-neg' : 'fund-flat';
}

function getRowStatusBadge(row: FundHoldingRow): { text: string; cls: string } {
  if (row.quoteMissing) return { text: '行情缺失', cls: 'badge-amber' };
  if (row.usMarketClosed) return { text: '美股休市', cls: 'badge-slate' };
  if (row.navSource.includes('休市/盘前')) return { text: '盘前/休市', cls: 'badge-slate' };
  if (row.quoteStale) return { text: '数据过期', cls: 'badge-amber' };
  if (row.hasTodayOfficialNav) return { text: row.isAStock ? '收盘结算' : '正式净值', cls: 'badge-green' };
  if (row.navSource.includes('盘中估值') || row.navSource.includes('腾讯行情')) {
    return { text: '实时估值', cls: 'badge-blue' };
  }
  if (row.navSource.includes('待更新')) return { text: '预估待结', cls: 'badge-blue' };
  return { text: '最近净值', cls: 'badge-slate' };
}

export function initFundTrackerUi(options: FundTrackerUiOptions): FundTrackerUiController {
  const fundTopBadge = element<HTMLElement>('fund-top-badge');
  const fundPrivacyBtn = element<HTMLButtonElement>('fund-privacy-btn');
  const fundRefreshBtn = element<HTMLButtonElement>('fund-refresh-btn');
  const fundSettleBtn = element<HTMLButtonElement>('fund-settle-btn');
  const fundActionStatus = element<HTMLElement>('fund-action-status');
  const fundModeBadge = element<HTMLElement>('fund-mode-badge');
  const fundUpdatedMeta = element<HTMLElement>('fund-updated-meta');
  const fundHeroAsset = element<HTMLElement>('fund-hero-asset');
  const fundHeroDaily = element<HTMLElement>('fund-hero-daily');
  const fundHeroCostPnl = element<HTMLElement>('fund-hero-cost-pnl');
  const fundStocksWeight = element<HTMLElement>('fund-stocks-weight');
  const fundStocksBody = element<HTMLElement>('fund-stocks-body');
  const fundFundsWeight = element<HTMLElement>('fund-funds-weight');
  const fundFundsBody = element<HTMLElement>('fund-funds-body');
  const fundKpiGrid = element<HTMLElement>('fund-kpi-grid');
  const fundChartSection = element<HTMLElement>('fund-chart-section');
  const fundTrendMetrics = element<HTMLElement>('fund-trend-metrics');
  const fundNavSelect = element<HTMLSelectElement>('fund-nav-select');
  const fundTrendRanges = element<HTMLElement>('fund-trend-ranges');
  const fundTrendCanvas = element<HTMLCanvasElement>('fund-trend-canvas');
  const fundTrendCaption = element<HTMLElement>('fund-trend-caption');
  const fundHoldingsSubtitle = element<HTMLElement>('fund-holdings-subtitle');
  const fundTypeFilters = element<HTMLElement>('fund-type-filters');
  const fundAddJumpBtn = element<HTMLButtonElement>('fund-add-jump-btn');
  const fundHoldingsList = element<HTMLElement>('fund-holdings-list');
  const fundFormDetails = element<HTMLDetailsElement>('fund-form-details');
  const fundFormSummary = element<HTMLElement>('fund-form-summary');
  const fundHoldingForm = element<HTMLFormElement>('fund-holding-form');
  const fundEditOriginalCode = element<HTMLInputElement>('fund-edit-original-code');
  const fundFormCode = element<HTMLInputElement>('fund-form-code');
  const fundFormName = element<HTMLInputElement>('fund-form-name');
  const fundFormType = element<HTMLSelectElement>('fund-form-type');
  const fundFormCost = element<HTMLInputElement>('fund-form-cost');
  const fundFormShares = element<HTMLInputElement>('fund-form-shares');
  const fundFormProxy = element<HTMLInputElement>('fund-form-proxy');
  const fundFormProxyName = element<HTMLInputElement>('fund-form-proxy-name');
  const fundFormRatio = element<HTMLInputElement>('fund-form-ratio');
  const fundFormInitNav = element<HTMLInputElement>('fund-form-init-nav');
  const fundFormInitDate = element<HTMLInputElement>('fund-form-init-date');
  const fundFormResetBtn = element<HTMLButtonElement>('fund-form-reset-btn');
  const fundFormSaveBtn = element<HTMLButtonElement>('fund-form-save-btn');

  fundTrendCanvas.setAttribute('aria-describedby', 'fund-trend-caption');

  const lifecycleAc = new AbortController();
  let activeAc: AbortController | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeRafId: number | null = null;
  let quietFetchAc: AbortController | null = null;
  let disposed = false;

  const deleteArmed = new Map<string, number>();
  const deleteArmedTimers = new Map<string, ReturnType<typeof setTimeout>>();

  let dashboard: FundDashboardData | null = null;
  let lastDataMode: 'cached' | 'live' | 'settle' = 'cached';
  let privacyMode = readPrivacyPref();
  let trendMetric: FundTrendMetricKey = 'asset';
  let trendLimit = 30;
  let selectedNavCode = '';
  let typeFilter: FundTypeFilterKey = 'all';
  let hoveredPointIdx: number | null = null;
  let plottedPoints: ChartPoint[] = [];
  let lastChartCssW = 900;
  let lastChartCssH = 220;
  let busy = false;
  let requestSeq = 0;
  let lastStatusBanner = '';

  function clearHoldingDeleteArm(code: string) {
    deleteArmed.delete(code);
    const timer = deleteArmedTimers.get(code);
    if (timer !== undefined) {
      clearTimeout(timer);
      deleteArmedTimers.delete(code);
    }
  }

  function armHoldingDelete(code: string) {
    clearHoldingDeleteArm(code);
    deleteArmed.set(code, Date.now());
    const timer = setTimeout(() => {
      deleteArmed.delete(code);
      deleteArmedTimers.delete(code);
      if (options.isVisible() && dashboard) {
        renderHoldingsList();
      }
    }, 5000);
    deleteArmedTimers.set(code, timer);
  }

  function setActionStatus(text = '', tone: '' | 'ok' | 'warn' | 'err' = '') {
    const trimmed = text.trim();
    if (!text) {
      fundActionStatus.hidden = true;
      fundActionStatus.textContent = '';
      fundActionStatus.className = 'health-status-banner';
      lastStatusBanner = '';
      return;
    }
    fundActionStatus.hidden = false;
    fundActionStatus.textContent = text;
    fundActionStatus.className = `health-status-banner${tone ? ` tone-${tone}` : ''}`;
    if (trimmed && trimmed !== lastStatusBanner && options.isVisible()) {
      announceStatus(trimmed, tone === 'err' ? 'assertive' : 'polite');
    }
    lastStatusBanner = trimmed;
  }

  async function runFundPlugin<T>(
    action: string,
    args: Record<string, unknown> = {},
    reqOpts?: ApiRequestOptions,
  ): Promise<FundPluginResponse<T>> {
    return api<FundPluginResponse<T>>('/api/plugin-run', {
      plugin: 'fund-tracker',
      action,
      args,
    }, reqOpts);
  }

  function clearFormInvalidStates() {
    for (const field of [fundFormCode, fundFormName, fundFormCost, fundFormShares, fundFormRatio, fundFormInitNav]) {
      field.setAttribute('aria-invalid', 'false');
    }
  }

  function resetForm(openAfter = false) {
    fundEditOriginalCode.value = '';
    fundFormCode.value = '';
    fundFormCode.disabled = false;
    fundFormName.value = '';
    fundFormType.value = 'a_index';
    fundFormCost.value = '';
    fundFormShares.value = '';
    fundFormProxy.value = '';
    fundFormProxyName.value = '';
    fundFormRatio.value = '';
    fundFormInitNav.value = '';
    fundFormInitDate.value = '';
    clearFormInvalidStates();
    fundFormSummary.textContent = '➕ 新增或修改股票 / 基金持仓';
    if (openAfter) {
      fundFormDetails.open = true;
    }
  }

  function populateFormForEdit(cfg: FundHoldingConfig) {
    fundEditOriginalCode.value = cfg.code;
    fundFormCode.value = cfg.code;
    fundFormCode.disabled = true;
    fundFormName.value = cfg.name;
    fundFormType.value = cfg.fundType in FUND_TYPE_LABELS ? cfg.fundType : 'other';
    fundFormCost.value = String(cfg.cost);
    fundFormShares.value = String(cfg.shares);
    fundFormProxy.value = cfg.proxySymbol;
    fundFormProxyName.value = cfg.proxyName;
    fundFormRatio.value = String(cfg.positionRatio);
    fundFormInitNav.value = String(cfg.initNav);
    fundFormInitDate.value = cfg.initNavDate;
    clearFormInvalidStates();
    fundFormSummary.textContent = `✏️ 正在修改持仓：${cfg.name} (${cfg.code})`;
    fundFormDetails.open = true;
    scrollRespectingMotion(fundFormDetails);
    safeFocus(fundFormCost);
  }

  function renderTopBadge() {
    fundTopBadge.classList.remove('fund-pos', 'fund-neg');
    if (!dashboard || dashboard.holdings.length === 0) {
      fundTopBadge.textContent = '—';
      fundTopBadge.title = '暂无持仓配置';
      return;
    }
    const { summary } = dashboard;
    if (privacyMode) {
      fundTopBadge.textContent = '****';
      fundTopBadge.title = '投资金额已脱敏';
      return;
    }
    fundTopBadge.textContent = formatBadgeMoney(summary.totalDailyPnl);
    if (summary.totalDailyPnl > 0) fundTopBadge.classList.add('fund-pos');
    else if (summary.totalDailyPnl < 0) fundTopBadge.classList.add('fund-neg');
    fundTopBadge.title = `总资产 ¥${summary.totalAsset.toFixed(2)} · 当日 ${formatSignedMoney(summary.totalDailyPnl, false)} (${formatSignedPct(summary.dailyPnlPct)})`;
  }

  function renderGroupCard(
    group: FundGroupSummary,
    totalAsset: number,
    weightEl: HTMLElement,
    bodyEl: HTMLElement,
    emptyLabel: string,
  ) {
    const sharePct = totalAsset > 0 ? Math.min(100, Math.max(0, (group.asset / totalAsset) * 100)) : 0;
    weightEl.textContent = `${sharePct.toFixed(1)}% 仓位`;

    if (group.count === 0) {
      bodyEl.replaceChildren(node('p', emptyLabel, 'empty'));
      return;
    }

    const assetLine = node('div', `${formatMoney(group.asset, privacyMode)} (${group.count} 只)`, 'fund-group-asset');
    const dailyLine = node('div', '', 'fund-group-stat');
    dailyLine.append(
      node('span', '当日：', 'meta'),
      node('strong', `${formatSignedMoney(group.dailyPnl, privacyMode)} (${formatSignedPct(group.dailyPnlPct)})`, pnlColorClass(group.dailyPnl)),
    );
    const totalLine = node('div', '', 'fund-group-stat');
    totalLine.append(
      node('span', '累计：', 'meta'),
      node('strong', `${formatSignedMoney(group.totalPnl, privacyMode)} (${formatSignedPct(group.totalPnlPct)})`, pnlColorClass(group.totalPnl)),
    );
    const prog = document.createElement('progress');
    prog.className = 'usage-share-progress';
    prog.max = 100;
    prog.value = Number(sharePct.toFixed(1));
    prog.setAttribute('aria-label', `仓位占比 ${sharePct.toFixed(1)}%`);

    bodyEl.replaceChildren(assetLine, dailyLine, totalLine, prog);
  }

  function renderHeroAndKpis() {
    if (!dashboard) return;
    const { summary, today, updatedAt } = dashboard;

    fundPrivacyBtn.textContent = privacyMode ? '👁 显示金额' : '👁 隐藏金额';
    fundPrivacyBtn.classList.toggle('active', privacyMode);
    fundPrivacyBtn.setAttribute('aria-pressed', String(privacyMode));

    if (lastDataMode === 'settle') {
      fundModeBadge.textContent = '🌙 晚间结算';
      fundModeBadge.className = 'hub-badge badge-green';
    } else if (lastDataMode === 'live') {
      fundModeBadge.textContent = '⚡ 实时估值';
      fundModeBadge.className = 'hub-badge badge-blue';
    } else {
      fundModeBadge.textContent = '💾 缓存快照';
      fundModeBadge.className = 'hub-badge badge-slate';
    }
    fundUpdatedMeta.textContent = `日期 ${today} · 更新 ${timestamp(updatedAt)}`;

    fundHeroAsset.textContent = formatMoney(summary.totalAsset, privacyMode);
    fundHeroDaily.textContent = `当日盈亏：${formatSignedMoney(summary.totalDailyPnl, privacyMode)} (${formatSignedPct(summary.dailyPnlPct)})`;
    fundHeroDaily.className = `fund-hero-daily ${pnlColorClass(summary.totalDailyPnl)}`;
    fundHeroCostPnl.textContent = `投入成本：${formatMoney(summary.totalCost, privacyMode)} · 累计收益：${formatSignedMoney(summary.totalPnl, privacyMode)} (${formatSignedPct(summary.totalPnlPct)})`;

    renderGroupCard(summary.stocks, summary.totalAsset, fundStocksWeight, fundStocksBody, '暂无股票持仓');
    renderGroupCard(summary.funds, summary.totalAsset, fundFundsWeight, fundFundsBody, '暂无基金持仓');

    const officialCount = summary.holdings.filter(h => h.hasTodayOfficialNav).length;
    const warnCount = summary.holdings.filter(h => h.quoteMissing || h.quoteStale).length;

    const dailyTone = summary.totalDailyPnl > 0 ? 'accent' : summary.totalDailyPnl < 0 ? 'positive' : 'default';
    const totalTone = summary.totalPnl > 0 ? 'accent' : summary.totalPnl < 0 ? 'positive' : 'default';

    fundKpiGrid.replaceChildren(
      kpiCard('总持仓资产', formatMoney(summary.totalAsset, privacyMode), `共 ${summary.holdings.length} 只标的`, 'default'),
      kpiCard('累计投入成本', formatMoney(summary.totalCost, privacyMode), `股票 ${summary.stocks.count} / 基金 ${summary.funds.count}`, 'default'),
      kpiCard('当日浮动盈亏', formatSignedMoney(summary.totalDailyPnl, privacyMode), `日收益率 ${formatSignedPct(summary.dailyPnlPct)}`, dailyTone),
      kpiCard(
        '累计总盈亏',
        formatSignedMoney(summary.totalPnl, privacyMode),
        `收益率 ${formatSignedPct(summary.totalPnlPct)} · 已结算 ${officialCount}/${summary.holdings.length}${warnCount > 0 ? ` · ${warnCount} 项提醒` : ''}`,
        totalTone,
      ),
    );
  }

  function renderNavSelector() {
    const holdings = dashboard?.holdings ?? [];
    if (!selectedNavCode || !holdings.some(h => h.code === selectedNavCode)) {
      const firstFund = holdings.find(h => h.fundType !== 'a_stock') ?? holdings[0];
      selectedNavCode = firstFund ? firstFund.code : '';
    }
    const frag = document.createDocumentFragment();
    for (const h of holdings) {
      const opt = document.createElement('option');
      opt.value = h.code;
      opt.textContent = `${h.name} (${h.code})`;
      if (h.code === selectedNavCode) opt.selected = true;
      frag.append(opt);
    }
    fundNavSelect.replaceChildren(frag);
    fundNavSelect.hidden = trendMetric !== 'holdingNav' || holdings.length === 0;
  }

  function renderTrendControls() {
    for (const btn of fundTrendMetrics.querySelectorAll<HTMLButtonElement>('button[data-metric]')) {
      const isActive = btn.dataset.metric === trendMetric;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    }
    for (const btn of fundTrendRanges.querySelectorAll<HTMLButtonElement>('button[data-range]')) {
      const isActive = Number(btn.dataset.range) === trendLimit;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    }
    renderNavSelector();
  }

  function renderTrendChart() {
    const canvas = fundTrendCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(320, Math.round(rect.width || canvas.clientWidth || 900));
    const cssH = Math.max(180, Math.round(rect.height || canvas.clientHeight || 220));
    lastChartCssW = cssW;
    lastChartCssH = cssH;
    const rawDpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
    const dpr = Math.min(rawDpr, 2);
    if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
      canvas.width = cssW * dpr;
      canvas.height = cssH * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    plottedPoints = [];

    const isIndustrial = typeof document !== 'undefined' && document.documentElement?.dataset?.theme === 'industrial';
    const axisTextCol = isIndustrial ? '#52525b' : '#94a3b8';
    const gridStrokeCol = isIndustrial ? 'rgba(24, 24, 27, 0.12)' : 'rgba(148, 163, 184, 0.16)';

    if (!dashboard) {
      fundTrendCaption.textContent = '暂无图表数据。';
      return;
    }

    interface SeriesItem {
      value: number;
      dateLabel: string;
      subLabel: string;
    }
    const series: SeriesItem[] = [];
    let metricTitle = '总资产';
    let strokeColor = isIndustrial ? '#ff6b1a' : '#f59e0b';
    let fillRgb = isIndustrial ? '255, 107, 26' : '245, 158, 11';
    let isMoneySeries = true;

    if (trendMetric === 'holdingNav') {
      isMoneySeries = false;
      const selectedHolding = dashboard.holdings.find(h => h.code === selectedNavCode);
      metricTitle = selectedHolding ? `${selectedHolding.name} 单位净值` : '标的净值';
      strokeColor = '#38bdf8';
      fillRgb = '56, 189, 248';
      const navList = (dashboard.navHistory[selectedNavCode] ?? []).slice(-trendLimit);
      for (const item of navList) {
        series.push({
          value: item.nav,
          dateLabel: item.navDate,
          subLabel: `${item.navDate} 净值 ${item.nav.toFixed(4)} (${formatSignedPct(item.dailyReturn)})`,
        });
      }
    } else {
      const snaps = dashboard.snapshots.slice(-trendLimit);
      if (trendMetric === 'asset') {
        metricTitle = '总资产';
        strokeColor = isIndustrial ? '#ff6b1a' : '#f59e0b';
        fillRgb = isIndustrial ? '255, 107, 26' : '245, 158, 11';
        for (const s of snaps) {
          series.push({
            value: s.totalAsset,
            dateLabel: s.date,
            subLabel: `${s.date} (${s.kind === 'settle' ? '结算' : '估值'}) · 总资产 ${formatMoney(s.totalAsset, privacyMode)}`,
          });
        }
      } else if (trendMetric === 'totalPnl') {
        metricTitle = '累计收益';
        strokeColor = '#fb7185';
        fillRgb = '251, 113, 133';
        for (const s of snaps) {
          series.push({
            value: s.totalPnl,
            dateLabel: s.date,
            subLabel: `${s.date} 累计盈亏 ${formatSignedMoney(s.totalPnl, privacyMode)}`,
          });
        }
      } else {
        metricTitle = '单日盈亏';
        strokeColor = '#34d399';
        fillRgb = '52, 211, 153';
        for (const s of snaps) {
          series.push({
            value: s.dailyPnl,
            dateLabel: s.date,
            subLabel: `${s.date} 当日盈亏 ${formatSignedMoney(s.dailyPnl, privacyMode)}`,
          });
        }
      }
    }

    if (series.length === 0) {
      ctx.fillStyle = axisTextCol;
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`暂无「${metricTitle}」历史数据，执行估值/结算或净值同步后自动绘制`, cssW / 2, cssH / 2);
      fundTrendCaption.textContent = `暂无「${metricTitle}」可用数据点。`;
      return;
    }

    const values = series.map(s => s.value);
    const minRaw = Math.min(...values);
    const maxRaw = Math.max(...values);
    const baseSpan = isMoneySeries ? Math.max(Math.abs(maxRaw) * 0.02, 50) : Math.max(Math.abs(maxRaw) * 0.03, 0.02);
    const span = Math.max(maxRaw - minRaw, baseSpan);
    const minV = minRaw - span * 0.16;
    const maxV = maxRaw + span * 0.16;
    const vRange = Math.max(0.0001, maxV - minV);

    const padL = 62;
    const padR = 20;
    const padT = 20;
    const padB = 34;
    const plotW = Math.max(60, cssW - padL - padR);
    const plotH = Math.max(60, cssH - padT - padB);

    const yOf = (val: number) => padT + plotH * (1 - (val - minV) / vRange);
    const xOf = (idx: number) => (series.length === 1
      ? padL + plotW / 2
      : padL + (idx / (series.length - 1)) * plotW);

    ctx.lineWidth = 1;
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const val = minV + (vRange * (gridSteps - i)) / gridSteps;
      const y = padT + (plotH * i) / gridSteps;
      ctx.strokeStyle = gridStrokeCol;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(cssW - padR, y);
      ctx.stroke();

      ctx.fillStyle = axisTextCol;
      const axisText = isMoneySeries
        ? (privacyMode ? '****' : Math.round(val).toLocaleString('en-US'))
        : val.toFixed(3);
      ctx.fillText(axisText, padL - 8, y + 4);
    }

    if ((trendMetric === 'totalPnl' || trendMetric === 'dailyPnl') && minV < 0 && maxV > 0) {
      const zeroY = yOf(0);
      ctx.save();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.48)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, zeroY);
      ctx.lineTo(cssW - padR, zeroY);
      ctx.stroke();
      ctx.restore();
    }

    const pts: ChartPoint[] = series.map((s, idx) => ({
      x: xOf(idx),
      y: yOf(s.value),
      value: s.value,
      dateLabel: s.dateLabel,
      subLabel: s.subLabel,
    }));
    plottedPoints = pts;

    if (pts.length > 1) {
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, `rgba(${fillRgb}, 0.24)`);
      grad.addColorStop(1, `rgba(${fillRgb}, 0.01)`);
      const firstPt = pts[0];
      const lastPt = pts[pts.length - 1];
      if (firstPt && lastPt) {
        ctx.beginPath();
        ctx.moveTo(firstPt.x, padT + plotH);
        for (const p of pts) ctx.lineTo(p.x, p.y);
        ctx.lineTo(lastPt.x, padT + plotH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(firstPt.x, firstPt.y);
        for (let i = 1; i < pts.length; i++) {
          const p = pts[i];
          if (p) ctx.lineTo(p.x, p.y);
        }
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2.4;
        ctx.stroke();
      }
    } else if (pts[0]) {
      ctx.save();
      ctx.strokeStyle = `rgba(${fillRgb}, 0.45)`;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(padL, pts[0].y);
      ctx.lineTo(cssW - padR, pts[0].y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.fillStyle = axisTextCol;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    const tickCount = Math.min(pts.length, 6);
    for (let t = 0; t < tickCount; t++) {
      const idx = tickCount === 1 ? 0 : Math.round((t * (pts.length - 1)) / (tickCount - 1));
      const p = pts[idx];
      if (!p) continue;
      ctx.fillText(p.dateLabel.slice(5), p.x, cssH - 10);
    }

    const activeIdx = hoveredPointIdx !== null && hoveredPointIdx < pts.length ? hoveredPointIdx : pts.length - 1;
    const focusAccent = isIndustrial ? '#c2410c' : '#fbbf24';
    const focusCrosshair = isIndustrial ? 'rgba(194, 65, 12, 0.50)' : 'rgba(251, 191, 36, 0.45)';
    const pointOutline = isIndustrial ? '#f7f4ed' : '#090b10';
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (!p) continue;
      const isActive = i === activeIdx;
      if (isActive) {
        ctx.save();
        ctx.strokeStyle = focusCrosshair;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(p.x, padT);
        ctx.lineTo(p.x, padT + plotH);
        ctx.stroke();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, isActive ? 5.2 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? focusAccent : strokeColor;
      ctx.fill();
      ctx.strokeStyle = pointOutline;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    const focusPt = pts[activeIdx];
    fundTrendCaption.textContent = focusPt
      ? `${metricTitle}（共 ${pts.length} 个数据点）· 当前选中：${focusPt.subLabel}`
      : `${metricTitle}（共 ${pts.length} 个数据点）`;
  }

  function renderHoldingsList() {
    for (const btn of fundTypeFilters.querySelectorAll<HTMLButtonElement>('button[data-filter]')) {
      const isActive = btn.dataset.filter === typeFilter;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', String(isActive));
    }
    const allRows = dashboard?.summary.holdings ?? [];
    const configsByCode = new Map((dashboard?.holdings ?? []).map(c => [c.code, c]));
    const filtered = typeFilter === 'stock'
      ? allRows.filter(r => r.isAStock)
      : typeFilter === 'fund'
        ? allRows.filter(r => !r.isAStock)
        : allRows;

    fundHoldingsSubtitle.textContent = `共 ${filtered.length} 只（总计 ${allRows.length} 只）`;

    if (filtered.length === 0) {
      fundHoldingsList.replaceChildren(node('p', '当前筛选下暂无持仓记录。', 'empty'));
      return;
    }

    const focusedActionKey = typeof document !== 'undefined' && fundHoldingsList.contains?.(document.activeElement)
      ? ((document.activeElement as HTMLElement | null)?.dataset?.holdingFocusKey ?? null)
      : null;

    const now = Date.now();
    const frag = document.createDocumentFragment();
    for (const row of filtered) {
      const cfg = configsByCode.get(row.code);
      const card = node('div', '', 'fund-holding-row');

      const mainCol = node('div', '', 'fund-holding-main');
      const titleLine = node('div', '', 'fund-holding-title');
      const typeLabel = FUND_TYPE_LABELS[String(row.fundType ?? cfg?.fundType ?? (row.isAStock ? 'a_stock' : 'other'))] ?? '基金';
      const statusBadge = getRowStatusBadge(row);

      titleLine.append(
        node('strong', row.name, 'fund-holding-name'),
        node('code', row.code, 'fund-holding-code'),
        node('span', typeLabel, 'hub-badge badge-slate'),
        node('span', statusBadge.text, `hub-badge ${statusBadge.cls}`),
      );
      if (row.proxySymbol) {
        const proxyText = row.proxyName && row.proxyName !== row.proxySymbol
          ? `锚定 ${row.proxyName} [${row.proxySymbol}]`
          : `锚定 ${row.proxySymbol}`;
        titleLine.append(node('span', proxyText, 'hub-meta-chip'));
      }

      const metricsGrid = node('div', '', 'fund-holding-metrics');
      const unitLabel = row.isAStock ? '股' : '份';
      const navPrecision = row.isAStock ? (row.currentNav < 10 ? 3 : 2) : 4;
      const sharesPrecision = row.isAStock ? 0 : 2;
      const metrics: Array<[string, string, string?]> = [
        [row.isAStock ? '现价' : '净值', row.currentNav.toFixed(navPrecision)],
        ['数量', `${row.shares.toFixed(sharesPrecision)} ${unitLabel}`],
        ['成本', formatMoney(row.cost, privacyMode)],
        ['市值', formatMoney(row.currentAsset, privacyMode)],
        ['当日盈亏', `${formatSignedMoney(row.dailyPnl, privacyMode)} (${formatSignedPct(row.changePct)})`, pnlColorClass(row.dailyPnl)],
        ['累计收益', `${formatSignedMoney(row.totalPnl, privacyMode)} (${formatSignedPct(row.totalPnlPct)})`, pnlColorClass(row.totalPnl)],
      ];
      for (const [label, val, valCls] of metrics) {
        const cell = node('div', '', 'fund-metric-kv');
        cell.append(
          node('span', label, 'meta'),
          node('strong', val, valCls || ''),
        );
        metricsGrid.append(cell);
      }

      const sourceNote = node('div', row.navSource, 'hint fund-holding-source');
      mainCol.append(titleLine, metricsGrid, sourceNote);

      const actionsCol = node('div', '', 'fund-holding-actions');
      const trendBtn = button('📈 走势', () => {
        trendMetric = 'holdingNav';
        selectedNavCode = row.code;
        hoveredPointIdx = null;
        renderTrendControls();
        renderTrendChart();
        scrollRespectingMotion(fundChartSection);
      }, 'mini-button');
      trendBtn.setAttribute('aria-label', `查看 ${row.name} (${row.code}) 净值走势`);
      trendBtn.dataset.holdingFocusKey = `${row.code}:trend`;

      const editBtn = button('✏️ 编辑', () => {
        if (cfg) {
          populateFormForEdit(cfg);
        } else {
          populateFormForEdit({
            code: row.code,
            name: row.name,
            fundType: String(row.fundType ?? (row.isAStock ? 'a_stock' : 'other')),
            proxySymbol: String(row.proxySymbol ?? ''),
            proxyName: String(row.proxyName ?? ''),
            positionRatio: Number(row.positionRatio ?? (row.isAStock ? 1 : 0.95)),
            initAmount: row.cost,
            cost: row.cost,
            initNav: Number(row.initNav ?? row.currentNav),
            initNavDate: String(row.initNavDate ?? row.baseNavDate),
            shares: row.shares,
            lastNav: row.currentNav,
            lastNavDate: row.baseNavDate,
            updatedAt: Date.now(),
          });
        }
      }, 'mini-button');
      editBtn.setAttribute('aria-label', `编辑持仓 ${row.name} (${row.code})`);
      editBtn.dataset.holdingFocusKey = `${row.code}:edit`;

      const armedAt = deleteArmed.get(row.code) ?? 0;
      const isArmed = now - armedAt < 5000;
      const delBtn = button(isArmed ? '确认删除' : '🗑️ 删除', () => {
        const currentlyArmed = Date.now() - (deleteArmed.get(row.code) ?? 0) < 5000;
        if (!currentlyArmed) {
          armHoldingDelete(row.code);
          renderHoldingsList();
          return;
        }
        clearHoldingDeleteArm(row.code);
        renderHoldingsList();
        void deleteHoldingFromUi(row.code);
      }, 'mini-button danger-btn');
      delBtn.setAttribute(
        'aria-label',
        isArmed ? `确认删除持仓 ${row.name} (${row.code})` : `删除持仓 ${row.name} (${row.code})`,
      );
      delBtn.dataset.holdingFocusKey = `${row.code}:del`;

      actionsCol.append(trendBtn, editBtn, delBtn);
      card.append(mainCol, actionsCol);
      frag.append(card);
    }
    fundHoldingsList.replaceChildren(frag);
    if (focusedActionKey) {
      const targetBtn = Array.from(fundHoldingsList.querySelectorAll<HTMLButtonElement>('button[data-holding-focus-key]'))
        .find(b => b.dataset.holdingFocusKey === focusedActionKey);
      if (targetBtn) safeFocus(targetBtn, { preventScroll: true });
    }
  }

  function renderModal() {
    if (!dashboard) return;
    renderHeroAndKpis();
    renderTrendControls();
    renderTrendChart();
    renderHoldingsList();
  }

  async function refreshDashboard(opts: {
    refresh?: boolean;
    mode?: 'status' | 'settle';
    quiet?: boolean;
    dataMode?: 'cached' | 'live' | 'settle';
  } = {}) {
    if (disposed || appState.authExpired) return;
    const seq = ++requestSeq;
    const isRefresh = Boolean(opts.refresh);
    const mode = opts.mode === 'settle' ? 'settle' : 'status';
    const isQuietPoll = Boolean(opts.quiet && !isRefresh);
    let ac: AbortController | null = null;
    if (isQuietPoll) {
      quietFetchAc?.abort();
      ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      quietFetchAc = ac;
    } else {
      quietFetchAc?.abort();
      quietFetchAc = null;
    }
    const reqOpts: ApiRequestOptions = {
      ...(isQuietPoll ? { priority: 'low' } : {}),
      signal: ac ? ac.signal : lifecycleAc.signal,
    };

    if (!opts.quiet) {
      setActionStatus(
        mode === 'settle' ? '正在从东方财富与腾讯财经拉取最新正式净值进行结算…' : isRefresh ? '正在刷新实时估值与市场行情…' : '正在加载投资看板…',
        '',
      );
    }
    try {
      const res = await runFundPlugin<FundDashboardData>('dashboard', {
        refresh: isRefresh,
        mode,
      }, reqOpts);
      if (disposed || seq !== requestSeq || appState.authExpired) {
        return;
      }
      if (!res.ok || !res.data) {
        if (!opts.quiet) setActionStatus(res.message || '加载投资看板失败', 'err');
        return;
      }
      dashboard = res.data;
      lastDataMode = opts.dataMode ?? (isRefresh ? (mode === 'settle' ? 'settle' : 'live') : 'cached');
      renderTopBadge();
      if (options.isVisible()) {
        renderModal();
        if (!opts.quiet) {
          setActionStatus(res.message || '数据已更新', 'ok');
        }
      }
    } catch (err) {
      if (ac?.signal.aborted || (err instanceof Error && err.name === 'AbortError')) return;
      if (!disposed && seq === requestSeq && !opts.quiet && options.isVisible() && !appState.authExpired) {
        setActionStatus(`加载投资看板失败：${errorText(err)}`, 'err');
      }
    } finally {
      if (ac && quietFetchAc === ac) quietFetchAc = null;
    }
  }

  async function triggerManualRefresh(mode: 'status' | 'settle') {
    if (busy || appState.authExpired) return;
    busy = true;
    fundRefreshBtn.disabled = true;
    fundSettleBtn.disabled = true;
    try {
      await refreshDashboard({
        refresh: true,
        mode,
        quiet: false,
        dataMode: mode === 'settle' ? 'settle' : 'live',
      });
    } finally {
      busy = false;
      fundRefreshBtn.disabled = appState.authExpired;
      fundSettleBtn.disabled = appState.authExpired;
    }
  }

  async function deleteHoldingFromUi(code: string) {
    if (busy || appState.authExpired) return;
    busy = true;
    ++requestSeq;
    try {
      const res = await runFundPlugin('remove-holding', { code });
      if (!res.ok) {
        setActionStatus(res.message || '移除持仓失败', 'err');
        return;
      }
      if (fundEditOriginalCode.value === code) {
        resetForm(false);
      }
      setActionStatus(res.message || `已移除 ${code}`, 'ok');
      await refreshDashboard({ refresh: false, quiet: true, dataMode: lastDataMode });
    } catch (err) {
      setActionStatus(`移除持仓失败：${errorText(err)}`, 'err');
    } finally {
      busy = false;
    }
  }

  async function saveHoldingFromUi() {
    if (busy) return;
    const originalCode = fundEditOriginalCode.value.trim();
    const code = fundFormCode.value.trim();
    const name = fundFormName.value.trim();
    const fundType = fundFormType.value.trim() || 'other';
    const costRaw = fundFormCost.value.trim();
    const cost = Number(costRaw);

    clearFormInvalidStates();
    if (!code || !name) {
      const invalidField = !code ? fundFormCode : fundFormName;
      invalidField.setAttribute('aria-invalid', 'true');
      setActionStatus('请填写标的代码和名称', 'warn');
      safeFocus(invalidField);
      return;
    }
    if (costRaw === '' || !Number.isFinite(cost) || cost < 0) {
      fundFormCost.setAttribute('aria-invalid', 'true');
      setActionStatus('请输入大于或等于 0 的有效总成本', 'warn');
      safeFocus(fundFormCost);
      return;
    }

    const sharesRaw = fundFormShares.value.trim();
    let parsedShares: number | undefined;
    if (sharesRaw !== '') {
      const v = Number(sharesRaw);
      if (!Number.isFinite(v) || v <= 0) {
        fundFormShares.setAttribute('aria-invalid', 'true');
        setActionStatus('持有份额/股数必须大于 0（或留空自动推算）', 'warn');
        safeFocus(fundFormShares);
        return;
      }
      parsedShares = v;
    }

    const ratioRaw = fundFormRatio.value.trim();
    let parsedRatio: number | undefined;
    if (ratioRaw !== '') {
      const v = Number(ratioRaw);
      if (!Number.isFinite(v) || v <= 0 || v > 1) {
        fundFormRatio.setAttribute('aria-invalid', 'true');
        setActionStatus('仓位映射系数必须在 (0, 1] 之间', 'warn');
        safeFocus(fundFormRatio);
        return;
      }
      parsedRatio = v;
    }

    const initNavRaw = fundFormInitNav.value.trim();
    let parsedInitNav: number | undefined;
    if (initNavRaw !== '') {
      const v = Number(initNavRaw);
      if (!Number.isFinite(v) || v <= 0) {
        fundFormInitNav.setAttribute('aria-invalid', 'true');
        setActionStatus('建仓基准净值必须大于 0', 'warn');
        safeFocus(fundFormInitNav);
        return;
      }
      parsedInitNav = v;
    }

    const proxySymbol = fundFormProxy.value.trim();
    const proxyName = fundFormProxyName.value.trim();
    const initDate = fundFormInitDate.value.trim();

    busy = true;
    fundFormSaveBtn.disabled = true;
    try {
      let res: FundPluginResponse;
      if (originalCode && originalCode === code) {
        const prevCfg = dashboard?.holdings.find(h => h.code === code);
        const setArgs: Record<string, unknown> = {
          code,
          name,
          fundType,
          cost,
          proxySymbol,
          proxyName: proxyName || proxySymbol || name,
        };
        if (parsedRatio !== undefined) setArgs.positionRatio = parsedRatio;
        if (parsedShares !== undefined) setArgs.shares = parsedShares;
        if (parsedInitNav !== undefined) setArgs.initNav = parsedInitNav;
        if (initDate && initDate !== prevCfg?.initNavDate && parsedShares === undefined) {
          setArgs.navDate = initDate;
        }
        res = await runFundPlugin('set-holding', setArgs);
      } else {
        const addArgs: Record<string, unknown> = {
          code,
          name,
          fundType,
          cost,
          proxySymbol,
          proxyName: proxyName || (fundType === 'a_stock' ? name : proxySymbol),
        };
        if (parsedRatio !== undefined) addArgs.positionRatio = parsedRatio;
        if (parsedShares !== undefined) addArgs.shares = parsedShares;
        if (parsedInitNav !== undefined) addArgs.initNav = parsedInitNav;
        if (initDate) addArgs.initNavDate = initDate;
        res = await runFundPlugin('add-holding', addArgs);
      }

      if (!res.ok) {
        setActionStatus(res.message || '保存持仓失败', 'err');
        return;
      }

      resetForm(false);
      fundFormDetails.open = false;
      setActionStatus(res.message || `已保存 ${name} (${code})`, 'ok');
      await refreshDashboard({ refresh: true, mode: 'status', quiet: true, dataMode: 'live' });
    } catch (err) {
      setActionStatus(`保存持仓失败：${errorText(err)}`, 'err');
    } finally {
      busy = false;
      fundFormSaveBtn.disabled = appState.authExpired;
    }
  }

  function handleCanvasHover(event: PointerEvent) {
    if (!plottedPoints.length) return;
    const rect = fundTrendCanvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? lastChartCssW / rect.width : 1;
    const scaleY = rect.height > 0 ? lastChartCssH / rect.height : 1;
    const px = (event.clientX - rect.left) * scaleX;
    const py = (event.clientY - rect.top) * scaleY;
    let bestIdx: number | null = null;
    let bestDist = 28;
    for (let i = 0; i < plottedPoints.length; i++) {
      const pt = plottedPoints[i];
      if (!pt) continue;
      const dist = Math.hypot(pt.x - px, pt.y - py);
      if (dist <= bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx !== hoveredPointIdx) {
      hoveredPointIdx = bestIdx;
      renderTrendChart();
    }
  }

  function scheduleChartRedraw() {
    if (!options.isVisible() || !dashboard) return;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      if (resizeRafId !== null) window.cancelAnimationFrame(resizeRafId);
      resizeRafId = window.requestAnimationFrame(() => {
        resizeRafId = null;
        if (options.isVisible() && dashboard) renderTrendChart();
      });
    } else {
      renderTrendChart();
    }
  }

  function activate() {
    if (disposed) return;
    setActionStatus();
    fundRefreshBtn.disabled = appState.authExpired;
    fundSettleBtn.disabled = appState.authExpired;
    fundFormSaveBtn.disabled = appState.authExpired;
    activeAc?.abort();
    activeAc = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (typeof window !== 'undefined' && activeAc) {
      listenEvent(window, 'friday:themechange', () => {
        if (options.isVisible()) renderTrendChart();
      }, activeAc.signal);
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (typeof ResizeObserver !== 'undefined') {
      const target = fundTrendCanvas.parentElement ?? fundTrendCanvas;
      resizeObserver = new ResizeObserver(() => {
        scheduleChartRedraw();
      });
      resizeObserver.observe(target);
    }
    if (appState.authExpired) return;
    if (dashboard) {
      renderModal();
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(() => {
          if (options.isVisible() && dashboard) renderTrendChart();
        });
      } else {
        renderTrendChart();
      }
      void refreshDashboard({ refresh: true, mode: 'status', quiet: true, dataMode: 'live' });
      return;
    }
    void refreshDashboard({ refresh: false, quiet: true }).then(() => {
      if (!disposed && options.isVisible() && !appState.authExpired) {
        return refreshDashboard({ refresh: true, mode: 'status', quiet: true, dataMode: 'live' });
      }
      return undefined;
    });
  }

  function deactivate() {
    activeAc?.abort();
    activeAc = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (resizeRafId !== null && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(resizeRafId);
      resizeRafId = null;
    }
    for (const timer of deleteArmedTimers.values()) {
      clearTimeout(timer);
    }
    deleteArmedTimers.clear();
    deleteArmed.clear();
  }

  listenEvent(fundPrivacyBtn, 'click', () => {
    privacyMode = !privacyMode;
    writePrivacyPref(privacyMode);
    renderTopBadge();
    renderModal();
  }, lifecycleAc.signal);
  listenEvent(fundRefreshBtn, 'click', () => void triggerManualRefresh('status'), lifecycleAc.signal);
  listenEvent(fundSettleBtn, 'click', () => void triggerManualRefresh('settle'), lifecycleAc.signal);
  listenEvent(fundAddJumpBtn, 'click', () => {
    resetForm(true);
    scrollRespectingMotion(fundFormDetails);
    safeFocus(fundFormCode);
  }, lifecycleAc.signal);
  listenEvent(fundFormResetBtn, 'click', () => {
    resetForm(true);
    setActionStatus();
  }, lifecycleAc.signal);
  bindFormSubmission(fundHoldingForm, fundFormSaveBtn, () => void saveHoldingFromUi(), lifecycleAc.signal);
  listenEvent(fundFormType, 'change', () => {
    if (!fundEditOriginalCode.value && !isEditingWithin(fundFormRatio)) {
      fundFormRatio.placeholder = fundFormType.value === 'a_stock' ? '默认 1' : '基金默认 0.95，股票默认 1';
    }
  }, lifecycleAc.signal);
  listenEvent(fundTrendMetrics, 'click', event => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-metric]');
    const metric = target?.dataset.metric as FundTrendMetricKey | undefined;
    if (!metric) return;
    trendMetric = metric;
    hoveredPointIdx = null;
    renderTrendControls();
    renderTrendChart();
  }, lifecycleAc.signal);
  listenEvent(fundTrendRanges, 'click', event => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-range]');
    const range = Number(target?.dataset.range);
    if (!Number.isFinite(range) || range <= 0) return;
    trendLimit = range;
    hoveredPointIdx = null;
    renderTrendControls();
    renderTrendChart();
  }, lifecycleAc.signal);
  listenEvent(fundNavSelect, 'change', () => {
    if (!fundNavSelect.value) return;
    selectedNavCode = fundNavSelect.value;
    hoveredPointIdx = null;
    renderTrendChart();
  }, lifecycleAc.signal);
  listenEvent(fundTypeFilters, 'click', event => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('button[data-filter]');
    const filter = target?.dataset.filter as FundTypeFilterKey | undefined;
    if (!filter) return;
    typeFilter = filter;
    renderHoldingsList();
  }, lifecycleAc.signal);
  listenEvent(fundTrendCanvas, 'pointermove', ev => handleCanvasHover(ev as PointerEvent), lifecycleAc.signal);
  listenEvent(fundTrendCanvas, 'pointerdown', ev => handleCanvasHover(ev as PointerEvent), lifecycleAc.signal);
  const clearCanvasHover = () => {
    if (hoveredPointIdx !== null) {
      hoveredPointIdx = null;
      renderTrendChart();
    }
  };
  listenEvent(fundTrendCanvas, 'pointerleave', clearCanvasHover, lifecycleAc.signal);
  listenEvent(fundTrendCanvas, 'pointercancel', clearCanvasHover, lifecycleAc.signal);

  return {
    activate,
    deactivate,
    refreshBadge: () => (disposed || appState.authExpired ? Promise.resolve() : refreshDashboard({ refresh: false, quiet: true })),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      deactivate();
      quietFetchAc?.abort();
      quietFetchAc = null;
      lifecycleAc.abort();
    },
  };
}

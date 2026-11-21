import type {
  UsageActor,
  UsageCostSource,
  UsageCurrency,
  UsageGranularity,
  UsageModelBreakdownView,
  UsagePreferences,
  UsageReportView,
  UsageTotalsView,
} from '../../view.js';
import { button, element, isEditingWithin, kpiCard, node, svgNode } from '../shared/dom.js';
import { errorText, timestamp } from '../shared/format.js';
import { api, appState, hooks } from '../state.js';

export interface UsageHubOptions {
  isVisible: () => boolean;
  onBadgeChange?: (summary: { calls: number; badgeText: string; moneyText: string; detailText: string }) => void;
}

export interface UsageHubController {
  activate: () => void;
  render: (force?: boolean) => void;
}

const ACTOR_ORDER: readonly UsageActor[] = [
  'router',
  'worker',
  'decision',
  'distiller',
  'dreamer',
  'probe',
];

const ACTOR_LABELS: Record<UsageActor, string> = {
  router: '主控 (Router)',
  worker: 'Worker 执行',
  decision: '决策引擎',
  distiller: '记忆提炼',
  dreamer: '潜意识做梦',
  probe: '模型探针',
  compaction: '上下文压缩',
};

const ACTOR_SHORT_LABELS: Record<UsageActor, string> = {
  router: '主控',
  worker: 'Worker',
  decision: '决策',
  distiller: '提炼',
  dreamer: '做梦',
  probe: '探针',
  compaction: '压缩',
};

const COST_SOURCE_META: Record<UsageCostSource, { label: string; badgeClass: string }> = {
  provider: { label: '上游账单', badgeClass: 'badge-green' },
  catalog: { label: '目录价', badgeClass: 'badge-teal' },
  estimated: { label: '参考估算', badgeClass: 'badge-amber' },
  free: { label: '免费', badgeClass: 'badge-blue' },
  unknown: { label: '未知单价', badgeClass: 'badge-slate' },
};

function formatInt(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Math.round(value).toLocaleString('zh-CN');
}

function formatCompact(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return formatInt(value);
}

function formatMoneyAmount(value: number, symbol: '¥' | '$'): string {
  if (!Number.isFinite(value) || value === 0) return `${symbol}0.00`;
  const abs = Math.abs(value);
  if (abs >= 0.01) return `${symbol}${value.toFixed(2)}`;
  if (abs >= 0.0001) return `${symbol}${value.toFixed(4)}`;
  return `< ${symbol}0.0001`;
}

function formatCny(value: number): string {
  return formatMoneyAmount(value, '¥');
}

function formatUsd(value: number): string {
  return formatMoneyAmount(value, '$');
}

function formatPrimaryMoney(totals: Pick<UsageTotalsView, 'costUsd' | 'costCny'>, currency: UsageCurrency): string {
  return currency === 'USD' ? formatUsd(totals.costUsd) : formatCny(totals.costCny);
}

function formatPrimarySavings(
  totals: Pick<UsageTotalsView, 'cacheSavingsUsd' | 'cacheSavingsCny'>,
  currency: UsageCurrency,
): string {
  return currency === 'USD' ? formatUsd(totals.cacheSavingsUsd) : formatCny(totals.cacheSavingsCny);
}

function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0.0%';
  return `${Math.min(100, Math.max(0, ratio * 100)).toFixed(1)}%`;
}

function formatUnitRate(usdPer1M: number): string {
  if (!Number.isFinite(usdPer1M) || usdPer1M <= 0) return '$0';
  if (usdPer1M >= 1) return `$${usdPer1M.toFixed(2)}`;
  return `$${Number(usdPer1M.toFixed(4))}`;
}

function formatTimezoneChip(tzOffsetMin: number): string {
  const sign = tzOffsetMin <= 0 ? '+' : '-';
  const abs = Math.abs(tzOffsetMin);
  const hours = Math.floor(abs / 60);
  const mins = abs % 60;
  return mins ? `UTC${sign}${hours}:${String(mins).padStart(2, '0')}` : `UTC${sign}${hours}`;
}

function localTodayDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function initUsageHub(options: UsageHubOptions): UsageHubController {
  const usageTopBadge = element<HTMLElement>('usage-top-badge');
  const usagePanelEl = element<HTMLElement>('system-panel-usage');
  const usageRefreshBtn = element<HTMLButtonElement>('usage-refresh-btn');

  const granDayBtn = element<HTMLButtonElement>('usage-gran-day');
  const granWeekBtn = element<HTMLButtonElement>('usage-gran-week');
  const granMonthBtn = element<HTMLButtonElement>('usage-gran-month');
  const usagePrevBtn = element<HTMLButtonElement>('usage-prev-btn');
  const usageDateInput = element<HTMLInputElement>('usage-date-input');
  const usageNextBtn = element<HTMLButtonElement>('usage-next-btn');
  const usageTodayBtn = element<HTMLButtonElement>('usage-today-btn');

  const usagePeriodLabel = element<HTMLElement>('usage-period-label');
  const usageTzChip = element<HTMLElement>('usage-tz-chip');
  const currCnyBtn = element<HTMLButtonElement>('usage-curr-cny');
  const currUsdBtn = element<HTMLButtonElement>('usage-curr-usd');
  const usageRateInput = element<HTMLInputElement>('usage-rate-input');
  const usageRateSaveBtn = element<HTMLButtonElement>('usage-rate-save-btn');
  const usageStatusBanner = element<HTMLElement>('usage-status-banner');

  const usageKpiGrid = element<HTMLElement>('usage-kpi-grid');
  const usageChartTitle = element<HTMLElement>('usage-chart-title');
  const usageChartSubtitle = element<HTMLElement>('usage-chart-subtitle');
  const usageChartShell = element<HTMLElement>('usage-chart-shell');
  const usageRecentTitle = element<HTMLElement>('usage-recent-title');
  const usageRecentGrid = element<HTMLElement>('usage-recent-grid');
  const usageModelsSubtitle = element<HTMLElement>('usage-models-subtitle');
  const usageModelsList = element<HTMLElement>('usage-models-list');
  const usageActorsGrid = element<HTMLElement>('usage-actors-grid');

  let granularity: UsageGranularity = 'day';
  let anchorDate: string | undefined;
  let report: UsageReportView | undefined;
  let loading = false;
  let prefsBusy = false;
  let fetchSeq = 0;

  function setStatusError(message?: string) {
    if (!message) {
      usageStatusBanner.hidden = true;
      usageStatusBanner.textContent = '';
      return;
    }
    usageStatusBanner.hidden = false;
    usageStatusBanner.textContent = message;
  }

  function updateToolbarControls() {
    const disabled = appState.authExpired || !appState.ready;
    const busy = disabled || loading || prefsBusy;

    const granButtons: Array<[HTMLButtonElement, UsageGranularity]> = [
      [granDayBtn, 'day'],
      [granWeekBtn, 'week'],
      [granMonthBtn, 'month'],
    ];
    for (const [btn, key] of granButtons) {
      const active = granularity === key;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.disabled = disabled || prefsBusy;
    }

    const activeCurrency: UsageCurrency = report?.prefs.currency ?? appState.view?.usageToday?.currency ?? 'CNY';
    currCnyBtn.classList.toggle('active', activeCurrency === 'CNY');
    currUsdBtn.classList.toggle('active', activeCurrency === 'USD');
    currCnyBtn.disabled = busy;
    currUsdBtn.disabled = busy;

    usagePrevBtn.disabled = disabled || prefsBusy || !report;
    usageNextBtn.disabled = disabled || prefsBusy || !report;
    usageDateInput.disabled = disabled || prefsBusy;
    usageTodayBtn.disabled = disabled || prefsBusy || Boolean(report && report.anchorDate === report.todayDate);
    usageRefreshBtn.disabled = busy;
    usageRateInput.disabled = disabled || prefsBusy;
    usageRateSaveBtn.disabled = busy;
  }

  function renderChart(current: UsageReportView) {
    const buckets = current.buckets;
    const currency = current.prefs.currency;

    if (current.granularity === 'day') usageChartTitle.textContent = '24 小时分时趋势';
    else if (current.granularity === 'week') usageChartTitle.textContent = '本周每日趋势';
    else usageChartTitle.textContent = '本月逐日趋势';

    if (!buckets.length) {
      usageChartSubtitle.textContent = '';
      usageChartShell.replaceChildren(node('p', '当前周期暂无趋势数据。', 'empty hub-empty-state'));
      return;
    }

    const hasCost = buckets.some(b => b.costUsd > 0);
    const hasTokens = buckets.some(b => b.totalTokens > 0);
    const metricMode: 'cost' | 'tokens' | 'calls' = hasCost ? 'cost' : hasTokens ? 'tokens' : 'calls';

    const valueOf = (b: typeof buckets[number]): number => {
      if (metricMode === 'cost') return currency === 'USD' ? b.costUsd : b.costCny;
      if (metricMode === 'tokens') return b.totalTokens;
      return b.calls;
    };

    const maxVal = Math.max(...buckets.map(valueOf), 0);
    const safeMax = maxVal > 0 ? maxVal : 1;

    if (metricMode === 'cost') {
      usageChartSubtitle.textContent = `按折算金额（${currency === 'USD' ? '美元 $' : '人民币 ¥'}）`;
    } else if (metricMode === 'tokens') {
      usageChartSubtitle.textContent = '按 Token 消耗量';
    } else {
      usageChartSubtitle.textContent = '按调用次数';
    }

    const vbWidth = 860;
    const vbHeight = 224;
    const padLeft = 60;
    const padRight = 16;
    const padTop = 16;
    const padBottom = 38;
    const plotW = vbWidth - padLeft - padRight;
    const plotH = vbHeight - padTop - padBottom;

    const svg = svgNode('svg', {
      viewBox: `0 0 ${vbWidth} ${vbHeight}`,
      class: 'usage-chart-svg',
      role: 'img',
      'aria-label': usageChartTitle.textContent ?? '模型用量趋势图',
    });

    const formatAxisTick = (val: number): string => {
      if (val === 0) return '0';
      if (metricMode === 'cost') {
        return currency === 'USD' ? formatUsd(val) : formatCny(val);
      }
      return formatCompact(val);
    };

    const tickFractions = maxVal > 0 ? [0, 0.5, 1] : [0, 1];
    for (const frac of tickFractions) {
      const y = padTop + plotH * (1 - frac);
      svg.append(svgNode('line', {
        x1: String(padLeft),
        y1: y.toFixed(1),
        x2: String(vbWidth - padRight),
        y2: y.toFixed(1),
        class: frac === 0 ? 'usage-chart-baseline' : 'usage-chart-grid',
      }));
      const tickLabel = svgNode('text', {
        x: String(padLeft - 8),
        y: (y + 4).toFixed(1),
        'text-anchor': 'end',
        class: 'usage-chart-axis',
      });
      tickLabel.textContent = formatAxisTick(safeMax * frac);
      svg.append(tickLabel);
    }

    const slotW = plotW / buckets.length;
    const barW = Math.max(6, Math.min(38, slotW * 0.64));

    buckets.forEach((bucket, idx) => {
      const val = valueOf(bucket);
      const barH = val > 0 ? Math.max(3, (val / safeMax) * plotH) : 2;
      const slotX = padLeft + idx * slotW;
      const barX = slotX + (slotW - barW) / 2;
      const barY = padTop + plotH - barH;

      const group = svgNode('g', { class: 'usage-chart-bar-group' });
      const title = svgNode('title');
      const bucketCacheRead = bucket.cacheReadTokens ?? 0;
      const bucketCacheWrite = bucket.cacheWriteTokens ?? 0;
      const bucketPrompt = bucket.inputTokens + bucketCacheRead + bucketCacheWrite;
      const bucketTokenParts = [
        `输入 ${formatInt(bucket.inputTokens)}`,
        `输出 ${formatInt(bucket.outputTokens)}`,
      ];
      if (bucketCacheRead > 0) {
        bucketTokenParts.push(`缓读 ${formatInt(bucketCacheRead)}`);
      }
      if (bucketCacheWrite > 0) {
        bucketTokenParts.push(`缓写 ${formatInt(bucketCacheWrite)}`);
      }
      const bucketHitSuffix = bucketCacheRead > 0 && bucketPrompt > 0
        ? ` · 缓存命中 ${formatPercent(bucketCacheRead / bucketPrompt)}`
        : '';
      title.textContent = [
        bucket.label,
        `调用：${formatInt(bucket.calls)} 次`,
        `Token：${formatInt(bucket.totalTokens)}（${bucketTokenParts.join(' / ')}）${bucketHitSuffix}`,
        `金额：${formatCny(bucket.costCny)} (${formatUsd(bucket.costUsd)})`,
      ].join('\n');
      group.append(title);

      const hit = svgNode('rect', {
        x: slotX.toFixed(1),
        y: String(padTop),
        width: slotW.toFixed(1),
        height: String(plotH),
        class: 'usage-chart-hit',
      });
      const bar = svgNode('rect', {
        x: barX.toFixed(1),
        y: barY.toFixed(1),
        width: barW.toFixed(1),
        height: barH.toFixed(1),
        rx: '3',
        class: val > 0 ? 'usage-chart-bar has-value' : 'usage-chart-bar is-zero',
      });
      group.append(hit, bar);

      const showXLabel =
        current.granularity === 'week'
        || (current.granularity === 'day' && (idx % 3 === 0 || idx === buckets.length - 1))
        || (current.granularity === 'month' && (idx === 0 || (idx + 1) % 5 === 0 || idx === buckets.length - 1));

      if (showXLabel) {
        const label = svgNode('text', {
          x: (slotX + slotW / 2).toFixed(1),
          y: String(vbHeight - 12),
          'text-anchor': 'middle',
          class: 'usage-chart-xaxis',
        });
        label.textContent = current.granularity === 'day' ? bucket.key : bucket.label;
        group.append(label);
      }

      svg.append(group);
    });

    usageChartShell.replaceChildren(svg);
  }

  function renderRecentPeriods(current: UsageReportView) {
    if (current.granularity === 'day') usageRecentTitle.textContent = '近 7 日汇总';
    else if (current.granularity === 'week') usageRecentTitle.textContent = '近 8 周汇总';
    else usageRecentTitle.textContent = '近 6 个月汇总';

    if (!current.recentPeriods.length) {
      usageRecentGrid.replaceChildren(node('p', '暂无历史对比数据。', 'empty hub-empty-state'));
      return;
    }

    const frag = document.createDocumentFragment();
    for (const period of current.recentPeriods) {
      const selected = period.anchorDate === current.anchorDate;
      const cls = `usage-period-card${selected ? ' is-selected' : ''}${period.isCurrent ? ' is-current' : ''}`;
      const card = button('', () => {
        anchorDate = period.anchorDate;
        void fetchReport();
      }, cls);

      const top = node('div', '', 'usage-period-card-head');
      top.append(node('span', period.label, 'usage-period-card-label'));
      if (period.isCurrent) {
        top.append(node('span', '当期', 'hub-badge badge-teal'));
      }
      const amount = node('strong', formatPrimaryMoney(period, current.prefs.currency), 'usage-period-card-money');
      const meta = node('span', `${formatInt(period.calls)} 次 · ${formatCompact(period.totalTokens)} tok`, 'meta');

      card.append(top, amount, meta);
      frag.append(card);
    }
    usageRecentGrid.replaceChildren(frag);
  }

  function renderModelCard(item: UsageModelBreakdownView, current: UsageReportView): HTMLElement {
    const card = node('article', '', 'hub-entity-card usage-model-card');
    const head = node('div', '', 'hub-card-head');

    const titleGroup = node('div', '', 'hub-card-title-group');
    const sourceMeta = COST_SOURCE_META[item.costSource] ?? COST_SOURCE_META.unknown;
    titleGroup.append(
      node('span', item.provider, 'hub-badge badge-blue'),
      node('strong', item.model, 'hub-card-title mono-chip'),
      node('span', sourceMeta.label, `hub-badge ${sourceMeta.badgeClass}`),
    );
    head.append(titleGroup);

    const moneyBox = node('div', '', 'usage-model-cost-group');
    const primaryStr = formatPrimaryMoney(item, current.prefs.currency);
    const secondaryStr = current.prefs.currency === 'USD' ? formatCny(item.costCny) : formatUsd(item.costUsd);
    moneyBox.append(
      node('strong', primaryStr, 'usage-model-cost-primary'),
      node('span', `(${secondaryStr})`, 'meta'),
    );
    head.append(moneyBox);
    card.append(head);

    const sharePct = current.totals.costUsd > 0 ? item.costShare * 100 : item.tokenShare * 100;
    const progressWrap = node('div', '', 'usage-progress-row');
    const progressHead = node('div', '', 'usage-progress-label');
    progressHead.append(
      node('span', `调用 ${formatInt(item.calls)} 次（成功 ${formatInt(item.successCalls)} / 失败 ${formatInt(item.failedCalls)}）`, 'meta'),
      node('span', `费用占比 ${(item.costShare * 100).toFixed(1)}% · Token 占比 ${(item.tokenShare * 100).toFixed(1)}%`, 'meta'),
    );
    const bar = document.createElement('progress');
    bar.className = 'usage-share-progress';
    bar.max = 100;
    bar.value = Math.max(0, Math.min(100, Number(sharePct.toFixed(1))));
    progressWrap.append(progressHead, bar);
    card.append(progressWrap);

    const tokensRow = node('div', '', 'hub-badges-row');
    tokensRow.append(
      node('span', `总 Token: ${formatInt(item.totalTokens)}`, 'hub-meta-chip mono-chip'),
      node('span', `输入: ${formatInt(item.inputTokens)}`, 'hub-meta-chip'),
      node('span', `输出: ${formatInt(item.outputTokens)}`, 'hub-meta-chip'),
    );
    const cacheTotal = item.cacheReadTokens + item.cacheWriteTokens;
    if (cacheTotal > 0) {
      const hitSuffix = item.cacheReadTokens > 0 ? ` · 命中 ${formatPercent(item.cacheHitRate)}` : '';
      const write1hSuffix = item.cacheWrite1hTokens > 0 ? `（含 1h 写 ${formatInt(item.cacheWrite1hTokens)}）` : '';
      tokensRow.append(
        node(
          'span',
          `缓存读/写: ${formatInt(item.cacheReadTokens)} / ${formatInt(item.cacheWriteTokens)}${write1hSuffix}${hitSuffix}`,
          item.cacheReadTokens > 0 ? 'hub-meta-chip usage-cache-chip-hit' : 'hub-meta-chip',
        ),
      );
      if (item.cacheSavingsUsd > 0) {
        tokensRow.append(
          node(
            'span',
            `缓存净省: ${formatPrimarySavings(item, current.prefs.currency)}`,
            'hub-meta-chip usage-cache-chip-savings',
          ),
        );
      } else if (item.cacheSavingsUsd < 0) {
        tokensRow.append(
          node(
            'span',
            `缓写净增: ${formatPrimarySavings({ cacheSavingsUsd: Math.abs(item.cacheSavingsUsd), cacheSavingsCny: Math.abs(item.cacheSavingsCny) }, current.prefs.currency)}`,
            'hub-meta-chip usage-cache-chip-surcharge',
          ),
        );
      }
    }
    if (item.reasoningTokens > 0) {
      tokensRow.append(node('span', `思考(含于输出): ${formatInt(item.reasoningTokens)}`, 'hub-meta-chip'));
    }
    const unitRateText = item.costSource === 'free'
      ? '单价: 免费'
      : item.unitInputUsdPer1M <= 0 && item.unitOutputUsdPer1M <= 0
        ? '单价: 未知'
        : `单价参考: 输 ${formatUnitRate(item.unitInputUsdPer1M)} / 出 ${formatUnitRate(item.unitOutputUsdPer1M)} / 缓读 ${formatUnitRate(item.unitCacheReadUsdPer1M)} / 缓写 ${formatUnitRate(item.unitCacheWriteUsdPer1M)} per 1M`;
    tokensRow.append(node('span', unitRateText, 'hub-meta-chip'));
    if (item.lastUsedAt > 0) {
      tokensRow.append(node('span', `最近调用: ${timestamp(item.lastUsedAt)}`, 'hub-meta-chip'));
    }
    card.append(tokensRow);

    const actorEntries = (Object.entries(item.actors) as Array<[UsageActor, number | undefined]>)
      .filter(([, count]) => typeof count === 'number' && count > 0);
    if (actorEntries.length) {
      const actorRow = node('div', '', 'hub-badges-row');
      actorRow.append(node('span', '角色分布：', 'meta'));
      for (const [actor, count] of actorEntries) {
        actorRow.append(node('span', `${ACTOR_SHORT_LABELS[actor] ?? actor} ×${count}`, 'hub-tag-chip'));
      }
      card.append(actorRow);
    }

    return card;
  }

  function renderActors(current: UsageReportView) {
    const extraActors: UsageActor[] = current.byActor.compaction?.calls ? ['compaction'] : [];
    const actors = [...ACTOR_ORDER, ...extraActors];

    const frag = document.createDocumentFragment();
    for (const actor of actors) {
      const stats = current.byActor[actor];
      const calls = stats?.calls ?? 0;
      const totalTokens = stats?.totalTokens ?? 0;
      const costUsd = stats?.costUsd ?? 0;
      const costCny = stats?.costCny ?? 0;
      const card = node('div', '', `usage-actor-card${calls > 0 ? ' has-calls' : ''}`);
      card.append(
        node('span', ACTOR_LABELS[actor] ?? actor, 'usage-actor-name'),
        node('strong', `${formatInt(calls)} 次`, 'usage-actor-calls'),
        node(
          'span',
          `${formatPrimaryMoney({ costUsd, costCny }, current.prefs.currency)} · ${formatCompact(totalTokens)} tok`,
          'meta',
        ),
      );
      frag.append(card);
    }
    usageActorsGrid.replaceChildren(frag);
  }

  function renderReport(current: UsageReportView) {
    const currency = current.prefs.currency;
    usagePeriodLabel.textContent = current.periodLabel;
    usageTzChip.textContent = formatTimezoneChip(current.tzOffsetMin);
    if (document.activeElement !== usageDateInput) {
      usageDateInput.value = current.anchorDate;
    }
    if (!isEditingWithin(usageRateInput.parentElement ?? usageRateInput)) {
      usageRateInput.value = String(current.prefs.usdToCnyRate);
    }

    const { totals, byModel } = current;
    const tokenSubParts = [
      `输入 ${formatCompact(totals.inputTokens)}`,
      `输出 ${formatCompact(totals.outputTokens)}`,
    ];
    if (totals.cacheReadTokens > 0) {
      tokenSubParts.push(`缓读 ${formatCompact(totals.cacheReadTokens)} (命中 ${formatPercent(totals.cacheHitRate)})`);
    }
    if (totals.cacheWriteTokens > 0) {
      tokenSubParts.push(`缓写 ${formatCompact(totals.cacheWriteTokens)}`);
    }
    if (totals.cacheReadTokens === 0 && totals.cacheWriteTokens === 0) {
      tokenSubParts.push('缓存 0');
    }
    if (totals.reasoningTokens > 0) {
      tokenSubParts.push(`思考 ${formatCompact(totals.reasoningTokens)}`);
    }

    const primaryMoney = formatPrimaryMoney(totals, currency);
    const secondaryMoney = currency === 'USD' ? formatCny(totals.costCny) : formatUsd(totals.costUsd);
    const savingsSub = totals.cacheSavingsUsd > 0
      ? ` · 缓存净省 ${formatPrimarySavings(totals, currency)}`
      : totals.cacheSavingsUsd < 0
        ? ` · 缓写净增 ${formatPrimarySavings({ cacheSavingsUsd: Math.abs(totals.cacheSavingsUsd), cacheSavingsCny: Math.abs(totals.cacheSavingsCny) }, currency)}`
        : '';
    const topModel = byModel[0];
    const topModelValue = topModel ? topModel.model : '—';
    const topModelSub = topModel
      ? (totals.costUsd > 0
          ? `${topModel.provider} · 费用占比 ${(topModel.costShare * 100).toFixed(1)}% · ${formatInt(topModel.calls)} 次`
          : `${topModel.provider} · Token 占比 ${(topModel.tokenShare * 100).toFixed(1)}% · ${formatInt(topModel.calls)} 次`)
      : '当前周期暂无模型调用';

    const kpiFrag = document.createDocumentFragment();
    kpiFrag.append(
      kpiCard(
        '调用次数',
        `${formatInt(totals.calls)} 次`,
        `成功 ${formatInt(totals.successCalls)} · 失败 ${formatInt(totals.failedCalls)}`,
        totals.calls > 0 ? 'accent' : 'default',
      ),
      kpiCard(
        '消耗 Token 总数',
        formatInt(totals.totalTokens),
        tokenSubParts.join(' · '),
        'default',
      ),
      kpiCard(
        '换算金额',
        primaryMoney,
        `约 ${secondaryMoney} · 1 USD = ¥${current.prefs.usdToCnyRate.toFixed(2)}${savingsSub}`,
        totals.costUsd > 0 ? 'positive' : 'default',
      ),
      kpiCard(
        '主力模型',
        topModelValue,
        topModelSub,
        topModel ? 'warning' : 'default',
      ),
    );
    usageKpiGrid.replaceChildren(kpiFrag);

    renderChart(current);
    renderRecentPeriods(current);

    usageModelsSubtitle.textContent = byModel.length ? `共 ${byModel.length} 款模型` : '';
    if (!byModel.length) {
      usageModelsList.replaceChildren(node('p', '当前周期暂无模型调用记录。', 'empty hub-empty-state'));
    } else {
      const modelsFrag = document.createDocumentFragment();
      for (const item of byModel) {
        modelsFrag.append(renderModelCard(item, current));
      }
      usageModelsList.replaceChildren(modelsFrag);
    }

    renderActors(current);
    updateToolbarControls();
  }

  async function fetchReport(silent = false) {
    if (appState.authExpired || !appState.ready) return;
    const seq = ++fetchSeq;
    loading = true;
    if (!silent) {
      setStatusError(undefined);
      updateToolbarControls();
    }
    try {
      const tzOffsetMin = new Date().getTimezoneOffset();
      const params = new URLSearchParams({
        granularity,
        tzOffsetMin: String(tzOffsetMin),
      });
      if (anchorDate) params.set('anchorDate', anchorDate);
      const data = await api<UsageReportView>(`/api/usage?${params.toString()}`);
      if (seq !== fetchSeq) return;
      report = data;
      anchorDate = data.anchorDate;
      setStatusError(undefined);
      renderReport(data);
    } catch (error) {
      if (seq !== fetchSeq) return;
      if (!silent) setStatusError(`加载模型用量统计失败：${errorText(error)}`);
    } finally {
      if (seq === fetchSeq) {
        loading = false;
        updateToolbarControls();
      }
    }
  }

  async function savePreferences(patch: { currency?: UsageCurrency; usdToCnyRate?: number }) {
    if (prefsBusy || appState.authExpired || !appState.ready) return;
    prefsBusy = true;
    setStatusError(undefined);
    updateToolbarControls();
    try {
      const updated = await api<UsagePreferences>('/api/usage-prefs', patch);
      if (report) {
        report = { ...report, prefs: updated };
      }
      if (appState.view?.usageToday) {
        appState.view.usageToday = {
          ...appState.view.usageToday,
          currency: updated.currency,
          usdToCnyRate: updated.usdToCnyRate,
          costCny: appState.view.usageToday.costUsd * updated.usdToCnyRate,
          cacheSavingsCny: (appState.view.usageToday.cacheSavingsUsd ?? 0) * updated.usdToCnyRate,
        };
      }
      render(true);
      await fetchReport(true);
      await hooks.refreshView();
    } catch (error) {
      setStatusError(`保存偏好设置失败：${errorText(error)}`);
    } finally {
      prefsBusy = false;
      updateToolbarControls();
    }
  }

  function submitExchangeRate() {
    const raw = Number(usageRateInput.value);
    if (!Number.isFinite(raw) || raw < 0.1 || raw > 100) {
      setStatusError('汇率须为 0.1 ~ 100 之间的有效数字（例如 7.25）。');
      usageRateInput.focus();
      return;
    }
    void savePreferences({ usdToCnyRate: raw });
  }

  function render(force = false) {
    const today = appState.view?.usageToday;
    if (!today || today.calls <= 0) {
      usageTopBadge.textContent = '0';
      options.onBadgeChange?.({
        calls: 0,
        badgeText: '0',
        moneyText: '',
        detailText: '今日模型调用 0 次',
      });
    } else {
      const primary = today.currency === 'USD' ? formatUsd(today.costUsd) : formatCny(today.costCny);
      const badgeText = `${today.calls}次 · ${primary}`;
      usageTopBadge.textContent = badgeText;
      const cacheBadgeDetail = (today.cacheReadTokens ?? 0) > 0
        ? ` · 缓存命中 ${formatPercent(today.cacheHitRate ?? 0)}${(today.cacheSavingsUsd ?? 0) > 0 ? ` (净省 ${formatPrimarySavings({ cacheSavingsUsd: today.cacheSavingsUsd ?? 0, cacheSavingsCny: today.cacheSavingsCny ?? 0 }, today.currency)})` : ''}`
        : '';
      options.onBadgeChange?.({
        calls: today.calls,
        badgeText,
        moneyText: primary,
        detailText: `今日调用 ${today.calls} 次 · ${formatInt(today.totalTokens)} tokens · ${formatCny(today.costCny)} (${formatUsd(today.costUsd)})${cacheBadgeDetail}`,
      });
    }

    if (!options.isVisible() && !force) {
      return;
    }

    updateToolbarControls();
    if (report) {
      renderReport(report);
    }

    const todayStr = report?.todayDate ?? today?.date ?? localTodayDateString();
    const isViewingToday = !anchorDate || anchorDate === todayStr;
    if (
      !force
      && options.isVisible()
      && isViewingToday
      && !loading
      && !prefsBusy
      && !appState.authExpired
      && appState.ready
      && !isEditingWithin(usagePanelEl)
    ) {
      void fetchReport(true);
    }
  }

  function activate() {
    granularity = 'day';
    anchorDate = undefined;
    setStatusError(undefined);
    updateToolbarControls();
    const todayStr = appState.view?.usageToday?.date ?? localTodayDateString();
    if (report && report.granularity === 'day' && report.anchorDate === todayStr) {
      renderReport(report);
    } else {
      usageKpiGrid.replaceChildren(kpiCard('正在读取', '…', '正在聚合今日模型调用账本'));
    }
    void fetchReport();
  }

  usageRefreshBtn.addEventListener('click', () => { void fetchReport(); });

  for (const [btn, nextGran] of [
    [granDayBtn, 'day'],
    [granWeekBtn, 'week'],
    [granMonthBtn, 'month'],
  ] as const) {
    btn.addEventListener('click', () => {
      if (granularity === nextGran) return;
      granularity = nextGran;
      updateToolbarControls();
      void fetchReport();
    });
  }

  usagePrevBtn.addEventListener('click', () => {
    if (report?.prevAnchorDate) {
      anchorDate = report.prevAnchorDate;
      void fetchReport();
    }
  });
  usageNextBtn.addEventListener('click', () => {
    if (report?.nextAnchorDate) {
      anchorDate = report.nextAnchorDate;
      void fetchReport();
    }
  });
  usageTodayBtn.addEventListener('click', () => {
    anchorDate = undefined;
    void fetchReport();
  });
  usageDateInput.addEventListener('change', () => {
    anchorDate = usageDateInput.value || undefined;
    void fetchReport();
  });

  currCnyBtn.addEventListener('click', () => { void savePreferences({ currency: 'CNY' }); });
  currUsdBtn.addEventListener('click', () => { void savePreferences({ currency: 'USD' }); });
  usageRateSaveBtn.addEventListener('click', submitExchangeRate);
  usageRateInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      submitExchangeRate();
    }
  });

  return {
    activate,
    render,
  };
}

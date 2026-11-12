/**
 * Fund report delivery adapter.
 *
 * WeChat collapses multi-line text into a single paragraph after it leaves our
 * transport, so scheduled fund reports (noon/status/settle) are delivered as:
 *   1. one short text summary (max three lines, no newline-dependent layout), and
 *   2. a Markdown attachment holding the full report byte-for-byte as produced
 *      by the plugin (no re-formatting, no line merging).
 *
 * `plugins/fund-tracker` keeps its own text generation untouched; this module
 * only rewrites the delivery shape, and returns `undefined` for anything that
 * is not a fund report so the caller can fall back to plain text.
 */

export interface PluginReportDelivery {
  /** Attachment file name: english + date, basename-safe. */
  fileName: string;
  /** Full report text, written verbatim. */
  content: string;
  /** Text summary, at most three lines. */
  summary: string;
}

const FUND_REPORT_ACTIONS = new Set(['noon', 'status', 'settle']);

const ACTION_LABELS: Record<string, string> = {
  noon: '午间估值',
  status: '实时状态',
  settle: '晚间结算',
};

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function localDate(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function shortDate(now: Date): string {
  return `${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function amount(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(2)}`;
}

function percent(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Build the three-line summary from the plugin's structured `data.summary`.
 * Returns `undefined` when the required figures are absent, so callers can
 * degrade to the original full-text message instead of sending a wrong digest.
 */
export function buildFundSummary(action: string, data: unknown, now = new Date()): string | undefined {
  if (!FUND_REPORT_ACTIONS.has(action)) return undefined;
  const summary = (data && typeof data === 'object' ? data : undefined) as Record<string, unknown> | undefined;
  if (!summary) return undefined;
  const totalAsset = num(summary.totalAsset);
  const totalDailyPnl = num(summary.totalDailyPnl);
  const dailyPnlPct = num(summary.dailyPnlPct);
  const totalPnl = num(summary.totalPnl);
  const totalPnlPct = num(summary.totalPnlPct);
  if (totalAsset === undefined || totalDailyPnl === undefined || dailyPnlPct === undefined
    || totalPnl === undefined || totalPnlPct === undefined) return undefined;
  const totalCost = num(summary.totalCost);

  const heading = `📊 基金${ACTION_LABELS[action] ?? action} ${shortDate(now)} · 完整明细见附件`;
  const assetLine = totalCost === undefined
    ? `总资产 ${totalAsset.toFixed(2)} 元`
    : `总资产 ${totalAsset.toFixed(2)} 元（成本 ${totalCost.toFixed(2)} 元）`;
  return [
    heading,
    `${assetLine}；当日 ${amount(totalDailyPnl)} 元 (${percent(dailyPnlPct)})`,
    `累计 ${amount(totalPnl)} 元 (${percent(totalPnlPct)})`,
  ].join('\n');
}

/**
 * Decide whether a plugin result should be delivered as summary + attachment.
 * Only `fund-tracker` noon/status/settle reports with structured data qualify.
 */
export function buildFundReportDelivery(input: {
  plugin: string;
  action: string;
  message: string;
  data?: unknown;
  now?: Date;
}): PluginReportDelivery | undefined {
  if (input.plugin !== 'fund-tracker') return undefined;
  if (!FUND_REPORT_ACTIONS.has(input.action)) return undefined;
  if (!input.message.trim()) return undefined;
  const now = input.now ?? new Date();
  const summary = buildFundSummary(input.action, input.data, now);
  if (!summary) return undefined;
  return {
    fileName: `fund-${input.action}-${localDate(now)}.md`,
    content: input.message,
    summary,
  };
}

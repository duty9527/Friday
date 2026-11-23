import { useState } from 'react';
import { cn } from '@/lib/utils';

export interface TrendPoint {
  label: string;
  value: number;
  secondary?: number;
  sublabel?: string;
}

export function TrendLineChart({
  points,
  primaryLabel = '主指标',
  secondaryLabel,
  unit = '',
  emptyText = '暂无趋势数据',
  className,
}: {
  points: readonly TrendPoint[];
  primaryLabel?: string;
  secondaryLabel?: string;
  unit?: string;
  emptyText?: string;
  className?: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!points.length) {
    return (
      <div className={cn('flex h-40 items-center justify-center rounded-lg border bg-muted/20 text-xs text-muted-foreground', className)}>
        {emptyText}
      </div>
    );
  }

  const vals = points.flatMap(p => (p.secondary !== undefined && Number.isFinite(p.secondary) ? [p.value, p.secondary] : [p.value]))
    .filter(Number.isFinite);
  const rawMin = vals.length ? Math.min(...vals) : 0;
  const rawMax = vals.length ? Math.max(...vals) : 1;
  const pad = Math.max((rawMax - rawMin) * 0.15, rawMax === rawMin ? Math.max(1, Math.abs(rawMax) * 0.05) : 0.001);
  const min = rawMin - pad;
  const max = rawMax + pad;
  const span = Math.max(1e-6, max - min);

  const width = 560;
  const height = 168;
  const padL = 12;
  const padR = 12;
  const padT = 16;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const coordX = (idx: number) =>
    points.length === 1 ? padL + plotW / 2 : padL + (idx / (points.length - 1)) * plotW;
  const coordY = (v: number) => padT + plotH - ((v - min) / span) * plotH;

  const primaryPath = points
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${coordX(idx).toFixed(1)} ${coordY(p.value).toFixed(1)}`)
    .join(' ');

  const secondaryPoints = points.filter(p => p.secondary !== undefined && Number.isFinite(p.secondary));
  const secondaryPath = secondaryPoints.length >= 2
    ? points
        .map((p, idx) =>
          p.secondary !== undefined && Number.isFinite(p.secondary)
            ? `${idx === 0 ? 'M' : 'L'} ${coordX(idx).toFixed(1)} ${coordY(p.secondary).toFixed(1)}`
            : null,
        )
        .filter(Boolean)
        .join(' ')
    : '';

  const areaPath = points.length >= 2
    ? `${primaryPath} L ${coordX(points.length - 1).toFixed(1)} ${(padT + plotH).toFixed(1)} L ${coordX(0).toFixed(1)} ${(padT + plotH).toFixed(1)} Z`
    : '';

  const activePoint = hoverIdx !== null ? points[hoverIdx] : points.at(-1);

  return (
    <div className={cn('rounded-lg border bg-card p-3 space-y-2', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <span className="size-2 rounded-full bg-info" />
            {primaryLabel}
          </span>
          {secondaryLabel && secondaryPath && (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <span className="size-2 rounded-full bg-warning" />
              {secondaryLabel}
            </span>
          )}
        </div>
        {activePoint && (
          <div className="font-mono text-[11px] text-muted-foreground">
            <span>{activePoint.label}</span>
            <span className="ms-2 font-semibold text-foreground">
              {activePoint.value.toFixed(2)}{unit}
            </span>
            {activePoint.secondary !== undefined && (
              <span className="ms-2">· {activePoint.secondary.toFixed(2)}{unit}</span>
            )}
          </div>
        )}
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="h-40 w-full overflow-visible">
        <line x1={padL} y1={padT + plotH} x2={width - padR} y2={padT + plotH} stroke="var(--border)" strokeWidth="1" />
        <line x1={padL} y1={padT + plotH / 2} x2={width - padR} y2={padT + plotH / 2} stroke="var(--border)" strokeDasharray="3 3" strokeWidth="1" />
        {areaPath && <path d={areaPath} fill="var(--info)" fillOpacity="0.1" />}
        {secondaryPath && (
          <path d={secondaryPath} fill="none" stroke="var(--warning)" strokeWidth="1.75" strokeDasharray="4 3" />
        )}
        <path d={primaryPath} fill="none" stroke="var(--info)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {points.map((p, idx) => {
          const cx = coordX(idx);
          const cy = coordY(p.value);
          const isHovered = hoverIdx === idx;
          return (
            <g key={`${p.label}-${idx}`}>
              <circle
                cx={cx}
                cy={cy}
                r={isHovered ? 4.5 : 3}
                fill={isHovered ? 'var(--foreground)' : 'var(--info)'}
                stroke="var(--background)"
                strokeWidth="1.5"
                className="cursor-pointer"
                onMouseEnter={() => setHoverIdx(idx)}
                onMouseLeave={() => setHoverIdx(null)}
              />
            </g>
          );
        })}
        <text x={padL} y={height - 6} fill="var(--muted-foreground)" fontSize="10">
          {points[0]?.label}
        </text>
        {points.length > 1 && (
          <text x={width - padR} y={height - 6} textAnchor="end" fill="var(--muted-foreground)" fontSize="10">
            {points.at(-1)?.label}
          </text>
        )}
      </svg>
    </div>
  );
}

export interface BarDatum {
  key: string;
  label: string;
  value: number;
  hint?: string;
}

export function BarSeriesChart({
  items,
  emptyText = '当前周期暂无记录',
  formatValue = (v: number) => String(Math.round(v)),
  className,
}: {
  items: readonly BarDatum[];
  emptyText?: string;
  formatValue?: (v: number) => string;
  className?: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!items.length) {
    return (
      <div className={cn('flex h-36 items-center justify-center rounded-lg border bg-muted/20 text-xs text-muted-foreground', className)}>
        {emptyText}
      </div>
    );
  }
  const max = Math.max(1, ...items.map(i => i.value));
  const hovered = hoverIdx !== null ? items[hoverIdx] : undefined;

  return (
    <div className={cn('rounded-lg border bg-card p-3 space-y-2', className)}>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>分时分布</span>
        <span className="font-mono text-foreground">
          {hovered ? `${hovered.label}: ${hovered.hint ?? formatValue(hovered.value)}` : `峰值 ${formatValue(max)}`}
        </span>
      </div>
      <div className="flex h-28 items-end gap-1 pt-2">
        {items.map((item, idx) => {
          const pct = Math.max(3, Math.round((item.value / max) * 100));
          return (
            <button
              key={item.key}
              type="button"
              title={`${item.label}: ${item.hint ?? formatValue(item.value)}`}
              onMouseEnter={() => setHoverIdx(idx)}
              onMouseLeave={() => setHoverIdx(null)}
              onFocus={() => setHoverIdx(idx)}
              onBlur={() => setHoverIdx(null)}
              className="group flex h-full min-w-0 flex-1 cursor-pointer flex-col items-center justify-end gap-1 outline-none"
            >
              <span
                style={{ height: `${pct}%` }}
                className={cn(
                  'w-full rounded-t-sm transition-colors',
                  hoverIdx === idx ? 'bg-primary' : 'bg-info/75 group-hover:bg-info',
                )}
              />
            </button>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
        <span>{items[0]?.label}</span>
        {items.length > 2 && <span>{items[Math.floor(items.length / 2)]?.label}</span>}
        {items.length > 1 && <span>{items.at(-1)?.label}</span>}
      </div>
    </div>
  );
}

export interface ColumnBarDatum {
  key: string;
  label: string;
  sublabel?: string;
  fullLabel?: string;
  value: number;
  hint?: string;
  clickable?: boolean;
}

export function ColumnBarChart({
  items,
  title = '柱状分布',
  emptyText = '当前周期暂无记录',
  formatValue = (v: number) => String(Math.round(v)),
  onSelect,
  className,
}: {
  items: readonly ColumnBarDatum[];
  title?: string;
  emptyText?: string;
  formatValue?: (v: number) => string;
  onSelect?: (item: ColumnBarDatum, index: number) => void;
  className?: string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (!items.length) {
    return (
      <div className={cn('flex h-44 items-center justify-center rounded-lg border bg-muted/20 text-xs text-muted-foreground', className)}>
        {emptyText}
      </div>
    );
  }

  const rawMax = Math.max(0, ...items.map(i => (Number.isFinite(i.value) ? i.value : 0)));
  const max = rawMax > 0 ? rawMax : 1;
  const hovered = hoverIdx !== null ? items[hoverIdx] : undefined;
  const hasSublabels = items.some(i => Boolean(i.sublabel));
  const hasAnyClickable = Boolean(onSelect && items.some(i => i.clickable));

  const width = 600;
  const padL = 46;
  const padR = 10;
  const padT = 14;
  const padB = hasSublabels ? 36 : 26;
  const height = 160 + padB;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const n = items.length;
  const slotW = plotW / n;
  const barGap = Math.min(8, Math.max(1.5, slotW * 0.24));
  const barW = Math.max(4, Math.min(28, slotW - barGap));

  const showXLabel = (idx: number) => {
    if (n <= 14) return true;
    if (n <= 25) return idx % 3 === 0 || idx === n - 1;
    return idx === 0 || (idx + 1) % 5 === 0 || idx === n - 1;
  };

  return (
    <div className={cn('rounded-lg border bg-card p-3 space-y-2', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span>{title}</span>
          {hasAnyClickable && (
            <span className="text-[11px] opacity-80">· 点击柱体可下钻</span>
          )}
        </div>
        <span className="font-mono text-foreground">
          {hovered
            ? `${hovered.fullLabel ?? hovered.label}：${hovered.hint ?? formatValue(hovered.value)}`
            : rawMax > 0
              ? `峰值 ${formatValue(rawMax)}`
              : '暂无骑行记录'}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-44 w-full overflow-visible select-none"
        role="img"
        aria-label={title}
      >
        <line x1={padL} y1={padT} x2={width - padR} y2={padT} stroke="var(--border)" strokeDasharray="3 3" strokeWidth="1" />
        <line x1={padL} y1={padT + plotH / 2} x2={width - padR} y2={padT + plotH / 2} stroke="var(--border)" strokeDasharray="3 3" strokeWidth="1" />
        <line x1={padL} y1={padT + plotH} x2={width - padR} y2={padT + plotH} stroke="var(--border)" strokeWidth="1" />

        {rawMax > 0 && (
          <>
            <text x={padL - 6} y={padT + 3} textAnchor="end" fill="var(--muted-foreground)" fontSize="10">
              {formatValue(rawMax)}
            </text>
            <text x={padL - 6} y={padT + plotH / 2 + 3} textAnchor="end" fill="var(--muted-foreground)" fontSize="10">
              {formatValue(rawMax / 2)}
            </text>
          </>
        )}
        <text x={padL - 6} y={padT + plotH + 3} textAnchor="end" fill="var(--muted-foreground)" fontSize="10">
          0
        </text>

        {items.map((item, idx) => {
          const val = Number.isFinite(item.value) && item.value > 0 ? item.value : 0;
          const barH = val > 0 ? Math.max(4, (val / max) * plotH) : 2;
          const slotX = padL + idx * slotW;
          const barX = slotX + (slotW - barW) / 2;
          const barY = padT + plotH - barH;
          const centerX = slotX + slotW / 2;
          const isActive = hoverIdx === idx;
          const isClickable = Boolean(onSelect && item.clickable);
          const desc = `${item.fullLabel ?? item.label}: ${item.hint ?? formatValue(item.value)}`;

          return (
            <g
              key={item.key}
              role={isClickable ? 'button' : undefined}
              tabIndex={isClickable ? 0 : undefined}
              aria-label={desc}
              className={isClickable ? 'cursor-pointer outline-none' : 'outline-none'}
              onMouseEnter={() => setHoverIdx(idx)}
              onMouseLeave={() => setHoverIdx(null)}
              onFocus={() => setHoverIdx(idx)}
              onBlur={() => setHoverIdx(null)}
              onClick={isClickable ? () => onSelect?.(item, idx) : undefined}
              onKeyDown={isClickable ? e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect?.(item, idx);
                }
              } : undefined}
            >
              <title>{desc}</title>
              {isActive && (
                <rect
                  x={slotX + 1}
                  y={padT}
                  width={Math.max(2, slotW - 2)}
                  height={plotH}
                  rx={4}
                  fill="var(--muted)"
                  fillOpacity={0.35}
                />
              )}
              <rect
                x={barX}
                y={barY}
                width={barW}
                height={barH}
                rx={2}
                fill={val > 0 ? (isActive ? 'var(--primary)' : 'var(--info)') : 'var(--border)'}
                fillOpacity={val > 0 ? (isActive ? 1 : 0.82) : (isActive ? 0.9 : 0.45)}
              />
              <rect x={slotX} y={padT} width={slotW} height={plotH + padB} fill="transparent" />
              {showXLabel(idx) && (
                <>
                  <text
                    x={centerX}
                    y={padT + plotH + 14}
                    textAnchor="middle"
                    fill={isActive ? 'var(--foreground)' : 'var(--muted-foreground)'}
                    fontSize="10"
                  >
                    {item.label}
                  </text>
                  {item.sublabel && (
                    <text
                      x={centerX}
                      y={padT + plotH + 26}
                      textAnchor="middle"
                      fill="var(--muted-foreground)"
                      fontSize="9"
                    >
                      {item.sublabel}
                    </text>
                  )}
                </>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

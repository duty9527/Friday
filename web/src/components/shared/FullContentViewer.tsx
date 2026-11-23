import { formatNumber, errorText } from '@friday/web/shared/format.js';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CopyIcon,
  Maximize2Icon,
  RefreshCwIcon,
  WrapTextIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { MarkdownContent } from '@/components/MarkdownContent';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export type ViewerBadgeVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'info'
  | 'success'
  | 'warning'
  | 'error';

export interface FullContentPayload {
  title: string;
  subtitle?: string;
  badges?: Array<{
    label: string;
    variant?: ViewerBadgeVariant;
  }>;
  content: string;
  mode?: 'markdown' | 'code' | 'text';
  truncatedHint?: string;
  loadFull?: () => Promise<string>;
}

export function FullContentDialog({
  payload,
  onClose,
}: {
  payload: FullContentPayload | null;
  onClose: () => void;
}) {
  const [loadedText, setLoadedText] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [copied, setCopied] = useState(false);
  const [rawSource, setRawSource] = useState(false);
  const [softWrap, setSoftWrap] = useState(true);

  useEffect(() => {
    setLoadedText(null);
    setLoadingFull(false);
    setLoadError('');
    setCopied(false);
    setRawSource(false);
    setSoftWrap(true);
  }, [payload]);

  const mode = payload?.mode ?? 'text';
  const displayText = loadedText ?? payload?.content ?? '';
  const lineCount = displayText ? displayText.split('\n').length : 0;

  const handleLoadFull = async () => {
    if (!payload?.loadFull || loadingFull) return;
    setLoadingFull(true);
    setLoadError('');
    try {
      const full = await payload.loadFull();
      setLoadedText(full);
    } catch (err) {
      setLoadError(errorText(err));
    } finally {
      setLoadingFull(false);
    }
  };

  const handleCopy = async () => {
    if (!displayText) return;
    try {
      await navigator.clipboard?.writeText(displayText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore clipboard errors
    }
  };

  return (
    <Dialog open={Boolean(payload)} onOpenChange={open => { if (!open) onClose(); }}>
      <DialogPopup
        className="h-[min(84dvh,780px)] max-w-4xl max-sm:h-[88dvh]"
        closeProps={{ 'aria-label': '关闭窗口' }}
      >
        <DialogHeader className="shrink-0 gap-2 border-b pb-3 pe-12">
          <DialogTitle className="break-words text-base leading-snug">
            {payload?.title ?? '完整内容'}
          </DialogTitle>

          {(payload?.subtitle || (payload?.badges && payload.badges.length > 0)) && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {payload?.badges?.map((b, idx) => (
                <Badge key={`${b.label}-${idx}`} size="sm" variant={b.variant ?? 'secondary'}>
                  {b.label}
                </Badge>
              ))}
              {payload?.subtitle && <span className="break-all">{payload.subtitle}</span>}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-xs">
            <span className="font-mono text-[11px] text-muted-foreground">
              {formatNumber(displayText.length)} 字 · {formatNumber(lineCount)} 行
              {loadedText !== null && ' · 已加载未截断全文'}
            </span>

            <div className="flex flex-wrap items-center gap-1.5">
              {payload?.loadFull && loadedText === null && (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  disabled={loadingFull}
                  onClick={() => void handleLoadFull()}
                >
                  <RefreshCwIcon className={cn('size-3', loadingFull && 'animate-spin')} />
                  <span>{loadingFull ? '正在拉取全文…' : '拉取未截断全文'}</span>
                </Button>
              )}

              {mode === 'markdown' && (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => setRawSource(v => !v)}
                >
                  <span>{rawSource ? '渲染预览' : '纯文本源码'}</span>
                </Button>
              )}

              {(mode === 'code' || (mode === 'markdown' && rawSource)) && (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  aria-pressed={softWrap}
                  onClick={() => setSoftWrap(v => !v)}
                >
                  <WrapTextIcon className="size-3" />
                  <span>{softWrap ? '原始横向' : '自动换行'}</span>
                </Button>
              )}

              <Button
                type="button"
                size="xs"
                variant="secondary"
                disabled={!displayText}
                onClick={() => void handleCopy()}
              >
                {copied ? <CheckIcon className="size-3 text-success-foreground" /> : <CopyIcon className="size-3" />}
                <span>{copied ? '已复制' : '复制全文'}</span>
              </Button>
            </div>
          </div>

          {payload?.truncatedHint && loadedText === null && (
            <p className="text-[11px] text-warning-foreground">{payload.truncatedHint}</p>
          )}

          {loadError && (
            <Alert variant="error" className="mt-1">
              <AlertDescription className="flex items-center justify-between gap-2 text-xs">
                <span>拉取全文失败：{loadError}</span>
                {payload?.loadFull && (
                  <Button size="xs" variant="outline" onClick={() => void handleLoadFull()}>
                    重试
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}
        </DialogHeader>

        <div
          data-slot="dialog-panel"
          data-testid="full-content-scroll"
          className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
        >
          {!displayText ? (
            <p className="py-10 text-center text-xs text-muted-foreground">（无内容）</p>
          ) : mode === 'markdown' && !rawSource ? (
            <MarkdownContent text={displayText} mode="assistant" allowCodeModal={false} />
          ) : mode === 'code' || (mode === 'markdown' && rawSource) ? (
            <pre
              className={cn(
                'rounded-lg border bg-code p-3.5 font-mono text-xs leading-relaxed text-code-foreground',
                softWrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto whitespace-pre',
              )}
            >
              <code>{displayText}</code>
            </pre>
          ) : (
            <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground">
              {displayText}
            </div>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

export function ViewFullButton({
  onClick,
  label = '查看完整',
  className,
}: {
  onClick: () => void;
  label?: string;
  className?: string;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className={cn('h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground', className)}
      onClick={e => {
        e.stopPropagation();
        onClick();
      }}
    >
      <Maximize2Icon className="size-3" />
      <span>{label}</span>
    </Button>
  );
}

export function ExpandableText({
  text,
  clampClass = 'line-clamp-2',
  threshold = 90,
  className,
  textClassName,
  onOpenFull,
  openFullLabel = '查看完整',
}: {
  text: string;
  clampClass?: string;
  threshold?: number;
  className?: string;
  textClassName?: string;
  onOpenFull?: () => void;
  openFullLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!text) return null;
  const needsToggle = text.length > threshold || text.includes('\n');

  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <div
        className={cn(
          'break-words',
          (!needsToggle || expanded) ? 'whitespace-pre-wrap' : clampClass,
          textClassName,
        )}
      >
        {text}
      </div>
      {needsToggle && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={e => {
              e.stopPropagation();
              setExpanded(prev => !prev);
            }}
            className="inline-flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {expanded ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
            <span>{expanded ? '收起' : '展开全文'}</span>
          </button>
          {onOpenFull && (
            <ViewFullButton onClick={onOpenFull} label={openFullLabel} />
          )}
        </div>
      )}
    </div>
  );
}

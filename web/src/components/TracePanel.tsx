import type { MemoryCard } from '@friday/view.js';
import { activeStatus, record } from '@friday/web/model.js';
import { formatNumber, profileBadges, statusText, tierBadges } from '@friday/web/shared/format.js';
import type {
  ChainActionNode,
  ChainCategory,
  ChainParamItem,
  ExecutionChainView,
  ExecutionTraceMemoryBrief,
  ExecutionTraceTaskSummary,
} from '@friday/web/trace-chain.js';
import {
  ArrowRightIcon,
  CheckIcon,
  CompassIcon,
  CopyIcon,
  Maximize2Icon,
  Minimize2Icon,
  PinOffIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
  XIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ExpandableText,
  FullContentDialog,
  ViewFullButton,
  type FullContentPayload,
} from '@/components/shared/FullContentViewer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useFriday } from '@/lib/friday-store';
import { cn } from '@/lib/utils';

function formatClock(at: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '00:00:00';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatOffset(offsetMs: number): string {
  const safe = Math.max(0, Number.isFinite(offsetMs) ? offsetMs : 0);
  if (safe < 60_000) return `+${(safe / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(safe / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `+${h}h${m}m`;
  return `+${m}m${s}s`;
}

function formatDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = ((ms % 60_000) / 1000).toFixed(1);
  return `${min}m${sec}s`;
}

function formatTokens(count?: number): string {
  if (count === undefined || !Number.isFinite(count)) return '0';
  return formatNumber(count);
}

function badgeVariantForTone(tone: ChainActionNode['tone'] | string): 'success' | 'info' | 'warning' | 'error' | 'secondary' {
  if (tone === 'ok') return 'success';
  if (tone === 'run') return 'info';
  if (tone === 'warn') return 'warning';
  if (tone === 'err') return 'error';
  return 'secondary';
}

function CopySnippetBtn({ text, label = '复制' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          // ignore
        }
      }}
    >
      {copied ? <CheckIcon className="size-3 text-success-foreground" /> : <CopyIcon className="size-3" />}
      <span>{copied ? '已复制' : label}</span>
    </Button>
  );
}

function ToolParamsView({
  params,
  onOpenFull,
}: {
  params: readonly ChainParamItem[];
  onOpenFull: (payload: FullContentPayload) => void;
}) {
  if (!params.length) {
    return <p className="text-xs text-muted-foreground">本工具调用未传入额外参数。</p>;
  }

  const items: Array<{ key: string; el: React.ReactNode }> = [];
  for (let i = 0; i < params.length; i++) {
    const param = params[i]!;
    if (param.kind === 'diff_old' || param.kind === 'diff_new') {
      const next = params[i + 1];
      if (param.kind === 'diff_old' && next?.kind === 'diff_new') {
        const diffCombined = `--- ${param.label}\n${param.value}\n\n+++ ${next.label}\n${next.value}`;
        items.push({
          key: `diff-${i}`,
          el: (
            <div className="space-y-1.5 rounded-lg border bg-card p-2.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-muted-foreground">文本变更对比</span>
                <ViewFullButton
                  onClick={() =>
                    onOpenFull({
                      title: '文本变更完整对比',
                      content: diffCombined,
                      mode: 'code',
                    })
                  }
                />
              </div>
              <div className="text-[11px] font-mono text-destructive-foreground">- {param.label}</div>
              <pre className="max-h-40 overflow-auto rounded border border-destructive/30 bg-destructive/6 p-2 font-mono text-[11px]">
                {param.value}
              </pre>
              <div className="text-[11px] font-mono text-success-foreground">+ {next.label}</div>
              <pre className="max-h-40 overflow-auto rounded border border-success/30 bg-success/6 p-2 font-mono text-[11px]">
                {next.value}
              </pre>
            </div>
          ),
        });
        i += 1;
        continue;
      }
      items.push({
        key: `diff-single-${i}`,
        el: (
          <div className="space-y-1 rounded-lg border bg-card p-2.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-muted-foreground">{param.label}</span>
              <ViewFullButton
                onClick={() =>
                  onOpenFull({
                    title: param.label,
                    content: param.value,
                    mode: 'code',
                  })
                }
              />
            </div>
            <pre className="max-h-40 overflow-auto rounded border bg-code p-2 font-mono text-[11px]">{param.value}</pre>
          </div>
        ),
      });
      continue;
    }

    if (param.kind === 'code') {
      items.push({
        key: `code-${i}`,
        el: (
          <div className="space-y-1 rounded-lg border bg-card p-2.5 text-xs">
            <div className="flex items-center justify-between gap-1">
              <span className="font-medium text-muted-foreground">{param.label}</span>
              <div className="flex items-center gap-1">
                <ViewFullButton
                  onClick={() =>
                    onOpenFull({
                      title: `参数 · ${param.label}`,
                      content: param.value,
                      mode: 'code',
                    })
                  }
                />
                <CopySnippetBtn text={param.value} />
              </div>
            </div>
            <pre className="max-h-40 overflow-auto rounded border bg-code p-2 font-mono text-[11px]">{param.value}</pre>
          </div>
        ),
      });
    } else if (param.kind === 'path') {
      items.push({
        key: `path-${i}`,
        el: (
          <div className="rounded-lg border bg-card p-2.5 text-xs space-y-1">
            <div className="flex items-center justify-between gap-1">
              <span className="font-medium text-muted-foreground">{param.label}</span>
              <CopySnippetBtn text={param.value} />
            </div>
            <div className="break-all font-mono text-[11px] text-foreground">{param.value}</div>
          </div>
        ),
      });
    } else if (param.kind === 'badge') {
      items.push({
        key: `badge-${i}`,
        el: (
          <div className="flex items-center justify-between gap-2 rounded-lg border bg-card p-2.5 text-xs">
            <span className="font-medium text-muted-foreground">{param.label}</span>
            <Badge size="sm" variant="info">{param.value}</Badge>
          </div>
        ),
      });
    } else {
      const isLongText = param.value.length > 160 || param.value.split('\n').length > 4;
      items.push({
        key: `text-${i}`,
        el: (
          <div className="rounded-lg border bg-card p-2.5 text-xs space-y-1">
            <div className="flex items-center justify-between gap-1">
              <span className="font-medium text-muted-foreground">{param.label}</span>
              {isLongText && (
                <ViewFullButton
                  onClick={() =>
                    onOpenFull({
                      title: `参数 · ${param.label}`,
                      content: param.value,
                      mode: 'text',
                    })
                  }
                />
              )}
            </div>
            <div className="whitespace-pre-wrap break-words text-foreground">{param.value}</div>
          </div>
        ),
      });
    }
  }

  return <div className="space-y-2">{items.map(it => <div key={it.key}>{it.el}</div>)}</div>;
}

function SemanticInspector({
  node,
  chainView,
  onClose,
  onOpenFull,
}: {
  node: ChainActionNode;
  chainView: ExecutionChainView;
  onClose: () => void;
  onOpenFull: (payload: FullContentPayload) => void;
}) {
  const {
    api,
    ready,
    authExpired,
    selection,
    selectTrace,
    setSelectedNodeId,
    operationCache,
    loadOperationOutput,
    jumpMessage,
  } = useFriday();

  const headingRef = useRef<HTMLHeadingElement>(null);

  const opTaskId = node.toolDetail?.taskId ?? node.taskId ?? (selection.type === 'task' ? selection.id : undefined);
  const opId = node.toolDetail?.operationId;
  const cacheKey = opId && opTaskId ? `${opTaskId}:${opId}` : undefined;
  const cachedOp = cacheKey ? operationCache.get(cacheKey) : undefined;

  useEffect(() => {
    if (opId && opTaskId && !cachedOp && ready && !authExpired) {
      void loadOperationOutput(opTaskId, opId);
    }
  }, [authExpired, cachedOp, loadOperationOutput, opId, opTaskId, ready]);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [node.id]);

  const tool = node.toolDetail;
  const llm = node.llmDetail;
  const msg = node.messageDetail;
  const rt = node.routingDetail;

  const finalToolOutput = (cachedOp?.text && cachedOp.text.trim().length > 0) ? cachedOp.text : tool?.resultText;

  const buildInspectorSummaryPayload = (): FullContentPayload | null => {
    if (tool) {
      const content = finalToolOutput || tool.errorText || tool.params.map(p => `${p.label}:\n${p.value}`).join('\n\n');
      return {
        title: `${node.title} · 完整步骤详情`,
        subtitle: `${tool.displayName} (${tool.toolName})`,
        badges: [{ label: node.statusLabel, variant: badgeVariantForTone(node.tone) }],
        content: content || '（无额外文本输出）',
        mode: finalToolOutput ? 'code' : 'text',
        ...(opId && opTaskId && !cachedOp?.text
          ? {
              truncatedHint: tool.resultTruncated ? '当前展示为截取输出，点击可从后台拉取完整执行结果。' : undefined,
              loadFull: async () => {
                const res = await api<Record<string, unknown>>(
                  `/api/operation?taskId=${encodeURIComponent(opTaskId)}&operationId=${encodeURIComponent(opId)}`,
                );
                return String(res.result ?? res.error ?? finalToolOutput ?? '（空）');
              },
            }
          : {}),
      };
    }
    if (llm) {
      const parts: string[] = [];
      if (llm.inputContext) parts.push(`## 输入触发上下文\n\n${llm.inputContext}`);
      if (llm.thinkingText) parts.push(`## 思考摘要\n\n${llm.thinkingText}`);
      if (llm.publicText) parts.push(`## 本轮模型输出\n\n${llm.publicText}`);
      if (llm.errorText) parts.push(`## 异常信息\n\n${llm.errorText}`);
      return {
        title: `${node.title} · 模型调用完整详情`,
        subtitle: `${llm.model ?? '未记录模型'}${llm.provider ? ` · ${llm.provider}` : ''}`,
        badges: [{ label: llm.stopReasonLabel, variant: badgeVariantForTone(node.tone) }],
        content: parts.join('\n\n') || '（无详细文本记录）',
        mode: 'markdown',
        ...(llm.publicTextTruncated ? { truncatedHint: '事件日志中记录的模型正文已被截断保存。' } : {}),
      };
    }
    if (msg) {
      return {
        title: `${node.title} · 消息完整正文`,
        subtitle: `${msg.channelLabel} · ${msg.senderLabel}`,
        content: msg.text || '（无公开文本）',
        mode: 'markdown',
      };
    }
    if (rt) {
      const parts: string[] = [];
      if (rt.promptText) parts.push(`## 任务指令正文\n\n${rt.promptText}`);
      if (rt.contextBrief) parts.push(`## 背景简报\n\n${rt.contextBrief}`);
      if (rt.reportText) parts.push(`## 汇报正文\n\n${rt.reportText}`);
      if (rt.errorText) parts.push(`## 错误说明\n\n${rt.errorText}`);
      return {
        title: rt.kindLabel || `${node.title} · 完整详情`,
        subtitle: rt.targetTaskLabel,
        content: parts.join('\n\n') || rt.summaryItems.map(i => `${i.label}: ${i.value}`).join('\n') || '（空）',
        mode: 'markdown',
      };
    }
    return null;
  };

  return (
    <div id="event-detail" className="flex min-h-0 flex-col border-t bg-card/40">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 ref={headingRef} tabIndex={-1} title={node.title} className="truncate text-xs font-semibold text-foreground outline-none">
            {node.title}
          </h3>
          <Badge size="sm" variant={badgeVariantForTone(node.tone)}>{node.statusLabel}</Badge>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ViewFullButton
            label="全屏"
            onClick={() => {
              const summaryPayload = buildInspectorSummaryPayload();
              if (summaryPayload) onOpenFull(summaryPayload);
            }}
          />
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="inspector-close-btn"
            aria-label="关闭步骤检视器"
            onClick={onClose}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="max-h-96 min-h-0 flex-1" overscrollContain>
        <div className="space-y-4 p-3 text-xs">
          {/* Tool Inspector */}
          {tool && (
            <>
              <section className="space-y-2">
                <div className="font-semibold text-muted-foreground">调用工具</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <strong className="text-sm text-foreground">{tool.displayName}</strong>
                  <Badge size="sm" variant="info" className="font-mono">{tool.toolName}</Badge>
                  <Badge size="sm" variant="secondary">{tool.categoryLabel}</Badge>
                  {tool.exitCode !== undefined && (
                    <Badge size="sm" variant={tool.exitCode === 0 ? 'success' : 'error'}>
                      退出码 {tool.exitCode}
                    </Badge>
                  )}
                </div>
              </section>

              <section className="space-y-2">
                <div className="font-semibold text-muted-foreground">使用参数</div>
                <ToolParamsView params={tool.params} onOpenFull={onOpenFull} />
              </section>

              <section className="space-y-2">
                <div className="font-semibold text-muted-foreground">获取结果</div>
                {tool.errorText && (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-destructive-foreground whitespace-pre-wrap break-words">
                    {tool.errorText}
                  </p>
                )}
                {cachedOp?.loading && <p className="text-muted-foreground">正在读取完整执行结果…</p>}
                {cachedOp?.error && (
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2">
                    <span className="text-destructive-foreground">完整结果读取失败：{cachedOp.error}</span>
                    {opTaskId && opId && (
                      <Button size="xs" variant="outline" onClick={() => void loadOperationOutput(opTaskId, opId)}>
                        重试读取
                      </Button>
                    )}
                  </div>
                )}
                {finalToolOutput ? (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-muted-foreground">
                        {cachedOp?.text ? '完整执行输出' : (tool.resultTruncated ? '执行输出（已截取片段）' : '执行输出')}
                      </span>
                      <div className="flex items-center gap-1">
                        <ViewFullButton
                          onClick={() =>
                            onOpenFull({
                              title: `${tool.displayName} · 完整执行输出`,
                              subtitle: tool.toolName,
                              content: finalToolOutput,
                              mode: 'code',
                              ...(opId && opTaskId && !cachedOp?.text
                                ? {
                                    truncatedHint: tool.resultTruncated ? '当前显示为截取片段，可尝试从后台拉取完整执行输出。' : undefined,
                                    loadFull: async () => {
                                      const res = await api<Record<string, unknown>>(
                                        `/api/operation?taskId=${encodeURIComponent(opTaskId)}&operationId=${encodeURIComponent(opId)}`,
                                      );
                                      return String(res.result ?? res.error ?? finalToolOutput);
                                    },
                                  }
                                : {}),
                            })
                          }
                        />
                        <CopySnippetBtn text={finalToolOutput} label="复制结果" />
                      </div>
                    </div>
                    <pre className="max-h-60 overflow-auto rounded-lg border bg-code p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">
                      {finalToolOutput}
                    </pre>
                  </div>
                ) : !tool.errorText && !cachedOp?.loading && !cachedOp?.error ? (
                  <p className="text-muted-foreground">
                    {activeStatus(node.status) ? '工具仍在执行中，等待返回结果…' : '本工具执行无额外文本输出。'}
                  </p>
                ) : null}
              </section>
            </>
          )}

          {/* LLM Inspector */}
          {llm && (
            <>
              <section className="space-y-2">
                <div className="font-semibold text-muted-foreground">模型与 Token 消耗</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <strong className="text-sm text-foreground">{llm.model ?? '未记录模型'}</strong>
                  {llm.provider && <Badge size="sm" variant="secondary">{llm.provider}</Badge>}
                  {llm.thinkingLevel && <Badge size="sm" variant="info">思考等级 {llm.thinkingLevel}</Badge>}
                  <Badge
                    size="sm"
                    variant={
                      llm.stopReason === 'error' || llm.stopReason === 'aborted'
                        ? 'error'
                        : llm.stopReason === 'length'
                          ? 'warning'
                          : 'success'
                    }
                  >
                    {llm.stopReasonLabel}
                  </Badge>
                </div>
                {llm.usage && (
                  <div className="flex flex-wrap gap-1.5">
                    {llm.usage.input !== undefined && <Badge size="sm" variant="outline">输入 {formatTokens(llm.usage.input)}</Badge>}
                    {llm.usage.cacheRead !== undefined && llm.usage.cacheRead > 0 && (
                      <Badge size="sm" variant="outline">缓存读取 {formatTokens(llm.usage.cacheRead)}</Badge>
                    )}
                    {llm.usage.reasoning !== undefined && llm.usage.reasoning > 0 && (
                      <Badge size="sm" variant="outline">推理 {formatTokens(llm.usage.reasoning)}</Badge>
                    )}
                    {llm.usage.output !== undefined && <Badge size="sm" variant="outline">输出 {formatTokens(llm.usage.output)}</Badge>}
                    {llm.usage.totalTokens !== undefined && <Badge size="sm" variant="outline">总计 {formatTokens(llm.usage.totalTokens)}</Badge>}
                    {llm.usage.costUsd !== undefined && llm.usage.costUsd > 0 && (
                      <Badge size="sm" variant="outline">估算费用 ${llm.usage.costUsd.toFixed(4)}</Badge>
                    )}
                  </div>
                )}
                {llm.errorText && (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-destructive-foreground whitespace-pre-wrap break-words">
                    {llm.errorText}
                  </p>
                )}
              </section>

              {llm.inputContext && (
                <section className="space-y-1.5">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-semibold text-muted-foreground">输入触发上下文</span>
                    <div className="flex items-center gap-1">
                      <ViewFullButton
                        onClick={() =>
                          onOpenFull({
                            title: '输入触发完整上下文',
                            subtitle: llm.model ?? undefined,
                            content: llm.inputContext!,
                            mode: 'text',
                          })
                        }
                      />
                      <CopySnippetBtn text={llm.inputContext} />
                    </div>
                  </div>
                  <div className="max-h-40 overflow-y-auto rounded-lg border bg-background p-2.5 whitespace-pre-wrap break-words">{llm.inputContext}</div>
                </section>
              )}

              {llm.thinkingText && (
                <section className="space-y-1.5">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-semibold text-muted-foreground">思考摘要</span>
                    <div className="flex items-center gap-1">
                      <ViewFullButton
                        onClick={() =>
                          onOpenFull({
                            title: '完整思考过程',
                            subtitle: llm.model ?? undefined,
                            content: llm.thinkingText!,
                            mode: 'markdown',
                          })
                        }
                      />
                      <CopySnippetBtn text={llm.thinkingText} />
                    </div>
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded-lg border bg-muted/35 p-2.5 whitespace-pre-wrap break-words text-muted-foreground">
                    {llm.thinkingText}
                  </div>
                </section>
              )}

              {llm.publicText && (
                <section className="space-y-1.5">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-semibold text-muted-foreground">
                      {llm.publicTextTruncated ? '本轮模型输出（已截取）' : '本轮模型输出'}
                    </span>
                    <div className="flex items-center gap-1">
                      <ViewFullButton
                        onClick={() =>
                          onOpenFull({
                            title: '本轮模型完整输出',
                            subtitle: llm.model ?? undefined,
                            content: llm.publicText!,
                            mode: 'markdown',
                            ...(llm.publicTextTruncated ? { truncatedHint: '事件日志保存的是截取后的模型输出摘要。' } : {}),
                          })
                        }
                      />
                      <CopySnippetBtn text={llm.publicText} />
                    </div>
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded-lg border bg-background p-2.5 whitespace-pre-wrap break-words">
                    {llm.publicText}
                  </div>
                </section>
              )}

              {llm.toolDecisions.length > 0 && (
                <section className="space-y-1.5">
                  <div className="font-semibold text-muted-foreground">
                    本轮工具调用决策 ({llm.toolDecisions.length})
                  </div>
                  <div className="space-y-1.5">
                    {llm.toolDecisions.map((dec, idx) => {
                      const targetNode = dec.spanId
                        ? (chainView.nodes.find(n => n.id === dec.spanId) ?? chainView.nodes.find(n => n.id.endsWith(`:${dec.spanId}`)))
                        : undefined;
                      return (
                        <button
                          key={`${dec.toolName}-${idx}`}
                          type="button"
                          disabled={!targetNode}
                          className="tool-decision-btn flex w-full cursor-pointer flex-col items-start gap-1 rounded-lg border bg-background p-2 text-start transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-60"
                          onClick={() => targetNode && setSelectedNodeId(targetNode.id)}
                        >
                          <div className="flex w-full items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5">
                              <strong className="text-foreground">{dec.displayName}</strong>
                              <Badge size="sm" variant="info" className="font-mono">{dec.toolName}</Badge>
                            </div>
                            {targetNode && <Badge size="sm" variant="outline">跳转检视 →</Badge>}
                          </div>
                          {dec.summary && <p className="text-muted-foreground whitespace-pre-wrap break-words">{dec.summary}</p>}
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}
            </>
          )}

          {/* Message Inspector */}
          {msg && (
            <>
              <section className="space-y-2">
                <div className="font-semibold text-muted-foreground">消息来源与归属</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge size="sm" variant="info">{msg.channelLabel}</Badge>
                  <Badge size="sm" variant="secondary">{msg.senderLabel}</Badge>
                  {msg.speakerLabel && <Badge size="sm" variant="success">🎙️ {msg.speakerLabel}</Badge>}
                  <Button type="button" size="xs" variant="outline" onClick={() => void jumpMessage(msg.messageId)}>
                    定位到主对话
                  </Button>
                </div>
                {msg.sessionNote && <div className="rounded-lg border bg-background p-2.5">{msg.sessionNote}</div>}
              </section>

              <section className="space-y-1.5">
                <div className="flex items-center justify-between gap-1">
                  <span className="font-semibold text-muted-foreground">消息完整正文</span>
                  <div className="flex items-center gap-1">
                    {msg.text && (
                      <ViewFullButton
                        onClick={() =>
                          onOpenFull({
                            title: '消息完整正文',
                            subtitle: `${msg.channelLabel} · ${msg.senderLabel}`,
                            content: msg.text!,
                            mode: 'markdown',
                          })
                        }
                      />
                    )}
                    {msg.text && <CopySnippetBtn text={msg.text} label="复制正文" />}
                  </div>
                </div>
                <div className="max-h-56 overflow-y-auto rounded-lg border bg-background p-2.5 whitespace-pre-wrap break-words">
                  {msg.text || '（无公开文本）'}
                </div>
              </section>
            </>
          )}

          {/* Routing Inspector */}
          {rt && (
            <>
              <section className="space-y-2">
                <div className="font-semibold text-muted-foreground">{rt.kindLabel || '路由与质检详情'}</div>
                {rt.targetTaskId && (selection.type !== 'task' || selection.id !== rt.targetTaskId) && (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => selectTrace({ type: 'task', id: rt.targetTaskId!, label: rt.targetTaskLabel ?? '关联工作' }, true)}
                  >
                    <span>打开关联工作：{rt.targetTaskLabel ?? '关联工作'}</span>
                    <ArrowRightIcon className="size-3" />
                  </Button>
                )}
                {rt.summaryItems.length > 0 && (
                  <div className="divide-y rounded-lg border bg-background">
                    {rt.summaryItems.map((item, idx) => (
                      <div key={idx} className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                        <span className="text-muted-foreground">{item.label}</span>
                        <span className="font-medium text-foreground text-end">{item.value}</span>
                      </div>
                    ))}
                  </div>
                )}
                {rt.errorText && (
                  <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-2 text-destructive-foreground whitespace-pre-wrap break-words">
                    {rt.errorText}
                  </p>
                )}
              </section>
              {rt.promptText && (
                <section className="space-y-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-semibold text-muted-foreground">任务指令正文</span>
                    <div className="flex items-center gap-1">
                      <ViewFullButton
                        onClick={() =>
                          onOpenFull({
                            title: '任务指令完整正文',
                            content: rt.promptText!,
                            mode: 'text',
                          })
                        }
                      />
                      <CopySnippetBtn text={rt.promptText} />
                    </div>
                  </div>
                  <div className="max-h-40 overflow-y-auto rounded-lg border bg-background p-2.5 whitespace-pre-wrap break-words">{rt.promptText}</div>
                </section>
              )}
              {rt.contextBrief && (
                <section className="space-y-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-semibold text-muted-foreground">背景简报</span>
                    <div className="flex items-center gap-1">
                      <ViewFullButton
                        onClick={() =>
                          onOpenFull({
                            title: '完整背景简报',
                            content: rt.contextBrief!,
                            mode: 'text',
                          })
                        }
                      />
                      <CopySnippetBtn text={rt.contextBrief} />
                    </div>
                  </div>
                  <div className="max-h-40 overflow-y-auto rounded-lg border bg-background p-2.5 whitespace-pre-wrap break-words">{rt.contextBrief}</div>
                </section>
              )}
              {rt.reportText && (
                <section className="space-y-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-semibold text-muted-foreground">汇报正文</span>
                    <div className="flex items-center gap-1">
                      <ViewFullButton
                        onClick={() =>
                          onOpenFull({
                            title: '完整汇报正文',
                            content: rt.reportText!,
                            mode: 'markdown',
                          })
                        }
                      />
                      <CopySnippetBtn text={rt.reportText} label="复制汇报" />
                    </div>
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded-lg border bg-background p-2.5 whitespace-pre-wrap break-words">{rt.reportText}</div>
                </section>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function WorkDetailOverview({
  chainView,
  onOpenFull,
}: {
  chainView: ExecutionChainView;
  onOpenFull: (payload: FullContentPayload) => void;
}) {
  const {
    api,
    selection,
    traceBundle,
    workData,
    works,
    stopRequests,
    stopWork,
    resumeWork,
    refreshSelectedWork,
    authExpired,
  } = useFriday();

  const [resuming, setResuming] = useState(false);

  if (selection.type !== 'task') {
    return <div id="work-detail" hidden />;
  }

  const taskId = selection.id;
  const bundleTask: Partial<ExecutionTraceTaskSummary> | undefined =
    traceBundle.scope.type === 'task' && traceBundle.scope.id === taskId ? traceBundle.task : undefined;
  const workRec = workData ? record(workData) : undefined;
  const viewWork = works.find(w => w.id === taskId);

  const status = bundleTask?.status ?? (typeof workRec?.status === 'string' ? workRec.status : undefined) ?? viewWork?.status;
  if (!status) {
    return (
      <div id="work-detail" className="border-b px-3 py-2 text-xs text-muted-foreground">
        正在读取任务执行总览…
      </div>
    );
  }

  const prompt = bundleTask?.prompt ?? (typeof workRec?.prompt === 'string' ? workRec.prompt : undefined) ?? viewWork?.prompt ?? selection.label;
  const cwd = bundleTask?.cwd ?? (typeof workRec?.cwd === 'string' ? workRec.cwd : undefined) ?? viewWork?.cwd;
  const profile = bundleTask?.profile ?? (typeof workRec?.profile === 'string' ? workRec.profile : undefined) ?? viewWork?.profile;
  const workerModel = bundleTask?.workerModel ?? (typeof workRec?.workerModel === 'string' ? workRec.workerModel : undefined) ?? viewWork?.workerModel;
  const modelTier = bundleTask?.modelTier ?? (typeof workRec?.modelTier === 'string' ? workRec.modelTier : undefined) ?? viewWork?.modelTier;
  const thinkingLevel = bundleTask?.thinkingLevel ?? (typeof workRec?.thinkingLevel === 'string' ? workRec.thinkingLevel : undefined) ?? viewWork?.thinkingLevel;
  const activeMs = bundleTask?.activeMs ?? (typeof workRec?.activeMs === 'number' ? workRec.activeMs : undefined) ?? viewWork?.activeMs;
  const pendingQuestion = bundleTask?.pendingQuestion ?? viewWork?.pendingQuestion;
  const reason = bundleTask?.reason ?? (typeof workRec?.reason === 'string' ? workRec.reason : undefined) ?? viewWork?.reason;
  const report = bundleTask?.report ?? (typeof workRec?.report === 'string' ? workRec.report : undefined);
  const contextBrief = bundleTask?.contextBrief ?? (typeof workRec?.contextBrief === 'string' ? workRec.contextBrief : undefined);
  const memories: ExecutionTraceMemoryBrief[] = bundleTask?.memories ?? [];
  const statusLabel = pendingQuestion ? '⏳ 等待拍板' : statusText(status);
  const requestedStop = stopRequests.has(`task:${taskId}`);
  const isActive = activeStatus(status);

  return (
    <div id="work-detail" className="border-b bg-card/50 px-3 py-2.5 space-y-2">
      <div className="work-overview-head flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <ExpandableText
            text={prompt || '后台工作'}
            clampClass="line-clamp-2"
            threshold={64}
            textClassName="text-xs font-semibold text-foreground"
            onOpenFull={() =>
              onOpenFull({
                title: '任务完整指令与总览',
                badges: [{ label: statusLabel }],
                subtitle: cwd ? `工作目录：${cwd}` : undefined,
                content: [
                  prompt || '后台工作',
                  cwd ? `\n工作目录：${cwd}` : '',
                  reason ? `\n状态说明：${reason}` : '',
                ].filter(Boolean).join('\n'),
                mode: 'text',
              })
            }
          />
          {cwd && <p title={cwd} className="truncate font-mono text-[11px] text-muted-foreground">{cwd}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {status === 'paused' && (
            <Button
              type="button"
              size="xs"
              variant="default"
              disabled={resuming}
              onClick={async () => {
                setResuming(true);
                await resumeWork(taskId);
                setResuming(false);
              }}
            >
              <PlayIcon className="size-3" />
              <span>确认继续运行此工作</span>
            </Button>
          )}
          {isActive && (
            <Button
              type="button"
              size="xs"
              variant="destructive-outline"
              disabled={requestedStop || authExpired}
              onClick={() => void stopWork(taskId)}
            >
              <SquareIcon className="size-2.5 fill-current" />
              <span>{requestedStop ? '停止中…' : '停止'}</span>
            </Button>
          )}
          <Button type="button" size="xs" variant="ghost" onClick={refreshSelectedWork} aria-label="刷新任务详情">
            <RefreshCwIcon className="size-3" />
          </Button>
        </div>
      </div>

      <div className="work-metrics-strip flex flex-wrap gap-1.5">
        <Badge
          className="work-metric-pill"
          size="sm"
          variant={pendingQuestion ? 'warning' : status === 'completed' ? 'success' : status === 'failed' ? 'error' : isActive ? 'info' : 'secondary'}
        >
          {statusLabel}
        </Badge>
        {profile && (
          <Badge className="work-metric-pill" size="sm" variant="outline">
            {profileBadges[profile] ?? profile}
          </Badge>
        )}
        {(workerModel || modelTier) && (
          <Badge className="work-metric-pill font-mono" size="sm" variant="outline">
            {workerModel ? `${workerModel}${thinkingLevel ? `@${thinkingLevel}` : ''}` : (tierBadges[modelTier!] ?? modelTier)}
          </Badge>
        )}
        {activeMs !== undefined && (
          <Badge className="work-metric-pill font-mono" size="sm" variant="outline">
            耗时 {formatDuration(activeMs)}
          </Badge>
        )}
        <Badge className="work-metric-pill font-mono" size="sm" variant="secondary">
          {chainView.nodes.length} 步
        </Badge>
      </div>

      {reason && <p className="text-[11px] text-muted-foreground whitespace-pre-wrap break-words">{reason}</p>}
      {(contextBrief || report || memories.length > 0) && (
        <details className="text-xs">
          <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground hover:text-foreground">
            展开任务简报 / 汇报 / 记忆 ({memories.length})
          </summary>
          <div className="mt-2 space-y-2">
            {contextBrief && (
              <div className="space-y-1 rounded border bg-background p-2 text-[11px]">
                <div className="flex items-center justify-between gap-1">
                  <span className="font-medium text-muted-foreground">任务背景简报</span>
                  <ViewFullButton
                    onClick={() =>
                      onOpenFull({
                        title: '任务完整背景简报',
                        content: contextBrief,
                        mode: 'markdown',
                      })
                    }
                  />
                </div>
                <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">{contextBrief}</div>
              </div>
            )}
            {report && (
              <div className="space-y-1 rounded border bg-background p-2 text-[11px]">
                <div className="flex items-center justify-between gap-1">
                  <span className="font-medium text-muted-foreground">已交付总结报告</span>
                  <ViewFullButton
                    onClick={() =>
                      onOpenFull({
                        title: 'Worker 完整总结报告',
                        content: report,
                        mode: 'markdown',
                      })
                    }
                  />
                </div>
                <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">{report}</div>
              </div>
            )}
            {memories.length > 0 && (
              <div className="space-y-1">
                {memories.map(m => (
                  <div key={m.id} className="rounded border bg-background px-2 py-1.5 text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">{m.topic}</span>
                      <ViewFullButton
                        onClick={() =>
                          onOpenFull({
                            title: `挂载记忆 · ${m.topic}`,
                            badges: m.tags?.map(t => ({ label: t, variant: 'secondary' as const })),
                            content: m.preview,
                            mode: 'markdown',
                            loadFull: async () => {
                              const list = await api<MemoryCard[]>('/api/memories');
                              const found = Array.isArray(list) ? list.find(c => c.id === m.id) : undefined;
                              return found?.content ?? m.preview;
                            },
                          })
                        }
                      />
                    </div>
                    <div className="text-muted-foreground whitespace-pre-wrap break-words">{m.preview}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

export function TracePanel() {
  const {
    rightCollapsed,
    selection,
    selectionPinned,
    unpinTraceToLatest,
    traceCategory,
    setTraceCategory,
    traceWide,
    setTraceWide,
    chainView,
    selectedNodeId,
    setSelectedNodeId,
    traceHasMore,
    traceBusy,
    loadEarlierTrace,
    mobilePanel,
  } = useFriday();

  const [viewerPayload, setViewerPayload] = useState<FullContentPayload | null>(null);

  const visibleNodes = useMemo(
    () => (traceCategory === 'all' ? chainView.nodes : chainView.nodes.filter(n => n.category === traceCategory)),
    [chainView.nodes, traceCategory],
  );

  const selectedNode = useMemo(
    () => (selectedNodeId ? chainView.nodes.find(n => n.id === selectedNodeId) : undefined),
    [chainView.nodes, selectedNodeId],
  );

  const scopeLabel = selection.type === 'all'
    ? '全局最新轨迹'
    : selection.type === 'task'
      ? `任务 · ${selection.label}`
      : `消息 · ${selection.label}`;

  const categoryTabs: Array<{ id: string; cat: ChainCategory; label: string; count: number }> = [
    { id: 'step-mode', cat: 'all', label: '全链路', count: chainView.stats.total },
    { id: 'filter-msg-mode', cat: 'message', label: '消息', count: chainView.stats.message },
    { id: 'graph-mode', cat: 'llm', label: '模型', count: chainView.stats.llm },
    { id: 'timeline-mode', cat: 'tool', label: '工具', count: chainView.stats.tool },
    { id: 'filter-route-mode', cat: 'routing', label: '路由', count: chainView.stats.routing },
  ];

  // Hidden on desktop when rightCollapsed, or on mobile when mobilePanel === 'chat'
  const showDesktop = !rightCollapsed;
  const showMobile = mobilePanel === 'trace';

  return (
    <aside
      aria-label="执行链路"
      className={cn(
        'flex h-full min-h-0 flex-col border-s bg-background',
        showMobile ? 'flex w-full lg:w-auto' : 'hidden',
        showDesktop
          ? (traceWide ? 'lg:flex lg:w-[34rem] xl:w-[40rem]' : 'lg:flex lg:w-88 xl:w-[27rem]')
          : 'lg:hidden',
      )}
    >
      {/* Trace Header */}
      <div className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="text-xs font-semibold tracking-tight text-foreground">执行链路</h2>
            {selectionPinned && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                title="取消固定，恢复自动跟随最新消息"
                onClick={unpinTraceToLatest}
              >
                <PinOffIcon className="size-3" />
                <span>取消固定</span>
              </Button>
            )}
          </div>
          <p id="trace-scope" className="truncate text-[11px] text-muted-foreground" title={scopeLabel}>
            {scopeLabel}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            id="open-mindmap-trace"
            size="xs"
            variant="outline"
            render={<a href="/mindmap" />}
            title="打开全息思考流程图"
          >
            <CompassIcon className="size-3.5" />
            <span>思考流程图</span>
          </Button>
          <Button
            id="trace-wide-toggle"
            type="button"
            size="icon-xs"
            variant={traceWide ? 'secondary' : 'ghost'}
            aria-pressed={traceWide}
            aria-label="加宽执行链路面板"
            className="hidden lg:inline-flex"
            onClick={() => setTraceWide(!traceWide)}
          >
            {traceWide ? <Minimize2Icon className="size-3.5" /> : <Maximize2Icon className="size-3.5" />}
          </Button>
        </div>
      </div>

      {/* Selected Work Overview */}
      <WorkDetailOverview chainView={chainView} onOpenFull={setViewerPayload} />

      {/* Category Tabs */}
      <div className="trace-tabs flex shrink-0 items-center gap-1 overflow-x-auto border-b px-3 py-1.5" role="group" aria-label="链路节点筛选">
        {categoryTabs.map(tab => {
          const pressed = traceCategory === tab.cat;
          return (
            <button
              key={tab.id}
              id={tab.id}
              type="button"
              aria-pressed={pressed}
              onClick={() => setTraceCategory(tab.cat)}
              className={cn(
                'inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors',
                pressed
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <span>{tab.label}</span>
              <span className={cn('font-mono text-[10px]', pressed ? 'opacity-80' : 'text-muted-foreground')}>
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Timeline List */}
      <ScrollArea className="min-h-0 flex-1" overscrollContain>
        <div id="trace-content" className="space-y-1.5 p-2.5">
          {traceHasMore && (
            <div className="flex justify-center pb-1">
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={traceBusy}
                onClick={() => void loadEarlierTrace()}
              >
                {traceBusy ? '加载中…' : '加载更早链路事件'}
              </Button>
            </div>
          )}

          {visibleNodes.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted-foreground">
              暂无可展示的链路节点。发送消息或点选左侧任务即可实时查看。
            </div>
          ) : (
            visibleNodes.map(node => {
              const isSelected = selectedNodeId === node.id;
              const startPct = Math.max(0, Math.min(96, node.waterfallStartPermille / 10));
              const widthPct = Math.max(4, Math.min(100 - startPct, node.waterfallWidthPermille / 10));

              return (
                <button
                  key={node.id}
                  type="button"
                  onClick={() => setSelectedNodeId(isSelected ? undefined : node.id)}
                  className={cn(
                    `chain-card cat-${node.category} tone-${node.tone}`,
                    'flex w-full cursor-pointer flex-col gap-1 rounded-lg border px-2.5 py-2 text-start transition-colors',
                    isSelected
                      ? 'border-ring bg-accent/70'
                      : 'border-border/60 bg-card hover:bg-accent/40',
                  )}
                >
                  <div className="flex w-full items-center justify-between gap-2 text-[10px] text-muted-foreground">
                    <div className="flex items-center gap-1.5 font-mono">
                      <span className="chain-clock">{formatClock(node.at)}</span>
                      <span className="chain-offset">{formatOffset(node.offsetMs)}</span>
                      {node.durationMs !== undefined && <span>· {formatDuration(node.durationMs)}</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      <Badge size="sm" variant="outline">{node.actorLabel}</Badge>
                      <Badge size="sm" variant={badgeVariantForTone(node.tone)}>{node.statusLabel}</Badge>
                    </div>
                  </div>

                  <div className="chain-title line-clamp-1 text-xs font-medium text-foreground">
                    {node.title}
                  </div>

                  {node.subtitle && (
                    <div className="line-clamp-1 text-[11px] text-muted-foreground">
                      {node.subtitle}
                    </div>
                  )}

                  {node.preview && (
                    <div className="line-clamp-2 text-[11px] text-muted-foreground/90">
                      {node.preview}
                    </div>
                  )}

                  <svg
                    className="chain-waterfall mt-0.5 h-1.5 w-full overflow-visible"
                    viewBox="0 0 100 4"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <rect className="wf-track" x="0" y="0" width="100" height="4" rx="2" />
                    <rect className="wf-bar" x={startPct.toFixed(2)} y="0" width={widthPct.toFixed(2)} height="4" rx="2" />
                  </svg>
                </button>
              );
            })
          )}
        </div>
      </ScrollArea>

      {/* Semantic Inspector Drawer */}
      {selectedNode ? (
        <SemanticInspector
          node={selectedNode}
          chainView={chainView}
          onClose={() => setSelectedNodeId(undefined)}
          onOpenFull={setViewerPayload}
        />
      ) : (
        <div id="event-detail" hidden />
      )}

      <FullContentDialog payload={viewerPayload} onClose={() => setViewerPayload(null)} />
    </aside>
  );
}

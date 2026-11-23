import type { MemoryCard } from '@friday/view.js';
import { activeStatus, routeLabel, routeState } from '@friday/web/model.js';
import { formatActionShortLabel } from '@friday/web/shared/chat-view.js';
import { ArrowUpRightIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import {
  ExpandableText,
  FullContentDialog,
  ViewFullButton,
  type FullContentPayload,
} from '@/components/shared/FullContentViewer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { useFriday } from '@/lib/friday-store';

export function RoutingDetailDialog() {
  const {
    api,
    routingDetailMessageId,
    setRoutingDetailMessageId,
    messagesMap,
    selectTrace,
    setMobilePanel,
    jumpMessage,
  } = useFriday();

  const [viewerPayload, setViewerPayload] = useState<FullContentPayload | null>(null);

  const message = routingDetailMessageId ? messagesMap.get(routingDetailMessageId) : undefined;
  const open = Boolean(message);
  const routing = message?.routing;
  const isActive = message ? activeStatus(message.status) : false;

  return (
    <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) setRoutingDetailMessageId(null); }}>
      <DialogPopup
        id="routing-detail"
        showCloseButton={false}
        className="max-h-[min(84dvh,780px)] max-w-2xl max-sm:max-h-[88dvh]"
        hidden={!open}
      >
        <DialogHeader className="flex-row items-center justify-between border-b pb-3">
          <div className="flex min-w-0 items-center gap-2">
            <DialogTitle className="text-base">分配记录与当时上下文</DialogTitle>
            {routing && (
              <Badge
                size="sm"
                variant={
                  routing.status === 'completed'
                    ? 'success'
                    : routing.status === 'failed' || routing.status === 'interrupted'
                      ? 'error'
                      : 'info'
                }
              >
                {routing.status}
              </Badge>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="关闭分配详情"
            onClick={() => setRoutingDetailMessageId(null)}
          >
            <XIcon className="size-4" />
          </Button>
        </DialogHeader>

        <DialogPanel className="space-y-4">
          {message && (
            <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-foreground">对应消息</span>
                <ViewFullButton
                  onClick={() =>
                    setViewerPayload({
                      title: '对应消息完整正文',
                      content: message.text,
                      mode: 'markdown',
                    })
                  }
                />
              </div>
              <ExpandableText text={message.text} clampClass="line-clamp-3" threshold={120} />
            </div>
          )}

          {!routing ? (
            <p className="text-sm text-muted-foreground">
              {isActive ? 'F.R.I.D.A.Y. 正在处理并记录路由分配…' : '此历史消息未采集路由摘要；不从回复正文猜测。'}
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">已记录的路由动作</div>
                {routing.actions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">本次处理没有额外调度动作。</p>
                ) : (
                  <div className="space-y-2">
                    {routing.actions.map(action => (
                      <div key={action.id} className="rounded-lg border bg-card p-3 text-xs space-y-1.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-foreground">{routeLabel(action)}</span>
                            <Badge
                              size="sm"
                              variant={
                                action.status === 'accepted'
                                  ? 'success'
                                  : action.status === 'failed'
                                    ? 'error'
                                    : 'secondary'
                              }
                            >
                              {routeState(action)}
                            </Badge>
                            {action.workerProfile && <Badge size="sm" variant="outline">{action.workerProfile}</Badge>}
                            {action.workerModel && <Badge size="sm" variant="outline">{action.workerModel}</Badge>}
                          </div>
                          {action.taskId && (
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              onClick={() => {
                                selectTrace({
                                  type: 'task',
                                  id: action.taskId!,
                                  label: action.taskLabel || formatActionShortLabel(action),
                                }, true);
                                setMobilePanel('trace');
                                setRoutingDetailMessageId(null);
                              }}
                            >
                              <span>查看任务</span>
                              <ArrowUpRightIcon className="size-3" />
                            </Button>
                          )}
                        </div>
                        {action.summary && (
                          <p className="whitespace-pre-wrap text-muted-foreground">{action.summary}</p>
                        )}
                        {action.error && (
                          <p className="whitespace-pre-wrap text-destructive-foreground">{action.error}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <details className="routing-facts rounded-lg border bg-muted/25 p-3 text-xs">
                <summary className="cursor-pointer font-medium text-foreground">
                  路由时的快照上下文（点击展开）
                </summary>
                <div className="mt-3 space-y-3">
                  <div>
                    <div className="mb-1 font-medium text-foreground">
                      当时可见的工作（{routing.context.works.length} / {routing.context.totalWorks}）
                    </div>
                    {routing.context.works.length === 0 ? (
                      <p className="text-muted-foreground">当时无可见后台工作。</p>
                    ) : (
                      <ul className="space-y-1">
                        {routing.context.works.map(w => (
                          <li key={w.id} className="flex items-start justify-between gap-2 rounded border bg-background px-2 py-1.5">
                            <div className="min-w-0 flex-1">
                              <ExpandableText
                                text={w.prompt}
                                clampClass="line-clamp-2"
                                threshold={80}
                                onOpenFull={() =>
                                  setViewerPayload({
                                    title: '关联后台工作完整指令',
                                    badges: [{ label: w.status }],
                                    content: w.prompt,
                                    mode: 'text',
                                  })
                                }
                              />
                            </div>
                            <Badge size="sm" variant="secondary" className="shrink-0">{w.status}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <div className="mb-1 font-medium text-foreground">
                      当时的近期对话引用（{routing.context.messages.length}）
                    </div>
                    {routing.context.messages.length === 0 ? (
                      <p className="text-muted-foreground">当时无近期对话引用。</p>
                    ) : (
                      <ul className="space-y-1">
                        {routing.context.messages.map(m => (
                          <li key={m.id} className="flex items-center justify-between gap-2 rounded border bg-background px-2 py-1">
                            <button
                              type="button"
                              title={m.preview}
                              className="min-w-0 flex-1 truncate text-start hover:underline cursor-pointer"
                              onClick={() => {
                                setRoutingDetailMessageId(null);
                                void jumpMessage(m.id);
                              }}
                            >
                              <span className="font-mono text-[10px] uppercase text-muted-foreground me-1.5">{m.role}</span>
                              {m.preview}
                            </button>
                            <ViewFullButton
                              label="原文"
                              className="shrink-0"
                              onClick={() =>
                                setViewerPayload({
                                  title: `近期对话引用（${m.role}）`,
                                  content: m.preview,
                                  mode: 'markdown',
                                  truncatedHint: '快照只记录引用摘要；点击「拉取未截断全文」获取完整历史消息。',
                                  loadFull: async () => {
                                    const res = await api<Record<string, unknown>>(`/api/message?messageId=${encodeURIComponent(m.id)}`);
                                    return String(res.text ?? m.preview);
                                  },
                                })
                              }
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {routing.context.autoRecalled && routing.context.autoRecalled.length > 0 && (
                    <div>
                      <div className="mb-1 font-medium text-foreground">
                        潜意识记忆闪回（{routing.context.autoRecalled.length}）
                      </div>
                      <ul className="space-y-1">
                        {routing.context.autoRecalled.map(hit => (
                          <li key={hit.id} className="space-y-1 rounded border bg-background px-2 py-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium text-foreground">{hit.title}</span>
                              <ViewFullButton
                                onClick={() =>
                                  setViewerPayload({
                                    title: `潜意识记忆 · ${hit.title}`,
                                    content: hit.snippet,
                                    mode: 'markdown',
                                    loadFull: async () => {
                                      const list = await api<MemoryCard[]>('/api/memories');
                                      const found = Array.isArray(list) ? list.find(c => c.id === hit.id || c.topic === hit.title) : undefined;
                                      return found?.content ?? hit.snippet;
                                    },
                                  })
                                }
                              />
                            </div>
                            <ExpandableText text={hit.snippet} clampClass="line-clamp-2" threshold={90} className="text-muted-foreground" />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </details>
            </>
          )}
        </DialogPanel>
      </DialogPopup>

      <FullContentDialog payload={viewerPayload} onClose={() => setViewerPayload(null)} />
    </Dialog>
  );
}

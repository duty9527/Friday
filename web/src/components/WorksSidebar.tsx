import type { WorkView } from '@friday/view.js';
import { activeStatus } from '@friday/web/model.js';
import { profileBadges, statusText, tierBadges, timestamp } from '@friday/web/shared/format.js';
import { ClockIcon, InboxIcon, SquareIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetHeader, SheetPopup, SheetTitle } from '@/components/ui/sheet';
import { useFriday } from '@/lib/friday-store';
import { cn } from '@/lib/utils';

function WorkRowItem({
  work,
  selected,
  onSelect,
  onStop,
  stopRequested,
  authExpired,
}: {
  work: WorkView;
  selected: boolean;
  onSelect: () => void;
  onStop: () => void;
  stopRequested: boolean;
  authExpired: boolean;
}) {
  const isActive = activeStatus(work.status);
  const modelLabel = work.workerModel
    ? `${work.workerModel}${work.thinkingLevel ? `@${work.thinkingLevel}` : ''}`
    : work.modelTier
      ? (tierBadges[work.modelTier] ?? work.modelTier)
      : undefined;
  const initiatorPrefix = work.initiator?.kind === 'timer'
    ? `⏱ 定时${work.initiator.label ? `(${work.initiator.label})` : ''} · `
    : '';
  const profilePrefix = work.profile || modelLabel
    ? `${profileBadges[work.profile ?? 'general'] ?? (work.profile || '子 AI')}${modelLabel ? ` (${modelLabel})` : ''} · `
    : '';
  const statusLabel = work.pendingQuestion ? '⏳ 等待拍板' : statusText(work.status);
  const shortLabel = (work.prompt || '后台工作').replace(/\s+/g, ' ').trim().slice(0, 28);

  return (
    <div
      className={cn(
        'work-row group relative flex items-start gap-1.5 rounded-lg border px-2.5 py-2 transition-colors',
        selected
          ? 'selected border-ring/50 bg-accent text-accent-foreground'
          : 'border-transparent hover:border-border hover:bg-accent/50',
      )}
    >
      <button
        type="button"
        className="work-row-main flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-1 text-start outline-none"
        aria-pressed={selected}
        title={work.prompt}
        onClick={onSelect}
      >
        <span className="work-title line-clamp-2 w-full text-xs font-medium leading-snug text-foreground">
          {work.prompt || '后台工作'}
        </span>
        <span className={cn('meta flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground', isActive && 'running')}>
          <span>{`${initiatorPrefix}${profilePrefix}`}</span>
          <Badge
            size="sm"
            variant={
              work.pendingQuestion
                ? 'warning'
                : work.status === 'failed'
                  ? 'error'
                  : work.status === 'completed'
                    ? 'success'
                    : isActive
                      ? 'info'
                      : 'secondary'
            }
          >
            {statusLabel}
          </Badge>
          <span>· {timestamp(work.createdAt)}</span>
        </span>
      </button>

      {isActive && (
        <Button
          type="button"
          size="xs"
          variant="destructive-outline"
          className="work-stop-btn shrink-0"
          disabled={stopRequested || authExpired}
          title={stopRequested ? '已请求停止，等待结算' : '停止该任务'}
          aria-label={stopRequested ? `正在请求停止工作：${shortLabel}` : `停止工作：${shortLabel}`}
          onClick={onStop}
        >
          <SquareIcon className="size-2.5 fill-current" />
          <span>{stopRequested ? '停止中…' : '停止'}</span>
        </Button>
      )}
    </div>
  );
}

function WorksListContent({ onAfterSelect }: { onAfterSelect?: () => void }) {
  const {
    view,
    works,
    workFilter,
    setWorkFilter,
    selection,
    selectTrace,
    setMobilePanel,
    stopRequests,
    stopWork,
    authExpired,
  } = useFriday();

  const filtered = works.filter(
    work => workFilter === 'all' || (workFilter === 'active' ? activeStatus(work.status) : !activeStatus(work.status)),
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold tracking-tight text-foreground">任务列表</h2>
          <Badge variant="secondary" size="sm" className="font-mono">
            {filtered.length}
          </Badge>
        </div>
        <select
          id="work-filter"
          aria-label="任务筛选"
          value={workFilter}
          onChange={e => setWorkFilter(e.target.value as 'all' | 'active' | 'settled')}
          className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">全部任务</option>
          <option value="active">进行中</option>
          <option value="settled">已结束 / 暂停</option>
        </select>
      </div>

      <ScrollArea className="flex-1" overscrollContain>
        <div id="works" className="works flex flex-col gap-1 p-2">
          {filtered.length === 0 ? (
            <Empty className="py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  {view ? <InboxIcon className="size-4" /> : <ClockIcon className="size-4" />}
                </EmptyMedia>
                <EmptyTitle className="text-sm">{view ? '暂无符合筛选的任务' : '正在读取任务…'}</EmptyTitle>
                <EmptyDescription className="text-xs">
                  {view ? '后台子 AI 执行的工作会出现在这里。' : '连接本机服务后自动同步任务列表。'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            filtered.map(work => (
              <WorkRowItem
                key={work.id}
                work={work}
                selected={selection.type === 'task' && selection.id === work.id}
                stopRequested={stopRequests.has(`task:${work.id}`)}
                authExpired={authExpired}
                onSelect={() => {
                  selectTrace({ type: 'task', id: work.id, label: work.prompt }, true);
                  setMobilePanel('trace');
                  onAfterSelect?.();
                }}
                onStop={() => void stopWork(work.id)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export function WorksSidebar() {
  const { leftCollapsed, mobileWorksOpen, setMobileWorksOpen } = useFriday();

  return (
    <>
      {!leftCollapsed && (
        <aside
          id="work-sidebar"
          aria-label="任务列表"
          className="hidden h-full w-64 shrink-0 flex-col border-e bg-sidebar text-sidebar-foreground lg:flex xl:w-72"
        >
          <WorksListContent />
        </aside>
      )}

      <Sheet open={mobileWorksOpen} onOpenChange={setMobileWorksOpen}>
        <SheetPopup side="left" className="w-80 max-w-[88vw] p-0 lg:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>任务列表</SheetTitle>
          </SheetHeader>
          <WorksListContent onAfterSelect={() => setMobileWorksOpen(false)} />
        </SheetPopup>
      </Sheet>
    </>
  );
}

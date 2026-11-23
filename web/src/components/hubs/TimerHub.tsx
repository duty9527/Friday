import type { TimerView } from '@friday/view.js';
import { errorText, formatIntervalText, timestamp } from '@friday/web/shared/format.js';
import { ArrowUpRightIcon, CheckCircle2Icon, ClockIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ConfirmActionDialog } from '@/components/shared/ConfirmActionDialog';
import {
  ExpandableText,
  FullContentDialog,
  ViewFullButton,
  type FullContentPayload,
} from '@/components/shared/FullContentViewer';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useFriday } from '@/lib/friday-store';

function timerStatusRank(timer: TimerView): number {
  if (timer.fatiguePaused || timer.lastRunStatus === 'fatigue_paused') return 0;
  if (timer.enabled) return 1;
  if (timer.goalMetAt) return 3;
  return 2;
}

export function TimerHub() {
  const { view, ready, authExpired, api, refreshView, selectTrace, setActiveHub, setMobilePanel } = useFriday();
  const timers = useMemo(
    () => [...(view?.timers ?? [])].sort((a, b) => timerStatusRank(a) - timerStatusRank(b)),
    [view?.timers],
  );
  const plugins = view?.plugins ?? [];
  const channels = view?.imChannels ?? [];

  const [name, setName] = useState('');
  const [instruction, setInstruction] = useState('');
  const [dailyAt, setDailyAt] = useState('');
  const [intervalSec, setIntervalSec] = useState('300');
  const [once, setOnce] = useState(false);
  const [goalCondition, setGoalCondition] = useState('');
  const [maxFailures, setMaxFailures] = useState('5');
  const [pluginSpec, setPluginSpec] = useState('');
  const [deliverChannelId, setDeliverChannelId] = useState('');

  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<TimerView | null>(null);
  const [viewerPayload, setViewerPayload] = useState<FullContentPayload | null>(null);

  const disabled = !ready || authExpired || busy;

  const toggleTimer = async (t: TimerView, enabled: boolean) => {
    setBusy(true);
    setErrMsg('');
    try {
      await api('/api/timer-toggle', { id: t.id, enabled });
      await refreshView();
    } catch (e) {
      setErrMsg(`切换失败：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const completeTimer = async (t: TimerView) => {
    setBusy(true);
    setErrMsg('');
    try {
      await api('/api/timer-complete', { id: t.id });
      await refreshView();
    } catch (e) {
      setErrMsg(`标记失败：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const removeTimer = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setErrMsg('');
    try {
      await api('/api/timer-remove', { id: deleteTarget.id });
      setDeleteTarget(null);
      await refreshView();
    } catch (e) {
      setErrMsg(`删除失败：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const addTimer = async () => {
    const trimmedName = name.trim();
    const trimmedDaily = dailyAt.trim();
    const trimmedGoal = goalCondition.trim();
    const trimmedPlugin = pluginSpec.trim();
    const [plugin, pluginAction] = trimmedPlugin ? trimmedPlugin.split('/').map(s => s.trim()) : [undefined, undefined];
    const trimmedInst = instruction.trim();
    const sec = Number(intervalSec);
    const rawMaxFail = Number(maxFailures);
    const parsedMaxFail = Number.isInteger(rawMaxFail) && rawMaxFail >= 1 && rawMaxFail <= 100 ? rawMaxFail : undefined;

    if (!trimmedName) {
      setErrMsg('请填写定时任务名称');
      return;
    }
    if (once && trimmedGoal) {
      setErrMsg('单次定时提醒与终态目标条件不可同时设置');
      return;
    }
    if (!trimmedInst && !plugin) {
      setErrMsg('请填写执行指令或指定插件动作');
      return;
    }
    if (trimmedDaily && !/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmedDaily)) {
      setErrMsg('每日定点时间格式应为 HH:mm（例如 09:30）');
      return;
    }
    if (!trimmedDaily && (!Number.isFinite(sec) || sec < 5 || sec > 604800)) {
      setErrMsg('间隔秒数须为 5 ~ 604800 之间的数字');
      return;
    }

    setErrMsg('');
    setBusy(true);
    try {
      await api<TimerView>('/api/timer-add', {
        name: trimmedName,
        intervalMs: Math.round((Number.isFinite(sec) && sec >= 5 ? sec : 60) * 1000),
        ...(trimmedDaily ? { dailyAt: trimmedDaily } : {}),
        ...(once ? { once: true } : {}),
        ...(trimmedGoal ? { goalCondition: trimmedGoal } : {}),
        ...(parsedMaxFail !== undefined ? { maxFailures: parsedMaxFail } : {}),
        ...(plugin ? { plugin } : {}),
        ...(pluginAction ? { pluginAction } : {}),
        ...(deliverChannelId ? { deliverChannelId } : {}),
        instruction: trimmedInst || `执行插件 ${plugin}/${pluginAction ?? 'status'}`,
      });
      setName('');
      setInstruction('');
      setDailyAt('');
      setOnce(false);
      setGoalCondition('');
      setPluginSpec('');
      await refreshView();
    } catch (e) {
      setErrMsg(`创建失败：${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {errMsg && (
        <Alert variant="error">
          <AlertDescription className="text-xs">{errMsg}</AlertDescription>
        </Alert>
      )}

      {/* Quick Create Form */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <PlusIcon className="size-4" />
            <span>新建定时 / 终态目标任务</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">任务名称</Label>
              <Input size="sm" disabled={disabled} placeholder="如：每日工作区巡检" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">定时间隔（秒）</Label>
              <Input size="sm" disabled={disabled || Boolean(dailyAt.trim())} placeholder="300" value={intervalSec} onChange={e => setIntervalSec(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">或每日定点（HH:mm）</Label>
              <Input size="sm" disabled={disabled} placeholder="09:30（留空用间隔）" value={dailyAt} onChange={e => setDailyAt(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">执行指令</Label>
            <Textarea size="sm" rows={2} disabled={disabled} placeholder="到期时自动派发给 F.R.I.D.A.Y. 的指令…" value={instruction} onChange={e => setInstruction(e.target.value)} />
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">终态达成条件（可选）</Label>
              <Input size="sm" disabled={disabled || once} placeholder="达成后自动停机" value={goalCondition} onChange={e => setGoalCondition(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">直接调用插件（可选）</Label>
              <select
                value={pluginSpec}
                disabled={disabled}
                onChange={e => setPluginSpec(e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
              >
                <option value="">由主控大模型调度</option>
                {plugins.filter(p => p.enabled !== false).flatMap(p =>
                  (p.actionSpecs ?? p.actions.map(a => ({ name: a, label: a }))).map(spec => (
                    <option key={`${p.name}/${spec.name}`} value={`${p.name}/${spec.name}`}>
                      {p.title} · {spec.label ?? spec.name}
                    </option>
                  )),
                )}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">结果投递渠道（可选）</Label>
              <select
                value={deliverChannelId}
                disabled={disabled}
                onChange={e => setDeliverChannelId(e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
              >
                <option value="">控制台默认</option>
                {channels.filter(c => c.enabled).map(c => (
                  <option key={c.id} value={c.id}>{c.name} ({c.platform})</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <label className="flex items-center gap-1.5 cursor-pointer">
                <Checkbox checked={once} disabled={disabled} onCheckedChange={v => setOnce(Boolean(v))} />
                <span>一次性倒计时</span>
              </label>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">连续失败熔断阈值</span>
                <Input size="sm" className="w-16 font-mono" disabled={disabled} value={maxFailures} onChange={e => setMaxFailures(e.target.value)} />
              </div>
            </div>
            <Button size="xs" variant="default" disabled={disabled} onClick={() => void addTimer()}>
              <PlusIcon className="size-3.5" />
              <span>添加定时任务</span>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Timer List */}
      <div className="space-y-2">
        {timers.length === 0 ? (
          <div className="rounded-lg border py-10 text-center text-xs text-muted-foreground">
            暂无持久化定时任务。可在上方新建，或在对话中直接让 F.R.I.D.A.Y. 帮你设定提醒。
          </div>
        ) : (
          timers.map(t => {
            const isFatigued = Boolean(t.fatiguePaused || t.lastRunStatus === 'fatigue_paused');
            return (
              <div key={t.id} className="rounded-xl border bg-card p-3 text-xs space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <ClockIcon className="size-3.5 text-muted-foreground" />
                      <span className="font-semibold text-sm text-foreground">{t.name}</span>
                      <Badge
                        size="sm"
                        variant={
                          isFatigued
                            ? 'error'
                            : t.goalMetAt
                              ? 'success'
                              : t.enabled
                                ? 'info'
                                : 'secondary'
                        }
                      >
                        {isFatigued ? '疲劳熔断' : t.goalMetAt ? '目标已达成' : t.enabled ? '运行中' : '已暂停'}
                      </Badge>
                      {t.once && <Badge size="sm" variant="outline">单次</Badge>}
                      {t.plugin && (
                        <Badge size="sm" variant="outline" className="font-mono">
                          {t.plugin}/{t.pluginAction ?? 'status'}
                        </Badge>
                      )}
                    </div>
                    {t.instruction.length > 220 ? (
                      <ExpandableText
                        text={t.instruction}
                        clampClass="line-clamp-3"
                        threshold={220}
                        className="text-muted-foreground"
                        onOpenFull={() =>
                          setViewerPayload({
                            title: `定时任务完整指令 · ${t.name}`,
                            subtitle: t.dailyAt ? `每日 ${t.dailyAt}` : formatIntervalText(t.intervalMs),
                            content: t.instruction,
                            mode: 'text',
                          })
                        }
                      />
                    ) : (
                      <p className="text-muted-foreground whitespace-pre-wrap">{t.instruction}</p>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    {t.activeTaskId && (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          selectTrace({ type: 'task', id: t.activeTaskId!, label: t.name }, true);
                          setMobilePanel('trace');
                          setActiveHub(null);
                        }}
                      >
                        <span>运行轨迹</span>
                        <ArrowUpRightIcon className="size-3" />
                      </Button>
                    )}
                    {t.goalCondition && !t.goalMetAt && (
                      <Button size="xs" variant="outline" disabled={disabled} onClick={() => void completeTimer(t)}>
                        <CheckCircle2Icon className="size-3" />
                        <span>达成停机</span>
                      </Button>
                    )}
                    <Switch
                      checked={t.enabled}
                      disabled={disabled}
                      aria-label={`${t.enabled ? '暂停' : '启用'}定时任务 ${t.name}`}
                      onCheckedChange={next => void toggleTimer(t, next)}
                    />
                    <Button size="icon-xs" variant="ghost" disabled={disabled} aria-label={`删除 ${t.name}`} onClick={() => setDeleteTarget(t)}>
                      <Trash2Icon className="size-3.5 text-destructive-foreground" />
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  <span>{t.dailyAt ? `每日 ${t.dailyAt}` : formatIntervalText(t.intervalMs)}</span>
                  {t.enabled && t.nextRunAt > 0 && <span>· 下次：{timestamp(t.nextRunAt)}</span>}
                  {t.lastRunAt && <span>· 上次：{timestamp(t.lastRunAt)}</span>}
                  {t.consecutiveFailures ? (
                    <span className="text-warning-foreground">· 连续失败 {t.consecutiveFailures}/{t.maxFailures ?? 5}</span>
                  ) : null}
                </div>

                {t.goalCondition && (
                  <div className="rounded bg-muted/40 px-2.5 py-1.5 text-[11px]">
                    终态目标：{t.goalCondition}
                    {t.goalSummary ? `（结算：${t.goalSummary}）` : ''}
                  </div>
                )}
                {t.lastError && (
                  <div className="flex items-start justify-between gap-2 rounded border border-destructive/30 bg-destructive/8 px-2.5 py-1.5 text-[11px] text-destructive-foreground">
                    <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">最近错误：{t.lastError}</span>
                    {t.lastError.length > 180 && (
                      <ViewFullButton
                        className="shrink-0"
                        onClick={() =>
                          setViewerPayload({
                            title: `定时任务错误详情 · ${t.name}`,
                            content: t.lastError!,
                            mode: 'text',
                          })
                        }
                      />
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <ConfirmActionDialog
        open={Boolean(deleteTarget)}
        onOpenChange={o => { if (!o) setDeleteTarget(null); }}
        title="删除定时任务"
        description={`确定要删除定时任务「${deleteTarget?.name ?? ''}」吗？删除后将不再按计划自动触发。`}
        busy={busy}
        onConfirm={removeTimer}
      />

      <FullContentDialog payload={viewerPayload} onClose={() => setViewerPayload(null)} />
    </div>
  );
}

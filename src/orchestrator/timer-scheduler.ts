import { randomUUID } from 'node:crypto';
import { runPlugin } from '../plugin.js';
import { formatFlowSessionId } from '../session.js';
import type { Store, Task, Timer } from '../store.js';
import type { MessageOrigin } from '../view.js';

export const MIN_TIMER_INTERVAL_MS = 500;
export const MAX_TIMER_INTERVAL_MS = 604_800_000;

export function clampTimerIntervalMs(intervalMs: number, fallback = 60_000): number {
  const base = Number.isFinite(intervalMs) ? Math.trunc(intervalMs) : fallback;
  return Math.max(MIN_TIMER_INTERVAL_MS, Math.min(MAX_TIMER_INTERVAL_MS, base));
}

export function nextDailyRunAt(dailyAt: string, now = Date.now()): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(dailyAt.trim());
  if (!match) throw new Error('dailyAt must be in HH:mm format (00:00..23:59)');
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

const CHANNEL_ALIAS_MAP: Record<string, string> = {
  小爱: 'xiaoai',
  小爱同学: 'xiaoai',
  小爱音箱: 'xiaoai',
  音箱: 'xiaoai',
  xiaoai: 'xiaoai',
  微信: 'wechat',
  wechat: 'wechat',
  钉钉: 'dingtalk',
  dingtalk: 'dingtalk',
  telegram: 'telegram',
  local: 'local',
  web: 'local',
  webui: 'local',
  console: 'local',
  网页: 'local',
  网页端: 'local',
  控制台: 'local',
  电脑: 'local',
  桌面: 'local',
  auto: 'auto',
};

export function resolveStoreChannelOrigin(
  store: Store,
  channelSpec: string,
  deliverTarget?: string,
): MessageOrigin | undefined {
  const trimmed = channelSpec.trim();
  const normalizedSpec = CHANNEL_ALIAS_MAP[trimmed.toLowerCase()] ?? trimmed;
  if (normalizedSpec === 'local') {
    return { channel: 'local' };
  }
  const channels = store.listImChannels();
  const ch = normalizedSpec === 'auto'
    ? (channels.find(c => c.enabled && c.platform !== 'xiaoai') ?? channels.find(c => c.enabled) ?? channels[0])
    : (channels.find(c => c.enabled && (c.id === normalizedSpec || c.platform === normalizedSpec || c.name === trimmed))
      ?? channels.find(c => c.id === normalizedSpec || c.platform === normalizedSpec || c.name === trimmed));
  if (ch && ch.enabled) {
    const target = deliverTarget
      ?? ch.defaultTarget
      ?? Object.keys(ch.contextTokens ?? {})[0]
      ?? ch.allowedSenders[0]
      ?? 'default';
    return {
      channel: ch.platform,
      channelId: ch.id,
      accountId: ch.accountId,
      conversationId: target,
      senderId: target,
      replyWebhook: ch.webhookUrl,
      contextToken: ch.contextTokens?.[target],
    };
  }
  return undefined;
}

export interface AddTimerOptions {
  dailyAt?: string;
  delayMs?: number;
  once?: boolean;
  plugin?: string;
  pluginAction?: string;
  deliverChannelId?: string;
  deliverTarget?: string;
}

export interface TimerSchedulerHost {
  home: string;
  store: Store;
  mode: 'real' | 'offline';
  closingSignal: AbortSignal;
  isClosing: () => boolean;
  jobs: Set<Promise<void>>;
  submit: (
    requestId: string,
    prompt: string,
    paths: string[],
    limitMs: number,
    chatWork: { originMessageId?: string; cwd?: string; signal: AbortSignal },
  ) => Promise<Task>;
  notifyOutbound: () => void;
}

export class TimerScheduler {
  private readonly runningPluginTimers = new Set<string>();

  constructor(private readonly host: TimerSchedulerHost) {}

  addTimer(
    name: string,
    instruction: string,
    intervalMs = 60_000,
    cwd?: string,
    origin?: MessageOrigin,
    options?: AddTimerOptions,
  ): Timer {
    const now = Date.now();
    const dailyAt = options?.dailyAt?.trim() || undefined;
    const delayMs = options?.delayMs !== undefined ? clampTimerIntervalMs(options.delayMs, 60_000) : undefined;
    const once = options?.once ?? (delayMs !== undefined ? true : undefined);
    const effectiveIntervalMs = dailyAt ? 86_400_000 : (delayMs ?? clampTimerIntervalMs(intervalMs, 60_000));
    const nextRunAt = dailyAt ? nextDailyRunAt(dailyAt, now) : now + (delayMs ?? effectiveIntervalMs);
    const plugin = options?.plugin?.trim() || undefined;
    const pluginAction = options?.pluginAction?.trim() || undefined;
    const deliverChannelId = options?.deliverChannelId?.trim() || undefined;
    const deliverTarget = options?.deliverTarget?.trim() || undefined;
    const timer: Timer = {
      id: randomUUID(),
      name,
      instruction,
      intervalMs: effectiveIntervalMs,
      ...(dailyAt ? { dailyAt } : {}),
      ...(once ? { once: true } : {}),
      ...(plugin ? { plugin } : {}),
      ...(pluginAction ? { pluginAction } : {}),
      ...(deliverChannelId ? { deliverChannelId } : {}),
      ...(deliverTarget ? { deliverTarget } : {}),
      cwd,
      enabled: true,
      createdAt: now,
      nextRunAt,
      missedRuns: 0,
      ...(origin ? { origin } : {}),
    };
    const resolvedOrigin = this.resolveTimerOrigin(timer);
    if (resolvedOrigin) timer.origin = resolvedOrigin;
    this.host.store.saveTimer(timer);
    const scheduleDesc = once
      ? (dailyAt ? `单次 ${dailyAt}` : `${Math.round((delayMs ?? effectiveIntervalMs) / 1000)} 秒后单次执行`)
      : (dailyAt ? `每日 ${dailyAt}` : `每 ${Math.round(effectiveIntervalMs / 1000)} 秒`);
    this.host.store.notice('system', 'timer_added', `已配置定时任务「${name}」（${scheduleDesc}）`);
    return timer;
  }

  toggleTimer(id: string, enabled: boolean): Timer {
    const timer = this.host.store.getTimer(id);
    timer.enabled = enabled;
    timer.pendingCatchup = false;
    if (enabled) {
      const safeIntervalMs = clampTimerIntervalMs(timer.intervalMs);
      timer.intervalMs = safeIntervalMs;
      timer.nextRunAt = timer.dailyAt ? nextDailyRunAt(timer.dailyAt, Date.now()) : Date.now() + safeIntervalMs;
    }
    this.host.store.saveTimer(timer);
    this.host.store.notice('system', enabled ? 'timer_enabled' : 'timer_disabled', `定时任务「${timer.name}」已${enabled ? '启用' : '关闭'}`);
    return timer;
  }

  removeTimer(id: string): boolean {
    this.runningPluginTimers.delete(id);
    return this.host.store.deleteTimer(id);
  }

  resolveTimerOrigin(timer: Timer): MessageOrigin | undefined {
    if (timer.deliverChannelId) {
      const resolved = resolveStoreChannelOrigin(this.host.store, timer.deliverChannelId, timer.deliverTarget);
      if (resolved) return resolved;
    }
    return timer.origin;
  }

  private triggerTimer(timer: Timer): void {
    const now = Date.now();
    timer.lastRunAt = now;
    timer.pendingCatchup = false;
    const origin = this.resolveTimerOrigin(timer);
    if (timer.plugin) {
      const pluginName = timer.plugin;
      const pluginAction = timer.pluginAction ?? 'status';
      this.runningPluginTimers.add(timer.id);
      this.host.store.saveTimer(timer);
      const job = runPlugin(
        this.host.home,
        pluginName,
        pluginAction,
        {
          timerId: timer.id,
          timerName: timer.name,
          instruction: timer.instruction,
        },
        30_000,
        { signal: this.host.closingSignal },
      ).then(res => {
        if (this.host.isClosing()) return;
        if (!res.notify) {
          this.host.store.notice('system', 'timer_plugin_silent', `定时插件「${timer.name}」(${pluginName}/${pluginAction}) 已执行（静默跳过通知）`);
          return;
        }
        const timerMsgId = randomUUID();
        const timerSessionId = formatFlowSessionId(timerMsgId);
        const userMsg = this.host.store.conversation.create({
          id: timerMsgId,
          role: 'user',
          source: 'system',
          origin,
          sessionId: timerSessionId,
          text: `[定时触发 · ${timer.name}] ${timer.instruction}`,
          status: 'completed',
          paths: [],
          mode: this.host.mode,
        });
        this.host.store.conversation.create({
          id: randomUUID(),
          replyTo: userMsg.id,
          role: 'assistant',
          source: 'system',
          origin,
          sessionId: timerSessionId,
          text: res.message,
          status: 'completed',
          paths: [],
          mode: this.host.mode,
        });
        this.host.store.notice('system', 'timer_plugin_completed', `定时插件「${timer.name}」(${pluginName}/${pluginAction}) 已执行并推送通知`);
        this.host.notifyOutbound();
      }).catch(err => {
        if (this.host.isClosing()) return;
        const errMsg = err instanceof Error ? err.message : '插件执行失败';
        this.host.store.notice('system', 'timer_plugin_failed', `定时插件「${timer.name}」执行失败：${errMsg}`);
      }).finally(() => {
        this.runningPluginTimers.delete(timer.id);
        this.host.jobs.delete(job);
      });
      this.host.jobs.add(job);
      return;
    }

    const timerMsgId = randomUUID();
    const message = this.host.store.conversation.create({
      id: timerMsgId,
      role: 'user',
      source: 'system',
      origin,
      sessionId: formatFlowSessionId(timerMsgId),
      text: `[定时触发 · ${timer.name}] ${timer.instruction}`,
      status: 'completed',
      paths: [],
      mode: this.host.mode,
    });
    const requestId = `timer:${timer.id}:${now}`;
    this.host.store.saveTimer(timer);
    void this.host.submit(
      requestId,
      timer.instruction,
      [],
      600_000,
      { originMessageId: message.id, cwd: timer.cwd, signal: this.host.closingSignal },
    ).then(task => {
      if (this.host.isClosing()) return;
      const current = this.host.store.listTimers().find(item => item.id === timer.id);
      if (current) {
        current.activeTaskId = task.id;
        this.host.store.saveTimer(current);
      }
    }).catch(err => {
      if (this.host.isClosing()) return;
      const errMsg = err instanceof Error ? err.message : '定时任务提交失败';
      this.host.store.notice('system', 'timer_failed', `定时任务「${timer.name}」触发失败：${errMsg}`);
    });
  }

  tick(): void {
    if (this.host.isClosing()) return;
    const now = Date.now();
    for (const timer of this.host.store.listTimers()) {
      let active = this.runningPluginTimers.has(timer.id);
      if (timer.activeTaskId) {
        let taskActive = false;
        try {
          taskActive = ['queued', 'running'].includes(this.host.store.get(timer.activeTaskId).status);
        } catch {
          taskActive = false;
        }
        if (taskActive) {
          active = true;
        } else {
          timer.activeTaskId = undefined;
          this.host.store.saveTimer(timer);
        }
      }
      if (!timer.enabled) continue;
      if (now >= timer.nextRunAt) {
        if (timer.once) {
          timer.enabled = false;
          timer.pendingCatchup = false;
          this.triggerTimer(timer);
          continue;
        }
        const safeIntervalMs = clampTimerIntervalMs(timer.intervalMs);
        if (timer.intervalMs !== safeIntervalMs) timer.intervalMs = safeIntervalMs;
        const rawNextRunAt = Number.isFinite(timer.nextRunAt) ? timer.nextRunAt : now;
        const missed = Math.max(0, Math.floor((now - rawNextRunAt) / safeIntervalMs));
        if (missed > 0) timer.missedRuns += missed;
        if (timer.dailyAt) {
          timer.nextRunAt = nextDailyRunAt(timer.dailyAt, now);
        } else {
          // Always advance strictly past `now` before saving/dispatching so overdue timers never spin at 0ms.
          const candidate = rawNextRunAt + (missed + 1) * safeIntervalMs;
          timer.nextRunAt = Number.isFinite(candidate) && candidate > now ? candidate : now + safeIntervalMs;
        }
        if (active) {
          timer.pendingCatchup = true;
          this.host.store.saveTimer(timer);
        } else {
          this.triggerTimer(timer);
        }
      } else if (!active && timer.pendingCatchup) {
        this.triggerTimer(timer);
      }
    }
  }
}

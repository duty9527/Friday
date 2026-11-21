import { randomUUID } from 'node:crypto';
import { findFallbackTelegramChannel, resolveImDeliveryTarget } from '../im/types.js';
import { runPlugin } from '../plugin.js';
import { formatFlowSessionId } from '../session.js';
import type { Store, Task, TaskStatus, Timer } from '../store.js';
import type { MessageOrigin, RunInitiator } from '../view.js';

export const MIN_TIMER_INTERVAL_MS = 500;
export const MAX_TIMER_INTERVAL_MS = 604_800_000;
export const DEFAULT_TIMER_MAX_FAILURES = 5;
export const MAX_TIMER_MAX_FAILURES = 100;
export const MAX_ENABLED_TIMERS = 20;
export const CHAT_MIN_RECURRING_LLM_INTERVAL_MS = 300_000;
export const CHAT_MIN_RECURRING_PLUGIN_INTERVAL_MS = 60_000;
export const CHAT_MIN_ONCE_DELAY_MS = 5_000;

export function clampTimerIntervalMs(intervalMs: number, fallback = 60_000): number {
  const base = Number.isFinite(intervalMs) ? Math.trunc(intervalMs) : fallback;
  return Math.max(MIN_TIMER_INTERVAL_MS, Math.min(MAX_TIMER_INTERVAL_MS, base));
}

export function clampTimerMaxFailures(maxFailures?: number, fallback = DEFAULT_TIMER_MAX_FAILURES): number {
  if (maxFailures === undefined || !Number.isFinite(maxFailures)) return fallback;
  return Math.max(1, Math.min(MAX_TIMER_MAX_FAILURES, Math.trunc(maxFailures)));
}

export function parseTimerIdFromRequestId(requestId?: string): string | undefined {
  if (!requestId || !requestId.startsWith('timer:')) return undefined;
  const rest = requestId.slice('timer:'.length);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0) return undefined;
  return rest.slice(0, sep);
}

export function extractGoalMetMarker(text?: string): { met: boolean; summary?: string; cleanedText: string } {
  if (!text) return { met: false, cleanedText: '' };
  let met = false;
  let summary: string | undefined;
  const cleanedText = text
    .replace(/\[\[GOAL_MET(?:\s*[:：]\s*([^\]]+))?\]\]/gi, (_full, rawSummary?: string) => {
      met = true;
      const trimmed = rawSummary?.trim();
      if (trimmed && !summary) summary = trimmed;
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { met, ...(summary ? { summary } : {}), cleanedText };
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
    const resolvedTarget = resolveImDeliveryTarget(ch, deliverTarget);
    if (!resolvedTarget && ch.platform === 'wechat' && ch.botToken && !ch.webhookUrl) return undefined;
    const target = resolvedTarget ?? 'default';
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
  goalCondition?: string;
  maxFailures?: number;
  enforceChatGuardrails?: boolean;
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
    chatWork: {
      originMessageId?: string;
      cwd?: string;
      signal: AbortSignal;
      initiator?: RunInitiator;
      timerId?: string;
    },
  ) => Promise<Task>;
  notifyOutbound: () => void;
}

export class TimerScheduler {
  private readonly runningPluginTimers = new Set<string>();
  private readonly submittingTaskTimers = new Set<string>();

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
    const rawDelayMs = options?.delayMs !== undefined && Number.isFinite(options.delayMs)
      ? Math.trunc(options.delayMs)
      : undefined;
    const delayMs = rawDelayMs !== undefined ? clampTimerIntervalMs(rawDelayMs, 60_000) : undefined;
    const once = options?.once ?? (delayMs !== undefined ? true : undefined);
    const goalCondition = options?.goalCondition?.trim() || undefined;
    if (once && goalCondition) {
      throw new Error('单次定时提醒与有终态目标不可同时设置（有终态目标会在达成后自动结束）');
    }
    const plugin = options?.plugin?.trim() || undefined;
    const pluginAction = options?.pluginAction?.trim() || undefined;
    if (options?.enforceChatGuardrails) {
      if (once && !dailyAt) {
        const checkDelay = rawDelayMs ?? (Number.isFinite(intervalMs) ? Math.trunc(intervalMs) : 60_000);
        if (checkDelay < CHAT_MIN_ONCE_DELAY_MS) {
          throw new Error('单次定时提醒延迟不能短于 5 秒（请设置 delayMs >= 5000）');
        }
      } else if (!once && !dailyAt) {
        const checkInterval = Number.isFinite(intervalMs) ? Math.trunc(intervalMs) : 60_000;
        if (plugin && checkInterval < CHAT_MIN_RECURRING_PLUGIN_INTERVAL_MS) {
          throw new Error('对话中创建的插件巡检周期不能短于 1 分钟（intervalMs >= 60000）');
        }
        if (!plugin && checkInterval < CHAT_MIN_RECURRING_LLM_INTERVAL_MS) {
          throw new Error('对话中创建的 AI 周期巡检间隔不能短于 5 分钟（intervalMs >= 300000，高频监控请使用零 Token 插件或调整周期）');
        }
      }
    }
    const enabledCount = this.host.store.listTimers().filter(t => t.enabled).length;
    if (enabledCount >= MAX_ENABLED_TIMERS) {
      throw new Error(`当前已启用的定时任务已达上限（${MAX_ENABLED_TIMERS} 个），请先关闭或删除不再需要的任务`);
    }
    const effectiveIntervalMs = dailyAt ? 86_400_000 : (delayMs ?? clampTimerIntervalMs(intervalMs, 60_000));
    const nextRunAt = dailyAt ? nextDailyRunAt(dailyAt, now) : now + (delayMs ?? effectiveIntervalMs);
    const deliverChannelId = options?.deliverChannelId?.trim() || undefined;
    const deliverTarget = options?.deliverTarget?.trim() || undefined;
    const maxFailures = clampTimerMaxFailures(options?.maxFailures);
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
      ...(goalCondition ? { goalCondition } : {}),
      maxFailures,
      consecutiveFailures: 0,
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
    const goalDesc = goalCondition ? `；终态目标：${goalCondition}` : '';
    this.host.store.notice('system', 'timer_added', `已配置定时任务「${name}」（${scheduleDesc}${goalDesc}）`);
    return timer;
  }

  toggleTimer(id: string, enabled: boolean): Timer {
    const timer = this.host.store.getTimer(id);
    if (enabled && !timer.enabled) {
      const enabledCount = this.host.store.listTimers().filter(t => t.enabled).length;
      if (enabledCount >= MAX_ENABLED_TIMERS) {
        throw new Error(`当前已启用的定时任务已达上限（${MAX_ENABLED_TIMERS} 个），请先关闭或删除不再需要的任务`);
      }
    }
    timer.enabled = enabled;
    timer.pendingCatchup = false;
    if (enabled) {
      const safeIntervalMs = clampTimerIntervalMs(timer.intervalMs);
      timer.intervalMs = safeIntervalMs;
      timer.nextRunAt = timer.dailyAt ? nextDailyRunAt(timer.dailyAt, Date.now()) : Date.now() + safeIntervalMs;
      timer.consecutiveFailures = 0;
      timer.fatiguePaused = false;
      timer.firstFailureNotified = false;
      timer.lastError = undefined;
      timer.goalMetAt = undefined;
      timer.goalSummary = undefined;
      if (timer.lastRunStatus === 'fatigue_paused' || timer.lastRunStatus === 'goal_met' || timer.lastRunStatus === 'error') {
        timer.lastRunStatus = undefined;
      }
    }
    this.host.store.saveTimer(timer);
    this.host.store.notice('system', enabled ? 'timer_enabled' : 'timer_disabled', `定时任务「${timer.name}」已${enabled ? '启用' : '关闭'}`);
    return timer;
  }

  completeTimer(id: string, summary?: string, options?: { notifyChat?: boolean }): Timer {
    const timer = this.host.store.getTimer(id);
    if (!timer.goalCondition) {
      throw new Error('只有配置了终态目标（goalCondition）的定时任务才能标记目标达成；无终态巡检请使用关闭或删除');
    }
    if (timer.goalMetAt && !timer.enabled && timer.lastRunStatus === 'goal_met') {
      return timer;
    }
    const cleanSummary = summary?.trim() || timer.goalSummary || `目标已达成：${timer.goalCondition}`;
    timer.enabled = false;
    timer.pendingCatchup = false;
    timer.activeTaskId = undefined;
    timer.goalMetAt = Date.now();
    timer.goalSummary = cleanSummary;
    timer.consecutiveFailures = 0;
    timer.fatiguePaused = false;
    timer.firstFailureNotified = false;
    timer.lastError = undefined;
    timer.lastRunStatus = 'goal_met';
    this.host.store.saveTimer(timer);
    this.host.store.notice('system', 'timer_goal_met', `定时目标「${timer.name}」已达成并自动停止：${cleanSummary}`);
    if (options?.notifyChat !== false) {
      this.postTimerSystemMessage(
        timer,
        `目标达成：${timer.goalCondition}`,
        `🎯 **定时目标已达成**（已自动停止任务「${timer.name}」）\n\n- 目标条件：${timer.goalCondition}\n- 达成摘要：${cleanSummary}`,
      );
    }
    return timer;
  }

  willNextFailureBeSilent(task: Pick<Task, 'timerId' | 'requestId'>): boolean {
    const timerId = task.timerId ?? parseTimerIdFromRequestId(task.requestId);
    if (!timerId) return false;
    const timer = this.host.store.listTimers().find(t => t.id === timerId);
    if (!timer) return false;
    const threshold = clampTimerMaxFailures(timer.maxFailures);
    const nextCount = (timer.consecutiveFailures ?? 0) + 1;
    return nextCount > 1 && nextCount < threshold;
  }

  recordTimerSuccess(timerId: string, taskId?: string): Timer | undefined {
    const current = this.host.store.listTimers().find(t => t.id === timerId);
    if (!current) return undefined;
    if (taskId && current.activeTaskId === taskId) {
      current.activeTaskId = undefined;
    }
    current.consecutiveFailures = 0;
    current.fatiguePaused = false;
    current.firstFailureNotified = false;
    current.lastError = undefined;
    if (!current.goalMetAt) {
      current.lastRunStatus = 'ok';
    }
    this.host.store.saveTimer(current);
    return current;
  }

  recordTimerFailure(
    timerId: string,
    errorMessage: string,
    options?: { notifyFirstFailure?: boolean; taskId?: string },
  ): Timer | undefined {
    const current = this.host.store.listTimers().find(t => t.id === timerId);
    if (!current) return undefined;
    if (options?.taskId && current.activeTaskId === options.taskId) {
      current.activeTaskId = undefined;
    }
    const cleanError = errorMessage.trim() || '定时任务执行失败';
    const threshold = clampTimerMaxFailures(current.maxFailures);
    const nextCount = (current.consecutiveFailures ?? 0) + 1;
    current.consecutiveFailures = nextCount;
    current.lastError = cleanError;
    if (nextCount >= threshold) {
      current.enabled = false;
      current.pendingCatchup = false;
      current.activeTaskId = undefined;
      current.fatiguePaused = true;
      current.lastRunStatus = 'fatigue_paused';
      this.host.store.saveTimer(current);
      this.host.store.notice(
        'system',
        'timer_fatigue_paused',
        `定时任务「${current.name}」连续失败 ${nextCount}/${threshold} 次，已触发疲劳熔断并自动暂停（最后错误：${cleanError}）`,
      );
      this.postTimerSystemMessage(
        current,
        `疲劳熔断（连续失败 ${nextCount} 次）`,
        `🛑 **定时任务已触发疲劳熔断并自动暂停**（「${current.name}」）\n\n- 连续失败：${nextCount} / ${threshold} 次\n- 最近错误：${cleanError}\n- 恢复方式：排查原因后可在「定时与目标」面板中手动重新启用。`,
      );
      return current;
    }
    if (nextCount === 1 && !current.firstFailureNotified) {
      current.firstFailureNotified = true;
      current.lastRunStatus = 'error';
      this.host.store.saveTimer(current);
      this.host.store.notice(
        'system',
        'timer_first_failure',
        `定时任务「${current.name}」首次执行失败（1/${threshold}），后续中间失败将静默累计直至熔断：${cleanError}`,
      );
      if (options?.notifyFirstFailure !== false) {
        this.postTimerSystemMessage(
          current,
          `首次执行失败（1/${threshold}）`,
          `⚠️ **定时任务「${current.name}」首次执行失败**（1/${threshold}）\n\n- 错误信息：${cleanError}\n- 说明：为避免告警轰炸，达到 ${threshold} 次连续失败前将静默记录并在达阈值后自动暂停。`,
        );
      }
      return current;
    }
    current.lastRunStatus = 'error';
    this.host.store.saveTimer(current);
    this.host.store.notice(
      'system',
      'timer_failure_silent',
      `定时任务「${current.name}」连续失败 ${nextCount}/${threshold} 次（静默累计中）：${cleanError}`,
    );
    return current;
  }

  onTimerTaskSettled(
    task: Pick<Task, 'id' | 'timerId' | 'requestId' | 'reason'>,
    status: TaskStatus,
    options?: { goalMet?: boolean; goalSummary?: string; notifyFirstFailure?: boolean },
  ): void {
    const timerId = task.timerId ?? parseTimerIdFromRequestId(task.requestId);
    if (!timerId) return;
    if (status === 'completed') {
      const updated = this.recordTimerSuccess(timerId, task.id);
      if (updated && options?.goalMet && updated.goalCondition) {
        this.completeTimer(updated.id, options.goalSummary);
      }
      return;
    }
    if (status === 'failed') {
      this.recordTimerFailure(timerId, task.reason ?? '后台任务执行失败', {
        notifyFirstFailure: options?.notifyFirstFailure,
        taskId: task.id,
      });
      return;
    }
    if (status === 'paused' || status === 'cancelled') {
      const current = this.host.store.listTimers().find(t => t.id === timerId);
      if (current && current.activeTaskId === task.id) {
        current.activeTaskId = undefined;
        this.host.store.saveTimer(current);
      }
    }
  }

  private postTimerSystemMessage(timer: Timer, heading: string, text: string): void {
    const { origin, fallbackNote } = this.resolveTriggerOriginWithFallback(timer);
    const deliveredText = fallbackNote ? `${text}\n\n> ℹ️ ${fallbackNote}` : text;
    const msgId = randomUUID();
    const sessionId = formatFlowSessionId(msgId);
    const userMsg = this.host.store.conversation.create({
      id: msgId,
      role: 'user',
      source: 'system',
      origin,
      sessionId,
      text: `[定时状态 · ${timer.name}] ${heading}`,
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
      sessionId,
      text: deliveredText,
      status: 'completed',
      paths: [],
      mode: this.host.mode,
    });
    this.host.notifyOutbound();
  }

  removeTimer(id: string): boolean {
    this.runningPluginTimers.delete(id);
    this.submittingTaskTimers.delete(id);
    return this.host.store.deleteTimer(id);
  }

  resolveTimerOrigin(timer: Timer): MessageOrigin | undefined {
    if (timer.deliverChannelId) {
      // A configured destination must not fall back to the stored origin of a previous binding.
      return resolveStoreChannelOrigin(this.host.store, timer.deliverChannelId, timer.deliverTarget);
    }
    return timer.origin;
  }

  private resolveTriggerOriginWithFallback(timer: Timer): { origin: MessageOrigin | undefined; fallbackNote?: string } {
    const primary = this.resolveTimerOrigin(timer);
    if (primary) return { origin: primary };
    if (timer.deliverChannelId) {
      const trimmed = timer.deliverChannelId.trim();
      const normalizedSpec = CHANNEL_ALIAS_MAP[trimmed.toLowerCase()] ?? trimmed;
      const channels = this.host.store.listImChannels();
      const targetChannel = channels.find(c => c.id === normalizedSpec || c.platform === normalizedSpec || c.name === trimmed);
      const targetsWechat = normalizedSpec === 'wechat' || targetChannel?.platform === 'wechat';
      if (targetsWechat) {
        const fb = findFallbackTelegramChannel(channels);
        if (fb) {
          return {
            origin: {
              channel: 'telegram',
              channelId: fb.channel.id,
              accountId: fb.channel.accountId,
              conversationId: fb.target,
              senderId: fb.target,
              replyWebhook: fb.channel.webhookUrl,
            },
            fallbackNote: '微信通道当前未激活或已停用，本次定时推送已自动通过 Telegram 兜底投递。',
          };
        }
      }
    }
    return { origin: undefined };
  }

  private triggerTimer(timer: Timer, plannedRunAt?: number): void {
    const now = Date.now();
    timer.lastRunAt = now;
    timer.pendingCatchup = false;
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
        if (!res.ok) {
          const errMsg = res.message?.trim() || `定时插件「${timer.name}」(${pluginName}/${pluginAction}) 返回失败`;
          this.recordTimerFailure(timer.id, errMsg, { notifyFirstFailure: true });
          return;
        }
        if (res.notify) {
          const { origin, fallbackNote } = this.resolveTriggerOriginWithFallback(timer);
          const rawDelivered = fallbackNote ? `${res.message}\n\n> ℹ️ ${fallbackNote}` : res.message;
          const deliveredText = rawDelivered.length > 65_536 ? `${rawDelivered.slice(0, 65_535)}…` : rawDelivered;
          const timerMsgId = randomUUID();
          const timerSessionId = formatFlowSessionId(timerMsgId);
          const rawPromptText = `[定时触发 · ${timer.name}] ${timer.instruction}`;
          const promptText = rawPromptText.length > 65_536 ? `${rawPromptText.slice(0, 65_535)}…` : rawPromptText;
          this.host.store.transaction(() => {
            const userMsg = this.host.store.conversation.create({
              id: timerMsgId,
              role: 'user',
              source: 'system',
              origin,
              sessionId: timerSessionId,
              text: promptText,
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
              text: deliveredText,
              status: 'completed',
              paths: [],
              mode: this.host.mode,
            });
          });
          this.host.store.notice('system', 'timer_plugin_completed', `定时插件「${timer.name}」(${pluginName}/${pluginAction}) 已执行并推送通知`);
          this.host.notifyOutbound();
        } else {
          this.host.store.notice('system', 'timer_plugin_silent', `定时插件「${timer.name}」(${pluginName}/${pluginAction}) 已执行（静默跳过通知）`);
        }
        const refreshed = this.recordTimerSuccess(timer.id);
        const dataObj = res.data && typeof res.data === 'object' ? (res.data as { goalMet?: unknown; goalSummary?: unknown }) : undefined;
        if (refreshed?.goalCondition && dataObj?.goalMet === true) {
          const summary = typeof dataObj.goalSummary === 'string' && dataObj.goalSummary.trim()
            ? dataObj.goalSummary.trim()
            : (res.message?.trim() || undefined);
          this.completeTimer(refreshed.id, summary);
        }
      }).catch(err => {
        if (this.host.isClosing()) return;
        const errMsg = err instanceof Error ? err.message : '插件执行失败';
        this.recordTimerFailure(timer.id, errMsg, { notifyFirstFailure: true });
      }).finally(() => {
        this.runningPluginTimers.delete(timer.id);
        this.host.jobs.delete(job);
      });
      this.host.jobs.add(job);
      return;
    }

    if (this.submittingTaskTimers.has(timer.id)) {
      this.host.store.saveTimer(timer);
      return;
    }
    const fireSlot = plannedRunAt ?? now;
    const { origin } = this.resolveTriggerOriginWithFallback(timer);
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
    const requestId = `timer:${timer.id}:${fireSlot}`;
    const promptInstruction = timer.goalCondition
      ? `${timer.instruction}\n\n[终态目标条件] ${timer.goalCondition}\n（若经核实该目标条件已经达成，请在最终汇报末尾附加 [[GOAL_MET: 一句话说明达成情况]]，系统将自动停止后续巡检。）`
      : timer.instruction;
    this.submittingTaskTimers.add(timer.id);
    this.host.store.saveTimer(timer);
    void this.host.submit(
      requestId,
      promptInstruction,
      [],
      600_000,
      {
        originMessageId: message.id,
        cwd: timer.cwd,
        signal: this.host.closingSignal,
        initiator: { kind: 'timer', id: timer.id, label: timer.name },
        timerId: timer.id,
      },
    ).then(task => {
      if (this.host.isClosing()) return;
      const latestTaskStatus = (() => {
        try { return this.host.store.get(task.id).status; } catch { return undefined; }
      })();
      if (!latestTaskStatus || !['queued', 'running', 'paused', 'waiting_approval'].includes(latestTaskStatus)) {
        return;
      }
      const current = this.host.store.listTimers().find(item => item.id === timer.id);
      if (current) {
        this.host.store.saveTimer({ ...current, activeTaskId: task.id });
      }
    }).catch(err => {
      if (this.host.isClosing()) return;
      const errMsg = err instanceof Error ? err.message : '定时任务提交失败';
      this.recordTimerFailure(timer.id, errMsg, { notifyFirstFailure: true });
    }).finally(() => {
      this.submittingTaskTimers.delete(timer.id);
    });
  }

  tick(): void {
    if (this.host.isClosing()) return;
    const now = Date.now();
    for (const timer of this.host.store.listTimers()) {
      let active = this.runningPluginTimers.has(timer.id) || this.submittingTaskTimers.has(timer.id);
      if (timer.activeTaskId) {
        let taskActive = false;
        try {
          taskActive = ['queued', 'running', 'paused', 'waiting_approval'].includes(
            this.host.store.get(timer.activeTaskId).status,
          );
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
        const plannedSlot = Number.isFinite(timer.nextRunAt) ? timer.nextRunAt : now;
        if (timer.once) {
          timer.enabled = false;
          timer.pendingCatchup = false;
          this.triggerTimer(timer, plannedSlot);
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
          this.triggerTimer(timer, plannedSlot);
        }
      } else if (!active && timer.pendingCatchup) {
        this.triggerTimer(timer, Number.isFinite(timer.nextRunAt) ? timer.nextRunAt : now);
      }
    }
  }
}

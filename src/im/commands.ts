import type { ImChannelConfig } from '../store.js';
import type { MainView, ModelHubView, PooledModelEntry } from '../view.js';
import type { ImGatewayContext, ImInboundMessage, ImSendOptions } from './types.js';
import {
  BOT_EXPRESSIONS,
  BOT_EXPRESSION_META,
  normalizeBotExpression,
} from '../web/shared/bot-expressions.js';

export const TELEGRAM_BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: 'start', description: '启动助手并绑定当前会话' },
  { command: 'help', description: '查看常用命令与使用说明' },
  { command: 'status', description: '查看系统运行态势简报' },
  { command: 'works', description: '查看最近后台任务与快捷控制' },
  { command: 'stop', description: '停止进行中的后台任务' },
  { command: 'resume', description: '恢复已暂停的后台任务' },
  { command: 'usage', description: '查看今日模型调用次数、Token 与费用' },
  { command: 'models', description: '查看当前主控模型与调度池状态' },
  { command: 'memories', description: '查看活跃全局记忆卡片' },
  { command: 'timers', description: '查看自主巡航定时任务' },
  { command: 'sticker', description: '发送 F.R.I.D.A.Y. 动态表情包' },
  { command: 'id', description: '查看当前 Chat ID 与个人 ID' },
];

export interface ParsedImSlashCommand {
  command: string;
  arg: string;
  normalized: string;
}

type UsageQueryStore = {
  queryUsage?: (opts?: { granularity?: 'day' | 'week' | 'month' }) => {
    periodLabel?: string;
    todayDate?: string;
    prefs?: { currency?: 'CNY' | 'USD'; usdToCnyRate?: number };
    totals?: {
      calls: number;
      successCalls?: number;
      failedCalls?: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens?: number;
      totalTokens: number;
      costUsd: number;
      costCny: number;
    };
    byModel?: Array<{
      spec: string;
      calls: number;
      totalTokens: number;
      costUsd: number;
      costCny: number;
    }>;
  };
};

type CoordinatorModelHubHost = {
  modelHub?: {
    getView?: () => Promise<ModelHubView> | ModelHubView;
    getModelPool?: () => PooledModelEntry[];
  };
};

/** Parse and normalize an IM slash command, stripping `@bot_username` and lowercasing the command token. */
export function parseImSlashCommand(rawText: string): ParsedImSlashCommand | undefined {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const match = /^(\/[^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return undefined;
  const rawToken = match[1]!;
  if (!/^\/[a-z0-9_-]+(?:@[a-z0-9_.-]+)?$/i.test(rawToken)) {
    return undefined;
  }
  const atIdx = rawToken.indexOf('@');
  const bareToken = atIdx > 1 ? rawToken.slice(0, atIdx) : rawToken;
  const command = bareToken.toLowerCase();
  const arg = (match[2] ?? '').trim();
  return {
    command,
    arg,
    normalized: arg ? `${command} ${arg}` : command,
  };
}

function buildInlineKeyboard(
  buttons: Array<{ text: string; callback_data: string }>,
  perRow = 2,
): Record<string, unknown> | undefined {
  if (!buttons.length) return undefined;
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow));
  }
  return { inline_keyboard: rows };
}

function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function formatMoney(n: number): string {
  return n.toFixed(4);
}

/** Check whether an inbound text message matches an instant IM slash command. */
export function isInstantImCommand(text: string, hasMedia: boolean): boolean {
  if (hasMedia) return false;
  const parsed = parseImSlashCommand(text);
  if (!parsed) return false;
  const { command, arg } = parsed;
  if (command === '/start' || command === '/stop' || command === '/resume' || command === '/sticker' || command === '/stickers') {
    return true;
  }
  if (arg) return false;
  return (
    command === '/help'
    || command === '/status'
    || command === '/brief'
    || command === '/works'
    || command === '/memories'
    || command === '/timers'
    || command === '/usage'
    || command === '/models'
    || command === '/id'
    || command === '/whoami'
  );
}

/** Execute instant IM slash commands (`/start`, `/help`, `/status`, `/works`, `/stop`, `/resume`, `/usage`, `/models`, `/memories`, `/timers`, `/sticker`, `/id`). */
export async function tryHandleImSlashCommand(params: {
  ctx: ImGatewayContext;
  channel: ImChannelConfig;
  inbound: ImInboundMessage;
  text: string;
  replyOpts: ImSendOptions;
}): Promise<{ ok: boolean; action: string } | undefined> {
  const { ctx, channel, inbound, text, replyOpts } = params;
  if (inbound.mediaItems?.length || inbound.telegramMedia?.length) {
    return undefined;
  }
  const parsed = parseImSlashCommand(text);
  if (!parsed) return undefined;

  const { command, arg } = parsed;
  const targetId = inbound.target ?? inbound.senderId;
  const ownTasks = ctx.coordinator.store.list().filter((task) => {
    const o = task.origin;
    return o?.channelId === channel.id
      && o.accountId === channel.accountId
      && o.conversationId === targetId
      && o.senderId === inbound.senderId;
  });

  if (command === '/start') {
    if (targetId && channel.defaultTarget !== targetId) {
      channel.defaultTarget = targetId;
      channel.updatedAt = Date.now();
      ctx.coordinator.store.saveImChannel(channel);
    }
    const startLines = [
      '🤖 你好！我是 F.R.I.D.A.Y. 智能副手。',
      `✅ 已将当前会话 Chat ID (${targetId}) 绑定为默认推送目标。`,
      ...(arg ? [`📌 附带参数: ${arg}`] : []),
      '',
      '你可以直接发送自然语言消息与我对话、下发后台任务或发送图片/文件分析，也可使用下方快捷按钮或 /help 查看全部命令。',
    ];
    const startOpts: ImSendOptions = channel.platform === 'telegram'
      ? {
          ...replyOpts,
          replyMarkup: {
            inline_keyboard: [
              [
                { text: '📊 运行状态', callback_data: '/status' },
                { text: '💰 今日用量', callback_data: '/usage' },
              ],
              [
                { text: '📋 后台任务', callback_data: '/works' },
                { text: '🧠 全局记忆', callback_data: '/memories' },
              ],
              [
                { text: '⏱️ 定时巡检', callback_data: '/timers' },
                { text: '❓ 帮助', callback_data: '/help' },
              ],
            ],
          },
        }
      : replyOpts;
    await ctx.sendToChannel(channel.id, startLines.join('\n'), startOpts).catch(() => {});
    return { ok: true, action: 'command_start' };
  }

  if (command === '/help' && !arg) {
    const helpText = [
      '📖 F.R.I.D.A.Y. 常用命令指南',
      '',
      '📊 系统与模型：',
      '• /status (/brief) — 查看系统运行态势简报',
      '• /usage — 查看今日模型调用次数、Token 与费用',
      '• /models — 查看当前主控模型与调度池状态',
      '• /id (/whoami) — 查看当前 Chat ID 与个人 ID',
      '',
      '📋 后台任务控制：',
      '• /works — 查看最近后台任务与快捷控制',
      '• /stop [ID前缀] — 停止进行中的后台任务',
      '• /resume [ID前缀] — 恢复已暂停的后台任务',
      '',
      '🧠 记忆、定时与互动：',
      '• /memories — 查看活跃全局记忆卡片',
      '• /timers — 查看自主巡航定时任务',
      '• /sticker [表情名|all] — 发送 F.R.I.D.A.Y. 动态表情包',
      '• /file <文件名> — 提取暂存区文件发送给你',
      '',
      '💬 自然语言提示：直接发消息即可对话；发送「派发：…」可启动后台深度任务；直接发图片/文件即可多模态分析。',
    ].join('\n');
    await ctx.sendToChannel(channel.id, helpText, replyOpts).catch(() => {});
    return { ok: true, action: 'command_help' };
  }

  if ((command === '/id' || command === '/whoami') && !arg) {
    const lines = [
      '🪪 当前会话身份信息',
      `• Chat ID: ${targetId}`,
      `• User ID: ${inbound.senderId}`,
      ...(inbound.senderUsername ? [`• Username: @${inbound.senderUsername}`] : []),
      ...(inbound.senderName ? [`• 昵称: ${inbound.senderName}`] : []),
      `• 通道: ${channel.name} (${channel.id})`,
      `• 白名单提示: 可填 ${inbound.senderId}${inbound.senderUsername ? ` 或 @${inbound.senderUsername}` : ''}`,
    ];
    await ctx.sendToChannel(channel.id, lines.join('\n'), replyOpts).catch(() => {});
    return { ok: true, action: 'command_id' };
  }

  if ((command === '/status' || command === '/brief') && !arg) {
    const view = ctx.coordinator.view();
    const activeWorks = view.works
      .filter(w => ownTasks.some(t => t.id === w.id))
      .filter(w => w.status === 'queued' || w.status === 'running');
    const briefText = [
      `🤖 FRIDAY 全息态势简报`,
      `• 运行模式: ${view.mode} (${view.health.status})`,
      `• 在途工作: ${activeWorks.length} 项 (历史共 ${ownTasks.length} 项)`,
      `• 全息记忆: ${view.memoryDirectory?.totalActive ?? 0} 张活跃记忆卡片`,
      `• 巡航定时: ${(view.timers ?? []).filter(t => t.enabled).length}/${(view.timers ?? []).length} 个启用`,
    ].join('\n');
    await ctx.sendToChannel(channel.id, briefText, replyOpts).catch(() => {});
    return { ok: true, action: 'command_status' };
  }

  if (command === '/models' && !arg) {
    const view = ctx.coordinator.view() as MainView & { modelHub?: ModelHubView };
    const hubHost = (ctx.coordinator as unknown as CoordinatorModelHubHost).modelHub;
    let hubView = view.modelHub;
    if (!hubView && hubHost?.getView) {
      try {
        hubView = await hubHost.getView();
      } catch { /* degrade to view.modelTiers */ }
    }
    const tiers = hubView?.tiers ?? view.modelTiers;
    const mode = hubView?.mode ?? view.mode;
    const routerSpec = hubView?.routerProvider && hubView?.routerModel
      ? `${hubView.routerProvider}/${hubView.routerModel}`
      : tiers
        ? `${tiers.provider}/${tiers.router}`
        : '未配置';
    const pool = hubView?.modelPool ?? hubHost?.getModelPool?.() ?? [];
    const lines = [
      `🧠 模型与调度池概况 (${mode})`,
      `• 主控路由 (Router): ${routerSpec}`,
    ];
    if (tiers) {
      lines.push(`• Worker 档位 (${hubView?.workerProvider ?? tiers.provider}): fast=${tiers.fast} | balanced=${tiers.balanced} | strong=${tiers.strong}`);
    }
    if (hubView?.decisionEngine) {
      const d = hubView.decisionEngine;
      lines.push(`• 决策引擎: ${d.model} (${d.enabled && d.configured ? '已启用' : '未启用/未配置'})`);
    }
    if (pool.length > 0) {
      lines.push(`• 模型调度池 (${pool.length} 个):`);
      for (const item of pool.slice(0, 6)) {
        lines.push(`  - ${item.spec} [${item.tier}]`);
      }
      if (pool.length > 6) {
        lines.push(`  - …其余 ${pool.length - 6} 个模型`);
      }
    } else if (tiers?.available?.length) {
      lines.push(`• 可用模型: ${tiers.available.slice(0, 6).join(', ')}${tiers.available.length > 6 ? ' …' : ''}`);
    } else {
      lines.push('• 模型调度池: 暂未配置额外池化模型');
    }
    await ctx.sendToChannel(channel.id, lines.join('\n'), replyOpts).catch(() => {});
    return { ok: true, action: 'command_models' };
  }

  if (command === '/usage' && !arg) {
    const storeWithUsage = ctx.coordinator.store as unknown as UsageQueryStore;
    const report = storeWithUsage.queryUsage?.({ granularity: 'day' });
    if (!report) {
      await ctx.sendToChannel(channel.id, '📊 用量统计服务暂未就绪，请稍后再试。', replyOpts).catch(() => {});
      return { ok: true, action: 'command_usage' };
    }
    const label = report.periodLabel ?? report.todayDate ?? '今日';
    const totals = report.totals;
    if (!totals || totals.calls === 0) {
      const emptyLines = [
        `📊 今日模型用量 (${label})`,
        '• 今日暂无模型调用记录。',
        '• 调用次数: 0 次',
        '• Token 总数: 0',
        '• 折算费用: ¥0.0000 ($0.0000)',
      ];
      await ctx.sendToChannel(channel.id, emptyLines.join('\n'), replyOpts).catch(() => {});
      return { ok: true, action: 'command_usage' };
    }
    const lines = [
      `📊 今日模型用量 (${label})`,
      `• 调用次数: ${totals.calls} 次${totals.failedCalls ? ` (成功 ${totals.successCalls ?? 0} / 失败 ${totals.failedCalls})` : ''}`,
      `• Token 总数: ${formatCount(totals.totalTokens)} (输入 ${formatCount(totals.inputTokens)} / 输出 ${formatCount(totals.outputTokens)} / 缓存读 ${formatCount(totals.cacheReadTokens)}${totals.cacheWriteTokens ? ` / 缓存写 ${formatCount(totals.cacheWriteTokens)}` : ''})`,
      `• 折算费用: ¥${formatMoney(totals.costCny)} ($${formatMoney(totals.costUsd)})${report.prefs?.usdToCnyRate ? ` · 汇率 ${report.prefs.usdToCnyRate}` : ''}`,
    ];
    const topModels = (report.byModel ?? []).slice(0, 5);
    if (topModels.length > 0) {
      lines.push('• Top 模型明细:');
      for (const m of topModels) {
        lines.push(`  - ${m.spec}: ${m.calls}次 · ${formatCount(m.totalTokens)} tok · ¥${formatMoney(m.costCny)} ($${formatMoney(m.costUsd)})`);
      }
    }
    await ctx.sendToChannel(channel.id, lines.join('\n'), replyOpts).catch(() => {});
    return { ok: true, action: 'command_usage' };
  }

  if (command === '/works' && !arg) {
    const works = ownTasks.slice(0, 8);
    const reply = works.length
      ? `📋 最近后台工作:\n` + works.map(w => `• [${w.id.slice(0, 8)}] (${w.status}${w.profile ? `/${w.profile}` : ''}) ${w.prompt}`).join('\n')
      : '📋 当前暂无后台工作。';
    let worksOpts = replyOpts;
    if (channel.platform === 'telegram' && works.length > 0) {
      const buttons: Array<{ text: string; callback_data: string }> = [];
      for (const w of works) {
        const shortId = w.id.slice(0, 8);
        if (w.status === 'queued' || w.status === 'running') {
          buttons.push({ text: `🛑 停止 ${shortId}`, callback_data: `/stop ${shortId}` });
        } else if (w.status === 'paused') {
          buttons.push({ text: `▶️ 恢复 ${shortId}`, callback_data: `/resume ${shortId}` });
        }
      }
      const replyMarkup = buildInlineKeyboard(buttons, 2);
      if (replyMarkup) {
        worksOpts = { ...replyOpts, replyMarkup };
      }
    }
    await ctx.sendToChannel(channel.id, reply, worksOpts).catch(() => {});
    return { ok: true, action: 'command_works' };
  }

  if (command === '/memories' && !arg) {
    const items = ctx.coordinator.store.memoryDirectory(10).items;
    const reply = items.length
      ? `🧠 活跃全局记忆 (${items.length}):\n` + items.map(m => `• ${m.pinned ? '★ ' : ''}[${m.topic}] ${m.preview}`).join('\n')
      : '🧠 当前暂无活跃记忆卡片。';
    await ctx.sendToChannel(channel.id, reply, replyOpts).catch(() => {});
    return { ok: true, action: 'command_memories' };
  }

  if (command === '/timers' && !arg) {
    const timers = ctx.coordinator.store.listTimers();
    const reply = timers.length
      ? `⏱️ 自主巡航定时器:\n` + timers.map(t => `• [${t.id.slice(0, 8)}] (${t.enabled ? '启用' : '暂停'} · 每${Math.round(t.intervalMs / 1000)}s) ${t.name}: ${t.instruction}`).join('\n')
      : '⏱️ 当前暂无自主巡航定时器。';
    await ctx.sendToChannel(channel.id, reply, replyOpts).catch(() => {});
    return { ok: true, action: 'command_timers' };
  }

  if (command === '/stop') {
    if (!arg) {
      const activeTasks = ownTasks.filter(t => t.status === 'queued' || t.status === 'running');
      if (activeTasks.length === 0) {
        await ctx.sendToChannel(channel.id, '📋 当前会话暂无进行中的在途后台工作。', replyOpts).catch(() => {});
        return { ok: true, action: 'command_stop_empty' };
      }
      if (activeTasks.length === 1) {
        const stopped = ctx.coordinator.stop(activeTasks[0]!.id);
        await ctx.sendToChannel(channel.id, `🛑 已请求停止工作 [${stopped.id.slice(0, 8)}]: 状态 ${stopped.status}`, replyOpts).catch(() => {});
        return { ok: true, action: 'command_stop' };
      }
      const listed = activeTasks.slice(0, 8);
      const reply = `🛑 当前有 ${activeTasks.length} 个进行中的工作，请指定前缀或点击按钮停止:\n`
        + listed.map(w => `• [${w.id.slice(0, 8)}] (${w.status}) ${w.prompt}`).join('\n');
      const stopOpts = channel.platform === 'telegram'
        ? {
            ...replyOpts,
            replyMarkup: buildInlineKeyboard(
              listed.map(w => {
                const shortId = w.id.slice(0, 8);
                return { text: `🛑 停止 ${shortId}`, callback_data: `/stop ${shortId}` };
              }),
              2,
            ),
          }
        : replyOpts;
      await ctx.sendToChannel(channel.id, reply, stopOpts).catch(() => {});
      return { ok: true, action: 'command_stop_select' };
    }
    const targetWork = ownTasks.find(t => t.id === arg || t.id.startsWith(arg));
    if (!targetWork) {
      await ctx.sendToChannel(channel.id, `⚠️ 未找到匹配 "${arg}" 的后台工作。`, replyOpts).catch(() => {});
      return { ok: true, action: 'command_stop_not_found' };
    }
    const stopped = ctx.coordinator.stop(targetWork.id);
    await ctx.sendToChannel(channel.id, `🛑 已请求停止工作 [${stopped.id.slice(0, 8)}]: 状态 ${stopped.status}`, replyOpts).catch(() => {});
    return { ok: true, action: 'command_stop' };
  }

  if (command === '/resume') {
    if (!arg) {
      const pausedTasks = ownTasks.filter(t => t.status === 'paused');
      if (pausedTasks.length === 0) {
        await ctx.sendToChannel(channel.id, '📋 当前会话暂无已暂停的后台工作。', replyOpts).catch(() => {});
        return { ok: true, action: 'command_resume_empty' };
      }
      if (pausedTasks.length === 1) {
        try {
          const resumed = ctx.coordinator.resume(pausedTasks[0]!.id);
          await ctx.sendToChannel(channel.id, `▶️ 已恢复运行工作 [${resumed.id.slice(0, 8)}]: 状态 ${resumed.status}`, replyOpts).catch(() => {});
          return { ok: true, action: 'command_resume' };
        } catch (error) {
          const msg = error instanceof Error ? error.message : '恢复失败';
          await ctx.sendToChannel(channel.id, `⚠️ 无法恢复工作 [${pausedTasks[0]!.id.slice(0, 8)}]: ${msg}`, replyOpts).catch(() => {});
          return { ok: true, action: 'command_resume_failed' };
        }
      }
      const listed = pausedTasks.slice(0, 8);
      const reply = `▶️ 当前有 ${pausedTasks.length} 个已暂停的工作，请指定前缀或点击按钮恢复:\n`
        + listed.map(w => `• [${w.id.slice(0, 8)}] ${w.prompt}`).join('\n');
      const resumeOpts = channel.platform === 'telegram'
        ? {
            ...replyOpts,
            replyMarkup: buildInlineKeyboard(
              listed.map(w => {
                const shortId = w.id.slice(0, 8);
                return { text: `▶️ 恢复 ${shortId}`, callback_data: `/resume ${shortId}` };
              }),
              2,
            ),
          }
        : replyOpts;
      await ctx.sendToChannel(channel.id, reply, resumeOpts).catch(() => {});
      return { ok: true, action: 'command_resume_select' };
    }
    const targetWork = ownTasks.find(t => t.id === arg || t.id.startsWith(arg));
    if (!targetWork) {
      await ctx.sendToChannel(channel.id, `⚠️ 未找到匹配 "${arg}" 的暂停工作。`, replyOpts).catch(() => {});
      return { ok: true, action: 'command_resume_not_found' };
    }
    try {
      const resumed = ctx.coordinator.resume(targetWork.id);
      await ctx.sendToChannel(channel.id, `▶️ 已恢复运行工作 [${resumed.id.slice(0, 8)}]: 状态 ${resumed.status}`, replyOpts).catch(() => {});
      return { ok: true, action: 'command_resume' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : '恢复失败';
      await ctx.sendToChannel(channel.id, `⚠️ 无法恢复工作 [${targetWork.id.slice(0, 8)}]: ${msg}`, replyOpts).catch(() => {});
      return { ok: true, action: 'command_resume_failed' };
    }
  }

  if (command === '/sticker' || command === '/stickers') {
    if (!arg) {
      const list = BOT_EXPRESSIONS.map(e => `${e}(${BOT_EXPRESSION_META[e].label})`).join(' · ');
      await ctx.sendToChannel(
        channel.id,
        `🤖 F.R.I.D.A.Y. 动态表情包支持：${list}\n发送 /sticker <表情名>（如 /sticker happy）或 /sticker all 一次领取全套 9 款动图，长按或保存即可添加表情！[[sticker:happy]]`,
        replyOpts,
      ).catch(() => {});
      return { ok: true, action: 'command_sticker_help' };
    }
    if (arg.toLowerCase() === 'all' || arg === '全部') {
      await ctx.sendToChannel(
        channel.id,
        '✨ 正在发送全套 9 款 F.R.I.D.A.Y. 动态表情包，收到后长按或保存即可添加到表情：',
        replyOpts,
      ).catch(() => {});
      for (const expr of BOT_EXPRESSIONS) {
        await ctx.sendToChannel(channel.id, `[[sticker:${expr}]]`, replyOpts).catch(() => {});
      }
      return { ok: true, action: 'command_sticker_all' };
    }
    const expr = normalizeBotExpression(arg);
    if (!expr) {
      await ctx.sendToChannel(
        channel.id,
        `⚠️ 未找到表情 "${arg}"，可选：${BOT_EXPRESSIONS.join(', ')}`,
        replyOpts,
      ).catch(() => {});
      return { ok: true, action: 'command_sticker_not_found' };
    }
    await ctx.sendToChannel(channel.id, `[[sticker:${expr}]]`, replyOpts).catch(() => {});
    return { ok: true, action: 'command_sticker' };
  }

  return undefined;
}

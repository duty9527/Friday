import type { ImChannelConfig } from '../store.js';
import type { ImGatewayContext, ImInboundMessage, ImSendOptions } from './types.js';

/** Check whether an inbound text message matches an instant IM slash command. */
export function isInstantImCommand(text: string, hasMedia: boolean): boolean {
  return !hasMedia && (
    text === '/status'
    || text === '/brief'
    || text === '/works'
    || text === '/memories'
    || text === '/timers'
    || text.startsWith('/stop ')
    || text.startsWith('/resume ')
  );
}

/** Execute instant IM slash commands (`/status`, `/works`, `/memories`, `/timers`, `/stop`, `/resume`). */
export async function tryHandleImSlashCommand(params: {
  ctx: ImGatewayContext;
  channel: ImChannelConfig;
  inbound: ImInboundMessage;
  text: string;
  replyOpts: ImSendOptions;
}): Promise<{ ok: boolean; action: string } | undefined> {
  const { ctx, channel, inbound, text, replyOpts } = params;
  const targetId = inbound.target ?? inbound.senderId;
  const ownTasks = ctx.coordinator.store.list().filter((task) => {
    const o = task.origin;
    return o?.channelId === channel.id
      && o.accountId === channel.accountId
      && o.conversationId === targetId
      && o.senderId === inbound.senderId;
  });

  if (text === '/status' || text === '/brief') {
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

  if (text === '/works') {
    const works = ownTasks.slice(0, 8);
    const reply = works.length
      ? `📋 最近后台工作:\n` + works.map(w => `• [${w.id.slice(0, 8)}] (${w.status}${w.profile ? `/${w.profile}` : ''}) ${w.prompt}`).join('\n')
      : '📋 当前暂无后台工作。';
    await ctx.sendToChannel(channel.id, reply, replyOpts).catch(() => {});
    return { ok: true, action: 'command_works' };
  }

  if (text === '/memories') {
    const items = ctx.coordinator.store.memoryDirectory(10).items;
    const reply = items.length
      ? `🧠 活跃全局记忆 (${items.length}):\n` + items.map(m => `• ${m.pinned ? '★ ' : ''}[${m.topic}] ${m.preview}`).join('\n')
      : '🧠 当前暂无活跃记忆卡片。';
    await ctx.sendToChannel(channel.id, reply, replyOpts).catch(() => {});
    return { ok: true, action: 'command_memories' };
  }

  if (text === '/timers') {
    const timers = ctx.coordinator.store.listTimers();
    const reply = timers.length
      ? `⏱️ 自主巡航定时器:\n` + timers.map(t => `• [${t.id.slice(0, 8)}] (${t.enabled ? '启用' : '暂停'} · 每${Math.round(t.intervalMs / 1000)}s) ${t.name}: ${t.instruction}`).join('\n')
      : '⏱️ 当前暂无自主巡航定时器。';
    await ctx.sendToChannel(channel.id, reply, replyOpts).catch(() => {});
    return { ok: true, action: 'command_timers' };
  }

  if (text.startsWith('/stop ')) {
    const prefix = text.slice(6).trim();
    const targetWork = ownTasks.find(t => t.id === prefix || t.id.startsWith(prefix));
    if (!targetWork) {
      await ctx.sendToChannel(channel.id, `⚠️ 未找到匹配 "${prefix}" 的后台工作。`, replyOpts).catch(() => {});
      return { ok: true, action: 'command_stop_not_found' };
    }
    const stopped = ctx.coordinator.stop(targetWork.id);
    await ctx.sendToChannel(channel.id, `🛑 已请求停止工作 [${stopped.id.slice(0, 8)}]: 状态 ${stopped.status}`, replyOpts).catch(() => {});
    return { ok: true, action: 'command_stop' };
  }

  if (text.startsWith('/resume ')) {
    const prefix = text.slice(8).trim();
    const targetWork = ownTasks.find(t => t.id === prefix || t.id.startsWith(prefix));
    if (!targetWork) {
      await ctx.sendToChannel(channel.id, `⚠️ 未找到匹配 "${prefix}" 的暂停工作。`, replyOpts).catch(() => {});
      return { ok: true, action: 'command_resume_not_found' };
    }
    const resumed = ctx.coordinator.resume(targetWork.id);
    await ctx.sendToChannel(channel.id, `▶️ 已恢复运行工作 [${resumed.id.slice(0, 8)}]: 状态 ${resumed.status}`, replyOpts).catch(() => {});
    return { ok: true, action: 'command_resume' };
  }

  return undefined;
}

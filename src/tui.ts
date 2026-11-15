import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from './protocol.js';
import type { ChatMessage, ContextSearchHit, ImChannelView, MainView, MemoryCard, TraceEvent } from './view.js';

const TERMINAL_ASSISTANT_STATUSES = new Set(['completed', 'failed', 'interrupted']);

/**
 * Resolves a full task ID or short prefix (such as the 8-char ID displayed by `/brief` & `/works`)
 * against known tasks.
 */
export function resolveTaskIdPrefix(inputId: string, tasks: ReadonlyArray<{ id: string }>): string {
  const target = inputId.trim();
  if (!target) throw new Error('任务 ID 不能为空');
  const exact = tasks.find(task => task.id === target);
  if (exact) return exact.id;
  const matches = tasks.filter(task => task.id.startsWith(target));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new Error(`任务 ID 前缀 "${target}" 匹配多个任务 (${matches.slice(0, 5).map(m => m.id.slice(0, 8)).join(', ')})，请提供更长前缀`);
  }
  return target;
}

/** Formats the speaker label for a user message, highlighting cross-channel origins. */
export function formatUserSpeaker(msg: ChatMessage, live = false): string {
  const origin = msg.origin;
  const who = origin?.speakerName ?? origin?.senderId;
  const suffix = who ? `·${who}` : '';
  if (!origin || origin.channel === 'local') {
    return live ? '\x1b[36mWeb/本地\x1b[0m' : '\x1b[36m你\x1b[0m';
  }
  switch (origin.channel) {
    case 'wechat': return `\x1b[35m微信${suffix}\x1b[0m`;
    case 'xiaoai': return `\x1b[35m小爱${suffix}\x1b[0m`;
    case 'telegram': return `\x1b[35mTelegram${suffix}\x1b[0m`;
    case 'dingtalk': return `\x1b[35m钉钉${suffix}\x1b[0m`;
    default: return `\x1b[35m${String(origin.channel)}${suffix}\x1b[0m`;
  }
}

/** Tracks printed message IDs and local TUI request IDs to avoid duplicate or self-echo renders. */
export class TuiMessageDeduper {
  private readonly printedFinalIds = new Set<string>();
  private readonly ownRequestIds = new Set<string>();

  registerOwnRequest(requestId: string): void {
    this.ownRequestIds.add(requestId);
    if (this.ownRequestIds.size > 256) {
      const oldest = this.ownRequestIds.values().next().value;
      if (oldest !== undefined) this.ownRequestIds.delete(oldest);
    }
  }

  seedInitial(messages: ReadonlyArray<ChatMessage>): void {
    for (const msg of messages) {
      if (msg.role === 'user' || TERMINAL_ASSISTANT_STATUSES.has(msg.status)) {
        this.printedFinalIds.add(msg.id);
      }
    }
  }

  shouldPrintPolled(msg: ChatMessage): boolean {
    if (this.printedFinalIds.has(msg.id)) return false;
    if (msg.role === 'user') {
      this.printedFinalIds.add(msg.id);
      if (msg.requestId && this.ownRequestIds.has(msg.requestId)) {
        this.ownRequestIds.delete(msg.requestId);
        return false;
      }
      return true;
    }
    if (msg.role === 'assistant' && TERMINAL_ASSISTANT_STATUSES.has(msg.status)) {
      this.printedFinalIds.add(msg.id);
      return true;
    }
    return false;
  }
}

function formatMessageText(msg: ChatMessage): string {
  if (msg.text) return msg.text;
  if (msg.attachments?.length) {
    return `[附件: ${msg.attachments.map(att => att.name).join(', ')}]`;
  }
  return msg.reason || `(${msg.status})`;
}

export async function startTui(home: string): Promise<void> {
  const initial = await request(home, { command: 'view' }) as MainView;
  let cursor = initial.cursor;
  const deduper = new TuiMessageDeduper();
  deduper.seedInitial(initial.messages.items);

  process.stdout.write(`\x1b[1mF.R.I.D.A.Y. · 全息记忆终端\x1b[0m · 模式: ${initial.mode} · 状态: ${initial.health.status} · 活跃记忆: ${initial.memoryDirectory?.totalActive ?? 0}\n`);
  process.stdout.write(`直接输入与 F.R.I.D.A.Y. 对话；命令: /brief 态势简报 | /memories 查看记忆 | /search <词> 联想检索 | /remember <主题>=<内容> 刻印记忆 | /im 查看IM通道 | /im login 微信扫码绑定 | /works 查看工作 | /timers 查看定时 | /stop <id> | /resume <id> | /quit 退出\n\n`);
  for (const msg of initial.messages.items) {
    const speaker = msg.role === 'user'
      ? formatUserSpeaker(msg, false)
      : msg.source === 'system' ? '\x1b[33m系统\x1b[0m' : '\x1b[32mF.R.I.D.A.Y.\x1b[0m';
    process.stdout.write(`[${speaker}] ${formatMessageText(msg)}\n`);
  }

  let closed = false;
  let pollInFlight = false;
  let qrPollAbort: AbortController | undefined;
  const pollAbort = new AbortController();
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\x1b[36m> \x1b[0m' });
  rl.prompt();

  const pollOnce = async () => {
    if (closed || pollInFlight) return;
    pollInFlight = true;
    try {
      const batch = await request(home, { command: 'updates', after: cursor }) as { events: TraceEvent[]; cursor: number };
      if (!batch.events.length) return;
      cursor = batch.cursor;
      const ids = [...new Set(batch.events.filter(e => e.type === 'message').map(e => e.messageId).filter((id): id is string => Boolean(id)))];
      for (const id of ids) {
        if (closed) return;
        const msg = await request(home, { command: 'message', messageId: id }) as ChatMessage;
        if (!deduper.shouldPrintPolled(msg)) continue;
        const label = msg.role === 'user'
          ? formatUserSpeaker(msg, true)
          : msg.source === 'system' ? '\x1b[33m系统\x1b[0m' : '\x1b[32mF.R.I.D.A.Y.\x1b[0m';
        process.stdout.write(`\r\x1b[K[${label}] ${formatMessageText(msg)}\n`);
        if (!closed) rl.prompt(true);
      }
    } catch {
      /* Transient poll error */
    } finally {
      pollInFlight = false;
    }
  };

  void (async () => {
    while (!closed && !pollAbort.signal.aborted) {
      await pollOnce();
      if (closed || pollAbort.signal.aborted) break;
      await delay(300, undefined, { signal: pollAbort.signal }).catch(() => {});
    }
  })();

  const resolveTaskId = async (shortOrFull: string): Promise<string> => {
    const trimmed = shortOrFull.trim();
    if (!trimmed) throw new Error('请指定任务 ID');
    if (trimmed.length >= 36) return trimmed;
    const tasks = await request(home, { command: 'list' }) as Array<{ id: string }>;
    return resolveTaskIdPrefix(trimmed, tasks);
  };

  rl.on('line', line => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    void (async () => {
      try {
        if (input === '/quit' || input === '/exit') { rl.close(); return; }
        if (input === '/brief') {
          const view = await request(home, { command: 'view' }) as MainView;
          const activeWorks = view.works.filter(w => w.status === 'queued' || w.status === 'running');
          const pending = view.works.filter(w => Boolean(w.pendingQuestion));
          const activeTimers = (view.timers ?? []).filter(t => t.enabled);
          const enabledIm = (view.imChannels ?? []).filter(c => c.enabled);
          process.stdout.write(`  [\x1b[32mF.R.I.D.A.Y. 态势简报\x1b[0m] 健康: ${view.health.status} · 活跃工作: ${activeWorks.length}（待拍板: ${pending.length}） · 记忆卡片: ${view.memoryDirectory?.totalActive ?? 0} · 启用定时: ${activeTimers.length} · 插件: ${(view.plugins ?? []).map(p => p.name).join(', ') || '无'} · IM在线: ${enabledIm.length}\n`);
          for (const item of pending) {
            process.stdout.write(`  ⏳ 待老板拍板 (${item.id.slice(0, 8)}): ${item.pendingQuestion!.question}\n`);
          }
        } else if (input === '/works') {
          const view = await request(home, { command: 'view' }) as MainView;
          for (const work of view.works) {
            const profileTag = work.profile ? `[${work.profile}] ` : '';
            const modelDisplay = work.workerModel
              ? `${work.workerModel}${work.thinkingLevel ? `@${work.thinkingLevel}` : ''}`
              : (work.modelTier ?? '');
            const modelTag = modelDisplay ? `[${modelDisplay}] ` : '';
            const qualityTag = work.qualityGate
              ? (work.qualityGate.skippedByRoute
                  ? ' [质检:免评]'
                  : ` [质检:${work.qualityGate.score.toFixed(1)}/${work.qualityGate.maxScore}]`)
              : '';
            const pendingTag = work.pendingQuestion ? ` [\x1b[33m⏳待拍板: ${work.pendingQuestion.question.slice(0, 48)}\x1b[0m]` : '';
            process.stdout.write(`  - ${work.id.slice(0, 8)} [${work.status}] ${profileTag}${modelTag}${work.prompt}${work.concurrentTaskIds?.length ? ' (同目录并发)' : ''}${qualityTag}${pendingTag}\n`);
          }
        } else if (input === '/memories') {
          const memories = await request(home, { command: 'memory-list' }) as MemoryCard[];
          if (!memories.length) process.stdout.write(`  (暂无活跃记忆卡片)\n`);
          for (const mem of memories) {
            const synInfo = mem.synapses?.length
              ? ` · ⚡突触(${mem.synapses.length}): ${mem.synapses.slice(0, 3).map(s => `${s.targetTopic ?? s.targetId.slice(0, 6)}[${Math.round(s.weight * 100)}%]`).join(', ')}`
              : '';
            process.stdout.write(`  - ${mem.id.slice(0, 8)} [\x1b[35m${mem.topic}\x1b[0m] ${mem.content}${mem.tags.length ? ` (${mem.tags.join(', ')})` : ''}${synInfo}\n`);
          }
        } else if (input === '/search' || input.startsWith('/search ')) {
          const query = input.slice(7).trim();
          if (!query) throw new Error('用法: /search <关键词>');
          const res = await request(home, { command: 'memory-search', query }) as { hits?: ContextSearchHit[] } | ContextSearchHit[];
          const hits = Array.isArray(res) ? res : (res.hits ?? []);
          if (!hits.length) process.stdout.write(`  (未命中相关上下文)\n`);
          for (const hit of hits) {
            const viaInfo = hit.activatedVia
              ? ` [⚡经由「${hit.activatedVia.topic}」扩散 w=${Math.round(hit.activatedVia.weight * 100)}%]`
              : '';
            process.stdout.write(`  - [${hit.kind}:${hit.id.slice(0, 8)}] \x1b[33m${hit.title}\x1b[0m${viaInfo} (score=${hit.score}): ${hit.snippet}\n`);
          }
        } else if (input === '/remember' || input.startsWith('/remember ')) {
          const raw = input.slice(9).trim();
          if (!raw) throw new Error('用法: /remember <主题>=<内容>');
          const sep = raw.indexOf('=');
          const topic = (sep > 0 ? raw.slice(0, sep) : '用户记忆').trim();
          const content = (sep > 0 ? raw.slice(sep + 1) : raw).trim();
          if (!content) throw new Error('记忆内容不能为空');
          const saved = await request(home, { command: 'memory-save', topic, content }) as MemoryCard;
          process.stdout.write(`  已刻印记忆卡片 ${saved.id.slice(0, 8)} [${saved.topic}]: ${saved.content}\n`);
        } else if (input === '/im') {
          const channels = await request(home, { command: 'im-list' }) as ImChannelView[];
          if (!channels.length) process.stdout.write(`  (暂未配置 IM 通道，可输入 /im login 发起微信扫码绑定)\n`);
          for (const ch of channels) {
            const bindInfo = ch.platform === 'wechat'
              ? (ch.hasBotToken ? ` · 已扫码(${ch.accountId ?? 'iLink'})` : ' · 未扫码')
              : '';
            process.stdout.write(`  - ${ch.id.slice(0, 8)} [${ch.platform}] ${ch.name} (${ch.enabled ? '启用' : '暂停'}${bindInfo} · 收:${ch.inboundCount} 发:${ch.outboundCount})\n`);
          }
        } else if (/^\/im\s+(?:login|qr)(?:\s|$)/.test(input)) {
          qrPollAbort?.abort();
          const currentQrAbort = new AbortController();
          qrPollAbort = currentQrAbort;
          const channelId = input.replace(/^\/im\s+(?:login|qr)\s*/, '').trim() || undefined;
          const session = await request(home, { command: 'im-wechat-qr-start', id: channelId }) as Record<string, unknown>;
          if (currentQrAbort.signal.aborted || closed) return;
          process.stdout.write(`\n📱 请使用手机微信扫描下方二维码绑定 FRIDAY (${String(session.channelName ?? '微信通道')}):\n\n${String(session.qrTerminal ?? '')}\n\n链接: ${String(session.qrcodeContent ?? '')}\n⏳ 后台正在等待您手机扫码确认...\n`);
          void (async () => {
            let last = 'wait';
            const deadline = Date.now() + 180_000;
            try {
              while (!closed && !currentQrAbort.signal.aborted && Date.now() < deadline) {
                await delay(1500, undefined, { signal: currentQrAbort.signal }).catch(() => {});
                if (closed || currentQrAbort.signal.aborted) return;
                try {
                  const cur = await request(home, { command: 'im-wechat-qr-status', sessionId: session.sessionId }) as Record<string, unknown>;
                  if (closed || currentQrAbort.signal.aborted) return;
                  const st = String(cur.status ?? 'wait');
                  if (st === 'scaned' && last !== 'scaned') {
                    last = 'scaned';
                    process.stdout.write(`\r\x1b[K📲 [微信扫码] 已扫码，请在手机端点击确认登录...\n`);
                    rl.prompt(true);
                  } else if (st === 'confirmed') {
                    process.stdout.write(`\r\x1b[K✅ [微信扫码] 绑定成功！Bot ID: ${String(cur.accountId ?? '已激活')}，iLink 实时收发已启动。\n`);
                    rl.prompt(true);
                    return;
                  } else if (st === 'expired') {
                    process.stdout.write(`\r\x1b[K⚠️ [微信扫码] 二维码已过期，请重新输入 /im login。\n`);
                    rl.prompt(true);
                    return;
                  } else if (st === 'error') {
                    process.stdout.write(`\r\x1b[K❌ [微信扫码] 绑定失败: ${String(cur.error ?? '未知错误')}\n`);
                    rl.prompt(true);
                    return;
                  }
                } catch { /* Transient poll error */ }
              }
            } finally {
              if (qrPollAbort === currentQrAbort) qrPollAbort = undefined;
            }
          })();
        } else if (input === '/timers') {
          const timers = await request(home, { command: 'timer-list' }) as Array<{ id: string; name: string; intervalMs: number; dailyAt?: string; once?: boolean; enabled: boolean }>;
          for (const timer of timers) {
            const sched = timer.once
              ? (timer.dailyAt ? `单次 ${timer.dailyAt}` : `单次 ${Math.round(timer.intervalMs / 1000)}s`)
              : (timer.dailyAt ? `每日 ${timer.dailyAt}` : `每 ${Math.round(timer.intervalMs / 1000)}s`);
            process.stdout.write(`  - ${timer.id.slice(0, 8)} [${timer.enabled ? '启用' : '关闭'}] ${timer.name} (${sched})\n`);
          }
        } else if (input === '/stop' || input.startsWith('/stop ')) {
          const taskId = await resolveTaskId(input.slice(5));
          const res = await request(home, { command: 'stop', taskId });
          process.stdout.write(`${JSON.stringify(res)}\n`);
        } else if (input === '/resume' || input.startsWith('/resume ')) {
          const taskId = await resolveTaskId(input.slice(7));
          const res = await request(home, { command: 'resume', taskId });
          process.stdout.write(`${JSON.stringify(res)}\n`);
        } else {
          const requestId = randomUUID();
          deduper.registerOwnRequest(requestId);
          await request(home, { command: 'chat', requestId, text: input, files: [] });
        }
      } catch (error) {
        process.stdout.write(`\x1b[31m错误: ${error instanceof Error ? error.message : '请求失败'}\x1b[0m\n`);
      } finally { if (!closed) rl.prompt(); }
    })();
  });

  await new Promise<void>(resolve => {
    rl.once('close', () => {
      closed = true;
      pollAbort.abort();
      qrPollAbort?.abort();
      resolve();
    });
  });
}

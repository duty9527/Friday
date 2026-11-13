import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { request } from './protocol.js';
import type { ChatMessage, ContextSearchHit, ImChannelView, MainView, MemoryCard, TraceEvent } from './view.js';

export async function startTui(home: string): Promise<void> {
  const initial = await request(home, { command: 'view' }) as MainView;
  let cursor = initial.cursor;
  const seenVersions = new Map<string, number>();
  process.stdout.write(`\x1b[1mF.R.I.D.A.Y. · 全息记忆终端\x1b[0m · 模式: ${initial.mode} · 状态: ${initial.health.status} · 活跃记忆: ${initial.memoryDirectory?.totalActive ?? 0}\n`);
  process.stdout.write(`直接输入与 F.R.I.D.A.Y. 对话；命令: /brief 态势简报 | /memories 查看记忆 | /search <词> 联想检索 | /remember <主题>=<内容> 刻印记忆 | /im 查看IM通道 | /im login 微信扫码绑定 | /works 查看工作 | /timers 查看定时 | /stop <id> | /resume <id> | /quit 退出\n\n`);
  for (const msg of initial.messages.items) {
    seenVersions.set(msg.id, msg.version);
    const speaker = msg.role === 'user' ? '\x1b[36m你\x1b[0m' : msg.source === 'system' ? '\x1b[33m系统\x1b[0m' : '\x1b[32mF.R.I.D.A.Y.\x1b[0m';
    process.stdout.write(`[${speaker}] ${msg.text || msg.reason || `(${msg.status})`}\n`);
  }

  let closed = false;
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\x1b[36m> \x1b[0m' });
  rl.prompt();

  const poll = setInterval(() => {
    if (closed) return;
    void (async () => {
      try {
        const batch = await request(home, { command: 'updates', after: cursor }) as { events: TraceEvent[]; cursor: number };
        if (batch.events.length) {
          cursor = batch.cursor;
          const ids = [...new Set(batch.events.filter(e => e.type === 'message').map(e => e.messageId).filter((id): id is string => Boolean(id)))];
          for (const id of ids) {
            const msg = await request(home, { command: 'message', messageId: id }) as ChatMessage;
            const prev = seenVersions.get(msg.id) ?? -1;
            if (msg.version > prev && msg.role === 'assistant' && ['completed', 'failed', 'interrupted'].includes(msg.status)) {
              seenVersions.set(msg.id, msg.version);
              const label = msg.source === 'system' ? '\x1b[33m系统\x1b[0m' : '\x1b[32mF.R.I.D.A.Y.\x1b[0m';
              process.stdout.write(`\r\x1b[K[${label}] ${msg.text || msg.reason || msg.status}\n`);
              rl.prompt(true);
            }
          }
        }
      } catch { /* Transient poll error */ }
    })();
  }, 300);

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
        } else if (input.startsWith('/search ')) {
          const query = input.slice(8).trim();
          const res = await request(home, { command: 'memory-search', query }) as { hits?: ContextSearchHit[] } | ContextSearchHit[];
          const hits = Array.isArray(res) ? res : (res.hits ?? []);
          if (!hits.length) process.stdout.write(`  (未命中相关上下文)\n`);
          for (const hit of hits) {
            const viaInfo = hit.activatedVia
              ? ` [⚡经由「${hit.activatedVia.topic}」扩散 w=${Math.round(hit.activatedVia.weight * 100)}%]`
              : '';
            process.stdout.write(`  - [${hit.kind}:${hit.id.slice(0, 8)}] \x1b[33m${hit.title}\x1b[0m${viaInfo} (score=${hit.score}): ${hit.snippet}\n`);
          }
        } else if (input.startsWith('/remember ')) {
          const raw = input.slice(10).trim();
          const sep = raw.indexOf('=');
          const topic = (sep > 0 ? raw.slice(0, sep) : '用户记忆').trim();
          const content = (sep > 0 ? raw.slice(sep + 1) : raw).trim();
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
        } else if (input.startsWith('/im login') || input.startsWith('/im qr')) {
          const channelId = input.replace(/^\/im\s+(login|qr)\s*/, '').trim() || undefined;
          const session = await request(home, { command: 'im-wechat-qr-start', id: channelId }) as Record<string, unknown>;
          process.stdout.write(`\n📱 请使用手机微信扫描下方二维码绑定 FRIDAY (${String(session.channelName ?? '微信通道')}):\n\n${String(session.qrTerminal ?? '')}\n\n链接: ${String(session.qrcodeContent ?? '')}\n⏳ 后台正在等待您手机扫码确认...\n`);
          void (async () => {
            let last = 'wait';
            const deadline = Date.now() + 180_000;
            while (!closed && Date.now() < deadline) {
              await new Promise(r => setTimeout(r, 1500));
              try {
                const cur = await request(home, { command: 'im-wechat-qr-status', sessionId: session.sessionId }) as Record<string, unknown>;
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
                }
              } catch { /* ignore */ }
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
        } else if (input.startsWith('/stop ')) {
          const res = await request(home, { command: 'stop', taskId: input.slice(6).trim() });
          process.stdout.write(`${JSON.stringify(res)}\n`);
        } else if (input.startsWith('/resume ')) {
          const res = await request(home, { command: 'resume', taskId: input.slice(8).trim() });
          process.stdout.write(`${JSON.stringify(res)}\n`);
        } else {
          await request(home, { command: 'chat', requestId: randomUUID(), text: input, files: [] });
        }
      } catch (error) {
        process.stdout.write(`\x1b[31m错误: ${error instanceof Error ? error.message : '请求失败'}\x1b[0m\n`);
      } finally { if (!closed) rl.prompt(); }
    })();
  });

  await new Promise<void>(resolve => {
    rl.once('close', () => {
      closed = true;
      clearInterval(poll);
      resolve();
    });
  });
}

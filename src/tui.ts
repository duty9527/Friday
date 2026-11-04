import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { request } from './protocol.js';
import type { ChatMessage, MainView, TraceEvent } from './view.js';

export async function startTui(home: string): Promise<void> {
  const initial = await request(home, { command: 'view' }) as MainView;
  let cursor = initial.cursor;
  const seenVersions = new Map<string, number>();
  process.stdout.write(`\x1b[1mSuper-agent (FRIDAY Prototype) TUI\x1b[0m · 模式: ${initial.mode} · 状态: ${initial.health.status}\n`);
  process.stdout.write(`输入消息直接与 Router 对话；命令: /works 查看工作 | /timers 查看定时 | /stop <id> | /resume <id> | /quit 退出界面（后台继续运行）\n\n`);
  for (const msg of initial.messages.items) {
    seenVersions.set(msg.id, msg.version);
    const speaker = msg.role === 'user' ? '\x1b[36m你\x1b[0m' : msg.source === 'system' ? '\x1b[33m系统\x1b[0m' : '\x1b[32mFRIDAY(Router)\x1b[0m';
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
              const label = msg.source === 'system' ? '\x1b[33m系统\x1b[0m' : '\x1b[32mFRIDAY(Router)\x1b[0m';
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
        if (input === '/works') {
          const view = await request(home, { command: 'view' }) as MainView;
          for (const work of view.works) {
            process.stdout.write(`  - ${work.id.slice(0, 8)} [${work.status}] ${work.prompt}${work.concurrentTaskIds?.length ? ' (同目录并发)' : ''}\n`);
          }
        } else if (input === '/timers') {
          const timers = await request(home, { command: 'timer-list' }) as Array<{ id: string; name: string; intervalMs: number; enabled: boolean }>;
          for (const timer of timers) {
            process.stdout.write(`  - ${timer.id.slice(0, 8)} [${timer.enabled ? '启用' : '关闭'}] ${timer.name} (每 ${Math.round(timer.intervalMs / 1000)}s)\n`);
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

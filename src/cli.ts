#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request, socketPath } from './protocol.js';

const help = `F.R.I.D.A.Y. (friday) — Local persistent personal AI assistant & tactical Router/Worker orchestrator (macOS/Linux)

  serve [--mode real|offline] [--offline-delay-ms 100]
  login [provider]   Authenticate via PI OAuth (default: openai Sign in with ChatGPT)
  logout [provider]  Remove stored OAuth credentials (default: openai)
  web [--port 0]   Open the single main conversation via an authenticated local URL
  tui              Interactive terminal chat & work monitor
  watchdog [--interval-ms 2000] [--max-retries 3]
  submit [--file PATH ...] [--limit-ms 600000] [--request-id ID] "instruction"
  followup TASK_ID [--request-id ID] "additional instruction"
  stop TASK_ID
  resume TASK_ID [--limit-ms 600000]
  timer list | add [--name NAME] [--every-ms 60000] [--delay-ms MS] [--daily-at HH:MM] [--once] [--plugin NAME] [--action ACTION] [--channel ID] [--target TARGET] [--cwd DIR] ["instruction"] | toggle ID [--enabled] | remove ID
  plugin list | run NAME [ACTION] [--args JSON]
  memory list | search [--scope all|memories|works|messages] [--cwd DIR] "query" | save --topic TOPIC [--tag TAG ...] [--link ID ...] [--pinned] [--cwd DIR] "content" | link ID TARGET_ID | pin ID [--unpin] | remove ID
  im list | login [CHANNEL_ID] [--name NAME] [--api-base URL] [--no-wait] | add --platform telegram|dingtalk|wechat|xiaoai --name NAME [--bot-token TOKEN] [--account-id ID] [--webhook-url URL] [--secret SECRET] [--target CHAT_ID] [--allow SENDER ...] [--api-base URL] [--every-ms MS] | toggle ID [--enabled] | test ID ["message"] | remove ID | voice ...
  voice status | list | model | enroll [NAME] [--role owner|member] [--append] [--channel ID] [--target ID] [--no-wait] | remove NAME_OR_ID | clear | enable | disable | config [--threshold N] [--wake-precheck|--no-wake-precheck] | rename TARGET NEW_NAME | role TARGET owner|member
  model list | probe [PROVIDER/]MODEL ["prompt"] | set [--router MODEL] [--provider PROVIDER] [--fast MODEL] [--balanced MODEL] [--strong MODEL] [--api-key KEY]
  brief            FRIDAY holographic situation report (health, active works, memory cortex, timers, IM channels)
  get TASK_ID
  list
  events [--after CURSOR]
  health
  shutdown

All commands accept --home DIR (default: ~/.super-agent).
Real mode requires SUPER_AGENT_PROVIDER, SUPER_AGENT_MODEL, SUPER_AGENT_API_KEY
(or prior OAuth login via "friday login"; optional: SUPER_AGENT_BASE_URL, SUPER_AGENT_ROUTER_MODEL, SUPER_AGENT_WORKER_MODEL).
Real mode: Workers have full local read/search/bash/edit/write tools. NOT a sandbox;
commands run as your OS account and can modify files, access outside cwd and use the network.
--file optionally hints a working path; real tasks need no attachment.
Offline mode remains read-only snapshot simulation (32 files, 256 KiB each, 1 MiB total).
The serve command stays in the foreground; use another terminal for web/client commands.
Web binds only 127.0.0.1, connects to the same --home daemon, and prints a private entry link.
Closing the browser or web bridge does not stop the daemon or its background work.
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: 'string' }, mode: { type: 'string' }, file: { type: 'string', multiple: true },
      'limit-ms': { type: 'string' }, 'request-id': { type: 'string' }, after: { type: 'string' },
      'offline-delay-ms': { type: 'string' }, port: { type: 'string' },
      name: { type: 'string' }, 'every-ms': { type: 'string' }, 'delay-ms': { type: 'string' }, 'daily-at': { type: 'string' }, once: { type: 'boolean' },
      plugin: { type: 'string' }, action: { type: 'string' }, channel: { type: 'string' }, args: { type: 'string' },
      cwd: { type: 'string' },
      topic: { type: 'string' }, scope: { type: 'string' }, tag: { type: 'string', multiple: true },
      link: { type: 'string', multiple: true }, pinned: { type: 'boolean' }, unpin: { type: 'boolean' },
      platform: { type: 'string' }, 'bot-token': { type: 'string' }, 'account-id': { type: 'string' }, 'webhook-url': { type: 'string' },
      secret: { type: 'string' }, target: { type: 'string' }, allow: { type: 'string', multiple: true }, 'api-base': { type: 'string' },
      router: { type: 'string' }, provider: { type: 'string' }, fast: { type: 'string' }, balanced: { type: 'string' }, strong: { type: 'string' }, 'api-key': { type: 'string' },
      threshold: { type: 'string' }, role: { type: 'string' }, append: { type: 'boolean' },
      'wake-precheck': { type: 'boolean' }, 'no-wake-precheck': { type: 'boolean' },
      enabled: { type: 'boolean' }, 'no-wait': { type: 'boolean' }, 'interval-ms': { type: 'string' }, 'max-retries': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (values.help || !command) { process.stdout.write(help); return; }
  const home = resolve(values.home ?? resolve(homedir(), '.super-agent'));
  const number = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Numeric options must be nonnegative integers');
    return parsed;
  };
  if (command === 'login' || command === 'logout') {
    const provider = args[0] ?? process.env.SUPER_AGENT_PROVIDER ?? 'openai';
    const { privateHome } = await import('./files.js');
    const verifiedHome = await privateHome(home);
    const { loginOAuth, logoutOAuth } = await import('./agent.js');
    if (command === 'logout') {
      const result = await logoutOAuth(verifiedHome, provider);
      process.stdout.write(JSON.stringify({ status: 'logged_out', ...result }, null, 2) + '\n');
      return;
    }
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once('SIGINT', abort); process.once('SIGTERM', abort);
    try {
      const result = await loginOAuth(verifiedHome, provider, {
        signal: controller.signal,
        notify(event) {
          if (event.type === 'auth_url') {
            process.stderr.write(`\n请在浏览器中打开以下链接完成授权登录:\n${event.url}\n`);
            if (event.instructions) process.stderr.write(`${event.instructions}\n`);
          } else if (event.type === 'device_code') {
            process.stderr.write(`\n请在浏览器中打开: ${event.verificationUri}\n输入设备码: ${event.userCode}\n`);
          } else {
            process.stderr.write(`${event.message}\n`);
          }
        },
        async prompt(authPrompt) {
          if (authPrompt.type === 'select') {
            process.stderr.write(`\n${authPrompt.message}\n`);
            authPrompt.options.forEach((opt, index) => process.stderr.write(`  ${index + 1}. ${opt.label}\n`));
            const answer = await rl.question(`请选择 (1-${authPrompt.options.length}): `, { signal: authPrompt.signal });
            const selected = authPrompt.options[Number.parseInt(answer.trim(), 10) - 1];
            if (!selected) throw new Error('无效的登录方式选择');
            return selected.id;
          }
          const suffix = authPrompt.placeholder ? ` (${authPrompt.placeholder})` : '';
          return rl.question(`${authPrompt.message}${suffix}: `, { signal: authPrompt.signal });
        },
      });
      process.stdout.write(JSON.stringify({
        status: 'logged_in', provider: result.provider, authPath: result.authPath,
        defaultModel: result.provider === 'openai' || result.provider === 'openai-codex' ? 'gpt-6.1-sol' : result.models[0],
        sampleModels: result.models.slice(0, 12),
      }, null, 2) + '\n');
    } finally {
      process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
      rl.close();
    }
    return;
  }
  if (command === 'web') {
    const { startWeb } = await import('./web-server.js');
    const web = await startWeb({ home, port: number(values.port) });
    const close = () => { void web.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    process.stdout.write(JSON.stringify({ status: 'web_ready', url: web.url, home: web.home, pid: process.pid }) + '\n');
    return;
  }
  if (command === 'tui') {
    const { startTui } = await import('./tui.js');
    await startTui(home);
    return;
  }
  if (command === 'watchdog') {
    const { Watchdog } = await import('./watchdog.js');
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const watchdog = new Watchdog({ home, intervalMs: number(values['interval-ms']), maxRetries: number(values['max-retries']) });
    await watchdog.loop(controller.signal);
    process.stdout.write(JSON.stringify(watchdog.state(), null, 2) + '\n');
    return;
  }
  if (command === 'serve') {
    const mode = values.mode ?? 'real';
    if (mode !== 'real' && mode !== 'offline') throw new Error('--mode must be real or offline');
    const offlineDelayMs = number(values['offline-delay-ms']);
    if (offlineDelayMs !== undefined && (mode !== 'offline' || offlineDelayMs > 10_000)) throw new Error('--offline-delay-ms requires offline mode and must be <=10000');
    const { serve } = await import('./server.js');
    const service = await serve({ home, mode, offlineDelayMs,
      provider: process.env.SUPER_AGENT_PROVIDER, model: process.env.SUPER_AGENT_MODEL, apiKey: process.env.SUPER_AGENT_API_KEY,
      baseUrl: process.env.SUPER_AGENT_BASE_URL, routerModel: process.env.SUPER_AGENT_ROUTER_MODEL, workerModel: process.env.SUPER_AGENT_WORKER_MODEL });
    const close = () => { void service.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    process.stdout.write(JSON.stringify({ status: 'ready', home: service.home, mode, execution: mode === 'real' ? 'native' : 'snapshot',
      cwd: process.cwd(), ...(mode === 'real' ? { sandbox: false, tools: ['read', 'ls', 'find', 'grep', 'bash', 'edit', 'write'] } : {}), pid: process.pid }) + '\n');
    return;
  }
  let message: Record<string, unknown>;
  switch (command) {
    case 'submit':
      message = { command, prompt: args.join(' '), files: (values.file ?? []).map(path => resolve(path)), requestId: values['request-id'] ?? randomUUID(), limitMs: number(values['limit-ms']) }; break;
    case 'followup':
      message = { command, taskId: args[0], text: args.slice(1).join(' '), requestId: values['request-id'] ?? randomUUID() }; break;
    case 'get': case 'stop': message = { command, taskId: args[0] }; break;
    case 'resume': message = { command, taskId: args[0], limitMs: number(values['limit-ms']) }; break;
    case 'timer': {
      const sub = args[0] ?? 'list';
      if (sub === 'list') message = { command: 'timer-list' };
      else if (sub === 'add') message = {
        command: 'timer-add',
        name: values.name,
        intervalMs: number(values['every-ms']),
        delayMs: number(values['delay-ms']),
        dailyAt: values['daily-at'],
        once: values.once,
        plugin: values.plugin,
        pluginAction: values.action,
        deliverChannelId: values.channel,
        deliverTarget: values.target,
        cwd: values.cwd ? resolve(values.cwd) : undefined,
        instruction: args.slice(1).join(' ') || undefined,
      };
      else if (sub === 'toggle') message = { command: 'timer-toggle', id: args[1], enabled: values.enabled ?? true };
      else if (sub === 'remove') message = { command: 'timer-remove', id: args[1] };
      else throw new Error(`Unknown timer subcommand: ${sub}`);
      break;
    }
    case 'plugin': {
      const { listPlugins, runPlugin } = await import('./plugin.js');
      const sub = args[0] ?? 'list';
      if (sub === 'list') {
        process.stdout.write(JSON.stringify(await listPlugins(home), null, 2) + '\n');
        return;
      }
      if (sub === 'run') {
        const pluginName = args[1] ?? values.plugin;
        if (!pluginName) throw new Error('Plugin name is required: friday plugin run <name> [action]');
        const pluginAction = args[2] ?? values.action ?? 'status';
        const parsedArgs = values.args ? JSON.parse(values.args) as Record<string, unknown> : {};
        const res = await runPlugin(home, pluginName, pluginAction, parsedArgs);
        process.stdout.write(JSON.stringify(res, null, 2) + '\n');
        return;
      }
      throw new Error(`Unknown plugin subcommand: ${sub}`);
    }
    case 'memory': {
      const sub = args[0] ?? 'list';
      if (sub === 'list') message = { command: 'memory-list', cwd: values.cwd ? resolve(values.cwd) : undefined, topic: values.topic };
      else if (sub === 'search') message = { command: 'memory-search', query: args.slice(1).join(' '), scope: values.scope, cwd: values.cwd ? resolve(values.cwd) : undefined };
      else if (sub === 'save') message = { command: 'memory-save', topic: values.topic ?? 'general', content: args.slice(1).join(' '), tags: values.tag, linkedMemoryIds: values.link, cwd: values.cwd ? resolve(values.cwd) : undefined, pinned: values.pinned };
      else if (sub === 'link') message = { command: 'memory-link', id: args[1], targetId: args[2] };
      else if (sub === 'pin') message = { command: 'memory-pin', id: args[1], pinned: !values.unpin };
      else if (sub === 'remove') message = { command: 'memory-remove', id: args[1] };
      else throw new Error(`Unknown memory subcommand: ${sub}`);
      break;
    }
    case 'im': {
      const sub = args[0] ?? 'list';
      if (sub === 'list') message = { command: 'im-list' };
      else if (sub === 'login' || sub === 'qr') {
        const session = await request(home, {
          command: 'im-wechat-qr-start',
          id: args[1],
          name: values.name,
          apiBase: values['api-base'],
          allowedSenders: values.allow,
        }) as Record<string, unknown>;
        if (values['no-wait']) {
          process.stdout.write(JSON.stringify(session, null, 2) + '\n');
          return;
        }
        process.stderr.write(`\n📱 请使用手机微信扫描下方二维码绑定 FRIDAY (${String(session.channelName ?? '微信通道')}):\n\n`);
        process.stderr.write(`${String(session.qrTerminal ?? '')}\n\n`);
        process.stderr.write(`若终端二维码显示异常，也可复制链接在微信中打开: ${String(session.qrcodeContent ?? '')}\n`);
        process.stderr.write(`⏳ 正在等待手机微信扫码确认...\n`);
        let lastStatus = 'wait';
        const deadline = Date.now() + 180_000;
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 1500));
          const current = await request(home, {
            command: 'im-wechat-qr-status',
            sessionId: session.sessionId,
          }) as Record<string, unknown>;
          const status = String(current.status ?? 'wait');
          if (status === 'scaned' && lastStatus !== 'scaned') {
            lastStatus = 'scaned';
            process.stderr.write(`📲 已扫码！请在手机微信上点击「确认登录」...\n`);
          } else if (status === 'confirmed') {
            process.stderr.write(`✅ 微信扫码绑定成功！Bot ID: ${String(current.accountId ?? '已激活')}\n`);
            process.stdout.write(JSON.stringify(current, null, 2) + '\n');
            return;
          } else if (status === 'expired') {
            throw new Error('二维码已过期，请重新执行 friday im login');
          }
        }
        throw new Error('等待微信扫码超时，请重新执行 friday im login');
      }
      else if (sub === 'add') message = {
        command: 'im-save',
        id: args[1],
        platform: values.platform,
        name: values.name ?? `${values.platform ?? 'im'}-channel`,
        botToken: values['bot-token'],
        accountId: values['account-id'],
        webhookUrl: values['webhook-url'],
        secret: values.secret,
        defaultTarget: values.target,
        allowedSenders: values.allow,
        apiBase: values['api-base'],
        pollIntervalMs: number(values['every-ms']),
        enabled: values.enabled ?? true,
      };
      else if (sub === 'toggle') message = { command: 'im-toggle', id: args[1], enabled: values.enabled ?? true };
      else if (sub === 'test') message = { command: 'im-test', id: args[1], text: args.slice(2).join(' ') || undefined };
      else if (sub === 'remove') message = { command: 'im-remove', id: args[1] };
      else if (sub === 'voice') {
        await runVoiceCli(home, args.slice(1), values);
        return;
      }
      else throw new Error(`Unknown im subcommand: ${sub}`);
      break;
    }
    case 'voice': {
      await runVoiceCli(home, args, values);
      return;
    }
    case 'model': {
      const sub = args[0] ?? 'list';
      if (sub === 'list') message = { command: 'model-hub' };
      else if (sub === 'probe') message = { command: 'model-probe', model: args[1], prompt: args.slice(2).join(' ') || undefined };
      else if (sub === 'set') message = {
        command: 'model-configure',
        providerId: values.provider,
        apiKey: values['api-key'],
        routerModel: values.router,
        workerProvider: values.provider,
        fastModel: values.fast,
        balancedModel: values.balanced,
        strongModel: values.strong,
      };
      else throw new Error(`Unknown model subcommand: ${sub}`);
      break;
    }
    case 'brief': {
      const view = await request(home, { command: 'view' }) as Record<string, unknown>;
      const works = Array.isArray(view.works) ? view.works as Array<Record<string, unknown>> : [];
      const timers = Array.isArray(view.timers) ? view.timers as Array<Record<string, unknown>> : [];
      const plugins = Array.isArray(view.plugins) ? view.plugins as Array<Record<string, unknown>> : [];
      process.stdout.write(JSON.stringify({
        codename: 'FRIDAY',
        mode: view.mode,
        health: view.health,
        activeWorks: works.filter(w => w.status === 'queued' || w.status === 'running'),
        pendingDecisions: works.filter(w => Boolean(w.pendingQuestion)),
        recentWorksCount: works.length,
        memoryDirectory: view.memoryDirectory,
        timers,
        plugins: plugins.map(p => ({ name: p.name, title: p.title, actions: p.actions })),
        imChannels: view.imChannels,
      }, null, 2) + '\n');
      return;
    }
    case 'list': case 'health': case 'shutdown': message = { command }; break;
    case 'events': message = { command, after: number(values.after) }; break;
    default: throw new Error(`Unknown command: ${command}`);
  }
  const result = await request(home, message);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

async function requestVoiceOrLocal(
  home: string,
  payload: Record<string, unknown>,
  localFallback: (manager: InstanceType<typeof import('./xiaoai-speaker.js').XiaoaiSpeakerManager>) => unknown,
): Promise<unknown> {
  if (existsSync(socketPath(home))) {
    try {
      return await request(home, payload);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') {
        throw error;
      }
    }
  }
  const { XiaoaiSpeakerManager } = await import('./xiaoai-speaker.js');
  const manager = new XiaoaiSpeakerManager({ homeDir: home });
  try {
    return localFallback(manager);
  } finally {
    manager.close();
  }
}

async function runVoiceCli(
  home: string,
  args: string[],
  values: {
    name?: string;
    role?: string;
    append?: boolean;
    channel?: string;
    target?: string;
    threshold?: string;
    'wake-precheck'?: boolean;
    'no-wake-precheck'?: boolean;
    'no-wait'?: boolean;
  },
): Promise<void> {
  const sub = args[0] ?? 'status';

  if (sub === 'status' || sub === 'list') {
    const res = await requestVoiceOrLocal(home, { command: 'voice-status' }, m => m.getStatus());
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  if (sub === 'model') {
    const { ensureXiaoaiSpeakerModel } = await import('./xiaoai-speaker.js');
    process.stderr.write('⏳ 检查/下载本地声纹模型 (CAM++ zh-cn 16k)...\n');
    const modelPath = await ensureXiaoaiSpeakerModel({ homeDir: home });
    process.stdout.write(JSON.stringify({ status: 'ready', modelPath }, null, 2) + '\n');
    return;
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    const target = args[1] ?? values.target ?? values.name;
    if (!target) throw new Error('Target speaker name or id is required: friday voice remove NAME_OR_ID');
    const res = await requestVoiceOrLocal(
      home,
      { command: 'voice-remove', target },
      (m) => {
        const out = m.removeSpeaker(target);
        return {
          removed: out.removed,
          ...(out.profile ? { name: out.profile.name, id: out.profile.id } : {}),
          remaining: out.remaining,
        };
      },
    );
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  if (sub === 'clear') {
    const res = await requestVoiceOrLocal(home, { command: 'voice-clear' }, m => m.clearSpeakers());
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const enabled = sub === 'enable';
    const res = await requestVoiceOrLocal(
      home,
      { command: 'voice-config', enabled },
      m => m.configure({ enabled }),
    );
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  if (sub === 'rename') {
    const renameTarget = args[1];
    const renameName = args[2];
    if (!renameTarget || !renameName) {
      throw new Error('Usage: friday voice rename TARGET NEW_NAME');
    }
    const res = await requestVoiceOrLocal(
      home,
      { command: 'voice-config', renameTarget, renameName },
      m => m.configure({ rename: { target: renameTarget, name: renameName } }),
    );
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  if (sub === 'role') {
    const roleTarget = args[1];
    const role = args[2];
    if (!roleTarget || (role !== 'owner' && role !== 'member')) {
      throw new Error('Usage: friday voice role TARGET owner|member');
    }
    const res = await requestVoiceOrLocal(
      home,
      { command: 'voice-config', roleTarget, role },
      m => m.configure({ role: { target: roleTarget, role } }),
    );
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  if (sub === 'config') {
    const threshold = values.threshold === undefined ? undefined : Number(values.threshold);
    if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0.1 || threshold > 0.95)) {
      throw new Error('threshold must be between 0.1 and 0.95');
    }
    const wakePrecheck = values['no-wake-precheck']
      ? false
      : (values['wake-precheck'] ? true : undefined);
    if (threshold === undefined && wakePrecheck === undefined) {
      throw new Error('Specify --threshold N and/or --wake-precheck|--no-wake-precheck');
    }
    const res = await requestVoiceOrLocal(
      home,
      { command: 'voice-config', threshold, wakePrecheck },
      m => m.configure({ threshold, wakePrecheck }),
    );
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return;
  }

  if (sub === 'enroll') {
    if (values.role !== undefined && values.role !== 'owner' && values.role !== 'member') {
      throw new Error('role must be owner or member');
    }
    const { ensureXiaoaiSpeakerModel } = await import('./xiaoai-speaker.js');
    process.stderr.write('⏳ 检查本地声纹模型...\n');
    await ensureXiaoaiSpeakerModel({ homeDir: home });
    const started = await request(home, {
      command: 'voice-enroll-start',
      name: args[1] ?? values.name,
      role: values.role,
      mode: values.append ? 'append' : 'replace',
      channelId: values.channel,
      targetId: values.target,
    }) as { session: Record<string, unknown>; channelId: string; targetId: string };
    if (values['no-wait']) {
      process.stdout.write(JSON.stringify(started, null, 2) + '\n');
      return;
    }

    const sessionId = String(started.session.sessionId ?? '');
    let lastShown = '';
    const printPrompt = (snap: Record<string, unknown>) => {
      const tag = `${String(snap.status ?? '')}:${String(snap.step ?? '')}:${String(snap.message ?? '')}`;
      if (tag !== lastShown) {
        lastShown = tag;
        process.stderr.write(`🎤 ${String(snap.message ?? '')}\n`);
      }
    };
    printPrompt(started.session);

    let aborted = false;
    const onSignal = () => {
      aborted = true;
      void request(home, { command: 'voice-enroll-cancel', sessionId }).catch(() => {});
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    try {
      const deadline = Date.now() + 150_000;
      while (!aborted && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 700));
        if (aborted) break;
        const current = await request(home, {
          command: 'voice-enroll-status',
          sessionId,
        }) as Record<string, unknown>;
        printPrompt(current);
        const status = String(current.status ?? '');
        if (status === 'completed') {
          process.stdout.write(JSON.stringify(current, null, 2) + '\n');
          return;
        }
        if (status === 'failed' || status === 'cancelled') {
          throw new Error(String(current.error ?? current.message ?? '声纹录入已结束'));
        }
      }
      if (aborted) {
        throw new Error('声纹录入已取消');
      }
      await request(home, { command: 'voice-enroll-cancel', sessionId }).catch(() => {});
      throw new Error('等待声纹录入超时');
    } finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  }

  throw new Error(`Unknown voice subcommand: ${sub}`);
}
main().catch(error => {
  process.stderr.write(`friday: ${error instanceof Error ? error.message : 'Command failed'}\n`);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from './protocol.js';

const help = `super-agent — trusted local Router/Worker coding agent (macOS/Linux)

  serve [--mode real|offline] [--offline-delay-ms 100]
  web [--port 0]   Open the single main conversation via an authenticated local URL
  submit [--file PATH ...] [--limit-ms 600000] [--request-id ID] "instruction"
  followup TASK_ID [--request-id ID] "additional instruction"
  stop TASK_ID
  get TASK_ID
  list
  events [--after CURSOR]
  health
  shutdown

All commands accept --home DIR (default: ~/.super-agent).
Real mode requires SUPER_AGENT_PROVIDER, SUPER_AGENT_MODEL, SUPER_AGENT_API_KEY.
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
      'offline-delay-ms': { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' },
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
  if (command === 'web') {
    const { startWeb } = await import('./web-server.js');
    const web = await startWeb({ home, port: number(values.port) });
    const close = () => { void web.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
    process.stdout.write(JSON.stringify({ status: 'web_ready', url: web.url, home: web.home, pid: process.pid }) + '\n');
    return;
  }
  if (command === 'serve') {
    const mode = values.mode ?? 'real';
    if (mode !== 'real' && mode !== 'offline') throw new Error('--mode must be real or offline');
    const offlineDelayMs = number(values['offline-delay-ms']);
    if (offlineDelayMs !== undefined && (mode !== 'offline' || offlineDelayMs > 10_000)) throw new Error('--offline-delay-ms requires offline mode and must be <=10000');
    const { serve } = await import('./server.js');
    const service = await serve({ home, mode, offlineDelayMs,
      provider: process.env.SUPER_AGENT_PROVIDER, model: process.env.SUPER_AGENT_MODEL, apiKey: process.env.SUPER_AGENT_API_KEY });
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
    case 'list': case 'health': case 'shutdown': message = { command }; break;
    case 'events': message = { command, after: number(values.after) }; break;
    default: throw new Error(`Unknown command: ${command}`);
  }
  const result = await request(home, message);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main().catch(error => {
  process.stderr.write(`super-agent: ${error instanceof Error ? error.message : 'Command failed'}\n`);
  process.exitCode = 1;
});

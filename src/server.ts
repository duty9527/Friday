import { createServer, type Socket } from 'node:net';
import { chmod, rm } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { privateHome } from './files.js';
import { realFactory, offlineFactory } from './agent.js';
import { Coordinator } from './coordinator.js';
import { integer, REQUEST_LIMIT, RESPONSE_LIMIT, socketPath, text, type Response } from './protocol.js';

export interface ServiceOptions {
  home: string; mode: 'real' | 'offline'; offlineDelayMs?: number;
  provider?: string; model?: string; apiKey?: string;
  baseUrl?: string; routerModel?: string; workerModel?: string;
}
export async function serve(options: ServiceOptions): Promise<{ home: string; close(): Promise<void> }> {
  if (process.platform === 'win32') throw new Error('This implementation requires Unix sockets (macOS/Linux)');
  process.umask(0o077);
  const home = await privateHome(options.home);
  const path = socketPath(home);
  if (Buffer.byteLength(path) > 100) throw new Error('Data directory path is too long for a Unix socket; use a shorter --home');
  let compromised = false;
  let coordinator: Coordinator | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const release = await lockfile.lock(home, {
    stale: 10_000, update: 2_000, retries: 0,
    onCompromised: () => { compromised = true; void shutdown?.(); },
  });
  const connections = new Set<Socket>();
  const server = createServer(socket => {
    connections.add(socket); socket.on('close', () => connections.delete(socket));
    let buffer = Buffer.alloc(0);
    let handled = false;
    socket.setTimeout(15_000, () => socket.destroy());
    socket.on('error', () => {});
    const reply = (response: Response) => {
      let encoded = JSON.stringify(response) + '\n';
      if (Buffer.byteLength(encoded) > RESPONSE_LIMIT) encoded = JSON.stringify({ ok: false, error: 'Response exceeds limit' }) + '\n';
      socket.end(encoded);
    };
    socket.on('data', chunk => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > REQUEST_LIMIT) { handled = true; reply({ ok: false, error: 'Request exceeds limit' }); return; }
      const newline = buffer.indexOf(10);
      if (newline === -1) return;
      handled = true;
      void (async () => {
        if (compromised || !coordinator) throw new Error('Service does not own its instance lock');
        const message: unknown = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
        if (!message || typeof message !== 'object' || !('command' in message)) throw new Error('Invalid command');
        const command = message as Record<string, unknown>;
        const store = coordinator.store;
        switch (command.command) {
          case 'health': return { mode: options.mode, pid: process.pid, status: coordinator.health().executorAvailable ? 'ready' : 'degraded', ...coordinator.health() };
          case 'view': return coordinator.view();
          case 'chat': {
            const files = command.files ?? [];
            if (!Array.isArray(files) || !files.every(file => typeof file === 'string')) throw new Error('files must be a string array');
            return coordinator.chat(text(command.requestId, 'requestId', 128), text(command.text, 'text'), files.map(file => text(file, 'file path', 4096)));
          }
          case 'chat-stop': return coordinator.stopReply(text(command.messageId, 'messageId', 128));
          case 'message': return store.conversation.get(text(command.messageId, 'messageId', 128));
          case 'history': return store.conversation.history(command.before === undefined ? undefined : integer(command.before, 0, 1, Number.MAX_SAFE_INTEGER));
          case 'trace': return store.conversation.trace({
            messageId: command.messageId === undefined ? undefined : text(command.messageId, 'messageId', 128),
            taskId: command.taskId === undefined ? undefined : text(command.taskId, 'taskId', 128),
          }, command.after === undefined ? undefined : integer(command.after, 0, 0, Number.MAX_SAFE_INTEGER),
            command.before === undefined ? undefined : integer(command.before, 0, 0, Number.MAX_SAFE_INTEGER));
          case 'updates': {
            const after = integer(command.after, 0, 0, Number.MAX_SAFE_INTEGER);
            const events = store.conversation.trace({}, after);
            return { events, cursor: events.at(-1)?.seq ?? after, head: store.conversation.latestSeq() };
          }
          case 'operation': {
            const taskId = text(command.taskId, 'taskId', 128);
            store.get(taskId);
            const operation = store.operationById(text(command.operationId, 'operationId', 128), taskId);
            if (!operation) throw new Error('Operation not found');
            return operation;
          }
          case 'submit': {
            if (command.files === undefined) command.files = [];
            if (!Array.isArray(command.files) || !command.files.every(file => typeof file === 'string')) throw new Error('files must be a string array');
            return coordinator.submit(text(command.requestId, 'requestId', 128), text(command.prompt, 'prompt'),
              command.files.map(file => text(file, 'file path', 4096)), integer(command.limitMs, 600_000, 100, 86_400_000));
          }
          case 'followup': return coordinator.followup(text(command.taskId, 'taskId', 128), text(command.requestId, 'requestId', 128), text(command.text, 'text'));
          case 'stop': return coordinator.stop(text(command.taskId, 'taskId', 128));
          case 'resume': return coordinator.resume(text(command.taskId, 'taskId', 128), integer(command.limitMs, 600_000, 100, 86_400_000));
          case 'timer-list': return store.listTimers();
          case 'timer-add': return coordinator.addTimer(text(command.name ?? '定时任务', 'name', 120), text(command.instruction, 'instruction'),
            integer(command.intervalMs, 60_000, 1_000, 604_800_000), command.cwd === undefined ? undefined : text(command.cwd, 'cwd', 4096));
          case 'timer-toggle': return coordinator.toggleTimer(text(command.id, 'id', 128), Boolean(command.enabled));
          case 'timer-remove': return { removed: coordinator.removeTimer(text(command.id, 'id', 128)) };
          case 'get': {
            const task = store.get(text(command.taskId, 'taskId', 128));
            return { ...task, operations: store.operations(task.id).map(({ result: _result, ...metadata }) => metadata),
              followups: store.events(task.id).map(({ id, text, state }) => ({ id, text, state })) };
          }
          case 'list': return store.list(100).map(({ id, status, mode, createdAt, reason, activeMs, limitMs }) => ({ id, status, mode, createdAt, reason, activeMs, limitMs }));
          case 'events': return store.notices(integer(command.after, 0, 0, Number.MAX_SAFE_INTEGER));
          case 'shutdown': {
            socket.once('close', () => { void shutdown?.(); });
            return { status: 'shutdown_requested' };
          }
          default: throw new Error('Unknown command');
        }
      })().then(result => reply({ ok: true, result }), error => reply({ ok: false, error: error instanceof Error ? error.message : 'Request failed' }));
    });
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    server.close();
    for (const socket of connections) socket.destroy();
    await coordinator?.close();
    if (!compromised) await rm(path, { force: true });
    await release().catch(() => {});
  })();
  shutdown = close;
  try {
    const factory = options.mode === 'offline'
      ? offlineFactory(options.offlineDelayMs)
      : await realFactory(home, options);
    coordinator = new Coordinator(home, factory);
    await coordinator.ready();
    if (compromised) throw new Error('Instance lock was lost during startup');
    await rm(path, { force: true });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => { server.removeListener('error', reject); resolve(); });
    });
    await chmod(path, 0o600);
    return { home, close };
  } catch (error) { await close(); throw error; }
}

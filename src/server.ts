import { createServer, type Socket } from 'node:net';
import { chmod, rm } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { privateHome } from './files.js';
import { realFactory, offlineFactory } from './agent.js';
import { Coordinator } from './coordinator.js';
import { buildMindmapSnapshot } from './mindmap-flow.js';
import { listPlugins, runPlugin } from './plugin.js';
import { integer, REQUEST_LIMIT, RESPONSE_LIMIT, socketPath, text, type Response } from './protocol.js';
import type { ModelTier, ThinkingLevel } from './view.js';

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
          case 'view': return { ...coordinator.view(), modelHub: await coordinator.modelHub.getView() };
          case 'mindmap': return await buildMindmapSnapshot(coordinator, {
            home,
            beforeSeq: command.before === undefined ? undefined : integer(command.before, 0, 1, Number.MAX_SAFE_INTEGER),
            limit: command.limit === undefined ? undefined : integer(command.limit, 120, 1, 200),
          });
          case 'model-hub': return await coordinator.modelHub.getView();
          case 'model-configure': return await coordinator.configureModels({
            providerId: command.providerId === undefined ? undefined : text(command.providerId, 'providerId', 64),
            providerName: command.providerName === undefined ? undefined : text(command.providerName, 'providerName', 80),
            enabled: command.enabled === undefined ? undefined : Boolean(command.enabled),
            apiKey: command.apiKey === undefined ? undefined : String(command.apiKey),
            clearApiKey: command.clearApiKey === undefined ? undefined : Boolean(command.clearApiKey),
            baseUrl: command.baseUrl === undefined ? undefined : String(command.baseUrl),
            customModels: Array.isArray(command.customModels) ? command.customModels.map(m => text(m, 'customModel', 128)) : undefined,
            selectedModels: Array.isArray(command.selectedModels)
              ? command.selectedModels.map(item => {
                  if (typeof item === 'string') return text(item, 'selectedModel', 128);
                  const entry = (item ?? {}) as Record<string, unknown>;
                  return {
                    id: text(entry.id, 'selectedModel.id', 128),
                    ...(entry.tier === undefined ? {} : { tier: text(entry.tier, 'selectedModel.tier', 16) as ModelTier }),
                    ...(Array.isArray(entry.thinkingLevels)
                      ? { thinkingLevels: entry.thinkingLevels.map(level => text(level, 'selectedModel.thinkingLevel', 16) as ThinkingLevel) }
                      : {}),
                  };
                })
              : undefined,
            routerProvider: command.routerProvider === undefined ? undefined : text(command.routerProvider, 'routerProvider', 64),
            routerModel: command.routerModel === undefined ? undefined : text(command.routerModel, 'routerModel', 128),
            workerProvider: command.workerProvider === undefined ? undefined : text(command.workerProvider, 'workerProvider', 64),
            fastModel: command.fastModel === undefined ? undefined : String(command.fastModel),
            balancedModel: command.balancedModel === undefined ? undefined : String(command.balancedModel),
            strongModel: command.strongModel === undefined ? undefined : String(command.strongModel),
            decisionEnabled: command.decisionEnabled === undefined ? undefined : Boolean(command.decisionEnabled),
            decisionApiKey: command.decisionApiKey === undefined ? undefined : String(command.decisionApiKey).slice(0, 512),
            clearDecisionApiKey: command.clearDecisionApiKey === undefined ? undefined : Boolean(command.clearDecisionApiKey),
            decisionBaseUrl: command.decisionBaseUrl === undefined ? undefined : String(command.decisionBaseUrl).slice(0, 512),
          });
          case 'model-probe': return await coordinator.modelHub.probe({
            provider: command.provider === undefined ? undefined : text(command.provider, 'provider', 64),
            model: text(command.model, 'model', 128),
            prompt: command.prompt === undefined ? undefined : text(command.prompt, 'prompt', 1024),
            apiKey: command.apiKey === undefined ? undefined : String(command.apiKey),
            baseUrl: command.baseUrl === undefined ? undefined : String(command.baseUrl),
          });
          case 'model-fetch': return await coordinator.modelHub.fetchModels({
            providerId: text(command.providerId ?? command.provider, 'providerId', 64),
            apiKey: command.apiKey === undefined ? undefined : String(command.apiKey),
            baseUrl: command.baseUrl === undefined ? undefined : String(command.baseUrl),
          });
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
          case 'timer-add': return coordinator.addTimer(
            text(command.name ?? (command.once || command.delayMs !== undefined ? '定时提醒' : '定时任务'), 'name', 120),
            text(command.instruction ?? (command.plugin ? `执行插件 ${String(command.plugin)}/${String(command.pluginAction ?? 'status')}` : '定时巡检'), 'instruction'),
            integer(command.intervalMs ?? (typeof command.intervalSeconds === 'number' ? Math.round(command.intervalSeconds * 1000) : undefined), 60_000, 500, 604_800_000),
            command.cwd === undefined ? undefined : text(command.cwd, 'cwd', 4096),
            undefined,
            {
              dailyAt: command.dailyAt === undefined ? undefined : text(command.dailyAt, 'dailyAt', 16),
              delayMs: command.delayMs === undefined ? undefined : integer(command.delayMs, 60_000, 500, 604_800_000),
              once: command.once === undefined ? undefined : Boolean(command.once),
              plugin: command.plugin === undefined ? undefined : text(command.plugin, 'plugin', 64),
              pluginAction: command.pluginAction === undefined ? undefined : text(command.pluginAction, 'pluginAction', 64),
              deliverChannelId: command.deliverChannelId === undefined ? undefined : text(command.deliverChannelId, 'deliverChannelId', 128),
              deliverTarget: command.deliverTarget === undefined ? undefined : text(command.deliverTarget, 'deliverTarget', 128),
            },
          );
          case 'timer-toggle': return coordinator.toggleTimer(text(command.id, 'id', 128), Boolean(command.enabled));
          case 'timer-remove': return { removed: coordinator.removeTimer(text(command.id, 'id', 128)) };
          case 'plugin-list': return await listPlugins(home);
          case 'plugin-run': return await runPlugin(
            home,
            text(command.plugin, 'plugin', 64),
            command.action === undefined ? 'status' : text(command.action, 'action', 64),
            command.args && typeof command.args === 'object' && !Array.isArray(command.args) ? command.args as Record<string, unknown> : {},
          );
          case 'memory-list': return store.listMemories({
            includeSuperseded: Boolean(command.includeSuperseded),
            cwd: command.cwd === undefined ? undefined : text(command.cwd, 'cwd', 4096),
            topic: command.topic === undefined ? undefined : text(command.topic, 'topic', 160),
            limit: integer(command.limit, 100, 1, 500),
          });
          case 'memory-search': {
            const scope = command.scope === undefined ? 'all' : text(command.scope, 'scope', 32);
            if (!['all', 'memories', 'works', 'messages'].includes(scope)) throw new Error('Invalid search scope');
            return store.searchContext({
              query: text(command.query, 'query', 512),
              scope: scope as 'all' | 'memories' | 'works' | 'messages',
              cwd: command.cwd === undefined ? undefined : text(command.cwd, 'cwd', 4096),
              limit: integer(command.limit, 12, 1, 50),
              includeSuperseded: Boolean(command.includeSuperseded),
            });
          }
          case 'memory-save': return store.saveMemory({
            id: command.id === undefined ? undefined : text(command.id, 'id', 128),
            topic: text(command.topic, 'topic', 160),
            content: text(command.content, 'content', 8192),
            tags: Array.isArray(command.tags) ? command.tags.map(tag => text(tag, 'tag', 64)) : undefined,
            cwd: command.cwd === undefined ? undefined : text(command.cwd, 'cwd', 4096),
            sourceTaskId: command.sourceTaskId === undefined ? undefined : text(command.sourceTaskId, 'sourceTaskId', 128),
            supersedeId: command.supersedeId === undefined ? undefined : text(command.supersedeId, 'supersedeId', 128),
            pinned: command.pinned === undefined ? undefined : Boolean(command.pinned),
            linkedMemoryIds: Array.isArray(command.linkedMemoryIds) ? command.linkedMemoryIds.map(id => text(id, 'linkedMemoryId', 128)) : undefined,
          });
          case 'memory-link': return store.linkMemories(
            text(command.id, 'id', 128),
            text(command.targetId, 'targetId', 128),
            'explicit',
          );
          case 'memory-pin': return store.pinMemory(text(command.id, 'id', 128), command.pinned === undefined ? true : Boolean(command.pinned));
          case 'memory-remove': return { removed: store.deleteMemory(text(command.id, 'id', 128)) };
          case 'im-list': return coordinator.im.listChannels();
          case 'im-save': {
            const platform = text(command.platform, 'platform', 32);
            if (!['telegram', 'dingtalk', 'wechat', 'xiaoai'].includes(platform)) throw new Error('Invalid IM platform');
            return coordinator.im.saveChannel({
              id: command.id === undefined ? undefined : text(command.id, 'id', 128),
              platform: platform as 'telegram' | 'dingtalk' | 'wechat' | 'xiaoai',
              name: text(command.name, 'name', 120),
              enabled: command.enabled === undefined ? undefined : Boolean(command.enabled),
              notifyAll: command.notifyAll === undefined ? undefined : Boolean(command.notifyAll),
              botToken: command.botToken === undefined ? undefined : String(command.botToken),
              accountId: command.accountId === undefined ? undefined : String(command.accountId),
              webhookUrl: command.webhookUrl === undefined ? undefined : String(command.webhookUrl),
              secret: command.secret === undefined ? undefined : String(command.secret),
              defaultTarget: command.defaultTarget === undefined ? undefined : String(command.defaultTarget),
              allowedSenders: Array.isArray(command.allowedSenders) ? command.allowedSenders.map(s => String(s)) : undefined,
              apiBase: command.apiBase === undefined ? undefined : String(command.apiBase),
              pollIntervalMs: command.pollIntervalMs === undefined ? undefined : integer(command.pollIntervalMs, 1500, 100, 300_000),
            });
          }
          case 'im-toggle': return coordinator.im.toggleChannel(text(command.id, 'id', 128), Boolean(command.enabled));
          case 'im-remove': return { removed: coordinator.im.removeChannel(text(command.id, 'id', 128)) };
          case 'im-test': return await coordinator.im.testChannel(text(command.id, 'id', 128), command.text === undefined ? undefined : String(command.text));
          case 'im-wechat-qr-start': return await coordinator.im.startWechatQrLogin({
            id: command.id === undefined ? undefined : text(command.id, 'id', 128),
            name: command.name === undefined ? undefined : text(command.name, 'name', 120),
            apiBase: command.apiBase === undefined ? undefined : String(command.apiBase),
            notifyAll: command.notifyAll === undefined ? undefined : Boolean(command.notifyAll),
            allowedSenders: Array.isArray(command.allowedSenders) ? command.allowedSenders.map(s => String(s)) : undefined,
          });
          case 'im-wechat-qr-status': return await coordinator.im.pollWechatQrLogin(
            text(command.sessionId ?? command.id, 'sessionId', 256),
          );
          case 'im-webhook': return await coordinator.im.handleWebhook(
            text(command.channelId, 'channelId', 128),
            text(command.method ?? 'POST', 'method', 16),
            new URLSearchParams(typeof command.query === 'string' ? command.query : ''),
            (command.headers && typeof command.headers === 'object' && !Array.isArray(command.headers) ? command.headers : {}) as Record<string, string | string[] | undefined>,
            typeof command.rawBody === 'string' ? command.rawBody : '',
          );
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

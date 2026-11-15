import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, writeFile, readFile, rm, stat, utimes, readdir, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { request, resolveRequestTimeoutMs, socketPath } from '../src/protocol.js';
import { Watchdog, type WatchdogState } from '../src/watchdog.js';
import { resolveTaskIdPrefix, formatUserSpeaker, TuiMessageDeduper } from '../src/tui.js';
import type { Task } from '../src/store.js';
import type { ChatMessage, ImChannelView, ModelHubView, PluginView, TimerView } from '../src/view.js';

const cli = resolve('dist/cli.js');
const exec = promisify(execFile);
async function start(home: string, delayMs = 100) {
  const child = spawn(process.execPath, [cli, 'serve', '--home', home, '--mode', 'offline', '--offline-delay-ms', String(delayMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Startup timed out: ${stderr}`)); }, 10_000);
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Service exited ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('"status":"ready"')) { clearTimeout(timeout); resolve(); }
    });
  });
  return child;
}
async function stop(home: string, child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  await request(home, { command: 'shutdown' }).catch(() => child.kill('SIGTERM'));
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([exited, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Service failed to shut down')); }, 5000);
    })]);
  } finally { clearTimeout(timer); }
}
async function poll(home: string, id: string, predicate: (task: Task) => boolean): Promise<Task> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const task = await request(home, { command: 'get', taskId: id }) as Task;
    if (predicate(task)) return task;
    await delay(25);
  }
  throw new Error(`Task did not reach expected state: ${JSON.stringify(await request(home, { command: 'get', taskId: id }))}`);
}
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'friday-e2e-'));
  const home = join(root, 'h'); const file = join(root, 'input.txt');
  await writeFile(file, 'explicit file contents');
  return { root, home, file };
}
const submit = (home: string, file: string, extras = {}) => request(home, { command: 'submit', requestId: randomUUID(), prompt: 'analyze this file', files: [file], ...extras }) as Promise<Task>;

test('CLI and daemon run concurrent tasks, accept follow-ups, cancel deterministically and retain results across restart', { timeout: 25_000 }, async () => {
  const f = await fixture(); let child: ChildProcess | undefined;
  try {
    child = await start(f.home, 150);
    const socket = await stat(join(f.home, 'service.sock'));
    assert.equal(socket.mode & 0o777, 0o600);
    const { stdout } = await exec(process.execPath, [cli, 'submit', '--home', f.home, '--file', f.file, 'first task']);
    const first = JSON.parse(stdout) as Task;
    const second = await submit(f.home, f.file);
    await request(f.home, { command: 'followup', taskId: first.id, requestId: 'f1', text: 'include a follow-up marker' });
    await poll(f.home, second.id, task => task.status === 'running');
    assert.equal((await request(f.home, { command: 'get', taskId: first.id }) as Task).status, 'running');
    const stopped = await request(f.home, { command: 'stop', taskId: second.id }) as Task;
    assert.ok(['paused', 'cancelled'].includes(stopped.status));
    await poll(f.home, second.id, task => task.status === 'cancelled');
    const complete = await poll(f.home, first.id, task => task.status === 'completed');
    assert.match(complete.report!, /OFFLINE SIMULATION/);
    const readOperation = (await request(f.home, { command: 'get', taskId: first.id }) as Task & { operations: Array<{ id: string; fileId: string }> }).operations[0]!;
    assert.equal(readOperation.fileId, 'f0');
    assert.match((await request(f.home, { command: 'operation', taskId: first.id, operationId: readOperation.id }) as { result: string }).result, /explicit file contents/);
    assert.match(complete.report!, /follow-up marker/);
    assert.equal(await realpath(f.file), f.file);
    await assert.rejects(request(f.home, { command: 'followup', taskId: first.id, requestId: 'late', text: 'late' }), /queued or running/);
    await stop(f.home, child); child = await start(f.home);
    assert.equal((await request(f.home, { command: 'get', taskId: first.id }) as Task).report, complete.report);
    assert.equal((await request(f.home, { command: 'get', taskId: second.id }) as Task).status, 'cancelled');
    const events = await request(f.home, { command: 'events', after: 0 }) as Array<{ seq: number }>;
    assert.ok(events.length > 0);
    assert.deepEqual(await request(f.home, { command: 'events', after: events.at(-1)!.seq }), []);
  } finally { if (child) await stop(f.home, child); await rm(f.root, { recursive: true, force: true }); }
});

test('duplicate submissions are idempotent, mismatched reuse and second instances are rejected; active time pauses work', { timeout: 20_000 }, async () => {
  const f = await fixture(); let child: ChildProcess | undefined;
  try {
    child = await start(f.home, 400);
    const id = randomUUID();
    const first = await submit(f.home, f.file, { requestId: id, limitMs: 200 });
    assert.equal((await submit(f.home, f.file, { requestId: id, limitMs: 200 })).id, first.id);
    await assert.rejects(submit(f.home, f.file, { requestId: id, prompt: 'changed' }), /different/);
    await assert.rejects(exec(process.execPath, [cli, 'serve', '--home', f.home, '--mode', 'offline']), /Lock file is already being held/);
    const paused = await poll(f.home, first.id, task => task.status === 'paused');
    assert.match(paused.reason!, /活跃执行时限/);
    assert.ok(paused.activeMs >= 200);
    const queued = await submit(f.home, f.file);
    await stop(f.home, child); child = await start(f.home);
    assert.equal((await request(f.home, { command: 'get', taskId: queued.id }) as Task).status, 'paused');
    assert.ok((await request(f.home, { command: 'get', taskId: first.id }) as Task).activeMs >= 200);
  } finally { if (child) await stop(f.home, child); await rm(f.root, { recursive: true, force: true }); }
});

test('executor death degrades health but leaves daemon controls and persisted results available', { timeout: 15_000 }, async () => {
  const f = await fixture(); let child: ChildProcess | undefined;
  try {
    child = await start(f.home, 25);
    const previous = await submit(f.home, f.file);
    await poll(f.home, previous.id, task => task.status === 'completed');
    const health = await request(f.home, { command: 'health' }) as { executorPid: number };
    process.kill(health.executorPid, 'SIGKILL');
    await delay(100);
    const current = await submit(f.home, f.file);
    const paused = await poll(f.home, current.id, task => task.status === 'paused');
    assert.match(paused.reason!, /读取操作失败或结果未知/);
    assert.equal((await request(f.home, { command: 'health' }) as { status: string }).status, 'degraded');
    assert.equal((await request(f.home, { command: 'get', taskId: previous.id }) as Task).status, 'completed');
    assert.equal((await request(f.home, { command: 'stop', taskId: current.id }) as Task).status, 'paused');
  } finally { if (child) await stop(f.home, child); await rm(f.root, { recursive: true, force: true }); }
});

test('abrupt daemon death pauses persisted in-flight work after stale-lock recovery without replay', { timeout: 15_000 }, async () => {
  const f = await fixture(); let child: ChildProcess | undefined;
  try {
    child = await start(f.home, 1000);
    const task = await submit(f.home, f.file);
    await poll(f.home, task.id, current => current.status === 'running');
    const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
    child.kill('SIGKILL'); await exited;
    // Advance only the lock's staleness clock; this avoids a ten-second wait and does not alter task state.
    const old = new Date(Date.now() - 60_000);
    await utimes(f.home + '.lock', old, old);
    child = await start(f.home);
    const recovered = await request(f.home, { command: 'get', taskId: task.id }) as Task;
    assert.equal(recovered.status, 'paused'); assert.match(recovered.reason!, /服务已重启/);
    assert.equal(recovered.report, undefined);
    assert.equal(recovered.revision, 1);
  } finally { if (child) await stop(f.home, child); await rm(f.root, { recursive: true, force: true }); }
});

test('simultaneous duplicate requests create one task and one snapshot', { timeout: 10_000 }, async () => {
  const f = await fixture(); let child: ChildProcess | undefined;
  try {
    child = await start(f.home);
    const requestId = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => submit(f.home, f.file, { requestId })));
    assert.equal(new Set(results.map(task => task.id)).size, 1);
    assert.equal((await readdir(join(f.home, 'tasks'))).length, 1);
  } finally { if (child) await stop(f.home, child); await rm(f.root, { recursive: true, force: true }); }
});

test('real service startup fails without explicit credentials rather than simulating success', async () => {
  const f = await fixture();
  try {
    const env = { ...process.env };
    delete env.FRIDAY_PROVIDER; delete env.FRIDAY_MODEL; delete env.FRIDAY_API_KEY;
    delete env.SUPER_AGENT_PROVIDER; delete env.SUPER_AGENT_MODEL; delete env.SUPER_AGENT_API_KEY;
    await assert.rejects(exec(process.execPath, [cli, 'serve', '--home', f.home], { env }), /requires (?:FRIDAY_PROVIDER|SUPER_AGENT_PROVIDER)/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});


test('CLI --file accepts a directory and returns nested immutable file records', { timeout: 15000 }, async () => {
  const f = await fixture(); let child: ChildProcess | undefined;
  try {
    const folder = join(f.root, 'project');
    await mkdir(join(folder, 'nested'), { recursive: true });
    await writeFile(join(folder, 'nested', 'note.txt'), 'authorized directory content');
    child = await start(f.home, 20);
    const { stdout } = await exec(process.execPath, [cli, 'submit', '--home', f.home, '--file', folder + '/', 'analyze folder']);
    const task = JSON.parse(stdout) as Task;
    assert.deepEqual(task.files.map(file => file.name), ['project/nested/note.txt']);
    await poll(f.home, task.id, task => task.status === 'completed');
  } finally { if (child) await stop(f.home, child); await rm(f.root, { recursive: true, force: true }); }
});

test('CLI timer/im toggle supports --no-enabled, --enabled, and omitting flag flips server state; voice config --no-wake-precheck works', { timeout: 20_000 }, async () => {
  const f = await fixture(); let child: ChildProcess | undefined;
  try {
    child = await start(f.home, 25);
    const timer = await request(f.home, {
      command: 'timer-add', name: 'toggle-check', intervalMs: 60_000, instruction: 'noop',
    }) as TimerView;
    assert.equal(timer.enabled, true);

    const t1 = JSON.parse((await exec(process.execPath, [cli, 'timer', 'toggle', '--home', f.home, timer.id])).stdout) as TimerView;
    assert.equal(t1.enabled, false);
    const t2 = JSON.parse((await exec(process.execPath, [cli, 'timer', 'toggle', '--home', f.home, timer.id])).stdout) as TimerView;
    assert.equal(t2.enabled, true);
    const t3 = JSON.parse((await exec(process.execPath, [cli, 'timer', 'toggle', '--home', f.home, timer.id, '--no-enabled'])).stdout) as TimerView;
    assert.equal(t3.enabled, false);
    const t4 = JSON.parse((await exec(process.execPath, [cli, 'timer', 'toggle', '--home', f.home, timer.id, '--enabled'])).stdout) as TimerView;
    assert.equal(t4.enabled, true);

    const ch = await request(f.home, {
      command: 'im-save', platform: 'telegram', name: 'tg-toggle', botToken: 'dummy-token', enabled: true,
    }) as ImChannelView;
    assert.equal(ch.enabled, true);
    const c1 = JSON.parse((await exec(process.execPath, [cli, 'im', 'toggle', '--home', f.home, ch.id, '--no-enabled'])).stdout) as ImChannelView;
    assert.equal(c1.enabled, false);
    const c2 = JSON.parse((await exec(process.execPath, [cli, 'im', 'toggle', '--home', f.home, ch.id])).stdout) as ImChannelView;
    assert.equal(c2.enabled, true);
    const c3 = JSON.parse((await exec(process.execPath, [cli, 'im', 'toggle', '--home', f.home, ch.id])).stdout) as ImChannelView;
    assert.equal(c3.enabled, false);

    const vcFalse = JSON.parse((await exec(process.execPath, [cli, 'voice', 'config', '--home', f.home, '--no-wake-precheck'])).stdout) as { wakePrecheck: boolean };
    assert.equal(vcFalse.wakePrecheck, false);
    const vcTrue = JSON.parse((await exec(process.execPath, [cli, 'voice', 'config', '--home', f.home, '--wake-precheck'])).stdout) as { wakePrecheck: boolean };
    assert.equal(vcTrue.wakePrecheck, true);
  } finally { if (child) await stop(f.home, child); await rm(f.root, { recursive: true, force: true }); }
});

test('server preserves caller umask without 0077 poisoning and CLI plugin list/run routes via daemon RPC then privateHome fallback', { timeout: 20_000 }, async () => {
  const f = await fixture(); let child: ChildProcess | undefined;
  try {
    const pluginDir = join(f.home, 'plugins', 'umask-probe');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'umask-probe',
      title: 'Umask Probe',
      description: 'Reports process umask',
      runtime: 'in-process',
      entry: 'index.mjs',
      actions: ['status'],
    }, null, 2));
    await writeFile(join(pluginDir, 'index.mjs'), [
      'export async function runAction(action) {',
      '  const mask = process.umask();',
      '  process.umask(mask);',
      '  return { ok: true, message: "ok", data: { action, umaskOctal: mask.toString(8).padStart(4, "0"), pid: process.pid } };',
      '}',
      '',
    ].join('\n'));

    const prevUmask = process.umask(0o022);
    try {
      child = await start(f.home, 25);
    } finally {
      process.umask(prevUmask);
    }
    const listRpc = JSON.parse((await exec(process.execPath, [cli, 'plugin', 'list', '--home', f.home])).stdout) as PluginView[];
    const probeView = listRpc.find(p => p.name === 'umask-probe');
    assert.ok(probeView);
    assert.equal(probeView.entryPath, undefined);
    assert.equal(probeView.sourceCode, undefined);

    const runRpc = JSON.parse((await exec(process.execPath, [cli, 'plugin', 'run', '--home', f.home, 'umask-probe', 'status'])).stdout) as { data: { pid: number; umaskOctal: string } };
    const health = await request(f.home, { command: 'health' }) as { pid: number };
    assert.equal(runRpc.data.pid, health.pid, 'plugin run should execute through running daemon RPC');
    assert.equal(runRpc.data.umaskOctal, '0022', 'daemon must preserve caller umask instead of forcing 0077');

    await assert.rejects(
      exec(process.execPath, [cli, 'plugin', 'run', '--home', f.home, 'missing-plugin-xyz', 'status']),
      /not found/,
    );

    await stop(f.home, child);
    child = undefined;

    const offlineHome = join(f.root, 'offline-home');
    const listLocal = JSON.parse((await exec(process.execPath, [cli, 'plugin', 'list', '--home', offlineHome])).stdout) as PluginView[];
    assert.ok(Array.isArray(listLocal));
    assert.equal((await stat(offlineHome)).mode & 0o777, 0o700);
  } finally { if (child) await stop(f.home, child); await rm(f.root, { recursive: true, force: true }); }
});

test('CLI model set does not overwrite workerProvider unless --worker-provider is explicitly passed', { timeout: 15_000 }, async () => {
  const f = await fixture(); let child: ChildProcess | undefined;
  try {
    child = await start(f.home, 25);
    const before = await request(f.home, { command: 'model-hub' }) as ModelHubView;
    const afterProviderOnly = JSON.parse((await exec(process.execPath, [
      cli, 'model', 'set', '--home', f.home,
      '--provider', 'deepseek', '--api-key', 'sk-test-123',
      '--base-url', 'https://example.invalid/v1',
      '--router-provider', 'deepseek', '--router', 'deepseek-chat',
    ])).stdout) as ModelHubView;
    assert.equal(afterProviderOnly.workerProvider, before.workerProvider);
    assert.equal(afterProviderOnly.routerProvider, 'deepseek');

    const afterWorkerSet = JSON.parse((await exec(process.execPath, [
      cli, 'model', 'set', '--home', f.home,
      '--worker-provider', 'deepseek', '--fast', 'deepseek-chat',
    ])).stdout) as ModelHubView;
    assert.equal(afterWorkerSet.workerProvider, 'deepseek');
  } finally { if (child) await stop(f.home, child); await rm(f.root, { recursive: true, force: true }); }
});

test('protocol resolves per-command timeouts, honors custom timeoutMs, and Watchdog persists watchdog.json with >= circuit breaker', { timeout: 20_000 }, async () => {
  assert.equal(resolveRequestTimeoutMs({ command: 'health' }), 15_000);
  assert.equal(resolveRequestTimeoutMs({ command: 'plugin-run' }), 90_000);
  assert.equal(resolveRequestTimeoutMs({ command: 'voice-enroll-start' }), 90_000);
  assert.equal(resolveRequestTimeoutMs({ command: 'memory-search' }), 90_000);
  assert.equal(resolveRequestTimeoutMs({ command: 'memory-save' }), 90_000);
  assert.equal(resolveRequestTimeoutMs({ command: 'health' }, { timeoutMs: 250 }), 250);

  const root = await mkdtemp(join(await realpath(tmpdir()), 'friday-proto-'));
  const mockServer = createServer(socket => {
    socket.on('data', () => {
      setTimeout(() => {
        if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, result: { status: 'ready' } }) + '\n');
      }, 250);
    });
  });
  try {
    await new Promise<void>(resolve => mockServer.listen(socketPath(root), () => resolve()));
    await assert.rejects(request(root, { command: 'health' }, { timeoutMs: 80 }), /Service request timed out/);

    const wdHome = join(root, 'wd-home');
    const watchdog = new Watchdog({ home: wdHome, maxRetries: 2, backoffMs: 5 });
    const first = await watchdog.checkOnce();
    assert.equal(first.status, 'recovering');
    assert.equal(first.failures, 1);
    const second = await watchdog.checkOnce();
    assert.equal(second.status, 'circuit_open');
    assert.equal(second.failures, 2);

    const stateStat = await stat(join(wdHome, 'watchdog.json'));
    assert.equal(stateStat.mode & 0o777, 0o600);
    const persisted = JSON.parse(await readFile(join(wdHome, 'watchdog.json'), 'utf8')) as WatchdogState;
    assert.equal(persisted.status, 'circuit_open');
    assert.ok(persisted.notices.some(n => n.kind === 'watchdog_circuit_open'));
    await assert.rejects(access(join(wdHome, 'state.db')));
  } finally {
    mockServer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI watchdog starts/recovers unreachable offline serve daemon and cleans up on SIGINT', { timeout: 20_000 }, async () => {
  const f = await fixture();
  const wd = spawn(process.execPath, [cli, 'watchdog', '--home', f.home, '--mode', 'offline', '--interval-ms', '100', '--max-retries', '3'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const deadline = Date.now() + 12_000;
    let recovered: WatchdogState | undefined;
    while (Date.now() < deadline) {
      try {
        const parsed = JSON.parse(await readFile(join(f.home, 'watchdog.json'), 'utf8')) as WatchdogState;
        if (parsed.status === 'healthy') {
          recovered = parsed;
          break;
        }
      } catch {}
      await delay(100);
    }
    assert.ok(recovered, 'watchdog should restart serve daemon and persist healthy status in watchdog.json');
    const health = await request(f.home, { command: 'health' }) as { status: string };
    assert.equal(health.status, 'ready');

    const exited = new Promise<number | null>(resolve => wd.once('exit', code => resolve(code)));
    wd.kill('SIGINT');
    await exited;
  } finally {
    if (wd.exitCode === null && wd.signalCode === null) wd.kill('SIGKILL');
    await request(f.home, { command: 'shutdown' }, { timeoutMs: 1_000 }).catch(() => {});
    await rm(f.root, { recursive: true, force: true });
  }
});

test('TUI helpers resolve 8-char task ID prefixes, format cross-channel speakers, and deduplicate finished/echoed messages', () => {
  const tasks = [
    { id: '12345678-aaaa-bbbb-cccc-000000000001' },
    { id: 'abcdef12-aaaa-bbbb-cccc-000000000002' },
  ];
  assert.equal(resolveTaskIdPrefix('12345678', tasks), tasks[0]!.id);
  assert.throws(() => resolveTaskIdPrefix('  ', tasks), /不能为空/);
  assert.throws(
    () => resolveTaskIdPrefix('a', [{ id: 'a1111111' }, { id: 'a2222222' }]),
    /匹配多个任务/,
  );

  const wechatUser: ChatMessage = {
    seq: 1, version: 1, id: 'm1', role: 'user', text: 'hi', status: 'completed',
    at: 1, mode: 'offline', paths: [], taskIds: [],
    origin: { channel: 'wechat', speakerName: 'Alice' },
  };
  assert.match(formatUserSpeaker(wechatUser, true), /微信·Alice/);

  const deduper = new TuiMessageDeduper();
  deduper.registerOwnRequest('req-own');
  assert.equal(deduper.shouldPrintPolled({ ...wechatUser, id: 'm-own', requestId: 'req-own', origin: undefined }), false);
  assert.equal(deduper.shouldPrintPolled(wechatUser), true);
  assert.equal(deduper.shouldPrintPolled({ ...wechatUser, version: 2 }), false);

  const assistantMsg: ChatMessage = {
    seq: 2, version: 1, id: 'm2', role: 'assistant', text: 'done', status: 'completed',
    at: 2, mode: 'offline', paths: [], taskIds: [],
  };
  assert.equal(deduper.shouldPrintPolled(assistantMsg), true);
  assert.equal(deduper.shouldPrintPolled({ ...assistantMsg, version: 5 }), false);
});

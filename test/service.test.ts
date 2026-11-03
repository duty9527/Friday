import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, writeFile, rm, stat, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { request } from '../src/protocol.js';
import type { Task } from '../src/store.js';

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
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-e2e-'));
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
    delete env.SUPER_AGENT_PROVIDER; delete env.SUPER_AGENT_MODEL; delete env.SUPER_AGENT_API_KEY;
    await assert.rejects(exec(process.execPath, [cli, 'serve', '--home', f.home], { env }), /requires SUPER_AGENT_PROVIDER/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, symlink, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshot, readSnapshot, FILE_LIMIT, privateHome } from '../src/files.js';
import { Store, type Task } from '../src/store.js';
import { Executor } from '../dist/executor.js';

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-state-'));
  const home = await privateHome(join(root, 'home'));
  return { root, home, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('file copies are independent, UTF-8 and integrity checked; links and oversized data rejected', async () => {
  const f = await fixture();
  try {
    const input = join(f.root, 'note.md');
    await writeFile(input, '你好, original');
    const id = randomUUID();
    const files = await snapshot(f.home, id, [input]);
    await writeFile(input, 'changed');
    assert.equal(await readSnapshot(f.home, id, files[0]!), '你好, original');
    await symlink(input, join(f.root, 'link'));
    await assert.rejects(snapshot(f.home, randomUUID(), [join(f.root, 'link')]), /Symbolic/);
    await mkdir(join(f.root, 'directory'));
    await assert.rejects(snapshot(f.home, randomUUID(), [join(f.root, 'directory')]), /No regular files/);
    await writeFile(input, Buffer.alloc(FILE_LIMIT + 1, 65));
    await assert.rejects(snapshot(f.home, randomUUID(), [input]), /exceeds/);
    await writeFile(input, Buffer.alloc(FILE_LIMIT, 65));
    const largeInputs = await Promise.all(Array.from({ length: 5 }, async (_, index) => {
      const path = join(f.root, `large-${index}.txt`);
      await writeFile(path, Buffer.alloc(FILE_LIMIT, 65));
      return path;
    }));
    await assert.rejects(snapshot(f.home, randomUUID(), largeInputs), /Total input/);
    await assert.rejects(snapshot(f.home, randomUUID(), []), /between 1 and 32/);
    await writeFile(input, Buffer.from([0xff, 0xfe]));
    await assert.rejects(snapshot(f.home, randomUUID(), [input]));
    await assert.rejects(readSnapshot(f.home, id, { ...files[0]!, id: '../../state.sqlite' }), /identity/);
  } finally { await f.cleanup(); }
});

test('SQLite preserves results, deduplicates follow-ups and pauses unknown work on restart', async () => {
  const f = await fixture();
  try {
    const store = new Store(f.home);
    const task: Task = { id: randomUUID(), requestId: 'r1', fingerprint: 'fp', prompt: 'analyze', status: 'running', revision: 0, files: [], mode: 'offline', createdAt: Date.now(), limitMs: 100, activeMs: 20 };
    store.create(task);
    assert.equal(store.byRequest('r1')?.id, task.id);
    assert.equal(store.addEvent('e1', task.id, 'follow up'), true);
    assert.equal(store.addEvent('e1', task.id, 'follow up'), false);
    assert.throws(() => store.addEvent('e1', task.id, 'different'), /different/);
    store.operation({ id: 'o1', taskId: task.id, revision: 0, fileId: 'f0', status: 'started' });
    store.close();
    const reopened = new Store(f.home);
    reopened.recover();
    assert.equal(reopened.get(task.id).status, 'paused');
    assert.equal(reopened.get(task.id).activeMs, 20);
    assert.equal(reopened.operations(task.id)[0]?.status, 'unknown');
    assert.ok(reopened.notices().length >= 3);
    reopened.close();
  } finally { await f.cleanup(); }
});

test('independent executor reads only IDs with matching snapshot digests and deduplicates operations', async () => {
  const f = await fixture();
  let executor: Executor | undefined;
  try {
    const input = join(f.root, 'note.txt'); await writeFile(input, 'safe input');
    const taskId = randomUUID();
    const [file] = await snapshot(f.home, taskId, [input]);
    executor = new Executor(f.home, () => {});
    await executor.ready;
    const op = { id: randomUUID(), taskId, revision: 0, fileId: file!.id, status: 'requested' as const };
    const result = await executor.start(op, file!);
    assert.equal(result.status, 'succeeded'); assert.equal(result.result, 'safe input');
    assert.deepEqual(await executor.start(op, file!), result);
    await assert.rejects(executor.start(op, { ...file!, sha256: 'changed' }), /mismatch/);
    const corrupt = await executor.start({ ...op, id: randomUUID() }, { ...file!, sha256: 'wrong' });
    assert.equal(corrupt.status, 'failed');
  } finally { await executor?.close(); await f.cleanup(); }
});

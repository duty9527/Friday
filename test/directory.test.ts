import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshot, readSnapshot } from '../src/files.js';

test('directory authorization includes nested files, preserves names and deduplicates overlapping paths', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-dir-'));
  try {
    const dir = join(root, 'project'); const home = join(root, 'home');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'note.txt'), 'root text');
    await writeFile(join(dir, 'nested', 'note.txt'), 'nested text');
    await writeFile(join(root, 'outside.txt'), 'not authorized');
    const id = randomUUID();
    const files = await snapshot(home, id, [dir + '/', join(dir, 'nested', 'note.txt')]);
    assert.deepEqual(files.map(file => file.name), ['project/nested/note.txt', 'project/note.txt']);
    assert.deepEqual(await Promise.all(files.map(file => readSnapshot(home, id, file))), ['nested text', 'root text']);
    await writeFile(join(dir, 'note.txt'), 'changed');
    assert.equal(await readSnapshot(home, id, files[1]!), 'root text');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('directory input refuses links, binary data, empty trees and oversized trees without partial snapshots', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-dir-'));
  try {
    const home = join(root, 'home'); const dir = join(root, 'input');
    await mkdir(dir); await writeFile(join(root, 'secret'), 'outside');
    await assert.rejects(snapshot(home, randomUUID(), [dir]), /No regular files/);
    await symlink(join(root, 'secret'), join(dir, 'escape'));
    const id = randomUUID();
    await assert.rejects(snapshot(home, id, [dir]), /Symbolic/);
    await assert.rejects(access(join(home, 'tasks', id)));
    await rm(join(dir, 'escape')); await writeFile(join(dir, 'binary'), Buffer.from([0]));
    await assert.rejects(snapshot(home, randomUUID(), [dir]), /Binary/);
    await rm(join(dir, 'binary'));
    for (let i = 0; i < 33; i++) await writeFile(join(dir, `${i}.txt`), 'text');
    await assert.rejects(snapshot(home, randomUUID(), [dir]), /32/);
    await rm(dir, { recursive: true }); await mkdir(dir);
    for (let i = 0; i < 5; i++) await writeFile(join(dir, `${i}.txt`), Buffer.alloc(256 * 1024, 65));
    await assert.rejects(snapshot(home, randomUUID(), [dir]), /Total input/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

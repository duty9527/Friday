import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, symlink, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snapshot, readSnapshot, FILE_LIMIT, privateHome } from '../src/files.js';
import { DatabaseSync } from 'node:sqlite';
import { Store, type Task } from '../src/store.js';
import { Executor } from '../src/executor.js';

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

test('Store enforces busy_timeout/FK cascade migration, unique short ID lookup, paginated list, and lightweight touchMemory', async () => {
  const f = await fixture();
  try {
    // 1) Seed legacy SQLite database without FK on memory_embeddings and with an orphaned embedding row
    const legacyDb = new DatabaseSync(join(f.home, 'state.sqlite'));
    legacyDb.exec(`
      CREATE TABLE memories(id TEXT PRIMARY KEY, topic TEXT NOT NULL, cwd TEXT, superseded_by TEXT, updated_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE memory_embeddings(memory_id TEXT PRIMARY KEY, model_id TEXT NOT NULL, dim INTEGER NOT NULL, content_hash TEXT NOT NULL, vector BLOB NOT NULL, updated_at INTEGER NOT NULL);
    `);
    const survivingCard = {
      id: 'mem-survive-1',
      topic: 'Legacy card',
      content: 'Legacy content',
      tags: ['legacy'],
      importance: 45,
      accessCount: 2,
      createdAt: 1000,
      updatedAt: 1000,
    };
    legacyDb.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?)').run(
      survivingCard.id, survivingCard.topic, null, null, 1000, JSON.stringify(survivingCard),
    );
    legacyDb.prepare('INSERT INTO memory_embeddings VALUES(?,?,?,?,?,?)').run(
      survivingCard.id, 'custom', 2, 'hash-ok', new Uint8Array(8), 1000,
    );
    legacyDb.prepare('INSERT INTO memory_embeddings VALUES(?,?,?,?,?,?)').run(
      'orphan-missing-mem', 'custom', 2, 'hash-orphan', new Uint8Array(8), 1000,
    );
    legacyDb.close();

    // Opening Store migrates memory_embeddings FK + memories columns and deletes orphans safely
    const store = new Store(f.home);
    const storeDb = (store as unknown as { sqlite: { db: DatabaseSync } }).sqlite.db;
    assert.equal((storeDb.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
    assert.equal((storeDb.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);

    const verifyDb = new DatabaseSync(join(f.home, 'state.sqlite'));
    try {
      const fks = verifyDb.prepare('PRAGMA foreign_key_list(memory_embeddings)').all() as Array<Record<string, unknown>>;
      assert.ok(fks.some(fk => fk.table === 'memories' && String(fk.on_delete).toUpperCase() === 'CASCADE'));
      const orphanCount = Number(verifyDb.prepare('SELECT count(*) AS cnt FROM memory_embeddings WHERE memory_id=?').get('orphan-missing-mem')!.cnt);
      assert.equal(orphanCount, 0, 'migration removes orphaned embeddings before adding FK');

      // Delete memory directly via Store -> ON DELETE CASCADE cleans memory_embeddings
      assert.equal(store.deleteMemory(survivingCard.id), true);
      const remainingEmbeddings = Number(verifyDb.prepare('SELECT count(*) AS cnt FROM memory_embeddings').get()!.cnt);
      assert.equal(remainingEmbeddings, 0, 'ON DELETE CASCADE removes child embedding row');
    } finally {
      verifyDb.close();
    }

    // 2) Lightweight touchMemory increments SQLite columns without stale reads on reopen
    const card = store.saveMemory({ topic: 'Touch test', content: 'Body payload', tags: ['ops'], importance: 40 });
    const t1 = store.touchMemory(card.id);
    assert.equal(t1?.accessCount, 1);
    const t2 = store.touchMemory(card.id, { active: true });
    assert.equal(t2?.accessCount, 2);
    assert.equal(t2?.importance, 45);
    assert.ok(t2?.lastAccessedAt && t2?.lastReinforcedAt);

    // 3) Short ID lookup (unique >= 6 chars, reject < 6 chars, reject ambiguous)
    const taskBase = {
      requestId: 'req-short-1',
      fingerprint: 'fp-s1',
      prompt: 'first short id task',
      status: 'completed' as const,
      revision: 0,
      files: [],
      mode: 'offline' as const,
      createdAt: Date.now(),
      limitMs: 60_000,
      activeMs: 10,
    };
    const tA = { ...taskBase, id: 'abc12311-1111-4111-8111-111111111111', requestId: 'r-1' };
    const tB = { ...taskBase, id: 'abc12322-2222-4222-8222-222222222222', requestId: 'r-2' };
    const tC = { ...taskBase, id: 'def45633-3333-4333-8333-333333333333', requestId: 'r-3' };
    store.create(tA);
    store.create(tB);
    store.create(tC);

    assert.equal(store.get('def456').id, tC.id, 'unique 6-char prefix resolves full task');
    assert.equal(store.get('abc1231').id, tA.id, 'unique 7-char prefix disambiguates task');
    assert.throws(() => store.get('def45'), /Task not found/);
    assert.throws(() => store.get('abc123'), /Ambiguous task ID prefix/);
    assert.deepEqual(store.list({ limit: 2, offset: 1 }).map(t => t.id), [tA.id, tB.id]);

    store.close();
    const reopened = new Store(f.home);
    assert.equal(reopened.getMemory(card.id).accessCount, 2);
    assert.equal(reopened.getMemory(card.id).importance, 45);
    reopened.close();
  } finally {
    await f.cleanup();
  }
});

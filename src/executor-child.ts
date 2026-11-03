import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { readSnapshot, type InputFile } from './files.js';
import type { Operation } from './store.js';

const home = process.argv[2];
if (!home || !process.send) throw new Error('Executor must be started by the coordinator');
const db = new DatabaseSync(join(home, 'executor.sqlite'));
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body TEXT NOT NULL)');
const running = new Map<string, { cancelled: boolean }>();
let disconnected = false;
function send(op: Operation) { if (process.connected) process.send?.(op); }
function persist(op: Operation, fingerprint: string) {
  db.prepare('INSERT INTO operations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(op.id, fingerprint, JSON.stringify(op));
}
async function start(op: Operation, file: InputFile) {
  const fingerprint = JSON.stringify({ taskId: op.taskId, revision: op.revision, file });
  const previous = db.prepare('SELECT * FROM operations WHERE id=?').get(op.id);
  if (previous) {
    if (previous.fingerprint !== fingerprint) {
      send({ ...op, status: 'failed', error: 'Operation ID parameter mismatch' });
      return;
    }
    if (!running.has(op.id)) {
      const saved = JSON.parse(String(previous.body)) as Operation;
      if (saved.status === 'requested' || saved.status === 'started') saved.status = 'unknown';
      send(saved);
    }
    return;
  }
  persist(op, fingerprint);
  const state = { cancelled: false };
  running.set(op.id, state);
  op.status = 'started'; persist(op, fingerprint); send(op);
  try {
    const result = await readSnapshot(home!, op.taskId, file);
    op.status = state.cancelled ? 'cancelled' : 'succeeded';
    if (!state.cancelled) op.result = result;
  } catch {
    op.status = state.cancelled ? 'cancelled' : 'failed';
    op.error = state.cancelled ? 'Read cancelled' : 'Snapshot read or integrity check failed';
  } finally {
    persist(op, fingerprint); send(op); running.delete(op.id);
    if (disconnected && !running.size) { db.close(); process.exit(0); }
  }
}
process.on('message', (message: { type?: string; op?: Operation; file?: InputFile; id?: string }) => {
  if (message.type === 'start' && message.op && message.file) {
    void start(message.op, message.file).catch(() => process.exit(1));
  } else if (message.type === 'stop' && message.id) {
    const state = running.get(message.id);
    if (state) state.cancelled = true;
  }
});
process.on('disconnect', () => {
  disconnected = true;
  for (const state of running.values()) state.cancelled = true;
  if (!running.size) { db.close(); process.exit(0); }
});
process.send({ ready: true });

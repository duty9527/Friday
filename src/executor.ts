import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { InputFile } from './files.js';
import type { Operation } from './store.js';

export class Executor {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, { resolve: (op: Operation) => void; fingerprint: string; promise: Promise<Operation> }>();
  private readonly finished = new Map<string, { fingerprint: string; op: Operation }>();
  readonly ready: Promise<void>;
  private dead = false;
  constructor(home: string, private readonly update: (op: Operation) => void) {
    this.child = fork(fileURLToPath(new URL('./executor-child.js', import.meta.url)), [home], {
      env: {}, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Executor startup timed out')), 10_000);
      this.child.on('message', (message: Operation & { ready?: boolean }) => {
        if (message.ready) { clearTimeout(timer); resolve(); return; }
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.update(message);
        if (!['started', 'requested'].includes(message.status)) {
          this.pending.delete(message.id);
          this.finished.set(message.id, { fingerprint: entry.fingerprint, op: message });
          if (this.finished.size > 128) this.finished.delete(this.finished.keys().next().value!);
          entry.resolve(message);
        }
      });
      this.child.once('error', error => { clearTimeout(timer); reject(error); });
      this.child.once('exit', () => {
        clearTimeout(timer); this.dead = true; reject(new Error('Executor exited'));
        for (const [id, entry] of this.pending) {
          const op: Operation = { ...JSON.parse(entry.fingerprint).op, id, status: 'unknown', error: 'Executor disconnected; no automatic replay' };
          this.update(op); entry.resolve(op);
        }
        this.pending.clear();
      });
    });
  }
  get pid() { return this.child.pid; }
  get available() { return !this.dead && this.child.connected; }
  start(op: Operation, file: InputFile): Promise<Operation> {
    const fingerprint = JSON.stringify({ op, file });
    const prior = this.pending.get(op.id) ?? this.finished.get(op.id);
    if (prior && prior.fingerprint !== fingerprint) return Promise.reject(new Error('Operation ID parameter mismatch'));
    if (this.pending.has(op.id)) return this.pending.get(op.id)!.promise;
    const completed = this.finished.get(op.id);
    if (completed) return Promise.resolve(completed.op);
    if (this.dead || !this.child.connected) return Promise.reject(new Error('Executor is unavailable'));
    let finish!: (value: Operation) => void;
    const promise = new Promise<Operation>(resolve => { finish = resolve; });
    this.pending.set(op.id, { resolve: finish, fingerprint, promise });
    this.update(op);
    this.child.send({ type: 'start', op, file }, error => {
      if (!error) return;
      const entry = this.pending.get(op.id);
      if (!entry) return;
      this.pending.delete(op.id);
      const unknown: Operation = { ...op, status: 'unknown', error: 'Executor delivery failed; no automatic replay' };
      this.update(unknown); entry.resolve(unknown);
    });
    return promise;
  }
  stop(id: string) {
    if (!this.dead && this.child.connected) this.child.send({ type: 'stop', id }, () => {});
  }
  async close() {
    if (this.dead) return;
    await new Promise<void>(resolve => {
      const kill = setTimeout(() => this.child.kill('SIGKILL'), 1000);
      this.child.once('exit', () => { clearTimeout(kill); resolve(); });
      if (this.child.connected) this.child.disconnect();
    });
  }
}

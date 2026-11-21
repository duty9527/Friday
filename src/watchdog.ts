import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { request, socketPath } from './protocol.js';

const execFileAsync = promisify(execFile);

export interface WatchdogNotice {
  kind: string;
  text: string;
  at: number;
}

export interface WatchdogOptions {
  home: string;
  intervalMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  restartService?: () => Promise<void>;
}

export interface WatchdogState {
  status: 'healthy' | 'recovering' | 'circuit_open';
  failures: number;
  maxRetries: number;
  lastCheckedAt: number;
  lastError?: string;
  notices: WatchdogNotice[];
}

export interface ManagedServeOptions {
  home: string;
  entryScript: string;
  execPath?: string;
  execArgv?: string[];
  mode?: 'real' | 'offline';
  systemdUnit?: string;
  serveArgs?: string[];
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export interface ManagedServeRestarter {
  restartService: () => Promise<void>;
  stop: () => Promise<void>;
  detach?: () => void;
}

const MAX_WATCHDOG_NOTICES = 50;

async function waitForSocketRemoval(sockPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(sockPath);
      await delay(80);
    } catch {
      return;
    }
  }
}

async function stopChildProcess(child: ChildProcess | undefined, timeoutMs: number): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    let finished = false;
    let killWait: NodeJS.Timeout | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (killWait) clearTimeout(killWait);
      resolve();
    };
    child.once('exit', finish);
    try {
      child.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      killWait = setTimeout(finish, 1_500);
      killWait.unref();
    }, timeoutMs);
    timer.unref();
  });
}

/**
 * Creates a controlled daemon restarter for `friday watchdog`.
 * Restarts either a configured systemd `--user` unit or a managed `serve` child process.
 */
export function createManagedServeRestarter(options: ManagedServeOptions): ManagedServeRestarter {
  let managedChild: ChildProcess | undefined;
  let detached = false;
  const pendingStops = new Set<Promise<void>>();
  const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;

  const stop = async () => {
    const child = managedChild;
    managedChild = undefined;
    await stopChildProcess(child, shutdownTimeoutMs);
    if (pendingStops.size > 0) {
      await Promise.allSettled([...pendingStops]);
    }
  };

  const restartService = async () => {
    detached = false;
    if (options.systemdUnit) {
      await execFileAsync('systemctl', ['--user', 'restart', options.systemdUnit], {
        timeout: startupTimeoutMs,
      });
      const deadline = Date.now() + startupTimeoutMs;
      while (Date.now() < deadline) {
        try {
          const health = await request(options.home, { command: 'health' }, { timeoutMs: 2_000 }) as {
            status?: string;
            executorAvailable?: boolean;
          };
          if (health.status === 'ready' && health.executorAvailable !== false) return;
        } catch {}
        await delay(150);
      }
      throw new Error(`Systemd unit "${options.systemdUnit}" did not become ready within ${startupTimeoutMs}ms`);
    }

    await stop();
    await request(options.home, { command: 'shutdown' }, { timeoutMs: 2_000 }).catch(() => {});
    await waitForSocketRemoval(socketPath(options.home), shutdownTimeoutMs);

    const execPath = options.execPath ?? process.execPath;
    const filteredExecArgv = (options.execArgv ?? process.execArgv).filter(
      arg => !arg.startsWith('--inspect') && !arg.startsWith('--debug'),
    );
    const args = [
      ...filteredExecArgv,
      options.entryScript,
      'serve',
      '--home',
      options.home,
      '--mode',
      options.mode ?? 'real',
      ...(options.serveArgs ?? []),
    ];

    const child = spawn(execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    managedChild = child;

    let stderr = '';
    const onStderr = (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > 4096) stderr = stderr.slice(-4096);
    };
    child.stderr?.on('data', onStderr);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      const noopError = () => {};
      const cleanup = () => {
        clearTimeout(timeoutTimer);
        clearInterval(pollTimer);
        child.off('exit', onExit);
        child.on('error', noopError);
        child.off('error', onError);
        child.stdout?.off('data', onStdout);
        child.stderr?.off('data', onStderr);
      };
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!error && !detached) {
          child.stdout?.resume();
          child.stderr?.resume();
        }
        if (error) reject(error);
        else resolve();
      };
      const onError = (err: Error) => {
        if (managedChild === child) managedChild = undefined;
        done(err);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (managedChild === child) managedChild = undefined;
        const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
        done(new Error(`Managed serve exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})${detail}`));
      };
      const onStdout = (chunk: Buffer | string) => {
        stdout += String(chunk);
        const lines = stdout.split('\n');
        stdout = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) continue;
          try {
            const parsed = JSON.parse(trimmed) as { status?: string };
            if (parsed.status === 'ready') {
              done();
              return;
            }
          } catch {}
        }
      };

      child.once('error', onError);
      child.once('exit', onExit);
      child.stdout?.on('data', onStdout);

      const pollTimer = setInterval(() => {
        void request(options.home, { command: 'health' }, { timeoutMs: 1_500 })
          .then(res => {
            const health = res as { status?: string; executorAvailable?: boolean; pid?: number };
            if (
              health.status === 'ready'
              && health.executorAvailable !== false
              && (health.pid === undefined || (child.pid !== undefined && health.pid === child.pid))
            ) {
              done();
            }
          })
          .catch(() => {});
      }, 200);
      pollTimer.unref();

      const timeoutTimer = setTimeout(() => {
        const stopTask = stopChildProcess(child, shutdownTimeoutMs)
          .finally(() => pendingStops.delete(stopTask));
        pendingStops.add(stopTask);
        if (managedChild === child) managedChild = undefined;
        done(new Error(`Managed serve did not become ready within ${startupTimeoutMs}ms`));
      }, startupTimeoutMs);
      timeoutTimer.unref();
    });
  };

  const detach = () => {
    detached = true;
    const child = managedChild;
    managedChild = undefined;
    if (!child) return;
    child.stdout?.pause();
    child.stderr?.pause();
    (child.stdout as { unref?: () => void } | null)?.unref?.();
    (child.stderr as { unref?: () => void } | null)?.unref?.();
    child.unref();
  };

  return { restartService, stop, detach };
}

export class Watchdog {
  private failures = 0;
  private circuitOpen = false;
  private lastCheckedAt = 0;
  private lastError?: string;
  private readonly notices: WatchdogNotice[] = [];
  private readonly maxRetries: number;
  private readonly backoffMs: number;

  constructor(private readonly options: WatchdogOptions) {
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffMs = options.backoffMs ?? 2_000;
  }

  state(): WatchdogState {
    return {
      status: this.circuitOpen ? 'circuit_open' : this.failures > 0 ? 'recovering' : 'healthy',
      failures: this.failures,
      maxRetries: this.maxRetries,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
      notices: [...this.notices],
    };
  }

  private recordNotice(kind: string, text: string) {
    this.notices.push({ kind, text, at: Date.now() });
    if (this.notices.length > MAX_WATCHDOG_NOTICES) {
      this.notices.splice(0, this.notices.length - MAX_WATCHDOG_NOTICES);
    }
  }

  private async persistState(): Promise<void> {
    await mkdir(this.options.home, { recursive: true, mode: 0o700 });
    const target = join(this.options.home, 'watchdog.json');
    const tmp = join(this.options.home, `.watchdog.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify(this.state(), null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, target);
    } catch (error) {
      await unlink(tmp).catch(() => {});
      throw error;
    }
  }

  async checkOnce(): Promise<WatchdogState> {
    this.lastCheckedAt = Date.now();
    if (this.circuitOpen) {
      await this.persistState();
      return this.state();
    }
    try {
      const health = await request(this.options.home, { command: 'health' }) as { status?: string; executorAvailable?: boolean };
      if (health.status === 'ready' && health.executorAvailable !== false) {
        if (this.failures > 0) this.recordNotice('watchdog_recovered', 'Watchdog 探测确认协调服务已恢复就绪。');
        this.failures = 0;
        this.lastError = undefined;
        await this.persistState();
        return this.state();
      }
      throw new Error(`Service reported ${health.status ?? 'degraded'}`);
    } catch (error) {
      this.failures++;
      this.lastError = error instanceof Error ? error.message : 'Health check failed';

      if (!this.options.restartService || this.maxRetries <= 0) {
        if (this.failures >= this.maxRetries) {
          this.circuitOpen = true;
          this.recordNotice(
            'watchdog_circuit_open',
            `Watchdog 连续探测/恢复失败（${this.failures}/${this.maxRetries} 次）：${this.lastError}。已触发熔断并停止重试，请人工排查。`,
          );
        }
        await this.persistState();
        return this.state();
      }

      if (this.failures > this.maxRetries) {
        this.circuitOpen = true;
        this.recordNotice(
          'watchdog_circuit_open',
          `Watchdog 连续探测/恢复失败（${this.failures}/${this.maxRetries} 次）：${this.lastError}。已触发熔断并停止重试，请人工排查。`,
        );
        await this.persistState();
        return this.state();
      }

      await delay(this.backoffMs * (2 ** (this.failures - 1)));
      try {
        await this.options.restartService();
        const after = await request(this.options.home, { command: 'health' }) as { status?: string; executorAvailable?: boolean };
        if (after.status !== 'ready' || after.executorAvailable === false) {
          throw new Error(`Service reported ${after.status ?? 'degraded'} after restart`);
        }
        this.recordNotice('watchdog_recovered', `Watchdog 在第 ${this.failures} 次尝试后成功恢复协调服务。`);
        this.failures = 0;
        this.lastError = undefined;
      } catch (restartError) {
        this.lastError = restartError instanceof Error ? restartError.message : 'Controlled restart failed';
        if (this.failures >= this.maxRetries) {
          this.circuitOpen = true;
          this.recordNotice(
            'watchdog_circuit_open',
            `Watchdog 受限重启连续失败已达上限（${this.maxRetries} 次）：${this.lastError}。已触发熔断并停止重试。`,
          );
        }
      }
      await this.persistState();
      return this.state();
    }
  }

  async loop(signal: AbortSignal): Promise<void> {
    const interval = this.options.intervalMs ?? 2_000;
    while (!signal.aborted && !this.circuitOpen) {
      await this.checkOnce();
      if (signal.aborted || this.circuitOpen) break;
      await delay(interval, undefined, { signal }).catch(() => {});
    }
  }
}

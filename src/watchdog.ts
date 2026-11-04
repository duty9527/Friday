import { setTimeout as delay } from 'node:timers/promises';
import { request } from './protocol.js';
import { Store } from './store.js';

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
}

export class Watchdog {
  private failures = 0;
  private circuitOpen = false;
  private lastCheckedAt = 0;
  private lastError?: string;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  constructor(private readonly options: WatchdogOptions) {
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffMs = options.backoffMs ?? 200;
  }
  state(): WatchdogState {
    return {
      status: this.circuitOpen ? 'circuit_open' : this.failures > 0 ? 'recovering' : 'healthy',
      failures: this.failures,
      maxRetries: this.maxRetries,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
    };
  }
  private recordNotice(kind: string, text: string) {
    const store = new Store(this.options.home);
    try { store.notice('system', kind, text); }
    finally { store.close(); }
  }
  async checkOnce(): Promise<WatchdogState> {
    this.lastCheckedAt = Date.now();
    if (this.circuitOpen) return this.state();
    try {
      const health = await request(this.options.home, { command: 'health' }) as { status?: string; executorAvailable?: boolean };
      if (health.status === 'ready' && health.executorAvailable !== false) {
        if (this.failures > 0) this.recordNotice('watchdog_recovered', 'Watchdog 探测确认协调服务已恢复就绪。');
        this.failures = 0;
        this.lastError = undefined;
        return this.state();
      }
      throw new Error(`Service reported ${health.status ?? 'degraded'}`);
    } catch (error) {
      this.failures++;
      this.lastError = error instanceof Error ? error.message : 'Health check failed';
      if (this.failures > this.maxRetries) {
        this.circuitOpen = true;
        this.recordNotice('watchdog_circuit_open', `Watchdog 连续探测/恢复失败（${this.failures - 1}/${this.maxRetries} 次）：${this.lastError}。已触发熔断并停止重试，请人工排查。`);
        return this.state();
      }
      if (this.options.restartService) {
        await delay(this.backoffMs * (2 ** (this.failures - 1)));
        try {
          await this.options.restartService();
          const after = await request(this.options.home, { command: 'health' }) as { status?: string; executorAvailable?: boolean };
          if (after.status === 'ready' && after.executorAvailable !== false) {
            this.recordNotice('watchdog_recovered', `Watchdog 在第 ${this.failures} 次尝试后成功恢复协调服务。`);
            this.failures = 0;
            this.lastError = undefined;
          }
        } catch (restartError) {
          this.lastError = restartError instanceof Error ? restartError.message : 'Controlled restart failed';
          if (this.failures >= this.maxRetries) {
            this.circuitOpen = true;
            this.recordNotice('watchdog_circuit_open', `Watchdog 受限重启连续失败已达上限（${this.maxRetries} 次）：${this.lastError}。已触发熔断并停止重试。`);
          }
        }
      }
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

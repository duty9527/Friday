import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listPluginsSync, runPlugin, type PluginRunResult } from '../plugin.js';
import { isRunningUnderNodeTest } from './subconscious-loop.js';

export const PLUGIN_REFRESH_INTERVALS = Object.freeze({
  fundMarketMs: 2 * 60_000,
  fundOffHoursMs: 30 * 60_000,
  miotHubMs: 10 * 60_000,
  miotLiveMs: 30 * 60_000,
  ninebotMs: 30 * 60_000,
  netleaMs: 30 * 60_000,
  laifenMaintenanceMs: 30_000,
  appleMs: 60 * 60_000,
  bleDeferMs: 60_000,
  failureBackoffBaseMs: 5 * 60_000,
});

export type RefreshPluginName =
  | 'fund-tracker'
  | 'miot'
  | 'ninebot'
  | 'netlea'
  | 'laifen'
  | 'apple-devices';

const REFRESH_ORDER: readonly RefreshPluginName[] = [
  'fund-tracker',
  'miot',
  'ninebot',
  'netlea',
  'laifen',
  'apple-devices',
];

const SHANGHAI_TIME_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Returns true during A-share, HK, or US trading windows in Asia/Shanghai time:
 * - Mon-Fri 09:15..16:15 (A-share + HK)
 * - Mon-Fri 21:00..24:00 (US evening)
 * - Tue-Sat 00:00..05:00 (US overnight/close)
 */
export function isFundMarketHours(nowMs = Date.now()): boolean {
  const parts = SHANGHAI_TIME_FMT.formatToParts(new Date(nowMs));
  let weekday = '';
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'weekday') weekday = part.value;
    else if (part.type === 'hour') hour = Number(part.value);
    else if (part.type === 'minute') minute = Number(part.value);
  }
  const hm = hour * 60 + minute;
  const isMonToFri =
    weekday === 'Mon'
    || weekday === 'Tue'
    || weekday === 'Wed'
    || weekday === 'Thu'
    || weekday === 'Fri';
  const isTueToSat =
    weekday === 'Tue'
    || weekday === 'Wed'
    || weekday === 'Thu'
    || weekday === 'Fri'
    || weekday === 'Sat';

  if (isMonToFri && ((hm >= 9 * 60 + 15 && hm <= 16 * 60 + 15) || hm >= 21 * 60)) {
    return true;
  }
  if (isTueToSat && hm <= 5 * 60) {
    return true;
  }
  return false;
}

export interface PluginRefreshHost {
  home: string;
  mode: 'real' | 'offline';
  closingSignal: AbortSignal;
  isClosing: () => boolean;
  enabled?: boolean;
  nowFn?: () => number;
  platform?: string;
  checkIntervalMs?: number;
  initialDelayMs?: number;
  staggerMs?: number;
  runPluginFn?: typeof runPlugin;
  listPluginsFn?: typeof listPluginsSync;
}

export type PluginRefreshOptions = PluginRefreshHost;

export interface PluginRefreshEntryState {
  lastAttemptAt: number;
  lastSuccessAt: number;
  consecutiveFailures: number;
  nextRetryAt: number;
  deferredUntil: number;
}

interface RefreshPlan {
  plugin: RefreshPluginName;
  action: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  intervalMs: number;
  afterSuccess?: (res: PluginRunResult, completedAt: number) => Promise<void>;
}

function readJsonRecordSafe(filePath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(filePath)) return null;
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function withReadonlyDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T | undefined {
  if (!existsSync(dbPath)) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return fn(db);
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}

function nonEmptyString(val: unknown): boolean {
  return typeof val === 'string' && val.trim().length > 0;
}

function toFiniteTs(val: unknown): number {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isBleSessionActive(
  filePath: string,
  nowMs: number,
  maxAgeMs: number,
  activePhases: readonly string[],
): boolean {
  try {
    if (!existsSync(filePath)) return false;
    const st = statSync(filePath);
    if (nowMs - st.mtimeMs >= maxAgeMs) return false;
    const raw = readJsonRecordSafe(filePath);
    const phase = typeof raw?.phase === 'string' ? raw.phase.trim().toLowerCase() : '';
    return activePhases.includes(phase);
  } catch {
    return false;
  }
}

function isPidAliveSafe(pid: unknown): boolean {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether `health-scale` or `laifen` currently holds/uses the local BLE adapter.
 */
export function isBlePeerBusy(home: string, nowMs: number): boolean {
  const pluginsRoot = join(home, 'plugins');
  return (
    isBleSessionActive(
      join(pluginsRoot, 'health-scale', 'live-session.json'),
      nowMs,
      90_000,
      ['scanning', 'connecting', 'measuring'],
    )
    || isBleSessionActive(
      join(pluginsRoot, 'laifen', 'live-session.json'),
      nowMs,
      420_000,
      ['scanning', 'connecting', 'monitoring', 'reconnecting'],
    )
    || isBleSessionActive(
      join(pluginsRoot, 'laifen', 'watch-state.json'),
      nowMs,
      60_000,
      ['connecting', 'syncing', 'brushing', 'reconnecting'],
    )
  );
}

/**
 * Coordinates low-overhead, single-flight silent background refreshes for live-data plugins.
 */
export class PluginRefreshScheduler {
  private readonly home: string;
  private readonly closingSignal: AbortSignal;
  private readonly isClosing: () => boolean;
  private readonly enabled: boolean;
  private readonly nowFn: () => number;
  private readonly platform: string;
  private readonly checkIntervalMs: number;
  private readonly initialDelayMs: number;
  private readonly staggerMs: number;
  private readonly runPluginFn: typeof runPlugin;
  private readonly listPluginsFn: typeof listPluginsSync;

  private readonly startedAt: number;
  private readonly entries = new Map<RefreshPluginName, PluginRefreshEntryState>();
  private miotHubLastSuccessAt = 0;
  private miotLiveLastSuccessAt = 0;
  private lastCheckAt?: number;
  private lastCompletedAt?: number;
  private activeJob?: Promise<void>;
  private activePlugin?: RefreshPluginName;

  constructor(host: PluginRefreshHost) {
    this.home = host.home;
    this.closingSignal = host.closingSignal;
    this.isClosing = host.isClosing;
    this.enabled =
      host.enabled ??
      (host.mode === 'real'
        && !isRunningUnderNodeTest()
        && process.env.FRIDAY_PLUGIN_AUTO_REFRESH !== '0');
    this.nowFn = host.nowFn ?? Date.now;
    this.platform = host.platform ?? process.platform;
    this.checkIntervalMs = Math.max(0, host.checkIntervalMs ?? 15_000);
    this.initialDelayMs = Math.max(0, host.initialDelayMs ?? 15_000);
    this.staggerMs = Math.max(0, host.staggerMs ?? 5_000);
    this.runPluginFn = host.runPluginFn ?? runPlugin;
    this.listPluginsFn = host.listPluginsFn ?? listPluginsSync;
    this.startedAt = this.nowFn();
  }

  private getEntry(name: RefreshPluginName): PluginRefreshEntryState {
    let entry = this.entries.get(name);
    if (!entry) {
      entry = {
        lastAttemptAt: 0,
        lastSuccessAt: 0,
        consecutiveFailures: 0,
        nextRetryAt: 0,
        deferredUntil: 0,
      };
      this.entries.set(name, entry);
    }
    return entry;
  }

  private recordFailure(entry: PluginRefreshEntryState, intervalMs: number, now: number): void {
    entry.consecutiveFailures += 1;
    const backoff = Math.min(
      intervalMs,
      PLUGIN_REFRESH_INTERVALS.failureBackoffBaseMs * (2 ** (entry.consecutiveFailures - 1)),
    );
    entry.nextRetryAt = now + backoff;
  }

  private prepareFundTrackerPlan(now: number, entry: PluginRefreshEntryState): RefreshPlan | null {
    const dir = join(this.home, 'plugins', 'fund-tracker');
    const dbPath = join(dir, 'funds.sqlite');
    const cfg = readJsonRecordSafe(join(dir, 'config.json'));
    const cfgHoldingsCount = Array.isArray(cfg?.holdings) ? cfg.holdings.length : 0;

    const dbMeta = withReadonlyDb(dbPath, db => {
      const hRow = db.prepare('SELECT COUNT(*) AS cnt FROM holdings').get() as { cnt?: unknown } | undefined;
      const sRow = db.prepare('SELECT MAX(created_at) AS ts FROM snapshots').get() as { ts?: unknown } | undefined;
      return {
        holdingCount: Number(hRow?.cnt ?? 0),
        latestSnapTs: toFiniteTs(sRow?.ts),
      };
    });

    const configured = (dbMeta?.holdingCount ?? 0) > 0 || cfgHoldingsCount > 0;
    if (!configured) return null;

    const intervalMs = isFundMarketHours(now)
      ? PLUGIN_REFRESH_INTERVALS.fundMarketMs
      : PLUGIN_REFRESH_INTERVALS.fundOffHoursMs;
    const effectiveLast = Math.max(dbMeta?.latestSnapTs ?? 0, entry.lastSuccessAt);
    if (effectiveLast > 0 && now - effectiveLast < intervalMs) return null;

    return {
      plugin: 'fund-tracker',
      action: 'dashboard',
      args: { refresh: true, silent: true },
      timeoutMs: 25_000,
      intervalMs,
    };
  }

  private prepareMiotPlan(now: number): RefreshPlan | null {
    const dir = join(this.home, 'plugins', 'miot');
    const cfg = readJsonRecordSafe(join(dir, 'config.json'));
    if (!nonEmptyString(cfg?.routerSsh)) return null;

    const cache = readJsonRecordSafe(join(dir, 'hub-cache.json'));
    const diskHotTs = toFiniteTs(cache?.hotDataFetchedAt ?? cache?.fetchedAt);
    const diskLiveTs = toFiniteTs(cache?.liveFetchedAt);
    const hotTs = Math.max(diskHotTs, this.miotHubLastSuccessAt, this.miotLiveLastSuccessAt);
    const liveTs = Math.max(diskLiveTs, this.miotLiveLastSuccessAt);

    if (liveTs <= 0 || now - liveTs >= PLUGIN_REFRESH_INTERVALS.miotLiveMs) {
      return {
        plugin: 'miot',
        action: 'devices',
        args: { refresh: true, live: true, silent: true },
        timeoutMs: 28_000,
        intervalMs: PLUGIN_REFRESH_INTERVALS.miotLiveMs,
        afterSuccess: async (_res, completedAt) => {
          this.miotHubLastSuccessAt = completedAt;
          this.miotLiveLastSuccessAt = completedAt;
        },
      };
    }

    if (hotTs <= 0 || now - hotTs >= PLUGIN_REFRESH_INTERVALS.miotHubMs) {
      return {
        plugin: 'miot',
        action: 'devices',
        args: { refresh: true, live: false, silent: true },
        timeoutMs: 20_000,
        intervalMs: PLUGIN_REFRESH_INTERVALS.miotHubMs,
        afterSuccess: async (_res, completedAt) => {
          this.miotHubLastSuccessAt = completedAt;
        },
      };
    }

    return null;
  }

  private prepareNinebotPlan(now: number, entry: PluginRefreshEntryState): RefreshPlan | null {
    const dir = join(this.home, 'plugins', 'ninebot');
    const cfg = readJsonRecordSafe(join(dir, 'config.json'));
    const sess = readJsonRecordSafe(join(dir, 'session.json'));
    const hasAccount =
      nonEmptyString(sess?.accessToken)
      || (nonEmptyString(cfg?.username) && nonEmptyString(cfg?.password));
    const hasOfficial =
      nonEmptyString(cfg?.deviceServiceKey)
      || nonEmptyString(process.env.NINEBOT_DEVICESERVICE_KEY);
    if (!hasAccount && !hasOfficial) return null;

    const dbPath = join(dir, 'ninebot.sqlite');
    const dbMeta = withReadonlyDb(dbPath, db => {
      const snapRow = db.prepare(
        'SELECT captured_at, odometer_km FROM snapshots ORDER BY captured_at DESC, id DESC LIMIT 1',
      ).get() as { captured_at?: unknown; odometer_km?: unknown } | undefined;
      const tripRow = db.prepare('SELECT COUNT(*) AS cnt FROM trips').get() as { cnt?: unknown } | undefined;
      return {
        latestTs: toFiniteTs(snapRow?.captured_at),
        prevOdo: typeof snapRow?.odometer_km === 'number' && Number.isFinite(snapRow.odometer_km)
          ? snapRow.odometer_km
          : null,
        tripCount: Number(tripRow?.cnt ?? 0),
      };
    });

    const intervalMs = PLUGIN_REFRESH_INTERVALS.ninebotMs;
    const effectiveLast = Math.max(dbMeta?.latestTs ?? 0, entry.lastSuccessAt);
    if (effectiveLast > 0 && now - effectiveLast < intervalMs) return null;

    const prevOdo = dbMeta?.prevOdo ?? null;
    const tripCount = dbMeta?.tripCount ?? 0;

    return {
      plugin: 'ninebot',
      action: 'dashboard',
      args: { refresh: true, limit: 16, silent: true },
      timeoutMs: 25_000,
      intervalMs,
      afterSuccess: async res => {
        if (this.isClosing() || this.closingSignal.aborted) return;
        const data = res.data && typeof res.data === 'object' && !Array.isArray(res.data)
          ? (res.data as Record<string, unknown>)
          : undefined;
        const cfgObj = data?.config && typeof data.config === 'object'
          ? (data.config as Record<string, unknown>)
          : undefined;
        const snapObj = data?.snapshot && typeof data.snapshot === 'object'
          ? (data.snapshot as Record<string, unknown>)
          : undefined;
        const effectiveBackend = cfgObj?.effectiveBackend;
        const nextOdo = snapObj?.odometerKm;
        const odoIncreased =
          prevOdo !== null
          && typeof nextOdo === 'number'
          && Number.isFinite(nextOdo)
          && nextOdo > prevOdo + 0.05;

        if (effectiveBackend === 'account' && (odoIncreased || tripCount === 0)) {
          try {
            await this.runPluginFn(
              this.home,
              'ninebot',
              'trips',
              { silent: true },
              25_000,
              { signal: this.closingSignal },
            );
          } catch {
            // Best-effort trips follow-up must never fail the dashboard refresh state.
          }
        }
      },
    };
  }

  private prepareNetleaPlan(now: number, entry: PluginRefreshEntryState): RefreshPlan | 'deferred' | null {
    if (this.platform !== 'linux') return null;
    const dir = join(this.home, 'plugins', 'netlea');
    const cfg = readJsonRecordSafe(join(dir, 'config.json'));
    const lastState = readJsonRecordSafe(join(dir, 'last-state.json'));
    const devObj = lastState?.device && typeof lastState.device === 'object'
      ? (lastState.device as Record<string, unknown>)
      : undefined;

    const configured =
      nonEmptyString(cfg?.targetMac)
      || nonEmptyString(lastState?.lastAddress)
      || nonEmptyString(devObj?.address);
    if (!configured) return null;

    const intervalMs = PLUGIN_REFRESH_INTERVALS.netleaMs;
    const effectiveLast = Math.max(toFiniteTs(lastState?.updatedAt), entry.lastSuccessAt);
    if (effectiveLast > 0 && now - effectiveLast < intervalMs) return null;

    if (isBlePeerBusy(this.home, now)) {
      entry.deferredUntil = now + PLUGIN_REFRESH_INTERVALS.bleDeferMs;
      return 'deferred';
    }

    const hasSchedule = Boolean(lastState?.schedule && typeof lastState.schedule === 'object');
    return {
      plugin: 'netlea',
      action: 'status',
      args: { minimal: hasSchedule, silent: true },
      timeoutMs: 30_000,
      intervalMs,
    };
  }

  private prepareLaifenPlan(now: number, entry: PluginRefreshEntryState): RefreshPlan | null {
    if (this.platform !== 'linux') return null;
    const dir = join(this.home, 'plugins', 'laifen');
    const outboxDir = join(dir, 'watch-outbox');
    let hasOutbox = false;
    try {
      if (existsSync(outboxDir)) {
        hasOutbox = readdirSync(outboxDir).some(f => f.startsWith('ev-') && f.endsWith('.json'));
      }
    } catch {
      hasOutbox = false;
    }

    const live = readJsonRecordSafe(join(dir, 'live-session.json'));
    const livePhase = typeof live?.phase === 'string' ? live.phase.trim().toLowerCase() : '';
    const isTerminalUningested = Boolean(
      live
      && (livePhase === 'completed' || livePhase === 'stopped')
      && !live.ingestedSessionId
      && (
        Number(live.activeBrushingSec || 0) >= 10
        || (typeof live.latestStatusHex === 'string' && live.latestStatusHex.length > 0 && !live.finalStateSynced)
      ),
    );
    const isDeadActive = Boolean(
      live
      && ['scanning', 'connecting', 'monitoring', 'reconnecting'].includes(livePhase)
      && (
        (Number(live.pid || 0) > 0 && !isPidAliveSafe(live.pid))
        || (now - toFiniteTs(live.updatedAt ?? live.startedAt) > (Number(live.timeoutSec || 360) + 20) * 1000)
      ),
    );

    const cfg = readJsonRecordSafe(join(dir, 'config.json'));
    let watchNeedsStart = false;
    if (cfg?.autoWakeSync === true) {
      const watch = readJsonRecordSafe(join(dir, 'watch-state.json'));
      const watchPhase = typeof watch?.phase === 'string' ? watch.phase.trim().toLowerCase() : '';
      const watchAlive = Boolean(watch && watchPhase !== 'stopped' && isPidAliveSafe(watch.pid));
      watchNeedsStart = !watchAlive;
    }

    if (!hasOutbox && !isTerminalUningested && !isDeadActive && !watchNeedsStart) {
      return null;
    }
    if (
      !hasOutbox
      && entry.lastSuccessAt > 0
      && now - entry.lastSuccessAt < PLUGIN_REFRESH_INTERVALS.laifenMaintenanceMs
    ) {
      return null;
    }

    return {
      plugin: 'laifen',
      action: 'status',
      args: { silent: true },
      timeoutMs: 10_000,
      intervalMs: PLUGIN_REFRESH_INTERVALS.laifenMaintenanceMs,
    };
  }

  private prepareAppleDevicesPlan(now: number, entry: PluginRefreshEntryState): RefreshPlan | null {
    const dir = join(this.home, 'plugins', 'apple-devices');
    const sess = readJsonRecordSafe(join(dir, 'session.json'));
    if (sess?.state !== 'authenticated') return null;

    const cache = readJsonRecordSafe(join(dir, 'devices-cache.json'));
    const intervalMs = PLUGIN_REFRESH_INTERVALS.appleMs;
    const effectiveLast = Math.max(toFiniteTs(cache?.fetchedAt), entry.lastSuccessAt);
    if (effectiveLast > 0 && now - effectiveLast < intervalMs) return null;

    return {
      plugin: 'apple-devices',
      action: 'status',
      args: { refresh: true, silent: true },
      timeoutMs: 30_000,
      intervalMs,
    };
  }

  private pickNextPlan(now: number): RefreshPlan | null {
    const manifests = this.listPluginsFn(this.home, { platform: this.platform });
    const enabledPlugins = new Set(manifests.filter(p => p.enabled).map(p => p.name));

    for (const name of REFRESH_ORDER) {
      if (!enabledPlugins.has(name)) continue;
      const entry = this.getEntry(name);
      if (entry.nextRetryAt > now || entry.deferredUntil > now) continue;

      let candidate: RefreshPlan | 'deferred' | null = null;
      switch (name) {
        case 'fund-tracker':
          candidate = this.prepareFundTrackerPlan(now, entry);
          break;
        case 'miot':
          candidate = this.prepareMiotPlan(now);
          break;
        case 'ninebot':
          candidate = this.prepareNinebotPlan(now, entry);
          break;
        case 'netlea':
          candidate = this.prepareNetleaPlan(now, entry);
          break;
        case 'laifen':
          candidate = this.prepareLaifenPlan(now, entry);
          break;
        case 'apple-devices':
          candidate = this.prepareAppleDevicesPlan(now, entry);
          break;
      }

      if (candidate && candidate !== 'deferred') {
        return candidate;
      }
    }
    return null;
  }

  private async executePlan(plan: RefreshPlan, startedAt: number): Promise<void> {
    const entry = this.getEntry(plan.plugin);
    entry.lastAttemptAt = startedAt;
    try {
      const res = await this.runPluginFn(
        this.home,
        plan.plugin,
        plan.action,
        plan.args,
        plan.timeoutMs,
        { signal: this.closingSignal },
      );
      if (this.isClosing() || this.closingSignal.aborted) return;
      const doneAt = this.nowFn();
      if (res.ok) {
        entry.consecutiveFailures = 0;
        entry.lastSuccessAt = doneAt;
        entry.nextRetryAt = 0;
        entry.deferredUntil = 0;
        if (plan.afterSuccess) {
          await plan.afterSuccess(res, doneAt);
        }
      } else {
        this.recordFailure(entry, plan.intervalMs, doneAt);
      }
    } catch {
      if (this.isClosing() || this.closingSignal.aborted) return;
      this.recordFailure(entry, plan.intervalMs, this.nowFn());
    }
  }

  /**
   * Periodic non-blocking tick invoked from Coordinator.tick().
   * Evaluates at most one eligible plugin refresh per tick and spaces jobs via staggerMs.
   */
  tick(): void {
    if (!this.enabled || this.isClosing() || this.activeJob) return;
    const now = this.nowFn();
    if (now - this.startedAt < this.initialDelayMs) return;
    if (this.lastCheckAt !== undefined && now - this.lastCheckAt < this.checkIntervalMs) return;
    if (this.lastCompletedAt !== undefined && now - this.lastCompletedAt < this.staggerMs) return;

    this.lastCheckAt = now;
    const plan = this.pickNextPlan(now);
    if (!plan) return;

    this.activePlugin = plan.plugin;
    this.activeJob = this.executePlan(plan, now).finally(() => {
      this.lastCompletedAt = this.nowFn();
      this.activeJob = undefined;
      this.activePlugin = undefined;
    });
  }

  /**
   * Awaits any in-flight refresh job during graceful service shutdown.
   */
  async awaitSettled(): Promise<void> {
    if (this.activeJob) {
      await this.activeJob.catch(() => {});
    }
  }

  /**
   * Returns a read-only diagnostic snapshot of scheduler state.
   */
  status(): {
    enabled: boolean;
    activePlugin: RefreshPluginName | null;
    entries: Record<string, PluginRefreshEntryState>;
  } {
    const entries: Record<string, PluginRefreshEntryState> = {};
    for (const [k, v] of this.entries.entries()) {
      entries[k] = { ...v };
    }
    return {
      enabled: this.enabled,
      activePlugin: this.activePlugin ?? null,
      entries,
    };
  }
}

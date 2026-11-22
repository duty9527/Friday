import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  PLUGIN_REFRESH_INTERVALS,
  PluginRefreshScheduler,
  isBlePeerBusy,
  isFundMarketHours,
} from '../src/orchestrator/plugin-refresh.js';
import type { PluginManifest, PluginRunResult } from '../src/plugin.js';

function withTmpHome(fn: (home: string) => Promise<void> | void): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'friday-plugin-refresh-'));
  return Promise.resolve(fn(home)).finally(() => {
    rmSync(home, { recursive: true, force: true });
  });
}

function makeManifests(home: string, enabledNames: string[]): PluginManifest[] {
  const enabledSet = new Set(enabledNames);
  return ['fund-tracker', 'miot', 'ninebot', 'netlea', 'laifen', 'apple-devices'].map(name => ({
    name,
    title: name,
    description: name,
    entry: 'index.mjs',
    entryPath: join(home, 'plugins', name, 'index.mjs'),
    dir: join(home, 'plugins', name),
    dataDir: join(home, 'plugins', name),
    enabled: enabledSet.has(name),
    runtime: 'in-process' as const,
    voiceFastpath: false,
    actions: ['status', 'dashboard'],
  }));
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function seedFundDb(home: string, snapshotCreatedAt: number): void {
  const dir = join(home, 'plugins', 'fund-tracker');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'funds.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS holdings (code TEXT PRIMARY KEY, name TEXT, cost REAL, shares REAL, last_nav REAL, last_nav_date TEXT);
    CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, date TEXT, total_cost REAL, total_asset REAL, daily_pnl REAL, total_pnl REAL, detail_json TEXT, created_at INTEGER);
    DELETE FROM holdings;
    DELETE FROM snapshots;
  `);
  db.prepare('INSERT INTO holdings VALUES (?, ?, ?, ?, ?, ?)').run('000001', '测试基金', 1000, 1000, 1.0, '2026-11-20');
  if (snapshotCreatedAt > 0) {
    db.prepare('INSERT INTO snapshots (kind, date, total_cost, total_asset, daily_pnl, total_pnl, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('status', '2026-11-20', 1000, 1010, 10, 10, '[]', snapshotCreatedAt);
  }
  db.close();
}

function seedNinebotDb(home: string, capturedAt: number, odometerKm: number, withTrip = true): void {
  const dir = join(home, 'plugins', 'ninebot');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'ninebot.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, sn TEXT, captured_at INTEGER, odometer_km REAL, payload_json TEXT);
    CREATE TABLE IF NOT EXISTS trips (sn TEXT, travel_id TEXT, end_time INTEGER, distance_km REAL);
    DELETE FROM snapshots;
    DELETE FROM trips;
  `);
  if (capturedAt > 0) {
    db.prepare('INSERT INTO snapshots (sn, captured_at, odometer_km, payload_json) VALUES (?, ?, ?, ?)')
      .run('NB-1', capturedAt, odometerKm, '{}');
  }
  if (withTrip) {
    db.prepare('INSERT INTO trips VALUES (?, ?, ?, ?)').run('NB-1', 'T1', Math.floor(capturedAt / 1000), 3.2);
  }
  db.close();
}

test('isFundMarketHours accurately covers A-share, HK, US evening/overnight, and off-hours in Asia/Shanghai', () => {
  // 2026-11-16 is Monday
  assert.equal(isFundMarketHours(Date.parse('2026-11-16T02:00:00+08:00')), false, 'Monday 02:00 (US Sun closed)');
  assert.equal(isFundMarketHours(Date.parse('2026-11-16T09:14:00+08:00')), false, 'Monday 09:14 before open');
  assert.equal(isFundMarketHours(Date.parse('2026-11-16T09:15:00+08:00')), true, 'Monday 09:15 A-share open');
  assert.equal(isFundMarketHours(Date.parse('2026-11-16T15:30:00+08:00')), true, 'Monday 15:30 HK trading');
  assert.equal(isFundMarketHours(Date.parse('2026-11-16T16:15:00+08:00')), true, 'Monday 16:15 HK close');
  assert.equal(isFundMarketHours(Date.parse('2026-11-16T19:00:00+08:00')), false, 'Monday 19:00 NAV disclosure off-hours');
  assert.equal(isFundMarketHours(Date.parse('2026-11-16T21:00:00+08:00')), true, 'Monday 21:00 US pre/open');
  // 2026-11-17 is Tuesday
  assert.equal(isFundMarketHours(Date.parse('2026-11-17T02:00:00+08:00')), true, 'Tuesday 02:00 US overnight');
  // 2026-11-21 is Saturday
  assert.equal(isFundMarketHours(Date.parse('2026-11-21T02:00:00+08:00')), true, 'Saturday 02:00 Friday night US session');
  assert.equal(isFundMarketHours(Date.parse('2026-11-21T05:01:00+08:00')), false, 'Saturday 05:01 after US close');
  // 2026-11-22 is Sunday
  assert.equal(isFundMarketHours(Date.parse('2026-11-22T10:00:00+08:00')), false, 'Sunday off-hours');
});

test('PluginRefreshScheduler skips unconfigured, unauthenticated, and disabled plugins with zero calls', async () => {
  await withTmpHome(async home => {
    const calls: Array<{ plugin: string; action: string; args: Record<string, unknown> }> = [];
    // Pending 2FA / expired Apple account + empty ninebot config + non-linux netlea -> none eligible
    writeJson(join(home, 'plugins', 'apple-devices', 'session.json'), { state: 'expired' });
    writeJson(join(home, 'plugins', 'ninebot', 'config.json'), { username: '', password: '' });
    writeJson(join(home, 'plugins', 'miot', 'config.json'), { routerSsh: '' });
    writeJson(join(home, 'plugins', 'netlea', 'config.json'), { targetMac: 'AA:BB:CC:DD:EE:FF' });

    let now = Date.parse('2026-11-16T10:00:00+08:00');
    const ac = new AbortController();
    const scheduler = new PluginRefreshScheduler({
      home,
      mode: 'real',
      closingSignal: ac.signal,
      isClosing: () => false,
      enabled: true,
      nowFn: () => now,
      platform: 'darwin', // netlea disabled on non-linux
      initialDelayMs: 0,
      checkIntervalMs: 0,
      staggerMs: 0,
      listPluginsFn: h => makeManifests(h, ['fund-tracker', 'miot', 'ninebot', 'apple-devices']),
      runPluginFn: async (_h, plugin, action = 'status', args = {}) => {
        calls.push({ plugin, action, args });
        return { ok: true, plugin, action, notify: false, message: 'ok' };
      },
    });

    scheduler.tick();
    await scheduler.awaitSettled();
    now += 60_000;
    scheduler.tick();
    await scheduler.awaitSettled();

    assert.equal(calls.length, 0);
  });
});

test('PluginRefreshScheduler enforces tiered intervals, disk freshness reuse, and ninebot trips follow-up', async () => {
  await withTmpHome(async home => {
    // 2026-11-16 10:00 +08:00 (Monday market hours)
    let now = Date.parse('2026-11-16T10:00:00+08:00');

    // Seed fund-tracker fresh 30s ago -> not due yet; ninebot fresh 10m ago -> not due yet;
    // miot hub fresh 3m ago, live missing -> miot live due; apple fresh 30m ago -> not due yet; netlea fresh 5m ago -> not due
    seedFundDb(home, now - 30_000);
    writeJson(join(home, 'plugins', 'miot', 'config.json'), { routerSsh: 'root@192.0.2.1' });
    writeJson(join(home, 'plugins', 'miot', 'hub-cache.json'), {
      fetchedAt: now - 3 * 60_000,
      hotDataFetchedAt: now - 3 * 60_000,
      devices: [],
    });
    writeJson(join(home, 'plugins', 'ninebot', 'session.json'), { accessToken: 'tok' });
    seedNinebotDb(home, now - 10 * 60_000, 100.0, true);
    writeJson(join(home, 'plugins', 'netlea', 'config.json'), { targetMac: '11:22:33:44:55:66' });
    writeJson(join(home, 'plugins', 'netlea', 'last-state.json'), {
      updatedAt: now - 5 * 60_000,
      schedule: { trips: [] },
    });
    writeJson(join(home, 'plugins', 'apple-devices', 'session.json'), { state: 'authenticated' });
    writeJson(join(home, 'plugins', 'apple-devices', 'devices-cache.json'), {
      fetchedAt: now - 30 * 60_000,
      entries: [],
    });

    const calls: Array<{ plugin: string; action: string; args: Record<string, unknown> }> = [];
    const ac = new AbortController();
    let ninebotOdo = 100.0;

    const scheduler = new PluginRefreshScheduler({
      home,
      mode: 'real',
      closingSignal: ac.signal,
      isClosing: () => false,
      enabled: true,
      nowFn: () => now,
      platform: 'linux',
      initialDelayMs: 0,
      checkIntervalMs: 0,
      staggerMs: 5_000,
      listPluginsFn: h => makeManifests(h, ['fund-tracker', 'miot', 'ninebot', 'netlea', 'apple-devices']),
      runPluginFn: async (_h, plugin, action = 'status', args = {}): Promise<PluginRunResult> => {
        calls.push({ plugin, action, args });
        if (plugin === 'ninebot' && action === 'dashboard') {
          return {
            ok: true,
            plugin,
            action,
            notify: false,
            message: 'ok',
            data: {
              config: { effectiveBackend: 'account' },
              snapshot: { odometerKm: ninebotOdo },
            },
          };
        }
        return { ok: true, plugin, action, notify: false, message: 'ok' };
      },
    });

    // 1. Only miot live is due (liveFetchedAt missing)
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.deepEqual(calls.map(c => [c.plugin, c.action, c.args]), [
      ['miot', 'devices', { refresh: true, live: true, silent: true }],
    ]);

    // 2. Advance 2 min (10:02): fund-tracker market-hours 2m interval is due! (now - (T0-30s) = 2m30s >= 2m)
    now += 2 * 60_000;
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.deepEqual(calls.at(-1), {
      plugin: 'fund-tracker',
      action: 'dashboard',
      args: { refresh: true, silent: true },
    });

    // 3. Advance to 10:11:50: miot hub 10m interval is due (while live 30m is NOT due yet)
    now += 10 * 60_000 - 10_000; // 10:11:50 -> miot live was at 10:00, so +11m50s < 30m, >= 10m
    seedFundDb(home, now - 10_000);
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.deepEqual(calls.at(-1), {
      plugin: 'miot',
      action: 'devices',
      args: { refresh: true, live: false, silent: true },
    });

    // 4. Advance to 10:21 (ninebot was at T0-10m = 09:50 -> now 31m old, and odometer increased!)
    now = Date.parse('2026-11-16T10:21:00+08:00');
    seedFundDb(home, now - 10_000);
    ninebotOdo = 104.5; // increased > 0.05km -> triggers trips follow-up!
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.deepEqual(calls.slice(-2), [
      { plugin: 'ninebot', action: 'dashboard', args: { refresh: true, limit: 16, silent: true } },
      { plugin: 'ninebot', action: 'trips', args: { silent: true } },
    ]);

    // 5. Advance to 10:26 (netlea was at T0-5m = 09:55 -> 31m old -> due with minimal:true since schedule exists)
    now = Date.parse('2026-11-16T10:26:00+08:00');
    seedFundDb(home, now - 10_000);
    writeJson(join(home, 'plugins', 'miot', 'hub-cache.json'), {
      fetchedAt: now - 5 * 60_000,
      hotDataFetchedAt: now - 5 * 60_000,
      liveFetchedAt: now - 25 * 60_000,
      devices: [],
    });
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.deepEqual(calls.at(-1), {
      plugin: 'netlea',
      action: 'status',
      args: { minimal: true, silent: true },
    });

    // 6. Advance to 10:31 (apple was at T0-30m = 09:30 -> 61m old -> due!)
    now = Date.parse('2026-11-16T10:31:00+08:00');
    seedFundDb(home, now - 10_000);
    writeJson(join(home, 'plugins', 'miot', 'hub-cache.json'), {
      fetchedAt: now,
      hotDataFetchedAt: now,
      liveFetchedAt: now,
      devices: [],
    });
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.deepEqual(calls.at(-1), {
      plugin: 'apple-devices',
      action: 'status',
      args: { refresh: true, silent: true },
    });

    // 7. Off-hours fund-tracker check: at 19:00 (off-hours), 15-min-old snapshot is NOT due (< 30m),
    // and becomes due at 31m!
    now = Date.parse('2026-11-16T19:00:00+08:00');
    seedFundDb(home, now - 15 * 60_000);
    // Keep other plugins fresh
    writeJson(join(home, 'plugins', 'miot', 'hub-cache.json'), { fetchedAt: now, hotDataFetchedAt: now, liveFetchedAt: now, devices: [] });
    seedNinebotDb(home, now, 104.5, true);
    writeJson(join(home, 'plugins', 'netlea', 'last-state.json'), { updatedAt: now, schedule: { trips: [] } });
    writeJson(join(home, 'plugins', 'apple-devices', 'devices-cache.json'), { fetchedAt: now, entries: [] });

    const countBeforeOffHours = calls.length;
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.equal(calls.length, countBeforeOffHours, 'off-hours 15m fund snapshot must not refresh (< 30m)');

    now += 16 * 60_000; // total 31m since fund snapshot
    writeJson(join(home, 'plugins', 'miot', 'hub-cache.json'), { fetchedAt: now, hotDataFetchedAt: now, liveFetchedAt: now, devices: [] });
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.equal(calls.length, countBeforeOffHours + 1);
    assert.equal(calls.at(-1)?.plugin, 'fund-tracker');
  });
});

test('PluginRefreshScheduler defers netlea when BLE peer is active and applies exponential failure backoff', async () => {
  await withTmpHome(async home => {
    let now = Date.now();
    writeJson(join(home, 'plugins', 'netlea', 'config.json'), { targetMac: '11:22:33:44:55:66' });
    writeJson(join(home, 'plugins', 'health-scale', 'live-session.json'), { phase: 'measuring', updatedAt: now });

    assert.equal(isBlePeerBusy(home, now), true);

    let shouldFail = true;
    const calls: string[] = [];
    const ac = new AbortController();
    const scheduler = new PluginRefreshScheduler({
      home,
      mode: 'real',
      closingSignal: ac.signal,
      isClosing: () => false,
      enabled: true,
      nowFn: () => now,
      platform: 'linux',
      initialDelayMs: 0,
      checkIntervalMs: 0,
      staggerMs: 0,
      listPluginsFn: h => makeManifests(h, ['netlea']),
      runPluginFn: async (_h, plugin, action = 'status') => {
        calls.push(`${plugin}:${action}`);
        if (shouldFail) {
          return { ok: false, plugin, action, notify: false, message: 'ble timeout' };
        }
        return { ok: true, plugin, action, notify: false, message: 'ok' };
      },
    });

    // 1. Busy health-scale defers netlea by 60s WITHOUT recording a failure
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.equal(calls.length, 0);
    assert.equal(scheduler.status().entries.netlea?.consecutiveFailures, 0);
    assert.equal(scheduler.status().entries.netlea?.deferredUntil, now + PLUGIN_REFRESH_INTERVALS.bleDeferMs);

    // 2. Peer clears, still within 60s defer -> wait; after 60s -> runs and fails once (5m backoff)
    writeJson(join(home, 'plugins', 'health-scale', 'live-session.json'), { phase: 'completed', updatedAt: now });
    now += 30_000;
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.equal(calls.length, 0);

    now += 31_000;
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.equal(calls.length, 1);
    assert.equal(scheduler.status().entries.netlea?.consecutiveFailures, 1);
    assert.equal(scheduler.status().entries.netlea?.nextRetryAt, now + 5 * 60_000);

    // 3. Before 5m backoff -> skipped; at 5m -> runs & fails again (10m backoff)
    now += 4 * 60_000;
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.equal(calls.length, 1);

    now += 60_000;
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.equal(calls.length, 2);
    assert.equal(scheduler.status().entries.netlea?.consecutiveFailures, 2);
    assert.equal(scheduler.status().entries.netlea?.nextRetryAt, now + 10 * 60_000);

    // 4. Recovery resets failure counter
    shouldFail = false;
    now += 10 * 60_000;
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.equal(calls.length, 3);
    assert.equal(scheduler.status().entries.netlea?.consecutiveFailures, 0);
    assert.equal(scheduler.status().entries.netlea?.nextRetryAt, 0);

    // 5. Stale BLE session file (older than 90s) no longer blocks netlea
    const oldSec = (now - 120_000) / 1000;
    writeJson(join(home, 'plugins', 'health-scale', 'live-session.json'), { phase: 'measuring' });
    utimesSync(join(home, 'plugins', 'health-scale', 'live-session.json'), oldSec, oldSec);
    assert.equal(isBlePeerBusy(home, now), false);
  });
});

test('PluginRefreshScheduler enforces single-flight sequential execution and clean abort on shutdown', async () => {
  await withTmpHome(async home => {
    const now = Date.now();
    writeJson(join(home, 'plugins', 'miot', 'config.json'), { routerSsh: 'root@192.0.2.1' });
    writeJson(join(home, 'plugins', 'apple-devices', 'session.json'), { state: 'authenticated' });

    let releaseFirst!: () => void;
    let firstAborted = false;
    const inFlight: string[] = [];
    const ac = new AbortController();
    let closing = false;

    const scheduler = new PluginRefreshScheduler({
      home,
      mode: 'real',
      closingSignal: ac.signal,
      isClosing: () => closing,
      enabled: true,
      nowFn: () => now,
      initialDelayMs: 0,
      checkIntervalMs: 0,
      staggerMs: 0,
      listPluginsFn: h => makeManifests(h, ['miot', 'apple-devices']),
      runPluginFn: async (_h, plugin, action = 'status', _args, _timeout, opts) => {
        inFlight.push(plugin);
        await new Promise<void>(resolve => {
          releaseFirst = resolve;
          opts?.signal?.addEventListener('abort', () => {
            firstAborted = true;
            resolve();
          }, { once: true });
        });
        return { ok: true, plugin, action, notify: false, message: 'done' };
      },
    });

    scheduler.tick();
    scheduler.tick(); // second tick while active must not spawn concurrent job
    assert.deepEqual(inFlight, ['miot']);
    assert.equal(scheduler.status().activePlugin, 'miot');

    closing = true;
    ac.abort(new Error('shutdown'));
    releaseFirst();
    await scheduler.awaitSettled();
    assert.equal(firstAborted, true);
    assert.equal(scheduler.status().activePlugin, null);
  });
});

test('PluginRefreshScheduler runs laifen maintenance on pending outbox or autoWakeSync recovery, and isBlePeerBusy honors reconnecting', async () => {
  await withTmpHome(async home => {
    let now = Date.now();
    const laifenDir = join(home, 'plugins', 'laifen');

    // 1. isBlePeerBusy detects laifen live-session and watch-state in 'reconnecting' phase
    writeJson(join(laifenDir, 'live-session.json'), { phase: 'reconnecting', updatedAt: now });
    assert.equal(isBlePeerBusy(home, now), true);
    writeJson(join(laifenDir, 'live-session.json'), { phase: 'completed', updatedAt: now });
    assert.equal(isBlePeerBusy(home, now), false);

    writeJson(join(laifenDir, 'watch-state.json'), { phase: 'reconnecting', updatedAt: now });
    assert.equal(isBlePeerBusy(home, now), true);
    writeJson(join(laifenDir, 'watch-state.json'), { phase: 'watching', updatedAt: now });
    assert.equal(isBlePeerBusy(home, now), false);

    // 2. Clean idle laifen triggers zero refresh calls
    const calls: Array<{ plugin: string; action: string }> = [];
    const ac = new AbortController();
    const scheduler = new PluginRefreshScheduler({
      home,
      mode: 'real',
      closingSignal: ac.signal,
      isClosing: () => false,
      enabled: true,
      nowFn: () => now,
      platform: 'linux',
      initialDelayMs: 0,
      checkIntervalMs: 0,
      staggerMs: 0,
      listPluginsFn: h => makeManifests(h, ['laifen']),
      runPluginFn: async (_h, plugin, action = 'status') => {
        calls.push({ plugin, action });
        return { ok: true, plugin, action, notify: false, message: 'ok' };
      },
    });
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.equal(calls.length, 0);

    // 3. Pending watch-outbox event triggers laifen/status
    writeJson(join(laifenDir, 'watch-outbox', 'ev-001.json'), { eventId: 'ev-001', kind: 'session' });
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.deepEqual(calls, [{ plugin: 'laifen', action: 'status' }]);

    // 4. autoWakeSync enabled with stopped watch-state triggers recovery after maintenance interval
    rmSync(join(laifenDir, 'watch-outbox', 'ev-001.json'));
    writeJson(join(laifenDir, 'config.json'), { autoWakeSync: true });
    writeJson(join(laifenDir, 'watch-state.json'), { phase: 'stopped', pid: null });
    now += PLUGIN_REFRESH_INTERVALS.laifenMaintenanceMs;
    scheduler.tick();
    await scheduler.awaitSettled();
    assert.deepEqual(calls, [
      { plugin: 'laifen', action: 'status' },
      { plugin: 'laifen', action: 'status' },
    ]);
  });
});

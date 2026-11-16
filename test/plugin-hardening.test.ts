import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { listPluginsSync, listPluginViews, runPlugin } from '../src/plugin.js';
import { runAction as runHealthScaleAction } from '../plugins/health-scale/index.mjs';
import { runAction as runFundTrackerAction } from '../plugins/fund-tracker/index.mjs';
import { executeTvAgentAction, resolveDecisionCredentials } from '../plugins/tv-agent/index.mjs';
import { executeTvIrAction } from '../plugins/tv-ir/index.mjs';
import { defaultFetchHubRawRows, runAction as runMiotAction } from '../plugins/miot/index.mjs';

test('health-scale manifest and PluginView dynamically disable on darwin and enable on linux', () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-plat-home-'));
  try {
    const darwinManifests = listPluginsSync(home, { platform: 'darwin' });
    const darwinHealth = darwinManifests.find(p => p.name === 'health-scale');
    assert.ok(darwinHealth, 'health-scale manifest must still be listed on darwin');
    assert.deepEqual(darwinHealth.platforms, ['linux']);
    assert.equal(darwinHealth.enabled, false, 'health-scale must be disabled on darwin');

    const darwinViews = listPluginViews(home, { platform: 'darwin' });
    const darwinHealthView = darwinViews.find(p => p.name === 'health-scale');
    assert.ok(darwinHealthView);
    assert.equal(darwinHealthView.enabled, false);

    // Subsequent call with platform: 'linux' must not be poisoned by MANIFEST_CACHE
    const linuxManifests = listPluginsSync(home, { platform: 'linux' });
    const linuxHealth = linuxManifests.find(p => p.name === 'health-scale');
    assert.ok(linuxHealth);
    assert.equal(linuxHealth.enabled, true, 'health-scale must be enabled on linux');

    const linuxViews = listPluginViews(home, { platform: 'linux' });
    const linuxHealthView = linuxViews.find(p => p.name === 'health-scale');
    assert.ok(linuxHealthView);
    assert.equal(linuxHealthView.enabled, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('health-scale rejects BLE actions on non-linux without stubs, ignores args.dataDir override, and redacts configPath', async () => {
  const safeDataDir = mkdtempSync(join(tmpdir(), 'friday-health-safe-'));
  const rogueDataDir = mkdtempSync(join(tmpdir(), 'friday-health-rogue-'));
  try {
    // 1. args.dataDir must NOT override deps.dataDir
    const cfgRes = await runHealthScaleAction(
      'config',
      { dataDir: rogueDataDir, targetMac: 'AA:BB:CC:DD:EE:FF', namePrefix: 'AFU-WL' },
      { dataDir: safeDataDir, nowFn: () => 1_700_000_000_000 },
    );
    assert.equal(cfgRes.ok, true);
    assert.equal(existsSync(join(safeDataDir, 'health.db')), true, 'health.db must be created in deps.dataDir');
    assert.equal(existsSync(join(rogueDataDir, 'health.db')), false, 'args.dataDir must never redirect health.db');
    assert.equal(existsSync(join(rogueDataDir, 'config.json')), false, 'args.dataDir must never redirect config.json');

    // 2. config result must not expose host configPath
    const cfgData = (cfgRes as { data?: Record<string, unknown> }).data!;
    assert.equal('configPath' in cfgData, false, 'health-scale config data must not expose configPath');
    assert.equal(String(cfgRes.message).includes(safeDataDir), false, 'health-scale config message must not leak host path');

    // 3. On non-Linux without injected bleRunner/spawnMeasure stubs, BLE actions return explicit disabled message
    if (process.platform !== 'linux') {
      for (const bleAction of ['scan', 'measure-start', 'measure-stop'] as const) {
        const res = await runHealthScaleAction(bleAction, {}, { dataDir: safeDataDir });
        assert.equal(res.ok, false, `${bleAction} should return ok: false on ${process.platform}`);
        assert.equal(res.notify, true);
        assert.equal(res.title, '当前系统已关闭蓝牙体脂秤');
        assert.match(String(res.message), /Linux BlueZ D-Bus/);
      }
    }

    // 4. Recreating DB after deletion still initializes schema properly despite INITIALIZED_DB_PATHS cache
    rmSync(join(safeDataDir, 'health.db'), { force: true });
    const dashAfterDelete = await runHealthScaleAction('dashboard', {}, { dataDir: safeDataDir });
    assert.equal(dashAfterDelete.ok, true);
  } finally {
    rmSync(safeDataDir, { recursive: true, force: true });
    rmSync(rogueDataDir, { recursive: true, force: true });
  }
});

test('fund-tracker, tv-agent, tv-ir, and miot config actions do not leak host configPath', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'friday-redact-cfg-'));
  try {
    const fundDir = join(tmpRoot, 'fund');
    const fundRes = await runFundTrackerAction('config', {}, { pluginDataDir: fundDir });
    assert.equal(fundRes.ok, true);
    assert.equal('configPath' in (fundRes.data as Record<string, unknown>), false);
    assert.equal(String(fundRes.message ?? '').includes(fundDir), false);

    const tvAgentDir = join(tmpRoot, 'tv-agent');
    const tvAgentRes = await executeTvAgentAction('config', { tvHost: '192.0.2.55' }, { pluginDataDir: tvAgentDir });
    assert.equal(tvAgentRes.ok, true);
    assert.equal('configPath' in (tvAgentRes.data as Record<string, unknown>), false);
    assert.equal(String(tvAgentRes.message ?? '').includes(tvAgentDir), false);

    const tvIrDir = join(tmpRoot, 'tv-ir');
    const tvIrRes = await executeTvIrAction('config', { defaultIntervalMs: 260 }, { pluginDataDir: tvIrDir, homeDir: tmpRoot });
    assert.equal(tvIrRes.ok, true);
    assert.equal('configPath' in (tvIrRes.data as Record<string, unknown>), false);
    assert.equal(String(tvIrRes.message ?? '').includes(tvIrDir), false);

    const miotDir = join(tmpRoot, 'miot');
    const miotRes = await runMiotAction('config', { udpTimeoutMs: 4000 }, { pluginDataDir: miotDir, homeDir: tmpRoot });
    assert.equal(miotRes.ok, true);
    assert.equal('configPath' in (miotRes.data as Record<string, unknown>), false);
    assert.equal(String(miotRes.message ?? '').includes(miotDir), false);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('tv-agent resolves decision credentials via PluginExecutionContext.getDecisionCredentials()', async () => {
  // 1. Direct unit check on resolveDecisionCredentials priority
  const fromCallback = resolveDecisionCredentials(
    {},
    { modelHubPath: '/nonexistent/model-hub.json' },
    {
      getDecisionCredentials: () => ({
        apiKey: 'ctx-injected-key',
        baseUrl: 'https://ctx-decision.example.com/v1beta',
      }),
    },
  );
  assert.deepEqual(fromCallback, {
    apiKey: 'ctx-injected-key',
    baseUrl: 'https://ctx-decision.example.com/v1beta',
  });

  // 2. Host buildInProcessContext injects getDecisionCredentials for tv-agent reading <homeDir>/sdk/model-hub.json
  const home = mkdtempSync(join(tmpdir(), 'friday-tv-ctx-home-'));
  try {
    mkdirSync(join(home, 'sdk'), { recursive: true });
    writeFileSync(
      join(home, 'sdk', 'model-hub.json'),
      JSON.stringify({
        decision: {
          apiKey: 'host-hub-decision-key',
          baseUrl: 'https://host-hub.example.com',
        },
      }),
      { mode: 0o600 },
    );

    // Configure tvHost on loopback closed port so navigate proceeds past the credentials check to wake and fails immediately
    await runPlugin(home, 'tv-agent', 'config', { tvHost: '127.0.0.1', agentPort: 1 });
    const navRes = await runPlugin(home, 'tv-agent', 'navigate', { goal: '打开B站' }, 5000);
    // Should NOT fail with "未找到 Gemini Decision API 密钥"; instead it reaches the TV wake step
    assert.equal(navRes.ok, false);
    assert.doesNotMatch(navRes.message, /未找到 Gemini Decision API 密钥/);
    assert.match(navRes.message, /电视 Agent/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('miot defaultFetchHubRawRows extracts hub DBs inside private 0o700 <homeDir>/run directory', async () => {
  const home = mkdtempSync(join(tmpdir(), 'friday-miot-privrun-'));
  const fixtureSrc = mkdtempSync(join(tmpdir(), 'friday-miot-tar-src-'));
  try {
    const devDir = join(fixtureSrc, 'share', 'custom', 'devInfo');
    const hotDir = join(fixtureSrc, 'local', 'hotdatasync');
    mkdirSync(devDir, { recursive: true });
    mkdirSync(hotDir, { recursive: true });

    const devDb = new DatabaseSync(join(devDir, 'devInfo.db'));
    devDb.exec('CREATE TABLE device_v4 (did TEXT, dev_name TEXT, token TEXT, connect_type TEXT, model TEXT, urn TEXT, room_name TEXT, online TEXT)');
    devDb.prepare('INSERT INTO device_v4 VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      '"110022003"',
      '"卧室灯"',
      '"0123456789abcdef0123456789abcdef"',
      '"16"',
      '"isa.switch.kg01hl"',
      '"urn:miot-spec-v2:device:switch:0000A003:isa-kg01hl:1"',
      '"卧室"',
      '"true"',
    );
    devDb.close();

    const hotDb = new DatabaseSync(join(hotDir, 'hot_data_v2.db'));
    hotDb.exec('CREATE TABLE appMsg (key TEXT, value TEXT)');
    hotDb.close();

    const tarBuf = execFileSync('tar', ['-C', fixtureSrc, '-cf', '-', 'share/custom/devInfo', 'local/hotdatasync']);

    const rows = await defaultFetchHubRawRows({
      target: { id: 'router', userHost: 'root@192.0.2.1' },
      homeDir: home,
      sshBinaryExec: async () => ({ stdout: tarBuf, stderr: '', code: 0 }),
    });
    assert.equal(rows.devInfoRows.length, 1);

    const runDir = join(home, 'run');
    assert.equal(existsSync(runDir), true, '<homeDir>/run must be created');
    const runStat = statSync(runDir);
    assert.equal(runStat.mode & 0o777, 0o700, '<homeDir>/run must have 0o700 permissions');
    const leftovers = readdirSync(runDir).filter(name => name.startsWith('friday-miot-'));
    assert.equal(leftovers.length, 0, 'temporary extraction directory must be cleaned up after reading');
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixtureSrc, { recursive: true, force: true });
  }
});

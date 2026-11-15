import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  resolveEnv,
  resolveFridayHome,
  resolvePluginDataDir,
  resolvePrivateRunDir,
} from '../src/paths.js';
import {
  listPluginsSync,
  listPluginViews,
  runPlugin,
  tryPluginVoiceFastpath,
} from '../src/plugin.js';
import { until } from './helpers/async.js';
import { withTempHome } from './helpers/tmp-home.js';

async function withEnv(
  patch: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(patch)) {
    prev.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of prev.entries()) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('paths: resolveFridayHome honors explicit -> FRIDAY_HOME -> SUPER_AGENT_HOME -> ~/.friday -> ~/.super-agent', async () => {
  const fakeUserHome = await mkdtemp(join(tmpdir(), 'friday-userhome-'));
  try {
    await withEnv(
      {
        HOME: fakeUserHome,
        FRIDAY_HOME: '/tmp/env-friday',
        SUPER_AGENT_HOME: '/tmp/env-legacy',
      },
      async () => {
        assert.equal(resolveFridayHome('  /tmp/explicit-home  '), resolve('/tmp/explicit-home'));
        assert.equal(resolveFridayHome('   '), resolve('/tmp/env-friday'));
      },
    );

    await withEnv(
      {
        HOME: fakeUserHome,
        FRIDAY_HOME: '   ',
        SUPER_AGENT_HOME: '/tmp/env-legacy',
      },
      () => {
        assert.equal(resolveFridayHome(), resolve('/tmp/env-legacy'));
      },
    );

    const legacyDir = join(fakeUserHome, '.super-agent');
    const fridayDir = join(fakeUserHome, '.friday');
    await withEnv(
      {
        HOME: fakeUserHome,
        FRIDAY_HOME: undefined,
        SUPER_AGENT_HOME: undefined,
      },
      async () => {
        assert.equal(resolveFridayHome(), fridayDir);
        await mkdir(legacyDir, { recursive: true });
        assert.equal(resolveFridayHome(), legacyDir);
        await mkdir(fridayDir, { recursive: true });
        assert.equal(resolveFridayHome(), fridayDir);
      },
    );
  } finally {
    await rm(fakeUserHome, { recursive: true, force: true });
  }
});

test('paths: resolveEnv, resolvePluginDataDir, and resolvePrivateRunDir enforce modes and boundaries', async () => {
  await withEnv({ FRIDAY_TEST_KEY: '  ', LEGACY_TEST_KEY: '  legacy-val  ' }, () => {
    assert.equal(resolveEnv('FRIDAY_TEST_KEY', 'LEGACY_TEST_KEY'), 'legacy-val');
  });
  await withEnv({ FRIDAY_TEST_KEY: ' primary ', LEGACY_TEST_KEY: 'legacy-val' }, () => {
    assert.equal(resolveEnv('FRIDAY_TEST_KEY', 'LEGACY_TEST_KEY'), 'primary');
  });
  await withEnv({ FRIDAY_TEST_KEY: '   ', LEGACY_TEST_KEY: undefined }, () => {
    assert.equal(resolveEnv('FRIDAY_TEST_KEY', 'LEGACY_TEST_KEY'), undefined);
  });

  await withTempHome('friday-paths-', async home => {
    assert.equal(resolvePluginDataDir(home, 'miot'), join(resolve(home), 'plugins', 'miot'));

    const runDir = resolvePrivateRunDir(home);
    assert.equal(runDir, join(resolve(home), 'run'));
    assert.equal((await stat(runDir)).mode & 0o777, 0o700);

    await chmod(runDir, 0o755);
    resolvePrivateRunDir(home);
    assert.equal((await stat(runDir)).mode & 0o777, 0o700);

    const symHome = join(home, 'sym-home');
    await mkdir(symHome, { recursive: true });
    await symlink(runDir, join(symHome, 'run'));
    assert.throws(() => resolvePrivateRunDir(symHome), /real directory/i);
  });
});

test('plugin: declarative manifest metadata, cache invalidation, and listPluginViews redaction', async () => {
  await withTempHome('friday-plugin-meta-', async home => {
    const pluginDir = join(home, 'plugins', 'demo-meta');
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, 'plugin.json');
    const entryPath = join(pluginDir, 'index.mjs');

    await writeFile(
      manifestPath,
      JSON.stringify({
        title: 'Demo Meta',
        description: 'v1',
        runtime: 'in-process',
        promptHint: 'Hint v1',
        voiceFastpath: true,
        actions: ['ping'],
      }),
      'utf8',
    );
    await writeFile(
      entryPath,
      'export async function runAction(action) { return { ok: true, message: action }; }\n',
      'utf8',
    );

    const first = listPluginsSync(home).find(p => p.name === 'demo-meta');
    assert.ok(first);
    assert.equal(first.runtime, 'in-process');
    assert.equal(first.promptHint, 'Hint v1');
    assert.equal(first.voiceFastpath, true);
    assert.equal(first.enabled, true);

    const views = listPluginViews(home);
    const view = views.find(v => v.name === 'demo-meta');
    assert.ok(view);
    assert.equal(view.runtime, 'in-process');
    assert.equal(view.promptHint, 'Hint v1');
    assert.equal(view.voiceFastpath, true);
    assert.equal('entryPath' in view, false);
    assert.equal('dir' in view, false);
    assert.equal('dataDir' in view, false);
    assert.equal('sourceCode' in view, false);

    await writeFile(
      manifestPath,
      JSON.stringify({
        title: 'Demo Meta',
        description: 'v2-longer',
        runtime: 'in-process',
        promptHint: 'Hint v2 updated',
        voiceFastpath: false,
        enabled: false,
        actions: ['ping', 'pong'],
      }),
      'utf8',
    );

    const updated = listPluginsSync(home).find(p => p.name === 'demo-meta');
    assert.ok(updated);
    assert.equal(updated.description, 'v2-longer');
    assert.equal(updated.promptHint, 'Hint v2 updated');
    assert.equal(updated.voiceFastpath, false);
    assert.equal(updated.enabled, false);
    assert.deepEqual(updated.actions, ['ping', 'pong']);
  });
});

test('plugin: in-process callPlugin isolates pluginDataDir without mutating process.env', async () => {
  await withEnv({ PLUGIN_DATA_DIR: '/sentinel/untouched', OPENAI_API_KEY: 'secret-should-not-leak' }, async () => {
    await withTempHome('friday-plugin-iso-', async home => {
      const alphaDir = join(home, 'plugins', 'alpha');
      const betaDir = join(home, 'plugins', 'beta');
      await mkdir(alphaDir, { recursive: true });
      await mkdir(betaDir, { recursive: true });

      await writeFile(
        join(alphaDir, 'plugin.json'),
        JSON.stringify({ title: 'Alpha', runtime: 'in-process', actions: ['chain'] }),
        'utf8',
      );
      await writeFile(
        join(alphaDir, 'index.mjs'),
        `export async function runAction(action, args, ctx) {
          const beta = await ctx.callPlugin('beta', 'inspect', { from: 'alpha' });
          return {
            ok: true,
            notify: true,
            message: 'ok',
            data: {
              alphaHome: ctx.homeDir,
              alphaDataDir: ctx.pluginDataDir,
              alphaAliasDir: ctx.dataDir,
              alphaEnvDataDir: ctx.env.PLUGIN_DATA_DIR,
              alphaHasSecret: 'OPENAI_API_KEY' in ctx.env,
              betaData: beta.data,
            },
          };
        }\n`,
        'utf8',
      );

      await writeFile(
        join(betaDir, 'plugin.json'),
        JSON.stringify({ title: 'Beta', runtime: 'in-process', actions: ['inspect'] }),
        'utf8',
      );
      await writeFile(
        join(betaDir, 'index.mjs'),
        `export async function runAction(action, args, ctx) {
          return {
            ok: true,
            notify: false,
            message: 'beta-ok',
            data: {
              betaHome: ctx.homeDir,
              betaDataDir: ctx.pluginDataDir,
              betaEnvDataDir: ctx.env.PLUGIN_DATA_DIR,
              from: args.from,
            },
          };
        }\n`,
        'utf8',
      );

      const res = await runPlugin(home, 'alpha', 'chain', {});
      assert.equal(res.ok, true);
      const data = res.data as Record<string, any>;
      assert.equal(data.alphaHome, resolve(home));
      assert.equal(data.alphaDataDir, resolvePluginDataDir(home, 'alpha'));
      assert.equal(data.alphaAliasDir, data.alphaDataDir);
      assert.equal(data.alphaEnvDataDir, data.alphaDataDir);
      assert.equal(data.alphaHasSecret, false);
      assert.equal(data.betaData.betaHome, resolve(home));
      assert.equal(data.betaData.betaDataDir, resolvePluginDataDir(home, 'beta'));
      assert.equal(data.betaData.betaEnvDataDir, resolvePluginDataDir(home, 'beta'));
      assert.equal(data.betaData.from, 'alpha');
      assert.equal(process.env.PLUGIN_DATA_DIR, '/sentinel/untouched');
    });
  });
});

test('plugin: AbortSignal aborts hung in-process action on timeout', async () => {
  await withTempHome('friday-plugin-abort-', async home => {
    const slowDir = join(home, 'plugins', 'slow-abort');
    await mkdir(slowDir, { recursive: true });
    await writeFile(
      join(slowDir, 'plugin.json'),
      JSON.stringify({ title: 'Slow', runtime: 'in-process', actions: ['hang'] }),
      'utf8',
    );
    await writeFile(
      join(slowDir, 'index.mjs'),
      `let abortedSeen = false;
      export async function runAction(action, _args, ctx) {
        if (action === 'check') return { ok: true, message: 'checked', data: { abortedSeen } };
        return await new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => { abortedSeen = true; }, { once: true });
          setTimeout(() => resolve({ ok: true, message: 'late' }), 5000);
        });
      }\n`,
      'utf8',
    );

    await assert.rejects(
      () => runPlugin(home, 'slow-abort', 'hang', {}, 40),
      /timed out after 40ms/i,
    );
    await until(async () => {
      const check = await runPlugin(home, 'slow-abort', 'check', {});
      return Boolean((check.data as { abortedSeen?: boolean })?.abortedSeen);
    }, 1000, 10);
  });
});

test('plugin: tryPluginVoiceFastpath dispatches enabled in-process handlers and fails open on errors', async () => {
  await withTempHome('friday-voice-fp-', async home => {
    const disabledDir = join(home, 'plugins', 'vp-disabled');
    const throwingDir = join(home, 'plugins', 'vp-throw');
    const handlerDir = join(home, 'plugins', 'vp-ok');
    await mkdir(disabledDir, { recursive: true });
    await mkdir(throwingDir, { recursive: true });
    await mkdir(handlerDir, { recursive: true });

    await writeFile(
      join(disabledDir, 'plugin.json'),
      JSON.stringify({ runtime: 'in-process', voiceFastpath: true, enabled: false }),
      'utf8',
    );
    await writeFile(
      join(disabledDir, 'index.mjs'),
      'export async function handleVoiceFastpath() { return { handled: true, speech: "disabled" }; }\n',
      'utf8',
    );

    await writeFile(
      join(throwingDir, 'plugin.json'),
      JSON.stringify({ runtime: 'in-process', voiceFastpath: true, enabled: true }),
      'utf8',
    );
    await writeFile(
      join(throwingDir, 'index.mjs'),
      'export async function handleVoiceFastpath() { throw new Error("boom"); }\n',
      'utf8',
    );

    await writeFile(
      join(handlerDir, 'plugin.json'),
      JSON.stringify({ runtime: 'in-process', voiceFastpath: true, enabled: true }),
      'utf8',
    );
    await writeFile(
      join(handlerDir, 'index.mjs'),
      `export async function handleVoiceFastpath(req, ctx) {
        if (!req.text.includes('测试')) return { handled: false };
        return { handled: true, ok: true, speech: '已处理:' + req.platform, data: { dataDir: ctx.pluginDataDir } };
      }\n`,
      'utf8',
    );

    const hit = await tryPluginVoiceFastpath(home, {
      text: '执行测试指令',
      channelId: 'xiaoai:livingroom',
      platform: 'xiaoai',
    });
    assert.ok(hit);
    assert.equal(hit.handled, true);
    assert.equal(hit.plugin, 'vp-ok');
    assert.equal(hit.speech, '已处理:xiaoai');
    assert.equal((hit.data as { dataDir?: string })?.dataDir, resolvePluginDataDir(home, 'vp-ok'));

    const miss = await tryPluginVoiceFastpath(home, {
      text: '普通聊天',
      channelId: 'xiaoai:livingroom',
      platform: 'xiaoai',
    });
    assert.equal(miss, undefined);
  });
});

test('test helpers: until polls and withTempHome cleans up', async () => {
  let count = 0;
  setTimeout(() => { count = 3; }, 35);
  await until(() => count === 3, 1000, 10);
  assert.equal(count, 3);
  await assert.rejects(() => until(() => false, 30, 10), /timed out/i);

  let createdPath = '';
  await withTempHome('friday-tmp-test-', async home => {
    createdPath = home;
    assert.equal((await stat(home)).mode & 0o777, 0o700);
  });
  await assert.rejects(() => stat(createdPath));
});

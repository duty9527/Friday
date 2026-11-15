import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { realFactory, offlineFactory, loginOAuth, logoutOAuth } from '../src/agent.js';
import { ModelHub } from '../src/model-hub.js';

test('real mode never falls back when configuration is missing', async () => {
  await assert.rejects(realFactory('/unused', {}), /requires SUPER_AGENT_PROVIDER/);
});

test('published SDK creates restricted router and worker sessions without a model request', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sa-sdk-'));
  try {
    const factory = await realFactory(home, { provider: 'openai', model: 'gpt-4o', apiKey: 'test-not-a-real-key' });
    for (const role of ['router', 'worker'] as const) {
      const session = await factory.create(role, role, [{
        name: role === 'router' ? 'dispatch_worker' : 'start_read',
        description: 'Only permitted capability', execute: async () => 'ok',
      }]);
      assert.ok(session.sessionFile);
      session.close();
    }
    assert.ok((await readdir(join(home, 'sdk'))).includes('worker'));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('offline is explicitly marked and abortable', async () => {
  const factory = offlineFactory(10);
  let dispatched = 0;
  const agent = await factory.create('router', 'id', [{ name: 'dispatch_worker', description: '', execute: async () => { dispatched++; return 'ok'; } }]);
  assert.match(await agent.prompt(JSON.stringify({ kind: 'NEW_TASK' }), new AbortController().signal), /OFFLINE SIMULATION/);
  assert.equal(dispatched, 1);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(agent.prompt('{}', controller.signal));
});

test('a base URL in the provider slot, or a model missing from the catalog, is explained with the IDs that work', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-msg-'));
  try {
    await assert.rejects(realFactory(root, { provider: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'x' }),
      (error: Error) => /not a base URL/.test(error.message) && /use "deepseek"/.test(error.message), 'the base-URL mistake names the fix');
    await assert.rejects(realFactory(root, { provider: 'deepseek', model: 'nonexistent-deepseek-model', apiKey: 'x' }),
      (error: Error) => /Unknown model "nonexistent-deepseek-model" for provider "deepseek"/.test(error.message) && /deepseek-chat/.test(error.message),
      'a missing model lists the real catalog entries, so invalid names cannot dead-end');
    await assert.rejects(realFactory(root, { provider: 'not-a-provider', model: 'x', apiKey: 'x' }),
      (error: Error) => /Unknown SDK provider "not-a-provider"/.test(error.message) && /deepseek/.test(error.message),
      'an unknown provider lists real provider IDs');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('openai OAuth credentials in home/sdk/auth.json work without SUPER_AGENT_API_KEY and logout clears them', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-oauth-'));
  try {
    await assert.rejects(
      loginOAuth(home, 'deepseek', { prompt: async () => '', notify: () => {} }),
      /does not support OAuth login/,
    );
    const sdkDir = join(home, 'sdk');
    await mkdir(sdkDir, { recursive: true, mode: 0o700 });
    await writeFile(join(sdkDir, 'auth.json'), JSON.stringify({
      openai: {
        type: 'oauth',
        access: 'oauth-access-token',
        refresh: 'oauth-refresh-token',
        expires: Date.now() + 3600_000,
        clientId: 'client-123',
        scopes: ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'],
      },
    }), { mode: 0o600 });
    // Works with default provider/model (openai / gpt-5.3-codex) or explicit model after OAuth login
    const factory = await realFactory(home, {});
    const session = await factory.create('router', 'router-oauth', [{
      name: 'dispatch_worker', description: 'Only permitted capability', execute: async () => 'ok',
    }]);
    assert.ok(session.sessionFile);
    session.close();

    await logoutOAuth(home, 'openai');
    const afterLogout = JSON.parse(await readFile(join(sdkDir, 'auth.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(afterLogout.openai, undefined);
    await assert.rejects(realFactory(home, {}), /requires SUPER_AGENT_PROVIDER/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('SdkAgent restores primary Router model after temporary fallback turn', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-sdk-restore-'));
  const requestedModels: string[] = [];
  let trippedOnce = false;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { model: string };
    requestedModels.push(body.model);
    if (body.model === 'primary-model' && !trippedOnce) {
      trippedOnce = true;
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '429 rate limit exceeded', type: 'rate_limit_error' } }));
      return;
    }
    const text = body.model === 'fallback-model' ? 'fallback ok' : 'primary ok';
    const packet = (delta: unknown, finish: string | null) => ({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify(packet({ role: 'assistant', content: text }, null))}\n\n`
      + `data: ${JSON.stringify(packet({}, 'stop'))}\n\n`
      + `data: [DONE]\n\n`,
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  try {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, authPath: join(home, 'sdk', 'auth.json') });
    runtime.registerProvider('fixture', {
      baseUrl: `http://127.0.0.1:${addr.port}/v1`,
      api: 'openai-completions',
      apiKey: 'fixture-key',
      models: [
        { id: 'primary-model', name: 'Primary', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 },
        { id: 'fallback-model', name: 'Fallback', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 },
      ],
    });
    const factory = await realFactory(
      home,
      { provider: 'fixture', model: 'fallback-model', routerModel: 'primary-model', apiKey: 'fixture-key', retry: { enabled: false } },
      runtime,
    );
    const router = await factory.create('router', 'router-restore', [{
      name: 'dispatch_worker', description: 'test tool', execute: async () => 'ok',
    }]);
    try {
      const turn1 = await router.prompt('first', new AbortController().signal);
      assert.equal(turn1, 'fallback ok');
      const turn2 = await router.prompt('second', new AbortController().signal);
      assert.equal(turn2, 'primary ok');
      assert.deepEqual(requestedModels, ['primary-model', 'fallback-model', 'primary-model']);
    } finally {
      router.close();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test('ModelHub.saveState serializes concurrent writes and probe does not mutate live runtime', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-hub-safety-'));
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '探针正常' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  try {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, authPath: join(home, 'sdk', 'auth.json') });
    const origOpenAiUrl = runtime.getModel('openai', 'gpt-4.1')?.baseUrl;
    const hub = new ModelHub(
      home,
      'real',
      { provider: 'openai', router: 'gpt-4.1', fast: 'gpt-4.1-mini', balanced: 'gpt-4.1', strong: 'o4-mini', available: ['gpt-4.1'] },
      'openai',
      runtime,
    );
    await hub.init();

    // Concurrent state writes must serialize atomically without JSON corruption.
    await Promise.all([
      hub.configure({ providerId: 'deepseek', apiKey: 'sk-ds-1111' }),
      hub.configure({ providerId: 'anthropic', apiKey: 'sk-ant-2222' }),
      hub.configure({ providerId: 'google', apiKey: 'sk-goog-3333' }),
      Promise.resolve().then(() => hub.recordTaskOutcome('openai/gpt-4.1', true, 120, 3)),
      Promise.resolve().then(() => hub.recordTaskOutcome('openai/gpt-4.1-mini', true, 90, 2)),
    ]);
    await hub.flush();
    const persisted = JSON.parse(await readFile(join(home, 'sdk', 'model-hub.json'), 'utf8')) as {
      providers: Record<string, { apiKey?: string }>;
      modelStats: Record<string, { successCount?: number }>;
    };
    assert.equal(persisted.providers.deepseek?.apiKey, 'sk-ds-1111');
    assert.equal(persisted.providers.anthropic?.apiKey, 'sk-ant-2222');
    assert.equal(persisted.providers.google?.apiKey, 'sk-goog-3333');
    assert.equal(persisted.modelStats['openai/gpt-4.1']?.successCount, 1);

    // Inline probe against custom baseUrl must not overwrite live runtime model metadata.
    const probe = await hub.probe({
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: 'sk-temp-probe',
      baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    });
    assert.equal(probe.ok, true);
    assert.equal(runtime.getModel('openai', 'gpt-4.1')?.baseUrl, origOpenAiUrl);
    await hub.close();
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

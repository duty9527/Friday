import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realFactory, offlineFactory } from '../src/agent.js';

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
    await assert.rejects(realFactory(root, { provider: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'x' }),
      (error: Error) => /not a base URL/.test(error.message) && /use "deepseek"/.test(error.message), 'the base-URL mistake names the fix');
    await assert.rejects(realFactory(root, { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'x' }),
      (error: Error) => /Unknown model "deepseek-chat" for provider "deepseek"/.test(error.message) && /deepseek-v4-pro/.test(error.message),
      'a missing model lists the catalog entries, so the vendor doc name cannot dead-end');
    await assert.rejects(realFactory(root, { provider: 'not-a-provider', model: 'x', apiKey: 'x' }),
      (error: Error) => /Unknown SDK provider "not-a-provider"/.test(error.message) && /deepseek/.test(error.message),
      'an unknown provider lists real provider IDs');
  } finally { await rm(root, { recursive: true, force: true }); }
});

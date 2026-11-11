import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { realFactory, type AgentObservation } from '../src/agent.js';
import { ModelHub } from '../src/model-hub.js';

test('real SDK streams through a local OpenAI-compatible fixture and executes only registered tools', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-http-'));
  let count = 0;
  let failRequests = false;
  let rateLimitOnce = false;
  let stallRequests = false;
  const observedTools: string[][] = [];
  const observed: AgentObservation[] = [];
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let bytes = '';
    for await (const chunk of request) bytes += chunk;
    const body = JSON.parse(bytes);
    requests.push(body);
    if (stallRequests) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      return;
    }
    if (rateLimitOnce) {
      rateLimitOnce = false;
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'server_error', message: 'The inference service is overloaded. Please try again later.' }));
      return;
    }
    if (failRequests) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture rejection', type: 'authentication_error' } }));
      return;
    }
    const tools: string[] = (body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name);
    observedTools.push(tools);
    const messages = JSON.stringify(body.messages);
    const toolName = tools[0];
    const hasToolResult = body.messages.some((message: { role: string }) => message.role === 'tool');
    const callTool = !hasToolResult && (toolName === 'dispatch_worker' || toolName === 'start_read');
    const delta = callTool
      ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${++count}`, type: 'function', function: { name: toolName, arguments: JSON.stringify({ input: toolName === 'start_read' ? 'f0' : 'dispatch' }) } }] }
      : { role: 'assistant', reasoning_content: 'PRIVATE_REASONING_SENTINEL', content: messages.includes('READ_COMPLETIONS') ? 'Verified SDK report: fixture file was read' : 'Dispatch or read accepted; waiting for host event' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const packet = (delta: unknown, finish_reason: string | null) => ({ id: 'chat-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] });
    response.end(`data: ${JSON.stringify(packet(delta, null))}\n\ndata: ${JSON.stringify(packet({}, callTool ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, authPath: join(root, 'auth.json') });
    runtime.registerProvider('fixture', {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'fixture-only',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 }],
    });
    const factory = await realFactory(root, { provider: 'fixture', model: 'fixture', apiKey: 'fixture-only', retry: { baseDelayMs: 20, maxAgentDelayMs: 100 } }, runtime);
    let dispatches = 0; let reads = 0;
    const router = await factory.create('router', 'router-test', [{ name: 'dispatch_worker', description: 'Dispatch task', execute: async () => { dispatches++; return 'worker accepted'; } }]);
    const worker = await factory.create('worker', 'worker-test', [{ name: 'start_read', description: 'Read explicit ID', execute: async input => { assert.equal(input, 'f0'); reads++; return 'operation accepted'; } }], { onEvent: event => observed.push(event) });
    try {
      const signal = new AbortController().signal;
      await router.prompt(JSON.stringify({ kind: 'NEW_TASK' }), signal);
      await worker.prompt(JSON.stringify({ kind: 'TASK', files: [{ id: 'f0' }] }), signal);
      const report = await worker.prompt(JSON.stringify({ kind: 'READ_COMPLETIONS', content: 'fixture file' }), signal);
      assert.match(report, /Verified SDK report/);
      const checkpoint = worker.checkpoint!;
      assert.ok(checkpoint?.leafId);
      assert.equal(dispatches, 1); assert.equal(reads, 1);
      assert.ok(observedTools.every(names => names.length === 1 && ['dispatch_worker', 'start_read'].includes(names[0]!)));
      assert.ok(observedTools.length >= 5);
      failRequests = true;
      await assert.rejects(worker.prompt('FAIL_TAIL_SENTINEL', signal), /Model request error/);
      failRequests = false;
      const restored = await factory.create('worker', 'worker-test', [{ name: 'start_read', description: 'Read explicit ID', execute: async () => { throw new Error('Committed read must not replay'); } }], { restore: checkpoint, onEvent: event => observed.push(event) });
      try {
        assert.match(await restored.prompt('Continue from committed checkpoint', signal), /Verified SDK report/);
        const restoredRequest = JSON.stringify(requests.at(-1));
        assert.match(restoredRequest, /READ_COMPLETIONS/);
        assert.doesNotMatch(restoredRequest, /FAIL_TAIL_SENTINEL/);
        rateLimitOnce = true;
        const recovered = await restored.prompt('RETRY_429_SENTINEL', signal);
        assert.match(recovered, /Verified SDK report/);
        assert.ok(observed.some(event => event.kind === 'retry_start'));
        assert.ok(observed.some(event => event.kind === 'retry_end' && event.data && (event.data as { success?: boolean }).success === true));

        // Disabling a provider in ModelHub removes it from pool and blocks probe, fetch, create, and prompt
        const hub = new ModelHub(
          root,
          'real',
          factory.modelTiers!,
          factory.routerProvider ?? 'fixture',
          runtime,
          (tiers, routerProv, routerMod, disabled) => factory.updateModelConfig?.(tiers, routerProv, routerMod, disabled),
        );
        await hub.init({ fixture: 'fixture-only' });
        const disabledView = await hub.configure({ providerId: 'fixture', enabled: false });
        assert.equal(disabledView.providers.find(p => p.id === 'fixture')?.enabled, false);
        assert.equal((disabledView.modelPool ?? []).some(m => m.providerId === 'fixture'), false);

        const reqCountBefore = requests.length;
        const blockedProbe = await hub.probe({ provider: 'fixture', model: 'fixture' });
        assert.equal(blockedProbe.ok, false);
        assert.match(blockedProbe.error ?? '', /已禁用/);
        await assert.rejects(hub.fetchModels({ providerId: 'fixture' }), /已禁用/);
        assert.throws(() => hub.selectWorkerModel({ model: 'fixture/fixture' }), /已禁用/);
        await assert.rejects(factory.create('worker', 'blocked-worker', []), /已禁用/);
        await assert.rejects(restored.prompt('MUST_NOT_CALL_DISABLED_PROVIDER', signal), /已禁用/);
        assert.equal(requests.length, reqCountBefore);

        const reenabledView = await hub.configure({ providerId: 'fixture', enabled: true });
        assert.equal(reenabledView.providers.find(p => p.id === 'fixture')?.enabled, true);
        assert.equal((reenabledView.modelPool ?? []).some(m => m.providerId === 'fixture'), true);
        assert.match(await restored.prompt('AFTER_REENABLE', signal), /Verified SDK report/);
      } finally { restored.close(); }
      assert.ok(observed.some(event => event.kind === 'tool_start' && event.toolName === 'start_read'));
      assert.ok(observed.some(event => event.kind === 'turn_end'));
      assert.doesNotMatch(JSON.stringify(observed), /PRIVATE_REASONING_SENTINEL/);
      stallRequests = true;
      await assert.rejects(worker.prompt('A stream that must be aborted', AbortSignal.timeout(100)));
    } finally { router.close(); worker.close(); }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

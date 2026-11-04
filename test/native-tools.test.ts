import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { realFactory, NATIVE_TOOL_NAMES, type AgentObservation } from '../src/agent.js';

// Local model fixture requests real SDK tools; no external provider or user filesystem is used.
test('native SDK Worker searches, reads, writes, edits and runs foreground Bash in the actual cwd', { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'sa-native-'));
  const cwd = join(root, 'project'); await mkdir(cwd);
  for (let i = 0; i < 40; i++) await writeFile(join(cwd, `${i}.txt`), 'untouched');
  const steps = [
    ['write', { path: 'result.txt', content: 'before native' }],
    ['edit', { path: 'result.txt', edits: [{ oldText: 'before', newText: 'after' }] }],
    ['read', { path: 'result.txt' }],
    ['ls', { path: '.' }],
    ['find', { pattern: '*.txt', path: '.' }],
    ['grep', { pattern: 'after native', path: '.' }],
    ['bash', { command: 'test "$(cat result.txt)" = "after native" && test -z "$SUPER_AGENT_API_KEY" && printf verified > checked.txt' }],
  ] as const;
  const observed: AgentObservation[] = [];
  const lifecycle: Array<{ id: string; name: string; phase: string; interrupted?: boolean }> = [];
  let stall = false;
  const server = createServer(async (request, response) => {
    let bytes = ''; for await (const chunk of request) bytes += chunk;
    const body = JSON.parse(bytes);
    const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name).sort();
    assert.deepEqual(names, [...NATIVE_TOOL_NAMES].sort());
    const results = body.messages.filter((message: { role: string }) => message.role === 'tool');
    if (!stall) for (const result of results) assert.doesNotMatch(JSON.stringify(result), /Error:|ENOENT|not found|failed with exit code/);
    const step = stall ? ['bash', { command: 'printf started > started.txt; sleep 30; printf escaped > escaped.txt' }] : steps[results.length];
    const delta = step ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${results.length}_${stall}`, type: 'function', function: { name: step[0], arguments: JSON.stringify(step[1]) } }] }
      : { role: 'assistant', content: 'All seven native tools verified.' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const packet = (delta: unknown, finish: string | null) => ({ id: 'native', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: finish }] });
    response.end(`data: ${JSON.stringify(packet(delta, null))}\n\ndata: ${JSON.stringify(packet({}, step ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const previousKey = process.env.SUPER_AGENT_API_KEY;
  process.env.SUPER_AGENT_API_KEY = 'not-for-subprocess';
  try {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, authPath: join(root, 'auth.json') });
    runtime.registerProvider('fixture', { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'fixture',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 }] });
    const factory = await realFactory(join(root, 'home'), { provider: 'fixture', model: 'fixture', apiKey: 'fixture' }, runtime);
    assert.equal(factory.nativeTools, true);
    const worker = await factory.create('worker', 'native-test', [], { execution: 'native', cwd, onEvent: event => observed.push(event), nativeTool: event => { lifecycle.push(event); } });
    try {
      assert.match(await worker.prompt('Use all tools', new AbortController().signal), /seven native tools/);
      assert.equal(await readFile(join(cwd, 'result.txt'), 'utf8'), 'after native');
      assert.equal(await readFile(join(cwd, 'checked.txt'), 'utf8'), 'verified');
      assert.deepEqual(new Set(observed.filter(event => event.kind === 'tool_end').map(event => event.toolName)), new Set(NATIVE_TOOL_NAMES));
      assert.equal(lifecycle.filter(event => event.phase === 'start').length, 7);
      assert.equal(lifecycle.filter(event => event.phase === 'end').length, 7);
      assert.ok(worker.sessionFile?.startsWith(join(root, 'home', 'sdk')));
      stall = true;
      const controller = new AbortController();
      const pending = worker.prompt('Stop foreground Bash', controller.signal);
      const rejected = assert.rejects(pending);
      for (let i = 0; i < 100; i++) { if (await access(join(cwd, 'started.txt')).then(() => true, () => false)) break; await delay(20); }
      await access(join(cwd, 'started.txt'));
      controller.abort(); await rejected;
      assert.equal(lifecycle.at(-1)?.interrupted, true);
      await assert.rejects(access(join(cwd, 'escaped.txt')));
    } finally { worker.close(); }
  } finally {
    if (previousKey === undefined) delete process.env.SUPER_AGENT_API_KEY; else process.env.SUPER_AGENT_API_KEY = previousKey;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

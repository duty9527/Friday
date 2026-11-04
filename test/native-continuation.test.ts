import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, writeFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Coordinator } from '../dist/coordinator.js';
import type { AgentFactory } from '../src/agent.js';
import type { Task } from '../src/store.js';

for (const execution of [undefined, 'snapshot'] as const) {
  for (const toolName of ['continue_work', 'start_work']) {
    test(`${toolName} from ${execution ?? 'legacy'} source uses current native tools, not old snapshots`, async () => {
      const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-nc-'));
      const cwd = join(home, 'project'); await mkdir(cwd);
      await writeFile(join(cwd, 'current.txt'), 'current workspace');
      const explicitCwd = execution === 'snapshot' && toolName === 'continue_work';
      let workerCreated = false;
      const factory: AgentFactory = { mode: 'real', nativeTools: true, create: async (role, _id, tools, options) => ({
        close() {}, async prompt(text) {
          const event = JSON.parse(text);
          if (role === 'router') {
            if (event.kind === 'CHAT') {
              await tools.find(tool => tool.name === toolName)!.execute(JSON.stringify({ instruction: 'inspect current directory',
                ...(toolName === 'continue_work' ? { taskId: 'old' } : { sourceTaskId: 'old' }), ...(explicitCwd ? { cwd } : {}) }));
              return 'dispatched';
            }
            return event.report;
          }
          workerCreated = true;
          assert.equal(options?.execution, 'native');
          assert.equal(options?.cwd, cwd);
          assert.deepEqual(tools, [], 'do not expose the old start_read-only API');
          assert.equal(event.execution, 'native');
          assert.ok((await readdir(options!.cwd!)).includes('current.txt'));
          return 'current files available';
        },
      }) };
      const coordinator = new Coordinator(home, factory);
      try {
        await coordinator.ready();
        const source: Task = { id: 'old', requestId: 'old', fingerprint: 'old', prompt: 'old task',
          status: 'completed', revision: 0, mode: 'real', execution, cwd: explicitCwd ? undefined : cwd, createdAt: 1, activeMs: 0, limitMs: 600000,
          report: 'Historical Worker had no shell, only snapshots', files: [{ id: 'f0', name: 'old.md', bytes: 1, sha256: 'missing-old-snapshot' }] };
        coordinator.store.create(source);
        const before = coordinator.store.get('old');
        coordinator.chat('continue', 'Continue the comparison using the full local tools');
        for (let i = 0; i < 100; i++) {
          if (coordinator.store.list().some(task => task.parentTaskId === 'old' && task.status === 'completed')) break;
          await delay(10);
        }
        const next = coordinator.store.list().find(task => task.parentTaskId === 'old');
        assert.ok(next, 'must dispatch even if legacy input snapshots are unavailable');
        assert.equal(next.status, 'completed'); assert.equal(next.execution, 'native'); assert.equal(next.cwd, cwd);
        assert.equal(workerCreated, true);
        assert.deepEqual(coordinator.store.get('old'), before, 'do not mutate or replay the historical task');
        await assert.rejects(access(join(home, 'tasks', next.id, 'inputs')));
      } finally { await coordinator.close(); await rm(home, { recursive: true, force: true }); }
    });
  }
}

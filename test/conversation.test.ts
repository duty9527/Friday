import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, type Task } from '../src/store.js';
import { publicData } from '../src/conversation.js';

async function fixture() { return mkdtemp(join(await realpath(tmpdir()), 'sa-chatdb-')); }
function task(id: string, originMessageId: string): Task {
  return { id, requestId: id, fingerprint: id, prompt: 'analyze', files: [], status: 'running', revision: 0, mode: 'offline', createdAt: Date.now(), limitMs: 600000, activeMs: 0, originMessageId };
}

test('one main transcript, message/work links and causal events survive reopen without deleting legacy tasks', async () => {
  const home = await fixture();
  try {
    const store = new Store(home);
    const chat = store.conversation;
    const message = chat.create({ id: randomUUID(), requestId: 'm1', role: 'user', text: '分析文件', status: 'queued', mode: 'offline', paths: ['/authorized/file.txt'] });
    const work = task(randomUUID(), message.id); store.create(work); chat.link(message.id, work.id);
    store.operation({ id: 'op1', taskId: work.id, fileId: 'f0', revision: 0, status: 'started', parentSpanId: 'worker-call' });
    const cursor = chat.latestSeq();
    store.transition(work.id, 'completed', undefined, 'report');
    chat.update(message.id, { status: 'completed' });
    assert.equal(chat.byRequest('m1')?.id, message.id);
    assert.deepEqual(chat.get(message.id).taskIds, [work.id]);
    const events = chat.trace({ messageId: message.id });
    assert.ok(events.some(event => event.spanId === 'op1' && event.parentSpanId === 'worker-call'));
    assert.ok(chat.trace({}, cursor).every(event => event.seq > cursor));
    store.close();
    const reopened = new Store(home);
    assert.equal(reopened.get(work.id).report, 'report');
    assert.equal(reopened.conversation.history().items[0]?.text, '分析文件');
    reopened.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('restart interrupts unfinished conversation and model spans instead of fabricating completed history', async () => {
  const home = await fixture();
  try {
    const store = new Store(home); const chat = store.conversation;
    const message = chat.create({ id: 'm1', role: 'assistant', text: 'partial', status: 'streaming', mode: 'real', paths: [] });
    chat.span({ rootId: message.id, messageId: message.id, spanId: 'model1' }, 'router', '模型请求', 'started');
    store.close();
    const resumed = new Store(home); resumed.recover();
    assert.equal(resumed.conversation.get(message.id).status, 'interrupted');
    assert.equal(resumed.conversation.get(message.id).text, 'partial');
    assert.ok(resumed.conversation.trace({ messageId: message.id }).some(event => event.spanId === 'model1' && event.status === 'interrupted'));
    resumed.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('nested state/message transactions roll back together and trace payloads are bounded and redacted', async () => {
  const home = await fixture();
  try {
    const store = new Store(home); const chat = store.conversation;
    assert.throws(() => store.transaction(() => {
      chat.create({ id: 'rollback', role: 'user', text: 'must not persist', status: 'queued', mode: 'offline', paths: [] });
      throw new Error('fixture rollback');
    }));
    assert.throws(() => chat.get('rollback'), /not found/);
    assert.equal(chat.latestSeq(), 0);
    const event = chat.span({ rootId: 'test' }, 'router', 'tool', 'started', { apiKey: 'secret', authorization: 'Bearer abcdefghijklmnop', text: 'sk-abcdefghijklmnop', big: 'x'.repeat(50000) });
    assert.ok(JSON.stringify(event.data).length < 17000);
    assert.doesNotMatch(JSON.stringify(event.data), /abcdefghijklmnop/);
    assert.equal((publicData({ access_token: 'test' }) as Record<string, unknown>).access_token, '[redacted]');
    store.close();
  } finally { await rm(home, { recursive: true, force: true }); }
});

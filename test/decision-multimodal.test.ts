import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { offlineFactory, type AgentFactory } from '../src/agent.js';
import { Coordinator } from '../src/coordinator.js';
import { messageImages } from '../src/message-images.js';
import type { AttachmentView } from '../src/view.js';
import { until } from './helpers/async.js';
import {
  DEFAULT_GEMINI_DECISION_BASE_URL,
  GEMINI_DECISION_MODEL,
  requestGeminiDecisions,
  resolveDecisionEndpoint,
  type DecisionContentBlock,
  type DecisionInput,
} from '../src/decision.js';

test('resolveDecisionEndpoint handles default, versioned, unversioned, and full /decisions URLs', () => {
  assert.equal(resolveDecisionEndpoint(), `${DEFAULT_GEMINI_DECISION_BASE_URL}/decisions`);
  assert.equal(resolveDecisionEndpoint('  '), `${DEFAULT_GEMINI_DECISION_BASE_URL}/decisions`);
  assert.equal(resolveDecisionEndpoint('https://proxy.example.com/'), 'https://proxy.example.com/v1beta/decisions');
  assert.equal(resolveDecisionEndpoint('https://proxy.example.com/v1beta/'), 'https://proxy.example.com/v1beta/decisions');
  assert.equal(resolveDecisionEndpoint('https://proxy.example.com/v1alpha'), 'https://proxy.example.com/v1alpha/decisions');
  assert.equal(resolveDecisionEndpoint('https://proxy.example.com/custom/v1beta/decisions/'), 'https://proxy.example.com/custom/v1beta/decisions');
});

test('requestGeminiDecisions preserves string input for backward compatibility', async () => {
  const originalFetch = globalThis.fetch;
  const captured: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        answers: {
          action: { type: 'choice', choice: 'open', confidence: 0.94 },
        },
        usage: { total_input_tokens: 120, total_output_tokens: 8, total_tokens: 128 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const input: DecisionInput = JSON.stringify({ goal: 'open settings' });
    const result = await requestGeminiDecisions(
      { apiKey: 'test-key-str', baseUrl: 'https://api.example.test/v1beta', timeoutMs: 2500 },
      input,
      {
        action: {
          type: 'choice',
          instructions: 'Pick next action',
          criteria: { open: 'Open settings', cancel: 'Cancel' },
        },
      },
    );

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.url, 'https://api.example.test/v1beta/decisions');
    assert.equal(captured[0]!.init?.method, 'POST');
    const headers = captured[0]!.init?.headers as Record<string, string>;
    assert.equal(headers['x-goog-api-key'], 'test-key-str');
    assert.equal(headers['Content-Type'], 'application/json');

    const body = JSON.parse(String(captured[0]!.init?.body)) as Record<string, unknown>;
    assert.equal(body.model, GEMINI_DECISION_MODEL);
    assert.equal(body.input, input);
    assert.deepEqual(result.answers, {
      action: { type: 'choice', choice: 'open', confidence: 0.94 },
    });
    assert.deepEqual(result.usage, { inputTokens: 120, totalTokens: 128 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestGeminiDecisions serializes multimodal text and image blocks verbatim', async () => {
  const originalFetch = globalThis.fetch;
  const capturedBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        answers: {
          next_step: { type: 'choice', choice: 'click_n3', confidence: 0.97 },
          done_prob: { type: 'noul', noul: 0.12, confidence: 0.91 },
        },
        usage: { total_input_tokens: 640, total_output_tokens: 14, total_tokens: 654 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const blocks: DecisionContentBlock[] = [
      { type: 'image', data: '/9j/4AAQSkZJRgABAQAAAQABAAD/', mime_type: 'image/jpeg' },
      { type: 'text', text: 'Goal: 打开 SmartTube\nNodes: [{"id":"n3","text":"SmartTube"}]' },
    ];
    const result = await requestGeminiDecisions(
      { apiKey: 'test-key-mm', baseUrl: 'https://api.example.test' },
      blocks,
      {
        next_step: {
          type: 'choice',
          instructions: 'Choose node or key action',
          criteria: { click_n3: 'Click SmartTube node n3', key_home: 'Press home' },
        },
        done_prob: {
          type: 'noul',
          instructions: 'Probability the goal is already satisfied',
        },
      },
    );

    assert.equal(capturedBodies.length, 1);
    assert.equal(capturedBodies[0]!.model, GEMINI_DECISION_MODEL);
    assert.deepEqual(capturedBodies[0]!.input, blocks);
    assert.equal(result.answers.next_step?.choice, 'click_n3');
    assert.equal(result.answers.done_prob?.noul, 0.12);
    assert.deepEqual(result.usage, { inputTokens: 640, totalTokens: 654 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestGeminiDecisions surfaces HTTP and malformed payload errors cleanly', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        requestGeminiDecisions(
          { apiKey: 'k' },
          [{ type: 'text', text: 'hello' }],
          { q: { type: 'noul', instructions: 'test' } },
        ),
      /Gemini Decision API HTTP 429: rate limited/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test('messageImages loads image attachments for TASK, FOLLOWUP, and BOSS_DECISION when supportsImages=true', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-msg-img-'));
  const imgPath = join(home, 'shot.png');
  await writeFile(imgPath, TINY_PNG);
  const att: AttachmentView = { kind: 'image', name: 'shot.png', status: 'ready', path: imgPath, mimeType: 'image/png', bytes: TINY_PNG.length };
  try {
    for (const kind of ['TASK', 'FOLLOWUP', 'BOSS_DECISION'] as const) {
      const payload = JSON.stringify({ kind, prompt: '请查看图片', attachments: [att] });
      const withImages = await messageImages(payload, true);
      assert.ok(withImages.images && withImages.images.length === 1, `${kind} should extract 1 image block`);
      assert.equal(withImages.images[0]!.mimeType, 'image/png');

      const withoutImages = await messageImages(payload, false);
      assert.deepEqual(withoutImages.images, [], `${kind} should strip images when model lacks vision`);
      assert.match(withoutImages.text, /不支持图像输入/);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Coordinator propagates image attachments into Worker TASK and FOLLOWUP events', async () => {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'sa-worker-img-'));
  const img1 = join(home, 'first.png');
  const img2 = join(home, 'second.png');
  await writeFile(img1, TINY_PNG);
  await writeFile(img2, TINY_PNG);
  const att1: AttachmentView = { kind: 'image', name: 'first.png', status: 'ready', path: img1, mimeType: 'image/png', bytes: TINY_PNG.length };
  const att2: AttachmentView = { kind: 'image', name: 'second.png', status: 'ready', path: img2, mimeType: 'image/png', bytes: TINY_PNG.length };

  const workerEvents: Array<{ kind: string; attachments?: AttachmentView[] }> = [];
  let createdTaskId: string | undefined;
  let routerError: string | undefined;
  let workerTurn = 0;
  const baseOffline = offlineFactory(5);
  const factory: AgentFactory = {
    mode: 'offline',
    nativeTools: true,
    modelTiers: baseOffline.modelTiers,
    resolveWorkerModel: baseOffline.resolveWorkerModel,
    async create(role, _id, tools) {
      return {
        close() {},
        async prompt(text) {
          const event = JSON.parse(text) as { kind: string; message?: { text?: string }; attachments?: AttachmentView[] };
          if (role === 'worker') {
            workerEvents.push({ kind: event.kind, attachments: event.attachments });
            workerTurn += 1;
            if (workerTurn === 1) await delay(80);
            return workerTurn === 1 ? 'first pass' : 'second pass';
          }
          if (event.kind === 'CHAT') {
            const msgText = event.message?.text ?? '';
            if (msgText.includes('第一张')) {
              const start = tools.find(t => t.name === 'start_work')!;
              try {
                const out = JSON.parse(await start.execute(JSON.stringify({ instruction: '分析第一张图', cwd: home }))) as { taskId: string };
                createdTaskId = out.taskId;
              } catch (err) {
                routerError = err instanceof Error ? err.message : String(err);
                throw err;
              }
              return '已派发看图';
            }
            if (msgText.includes('第二张') && createdTaskId) {
              const cont = tools.find(t => t.name === 'continue_work')!;
              await cont.execute(JSON.stringify({ taskId: createdTaskId, instruction: '补充分析第二张图' }));
              return '已追加第二张图';
            }
          }
          return '完成汇总';
        },
      };
    },
  };

  const coordinator = new Coordinator(home, factory);
  try {
    await coordinator.ready();
    coordinator.chat('req-img-1', '看第一张图', [img1], { channel: 'local' }, [att1]);
    await until(() => Boolean(createdTaskId || routerError));
    assert.equal(routerError, undefined);
    coordinator.chat('req-img-2', '追加第二张图', [img2], { channel: 'local' }, [att2]);
    await until(() => coordinator.store.get(createdTaskId!).status === 'completed');

    assert.ok(workerEvents.length >= 2);
    assert.equal(workerEvents[0]!.kind, 'TASK');
    assert.equal(workerEvents[0]!.attachments?.[0]?.path, img1);
    assert.equal(workerEvents[1]!.kind, 'FOLLOWUP');
    assert.equal(workerEvents[1]!.attachments?.[0]?.path, img2);
  } finally {
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
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

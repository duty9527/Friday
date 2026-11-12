import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePublicReply } from '../src/reply-filter.js';
import { isRetryableModelError } from '../src/agent.js';

const TASK = '84eeec04-1111-4222-8333-944445555666';
const OTHER = 'bff1861b-aaaa-4bbb-8ccc-dddddddddddd';

test('strips leaked task IDs in parentheses and after a task label', () => {
  assert.equal(sanitizePublicReply('已经派出去了（任务 `84eeec04`）。', [TASK]), '已经派出去了。');
  assert.equal(sanitizePublicReply('清理任务已派出（`bff1861b`），去删报告文件。', [OTHER]), '清理任务已派出，去删报告文件。');
  assert.equal(sanitizePublicReply(`查看任务 ${TASK} 的结果`, []), '查看任务 的结果');
  assert.equal(sanitizePublicReply(`记录 ${OTHER} 已更新`), '记录 已更新');
});

test('keeps short hex strings that are not known task IDs (e.g. git commits)', () => {
  assert.equal(sanitizePublicReply('最新提交是（`f730c9fa`），已推送。', [TASK]), '最新提交是（`f730c9fa`），已推送。');
});

test('replaces internal staging paths but keeps ordinary user paths', () => {
  assert.equal(
    sanitizePublicReply('文档落到 `~/.super-agent/wechat-files/brief.md`，原件在 `~/Documents/ljzp_final.xlsx`。'),
    '文档落到 本地，原件在 `~/Documents/ljzp_final.xlsx`。',
  );
  assert.equal(sanitizePublicReply('图在 /Users/duty/.super-agent/inbound-media/a.jpg 里'), '图在 本地 里');
  assert.equal(sanitizePublicReply('报告在 ~/.super-agent/reports/x.md'), '报告在 ~/.super-agent/reports/x.md');
});

test('leaves the dispatch acknowledgment and WeChat native expressions untouched', () => {
  assert.equal(sanitizePublicReply('好的老板，任务已下发。', [TASK]), '好的老板，任务已下发。');
  assert.equal(sanitizePublicReply('这波操作确实稳 [旺柴] 🫡', [TASK]), '这波操作确实稳 [旺柴] 🫡');
});

test('classifies transient provider errors as retryable', () => {
  assert.ok(isRetryableModelError(new Error('Model request error: 429: {"type":"server_error","message":"The inference service is overloaded."}')));
  assert.ok(isRetryableModelError(new Error('503 Service Unavailable')));
  assert.ok(!isRetryableModelError(new Error("Cannot find module '/x/google-generative-ai.js'")));
  assert.ok(!isRetryableModelError(new Error('401 invalid api key')));
});

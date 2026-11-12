import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ImGateway } from '../src/im.js';

// Match Tencent openclaw-weixin 2.4.10: text_item.text is a JSON string,
// not HTML, a literal backslash-n string, or an array of lines.
test('WeChat iLink preserves multiline text in direct and conversation outbound request bodies', async () => {
  const home = await mkdtemp(join(tmpdir(), 'friday-wechat-text-'));
  const store = new Store(home);
  const gateway = new ImGateway({ store } as any);
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), 'https://wechat.invalid/ilink/bot/sendmessage');
    requests.push(String(init?.body));
    return Response.json({ ret: 0 });
  }) as typeof fetch;
  const text = '# ☀️ 基金午间持仓估值 · 2026-11-10 12:00\n\n💰 **总资产** 20794.33 元 ｜ **成本** 29020.00 元\n📈 **当日预估** -1.00 元（**-0.01%**）\n\n## 📋 明细（1 只）\n\n- 🟢 **示例基金** `000001`：资产 100.00（成本 200.00 / 1.00 份）｜当日 -1.00（-0.50%）｜累计 -50.00%\r\n\n> ⚠️ 盘中估值，锚定对应指数，以晚间官方披露为准。';
  try {
    store.saveImChannel({
      id: 'wx-text', platform: 'wechat', name: 'text regression', enabled: true,
      notifyAll: false, botToken: 'test-token', accountId: 'test-bot',
      apiBase: 'https://wechat.invalid', defaultTarget: 'test-user',
      allowedSenders: ['test-user'], contextTokens: { 'test-user': 'test-context' },
      pollIntervalMs: 5000, inboundCount: 0, outboundCount: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    await gateway.sendToChannel('wx-text', text);
    // Scheduled plugin output becomes a completed assistant conversation message.
    store.conversation.create({
      id: 'plugin-output', role: 'assistant', source: 'system', text,
      status: 'completed', paths: [], mode: 'real',
      origin: { channel: 'wechat', channelId: 'wx-text', accountId: 'test-bot',
        conversationId: 'test-user', senderId: 'test-user', contextToken: 'test-context' },
    });
    await (gateway as any).flushOutboundUpdates();
    assert.equal(requests.length, 2);
    for (const raw of requests) {
      assert.ok(raw.includes('\\n'), 'JSON wire encoding escapes actual newlines');
      const body = JSON.parse(raw);
      assert.equal(body.msg.item_list.length, 1);
      assert.equal(body.msg.item_list[0].type, 1);
      assert.equal(body.msg.item_list[0].text_item.text, text,
        'decoded iLink text preserves LF, CRLF, blank lines, indentation and Unicode exactly');
      assert.equal(body.msg.context_token, 'test-context');
    }
  } finally {
    await gateway.close();
    globalThis.fetch = originalFetch;
    store.close();
    await rm(home, { recursive: true, force: true });
  }
});

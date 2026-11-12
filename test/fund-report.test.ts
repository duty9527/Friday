import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFundReportDelivery, buildFundSummary } from '../src/fund-report.js';
import { Coordinator } from '../dist/coordinator.js';
import { offlineFactory } from '../src/agent.js';

const FULL_REPORT = [
  '☀️【基金午间持仓估值 · 2026-11-10 12:00】',
  '━━━━━━━━━━━━━━━━━━━━',
  '💰 当前持仓总资产：28700.12 元（总成本 29020.00 元）',
  '📈 当日预估收益：+12.34 元 (+0.04%)',
  '🏦 累计持仓总盈亏：-319.88 元 (-1.10%)',
  '━━━━━━━━━━━━━━━━━━━━',
  '📋 持仓明细（共 1 只）：',
  '🔴 测试基金 (018168)',
  '   • 资产/成本：28700.12 / 29020.00 元（份额 322.7790）',
  '   • 当日盈亏：+12.34 元 (+0.05%) | 累计：-319.88 元 (-1.10%)',
  '   • 净值口径：1.2345 [盘中估值(锚定恒生科技 +0.05%)]',
].join('\n');

const SUMMARY_DATA = {
  totalCost: 29020,
  totalAsset: 28700.12,
  totalDailyPnl: 12.34,
  dailyPnlPct: 0.04,
  totalPnl: -319.88,
  totalPnlPct: -1.1,
  holdings: [{ code: '018168' }],
};

test('fund report delivery: three-line summary plus verbatim Markdown attachment', () => {
  const now = new Date(2026, 10, 10, 12, 0, 0);
  const delivery = buildFundReportDelivery({
    plugin: 'fund-tracker', action: 'noon', message: FULL_REPORT, data: SUMMARY_DATA, now,
  });
  assert.ok(delivery);
  assert.equal(delivery!.fileName, 'fund-noon-2026-11-10.md');
  // Attachment carries the plugin message byte-for-byte: no re-formatting, no merged lines.
  assert.equal(delivery!.content, FULL_REPORT);
  const lines = delivery!.summary.split('\n');
  assert.equal(lines.length, 3);
  assert.ok(!delivery!.summary.endsWith('\n'));
  assert.match(lines[1]!, /总资产 28700\.12 元（成本 29020\.00 元）/);
  assert.match(lines[1]!, /当日 \+12\.34 元 \(\+0\.04%\)/);
  assert.match(lines[2]!, /累计 -319\.88 元 \(-1\.10%\)/);

  // Negative daily figures keep their sign.
  const down = buildFundSummary('settle', { ...SUMMARY_DATA, totalDailyPnl: -123.45, dailyPnlPct: -0.42 }, now);
  assert.match(down!, /当日 -123\.45 元 \(-0\.42%\)/);
});

test('fund report delivery only applies to fund-tracker noon/status/settle with structured data', () => {
  const now = new Date(2026, 10, 10, 12, 0, 0);
  const base = { plugin: 'fund-tracker', action: 'noon', message: FULL_REPORT, data: SUMMARY_DATA, now };
  assert.equal(buildFundReportDelivery({ ...base, action: 'settle' })!.fileName, 'fund-settle-2026-11-10.md');
  assert.equal(buildFundReportDelivery({ ...base, action: 'status' })!.fileName, 'fund-status-2026-11-10.md');
  assert.equal(buildFundReportDelivery({ ...base, plugin: 'system-pulse' }), undefined);
  assert.equal(buildFundReportDelivery({ ...base, action: 'init' }), undefined);
  assert.equal(buildFundReportDelivery({ ...base, data: { holdings: [] } }), undefined);
  assert.equal(buildFundReportDelivery({ ...base, data: undefined }), undefined);
  assert.equal(buildFundReportDelivery({ ...base, message: '   ' }), undefined);
});

test('scheduled fund plugin report is sent as one full markdown text message, no attachment', async () => {
  process.env.FUND_TRACKER_OFFLINE = '1';
  const home = await mkdtemp(join(tmpdir(), 'friday-fund-report-'));
  const coordinator = new Coordinator(home, offlineFactory(20));
  try {
    await coordinator.ready();
    const now = Date.now();
    coordinator.store.saveImChannel({
      id: 'wx-fund',
      platform: 'wechat',
      name: '微信基金通知',
      accountId: 'bot-1',
      botToken: 'token-1',
      defaultTarget: 'boss-wx',
      contextTokens: { 'boss-wx': 'ctx-fund' },
      allowedSenders: ['boss-wx'],
      enabled: true,
      notifyAll: true,
      inboundCount: 0,
      outboundCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const texts: Array<{ channelId: string; text: string; target?: string }> = [];
    const files: Array<{ channelId: string; name: string; target: string; contextToken?: string }> = [];
    coordinator.im.sendToChannel = async (channelId, text, options) => { texts.push({ channelId, text, target: options?.target }); };
    coordinator.im.sendWechatAttachment = async (channelId, name, options) => { files.push({ channelId, name, ...options }); };

    const timer = coordinator.addTimer('基金午间持仓估值', '每日12:00计算持仓盘中估值并通知', 86_400_000, home, undefined, {
      dailyAt: '12:00', plugin: 'fund-tracker', pluginAction: 'status',
      deliverChannelId: 'wx-fund', deliverTarget: 'boss-wx',
    });
    timer.nextRunAt = Date.now() - 1000;
    coordinator.store.saveTimer(timer);

    for (let i = 0; i < 200 && !texts.length; i++) await new Promise(r => setTimeout(r, 25));

    assert.equal(files.length, 0, 'the retired attachment delivery is not used anymore');
    assert.equal(texts.length, 1, 'one full text message delivered on the bound WeChat channel');
    assert.equal(texts[0]!.channelId, 'wx-fund');
    assert.equal(texts[0]!.target, 'boss-wx');

    const text = texts[0]!.text;
    assert.ok(text.startsWith('# 📊 '), 'markdown heading is the first line');
    assert.ok(text.includes('\n\n💰 **总资产**'), 'blank line then bold total assets line');
    assert.ok(/\n📈 \*\*当日预估\*\* [+-]?\d+\.\d{2} 元（\*\*[+-]?\d+\.\d{2}%\*\*）/.test(text));
    assert.ok(/\n🏦 \*\*累计\*\* [+-]?\d+\.\d{2} 元（\*\*[+-]?\d+\.\d{2}%\*\*）/.test(text));
    assert.ok(text.includes('\n\n## 📋 明细（7 只）\n\n- '), 'markdown heading plus unordered list');
    assert.ok(text.includes('`020989`'), 'fund code keeps inline-code formatting');
    assert.ok(text.includes('\n\n> ⚠️ 盘中估值'), 'closing quote block kept');
    assert.ok(!text.includes('━━━━━━━━'), 'old full-width separator removed');
    assert.ok(!text.includes('•'), 'old bullet char removed');

    // Stored conversation body must equal the outgoing text character for character.
    const stored = coordinator.store.conversation.allMessages().filter(item => item.role === 'assistant');
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.text, text, 'stored report equals delivered report');
    assert.equal((text.match(/\n/g) ?? []).length, stored[0]!.text.split('\n').length - 1);
    assert.equal(coordinator.store.list().length, 0, 'plugin timer delivered without spawning an LLM Worker');
  } finally {
    delete process.env.FUND_TRACKER_OFFLINE;
    await coordinator.close();
    await rm(home, { recursive: true, force: true });
  }
});

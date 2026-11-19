import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Coordinator } from '../src/coordinator.js';
import { offlineFactory } from '../src/agent.js';
import { expectedUsQdiiNavDate, parseQuoteTimestamp, runAction as runFundTrackerAction } from '../plugins/fund-tracker/index.mjs';
import { until } from './helpers/async.js';
import { withTempHome } from './helpers/tmp-home.js';

test('scheduled fund plugin report is sent as one full markdown text message, no attachment', async () => {
  process.env.FUND_TRACKER_OFFLINE = '1';
  try {
    await withTempHome('friday-fund-', async home => {
      const pluginDataDir = join(home, 'plugins', 'fund-tracker');
      await mkdir(pluginDataDir, { recursive: true, mode: 0o700 });
      await writeFile(join(pluginDataDir, 'config.json'), JSON.stringify({
        holdings: [{
          code: '990001',
          name: '测试估值基金',
          fundType: 'a_index',
          proxySymbol: 'sh000300',
          proxyName: '沪深300',
          positionRatio: 0.95,
          initAmount: 1000,
          cost: 1000,
          initNav: 1.0,
          initNavDate: '2026-11-09',
        }],
      }), { mode: 0o600 });

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
        coordinator.im.sendToChannel = async (channelId, text, options) => {
          texts.push({ channelId, text, target: options?.target });
        };
        coordinator.im.sendWechatAttachment = async (channelId, name, options) => {
          files.push({ channelId, name, ...options });
        };

        const timer = coordinator.addTimer('基金午间持仓估值', '每日12:00计算持仓盘中估值并通知', 86_400_000, home, undefined, {
          dailyAt: '12:00',
          plugin: 'fund-tracker',
          pluginAction: 'status',
          deliverChannelId: 'wx-fund',
          deliverTarget: 'boss-wx',
        });
        timer.nextRunAt = Date.now() - 1000;
        coordinator.store.saveTimer(timer);

        await until(() => texts.length >= 1, 5_000, 25);

        assert.equal(files.length, 0, 'the retired attachment delivery is not used anymore');
        assert.equal(texts.length, 1, 'one full text message delivered on the bound WeChat channel');
        assert.equal(texts[0]!.channelId, 'wx-fund');
        assert.equal(texts[0]!.target, 'boss-wx');

        const text = texts[0]!.text;
        assert.ok(text.startsWith('# 📊 '), 'markdown heading is the first line');
        assert.ok(text.includes('\n\n💰 **总资产**'), 'blank line then bold total assets line');
        assert.ok(/💰 \*\*总资产\*\* \d+\.\d{2} ｜ \*\*成本\*\* \d+\.\d{2} ｜ \*\*当日\*\* [+-]?\d+\.\d{2} 元（[+-]?\d+\.\d{2}%） ｜ \*\*累计\*\* [+-]?\d+\.\d{2} 元（[+-]?\d+\.\d{2}%）/.test(text));
        assert.ok(text.includes('## 【📈 股票】'));
        assert.ok(text.includes('## 【🏦 基金】'));
        assert.ok(/`\d{6}`/.test(text), 'fund code keeps inline-code formatting');
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
        await coordinator.close();
      }
    });
  } finally {
    delete process.env.FUND_TRACKER_OFFLINE;
  }
});

test('fund-tracker parses HK/US/A-share quote timestamps, degrades gracefully per holding, and avoids re-counting unproxied historical returns', async () => {
  assert.deepEqual(parseQuoteTimestamp('20261118115936'), {
    quoteDate: '2026-11-18',
    quoteStamp: '2026-11-18 11:59:36',
  });
  assert.deepEqual(parseQuoteTimestamp('2026/11/18 11:59:32'), {
    quoteDate: '2026-11-18',
    quoteStamp: '2026-11-18 11:59:32',
  });
  assert.deepEqual(parseQuoteTimestamp('2026-11-17 17:15:59'), {
    quoteDate: '2026-11-17',
    quoteStamp: '2026-11-17 17:15:59',
  });
  assert.equal(parseQuoteTimestamp('invalid'), null);

  await withTempHome('friday-fund-quotes-', async home => {
    const pluginDataDir = join(home, 'plugins', 'fund-tracker');
    await mkdir(pluginDataDir, { recursive: true, mode: 0o700 });
    await writeFile(join(pluginDataDir, 'config.json'), JSON.stringify({
      holdings: [
        {
          code: '002131',
          name: '利欧股份',
          fundType: 'a_stock',
          proxySymbol: 'sz002131',
          proxyName: '利欧股份',
          positionRatio: 1,
          initAmount: 31951.94,
          cost: 31951.94,
          initNav: 4.5,
          initNavDate: '2026-11-18',
          shares: 7100,
        },
        {
          code: '020989',
          name: '南方恒生科技ETF发起联接(QDII)C',
          fundType: 'hk_etf_feeder',
          proxySymbol: 'hkHSTECH',
          proxyName: '恒生科技指数',
          positionRatio: 0.95,
          initAmount: 6840.2,
          cost: 10000,
          initNav: 0.952,
          initNavDate: '2026-11-09',
          shares: 7185.084,
        },
        {
          code: '024749',
          name: '博时中证卫星产业指数C',
          fundType: 'a_index',
          proxySymbol: 'sz159206',
          proxyName: '卫星ETF',
          positionRatio: 0.95,
          initAmount: 5602.24,
          cost: 10000,
          initNav: 0.8479,
          initNavDate: '2026-11-09',
          shares: 6607.1942,
        },
        {
          code: '018064',
          name: '华夏标普500ETF发起式联接(QDII)A',
          fundType: 'us_qdii',
          proxySymbol: '',
          proxyName: '',
          positionRatio: 0.95,
          initAmount: 7000,
          cost: 7000,
          initNav: 1.6397,
          initNavDate: '2026-11-16',
          shares: 4472.74,
        },
      ],
    }), { mode: 0o600 });

    const fixedNow = new Date('2026-11-18T12:00:00+08:00').getTime();

    const buildTencentPacket = (lines: string[]) => {
      const body = `${lines.join('\n')}\n`;
      return new Response(new TextEncoder().encode(body), { status: 200 });
    };

    const makeQuoteLine = (key: string, name: string, code: string, price: string, prevClose: string, quoteTime: string, changePct: string) => {
      const parts = new Array(40).fill('0');
      parts[0] = '100';
      parts[1] = name;
      parts[2] = code;
      parts[3] = price;
      parts[4] = prevClose;
      parts[30] = quoteTime;
      parts[32] = changePct;
      return `v_${key}="${parts.join('~')}";`;
    };

    // 1. Fresh HK quote (YYYY/MM/DD HH:mm:ss) + Stale A-share quote (20261117161445) + Missing ETF quote + unproxied QDII
    const mockFetchStaleAndMissing: typeof fetch = async input => {
      const url = String(input);
      if (url.includes('api.fund.eastmoney.com')) {
        if (url.includes('fundCode=018064')) {
          return new Response(JSON.stringify({
            Data: {
              LSJZList: [
                { FSRQ: '2026-11-16', DWJZ: '1.6397', LJJZ: '1.6397', JZZZL: '-1.83' },
              ],
            },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          Data: {
            LSJZList: [
              { FSRQ: '2026-11-17', DWJZ: '0.8880', LJJZ: '0.8880', JZZZL: '-1.11' },
            ],
          },
        }), { status: 200 });
      }
      return buildTencentPacket([
        makeQuoteLine('sz002131', '利欧股份', '002131', '3.83', '4.00', '20261117161445', '-4.25'),
        makeQuoteLine('hkHSTECH', '恒生科技指数', 'HSTECH', '3703.22', '3758.17', '2026/11/18 11:59:32', '-1.49'),
      ]);
    };

    const res1 = await runFundTrackerAction('noon', {}, {
      pluginDataDir,
      nowFn: () => fixedNow,
      fetchFn: mockFetchStaleAndMissing,
    });
    assert.equal(res1.ok, true);
    const msg1 = String(res1.message ?? '');
    assert.match(msg1, /南方恒生科技ETF发起联接\(QDII\)C.*当日 -90\.53（-1\.42%）.*锚定恒生科技指数 -1\.49%，报价时间 2026-11-18 11:59:32/);
    assert.match(msg1, /利欧股份.*当日 数据过期\(2026-11-17\).*⚠️ 数据过期\(非当日行情，数据日期 2026-11-17，报价时间 2026-11-17 16:14:45/);
    assert.match(msg1, /博时中证卫星产业指数C.*当日 行情未取到.*⚠️ 行情未取到\(锚定卫星ETF\[sz159206\]无有效报价/);
    assert.doesNotMatch(msg1, /锚定恒生科技指数 0\.00%/);
    assert.doesNotMatch(msg1, /锚定卫星ETF 0\.00%/);

    // Unproxied QDII whose latest official NAV is 2026-11-16 (-1.83%) must NOT re-count -1.83% on 2026-11-18
    const summary1 = res1.data as {
      stocks: { count: number; dailyPnl: number };
      funds: { count: number; dailyPnl: number };
      holdings: Array<{ code: string; dailyPnl: number; changePct: number; quoteMissing?: boolean }>;
    };
    assert.equal(summary1.stocks.count, 1);
    assert.equal(summary1.funds.count, 3);
    const qdiiRow = summary1.holdings.find(h => h.code === '018064');
    assert.equal(qdiiRow?.dailyPnl, 0);
    assert.equal(qdiiRow?.changePct, 0);

    // 2. When Tencent quote endpoint fails or omits an A-stock quote, report degrades per holding instead of aborting
    const mockFetchStockError: typeof fetch = async input => {
      const url = String(input);
      if (url.includes('api.fund.eastmoney.com')) {
        return new Response(JSON.stringify({
          Data: {
            LSJZList: [
              { FSRQ: '2026-11-18', DWJZ: '0.9000', LJJZ: '0.9000', JZZZL: '1.35' },
            ],
          },
        }), { status: 200 });
      }
      throw new Error('Tencent quote timeout');
    };

    const res2 = await runFundTrackerAction('noon', {}, {
      pluginDataDir,
      nowFn: () => fixedNow,
      fetchFn: mockFetchStockError,
    });
    assert.equal(res2.ok, true);
    const msg2 = String(res2.message ?? '');
    assert.match(msg2, /利欧股份.*当日 行情未取到.*⚠️ 行情未取到/);
    const summary2 = res2.data as {
      stocks: { dailyPnl: number };
      holdings: Array<{ code: string; dailyPnl: number; quoteMissing?: boolean }>;
    };
    const stockRow2 = summary2.holdings.find(h => h.code === '002131');
    assert.equal(stockRow2?.quoteMissing, true);
    assert.equal(stockRow2?.dailyPnl, 0);
    assert.equal(summary2.stocks.dailyPnl, 0);
  });
});

test('fund-tracker settles US QDII T-1 NAV on winter 21:30 settle, switches to live estimation at 23:30, handles US holidays cleanly, and serves dashboard', async () => {
  await withTempHome('friday-fund-qdii-', async home => {
    const pluginDataDir = join(home, 'plugins', 'fund-tracker');
    await mkdir(pluginDataDir, { recursive: true, mode: 0o700 });
    await writeFile(join(pluginDataDir, 'config.json'), JSON.stringify({
      holdings: [
        {
          code: '018064',
          name: '华夏标普500ETF发起式联接(QDII)A',
          fundType: 'us_qdii',
          proxySymbol: '',
          proxyName: '',
          positionRatio: 0.95,
          initAmount: 7000,
          cost: 7000,
          initNav: 1.565,
          initNavDate: '2025-10-01',
          shares: 4472.7389,
        },
        {
          code: '016055',
          name: '博时纳斯达克100ETF发起式联接(QDII)A',
          fundType: 'us_qdii',
          proxySymbol: 'usNDX',
          proxyName: '纳斯达克100',
          positionRatio: 0.95,
          initAmount: 318.66,
          cost: 300,
          initNav: 1.9969,
          initNavDate: '2026-11-09',
          shares: 159.5773,
        },
      ],
    }), { mode: 0o600 });

    assert.equal(expectedUsQdiiNavDate({ date: '2026-11-18', weekday: 'Wed', isWeekend: false }), '2026-11-17');
    assert.equal(expectedUsQdiiNavDate({ date: '2026-11-16', weekday: 'Mon', isWeekend: false }), '2026-11-13');
    assert.equal(expectedUsQdiiNavDate({ date: '2026-11-21', weekday: 'Sat', isWeekend: true }), null);

    // 1. Update proxySymbol via set-holding
    const setProxy = await runFundTrackerAction('set-holding', {
      code: '018064',
      proxySymbol: 'usINX',
      proxyName: '标普500',
    }, { pluginDataDir });
    assert.equal(setProxy.ok, true);
    assert.equal((setProxy.data as Record<string, unknown>)?.proxy_symbol, 'usINX');
    assert.equal((setProxy.data as Record<string, unknown>)?.proxy_name, '标普500');

    const makeQuoteLine = (key: string, name: string, code: string, price: string, prevClose: string, quoteTime: string, changePct: string) => {
      const parts = new Array(40).fill('0');
      parts[0] = '200';
      parts[1] = name;
      parts[2] = code;
      parts[3] = price;
      parts[4] = prevClose;
      parts[30] = quoteTime;
      parts[32] = changePct;
      return `v_${key}="${parts.join('~')}";`;
    };

    let quotePhase: 'pre_open' | 'night_open' | 'holiday' = 'pre_open';
    const mockFetch: typeof fetch = async input => {
      const url = String(input);
      if (url.includes('api.fund.eastmoney.com')) {
        if (quotePhase === 'holiday') {
          return new Response(JSON.stringify({
            Data: {
              LSJZList: [
                { FSRQ: '2026-11-16', DWJZ: url.includes('018064') ? '1.6397' : '1.9479', LJJZ: '1.6397', JZZZL: '-1.83' },
              ],
            },
          }), { status: 200 });
        }
        if (url.includes('fundCode=018064')) {
          return new Response(JSON.stringify({
            Data: {
              LSJZList: [
                { FSRQ: '2026-11-17', DWJZ: '1.6228', LJJZ: '1.6228', JZZZL: '-1.03' },
                { FSRQ: '2026-11-16', DWJZ: '1.6397', LJJZ: '1.6397', JZZZL: '-1.83' },
              ],
            },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          Data: {
            LSJZList: [
              { FSRQ: '2026-11-17', DWJZ: '1.9343', LJJZ: '1.9343', JZZZL: '-0.70' },
              { FSRQ: '2026-11-16', DWJZ: '1.9479', LJJZ: '1.9479', JZZZL: '-2.55' },
            ],
          },
        }), { status: 200 });
      }
      if (quotePhase === 'pre_open') {
        return new Response(new TextEncoder().encode([
          makeQuoteLine('usINX', '标普500', '.INX', '7340.53', '7393.00', '2026-11-17 17:15:59', '-0.71'),
          makeQuoteLine('usNDX', '纳斯达克100', 'NDX', '27001.78', '27198.00', '2026-11-17 17:15:59', '-0.72'),
        ].join('\n')), { status: 200 });
      }
      if (quotePhase === 'night_open') {
        return new Response(new TextEncoder().encode([
          makeQuoteLine('usINX', '标普500', '.INX', '7324.54', '7340.53', '2026-11-18 10:30:00', '-0.22'),
          makeQuoteLine('usNDX', '纳斯达克100', 'NDX', '27061.40', '27001.78', '2026-11-18 10:30:00', '0.22'),
        ].join('\n')), { status: 200 });
      }
      return new Response(new TextEncoder().encode([
        makeQuoteLine('usINX', '标普500', '.INX', '7393.00', '7393.00', '2026-11-16 17:15:59', '0.00'),
        makeQuoteLine('usNDX', '纳斯达克100', 'NDX', '27198.00', '27198.00', '2026-11-16 17:15:59', '0.00'),
      ].join('\n')), { status: 200 });
    };

    // 2. 21:30 settle on 2026-11-18 (winter): official 2026-11-17 NAV disclosed even though Tencent US quote is still 2026-11-17
    const settleNow = Date.parse('2026-11-18T21:30:01+08:00');
    const settleRes = await runFundTrackerAction('settle', {}, {
      pluginDataDir,
      nowFn: () => settleNow,
      fetchFn: mockFetch,
    });
    assert.equal(settleRes.ok, true);
    const settleMsg = String(settleRes.message ?? '');
    assert.match(settleMsg, /华夏标普500.*当日 -75\.59（-1\.03%）.*✅ 正式净值\(2026-11-17，QDII晚间披露\)/);
    assert.match(settleMsg, /博时纳斯达克100.*当日 -2\.17（-0\.70%）.*✅ 正式净值\(2026-11-17，QDII晚间披露\)/);
    assert.doesNotMatch(settleMsg, /数据过期/);

    // 3. Cached dashboard (refresh=false) reads today's settle snapshot silently (notify=false) and populates snapshots + navHistory
    const dashCached = await runFundTrackerAction('dashboard', { refresh: false }, {
      pluginDataDir,
      nowFn: () => settleNow,
      fetchFn: async () => { throw new Error('offline cached dashboard must not fetch'); },
    });
    assert.equal(dashCached.ok, true);
    assert.equal(dashCached.notify, false);
    const dashData = dashCached.data as {
      summary: { totalDailyPnl: number; holdings: Array<{ code: string; hasTodayOfficialNav: boolean }> };
      snapshots: Array<{ date: string; kind: string; dailyPnl: number }>;
      navHistory: Record<string, Array<{ navDate: string; nav: number }>>;
    };
    assert.equal(dashData.summary.totalDailyPnl, -77.76);
    assert.equal(dashData.summary.holdings.every(h => h.hasTodayOfficialNav), true);
    assert.equal(dashData.snapshots.length, 1);
    assert.equal(dashData.snapshots[0]?.kind, 'settle');
    assert.equal(dashData.navHistory['018064']?.length, 2);

    // 4. Night 23:30 status after US market opens switches to live night-session valuation on top of 2026-11-17 NAV
    quotePhase = 'night_open';
    const nightRes = await runFundTrackerAction('status', {}, {
      pluginDataDir,
      nowFn: () => Date.parse('2026-11-18T23:30:00+08:00'),
      fetchFn: mockFetch,
    });
    assert.equal(nightRes.ok, true);
    const nightMsg = String(nightRes.message ?? '');
    assert.match(nightMsg, /华夏标普500.*盘中估值\(锚定标普500 -0\.22%，报价时间 2026-11-18 10:30:00\)/);
    assert.match(nightMsg, /博时纳斯达克100.*盘中估值\(锚定纳斯达克100 \+0\.22%，报价时间 2026-11-18 10:30:00\)/);

    // 5. US holiday: Eastmoney and Tencent stop cleanly at an earlier date -> calm holiday label instead of stale error
    await withTempHome('friday-fund-holiday-', async holidayHome => {
      const holidayDir = join(holidayHome, 'plugins', 'fund-tracker');
      await mkdir(holidayDir, { recursive: true, mode: 0o700 });
      await writeFile(join(holidayDir, 'config.json'), JSON.stringify({
        holdings: [
          {
            code: '018064',
            name: '华夏标普500ETF发起式联接(QDII)A',
            fundType: 'us_qdii',
            proxySymbol: 'usINX',
            proxyName: '标普500',
            positionRatio: 0.95,
            initAmount: 7000,
            cost: 7000,
            initNav: 1.6397,
            initNavDate: '2026-11-16',
            shares: 4472.7389,
          },
        ],
      }), { mode: 0o600 });
      quotePhase = 'holiday';
      const holidayRes = await runFundTrackerAction('settle', {}, {
        pluginDataDir: holidayDir,
        nowFn: () => settleNow,
        fetchFn: mockFetch,
      });
      assert.equal(holidayRes.ok, true);
      const hMsg = String(holidayRes.message ?? '');
      assert.match(hMsg, /📅 美股休市\/未开盘/);
      assert.doesNotMatch(hMsg, /⚠️ 数据过期/);
      const hSummary = holidayRes.data as { holdings: Array<{ dailyPnl: number; quoteStale?: boolean; usMarketClosed?: boolean }> };
      assert.equal(hSummary.holdings[0]?.dailyPnl, 0);
      assert.equal(hSummary.holdings[0]?.quoteStale, false);
      assert.equal(hSummary.holdings[0]?.usMarketClosed, true);
    });
  });
});

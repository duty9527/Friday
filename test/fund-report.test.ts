import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Coordinator } from '../src/coordinator.js';
import { offlineFactory } from '../src/agent.js';
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
        assert.ok(/\n📈 \*\*当日预估\*\* [+-]?\d+\.\d{2} 元（\*\*[+-]?\d+\.\d{2}%\*\*）/.test(text));
        assert.ok(/\n🏦 \*\*累计\*\* [+-]?\d+\.\d{2} 元（\*\*[+-]?\d+\.\d{2}%\*\*）/.test(text));
        assert.ok(/\n\n## 📋 明细（\d+ 只）\n\n- /.test(text), 'markdown heading plus unordered list');
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

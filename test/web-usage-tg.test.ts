import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { serve } from '../src/server.js';
import { startWeb } from '../src/web-server.js';
import type {
  MainView,
  TelegramQuickConnectView,
  TelegramSyncCommandsView,
  UsagePreferences,
  UsageReportView,
} from '../src/view.js';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function createWebFixture() {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'friday-web-usage-tg-'));
  const daemon = await serve({ home, mode: 'offline', offlineDelayMs: 20 });
  const web = await startWeb({ home, port: 0 });
  const entry = new URL(web.url);
  const base = entry.origin;
  const token = new URLSearchParams(entry.hash.slice(1)).get('token')!;
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  return {
    home,
    base,
    headers,
    close: async () => {
      await web.close();
      await daemon.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test('Web usage and Telegram UI files strictly adhere to CSP and zero inline style rules', async () => {
  const webRoot = fileURLToPath(new URL('../src/web/', import.meta.url));
  const indexHtml = await readFile(join(webRoot, 'index.html'), 'utf8');
  const usageHubTs = await readFile(join(webRoot, 'hubs', 'usage-hub.ts'), 'utf8');
  const systemHubTs = await readFile(join(webRoot, 'hubs', 'system-hub.ts'), 'utf8');
  const servicesHubTs = await readFile(join(webRoot, 'hubs', 'services-hub.ts'), 'utf8');
  const timerPluginHubTs = await readFile(join(webRoot, 'hubs', 'timer-plugin-hub.ts'), 'utf8');
  const imVoiceHubTs = await readFile(join(webRoot, 'hubs', 'im-voice-hub.ts'), 'utf8');
  const appleUiTs = await readFile(join(webRoot, 'plugins', 'apple-devices-ui.ts'), 'utf8');
  const miotUiTs = await readFile(join(webRoot, 'plugins', 'miot-ui.ts'), 'utf8');
  const ninebotUiTs = await readFile(join(webRoot, 'plugins', 'ninebot-ui.ts'), 'utf8');
  const clientTs = await readFile(join(webRoot, 'client.ts'), 'utf8');
  const styleCss = await readFile(join(webRoot, 'style.css'), 'utf8');

  assert.match(indexHtml, /id="open-system-hub-top"/);
  assert.match(indexHtml, /id="system-top-badge"/);
  assert.match(indexHtml, /id="system-hub-backdrop"/);
  assert.match(indexHtml, /id="system-hub-modal"/);
  assert.match(indexHtml, /id="system-tab-models"/);
  assert.match(indexHtml, /id="system-tab-usage"/);
  assert.match(indexHtml, /id="system-tab-services"/);
  assert.match(indexHtml, /id="system-panel-models"/);
  assert.match(indexHtml, /id="system-panel-usage"/);
  assert.match(indexHtml, /id="system-panel-services"/);
  assert.match(indexHtml, /id="geo-amap-key-input"/);
  assert.doesNotMatch(indexHtml, /id="ninebot-cfg-amap"/, 'AMap key input must live in System Base');
  assert.match(indexHtml, /id="model-top-badge"/);
  assert.match(indexHtml, /id="usage-top-badge"/);
  assert.match(indexHtml, /id="open-mindmap-trace"/);
  assert.doesNotMatch(indexHtml, /id="open-model-hub-top"/, 'model hub must live under SYS system base');
  assert.doesNotMatch(indexHtml, /id="open-usage-hub-top"/, 'usage hub must live under SYS system base');
  assert.doesNotMatch(indexHtml, /id="open-mindmap-top"/, 'mindmap link must live inside trace heading');
  assert.match(indexHtml, /id="im-tg-token-input"/);
  assert.match(indexHtml, /id="im-tg-allow-input"/);
  assert.match(indexHtml, /id="im-tg-quick-btn"/);
  assert.match(indexHtml, /id="im-tg-quick-status"/);

  assert.doesNotMatch(indexHtml, /\sstyle\s*=/i, 'index.html must not contain inline style attributes');
  assert.doesNotMatch(indexHtml, /<script(?![^>]*\bsrc=)[^>]*>/i, 'index.html must not contain inline scripts');
  assert.doesNotMatch(indexHtml, /\son[a-z]+\s*=/i, 'index.html must not contain inline event handlers');

  for (const [name, src] of [
    ['usage-hub.ts', usageHubTs],
    ['system-hub.ts', systemHubTs],
    ['services-hub.ts', servicesHubTs],
    ['timer-plugin-hub.ts', timerPluginHubTs],
    ['im-voice-hub.ts', imVoiceHubTs],
    ['apple-devices-ui.ts', appleUiTs],
    ['miot-ui.ts', miotUiTs],
    ['ninebot-ui.ts', ninebotUiTs],
    ['client.ts', clientTs],
  ] as const) {
    assert.doesNotMatch(src, /\.style\./, `${name} must not mutate element.style`);
    assert.doesNotMatch(src, /setAttribute\(\s*['"]style['"]/, `${name} must not set style attributes`);
    assert.doesNotMatch(src, /\.innerHTML\b/, `${name} must not assign innerHTML`);
    assert.doesNotMatch(src, /style="/, `${name} must not emit inline style attributes`);
  }

  for (const selector of [
    '.telegram-hero-card',
    '.telegram-quick-status',
    '.usage-chart-svg',
    '.usage-share-progress',
    '.usage-period-card',
    '.usage-actor-card',
    '.usage-cache-chip-hit',
    '.usage-cache-chip-savings',
    '.usage-cache-chip-surcharge',
  ]) {
    assert.ok(styleCss.includes(selector), `style.css must define ${selector}`);
  }
});

test('Web /api/view, /api/usage (day/week/month + tzOffsetMin), and /api/usage-prefs work end-to-end', { timeout: 15_000 }, async () => {
  const f = await createWebFixture();
  try {
    // 1. Static CSP header & modular JS assets check
    const pageRes = await fetch(f.base);
    assert.equal(pageRes.status, 200);
    const csp = pageRes.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    const usageModuleRes = await fetch(`${f.base}/hubs/usage-hub.js`);
    assert.equal(usageModuleRes.status, 200);
    assert.match(usageModuleRes.headers.get('content-type') ?? '', /javascript/);

    // 2. Auth checks
    assert.equal((await fetch(`${f.base}/api/usage`)).status, 401);
    assert.equal((await fetch(`${f.base}/api/usage-prefs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currency: 'USD' }),
    })).status, 401);

    // 3. Empty initial /api/view includes usageToday
    const initialView = await (await fetch(`${f.base}/api/view`, { headers: f.headers })).json() as MainView;
    assert.ok(initialView.usageToday, '/api/view must return usageToday');
    assert.equal(initialView.usageToday.calls, 0);
    assert.equal(initialView.usageToday.totalTokens, 0);
    assert.equal(initialView.usageToday.currency, 'CNY');
    assert.equal(initialView.usageToday.usdToCnyRate, 7.25);

    const localTz = new Date().getTimezoneOffset();
    const emptyDay = await (await fetch(
      `${f.base}/api/usage?granularity=day&tzOffsetMin=${localTz}`,
      { headers: f.headers },
    )).json() as UsageReportView;
    assert.equal(emptyDay.granularity, 'day');
    assert.equal(emptyDay.buckets.length, 24);
    assert.equal(emptyDay.recentPeriods.length, 7);

    // 4. Seed model_usage rows into SQLite across today and previous day
    const now = Date.now();
    const todayAt = Math.max(emptyDay.startAt + 60_000, Math.min(emptyDay.endAt - 60_000, now - 5_000));
    const yesterdayAt = emptyDay.startAt - 43_200_000; // 12h before start of today
    const db = new DatabaseSync(join(f.home, 'state.sqlite'));
    try {
      const insert = db.prepare(`
        INSERT INTO model_usage(
          id, at, actor, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
          cost_usd, unit_input_usd, unit_output_usd, cost_source, status, task_id, message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run(
        'u-today-1', todayAt, 'router', 'deepseek', 'deepseek-chat',
        1000, 500, 200, 0, 0, 1700,
        0.0012, 0.27, 1.1, 'catalog', 'completed', null, 'msg-1',
      );
      insert.run(
        'u-today-2', todayAt + 1000, 'worker', 'anthropic', 'claude-sonnet-4',
        2000, 1000, 500, 0, 200, 3500,
        0.021375, 3, 15, 'estimated', 'completed', 'task-1', null,
      );
      insert.run(
        'u-prev-1', yesterdayAt, 'decision', 'google', 'gemini-decision-1',
        800, 200, 0, 0, 0, 1000,
        0.00016, 0.1, 0.4, 'catalog', 'failed', null, null,
      );
      insert.run(
        'u-tz-boundary', Date.UTC(2025, 5, 15, 16, 30, 0), 'probe', 'openai', 'gpt-4o-mini',
        500, 100, 0, 0, 0, 600,
        0.000135, 0.15, 0.6, 'estimated', 'completed', null, null,
      );
    } finally {
      db.close();
    }

    // 5. Verify /api/view reflects today's aggregated usageToday
    const afterView = await (await fetch(`${f.base}/api/view`, { headers: f.headers })).json() as MainView;
    assert.ok(afterView.usageToday);
    assert.equal(afterView.usageToday.calls, 2);
    assert.equal(afterView.usageToday.totalTokens, 5200);
    assert.equal(afterView.usageToday.cacheReadTokens, 700);
    assert.equal(afterView.usageToday.cacheWriteTokens, 0);
    assert.ok(afterView.usageToday.cacheHitRate > 0);
    assert.ok(afterView.usageToday.cacheSavingsUsd > 0);
    assert.ok(Math.abs(afterView.usageToday.costUsd - 0.022575) < 1e-6);
    assert.ok(Math.abs(afterView.usageToday.costCny - 0.022575 * 7.25) < 1e-5);

    // 6. Verify day report + model & actor breakdown
    const dayReport = await (await fetch(
      `${f.base}/api/usage?granularity=day&anchorDate=${emptyDay.todayDate}&tzOffsetMin=${localTz}`,
      { headers: f.headers },
    )).json() as UsageReportView;
    assert.equal(dayReport.totals.calls, 2);
    assert.equal(dayReport.totals.successCalls, 2);
    assert.equal(dayReport.totals.failedCalls, 0);
    assert.equal(dayReport.totals.totalTokens, 5200);
    assert.ok(Math.abs(dayReport.totals.cacheHitRate - 700 / 3700) < 1e-5);
    assert.ok(dayReport.totals.cacheSavingsUsd > 0);
    assert.ok(Math.abs(dayReport.totals.cacheSavingsCny - dayReport.totals.cacheSavingsUsd * 7.25) < 1e-6);
    assert.equal(dayReport.byModel.length, 2);
    assert.equal(dayReport.byModel[0]?.model, 'claude-sonnet-4');
    assert.equal(dayReport.byModel[0]?.unitCacheReadUsdPer1M, 0.3);
    assert.equal(dayReport.byModel[0]?.unitCacheWriteUsdPer1M, 3.75);
    assert.equal(dayReport.byModel[1]?.model, 'deepseek-chat');
    assert.equal(dayReport.byModel[1]?.unitCacheReadUsdPer1M, 0.07);
    assert.equal(dayReport.byModel[1]?.unitCacheWriteUsdPer1M, 0.27);
    assert.equal(dayReport.buckets.reduce((s, b) => s + b.cacheReadTokens, 0), 700);
    assert.equal(dayReport.byActor.worker?.calls, 1);
    assert.equal(dayReport.byActor.router?.calls, 1);

    // 7. Switch date to yesterday
    const prevDayReport = await (await fetch(
      `${f.base}/api/usage?granularity=day&anchorDate=${dayReport.prevAnchorDate}&tzOffsetMin=${localTz}`,
      { headers: f.headers },
    )).json() as UsageReportView;
    assert.equal(prevDayReport.totals.calls, 1);
    assert.equal(prevDayReport.totals.failedCalls, 1);
    assert.equal(prevDayReport.byModel[0]?.model, 'gemini-decision-1');
    assert.equal(prevDayReport.byActor.decision?.calls, 1);

    // 8. Week & Month reports + explicit timezone boundary verification
    const weekReport = await (await fetch(
      `${f.base}/api/usage?granularity=week&anchorDate=${dayReport.todayDate}&tzOffsetMin=${localTz}`,
      { headers: f.headers },
    )).json() as UsageReportView;
    assert.equal(weekReport.granularity, 'week');
    assert.equal(weekReport.tzOffsetMin, localTz);
    assert.equal(weekReport.buckets.length, 7);
    assert.equal(weekReport.recentPeriods.length, 8);
    assert.ok(weekReport.totals.calls >= 2);

    const monthReport = await (await fetch(
      `${f.base}/api/usage?granularity=month&anchorDate=${dayReport.todayDate}&tzOffsetMin=${localTz}`,
      { headers: f.headers },
    )).json() as UsageReportView;
    assert.equal(monthReport.granularity, 'month');
    assert.ok(monthReport.buckets.length >= 28 && monthReport.buckets.length <= 31);
    assert.equal(monthReport.recentPeriods.length, 6);
    assert.ok(monthReport.totals.calls >= 2);

    const utcDay = await (await fetch(
      `${f.base}/api/usage?granularity=day&anchorDate=2025-06-15&tzOffsetMin=0`,
      { headers: f.headers },
    )).json() as UsageReportView;
    assert.equal(utcDay.totals.calls, 1);
    assert.equal(utcDay.buckets[16]?.calls, 1);

    const utc8Day = await (await fetch(
      `${f.base}/api/usage?granularity=day&anchorDate=2025-06-16&tzOffsetMin=-480`,
      { headers: f.headers },
    )).json() as UsageReportView;
    assert.equal(utc8Day.totals.calls, 1);
    assert.equal(utc8Day.buckets[0]?.calls, 1);

    // 9. Update usage preferences (currency + rate)
    const prefsRes = await fetch(`${f.base}/api/usage-prefs`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ currency: 'USD', usdToCnyRate: 7.5 }),
    });
    assert.equal(prefsRes.status, 200);
    const prefs = await prefsRes.json() as UsagePreferences;
    assert.deepEqual(prefs, { currency: 'USD', usdToCnyRate: 7.5 });

    const viewAfterPrefs = await (await fetch(`${f.base}/api/view`, { headers: f.headers })).json() as MainView;
    assert.equal(viewAfterPrefs.usageToday?.currency, 'USD');
    assert.equal(viewAfterPrefs.usageToday?.usdToCnyRate, 7.5);
    assert.ok(Math.abs((viewAfterPrefs.usageToday?.costCny ?? 0) - 0.022575 * 7.5) < 1e-5);

    // 10. Invalid parameter validation
    assert.equal((await fetch(`${f.base}/api/usage?granularity=year`, { headers: f.headers })).status, 400);
    assert.equal((await fetch(`${f.base}/api/usage?anchorDate=2026-02-30`, { headers: f.headers })).status, 400);
    assert.equal((await fetch(`${f.base}/api/usage?tzOffsetMin=999`, { headers: f.headers })).status, 400);
    assert.equal((await fetch(`${f.base}/api/usage?tzOffsetMin=abc`, { headers: f.headers })).status, 400);
    assert.equal((await fetch(`${f.base}/api/usage-prefs`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ currency: 'EUR' }),
    })).status, 400);
    assert.equal((await fetch(`${f.base}/api/usage-prefs`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ usdToCnyRate: 200 }),
    })).status, 400);
  } finally {
    await f.close();
  }
});

test('Web /api/im-telegram-quick and /api/im-telegram-sync connect and sync commands with mock Telegram server', { timeout: 15_000 }, async () => {
  const telegramRequests: Array<{ path: string; body: Record<string, unknown> | undefined }> = [];
  const mockTgServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? '/';
    const rawBody = req.method === 'POST' ? await readBody(req) : '';
    const parsedBody = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : undefined;
    telegramRequests.push({ path: rawUrl, body: parsedBody });

    res.writeHead(200, { 'content-type': 'application/json' });
    if (rawUrl.includes('/getMe')) {
      res.end(JSON.stringify({
        ok: true,
        result: { id: 987654321, is_bot: true, first_name: 'Friday Test Bot', username: 'friday_test_bot' },
      }));
      return;
    }
    if (rawUrl.includes('/deleteWebhook')) {
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }
    if (rawUrl.includes('/setMyCommands')) {
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }
    if (rawUrl.includes('/getUpdates')) {
      res.end(JSON.stringify({ ok: true, result: [] }));
      return;
    }
    res.end(JSON.stringify({ ok: true, result: {} }));
  });

  await new Promise<void>(resolve => mockTgServer.listen(0, '127.0.0.1', resolve));
  const addr = mockTgServer.address();
  assert.ok(addr && typeof addr !== 'string');
  const mockBase = `http://127.0.0.1:${addr.port}`;

  const f = await createWebFixture();
  try {
    assert.equal((await fetch(`${f.base}/api/im-telegram-quick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botToken: '123:abc' }),
    })).status, 401);

    const invalidRes = await fetch(`${f.base}/api/im-telegram-quick`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ botToken: '   ' }),
    });
    assert.equal(invalidRes.status, 400);

    const quickRes = await fetch(`${f.base}/api/im-telegram-quick`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({
        botToken: '987654321:MOCK_TELEGRAM_TOKEN',
        allowedSenders: ['@alice', '10086'],
        apiBase: mockBase,
      }),
    });
    assert.equal(quickRes.status, 200);
    const quickView = await quickRes.json() as TelegramQuickConnectView;
    assert.equal(quickView.ok, true);
    assert.equal(quickView.bot.id, 987654321);
    assert.equal(quickView.bot.username, 'friday_test_bot');
    assert.equal(quickView.bot.firstName, 'Friday Test Bot');
    assert.equal(quickView.commandsRegistered, true);
    assert.equal(quickView.webhookCleared, true);
    assert.equal(quickView.channel.platform, 'telegram');
    assert.equal(quickView.channel.hasBotToken, true);
    assert.equal(quickView.channel.accountId, '@friday_test_bot');
    assert.deepEqual(quickView.channel.allowedSenders, ['@alice', '10086']);

    assert.ok(telegramRequests.some(r => r.path.includes('/getMe')), 'quickConnect must call getMe');
    assert.ok(telegramRequests.some(r => r.path.includes('/deleteWebhook')), 'quickConnect must call deleteWebhook');
    const firstSetCmds = telegramRequests.find(r => r.path.includes('/setMyCommands'));
    assert.ok(firstSetCmds && Array.isArray(firstSetCmds.body?.commands), 'quickConnect must call setMyCommands');
    const cmdNames = (firstSetCmds.body!.commands as Array<{ command: string }>).map(c => c.command);
    for (const expected of ['start', 'help', 'status', 'works', 'usage', 'id']) {
      assert.ok(cmdNames.includes(expected), `setMyCommands must register /${expected}`);
    }

    const viewAfterQuick = await (await fetch(`${f.base}/api/view`, { headers: f.headers })).json() as MainView;
    const savedCh = viewAfterQuick.imChannels?.find(ch => ch.id === quickView.channel.id);
    assert.ok(savedCh, 'quick-connected Telegram channel appears in /api/view');
    assert.equal(savedCh.hasBotToken, true);
    assert.equal('botToken' in (savedCh as unknown as Record<string, unknown>), false, 'botToken secret must never leak to /api/view');

    const syncRes = await fetch(`${f.base}/api/im-telegram-sync`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ id: quickView.channel.id }),
    });
    assert.equal(syncRes.status, 200);
    const syncView = await syncRes.json() as TelegramSyncCommandsView;
    assert.equal(syncView.ok, true);
    assert.ok(syncView.count >= 10);
    assert.equal(syncView.channel.id, quickView.channel.id);
    assert.equal(
      telegramRequests.filter(r => r.path.includes('/setMyCommands')).length,
      2,
      'sync must invoke setMyCommands again',
    );

    const unknownSync = await fetch(`${f.base}/api/im-telegram-sync`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ id: 'missing-channel-id' }),
    });
    assert.equal(unknownSync.status, 400);
  } finally {
    await f.close();
    await new Promise<void>(resolve => mockTgServer.close(() => resolve()));
  }
});

test('System Base /api/geo-config and /api/geo-probe save, mask, clear, and validate safely', { timeout: 15_000 }, async () => {
  const f = await createWebFixture();
  try {
    const initial = await (await fetch(`${f.base}/api/geo-config`, { headers: f.headers })).json() as {
      configured: boolean;
      source: string;
      maskedKey: string;
      cacheEntries: number;
    };
    assert.equal(initial.configured, false);
    assert.equal(initial.source, 'none');
    assert.equal(initial.cacheEntries, 0);

    const saved = await (await fetch(`${f.base}/api/geo-config`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ amapKey: 'my_secret_amap_key_9876' }),
    })).json() as {
      configured: boolean;
      source: string;
      maskedKey: string;
    };
    assert.equal(saved.configured, true);
    assert.equal(saved.source, 'system');
    assert.equal(saved.maskedKey, 'my_s****9876');
    assert.equal(JSON.stringify(saved).includes('my_secret_amap_key_9876'), false, 'plaintext API key must never leak');
    assert.equal(JSON.stringify(saved).includes(f.home), false, 'homeDir path must never leak');

    const cleared = await (await fetch(`${f.base}/api/geo-config`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({ clearAmapKey: true }),
    })).json() as {
      configured: boolean;
      source: string;
      maskedKey: string;
    };
    assert.equal(cleared.configured, false);
    assert.equal(cleared.source, 'none');

    const emptyProbe = await (await fetch(`${f.base}/api/geo-probe`, {
      method: 'POST',
      headers: f.headers,
      body: JSON.stringify({}),
    })).json() as {
      ok: boolean;
      message: string;
    };
    assert.equal(emptyProbe.ok, false);
    assert.match(emptyProbe.message, /请先输入或保存/);
  } finally {
    await f.close();
  }
});

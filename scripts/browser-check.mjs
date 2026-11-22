#!/usr/bin/env node
// End-to-end check of the local Web conversation and Execution Chain Studio in a real browser.
//
//   node scripts/browser-check.mjs <entry-url> [--cdp-lib PATH] [--sample /absolute/path.txt] [--out-dir DIR]
//
// <entry-url> is the URL printed by `node dist/cli.js web`. The daemon behind it must be running
// (offline mode is fine). Requires Node 22+ and Chromium/Playwright (or pass --cdp-lib <path/to/lib/cdp.mjs> / CDP_HELPER_PATH).
// This script submits real messages to that daemon's transcript, so point it at a demo data directory.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const entryUrl = args.find(argument => /^https?:\/\//.test(argument));
const option = (name) => { const index = args.indexOf(`--${name}`); return index === -1 ? undefined : args[index + 1]; };
const helperPath = option('cdp-lib') ?? process.env.CDP_HELPER_PATH ?? process.env.CDP_HELPER;

if (!entryUrl) throw new Error('usage: node scripts/browser-check.mjs <entry-url from `web`> [--cdp-lib PATH] [--sample /abs/file.txt] [--out-dir DIR]');
const outDir = resolve(option('out-dir') ?? option('out') ?? 'tmp/browser-smoke');
const samplePath = option('sample');
const sample = samplePath ? resolve(samplePath) : undefined;
if (sample) await writeFile(sample, 'Router maintains one continuous conversation.\nWorkers execute isolated read-only tasks.\n').catch(() => {});

async function launchBrowserAdapter() {
  if (helperPath) {
    let cdp;
    try { cdp = await import(pathToFileURL(resolve(helperPath)).href); }
    catch { throw new Error(`CDP helper not found at ${helperPath}. Install the CDP helper or omit --cdp-lib to use Playwright.`); }
    const { Browser, sleep } = cdp;
    const browser = await Browser.launch();
    const page = await browser.newPage({ width: 1440, height: 900 });
    return { browser, page, sleep };
  }

  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    const candidates = [
      process.env.PLAYWRIGHT_PATH,
      join(homedir(), '.local/share/mise/installs/npm-playwright/latest/node_modules/playwright/index.mjs'),
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        playwright = await import(pathToFileURL(candidate).href);
        break;
      }
    }
  }
  if (!playwright?.chromium) {
    throw new Error('Playwright or --cdp-lib is required to run browser-check.mjs.');
  }
  const executablePath = existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined;
  const pwBrowser = await playwright.chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
    args: ['--no-sandbox'],
  });
  const context = await pwBrowser.newContext({ viewport: { width: 1440, height: 900 } });
  const pwPage = await context.newPage();
  const consoleErrors = [];
  pwPage.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  pwPage.on('pageerror', err => consoleErrors.push(err instanceof Error ? err.message : String(err)));
  const sleep = (ms) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

  const page = {
    consoleErrors,
    async goto(url, { settleMs = 250 } = {}) {
      await pwPage.goto(url, { waitUntil: 'domcontentloaded' });
      await sleep(settleMs);
    },
    async eval(fnOrExpr, arg) {
      return pwPage.evaluate(fnOrExpr, arg);
    },
    async send(method, params = {}) {
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && params.key) {
        await pwPage.keyboard.press(params.key);
      }
    },
    async setViewport({ width, height }) {
      await pwPage.setViewportSize({ width, height });
    },
    async screenshot({ path, quality = 85 }) {
      const isPng = String(path).toLowerCase().endsWith('.png');
      await pwPage.screenshot({ path, ...(isPng ? {} : { type: 'jpeg', quality }) });
    },
    async checkCoarseTouch() {
      const tok = await pwPage.evaluate(() => sessionStorage.getItem('friday.local-access-token') ?? sessionStorage.getItem('super-agent.local-access-token'));
      const touchCtx = await pwBrowser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
      try {
        const touchPage = await touchCtx.newPage();
        touchPage.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
        touchPage.on('pageerror', err => consoleErrors.push(err instanceof Error ? err.message : String(err)));
        const base = new URL(pwPage.url());
        await touchPage.goto(tok ? `${base.origin}/#token=${tok}` : base.origin, { waitUntil: 'domcontentloaded' });
        await until(() => touchPage.evaluate(() => !document.querySelector('#draft')?.disabled && document.querySelectorAll('#messages .message').length > 0), 'touch mobile hydration');
        await touchPage.evaluate(() => {
          const detailBtn = document.querySelector('#conv-detail-mode-btn');
          if (detailBtn && detailBtn.getAttribute('aria-pressed') !== 'true') detailBtn.click();
        });
        await until(() => touchPage.evaluate(() => document.querySelectorAll('.route-expand-btn').length > 0), 'coarse touch .route-expand-btn visible in audit detail mode');
        const touchMetrics = await touchPage.evaluate(() => {
          const coarse = window.matchMedia('(pointer: coarse)').matches;
          const expandBtns = [...document.querySelectorAll('.route-expand-btn')].map(el => Math.round(el.getBoundingClientRect().height));
          const msgBtns = [...document.querySelectorAll('.message-actions button')].map(el => Math.round(el.getBoundingClientRect().height));
          const avatar = document.querySelector('#companion-avatar')?.getBoundingClientRect();
          const pokes = [...document.querySelectorAll('.bot-poke-btn')].map(el => {
            const r = el.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) };
          });
          return {
            coarse,
            expandBtns,
            msgBtns,
            avatar: avatar ? { w: Math.round(avatar.width), h: Math.round(avatar.height) } : null,
            pokes,
          };
        });
        assert.equal(touchMetrics.coarse, true, 'touch emulation must match (pointer: coarse)');
        assert.ok(touchMetrics.expandBtns.length > 0 && touchMetrics.expandBtns.every(h => h <= 32), `coarse .route-expand-btn heights must be <=32px, got ${JSON.stringify(touchMetrics.expandBtns)}`);
        assert.ok(touchMetrics.msgBtns.length > 0 && touchMetrics.msgBtns.every(h => h <= 32), `coarse .message-actions button heights must be <=32px, got ${JSON.stringify(touchMetrics.msgBtns)}`);
        assert.ok(touchMetrics.avatar && touchMetrics.avatar.h <= 34 && Math.abs(touchMetrics.avatar.w - touchMetrics.avatar.h) <= 2, `coarse #companion-avatar must stay square <=34px, got ${JSON.stringify(touchMetrics.avatar)}`);
        assert.ok(touchMetrics.pokes.length > 0 && touchMetrics.pokes.every(p => p.w <= 32 && p.h <= 32), `coarse .bot-poke-btn must stay <=32px, got ${JSON.stringify(touchMetrics.pokes)}`);
      } finally {
        await touchCtx.close();
      }
    },
  };
  return {
    browser: { close: () => pwBrowser.close() },
    page,
    sleep,
  };
}

await mkdir(outDir, { recursive: true });
const entry = new URL(entryUrl);
const token = new URLSearchParams(entry.hash.slice(1)).get('token');
assert.match(token ?? '', /^[a-f0-9]{64}$/, 'entry URL must carry the access token fragment');

const { browser, page, sleep } = await launchBrowserAdapter();
const checks = [];
async function until(predicate, description, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) { if (await predicate()) return; await sleep(100); }
  throw new Error(`Timed out: ${description}`);
}
const count = () => page.eval("document.querySelectorAll('#messages article').length");
async function fill(text) {
  await page.eval(({ text }) => {
    const draft = document.querySelector('#draft');
    draft.value = text;
    draft.dispatchEvent(new Event('input', { bubbles: true }));
    draft.focus();
  }, { text });
}
const pressEnter = async () => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const burst = (texts) => page.eval(async ({ texts }) => {
  const tok = sessionStorage.getItem('friday.local-access-token') ?? sessionStorage.getItem('super-agent.local-access-token');
  for (const text of texts) {
    await fetch('/api/chat', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), text, files: [] }),
    });
  }
}, { texts });

function assertNoRawJsonDump(text, label) {
  assert.doesNotMatch(text, /^\s*(?:\{"[^"]+"\s*:|\[\s*\{)/m, `${label} must not contain raw JSON objects/arrays`);
  assert.doesNotMatch(text, /\{"type"\s*:\s*"text"|\{"content"\s*:\s*\[|\{"input"\s*:\s*"\{/, `${label} must not leak raw protocol/tool JSON`);
  assert.doesNotMatch(text, /sk-[A-Za-z0-9]{12,}/, `${label} must never expose credentials`);
}

try {
  await page.goto(entryUrl, { settleMs: 250 });
  await until(() => page.eval("!document.querySelector('#draft').disabled"), 'authenticated composer');
  assert.equal(await page.eval('location.hash'), '', 'the token fragment is cleared from the address bar');
  assert.equal(await page.eval("document.querySelector('input[type=file]') === null"), true, 'no upload control exists');
  assert.doesNotMatch(await page.eval('document.body.innerText'), /新建对话|切换会话/);
  assert.doesNotMatch(await page.eval("document.querySelector('meta[name=\"viewport\"]')?.getAttribute('content') ?? ''"), /maximum-scale\s*=\s*1/i, 'viewport meta must not set maximum-scale=1');
  assert.equal(await page.eval("document.querySelectorAll('h1').length"), 1, 'page must have a single <h1>');
  assert.equal(await page.eval("document.querySelector('.skip-link')?.getAttribute('href')"), '#main-content', '.skip-link must target #main-content');
  assert.equal(await page.eval("document.querySelector('#open-notebook-hub-top') === null"), true, 'M5 standalone #open-notebook-hub-top must not exist');
  assert.equal(await page.eval("document.querySelector('#notebook-hub-backdrop') === null"), true, 'legacy #notebook-hub-backdrop must not exist');
  assert.equal(await page.eval("['#open-memory-hub-top','#open-timer-hub-top','#open-plugin-hub-top','#open-im-hub-top','#open-system-hub-top'].every(s => document.querySelector(s) !== null)"), true, 'strict M1~M4 + SYS topbar hubs must exist');
  assert.equal(await page.eval("document.querySelector('.trace-tabs')?.getAttribute('role')"), 'group', '.trace-tabs filter bar must have role="group"');
  await page.screenshot({ path: `${outDir}/empty-desktop.jpg`, quality: 85 });
  checks.push('authenticated empty screen, fragment removal, accessibility landmarks, strict M1~M4+SYS topbar, and no session manager or upload control');

  // Verify M1 native <dialog closedby="any"> + merged Notes/Diary roving tablist + Escape focus restoration
  await page.eval(() => {
    const trigger = document.querySelector('#open-memory-hub-top');
    trigger?.focus();
    trigger?.click();
  });
  await until(() => page.eval("document.querySelector('#memory-hub-dialog')?.open === true"), 'M1 memory-hub dialog opens');
  assert.equal(await page.eval("document.querySelector('#memory-tab-matrix')?.getAttribute('aria-selected')"), 'true');
  await page.eval(() => document.querySelector('#memory-tab-matrix')?.focus());
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await until(() => page.eval("document.querySelector('#notebook-tab-notes')?.getAttribute('aria-selected') === 'true' && document.querySelector('#notebook-panel-notes')?.hidden === false"), 'ArrowRight switches M1 to Notes tab');
  await page.eval(() => document.querySelector('#notebook-tab-diary')?.click());
  await until(() => page.eval("document.querySelector('#notebook-tab-diary')?.getAttribute('aria-selected') === 'true' && document.querySelector('#notebook-panel-diary')?.hidden === false"), 'click switches M1 to Diary tab');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(() => page.eval("document.querySelector('#memory-hub-dialog')?.open === false"), 'M1 memory-hub dialog closes on Escape');
  assert.equal(await page.eval("document.activeElement?.id"), 'open-memory-hub-top', 'Escape on M1 dialog must restore focus to #open-memory-hub-top');
  checks.push('M1 native dialog opens, switches to Notes (keyboard ArrowRight) & Diary (click), closes via Escape, and restores focus');

  const before = await count();
  await fill('我们始终在同一个对话中');
  await page.eval(() => document.querySelector('#draft').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  await sleep(250);
  assert.equal(await count(), before, 'an IME composition Enter must not send');
  await pressEnter();
  await until(() => page.eval("[...document.querySelectorAll('#messages .router-message .message-text')].some(x => x.textContent.includes('我们始终在同一个对话中'))"), 'ordinary reply');
  await until(() => page.eval("document.querySelector('#trace-scope').innerText.includes('我们始终在同一个对话中')"), 'the process follows the newest round');
  checks.push('ordinary conversation without files, IME Enter suppressed, process follows the newest round');

  // Clean mode hides pure direct-reply routing clutter by default; audit detail mode reveals it on demand
  assert.equal(
    await page.eval("[...document.querySelectorAll('#messages .user-message')].at(-1)?.querySelector('.routing-summary') === null"),
    true,
    'clean mode hides routine direct-reply routing summary',
  );
  await page.eval(() => document.querySelector('#conv-detail-mode-btn')?.click());
  await until(() => page.eval("document.querySelector('#conv-detail-mode-btn').getAttribute('aria-pressed') === 'true'"), 'audit detail mode enabled');
  await until(() => page.eval("[...document.querySelectorAll('#messages .user-message')].at(-1)?.querySelector('.routing-summary')?.innerText.includes('仅回复')"), 'direct reply routing summary in detail mode');
  await page.eval(() => document.querySelector('#conv-detail-mode-btn')?.click());
  await until(() => page.eval("document.querySelector('#conv-detail-mode-btn').getAttribute('aria-pressed') === 'false'"), 'audit detail mode restored to clean default');

  await page.eval(() => {
    const user = [...document.querySelectorAll('#messages .user-message')].at(-1);
    [...user.querySelectorAll('.message-actions button')].find(button => button.innerText.includes('路由'))?.click();
  });
  await until(() => page.eval("document.querySelector('#routing-detail').hidden === false"), 'routing detail panel');
  await page.eval(() => { const facts = document.querySelector('#routing-detail details.routing-facts'); if (facts) facts.open = true; });
  await until(() => page.eval("document.querySelector('#routing-detail').innerText.includes('当时可见的工作')"), 'routing-time context');
  assert.match(await page.eval("document.querySelector('#routing-detail').innerText"), /当时的近期对话引用/);
  checks.push('direct-reply decision is explicit; per-message route context opens without inspecting raw JSON');

  await fill('<img src=x onerror="window.__xss=1">');
  await pressEnter();
  await until(() => page.eval("[...document.querySelectorAll('#messages .router-message .message-text')].some(x => x.textContent.includes('onerror'))"), 'literal reply');
  assert.equal(await page.eval('window.__xss'), undefined, 'model/user text is never executed');
  assert.equal(await page.eval("document.querySelectorAll('#messages img').length"), 0);
  checks.push('user and model text is rendered as text, never as HTML');

  // Create a background work (with explicit authorized file if --sample provided, else via delegation command)
  const usersBefore = await page.eval("document.querySelectorAll('#messages .user-message').length");
  if (sample) {
    await page.eval(async ({ filePath }) => {
      const tok = sessionStorage.getItem('friday.local-access-token') ?? sessionStorage.getItem('super-agent.local-access-token');
      await fetch('/api/chat', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: crypto.randomUUID(), text: '分析这份文件，说明职责边界', files: [filePath] }),
      });
    }, { filePath: sample });
  } else {
    await fill('派发：代码审查与职责检查');
    await pressEnter();
  }
  await until(() => page.eval(`document.querySelectorAll('#messages .user-message').length === ${usersBefore + 1}`), 'the submitted task message');
  await until(() => page.eval("document.querySelectorAll('.work-row').length > 0"), 'background work');
  await until(() => page.eval("[...document.querySelectorAll('.work-row')].some(x => x.textContent.includes('已完成'))"), 'work completion');

  // Collapse the right drawer first to verify clicking a task auto-opens it
  await page.eval(() => document.querySelector('#desktop-trace-fold')?.click());
  await until(() => page.eval("document.body.classList.contains('desktop-right-collapsed')"), 'right drawer collapsed before task click');

  await until(() => page.eval("[...document.querySelectorAll('#messages .user-message')].at(-1)?.querySelector('.routing-summary .route-target') !== null"), 'routing target for the new work');
  await page.eval(() => [...document.querySelectorAll('#messages .user-message')].at(-1).querySelector('.routing-summary .route-target').click());
  await until(() => page.eval("!document.body.classList.contains('desktop-right-collapsed')"), 'right drawer auto-opens on task click');

  await until(() => page.eval("document.querySelector('#work-detail').hidden === false && document.querySelector('#work-detail').innerText.includes('已完成')"), 'task overview header');
  await until(() => page.eval("document.querySelectorAll('#trace-content .chain-card').length >= 5"), 'execution chain nodes rendered');
  if (sample) {
    await until(() => page.eval("document.querySelector('#trace-content').innerText.includes('读取文件副本')"), 'worker tool step');
  }
  assert.equal(await page.eval("document.querySelector('#step-mode').getAttribute('aria-pressed')"), 'true', 'all-chain mode is active by default');

  const chainSnapshot = await page.eval(() => {
    const parseOffset = (raw) => {
      const m = /^\+(?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s$/.exec((raw || '').trim());
      if (m) return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
      const hm = /^\+(\d+)h(\d+)m$/.exec((raw || '').trim());
      if (hm) return Number(hm[1]) * 3600 + Number(hm[2]) * 60;
      return -1;
    };
    const cards = [...document.querySelectorAll('#trace-content .chain-card')].map(el => ({
      classes: el.className,
      clock: el.querySelector('.chain-clock')?.textContent?.trim() ?? '',
      offset: el.querySelector('.chain-offset')?.textContent?.trim() ?? '',
      offsetSec: parseOffset(el.querySelector('.chain-offset')?.textContent),
      title: el.querySelector('.chain-title')?.textContent?.trim() ?? '',
      hasWaterfall: Boolean(el.querySelector('svg.chain-waterfall rect.wf-track') && el.querySelector('svg.chain-waterfall rect.wf-bar')),
    }));
    return {
      cards,
      workText: document.querySelector('#work-detail')?.innerText ?? '',
      chainText: document.querySelector('#trace-content')?.innerText ?? '',
      hasOverviewMetrics: Boolean(document.querySelector('#work-detail .work-overview-head') && document.querySelector('#work-detail .work-metrics-strip .work-metric-pill')),
    };
  });

  assert.equal(chainSnapshot.hasOverviewMetrics, true, 'task overview renders structured header and metric pills');
  assertNoRawJsonDump(chainSnapshot.workText, 'work-detail');
  assertNoRawJsonDump(chainSnapshot.chainText, 'trace-content');
  assert.ok(chainSnapshot.cards.every(c => /^\d{2}:\d{2}:\d{2}$/.test(c.clock) && c.offsetSec >= 0 && c.hasWaterfall),
    'every execution chain card must show clock, relative offset, and SVG waterfall bar');
  for (let i = 1; i < chainSnapshot.cards.length; i++) {
    assert.ok(chainSnapshot.cards[i].offsetSec >= chainSnapshot.cards[i - 1].offsetSec,
      `execution chain must be sorted chronologically (${chainSnapshot.cards[i - 1].offset} -> ${chainSnapshot.cards[i].offset})`);
  }
  assert.ok(chainSnapshot.cards.some(c => c.classes.includes('cat-message') && c.title.includes('收到消息')), 'chain contains received message node');
  assert.ok(chainSnapshot.cards.some(c => c.classes.includes('cat-message') && c.title.includes('公开回复交付')), 'chain contains reply delivery node');
  assert.ok(chainSnapshot.cards.some(c => c.classes.includes('cat-routing')), 'chain contains routing node');
  assert.ok(chainSnapshot.cards.some(c => c.classes.includes('cat-llm')), 'chain contains model call node');
  if (sample) {
    assert.ok(chainSnapshot.cards.some(c => c.classes.includes('cat-tool') && c.title.includes('读取文件副本')), 'chain contains tool execution node');
  }
  assert.match(await page.eval("document.querySelector('#messages').textContent"), /新建工作/);
  checks.push('auto-opened drawer, task overview card, chronological execution chain with offsets and SVG waterfalls');

  // Verify direction / category filters
  const filterCases = [
    { btn: '#filter-msg-mode', catClass: 'cat-message', required: true },
    { btn: '#graph-mode', catClass: 'cat-llm', required: true },
    { btn: '#timeline-mode', catClass: 'cat-tool', required: Boolean(sample) },
    { btn: '#filter-route-mode', catClass: 'cat-routing', required: true },
  ];
  for (const fc of filterCases) {
    await page.eval(({ btn }) => document.querySelector(btn)?.click(), { btn: fc.btn });
    await sleep(100);
    assert.equal(await page.eval(`document.querySelector('${fc.btn}').getAttribute('aria-pressed')`), 'true', `${fc.btn} active`);
    const filtered = await page.eval(() => [...document.querySelectorAll('#trace-content .chain-card')].map(el => el.className));
    if (fc.required) assert.ok(filtered.length > 0, `${fc.btn} must render matching nodes`);
    assert.ok(filtered.every(cls => cls.includes(fc.catClass)), `${fc.btn} must only show ${fc.catClass} nodes`);
  }
  await page.eval(() => document.querySelector('#step-mode')?.click());
  await sleep(100);
  checks.push('category filter tabs filter timeline accurately across message, llm, tool, and routing');

  // Verify semantic inspector for tool & llm nodes (zero raw JSON)
  if (sample) {
    await page.eval(() => document.querySelector('#trace-content .chain-card.cat-tool')?.click());
    await until(() => page.eval("document.querySelector('#event-detail').hidden === false && document.querySelector('#event-detail').innerText.includes('Router maintains one continuous conversation')"), 'tool inspector with readable output');
    const toolInspectorText = await page.eval("document.querySelector('#event-detail').innerText");
    assert.match(toolInspectorText, /调用工具/);
    assert.match(toolInspectorText, /使用参数/);
    assert.match(toolInspectorText, /获取结果/);
    assert.match(toolInspectorText, /读取文件副本/);
    assertNoRawJsonDump(toolInspectorText, 'tool-inspector');
  }

  await page.eval(() => document.querySelector('#trace-content .chain-card.cat-llm')?.click());
  await until(() => page.eval("document.querySelector('#event-detail').hidden === false && /模型与\\s*token\\s*消耗/i.test(document.querySelector('#event-detail').innerText)"), 'LLM inspector rendered');
  const llmInspector = await page.eval(() => ({
    text: document.querySelector('#event-detail')?.innerText ?? '',
    hasDecisionBtn: Boolean(document.querySelector('#event-detail .tool-decision-btn:not(:disabled)')),
  }));
  assertNoRawJsonDump(llmInspector.text, 'llm-inspector');
  if (llmInspector.hasDecisionBtn) {
    await page.eval(() => document.querySelector('#event-detail .tool-decision-btn:not(:disabled)')?.click());
    await sleep(120);
    assert.equal(await page.eval("document.querySelector('#event-detail').hidden"), false, 'clicking tool decision jumps to target node');
  }
  // Test wide toggle and inspector close button
  await page.eval(() => document.querySelector('#trace-wide-toggle')?.click());
  await until(() => page.eval("document.querySelector('#panels').classList.contains('trace-wide')"), 'wide toggle expands studio');
  await page.eval(() => document.querySelector('#trace-wide-toggle')?.click());
  await until(() => page.eval("!document.querySelector('#panels').classList.contains('trace-wide')"), 'wide toggle restores width');
  await page.eval(() => document.querySelector('#event-detail .inspector-close-btn')?.click());
  await until(() => page.eval("document.querySelector('#event-detail').hidden === true"), 'inspector close button hides detail pane');
  checks.push('semantic inspector renders Chinese tool/LLM details, tool jump navigation, wide toggle, and zero raw JSON');

  const beforeSelection = await count();
  await page.eval(() => document.querySelector('.work-row .work-row-main')?.click());
  await sleep(150);
  assert.equal(await count(), beforeSelection, 'selecting a work must not change the conversation');

  // A per-run marker keeps this check independent of whatever an earlier run left in the fixture.
  const burstTag = `连续消息-${Date.now().toString(36)}`;
  await burst(Array.from({ length: 12 }, (_, index) => `${burstTag} ${index}`));
  await until(() => page.eval(`[...document.querySelectorAll('#messages .user-message')].filter(x => x.textContent.includes('${burstTag}')).length === 12`), 'burst hydration');
  checks.push('a burst larger than one history page is fully hydrated from the event stream');

  const orphans = await page.eval(() => {
    const articles = [...document.querySelectorAll('#messages article')];
    const index = new Map(articles.map((item, position) => [item.dataset.messageId, position]));
    return articles.filter(item => item.dataset.replyTo && index.has(item.dataset.replyTo) && index.get(item.dataset.replyTo) > index.get(item.dataset.messageId)).length;
  });
  assert.equal(orphans, 0, 'no reply may appear before the user message it belongs to');
  assert.doesNotMatch(await page.eval("[...document.querySelectorAll('#trace-content .chain-card .chain-title')].map(item => item.textContent).join(' ')"), /关联后台工作/,
    'bookkeeping events stay out of the readable execution chain');
  assert.doesNotMatch(await page.eval("document.querySelector('#trace-scope').innerText"), new RegExp(burstTag),
    'a scope the reader opened stays put instead of jumping to a burst of new messages');
  checks.push('every shown reply carries its user message; a pinned scope holds while bookkeeping stays out');

  const beforeReload = await page.eval(`[...document.querySelectorAll('#messages .user-message')].filter(x => x.textContent.includes('${burstTag}')).length`);
  await page.goto(new URL(entryUrl).origin, { settleMs: 300 });
  await until(() => page.eval("!document.querySelector('#draft').disabled"), 'sessionStorage refresh authentication');
  for (let round = 0; round < 8; round++) {
    if (await page.eval("document.querySelector('#older').hidden")) break;
    await page.eval(() => document.querySelector('#older').click());
    await sleep(200);
  }
  assert.equal(await page.eval(`[...document.querySelectorAll('#messages .user-message')].filter(x => x.textContent.includes('${burstTag}')).length`), beforeReload);
  checks.push('refresh keeps the same main history and load-older restores it');

  // Toggle audit detail mode to verify settled markers and toggle channel/system filters cleanly
  await page.eval(() => document.querySelector('#conv-detail-mode-btn')?.click());
  await until(() => page.eval(`[...document.querySelectorAll('#messages .user-message')].filter(x => x.textContent.includes('${burstTag}')).every(x => x.querySelector('.speaker').textContent.includes('F.R.I.D.A.Y. 已处理'))`), 'burst replies settled in detail mode');
  const order = await page.eval(() => [...document.querySelectorAll('#messages article')].map(item => Number(item.dataset.seq)));
  assert.ok(order.every((seq, index) => index === 0 || order[index - 1] < seq), 'persisted insertion order survives hydration, refresh and paging');
  assert.equal(await page.eval("document.querySelectorAll('#messages .router-message .source-reference').length > 0"), true, 'replies carry clickable source references');
  await page.eval(() => {
    const btns = [...document.querySelectorAll('#messages .user-message .message-actions button')].filter(b => b.textContent.includes('路由'));
    btns.at(-1)?.click();
  });
  await page.eval(() => { const facts = document.querySelector('#routing-detail details.routing-facts'); if (facts) facts.open = true; });
  assert.match(await page.eval("document.querySelector('#routing-detail').innerText"), /分配记录与当时上下文/);
  await page.eval(() => document.querySelector('#conv-hide-system-btn')?.click());
  assert.equal(await page.eval("document.querySelector('#conv-hide-system-btn').getAttribute('aria-pressed')"), 'true');
  await page.eval(() => document.querySelector('#conv-hide-system-btn')?.click());
  await page.eval(() => document.querySelector('#conv-channel-filters button')?.click());
  await page.eval(() => document.querySelector('#conv-detail-mode-btn')?.click());
  checks.push('all message blocks remain in durable sequence order after reload; clean/audit toggles, channel/system filters, source references and routing context survive');

  // Re-select the completed work so responsive & dual-theme checks inspect a populated Execution Chain Studio
  await page.eval(() => document.querySelector('.work-row .work-row-main')?.click());
  await until(() => page.eval("document.querySelectorAll('#trace-content .chain-card').length >= 4"), 'task chain reloaded after refresh');

  await page.eval(() => document.querySelector('#theme-system-btn')?.click());
  await sleep(120);
  assert.equal(await page.eval("document.documentElement.getAttribute('data-theme-pref')"), 'system', 'theme preference switched to system');
  assert.equal(await page.eval("document.querySelector('#theme-system-btn')?.getAttribute('aria-pressed')"), 'true', '#theme-system-btn aria-pressed=true');
  assert.equal(await page.eval("document.querySelector('meta[name=\"color-scheme\"]')?.getAttribute('content')"), 'light dark', 'system theme sets color-scheme="light dark"');
  assert.equal(await page.eval("document.querySelectorAll('meta[name=\"theme-color\"]').length"), 1, 'single meta[name="theme-color"] maintained');

  for (const [themeName, themeBtn] of [['spatial', '#theme-spatial-btn'], ['industrial', '#theme-industrial-btn']]) {
    await page.eval(({ themeBtn }) => document.querySelector(themeBtn)?.click(), { themeBtn });
    await sleep(120);
    assert.equal(await page.eval("document.documentElement.getAttribute('data-theme')"), themeName, `theme switched to ${themeName}`);
    assert.equal(await page.eval(`document.querySelector('${themeBtn}')?.getAttribute('aria-pressed')`), 'true', `${themeBtn} aria-pressed=true`);

    if (themeName === 'industrial') {
      assert.equal(
        await page.eval("getComputedStyle(document.querySelector('#conv-channel-filters .conv-channel-chip.active')).color"),
        'rgb(255, 255, 255)',
        'industrial active channel chip text must remain crisp white (#ffffff)',
      );
    }

    await page.setViewport({ width: 1440, height: 900, mobile: false });
    await sleep(200);
    assert.equal(await page.eval('document.documentElement.scrollWidth <= innerWidth'), true, `1440x900 (${themeName}): no horizontal page overflow`);
    assert.equal(
      await page.eval("[...document.querySelectorAll('[hidden=\"until-found\"]')].every(el => Math.round(el.getBoundingClientRect().height) === 0)"),
      true,
      `1440x900 (${themeName}): collapsed [hidden="until-found"] containers must have zero height`,
    );
    assert.equal(
      await page.eval("[...document.querySelectorAll('.bot-poke-btn')].every(el => { const r = el.getBoundingClientRect(); return r.width <= 32 && r.height <= 32 && getComputedStyle(el).borderTopWidth === '0px'; })"),
      true,
      `1440x900 (${themeName}): .bot-poke-btn avatars stay compact (<=32px) with 0px border`,
    );

    for (const [width, height, name] of [[768, 1024, 'tablet'], [390, 844, 'mobile']]) {
      await page.setViewport({ width, height, mobile: width < 600 });
      await page.eval(() => document.querySelector('#show-chat').click());
      await sleep(250);
      if (themeName === 'spatial') await page.screenshot({ path: `${outDir}/${name}-chat.jpg`, quality: 85 });
      assert.equal(await page.eval('document.documentElement.scrollWidth <= innerWidth'), true, `${name} (${themeName}) chat: no horizontal page overflow`);

      if (width === 390) {
        await page.eval(() => {
          const navBtn = document.querySelector('#mobile-nav-btn');
          navBtn?.focus();
          navBtn?.click();
        });
        await until(() => page.eval("document.body.classList.contains('mobile-nav-open') && document.querySelector('#mobile-nav-btn')?.getAttribute('aria-expanded') === 'true'"), `mobile nav drawer opens (${themeName})`);
        assert.equal(await page.eval("document.querySelector('#main-content')?.inert === true"), true, `mobile nav drawer sets inert on #main-content (${themeName})`);
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await until(() => page.eval("!document.body.classList.contains('mobile-nav-open')"), `mobile nav drawer closes on Escape (${themeName})`);
        assert.equal(await page.eval("document.querySelector('#main-content')?.inert === false"), true, `mobile nav drawer clears inert on close (${themeName})`);
        assert.equal(await page.eval("document.activeElement?.id"), 'mobile-nav-btn', `mobile nav drawer restores focus to #mobile-nav-btn (${themeName})`);
      }

      await page.eval(() => document.querySelector('#show-trace').click());
      await sleep(250);
      if (themeName === 'spatial') await page.screenshot({ path: `${outDir}/${name}-trace.jpg`, quality: 85 });
      assert.equal(await page.eval('document.documentElement.scrollWidth <= innerWidth'), true, `${name} (${themeName}) trace: no horizontal page overflow`);

      await page.eval(() => document.querySelector('#trace-content .chain-card')?.click());
      await sleep(150);
      assert.equal(await page.eval('document.documentElement.scrollWidth <= innerWidth'), true, `${name} (${themeName}) trace+inspector: no horizontal page overflow`);
      await page.eval(() => document.querySelector('#event-detail .inspector-close-btn')?.click());

      await page.eval(() => document.querySelector('#work-toggle').click());
      assert.equal(await page.eval("document.querySelector('#work-toggle').getAttribute('aria-expanded')"), 'true');
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      assert.equal(await page.eval("document.querySelector('#work-toggle').getAttribute('aria-expanded')"), 'false');
    }
  }
  checks.push('system/spatial/industrial themes across 1440x900, 768x1024, 390x844 (mobile nav inert + focus restore, chat, trace, inspector, work drawer + Escape) with zero page overflow');

  if (typeof page.checkCoarseTouch === 'function') {
    await page.checkCoarseTouch();
    checks.push('touch-emulated coarse pointer mobile keeps .route-expand-btn, .message-actions buttons, #companion-avatar, and .bot-poke-btn compact');
  }

  await page.eval(() => document.querySelector('#theme-spatial-btn')?.click());
  await page.setViewport({ width: 1440, height: 900, mobile: false });
  await page.eval(() => document.querySelector('#show-chat').click());
  await sleep(300);
  await page.screenshot({ path: `${outDir}/filled-desktop.jpg`, quality: 85 });
  assert.deepEqual(page.consoleErrors, []);
  checks.push('no browser runtime exceptions');

  await writeFile(`${outDir}/results.json`, JSON.stringify({ entry: entry.origin, checks }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally { await browser.close(); }

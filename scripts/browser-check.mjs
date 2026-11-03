#!/usr/bin/env node
// End-to-end check of the local Web conversation and trace in a real browser.
//
//   node scripts/browser-check.mjs <entry-url> [--sample /absolute/path.txt] [--out DIR]
//
// <entry-url> is the URL printed by `node dist/cli.js web`. The daemon behind it must be running
// (offline mode is fine). Requires Node 22+ and an installed Chrome/Edge/Chromium, plus the
// tasteskill CDP helper: set CDP_HELPER to its lib/cdp.mjs, or keep the default path used here.
// This script submits real messages to that daemon's transcript, so point it at a demo data directory.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const helperPath = process.env.CDP_HELPER ?? '/Users/duty/.agents/skills/design-taste-frontend/scripts/lib/cdp.mjs';
let cdp;
try { cdp = await import(pathToFileURL(helperPath).href); }
catch { throw new Error(`CDP helper not found at ${helperPath}. Install the tasteskill CDP helper or set CDP_HELPER to its lib/cdp.mjs path.`); }
const { Browser, sleep } = cdp;

const args = process.argv.slice(2);
const entryUrl = args.find(argument => /^https?:\/\//.test(argument));
const option = (name) => { const index = args.indexOf(`--${name}`); return index === -1 ? undefined : args[index + 1]; };
if (!entryUrl) throw new Error('usage: node scripts/browser-check.mjs <entry-url from `web`> [--sample /abs/file.txt] [--out DIR]');
const outDir = resolve(option('out') ?? '.thinkrail/context/browser-smoke');
const samplePath = option('sample');
const sample = samplePath ? resolve(samplePath) : undefined;
if (sample) await writeFile(sample, 'Router maintains one continuous conversation.\nWorkers execute isolated read-only tasks.\n').catch(() => {});

await mkdir(outDir, { recursive: true });
const entry = new URL(entryUrl);
const token = new URLSearchParams(entry.hash.slice(1)).get('token');
assert.match(token ?? '', /^[a-f0-9]{64}$/, 'entry URL must carry the access token fragment');
const browser = await Browser.launch();
const page = await browser.newPage({ width: 1440, height: 900 });
const checks = [];
async function until(predicate, description, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) { if (await predicate()) return; await sleep(100); }
  throw new Error(`Timed out: ${description}`);
}
const count = () => page.eval("document.querySelectorAll('#messages article').length");
async function fill(text, paths = '') {
  await page.eval(({ text, paths }) => {
    const draft = document.querySelector('#draft');
    draft.value = text;
    draft.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#paths').value = paths;
    draft.focus();
  }, { text, paths });
}
const pressEnter = async () => {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const burst = (texts) => page.eval(async ({ texts }) => {
  const token = sessionStorage.getItem('super-agent.local-access-token');
  for (const text of texts) {
    await fetch('/api/chat', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), text, files: [] }) });
  }
}, { texts });

try {
  await page.goto(entryUrl, { settleMs: 250 });
  await until(() => page.eval("!document.querySelector('#draft').disabled"), 'authenticated composer');
  assert.equal(await page.eval('location.hash'), '', 'the token fragment is cleared from the address bar');
  assert.equal(await page.eval("document.querySelector('input[type=file]') === null"), true, 'no upload control exists');
  assert.doesNotMatch(await page.eval('document.body.innerText'), /新建对话|切换会话/);
  await page.screenshot({ path: `${outDir}/empty-desktop.jpg`, quality: 85 });
  checks.push('authenticated empty screen, fragment removal, no session manager or upload control');

  const before = await count();
  await fill('我们始终在同一个对话中');
  await page.eval(() => document.querySelector('#draft').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  await sleep(250);
  assert.equal(await count(), before, 'an IME composition Enter must not send');
  await pressEnter();
  await until(() => page.eval("[...document.querySelectorAll('#messages .router-message')].some(x => x.innerText.includes('我们始终在同一个对话中'))"), 'ordinary reply');
  checks.push('ordinary conversation without files, IME Enter suppressed');

  await fill('<img src=x onerror="window.__xss=1">');
  await pressEnter();
  await until(() => page.eval("[...document.querySelectorAll('#messages .router-message')].some(x => x.innerText.includes('onerror'))"), 'literal reply');
  assert.equal(await page.eval('window.__xss'), undefined, 'model/user text is never executed');
  assert.equal(await page.eval("document.querySelectorAll('#messages img').length"), 0);
  checks.push('user and model text is rendered as text, never as HTML');

  if (sample) {
    await fill('分析这份文件，说明职责边界', sample);
    await pressEnter();
    await until(() => page.eval("document.querySelectorAll('.work-row').length > 0"), 'background work');
    await until(() => page.eval("[...document.querySelectorAll('.work-row')].some(x => x.innerText.includes('已完成'))"), 'work completion');
    await page.eval(() => document.querySelector('.work-row').click());
    await until(() => page.eval("document.querySelector('#trace-content').innerText.includes('读取文件副本')"), 'operation node');
    assert.match(await page.eval("document.querySelector('#trace-content').innerText"), /worker/);
    checks.push('explicit absolute path analysis, causal nodes, no task-ID entry');
  } else checks.push('skipped path analysis (no --sample given)');

  await page.eval(() => document.querySelector('#trace-content .node-button')?.click());
  assert.match(await page.eval("document.querySelector('#event-detail').innerText"), /Span|Token|状态/);
  const beforeSelection = await count();
  await page.eval(() => document.querySelector('.work-row')?.click());
  await sleep(150);
  assert.equal(await count(), beforeSelection, 'selecting a work must not change the conversation');
  checks.push('node details render; selecting a work never switches conversation context');

  await burst(Array.from({ length: 12 }, (_, index) => `连续消息 ${index}`));
  await until(() => page.eval("[...document.querySelectorAll('#messages .user-message')].filter(x => x.innerText.includes('连续消息')).length === 12"), 'burst hydration');
  checks.push('a burst larger than one history page is fully hydrated from the event stream');

  const orphans = await page.eval(() => {
    const articles = [...document.querySelectorAll('#messages article')];
    const index = new Map(articles.map((item, position) => [item.dataset.messageId, position]));
    return articles.filter(item => item.dataset.replyTo && index.has(item.dataset.replyTo) && index.get(item.dataset.replyTo) > index.get(item.dataset.messageId)).length;
  });
  assert.equal(orphans, 0, 'no reply may appear before the user message it belongs to');
  assert.doesNotMatch(await page.eval("document.querySelector('#trace-content').innerText"), /关联后台工作/, 'bookkeeping events stay out of the causal graph');
  checks.push('every shown reply carries its user message; graph hides bookkeeping events');

  const beforeReload = await page.eval("[...document.querySelectorAll('#messages .user-message')].filter(x => x.innerText.includes('连续消息')).length");
  await page.goto(new URL(entryUrl).origin, { settleMs: 300 });
  await until(() => page.eval("!document.querySelector('#draft').disabled"), 'sessionStorage refresh authentication');
  for (let round = 0; round < 8; round++) {
    if (await page.eval("document.querySelector('#older').hidden")) break;
    await page.eval(() => document.querySelector('#older').click());
    await sleep(200);
  }
  assert.equal(await page.eval("[...document.querySelectorAll('#messages .user-message')].filter(x => x.innerText.includes('连续消息')).length"), beforeReload);
  checks.push('refresh keeps the same main history and load-older restores it');

  for (const [width, height, name] of [[768, 1024, 'tablet'], [390, 844, 'mobile']]) {
    await page.setViewport({ width, height, mobile: width < 600 });
    await page.eval(() => document.querySelector('#show-chat').click());
    await sleep(300);
    await page.screenshot({ path: `${outDir}/${name}-chat.jpg`, quality: 85 });
    assert.equal(await page.eval('document.documentElement.scrollWidth <= innerWidth'), true, `${name}: no horizontal page overflow`);
    await page.eval(() => document.querySelector('#show-trace').click());
    await sleep(300);
    await page.screenshot({ path: `${outDir}/${name}-trace.jpg`, quality: 85 });
    assert.equal(await page.eval('document.documentElement.scrollWidth <= innerWidth'), true, `${name}: no horizontal page overflow`);
    await page.eval(() => document.querySelector('#work-toggle').click());
    assert.equal(await page.eval("document.querySelector('#work-toggle').getAttribute('aria-expanded')"), 'true');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await page.eval("document.querySelector('#work-toggle').getAttribute('aria-expanded')"), 'false');
  }
  checks.push('768/390 conversation, trace, work drawer and Escape, with no page overflow');

  await page.setViewport({ width: 1440, height: 900 });
  await page.eval(() => document.querySelector('#show-chat').click());
  await sleep(300);
  await page.screenshot({ path: `${outDir}/filled-desktop.jpg`, quality: 85 });
  assert.deepEqual(page.consoleErrors, []);
  checks.push('no browser runtime exceptions');

  await writeFile(`${outDir}/results.json`, JSON.stringify({ entry: entry.origin, checks }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} finally { await browser.close(); }

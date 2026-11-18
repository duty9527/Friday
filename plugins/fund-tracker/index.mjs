#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import {
  ensurePrivateDir,
  errMsg,
  readConfig,
  resolvePluginPaths,
  writeConfig,
} from '../_shared/config-store.mjs';

/** @type {Array<Record<string, unknown>>} */
export const DEFAULT_HOLDINGS = [];

const DEFAULT_CONFIG = {
  holdings: /** @type {Array<Record<string, unknown>>} */ ([]),
};

const ACTIONS = ['status', 'noon', 'settle', 'init', 'config', 'add-holding', 'remove-holding', 'set-holding'];

/**
 * @param {Record<string, unknown>} raw
 */
function normalizeHoldingInput(raw) {
  const code = String(raw?.code ?? '').trim();
  const name = String(raw?.name ?? '').trim();
  if (!code || !name) {
    throw new Error('基金持仓必须包含 code 与 name');
  }
  const fundType = String(raw?.fundType ?? 'other').trim() || 'other';
  const isAStock = fundType === 'a_stock';
  let proxySymbol = String(raw?.proxySymbol ?? '').trim();
  if (isAStock && !proxySymbol && /^\d{6}$/.test(code)) {
    const prefix = code.startsWith('6')
      ? 'sh'
      : (code.startsWith('4') || code.startsWith('8') || code.startsWith('92'))
        ? 'bj'
        : 'sz';
    proxySymbol = `${prefix}${code}`;
  }
  const proxyName = String(raw?.proxyName ?? (isAStock ? name : proxySymbol)).trim();
  const defaultRatio = isAStock ? 1 : 0.95;
  const rawRatio = Number(raw?.positionRatio ?? defaultRatio);
  const positionRatio = Number.isFinite(rawRatio) && rawRatio > 0 && rawRatio <= 1 ? rawRatio : defaultRatio;
  const cost = Number(raw?.cost ?? raw?.initAmount ?? 0);
  if (!Number.isFinite(cost) || cost < 0) {
    throw new Error(`基金 ${code} 的 cost 必须为非负数字`);
  }
  const initAmountRaw = Number(raw?.initAmount ?? cost);
  const initAmount = Number.isFinite(initAmountRaw) && initAmountRaw >= 0 ? initAmountRaw : cost;
  const initNavRaw = Number(raw?.initNav ?? 1);
  const initNav = Number.isFinite(initNavRaw) && initNavRaw > 0 ? initNavRaw : 1;
  const initNavDate = String(raw?.initNavDate ?? formatLocalDate()).trim() || formatLocalDate();
  const rawShares = raw?.shares !== undefined ? Number(raw.shares) : initAmount / initNav;
  const shares = Number.isFinite(rawShares) && rawShares >= 0 ? Number(rawShares.toFixed(4)) : 0;

  return {
    code,
    name,
    fundType,
    proxySymbol,
    proxyName,
    positionRatio,
    initAmount,
    cost,
    initNav,
    initNavDate,
    shares,
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function listHoldingsFromDb(db) {
  return /** @type {Array<Record<string, unknown>>} */ (
    db.prepare('SELECT * FROM holdings ORDER BY cost DESC, code ASC').all()
  );
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {import('../_shared/types.d.ts').PluginPaths} paths
 */
function syncConfigHoldingsFromDb(db, paths) {
  const rows = listHoldingsFromDb(db).map(row => ({
    code: String(row.code),
    name: String(row.name),
    fundType: String(row.fund_type),
    proxySymbol: String(row.proxy_symbol),
    proxyName: String(row.proxy_name),
    positionRatio: Number(row.position_ratio),
    initAmount: Number(row.init_amount),
    cost: Number(row.cost),
    initNav: Number(row.init_nav),
    initNavDate: String(row.init_nav_date),
    shares: Number(row.shares),
  }));
  const cfg = readConfig(paths.configPath, DEFAULT_CONFIG);
  writeConfig(paths.configPath, { ...cfg, holdings: rows });
}

/**
 * @param {import('../_shared/types.d.ts').PluginPaths} paths
 * @param {() => number} nowFn
 */
function openDb(paths, nowFn = Date.now) {
  ensurePrivateDir(paths.pluginDataDir);
  const db = new DatabaseSync(join(paths.pluginDataDir, 'funds.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS holdings (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      fund_type TEXT NOT NULL,
      proxy_symbol TEXT NOT NULL,
      proxy_name TEXT NOT NULL,
      position_ratio REAL NOT NULL,
      init_amount REAL NOT NULL,
      cost REAL NOT NULL,
      init_nav REAL NOT NULL,
      init_nav_date TEXT NOT NULL,
      shares REAL NOT NULL,
      last_nav REAL NOT NULL,
      last_nav_date TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nav_history (
      code TEXT NOT NULL,
      nav_date TEXT NOT NULL,
      nav REAL NOT NULL,
      acc_nav REAL,
      daily_return REAL,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (code, nav_date)
    );
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      date TEXT NOT NULL,
      total_cost REAL NOT NULL,
      total_asset REAL NOT NULL,
      daily_pnl REAL NOT NULL,
      total_pnl REAL NOT NULL,
      detail_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);

  const countRow = /** @type {{ cnt?: number } | undefined} */ (
    db.prepare('SELECT COUNT(*) AS cnt FROM holdings').get()
  );
  if (Number(countRow?.cnt ?? 0) === 0) {
    const cfg = readConfig(paths.configPath, DEFAULT_CONFIG);
    const seedItems = Array.isArray(cfg.holdings) && cfg.holdings.length > 0
      ? cfg.holdings
      : DEFAULT_HOLDINGS;
    if (seedItems.length > 0) {
      const now = nowFn();
      const insert = db.prepare(`
        INSERT INTO holdings (
          code, name, fund_type, proxy_symbol, proxy_name, position_ratio,
          init_amount, cost, init_nav, init_nav_date, shares, last_nav, last_nav_date, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const rawItem of seedItems) {
        try {
          const item = normalizeHoldingInput(/** @type {Record<string, unknown>} */ (rawItem));
          insert.run(
            item.code, item.name, item.fundType, item.proxySymbol, item.proxyName, item.positionRatio,
            item.initAmount, item.cost, item.initNav, item.initNavDate, item.shares,
            item.initNav, item.initNavDate, now,
          );
        } catch {
          // Skip malformed entries in external seed config rather than crashing openDb
        }
      }
    }
  }
  return db;
}

/**
 * Extract Asia/Shanghai wall-clock calendar & market-hour parts regardless of host TZ.
 * @param {number} [ts]
 */
function getShanghaiTimeParts(ts = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ts)).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    date,
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
    isWeekend: parts.weekday === 'Sat' || parts.weekday === 'Sun',
  };
}

function formatLocalDate(ts = Date.now()) {
  return getShanghaiTimeParts(ts).date;
}

function isWeekend(ts = Date.now()) {
  return getShanghaiTimeParts(ts).isWeekend;
}

/**
 * Parse Tencent quote timestamp across A-share (YYYYMMDDHHmmss),
 * HK (YYYY/MM/DD HH:mm:ss), and US (YYYY-MM-DD HH:mm:ss) formats.
 * @param {unknown} raw
 * @returns {{ quoteDate: string; quoteStamp: string } | null}
 */
export function parseQuoteTimestamp(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})(?:[\sT]*(\d{2}):?(\d{2}):?(\d{2}))?$/.exec(s);
  if (!m) return null;
  const [, y, mo, d, hh = '00', mm = '00', ss = '00'] = m;
  return {
    quoteDate: `${y}-${mo}-${d}`,
    quoteStamp: `${y}-${mo}-${d} ${hh}:${mm}:${ss}`,
  };
}

/**
 * @param {number} n
 * @param {number} [digits]
 */
function signNum(n, digits = 2) {
  const fixed = Math.abs(n).toFixed(digits);
  return n > 0 ? `+${fixed}` : n < 0 ? `-${fixed}` : fixed;
}

/**
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 */
function buildRequestSignal(timeoutMs, signal) {
  const timer = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timer, signal]) : timer;
}

/**
 * @param {string} code
 * @param {number} [pageSize]
 * @param {typeof fetch} [fetchFn]
 * @param {AbortSignal} [signal]
 */
async function fetchFundNavHistory(code, pageSize = 10, fetchFn = fetch, signal) {
  const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${encodeURIComponent(code)}&pageIndex=1&pageSize=${pageSize}`;
  const res = await fetchFn(url, {
    headers: {
      Referer: 'https://fundf10.eastmoney.com/',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64)',
    },
    signal: buildRequestSignal(10_000, signal),
  });
  if (!res.ok) throw new Error(`Eastmoney NAV HTTP ${res.status} for ${code}`);
  const json = /** @type {{ Data?: { LSJZList?: Array<Record<string, unknown>> } }} */ (await res.json());
  const list = Array.isArray(json?.Data?.LSJZList) ? json.Data.LSJZList : [];
  return list
    .filter(row => row?.FSRQ && row?.DWJZ && !Number.isNaN(Number(row.DWJZ)))
    .map(row => ({
      navDate: String(row.FSRQ),
      nav: Number(row.DWJZ),
      accNav: row.LJJZ && !Number.isNaN(Number(row.LJJZ)) ? Number(row.LJJZ) : Number(row.DWJZ),
      dailyReturn: row.JZZZL && !Number.isNaN(Number(row.JZZZL)) ? Number(row.JZZZL) : 0,
    }));
}

/**
 * @param {string[]} symbols
 * @param {typeof fetch} [fetchFn]
 * @param {AbortSignal} [signal]
 */
async function fetchMarketQuotes(symbols, fetchFn = fetch, signal) {
  const unique = [...new Set(symbols.filter(Boolean))];
  if (!unique.length) return new Map();
  const url = `https://qt.gtimg.cn/q=${unique.join(',')}`;
  const res = await fetchFn(url, {
    headers: {
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    signal: buildRequestSignal(10_000, signal),
  });
  if (!res.ok) throw new Error(`Tencent quote HTTP ${res.status}`);
  const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
  const map = new Map();
  for (const line of text.trim().split('\n')) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^v_/, '');
    const raw = line.slice(eq + 1).trim().replace(/^"|"$/g, '').replace(/";$/, '');
    const parts = raw.split('~');
    if (parts.length < 35) continue;
    const price = Number(parts[3]);
    const prevClose = Number(parts[4]);
    const changePct = Number(parts[32]);
    const quoteTime = String(parts[30] || '').trim();
    const parsedTime = parseQuoteTimestamp(quoteTime);
    if (!(price > 0) || !(prevClose > 0) || !Number.isFinite(changePct) || !parsedTime) continue;
    map.set(key, {
      symbol: key,
      name: parts[1] || key,
      price,
      prevClose,
      changePct,
      quoteTime,
      quoteDate: parsedTime.quoteDate,
      quoteStamp: parsedTime.quoteStamp,
    });
  }
  return map;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<Record<string, unknown>>} holdings
 * @param {{ nowFn?: () => number; fetchFn?: typeof fetch; signal?: AbortSignal }} [opts]
 */
async function syncAllNavs(db, holdings, opts = {}) {
  const now = (opts.nowFn ?? Date.now)();
  const upsertNav = db.prepare(`
    INSERT INTO nav_history (code, nav_date, nav, acc_nav, daily_return, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(code, nav_date) DO UPDATE SET
      nav=excluded.nav, acc_nav=excluded.acc_nav, daily_return=excluded.daily_return, fetched_at=excluded.fetched_at
  `);
  const updateHoldingLatest = db.prepare(`
    UPDATE holdings SET last_nav=?, last_nav_date=?, updated_at=? WHERE code=?
  `);

  for (const h of holdings) {
    if (String(h.fund_type || h.fundType) === 'a_stock') {
      continue;
    }
    const code = String(h.code);
    try {
      const history = await fetchFundNavHistory(code, 10, opts.fetchFn ?? fetch, opts.signal);
      if (history.length > 0) {
        for (const item of history) {
          upsertNav.run(code, item.navDate, item.nav, item.accNav, item.dailyReturn, now);
        }
        const latest = history[0];
        if (latest) {
          updateHoldingLatest.run(latest.nav, latest.navDate, now, code);
        }
      }
    } catch {
      // Keep cached SQLite NAV if upstream is temporarily unreachable
    }
  }
}

/**
 * @param {Array<Record<string, any>>} groupRows
 */
function calcGroupSummary(groupRows) {
  const count = groupRows.length;
  if (count === 0) {
    return {
      count: 0,
      cost: 0,
      totalCost: 0,
      asset: 0,
      totalAsset: 0,
      dailyPnl: 0,
      totalDailyPnl: 0,
      dailyPnlPct: 0,
      totalPnl: 0,
      totalPnlPct: 0,
      holdings: /** @type {Array<Record<string, any>>} */ ([]),
    };
  }
  const cost = Number(groupRows.reduce((sum, r) => sum + Number(r.cost ?? 0), 0).toFixed(2));
  const asset = Number(groupRows.reduce((sum, r) => sum + Number(r.currentAsset ?? 0), 0).toFixed(2));
  const dailyPnl = Number(groupRows.reduce((sum, r) => sum + Number(r.dailyPnl ?? 0), 0).toFixed(2));
  const totalPnl = Number((asset - cost).toFixed(2));
  const totalPnlPct = cost > 0 ? Number(((totalPnl / cost) * 100).toFixed(2)) : 0;
  const prevAsset = asset - dailyPnl;
  const dailyPnlPct = prevAsset > 0 ? Number(((dailyPnl / prevAsset) * 100).toFixed(2)) : 0;

  return {
    count,
    cost,
    totalCost: cost,
    asset,
    totalAsset: asset,
    dailyPnl,
    totalDailyPnl: dailyPnl,
    dailyPnlPct,
    totalPnl,
    totalPnlPct,
    holdings: groupRows,
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {'status' | 'noon' | 'settle'} mode
 * @param {boolean} offline
 * @param {{ nowFn?: () => number; fetchFn?: typeof fetch; signal?: AbortSignal }} [opts]
 */
async function computeValuation(db, mode = 'noon', offline = false, opts = {}) {
  const nowFn = opts.nowFn ?? Date.now;
  const holdings = listHoldingsFromDb(db);
  const nowTs = nowFn();
  const shTime = getShanghaiTimeParts(nowTs);
  const today = shTime.date;

  if (holdings.length === 0) {
    const title = mode === 'settle'
      ? `# 🌙 持仓晚间结算 · ${today} 21:30`
      : mode === 'noon'
        ? `# ☀️ 持仓午间估值 · ${today} 12:00`
        : `# 📊 持仓总览 · ${today}`;
    const emptyGroup = calcGroupSummary([]);
    return {
      today,
      title,
      empty: true,
      message: `${title}\n\n当前尚未配置任何持仓。请使用 \`add-holding\` 添加，或在 \`config.json\` 的 \`holdings\` 中导入持仓列表。`,
      summary: {
        totalCost: 0,
        totalAsset: 0,
        totalDailyPnl: 0,
        dailyPnlPct: 0,
        totalPnl: 0,
        totalPnlPct: 0,
        stocks: { ...emptyGroup },
        funds: { ...emptyGroup },
        holdings: [],
      },
    };
  }

  if (!offline) {
    await syncAllNavs(db, holdings, opts);
  }
  const refreshedHoldings = listHoldingsFromDb(db);
  const symbols = refreshedHoldings.map(h => String(h.proxy_symbol || '')).filter(Boolean);
  let quotes = new Map();
  if (!offline && symbols.length > 0) {
    try {
      quotes = await fetchMarketQuotes(symbols, opts.fetchFn ?? fetch, opts.signal);
    } catch {
      // Keep empty quotes map so each row degrades explicitly with quoteMissing=true
    }
  }

  const isTradingWindow = !shTime.isWeekend && shTime.minutesOfDay >= 9 * 60 + 30;
  /** @type {Array<Record<string, any>>} */
  const rows = [];

  for (const h of refreshedHoldings) {
    const code = String(h.code);
    const name = String(h.name);
    const shares = Number(h.shares);
    const cost = Number(h.cost);
    const positionRatio = Number(h.position_ratio);
    const proxySymbol = String(h.proxy_symbol);
    const proxyName = String(h.proxy_name || proxySymbol || '跟踪标的');
    const isAStock = String(h.fund_type || h.fundType) === 'a_stock';

    if (isAStock) {
      const quote = proxySymbol ? quotes.get(proxySymbol) : undefined;
      const quoteMissing = !offline && !quote;
      const quoteDate = quote?.quoteDate || '';
      const quoteStamp = quote?.quoteStamp || '';
      const isQuoteStale = !offline && Boolean(quote && (quoteDate !== today || !isTradingWindow));
      const fallbackNav = Number(h.last_nav) > 0 ? Number(h.last_nav) : 0;
      const currentPrice = quote ? quote.price : fallbackNav;
      const prevClose = quote ? (isQuoteStale ? quote.price : quote.prevClose) : currentPrice;
      const changePct = quote && !isQuoteStale ? Number(quote.changePct) : 0;
      const currentAsset = Number((shares * currentPrice).toFixed(2));
      const dailyPnl = quote && !isQuoteStale ? Number((shares * (currentPrice - prevClose)).toFixed(2)) : 0;
      const totalPnl = Number((currentAsset - cost).toFixed(2));
      const totalPnlPct = cost > 0 ? Number(((totalPnl / cost) * 100).toFixed(2)) : 0;
      const costPrice = shares > 0 ? Number((cost / shares).toFixed(3)) : 0;
      const priceText = currentPrice.toFixed(currentPrice < 10 ? 3 : 2);
      let navSource = `ℹ️ 最近价格(${String(h.last_nav_date || today)})`;
      if (quoteMissing) {
        navSource = `⚠️ 行情未取到(无有效实时报价，沿用最近记录价 ${priceText}，当日盈亏置 0)`;
      } else if (isQuoteStale) {
        navSource = quoteDate !== today
          ? `⚠️ 数据过期(非当日行情，数据日期 ${quoteDate}，报价时间 ${quoteStamp}，前收 ${priceText})`
          : `📅 休市/盘前(报价时间 ${quoteStamp}，沿用价格 ${priceText})`;
      } else if (quote) {
        navSource = mode === 'settle'
          ? `✅ 腾讯行情收盘价(${quoteStamp})`
          : `⚡ 腾讯行情(现价 ${priceText}，报价时间 ${quoteStamp})`;
      }

      if (mode === 'settle' && quote?.price && !isQuoteStale) {
        db.prepare(`
          INSERT INTO nav_history (code, nav_date, nav, acc_nav, daily_return, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(code, nav_date) DO UPDATE SET
            nav=excluded.nav, acc_nav=excluded.acc_nav, daily_return=excluded.daily_return, fetched_at=excluded.fetched_at
        `).run(code, today, quote.price, quote.price, quote.changePct, nowFn());
        db.prepare('UPDATE holdings SET last_nav=?, last_nav_date=?, updated_at=? WHERE code=?')
          .run(quote.price, today, nowFn(), code);
      }

      rows.push({
        code,
        name,
        isAStock: true,
        shares,
        cost: Number(cost.toFixed(2)),
        costPrice,
        baseNav: prevClose,
        baseNavDate: quoteMissing ? String(h.last_nav_date || today) : (isQuoteStale ? quoteDate : today),
        currentNav: currentPrice,
        changePct: Number(changePct.toFixed(2)),
        currentAsset,
        dailyPnl,
        totalPnl,
        totalPnlPct,
        navSource,
        hasTodayOfficialNav: !offline && !quoteMissing && !isQuoteStale,
        quoteDate: quoteDate || undefined,
        quoteStamp: quoteStamp || undefined,
        quoteMissing,
        quoteStale: isQuoteStale,
      });
      continue;
    }

    const navRows = /** @type {Array<Record<string, unknown>>} */ (
      db.prepare('SELECT * FROM nav_history WHERE code=? ORDER BY nav_date DESC LIMIT 3').all(code)
    );
    const firstNav = navRows[0];
    const secondNav = navRows[1];
    const latestNavObj = firstNav
      ? { nav: Number(firstNav.nav), navDate: String(firstNav.nav_date), dailyReturn: Number(firstNav.daily_return ?? 0) }
      : { nav: Number(h.last_nav), navDate: String(h.last_nav_date), dailyReturn: 0 };
    const prevNavObj = secondNav
      ? { nav: Number(secondNav.nav), navDate: String(secondNav.nav_date) }
      : undefined;

    const hasTodayOfficialNav = latestNavObj.navDate === today;
    const quote = proxySymbol ? quotes.get(proxySymbol) : undefined;
    const isUsProxy = proxySymbol.toLowerCase().startsWith('us');
    const quoteDate = quote?.quoteDate || '';
    const quoteStamp = quote?.quoteStamp || '';
    const isQuoteFresh = Boolean(
      quote && (
        isUsProxy
          ? (quoteDate === today || (latestNavObj.navDate && quoteDate > latestNavObj.navDate))
          : (isTradingWindow && quoteDate === today)
      ),
    );
    const quoteMissing = !offline && Boolean(proxySymbol) && !hasTodayOfficialNav && !quote;
    const quoteStale = !offline && Boolean(proxySymbol) && !hasTodayOfficialNav && Boolean(quote) && !isQuoteFresh;
    const rawProxyPct = quote && isQuoteFresh ? Number(quote.changePct) : 0;
    const proxyChangePct = Number.isFinite(rawProxyPct) ? rawProxyPct : 0;

    let baseNav = latestNavObj.nav;
    let currentNav = latestNavObj.nav;
    let changePct = 0;
    let navSource = '';

    if (hasTodayOfficialNav) {
      currentNav = latestNavObj.nav;
      changePct = latestNavObj.dailyReturn;
      baseNav = prevNavObj ? prevNavObj.nav : Number((currentNav / (1 + changePct / 100)).toFixed(4));
      navSource = `✅ 正式净值(${latestNavObj.navDate})`;
    } else if (!proxySymbol) {
      baseNav = latestNavObj.nav;
      currentNav = latestNavObj.nav;
      changePct = 0;
      navSource = `ℹ️ 最近净值(${latestNavObj.navDate})`;
    } else if (quoteMissing) {
      baseNav = latestNavObj.nav;
      currentNav = latestNavObj.nav;
      changePct = 0;
      navSource = `⚠️ 行情未取到(锚定${proxyName}[${proxySymbol}]无有效报价，沿用${latestNavObj.navDate}净值${latestNavObj.nav.toFixed(4)})`;
    } else if (quoteStale) {
      baseNav = latestNavObj.nav;
      currentNav = latestNavObj.nav;
      changePct = 0;
      navSource = quoteDate !== today
        ? `⚠️ 数据过期(锚定${proxyName}数据日期 ${quoteDate} 非今日[${today}]，报价时间 ${quoteStamp}，沿用${latestNavObj.navDate}净值${latestNavObj.nav.toFixed(4)})`
        : `📅 休市/盘前(锚定${proxyName}报价时间 ${quoteStamp}，沿用${latestNavObj.navDate}净值${latestNavObj.nav.toFixed(4)})`;
    } else if (mode === 'settle') {
      baseNav = latestNavObj.nav;
      changePct = Number((proxyChangePct * positionRatio).toFixed(2));
      currentNav = Number((baseNav * (1 + changePct / 100)).toFixed(4));
      const stampSuffix = quoteStamp
        ? isUsProxy && quoteDate !== today
          ? `，美东报价 ${quoteStamp}[数据日期 ${quoteDate}]`
          : `，报价时间 ${quoteStamp}`
        : '';
      navSource = `⏳ 净值待更新(前值${latestNavObj.navDate}:${latestNavObj.nav.toFixed(4)}, 按${proxyName} ${signNum(proxyChangePct)}%预估${stampSuffix})`;
    } else {
      baseNav = latestNavObj.nav;
      changePct = Number((proxyChangePct * positionRatio).toFixed(2));
      currentNav = Number((baseNav * (1 + changePct / 100)).toFixed(4));
      const stampSuffix = quoteStamp
        ? isUsProxy && quoteDate !== today
          ? `，美东报价 ${quoteStamp}[数据日期 ${quoteDate}]`
          : `，报价时间 ${quoteStamp}`
        : '';
      navSource = `盘中估值(锚定${proxyName} ${signNum(proxyChangePct)}%${stampSuffix})`;
    }

    const currentAsset = Number((shares * currentNav).toFixed(2));
    const dailyPnl = Number((shares * (currentNav - baseNav)).toFixed(2));
    const totalPnl = Number((currentAsset - cost).toFixed(2));
    const totalPnlPct = cost > 0 ? Number(((totalPnl / cost) * 100).toFixed(2)) : 0;

    rows.push({
      code,
      name,
      isAStock: false,
      shares: Number(shares.toFixed(2)),
      cost: Number(cost.toFixed(2)),
      baseNav: Number(baseNav.toFixed(4)),
      baseNavDate: latestNavObj.navDate,
      currentNav: Number(currentNav.toFixed(4)),
      changePct: Number(changePct.toFixed(2)),
      currentAsset,
      dailyPnl,
      totalPnl,
      totalPnlPct,
      navSource,
      hasTodayOfficialNav,
      quoteDate: quoteDate || undefined,
      quoteStamp: quoteStamp || undefined,
      quoteMissing,
      quoteStale,
    });
  }

  const stocks = calcGroupSummary(rows.filter(r => Boolean(r.isAStock)));
  const funds = calcGroupSummary(rows.filter(r => !r.isAStock));

  const totalCost = Number((stocks.cost + funds.cost).toFixed(2));
  const totalAsset = Number((stocks.asset + funds.asset).toFixed(2));
  const totalDailyPnl = Number((stocks.dailyPnl + funds.dailyPnl).toFixed(2));
  const totalPnl = Number((stocks.totalPnl + funds.totalPnl).toFixed(2));
  const totalPnlPct = totalCost > 0 ? Number(((totalPnl / totalCost) * 100).toFixed(2)) : 0;
  const prevAsset = totalAsset - totalDailyPnl;
  const dailyPnlPct = prevAsset > 0 ? Number(((totalDailyPnl / prevAsset) * 100).toFixed(2)) : 0;

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM snapshots WHERE kind=? AND date=?').run(mode, today);
    db.prepare(`
      INSERT INTO snapshots (kind, date, total_cost, total_asset, daily_pnl, total_pnl, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(mode, today, totalCost, totalAsset, totalDailyPnl, totalPnl, JSON.stringify(rows), nowFn());
    db.prepare(`
      DELETE FROM snapshots WHERE id NOT IN (
        SELECT id FROM snapshots ORDER BY created_at DESC, id DESC LIMIT 200
      )
    `).run();
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }

  const title = mode === 'settle'
    ? `# 🌙 持仓晚间结算 · ${today} 21:30`
    : mode === 'noon'
      ? `# ☀️ 持仓午间估值 · ${today} 12:00`
      : `# 📊 持仓总览 · ${today}`;

  const lines = [
    title,
    '',
    `💰 **总资产** ${totalAsset.toFixed(2)} ｜ **成本** ${totalCost.toFixed(2)} ｜ **当日** ${signNum(totalDailyPnl)} 元（${signNum(dailyPnlPct)}%） ｜ **累计** ${signNum(totalPnl)} 元（${signNum(totalPnlPct)}%）`,
    '',
    '## 【📈 股票】',
  ];

  if (stocks.count === 0) {
    lines.push('暂无持仓');
  } else {
    lines.push(
      `**资产** ${stocks.asset.toFixed(2)} ｜ **成本** ${stocks.cost.toFixed(2)} ｜ **当日** ${signNum(stocks.dailyPnl)} 元（${signNum(stocks.dailyPnlPct)}%） ｜ **累计** ${signNum(stocks.totalPnl)} 元（${signNum(stocks.totalPnlPct)}%）`,
      '',
    );
    for (const r of stocks.holdings) {
      const icon = r.quoteStale || r.quoteMissing ? '⚠️' : r.dailyPnl > 0 ? '🔴' : r.dailyPnl < 0 ? '🟢' : '⚪';
      const dailySeg = r.quoteMissing
        ? '当日 行情未取到'
        : r.quoteStale
          ? (r.quoteDate && r.quoteDate !== today ? `当日 数据过期(${r.quoteDate})` : '当日 休市/盘前')
          : `当日 ${signNum(r.dailyPnl)}（${signNum(r.changePct)}%）`;
      lines.push(
        `- ${icon} **${r.name}** \`${r.code}\` ｜ 现价 ${r.currentNav.toFixed(r.currentNav < 10 ? 3 : 2)} / 成本价 ${r.costPrice.toFixed(3)} / ${r.shares} 股 ｜ 市值 ${r.currentAsset.toFixed(2)} ｜ ${dailySeg} ｜ 累计 ${signNum(r.totalPnl)}（${signNum(r.totalPnlPct)}%） ｜ ${r.navSource}`,
      );
    }
  }

  lines.push('', '## 【🏦 基金】');

  if (funds.count === 0) {
    lines.push('暂无持仓');
  } else {
    lines.push(
      `**资产** ${funds.asset.toFixed(2)} ｜ **成本** ${funds.cost.toFixed(2)} ｜ **当日** ${signNum(funds.dailyPnl)} 元（${signNum(funds.dailyPnlPct)}%） ｜ **累计** ${signNum(funds.totalPnl)} 元（${signNum(funds.totalPnlPct)}%）`,
      '',
    );
    for (const r of funds.holdings) {
      const icon = r.quoteStale || r.quoteMissing ? '⚠️' : r.dailyPnl > 0 ? '🔴' : r.dailyPnl < 0 ? '🟢' : '⚪';
      const dailySeg = r.quoteMissing
        ? '当日 行情未取到'
        : r.quoteStale
          ? (r.quoteDate && r.quoteDate !== today ? `当日 数据过期(${r.quoteDate})` : '当日 休市/盘前')
          : `当日 ${signNum(r.dailyPnl)}（${signNum(r.changePct)}%）`;
      lines.push(
        `- ${icon} **${r.name}** \`${r.code}\` ｜ 净值 ${r.currentNav.toFixed(4)} / ${r.shares.toFixed(2)} 份 ｜ 市值 ${r.currentAsset.toFixed(2)} ｜ ${dailySeg} ｜ 累计 ${signNum(r.totalPnl)}（${signNum(r.totalPnlPct)}%） ｜ ${r.navSource}`,
      );
    }
  }

  lines.push(
    '',
    mode === 'settle'
      ? '> 🌙 晚间结算：尚未公布当日正式净值的基金按跟踪标的最新涨跌幅预估，以晚间官方披露为准。'
      : '> ⚠️ 盘中估值，锚定对应指数，以晚间官方披露为准。',
  );

  return {
    today,
    title,
    empty: false,
    message: lines.join('\n'),
    summary: {
      totalCost,
      totalAsset,
      totalDailyPnl,
      dailyPnlPct,
      totalPnl,
      totalPnlPct,
      stocks,
      funds,
      holdings: rows,
    },
  };
}

/**
 * Execute a fund-tracker plugin action.
 * @param {string} [action]
 * @param {Record<string, unknown>} [args]
 * @param {import('../_shared/types.d.ts').PluginExecutionContext & { fetchFn?: typeof fetch }} [depsOrCtx]
 * @returns {Promise<import('../_shared/types.d.ts').PluginRunResult>}
 */
export async function runAction(action = 'status', args = {}, depsOrCtx = {}) {
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const name = String(action || 'status').trim().toLowerCase();
  if (!ACTIONS.includes(name)) {
    return {
      ok: false,
      notify: true,
      title: '基金操作失败',
      message: `不支持的 fund-tracker 动作 "${action}"，可用动作：${ACTIONS.join('、')}。`,
    };
  }

  const paths = resolvePluginPaths('fund-tracker', depsOrCtx);
  const nowFn = typeof depsOrCtx.nowFn === 'function' ? depsOrCtx.nowFn : Date.now;
  const fetchFn = typeof depsOrCtx.fetchFn === 'function' ? depsOrCtx.fetchFn : fetch;
  const signal = depsOrCtx.signal;
  const db = openDb(paths, nowFn);

  try {
    if (name === 'config') {
      const current = readConfig(paths.configPath, DEFAULT_CONFIG);
      const next = { ...current };
      let changed = false;

      if (safeArgs.holdings !== undefined) {
        if (!Array.isArray(safeArgs.holdings)) {
          return {
            ok: false,
            notify: false,
            title: '基金配置无效',
            message: 'holdings 必须是基金持仓数组。',
          };
        }
        const normalized = safeArgs.holdings.map(item =>
          normalizeHoldingInput(/** @type {Record<string, unknown>} */ (item)),
        );
        next.holdings = normalized;
        writeConfig(paths.configPath, next);
        changed = true;

        db.exec('BEGIN');
        try {
          if (safeArgs.replace === true) {
            db.prepare('DELETE FROM holdings').run();
          }
          const upsert = db.prepare(`
            INSERT INTO holdings (
              code, name, fund_type, proxy_symbol, proxy_name, position_ratio,
              init_amount, cost, init_nav, init_nav_date, shares, last_nav, last_nav_date, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET
              name=excluded.name,
              fund_type=excluded.fund_type,
              proxy_symbol=excluded.proxy_symbol,
              proxy_name=excluded.proxy_name,
              position_ratio=excluded.position_ratio,
              init_amount=excluded.init_amount,
              cost=excluded.cost,
              init_nav=excluded.init_nav,
              init_nav_date=excluded.init_nav_date,
              shares=excluded.shares,
              last_nav=CASE WHEN holdings.last_nav_date <= excluded.init_nav_date THEN excluded.last_nav ELSE holdings.last_nav END,
              last_nav_date=CASE WHEN holdings.last_nav_date <= excluded.init_nav_date THEN excluded.last_nav_date ELSE holdings.last_nav_date END,
              updated_at=excluded.updated_at
          `);
          const now = nowFn();
          for (const item of normalized) {
            upsert.run(
              item.code, item.name, item.fundType, item.proxySymbol, item.proxyName, item.positionRatio,
              item.initAmount, item.cost, item.initNav, item.initNavDate, item.shares,
              item.initNav, item.initNavDate, now,
            );
          }
          db.exec('COMMIT');
        } catch (err) {
          try { db.exec('ROLLBACK'); } catch { /* ignore */ }
          throw err;
        }
        syncConfigHoldingsFromDb(db, paths);
      }

      const dbHoldings = listHoldingsFromDb(db);
      return {
        ok: true,
        notify: false,
        title: '基金插件配置',
        message: `${changed ? '✅ 已保存基金配置' : '⚙️ 当前基金配置'}：共 ${dbHoldings.length} 只持仓。`,
        data: {
          config: next,
          dbHoldingCount: dbHoldings.length,
        },
      };
    }

    if (name === 'init') {
      const holdings = listHoldingsFromDb(db);
      if (holdings.length === 0) {
        return {
          ok: true,
          notify: true,
          title: '基金持仓为空',
          message: '当前没有任何基金持仓可初始化。请先通过 `add-holding` 或 `config.json` 添加持仓后再执行初始化同步。',
          data: { holdings: [], totalCost: 0 },
        };
      }
      const offline = Boolean(safeArgs.offline || process.env.FUND_TRACKER_OFFLINE === '1');
      if (!offline) {
        await syncAllNavs(db, holdings, { nowFn, fetchFn, signal });
      }
      const updated = listHoldingsFromDb(db);
      const totalCost = updated.reduce((sum, h) => sum + Number(h.cost ?? 0), 0);
      return {
        ok: true,
        notify: true,
        title: '基金持仓初始化完成',
        message: `✅ 已同步 ${updated.length} 只基金持仓（合计成本 ${totalCost.toFixed(2)} 元）。`,
        data: { holdings: updated, totalCost: Number(totalCost.toFixed(2)) },
      };
    }

    if (name === 'add-holding') {
      const normalized = normalizeHoldingInput(safeArgs);
      const now = nowFn();
      db.prepare(`
        INSERT INTO holdings (
          code, name, fund_type, proxy_symbol, proxy_name, position_ratio,
          init_amount, cost, init_nav, init_nav_date, shares, last_nav, last_nav_date, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          name=excluded.name,
          fund_type=excluded.fund_type,
          proxy_symbol=excluded.proxy_symbol,
          proxy_name=excluded.proxy_name,
          position_ratio=excluded.position_ratio,
          init_amount=excluded.init_amount,
          cost=excluded.cost,
          init_nav=excluded.init_nav,
          init_nav_date=excluded.init_nav_date,
          shares=excluded.shares,
          last_nav=CASE WHEN holdings.last_nav_date <= excluded.init_nav_date THEN excluded.last_nav ELSE holdings.last_nav END,
          last_nav_date=CASE WHEN holdings.last_nav_date <= excluded.init_nav_date THEN excluded.last_nav_date ELSE holdings.last_nav_date END,
          updated_at=excluded.updated_at
      `).run(
        normalized.code, normalized.name, normalized.fundType, normalized.proxySymbol, normalized.proxyName,
        normalized.positionRatio, normalized.initAmount, normalized.cost, normalized.initNav,
        normalized.initNavDate, normalized.shares, normalized.initNav, normalized.initNavDate, now,
      );
      syncConfigHoldingsFromDb(db, paths);
      const saved = db.prepare('SELECT * FROM holdings WHERE code=?').get(normalized.code);
      return {
        ok: true,
        notify: true,
        title: `已保存基金 ${normalized.code}`,
        message: `✅ 已添加/更新 ${normalized.name} (${normalized.code})：成本 ${normalized.cost.toFixed(2)} 元，份额 ${normalized.shares.toFixed(4)}。`,
        data: saved,
      };
    }

    if (name === 'remove-holding') {
      const code = String(safeArgs.code ?? '').trim();
      if (!code) {
        return { ok: false, notify: false, title: '删除基金失败', message: 'remove-holding 需要提供 code。' };
      }
      const existing = db.prepare('SELECT * FROM holdings WHERE code=?').get(code);
      if (!existing) {
        return { ok: false, notify: false, title: '删除基金失败', message: `未找到基金持仓 ${code}。` };
      }
      db.prepare('DELETE FROM holdings WHERE code=?').run(code);
      syncConfigHoldingsFromDb(db, paths);
      return {
        ok: true,
        notify: true,
        title: `已移除基金 ${code}`,
        message: `🗑️ 已从持仓移除 ${String(existing.name)} (${code})。`,
        data: { code, remainingCount: listHoldingsFromDb(db).length },
      };
    }

    if (name === 'set-holding') {
      const code = String(safeArgs.code ?? '').trim();
      if (!code) {
        return { ok: false, notify: false, title: '更新基金失败', message: 'set-holding 需要提供 args.code。' };
      }
      const existing = /** @type {Record<string, unknown> | undefined} */ (
        db.prepare('SELECT * FROM holdings WHERE code=?').get(code)
      );
      if (!existing) {
        return { ok: false, notify: false, title: '更新基金失败', message: `未找到基金持仓 ${code}。` };
      }
      let shares = Number(existing.shares);
      if (safeArgs.shares !== undefined) {
        const parsedShares = Number(safeArgs.shares);
        if (!Number.isFinite(parsedShares) || parsedShares <= 0) {
          return { ok: false, notify: false, title: '更新基金失败', message: 'shares 必须是大于 0 的有限数字。' };
        }
        shares = Number(parsedShares.toFixed(4));
      }
      let cost = Number(existing.cost);
      if (safeArgs.cost !== undefined) {
        const parsedCost = Number(safeArgs.cost);
        if (!Number.isFinite(parsedCost) || parsedCost < 0) {
          return { ok: false, notify: false, title: '更新基金失败', message: 'cost 必须是非负有限数字。' };
        }
        cost = parsedCost;
      }
      let initAmount = Number(existing.init_amount);
      if (safeArgs.initAmount !== undefined) {
        const parsedInitAmount = Number(safeArgs.initAmount);
        if (!Number.isFinite(parsedInitAmount) || parsedInitAmount <= 0) {
          return { ok: false, notify: false, title: '更新基金失败', message: 'initAmount 必须是大于 0 的有限数字。' };
        }
        initAmount = parsedInitAmount;
      } else if (safeArgs.cost !== undefined) {
        initAmount = cost;
      }

      let initNav = Number(existing.init_nav);
      let initNavDate = String(existing.init_nav_date);
      if (typeof safeArgs.navDate === 'string' && safeArgs.navDate.trim()) {
        initNavDate = safeArgs.navDate.trim();
        if (String(existing.fund_type) === 'a_stock') {
          if (safeArgs.initNav !== undefined) {
            const parsedInitNav = Number(safeArgs.initNav);
            if (!Number.isFinite(parsedInitNav) || parsedInitNav <= 0) {
              return { ok: false, notify: false, title: '更新基金失败', message: 'initNav 必须是大于 0 的有限数字。' };
            }
            initNav = parsedInitNav;
            if (safeArgs.shares === undefined) {
              shares = Number((initAmount / initNav).toFixed(4));
            }
          }
        } else {
          const history = await fetchFundNavHistory(code, 20, fetchFn, signal);
          const matched = history.find(item => item.navDate === initNavDate);
          if (!matched || !Number.isFinite(matched.nav) || matched.nav <= 0) {
            throw new Error(`未找到 ${code} 在 ${initNavDate} 的正式净值`);
          }
          initNav = matched.nav;
          if (safeArgs.shares === undefined) {
            shares = Number((initAmount / initNav).toFixed(4));
          }
        }
      } else if (safeArgs.initAmount !== undefined && safeArgs.shares === undefined) {
        const currentNav = Number(existing.last_nav) > 0 ? Number(existing.last_nav) : initNav;
        if (Number.isFinite(currentNav) && currentNav > 0) {
          shares = Number((initAmount / currentNav).toFixed(4));
        }
      }
      db.prepare(`
        UPDATE holdings
        SET init_amount=?, shares=?, cost=?, init_nav=?, init_nav_date=?,
            last_nav=CASE WHEN last_nav_date <= ? THEN ? ELSE last_nav END,
            last_nav_date=CASE WHEN last_nav_date <= ? THEN ? ELSE last_nav_date END,
            updated_at=?
        WHERE code=?
      `).run(initAmount, shares, cost, initNav, initNavDate, initNavDate, initNav, initNavDate, initNavDate, nowFn(), code);
      syncConfigHoldingsFromDb(db, paths);
      const after = /** @type {Record<string, unknown>} */ (
        db.prepare('SELECT * FROM holdings WHERE code=?').get(code)
      );
      return {
        ok: true,
        notify: true,
        title: `已更新基金 ${code} 持仓配置`,
        message: `✅ 已更新 ${String(after.name)} (${code})：成本 ${Number(after.cost).toFixed(2)} 元，份额 ${Number(after.shares).toFixed(2)}（基准净值日 ${String(after.init_nav_date)}: ${Number(after.init_nav)}）`,
        data: after,
      };
    }

    if ((name === 'noon' || name === 'settle') && isWeekend(nowFn()) && !safeArgs.force) {
      return {
        ok: true,
        notify: false,
        title: '非交易日静默跳过',
        message: '今日为周末休市日，跳过定时持仓推送。',
      };
    }

    const mode = name === 'settle' ? 'settle' : name === 'noon' ? 'noon' : 'status';
    const offline = Boolean(safeArgs.offline || process.env.FUND_TRACKER_OFFLINE === '1');
    const result = await computeValuation(db, mode, offline, { nowFn, fetchFn, signal });
    return {
      ok: true,
      notify: result.empty ? (name === 'status') : true,
      title: result.title,
      message: result.message,
      data: result.summary,
    };
  } catch (err) {
    return {
      ok: false,
      notify: true,
      title: '基金持仓操作失败',
      message: errMsg(err),
    };
  } finally {
    db.close();
  }
}

async function main() {
  const action = process.argv[2] || 'status';
  /** @type {Record<string, unknown>} */
  let args = {};
  if (process.argv[3]) {
    try { args = JSON.parse(process.argv[3]); } catch { args = {}; }
  }
  const result = await runAction(action, args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch(err => {
    process.stderr.write(`fund-tracker error: ${errMsg(err)}\n`);
    process.exitCode = 1;
  });
}

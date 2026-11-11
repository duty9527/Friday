#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_HOLDINGS = [
  {
    code: '020989',
    name: '南方恒生科技ETF发起联接(QDII)C',
    fundType: 'hk_etf_feeder',
    proxySymbol: 'hkHSTECH',
    proxyName: '恒生科技指数',
    positionRatio: 0.95,
    initAmount: 6840.20,
    cost: 10000.00,
    initNav: 0.9520,
    initNavDate: '2026-11-09',
  },
  {
    code: '024749',
    name: '博时中证卫星产业指数C',
    fundType: 'a_index',
    proxySymbol: 'sz159206',
    proxyName: '卫星ETF',
    positionRatio: 0.95,
    initAmount: 5602.24,
    cost: 10000.00,
    initNav: 0.8479,
    initNavDate: '2026-11-09',
  },
  {
    code: '019305',
    name: '摩根标普500指数(QDII)人民币C',
    fundType: 'us_qdii',
    proxySymbol: 'usINX',
    proxyName: '标普500指数',
    positionRatio: 0.95,
    initAmount: 5124.80,
    cost: 5000.00,
    initNav: 1.6138,
    initNavDate: '2026-11-06',
  },
  {
    code: '000217',
    name: '华安黄金ETF联接C',
    fundType: 'gold_feeder',
    proxySymbol: 'sh518880',
    proxyName: '黄金ETF华安',
    positionRatio: 0.95,
    initAmount: 1504.42,
    cost: 2000.00,
    initNav: 2.9575,
    initNavDate: '2026-11-09',
  },
  {
    code: '012349',
    name: '天弘恒生科技ETF联接C',
    fundType: 'hk_etf_feeder',
    proxySymbol: 'hkHSTECH',
    proxyName: '恒生科技指数',
    positionRatio: 0.95,
    initAmount: 825.13,
    cost: 1000.00,
    initNav: 0.5426,
    initNavDate: '2026-11-09',
  },
  {
    code: '018168',
    name: '国泰有色矿业ETF联接C',
    fundType: 'a_etf_feeder',
    proxySymbol: 'sh561330',
    proxyName: '有色矿业ETF',
    positionRatio: 0.95,
    initAmount: 468.32,
    cost: 720.00,
    initNav: 1.4509,
    initNavDate: '2026-11-09',
  },
  {
    code: '016055',
    name: '博时纳斯达克100ETF发起式联接(QDII)A',
    fundType: 'us_qdii',
    proxySymbol: 'usNDX',
    proxyName: '纳斯达克100',
    positionRatio: 0.95,
    initAmount: 318.66,
    cost: 300.00,
    initNav: 1.9969,
    initNavDate: '2026-11-09',
  },
];

function getDataDir() {
  if (process.env.PLUGIN_DATA_DIR) return resolve(process.env.PLUGIN_DATA_DIR);
  const home = process.env.SUPER_AGENT_HOME
    ? resolve(process.env.SUPER_AGENT_HOME)
    : resolve(homedir(), '.super-agent');
  return join(home, 'plugins', 'fund-tracker');
}

function openDb() {
  const dir = getDataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, 'funds.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL;
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

  const countRow = db.prepare('SELECT COUNT(*) AS cnt FROM holdings').get();
  if (Number(countRow?.cnt ?? 0) === 0) {
    const now = Date.now();
    const insert = db.prepare(`
      INSERT INTO holdings (
        code, name, fund_type, proxy_symbol, proxy_name, position_ratio,
        init_amount, cost, init_nav, init_nav_date, shares, last_nav, last_nav_date, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of DEFAULT_HOLDINGS) {
      const shares = Number((item.initAmount / item.initNav).toFixed(4));
      insert.run(
        item.code, item.name, item.fundType, item.proxySymbol, item.proxyName, item.positionRatio,
        item.initAmount, item.cost, item.initNav, item.initNavDate, shares,
        item.initNav, item.initNavDate, now,
      );
    }
  }
  return db;
}

function formatLocalDate(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isWeekend(ts = Date.now()) {
  const day = new Date(ts).getDay();
  return day === 0 || day === 6;
}

function signNum(n, digits = 2) {
  const fixed = Math.abs(n).toFixed(digits);
  return n > 0 ? `+${fixed}` : n < 0 ? `-${fixed}` : fixed;
}

async function fetchFundNavHistory(code, pageSize = 10) {
  const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${encodeURIComponent(code)}&pageIndex=1&pageSize=${pageSize}`;
  const res = await fetch(url, {
    headers: {
      Referer: 'https://fundf10.eastmoney.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Eastmoney NAV HTTP ${res.status} for ${code}`);
  const json = await res.json();
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

async function fetchMarketQuotes(symbols) {
  const unique = [...new Set(symbols.filter(Boolean))];
  if (!unique.length) return new Map();
  const url = `https://qt.gtimg.cn/q=${unique.join(',')}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
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
    map.set(key, {
      symbol: key,
      name: parts[1] || key,
      price: Number(parts[3] || 0),
      prevClose: Number(parts[4] || 0),
      changePct: Number(parts[32] || 0),
      quoteTime: String(parts[30] || ''),
    });
  }
  return map;
}

async function syncAllNavs(db, holdings) {
  const now = Date.now();
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
    try {
      const history = await fetchFundNavHistory(h.code, 10);
      if (history.length > 0) {
        for (const item of history) {
          upsertNav.run(h.code, item.navDate, item.nav, item.accNav, item.dailyReturn, now);
        }
        const latest = history[0];
        updateHoldingLatest.run(latest.nav, latest.navDate, now, h.code);
      }
    } catch {
      // Keep cached SQLite NAV if upstream is temporarily unreachable
    }
  }
}

async function computeValuation(db, mode = 'noon', offline = false) {
  const holdings = db.prepare('SELECT * FROM holdings ORDER BY cost DESC, code ASC').all();
  if (!offline) {
    await syncAllNavs(db, holdings);
  }
  const refreshedHoldings = db.prepare('SELECT * FROM holdings ORDER BY cost DESC, code ASC').all();
  const symbols = refreshedHoldings.map(h => String(h.proxy_symbol));
  let quotes = new Map();
  if (!offline) {
    try {
      quotes = await fetchMarketQuotes(symbols);
    } catch {
      // Fallback to 0% intraday change if quote API fails
    }
  }

  const today = formatLocalDate();
  const rows = [];
  let totalCost = 0;
  let totalAsset = 0;
  let totalDailyPnl = 0;

  for (const h of refreshedHoldings) {
    const code = String(h.code);
    const name = String(h.name);
    const shares = Number(h.shares);
    const cost = Number(h.cost);
    const positionRatio = Number(h.position_ratio);
    const proxySymbol = String(h.proxy_symbol);
    const proxyName = String(h.proxy_name);

    const navRows = db.prepare('SELECT * FROM nav_history WHERE code=? ORDER BY nav_date DESC LIMIT 3').all(code);
    const latestNavObj = navRows[0]
      ? { nav: Number(navRows[0].nav), navDate: String(navRows[0].nav_date), dailyReturn: Number(navRows[0].daily_return ?? 0) }
      : { nav: Number(h.last_nav), navDate: String(h.last_nav_date), dailyReturn: 0 };
    const prevNavObj = navRows[1]
      ? { nav: Number(navRows[1].nav), navDate: String(navRows[1].nav_date) }
      : undefined;

    const quote = quotes.get(proxySymbol);
    const proxyChangePct = quote ? Number(quote.changePct) : 0;

    // 区分 12:00 盘中实时估值 与 21:30 晚间正式结算
    const hasTodayOfficialNav = latestNavObj.navDate === today;
    let baseNav = latestNavObj.nav;
    let currentNav = latestNavObj.nav;
    let changePct = 0;
    let navSource = '';

    if (hasTodayOfficialNav) {
      // 当日正式净值已公布：直接采用官方正式净值与日涨跌幅结算
      currentNav = latestNavObj.nav;
      changePct = latestNavObj.dailyReturn;
      baseNav = prevNavObj ? prevNavObj.nav : Number((currentNav / (1 + changePct / 100)).toFixed(4));
      navSource = `✅ 正式净值(${latestNavObj.navDate})`;
    } else if (mode === 'settle') {
      // 晚间 21:30 结算时该基金尚未公布今日正式净值（如美股 QDII T+1 结算或晚间延迟更新）：
      // 采用收盘跟踪标的涨跌幅计算预估结算值，并同时展示已确认的最新正式净值
      baseNav = latestNavObj.nav;
      changePct = Number((proxyChangePct * positionRatio).toFixed(2));
      currentNav = Number((baseNav * (1 + changePct / 100)).toFixed(4));
      navSource = `⏳ 净值待更新(前值${latestNavObj.navDate}:${latestNavObj.nav.toFixed(4)}, 按${proxyName} ${signNum(proxyChangePct)}%预估)`;
    } else {
      // 盘中估值公式：
      // 估算净值 = 上一交易日净值 × (1 + 估算涨跌幅)
      // 估算涨跌幅 = 跟踪指数/ETF涨跌幅 × 仓位系数
      baseNav = latestNavObj.nav;
      changePct = Number((proxyChangePct * positionRatio).toFixed(2));
      currentNav = Number((baseNav * (1 + changePct / 100)).toFixed(4));
      navSource = `盘中估值(锚定${proxyName} ${signNum(proxyChangePct)}%)`;
    }

    // 当前估算资产 = 持仓份额 × 估算净值
    const currentAsset = Number((shares * currentNav).toFixed(2));
    // 当日估算收益 = 持仓份额 × (估算净值 - 上一交易日净值)
    const dailyPnl = Number((shares * (currentNav - baseNav)).toFixed(2));
    // 累计收益 = 当前估算资产 - 持仓成本
    const totalPnl = Number((currentAsset - cost).toFixed(2));
    const totalPnlPct = cost > 0 ? Number(((totalPnl / cost) * 100).toFixed(2)) : 0;

    totalCost += cost;
    totalAsset += currentAsset;
    totalDailyPnl += dailyPnl;

    rows.push({
      code,
      name,
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
    });
  }

  totalCost = Number(totalCost.toFixed(2));
  totalAsset = Number(totalAsset.toFixed(2));
  totalDailyPnl = Number(totalDailyPnl.toFixed(2));
  const totalPnl = Number((totalAsset - totalCost).toFixed(2));
  const totalPnlPct = totalCost > 0 ? Number(((totalPnl / totalCost) * 100).toFixed(2)) : 0;
  const prevAsset = totalAsset - totalDailyPnl;
  const dailyPnlPct = prevAsset > 0 ? Number(((totalDailyPnl / prevAsset) * 100).toFixed(2)) : 0;

  db.prepare(`
    INSERT INTO snapshots (kind, date, total_cost, total_asset, daily_pnl, total_pnl, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(mode, today, totalCost, totalAsset, totalDailyPnl, totalPnl, JSON.stringify(rows), Date.now());

  const title = mode === 'settle'
    ? `🌙【基金晚间正式结算 · ${today} 21:30】`
    : mode === 'noon'
      ? `☀️【基金午间持仓估值 · ${today} 12:00】`
      : `📊【基金实时持仓与收益状态 · ${today}】`;

  const lines = [
    title,
    `━━━━━━━━━━━━━━━━━━━━`,
    `💰 当前持仓总资产：${totalAsset.toFixed(2)} 元（总成本 ${totalCost.toFixed(2)} 元）`,
    `📈 当日${mode === 'settle' ? '结算' : '预估'}收益：${signNum(totalDailyPnl)} 元 (${signNum(dailyPnlPct)}%)`,
    `🏦 累计持仓总盈亏：${signNum(totalPnl)} 元 (${signNum(totalPnlPct)}%)`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📋 持仓明细（共 ${rows.length} 只）：`,
  ];

  for (const r of rows) {
    const icon = r.dailyPnl > 0 ? '🔴' : r.dailyPnl < 0 ? '🟢' : '⚪';
    lines.push(
      `${icon} ${r.name} (${r.code})`,
      `   • 资产/成本：${r.currentAsset.toFixed(2)} / ${r.cost.toFixed(2)} 元（份额 ${r.shares.toFixed(2)}）`,
      `   • 当日盈亏：${signNum(r.dailyPnl)} 元 (${signNum(r.changePct)}%) | 累计：${signNum(r.totalPnl)} 元 (${signNum(r.totalPnlPct)}%)`,
      `   • 净值口径：${r.currentNav.toFixed(4)} [${r.navSource}]`,
    );
  }

  return {
    today,
    title,
    message: lines.join('\n'),
    summary: {
      totalCost,
      totalAsset,
      totalDailyPnl,
      dailyPnlPct,
      totalPnl,
      totalPnlPct,
      holdings: rows,
    },
  };
}

async function main() {
  const action = process.argv[2] || 'status';
  let args = {};
  if (process.argv[3]) {
    try { args = JSON.parse(process.argv[3]); } catch { args = {}; }
  }
  const db = openDb();
  try {
    if (action === 'init') {
      const holdings = db.prepare('SELECT * FROM holdings ORDER BY cost DESC').all();
      await syncAllNavs(db, holdings);
      const updated = db.prepare('SELECT * FROM holdings ORDER BY cost DESC').all();
      process.stdout.write(JSON.stringify({
        ok: true,
        notify: true,
        title: '基金持仓初始化完成',
        message: `✅ 已初始化 ${updated.length} 只基金持仓并同步最新东方财富正式净值（合计成本 29,020.00 元）。`,
        data: { holdings: updated },
      }) + '\n');
      return;
    }

    if (action === 'set-holding') {
      const code = String(args.code ?? '').trim();
      if (!code) throw new Error('set-holding requires args.code');
      const existing = db.prepare('SELECT * FROM holdings WHERE code=?').get(code);
      if (!existing) throw new Error(`Holding ${code} not found`);
      let shares = args.shares !== undefined ? Number(args.shares) : Number(existing.shares);
      const cost = args.cost !== undefined ? Number(args.cost) : Number(existing.cost);
      let initNav = Number(existing.init_nav);
      let initNavDate = String(existing.init_nav_date);
      if (typeof args.navDate === 'string' && args.navDate.trim()) {
        initNavDate = args.navDate.trim();
        const history = await fetchFundNavHistory(code, 20);
        const matched = history.find(item => item.navDate === initNavDate);
        if (!matched) throw new Error(`未找到 ${code} 在 ${initNavDate} 的正式净值`);
        initNav = matched.nav;
        if (args.shares === undefined) {
          shares = Number((Number(existing.init_amount) / initNav).toFixed(4));
        }
      }
      db.prepare('UPDATE holdings SET shares=?, cost=?, init_nav=?, init_nav_date=?, updated_at=? WHERE code=?')
        .run(shares, cost, initNav, initNavDate, Date.now(), code);
      const after = db.prepare('SELECT * FROM holdings WHERE code=?').get(code);
      process.stdout.write(JSON.stringify({
        ok: true,
        notify: true,
        title: `已更新基金 ${code} 持仓配置`,
        message: `✅ 已更新 ${after.name} (${code})：成本 ${Number(after.cost).toFixed(2)} 元，份额 ${Number(after.shares).toFixed(2)}（基准净值日 ${after.init_nav_date}: ${after.init_nav}）`,
        data: after,
      }) + '\n');
      return;
    }

    if ((action === 'noon' || action === 'settle') && isWeekend() && !args.force) {
      process.stdout.write(JSON.stringify({
        ok: true,
        notify: false,
        title: '非交易日静默跳过',
        message: '今日为周末休市日，跳过定时持仓推送。',
      }) + '\n');
      return;
    }

    const mode = action === 'settle' ? 'settle' : action === 'noon' ? 'noon' : 'status';
    const offline = Boolean(args.offline || process.env.FUND_TRACKER_OFFLINE === '1');
    const result = await computeValuation(db, mode, offline);
    process.stdout.write(JSON.stringify({
      ok: true,
      notify: true,
      title: result.title,
      message: result.message,
      data: result.summary,
    }) + '\n');
  } finally {
    db.close();
  }
}

main().catch(err => {
  process.stderr.write(`fund-tracker error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

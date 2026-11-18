import { execFile } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveHomeDir } from '../_shared/config-store.mjs';

const execFileAsync = promisify(execFile);
const ACTIONS = ['status', 'patrol', 'remind'];

/**
 * @param {string} targetPath
 */
function collectDisk(targetPath) {
  try {
    const st = statfsSync(targetPath);
    const blockSize = Number(st.bsize || 4096);
    const totalBytes = Number(st.blocks) * blockSize;
    const freeBytes = Number(st.bavail) * blockSize;
    const totalGb = Number((totalBytes / (1024 ** 3)).toFixed(1));
    const freeGb = Number((freeBytes / (1024 ** 3)).toFixed(1));
    const usedPct = totalBytes > 0 ? Number((((totalBytes - freeBytes) / totalBytes) * 100).toFixed(1)) : 0;
    return { totalGb, freeGb, usedPct };
  } catch {
    return null;
  }
}

/**
 * @param {string} cwd
 * @param {AbortSignal} [signal]
 */
async function collectGit(cwd, signal) {
  if (!cwd || !existsSync(cwd)) return null;
  const opts = {
    cwd,
    encoding: /** @type {const} */ ('utf8'),
    timeout: 2500,
    ...(signal ? { signal } : {}),
  };
  try {
    const { stdout: insideRaw } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], opts);
    if (insideRaw.trim() !== 'true') return null;
    const [{ stdout: branchRaw }, { stdout: porcelainRaw }, lastCommit] = await Promise.all([
      execFileAsync('git', ['branch', '--show-current'], opts),
      execFileAsync('git', ['status', '--porcelain'], { ...opts, timeout: 3000 }),
      execFileAsync('git', ['log', '-1', '--pretty=%h %s'], opts)
        .then(r => r.stdout.trim())
        .catch(() => ''),
    ]);
    const branch = branchRaw.trim() || 'HEAD';
    const porcelain = porcelainRaw.trim();
    const dirtyCount = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
    return { cwd, branch, dirtyCount, lastCommit };
  } catch (err) {
    if (signal?.aborted || /** @type {{ name?: string }} */ (err)?.name === 'AbortError') {
      throw err;
    }
    return null;
  }
}

/**
 * @param {Record<string, unknown>} args
 * @param {import('../_shared/types.d.ts').PluginExecutionContext} context
 */
async function collectSnapshot(args, context) {
  const coreCount = Math.max(1, cpus().length);
  const [load1 = 0, load5 = 0, load15 = 0] = loadavg().map(v => Number(v.toFixed(2)));
  const loadPerCore = Number((load1 / coreCount).toFixed(2));
  const memTotalBytes = totalmem();
  const memFreeBytes = freemem();
  const memUsedBytes = Math.max(0, memTotalBytes - memFreeBytes);
  const memUsedPct = memTotalBytes > 0 ? Number(((memUsedBytes / memTotalBytes) * 100).toFixed(1)) : 0;
  const memTotalGb = Number((memTotalBytes / (1024 ** 3)).toFixed(1));
  const memUsedGb = Number((memUsedBytes / (1024 ** 3)).toFixed(1));
  const explicitCwd = typeof args.cwd === 'string' && args.cwd.trim() ? resolve(args.cwd.trim()) : '';
  const targetDir = explicitCwd || resolveHomeDir(context);
  const disk = collectDisk(existsSync(targetDir) ? targetDir : resolveHomeDir(context));
  const git = await collectGit(explicitCwd || process.cwd(), context?.signal);
  const uptimeHours = Number((uptime() / 3600).toFixed(1));
  return {
    host: hostname(),
    os: `${platform()} ${release()}`,
    node: process.version,
    uptimeHours,
    cpu: { cores: coreCount, load1, load5, load15, loadPerCore },
    memory: { usedGb: memUsedGb, totalGb: memTotalGb, usedPct: memUsedPct },
    disk,
    git,
  };
}

/**
 * Execute a system-pulse plugin action.
 * @param {string} [action]
 * @param {Record<string, unknown>} [args]
 * @param {import('../_shared/types.d.ts').PluginExecutionContext} [context]
 * @returns {Promise<import('../_shared/types.d.ts').PluginRunResult>}
 */
export async function runAction(action = 'status', args = {}, context = {}) {
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const name = String(action || 'status').trim().toLowerCase();
  if (!ACTIONS.includes(name)) {
    return {
      ok: false,
      notify: true,
      title: '系统巡检失败',
      message: `不支持的 system-pulse 动作 "${action}"，可用动作：${ACTIONS.join('、')}。`,
    };
  }

  const nowFn = typeof context.nowFn === 'function' ? context.nowFn : Date.now;

  if (name === 'remind') {
    const content = String(safeArgs.text ?? safeArgs.instruction ?? safeArgs.timerName ?? '定时提醒时间已到').trim();
    const clean = content.replace(/^(?:提醒我?|定时提醒)[:：\s]*/i, '').trim() || content;
    return {
      ok: true,
      notify: true,
      title: 'F.R.I.D.A.Y. 准点提醒',
      message: `⏰ 老板，提醒时间到了：${clean}`,
      data: { reminder: clean, triggeredAt: nowFn() },
    };
  }

  const snap = await collectSnapshot(safeArgs, context);

  if (name === 'patrol') {
    const maxLoadPerCore = typeof safeArgs.maxLoadPerCore === 'number' ? safeArgs.maxLoadPerCore : 2.5;
    const maxMemUsedPct = typeof safeArgs.maxMemUsedPct === 'number' ? safeArgs.maxMemUsedPct : 94;
    const minDiskFreeGb = typeof safeArgs.minDiskFreeGb === 'number' ? safeArgs.minDiskFreeGb : 2;
    const alerts = [];
    if (snap.cpu.loadPerCore > maxLoadPerCore) {
      alerts.push(`CPU 单核负载偏高 (${snap.cpu.loadPerCore} > ${maxLoadPerCore}，1m 负载 ${snap.cpu.load1}/${snap.cpu.cores} 核)`);
    }
    if (snap.memory.usedPct > maxMemUsedPct) {
      alerts.push(`系统内存占用偏高 (${snap.memory.usedPct}% > ${maxMemUsedPct}%，已用 ${snap.memory.usedGb}/${snap.memory.totalGb} GiB)`);
    }
    if (snap.disk && snap.disk.freeGb < minDiskFreeGb) {
      alerts.push(`磁盘剩余空间不足 (${snap.disk.freeGb} GiB < ${minDiskFreeGb} GiB)`);
    }
    if (safeArgs.warnDirtyGit === true && snap.git && snap.git.dirtyCount > 0) {
      alerts.push(`工作区 ${snap.git.branch} 存在 ${snap.git.dirtyCount} 处未提交变更`);
    }
    if (alerts.length === 0 && safeArgs.force !== true) {
      return {
        ok: true,
        notify: false,
        title: '系统巡航正常',
        message: '',
        data: { healthy: true, snapshot: snap },
      };
    }
    const lines = alerts.length
      ? [`⚠️ 老板，巡航检测到 ${alerts.length} 项主机/工作区指标越界：`, ...alerts.map(a => `- ${a}`)]
      : [`✅ 老板，主机各项生命体征平稳（CPU 负载 ${snap.cpu.load1}/${snap.cpu.cores} 核 · 内存 ${snap.memory.usedPct}% · 磁盘余量 ${snap.disk?.freeGb ?? '—'} GiB）。`];
    return {
      ok: true,
      notify: true,
      title: alerts.length ? 'F.R.I.D.A.Y. 系统巡航告警' : 'F.R.I.D.A.Y. 巡航简报',
      message: lines.join('\n'),
      data: { healthy: alerts.length === 0, alerts, snapshot: snap },
    };
  }

  const lines = [
    `🖥️ 主机 ${snap.host} (${snap.os} · Node ${snap.node} · 已运行 ${snap.uptimeHours}h)`,
    `⚡ CPU：${snap.cpu.cores} 核 · 负载 ${snap.cpu.load1} / ${snap.cpu.load5} / ${snap.cpu.load15}（单核比 ${snap.cpu.loadPerCore}）`,
    `🧠 内存：${snap.memory.usedGb} / ${snap.memory.totalGb} GiB (${snap.memory.usedPct}%)`,
  ];
  if (snap.disk) {
    lines.push(`💾 磁盘：剩余 ${snap.disk.freeGb} / ${snap.disk.totalGb} GiB（已用 ${snap.disk.usedPct}%）`);
  }
  if (snap.git) {
    lines.push(`🌿 Git (${snap.git.branch})：${snap.git.dirtyCount === 0 ? '工作区干净' : `${snap.git.dirtyCount} 处未提交变更`}${snap.git.lastCommit ? ` · 最近提交 ${snap.git.lastCommit}` : ''}`);
  }
  return {
    ok: true,
    notify: true,
    title: '主机与工作区状态快照',
    message: lines.join('\n'),
    data: snap,
  };
}

async function main() {
  const action = process.argv[2] || 'status';
  /** @type {Record<string, unknown>} */
  let args = {};
  try {
    args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  } catch {
    args = {};
  }
  const result = await runAction(action, args);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  await main();
}

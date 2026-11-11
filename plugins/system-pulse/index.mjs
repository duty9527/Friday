import { execFileSync } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from 'node:os';
import { resolve } from 'node:path';

const action = process.argv[2] || 'status';
let args = {};
try {
  args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
} catch {
  args = {};
}

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

function collectGit(cwd) {
  if (!cwd || !existsSync(cwd)) return null;
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500,
    }).trim();
    if (inside !== 'true') return null;
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500,
    }).trim() || 'HEAD';
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    const dirtyCount = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
    let lastCommit = '';
    try {
      lastCommit = execFileSync('git', ['log', '-1', '--pretty=%h %s'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2500,
      }).trim();
    } catch {
      lastCommit = '';
    }
    return { cwd, branch, dirtyCount, lastCommit };
  } catch {
    return null;
  }
}

function collectSnapshot() {
  const coreCount = Math.max(1, cpus().length);
  const [load1, load5, load15] = loadavg().map(v => Number(v.toFixed(2)));
  const loadPerCore = Number((load1 / coreCount).toFixed(2));
  const memTotalBytes = totalmem();
  const memFreeBytes = freemem();
  const memUsedBytes = Math.max(0, memTotalBytes - memFreeBytes);
  const memUsedPct = memTotalBytes > 0 ? Number(((memUsedBytes / memTotalBytes) * 100).toFixed(1)) : 0;
  const memTotalGb = Number((memTotalBytes / (1024 ** 3)).toFixed(1));
  const memUsedGb = Number((memUsedBytes / (1024 ** 3)).toFixed(1));
  const targetDir = typeof args.cwd === 'string' && args.cwd.trim()
    ? resolve(args.cwd.trim())
    : process.env.SUPER_AGENT_HOME || process.cwd();
  const disk = collectDisk(existsSync(targetDir) ? targetDir : process.cwd());
  const git = collectGit(typeof args.cwd === 'string' && args.cwd.trim() ? resolve(args.cwd.trim()) : process.cwd());
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

if (action === 'remind') {
  const content = String(args.text ?? args.instruction ?? args.timerName ?? '定时提醒时间已到').trim();
  const clean = content.replace(/^(?:提醒我?|定时提醒)[:：\s]*/i, '').trim() || content;
  process.stdout.write(JSON.stringify({
    ok: true,
    notify: true,
    title: 'F.R.I.D.A.Y. 准点提醒',
    message: `⏰ 老板，提醒时间到了：${clean}`,
    data: { reminder: clean, triggeredAt: Date.now() },
  }) + '\n');
} else if (action === 'patrol') {
  const snap = collectSnapshot();
  const maxLoadPerCore = typeof args.maxLoadPerCore === 'number' ? args.maxLoadPerCore : 2.5;
  const maxMemUsedPct = typeof args.maxMemUsedPct === 'number' ? args.maxMemUsedPct : 94;
  const minDiskFreeGb = typeof args.minDiskFreeGb === 'number' ? args.minDiskFreeGb : 2;
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
  if (args.warnDirtyGit === true && snap.git && snap.git.dirtyCount > 0) {
    alerts.push(`工作区 ${snap.git.branch} 存在 ${snap.git.dirtyCount} 处未提交变更`);
  }
  if (alerts.length === 0 && args.force !== true) {
    process.stdout.write(JSON.stringify({
      ok: true,
      notify: false,
      title: '系统巡航正常',
      message: '',
      data: { healthy: true, snapshot: snap },
    }) + '\n');
  } else {
    const lines = alerts.length
      ? [`⚠️ 老板，巡航检测到 ${alerts.length} 项主机/工作区指标越界：`, ...alerts.map(a => `- ${a}`)]
      : [`✅ 老板，主机各项生命体征平稳（CPU 负载 ${snap.cpu.load1}/${snap.cpu.cores} 核 · 内存 ${snap.memory.usedPct}% · 磁盘余量 ${snap.disk?.freeGb ?? '—'} GiB）。`];
    process.stdout.write(JSON.stringify({
      ok: true,
      notify: true,
      title: alerts.length ? 'F.R.I.D.A.Y. 系统巡航告警' : 'F.R.I.D.A.Y. 巡航简报',
      message: lines.join('\n'),
      data: { healthy: alerts.length === 0, alerts, snapshot: snap },
    }) + '\n');
  }
} else {
  const snap = collectSnapshot();
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
  process.stdout.write(JSON.stringify({
    ok: true,
    notify: true,
    title: '主机与工作区状态快照',
    message: lines.join('\n'),
    data: snap,
  }) + '\n');
}

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACTIONS = ['status', 'dashboard', 'layout', 'express', 'sound', 'screen'];

/**
 * @param {import('../_shared/types.d.ts').PluginExecutionContext} context
 * @returns {string}
 */
function resolveDaemonUrl(context) {
  const env = context?.env ?? {};
  const explicitUrl = String(env.CS80_FACE_URL ?? process.env.CS80_FACE_URL ?? '').trim();
  if (explicitUrl) return explicitUrl.replace(/\/+$/, '');
  const portRaw = String(env.CS80_FACE_PORT ?? process.env.CS80_FACE_PORT ?? '8788').trim();
  const port = Number(portRaw);
  const safePort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 8788;
  return `http://127.0.0.1:${safePort}`;
}

/**
 * @param {AbortSignal | undefined} external
 * @param {number} timeoutMs
 */
function combineSignal(external, timeoutMs) {
  const timer = AbortSignal.timeout(timeoutMs);
  if (!external) return timer;
  return AbortSignal.any([external, timer]);
}

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {{ method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number }} [opts]
 */
async function callDaemon(baseUrl, path, opts = {}) {
  const method = opts.method ?? 'GET';
  const headers = opts.body !== undefined ? { 'content-type': 'application/json' } : undefined;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: combineSignal(opts.signal, opts.timeoutMs ?? 20_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`CS80 daemon returned non-JSON (${res.status}): ${text.slice(0, 160)}`);
  }
  if (!res.ok && json?.ok !== false) {
    throw new Error(`CS80 daemon HTTP ${res.status}`);
  }
  return json;
}

/**
 * Execute a cs80-face plugin action.
 * @param {string} [action]
 * @param {Record<string, unknown>} [args]
 * @param {import('../_shared/types.d.ts').PluginExecutionContext} [context]
 * @returns {Promise<import('../_shared/types.d.ts').PluginRunResult>}
 */
export async function runAction(action = 'status', args = {}, context = {}) {
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const name = String(action || 'status').trim().toLowerCase();
  const silent = safeArgs.silent === true;
  if (!ACTIONS.includes(name)) {
    return {
      ok: false,
      notify: true,
      title: 'CS80 副屏控制失败',
      message: `不支持的 cs80-face 动作 "${action}"，可用动作：${ACTIONS.join('、')}。`,
    };
  }

  const baseUrl = resolveDaemonUrl(context);

  try {
    if (name === 'status') {
      const st = await callDaemon(baseUrl, '/api/status', { signal: context?.signal, timeoutMs: 6000 });
      const spk = st.speaker ?? {};
      const lines = [
        `🖥️ CS80 设备状态：${st.device ?? 'unknown'}${st.usbSpeed ? ` (USB ${st.usbSpeed} Mbps)` : ''}${st.block ? ` · block=${st.block}` : ''}`,
        `🤖 脸部状态：${st.botState ?? 'idle'} (${st.subPhase ?? 'awake'}) · 表情覆盖=${st.expression ?? 'auto'} · 活跃Worker=${st.workerCount ?? 0}`,
        `📐 副屏网格：2x${st.gridRows ?? 2} · 当前第 ${(Number(st.activePage ?? 0) + 1)}/${st.pageCount ?? 1} 页 · 跑马灯=${st.marqueeMode ?? 'auto_pause'}`,
        `💡 屏幕：亮度=${st.brightness ?? 100}% · 待机=${st.standby ? '是' : '否'} · Cairo=${st.cairo ? 'on' : 'fallback'}`,
        `🔊 喇叭：音量=${spk.volume ?? 65}% · 静音=${spk.muted ? '是' : '否'} · 夜间免打扰=${spk.quietHours || '关'}`,
      ];
      if (st.udevHint) {
        lines.push(`⚠️ 需要一次性 udev 权限规则：${st.udevHint}`);
      } else if (st.lastError && st.device !== 'up') {
        lines.push(`ℹ️ 详情：${st.lastError}`);
      }
      return {
        ok: true,
        notify: !silent,
        title: 'CS80 副屏与喇叭状态',
        message: lines.join('\n'),
        data: st,
      };
    }

    if (name === 'dashboard') {
      const wantPreview = safeArgs.includePreview !== false;
      const dash = await callDaemon(baseUrl, `/api/dashboard?preview=${wantPreview ? '1' : '0'}`, {
        signal: context?.signal,
        timeoutMs: 8000,
      });
      return {
        ok: Boolean(dash && typeof dash === 'object' && (dash.ok ?? true)),
        notify: false,
        title: 'CS80 副屏配置面板数据',
        message: `CS80 状态=${dash?.status?.device ?? 'unknown'} · 页数=${dash?.layout?.pages?.length ?? 1}`,
        data: dash,
      };
    }

    const payload = { ...safeArgs, action: name };
    const timeoutMs = name === 'sound' ? 30_000 : 10_000;
    const res = await callDaemon(baseUrl, '/api/control', {
      method: 'POST',
      body: payload,
      signal: context?.signal,
      timeoutMs,
    });

    const ok = Boolean(res?.ok);
    if (name === 'layout') {
      const pagesCount = Array.isArray(res?.layout?.pages) ? res.layout.pages.length : 1;
      const gridRows = res?.layout?.gridRows ?? 2;
      return {
        ok,
        notify: safeArgs.notify === true && !silent,
        title: 'CS80 Bento 卡片编排已更新',
        message: ok
          ? `🧩 已保存并同步 CS80 副屏布局：2x${gridRows} 网格 · ${pagesCount} 页 · 跑马灯=${res?.layout?.marqueeMode ?? 'auto_pause'}`
          : `⚠️ 更新 CS80 布局失败：${res?.err ?? 'unknown'}`,
        data: res,
      };
    }

    if (name === 'express') {
      const desc = [
        safeArgs.scene ? `场景=${safeArgs.scene}` : '',
        safeArgs.channel ? `通道=${safeArgs.channel}` : '',
        safeArgs.expr ? `表情=${safeArgs.expr}` : '',
        safeArgs.poke ? `动作=${safeArgs.poke}` : '',
        safeArgs.text ? `屏幕文字=“${String(safeArgs.text)}”` : '',
      ].filter(Boolean).join(' · ') || '已刷新';
      return {
        ok,
        notify: !silent,
        title: 'CS80 表情互动',
        message: ok ? `✨ 已更新 CS80 副屏：${desc}` : `⚠️ 更新 CS80 表情失败：${res?.err ?? 'unknown'}`,
        data: res,
      };
    }

    if (name === 'sound') {
      const hasReminderText = typeof safeArgs.text === 'string' && safeArgs.text.trim().length > 0;
      const parts = [];
      if (safeArgs.chime) parts.push(`提示音=${safeArgs.chime}`);
      if (safeArgs.file) parts.push(`文件=${safeArgs.file}`);
      if (safeArgs.volume !== undefined) parts.push(`音量=${safeArgs.volume}%`);
      if (safeArgs.muted !== undefined) parts.push(safeArgs.muted ? '已静音' : '已取消静音');
      if (safeArgs.stop) parts.push('已停止播放');
      if (hasReminderText) parts.push(`提醒=“${String(safeArgs.text).trim()}”`);
      const detail = parts.join(' · ') || '已完成';
      return {
        ok,
        notify: !silent,
        title: hasReminderText ? 'F.R.I.D.A.Y. CS80 定时提醒' : 'CS80 内置喇叭',
        message: ok
          ? (hasReminderText ? `🔔 ${String(safeArgs.text).trim()}（CS80 喇叭已响铃）` : `🔊 CS80 喇叭操作完成：${detail}`)
          : `⚠️ CS80 喇叭操作失败：${res?.play?.err ?? res?.err ?? 'unknown'}`,
        data: res,
      };
    }

    // screen
    const screenParts = [];
    if (safeArgs.brightness !== undefined) screenParts.push(`亮度=${safeArgs.brightness}%`);
    if (safeArgs.standby !== undefined) screenParts.push(safeArgs.standby ? '进入待机' : '已唤醒');
    if (safeArgs.refresh) screenParts.push('已全帧刷新');
    return {
      ok,
      notify: !silent,
      title: 'CS80 屏幕控制',
      message: ok ? `🖥️ CS80 屏幕已更新：${screenParts.join(' · ') || '完成'}` : `⚠️ CS80 屏幕控制失败：${res?.err ?? 'unknown'}`,
      data: res,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      notify: !silent,
      title: 'CS80 守护进程未连接',
      message: `无法连接 CS80 伴侣守护进程 (${baseUrl})：${msg}。请确认 friday-face.service 已启动。`,
      data: { baseUrl, error: msg },
    };
  }
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

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type Cs80SceneId =
  | 'speaking'
  | 'sending_msg'
  | 'printing'
  | 'operating_xiaoai'
  | 'operating_tv'
  | 'managing_laifen'
  | 'weighing_scale';

export interface Cs80ScenePayload {
  scene: Cs80SceneId;
  phase: 'start' | 'pulse' | 'end';
  channel?: string;
  caption?: string;
  holdSec?: number;
  tailSec?: number;
  force?: boolean;
}

export interface Cs80PushOptions {
  skipWhenMocked?: boolean;
}

const READONLY_PLUGIN_ACTIONS = new Set([
  'status',
  'dashboard',
  'devices',
  'get',
  'keys',
  'config',
  'tree',
  'screenshot',
  'trips',
  'vehicles',
  'scan',
  'list',
  'info',
  'measure-status',
  'monitor-status',
  'tracks',
  'search-online',
]);

const PRINT_BASH_CMD_RE = /(?:^|[;&|(\n]\s*)(?:sudo\s+)?(?:\/usr\/bin\/|\/bin\/)?(?:lp|lpr|ipptool|cupsfilter)\b(?:\s|$)/m;
const PRINT_CUPS_SCRIPT_RE = /cups\.Connection[\s\S]*printFile|printFile\s*\(/i;

function resolveCs80BaseUrl(): string {
  const rawUrl = process.env.CS80_FACE_URL?.trim();
  if (rawUrl) {
    return rawUrl.replace(/\/+$/, '');
  }
  const portNum = Number(process.env.CS80_FACE_PORT ?? '8788');
  const port = Number.isInteger(portNum) && portNum > 0 && portNum <= 65535 ? portNum : 8788;
  return `http://127.0.0.1:${port}`;
}

function shouldSuppressCs80Push(options?: Cs80PushOptions): boolean {
  if (process.env.CS80_FACE_VOICE_PUSH === '0' || process.env.CS80_FACE_PUSH === '0') {
    return true;
  }
  const explicitTarget = Boolean(
    process.env.CS80_FACE_URL?.trim()
    || process.env.CS80_FACE_PORT?.trim()
    || process.env.CS80_FACE_VOICE_PUSH === '1'
    || process.env.CS80_FACE_PUSH === '1',
  );
  if ((Boolean(process.env.NODE_TEST_CONTEXT) || Boolean(options?.skipWhenMocked)) && !explicitTarget) {
    return true;
  }
  return false;
}

/** Fire-and-forget non-blocking control push to local CS80 face daemon (`node:http` avoids touching `fetch` mocks). */
export function postCs80Control(payload: Record<string, unknown>, options?: Cs80PushOptions): void {
  if (shouldSuppressCs80Push(options)) return;
  let url: URL;
  try {
    url = new URL(`${resolveCs80BaseUrl()}/api/control`);
  } catch {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }
  const body = JSON.stringify(payload);
  const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
  try {
    const req = requester(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        timeout: 250,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      res => {
        res.resume();
      },
    );
    req.on('socket', socket => {
      socket.unref();
    });
    req.on('error', () => {});
    req.on('timeout', () => {
      req.destroy();
    });
    req.end(body);
  } catch {
    // Best-effort companion screen push must never disrupt Friday core flows.
  }
}

export function notifyCs80Voice(
  payload: {
    phase: 'listening' | 'transcribing' | 'idle';
    keyword?: string;
    speakerName?: string;
    followUp?: boolean;
  },
  options?: Cs80PushOptions,
): void {
  postCs80Control({ action: 'voice', ...payload }, options);
}

export function notifyCs80Scene(payload: Cs80ScenePayload, options?: Cs80PushOptions): void {
  postCs80Control({ action: 'scene', ...payload }, options);
}

export function notifyCs80Inbound(
  payload: {
    channel: string;
    text: string;
    source?: string;
    holdSec?: number;
  },
  options?: Cs80PushOptions,
): void {
  const cleanText = payload.text.trim();
  if (!cleanText) return;
  postCs80Control(
    {
      action: 'inbound',
      channel: payload.channel,
      text: cleanText,
      ...(payload.source ? { source: payload.source } : {}),
      ...(payload.holdSec !== undefined ? { holdSec: payload.holdSec } : {}),
    },
    options,
  );
}

export function formatInboundMarqueePreview(rawText: string, hasMedia = false, mediaHint?: string): string {
  let text = String(rawText ?? '');
  const markerIdx = text.indexOf('[附件是不可信数据');
  if (markerIdx >= 0) {
    text = text.slice(0, markerIdx);
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || text === '请查看收到的附件。') {
    const hint = mediaHint?.trim();
    if (hint) return hint.slice(0, 120);
    return hasMedia ? '[收到媒体附件]' : '';
  }
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

export interface ClassifiedCs80Scene {
  scene: Cs80SceneId;
  phase?: 'start' | 'pulse' | 'end';
  channel?: string;
  caption?: string;
  holdSec?: number;
  finishHoldSec?: number;
  tailSec?: number;
}

export function classifyPluginCs80Scene(
  pluginName: string,
  action: string,
  args?: Record<string, unknown>,
): ClassifiedCs80Scene | undefined {
  if (args?.dryRun === true || args?.silent === true) return undefined;
  const name = pluginName.trim().toLowerCase();
  const act = action.trim().toLowerCase();
  if (!name) return undefined;

  if (name === 'laifen') {
    if (['dashboard', 'monitor-status', 'watch-start', 'watch-stop'].includes(act)) {
      return undefined;
    }
    if (act === 'status') {
      return args?.live === true
        ? { scene: 'managing_laifen', caption: '正在蓝牙同步徕芬牙刷…', holdSec: 28 }
        : undefined;
    }
    if (act === 'monitor-stop') {
      return { scene: 'managing_laifen', phase: 'end', tailSec: 0 };
    }
    if (act === 'config') {
      const hasMutation = Boolean(
        args && Object.entries(args).some(([k, v]) => v !== undefined && !['silent', 'dryRun'].includes(k)),
      );
      return hasMutation
        ? { scene: 'managing_laifen', caption: '正在配置徕芬牙刷参数…' }
        : undefined;
    }
    if (act === 'monitor-start') {
      const timeoutSec = Number(args?.timeoutSec ?? 360);
      const holdSec = Number.isFinite(timeoutSec) && timeoutSec > 0 ? Math.min(600, Math.round(timeoutSec) + 10) : 370;
      return { scene: 'managing_laifen', caption: '徕芬牙刷刷牙实时监听中…', holdSec, finishHoldSec: holdSec };
    }
    if (act === 'sync') {
      return { scene: 'managing_laifen', caption: '正在蓝牙唤醒同步徕芬牙刷…', holdSec: 28 };
    }
    if (act === 'set') {
      return { scene: 'managing_laifen', caption: '正在调节徕芬牙刷扫振档位…', holdSec: 28 };
    }
    if (act === 'power') {
      return { scene: 'managing_laifen', caption: '正在控制徕芬牙刷电机/校准…', holdSec: 28 };
    }
    if (['scan', 'brushhead-reset', 'session-add', 'session-delete', 'pending-clear'].includes(act)) {
      return { scene: 'managing_laifen', caption: '正在管理徕芬电动牙刷…' };
    }
    return undefined;
  }

  if (name === 'health-scale') {
    if (act === 'measure-start') {
      const timeoutSec = Number(args?.timeoutSec ?? 45);
      const holdSec = Number.isFinite(timeoutSec) && timeoutSec > 0 ? Math.min(120, Math.round(timeoutSec) + 5) : 50;
      return { scene: 'weighing_scale', caption: '沃莱 A1 测试模式 · 请赤脚上秤测量…', holdSec, finishHoldSec: holdSec };
    }
    if (act === 'scan') {
      return { scene: 'weighing_scale', caption: '正在蓝牙扫描沃莱 A1 体脂秤…', holdSec: 12 };
    }
    if (act === 'measure-stop') {
      return { scene: 'weighing_scale', phase: 'end', tailSec: 0 };
    }
    return undefined;
  }

  if (READONLY_PLUGIN_ACTIONS.has(act)) return undefined;

  if (name === 'music') {
    if (act === 'download') {
      return { scene: 'operating_xiaoai', caption: '正在搜索下载音乐…', holdSec: 30 };
    }
    if (['play', 'pause', 'resume', 'stop', 'next', 'prev', 'volume', 'loop', 'timer'].includes(act)) {
      return { scene: 'operating_xiaoai', caption: '正在小爱音箱播控音乐…' };
    }
    return undefined;
  }

  if (name === 'tv-ir') {
    if (['press', 'sequence', 'learn'].includes(act)) {
      return { scene: 'operating_tv', caption: '正在遥控客厅电视…' };
    }
    return undefined;
  }

  if (name === 'tv-agent') {
    if (act === 'volume') {
      const mutates = args?.level !== undefined || args?.delta !== undefined || args?.mute !== undefined;
      return mutates ? { scene: 'operating_tv', caption: '正在调节电视音量…' } : undefined;
    }
    if (act === 'cast') {
      const op = String(args?.op ?? 'info').trim().toLowerCase();
      return op === 'info' ? undefined : { scene: 'operating_tv', caption: '正在投屏控制电视…' };
    }
    if (['power', 'open_app', 'act', 'navigate'].includes(act)) {
      return { scene: 'operating_tv', caption: '正在遥控客厅电视…' };
    }
    return undefined;
  }

  if (name === 'miot') {
    if (act === 'cook') {
      const op = String(args?.op ?? 'status').trim().toLowerCase();
      if (op === 'status') return undefined;
      return { scene: 'operating_xiaoai', caption: '正在通过小爱音箱操控家居设备…' };
    }
    if (act === 'set') {
      const devHint = String(args?.device ?? args?.did ?? args?.name ?? '');
      if (/电视|tv/i.test(devHint)) {
        return { scene: 'operating_tv', caption: '正在遥控客厅电视…' };
      }
      return { scene: 'operating_xiaoai', caption: '正在通过小爱音箱操控家居设备…' };
    }
    if (['action', 'command'].includes(act)) {
      return { scene: 'operating_xiaoai', caption: '正在通过小爱音箱操控家居设备…' };
    }
    return undefined;
  }

  if (name.includes('print') || act.includes('print')) {
    return { scene: 'printing', caption: '正在操作打印机输出文档…' };
  }

  return undefined;
}

function formatTvStepsCaption(steps: unknown): string {
  if (!Array.isArray(steps) || steps.length === 0) return '';
  const parts: string[] = [];
  for (const s of steps) {
    if (!s || typeof s !== 'object') continue;
    const label = String((s as { label?: unknown }).label ?? '').trim();
    const count = Number((s as { count?: unknown }).count ?? 1);
    if (!label) continue;
    parts.push(count > 1 ? `${label}${count}下` : label);
  }
  return parts.join('、');
}

export function classifyFastpathCs80Scene(
  request: { text?: string; platform?: string; sessionState?: Record<string, unknown> },
  result?: { handled?: boolean; plugin?: string; action?: string; data?: unknown; sessionState?: Record<string, unknown> | null },
): ClassifiedCs80Scene | undefined {
  if (!result?.handled) return undefined;

  const ev = String(request.sessionState?.event ?? '');
  const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? (result.data as Record<string, unknown>)
    : undefined;
  if (data?.readonly === true || data?.dryRun === true) return undefined;

  const plugin = String(result.plugin ?? '').trim().toLowerCase();
  const act = String(result.action ?? '').trim().toLowerCase();

  if (ev === 'assistant_reply') {
    if ((plugin === 'tv-ir' || plugin === 'tv-agent') && act === 'tv_remote_enter') {
      return { scene: 'operating_tv', phase: 'start', holdSec: 64, caption: '电视遥控模式 · 请直接说按键指令' };
    }
    return undefined;
  }

  if (ev === 'measure_poll') {
    if (act === 'measure-completed') {
      return { scene: 'weighing_scale', phase: 'end', tailSec: 1.2 };
    }
    if (['measure-timeout', 'measure-ended', 'measure-stop'].includes(act)) {
      return { scene: 'weighing_scale', phase: 'end', tailSec: 0 };
    }
    return undefined;
  }

  if (ev === 'brushing_poll') {
    if (act === 'monitor-completed') {
      return { scene: 'managing_laifen', phase: 'end', tailSec: 1.2 };
    }
    if (['monitor-timeout', 'monitor-ended', 'monitor-stop'].includes(act)) {
      return { scene: 'managing_laifen', phase: 'end', tailSec: 0 };
    }
    return undefined;
  }

  if (plugin === 'tv-ir' || plugin === 'tv-agent') {
    if (act === 'tv_remote_exit') {
      return { scene: 'operating_tv', phase: 'end', tailSec: 0 };
    }
    if (act === 'tv_remote_enter') {
      return { scene: 'operating_tv', phase: 'start', holdSec: 64, caption: '电视遥控模式 · 请直接说按键指令' };
    }
    if (['voice_fastpath_ignored', 'ignored', 'noop', 'status', 'query', 'keys', 'exit', 'cancel'].includes(act)) {
      return undefined;
    }
    const inRemote = Boolean(result.sessionState?.tvRemoteActive);
    const stepText = formatTvStepsCaption(data?.steps);
    if (inRemote) {
      return {
        scene: 'operating_tv',
        phase: 'start',
        holdSec: 64,
        caption: stepText ? `电视遥控模式 · 已按${stepText}` : '电视遥控模式 · 请直接说按键指令',
      };
    }
    return {
      scene: 'operating_tv',
      phase: 'pulse',
      holdSec: 4.5,
      caption: stepText ? `电视遥控 · 已按${stepText}` : '正在遥控客厅电视…',
    };
  }

  if (['voice_fastpath_ignored', 'ignored', 'noop', 'status', 'query', 'keys', 'exit', 'cancel', 'tv_remote_exit'].includes(act)) {
    return undefined;
  }

  if (plugin === 'laifen') {
    if (act === 'monitor-stop') {
      return { scene: 'managing_laifen', phase: 'end', tailSec: 0 };
    }
    if (act === 'monitor-start') {
      const timeoutSec = Number(data?.timeoutSec ?? 360);
      const holdSec = Number.isFinite(timeoutSec) && timeoutSec > 0 ? Math.min(600, Math.round(timeoutSec) + 10) : 370;
      return { scene: 'managing_laifen', phase: 'start', holdSec, caption: '徕芬牙刷刷牙实时监听中…' };
    }
    if (['sync', 'set', 'power', 'brushhead-reset', 'session-add'].includes(act)) {
      return { scene: 'managing_laifen', phase: 'pulse', holdSec: 4.5, caption: '正在管理徕芬电动牙刷…' };
    }
    return undefined;
  }

  if (plugin === 'health-scale') {
    if (act === 'measure-start') {
      const timeoutSec = Number(data?.timeoutSec ?? 45);
      const holdSec = Number.isFinite(timeoutSec) && timeoutSec > 0 ? Math.min(120, Math.round(timeoutSec) + 5) : 50;
      return { scene: 'weighing_scale', phase: 'start', holdSec, caption: '沃莱 A1 测试模式 · 请赤脚上秤测量…' };
    }
    if (act === 'measure-completed') {
      return { scene: 'weighing_scale', phase: 'end', tailSec: 1.2 };
    }
    if (['measure-stop', 'measure-timeout', 'measure-ended'].includes(act)) {
      return { scene: 'weighing_scale', phase: 'end', tailSec: 0 };
    }
    return undefined;
  }

  if (plugin === 'miot') {
    if (['devices', 'get'].includes(act)) return undefined;
    const devHint = String(data?.device ?? data?.name ?? request.text ?? '');
    if (/电视|tv/i.test(devHint)) {
      return { scene: 'operating_tv', caption: '正在遥控客厅电视…' };
    }
    return { scene: 'operating_xiaoai', caption: '正在通过小爱音箱操控家居设备…' };
  }
  if (plugin === 'music') {
    if (['status', 'query', 'dashboard', 'tracks'].includes(act)) return undefined;
    return { scene: 'operating_xiaoai', phase: 'pulse', holdSec: 4.0, caption: '正在小爱音箱播控音乐…' };
  }
  if (plugin.includes('print') || act.includes('print')) {
    return { scene: 'printing', caption: '正在操作打印机输出文档…' };
  }
  return undefined;
}

export function classifyBashCommandCs80Scene(
  command: string,
): { scene: Cs80SceneId; caption: string } | undefined {
  const cmd = String(command ?? '').trim();
  if (!cmd || /--help\b/.test(cmd)) return undefined;
  if (PRINT_BASH_CMD_RE.test(cmd) || PRINT_CUPS_SCRIPT_RE.test(cmd)) {
    return { scene: 'printing', caption: '正在操作打印机输出文档…' };
  }
  return undefined;
}

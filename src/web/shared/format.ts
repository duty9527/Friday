export const statusNames: Record<string, string> = {
  queued: '排队中',
  processing: '处理中',
  streaming: '回复中',
  completed: '已完成',
  interrupted: '已中断',
  failed: '失败',
  running: '运行中',
  started: '已开始',
  requested: '已请求',
  succeeded: '成功',
  paused: '已暂停',
  cancelled: '已取消',
  stopped: '已停止',
  stopping: '正在请求停止',
  stop_requested: '已请求停止',
  cancel_requested: '已请求取消',
  unknown: '结果未知',
  waiting_decision: '等待老板拍板',
  decision_received: '已获老板拍板',
  linked: '已关联',
  ready: '就绪',
  degraded: '服务降级',
  pending: '处理中',
  accepted: '已受理',
  followup: '收到补充要求',
  followup_failed: '补充要求未处理',
};

export function statusText(value: string): string {
  return statusNames[value] ?? value;
}

export function timestamp(at: number): string {
  return Number.isFinite(at) ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '—';
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? '—';
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败';
}

export function formatIntervalText(ms: number): string {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec % 3600 === 0) return `每 ${sec / 3600} 小时 (${sec}s)`;
  if (sec % 60 === 0) return `每 ${sec / 60} 分钟 (${sec}s)`;
  return `每 ${sec} 秒`;
}

export const synapseRelationNames: Record<string, string> = {
  explicit: '显式关联',
  semantic: '语义关联',
  co_activated: '共现强化',
  shared_tag: '标签共振',
  task_chain: '任务同源',
};

export const profileBadges: Record<string, string> = {
  coding: '编码 AI',
  research: '调研 AI',
  review: '审查 AI',
  general: '通用 AI',
};

export const tierBadges: Record<string, string> = {
  fast: '⚡极速',
  balanced: '⚖️均衡',
  strong: '🧠强力',
};

export interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/**
 * Generates an RFC 4122 UUIDv4 request identifier, falling back cleanly when
 * `crypto.randomUUID` is unavailable in non-HTTPS browser contexts.
 */
export function makeRequestId(cryptoObj: CryptoLike | undefined = typeof crypto !== 'undefined' ? crypto : undefined): string {
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

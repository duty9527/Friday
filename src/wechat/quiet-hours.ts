import { sanitizeImError } from '../im/types.js';
import type { QuietHoursConfig, RejectedStrangerView } from '../view.js';

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Parse `"HH:mm"` into minutes since local midnight (`0..1439`). */
export function parseQuietHm(value: string): number | undefined {
  const match = HHMM_RE.exec(value.trim());
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatHm(minutes: number): string {
  const hh = String(Math.floor(minutes / 60) % 24).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Validate and normalize quiet-hours config. Returns undefined if cleared or omitted. */
export function normalizeQuietHours(input: unknown): QuietHoursConfig | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('quietHours 配置格式无效');
  }
  const obj = input as Record<string, unknown>;
  const enabled = Boolean(obj.enabled);
  const startRaw = typeof obj.start === 'string' && obj.start.trim() ? obj.start.trim() : '23:00';
  const endRaw = typeof obj.end === 'string' && obj.end.trim() ? obj.end.trim() : '07:00';
  const startMin = parseQuietHm(startRaw);
  const endMin = parseQuietHm(endRaw);
  if (startMin === undefined || endMin === undefined) {
    throw new Error('免打扰时间格式无效，请使用 HH:mm（例如 23:00）');
  }
  return {
    enabled,
    start: formatHm(startMin),
    end: formatHm(endMin),
  };
}

/** Return true if `now` falls inside the configured quiet hours window (`start === end` disables). */
export function isInQuietHours(config?: QuietHoursConfig, now = new Date()): boolean {
  if (!config?.enabled) return false;
  const startMin = parseQuietHm(config.start);
  const endMin = parseQuietHm(config.end);
  if (startMin === undefined || endMin === undefined || startMin === endMin) {
    return false;
  }
  const currentMin = now.getHours() * 60 + now.getMinutes();
  if (startMin < endMin) {
    return currentMin >= startMin && currentMin < endMin;
  }
  return currentMin >= startMin || currentMin < endMin;
}

/** Return the epoch ms at which the active quiet window ends (with +1000ms margin). */
export function nextQuietHoursEndMs(config: QuietHoursConfig, now = new Date()): number {
  const endMin = parseQuietHm(config.end);
  if (endMin === undefined) return now.getTime() + 60_000;
  const endHour = Math.floor(endMin / 60);
  const endMinute = endMin % 60;
  const target = new Date(now.getTime());
  target.setHours(endHour, endMinute, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime() + 1_000;
}

/** Record or increment a rejected stranger attempt, bounded to the most recent `maxEntries`. */
export function recordRejectedStranger(
  existing: ReadonlyArray<RejectedStrangerView> | undefined,
  entry: { senderId: string; senderName?: string; text?: string; at?: number },
  maxEntries = 20,
): RejectedStrangerView[] {
  const now = entry.at ?? Date.now();
  const preview = entry.text
    ? sanitizeImError(entry.text).replace(/\s+/g, ' ').trim().slice(0, 80) || undefined
    : undefined;

  const list = [...(existing ?? [])];
  const idx = list.findIndex(item => item.senderId === entry.senderId);
  if (idx >= 0) {
    const prev = list[idx]!;
    const updated: RejectedStrangerView = {
      senderId: prev.senderId,
      ...(entry.senderName?.trim()
        ? { senderName: entry.senderName.trim().slice(0, 80) }
        : prev.senderName
          ? { senderName: prev.senderName }
          : {}),
      ...(preview ? { lastText: preview } : prev.lastText ? { lastText: prev.lastText } : {}),
      count: prev.count + 1,
      firstSeenAt: prev.firstSeenAt,
      lastSeenAt: now,
    };
    list.splice(idx, 1);
    list.unshift(updated);
  } else {
    list.unshift({
      senderId: entry.senderId,
      ...(entry.senderName?.trim() ? { senderName: entry.senderName.trim().slice(0, 80) } : {}),
      ...(preview ? { lastText: preview } : {}),
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }

  return list
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .slice(0, Math.max(1, maxEntries));
}

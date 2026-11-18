import { createConnection } from 'node:net';
import { join } from 'node:path';

export const REQUEST_LIMIT = 64 * 1024;
export const RESPONSE_LIMIT = 4 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const LONG_REQUEST_TIMEOUT_MS = 90_000;
export const PLUGIN_REQUEST_TIMEOUT_MS = 305_000;

const LONG_COMMANDS = new Set([
  'voice-enroll-start',
  'memory-search',
  'memory-save',
  'im-telegram-quick',
  'im-telegram-sync-commands',
  'model-configure',
  'model-probe',
  'model-fetch',
  'submit',
  'im-test',
  'im-webhook',
]);

export const socketPath = (home: string) => join(home, 'service.sock');
export interface Response { ok: boolean; result?: unknown; error?: string }
export interface RequestOptions { timeoutMs?: number }

export function text(value: unknown, name: string, max = 16_384): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters`);
  return value;
}

export function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Expected an integer from ${min} to ${max}`);
  return value;
}

export function resolveRequestTimeoutMs(message: unknown, options?: RequestOptions): number {
  if (options?.timeoutMs !== undefined) {
    if (typeof options.timeoutMs !== 'number' || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive finite number');
    }
    return options.timeoutMs;
  }
  const command = message && typeof message === 'object' && 'command' in message
    && typeof (message as { command?: unknown }).command === 'string'
    ? (message as { command: string }).command
    : undefined;
  if (command === 'plugin-run') return PLUGIN_REQUEST_TIMEOUT_MS;
  return command && LONG_COMMANDS.has(command) ? LONG_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS;
}

export async function request(home: string, message: unknown, options?: RequestOptions): Promise<unknown> {
  const encoded = JSON.stringify(message) + '\n';
  if (Buffer.byteLength(encoded) > REQUEST_LIMIT) throw new Error('Request is too large');
  const timeoutMs = resolveRequestTimeoutMs(message, options);
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(home));
    let buffer = Buffer.alloc(0);
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('Service request timed out')));
    socket.on('error', fail);
    socket.on('connect', () => socket.write(encoded));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > RESPONSE_LIMIT) { fail(new Error('Response too large')); return; }
      const newline = buffer.indexOf(10);
      if (newline === -1) return;
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as Response;
        settled = true;
        socket.destroy();
        if (!response.ok) reject(new Error(response.error ?? 'Service request failed'));
        else resolve(response.result);
      } catch { fail(new Error('Invalid service response')); }
    });
    socket.on('end', () => { if (!settled && !buffer.includes(10)) fail(new Error('Service closed without a response')); });
    socket.on('close', () => { if (!settled) fail(new Error('Service closed without a response')); });
  });
}

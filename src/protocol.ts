import { createConnection } from 'node:net';
import { join } from 'node:path';

export const REQUEST_LIMIT = 64 * 1024;
export const RESPONSE_LIMIT = 4 * 1024 * 1024;
export const socketPath = (home: string) => join(home, 'service.sock');
export interface Response { ok: boolean; result?: unknown; error?: string }
export function text(value: unknown, name: string, max = 16_384): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be a non-empty string of at most ${max} characters`);
  return value;
}
export function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Expected an integer from ${min} to ${max}`);
  return value;
}
export async function request(home: string, message: unknown): Promise<unknown> {
  const encoded = JSON.stringify(message) + '\n';
  if (Buffer.byteLength(encoded) > REQUEST_LIMIT) throw new Error('Request is too large');
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(home));
    let buffer = Buffer.alloc(0);
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.setTimeout(15_000, () => fail(new Error('Service request timed out')));
    socket.on('error', fail);
    socket.on('connect', () => socket.write(encoded));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > RESPONSE_LIMIT) { fail(new Error('Response too large')); return; }
      if (!buffer.includes(10)) return;
      try {
        const response = JSON.parse(buffer.toString('utf8').split('\n')[0]!) as Response;
        socket.destroy();
        if (!response.ok) reject(new Error(response.error ?? 'Service request failed'));
        else resolve(response.result);
      } catch { fail(new Error('Invalid service response')); }
    });
    socket.on('end', () => { if (!buffer.includes(10)) fail(new Error('Service closed without a response')); });
  });
}

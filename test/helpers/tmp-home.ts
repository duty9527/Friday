import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Creates an isolated `0o700` temporary Friday home directory. */
export async function createTempHome(prefix = 'friday-'): Promise<string> {
  const dir = await mkdtemp(join(await realpath(tmpdir()), prefix));
  await chmod(dir, 0o700);
  return dir;
}

/** Creates a temporary Friday home directory, runs `fn(home)`, and removes it in `finally`. */
export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T>;
export async function withTempHome<T>(prefix: string, fn: (home: string) => Promise<T>): Promise<T>;
export async function withTempHome<T>(fn: (home: string) => Promise<T>, prefix?: string): Promise<T>;
export async function withTempHome<T>(
  prefixOrFn: string | ((home: string) => Promise<T>),
  fnOrPrefix?: ((home: string) => Promise<T>) | string,
): Promise<T> {
  const prefix = typeof prefixOrFn === 'string'
    ? prefixOrFn
    : (typeof fnOrPrefix === 'string' ? fnOrPrefix : 'friday-');
  const fn = typeof prefixOrFn === 'function'
    ? prefixOrFn
    : fnOrPrefix as (home: string) => Promise<T>;
  const home = await createTempHome(prefix);
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

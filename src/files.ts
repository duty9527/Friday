import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile, chmod, rm } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const FILE_LIMIT = 256 * 1024;
export const TOTAL_LIMIT = 1024 * 1024;
export interface InputFile { id: string; name: string; bytes: number; sha256: string }

export async function privateHome(path: string): Promise<string> {
  const home = resolve(path);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const stat = await lstat(home);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error('Data directory must be a real directory owned by the current user');
  }
  await chmod(home, 0o700);
  return realpath(home);
}

async function noSymlinkAncestors(path: string): Promise<void> {
  let current = path;
  while (current !== parse(current).root) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not accepted as inputs');
    current = dirname(current);
  }
}

export async function readRegular(path: string, limit = FILE_LIMIT): Promise<Buffer> {
  await noSymlinkAncestors(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('Only regular files are accepted');
    if (before.size > limit) throw new Error(`File exceeds ${limit} byte limit`);
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > limit) throw new Error(`File exceeds ${limit} byte limit`);
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('Input changed while creating snapshot; submit again');
    }
    const data = buffer.subarray(0, count);
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (data.includes(0)) throw new Error('Binary input is not supported');
    return data;
  } finally { await handle.close(); }
}

export async function snapshot(home: string, taskId: string, paths: string[]): Promise<InputFile[]> {
  if (paths.length < 1 || paths.length > 32) throw new Error('Provide between 1 and 32 input files');
  const root = join(home, 'tasks', taskId, 'inputs');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const files: InputFile[] = [];
  let total = 0;
  try {
    for (const [index, input] of paths.entries()) {
      const path = resolve(input);
      const data = await readRegular(path);
      total += data.length;
      if (total > TOTAL_LIMIT) throw new Error(`Total input exceeds ${TOTAL_LIMIT} byte limit`);
      const file = { id: `f${index}`, name: basename(path), bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
      await writeFile(join(root, file.id), data, { flag: 'wx', mode: 0o400 });
      files.push(file);
    }
    return files;
  } catch (error) {
    await rm(join(home, 'tasks', taskId), { recursive: true, force: true });
    throw error;
  }
}

export async function readSnapshot(home: string, taskId: string, file: InputFile): Promise<string> {
  if (!/^[a-f0-9-]{36}$/.test(taskId) || !/^f\d+$/.test(file.id)) throw new Error('Invalid snapshot identity');
  const bytes = await readRegular(join(home, 'tasks', taskId, 'inputs', file.id));
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Snapshot integrity check failed');
  return bytes.toString('utf8');
}

import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, writeFile, chmod, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
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

async function noSymlinkAncestors(path: string, stopAt?: string): Promise<void> {
  // Check raw path segments left-to-right BEFORE lexical resolution collapses "symlink/..".
  const absRaw = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  const rawRoot = parse(absRaw).root;
  const bound = stopAt ? resolve(stopAt) : undefined;
  const rawParts = absRaw.slice(rawRoot.length).split(/[\\/]+/).filter(Boolean);
  let rawCursor = rawRoot;
  let hitStopBound = !bound;
  for (const part of rawParts) {
    if (part === '.') continue;
    if (part === '..') {
      rawCursor = dirname(rawCursor);
      continue;
    }
    rawCursor = rawCursor.endsWith(sep) ? `${rawCursor}${part}` : `${rawCursor}${sep}${part}`;
    if (!hitStopBound && bound && (rawCursor === bound || rawCursor.startsWith(`${bound}${sep}`))) {
      hitStopBound = true;
    }
    if (hitStopBound && (await lstat(rawCursor)).isSymbolicLink()) {
      throw new Error('Symbolic links are not accepted as inputs');
    }
  }
  const fsRoot = parse(path).root;
  let current = resolve(path);
  while (current !== fsRoot) {
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Symbolic links are not accepted as inputs');
    if (bound && current === bound) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function readRegular(path: string, limit = FILE_LIMIT, stopAt?: string): Promise<Buffer> {
  await noSymlinkAncestors(path, stopAt);
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

async function expandInputs(paths: string[]): Promise<Array<{ path: string; name: string; root: string }>> {
  const files: Array<{ path: string; name: string; root: string }> = [];
  const seen = new Set<string>();
  let entries = 0;
  async function visit(path: string, root: string, depth: number): Promise<void> {
    if (++entries > 4096 || depth > 64) throw new Error('Directory scan limit exceeded (4096 entries / 64 levels)');
    await noSymlinkAncestors(path, depth === 0 ? undefined : root);
    const before = await lstat(path);
    if (seen.has(path)) return;
    seen.add(path);
    if (before.isFile()) {
      files.push({ path, root, name: path === root ? basename(path) : join(basename(root), relative(root, path)) });
      if (files.length > 32) throw new Error('Expanded input exceeds 32 file limit; choose a smaller directory');
      return;
    }
    if (!before.isDirectory()) throw new Error(`Only regular files and directories are accepted: ${path}`);
    const children: string[] = [];
    const directory = await opendir(path);
    for await (const child of directory) {
      if (children.length + entries >= 4096) throw new Error('Directory scan limit exceeded (4096 entries)');
      children.push(child.name);
    }
    children.sort();
    for (const child of children) await visit(join(path, child), root, depth + 1);
    await noSymlinkAncestors(path, depth === 0 ? undefined : root);
    const after = await lstat(path);
    if (after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`Directory changed while creating snapshot; submit again: ${path}`);
    }
  }
  for (const input of paths) {
    await noSymlinkAncestors(input);
    const path = resolve(input);
    await visit(path, path, 0);
  }
  if (!files.length) throw new Error('No regular files found in the authorized input paths');
  // Disambiguate colliding snapshot display names across distinct top-level inputs.
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.name, (counts.get(file.name) ?? 0) + 1);
  if ([...counts.values()].some(c => c > 1)) {
    const used = new Set<string>();
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      if ((counts.get(file.name) ?? 0) <= 1 && !used.has(file.name)) {
        used.add(file.name);
        continue;
      }
      let candidate = join(basename(dirname(file.root)), file.name);
      if (used.has(candidate)) {
        let seq = 2;
        while (used.has(`${seq}-${candidate}`)) seq++;
        candidate = `${seq}-${candidate}`;
      }
      file.name = candidate;
      used.add(candidate);
    }
  }
  return files;
}

export async function snapshot(home: string, taskId: string, paths: string[]): Promise<InputFile[]> {
  if (paths.length < 1 || paths.length > 32) throw new Error('Provide between 1 and 32 input paths (files or directories)');
  const root = join(home, 'tasks', taskId, 'inputs');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const files: InputFile[] = [];
  let total = 0;
  try {
    const inputs = await expandInputs(paths);
    for (const [index, input] of inputs.entries()) {
      let data: Buffer;
      try { data = await readRegular(input.path, FILE_LIMIT, input.root); }
      catch (error) { throw new Error(`Cannot read authorized input ${input.path}: ${error instanceof Error ? error.message : String(error)}`); }
      total += data.length;
      if (total > TOTAL_LIMIT) throw new Error(`Total input exceeds ${TOTAL_LIMIT} byte limit`);
      const file = { id: `f${index}`, name: input.name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') };
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
  const bytes = await readRegular(join(home, 'tasks', taskId, 'inputs', file.id), FILE_LIMIT, home);
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Snapshot integrity check failed');
  return bytes.toString('utf8');
}

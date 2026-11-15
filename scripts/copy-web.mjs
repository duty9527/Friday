import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcWeb = fileURLToPath(new URL('../src/web', import.meta.url));
const distWeb = fileURLToPath(new URL('../dist/web', import.meta.url));

function isSkipped(name) {
  if (name === '.DS_Store' || name === 'Thumbs.db') return true;
  if (/^tsconfig.*\.json$/i.test(name)) return true;
  return /\.(?:ts|tsx|mts|cts)$/i.test(name);
}

async function copyStaticTree(srcDir, dstDir) {
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      await copyStaticTree(srcPath, dstPath);
      continue;
    }
    if (!entry.isFile() || isSkipped(entry.name)) continue;
    await mkdir(dirname(dstPath), { recursive: true });
    await copyFile(srcPath, dstPath);
  }
}

await mkdir(distWeb, { recursive: true });
await copyStaticTree(srcWeb, distWeb);

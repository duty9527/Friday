import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcWeb = fileURLToPath(new URL('../src/web', import.meta.url));
const distWeb = fileURLToPath(new URL('../dist/web', import.meta.url));
const ALLOWED_STATIC_ASSET = /\.(?:html|css|png|woff2|webmanifest)$/i;
const FORBIDDEN_DIST_ASSET = /\.(?:map|txt)$/i;

async function copyStaticTree(srcDir, dstDir) {
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      await copyStaticTree(srcPath, dstPath);
      continue;
    }
    if (!entry.isFile() || (!ALLOWED_STATIC_ASSET.test(entry.name) && entry.name !== 'theme-boot.js')) continue;
    await mkdir(dirname(dstPath), { recursive: true });
    await copyFile(srcPath, dstPath);
  }
}

async function pruneForbiddenAssets(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const target = join(dir, entry.name);
    if (entry.isDirectory()) {
      await pruneForbiddenAssets(target);
      continue;
    }
    if (entry.isFile() && FORBIDDEN_DIST_ASSET.test(entry.name)) {
      await rm(target, { force: true });
    }
  }
}

await mkdir(distWeb, { recursive: true });
await pruneForbiddenAssets(distWeb);
await copyStaticTree(srcWeb, distWeb);

import { mkdir, copyFile } from 'node:fs/promises';
const target = new URL('../dist/web/', import.meta.url);
await mkdir(target, { recursive: true });
for (const name of ['index.html', 'mindmap.html', 'style.css', 'mindmap.css', 'plex-sans.woff2', 'plex-mono.woff2', 'logo.png', 'avatar.png', 'FONT-LICENSE.txt']) {
  await copyFile(new URL(`../src/web/${name}`, import.meta.url), new URL(name, target));
}

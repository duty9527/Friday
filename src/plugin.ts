import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { PluginActionSpec, PluginView } from './view.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type PluginManifest = PluginView;

export interface PluginRunResult {
  ok: boolean;
  plugin: string;
  action: string;
  notify: boolean;
  title?: string;
  message: string;
  data?: unknown;
}

const VALID_PLUGIN_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function pluginRoots(home: string): string[] {
  return [join(home, 'plugins'), join(REPO_ROOT, 'plugins')];
}

export function listPluginsSync(home: string): PluginManifest[] {
  const seen = new Set<string>();
  const manifests: PluginManifest[] = [];
  for (const root of pluginRoots(home)) {
    if (!existsSync(root)) continue;
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !VALID_PLUGIN_NAME.test(entry.name) || seen.has(entry.name)) continue;
      const dir = join(root, entry.name);
      const manifestPath = join(dir, 'plugin.json');
      const defaultEntry = join(dir, 'index.mjs');
      if (!existsSync(manifestPath) && !existsSync(defaultEntry)) continue;
      let raw: Record<string, unknown> = {};
      let manifestJson: string | undefined;
      if (existsSync(manifestPath)) {
        try {
          manifestJson = readFileSync(manifestPath, 'utf8');
          raw = JSON.parse(manifestJson) as Record<string, unknown>;
        } catch { /* ignore invalid manifest */ }
      }
      const entryFile = typeof raw.entry === 'string' && raw.entry.trim() ? raw.entry.trim() : 'index.mjs';
      const entryPath = join(dir, entryFile);
      if (!existsSync(entryPath)) continue;
      let sourceCode: string | undefined;
      try {
        sourceCode = readFileSync(entryPath, 'utf8').slice(0, 131_072);
      } catch { /* ignore read error */ }
      const actions = Array.isArray(raw.actions) ? raw.actions.map(a => String(a)) : ['status'];
      const actionSpecs: PluginActionSpec[] = Array.isArray(raw.actionSpecs)
        ? (raw.actionSpecs as Array<Record<string, unknown>>)
            .filter(item => item && typeof item.name === 'string')
            .map(item => ({
              name: String(item.name),
              label: typeof item.label === 'string' ? item.label : undefined,
              description: typeof item.description === 'string' ? item.description : undefined,
              defaultArgs: item.defaultArgs && typeof item.defaultArgs === 'object' && !Array.isArray(item.defaultArgs)
                ? item.defaultArgs as Record<string, unknown>
                : undefined,
            }))
        : actions.map(name => ({ name, defaultArgs: {} }));
      seen.add(entry.name);
      manifests.push({
        name: entry.name,
        title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : entry.name,
        description: typeof raw.description === 'string' ? raw.description.trim() : '',
        entry: entryFile,
        entryPath,
        dir,
        dataDir: join(home, 'plugins', entry.name),
        actions,
        actionSpecs,
        manifestJson,
        sourceCode,
      });
    }
  }
  return manifests;
}

export async function listPlugins(home: string): Promise<PluginManifest[]> {
  return listPluginsSync(home);
}

export async function runPlugin(
  home: string,
  name: string,
  action = 'status',
  args: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<PluginRunResult> {
  const cleanName = name.trim();
  if (!VALID_PLUGIN_NAME.test(cleanName)) {
    throw new Error(`Invalid plugin name: ${cleanName}`);
  }
  const plugins = listPluginsSync(home);
  const manifest = plugins.find(p => p.name === cleanName);
  if (!manifest) {
    throw new Error(`Plugin "${cleanName}" not found`);
  }
  const entryPath = manifest.entryPath;
  const dataDir = manifest.dataDir;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  const cleanEnv: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete cleanEnv[key];
  }
  cleanEnv.SUPER_AGENT_HOME = home;
  cleanEnv.PLUGIN_DATA_DIR = dataDir;

  const { stdout } = await execFileAsync(
    process.execPath,
    [entryPath, action, JSON.stringify(args)],
    {
      cwd: manifest.dir,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: cleanEnv,
    },
  );

  const trimmed = stdout.trim();
  if (!trimmed) {
    return { ok: true, plugin: cleanName, action, notify: false, message: '' };
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      ok: parsed.ok === undefined ? true : Boolean(parsed.ok),
      plugin: cleanName,
      action,
      notify: parsed.notify === undefined ? true : Boolean(parsed.notify),
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      message: typeof parsed.message === 'string' ? parsed.message : trimmed,
      data: parsed.data,
    };
  } catch {
    return {
      ok: true,
      plugin: cleanName,
      action,
      notify: true,
      message: trimmed,
    };
  }
}

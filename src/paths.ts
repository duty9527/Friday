import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Resolves the Friday home directory following strict precedence:
 * 1) explicit `--home` / argument if non-empty
 * 2) `FRIDAY_HOME` environment variable
 * 3) `SUPER_AGENT_HOME` legacy environment variable
 * 4) existing `~/.friday`
 * 5) existing `~/.super-agent` (host backwards compatibility)
 * 6) default `~/.friday`
 */
export function resolveFridayHome(explicitHome?: string): string {
  const explicit = explicitHome?.trim();
  if (explicit) return resolve(explicit);
  const fridayEnv = process.env.FRIDAY_HOME?.trim();
  if (fridayEnv) return resolve(fridayEnv);
  const legacyEnv = process.env.SUPER_AGENT_HOME?.trim();
  if (legacyEnv) return resolve(legacyEnv);
  const fridayDefault = resolve(homedir(), '.friday');
  if (existsSync(fridayDefault)) return fridayDefault;
  const legacyDefault = resolve(homedir(), '.super-agent');
  if (existsSync(legacyDefault)) return legacyDefault;
  return fridayDefault;
}

/**
 * Reads a non-empty environment variable, falling back from the primary
 * `FRIDAY_*` key to an optional legacy key.
 */
export function resolveEnv(fridayKey: string, legacyKey?: string): string | undefined {
  const primary = process.env[fridayKey]?.trim();
  if (primary) return primary;
  if (legacyKey) {
    const legacy = process.env[legacyKey]?.trim();
    if (legacy) return legacy;
  }
  return undefined;
}

/** Resolves an isolated per-plugin data directory under `<homeDir>/plugins/<pluginName>`. */
export function resolvePluginDataDir(homeDir: string, pluginName: string): string {
  return join(resolve(homeDir), 'plugins', pluginName);
}

/**
 * Ensures `<homeDir>/run` exists as a real `0o700` directory and returns its path.
 */
export function resolvePrivateRunDir(homeDir: string): string {
  const runDir = join(resolve(homeDir), 'run');
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(runDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Private run directory must be a real directory');
  }
  chmodSync(runDir, 0o700);
  return runDir;
}

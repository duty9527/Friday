import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolveFridayHome, resolvePrivateRunDir } from '../paths.js';

export interface XiaoaiSshTarget {
  id: string;        // e.g. 'oh2p' | 'lx06' | 'default'
  userHost: string;  // e.g. 'root@192.0.2.10'
  port?: number;
}

export type XiaoaiSshRunner = (
  target: XiaoaiSshTarget,
  remoteCommand: string,
  options?: { timeoutMs?: number; homeDir?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface XiaoaiApiOptions {
  prefix?: string;
  passthroughNative: boolean;
  kws: boolean;
  kwsDevice: string;
  kwsChime: boolean;
  speakerVerify?: boolean;
  speakerThreshold?: number;
}

export const SSH_POLL_COMMAND =
  '[ -L /tmp/mico_aivs_lab/instruction.log ] && rm -f /tmp/mico_aivs_lab/instruction.log; mkdir -p /tmp/mico_aivs_lab; tail -n 60 /tmp/mico_aivs_lab/instruction.log 2>/dev/null || true';

// BusyBox sleep may only accept integers; use usleep first and cap iterations at 2 to avoid 16s stalls.
export const SSH_PAUSE_COMMAND =
  'rm -f /tmp/friday_speaking; (ubus call mediaplayer player_play_operation \'{"action":"pause"}\' >/dev/null 2>&1 || mphelper pause >/dev/null 2>&1 || true); sh -c \'i=0; while [ $i -lt 2 ]; do usleep 250000 2>/dev/null || sleep 1; [ -f /tmp/friday_speaking ] && exit 0; ubus call mediaplayer player_play_operation "{\\"action\\":\\"pause\\"}" >/dev/null 2>&1 || mphelper pause >/dev/null 2>&1 || true; i=$((i+1)); done\' </dev/null >/dev/null 2>&1 &';

export const SSH_PLAY_STATUS_COMMAND = 'ubus call mediaplayer player_get_play_status 2>/dev/null || true';
const XIAOAI_WAKE_CHIME_PATH = '/usr/share/sound-vendor/AiNiRobot/wakeup_zai_01.wav';

let configuredSshHomeDir: string | undefined;
const activeControlMasters = new Map<string, { target: XiaoaiSshTarget; controlPath: string }>();

export function setDefaultXiaoaiSshHome(homeDir: string): void {
  configuredSshHomeDir = homeDir;
}

export function resolveXiaoaiSshControlPath(homeDir?: string): string {
  const baseHome = resolveFridayHome(homeDir ?? configuredSshHomeDir);
  const runDir = resolvePrivateRunDir(baseHome);
  return join(runDir, 'ssh-ctl-%C');
}

export function escapeShellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

export function buildXiaoaiSshArgs(
  target: XiaoaiSshTarget,
  remoteCommand: string,
  controlPath?: string,
): string[] {
  const controlArgs = controlPath
    ? [
        '-o', 'ControlMaster=auto',
        '-o', `ControlPath=${controlPath}`,
        '-o', 'ControlPersist=1800',
      ]
    : [
        '-o', 'ControlMaster=no',
        '-o', 'ControlPath=none',
      ];
  return [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=5',
    '-o', 'HostKeyAlgorithms=+ssh-rsa',
    '-o', 'PubkeyAcceptedKeyTypes=+ssh-rsa',
    ...controlArgs,
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    ...(target.port ? ['-p', String(target.port)] : []),
    target.userHost,
    remoteCommand,
  ];
}

function runSshOnce(
  target: XiaoaiSshTarget,
  remoteCommand: string,
  timeoutMs: number,
  controlPath?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const args = buildXiaoaiSshArgs(target, remoteCommand, controlPath);
    execFile('ssh', args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const errWithCode = error as Error & { code?: number | string };
        if (typeof errWithCode.code === 'number') {
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            code: errWithCode.code,
          });
          return;
        }
        reject(error);
        return;
      }
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        code: 0,
      });
    });
  });
}

export const defaultSshRunner: XiaoaiSshRunner = async (target, remoteCommand, options) => {
  const timeoutMs = options?.timeoutMs ?? 8_000;
  const startedAt = Date.now();
  let controlPath: string | undefined;
  try {
    controlPath = resolveXiaoaiSshControlPath(options?.homeDir);
    const trackKey = `${controlPath}\0${target.userHost}:${target.port ?? 22}`;
    activeControlMasters.set(trackKey, { target, controlPath });
  } catch (err) {
    console.warn(
      `[xiaoai-ssh] failed to prepare private ControlPath, falling back to non-multiplexed SSH: ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
    );
  }
  const first = await runSshOnce(target, remoteCommand, timeoutMs, controlPath);
  if (first.code === 255 && controlPath && Date.now() - startedAt < 2_000) {
    return runSshOnce(target, remoteCommand, timeoutMs, undefined);
  }
  return first;
};

/** Close persisted SSH ControlMaster sockets created during this process lifecycle. */
export async function closeXiaoaiSshConnections(): Promise<void> {
  const entries = [...activeControlMasters.values()];
  activeControlMasters.clear();
  await Promise.all(
    entries.map(({ target, controlPath }) =>
      new Promise<void>(resolve => {
        const args = [
          '-O', 'exit',
          '-o', `ControlPath=${controlPath}`,
          ...(target.port ? ['-p', String(target.port)] : []),
          target.userHost,
        ];
        execFile('ssh', args, { timeout: 2_000 }, () => resolve());
      }),
    ),
  );
}

function parseBoolParam(raw: string | null, fallback: boolean): boolean {
  if (raw === null) return fallback;
  const norm = raw.trim().toLowerCase();
  if (norm === '0' || norm === 'false' || norm === 'no' || norm === 'off') return false;
  if (norm === '1' || norm === 'true' || norm === 'yes' || norm === 'on') return true;
  return fallback;
}

export function parseXiaoaiApiOptions(apiBase?: string): XiaoaiApiOptions {
  const isSsh = Boolean(apiBase?.trim().startsWith('ssh://'));
  const defaults: XiaoaiApiOptions = {
    passthroughNative: true,
    kws: isSsh,
    kwsDevice: 'noop',
    kwsChime: true,
  };
  if (!apiBase) return defaults;
  const qIdx = apiBase.indexOf('?');
  if (qIdx < 0) return defaults;
  const params = new URLSearchParams(apiBase.slice(qIdx + 1));
  const prefix = params.get('prefix')?.trim() || undefined;
  const passthroughNative = parseBoolParam(params.get('passthrough'), true);
  const kws = parseBoolParam(params.get('kws'), isSsh);
  const rawDevice = params.get('kwsDevice')?.trim() || '';
  const kwsDevice = /^[a-zA-Z0-9_.:,-]+$/.test(rawDevice) ? rawDevice : 'noop';
  const kwsChime = parseBoolParam(params.get('kwsChime'), true);
  const speakerVerify = params.has('speakerVerify')
    ? parseBoolParam(params.get('speakerVerify'), true)
    : undefined;
  const rawThreshold = params.get('speakerThreshold')?.trim();
  const parsedThreshold = rawThreshold ? Number(rawThreshold) : Number.NaN;
  const speakerThreshold = Number.isFinite(parsedThreshold) && parsedThreshold >= 0.20 && parsedThreshold <= 0.90
    ? parsedThreshold
    : undefined;
  return {
    prefix,
    passthroughNative,
    kws,
    kwsDevice,
    kwsChime,
    ...(speakerVerify !== undefined ? { speakerVerify } : {}),
    ...(speakerThreshold !== undefined ? { speakerThreshold } : {}),
  };
}

export function parseXiaoaiSshTargets(apiBase?: string): XiaoaiSshTarget[] {
  const trimmed = apiBase?.trim();
  if (!trimmed || !trimmed.startsWith('ssh://')) return [];
  const withoutScheme = trimmed.slice('ssh://'.length);
  const qIdx = withoutScheme.indexOf('?');
  const hostsPart = qIdx >= 0 ? withoutScheme.slice(0, qIdx) : withoutScheme;
  const entries = hostsPart
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  if (entries.length === 0) return [];

  const targets: XiaoaiSshTarget[] = [];
  for (const entry of entries) {
    const eqIdx = entry.indexOf('=');
    const hasExplicitId = eqIdx > 0;
    const explicitId = hasExplicitId ? entry.slice(0, eqIdx).trim() : '';
    const addr = hasExplicitId ? entry.slice(eqIdx + 1).trim() : entry;
    if (!addr) continue;

    let userHost = addr;
    let port: number | undefined;
    const portMatch = /^(.+):(\d+)$/.exec(addr);
    if (portMatch && portMatch[1] && portMatch[2]) {
      const parsedPort = Number(portMatch[2]);
      if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
        userHost = portMatch[1].trim();
        port = parsedPort;
      }
    }
    if (!userHost) continue;

    const id = hasExplicitId
      ? explicitId
      : entries.length === 1
        ? 'default'
        : userHost;
    if (!id) continue;

    targets.push({
      id,
      userHost,
      ...(port !== undefined ? { port } : {}),
    });
  }
  return targets;
}

export function getXiaoaiWakeCacheFileName(greetingText: string): string {
  const hash = createHash('sha1').update(greetingText.trim()).digest('hex').slice(0, 10);
  return `wake_${hash}.audio`;
}

function buildWakeCacheStoreSnippet(greetingText: string, cacheFile: string): string {
  const qGreeting = `'${escapeShellSingleQuote(greetingText)}'`;
  return [
    `CF="$CDIR/${cacheFile}";`,
    `if [ ! -s "$CF" ] && [ -s "/tmp/friday_wake_cache/${cacheFile}" ]; then CF="/tmp/friday_wake_cache/${cacheFile}"; fi;`,
    'if [ ! -s "$CF" ] && [ -x /usr/bin/gen-tts ] && [ -r /usr/share/libubox/jshn.sh ]; then',
    `_res=$(/usr/bin/gen-tts ${qGreeting} 2>/dev/null || true);`,
    'if [ -n "$_res" ]; then',
    '_p=$(. /usr/share/libubox/jshn.sh; json_init; json_load "$_res" 2>/dev/null; json_get_var _info info; json_cleanup; json_init; json_load "$_info" 2>/dev/null; json_get_var _path path; json_cleanup; printf \'%s\' "$_path");',
    'if [ -n "$_p" ] && [ -s "$_p" ]; then mv -f "$_p" "$CF" 2>/dev/null || cp -f "$_p" "$CF" 2>/dev/null || true; rm -f "$_p" 2>/dev/null || true; fi;',
    'fi;',
    'fi;',
  ].join(' ');
}

export function buildXiaoaiWakeCommand(options?: { chime?: boolean; greetingText?: string }): string {
  const prepCmd = 'rm -f /tmp/friday_speaking';
  const pauseCmd = '((ubus -t 1 call mediaplayer player_play_operation \'{"action":"pause"}\' >/dev/null 2>&1 || mphelper pause >/dev/null 2>&1 || true) </dev/null >/dev/null 2>&1 &)';
  const fallbackPlay = `ubus -t 2 call qplayer play '{"play":"${XIAOAI_WAKE_CHIME_PATH}"}' >/dev/null 2>&1 || /usr/bin/miplayer -f '${XIAOAI_WAKE_CHIME_PATH}' </dev/null >/dev/null 2>&1 || true`;
  const ledCmd = 'tok="$$_$(date +%s)"; echo "$tok" >/tmp/friday_led_tok; (/bin/shut_led 2 >/dev/null 2>&1 || true); (/bin/show_led 1 >/dev/null 2>&1 || true); (sh -c \'sleep 15; [ "$(cat /tmp/friday_led_tok 2>/dev/null)" = "\'"$tok"\'" ] && /bin/shut_led 1 >/dev/null 2>&1 || true\' </dev/null >/dev/null 2>&1 &)';
  const cleanGreeting = options?.greetingText?.replace(/["\\$`\r\n]/g, '').trim();
  if (options?.chime === false) {
    return `${prepCmd}; ${ledCmd}; ${pauseCmd}`;
  }
  if (!cleanGreeting) {
    return `${prepCmd}; ${ledCmd}; ${pauseCmd}; (${fallbackPlay})`;
  }
  const cacheFile = getXiaoaiWakeCacheFileName(cleanGreeting);
  const playGreetingCmd = [
    '(',
    'CDIR=/data/friday_wake_cache;',
    'mkdir -p "$CDIR" 2>/dev/null || { CDIR=/tmp/friday_wake_cache; mkdir -p "$CDIR" 2>/dev/null || true; };',
    buildWakeCacheStoreSnippet(cleanGreeting, cacheFile),
    'WAVF="$CF.wav";',
    `if [ ! -s "$WAVF" ] && [ -s "/tmp/friday_wake_cache/${cacheFile}.wav" ]; then WAVF="/tmp/friday_wake_cache/${cacheFile}.wav"; fi;`,
    `if [ -s "$WAVF" ]; then (/usr/bin/aplay -D notify -q "$WAVF" </dev/null >/dev/null 2>&1 || /usr/bin/qplayer "$WAVF" </dev/null >/dev/null 2>&1 || /usr/bin/miplayer -f "$WAVF" </dev/null >/dev/null 2>&1 || true); elif [ -s "$CF" ]; then /usr/bin/miplayer -f "$CF" </dev/null >/dev/null 2>&1 || true; else ${fallbackPlay}; fi`,
    ')',
  ].join(' ');
  return `${prepCmd}; ${ledCmd}; ${pauseCmd}; ${playGreetingCmd}`;
}

export function buildXiaoaiWakePrewarmCommand(phrases: readonly string[]): string {
  const cleaned = [...new Set(phrases.map(p => p.replace(/["\\$`\r\n]/g, '').trim()).filter(Boolean))];
  if (cleaned.length === 0) {
    return 'true';
  }
  const steps = cleaned.map(phrase => buildWakeCacheStoreSnippet(phrase, getXiaoaiWakeCacheFileName(phrase)));
  return [
    'CDIR=/data/friday_wake_cache;',
    'mkdir -p "$CDIR" 2>/dev/null || { CDIR=/tmp/friday_wake_cache; mkdir -p "$CDIR" 2>/dev/null || exit 0; };',
    ...steps,
  ].join(' ');
}

export function buildXiaoaiLedCommand(mode: 'listen' | 'think' | 'off'): string {
  if (mode === 'listen') {
    return 'rm -f /tmp/friday_speaking; tok="listen_$$_$(date +%s)"; echo "$tok" >/tmp/friday_led_tok; (/bin/shut_led 2 >/dev/null 2>&1 || true); (/bin/show_led 1 >/dev/null 2>&1 || true); (sh -c \'sleep 12; [ "$(cat /tmp/friday_led_tok 2>/dev/null)" = "\'"$tok"\'" ] && /bin/shut_led 1 >/dev/null 2>&1 || true\' </dev/null >/dev/null 2>&1 &)';
  }
  if (mode === 'think') {
    return 'tok="think_$$_$(date +%s)"; echo "$tok" >/tmp/friday_led_tok; (/bin/shut_led 1 >/dev/null 2>&1 || true); (/bin/show_led 2 >/dev/null 2>&1 || true); (sh -c \'sleep 30; [ "$(cat /tmp/friday_led_tok 2>/dev/null)" = "\'"$tok"\'" ] && /bin/shut_led 2 >/dev/null 2>&1 || true\' </dev/null >/dev/null 2>&1 &)';
  }
  return 'rm -f /tmp/friday_led_tok; (/bin/shut_led 1 >/dev/null 2>&1 || true); (/bin/shut_led 2 >/dev/null 2>&1 || true)';
}

export async function setXiaoaiSpeakerLed(
  target: XiaoaiSshTarget,
  mode: 'listen' | 'think' | 'off',
  sshRunner?: XiaoaiSshRunner,
): Promise<void> {
  await (sshRunner ?? defaultSshRunner)(target, buildXiaoaiLedCommand(mode), { timeoutMs: 4_000 }).catch(err => {
    console.warn(`[xiaoai-ssh] LED (${mode}) failed for ${target.id}: ${err instanceof Error ? err.message : 'error'}`);
  });
}

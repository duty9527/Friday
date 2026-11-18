export interface PluginRunResult<T = Record<string, unknown>> {
  ok: boolean;
  notify?: boolean;
  title?: string;
  message?: string;
  data?: T;
  [key: string]: unknown;
}

export interface PluginActionResult {
  ok: boolean;
  notify?: boolean;
  title?: string;
  message?: string;
  data?: any;
  [key: string]: unknown;
}

export interface PluginExecutionContext {
  homeDir?: string;
  pluginDataDir?: string;
  dataDir?: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  getDecisionCredentials?: () => { apiKey: string; baseUrl?: string } | undefined;
  callPlugin?: (
    targetPlugin: string,
    action?: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<PluginRunResult>;
  nowFn?: () => number;
  [key: string]: unknown;
}

export interface VoiceFastpathRequest {
  text: string;
  channelId: string;
  platform: string;
  targetId?: string;
  senderId?: string;
  speakerId?: string;
  speakerName?: string;
  speakerRole?: 'owner' | 'member';
  allowedPlugins?: ReadonlySet<string> | readonly string[];
  explicitWake?: boolean;
  sessionState?: Record<string, unknown>;
}

export interface VoiceFastpathResult {
  handled: boolean;
  plugin?: string;
  action?: string;
  ok?: boolean;
  speech?: string;
  followUp?: boolean;
  followUpWaitMs?: number;
  sessionState?: Record<string, unknown> | null;
  clearSessionState?: boolean;
  data?: unknown;
}

export interface PluginPaths {
  homeDir: string;
  pluginDataDir: string;
  dataDir: string;
  configPath: string;
  [key: string]: string;
}

export interface SshTarget {
  id: string;
  userHost: string;
  port?: number;
}

export interface SshExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface SshBinaryExecResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

export interface SpeakerDiscoveryResult {
  target?: SshTarget;
  id: string;
  userHost: string;
  port?: number;
  source: 'args' | 'config' | 'env' | 'sqlite' | 'none';
  channelId?: string;
}

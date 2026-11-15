import { createHash, randomUUID } from 'node:crypto';
import type { ImInboundMessage } from '../im/types.js';
import type { ImChannelConfig } from '../store.js';
import {
  defaultSshRunner,
  parseXiaoaiApiOptions,
  parseXiaoaiSshTargets,
  SSH_PAUSE_COMMAND,
  SSH_POLL_COMMAND,
  type XiaoaiSshRunner,
  type XiaoaiSshTarget,
} from './ssh.js';
import { shouldInterceptXiaoaiQuery } from './utterance-utils.js';

export interface XiaoaiPollResult {
  messages: ImInboundMessage[];
  nextPollOffset?: number;
  nextSyncBuf?: string;
}

interface XiaoaiSshSyncState {
  mode: 'ssh';
  cursors: Record<string, string>;
}

export interface XiaoaiCloudSession {
  userId: string;
  serviceToken: string;
  ssecurity?: string;
  deviceId?: string;
  hardware?: string;
  accountId?: string;
}

interface XiaoaiCloudSyncState {
  mode: 'cloud';
  session: XiaoaiCloudSession;
}

export interface MinaDevice {
  deviceID: string;
  name?: string;
  alias?: string;
  hardware?: string;
  presence?: string;
  serialNumber?: string;
}

interface MinaConversationRecord {
  time: number;
  query: string;
  requestId?: string;
}

const DEFAULT_XIAOMI_ACCOUNT_BASE = 'https://account.xiaomi.com';
const DEFAULT_MINA_API_BASE = 'https://api2.mina.mi.com';
const DEFAULT_MINA_PROFILE_BASE = 'https://userprofile.mina.mi.com';

export function isXiaoaiPollable(channel: ImChannelConfig): boolean {
  return parseXiaoaiSshTargets(channel.apiBase).length > 0
    || Boolean(channel.accountId && channel.botToken);
}

export function parseXiaoaiWebhookPayload(channelId: string, rawBody: string): ImInboundMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody || '{}');
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const payload = parsed as Record<string, unknown>;

  const textCandidate = payload.text ?? payload.query ?? payload.content;
  let rawText = '';
  if (typeof textCandidate === 'string') {
    rawText = textCandidate.trim();
  } else if (textCandidate && typeof textCandidate === 'object' && !Array.isArray(textCandidate)) {
    const inner = (textCandidate as Record<string, unknown>).content;
    if (typeof inner === 'string') rawText = inner.trim();
  }
  if (!rawText) return undefined;

  const prefix = typeof payload.prefix === 'string' && payload.prefix.trim() ? payload.prefix.trim() : undefined;
  const passthroughNative = typeof payload.passthroughNative === 'boolean' ? payload.passthroughNative : undefined;
  const decision = shouldInterceptXiaoaiQuery(rawText, { prefix, passthroughNative });
  if (!decision.intercept || !decision.query) return undefined;

  const deviceId = typeof payload.deviceId === 'string' && payload.deviceId.trim()
    ? payload.deviceId.trim()
    : undefined;
  const targetField = typeof payload.target === 'string' && payload.target.trim()
    ? payload.target.trim()
    : undefined;
  const senderIdField = typeof payload.senderId === 'string' && payload.senderId.trim()
    ? payload.senderId.trim()
    : undefined;
  const senderId = senderIdField ?? deviceId ?? targetField ?? 'xiaoai-speaker';
  const target = deviceId ?? targetField ?? senderId;
  const senderName = typeof payload.senderName === 'string' && payload.senderName.trim()
    ? payload.senderName.trim()
    : undefined;
  const rawExternalId = payload.msgId ?? payload.id;
  const externalId = typeof rawExternalId === 'string' && rawExternalId.trim()
    ? rawExternalId.trim()
    : typeof rawExternalId === 'number' && Number.isFinite(rawExternalId)
      ? String(rawExternalId)
      : randomUUID();
  const replyWebhook = typeof payload.replyWebhook === 'string' && payload.replyWebhook.trim()
    ? payload.replyWebhook.trim()
    : undefined;

  return {
    channelId,
    externalId,
    senderId,
    ...(senderName ? { senderName } : {}),
    target,
    text: decision.query,
    ...(replyWebhook ? { replyWebhook } : {}),
  };
}

function parseSshInstructionLine(line: string): { cursorId: string; rawText: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const lineHash = createHash('sha256').update(trimmed).digest('hex').slice(0, 24);

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        const header = obj.header && typeof obj.header === 'object' && !Array.isArray(obj.header)
          ? (obj.header as Record<string, unknown>)
          : undefined;
        const payload = obj.payload && typeof obj.payload === 'object' && !Array.isArray(obj.payload)
          ? (obj.payload as Record<string, unknown>)
          : undefined;

        let rawText = '';
        if (header && typeof header.namespace === 'string') {
          if (
            header.namespace === 'SpeechRecognizer'
            && header.name === 'RecognizeResult'
            && payload?.is_final !== false
          ) {
            const results = Array.isArray(payload?.results) ? payload.results : undefined;
            const first = results?.[0];
            if (first && typeof first === 'object' && !Array.isArray(first)) {
              const textVal = (first as Record<string, unknown>).text;
              if (typeof textVal === 'string') rawText = textVal.trim();
            }
          }
        } else {
          const candidate = obj.query ?? obj.text ?? obj.asr;
          if (typeof candidate === 'string') rawText = candidate.trim();
        }

        if (!rawText) return undefined;
        const headerId = typeof header?.id === 'string' && header.id.trim() ? header.id.trim() : undefined;
        const tsVal = obj.timestamp !== undefined && obj.timestamp !== null && String(obj.timestamp).trim()
          ? String(obj.timestamp).trim()
          : undefined;
        return { cursorId: headerId ?? tsVal ?? lineHash, rawText };
      }
    } catch {
      // Fallback to plain-text line handling
    }
  }

  return { cursorId: lineHash, rawText: trimmed };
}

function parseSshSyncState(syncBuf?: string): Record<string, string> {
  if (!syncBuf) return {};
  try {
    const parsed = JSON.parse(syncBuf) as Partial<XiaoaiSshSyncState>;
    if (parsed.mode === 'ssh' && parsed.cursors && typeof parsed.cursors === 'object') {
      const cursors: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.cursors)) {
        if (typeof v === 'string') cursors[k] = v;
      }
      return cursors;
    }
  } catch {
    // Ignore malformed syncBuf
  }
  return {};
}

async function pollSshTargets(
  channel: ImChannelConfig,
  targets: XiaoaiSshTarget[],
  sshRunner: XiaoaiSshRunner,
): Promise<XiaoaiPollResult> {
  const apiOptions = parseXiaoaiApiOptions(channel.apiBase);
  const prevCursors = parseSshSyncState(channel.syncBuf);
  const nextCursors: Record<string, string> = { ...prevCursors };
  const messages: ImInboundMessage[] = [];
  let succeededCount = 0;
  let lastError: unknown;

  for (const target of targets) {
    let stdout = '';
    try {
      const res = await sshRunner(target, SSH_POLL_COMMAND, { timeoutMs: 8_000 });
      if (res.code !== 0) {
        throw new Error(res.stderr.trim() || `SSH exit code ${res.code}`);
      }
      stdout = res.stdout;
      succeededCount++;
    } catch (error) {
      lastError = error;
      continue;
    }

    const entries = stdout
      .split(/\r?\n/)
      .map(parseSshInstructionLine)
      .filter((entry): entry is { cursorId: string; rawText: string } => Boolean(entry));

    const hasBaseline = Object.prototype.hasOwnProperty.call(prevCursors, target.id);
    if (!hasBaseline) {
      const lastEntry = entries.at(-1);
      nextCursors[target.id] = lastEntry ? lastEntry.cursorId : '';
      continue;
    }

    const prevCursor = prevCursors[target.id] ?? '';
    let newEntries: Array<{ cursorId: string; rawText: string }>;
    if (!prevCursor) {
      newEntries = entries;
    } else {
      const idx = entries.map(e => e.cursorId).lastIndexOf(prevCursor);
      newEntries = idx >= 0 ? entries.slice(idx + 1) : entries;
    }

    if (entries.length > 0) {
      const lastEntry = entries.at(-1);
      if (lastEntry) nextCursors[target.id] = lastEntry.cursorId;
    }

    let pausedThisSpeaker = false;
    for (const entry of newEntries) {
      const decision = shouldInterceptXiaoaiQuery(entry.rawText, apiOptions);
      if (!decision.intercept || !decision.query) continue;

      if (!pausedThisSpeaker) {
        pausedThisSpeaker = true;
        await sshRunner(target, SSH_PAUSE_COMMAND, { timeoutMs: 4_000 }).catch(err => {
          console.warn(`[xiaoai-poll] pause failed on ${target.id}: ${err instanceof Error ? err.message : 'error'}`);
        });
      }
      messages.push({
        channelId: channel.id,
        externalId: `${target.id}:${entry.cursorId}`,
        senderId: target.id,
        senderName: target.id,
        target: target.id,
        text: decision.query,
      });
    }
  }

  if (succeededCount === 0 && lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  const nextSyncBuf = JSON.stringify({ mode: 'ssh', cursors: nextCursors } satisfies XiaoaiSshSyncState);
  return {
    messages,
    ...(nextSyncBuf !== channel.syncBuf ? { nextSyncBuf } : {}),
  };
}

export function getCloudBases(apiBase?: string): { accountBase: string; minaBase: string; profileBase: string } {
  const trimmed = apiBase?.trim();
  if (trimmed && /^https?:\/\//i.test(trimmed)) {
    const base = trimmed.replace(/\/+$/, '');
    return {
      accountBase: `${base}/account`,
      minaBase: `${base}/mina`,
      profileBase: `${base}/profile`,
    };
  }
  return {
    accountBase: DEFAULT_XIAOMI_ACCOUNT_BASE,
    minaBase: DEFAULT_MINA_API_BASE,
    profileBase: DEFAULT_MINA_PROFILE_BASE,
  };
}

function parseXiaomiJsonText(rawText: string): Record<string, unknown> {
  const cleaned = rawText.replace(/^&&&START&&&/, '').trim();
  const parsed = JSON.parse(cleaned || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function parseSetCookiePairs(headers: Headers): Record<string, string> {
  const pairs: Record<string, string> = {};
  const list = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : (headers.get('set-cookie') ? [headers.get('set-cookie') as string] : []);
  for (const rawCookie of list) {
    const firstPart = rawCookie.split(';')[0]?.trim();
    if (!firstPart) continue;
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = firstPart.slice(0, eqIdx).trim();
    const val = firstPart.slice(eqIdx + 1).trim();
    if (key) pairs[key] = val;
  }
  return pairs;
}

function parseTokenJson(botToken?: string, accountId?: string): XiaoaiCloudSession | undefined {
  const trimmed = botToken?.trim();
  if (!trimmed || !trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const serviceToken = typeof parsed.serviceToken === 'string' ? parsed.serviceToken.trim() : '';
    const userId = typeof parsed.userId === 'string'
      ? parsed.userId.trim()
      : typeof parsed.userId === 'number'
        ? String(parsed.userId)
        : (accountId?.trim() ?? '');
    if (!serviceToken || !userId) return undefined;
    return {
      userId,
      serviceToken,
      ...(typeof parsed.ssecurity === 'string' && parsed.ssecurity.trim()
        ? { ssecurity: parsed.ssecurity.trim() }
        : {}),
      ...(typeof parsed.deviceId === 'string' && parsed.deviceId.trim()
        ? { deviceId: parsed.deviceId.trim() }
        : {}),
      ...(typeof parsed.hardware === 'string' && parsed.hardware.trim()
        ? { hardware: parsed.hardware.trim() }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function parseCachedCloudSession(syncBuf?: string, accountId?: string): XiaoaiCloudSession | undefined {
  if (!syncBuf) return undefined;
  try {
    const parsed = JSON.parse(syncBuf) as Partial<XiaoaiCloudSyncState>;
    if (parsed.mode === 'cloud' && parsed.session?.userId && parsed.session?.serviceToken) {
      if (parsed.session.accountId && accountId && parsed.session.accountId !== accountId) {
        return undefined;
      }
      return parsed.session;
    }
  } catch {
    // Ignore malformed syncBuf
  }
  return undefined;
}

async function loginXiaomiCloud(
  accountId: string,
  password: string,
  accountBase: string,
  minaBase: string,
  fetchFn: typeof fetch,
): Promise<XiaoaiCloudSession> {
  const step1Url = `${accountBase}/pass/serviceLogin?sid=micoapi&_json=true`;
  const step1Res = await fetchFn(step1Url, {
    method: 'GET',
    signal: AbortSignal.timeout(15_000),
  });
  if (!step1Res.ok) {
    throw new Error(`小米账号 serviceLogin 失败: HTTP ${step1Res.status}`);
  }
  const step1Cookies = parseSetCookiePairs(step1Res.headers);
  const step1Data = parseXiaomiJsonText(await step1Res.text());

  const pwdHash = createHash('md5').update(password).digest('hex').toUpperCase();
  const authForm = new URLSearchParams({
    qs: typeof step1Data.qs === 'string' ? step1Data.qs : '%3Fsid%3Dmicoapi%26_json%3Dtrue',
    sid: typeof step1Data.sid === 'string' ? step1Data.sid : 'micoapi',
    _json: 'true',
    callback: typeof step1Data.callback === 'string' ? step1Data.callback : `${minaBase}/sts`,
    user: accountId,
    hash: pwdHash,
    _sign: typeof step1Data._sign === 'string' ? step1Data._sign : '',
  });
  const step1CookieStr = Object.entries(step1Cookies).map(([k, v]) => `${k}=${v}`).join('; ');

  const step2Res = await fetchFn(`${accountBase}/pass/serviceLoginAuth2`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(step1CookieStr ? { cookie: step1CookieStr } : {}),
    },
    body: authForm.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!step2Res.ok) {
    throw new Error(`小米账号 serviceLoginAuth2 失败: HTTP ${step2Res.status}`);
  }
  const step2Data = parseXiaomiJsonText(await step2Res.text());
  const code = step2Data.code !== undefined ? Number(step2Data.code) : 0;
  if (code !== 0) {
    const desc = typeof step2Data.desc === 'string' ? step2Data.desc : `code=${code}`;
    throw new Error(`小米账号登录失败: ${desc}`);
  }
  if (typeof step2Data.notificationUrl === 'string' && step2Data.notificationUrl && !step2Data.location && !step2Data.serviceToken) {
    throw new Error('小米账号需要二次验证，请改用 JSON Token 或关闭小号风控验证');
  }

  const userId = step2Data.userId !== undefined && step2Data.userId !== null
    ? String(step2Data.userId)
    : accountId;
  const ssecurity = typeof step2Data.ssecurity === 'string' ? step2Data.ssecurity : undefined;

  let serviceToken = typeof step2Data.serviceToken === 'string' ? step2Data.serviceToken.trim() : '';
  if (!serviceToken && typeof step2Data.location === 'string' && step2Data.location.trim()) {
    const rawLocation = step2Data.location.trim();
    const stsUrl = /^https?:\/\//i.test(rawLocation)
      ? rawLocation
      : `${minaBase.replace(/\/mina$/, '')}${rawLocation.startsWith('/') ? '' : '/'}${rawLocation}`;
    const stsRes = await fetchFn(stsUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (!stsRes.ok && stsRes.status >= 400) {
      throw new Error(`小米 login_sts 失败: HTTP ${stsRes.status}`);
    }
    const stsCookies = parseSetCookiePairs(stsRes.headers);
    if (stsCookies.serviceToken) {
      serviceToken = stsCookies.serviceToken;
    } else {
      try {
        const stsData = parseXiaomiJsonText(await stsRes.text());
        if (typeof stsData.serviceToken === 'string') {
          serviceToken = stsData.serviceToken.trim();
        }
      } catch {
        // Non-JSON response without serviceToken cookie
      }
    }
  }

  if (!serviceToken) {
    throw new Error('小米账号登录未返回 serviceToken');
  }

  return {
    userId,
    serviceToken,
    ...(ssecurity ? { ssecurity } : {}),
    accountId,
  };
}

export async function resolveCloudSession(
  channel: ImChannelConfig,
  accountBase: string,
  minaBase: string,
  fetchFn: typeof fetch,
  forceRefresh = false,
): Promise<{ session: XiaoaiCloudSession; syncBufToSave?: string; isPasswordAuth: boolean }> {
  const tokenSession = parseTokenJson(channel.botToken, channel.accountId);
  if (tokenSession) {
    return { session: tokenSession, isPasswordAuth: false };
  }

  if (!channel.accountId || !channel.botToken) {
    throw new Error('小米云模式缺少 accountId 或 botToken');
  }

  if (!forceRefresh) {
    const cached = parseCachedCloudSession(channel.syncBuf, channel.accountId);
    if (cached) {
      return { session: cached, isPasswordAuth: true };
    }
  }

  const session = await loginXiaomiCloud(channel.accountId, channel.botToken, accountBase, minaBase, fetchFn);
  const syncBufToSave = JSON.stringify({ mode: 'cloud', session } satisfies XiaoaiCloudSyncState);
  return { session, syncBufToSave, isPasswordAuth: true };
}

function buildMinaCookie(session: XiaoaiCloudSession, deviceId?: string): string {
  const parts = [
    `userId=${session.userId}`,
    `serviceToken=${session.serviceToken}`,
  ];
  if (deviceId) parts.push(`deviceId=${deviceId}`);
  parts.push('sn=');
  return parts.join('; ');
}

export async function fetchMinaDeviceList(
  minaBase: string,
  session: XiaoaiCloudSession,
  fetchFn: typeof fetch,
): Promise<{ devices: MinaDevice[]; unauthorized: boolean }> {
  const requestId = `friday_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const url = `${minaBase}/admin/v2/device_list?master=0&requestId=${encodeURIComponent(requestId)}`;
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { cookie: buildMinaCookie(session) },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) {
    return { devices: [], unauthorized: true };
  }
  if (!res.ok) {
    throw new Error(`MiNA device_list 失败: HTTP ${res.status}`);
  }
  const body = await res.json() as { code?: number; message?: string; data?: unknown };
  if (body.code !== undefined && body.code !== 0) {
    throw new Error(`MiNA device_list 业务错误: ${body.message ?? `code=${body.code}`}`);
  }
  const list = Array.isArray(body.data) ? body.data : [];
  const devices: MinaDevice[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const deviceID = typeof obj.deviceID === 'string'
      ? obj.deviceID
      : typeof obj.deviceId === 'string'
        ? obj.deviceId
        : '';
    if (!deviceID) continue;
    devices.push({
      deviceID,
      name: typeof obj.name === 'string' ? obj.name : undefined,
      alias: typeof obj.alias === 'string' ? obj.alias : undefined,
      hardware: typeof obj.hardware === 'string' ? obj.hardware : undefined,
      presence: typeof obj.presence === 'string' ? obj.presence : undefined,
      serialNumber: typeof obj.serialNumber === 'string' ? obj.serialNumber : undefined,
    });
  }
  return { devices, unauthorized: false };
}

export function selectTargetMinaDevices(
  devices: MinaDevice[],
  preferredTarget?: string,
  sessionDeviceId?: string,
): MinaDevice[] {
  const wanted = preferredTarget?.trim() || sessionDeviceId?.trim();
  if (wanted) {
    const matched = devices.filter(
      d => d.deviceID === wanted || d.name === wanted || d.alias === wanted || d.serialNumber === wanted,
    );
    if (matched.length > 0) return matched;
  }
  const online = devices.filter(d => !d.presence || d.presence.toLowerCase() === 'online');
  return online.length > 0 ? online : devices.slice(0, 1);
}

async function fetchMinaConversations(
  profileBase: string,
  session: XiaoaiCloudSession,
  device: MinaDevice,
  fetchFn: typeof fetch,
): Promise<{ records: MinaConversationRecord[]; unauthorized: boolean }> {
  const hardware = device.hardware ?? session.hardware ?? 'LX06';
  const url = `${profileBase}/device_profile/v2/conversation?source=dialogu&hardware=${encodeURIComponent(hardware)}&limit=5`;
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { cookie: buildMinaCookie(session, device.deviceID) },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) {
    return { records: [], unauthorized: true };
  }
  if (!res.ok) {
    throw new Error(`MiNA conversation 失败: HTTP ${res.status}`);
  }
  const body = await res.json() as { code?: number; message?: string; data?: unknown };
  if (body.code !== undefined && body.code !== 0) {
    throw new Error(`MiNA conversation 业务错误: ${body.message ?? `code=${body.code}`}`);
  }

  let dataObj: unknown = body.data;
  if (typeof dataObj === 'string') {
    try {
      dataObj = JSON.parse(dataObj);
    } catch {
      dataObj = undefined;
    }
  }

  let rawRecords: unknown[] = [];
  if (Array.isArray(dataObj)) {
    rawRecords = dataObj;
  } else if (dataObj && typeof dataObj === 'object') {
    const recs = (dataObj as Record<string, unknown>).records;
    if (Array.isArray(recs)) rawRecords = recs;
  }

  const records: MinaConversationRecord[] = [];
  for (const item of rawRecords) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const time = Number(obj.time ?? obj.timestamp ?? 0);
    const q = obj.query ?? obj.text;
    const query = typeof q === 'string' ? q.trim() : '';
    if (!Number.isFinite(time) || !query) continue;
    records.push({
      time,
      query,
      requestId: typeof obj.requestId === 'string' ? obj.requestId : undefined,
    });
  }
  return { records, unauthorized: false };
}

export async function callMinaRemoteUbus(
  minaBase: string,
  session: XiaoaiCloudSession,
  deviceId: string,
  path: string,
  method: string,
  message: string,
  fetchFn: typeof fetch,
): Promise<void> {
  const form = new URLSearchParams({
    deviceId,
    message,
    method,
    path,
    requestId: `friday_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
  });
  const res = await fetchFn(`${minaBase}/remote/ubus`, {
    method: 'POST',
    headers: {
      cookie: buildMinaCookie(session),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`MiNA /remote/ubus (${path}.${method}) 失败: HTTP ${res.status}`);
  }
  try {
    const data = await res.json() as { code?: number; message?: string };
    if (data.code !== undefined && data.code !== 0) {
      throw new Error(`MiNA /remote/ubus 业务错误: ${data.message ?? `code=${data.code}`}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('MiNA /remote/ubus')) throw err;
  }
}

async function pollCloudChannel(
  channel: ImChannelConfig,
  fetchFn: typeof fetch,
): Promise<XiaoaiPollResult> {
  const { accountBase, minaBase, profileBase } = getCloudBases(channel.apiBase);
  const apiOptions = parseXiaoaiApiOptions(channel.apiBase);

  let resolved = await resolveCloudSession(channel, accountBase, minaBase, fetchFn, false);
  let { devices, unauthorized } = await fetchMinaDeviceList(minaBase, resolved.session, fetchFn);
  if (unauthorized && resolved.isPasswordAuth) {
    resolved = await resolveCloudSession(channel, accountBase, minaBase, fetchFn, true);
    ({ devices, unauthorized } = await fetchMinaDeviceList(minaBase, resolved.session, fetchFn));
  }
  if (unauthorized) {
    throw new Error('小米云会话已过期或未授权');
  }

  const targetDevices = selectTargetMinaDevices(devices, channel.defaultTarget, resolved.session.deviceId);
  if (targetDevices.length === 0 && resolved.session.deviceId) {
    targetDevices.push({
      deviceID: resolved.session.deviceId,
      hardware: resolved.session.hardware,
    });
  }

  const isBaseline = channel.pollOffset === undefined;
  let maxTime = channel.pollOffset ?? 0;
  const collected: Array<{ device: MinaDevice; record: MinaConversationRecord }> = [];

  for (const device of targetDevices) {
    const conv = await fetchMinaConversations(profileBase, resolved.session, device, fetchFn);
    if (conv.unauthorized) {
      throw new Error('小米云对话历史接口未授权');
    }
    for (const record of conv.records) {
      if (isBaseline) {
        if (record.time > maxTime) maxTime = record.time;
      } else if (record.time > channel.pollOffset!) {
        if (record.time > maxTime) maxTime = record.time;
        collected.push({ device, record });
      }
    }
  }

  if (isBaseline) {
    return {
      messages: [],
      nextPollOffset: maxTime,
      ...(resolved.syncBufToSave ? { nextSyncBuf: resolved.syncBufToSave } : {}),
    };
  }

  collected.sort((a, b) => a.record.time - b.record.time);
  const messages: ImInboundMessage[] = [];
  const pausedDevices = new Set<string>();

  for (const { device, record } of collected) {
    const decision = shouldInterceptXiaoaiQuery(record.query, apiOptions);
    if (!decision.intercept || !decision.query) continue;

    if (!pausedDevices.has(device.deviceID)) {
      pausedDevices.add(device.deviceID);
      await callMinaRemoteUbus(
        minaBase,
        resolved.session,
        device.deviceID,
        'mediaplayer',
        'player_play_operation',
        '{"action":"pause"}',
        fetchFn,
      ).catch(err => {
        console.warn(`[xiaoai-cloud] pause failed for ${device.deviceID}: ${err instanceof Error ? err.message : 'error'}`);
      });
    }

    messages.push({
      channelId: channel.id,
      externalId: record.requestId || `${device.deviceID}:${record.time}`,
      senderId: device.deviceID,
      senderName: device.alias || device.name || device.deviceID,
      target: device.deviceID,
      text: decision.query,
    });
  }

  return {
    messages,
    ...(maxTime !== channel.pollOffset ? { nextPollOffset: maxTime } : {}),
    ...(resolved.syncBufToSave && resolved.syncBufToSave !== channel.syncBuf
      ? { nextSyncBuf: resolved.syncBufToSave }
      : {}),
  };
}

export async function pollXiaoaiChannel(
  channel: ImChannelConfig,
  deps?: { sshRunner?: XiaoaiSshRunner; fetchImpl?: typeof fetch },
): Promise<XiaoaiPollResult> {
  const sshTargets = parseXiaoaiSshTargets(channel.apiBase);
  if (sshTargets.length > 0) {
    return pollSshTargets(channel, sshTargets, deps?.sshRunner ?? defaultSshRunner);
  }
  if (channel.accountId && channel.botToken) {
    return pollCloudChannel(channel, deps?.fetchImpl ?? globalThis.fetch);
  }
  return { messages: [] };
}

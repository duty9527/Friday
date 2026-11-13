import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { ImChannelConfig } from './store.js';
import type { ImInboundMessage } from './im.js';

export interface XiaoaiSshTarget {
  id: string;        // 如 'oh2p' | 'lx06' | 'default'
  userHost: string;  // 如 'root@192.168.31.101'
  port?: number;
}

export type XiaoaiSshRunner = (
  target: XiaoaiSshTarget,
  remoteCommand: string,
  options?: { timeoutMs?: number; password?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface XiaoaiSendOptions {
  target?: string;
  replyToMessageId?: string;
  replyWebhook?: string;
  sshRunner?: XiaoaiSshRunner;
  fetchImpl?: typeof fetch;
}

export interface XiaoaiPollResult {
  messages: ImInboundMessage[];
  nextPollOffset?: number;
  nextSyncBuf?: string;
}

interface XiaoaiApiOptions {
  prefix?: string;
  passthroughNative: boolean;
}

interface XiaoaiSshSyncState {
  mode: 'ssh';
  cursors: Record<string, string>;
}

interface XiaoaiCloudSession {
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

interface MinaDevice {
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
const SSH_POLL_COMMAND = 'tail -n 20 /tmp/mico_aivs_lab/instruction.log 2>/dev/null || true';
const SSH_PAUSE_COMMAND =
  'ubus call mediaplayer player_play_operation \'{"action":"pause"}\' >/dev/null 2>&1 || mphelper pause >/dev/null 2>&1 || true';

const WECHAT_EMOJI_TAGS = new Set([
  '微笑', '撇嘴', '色', '发呆', '得意', '流泪', '害羞', '闭嘴', '睡', '大哭',
  '尴尬', '发怒', '调皮', '呲牙', '惊讶', '难过', '囧', '抓狂', '吐', '偷笑',
  '愉快', '白眼', '傲慢', '困', '惊恐', '憨笑', '悠闲', '咒骂', '疑问', '嘘',
  '晕', '衰', '骷髅', '敲打', '再见', '擦汗', '抠鼻', '鼓掌', '坏笑', '右哼哼',
  '左哼哼', '鄙视', '委屈', '快哭了', '阴险', '亲亲', '可怜', '笑脸', '生病', '脸红',
  '破涕为笑', '恐惧', '失望', '无语', '嘿哈', '捂脸', '奸笑', '机智', '皱眉', '耶',
  '吃瓜', '加油', '汗', '天啊', 'emm', '社会社会', '旺柴', '好的', '打脸', '哇',
  '翻白眼', '666', '让我看看', '叹气', '苦涩', '裂开', '嘴唇', '爱心', '心碎', '拥抱',
  '强', '弱', '握手', '胜利', '抱拳', '勾引', '拳头', 'ok', '合十', '啤酒',
  '咖啡', '蛋糕', '玫瑰', '凋谢', '菜刀', '西瓜', '炸弹', '便便', '月亮', '太阳',
  '庆祝', '礼物', '红包', '發', '福', '烟花', '爆竹', '猪头', '跳跳', '发抖',
  '转圈', '磕头', '回头', '跳绳', '激动', '街舞', '献吻', '左太极', '右太极', '哈欠',
  '吓', '酷', '饥饿', '疯了', '闪电', '刀', '足球', '饭', '示爱', '爱你', 'no',
  '差劲', '敬礼', '笑哭', '点赞', '比心', '大笑', '开心', '哭笑', '流汗', '斜眼笑',
  '狗头',
]);

const NATIVE_CONTROL_PATTERNS: RegExp[] = [
  /^(?:请)?(?:闭嘴|退下|停止(?:播放)?|暂停(?:播放)?|继续(?:播放)?|恢复播放|下一[首曲集]|上一[首曲集]|切歌|关机|静音|取消静音|打开静音)(?:吧|啦|一下)?$/,
  /^(?:把)?(?:音量|声音).{0,8}(?:调?[大小高低]|加|减)(?:[一]?点(?:儿)?|些|一些)?$/,
  /^(?:把)?(?:音量|声音)(?:调到|设为|设置成?|调成)?\s*\d{1,3}%?$/,
  /^(?:调[大小高低]|增大|减小|加大|降低)(?:一下|一点)?(?:音量|声音)$/,
  /^(?:再)?(?:大声|小声)[一]?点(?:儿)?$/,
  /^(?:最大|最小)(?:音量|声音)$/,
  /^(?:帮我)?(?:定|设|设置|建|添加|取消|关闭|删除|关掉)(?:一个|个)?.{0,14}闹钟$/,
  /^(?:定|设|设置|取消|关闭|删除)闹钟$/,
];

const defaultSshRunner: XiaoaiSshRunner = (target, remoteCommand, options) =>
  new Promise((resolve, reject) => {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=5',
      '-o', 'HostKeyAlgorithms=+ssh-rsa',
      '-o', 'PubkeyAcceptedKeyTypes=+ssh-rsa',
      ...(target.port ? ['-p', String(target.port)] : []),
      target.userHost,
      remoteCommand,
    ];
    execFile('ssh', args, { timeout: options?.timeoutMs ?? 8_000 }, (error, stdout, stderr) => {
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

function escapeShellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function parseXiaoaiApiOptions(apiBase?: string): XiaoaiApiOptions {
  if (!apiBase) return { passthroughNative: true };
  const qIdx = apiBase.indexOf('?');
  if (qIdx < 0) return { passthroughNative: true };
  const params = new URLSearchParams(apiBase.slice(qIdx + 1));
  const prefix = params.get('prefix')?.trim() || undefined;
  const pt = params.get('passthrough')?.trim().toLowerCase();
  const passthroughNative = pt === '0' || pt === 'false' ? false : true;
  return { prefix, passthroughNative };
}

function splitKeepingDelimiters(text: string, pattern: RegExp): string[] {
  const matches = text.match(pattern);
  if (!matches) return [];
  return matches.map(part => part.trim()).filter(Boolean);
}

export function sanitizeForSpeech(text: string): string {
  if (!text) return '';
  let result = text.replace(/\r\n?/g, '\n');

  // 1. Replace fenced code blocks with spoken notice
  result = result.replace(/```[\s\S]*?```/g, '（代码详情已同步至控制台）');
  result = result.replace(/```[\s\S]*$/g, '（代码详情已同步至控制台）');

  // 2. Replace markdown links [label](url) -> label, and bare URLs -> notice
  result = result.replace(/!?\[([^\]]*)\]\((?:[^()\s]+|\([^)]*\))+\)/g, (_m, label: string) => label);
  result = result.replace(/https?:\/\/[^\s，。！？；、（）【】《》"'<>]+/gi, '（链接见控制台）');

  // 3. Strip WeChat emoji tags and decorative Unicode emojis
  result = result.replace(/\[([^\[\]\s]{1,12})\]/g, (full, tag: string) =>
    WECHAT_EMOJI_TAGS.has(tag.toLowerCase()) ? '' : full,
  );
  result = result.replace(/\p{Extended_Pictographic}/gu, '');
  result = result.replace(/[\uFE0E\uFE0F\u200D\u20E3]/gu, '');

  // 4. Strip markdown headings, list prefixes, bold/italic markers, inline code backticks
  result = result.replace(/^#+\s*/gm, '');
  result = result.replace(/^[•\-*]\s+/gm, '');
  result = result.replace(/\*\*|__|\*/g, '');
  result = result.replace(/`/g, '');

  // 5. Collapse newlines into natural Chinese pauses without duplicating punctuation
  result = result.replace(/([。！？；：.!?;:，,、])[ \t]*\n+\s*/g, '$1');
  result = result.replace(/[ \t]*\n{2,}\s*/g, '。');
  result = result.replace(/[ \t]*\n\s*/g, '，');

  // 6. Normalize punctuation and whitespace
  result = result.replace(/[。]{2,}/g, '。');
  result = result.replace(/[，]{2,}/g, '，');
  result = result.replace(/[，,]([。！？；!?;])/g, '$1');
  result = result.replace(/([。！？；!?;])[，,]+/g, '$1');
  result = result.replace(/[ \t]+/g, ' ');
  result = result.replace(/\s*([。！？；：，、])\s*/g, '$1');

  return result.trim();
}

export function splitSpeechSegments(text: string, maxSegmentChars = 160): string[] {
  const clean = sanitizeForSpeech(text);
  if (!clean) return [];
  const limit = Math.max(1, Math.floor(maxSegmentChars));
  if (clean.length <= limit) return [clean];

  const sentences = splitKeepingDelimiters(clean, /[^。！？；!?;]*[。！？；!?;]+|[^。！？；!?;]+/g);
  const units: string[] = [];

  for (const sentence of sentences) {
    if (sentence.length <= limit) {
      units.push(sentence);
      continue;
    }
    const clauses = splitKeepingDelimiters(sentence, /[^，、,：:]*[，、,：:]+|[^，、,：:]+/g);
    for (const clause of clauses) {
      if (clause.length <= limit) {
        units.push(clause);
        continue;
      }
      for (let i = 0; i < clause.length; i += limit) {
        const slice = clause.slice(i, i + limit).trim();
        if (slice) units.push(slice);
      }
    }
  }

  const segments: string[] = [];
  let current = '';
  for (const unit of units) {
    if (!current) {
      current = unit;
      continue;
    }
    const needsSpace = /[A-Za-z0-9.!?;,:]$/.test(current) && /^[A-Za-z0-9]/.test(unit);
    const joiner = needsSpace ? ' ' : '';
    if (current.length + joiner.length + unit.length <= limit) {
      current = `${current}${joiner}${unit}`;
    } else {
      segments.push(current.trim());
      current = unit;
    }
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

export function shouldInterceptXiaoaiQuery(
  rawText: string,
  options?: { prefix?: string; passthroughNative?: boolean },
): { intercept: boolean; query: string } {
  const cleaned = rawText
    .trim()
    .replace(/^(?:小爱同学[\s，,。！!、：:]*)+/i, '')
    .trim();
  if (!cleaned) return { intercept: false, query: '' };

  const prefixRaw = options?.prefix?.trim();
  if (prefixRaw) {
    const prefixes = prefixRaw
      .split(/[,，]/)
      .map(p => p.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (prefixes.length > 0) {
      const lower = cleaned.toLowerCase();
      for (const prefix of prefixes) {
        if (!lower.startsWith(prefix.toLowerCase())) continue;
        const lastChar = prefix.slice(-1);
        const nextChar = cleaned.charAt(prefix.length);
        if (/[a-zA-Z]/.test(lastChar) && /[a-zA-Z]/.test(nextChar)) continue;
        const rest = cleaned
          .slice(prefix.length)
          .replace(/^[\s，,。！!、：:]+/, '')
          .trim();
        return { intercept: true, query: rest || cleaned.slice(0, prefix.length) };
      }
      return { intercept: false, query: '' };
    }
  }

  if (options?.passthroughNative !== false) {
    const normalized = cleaned.replace(/[。！!？?，,\s]+$/g, '').trim();
    if (!normalized) return { intercept: false, query: '' };
    if (NATIVE_CONTROL_PATTERNS.some(pattern => pattern.test(normalized))) {
      return { intercept: false, query: '' };
    }
  }

  return { intercept: true, query: cleaned };
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
        await sshRunner(target, SSH_PAUSE_COMMAND, { timeoutMs: 4_000 }).catch(() => {});
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

function getCloudBases(apiBase?: string): { accountBase: string; minaBase: string; profileBase: string } {
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

async function resolveCloudSession(
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

async function fetchMinaDeviceList(
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

function selectTargetMinaDevices(
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

async function callMinaRemoteUbus(
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
      ).catch(() => {});
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

export async function sendXiaoaiSpeech(
  channel: ImChannelConfig,
  rawText: string,
  options?: XiaoaiSendOptions,
): Promise<{ segments: string[]; mode: 'webhook' | 'ssh' | 'cloud' }> {
  const sshTargets = parseXiaoaiSshTargets(channel.apiBase);
  const fetchFn = options?.fetchImpl ?? globalThis.fetch;
  const webhookUrl = options?.replyWebhook?.trim()
    || (sshTargets.length === 0 ? channel.webhookUrl?.trim() : undefined);

  if (webhookUrl) {
    const segments = splitSpeechSegments(rawText);
    if (segments.length === 0) return { segments: [], mode: 'webhook' };

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (channel.botToken) {
      headers.authorization = `Bearer ${channel.botToken}`;
    }
    const res = await fetchFn(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        msgtype: 'tts',
        target: options?.target ?? channel.defaultTarget ?? 'default',
        text: segments.join(' '),
        segments,
        rawText,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`小爱 Webhook 发送失败: HTTP ${res.status}`);
    }
    return { segments, mode: 'webhook' };
  }

  if (sshTargets.length > 0) {
    const segments = splitSpeechSegments(rawText);
    if (segments.length === 0) return { segments: [], mode: 'ssh' };

    const requestedTarget = options?.target?.trim() || channel.defaultTarget?.trim();
    const matched = requestedTarget
      ? sshTargets.find(t => t.id === requestedTarget || t.userHost === requestedTarget)
      : undefined;
    const target = matched ?? sshTargets[0];
    if (!target) {
      throw new Error('小爱 SSH 目标列表为空');
    }

    const sshRunner = options?.sshRunner ?? defaultSshRunner;
    for (const seg of segments) {
      const jsonPayload = JSON.stringify({ text: seg, save: 0 });
      const cmd = `ubus call mibrain text_to_speech '${escapeShellSingleQuote(jsonPayload)}' >/dev/null 2>&1 || /usr/sbin/tts_play.sh '${escapeShellSingleQuote(seg)}'`;
      const res = await sshRunner(target, cmd, { timeoutMs: 12_000 });
      if (res.code !== 0) {
        throw new Error(res.stderr.trim() || `小爱 SSH TTS 失败 (exit=${res.code})`);
      }
    }
    return { segments, mode: 'ssh' };
  }

  if (channel.accountId && channel.botToken) {
    const segments = splitSpeechSegments(rawText);
    if (segments.length === 0) return { segments: [], mode: 'cloud' };

    const { accountBase, minaBase } = getCloudBases(channel.apiBase);
    const resolved = await resolveCloudSession(channel, accountBase, minaBase, fetchFn, false);
    let targetDeviceId = options?.target?.trim()
      || channel.defaultTarget?.trim()
      || resolved.session.deviceId;

    if (!targetDeviceId) {
      const { devices } = await fetchMinaDeviceList(minaBase, resolved.session, fetchFn);
      const selected = selectTargetMinaDevices(devices, undefined, undefined)[0];
      targetDeviceId = selected?.deviceID;
    }
    if (!targetDeviceId) {
      throw new Error('小米云模式下未找到可用的小爱音箱设备ID');
    }

    for (const seg of segments) {
      await callMinaRemoteUbus(
        minaBase,
        resolved.session,
        targetDeviceId,
        'mibrain',
        'text_to_speech',
        JSON.stringify({ text: seg, save: 0 }),
        fetchFn,
      );
    }
    return { segments, mode: 'cloud' };
  }

  throw new Error('小爱音箱通道未配置发送方式（需要 SSH 地址、webhookUrl 或小米云账号凭证）');
}

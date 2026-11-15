import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
  waitForCompletion?: boolean;
  sshRunner?: XiaoaiSshRunner;
  fetchImpl?: typeof fetch;
}

export interface XiaoaiPollResult {
  messages: ImInboundMessage[];
  nextPollOffset?: number;
  nextSyncBuf?: string;
}

export interface XiaoaiApiOptions {
  prefix?: string;
  passthroughNative: boolean;
  kws: boolean;
  kwsDevice: string;
  kwsChime: boolean;
  wakeWindowMs: number;
  speakerVerify?: boolean;
  speakerThreshold?: number;
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
const SSH_POLL_COMMAND =
  '[ -L /tmp/mico_aivs_lab/instruction.log ] && rm -f /tmp/mico_aivs_lab/instruction.log; mkdir -p /tmp/mico_aivs_lab; tail -n 60 /tmp/mico_aivs_lab/instruction.log 2>/dev/null || true';
const SSH_PAUSE_COMMAND =
  'rm -f /tmp/friday_speaking; (ubus call mediaplayer player_play_operation \'{"action":"pause"}\' >/dev/null 2>&1 || mphelper pause >/dev/null 2>&1 || true); sh -c \'i=0; while [ $i -lt 16 ]; do sleep 0.25 2>/dev/null || sleep 1; [ -f /tmp/friday_speaking ] && exit 0; ubus call mediaplayer player_play_operation "{\\"action\\":\\"pause\\"}" >/dev/null 2>&1 || mphelper pause >/dev/null 2>&1 || true; i=$((i+1)); done\' </dev/null >/dev/null 2>&1 &';

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
  /^(?:请)?(?:闭嘴|退下|停止(?:播放)?|暂停(?:播放)?|继续(?:播放)?|恢复播放|下一[首曲集]|上一[首曲集]|切歌|关机|静音|取消静音|打开静音)(?:吧|呗|啦|咯|呀|一下)?$/,
  /^(?:请|帮我|把)?(?:打开|关闭|关掉|开启|调亮|调暗).{1,15}(?:灯|空调|风扇|窗帘|插座|电视|加湿器|净化器|除湿机|扫地机|开关)(?:吧|啦|一下)?$/,
  /^(?:把)?(?:音量|声音).{0,8}(?:调?[大小高低]|加|减)(?:[一]?点(?:儿)?|些|一些)?$/,
  /^(?:把)?(?:音量|声音)(?:调到|设为|设置成?|调成)?\s*\d{1,3}%?$/,
  /^(?:调[大小高低]|增大|减小|加大|降低)(?:一下|一点)?(?:音量|声音)$/,
  /^(?:再)?(?:大声|小声)[一]?点(?:儿)?$/,
  /^(?:最大|最小)(?:音量|声音)$/,
  /^(?:帮我)?(?:定|设|设置|建|添加|取消|关闭|删除|关掉)(?:一个|个)?.{0,14}闹钟$/,
  /^(?:定|设|设置|取消|关闭|删除)闹钟$/,
];

function runSshOnce(
  target: XiaoaiSshTarget,
  remoteCommand: string,
  timeoutMs: number,
  useControlMaster: boolean,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const controlArgs = useControlMaster
      ? [
          '-o', 'ControlMaster=auto',
          '-o', 'ControlPath=/tmp/friday-xiaoai-%C',
          '-o', 'ControlPersist=600',
        ]
      : [
          '-o', 'ControlMaster=no',
          '-o', 'ControlPath=none',
        ];
    const args = [
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

const defaultSshRunner: XiaoaiSshRunner = async (target, remoteCommand, options) => {
  const timeoutMs = options?.timeoutMs ?? 8_000;
  const startedAt = Date.now();
  const first = await runSshOnce(target, remoteCommand, timeoutMs, true);
  if (first.code === 255 && Date.now() - startedAt < 2_000) {
    return runSshOnce(target, remoteCommand, timeoutMs, false);
  }
  return first;
};

const DEFAULT_WAKE_WINDOW_MS = 14_000;
const XIAOAI_WAKE_CHIME_PATH = '/usr/share/sound-vendor/AiNiRobot/wakeup_zai_01.wav';
const xiaoaiWakeWindows = new Map<string, { expiresAt: number; keyword: string }>();
const xiaoaiSpeakingGuards = new Map<string, { until: number }>();
const xiaoaiSpeechEpochs = new Map<string, number>();

function xiaoaiRuntimeKey(channelId: string, targetId: string): string {
  return `${channelId}:${targetId}`;
}

export function bumpXiaoaiSpeechEpoch(channelId: string, targetId: string): number {
  const key = xiaoaiRuntimeKey(channelId, targetId);
  xiaoaiSpeakingGuards.delete(key);
  const next = (xiaoaiSpeechEpochs.get(key) ?? 0) + 1;
  xiaoaiSpeechEpochs.set(key, next);
  return next;
}

export function getXiaoaiSpeechEpoch(channelId: string, targetId: string): number {
  return xiaoaiSpeechEpochs.get(xiaoaiRuntimeKey(channelId, targetId)) ?? 0;
}

export function markXiaoaiWakeWindow(
  channelId: string,
  targetId: string,
  keyword: string,
  ttlMs = DEFAULT_WAKE_WINDOW_MS,
): void {
  const safeTtl = Math.max(3_000, Math.min(60_000, ttlMs));
  xiaoaiWakeWindows.set(xiaoaiRuntimeKey(channelId, targetId), {
    expiresAt: Date.now() + safeTtl,
    keyword,
  });
}

export function isXiaoaiWakeWindowActive(
  channelId: string,
  targetId: string,
  now = Date.now(),
): boolean {
  const key = xiaoaiRuntimeKey(channelId, targetId);
  const entry = xiaoaiWakeWindows.get(key);
  if (!entry) return false;
  if (entry.expiresAt <= now) {
    xiaoaiWakeWindows.delete(key);
    return false;
  }
  return true;
}

export function clearXiaoaiWakeWindow(channelId: string, targetId: string): void {
  xiaoaiWakeWindows.delete(xiaoaiRuntimeKey(channelId, targetId));
}

export function markXiaoaiSpeakingGuard(
  channelId: string,
  targetId: string,
  durationMs: number,
  overwrite = false,
): void {
  const key = xiaoaiRuntimeKey(channelId, targetId);
  const nextUntil = Date.now() + Math.max(0, durationMs);
  const prev = xiaoaiSpeakingGuards.get(key);
  xiaoaiSpeakingGuards.set(key, {
    until: !overwrite && prev ? Math.max(prev.until, nextUntil) : nextUntil,
  });
}

/**
 * Suppress bare `"星期五"` self-echo while Friday is speaking on this speaker,
 * while still allowing explicit wake phrases (`"你好星期五"`, `"嘿星期五"`, `"嗨星期五"`, `"呼叫星期五"`) for barge-in.
 */
export function isXiaoaiSpeakingSelfEcho(
  channelId: string,
  targetId: string,
  keyword: string,
  now = Date.now(),
): boolean {
  const key = xiaoaiRuntimeKey(channelId, targetId);
  const guard = xiaoaiSpeakingGuards.get(key);
  if (!guard) return false;
  if (guard.until <= now) {
    xiaoaiSpeakingGuards.delete(key);
    return false;
  }
  return keyword.trim() === '星期五';
}

export function resetXiaoaiRuntimeState(): void {
  xiaoaiWakeWindows.clear();
  xiaoaiSpeakingGuards.clear();
  xiaoaiSpeechEpochs.clear();
}

function escapeShellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function parseBoolParam(raw: string | null, defaultValue: boolean): boolean {
  if (!raw) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no') {
    return false;
  }
  if (normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes') {
    return true;
  }
  return defaultValue;
}

export function parseXiaoaiApiOptions(apiBase?: string): XiaoaiApiOptions {
  const isSsh = Boolean(apiBase?.trim().startsWith('ssh://'));
  const defaults: XiaoaiApiOptions = {
    passthroughNative: true,
    kws: isSsh,
    kwsDevice: 'noop',
    kwsChime: true,
    wakeWindowMs: DEFAULT_WAKE_WINDOW_MS,
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
  const wakeWindowRaw = Number(params.get('wakeWindowMs'));
  const wakeWindowMs = Number.isFinite(wakeWindowRaw) && wakeWindowRaw > 0
    ? Math.max(3_000, Math.min(60_000, Math.round(wakeWindowRaw)))
    : DEFAULT_WAKE_WINDOW_MS;
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
    wakeWindowMs,
    ...(speakerVerify !== undefined ? { speakerVerify } : {}),
    ...(speakerThreshold !== undefined ? { speakerThreshold } : {}),
  };
}

export function buildXiaoaiWakeCommand(options?: { chime?: boolean }): string {
  const pauseCmd = 'rm -f /tmp/friday_speaking; (ubus -t 1 call mediaplayer player_play_operation \'{"action":"pause"}\' >/dev/null 2>&1 || mphelper pause >/dev/null 2>&1 || true)';
  const chimeCmd = options?.chime === false
    ? ''
    : `(ubus -t 2 call qplayer play '{"play":"${XIAOAI_WAKE_CHIME_PATH}"}' >/dev/null 2>&1 || /usr/bin/miplayer -f '${XIAOAI_WAKE_CHIME_PATH}' </dev/null >/dev/null 2>&1 || true); `;
  const ledCmd = 'tok="$$_$(date +%s)"; echo "$tok" >/tmp/friday_led_tok; (/bin/shut_led 2 >/dev/null 2>&1 || true); (/bin/show_led 1 >/dev/null 2>&1 || true); (sh -c \'sleep 12; [ "$(cat /tmp/friday_led_tok 2>/dev/null)" = "\'"$tok"\'" ] && /bin/shut_led 1 >/dev/null 2>&1 || true\' </dev/null >/dev/null 2>&1 &)';
  return `${pauseCmd}; ${chimeCmd}${ledCmd}`;
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
  await (sshRunner ?? defaultSshRunner)(target, buildXiaoaiLedCommand(mode), { timeoutMs: 4_000 }).catch(() => {});
}

export async function handleXiaoaiKeywordWake(params: {
  channel: ImChannelConfig;
  target: XiaoaiSshTarget;
  keyword: string;
  chime?: boolean;
  sshRunner?: XiaoaiSshRunner;
}): Promise<{ woken: boolean; suppressed: boolean; wakeWindowMs: number }> {
  const { channel, target, keyword } = params;
  if (isXiaoaiSpeakingSelfEcho(channel.id, target.id, keyword)) {
    return { woken: false, suppressed: true, wakeWindowMs: 0 };
  }
  bumpXiaoaiSpeechEpoch(channel.id, target.id);
  const apiOptions = parseXiaoaiApiOptions(channel.apiBase);
  const sshRunner = params.sshRunner ?? defaultSshRunner;
  const useChime = params.chime !== undefined ? params.chime : apiOptions.kwsChime;
  const res = await sshRunner(
    target,
    buildXiaoaiWakeCommand({ chime: useChime }),
    { timeoutMs: 8_000 },
  );
  if (res.code !== 0) {
    throw new Error(res.stderr.trim() || `小爱唤醒触发失败 (exit=${res.code})`);
  }
  return { woken: true, suppressed: false, wakeWindowMs: 0 };
}

function splitKeepingDelimiters(text: string, pattern: RegExp): string[] {
  const matches = text.match(pattern);
  if (!matches) return [];
  return matches.map(part => part.trim()).filter(Boolean);
}

export function stripXiaoaiDialogDirective(text: string): {
  text: string;
  directive?: 'listen' | 'end';
} {
  if (!text) return { text: '' };
  let directive: 'listen' | 'end' | undefined;
  const stripped = text
    .replace(/\s*\[\[\s*(LISTEN|CONTINUE_DIALOG|END|END_DIALOG)\s*\]\]\s*/gi, (_m, rawTag: string) => {
      const upper = rawTag.toUpperCase();
      directive = upper.startsWith('LISTEN') || upper.startsWith('CONTINUE') ? 'listen' : 'end';
      return '';
    })
    .trim();
  return { text: stripped, ...(directive ? { directive } : {}) };
}

const IMMEDIATE_SPEAK_INVITE_RE =
  /(?:(?:要|想|还要|还想)(?:试|按|调|听|看|查|选|换|用|测).{0,10}(?:就说|直说|直接说|尽管说|跟我说|告诉我)|(?:别的|其他|什么|哪个)(?:键|功能|歌|操作)?.{0,6}(?:就说|直说|直接说|尽管说)|(?:你|请)?(?:直接说|直说|尽管说|接着说|继续说|说吧|讲吧)(?:就行|就好|吧)?|告诉我.{1,18}(?:就行|就好|吧))$/;

export function shouldContinueXiaoaiDialog(
  rawText: string,
  options?: { hasPendingWorkerQuestion?: boolean },
): boolean {
  const { text, directive } = stripXiaoaiDialogDirective(rawText);
  if (directive === 'listen') return true;
  const clean = sanitizeForSpeech(text);
  const sentences = clean ? clean.split(/[。！!;；]+/).map(s => s.trim()).filter(Boolean) : [];
  const tail = sentences.at(-1) ?? clean;
  const hasImmediateInvite =
    Boolean(tail)
    && !/(?:以后|下次|回头|随时)/.test(tail)
    && IMMEDIATE_SPEAK_INVITE_RE.test(tail);
  if (directive === 'end') return hasImmediateInvite;
  if (options?.hasPendingWorkerQuestion) return true;
  if (!clean) return false;
  if (hasImmediateInvite) return true;
  if (/[？?]\s*$/.test(clean)) return true;
  const lastQIdx = Math.max(clean.lastIndexOf('？'), clean.lastIndexOf('?'));
  if (lastQIdx >= 0) {
    const afterQ = clean.slice(lastQIdx + 1).replace(/[。！!;；，,、\s]+/g, '');
    if (afterQ.length <= 32 && !/(?:不用回|无需回|不必回)/.test(afterQ)) {
      return true;
    }
  }
  const recentTail = sentences.slice(-2).join('，');
  if (/[？?]/.test(tail)) return true;
  if (/(?:吗|呢|么|好不好|行不行|可不可以|对不对|是不是|要哪个|选哪个|哪一个|发到哪(?:里|儿)?|转到哪(?:里|儿)?|请说|请讲|请确认|告诉我)$/.test(tail)) {
    return true;
  }
  if (/(?:帮我确认|请确认|确认一下|给(?:我)?(?:一?点|个)?线索|给点提示|跟我说一下|再说一下)/.test(recentTail)) {
    return true;
  }
  if (/(?:要不要|需要我|想发|发(?:给你?|你|到|去)|转到|用哪个|选|确认|请问|是.{0,8}还是|放.{0,8}还是).*(?:还是|或者)/.test(tail) && !/(?:无论|不管)/.test(tail)) {
    return true;
  }
  return false;
}

export function sanitizeForSpeech(text: string): string {
  if (!text) return '';
  let result = stripXiaoaiDialogDirective(text).text.replace(/\r\n?/g, '\n');

  // 1. Replace fenced code blocks with spoken notice
  result = result.replace(/```[\s\S]*?```/g, '（代码详情已同步至控制台）');
  result = result.replace(/```[\s\S]*$/g, '（代码详情已同步至控制台）');

  // 2. Replace markdown links [label](url) -> label, and bare URLs -> notice
  result = result.replace(/!?\[([^\]]*)\]\((?:[^()\s]+|\([^)]*\))+\)/g, (_m, label: string) => label);
  result = result.replace(/https?:\/\/[^\s，。！？；、（）【】《》"'<>]+/gi, '（链接见控制台）');

  // 3. Strip WeChat emoji tags, stray inline HTML tags (e.g. </br>), and decorative Unicode emojis
  result = result.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s+[^<>]*)?\/?>/g, '');
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
    .replace(/^(?:小爱同学[\s，,。！!？?、：:]*|小爱[\s，,。！!？?、：:]+)+/i, '')
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
          .replace(/^[\s，,。！!？?、：:]+/, '')
          .trim();
        if (!rest) return { intercept: false, query: '' };
        return { intercept: true, query: rest };
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

export const SSH_PLAY_STATUS_COMMAND = 'ubus call mediaplayer player_get_play_status 2>/dev/null || true';

export function isXiaoaiPlayerPlaying(stdout: string): boolean {
  return /\\?"status\\?"\s*:\s*1\b/i.test(stdout) || /\\?"state\\?"\s*:\s*\\?"playing\\?"/i.test(stdout);
}

async function waitForXiaoaiSegmentPlayback(
  target: XiaoaiSshTarget,
  sshRunner: XiaoaiSshRunner,
  segmentLength: number,
  isCancelled?: () => boolean,
): Promise<void> {
  if (isCancelled?.()) return;
  const probe = await sshRunner(target, SSH_PLAY_STATUS_COMMAND, { timeoutMs: 4_000 }).catch(() => undefined);
  if (!probe || probe.code !== 0 || !probe.stdout.trim()) return;

  const startedAt = Date.now();
  let sawPlaying = isXiaoaiPlayerPlaying(probe.stdout);
  const startGraceMs = 1_200;
  const maxWaitMs = Math.min(45_000, Math.max(6_000, segmentLength * 350));

  while (Date.now() - startedAt < maxWaitMs) {
    if (isCancelled?.()) return;
    if (sawPlaying || Date.now() - startedAt >= startGraceMs) {
      if (!sawPlaying) return;
    }
    await delay(220);
    if (isCancelled?.()) return;
    const res = await sshRunner(target, SSH_PLAY_STATUS_COMMAND, { timeoutMs: 4_000 }).catch(() => undefined);
    if (!res || res.code !== 0 || !res.stdout.trim()) return;
    const playing = isXiaoaiPlayerPlaying(res.stdout);
    if (playing) {
      sawPlaying = true;
      continue;
    }
    if (sawPlaying) return;
  }
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
    const speechEpoch = getXiaoaiSpeechEpoch(channel.id, target.id);
    const isEpochCancelled = () => getXiaoaiSpeechEpoch(channel.id, target.id) !== speechEpoch;
    for (let i = 0; i < segments.length; i++) {
      if (isEpochCancelled()) break;
      const seg = segments[i]!;
      const estimatedSpeechMs = Math.min(18_000, Math.max(2_200, seg.length * 190 + 900));
      markXiaoaiSpeakingGuard(channel.id, target.id, estimatedSpeechMs);
      const jsonPayload = JSON.stringify({ text: seg, save: 0 });
      const cmd = `rm -f /tmp/friday_led_tok; touch /tmp/friday_speaking; (/bin/shut_led 1 >/dev/null 2>&1; /bin/shut_led 2 >/dev/null 2>&1 || true); ubus call mibrain text_to_speech '${escapeShellSingleQuote(jsonPayload)}' >/dev/null 2>&1 || /usr/sbin/tts_play.sh '${escapeShellSingleQuote(seg)}'`;
      const res = await sshRunner(target, cmd, { timeoutMs: 12_000 });
      if (res.code !== 0) {
        throw new Error(res.stderr.trim() || `小爱 SSH TTS 失败 (exit=${res.code})`);
      }
      if (i < segments.length - 1 || options?.waitForCompletion) {
        await waitForXiaoaiSegmentPlayback(target, sshRunner, seg.length, isEpochCancelled);
        if (i === segments.length - 1 && !isEpochCancelled()) {
          markXiaoaiSpeakingGuard(channel.id, target.id, 350, true);
        }
      } else {
        markXiaoaiSpeakingGuard(channel.id, target.id, estimatedSpeechMs);
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

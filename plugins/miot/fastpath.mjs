import { existsSync } from 'node:fs';
import {
  clampInt,
  errMsg,
  readConfig,
  readJsonSafe,
  resolvePluginPaths,
} from '../_shared/config-store.mjs';

const TV_EXCLUDE_RE = /(?:电视机?|遥控器?)/i;
const FILLER_PREFIX_RE = /^(?:小爱同学|小爱)[,，。!！?？\s]*/i;
const NON_MIOT_TARGET_RE = /(?:音乐|歌|歌曲|故事|相声|新闻|天气|闹钟|提醒|蓝牙|wifi|无线网|计时器|手机|电脑|影视仓|饮食仓|尹志仓|tvbox|b站|哔哩|爱奇艺|优酷|腾讯视频|芒果tv|浏览器|历史记录|播放记录|观看记录|记录|选集|详情|弹幕|字幕|全屏|菜单|设置|应用|软件|app|网页|页面|窗口)/i;
const SMART_DEVICE_NOUN_RE = /(?:灯|照明|台灯|吸顶灯|筒灯|射灯|灯带|开关|插座|插排|排插|插头|通断器|风扇|加湿器|净化器|窗帘|扫地机|饮水机|浴霸|空调|空气炸锅|炸锅)/;

function cleanUtterance(raw) {
  let text = String(raw || '').trim();
  text = text.replace(FILLER_PREFIX_RE, '');
  text = text.replace(/[。！!？?]+$/g, '').trim();
  return text;
}

function normalizeProtectedKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/的/g, '')
    .replace(/\s+/g, '');
}

/**
 * Check if a target query or resolved device is blocked by `config.protectedDevices`.
 * @param {string[]} protectedDevices
 * @param {{ query?: string; room?: string; resolved?: { did?: unknown; dev_name?: string; name?: string; room_name?: string; room?: string } }} info
 * @returns {string | null}
 */
export function findProtectedMatch(protectedDevices, info = {}) {
  const list = Array.isArray(protectedDevices)
    ? protectedDevices.map(x => String(x ?? '').trim()).filter(Boolean)
    : [];
  if (list.length === 0) return null;

  const candidates = new Set();
  if (info.query) candidates.add(normalizeProtectedKey(info.query));
  if (info.room && info.query) candidates.add(normalizeProtectedKey(`${info.room}${info.query}`));
  if (info.resolved) {
    const r = info.resolved;
    if (r.did !== undefined && r.did !== null) candidates.add(normalizeProtectedKey(String(r.did)));
    const devName = String(r.dev_name ?? r.name ?? '').trim();
    const roomName = String(r.room_name ?? r.room ?? '').trim();
    if (devName) candidates.add(normalizeProtectedKey(devName));
    if (roomName && devName) candidates.add(normalizeProtectedKey(`${roomName}${devName}`));
  }

  for (const entry of list) {
    const normEntry = normalizeProtectedKey(entry);
    if (!normEntry) continue;
    if (candidates.has(normEntry)) {
      return entry;
    }
    if (info.resolved) {
      const devName = normalizeProtectedKey(info.resolved.dev_name ?? info.resolved.name ?? '');
      const roomName = normalizeProtectedKey(info.resolved.room_name ?? info.resolved.room ?? '');
      if (devName && (normEntry === devName || normEntry === `${roomName}${devName}`)) {
        return entry;
      }
    }
  }
  return null;
}

function parseAirFryerIntent(text) {
  if (!/(?:空气炸锅|空气炸播|空气炸国|空炸|炸锅)/.test(text)) return null;

  if (/(?:状态|怎么样|还有多久|剩余时间|剩多少|温度多少|开着吗|工作吗)/.test(text)) {
    return { kind: 'get', device: '空气炸锅', speechPrefix: '空气炸锅' };
  }
  if (/^(?:请|帮我|麻烦)?(?:暂停|先停一下)/.test(text)) {
    return { kind: 'fryer_action', device: '空气炸锅', action: 'pause' };
  }
  if (/^(?:请|帮我|麻烦)?(?:继续|恢复|开始)(?:运行|工作|烹饪)?/.test(text)) {
    return { kind: 'fryer_action', device: '空气炸锅', action: 'start' };
  }
  if (/^(?:请|帮我|麻烦)?(?:关闭|关掉|关了|停止|取消)/.test(text)) {
    return { kind: 'fryer_action', device: '空气炸锅', action: 'stop' };
  }

  // Cook mode: recipe + optional temp + optional minutes.
  const recipeRules = [
    ['fries', /(?:薯条|炸薯条)/],
    ['wings', /(?:鸡翅|烤鸡翅)/],
    ['sweet_potato', /(?:红薯|烤红薯|地瓜)/],
    ['egg_tart', /(?:蛋挞|烤蛋挞)/],
    ['defrost', /(?:解冻)/],
    ['dried_fruit', /(?:果干|烘干)/],
    ['yogurt', /(?:酸奶)/],
  ];
  let recipe;
  for (const [id, re] of recipeRules) {
    if (re.test(text)) {
      recipe = id;
      break;
    }
  }
  const tempMatch = text.match(/(\d{2,3})\s*(?:度|℃|°c)/i);
  const minMatch = text.match(/(\d{1,4})\s*(?:分钟|min)/i);
  if (recipe || tempMatch || minMatch || /(?:烤|炸|烹饪|启动|打开)/.test(text)) {
    return {
      kind: 'cook',
      device: '空气炸锅',
      ...(recipe ? { recipe } : {}),
      ...(tempMatch ? { tempC: Number(tempMatch[1]) } : {}),
      ...(minMatch ? { minutes: Number(minMatch[1]) } : {}),
    };
  }
  return null;
}

function parseAcIntent(text) {
  if (!/空调/.test(text)) return null;

  const statusRe = /(?:状态|开着吗|开了吗|多少度|现在几度)/;
  // Extract optional room prefix before 空调 (e.g. "把卧室空调调到26度", "打开客厅的空调").
  const prefixMatch = text.match(/^(?:(?:请|帮我|麻烦|能不能|可以|把|将|给)?(?:打开|开启|开一下|关闭|关掉|关了|开启|调低|调高|设置|设定|把|将|调)?)*([^\s把将给开关闭调设到为]+?)(?:的)?空调/);
  let room;
  if (prefixMatch?.[1]) {
    const candidate = prefixMatch[1]
      .replace(/^(?:请|帮我|麻烦|把|将|给|打开|开启|关闭|关掉|关|调|设|设置|看下|查看|查一下)+/g, '')
      .replace(/的$/, '')
      .trim();
    if (candidate && !/^(?:一下|我的|家里|房间)$/.test(candidate)) {
      room = candidate;
    }
  }
  const device = room ? `${room}空调` : '空调';

  if (statusRe.test(text)) {
    return { kind: 'get', device, ...(room ? { room } : {}) };
  }

  let on;
  if (/(?:打开|开启|开一下|开机)/.test(text)) on = true;
  if (/(?:关闭|关掉|关了|关机)/.test(text) && !/(?:打开|开启)/.test(text)) on = false;

  const tempMatch = text.match(/(\d{1,3})\s*(?:度|℃|°c)/i);
  let temperature;
  if (tempMatch) {
    temperature = Number(tempMatch[1]);
  }

  let mode;
  if (/制冷|冷风/.test(text)) mode = 'cool';
  else if (/制热|暖风/.test(text)) mode = 'heat';
  else if (/除湿/.test(text)) mode = 'dry';
  else if (/送风/.test(text)) mode = 'fan';
  else if (/自动模式/.test(text)) mode = 'auto';

  let fanSpeed;
  if (/低速|低风|小风/.test(text)) fanSpeed = 'low';
  else if (/中速|中风/.test(text)) fanSpeed = 'medium';
  else if (/高速|高风|大风|强风/.test(text)) fanSpeed = 'high';
  else if (/自动风/.test(text)) fanSpeed = 'auto';

  if (on === undefined && temperature === undefined && mode === undefined && fanSpeed === undefined) {
    if (/^开(?:一下)?空调$/.test(text)) on = true;
    else if (/^关(?:一下)?空调$/.test(text)) on = false;
    else return null;
  }

  return {
    kind: 'ac_set',
    device,
    ...(room ? { room } : {}),
    ...(on !== undefined ? { on } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(fanSpeed !== undefined ? { fanSpeed } : {}),
  };
}

function parseGenericSwitchIntent(text) {
  // Query patterns: "卧室灯开了吗", "查看客厅灯状态"
  const queryMatch = text.match(/^(?:请|帮我|麻烦)?(?:查询|查看|查一下|看看|看下)?\s*(.+?)(?:是)?(?:开着吗|开了吗|关着吗|关了吗|状态(?:怎么样)?)[吗嘛呢]?$/);
  if (queryMatch?.[1]) {
    const dev = queryMatch[1].replace(/^(?:请|帮我|麻烦|把|将|给)+/, '').trim();
    if (dev && dev.length <= 32 && !TV_EXCLUDE_RE.test(dev) && !NON_MIOT_TARGET_RE.test(dev)) {
      return { kind: 'get', device: dev };
    }
  }

  // Action patterns:
  // 1) "打开客厅灯" / "关闭卧室台灯" / "关掉书房插座" / "切换阳台灯"
  // 2) "把客厅灯打开" / "把卧室灯关掉"
  let actionWord = '';
  let target = '';

  const baMatch = text.match(/^(?:请|帮我|麻烦|现在|顺便)?(?:把|将|给)\s*(.+?)\s*(打开|开启|开一下|开|关闭|关掉|关了|关一下|关|切换|反转)(?:吧|一下|咯|了)?$/);
  if (baMatch?.[1] && baMatch?.[2]) {
    target = baMatch[1].trim();
    actionWord = baMatch[2];
  } else {
    const verbFirstMatch = text.match(/^(?:请|帮我|麻烦|现在|顺便)?(打开|开启|开一下|关闭|关掉|关了|关一下|切换|反转|开|关)\s*(?:一下)?\s*(.+?)(?:吧|一下|咯|了)?$/);
    if (verbFirstMatch?.[1] && verbFirstMatch?.[2]) {
      actionWord = verbFirstMatch[1];
      target = verbFirstMatch[2].trim();
    }
  }

  if (!actionWord || !target) return null;
  if (TV_EXCLUDE_RE.test(target) || NON_MIOT_TARGET_RE.test(target)) {
    return null;
  }
  if (!SMART_DEVICE_NOUN_RE.test(target) && target.length > 16) {
    return null;
  }

  const isToggle = /^(?:切换|反转)/.test(actionWord);
  const isOn = /^(?:打开|开启|开一下|开)/.test(actionWord);
  const isOff = /^(?:关闭|关掉|关了|关一下|关)/.test(actionWord);
  if (!isToggle && !isOn && !isOff) return null;

  return {
    kind: 'set_power',
    device: target.replace(/^我的/, '').trim(),
    ...(isToggle ? { toggle: true } : { on: isOn }),
  };
}

/**
 * Parse a Chinese smart-home voice utterance into one or more structured MiOT intents.
 * @param {string} rawText
 * @returns {Array<Record<string, any>> | null}
 */
export function parseMiotVoiceUtterance(rawText) {
  const cleaned = cleanUtterance(rawText);
  if (!cleaned || cleaned.length > 120) return null;
  if (TV_EXCLUDE_RE.test(cleaned)) return null;

  const clauses = cleaned
    .split(/(?:然后|接着|之后|并且|同时|[,，;；]+)/)
    .map(c => c.trim())
    .filter(Boolean);

  if (clauses.length === 0) return null;
  const intents = [];
  for (const clause of clauses) {
    const intent =
      parseAirFryerIntent(clause) ||
      parseAcIntent(clause) ||
      parseGenericSwitchIntent(clause);
    if (!intent) return null;
    intents.push(intent);
  }
  return intents;
}

async function executeSingleIntent(intent, cfg, deps, runActionFn) {
  const isMutation = intent.kind !== 'get';

  // Fast check against raw query before touching hub SSH/cache.
  if (isMutation) {
    const preMatch = findProtectedMatch(cfg.protectedDevices, {
      query: intent.device,
      room: intent.room,
    });
    if (preMatch) {
      return {
        ok: false,
        protectedBlocked: true,
        speech: `设备「${preMatch}」已设为语音保护设备，禁止通过语音控制。`,
      };
    }
  }

  // Also check resolved device metadata (covers aliases/did matches in protectedDevices).
  if (isMutation && Array.isArray(cfg.protectedDevices) && cfg.protectedDevices.length > 0) {
    try {
      const devListRes = await runActionFn('devices', { live: false }, deps);
      const devices = Array.isArray(devListRes?.data?.devices) ? devListRes.data.devices : [];
      const q = String(intent.device || '').toLowerCase();
      const matched = devices.find(d => {
        const name = String(d.name || d.dev_name || '').toLowerCase();
        const full = `${String(d.room || d.room_name || '').toLowerCase()}${name}`;
        return name === q || full === q || String(d.did) === intent.device;
      });
      if (matched) {
        const postMatch = findProtectedMatch(cfg.protectedDevices, {
          query: intent.device,
          room: intent.room,
          resolved: matched,
        });
        if (postMatch) {
          return {
            ok: false,
            protectedBlocked: true,
            speech: `设备「${matched.room ? `${matched.room}${matched.name}` : matched.name || postMatch}」已设为语音保护设备，禁止通过语音控制。`,
          };
        }
      }
    } catch {
      // Ignore pre-resolution errors; execution below will surface device lookup errors cleanly.
    }
  }

  if (intent.kind === 'get') {
    const res = await runActionFn('get', {
      device: intent.device,
      ...(intent.room ? { room: intent.room } : {}),
    }, deps);
    return {
      ok: Boolean(res?.ok),
      speech: res?.message || '已查询设备状态。',
      result: res,
    };
  }

  if (intent.kind === 'fryer_action') {
    const res = await runActionFn('action', {
      device: intent.device,
      action: intent.action,
    }, deps);
    return {
      ok: Boolean(res?.ok),
      speech: res?.message || '空气炸锅操作已执行。',
      result: res,
    };
  }

  if (intent.kind === 'cook') {
    const res = await runActionFn('cook', {
      device: intent.device,
      ...(intent.recipe ? { recipe: intent.recipe } : {}),
      ...(intent.tempC !== undefined ? { tempC: intent.tempC } : {}),
      ...(intent.minutes !== undefined ? { minutes: intent.minutes } : {}),
    }, deps);
    return {
      ok: Boolean(res?.ok),
      speech: res?.message || '已启动空气炸锅。',
      result: res,
    };
  }

  if (intent.kind === 'ac_set') {
    if (intent.temperature !== undefined) {
      const clamped = clampInt(intent.temperature, 16, 31);
      if (clamped === undefined || intent.temperature < 16 || intent.temperature > 31) {
        return {
          ok: false,
          speech: `空调温度需要在 16 到 31 度之间，${intent.temperature}度超出范围。`,
        };
      }
    }
    const res = await runActionFn('set', {
      device: intent.device,
      ...(intent.room ? { room: intent.room } : {}),
      ...(intent.on !== undefined ? { on: intent.on } : {}),
      ...(intent.temperature !== undefined ? { temperature: intent.temperature } : {}),
      ...(intent.mode !== undefined ? { mode: intent.mode } : {}),
      ...(intent.fanSpeed !== undefined ? { fanSpeed: intent.fanSpeed } : {}),
    }, deps);
    return {
      ok: Boolean(res?.ok),
      speech: res?.message || '空调已设置。',
      result: res,
    };
  }

  if (intent.kind === 'set_power') {
    const res = await runActionFn('set', {
      device: intent.device,
      ...(intent.toggle ? { toggle: true } : { on: Boolean(intent.on) }),
    }, deps);
    return {
      ok: Boolean(res?.ok),
      speech: res?.message || '设备已操作。',
      result: res,
    };
  }

  return { ok: false, speech: '未识别的米家语音指令。' };
}

function matchesCustomAlias(customAliases, intent) {
  if (!customAliases || typeof customAliases !== 'object') return false;
  const queries = new Set();
  const q = normalizeProtectedKey(intent?.device);
  if (q) queries.add(q);
  if (intent?.room && intent?.device) {
    const rq = normalizeProtectedKey(`${intent.room}${intent.device}`);
    if (rq) queries.add(rq);
  }
  if (queries.size === 0) return false;
  for (const [key, val] of Object.entries(customAliases)) {
    if (Array.isArray(val)) {
      if (val.some(alias => queries.has(normalizeProtectedKey(alias)))) return true;
    } else if (typeof val === 'string' && queries.has(normalizeProtectedKey(key))) {
      return true;
    }
  }
  return false;
}

function deviceMatchesQuery(device, query, room) {
  if (!device || typeof device !== 'object') return false;
  const q = normalizeProtectedKey(query);
  if (!q) return false;
  const rq = room ? normalizeProtectedKey(`${room}${query}`) : '';
  const did = normalizeProtectedKey(device.did);
  if (did && (did === q || (rq && did === rq))) return true;
  const name = normalizeProtectedKey(device.dev_name ?? device.name);
  const roomName = normalizeProtectedKey(device.room_name ?? device.room);
  const fullName = normalizeProtectedKey(device.fullName) || (roomName && name ? `${roomName}${name}` : '');
  const modelName = normalizeProtectedKey(device.model_name ?? device.modelName);
  const fields = [name, fullName, modelName].filter(Boolean);
  return fields.some(
    field => field.includes(q) || q.includes(field) || (rq && (field.includes(rq) || rq.includes(field))),
  );
}

function isDeviceNotFoundOutcome(outcome) {
  if (!outcome || outcome.ok || outcome.protectedBlocked) return false;
  const code = outcome.result?.data?.code;
  if (code === 'DEVICE_NOT_FOUND' || code === 'DEVICE_REQUIRED') {
    return true;
  }
  const speech = String(outcome.speech ?? '');
  return speech.includes('未找到') || speech.includes('找不到');
}

/**
 * Handle MiOT voice fastpath queries/commands inside plugins/miot.
 * @param {import('../_shared/types.d.ts').VoiceFastpathRequest} request
 * @param {import('../_shared/types.d.ts').PluginActionContext & Record<string, any>} context
 * @param {(action: string, args: Record<string, any>, deps?: any) => Promise<import('../_shared/types.d.ts').PluginActionResult>} runActionFn
 * @returns {Promise<import('../_shared/types.d.ts').VoiceFastpathResult>}
 */
export async function handleMiotVoiceFastpath(request, context = {}, runActionFn) {
  const sessionState = request?.sessionState && typeof request.sessionState === 'object'
    ? request.sessionState
    : null;

  if (sessionState?.event === 'assistant_reply') {
    return { handled: false };
  }
  if (sessionState?.tvRemoteActive || sessionState?.continuous) {
    return { handled: false };
  }

  const intents = parseMiotVoiceUtterance(request?.text);
  if (!intents || intents.length === 0) {
    return { handled: false };
  }

  const paths = resolvePluginPaths('miot', context, {
    cachePath: 'hub-cache.json',
  });
  const rawCfg = readConfig(paths.configPath, {
    routerSsh: '',
    speakerSsh: '',
    protectedDevices: [],
    customAliases: {},
  });
  const protectedDevices = Array.isArray(rawCfg.protectedDevices) ? rawCfg.protectedDevices : [];

  const hasHubInjection = Boolean(
    context?.fetchHubRawRows || context?.sshTextExec || context?.sshBinaryExec || context?.devices,
  );
  const hasRouterConfig = typeof rawCfg.routerSsh === 'string' && rawCfg.routerSsh.trim().length > 0;
  const hasCache = existsSync(paths.cachePath);

  // Check protected devices even before requiring hub config so blocked feedback stays consistent.
  const preProtected = intents.find(i => i.kind !== 'get' && findProtectedMatch(protectedDevices, { query: i.device, room: i.room }));
  if (preProtected) {
    const hit = findProtectedMatch(protectedDevices, { query: preProtected.device, room: preProtected.room });
    return {
      handled: true,
      speech: `设备「${hit}」已设为语音保护设备，禁止通过语音控制。`,
      data: { blocked: true, reason: 'protected_device', device: hit },
    };
  }

  if (!hasRouterConfig && !hasCache && !hasHubInjection) {
    return { handled: false };
  }

  if (typeof runActionFn !== 'function') {
    return { handled: false };
  }

  // Generic targets without a known smart-device noun must match a known device or custom alias
  // before claiming fastpath execution (reads local cache first to avoid unnecessary hub SSH calls).
  const unverifiedGenericIntents = intents.filter(
    i => (i.kind === 'set_power' || i.kind === 'get') && !SMART_DEVICE_NOUN_RE.test(i.device),
  );
  if (unverifiedGenericIntents.length > 0) {
    const customAliases = rawCfg.customAliases;
    const needsLookup = unverifiedGenericIntents.some(i => !matchesCustomAlias(customAliases, i));
    if (needsLookup) {
      let candidateDevices = Array.isArray(context?.devices) ? context.devices : null;
      if (!candidateDevices) {
        const cachedSnapshot = readJsonSafe(paths.cachePath, null);
        if (Array.isArray(cachedSnapshot?.devices)) {
          candidateDevices = cachedSnapshot.devices;
        }
      }
      if (!candidateDevices) {
        try {
          const devRes = await runActionFn('devices', { live: false }, context);
          if (Array.isArray(devRes?.data?.devices)) {
            candidateDevices = devRes.data.devices;
          }
        } catch {
          candidateDevices = null;
        }
      }
      if (Array.isArray(candidateDevices)) {
        const missing = unverifiedGenericIntents.some(
          i => !matchesCustomAlias(customAliases, i) && !candidateDevices.some(d => deviceMatchesQuery(d, i.device, i.room)),
        );
        if (missing) {
          return { handled: false };
        }
      }
    }
  }

  const speeches = [];
  const results = [];
  let allOk = true;
  for (const intent of intents) {
    try {
      const outcome = await executeSingleIntent(intent, { protectedDevices }, context, runActionFn);
      if (!outcome.ok) allOk = false;
      speeches.push(outcome.speech);
      results.push(outcome);
    } catch (err) {
      allOk = false;
      speeches.push(errMsg(err));
    }
  }

  if (results.length > 0 && results.length === intents.length && results.every(isDeviceNotFoundOutcome)) {
    return { handled: false };
  }

  return {
    handled: true,
    speech: speeches.join(' '),
    data: {
      ok: allOk,
      intents,
      results,
    },
  };
}

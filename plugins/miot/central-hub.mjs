import { randomBytes } from 'node:crypto';
import { inflateRawSync, inflateSync } from 'node:zlib';
import {
  clampInt,
  errMsg,
  readJsonSafe,
  writeJsonAtomic,
} from '../_shared/config-store.mjs';
import { shellQuote } from '../_shared/ssh.mjs';

export const CENTRAL_TOPIC_RE = /^(?:local|master)\/[A-Za-z0-9_/-]+$/;
export const VAR_IDENT_RE = /^[A-Za-z0-9]{1,64}$/;
export const GRAPH_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
export const GEEK_URL_RE = /^http:\/\/[0-9A-Za-z._:-]+$/;

const MAX_JSONZ_BYTES = 2 * 1024 * 1024;
const MAX_MIPS_PAYLOAD_BYTES = 64 * 1024;
const HEX32_SCAN_RE = /(?<![0-9a-zA-Z])[0-9a-fA-F]{32}(?![0-9a-zA-Z])/g;
const SECRET_KEYS = new Set([
  'token', 'tokenbydid', 'tokenmap', 'tokens',
  'bindkey', 'bind_key', 'ltmk', 'secret', 'password', 'passw',
]);

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const MARKERS = Object.freeze({
  pid: '__FRIDAY_SEC_PID__',
  gw: '__FRIDAY_SEC_GW__',
  role: '__FRIDAY_SEC_ROLE__',
  gwList: '__FRIDAY_SEC_GWLIST__',
  btStatus: '__FRIDAY_SEC_BTSTATUS__',
  btDevs: '__FRIDAY_SEC_BTDEVS__',
  port: '__FRIDAY_SEC_PORT__',
  geekReady: '__FRIDAY_SEC_GEEK_READY__',
  geekList: '__FRIDAY_SEC_GEEK_LIST__',
  varScopes: '__FRIDAY_SEC_VAR_SCOPES__',
  scenes: '__FRIDAY_SEC_SCENES__',
  cloudGraphs: '__FRIDAY_SEC_CLOUD_GRAPHS__',
  geekGraphs: '__FRIDAY_SEC_GEEK_GRAPHS__',
  logs: '__FRIDAY_SEC_LOGS__',
});

/**
 * Strip secret-like keys and mask 32-hex strings from cached or returned payloads.
 * @param {unknown} value
 * @returns {any}
 */
export function sanitizeCentralValue(value) {
  if (typeof value === 'string') return value.replace(HEX32_SCAN_RE, '[redacted]');
  if (Array.isArray(value)) return value.map(sanitizeCentralValue);
  if (value && typeof value === 'object') {
    if (Buffer.isBuffer(value)) return `[buffer ${value.length}B]`;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k.toLowerCase())) continue;
      out[k] = sanitizeCentralValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Validate a Geek Edition variable scope or id (`^[A-Za-z0-9]{1,64}$`).
 * @param {unknown} raw
 * @param {string} [label]
 * @returns {string}
 */
export function validateVarIdentifier(raw, label = '变量标识') {
  const clean = String(raw ?? '').trim();
  if (!VAR_IDENT_RE.test(clean)) {
    throw new Error(`${label} "${clean}" 格式无效，只能包含 1-64 位英文字母或数字。`);
  }
  return clean;
}

/**
 * Validate a Geek Edition graph id.
 * @param {unknown} raw
 * @returns {string}
 */
export function validateGraphId(raw) {
  const clean = String(raw ?? '').trim();
  if (!GRAPH_ID_RE.test(clean)) {
    throw new Error(`规则 ID "${clean}" 格式无效。`);
  }
  return clean;
}

/**
 * Validate a Geek Edition node array before sending `local/autoLocal/setGraph`.
 * @param {unknown} nodes
 * @returns {any[]}
 */
export function validateGeekNodes(nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('nodes 必须为非空数组。');
  }
  if (nodes.length > 200) {
    throw new Error('nodes 数量超出限制（最多 200 个节点）。');
  }
  const seen = new Set();
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      throw new Error('nodes 元素必须为对象。');
    }
    const id = typeof node.id === 'string' ? node.id.trim() : '';
    const type = typeof node.type === 'string' ? node.type.trim() : '';
    if (!id || seen.has(id)) {
      throw new Error(`节点 ID "${id}" 缺失或重复。`);
    }
    seen.add(id);
    if (!type) {
      throw new Error(`节点 "${id}" 缺少 type。`);
    }
    if (!node.props || typeof node.props !== 'object' || Array.isArray(node.props)) {
      throw new Error(`节点 "${id}" 缺少 props 对象。`);
    }
  }
  return nodes;
}

/**
 * Build an HTTP URL for the official Geek Edition canvas and enforce `http://<host>[:port]`.
 * @param {unknown} ipOrHost
 * @param {unknown} portRaw
 * @returns {string}
 */
export function buildSafeGeekUrl(ipOrHost, portRaw) {
  const host = String(ipOrHost ?? '').trim();
  if (!host || /[\s/\\?#"'<>]/.test(host)) return '';
  const port = clampInt(portRaw, 1, 65535);
  if (!port) return '';
  const candidate = port === 80 ? `http://${host}` : `http://${host}:${port}`;
  return GEEK_URL_RE.test(candidate) ? candidate : '';
}

/**
 * Build remote shell script that reads stdin JSON payload and invokes `mips_callapi` inside `central_service`'s chroot.
 * @param {string} topic
 * @param {number} [timeoutMs]
 * @returns {string}
 */
export function buildCentralMipsApiScript(topic, timeoutMs = 4000) {
  const cleanTopic = String(topic ?? '').trim();
  if (!CENTRAL_TOPIC_RE.test(cleanTopic)) {
    throw new Error(`无效的 MIPS topic "${cleanTopic}"`);
  }
  const safeTimeout = clampInt(timeoutMs, 300, 20_000) ?? 4000;
  return [
    `MQTT_PID=$(pidof central_service | awk '{print $1}')`,
    `[ -n "$MQTT_PID" ] || { echo "central_service not running" >&2; exit 3; }`,
    `ROOT="/proc/$MQTT_PID/root"`,
    `PAYLOAD=$(cat)`,
    `[ -n "$PAYLOAD" ] || PAYLOAD='{}'`,
    `exec chroot "$ROOT" /usr/bin/mips_callapi --topic ${shellQuote(cleanTopic)} --payload "$PAYLOAD" --timeout ${safeTimeout}`,
  ].join('\n');
}

/**
 * Call a central hub MIPS API over SSH stdin without embedding payload JSON into shell args.
 * @param {{
 *   target: import('../_shared/types.d.ts').SshTarget;
 *   sshBin: (target: any, cmd: string, opts?: any) => Promise<import('../_shared/types.d.ts').SshBinaryExecResult>;
 *   topic: string;
 *   payload?: Record<string, unknown>;
 *   timeoutMs?: number;
 *   sshTimeoutMs?: number;
 * }} opts
 * @returns {Promise<any>}
 */
export async function callCentralMipsApi({
  target,
  sshBin,
  topic,
  payload = {},
  timeoutMs = 4000,
  sshTimeoutMs = 12_000,
}) {
  const payloadObj = payload && typeof payload === 'object' ? payload : {};
  const payloadStr = JSON.stringify(payloadObj);
  if (payloadStr.includes('\0')) {
    throw new Error('MIPS 请求负载不能包含 NUL 字节。');
  }
  if (Buffer.byteLength(payloadStr, 'utf8') > MAX_MIPS_PAYLOAD_BYTES) {
    throw new Error('MIPS 请求负载超过 64KB 限制。');
  }
  const script = buildCentralMipsApiScript(topic, timeoutMs);
  const res = await sshBin(target, script, {
    input: Buffer.from(payloadStr, 'utf8'),
    timeoutMs: sshTimeoutMs,
  });
  const stdoutText = (Buffer.isBuffer(res.stdout) ? res.stdout.toString('utf8') : String(res.stdout ?? '')).trim();
  const stderrText = String(res.stderr ?? '').trim();
  if (res.code !== 0 && !stdoutText) {
    throw new Error(`中枢 MIPS (${topic}) 调用失败 (ssh code=${res.code})：${stderrText.slice(0, 200) || '无输出'}`);
  }
  if (!stdoutText) {
    throw new Error(`中枢 MIPS (${topic}) 无响应（可能超时）。`);
  }
  const parsed = tryParseJsonText(stdoutText);
  if (parsed === undefined) {
    throw new Error(`无法解析中枢 MIPS (${topic}) 响应：${stdoutText.slice(0, 160)}`);
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error) {
    const errObj = parsed.error;
    const msg = errObj.message ?? JSON.stringify(errObj);
    const codePart = errObj.code !== undefined ? ` (code=${errObj.code})` : '';
    throw new Error(`中枢 MIPS (${topic}) 返回错误：${msg}${codePart}`);
  }
  return parsed;
}

/**
 * Decode a central `.jsonz` file (`[uint32LE len][deflate payload]`) from Buffer or base64 string.
 * @param {Buffer | string} input
 * @returns {any}
 */
export function decodeCentralJsonz(input) {
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(String(input ?? '').trim(), 'base64');
  if (buf.length <= 4) {
    throw new Error('无效的 .jsonz 数据（长度不足 5 字节）。');
  }
  const expectedLen = buf.readUInt32LE(0);
  if (expectedLen === 0 || expectedLen > MAX_JSONZ_BYTES) {
    throw new Error(`无效的 .jsonz 声明长度 (${expectedLen})。`);
  }
  const compressed = buf.subarray(4);
  let inflated;
  try {
    inflated = inflateRawSync(compressed, { maxOutputLength: MAX_JSONZ_BYTES });
  } catch {
    inflated = inflateSync(compressed, { maxOutputLength: MAX_JSONZ_BYTES });
  }
  const text = inflated.toString('utf8');
  return JSON.parse(text);
}

/**
 * Build a batched single-SSH read-only probe script for central Mesh, Geek graphs, scenes, and logs.
 * @param {{
 *   routerDid?: string;
 *   includeLogs?: boolean;
 *   logLimit?: number;
 *   includeCloudScenes?: boolean;
 *   includeGraphContents?: boolean;
 * }} [opts]
 * @returns {string}
 */
export function buildCentralOverviewScript({
  routerDid = '',
  includeLogs = true,
  logLimit = 40,
  includeCloudScenes = true,
  includeGraphContents = false,
} = {}) {
  const cleanDid = /^[A-Za-z0-9._-]{1,64}$/.test(String(routerDid ?? '').trim())
    ? String(routerDid).trim()
    : '';
  const safeLimit = clampInt(logLimit, 1, 200) ?? 40;
  const lines = [
    `MQTT_PID=$(pidof central_service | awk '{print $1}')`,
    `[ -n "$MQTT_PID" ] || { echo "central_service not running" >&2; exit 3; }`,
    `ROOT="/proc/$MQTT_PID/root"`,
    `echo ${MARKERS.pid}`,
    `echo "$MQTT_PID"`,
    `echo ${MARKERS.gw}`,
    `chroot "$ROOT" /usr/bin/mips_callapi --topic local/baseGw/getGwStatus --timeout 2500 2>&1 || true; echo ""`,
    `echo ${MARKERS.role}`,
    ...(cleanDid
      ? [`chroot "$ROOT" /usr/bin/mips_callapi --topic local/central/getRole --payload ${shellQuote(JSON.stringify({ did: cleanDid }))} --timeout 2000 2>&1 || true; echo ""`]
      : [`echo "{}"`]),
    `echo ${MARKERS.gwList}`,
    `chroot "$ROOT" /usr/bin/mips_callapi --topic local/central/getGwList --timeout 2000 2>&1 || true; echo ""`,
    `echo ${MARKERS.btStatus}`,
    `chroot "$ROOT" /usr/bin/mips_callapi --topic local/bt/getServiceStatus --timeout 2000 2>&1 || true; echo ""`,
    `echo ${MARKERS.btDevs}`,
    `chroot "$ROOT" /usr/bin/mips_callapi --topic local/bt/getDevList --timeout 2000 2>&1 || true; echo ""`,
    `echo ${MARKERS.port}`,
    `chroot "$ROOT" /usr/bin/mgetprop ro.sys.webcfgport 2>/dev/null || true; echo ""`,
    `echo ${MARKERS.geekReady}`,
    `chroot "$ROOT" /usr/bin/mips_callapi --topic local/autoLocal/getServiceReady --timeout 2000 2>&1 || true; echo ""`,
    `echo ${MARKERS.geekList}`,
    `chroot "$ROOT" /usr/bin/mips_callapi --topic local/autoLocal/getGraphList --timeout 2500 2>&1 || true; echo ""`,
    `echo ${MARKERS.varScopes}`,
    `chroot "$ROOT" /usr/bin/mips_callapi --topic local/autoLocal/getVarScopeList --timeout 2000 2>&1 || true; echo ""`,
    `echo ${MARKERS.scenes}`,
    `chroot "$ROOT" /usr/bin/mips_callapi --topic local/automation/getMijiaActionGroupList --timeout 2500 2>&1 || true; echo ""`,
  ];

  if (includeCloudScenes) {
    lines.push(
      `echo ${MARKERS.cloudGraphs}`,
      `for f in /data/other/central/share/custom/automation/cloudGraphs/*.jsonz; do [ -f "$f" ] || continue; printf 'FILE:%s\\n' "\${f##*/}"; base64 "$f" | tr -d '\\n'; printf '\\n'; done`,
    );
  }
  if (includeGraphContents) {
    lines.push(
      `echo ${MARKERS.geekGraphs}`,
      `for f in /data/other/central/share/custom/autoLocal/graphs/*.jsonz; do [ -f "$f" ] || continue; printf 'FILE:%s\\n' "\${f##*/}"; base64 "$f" | tr -d '\\n'; printf '\\n'; done`,
    );
  }
  if (includeLogs) {
    lines.push(
      `echo ${MARKERS.logs}`,
      `tail -n ${safeLimit} /data/other/central/local/autoLocal/log/0.log 2>/dev/null || true`,
    );
  }
  return lines.join('\n');
}

function tryParseJsonText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || (!line.startsWith('{') && !line.startsWith('['))) continue;
      try {
        return JSON.parse(line);
      } catch {
        // continue
      }
    }
    return undefined;
  }
}

function splitMarkerSections(stdout) {
  /** @type {Set<string>} */
  const known = new Set(Object.values(MARKERS));
  /** @type {Record<string, string>} */
  const sections = {};
  let active = '';
  /** @type {string[]} */
  let buf = [];
  for (const rawLine of String(stdout ?? '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (known.has(trimmed)) {
      if (active) sections[active] = buf.join('\n');
      active = trimmed;
      buf = [];
    } else if (active) {
      buf.push(rawLine);
    }
  }
  if (active) sections[active] = buf.join('\n');
  return sections;
}

function parseJsonzBlock(sectionText) {
  /** @type {Record<string, any>} */
  const out = {};
  const lines = String(sectionText ?? '').split(/\r?\n/);
  let currentId = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('FILE:')) {
      const filename = line.slice(5).trim();
      currentId = filename.replace(/\.jsonz$/i, '');
      continue;
    }
    if (currentId) {
      try {
        out[currentId] = decodeCentralJsonz(line);
      } catch {
        // ignore corrupted file entry
      }
      currentId = '';
    }
  }
  return out;
}

/**
 * Parse the batched overview script output into structured gateway, Geek, scene, and log data.
 * @param {string} stdout
 * @param {{ routerHostFallback?: string }} [opts]
 */
export function parseCentralOverviewOutput(stdout, { routerHostFallback = '' } = {}) {
  const sec = splitMarkerSections(stdout);
  const pidMatch = String(sec[MARKERS.pid] ?? '').trim().match(/^\d+/);
  const centralPid = pidMatch ? Number(pidMatch[0]) : null;

  const gwObj = tryParseJsonText(sec[MARKERS.gw]);
  const gwRes = gwObj && !gwObj.error && gwObj.result && typeof gwObj.result === 'object' ? gwObj.result : {};

  const roleObj = tryParseJsonText(sec[MARKERS.role]);
  const roleNum = roleObj && !roleObj.error && typeof roleObj.result === 'number' ? roleObj.result : undefined;

  const gwListObj = tryParseJsonText(sec[MARKERS.gwList]);
  const subGateways = gwListObj && !gwListObj.error && Array.isArray(gwListObj.result?.list)
    ? gwListObj.result.list
    : [];

  const btStatusObj = tryParseJsonText(sec[MARKERS.btStatus]);
  const btService = btStatusObj && !btStatusObj.error && typeof btStatusObj === 'object'
    ? {
        id: btStatusObj.id,
        version: typeof btStatusObj.version === 'string' ? btStatusObj.version : '',
      }
    : { version: '' };

  const btDevsObj = tryParseJsonText(sec[MARKERS.btDevs]);
  const btMeshDids = btDevsObj && !btDevsObj.error && btDevsObj.devices && typeof btDevsObj.devices === 'object'
    ? Object.keys(btDevsObj.devices)
    : [];

  const portNum = clampInt(String(sec[MARKERS.port] ?? '').trim(), 1, 65535) ?? 8086;
  const hostFromSsh = String(routerHostFallback ?? '').replace(/^[^@]*@/, '').split(':')[0]?.replace(/^\[|\]$/g, '') ?? '';
  const gwIp = typeof gwRes.ip === 'string' && gwRes.ip.trim() ? gwRes.ip.trim() : hostFromSsh;
  const geekUrl = buildSafeGeekUrl(gwIp, portNum);

  const geekReadyObj = tryParseJsonText(sec[MARKERS.geekReady]);
  const geekReady = Boolean(geekReadyObj && !geekReadyObj.error && geekReadyObj.result === true);

  const geekListObj = tryParseJsonText(sec[MARKERS.geekList]);
  const geekGraphs = Array.isArray(geekListObj) ? geekListObj : [];

  const varScopesObj = tryParseJsonText(sec[MARKERS.varScopes]);
  const varScopes = varScopesObj && !varScopesObj.error && Array.isArray(varScopesObj.scopes)
    ? varScopesObj.scopes.map(s => String(s))
    : [];

  const scenesObj = tryParseJsonText(sec[MARKERS.scenes]);
  const actionGroupIds = scenesObj && !scenesObj.error && Array.isArray(scenesObj.result)
    ? scenesObj.result.map(id => String(id))
    : [];

  const cloudScenesById = parseJsonzBlock(sec[MARKERS.cloudGraphs]);
  const geekGraphBodiesById = parseJsonzBlock(sec[MARKERS.geekGraphs]);
  const rawLogText = String(sec[MARKERS.logs] ?? '');

  return {
    centralPid,
    gateway: {
      online: gwRes.online === true,
      bindStatus: gwRes.bindStatus === true,
      homeId: typeof gwRes.homeid === 'string' ? gwRes.homeid : '',
      homeName: typeof gwRes.homeName === 'string' ? gwRes.homeName : '',
      linkType: typeof gwRes.linkType === 'number' ? gwRes.linkType : undefined,
      ip: gwIp,
      role: roleNum,
      roleLabel: roleNum === 1 ? '主中枢' : roleNum === 2 ? '从网关' : '中枢网关',
      geekPort: portNum,
      geekUrl,
    },
    subGateways,
    btService,
    btMeshDids,
    geekReady,
    geekUrl,
    geekGraphs,
    geekGraphBodiesById,
    varScopes,
    actionGroupIds,
    cloudScenesById,
    rawLogText,
  };
}

/**
 * Default SSH fetcher for central overview data.
 * @param {{
 *   target: import('../_shared/types.d.ts').SshTarget;
 *   sshText: (target: any, cmd: string, timeoutMs?: number) => Promise<import('../_shared/types.d.ts').SshExecResult>;
 *   routerDid?: string;
 *   includeLogs?: boolean;
 *   logLimit?: number;
 *   includeCloudScenes?: boolean;
 *   includeGraphContents?: boolean;
 *   timeoutMs?: number;
 * }} opts
 */
export async function defaultFetchCentralOverview({
  target,
  sshText,
  routerDid = '',
  includeLogs = true,
  logLimit = 40,
  includeCloudScenes = true,
  includeGraphContents = false,
  timeoutMs = 15_000,
}) {
  const script = buildCentralOverviewScript({
    routerDid,
    includeLogs,
    logLimit,
    includeCloudScenes,
    includeGraphContents,
  });
  const res = await sshText(target, script, timeoutMs);
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '').trim();
  if (res.code !== 0 && !stdout.includes(MARKERS.pid)) {
    throw new Error(`读取中枢总览失败 (ssh code=${res.code})：${stderr.slice(0, 200) || '无输出'}`);
  }
  const hostFallback = String(target?.userHost ?? '');
  return parseCentralOverviewOutput(stdout, { routerHostFallback: hostFallback });
}

/**
 * Parse `/data/other/central/local/autoLocal/log/0.log` lines into newest-first entries.
 * @param {string} rawText
 * @param {{ graphNameById?: Map<string, string> | Record<string, string>; graphId?: string; limit?: number }} [opts]
 */
export function parseAutoLocalLogs(rawText, { graphNameById = new Map(), graphId = '', limit = 40 } = {}) {
  const filterId = String(graphId ?? '').trim();
  const maxEntries = clampInt(limit, 1, 200) ?? 40;
  const resolveName = id => {
    if (graphNameById instanceof Map) return graphNameById.get(id) || id;
    if (graphNameById && typeof graphNameById === 'object') return graphNameById[id] || id;
    return id;
  };
  /** @type {any[]} */
  const entries = [];
  for (const rawLine of String(rawText ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const level = Number(parts[0]);
    const ts = Number(parts[1]);
    const kind = parts[2];
    const gId = String(parts[3] ?? '').trim();
    if (!Number.isFinite(ts) || !gId) continue;
    if (filterId && gId !== filterId) continue;
    const graphName = resolveName(gId);

    if (kind === 'r') {
      const detail = parts.slice(4).join('|');
      let summary = detail;
      let ok = true;
      try {
        const obj = JSON.parse(detail);
        if (obj && typeof obj === 'object' && typeof obj.enable === 'boolean') {
          summary = obj.enable ? '启用自动化规则' : '停用自动化规则';
        }
      } catch {
        // keep raw detail
      }
      entries.push({ ts, level, type: 'rule', graphId: gId, graphName, detail, ok, summary });
    } else if (kind === 'l') {
      const from = parts[4] ?? '';
      const to = parts[5] ?? '';
      const arg = parts.slice(6).join('|');
      const argNote = arg && arg !== 'null' ? ` (${arg})` : '';
      entries.push({
        ts,
        level,
        type: 'link',
        graphId: gId,
        graphName,
        from,
        to,
        detail: arg,
        summary: `触发连线 ${from} → ${to}${argNote}`,
      });
    } else if (kind === 'i') {
      const nodeId = parts[4] ?? '';
      const detail = parts.slice(5).join('|');
      const isOk = detail === 'success';
      const isErr = !isOk && /(?:error|fail|timeout|invalid)/i.test(detail);
      const summary = isOk
        ? `节点 ${nodeId} 执行成功`
        : isErr
          ? `节点 ${nodeId} 执行失败：${detail}`
          : `节点 ${nodeId}：${detail}`;
      entries.push({
        ts,
        level,
        type: 'node',
        graphId: gId,
        graphName,
        nodeId,
        detail,
        ...(isOk ? { ok: true } : isErr ? { ok: false } : {}),
        summary,
      });
    } else {
      const detail = parts.slice(4).join('|');
      entries.push({ ts, level, type: 'other', graphId: gId, graphName, detail, summary: detail });
    }
  }
  return entries.reverse().slice(0, maxEntries);
}

function lookupDevice(devicesByDid, did) {
  const key = String(did ?? '').trim();
  if (!key) return undefined;
  if (devicesByDid instanceof Map) return devicesByDid.get(key);
  if (devicesByDid && typeof devicesByDid === 'object') return devicesByDid[key];
  return undefined;
}

function deviceFullLabel(devicesByDid, did) {
  const key = String(did ?? '').trim();
  const dev = lookupDevice(devicesByDid, key);
  if (!dev) return key ? `设备(${key})` : '未知设备';
  const room = dev.room_name ?? dev.room ?? '';
  const name = dev.dev_name ?? dev.name ?? key;
  if (!room || name.startsWith(room)) return name;
  return `${room}${name}`;
}

function pad2(n) {
  return String(Math.max(0, Math.floor(Number(n) || 0))).padStart(2, '0');
}

function describeFilter(filter) {
  if (!filter || typeof filter !== 'object') return '每天';
  const parts = [];
  if (Array.isArray(filter.day) && filter.day.length > 0) {
    parts.push(filter.day.map(d => WEEKDAY_LABELS[Number(d)] ?? `周${d}`).join('/'));
  }
  if (filter.inHoliday === true) parts.push('节假日');
  else if (filter.inHoliday === false) parts.push('工作日');
  return parts.length ? parts.join(' ') : '每天';
}

function describeGeekNode(node, devicesByDid) {
  const type = String(node?.type ?? 'unknown');
  const p = node?.props && typeof node.props === 'object' ? node.props : {};
  switch (type) {
    case 'alarmClock': {
      const when = describeFilter(p.filter);
      if (p.isSunset) {
        const sunLabel = String(p.type ?? '').toLowerCase().includes('rise') ? '日出' : '日落';
        const offset = Number(p.offset ?? 0);
        const offsetText = offset ? `(${offset > 0 ? '+' : ''}${offset}分)` : '';
        return `${when} ${sunLabel}${offsetText}`;
      }
      const hh = pad2(p.hour);
      const mm = pad2(p.minute);
      const ss = Number(p.second ?? 0) > 0 ? `:${pad2(p.second)}` : '';
      return `${when} ${hh}:${mm}${ss}`;
    }
    case 'timeRange': {
      const s = p.start ?? {};
      const e = p.end ?? {};
      return `时段 ${pad2(s.hour)}:${pad2(s.minute)}~${pad2(e.hour)}:${pad2(e.minute)}`;
    }
    case 'deviceOutput': {
      const label = deviceFullLabel(devicesByDid, p.did);
      if (Number(p.siid) === 2 && Number(p.piid) === 1 && typeof p.value === 'boolean') {
        return `${p.value ? '打开' : '关闭'}${label}`;
      }
      if (p.aiid !== undefined) {
        return `${label} 执行动作(${p.siid}.${p.aiid})`;
      }
      return `设置 ${label} ${p.siid}.${p.piid}=${JSON.stringify(p.value)}`;
    }
    case 'deviceInput': {
      const label = deviceFullLabel(devicesByDid, p.did);
      if (p.eiid !== undefined) return `当${label}触发事件(${p.siid}.${p.eiid})`;
      return `当${label}状态(${p.siid}.${p.piid})`;
    }
    case 'deviceGet':
      return `读取${deviceFullLabel(devicesByDid, p.did)}(${p.siid}.${p.piid})`;
    case 'delay':
      return `延迟 ${p.timeout ?? p.delay ?? 0}ms`;
    case 'varGet':
      return `读取变量 ${p.scope ?? ''}.${p.id ?? ''}`;
    case 'varSetNumber':
    case 'varSetString':
      return `设置变量 ${p.scope ?? ''}.${p.id ?? ''}=${JSON.stringify(p.value)}`;
    case 'varChange':
      return `当变量 ${p.scope ?? ''}.${p.id ?? ''} 变化`;
    case 'logicAnd':
      return '逻辑与(AND)';
    case 'logicOr':
      return '逻辑或(OR)';
    case 'logicNot':
      return '逻辑非(NOT)';
    case 'signalOr':
      return '信号合并(OR)';
    case 'condition':
      return '条件判断';
    case 'onlyNTimes':
      return `限执行 ${p.n ?? ''} 次`;
    case 'modeSwitch':
      return '模式切换';
    case 'onLoad':
      return '规则启动时';
    default:
      return type;
  }
}

/**
 * Produce a human-readable summary for a Geek Edition graph and its metadata config.
 * @param {any} graph
 * @param {any} cfg
 * @param {Map<string, any> | Record<string, any>} [devicesByDid]
 */
export function summarizeGeekGraph(graph, cfg, devicesByDid = new Map()) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const id = String(cfg?.id ?? graph?.id ?? '');
  const name = String(cfg?.userData?.name ?? id);
  const enable = cfg?.enable === true;
  const uiType = typeof cfg?.uiType === 'string' ? cfg.uiType : 'test';
  const lastUpdateTime = typeof cfg?.userData?.lastUpdateTime === 'number' ? cfg.userData.lastUpdateTime : undefined;

  const nodeById = new Map(nodes.map(n => [String(n.id), n]));
  const incoming = new Set();
  for (const n of nodes) {
    const outs = n?.outputs && typeof n.outputs === 'object' ? Object.values(n.outputs) : [];
    for (const targets of outs) {
      if (!Array.isArray(targets)) continue;
      for (const targetRef of targets) {
        const targetId = String(targetRef ?? '').split('.')[0];
        if (targetId) incoming.add(targetId);
      }
    }
  }

  /** @type {string[]} */
  const chains = [];
  const roots = nodes.filter(n => !incoming.has(String(n.id)));
  const walk = (node, trail, seen) => {
    const idStr = String(node.id);
    if (seen.has(idStr)) return;
    const nextSeen = new Set(seen);
    nextSeen.add(idStr);
    const label = describeGeekNode(node, devicesByDid);
    const nextTrail = [...trail, label];
    const outs = node?.outputs && typeof node.outputs === 'object' ? Object.values(node.outputs) : [];
    /** @type {any[]} */
    const nextNodes = [];
    for (const targets of outs) {
      if (!Array.isArray(targets)) continue;
      for (const ref of targets) {
        const tid = String(ref ?? '').split('.')[0];
        const targetNode = nodeById.get(tid);
        if (targetNode && !nextNodes.includes(targetNode)) nextNodes.push(targetNode);
      }
    }
    if (nextNodes.length === 0) {
      chains.push(nextTrail.join(' → '));
    } else {
      for (const child of nextNodes) walk(child, nextTrail, nextSeen);
    }
  };
  for (const root of roots) {
    walk(root, [], new Set());
  }
  if (chains.length === 0 && nodes.length > 0) {
    for (const n of nodes) chains.push(describeGeekNode(n, devicesByDid));
  }

  const nodeTypes = [...new Set(nodes.map(n => String(n?.type ?? 'unknown')))];
  const steps = nodes.map(n => ({
    id: String(n.id),
    type: String(n.type),
    description: describeGeekNode(n, devicesByDid),
  }));

  return {
    id,
    name,
    enable,
    uiType,
    ...(lastUpdateTime !== undefined ? { lastUpdateTime } : {}),
    nodeCount: nodes.length,
    nodeTypes,
    steps,
    summary: chains.length > 0 ? chains.join('；') : (nodes.length === 0 ? '尚未读取节点图' : '空规则'),
  };
}

/**
 * Summarize a decoded local Mi Home scene (`cloudGraphs/<id>.jsonz`).
 * @param {string} id
 * @param {any} decodedGraph
 * @param {Map<string, any> | Record<string, any>} [devicesByDid]
 * @param {(device: any) => unknown} [isProtectedFn]
 */
export function summarizeCloudScene(id, decodedGraph, devicesByDid = new Map(), isProtectedFn = undefined) {
  const nodes = Array.isArray(decodedGraph?.nodes) ? decodedGraph.nodes : [];
  /** @type {any[]} */
  const actions = [];
  let signature = '';
  let touchesProtected = false;
  let turnsOffProtected = false;

  for (const n of nodes) {
    if (n?.type === 'hyperLinkTarget' && typeof n.props?.signature === 'string') {
      signature = n.props.signature;
    }
    if (n?.type === 'legacyRPC' && n.props) {
      const did = String(n.props.did ?? '');
      const method = String(n.props.method ?? '');
      const dev = lookupDevice(devicesByDid, did);
      const devLabel = deviceFullLabel(devicesByDid, did);
      const isProt = Boolean(dev && typeof isProtectedFn === 'function' && isProtectedFn(dev));
      if (isProt) touchesProtected = true;

      if (method === 'set_properties' && Array.isArray(n.props.params)) {
        for (const p of n.props.params) {
          const pDid = String(p?.did ?? did);
          const pDev = lookupDevice(devicesByDid, pDid) ?? dev;
          const pLabel = deviceFullLabel(devicesByDid, pDid);
          const pProt = Boolean(pDev && typeof isProtectedFn === 'function' && isProtectedFn(pDev));
          if (pProt) touchesProtected = true;
          const siid = Number(p?.siid);
          const piid = Number(p?.piid);
          const value = p?.value;
          if (pProt && siid === 2 && piid === 1 && (value === false || value === 0)) {
            turnsOffProtected = true;
          }
          const text = siid === 2 && piid === 1 && typeof value === 'boolean'
            ? `${value ? '打开' : '关闭'}${pLabel}`
            : `设置 ${pLabel} (${siid}.${piid}=${JSON.stringify(value)})`;
          actions.push({ did: pDid, deviceName: pLabel, method, siid, piid, value, protected: pProt, text });
        }
      } else {
        actions.push({ did, deviceName: devLabel, method, params: n.props.params, protected: isProt, text: `${devLabel} ${method}` });
      }
    }
  }

  const tsSec = typeof decodedGraph?.cfg?.ts === 'number' ? decodedGraph.cfg.ts : undefined;
  return {
    id: String(id),
    signature: signature || `user.click_${id}`,
    ...(tsSec !== undefined ? { updatedAt: tsSec * 1000 } : {}),
    mijiaActionGroup: decodedGraph?.cfg?.mijiaActionGroup === true,
    actions,
    touchesProtected,
    turnsOffProtected,
    summary: actions.length > 0 ? actions.map(a => a.text).join(' → ') : `本地场景 ${id}`,
  };
}

function makeGeekNodeId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function parseTimeSpec(raw) {
  const text = String(raw ?? '').trim();
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!m) {
    throw new Error(`无效的时间格式 "${text}"，请使用 HH:MM 或 HH:MM:SS（如 16:00）。`);
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = m[3] ? Number(m[3]) : 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59 || !Number.isInteger(second) || second < 0 || second > 59) {
    throw new Error(`时间超出合法范围 "${text}"（小时 0-23，分钟/秒 0-59）。`);
  }
  return { hour, minute, second };
}

/**
 * Build a validated Geek Edition schedule graph payload ready for `local/autoLocal/setGraph`.
 * @param {{
 *   id?: string;
 *   name: string;
 *   enable?: boolean;
 *   rules: Array<{ time: string; device?: string; did?: string; room?: string; on?: boolean; siid?: number; piid?: number; value?: unknown; days?: number[] }>;
 *   resolveDeviceFn: (rule: any) => any;
 *   nowMs?: number;
 * }} opts
 */
export function buildScheduleGeekGraph({
  id = undefined,
  name,
  enable = true,
  rules,
  resolveDeviceFn,
  nowMs = Date.now(),
}) {
  const cleanName = String(name ?? '').trim();
  if (!cleanName || cleanName.length > 64) {
    throw new Error('规则名称不能为空且不能超过 64 个字符。');
  }
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > 12) {
    throw new Error('rules 必须包含 1 到 12 条定时动作。');
  }
  const graphId = id ? validateGraphId(id) : String(Math.floor(nowMs));
  /** @type {any[]} */
  const nodes = [];
  const usedIds = new Set();
  const nextId = () => {
    let candidate = makeGeekNodeId();
    while (usedIds.has(candidate)) candidate = makeGeekNodeId();
    usedIds.add(candidate);
    return candidate;
  };

  rules.forEach((rule, idx) => {
    if (!rule || typeof rule !== 'object') {
      throw new Error(`第 ${idx + 1} 条规则无效。`);
    }
    const { hour, minute, second } = parseTimeSpec(rule.time);
    const dev = resolveDeviceFn(rule);
    if (!dev || !dev.did) {
      throw new Error(`第 ${idx + 1} 条规则未能解析目标设备。`);
    }
    if (!dev.urn) {
      throw new Error(`设备 "${dev.dev_name ?? dev.name ?? dev.did}" 缺少 URN，无法写入极客版节点。`);
    }
    let siid;
    let piid;
    let value;
    if (typeof rule.on === 'boolean') {
      siid = 2;
      piid = 1;
      value = rule.on;
    } else if (rule.siid !== undefined && rule.piid !== undefined && rule.value !== undefined) {
      siid = clampInt(rule.siid, 0, 999);
      piid = clampInt(rule.piid, 0, 999);
      if (siid === undefined || piid === undefined) {
        throw new Error(`第 ${idx + 1} 条规则的 siid/piid 必须为非负整数。`);
      }
      value = rule.value;
    } else {
      throw new Error(`第 ${idx + 1} 条规则请指定 on:true/false 或 siid/piid/value。`);
    }

    /** @type {Record<string, unknown>} */
    const filter = {};
    if (Array.isArray(rule.days) && rule.days.length > 0) {
      const cleanDays = [...new Set(rule.days.map(d => clampInt(d, 0, 6)).filter(d => d !== undefined))];
      if (cleanDays.length === 0) {
        throw new Error(`第 ${idx + 1} 条规则的 days 必须是 0-6 的星期整数数组（0=周日）。`);
      }
      filter.day = cleanDays;
    }

    const alarmId = nextId();
    const outId = nextId();
    const yBase = 60 + idx * 240;

    nodes.push({
      id: alarmId,
      type: 'alarmClock',
      cfg: {
        happenType: 'now',
        tempOffset: 0,
        pos: { x: 70, y: yBase, width: 416, height: 112 },
        name: 'alarmClock',
        version: 0,
      },
      inputs: {},
      outputs: { output: [`${outId}.trigger`] },
      props: {
        type: 'periodicAlarm',
        isSunset: false,
        hour,
        minute,
        second,
        filter,
      },
    });

    nodes.push({
      id: outId,
      type: 'deviceOutput',
      cfg: {
        urn: String(dev.urn),
        pos: { x: 720, y: yBase - 20, width: 528, height: 164 },
        name: 'deviceOutput',
        version: 1,
      },
      inputs: { trigger: null },
      outputs: { output: [] },
      props: {
        did: String(dev.did),
        siid,
        piid,
        value,
      },
    });
  });

  const cfg = {
    id: graphId,
    userData: {
      name: cleanName,
      transform: { x: 0, y: 0, scale: 1, rotate: 0 },
      lastUpdateTime: nowMs,
      version: 0,
    },
    uiType: 'test',
    enable: Boolean(enable),
  };

  return { id: graphId, nodes, cfg };
}

/**
 * Read sanitized central cache (`central-cache.json`).
 * @param {string | undefined} cachePath
 * @returns {Record<string, any> | null}
 */
export function readCentralCache(cachePath) {
  if (!cachePath) return null;
  const parsed = readJsonSafe(cachePath, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return sanitizeCentralValue(parsed);
}

/**
 * Persist sanitized central cache (`central-cache.json`) with 0o600 permissions.
 * @param {string | undefined} cachePath
 * @param {Record<string, any>} data
 */
export function writeCentralCache(cachePath, data) {
  if (!cachePath || !data || typeof data !== 'object') return;
  try {
    writeJsonAtomic(cachePath, { version: 1, ...sanitizeCentralValue(data) }, { mode: 0o600 });
  } catch {
    // best-effort cache
  }
}

export { errMsg };

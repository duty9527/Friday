import {
  constants as cryptoConstants,
  createCipheriv,
  createDecipheriv,
  createHash,
  publicEncrypt,
  randomBytes,
  randomInt,
} from 'node:crypto';

export const PASSPORT_CLIENT_ID = 'vehicle_app_prod';
export const PASSPORT_CLIENT_KEY = 'e177176a-3b3e-1513-e26e-d1123034cb66';

export const CHARSET_KREQ =
  '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
export const CHARSET_KEYDATA4 =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789;-_.,+/';
export const CHARSET_HEX = '0123456789abcdef';

// Live server N1 RSA-1024 SPKI public key used by the Netease ("NET") business envelope.
export const RSA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDT3m0c/8y9c13PzaFbATEg+Zwd
kpPcCy0V21VKBBSx16ckVtLERAQ7EH8d6DqgEbyzayAwlQd1gDhUmx27hDWafXr9
/evUZkkBegcsNnKrIlh93lPKccjk+LDXS1TnDIIFiTlSbNnaYwehI/9pUbKCI3h7
yE0pum6hJh/9QtGPlwIDAQAB
-----END PUBLIC KEY-----`;

export const WIRE_P = '101';
export const WIRE_T = '0';
export const WRAPPER_PLATFORM = 2;

const AES_ZERO_IV = Buffer.alloc(16, 0);

/**
 * Compute Ninebot Passport `Sign` header: lowercase SHA-256 of sorted `k=v` query-style string.
 * @param {string} urlPath
 * @param {Record<string, unknown>} params
 * @returns {string}
 */
export function passportSign(urlPath, params) {
  /** @type {Record<string, string>} */
  const merged = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) {
      merged[k] = String(v);
    }
  }
  merged.clientKey = PASSPORT_CLIENT_KEY;
  merged.url = urlPath;
  const canonical = Object.keys(merged)
    .sort()
    .map(k => `${k}=${merged[k]}`)
    .join('&');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * @param {number} len
 * @param {string} charset
 * @returns {string}
 */
export function randFromCharset(len, charset) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += charset[randomInt(charset.length)];
  }
  return out;
}

/**
 * @param {number} len
 * @returns {string}
 */
export function randHex(len) {
  return randFromCharset(len, CHARSET_HEX);
}

/**
 * Generate 16-byte printable ASCII AES-128 request key.
 * @returns {Buffer}
 */
export function genKreq() {
  return Buffer.from(randFromCharset(16, CHARSET_KREQ), 'ascii');
}

/**
 * Generate the four keyData components sent to server for response key derivation.
 * @returns {{ kd1: string; kd2: string; kd3: string; kd4: string }}
 */
export function genKeyData() {
  return {
    kd1: randHex(11),
    kd2: randHex(11),
    kd3: randHex(10),
    kd4: randFromCharset(8, CHARSET_KEYDATA4),
  };
}

/**
 * Generate 32-hex nonce: first 2 hex chars lowercase, remaining 30 hex chars uppercase.
 * @returns {string}
 */
export function genNonce() {
  const h = randomBytes(16).toString('hex');
  return h.slice(0, 2).toLowerCase() + h.slice(2).toUpperCase();
}

/**
 * Unsigned 32-bit left rotation.
 * @param {number} v
 * @param {number} n
 * @returns {number}
 */
function rol32(v, n) {
  const u = v >>> 0;
  const s = n & 31;
  return s === 0 ? u : (((u << s) | (u >>> (32 - s))) >>> 0);
}

/**
 * Accumulate bytes with ROL32(8) ^ byte.
 * @param {Buffer | Uint8Array} buf
 * @returns {number}
 */
function rol8acc(buf) {
  let v = 0;
  for (const b of buf) {
    v = (rol32(v, 8) ^ b) >>> 0;
  }
  return v >>> 0;
}

/**
 * Derive 16-byte AES-128 response key from `(kd1, kd2, kd3, kd4)`.
 * @param {Buffer | Uint8Array | string} kd1
 * @param {Buffer | Uint8Array | string} kd2
 * @param {Buffer | Uint8Array | string} kd3
 * @param {Buffer | Uint8Array | string} kd4
 * @returns {Buffer}
 */
export function deriveKey(kd1, kd2, kd3, kd4) {
  const bA = typeof kd1 === 'string' ? Buffer.from(kd1, 'utf8') : kd1;
  const bB = typeof kd2 === 'string' ? Buffer.from(kd2, 'utf8') : kd2;
  const bC = typeof kd3 === 'string' ? Buffer.from(kd3, 'utf8') : kd3;
  const bD = typeof kd4 === 'string' ? Buffer.from(kd4, 'utf8') : kd4;

  const A = rol8acc(bA);
  const B = rol8acc(bB);
  const C = rol8acc(bC);
  const D = rol8acc(bD);

  const x = (A ^ C) >>> 0;
  const y = (B ^ D) >>> 0;
  const fx = (rol32(x, 8) ^ x ^ rol32(x, 24)) >>> 0;
  const gy = (rol32(y, 8) ^ y ^ rol32(y, 24)) >>> 0;

  const a1 = (A ^ gy) >>> 0;
  const b1 = (B ^ fx) >>> 0;
  const c1 = (C ^ gy) >>> 0;
  const d1 = (D ^ fx) >>> 0;

  const out3 = ((c1 & b1) ^ a1) >>> 0;
  const tmp = (~(c1 ^ d1 ^ ((c1 | d1) ^ b1))) >>> 0;
  const out2 = (out3 ^ tmp) >>> 0;
  const out1 = ((tmp | out3) ^ ((c1 | d1) ^ b1)) >>> 0;
  const out0 = (((~((c1 | d1) ^ b1)) & out2) ^ d1) >>> 0;

  const out = Buffer.allocUnsafe(16);
  out.writeUInt32LE(out0, 0);
  out.writeUInt32LE(out1, 4);
  out.writeUInt32LE(out2, 8);
  out.writeUInt32LE(out3, 12);
  return out;
}

/**
 * Android Base64 (CRLF-free LF wrap every 76 chars + trailing newline when non-empty).
 * @param {Buffer | Uint8Array | string} data
 * @returns {string}
 */
export function androidB64(data) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  if (buf.length === 0) return '';
  const b64 = buf.toString('base64');
  /** @type {string[]} */
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Escape string identically to Ninebot Go `jsonEscapeString` (only `"`, `\`, `\n`, `\r`, `\t`).
 * Preserves `<`, `>`, `&`, and UTF-8 characters verbatim.
 * @param {string} s
 * @returns {string}
 */
export function jsonEscape(s) {
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else out += ch;
  }
  out += '"';
  return out;
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function serializeJsonValue(v) {
  if (typeof v === 'string') return jsonEscape(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) {
    return `[${v.map(item => serializeJsonValue(item)).join(',')}]`;
  }
  if (v instanceof Map) {
    const parts = [];
    for (const [k, item] of v.entries()) {
      parts.push(`${jsonEscape(String(k))}:${serializeJsonValue(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  if (typeof v === 'object') {
    const parts = [];
    for (const [k, item] of Object.entries(/** @type {Record<string, unknown>} */ (v))) {
      parts.push(`${jsonEscape(String(k))}:${serializeJsonValue(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return jsonEscape(String(v));
}

/**
 * Serialize ordered `[key, value]` tuples (or Map/object) without HTML escaping or whitespace.
 * @param {Array<[string, unknown]> | Map<string, unknown> | Record<string, unknown>} entriesOrObj
 * @returns {string}
 */
export function orderedJsonDumps(entriesOrObj) {
  if (Array.isArray(entriesOrObj)) {
    const parts = entriesOrObj.map(([k, v]) => `${jsonEscape(String(k))}:${serializeJsonValue(v)}`);
    return `{${parts.join(',')}}`;
  }
  return serializeJsonValue(entriesOrObj);
}

/**
 * Build inner business JSON string with trailing uppercase MD5 `checkcode`.
 * @param {Array<[string, unknown]> | Map<string, unknown> | Record<string, unknown>} entriesOrObj
 * @returns {string}
 */
export function buildInner(entriesOrObj) {
  /** @type {Array<[string, unknown]>} */
  const entries = Array.isArray(entriesOrObj)
    ? entriesOrObj.map(([k, v]) => [String(k), v])
    : entriesOrObj instanceof Map
      ? Array.from(entriesOrObj.entries()).map(([k, v]) => [String(k), v])
      : Object.entries(entriesOrObj || {});
  const noCheck = entries.filter(([k]) => k !== 'checkcode');
  const rawNoCheck = orderedJsonDumps(noCheck);
  const checkcode = createHash('md5').update(rawNoCheck, 'utf8').digest('hex').toUpperCase();
  return orderedJsonDumps([...noCheck, ['checkcode', checkcode]]);
}

/**
 * Build plaintext wrapper JSON matching Ninebot Go `BuildWrapper` formatting.
 * @param {Buffer | Uint8Array | string} innerBytes
 * @param {{ kd1: string; kd2: string; kd3: string; kd4: string }} keyData
 * @param {number} [platform]
 * @param {number} [timestampSec]
 * @returns {string}
 */
export function buildWrapper(innerBytes, keyData, platform = WRAPPER_PLATFORM, timestampSec) {
  const ts = typeof timestampSec === 'number' && Number.isFinite(timestampSec)
    ? Math.trunc(timestampSec)
    : Math.floor(Date.now() / 1000);
  return [
    '{\n',
    '\t"data" : ', jsonEscape(androidB64(innerBytes)), ',\n',
    '\t"keyDataFour" : "', keyData.kd4, '",\n',
    '\t"keyDataOne" : "', keyData.kd1, '",\n',
    '\t"keyDataThree" : "', keyData.kd3, '",\n',
    '\t"keyDataTwo" : "', keyData.kd2, '",\n',
    '\t"platform" : ', String(platform), ',\n',
    '\t"timeStamp" : ', String(ts), '\n}\n',
  ].join('');
}

/**
 * @param {Buffer | Uint8Array} key16
 * @param {Buffer | Uint8Array} plaintext
 * @returns {Buffer}
 */
export function aesCbcEncrypt(key16, plaintext) {
  const cipher = createCipheriv('aes-128-cbc', key16, AES_ZERO_IV);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/**
 * @param {Buffer | Uint8Array} key16
 * @param {Buffer | Uint8Array} ciphertext
 * @returns {Buffer}
 */
export function aesCbcDecrypt(key16, ciphertext) {
  const decipher = createDecipheriv('aes-128-cbc', key16, AES_ZERO_IV);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt inner business JSON bytes into wire `{ d, h, k, p, t }` envelope.
 * @param {Buffer | Uint8Array | string} innerBytes
 * @param {{
 *   aesKey?: Buffer;
 *   keyData?: { kd1: string; kd2: string; kd3: string; kd4: string };
 *   platform?: number;
 *   timestampSec?: number;
 *   rsaPublicKeyPem?: string;
 * }} [options]
 * @returns {{
 *   body: { d: string; h: string; k: string; p: string; t: string };
 *   secrets: { aesKey: Buffer; kd1: string; kd2: string; kd3: string; kd4: string };
 * }}
 */
export function buildRequest(innerBytes, options = {}) {
  const aesKey = options.aesKey ?? genKreq();
  const keyData = options.keyData ?? genKeyData();
  const platform = options.platform ?? WRAPPER_PLATFORM;
  const pubPem = options.rsaPublicKeyPem || RSA_PUBLIC_KEY_PEM;
  const wrapperStr = buildWrapper(innerBytes, keyData, platform, options.timestampSec);
  const wrapperBuf = Buffer.from(wrapperStr, 'utf8');
  const dRaw = aesCbcEncrypt(aesKey, wrapperBuf);
  const h = createHash('md5').update(wrapperBuf).digest('hex');
  const kRaw = publicEncrypt(
    { key: pubPem, padding: cryptoConstants.RSA_PKCS1_PADDING },
    aesKey,
  );
  return {
    body: {
      d: dRaw.toString('base64'),
      h,
      k: kRaw.toString('base64'),
      p: WIRE_P,
      t: WIRE_T,
    },
    secrets: {
      aesKey,
      ...keyData,
    },
  };
}

/**
 * Alias matching plan naming (`encryptRequest` returns `{ body, secrets }`).
 */
export const encryptRequest = buildRequest;

/**
 * Decrypt `{"r": "..."}` response into wrapper plaintext bytes.
 * @param {string} rB64
 * @param {{ kd1: string; kd2: string; kd3: string; kd4: string }} keyData
 * @returns {Buffer}
 */
export function decryptResponse(rB64, keyData) {
  const cleaned = String(rB64 || '').replace(/\s+/g, '');
  if (!cleaned) {
    throw new Error('响应缺少加密载荷 r');
  }
  const key = deriveKey(keyData.kd1, keyData.kd2, keyData.kd3, keyData.kd4);
  return aesCbcDecrypt(key, Buffer.from(cleaned, 'base64'));
}

/**
 * Unwrap decrypted wrapper JSON (`{"data": b64(...) }`) into parsed inner business JSON object.
 * @param {Buffer | string} plain
 * @returns {Record<string, unknown>}
 */
export function unwrapResponse(plain) {
  const text = Buffer.isBuffer(plain) ? plain.toString('utf8') : String(plain);
  const outer = JSON.parse(text);
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) {
    throw new Error('响应包装体格式无效');
  }
  const innerB64 = outer.data;
  if (typeof innerB64 !== 'string' || !innerB64.trim()) {
    // Some endpoints might occasionally place business JSON directly at outer level
    if ('code' in outer) {
      return outer;
    }
    throw new Error('响应包装体缺少 data 字段');
  }
  const decoded = Buffer.from(innerB64.replace(/\s+/g, ''), 'base64').toString('utf8');
  const inner = JSON.parse(decoded);
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) {
    throw new Error('内层业务响应非 JSON 对象');
  }
  return inner;
}

/**
 * Full wire response decryption + unwrap pipeline.
 * @param {{ r?: unknown }} respObj
 * @param {{ kd1: string; kd2: string; kd3: string; kd4: string }} secrets
 * @returns {Record<string, unknown>}
 */
export function decryptWireResponse(respObj, secrets) {
  if (!respObj || typeof respObj.r !== 'string' || !respObj.r.trim()) {
    throw new Error('业务响应缺少 r 字段');
  }
  const plain = decryptResponse(respObj.r, secrets);
  return unwrapResponse(plain);
}

/**
 * @param {number} lon
 * @param {number} lat
 * @returns {boolean}
 */
function outOfChina(lon, lat) {
  return !(lon > 72.004 && lon < 137.8347 && lat > 0.8293 && lat < 55.8271);
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320.0 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

/**
 * @param {number} x
 * @param {number} y
 * @returns {number}
 */
function transformLon(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return ret;
}

/**
 * Convert WGS-84 coordinates (reported by Ninebot GPS) to GCJ-02 (used by AMap/Gaode).
 * @param {number} lat
 * @param {number} lon
 * @returns {{ lat: number; lon: number }}
 */
export function wgs84ToGcj02(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { lat, lon };
  }
  if ((lat === 0 && lon === 0) || outOfChina(lon, lat)) {
    return { lat, lon };
  }
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return {
    lat: Number((lat + dLat).toFixed(6)),
    lon: Number((lon + dLon).toFixed(6)),
  };
}

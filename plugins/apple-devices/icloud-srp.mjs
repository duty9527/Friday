import { createHash, pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * RFC 5054 Appendix A 2048-bit SRP Group prime N (256 bytes) used by Apple IDMSa SRP-6a.
 */
export const SRP_2048_N_HEX = [
  'AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050',
  'A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50',
  'E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B8',
  '55F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773B',
  'CA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748',
  '544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6',
  'AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB6',
  '94B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73',
].join('');

export const SRP_N = BigInt(`0x${SRP_2048_N_HEX}`);
export const SRP_N_BUF = Buffer.from(SRP_2048_N_HEX, 'hex');
export const SRP_N_BYTES = SRP_N_BUF.length; // 256
export const SRP_G = 2n;
export const SRP_G_MIN_BUF = Buffer.from([0x02]);

/**
 * @param {Buffer} buf
 * @returns {Buffer}
 */
function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

/**
 * @param {Buffer} buf
 * @returns {bigint}
 */
export function bytesToBigInt(buf) {
  if (!buf || buf.length === 0) return 0n;
  return BigInt(`0x${buf.toString('hex')}`);
}

/**
 * Minimal big-endian unsigned byte encoding matching Python `long_to_bytes`.
 * @param {bigint} n
 * @returns {Buffer}
 */
export function bigIntToMinBytes(n) {
  if (n < 0n) {
    throw new RangeError('bigIntToMinBytes expects non-negative BigInt');
  }
  if (n === 0n) {
    return Buffer.from([0x00]);
  }
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Left-pad an unsigned big-endian Buffer with zero bytes up to `len`.
 * @param {Buffer} buf
 * @param {number} [len]
 * @returns {Buffer}
 */
export function padBytes(buf, len = SRP_N_BYTES) {
  if (buf.length === len) return buf;
  if (buf.length > len) {
    throw new RangeError(`Buffer length (${buf.length}) exceeds target width (${len})`);
  }
  const out = Buffer.alloc(len);
  buf.copy(out, len - buf.length);
  return out;
}

/**
 * Modular exponentiation `(base ** exp) % mod`.
 * @param {bigint} base
 * @param {bigint} exp
 * @param {bigint} mod
 * @returns {bigint}
 */
export function modPow(base, exp, mod) {
  if (mod <= 0n) throw new RangeError('mod must be positive');
  if (exp < 0n) throw new RangeError('exp must be non-negative');
  let result = 1n;
  let b = ((base % mod) + mod) % mod;
  let e = exp;
  while (e > 0n) {
    if ((e & 1n) === 1n) {
      result = (result * b) % mod;
    }
    e >>= 1n;
    if (e > 0n) {
      b = (b * b) % mod;
    }
  }
  return result;
}

/**
 * @param {Buffer} left
 * @param {Buffer} right
 * @returns {Buffer}
 */
function xorBuffers(left, right) {
  if (left.length !== right.length) {
    throw new RangeError('xorBuffers inputs must have identical length');
  }
  const out = Buffer.allocUnsafe(left.length);
  for (let i = 0; i < left.length; i += 1) {
    out[i] = left[i] ^ right[i];
  }
  return out;
}

/**
 * RFC 5054 multiplier `k = H(PAD(N) || PAD(g))`.
 * @returns {bigint}
 */
function computeSrpK() {
  return bytesToBigInt(sha256(Buffer.concat([SRP_N_BUF, padBytes(SRP_G_MIN_BUF, SRP_N_BYTES)])));
}

/**
 * `H(N) XOR H(PAD(g))` per RFC 5054 / pysrp `rfc5054_enable`.
 * @returns {Buffer}
 */
function computeHNxorG() {
  const hN = sha256(SRP_N_BUF);
  const hG = sha256(padBytes(SRP_G_MIN_BUF, SRP_N_BYTES));
  return xorBuffers(hN, hG);
}

/**
 * Generate client SRP ephemeral private `a` and public `A = g^a mod N`.
 * Ensures `A % N !== 0` and exact 256-byte representation to avoid padding ambiguity.
 * @returns {{ aHex: string; aBase64: string }}
 */
export function createSrpClientEphemeral() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const aBuf = randomBytes(256);
    aBuf[0] |= 0x80;
    const a = bytesToBigInt(aBuf);
    if (a === 0n) continue;
    const A = modPow(SRP_G, a, SRP_N);
    if (A % SRP_N === 0n) continue;
    const aBytes = bigIntToMinBytes(A);
    if (aBytes.length !== SRP_N_BYTES) continue;
    return {
      aHex: aBuf.toString('hex'),
      aBase64: aBytes.toString('base64'),
    };
  }
  throw new Error('Failed to generate valid 256-byte SRP ephemeral key');
}

/**
 * Derive Apple IDMSa 32-byte key from raw password using `s2k` or `s2k_fo`.
 * @param {string} password
 * @param {Buffer} saltBuf
 * @param {number} iterations
 * @param {'s2k' | 's2k_fo'} protocol
 * @returns {Buffer}
 */
export function deriveApplePasswordKey(password, saltBuf, iterations, protocol) {
  if (typeof password !== 'string' || !password) {
    throw new Error('Password must be a non-empty string');
  }
  if (!Buffer.isBuffer(saltBuf) || saltBuf.length === 0) {
    throw new Error('Salt must be a non-empty Buffer');
  }
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 5_000_000) {
    throw new Error(`Invalid PBKDF2 iteration count: ${String(iterations)}`);
  }
  if (protocol !== 's2k' && protocol !== 's2k_fo') {
    throw new Error(`Unsupported Apple SRP protocol: ${String(protocol)}`);
  }
  const pwHash = sha256(Buffer.from(password, 'utf8'));
  const pwInput = protocol === 's2k_fo'
    ? Buffer.from(pwHash.toString('hex'), 'utf8')
    : pwHash;
  return pbkdf2Sync(pwInput, saltBuf, iterations, 32, 'sha256');
}

/**
 * Apple `no_username_in_x` private key calculation:
 * `x = H(salt || H(':' || derivedKey))`.
 * @param {Buffer} saltBuf
 * @param {Buffer} derivedKey
 * @returns {bigint}
 */
export function computeAppleSrpX(saltBuf, derivedKey) {
  const inner = sha256(Buffer.concat([Buffer.from(':', 'utf8'), derivedKey]));
  return bytesToBigInt(sha256(Buffer.concat([saltBuf, inner])));
}

/**
 * Compute SRP-6a client proof `M1` and server proof `M2` for Apple `/signin/complete`.
 * @param {{
 *   accountName: string;
 *   password: string;
 *   aHex: string;
 *   saltBase64: string;
 *   bBase64: string;
 *   iterations: number;
 *   protocol: 's2k' | 's2k_fo';
 * }} params
 * @returns {{ m1Base64: string; m2Base64: string }}
 */
export function completeSrpClientChallenge(params) {
  const accountName = String(params?.accountName ?? '');
  if (!accountName) {
    throw new Error('accountName is required for SRP challenge');
  }
  const aBuf = Buffer.from(String(params?.aHex ?? ''), 'hex');
  if (aBuf.length === 0) {
    throw new Error('Invalid SRP client secret aHex');
  }
  const a = bytesToBigInt(aBuf);
  const A = modPow(SRP_G, a, SRP_N);
  const ABytes = bigIntToMinBytes(A);

  const saltBuf = Buffer.from(String(params?.saltBase64 ?? ''), 'base64');
  const bBuf = Buffer.from(String(params?.bBase64 ?? ''), 'base64');
  if (saltBuf.length === 0 || bBuf.length === 0) {
    throw new Error('Invalid base64 salt or server ephemeral B');
  }
  const B = bytesToBigInt(bBuf);
  if (B <= 0n || B % SRP_N === 0n) {
    throw new Error('SRP-6a safety check failed: invalid server ephemeral B');
  }

  const u = bytesToBigInt(
    sha256(Buffer.concat([padBytes(ABytes, SRP_N_BYTES), padBytes(bBuf, SRP_N_BYTES)])),
  );
  if (u === 0n) {
    throw new Error('SRP-6a safety check failed: u is zero');
  }

  const derivedKey = deriveApplePasswordKey(
    params.password,
    saltBuf,
    params.iterations,
    params.protocol,
  );
  const x = computeAppleSrpX(saltBuf, derivedKey);
  const k = computeSrpK();
  const gx = modPow(SRP_G, x, SRP_N);
  const base = ((B - ((k * gx) % SRP_N)) % SRP_N + SRP_N) % SRP_N;
  const exp = a + (u * x);
  const S = modPow(base, exp, SRP_N);
  const K = sha256(bigIntToMinBytes(S));

  const BBytes = bigIntToMinBytes(B);
  const hNxorG = computeHNxorG();
  const hI = sha256(Buffer.from(accountName, 'utf8'));
  const M1 = sha256(Buffer.concat([hNxorG, hI, saltBuf, ABytes, BBytes, K]));
  const M2 = sha256(Buffer.concat([ABytes, M1, K]));

  return {
    m1Base64: M1.toString('base64'),
    m2Base64: M2.toString('base64'),
  };
}

/**
 * Deterministic/random mock SRP server session helper for cryptographic verification tests.
 * @param {{
 *   accountName: string;
 *   password: string;
 *   saltBuf?: Buffer;
 *   iterations?: number;
 *   protocol?: 's2k' | 's2k_fo';
 * }} config
 */
export function createMockSrpServerSession(config) {
  const saltBuf = config.saltBuf ?? randomBytes(16);
  const iterations = config.iterations ?? 20_000;
  const protocol = config.protocol ?? 's2k_fo';
  const derivedKey = deriveApplePasswordKey(config.password, saltBuf, iterations, protocol);
  const x = computeAppleSrpX(saltBuf, derivedKey);
  const v = modPow(SRP_G, x, SRP_N);
  const k = computeSrpK();

  let b = 0n;
  let B = 0n;
  for (let i = 0; i < 32; i += 1) {
    b = bytesToBigInt(randomBytes(32));
    if (b === 0n) continue;
    B = (k * v + modPow(SRP_G, b, SRP_N)) % SRP_N;
    if (B % SRP_N !== 0n && bigIntToMinBytes(B).length === SRP_N_BYTES) break;
  }
  const BBytes = bigIntToMinBytes(B);

  return {
    saltBase64: saltBuf.toString('base64'),
    bBase64: BBytes.toString('base64'),
    iterations,
    protocol,
    /**
     * Verify client `aBase64`, `m1Base64`, `m2Base64`.
     * @param {{ aBase64: string; m1Base64: string; m2Base64?: string }} clientProof
     * @returns {{ ok: boolean; expectedM1Base64: string; expectedM2Base64: string }}
     */
    verifyClient(clientProof) {
      const aBuf = Buffer.from(clientProof.aBase64, 'base64');
      const A = bytesToBigInt(aBuf);
      if (A % SRP_N === 0n) {
        return { ok: false, expectedM1Base64: '', expectedM2Base64: '' };
      }
      const ABytes = bigIntToMinBytes(A);
      const u = bytesToBigInt(
        sha256(Buffer.concat([padBytes(ABytes, SRP_N_BYTES), padBytes(BBytes, SRP_N_BYTES)])),
      );
      const S = modPow((A * modPow(v, u, SRP_N)) % SRP_N, b, SRP_N);
      const K = sha256(bigIntToMinBytes(S));
      const hNxorG = computeHNxorG();
      const hI = sha256(Buffer.from(config.accountName, 'utf8'));
      const expectedM1 = sha256(Buffer.concat([hNxorG, hI, saltBuf, ABytes, BBytes, K]));
      const expectedM2 = sha256(Buffer.concat([ABytes, expectedM1, K]));
      const expectedM1Base64 = expectedM1.toString('base64');
      const expectedM2Base64 = expectedM2.toString('base64');
      const ok = clientProof.m1Base64 === expectedM1Base64
        && (!clientProof.m2Base64 || clientProof.m2Base64 === expectedM2Base64);
      return { ok, expectedM1Base64, expectedM2Base64 };
    },
  };
}

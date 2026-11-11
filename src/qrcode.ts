// Self-contained ISO/IEC 18004 QR Code encoder (Versions 1..10, ECC Level L, Byte Mode)
// Generates both crisp SVG for Web Console and compact Unicode half-blocks for CLI / TUI.

interface VersionSpec {
  version: number;
  totalData: number;
  ecPerBlock: number;
  blocks: number[]; // data bytes per block
  align: number[];
  versionInfo?: number;
}

const FALLBACK_SPEC: VersionSpec = {
  version: 10,
  totalData: 274,
  ecPerBlock: 18,
  blocks: [68, 68, 69, 69],
  align: [6, 28, 50],
  versionInfo: 0x0a4d3,
};

const VERSION_SPECS: VersionSpec[] = [
  { version: 1, totalData: 19, ecPerBlock: 7, blocks: [19], align: [] },
  { version: 2, totalData: 34, ecPerBlock: 10, blocks: [34], align: [6, 18] },
  { version: 3, totalData: 55, ecPerBlock: 15, blocks: [55], align: [6, 22] },
  { version: 4, totalData: 80, ecPerBlock: 20, blocks: [80], align: [6, 26] },
  { version: 5, totalData: 108, ecPerBlock: 26, blocks: [108], align: [6, 30] },
  { version: 6, totalData: 136, ecPerBlock: 18, blocks: [68, 68], align: [6, 34] },
  { version: 7, totalData: 156, ecPerBlock: 20, blocks: [78, 78], align: [6, 22, 38], versionInfo: 0x07c94 },
  { version: 8, totalData: 194, ecPerBlock: 24, blocks: [97, 97], align: [6, 24, 42], versionInfo: 0x085bc },
  { version: 9, totalData: 232, ecPerBlock: 30, blocks: [116, 116], align: [6, 26, 46], versionInfo: 0x09a99 },
  FALLBACK_SPEC,
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255] ?? 0;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0;
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i] ?? 1;
    for (let j = 0; j < poly.length; j++) {
      const pj = poly[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ pj;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(pj, root);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEc(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = (data[i] ?? 0) ^ (rem[0] ?? 0);
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) {
        rem[j] = (rem[j] ?? 0) ^ gfMul(gen[j + 1] ?? 0, factor);
      }
    }
  }
  return rem;
}

function bchFormatInfo(mask: number): number {
  // ECC Level L = 01
  const data = (0b01 << 3) | (mask & 0b111);
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

export function encodeQrMatrix(text: string): boolean[][] {
  const payload = Buffer.from(text, 'utf8');
  const spec: VersionSpec = VERSION_SPECS.find(s => {
    const lenBits = s.version <= 9 ? 8 : 16;
    const capacityBytes = Math.floor((s.totalData * 8 - 4 - lenBits) / 8);
    return payload.length <= capacityBytes;
  }) ?? FALLBACK_SPEC;

  const lenBits = spec.version <= 9 ? 8 : 16;
  const maxPayload = Math.floor((spec.totalData * 8 - 4 - lenBits) / 8);
  const bytes = payload.length > maxPayload ? payload.subarray(0, maxPayload) : payload;

  const bits: number[] = [];
  const pushBits = (val: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, lenBits);
  for (const b of bytes) pushBits(b, 8);

  const totalBits = spec.totalData * 8;
  const terminator = Math.min(4, totalBits - bits.length);
  pushBits(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);

  const dataWords = new Uint8Array(spec.totalData);
  for (let i = 0; i < bits.length / 8; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | (bits[i * 8 + b] ?? 0);
    dataWords[i] = byte;
  }
  for (let i = bits.length / 8, p = 0; i < spec.totalData; i++, p ^= 1) {
    dataWords[i] = p === 0 ? 0xec : 0x11;
  }

  // Split into blocks and compute RS ECC
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const blockLen of spec.blocks) {
    const block = dataWords.subarray(offset, offset + blockLen);
    offset += blockLen;
    dataBlocks.push(block);
    ecBlocks.push(rsComputeEc(block, spec.ecPerBlock));
  }

  const finalCodewords: number[] = [];
  const maxDataBlockLen = Math.max(...spec.blocks);
  for (let i = 0; i < maxDataBlockLen; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) finalCodewords.push(block[i] ?? 0);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const ec of ecBlocks) {
      finalCodewords.push(ec[i] ?? 0);
    }
  }

  const size = spec.version * 4 + 17;
  const modules: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));

  const setModule = (r: number, c: number, dark: boolean) => {
    const row = modules[r];
    if (row && c >= 0 && c < size) row[c] = dark;
  };
  const getModule = (r: number, c: number): boolean => Boolean(modules[r]?.[c]);
  const isFunc = (r: number, c: number): boolean => Boolean(isFunction[r]?.[c]);

  const setFunction = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    setModule(r, c, dark);
    const fRow = isFunction[r];
    if (fRow) fRow[c] = true;
  };

  // Finder patterns + separators
  const drawFinder = (top: number, left: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = top + r;
        const cc = left + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const inRing = r === 0 || r === 6 || c === 0 || c === 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setFunction(rr, cc, inOuter && (inRing || inCore));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  for (const ar of spec.align) {
    for (const ac of spec.align) {
      if ((ar === 6 && ac === 6) || (ar === 6 && ac === size - 7) || (ar === size - 7 && ac === 6)) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          setFunction(ar + r, ac + c, dark);
        }
      }
    }
  }

  // Dark module & reserved format areas
  setFunction(size - 8, 8, true);
  for (let i = 0; i < 9; i++) {
    if (!isFunc(8, i)) setFunction(8, i, false);
    if (!isFunc(i, 8)) setFunction(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunc(8, size - 1 - i)) setFunction(8, size - 1 - i, false);
    if (!isFunc(size - 1 - i, 8)) setFunction(size - 1 - i, 8, false);
  }

  // Version info (v7+)
  if (spec.versionInfo !== undefined) {
    for (let i = 0; i < 18; i++) {
      const bit = ((spec.versionInfo >> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, bit);
      setFunction(b, a, bit);
    }
  }

  // Place data bits in zigzag
  let bitIdx = 0;
  const totalStreamBits = finalCodewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const upward = ((right + 1) & 2) === 0;
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (isFunc(r, c)) continue;
        let dark = false;
        if (bitIdx < totalStreamBits) {
          const word = finalCodewords[bitIdx >> 3] ?? 0;
          dark = ((word >> (7 - (bitIdx & 7))) & 1) === 1;
          bitIdx++;
        }
        setModule(r, c, dark);
      }
    }
  }

  // Apply mask 0 ((r + c) % 2 === 0) and write format info
  const mask = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!isFunc(r, c) && (r + c) % 2 === 0) {
        setModule(r, c, !getModule(r, c));
      }
    }
  }

  const formatBits = bchFormatInfo(mask);
  // Top-left format info: bit 14 (MSB) at (8,0) .. bit 0 (LSB) at (0,8)
  for (let c = 0; c <= 5; c++) setFunction(8, c, ((formatBits >> (14 - c)) & 1) === 1);
  setFunction(8, 7, ((formatBits >> 8) & 1) === 1);
  setFunction(8, 8, ((formatBits >> 7) & 1) === 1);
  setFunction(7, 8, ((formatBits >> 6) & 1) === 1);
  for (let r = 0; r <= 5; r++) setFunction(r, 8, ((formatBits >> r) & 1) === 1);

  // Bottom-left format info: bit 14 at (size-1, 8) .. bit 8 at (size-7, 8); (size-8, 8) stays dark module
  for (let i = 0; i < 7; i++) setFunction(size - 1 - i, 8, ((formatBits >> (14 - i)) & 1) === 1);
  setFunction(size - 8, 8, true);
  // Top-right format info: bit 7 at (8, size-8) .. bit 0 at (8, size-1)
  for (let i = 0; i < 8; i++) setFunction(8, size - 8 + i, ((formatBits >> (7 - i)) & 1) === 1);

  return modules;
}

export function renderQrTerminal(text: string, quietZone = 2): string {
  const matrix = encodeQrMatrix(text);
  const n = matrix.length;
  const total = n + quietZone * 2;
  const get = (r: number, c: number): boolean => {
    const mr = r - quietZone;
    const mc = c - quietZone;
    if (mr < 0 || mr >= n || mc < 0 || mc >= n) return false;
    return Boolean(matrix[mr]?.[mc]);
  };
  const lines: string[] = [];
  for (let r = 0; r < total; r += 2) {
    let line = '';
    for (let c = 0; c < total; c++) {
      const top = get(r, c);
      const bottom = r + 1 < total ? get(r + 1, c) : false;
      if (top && bottom) line += ' ';
      else if (top && !bottom) line += '▄';
      else if (!top && bottom) line += '▀';
      else line += '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

export function renderQrSvgDataUrl(text: string, quietZone = 3): string {
  const matrix = encodeQrMatrix(text);
  const n = matrix.length;
  const total = n + quietZone * 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r]?.[c]) {
        path += `M${c + quietZone},${r + quietZone}h1v1h-1z`;
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

import { svgNode } from './dom.js';
import { BOT_EXPRESSION_META, type BotExpression } from './bot-expressions.js';
import { onReducedMotionChange, prefersReducedMotion } from './ui-primitives.js';

export type BotBodyKind = 'squircle' | 'pebble' | 'sphere' | 'gem';
export type BotMorphKind = 'thinking' | 'radar' | 'orbit';
export type BotStateId =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'searching'
  | 'streaming'
  | 'working'
  | 'waiting'
  | 'finished'
  | 'failed'
  | 'sleeping';
export type BotPokeKind = 'bounce' | 'nod' | 'spin';

export interface StaticBotSvgOptions {
  size: number;
  expr?: BotExpression;
  body?: BotBodyKind;
  rx?: number;
  ry?: number;
  rz?: number;
  className?: string;
  interactivePoke?: boolean;
  label?: string;
}

export interface BotAvatarController {
  readonly svg: SVGSVGElement;
  createPokeButton(label?: string): HTMLButtonElement;
  setState(state: BotStateId): void;
  setExpression(expr: BotExpression | 'auto'): void;
  setGaze(nx: number, ny: number): void;
  blink(): void;
  poke(kind: BotPokeKind, turns?: number): void;
  destroy(): void;
}

export const BOT_AMBER_PALETTE = {
  body: '#E88B0A',
  eye: '#FFFFFF',
  morphPrimary: '#E88B0A',
  morphAccent: '#FBBF24',
} as const;

const DEG = Math.PI / 180;
const SVG_NS = 'http://www.w3.org/2000/svg';

type Vec2 = [number, number];
type Vec3 = [number, number, number];
type Mat3 = [number, number, number, number, number, number, number, number, number];

interface Spring {
  x: number;
  v: number;
  t: number;
}

interface Keyframe<T extends number[]> {
  t: number;
  v: T;
  ease?: (u: number) => number;
}

interface ClipSpec {
  duration: number;
  rot: Keyframe<Vec3>[];
  pos: Keyframe<Vec2>[];
  squash: Keyframe<Vec2>[];
}

interface StateSpec {
  id: BotStateId;
  clips: string[];
  compactClips: string[];
  face: BotExpression;
  morph: BotMorphKind | null;
  next?: BotStateId;
  holdSeconds?: number;
}

interface BodyMesh {
  kind: BotBodyKind;
  rings: Vec3[][];
  eyeOffsetY: number;
  eyeDepthFn: (x: number, y: number) => number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

function createSpring(init = 0): Spring {
  return { x: init, v: 0, t: init };
}

function stepSpring(s: Spring, omega: number, zeta: number, dt: number): void {
  const acc = -2 * zeta * omega * s.v - omega * omega * (s.x - s.t);
  s.v += acc * dt;
  s.x += s.v * dt;
  if (!Number.isFinite(s.x) || !Number.isFinite(s.v)) {
    s.x = s.t;
    s.v = 0;
  }
}

function wrapAngleSpring(s: Spring, targetDeg: number): void {
  s.x += 360 * Math.round((targetDeg - s.x) / 360);
  s.t = targetDeg;
}

function rotMatrixEuler(rxDeg: number, ryDeg: number, rzDeg: number): Mat3 {
  const ax = rxDeg * DEG;
  const ay = ryDeg * DEG;
  const az = rzDeg * DEG;
  const cx = Math.cos(ax);
  const sx = Math.sin(ax);
  const cy = Math.cos(ay);
  const sy = Math.sin(ay);
  const cz = Math.cos(az);
  const sz = Math.sin(az);
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

function mulMatVec(m: Mat3, x: number, y: number, z: number): Vec3 {
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
  ];
}

function convexHull2D(pts: Vec2[]): Vec2[] {
  const sorted = pts.toSorted((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  if (sorted.length <= 2) return sorted;
  const cross = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Vec2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2) {
      const a = lower[lower.length - 2]!;
      const b = lower[lower.length - 1]!;
      if (cross(a, b, p) <= 0) lower.pop();
      else break;
    }
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!;
    while (upper.length >= 2) {
      const a = upper[upper.length - 2]!;
      const b = upper[upper.length - 1]!;
      if (cross(a, b, p) <= 0) upper.pop();
      else break;
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function buildCrossSection(kind: Exclude<BotBodyKind, 'sphere'>, nTheta = 72): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < nTheta; i++) {
    const th = (i / nTheta) * Math.PI * 2;
    const c = Math.cos(th);
    const s = Math.sin(th);
    if (kind === 'squircle') {
      const p = 3.5;
      pts.push([
        Math.sign(c) * Math.pow(Math.abs(c), 2 / p),
        Math.sign(s) * Math.pow(Math.abs(s), 2 / p),
      ]);
    } else if (kind === 'pebble') {
      const wide = 1 + 0.08 * s - 0.04 * s * s;
      const topCompress = s < 0 ? 0.91 : 0.98;
      pts.push([c * wide * 1.01, s * topCompress]);
    } else {
      const sectors = 8;
      const step = (Math.PI * 2) / sectors;
      const local = (((th + step / 2) % step) + step) % step - step / 2;
      const rPoly = Math.cos(step / 2) / Math.cos(local);
      const rBlend = lerp(rPoly, 1.0, 0.22);
      pts.push([c * rBlend * 0.99, s * rBlend * 0.99]);
    }
  }
  return pts;
}

function buildBodyMesh(kind: BotBodyKind): BodyMesh {
  if (kind === 'sphere') {
    const rings: Vec3[][] = [];
    const nLat = 9;
    const nLon = 60;
    for (let i = 0; i < nLat; i++) {
      const phi = lerp(Math.PI * 0.44, -Math.PI * 0.44, i / (nLat - 1));
      const r = Math.cos(phi);
      const z = Math.sin(phi) * 0.96;
      const ring: Vec3[] = [];
      for (let j = 0; j < nLon; j++) {
        const th = (j / nLon) * Math.PI * 2;
        ring.push([r * Math.cos(th), r * Math.sin(th), z]);
      }
      rings.push(ring);
    }
    return {
      kind,
      rings,
      eyeOffsetY: 0.02,
      eyeDepthFn: (x, y) => Math.sqrt(Math.max(0.05, 1 - x * x - y * y)) * 0.96,
    };
  }

  const halfT = kind === 'pebble' ? 0.46 : kind === 'gem' ? 0.41 : 0.43;
  const bevel = kind === 'pebble' ? 0.26 : 0.22;
  const coreHalfT = halfT - bevel;
  const baseXY = buildCrossSection(kind, 72);
  const bevelAngles = [
    Math.PI * 0.5,
    Math.PI * 0.36,
    Math.PI * 0.20,
    0,
    -Math.PI * 0.20,
    -Math.PI * 0.36,
    -Math.PI * 0.5,
  ];
  const rings: Vec3[][] = bevelAngles.map(phi => {
    const sc = 1 - bevel + bevel * Math.cos(phi);
    const zBase = (phi >= 0 ? coreHalfT : -coreHalfT) + bevel * Math.sin(phi);
    const dome = phi >= 0 ? 0.045 * Math.sin(phi) : -0.045 * Math.sin(-phi);
    return baseXY.map(([x, y]) => [x * sc, y * sc, zBase + dome]);
  });

  const eyeOffsetY = kind === 'squircle' ? 0.045 : kind === 'gem' ? 0.04 : 0.02;
  const eyeDepthFn = (x: number, y: number): number =>
    halfT + 0.045 * Math.max(0, 1 - (x * x + y * y));
  return { kind, rings, eyeOffsetY, eyeDepthFn };
}

const BODY_MESHES: Record<BotBodyKind, BodyMesh> = {
  squircle: buildBodyMesh('squircle'),
  pebble: buildBodyMesh('pebble'),
  sphere: buildBodyMesh('sphere'),
  gem: buildBodyMesh('gem'),
};

function sampleCapsuleSpine(cx: number, cy: number, halfH: number, tiltRad: number, segs = 5): Vec2[] {
  const pts: Vec2[] = [];
  const dx = Math.sin(tiltRad);
  const dy = Math.cos(tiltRad);
  for (let i = 0; i < segs; i++) {
    const u = lerp(-1, 1, i / (segs - 1));
    pts.push([cx + dx * halfH * u, cy + dy * halfH * u]);
  }
  return pts;
}

function sampleArcSpine(
  cx: number,
  cy: number,
  w: number,
  h: number,
  curveDir: number,
  tiltRad = 0,
  segs = 7,
): Vec2[] {
  const pts: Vec2[] = [];
  const ct = Math.cos(tiltRad);
  const st = Math.sin(tiltRad);
  for (let i = 0; i < segs; i++) {
    const t = i / (segs - 1);
    const s = 1 - t;
    const lx = lerp(-w, w, t);
    const y0 = -curveDir * h * 0.5;
    const yCtrl = curveDir * h * 1.3;
    const ly = s * s * y0 + 2 * s * t * yCtrl + t * t * y0;
    pts.push([cx + lx * ct - ly * st, cy + lx * st + ly * ct]);
  }
  return pts;
}

function getEyeGeometry(
  expr: BotExpression,
  side: -1 | 1,
  eyeOffsetY: number,
  lids: number,
  gaze: Vec2,
): { spine: Vec2[]; radius: number } {
  const baseCx = side * 0.225 + gaze[0] * 0.075;
  const baseCy = eyeOffsetY - gaze[1] * 0.055;
  const lidFactor = Math.max(0.08, 1 - 0.9 * clamp(lids, 0, 1));

  switch (expr) {
    case 'happy': {
      const h = 0.115 * lidFactor;
      const dy = 0.02 * (1 - lidFactor);
      return {
        spine: sampleArcSpine(baseCx, baseCy + dy, 0.105, -h, 1, side * -0.05),
        radius: 0.044,
      };
    }
    case 'sleepy': {
      const h = 0.095 * Math.max(0.28, lidFactor);
      return {
        spine: sampleArcSpine(baseCx, baseCy + 0.03, 0.098, h, 1, side * 0.04),
        radius: 0.042,
      };
    }
    case 'calm':
      return {
        spine: sampleCapsuleSpine(baseCx, baseCy + 0.015, 0.095 * lidFactor, 0),
        radius: 0.068,
      };
    case 'surprised':
      return {
        spine: sampleCapsuleSpine(baseCx, baseCy - 0.01, 0.205 * lidFactor, 0),
        radius: 0.090,
      };
    case 'inspecting':
      return side < 0
        ? {
            spine: sampleCapsuleSpine(baseCx, baseCy - 0.015, 0.072 * lidFactor, 0.1),
            radius: 0.066,
          }
        : {
            spine: sampleCapsuleSpine(baseCx, baseCy - 0.005, 0.18 * lidFactor, -0.03),
            radius: 0.082,
          };
    case 'squinted': {
      const tilt = -side * (Math.PI / 2 - 0.24);
      return {
        spine: sampleCapsuleSpine(baseCx, baseCy + 0.01, 0.076, tilt),
        radius: Math.max(0.034, 0.045 * Math.max(0.65, lidFactor)),
      };
    }
    case 'confused':
      return side < 0
        ? {
            spine: sampleArcSpine(baseCx, baseCy + 0.02, 0.088, -0.065 * lidFactor, 1, 0.22),
            radius: 0.046,
          }
        : {
            spine: sampleCapsuleSpine(baseCx, baseCy - 0.015, 0.15 * lidFactor, -0.14),
            radius: 0.070,
          };
    case 'sad':
      return {
        spine: sampleCapsuleSpine(baseCx, baseCy + 0.025, 0.115 * lidFactor, side * 0.36),
        radius: 0.064,
      };
    case 'neutral':
    default:
      return {
        spine: sampleCapsuleSpine(baseCx, baseCy, 0.155 * lidFactor, 0),
        radius: 0.072,
      };
  }
}

function projectPoint(
  x: number,
  y: number,
  z: number,
  mat: Mat3,
  sx: number,
  sy: number,
  px: number,
  py: number,
  scale: number,
  baseRadius: number,
): Vec3 {
  const [rx, ry, rz] = mulMatVec(mat, x, y, z);
  const r = baseRadius * scale;
  return [
    rx * sx * r + 72 + px * baseRadius,
    ry * sy * r + 72 + py * baseRadius,
    rz,
  ];
}

function ptsToPath(pts: Vec2[]): string {
  const first = pts[0];
  if (!first) return '';
  let d = `M${first[0].toFixed(2)} ${first[1].toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    d += ` L${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
  }
  return d + ' Z';
}

function spineToPath(pts: Vec3[]): string {
  const first = pts[0];
  if (!first) return '';
  let d = `M${first[0].toFixed(2)} ${first[1].toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    d += ` L${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
  }
  return d;
}

export interface PoseFrameParams {
  body?: BotBodyKind;
  expr?: BotExpression;
  rx?: number;
  ry?: number;
  rz?: number;
  px?: number;
  py?: number;
  sx?: number;
  sy?: number;
  scale?: number;
  lids?: number;
  gaze?: Vec2;
  baseRadius?: number;
}

export interface PoseFrameResult {
  bodyPath: string;
  eyeLeft: { d: string; strokeWidth: number; opacity: number };
  eyeRight: { d: string; strokeWidth: number; opacity: number };
}

/** Pure 3D-to-SVG projection solver (Node & browser compatible). */
export function computePoseFrame(params: PoseFrameParams = {}): PoseFrameResult {
  const mesh = BODY_MESHES[params.body ?? 'squircle'];
  const expr = params.expr ?? 'neutral';
  const rx = params.rx ?? 0;
  const ry = params.ry ?? 0;
  const rz = params.rz ?? 0;
  const px = params.px ?? 0;
  const py = params.py ?? 0;
  const sx = params.sx ?? 1;
  const sy = params.sy ?? 1;
  const scale = params.scale ?? 1;
  const lids = params.lids ?? 0;
  const gaze = params.gaze ?? [0, 0];
  const baseRadius = params.baseRadius ?? 46;

  const mat = rotMatrixEuler(rx, ry, rz);
  const all2D: Vec2[] = [];
  for (const ring of mesh.rings) {
    for (const [x, y, z] of ring) {
      const p = projectPoint(x, y, z, mat, sx, sy, px, py, scale, baseRadius);
      all2D.push([p[0], p[1]]);
    }
  }
  const hull = convexHull2D(all2D);
  const bodyPath = ptsToPath(hull);

  const projectEye = (side: -1 | 1): { d: string; strokeWidth: number; opacity: number } => {
    const geo = getEyeGeometry(expr, side, mesh.eyeOffsetY, lids, gaze);
    const pts3D = geo.spine.map(([ex, ey]) => {
      const ez = mesh.eyeDepthFn(ex, ey);
      return projectPoint(ex, ey, ez, mat, sx, sy, px, py, scale, baseRadius);
    });
    const mid = pts3D[Math.floor(pts3D.length / 2)]!;
    const normalZ = mat[8];
    if (normalZ <= -0.08 && mid[2] <= 0.02) {
      return { d: '', strokeWidth: 0, opacity: 0 };
    }
    const facingOp = clamp((normalZ + 0.12) / 0.25, 0, 1);
    return {
      d: spineToPath(pts3D),
      strokeWidth: geo.radius * 2 * baseRadius * scale,
      opacity: facingOp,
    };
  };

  return {
    bodyPath,
    eyeLeft: projectEye(-1),
    eyeRight: projectEye(1),
  };
}

let staticUidCounter = 0;

/** Renders a self-contained static `<svg>` markup string suitable for PNG/GIF rasterization. */
export function renderBotStaticSvgString(options: {
  size?: number;
  expr?: BotExpression;
  body?: BotBodyKind;
  rx?: number;
  ry?: number;
  rz?: number;
  px?: number;
  py?: number;
  sx?: number;
  sy?: number;
  scale?: number;
  lids?: number;
  gaze?: Vec2;
  baseRadius?: number;
  background?: 'transparent' | 'dark-glow' | 'wechat-dark' | 'wechat-light';
} = {}): string {
  const size = options.size ?? 1024;
  const uid = `friday-static-${++staticUidCounter}`;
  const bg = options.background ?? 'transparent';
  const frame = computePoseFrame({
    body: options.body ?? 'squircle',
    expr: options.expr ?? 'neutral',
    rx: options.rx ?? -3,
    ry: options.ry ?? -12,
    rz: options.rz ?? -2,
    px: options.px ?? 0,
    py: options.py ?? 0,
    sx: options.sx ?? 1,
    sy: options.sy ?? 1,
    scale: options.scale ?? 1,
    lids: options.lids ?? 0,
    gaze: options.gaze ?? [0, 0],
    baseRadius: options.baseRadius ?? (bg === 'transparent' ? 54 : 50),
  });

  let bgMarkup = '';
  let glowDef = '';
  if (bg === 'dark-glow' || bg === 'wechat-dark') {
    const baseFill = bg === 'dark-glow' ? '#0f141c' : '#14171f';
    glowDef = `<radialGradient id="${uid}-glow" cx="50%" cy="50%" r="52%"><stop offset="0%" stop-color="#f59e0b" stop-opacity="0.34"/><stop offset="62%" stop-color="#d97706" stop-opacity="0.10"/><stop offset="100%" stop-color="${baseFill}" stop-opacity="0"/></radialGradient>`;
    bgMarkup = `<rect width="144" height="144" fill="${baseFill}"/><circle cx="72" cy="72" r="70" fill="url(#${uid}-glow)"/>`;
  } else if (bg === 'wechat-light') {
    glowDef = `<radialGradient id="${uid}-glow" cx="50%" cy="50%" r="54%"><stop offset="0%" stop-color="#fde68a" stop-opacity="0.48"/><stop offset="72%" stop-color="#fffbeb" stop-opacity="0.12"/><stop offset="100%" stop-color="#fffbeb" stop-opacity="0"/></radialGradient>`;
    bgMarkup = `<rect width="144" height="144" fill="#fffbeb"/><circle cx="72" cy="72" r="70" fill="url(#${uid}-glow)"/>`;
  }

  const eyeMarkup = (eye: { d: string; strokeWidth: number; opacity: number }): string =>
    eye.d && eye.opacity > 0.01
      ? `<path d="${eye.d}" fill="none" stroke="${BOT_AMBER_PALETTE.eye}" stroke-width="${eye.strokeWidth.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" opacity="${eye.opacity.toFixed(3)}"/>`
      : '';

  return [
    `<svg xmlns="${SVG_NS}" width="${size}" height="${size}" viewBox="0 0 144 144">`,
    `<defs>`,
    glowDef,
    `<path id="${uid}-body" d="${frame.bodyPath}"/>`,
    `<mask id="${uid}-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="144" height="144">`,
    `<use href="#${uid}-body" fill="#ffffff"/>`,
    `</mask>`,
    `</defs>`,
    bgMarkup,
    `<g>`,
    `<use href="#${uid}-body" fill="${BOT_AMBER_PALETTE.body}"/>`,
    `<g mask="url(#${uid}-mask)">`,
    eyeMarkup(frame.eyeLeft),
    eyeMarkup(frame.eyeRight),
    `</g>`,
    `</g>`,
    `</svg>`,
  ].join('');
}

// -----------------------------------------------------------------------------
// Clip Library & State Machine
// -----------------------------------------------------------------------------
function evalTrack<T extends number[]>(keys: Keyframe<T>[], t: number, fallback: T): T {
  const first = keys[0];
  if (!first) return fallback;
  if (t <= first.t) return first.v;
  const last = keys[keys.length - 1]!;
  if (t >= last.t) return last.v;
  let idx = 0;
  while (idx < keys.length - 2 && keys[idx + 1]!.t <= t) idx++;
  const a = keys[idx]!;
  const b = keys[idx + 1]!;
  const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
  const e = a.ease ? a.ease(u) : easeInOutCubic(u);
  return a.v.map((val, k) => lerp(val, b.v[k]!, e)) as T;
}

const CLIPS: Record<string, ClipSpec> = {
  Idle_B: {
    duration: 3.1,
    rot: [
      { t: 0, v: [1, -4, 0] },
      { t: 0.75, v: [-3, -17, -3] },
      { t: 1.65, v: [2, 16, 3] },
      { t: 2.45, v: [-1, 5, 1] },
      { t: 3.1, v: [1, -4, 0] },
    ],
    pos: [
      { t: 0, v: [0, 0] },
      { t: 0.75, v: [-0.03, -0.01] },
      { t: 1.65, v: [0.03, 0.01] },
      { t: 3.1, v: [0, 0] },
    ],
    squash: [
      { t: 0, v: [1, 1] },
      { t: 0.9, v: [1.045, 0.96] },
      { t: 2.0, v: [0.975, 1.03] },
      { t: 3.1, v: [1, 1] },
    ],
  },
  Idle_D: {
    duration: 3.4,
    rot: [
      { t: 0, v: [0, 0, 0] },
      { t: 0.65, v: [-12, -10, -8] },
      { t: 1.5, v: [-6, 12, 9] },
      { t: 2.35, v: [5, 18, 4] },
      { t: 3.4, v: [0, 0, 0] },
    ],
    pos: [
      { t: 0, v: [0, 0] },
      { t: 0.65, v: [-0.02, -0.04] },
      { t: 1.5, v: [0.03, -0.02] },
      { t: 3.4, v: [0, 0] },
    ],
    squash: [
      { t: 0, v: [1, 1] },
      { t: 0.65, v: [0.97, 1.035] },
      { t: 2.2, v: [1.03, 0.975] },
      { t: 3.4, v: [1, 1] },
    ],
  },
  Idle_A: {
    duration: 3.8,
    rot: [
      { t: 0, v: [0, 0, 0] },
      { t: 0.7, v: [-10, -20, -6] },
      { t: 1.45, v: [12, 0, 0] },
      { t: 2.2, v: [-8, 22, 7] },
      { t: 3.05, v: [0, 360, 0] },
      { t: 3.8, v: [0, 360, 0] },
    ],
    pos: [
      { t: 0, v: [0, 0] },
      { t: 1.45, v: [0, 0.03] },
      { t: 2.6, v: [0, -0.05] },
      { t: 3.8, v: [0, 0] },
    ],
    squash: [
      { t: 0, v: [1, 1] },
      { t: 1.45, v: [1.06, 0.94] },
      { t: 2.6, v: [0.93, 1.08] },
      { t: 3.15, v: [1.04, 0.96] },
      { t: 3.8, v: [1, 1] },
    ],
  },
  Working_A: {
    duration: 1.9,
    rot: [
      { t: 0, v: [4, -14, -4] },
      { t: 0.45, v: [8, -14, -5] },
      { t: 0.95, v: [2, 14, 5] },
      { t: 1.4, v: [9, 14, 4] },
      { t: 1.9, v: [4, -14, -4] },
    ],
    pos: [
      { t: 0, v: [-0.02, 0] },
      { t: 0.45, v: [-0.02, 0.025] },
      { t: 0.95, v: [0.02, -0.015] },
      { t: 1.4, v: [0.02, 0.025] },
      { t: 1.9, v: [-0.02, 0] },
    ],
    squash: [
      { t: 0, v: [1, 1] },
      { t: 0.45, v: [1.05, 0.95] },
      { t: 0.95, v: [0.97, 1.03] },
      { t: 1.4, v: [1.05, 0.95] },
      { t: 1.9, v: [1, 1] },
    ],
  },
  Streaming_A: {
    duration: 1.4,
    rot: [
      { t: 0, v: [-2, -6, -5] },
      { t: 0.35, v: [6, 0, 0] },
      { t: 0.7, v: [-3, 7, 5] },
      { t: 1.05, v: [5, 0, 0] },
      { t: 1.4, v: [-2, -6, -5] },
    ],
    pos: [
      { t: 0, v: [0, -0.02] },
      { t: 0.35, v: [0, 0.02] },
      { t: 0.7, v: [0, -0.025] },
      { t: 1.05, v: [0, 0.02] },
      { t: 1.4, v: [0, -0.02] },
    ],
    squash: [
      { t: 0, v: [0.97, 1.035] },
      { t: 0.35, v: [1.05, 0.95] },
      { t: 0.7, v: [0.97, 1.035] },
      { t: 1.05, v: [1.05, 0.95] },
      { t: 1.4, v: [0.97, 1.035] },
    ],
  },
  Done_A: {
    duration: 1.35,
    rot: [
      { t: 0, v: [0, 0, 0] },
      { t: 0.25, v: [-14, 0, -6], ease: easeOutCubic },
      { t: 0.55, v: [10, 0, 5] },
      { t: 0.85, v: [-10, 0, -3] },
      { t: 1.35, v: [0, 0, 0] },
    ],
    pos: [
      { t: 0, v: [0, 0.04] },
      { t: 0.28, v: [0, -0.14], ease: easeOutBack },
      { t: 0.58, v: [0, 0.03] },
      { t: 0.88, v: [0, -0.06] },
      { t: 1.35, v: [0, 0] },
    ],
    squash: [
      { t: 0, v: [1.09, 0.91] },
      { t: 0.28, v: [0.91, 1.11] },
      { t: 0.58, v: [1.08, 0.92] },
      { t: 0.88, v: [0.96, 1.05] },
      { t: 1.35, v: [1, 1] },
    ],
  },
  Blocked_A: {
    duration: 1.6,
    rot: [
      { t: 0, v: [0, 0, 0] },
      { t: 0.3, v: [6, -20, -6] },
      { t: 0.65, v: [6, 20, 6] },
      { t: 1.0, v: [8, -14, -4] },
      { t: 1.6, v: [4, 0, 0] },
    ],
    pos: [
      { t: 0, v: [0, 0] },
      { t: 0.3, v: [-0.04, 0.02] },
      { t: 0.65, v: [0.04, 0.02] },
      { t: 1.6, v: [0, 0.02] },
    ],
    squash: [
      { t: 0, v: [1, 1] },
      { t: 0.5, v: [1.04, 0.96] },
      { t: 1.6, v: [1.02, 0.98] },
    ],
  },
  Listening_A: {
    duration: 2.6,
    rot: [
      { t: 0, v: [5, -10, -7] },
      { t: 1.3, v: [3, -6, -9] },
      { t: 2.6, v: [5, -10, -7] },
    ],
    pos: [
      { t: 0, v: [-0.02, 0.02] },
      { t: 1.3, v: [-0.02, 0.0] },
      { t: 2.6, v: [-0.02, 0.02] },
    ],
    squash: [
      { t: 0, v: [1.02, 0.98] },
      { t: 1.3, v: [0.99, 1.02] },
      { t: 2.6, v: [1.02, 0.98] },
    ],
  },
  Sleeping_A: {
    duration: 3.6,
    rot: [
      { t: 0, v: [12, -5, -4] },
      { t: 1.8, v: [15, -3, -6] },
      { t: 3.6, v: [12, -5, -4] },
    ],
    pos: [
      { t: 0, v: [0, 0.05] },
      { t: 1.8, v: [0, 0.07] },
      { t: 3.6, v: [0, 0.05] },
    ],
    squash: [
      { t: 0, v: [1.04, 0.96] },
      { t: 1.8, v: [1.08, 0.93] },
      { t: 3.6, v: [1.04, 0.96] },
    ],
  },
};

const STATES: Record<BotStateId, StateSpec> = {
  idle: { id: 'idle', clips: ['Idle_B', 'Idle_B', 'Idle_D', 'Idle_B', 'Idle_A'], compactClips: ['Idle_B'], face: 'neutral', morph: null },
  listening: { id: 'listening', clips: ['Listening_A'], compactClips: ['Listening_A'], face: 'calm', morph: null },
  thinking: { id: 'thinking', clips: ['Idle_B'], compactClips: ['Idle_B'], face: 'neutral', morph: 'thinking' },
  searching: { id: 'searching', clips: ['Idle_B'], compactClips: ['Idle_B'], face: 'inspecting', morph: 'radar' },
  streaming: { id: 'streaming', clips: ['Streaming_A'], compactClips: ['Streaming_A'], face: 'neutral', morph: null },
  working: { id: 'working', clips: ['Working_A'], compactClips: ['Working_A'], face: 'inspecting', morph: null },
  waiting: { id: 'waiting', clips: ['Idle_B'], compactClips: ['Idle_B'], face: 'calm', morph: 'orbit' },
  finished: { id: 'finished', clips: ['Done_A'], compactClips: ['Done_A'], face: 'happy', morph: null, next: 'idle', holdSeconds: 2.3 },
  failed: { id: 'failed', clips: ['Blocked_A'], compactClips: ['Blocked_A'], face: 'confused', morph: null, next: 'idle', holdSeconds: 2.5 },
  sleeping: { id: 'sleeping', clips: ['Sleeping_A'], compactClips: ['Sleeping_A'], face: 'sleepy', morph: null },
};

/** Derives the companion bot state from live F.R.I.D.A.Y. connection, composer, message, and work state. */
export function deriveFridayBotState(input: {
  ready: boolean;
  authExpired: boolean;
  staleConnection: boolean;
  sending: boolean;
  draftTyping: boolean;
  voiceListening?: boolean;
  voiceTranscribing?: boolean;
  subconsciousSleeping?: boolean;
  messages: Iterable<{
    role: 'user' | 'assistant';
    status: string;
    routing?: { status: string; actions: Array<{ kind: string }> };
  }>;
  works: ReadonlyArray<{ status: string; pendingQuestion?: unknown }>;
}): BotStateId {
  if (input.authExpired || !input.ready) return 'sleeping';
  if (input.voiceListening) return 'listening';
  if (input.voiceTranscribing) return 'thinking';

  let hasStreaming = false;
  let hasSearching = false;
  let hasProcessing = false;
  for (const msg of input.messages) {
    if (msg.status === 'streaming') {
      hasStreaming = true;
    } else if (msg.status === 'queued' || msg.status === 'processing') {
      hasProcessing = true;
    }
    if (msg.routing && (msg.routing.status === 'processing' || msg.status === 'queued' || msg.status === 'processing')) {
      for (const act of msg.routing.actions) {
        if (act.kind === 'search_memory' || act.kind === 'recall') {
          hasSearching = true;
        }
      }
    }
  }

  if (hasStreaming) return 'streaming';
  if (hasSearching) return 'searching';
  if (hasProcessing) return 'thinking';

  let hasWaitingWork = false;
  let hasActiveWork = false;
  for (const work of input.works) {
    if (work.status === 'queued' || work.status === 'running') {
      hasActiveWork = true;
      if (work.pendingQuestion !== undefined) hasWaitingWork = true;
    }
  }
  if (hasWaitingWork) return 'waiting';
  if (hasActiveWork) return 'working';

  if (input.sending) return 'thinking';
  if (input.draftTyping) return 'listening';
  if (input.staleConnection) return 'waiting';
  if (input.subconsciousSleeping) return 'sleeping';
  return 'idle';
}

// -----------------------------------------------------------------------------
// Browser DOM Runtime & Shared Scheduler
// -----------------------------------------------------------------------------
function shuffle<T>(arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

interface LiveAvatarRuntime {
  svg: SVGSVGElement;
  compact: boolean;
  wasConnected: boolean;
  destroyed: boolean;
  onScreen: boolean;
  contentSkipped: boolean;
  observer: IntersectionObserver | undefined;
  bodyPathDef: SVGPathElement;
  botGroup: SVGGElement;
  eyeL: SVGPathElement;
  eyeR: SVGPathElement;
  morphLayer: SVGGElement;
  stateId: BotStateId;
  exprOverride: BotExpression | 'auto';
  gazeTarget: Vec2;
  gazeX: Spring;
  gazeY: Spring;
  rotX: Spring;
  rotY: Spring;
  rotZ: Spring;
  posX: Spring;
  posY: Spring;
  sclX: Spring;
  sclY: Spring;
  morphBlend: Spring;
  activeMorph: BotMorphKind | null;
  clipName: string;
  clipElapsed: number;
  clipQueue: string[];
  stateElapsed: number;
  blinkTimer: number;
  blinkElapsed: number;
  poke: { kind: BotPokeKind; elapsed: number; dur: number; turns: number } | null;
  clock: number;
}

const activeControllers = new Set<LiveAvatarRuntime>();
const activeTweens = new Set<(dt: number) => boolean>();
let rafId: number | undefined;
let lastRafTs = 0;
let domUidCounter = 0;
let visibilityHooked = false;
let reducedMotionActive = prefersReducedMotion();

function hasRunnableWork(): boolean {
  if (reducedMotionActive) return false;
  if (typeof document !== 'undefined' && document.hidden) return false;
  if (activeTweens.size > 0) return true;
  for (const rt of activeControllers) {
    if (!rt.destroyed && rt.onScreen && !rt.contentSkipped) return true;
  }
  return false;
}

function ensureVisibilityHook(): void {
  if (visibilityHooked) return;
  visibilityHooked = true;
  reducedMotionActive = prefersReducedMotion();
  onReducedMotionChange((reduced) => {
    reducedMotionActive = reduced;
    if (reduced) {
      for (const rt of activeControllers) {
        if (!rt.destroyed) applyRuntimeToSvg(rt);
      }
      if (rafId !== undefined && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId);
        rafId = undefined;
      }
      return;
    }
    if (hasRunnableWork()) {
      ensureRafLoop();
    }
  });
  if (typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && hasRunnableWork()) {
      ensureRafLoop();
    }
  });
  document.addEventListener('contentvisibilityautostatechange', (event) => {
    const target = event.target as Node | null;
    if (!target || typeof target.contains !== 'function') return;
    const skipped = Boolean((event as Event & { skipped?: boolean }).skipped);
    let woke = false;
    for (const rt of activeControllers) {
      if (rt.destroyed) continue;
      if (target.contains(rt.svg)) {
        rt.contentSkipped = skipped;
        if (!skipped) woke = true;
      }
    }
    if (woke && hasRunnableWork()) {
      ensureRafLoop();
    }
  }, { capture: true });
}

function ensureRafLoop(): void {
  ensureVisibilityHook();
  if (rafId !== undefined || typeof requestAnimationFrame !== 'function' || !hasRunnableWork()) return;
  lastRafTs = typeof performance !== 'undefined' ? performance.now() : Date.now();
  rafId = requestAnimationFrame(stepAllRuntimes);
}

function renderMorphLayer(
  layer: SVGGElement,
  morphName: BotMorphKind | null,
  progress: number,
  clock: number,
): void {
  if (progress <= 0.02 || !morphName) {
    layer.setAttribute('opacity', '0');
    if (layer.childNodes?.length) layer.replaceChildren();
    return;
  }
  layer.setAttribute('opacity', clamp(progress, 0, 1).toFixed(3));
  const kids: SVGElement[] = [];

  if (morphName === 'thinking') {
    const scale = 0.65 + 0.35 * progress;
    for (let i = 0; i < 3; i++) {
      const ph = clock * 4.4 - i * 0.85;
      const wave = Math.sin(ph);
      const lift = Math.max(0, wave);
      const cx = 72 + (i - 1) * 26 * scale;
      const cy = 76 - lift * 16;
      const stretch = wave > 0 ? 1 + lift * 0.14 : 1 - Math.abs(wave) * 0.12;
      const rx = (9.5 / Math.sqrt(stretch)) * scale;
      const ry = 9.5 * stretch * scale;
      kids.push(svgNode('ellipse', {
        cx: cx.toFixed(2),
        cy: cy.toFixed(2),
        rx: rx.toFixed(2),
        ry: ry.toFixed(2),
        fill: i === 1 ? BOT_AMBER_PALETTE.morphAccent : BOT_AMBER_PALETTE.morphPrimary,
      }));
    }
  } else if (morphName === 'radar') {
    const coreR = (10 + Math.sin(clock * 5) * 1.6) * progress;
    for (let i = 0; i < 2; i++) {
      const cycle = (clock * 0.72 + i * 0.5) % 1;
      const r = 14 + cycle * 38;
      const op = (1 - cycle) * 0.72 * progress;
      kids.push(svgNode('circle', {
        cx: '72',
        cy: '72',
        r: r.toFixed(2),
        fill: 'none',
        stroke: BOT_AMBER_PALETTE.morphPrimary,
        'stroke-width': '2.8',
        'stroke-opacity': op.toFixed(3),
      }));
    }
    const a0 = clock * 3.1;
    const a1 = a0 + 1.35;
    const sr = 36 * progress;
    const x0 = 72 + sr * Math.cos(a0);
    const y0 = 72 + sr * Math.sin(a0);
    const x1 = 72 + sr * Math.cos(a1);
    const y1 = 72 + sr * Math.sin(a1);
    kids.push(svgNode('path', {
      d: `M${x0.toFixed(2)} ${y0.toFixed(2)} A${sr.toFixed(2)} ${sr.toFixed(2)} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      fill: 'none',
      stroke: BOT_AMBER_PALETTE.morphAccent,
      'stroke-width': '4',
      'stroke-linecap': 'round',
    }));
    kids.push(svgNode('circle', {
      cx: '72',
      cy: '72',
      r: coreR.toFixed(2),
      fill: BOT_AMBER_PALETTE.morphPrimary,
    }));
  } else {
    const coreR = 16 * progress;
    const ringPts: Vec2[] = [];
    const rxA = 44 * progress;
    const ryA = 16 * progress;
    const tilt = -0.38;
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    for (let i = 0; i <= 32; i++) {
      const a = (i / 32) * Math.PI * 2;
      const ex = rxA * Math.cos(a);
      const ey = ryA * Math.sin(a);
      ringPts.push([72 + ex * ct - ey * st, 72 + ex * st + ey * ct]);
    }
    kids.push(svgNode('path', {
      d: ptsToPath(ringPts),
      fill: 'none',
      stroke: BOT_AMBER_PALETTE.morphPrimary,
      'stroke-width': '2',
      'stroke-opacity': '0.35',
    }));
    const sats = [clock * 2.5, clock * 2.5 + Math.PI].map(a => {
      const ex = rxA * Math.cos(a);
      const ey = ryA * Math.sin(a);
      const z = Math.sin(a);
      return {
        x: 72 + ex * ct - ey * st,
        y: 72 + ex * st + ey * ct,
        z,
        r: (6.2 + z * 2.1) * progress,
      };
    });
    for (const s of sats) {
      if (s.z < 0) {
        kids.push(svgNode('circle', {
          cx: s.x.toFixed(2),
          cy: s.y.toFixed(2),
          r: s.r.toFixed(2),
          fill: BOT_AMBER_PALETTE.morphAccent,
          opacity: '0.7',
        }));
      }
    }
    kids.push(svgNode('circle', {
      cx: '72',
      cy: '72',
      r: coreR.toFixed(2),
      fill: BOT_AMBER_PALETTE.morphPrimary,
    }));
    for (const s of sats) {
      if (s.z >= 0) {
        kids.push(svgNode('circle', {
          cx: s.x.toFixed(2),
          cy: s.y.toFixed(2),
          r: s.r.toFixed(2),
          fill: BOT_AMBER_PALETTE.morphAccent,
        }));
      }
    }
  }

  layer.replaceChildren(...kids);
}

function setRuntimeState(rt: LiveAvatarRuntime, stateId: BotStateId): void {
  const spec = STATES[stateId];
  rt.stateId = spec.id;
  rt.stateElapsed = 0;
  const pool = rt.compact ? spec.compactClips : spec.clips;
  rt.clipQueue = shuffle(pool);
  rt.clipName = rt.clipQueue.shift() ?? pool[0] ?? 'Idle_B';
  rt.clipElapsed = 0;
  if (spec.morph) {
    rt.activeMorph = spec.morph;
    rt.morphBlend.t = 1;
  } else {
    rt.morphBlend.t = 0;
  }
}

function applyRuntimeToSvg(rt: LiveAvatarRuntime): void {
  const stateSpec = STATES[rt.stateId];
  const damp = rt.compact ? 0.65 : 1.0;
  const breath = Math.sin(rt.clock * 2.1);

  let rx = rt.rotX.x * damp - rt.gazeY.x * 16 * damp + breath * 1.3 * damp;
  let ry = rt.rotY.x * damp + rt.gazeX.x * 22 * damp;
  let rz = rt.rotZ.x * damp + rt.gazeX.x * 3.5 * damp;
  let px = rt.posX.x * damp + rt.gazeX.x * 0.04 * damp;
  let py = rt.posY.x * damp - rt.gazeY.x * 0.03 * damp + breath * 0.009 * damp;
  let sx = lerp(1, rt.sclX.x, damp) * (1 + breath * 0.011 * damp);
  let sy = lerp(1, rt.sclY.x, damp) * (1 - breath * 0.011 * damp);

  if (rt.poke) {
    const u = clamp(rt.poke.elapsed / rt.poke.dur, 0, 1);
    if (rt.poke.kind === 'bounce') {
      const hop = Math.sin(u * Math.PI);
      const sq = Math.sin(u * Math.PI * 2);
      py -= hop * 0.24;
      sy *= 1 + sq * 0.14;
      sx *= 1 - sq * 0.10;
      rx -= hop * 8;
    } else if (rt.poke.kind === 'nod') {
      const nod = Math.sin(u * Math.PI * 3) * (1 - u);
      rx += nod * 24;
      py += Math.max(0, nod) * 0.06;
    } else {
      const e = easeInOutCubic(u);
      ry += e * 360 * rt.poke.turns;
      const jump = Math.sin(u * Math.PI);
      py -= jump * 0.12;
      sy *= 1 + jump * 0.07;
      sx *= 1 - jump * 0.05;
    }
  }

  let lids = 0;
  if (rt.blinkElapsed >= 0) {
    const bu = clamp(rt.blinkElapsed / 0.17, 0, 1);
    lids = Math.sin(bu * Math.PI);
  }

  const expr = rt.exprOverride === 'auto' ? stateSpec.face : rt.exprOverride;
  const morphP = clamp(rt.morphBlend.x, 0, 1);
  const botOpacity = clamp(1 - morphP * 1.35, 0, 1);
  const botScale = 1 - morphP * 0.48;

  rt.botGroup.setAttribute('opacity', botOpacity.toFixed(3));
  renderMorphLayer(rt.morphLayer, rt.activeMorph, morphP, rt.clock);
  if (botOpacity <= 0.01) return;

  const frame = computePoseFrame({
    body: 'squircle',
    expr,
    rx,
    ry,
    rz,
    px,
    py,
    sx,
    sy,
    scale: botScale,
    lids,
    gaze: [rt.gazeX.x * damp, rt.gazeY.x * damp],
    baseRadius: rt.compact ? 50 : 48,
  });

  rt.bodyPathDef.setAttribute('d', frame.bodyPath);
  const writeEye = (el: SVGPathElement, eye: { d: string; strokeWidth: number; opacity: number }): void => {
    if (!eye.d || eye.opacity <= 0.01) {
      el.setAttribute('opacity', '0');
      return;
    }
    el.setAttribute('d', eye.d);
    el.setAttribute('stroke-width', eye.strokeWidth.toFixed(2));
    el.setAttribute('opacity', eye.opacity.toFixed(3));
  };
  writeEye(rt.eyeL, frame.eyeLeft);
  writeEye(rt.eyeR, frame.eyeRight);
}

function stepRuntime(rt: LiveAvatarRuntime, rawDt: number): void {
  rt.clock += rawDt;
  rt.stateElapsed += rawDt;
  rt.clipElapsed += rawDt;

  const stateSpec = STATES[rt.stateId];
  if (stateSpec.next && rt.stateElapsed >= (stateSpec.holdSeconds ?? 2.3)) {
    setRuntimeState(rt, stateSpec.next);
  }

  const currentClip = CLIPS[rt.clipName] ?? CLIPS.Idle_B!;
  if (rt.clipElapsed >= currentClip.duration) {
    rt.clipElapsed %= currentClip.duration;
    const spec = STATES[rt.stateId];
    const pool = rt.compact ? spec.compactClips : spec.clips;
    if (pool.length > 1) {
      if (!rt.clipQueue.length) rt.clipQueue = shuffle(pool);
      rt.clipName = rt.clipQueue.shift() ?? pool[0]!;
    }
  }

  if (rt.blinkElapsed >= 0) {
    rt.blinkElapsed += rawDt;
    if (rt.blinkElapsed >= 0.17) rt.blinkElapsed = -1;
  } else {
    rt.blinkTimer -= rawDt;
    if (rt.blinkTimer <= 0 && !rt.activeMorph) {
      rt.blinkElapsed = 0;
      rt.blinkTimer = 2.6 + Math.random() * 2.8;
    }
  }

  if (rt.poke) {
    rt.poke.elapsed += rawDt;
    if (rt.poke.elapsed >= rt.poke.dur) rt.poke = null;
  }

  const activeClip = CLIPS[rt.clipName] ?? CLIPS.Idle_B!;
  const tClip = rt.clipElapsed % activeClip.duration;
  const targetRot = evalTrack<Vec3>(activeClip.rot, tClip, [0, 0, 0]);
  const targetPos = evalTrack<Vec2>(activeClip.pos, tClip, [0, 0]);
  const targetScl = evalTrack<Vec2>(activeClip.squash, tClip, [1, 1]);

  wrapAngleSpring(rt.rotX, targetRot[0]);
  wrapAngleSpring(rt.rotY, targetRot[1]);
  wrapAngleSpring(rt.rotZ, targetRot[2]);
  rt.posX.t = targetPos[0];
  rt.posY.t = targetPos[1];
  rt.sclX.t = targetScl[0];
  rt.sclY.t = targetScl[1];
  rt.gazeX.t = rt.gazeTarget[0];
  rt.gazeY.t = rt.gazeTarget[1];

  const subDt = 1 / 120;
  const steps = Math.max(1, Math.ceil(rawDt / subDt));
  const h = rawDt / steps;
  for (let i = 0; i < steps; i++) {
    stepSpring(rt.gazeX, 14, 0.82, h);
    stepSpring(rt.gazeY, 14, 0.82, h);
    stepSpring(rt.rotX, 18, 0.88, h);
    stepSpring(rt.rotY, 18, 0.88, h);
    stepSpring(rt.rotZ, 18, 0.88, h);
    stepSpring(rt.posX, 18, 0.88, h);
    stepSpring(rt.posY, 18, 0.88, h);
    stepSpring(rt.sclX, 20, 0.85, h);
    stepSpring(rt.sclY, 20, 0.85, h);
    stepSpring(rt.morphBlend, 12, 1.0, h);
  }
  if (rt.morphBlend.t === 0 && rt.morphBlend.x < 0.01) {
    rt.activeMorph = null;
  }

  applyRuntimeToSvg(rt);
}

function stepAllRuntimes(now: number): void {
  rafId = undefined;
  const rawDt = Math.min(0.05, Math.max(0.001, (now - lastRafTs) / 1000));
  lastRafTs = now;

  if (!document.hidden && !reducedMotionActive) {
    for (const rt of [...activeControllers]) {
      if (rt.destroyed) {
        rt.observer?.disconnect();
        activeControllers.delete(rt);
        continue;
      }
      if (rt.svg.isConnected) {
        rt.wasConnected = true;
      } else if (rt.wasConnected) {
        rt.destroyed = true;
        rt.observer?.disconnect();
        activeControllers.delete(rt);
        continue;
      }
      if (rt.onScreen && !rt.contentSkipped) {
        stepRuntime(rt, rawDt);
      }
    }
    for (const tween of [...activeTweens]) {
      if (!tween(rawDt)) {
        activeTweens.delete(tween);
      }
    }
  }

  if (hasRunnableWork() && typeof requestAnimationFrame === 'function') {
    rafId = requestAnimationFrame(stepAllRuntimes);
  }
}

function buildSvgSkeleton(
  idPrefix: string,
  size: number,
  className?: string,
): {
  svg: SVGSVGElement;
  bodyPathDef: SVGPathElement;
  botGroup: SVGGElement;
  eyeL: SVGPathElement;
  eyeR: SVGPathElement;
  morphLayer: SVGGElement;
} {
  const svg = svgNode('svg', {
    width: String(size),
    height: String(size),
    viewBox: '0 0 144 144',
    'aria-hidden': 'true',
    ...(className ? { class: className } : {}),
  });
  const defs = svgNode('defs');
  const bodyPathDef = svgNode('path', { id: `${idPrefix}-body` });
  const mask = svgNode('mask', {
    id: `${idPrefix}-mask`,
    maskUnits: 'userSpaceOnUse',
    x: '0',
    y: '0',
    width: '144',
    height: '144',
  });
  mask.append(svgNode('use', { href: `#${idPrefix}-body`, fill: '#ffffff' }));
  defs.append(bodyPathDef, mask);

  const botGroup = svgNode('g');
  const bodyUse = svgNode('use', {
    href: `#${idPrefix}-body`,
    fill: BOT_AMBER_PALETTE.body,
  });
  const eyesLayer = svgNode('g', { mask: `url(#${idPrefix}-mask)` });
  const eyeL = svgNode('path', {
    fill: 'none',
    stroke: BOT_AMBER_PALETTE.eye,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  const eyeR = svgNode('path', {
    fill: 'none',
    stroke: BOT_AMBER_PALETTE.eye,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  eyesLayer.append(eyeL, eyeR);
  botGroup.append(bodyUse, eyesLayer);

  const morphLayer = svgNode('g', { opacity: '0' });
  svg.append(defs, botGroup, morphLayer);

  return { svg, bodyPathDef, botGroup, eyeL, eyeR, morphLayer };
}

/** Creates a live animated 3D-SVG F.R.I.D.A.Y. bot avatar driven by the shared RAF scheduler. */
export function createLiveBotAvatar(options: {
  size: number;
  compact?: boolean;
  interactive?: boolean;
  initialState?: BotStateId;
  initialExpr?: BotExpression | 'auto';
  idPrefix?: string;
  className?: string;
}): BotAvatarController {
  ensureVisibilityHook();
  const idPrefix = options.idPrefix ?? `friday-bot-${++domUidCounter}`;
  const skeleton = buildSvgSkeleton(idPrefix, options.size, options.className);

  const rt: LiveAvatarRuntime = {
    svg: skeleton.svg,
    compact: options.compact ?? false,
    wasConnected: false,
    destroyed: false,
    onScreen: true,
    contentSkipped: false,
    observer: undefined,
    bodyPathDef: skeleton.bodyPathDef,
    botGroup: skeleton.botGroup,
    eyeL: skeleton.eyeL,
    eyeR: skeleton.eyeR,
    morphLayer: skeleton.morphLayer,
    stateId: options.initialState ?? 'idle',
    exprOverride: options.initialExpr ?? 'auto',
    gazeTarget: [0, 0],
    gazeX: createSpring(0),
    gazeY: createSpring(0),
    rotX: createSpring(-2),
    rotY: createSpring(-8),
    rotZ: createSpring(0),
    posX: createSpring(0),
    posY: createSpring(0),
    sclX: createSpring(1),
    sclY: createSpring(1),
    morphBlend: createSpring(0),
    activeMorph: null,
    clipName: 'Idle_B',
    clipElapsed: 0,
    clipQueue: [],
    stateElapsed: 0,
    blinkTimer: 2.4 + Math.random() * 2.4,
    blinkElapsed: -1,
    poke: null,
    clock: Math.random() * 4,
  };

  setRuntimeState(rt, rt.stateId);
  if (rt.activeMorph) rt.morphBlend.x = 1;
  applyRuntimeToSvg(rt);

  if (typeof IntersectionObserver === 'function') {
    try {
      const io = new IntersectionObserver((entries) => {
        if (rt.destroyed || !rt.svg.isConnected) return;
        const entry = entries.at(-1);
        if (!entry) return;
        rt.onScreen = entry.isIntersecting;
        if (entry.isIntersecting && hasRunnableWork()) {
          ensureRafLoop();
        }
      }, { threshold: 0 });
      io.observe(skeleton.svg);
      rt.observer = io;
    } catch {
      // Ignore IntersectionObserver errors in stub environments
    }
  }

  activeControllers.add(rt);
  if (hasRunnableWork()) {
    ensureRafLoop();
  }

  let pokeSeq = 0;
  const triggerCyclePoke = (): void => {
    const seq: BotPokeKind[] = ['bounce', 'nod', 'spin'];
    const kind = seq[pokeSeq % seq.length]!;
    pokeSeq++;
    controller.poke(kind, kind === 'spin' ? 2 : 1);
  };

  const controller: BotAvatarController = {
    svg: skeleton.svg,
    createPokeButton(label = '与 F.R.I.D.A.Y. 互动') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bot-poke-btn';
      btn.setAttribute('aria-label', label);
      btn.appendChild(skeleton.svg);
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        triggerCyclePoke();
      });
      return btn;
    },
    setState(state) {
      if (rt.destroyed || rt.stateId === state) return;
      setRuntimeState(rt, state);
      if (reducedMotionActive || !rt.onScreen || rt.contentSkipped) {
        if (rt.activeMorph) rt.morphBlend.x = 1;
        else rt.morphBlend.x = 0;
        applyRuntimeToSvg(rt);
      }
    },
    setExpression(expr) {
      if (rt.destroyed || rt.exprOverride === expr) return;
      rt.exprOverride = expr;
      if (reducedMotionActive || !rt.onScreen || rt.contentSkipped) applyRuntimeToSvg(rt);
    },
    setGaze(nx, ny) {
      rt.gazeTarget = [clamp(nx, -1, 1), clamp(ny, -1, 1)];
    },
    blink() {
      if (rt.destroyed) return;
      rt.blinkElapsed = 0;
      rt.blinkTimer = 2.8 + Math.random() * 2.4;
    },
    poke(kind, turns = 2) {
      if (rt.destroyed || reducedMotionActive) return;
      const dur = kind === 'spin' ? 0.9 + 0.25 * Math.max(0, turns - 1) : kind === 'bounce' ? 0.62 : 0.48;
      rt.poke = { kind, elapsed: 0, dur, turns };
      if (kind !== 'spin') rt.blinkElapsed = 0;
      if (hasRunnableWork()) ensureRafLoop();
    },
    destroy() {
      rt.destroyed = true;
      rt.observer?.disconnect();
      rt.observer = undefined;
      activeControllers.delete(rt);
    },
  };

  return controller;
}

/**
 * Creates a zero-idle-overhead static bot SVG (suitable for historical messages, inline emotes, and tray buttons).
 * When `interactivePoke` is enabled, wraps the decorative SVG in a keyboard-reachable `<button type="button">`
 * that triggers a brief 520ms elastic bounce tween on click or hover.
 */
export function createStaticBotSvg(options: StaticBotSvgOptions & { interactivePoke: true }): HTMLButtonElement;
export function createStaticBotSvg(options: StaticBotSvgOptions & { interactivePoke?: false | undefined }): SVGSVGElement;
export function createStaticBotSvg(options: StaticBotSvgOptions): SVGSVGElement | HTMLButtonElement;
export function createStaticBotSvg(options: StaticBotSvgOptions): SVGSVGElement | HTMLButtonElement {
  const idPrefix = `friday-static-el-${++domUidCounter}`;
  const skeleton = buildSvgSkeleton(idPrefix, options.size, options.className);
  const expr = options.expr ?? 'neutral';
  const body = options.body ?? 'squircle';
  const baseRx = options.rx ?? -3;
  const baseRy = options.ry ?? -8;
  const baseRz = options.rz ?? 0;
  const baseRadius = options.size <= 24 ? 58 : 50;

  const paint = (rx: number, ry: number, rz: number, py: number, sx: number, sy: number, lids: number): void => {
    const frame = computePoseFrame({ body, expr, rx, ry, rz, py, sx, sy, lids, baseRadius });
    skeleton.bodyPathDef.setAttribute('d', frame.bodyPath);
    const updateEye = (el: SVGPathElement, eye: { d: string; strokeWidth: number; opacity: number }): void => {
      if (!eye.d || eye.opacity <= 0.01) {
        el.setAttribute('opacity', '0');
        return;
      }
      el.setAttribute('d', eye.d);
      el.setAttribute('stroke-width', eye.strokeWidth.toFixed(2));
      el.setAttribute('opacity', eye.opacity.toFixed(3));
    };
    updateEye(skeleton.eyeL, frame.eyeLeft);
    updateEye(skeleton.eyeR, frame.eyeRight);
  };

  paint(baseRx, baseRy, baseRz, 0, 1, 1, 0);

  if (options.interactivePoke) {
    ensureVisibilityHook();
    let running = false;
    const triggerMicroTween = (): void => {
      if (running || typeof requestAnimationFrame !== 'function' || reducedMotionActive || prefersReducedMotion()) return;
      running = true;
      let elapsed = 0;
      const dur = 0.52;
      activeTweens.add(dt => {
        if (!skeleton.svg.isConnected || reducedMotionActive) {
          paint(baseRx, baseRy, baseRz, 0, 1, 1, 0);
          running = false;
          return false;
        }
        elapsed += dt;
        const u = clamp(elapsed / dur, 0, 1);
        const hop = Math.sin(u * Math.PI);
        const sq = Math.sin(u * Math.PI * 2);
        const lids = u < 0.32 ? Math.sin((u / 0.32) * Math.PI) : 0;
        paint(baseRx - hop * 8, baseRy + Math.sin(u * Math.PI * 2) * 10, baseRz, -hop * 0.14, 1 - sq * 0.08, 1 + sq * 0.10, lids);
        if (u >= 1) {
          paint(baseRx, baseRy, baseRz, 0, 1, 1, 0);
          running = false;
          return false;
        }
        return true;
      });
      ensureRafLoop();
    };
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bot-poke-btn';
    const metaLabel = BOT_EXPRESSION_META[expr]?.label ?? expr;
    btn.setAttribute('aria-label', options.label ?? `与 F.R.I.D.A.Y. (${metaLabel}) 互动`);
    btn.appendChild(skeleton.svg);
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      triggerMicroTween();
    });
    btn.addEventListener('mouseenter', triggerMicroTween);
    return btn;
  }

  return skeleton.svg;
}

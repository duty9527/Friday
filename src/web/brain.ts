import type { MemoryCard, MemoryDirectoryItem, MemorySynapse, SynapseRelation } from '../view.js';

export type BrainMemoryItem = MemoryCard | MemoryDirectoryItem;

export interface BrainNode {
  id: string;
  topic: string;
  pinned: boolean;
  accessCount: number;
  tags: string[];
  synapseCount: number;
  /** 3D coordinates normalized to sphere radius (~0.38..0.86). */
  x: number;
  y: number;
  z: number;
  baseSize: number;
  phase: number;
  item: BrainMemoryItem;
}

export interface BrainEdge {
  key: string;
  sourceIdx: number;
  targetIdx: number;
  sourceId: string;
  targetId: string;
  weight: number;
  relation: SynapseRelation;
  phase: number;
}

export interface BrainGraph {
  nodes: BrainNode[];
  edges: BrainEdge[];
}

/**
 * Unified specification for every J.A.R.V.I.S. Fenestrated Runic / Circuit-Filigree Ring & Semicircle:
 * - Smooth, sculpted outer & inner golden rim arcs (never choppy 5-line musical-staff dashes!);
 * - Breathable hollow amber interior channel carved with a single intricate meandering polar rune trace;
 * - Optional luminous liquid-gold crest spine for lush "虚实交融" energy contrast.
 */
interface HolographicRuneArc {
  /** Base polar radius on or inside the 3D sphere (0.068 .. 0.975). */
  radius: number;
  /** Peak radial half-width of the sculpted holographic band. */
  halfWidth: number;
  /** Slight eccentricity [dx, dy] in ring plane for organic spiral nesting. */
  offsetX?: number;
  offsetY?: number;
  /** Spherical depth offset (-0.28 .. +0.26) — projects onto true 3D sphere curvature! */
  zOffset: number;
  /** Coherent 3D plane tilts (rad) creating genuine 3D spherical volume without ⚛️ atom crosses. */
  tiltX: number;
  tiltY: number;
  tiltZ: number;
  /** Drift speed of internal rune trace along the arc (rad/s). */
  flowSpeed: number;
  /** Overall luminous intensity (0.70 .. 1.20). */
  intensity: number;
  /** Color temperature palette. */
  tone: 'radiantGold' | 'warmAmber' | 'deepOrange';
  /** Partial arc spans [startRad, endRad] (0 = 3 o'clock, PI/2 = 12 o'clock, PI = 9 o'clock). */
  segments: Array<[number, number]>;
  /** Visual style of the rims: 'framed' (crisp double-walled window arch) | 'crescent' (luminous liquid-gold spine + filigree wing). */
  style: 'framed' | 'crescent';
  /** Density of carved polar rune glyphs inside the hollow channel (~8..18 per rad). */
  runeDensity: number;
  /** Whether counter-clockwise end (~10:30) terminates in the iconic angled stepped jaw. */
  steppedJawEnd?: boolean;
  /** Number of sparse radial support struts across the hollow channel (e.g. 5 on the top outer hood). */
  radialStruts?: number;
  /** Keep silhouette framed toward viewer until manually orbited. */
  silhouetteFramed?: boolean;
  seed: number;
}

interface InteriorWeaveArc {
  r: number;
  tiltX: number;
  tiltY: number;
  tiltZ: number;
  startAngle: number;
  span: number;
  speed: number;
  alpha: number;
  width: number;
  bright: boolean;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededUnit(seed: number, salt: number): number {
  const mixed = hashString(`${seed}:${salt}`);
  return (mixed % 10_000) / 10_000;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Deterministic 3D spherical neural layout:
 * - Central core (0..0.28R) houses the hollow-eyed concentric runic core rings.
 * - Pinned core beliefs inhabit the inner mantle (0.39R..0.56R).
 * - Active semantic memories inhabit the outer cortex (0.63R..0.86R).
 */
export function layoutBrainGraph(items: BrainMemoryItem[]): BrainGraph {
  const pinnedItems = items.filter(i => i.pinned);
  const regularItems = items.filter(i => !i.pinned);
  const ordered = [...pinnedItems, ...regularItems];
  const nodes: BrainNode[] = [];
  const indexById = new Map<string, number>();

  for (let idx = 0; idx < ordered.length; idx++) {
    const item = ordered[idx]!;
    const h = hashString(item.id);
    const isPinned = Boolean(item.pinned);
    const groupIdx = isPinned ? idx : idx - pinnedItems.length;
    const groupTotal = Math.max(1, isPinned ? pinnedItems.length : regularItems.length);

    const t = (groupIdx + 0.5) / groupTotal;
    const baseY = 1 - 2 * t;
    const jitterY = (seededUnit(h, 1) - 0.5) * 0.14;
    const ny = clamp(baseY + jitterY, -0.93, 0.93);
    const ringRadius = Math.sqrt(Math.max(0, 1 - ny * ny));
    const theta = groupIdx * GOLDEN_ANGLE + seededUnit(h, 2) * 0.55;

    const shellRadius = isPinned
      ? 0.40 + seededUnit(h, 3) * 0.16
      : 0.63 + seededUnit(h, 3) * 0.23;

    const x = Math.cos(theta) * ringRadius * shellRadius;
    const y = ny * shellRadius;
    const z = Math.sin(theta) * ringRadius * shellRadius;

    const synCount = item.synapses?.length ?? 0;
    const access = item.accessCount ?? 0;
    const baseSize = isPinned
      ? 3.3 + Math.min(1.4, access * 0.13 + synCount * 0.10)
      : 2.3 + Math.min(1.3, access * 0.11 + synCount * 0.09);

    indexById.set(item.id, nodes.length);
    nodes.push({
      id: item.id,
      topic: item.topic,
      pinned: isPinned,
      accessCount: access,
      tags: item.tags,
      synapseCount: synCount,
      x,
      y,
      z,
      baseSize,
      phase: seededUnit(h, 4) * Math.PI * 2,
      item,
    });
  }

  const edgeMap = new Map<string, BrainEdge>();
  for (let sourceIdx = 0; sourceIdx < nodes.length; sourceIdx++) {
    const source = nodes[sourceIdx]!;
    const synapses: MemorySynapse[] = source.item.synapses ?? [];
    for (const syn of synapses) {
      const targetIdx = indexById.get(syn.targetId);
      if (targetIdx === undefined || targetIdx === sourceIdx) continue;
      const a = Math.min(sourceIdx, targetIdx);
      const b = Math.max(sourceIdx, targetIdx);
      const key = `${a}:${b}`;
      const existing = edgeMap.get(key);
      if (!existing || syn.weight > existing.weight) {
        edgeMap.set(key, {
          key,
          sourceIdx,
          targetIdx,
          sourceId: source.id,
          targetId: syn.targetId,
          weight: clamp(syn.weight, 0.15, 1),
          relation: syn.relation,
          phase: seededUnit(hashString(key), 7),
        });
      }
    }
  }

  return { nodes, edges: [...edgeMap.values()] };
}

/**
 * Multi-layer J.A.R.V.I.S. Fenestrated Runic Rings & Sculpted Semicircles
 * (Matched directly to the Age of Ultron lab panorama & high-res close-up):
 *
 * Polar angle 0 = 3 o'clock (right), PI/2 = 12 o'clock (top), PI = 9 o'clock (left), 3*PI/2 = 6 o'clock (bottom).
 */
const HOLOGRAPHIC_RUNE_ARCS: HolographicRuneArc[] = [
  // =========================================================================
  // 1. CENTRAL RUNIC CORE RINGS (0.070R .. 0.235R — Hollow amber eye + carved golden rings!)
  // =========================================================================
  // C1. Innermost signature open golden runic ring (~0.072R) framing the dark amber pupil
  {
    radius: 0.072,
    halfWidth: 0.015,
    offsetX: -0.006,
    offsetY: -0.005,
    zOffset: 0.12,
    tiltX: -0.22,
    tiltY: 0.18,
    tiltZ: 0.06,
    flowSpeed: -0.38,
    intensity: 1.15,
    tone: 'radiantGold',
    segments: [[-0.85, 4.65]],
    style: 'framed',
    runeDensity: 10,
    silhouetteFramed: true,
    seed: 11,
  },
  // C2. Second eccentric filigree core ring (~0.128R)
  {
    radius: 0.128,
    halfWidth: 0.020,
    offsetX: 0.010,
    offsetY: 0.008,
    zOffset: 0.10,
    tiltX: -0.26,
    tiltY: 0.22,
    tiltZ: -0.14,
    flowSpeed: 0.28,
    intensity: 1.02,
    tone: 'radiantGold',
    segments: [[0.20, 3.65], [4.25, 5.85]],
    style: 'crescent',
    runeDensity: 12,
    silhouetteFramed: true,
    seed: 22,
  },
  // C3. Iconic lush golden lower-left-to-lower-right crescent collar (~0.215R, ~4:30 clockwise to ~10:30)
  // Combines a molten liquid-gold inner crest with a fenestrated runic outer wing!
  {
    radius: 0.215,
    halfWidth: 0.038,
    offsetX: -0.016,
    offsetY: -0.012,
    zOffset: 0.15,
    tiltX: -0.28,
    tiltY: 0.20,
    tiltZ: -0.08,
    flowSpeed: -0.20,
    intensity: 1.16,
    tone: 'radiantGold',
    segments: [[2.45, 5.78]],
    style: 'crescent',
    runeDensity: 15,
    radialStruts: 3,
    silhouetteFramed: true,
    seed: 33,
  },
  // C4. Delicate upper-right filigree core counter-arc (~0.196R)
  {
    radius: 0.196,
    halfWidth: 0.022,
    offsetX: 0.012,
    offsetY: 0.012,
    zOffset: 0.06,
    tiltX: -0.22,
    tiltY: 0.26,
    tiltZ: 0.10,
    flowSpeed: 0.24,
    intensity: 0.88,
    tone: 'warmAmber',
    segments: [[-0.38, 2.18]],
    style: 'framed',
    runeDensity: 12,
    silhouetteFramed: true,
    seed: 44,
  },

  // =========================================================================
  // 2. INNER & MID-CORTEX 3D SPHERICAL VORTEX SEMICIRCLES (0.34R .. 0.77R)
  // =========================================================================
  // M1. Signature radiant golden upper-right-to-lower-right sweeping inner semicircle (~0.39R)
  // Mirrors the prominent glowing golden crescent sweeping above & right of the core in the close-up!
  {
    radius: 0.392,
    halfWidth: 0.042,
    offsetX: 0.020,
    offsetY: 0.014,
    zOffset: 0.18,
    tiltX: -0.32,
    tiltY: 0.28,
    tiltZ: -0.12,
    flowSpeed: 0.15,
    intensity: 1.12,
    tone: 'radiantGold',
    segments: [[-1.15, 2.24]],
    style: 'crescent',
    runeDensity: 15,
    radialStruts: 4,
    silhouetteFramed: true,
    seed: 55,
  },
  // M2. Complementary lower-left 3D curved amber crescent (~0.355R)
  {
    radius: 0.355,
    halfWidth: 0.028,
    offsetX: -0.015,
    offsetY: -0.016,
    zOffset: 0.04,
    tiltX: 0.28,
    tiltY: -0.24,
    tiltZ: 0.16,
    flowSpeed: -0.17,
    intensity: 0.88,
    tone: 'warmAmber',
    segments: [[2.55, 5.10]],
    style: 'framed',
    runeDensity: 13,
    seed: 66,
  },
  // M3. Mid-cortex sculpted fenestrated semicircle sweeping down the right & lower-right (~0.54R)
  {
    radius: 0.545,
    halfWidth: 0.035,
    zOffset: 0.14,
    tiltX: -0.36,
    tiltY: 0.32,
    tiltZ: -0.08,
    flowSpeed: -0.12,
    intensity: 0.94,
    tone: 'warmAmber',
    segments: [[-1.48, 1.66], [2.78, 4.45]],
    style: 'framed',
    runeDensity: 15,
    radialStruts: 3,
    seed: 77,
  },
  // M4. Deep 3D spherical mid-outer amber bands (~0.68R — tilted along sphere surface for unmistakable 3D volume!)
  {
    radius: 0.675,
    halfWidth: 0.030,
    zOffset: -0.14,
    tiltX: 0.38,
    tiltY: 0.26,
    tiltZ: 0.22,
    flowSpeed: 0.10,
    intensity: 0.80,
    tone: 'deepOrange',
    segments: [[-0.92, 2.05], [2.75, 5.20]],
    style: 'crescent',
    runeDensity: 14,
    seed: 88,
  },
  // M5. Upper-dome latitude crown ring (~0.78R up near the 12:00 hood, matching the subtle horizontal dome ellipse in the close-up!)
  {
    radius: 0.50,
    halfWidth: 0.018,
    offsetY: 0.72,
    zOffset: 0.04,
    tiltX: 1.28,
    tiltY: 0.08,
    tiltZ: -0.03,
    flowSpeed: 0.12,
    intensity: 0.72,
    tone: 'warmAmber',
    segments: [[-0.25, 3.40]],
    style: 'framed',
    runeDensity: 11,
    silhouetteFramed: true,
    seed: 99,
  },

  // =========================================================================
  // 3. ASYMMETRIC NON-CIRCULAR OUTER RUNIC SHELL (0.87R .. 0.99R)
  // =========================================================================
  // S1. THE ICONIC OUTER FENESTRATED RUNIC ARCH (~0.968R):
  // Smooth continuous outer & inner golden rims framing an airy hollow amber channel
  // with carved meandering rune traces, 5 radial support struts, and the 10:30 stepped jaw!
  {
    radius: 0.968,
    halfWidth: 0.041,
    zOffset: 0.14,
    tiltX: -0.06,
    tiltY: 0.05,
    tiltZ: 0.01,
    flowSpeed: 0.045,
    intensity: 1.16,
    tone: 'radiantGold',
    segments: [[-0.78, 2.35]],
    style: 'framed',
    runeDensity: 16,
    steppedJawEnd: true,
    radialStruts: 6,
    silhouetteFramed: true,
    seed: 111,
  },
  // S2. Nested secondary filigree sub-arch beneath the upper-right hood (~0.892R)
  {
    radius: 0.892,
    halfWidth: 0.022,
    zOffset: 0.08,
    tiltX: -0.10,
    tiltY: 0.09,
    tiltZ: -0.02,
    flowSpeed: -0.07,
    intensity: 0.84,
    tone: 'warmAmber',
    segments: [[-0.38, 2.22]],
    style: 'crescent',
    runeDensity: 14,
    radialStruts: 4,
    silhouetteFramed: true,
    seed: 122,
  },
  // S3. Fragmented lower-left & bottom filigree shell rim (~5:35..8:45) — broken organic runic crescents
  // cradling the lower sphere while keeping the left side (8:50..10:25) open & genuinely non-circular!
  {
    radius: 0.938,
    halfWidth: 0.027,
    zOffset: 0.10,
    tiltX: 0.09,
    tiltY: -0.07,
    tiltZ: 0.04,
    flowSpeed: 0.065,
    intensity: 0.92,
    tone: 'radiantGold',
    segments: [[3.48, 4.40], [4.50, 5.26]],
    style: 'framed',
    runeDensity: 14,
    silhouetteFramed: true,
    seed: 133,
  },
  // S4. Secondary recessed lower-shell amber filigree fragments (~0.868R)
  {
    radius: 0.868,
    halfWidth: 0.020,
    zOffset: 0.04,
    tiltX: 0.14,
    tiltY: -0.09,
    tiltZ: -0.04,
    flowSpeed: -0.06,
    intensity: 0.76,
    tone: 'warmAmber',
    segments: [[3.26, 4.20], [4.34, 5.40]],
    style: 'crescent',
    runeDensity: 12,
    silhouetteFramed: true,
    seed: 144,
  },
];

/**
 * Dense, warm golden-amber spherical filament weave filling the 3D hologram volume.
 */
function buildInteriorWeave(count = 230): InteriorWeaveArc[] {
  const list: InteriorWeaveArc[] = [];
  for (let i = 0; i < count; i++) {
    const r = 0.15 + Math.pow(seededUnit(i + 500, 1), 0.75) * 0.76;
    const tiltX = (seededUnit(i + 500, 2) - 0.5) * 1.85;
    const tiltY = (seededUnit(i + 500, 3) - 0.5) * 1.85;
    const tiltZ = (seededUnit(i + 500, 4) - 0.5) * 1.15;
    const startAngle = seededUnit(i + 500, 5) * Math.PI * 2;
    const span = 0.36 + seededUnit(i + 500, 6) * 0.96;
    const speed = (0.05 + seededUnit(i + 500, 7) * 0.16) * (i % 2 === 0 ? 1 : -1);
    const bright = i % 5 === 0;
    const alpha = bright
      ? 0.25 + seededUnit(i + 500, 8) * 0.26
      : 0.15 + seededUnit(i + 500, 8) * 0.22;
    const width = bright
      ? 1.1 + seededUnit(i + 500, 9) * 0.9
      : 0.75 + seededUnit(i + 500, 9) * 0.85;
    list.push({ r, tiltX, tiltY, tiltZ, startAngle, span, speed, alpha, width, bright });
  }
  return list;
}

interface ProjectedPoint {
  sx: number;
  sy: number;
  z: number;
  scale: number;
}

function getTonePalette(tone: HolographicRuneArc['tone']) {
  if (tone === 'radiantGold') {
    return {
      crest: [254, 243, 199] as const, // Warm champagne-gold highlight (#fef3c7)
      gold: [251, 191, 36] as const,   // Pure radiant gold (#fbbf24)
      amber: [245, 158, 11] as const,  // Rich golden-amber (#f59e0b)
      glow: [234, 88, 12] as const,    // Fiery orange-amber body (#ea580c)
    };
  }
  if (tone === 'warmAmber') {
    return {
      crest: [253, 224, 71] as const,  // Bright yellow-gold (#fde047)
      gold: [245, 158, 11] as const,   // Golden-amber (#f59e0b)
      amber: [234, 88, 12] as const,   // Deep orange-gold (#ea580c)
      glow: [194, 65, 12] as const,    // Burnt orange-amber (#c2410c)
    };
  }
  return {
    crest: [251, 191, 36] as const,
    gold: [234, 88, 12] as const,
    amber: [194, 65, 12] as const,
    glow: [154, 52, 18] as const,
  };
}

function rgba(rgb: readonly [number, number, number], a: number): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${clamp(a, 0, 1).toFixed(3)})`;
}

export class GoldenBrainStage {
  private graph: BrainGraph = { nodes: [], edges: [] };
  private readonly interiorWeave = buildInteriorWeave(230);
  private selectedId: string | undefined;
  private hoveredId: string | undefined;
  private highlightedIds = new Set<string>();
  private hasActiveFilter = false;
  private immersive = false;

  private rotY = 0;
  private rotX = 0;
  private userOrbY = 0;
  private userOrbX = 0;
  private targetRotY: number | undefined;
  private targetRotX: number | undefined;
  private velY = 0;
  private velX = 0;
  private zoom = 1;
  private autoRotate = true;
  private running = false;
  private rafId = 0;
  private lastTs = 0;
  private elapsed = 0;

  private dragging = false;
  private pointerDownX = 0;
  private pointerDownY = 0;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private dragMoved = false;

  private projectedNodes = new Map<string, ProjectedPoint & { radius: number; node: BrainNode }>();
  private resizeObserver?: ResizeObserver;
  private cssWidth = 640;
  private cssHeight = 412;

  private sceneLayer?: HTMLCanvasElement;
  private backBlurLayer?: HTMLCanvasElement;
  private bloomLayer?: HTMLCanvasElement;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: {
      onSelect: (item: BrainMemoryItem | undefined) => void;
    },
  ) {
    if (typeof document !== 'undefined') {
      this.sceneLayer = document.createElement('canvas');
      this.backBlurLayer = document.createElement('canvas');
      this.bloomLayer = document.createElement('canvas');
    }
    this.bindEvents();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.syncCanvasSize());
      this.resizeObserver.observe(this.canvas);
    }
  }

  setData(items: BrainMemoryItem[], highlightedIds?: Iterable<string>, filterActive = false) {
    this.graph = layoutBrainGraph(items);
    this.highlightedIds = new Set(highlightedIds ?? []);
    this.hasActiveFilter = filterActive;

    if (this.selectedId && !this.graph.nodes.some(n => n.id === this.selectedId)) {
      this.selectedId = undefined;
    }
    if (!this.selectedId && this.graph.nodes.length > 0) {
      const first = this.graph.nodes.find(n => !filterActive || this.highlightedIds.has(n.id)) ?? this.graph.nodes[0];
      this.selectedId = first?.id;
    }
    this.notifySelection();
    this.renderFrame(0);
  }

  getSelectedId(): string | undefined {
    return this.selectedId;
  }

  isAutoRotating(): boolean {
    return this.autoRotate;
  }

  setAutoRotate(next: boolean): boolean {
    this.autoRotate = next;
    return this.autoRotate;
  }

  setImmersive(next: boolean) {
    this.immersive = next;
    this.syncCanvasSize();
    this.renderFrame(0);
  }

  isImmersive(): boolean {
    return this.immersive;
  }

  resetView() {
    this.zoom = 1;
    this.userOrbX = 0;
    this.userOrbY = 0;
    this.targetRotX = 0;
    this.targetRotY = 0;
    this.velX = 0;
    this.velY = 0;
    this.autoRotate = true;
  }

  focusMemory(id: string | undefined, animate = true) {
    this.selectedId = id;
    const target = id ? this.graph.nodes.find(n => n.id === id) : undefined;
    if (target && animate) {
      const desiredRotY = -Math.atan2(target.x, target.z);
      const xz = Math.sqrt(target.x * target.x + target.z * target.z);
      const desiredRotX = clamp(Math.atan2(target.y, Math.max(0.001, xz)), -0.85, 0.85);
      const deltaY = Math.atan2(Math.sin(desiredRotY - this.rotY), Math.cos(desiredRotY - this.rotY));
      this.targetRotY = this.rotY + deltaY;
      this.targetRotX = desiredRotX;
      this.velX = 0;
      this.velY = 0;
    }
    this.notifySelection();
    if (!this.running) this.renderFrame(0);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.syncCanvasSize();
    this.lastTs = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      const dt = clamp((now - this.lastTs) / 1000, 0.001, 0.05);
      this.lastTs = now;
      this.renderFrame(dt);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private notifySelection() {
    const found = this.selectedId ? this.graph.nodes.find(n => n.id === this.selectedId)?.item : undefined;
    this.callbacks.onSelect(found);
  }

  private syncCanvasSize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(260, Math.round(rect.width || 620));
    const h = Math.max(240, Math.round(rect.height || 412));
    this.cssWidth = w;
    this.cssHeight = h;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    if (this.sceneLayer && (this.sceneLayer.width !== targetW || this.sceneLayer.height !== targetH)) {
      this.sceneLayer.width = targetW;
      this.sceneLayer.height = targetH;
    }
    const halfW = Math.max(130, Math.round(w * 0.5));
    const halfH = Math.max(120, Math.round(h * 0.5));
    if (this.backBlurLayer && (this.backBlurLayer.width !== halfW || this.backBlurLayer.height !== halfH)) {
      this.backBlurLayer.width = halfW;
      this.backBlurLayer.height = halfH;
    }
    if (this.bloomLayer && (this.bloomLayer.width !== halfW || this.bloomLayer.height !== halfH)) {
      this.bloomLayer.width = halfW;
      this.bloomLayer.height = halfH;
    }
  }

  private rotate3D(x: number, y: number, z: number, ry = this.rotY, rx = this.rotX): { x: number; y: number; z: number } {
    const cosY = Math.cos(ry);
    const sinY = Math.sin(ry);
    const x1 = x * cosY + z * sinY;
    const z1 = -x * sinY + z * cosY;

    const cosX = Math.cos(rx);
    const sinX = Math.sin(rx);
    const y2 = y * cosX - z1 * sinX;
    const z2 = y * sinX + z1 * cosX;
    return { x: x1, y: y2, z: z2 };
  }

  private project(x: number, y: number, z: number, cx: number, cy: number, sphereR: number): ProjectedPoint {
    const fov = 3.35;
    const perspective = fov / Math.max(1.0, fov - z * 0.76);
    return {
      sx: cx + x * sphereR * perspective,
      sy: cy - y * sphereR * perspective,
      z,
      scale: perspective,
    };
  }

  private updatePhysics(dt: number) {
    this.elapsed += dt;
    if (this.dragging) return;

    if (this.targetRotY !== undefined && this.targetRotX !== undefined) {
      const dy = this.targetRotY - this.rotY;
      const dx = this.targetRotX - this.rotX;
      this.rotY += dy * Math.min(1, dt * 7.2);
      this.rotX += dx * Math.min(1, dt * 7.2);
      this.userOrbY *= Math.pow(0.88, dt * 60);
      this.userOrbX *= Math.pow(0.88, dt * 60);
      if (Math.abs(dy) < 0.003 && Math.abs(dx) < 0.003) {
        this.rotY = this.targetRotY;
        this.rotX = this.targetRotX;
        this.targetRotY = undefined;
        this.targetRotX = undefined;
      }
      return;
    }

    if (Math.abs(this.velY) > 0.0002 || Math.abs(this.velX) > 0.0002) {
      const stepY = this.velY * dt * 60;
      const stepX = this.velX * dt * 60;
      this.rotY += stepY;
      this.rotX = clamp(this.rotX + stepX, -1.15, 1.15);
      this.userOrbY += stepY;
      this.userOrbX = clamp(this.userOrbX + stepX, -0.95, 0.95);
      const damping = Math.pow(0.91, dt * 60);
      this.velY *= damping;
      this.velX *= damping;
    } else if (this.autoRotate) {
      this.rotY += dt * 0.15;
      this.rotX += (-0.08 + Math.sin(this.elapsed * 0.45) * 0.05 - this.rotX) * dt * 0.8;
      this.userOrbY *= Math.pow(0.992, dt * 60);
      this.userOrbX *= Math.pow(0.992, dt * 60);
    }
  }

  private renderFrame(dt: number) {
    const mainCtx = this.canvas.getContext('2d');
    if (!mainCtx) return;
    if (dt > 0) this.updatePhysics(dt);

    const w = this.cssWidth;
    const h = this.cssHeight;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const baseScale = this.immersive ? 0.37 : 0.35;
    const sphereR = Math.min(w, h) * baseScale * this.zoom;
    const dpr = this.canvas.width / Math.max(1, w);

    const focusId = this.immersive ? this.hoveredId : (this.hoveredId ?? this.selectedId);
    const connectedIds = new Set<string>();
    if (focusId) {
      connectedIds.add(focusId);
      for (const edge of this.graph.edges) {
        if (edge.sourceId === focusId) connectedIds.add(edge.targetId);
        else if (edge.targetId === focusId) connectedIds.add(edge.sourceId);
      }
    }

    // Project 3D memory neurons
    this.projectedNodes.clear();
    const sortedNodes: Array<ProjectedPoint & { radius: number; node: BrainNode }> = [];
    for (const n of this.graph.nodes) {
      const r = this.rotate3D(n.x, n.y, n.z);
      const p = this.project(r.x, r.y, r.z, cx, cy, sphereR);
      const radius = n.baseSize * p.scale;
      const entry = { ...p, radius, node: n };
      this.projectedNodes.set(n.id, entry);
      sortedNodes.push(entry);
    }
    sortedNodes.sort((a, b) => a.z - b.z);

    // 1. Absolute pure pitch-black background (#000000)
    mainCtx.save();
    mainCtx.scale(dpr, dpr);
    mainCtx.globalCompositeOperation = 'source-over';
    mainCtx.fillStyle = '#000000';
    mainCtx.fillRect(0, 0, w, h);

    // 2. Warm vibrant liquid-amber volumetric sphere glow (rich orange-amber body, hollow-preserved center!)
    mainCtx.globalCompositeOperation = 'lighter';
    const bodyGlow = mainCtx.createRadialGradient(cx, cy, sphereR * 0.04, cx, cy, sphereR * 0.98);
    bodyGlow.addColorStop(0.0, 'rgba(217, 119, 6, 0.14)');
    bodyGlow.addColorStop(0.18, 'rgba(245, 158, 11, 0.32)');
    bodyGlow.addColorStop(0.50, 'rgba(234, 88, 12, 0.28)');
    bodyGlow.addColorStop(0.78, 'rgba(194, 65, 12, 0.18)');
    bodyGlow.addColorStop(0.94, 'rgba(154, 52, 18, 0.06)');
    bodyGlow.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
    mainCtx.fillStyle = bodyGlow;
    mainCtx.beginPath();
    mainCtx.arc(cx, cy, sphereR * 0.98, 0, Math.PI * 2);
    mainCtx.fill();
    mainCtx.restore();

    const sCtx = this.sceneLayer?.getContext('2d');
    const bCtx = this.backBlurLayer?.getContext('2d');
    const bloomCtx = this.bloomLayer?.getContext('2d');

    if (sCtx && bCtx && bloomCtx && this.sceneLayer && this.backBlurLayer && this.bloomLayer) {
      // === PASS A: Soft out-of-focus background amber weave & far-hemisphere neurons ("虚") ===
      bCtx.save();
      bCtx.setTransform(1, 0, 0, 1, 0, 0);
      bCtx.clearRect(0, 0, this.backBlurLayer.width, this.backBlurLayer.height);
      bCtx.scale(0.5, 0.5);
      bCtx.globalCompositeOperation = 'lighter';

      this.drawInteriorWeave(bCtx, cx, cy, sphereR, 'back');
      this.drawHolographicRuneArcs(bCtx, cx, cy, sphereR, 'backBlur');
      this.drawSynapses(bCtx, cx, cy, sphereR, focusId, 'back');
      for (const entry of sortedNodes) {
        if (entry.z < 0) this.drawMemoryNeuron(bCtx, entry, focusId, connectedIds);
      }
      bCtx.restore();

      mainCtx.save();
      mainCtx.globalCompositeOperation = 'lighter';
      mainCtx.filter = 'blur(3.6px)';
      mainCtx.globalAlpha = 0.92;
      mainCtx.drawImage(this.backBlurLayer, 0, 0, this.canvas.width, this.canvas.height);
      mainCtx.filter = 'none';
      mainCtx.restore();

      // === PASS B: Continuous Fenestrated Holographic Rune Rings, Core Vortex & Front Neurons ("实") ===
      sCtx.save();
      sCtx.setTransform(1, 0, 0, 1, 0, 0);
      sCtx.clearRect(0, 0, this.sceneLayer.width, this.sceneLayer.height);
      sCtx.scale(dpr, dpr);
      sCtx.globalCompositeOperation = 'lighter';

      this.drawInteriorWeave(sCtx, cx, cy, sphereR, 'front');
      this.drawHolographicRuneArcs(sCtx, cx, cy, sphereR, 'main');
      this.drawCoreSwirlWisps(sCtx, cx, cy, sphereR);
      this.drawSynapses(sCtx, cx, cy, sphereR, focusId, 'front');
      for (const entry of sortedNodes) {
        if (entry.z >= 0) this.drawMemoryNeuron(sCtx, entry, focusId, connectedIds);
      }
      sCtx.restore();

      // === PASS C: Lush Cinema-Grade Multi-Radius Golden Optical Bloom ===
      bloomCtx.save();
      bloomCtx.setTransform(1, 0, 0, 1, 0, 0);
      bloomCtx.clearRect(0, 0, this.bloomLayer.width, this.bloomLayer.height);
      bloomCtx.filter = 'blur(5.8px)';
      bloomCtx.drawImage(this.sceneLayer, 0, 0, this.bloomLayer.width, this.bloomLayer.height);
      bloomCtx.restore();

      mainCtx.save();
      mainCtx.globalCompositeOperation = 'lighter';
      // 1. Wide warm golden-amber atmospheric halation
      mainCtx.filter = 'blur(15px)';
      mainCtx.globalAlpha = 0.56;
      mainCtx.drawImage(this.bloomLayer, 0, 0, this.canvas.width, this.canvas.height);
      // 2. Tight luminous gold plasma aura hugging every carved rune arc
      mainCtx.filter = 'none';
      mainCtx.globalAlpha = 0.70;
      mainCtx.drawImage(this.bloomLayer, 0, 0, this.canvas.width, this.canvas.height);
      // 3. Sculpted holographic filigree with subtle optical softening
      mainCtx.filter = 'blur(0.4px)';
      mainCtx.globalAlpha = 0.90;
      mainCtx.drawImage(this.sceneLayer, 0, 0);
      mainCtx.filter = 'none';
      mainCtx.restore();
    }

    // === PASS D: Crisp HUD Callout & Corner Telemetry ===
    mainCtx.save();
    mainCtx.scale(dpr, dpr);
    if (this.hoveredId) {
      const targetProj = this.projectedNodes.get(this.hoveredId);
      if (targetProj) {
        this.drawHoverCallout(mainCtx, targetProj.sx, targetProj.sy, targetProj.radius, targetProj.node, w, h);
      }
    } else if (!this.immersive && this.selectedId) {
      const targetProj = this.projectedNodes.get(this.selectedId);
      if (targetProj) {
        this.drawInlineNodeTag(mainCtx, targetProj.sx, targetProj.sy, targetProj.radius, targetProj.node.topic, true, w);
      }
    }

    if (!this.immersive) {
      this.drawCornerTelemetry(mainCtx, w, h);
    }
    mainCtx.restore();
  }

  private drawInteriorWeave(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    sphereR: number,
    pass: 'back' | 'front',
  ) {
    ctx.lineCap = 'round';
    for (const f of this.interiorWeave) {
      const curStart = f.startAngle + this.elapsed * f.speed;
      const cosTx = Math.cos(f.tiltX);
      const sinTx = Math.sin(f.tiltX);
      const cosTy = Math.cos(f.tiltY);
      const sinTy = Math.sin(f.tiltY);
      const cosTz = Math.cos(f.tiltZ);
      const sinTz = Math.sin(f.tiltZ);

      const ptF = (ang: number): ProjectedPoint => {
        const lx = Math.cos(ang) * f.r;
        const ly = Math.sin(ang) * f.r;
        const y1 = ly * cosTx;
        const z1 = ly * sinTx;
        const x2 = lx * cosTy + z1 * sinTy;
        const z2 = -lx * sinTy + z1 * cosTy;
        const x3 = x2 * cosTz - y1 * sinTz;
        const y3 = x2 * sinTz + y1 * cosTz;
        const w3 = this.rotate3D(
          x3,
          y3,
          z2,
          this.rotY * 0.55 + this.userOrbY * 0.45,
          this.rotX * 0.55 + this.userOrbX * 0.45,
        );
        return this.project(w3.x, w3.y, w3.z, cx, cy, sphereR);
      };

      const pMid = ptF(curStart + f.span * 0.5);
      if (pass === 'back' && pMid.z >= 0.05) continue;
      if (pass === 'front' && pMid.z < 0.05) continue;

      const p0 = ptF(curStart);
      const p2 = ptF(curStart + f.span);
      const a = f.alpha * (pass === 'back' ? 0.90 : 0.84);

      const grad = ctx.createLinearGradient(p0.sx, p0.sy, p2.sx, p2.sy);
      grad.addColorStop(0, 'rgba(194, 65, 12, 0)');
      grad.addColorStop(0.5, f.bright ? `rgba(251, 191, 36, ${a.toFixed(3)})` : `rgba(242, 112, 20, ${a.toFixed(3)})`);
      grad.addColorStop(1, 'rgba(194, 65, 12, 0)');

      ctx.strokeStyle = grad;
      ctx.lineWidth = f.width * pMid.scale;
      ctx.beginPath();
      ctx.moveTo(p0.sx, p0.sy);
      ctx.quadraticCurveTo(pMid.sx, pMid.sy, p2.sx, p2.sy);
      ctx.stroke();
    }
  }

  /**
   * Organic curved golden spiral wisps curling around the hollow central eye.
   */
  private drawCoreSwirlWisps(ctx: CanvasRenderingContext2D, cx: number, cy: number, sphereR: number) {
    const breathY = Math.sin(this.elapsed * 0.52) * 0.05;
    const breathX = Math.cos(this.elapsed * 0.41) * 0.04;
    const camRy = this.userOrbY + breathY;
    const camRx = this.userOrbX + breathX;

    const ptCore = (lx: number, ly: number, lz = 0.11): ProjectedPoint => {
      const rw = this.rotate3D(lx, ly, lz, camRy, camRx);
      return this.project(rw.x, rw.y, rw.z, cx, cy, sphereR);
    };

    const c0 = ptCore(0, 0, 0.11);
    const halo = ctx.createRadialGradient(c0.sx, c0.sy, sphereR * 0.025, c0.sx, c0.sy, sphereR * 0.25);
    halo.addColorStop(0.0, 'rgba(180, 83, 9, 0.04)');
    halo.addColorStop(0.24, 'rgba(251, 191, 36, 0.28)');
    halo.addColorStop(0.58, 'rgba(245, 158, 11, 0.20)');
    halo.addColorStop(1.0, 'rgba(194, 65, 12, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(c0.sx, c0.sy, sphereR * 0.25, 0, Math.PI * 2);
    ctx.fill();

    ctx.lineCap = 'round';
    for (let wIdx = 0; wIdx < 2; wIdx++) {
      const baseA = wIdx * 2.85 - this.elapsed * 0.30 + 1.1;
      ctx.strokeStyle = wIdx === 0 ? 'rgba(254, 243, 199, 0.85)' : 'rgba(251, 191, 36, 0.72)';
      ctx.lineWidth = wIdx === 0 ? 1.75 : 1.25;
      ctx.beginPath();
      const steps = 18;
      for (let s = 0; s <= steps; s++) {
        const u = s / steps;
        const r = 0.028 + u * 0.062;
        const ang = baseA + u * 2.25;
        const p = ptCore(Math.cos(ang) * r, Math.sin(ang) * r, 0.12);
        if (s === 0) ctx.moveTo(p.sx, p.sy);
        else ctx.lineTo(p.sx, p.sy);
      }
      ctx.stroke();
    }
  }

  /**
   * FENESTRATED HOLOGRAPHIC RUNE & LIQUID-GOLD CRESCENT ENGINE:
   * - 'framed' arches (like the outer 10:30..4:45 arch & inner C1 ring):
   *   Smooth, continuous outer & inner golden rim arcs framing an airy, translucent hollow channel,
   *   carved inside by a single intricate meandering polar circuit-rune trace + sparse radial struts!
   * - 'crescent' bands (like C3 lower-left core crescent & M1 upper-right inner crescent):
   *   A lush, molten liquid-gold inner spine fading seamlessly into a fenestrated filigree rune wing!
   */
  private drawHolographicRuneArcs(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    sphereR: number,
    mode: 'backBlur' | 'main',
  ) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const breathY = Math.sin(this.elapsed * 0.52) * 0.05;
    const breathX = Math.cos(this.elapsed * 0.41) * 0.04;

    for (const arc of HOLOGRAPHIC_RUNE_ARCS) {
      if (mode === 'backBlur' && arc.zOffset > 0.08) continue;

      const pal = getTonePalette(arc.tone);
      const cosTx = Math.cos(arc.tiltX);
      const sinTx = Math.sin(arc.tiltX);
      const cosTy = Math.cos(arc.tiltY);
      const sinTy = Math.sin(arc.tiltY);
      const cosTz = Math.cos(arc.tiltZ);
      const sinTz = Math.sin(arc.tiltZ);

      const camRy = arc.silhouetteFramed
        ? this.userOrbY + breathY
        : this.userOrbY + Math.sin(this.rotY) * 0.24 + breathY;
      const camRx = arc.silhouetteFramed
        ? this.userOrbX + breathX
        : this.userOrbX + this.rotX * 0.32 + breathX;

      const offX = arc.offsetX ?? 0;
      const offY = arc.offsetY ?? 0;

      // Projects polar point onto curved 3D spherical shell slice
      const isCrownDome = Math.abs(offY) > 0.4;
      const pt = (ang: number, rOff: number): ProjectedPoint => {
        const r = Math.max(0.01, arc.radius + rOff);
        const lx = (isCrownDome ? 0 : offX) + Math.cos(ang) * r;
        const ly = (isCrownDome ? 0 : offY) + Math.sin(ang) * r;
        const rSq = lx * lx + ly * ly;
        const domeZ = arc.zOffset * Math.sqrt(Math.max(0.25, 1.08 - rSq * 0.55));

        const y1 = ly * cosTx - domeZ * sinTx;
        const z1 = ly * sinTx + domeZ * cosTx;
        const x2 = lx * cosTy + z1 * sinTy;
        const z2 = -lx * sinTy + z1 * cosTy;
        const x3 = x2 * cosTz - y1 * sinTz;
        const y3 = x2 * sinTz + y1 * cosTz + (isCrownDome ? offY : 0);

        const rw = this.rotate3D(x3, y3, z2, camRy, camRx);
        return this.project(rw.x, rw.y, rw.z, cx, cy, sphereR);
      };

      const flowPhase = this.elapsed * arc.flowSpeed;

      for (const [segStart, segEnd] of arc.segments) {
        const segSpan = segEnd - segStart;
        if (segSpan <= 0.02) continue;

        const isCrescent = arc.style === 'crescent';

        const envelopeAt = (u: number, zVal: number): { alphaEnv: number; widthEnv: number } => {
          const depthShade = clamp((zVal + 0.68) / 0.88, 0.38, 1.0);
          let endFade: number;
          let widthScale: number;
          if (isCrescent) {
            const sCurve = Math.sin(clamp(u, 0, 1) * Math.PI);
            endFade = Math.pow(sCurve, 0.58);
            widthScale = 0.22 + 0.78 * Math.pow(sCurve, 0.52);
          } else {
            const headFade = clamp(u * 4.2, 0.04, 1);
            const tailFade = arc.steppedJawEnd ? 1.0 : clamp((1 - u) * 4.2, 0.05, 1);
            endFade = headFade * tailFade;
            widthScale = arc.steppedJawEnd
              ? (0.48 + 0.52 * clamp(u * 2.6, 0, 1))
              : (0.48 + 0.52 * Math.sin(clamp(u, 0, 1) * Math.PI));
          }
          const modeScale = mode === 'backBlur' ? 0.45 : 1.0;
          return {
            alphaEnv: arc.intensity * depthShade * endFade * modeScale,
            widthEnv: widthScale,
          };
        };

        // 1. Airy Translucent Honey-Amber Channel Veil (subtle so hollow filigree breathes clearly!)
        const veilSteps = Math.max(22, Math.ceil(segSpan * 28));
        for (let s = 0; s < veilSteps; s++) {
          const u0 = s / veilSteps;
          const u1 = (s + 1) / veilSteps;
          const uMid = (u0 + u1) * 0.5;
          const a0 = segStart + segSpan * u0;
          const a1 = segStart + segSpan * u1;
          const pMid = pt((a0 + a1) * 0.5, 0);
          const { alphaEnv, widthEnv } = envelopeAt(uMid, pMid.z);
          if (alphaEnv < 0.02) continue;

          const hw0 = arc.halfWidth * envelopeAt(u0, pMid.z).widthEnv;
          const hw1 = arc.halfWidth * widthEnv;
          const pO0 = pt(a0, hw0);
          const pO1 = pt(a1, hw1);
          const pI1 = pt(a1, -hw1);
          const pI0 = pt(a0, -hw0);

          const veilAlpha = alphaEnv * (isCrescent ? 0.24 : 0.14);
          ctx.fillStyle = rgba(pal.glow, veilAlpha);
          ctx.beginPath();
          ctx.moveTo(pO0.sx, pO0.sy);
          ctx.lineTo(pO1.sx, pO1.sy);
          ctx.lineTo(pI1.sx, pI1.sy);
          ctx.lineTo(pI0.sx, pI0.sy);
          ctx.closePath();
          ctx.fill();
        }

        if (mode === 'backBlur') continue;

        // 2. SILKY CONTINUOUS BOUNDARY RIMS OR MOLTEN LIQUID-GOLD CREST SPINE
        // Stroked as continuous connected polylines per sub-span so round lineCaps NEVER create beaded dot artifacts!
        const rimSteps = Math.max(36, Math.ceil(segSpan * 42));
        const pStartPt = pt(segStart + segSpan * 0.08, 0);
        const pPeakPt = pt(segStart + segSpan * 0.52, 0);
        const pEndPt = pt(segStart + segSpan * 0.92, 0);

        const makeArcGradient = (rgb: readonly [number, number, number], peakAlpha: number) => {
          const grad = ctx.createLinearGradient(pStartPt.sx, pStartPt.sy, pEndPt.sx, pEndPt.sy);
          const aHead = arc.style === 'crescent' ? 0.04 : peakAlpha * 0.22;
          const aTail = arc.steppedJawEnd ? peakAlpha * 0.96 : (arc.style === 'crescent' ? 0.04 : peakAlpha * 0.25);
          grad.addColorStop(0, rgba(rgb, aHead));
          grad.addColorStop(0.32, rgba(rgb, peakAlpha));
          grad.addColorStop(0.74, rgba(rgb, peakAlpha * 0.95));
          grad.addColorStop(1, rgba(rgb, aTail));
          return grad;
        };

        if (arc.style === 'framed') {
          for (const rimSide of [1, -1] as const) {
            const isOuter = rimSide === 1;
            const peakEnv = envelopeAt(0.55, pPeakPt.z).alphaEnv;
            ctx.strokeStyle = makeArcGradient(isOuter ? pal.crest : pal.gold, peakEnv * (isOuter ? 0.94 : 0.80));
            ctx.lineWidth = (isOuter ? (arc.radius > 0.85 ? 2.5 : 2.05) : (arc.radius > 0.85 ? 1.7 : 1.4)) * pPeakPt.scale;

            ctx.beginPath();
            let penDown = false;
            for (let s = 0; s <= rimSteps; s++) {
              const u = s / rimSteps;
              if (!isOuter && Math.sin(u * segSpan * 4.2 + arc.seed) > 0.86) {
                penDown = false;
                continue;
              }
              const ang = segStart + segSpan * u;
              const localHw = arc.halfWidth * envelopeAt(u, pPeakPt.z).widthEnv * rimSide;
              const p = pt(ang, localHw);
              if (!penDown) {
                ctx.moveTo(p.sx, p.sy);
                penDown = true;
              } else {
                ctx.lineTo(p.sx, p.sy);
              }
            }
            ctx.stroke();

            // Subtle recessed echo filament inside wide framed arches for richer sculpted depth
            if (isOuter && arc.halfWidth > 0.03) {
              ctx.strokeStyle = makeArcGradient(pal.amber, peakEnv * 0.44);
              ctx.lineWidth = 1.05 * pPeakPt.scale;
              ctx.beginPath();
              penDown = false;
              for (let s = 0; s <= rimSteps; s++) {
                const u = s / rimSteps;
                if (Math.sin(u * segSpan * 7.5 + arc.seed * 2.1) < -0.25) {
                  penDown = false;
                  continue;
                }
                const ang = segStart + segSpan * u;
                const localHw = arc.halfWidth * envelopeAt(u, pPeakPt.z).widthEnv * 0.70;
                const p = pt(ang, localHw);
                if (!penDown) {
                  ctx.moveTo(p.sx, p.sy);
                  penDown = true;
                } else {
                  ctx.lineTo(p.sx, p.sy);
                }
              }
              ctx.stroke();
            }
          }
        } else {
          // 'crescent' style: Silky Continuous Molten Liquid-Gold Inner Spine + Broken Filigree Outer Rim!
          const peakEnv = envelopeAt(0.5, pPeakPt.z).alphaEnv;
          ctx.strokeStyle = makeArcGradient(pal.crest, peakEnv * 0.95);
          ctx.lineWidth = (arc.halfWidth > 0.034 ? 3.4 : 2.5) * pPeakPt.scale;
          ctx.beginPath();
          for (let s = 0; s <= rimSteps; s++) {
            const u = s / rimSteps;
            const ang = segStart + segSpan * u;
            const localHw = arc.halfWidth * envelopeAt(u, pPeakPt.z).widthEnv;
            const p = pt(ang, -localHw * 0.42);
            if (s === 0) ctx.moveTo(p.sx, p.sy);
            else ctx.lineTo(p.sx, p.sy);
          }
          ctx.stroke();

          // Soft wide golden glow ribbon hugging the molten spine
          ctx.strokeStyle = makeArcGradient(pal.gold, peakEnv * 0.36);
          ctx.lineWidth = (arc.halfWidth > 0.034 ? 7.2 : 5.0) * pPeakPt.scale;
          ctx.beginPath();
          for (let s = 0; s <= rimSteps; s++) {
            const u = s / rimSteps;
            const ang = segStart + segSpan * u;
            const localHw = arc.halfWidth * envelopeAt(u, pPeakPt.z).widthEnv;
            const p = pt(ang, -localHw * 0.25);
            if (s === 0) ctx.moveTo(p.sx, p.sy);
            else ctx.lineTo(p.sx, p.sy);
          }
          ctx.stroke();

          // Broken filigree outer boundary at +0.92 * hw
          ctx.strokeStyle = makeArcGradient(pal.gold, peakEnv * 0.76);
          ctx.lineWidth = 1.35 * pPeakPt.scale;
          ctx.beginPath();
          let penDown = false;
          for (let s = 0; s <= rimSteps; s++) {
            const u = s / rimSteps;
            if (Math.sin(u * segSpan * 6.2 + arc.seed * 1.7) < -0.35) {
              penDown = false;
              continue;
            }
            const ang = segStart + segSpan * u;
            const localHw = arc.halfWidth * envelopeAt(u, pPeakPt.z).widthEnv;
            const p = pt(ang, localHw * 0.92);
            if (!penDown) {
              ctx.moveTo(p.sx, p.sy);
              penDown = true;
            } else {
              ctx.lineTo(p.sx, p.sy);
            }
          }
          ctx.stroke();
        }

        // 3. SINGLE INTRICATE MEANDERING CIRCUIT-RUNE TRACE INSIDE THE HOLLOW CHANNEL!
        // Because the channel is NOT stuffed with 7 parallel staff lines, each sculpted polar rune glyph
        // (arc -> slanted step -> counter-arc / hollow eyelet) stands out with crystal-clear filigree elegance!
        const glyphCells = Math.max(6, Math.round(segSpan * arc.runeDensity));
        const cellSpan = segSpan / glyphCells;
        const cellDrift = flowPhase / Math.max(0.01, cellSpan);
        const baseIdx = Math.floor(cellDrift);
        const fracOff = cellDrift - baseIdx;

        for (let g = -1; g <= glyphCells; g++) {
          const u0 = clamp((g - fracOff) / glyphCells, 0.015, 0.985);
          const u1 = clamp((g + 1 - fracOff) / glyphCells, 0.015, 0.985);
          if (u1 - u0 < 0.25 / glyphCells) continue;

          const uMid = (u0 + u1) * 0.5;
          const a0 = segStart + segSpan * u0;
          const a1 = segStart + segSpan * u1;
          const aMid = (a0 + a1) * 0.5;
          const pMid = pt(aMid, 0);
          const { alphaEnv, widthEnv } = envelopeAt(uMid, pMid.z);
          if (alphaEnv < 0.05) continue;

          const gId = ((g + baseIdx) % 64 + 64) % 64;
          const r1 = seededUnit(arc.seed + 300, gId * 11 + 1);
          const r2 = seededUnit(arc.seed + 300, gId * 11 + 2);
          const r3 = seededUnit(arc.seed + 300, gId * 11 + 3);

          // Generous negative-space breathing pockets (~24%) so the channel feels genuinely fenestrated & hollow!
          if (r1 < 0.24) continue;

          const localHw = arc.halfWidth * widthEnv;
          const pad = (a1 - a0) * 0.08;
          const ga0 = a0 + pad;
          const ga1 = a1 - pad;
          const gSpan = ga1 - ga0;
          if (gSpan <= 0.004) continue;

          const laneHi = localHw * (isCrescent ? 0.56 : 0.48);
          const laneLo = localHw * (isCrescent ? -0.05 : -0.46);
          const laneMid = (laneHi + laneLo) * 0.5;

          const pulse = 0.76 + 0.24 * Math.sin(this.elapsed * 2.4 + g * 1.5 + arc.seed);
          const strokeMain = rgba(r3 > 0.6 ? pal.crest : pal.gold, alphaEnv * pulse * 0.86);
          const strokeSub = rgba(pal.amber, alphaEnv * pulse * 0.72);
          const lw = (localHw > 0.028 ? 1.45 : 1.18) * pMid.scale;

          const strokeArcSeg = (sa: number, ea: number, rOff: number, w: number, style: string) => {
            const steps = Math.max(2, Math.ceil(Math.abs(ea - sa) * 18));
            ctx.strokeStyle = style;
            ctx.lineWidth = w;
            ctx.beginPath();
            for (let k = 0; k <= steps; k++) {
              const p = pt(sa + ((ea - sa) * k) / steps, rOff);
              if (k === 0) ctx.moveTo(p.sx, p.sy);
              else ctx.lineTo(p.sx, p.sy);
            }
            ctx.stroke();
          };

          const motif = gId % 4;
          if (motif === 0) {
            // Slanted Z-Meander Rune: upper arc -> 35° slanted diagonal -> lower arc
            const k0 = ga0 + gSpan * 0.36;
            const k1 = ga0 + gSpan * 0.64;
            const topFirst = r2 > 0.5;
            const rA = topFirst ? laneHi : laneLo;
            const rB = topFirst ? laneLo : laneHi;
            strokeArcSeg(ga0, k0, rA, lw, strokeMain);
            const pK0 = pt(k0, rA);
            const pK1 = pt(k1, rB);
            ctx.strokeStyle = strokeMain;
            ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.moveTo(pK0.sx, pK0.sy);
            ctx.lineTo(pK1.sx, pK1.sy);
            ctx.stroke();
            strokeArcSeg(k1, ga1, rB, lw, strokeMain);
          } else if (motif === 1) {
            // Carved Hollow Trapezoid / Slanted Eyelet inside the window arch
            const kIn0 = ga0 + gSpan * 0.16;
            const kIn1 = ga1 - gSpan * 0.16;
            strokeArcSeg(kIn0, kIn1, laneHi, lw, strokeMain);
            const pL0 = pt(ga0, laneLo);
            const pL1 = pt(kIn0, laneHi);
            const pR0 = pt(kIn1, laneHi);
            const pR1 = pt(ga1, laneLo);
            ctx.strokeStyle = strokeSub;
            ctx.lineWidth = lw * 0.92;
            ctx.beginPath();
            ctx.moveTo(pL0.sx, pL0.sy);
            ctx.lineTo(pL1.sx, pL1.sy);
            ctx.moveTo(pR0.sx, pR0.sy);
            ctx.lineTo(pR1.sx, pR1.sy);
            ctx.stroke();
          } else if (motif === 2) {
            // Calligraphic Tuning-Fork / Y-Branch Circuit Trace
            const splitA = ga0 + gSpan * 0.45;
            strokeArcSeg(ga0, splitA, laneMid, lw * 1.1, strokeMain);
            const pS = pt(splitA, laneMid);
            const pBranchHi = pt(ga0 + gSpan * 0.68, laneHi);
            const pBranchLo = pt(ga0 + gSpan * 0.68, laneLo);
            ctx.strokeStyle = strokeMain;
            ctx.lineWidth = lw * 0.95;
            ctx.beginPath();
            ctx.moveTo(pS.sx, pS.sy);
            ctx.lineTo(pBranchHi.sx, pBranchHi.sy);
            ctx.moveTo(pS.sx, pS.sy);
            ctx.lineTo(pBranchLo.sx, pBranchLo.sy);
            ctx.stroke();
            strokeArcSeg(ga0 + gSpan * 0.68, ga1, r2 > 0.5 ? laneHi : laneLo, lw * 0.95, strokeSub);
          } else {
            // Accent Rune Bar with glowing micro-node
            const barLane = r2 > 0.5 ? laneHi * 0.75 : laneLo * 0.75;
            strokeArcSeg(ga0, ga1, barLane, lw * 1.15, strokeMain);
            const pNode = pt(ga0 + gSpan * 0.5, barLane);
            ctx.fillStyle = rgba(pal.crest, alphaEnv * 0.90);
            ctx.beginPath();
            ctx.arc(pNode.sx, pNode.sy, 1.35 * pMid.scale, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        // 4. Sparse Radial Support Struts bridging across the fenestrated arch (11..2 o'clock detail!)
        if (arc.radialStruts && arc.radialStruts > 0) {
          for (let stIdx = 1; stIdx <= arc.radialStruts; stIdx++) {
            const uStrut = stIdx / (arc.radialStruts + 0.55);
            if (uStrut < 0.14 || uStrut > 0.94) continue;
            const aStrut = segStart + segSpan * uStrut;
            const pMid = pt(aStrut, 0);
            const { alphaEnv, widthEnv } = envelopeAt(uStrut, pMid.z);
            const localHw = arc.halfWidth * widthEnv;
            const pOut = pt(aStrut, localHw * 1.0);
            const pIn = pt(aStrut - 0.010, -localHw * (arc.radius > 0.85 ? 1.48 : 1.15));

            ctx.strokeStyle = rgba(pal.gold, alphaEnv * 0.74);
            ctx.lineWidth = (arc.radius > 0.85 ? 1.55 : 1.2) * pMid.scale;
            ctx.beginPath();
            ctx.moveTo(pOut.sx, pOut.sy);
            ctx.lineTo(pIn.sx, pIn.sy);
            ctx.stroke();
          }
        }

        // 5. Iconic Angled Stepped Jaw at the 10:30 Upper-Left Terminus!
        if (arc.steppedJawEnd) {
          const jawHw = arc.halfWidth;
          const pOuterTip = pt(segEnd, jawHw);
          const pSlantIn = pt(segEnd - 0.048, -jawHw * 1.04);
          const pStepBack = pt(segEnd - 0.16, -jawHw * 1.04);

          ctx.strokeStyle = rgba(pal.crest, 0.95);
          ctx.lineWidth = 2.45;
          ctx.beginPath();
          ctx.moveTo(pOuterTip.sx, pOuterTip.sy);
          ctx.lineTo(pSlantIn.sx, pSlantIn.sy);
          ctx.lineTo(pStepBack.sx, pStepBack.sy);
          ctx.stroke();

          const pIn1 = pt(segEnd - 0.018, jawHw * 0.42);
          const pIn2 = pt(segEnd - 0.105, -jawHw * 0.44);
          ctx.strokeStyle = rgba(pal.gold, 0.84);
          ctx.lineWidth = 1.45;
          ctx.beginPath();
          ctx.moveTo(pIn1.sx, pIn1.sy);
          ctx.lineTo(pIn2.sx, pIn2.sy);
          ctx.stroke();
        }
      }
    }

    // 6. Softly tapered floating golden splinter wisps off the open 9:20..10:15 left gap!
    if (mode === 'main') {
      const camRy = this.userOrbY + breathY;
      const camRx = this.userOrbX + breathX;
      const splinters: Array<[number, number, number, number, number]> = [
        [0.978, 2.53, 2.85, 0.84, 1.85],
        [0.938, 2.61, 2.97, 0.68, 1.40],
        [0.900, 2.69, 3.04, 0.50, 1.05],
      ];
      for (const [sr, sa0, sa1, salpha, sw] of splinters) {
        const steps = 14;
        for (let s = 0; s < steps; s++) {
          const u0 = s / steps;
          const u1 = (s + 1) / steps;
          const taper = Math.sin(((u0 + u1) * 0.5) * Math.PI);
          const a0 = sa0 + (sa1 - sa0) * u0;
          const a1 = sa0 + (sa1 - sa0) * u1;
          const rw0 = this.rotate3D(Math.cos(a0) * sr, Math.sin(a0) * sr, 0.10, camRy, camRx);
          const rw1 = this.rotate3D(Math.cos(a1) * sr, Math.sin(a1) * sr, 0.10, camRy, camRx);
          const p0 = this.project(rw0.x, rw0.y, rw0.z, cx, cy, sphereR);
          const p1 = this.project(rw1.x, rw1.y, rw1.z, cx, cy, sphereR);
          ctx.strokeStyle = `rgba(253, 224, 71, ${(salpha * taper).toFixed(3)})`;
          ctx.lineWidth = sw * (0.45 + 0.55 * taper);
          ctx.beginPath();
          ctx.moveTo(p0.sx, p0.sy);
          ctx.lineTo(p1.sx, p1.sy);
          ctx.stroke();
        }
      }
    }
  }

  private drawSynapses(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    sphereR: number,
    focusId: string | undefined,
    pass: 'back' | 'front',
  ) {
    for (const entry of this.projectedNodes.values()) {
      if (!entry.node.pinned) continue;
      if (pass === 'back' && entry.z >= 0) continue;
      if (pass === 'front' && entry.z < 0) continue;
      const isFocused = focusId === entry.node.id;
      const alpha = isFocused ? 0.74 : pass === 'back' ? 0.16 : 0.28;

      const n = entry.node;
      const lenN = Math.max(0.001, Math.hypot(n.x, n.y, n.z));
      const rs = this.rotate3D((n.x / lenN) * 0.21, (n.y / lenN) * 0.21, (n.z / lenN) * 0.21);
      const pStart = this.project(rs.x, rs.y, rs.z, cx, cy, sphereR);

      const rm = this.rotate3D(n.x * 0.56 - n.z * 0.22, n.y * 0.56, n.z * 0.56 + n.x * 0.22);
      const ctrl = this.project(rm.x, rm.y, rm.z, cx, cy, sphereR);

      const grad = ctx.createLinearGradient(pStart.sx, pStart.sy, entry.sx, entry.sy);
      grad.addColorStop(0, `rgba(253, 224, 71, ${alpha})`);
      grad.addColorStop(1, `rgba(245, 158, 11, ${(alpha * 0.5).toFixed(3)})`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = isFocused ? 1.45 : 0.9;
      ctx.beginPath();
      ctx.moveTo(pStart.sx, pStart.sy);
      ctx.quadraticCurveTo(ctrl.sx, ctrl.sy, entry.sx, entry.sy);
      ctx.stroke();
    }

    for (const edge of this.graph.edges) {
      const sNode = this.graph.nodes[edge.sourceIdx];
      const tNode = this.graph.nodes[edge.targetIdx];
      if (!sNode || !tNode) continue;
      const p1 = this.projectedNodes.get(sNode.id);
      const p2 = this.projectedNodes.get(tNode.id);
      if (!p1 || !p2) continue;

      const avgZ = (p1.z + p2.z) * 0.5;
      if (pass === 'back' && avgZ >= 0) continue;
      if (pass === 'front' && avgZ < 0) continue;

      const touchesFocus = Boolean(focusId && (edge.sourceId === focusId || edge.targetId === focusId));
      const dimmedByFocus = Boolean(focusId && !touchesFocus);
      const depthFactor = pass === 'back' ? 0.46 : 0.78 + Math.max(0, avgZ) * 0.30;

      const rawMx = (sNode.x + tNode.x) * 0.5 - (sNode.z - tNode.z) * 0.22;
      const rawMy = (sNode.y + tNode.y) * 0.5 + (edge.phase - 0.5) * 0.16;
      const rawMz = (sNode.z + tNode.z) * 0.5 + (sNode.x - tNode.x) * 0.22;
      const len = Math.max(0.001, Math.hypot(rawMx, rawMy, rawMz));
      const targetR = Math.min(0.86, (Math.hypot(sNode.x, sNode.y, sNode.z) + Math.hypot(tNode.x, tNode.y, tNode.z)) * 0.52);
      const scaleOut = targetR / len;

      const rMid = this.rotate3D(rawMx * scaleOut, rawMy * scaleOut, rawMz * scaleOut);
      const ctrl = this.project(rMid.x, rMid.y, rMid.z, cx, cy, sphereR);

      const baseAlpha = touchesFocus
        ? 0.86
        : dimmedByFocus
          ? 0.12 * depthFactor
          : (0.19 + edge.weight * 0.26) * depthFactor;

      ctx.strokeStyle = touchesFocus
        ? `rgba(254, 243, 199, ${baseAlpha.toFixed(3)})`
        : `rgba(251, 191, 36, ${baseAlpha.toFixed(3)})`;
      ctx.lineWidth = touchesFocus ? 1.45 + edge.weight * 0.5 : 0.72 + edge.weight * 0.5;
      ctx.beginPath();
      ctx.moveTo(p1.sx, p1.sy);
      ctx.quadraticCurveTo(ctrl.sx, ctrl.sy, p2.sx, p2.sy);
      ctx.stroke();

      if (touchesFocus || (!dimmedByFocus && pass === 'front')) {
        const speed = touchesFocus ? 0.52 : 0.20 + edge.weight * 0.15;
        const u = (this.elapsed * speed + edge.phase) % 1;
        const inv = 1 - u;
        const px = inv * inv * p1.sx + 2 * inv * u * ctrl.sx + u * u * p2.sx;
        const py = inv * inv * p1.sy + 2 * inv * u * ctrl.sy + u * u * p2.sy;
        const pulseR = (touchesFocus ? 2.1 : 1.35) * ((p1.scale + p2.scale) * 0.5);

        ctx.fillStyle = touchesFocus ? 'rgba(255, 251, 235, 0.94)' : 'rgba(254, 240, 138, 0.84)';
        ctx.beginPath();
        ctx.arc(px, py, pulseR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawMemoryNeuron(
    ctx: CanvasRenderingContext2D,
    item: ProjectedPoint & { radius: number; node: BrainNode },
    focusId: string | undefined,
    connectedIds: Set<string>,
  ) {
    const { sx, sy, z, radius, node: n } = item;
    const isSelected = !this.immersive && n.id === this.selectedId;
    const isHovered = n.id === this.hoveredId;
    const isActiveTarget = isSelected || isHovered;
    const isNeighbor = connectedIds.has(n.id);
    const matchesFilter = !this.hasActiveFilter || this.highlightedIds.has(n.id);

    const depthAlpha = z < 0
      ? Math.max(0.25, 0.52 + z * 0.26)
      : Math.min(1, 0.78 + z * 0.26);

    let intensity = depthAlpha;
    if (!matchesFilter) intensity *= 0.24;
    else if (focusId && !isNeighbor) intensity *= 0.58;
    if (isActiveTarget) intensity = 1;

    const pulse = 1 + Math.sin(this.elapsed * 2.8 + n.phase) * 0.08;
    const haloMultiplier = isActiveTarget ? 4.3 : n.pinned ? 3.2 : 2.5;
    const glowRadius = radius * haloMultiplier * pulse;

    const halo = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowRadius);
    halo.addColorStop(0, `rgba(254, 243, 199, ${(0.94 * intensity).toFixed(3)})`);
    halo.addColorStop(0.38, `rgba(251, 191, 36, ${(0.58 * intensity).toFixed(3)})`);
    halo.addColorStop(1, 'rgba(234, 88, 12, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(sx, sy, glowRadius, 0, Math.PI * 2);
    ctx.fill();

    const coreDotR = Math.max(1.25, radius * (isActiveTarget ? 1.26 : 0.84));
    ctx.fillStyle = `rgba(255, 251, 235, ${(0.97 * intensity).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(sx, sy, coreDotR, 0, Math.PI * 2);
    ctx.fill();

    if (isActiveTarget || (this.hasActiveFilter && matchesFilter)) {
      ctx.strokeStyle = isActiveTarget
        ? 'rgba(254, 243, 199, 0.94)'
        : `rgba(253, 224, 71, ${(0.70 * intensity).toFixed(3)})`;
      ctx.lineWidth = isActiveTarget ? 1.45 : 1.0;
      const ringR = radius * (isActiveTarget ? 2.6 : 2.0);
      const startA = this.elapsed * (isActiveTarget ? 1.5 : 0.8) + n.phase;
      for (let seg = 0; seg < 3; seg++) {
        const sa = startA + (seg * Math.PI * 2) / 3;
        ctx.beginPath();
        ctx.arc(sx, sy, ringR, sa, sa + Math.PI * 0.45);
        ctx.stroke();
      }
    }
  }

  private drawInlineNodeTag(
    ctx: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    radius: number,
    topic: string,
    selected: boolean,
    canvasW: number,
  ) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = `${selected ? '600 ' : ''}11px "IBM Plex Sans", system-ui, sans-serif`;
    const label = topic.length > 16 ? `${topic.slice(0, 15)}…` : topic;
    const textW = ctx.measureText(label).width;
    const placeLeft = sx + radius + textW + 26 > canvasW;
    const tx = placeLeft ? sx - radius - 12 - textW : sx + radius + 12;
    const ty = sy + 4;

    ctx.strokeStyle = 'rgba(251, 191, 36, 0.72)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(placeLeft ? sx - radius - 2 : sx + radius + 2, sy);
    ctx.lineTo(placeLeft ? tx + textW + 5 : tx - 5, sy);
    ctx.stroke();

    ctx.fillStyle = 'rgba(12, 7, 2, 0.86)';
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.78)';
    ctx.beginPath();
    ctx.roundRect(tx - 5, ty - 11, textW + 10, 16, 4);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#fef9c3';
    ctx.fillText(label, tx, ty);
    ctx.restore();
  }

  private drawHoverCallout(
    ctx: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    radius: number,
    node: BrainNode,
    w: number,
    h: number,
  ) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = '600 12px "IBM Plex Sans", system-ui, sans-serif';
    const title = node.topic.length > 26 ? `${node.topic.slice(0, 25)}…` : node.topic;
    const sub = `${node.pinned ? '★ 核心信条 · ' : ''}突触 ${node.synapseCount} · 提取 ${node.accessCount}`;
    const titleW = ctx.measureText(title).width;
    ctx.font = '11px "IBM Plex Mono", monospace';
    const subW = ctx.measureText(sub).width;
    const boxW = Math.max(titleW, subW) + 22;
    const boxH = 42;

    const dirX = sx > w * 0.55 ? -1 : 1;
    const dirY = sy < 72 ? 1 : -1;
    const elbowX = sx + dirX * (radius + 16);
    const elbowY = sy + dirY * 14;
    const boxX = clamp(dirX > 0 ? elbowX + 10 : elbowX - boxW - 10, 10, w - boxW - 10);
    const boxY = clamp(elbowY - boxH * 0.5, 10, h - boxH - 10);

    ctx.strokeStyle = 'rgba(251, 191, 36, 0.88)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(sx + dirX * (radius + 3), sy);
    ctx.lineTo(elbowX, elbowY);
    ctx.lineTo(dirX > 0 ? boxX : boxX + boxW, elbowY);
    ctx.stroke();

    ctx.fillStyle = 'rgba(10, 6, 2, 0.92)';
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.78)';
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxW, boxH, 6);
    ctx.fill();
    ctx.stroke();

    ctx.font = '600 12px "IBM Plex Sans", system-ui, sans-serif';
    ctx.fillStyle = '#fef3c7';
    ctx.fillText(title, boxX + 11, boxY + 17);

    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.fillStyle = '#f59e0b';
    ctx.fillText(sub, boxX + 11, boxY + 33);
    ctx.restore();
  }

  private drawCornerTelemetry(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.font = '10.5px "IBM Plex Mono", monospace';
    ctx.fillStyle = 'rgba(251, 191, 36, 0.68)';
    ctx.fillText('J.A.R.V.I.S. / F.R.I.D.A.Y. // AMBER MATRIX', 14, 20);
    const statLine = `NEURONS ${this.graph.nodes.length}  ·  SYNAPSES ${this.graph.edges.length}  ·  CORE LOCKED`;
    ctx.fillStyle = 'rgba(245, 158, 11, 0.56)';
    ctx.fillText(statLine, 14, h - 13);

    const hint = '拖拽旋转 · 滚轮缩放 · 点击神经元检视';
    const hintW = ctx.measureText(hint).width;
    if (w > 460) {
      ctx.fillStyle = 'rgba(254, 243, 199, 0.45)';
      ctx.fillText(hint, w - hintW - 14, h - 13);
    }
    ctx.restore();
  }

  private hitTest(clientX: number, clientY: number): BrainNode | undefined {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: { node: BrainNode; dist: number; z: number } | undefined;
    for (const entry of this.projectedNodes.values()) {
      const hitR = Math.max(12, entry.radius * 3.2);
      const dx = x - entry.sx;
      const dy = y - entry.sy;
      const dist = Math.hypot(dx, dy);
      if (dist <= hitR) {
        if (!best || entry.z > best.z + 0.08 || (Math.abs(entry.z - best.z) <= 0.08 && dist < best.dist)) {
          best = { node: entry.node, dist, z: entry.z };
        }
      }
    }
    return best?.node;
  }

  private bindEvents() {
    this.canvas.addEventListener('pointerdown', e => {
      this.dragging = true;
      this.dragMoved = false;
      this.pointerDownX = e.clientX;
      this.pointerDownY = e.clientY;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      this.targetRotX = undefined;
      this.targetRotY = undefined;
      this.canvas.setPointerCapture(e.pointerId);
    });

    this.canvas.addEventListener('pointermove', e => {
      if (this.dragging) {
        const dx = e.clientX - this.lastPointerX;
        const dy = e.clientY - this.lastPointerY;
        this.lastPointerX = e.clientX;
        this.lastPointerY = e.clientY;
        if (Math.hypot(e.clientX - this.pointerDownX, e.clientY - this.pointerDownY) > 4) {
          this.dragMoved = true;
        }
        const dRy = dx * 0.0068;
        const dRx = dy * 0.0068;
        this.rotY += dRy;
        this.rotX = clamp(this.rotX + dRx, -1.15, 1.15);
        this.userOrbY += dRy;
        this.userOrbX = clamp(this.userOrbX + dRx, -0.95, 0.95);
        this.velY = dx * 0.0024;
        this.velX = dy * 0.0024;
        return;
      }
      const hit = this.hitTest(e.clientX, e.clientY);
      const nextHover = hit?.id;
      if (nextHover !== this.hoveredId) {
        this.hoveredId = nextHover;
        this.canvas.classList.toggle('is-hovering-node', Boolean(nextHover));
      }
    });

    const releasePointer = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
      if (!this.dragMoved) {
        const hit = this.hitTest(e.clientX, e.clientY);
        if (hit) {
          this.focusMemory(hit.id, true);
        }
      }
    };

    this.canvas.addEventListener('pointerup', releasePointer);
    this.canvas.addEventListener('pointercancel', releasePointer);
    this.canvas.addEventListener('pointerleave', () => {
      if (!this.dragging && this.hoveredId) {
        this.hoveredId = undefined;
        this.canvas.classList.remove('is-hovering-node');
      }
    });

    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.92 : 1.08;
      this.zoom = clamp(this.zoom * factor, 0.72, 1.68);
    }, { passive: false });
  }
}

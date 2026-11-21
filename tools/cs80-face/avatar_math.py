"""Pure-Python 3D squircle pose solver, spring physics, and expression engine for F.R.I.D.A.Y."""

from __future__ import annotations

from dataclasses import dataclass, field
import math
import random
import re
from typing import Callable, Dict, List, Optional, Sequence, Tuple

Vec2 = Tuple[float, float]
Vec3 = Tuple[float, float, float]
Mat3 = Tuple[float, float, float, float, float, float, float, float, float]

DEG = math.pi / 180.0

BOT_EXPRESSIONS: Tuple[str, ...] = (
    "neutral",
    "listening",
    "happy",
    "calm",
    "surprised",
    "inspecting",
    "squinted",
    "sleepy",
    "confused",
    "sad",
)

EXPRESSION_ALIAS_MAP: Dict[str, str] = {
    "neutral": "neutral",
    "default": "neutral",
    "idle": "neutral",
    "默认": "neutral",
    "待机": "neutral",
    "listening": "listening",
    "listen": "listening",
    "倾听": "listening",
    "聆听": "listening",
    "happy": "happy",
    "wink": "happy",
    "smile": "happy",
    "celebrate": "happy",
    "开心": "happy",
    "高兴": "happy",
    "笑": "happy",
    "庆祝": "happy",
    "calm": "calm",
    "gentle": "calm",
    "柔和": "calm",
    "平静": "calm",
    "淡定": "calm",
    "surprised": "surprised",
    "wow": "surprised",
    "惊讶": "surprised",
    "震惊": "surprised",
    "inspecting": "inspecting",
    "curious": "inspecting",
    "inspect": "inspecting",
    "打量": "inspecting",
    "好奇": "inspecting",
    "机智": "inspecting",
    "squinted": "squinted",
    "squint": "squinted",
    "focus": "squinted",
    "专注": "squinted",
    "眯眼": "squinted",
    "sleepy": "sleepy",
    "drowsy": "sleepy",
    "sleep": "sleepy",
    "犯困": "sleepy",
    "困": "sleepy",
    "打盹": "sleepy",
    "confused": "confused",
    "puzzle": "confused",
    "疑惑": "confused",
    "懵": "confused",
    "尴尬": "confused",
    "sad": "sad",
    "sigh": "sad",
    "难过": "sad",
    "叹气": "sad",
    "裂开": "sad",
}

BOT_TAG_RE = re.compile(
    r"\[\[\s*sticker:([^\[\]\s]{1,24})\s*\]\]|\[bot:([^\[\]\s]{1,24})\]",
    re.IGNORECASE,
)


def normalize_expression(raw: str) -> Optional[str]:
    key = (raw or "").strip().lower()
    return EXPRESSION_ALIAS_MAP.get(key)


def extract_bot_expression(text: str) -> Optional[str]:
    if not text:
        return None
    found: Optional[str] = None
    for m in BOT_TAG_RE.finditer(text):
        arg = m.group(1) if m.group(1) is not None else (m.group(2) or "")
        expr = normalize_expression(arg)
        if expr:
            found = expr
    if found:
        return found
    if "[困]" in text:
        return "sleepy"
    if "[机智]" in text:
        return "inspecting"
    if "[庆祝]" in text:
        return "happy"
    return None


def strip_bot_tags(text: str) -> str:
    if not text:
        return ""
    cleaned = BOT_TAG_RE.sub("", text)
    cleaned = re.sub(r"```[\s\S]*?```", " [代码块] ", cleaned)
    cleaned = re.sub(r"`([^`]+)`", r"\1", cleaned)
    cleaned = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", cleaned)
    cleaned = re.sub(r"(?m)^\s{0,3}#{1,6}\s+", "", cleaned)
    cleaned = re.sub(r"[*_~]+", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def ease_in_out_cubic(t: float) -> float:
    if t < 0.5:
        return 4.0 * t * t * t
    return 1.0 - ((-2.0 * t + 2.0) ** 3) / 2.0


def ease_out_cubic(t: float) -> float:
    return 1.0 - ((1.0 - t) ** 3)


def ease_out_back(t: float) -> float:
    c1 = 1.70158
    c3 = c1 + 1.0
    return 1.0 + c3 * ((t - 1.0) ** 3) + c1 * ((t - 1.0) ** 2)


@dataclass
class Spring:
    x: float = 0.0
    v: float = 0.0
    t: float = 0.0

    def step(self, omega: float, zeta: float, dt: float) -> None:
        acc = -2.0 * zeta * omega * self.v - omega * omega * (self.x - self.t)
        self.v += acc * dt
        self.x += self.v * dt
        if not (math.isfinite(self.x) and math.isfinite(self.v)):
            self.x = self.t
            self.v = 0.0

    def wrap_angle(self, target_deg: float) -> None:
        self.x += 360.0 * round((target_deg - self.x) / 360.0)
        self.t = target_deg

    def settled(self, eps_x: float = 0.03, eps_v: float = 0.05) -> bool:
        return abs(self.x - self.t) <= eps_x and abs(self.v) <= eps_v


def rot_matrix_euler(rx_deg: float, ry_deg: float, rz_deg: float) -> Mat3:
    ax = rx_deg * DEG
    ay = ry_deg * DEG
    az = rz_deg * DEG
    cx, sx = math.cos(ax), math.sin(ax)
    cy, sy = math.cos(ay), math.sin(ay)
    cz, sz = math.cos(az), math.sin(az)
    return (
        cz * cy,
        cz * sy * sx - sz * cx,
        cz * sy * cx + sz * sx,
        sz * cy,
        sz * sy * sx + cz * cx,
        sz * sy * cx - cz * sx,
        -sy,
        cy * sx,
        cy * cx,
    )


def mul_mat_vec(m: Mat3, x: float, y: float, z: float) -> Vec3:
    return (
        m[0] * x + m[1] * y + m[2] * z,
        m[3] * x + m[4] * y + m[5] * z,
        m[6] * x + m[7] * y + m[8] * z,
    )


def convex_hull_2d(pts: Sequence[Vec2]) -> List[Vec2]:
    sorted_pts = sorted(pts, key=lambda p: (p[0], p[1]))
    if len(sorted_pts) <= 2:
        return list(sorted_pts)

    def cross(o: Vec2, a: Vec2, b: Vec2) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: List[Vec2] = []
    for p in sorted_pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0.0:
            lower.pop()
        lower.append(p)

    upper: List[Vec2] = []
    for p in reversed(sorted_pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0.0:
            upper.pop()
        upper.append(p)

    return lower[:-1] + upper[:-1]


def _build_squircle_mesh(n_theta: int = 72) -> Tuple[List[List[Vec3]], float]:
    base_xy: List[Vec2] = []
    p_exp = 3.5
    for i in range(n_theta):
        th = (i / n_theta) * math.pi * 2.0
        c = math.cos(th)
        s = math.sin(th)
        sx = math.copysign(abs(c) ** (2.0 / p_exp), c) if c != 0.0 else 0.0
        sy = math.copysign(abs(s) ** (2.0 / p_exp), s) if s != 0.0 else 0.0
        base_xy.append((sx, sy))

    half_t = 0.43
    bevel = 0.22
    core_half_t = half_t - bevel
    bevel_angles = (
        math.pi * 0.5,
        math.pi * 0.36,
        math.pi * 0.20,
        0.0,
        -math.pi * 0.20,
        -math.pi * 0.36,
        -math.pi * 0.5,
    )
    rings: List[List[Vec3]] = []
    for phi in bevel_angles:
        sc = 1.0 - bevel + bevel * math.cos(phi)
        z_base = (core_half_t if phi >= 0.0 else -core_half_t) + bevel * math.sin(phi)
        dome = 0.045 * math.sin(phi) if phi >= 0.0 else -0.045 * math.sin(-phi)
        rings.append([(x * sc, y * sc, z_base + dome) for x, y in base_xy])
    return rings, half_t


_SQUIRCLE_RINGS, _SQUIRCLE_HALF_T = _build_squircle_mesh()
_EYE_OFFSET_Y = 0.045


def _eye_depth(x: float, y: float) -> float:
    return _SQUIRCLE_HALF_T + 0.045 * max(0.0, 1.0 - (x * x + y * y))


def _sample_capsule_spine(cx: float, cy: float, half_h: float, tilt_rad: float, segs: int = 5) -> List[Vec2]:
    dx = math.sin(tilt_rad)
    dy = math.cos(tilt_rad)
    pts: List[Vec2] = []
    for i in range(segs):
        u = lerp(-1.0, 1.0, i / (segs - 1))
        pts.append((cx + dx * half_h * u, cy + dy * half_h * u))
    return pts


def _sample_arc_spine(
    cx: float,
    cy: float,
    w: float,
    h: float,
    curve_dir: float,
    tilt_rad: float = 0.0,
    segs: int = 7,
) -> List[Vec2]:
    ct = math.cos(tilt_rad)
    st = math.sin(tilt_rad)
    pts: List[Vec2] = []
    for i in range(segs):
        t = i / (segs - 1)
        s = 1.0 - t
        lx = lerp(-w, w, t)
        y0 = -curve_dir * h * 0.5
        y_ctrl = curve_dir * h * 1.3
        ly = s * s * y0 + 2.0 * s * t * y_ctrl + t * t * y0
        pts.append((cx + lx * ct - ly * st, cy + lx * st + ly * ct))
    return pts


def get_eye_geometry(
    expr: str,
    side: int,
    lids: float,
    gaze: Vec2,
) -> Tuple[List[Vec2], float]:
    base_cx = side * 0.225 + gaze[0] * 0.075
    base_cy = _EYE_OFFSET_Y - gaze[1] * 0.055
    lid_factor = max(0.08, 1.0 - 0.9 * clamp(lids, 0.0, 1.0))

    if expr == "happy":
        h = 0.115 * lid_factor
        dy = 0.02 * (1.0 - lid_factor)
        return _sample_arc_spine(base_cx, base_cy + dy, 0.105, -h, 1.0, side * -0.05), 0.044
    if expr == "sleepy":
        h = 0.095 * max(0.28, lid_factor)
        return _sample_arc_spine(base_cx, base_cy + 0.03, 0.098, h, 1.0, side * 0.04), 0.042
    if expr == "calm":
        return _sample_capsule_spine(base_cx, base_cy + 0.015, 0.095 * lid_factor, 0.0), 0.068
    if expr == "surprised":
        return _sample_capsule_spine(base_cx, base_cy - 0.01, 0.205 * lid_factor, 0.0), 0.090
    if expr == "inspecting":
        if side < 0:
            return _sample_capsule_spine(base_cx, base_cy - 0.015, 0.072 * lid_factor, 0.1), 0.066
        return _sample_capsule_spine(base_cx, base_cy - 0.005, 0.18 * lid_factor, -0.03), 0.082
    if expr == "squinted":
        tilt = -side * (math.pi / 2.0 - 0.24)
        return _sample_capsule_spine(base_cx, base_cy + 0.01, 0.076, tilt), max(
            0.034, 0.045 * max(0.65, lid_factor)
        )
    if expr == "confused":
        if side < 0:
            return _sample_arc_spine(base_cx, base_cy + 0.02, 0.088, -0.065 * lid_factor, 1.0, 0.22), 0.046
        return _sample_capsule_spine(base_cx, base_cy - 0.015, 0.15 * lid_factor, -0.14), 0.070
    if expr == "sad":
        return _sample_capsule_spine(base_cx, base_cy + 0.025, 0.115 * lid_factor, side * 0.36), 0.064
    if expr == "listening":
        # Wide, bright, attentive eyes focused slightly upward with subtle perked tilt
        return _sample_capsule_spine(base_cx, base_cy - 0.018, 0.212 * lid_factor, -side * 0.05), 0.086
    return _sample_capsule_spine(base_cx, base_cy, 0.155 * lid_factor, 0.0), 0.072


@dataclass
class EyeProjection:
    points: List[Vec2]
    stroke_width: float
    opacity: float


@dataclass
class PoseFrame:
    body_polygon: List[Vec2]
    eye_left: EyeProjection
    eye_right: EyeProjection
    normal_z: float


def compute_pose_frame(
    *,
    expr: str = "neutral",
    rx: float = 0.0,
    ry: float = 0.0,
    rz: float = 0.0,
    px: float = 0.0,
    py: float = 0.0,
    sx: float = 1.0,
    sy: float = 1.0,
    scale: float = 1.0,
    lids: float = 0.0,
    gaze: Vec2 = (0.0, 0.0),
    center_x: float = 400.0,
    center_y: float = 436.0,
    base_radius: float = 192.0,
) -> PoseFrame:
    mat = rot_matrix_euler(rx, ry, rz)
    r = base_radius * scale

    def project(x: float, y: float, z: float) -> Vec3:
        vx, vy, vz = mul_mat_vec(mat, x, y, z)
        return (
            vx * sx * r + center_x + px * base_radius,
            vy * sy * r + center_y + py * base_radius,
            vz,
        )

    all_2d: List[Vec2] = []
    for ring in _SQUIRCLE_RINGS:
        for x, y, z in ring:
            p = project(x, y, z)
            all_2d.append((p[0], p[1]))
    hull = convex_hull_2d(all_2d)

    def project_eye(side: int) -> EyeProjection:
        spine, radius = get_eye_geometry(expr, side, lids, gaze)
        pts_3d = [project(ex, ey, _eye_depth(ex, ey)) for ex, ey in spine]
        mid = pts_3d[len(pts_3d) // 2]
        normal_z = mat[8]
        if normal_z <= -0.08 and mid[2] <= 0.02:
            return EyeProjection(points=[], stroke_width=0.0, opacity=0.0)
        facing_op = clamp((normal_z + 0.12) / 0.25, 0.0, 1.0)
        return EyeProjection(
            points=[(p[0], p[1]) for p in pts_3d],
            stroke_width=radius * 2.0 * r,
            opacity=facing_op,
        )

    return PoseFrame(
        body_polygon=hull,
        eye_left=project_eye(-1),
        eye_right=project_eye(1),
        normal_z=mat[8],
    )


Keyframe = Tuple[float, Tuple[float, ...], Optional[Callable[[float], float]]]


@dataclass(frozen=True)
class ClipSpec:
    duration: float
    rot: Tuple[Keyframe, ...]
    pos: Tuple[Keyframe, ...]
    squash: Tuple[Keyframe, ...]


def _eval_track(keys: Sequence[Keyframe], t: float, fallback: Tuple[float, ...]) -> Tuple[float, ...]:
    if not keys:
        return fallback
    if t <= keys[0][0]:
        return keys[0][1]
    if t >= keys[-1][0]:
        return keys[-1][1]
    idx = 0
    while idx < len(keys) - 2 and keys[idx + 1][0] <= t:
        idx += 1
    t0, v0, ease0 = keys[idx]
    t1, v1, _ = keys[idx + 1]
    u = (t - t0) / max(1e-6, t1 - t0)
    e = ease0(u) if ease0 is not None else ease_in_out_cubic(u)
    return tuple(lerp(a, b, e) for a, b in zip(v0, v1))


CLIPS: Dict[str, ClipSpec] = {
    "Idle_Calm": ClipSpec(
        duration=4.0,
        rot=((0.0, (-3.0, -9.0, -1.0), None), (4.0, (-3.0, -9.0, -1.0), None)),
        pos=((0.0, (0.0, 0.0), None), (4.0, (0.0, 0.0), None)),
        squash=((0.0, (1.0, 1.0), None), (4.0, (1.0, 1.0), None)),
    ),
    "Idle_B": ClipSpec(
        duration=3.1,
        rot=(
            (0.0, (1.0, -4.0, 0.0), None),
            (0.75, (-3.0, -17.0, -3.0), None),
            (1.65, (2.0, 16.0, 3.0), None),
            (2.45, (-1.0, 5.0, 1.0), None),
            (3.1, (1.0, -4.0, 0.0), None),
        ),
        pos=(
            (0.0, (0.0, 0.0), None),
            (0.75, (-0.03, -0.01), None),
            (1.65, (0.03, 0.01), None),
            (3.1, (0.0, 0.0), None),
        ),
        squash=(
            (0.0, (1.0, 1.0), None),
            (0.9, (1.045, 0.96), None),
            (2.0, (0.975, 1.03), None),
            (3.1, (1.0, 1.0), None),
        ),
    ),
    "Working_A": ClipSpec(
        duration=1.9,
        rot=(
            (0.0, (4.0, -14.0, -4.0), None),
            (0.45, (8.0, -14.0, -5.0), None),
            (0.95, (2.0, 14.0, 5.0), None),
            (1.4, (9.0, 14.0, 4.0), None),
            (1.9, (4.0, -14.0, -4.0), None),
        ),
        pos=(
            (0.0, (-0.02, 0.0), None),
            (0.45, (-0.02, 0.025), None),
            (0.95, (0.02, -0.015), None),
            (1.4, (0.02, 0.025), None),
            (1.9, (-0.02, 0.0), None),
        ),
        squash=(
            (0.0, (1.0, 1.0), None),
            (0.45, (1.05, 0.95), None),
            (0.95, (0.97, 1.03), None),
            (1.4, (1.05, 0.95), None),
            (1.9, (1.0, 1.0), None),
        ),
    ),
    "Streaming_A": ClipSpec(
        duration=1.4,
        rot=(
            (0.0, (-2.0, -6.0, -5.0), None),
            (0.35, (6.0, 0.0, 0.0), None),
            (0.7, (-3.0, 7.0, 5.0), None),
            (1.05, (5.0, 0.0, 0.0), None),
            (1.4, (-2.0, -6.0, -5.0), None),
        ),
        pos=(
            (0.0, (0.0, -0.02), None),
            (0.35, (0.0, 0.02), None),
            (0.7, (0.0, -0.025), None),
            (1.05, (0.0, 0.02), None),
            (1.4, (0.0, -0.02), None),
        ),
        squash=(
            (0.0, (0.97, 1.035), None),
            (0.35, (1.05, 0.95), None),
            (0.7, (0.97, 1.035), None),
            (1.05, (1.05, 0.95), None),
            (1.4, (0.97, 1.035), None),
        ),
    ),
    "Done_A": ClipSpec(
        duration=1.35,
        rot=(
            (0.0, (0.0, 0.0, 0.0), None),
            (0.25, (-14.0, 0.0, -6.0), ease_out_cubic),
            (0.55, (10.0, 0.0, 5.0), None),
            (0.85, (-10.0, 0.0, -3.0), None),
            (1.35, (0.0, 0.0, 0.0), None),
        ),
        pos=(
            (0.0, (0.0, 0.04), None),
            (0.28, (0.0, -0.14), ease_out_back),
            (0.58, (0.0, 0.03), None),
            (0.88, (0.0, -0.06), None),
            (1.35, (0.0, 0.0), None),
        ),
        squash=(
            (0.0, (1.09, 0.91), None),
            (0.28, (0.91, 1.11), None),
            (0.58, (1.08, 0.92), None),
            (0.88, (0.96, 1.05), None),
            (1.35, (1.0, 1.0), None),
        ),
    ),
    "Blocked_A": ClipSpec(
        duration=1.6,
        rot=(
            (0.0, (0.0, 0.0, 0.0), None),
            (0.3, (6.0, -20.0, -6.0), None),
            (0.65, (6.0, 20.0, 6.0), None),
            (1.0, (8.0, -14.0, -4.0), None),
            (1.6, (4.0, 0.0, 0.0), None),
        ),
        pos=(
            (0.0, (0.0, 0.0), None),
            (0.3, (-0.04, 0.02), None),
            (0.65, (0.04, 0.02), None),
            (1.6, (0.0, 0.02), None),
        ),
        squash=(
            (0.0, (1.0, 1.0), None),
            (0.5, (1.04, 0.96), None),
            (1.6, (1.02, 0.98), None),
        ),
    ),
    "Listening_A": ClipSpec(
        duration=2.4,
        rot=(
            (0.0, (-7.0, -13.0, -7.5), None),
            (1.2, (-4.0, -8.0, -9.5), None),
            (2.4, (-7.0, -13.0, -7.5), None),
        ),
        pos=(
            (0.0, (-0.02, -0.025), None),
            (1.2, (-0.015, -0.045), None),
            (2.4, (-0.02, -0.025), None),
        ),
        squash=(
            (0.0, (1.02, 0.985), None),
            (1.2, (0.985, 1.02), None),
            (2.4, (1.02, 0.985), None),
        ),
    ),
    "Sleeping_Calm": ClipSpec(
        duration=4.0,
        rot=((0.0, (13.0, -5.0, -4.0), None), (4.0, (13.0, -5.0, -4.0), None)),
        pos=((0.0, (0.0, 0.06), None), (4.0, (0.0, 0.06), None)),
        squash=((0.0, (1.05, 0.95), None), (4.0, (1.05, 0.95), None)),
    ),
    "Dreaming_REM": ClipSpec(
        duration=3.2,
        rot=(
            (0.0, (12.0, -6.0, -4.0), None),
            (0.8, (14.0, 5.0, -2.0), None),
            (1.6, (11.0, -8.0, -5.0), None),
            (2.4, (13.0, 7.0, -3.0), None),
            (3.2, (12.0, -6.0, -4.0), None),
        ),
        pos=(
            (0.0, (0.0, 0.05), None),
            (1.6, (0.0, 0.07), None),
            (3.2, (0.0, 0.05), None),
        ),
        squash=(
            (0.0, (1.04, 0.96), None),
            (1.6, (1.08, 0.93), None),
            (3.2, (1.04, 0.96), None),
        ),
    ),
}


@dataclass(frozen=True)
class StateSpec:
    id: str
    clip: str
    face: str
    morph: Optional[str] = None
    continuous: bool = True
    next_state: Optional[str] = None
    hold_seconds: float = 2.3


STATES: Dict[str, StateSpec] = {
    "idle": StateSpec("idle", "Idle_Calm", "neutral", None, continuous=False),
    "listening": StateSpec("listening", "Listening_A", "listening", None, continuous=True),
    "thinking": StateSpec("thinking", "Idle_B", "neutral", "thinking", continuous=True),
    "searching": StateSpec("searching", "Idle_B", "inspecting", "radar", continuous=True),
    "streaming": StateSpec("streaming", "Streaming_A", "neutral", None, continuous=True),
    "working": StateSpec("working", "Working_A", "inspecting", None, continuous=True),
    "waiting": StateSpec("waiting", "Idle_B", "calm", "orbit", continuous=True),
    "finished": StateSpec("finished", "Done_A", "happy", None, continuous=True, next_state="idle", hold_seconds=2.3),
    "failed": StateSpec("failed", "Blocked_A", "confused", None, continuous=True, next_state="idle", hold_seconds=2.5),
    "sleeping": StateSpec("sleeping", "Sleeping_Calm", "sleepy", None, continuous=False),
}


@dataclass
class PokeAnim:
    kind: str
    elapsed: float
    dur: float
    turns: int = 2


@dataclass
class FaceSnapshot:
    state_id: str
    sub_phase: str
    expr: str
    pose: PoseFrame
    morph: Optional[str]
    morph_progress: float
    clock: float
    worker_count: int
    settled: bool


class BotAnimator:
    """Drives F.R.I.D.A.Y.'s 3D squircle face with spring dampers & adaptive calm-idle settle."""

    def __init__(self, rng: Optional[random.Random] = None) -> None:
        self._rng = rng or random.Random()
        self.state_id: str = "idle"
        self.sub_phase: str = "awake"  # awake | nrem | rem
        self.expr_override: str = "auto"
        self.override_until: float = 0.0
        self.worker_count: int = 0
        self.clock: float = 0.0
        self.state_elapsed: float = 0.0
        self.clip_elapsed: float = 0.0

        self.gaze_target: Vec2 = (0.0, 0.0)
        self.gaze_x = Spring(0.0, 0.0, 0.0)
        self.gaze_y = Spring(0.0, 0.0, 0.0)
        self.gaze_reset_at: float = 0.0
        self.next_look_timer: float = 6.5

        self.rot_x = Spring(-3.0, 0.0, -3.0)
        self.rot_y = Spring(-9.0, 0.0, -9.0)
        self.rot_z = Spring(-1.0, 0.0, -1.0)
        self.pos_x = Spring(0.0, 0.0, 0.0)
        self.pos_y = Spring(0.0, 0.0, 0.0)
        self.scl_x = Spring(1.0, 0.0, 1.0)
        self.scl_y = Spring(1.0, 0.0, 1.0)
        self.morph_blend = Spring(0.0, 0.0, 0.0)
        self.active_morph: Optional[str] = None

        self.blink_timer: float = 3.2
        self.blink_elapsed: float = -1.0
        self.poke_anim: Optional[PokeAnim] = None
        self._dirty: bool = True

    def set_state(
        self,
        state_id: str,
        *,
        sub_phase: str = "awake",
        worker_count: int = 0,
    ) -> bool:
        if state_id not in STATES:
            state_id = "idle"
        changed = False
        if self.state_id != state_id:
            self.state_id = state_id
            self.state_elapsed = 0.0
            self.clip_elapsed = 0.0
            spec = STATES[state_id]
            if spec.morph:
                self.active_morph = spec.morph
                self.morph_blend.t = 1.0
            else:
                self.morph_blend.t = 0.0
            changed = True
        if self.sub_phase != sub_phase:
            self.sub_phase = sub_phase
            changed = True
        if self.worker_count != worker_count:
            self.worker_count = worker_count
            changed = True
        if changed:
            self._dirty = True
        return changed

    def set_expression(self, expr: str, hold_sec: float = 0.0, now_wall: Optional[float] = None) -> None:
        norm = "auto" if expr == "auto" else (normalize_expression(expr) or "neutral")
        if self.expr_override != norm:
            self.expr_override = norm
            self._dirty = True
        if norm != "auto" and hold_sec > 0.0:
            self.override_until = (now_wall if now_wall is not None else self.clock) + hold_sec
        else:
            self.override_until = 0.0

    def trigger_blink(self) -> None:
        self.blink_elapsed = 0.0
        self.blink_timer = 3.2 + self._rng.random() * 2.6
        self._dirty = True

    def trigger_poke(self, kind: str = "bounce", turns: int = 2) -> None:
        kind = kind if kind in ("bounce", "nod", "spin") else "bounce"
        turns = max(1, min(4, int(turns)))
        dur = (0.9 + 0.25 * max(0, turns - 1)) if kind == "spin" else (0.62 if kind == "bounce" else 0.48)
        self.poke_anim = PokeAnim(kind=kind, elapsed=0.0, dur=dur, turns=turns)
        if kind != "spin":
            self.blink_elapsed = 0.0
        self._dirty = True

    def next_wakeup_delay(self, now_wall: Optional[float] = None) -> float:
        """Maximum seconds daemon can sleep before the next blink, look, or override expiry."""
        spec = STATES[self.state_id]
        is_continuous = (
            spec.continuous
            or (self.state_id == "sleeping" and self.sub_phase == "rem")
            or (self.worker_count > 0)
            or self.poke_anim is not None
            or self.blink_elapsed >= 0.0
        )
        if is_continuous or self._dirty:
            return 0.105
        delays = [2.0]
        if self.state_id != "sleeping":
            delays.append(max(0.05, self.blink_timer))
        if self.state_id == "idle":
            if self.gaze_reset_at > 0.0:
                delays.append(max(0.05, self.gaze_reset_at - self.clock))
            else:
                delays.append(max(0.05, self.next_look_timer))
        if self.override_until > 0.0 and now_wall is not None:
            delays.append(max(0.05, self.override_until - now_wall))
        return min(delays)

    def step(
        self,
        dt: float,
        now_wall: Optional[float] = None,
        *,
        center_x: float = 400.0,
        center_y: float = 436.0,
        base_radius: float = 192.0,
    ) -> FaceSnapshot:
        raw_dt = max(0.001, float(dt))
        phys_dt = clamp(raw_dt, 0.001, 0.25)
        self.clock += raw_dt
        self.state_elapsed += raw_dt
        self.clip_elapsed += phys_dt

        wall = now_wall if now_wall is not None else self.clock
        if self.override_until > 0.0 and wall >= self.override_until:
            self.expr_override = "auto"
            self.override_until = 0.0
            self._dirty = True

        spec = STATES[self.state_id]
        if spec.next_state and self.state_elapsed >= spec.hold_seconds:
            self.set_state(spec.next_state, sub_phase=self.sub_phase, worker_count=self.worker_count)
            spec = STATES[self.state_id]

        # Choose clip: REM dream gets gentle REM motion; NREM sleep stays calm to save panel updates
        clip_name = spec.clip
        if self.state_id == "sleeping" and self.sub_phase == "rem":
            clip_name = "Dreaming_REM"
        clip = CLIPS[clip_name]
        if self.clip_elapsed >= clip.duration:
            self.clip_elapsed %= clip.duration

        # Natural blink (every 3.2..5.8s)
        if self.blink_elapsed >= 0.0:
            self.blink_elapsed += phys_dt
            self._dirty = True
            if self.blink_elapsed >= 0.19:
                self.blink_elapsed = -1.0
        elif self.state_id != "sleeping":
            self.blink_timer -= raw_dt
            if self.blink_timer <= 0.0:
                self.trigger_blink()

        # Periodic subtle look-around in idle
        if self.state_id == "idle" and self.poke_anim is None:
            if self.gaze_reset_at > 0.0 and self.clock >= self.gaze_reset_at:
                self.gaze_target = (0.0, 0.0)
                self.gaze_reset_at = 0.0
                self._dirty = True
            elif self.gaze_reset_at <= 0.0:
                self.next_look_timer -= raw_dt
                if self.next_look_timer <= 0.0:
                    gx = self._rng.uniform(-0.75, 0.75)
                    gy = self._rng.uniform(-0.35, 0.35)
                    self.gaze_target = (gx, gy)
                    self.gaze_reset_at = self.clock + 1.5
                    self.next_look_timer = 7.0 + self._rng.random() * 6.0
                    self._dirty = True
        elif self.state_id == "sleeping" and self.sub_phase == "rem":
            # Subtle REM eye drift under closed eyelids
            self.gaze_target = (math.sin(self.clock * 2.1) * 0.65, math.cos(self.clock * 1.4) * 0.25)
        elif self.gaze_target != (0.0, 0.0) or self.gaze_reset_at > 0.0:
            self.gaze_target = (0.0, 0.0)
            self.gaze_reset_at = 0.0
            self._dirty = True

        if self.poke_anim is not None:
            self.poke_anim.elapsed += phys_dt
            self._dirty = True
            if self.poke_anim.elapsed >= self.poke_anim.dur:
                self.poke_anim = None

        t_clip = self.clip_elapsed % clip.duration
        target_rot = _eval_track(clip.rot, t_clip, (0.0, 0.0, 0.0))
        target_pos = _eval_track(clip.pos, t_clip, (0.0, 0.0))
        target_scl = _eval_track(clip.squash, t_clip, (1.0, 1.0))

        self.rot_x.wrap_angle(target_rot[0])
        self.rot_y.wrap_angle(target_rot[1])
        self.rot_z.wrap_angle(target_rot[2])
        self.pos_x.t = target_pos[0]
        self.pos_y.t = target_pos[1]
        self.scl_x.t = target_scl[0]
        self.scl_y.t = target_scl[1]
        self.gaze_x.t = self.gaze_target[0]
        self.gaze_y.t = self.gaze_target[1]

        sub_dt = 1.0 / 120.0
        steps = max(1, math.ceil(phys_dt / sub_dt))
        h = phys_dt / steps
        for _ in range(steps):
            self.gaze_x.step(14.0, 0.82, h)
            self.gaze_y.step(14.0, 0.82, h)
            self.rot_x.step(18.0, 0.88, h)
            self.rot_y.step(18.0, 0.88, h)
            self.rot_z.step(18.0, 0.88, h)
            self.pos_x.step(18.0, 0.88, h)
            self.pos_y.step(18.0, 0.88, h)
            self.scl_x.step(20.0, 0.85, h)
            self.scl_y.step(20.0, 0.85, h)
            self.morph_blend.step(12.0, 1.0, h)

        if self.morph_blend.t == 0.0 and self.morph_blend.x < 0.01:
            self.active_morph = None

        is_continuous = spec.continuous or (self.state_id == "sleeping" and self.sub_phase == "rem") or (
            self.worker_count > 0
        )
        breath = math.sin(self.clock * 2.1) if is_continuous else 0.0

        rx = self.rot_x.x - self.gaze_y.x * 16.0 + breath * 1.3
        ry = self.rot_y.x + self.gaze_x.x * 22.0
        rz = self.rot_z.x + self.gaze_x.x * 3.5
        px = self.pos_x.x + self.gaze_x.x * 0.04
        py = self.pos_y.x - self.gaze_y.x * 0.03 + breath * 0.009
        sx = self.scl_x.x * (1.0 + breath * 0.011)
        sy = self.scl_y.x * (1.0 - breath * 0.011)

        if self.poke_anim is not None:
            u = clamp(self.poke_anim.elapsed / self.poke_anim.dur, 0.0, 1.0)
            if self.poke_anim.kind == "bounce":
                hop = math.sin(u * math.pi)
                sq = math.sin(u * math.pi * 2.0)
                py -= hop * 0.24
                sy *= 1.0 + sq * 0.14
                sx *= 1.0 - sq * 0.10
                rx -= hop * 8.0
            elif self.poke_anim.kind == "nod":
                nod = math.sin(u * math.pi * 3.0) * (1.0 - u)
                rx += nod * 24.0
                py += max(0.0, nod) * 0.06
            else:
                e = ease_in_out_cubic(u)
                ry += e * 360.0 * self.poke_anim.turns
                jump = math.sin(u * math.pi)
                py -= jump * 0.12
                sy *= 1.0 + jump * 0.07
                sx *= 1.0 - jump * 0.05

        lids = 0.0
        if self.blink_elapsed >= 0.0:
            bu = clamp(self.blink_elapsed / 0.19, 0.0, 1.0)
            lids = math.sin(bu * math.pi)

        expr = spec.face if self.expr_override == "auto" else self.expr_override
        morph_p = clamp(self.morph_blend.x, 0.0, 1.0)
        body_scale = 1.0 - morph_p * 0.10

        pose = compute_pose_frame(
            expr=expr,
            rx=rx,
            ry=ry,
            rz=rz,
            px=px,
            py=py,
            sx=sx,
            sy=sy,
            scale=body_scale,
            lids=lids,
            gaze=(self.gaze_x.x, self.gaze_y.x),
            center_x=center_x,
            center_y=center_y,
            base_radius=base_radius,
        )

        springs_settled = (
            self.gaze_x.settled(0.01, 0.02)
            and self.gaze_y.settled(0.01, 0.02)
            and self.rot_x.settled(0.08, 0.15)
            and self.rot_y.settled(0.08, 0.15)
            and self.rot_z.settled(0.08, 0.15)
            and self.pos_x.settled(0.004, 0.01)
            and self.pos_y.settled(0.004, 0.01)
            and self.scl_x.settled(0.004, 0.01)
            and self.scl_y.settled(0.004, 0.01)
            and self.morph_blend.settled(0.01, 0.02)
        )
        settled = (
            not is_continuous
            and not self._dirty
            and self.poke_anim is None
            and self.blink_elapsed < 0.0
            and springs_settled
        )
        self._dirty = False

        return FaceSnapshot(
            state_id=self.state_id,
            sub_phase=self.sub_phase,
            expr=expr,
            pose=pose,
            morph=self.active_morph if morph_p > 0.02 else None,
            morph_progress=morph_p,
            clock=self.clock,
            worker_count=self.worker_count,
            settled=settled,
        )

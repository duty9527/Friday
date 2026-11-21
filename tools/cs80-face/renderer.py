"""Zero-flicker 800x1280 3-layer Cairo/fallback renderer, smooth marquee & Bento cards for CS80."""

from __future__ import annotations

import ctypes
from dataclasses import dataclass
import math
from pathlib import Path
import re
import struct
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple
import zlib

try:
    import cairo  # type: ignore
except ImportError:  # pragma: no cover - local dev fallback when pycairo is absent
    cairo = None  # type: ignore

from avatar_math import FaceSnapshot, clamp
from widgets import PlacedCard, pack_bento_page

WIDTH = 800
HEIGHT = 1280
FRAME_BYTES = WIDTH * HEIGHT * 2
TILE_W = 32
TILE_H = 16
TILE_MSG_BYTES = 4 + TILE_W * TILE_H * 2
MAX_PATCH_TILES = 160
MAX_MARQUEE_CHARS = 120
MAX_MARQUEE_SURF_W = 3200


def _clean_marquee_text(text: str) -> str:
    clean = " ".join(_sanitize_hud_text(text or "").split())
    if len(clean) > MAX_MARQUEE_CHARS:
        return clean[:MAX_MARQUEE_CHARS].rstrip() + "…"
    return clean

# Layout geometries indexed by grid_rows (2 -> 2x2 large face, 3 -> 2x3 compact stage + 6 cells)
STAGE_GEOMETRY: Dict[int, Dict[str, float]] = {
    2: {
        "face_cx": 400.0,
        "face_cy": 354.0,
        "face_r": 168.0,
        "marquee_y": 644.0,
        "marquee_h": 50.0,
        "grid_y": 710.0,
        "grid_h": 488.0,
        "gap": 16.0,
    },
    3: {
        "face_cx": 400.0,
        "face_cy": 272.0,
        "face_r": 132.0,
        "marquee_y": 492.0,
        "marquee_h": 48.0,
        "grid_y": 556.0,
        "grid_h": 642.0,
        "gap": 15.0,
    },
}


def stage_geometry_for_rows(grid_rows: int) -> Dict[str, float]:
    return STAGE_GEOMETRY[3 if int(grid_rows) == 3 else 2]


# Pure zero-flicker SC7705 palette (pure black background + saturated primaries + crisp white)
COL_BG = (0.0, 0.0, 0.0)
COL_AMBER = (0xE8 / 255.0, 0x8B / 255.0, 0x0A / 255.0)
COL_AMBER_BRIGHT = (0xFB / 255.0, 0xBF / 255.0, 0x24 / 255.0)
COL_AMBER_DIM = (0xB4 / 255.0, 0x53 / 255.0, 0x09 / 255.0)
COL_AMBER_DARK_LINE = (0x78 / 255.0, 0x35 / 255.0, 0x0F / 255.0)
COL_WHITE = (1.0, 1.0, 1.0)
COL_EMERALD = (0x10 / 255.0, 0xB9 / 255.0, 0x81 / 255.0)
COL_RED = (0xEF / 255.0, 0x44 / 255.0, 0x44 / 255.0)
COL_SKY = (0x38 / 255.0, 0xBD / 255.0, 0xF8 / 255.0)
COL_SLATE = (0x94 / 255.0, 0xA3 / 255.0, 0xB8 / 255.0)
COL_NB_LIME = (0x3E / 255.0, 0xE6 / 255.0, 0x4E / 255.0)

STATE_BADGES = {
    "idle": ("待机守候", COL_AMBER),
    "listening": ("正在倾听", COL_EMERALD),
    "thinking": ("思考推演", COL_AMBER_BRIGHT),
    "searching": ("记忆检索", COL_AMBER_BRIGHT),
    "streaming": ("正在回复", COL_WHITE),
    "working": ("协同执行", COL_EMERALD),
    "waiting": ("等待指示", COL_AMBER_BRIGHT),
    "finished": ("执行完成", COL_EMERALD),
    "failed": ("执行受阻", COL_RED),
    "sleeping": ("静默休眠", COL_AMBER_DIM),
    "speaking": ("语音播报", COL_AMBER_BRIGHT),
    "sending_msg": ("发送消息", COL_EMERALD),
    "printing": ("正在打印", COL_AMBER_BRIGHT),
    "operating_xiaoai": ("操控小爱", COL_EMERALD),
    "operating_tv": ("操控电视", COL_SKY),
    "managing_laifen": ("牙刷管理", COL_SKY),
    "weighing_scale": ("体脂测重", COL_EMERALD),
}

_PROFILE_ZH: Dict[str, str] = {
    "general": "通用",
    "coding": "编码",
    "code": "编码",
    "research": "调研",
    "ops": "运维",
    "analysis": "分析",
    "review": "审查",
    "plan": "规划",
    "writer": "写作",
}

_CHANNEL_ZH: Dict[str, str] = {
    "WX": "微信",
    "WECHAT": "微信",
    "XIAOAI": "小爱",
    "TG": "电报",
    "TELEGRAM": "电报",
    "DT": "钉钉",
    "DINGTALK": "钉钉",
}

_HEADLINE_SRC_ZH: Dict[str, str] = {
    "WX": "微信",
    "WECHAT": "微信",
    "XIAOAI": "小爱",
    "TG": "电报",
    "TELEGRAM": "电报",
    "DT": "钉钉",
    "DINGTALK": "钉钉",
    "WEB": "控制台",
    "LOCAL": "控制台",
    "USER": "提问",
    "FRIDAY": "主脑",
    "OFFLINE": "离线",
    "ALERT": "互动",
}


def _localize_profile_tag(profile: str) -> str:
    raw = str(profile or "general").strip()
    return _PROFILE_ZH.get(raw.lower(), raw or "通用")


def _localize_channel_label(label: str) -> str:
    raw = str(label or "").strip()
    return _CHANNEL_ZH.get(raw.upper(), raw)


def _localize_headline_source(src: str) -> str:
    clean = _sanitize_hud_text(src or "主脑")
    if not clean:
        return "主脑"
    parts = [p.strip() for p in clean.split("·")]
    head_up = parts[0].upper()
    if head_up in _HEADLINE_SRC_ZH:
        parts[0] = _HEADLINE_SRC_ZH[head_up]
        return " · ".join(p for p in parts if p)[:18]
    return clean[:18]


@dataclass(frozen=True)
class WorkerSummary:
    task_id: str
    profile: str
    prompt: str
    elapsed_sec: int
    status: str = "running"


@dataclass(frozen=True)
class HudState:
    headline_meta: str = "F.R.I.D.A.Y. · 就绪"
    headline_source: str = "主脑"
    headline_text: str = "全天候个人 AI 副手待命。"
    ask_boss_question: str = ""
    workers: Tuple[WorkerSummary, ...] = ()
    channels: Tuple[Tuple[str, bool], ...] = (("微信", False), ("小爱", False), ("电报", False))
    memory_count: int = 0
    today_calls: int = 0
    speaker_volume: int = 65
    speaker_muted: bool = False
    friday_connected: bool = False
    clock_hm: str = ""
    voice_caption: str = ""
    grid_rows: int = 2
    active_page: int = 0
    page_count: int = 1
    page_name: str = "核心总览"
    auto_task_overlay: bool = True
    marquee_mode: str = "auto_pause"
    marquee_speed: int = 2
    layout_rev: int = 1
    data_rev: int = 1
    headline_incoming: bool = False
    scene_channel: str = ""
    scene_caption: str = ""


class MarqueeController:
    """Manages smooth horizontal single-line marquee with smart 2-loop auto-pause."""

    SPEED_PX_SEC = {1: 38.0, 2: 58.0, 3: 88.0}

    def __init__(self) -> None:
        self.text: str = ""
        self.text_w: float = 0.0
        self.viewport_w: float = 520.0
        self.gap: float = 72.0
        self.scroll_x: float = 0.0
        self.loops_done: int = 0
        self.phase: str = "rest"  # "lead_pause" | "scroll" | "rest"
        self.phase_elapsed: float = 0.0
        self.mode: str = "auto_pause"
        self.speed_level: int = 2
        self._last_mode: str = "auto_pause"

    def set_content(
        self,
        text: str,
        text_w: float,
        viewport_w: float,
        mode: str = "auto_pause",
        speed_level: int = 2,
    ) -> None:
        clean = _clean_marquee_text(text)
        mode = mode if mode in ("auto_pause", "continuous", "static") else "auto_pause"
        speed_level = max(1, min(3, int(speed_level or 2)))
        text_changed = clean != self.text
        mode_changed = mode != self._last_mode
        self.text = clean
        self.text_w = max(0.0, float(text_w))
        self.viewport_w = max(120.0, float(viewport_w))
        self.mode = mode
        self._last_mode = mode
        self.speed_level = speed_level

        overflows = self.text_w > self.viewport_w + 4.0
        if not overflows or mode == "static":
            self.scroll_x = 0.0
            self.loops_done = 0
            self.phase = "rest"
            self.phase_elapsed = 0.0
        elif text_changed or mode_changed:
            self.scroll_x = 0.0
            self.loops_done = 0
            self.phase = "lead_pause"
            self.phase_elapsed = 0.0

    def step(self, dt: float) -> bool:
        """Advance marquee by dt seconds; return True if scroll offset changed visually."""
        if self.mode == "static" or self.text_w <= self.viewport_w + 4.0 or self.phase == "rest":
            return False
        raw_dt = max(0.001, min(0.25, float(dt)))
        if self.phase == "lead_pause":
            self.phase_elapsed += raw_dt
            if self.phase_elapsed >= 1.1:
                self.phase = "scroll"
                self.phase_elapsed = 0.0
            return False

        # phase == "scroll"
        speed = self.SPEED_PX_SEC.get(self.speed_level, 58.0)
        cycle = self.text_w + self.gap
        prev_int = int(round(self.scroll_x))
        self.scroll_x += speed * raw_dt
        if self.scroll_x >= cycle:
            self.scroll_x %= cycle
            self.loops_done += 1
            if self.mode == "auto_pause" and self.loops_done >= 2:
                self.scroll_x = 0.0
                self.phase = "rest"
                return True
        return int(round(self.scroll_x)) != prev_int

    def next_wakeup_delay(self) -> Optional[float]:
        if self.mode == "static" or self.text_w <= self.viewport_w + 4.0 or self.phase == "rest":
            return None
        if self.phase == "lead_pause":
            return max(0.05, 1.12 - self.phase_elapsed)
        return 0.12


class _Fast565Lib:
    def __init__(self) -> None:
        self._lib = None
        so_path = Path(__file__).resolve().parent / "bin" / "fast565.so"
        if so_path.is_file():
            try:
                lib = ctypes.CDLL(str(so_path))
                lib.bgra_to_bgr565.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
                lib.bgra_to_bgr565.restype = None
                lib.bgr565_to_rgb24.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
                lib.bgr565_to_rgb24.restype = None
                lib.diff_tiles_32x16.argtypes = [
                    ctypes.c_void_p,
                    ctypes.c_void_p,
                    ctypes.c_uint32,
                    ctypes.c_uint32,
                    ctypes.c_void_p,
                    ctypes.c_uint32,
                ]
                lib.diff_tiles_32x16.restype = ctypes.c_uint32
                self._lib = lib
            except OSError:
                self._lib = None

    @property
    def loaded(self) -> bool:
        return self._lib is not None

    @staticmethod
    def _c_buf(buf: bytes | bytearray | memoryview, byte_len: int):
        if isinstance(buf, bytes):
            return buf
        mv = memoryview(buf)
        if not mv.readonly and mv.c_contiguous:
            return (ctypes.c_ubyte * byte_len).from_buffer(mv)
        return bytes(mv)

    def bgra_to_bgr565(self, bgra: bytes | bytearray | memoryview, out_buf: bytearray) -> None:
        pixels = WIDTH * HEIGHT
        if self._lib is not None:
            src_arr = self._c_buf(bgra, pixels * 4)
            dst_arr = (ctypes.c_uint16 * pixels).from_buffer(out_buf)
            self._lib.bgra_to_bgr565(src_arr, dst_arr, pixels)
            return
        mv = memoryview(bgra)
        for i in range(pixels):
            j = i * 4
            b = mv[j]
            g = mv[j + 1]
            r = mv[j + 2]
            px = ((b & 0xF8) << 8) | ((g & 0xFC) << 3) | (r >> 3)
            out_buf[i * 2] = px & 0xFF
            out_buf[i * 2 + 1] = (px >> 8) & 0xFF

    def bgr565_to_rgb24(self, in565: bytes | bytearray | memoryview, out_rgb: bytearray) -> None:
        pixels = WIDTH * HEIGHT
        if self._lib is not None:
            src_arr = self._c_buf(in565, pixels * 2)
            dst_arr = (ctypes.c_ubyte * (pixels * 3)).from_buffer(out_rgb)
            self._lib.bgr565_to_rgb24(src_arr, dst_arr, pixels)
            return
        for i in range(pixels):
            px = in565[i * 2] | (in565[i * 2 + 1] << 8)
            b5 = (px >> 11) & 0x1F
            g6 = (px >> 5) & 0x3F
            r5 = px & 0x1F
            out_rgb[i * 3] = (r5 << 3) | (r5 >> 2)
            out_rgb[i * 3 + 1] = (g6 << 2) | (g6 >> 4)
            out_rgb[i * 3 + 2] = (b5 << 3) | (b5 >> 2)

    def bgra_band_to_bgr565(
        self,
        bgra: bytes | bytearray | memoryview,
        out_buf: bytearray,
        y0: int,
        y1: int,
    ) -> None:
        y0 = max(0, min(HEIGHT, int(y0)))
        y1 = max(y0, min(HEIGHT, int(y1)))
        rows = y1 - y0
        if rows <= 0:
            return
        if y0 == 0 and y1 == HEIGHT:
            self.bgra_to_bgr565(bgra, out_buf)
            return
        pixels = WIDTH * rows
        src_off = y0 * WIDTH * 4
        dst_off = y0 * WIDTH * 2
        mv_src = memoryview(bgra)[src_off : src_off + pixels * 4]
        mv_dst = memoryview(out_buf)[dst_off : dst_off + pixels * 2]
        if self._lib is not None:
            src_arr = self._c_buf(mv_src, pixels * 4)
            dst_arr = (ctypes.c_uint16 * pixels).from_buffer(mv_dst)
            self._lib.bgra_to_bgr565(src_arr, dst_arr, pixels)
            return
        for i in range(pixels):
            j = i * 4
            b = mv_src[j]
            g = mv_src[j + 1]
            r = mv_src[j + 2]
            px = ((b & 0xF8) << 8) | ((g & 0xFC) << 3) | (r >> 3)
            mv_dst[i * 2] = px & 0xFF
            mv_dst[i * 2 + 1] = (px >> 8) & 0xFF

    def diff_tiles(
        self,
        prev565: bytearray,
        curr565: bytearray,
        out_tiles: bytearray,
        max_tiles: int = MAX_PATCH_TILES,
    ) -> int:
        return self.diff_tiles_band(prev565, curr565, out_tiles, 0, HEIGHT, max_tiles)

    def diff_tiles_band(
        self,
        prev565: bytearray,
        curr565: bytearray,
        out_tiles: bytearray,
        y0: int,
        y1: int,
        max_tiles: int = MAX_PATCH_TILES,
    ) -> int:
        y0 = max(0, (int(y0) // TILE_H) * TILE_H)
        y1 = min(HEIGHT, ((int(y1) + TILE_H - 1) // TILE_H) * TILE_H)
        rows = y1 - y0
        if rows <= 0:
            return 0
        if self._lib is not None:
            pixels = WIDTH * rows
            byte_off = y0 * WIDTH * 2
            p_arr = (ctypes.c_uint16 * pixels).from_buffer(memoryview(prev565)[byte_off : byte_off + pixels * 2])
            c_arr = (ctypes.c_uint16 * pixels).from_buffer(memoryview(curr565)[byte_off : byte_off + pixels * 2])
            o_arr = (ctypes.c_ubyte * (max_tiles * TILE_MSG_BYTES)).from_buffer(out_tiles)
            dirty = int(self._lib.diff_tiles_32x16(p_arr, c_arr, WIDTH, rows, o_arr, max_tiles))
            if y0 > 0 and 0 < dirty <= max_tiles:
                for i in range(dirty):
                    off = i * TILE_MSG_BYTES + 2
                    ty_rel = struct.unpack_from("<H", out_tiles, off)[0]
                    struct.pack_into("<H", out_tiles, off, ty_rel + y0)
            return dirty

        dirty = 0
        row_bytes = TILE_W * 2
        for ty in range(y0, y1, TILE_H):
            for tx in range(0, WIDTH, TILE_W):
                changed = False
                for r in range(TILE_H):
                    off = ((ty + r) * WIDTH + tx) * 2
                    if prev565[off : off + row_bytes] != curr565[off : off + row_bytes]:
                        changed = True
                        break
                if not changed:
                    continue
                if dirty >= max_tiles:
                    return max_tiles + 1
                base = dirty * TILE_MSG_BYTES
                struct.pack_into("<HH", out_tiles, base, tx, ty)
                dst = base + 4
                for r in range(TILE_H):
                    off = ((ty + r) * WIDTH + tx) * 2
                    out_tiles[dst : dst + row_bytes] = curr565[off : off + row_bytes]
                    dst += row_bytes
                dirty += 1
        return dirty


def _encode_png_rgb24(width: int, height: int, rgb: bytes | bytearray) -> bytes:
    stride = width * 3
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        start = y * stride
        raw.extend(rgb[start : start + stride])
    compressed = zlib.compress(bytes(raw), level=6)

    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")


_EMOJI_STRIP_RE = re.compile(
    r"[\U0001F000-\U0001FAFF\u2600-\u27BF\u231A-\u231B\u23E9-\u23FA\u2B50\u2B55\uFE0E\uFE0F\u200D]"
)


def _sanitize_hud_text(text: str) -> str:
    if not text:
        return ""
    cleaned = _EMOJI_STRIP_RE.sub("", str(text))
    return re.sub(r" {2,}", " ", cleaned).strip()


def _cairo_four_star(ctx, cx: float, cy: float, r: float) -> None:
    inner = r * 0.28
    ctx.new_path()
    for i in range(8):
        ang = i * math.pi * 0.25
        rad = r if i % 2 == 0 else inner
        px = cx + math.cos(ang) * rad
        py = cy + math.sin(ang) * rad
        if i == 0:
            ctx.move_to(px, py)
        else:
            ctx.line_to(px, py)
    ctx.close_path()
    ctx.fill()


def _cairo_lightning_bolt(ctx, x: float, y: float, h: float) -> None:
    w = h * 0.65
    pts = (
        (x + w * 0.62, y),
        (x + w * 0.08, y + h * 0.56),
        (x + w * 0.46, y + h * 0.56),
        (x + w * 0.30, y + h),
        (x + w * 0.92, y + h * 0.42),
        (x + w * 0.52, y + h * 0.42),
    )
    ctx.new_path()
    ctx.move_to(pts[0][0], pts[0][1])
    for px, py in pts[1:]:
        ctx.line_to(px, py)
    ctx.close_path()
    ctx.fill()


def _cairo_lock_glyph(
    ctx,
    x: float,
    y: float,
    h: float,
    locked: bool = True,
    col: Tuple[float, float, float] = COL_EMERALD,
) -> None:
    w = h * 0.78
    cx = x + w * 0.5
    sr = w * 0.27
    sy = y + (h * 0.34 if locked else h * 0.26)
    ctx.set_source_rgb(*col)
    ctx.set_line_width(max(1.5, h * 0.13))
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.new_path()
    ctx.arc(cx, sy, sr, math.pi, math.pi * 2.0)
    ctx.stroke()

    ctx.new_path()
    ctx.move_to(cx - sr, sy)
    ctx.line_to(cx - sr, y + h * 0.45)
    if locked:
        ctx.move_to(cx + sr, sy)
        ctx.line_to(cx + sr, y + h * 0.45)
    ctx.stroke()

    _cairo_rounded_rect(ctx, x + w * 0.08, y + h * 0.44, w * 0.84, h * 0.54, max(2.0, h * 0.12))
    ctx.set_source_rgb(*col)
    ctx.fill()

    ctx.new_path()
    ctx.arc(cx, y + h * 0.70, max(1.1, h * 0.08), 0.0, math.pi * 2.0)
    ctx.set_source_rgb(*COL_BG)
    ctx.fill()


def _cairo_pin_glyph(
    ctx,
    x: float,
    y: float,
    h: float,
    col: Tuple[float, float, float] = COL_AMBER_BRIGHT,
) -> None:
    w = h * 0.72
    cx = x + w * 0.5
    r = w * 0.44
    cy = y + r
    ctx.set_source_rgb(*col)
    ctx.new_path()
    ctx.arc(cx, cy, r, 0.0, math.pi * 2.0)
    ctx.fill()

    ctx.new_path()
    ctx.move_to(cx - r * 0.86, cy + r * 0.38)
    ctx.line_to(cx, y + h)
    ctx.line_to(cx + r * 0.86, cy + r * 0.38)
    ctx.close_path()
    ctx.fill()

    ctx.new_path()
    ctx.arc(cx, cy, max(1.3, r * 0.40), 0.0, math.pi * 2.0)
    ctx.set_source_rgb(*COL_BG)
    ctx.fill()


def _cairo_tv_glyph(
    ctx,
    x: float,
    y: float,
    w: float,
    h: float,
    online: bool = True,
    col: Tuple[float, float, float] = COL_EMERALD,
) -> None:
    screen_h = h * 0.76
    _cairo_rounded_rect(ctx, x, y, w, screen_h, max(3.0, h * 0.12))
    ctx.set_source_rgba(col[0], col[1], col[2], 0.14 if online else 0.04)
    ctx.fill_preserve()
    ctx.set_source_rgb(*col)
    ctx.set_line_width(max(1.8, h * 0.06))
    ctx.stroke()

    if online:
        # Subtle play triangle inside TV screen
        cx = x + w * 0.5
        cy = y + screen_h * 0.5
        pr = min(w, screen_h) * 0.22
        ctx.new_path()
        ctx.move_to(cx - pr * 0.55, cy - pr * 0.82)
        ctx.line_to(cx + pr * 0.95, cy)
        ctx.line_to(cx - pr * 0.55, cy + pr * 0.82)
        ctx.close_path()
        ctx.set_source_rgb(*COL_WHITE)
        ctx.fill()
    else:
        ctx.new_path()
        ctx.move_to(x + w * 0.32, y + screen_h * 0.5)
        ctx.line_to(x + w * 0.68, y + screen_h * 0.5)
        ctx.set_source_rgb(*col)
        ctx.set_line_width(2.0)
        ctx.set_line_cap(cairo.LINE_CAP_ROUND)
        ctx.stroke()

    # Stand neck and base
    cx = x + w * 0.5
    ctx.new_path()
    ctx.move_to(cx, y + screen_h)
    ctx.line_to(cx, y + h * 0.94)
    ctx.move_to(cx - w * 0.28, y + h * 0.96)
    ctx.line_to(cx + w * 0.28, y + h * 0.96)
    ctx.set_source_rgb(*col)
    ctx.set_line_width(max(2.0, h * 0.07))
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.stroke()


def _cairo_remote_dpad(
    ctx,
    cx: float,
    cy: float,
    r: float,
    ready: bool = True,
    col: Tuple[float, float, float] = COL_EMERALD,
) -> None:
    if ready:
        # Subtle IR waves above top of D-pad
        ctx.set_line_cap(cairo.LINE_CAP_ROUND)
        for i, wave_r in enumerate((r * 1.16, r * 1.36)):
            ctx.new_path()
            ctx.arc(cx, cy - r * 0.15, wave_r, math.pi * 1.30, math.pi * 1.70)
            ctx.set_source_rgba(col[0], col[1], col[2], 0.72 - i * 0.28)
            ctx.set_line_width(max(1.6, r * 0.08))
            ctx.stroke()

    # Outer ring
    ctx.new_path()
    ctx.arc(cx, cy, r, 0.0, math.pi * 2.0)
    ctx.set_source_rgba(col[0], col[1], col[2], 0.10 if ready else 0.04)
    ctx.fill_preserve()
    ctx.set_source_rgb(*col)
    ctx.set_line_width(max(1.8, r * 0.07))
    ctx.stroke()

    # Inner OK circle
    ir = r * 0.34
    ctx.new_path()
    ctx.arc(cx, cy, ir, 0.0, math.pi * 2.0)
    ctx.set_source_rgba(COL_AMBER_BRIGHT[0], COL_AMBER_BRIGHT[1], COL_AMBER_BRIGHT[2], 0.22 if ready else 0.08)
    ctx.fill_preserve()
    ctx.set_source_rgb(*(COL_AMBER_BRIGHT if ready else COL_AMBER_DIM))
    ctx.set_line_width(max(1.4, r * 0.05))
    ctx.stroke()

    # 4 directional indicator dots/chevrons
    d_dist = r * 0.67
    chev = r * 0.12
    ctx.set_source_rgb(*(COL_WHITE if ready else COL_AMBER_DIM))
    ctx.set_line_width(max(1.6, r * 0.07))
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.set_line_join(cairo.LINE_JOIN_ROUND)
    for dx, dy in ((0.0, -1.0), (0.0, 1.0), (-1.0, 0.0), (1.0, 0.0)):
        px = cx + dx * d_dist
        py = cy + dy * d_dist
        nx, ny = -dy, dx
        ctx.new_path()
        ctx.move_to(px - dx * chev * 0.5 + nx * chev, py - dy * chev * 0.5 + ny * chev)
        ctx.line_to(px + dx * chev * 0.7, py + dy * chev * 0.7)
        ctx.line_to(px - dx * chev * 0.5 - nx * chev, py - dy * chev * 0.5 - ny * chev)
        ctx.stroke()


def _draw_cloud_shape(
    ctx,
    cx: float,
    cy: float,
    s: float,
    col: Tuple[float, float, float],
    alpha: float = 1.0,
) -> None:
    ctx.set_source_rgba(col[0], col[1], col[2], alpha)
    for ox, oy, rad in (
        (-s * 0.32, s * 0.08, s * 0.28),
        (0.0, -s * 0.06, s * 0.36),
        (s * 0.34, s * 0.10, s * 0.25),
    ):
        ctx.new_path()
        ctx.arc(cx + ox, cy + oy, rad, 0.0, math.pi * 2.0)
        ctx.fill()
    _cairo_rounded_rect(ctx, cx - s * 0.58, cy + s * 0.04, s * 1.16, s * 0.32, s * 0.15)
    ctx.fill()


def _draw_weather_icon_cairo(ctx, cx: float, cy: float, r: float, wcode: Optional[int]) -> None:
    code = 2 if wcode is None else int(wcode)

    def draw_sun(sx: float, sy: float, sr: float) -> None:
        ctx.new_path()
        ctx.arc(sx, sy, sr * 1.18, 0.0, math.pi * 2.0)
        ctx.set_source_rgba(COL_AMBER_BRIGHT[0], COL_AMBER_BRIGHT[1], COL_AMBER_BRIGHT[2], 0.20)
        ctx.fill()
        ctx.new_path()
        ctx.arc(sx, sy, sr * 0.72, 0.0, math.pi * 2.0)
        ctx.set_source_rgb(*COL_AMBER_BRIGHT)
        ctx.fill()
        ctx.set_line_width(max(1.8, sr * 0.16))
        ctx.set_line_cap(cairo.LINE_CAP_ROUND)
        for i in range(8):
            ang = i * math.pi * 0.25
            ctx.new_path()
            ctx.move_to(sx + math.cos(ang) * sr * 0.96, sy + math.sin(ang) * sr * 0.96)
            ctx.line_to(sx + math.cos(ang) * sr * 1.32, sy + math.sin(ang) * sr * 1.32)
            ctx.stroke()

    if code == 0:
        draw_sun(cx, cy, r * 0.66)
    elif code in (1, 2):
        draw_sun(cx + r * 0.28, cy - r * 0.22, r * 0.44)
        _draw_cloud_shape(ctx, cx - r * 0.08, cy + r * 0.18, r * 0.92, COL_WHITE, 0.95)
    elif code == 3:
        _draw_cloud_shape(ctx, cx + r * 0.16, cy - r * 0.12, r * 0.76, COL_SLATE, 0.65)
        _draw_cloud_shape(ctx, cx - r * 0.08, cy + r * 0.14, r * 0.92, COL_WHITE, 0.95)
    elif code in (45, 48):
        _draw_cloud_shape(ctx, cx, cy - r * 0.14, r * 0.84, COL_SLATE, 0.85)
        ctx.set_line_cap(cairo.LINE_CAP_ROUND)
        ctx.set_line_width(max(2.0, r * 0.11))
        for idx, dy in enumerate((0.28, 0.52)):
            ctx.new_path()
            ctx.set_source_rgba(COL_AMBER_BRIGHT[0], COL_AMBER_BRIGHT[1], COL_AMBER_BRIGHT[2], 0.80 - idx * 0.22)
            ctx.move_to(cx - r * 0.56 + idx * r * 0.12, cy + r * dy)
            ctx.line_to(cx + r * 0.56 - idx * r * 0.08, cy + r * dy)
            ctx.stroke()
    elif code in (71, 73, 75, 77, 85, 86):
        _draw_cloud_shape(ctx, cx, cy - r * 0.18, r * 0.88, COL_WHITE, 0.92)
        ctx.set_source_rgb(*COL_SKY)
        for ox, oy in ((-0.36, 0.44), (0.0, 0.56), (0.36, 0.42)):
            ctx.new_path()
            ctx.arc(cx + r * ox, cy + r * oy, max(2.0, r * 0.10), 0.0, math.pi * 2.0)
            ctx.fill()
    elif code >= 95:
        _draw_cloud_shape(ctx, cx, cy - r * 0.20, r * 0.88, COL_SLATE, 0.95)
        ctx.set_source_rgb(*COL_AMBER_BRIGHT)
        _cairo_lightning_bolt(ctx, cx - r * 0.22, cy + r * 0.12, r * 0.68)
    else:
        # Rain / drizzle / showers
        _draw_cloud_shape(ctx, cx, cy - r * 0.20, r * 0.88, COL_WHITE, 0.92)
        ctx.set_source_rgb(*COL_SKY)
        ctx.set_line_cap(cairo.LINE_CAP_ROUND)
        ctx.set_line_width(max(2.0, r * 0.10))
        for ox in (-0.34, 0.0, 0.34):
            rx0 = cx + r * ox
            ry0 = cy + r * 0.30
            ctx.new_path()
            ctx.move_to(rx0, ry0)
            ctx.line_to(rx0 - r * 0.12, ry0 + r * 0.30)
            ctx.stroke()


def _draw_progress_bar(
    ctx,
    x: float,
    y: float,
    w: float,
    h: float,
    ratio: float,
    fill_col: Tuple[float, float, float],
    track_col: Tuple[float, float, float] = COL_AMBER_DARK_LINE,
) -> None:
    rad = h * 0.5
    _cairo_rounded_rect(ctx, x, y, w, h, rad)
    ctx.set_source_rgba(track_col[0], track_col[1], track_col[2], 0.26)
    ctx.fill_preserve()
    ctx.set_source_rgba(track_col[0], track_col[1], track_col[2], 0.65)
    ctx.set_line_width(1.0)
    ctx.stroke()
    r = clamp(float(ratio), 0.0, 1.0)
    if r > 0.02:
        _cairo_rounded_rect(ctx, x, y, max(h, w * r), h, rad)
        ctx.set_source_rgb(*fill_col)
        ctx.fill()


def _draw_segmented_bar_cairo(
    ctx,
    x: float,
    y: float,
    w: float,
    h: float,
    ratio: float,
    fill_col: Tuple[float, float, float],
    segments: int = 16,
) -> None:
    count = max(4, int(segments))
    gap = 3.5 if count <= 14 else 3.0
    seg_w = max(3.0, (w - gap * (count - 1)) / float(count))
    lit = int(round(clamp(float(ratio), 0.0, 1.0) * count))
    rad = min(2.5, h * 0.35, seg_w * 0.35)
    for idx in range(count):
        sx = x + idx * (seg_w + gap)
        _cairo_rounded_rect(ctx, sx, y, seg_w, h, rad)
        if idx < lit:
            ctx.set_source_rgb(*fill_col)
        else:
            ctx.set_source_rgba(COL_SLATE[0], COL_SLATE[1], COL_SLATE[2], 0.22)
        ctx.fill()


def _draw_scooter_silhouette_cairo(
    ctx,
    cx: float,
    cy: float,
    box_w: float,
    box_h: float,
    col: Tuple[float, float, float],
) -> None:
    scale = min(box_w / 140.0, box_h / 82.0)
    ox = cx - 70.0 * scale
    oy = cy - 41.0 * scale
    px = lambda vx: ox + vx * scale
    py = lambda vy: oy + vy * scale

    ctx.set_source_rgba(0.0, 0.0, 0.0, 0.55)
    ctx.save()
    ctx.translate(cx, py(72.0))
    ctx.scale(46.0 * scale, 5.0 * scale)
    ctx.new_path()
    ctx.arc(0.0, 0.0, 1.0, 0.0, math.pi * 2.0)
    ctx.fill()
    ctx.restore()

    for wx in (34.0, 108.0):
        ctx.new_path()
        ctx.arc(px(wx), py(60.0), 12.0 * scale, 0.0, math.pi * 2.0)
        ctx.set_source_rgb(0.14, 0.18, 0.24)
        ctx.fill_preserve()
        ctx.set_source_rgb(*COL_SLATE)
        ctx.set_line_width(max(1.8, 2.5 * scale))
        ctx.stroke()

        ctx.new_path()
        ctx.arc(px(wx), py(60.0), 5.2 * scale, 0.0, math.pi * 2.0)
        ctx.set_source_rgb(*col)
        ctx.set_line_width(max(1.2, 1.6 * scale))
        ctx.stroke()

    pts = (
        (36.0, 56.0),
        (52.0, 58.0),
        (86.0, 58.0),
        (104.0, 44.0),
        (114.0, 38.0),
        (104.0, 30.0),
        (78.0, 32.0),
        (68.0, 46.0),
        (50.0, 46.0),
        (44.0, 26.0),
        (35.0, 23.0),
        (30.0, 31.0),
        (38.0, 51.0),
    )
    ctx.new_path()
    ctx.move_to(px(pts[0][0]), py(pts[0][1]))
    for vx, vy in pts[1:]:
        ctx.line_to(px(vx), py(vy))
    ctx.close_path()
    ctx.set_source_rgba(col[0], col[1], col[2], 0.16)
    ctx.fill_preserve()
    ctx.set_source_rgb(*COL_WHITE)
    ctx.set_line_width(max(1.4, 1.8 * scale))
    ctx.stroke()

    ctx.set_source_rgb(*col)
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.set_line_width(max(1.8, 2.2 * scale))
    ctx.new_path()
    ctx.move_to(px(36.0), py(22.0))
    ctx.line_to(px(42.0), py(12.0))
    ctx.line_to(px(51.0), py(11.0))
    ctx.stroke()


def _draw_pill(
    ctx,
    x: float,
    y: float,
    h: float,
    text: str,
    col: Tuple[float, float, float],
    *,
    font_size: float = 13.5,
    pad_x: float = 10.0,
    bold: bool = True,
    font_family: str = "Noto Sans CJK SC",
    text_col: Optional[Tuple[float, float, float]] = None,
) -> float:
    weight = cairo.FONT_WEIGHT_BOLD if bold else cairo.FONT_WEIGHT_NORMAL
    ctx.select_font_face(font_family, cairo.FONT_SLANT_NORMAL, weight)
    ctx.set_font_size(font_size)
    tw = ctx.text_extents(text).x_advance
    pw = tw + pad_x * 2.0
    _cairo_rounded_rect(ctx, x, y, pw, h, h * 0.5)
    ctx.set_source_rgba(col[0], col[1], col[2], 0.14)
    ctx.fill_preserve()
    ctx.set_source_rgba(col[0], col[1], col[2], 0.78)
    ctx.set_line_width(1.2)
    ctx.stroke()
    ctx.set_source_rgb(*(text_col or col))
    ctx.move_to(x + pad_x, y + h * 0.71)
    ctx.show_text(text)
    return pw


def _cairo_bar_chart(
    ctx,
    x: float,
    y: float,
    w: float,
    h: float,
    values: Sequence[int],
    active_col: Tuple[float, float, float] = COL_EMERALD,
    goal: int = 2,
    font_family: str = "Noto Sans CJK SC",
) -> None:
    vals = [max(0, int(v)) for v in list(values)[-7:]]
    if not vals:
        vals = [0] * 7
    n = len(vals)
    max_v = max(max(1, int(goal)), max(vals))
    label_h = 15.0 if h >= 58.0 else 0.0
    chart_h = max(20.0, h - label_h - 4.0)
    base_y = y + chart_h

    # Subtle baseline & daily goal guide line
    ctx.new_path()
    ctx.move_to(x, base_y)
    ctx.line_to(x + w, base_y)
    ctx.set_source_rgb(*COL_AMBER_DARK_LINE)
    ctx.set_line_width(1.0)
    ctx.stroke()

    gap = min(10.0, max(4.0, w * 0.04))
    bar_w = max(6.0, (w - gap * (n - 1)) / float(n))
    for idx, val in enumerate(vals):
        bx = x + idx * (bar_w + gap)
        is_today = idx == n - 1
        if val <= 0:
            bh = 4.0
            b_col = COL_AMBER_DARK_LINE
        else:
            bh = max(6.0, (val / float(max_v)) * (chart_h - 4.0))
            b_col = active_col if val >= goal else COL_AMBER_BRIGHT
        by = base_y - bh
        _cairo_rounded_rect(ctx, bx, by, bar_w, bh, min(4.0, bar_w * 0.35))
        ctx.set_source_rgb(*b_col)
        ctx.fill()
        if is_today:
            ctx.new_path()
            ctx.arc(bx + bar_w * 0.5, max(y + 2.0, by - 4.0), 2.2, 0.0, math.pi * 2.0)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.fill()

    if label_h > 0.0:
        ctx.select_font_face(font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        ctx.set_font_size(11.0)
        ctx.set_source_rgb(*COL_AMBER)
        ctx.move_to(x, y + h - 2.0)
        ctx.show_text(f"前{n}天")
        today_lbl = "今日"
        tw = ctx.text_extents(today_lbl).x_advance
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + w - tw, y + h - 2.0)
        ctx.show_text(today_lbl)


def _cairo_rounded_rect(ctx, x: float, y: float, w: float, h: float, r: float) -> None:
    r = min(r, max(0.0, w * 0.5), max(0.0, h * 0.5))
    ctx.new_sub_path()
    ctx.arc(x + w - r, y + r, r, -math.pi * 0.5, 0.0)
    ctx.arc(x + w - r, y + h - r, r, 0.0, math.pi * 0.5)
    ctx.arc(x + r, y + h - r, r, math.pi * 0.5, math.pi)
    ctx.arc(x + r, y + r, r, math.pi, math.pi * 1.5)
    ctx.close_path()


def _fit_single_line_cairo(ctx, text: str, max_width: float) -> str:
    clean = " ".join(_sanitize_hud_text(text or "").replace("\r", "\n").split())
    if not clean:
        return ""
    if ctx.text_extents(clean).x_advance <= max_width:
        return clean
    out = clean
    while len(out) > 1 and ctx.text_extents(out + "…").x_advance > max_width:
        out = out[:-1]
    return out + "…"


def _wrap_text_cairo(ctx, text: str, max_width: float, max_lines: int) -> List[str]:
    clean = " ".join(_sanitize_hud_text(text or "").replace("\r", "\n").split())
    if not clean or max_lines <= 0:
        return []
    lines: List[str] = []
    cur = ""
    truncated = False
    for ch in clean:
        candidate = cur + ch
        if ctx.text_extents(candidate).x_advance <= max_width or not cur:
            cur = candidate
        else:
            lines.append(cur.rstrip())
            if len(lines) >= max_lines:
                truncated = True
                cur = ""
                break
            cur = ch.lstrip()
    if cur and len(lines) < max_lines:
        lines.append(cur.rstrip())
    elif cur:
        truncated = True

    if truncated and lines:
        last = lines[-1]
        while last and ctx.text_extents(last + "…").x_advance > max_width:
            last = last[:-1]
        lines[-1] = last + "…"
    return lines


def _smooth_polyline(
    pts: Sequence[Tuple[float, float]],
    y_top: float,
    y_bot: float,
    steps: int = 4,
) -> List[Tuple[float, float]]:
    n = len(pts)
    if n <= 2:
        return list(pts)
    out: List[Tuple[float, float]] = [pts[0]]
    for i in range(n - 1):
        p0 = pts[max(0, i - 1)]
        p1 = pts[i]
        p2 = pts[i + 1]
        p3 = pts[min(n - 1, i + 2)]
        for s in range(1, steps + 1):
            t = s / float(steps)
            t2 = t * t
            t3 = t2 * t
            px = p1[0] + (p2[0] - p1[0]) * t
            py = 0.5 * (
                (2.0 * p1[1])
                + (-p0[1] + p2[1]) * t
                + (2.0 * p0[1] - 5.0 * p1[1] + 4.0 * p2[1] - p3[1]) * t2
                + (-p0[1] + 3.0 * p1[1] - 3.0 * p2[1] + p3[1]) * t3
            )
            out.append((px, clamp(py, y_top, y_bot)))
    return out


def _draw_sparkline_cairo(
    ctx,
    x: float,
    y: float,
    w: float,
    h: float,
    values: Sequence[float],
    col: Tuple[float, float, float],
) -> None:
    vals = [float(v) for v in values]
    base_y = y + h - 2.0
    if len(vals) < 2:
        ctx.new_path()
        ctx.move_to(x, y + h * 0.55)
        ctx.line_to(x + w, y + h * 0.55)
        ctx.set_source_rgb(*COL_AMBER_DARK_LINE)
        ctx.set_line_width(1.5)
        ctx.stroke()
        return

    lo = min(vals)
    hi = max(vals)
    flat = (hi - lo) < 1e-6
    span = max(1e-6, hi - lo)
    y_top = y + 3.0
    y_bot = base_y - 3.0
    usable_h = max(6.0, y_bot - y_top)
    pts: List[Tuple[float, float]] = []
    for idx, v in enumerate(vals):
        px = x + (idx / float(len(vals) - 1)) * w
        norm = 0.5 if flat else (v - lo) / span
        py = y_bot - norm * usable_h
        pts.append((px, py))

    smooth = _smooth_polyline(pts, y_top, y_bot)

    # Subtle baseline
    ctx.new_path()
    ctx.move_to(x, base_y)
    ctx.line_to(x + w, base_y)
    ctx.set_source_rgba(col[0], col[1], col[2], 0.24)
    ctx.set_line_width(1.0)
    ctx.stroke()

    # Vertical LinearGradient area fill under smooth curve
    ctx.save()
    ctx.new_path()
    ctx.move_to(smooth[0][0], base_y)
    for px, py in smooth:
        ctx.line_to(px, py)
    ctx.line_to(smooth[-1][0], base_y)
    ctx.close_path()
    grad = cairo.LinearGradient(0.0, y_top, 0.0, base_y)
    grad.add_color_stop_rgba(0.0, col[0], col[1], col[2], 0.30)
    grad.add_color_stop_rgba(1.0, col[0], col[1], col[2], 0.02)
    ctx.set_source(grad)
    ctx.fill()
    ctx.restore()

    # Crisp smooth line
    ctx.new_path()
    ctx.move_to(smooth[0][0], smooth[0][1])
    for px, py in smooth[1:]:
        ctx.line_to(px, py)
    ctx.set_source_rgb(*col)
    ctx.set_line_width(2.4)
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.set_line_join(cairo.LINE_JOIN_ROUND)
    ctx.stroke()

    # Glowing end dot
    lx, ly = pts[-1]
    ctx.new_path()
    ctx.arc(lx, ly, 6.2, 0.0, math.pi * 2.0)
    ctx.set_source_rgba(col[0], col[1], col[2], 0.30)
    ctx.fill()
    ctx.new_path()
    ctx.arc(lx, ly, 3.8, 0.0, math.pi * 2.0)
    ctx.set_source_rgb(*col)
    ctx.fill()
    ctx.new_path()
    ctx.arc(lx, ly, 2.0, 0.0, math.pi * 2.0)
    ctx.set_source_rgb(*COL_WHITE)
    ctx.fill()


class FaceRenderer:
    """Renders 800x1280 frames to BGR565 & PNG with 3-layer offscreen surface caching."""

    def __init__(self, font_family: str = "Noto Sans CJK SC") -> None:
        self.font_family = font_family
        self.fast = _Fast565Lib()
        self.marquee = MarqueeController()

        self._bgra = bytearray(WIDTH * HEIGHT * 4)
        self._curr565 = bytearray(FRAME_BYTES)
        self._prev565 = bytearray(FRAME_BYTES)
        self._tiles_buf = bytearray(MAX_PATCH_TILES * TILE_MSG_BYTES)
        self._has_prev = False
        self._last_composite_rows: int = 0
        self._surface = None

        # 3-Layer Cairo offscreen caches
        self._stage_surface = None
        self._stage_key: Optional[Any] = None
        self._marquee_text_surface = None
        self._marquee_key: Optional[Any] = None
        self._bento_surface = None
        self._bento_key: Optional[Any] = None
        self._measure_ctx = None
        self._ninebot_img_cache: Dict[str, Tuple[int, Any]] = {}

        if cairo is not None:
            self._surface = cairo.ImageSurface.create_for_data(
                self._bgra, cairo.FORMAT_ARGB32, WIDTH, HEIGHT, WIDTH * 4
            )
            self._measure_ctx = cairo.Context(cairo.ImageSurface(cairo.FORMAT_ARGB32, 16, 16))

    @property
    def uses_cairo(self) -> bool:
        return self._surface is not None

    def invalidate_prev(self) -> None:
        self._has_prev = False
        self._last_composite_rows = 0
        self._stage_key = None
        self._bento_key = None

    def sync_marquee_metrics(self, hud: HudState) -> None:
        """Compute exact text width via Cairo (or char heuristic) so MarqueeController stays accurate."""
        clean_src = _localize_headline_source(hud.headline_source or "主脑")
        clean_txt = _clean_marquee_text(hud.headline_text or "")
        if self._measure_ctx is not None:
            mctx = self._measure_ctx
            mctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            mctx.set_font_size(16.0)
            pill_w = max(72.0, mctx.text_extents(clean_src).x_advance + 22.0)
            viewport_w = 728.0 - 30.0 - pill_w - 22.0
            mctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            mctx.set_font_size(22.0)
            text_w = mctx.text_extents(clean_txt).x_advance if clean_txt else 0.0
        else:
            pill_w = max(72.0, len(clean_src) * 11.0 + 22.0)
            viewport_w = 728.0 - 30.0 - pill_w - 22.0
            text_w = sum(22.0 if ord(ch) > 127 else 12.5 for ch in clean_txt)
        self.marquee.set_content(
            clean_txt,
            text_w,
            viewport_w,
            mode=hud.marquee_mode,
            speed_level=hud.marquee_speed,
        )

    def render_frame(
        self,
        face: FaceSnapshot,
        hud: HudState,
        *,
        placed_cards: Sequence[PlacedCard] = (),
        widget_data: Optional[Dict[str, Dict[str, Any]]] = None,
    ) -> Tuple[bytes, Optional[Tuple[int, bytes]]]:
        """Render frame and return (full_bgr565_bytes, optional (dirty_count, patch_payload_without_type))."""
        self.sync_marquee_metrics(hud)
        dirty_band: Optional[Tuple[int, int]] = None
        if self._surface is not None:
            dirty_band = self._render_cairo(face, hud, placed_cards=placed_cards, widget_data=widget_data or {})
        else:
            self._render_fallback_bgra(face, hud, placed_cards=placed_cards)

        if dirty_band is not None and self._has_prev:
            by0, by1 = dirty_band
            self.fast.bgra_band_to_bgr565(self._bgra, self._curr565, by0, by1)
            dirty = self.fast.diff_tiles_band(self._prev565, self._curr565, self._tiles_buf, by0, by1, MAX_PATCH_TILES)
            if dirty == 0:
                patch_info: Optional[Tuple[int, bytes]] = (0, b"")
            elif dirty <= MAX_PATCH_TILES:
                payload = struct.pack("<I", dirty) + bytes(self._tiles_buf[: dirty * TILE_MSG_BYTES])
                patch_info = (dirty, payload)
            else:
                patch_info = None
            off0 = by0 * WIDTH * 2
            off1 = by1 * WIDTH * 2
            self._prev565[off0:off1] = self._curr565[off0:off1]
        else:
            self.fast.bgra_to_bgr565(self._bgra, self._curr565)
            patch_info = None
            if self._has_prev:
                dirty = self.fast.diff_tiles(self._prev565, self._curr565, self._tiles_buf, MAX_PATCH_TILES)
                if dirty == 0:
                    patch_info = (0, b"")
                elif dirty <= MAX_PATCH_TILES:
                    payload = struct.pack("<I", dirty) + bytes(self._tiles_buf[: dirty * TILE_MSG_BYTES])
                    patch_info = (dirty, payload)
                else:
                    patch_info = None
            self._prev565[:] = self._curr565
        self._has_prev = True
        return bytes(self._curr565), patch_info

    def current_png_bytes(self) -> bytes:
        if self._surface is not None:
            import io

            buf = io.BytesIO()
            self._surface.write_to_png(buf)
            return buf.getvalue()
        rgb = bytearray(WIDTH * HEIGHT * 3)
        self.fast.bgr565_to_rgb24(self._curr565, rgb)
        return _encode_png_rgb24(WIDTH, HEIGHT, rgb)

    # ---- Layer 1 + Layer 2 + Layer 3 Compositor (Cairo) ----
    def _render_cairo(
        self,
        face: FaceSnapshot,
        hud: HudState,
        *,
        placed_cards: Sequence[PlacedCard],
        widget_data: Dict[str, Dict[str, Any]],
    ) -> Optional[Tuple[int, int]]:
        geo = stage_geometry_for_rows(hud.grid_rows)
        marquee_y = int(geo["marquee_y"])
        marquee_h = int(geo["marquee_h"])
        grid_y = int(geo["grid_y"])
        clock_str = hud.clock_hm or time.strftime("%H:%M")
        stage_redrawn = False
        bento_redrawn = False

        # Layer 1: Top Header + Face Stage (0 .. marquee_y)
        stage_h = marquee_y
        if self._stage_surface is None or self._stage_surface.get_height() != stage_h:
            self._stage_surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, WIDTH, stage_h)
            self._stage_key = None

        stage_key = (
            "static",
            hud.grid_rows,
            face.state_id,
            face.sub_phase,
            face.expr,
            face.worker_count,
            clock_str,
            hud.friday_connected,
            hud.voice_caption,
            hud.scene_channel,
            hud.scene_caption,
            round(face.pose.normal_z, 3),
        )
        if (not face.settled) or (self._stage_key != stage_key):
            sctx = cairo.Context(self._stage_surface)
            sctx.set_antialias(cairo.ANTIALIAS_BEST)
            sctx.set_source_rgb(*COL_BG)
            sctx.paint()
            self._draw_header_cairo(sctx, face, hud, clock_str)
            self._draw_stage_cairo(sctx, face, hud, geo)
            self._stage_key = stage_key if face.settled else None
            stage_redrawn = True

        # Layer 3: Bento Cards / Task Overlay + Page Dots + Footer (grid_y .. HEIGHT)
        bento_h = HEIGHT - grid_y
        if self._bento_surface is None or self._bento_surface.get_height() != bento_h:
            self._bento_surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, WIDTH, bento_h)
            self._bento_key = None

        bento_key = (
            hud.grid_rows,
            hud.layout_rev,
            hud.data_rev,
            hud.active_page,
            hud.page_count,
            hud.page_name,
            hud.auto_task_overlay,
            hud.ask_boss_question,
            hud.workers,
            hud.channels,
            hud.memory_count,
            hud.today_calls,
            hud.speaker_volume,
            hud.speaker_muted,
            tuple((c.card_id, c.kind, c.effective_size) for c in placed_cards),
        )
        if self._bento_key != bento_key:
            bctx = cairo.Context(self._bento_surface)
            bctx.set_antialias(cairo.ANTIALIAS_BEST)
            bctx.set_source_rgb(*COL_BG)
            bctx.paint()
            bctx.save()
            bctx.translate(0.0, -float(grid_y))
            self._draw_bottom_region_cairo(bctx, hud, placed_cards, widget_data, geo)
            self._draw_footer_cairo(bctx, hud)
            bctx.restore()
            self._bento_key = bento_key
            bento_redrawn = True

        # Composite onto main 800x1280 surface (marquee-only band update when Stage & Bento hit cache!)
        ctx = cairo.Context(self._surface)
        ctx.set_antialias(cairo.ANTIALIAS_BEST)
        rows_norm = 3 if int(hud.grid_rows) == 3 else 2
        if self._has_prev and self._last_composite_rows == rows_norm and (not stage_redrawn) and (not bento_redrawn):
            band_y0 = max(0, ((marquee_y - 2) // TILE_H) * TILE_H)
            band_y1 = min(HEIGHT, (((marquee_y + marquee_h + 2) + TILE_H - 1) // TILE_H) * TILE_H)
            ctx.save()
            ctx.new_path()
            ctx.rectangle(0.0, float(band_y0), float(WIDTH), float(band_y1 - band_y0))
            ctx.clip()
            ctx.set_source_rgb(*COL_BG)
            ctx.paint()
            if band_y0 < marquee_y:
                ctx.set_source_surface(self._stage_surface, 0.0, 0.0)
                ctx.paint()
            self._draw_marquee_cairo(ctx, face, hud, geo)
            if band_y1 > grid_y:
                ctx.set_source_surface(self._bento_surface, 0.0, float(grid_y))
                ctx.paint()
            ctx.restore()
            self._surface.flush()
            return (band_y0, band_y1)

        ctx.set_source_rgb(*COL_BG)
        ctx.paint()
        ctx.set_source_surface(self._stage_surface, 0.0, 0.0)
        ctx.paint()
        self._draw_marquee_cairo(ctx, face, hud, geo)
        ctx.set_source_surface(self._bento_surface, 0.0, float(grid_y))
        ctx.paint()
        self._last_composite_rows = rows_norm
        self._surface.flush()
        return None

    def _draw_header_cairo(self, ctx, face: FaceSnapshot, hud: HudState, clock_str: str) -> None:
        badge_text, badge_col = STATE_BADGES.get(face.state_id, ("准备就绪", COL_AMBER))
        if face.state_id == "sleeping" and face.sub_phase == "rem":
            badge_text = "梦境整理"
            badge_col = COL_AMBER_BRIGHT
        elif face.state_id == "listening" and "连续" in hud.voice_caption:
            badge_text = "连续对话"
            badge_col = COL_EMERALD
        elif face.state_id == "working" and face.worker_count > 0:
            badge_text = f"协同执行 · {face.worker_count}项"
        elif face.state_id == "sending_msg" and hud.scene_channel == "telegram":
            badge_col = COL_SKY

        dot_col = COL_EMERALD if hud.friday_connected else COL_RED
        ctx.new_path()
        ctx.set_source_rgba(dot_col[0], dot_col[1], dot_col[2], 0.24)
        ctx.arc(44.0, 50.0, 11.5, 0.0, math.pi * 2.0)
        ctx.fill()
        ctx.new_path()
        ctx.set_source_rgb(*dot_col)
        ctx.arc(44.0, 50.0, 6.5, 0.0, math.pi * 2.0)
        ctx.fill()

        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(25.0)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(62.0, 59.0)
        ctx.show_text("F.R.I.D.A.Y.")

        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(17.5)
        tw = ctx.text_extents(badge_text).x_advance
        pill_x = 224.0
        pill_y = 32.0
        pill_w = max(112.0, tw + 30.0)
        pill_h = 35.0
        _cairo_rounded_rect(ctx, pill_x, pill_y, pill_w, pill_h, 17.5)
        ctx.set_source_rgba(badge_col[0], badge_col[1], badge_col[2], 0.12)
        ctx.fill_preserve()
        ctx.set_source_rgb(*badge_col)
        ctx.set_line_width(1.8)
        ctx.stroke()
        ctx.move_to(pill_x + (pill_w - tw) * 0.5, pill_y + 23.5)
        ctx.show_text(badge_text)

        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(31.0)
        ext = ctx.text_extents(clock_str)
        ctx.set_source_rgb(*COL_AMBER_BRIGHT)
        ctx.move_to(764.0 - ext.x_advance, 60.0)
        ctx.show_text(clock_str)

    def _compute_satellites(self, face: FaceSnapshot, cx: float, cy: float, r: float) -> List[Tuple[float, float, float, float]]:
        sats: List[Tuple[float, float, float, float]] = []
        scale = r / 192.0
        if face.morph == "orbit":
            rx_a = 285.0 * scale * face.morph_progress
            ry_a = 92.0 * scale * face.morph_progress
            tilt = -0.36
            ct, st = math.cos(tilt), math.sin(tilt)
            for idx in range(2):
                a = face.clock * 2.4 + idx * math.pi
                ex = rx_a * math.cos(a)
                ey = ry_a * math.sin(a)
                z = math.sin(a)
                sats.append((cx + ex * ct - ey * st, cy + ex * st + ey * ct, z, (14.0 + z * 4.0) * scale))
        elif face.worker_count > 0:
            count = min(5, face.worker_count)
            rx_a = 278.0 * scale
            ry_a = 86.0 * scale
            tilt = 0.24
            ct, st = math.cos(tilt), math.sin(tilt)
            for idx in range(count):
                a = face.clock * 1.9 + (idx * 2.0 * math.pi) / count
                ex = rx_a * math.cos(a)
                ey = ry_a * math.sin(a)
                z = math.sin(a)
                sats.append((cx + ex * ct - ey * st, cy + ex * st + ey * ct, z, (11.5 + z * 3.0) * scale))
        return sats

    def _draw_orbit_ring(self, ctx, cx: float, cy: float, rx_a: float, ry_a: float, tilt: float, alpha: float) -> None:
        ct, st = math.cos(tilt), math.sin(tilt)
        ctx.new_path()
        steps = 48
        for i in range(steps + 1):
            a = (i / steps) * math.pi * 2.0
            ex = rx_a * math.cos(a)
            ey = ry_a * math.sin(a)
            px = cx + ex * ct - ey * st
            py = cy + ex * st + ey * ct
            if i == 0:
                ctx.move_to(px, py)
            else:
                ctx.line_to(px, py)
        ctx.close_path()
        ctx.set_source_rgba(COL_AMBER[0], COL_AMBER[1], COL_AMBER[2], alpha)
        ctx.set_line_width(2.5)
        ctx.stroke()

    def _draw_paper_plane_cairo(
        self,
        ctx,
        x: float,
        y: float,
        angle: float,
        size: float,
        col: Tuple[float, float, float],
    ) -> None:
        ca = math.cos(angle)
        sa = math.sin(angle)

        def pt(lx: float, ly: float) -> Tuple[float, float]:
            return (x + lx * ca - ly * sa, y + lx * sa + ly * ca)

        nose = pt(size * 1.15, 0.0)
        top_wing = pt(-size * 0.85, -size * 0.68)
        fold = pt(-size * 0.42, 0.0)
        bot_wing = pt(-size * 0.85, size * 0.68)

        ctx.new_path()
        ctx.move_to(*nose)
        ctx.line_to(*top_wing)
        ctx.line_to(*fold)
        ctx.line_to(*bot_wing)
        ctx.close_path()
        ctx.set_source_rgba(col[0], col[1], col[2], 0.24)
        ctx.fill_preserve()
        ctx.set_source_rgb(*col)
        ctx.set_line_width(3.0)
        ctx.set_line_join(cairo.LINE_JOIN_ROUND)
        ctx.stroke()

        ctx.new_path()
        ctx.move_to(*fold)
        ctx.line_to(*nose)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.set_line_width(2.2)
        ctx.set_line_cap(cairo.LINE_CAP_ROUND)
        ctx.stroke()

    def _draw_scene_effects_cairo(
        self,
        ctx,
        face: FaceSnapshot,
        hud: HudState,
        cx: float,
        cy: float,
        cur_cx: float,
        cur_cy: float,
        fr: float,
        s: float,
    ) -> None:
        key = face.state_id
        clock = face.clock

        if key == "speaking":
            ctx.set_line_cap(cairo.LINE_CAP_ROUND)
            for i in range(3):
                cyc = (clock * 0.85 + i * 0.333) % 1.0
                r = fr * (1.16 + cyc * 0.44)
                op = (1.0 - cyc) * 0.82
                col = COL_AMBER_BRIGHT if i % 2 == 0 else COL_EMERALD
                ctx.set_source_rgba(col[0], col[1], col[2], op)
                ctx.set_line_width(max(1.6, 3.4 - cyc * 1.2))
                ctx.new_path()
                ctx.arc(cur_cx, cur_cy, r, math.pi * 0.76, math.pi * 1.24)
                ctx.stroke()
                ctx.new_path()
                ctx.arc(cur_cx, cur_cy, r, -math.pi * 0.24, math.pi * 0.24)
                ctx.stroke()

            base_y = cy + fr * 1.12
            for i in range(9):
                center_dist = abs(i - 4) / 4.0
                env = 1.0 - center_dist * 0.55
                v = 0.28 + 0.72 * abs(math.sin(clock * 8.4 + i * 0.65)) * abs(math.cos(clock * 3.1 - i * 0.4))
                bh = (9.0 + 25.0 * env * v) * s
                bx = cur_cx + (i - 4) * 18.0 * s
                bw = max(5.0, 8.0 * s)
                ctx.set_source_rgb(*(COL_AMBER_BRIGHT if i % 2 == 0 else COL_WHITE))
                _cairo_rounded_rect(ctx, bx - bw * 0.5, base_y - bh * 0.5, bw, bh, bw * 0.5)
                ctx.fill()
            return

        if key == "sending_msg":
            accent = COL_SKY if hud.scene_channel == "telegram" else COL_EMERALD
            cyc = (clock * 0.55) % 1.0
            p0 = (cur_cx + fr * 0.78, cur_cy + fr * 0.10)
            p1 = (cur_cx + fr * 1.05, cur_cy - fr * 0.45)
            p2 = (cx + 235.0 * s, max(110.0, cy - 154.0 * s))
            p3 = (cx + 322.0 * s, max(96.0, cy - 222.0 * s))

            def bez(t: float) -> Tuple[float, float]:
                u = 1.0 - t
                u2 = u * u
                t2 = t * t
                return (
                    u2 * u * p0[0] + 3.0 * u2 * t * p1[0] + 3.0 * u * t2 * p2[0] + t2 * t * p3[0],
                    u2 * u * p0[1] + 3.0 * u2 * t * p1[1] + 3.0 * u * t2 * p2[1] + t2 * t * p3[1],
                )

            if cyc < 0.45:
                u = cyc / 0.45
                ctx.new_path()
                ctx.arc(p0[0], p0[1], (10.0 + u * 34.0) * s, 0.0, math.pi * 2.0)
                ctx.set_source_rgba(accent[0], accent[1], accent[2], (1.0 - u) * 0.70)
                ctx.set_line_width(2.5)
                ctx.stroke()

            fly_u = min(1.0, cyc / 0.78)
            for d in range(1, 8):
                dt = fly_u - d * 0.055
                if dt <= 0.0:
                    continue
                tx, ty = bez(dt)
                alpha = (1.0 - d / 8.0) * (max(0.0, 1.0 - (cyc - 0.78) / 0.22) if cyc > 0.78 else 0.85)
                dot_col = COL_AMBER_BRIGHT if d % 2 == 0 else accent
                ctx.new_path()
                ctx.arc(tx, ty, max(1.4, (4.6 - d * 0.45) * s), 0.0, math.pi * 2.0)
                ctx.set_source_rgba(dot_col[0], dot_col[1], dot_col[2], alpha)
                ctx.fill()

            if cyc <= 0.82:
                px, py = bez(fly_u)
                nx, ny = bez(min(1.0, fly_u + 0.02))
                ang = math.atan2(ny - py, nx - px)
                scale_plane = 1.0 - fly_u * 0.18
                self._draw_paper_plane_cairo(ctx, px, py, ang, 24.0 * scale_plane * s, accent)
            else:
                u = (cyc - 0.82) / 0.18
                op = math.sin(u * math.pi)
                ctx.new_path()
                ctx.arc(p3[0], p3[1], (18.0 + u * 22.0) * s, 0.0, math.pi * 2.0)
                ctx.set_source_rgba(accent[0], accent[1], accent[2], op * 0.85)
                ctx.set_line_width(2.6)
                ctx.stroke()

                ctx.set_source_rgba(COL_AMBER_BRIGHT[0], COL_AMBER_BRIGHT[1], COL_AMBER_BRIGHT[2], op)
                _cairo_four_star(ctx, p3[0] - 24.0 * s, p3[1] - 18.0 * s, 8.0 * s)
                _cairo_four_star(ctx, p3[0] + 22.0 * s, p3[1] + 16.0 * s, 6.0 * s)

                ctx.new_path()
                ctx.move_to(p3[0] - 11.0 * s, p3[1] + 1.0 * s)
                ctx.line_to(p3[0] - 3.0 * s, p3[1] + 10.0 * s)
                ctx.line_to(p3[0] + 13.0 * s, p3[1] - 9.0 * s)
                ctx.set_source_rgba(1.0, 1.0, 1.0, op)
                ctx.set_line_width(max(2.5, 4.0 * s))
                ctx.set_line_cap(cairo.LINE_CAP_ROUND)
                ctx.set_line_join(cairo.LINE_CAP_ROUND)
                ctx.stroke()
            return

        if key == "printing":
            dx = cx + 232.0 * s
            dy = cy - 12.0 * s
            pw = 166.0 * s
            ph = 92.0 * s

            pulse = (clock * 1.8) % 1.0
            for i in range(3):
                u = (pulse + i * 0.33) % 1.0
                lx = cur_cx + fr * 0.55 + ((dx - pw * 0.58) - (cur_cx + fr * 0.55)) * u
                ly = (cur_cy - 12.0 * s) + ((dy - 10.0 * s) - (cur_cy - 12.0 * s)) * u
                ctx.new_path()
                ctx.arc(lx, ly, max(2.2, 4.0 * s), 0.0, math.pi * 2.0)
                ctx.set_source_rgba(COL_AMBER_BRIGHT[0], COL_AMBER_BRIGHT[1], COL_AMBER_BRIGHT[2], math.sin(u * math.pi) * 0.85)
                ctx.fill()

            _cairo_rounded_rect(ctx, dx - 44.0 * s, dy - ph * 0.5 - 38.0 * s, 88.0 * s, 42.0 * s, 6.0 * s)
            ctx.set_source_rgba(COL_AMBER[0], COL_AMBER[1], COL_AMBER[2], 0.16)
            ctx.fill_preserve()
            ctx.set_source_rgb(*COL_AMBER_DIM)
            ctx.set_line_width(2.2)
            ctx.stroke()

            _cairo_rounded_rect(ctx, dx - pw * 0.5, dy - ph * 0.5, pw, ph, 16.0 * s)
            ctx.set_source_rgb(0x0F / 255.0, 0x09 / 255.0, 0x02 / 255.0)
            ctx.fill_preserve()
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.set_line_width(2.6)
            ctx.stroke()

            _cairo_rounded_rect(ctx, dx - pw * 0.40, dy - ph * 0.34, pw * 0.80, 14.0 * s, 4.0 * s)
            ctx.set_source_rgba(COL_AMBER[0], COL_AMBER[1], COL_AMBER[2], 0.25)
            ctx.fill()

            led_alpha = 0.4 + 0.6 * abs(math.sin(clock * 6.0))
            ctx.new_path()
            ctx.arc(dx + pw * 0.36, dy - ph * 0.27, max(2.8, 5.0 * s), 0.0, math.pi * 2.0)
            ctx.set_source_rgba(COL_EMERALD[0], COL_EMERALD[1], COL_EMERALD[2], led_alpha)
            ctx.fill()

            head_x = dx + math.sin(clock * 5.2) * (pw * 0.28)
            _cairo_rounded_rect(ctx, head_x - 13.0 * s, dy - 10.0 * s, 26.0 * s, 8.0 * s, 4.0 * s)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.fill()
            ctx.new_path()
            ctx.arc(head_x, dy - 6.0 * s, 12.0 * s, 0.0, math.pi * 2.0)
            ctx.set_source_rgba(COL_AMBER_BRIGHT[0], COL_AMBER_BRIGHT[1], COL_AMBER_BRIGHT[2], 0.25)
            ctx.fill()

            _cairo_rounded_rect(ctx, dx - 56.0 * s, dy + ph * 0.24, 112.0 * s, 10.0 * s, 4.0 * s)
            ctx.set_source_rgb(*COL_BG)
            ctx.fill_preserve()
            ctx.set_source_rgb(*COL_AMBER_DIM)
            ctx.set_line_width(1.6)
            ctx.stroke()

            feed = (clock * 0.48) % 1.0
            sheet_h = (14.0 + feed * 86.0) * s
            paper_top = dy + ph * 0.26
            ctx.save()
            ctx.new_path()
            ctx.rectangle(dx - 54.0 * s, dy + ph * 0.28, 108.0 * s, 118.0 * s)
            ctx.clip()
            _cairo_rounded_rect(ctx, dx - 46.0 * s, paper_top, 92.0 * s, sheet_h, 5.0 * s)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.fill_preserve()
            ctx.set_source_rgb(*COL_AMBER)
            ctx.set_line_width(2.0)
            ctx.stroke()
            for li in range(5):
                ly = paper_top + (15.0 + li * 15.0) * s
                if ly + 4.0 * s < paper_top + sheet_h - 8.0 * s:
                    lw = (52.0 if li == 0 else (38.0 if li == 4 else 66.0)) * s
                    _cairo_rounded_rect(ctx, dx - 34.0 * s, ly, lw, 4.5 * s, 2.0 * s)
                    ctx.set_source_rgb(*(COL_AMBER if li == 0 else COL_AMBER_DIM))
                    ctx.fill()
            ctx.restore()
            return

        if key == "operating_xiaoai":
            sx = cx + 238.0 * s
            sy = cy + 14.0 * s
            sw = 88.0 * s
            sh = 152.0 * s

            ctx.set_line_cap(cairo.LINE_CAP_ROUND)
            for i in range(3):
                u = (clock * 0.95 + i * 0.333) % 1.0
                bx = (cur_cx + fr * 0.56) + ((sx - sw * 0.65) - (cur_cx + fr * 0.56)) * u
                by = (cur_cy - 18.0 * s) + ((sy - 38.0 * s) - (cur_cy - 18.0 * s)) * u
                op = math.sin(u * math.pi) * 0.90
                ctx.new_path()
                ctx.arc(bx - 10.0 * s, by, (18.0 + u * 10.0) * s, -math.pi * 0.34, math.pi * 0.34)
                ctx.set_source_rgba(COL_EMERALD[0], COL_EMERALD[1], COL_EMERALD[2], op)
                ctx.set_line_width(3.0)
                ctx.stroke()

            for i in range(2):
                cyc = (clock * 0.65 + i * 0.5) % 1.0
                ctx.new_path()
                ctx.arc(sx, sy - sh * 0.44, (24.0 + cyc * 72.0) * s, math.pi * 1.15, math.pi * 1.95)
                ctx.set_source_rgba(COL_SKY[0], COL_SKY[1], COL_SKY[2], (1.0 - cyc) * 0.72)
                ctx.set_line_width(2.4)
                ctx.stroke()

            nodes = (
                (sx - 56.0 * s, sy - 118.0 * s, COL_AMBER_BRIGHT),
                (sx + 2.0 * s, sy - 134.0 * s, COL_EMERALD),
                (sx + 56.0 * s, sy - 112.0 * s, COL_SKY),
            )
            for idx, (nx, ny, ncol) in enumerate(nodes):
                glow = 0.55 + 0.45 * math.sin(clock * 4.5 + idx * 1.7)
                ctx.new_path()
                ctx.arc(nx, ny, 11.0 * s, 0.0, math.pi * 2.0)
                ctx.set_source_rgba(ncol[0], ncol[1], ncol[2], 0.16 * glow)
                ctx.fill_preserve()
                ctx.set_source_rgba(ncol[0], ncol[1], ncol[2], 0.90 * glow)
                ctx.set_line_width(2.0)
                ctx.stroke()
                ctx.new_path()
                ctx.arc(nx, ny, max(2.2, 3.6 * s), 0.0, math.pi * 2.0)
                ctx.set_source_rgb(*ncol)
                ctx.fill()

            _cairo_rounded_rect(ctx, sx - sw * 0.5, sy - sh * 0.5, sw, sh, 22.0 * s)
            ctx.set_source_rgb(0x07 / 255.0, 0x11 / 255.0, 0x0E / 255.0)
            ctx.fill_preserve()
            ctx.set_source_rgb(*COL_EMERALD)
            ctx.set_line_width(2.6)
            ctx.stroke()

            ctx.set_source_rgba(COL_EMERALD[0], COL_EMERALD[1], COL_EMERALD[2], 0.45)
            for row in range(5):
                for col_i in range(-3, 4):
                    ctx.new_path()
                    ctx.arc(sx + col_i * 9.5 * s, sy + (12.0 + row * 10.5) * s, max(1.2, 1.8 * s), 0.0, math.pi * 2.0)
                    ctx.fill()

            ring_y = sy - sh * 0.5 + 15.0 * s
            ctx.save()
            ctx.translate(sx, ring_y)
            ctx.scale(1.0, 0.34)
            ctx.new_path()
            ctx.arc(0.0, 0.0, sw * 0.38, 0.0, math.pi * 2.0)
            ctx.set_source_rgb(*COL_SKY)
            ctx.set_line_width(5.0)
            ctx.stroke()
            bead_ang = clock * 4.2
            ctx.new_path()
            ctx.arc(math.cos(bead_ang) * sw * 0.38, math.sin(bead_ang) * sw * 0.38, max(3.0, 5.5 * s), 0.0, math.pi * 2.0)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.fill()
            ctx.restore()
            return

        if key == "operating_tv":
            tv_x = cx + 236.0 * s
            tv_y = cy - 54.0 * s
            tv_w = 166.0 * s
            tv_h = 104.0 * s

            _cairo_rounded_rect(ctx, tv_x - tv_w * 0.5, tv_y - tv_h * 0.5, tv_w, tv_h, 10.0 * s)
            ctx.set_source_rgb(0x05 / 255.0, 0x0C / 255.0, 0x14 / 255.0)
            ctx.fill_preserve()
            ctx.set_source_rgb(*COL_SKY)
            ctx.set_line_width(2.6)
            ctx.stroke()

            ctx.set_source_rgb(*COL_SKY)
            ctx.set_line_width(3.0)
            ctx.set_line_cap(cairo.LINE_CAP_ROUND)
            ctx.new_path()
            ctx.move_to(tv_x, tv_y + tv_h * 0.5)
            ctx.line_to(tv_x, tv_y + tv_h * 0.5 + 18.0 * s)
            ctx.move_to(tv_x - 36.0 * s, tv_y + tv_h * 0.5 + 19.0 * s)
            ctx.line_to(tv_x + 36.0 * s, tv_y + tv_h * 0.5 + 19.0 * s)
            ctx.stroke()

            focus_idx = int(clock * 2.2) % 3
            for i in range(3):
                tile_x = tv_x + (-66.0 + i * 46.0) * s
                tile_y = tv_y - 26.0 * s
                active = i == focus_idx
                base_c = COL_SKY if active else COL_AMBER
                _cairo_rounded_rect(ctx, tile_x, tile_y, 40.0 * s, 34.0 * s, 5.0 * s)
                ctx.set_source_rgba(base_c[0], base_c[1], base_c[2], 0.34 if active else 0.10)
                ctx.fill_preserve()
                if active:
                    ctx.set_source_rgb(*COL_WHITE)
                    ctx.set_line_width(2.2)
                else:
                    ctx.set_source_rgba(COL_SKY[0], COL_SKY[1], COL_SKY[2], 0.45)
                    ctx.set_line_width(1.2)
                ctx.stroke()

            _cairo_rounded_rect(ctx, tv_x - 64.0 * s, tv_y + 22.0 * s, 128.0 * s, 7.0 * s, 3.5 * s)
            ctx.set_source_rgba(COL_SKY[0], COL_SKY[1], COL_SKY[2], 0.25)
            ctx.fill()
            bar_w = (36.0 + 70.0 * (0.5 + 0.5 * math.sin(clock * 2.6))) * s
            _cairo_rounded_rect(ctx, tv_x - 64.0 * s, tv_y + 22.0 * s, bar_w, 7.0 * s, 3.5 * s)
            ctx.set_source_rgb(*COL_EMERALD)
            ctx.fill()

            rx = cx + 196.0 * s
            ry = cy + 84.0 * s
            rr = 30.0 * s
            ctx.new_path()
            ctx.arc(rx, ry, rr, 0.0, math.pi * 2.0)
            ctx.set_source_rgba(COL_SKY[0], COL_SKY[1], COL_SKY[2], 0.12)
            ctx.fill_preserve()
            ctx.set_source_rgb(*COL_SKY)
            ctx.set_line_width(2.4)
            ctx.stroke()

            press_beat = max(0.0, math.sin(clock * 5.6))
            ctx.new_path()
            ctx.arc(rx, ry, rr * (0.34 + 0.04 * press_beat), 0.0, math.pi * 2.0)
            ctx.set_source_rgba(COL_AMBER_BRIGHT[0], COL_AMBER_BRIGHT[1], COL_AMBER_BRIGHT[2], 0.25 + 0.40 * press_beat)
            ctx.fill_preserve()
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.set_line_width(1.8)
            ctx.stroke()

            dirs = ((0.0, -1.0), (1.0, 0.0), (0.0, 1.0), (-1.0, 0.0))
            active_dir = int(clock * 2.2) % 4
            chev = rr * 0.13
            ctx.set_line_cap(cairo.LINE_CAP_ROUND)
            ctx.set_line_join(cairo.LINE_JOIN_ROUND)
            for idx, (dx, dy) in enumerate(dirs):
                px = rx + dx * rr * 0.67
                py = ry + dy * rr * 0.67
                nx, ny = -dy, dx
                ctx.new_path()
                ctx.move_to(px - dx * chev * 0.5 + nx * chev, py - dy * chev * 0.5 + ny * chev)
                ctx.line_to(px + dx * chev * 0.7, py + dy * chev * 0.7)
                ctx.line_to(px - dx * chev * 0.5 - nx * chev, py - dy * chev * 0.5 - ny * chev)
                ctx.set_source_rgb(*(COL_AMBER_BRIGHT if idx == active_dir else COL_WHITE))
                ctx.set_line_width(2.6 if idx == active_dir else 1.8)
                ctx.stroke()

            for i in range(3):
                u = (clock * 1.4 + i * 0.333) % 1.0
                bx = rx + ((tv_x - 10.0 * s) - rx) * u
                by = (ry - rr - 4.0 * s) + ((tv_y + tv_h * 0.5 + 14.0 * s) - (ry - rr - 4.0 * s)) * u
                col = COL_SKY if i % 2 == 0 else COL_EMERALD
                ctx.new_path()
                ctx.arc(bx, by, (12.0 + u * 8.0) * s, -math.pi * 0.76, -math.pi * 0.24)
                ctx.set_source_rgba(col[0], col[1], col[2], math.sin(u * math.pi) * 0.90)
                ctx.set_line_width(2.6)
                ctx.stroke()
            return

        if key == "managing_laifen":
            bx = cx + 248.0 * s
            by = cy + 14.0 * s

            ctx.set_line_cap(cairo.LINE_CAP_ROUND)
            for i in range(3):
                u = (clock * 1.15 + i * 0.333) % 1.0
                wx = (cur_cx + fr * 0.62) + ((bx - 42.0 * s) - (cur_cx + fr * 0.62)) * u
                wy = (cur_cy + 8.0 * s) + ((by + 16.0 * s) - (cur_cy + 8.0 * s)) * u
                col = COL_SKY if i % 2 == 0 else COL_EMERALD
                ctx.new_path()
                ctx.arc(wx - 8.0 * s, wy, (15.0 + u * 9.0) * s, -math.pi * 0.32, math.pi * 0.32)
                ctx.set_source_rgba(col[0], col[1], col[2], math.sin(u * math.pi) * 0.88)
                ctx.set_line_width(2.8)
                ctx.stroke()

            for i in range(5):
                u = (clock * 0.72 + i * 0.2) % 1.0
                bbx = bx - 30.0 * s + (math.sin(clock * 3.1 + i * 1.4) * 16.0 + (i - 2) * 9.0) * s
                bby = (by - 92.0 * s) - u * 54.0 * s
                br = (3.4 + (i % 3) * 1.6) * (0.7 + 0.4 * math.sin(u * math.pi)) * s
                bop = math.sin(u * math.pi) * 0.85
                bcol = COL_SKY if i % 2 == 0 else COL_EMERALD
                ctx.new_path()
                ctx.arc(bbx, bby, br, 0.0, math.pi * 2.0)
                ctx.set_source_rgba(bcol[0], bcol[1], bcol[2], bop * 0.16)
                ctx.fill_preserve()
                ctx.set_source_rgba(bcol[0], bcol[1], bcol[2], bop)
                ctx.set_line_width(1.6)
                ctx.stroke()
                ctx.new_path()
                ctx.arc(bbx - br * 0.32, bby - br * 0.32, max(1.0, br * 0.26), 0.0, math.pi * 2.0)
                ctx.set_source_rgba(1.0, 1.0, 1.0, bop)
                ctx.fill()

            sp0 = max(0.0, math.sin(clock * 4.2))
            sp1 = max(0.0, math.cos(clock * 3.6 + 0.8))
            ctx.set_source_rgba(1.0, 1.0, 1.0, 0.35 + 0.65 * sp0)
            _cairo_four_star(ctx, bx - 54.0 * s, by - 118.0 * s, 7.5 * s)
            ctx.set_source_rgba(COL_AMBER_BRIGHT[0], COL_AMBER_BRIGHT[1], COL_AMBER_BRIGHT[2], 0.35 + 0.65 * sp1)
            _cairo_four_star(ctx, bx + 26.0 * s, by - 124.0 * s, 6.0 * s)

            vib_x = math.sin(clock * 28.0) * 1.2 * s
            ctx.save()
            ctx.translate(bx + vib_x, by)
            ctx.rotate(0.18)

            _cairo_rounded_rect(ctx, -20.0 * s, -30.0 * s, 40.0 * s, 134.0 * s, 17.0 * s)
            ctx.set_source_rgb(6.0 / 255.0, 17.0 / 255.0, 24.0 / 255.0)
            ctx.fill_preserve()
            ctx.set_source_rgb(*COL_SKY)
            ctx.set_line_width(2.6)
            ctx.stroke()

            _cairo_rounded_rect(ctx, -6.0 * s, -2.0 * s, 12.0 * s, 22.0 * s, 6.0 * s)
            ctx.set_source_rgba(COL_SKY[0], COL_SKY[1], COL_SKY[2], 0.18)
            ctx.fill_preserve()
            ctx.set_source_rgba(COL_SKY[0], COL_SKY[1], COL_SKY[2], 0.72)
            ctx.set_line_width(1.5)
            ctx.stroke()

            active_mode_led = int(clock * 1.6) % 3
            for idx, ly in enumerate((38.0 * s, 52.0 * s, 66.0 * s)):
                is_lit = idx == active_mode_led
                pulse = (0.72 + 0.28 * math.sin(clock * 8.0)) if is_lit else 0.35
                lcol = COL_EMERALD if is_lit else COL_AMBER_BRIGHT
                ctx.new_path()
                ctx.arc(0.0, ly, (4.4 if is_lit else 2.8) * s, 0.0, math.pi * 2.0)
                ctx.set_source_rgba(lcol[0], lcol[1], lcol[2], pulse)
                ctx.fill()
                if is_lit:
                    ctx.new_path()
                    ctx.arc(0.0, ly, 1.8 * s, 0.0, math.pi * 2.0)
                    ctx.set_source_rgb(*COL_WHITE)
                    ctx.fill()

            ctx.new_path()
            ctx.move_to(-12.0 * s, 88.0 * s)
            ctx.line_to(12.0 * s, 88.0 * s)
            ctx.set_source_rgba(COL_AMBER_BRIGHT[0], COL_AMBER_BRIGHT[1], COL_AMBER_BRIGHT[2], 0.75)
            ctx.set_line_width(2.2)
            ctx.stroke()

            _cairo_rounded_rect(ctx, -5.5 * s, -78.0 * s, 11.0 * s, 50.0 * s, 4.0 * s)
            ctx.set_source_rgb(6.0 / 255.0, 17.0 / 255.0, 24.0 / 255.0)
            ctx.fill_preserve()
            ctx.set_source_rgb(*COL_SKY)
            ctx.set_line_width(2.2)
            ctx.stroke()

            sweep_ang = math.sin(clock * 7.5) * 0.24
            ctx.save()
            ctx.translate(0.0, -76.0 * s)
            ctx.rotate(sweep_ang)

            ctx.new_path()
            ctx.arc(0.0, -24.0 * s, 30.0 * s, -math.pi * 0.85, -math.pi * 0.45)
            ctx.set_source_rgba(COL_SKY[0], COL_SKY[1], COL_SKY[2], 0.65)
            ctx.set_line_width(2.0)
            ctx.stroke()

            ctx.new_path()
            ctx.arc(0.0, -24.0 * s, 35.0 * s, math.pi * 0.55, math.pi * 0.92)
            ctx.set_source_rgba(COL_AMBER_BRIGHT[0], COL_AMBER_BRIGHT[1], COL_AMBER_BRIGHT[2], 0.55)
            ctx.set_line_width(1.8)
            ctx.stroke()

            _cairo_rounded_rect(ctx, -9.0 * s, -46.0 * s, 18.0 * s, 44.0 * s, 8.0 * s)
            ctx.set_source_rgb(6.0 / 255.0, 17.0 / 255.0, 24.0 / 255.0)
            ctx.fill_preserve()
            ctx.set_source_rgb(*COL_SKY)
            ctx.set_line_width(2.4)
            ctx.stroke()

            for ti in range(6):
                ty = (-40.0 + ti * 6.0) * s
                tlen = (11.0 if ti in (0, 5) else 14.0) * s
                ctx.new_path()
                ctx.move_to(-9.0 * s, ty)
                ctx.line_to(-9.0 * s - tlen, ty)
                ctx.set_source_rgb(*(COL_WHITE if ti % 2 == 0 else COL_EMERALD))
                ctx.set_line_width(max(2.2, 3.2 * s))
                ctx.stroke()

            ctx.restore()
            ctx.restore()
            return

        if key == "weighing_scale":
            sx = cx + 244.0 * s
            sy = cy + 10.0 * s
            sw = 154.0 * s
            sh = 154.0 * s

            ctx.set_line_cap(cairo.LINE_CAP_ROUND)
            for i in range(3):
                u = (clock * 1.1 + i * 0.333) % 1.0
                wx = (cur_cx + fr * 0.60) + ((sx - sw * 0.54) - (cur_cx + fr * 0.60)) * u
                wy = (cur_cy + 8.0 * s) + ((sy - 6.0 * s) - (cur_cy + 8.0 * s)) * u
                col = COL_EMERALD if i % 2 == 0 else COL_SKY
                ctx.new_path()
                ctx.arc(wx - 8.0 * s, wy, (15.0 + u * 9.0) * s, -math.pi * 0.34, math.pi * 0.34)
                ctx.set_source_rgba(col[0], col[1], col[2], math.sin(u * math.pi) * 0.88)
                ctx.set_line_width(2.8)
                ctx.stroke()

            ctx.set_source_rgba(COL_EMERALD[0], COL_EMERALD[1], COL_EMERALD[2], 0.55)
            _cairo_rounded_rect(ctx, sx - 52.0 * s, sy + sh * 0.5 + 1.0 * s, 20.0 * s, 4.0 * s, 2.0 * s)
            ctx.fill()
            _cairo_rounded_rect(ctx, sx + 32.0 * s, sy + sh * 0.5 + 1.0 * s, 20.0 * s, 4.0 * s, 2.0 * s)
            ctx.fill()

            _cairo_rounded_rect(ctx, sx - sw * 0.5, sy - sh * 0.5, sw, sh, 24.0 * s)
            ctx.set_source_rgb(6.0 / 255.0, 18.0 / 255.0, 14.0 / 255.0)
            ctx.fill_preserve()
            ctx.set_source_rgb(*COL_EMERALD)
            ctx.set_line_width(2.6)
            ctx.stroke()

            _cairo_rounded_rect(ctx, sx - sw * 0.5 + 6.0 * s, sy - sh * 0.5 + 6.0 * s, sw - 12.0 * s, sh - 12.0 * s, 19.0 * s)
            ctx.set_source_rgba(COL_EMERALD[0], COL_EMERALD[1], COL_EMERALD[2], 0.22)
            ctx.set_line_width(1.4)
            ctx.stroke()

            _cairo_rounded_rect(ctx, sx - 48.0 * s, sy - 62.0 * s, 96.0 * s, 30.0 * s, 8.0 * s)
            ctx.set_source_rgb(*COL_BG)
            ctx.fill_preserve()
            ctx.set_source_rgba(COL_EMERALD[0], COL_EMERALD[1], COL_EMERALD[2], 0.55)
            ctx.set_line_width(1.6)
            ctx.stroke()

            cyc = (clock * 0.35) % 1.0
            if cyc < 0.38:
                lit_bar = int(clock * 6.0) % 4
                for b in range(4):
                    _cairo_rounded_rect(ctx, sx - 32.0 * s + b * 17.0 * s, sy - 50.0 * s, 12.0 * s, 6.0 * s, 3.0 * s)
                    if b == lit_bar:
                        ctx.set_source_rgb(*COL_EMERALD)
                    else:
                        ctx.set_source_rgba(COL_AMBER_BRIGHT[0], COL_AMBER_BRIGHT[1], COL_AMBER_BRIGHT[2], 0.65 if b < lit_bar else 0.20)
                    ctx.fill()
            else:
                locked = cyc >= 0.78
                w_val = "68.4" if locked else f"{68.2 + abs(math.sin(clock * 6.4)) * 0.3:.1f}"
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
                ctx.set_font_size(18.0 * s)
                tw = ctx.text_extents(w_val).x_advance
                ctx.set_source_rgb(*(COL_EMERALD if locked else COL_WHITE))
                ctx.move_to(sx - tw * 0.5 - 8.0 * s, sy - 41.0 * s)
                ctx.show_text(w_val)
                ctx.set_font_size(11.0 * s)
                ctx.set_source_rgb(*COL_AMBER_BRIGHT)
                ctx.move_to(sx + tw * 0.5 - 5.0 * s, sy - 41.0 * s)
                ctx.show_text("kg")
                if locked and math.sin(clock * 10.0) > -0.3:
                    ctx.new_path()
                    ctx.arc(sx - 38.0 * s, sy - 47.0 * s, max(2.0, 3.0 * s), 0.0, math.pi * 2.0)
                    ctx.set_source_rgb(*COL_EMERALD)
                    ctx.fill()

            active_pad = int(clock * 3.2) % 4
            pad_centers = (
                (sx - 32.0 * s, sy + 5.0 * s),
                (sx + 32.0 * s, sy + 5.0 * s),
                (sx + 32.0 * s, sy + 49.0 * s),
                (sx - 32.0 * s, sy + 49.0 * s),
            )
            for idx, (px, py) in enumerate(pad_centers):
                active = idx == active_pad
                pcol = (COL_EMERALD if idx % 2 == 0 else COL_SKY) if active else COL_EMERALD
                _cairo_rounded_rect(ctx, px - 27.0 * s, py - 19.0 * s, 54.0 * s, 38.0 * s, 10.0 * s)
                ctx.set_source_rgba(pcol[0], pcol[1], pcol[2], 0.24 if active else 0.08)
                ctx.fill_preserve()
                ctx.set_source_rgba(pcol[0], pcol[1], pcol[2], 0.95 if active else 0.34)
                ctx.set_line_width(2.2 if active else 1.4)
                ctx.stroke()

            bia_cy = sy + 27.0 * s
            for i in range(2):
                w = (clock * 0.78 + i * 0.5) % 1.0
                r = (12.0 + w * 44.0) * s
                col = COL_EMERALD if i == 0 else COL_SKY
                ctx.new_path()
                ctx.arc(sx, bia_cy, r, 0.0, math.pi * 2.0)
                ctx.set_source_rgba(col[0], col[1], col[2], (1.0 - w) * 0.78)
                ctx.set_line_width(2.2)
                ctx.stroke()
            ctx.new_path()
            ctx.arc(sx, bia_cy, max(2.8, 4.5 * s), 0.0, math.pi * 2.0)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.fill()

    def _draw_stage_cairo(self, ctx, face: FaceSnapshot, hud: HudState, geo: Dict[str, float]) -> None:
        cx = geo["face_cx"]
        cy = geo["face_cy"]
        fr = geo["face_r"]
        cur_cx = face.pose.center_x
        cur_cy = face.pose.center_y
        scale = fr / 192.0
        s = fr / 162.0
        sats = self._compute_satellites(face, cur_cx, cur_cy, fr)

        # Bilateral emerald voice-wave equalizer when actively listening
        if face.state_id == "listening":
            pulse = 0.5 + 0.5 * math.sin(face.clock * 4.5)
            ctx.new_path()
            ctx.arc(cx, cy, fr * (1.28 + 0.07 * pulse), math.pi * 0.72, math.pi * 1.28)
            ctx.set_source_rgba(COL_EMERALD[0], COL_EMERALD[1], COL_EMERALD[2], 0.45)
            ctx.set_line_width(3.0)
            ctx.set_line_cap(cairo.LINE_CAP_ROUND)
            ctx.stroke()

            ctx.new_path()
            ctx.arc(cx, cy, fr * (1.28 + 0.07 * pulse), -math.pi * 0.28, math.pi * 0.28)
            ctx.set_source_rgba(COL_EMERALD[0], COL_EMERALD[1], COL_EMERALD[2], 0.45)
            ctx.stroke()

            for side in (-1, 1):
                for bi in range(7):
                    dist = (6 - bi) if side < 0 else bi
                    norm = 1.0 - dist / 7.0
                    wave = 0.35 + 0.65 * abs(math.sin(face.clock * 6.8 + bi * 0.78 + (0.0 if side < 0 else 1.1)))
                    bh = (24.0 + 78.0 * norm * wave) * scale
                    bx = cx + side * (fr * 1.22 + dist * 16.5 * scale)
                    by = cy - bh * 0.5
                    bw = max(5.0, 7.5 * scale)
                    col = COL_EMERALD if bi % 2 == 0 else COL_AMBER_BRIGHT
                    ctx.set_source_rgb(*col)
                    _cairo_rounded_rect(ctx, bx - bw * 0.5, by, bw, bh, bw * 0.5)
                    ctx.fill()
        elif face.state_id in ("speaking", "printing", "operating_xiaoai", "operating_tv", "managing_laifen", "weighing_scale"):
            self._draw_scene_effects_cairo(ctx, face, hud, cx, cy, cur_cx, cur_cy, fr, s)

        # Back-side radar rings
        if face.morph == "radar":
            for i in range(2):
                cycle = (face.clock * 0.72 + i * 0.5) % 1.0
                r = (210.0 + cycle * 115.0) * scale
                op = (1.0 - cycle) * 0.78 * face.morph_progress
                ctx.new_path()
                ctx.set_source_rgba(COL_AMBER[0], COL_AMBER[1], COL_AMBER[2], op)
                ctx.set_line_width(3.5)
                ctx.arc(cx, cy, r, 0.0, math.pi * 2.0)
                ctx.stroke()

        if face.morph == "orbit":
            self._draw_orbit_ring(ctx, cx, cy, 285.0 * scale * face.morph_progress, 92.0 * scale * face.morph_progress, -0.36, 0.55)
        elif face.worker_count > 0:
            self._draw_orbit_ring(ctx, cx, cy, 278.0 * scale, 86.0 * scale, 0.24, 0.40)

        for sx, sy, sz, sr in sats:
            if sz < 0.0:
                ctx.new_path()
                ctx.set_source_rgba(COL_AMBER_BRIGHT[0], COL_AMBER_BRIGHT[1], COL_AMBER_BRIGHT[2], 0.75)
                ctx.arc(sx, sy, max(4.0, sr), 0.0, math.pi * 2.0)
                ctx.fill()

        # Squircle 3D hull
        poly = face.pose.body_polygon
        if len(poly) >= 3:
            ctx.new_path()
            ctx.move_to(poly[0][0], poly[0][1])
            for x, y in poly[1:]:
                ctx.line_to(x, y)
            ctx.close_path()
            ctx.set_source_rgb(*COL_AMBER)
            ctx.fill_preserve()

            edge_col = COL_AMBER_BRIGHT
            if face.state_id in ("listening", "operating_xiaoai", "weighing_scale"):
                edge_col = COL_EMERALD
            elif face.state_id in ("operating_tv", "managing_laifen"):
                edge_col = COL_SKY
            elif face.state_id == "sending_msg":
                edge_col = COL_SKY if hud.scene_channel == "telegram" else COL_EMERALD
            ctx.set_source_rgb(*edge_col)
            ctx.set_line_width(
                2.2 if face.state_id in ("listening", "speaking", "sending_msg", "printing", "operating_xiaoai", "operating_tv", "managing_laifen", "weighing_scale") else 2.0
            )
            ctx.stroke()

            ctx.save()
            ctx.new_path()
            ctx.move_to(poly[0][0], poly[0][1])
            for x, y in poly[1:]:
                ctx.line_to(x, y)
            ctx.close_path()
            ctx.clip()

            for eye in (face.pose.eye_left, face.pose.eye_right):
                if len(eye.points) >= 2 and eye.opacity > 0.01:
                    ctx.new_path()
                    ctx.move_to(eye.points[0][0], eye.points[0][1])
                    for x, y in eye.points[1:]:
                        ctx.line_to(x, y)
                    ctx.set_source_rgba(1.0, 1.0, 1.0, eye.opacity)
                    ctx.set_line_width(eye.stroke_width)
                    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
                    ctx.set_line_join(cairo.LINE_JOIN_ROUND)
                    ctx.stroke()
            ctx.restore()

        for sx, sy, sz, sr in sats:
            if sz >= 0.0:
                ctx.new_path()
                ctx.set_source_rgb(*COL_AMBER_BRIGHT)
                ctx.arc(sx, sy, max(4.0, sr), 0.0, math.pi * 2.0)
                ctx.fill()
                ctx.new_path()
                ctx.set_source_rgb(*COL_WHITE)
                ctx.arc(sx, sy, max(2.0, sr * 0.42), 0.0, math.pi * 2.0)
                ctx.fill()

        if face.state_id == "sending_msg":
            self._draw_scene_effects_cairo(ctx, face, hud, cx, cy, cur_cx, cur_cy, fr, s)

        if face.morph == "radar":
            a0 = face.clock * 3.1
            a1 = a0 + 1.25
            ctx.new_path()
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.set_line_width(5.5)
            ctx.set_line_cap(cairo.LINE_CAP_ROUND)
            ctx.arc(cx, cy, 255.0 * scale * face.morph_progress, a0, a1)
            ctx.stroke()

        if face.morph == "thinking":
            dot_s = (0.65 + 0.35 * face.morph_progress) * scale
            base_y = cur_cy + fr * 1.28
            for i in range(3):
                ph = face.clock * 4.4 - i * 0.85
                lift = max(0.0, math.sin(ph))
                dx = cur_cx + (i - 1) * 48.0 * dot_s
                dy = base_y - lift * 20.0 * scale
                ctx.new_path()
                ctx.set_source_rgb(*(COL_AMBER_BRIGHT if i == 1 else COL_AMBER))
                ctx.arc(dx, dy, 11.0 * dot_s, 0.0, math.pi * 2.0)
                ctx.fill()

        # Bottom stage caption pill for listening & dynamic scene states
        scene_cap = ""
        cap_col = COL_EMERALD
        if face.state_id == "listening":
            scene_cap = hud.voice_caption or "请说话 · 正在监听声纹与指令"
            cap_col = COL_EMERALD
        elif face.state_id == "speaking":
            scene_cap = hud.scene_caption or "小爱音箱正在播报回复…"
            cap_col = COL_AMBER_BRIGHT
        elif face.state_id == "sending_msg":
            is_tg = hud.scene_channel == "telegram"
            scene_cap = hud.scene_caption or ("电报消息发送中…" if is_tg else "微信消息发送中…")
            cap_col = COL_SKY if is_tg else COL_EMERALD
        elif face.state_id == "printing":
            scene_cap = hud.scene_caption or "正在操作打印机输出文档…"
            cap_col = COL_AMBER_BRIGHT
        elif face.state_id == "operating_xiaoai":
            scene_cap = hud.scene_caption or "正在通过小爱音箱操控家居设备…"
            cap_col = COL_EMERALD
        elif face.state_id == "operating_tv":
            scene_cap = hud.scene_caption or "正在遥控客厅电视…"
            cap_col = COL_SKY
        elif face.state_id == "managing_laifen":
            scene_cap = hud.scene_caption or "正在蓝牙同步与管理徕芬牙刷…"
            cap_col = COL_SKY
        elif face.state_id == "weighing_scale":
            scene_cap = hud.scene_caption or "沃莱 A1 测试模式 · 请赤脚上秤测量…"
            cap_col = COL_EMERALD

        if scene_cap:
            cap = _sanitize_hud_text(scene_cap)[:36]
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(18.0 if hud.grid_rows == 2 else 15.5)
            cap = _fit_single_line_cairo(ctx, cap, 600.0)
            tw = ctx.text_extents(cap).x_advance
            cap_w = min(640.0, tw + 34.0)
            cap_h = 34.0 if hud.grid_rows == 2 else 28.0
            cap_x = cx - cap_w * 0.5
            min_y = (cy + fr * 1.12 + 23.0 * s) if face.state_id == "speaking" else (cy + fr * 1.18)
            cap_y = min(geo["marquee_y"] - cap_h - 6.0, min_y)
            _cairo_rounded_rect(ctx, cap_x, cap_y, cap_w, cap_h, cap_h * 0.5)
            ctx.set_source_rgba(cap_col[0], cap_col[1], cap_col[2], 0.14)
            ctx.fill_preserve()
            ctx.set_source_rgb(*cap_col)
            ctx.set_line_width(1.6)
            ctx.stroke()
            ctx.move_to(cap_x + (cap_w - tw) * 0.5, cap_y + cap_h * 0.68)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.show_text(cap)

        if face.state_id == "sleeping":
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            top_y = max(98.0, cy - fr * 1.05)
            if face.sub_phase == "rem":
                for idx in range(5):
                    phase = (face.clock * 0.45 + idx * 0.21) % 1.0
                    sx = 220.0 + idx * 90.0 + math.sin(face.clock * 1.4 + idx) * 18.0
                    sy = (top_y + 24.0) - phase * 58.0
                    r = 3.5 + math.sin(phase * math.pi) * 3.0
                    ctx.new_path()
                    ctx.set_source_rgba(COL_AMBER_BRIGHT[0], COL_AMBER_BRIGHT[1], COL_AMBER_BRIGHT[2], math.sin(phase * math.pi))
                    ctx.arc(sx, sy, r, 0.0, math.pi * 2.0)
                    ctx.fill()
                ctx.set_source_rgb(*COL_AMBER_BRIGHT)
                _cairo_four_star(ctx, 566.0, top_y, 9.5)
                _cairo_four_star(ctx, 582.0, top_y - 10.0, 5.0)
                ctx.set_font_size(20.0)
                ctx.move_to(594.0, top_y + 7.0)
                ctx.show_text("梦境整理")
            else:
                ctx.set_source_rgba(COL_AMBER[0], COL_AMBER[1], COL_AMBER[2], 0.65)
                ctx.new_path()
                ctx.arc(600.0, top_y + 1.0, 4.0, 0.0, math.pi * 2.0)
                ctx.fill()
                ctx.set_font_size(20.0)
                ctx.set_source_rgb(*COL_AMBER)
                ctx.move_to(614.0, top_y + 7.5)
                ctx.show_text("休眠中")

    def _draw_marquee_cairo(self, ctx, face: FaceSnapshot, hud: HudState, geo: Dict[str, float]) -> None:
        x0 = 36.0
        w = 728.0
        y0 = geo["marquee_y"]
        h = geo["marquee_h"]

        is_in = hud.headline_incoming or (face.state_id == "listening")
        border_col = COL_EMERALD if is_in else COL_AMBER_DIM
        _cairo_rounded_rect(ctx, x0, y0, w, h, 14.0)
        ctx.set_source_rgb(*border_col)
        ctx.set_line_width(1.8 if hud.headline_incoming else 1.6)
        ctx.stroke()

        # Left source pill
        src = _localize_headline_source(hud.headline_source or "主脑")
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(16.0)
        sw = ctx.text_extents(src).x_advance
        pill_w = max(72.0, sw + 22.0)
        pill_h = h - 18.0
        pill_x = x0 + 12.0
        pill_y = y0 + 9.0
        pill_col = COL_EMERALD if is_in else COL_AMBER
        _cairo_rounded_rect(ctx, pill_x, pill_y, pill_w, pill_h, 8.0)
        ctx.set_source_rgba(pill_col[0], pill_col[1], pill_col[2], 0.14 if hud.headline_incoming else 0.12)
        ctx.fill_preserve()
        ctx.set_source_rgb(*pill_col)
        ctx.set_line_width(1.5)
        ctx.stroke()
        ctx.move_to(pill_x + (pill_w - sw) * 0.5, pill_y + pill_h * 0.72)
        ctx.set_source_rgb(*(COL_WHITE if hud.headline_incoming else COL_AMBER_BRIGHT))
        ctx.show_text(src)

        # Clipped horizontally scrolling message viewport
        vx = pill_x + pill_w + 14.0
        vw = (x0 + w - 14.0) - vx
        txt = self.marquee.text
        text_w = max(1.0, self.marquee.text_w)

        if self._marquee_key != (txt, int(h)) or self._marquee_text_surface is None:
            surf_w = min(MAX_MARQUEE_SURF_W, max(64, int(math.ceil(text_w)) + 24))
            surf_h = int(h)
            ms = cairo.ImageSurface(cairo.FORMAT_ARGB32, surf_w, surf_h)
            mctx = cairo.Context(ms)
            mctx.set_antialias(cairo.ANTIALIAS_BEST)
            mctx.set_source_rgb(*COL_BG)
            mctx.paint()
            mctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            mctx.set_font_size(22.0)
            mctx.set_source_rgb(*COL_WHITE)
            mctx.move_to(0.0, h * 0.68)
            mctx.show_text(txt)
            self._marquee_text_surface = ms
            self._marquee_key = (txt, int(h))

        ctx.save()
        ctx.new_path()
        ctx.rectangle(vx, y0 + 2.0, vw, h - 4.0)
        ctx.clip()

        sx = self.marquee.scroll_x
        ms_surf = self._marquee_text_surface
        ctx.set_source_surface(ms_surf, vx - sx, y0)
        ctx.paint()
        if self.marquee.phase == "scroll" and text_w > vw + 4.0:
            cycle = text_w + self.marquee.gap
            if cycle - sx < vw:
                ctx.set_source_surface(ms_surf, vx + cycle - sx, y0)
                ctx.paint()

        # Subtle edge fade gradients (left + right, pure black transparent)
        if self.marquee.phase == "scroll":
            lg = cairo.LinearGradient(vx, 0.0, vx + 20.0, 0.0)
            lg.add_color_stop_rgba(0.0, 0.0, 0.0, 0.0, 1.0)
            lg.add_color_stop_rgba(1.0, 0.0, 0.0, 0.0, 0.0)
            ctx.set_source(lg)
            ctx.rectangle(vx, y0 + 2.0, 20.0, h - 4.0)
            ctx.fill()

        if text_w > vw + 4.0:
            rg = cairo.LinearGradient(vx + vw - 24.0, 0.0, vx + vw, 0.0)
            rg.add_color_stop_rgba(0.0, 0.0, 0.0, 0.0, 0.0)
            rg.add_color_stop_rgba(1.0, 0.0, 0.0, 0.0, 1.0)
            ctx.set_source(rg)
            ctx.rectangle(vx + vw - 24.0, y0 + 2.0, 24.0, h - 4.0)
            ctx.fill()

        ctx.restore()

    def _draw_bottom_region_cairo(
        self,
        ctx,
        hud: HudState,
        placed_cards: Sequence[PlacedCard],
        widget_data: Dict[str, Dict[str, Any]],
        geo: Dict[str, float],
    ) -> None:
        x0 = 36.0
        w = 728.0
        y0 = geo["grid_y"]
        total_h = geo["grid_h"]

        # Priority 1: Preemptive Tactical Task / ASK_BOSS Overlay when active
        if hud.auto_task_overlay and (hud.ask_boss_question or hud.workers):
            self._draw_task_overlay_cairo(ctx, hud, x0, y0, w, total_h)
            return

        # Priority 2: Bento Grid Cards
        if not placed_cards:
            _cairo_rounded_rect(ctx, x0, y0, w, total_h, 16.0)
            ctx.set_source_rgb(*COL_AMBER_DIM)
            ctx.set_line_width(1.5)
            ctx.stroke()
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(24.0)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x0 + 28.0, y0 + 56.0)
            ctx.show_text("当前页暂无卡片 — 请在 Web 控制台「CS80 副屏」添加插件卡片")
        else:
            for card in placed_cards:
                key = f"{card.kind}#{card.card_id}" if (card.kind.startswith("plugin:") and card.card_id) else card.kind
                data = widget_data.get(key) or widget_data.get(card.kind) or {}
                self._draw_bento_card_cairo(ctx, card, data, hud)

        # Page carousel dots when multiple pages exist
        if hud.page_count > 1:
            dot_y = 1205.5
            spacing = 18.0
            start_x = 400.0 - ((hud.page_count - 1) * spacing) * 0.5
            for idx in range(hud.page_count):
                active = idx == hud.active_page
                ctx.new_path()
                ctx.arc(start_x + idx * spacing, dot_y, 4.2 if active else 2.8, 0.0, math.pi * 2.0)
                ctx.set_source_rgb(*(COL_AMBER_BRIGHT if active else COL_AMBER_DARK_LINE))
                ctx.fill()

    def _draw_task_overlay_cairo(self, ctx, hud: HudState, x0: float, y_top: float, w: float, total_h: float) -> None:
        has_workers = len(hud.workers) > 0
        cur_y = y_top
        if hud.ask_boss_question:
            box_h = min(total_h * (0.52 if has_workers else 0.92), 280.0 if has_workers else 380.0)
            _cairo_rounded_rect(ctx, x0, cur_y, w, box_h, 16.0)
            ctx.set_source_rgba(COL_AMBER_BRIGHT[0], COL_AMBER_BRIGHT[1], COL_AMBER_BRIGHT[2], 0.06)
            ctx.fill_preserve()
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.set_line_width(2.2)
            ctx.stroke()

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(21.0)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            _cairo_lightning_bolt(ctx, x0 + 22.0, cur_y + 18.0, 20.0)
            ctx.move_to(x0 + 42.0, cur_y + 36.0)
            ctx.show_text("等待您的决策指示")

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(25.0)
            ctx.set_source_rgb(*COL_WHITE)
            max_lines = 3 if has_workers else 6
            lines = _wrap_text_cairo(ctx, hud.ask_boss_question, w - 44.0, max_lines)
            for idx, line in enumerate(lines):
                ctx.move_to(x0 + 22.0, cur_y + 78.0 + idx * 36.0)
                ctx.show_text(line)

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(17.0)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x0 + 22.0, cur_y + box_h - 16.0)
            ctx.show_text("微信 / 小爱语音直接回复即可唤醒继续")
            cur_y += box_h + 14.0

        for idx, wk in enumerate(hud.workers[:4]):
            if cur_y + 52.0 > y_top + total_h:
                break
            _cairo_rounded_rect(ctx, x0, cur_y, w, 48.0, 10.0)
            ctx.set_source_rgb(*COL_AMBER_DIM)
            ctx.set_line_width(1.6)
            ctx.stroke()

            tag_lbl = _localize_profile_tag(wk.profile)
            tag_w = _draw_pill(
                ctx,
                x0 + 14.0,
                cur_y + 10.0,
                28.0,
                tag_lbl,
                COL_AMBER_BRIGHT,
                font_size=15.0,
                pad_x=10.0,
                font_family=self.font_family,
            )

            elapsed_str = f"{wk.elapsed_sec}秒"
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(18.0)
            elapsed_w = ctx.text_extents(elapsed_str).x_advance
            ctx.set_source_rgb(*COL_EMERALD)
            ctx.move_to(x0 + w - 16.0 - elapsed_w, cur_y + 30.0)
            ctx.show_text(elapsed_str)

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(19.0)
            ctx.set_source_rgb(*COL_WHITE)
            avail_w = w - 46.0 - tag_w - elapsed_w
            prompt_lines = _wrap_text_cairo(ctx, wk.prompt, avail_w, 1)
            ctx.move_to(x0 + 24.0 + tag_w, cur_y + 31.0)
            ctx.show_text(prompt_lines[0] if prompt_lines else wk.task_id)
            cur_y += 58.0

    def _draw_card_frame(
        self,
        ctx,
        card: PlacedCard,
        title: str,
        badge: str,
        border_col: Tuple[float, float, float],
        badge_col: Tuple[float, float, float],
        dot_col: Optional[Tuple[float, float, float]] = None,
        badge_icon: Optional[str] = None,
    ) -> None:
        x, y, w, h = card.x, card.y, card.w, card.h
        _cairo_rounded_rect(ctx, x, y, w, h, 14.0)
        ctx.set_source_rgb(*border_col)
        ctx.set_line_width(1.6)
        ctx.stroke()

        # Card Header Row
        hdr_x = x + 16.0
        if dot_col is not None:
            ctx.new_path()
            ctx.arc(x + 21.0, y + 23.0, 4.5, 0.0, math.pi * 2.0)
            ctx.set_source_rgb(*dot_col)
            ctx.fill()
            hdr_x = x + 32.0

        b_str = _sanitize_hud_text(badge)[:18] if badge else ""
        bw = 0.0
        icon_w = 15.0 if badge_icon else 0.0
        if b_str:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(14.5)
            bw = ctx.text_extents(b_str).x_advance
            bx = x + w - 16.0 - bw
            if badge_icon == "bolt":
                ctx.set_source_rgb(*badge_col)
                _cairo_lightning_bolt(ctx, bx - 13.0, y + 15.5, 13.5)
            elif badge_icon == "lock":
                _cairo_lock_glyph(ctx, bx - 15.0, y + 15.5, 13.5, locked=True, col=badge_col)
            elif badge_icon == "unlock":
                _cairo_lock_glyph(ctx, bx - 15.0, y + 15.5, 13.5, locked=False, col=badge_col)
            ctx.set_source_rgb(*badge_col)
            ctx.move_to(bx, y + 28.0)
            ctx.show_text(b_str)

        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(17.0)
        ctx.set_source_rgb(*COL_AMBER_BRIGHT)
        title_max_w = max(60.0, w - (hdr_x - x) - 16.0 - ((bw + icon_w + 10.0) if b_str else 0.0))
        ctx.move_to(hdr_x, y + 29.0)
        ctx.show_text(_fit_single_line_cairo(ctx, title, title_max_w))

        ctx.new_path()
        ctx.move_to(x + 14.0, y + 40.0)
        ctx.line_to(x + w - 14.0, y + 40.0)
        ctx.set_source_rgb(*COL_AMBER_DARK_LINE)
        ctx.set_line_width(1.0)
        ctx.stroke()

    def _draw_bento_card_cairo(self, ctx, card: PlacedCard, data: Dict[str, Any], hud: HudState) -> None:
        kind = card.kind
        if kind == "fund-tracker":
            self._card_fund_tracker(ctx, card, data)
        elif kind == "health-scale":
            self._card_health_scale(ctx, card, data)
        elif kind == "miot":
            self._card_miot(ctx, card, data)
        elif kind == "ninebot":
            self._card_ninebot(ctx, card, data)
        elif kind == "laifen":
            self._card_laifen(ctx, card, data)
        elif kind == "netlea":
            self._card_netlea(ctx, card, data)
        elif kind == "apple-devices":
            self._card_apple_devices(ctx, card, data)
        elif kind == "system-pulse":
            self._card_system_pulse(ctx, card, data)
        elif kind == "tv-agent":
            self._card_tv_agent(ctx, card, data)
        elif kind == "tv-ir":
            self._card_tv_ir(ctx, card, data)
        elif kind == "memory":
            self._card_memory(ctx, card, data)
        elif kind == "timers":
            self._card_timers(ctx, card, data)
        elif kind == "usage":
            self._card_usage(ctx, card, data)
        elif kind == "weather":
            self._card_weather(ctx, card, data)
        elif kind == "workers":
            self._card_workers(ctx, card, data, hud)
        else:
            self._card_custom_plugin(ctx, card, data)

    def _card_fund_tracker(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        daily_pct = float(d.get("dailyPct") or 0.0)
        is_up = daily_pct >= 0.0
        accent = COL_RED if is_up else COL_EMERALD
        ok = bool(d.get("ok"))
        badge = f"{d.get('holdingCount', 0)}只 · {d.get('updatedHm') or '实时'}" if ok else "待同步"
        self._draw_card_frame(
            ctx,
            card,
            card.title or "投资收益",
            badge,
            accent if ok else COL_AMBER_DIM,
            accent if ok else COL_AMBER,
            dot_col=accent if ok else COL_AMBER_DIM,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        if d.get("empty") or not ok:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(19.0)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 18.0, y + 92.0)
            ctx.show_text(_fit_single_line_cairo(ctx, str(d.get("subline") or "暂无持仓数据"), w - 36.0))
            return

        sign = "+" if daily_pct > 0 else ""
        pct_str = f"{sign}{daily_pct:.2f}%"
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(35.0 if card.w_span == 2 else 30.0)
        ctx.set_source_rgb(*accent)
        ctx.move_to(x + 16.0, y + 84.0)
        ctx.show_text(pct_str)

        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        ctx.set_font_size(17.5)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 16.0, y + 112.0)
        ctx.show_text(_fit_single_line_cairo(ctx, str(d.get("subline") or ""), (w * 0.48 if card.w_span == 2 else w - 32.0)))

        tot_pnl_pct = float(d.get("totalPnlPct") or 0.0)
        tot_pnl = float(d.get("totalPnl") or 0.0)
        ctx.set_font_size(15.0)
        ctx.set_source_rgb(*COL_AMBER)
        ctx.move_to(x + 16.0, y + 136.0)
        ctx.show_text(_fit_single_line_cairo(ctx, f"累计 {tot_pnl:+.0f} ({tot_pnl_pct:+.1f}%)", (w * 0.48 if card.w_span == 2 else w - 32.0)))

        spark = d.get("spark") or []
        if card.w_span == 2 and card.h_span == 1:
            _draw_sparkline_cairo(ctx, x + w * 0.52, y + 54.0, w * 0.44, h - 70.0, spark, accent)
        elif card.h_span == 1:
            _draw_sparkline_cairo(ctx, x + 16.0, y + 146.0, w - 32.0, max(40.0, h - 158.0), spark, accent)
        else:
            spark_x = x + (w * 0.52 if card.w_span == 2 else 16.0)
            spark_w = (w * 0.44 if card.w_span == 2 else w - 32.0)
            spark_y = y + (54.0 if card.w_span == 2 else 148.0)
            spark_h = 88.0 if h >= 450 else 78.0
            _draw_sparkline_cairo(ctx, spark_x, spark_y, spark_w, spark_h, spark, accent)
            row_y = y + (160.0 if card.w_span == 2 else (spark_y - y + spark_h + 18.0))
            pitch = 38.0 if h >= 450 else 34.0
            for idx, item in enumerate((d.get("holdings") or [])[:6]):
                if row_y + 24.0 > y + h - 8.0:
                    break
                ch = float(item.get("changePct") or 0.0)
                r_col = COL_RED if ch >= 0.0 else COL_EMERALD
                if idx > 0:
                    ctx.new_path()
                    ctx.move_to(x + 16.0, row_y - 4.0)
                    ctx.line_to(x + w - 16.0, row_y - 4.0)
                    ctx.set_source_rgba(COL_AMBER_DARK_LINE[0], COL_AMBER_DARK_LINE[1], COL_AMBER_DARK_LINE[2], 0.45)
                    ctx.set_line_width(1.0)
                    ctx.stroke()
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                ctx.set_font_size(15.5)
                ctx.set_source_rgb(*COL_WHITE)
                ctx.move_to(x + 16.0, row_y + 18.0)
                ctx.show_text(_fit_single_line_cairo(ctx, f"{item.get('name', '')} ({item.get('code', '')})", w - 135.0))
                val_s = f"{ch:+.2f}%"
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
                vw = ctx.text_extents(val_s).x_advance
                ctx.set_source_rgb(*r_col)
                ctx.move_to(x + w - 16.0 - vw, row_y + 18.0)
                ctx.show_text(val_s)
                row_y += pitch

    def _card_health_scale(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        ok = bool(d.get("ok"))
        diff = float(d.get("diffKg") or 0.0)
        badge = f"评分 {d.get('score', '--')}" if d.get("score") else (d.get("measuredStr") or "待测量")
        self._draw_card_frame(
            ctx,
            card,
            card.title or "体脂健康",
            badge,
            COL_EMERALD if ok else COL_AMBER_DIM,
            COL_EMERALD if ok else COL_AMBER,
            dot_col=COL_EMERALD if ok else COL_AMBER_DIM,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        if d.get("empty") or not ok:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(19.0)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 18.0, y + 92.0)
            ctx.show_text("踩上体脂秤同步体重体脂")
            return

        w_str = f"{float(d.get('weightKg') or 0.0):.1f}"
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(35.0 if card.w_span == 2 else 31.0)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 16.0, y + 84.0)
        ctx.show_text(w_str)
        ww = ctx.text_extents(w_str).x_advance

        ctx.set_font_size(17.5)
        ctx.set_source_rgb(*(COL_EMERALD if diff <= 0.0 else COL_AMBER_BRIGHT))
        ctx.move_to(x + 22.0 + ww, y + 84.0)
        ctx.show_text(f"公斤  {diff:+.2f}")

        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        ctx.set_font_size(16.0)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 16.0, y + 112.0)
        fat = float(d.get("bodyFat") or 0.0)
        mus = float(d.get("musclePct") or 0.0)
        bmi = float(d.get("bmi") or 0.0)
        max_w = w * 0.50 if (card.w_span == 2) else (w - 32.0)
        ctx.show_text(_fit_single_line_cairo(ctx, f"体脂 {fat:.1f}% · 肌肉 {mus:.1f}% · 指数 {bmi:.1f}", max_w))

        spark = d.get("spark") or []
        bars = [
            ("体脂率", f"{fat:.1f}%", min(1.0, fat / 35.0), COL_AMBER_BRIGHT),
            ("骨骼肌", f"{mus:.1f}%", min(1.0, mus / 55.0), COL_EMERALD),
            ("水分率", f"{float(d.get('waterPct') or 0.0):.1f}%", min(1.0, float(d.get("waterPct") or 0.0) / 70.0), COL_SKY),
            ("内脏脂肪", f"{d.get('visceral', '--')} 级", min(1.0, float(d.get("visceral") or 0) / 18.0), COL_AMBER),
        ]
        if card.w_span == 2 and card.h_span == 1:
            _draw_sparkline_cairo(ctx, x + w * 0.55, y + 54.0, w * 0.41, h - 70.0, spark, COL_EMERALD)
            ctx.set_font_size(15.0)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 16.0, y + 142.0)
            ctx.show_text(_fit_single_line_cairo(ctx, f"体型 {d.get('bodyType') or '--'} · 代谢 {d.get('bmrKcal') or '--'} 千卡 · 水分 {d.get('waterPct') or '--'}%", w * 0.50))
        elif card.h_span == 1:
            _draw_sparkline_cairo(ctx, x + 16.0, y + 126.0, w - 32.0, max(42.0, h - 138.0), spark, COL_EMERALD)
        elif card.w_span == 2 and card.h_span == 2:
            ctx.set_font_size(15.0)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 16.0, y + 138.0)
            ctx.show_text(_fit_single_line_cairo(ctx, f"体型 {d.get('bodyType') or '--'} · 基础代谢 {d.get('bmrKcal') or '--'} 千卡", w * 0.46))
            _draw_sparkline_cairo(ctx, x + 16.0, y + 162.0, w * 0.45, h - 180.0, spark, COL_EMERALD)
            by = y + 60.0
            pitch = 68.0 if h >= 450 else 58.0
            for lbl, val, pct, bcol in bars:
                self._draw_bar_row(ctx, x + w * 0.52, by, w * 0.44, lbl, val, pct, bcol)
                by += pitch
        else:
            spark_h = 84.0 if h < 450 else 96.0
            _draw_sparkline_cairo(ctx, x + 16.0, y + 126.0, w - 32.0, spark_h, spark, COL_EMERALD)
            by = y + 126.0 + spark_h + 16.0
            pitch = 38.0 if h < 450 else 44.0
            for lbl, val, pct, bcol in bars:
                if by + 30.0 > y + h - 8.0:
                    break
                self._draw_bar_row(ctx, x + 16.0, by, w - 32.0, lbl, val, pct, bcol)
                by += pitch

    def _card_miot(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        ok = bool(d.get("ok"))
        online = int(d.get("online") or 0)
        total = int(d.get("total") or 0)
        on_cnt = int(d.get("onCount") or 0)
        self._draw_card_frame(
            ctx,
            card,
            card.title or "全屋智能",
            f"{online}/{total} 在线 · {on_cnt}开" if total > 0 else "待同步",
            COL_AMBER_DIM,
            COL_EMERALD if ok else COL_AMBER,
            dot_col=COL_EMERALD if ok else COL_AMBER_DIM,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        devices = list(d.get("devices") or [])
        if not devices:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(19.0)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 18.0, y + 92.0)
            ctx.show_text(_fit_single_line_cairo(ctx, str(d.get("subline") or "等待同步全屋设备"), w - 36.0))
            return

        env_temp = d.get("envTemp")
        env_hum = d.get("envHum")
        has_env = env_temp is not None or env_hum is not None
        grid_top = y + 52.0
        if has_env:
            cx = x + 16.0
            if env_temp is not None:
                cw = _draw_pill(ctx, cx, y + 48.0, 24.0, f"室温 {float(env_temp):.1f}℃", COL_AMBER_BRIGHT, font_size=13.0, pad_x=9.0, font_family=self.font_family)
                cx += cw + 8.0
            if env_hum is not None:
                cw = _draw_pill(ctx, cx, y + 48.0, 24.0, f"湿度 {float(env_hum):.0f}%", COL_SKY, font_size=13.0, pad_x=9.0, font_family=self.font_family)
                cx += cw + 8.0
            rooms = d.get("rooms")
            if rooms and cx + 80.0 < x + w - 16.0:
                rm_str = f"{int(rooms)} 个房间"
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                ctx.set_font_size(13.5)
                rw = ctx.text_extents(rm_str).x_advance
                ctx.set_source_rgb(*COL_AMBER)
                ctx.move_to(x + w - 16.0 - rw, y + 64.5)
                ctx.show_text(rm_str)
            grid_top = y + 80.0

        cols = 2 if card.w_span == 1 else 3
        gap = 10.0
        avail_h = max(84.0, (y + h - 12.0) - grid_top)
        max_rows = max(2, int((avail_h + gap) // (46.0 + gap)))
        pw = (w - 32.0 - gap * (cols - 1)) / float(cols)
        ph = min(64.0, (avail_h - gap * (max_rows - 1)) / float(max_rows))
        for idx, dev in enumerate(devices[: cols * max_rows]):
            r = idx // cols
            c = idx % cols
            px = x + 16.0 + c * (pw + gap)
            py = grid_top + r * (ph + gap)
            is_on = dev.get("on") is True
            is_online = bool(dev.get("online"))
            p_col = COL_EMERALD if is_on else (COL_AMBER_DIM if is_online else COL_RED)
            _cairo_rounded_rect(ctx, px, py, pw, ph, 10.0)
            fill_col = COL_EMERALD if is_on else (COL_AMBER if is_online else COL_RED)
            ctx.set_source_rgba(fill_col[0], fill_col[1], fill_col[2], 0.11 if is_on else (0.04 if is_online else 0.08))
            ctx.fill_preserve()
            ctx.set_source_rgb(*p_col)
            ctx.set_line_width(1.4)
            ctx.stroke()

            ctx.new_path()
            ctx.arc(px + 12.0, py + ph * 0.5, 4.0, 0.0, math.pi * 2.0)
            ctx.set_source_rgb(*(COL_EMERALD if is_on else (COL_AMBER if is_online else COL_RED)))
            ctx.fill()

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD if is_on else cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(14.5 if ph < 50.0 else 15.0)
            ctx.set_source_rgb(*(COL_WHITE if is_online else COL_AMBER_DIM))
            ctx.move_to(px + 22.0, py + ph * 0.46)
            ctx.show_text(_fit_single_line_cairo(ctx, str(dev.get("name") or ""), pw - 28.0))

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(12.0 if ph < 50.0 else 12.5)
            ctx.set_source_rgb(*(COL_EMERALD if is_on else COL_AMBER))
            st_lbl = "开启" if is_on else ("待机" if dev.get("on") is False else ("在线" if is_online else "离线"))
            ctx.move_to(px + 22.0, py + ph * 0.80)
            ctx.show_text(_fit_single_line_cairo(ctx, f"{dev.get('room', '')} · {st_lbl}", pw - 28.0))

    def _get_ninebot_scooter_surface(self, image_path: str, mtime_ns: int = 0) -> Optional[Any]:
        if cairo is None or not image_path:
            return None
        p = Path(image_path)
        try:
            if p.is_symlink() or not p.is_file():
                return None
            st = p.stat()
            cur_mtime = int(mtime_ns or st.st_mtime_ns)
            if st.st_size < 64 or st.st_size > 512 * 1024:
                return None
            cached = self._ninebot_img_cache.get(image_path)
            if cached is not None and cached[0] == cur_mtime:
                return cached[1]
            surf = cairo.ImageSurface.create_from_png(str(p))
            if surf.get_width() <= 0 or surf.get_height() <= 0:
                return None
            if len(self._ninebot_img_cache) >= 4:
                self._ninebot_img_cache.clear()
            self._ninebot_img_cache[image_path] = (cur_mtime, surf)
            return surf
        except Exception:
            return None

    def _draw_ninebot_showroom_cairo(
        self,
        ctx,
        sx: float,
        sy: float,
        sw: float,
        sh: float,
        accent: Tuple[float, float, float],
        image_path: str,
        mtime_ns: int,
        footer_text: str,
    ) -> None:
        _cairo_rounded_rect(ctx, sx, sy, sw, sh, 11.0)
        ctx.set_source_rgba(1.0, 1.0, 1.0, 0.03)
        ctx.fill_preserve()
        ctx.set_source_rgba(accent[0], accent[1], accent[2], 0.28)
        ctx.set_line_width(1.0)
        ctx.stroke()

        stage_cx = sx + sw * 0.5
        stage_h = sh - (22.0 if footer_text else 4.0)
        stage_cy = sy + stage_h * 0.50

        glow_r = min(sw, stage_h) * 0.52
        rg = cairo.RadialGradient(stage_cx, stage_cy, 2.0, stage_cx, stage_cy, max(12.0, glow_r))
        rg.add_color_stop_rgba(0.0, accent[0], accent[1], accent[2], 0.24)
        rg.add_color_stop_rgba(1.0, accent[0], accent[1], accent[2], 0.0)
        ctx.save()
        ctx.set_source(rg)
        ctx.new_path()
        ctx.arc(stage_cx, stage_cy, max(12.0, glow_r), 0.0, math.pi * 2.0)
        ctx.fill()
        ctx.restore()

        surf = self._get_ninebot_scooter_surface(image_path, mtime_ns)
        if surf is not None:
            iw = float(surf.get_width())
            ih = float(surf.get_height())
            scale = min((sw - 14.0) / max(1.0, iw), (stage_h - 6.0) / max(1.0, ih))
            dw = iw * scale
            dh = ih * scale
            dx = sx + (sw - dw) * 0.5
            dy = sy + (stage_h - dh) * 0.5
            ctx.save()
            ctx.translate(dx, dy)
            ctx.scale(scale, scale)
            ctx.set_source_surface(surf, 0.0, 0.0)
            ctx.paint()
            ctx.restore()
        else:
            _draw_scooter_silhouette_cairo(ctx, stage_cx, stage_cy, sw - 20.0, stage_h - 8.0, accent)

        if footer_text:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(12.5)
            txt = _fit_single_line_cairo(ctx, footer_text, sw - 16.0)
            tw = ctx.text_extents(txt).x_advance
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.move_to(sx + (sw - tw) * 0.5, sy + sh - 7.0)
            ctx.show_text(txt)

    def _card_ninebot(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        ok = bool(d.get("ok"))
        batt = d.get("battery")
        batt_val = int(batt) if batt is not None else None
        charging = bool(d.get("charging"))
        power_on = bool(d.get("powerOn"))
        locked = d.get("locked")
        is_low = batt_val is not None and batt_val <= 20 and not charging

        badge_icon: Optional[str] = None
        if not ok:
            accent = COL_AMBER
            border = COL_AMBER_DIM
            dot = COL_AMBER_DIM
            badge = "待绑定"
        elif charging:
            accent = COL_NB_LIME
            border = COL_NB_LIME
            dot = COL_NB_LIME
            pw_w = d.get("chargingPowerW")
            badge = f"{pw_w}W 快充" if pw_w else "充电中"
            badge_icon = "bolt"
        elif locked is False:
            accent = COL_RED
            border = COL_RED
            dot = COL_RED
            badge = "未上锁"
            badge_icon = "unlock"
        elif power_on:
            accent = COL_AMBER_BRIGHT
            border = COL_AMBER_BRIGHT
            dot = COL_AMBER_BRIGHT
            badge = "电门开启"
            badge_icon = "bolt"
        else:
            badge_icon = "lock" if locked is True else None
            upd = str(d.get("updatedHm") or "")
            if is_low:
                accent = COL_RED
                border = COL_RED
                dot = COL_RED
                badge = "已上锁 · 低电" if locked is True else "低电量提醒"
            else:
                accent = COL_NB_LIME if (batt_val is None or batt_val >= 35) else COL_AMBER_BRIGHT
                border = COL_NB_LIME if (batt_val is None or batt_val >= 35) else COL_AMBER_DIM
                dot = accent
                if locked is True:
                    badge = f"已上锁 · {upd}" if upd else "已上锁"
                else:
                    badge = upd or "在线"

        name_str = str(d.get("name") or "九号座驾")
        color_str = str(d.get("color") or "").strip()
        hdr_title = card.title or (f"{name_str} · {color_str}" if color_str else name_str)

        self._draw_card_frame(
            ctx,
            card,
            hdr_title,
            badge,
            border,
            accent,
            dot_col=dot,
            badge_icon=badge_icon,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        if d.get("empty") or not ok:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(19.0)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 18.0, y + 92.0)
            ctx.show_text(_fit_single_line_cairo(ctx, str(d.get("subline") or "请在「九号守护」绑定九号账号"), w - 36.0))
            return

        range_km = d.get("rangeKm")
        range_num = f"{float(range_km):.1f}" if range_km is not None else "--"
        batt_str = f"{batt_val}%" if batt_val is not None else "--%"
        addr_str = _sanitize_hud_text(str(d.get("address") or "暂无定位"))
        spark = d.get("spark") or []
        img_path = str(d.get("imagePath") or "")
        img_mtime = int(d.get("imageMtimeNs") or 0)

        volt_s = f"{float(d['voltageV']):.1f}V" if d.get("voltageV") is not None else ""
        temp_s = f"{float(d['tempC']):.0f}℃" if d.get("tempC") is not None else ""
        bms_text = " · ".join(p for p in (volt_s, temp_s) if p) or "BMS待机"
        aux_s = f"备电 {int(d['auxBattery'])}%" if d.get("auxBattery") is not None else ""
        lock_pill = "充电中" if charging else ("未上锁" if locked is False else ("电门开" if power_on else ("已设防" if locked is True else "待机")))
        lock_col = COL_NB_LIME if (locked is True or charging) else (COL_RED if locked is False else COL_AMBER_BRIGHT)

        odo_s = f"总{d['odometerKm']:.0f}km" if d.get("odometerKm") is not None else ""
        mon_s = f"本月{float(d.get('monthKm') or 0.0):.0f}km" if float(d.get("monthKm") or 0.0) > 0 else ""
        spd_s = f"极速{float(d.get('maxSpeedKmh') or 0.0):.0f}" if float(d.get("maxSpeedKmh") or 0.0) > 0 else ""
        ride_footer = " · ".join(p for p in (mon_s, spd_s) if p) or odo_s

        if card.w_span == 2 and card.h_span == 1:
            left_w = w * 0.54
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(34.0)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 16.0, y + 79.0)
            ctx.show_text(range_num)
            rw = ctx.text_extents(range_num).x_advance

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(14.5)
            ctx.set_source_rgb(*COL_SLATE)
            ctx.move_to(x + 22.0 + rw, y + 79.0)
            ctx.show_text("km 续航")

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(29.0)
            sw_txt = ctx.text_extents(batt_str).x_advance
            ctx.set_source_rgb(*accent)
            ctx.move_to(x + 16.0 + left_w - sw_txt, y + 79.0)
            ctx.show_text(batt_str)

            _draw_segmented_bar_cairo(ctx, x + 16.0, y + 90.0, left_w, 10.0, float(batt_val or 0) / 100.0, accent, segments=16)

            px_cur = x + 16.0
            py_pill = y + 111.0
            pw_used = _draw_pill(ctx, px_cur, py_pill, 23.0, lock_pill, lock_col, font_size=12.5, pad_x=8.5, font_family=self.font_family, text_col=COL_WHITE)
            px_cur += pw_used + 7.0
            pw_used = _draw_pill(ctx, px_cur, py_pill, 23.0, bms_text, COL_SKY, font_size=12.5, pad_x=8.5, font_family=self.font_family, text_col=COL_WHITE)
            px_cur += pw_used + 7.0
            if aux_s and px_cur + 84.0 <= x + 16.0 + left_w:
                _draw_pill(ctx, px_cur, py_pill, 23.0, aux_s, COL_EMERALD, font_size=12.5, pad_x=8.0, font_family=self.font_family, text_col=COL_WHITE)

            _cairo_pin_glyph(ctx, x + 16.0, y + h - 30.0, 14.5, COL_AMBER_BRIGHT)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(14.5)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 31.0, y + h - 16.5)
            ctx.show_text(_fit_single_line_cairo(ctx, addr_str, left_w - 15.0))

            self._draw_ninebot_showroom_cairo(
                ctx,
                x + w * 0.585,
                y + 49.0,
                w * 0.39,
                h - 60.0,
                accent,
                img_path,
                img_mtime,
                ride_footer,
            )
            return

        if card.w_span == 1 and card.h_span == 1:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(31.0)
            ctx.set_source_rgb(*accent)
            ctx.move_to(x + 16.0, y + 79.0)
            ctx.show_text(batt_str)
            bw = ctx.text_extents(batt_str).x_advance

            ctx.set_font_size(16.5)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 24.0 + bw, y + 79.0)
            ctx.show_text(f"续航 {range_num}km")

            _draw_segmented_bar_cairo(ctx, x + 16.0, y + 90.0, w - 32.0, 9.5, float(batt_val or 0) / 100.0, accent, segments=12)

            px_cur = x + 16.0
            pw_used = _draw_pill(ctx, px_cur, y + 111.0, 23.0, lock_pill, lock_col, font_size=12.5, pad_x=8.5, font_family=self.font_family, text_col=COL_WHITE)
            px_cur += pw_used + 7.0
            if px_cur + 80.0 < x + w - 14.0:
                _draw_pill(ctx, px_cur, y + 111.0, 23.0, bms_text, COL_SKY, font_size=12.5, pad_x=8.5, font_family=self.font_family, text_col=COL_WHITE)

            _cairo_pin_glyph(ctx, x + 16.0, y + h - 30.0, 14.0, COL_AMBER_BRIGHT)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(14.0)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 30.0, y + h - 16.5)
            ctx.show_text(_fit_single_line_cairo(ctx, addr_str, w - 46.0))
            return

        if card.w_span == 2 and card.h_span == 2:
            left_w = w * 0.51
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(36.0)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 16.0, y + 84.0)
            ctx.show_text(range_num)
            rw = ctx.text_extents(range_num).x_advance

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(15.0)
            ctx.set_source_rgb(*COL_SLATE)
            ctx.move_to(x + 22.0 + rw, y + 84.0)
            ctx.show_text("km 续航")

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(30.0)
            sw_txt = ctx.text_extents(batt_str).x_advance
            ctx.set_source_rgb(*accent)
            ctx.move_to(x + 16.0 + left_w - sw_txt, y + 84.0)
            ctx.show_text(batt_str)

            _draw_segmented_bar_cairo(ctx, x + 16.0, y + 96.0, left_w, 10.5, float(batt_val or 0) / 100.0, accent, segments=16)

            px_cur = x + 16.0
            py_pill = y + 118.0
            pw_used = _draw_pill(ctx, px_cur, py_pill, 24.0, lock_pill, lock_col, font_size=13.0, pad_x=9.0, font_family=self.font_family, text_col=COL_WHITE)
            px_cur += pw_used + 8.0
            pw_used = _draw_pill(ctx, px_cur, py_pill, 24.0, bms_text, COL_SKY, font_size=13.0, pad_x=9.0, font_family=self.font_family, text_col=COL_WHITE)
            px_cur += pw_used + 8.0
            if aux_s and px_cur + 84.0 <= x + 16.0 + left_w:
                _draw_pill(ctx, px_cur, py_pill, 24.0, aux_s, COL_EMERALD, font_size=13.0, pad_x=8.5, font_family=self.font_family, text_col=COL_WHITE)

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(13.5)
            ctx.set_source_rgb(*COL_SLATE)
            ctx.move_to(x + 16.0, y + 164.0)
            ctx.show_text("电量变化趋势")
            _draw_sparkline_cairo(ctx, x + 16.0, y + 174.0, left_w, h - 190.0, spark, accent)

            self._draw_ninebot_showroom_cairo(
                ctx,
                x + w * 0.555,
                y + 50.0,
                w * 0.42,
                162.0,
                accent,
                img_path,
                img_mtime,
                "",
            )

            rows = [
                ("总里程", f"{d['odometerKm']:.1f} 公里" if d.get("odometerKm") is not None else "--"),
                ("本月骑行", f"{float(d.get('monthKm') or 0.0):.1f} 公里"),
                ("最高极速", f"{float(d.get('maxSpeedKmh') or 0.0):.1f} km/h" if float(d.get("maxSpeedKmh") or 0) > 0 else "--"),
                ("停放位置", addr_str),
            ]
            ry = y + 244.0
            rx = x + w * 0.555
            rw_col = w * 0.42
            pitch = (y + h - 18.0 - ry) / float(max(1, len(rows) - 1)) if len(rows) > 1 else 44.0
            pitch = min(46.0, max(36.0, pitch))
            for idx, (lbl, val) in enumerate(rows):
                if idx > 0:
                    ctx.new_path()
                    ctx.move_to(rx, ry - 22.0)
                    ctx.line_to(rx + rw_col, ry - 22.0)
                    ctx.set_source_rgba(COL_AMBER_DARK_LINE[0], COL_AMBER_DARK_LINE[1], COL_AMBER_DARK_LINE[2], 0.45)
                    ctx.set_line_width(1.0)
                    ctx.stroke()
                ctx.set_font_size(14.5)
                ctx.set_source_rgb(*COL_AMBER)
                ctx.move_to(rx, ry)
                ctx.show_text(lbl)
                ctx.set_source_rgb(*COL_WHITE)
                vs = _fit_single_line_cairo(ctx, val, rw_col - 82.0)
                vw = ctx.text_extents(vs).x_advance
                ctx.move_to(rx + rw_col - vw, ry)
                ctx.show_text(vs)
                ry += pitch
            return

        # 1x2 vertical cockpit
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(31.0)
        ctx.set_source_rgb(*accent)
        ctx.move_to(x + 16.0, y + 79.0)
        ctx.show_text(batt_str)
        bw = ctx.text_extents(batt_str).x_advance
        ctx.set_font_size(16.5)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 24.0 + bw, y + 79.0)
        ctx.show_text(f"续航 {range_num}km")

        _draw_segmented_bar_cairo(ctx, x + 16.0, y + 90.0, w - 32.0, 9.5, float(batt_val or 0) / 100.0, accent, segments=12)

        px_cur = x + 16.0
        pw_used = _draw_pill(ctx, px_cur, y + 109.0, 22.0, lock_pill, lock_col, font_size=12.0, pad_x=8.0, font_family=self.font_family, text_col=COL_WHITE)
        px_cur += pw_used + 6.0
        _draw_pill(ctx, px_cur, y + 109.0, 22.0, bms_text, COL_SKY, font_size=12.0, pad_x=8.0, font_family=self.font_family, text_col=COL_WHITE)

        stage_h = 114.0 if h < 450 else 136.0
        self._draw_ninebot_showroom_cairo(
            ctx,
            x + 16.0,
            y + 140.0,
            w - 32.0,
            stage_h,
            accent,
            img_path,
            img_mtime,
            ride_footer,
        )

        rows = [
            ("总里程", f"{d['odometerKm']:.1f} 公里" if d.get("odometerKm") is not None else "--"),
            ("本月骑行", f"{float(d.get('monthKm') or 0.0):.1f} 公里"),
            ("最高极速", f"{float(d.get('maxSpeedKmh') or 0.0):.1f} km/h" if float(d.get("maxSpeedKmh") or 0) > 0 else "--"),
            ("停放位置", addr_str),
        ]
        ry = y + 140.0 + stage_h + 26.0
        pitch = 34.0 if h < 450 else 38.0
        for lbl, val in rows:
            if ry + 10.0 > y + h - 8.0:
                break
            ctx.set_font_size(14.5)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 16.0, ry)
            ctx.show_text(lbl)
            ctx.set_source_rgb(*COL_WHITE)
            vs = _fit_single_line_cairo(ctx, val, w - 116.0)
            vw = ctx.text_extents(vs).x_advance
            ctx.move_to(x + w - 16.0 - vw, ry)
            ctx.show_text(vs)
            ry += pitch

    def _card_laifen(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        ok = bool(d.get("ok"))
        watching = bool(d.get("watching"))
        today = int(d.get("todayCount") or 0)
        goal = max(1, int(d.get("dailyGoal") or 2))
        batt = d.get("battery")
        batt_val = int(batt) if batt is not None else None

        if not ok or d.get("empty"):
            badge = "待同步"
            accent = COL_AMBER
            border = COL_AMBER_DIM
            dot = COL_AMBER_DIM
        elif watching:
            badge = "刷牙中"
            accent = COL_EMERALD
            border = COL_EMERALD
            dot = COL_EMERALD
        elif batt_val is not None and batt_val <= 15:
            badge = f"今日 {today}/{goal}"
            accent = COL_RED
            border = COL_RED
            dot = COL_RED
        else:
            badge = "今日达标" if today >= goal else f"今日 {today}/{goal}"
            accent = COL_EMERALD if today >= goal else COL_AMBER_BRIGHT
            border = COL_EMERALD if today >= goal else COL_AMBER_DIM
            dot = accent

        self._draw_card_frame(
            ctx,
            card,
            card.title or str(d.get("name") or "口腔护理"),
            badge,
            border,
            accent,
            dot_col=dot,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        if d.get("empty") or not ok:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(19.0)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 18.0, y + 92.0)
            ctx.show_text(_fit_single_line_cairo(ctx, str(d.get("subline") or "唤醒牙刷靠近主机即可同步"), w - 36.0))
            return

        left_w = (w * 0.45) if card.w_span == 2 else (w - 32.0)
        batt_str = f"{batt_val}%" if batt_val is not None else "--%"
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(32.0 if card.w_span == 2 else 28.0)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 16.0, y + 80.0)
        ctx.show_text(batt_str)
        bw = ctx.text_extents(batt_str).x_advance

        mode_lbl = str(d.get("modeLabel") or "日常清洁")
        _draw_pill(
            ctx,
            x + 24.0 + bw,
            y + 56.0,
            25.0,
            _fit_single_line_cairo(ctx, mode_lbl, max(60.0, left_w - bw - 12.0)),
            accent,
            font_size=13.0,
            pad_x=9.0,
            font_family=self.font_family,
        )

        # Battery bar
        batt_col = COL_RED if (batt_val is not None and batt_val <= 15) else (COL_EMERALD if (batt_val or 0) >= 35 else COL_AMBER_BRIGHT)
        _draw_progress_bar(ctx, x + 16.0, y + 92.0, left_w, 7.0, float(batt_val or 0) / 100.0, batt_col)

        # Today check-in dots & streak
        dot_row_y = y + (116.0 if h >= 220 else 112.0)
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        ctx.set_font_size(14.5)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 16.0, dot_row_y + 11.0)
        ctx.show_text(f"打卡 {today}/{goal}")
        dot_x0 = x + 94.0
        for idx in range(min(4, goal)):
            ctx.new_path()
            ctx.arc(dot_x0 + idx * 17.0, dot_row_y + 6.0, 5.2, 0.0, math.pi * 2.0)
            if idx < today:
                ctx.set_source_rgb(*COL_EMERALD)
                ctx.fill()
            else:
                ctx.set_source_rgb(*COL_AMBER_DIM)
                ctx.set_line_width(1.4)
                ctx.stroke()

        streak = int(d.get("streakDays") or 0)
        streak_str = f"连续 {streak} 天" if streak > 0 else "今日待完成"
        ctx.set_font_size(14.0)
        sw = ctx.text_extents(streak_str).x_advance
        ctx.set_source_rgb(*(COL_AMBER_BRIGHT if streak > 0 else COL_AMBER))
        ctx.move_to(x + 16.0 + left_w - sw, dot_row_y + 11.0)
        ctx.show_text(streak_str)

        # Brush-head remaining life bar
        days_left = d.get("brushDaysLeft")
        brush_pct = d.get("brushPct")
        if brush_pct is None and days_left is not None:
            brush_pct = clamp((float(days_left) / 90.0) * 100.0, 0.0, 100.0)
        bp = float(brush_pct or 0.0)
        brush_y = y + (152.0 if h >= 220 else 142.0)
        brush_lbl = f"余 {int(days_left)} 天" if days_left is not None else f"{bp:.0f}%"
        brush_col = COL_EMERALD if bp > 25.0 else COL_RED
        self._draw_bar_row(ctx, x + 16.0, brush_y, left_w, "刷头寿命", brush_lbl, bp / 100.0, brush_col)

        week_counts = list(d.get("weekCounts") or [])
        strength = d.get("strength")
        rng = d.get("range")
        spd = d.get("speed")
        dur_s = d.get("durationSec")

        if card.w_span == 2 and card.h_span == 1:
            rx = x + w * 0.52
            rw = w * 0.44
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(14.5)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.move_to(rx, y + 66.0)
            ctx.show_text("近 7 日刷牙记录")
            if dur_s:
                ds = f"目标 {int(dur_s)}秒"
                dsw = ctx.text_extents(ds).x_advance
                ctx.set_source_rgb(*COL_AMBER)
                ctx.move_to(rx + rw - dsw, y + 66.0)
                ctx.show_text(ds)
            _cairo_bar_chart(ctx, rx, y + 76.0, rw, h - 114.0, week_counts, COL_EMERALD, goal=goal, font_family=self.font_family)
            spec_parts = []
            if strength is not None:
                spec_parts.append(f"力度 {int(strength)}")
            if rng is not None:
                spec_parts.append(f"摆幅 {int(rng)}")
            if spd is not None:
                spec_parts.append(f"摆速 {int(spd)}")
            if spec_parts:
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                ctx.set_font_size(13.5)
                ctx.set_source_rgb(*COL_AMBER)
                ctx.move_to(rx, y + h - 12.0)
                ctx.show_text(_fit_single_line_cairo(ctx, " · ".join(spec_parts), rw))
        elif card.h_span == 2:
            if card.w_span == 2:
                # Right half: 7-day bar chart + summary; Left bottom: oscillation specs
                rx = x + w * 0.52
                rw = w * 0.44
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
                ctx.set_font_size(16.0)
                ctx.set_source_rgb(*COL_AMBER_BRIGHT)
                ctx.move_to(rx, y + 68.0)
                ctx.show_text("近 7 日刷牙趋势")
                if dur_s:
                    ds = f"单次 {int(dur_s)}秒"
                    dsw = ctx.text_extents(ds).x_advance
                    ctx.set_source_rgb(*COL_AMBER)
                    ctx.move_to(rx + rw - dsw, y + 68.0)
                    ctx.show_text(ds)
                _cairo_bar_chart(ctx, rx, y + 84.0, rw, h - 140.0, week_counts, COL_EMERALD, goal=goal, font_family=self.font_family)
                if d.get("updatedHm"):
                    ctx.set_font_size(13.5)
                    ctx.set_source_rgb(*COL_AMBER)
                    ctx.move_to(rx, y + h - 18.0)
                    ctx.show_text(f"最近同步 {d['updatedHm']}")
                spec_y = brush_y + 58.0
                spec_w = left_w
            else:
                # 1x2: 7-day bar chart in middle, oscillation specs below
                chart_y = brush_y + 52.0
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
                ctx.set_font_size(14.5)
                ctx.set_source_rgb(*COL_AMBER_BRIGHT)
                ctx.move_to(x + 16.0, chart_y)
                ctx.show_text("近 7 日刷牙记录")
                chart_h = 92.0 if h < 450 else 108.0
                _cairo_bar_chart(ctx, x + 16.0, chart_y + 8.0, w - 32.0, chart_h, week_counts, COL_EMERALD, goal=goal, font_family=self.font_family)
                spec_y = chart_y + chart_h + 24.0
                spec_w = w - 32.0

            specs = [
                ("振动力度", f"{int(strength or 0)} 档", float(strength or 0) / 20.0, COL_EMERALD),
                ("扫振摆幅", f"{int(rng or 0)} 档", float(rng or 0) / 10.0, COL_AMBER_BRIGHT),
                ("扫振摆速", f"{int(spd or 0)} 档", float(spd or 0) / 10.0, COL_SKY),
            ]
            pitch = 38.0 if h < 450 else 44.0
            for lbl, val, ratio, scol in specs:
                if spec_y + 30.0 > y + h - 8.0:
                    break
                if strength is None and rng is None and spd is None:
                    break
                self._draw_bar_row(ctx, x + 16.0, spec_y, spec_w, lbl, val, ratio, scol)
                spec_y += pitch

    def _card_netlea(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        ok = bool(d.get("ok"))
        on = d.get("on")
        if not ok or d.get("empty") or on is None:
            badge = "待同步"
            accent = COL_AMBER
            border = COL_AMBER_DIM
            dot = COL_AMBER_DIM
        elif on:
            badge = "照明开启"
            accent = COL_EMERALD
            border = COL_EMERALD
            dot = COL_EMERALD
        else:
            badge = "已关闭"
            accent = COL_AMBER
            border = COL_AMBER_DIM
            dot = COL_AMBER_DIM

        self._draw_card_frame(
            ctx,
            card,
            card.title or str(d.get("name") or "生态水草灯"),
            badge,
            border,
            accent,
            dot_col=dot,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        if d.get("empty") or not ok:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(19.0)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 18.0, y + 92.0)
            ctx.show_text(_fit_single_line_cairo(ctx, str(d.get("subline") or "靠近水草灯蓝牙即可同步光谱"), w - 36.0))
            return

        bri = d.get("brightness")
        bri_str = f"{int(bri)}%" if bri is not None else ("开启" if on else "关闭")
        mode_lbl = str(d.get("modeLabel") or "自动行程")
        fan_lv = int(d.get("fan") or 0)
        channels = [
            ("红", int(d.get("red") or 0), COL_RED),
            ("绿", int(d.get("green") or 0), COL_EMERALD),
            ("白", int(d.get("white") or 0), COL_WHITE),
            ("蓝", int(d.get("blue") or 0), COL_SKY),
        ]

        def draw_spectrum_bars(bx: float, by0: float, bw: float, pitch: float, bar_h: float, full_label: bool) -> None:
            lbl_w = 66.0 if full_label else 24.0
            pct_w = 46.0
            track_x = bx + lbl_w
            track_w = max(48.0, bw - lbl_w - pct_w)
            for idx, (ch_lbl, ch_val, ch_col) in enumerate(channels):
                cy = by0 + idx * pitch
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
                ctx.set_font_size(14.0 if pitch < 28.0 else 15.0)
                ctx.set_source_rgb(*ch_col)
                ctx.move_to(bx, cy + 12.0)
                ctx.show_text(f"{ch_lbl}光通道" if full_label else ch_lbl)
                _draw_progress_bar(ctx, track_x, cy + (12.0 - bar_h) * 0.5 + 2.0, track_w, bar_h, ch_val / 100.0, ch_col, track_col=(0.28, 0.28, 0.30))
                vs = f"{ch_val}%"
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
                vw = ctx.text_extents(vs).x_advance
                ctx.set_source_rgb(*(COL_WHITE if on else COL_AMBER_DIM))
                ctx.move_to(bx + bw - vw, cy + 12.0)
                ctx.show_text(vs)

        if card.w_span == 2 and card.h_span == 1:
            # Left hero brightness + mode + fan; right 4-channel RGBW bars
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(36.0)
            ctx.set_source_rgb(*(COL_WHITE if on else COL_AMBER))
            ctx.move_to(x + 16.0, y + 90.0)
            ctx.show_text(bri_str)
            _draw_pill(ctx, x + 16.0, y + 110.0, 26.0, mode_lbl, accent, font_size=13.5, pad_x=10.0, font_family=self.font_family)
            fan_s = f"散热 {fan_lv} 档" if fan_lv > 0 else "静音散热"
            upd_s = f" · {d['updatedHm']}" if d.get("updatedHm") else ""
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(14.5)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 16.0, y + h - 18.0)
            ctx.show_text(_fit_single_line_cairo(ctx, f"{fan_s}{upd_s}", w * 0.35))
            pitch = (h - 68.0) / 4.0
            draw_spectrum_bars(x + w * 0.39, y + 56.0, w * 0.57, pitch, 10.0, True)
        elif card.w_span == 1 and card.h_span == 1:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(28.0)
            ctx.set_source_rgb(*(COL_WHITE if on else COL_AMBER))
            ctx.move_to(x + 16.0, y + 76.0)
            ctx.show_text(bri_str)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(13.0)
            mw = ctx.text_extents(mode_lbl).x_advance + 18.0
            _draw_pill(ctx, x + w - 16.0 - mw, y + 52.0, 24.0, mode_lbl, accent, font_size=13.0, pad_x=9.0, font_family=self.font_family)
            pitch = 24.0 if h < 220 else 29.0
            draw_spectrum_bars(x + 16.0, y + 92.0, w - 32.0, pitch, 8.5, False)
        else:
            # 1x2 or 2x2
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(36.0 if card.w_span == 2 else 32.0)
            ctx.set_source_rgb(*(COL_WHITE if on else COL_AMBER))
            ctx.move_to(x + 16.0, y + 84.0)
            ctx.show_text(bri_str)
            bw = ctx.text_extents(bri_str).x_advance
            pw = _draw_pill(ctx, x + 26.0 + bw, y + 58.0, 26.0, mode_lbl, accent, font_size=13.5, pad_x=10.0, font_family=self.font_family)
            fan_s = f"散热 {fan_lv} 档" if fan_lv > 0 else "静音待机"
            if card.w_span == 2:
                _draw_pill(ctx, x + 34.0 + bw + pw, y + 58.0, 26.0, fan_s, COL_SKY, font_size=13.5, pad_x=10.0, font_family=self.font_family)
            pitch = (h - 140.0) / 4.0
            draw_spectrum_bars(x + 16.0, y + 112.0, w - 32.0, min(68.0, pitch), 12.0 if card.w_span == 2 else 10.0, card.w_span == 2)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(14.5)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 16.0, y + h - 16.0)
            upd = f" · 更新于 {d['updatedHm']}" if d.get("updatedHm") else ""
            ctx.show_text(_fit_single_line_cairo(ctx, f"{fan_s}{upd}", w - 32.0))

    def _card_apple_devices(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        ok = bool(d.get("ok"))
        auth_state = str(d.get("authState") or "")
        online_cnt = int(d.get("online") or 0)
        total_cnt = int(d.get("total") or 0)
        low_cnt = int(d.get("lowCount") or 0)
        devices = list(d.get("devices") or [])

        if not ok or d.get("empty"):
            badge = {
                "unauthenticated": "待登录",
                "pending_2fa": "待验证",
                "expired": "已过期",
            }.get(auth_state, "待同步")
            accent = COL_AMBER
            border = COL_AMBER_DIM
            dot = COL_AMBER_DIM
        elif low_cnt > 0:
            badge = "低电量预警"
            accent = COL_RED
            border = COL_RED
            dot = COL_RED
        else:
            badge = f"{online_cnt}台在线"
            accent = COL_EMERALD
            border = COL_EMERALD if online_cnt > 0 else COL_AMBER_DIM
            dot = COL_EMERALD if online_cnt > 0 else COL_AMBER_DIM

        self._draw_card_frame(
            ctx,
            card,
            card.title or "苹果设备",
            badge,
            border,
            accent,
            dot_col=dot,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        if d.get("empty") or not ok or not devices:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(19.0)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 18.0, y + 92.0)
            ctx.show_text(_fit_single_line_cairo(ctx, str(d.get("subline") or "请在「苹果设备」完成登录同步"), w - 36.0))
            return

        def draw_device_row(rx: float, ry: float, rw: float, rh: float, dev: Dict[str, Any], capsule: bool) -> None:
            bat = dev.get("battery")
            bat_val = int(bat) if bat is not None else None
            charging = bool(dev.get("charging"))
            dev_online = bool(dev.get("online"))
            cat = str(dev.get("catLabel") or "设备")[:4]
            name = str(dev.get("name") or "设备")
            place = str(dev.get("place") or ("在线" if dev_online else "离线"))
            if bat_val is not None and bat_val <= 20 and not charging:
                b_col = COL_RED
            elif charging or (bat_val is not None and bat_val >= 50):
                b_col = COL_EMERALD
            else:
                b_col = COL_AMBER_BRIGHT

            if capsule:
                _cairo_rounded_rect(ctx, rx, ry, rw, rh, 10.0)
                ctx.set_source_rgba(b_col[0], b_col[1], b_col[2], 0.08 if dev_online else 0.03)
                ctx.fill_preserve()
                ctx.set_source_rgb(*(COL_AMBER_DIM if dev_online else COL_AMBER_DARK_LINE))
                ctx.set_line_width(1.2)
                ctx.stroke()

            pad = 10.0 if capsule else 0.0
            ix = rx + pad
            iw = rw - pad * 2.0
            top_y = ry + (8.0 if capsule else 2.0)

            cat_w = _draw_pill(
                ctx,
                ix,
                top_y,
                20.0,
                cat,
                COL_AMBER_BRIGHT if dev_online else COL_AMBER_DIM,
                font_size=11.5,
                pad_x=7.0,
                font_family=self.font_family,
            )

            bat_str = f"{bat_val}%" if bat_val is not None else "--"
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(15.0)
            bat_w = ctx.text_extents(bat_str).x_advance
            ctx.set_source_rgb(*(b_col if dev_online else COL_AMBER_DIM))
            ctx.move_to(ix + iw - bat_w, top_y + 15.0)
            ctx.show_text(bat_str)
            bolt_reserve = 13.0 if charging else 0.0
            if charging:
                ctx.set_source_rgb(*COL_EMERALD)
                _cairo_lightning_bolt(ctx, ix + iw - bat_w - 11.0, top_y + 2.5, 13.0)

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD if dev_online else cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(14.5)
            ctx.set_source_rgb(*(COL_WHITE if dev_online else COL_AMBER_DIM))
            name_max = max(40.0, iw - cat_w - bat_w - bolt_reserve - 14.0)
            ctx.move_to(ix + cat_w + 7.0, top_y + 15.0)
            ctx.show_text(_fit_single_line_cairo(ctx, name, name_max))

            # Bottom mini battery bar + place tag
            bot_y = ry + rh - (14.0 if capsule else 10.0)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(12.0)
            pl_str = _fit_single_line_cairo(ctx, place, iw * 0.44)
            pl_w = ctx.text_extents(pl_str).x_advance
            ctx.set_source_rgb(*(COL_AMBER if dev_online else COL_AMBER_DIM))
            ctx.move_to(ix + iw - pl_w, bot_y + 4.0)
            ctx.show_text(pl_str)

            bar_w = max(40.0, iw - pl_w - 10.0)
            _draw_progress_bar(ctx, ix, bot_y - 2.0, bar_w, 5.0, (float(bat_val or 0) / 100.0) if bat_val is not None else 0.0, b_col)

        if card.w_span == 2 and card.h_span == 1:
            cols = 2
            rows_cnt = 2
            gap = 10.0
            cw = (w - 32.0 - gap) * 0.5
            ch = (h - 60.0 - gap) * 0.5
            for idx, dev in enumerate(devices[: cols * rows_cnt]):
                r = idx // cols
                c = idx % cols
                draw_device_row(x + 16.0 + c * (cw + gap), y + 50.0 + r * (ch + gap), cw, ch, dev, True)
        elif card.w_span == 2 and card.h_span == 2:
            # Summary strip + 2-column grid of up to 8 capsules
            sum_s = f"共 {total_cnt or len(devices)} 台设备 · {online_cnt} 台在线"
            if low_cnt > 0:
                sum_s += f" · {low_cnt} 台低电量"
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(14.5)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.move_to(x + 16.0, y + 66.0)
            ctx.show_text(sum_s)
            if d.get("updatedHm"):
                us = f"同步 {d['updatedHm']}"
                uw = ctx.text_extents(us).x_advance
                ctx.set_source_rgb(*COL_AMBER)
                ctx.move_to(x + w - 16.0 - uw, y + 66.0)
                ctx.show_text(us)
            cols = 2
            max_rows = 4 if h >= 440 else 3
            gap = 10.0
            top_y = y + 80.0
            cw = (w - 32.0 - gap) * 0.5
            ch = min(84.0, (y + h - 12.0 - top_y - gap * (max_rows - 1)) / float(max_rows))
            for idx, dev in enumerate(devices[: cols * max_rows]):
                r = idx // cols
                c = idx % cols
                draw_device_row(x + 16.0 + c * (cw + gap), top_y + r * (ch + gap), cw, ch, dev, True)
        else:
            # 1x1 or 1x2 clean vertical device rows
            row_h = 44.0 if h < 220 else 50.0
            gap = 6.0 if h < 220 else 8.0
            avail_h = h - 58.0
            max_rows = max(2, int((avail_h + gap) // (row_h + gap)))
            for idx, dev in enumerate(devices[:max_rows]):
                ry = y + 48.0 + idx * (row_h + gap)
                if ry + row_h > y + h - 6.0:
                    break
                if idx > 0:
                    ctx.new_path()
                    ctx.move_to(x + 16.0, ry - gap * 0.5)
                    ctx.line_to(x + w - 16.0, ry - gap * 0.5)
                    ctx.set_source_rgba(COL_AMBER_DARK_LINE[0], COL_AMBER_DARK_LINE[1], COL_AMBER_DARK_LINE[2], 0.45)
                    ctx.set_line_width(1.0)
                    ctx.stroke()
                draw_device_row(x + 16.0, ry, w - 32.0, row_h, dev, False)

    def _card_system_pulse(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        cpu = float(d.get("cpuPct") or 0.0)
        mem = float(d.get("memPct") or 0.0)
        disk = float(d.get("diskPct") or 0.0)
        load1 = float(d.get("load1") or 0.0)
        self._draw_card_frame(
            ctx,
            card,
            card.title or "主机脉搏",
            f"负载 {load1:.2f}",
            COL_AMBER_DIM,
            COL_AMBER_BRIGHT,
            dot_col=COL_EMERALD,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        mem_val = f"{mem:.0f}% ({d.get('memUsedGb', 0):.1f}/{d.get('memTotalGb', 0):.1f}G)"
        if card.w_span == 1 and w < 370:
            mem_val = f"{mem:.0f}% ({d.get('memUsedGb', 0):.1f}G)"
        bars = [
            ("处理器", f"{cpu:.0f}%", cpu / 100.0, COL_EMERALD if cpu < 70 else COL_AMBER_BRIGHT),
            ("运行内存", mem_val, mem / 100.0, COL_AMBER_BRIGHT if mem < 82 else COL_RED),
            ("存储空间", f"{disk:.0f}% (余 {d.get('diskFreeGb', 0):.0f}G)", disk / 100.0, COL_AMBER),
        ]
        if card.w_span == 2 and card.h_span == 1:
            col_w = (w - 48.0) * 0.5
            for idx, (lbl, val, ratio, col) in enumerate(bars[:2]):
                bx = x + 16.0 + idx * (col_w + 16.0)
                self._draw_bar_row(ctx, bx, y + 58.0, col_w, lbl, val, ratio, col)
            self._draw_bar_row(ctx, x + 16.0, y + 114.0, col_w, bars[2][0], bars[2][1], bars[2][2], bars[2][3])
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(15.0)
            ctx.set_source_rgb(*COL_WHITE)
            nt = str(d.get("nextTimer") or "定时调度待命中")
            ctx.move_to(x + 32.0 + col_w, y + 144.0)
            ctx.show_text(_fit_single_line_cairo(ctx, f"下一日程 · {nt}", col_w))
        else:
            compact = h < 220
            by = y + (48.0 if compact else 54.0)
            pitch = 38.0 if compact else (54.0 if card.h_span == 2 else 44.0)
            for lbl, val, ratio, col in bars:
                if by + 32.0 > y + h - 22.0:
                    break
                self._draw_bar_row(ctx, x + 16.0, by, w - 32.0, lbl, val, ratio, col)
                by += pitch
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(14.0 if compact else 15.0)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.move_to(x + 16.0, y + h - 14.0)
            nt = str(d.get("nextTimer") or f"已运行 {d.get('uptimeH', 0):.0f} 小时 · 定时 {d.get('timerCount', 0)}")
            ctx.show_text(_fit_single_line_cairo(ctx, nt, w - 32.0))

    def _draw_bar_row(
        self,
        ctx,
        x: float,
        y: float,
        w: float,
        label: str,
        value: str,
        ratio: float,
        col: Tuple[float, float, float],
    ) -> None:
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        ctx.set_font_size(14.5)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x, y + 13.0)
        ctx.show_text(label)
        vw = ctx.text_extents(value).x_advance
        ctx.set_source_rgb(*COL_AMBER_BRIGHT)
        ctx.move_to(x + w - vw, y + 13.0)
        ctx.show_text(value)
        _draw_progress_bar(ctx, x, y + 20.0, w, 8.0, ratio, col)

    def _card_tv_agent(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        online = bool(d.get("online"))
        accent = COL_EMERALD if online else COL_AMBER
        self._draw_card_frame(
            ctx,
            card,
            card.title or "客厅电视",
            "播放中" if online else "待机",
            COL_EMERALD if online else COL_AMBER_DIM,
            accent,
            dot_col=COL_EMERALD if online else COL_AMBER_DIM,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        app_raw = str(d.get("appName") or "").strip()
        app_name = app_raw or ("智能电视在线" if online else "息屏待机")
        vol = d.get("volume")
        muted = bool(d.get("muted"))
        vol_pct = clamp(float(vol) / 100.0, 0.0, 1.0) if vol is not None else 0.0
        vol_lbl = "已静音" if muted else (f"音量 {int(vol)}%" if vol is not None else ("音量待同步" if online else "待机休眠"))

        if card.w_span == 2 and card.h_span == 1:
            mid_y = y + 40.0 + (h - 40.0) * 0.5
            _cairo_tv_glyph(ctx, x + 20.0, mid_y - 24.0, 64.0, 48.0, online=online, col=accent)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(27.0)
            ctx.set_source_rgb(*(COL_WHITE if online else COL_AMBER))
            ctx.move_to(x + 98.0, mid_y - 2.0)
            ctx.show_text(_fit_single_line_cairo(ctx, app_name, w * 0.48 - 98.0))
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(15.0)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.move_to(x + 98.0, mid_y + 24.0)
            ctx.show_text("支持语音点播 · 无线投屏" if online else "随时可语音唤醒开机")

            rx = x + w * 0.54
            rw = w * 0.42
            self._draw_bar_row(ctx, rx, mid_y - 26.0, rw, "电视音量", vol_lbl, 0.0 if muted else vol_pct, COL_AMBER_DIM if muted else accent)
            cap = "大屏控制与投屏通道就绪" if (d.get("agentOk") or d.get("dlnaOk")) else "等待连接电视端服务"
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(14.5)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(rx, mid_y + 34.0)
            ctx.show_text(_fit_single_line_cairo(ctx, cap, rw))
        elif card.h_span == 2:
            glyph_w = 88.0 if card.w_span == 2 else 74.0
            glyph_h = 66.0 if card.w_span == 2 else 56.0
            _cairo_tv_glyph(ctx, x + (w - glyph_w) * 0.5, y + 68.0, glyph_w, glyph_h, online=online, col=accent)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(28.0)
            app_s = _fit_single_line_cairo(ctx, app_name, w - 32.0)
            aw = ctx.text_extents(app_s).x_advance
            ctx.set_source_rgb(*(COL_WHITE if online else COL_AMBER))
            ctx.move_to(x + (w - aw) * 0.5, y + 174.0)
            ctx.show_text(app_s)
            self._draw_bar_row(ctx, x + 20.0, y + 216.0, w - 40.0, "媒体音量", vol_lbl, 0.0 if muted else vol_pct, COL_AMBER_DIM if muted else accent)
            sub_s = "语音遥控与投屏协同已连接" if (d.get("agentOk") or d.get("dlnaOk")) else "息屏待机中，可语音或按键唤醒"
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(15.5)
            ctx.set_source_rgb(*COL_AMBER)
            sw = ctx.text_extents(sub_s).x_advance
            ctx.move_to(x + max(16.0, (w - sw) * 0.5), y + 292.0)
            ctx.show_text(_fit_single_line_cairo(ctx, sub_s, w - 32.0))
        else:
            _cairo_tv_glyph(ctx, x + 16.0, y + 58.0, 48.0, 38.0, online=online, col=accent)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(23.5)
            ctx.set_source_rgb(*(COL_WHITE if online else COL_AMBER))
            ctx.move_to(x + 76.0, y + 80.0)
            ctx.show_text(_fit_single_line_cairo(ctx, app_name, w - 92.0))
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(14.0)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.move_to(x + 76.0, y + 102.0)
            ctx.show_text("无线投屏 · 语音控制" if online else "电视当前处于待机状态")
            bar_y = y + (132.0 if h < 220 else 148.0)
            self._draw_bar_row(ctx, x + 16.0, bar_y, w - 32.0, "电视音量", vol_lbl, 0.0 if muted else vol_pct, COL_AMBER_DIM if muted else accent)

    def _card_tv_ir(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        tx_ok = bool(d.get("txReady"))
        accent = COL_EMERALD if tx_ok else COL_AMBER
        self._draw_card_frame(
            ctx,
            card,
            card.title or "电视遥控",
            "红外就绪" if tx_ok else "待连接",
            COL_EMERALD if tx_ok else COL_AMBER_DIM,
            accent,
            dot_col=COL_EMERALD if tx_ok else COL_AMBER,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        learned_cnt = int(d.get("learnedCount") or 0)
        head_raw = _sanitize_hud_text(str(d.get("headline") or "")).replace("LX06", "").strip()
        headline = head_raw or ("全向红外就绪" if tx_ok else "等待音箱连接")
        caps = ("电源", "音量", "方向导航")

        if card.w_span == 2 and card.h_span == 1:
            _cairo_remote_dpad(ctx, x + 78.0, y + 44.0 + (h - 48.0) * 0.5, 42.0, ready=tx_ok, col=accent)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(25.0)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 150.0, y + 92.0)
            ctx.show_text(_fit_single_line_cairo(ctx, headline, w - 170.0))
            px = x + 150.0
            for c_lbl in caps:
                cw = _draw_pill(ctx, px, y + 114.0, 28.0, c_lbl, accent, font_size=14.0, pad_x=12.0, font_family=self.font_family)
                px += cw + 10.0
            if learned_cnt > 0:
                _draw_pill(ctx, px, y + 114.0, 28.0, f"自学习 {learned_cnt} 键", COL_AMBER_BRIGHT, font_size=14.0, pad_x=12.0, font_family=self.font_family)
        elif card.h_span == 2:
            rad = 56.0 if card.w_span == 2 else 46.0
            _cairo_remote_dpad(ctx, x + w * 0.5, y + 132.0, rad, ready=tx_ok, col=accent)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(24.0)
            hs = _fit_single_line_cairo(ctx, headline, w - 32.0)
            hw = ctx.text_extents(hs).x_advance
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + (w - hw) * 0.5, y + 234.0)
            ctx.show_text(hs)
            tags = list(caps) + ([f"已学 {learned_cnt} 键"] if learned_cnt > 0 else [])
            cx = x + 16.0
            cy = y + 266.0
            for t_lbl in tags:
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
                ctx.set_font_size(14.0)
                est_w = ctx.text_extents(t_lbl).x_advance + 24.0
                if cx + est_w > x + w - 16.0:
                    cx = x + 16.0
                    cy += 38.0
                pw = _draw_pill(ctx, cx, cy, 28.0, t_lbl, accent, font_size=14.0, pad_x=12.0, font_family=self.font_family)
                cx += pw + 10.0
        else:
            # 1x1
            dpad_r = 34.0 if h < 220 else 38.0
            _cairo_remote_dpad(ctx, x + w - 58.0, y + 42.0 + (h - 46.0) * 0.5, dpad_r, ready=tx_ok, col=accent)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(21.5)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 16.0, y + 84.0)
            ctx.show_text(_fit_single_line_cairo(ctx, headline, w - 122.0))
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(14.5)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.move_to(x + 16.0, y + 114.0)
            ctx.show_text("电源 · 音量 · 方向导航")
            if learned_cnt > 0:
                _draw_pill(ctx, x + 16.0, y + (136.0 if h < 220 else 144.0), 25.0, f"自学习 {learned_cnt} 键", COL_AMBER_BRIGHT, font_size=13.0, pad_x=10.0, font_family=self.font_family)

    def _card_memory(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        total = int(d.get("totalActive") or 0)
        edges = list(d.get("edges") or [])
        n_nodes = max(1, min(12, int(d.get("nodeCount") or 6)))
        self._draw_card_frame(
            ctx,
            card,
            card.title or "突触记忆",
            f"{total} 条 · {len(edges)} 关联",
            COL_AMBER_DIM,
            COL_AMBER_BRIGHT,
            dot_col=COL_AMBER_BRIGHT,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(28.0)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 16.0, y + 82.0)
        ctx.show_text(f"{total}")
        tw = ctx.text_extents(f"{total}").x_advance
        ctx.set_font_size(15.5)
        ctx.set_source_rgb(*COL_AMBER)
        ctx.move_to(x + 22.0 + tw, y + 82.0)
        ctx.show_text(f"条 · {d.get('pinnedCount', 0)} 置顶")

        # Draw mini Hebbian constellation in right or lower region
        gx = x + (w * 0.48 if card.w_span == 2 else 16.0)
        gy = y + (50.0 if card.w_span == 2 else 96.0)
        gw = (w * 0.48 if card.w_span == 2 else w - 32.0)
        gh = max(72.0, h - (62.0 if card.w_span == 2 else 108.0))
        cx, cy = gx + gw * 0.5, gy + gh * 0.5
        rad = min(gw, gh) * 0.38
        pts = [
            (
                cx + math.cos(i * 2.0 * math.pi / n_nodes - 0.5) * rad * (0.72 + (i % 3) * 0.14),
                cy + math.sin(i * 2.0 * math.pi / n_nodes - 0.5) * rad * (0.72 + ((i + 1) % 3) * 0.14),
            )
            for i in range(n_nodes)
        ]
        for a, b, wt in edges:
            if a < len(pts) and b < len(pts):
                ctx.new_path()
                ctx.move_to(pts[a][0], pts[a][1])
                ctx.line_to(pts[b][0], pts[b][1])
                ctx.set_source_rgba(COL_AMBER[0], COL_AMBER[1], COL_AMBER[2], clamp(0.35 + wt * 0.5, 0.25, 0.9))
                ctx.set_line_width(1.5)
                ctx.stroke()
        for idx, (px, py) in enumerate(pts):
            if idx < 3:
                ctx.new_path()
                ctx.arc(px, py, 7.2, 0.0, math.pi * 2.0)
                ctx.set_source_rgba(COL_AMBER_BRIGHT[0], COL_AMBER_BRIGHT[1], COL_AMBER_BRIGHT[2], 0.24)
                ctx.fill()
            ctx.new_path()
            ctx.arc(px, py, 4.2 if idx < 3 else 2.8, 0.0, math.pi * 2.0)
            ctx.set_source_rgb(*(COL_AMBER_BRIGHT if idx < 3 else COL_WHITE))
            ctx.fill()

        # Topic list when wide or tall
        if card.w_span == 2 or card.h_span == 2:
            ty = y + 112.0
            for topic in (d.get("topics") or [])[:5]:
                if ty + 18.0 > y + h - 10.0:
                    break
                ctx.new_path()
                ctx.arc(x + 21.0, ty - 5.0, 2.8, 0.0, math.pi * 2.0)
                ctx.set_source_rgb(*COL_AMBER_BRIGHT)
                ctx.fill()
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                ctx.set_font_size(15.5)
                ctx.set_source_rgb(*COL_WHITE)
                ctx.move_to(x + 31.0, ty)
                ctx.show_text(_fit_single_line_cairo(ctx, str(topic), (w * 0.42 if card.w_span == 2 else w - 46.0)))
                ty += 26.0

    def _card_timers(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        self._draw_card_frame(
            ctx,
            card,
            card.title or "日程与巡检",
            f"启用 {d.get('enabled', 0)}/{d.get('total', 0)}",
            COL_AMBER_DIM,
            COL_AMBER_BRIGHT,
            dot_col=COL_EMERALD if (d.get("enabled") or 0) > 0 else COL_AMBER_DIM,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        rows = list(d.get("rows") or [])
        if not rows:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(18.0)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 16.0, y + 92.0)
            ctx.show_text("暂无运行中的日程与巡检")
            return
        ry = y + 58.0
        pitch = 38.0 if (h < 220 or card.h_span == 2) else 44.0
        for row in rows[: (6 if card.h_span == 2 else 3)]:
            if ry + 26.0 > y + h - 8.0:
                break
            hm = str(row.get("nextHm") or "--:--")
            hm_w = _draw_pill(ctx, x + 16.0, ry, 26.0, hm, COL_AMBER_BRIGHT, font_size=14.0, pad_x=8.0, font_family=self.font_family)
            right_reserve = 0.0
            if row.get("goal"):
                gw = _draw_pill(ctx, x + w - 58.0, ry + 2.0, 22.0, "目标", COL_EMERALD, font_size=12.0, pad_x=7.0, font_family=self.font_family)
                right_reserve = gw + 8.0
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(15.5)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 26.0 + hm_w, ry + 18.5)
            ctx.show_text(_fit_single_line_cairo(ctx, str(row.get("name") or ""), max(40.0, w - 42.0 - hm_w - right_reserve)))
            ry += pitch

    def _card_usage(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        calls = int(d.get("calls") or 0)
        cost_cny = float(d.get("costCny") or 0.0)
        tok_str = str(d.get("tokStr") or "0")
        tot_toks = int(d.get("totalTokens") or 0)
        self._draw_card_frame(
            ctx,
            card,
            card.title or "今日算力",
            f"{calls} 次调用",
            COL_AMBER_DIM,
            COL_AMBER_BRIGHT,
            dot_col=COL_AMBER_BRIGHT,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(36.0 if card.w_span == 2 else 32.0)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 16.0, y + 86.0)
        ctx.show_text(f"¥{cost_cny:.2f}")

        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        ctx.set_font_size(16.0)
        ctx.set_source_rgb(*COL_AMBER_BRIGHT)
        ctx.move_to(x + 16.0, y + 116.0)
        ctx.show_text(_fit_single_line_cairo(ctx, f"今日吞吐 {tok_str} · {calls} 次响应", w - 32.0))

        # Visual throughput / budget indicator bar (zero USD or raw Token jargon)
        load_ratio = min(1.0, max(0.05 if (calls > 0 or tot_toks > 0) else 0.0, cost_cny / 20.0 if cost_cny > 0 else tot_toks / 120000.0))
        bar_y = y + (138.0 if h < 220 else 150.0)
        bar_col = COL_EMERALD if load_ratio < 0.65 else (COL_AMBER_BRIGHT if load_ratio < 0.88 else COL_RED)
        self._draw_bar_row(ctx, x + 16.0, bar_y, (w * 0.48 if card.w_span == 2 and card.h_span == 1 else w - 32.0), "算力负荷", f"{tok_str}", load_ratio, bar_col)
        if card.w_span == 2 and card.h_span == 1:
            _draw_pill(ctx, x + w * 0.56, y + 72.0, 28.0, f"累计调用 {calls} 次", COL_EMERALD, font_size=14.5, pad_x=12.0, font_family=self.font_family)
            _draw_pill(ctx, x + w * 0.56, y + 114.0, 28.0, f"吞吐规模 {tok_str}", COL_AMBER_BRIGHT, font_size=14.5, pad_x=12.0, font_family=self.font_family)

    @staticmethod
    def _infer_wcode(d: Dict[str, Any]) -> int:
        if d.get("wcode") is not None:
            try:
                return int(d["wcode"])
            except (TypeError, ValueError):
                pass
        desc = str(d.get("desc") or "")
        if "雷" in desc:
            return 95
        if "雪" in desc:
            return 71
        if "雨" in desc:
            return 61
        if "雾" in desc:
            return 45
        if "阴" in desc:
            return 3
        if "晴" in desc and "云" not in desc:
            return 0
        return 2

    def _card_weather(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        ok = bool(d.get("ok"))
        city = str(d.get("city") or "本地")
        desc = str(d.get("desc") or "--")
        wcode = self._infer_wcode(d)
        self._draw_card_frame(
            ctx,
            card,
            card.title or f"本地气象 · {city}",
            desc,
            COL_AMBER_DIM,
            COL_AMBER_BRIGHT,
            dot_col=COL_EMERALD if ok else COL_AMBER_DIM,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        temp = d.get("temp")
        t_str = f"{float(temp):.0f}°" if temp is not None else "--°"
        feels = d.get("feelsLike")
        tmax = d.get("tempMax")
        tmin = d.get("tempMin")
        hum = d.get("humidity")
        wind_desc = str(d.get("windDesc") or "")
        if not wind_desc and d.get("wind") is not None:
            wv = float(d["wind"])
            wind_desc = "微风" if wv < 6.0 else ("轻风" if wv < 18.0 else ("和风" if wv < 35.0 else "强风"))

        range_part = f"今日 {float(tmin):.0f}°~{float(tmax):.0f}°" if (tmin is not None and tmax is not None) else ""
        feels_part = f"体感 {float(feels):.0f}°" if feels is not None else ""
        line1 = " · ".join(p for p in (feels_part, range_part) if p)
        hum_part = f"湿度 {int(hum)}%" if hum is not None else ""
        line2 = " · ".join(p for p in (hum_part, wind_desc) if p) or str(d.get("subline") or city)

        if card.w_span == 2 and card.h_span == 1:
            _draw_weather_icon_cairo(ctx, x + 64.0, y + 42.0 + (h - 48.0) * 0.5, 34.0, wcode)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(44.0)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 118.0, y + 112.0)
            ctx.show_text(t_str)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(16.0)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.move_to(x + 118.0, y + 144.0)
            ctx.show_text(_fit_single_line_cairo(ctx, f"{city} · {desc}", w * 0.40 - 118.0))

            # Right 2x2 metric tiles
            metrics = [
                ("体感温度", f"{float(feels):.0f}°" if feels is not None else "--"),
                ("今日温差", f"{float(tmin):.0f}~{float(tmax):.0f}°" if (tmin is not None and tmax is not None) else "--"),
                ("相对湿度", f"{int(hum)}%" if hum is not None else "--"),
                ("实时风况", wind_desc or "--"),
            ]
            rx0 = x + w * 0.46
            mw = (w * 0.50 - 12.0) * 0.5
            mh = (h - 68.0 - 10.0) * 0.5
            for idx, (ml, mv) in enumerate(metrics):
                c = idx % 2
                r = idx // 2
                mx = rx0 + c * (mw + 12.0)
                my = y + 54.0 + r * (mh + 10.0)
                _cairo_rounded_rect(ctx, mx, my, mw, mh, 10.0)
                ctx.set_source_rgba(COL_AMBER[0], COL_AMBER[1], COL_AMBER[2], 0.05)
                ctx.fill_preserve()
                ctx.set_source_rgb(*COL_AMBER_DARK_LINE)
                ctx.set_line_width(1.1)
                ctx.stroke()
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                ctx.set_font_size(13.0)
                ctx.set_source_rgb(*COL_AMBER)
                ctx.move_to(mx + 12.0, my + 22.0)
                ctx.show_text(ml)
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
                ctx.set_font_size(17.5)
                ctx.set_source_rgb(*COL_WHITE)
                ctx.move_to(mx + 12.0, my + mh - 12.0)
                ctx.show_text(mv)
        elif card.h_span == 2:
            _draw_weather_icon_cairo(ctx, x + w - 76.0, y + 108.0, 38.0, wcode)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(48.0)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 20.0, y + 114.0)
            ctx.show_text(t_str)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(17.0)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.move_to(x + 20.0, y + 148.0)
            ctx.show_text(_fit_single_line_cairo(ctx, f"{city} · {desc}", w - 148.0))

            rows = [
                ("体感温度", f"{float(feels):.0f}°C" if feels is not None else "--"),
                ("今日高温", f"{float(tmax):.0f}°C" if tmax is not None else "--"),
                ("今日低温", f"{float(tmin):.0f}°C" if tmin is not None else "--"),
                ("相对湿度", f"{int(hum)}%" if hum is not None else "--"),
                ("风力风况", wind_desc or "--"),
            ]
            ry = y + 196.0
            pitch = 42.0 if h < 450 else 50.0
            for idx, (rl, rv) in enumerate(rows):
                if ry + 18.0 > y + h - 10.0:
                    break
                if idx > 0:
                    ctx.new_path()
                    ctx.move_to(x + 20.0, ry - 18.0)
                    ctx.line_to(x + w - 20.0, ry - 18.0)
                    ctx.set_source_rgba(COL_AMBER_DARK_LINE[0], COL_AMBER_DARK_LINE[1], COL_AMBER_DARK_LINE[2], 0.45)
                    ctx.set_line_width(1.0)
                    ctx.stroke()
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                ctx.set_font_size(16.0)
                ctx.set_source_rgb(*COL_AMBER)
                ctx.move_to(x + 20.0, ry)
                ctx.show_text(rl)
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
                rvw = ctx.text_extents(rv).x_advance
                ctx.set_source_rgb(*COL_WHITE)
                ctx.move_to(x + w - 20.0 - rvw, ry)
                ctx.show_text(rv)
                ry += pitch
        else:
            # 1x1
            _draw_weather_icon_cairo(ctx, x + w - 58.0, y + 84.0, 26.0, wcode)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(40.0)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 16.0, y + 98.0)
            ctx.show_text(t_str)

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(15.5)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            y1 = y + (134.0 if h < 220 else 142.0)
            if line1:
                ctx.move_to(x + 16.0, y1)
                ctx.show_text(_fit_single_line_cairo(ctx, line1, w - 32.0))
                y2 = y1 + (28.0 if h < 220 else 32.0)
            else:
                y2 = y1
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 16.0, y2)
            ctx.show_text(_fit_single_line_cairo(ctx, line2, w - 32.0))

    def _card_workers(self, ctx, card: PlacedCard, d: Dict[str, Any], hud: HudState) -> None:
        cnt = len(hud.workers)
        self._draw_card_frame(
            ctx,
            card,
            card.title or "后台任务",
            f"{cnt} 运行中" if cnt else "空闲",
            COL_EMERALD if cnt else COL_AMBER_DIM,
            COL_EMERALD if cnt else COL_AMBER,
            dot_col=COL_EMERALD if cnt else COL_AMBER_DIM,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        if not hud.workers:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(18.0)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 16.0, y + 92.0)
            ctx.show_text("当前暂无后台并发任务")
            return
        ry = y + 58.0
        pitch = 38.0 if (h < 220 or card.h_span == 2) else 42.0
        for wk in hud.workers[: (6 if card.h_span == 2 else 3)]:
            if ry + 26.0 > y + h - 8.0:
                break
            tag_lbl = _localize_profile_tag(wk.profile)
            tag_w = _draw_pill(ctx, x + 16.0, ry, 25.0, tag_lbl, COL_AMBER_BRIGHT, font_size=13.5, pad_x=8.0, font_family=self.font_family)
            es = f"{wk.elapsed_sec}秒"
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(14.5)
            ew = ctx.text_extents(es).x_advance
            ctx.set_source_rgb(*COL_EMERALD)
            ctx.move_to(x + w - 16.0 - ew, ry + 18.0)
            ctx.show_text(es)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(15.5)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 26.0 + tag_w, ry + 18.0)
            ctx.show_text(_fit_single_line_cairo(ctx, wk.prompt, max(40.0, w - 52.0 - tag_w - ew)))
            ry += pitch

    def _card_custom_plugin(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        ok = bool(d.get("ok"))
        title = card.title or str(d.get("title") or card.plugin or card.kind)
        msg = str(d.get("message") or d.get("subline") or "已挂载扩展插件卡片")
        if not d:
            badge = "待命"
            border = COL_AMBER_DIM
            b_col = COL_AMBER
            dot = COL_AMBER_DIM
        elif ok:
            badge = "运行正常"
            border = COL_EMERALD
            b_col = COL_EMERALD
            dot = COL_EMERALD
        elif "等待" in msg or "待命" in str(d.get("headline") or ""):
            badge = "待命"
            border = COL_AMBER_DIM
            b_col = COL_AMBER
            dot = COL_AMBER
        else:
            badge = "连接异常"
            border = COL_AMBER_DIM
            b_col = COL_RED
            dot = COL_RED

        self._draw_card_frame(
            ctx,
            card,
            title,
            badge,
            border,
            b_col,
            dot_col=dot,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        kpis = list(d.get("kpis") or [])

        if kpis:
            # Hero highlight on primary KPI + balanced grid for remaining KPIs
            h_lbl, h_val = kpis[0]
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(13.5)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 16.0, y + 64.0)
            ctx.show_text(_fit_single_line_cairo(ctx, str(h_lbl), w - 32.0))

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(25.0 if card.w_span == 2 else 22.0)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 16.0, y + 92.0)
            ctx.show_text(_fit_single_line_cairo(ctx, str(h_val), w - 32.0))

            rest = kpis[1:]
            if rest:
                cols = 2 if card.w_span == 2 else 1
                ry = y + 114.0
                pitch = 30.0 if (h < 220 or card.h_span == 1) else 36.0
                max_items = 6 if card.h_span == 2 else (4 if card.w_span == 2 else 3)
                for idx, (k_lbl, k_val) in enumerate(rest[:max_items]):
                    c = idx % cols
                    r = idx // cols
                    col_w = (w - 32.0 - 18.0) / float(cols) if cols > 1 else (w - 32.0)
                    kx = x + 16.0 + c * (col_w + 18.0)
                    ky = ry + r * pitch
                    if ky + 12.0 > y + h - 8.0:
                        break
                    ctx.new_path()
                    ctx.move_to(kx, ky - 17.0)
                    ctx.line_to(kx + col_w, ky - 17.0)
                    ctx.set_source_rgba(COL_AMBER_DARK_LINE[0], COL_AMBER_DARK_LINE[1], COL_AMBER_DARK_LINE[2], 0.35)
                    ctx.set_line_width(1.0)
                    ctx.stroke()

                    ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                    ctx.set_font_size(14.5)
                    ctx.set_source_rgb(*COL_AMBER)
                    ctx.move_to(kx, ky)
                    ctx.show_text(_fit_single_line_cairo(ctx, str(k_lbl), col_w * 0.45))
                    ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
                    ctx.set_font_size(15.5)
                    ctx.set_source_rgb(*COL_WHITE)
                    vs = _fit_single_line_cairo(ctx, str(k_val), col_w * 0.52)
                    vw = ctx.text_extents(vs).x_advance
                    ctx.move_to(kx + col_w - vw, ky)
                    ctx.show_text(vs)
        else:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(17.0)
            ctx.set_source_rgb(*COL_WHITE)
            max_l = 4 if card.h_span == 2 else 2
            for idx, line in enumerate(_wrap_text_cairo(ctx, msg, w - 32.0, max_l)):
                ctx.move_to(x + 16.0, y + 74.0 + idx * 28.0)
                ctx.show_text(line)

    def _draw_footer_cairo(self, ctx, hud: HudState) -> None:
        ctx.new_path()
        ctx.set_source_rgb(*COL_AMBER_DARK_LINE)
        ctx.set_line_width(1.0)
        ctx.move_to(36.0, 1214.0)
        ctx.line_to(764.0, 1214.0)
        ctx.stroke()

        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(18.5)
        cx = 38.0
        for label, online in hud.channels:
            ch_label = _localize_channel_label(label)
            ctx.new_path()
            ctx.set_source_rgb(*(COL_EMERALD if online else COL_AMBER_DIM))
            ctx.arc(cx + 6.0, 1244.0, 5.5, 0.0, math.pi * 2.0)
            ctx.fill()
            ctx.set_source_rgb(*(COL_WHITE if online else COL_AMBER_DIM))
            ctx.move_to(cx + 18.0, 1251.0)
            ctx.show_text(ch_label)
            cx += 34.0 + ctx.text_extents(ch_label).x_advance

        spk = "已静音" if hud.speaker_muted else f"音量 {hud.speaker_volume}%"
        if hud.page_count > 1:
            page_lbl = _sanitize_hud_text(hud.page_name or "总览") or "总览"
            right_raw = f"{page_lbl} ({hud.active_page + 1}/{hud.page_count}) · {spk}"
        else:
            right_raw = f"记忆 {hud.memory_count} · {spk}"
        right_max = max(120.0, 764.0 - cx - 14.0)
        right_str = _fit_single_line_cairo(ctx, right_raw, right_max)
        ctx.set_source_rgb(*COL_AMBER)
        ext = ctx.text_extents(right_str)
        ctx.move_to(764.0 - ext.x_advance, 1251.0)
        ctx.show_text(right_str)

    # ---- Pure-stdlib minimal fallback when pycairo is unavailable (e.g., dev/CI) ----
    def _draw_rect_outline_bgra(self, x0: int, y0: int, x1: int, y1: int, px_col: bytes) -> None:
        bgra = self._bgra
        x0 = max(0, min(WIDTH - 1, x0))
        x1 = max(0, min(WIDTH - 1, x1))
        y0 = max(0, min(HEIGHT - 1, y0))
        y1 = max(0, min(HEIGHT - 1, y1))
        if x1 <= x0 or y1 <= y0:
            return
        span = x1 - x0 + 1
        row_bytes = px_col * span
        for y in (y0, y1):
            off = (y * WIDTH + x0) * 4
            bgra[off : off + span * 4] = row_bytes
        for y in range(y0, y1 + 1):
            off_l = (y * WIDTH + x0) * 4
            off_r = (y * WIDTH + x1) * 4
            bgra[off_l : off_l + 4] = px_col
            bgra[off_r : off_r + 4] = px_col

    def _render_fallback_bgra(
        self,
        face: FaceSnapshot,
        hud: HudState,
        *,
        placed_cards: Sequence[PlacedCard],
    ) -> None:
        bgra = self._bgra
        bgra[:] = b"\x00" * (WIDTH * HEIGHT * 4)
        geo = stage_geometry_for_rows(hud.grid_rows)

        # Squircle polygon fill
        poly = face.pose.body_polygon
        if len(poly) >= 3:
            ys = [p[1] for p in poly]
            y_min = max(0, int(math.floor(min(ys))))
            y_max = min(HEIGHT - 1, int(math.ceil(max(ys))))
            amber_px = bytes((0x0A, 0x8B, 0xE8, 0xFF))
            n = len(poly)
            for y in range(y_min, y_max + 1):
                yf = y + 0.5
                xs: List[float] = []
                for i in range(n):
                    x1, y1 = poly[i]
                    x2, y2 = poly[(i + 1) % n]
                    if (y1 <= yf < y2) or (y2 <= yf < y1):
                        xs.append(x1 + (yf - y1) * (x2 - x1) / (y2 - y1))
                xs.sort()
                for k in range(0, len(xs) - 1, 2):
                    x_start = max(0, int(math.ceil(xs[k])))
                    x_end = min(WIDTH - 1, int(math.floor(xs[k + 1])))
                    if x_end >= x_start:
                        row_off = (y * WIDTH + x_start) * 4
                        span = x_end - x_start + 1
                        bgra[row_off : row_off + span * 4] = amber_px * span

        white_px = bytes((0xFF, 0xFF, 0xFF, 0xFF))
        for eye in (face.pose.eye_left, face.pose.eye_right):
            if len(eye.points) < 2 or eye.opacity <= 0.05:
                continue
            rad = max(2.0, eye.stroke_width * 0.5)
            rad2 = rad * rad
            for i in range(len(eye.points) - 1):
                ax, ay = eye.points[i]
                bx, by = eye.points[i + 1]
                x0 = max(0, int(math.floor(min(ax, bx) - rad)))
                x1 = min(WIDTH - 1, int(math.ceil(max(ax, bx) + rad)))
                y0 = max(0, int(math.floor(min(ay, by) - rad)))
                y1 = min(HEIGHT - 1, int(math.ceil(max(ay, by) + rad)))
                dx, dy = bx - ax, by - ay
                seg_len2 = dx * dx + dy * dy
                for y in range(y0, y1 + 1):
                    for x in range(x0, x1 + 1):
                        if seg_len2 <= 1e-6:
                            dist2 = (x - ax) ** 2 + (y - ay) ** 2
                        else:
                            t = clamp(((x - ax) * dx + (y - ay) * dy) / seg_len2, 0.0, 1.0)
                            dist2 = (x - (ax + t * dx)) ** 2 + (y - (ay + t * dy)) ** 2
                        if dist2 <= rad2:
                            off = (y * WIDTH + x) * 4
                            bgra[off : off + 4] = white_px

        # Equalizer / scene indicator when listening or running dynamic scenes
        emerald_px = bytes((0x81, 0xB9, 0x10, 0xFF))
        amber_bright_px = bytes((0x24, 0xBF, 0xFB, 0xFF))
        amber_dim_px = bytes((0x09, 0x53, 0xB4, 0xFF))
        sky_px = bytes((0xF8, 0xBD, 0x38, 0xFF))
        if face.state_id == "listening":
            for side in (-1, 1):
                bx = int(geo["face_cx"] + side * (geo["face_r"] * 1.28))
                cy = int(geo["face_cy"])
                for dy in range(-28, 29):
                    off = ((cy + dy) * WIDTH + bx) * 4
                    bgra[off : off + 6 * 4] = emerald_px * 6
        elif face.state_id in ("speaking", "sending_msg", "printing", "operating_xiaoai", "operating_tv", "managing_laifen", "weighing_scale"):
            accent_px = sky_px if (
                face.state_id in ("operating_tv", "managing_laifen")
                or (face.state_id == "sending_msg" and hud.scene_channel == "telegram")
            ) else (
                emerald_px if face.state_id in ("sending_msg", "operating_xiaoai", "weighing_scale") else amber_bright_px
            )
            bx = int(min(WIDTH - 24, geo["face_cx"] + geo["face_r"] * 1.35))
            cy = int(geo["face_cy"])
            for dy in range(-24, 25):
                off = ((cy + dy) * WIDTH + bx) * 4
                bgra[off : off + 6 * 4] = accent_px * 6

        # Marquee box + animated scroll tick pixel marker (inside marquee strip only -> tiny tile patch!)
        my0 = int(geo["marquee_y"])
        my1 = int(geo["marquee_y"] + geo["marquee_h"])
        m_outline = emerald_px if (hud.headline_incoming or face.state_id == "listening") else amber_dim_px
        self._draw_rect_outline_bgra(36, my0, 763, my1, m_outline)
        if self.marquee.text:
            tick_x = 140 + int(self.marquee.scroll_x) % 560
            tick_y = my0 + 18
            for dy in range(12):
                off = ((tick_y + dy) * WIDTH + tick_x) * 4
                bgra[off : off + 8 * 4] = white_px * 8

        # Bento cards or task overlay
        if hud.auto_task_overlay and (hud.ask_boss_question or hud.workers):
            self._draw_rect_outline_bgra(36, int(geo["grid_y"]), 763, int(geo["grid_y"] + 180), amber_bright_px)
        else:
            for card in placed_cards:
                self._draw_rect_outline_bgra(
                    int(card.x),
                    int(card.y),
                    int(card.x + card.w),
                    int(card.y + card.h),
                    amber_dim_px,
                )

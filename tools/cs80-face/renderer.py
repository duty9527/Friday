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

STATE_BADGES = {
    "idle": ("IDLE · 待机", COL_AMBER),
    "listening": ("LISTENING · 正在倾听", COL_EMERALD),
    "thinking": ("THINKING · 思考", COL_AMBER_BRIGHT),
    "searching": ("RECALL · 记忆闪回", COL_AMBER_BRIGHT),
    "streaming": ("SPEAKING · 回复中", COL_WHITE),
    "working": ("WORKING · 协同中", COL_EMERALD),
    "waiting": ("ASK BOSS · 请示", COL_AMBER_BRIGHT),
    "finished": ("DONE · 已完成", COL_EMERALD),
    "failed": ("BLOCKED · 受阻", COL_RED),
    "sleeping": ("SLEEP · NREM", COL_AMBER_DIM),
}


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
    headline_source: str = "FRIDAY"
    headline_text: str = "全天候个人 AI 战术副手待命。"
    ask_boss_question: str = ""
    workers: Tuple[WorkerSummary, ...] = ()
    channels: Tuple[Tuple[str, bool], ...] = (("WX", False), ("XIAOAI", False), ("TG", False))
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


_EMOJI_STRIP_RE = re.compile(r"[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u200D]")


def _sanitize_hud_text(text: str) -> str:
    if not text:
        return ""
    s = (
        text.replace("✅", "[OK]")
        .replace("✔️", "[OK]")
        .replace("⚠️", "[!]")
        .replace("⚠", "[!]")
        .replace("❌", "[×]")
        .replace("⏰", "[提醒]")
        .replace("⚡", "[!]")
    )
    return _EMOJI_STRIP_RE.sub("", s)


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
    if len(vals) < 2:
        # Subtle flat reference baseline
        ctx.new_path()
        ctx.move_to(x, y + h * 0.55)
        ctx.line_to(x + w, y + h * 0.55)
        ctx.set_source_rgb(*COL_AMBER_DARK_LINE)
        ctx.set_line_width(1.5)
        ctx.stroke()
        return

    lo = min(vals)
    hi = max(vals)
    span = max(1e-6, hi - lo)
    pts: List[Tuple[float, float]] = []
    for idx, v in enumerate(vals):
        px = x + (idx / float(len(vals) - 1)) * w
        norm = (v - lo) / span
        py = y + h - 3.0 - norm * max(4.0, h - 6.0)
        pts.append((px, py))

    # Subtle baseline
    ctx.new_path()
    ctx.move_to(x, y + h - 2.0)
    ctx.line_to(x + w, y + h - 2.0)
    ctx.set_source_rgb(*COL_AMBER_DARK_LINE)
    ctx.set_line_width(1.0)
    ctx.stroke()

    ctx.new_path()
    ctx.move_to(pts[0][0], pts[0][1])
    for px, py in pts[1:]:
        ctx.line_to(px, py)
    ctx.set_source_rgb(*col)
    ctx.set_line_width(2.4)
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.set_line_join(cairo.LINE_JOIN_ROUND)
    ctx.stroke()

    lx, ly = pts[-1]
    ctx.new_path()
    ctx.arc(lx, ly, 4.0, 0.0, math.pi * 2.0)
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
        clean_src = _sanitize_hud_text(hud.headline_source or "FRIDAY")[:16]
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
        badge_text, badge_col = STATE_BADGES.get(face.state_id, ("READY", COL_AMBER))
        if face.state_id == "sleeping" and face.sub_phase == "rem":
            badge_text = "DREAM · REM 做梦"
            badge_col = COL_AMBER_BRIGHT
        elif face.state_id == "listening" and "连续" in hud.voice_caption:
            badge_text = "LISTENING · 连续对话"
            badge_col = COL_EMERALD
        elif face.state_id == "working" and face.worker_count > 0:
            badge_text = f"WORKING · {face.worker_count} ACTIVE"

        dot_col = COL_EMERALD if hud.friday_connected else COL_RED
        ctx.new_path()
        ctx.set_source_rgb(*dot_col)
        ctx.arc(44.0, 50.0, 7.0, 0.0, math.pi * 2.0)
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
        pill_w = max(144.0, tw + 28.0)
        pill_h = 35.0
        _cairo_rounded_rect(ctx, pill_x, pill_y, pill_w, pill_h, 17.5)
        ctx.set_source_rgb(*badge_col)
        ctx.set_line_width(2.0)
        ctx.stroke()
        ctx.move_to(pill_x + 14.0, pill_y + 23.5)
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

    def _draw_stage_cairo(self, ctx, face: FaceSnapshot, hud: HudState, geo: Dict[str, float]) -> None:
        cx = geo["face_cx"]
        cy = geo["face_cy"]
        fr = geo["face_r"]
        scale = fr / 192.0
        sats = self._compute_satellites(face, cx, cy, fr)

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

            edge_col = COL_EMERALD if face.state_id == "listening" else COL_AMBER_BRIGHT
            ctx.set_source_rgb(*edge_col)
            ctx.set_line_width(2.2 if face.state_id == "listening" else 2.0)
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
            base_y = cy + fr * 1.28
            for i in range(3):
                ph = face.clock * 4.4 - i * 0.85
                lift = max(0.0, math.sin(ph))
                dx = cx + (i - 1) * 48.0 * dot_s
                dy = base_y - lift * 20.0 * scale
                ctx.new_path()
                ctx.set_source_rgb(*(COL_AMBER_BRIGHT if i == 1 else COL_AMBER))
                ctx.arc(dx, dy, 11.0 * dot_s, 0.0, math.pi * 2.0)
                ctx.fill()

        # Speaker-lock caption below listening face
        if face.state_id == "listening":
            cap = _sanitize_hud_text(hud.voice_caption or "请说话 · 正在监听声纹与指令")[:36]
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(18.0 if hud.grid_rows == 2 else 15.5)
            tw = ctx.text_extents(cap).x_advance
            cap_w = min(640.0, tw + 34.0)
            cap_h = 34.0 if hud.grid_rows == 2 else 28.0
            cap_x = cx - cap_w * 0.5
            cap_y = min(geo["marquee_y"] - cap_h - 10.0, cy + fr * 1.18)
            _cairo_rounded_rect(ctx, cap_x, cap_y, cap_w, cap_h, cap_h * 0.5)
            ctx.set_source_rgb(*COL_EMERALD)
            ctx.set_line_width(1.6)
            ctx.stroke()
            ctx.move_to(cap_x + 17.0, cap_y + cap_h * 0.68)
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
                _cairo_four_star(ctx, 594.0, top_y, 10.0)
                ctx.set_font_size(23.0)
                ctx.move_to(614.0, top_y + 8.0)
                ctx.show_text("REM")
            else:
                ctx.set_font_size(30.0)
                ctx.set_source_rgb(*COL_AMBER)
                ctx.move_to(600.0, top_y + 10.0)
                ctx.show_text("Zzz")

    def _draw_marquee_cairo(self, ctx, face: FaceSnapshot, hud: HudState, geo: Dict[str, float]) -> None:
        x0 = 36.0
        w = 728.0
        y0 = geo["marquee_y"]
        h = geo["marquee_h"]

        border_col = COL_EMERALD if face.state_id == "listening" else COL_AMBER_DIM
        _cairo_rounded_rect(ctx, x0, y0, w, h, 14.0)
        ctx.set_source_rgb(*border_col)
        ctx.set_line_width(1.6)
        ctx.stroke()

        # Left source pill
        src = _sanitize_hud_text(hud.headline_source or "FRIDAY")[:16]
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(16.0)
        sw = ctx.text_extents(src).x_advance
        pill_w = max(72.0, sw + 22.0)
        pill_h = h - 18.0
        pill_x = x0 + 12.0
        pill_y = y0 + 9.0
        _cairo_rounded_rect(ctx, pill_x, pill_y, pill_w, pill_h, 8.0)
        ctx.set_source_rgb(*(COL_EMERALD if face.state_id == "listening" else COL_AMBER))
        ctx.set_line_width(1.5)
        ctx.stroke()
        ctx.move_to(pill_x + 11.0, pill_y + pill_h * 0.72)
        ctx.set_source_rgb(*COL_AMBER_BRIGHT)
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
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.set_line_width(2.4)
            ctx.stroke()

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(21.0)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            _cairo_lightning_bolt(ctx, x0 + 22.0, cur_y + 18.0, 20.0)
            ctx.move_to(x0 + 42.0, cur_y + 36.0)
            ctx.show_text("战术请示 · ASK BOSS")

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

            tag = f"[{wk.profile.upper()}]"
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(18.0)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.move_to(x0 + 16.0, cur_y + 30.0)
            ctx.show_text(tag)
            tag_w = ctx.text_extents(tag).x_advance

            elapsed_str = f"{wk.elapsed_sec}s"
            ctx.set_font_size(18.5)
            elapsed_w = ctx.text_extents(elapsed_str).x_advance
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.move_to(x0 + w - 16.0 - elapsed_w, cur_y + 30.0)
            ctx.show_text(elapsed_str)

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(19.5)
            ctx.set_source_rgb(*COL_WHITE)
            avail_w = w - 48.0 - tag_w - elapsed_w
            prompt_lines = _wrap_text_cairo(ctx, wk.prompt, avail_w, 1)
            ctx.move_to(x0 + 26.0 + tag_w, cur_y + 31.0)
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

        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(17.0)
        ctx.set_source_rgb(*COL_AMBER_BRIGHT)
        ctx.move_to(hdr_x, y + 29.0)
        ctx.show_text(_fit_single_line_cairo(ctx, title, w - 120.0))

        if badge:
            ctx.set_font_size(15.0)
            b_str = _sanitize_hud_text(badge)[:18]
            bw = ctx.text_extents(b_str).x_advance
            ctx.set_source_rgb(*badge_col)
            ctx.move_to(x + w - 16.0 - bw, y + 28.0)
            ctx.show_text(b_str)

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
        daily_pnl = float(d.get("dailyPnl") or 0.0)
        is_up = daily_pct >= 0.0
        accent = COL_RED if is_up else COL_EMERALD
        ok = bool(d.get("ok"))
        badge = f"{d.get('holdingCount', 0)}只 · {d.get('updatedHm') or '实盘'}" if ok else "待同步"
        self._draw_card_frame(
            ctx,
            card,
            card.title or "基金估值",
            badge,
            accent if ok else COL_AMBER_DIM,
            accent if ok else COL_AMBER,
            dot_col=accent if ok else COL_AMBER_DIM,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        if d.get("empty") or not ok:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(20.0)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 18.0, y + 92.0)
            ctx.show_text(_fit_single_line_cairo(ctx, str(d.get("subline") or "暂无持仓数据"), w - 36.0))
            return

        sign = "+" if daily_pct > 0 else ""
        pct_str = f"{sign}{daily_pct:.2f}%"
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(36.0 if card.w_span == 2 else 31.0)
        ctx.set_source_rgb(*accent)
        ctx.move_to(x + 16.0, y + 86.0)
        ctx.show_text(pct_str)

        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        ctx.set_font_size(18.0)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 16.0, y + 114.0)
        ctx.show_text(_fit_single_line_cairo(ctx, str(d.get("subline") or ""), (w * 0.56 if card.w_span == 2 else w - 32.0)))

        tot_pnl_pct = float(d.get("totalPnlPct") or 0.0)
        tot_pnl = float(d.get("totalPnl") or 0.0)
        ctx.set_font_size(15.5)
        ctx.set_source_rgb(*COL_AMBER)
        ctx.move_to(x + 16.0, y + 138.0)
        ctx.show_text(f"累计 {tot_pnl:+.0f} ({tot_pnl_pct:+.1f}%)")

        spark = d.get("spark") or []
        if card.w_span == 2 and card.h_span == 1:
            _draw_sparkline_cairo(ctx, x + w * 0.52, y + 54.0, w * 0.44, h - 72.0, spark, accent)
        elif card.h_span == 1:
            _draw_sparkline_cairo(ctx, x + 16.0, y + 150.0, w - 32.0, max(36.0, h - 166.0), spark, accent)
        else:
            # 1x2 or 2x2: sparkline + holdings table
            spark_x = x + (w * 0.52 if card.w_span == 2 else 16.0)
            spark_w = (w * 0.44 if card.w_span == 2 else w - 32.0)
            spark_y = y + (54.0 if card.w_span == 2 else 150.0)
            _draw_sparkline_cairo(ctx, spark_x, spark_y, spark_w, 86.0, spark, accent)
            row_y = y + (158.0 if card.w_span == 2 else 252.0)
            for item in (d.get("holdings") or [])[:5]:
                if row_y + 28.0 > y + h - 10.0:
                    break
                ch = float(item.get("changePct") or 0.0)
                r_col = COL_RED if ch >= 0.0 else COL_EMERALD
                ctx.set_font_size(16.0)
                ctx.set_source_rgb(*COL_WHITE)
                ctx.move_to(x + 16.0, row_y + 18.0)
                ctx.show_text(_fit_single_line_cairo(ctx, f"{item.get('name', '')} ({item.get('code', '')})", w - 135.0))
                val_s = f"{ch:+.2f}%"
                vw = ctx.text_extents(val_s).x_advance
                ctx.set_source_rgb(*r_col)
                ctx.move_to(x + w - 16.0 - vw, row_y + 18.0)
                ctx.show_text(val_s)
                row_y += 38.0

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
            ctx.set_font_size(20.0)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 18.0, y + 92.0)
            ctx.show_text("踩上体脂秤同步体重体脂")
            return

        w_str = f"{float(d.get('weightKg') or 0.0):.1f}"
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(36.0 if card.w_span == 2 else 32.0)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 16.0, y + 86.0)
        ctx.show_text(w_str)
        ww = ctx.text_extents(w_str).x_advance

        ctx.set_font_size(18.0)
        ctx.set_source_rgb(*COL_AMBER_BRIGHT)
        ctx.move_to(x + 22.0 + ww, y + 86.0)
        ctx.show_text(f"kg  {diff:+.2f}")

        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        ctx.set_font_size(16.5)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 16.0, y + 114.0)
        fat = float(d.get("bodyFat") or 0.0)
        mus = float(d.get("musclePct") or 0.0)
        bmi = float(d.get("bmi") or 0.0)
        ctx.show_text(_fit_single_line_cairo(ctx, f"体脂 {fat:.1f}% · 肌肉 {mus:.1f}% · BMI {bmi:.1f}", w - 32.0))

        spark = d.get("spark") or []
        if card.w_span == 2 and card.h_span == 1:
            _draw_sparkline_cairo(ctx, x + w * 0.56, y + 54.0, w * 0.40, h - 72.0, spark, COL_EMERALD)
            ctx.set_font_size(15.5)
            ctx.set_source_rgb(*COL_AMBER)
            ctx.move_to(x + 16.0, y + 142.0)
            ctx.show_text(f"体型 {d.get('bodyType') or '--'} · 代谢 {d.get('bmrKcal') or '--'} kcal · 水分 {d.get('waterPct') or '--'}%")
        elif card.h_span == 1:
            _draw_sparkline_cairo(ctx, x + 16.0, y + 132.0, w - 32.0, max(42.0, h - 148.0), spark, COL_EMERALD)
        else:
            _draw_sparkline_cairo(ctx, x + 16.0, y + 132.0, w - 32.0, 96.0, spark, COL_EMERALD)
            bars = [
                ("体脂率", f"{fat:.1f}%", min(1.0, fat / 35.0)),
                ("骨骼肌", f"{mus:.1f}%", min(1.0, mus / 55.0)),
                ("水分率", f"{float(d.get('waterPct') or 0.0):.1f}%", min(1.0, float(d.get("waterPct") or 0.0) / 70.0)),
                ("内脏脂肪", f"{d.get('visceral', '--')} 级", min(1.0, float(d.get("visceral") or 0) / 18.0)),
            ]
            by = y + 248.0
            for lbl, val, pct in bars:
                if by + 34.0 > y + h - 12.0:
                    break
                ctx.set_font_size(15.5)
                ctx.set_source_rgb(*COL_WHITE)
                ctx.move_to(x + 16.0, by + 15.0)
                ctx.show_text(lbl)
                vw = ctx.text_extents(val).x_advance
                ctx.set_source_rgb(*COL_AMBER_BRIGHT)
                ctx.move_to(x + w - 16.0 - vw, by + 15.0)
                ctx.show_text(val)
                bar_y = by + 22.0
                _cairo_rounded_rect(ctx, x + 16.0, bar_y, w - 32.0, 7.0, 3.5)
                ctx.set_source_rgb(*COL_AMBER_DARK_LINE)
                ctx.set_line_width(1.2)
                ctx.stroke()
                if pct > 0.02:
                    _cairo_rounded_rect(ctx, x + 16.0, bar_y, max(8.0, (w - 32.0) * pct), 7.0, 3.5)
                    ctx.set_source_rgb(*COL_EMERALD)
                    ctx.fill()
                by += 44.0

    def _card_miot(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        ok = bool(d.get("ok"))
        online = int(d.get("online") or 0)
        total = int(d.get("total") or 0)
        on_cnt = int(d.get("onCount") or 0)
        self._draw_card_frame(
            ctx,
            card,
            card.title or "米家智控",
            f"{online}/{total} 在线 · {on_cnt}开" if total > 0 else "待读取",
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
            ctx.show_text("暂无缓存设备状态")
            return

        cols = 2 if card.w_span == 1 else 3
        max_rows = max(2, int((h - 60.0) // 46.0))
        gap = 10.0
        pw = (w - 32.0 - gap * (cols - 1)) / float(cols)
        ph = min(64.0, (h - 60.0 - gap * (max_rows - 1)) / float(max_rows))
        for idx, dev in enumerate(devices[: cols * max_rows]):
            r = idx // cols
            c = idx % cols
            px = x + 16.0 + c * (pw + gap)
            py = y + 52.0 + r * (ph + gap)
            is_on = dev.get("on") is True
            is_online = bool(dev.get("online"))
            p_col = COL_EMERALD if is_on else (COL_AMBER_DIM if is_online else COL_RED)
            _cairo_rounded_rect(ctx, px, py, pw, ph, 10.0)
            ctx.set_source_rgb(*p_col)
            ctx.set_line_width(1.5)
            ctx.stroke()

            ctx.new_path()
            ctx.arc(px + 12.0, py + ph * 0.5, 4.0, 0.0, math.pi * 2.0)
            ctx.set_source_rgb(*(COL_EMERALD if is_on else (COL_AMBER if is_online else COL_RED)))
            ctx.fill()

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD if is_on else cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(15.0)
            ctx.set_source_rgb(*(COL_WHITE if is_online else COL_AMBER_DIM))
            ctx.move_to(px + 22.0, py + ph * 0.48)
            ctx.show_text(_fit_single_line_cairo(ctx, str(dev.get("name") or ""), pw - 30.0))

            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(12.5)
            ctx.set_source_rgb(*(COL_EMERALD if is_on else COL_AMBER))
            st_lbl = "开启" if is_on else ("待机" if dev.get("on") is False else ("在线" if is_online else "离线"))
            ctx.move_to(px + 22.0, py + ph * 0.80)
            ctx.show_text(_fit_single_line_cairo(ctx, f"{dev.get('room', '')} · {st_lbl}", pw - 30.0))

    def _card_ninebot(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        ok = bool(d.get("ok"))
        batt = d.get("battery")
        batt_val = int(batt) if batt is not None else None
        charging = bool(d.get("charging"))
        power_on = bool(d.get("powerOn"))
        locked = d.get("locked")
        alerts = int(d.get("alertCount") or 0)
        is_warn = alerts > 0 or (not charging and (power_on or locked is False)) or (batt_val is not None and batt_val <= 20 and not charging)

        if not ok:
            accent = COL_AMBER
            border = COL_AMBER_DIM
            dot = COL_AMBER_DIM
            badge = "待绑定"
        elif is_warn:
            accent = COL_RED
            border = COL_RED
            dot = COL_RED
            badge = "未锁车!" if (power_on or locked is False) else f"告警 {alerts}"
        elif charging:
            accent = COL_EMERALD
            border = COL_EMERALD
            dot = COL_EMERALD
            pw_w = d.get("chargingPowerW")
            badge = f"⚡{pw_w}W" if pw_w else "充电中"
        else:
            accent = COL_EMERALD if (batt_val is not None and batt_val >= 40) else COL_AMBER_BRIGHT
            border = COL_EMERALD if (batt_val is not None and batt_val >= 40) else COL_AMBER_DIM
            dot = accent
            upd = str(d.get("updatedHm") or "")
            badge = f"已锁 · {upd}" if (locked is True and upd) else ("已锁" if locked is True else (upd or "在线"))

        self._draw_card_frame(
            ctx,
            card,
            card.title or str(d.get("name") or "九号守护"),
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
            ctx.show_text(_fit_single_line_cairo(ctx, str(d.get("subline") or "请在「九号守护」绑定九号账号"), w - 36.0))
            return

        batt_str = f"{batt_val}%" if batt_val is not None else "--%"
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(36.0 if card.w_span == 2 else 32.0)
        ctx.set_source_rgb(*accent)
        ctx.move_to(x + 16.0, y + 86.0)
        ctx.show_text(batt_str)
        bw = ctx.text_extents(batt_str).x_advance

        range_km = d.get("rangeKm")
        ctx.set_font_size(17.5)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 24.0 + bw, y + 86.0)
        ctx.show_text(f"续航 {float(range_km):.1f}km" if range_km is not None else "续航 --")

        # Battery progress bar
        bar_w = w * 0.48 if (card.w_span == 2 and card.h_span == 1) else (w - 32.0)
        bar_y = y + 98.0
        _cairo_rounded_rect(ctx, x + 16.0, bar_y, bar_w, 8.0, 4.0)
        ctx.set_source_rgb(*COL_AMBER_DARK_LINE)
        ctx.set_line_width(1.2)
        ctx.stroke()
        ratio = clamp((float(batt_val or 0) / 100.0), 0.0, 1.0)
        if ratio > 0.02:
            _cairo_rounded_rect(ctx, x + 16.0, bar_y, max(8.0, bar_w * ratio), 8.0, 4.0)
            ctx.set_source_rgb(*accent)
            ctx.fill()

        # BMS telemetry line
        parts = []
        if d.get("voltageV") is not None:
            parts.append(f"{float(d['voltageV']):.1f}V")
        if d.get("tempC") is not None:
            parts.append(f"{float(d['tempC']):.0f}℃")
        if d.get("auxBattery") is not None:
            parts.append(f"备电{d['auxBattery']}%")
        if charging and d.get("remainChargeTime"):
            parts.append(f"余{d['remainChargeTime']}")
        bms_line = " · ".join(parts) or ("电门开启" if power_on else "已关机")

        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        ctx.set_font_size(15.5)
        ctx.set_source_rgb(*COL_AMBER_BRIGHT)
        ctx.move_to(x + 16.0, y + 132.0)
        ctx.show_text(_fit_single_line_cairo(ctx, bms_line, bar_w))

        addr_str = str(d.get("address") or "暂无定位")
        spark = d.get("spark") or []
        if card.w_span == 2 and card.h_span == 1:
            _draw_sparkline_cairo(ctx, x + w * 0.56, y + 54.0, w * 0.40, h - 86.0, spark, accent)
            ctx.set_font_size(15.0)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 16.0, y + 162.0)
            ctx.show_text(_fit_single_line_cairo(ctx, f"📍 {addr_str}", w * 0.52))
            odo_s = f"总 {d['odometerKm']:.0f}km" if d.get("odometerKm") is not None else ""
            spd_s = f"极速 {d['maxSpeedKmh']:.0f}km/h" if float(d.get("maxSpeedKmh") or 0) > 0 else ""
            right_info = " · ".join(p for p in (odo_s, spd_s) if p)
            if right_info:
                rw = ctx.text_extents(right_info).x_advance
                ctx.set_source_rgb(*COL_AMBER)
                ctx.move_to(x + w - 16.0 - rw, y + h - 14.0)
                ctx.show_text(right_info)
        elif card.h_span == 1:
            ctx.set_font_size(14.5)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 16.0, y + 162.0)
            ctx.show_text(_fit_single_line_cairo(ctx, f"📍 {addr_str}", w - 32.0))
        else:
            _draw_sparkline_cairo(ctx, x + 16.0, y + 148.0, w - 32.0, 96.0, spark, accent)
            rows = [
                ("总里程", f"{d['odometerKm']:.1f} km" if d.get("odometerKm") is not None else "--"),
                ("本月骑行", f"{float(d.get('monthKm') or 0.0):.1f} km"),
                ("最高极速", f"{float(d.get('maxSpeedKmh') or 0.0):.1f} km/h" if float(d.get("maxSpeedKmh") or 0) > 0 else "--"),
                ("停放位置", addr_str),
            ]
            ry = y + 272.0
            for lbl, val in rows:
                if ry + 20.0 > y + h - 10.0:
                    break
                ctx.set_font_size(15.5)
                ctx.set_source_rgb(*COL_AMBER)
                ctx.move_to(x + 16.0, ry)
                ctx.show_text(lbl)
                ctx.set_source_rgb(*COL_WHITE)
                vs = _fit_single_line_cairo(ctx, val, w - 124.0)
                vw = ctx.text_extents(vs).x_advance
                ctx.move_to(x + w - 16.0 - vw, ry)
                ctx.show_text(vs)
                ry += 38.0

    def _card_system_pulse(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        cpu = float(d.get("cpuPct") or 0.0)
        mem = float(d.get("memPct") or 0.0)
        disk = float(d.get("diskPct") or 0.0)
        load1 = float(d.get("load1") or 0.0)
        self._draw_card_frame(
            ctx,
            card,
            card.title or "主机脉搏",
            f"LOAD {load1:.2f}",
            COL_AMBER_DIM,
            COL_AMBER_BRIGHT,
            dot_col=COL_EMERALD,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        bars = [
            ("CPU 占用", f"{cpu:.0f}%", cpu / 100.0, COL_EMERALD if cpu < 70 else COL_AMBER_BRIGHT),
            ("内存 RAM", f"{mem:.0f}% ({d.get('memUsedGb', 0):.1f}/{d.get('memTotalGb', 0):.1f}G)", mem / 100.0, COL_AMBER_BRIGHT if mem < 82 else COL_RED),
            ("根分区磁盘", f"{disk:.0f}% (余 {d.get('diskFreeGb', 0):.0f}G)", disk / 100.0, COL_AMBER),
        ]
        if card.w_span == 2 and card.h_span == 1:
            col_w = (w - 48.0) * 0.5
            for idx, (lbl, val, ratio, col) in enumerate(bars[:2]):
                bx = x + 16.0 + idx * (col_w + 16.0)
                self._draw_bar_row(ctx, bx, y + 58.0, col_w, lbl, val, ratio, col)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(16.0)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 16.0, y + 148.0)
            nt = str(d.get("nextTimer") or "定时调度待命中")
            ctx.show_text(_fit_single_line_cairo(ctx, f"下一日程: {nt}  ·  磁盘已用 {disk:.0f}% (余 {d.get('diskFreeGb', 0):.0f}G)", w - 32.0))
        else:
            by = y + 54.0
            for lbl, val, ratio, col in bars:
                if by + 40.0 > y + h - 28.0:
                    break
                self._draw_bar_row(ctx, x + 16.0, by, w - 32.0, lbl, val, ratio, col)
                by += 44.0
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(15.0)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            ctx.move_to(x + 16.0, y + h - 18.0)
            nt = str(d.get("nextTimer") or f"在线 {d.get('uptimeH', 0):.0f}h · 定时 {d.get('timerCount', 0)}")
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
        ctx.set_font_size(15.0)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x, y + 14.0)
        ctx.show_text(label)
        vw = ctx.text_extents(value).x_advance
        ctx.set_source_rgb(*COL_AMBER_BRIGHT)
        ctx.move_to(x + w - vw, y + 14.0)
        ctx.show_text(value)
        _cairo_rounded_rect(ctx, x, y + 22.0, w, 9.0, 4.5)
        ctx.set_source_rgb(*COL_AMBER_DARK_LINE)
        ctx.set_line_width(1.2)
        ctx.stroke()
        r = clamp(ratio, 0.0, 1.0)
        if r > 0.02:
            _cairo_rounded_rect(ctx, x, y + 22.0, max(9.0, w * r), 9.0, 4.5)
            ctx.set_source_rgb(*col)
            ctx.fill()

    def _card_tv_agent(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        online = bool(d.get("online"))
        self._draw_card_frame(
            ctx,
            card,
            card.title or "电视控制",
            "ONLINE" if online else "STANDBY",
            COL_EMERALD if online else COL_AMBER_DIM,
            COL_EMERALD if online else COL_AMBER,
            dot_col=COL_EMERALD if online else COL_AMBER_DIM,
        )
        x, y, w = card.x, card.y, card.w
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(26.0)
        ctx.set_source_rgb(*(COL_WHITE if online else COL_AMBER))
        ctx.move_to(x + 16.0, y + 86.0)
        ctx.show_text(_fit_single_line_cairo(ctx, str(d.get("appName") or ("在线" if online else "待机/关机")), w - 32.0))

        vol = d.get("volume")
        vol_s = f"音量 {vol}{' (静音)' if d.get('muted') else ''}" if vol is not None else f"IP {d.get('host') or '--'}"
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        ctx.set_font_size(17.0)
        ctx.set_source_rgb(*COL_AMBER_BRIGHT)
        ctx.move_to(x + 16.0, y + 120.0)
        ctx.show_text(_fit_single_line_cairo(ctx, vol_s, w - 32.0))

        ctx.set_font_size(14.5)
        ctx.set_source_rgb(*COL_AMBER)
        ctx.move_to(x + 16.0, y + 148.0)
        ctx.show_text(f"DLNA {'OK' if d.get('dlnaOk') else '--'} · Agent {'OK' if d.get('agentOk') else '--'}")

    def _card_tv_ir(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        tx_ok = bool(d.get("txReady"))
        self._draw_card_frame(
            ctx,
            card,
            card.title or "红外遥控",
            "TX READY" if tx_ok else "CHECK",
            COL_EMERALD if tx_ok else COL_AMBER_DIM,
            COL_EMERALD if tx_ok else COL_AMBER,
            dot_col=COL_EMERALD if tx_ok else COL_AMBER,
        )
        x, y, w = card.x, card.y, card.w
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(26.0)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 16.0, y + 88.0)
        ctx.show_text(str(d.get("headline") or "LX06 红外就绪"))

        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        ctx.set_font_size(17.0)
        ctx.set_source_rgb(*COL_AMBER_BRIGHT)
        ctx.move_to(x + 16.0, y + 122.0)
        ctx.show_text(_fit_single_line_cairo(ctx, str(d.get("subline") or ""), w - 32.0))

    def _card_memory(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        total = int(d.get("totalActive") or 0)
        edges = list(d.get("edges") or [])
        n_nodes = max(1, min(12, int(d.get("nodeCount") or 6)))
        self._draw_card_frame(
            ctx,
            card,
            card.title or "全息突触记忆",
            f"{total} 条 · {len(edges)} 边",
            COL_AMBER_DIM,
            COL_AMBER_BRIGHT,
            dot_col=COL_AMBER_BRIGHT,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(28.0)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 16.0, y + 84.0)
        ctx.show_text(f"{total}")
        tw = ctx.text_extents(f"{total}").x_advance
        ctx.set_font_size(16.0)
        ctx.set_source_rgb(*COL_AMBER)
        ctx.move_to(x + 22.0 + tw, y + 84.0)
        ctx.show_text(f"条 · {d.get('pinnedCount', 0)} 置顶")

        # Draw mini Hebbian constellation in right or lower region
        gx = x + (w * 0.48 if card.w_span == 2 else 16.0)
        gy = y + (50.0 if card.w_span == 2 else 102.0)
        gw = (w * 0.48 if card.w_span == 2 else w - 32.0)
        gh = max(72.0, h - (62.0 if card.w_span == 2 else 116.0))
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
                ctx.set_line_width(1.4)
                ctx.stroke()
        for idx, (px, py) in enumerate(pts):
            ctx.new_path()
            ctx.arc(px, py, 4.2 if idx < 3 else 2.8, 0.0, math.pi * 2.0)
            ctx.set_source_rgb(*(COL_AMBER_BRIGHT if idx < 3 else COL_WHITE))
            ctx.fill()

        # Topic list when wide or tall
        if card.w_span == 2 or card.h_span == 2:
            ty = y + 114.0
            for topic in (d.get("topics") or [])[:4]:
                if ty + 20.0 > y + h - 10.0:
                    break
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                ctx.set_font_size(15.5)
                ctx.set_source_rgb(*COL_WHITE)
                ctx.move_to(x + 16.0, ty)
                ctx.show_text(_fit_single_line_cairo(ctx, f"· {topic}", (w * 0.42 if card.w_span == 2 else w - 32.0)))
                ty += 24.0

    def _card_timers(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        self._draw_card_frame(
            ctx,
            card,
            card.title or "定时与目标",
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
            ctx.show_text("暂无运行中的定时任务")
            return
        ry = y + 68.0
        for row in rows[: (5 if card.h_span == 2 else 3)]:
            if ry + 12.0 > y + h - 8.0:
                break
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(16.0)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            hm = str(row.get("nextHm") or "--:--")
            ctx.move_to(x + 16.0, ry)
            ctx.show_text(hm)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 76.0, ry)
            ctx.show_text(_fit_single_line_cairo(ctx, str(row.get("name") or ""), w - 92.0))
            ry += 34.0

    def _card_usage(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        self._draw_card_frame(
            ctx,
            card,
            card.title or "今日算力",
            f"{d.get('calls', 0)} 次调用",
            COL_AMBER_DIM,
            COL_AMBER_BRIGHT,
            dot_col=COL_AMBER_BRIGHT,
        )
        x, y, w = card.x, card.y, card.w
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(32.0)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 16.0, y + 88.0)
        ctx.show_text(f"¥{float(d.get('costCny') or 0.0):.2f}")

        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        ctx.set_font_size(17.5)
        ctx.set_source_rgb(*COL_AMBER_BRIGHT)
        ctx.move_to(x + 16.0, y + 122.0)
        ctx.show_text(f"Token {d.get('tokStr', '0')}  ·  ${float(d.get('costUsd') or 0.0):.3f}")

    def _card_weather(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        ok = bool(d.get("ok"))
        self._draw_card_frame(
            ctx,
            card,
            card.title or f"实时气象 · {d.get('city', '本地')}",
            str(d.get("desc") or "--"),
            COL_AMBER_DIM,
            COL_AMBER_BRIGHT,
            dot_col=COL_EMERALD if ok else COL_AMBER_DIM,
        )
        x, y, w = card.x, card.y, card.w
        temp = d.get("temp")
        t_str = f"{float(temp):.0f}°C" if temp is not None else "--°C"
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        ctx.set_font_size(34.0)
        ctx.set_source_rgb(*COL_WHITE)
        ctx.move_to(x + 16.0, y + 88.0)
        ctx.show_text(t_str)
        ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
        ctx.set_font_size(17.0)
        ctx.set_source_rgb(*COL_AMBER_BRIGHT)
        ctx.move_to(x + 16.0, y + 124.0)
        ctx.show_text(_fit_single_line_cairo(ctx, str(d.get("subline") or ""), w - 32.0))

    def _card_workers(self, ctx, card: PlacedCard, d: Dict[str, Any], hud: HudState) -> None:
        cnt = len(hud.workers)
        self._draw_card_frame(
            ctx,
            card,
            card.title or "并发 Worker",
            f"{cnt} 运行中" if cnt else "IDLE",
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
            ctx.show_text("当前无后台 Worker 运行")
            return
        ry = y + 68.0
        for wk in hud.workers[: (5 if card.h_span == 2 else 3)]:
            if ry + 12.0 > y + h - 8.0:
                break
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
            ctx.set_font_size(15.5)
            ctx.set_source_rgb(*COL_AMBER_BRIGHT)
            tag = f"[{wk.profile.upper()}]"
            ctx.move_to(x + 16.0, ry)
            ctx.show_text(tag)
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_source_rgb(*COL_WHITE)
            ctx.move_to(x + 114.0, ry)
            ctx.show_text(_fit_single_line_cairo(ctx, wk.prompt, w - 170.0))
            ctx.set_source_rgb(*COL_EMERALD)
            es = f"{wk.elapsed_sec}s"
            ew = ctx.text_extents(es).x_advance
            ctx.move_to(x + w - 16.0 - ew, ry)
            ctx.show_text(es)
            ry += 34.0

    def _card_custom_plugin(self, ctx, card: PlacedCard, d: Dict[str, Any]) -> None:
        ok = bool(d.get("ok"))
        title = card.title or str(d.get("title") or card.plugin or card.kind)
        action = card.action or str(d.get("action") or "status")
        self._draw_card_frame(
            ctx,
            card,
            title,
            f"{action} · {'OK' if ok else 'ERR'}",
            COL_EMERALD if ok else COL_AMBER_DIM,
            COL_EMERALD if ok else COL_AMBER,
            dot_col=COL_EMERALD if ok else COL_RED,
        )
        x, y, w, h = card.x, card.y, card.w, card.h
        kpis = list(d.get("kpis") or [])
        msg = str(d.get("message") or d.get("subline") or "已挂载自定义插件卡片")

        if kpis:
            cols = 2 if card.w_span == 2 else 1
            max_items = 6 if (card.w_span == 2 and card.h_span == 2) else (4 if card.w_span == 2 or card.h_span == 2 else 3)
            ry = y + 68.0
            for idx, (k_lbl, k_val) in enumerate(kpis[:max_items]):
                c = idx % cols
                r = idx // cols
                col_w = (w - 32.0 - 16.0) / float(cols) if cols > 1 else (w - 32.0)
                kx = x + 16.0 + c * (col_w + 16.0)
                ky = ry + r * 34.0
                if ky + 10.0 > y + h - 12.0:
                    break
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
                ctx.set_font_size(15.0)
                ctx.set_source_rgb(*COL_AMBER)
                ctx.move_to(kx, ky)
                ctx.show_text(_fit_single_line_cairo(ctx, str(k_lbl), col_w * 0.45))
                ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
                ctx.set_font_size(16.5)
                ctx.set_source_rgb(*COL_WHITE)
                vs = _fit_single_line_cairo(ctx, str(k_val), col_w * 0.52)
                vw = ctx.text_extents(vs).x_advance
                ctx.move_to(kx + col_w - vw, ky)
                ctx.show_text(vs)
        else:
            ctx.select_font_face(self.font_family, cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_NORMAL)
            ctx.set_font_size(17.5)
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
        ctx.set_font_size(19.0)
        cx = 38.0
        for label, online in hud.channels:
            ctx.new_path()
            ctx.set_source_rgb(*(COL_EMERALD if online else COL_AMBER_DIM))
            ctx.arc(cx + 6.0, 1244.0, 5.5, 0.0, math.pi * 2.0)
            ctx.fill()
            ctx.set_source_rgb(*(COL_WHITE if online else COL_AMBER_DIM))
            ctx.move_to(cx + 18.0, 1251.0)
            ctx.show_text(label)
            cx += 36.0 + ctx.text_extents(label).x_advance

        spk = "SPK MUTE" if hud.speaker_muted else f"SPK {hud.speaker_volume}%"
        page_s = f" · P{hud.active_page + 1}/{hud.page_count}" if hud.page_count > 1 else ""
        right_str = f"MEM {hud.memory_count} · {spk} · CALLS {hud.today_calls}{page_s}"
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

        # Equalizer indicator when listening
        emerald_px = bytes((0x81, 0xB9, 0x10, 0xFF))
        amber_bright_px = bytes((0x24, 0xBF, 0xFB, 0xFF))
        amber_dim_px = bytes((0x09, 0x53, 0xB4, 0xFF))
        if face.state_id == "listening":
            for side in (-1, 1):
                bx = int(geo["face_cx"] + side * (geo["face_r"] * 1.28))
                cy = int(geo["face_cy"])
                for dy in range(-28, 29):
                    off = ((cy + dy) * WIDTH + bx) * 4
                    bgra[off : off + 6 * 4] = emerald_px * 6

        # Marquee box + animated scroll tick pixel marker (inside marquee strip only -> tiny tile patch!)
        my0 = int(geo["marquee_y"])
        my1 = int(geo["marquee_y"] + geo["marquee_h"])
        self._draw_rect_outline_bgra(36, my0, 763, my1, emerald_px if face.state_id == "listening" else amber_dim_px)
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

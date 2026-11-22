"""CS80 Bento widget layout persistence, 2-column grid packer, plugin catalog & lazy TTL collectors."""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
from datetime import datetime, timedelta
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import threading
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple
import urllib.request

try:
    from zoneinfo import ZoneInfo as _ZoneInfo
    _SHANGHAI_TZ: Optional[Any] = _ZoneInfo("Asia/Shanghai")
except Exception:
    _SHANGHAI_TZ = None

VALID_SIZES: Tuple[str, ...] = ("1x1", "2x1", "1x2", "2x2")
VALID_MARQUEE_MODES: Tuple[str, ...] = ("auto_pause", "continuous", "static")
BUILTIN_PLUGIN_WIDGETS: Tuple[str, ...] = (
    "fund-tracker",
    "health-scale",
    "miot",
    "ninebot",
    "laifen",
    "netlea",
    "apple-devices",
    "tv-agent",
    "tv-ir",
)

LAIFEN_MODE_ZH: Dict[int, str] = {
    1: "柔和护龈",
    2: "日常清洁",
    3: "强劲清洁",
    4: "高频亮白",
}

_CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def _localize_laifen_name(raw_name: Any) -> str:
    s = str(raw_name or "").strip()
    if s and _CJK_RE.search(s):
        return s[:16]
    return "徕芬电动牙刷"


def _localize_netlea_name(raw_name: Any) -> str:
    s = str(raw_name or "").strip()
    if s and _CJK_RE.search(s):
        return s[:18]
    return "尼特利鱼缸灯"

APPLE_CATEGORY_ZH: Dict[str, str] = {
    "iphone": "手机",
    "ipad": "平板",
    "watch": "手表",
    "airpods": "耳机",
    "mac": "电脑",
    "airtag": "追踪器",
}

TV_APP_NAME_ZH: Dict[str, str] = {
    "com.bili.tv.bili_tv_app": "哔哩哔哩",
    "com.xiaodianshi.tv.yst": "哔哩哔哩",
    "tv.danmaku.bili": "哔哩哔哩",
    "com.ktcp.video": "云视听极光",
    "com.ktcp.tvvideo": "云视听极光",
    "com.tencent.qqlivetv": "云视听极光",
    "com.gitvdemo.video": "银河奇异果",
    "com.qiyi.video.speaker": "银河奇异果",
    "com.iqiyi.i18n.tv": "银河奇异果",
    "com.gitv.video": "银河奇异果",
    "com.cibn.tv": "酷喵影视",
    "com.youku.tv": "酷喵影视",
    "org.xbmc.kodi": "本地影院",
    "org.courville.nova": "本地影院",
    "com.mxtech.videoplayer.ad": "本地影院",
    "com.mxtech.videoplayer.pro": "本地影院",
    "org.videolan.vlc": "本地影院",
    "com.plexapp.android": "本地影院",
    "com.mb.android": "本地影院",
    "org.jellyfin.androidtv": "本地影院",
    "com.xiaomi.mitv.mediaexplorer": "本地影院",
    "org.smarttube.stable": "YouTube",
    "org.smarttube.beta": "YouTube",
    "com.google.android.youtube.tv": "YouTube",
    "com.liskovsoft.smarttubetv": "YouTube",
    "com.mitv.tvhome": "电视桌面",
    "com.xiaomi.mitv.tvhome": "电视桌面",
    "com.dangbei.tvlauncher": "电视桌面",
    "com.google.android.tvlauncher": "电视桌面",
    "com.google.android.apps.tv.launcherx": "电视桌面",
    "com.android.tv.launcher": "电视桌面",
    "com.tcl.cyberui": "电视桌面",
    "com.sony.dtv.homelauncher": "电视桌面",
}

SCALAR_INTERNAL_BLOCKLIST: Set[str] = {
    "id",
    "pid",
    "stubpid",
    "ok",
    "notify",
    "live",
    "dryrun",
    "fromcache",
    "refreshed",
    "updatedat",
    "fetchedat",
    "createdat",
    "savedat",
    "startedat",
    "cacheagesec",
    "cooldownactive",
    "cooldownremainingsec",
    "fadeseconds",
    "lastaddress",
    "targetmac",
    "nameprefix",
    "tx",
    "infohex",
    "laststatushex",
    "token",
    "secret",
    "password",
    "cookies",
    "rawadv",
    "impedances",
    "adcs",
    "configpath",
    "datadir",
    "errorcode",
}

SCALAR_KEY_TRANSLATIONS: Dict[str, Tuple[str, str]] = {
    "batterypct": ("电量", "%"),
    "batterypercent": ("电量", "%"),
    "battery": ("电量", "%"),
    "activemode": ("当前模式", ""),
    "mode": ("当前模式", ""),
    "todaycount": ("今日次数", "次"),
    "streakdays": ("连续打卡", "天"),
    "brushheaddaysleft": ("刷头剩余", "天"),
    "daysleft": ("剩余天数", "天"),
    "percentleft": ("剩余寿命", "%"),
    "temperature": ("温度", "°C"),
    "tempc": ("温度", "°C"),
    "temp": ("温度", "°C"),
    "humidity": ("湿度", "%"),
    "hum": ("湿度", "%"),
    "brightness": ("亮度", "%"),
    "volume": ("音量", "%"),
    "online": ("在线", ""),
    "status": ("状态", ""),
    "state": ("状态", ""),
    "enabled": ("启用", ""),
    "active": ("活跃", ""),
    "powerstate": ("电源状态", ""),
    "authstate": ("认证状态", ""),
    "charging": ("充电状态", ""),
    "durationsec": ("时长", "秒"),
    "dailygoal": ("每日目标", "次"),
    "dailygoalcount": ("每日目标", "次"),
    "strength": ("振动强度", ""),
    "range": ("扫幅", ""),
    "speed": ("扫速", ""),
    "count": ("数量", ""),
    "total": ("总数", ""),
    "red": ("红光", "%"),
    "green": ("绿光", "%"),
    "white": ("白光", "%"),
    "blue": ("蓝光", "%"),
    "fan": ("风扇", "档"),
}

SCALAR_VALUE_ZH: Dict[str, str] = {
    "online": "在线",
    "offline": "离线",
    "running": "运行中",
    "idle": "待命",
    "true": "是",
    "false": "否",
    "standby_or_off": "待机",
    "authenticated": "已登录",
    "unauthenticated": "未绑定",
    "pending_2fa": "待验证",
    "expired": "已过期",
    "charging": "充电中",
    "notcharging": "未充电",
    "charged": "已充满",
    "watching": "监听中",
    "stopped": "已停止",
    "starting": "启动中",
    "completed": "已完成",
    "ready": "就绪",
}

WMO_WEATHER_ZH: Dict[int, str] = {
    0: "晴",
    1: "晴间少云",
    2: "多云",
    3: "阴",
    4: "霾",
    45: "雾",
    48: "冻雾",
    51: "毛毛雨",
    53: "小雨",
    55: "中雨",
    56: "冻毛毛雨",
    57: "强冻毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    66: "小冻雨",
    67: "大冻雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    77: "米雪",
    80: "阵雨",
    81: "强阵雨",
    82: "暴雨",
    85: "小阵雪",
    86: "大阵雪",
    95: "雷阵雨",
    96: "雷阵雨伴冰雹",
    99: "强雷阵雨",
}

CITY_COORDS_ZH: Dict[str, Tuple[float, float]] = {
    "上海": (31.2304, 121.4737),
    "北京": (39.9042, 116.4074),
    "深圳": (22.5431, 114.0579),
    "广州": (23.1291, 113.2644),
    "杭州": (30.2741, 120.1551),
    "西安": (34.2658, 108.9541),
    "成都": (30.5728, 104.0668),
    "重庆": (29.5630, 106.5516),
    "武汉": (30.5928, 114.3055),
    "南京": (32.0603, 118.7969),
    "苏州": (31.2989, 120.5853),
    "天津": (39.3434, 117.3616),
    "长沙": (28.2282, 112.9388),
    "郑州": (34.7466, 113.6253),
    "青岛": (36.0671, 120.3826),
    "厦门": (24.4798, 118.0894),
    "香港": (22.3193, 114.1694),
    "台北": (25.0330, 121.5654),
}


def _resolve_city_coords(city: str) -> Optional[Tuple[float, float]]:
    clean = str(city or "").strip()
    if not clean:
        return None
    if clean in CITY_COORDS_ZH:
        return CITY_COORDS_ZH[clean]
    stripped = clean.rstrip("市区县")
    if stripped and stripped in CITY_COORDS_ZH:
        return CITY_COORDS_ZH[stripped]
    return None


def default_pages_payload() -> List[Dict[str, Any]]:
    return [
        {
            "id": "overview",
            "name": "日常总览",
            "cards": [
                {"id": "c-fund", "kind": "fund-tracker", "size": "1x1"},
                {"id": "c-health", "kind": "health-scale", "size": "1x1"},
                {"id": "c-miot", "kind": "miot", "size": "1x1"},
                {"id": "c-weather", "kind": "weather", "size": "1x1"},
            ],
        },
        {
            "id": "mobility",
            "name": "出行与随身",
            "cards": [
                {"id": "c-ninebot", "kind": "ninebot", "size": "2x1"},
                {"id": "c-apple", "kind": "apple-devices", "size": "2x1"},
            ],
        },
        {
            "id": "care-eco",
            "name": "个护与生态",
            "cards": [
                {"id": "c-laifen", "kind": "laifen", "size": "2x1"},
                {"id": "c-netlea", "kind": "netlea", "size": "2x1"},
            ],
        },
        {
            "id": "media-hub",
            "name": "影音与中枢",
            "cards": [
                {"id": "c-tv", "kind": "tv-agent", "size": "1x1"},
                {"id": "c-tv-ir", "kind": "tv-ir", "size": "1x1"},
                {"id": "c-sys", "kind": "system-pulse", "size": "1x1"},
                {"id": "c-timers", "kind": "timers", "size": "1x1"},
            ],
        },
        {
            "id": "brain-compute",
            "name": "主脑与算力",
            "cards": [
                {"id": "c-memory", "kind": "memory", "size": "2x1"},
                {"id": "c-usage", "kind": "usage", "size": "1x1"},
                {"id": "c-workers", "kind": "workers", "size": "1x1"},
            ],
        },
    ]


def default_layout_dict() -> Dict[str, Any]:
    return {
        "version": 1,
        "gridRows": 2,
        "marqueeMode": "auto_pause",
        "marqueeSpeed": 2,
        "pageRotateSec": 20,
        "autoTaskOverlay": True,
        "activePage": 0,
        "weatherCity": "上海",
        "weatherLat": 31.23,
        "weatherLon": 121.47,
        "pages": default_pages_payload(),
    }


def _clean_size(raw: Any, fallback: str = "1x1") -> str:
    s = str(raw or "").strip().lower()
    return s if s in VALID_SIZES else fallback


def parse_card_span(size: str) -> Tuple[int, int]:
    norm = _clean_size(size)
    parts = norm.split("x")
    return int(parts[0]), int(parts[1])


@dataclass(frozen=True)
class PlacedCard:
    card_id: str
    kind: str
    col: int
    row: int
    w_span: int
    h_span: int
    configured_size: str
    effective_size: str
    x: float
    y: float
    w: float
    h: float
    title: str = ""
    plugin: str = ""
    action: str = ""
    ttl_sec: int = 120


def pack_bento_page(
    cards: Sequence[Dict[str, Any]],
    grid_rows: int = 2,
    *,
    x0: float = 36.0,
    y0: float = 710.0,
    total_w: float = 728.0,
    total_h: float = 492.0,
    gap: float = 16.0,
) -> Tuple[List[PlacedCard], int]:
    """Pack variable-sized Bento cards (1x1, 2x1, 1x2, 2x2) into a 2 x grid_rows layout."""
    rows = 3 if int(grid_rows) == 3 else 2
    cols = 2
    occupied = [[False] * cols for _ in range(rows)]
    col_w = (total_w - gap * (cols - 1)) / float(cols)
    row_h = (total_h - gap * (rows - 1)) / float(rows)

    placed: List[PlacedCard] = []
    overflow = 0

    def try_fit(ew: int, eh: int) -> Optional[Tuple[int, int]]:
        for r in range(rows - eh + 1):
            for c in range(cols - ew + 1):
                if all(not occupied[r + dr][c + dc] for dr in range(eh) for dc in range(ew)):
                    return r, c
        return None

    for idx, card in enumerate(cards):
        if not isinstance(card, dict):
            continue
        kind = str(card.get("kind") or "").strip()
        if not kind:
            continue
        cfg_size = _clean_size(card.get("size"), "1x1")
        req_w, req_h = parse_card_span(cfg_size)

        candidates: List[Tuple[int, int]] = [(req_w, req_h)]
        if req_h == 2:
            candidates.append((req_w, 1))
        if req_w == 2:
            candidates.append((1, min(req_h, 1)))

        chosen: Optional[Tuple[int, int, int, int]] = None
        for cw, ch in candidates:
            if ch > rows:
                continue
            pos = try_fit(cw, ch)
            if pos is not None:
                chosen = (pos[0], pos[1], cw, ch)
                break

        if chosen is None:
            overflow += 1
            continue

        r0, c0, ew, eh = chosen
        for dr in range(eh):
            for dc in range(ew):
                occupied[r0 + dr][c0 + dc] = True

        px = x0 + c0 * (col_w + gap)
        py = y0 + r0 * (row_h + gap)
        pw = col_w * ew + gap * (ew - 1)
        ph = row_h * eh + gap * (eh - 1)
        plugin_name = str(card.get("plugin") or (kind[7:] if kind.startswith("plugin:") else ""))
        try:
            ttl_raw = int(card.get("ttlSec") or 120)
        except (TypeError, ValueError):
            ttl_raw = 120
        placed.append(
            PlacedCard(
                card_id=str(card.get("id") or f"card-{idx + 1}"),
                kind=kind,
                col=c0,
                row=r0,
                w_span=ew,
                h_span=eh,
                configured_size=cfg_size,
                effective_size=f"{ew}x{eh}",
                x=px,
                y=py,
                w=pw,
                h=ph,
                title=str(card.get("title") or ""),
                plugin=plugin_name,
                action=str(card.get("action") or ""),
                ttl_sec=max(15, min(3600, ttl_raw)),
            )
        )

    return placed, overflow


def _sanitize_card(raw: Any, fallback_id: str) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("kind") or "").strip()[:64]
    if not kind:
        return None
    migrated_builtin = False
    if kind.startswith("plugin:") and kind[7:] in BUILTIN_PLUGIN_WIDGETS:
        kind = kind[7:]
        migrated_builtin = True
    card_id = re.sub(r"[^a-zA-Z0-9_-]", "", str(raw.get("id") or fallback_id))[:40] or fallback_id
    out: Dict[str, Any] = {
        "id": card_id,
        "kind": kind,
        "size": _clean_size(raw.get("size"), "1x1"),
    }
    if not migrated_builtin:
        if raw.get("plugin"):
            out["plugin"] = str(raw["plugin"]).strip()[:64]
        elif kind.startswith("plugin:"):
            out["plugin"] = kind[7:][:64]
        if raw.get("action"):
            out["action"] = str(raw["action"]).strip()[:64]
    if raw.get("title"):
        raw_title = str(raw["title"]).strip()[:48]
        if not (migrated_builtin and ("(" in raw_title or len(raw_title) > 10)):
            out["title"] = raw_title
    if raw.get("ttlSec") is not None:
        try:
            out["ttlSec"] = max(15, min(3600, int(raw["ttlSec"])))
        except (TypeError, ValueError):
            pass
    return out


def _sanitize_pages(raw_pages: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw_pages, list) or not raw_pages:
        return default_pages_payload()
    pages: List[Dict[str, Any]] = []
    seen_ids: Set[str] = set()
    for p_idx, raw_p in enumerate(raw_pages[:6]):
        if not isinstance(raw_p, dict):
            continue
        pid = re.sub(r"[^a-zA-Z0-9_-]", "", str(raw_p.get("id") or f"page-{p_idx + 1}"))[:32] or f"page-{p_idx + 1}"
        while pid in seen_ids:
            pid = f"{pid}-{p_idx + 1}"
        seen_ids.add(pid)
        pname = str(raw_p.get("name") or f"页面 {p_idx + 1}").strip()[:24] or f"页面 {p_idx + 1}"
        cards: List[Dict[str, Any]] = []
        raw_cards = raw_p.get("cards") if isinstance(raw_p.get("cards"), list) else []
        for c_idx, raw_c in enumerate(raw_cards[:8]):
            sanitized = _sanitize_card(raw_c, f"{pid}-c{c_idx + 1}")
            if sanitized is not None:
                cards.append(sanitized)
        pages.append({"id": pid, "name": pname, "cards": cards})
    return pages or default_pages_payload()


class LayoutStore:
    """Thread-safe atomic JSON store for CS80 Bento deck & display preferences."""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = Path(data_dir)
        self.path = self.data_dir / "layout.json"
        self._lock = threading.Lock()
        self.revision: int = 1
        self._config: Dict[str, Any] = self._load_from_disk()

    def _normalize(self, raw: Dict[str, Any], base: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        merged = dict(base or default_layout_dict())
        for key in (
            "gridRows",
            "marqueeMode",
            "marqueeSpeed",
            "pageRotateSec",
            "autoTaskOverlay",
            "activePage",
            "weatherCity",
            "weatherLat",
            "weatherLon",
            "pages",
        ):
            if key in raw and raw[key] is not None:
                merged[key] = raw[key]

        try:
            grid_rows = 3 if int(merged.get("gridRows") or 2) == 3 else 2
        except (TypeError, ValueError):
            grid_rows = 2
        marquee_mode = str(merged.get("marqueeMode") or "auto_pause").strip()
        if marquee_mode not in VALID_MARQUEE_MODES:
            marquee_mode = "auto_pause"
        try:
            marquee_speed = max(1, min(3, int(merged.get("marqueeSpeed") or 2)))
        except (TypeError, ValueError):
            marquee_speed = 2
        try:
            rotate_sec = int(merged.get("pageRotateSec") if merged.get("pageRotateSec") is not None else 20)
        except (TypeError, ValueError):
            rotate_sec = 20
        rotate_sec = 0 if rotate_sec <= 0 else max(10, min(180, rotate_sec))
        pages = _sanitize_pages(merged.get("pages"))
        try:
            active_page = int(merged.get("activePage") or 0)
        except (TypeError, ValueError):
            active_page = 0
        active_page = max(0, min(len(pages) - 1, active_page))
        weather_city = str(merged.get("weatherCity") or "上海").strip()[:24] or "上海"
        try:
            lat_f = float(merged.get("weatherLat") if merged.get("weatherLat") is not None else 31.23)
            weather_lat = max(-85.0, min(85.0, lat_f)) if math.isfinite(lat_f) else 31.23
        except (TypeError, ValueError):
            weather_lat = 31.23
        try:
            lon_f = float(merged.get("weatherLon") if merged.get("weatherLon") is not None else 121.47)
            weather_lon = max(-180.0, min(180.0, lon_f)) if math.isfinite(lon_f) else 121.47
        except (TypeError, ValueError):
            weather_lon = 121.47

        has_raw_city = isinstance(raw.get("weatherCity"), str) and bool(str(raw.get("weatherCity")).strip())
        has_raw_coords = (
            ("weatherLat" in raw and raw["weatherLat"] is not None)
            or ("weatherLon" in raw and raw["weatherLon"] is not None)
        )
        is_default_shanghai_coords = (round(weather_lat, 2), round(weather_lon, 2)) == (31.23, 121.47)
        if (has_raw_city and not has_raw_coords) or (weather_city != "上海" and is_default_shanghai_coords):
            resolved = _resolve_city_coords(weather_city)
            if resolved is not None:
                weather_lat, weather_lon = resolved

        return {
            "version": 1,
            "gridRows": grid_rows,
            "marqueeMode": marquee_mode,
            "marqueeSpeed": marquee_speed,
            "pageRotateSec": rotate_sec,
            "autoTaskOverlay": bool(merged.get("autoTaskOverlay", True)),
            "activePage": active_page,
            "weatherCity": weather_city,
            "weatherLat": round(weather_lat, 4),
            "weatherLon": round(weather_lon, 4),
            "pages": pages,
        }

    def _load_from_disk(self) -> Dict[str, Any]:
        if self.path.is_file():
            try:
                parsed = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(parsed, dict):
                    return self._normalize(parsed)
            except (OSError, ValueError):
                pass
        return default_layout_dict()

    def _save_to_disk(self, cfg: Dict[str, Any]) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.data_dir / f".layout.{os.getpid()}.tmp"
        tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, self.path)

    def get(self) -> Dict[str, Any]:
        with self._lock:
            return json.loads(json.dumps(self._config))

    def active_card_kinds(self) -> Set[str]:
        with self._lock:
            kinds: Set[str] = set()
            for page in self._config.get("pages") or []:
                for card in page.get("cards") or []:
                    k = str(card.get("kind") or "").strip()
                    if k:
                        kinds.add(k)
            return kinds

    def all_cards(self) -> List[Dict[str, Any]]:
        with self._lock:
            out: List[Dict[str, Any]] = []
            for page in self._config.get("pages") or []:
                for card in page.get("cards") or []:
                    out.append(dict(card))
            return out

    def step_rotation(self, step_delta: int = 1) -> int:
        with self._lock:
            pages = self._config.get("pages") or []
            if len(pages) <= 1:
                return 0
            nxt = (int(self._config.get("activePage") or 0) + step_delta) % len(pages)
            self._config["activePage"] = nxt
            self.revision += 1
            return nxt

    def apply_patch(self, patch: Dict[str, Any]) -> Tuple[Dict[str, Any], bool, Set[str]]:
        with self._lock:
            prev_rows = int(self._config.get("gridRows") or 2)
            prev_kinds = {
                str(c.get("kind") or "")
                for p in self._config.get("pages") or []
                for c in p.get("cards") or []
            }
            src = dict(patch.get("layout")) if isinstance(patch.get("layout"), dict) else dict(patch)
            if src.get("reset") is True:
                reset_src = default_layout_dict()
                if self._config.get("weatherCity"):
                    reset_src["weatherCity"] = self._config["weatherCity"]
                    reset_src["weatherLat"] = self._config["weatherLat"]
                    reset_src["weatherLon"] = self._config["weatherLon"]
                for key in (
                    "gridRows",
                    "marqueeMode",
                    "marqueeSpeed",
                    "pageRotateSec",
                    "autoTaskOverlay",
                    "activePage",
                    "weatherCity",
                    "weatherLat",
                    "weatherLon",
                ):
                    if key in src and src[key] is not None:
                        reset_src[key] = src[key]
                src = reset_src
            nxt = self._normalize(src, base=self._config)
            self._config = nxt
            self.revision += 1
            self._save_to_disk(nxt)
            new_kinds = {
                str(c.get("kind") or "")
                for p in nxt.get("pages") or []
                for c in p.get("cards") or []
            }
            return json.loads(json.dumps(nxt)), int(nxt["gridRows"]) != prev_rows, (new_kinds - prev_kinds)


def _read_plugin_manifests_from_dir(root: Path, bucket: Dict[str, Dict[str, Any]]) -> None:
    if not root.is_dir():
        return
    try:
        children = sorted(root.iterdir(), key=lambda p: p.name)
    except OSError:
        return
    for d in children:
        if not d.is_dir() or d.name.startswith("_") or d.name == "cs80-face":
            continue
        pjson = d / "plugin.json"
        if not pjson.is_file():
            continue
        try:
            raw = json.loads(pjson.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or d.name).strip()
        if not name or name == "cs80-face":
            continue
        actions = [str(a) for a in (raw.get("actions") or ["status"]) if str(a).strip()]
        bucket[name] = {
            "name": name,
            "title": str(raw.get("title") or name),
            "description": str(raw.get("description") or raw.get("promptHint") or ""),
            "actions": actions or ["status"],
            "enabled": raw.get("enabled") is not False,
        }


def discover_widget_catalog(
    friday_home: Path,
    view_plugins: Sequence[Dict[str, Any]] = (),
    repo_plugins_dir: Optional[Path] = None,
) -> List[Dict[str, Any]]:
    """Build catalog of all built-in plugins, Friday core telemetry cards, and custom plugins."""
    manifests: Dict[str, Dict[str, Any]] = {}
    repo_dir = repo_plugins_dir or (Path(__file__).resolve().parent.parent.parent / "plugins")
    _read_plugin_manifests_from_dir(repo_dir, manifests)
    _read_plugin_manifests_from_dir(Path(friday_home) / "plugins", manifests)
    for item in view_plugins:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name or name == "cs80-face":
            continue
        prev = manifests.get(name, {})
        actions = [str(a) for a in (item.get("actions") or prev.get("actions") or ["status"]) if str(a).strip()]
        manifests[name] = {
            "name": name,
            "title": str(item.get("title") or prev.get("title") or name),
            "description": str(item.get("description") or item.get("promptHint") or prev.get("description") or ""),
            "actions": actions,
            "enabled": item.get("enabled") is not False,
        }

    catalog: List[Dict[str, Any]] = [
        {
            "kind": "fund-tracker",
            "category": "plugin",
            "plugin": "fund-tracker",
            "title": "投资收益",
            "subtitle": "实时估值 · 当日盈亏 · 收益走势与重仓明细",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": manifests.get("fund-tracker", {}).get("enabled", True),
        },
        {
            "kind": "health-scale",
            "category": "plugin",
            "plugin": "health-scale",
            "title": "体脂健康",
            "subtitle": "体重曲线 · 体脂肌肉率 · 身体评分与成分",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": manifests.get("health-scale", {}).get("enabled", True),
        },
        {
            "kind": "miot",
            "category": "plugin",
            "plugin": "miot",
            "title": "全屋智能",
            "subtitle": "环境温湿度 · 房间设备在线与开关矩阵",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": manifests.get("miot", {}).get("enabled", True),
        },
        {
            "kind": "ninebot",
            "category": "plugin",
            "plugin": "ninebot",
            "title": "九号座驾",
            "subtitle": "电量与续航 · 充电功率 · 锁车安防与停放位置",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": manifests.get("ninebot", {}).get("enabled", True),
        },
        {
            "kind": "laifen",
            "category": "plugin",
            "plugin": "laifen",
            "title": "徕芬电动牙刷",
            "subtitle": "牙刷电量 · 护齿模式 · 刷牙打卡与刷头寿命",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": manifests.get("laifen", {}).get("enabled", True),
        },
        {
            "kind": "netlea",
            "category": "plugin",
            "plugin": "netlea",
            "title": "尼特利鱼缸灯",
            "subtitle": "灯具状态 · 四通道光谱比例 · 自动日出日落",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": manifests.get("netlea", {}).get("enabled", True),
        },
        {
            "kind": "apple-devices",
            "category": "plugin",
            "plugin": "apple-devices",
            "title": "苹果设备",
            "subtitle": "多设备电量 · 充电状态 · 常用地点守护",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": manifests.get("apple-devices", {}).get("enabled", True),
        },
        {
            "kind": "tv-agent",
            "category": "plugin",
            "plugin": "tv-agent",
            "title": "客厅电视",
            "subtitle": "播放与待机 · 当前应用 · 音量状态",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": manifests.get("tv-agent", {}).get("enabled", True),
        },
        {
            "kind": "tv-ir",
            "category": "plugin",
            "plugin": "tv-ir",
            "title": "电视遥控",
            "subtitle": "全向红外控制 · 快捷按键与自学习指令",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": manifests.get("tv-ir", {}).get("enabled", True),
        },
        {
            "kind": "system-pulse",
            "category": "core",
            "title": "主机脉搏",
            "subtitle": "处理器与内存 · 磁盘空间 · 近期日程",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": True,
        },
        {
            "kind": "memory",
            "category": "core",
            "title": "突触记忆",
            "subtitle": "长期记忆库 · 核心置顶 · 关联知识星图",
            "defaultSize": "2x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": True,
        },
        {
            "kind": "timers",
            "category": "core",
            "title": "日程与巡检",
            "subtitle": "今日待触发提醒 · 周期巡检与目标追踪",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": True,
        },
        {
            "kind": "usage",
            "category": "core",
            "title": "今日算力",
            "subtitle": "模型调用次数 · 算力消耗与今日账单",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": True,
        },
        {
            "kind": "weather",
            "category": "core",
            "title": "本地气象",
            "subtitle": "实时气温 · 天气状况 · 高低温与风湿实况",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": True,
        },
        {
            "kind": "workers",
            "category": "core",
            "title": "后台任务",
            "subtitle": "并发智能体进度 · 运行耗时与请示状态",
            "defaultSize": "2x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": True,
        },
    ]

    for name, info in sorted(manifests.items()):
        if name in BUILTIN_PLUGIN_WIDGETS:
            continue
        actions = info.get("actions") or ["status"]
        default_act = "dashboard" if "dashboard" in actions else ("status" if "status" in actions else actions[0])
        catalog.append(
            {
                "kind": f"plugin:{name}",
                "category": "custom_plugin",
                "plugin": name,
                "title": info.get("title") or name,
                "subtitle": (info.get("description") or "扩展插件实时状态")[:68],
                "actions": actions,
                "defaultAction": default_act,
                "configurableAction": True,
                "defaultSize": "1x1",
                "supportedSizes": list(VALID_SIZES),
                "enabled": info.get("enabled", True),
            }
        )

    return catalog


def _is_market_hours_now(now_ts: Optional[float] = None) -> bool:
    ts = time.time() if now_ts is None else float(now_ts)
    if _SHANGHAI_TZ is not None:
        dt = datetime.fromtimestamp(ts, tz=_SHANGHAI_TZ)
        wday = dt.weekday()
        hm = dt.hour * 60 + dt.minute
    else:
        lt = time.localtime(ts)
        wday = lt.tm_wday
        hm = lt.tm_hour * 60 + lt.tm_min
    is_mon_to_fri = 0 <= wday <= 4
    is_tue_to_sat = 1 <= wday <= 5
    if is_mon_to_fri and ((9 * 60 + 15 <= hm <= 16 * 60 + 15) or hm >= 21 * 60):
        return True
    if is_tue_to_sat and hm <= 5 * 60:
        return True
    return False


def _fmt_money(v: float) -> str:
    sign = "+" if v > 0 else ("-" if v < 0 else "")
    av = abs(v)
    if av >= 100_000:
        return f"{sign}{av / 10000.0:.2f}万"
    return f"{sign}{av:,.0f}"


def _is_scalar_key_blocked(key: str) -> bool:
    ks = str(key).strip()
    if not ks:
        return True
    kl = ks.lower()
    if kl in SCALAR_INTERNAL_BLOCKLIST:
        return True
    if ks.endswith(("Id", "At", "Hex", "Path", "Url", "Mac", "ID", "URL", "MAC")):
        return True
    if kl.endswith(("_id", "_at", "_hex", "_path", "_url", "_mac")):
        return True
    return False


def _extract_scalars(obj: Any, prefix: str = "", out: Optional[List[Tuple[str, str]]] = None) -> List[Tuple[str, str]]:
    if out is None:
        out = []
    if len(out) >= 6 or obj is None:
        return out
    if isinstance(obj, dict):
        for k, v in obj.items():
            if len(out) >= 6:
                break
            ks = str(k).strip()
            if _is_scalar_key_blocked(ks):
                continue
            kl = ks.lower()
            lbl, unit = SCALAR_KEY_TRANSLATIONS.get(kl, (ks, ""))
            if isinstance(v, bool):
                val = "是" if v else "否"
                out.append((lbl[:12], val[:18]))
            elif isinstance(v, (int, float)):
                num_s = f"{v:.2f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)
                val = f"{num_s}{unit}" if unit else num_s
                out.append((lbl[:12], val[:18]))
            elif isinstance(v, str):
                sv = v.strip()
                if not sv or len(sv) > 26:
                    continue
                mapped = SCALAR_VALUE_ZH.get(sv.lower())
                val = mapped if mapped is not None else sv
                out.append((lbl[:12], val[:18]))
            elif isinstance(v, dict) and not prefix:
                _extract_scalars(v, ks, out)
    return out


def _is_pid_alive(pid: Any) -> bool:
    try:
        p = int(pid)
    except (TypeError, ValueError):
        return False
    if p <= 0:
        return False
    try:
        os.kill(p, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def _connect_ro_sqlite(db_path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"{db_path.resolve().as_uri()}?mode=ro", uri=True, timeout=1.0)


def _coerce_int(val: Any, default: int) -> int:
    if isinstance(val, bool) or val is None:
        return default
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def _haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> int:
    r = 6_371_000.0
    to_rad = math.pi / 180.0
    d_lat = (lat2 - lat1) * to_rad
    d_lon = (lon2 - lon1) * to_rad
    a = (math.sin(d_lat * 0.5) ** 2) + math.cos(lat1 * to_rad) * math.cos(lat2 * to_rad) * (math.sin(d_lon * 0.5) ** 2)
    return int(round(2.0 * r * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))))


def _wgs84_to_gcj02(lat: float, lon: float) -> Tuple[float, float]:
    """Convert WGS-84 coordinates into GCJ-02 inside Mainland China; return unchanged outside China."""
    if (lat == 0.0 and lon == 0.0) or not (72.004 < lon < 137.8347 and 0.8293 < lat < 55.8271):
        return (round(lat, 6), round(lon, 6))
    a = 6378245.0
    ee = 0.00669342162296594323
    x = lon - 105.0
    y = lat - 35.0
    d_lat = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    d_lat += ((20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0) / 3.0
    d_lat += ((20.0 * math.sin(y * math.pi) + 40.0 * math.sin((y / 3.0) * math.pi)) * 2.0) / 3.0
    d_lat += ((160.0 * math.sin((y / 12.0) * math.pi) + 320.0 * math.sin((y * math.pi) / 30.0)) * 2.0) / 3.0
    d_lon = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    d_lon += ((20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0) / 3.0
    d_lon += ((20.0 * math.sin(x * math.pi) + 40.0 * math.sin((x / 3.0) * math.pi)) * 2.0) / 3.0
    d_lon += ((150.0 * math.sin((x / 12.0) * math.pi) + 300.0 * math.sin((x / 30.0) * math.pi)) * 2.0) / 3.0
    rad_lat = (lat / 180.0) * math.pi
    magic = math.sin(rad_lat)
    magic = 1.0 - ee * magic * magic
    sqrt_magic = math.sqrt(magic)
    d_lat = (d_lat * 180.0) / (((a * (1.0 - ee)) / (magic * sqrt_magic)) * math.pi)
    d_lon = (d_lon * 180.0) / ((a / sqrt_magic) * math.cos(rad_lat) * math.pi)
    return (round(lat + d_lat, 6), round(lon + d_lon, 6))


def _normalize_tv_app_name(app_name: Any, package_name: Any, *, online: bool) -> str:
    pkg = str(package_name or "").strip()
    raw_app = str(app_name or "").strip()
    if pkg:
        direct = TV_APP_NAME_ZH.get(pkg.lower())
        if direct:
            return direct
    probe = f"{pkg} {raw_app}".lower()
    if any(t in probe for t in ("bili", "小电视", "哔哩")):
        return "哔哩哔哩"
    if any(t in probe for t in ("ktcp", "qqlive", "云视听", "极光")):
        return "云视听极光"
    if any(t in probe for t in ("qiyi", "gitv", "奇异果")):
        return "银河奇异果"
    if any(t in probe for t in ("youku", "cibn", "酷喵")):
        return "酷喵影视"
    if any(t in probe for t in ("smarttube", "youtube")):
        return "YouTube"
    if any(t in probe for t in ("kodi", "vlc", "nova", "mxtech", "plex", "emby", "jellyfin", "mediaexplorer", "本地影院")):
        return "本地影院"
    if any(t in probe for t in ("tvhome", "launcher", "电视桌面")):
        return "电视桌面"
    if raw_app and "." not in raw_app:
        return raw_app[:16]
    if pkg and "." not in pkg:
        return pkg[:16]
    return "电视桌面" if online else "已待机"


def _is_miot_bridge_node(d: Dict[str, Any]) -> bool:
    cat = str(d.get("category") or "").strip().lower()
    ch = str(d.get("controlChannel") or "").strip().lower()
    urn = str(d.get("urn") or "").strip().lower()
    model = str(d.get("model") or "").strip().lower()
    name = str(d.get("dev_name") or d.get("name") or "").strip().lower()
    if cat in ("router", "gateway", "hub", "bridge") or ch == "router":
        return True
    if any(t in urn for t in (":gateway:", ":router:", ":mesh-gateway:", ":ble-gateway:")):
        return True
    if any(t in model for t in (".router.", ".gateway.", "gateway", "bridge")):
        return True
    if (not d.get("controllable")) and any(t in name for t in ("网关", "中枢", "路由器", "gateway", "bridge", "hub")):
        return True
    return False


def _coerce_float(val: Any) -> Optional[float]:
    if isinstance(val, bool) or val is None:
        return None
    try:
        f = float(val)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def _extract_miot_env(raw_devices: Sequence[Dict[str, Any]]) -> Tuple[Optional[float], Optional[float]]:
    temp_val: Optional[float] = None
    hum_val: Optional[float] = None
    temp_keys = ("temperature", "envtemp", "indoortemp", "currenttemperature", "temp")
    hum_keys = ("humidity", "envhum", "indoorhumidity", "relativehumidity", "hum")
    for d in raw_devices:
        if not isinstance(d, dict):
            continue
        cat = str(d.get("category") or "").lower()
        if cat == "air_fryer":
            continue
        state = d.get("state") if isinstance(d.get("state"), dict) else {}
        cached = d.get("cachedState") if isinstance(d.get("cachedState"), dict) else {}
        raw_keys = cached.get("rawKeys") if isinstance(cached.get("rawKeys"), dict) else {}
        props = cached.get("properties") if isinstance(cached.get("properties"), dict) else {}

        for source in (d, state, raw_keys):
            for k, raw_v in source.items():
                kl = str(k).lower()
                val = raw_v.get("value") if isinstance(raw_v, dict) else raw_v
                num = _coerce_float(val)
                if num is None:
                    continue
                if temp_val is None and kl in temp_keys and -20.0 <= num <= 55.0:
                    temp_val = round(num, 1)
                if hum_val is None and kl in hum_keys and 0.0 <= num <= 100.0:
                    hum_val = round(num, 1)

        # Fallback: MIoT sensor properties when device metadata identifies an env sensor
        probe = f"{d.get('urn') or ''} {d.get('model') or ''} {d.get('dev_name') or d.get('name') or ''} {cat}".lower()
        is_env_sensor = any(t in probe for t in ("sensor_ht", "thermometer", "hygrometer", "temperature-humidity", "environment", "温湿度", "湿度计", "温度计"))
        if is_env_sensor and isinstance(props, dict):
            for pk in ("2.1", "2.7", "3.1"):
                if temp_val is not None:
                    break
                entry = props.get(pk)
                num = _coerce_float(entry.get("value") if isinstance(entry, dict) else entry)
                if num is not None and -20.0 <= num <= 55.0:
                    temp_val = round(num, 1)
            for pk in ("2.2", "2.8", "3.2"):
                if hum_val is not None:
                    break
                entry = props.get(pk)
                num = _coerce_float(entry.get("value") if isinstance(entry, dict) else entry)
                if num is not None and 0.0 <= num <= 100.0:
                    hum_val = round(num, 1)

        if temp_val is not None and hum_val is not None:
            break
    return temp_val, hum_val


class WidgetDataHub:
    """Low-resource lazy TTL & local-cache-first telemetry collector for CS80 Bento cards."""

    def __init__(
        self,
        friday_home: Path,
        rpc_fn: Callable[[Dict[str, Any], float], Any],
        layout_store: LayoutStore,
        *,
        disable_network: bool = False,
    ) -> None:
        self.home = Path(friday_home)
        self._rpc = rpc_fn
        self.layout_store = layout_store
        self.disable_network = disable_network

        self._lock = threading.Lock()
        self._data: Dict[str, Dict[str, Any]] = {}
        self._hashes: Dict[str, str] = {}
        self._last_poll_at: Dict[str, float] = {}
        self._last_mtime: Dict[str, float] = {}
        self._last_live_attempt_at: Dict[str, float] = {}
        self._last_proc_cpu: Optional[Tuple[int, int]] = None
        self._force_kinds: Set[str] = set()
        self.data_rev: int = 1

    def trigger_refresh(self, kinds: Optional[Iterable[str]] = None) -> None:
        with self._lock:
            if kinds is None:
                for k in self.layout_store.active_card_kinds():
                    self._force_kinds.add(k)
            else:
                for k in kinds:
                    self._force_kinds.add(str(k))

    def _store_widget(self, key: str, payload: Dict[str, Any]) -> bool:
        encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
        with self._lock:
            if self._hashes.get(key) == encoded:
                return False
            self._hashes[key] = encoded
            self._data[key] = payload
            self.data_rev += 1
            return True

    def get_widget(self, kind: str, card_id: str = "") -> Dict[str, Any]:
        with self._lock:
            if kind.startswith("plugin:") and card_id:
                key = f"{kind}#{card_id}"
                if key in self._data:
                    return dict(self._data[key])
            return dict(self._data.get(kind) or {})

    def snapshot_all(self) -> Tuple[int, Dict[str, Dict[str, Any]]]:
        with self._lock:
            return self.data_rev, {k: dict(v) for k, v in self._data.items()}

    def get_summary_snapshot(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            now = time.monotonic()
            out: Dict[str, Dict[str, Any]] = {}
            for k, val in self._data.items():
                age = int(max(0.0, now - self._last_poll_at.get(k, now))) if k in self._last_poll_at else 0
                out[k] = {
                    "headline": str(val.get("headline") or val.get("title") or "--"),
                    "subline": str(val.get("subline") or ""),
                    "ok": bool(val.get("ok", True)),
                    "ageSec": age,
                }
            return out

    def refresh_due(self, last_view: Optional[Dict[str, Any]], *, connected: bool, force: bool = False) -> None:
        """Poll only configured widget kinds honoring local mtime & per-widget TTL."""
        now_mono = time.monotonic()
        cards = self.layout_store.all_cards()
        by_kind: Dict[str, Dict[str, Any]] = {}
        custom_cards: List[Dict[str, Any]] = []
        for c in cards:
            k = str(c.get("kind") or "").strip()
            if not k:
                continue
            if k.startswith("plugin:"):
                custom_cards.append(c)
            elif k not in by_kind:
                by_kind[k] = c

        # Fast in-memory derivations from FridayClient view (0 RPC overhead)
        if last_view is not None:
            for core_kind in ("memory", "timers", "usage", "workers"):
                if core_kind in by_kind:
                    self._collect_core_from_view(core_kind, last_view)

        if "system-pulse" in by_kind:
            if self._due("system-pulse", 10.0, now_mono, force=force):
                self._collect_system_pulse(last_view)

        if "fund-tracker" in by_kind:
            ttl = 60.0 if _is_market_hours_now() else 180.0
            db_path = self.home / "plugins" / "fund-tracker" / "funds.sqlite"
            wal_path = self.home / "plugins" / "fund-tracker" / "funds.sqlite-wal"
            m1 = self._file_mtime_changed("fund-tracker:db", db_path)
            m2 = self._file_mtime_changed("fund-tracker:wal", wal_path)
            if self._should_poll("fund-tracker", ttl, now_mono, force=force, mtime_changed=(m1 or m2)):
                self._collect_fund_tracker(db_path, connected=connected, allow_refresh=False)

        if "health-scale" in by_kind:
            db_path = self.home / "plugins" / "health-scale" / "health.db"
            wal_path = self.home / "plugins" / "health-scale" / "health.db-wal"
            sess_path = self.home / "plugins" / "health-scale" / "live-session.json"
            m1 = self._file_mtime_changed("health-scale:db", db_path)
            m2 = self._file_mtime_changed("health-scale:wal", wal_path)
            m3 = self._file_mtime_changed("health-scale:sess", sess_path)
            if self._should_poll("health-scale", 600.0, now_mono, force=force, mtime_changed=(m1 or m2 or m3)):
                self._collect_health_scale(db_path, connected=connected)

        if "miot" in by_kind:
            cache_path = self.home / "plugins" / "miot" / "hub-cache.json"
            m_changed = self._file_mtime_changed("miot:cache", cache_path)
            if self._should_poll("miot", 180.0, now_mono, force=force, mtime_changed=m_changed):
                self._collect_miot(cache_path, connected=connected)

        if "ninebot" in by_kind:
            db_path = self.home / "plugins" / "ninebot" / "ninebot.sqlite"
            wal_path = self.home / "plugins" / "ninebot" / "ninebot.sqlite-wal"
            img_path = self.home / "plugins" / "ninebot" / "vehicle-dark.png"
            m1 = self._file_mtime_changed("ninebot:db", db_path)
            m2 = self._file_mtime_changed("ninebot:wal", wal_path)
            m3 = self._file_mtime_changed("ninebot:img", img_path)
            if self._should_poll("ninebot", 180.0, now_mono, force=force, mtime_changed=(m1 or m2 or m3)):
                self._collect_ninebot(db_path, connected=connected)

        if "laifen" in by_kind:
            db_path = self.home / "plugins" / "laifen" / "laifen.db"
            wal_path = self.home / "plugins" / "laifen" / "laifen.db-wal"
            watch_path = self.home / "plugins" / "laifen" / "watch-state.json"
            sess_path = self.home / "plugins" / "laifen" / "live-session.json"
            m1 = self._file_mtime_changed("laifen:db", db_path)
            m2 = self._file_mtime_changed("laifen:wal", wal_path)
            m3 = self._file_mtime_changed("laifen:watch", watch_path)
            m4 = self._file_mtime_changed("laifen:sess", sess_path)
            if self._should_poll("laifen", 180.0, now_mono, force=force, mtime_changed=(m1 or m2 or m3 or m4)):
                self._collect_laifen(db_path, connected=connected)

        if "netlea" in by_kind:
            state_path = self.home / "plugins" / "netlea" / "last-state.json"
            cfg_path = self.home / "plugins" / "netlea" / "config.json"
            m1 = self._file_mtime_changed("netlea:state", state_path)
            m2 = self._file_mtime_changed("netlea:cfg", cfg_path)
            if self._should_poll("netlea", 180.0, now_mono, force=force, mtime_changed=(m1 or m2)):
                self._collect_netlea(state_path, connected=connected)

        if "apple-devices" in by_kind:
            cache_path = self.home / "plugins" / "apple-devices" / "devices-cache.json"
            sess_path = self.home / "plugins" / "apple-devices" / "session.json"
            m1 = self._file_mtime_changed("apple-devices:cache", cache_path)
            m2 = self._file_mtime_changed("apple-devices:sess", sess_path)
            if self._should_poll("apple-devices", 180.0, now_mono, force=force, mtime_changed=(m1 or m2)):
                self._collect_apple_devices(cache_path, connected=connected)

        if "tv-agent" in by_kind:
            if self._due("tv-agent", 45.0, now_mono, force=force):
                self._collect_tv_agent(connected=connected)

        if "tv-ir" in by_kind:
            if self._due("tv-ir", 300.0, now_mono, force=force):
                self._collect_tv_ir(connected=connected)

        if "weather" in by_kind:
            if self._due("weather", 600.0, now_mono, force=force):
                self._collect_weather()

        for c in custom_cards:
            cid = str(c.get("id") or "")
            k = str(c.get("kind") or "")
            key = f"{k}#{cid}" if cid else k
            ttl = float(max(15, min(3600, int(c.get("ttlSec") or 120))))
            if self._due(key, ttl, now_mono, force=force, alt_kind=k):
                self._collect_custom_plugin(key, c, connected=connected)

    def _should_poll(
        self,
        key: str,
        ttl: float,
        now_mono: float,
        *,
        force: bool = False,
        mtime_changed: bool = False,
    ) -> bool:
        return self._due(key, ttl, now_mono, force=(force or mtime_changed))

    def _due(self, key: str, ttl: float, now_mono: float, *, force: bool = False, alt_kind: str = "") -> bool:
        with self._lock:
            forced = (key in self._force_kinds) or (alt_kind and alt_kind in self._force_kinds)
            if forced:
                self._force_kinds.discard(key)
                if alt_kind:
                    self._force_kinds.discard(alt_kind)
                self._last_poll_at[key] = now_mono
                return True
            if force:
                self._last_poll_at[key] = now_mono
                return True
            last = self._last_poll_at.get(key)
            if last is None or (now_mono - last) >= ttl:
                self._last_poll_at[key] = now_mono
                return True
            return False

    def _file_mtime_changed(self, tag: str, path: Path) -> bool:
        try:
            mt = path.stat().st_mtime if path.exists() else -1.0
        except OSError:
            mt = -1.0
        with self._lock:
            prev = self._last_mtime.get(tag)
            if prev is None or abs(mt - prev) > 1e-6:
                self._last_mtime[tag] = mt
                return True
            return False

    def _can_attempt_live(self, key: str, cooldown_sec: float, now_mono: Optional[float] = None) -> bool:
        if self.disable_network:
            return False
        mono = time.monotonic() if now_mono is None else float(now_mono)
        with self._lock:
            last = self._last_live_attempt_at.get(key)
            if last is not None and (mono - last) < cooldown_sec:
                return False
            self._last_live_attempt_at[key] = mono
            return True

    def _is_ble_peer_busy(self) -> bool:
        now_wall = time.time()
        checks = (
            (self.home / "plugins" / "health-scale" / "live-session.json", 90.0, ("scanning", "connecting", "measuring")),
            (self.home / "plugins" / "laifen" / "live-session.json", 200.0, ("scanning", "connecting", "monitoring")),
            (self.home / "plugins" / "laifen" / "watch-state.json", 60.0, ("connecting", "syncing", "brushing")),
        )
        for path, max_age_sec, phases in checks:
            try:
                if not path.is_file():
                    continue
                st = path.stat()
                if (now_wall - st.st_mtime) >= max_age_sec:
                    continue
                raw = json.loads(path.read_text(encoding="utf-8"))
                phase = str((raw or {}).get("phase") or "").strip().lower() if isinstance(raw, dict) else ""
                if phase in phases:
                    return True
            except Exception:
                continue
        return False

    def _read_proc_cpu_pct(self) -> float:
        try:
            line = Path("/proc/stat").read_text(encoding="utf-8").splitlines()[0]
            nums = [int(x) for x in line.split()[1:8]]
            total = sum(nums)
            idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
            prev = self._last_proc_cpu
            self._last_proc_cpu = (total, idle)
            if prev is None:
                return 0.0
            dt_total = max(1, total - prev[0])
            dt_idle = max(0, idle - prev[1])
            return max(0.0, min(100.0, 100.0 * (dt_total - dt_idle) / dt_total))
        except Exception:
            return 0.0

    def _collect_system_pulse(self, view: Optional[Dict[str, Any]]) -> None:
        cpu_pct = self._read_proc_cpu_pct()
        mem_used_gb = 0.0
        mem_total_gb = 0.0
        mem_pct = 0.0
        try:
            kv: Dict[str, int] = {}
            for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
                parts = line.split(":")
                if len(parts) == 2:
                    kv[parts[0]] = int(parts[1].strip().split()[0])
            tot = kv.get("MemTotal", 0)
            avail = kv.get("MemAvailable", kv.get("MemFree", 0))
            if tot > 0:
                used = max(0, tot - avail)
                mem_total_gb = tot / (1024.0 * 1024.0)
                mem_used_gb = used / (1024.0 * 1024.0)
                mem_pct = 100.0 * used / tot
        except Exception:
            pass

        disk_pct = 0.0
        disk_free_gb = 0.0
        try:
            st = os.statvfs("/")
            total_b = st.f_blocks * st.f_frsize
            avail_b = st.f_bavail * st.f_frsize
            if total_b > 0:
                disk_pct = 100.0 * (total_b - avail_b) / total_b
                disk_free_gb = avail_b / (1024.0 ** 3)
        except Exception:
            pass

        load_1 = 0.0
        load_5 = 0.0
        try:
            parts = Path("/proc/loadavg").read_text(encoding="utf-8").split()
            load_1 = float(parts[0])
            load_5 = float(parts[1])
        except Exception:
            pass

        uptime_h = 0.0
        try:
            up_s = float(Path("/proc/uptime").read_text(encoding="utf-8").split()[0])
            uptime_h = up_s / 3600.0
        except Exception:
            pass

        timers = list((view or {}).get("timers") or [])
        enabled_timers = [t for t in timers if t.get("enabled")]
        next_timer_str = ""
        if enabled_timers:
            enabled_timers.sort(key=lambda t: float(t.get("nextRunAt") or 9e15))
            nt = enabled_timers[0]
            nr = float(nt.get("nextRunAt") or 0.0)
            next_hm = time.strftime("%H:%M", time.localtime(nr / 1000.0)) if nr > 0 else "--:--"
            next_timer_str = f"{str(nt.get('name') or '定时')[:10]} {next_hm}"

        self._store_widget(
            "system-pulse",
            {
                "ok": True,
                "cpuPct": round(cpu_pct, 1),
                "memPct": round(mem_pct, 1),
                "memUsedGb": round(mem_used_gb, 1),
                "memTotalGb": round(mem_total_gb, 1),
                "diskPct": round(disk_pct, 1),
                "diskFreeGb": round(disk_free_gb, 1),
                "load1": round(load_1, 2),
                "load5": round(load_5, 2),
                "uptimeH": round(uptime_h, 1),
                "timerCount": len(enabled_timers),
                "nextTimer": next_timer_str,
                "headline": f"处理器 {cpu_pct:.0f}% · 内存 {mem_pct:.0f}%",
                "subline": next_timer_str or f"负载 {load_1:.2f} · 磁盘可用 {disk_free_gb:.0f}G",
            },
        )

    def _collect_core_from_view(self, kind: str, view: Dict[str, Any]) -> None:
        if kind == "memory":
            md = view.get("memoryDirectory") or {}
            total = int(md.get("totalActive") or 0)
            items = list(md.get("items") or [])
            pinned_count = sum(1 for it in items if it.get("pinned"))
            topics = [str(it.get("topic") or "")[:16] for it in items[:6] if it.get("topic")]
            id_to_idx = {str(it.get("id") or ""): i for i, it in enumerate(items[:14])}
            edges: List[Tuple[int, int, float]] = []
            for i, it in enumerate(items[:14]):
                for syn in (it.get("synapses") or [])[:4]:
                    j = id_to_idx.get(str(syn.get("targetId") or ""))
                    if j is not None and j != i:
                        edges.append((i, j, float(syn.get("weight") or 0.5)))
            self._store_widget(
                "memory",
                {
                    "ok": True,
                    "totalActive": total,
                    "pinnedCount": pinned_count,
                    "topics": topics,
                    "nodeCount": min(len(items), 14),
                    "edgeCount": len(edges),
                    "edges": edges[:18],
                    "headline": f"{total} 条活跃记忆",
                    "subline": f"置顶 {pinned_count} · 突触边 {len(edges)} · " + (topics[0] if topics else "突触就绪"),
                },
            )
        elif kind == "timers":
            timers = list(view.get("timers") or [])
            enabled = [t for t in timers if t.get("enabled")]
            enabled.sort(key=lambda t: float(t.get("nextRunAt") or 9e15))
            rows = []
            for t in enabled[:5]:
                nr = float(t.get("nextRunAt") or 0.0)
                hm = time.strftime("%H:%M", time.localtime(nr / 1000.0)) if nr > 0 else "--:--"
                rows.append({"name": str(t.get("name") or "未命名")[:18], "nextHm": hm, "goal": bool(t.get("goalCondition"))})
            self._store_widget(
                "timers",
                {
                    "ok": True,
                    "total": len(timers),
                    "enabled": len(enabled),
                    "rows": rows,
                    "headline": f"启用 {len(enabled)} / {len(timers)}",
                    "subline": f"下一触发 {rows[0]['name']} ({rows[0]['nextHm']})" if rows else "暂无运行中定时任务",
                },
            )
        elif kind == "usage":
            u = view.get("usageToday") or {}
            calls = int(u.get("calls") or 0)
            toks = int(u.get("totalTokens") or 0)
            cost_cny = float(u.get("costCny") or 0.0)
            cost_usd = float(u.get("costUsd") or 0.0)
            tok_str = f"{toks / 1000.0:.1f}k" if toks >= 1000 else str(toks)
            self._store_widget(
                "usage",
                {
                    "ok": True,
                    "calls": calls,
                    "totalTokens": toks,
                    "tokStr": tok_str,
                    "costCny": round(cost_cny, 3),
                    "costUsd": round(cost_usd, 4),
                    "headline": f"¥{cost_cny:.2f} · {calls} 次调用",
                    "subline": f"今日吞吐 {tok_str}",
                },
            )
        elif kind == "workers":
            works = [w for w in (view.get("works") or []) if w.get("status") in ("queued", "running")]
            rows = []
            now_ms = time.time() * 1000.0
            for w in works[:5]:
                created = float(w.get("createdAt") or now_ms)
                pq = w.get("pendingQuestion")
                rows.append(
                    {
                        "id": str(w.get("id") or "")[:8],
                        "profile": str(w.get("profile") or "general"),
                        "prompt": str(w.get("prompt") or "")[:40],
                        "elapsedSec": max(0, int((now_ms - created) / 1000.0)),
                        "waiting": bool(isinstance(pq, dict) and pq.get("question")),
                    }
                )
            self._store_widget(
                "workers",
                {
                    "ok": True,
                    "count": len(works),
                    "rows": rows,
                    "headline": f"{len(works)} 个后台任务" if works else "任务队列空闲",
                    "subline": rows[0]["prompt"] if rows else "随时可执行代码与研究子任务",
                },
            )

    def _collect_fund_tracker(self, db_path: Path, *, connected: bool, allow_refresh: bool = False) -> None:
        # 1) Try Friday RPC dashboard first (fast SQLite computation without blocking on network)
        summary: Optional[Dict[str, Any]] = None
        snapshots: List[Dict[str, Any]] = []
        updated_at: float = 0.0
        if connected:
            try:
                res = self._rpc(
                    {
                        "command": "plugin-run",
                        "plugin": "fund-tracker",
                        "action": "dashboard",
                        "args": {"refresh": False, "silent": True},
                    },
                    5.0,
                )
                data = (res or {}).get("data") if isinstance(res, dict) else None
                if isinstance(data, dict) and isinstance(data.get("summary"), dict):
                    summary = data["summary"]
                    snapshots = list(data.get("snapshots") or [])
                    updated_at = float(data.get("updatedAt") or 0.0)
            except Exception:
                summary = None

        # 2) Direct read-only SQLite fallback if RPC unavailable
        if summary is None and db_path.is_file():
            try:
                with contextlib.closing(_connect_ro_sqlite(db_path)) as con:
                    con.row_factory = sqlite3.Row
                    cur = con.cursor()
                    h_rows = cur.execute(
                        "SELECT code, name, cost, shares, last_nav, last_nav_date FROM holdings ORDER BY cost DESC LIMIT 12"
                    ).fetchall()
                    s_rows = cur.execute(
                        "SELECT date, total_cost, total_asset, daily_pnl, total_pnl, created_at FROM snapshots ORDER BY created_at DESC LIMIT 24"
                    ).fetchall()
                total_cost = sum(float(r["cost"] or 0.0) for r in h_rows)
                total_asset = sum(float(r["shares"] or 0.0) * float(r["last_nav"] or 0.0) for r in h_rows)
                if s_rows:
                    latest_s = s_rows[0]
                    total_asset = float(latest_s["total_asset"] or total_asset)
                    daily_pnl = float(latest_s["daily_pnl"] or 0.0)
                    total_pnl = float(latest_s["total_pnl"] or (total_asset - total_cost))
                    updated_at = float(latest_s["created_at"] or 0.0)
                    base_asset = max(1.0, total_asset - daily_pnl)
                    daily_pct = (daily_pnl / base_asset) * 100.0
                    total_pct = (total_pnl / max(1.0, total_cost)) * 100.0
                else:
                    daily_pnl = 0.0
                    daily_pct = 0.0
                    total_pnl = total_asset - total_cost
                    total_pct = (total_pnl / max(1.0, total_cost)) * 100.0 if total_cost > 0 else 0.0
                summary = {
                    "totalCost": total_cost,
                    "totalAsset": total_asset,
                    "totalDailyPnl": daily_pnl,
                    "dailyPnlPct": daily_pct,
                    "totalPnl": total_pnl,
                    "totalPnlPct": total_pct,
                    "holdings": [
                        {
                            "code": str(r["code"] or ""),
                            "name": str(r["name"] or ""),
                            "changePct": 0.0,
                            "dailyPnl": 0.0,
                            "currentAsset": float(r["shares"] or 0.0) * float(r["last_nav"] or 0.0),
                        }
                        for r in h_rows
                    ],
                }
                snapshots = [dict(r) for r in reversed(s_rows)]
            except Exception:
                summary = None

        # 3) Bounded fallback live refresh if cached snapshot is stale (e.g. Core refresh disabled/lagged)
        has_holdings = bool(summary.get("holdings")) if isinstance(summary, dict) else False
        if not has_holdings and summary is None:
            cfg_path = db_path.parent / "config.json"
            if cfg_path.is_file():
                try:
                    cfg_raw = json.loads(cfg_path.read_text(encoding="utf-8"))
                    has_holdings = bool(isinstance(cfg_raw, dict) and cfg_raw.get("holdings"))
                except Exception:
                    has_holdings = False
        if not has_holdings and db_path.is_file():
            try:
                with contextlib.closing(_connect_ro_sqlite(db_path)) as con:
                    cnt_row = con.execute("SELECT COUNT(*) FROM holdings").fetchone()
                has_holdings = bool(cnt_row and int(cnt_row[0] or 0) > 0)
            except Exception:
                pass

        now_ms = time.time() * 1000.0
        snap_age_sec = ((now_ms - updated_at) / 1000.0) if updated_at > 0 else 999999.0
        stale_limit_sec = 300.0 if _is_market_hours_now() else 2100.0
        if (
            connected
            and not self.disable_network
            and has_holdings
            and (allow_refresh or snap_age_sec > stale_limit_sec)
            and self._can_attempt_live("fund-tracker", 300.0)
        ):
            try:
                res = self._rpc(
                    {
                        "command": "plugin-run",
                        "plugin": "fund-tracker",
                        "action": "dashboard",
                        "args": {"refresh": True, "silent": True},
                    },
                    20.0,
                )
                data = (res or {}).get("data") if isinstance(res, dict) else None
                if isinstance(data, dict) and isinstance(data.get("summary"), dict):
                    summary = data["summary"]
                    snapshots = list(data.get("snapshots") or [])
                    updated_at = float(data.get("updatedAt") or now_ms)
            except Exception:
                pass

        if not summary:
            self._store_widget(
                "fund-tracker",
                {
                    "ok": False,
                    "empty": True,
                    "headline": "暂无持仓",
                    "subline": "请在「投资管理」配置持仓",
                    "spark": [],
                    "holdings": [],
                },
            )
            return

        daily_pnl = float(summary.get("totalDailyPnl") or 0.0)
        daily_pct = float(summary.get("dailyPnlPct") or 0.0)
        total_asset = float(summary.get("totalAsset") or 0.0)
        total_pnl = float(summary.get("totalPnl") or 0.0)
        total_pct = float(summary.get("totalPnlPct") or 0.0)
        holdings_raw = list(summary.get("holdings") or [])
        holdings_raw.sort(key=lambda h: abs(float(h.get("dailyPnl") or 0.0)), reverse=True)
        holdings = [
            {
                "code": str(h.get("code") or ""),
                "name": str(h.get("name") or "")[:12],
                "changePct": round(float(h.get("changePct") or 0.0), 2),
                "dailyPnl": round(float(h.get("dailyPnl") or 0.0), 1),
                "asset": round(float(h.get("currentAsset") or 0.0), 0),
                "official": bool(h.get("hasTodayOfficialNav")),
            }
            for h in holdings_raw[:6]
        ]

        sorted_snaps = sorted(snapshots, key=lambda s: (str(s.get("date") or ""), int(s.get("createdAt") or s.get("created_at") or 0)))
        spark = [round(float(s.get("totalPnl") if s.get("totalPnl") is not None else (s.get("total_pnl") or 0.0)), 2) for s in sorted_snaps[-16:]]
        if not spark:
            spark = [round(total_pnl, 2)]

        sign = "+" if daily_pct > 0 else ""
        self._store_widget(
            "fund-tracker",
            {
                "ok": True,
                "dailyPct": round(daily_pct, 2),
                "dailyPnl": round(daily_pnl, 1),
                "totalAsset": round(total_asset, 0),
                "totalPnl": round(total_pnl, 1),
                "totalPnlPct": round(total_pct, 2),
                "holdingCount": len(holdings_raw),
                "holdings": holdings,
                "spark": spark,
                "updatedHm": time.strftime("%H:%M", time.localtime(updated_at / 1000.0)) if updated_at > 0 else "",
                "headline": f"{sign}{daily_pct:.2f}%",
                "subline": f"今日 {_fmt_money(daily_pnl)} · 总 {_fmt_money(total_asset)}",
            },
        )

    def _collect_health_scale(self, db_path: Path, *, connected: bool) -> None:
        dash: Optional[Dict[str, Any]] = None
        if connected:
            try:
                res = self._rpc(
                    {"command": "plugin-run", "plugin": "health-scale", "action": "dashboard", "args": {"limit": 30}},
                    5.0,
                )
                d = (res or {}).get("data") if isinstance(res, dict) else None
                if isinstance(d, dict):
                    dash = d
            except Exception:
                dash = None

        if dash is None and db_path.is_file():
            try:
                with contextlib.closing(_connect_ro_sqlite(db_path)) as con:
                    con.row_factory = sqlite3.Row
                    cur = con.cursor()
                    prof = cur.execute("SELECT id, name FROM profiles ORDER BY is_default DESC, updated_at DESC LIMIT 1").fetchone()
                    if prof:
                        rows = cur.execute(
                            "SELECT weight_kg, heart_rate, measured_at FROM measurements WHERE profile_id = ? ORDER BY measured_at DESC LIMIT 14",
                            (prof["id"],),
                        ).fetchall()
                    else:
                        rows = []
                if rows:
                    latest_w = float(rows[0]["weight_kg"] or 0.0)
                    prev_w = float(rows[1]["weight_kg"] or latest_w) if len(rows) > 1 else latest_w
                    dash = {
                        "activeProfile": {"name": str(prof["name"] or "默认")},
                        "latest": {
                            "weightKg": latest_w,
                            "measuredAt": rows[0]["measured_at"],
                            "heartRate": rows[0]["heart_rate"],
                            "metrics": {},
                        },
                        "deltas": {"prevDiffKg": round(latest_w - prev_w, 2)},
                        "records": [{"weightKg": float(r["weight_kg"] or 0.0)} for r in rows],
                    }
            except Exception:
                dash = None

        latest = (dash or {}).get("latest") if isinstance(dash, dict) else None
        if not isinstance(latest, dict):
            self._store_widget(
                "health-scale",
                {
                    "ok": False,
                    "empty": True,
                    "headline": "-- kg",
                    "subline": "踩上体脂秤同步测量",
                    "spark": [],
                },
            )
            return

        m = latest.get("metrics") or {}
        weight_kg = float(latest.get("weightKg") or 0.0)
        prev_diff = ((dash or {}).get("deltas") or {}).get("prevDiffKg")
        diff_kg = float(prev_diff) if prev_diff is not None else 0.0
        records = list((dash or {}).get("records") or [])
        spark = [round(float(r.get("weightKg") or 0.0), 2) for r in reversed(records[:14])]
        body_fat = float(m.get("bodyFatPercent") or 0.0)
        muscle_pct = float(m.get("skeletalMusclePercent") or 0.0)
        water_pct = float(m.get("waterPercent") or 0.0)
        bmi = float(m.get("bmi") or 0.0)
        score = int(m.get("bodyScore") or 0)
        body_type = str(m.get("bodyType") or "")
        measured_ms = float(latest.get("measuredAt") or 0.0)
        measured_str = time.strftime("%m-%d %H:%M", time.localtime(measured_ms / 1000.0)) if measured_ms > 0 else ""

        self._store_widget(
            "health-scale",
            {
                "ok": True,
                "profileName": str(((dash or {}).get("activeProfile") or {}).get("name") or ""),
                "weightKg": round(weight_kg, 1),
                "diffKg": round(diff_kg, 2),
                "bodyFat": round(body_fat, 1),
                "musclePct": round(muscle_pct, 1),
                "waterPct": round(water_pct, 1),
                "bmi": round(bmi, 1),
                "score": score,
                "bodyType": body_type,
                "bmrKcal": int(m.get("bmrKcal") or 0),
                "visceral": int(m.get("visceralFatLevel") or 0),
                "measuredStr": measured_str,
                "spark": spark,
                "headline": f"{weight_kg:.1f} kg",
                "subline": (f"体脂 {body_fat:.1f}% · 评分 {score}" if score > 0 else f"较上次 {diff_kg:+.2f}kg"),
            },
        )

    def _collect_miot(self, cache_path: Path, *, connected: bool) -> None:
        cached_devices: List[Dict[str, Any]] = []
        fetched_at = 0.0
        live_fetched_at = 0.0
        if cache_path.is_file():
            try:
                parsed = json.loads(cache_path.read_text(encoding="utf-8"))
                cached_devices = list(parsed.get("devices") or [])
                fetched_at = float(parsed.get("hotDataFetchedAt") or parsed.get("fetchedAt") or 0.0)
                live_fetched_at = float(parsed.get("liveFetchedAt") or 0.0)
            except Exception:
                cached_devices = []
        raw_devices: List[Dict[str, Any]] = list(cached_devices)

        cfg_path = cache_path.parent / "config.json"
        configured = False
        if cfg_path.is_file():
            try:
                cfg_obj = json.loads(cfg_path.read_text(encoding="utf-8"))
                configured = bool(isinstance(cfg_obj, dict) and str(cfg_obj.get("routerSsh") or "").strip())
            except Exception:
                configured = False

        now_ms = time.time() * 1000.0
        hot_age_sec = (now_ms - fetched_at) / 1000.0 if fetched_at > 0 else 999999.0
        live_age_sec = (now_ms - live_fetched_at) / 1000.0 if live_fetched_at > 0 else 999999.0
        if (
            connected
            and not self.disable_network
            and configured
            and (not raw_devices or hot_age_sec > 720.0 or live_age_sec > 2100.0)
            and self._can_attempt_live("miot", 300.0)
        ):
            want_live = live_age_sec > 2100.0
            try:
                res = self._rpc(
                    {
                        "command": "plugin-run",
                        "plugin": "miot",
                        "action": "devices",
                        "args": {"refresh": True, "live": want_live, "silent": True},
                    },
                    25.0,
                )
                data = (res or {}).get("data") if isinstance(res, dict) else None
                if isinstance(data, dict) and isinstance(data.get("devices"), list):
                    raw_devices = list(data["devices"])
                    if cache_path.is_file():
                        try:
                            cached_devices = list(json.loads(cache_path.read_text(encoding="utf-8")).get("devices") or [])
                        except Exception:
                            pass
            except Exception:
                pass

        if not raw_devices:
            self._store_widget(
                "miot",
                {
                    "ok": False,
                    "empty": True,
                    "online": 0,
                    "total": 0,
                    "onCount": 0,
                    "envTemp": None,
                    "envHum": None,
                    "devices": [],
                    "headline": "未连接米家中枢",
                    "subline": "等待同步全屋设备",
                },
            )
            return

        cached_by_did = {
            str(cd.get("did") or ""): cd
            for cd in cached_devices
            if isinstance(cd, dict) and cd.get("did")
        }
        merged_for_env: List[Dict[str, Any]] = []
        items: List[Dict[str, Any]] = []
        online_cnt = 0
        on_cnt = 0
        rooms: Dict[str, int] = {}
        for d in raw_devices:
            if not isinstance(d, dict):
                continue
            did = str(d.get("did") or "")
            cached_entry = cached_by_did.get(did) or {}
            merged_d = dict(d)
            if "cachedState" not in merged_d and isinstance(cached_entry.get("cachedState"), dict):
                merged_d["cachedState"] = cached_entry["cachedState"]
            merged_for_env.append(merged_d)

            online = bool(merged_d.get("online", True))
            if online:
                online_cnt += 1
            on_val: Optional[bool] = None
            if isinstance(merged_d.get("state"), dict) and "on" in merged_d["state"]:
                on_val = bool(merged_d["state"]["on"])
            else:
                props = ((merged_d.get("cachedState") or {}).get("properties") or {})
                if isinstance(props, dict) and "2.1" in props and isinstance(props["2.1"], dict):
                    v = props["2.1"].get("value")
                    if v is not None:
                        on_val = v in (True, 1, "1", "true")
            if on_val:
                on_cnt += 1
            name = str(merged_d.get("dev_name") or merged_d.get("name") or "设备")[:14]
            room = str(merged_d.get("room_name") or merged_d.get("room") or "默认")[:8]
            cat = str(merged_d.get("category") or "")
            is_bridge = _is_miot_bridge_node(merged_d)
            rooms[room] = rooms.get(room, 0) + 1
            items.append(
                {
                    "name": name,
                    "room": room,
                    "cat": cat,
                    "online": online,
                    "on": on_val,
                    "controllable": bool(merged_d.get("controllable")),
                    "_is_bridge": is_bridge,
                }
            )

        env_temp, env_hum = _extract_miot_env(merged_for_env)
        # Deprioritize pure bridge/gateway/hub nodes; put controllable / currently ON items first
        items.sort(
            key=lambda x: (
                1 if x["_is_bridge"] else 0,
                0 if x["on"] else (1 if x["controllable"] else 2),
                0 if x["online"] else 1,
            )
        )
        clean_devices = [{k: v for k, v in it.items() if k != "_is_bridge"} for it in items[:10]]
        env_parts = []
        if env_temp is not None:
            env_parts.append(f"室内 {env_temp:.1f}°C")
        if env_hum is not None:
            env_parts.append(f"{env_hum:.0f}%" if env_temp is not None else f"湿度 {env_hum:.0f}%")
        env_str = " · ".join(env_parts)
        subline = f"{env_str} · 开启 {on_cnt} 台" if env_str else f"开启 {on_cnt} 台 · {len(rooms)} 个房间"
        self._store_widget(
            "miot",
            {
                "ok": True,
                "total": len(items),
                "online": online_cnt,
                "onCount": on_cnt,
                "rooms": len(rooms),
                "envTemp": env_temp,
                "envHum": env_hum,
                "devices": clean_devices,
                "headline": f"{online_cnt}/{len(items)} 在线",
                "subline": subline,
            },
        )

    def _collect_ninebot(self, db_path: Path, *, connected: bool) -> None:
        dash: Optional[Dict[str, Any]] = None
        if connected:
            try:
                res = self._rpc(
                    {"command": "plugin-run", "plugin": "ninebot", "action": "dashboard", "args": {"limit": 16}},
                    5.0,
                )
                d = (res or {}).get("data") if isinstance(res, dict) else None
                if isinstance(d, dict):
                    dash = d
            except Exception:
                dash = None

        if dash is None and db_path.is_file():
            try:
                with contextlib.closing(_connect_ro_sqlite(db_path)) as con:
                    con.row_factory = sqlite3.Row
                    cur = con.cursor()
                    s_rows = cur.execute(
                        "SELECT captured_at, battery, aux_battery, voltage_v, temp_c, charging, charging_power_w, effective_range_km, odometer_km, power_on, locked, gcj_lat, gcj_lon, address, payload_json FROM snapshots ORDER BY captured_at DESC, id DESC LIMIT 16"
                    ).fetchall()
                    t_rows = cur.execute(
                        "SELECT end_time, distance_km, max_speed_kmh FROM trips ORDER BY end_time DESC LIMIT 40"
                    ).fetchall()
                    a_rows = cur.execute(
                        "SELECT alert_key FROM alert_state WHERE active = 1"
                    ).fetchall()
                if s_rows:
                    latest_payload: Dict[str, Any] = {}
                    try:
                        parsed_p = json.loads(str(s_rows[0]["payload_json"] or "{}"))
                        if isinstance(parsed_p, dict):
                            latest_payload = parsed_p
                    except Exception:
                        latest_payload = {}
                    if not latest_payload:
                        latest_payload = {
                            "name": "九号电摩",
                            "capturedAt": s_rows[0]["captured_at"],
                            "battery": s_rows[0]["battery"],
                            "auxBattery": s_rows[0]["aux_battery"],
                            "voltageV": s_rows[0]["voltage_v"],
                            "temperatureC": s_rows[0]["temp_c"],
                            "charging": bool(s_rows[0]["charging"]),
                            "chargingPowerW": s_rows[0]["charging_power_w"],
                            "effectiveRangeKm": s_rows[0]["effective_range_km"],
                            "odometerKm": s_rows[0]["odometer_km"],
                            "powerOn": bool(s_rows[0]["power_on"]),
                            "locked": None if s_rows[0]["locked"] is None else bool(s_rows[0]["locked"]),
                            "location": {
                                "valid": s_rows[0]["gcj_lat"] is not None and s_rows[0]["gcj_lon"] is not None,
                                "gcjLat": s_rows[0]["gcj_lat"],
                                "gcjLon": s_rows[0]["gcj_lon"],
                                "address": s_rows[0]["address"],
                            },
                        }
                    today_str = time.strftime("%Y-%m-%d", time.localtime())
                    today_km = 0.0
                    month_km = 0.0
                    max_spd = 0.0
                    for tr in t_rows:
                        dist = float(tr["distance_km"] or 0.0)
                        month_km += dist
                        spd = float(tr["max_speed_kmh"] or 0.0)
                        if spd > max_spd:
                            max_spd = spd
                        end_ts = int(tr["end_time"] or 0)
                        if end_ts > 0 and time.strftime("%Y-%m-%d", time.localtime(end_ts)) == today_str:
                            today_km += dist
                    dash = {
                        "configured": True,
                        "snapshot": latest_payload,
                        "history": [{"battery": r["battery"]} for r in s_rows],
                        "tripSummary": {
                            "todayDistanceKm": round(today_km, 2),
                            "totalDistanceKm": round(month_km, 2),
                            "maxSpeedKmh": round(max_spd, 1),
                        },
                        "activeAlerts": [{"key": str(r["alert_key"])} for r in a_rows],
                    }
            except Exception:
                dash = None

        nb_dir = self.home / "plugins" / "ninebot"
        configured = bool((dash or {}).get("configured")) if isinstance(dash, dict) else (
            (nb_dir / "session.json").is_file() or (nb_dir / "config.json").is_file()
        )
        snap = (dash or {}).get("snapshot") if isinstance(dash, dict) else None
        cap_ms_raw = float(snap.get("capturedAt") or 0.0) if isinstance(snap, dict) else 0.0
        snap_age_sec = ((time.time() * 1000.0 - cap_ms_raw) / 1000.0) if cap_ms_raw > 0 else 999999.0
        if (
            connected
            and not self.disable_network
            and configured
            and (not isinstance(snap, dict) or snap_age_sec > 2100.0)
            and self._can_attempt_live("ninebot", 600.0)
        ):
            try:
                res = self._rpc(
                    {
                        "command": "plugin-run",
                        "plugin": "ninebot",
                        "action": "dashboard",
                        "args": {"refresh": True, "limit": 16, "silent": True},
                    },
                    20.0,
                )
                d = (res or {}).get("data") if isinstance(res, dict) else None
                if isinstance(d, dict):
                    dash = d
                    configured = bool(d.get("configured", configured))
                    snap = d.get("snapshot")
            except Exception:
                pass
        if not isinstance(snap, dict):
            self._store_widget(
                "ninebot",
                {
                    "ok": False,
                    "empty": True,
                    "configured": configured,
                    "headline": "待同步车况" if configured else "待绑定九号",
                    "subline": "执行一次同步即上屏" if configured else "请在「九号守护」登录子账号",
                    "spark": [],
                },
            )
            return

        batt = snap.get("battery")
        batt_num = int(round(float(batt))) if batt is not None else None
        aux_batt = snap.get("auxBattery")
        volt = snap.get("voltageV")
        temp = snap.get("temperatureC")
        charging = bool(snap.get("charging"))
        charge_w = snap.get("chargingPowerW")
        remain_t = str(snap.get("remainChargeTime") or "").strip()
        range_km = snap.get("effectiveRangeKm")
        odo_km = snap.get("odometerKm")
        power_on = bool(snap.get("powerOn"))
        locked = snap.get("locked")
        loc = snap.get("location") if isinstance(snap.get("location"), dict) else {}
        addr = str(loc.get("shortAddress") or loc.get("address") or "").strip()
        if not addr and loc.get("valid") and loc.get("gcjLat") is not None and loc.get("gcjLon") is not None:
            addr = f"{loc.get('gcjLat')}, {loc.get('gcjLon')}"
        if not addr:
            addr = "暂无有效定位"

        history = list((dash or {}).get("history") or [])
        spark = [
            float(h["battery"])
            for h in reversed(history[:16])
            if isinstance(h, dict) and h.get("battery") is not None
        ]
        if not spark and batt_num is not None:
            spark = [float(batt_num)]

        trip_sum = (dash or {}).get("tripSummary") if isinstance((dash or {}).get("tripSummary"), dict) else {}
        today_km = float(trip_sum.get("todayDistanceKm") or 0.0)
        month_km = float(trip_sum.get("totalDistanceKm") or 0.0)
        max_spd = float(trip_sum.get("maxSpeedKmh") or 0.0)
        alerts = list((dash or {}).get("activeAlerts") or [])
        cap_ms = float(snap.get("capturedAt") or 0.0)
        updated_hm = time.strftime("%H:%M", time.localtime(cap_ms / 1000.0)) if cap_ms > 0 else ""

        color_str = str(snap.get("color") or "").strip()[:10]
        model_name = str(snap.get("modelName") or "").strip()[:16]
        precise_km = snap.get("preciseEstimateMileageKm")
        estimate_km = snap.get("estimateMileageKm")
        gsm_sig = snap.get("gsmSignal")
        gnss_sig = snap.get("gnssSignal")

        image_path = ""
        image_mtime_ns = 0
        img_file = nb_dir / "vehicle-dark.png"
        try:
            if img_file.is_file() and not img_file.is_symlink():
                st = img_file.stat()
                if 64 <= st.st_size <= 512 * 1024:
                    image_path = str(img_file)
                    image_mtime_ns = int(st.st_mtime_ns)
        except OSError:
            image_path = ""
            image_mtime_ns = 0

        batt_str = f"{batt_num}%" if batt_num is not None else "--%"
        range_str = f"续航 {float(range_km):.1f}km" if range_km is not None else "续航 --"
        if charging:
            lock_str = "充电中"
        elif locked is False:
            lock_str = "未上锁"
        elif power_on:
            lock_str = "电门开启"
        elif locked is True:
            lock_str = "已上锁"
        else:
            lock_str = "待机"

        self._store_widget(
            "ninebot",
            {
                "ok": True,
                "name": str(snap.get("name") or "九号电摩")[:16],
                "modelName": model_name,
                "color": color_str,
                "battery": batt_num,
                "auxBattery": int(round(float(aux_batt))) if aux_batt is not None else None,
                "voltageV": round(float(volt), 1) if volt is not None else None,
                "tempC": round(float(temp), 1) if temp is not None else None,
                "charging": charging,
                "chargingPowerW": int(round(float(charge_w))) if charge_w is not None else None,
                "remainChargeTime": remain_t,
                "rangeKm": round(float(range_km), 1) if range_km is not None else None,
                "preciseRangeKm": round(float(precise_km), 1) if precise_km is not None else None,
                "estimateRangeKm": round(float(estimate_km), 1) if estimate_km is not None else None,
                "odometerKm": round(float(odo_km), 1) if odo_km is not None else None,
                "powerOn": power_on,
                "locked": locked,
                "gsmSignal": int(gsm_sig) if gsm_sig is not None else None,
                "gnssSignal": int(gnss_sig) if gnss_sig is not None else None,
                "imagePath": image_path,
                "imageMtimeNs": image_mtime_ns,
                "address": addr[:34],
                "todayKm": round(today_km, 1),
                "monthKm": round(month_km, 1),
                "maxSpeedKmh": round(max_spd, 1),
                "alertCount": len(alerts),
                "updatedHm": updated_hm,
                "spark": spark,
                "headline": f"{batt_str} · {range_str}",
                "subline": f"{lock_str} · {addr[:20]}",
            },
        )

    def _collect_laifen(self, db_path: Path, *, connected: bool) -> None:
        dash: Optional[Dict[str, Any]] = None
        if connected:
            try:
                res = self._rpc(
                    {"command": "plugin-run", "plugin": "laifen", "action": "dashboard", "args": {"limit": 30}},
                    5.0,
                )
                d = (res or {}).get("data") if isinstance(res, dict) else None
                if isinstance(d, dict):
                    dash = d
            except Exception:
                dash = None

        laifen_dir = self.home / "plugins" / "laifen"
        if dash is None:
            cfg: Dict[str, Any] = {}
            cfg_path = laifen_dir / "config.json"
            if cfg_path.is_file():
                try:
                    parsed_cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
                    if isinstance(parsed_cfg, dict):
                        cfg = parsed_cfg
                except Exception:
                    cfg = {}

            daily_goal = max(1, min(6, _coerce_int(cfg.get("dailyGoalCount"), 2) or 2))
            lifespan_days = max(15, min(365, _coerce_int(cfg.get("brushHeadLifespanDays"), 90) or 90))
            replaced_at_raw = cfg.get("brushHeadReplacedAt")
            replaced_at = int(replaced_at_raw) if isinstance(replaced_at_raw, (int, float)) and replaced_at_raw > 0 else None

            dev_fb: Optional[Dict[str, Any]] = None
            session_times: List[int] = []
            if db_path.is_file():
                try:
                    with contextlib.closing(_connect_ro_sqlite(db_path)) as con:
                        con.row_factory = sqlite3.Row
                        cur = con.cursor()
                        row = cur.execute(
                            "SELECT name, battery_pct, active_mode, modes_json, duration_sec, status, updated_at, last_synced_at "
                            "FROM device_state ORDER BY CASE WHEN id = 'primary' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1"
                        ).fetchone()
                        if row is not None:
                            try:
                                modes = json.loads(str(row["modes_json"] or "{}"))
                            except Exception:
                                modes = {}
                            if not isinstance(modes, dict):
                                modes = {}
                            active_mode = row["active_mode"] if row["active_mode"] is not None else 1
                            slot = modes.get(str(active_mode)) or modes.get("1") or {}
                            if not isinstance(slot, dict):
                                slot = {}
                            dev_fb = {
                                "name": str(row["name"] or ""),
                                "batteryPct": row["battery_pct"],
                                "activeMode": active_mode,
                                "activeStrength": slot.get("strength"),
                                "activeRange": slot.get("range"),
                                "activeSpeed": slot.get("speed"),
                                "durationSec": row["duration_sec"],
                                "status": str(row["status"] or "Idle"),
                                "updatedAt": row["updated_at"],
                                "lastSyncedAt": row["last_synced_at"],
                            }
                        s_rows = cur.execute("SELECT brushed_at FROM brush_sessions ORDER BY brushed_at DESC").fetchall()
                        session_times = [int(r["brushed_at"]) for r in s_rows if r["brushed_at"] is not None]
                except Exception:
                    dev_fb = None
                    session_times = []

            now_dt = datetime.now()
            now_ms = int(now_dt.timestamp() * 1000.0)
            today_date = now_dt.date()
            by_day: Dict[str, int] = {}
            for ts_ms in session_times:
                day_key = datetime.fromtimestamp(ts_ms / 1000.0).strftime("%Y-%m-%d")
                by_day[day_key] = by_day.get(day_key, 0) + 1

            def _day_key_offset(delta_days: int) -> str:
                return (today_date + timedelta(days=delta_days)).isoformat()

            today_key = _day_key_offset(0)
            yesterday_key = _day_key_offset(-1)
            today_count_fb = by_day.get(today_key, 0)
            last7 = [{"count": by_day.get(_day_key_offset(d), 0)} for d in range(-6, 1)]

            streak_fb = 0
            start_off: Optional[int] = 0 if today_key in by_day else (-1 if yesterday_key in by_day else None)
            if start_off is not None:
                off = start_off
                while _day_key_offset(off) in by_day:
                    streak_fb += 1
                    off -= 1

            earliest_sess = min(session_times) if session_times else None
            last_synced = dev_fb.get("lastSyncedAt") if dev_fb else None
            anchor_at = replaced_at or earliest_sess or last_synced or now_ms
            days_used = max(0, int((now_ms - float(anchor_at)) // 86_400_000))
            days_left = max(0, lifespan_days - days_used)
            pct_left = round(max(0.0, min(100.0, (days_left / max(1, lifespan_days)) * 100.0)), 1)

            watch_running = False
            watch_path = laifen_dir / "watch-state.json"
            if watch_path.is_file():
                try:
                    w_raw = json.loads(watch_path.read_text(encoding="utf-8"))
                    if isinstance(w_raw, dict):
                        w_phase = str(w_raw.get("phase") or "")
                        w_pid = w_raw.get("pid")
                        if w_phase in ("watching", "syncing", "brushing", "cooldown", "yielding", "connecting"):
                            watch_running = _is_pid_alive(w_pid) if w_pid else False
                except Exception:
                    watch_running = False

            live_phase = ""
            sess_path = laifen_dir / "live-session.json"
            if sess_path.is_file():
                try:
                    s_raw = json.loads(sess_path.read_text(encoding="utf-8"))
                    if isinstance(s_raw, dict):
                        sp = str(s_raw.get("phase") or "")
                        if sp in ("scanning", "connecting", "monitoring") and _is_pid_alive(s_raw.get("pid")):
                            live_phase = sp
                except Exception:
                    live_phase = ""

            dash = {
                "device": dev_fb,
                "stats": {
                    "todayCount": today_count_fb,
                    "dailyGoalCount": daily_goal,
                    "streakDays": streak_fb,
                    "totalSessions": len(session_times),
                    "last7Days": last7,
                    "brushHead": {
                        "daysLeft": days_left,
                        "percentLeft": pct_left,
                    },
                },
                "watchStatus": {"running": watch_running},
                "liveSession": {"phase": live_phase} if live_phase else None,
                "config": {"dailyGoalCount": daily_goal},
            }

        dev = dash.get("device") if isinstance(dash, dict) and isinstance(dash.get("device"), dict) else None
        stats = dash.get("stats") if isinstance(dash, dict) and isinstance(dash.get("stats"), dict) else {}
        bh = stats.get("brushHead") if isinstance(stats.get("brushHead"), dict) else {}
        watch_st = dash.get("watchStatus") if isinstance(dash, dict) and isinstance(dash.get("watchStatus"), dict) else {}
        live_sess = dash.get("liveSession") if isinstance(dash, dict) and isinstance(dash.get("liveSession"), dict) else {}
        cfg_d = dash.get("config") if isinstance(dash, dict) and isinstance(dash.get("config"), dict) else {}

        watching = bool(watch_st.get("running")) or str(live_sess.get("phase") or "") in ("scanning", "connecting", "monitoring")
        today_count = _coerce_int(stats.get("todayCount") if stats.get("todayCount") is not None else (dash or {}).get("todayCount"), 0)
        daily_goal = max(1, _coerce_int(stats.get("dailyGoalCount") or cfg_d.get("dailyGoalCount"), 2) or 2)
        streak_days = _coerce_int(stats.get("streakDays") if stats.get("streakDays") is not None else (dash or {}).get("streakDays"), 0)
        raw_days_left = bh.get("daysLeft") if bh.get("daysLeft") is not None else (dash or {}).get("brushHeadDaysLeft")
        brush_days_left = _coerce_int(raw_days_left, 0) if raw_days_left is not None else None
        raw_brush_pct = bh.get("percentLeft")
        if raw_brush_pct is not None:
            brush_pct = round(max(0.0, min(100.0, float(raw_brush_pct))), 1)
        elif brush_days_left is not None:
            brush_pct = round(max(0.0, min(100.0, (brush_days_left / 90.0) * 100.0)), 1)
        else:
            brush_pct = 100.0

        last7_raw = stats.get("last7Days") if isinstance(stats.get("last7Days"), list) else []
        week_counts = [int(item.get("count") or 0) for item in last7_raw[-7:] if isinstance(item, dict)]
        if len(week_counts) < 7:
            week_counts = [0] * (7 - len(week_counts)) + week_counts

        total_sessions = int(stats.get("totalSessions") or 0)
        has_data = (dev is not None) or (total_sessions > 0) or (today_count > 0)

        name = _localize_laifen_name((dev or {}).get("name"))
        batt = int(round(float(dev["batteryPct"]))) if dev and dev.get("batteryPct") is not None else None
        mode = int(dev["activeMode"]) if dev and dev.get("activeMode") is not None else None
        mode_label = LAIFEN_MODE_ZH.get(mode, f"{mode}档" if mode else ("未连接" if has_data else "待同步")) if mode is not None else ("未连接" if has_data else "待同步")
        strength = int(dev["activeStrength"]) if dev and dev.get("activeStrength") is not None else None
        rng = int(dev["activeRange"]) if dev and dev.get("activeRange") is not None else None
        speed = int(dev["activeSpeed"]) if dev and dev.get("activeSpeed") is not None else None
        dur_sec = int(dev["durationSec"]) if dev and dev.get("durationSec") is not None else None
        ts_ms = float(dev.get("lastSyncedAt") or dev.get("updatedAt") or 0.0) if dev else 0.0
        updated_hm = time.strftime("%H:%M", time.localtime(ts_ms / 1000.0)) if ts_ms > 0 else ""

        if not has_data:
            headline = "待同步牙刷"
            subline = "自动唤醒监听中 · 拿起即同步" if watching else "轻按牙刷亮灯即可同步状态"
        else:
            headline = (
                f"{batt}% · {mode_label}"
                if batt is not None
                else (mode_label if dev is not None else f"今日 {today_count}/{daily_goal} 次")
            )
            bh_part = f" · 刷头余 {brush_days_left} 天" if brush_days_left is not None else ""
            subline = f"今日 {today_count}/{daily_goal} 次{bh_part}"

        self._store_widget(
            "laifen",
            {
                "ok": has_data,
                "empty": not has_data,
                "name": name,
                "battery": batt,
                "mode": mode,
                "modeLabel": mode_label,
                "todayCount": today_count,
                "dailyGoal": daily_goal,
                "streakDays": streak_days,
                "brushDaysLeft": brush_days_left,
                "brushPct": brush_pct,
                "strength": strength,
                "range": rng,
                "speed": speed,
                "durationSec": dur_sec,
                "watching": watching,
                "weekCounts": week_counts,
                "updatedHm": updated_hm,
                "headline": headline,
                "subline": subline,
            },
        )

    def _collect_netlea(self, state_path: Path, *, connected: bool) -> None:
        data: Optional[Dict[str, Any]] = None
        if connected:
            try:
                res = self._rpc(
                    {"command": "plugin-run", "plugin": "netlea", "action": "dashboard", "args": {"refresh": False}},
                    4.5,
                )
                d = (res or {}).get("data") if isinstance(res, dict) else None
                if isinstance(d, dict):
                    data = d
            except Exception:
                data = None

        netlea_dir = self.home / "plugins" / "netlea"
        if data is None:
            snap_raw: Dict[str, Any] = {}
            if state_path.is_file():
                try:
                    parsed = json.loads(state_path.read_text(encoding="utf-8"))
                    if isinstance(parsed, dict):
                        snap_raw = parsed
                except Exception:
                    snap_raw = {}
            cfg_raw: Dict[str, Any] = {}
            cfg_path = netlea_dir / "config.json"
            if cfg_path.is_file():
                try:
                    parsed_cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
                    if isinstance(parsed_cfg, dict):
                        cfg_raw = parsed_cfg
                except Exception:
                    cfg_raw = {}
            data = {
                "updatedAt": snap_raw.get("updatedAt"),
                "lastAddress": snap_raw.get("lastAddress"),
                "device": snap_raw.get("device"),
                "state": snap_raw.get("state"),
                "schedule": snap_raw.get("schedule"),
                "config": cfg_raw,
            }

        dev = data.get("device") if isinstance(data.get("device"), dict) else None
        st = data.get("state") if isinstance(data.get("state"), dict) else None
        cfg = data.get("config") if isinstance(data.get("config"), dict) else {}
        updated_at = float(data.get("updatedAt") or 0.0)
        state_age_sec = ((time.time() * 1000.0 - updated_at) / 1000.0) if updated_at > 0 else 999999.0
        has_bound_lamp = bool(
            str(cfg.get("targetMac") or "").strip()
            or str(data.get("lastAddress") or "").strip()
            or str((dev or {}).get("address") or "").strip()
        )
        is_linux = os.name == "posix" and sys.platform.startswith("linux")
        if (
            connected
            and not self.disable_network
            and is_linux
            and has_bound_lamp
            and (not isinstance(st, dict) or state_age_sec > 2100.0)
            and (not self._is_ble_peer_busy())
            and self._can_attempt_live("netlea", 600.0)
        ):
            try:
                has_sched = isinstance(data.get("schedule"), dict)
                st_res = self._rpc(
                    {
                        "command": "plugin-run",
                        "plugin": "netlea",
                        "action": "status",
                        "args": {"minimal": has_sched, "silent": True},
                    },
                    25.0,
                )
                if isinstance(st_res, dict) and st_res.get("ok"):
                    dash_res = self._rpc(
                        {
                            "command": "plugin-run",
                            "plugin": "netlea",
                            "action": "dashboard",
                            "args": {"refresh": False, "silent": True},
                        },
                        5.0,
                    )
                    d2 = (dash_res or {}).get("data") if isinstance(dash_res, dict) else None
                    if isinstance(d2, dict):
                        data = d2
                        dev = data.get("device") if isinstance(data.get("device"), dict) else None
                        st = data.get("state") if isinstance(data.get("state"), dict) else None
                        cfg = data.get("config") if isinstance(data.get("config"), dict) else {}
                        updated_at = float(data.get("updatedAt") or 0.0)
            except Exception:
                pass
        updated_hm = time.strftime("%H:%M", time.localtime(updated_at / 1000.0)) if updated_at > 0 else ""

        name = _localize_netlea_name((dev or {}).get("name"))

        if not isinstance(st, dict):
            self._store_widget(
                "netlea",
                {
                    "ok": False,
                    "empty": True,
                    "name": name,
                    "on": None,
                    "modeLabel": "待同步",
                    "brightness": None,
                    "red": 0,
                    "green": 0,
                    "white": 0,
                    "blue": 0,
                    "fan": 0,
                    "updatedHm": updated_hm,
                    "headline": "待同步灯具",
                    "subline": "在「鱼缸灯光」面板同步状态",
                },
            )
            return

        ch = st.get("channels") if isinstance(st.get("channels"), dict) else {}
        red = max(0, min(100, int(round(float(ch.get("red") or 0)))))
        green = max(0, min(100, int(round(float(ch.get("green") or 0)))))
        white = max(0, min(100, int(round(float(ch.get("white") or 0)))))
        blue = max(0, min(100, int(round(float(ch.get("blue") or 0)))))
        fan = max(0, min(5, int(round(float(ch.get("fan") or 0)))))
        on_val = bool(st.get("on"))

        if not on_val:
            brightness: Optional[int] = 0
        else:
            def_ch = cfg.get("defaultChannels") if isinstance(cfg.get("defaultChannels"), dict) else {}
            def_sum = sum(
                max(0, int(def_ch.get(c, d)))
                for c, d in (("red", 69), ("green", 54), ("white", 98), ("blue", 54))
            )
            cur_sum = red + green + white + blue
            if cur_sum <= 0:
                brightness = 0
            elif def_sum > 0:
                brightness = max(1, min(100, int(round(100.0 * cur_sum / def_sum))))
            else:
                brightness = max(1, min(100, int(round(cur_sum / 4.0))))

        master = st.get("master") if isinstance(st.get("master"), dict) else {}
        lamp_mode = master.get("lampMode")
        state_type = master.get("stateType")
        if not on_val:
            mode_label = "已关闭"
        elif lamp_mode == 1:
            mode_label = "手动补光"
        elif state_type == 1:
            mode_label = "自动行程"
        else:
            mode_label = "手动补光"

        headline = f"开启 · {brightness}%" if on_val else "已关闭"
        subline = f"红{red} 绿{green} 白{white} 蓝{blue} · {mode_label}"
        self._store_widget(
            "netlea",
            {
                "ok": True,
                "empty": False,
                "name": name,
                "on": on_val,
                "modeLabel": mode_label,
                "brightness": brightness,
                "red": red,
                "green": green,
                "white": white,
                "blue": blue,
                "fan": fan,
                "updatedHm": updated_hm,
                "headline": headline,
                "subline": subline,
            },
        )

    def _collect_apple_devices(self, cache_path: Path, *, connected: bool) -> None:
        data: Optional[Dict[str, Any]] = None
        if connected:
            try:
                res = self._rpc(
                    {
                        "command": "plugin-run",
                        "plugin": "apple-devices",
                        "action": "status",
                        "args": {"cacheOnly": True, "silent": True},
                    },
                    5.0,
                )
                d = (res or {}).get("data") if isinstance(res, dict) else None
                if isinstance(d, dict):
                    data = d
            except Exception:
                data = None

        apple_dir = self.home / "plugins" / "apple-devices"
        if data is None:
            sess_raw: Dict[str, Any] = {}
            sess_path = apple_dir / "session.json"
            if sess_path.is_file():
                try:
                    parsed_s = json.loads(sess_path.read_text(encoding="utf-8"))
                    if isinstance(parsed_s, dict):
                        sess_raw = parsed_s
                except Exception:
                    sess_raw = {}
            raw_state = str(sess_raw.get("state") or "")
            auth_state = raw_state if raw_state in ("authenticated", "pending_2fa", "expired") else "unauthenticated"

            cfg_raw: Dict[str, Any] = {}
            cfg_path = apple_dir / "config.json"
            if cfg_path.is_file():
                try:
                    parsed_c = json.loads(cfg_path.read_text(encoding="utf-8"))
                    if isinstance(parsed_c, dict):
                        cfg_raw = parsed_c
                except Exception:
                    cfg_raw = {}
            places_cfg = cfg_raw.get("places") if isinstance(cfg_raw.get("places"), dict) else {}

            fetched_at: Optional[float] = None
            raw_devices_fb: List[Dict[str, Any]] = []
            if cache_path.is_file():
                try:
                    c_raw = json.loads(cache_path.read_text(encoding="utf-8"))
                    if isinstance(c_raw, dict):
                        if isinstance(c_raw.get("fetchedAt"), (int, float)):
                            fetched_at = float(c_raw["fetchedAt"])
                        for entry in (c_raw.get("entries") or []):
                            if not isinstance(entry, dict) or not isinstance(entry.get("device"), dict):
                                continue
                            dev_obj = dict(entry["device"])
                            loc = dev_obj.get("location")
                            best_place: Optional[Dict[str, Any]] = None
                            if isinstance(loc, dict):
                                short_fb = str(loc.get("shortAddress") or loc.get("address") or "").strip()
                                if short_fb:
                                    dev_obj["_shortAddr"] = short_fb
                            if isinstance(loc, dict) and isinstance(loc.get("latitude"), (int, float)) and isinstance(loc.get("longitude"), (int, float)):
                                lat = float(loc["latitude"])
                                lon = float(loc["longitude"])
                                gcj_lat_raw = loc.get("gcjLat")
                                gcj_lon_raw = loc.get("gcjLon")
                                if isinstance(gcj_lat_raw, (int, float)) and isinstance(gcj_lon_raw, (int, float)):
                                    gcj_lat, gcj_lon = float(gcj_lat_raw), float(gcj_lon_raw)
                                else:
                                    gcj_lat, gcj_lon = _wgs84_to_gcj02(lat, lon)
                                for pname, pcfg in places_cfg.items():
                                    if not isinstance(pcfg, dict):
                                        continue
                                    plat = pcfg.get("lat", pcfg.get("latitude"))
                                    plng = pcfg.get("lng", pcfg.get("lon", pcfg.get("longitude")))
                                    if not isinstance(plat, (int, float)) or not isinstance(plng, (int, float)):
                                        continue
                                    radius = int(pcfg.get("radiusMeters") or pcfg.get("radius") or 250)
                                    dist = min(
                                        _haversine_meters(lat, lon, float(plat), float(plng)),
                                        _haversine_meters(gcj_lat, gcj_lon, float(plat), float(plng)),
                                    )
                                    cand = {"name": str(pname), "distanceMeters": dist, "inside": dist <= radius}
                                    if (
                                        best_place is None
                                        or (cand["inside"] and not best_place["inside"])
                                        or (cand["inside"] == best_place["inside"] and cand["distanceMeters"] < best_place["distanceMeters"])
                                    ):
                                        best_place = cand
                            dev_obj["place"] = best_place
                            dev_obj.pop("location", None)
                            raw_devices_fb.append(dev_obj)
                except Exception:
                    raw_devices_fb = []

            data = {
                "authState": auth_state,
                "fetchedAt": fetched_at,
                "devices": raw_devices_fb,
                "config": cfg_raw,
            }

        auth_state = str(data.get("authState") or "unauthenticated")
        fetched_ms = float(data.get("fetchedAt") or 0.0)
        cache_age_sec = ((time.time() * 1000.0 - fetched_ms) / 1000.0) if fetched_ms > 0 else 999999.0
        if (
            connected
            and not self.disable_network
            and auth_state == "authenticated"
            and (fetched_ms <= 0 or cache_age_sec > 3900.0)
            and self._can_attempt_live("apple-devices", 600.0)
        ):
            try:
                res = self._rpc(
                    {
                        "command": "plugin-run",
                        "plugin": "apple-devices",
                        "action": "status",
                        "args": {"refresh": True, "silent": True},
                    },
                    25.0,
                )
                d2 = (res or {}).get("data") if isinstance(res, dict) else None
                if isinstance(res, dict) and res.get("ok") and isinstance(d2, dict):
                    data = d2
                    auth_state = str(data.get("authState") or auth_state)
                    fetched_ms = float(data.get("fetchedAt") or 0.0)
                elif isinstance(d2, dict) and d2.get("authState") in ("expired", "unauthenticated", "pending_2fa"):
                    auth_state = str(d2["authState"])
            except Exception:
                pass

        cfg_d = data.get("config") if isinstance(data.get("config"), dict) else {}
        min_batt_pct = _coerce_int(cfg_d.get("minBatteryPct"), 25) or 25
        updated_hm = time.strftime("%H:%M", time.localtime(fetched_ms / 1000.0)) if fetched_ms > 0 else ""

        raw_devs = [d for d in (data.get("devices") or []) if isinstance(d, dict)]
        cat_order = {"iphone": 0, "watch": 1, "ipad": 2, "mac": 3, "airpods": 4, "airtag": 5}
        devices_out: List[Tuple[int, int, Dict[str, Any]]] = []
        online_cnt = 0
        low_cnt = 0
        for d in raw_devs:
            cat = str(d.get("category") or "").strip().lower()
            probe = f"{d.get('model') or ''} {d.get('name') or ''} {d.get('displayName') or ''}".lower()
            if (not cat or cat == "other") and "airtag" in probe:
                cat = "airtag"
            cat_label = APPLE_CATEGORY_ZH.get(cat, "设备")
            raw_batt = d.get("batteryPercent")
            batt = max(0, min(100, int(round(float(raw_batt))))) if isinstance(raw_batt, (int, float)) else None
            b_status = str(d.get("batteryStatus") or "Unknown")
            charging = b_status == "Charging"
            online = bool(d.get("online"))
            if online:
                online_cnt += 1
            if batt is not None and batt < min_batt_pct and b_status not in ("Charging", "Charged"):
                low_cnt += 1

            loc_d = d.get("location") if isinstance(d.get("location"), dict) else {}
            short_addr = str(loc_d.get("shortAddress") or loc_d.get("address") or d.get("_shortAddr") or "").strip()
            place_str = ""
            place_obj = d.get("place")
            if isinstance(place_obj, dict) and place_obj.get("name"):
                pname = str(place_obj["name"]).strip()[:10]
                if place_obj.get("inside"):
                    place_str = pname if pname.startswith("在") else f"在{pname}"
                elif short_addr:
                    place_str = short_addr[:16]
                else:
                    dist = place_obj.get("distanceMeters")
                    if isinstance(dist, (int, float)):
                        place_str = f"距{pname}{int(round(dist))}m" if dist < 1000 else f"距{pname}{dist / 1000.0:.1f}km"
                    else:
                        place_str = f"距{pname}"
            elif short_addr:
                place_str = short_addr[:16]

            raw_name = str(d.get("name") or d.get("displayName") or "").strip() or cat_label
            dev_item = {
                "name": raw_name[:64],
                "catLabel": cat_label,
                "battery": batt,
                "charging": charging,
                "online": online,
                "place": place_str,
            }
            devices_out.append((0 if online else 1, cat_order.get(cat, 6), dev_item))

        devices_out.sort(key=lambda item: (item[0], item[1]))
        final_devices = [item[2] for item in devices_out]
        total = len(final_devices)

        if auth_state in ("expired", "unauthenticated", "pending_2fa") or total == 0:
            if auth_state == "pending_2fa":
                headline = "待完成验证"
                subline = "请在「苹果设备」输入验证码"
            elif auth_state == "expired":
                headline = "会话已过期"
                subline = "会话已过期，请在「苹果设备」重新登录"
            elif auth_state == "authenticated":
                headline = "暂无设备缓存"
                subline = "请在「苹果设备」面板刷新"
            else:
                headline = "待绑定苹果账号"
                subline = "请在「苹果设备」完成登录"
            self._store_widget(
                "apple-devices",
                {
                    "ok": False,
                    "empty": total == 0,
                    "authState": auth_state,
                    "total": total,
                    "online": online_cnt,
                    "lowCount": low_cnt,
                    "devices": final_devices,
                    "updatedHm": updated_hm,
                    "headline": headline,
                    "subline": subline,
                },
            )
            return

        first = final_devices[0]
        first_batt = f" {first['battery']}%" if first["battery"] is not None else ""
        headline = f"{online_cnt}/{total} 台在线"
        subline = (
            f"{low_cnt} 台低电量 · {first['name']}{first_batt}"
            if low_cnt > 0
            else f"电量正常 · {first['name']}{first_batt}"
        )
        self._store_widget(
            "apple-devices",
            {
                "ok": True,
                "empty": False,
                "authState": auth_state,
                "total": total,
                "online": online_cnt,
                "lowCount": low_cnt,
                "devices": final_devices,
                "updatedHm": updated_hm,
                "headline": headline,
                "subline": subline,
            },
        )

    def _collect_tv_agent(self, *, connected: bool) -> None:
        cfg_path = self.home / "plugins" / "tv-agent" / "config.json"
        configured = False
        if cfg_path.is_file():
            try:
                configured = bool(str(json.loads(cfg_path.read_text(encoding="utf-8")).get("tvHost") or "").strip())
            except Exception:
                configured = False
        data: Dict[str, Any] = {}
        if connected:
            try:
                res = self._rpc({"command": "plugin-run", "plugin": "tv-agent", "action": "status", "args": {}}, 3.5)
                if isinstance(res, dict) and isinstance(res.get("data"), dict):
                    data = dict(res["data"])
            except Exception:
                pass
        if data.get("tvHost"):
            configured = True
        online = data.get("powerState") == "online"
        vol = data.get("volume")
        muted = bool(data.get("muted"))
        app_display = _normalize_tv_app_name(data.get("appName"), data.get("packageName"), online=online)
        vol_desc = "已静音" if muted else (f"音量 {vol}%" if vol is not None else "已连接")
        headline = f"播放中 · {app_display}" if online else ("客厅电视待机" if configured else "待配置电视")
        subline = (
            f"{app_display} · {vol_desc}"
            if online
            else ("已开启联动控制 · 可语音唤醒" if configured else "请在「客厅电视」配置设备")
        )
        self._store_widget(
            "tv-agent",
            {
                "ok": online or configured,
                "online": online,
                "appName": app_display if online else ("已待机" if configured else "未配置"),
                "volume": vol,
                "muted": muted,
                "dlnaOk": bool(data.get("dlnaReachable")),
                "agentOk": bool(data.get("agentReachable")),
                "headline": headline,
                "subline": subline,
            },
        )

    def _collect_tv_ir(self, *, connected: bool) -> None:
        learned_path = self.home / "plugins" / "tv-ir" / "learned-keys.json"
        learned_cnt = 0
        if learned_path.is_file():
            try:
                learned_cnt = len(json.loads(learned_path.read_text(encoding="utf-8")) or {})
            except Exception:
                learned_cnt = 0
        data: Dict[str, Any] = {}
        ok = False
        if connected:
            try:
                res = self._rpc({"command": "plugin-run", "plugin": "tv-ir", "action": "status", "args": {}}, 8.0)
                if isinstance(res, dict):
                    ok = bool(res.get("ok"))
                    if isinstance(res.get("data"), dict):
                        data = dict(res["data"])
            except Exception:
                pass
        tx_ready = bool(data.get("txReady", False))
        rx_ready = bool(data.get("rxReady", False))
        preset_cnt = _coerce_int(data.get("presetCount"), 12) or 12
        learned_cnt = _coerce_int(data.get("learnedCount"), learned_cnt) if data.get("learnedCount") is not None else learned_cnt
        subline = "支持电源 · 音量 · 方向导航" + (f" · 已学 {learned_cnt} 键" if learned_cnt > 0 else "")
        self._store_widget(
            "tv-ir",
            {
                "ok": ok and tx_ready,
                "txReady": tx_ready,
                "rxReady": rx_ready,
                "presetCount": preset_cnt,
                "learnedCount": learned_cnt,
                "headline": "全向红外就绪" if tx_ready else "等待音箱连接",
                "subline": subline,
            },
        )

    def _collect_weather(self) -> None:
        cfg = self.layout_store.get()
        city = str(cfg.get("weatherCity") or "上海")
        lat = float(cfg.get("weatherLat") or 31.23)
        lon = float(cfg.get("weatherLon") or 121.47)
        if self.disable_network:
            self._store_widget(
                "weather",
                {
                    "ok": False,
                    "city": city,
                    "temp": None,
                    "feelsLike": None,
                    "tempMax": None,
                    "tempMin": None,
                    "wcode": 0,
                    "desc": "离线模式",
                    "wind": 0.0,
                    "windDesc": "微风",
                    "headline": f"{city} · 离线",
                    "subline": "网络检查已禁用",
                },
            )
            return
        try:
            url = (
                f"https://api.open-meteo.com/v1/forecast?latitude={lat:.4f}&longitude={lon:.4f}"
                "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m"
                "&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto"
            )
            req = urllib.request.Request(url, headers={"User-Agent": "friday-cs80/1.0"})
            with urllib.request.urlopen(req, timeout=2.5) as resp:
                raw = json.loads(resp.read().decode("utf-8"))
            cur = raw.get("current") or {}
            daily = raw.get("daily") or {}
            temp = cur.get("temperature_2m")
            feels_like = cur.get("apparent_temperature")
            hum = cur.get("relative_humidity_2m")
            wcode = int(cur.get("weather_code") or 0)
            wind = float(cur.get("wind_speed_10m") or 0.0)
            tmax_list = daily.get("temperature_2m_max") or []
            tmin_list = daily.get("temperature_2m_min") or []
            temp_max = round(float(tmax_list[0]), 1) if tmax_list and tmax_list[0] is not None else None
            temp_min = round(float(tmin_list[0]), 1) if tmin_list and tmin_list[0] is not None else None

            if wind < 6.0:
                wind_desc = "微风"
            elif wind < 18.0:
                wind_desc = "轻风"
            elif wind < 35.0:
                wind_desc = "和风"
            else:
                wind_desc = "强风"

            desc = WMO_WEATHER_ZH.get(wcode, "多云")
            t_str = f"{float(temp):.0f}°C" if temp is not None else "--°C"
            hum_str = f"{int(round(float(hum)))}%" if hum is not None else "--%"
            range_str = (
                f" · {temp_min:.0f}~{temp_max:.0f}°"
                if temp_min is not None and temp_max is not None
                else ""
            )
            self._store_widget(
                "weather",
                {
                    "ok": True,
                    "city": city,
                    "temp": round(float(temp), 1) if temp is not None else None,
                    "feelsLike": round(float(feels_like), 1) if feels_like is not None else None,
                    "tempMax": temp_max,
                    "tempMin": temp_min,
                    "humidity": int(round(float(hum))) if hum is not None else None,
                    "wcode": wcode,
                    "wind": round(wind, 1),
                    "windDesc": wind_desc,
                    "desc": desc,
                    "headline": f"{t_str} · {desc}",
                    "subline": f"{city} · 湿度 {hum_str} · {wind_desc}{range_str}",
                },
            )
        except Exception:
            # Keep previous valid weather if we had one; else record graceful unavailable
            existing = self.get_widget("weather")
            if not existing:
                self._store_widget(
                    "weather",
                    {
                        "ok": False,
                        "city": city,
                        "temp": None,
                        "feelsLike": None,
                        "tempMax": None,
                        "tempMin": None,
                        "wcode": 0,
                        "desc": "暂无气象",
                        "wind": 0.0,
                        "windDesc": "微风",
                        "headline": f"{city} --°C",
                        "subline": "气象源暂不可达",
                    },
                )

    def _collect_custom_plugin(self, key: str, card: Dict[str, Any], *, connected: bool) -> None:
        plugin = str(card.get("plugin") or "").strip()
        if not plugin and str(card.get("kind") or "").startswith("plugin:"):
            plugin = str(card["kind"])[7:]
        action = str(card.get("action") or "status").strip() or "status"
        title = str(card.get("title") or plugin)
        if not connected or not plugin:
            self._store_widget(
                key,
                {
                    "ok": False,
                    "plugin": plugin,
                    "action": action,
                    "title": title,
                    "message": "等待连接主脑服务",
                    "kpis": [],
                    "headline": f"{title} · 待连接",
                    "subline": "等待主脑服务上线",
                },
            )
            return
        try:
            res = self._rpc({"command": "plugin-run", "plugin": plugin, "action": action, "args": {}}, 5.0)
            ok = bool(res.get("ok")) if isinstance(res, dict) else False
            r_title = str((res or {}).get("title") or title)[:24]
            msg = str((res or {}).get("message") or "").strip()
            kpis = _extract_scalars((res or {}).get("data"))
            first_line = next((ln.strip() for ln in msg.splitlines() if ln.strip()), "")
            kpi_summary = " · ".join(f"{kl} {kv}" for kl, kv in kpis[:2]) if kpis else ""
            self._store_widget(
                key,
                {
                    "ok": ok,
                    "plugin": plugin,
                    "action": action,
                    "title": r_title,
                    "message": msg[:240],
                    "kpis": kpis,
                    "headline": kpis[0][1] if kpis else (first_line[:22] or ("运行正常" if ok else "状态异常")),
                    "subline": first_line[:36] or kpi_summary or ("插件运行正常" if ok else "插件状态异常"),
                },
            )
        except Exception as exc:
            self._store_widget(
                key,
                {
                    "ok": False,
                    "plugin": plugin,
                    "action": action,
                    "title": title,
                    "message": str(exc)[:140],
                    "kpis": [],
                    "headline": "调用失败",
                    "subline": "插件调用失败，请稍后重试",
                },
            )

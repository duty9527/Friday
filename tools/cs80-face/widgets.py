"""CS80 Bento widget layout persistence, 2-column grid packer, plugin catalog & lazy TTL collectors."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple
import urllib.request

VALID_SIZES: Tuple[str, ...] = ("1x1", "2x1", "1x2", "2x2")
VALID_MARQUEE_MODES: Tuple[str, ...] = ("auto_pause", "continuous", "static")
BUILTIN_PLUGIN_WIDGETS: Tuple[str, ...] = (
    "fund-tracker",
    "health-scale",
    "miot",
    "ninebot",
    "tv-agent",
    "tv-ir",
)

WMO_WEATHER_ZH: Dict[int, str] = {
    0: "晴",
    1: "晴间少云",
    2: "多云",
    3: "阴",
    45: "雾",
    48: "冻雾",
    51: "毛毛雨",
    53: "小雨",
    55: "中雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "阵雨",
    81: "强阵雨",
    82: "暴雨",
    95: "雷阵雨",
}


def default_pages_payload() -> List[Dict[str, Any]]:
    return [
        {
            "id": "main",
            "name": "核心总览",
            "cards": [
                {"id": "c-fund", "kind": "fund-tracker", "size": "1x1"},
                {"id": "c-health", "kind": "health-scale", "size": "1x1"},
                {"id": "c-miot", "kind": "miot", "size": "1x1"},
                {"id": "c-sys", "kind": "system-pulse", "size": "1x1"},
            ],
        }
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
                ttl_sec=max(15, min(3600, int(card.get("ttlSec") or 120))),
            )
        )

    return placed, overflow


def _sanitize_card(raw: Any, fallback_id: str) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("kind") or "").strip()[:64]
    if not kind:
        return None
    card_id = re.sub(r"[^a-zA-Z0-9_-]", "", str(raw.get("id") or fallback_id))[:40] or fallback_id
    out: Dict[str, Any] = {
        "id": card_id,
        "kind": kind,
        "size": _clean_size(raw.get("size"), "1x1"),
    }
    if raw.get("plugin"):
        out["plugin"] = str(raw["plugin"]).strip()[:64]
    elif kind.startswith("plugin:"):
        out["plugin"] = kind[7:][:64]
    if raw.get("action"):
        out["action"] = str(raw["action"]).strip()[:64]
    if raw.get("title"):
        out["title"] = str(raw["title"]).strip()[:48]
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
            weather_lat = max(-85.0, min(85.0, float(merged.get("weatherLat") or 31.23)))
        except (TypeError, ValueError):
            weather_lat = 31.23
        try:
            weather_lon = max(-180.0, min(180.0, float(merged.get("weatherLon") or 121.47)))
        except (TypeError, ValueError):
            weather_lon = 121.47

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
                src = default_layout_dict()
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
            "title": "基金持仓与盈亏",
            "subtitle": "资产净值 · 日盈亏率 · 收益曲线与重点持仓",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": manifests.get("fund-tracker", {}).get("enabled", True),
        },
        {
            "kind": "health-scale",
            "category": "plugin",
            "plugin": "health-scale",
            "title": "体脂健康档案",
            "subtitle": "体重走势 · 体脂骨骼肌 · BMI 与身体评分",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": manifests.get("health-scale", {}).get("enabled", True),
        },
        {
            "kind": "miot",
            "category": "plugin",
            "plugin": "miot",
            "title": "米家全屋智能",
            "subtitle": "房间环境 · 在线设备开关状态矩阵",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": manifests.get("miot", {}).get("enabled", True),
        },
        {
            "kind": "ninebot",
            "category": "plugin",
            "plugin": "ninebot",
            "title": "九号守护",
            "subtitle": "电量与72V电压 · 精准续航 · 充电功率与锁车定位",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": manifests.get("ninebot", {}).get("enabled", True),
        },
        {
            "kind": "system-pulse",
            "category": "core",
            "title": "主机算力脉搏",
            "subtitle": "CPU 负载 · 内存磁盘 · 定时日程与通道在线率",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": True,
        },
        {
            "kind": "tv-agent",
            "category": "plugin",
            "plugin": "tv-agent",
            "title": "智能电视控制",
            "subtitle": "电视在线/待机 · 音量静音 · 前台应用",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": manifests.get("tv-agent", {}).get("enabled", True),
        },
        {
            "kind": "tv-ir",
            "category": "plugin",
            "plugin": "tv-ir",
            "title": "音箱红外遥控",
            "subtitle": "LX06 红外 TX/RX 就绪 · 预设与学习按键",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": manifests.get("tv-ir", {}).get("enabled", True),
        },
        {
            "kind": "memory",
            "category": "core",
            "title": "全息突触记忆",
            "subtitle": "活跃记忆量 · 赫布突触连接网络图谱",
            "defaultSize": "2x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": True,
        },
        {
            "kind": "timers",
            "category": "core",
            "title": "定时与目标调度",
            "subtitle": "启用中的定时巡检、单次提醒与目标跟踪",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": True,
        },
        {
            "kind": "usage",
            "category": "core",
            "title": "今日算力与消费",
            "subtitle": "调用次数 · Token 消耗与预估费用",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": True,
        },
        {
            "kind": "weather",
            "category": "core",
            "title": "实时气象卡片",
            "subtitle": "当前温度 · 天气实况与风速（Open-Meteo）",
            "defaultSize": "1x1",
            "supportedSizes": list(VALID_SIZES),
            "enabled": True,
        },
        {
            "kind": "workers",
            "category": "core",
            "title": "活跃 Worker 任务",
            "subtitle": "后台并发代理、耗时与提问等待状态",
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
                "subtitle": (info.get("description") or "自定义插件实时卡片")[:68],
                "actions": actions,
                "defaultAction": default_act,
                "configurableAction": True,
                "defaultSize": "1x1",
                "supportedSizes": list(VALID_SIZES),
                "enabled": info.get("enabled", True),
            }
        )

    return catalog


def _is_market_hours_now() -> bool:
    lt = time.localtime()
    if lt.tm_wday >= 5:
        return False
    hm = lt.tm_hour * 60 + lt.tm_min
    return (9 * 60 + 15 <= hm <= 15 * 60 + 15) or (hm >= 21 * 60) or (hm <= 5 * 60)


def _fmt_money(v: float) -> str:
    sign = "+" if v > 0 else ("-" if v < 0 else "")
    av = abs(v)
    if av >= 100_000:
        return f"{sign}{av / 10000.0:.2f}万"
    return f"{sign}{av:,.0f}"


def _extract_scalars(obj: Any, prefix: str = "", out: Optional[List[Tuple[str, str]]] = None) -> List[Tuple[str, str]]:
    if out is None:
        out = []
    if len(out) >= 6 or obj is None:
        return out
    if isinstance(obj, dict):
        for k, v in list(obj.items())[:14]:
            if len(out) >= 6:
                break
            ks = str(k)
            if ks.lower() in ("token", "secret", "password", "cookies", "rawadv", "impedances", "adcs"):
                continue
            label = f"{prefix}.{ks}" if prefix else ks
            if isinstance(v, (int, float, bool)):
                if isinstance(v, bool):
                    val = "是" if v else "否"
                elif isinstance(v, float):
                    val = f"{v:.2f}".rstrip("0").rstrip(".")
                else:
                    val = str(v)
                out.append((ks[:12], val[:18]))
            elif isinstance(v, str) and v.strip() and len(v.strip()) <= 26:
                out.append((ks[:12], v.strip()))
            elif isinstance(v, dict) and not prefix:
                _extract_scalars(v, label, out)
    return out


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
            ttl = 60.0 if _is_market_hours_now() else 300.0
            db_path = self.home / "plugins" / "fund-tracker" / "funds.sqlite"
            mtime_changed = self._file_mtime_changed("fund-tracker", db_path)
            if mtime_changed or self._due("fund-tracker", ttl, now_mono, force=force):
                self._collect_fund_tracker(db_path, connected=connected, allow_refresh=_is_market_hours_now())

        if "health-scale" in by_kind:
            db_path = self.home / "plugins" / "health-scale" / "health.db"
            sess_path = self.home / "plugins" / "health-scale" / "live-session.json"
            m1 = self._file_mtime_changed("health-scale:db", db_path)
            m2 = self._file_mtime_changed("health-scale:sess", sess_path)
            if m1 or m2 or self._due("health-scale", 600.0, now_mono, force=force):
                self._collect_health_scale(db_path, connected=connected)

        if "miot" in by_kind:
            cache_path = self.home / "plugins" / "miot" / "hub-cache.json"
            m_changed = self._file_mtime_changed("miot:cache", cache_path)
            if m_changed or self._due("miot", 180.0, now_mono, force=force):
                self._collect_miot(cache_path, connected=connected)

        if "ninebot" in by_kind:
            db_path = self.home / "plugins" / "ninebot" / "ninebot.sqlite"
            m_changed = self._file_mtime_changed("ninebot:db", db_path)
            if m_changed or self._due("ninebot", 180.0, now_mono, force=force):
                self._collect_ninebot(db_path, connected=connected)

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
                "headline": f"CPU {cpu_pct:.0f}% · RAM {mem_pct:.0f}%",
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
                    "headline": f"¥{cost_cny:.2f} · {calls}次",
                    "subline": f"Token {tok_str} · ${cost_usd:.3f}",
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
                    "headline": f"{len(works)} 个并发任务" if works else "Worker 队列空闲",
                    "subline": rows[0]["prompt"] if rows else "主脑随时可执行代码/研究子任务",
                },
            )

    def _collect_fund_tracker(self, db_path: Path, *, connected: bool, allow_refresh: bool) -> None:
        # 1) Try Friday RPC dashboard first (fast SQLite computation, optional live fetch during market hours)
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
                        "args": {"refresh": bool(allow_refresh)},
                    },
                    10.0 if allow_refresh else 5.0,
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
                con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1.0)
                con.row_factory = sqlite3.Row
                cur = con.cursor()
                h_rows = cur.execute(
                    "SELECT code, name, cost, shares, last_nav, last_nav_date FROM holdings ORDER BY cost DESC LIMIT 12"
                ).fetchall()
                s_rows = cur.execute(
                    "SELECT date, total_cost, total_asset, daily_pnl, total_pnl, created_at FROM snapshots ORDER BY created_at DESC LIMIT 24"
                ).fetchall()
                con.close()
                total_cost = sum(float(r["cost"] or 0.0) for r in h_rows)
                total_asset = sum(float(r["shares"] or 0.0) * float(r["last_nav"] or 0.0) for r in h_rows)
                if s_rows:
                    latest_s = s_rows[0]
                    total_asset = float(latest_s["total_asset"] or total_asset)
                    daily_pnl = float(latest_s["daily_pnl"] or 0.0)
                    total_pnl = float(latest_s["total_pnl"] or (total_asset - total_cost))
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
                con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1.0)
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
                con.close()
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
        raw_devices: List[Dict[str, Any]] = []
        fetched_at = 0.0
        if cache_path.is_file():
            try:
                parsed = json.loads(cache_path.read_text(encoding="utf-8"))
                raw_devices = list(parsed.get("devices") or [])
                fetched_at = float(parsed.get("hotDataFetchedAt") or parsed.get("fetchedAt") or 0.0)
            except Exception:
                raw_devices = []

        cache_age_sec = (time.time() * 1000.0 - fetched_at) / 1000.0 if fetched_at > 0 else 999999.0
        if connected and (not raw_devices or cache_age_sec > 360.0):
            try:
                res = self._rpc(
                    {"command": "plugin-run", "plugin": "miot", "action": "devices", "args": {"live": False}},
                    6.0,
                )
                data = (res or {}).get("data") if isinstance(res, dict) else None
                if isinstance(data, dict) and isinstance(data.get("devices"), list):
                    raw_devices = list(data["devices"])
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
                    "devices": [],
                    "headline": "未连接米家中枢",
                    "subline": "请检查 miot hub-cache",
                },
            )
            return

        items: List[Dict[str, Any]] = []
        online_cnt = 0
        on_cnt = 0
        rooms: Dict[str, int] = {}
        for d in raw_devices:
            if not isinstance(d, dict):
                continue
            online = bool(d.get("online", True))
            if online:
                online_cnt += 1
            on_val: Optional[bool] = None
            if isinstance(d.get("state"), dict) and "on" in d["state"]:
                on_val = bool(d["state"]["on"])
            else:
                props = ((d.get("cachedState") or {}).get("properties") or {})
                if isinstance(props, dict) and "2.1" in props and isinstance(props["2.1"], dict):
                    v = props["2.1"].get("value")
                    if v is not None:
                        on_val = v in (True, 1, "1", "true")
            if on_val:
                on_cnt += 1
            name = str(d.get("dev_name") or d.get("name") or "设备")[:14]
            room = str(d.get("room_name") or d.get("room") or "默认")[:8]
            cat = str(d.get("category") or "")
            rooms[room] = rooms.get(room, 0) + 1
            items.append(
                {
                    "name": name,
                    "room": room,
                    "cat": cat,
                    "online": online,
                    "on": on_val,
                    "controllable": bool(d.get("controllable")),
                }
            )

        # Put controllable / currently ON items first
        items.sort(key=lambda x: (0 if x["on"] else (1 if x["controllable"] else 2), 0 if x["online"] else 1))
        self._store_widget(
            "miot",
            {
                "ok": True,
                "total": len(items),
                "online": online_cnt,
                "onCount": on_cnt,
                "rooms": len(rooms),
                "devices": items[:10],
                "headline": f"{online_cnt}/{len(items)} 在线",
                "subline": f"开启 {on_cnt} 台 · {len(rooms)} 个房间",
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
                con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1.0)
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
                con.close()
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

        batt_str = f"{batt_num}%" if batt_num is not None else "--%"
        range_str = f"续航 {float(range_km):.1f}km" if range_km is not None else "续航 --"
        lock_str = "⚡充电" if charging else ("未锁车" if (power_on or locked is False) else ("已锁" if locked is True else "待机"))
        self._store_widget(
            "ninebot",
            {
                "ok": True,
                "name": str(snap.get("name") or "九号电摩")[:16],
                "battery": batt_num,
                "auxBattery": int(round(float(aux_batt))) if aux_batt is not None else None,
                "voltageV": round(float(volt), 1) if volt is not None else None,
                "tempC": round(float(temp), 1) if temp is not None else None,
                "charging": charging,
                "chargingPowerW": int(round(float(charge_w))) if charge_w is not None else None,
                "remainChargeTime": remain_t,
                "rangeKm": round(float(range_km), 1) if range_km is not None else None,
                "odometerKm": round(float(odo_km), 1) if odo_km is not None else None,
                "powerOn": power_on,
                "locked": locked,
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

    def _collect_tv_agent(self, *, connected: bool) -> None:
        cfg_path = self.home / "plugins" / "tv-agent" / "config.json"
        tv_host = ""
        if cfg_path.is_file():
            try:
                tv_host = str(json.loads(cfg_path.read_text(encoding="utf-8")).get("tvHost") or "")
            except Exception:
                pass
        data: Dict[str, Any] = {}
        if connected:
            try:
                res = self._rpc({"command": "plugin-run", "plugin": "tv-agent", "action": "status", "args": {}}, 3.5)
                if isinstance(res, dict) and isinstance(res.get("data"), dict):
                    data = dict(res["data"])
            except Exception:
                pass
        online = data.get("powerState") == "online"
        vol = data.get("volume")
        muted = bool(data.get("muted"))
        app = str(data.get("appName") or data.get("packageName") or "")[:18]
        host = str(data.get("tvHost") or tv_host or "未配置")
        self._store_widget(
            "tv-agent",
            {
                "ok": online or bool(host != "未配置"),
                "online": online,
                "host": host,
                "appName": app or ("桌面待机" if online else "已关机"),
                "volume": vol,
                "muted": muted,
                "dlnaOk": bool(data.get("dlnaReachable")),
                "agentOk": bool(data.get("agentReachable")),
                "headline": "TV 在线" if online else "TV 待机",
                "subline": (f"{app or '在线'} · 音量 {vol if vol is not None else '--'}" if online else f"主机 {host}"),
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
                res = self._rpc({"command": "plugin-run", "plugin": "tv-ir", "action": "status", "args": {}}, 4.0)
                if isinstance(res, dict):
                    ok = bool(res.get("ok"))
                    if isinstance(res.get("data"), dict):
                        data = dict(res["data"])
            except Exception:
                pass
        tx_ready = bool(data.get("txReady", False))
        rx_ready = bool(data.get("rxReady", False))
        preset_cnt = int(data.get("presetCount") or 12)
        learned_cnt = int(data.get("learnedCount") if data.get("learnedCount") is not None else learned_cnt)
        self._store_widget(
            "tv-ir",
            {
                "ok": ok and tx_ready,
                "txReady": tx_ready,
                "rxReady": rx_ready,
                "presetCount": preset_cnt,
                "learnedCount": learned_cnt,
                "headline": "红外就绪" if tx_ready else "红外待检",
                "subline": f"预设 {preset_cnt} 键 · 已学 {learned_cnt} 键",
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
                    "desc": "离线模式",
                    "wind": 0.0,
                    "headline": f"{city} · 离线",
                    "subline": "网络检查已禁用",
                },
            )
            return
        try:
            url = (
                f"https://api.open-meteo.com/v1/forecast?latitude={lat:.4f}&longitude={lon:.4f}"
                "&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto"
            )
            req = urllib.request.Request(url, headers={"User-Agent": "friday-cs80/1.0"})
            with urllib.request.urlopen(req, timeout=2.5) as resp:
                raw = json.loads(resp.read().decode("utf-8"))
            cur = raw.get("current") or {}
            temp = cur.get("temperature_2m")
            hum = cur.get("relative_humidity_2m")
            wcode = int(cur.get("weather_code") or 0)
            wind = float(cur.get("wind_speed_10m") or 0.0)
            desc = WMO_WEATHER_ZH.get(wcode, "多云")
            t_str = f"{float(temp):.0f}°C" if temp is not None else "--°C"
            self._store_widget(
                "weather",
                {
                    "ok": True,
                    "city": city,
                    "temp": float(temp) if temp is not None else None,
                    "humidity": int(hum) if hum is not None else None,
                    "wind": round(wind, 1),
                    "desc": desc,
                    "headline": f"{t_str} · {desc}",
                    "subline": f"{city} · 湿度 {hum or '--'}% · 风 {wind:.0f}km/h",
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
                        "desc": "暂无气象",
                        "wind": 0.0,
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
                    "message": "等待连接 F.R.I.D.A.Y. 服务",
                    "kpis": [],
                    "headline": f"{title} · 待连接",
                    "subline": f"action={action}",
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
            self._store_widget(
                key,
                {
                    "ok": ok,
                    "plugin": plugin,
                    "action": action,
                    "title": r_title,
                    "message": msg[:240],
                    "kpis": kpis,
                    "headline": kpis[0][1] if kpis else (first_line[:22] or ("在线" if ok else "异常")),
                    "subline": first_line[:36] or f"{plugin}/{action}",
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
                    "subline": str(exc)[:34],
                },
            )

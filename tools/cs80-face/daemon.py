#!/usr/bin/env python3
"""F.R.I.D.A.Y. native CS80 face & speaker daemon."""

from __future__ import annotations

import argparse
import base64
from collections import deque
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import platform
import queue
import re
import signal
import struct
import subprocess
import sys
import threading
import time
from typing import Any, Deque, Dict, List, Optional, Tuple
from urllib.parse import parse_qs

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from audio import SpeakerController  # noqa: E402
from avatar_math import BotAnimator, FaceSnapshot  # noqa: E402
from friday_client import FridayClient, FridaySnapshot, resolve_friday_home  # noqa: E402
from renderer import FaceRenderer, FRAME_BYTES, HudState, WorkerSummary, stage_geometry_for_rows  # noqa: E402
from widgets import (  # noqa: E402
    LayoutStore,
    WidgetDataHub,
    discover_widget_catalog,
    pack_bento_page,
)

CTL_BRIGHTNESS = 1
CTL_SLEEP = 2
CTL_WAKE = 3
CTL_STATE = 4
CTL_HELLO = 5
_BLACK_FRAME_BYTES = bytes(FRAME_BYTES)

SCENE_STATES = (
    "speaking",
    "sending_msg",
    "printing",
    "operating_xiaoai",
    "operating_tv",
    "managing_laifen",
    "weighing_scale",
)
DEVICE_SCENES = (
    "printing",
    "operating_xiaoai",
    "operating_tv",
    "managing_laifen",
    "weighing_scale",
)


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

BIN_QDC1 = SCRIPT_DIR / "bin" / "qdc1"
RULES_FILE = SCRIPT_DIR / "99-cs80.rules"


def probe_cs80_usb() -> Dict[str, Any]:
    """Inspect Linux sysfs for Quectel CS80 (2c7c:0901) speed and device node permissions."""
    if platform.system() != "Linux":
        return {"present": True, "accessible": True, "speed": None, "dev_path": None}
    sys_usb = Path("/sys/bus/usb/devices")
    if not sys_usb.is_dir():
        return {"present": False, "accessible": False, "speed": None, "dev_path": None}
    for dev in sys_usb.iterdir():
        vid_p = dev / "idVendor"
        pid_p = dev / "idProduct"
        if not (vid_p.is_file() and pid_p.is_file()):
            continue
        try:
            if vid_p.read_text().strip().lower() != "2c7c":
                continue
            if pid_p.read_text().strip().lower() != "0901":
                continue
            busnum = int((dev / "busnum").read_text().strip())
            devnum = int((dev / "devnum").read_text().strip())
            speed_raw = (dev / "speed").read_text().strip() if (dev / "speed").is_file() else ""
            speed = int(float(speed_raw)) if speed_raw else None
            dev_path = f"/dev/bus/usb/{busnum:03d}/{devnum:03d}"
            accessible = os.access(dev_path, os.R_OK | os.W_OK)
            return {
                "present": True,
                "accessible": accessible,
                "speed": speed,
                "dev_path": dev_path,
                "sysfs": str(dev),
            }
        except (OSError, ValueError):
            continue
    return {"present": False, "accessible": False, "speed": None, "dev_path": None}


def build_udev_hint() -> str:
    return (
        f"sudo install -m 644 {RULES_FILE} /etc/udev/rules.d/99-cs80.rules && "
        "sudo udevadm control --reload-rules && "
        "sudo udevadm trigger --subsystem-match=usb --attr-match=idVendor=2c7c"
    )


def _parse_finite_float(val: Any, default: float, name: str = "value") -> float:
    if val is None:
        return default
    if isinstance(val, bool):
        raise ValueError(f"invalid-{name}")
    f = float(val)
    if not math.isfinite(f):
        raise ValueError(f"invalid-{name}")
    return f


def _parse_int(val: Any, default: Optional[int] = None, name: str = "value") -> int:
    if val is None:
        if default is not None:
            return default
        raise ValueError(f"invalid-{name}")
    if isinstance(val, bool):
        raise ValueError(f"invalid-{name}")
    if isinstance(val, int):
        return val
    f = float(val)
    if not math.isfinite(f):
        raise ValueError(f"invalid-{name}")
    return int(round(f))


_TIME_RANGE_RE = re.compile(r"^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$")


def normalize_time_range(raw: str, name: str = "nightStandbyHours") -> str:
    s = raw.strip()
    if not s:
        return ""
    m = _TIME_RANGE_RE.match(s)
    if not m:
        raise ValueError(f"invalid-{name}")
    sh, sm, eh, em = (int(m.group(i)) for i in range(1, 5))
    if not (0 <= sh <= 23 and 0 <= sm <= 59 and 0 <= eh <= 23 and 0 <= em <= 59):
        raise ValueError(f"invalid-{name}")
    if sh * 60 + sm == eh * 60 + em:
        raise ValueError(f"invalid-{name}")
    return f"{sh:02d}:{sm:02d}-{eh:02d}:{em:02d}"


def is_in_time_range(spec: str, now_dt: Optional[datetime] = None) -> bool:
    raw = (spec or "").strip()
    if not raw or "-" not in raw:
        return False
    m = _TIME_RANGE_RE.match(raw)
    if not m:
        return False
    sh, sm, eh, em = (int(m.group(i)) for i in range(1, 5))
    if not (0 <= sh <= 23 and 0 <= sm <= 59 and 0 <= eh <= 23 and 0 <= em <= 59):
        return False
    dt = now_dt or datetime.now()
    cur = dt.hour * 60 + dt.minute
    start = sh * 60 + sm
    end = eh * 60 + em
    if start == end:
        return False
    if start < end:
        return start <= cur < end
    return cur >= start or cur < end


class ScreenPolicyStore:
    """Thread-safe atomic JSON persistence for CS80 brightness & auto-standby policies."""

    def __init__(self, data_dir: Path, *, default_night_enabled: bool = True) -> None:
        self.data_dir = Path(data_dir)
        self.path = self.data_dir / "screen.json"
        self._default_night_enabled = bool(default_night_enabled)
        self._lock = threading.Lock()
        self._config = self._load()

    def _defaults(self) -> Dict[str, Any]:
        return {
            "brightness": 100,
            "nightStandbyEnabled": self._default_night_enabled,
            "nightStandbyHours": "23:00-07:30",
            "idleStandbyEnabled": False,
            "idleStandbyMin": 15,
            "tempWakeSec": 90,
            "manualStandby": False,
        }

    def _normalize(self, raw: Dict[str, Any], base: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        cfg = dict(base or self._defaults())
        if "brightness" in raw and raw["brightness"] is not None:
            bri = _parse_int(raw["brightness"], None, "brightness")
            cfg["brightness"] = max(5, min(100, (bri // 5) * 5))
        if "nightStandbyEnabled" in raw and raw["nightStandbyEnabled"] is not None:
            val = raw["nightStandbyEnabled"]
            if not isinstance(val, bool):
                raise ValueError("invalid-nightStandbyEnabled")
            cfg["nightStandbyEnabled"] = val
        if "nightStandbyHours" in raw and raw["nightStandbyHours"] is not None:
            val = raw["nightStandbyHours"]
            if not isinstance(val, str):
                raise ValueError("invalid-nightStandbyHours")
            cfg["nightStandbyHours"] = normalize_time_range(val, "nightStandbyHours")
        if "idleStandbyEnabled" in raw and raw["idleStandbyEnabled"] is not None:
            val = raw["idleStandbyEnabled"]
            if not isinstance(val, bool):
                raise ValueError("invalid-idleStandbyEnabled")
            cfg["idleStandbyEnabled"] = val
        if "idleStandbyMin" in raw and raw["idleStandbyMin"] is not None:
            mins = _parse_int(raw["idleStandbyMin"], None, "idleStandbyMin")
            if mins < 1 or mins > 720:
                raise ValueError("invalid-idleStandbyMin")
            cfg["idleStandbyMin"] = mins
        if "tempWakeSec" in raw and raw["tempWakeSec"] is not None:
            sec = _parse_int(raw["tempWakeSec"], None, "tempWakeSec")
            if sec < 15 or sec > 1800:
                raise ValueError("invalid-tempWakeSec")
            cfg["tempWakeSec"] = sec
        if "manualStandby" in raw and raw["manualStandby"] is not None:
            val = raw["manualStandby"]
            if not isinstance(val, bool):
                raise ValueError("invalid-manualStandby")
            cfg["manualStandby"] = val
        return cfg

    def _load(self) -> Dict[str, Any]:
        defaults = self._defaults()
        try:
            raw = json.loads(self.path.read_text("utf-8"))
            if not isinstance(raw, dict):
                return defaults
            return self._normalize(raw, defaults)
        except (OSError, ValueError, TypeError):
            return defaults

    def _save_locked(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.data_dir / f".tmp-screen.{os.getpid()}.{threading.get_ident()}.json"
        try:
            tmp.write_text(json.dumps(self._config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            tmp.replace(self.path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise

    def get(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self._config)

    def update(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            updated = self._normalize(patch, self._config)
            self._config = updated
            self._save_locked()
            return dict(updated)


class SidecarBridge:
    """Thread-safe subprocess wrapper around qdc1 (or --mock-sidecar)."""

    def __init__(
        self,
        *,
        mock: bool = False,
        mock_log: Optional[Path] = None,
        on_ready: Optional[Any] = None,
        on_patch_lost: Optional[Any] = None,
    ) -> None:
        self.mock = mock
        self.mock_log = mock_log
        self._on_ready = on_ready
        self._on_patch_lost = on_patch_lost

        self._proc: Optional[subprocess.Popen[bytes]] = None
        self._write_lock = threading.Lock()
        self._ctl_lock = threading.Lock()
        self._cond = threading.Condition()
        self._stop_event = threading.Event()
        self._stop = False

        self.state = "disconnected"  # disconnected | permission_denied | connecting | up | no_sidecar
        self.usb_speed: Optional[int] = None
        self.dev_path: Optional[str] = None
        self.udev_hint: Optional[str] = None
        self.block_size: int = 0
        self.features: int = 0
        self._features_ready: bool = False
        self.session: int = 0
        self.last_error: Optional[str] = None
        self.last_frame_ms: int = 0
        self.last_patch_ms: int = 0
        self.last_patch_tiles: int = 0
        self.device_brightness: Optional[int] = None
        self.device_backlight_pwm: Optional[int] = None
        self.device_edges: Optional[int] = None
        self.device_awake: Optional[bool] = None

        self._audio_n: int = 0
        self._audio_seq: int = 0
        self._last_audio_ev: Optional[Dict[str, Any]] = None
        self._last_ctl_ev: Optional[Dict[str, Any]] = None
        self._ctl_seq: int = 0
        self._mock_commands: Deque[Dict[str, Any]] = deque(maxlen=120)
        self._thread = threading.Thread(target=self._run_loop, name="qdc1-supervisor", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop = True
        self._stop_event.set()
        proc = self._proc
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=2.0)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        with self._cond:
            self._cond.notify_all()

    def is_up(self) -> bool:
        return self.state == "up" and self._proc is not None and self._proc.poll() is None

    def wait_features(self, timeout: float = 0.5) -> int:
        deadline = time.monotonic() + max(0.0, timeout)
        with self._cond:
            while not self._features_ready and self.is_up():
                rem = deadline - time.monotonic()
                if rem <= 0:
                    break
                self._cond.wait(timeout=rem)
            return self.features

    def snapshot_status(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "device": self.state,
            "usbSpeed": self.usb_speed,
            "devPath": self.dev_path,
            "block": self.block_size,
            "features": self.features,
            "session": self.session,
            "lastError": self.last_error,
            "udevHint": self.udev_hint,
            "hwState": {
                "brightness": self.device_brightness,
                "backlightPwm": self.device_backlight_pwm,
                "edges": self.device_edges,
                "awake": self.device_awake,
                "sleepSupported": bool(self.features & 0x40),
            },
            "stats": {
                "frameMs": self.last_frame_ms,
                "patchMs": self.last_patch_ms,
                "patchTiles": self.last_patch_tiles,
            },
        }
        if self.mock:
            with self._cond:
                out["mockCommands"] = list(self._mock_commands)[-40:]
        return out

    def _run_loop(self) -> None:
        backoff = 1.5
        while not self._stop:
            if not self.mock:
                usb = probe_cs80_usb()
                self.usb_speed = usb.get("speed")
                self.dev_path = usb.get("dev_path")
                if not usb.get("present"):
                    self.state = "disconnected"
                    self.udev_hint = None
                    self.last_error = "CS80 USB device (2c7c:0901) not detected"
                    self._stop_event.wait(timeout=2.5)
                    continue
                if not usb.get("accessible") and os.geteuid() != 0:
                    self.state = "permission_denied"
                    self.udev_hint = build_udev_hint()
                    self.last_error = f"Permission denied on {self.dev_path}; install udev rule"
                    self._stop_event.wait(timeout=3.0)
                    continue
                if not BIN_QDC1.is_file():
                    self.state = "no_sidecar"
                    self.last_error = f"Missing binary {BIN_QDC1}"
                    self._stop_event.wait(timeout=5.0)
                    continue
                cmd = [str(BIN_QDC1)]
            else:
                self.usb_speed = 480
                self.dev_path = "mock://2c7c:0901"
                cmd = [sys.executable, "-u", str(Path(__file__).resolve()), "--internal-mock-sidecar"]
                if self.mock_log is not None:
                    cmd += ["--mock-log", str(self.mock_log)]

            self.udev_hint = None
            self.state = "connecting"
            self.last_error = None
            with self._cond:
                self.features = 0
                self._features_ready = False
                self._audio_n = 0
                self._last_audio_ev = None
                self._last_ctl_ev = None
            try:
                proc = subprocess.Popen(
                    cmd,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    bufsize=0,
                )
            except Exception as exc:
                self.state = "disconnected"
                self.last_error = str(exc)
                self._stop_event.wait(timeout=backoff)
                backoff = min(5.0, backoff * 1.5)
                continue

            self._proc = proc
            stderr_lines: List[str] = []

            def read_stderr() -> None:
                assert proc.stderr is not None
                for raw in proc.stderr:
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    stderr_lines.append(line)
                    if len(stderr_lines) > 20:
                        stderr_lines.pop(0)
                    print(f"[qdc1] {line}", file=sys.stderr, flush=True)
                    if "patch hash mismatch" in line or "need full frame" in line:
                        if self._on_patch_lost:
                            self._on_patch_lost()

            err_thread = threading.Thread(target=read_stderr, daemon=True)
            err_thread.start()

            rc = 0
            try:
                assert proc.stdout is not None
                for raw in proc.stdout:
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    try:
                        ev = json.loads(line)
                    except ValueError:
                        continue
                    self._handle_event(ev)
                rc = proc.wait()
                err_thread.join(timeout=1.0)
            finally:
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    if stream is not None:
                        try:
                            stream.close()
                        except OSError:
                            pass
                self._proc = None

            if self._stop:
                break
            was_up = self.state == "up"
            self.state = "disconnected"
            if stderr_lines:
                self.last_error = stderr_lines[-1]
            elif rc != 0:
                self.last_error = f"qdc1 exited with code {rc}"
            with self._cond:
                self._cond.notify_all()
            if was_up:
                backoff = 1.5
            self._stop_event.wait(timeout=backoff)
            backoff = min(5.0, backoff * 1.4)

    def _handle_event(self, ev: Dict[str, Any]) -> None:
        kind = ev.get("event")
        if self.mock and kind == "mock-cmd":
            with self._cond:
                self._mock_commands.append(ev)
            return
        if kind == "ready":
            with self._cond:
                self.block_size = int(ev.get("block") or 0)
                self._audio_n = 0
                self._last_audio_ev = None
                self._last_ctl_ev = None
                self.session += 1
                self.state = "up"
                self.last_error = None
                self._cond.notify_all()
            if self._on_ready:
                self._on_ready()
        elif kind == "features":
            with self._cond:
                self.features = int(ev.get("bits") or 0)
                self._features_ready = True
                self._cond.notify_all()
        elif kind in ("frame", "saver"):
            self.last_frame_ms = int(ev.get("ms") or 0)
        elif kind == "patch":
            self.last_patch_ms = int(ev.get("ms") or 0)
            self.last_patch_tiles = int(ev.get("tiles") or 0)
            if not ev.get("ok") and self._on_patch_lost:
                self._on_patch_lost()
        elif kind == "state":
            self.device_brightness = int(ev.get("brightness") or 0)
            self.device_backlight_pwm = int(ev.get("backlight") or 0)
            self.device_edges = int(ev.get("edges") or 0)
            with self._cond:
                self._ctl_seq += 1
                self._last_ctl_ev = ev
                self._cond.notify_all()
        elif kind in ("brightness", "power", "hello", "control"):
            if kind == "power" and ev.get("ok") and (self.features & 0x40):
                self.device_awake = bool(ev.get("awake"))
            with self._cond:
                self._ctl_seq += 1
                self._last_ctl_ev = ev
                self._cond.notify_all()
        elif kind in ("audio", "audio-data", "pcm"):
            with self._cond:
                self._audio_seq += 1
                self._audio_n = int(ev.get("n") or 0)
                self._last_audio_ev = ev
                self._cond.notify_all()

    def _write_raw(self, data: bytes) -> bool:
        proc = self._proc
        if proc is None or proc.poll() is not None or proc.stdin is None:
            return False
        with self._write_lock:
            try:
                proc.stdin.write(data)
                proc.stdin.flush()
                return True
            except (OSError, ValueError):
                return False

    def send_full_bgr565(self, frame_bytes: bytes) -> bool:
        if len(frame_bytes) != FRAME_BYTES:
            return False
        return self._write_raw(b"\x04" + frame_bytes)

    def send_patch(self, payload: bytes) -> bool:
        return self._write_raw(b"\x02" + payload)

    def send_ctl(self, cmd: int, arg: int = 0, wait_sec: float = 2.0) -> Dict[str, Any]:
        with self._ctl_lock:
            with self._cond:
                seq0 = self._ctl_seq
                session0 = self.session
            if not self._write_raw(bytes((0x03, cmd & 0xFF, arg & 0xFF))):
                return {"ok": False, "err": "device-down"}
            deadline = time.monotonic() + wait_sec
            with self._cond:
                while self._ctl_seq <= seq0:
                    rem = deadline - time.monotonic()
                    if rem <= 0 or self.session != session0 or not self.is_up():
                        return {"ok": False, "err": "timeout"}
                    self._cond.wait(timeout=rem)
                return dict(self._last_ctl_ev or {"ok": True})

    def send_audio_cmd(
        self, sub: int, offset: int = 0, raw: int = 0, payload: bytes = b"", timeout: float = 15.0
    ) -> Dict[str, Any]:
        with self._cond:
            seq0 = self._audio_seq
            session0 = self.session
        msg = b"\x05" + bytes((sub & 0xFF, 0, 0, 0)) + struct.pack("<III", len(payload), offset & 0xFFFFFFFF, raw & 0xFFFFFFFF) + payload
        if not self._write_raw(msg):
            return {"ok": False, "err": "device-down"}
        deadline = time.monotonic() + timeout
        with self._cond:
            while True:
                ev = self._last_audio_ev
                if (
                    ev is not None
                    and self._audio_seq > seq0
                    and ev.get("event") == "audio"
                    and int(ev.get("sub", -1)) == sub
                ):
                    return dict(ev)
                rem = deadline - time.monotonic()
                if rem <= 0 or self.session != session0 or not self.is_up():
                    return {"ok": False, "err": "timeout"}
                self._cond.wait(timeout=rem)

    def send_audio_block(self, offset: int, chunk: bytes, timeout: float = 5.0) -> Dict[str, Any]:
        with self._cond:
            seq0 = self._audio_seq
            session0 = self.session
        msg = b"\x06" + struct.pack("<II", offset & 0xFFFFFFFF, len(chunk)) + chunk
        if not self._write_raw(msg):
            return {"ok": False, "err": "device-down"}
        deadline = time.monotonic() + timeout
        with self._cond:
            while True:
                ev = self._last_audio_ev
                if (
                    ev is not None
                    and self._audio_seq > seq0
                    and ev.get("event") == "audio-data"
                    and (int(ev.get("offset", -1)) == offset or ev.get("ok") == 0)
                ):
                    return dict(ev)
                rem = deadline - time.monotonic()
                if rem <= 0 or self.session != session0 or not self.is_up():
                    return {"ok": False, "err": "timeout"}
                self._cond.wait(timeout=rem)


class FaceDaemon:
    """Coordinates Friday polling, animation loop, CS80 display, built-in speaker, and HTTP API."""

    def __init__(
        self,
        *,
        friday_home: Optional[str] = None,
        mock_sidecar: bool = False,
        mock_log: Optional[Path] = None,
        brightness: Optional[int] = None,
    ) -> None:
        self.friday = FridayClient(explicit_home=friday_home)
        self.data_dir = self.friday.home / "plugins" / "cs80-face"
        self.layout_store = LayoutStore(self.data_dir)
        self.screen_store = ScreenPolicyStore(self.data_dir, default_night_enabled=not mock_sidecar)
        self.widget_hub = WidgetDataHub(
            self.friday.home,
            self.friday.rpc,
            self.layout_store,
            disable_network=mock_sidecar,
        )
        self.renderer = FaceRenderer()
        self.animator = BotAnimator()

        self._lock = threading.Lock()
        self._hw_power_lock = threading.Lock()
        self._wake_event = threading.Event()
        self._widget_refresh_event = threading.Event()
        self._stop = False
        self._full_needed = True
        self._standby = False
        self._standby_reason = "none"
        self._last_activity_mono = time.monotonic()
        self._temp_wake_until = 0.0
        self._hw_standby_applied: Optional[bool] = None
        self._hw_standby_session = -1
        if brightness is not None:
            self._brightness = max(5, min(100, (int(brightness) // 5) * 5))
        else:
            self._brightness = int(self.screen_store.get()["brightness"])
        self._last_session_seen = -1

        self._banner_meta: Optional[str] = None
        self._banner_text: Optional[str] = None
        self._banner_until: float = 0.0
        self._transient_until: float = 0.0
        self._transient_state: Optional[str] = None
        self._voice_state: Optional[str] = None
        self._voice_caption: str = ""
        self._voice_until: float = 0.0
        self._voice_followup: bool = False
        self._scene_state: Optional[str] = None
        self._scene_channel: str = ""
        self._scene_caption: str = ""
        self._scene_until: float = 0.0
        self._scene_priority: int = 0
        self._scene_is_preview: bool = False
        self._live_file_scene: Optional[str] = None
        self._live_file_caption: str = ""
        self._live_file_cache: Dict[str, Tuple[int, Optional[Dict[str, Any]]]] = {}
        self._inbound_source: Optional[str] = None
        self._inbound_text: Optional[str] = None
        self._inbound_until: float = 0.0
        self._inbound_baseline_sig: Tuple[str, int] = ("", 0)
        self._last_page_rotate_at: float = time.monotonic()

        self._last_hud_key: Optional[Any] = None
        self._last_clock_hm: str = ""
        self._render_seq: int = 0
        self._cached_png: Tuple[int, bytes] = (-1, b"")
        self._last_snapshot = FridaySnapshot()
        self._sound_queue: "queue.Queue[Tuple[str, Dict[str, Any]]]" = queue.Queue()

        self.sidecar = SidecarBridge(
            mock=mock_sidecar,
            mock_log=mock_log,
            on_ready=self._on_sidecar_ready,
            on_patch_lost=self._on_patch_lost,
        )
        self.speaker = SpeakerController(self.data_dir, self.sidecar)
        with self._lock:
            self._refresh_standby_state_locked(self._last_activity_mono)

    def evaluate_standby(self, now_mono: float, now_dt: Optional[datetime] = None) -> Tuple[bool, str]:
        """Evaluate whether the physical CS80 screen should currently be in standby (call under self._lock)."""
        cfg = self.screen_store.get()
        voice_active = (
            (self._voice_state is not None and now_mono < self._voice_until)
            or (self._last_snapshot.bot_state == "listening")
        )
        if voice_active:
            self._last_activity_mono = now_mono
            self._temp_wake_until = max(self._temp_wake_until, now_mono + int(cfg["tempWakeSec"]))
            return False, "none"

        in_night = bool(cfg["nightStandbyEnabled"]) and is_in_time_range(
            str(cfg["nightStandbyHours"]),
            now_dt=now_dt,
        )
        if cfg["manualStandby"]:
            if now_mono < self._temp_wake_until:
                return False, "none"
            return True, "manual"
        if in_night:
            if now_mono < self._temp_wake_until:
                return False, "none"
            return True, "night"
        if cfg["idleStandbyEnabled"]:
            idle_sec = int(cfg["idleStandbyMin"]) * 60.0
            if (now_mono - self._last_activity_mono) >= idle_sec and now_mono >= self._temp_wake_until:
                return True, "idle"
        return False, "none"

    def _refresh_standby_state_locked(self, now_mono: float, now_dt: Optional[datetime] = None) -> Tuple[bool, str]:
        standby, reason = self.evaluate_standby(now_mono, now_dt=now_dt)
        self._standby = standby
        self._standby_reason = reason
        return standby, reason

    def _mark_user_activity_locked(self, now_mono: float, *, wake: bool = True) -> None:
        self._last_activity_mono = now_mono
        if wake:
            cfg = self.screen_store.get()
            self._temp_wake_until = max(self._temp_wake_until, now_mono + int(cfg["tempWakeSec"]))
        was_standby = self._standby
        standby_now, _ = self._refresh_standby_state_locked(now_mono)
        if was_standby and not standby_now:
            self._full_needed = True
            self.renderer.invalidate_prev()

    def _sync_hardware_standby(self, target_standby: bool, *, force: bool = False) -> Dict[str, Any]:
        """Apply hardware standby (black frame + CTL_SLEEP on 0x40 or CTL_BRIGHTNESS 0/5 on 0.3.0) outside self._lock."""
        with self._hw_power_lock:
            if not self.sidecar.is_up():
                return {"ok": True, "deferred": True, "standby": target_standby}
            session = self.sidecar.session
            with self._lock:
                already_synced = (
                    not force
                    and self._hw_standby_session == session
                    and self._hw_standby_applied == target_standby
                )
            if already_synced:
                return {"ok": True, "unchanged": True, "standby": target_standby}

            feats = self.sidecar.wait_features(timeout=0.5)
            supports_hw_sleep = bool(feats & 0x40)
            if target_standby:
                self.sidecar.send_full_bgr565(_BLACK_FRAME_BYTES)
                if supports_hw_sleep:
                    res = self.sidecar.send_ctl(CTL_SLEEP, 0)
                    self.sidecar.send_ctl(CTL_STATE, 0)
                else:
                    res = self.sidecar.send_ctl(CTL_BRIGHTNESS, 0)
                    if not (res.get("ok") and int(res.get("value", 100)) <= 5):
                        res = self.sidecar.send_ctl(CTL_BRIGHTNESS, 5)
                    self.sidecar.send_ctl(CTL_STATE, 0)
                with self._lock:
                    self._full_needed = True
                    self.renderer.invalidate_prev()
                    if res.get("ok"):
                        self._hw_standby_applied = True
                        self._hw_standby_session = session
                return res

            if supports_hw_sleep:
                res = self.sidecar.send_ctl(CTL_WAKE, 0)
            else:
                res = {"ok": True}
            with self._lock:
                bri = self._brightness
            bri_res = self.sidecar.send_ctl(CTL_BRIGHTNESS, bri)
            self.sidecar.send_ctl(CTL_STATE, 0)
            if res.get("ok") and bri_res.get("ok"):
                with self._lock:
                    self._hw_standby_applied = False
                    self._hw_standby_session = session
            return res if not res.get("ok") else bri_res

    def _on_sidecar_ready(self) -> None:
        with self._lock:
            self._full_needed = True
            self.renderer.invalidate_prev()
        self._sound_queue.put(("ready", {}))
        self._wake_event.set()

    def _on_patch_lost(self) -> None:
        with self._lock:
            self._full_needed = True
            self.renderer.invalidate_prev()
        self._wake_event.set()

    def start(self) -> None:
        self.sidecar.start()
        threading.Thread(target=self._sound_worker, name="cs80-sound", daemon=True).start()
        threading.Thread(target=self._friday_poll_loop, name="friday-poll", daemon=True).start()
        threading.Thread(target=self._widget_poll_loop, name="cs80-widgets", daemon=True).start()
        threading.Thread(target=self._render_loop, name="cs80-render", daemon=True).start()

    def stop(self) -> None:
        self._stop = True
        self._wake_event.set()
        self._widget_refresh_event.set()
        self.sidecar.stop()

    def _widget_poll_loop(self) -> None:
        # Initial fast collection once daemon starts
        while not self._stop:
            with self._lock:
                snap = self._last_snapshot
                in_standby = self._standby
            last_view = self.friday.last_view
            prev_rev, _ = self.widget_hub.snapshot_all()
            forced = self._widget_refresh_event.is_set()
            if forced:
                self._widget_refresh_event.clear()
            if not in_standby or forced:
                try:
                    self.widget_hub.refresh_due(last_view, connected=snap.connected, force=False)
                except Exception:
                    pass
                new_rev, _ = self.widget_hub.snapshot_all()
                if new_rev != prev_rev or forced:
                    self._wake_event.set()
            self._widget_refresh_event.wait(timeout=10.0 if in_standby else 2.0)

    def _apply_scene(
        self,
        scene: str,
        *,
        now: float,
        hold_sec: float,
        channel: str = "",
        caption: str = "",
        force: bool = False,
        is_preview: bool = False,
    ) -> None:
        norm = scene.strip().lower()
        ch = channel.strip().lower()
        if norm == "sending_wechat":
            norm = "sending_msg"
            ch = ch or "wechat"
        elif norm == "sending_telegram":
            norm = "sending_msg"
            ch = ch or "telegram"
        if norm not in SCENE_STATES:
            return
        prio = 2 if norm in DEVICE_SCENES else 1
        if not force and self._scene_state and now < self._scene_until and self._scene_priority > prio:
            return
        self._scene_state = norm
        self._scene_priority = prio
        self._scene_channel = ch
        self._scene_caption = caption.strip()
        self._scene_until = now + max(0.2, float(hold_sec))
        self._scene_is_preview = is_preview

    def _clear_scene(
        self,
        scene: Optional[str] = None,
        *,
        now: float,
        tail_sec: float = 0.0,
    ) -> None:
        if scene and self._scene_state != scene:
            return
        if tail_sec > 0.0 and self._scene_state:
            self._scene_until = now + tail_sec
            return
        self._scene_state = None
        self._scene_channel = ""
        self._scene_caption = ""
        self._scene_until = 0.0
        self._scene_priority = 0
        self._scene_is_preview = False

    def _read_cached_plugin_json(self, path: Path) -> Optional[Dict[str, Any]]:
        key = str(path)
        try:
            st = path.stat()
        except OSError:
            self._live_file_cache.pop(key, None)
            return None
        cached = self._live_file_cache.get(key)
        if cached and cached[0] == st.st_mtime_ns:
            return cached[1]
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            raw = None
        parsed = raw if isinstance(raw, dict) else None
        self._live_file_cache[key] = (st.st_mtime_ns, parsed)
        return parsed

    def _poll_plugin_live_scenes(self) -> Tuple[Optional[str], str, Optional[str]]:
        plugins_dir = self.friday.home / "plugins"
        now_ms = time.time() * 1000.0

        def _is_live_entry(raw: Optional[Dict[str, Any]], phases: Tuple[str, ...]) -> Optional[str]:
            if not raw:
                return None
            phase = str(raw.get("phase") or "").strip().lower()
            if phase not in phases:
                return None
            pid = raw.get("pid")
            if pid is not None:
                return phase if _is_pid_alive(pid) else None
            try:
                updated_ms = float(raw.get("updatedAt") or raw.get("startedAt") or 0.0)
            except (TypeError, ValueError):
                return None
            return phase if (updated_ms > 0.0 and (now_ms - updated_ms) < 10_000.0) else None

        hs_raw = self._read_cached_plugin_json(plugins_dir / "health-scale" / "live-session.json")
        hs_phase = _is_live_entry(hs_raw, ("scanning", "connecting", "measuring"))
        if hs_phase:
            caps = {
                "scanning": "沃莱 A1 扫描等待中 · 请赤脚上秤…",
                "connecting": "已发现沃莱 A1 · 正在建立蓝牙连接…",
                "measuring": "沃莱 A1 正在测量体重与体脂…",
            }
            return ("weighing_scale", caps.get(hs_phase, "沃莱 A1 测试模式 · 请赤脚上秤测量…"), None)

        lf_raw = self._read_cached_plugin_json(plugins_dir / "laifen" / "live-session.json")
        lf_phase = _is_live_entry(lf_raw, ("scanning", "connecting", "monitoring"))
        if lf_phase:
            caps = {
                "scanning": "正在蓝牙扫描徕芬电动牙刷…",
                "connecting": "正在连接徕芬电动牙刷…",
                "monitoring": "徕芬牙刷刷牙实时监听中…",
            }
            return ("managing_laifen", caps.get(lf_phase, "正在蓝牙同步与管理徕芬牙刷…"), None)

        watch_raw = self._read_cached_plugin_json(plugins_dir / "laifen" / "watch-state.json")
        watch_phase = _is_live_entry(watch_raw, ("syncing", "brushing", "connecting"))
        if watch_phase:
            cap = "检测到正在刷牙 · 实时记录中…" if watch_phase == "brushing" else "徕芬牙刷自动唤醒同步中…"
            return ("managing_laifen", cap, None)

        hs_done_phase = str((hs_raw or {}).get("phase") or "").strip().lower() if hs_raw else ""
        return (None, "", hs_done_phase)

    def _resolve_active_state(self, now: float, snap: FridaySnapshot) -> str:
        if self._voice_state and now >= self._voice_until:
            self._voice_state = None
            self._voice_caption = ""
            self._voice_followup = False
        if self._scene_state and now >= self._scene_until:
            self._scene_state = None
            self._scene_channel = ""
            self._scene_caption = ""
            self._scene_priority = 0
            self._scene_is_preview = False
        if self._transient_state and now >= self._transient_until:
            self._transient_state = None

        if self._voice_state == "listening" and not self._voice_followup:
            return "listening"
        if self._scene_state and self._scene_priority >= 2:
            return self._scene_state
        if self._live_file_scene:
            return self._live_file_scene
        if self._voice_state:
            return self._voice_state
        if self._scene_state:
            return self._scene_state
        if snap.active_scene:
            return snap.active_scene
        if self._transient_state:
            return self._transient_state
        return snap.bot_state

    def _sound_worker(self) -> None:
        while not self._stop:
            try:
                kind, args = self._sound_queue.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                if kind == "ready":
                    with self._lock:
                        in_standby, _ = self._refresh_standby_state_locked(time.monotonic())
                    self._sync_hardware_standby(in_standby, force=True)
                    self.speaker.on_sidecar_ready()
                    if not in_standby:
                        self.speaker.play_chime("boot", force=False, sleeping=False)
                elif kind == "chime":
                    self.speaker.play_chime(
                        str(args.get("name")),
                        force=bool(args.get("force", False)),
                        sleeping=bool(args.get("sleeping", False)),
                    )
            except Exception as exc:
                print(f"[cs80-sound] error: {exc}", file=sys.stderr, flush=True)

    def _friday_poll_loop(self) -> None:
        while not self._stop:
            try:
                snap = self.friday.poll()
                now = time.monotonic()
                need_wake = False
                live_scene, live_cap, hs_done_phase = self._poll_plugin_live_scenes()
                with self._lock:
                    prev = self._last_snapshot
                    self._last_snapshot = snap
                    prev_live_scene = self._live_file_scene
                    prev_live_cap = self._live_file_caption
                    if prev_live_scene and live_scene != prev_live_scene:
                        if self._scene_state == prev_live_scene and not self._scene_is_preview:
                            tail = 1.2 if (prev_live_scene == "weighing_scale" and hs_done_phase == "completed") else 0.0
                            self._clear_scene(prev_live_scene, now=now, tail_sec=tail)
                        need_wake = True
                    self._live_file_scene = live_scene
                    self._live_file_caption = live_cap
                    if live_scene != prev_live_scene or live_cap != prev_live_cap:
                        need_wake = True
                    if snap.transient_state:
                        self._transient_state = snap.transient_state
                        self._transient_until = now + 2.5
                        if snap.transient_poke:
                            self.animator.trigger_poke(snap.transient_poke, 1)
                        need_wake = True
                    if snap.transient_scene:
                        self._apply_scene(
                            snap.transient_scene,
                            now=now,
                            hold_sec=3.6,
                            channel=snap.transient_scene_channel,
                            force=False,
                        )
                        need_wake = True

                    active_state = self._resolve_active_state(now, snap)
                    if snap.bot_state == "listening":
                        self._mark_user_activity_locked(now, wake=True)
                        need_wake = True
                    sub_phase = "awake" if active_state in ("listening", "thinking", *SCENE_STATES) else snap.sub_phase
                    if self.animator.set_state(
                        active_state,
                        sub_phase=sub_phase,
                        worker_count=snap.worker_count,
                    ):
                        need_wake = True
                    if snap.auto_expr and active_state in ("idle", "streaming", "finished") and self.animator.override_until <= 0.0:
                        self.animator.set_expression(snap.auto_expr, hold_sec=0.0, now_wall=now)
                    elif self.animator.override_until <= 0.0:
                        self.animator.set_expression("auto", hold_sec=0.0, now_wall=now)

                    if prev.hud != snap.hud:
                        need_wake = True

                for chime in snap.chimes:
                    self._sound_queue.put(
                        ("chime", {"name": chime, "force": False, "sleeping": snap.bot_state == "sleeping"})
                    )

                if need_wake:
                    self._wake_event.set()
                    self._widget_refresh_event.set()
            except Exception as exc:
                print(f"[friday-poll] error: {exc}", file=sys.stderr, flush=True)
            time.sleep(0.40)

    def _effective_hud(self, now: float, layout: Dict[str, Any], data_rev: int) -> HudState:
        snap_hud = self._last_snapshot.hud
        clock_hm = time.strftime("%H:%M")
        meta = snap_hud.headline_meta
        source = snap_hud.headline_source
        text = snap_hud.headline_text
        headline_incoming = snap_hud.headline_incoming
        if self._inbound_text:
            if (
                now >= self._inbound_until
                or snap_hud.headline_incoming
                or self._last_snapshot.reply_sig != self._inbound_baseline_sig
            ):
                self._inbound_text = None
                self._inbound_source = None
            else:
                source = self._inbound_source or "来信"
                meta = f"F.R.I.D.A.Y. · {source}"
                text = self._inbound_text
                headline_incoming = True

        if self._banner_text and now < self._banner_until:
            meta = self._banner_meta or "F.R.I.D.A.Y. · 互动"
            source = "互动提醒"
            text = self._banner_text
            headline_incoming = False
        elif self._banner_text and now >= self._banner_until:
            self._banner_text = None
            self._banner_meta = None

        voice_cap = snap_hud.voice_caption
        if self._voice_state == "listening" and now < self._voice_until and self._voice_caption:
            voice_cap = self._voice_caption

        scene_channel = self._scene_channel if (self._scene_state and now < self._scene_until) else ""
        if self._live_file_scene and not self._scene_is_preview and (not self._scene_state or self._scene_state == self._live_file_scene):
            scene_caption = self._live_file_caption
        elif self._scene_state and now < self._scene_until:
            scene_caption = self._scene_caption
        else:
            scene_caption = ""

        pages = layout.get("pages") or []
        page_cnt = max(1, len(pages))
        active_pg = max(0, min(page_cnt - 1, int(layout.get("activePage") or 0)))
        page_name = str(pages[active_pg].get("name") or "") if pages else ""

        spk_cfg = self.speaker.get_config_snapshot()
        return HudState(
            headline_meta=meta,
            headline_source=source,
            headline_text=text,
            ask_boss_question=snap_hud.ask_boss_question,
            workers=snap_hud.workers,
            channels=snap_hud.channels,
            memory_count=snap_hud.memory_count,
            today_calls=snap_hud.today_calls,
            speaker_volume=spk_cfg["volume"],
            speaker_muted=spk_cfg["muted"],
            friday_connected=snap_hud.friday_connected,
            clock_hm=clock_hm,
            voice_caption=voice_cap,
            grid_rows=int(layout.get("gridRows") or 2),
            active_page=active_pg,
            page_count=page_cnt,
            page_name=page_name,
            auto_task_overlay=bool(layout.get("autoTaskOverlay", True)),
            marquee_mode=str(layout.get("marqueeMode") or "auto_pause"),
            marquee_speed=int(layout.get("marqueeSpeed") or 2),
            layout_rev=self.layout_store.revision,
            data_rev=data_rev,
            headline_incoming=headline_incoming,
            scene_channel=scene_channel,
            scene_caption=scene_caption,
        )

    def _render_loop(self) -> None:
        last_step = time.monotonic()
        while not self._stop:
            now = time.monotonic()
            dt = now - last_step
            last_step = now

            pending_full: Optional[bytes] = None
            pending_patch: Optional[bytes] = None
            frame_session = 0
            need_hw_sync = False
            target_hw_standby = False
            delay = 0.5
            try:
                with self._lock:
                    was_standby = self._standby
                    standby_now, _ = self._refresh_standby_state_locked(now)
                    if was_standby and not standby_now:
                        self._full_needed = True
                        self.renderer.invalidate_prev()
                        self._widget_refresh_event.set()
                    sidecar_up = self.sidecar.is_up()
                    session = self.sidecar.session
                    frame_session = session
                    if session != self._last_session_seen:
                        self._last_session_seen = session
                        self._full_needed = True
                    need_hw_sync = sidecar_up and (
                        self._hw_standby_session != session or self._hw_standby_applied != standby_now
                    )
                    target_hw_standby = standby_now
                    if standby_now:
                        sec_in_min = time.localtime().tm_sec
                        delay = min(15.0, max(0.5, 60.2 - sec_in_min))
                    else:
                        active_state = self._resolve_active_state(now, self._last_snapshot)
                        sub_phase = "awake" if active_state in ("listening", "thinking", *SCENE_STATES) else self._last_snapshot.sub_phase
                        self.animator.set_state(
                            active_state,
                            sub_phase=sub_phase,
                            worker_count=self._last_snapshot.worker_count,
                        )

                        layout = self.layout_store.get()
                        pages = layout.get("pages") or []
                        rotate_sec = int(layout.get("pageRotateSec") or 0)
                        preempted = bool(layout.get("autoTaskOverlay", True)) and (
                            bool(self._last_snapshot.hud.ask_boss_question) or bool(self._last_snapshot.hud.workers)
                        )
                        if len(pages) > 1 and rotate_sec > 0 and not preempted and active_state != "listening":
                            if now - self._last_page_rotate_at >= rotate_sec:
                                self.layout_store.step_rotation(1)
                                self._last_page_rotate_at = now
                                layout = self.layout_store.get()
                        else:
                            if active_state == "listening" or preempted:
                                self._last_page_rotate_at = now

                        data_rev, widget_data = self.widget_hub.snapshot_all()
                        hud = self._effective_hud(now, layout, data_rev)
                        geo = stage_geometry_for_rows(hud.grid_rows)

                        # Step animator and marquee together
                        self.renderer.sync_marquee_metrics(hud)
                        marquee_moved = self.renderer.marquee.step(dt)
                        face_snap = self.animator.step(
                            dt,
                            now_wall=now,
                            center_x=geo["face_cx"],
                            center_y=geo["face_cy"],
                            base_radius=geo["face_r"],
                        )

                        hud_changed = (hud != self._last_hud_key) or (hud.clock_hm != self._last_clock_hm)
                        should_draw = (
                            (not face_snap.settled)
                            or marquee_moved
                            or hud_changed
                            or self._full_needed
                            or self._render_seq == 0
                        )

                        if should_draw:
                            active_cards = pages[hud.active_page].get("cards") or [] if pages else []
                            placed_cards, _ = pack_bento_page(
                                active_cards,
                                grid_rows=hud.grid_rows,
                                x0=36.0,
                                y0=geo["grid_y"],
                                total_w=728.0,
                                total_h=geo["grid_h"],
                                gap=geo["gap"],
                            )
                            full_bytes, patch_info = self.renderer.render_frame(
                                face_snap,
                                hud,
                                placed_cards=placed_cards,
                                widget_data=widget_data,
                            )
                            self._render_seq += 1
                            self._last_hud_key = hud
                            self._last_clock_hm = hud.clock_hm
                            push_full = self._full_needed or patch_info is None
                            if sidecar_up:
                                if push_full:
                                    pending_full = full_bytes
                                elif patch_info is not None and patch_info[0] > 0:
                                    pending_patch = patch_info[1]
                                elif patch_info is not None and patch_info[0] == 0:
                                    self._full_needed = False

                        delay = self.animator.next_wakeup_delay(now_wall=now)
                        m_delay = self.renderer.marquee.next_wakeup_delay()
                        if m_delay is not None:
                            delay = min(delay, m_delay)
                        if len(pages) > 1 and rotate_sec > 0 and not preempted and active_state != "listening":
                            delay = min(delay, max(0.2, (self._last_page_rotate_at + rotate_sec) - now))
                        for active, deadline in (
                            (bool(self._banner_text), self._banner_until),
                            (bool(self._inbound_text), self._inbound_until),
                            (bool(self._voice_state), self._voice_until),
                            (bool(self._scene_state), self._scene_until),
                            (bool(self._transient_state), self._transient_until),
                        ):
                            if active and deadline > 0.0:
                                delay = min(delay, max(0.05, deadline - now))
                        if self._temp_wake_until > now:
                            delay = min(delay, max(0.05, self._temp_wake_until - now))
                        cfg = self.screen_store.get()
                        if cfg["idleStandbyEnabled"]:
                            idle_deadline = self._last_activity_mono + int(cfg["idleStandbyMin"]) * 60.0
                            if idle_deadline > now:
                                delay = min(delay, max(0.2, idle_deadline - now))
                        sec_in_min = time.localtime().tm_sec
                        delay = min(delay, max(0.2, 60.2 - sec_in_min))

                # Write to sidecar outside self._lock so HTTP/poll threads never block on USB writes
                if target_hw_standby:
                    if need_hw_sync:
                        self._sync_hardware_standby(True)
                else:
                    if need_hw_sync:
                        self._sync_hardware_standby(False)
                    if pending_full is not None:
                        if self.sidecar.send_full_bgr565(pending_full):
                            with self._lock:
                                if self.sidecar.session == frame_session:
                                    self._full_needed = False
                                else:
                                    self._full_needed = True
                                    self.renderer.invalidate_prev()
                        else:
                            with self._lock:
                                self._full_needed = True
                                self.renderer.invalidate_prev()
                    elif pending_patch is not None:
                        if not self.sidecar.send_patch(pending_patch):
                            with self._lock:
                                self._full_needed = True
                                self.renderer.invalidate_prev()
            except Exception as exc:
                print(f"[cs80-render] error: {exc}", file=sys.stderr, flush=True)
                delay = 0.4

            self._wake_event.wait(timeout=delay)
            self._wake_event.clear()

    def handle_control(self, body: Dict[str, Any]) -> Dict[str, Any]:
        action = str(body.get("action") or "").strip().lower()
        if not action:
            for candidate in ("voice", "scene", "inbound", "layout", "express", "sound", "screen"):
                if candidate in body:
                    action = candidate
                    body = dict(body[candidate]) if isinstance(body[candidate], dict) else {}
                    break

        now = time.monotonic()
        if action == "voice":
            phase = str(body.get("phase") or "idle").strip().lower()
            kw = str(body.get("keyword") or "").strip()
            spk = str(body.get("speakerName") or "").strip()
            fu = bool(body.get("followUp"))
            with self._lock:
                if phase == "listening":
                    self._voice_state = "listening"
                    self._voice_followup = fu
                    if not fu:
                        self._clear_scene(now=now)
                    if fu:
                        self._voice_caption = f"连续对话倾听 · {spk}" if spk else "连续对话倾听中 · 请继续说话"
                    elif kw and spk:
                        self._voice_caption = f'已唤醒 "{kw}" · 声纹 {spk}'
                    elif kw:
                        self._voice_caption = f'已唤醒 "{kw}" · 请说话'
                    else:
                        self._voice_caption = "正在倾听语音指令…"
                    self._voice_until = now + 15.0
                    self._last_page_rotate_at = now
                    active_state = self._resolve_active_state(now, self._last_snapshot)
                    self.animator.set_state(
                        active_state,
                        sub_phase="awake",
                        worker_count=self._last_snapshot.worker_count,
                    )
                elif phase == "transcribing":
                    self._voice_state = "thinking"
                    self._voice_followup = False
                    self._voice_caption = ""
                    self._voice_until = now + 8.0
                    active_state = self._resolve_active_state(now, self._last_snapshot)
                    self.animator.set_state(
                        active_state,
                        sub_phase="awake",
                        worker_count=self._last_snapshot.worker_count,
                    )
                else:
                    self._voice_state = None
                    self._voice_followup = False
                    self._voice_caption = ""
                    active_state = self._resolve_active_state(now, self._last_snapshot)
                    self.animator.set_state(
                        active_state,
                        sub_phase="awake" if active_state in ("listening", "thinking", *SCENE_STATES) else self._last_snapshot.sub_phase,
                        worker_count=self._last_snapshot.worker_count,
                    )
                self._mark_user_activity_locked(now, wake=True)
            self._wake_event.set()
            return {"ok": True, "action": "voice", "phase": phase}

        if action == "scene":
            phase = str(body.get("phase") or "start").strip().lower()
            scene = str(body.get("scene") or "").strip().lower()
            channel = str(body.get("channel") or "").strip().lower()
            caption = str(body.get("caption") or "").strip()
            try:
                hold_sec = _parse_finite_float(body.get("holdSec"), 18.0 if phase == "start" else 3.8, "holdSec")
                tail_sec = _parse_finite_float(body.get("tailSec"), 0.0, "tailSec")
            except ValueError as exc:
                return {"ok": False, "err": str(exc)}
            force = bool(body.get("force"))
            with self._lock:
                if phase == "end":
                    self._clear_scene(scene or None, now=now, tail_sec=tail_sec)
                else:
                    self._apply_scene(
                        scene,
                        now=now,
                        hold_sec=hold_sec,
                        channel=channel,
                        caption=caption,
                        force=force,
                    )
                active_state = self._resolve_active_state(now, self._last_snapshot)
                self.animator.set_state(
                    active_state,
                    sub_phase="awake" if active_state in ("listening", "thinking", *SCENE_STATES) else self._last_snapshot.sub_phase,
                    worker_count=self._last_snapshot.worker_count,
                )
                if phase != "end" and (scene == "speaking" or channel == "xiaoai"):
                    self._mark_user_activity_locked(now, wake=True)
            self._wake_event.set()
            return {"ok": True, "action": "scene", "scene": scene, "phase": phase, "botState": active_state}

        if action == "inbound":
            raw_ch = str(body.get("channel") or "local").strip().upper()
            ch_map = {
                "WECHAT": "微信来信",
                "TELEGRAM": "电报来信",
                "XIAOAI": "小爱语音",
                "DINGTALK": "钉钉来信",
                "LOCAL": "控制台提问",
                "WEB": "控制台提问",
            }
            src_label = str(body.get("source") or "").strip() or f"{ch_map.get(raw_ch, '来信')} · {time.strftime('%H:%M')}"
            txt = str(body.get("text") or "").strip()
            try:
                hold_sec = _parse_finite_float(body.get("holdSec"), 30.0, "holdSec")
            except ValueError as exc:
                return {"ok": False, "err": str(exc)}
            with self._lock:
                if txt:
                    self._inbound_source = src_label
                    self._inbound_text = txt
                    self._inbound_until = now + max(1.0, hold_sec)
                    self._inbound_baseline_sig = self._last_snapshot.reply_sig
                    if raw_ch == "XIAOAI":
                        self._mark_user_activity_locked(now, wake=True)
            self._wake_event.set()
            return {"ok": True, "action": "inbound", "source": src_label}

        if action == "layout":
            updated, grid_changed, added_kinds = self.layout_store.apply_patch(body)
            with self._lock:
                self._last_page_rotate_at = now
                self._mark_user_activity_locked(now, wake=True)
                if grid_changed:
                    self._full_needed = True
                    self.renderer.invalidate_prev()
                if body.get("includePreview"):
                    layout_now = updated
                    data_rev, widget_data = self.widget_hub.snapshot_all()
                    hud = self._effective_hud(now, layout_now, data_rev)
                    geo = stage_geometry_for_rows(hud.grid_rows)
                    pages = layout_now.get("pages") or []
                    active_cards = pages[hud.active_page].get("cards") or [] if pages else []
                    placed_cards, _ = pack_bento_page(
                        active_cards,
                        grid_rows=hud.grid_rows,
                        x0=36.0,
                        y0=geo["grid_y"],
                        total_w=728.0,
                        total_h=geo["grid_h"],
                        gap=geo["gap"],
                    )
                    face_snap = self.animator.step(
                        0.016,
                        now_wall=now,
                        center_x=geo["face_cx"],
                        center_y=geo["face_cy"],
                        base_radius=geo["face_r"],
                    )
                    self.renderer.render_frame(
                        face_snap,
                        hud,
                        placed_cards=placed_cards,
                        widget_data=widget_data,
                        update_prev=False,
                    )
                    self._render_seq += 1
                    self._last_hud_key = None
            if added_kinds or body.get("refreshWidgets"):
                self.widget_hub.trigger_refresh(added_kinds if not body.get("refreshWidgets") else None)
                self._widget_refresh_event.set()
            self._wake_event.set()
            out_res: Dict[str, Any] = {
                "ok": True,
                "action": "layout",
                "layout": updated,
                "gridChanged": grid_changed,
            }
            if body.get("includePreview"):
                png_b64 = base64.b64encode(self.get_preview_png()).decode("ascii")
                out_res["previewDataUrl"] = f"data:image/png;base64,{png_b64}"
            return out_res

        if action == "express":
            expr = body.get("expr")
            scene_arg = str(body.get("scene") or "").strip().lower()
            channel = str(body.get("channel") or "").strip().lower()
            caption = str(body.get("caption") or "").strip()
            poke = body.get("poke")
            try:
                turns = _parse_int(body.get("turns"), 2, "turns")
                hold_sec = _parse_finite_float(body.get("holdSec"), 12.0, "holdSec")
            except ValueError as exc:
                return {"ok": False, "err": str(exc)}
            text = body.get("text")
            title = body.get("title")
            expr_norm = str(expr or "").strip().lower()
            if not scene_arg and expr_norm in (*SCENE_STATES, "sending_wechat", "sending_telegram"):
                scene_arg = expr_norm
                expr = None
            with self._lock:
                if expr_norm == "auto":
                    self._clear_scene(now=now)
                    self.animator.set_expression("auto", hold_sec=0.0, now_wall=now)
                elif expr:
                    self.animator.set_expression(str(expr), hold_sec=hold_sec, now_wall=now)
                if scene_arg:
                    self._apply_scene(
                        scene_arg,
                        now=now,
                        hold_sec=hold_sec,
                        channel=channel,
                        caption=caption,
                        force=True,
                        is_preview=True,
                    )
                    self.animator.set_expression("auto", hold_sec=0.0, now_wall=now)
                active_state = self._resolve_active_state(now, self._last_snapshot)
                self.animator.set_state(
                    active_state,
                    sub_phase="awake" if active_state in ("listening", "thinking", *SCENE_STATES) else self._last_snapshot.sub_phase,
                    worker_count=self._last_snapshot.worker_count,
                )
                if poke:
                    self.animator.trigger_poke(str(poke), turns=turns)
                if text:
                    self._banner_text = str(text)
                    self._banner_meta = str(title or "F.R.I.D.A.Y. · 表情互动")
                    self._banner_until = now + hold_sec
                self._mark_user_activity_locked(now, wake=True)
            self._wake_event.set()
            return {"ok": True, "action": "express", "expr": expr, "scene": scene_arg or None, "poke": poke}

        if action == "sound":
            out: Dict[str, Any] = {"ok": True, "action": "sound"}
            try:
                hold_sec = _parse_finite_float(body.get("holdSec"), 15.0, "holdSec") if body.get("text") else 15.0
                vol_val = _parse_int(body.get("volume"), None, "volume") if body.get("volume") is not None else None
            except ValueError as exc:
                return {"ok": False, "err": str(exc)}
            if body.get("text"):
                with self._lock:
                    self._banner_text = str(body["text"])
                    self._banner_meta = str(body.get("title") or "F.R.I.D.A.Y. · 提醒")
                    self._banner_until = now + hold_sec
                    self.animator.trigger_poke("bounce", 1)
                self._wake_event.set()

            if vol_val is not None:
                out["volume"] = self.speaker.set_volume(vol_val)
                self._wake_event.set()
            if body.get("muted") is not None:
                out["muted"] = self.speaker.set_muted(bool(body["muted"]))
                self._wake_event.set()
            if body.get("quietHours") is not None:
                out["quietHours"] = self.speaker.set_quiet_hours(str(body["quietHours"]))
            if body.get("stop"):
                out["stop"] = self.speaker.stop()
            if body.get("file"):
                res = self.speaker.play_file(str(body["file"]))
                out["play"] = res
                out["ok"] = bool(res.get("ok"))
            elif body.get("chime"):
                force = True if body.get("force") is None else bool(body["force"])
                with self._lock:
                    is_sleeping = self._last_snapshot.bot_state == "sleeping"
                res = self.speaker.play_chime(
                    str(body["chime"]),
                    force=force,
                    sleeping=is_sleeping,
                )
                out["play"] = res
                out["ok"] = bool(res.get("ok"))
            return out

        if action == "screen":
            out = {"ok": True, "action": "screen"}
            policy_patch: Dict[str, Any] = {}
            bri_val: Optional[int] = None
            if body.get("brightness") is not None:
                try:
                    raw_bri = _parse_int(body.get("brightness"), None, "brightness")
                except ValueError as exc:
                    return {"ok": False, "err": str(exc)}
                bri_val = max(5, min(100, (raw_bri // 5) * 5))
                policy_patch["brightness"] = bri_val

            for key in ("nightStandbyEnabled", "nightStandbyHours", "idleStandbyEnabled", "idleStandbyMin", "tempWakeSec"):
                if key in body and body[key] is not None:
                    policy_patch[key] = body[key]

            if policy_patch:
                try:
                    updated_policy = self.screen_store.update(policy_patch)
                except ValueError as exc:
                    return {"ok": False, "err": str(exc)}
            else:
                updated_policy = self.screen_store.get()

            standby_arg = body.get("standby")
            if standby_arg is not None and not isinstance(standby_arg, bool):
                return {"ok": False, "err": "invalid-standby"}

            if standby_arg is True:
                in_night_now = bool(updated_policy["nightStandbyEnabled"]) and is_in_time_range(
                    str(updated_policy["nightStandbyHours"])
                )
                updated_policy = self.screen_store.update({"manualStandby": not in_night_now})
            elif standby_arg is False:
                updated_policy = self.screen_store.update({"manualStandby": False})

            with self._lock:
                if bri_val is not None:
                    self._brightness = bri_val
                if standby_arg is True:
                    self._temp_wake_until = 0.0
                elif standby_arg is False:
                    self._mark_user_activity_locked(now, wake=True)
                elif bri_val is not None or body.get("refresh"):
                    self._mark_user_activity_locked(now, wake=True)
                elif policy_patch.get("idleStandbyEnabled") is True:
                    # Reset idle clock when enabling idle standby so it does not snap off mid-click
                    self._last_activity_mono = now

                was_standby = self._standby
                standby_now, reason_now = self._refresh_standby_state_locked(now)
                if not standby_now and (was_standby or body.get("refresh") or standby_arg is False):
                    self._full_needed = True
                    self.renderer.invalidate_prev()

            hw_res = self._sync_hardware_standby(standby_now, force=(standby_arg is not None))
            if standby_arg is not None:
                out["standby"] = hw_res
            if bri_val is not None:
                if not standby_now and self.sidecar.is_up():
                    out["brightness"] = self.sidecar.send_ctl(CTL_BRIGHTNESS, bri_val)
                    self.sidecar.send_ctl(CTL_STATE, 0)
                else:
                    out["brightness"] = {"ok": True, "deferred": True, "value": bri_val}
            if body.get("refresh"):
                self.widget_hub.trigger_refresh()
                self._widget_refresh_event.set()
                out["refresh"] = True
            elif not standby_now and was_standby:
                self.widget_hub.trigger_refresh()
                self._widget_refresh_event.set()

            self._wake_event.set()
            out["standbyActive"] = standby_now
            out["standbyReason"] = reason_now
            out["screenPolicy"] = updated_policy
            return out

        return {"ok": False, "err": f"unknown-action:{action}"}

    def get_status(self) -> Dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            snap = self._last_snapshot
            state_id = self.animator.state_id
            sub_phase = self.animator.sub_phase
            expr = self.animator.expr_override
            standby, reason = self._refresh_standby_state_locked(now)
            brightness = self._brightness
            temp_wake_until = self._temp_wake_until
        screen_policy = self.screen_store.get()
        under_standby_policy = bool(screen_policy["manualStandby"]) or (
            bool(screen_policy["nightStandbyEnabled"])
            and is_in_time_range(str(screen_policy["nightStandbyHours"]))
        )
        temp_wake_rem = (
            max(0, int(math.ceil(temp_wake_until - now)))
            if (not standby and temp_wake_until > now and under_standby_policy)
            else 0
        )
        sidecar_status = self.sidecar.snapshot_status()
        layout = self.layout_store.get()
        if not standby:
            standby_mode = "none"
        elif self.sidecar.features & 0x40:
            standby_mode = "hw_sleep"
        elif self.sidecar.device_brightness == 0:
            standby_mode = "backlight_off"
        else:
            standby_mode = "black_dim"
        return {
            "ok": True,
            **sidecar_status,
            "fridayConnected": snap.connected,
            "fridayHome": str(self.friday.home),
            "botState": state_id,
            "subPhase": sub_phase,
            "expression": expr,
            "workerCount": snap.worker_count,
            "standby": standby,
            "standbyReason": reason,
            "standbyMode": standby_mode,
            "tempWakeRemainingSec": temp_wake_rem,
            "screenPolicy": screen_policy,
            "brightness": brightness,
            "speaker": self.speaker.get_config_snapshot(),
            "gridRows": layout.get("gridRows", 2),
            "activePage": layout.get("activePage", 0),
            "pageCount": len(layout.get("pages") or []),
            "marqueeMode": layout.get("marqueeMode", "auto_pause"),
            "cairo": self.renderer.uses_cairo,
            "fast565": self.renderer.fast.loaded,
        }

    def get_dashboard(self, *, include_preview: bool = True) -> Dict[str, Any]:
        status = self.get_status()
        layout = self.layout_store.get()
        last_view = self.friday.last_view or {}
        catalog = discover_widget_catalog(
            self.friday.home,
            view_plugins=list(last_view.get("plugins") or []),
        )
        widgets_summary = self.widget_hub.get_summary_snapshot()
        res: Dict[str, Any] = {
            "ok": True,
            "status": status,
            "layout": layout,
            "catalog": catalog,
            "widgets": widgets_summary,
        }
        if include_preview:
            png = self.get_preview_png()
            res["previewDataUrl"] = f"data:image/png;base64,{base64.b64encode(png).decode('ascii')}"
        return res

    def get_preview_png(self) -> bytes:
        with self._lock:
            if self._render_seq == 0:
                now = time.monotonic()
                layout = self.layout_store.get()
                data_rev, widget_data = self.widget_hub.snapshot_all()
                hud = self._effective_hud(now, layout, data_rev)
                geo = stage_geometry_for_rows(hud.grid_rows)
                pages = layout.get("pages") or []
                active_cards = pages[hud.active_page].get("cards") or [] if pages else []
                placed_cards, _ = pack_bento_page(
                    active_cards,
                    grid_rows=hud.grid_rows,
                    x0=36.0,
                    y0=geo["grid_y"],
                    total_w=728.0,
                    total_h=geo["grid_h"],
                    gap=geo["gap"],
                )
                face_snap = self.animator.step(
                    0.016,
                    now_wall=now,
                    center_x=geo["face_cx"],
                    center_y=geo["face_cy"],
                    base_radius=geo["face_r"],
                )
                self.renderer.render_frame(
                    face_snap,
                    hud,
                    placed_cards=placed_cards,
                    widget_data=widget_data,
                    update_prev=False,
                )
                self._render_seq = 1
            if self._cached_png[0] != self._render_seq:
                png = self.renderer.current_png_bytes()
                self._cached_png = (self._render_seq, png)
            return self._cached_png[1]


def make_http_server(daemon: FaceDaemon, host: str, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            return

        def _send_json(self, code: int, payload: Dict[str, Any]) -> None:
            raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802
            path, _, query_str = self.path.partition("?")
            if path == "/api/status":
                self._send_json(HTTPStatus.OK, daemon.get_status())
            elif path == "/api/dashboard":
                qs = parse_qs(query_str)
                want_preview = (qs.get("preview") or ["1"])[0] not in ("0", "false", "no")
                self._send_json(HTTPStatus.OK, daemon.get_dashboard(include_preview=want_preview))
            elif path == "/preview.png":
                png = daemon.get_preview_png()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(png)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(png)
            elif path == "/":
                html = (
                    "<!doctype html><html><head><meta charset='utf-8'>"
                    "<title>F.R.I.D.A.Y. CS80 Face</title>"
                    "<style>body{background:#000;color:#fff;font-family:sans-serif;display:flex;"
                    "gap:24px;padding:24px;align-items:flex-start}img{height:90vh;border:1px solid #E88B0A;border-radius:12px}"
                    "pre{background:#090909;border:1px solid #333;padding:16px;border-radius:8px;max-width:520px;overflow:auto}</style>"
                    "</head><body><img id='p' src='/preview.png'><pre id='s'></pre>"
                    "<script>async function r(){document.getElementById('p').src='/preview.png?t='+Date.now();"
                    "const j=await (await fetch('/api/status')).json();"
                    "document.getElementById('s').textContent=JSON.stringify(j,null,2);}r();setInterval(r,1000);</script>"
                    "</body></html>"
                ).encode("utf-8")
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(html)))
                self.end_headers()
                self.wfile.write(html)
            else:
                self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "err": "not-found"})

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path != "/api/control":
                self._send_json(HTTPStatus.NOT_FOUND, {"ok": False, "err": "not-found"})
                return
            raw_len = self.headers.get("Content-Length") or "0"
            try:
                length = int(raw_len)
            except (TypeError, ValueError):
                self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "err": "invalid-content-length"})
                return
            if length < 0:
                self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "err": "invalid-content-length"})
                return
            if length > 262144:
                self._send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"ok": False, "err": "too-large"})
                return
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
                if not isinstance(body, dict):
                    raise ValueError("Expected JSON object")
            except Exception as exc:
                self._send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "err": str(exc)})
                return
            res = daemon.handle_control(body)
            self._send_json(HTTPStatus.OK if res.get("ok") else HTTPStatus.BAD_REQUEST, res)

    ThreadingHTTPServer.allow_reuse_address = True
    return ThreadingHTTPServer((host, port), Handler)


def _read_exact_fd(fd: int, n: int) -> Optional[bytes]:
    chunks: List[bytes] = []
    rem = n
    while rem > 0:
        b = os.read(fd, rem)
        if not b:
            return None
        chunks.append(b)
        rem -= len(b)
    return b"".join(chunks)


def run_internal_mock_sidecar(mock_log: Optional[Path]) -> int:
    """Implements qdc1 stdin/stdout protocol in memory for automated testing."""
    fd = sys.stdin.fileno()
    patch_n = 0
    audio_n = 0
    brightness = 100
    standby = 0
    uploaded_hash = 0

    def emit(obj: Dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
        sys.stdout.flush()

    def record(obj: Dict[str, Any]) -> None:
        emit({"event": "mock-cmd", **obj})
        if mock_log is not None:
            mock_log.parent.mkdir(parents=True, exist_ok=True)
            with mock_log.open("a", encoding="utf-8") as fp:
                fp.write(json.dumps(obj, separators=(",", ":")) + "\n")

    emit({"event": "ready", "block": 520192, "status": 0})
    emit({"event": "features", "bits": 0x23F})

    while True:
        hdr = _read_exact_fd(fd, 1)
        if hdr is None:
            break
        t = hdr[0]
        if t == 0x04:
            buf = _read_exact_fd(fd, FRAME_BYTES)
            if buf is None:
                break
            record({"type": "0x04", "bytes": len(buf), "black": buf == _BLACK_FRAME_BYTES})
            emit({"event": "saver", "ok": 1, "wire": len(buf), "ms": 12})
        elif t == 0x02:
            cnt_raw = _read_exact_fd(fd, 4)
            if cnt_raw is None:
                break
            cnt = struct.unpack("<I", cnt_raw)[0]
            payload = _read_exact_fd(fd, cnt * (4 + 32 * 16 * 2))
            if payload is None:
                break
            patch_n += 1
            record({"type": "0x02", "tiles": cnt})
            emit({"event": "patch", "n": patch_n, "ok": 1, "code": 0, "status": 0, "tiles": cnt, "wire": 64, "ms": 2})
        elif t == 0x03:
            ctl = _read_exact_fd(fd, 2)
            if ctl is None:
                break
            cmd, arg = ctl[0], ctl[1]
            record({"type": "0x03", "cmd": cmd, "arg": arg})
            if cmd == CTL_BRIGHTNESS:
                brightness = arg
                emit({"event": "brightness", "ok": 1, "value": arg})
            elif cmd in (CTL_SLEEP, CTL_WAKE):
                standby = 1 if cmd == CTL_SLEEP else 0
                emit({"event": "power", "ok": 1, "awake": 0 if standby else 1})
            elif cmd == CTL_STATE:
                emit({"event": "state", "brightness": brightness, "backlight": 0 if brightness == 100 else 1, "edges": 0, "detail": 0})
            else:
                emit({"event": "hello", "block": 520192})
        elif t == 0x05:
            h = _read_exact_fd(fd, 16)
            if h is None:
                break
            sub = h[0]
            plen, off, raw_v = struct.unpack_from("<III", h, 4)
            payload = _read_exact_fd(fd, plen) if plen else b""
            if payload is None:
                break
            audio_n += 1
            if sub == 3:
                uploaded_hash = raw_v
            detail = uploaded_hash if sub in (4, 6) else 0
            record({"type": "0x05", "sub": sub, "offset": off, "raw": raw_v, "len": plen})
            emit({"event": "audio", "n": audio_n, "sub": sub, "ok": 1, "status": 0, "rx": 65, "dec": 0, "draw": 0, "detail": detail, "ms": 2})
        elif t == 0x06:
            h = _read_exact_fd(fd, 8)
            if h is None:
                break
            off, plen = struct.unpack("<II", h)
            payload = _read_exact_fd(fd, plen)
            if payload is None:
                break
            audio_n += 1
            record({"type": "0x06", "offset": off, "len": plen})
            emit({"event": "audio-data", "n": audio_n, "ok": 1, "status": 0, "offset": off, "sent": plen, "detail": off + plen, "ms": 2})
        else:
            break
    emit({"event": "exit"})
    return 0


def render_single_png(
    out_path: Path,
    *,
    state: str = "idle",
    sub_phase: str = "awake",
    expr: str = "auto",
    workers: int = 0,
    headline_meta: str = "F.R.I.D.A.Y. · 微信 · 20:50",
    headline_text: str = "已接入拉卡拉 CS80 竖屏与内置喇叭，当前系统运转正常。",
    ask_boss: str = "",
) -> None:
    renderer = FaceRenderer()
    anim = BotAnimator()
    anim.set_state(state, sub_phase=sub_phase, worker_count=workers)
    anim.set_expression(expr)
    geo = stage_geometry_for_rows(2)
    for _ in range(12):
        snap = anim.step(
            0.08,
            center_x=geo["face_cx"],
            center_y=geo["face_cy"],
            base_radius=geo["face_r"],
        )
    wk_rows = tuple(
        WorkerSummary(
            task_id=f"w{i+1}",
            profile=("coding", "research", "review")[i % 3],
            prompt=(
                "分析 CS80 MIPI 面板消隐时序与 QDC1 ZLP 拆包优化",
                "检索本地 L2 语义记忆：196 节点音频与声纹门禁配置",
                "核验 TypeScript 类型检查与端到端测试覆盖",
            )[i % 3],
            elapsed_sec=14 + i * 9,
        )
        for i in range(workers)
    )
    sample_cards = [
        {"id": "c1", "kind": "fund-tracker", "size": "1x1"},
        {"id": "c2", "kind": "health-scale", "size": "1x1"},
        {"id": "c3", "kind": "miot", "size": "1x1"},
        {"id": "c4", "kind": "system-pulse", "size": "1x1"},
    ]
    placed_cards, _ = pack_bento_page(
        sample_cards,
        grid_rows=2,
        x0=36.0,
        y0=geo["grid_y"],
        total_w=728.0,
        total_h=geo["grid_h"],
        gap=geo["gap"],
    )
    sample_data = {
        "fund-tracker": {
            "ok": True,
            "dailyPct": 1.84,
            "dailyPnl": 1245.0,
            "totalPnl": 8420.0,
            "totalPnlPct": 12.6,
            "holdingCount": 5,
            "updatedHm": "15:00",
            "subline": "今日 +1,245 · 总 7.52万",
            "spark": [6900, 7100, 7050, 7380, 7650, 8100, 8420],
        },
        "health-scale": {
            "ok": True,
            "weightKg": 68.4,
            "diffKg": -0.3,
            "bodyFat": 17.8,
            "musclePct": 44.2,
            "bmi": 22.1,
            "score": 88,
            "measuredStr": "今日 07:45",
            "spark": [69.2, 69.0, 68.8, 68.7, 68.5, 68.4],
        },
        "miot": {
            "ok": True,
            "online": 11,
            "total": 12,
            "onCount": 3,
            "devices": [
                {"name": "客厅吸顶灯", "room": "客厅", "online": True, "on": True},
                {"name": "米家空气炸锅", "room": "厨房", "online": True, "on": True},
                {"name": "客厅空调", "room": "客厅", "online": True, "on": False},
                {"name": "台灯 Pro", "room": "卧室", "online": True, "on": True},
            ],
        },
        "system-pulse": {
            "ok": True,
            "cpuPct": 18.0,
            "memPct": 41.0,
            "memUsedGb": 3.1,
            "memTotalGb": 7.6,
            "diskPct": 52.0,
            "diskFreeGb": 108.0,
            "load1": 0.42,
            "nextTimer": "午间估值 12:00",
        },
        "ninebot": {
            "ok": True,
            "name": "九号 M95C",
            "battery": 80,
            "auxBattery": 93,
            "voltageV": 75.3,
            "tempC": 26.0,
            "charging": True,
            "chargingPowerW": 310,
            "remainChargeTime": "1h20m",
            "rangeKm": 99.6,
            "odometerKm": 1234.5,
            "powerOn": False,
            "locked": True,
            "address": "高新区科技路1号",
            "monthKm": 128.4,
            "maxSpeedKmh": 68.0,
            "alertCount": 0,
            "updatedHm": "01:45",
            "spark": [92, 86, 78, 72, 65, 74, 80],
        },
    }
    hud = HudState(
        headline_meta=headline_meta,
        headline_source="微信 · 20:50",
        headline_text=headline_text,
        ask_boss_question=ask_boss,
        workers=wk_rows,
        channels=(("微信", True), ("小爱", True), ("电报", True)),
        memory_count=128,
        today_calls=42,
        speaker_volume=65,
        speaker_muted=False,
        friday_connected=True,
        clock_hm=time.strftime("%H:%M"),
        voice_caption='已唤醒 "星期五" · 请说话' if state == "listening" else "",
    )
    renderer.render_frame(snap, hud, placed_cards=placed_cards, widget_data=sample_data)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(renderer.current_png_bytes())


def main() -> int:
    ap = argparse.ArgumentParser(description="F.R.I.D.A.Y. CS80 Companion Face & Speaker Daemon")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--home", default=None, help="Explicit Friday home directory")
    ap.add_argument("--brightness", type=int, default=None)
    ap.add_argument("--mock-sidecar", action="store_true")
    ap.add_argument("--mock-log", default=None)
    ap.add_argument("--internal-mock-sidecar", action="store_true")
    ap.add_argument("--render-once", default=None)
    ap.add_argument("--render-demo", default=None)
    ap.add_argument("--prewarm-chimes", action="store_true")
    ap.add_argument("--state", default="idle")
    ap.add_argument("--sub-phase", default="awake")
    ap.add_argument("--expr", default="auto")
    ap.add_argument("--workers", type=int, default=0)
    ap.add_argument("--text", default="已接入拉卡拉 CS80 竖屏与内置喇叭，当前系统运转正常。")
    ap.add_argument("--ask-boss", default="")
    args = ap.parse_args()

    if args.internal_mock_sidecar:
        return run_internal_mock_sidecar(Path(args.mock_log) if args.mock_log else None)

    if args.prewarm_chimes:
        home = resolve_friday_home(args.home)
        sc = SpeakerController(home / "plugins" / "cs80-face", SidecarBridge(mock=True))
        sizes = sc.prewarm_chimes()
        print(json.dumps({"ok": True, "soundsDir": str(sc.sounds_dir), "chimes": sizes}))
        return 0

    if args.render_once:
        out = Path(args.render_once)
        render_single_png(
            out,
            state=args.state,
            sub_phase=args.sub_phase,
            expr=args.expr,
            workers=args.workers,
            headline_text=args.text,
            ask_boss=args.ask_boss,
        )
        print(json.dumps({"ok": True, "path": str(out)}))
        return 0

    if args.render_demo:
        demo_dir = Path(args.render_demo)
        render_single_png(demo_dir / "idle.png", state="idle")
        render_single_png(
            demo_dir / "working.png",
            state="working",
            workers=2,
            headline_meta="F.R.I.D.A.Y. · 协同执行",
            headline_text="正在后台并发核查 CS80 固件特性位并合成提示音。",
        )
        render_single_png(
            demo_dir / "ask_boss.png",
            state="waiting",
            workers=1,
            ask_boss="检测到 196 主机缺少 CS80 的 udev 规则，是否立即安装并重启 friday-face 服务？",
        )
        render_single_png(
            demo_dir / "dream_rem.png",
            state="sleeping",
            sub_phase="rem",
            headline_meta="F.R.I.D.A.Y. · 潜意识做梦",
            headline_text="正在只读漫游工作区并巩固今日突触记忆网络…",
        )
        print(json.dumps({"ok": True, "dir": str(demo_dir)}))
        return 0

    daemon = FaceDaemon(
        friday_home=args.home,
        mock_sidecar=args.mock_sidecar,
        mock_log=Path(args.mock_log) if args.mock_log else None,
        brightness=args.brightness,
    )
    server = make_http_server(daemon, args.host, args.port)
    actual_port = server.server_address[1]
    daemon.start()

    shutting_down = threading.Event()

    def handle_sig(_sig: int, _frame: Any) -> None:
        if shutting_down.is_set():
            return
        shutting_down.set()

        def _shutdown() -> None:
            daemon.stop()
            server.shutdown()

        threading.Thread(target=_shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, handle_sig)
    signal.signal(signal.SIGINT, handle_sig)

    print(f"LISTENING http://{args.host}:{actual_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        daemon.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

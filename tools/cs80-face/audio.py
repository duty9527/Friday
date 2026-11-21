"""CS80 built-in speaker controller, chime synthesizer, and MP3 uploader."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import io
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import threading
import time
from typing import Any, Callable, Dict, Optional, Protocol, Sequence, Tuple
import wave

AUDIO_QUERY = 0
AUDIO_STOP = 1
AUDIO_VOLUME = 2
AUDIO_BEGIN = 3
AUDIO_END = 4
AUDIO_PLAY = 5
AUDIO_VERIFY = 6
AUDIO_DIAG = 8
AUDIO_ROUTE = 9

AUDIO_CHUNK = 16384
AUDIO_MAX = 4 * 1024 * 1024

_P1, _P2, _P3, _P4, _P5 = 2654435761, 2246822519, 3266489917, 668265263, 374761393
_M32 = 0xFFFFFFFF


def _rotl32(x: int, r: int) -> int:
    return ((x << r) | (x >> (32 - r))) & _M32


def xxh32(data: bytes, seed: int = 0) -> int:
    """Standard xxHash32 matching QDC1 firmware and qdc1.c (xxh32(b'') == 0x02cc5d05)."""
    n = len(data)
    i = 0
    if n >= 16:
        v0 = (seed + _P1 + _P2) & _M32
        v1 = (seed + _P2) & _M32
        v2 = seed & _M32
        v3 = (seed - _P1) & _M32
        while i <= n - 16:
            l0, l1, l2, l3 = struct.unpack_from("<IIII", data, i)
            i += 16
            v0 = (_rotl32((v0 + l0 * _P2) & _M32, 13) * _P1) & _M32
            v1 = (_rotl32((v1 + l1 * _P2) & _M32, 13) * _P1) & _M32
            v2 = (_rotl32((v2 + l2 * _P2) & _M32, 13) * _P1) & _M32
            v3 = (_rotl32((v3 + l3 * _P2) & _M32, 13) * _P1) & _M32
        h = (_rotl32(v0, 1) + _rotl32(v1, 7) + _rotl32(v2, 12) + _rotl32(v3, 18)) & _M32
    else:
        h = (seed + _P5) & _M32
    h = (h + n) & _M32
    while i <= n - 4:
        lane = struct.unpack_from("<I", data, i)[0]
        h = (_rotl32((h + lane * _P3) & _M32, 17) * _P4) & _M32
        i += 4
    while i < n:
        h = (_rotl32((h + data[i] * _P5) & _M32, 11) * _P1) & _M32
        i += 1
    h ^= h >> 15
    h = (h * _P2) & _M32
    h ^= h >> 13
    h = (h * _P3) & _M32
    h ^= h >> 16
    return h


CHIME_SPECS: Dict[str, Tuple[Tuple[float, float, float, float], ...]] = {
    # (start_sec, duration_sec, freq_hz, amplitude)
    "boot": (
        (0.00, 0.24, 523.25, 0.34),  # C5
        (0.09, 0.26, 659.25, 0.32),  # E5
        (0.18, 0.30, 783.99, 0.32),  # G5
        (0.28, 0.42, 987.77, 0.28),  # B5
    ),
    "wake": (
        (0.00, 0.16, 880.00, 0.32),   # A5
        (0.09, 0.28, 1318.51, 0.30),  # E6
    ),
    "ask_boss": (
        (0.00, 0.22, 587.33, 0.34),  # D5
        (0.14, 0.24, 880.00, 0.32),  # A5
        (0.28, 0.38, 739.99, 0.30),  # F#5
    ),
    "done": (
        (0.00, 0.18, 523.25, 0.32),   # C5
        (0.10, 0.20, 783.99, 0.32),   # G5
        (0.20, 0.36, 1046.50, 0.32),  # C6
    ),
    "alert": (
        (0.00, 0.22, 392.00, 0.34),  # G4
        (0.24, 0.32, 329.63, 0.34),  # E4
    ),
    "remind": (
        (0.00, 0.20, 659.25, 0.32),  # E5
        (0.13, 0.22, 830.61, 0.30),  # G#5
        (0.26, 0.42, 987.77, 0.32),  # B5
    ),
}


def find_ffmpeg() -> str:
    cand = shutil.which("ffmpeg")
    if cand:
        return cand
    for fallback in ("/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/homebrew/bin/ffmpeg"):
        if Path(fallback).is_file():
            return fallback
    return ""


def _synthesize_wav_bytes(notes: Sequence[Tuple[float, float, float, float]], sample_rate: int = 44100) -> bytes:
    total_dur = max(start + dur for start, dur, _, _ in notes) + 0.08
    n_samples = int(total_dur * sample_rate)
    mix = [0.0] * n_samples
    for start, dur, freq, amp in notes:
        i0 = int(start * sample_rate)
        i1 = min(n_samples, i0 + int(dur * sample_rate))
        attack = max(1, int(0.012 * sample_rate))
        for i in range(i0, i1):
            t_rel = (i - i0) / sample_rate
            env_attack = min(1.0, (i - i0) / attack)
            env_decay = math.exp(-4.8 * (t_rel / max(0.05, dur)))
            # Warm electric bell: fundamental + soft 2nd harmonic
            val = (
                math.sin(2.0 * math.pi * freq * t_rel) * 0.78
                + math.sin(2.0 * math.pi * (freq * 2.0) * t_rel) * 0.22
            )
            mix[i] += val * amp * env_attack * env_decay

    pcm = bytearray(n_samples * 4)  # stereo 16-bit
    for i, s in enumerate(mix):
        clamped = max(-0.92, min(0.92, s))
        v = int(clamped * 32767.0)
        struct.pack_into("<hh", pcm, i * 4, v, v)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(bytes(pcm))
    return buf.getvalue()


def audio_to_mp3(data: bytes, name: str = "") -> Tuple[bytes, Dict[str, Any]]:
    ext = Path(name or "").suffix.lower()
    is_mp3 = ext == ".mp3" or data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0)
    if is_mp3:
        if len(data) > AUDIO_MAX:
            raise RuntimeError(f"MP3 exceeds 4 MiB device limit ({len(data)} bytes)")
        return data, {"converted": False, "format": (ext[1:] or "mp3"), "outBytes": len(data)}
    ff = find_ffmpeg()
    if not ff:
        raise RuntimeError("ffmpeg is required to transcode audio to MP3")
    with tempfile.TemporaryDirectory(prefix="cs80-audio-") as tmpdir:
        src = Path(tmpdir) / f"in{ext or '.bin'}"
        dst = Path(tmpdir) / "out.mp3"
        src.write_bytes(data)
        t0 = time.monotonic()
        res = subprocess.run(
            [ff, "-y", "-v", "error", "-i", str(src), "-vn", "-ac", "2", "-ar", "44100", "-b:a", "128k", str(dst)],
            capture_output=True,
            timeout=120,
        )
        if res.returncode != 0 or not dst.is_file():
            err = (res.stderr or b"").decode("utf-8", "replace").strip().splitlines()
            raise RuntimeError((err[-1] if err else "ffmpeg conversion failed")[:160])
        out = dst.read_bytes()
        if len(out) > AUDIO_MAX:
            raise RuntimeError(f"Transcoded MP3 exceeds 4 MiB device limit ({len(out)} bytes)")
        return out, {
            "converted": True,
            "format": (ext[1:] or "?"),
            "ms": int((time.monotonic() - t0) * 1000),
            "inBytes": len(data),
            "outBytes": len(out),
        }


def ensure_chime_mp3(name: str, sounds_dir: Path) -> Path:
    if name not in CHIME_SPECS:
        raise ValueError(f"Unknown chime '{name}'. Valid: {', '.join(CHIME_SPECS)}")
    sounds_dir.mkdir(parents=True, exist_ok=True)
    mp3_path = sounds_dir / f"{name}.mp3"
    if mp3_path.is_file() and mp3_path.stat().st_size > 128:
        return mp3_path
    wav_bytes = _synthesize_wav_bytes(CHIME_SPECS[name])
    mp3_bytes, _ = audio_to_mp3(wav_bytes, name=f"{name}.wav")
    fd, tmp_name = tempfile.mkstemp(prefix=f".tmp-{name}-", suffix=".mp3", dir=str(sounds_dir))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as fp:
            fp.write(mp3_bytes)
        tmp_path.replace(mp3_path)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise
    return mp3_path


def parse_quiet_hours(spec: str, now_dt: Optional[datetime] = None) -> bool:
    raw = (spec or "").strip()
    if not raw or "-" not in raw:
        return False
    parts = raw.split("-", 1)
    try:
        sh, sm = (int(x) for x in parts[0].strip().split(":", 1))
        eh, em = (int(x) for x in parts[1].strip().split(":", 1))
    except ValueError:
        return False
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


class AudioTransport(Protocol):
    def is_up(self) -> bool: ...
    def send_audio_cmd(
        self, sub: int, offset: int = 0, raw: int = 0, payload: bytes = b"", timeout: float = 15.0
    ) -> Dict[str, Any]: ...
    def send_audio_block(self, offset: int, chunk: bytes, timeout: float = 5.0) -> Dict[str, Any]: ...


@dataclass
class SpeakerConfig:
    volume: int = 65
    muted: bool = False
    quiet_hours: str = "23:30-07:30"


class SpeakerController:
    """Manages CS80 built-in speaker config, chime synthesis, caching, and QDC1 upload/playback."""

    def __init__(self, data_dir: Path, transport: AudioTransport) -> None:
        self.data_dir = data_dir
        self.sounds_dir = data_dir / "sounds"
        self.config_path = data_dir / "config.json"
        self.transport = transport
        self._lock = threading.Lock()
        self._cache: Dict[str, Tuple[bytes, int]] = {}
        self._applied_volume: Optional[int] = None
        self.config = self._load_config()

    def _load_config(self) -> SpeakerConfig:
        try:
            raw = json.loads(self.config_path.read_text("utf-8"))
            if not isinstance(raw, dict):
                return SpeakerConfig()
            vol = max(0, min(100, int(raw.get("volume", 65))))
            muted = bool(raw.get("muted", False))
            qh = str(raw.get("quiet_hours", "23:30-07:30"))
            return SpeakerConfig(volume=vol, muted=muted, quiet_hours=qh)
        except (OSError, ValueError, TypeError):
            return SpeakerConfig()

    def get_config_snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "volume": self.config.volume,
                "muted": self.config.muted,
                "quietHours": self.config.quiet_hours,
            }

    def _save_config(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.data_dir / f".tmp-config.{os.getpid()}.json"
        tmp.write_text(
            json.dumps(
                {
                    "volume": self.config.volume,
                    "muted": self.config.muted,
                    "quiet_hours": self.config.quiet_hours,
                },
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        tmp.replace(self.config_path)

    def prewarm_chimes(self) -> Dict[str, int]:
        sizes: Dict[str, int] = {}
        for name in CHIME_SPECS:
            p = ensure_chime_mp3(name, self.sounds_dir)
            data = p.read_bytes()
            self._cache[str(p)] = (data, xxh32(data))
            sizes[name] = len(data)
        return sizes

    def set_volume(self, value: int) -> Dict[str, Any]:
        vol = max(0, min(100, int(value)))
        with self._lock:
            self.config.volume = vol
            self._save_config()
            if not self.transport.is_up():
                self._applied_volume = None
                return {"ok": True, "volume": vol, "deferred": True}
            res = self.transport.send_audio_cmd(AUDIO_VOLUME, offset=vol)
            if res.get("ok"):
                self._applied_volume = vol
            return {"ok": bool(res.get("ok")), "volume": vol, "device": res}

    def set_muted(self, muted: bool) -> Dict[str, Any]:
        with self._lock:
            self.config.muted = bool(muted)
            self._save_config()
            res: Dict[str, Any] = {"ok": True, "muted": self.config.muted}
            if self.config.muted and self.transport.is_up():
                res["stop"] = self.transport.send_audio_cmd(AUDIO_STOP)
            return res

    def set_quiet_hours(self, quiet_hours: str) -> Dict[str, Any]:
        with self._lock:
            self.config.quiet_hours = str(quiet_hours or "").strip()
            self._save_config()
            return {"ok": True, "quiet_hours": self.config.quiet_hours}

    def stop(self) -> Dict[str, Any]:
        with self._lock:
            if not self.transport.is_up():
                return {"ok": False, "err": "device-down"}
            return self.transport.send_audio_cmd(AUDIO_STOP)

    def _upload_locked(self, data: bytes, h: int) -> Dict[str, Any]:
        r = self.transport.send_audio_cmd(AUDIO_BEGIN, offset=len(data), raw=h, timeout=20.0)
        if not r.get("ok"):
            return r
        for off in range(0, len(data), AUDIO_CHUNK):
            r = self.transport.send_audio_block(off, data[off : off + AUDIO_CHUNK], timeout=5.0)
            if not r.get("ok"):
                return dict(r, offset=off)
        r = self.transport.send_audio_cmd(AUDIO_END, timeout=30.0)
        if not r.get("ok"):
            return r
        got = r.get("detail")
        if got and got != h:
            return {"ok": False, "err": "hash-mismatch", "expect": h, "got": got}
        return {"ok": True, "size": len(data), "hash": h}

    def _play_uploaded_locked(self) -> Dict[str, Any]:
        if self._applied_volume != self.config.volume:
            v_res = self.transport.send_audio_cmd(AUDIO_VOLUME, offset=self.config.volume)
            if v_res.get("ok"):
                self._applied_volume = self.config.volume
        r = self.transport.send_audio_cmd(AUDIO_PLAY, timeout=20.0)
        if r.get("ok") or r.get("status") != 4:
            return r
        # Self-heal BAD_STATE: restore speaker route (0) and non-zero volume
        d = self.transport.send_audio_cmd(AUDIO_DIAG)
        if d.get("ok") and d.get("rx") not in (None, 0):
            self.transport.send_audio_cmd(AUDIO_ROUTE, offset=0)
        q = self.transport.send_audio_cmd(AUDIO_QUERY)
        if q.get("ok") and not q.get("rx"):
            vol = self.config.volume or 65
            self.transport.send_audio_cmd(AUDIO_VOLUME, offset=vol)
            self._applied_volume = vol
        return self.transport.send_audio_cmd(AUDIO_PLAY, timeout=20.0)

    def _play_mp3_bytes_locked(self, data: bytes, h: int) -> Dict[str, Any]:
        if not self.transport.is_up():
            return {"ok": False, "err": "device-down"}
        v = self.transport.send_audio_cmd(AUDIO_VERIFY, timeout=15.0)
        uploaded = False
        if not (v.get("ok") and v.get("detail") == h):
            up = self._upload_locked(data, h)
            if not up.get("ok"):
                return up
            uploaded = True
        play_res = self._play_uploaded_locked()
        return dict(play_res, size=len(data), hash=h, uploaded=uploaded)

    def play_chime(
        self,
        name: str,
        *,
        force: bool = False,
        sleeping: bool = False,
        now_dt: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        if name not in CHIME_SPECS:
            return {"ok": False, "err": f"unknown-chime:{name}"}
        if not force:
            with self._lock:
                muted = self.config.muted
                quiet_hours = self.config.quiet_hours
            if muted:
                return {"ok": True, "skipped": "muted"}
            if sleeping:
                return {"ok": True, "skipped": "sleeping"}
            if parse_quiet_hours(quiet_hours, now_dt=now_dt):
                return {"ok": True, "skipped": "quiet-hours"}
        try:
            mp3_path = ensure_chime_mp3(name, self.sounds_dir)
        except Exception as exc:
            return {"ok": False, "err": str(exc)}
        key = str(mp3_path)
        with self._lock:
            if not force and self.config.muted:
                return {"ok": True, "skipped": "muted"}
            cached = self._cache.get(key)
            if cached is None:
                data = mp3_path.read_bytes()
                h = xxh32(data)
                self._cache[key] = (data, h)
            else:
                data, h = cached
            return dict(self._play_mp3_bytes_locked(data, h), chime=name)

    def play_file(self, file_path: str) -> Dict[str, Any]:
        p = Path(file_path).expanduser()
        if not p.is_file():
            return {"ok": False, "err": f"file-not-found:{file_path}"}
        try:
            st = p.stat()
            if st.st_size > 64 * 1024 * 1024:
                return {"ok": False, "err": "input-too-large"}
            raw = p.read_bytes()
        except OSError as exc:
            return {"ok": False, "err": str(exc)}
        if len(raw) > 64 * 1024 * 1024:
            return {"ok": False, "err": "input-too-large"}
        try:
            mp3_bytes, info = audio_to_mp3(raw, name=p.name)
        except Exception as exc:
            return {"ok": False, "err": str(exc)}
        h = xxh32(mp3_bytes)
        with self._lock:
            res = self._play_mp3_bytes_locked(mp3_bytes, h)
            return dict(res, transcode=info, file=str(p))

    def on_sidecar_ready(self) -> None:
        with self._lock:
            self._applied_volume = None
            if self.transport.is_up():
                r = self.transport.send_audio_cmd(AUDIO_VOLUME, offset=self.config.volume)
                if r.get("ok"):
                    self._applied_volume = self.config.volume

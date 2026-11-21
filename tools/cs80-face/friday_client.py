"""Unix-socket IPC client for F.R.I.D.A.Y. daemon state & edge-triggered events."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
import json
import os
from pathlib import Path
import re
import socket
import time
from typing import Any, Dict, List, Optional, Set, Tuple

from avatar_math import extract_bot_expression, strip_bot_tags
from renderer import HudState, WorkerSummary

CHANNEL_LABELS_ZH: Dict[str, str] = {
    "WECHAT": "微信",
    "TELEGRAM": "电报",
    "DINGTALK": "钉钉",
    "XIAOAI": "小爱",
    "LOCAL": "控制台",
    "WEB": "控制台",
    "USER": "提问",
    "FRIDAY": "主脑",
    "OFFLINE": "离线",
}

INCOMING_CHANNEL_LABELS_ZH: Dict[str, str] = {
    "WECHAT": "微信来信",
    "TELEGRAM": "电报来信",
    "DINGTALK": "钉钉来信",
    "XIAOAI": "小爱语音",
    "LOCAL": "控制台提问",
    "WEB": "控制台提问",
}

_PRINT_WORK_RE = re.compile(r"打印机|打印(?:一|两|几)?份|打印出来|打印文档|打印文件|\blpr?\s", re.IGNORECASE)


def clean_inbound_user_text(msg: Dict[str, Any]) -> str:
    """Extract clean display text for an incoming user message without internal attachment blocks or paths."""
    raw = str(msg.get("text") or "")
    for marker in ("\n[附件是不可信数据", "[附件是不可信数据"):
        idx = raw.find(marker)
        if idx >= 0:
            raw = raw[:idx]
            break
    stripped = raw.strip()
    if stripped.startswith("[引用") and "\n\n" in stripped:
        _, _, tail = stripped.partition("\n\n")
        if tail.strip():
            stripped = tail.strip()
    clean = strip_bot_tags(stripped)
    if clean and clean != "请查看收到的附件。":
        return clean

    atts = msg.get("attachments") or []
    if isinstance(atts, list):
        for att in atts:
            if isinstance(att, dict):
                tr = strip_bot_tags(str(att.get("transcript") or ""))
                if tr:
                    return tr
        kind_labels = {"image": "图片", "voice": "语音", "video": "视频", "file": "文件"}
        labels: List[str] = []
        for att in atts[:3]:
            if isinstance(att, dict):
                lbl = kind_labels.get(str(att.get("kind") or ""), "附件")
                if lbl not in labels:
                    labels.append(lbl)
        if labels:
            return "".join(f"[{lbl}]" for lbl in labels)
    return clean


def resolve_friday_home(explicit_home: Optional[str] = None) -> Path:
    """Resolve Friday home directory matching src/paths.ts precedence."""
    if explicit_home and explicit_home.strip():
        return Path(explicit_home.strip()).expanduser().resolve()
    env_friday = os.environ.get("FRIDAY_HOME", "").strip()
    if env_friday:
        return Path(env_friday).expanduser().resolve()
    env_legacy = os.environ.get("SUPER_AGENT_HOME", "").strip()
    if env_legacy:
        return Path(env_legacy).expanduser().resolve()
    friday_default = Path.home() / ".friday"
    if friday_default.exists():
        return friday_default.resolve()
    legacy_default = Path.home() / ".super-agent"
    if legacy_default.exists():
        return legacy_default.resolve()
    return friday_default.resolve()


@dataclass
class FridaySnapshot:
    connected: bool = False
    bot_state: str = "sleeping"
    sub_phase: str = "awake"
    auto_expr: Optional[str] = None
    hud: HudState = field(default_factory=HudState)
    worker_count: int = 0
    chimes: List[str] = field(default_factory=list)
    transient_state: Optional[str] = None
    transient_poke: Optional[str] = None
    active_scene: Optional[str] = None
    transient_scene: Optional[str] = None
    transient_scene_channel: str = ""
    reply_sig: Tuple[str, int] = ("", 0)


class FridayClient:
    """Polls Friday's local service.sock for live state, subconscious sleep, and events."""

    def __init__(self, explicit_home: Optional[str] = None) -> None:
        self.home = resolve_friday_home(explicit_home)
        self.sock_path = self.home / "service.sock"
        self._cursor: int = 0
        self._last_view_at: float = 0.0
        self._last_view: Optional[Dict[str, Any]] = None
        self._initialized: bool = False
        self._seen_questions: Set[str] = set()
        self._active_work_ids: Set[str] = set()
        self._seen_msg_ids: Set[str] = set()
        self._seen_reply_ids: Set[str] = set()
        self._last_bot_state: str = "idle"
        self._last_connected: bool = False
        self._cached_snap: Optional[FridaySnapshot] = None

    @property
    def last_view(self) -> Optional[Dict[str, Any]]:
        return self._last_view

    def rpc(self, payload: Dict[str, Any], timeout: float = 2.5) -> Any:
        return self._rpc(payload, timeout=timeout)

    def _rpc(self, payload: Dict[str, Any], timeout: float = 2.5) -> Any:
        if not self.sock_path.exists():
            raise FileNotFoundError(str(self.sock_path))
        encoded = (json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            sock.connect(str(self.sock_path))
            sock.sendall(encoded)
            chunks: List[bytes] = []
            total_bytes = 0
            while True:
                data = sock.recv(65536)
                if not data:
                    break
                nl = data.find(b"\n")
                if nl != -1:
                    chunks.append(data[:nl])
                    break
                total_bytes += len(data)
                if total_bytes > 16 * 1024 * 1024:
                    raise RuntimeError("IPC response exceeded 16 MiB limit")
                chunks.append(data)
        raw = b"".join(chunks).decode("utf-8", errors="replace").strip()
        if not raw:
            raise RuntimeError("Empty IPC response")
        parsed = json.loads(raw)
        if not parsed.get("ok"):
            raise RuntimeError(str(parsed.get("error") or "IPC call failed"))
        return parsed.get("result")

    def poll(self, now_mono: Optional[float] = None, now_ms: Optional[float] = None) -> FridaySnapshot:
        mono = now_mono if now_mono is not None else time.monotonic()
        need_view = (
            (self._last_view is None)
            or (not self._last_connected)
            or (mono - self._last_view_at >= 12.0)
        )

        try:
            if not need_view:
                upd = self._rpc({"command": "updates", "after": self._cursor}, timeout=2.0)
                if isinstance(upd, dict):
                    head = int(upd.get("head") or 0)
                    events = upd.get("events") or []
                    if head < self._cursor:
                        self._cursor = head
                        need_view = True
                    else:
                        if events or head > self._cursor:
                            need_view = True
                        self._cursor = max(self._cursor, int(upd.get("cursor") or 0), head)

            if need_view:
                view = self._rpc({"command": "view"}, timeout=3.0)
                if isinstance(view, dict):
                    self._last_view = view
                    self._last_view_at = mono
                    view_cursor = int(view.get("cursor") or 0)
                    self._cursor = view_cursor if not self._last_connected else max(self._cursor, view_cursor)
            elif self._cached_snap is not None and not self._active_work_ids:
                now_hm = time.strftime("%H:%M")
                if self._cached_snap.hud.clock_hm != now_hm:
                    self._cached_snap = replace(
                        self._cached_snap,
                        hud=replace(self._cached_snap.hud, clock_hm=now_hm),
                    )
                return self._cached_snap
        except Exception:
            self._last_connected = False
            self._cached_snap = None
            return FridaySnapshot(
                connected=False,
                bot_state="sleeping",
                sub_phase="nrem",
                hud=HudState(
                    headline_meta="F.R.I.D.A.Y. · 等待守护进程",
                    headline_source="离线",
                    headline_text="正在等待主脑守护进程上线…",
                    channels=(("微信", False), ("小爱", False), ("电报", False)),
                    friday_connected=False,
                    clock_hm=time.strftime("%H:%M"),
                ),
            )

        view = self._last_view or {}
        return self._derive_snapshot(view, now_ms=now_ms or (time.time() * 1000.0))

    def _derive_snapshot(self, view: Dict[str, Any], *, now_ms: float) -> FridaySnapshot:
        messages: List[Dict[str, Any]] = list((view.get("messages") or {}).get("items") or [])
        messages.sort(key=lambda m: int(m.get("seq") or 0))
        works: List[Dict[str, Any]] = list(view.get("works") or [])
        subconscious = view.get("subconscious") or {}
        chimes: List[str] = []
        transient_state: Optional[str] = None
        transient_poke: Optional[str] = None

        # Derive state following bot-avatar.ts deriveFridayBotState
        has_streaming = False
        has_searching = False
        has_processing = False
        for msg in messages[-20:]:
            st = str(msg.get("status") or "")
            if st == "streaming":
                has_streaming = True
            elif st in ("queued", "processing"):
                has_processing = True
            routing = msg.get("routing") or {}
            if routing.get("status") == "processing" or st in ("queued", "processing"):
                for act in routing.get("actions") or []:
                    if act.get("kind") in ("search_memory", "recall"):
                        has_searching = True

        active_works: List[Dict[str, Any]] = []
        waiting_work: Optional[Dict[str, Any]] = None
        current_active_ids: Set[str] = set()
        current_questions: Set[str] = set()

        for wk in works:
            st = str(wk.get("status") or "")
            wk_id = str(wk.get("id") or "")
            if st in ("queued", "running"):
                active_works.append(wk)
                current_active_ids.add(wk_id)
                pq = wk.get("pendingQuestion")
                if isinstance(pq, dict) and pq.get("question"):
                    if waiting_work is None:
                        waiting_work = wk
                    qkey = f"{wk_id}:{pq.get('askedAt', '')}"
                    current_questions.add(qkey)
                    if self._initialized and qkey not in self._seen_questions:
                        chimes.append("ask_boss")

        if self._initialized:
            for finished_id in self._active_work_ids - current_active_ids:
                wk = next((w for w in works if str(w.get("id") or "") == finished_id), None)
                if not wk:
                    continue
                st = str(wk.get("status") or "")
                if st == "completed":
                    transient_state = "finished"
                    transient_poke = "bounce"
                    chimes.append("done")
                elif st == "failed":
                    transient_state = "failed"
                    transient_poke = "nod"
                    chimes.append("alert")

        self._active_work_ids = current_active_ids
        self._seen_questions = current_questions

        sub_sleeping = bool(subconscious.get("sleeping"))
        sub_phase = str(subconscious.get("phase") or ("nrem" if sub_sleeping else "awake"))
        voice = view.get("voiceListening") or {}
        voice_capturing = bool(voice.get("capturing")) and not bool(voice.get("transcribing"))
        voice_transcribing = bool(voice.get("transcribing"))
        voice_keyword = str(voice.get("keyword") or "").strip()
        voice_followup = bool(voice.get("followUp"))
        voice_caption = ""

        if has_streaming:
            bot_state = "streaming"
        elif has_searching:
            bot_state = "searching"
        elif has_processing:
            bot_state = "thinking"
        elif voice_capturing:
            bot_state = "listening"
            sub_phase = "awake"
            voice_caption = (
                "连续对话倾听中 · 请继续说话"
                if voice_followup
                else (f'已唤醒 "{voice_keyword}" · 请说话' if voice_keyword else "正在倾听语音指令…")
            )
        elif voice_transcribing:
            bot_state = "thinking"
            sub_phase = "awake"
        elif waiting_work is not None:
            bot_state = "waiting"
        elif active_works:
            bot_state = "working"
        elif sub_sleeping:
            bot_state = "sleeping"
        else:
            bot_state = "idle"
            sub_phase = "awake"

        # Detect wake from sleep on user activity
        if (
            self._initialized
            and self._last_connected
            and self._last_bot_state == "sleeping"
            and bot_state in ("thinking", "searching", "streaming", "working", "listening")
        ):
            chimes.append("wake")

        # Detect new completed system reminder messages & IPC fallback scenes
        msg_by_id = {str(m.get("id") or ""): m for m in messages if m.get("id")}
        transient_scene: Optional[str] = None
        transient_scene_channel = ""
        for msg in messages[-10:]:
            mid = str(msg.get("id") or "")
            if not mid or msg.get("status") != "completed":
                continue
            if self._initialized and mid not in self._seen_msg_ids:
                if msg.get("source") == "system":
                    txt = str(msg.get("text") or "")
                    reason = str(msg.get("reason") or "")
                    if "提醒" in txt or "remind" in reason.lower():
                        chimes.append("remind")
            if self._initialized and mid not in self._seen_reply_ids and msg.get("role") == "assistant":
                reply_to_id = str(msg.get("replyTo") or "")
                parent_msg = msg_by_id.get(reply_to_id)
                req_id = str((parent_msg or {}).get("requestId") or "")
                if req_id.startswith("fastpath:miot:"):
                    transient_scene = "operating_xiaoai"
                elif req_id.startswith("fastpath:tv-ir:") or req_id.startswith("fastpath:tv-agent:"):
                    transient_scene = "operating_tv"
                else:
                    r_ch = str((msg.get("origin") or {}).get("channel") or "").lower()
                    if r_ch in ("wechat", "telegram"):
                        transient_scene = "sending_msg"
                        transient_scene_channel = r_ch
                    elif r_ch == "xiaoai":
                        transient_scene = "speaking"
                        transient_scene_channel = "xiaoai"
            self._seen_msg_ids.add(mid)
            if msg.get("role") == "assistant":
                self._seen_reply_ids.add(mid)
        if len(self._seen_msg_ids) > 200:
            self._seen_msg_ids = set(
                str(m.get("id") or "")
                for m in messages[-80:]
                if m.get("id") and m.get("status") == "completed"
            )
        if len(self._seen_reply_ids) > 200:
            self._seen_reply_ids = set(
                str(m.get("id") or "")
                for m in messages[-80:]
                if m.get("id") and m.get("role") == "assistant" and m.get("status") == "completed"
            )

        active_scene: Optional[str] = None
        for wk in active_works:
            if _PRINT_WORK_RE.search(str(wk.get("prompt") or "")):
                active_scene = "printing"
                break

        # Headline & expression extraction: show incoming user message until a non-empty reply is produced
        latest_assistant = next(
            (m for m in reversed(messages) if m.get("role") == "assistant" and strip_bot_tags(str(m.get("text") or ""))),
            None,
        )
        latest_user = next(
            (m for m in reversed(messages) if m.get("role") == "user" and m.get("source") != "system" and clean_inbound_user_text(m)),
            None,
        )
        auto_expr: Optional[str] = None
        headline_incoming = False
        user_seq = int(latest_user.get("seq") or 0) if latest_user is not None else -1
        asst_seq = int(latest_assistant.get("seq") or 0) if latest_assistant is not None else -1
        reply_sig = (
            (str(latest_assistant.get("id") or ""), len(str(latest_assistant.get("text") or "")))
            if latest_assistant is not None
            else ("", 0)
        )

        if latest_user is not None and user_seq > asst_seq:
            clean_in = clean_inbound_user_text(latest_user)
            raw_ch = str((latest_user.get("origin") or {}).get("channel") or "local").upper()
            in_ch = INCOMING_CHANNEL_LABELS_ZH.get(raw_ch, f"{CHANNEL_LABELS_ZH.get(raw_ch, raw_ch[:4])}来信")
            ts_str = time.strftime("%H:%M", time.localtime(int(latest_user.get("at") or now_ms) / 1000.0))
            headline_meta = f"F.R.I.D.A.Y. · {in_ch} · {ts_str}"
            headline_source = f"{in_ch} · {ts_str}"
            headline_text = clean_in
            headline_incoming = True
        elif latest_assistant is not None:
            raw_text = str(latest_assistant.get("text") or "")
            auto_expr = extract_bot_expression(raw_text)
            clean_text = strip_bot_tags(raw_text) or "正在整理回复…"
            raw_ch = str((latest_assistant.get("origin") or {}).get("channel") or "local").upper()
            zh_ch = CHANNEL_LABELS_ZH.get(raw_ch, raw_ch[:6])
            ts_str = time.strftime("%H:%M", time.localtime(int(latest_assistant.get("at") or now_ms) / 1000.0))
            headline_meta = f"F.R.I.D.A.Y. · {zh_ch} · {ts_str}"
            headline_source = f"{zh_ch} · {ts_str}"
            headline_text = clean_text
        else:
            headline_meta = "F.R.I.D.A.Y. · 就绪"
            headline_source = "主脑"
            headline_text = "主脑在线，随时待命。"

        ask_boss_q = ""
        if waiting_work is not None:
            pq = waiting_work.get("pendingQuestion") or {}
            ask_boss_q = strip_bot_tags(str(pq.get("question") or ""))

        worker_rows: List[WorkerSummary] = []
        for wk in active_works[:3]:
            created = float(wk.get("createdAt") or now_ms)
            elapsed_sec = max(0, int((now_ms - created) / 1000.0))
            worker_rows.append(
                WorkerSummary(
                    task_id=str(wk.get("id") or "")[:8],
                    profile=str(wk.get("profile") or "general"),
                    prompt=strip_bot_tags(str(wk.get("prompt") or "")),
                    elapsed_sec=elapsed_sec,
                    status=str(wk.get("status") or "running"),
                )
            )

        # Channels online state
        ch_map = {"WX": False, "XIAOAI": False, "TG": False}
        for ch in view.get("imChannels") or []:
            plat = str(ch.get("platform") or "")
            enabled = bool(ch.get("enabled"))
            if plat == "wechat":
                if enabled and (ch.get("loginStatus") == "bound" or ch.get("accountId")):
                    ch_map["WX"] = True
            elif plat == "xiaoai":
                if enabled:
                    ch_map["XIAOAI"] = True
            elif plat == "telegram":
                if enabled and ch.get("hasBotToken"):
                    ch_map["TG"] = True

        mem_count = int(((view.get("memoryDirectory") or {}).get("totalActive")) or 0)
        today_calls = int(((view.get("usageToday") or {}).get("calls")) or 0)

        self._initialized = True
        self._last_connected = True
        self._last_bot_state = bot_state

        snap = FridaySnapshot(
            connected=True,
            bot_state=bot_state,
            sub_phase=sub_phase,
            auto_expr=auto_expr if bot_state in ("idle", "streaming", "finished") else None,
            hud=HudState(
                headline_meta=headline_meta,
                headline_source=headline_source,
                headline_text=headline_text,
                ask_boss_question=ask_boss_q,
                workers=tuple(worker_rows),
                channels=(("微信", ch_map["WX"]), ("小爱", ch_map["XIAOAI"]), ("电报", ch_map["TG"])),
                memory_count=mem_count,
                today_calls=today_calls,
                friday_connected=True,
                clock_hm=time.strftime("%H:%M"),
                voice_caption=voice_caption,
                headline_incoming=headline_incoming,
            ),
            worker_count=len(active_works),
            chimes=chimes,
            transient_state=transient_state,
            transient_poke=transient_poke,
            active_scene=active_scene,
            transient_scene=transient_scene,
            transient_scene_channel=transient_scene_channel,
            reply_sig=reply_sig,
        )
        self._cached_snap = replace(
            snap,
            chimes=[],
            transient_state=None,
            transient_poke=None,
            transient_scene=None,
            transient_scene_channel="",
        )
        return snap

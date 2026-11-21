#!/usr/bin/python3
"""BlueZ D-Bus BLE helper for Laifen Wave (V1) and Wave Pro / i2 (V2 Pro) toothbrushes.

Uses system Python `dbus` + `gi.repository.GLib` with zero third-party pip deps.
Uses a single-GLib.MainLoop asynchronous state machine for reliable operation on
both newer BLE 5.x adapters and older Intel Wireless 3165 (BLE 4.2) controllers.

Commands:
  - scan:    discover awake LFTB* / Laifen* toothbrushes (excluding U-GWH* appliances)
  - sync:    connect asynchronously, subscribe FF02 notifications, capture baseline status/info
  - write:   connect, capture baseline, send patched/raw commands, verify ACK + status readback
  - monitor: long-lived brushing monitor streaming atomic JSON snapshots to --state-file
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from typing import Any, Callable

import dbus
import dbus.mainloop.glib
from gi.repository import GLib


BLUEZ_SERVICE = "org.bluez"
OBJECT_MANAGER_IFACE = "org.freedesktop.DBus.ObjectManager"
PROPERTIES_IFACE = "org.freedesktop.DBus.Properties"
ADAPTER_IFACE = "org.bluez.Adapter1"
DEVICE_IFACE = "org.bluez.Device1"
GATT_CHAR_IFACE = "org.bluez.GattCharacteristic1"

CHAR_FF02_UUID = "0000ff02-0000-1000-8000-00805f9b34fb"
CHAR_GAP_NAME_UUID = "00002a00-0000-1000-8000-00805f9b34fb"

EXCLUDED_NAME_PREFIXES = ("U-GWH",)
EXTRA_NAME_PREFIXES = ("LAIFEN",)
EXTRA_NAME_SUBSTRINGS = ("徕芬", "莱芬")

V2PRO_OVER_PRESSURE_BYTES = {
    "Light": (0x00, 0xDC),
    "Medium": (0x01, 0x4A),
    "Hard": (0x01, 0xB8),
}


def now_ms() -> int:
    return int(time.time() * 1000)


def atomic_write_json(path: str, payload: dict[str, Any]) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, mode=0o700, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{time.monotonic_ns()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def serialize_device(path: str, props: dict[str, Any]) -> dict[str, Any]:
    raw_mfg = props.get("ManufacturerData") or {}
    mfg_out: dict[str, str] = {}
    for company_id, payload in raw_mfg.items():
        cid = int(company_id)
        mfg_out[f"0x{cid:04x}"] = bytes(int(b) & 0xFF for b in payload).hex().upper()

    raw_svc = props.get("ServiceData") or {}
    svc_out: dict[str, str] = {}
    for uuid_key, payload in raw_svc.items():
        svc_out[str(uuid_key).lower()] = bytes(int(b) & 0xFF for b in payload).hex().upper()

    uuids = [str(u).lower() for u in (props.get("UUIDs") or [])]
    name = str(props.get("Name") or "")
    alias = str(props.get("Alias") or "")
    rssi = int(props["RSSI"]) if "RSSI" in props and props["RSSI"] is not None else None
    return {
        "path": str(path),
        "address": str(props.get("Address") or "").upper(),
        "name": name or alias,
        "rawName": name,
        "alias": alias,
        "rssi": rssi,
        "uuids": uuids,
        "manufacturerData": mfg_out,
        "serviceData": svc_out,
        "connected": bool(props.get("Connected", False)),
        "paired": bool(props.get("Paired", False)),
        "servicesResolved": bool(props.get("ServicesResolved", False)),
    }


def is_excluded_device(dev: dict[str, Any]) -> bool:
    for label in (dev.get("rawName") or "", dev.get("name") or "", dev.get("alias") or ""):
        upper = label.strip().upper()
        if any(upper.startswith(prefix) for prefix in EXCLUDED_NAME_PREFIXES):
            return True
    return False


def matches_laifen(dev: dict[str, Any], target_mac: str, name_prefix: str) -> bool:
    if is_excluded_device(dev):
        return False
    norm_mac = (target_mac or "").strip().upper()
    if norm_mac and (dev.get("address") or "").upper() == norm_mac:
        return True

    norm_prefix = (name_prefix or "LFTB").strip().upper()
    for label in (dev.get("rawName") or "", dev.get("name") or "", dev.get("alias") or ""):
        clean = label.strip()
        upper = clean.upper()
        if norm_prefix and upper.startswith(norm_prefix):
            return True
        if any(upper.startswith(p) for p in EXTRA_NAME_PREFIXES):
            return True
        if any(sub in clean for sub in EXTRA_NAME_SUBSTRINGS):
            return True
    return False


def get_managed_objects(bus: dbus.SystemBus) -> dict[str, dict[str, dict[str, Any]]]:
    mgr = dbus.Interface(bus.get_object(BLUEZ_SERVICE, "/"), OBJECT_MANAGER_IFACE)
    return mgr.GetManagedObjects()


def find_adapter(bus: dbus.SystemBus, preferred_adapter: str = "") -> tuple[str, dict[str, Any]]:
    objs = get_managed_objects(bus)
    adapters = [
        (str(path), dict(ifaces[ADAPTER_IFACE]))
        for path, ifaces in objs.items()
        if ADAPTER_IFACE in ifaces
    ]
    if not adapters:
        raise RuntimeError("未检测到本机蓝牙适配器 (org.bluez.Adapter1)")
    if preferred_adapter:
        for path, props in adapters:
            if path.endswith("/" + preferred_adapter) or path == preferred_adapter:
                return path, props
    for path, props in adapters:
        if bool(props.get("Powered", False)):
            return path, props
    return adapters[0]


def ensure_adapter_powered(bus: dbus.SystemBus, adapter_path: str, props: dict[str, Any]) -> None:
    if not bool(props.get("Powered", False)):
        dbus.Interface(bus.get_object(BLUEZ_SERVICE, adapter_path), PROPERTIES_IFACE).Set(
            ADAPTER_IFACE, "Powered", dbus.Boolean(True)
        )


def safe_stop_discovery(adapter: dbus.Interface) -> None:
    try:
        adapter.StopDiscovery()
    except Exception:
        pass


def safe_start_le_discovery(adapter: dbus.Interface, duplicate_data: bool = True) -> None:
    filters = (
        (
            {"Transport": dbus.String("le"), "DuplicateData": dbus.Boolean(True)},
            {"Transport": dbus.String("le")},
        )
        if duplicate_data
        else ({"Transport": dbus.String("le")},)
    )
    for filt in filters:
        try:
            adapter.SetDiscoveryFilter(dbus.Dictionary(filt, signature="sv"))
            break
        except Exception:
            continue
    try:
        adapter.StartDiscovery()
    except dbus.DBusException as exc:
        if "InProgress" not in str(exc):
            raise


def xor_frame(prefix_bytes: list[int]) -> bytes:
    cs = 0
    for b in prefix_bytes:
        cs ^= b & 0xFF
    return bytes([*(b & 0xFF for b in prefix_bytes), cs])


def build_v2pro_cmd(cmd16: int, payload: list[int]) -> bytes:
    return xor_frame([0xAA, (cmd16 >> 8) & 0xFF, cmd16 & 0xFF, 0x00, 0x00, len(payload), *payload])


def is_status_frame(raw: bytes) -> bool:
    if len(raw) >= 19 and raw[0] == 0xAA and raw[1] == 0x0A and raw[2] == 0x02:
        return True
    if len(raw) >= 10 and raw[0] == 0x5A and raw[1] in (0xC1, 0x81) and raw[2] == 0x03:
        paylen = raw[5]
        return len(raw) >= 6 + paylen + 1 and paylen >= 33
    if len(raw) >= 10 and raw[0] == 0x5A and raw[2] == 0x03:
        paylen = raw[5]
        return len(raw) >= 6 + paylen + 1 and paylen >= 22
    return False


def is_info_frame(raw: bytes) -> bool:
    return len(raw) >= 8 and raw[0] == 0xAA and raw[1] == 0x01 and raw[2] == 0x02


def parse_v1_baseline(raw: bytes) -> dict[str, Any] | None:
    if len(raw) < 19 or raw[0] != 0xAA or raw[1] != 0x0A or raw[2] != 0x02:
        return None
    mode_index = raw[4] if 0 <= raw[4] <= 3 else 0
    modes: dict[int, tuple[int, int, int]] = {}
    for m in range(4):
        base = 5 + 3 * m
        if base + 2 < len(raw):
            s = raw[base] if 1 <= raw[base] <= 20 else (11 if m == 3 else 5)
            r = raw[base + 1] if 1 <= raw[base + 1] <= 10 else 5
            sp = raw[base + 2] if 1 <= raw[base + 2] <= 10 else 5
            modes[m] = (s, r, sp)
        else:
            modes[m] = (11 if m == 3 else 5, 5, 5)
    return {
        "protocol": "v1",
        "mode_index": mode_index,
        "modes": modes,
        "airplane_mode": bool(raw[17]) if len(raw) > 17 else False,
        "battery_level": raw[18] if len(raw) > 18 else None,
        "reminder_30s": bool(raw[19]) if len(raw) >= 26 else False,
        "duration_sec": ((raw[20] << 8) | raw[21]) if len(raw) >= 26 else 120,
        "high_frequency": bool(raw[22]) if len(raw) >= 26 else False,
        "running": (raw[23] == 0x01) if len(raw) >= 26 else False,
    }


def parse_status_running(raw: bytes) -> bool | None:
    if len(raw) >= 26 and raw[0] == 0xAA and raw[1] == 0x0A and raw[2] == 0x02:
        return raw[23] == 0x01
    if len(raw) >= 20 and raw[0] == 0x5A and raw[1] in (0xC1, 0x81) and raw[2] == 0x03:
        paylen = raw[5]
        if len(raw) >= 6 + paylen + 1 and paylen >= 14:
            return raw[6 + 13] == 0x01
    return None


def is_over_pressure_frame(raw: bytes) -> bool:
    if len(raw) >= 10 and raw[0] == 0x5A and raw[1] == 0x82 and raw[2] == 0x0C:
        paylen = raw[5]
        if len(raw) >= 6 + paylen + 1 and paylen >= 3:
            return raw[6 + 2] != 0
    return False


def build_commands_from_patch(
    proto: str,
    patch: dict[str, Any],
    baseline_raw: bytes | None,
) -> list[dict[str, Any]]:
    """Build ordered BLE write command dicts: {bytes, label, delayAfter}."""
    cmds: list[dict[str, Any]] = []
    if not patch:
        return cmds

    if proto == "v2pro":
        if "highFrequency" in patch:
            cmds.append({
                "bytes": build_v2pro_cmd(0x0203, [0x01 if patch["highFrequency"] else 0x00]),
                "label": "v2pro_high_frequency",
                "delayAfter": 0.05,
            })
        has_mode = ("mode" in patch) or ("modeIndex" in patch)
        has_params = any(k in patch for k in ("strength", "range", "speed"))
        mode_idx = int(patch["modeIndex"]) if "modeIndex" in patch else (int(patch["mode"]) - 1 if "mode" in patch else 0)
        mode_idx = max(0, min(3, mode_idx))
        if has_params:
            raw_s = patch.get("strength")
            s = int(raw_s) if raw_s is not None else (11 if mode_idx == 3 else 5)
            s = max(11, min(20, s)) if mode_idx == 3 else max(1, min(10, s))
            raw_r = patch.get("range")
            r = max(1, min(10, int(raw_r) if raw_r is not None else 5))
            raw_sp = patch.get("speed")
            sp = max(1, min(10, int(raw_sp) if raw_sp is not None else 5))
            cmds.append({
                "bytes": build_v2pro_cmd(0x0109, [mode_idx, s, r, sp]),
                "label": "v2pro_mode_params",
                "delayAfter": 0.05,
            })
        elif has_mode:
            cmds.append({
                "bytes": build_v2pro_cmd(0x0109, [mode_idx]),
                "label": "v2pro_mode",
                "delayAfter": 0.05,
            })
        if "durationSec" in patch:
            sec = max(60, min(300, int(round(float(patch["durationSec"]) / 30.0) * 30)))
            hi, lo = (sec >> 8) & 0xFF, sec & 0xFF
            for m in range(4):
                cmds.append({
                    "bytes": build_v2pro_cmd(0x0200, [m, hi, lo]),
                    "label": f"v2pro_duration_m{m + 1}",
                    "delayAfter": 0.15,
                })
        if "reminder30s" in patch:
            cmds.append({
                "bytes": build_v2pro_cmd(0x010C, [0x01 if patch["reminder30s"] else 0x00]),
                "label": "v2pro_reminder_30s",
                "delayAfter": 0.05,
            })
        if "airplaneMode" in patch:
            cmds.append({
                "bytes": build_v2pro_cmd(0x0202, [0x01 if patch["airplaneMode"] else 0x00]),
                "label": "v2pro_airplane_mode",
                "delayAfter": 0.05,
            })
        if "deepClean" in patch:
            cmds.append({
                "bytes": build_v2pro_cmd(0x0207, [0x01 if patch["deepClean"] else 0x00]),
                "label": "v2pro_deep_clean",
                "delayAfter": 0.05,
            })
        if "antiSplash" in patch:
            cmds.append({
                "bytes": build_v2pro_cmd(0x0210, [0x01 if patch["antiSplash"] else 0x00]),
                "label": "v2pro_anti_splash",
                "delayAfter": 0.05,
            })
        if "powerRampUp" in patch:
            cmds.append({
                "bytes": build_v2pro_cmd(0x0211, [0x01 if patch["powerRampUp"] else 0x00]),
                "label": "v2pro_power_ramp_up",
                "delayAfter": 0.05,
            })
        if "bristleProtection" in patch:
            cmds.append({
                "bytes": build_v2pro_cmd(0x0213, [0x01 if patch["bristleProtection"] else 0x00]),
                "label": "v2pro_bristle_protection",
                "delayAfter": 0.05,
            })
        if "liftToWake" in patch:
            cmds.append({
                "bytes": build_v2pro_cmd(0x0208, [0x01 if patch["liftToWake"] else 0x00]),
                "label": "v2pro_lift_to_wake",
                "delayAfter": 0.05,
            })
        if "overPressureLevel" in patch or "overPressure" in patch:
            lvl = str(patch.get("overPressureLevel") or "Medium")
            p27, p28 = V2PRO_OVER_PRESSURE_BYTES.get(lvl, (0x01, 0x4A))
            enabled = 0x00 if patch.get("overPressure") is False else 0x01
            cmds.append({
                "bytes": build_v2pro_cmd(0x020B, [enabled, p27, p28]),
                "label": "v2pro_over_pressure",
                "delayAfter": 0.05,
            })
        if "power" in patch:
            cmds.append({
                "bytes": build_v2pro_cmd(0x0108, [0x01 if patch["power"] else 0x00]),
                "label": "v2pro_power",
                "delayAfter": 0.05,
            })
        return cmds

    # V1 protocol (AA-header)
    base = parse_v1_baseline(baseline_raw) if baseline_raw else None
    if base is None:
        base = {
            "mode_index": 0,
            "modes": {0: (5, 5, 5), 1: (5, 5, 5), 2: (5, 5, 5), 3: (11, 6, 6)},
            "high_frequency": False,
        }

    if "modeIndex" in patch:
        target_mode = max(0, min(3, int(patch["modeIndex"])))
    elif "mode" in patch:
        target_mode = max(0, min(3, int(patch["mode"]) - 1))
    else:
        target_mode = int(base["mode_index"])

    want_hf = patch.get("highFrequency")
    if target_mode == 3 and not base["high_frequency"] and want_hf is not False:
        cmds.append({
            "bytes": xor_frame([0xAA, 0x0E, 0x01, 0x01, 0x01]),
            "label": "v1_enable_high_frequency_for_mode4",
            "delayAfter": 0.05,
        })
    elif want_hf is True:
        cmds.append({
            "bytes": xor_frame([0xAA, 0x0E, 0x01, 0x01, 0x01]),
            "label": "v1_high_frequency_on",
            "delayAfter": 0.05,
        })

    if any(k in patch for k in ("mode", "modeIndex", "strength", "range", "speed")):
        base_s, base_r, base_sp = base["modes"].get(target_mode, (11 if target_mode == 3 else 5, 5, 5))
        s = int(patch["strength"]) if patch.get("strength") is not None else base_s
        s = max(11, min(20, s)) if target_mode == 3 else max(1, min(10, s))
        r = max(1, min(10, int(patch["range"]) if patch.get("range") is not None else base_r))
        sp = max(1, min(10, int(patch["speed"]) if patch.get("speed") is not None else base_sp))
        cmds.append({
            "bytes": xor_frame([0xAA, 0x04, 0x01, 0x04, target_mode, s, r, sp]),
            "label": f"v1_mode_{target_mode + 1}_settings",
            "delayAfter": 0.05,
        })

    if want_hf is False:
        cmds.append({
            "bytes": xor_frame([0xAA, 0x0E, 0x01, 0x01, 0x00]),
            "label": "v1_high_frequency_off",
            "delayAfter": 0.05,
        })

    if "durationSec" in patch:
        sec = max(60, min(300, int(round(float(patch["durationSec"]) / 30.0) * 30)))
        cmds.append({
            "bytes": xor_frame([0xAA, 0x05, 0x01, 0x02, (sec >> 8) & 0xFF, sec & 0xFF]),
            "label": "v1_duration",
            "delayAfter": 0.05,
        })

    if "reminder30s" in patch:
        cmds.append({
            "bytes": xor_frame([0xAA, 0x0B, 0x01, 0x01, 0x01 if patch["reminder30s"] else 0x00]),
            "label": "v1_reminder_30s",
            "delayAfter": 0.05,
        })

    if "airplaneMode" in patch:
        cmds.append({
            "bytes": xor_frame([0xAA, 0x07, 0x01, 0x01, 0x01 if patch["airplaneMode"] else 0x00]),
            "label": "v1_airplane_mode",
            "delayAfter": 0.05,
        })

    if "power" in patch:
        cmds.append({
            "bytes": xor_frame([0xAA, 0x0F, 0x01, 0x01, 0x01 if patch["power"] else 0x00]),
            "label": "v1_power",
            "delayAfter": 0.05,
        })

    if "calibration" in patch:
        cal = str(patch["calibration"]).strip().lower()
        if cal == "limp":
            cmds.append({
                "bytes": xor_frame([0xAA, 0x06, 0x01, 0x01, 0x01]),
                "label": "v1_calibration_limp",
                "delayAfter": 0.05,
            })
        elif cal == "calibrate":
            cmds.append({
                "bytes": xor_frame([0xAA, 0x06, 0x01, 0x01, 0x03]),
                "label": "v1_calibration_align",
                "delayAfter": 0.05,
            })

    return cmds


def install_signal_handlers(callback: Callable[[], None]) -> None:
    """Register SIGINT/SIGTERM handlers via GLib.unix_signal_add with signal fallback."""
    def _on_unix_sig(*_args: Any) -> bool:
        callback()
        return False

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, _on_unix_sig)
        except Exception:
            signal.signal(sig, lambda *_a: GLib.idle_add(lambda: (callback(), False)[1]))


def run_scan(args: argparse.Namespace) -> dict[str, Any]:
    """Single-GLib.MainLoop LE scan returning matching Laifen devices."""
    bus = dbus.SystemBus()
    adapter_path, adapter_props = find_adapter(bus, args.adapter)
    ensure_adapter_powered(bus, adapter_path, adapter_props)
    adapter = dbus.Interface(bus.get_object(BLUEZ_SERVICE, adapter_path), ADAPTER_IFACE)

    target_mac = args.target_mac
    name_prefix = args.name_prefix
    stop_on_match = bool(getattr(args, "stop_on_match", False)) or bool((target_mac or "").strip())
    seen_devices: dict[str, dict[str, Any]] = {}

    loop = GLib.MainLoop()
    timer_expired = False
    early_quit_id: int | None = None

    def stop_loop() -> bool:
        nonlocal timer_expired
        timer_expired = True
        loop.quit()
        return False

    def trigger_early_quit() -> bool:
        nonlocal early_quit_id
        early_quit_id = None
        loop.quit()
        return False

    def record_seen(dev: dict[str, Any]) -> None:
        nonlocal early_quit_id
        addr = dev.get("address") or dev.get("path")
        if not addr:
            return
        prev = seen_devices.get(addr, {})
        merged = {**prev, **{k: v for k, v in dev.items() if v not in (None, "", [], {})}}
        merged["seenAt"] = now_ms()
        seen_devices[addr] = merged

        if stop_on_match:
            has_name = bool(merged.get("rawName"))
            if has_name:
                if early_quit_id is not None:
                    try:
                        GLib.source_remove(early_quit_id)
                    except Exception:
                        pass
                early_quit_id = GLib.timeout_add(50, trigger_early_quit)
            elif early_quit_id is None:
                early_quit_id = GLib.timeout_add(180, trigger_early_quit)

    def on_added(path: Any, interfaces: dict[str, Any]) -> None:
        if DEVICE_IFACE not in interfaces:
            return
        dev = serialize_device(str(path), dict(interfaces[DEVICE_IFACE]))
        if matches_laifen(dev, target_mac, name_prefix):
            record_seen(dev)

    def on_changed(interface: str, _changed: Any, _inv: Any, path: str | None = None) -> None:
        if interface != DEVICE_IFACE or not path:
            return
        try:
            props = dict(dbus.Interface(bus.get_object(BLUEZ_SERVICE, path), PROPERTIES_IFACE).GetAll(DEVICE_IFACE))
            dev = serialize_device(str(path), props)
            if matches_laifen(dev, target_mac, name_prefix):
                record_seen(dev)
        except Exception:
            pass

    install_signal_handlers(loop.quit)

    r1 = bus.add_signal_receiver(on_added, dbus_interface=OBJECT_MANAGER_IFACE, signal_name="InterfacesAdded", bus_name=BLUEZ_SERVICE)
    r2 = bus.add_signal_receiver(on_changed, dbus_interface=PROPERTIES_IFACE, signal_name="PropertiesChanged", bus_name=BLUEZ_SERVICE, path_keyword="path")
    tid: int | None = None

    try:
        safe_stop_discovery(adapter)
        objs = get_managed_objects(bus)
        for p, ifaces in objs.items():
            if DEVICE_IFACE not in ifaces:
                continue
            dev = serialize_device(str(p), dict(ifaces[DEVICE_IFACE]))
            if not matches_laifen(dev, target_mac, name_prefix):
                continue
            if dev["connected"]:
                record_seen(dev)
            elif not dev["paired"]:
                try:
                    adapter.RemoveDevice(dbus.ObjectPath(str(p)))
                except Exception:
                    pass
        safe_start_le_discovery(adapter)
        tid = GLib.timeout_add(int(max(1.0, float(args.timeout)) * 1000), stop_loop)
        loop.run()
    finally:
        if early_quit_id is not None:
            try:
                GLib.source_remove(early_quit_id)
            except Exception:
                pass
        if tid is not None and not timer_expired:
            try:
                GLib.source_remove(tid)
            except Exception:
                pass
        r1.remove()
        r2.remove()
        safe_stop_discovery(adapter)

    devices = sorted(
        seen_devices.values(),
        key=lambda d: d.get("rssi") if isinstance(d.get("rssi"), int) else -999,
        reverse=True,
    )
    return {
        "ok": True,
        "scannedAt": now_ms(),
        "adapter": {
            "path": adapter_path,
            "address": str(adapter_props.get("Address") or "").upper(),
            "name": str(adapter_props.get("Name") or ""),
        },
        "devices": devices,
    }


class BaseBleSession:
    """Shared single-GLib.MainLoop asynchronous BlueZ connection state machine.

    Tuned for Intel Wireless 3165 (BLE 4.2) and short wake-up advertising windows:
      - Optionally reuses a warm BlueZ cache entry (recent RSSI on bound target_mac)
        for instant 220ms fast-connect; falls back to RemoveDevice + LE scan if stale.
      - Skips rawName wait when exact target_mac matches.
      - Stops discovery and waits 220ms (polling Adapter1.Discovering == False)
        before async Connect(timeout=6).
      - Retries Connect() directly once after 450ms before resuming discovery.
    """

    def __init__(
        self,
        target_mac: str,
        name_prefix: str,
        adapter_name: str,
        timeout_sec: float,
        max_attempts: int = 6,
        has_deadline: bool = True,
        allow_warm_cache: bool = True,
    ) -> None:
        self.bus = dbus.SystemBus()
        self.loop = GLib.MainLoop()
        self.adapter_path, self.adapter_props = find_adapter(self.bus, adapter_name)
        ensure_adapter_powered(self.bus, self.adapter_path, self.adapter_props)
        self.adapter = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.adapter_path), ADAPTER_IFACE)

        self.target_mac = target_mac
        self.name_prefix = name_prefix
        norm_mac = (self.target_mac or "").strip().upper()
        self.target_dev_suffix = ("/DEV_" + norm_mac.replace(":", "_")) if norm_mac else ""
        self.ignored_paths: set[str] = set()
        self.timeout_sec = float(timeout_sec)
        self.started_at = now_ms()
        self.has_deadline = has_deadline
        self.allow_warm_cache = allow_warm_cache
        self.deadline = time.monotonic() + max(3.0, self.timeout_sec)
        self.max_attempts = max_attempts
        self.connect_attempts = 0
        self.attempt_errors: list[str] = []

        self.stopping = False
        self.finished = False
        self.initial_cleanup_done = False
        self.warm_cache_fast_try = False
        self.discovery_active = False
        self.settling_match = False
        self.connecting = False
        self.direct_retried_for_current_adv = False
        self.services_handled = False

        self.device_path: str | None = None
        self.device_snapshot: dict[str, Any] | None = None
        self.ff02_path: str | None = None
        self.gap_name_path: str | None = None
        self.connected = False
        self.notify_active = False

        self.overall_timer_id: int | None = None
        self.scan_rsp_timer_id: int | None = None
        self.settle_timer_id: int | None = None
        self.connect_timer_id: int | None = None
        self.resolve_timer_id: int | None = None
        self.retry_timer_id: int | None = None
        self.settle_polls_remaining = 0

        self.receivers: list[Any] = []
        self.notifications: list[dict[str, Any]] = []
        self.status_frames: list[bytes] = []
        self.info_frames: list[bytes] = []
        self.ack_frames: list[dict[str, Any]] = []
        self.status_seq = 0

    def cancel_timer(self, attr: str) -> None:
        tid = getattr(self, attr, None)
        if tid is not None:
            setattr(self, attr, None)
            try:
                GLib.source_remove(tid)
            except Exception:
                pass

    def _base_timer_attrs(self) -> tuple[str, ...]:
        return (
            "overall_timer_id",
            "scan_rsp_timer_id",
            "settle_timer_id",
            "connect_timer_id",
            "resolve_timer_id",
            "retry_timer_id",
        )

    def cancel_all_timers(self) -> None:
        for attr in self._base_timer_attrs():
            self.cancel_timer(attr)

    def install_receivers(self) -> None:
        self.receivers.append(
            self.bus.add_signal_receiver(
                self._on_interfaces_added,
                dbus_interface=OBJECT_MANAGER_IFACE,
                signal_name="InterfacesAdded",
                bus_name=BLUEZ_SERVICE,
            )
        )
        self.receivers.append(
            self.bus.add_signal_receiver(
                self._on_properties_changed,
                dbus_interface=PROPERTIES_IFACE,
                signal_name="PropertiesChanged",
                bus_name=BLUEZ_SERVICE,
                path_keyword="path",
            )
        )

    def cleanup_ble(self) -> None:
        self.cancel_all_timers()
        for rec in self.receivers:
            try:
                rec.remove()
            except Exception:
                pass
        self.receivers.clear()
        safe_stop_discovery(self.adapter)
        self.discovery_active = False
        if self.ff02_path:
            try:
                dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.ff02_path), GATT_CHAR_IFACE).StopNotify(timeout=3)
            except Exception:
                pass
        self.notify_active = False
        if self.device_path:
            try:
                dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.device_path), DEVICE_IFACE).Disconnect()
            except Exception:
                pass
        self.connected = False

    def clear_stale_unpaired_once(self) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        objs = get_managed_objects(self.bus)
        connected_match: dict[str, Any] | None = None
        warm_match: dict[str, Any] | None = None
        norm_mac = (self.target_mac or "").strip().upper()
        do_cleanup = not self.initial_cleanup_done
        stale_paths: list[str] = []

        for path, ifaces in objs.items():
            if DEVICE_IFACE not in ifaces:
                continue
            dev = serialize_device(str(path), dict(ifaces[DEVICE_IFACE]))
            if not matches_laifen(dev, self.target_mac, self.name_prefix):
                continue
            if dev["connected"]:
                connected_match = dev
                break
            if do_cleanup and not dev["paired"]:
                if (
                    self.allow_warm_cache
                    and warm_match is None
                    and norm_mac
                    and (dev.get("address") or "").upper() == norm_mac
                    and dev.get("rssi") is not None
                ):
                    warm_match = dev
                else:
                    stale_paths.append(str(path))

        if connected_match is None and do_cleanup:
            for spath in stale_paths:
                try:
                    self.adapter.RemoveDevice(dbus.ObjectPath(spath))
                except Exception:
                    pass

        self.initial_cleanup_done = True
        return connected_match, warm_match

    def can_accept_candidate(self) -> bool:
        return True

    def begin_scan(self) -> bool:
        self.retry_timer_id = None
        if self.stopping or self.finished:
            return False
        if self.has_deadline and time.monotonic() >= self.deadline:
            self.on_overall_timeout()
            return False

        self.settling_match = False
        self.connecting = False
        self.services_handled = False
        self.device_path = None
        self.ff02_path = None
        self.gap_name_path = None

        safe_stop_discovery(self.adapter)
        self.discovery_active = False
        already_connected, warm_match = self.clear_stale_unpaired_once()
        if already_connected:
            self.device_path = already_connected["path"]
            self.device_snapshot = already_connected
            self.connecting = True
            self.connected = True
            if already_connected.get("servicesResolved"):
                self._on_services_resolved()
            else:
                self._on_connect_ok()
            return False

        if warm_match is not None:
            self.warm_cache_fast_try = True
            self.device_path = warm_match["path"]
            self.device_snapshot = warm_match
            self.direct_retried_for_current_adv = False
            self._start_stop_discovery_settle()
            return False

        self.on_scan_started()
        safe_start_le_discovery(self.adapter)
        self.discovery_active = True
        return False

    def _on_interfaces_added(self, path: Any, interfaces: dict[str, Any]) -> None:
        if self.stopping or self.finished or self.settling_match or self.connecting or self.device_path:
            return
        if not self.can_accept_candidate():
            return
        if DEVICE_IFACE not in interfaces:
            return
        dev = serialize_device(str(path), dict(interfaces[DEVICE_IFACE]))
        if matches_laifen(dev, self.target_mac, self.name_prefix):
            self._handle_candidate_sighted(dev)

    def _on_properties_changed(
        self,
        interface: str,
        changed: dict[str, Any],
        _invalidated: Any,
        path: str | None = None,
    ) -> None:
        if self.stopping or self.finished or not path:
            return

        if interface == DEVICE_IFACE:
            if self.device_path and str(path) == self.device_path:
                if "RSSI" in changed and self.device_snapshot is not None:
                    self.device_snapshot["rssi"] = int(changed["RSSI"])
                if "Name" in changed and self.device_snapshot is not None:
                    self.device_snapshot["name"] = str(changed["Name"])
                if "ServicesResolved" in changed and bool(changed["ServicesResolved"]):
                    self.cancel_timer("resolve_timer_id")
                    self._on_services_resolved()
                if "Connected" in changed and not bool(changed["Connected"]):
                    self.connected = False
                    self.on_device_disconnected()
            elif not self.settling_match and not self.connecting and not self.device_path:
                if not self.can_accept_candidate():
                    return
                spath = str(path)
                if self.target_dev_suffix and not spath.upper().endswith(self.target_dev_suffix):
                    return
                if not self.target_dev_suffix and spath in self.ignored_paths and "Name" not in changed and "Alias" not in changed:
                    return
                if not any(k in changed for k in ("RSSI", "ManufacturerData", "ServiceData", "Name", "Alias")):
                    return
                try:
                    props = dict(
                        dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, path), PROPERTIES_IFACE).GetAll(DEVICE_IFACE)
                    )
                    dev = serialize_device(spath, props)
                    if matches_laifen(dev, self.target_mac, self.name_prefix):
                        self._handle_candidate_sighted(dev)
                    elif not self.target_dev_suffix and (dev.get("rawName") or dev.get("alias")):
                        self.ignored_paths.add(spath)
                except Exception:
                    pass

        elif interface == GATT_CHAR_IFACE and self.ff02_path and str(path) == self.ff02_path and "Value" in changed:
            raw = bytes(int(b) & 0xFF for b in changed["Value"])
            self._record_ff02_packet(raw)

    def _handle_candidate_sighted(self, dev: dict[str, Any]) -> None:
        if self.stopping or self.finished or self.settling_match or self.connecting:
            return
        self.device_path = dev["path"]
        self.device_snapshot = dev
        self.direct_retried_for_current_adv = False

        exact_mac = bool(self.target_mac and (dev.get("address") or "").upper() == self.target_mac.strip().upper())
        if not exact_mac and not dev.get("rawName"):
            # Wait 120ms for Scan Response (Name) when discovering by prefix only
            self.settling_match = True
            self.cancel_timer("scan_rsp_timer_id")
            self.scan_rsp_timer_id = GLib.timeout_add(120, self._on_scan_rsp_settled)
            return

        self._start_stop_discovery_settle()

    def _on_scan_rsp_settled(self) -> bool:
        self.scan_rsp_timer_id = None
        self.settling_match = False
        if self.stopping or self.finished or not self.device_path:
            return False
        try:
            props = dict(
                dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.device_path), PROPERTIES_IFACE).GetAll(DEVICE_IFACE)
            )
            self.device_snapshot = serialize_device(self.device_path, props)
        except Exception:
            pass
        if self.device_snapshot and is_excluded_device(self.device_snapshot):
            self.device_path = None
            self.device_snapshot = None
            return False
        self._start_stop_discovery_settle()
        return False

    def _start_stop_discovery_settle(self) -> None:
        if self.stopping or self.finished or self.connecting or not self.device_path:
            return
        self.connecting = True
        self.on_connecting_started(self.device_snapshot or {})
        safe_stop_discovery(self.adapter)
        self.discovery_active = False
        self.settle_polls_remaining = 3  # 220ms settle + up to 3 * 80ms only if still Discovering
        self.cancel_timer("settle_timer_id")
        self.settle_timer_id = GLib.timeout_add(220, self._poll_discovery_stopped)

    def _poll_discovery_stopped(self) -> bool:
        self.settle_timer_id = None
        if self.stopping or self.finished or not self.device_path:
            return False
        discovering = False
        try:
            discovering = bool(
                dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.adapter_path), PROPERTIES_IFACE).Get(
                    ADAPTER_IFACE, "Discovering"
                )
            )
        except Exception:
            discovering = False

        if discovering and self.settle_polls_remaining > 0:
            self.settle_polls_remaining -= 1
            self.settle_timer_id = GLib.timeout_add(80, self._poll_discovery_stopped)
            return False

        self._do_connect_async()
        return False

    def _do_connect_async(self) -> bool:
        self.connect_timer_id = None
        if self.stopping or self.finished or not self.device_path:
            return False
        if self.has_deadline and time.monotonic() >= self.deadline:
            self.on_overall_timeout()
            return False

        # Check if device already transitioned to Connected during settle
        try:
            props = dict(
                dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.device_path), PROPERTIES_IFACE).GetAll(DEVICE_IFACE)
            )
            self.device_snapshot = serialize_device(self.device_path, props)
            if bool(props.get("Connected", False)):
                self.connected = True
                if bool(props.get("ServicesResolved", False)):
                    self._on_services_resolved()
                else:
                    self._on_connect_ok()
                return False
        except Exception:
            pass

        self.connect_attempts += 1
        try:
            dev_iface = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.device_path), DEVICE_IFACE)
            dev_iface.Connect(reply_handler=self._on_connect_ok, error_handler=self._on_connect_err, timeout=6)
        except Exception as exc:
            self._on_connect_err(exc)
        return False

    def _on_connect_ok(self) -> None:
        if self.stopping or self.finished or not self.device_path:
            return
        self.warm_cache_fast_try = False
        self.connected = True
        self.on_connected()
        try:
            props = dict(
                dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.device_path), PROPERTIES_IFACE).GetAll(DEVICE_IFACE)
            )
            self.device_snapshot = serialize_device(self.device_path, props)
            if bool(props.get("ServicesResolved", False)):
                self._on_services_resolved()
                return
        except Exception:
            pass
        self.cancel_timer("resolve_timer_id")
        self.resolve_timer_id = GLib.timeout_add(8000, self._on_resolve_timeout)

    def _on_resolve_timeout(self) -> bool:
        self.resolve_timer_id = None
        if not self.stopping and not self.finished and not self.services_handled:
            self._handle_connect_failure("蓝牙服务解析超时")
        return False

    def _on_connect_err(self, err: Any) -> None:
        if self.stopping or self.finished or not self.device_path:
            return
        self.connected = False
        self._handle_connect_failure(str(err))

    def _handle_connect_failure(self, err_msg: str) -> None:
        self.cancel_timer("resolve_timer_id")
        self.cancel_timer("connect_timer_id")
        self.cancel_timer("settle_timer_id")
        self.services_handled = False
        self.notify_active = False
        self.ff02_path = None
        self.gap_name_path = None
        self.attempt_errors.append(err_msg)

        if self.max_attempts > 0 and self.connect_attempts >= self.max_attempts:
            self.on_connect_exhausted(err_msg)
            return
        if self.has_deadline and time.monotonic() + 1.5 >= self.deadline:
            self.on_overall_timeout()
            return

        if self.warm_cache_fast_try:
            self.warm_cache_fast_try = False
            old_path = self.device_path
            if old_path:
                try:
                    dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, old_path), DEVICE_IFACE).Disconnect()
                except Exception:
                    pass
                try:
                    self.adapter.RemoveDevice(dbus.ObjectPath(old_path))
                except Exception:
                    pass
            self.device_path = None
            self.connecting = False
            self.direct_retried_for_current_adv = False
            self.on_retry_scheduled("缓存连接已过期，已转入实时扫描等待牙刷唤醒…")
            self.cancel_timer("retry_timer_id")
            self.retry_timer_id = GLib.timeout_add(150, self.begin_scan)
            return

        # Retry directly once after 450ms without RemoveDevice or restarting discovery
        if not self.direct_retried_for_current_adv and self.device_path:
            self.direct_retried_for_current_adv = True
            self.on_retry_scheduled(f"连接未就绪 ({err_msg[:60]})，450ms 后直接重试…")
            self.cancel_timer("connect_timer_id")
            self.connect_timer_id = GLib.timeout_add(450, self._do_connect_async)
            return

        # Fall back to scanning without calling RemoveDevice (keep LE bearer cache)
        self.direct_retried_for_current_adv = False
        if self.device_path:
            try:
                dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.device_path), DEVICE_IFACE).Disconnect()
            except Exception:
                pass
        self.device_path = None
        self.connecting = False
        self.on_retry_scheduled(f"连接未就绪 ({err_msg[:60]})，继续扫描等待牙刷广播…")
        self.cancel_timer("retry_timer_id")
        self.retry_timer_id = GLib.timeout_add(450, self.begin_scan)

    def _on_services_resolved(self) -> None:
        if self.stopping or self.finished or not self.device_path or self.services_handled:
            return
        self.services_handled = True

        objs = get_managed_objects(self.bus)
        prefix = self.device_path + "/"
        for path, ifaces in objs.items():
            spath = str(path)
            if not spath.startswith(prefix) or GATT_CHAR_IFACE not in ifaces:
                continue
            cuuid = str(ifaces[GATT_CHAR_IFACE].get("UUID") or "").lower()
            if cuuid == CHAR_FF02_UUID:
                self.ff02_path = spath
            elif cuuid == CHAR_GAP_NAME_UUID:
                self.gap_name_path = spath

        if not self.ff02_path:
            self.services_handled = False
            self._handle_connect_failure("未在设备中找到 0xFF02 通信特征")
            return

        if self.gap_name_path and self.device_snapshot is not None:
            try:
                c_iface = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.gap_name_path), GATT_CHAR_IFACE)
                raw_name = bytes(int(b) & 0xFF for b in c_iface.ReadValue(dbus.Dictionary({}, signature="sv")))
                gap_name = raw_name.split(b"\x00", 1)[0].decode("utf-8", errors="replace").strip()
                if gap_name:
                    self.device_snapshot["name"] = gap_name
            except Exception:
                pass

        try:
            c_iface = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.ff02_path), GATT_CHAR_IFACE)
            c_iface.StartNotify(
                reply_handler=self._on_notify_ok_internal,
                error_handler=lambda e: self._on_notify_err_internal(str(e)),
                timeout=8,
            )
        except Exception as exc:
            self._on_notify_err_internal(str(exc))

    def _on_notify_ok_internal(self) -> None:
        if self.stopping or self.finished:
            return
        self.notify_active = True
        self.on_notify_started()

    def _on_notify_err_internal(self, err_msg: str) -> None:
        if self.stopping or self.finished:
            return
        self.services_handled = False
        self._handle_connect_failure(f"订阅 FF02 失败: {err_msg}")

    def _record_ff02_packet(self, raw: bytes) -> None:
        if self.stopping or self.finished or not raw:
            return
        hex_str = raw.hex().upper()
        self.notifications.append({"at": now_ms(), "uuid": CHAR_FF02_UUID, "hex": hex_str})
        if is_status_frame(raw):
            self.status_frames.append(raw)
            self.status_seq += 1
        elif is_info_frame(raw):
            self.info_frames.append(raw)
        elif len(raw) >= 6 and raw[0] == 0xAA and raw[2] == 0x02 and raw[3] == 0x01:
            self.ack_frames.append({
                "at": now_ms(),
                "proto": "v1",
                "cmdByte": raw[1],
                "statusByte": raw[4],
                "hex": hex_str,
            })
        elif len(raw) >= 6 and raw[0] == 0x5A and raw[1] == 0xC2:
            self.ack_frames.append({
                "at": now_ms(),
                "proto": "v2pro",
                "cmdByte": raw[2],
                "statusByte": 0,
                "hex": hex_str,
            })
        self.on_ff02_packet(raw, hex_str)

    # Hooks for subclasses
    def on_scan_started(self) -> None:
        pass

    def on_connecting_started(self, dev: dict[str, Any]) -> None:
        pass

    def on_connected(self) -> None:
        pass

    def on_retry_scheduled(self, msg: str) -> None:
        pass

    def on_device_disconnected(self) -> None:
        pass

    def on_notify_started(self) -> None:
        pass

    def on_ff02_packet(self, raw: bytes, hex_str: str) -> None:
        pass

    def on_connect_exhausted(self, last_err: str) -> None:
        pass

    def on_overall_timeout(self) -> bool:
        return False


class AsyncOneShotSession(BaseBleSession):
    """Pure asynchronous single-GLib.MainLoop session for `sync` and `write`."""

    def __init__(self, mode: str, args: argparse.Namespace, ops: dict[str, Any] | None = None) -> None:
        super().__init__(
            target_mac=args.target_mac,
            name_prefix=args.name_prefix,
            adapter_name=args.adapter,
            timeout_sec=float(args.timeout),
            max_attempts=6,
            has_deadline=True,
            allow_warm_cache=True,
        )
        self.mode = mode  # "sync" | "write"
        self.ops = ops or {}
        self.patch = self.ops.get("patch") if isinstance(self.ops.get("patch"), dict) else {}
        self.raw_hex_list = self.ops.get("rawHexList") if isinstance(self.ops.get("rawHexList"), list) else []
        self.refresh_status = bool(self.ops.get("refreshStatus", True))

        self.state_file = str(getattr(args, "state_file", "") or "").strip()
        self.session_id = str(getattr(args, "session_id", "") or "").strip() or f"{mode}-{self.started_at}"
        self.stopped_by_signal = False
        self.state: dict[str, Any] = {
            "sessionId": self.session_id,
            "pid": os.getpid(),
            "phase": "scanning",
            "startedAt": self.started_at,
            "updatedAt": self.started_at,
            "timeoutSec": self.timeout_sec,
            "message": "正在等待徕芬牙刷广播信号（请拿起或轻按牙刷亮灯）…",
            "device": None,
            "firstStatusHex": None,
            "latestStatusHex": None,
            "infoHex": None,
            "runningStartedAt": None,
            "activeBrushingSec": 0,
            "overPressureEvents": 0,
            "error": None,
        }

        self.phase = "scanning"
        self.result: dict[str, Any] = {"ok": False, "error": "未执行"}

        self.wait_timer_id: int | None = None
        self.ack_timer_id: int | None = None
        self.write_delay_timer_id: int | None = None
        self.refresh_timer_id: int | None = None
        self.cycle_timer_id: int | None = None

        self.proto = "v1"
        self.baseline_raw: bytes | None = None
        self.after_raw: bytes | None = None
        self.cmd_queue: list[dict[str, Any]] = []
        self.cmd_index = 0
        self.cmd_start_ack_idx = 0
        self.seq_before_last = 0
        self.tx_log: list[dict[str, Any]] = []
        self.waiting_ack = False
        self.cycling_notify = False

    def flush_state(self, phase: str | None = None, message: str | None = None, error: str | None = None) -> None:
        if not self.state_file:
            return
        if phase is not None:
            self.state["phase"] = phase
        if message is not None:
            self.state["message"] = message
        if error is not None or phase in ("completed", "scanning", "connecting", "monitoring"):
            self.state["error"] = error
        self.state["device"] = self.device_snapshot
        self.state["updatedAt"] = now_ms()
        if self.baseline_raw is not None:
            self.state["firstStatusHex"] = self.baseline_raw.hex().upper()
        elif self.status_frames:
            self.state["firstStatusHex"] = self.status_frames[0].hex().upper()
        if self.after_raw is not None:
            self.state["latestStatusHex"] = self.after_raw.hex().upper()
        elif self.status_frames:
            self.state["latestStatusHex"] = self.status_frames[-1].hex().upper()
        if self.info_frames:
            self.state["infoHex"] = self.info_frames[-1].hex().upper()
        try:
            atomic_write_json(self.state_file, self.state)
        except Exception:
            pass

    def cancel_all_timers(self) -> None:
        super().cancel_all_timers()
        for attr in ("wait_timer_id", "ack_timer_id", "write_delay_timer_id", "refresh_timer_id", "cycle_timer_id"):
            self.cancel_timer(attr)

    def finish(self, payload: dict[str, Any]) -> None:
        if self.finished:
            return
        self.finished = True
        self.stopping = True
        self.result = payload
        self.cleanup_ble()
        if self.state_file:
            if payload.get("ok"):
                self.flush_state(
                    "completed",
                    "已完成牙刷唤醒同步" if self.mode == "sync" else "已完成牙刷参数写入与校验",
                    None,
                )
            elif self.stopped_by_signal:
                self.flush_state("stopped", str(payload.get("error") or "已手动停止等待"), None)
            elif "超时" in str(payload.get("error") or ""):
                self.flush_state("timeout", str(payload.get("error")), str(payload.get("error")))
            else:
                self.flush_state("error", str(payload.get("error") or "执行失败"), str(payload.get("error") or "执行失败"))
        self.loop.quit()

    def finish_error(self, message: str) -> None:
        self.finish({
            "ok": False,
            "error": message,
            "attempts": self.connect_attempts,
            "attemptErrors": self.attempt_errors,
            "device": self.device_snapshot,
        })

    def _on_signal_stop(self) -> None:
        self.stopped_by_signal = True
        self.finish_error("已手动停止等待")

    def on_scan_started(self) -> None:
        self.flush_state("scanning", "正在等待徕芬牙刷广播信号（请拿起或轻按牙刷亮灯）…")

    def on_connecting_started(self, dev: dict[str, Any]) -> None:
        rssi = dev.get("rssi")
        rssi_txt = f" (RSSI {rssi} dBm)" if rssi is not None else ""
        self.flush_state("connecting", f"已发现 {dev.get('name') or dev.get('address') or 'LFTB'}{rssi_txt}，正在建立蓝牙连接…")

    def on_retry_scheduled(self, msg: str) -> None:
        self.flush_state("scanning", msg)

    def run(self) -> dict[str, Any]:
        self.flush_state("scanning", "正在初始化蓝牙同步窗口（请拿起或轻按牙刷亮灯）…")
        install_signal_handlers(self._on_signal_stop)

        self.overall_timer_id = GLib.timeout_add(int(max(3.0, self.timeout_sec) * 1000), self.on_overall_timeout)
        self.install_receivers()
        self.begin_scan()
        try:
            self.loop.run()
        finally:
            if not self.finished:
                self.cleanup_ble()
        return self.result

    def on_overall_timeout(self) -> bool:
        self.overall_timer_id = None
        if self.attempt_errors:
            self.finish_error(f"连接牙刷超时（共尝试 {self.connect_attempts} 次，最近错误: {self.attempt_errors[-1]}）")
        elif self.device_snapshot and not self.services_handled:
            self.finish_error("已发现牙刷但连接未完成，请确认牙刷电量充足且手机 App 未占线后重试")
        else:
            self.finish_error("等待超时：未检测到唤醒中的徕芬牙刷（请拿起或轻按牙刷亮灯，并确认手机 App 未占用连接）")
        return False

    def on_connect_exhausted(self, last_err: str) -> None:
        self.finish_error(f"蓝牙连接失败（已重试 {self.connect_attempts} 次）: {last_err}")

    def on_device_disconnected(self) -> None:
        if self.cycling_notify or self.phase == "finishing":
            return
        if not self.services_handled:
            self._handle_connect_failure("蓝牙连接未完成服务解析即断开")
            return
        if self.phase in ("waiting_status", "writing"):
            self.finish_error("牙刷在指令执行期间意外断开连接，请轻按唤醒后重试")
        elif self.phase == "refreshing_status":
            self._finish_write_ok()

    def on_notify_started(self) -> None:
        if self.stopping or self.finished:
            return
        if self.cycling_notify:
            self.cycling_notify = False
            self.cancel_timer("refresh_timer_id")
            self.refresh_timer_id = GLib.timeout_add(1500, self._on_cycle_refresh_timeout)
            return

        if self.mode == "sync":
            self.phase = "waiting_status"
            self.flush_state("monitoring", "已连接牙刷，正在读取电量与全档位状态…")
            if self.status_frames:
                self._schedule_sync_complete(0.25 if not self.info_frames else 0.02)
            else:
                self.cancel_timer("wait_timer_id")
                self.wait_timer_id = GLib.timeout_add(2500, self._on_wait_status_timeout)
        else:
            self.phase = "waiting_status"
            self.flush_state("monitoring", "已连接牙刷，正在写入并校验参数…")
            if self.status_frames:
                self._begin_write_pipeline()
            else:
                wait_ms = 2500 if self.patch else 1800
                self.cancel_timer("wait_timer_id")
                self.wait_timer_id = GLib.timeout_add(wait_ms, self._on_wait_status_timeout)

    def _schedule_sync_complete(self, delay_sec: float) -> None:
        self.cancel_timer("wait_timer_id")
        self.wait_timer_id = GLib.timeout_add(int(max(0.02, delay_sec) * 1000), self._complete_sync)

    def _complete_sync(self) -> bool:
        self.wait_timer_id = None
        if self.stopping or self.finished:
            return False
        if not self.status_frames:
            self.finish_error("已连接牙刷但未收到 FF02 状态通知帧")
            return False
        self.phase = "finishing"
        self.finish({
            "ok": True,
            "syncedAt": now_ms(),
            "device": self.device_snapshot,
            "statusHex": self.status_frames[-1].hex().upper(),
            "infoHex": self.info_frames[-1].hex().upper() if self.info_frames else None,
            "notifications": self.notifications,
        })
        return False

    def _on_wait_status_timeout(self) -> bool:
        self.wait_timer_id = None
        if self.stopping or self.finished:
            return False
        if self.mode == "sync":
            self.finish_error("已连接牙刷但未收到 FF02 状态通知帧")
            return False
        # write mode
        if self.patch:
            self.finish_error("已连接牙刷但未收到初始状态帧，无法安全合并参数写入")
            return False
        self._begin_write_pipeline()
        return False

    def on_ff02_packet(self, raw: bytes, _hex_str: str) -> None:
        if self.phase == "waiting_status":
            if self.mode == "sync":
                if is_status_frame(raw):
                    self._schedule_sync_complete(0.02 if self.info_frames else 0.25)
                elif is_info_frame(raw) and self.status_frames:
                    self._schedule_sync_complete(0.02)
            elif self.mode == "write" and is_status_frame(raw):
                self.cancel_timer("wait_timer_id")
                self._begin_write_pipeline()
        elif self.phase == "writing" and self.waiting_ack:
            self._check_pending_ack()
        elif self.phase == "refreshing_status" and is_status_frame(raw):
            if self.status_seq > self.seq_before_last:
                self.after_raw = raw
                self.cancel_timer("refresh_timer_id")
                self._finish_write_ok()

    def _begin_write_pipeline(self) -> None:
        if self.stopping or self.finished or self.phase == "writing":
            return
        self.baseline_raw = self.status_frames[-1] if self.status_frames else None
        if self.patch and self.baseline_raw is None:
            self.finish_error("已连接牙刷但未收到初始状态帧，无法安全合并参数写入")
            return

        dev_name = str((self.device_snapshot or {}).get("name") or "").upper()
        if self.baseline_raw and self.baseline_raw[0] == 0x5A:
            self.proto = "v2pro"
        elif self.baseline_raw and self.baseline_raw[0] == 0xAA:
            self.proto = "v1"
        elif "LFTB02" in dev_name:
            self.proto = "v2pro"
        else:
            self.proto = "v1"

        cmd_items = build_commands_from_patch(self.proto, self.patch, self.baseline_raw)
        for idx, item in enumerate(self.raw_hex_list):
            raw_bytes = bytes.fromhex(str(item).strip())
            if raw_bytes:
                cmd_items.append({"bytes": raw_bytes, "label": f"raw_{idx}", "delayAfter": 0.05})

        if not cmd_items:
            self.finish_error("未生成任何有效写入指令")
            return

        self.cmd_queue = cmd_items
        self.cmd_index = 0
        self.phase = "writing"
        self._send_next_command()

    def _send_next_command(self) -> bool:
        self.write_delay_timer_id = None
        if self.stopping or self.finished:
            return False
        if self.cmd_index >= len(self.cmd_queue):
            self._on_all_writes_done()
            return False

        item = self.cmd_queue[self.cmd_index]
        cmd_bytes: bytes = item["bytes"]
        self.cmd_start_ack_idx = len(self.ack_frames)
        self.seq_before_last = self.status_seq
        self.waiting_ack = True

        try:
            c_iface = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.ff02_path), GATT_CHAR_IFACE)
            arr = dbus.Array([dbus.Byte(b) for b in cmd_bytes], signature="y")
            opts = dbus.Dictionary({"type": dbus.String("request")}, signature="sv")
            c_iface.WriteValue(
                arr,
                opts,
                reply_handler=self._on_write_dbus_ok,
                error_handler=lambda e: self._on_write_dbus_err(str(e)),
                timeout=6,
            )
        except Exception as exc:
            self._on_write_dbus_err(str(exc))
        return False

    def _on_write_dbus_ok(self) -> None:
        if self.stopping or self.finished or self.phase != "writing":
            return
        if not self._check_pending_ack():
            self.cancel_timer("ack_timer_id")
            self.ack_timer_id = GLib.timeout_add(1200, self._on_ack_timeout)

    def _on_write_dbus_err(self, err_msg: str) -> None:
        if self.stopping or self.finished:
            return
        self.waiting_ack = False
        item = self.cmd_queue[self.cmd_index] if self.cmd_index < len(self.cmd_queue) else {"label": "unknown"}
        self.finish_error(f"写入指令 {item['label']} 失败: {err_msg}")

    def _check_pending_ack(self) -> bool:
        if not self.waiting_ack or self.cmd_index >= len(self.cmd_queue):
            return False
        item = self.cmd_queue[self.cmd_index]
        cmd_bytes: bytes = item["bytes"]
        expected_cmd = cmd_bytes[1] if len(cmd_bytes) >= 2 else -1
        matched = [
            a for a in self.ack_frames[self.cmd_start_ack_idx:]
            if a["proto"] == "v2pro" or a["cmdByte"] == expected_cmd
        ]
        if not matched:
            return False

        self.waiting_ack = False
        self.cancel_timer("ack_timer_id")
        ack = matched[0]
        if ack["statusByte"] != 0x00:
            self.finish_error(f"指令 {item['label']} 返回错误状态码: {ack['hex']}")
            return True

        self.tx_log.append({
            "label": item["label"],
            "txHex": cmd_bytes.hex().upper(),
            "ack": ack,
        })
        self.cmd_index += 1
        delay_sec = float(item.get("delayAfter", 0))
        if delay_sec > 0 and self.cmd_index < len(self.cmd_queue):
            self.cancel_timer("write_delay_timer_id")
            self.write_delay_timer_id = GLib.timeout_add(int(delay_sec * 1000), self._send_next_command)
        else:
            self._send_next_command()
        return True

    def _on_ack_timeout(self) -> bool:
        self.ack_timer_id = None
        if self.stopping or self.finished or not self.waiting_ack:
            return False
        item = self.cmd_queue[self.cmd_index]
        self.waiting_ack = False
        self.finish_error(f"指令 {item['label']} ({item['bytes'].hex().upper()}) 未收到牙刷应答")
        return False

    def _on_all_writes_done(self) -> None:
        self.phase = "refreshing_status"
        if self.status_seq > self.seq_before_last and self.status_frames:
            self.after_raw = self.status_frames[-1]
            self._finish_write_ok()
            return
        if not self.refresh_status:
            self.cancel_timer("refresh_timer_id")
            self.refresh_timer_id = GLib.timeout_add(300, lambda: (setattr(self, "refresh_timer_id", None), self._finish_write_ok(), False)[2])
            return
        self.cancel_timer("refresh_timer_id")
        self.refresh_timer_id = GLib.timeout_add(450, self._on_spontaneous_refresh_timeout)

    def _on_spontaneous_refresh_timeout(self) -> bool:
        self.refresh_timer_id = None
        if self.stopping or self.finished:
            return False
        if self.status_seq > self.seq_before_last and self.status_frames:
            self.after_raw = self.status_frames[-1]
            self._finish_write_ok()
            return False
        if not self.connected or not self.ff02_path:
            self._finish_write_ok()
            return False
        # Cycle StopNotify -> 150ms -> StartNotify to trigger fresh AA0A dump
        self.cycling_notify = True
        try:
            dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.ff02_path), GATT_CHAR_IFACE).StopNotify(
                reply_handler=self._on_cycle_stop_done,
                error_handler=lambda _e: self._on_cycle_stop_done(),
                timeout=4,
            )
        except Exception:
            self._on_cycle_stop_done()
        return False

    def _on_cycle_stop_done(self) -> None:
        if self.stopping or self.finished:
            return
        self.cancel_timer("cycle_timer_id")
        self.cycle_timer_id = GLib.timeout_add(150, self._on_cycle_start_notify)

    def _on_cycle_start_notify(self) -> bool:
        self.cycle_timer_id = None
        if self.stopping or self.finished or not self.connected or not self.ff02_path:
            self.cycling_notify = False
            self._finish_write_ok()
            return False
        try:
            dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.ff02_path), GATT_CHAR_IFACE).StartNotify(
                reply_handler=lambda: self.on_notify_started(),
                error_handler=lambda _e: self._finish_write_ok(),
                timeout=6,
            )
        except Exception:
            self._finish_write_ok()
        return False

    def _on_cycle_refresh_timeout(self) -> bool:
        self.refresh_timer_id = None
        if self.status_seq > self.seq_before_last and self.status_frames:
            self.after_raw = self.status_frames[-1]
        self._finish_write_ok()
        return False

    def _finish_write_ok(self) -> None:
        if self.stopping or self.finished:
            return
        self.phase = "finishing"
        self.finish({
            "ok": True,
            "writtenAt": now_ms(),
            "protocol": self.proto,
            "device": self.device_snapshot,
            "baselineHex": self.baseline_raw.hex().upper() if self.baseline_raw else None,
            "afterHex": self.after_raw.hex().upper() if self.after_raw else None,
            "infoHex": self.info_frames[-1].hex().upper() if self.info_frames else None,
            "txLog": self.tx_log,
            "ackLog": self.ack_frames,
        })


class MonitorSession(BaseBleSession):
    """Long-running background monitor for brushing telemetry and habit check-in."""

    def __init__(self, args: argparse.Namespace) -> None:
        super().__init__(
            target_mac=args.target_mac,
            name_prefix=args.name_prefix,
            adapter_name=args.adapter,
            timeout_sec=float(args.timeout),
            max_attempts=0,  # Retry until overall monitor deadline
            has_deadline=True,
            allow_warm_cache=True,
        )
        self.args = args
        self.state_file = args.state_file
        self.connected_at: int | None = None
        self.running_started_at: int | None = None
        self.last_running = False
        self.over_pressure_events = 0
        self.over_pressure_active = False

        self.first_status_hex: str | None = None
        self.latest_status_hex: str | None = None
        self.info_hex: str | None = None
        self.grace_timer_id: int | None = None

        self.session_id = getattr(args, "session_id", "") or f"brush-{self.started_at}"
        self.state: dict[str, Any] = {
            "sessionId": self.session_id,
            "pid": os.getpid(),
            "phase": "scanning",
            "startedAt": self.started_at,
            "updatedAt": self.started_at,
            "timeoutSec": float(args.timeout),
            "message": "正在扫描并等待徕芬牙刷唤醒…",
            "adapter": {
                "path": self.adapter_path,
                "address": str(self.adapter_props.get("Address") or "").upper(),
            },
            "device": None,
            "firstStatusHex": None,
            "latestStatusHex": None,
            "infoHex": None,
            "runningStartedAt": None,
            "activeBrushingSec": 0,
            "overPressureEvents": 0,
            "notifications": self.notifications,
            "error": None,
        }

    def cancel_all_timers(self) -> None:
        super().cancel_all_timers()
        self.cancel_timer("grace_timer_id")

    def flush(self) -> None:
        self.state["device"] = self.device_snapshot
        self.state["updatedAt"] = now_ms()
        self.state["firstStatusHex"] = self.first_status_hex
        self.state["latestStatusHex"] = self.latest_status_hex
        self.state["infoHex"] = self.info_hex
        self.state["runningStartedAt"] = self.running_started_at
        self.state["overPressureEvents"] = self.over_pressure_events
        if self.running_started_at is not None and self.last_running:
            self.state["activeBrushingSec"] = max(
                int(self.state.get("activeBrushingSec") or 0),
                int((now_ms() - self.running_started_at) / 1000),
            )
        atomic_write_json(self.state_file, self.state)

    def finish(self, phase: str, message: str, error: str | None = None) -> None:
        if self.finished:
            return
        self.finished = True
        self.stopping = True
        self.state["phase"] = phase
        self.state["message"] = message
        self.state["error"] = error
        self.cleanup_ble()
        self.flush()
        self.loop.quit()

    def on_overall_timeout(self) -> bool:
        self.overall_timer_id = None
        if self.latest_status_hex:
            self.finish("completed", "刷牙监听窗口结束，已保存最新牙刷状态与刷牙时长")
        else:
            self.finish("timeout", "等待超时：未检测到唤醒中的徕芬牙刷，请确认蓝牙未被手机 App 占用", "监听等待超时")
        return False

    def on_scan_started(self) -> None:
        self.state["phase"] = "scanning"
        self.state["message"] = "正在扫描徕芬牙刷广播（请拿起或按亮牙刷）…"
        self.flush()

    def on_connecting_started(self, dev: dict[str, Any]) -> None:
        self.state["phase"] = "connecting"
        self.state["message"] = f"发现 {dev.get('name') or dev.get('address') or 'LFTB'}，正在建立 GATT 连接…"
        self.flush()

    def on_connected(self) -> None:
        self.connected_at = now_ms()

    def on_retry_scheduled(self, msg: str) -> None:
        self.state["phase"] = "scanning"
        self.state["message"] = msg
        self.flush()

    def on_device_disconnected(self) -> None:
        elapsed_ms = now_ms() - (self.connected_at or self.started_at)
        if self.latest_status_hex and (self.running_started_at is not None or elapsed_ms >= 10000):
            if self.running_started_at is not None and self.last_running:
                self.state["activeBrushingSec"] = max(
                    int(self.state.get("activeBrushingSec") or 0),
                    int((now_ms() - self.running_started_at) / 1000),
                )
            self.finish("completed", "牙刷已结束并断开连接，本次刷牙数据已同步")
        elif not self.services_handled:
            self._handle_connect_failure("蓝牙连接未完成即断开")
        else:
            self._handle_connect_failure("牙刷暂时休眠断开")

    def on_notify_started(self) -> None:
        self.state["phase"] = "monitoring"
        self.state["message"] = "已连接徕芬牙刷，正在实时监听刷牙状态…"
        self.flush()

    def _on_idle_grace(self) -> bool:
        self.grace_timer_id = None
        if not self.stopping and not self.finished and not self.last_running and self.latest_status_hex:
            self.finish("completed", "检测到本次刷牙结束，已自动记录")
        return False

    def on_ff02_packet(self, raw: bytes, hex_str: str) -> None:
        if is_info_frame(raw):
            self.info_hex = hex_str
        elif is_over_pressure_frame(raw):
            if not self.over_pressure_active:
                self.over_pressure_events += 1
            self.over_pressure_active = True
        elif len(raw) >= 10 and raw[0] == 0x5A and raw[1] == 0x82 and raw[2] == 0x0C:
            self.over_pressure_active = False

        if is_status_frame(raw):
            if self.first_status_hex is None:
                self.first_status_hex = hex_str
            self.latest_status_hex = hex_str
            running = parse_status_running(raw)
            if running is True:
                self.cancel_timer("grace_timer_id")
                if not self.last_running:
                    self.running_started_at = self.running_started_at or now_ms()
                self.last_running = True
                self.state["message"] = "正在刷牙中，实时追踪档位与时长…"
            elif running is False and self.last_running:
                self.last_running = False
                elapsed_sec = int((now_ms() - (self.running_started_at or now_ms())) / 1000)
                self.state["activeBrushingSec"] = max(int(self.state.get("activeBrushingSec") or 0), elapsed_sec)
                if elapsed_sec >= 10:
                    self.state["message"] = "检测到停止转动，正在收尾归档…"
                    self.cancel_timer("grace_timer_id")
                    self.grace_timer_id = GLib.timeout_add(1500, self._on_idle_grace)
        self.flush()

    def start(self) -> int:
        self.flush()
        install_signal_handlers(lambda: self.finish("stopped", "已手动停止刷牙监听"))

        self.overall_timer_id = GLib.timeout_add(int(max(10.0, float(self.args.timeout)) * 1000), self.on_overall_timeout)
        self.install_receivers()
        self.begin_scan()
        try:
            self.loop.run()
        finally:
            if not self.finished:
                self.cleanup_ble()
                self.flush()
        return 0


class WatchSession(BaseBleSession):
    """Persistent low-duty wake-up watcher that auto-syncs, flushes queued writes,
    tracks brushing sessions, and yields hci0 to manual actions or health-scale."""

    def __init__(self, args: argparse.Namespace) -> None:
        super().__init__(
            target_mac=args.target_mac,
            name_prefix=args.name_prefix,
            adapter_name=args.adapter,
            timeout_sec=3600.0,
            max_attempts=0,
            has_deadline=False,
            allow_warm_cache=False,
        )
        self.args = args
        self.state_file = args.state_file
        self.outbox_dir = args.outbox_dir
        self.pending_file = str(args.pending_file or "").strip()
        self.yield_lock_file = str(args.yield_lock_file or "").strip()
        self.peer_session_file = str(args.peer_session_file or "").strip()
        self.cooldown_sec = max(5.0, float(args.cooldown_sec))
        self.idle_hold_sec = max(2.0, float(args.idle_hold_sec))

        os.makedirs(self.outbox_dir, mode=0o700, exist_ok=True)
        self.outbox_seq = 0
        self.cycle_seq = 0
        self.cooldown_until = 0.0
        self.last_applied_patch_id: str | None = None
        self.last_flush_mono = 0.0
        self._last_flushed_sig: tuple[str, str] | None = None

        self.tick_timer_id: int | None = None
        self.idle_release_timer_id: int | None = None
        self.sync_emit_timer_id: int | None = None
        self.status_wait_timer_id: int | None = None
        self.grace_timer_id: int | None = None
        self.ack_timer_id: int | None = None
        self.write_delay_timer_id: int | None = None
        self.refresh_timer_id: int | None = None
        self.cycle_timer_id: int | None = None

        self.cycle_id = ""
        self.cycle_phase = "idle"
        self.cycle_first_status_hex: str | None = None
        self.cycle_latest_status_hex: str | None = None
        self.cycle_emitted_sync_hex: str | None = None
        self.cycle_info_hex: str | None = None
        self.cycle_sync_emitted = False
        self.cycle_session_emitted = False
        self.cycle_running_started_at: int | None = None
        self.cycle_last_running = False
        self.cycle_active_sec = 0
        self.cycle_over_pressure = 0
        self.cycle_over_pressure_active = False

        self.cycle_proto = "v1"
        self.cycle_baseline_raw: bytes | None = None
        self.cycle_after_raw: bytes | None = None
        self.cycle_pending_patch_id: str | None = None
        self.cycle_applied_patch_id: str | None = None
        self.cycle_cmd_queue: list[dict[str, Any]] = []
        self.cycle_cmd_index = 0
        self.cycle_cmd_start_ack_idx = 0
        self.cycle_seq_before_last = 0
        self.cycle_waiting_ack = False
        self.cycle_cycling_notify = False

        self.state: dict[str, Any] = {
            "pid": os.getpid(),
            "phase": "watching",
            "startedAt": self.started_at,
            "updatedAt": self.started_at,
            "message": "后台自动唤醒监听启动中…",
            "adapter": {
                "path": self.adapter_path,
                "address": str(self.adapter_props.get("Address") or "").upper(),
            },
            "device": None,
            "lastSyncedAt": None,
            "lastStatusHex": None,
            "lastEventKind": None,
            "activeBrushingSec": 0,
            "error": None,
        }

    def cancel_cycle_timers(self) -> None:
        for attr in (
            "scan_rsp_timer_id",
            "settle_timer_id",
            "connect_timer_id",
            "resolve_timer_id",
            "retry_timer_id",
            "idle_release_timer_id",
            "sync_emit_timer_id",
            "status_wait_timer_id",
            "grace_timer_id",
            "ack_timer_id",
            "write_delay_timer_id",
            "refresh_timer_id",
            "cycle_timer_id",
        ):
            self.cancel_timer(attr)

    def cancel_all_timers(self) -> None:
        super().cancel_all_timers()
        self.cancel_cycle_timers()
        self.cancel_timer("tick_timer_id")

    def flush(self, force: bool = False) -> None:
        phase = str(self.state.get("phase") or "")
        msg = str(self.state.get("message") or "")
        sig = (phase, msg)
        now_mono = time.monotonic()
        if not force and sig == self._last_flushed_sig and (now_mono - self.last_flush_mono) < 10.0:
            return
        self._last_flushed_sig = sig
        self.last_flush_mono = now_mono
        self.state["device"] = self.device_snapshot
        self.state["updatedAt"] = now_ms()
        self.state["activeBrushingSec"] = self.cycle_active_sec
        try:
            atomic_write_json(self.state_file, self.state)
        except Exception:
            pass

    def finish(self, phase: str, message: str, error: str | None = None) -> None:
        if self.finished:
            return
        self.finished = True
        self.stopping = True
        self.state["phase"] = phase
        self.state["message"] = message
        self.state["error"] = error
        self.cleanup_ble()
        self.flush(force=True)
        self.loop.quit()

    def _read_pending_patch(self) -> dict[str, Any] | None:
        if not self.pending_file or not os.path.exists(self.pending_file):
            return None
        try:
            with open(self.pending_file, "r", encoding="utf-8") as fh:
                raw = json.load(fh)
            if isinstance(raw, dict) and isinstance(raw.get("patch"), dict) and raw["patch"] and raw.get("patchId"):
                return raw
        except Exception:
            pass
        return None

    def _consume_pending_patch_if_matches(self, patch_id: str | None) -> None:
        if not patch_id or not self.pending_file:
            return
        cur = self._read_pending_patch()
        if cur and str(cur.get("patchId") or "") == str(patch_id):
            try:
                os.unlink(self.pending_file)
            except OSError:
                pass

    def _is_manual_lock_active(self) -> bool:
        if not self.yield_lock_file or not os.path.exists(self.yield_lock_file):
            return False
        try:
            st = os.stat(self.yield_lock_file)
            return (time.time() - st.st_mtime) < 90.0
        except OSError:
            return False

    def _is_active_session_file(self, path: str, max_age_sec: float, active_phases: tuple[str, ...]) -> bool:
        if not path or not os.path.exists(path):
            return False
        try:
            st = os.stat(path)
            if (time.time() - st.st_mtime) >= max_age_sec:
                return False
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return isinstance(data, dict) and data.get("phase") in active_phases
        except Exception:
            return False

    def _is_peer_ble_lock_active(self) -> bool:
        if not self.state_file:
            return False
        plugins_root = os.path.dirname(os.path.dirname(os.path.abspath(self.state_file)))
        netlea_lock = os.path.join(plugins_root, "netlea", "ble-active.lock")
        if not os.path.exists(netlea_lock):
            return False
        try:
            st = os.stat(netlea_lock)
            return (time.time() - st.st_mtime) < 40.0
        except OSError:
            return False

    def _check_yield(self) -> tuple[bool, str]:
        if self._is_manual_lock_active():
            return True, "等待手动操作完成"
        if self.state_file:
            own_live = os.path.join(os.path.dirname(os.path.abspath(self.state_file)), "live-session.json")
            if self._is_active_session_file(own_live, 200.0, ("scanning", "connecting", "monitoring")):
                return True, "等待手动监听或同步完成"
        if self._is_active_session_file(self.peer_session_file, 90.0, ("scanning", "connecting", "measuring")):
            return True, "体脂秤测量中，蓝牙礼让"
        if self._is_peer_ble_lock_active():
            return True, "水草灯蓝牙通讯中，蓝牙礼让"
        return False, ""

    def can_accept_candidate(self) -> bool:
        if self.stopping or self.finished:
            return False
        if time.monotonic() < self.cooldown_until:
            return False
        yielding, _ = self._check_yield()
        return not yielding

    def _remove_disconnected_unpaired_matches(self) -> dict[str, Any] | None:
        objs = get_managed_objects(self.bus)
        for path, ifaces in objs.items():
            if DEVICE_IFACE not in ifaces:
                continue
            dev = serialize_device(str(path), dict(ifaces[DEVICE_IFACE]))
            if not matches_laifen(dev, self.target_mac, self.name_prefix):
                continue
            if dev["connected"]:
                return dev
            if not dev["paired"]:
                try:
                    self.adapter.RemoveDevice(dbus.ObjectPath(str(path)))
                except Exception:
                    pass
        return None

    def _reset_cycle_state(self) -> None:
        self.cycle_seq += 1
        self.cycle_id = f"w-{self.started_at}-{self.cycle_seq}"
        self.cycle_phase = "idle"
        self.cycle_first_status_hex = None
        self.cycle_latest_status_hex = None
        self.cycle_emitted_sync_hex = None
        self.cycle_info_hex = None
        self.cycle_sync_emitted = False
        self.cycle_session_emitted = False
        self.cycle_running_started_at = None
        self.cycle_last_running = False
        self.cycle_active_sec = 0
        self.cycle_over_pressure = 0
        self.cycle_over_pressure_active = False
        self.cycle_proto = "v1"
        self.cycle_baseline_raw = None
        self.cycle_after_raw = None
        self.cycle_pending_patch_id = None
        self.cycle_applied_patch_id = None
        self.cycle_cmd_queue = []
        self.cycle_cmd_index = 0
        self.cycle_cmd_start_ack_idx = 0
        self.cycle_seq_before_last = 0
        self.cycle_waiting_ack = False
        self.cycle_cycling_notify = False

        self.notifications.clear()
        self.status_frames.clear()
        self.info_frames.clear()
        self.ack_frames.clear()
        self.status_seq = 0

    def _emit_outbox_event(self, kind: str) -> None:
        if not self.cycle_latest_status_hex:
            return
        self.outbox_seq += 1
        ts = now_ms()
        ev_id = f"ev-{ts}-{os.getpid()}-{self.outbox_seq:04d}"
        payload = {
            "eventId": ev_id,
            "kind": kind,
            "at": ts,
            "device": self.device_snapshot,
            "firstStatusHex": self.cycle_first_status_hex,
            "latestStatusHex": self.cycle_latest_status_hex,
            "infoHex": self.cycle_info_hex,
            "appliedPatchId": self.cycle_applied_patch_id,
            "runningStartedAt": self.cycle_running_started_at,
            "activeBrushingSec": self.cycle_active_sec,
            "overPressureEvents": self.cycle_over_pressure,
            "dedupKey": f"watch:{self.cycle_id}" if kind == "session" else None,
        }
        try:
            atomic_write_json(os.path.join(self.outbox_dir, f"{ev_id}.json"), payload)
            entries = sorted(f for f in os.listdir(self.outbox_dir) if f.startswith("ev-") and f.endswith(".json"))
            for old in entries[:-60]:
                try:
                    os.unlink(os.path.join(self.outbox_dir, old))
                except OSError:
                    pass
        except Exception:
            pass
        self.state["lastSyncedAt"] = ts
        self.state["lastStatusHex"] = self.cycle_latest_status_hex
        self.state["lastEventKind"] = kind
        if kind == "sync":
            self.cycle_emitted_sync_hex = self.cycle_latest_status_hex

    def _disconnect_and_cooldown(self, cooldown_sec: float, phase: str, msg: str) -> None:
        self.cancel_cycle_timers()
        safe_stop_discovery(self.adapter)
        self.discovery_active = False
        if self.ff02_path:
            try:
                dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.ff02_path), GATT_CHAR_IFACE).StopNotify(timeout=2)
            except Exception:
                pass
        self.notify_active = False
        if self.device_path:
            try:
                dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.device_path), DEVICE_IFACE).Disconnect()
            except Exception:
                pass
        self.device_path = None
        self.ff02_path = None
        self.gap_name_path = None
        self.connected = False
        self.connecting = False
        self.settling_match = False
        self.services_handled = False
        self.cooldown_until = time.monotonic() + max(0.0, cooldown_sec)
        self.state["phase"] = phase
        self.state["message"] = msg
        self.flush(force=True)

    def _abort_for_yield(self, reason: str) -> None:
        self._disconnect_and_cooldown(0.0, "yielding", f"蓝牙适配器礼让中（{reason}）…")

    def begin_scan(self) -> bool:
        self.retry_timer_id = None
        if self.stopping or self.finished:
            return False
        self.cancel_cycle_timers()
        self._reset_cycle_state()
        self.settling_match = False
        self.connecting = False
        self.services_handled = False
        self.device_path = None
        self.ff02_path = None
        self.gap_name_path = None
        if len(self.attempt_errors) > 10:
            self.attempt_errors = self.attempt_errors[-5:]

        yielding, reason = self._check_yield()
        if yielding:
            safe_stop_discovery(self.adapter)
            self.discovery_active = False
            self.state["phase"] = "yielding"
            self.state["message"] = f"蓝牙适配器礼让中（{reason}）…"
            self.flush()
            return False

        if time.monotonic() < self.cooldown_until:
            safe_stop_discovery(self.adapter)
            self.discovery_active = False
            rem = max(1, int((self.cooldown_until - time.monotonic()) + 0.999))
            self.state["phase"] = "cooldown"
            self.state["message"] = f"已完成唤醒同步，短连接已释放（冷却 {rem}s 后恢复监听）"
            self.flush()
            return False

        safe_stop_discovery(self.adapter)
        self.discovery_active = False
        already_connected = self._remove_disconnected_unpaired_matches()
        if already_connected:
            self.device_path = already_connected["path"]
            self.device_snapshot = already_connected
            self.connecting = True
            self.connected = True
            self.state["phase"] = "connecting"
            self.state["message"] = "检测到牙刷已连接，正在读取最新状态…"
            self.flush()
            if already_connected.get("servicesResolved"):
                self._on_services_resolved()
            else:
                self._on_connect_ok()
            return False

        self.state["phase"] = "watching"
        self.state["message"] = "后台自动唤醒监听中：拿起牙刷亮灯即自动同步电量与打卡"
        self.flush()
        safe_start_le_discovery(self.adapter, duplicate_data=False)
        self.discovery_active = True
        return False

    def _on_tick(self) -> bool:
        if self.stopping or self.finished:
            self.tick_timer_id = None
            return False

        pending = self._read_pending_patch()
        if pending and str(pending.get("patchId") or "") != self.last_applied_patch_id:
            if time.monotonic() < self.cooldown_until:
                self.cooldown_until = 0.0

        yielding, reason = self._check_yield()
        if self.connected or self.connecting or self.settling_match:
            if self._is_manual_lock_active() and self.cycle_phase != "brushing":
                self._abort_for_yield(reason or "等待手动操作")
            elif self.cycle_last_running and self.cycle_running_started_at is not None:
                self.cycle_active_sec = max(self.cycle_active_sec, int((now_ms() - self.cycle_running_started_at) / 1000))
                self.flush()
            return True

        if yielding:
            if self.discovery_active:
                safe_stop_discovery(self.adapter)
                self.discovery_active = False
            self.state["phase"] = "yielding"
            self.state["message"] = f"蓝牙适配器礼让中（{reason}）…"
            self.flush()
            return True

        if time.monotonic() < self.cooldown_until:
            if self.discovery_active:
                safe_stop_discovery(self.adapter)
                self.discovery_active = False
            rem = max(1, int((self.cooldown_until - time.monotonic()) + 0.999))
            self.state["phase"] = "cooldown"
            self.state["message"] = f"已完成唤醒同步，短连接已释放（冷却 {rem}s 后恢复监听）"
            self.flush()
            return True

        if not self.discovery_active:
            self.begin_scan()
        else:
            self.state["phase"] = "watching"
            self.state["message"] = "后台自动唤醒监听中：拿起牙刷亮灯即自动同步电量与打卡"
            self.flush()
        return True

    def on_scan_started(self) -> None:
        self.state["phase"] = "watching"
        self.state["message"] = "后台自动唤醒监听中：拿起牙刷亮灯即自动同步电量与打卡"
        self.flush()

    def on_connecting_started(self, dev: dict[str, Any]) -> None:
        self.discovery_active = False
        self._reset_cycle_state()
        rssi = dev.get("rssi")
        rssi_txt = f" (RSSI {rssi} dBm)" if rssi is not None else ""
        self.state["phase"] = "connecting"
        self.state["message"] = f"检测到牙刷唤醒 {dev.get('name') or dev.get('address') or 'LFTB'}{rssi_txt}，正在快速同步…"
        self.flush(force=True)

    def on_retry_scheduled(self, _msg: str) -> None:
        self.state["phase"] = "connecting"
        self.state["message"] = "牙刷广播未稳，正在快速重连…"
        self.flush()

    def on_notify_started(self) -> None:
        if self.stopping or self.finished:
            return
        if self.cycle_cycling_notify:
            self.cycle_cycling_notify = False
            self.cancel_timer("refresh_timer_id")
            self.refresh_timer_id = GLib.timeout_add(1500, self._on_watch_cycle_refresh_timeout)
            return
        self.cycle_phase = "waiting_status"
        self.state["phase"] = "syncing"
        self.state["message"] = "已连接牙刷，正在自动同步状态…"
        self.flush(force=True)
        self.cancel_timer("status_wait_timer_id")
        self.status_wait_timer_id = GLib.timeout_add(4500, self._on_watch_status_wait_timeout)

    def _on_watch_status_wait_timeout(self) -> bool:
        self.status_wait_timer_id = None
        if not self.stopping and not self.finished and not self.cycle_latest_status_hex:
            self._disconnect_and_cooldown(5.0, "watching", "已连接但未收到状态帧，已释放并继续监听")
        return False

    def _on_sync_emit_timer(self) -> bool:
        self.sync_emit_timer_id = None
        if not self.cycle_sync_emitted and self.cycle_latest_status_hex:
            self.cycle_sync_emitted = True
            self._emit_outbox_event("sync")
            if self.cycle_phase == "idle_hold":
                self.state["phase"] = "syncing"
                self.state["message"] = "已自动同步牙刷电量与状态，若未开启刷牙将在几秒内自动释放连接"
                self.flush(force=True)
        return False

    def _on_idle_release(self) -> bool:
        self.idle_release_timer_id = None
        if self.stopping or self.finished or self.cycle_last_running:
            return False
        if not self.cycle_sync_emitted or (
            self.cycle_latest_status_hex and self.cycle_latest_status_hex != self.cycle_emitted_sync_hex
        ):
            self.cycle_sync_emitted = True
            self._emit_outbox_event("sync")
        self._disconnect_and_cooldown(
            self.cooldown_sec,
            "cooldown",
            f"已完成唤醒同步，短连接已释放（冷却 {int(self.cooldown_sec)}s 后恢复监听）",
        )
        return False

    def _on_brushing_idle_grace(self) -> bool:
        self.grace_timer_id = None
        if self.stopping or self.finished or self.cycle_last_running:
            return False
        self._complete_brushing_cycle()
        return False

    def _complete_brushing_cycle(self) -> None:
        if self.cycle_running_started_at is not None:
            elapsed = int((now_ms() - self.cycle_running_started_at) / 1000)
            self.cycle_active_sec = max(self.cycle_active_sec, elapsed)
        if self.cycle_active_sec >= 10 and not self.cycle_session_emitted and self.cycle_latest_status_hex:
            self.cycle_session_emitted = True
            self._emit_outbox_event("session")
            self._disconnect_and_cooldown(25.0, "cooldown", "检测到本次刷牙结束并已自动打卡，连接已释放")
        else:
            if not self.cycle_sync_emitted and self.cycle_latest_status_hex:
                self.cycle_sync_emitted = True
                self._emit_outbox_event("sync")
            self._disconnect_and_cooldown(self.cooldown_sec, "cooldown", "已完成唤醒同步，短连接已释放")

    def on_device_disconnected(self) -> None:
        if self.cycle_cycling_notify or self.stopping or self.finished:
            return
        if not self.services_handled:
            self._handle_connect_failure("蓝牙连接未完成服务解析即断开")
            return
        self.cancel_cycle_timers()
        if self.cycle_phase == "refreshing_pending":
            self._finish_pending_write_ok()
            return
        if self.cycle_phase == "brushing" or (
            self.cycle_running_started_at is not None and self.cycle_active_sec >= 10
        ):
            self._complete_brushing_cycle()
            return
        if self.cycle_latest_status_hex and not self.cycle_sync_emitted:
            self.cycle_sync_emitted = True
            self._emit_outbox_event("sync")
        self._disconnect_and_cooldown(
            self.cooldown_sec if self.cycle_sync_emitted else 3.0,
            "cooldown" if self.cycle_sync_emitted else "watching",
            "牙刷已休眠断开，已保存最新状态" if self.cycle_sync_emitted else "牙刷已断开，继续监听唤醒",
        )

    def _start_pending_write(self, baseline_raw: bytes, pending: dict[str, Any]) -> bool:
        dev_name = str((self.device_snapshot or {}).get("name") or "").upper()
        if baseline_raw[0] == 0x5A:
            self.cycle_proto = "v2pro"
        elif baseline_raw[0] == 0xAA:
            self.cycle_proto = "v1"
        elif "LFTB02" in dev_name:
            self.cycle_proto = "v2pro"
        else:
            self.cycle_proto = "v1"

        patch = pending.get("patch") if isinstance(pending.get("patch"), dict) else {}
        cmd_items = build_commands_from_patch(self.cycle_proto, patch, baseline_raw)
        patch_id = str(pending.get("patchId") or "")
        if not cmd_items:
            self._consume_pending_patch_if_matches(patch_id)
            self.last_applied_patch_id = patch_id
            return False

        self.cycle_phase = "writing_pending"
        self.cycle_baseline_raw = baseline_raw
        self.cycle_pending_patch_id = patch_id
        self.cycle_cmd_queue = cmd_items
        self.cycle_cmd_index = 0
        self.state["phase"] = "syncing"
        self.state["message"] = "牙刷已唤醒，正在自动下发暂存的参数配置…"
        self.flush(force=True)
        self._send_next_pending_command()
        return True

    def _send_next_pending_command(self) -> bool:
        self.write_delay_timer_id = None
        if self.stopping or self.finished or not self.connected or not self.ff02_path:
            return False
        if self.cycle_cmd_index >= len(self.cycle_cmd_queue):
            self._on_pending_writes_done()
            return False

        item = self.cycle_cmd_queue[self.cycle_cmd_index]
        cmd_bytes: bytes = item["bytes"]
        self.cycle_cmd_start_ack_idx = len(self.ack_frames)
        self.cycle_seq_before_last = self.status_seq
        self.cycle_waiting_ack = True
        try:
            c_iface = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.ff02_path), GATT_CHAR_IFACE)
            arr = dbus.Array([dbus.Byte(b) for b in cmd_bytes], signature="y")
            opts = dbus.Dictionary({"type": dbus.String("request")}, signature="sv")
            c_iface.WriteValue(
                arr,
                opts,
                reply_handler=self._on_pending_write_dbus_ok,
                error_handler=lambda e: self._on_pending_write_failed(str(e)),
                timeout=6,
            )
        except Exception as exc:
            self._on_pending_write_failed(str(exc))
        return False

    def _on_pending_write_dbus_ok(self) -> None:
        if self.stopping or self.finished or self.cycle_phase != "writing_pending":
            return
        if not self._check_pending_write_ack():
            self.cancel_timer("ack_timer_id")
            self.ack_timer_id = GLib.timeout_add(1200, lambda: (self._on_pending_write_failed("写入应答超时"), False)[1])

    def _check_pending_write_ack(self) -> bool:
        if not self.cycle_waiting_ack or self.cycle_cmd_index >= len(self.cycle_cmd_queue):
            return False
        item = self.cycle_cmd_queue[self.cycle_cmd_index]
        cmd_bytes: bytes = item["bytes"]
        expected_cmd = cmd_bytes[1] if len(cmd_bytes) >= 2 else -1
        matched = [
            a for a in self.ack_frames[self.cycle_cmd_start_ack_idx:]
            if a["proto"] == "v2pro" or a["cmdByte"] == expected_cmd
        ]
        if not matched:
            return False

        self.cycle_waiting_ack = False
        self.cancel_timer("ack_timer_id")
        ack = matched[0]
        if ack["statusByte"] != 0x00:
            self._on_pending_write_failed(f"指令返回错误码 {ack['hex']}")
            return True

        self.cycle_cmd_index += 1
        delay_sec = float(item.get("delayAfter", 0))
        if delay_sec > 0 and self.cycle_cmd_index < len(self.cycle_cmd_queue):
            self.cancel_timer("write_delay_timer_id")
            self.write_delay_timer_id = GLib.timeout_add(int(delay_sec * 1000), self._send_next_pending_command)
        else:
            self._send_next_pending_command()
        return True

    def _on_pending_write_failed(self, err_msg: str) -> None:
        self.cycle_waiting_ack = False
        self.cancel_timer("ack_timer_id")
        self.state["error"] = f"暂存参数下发未完成: {err_msg}"
        self._after_status_synced(parse_status_running(self.cycle_baseline_raw) if self.cycle_baseline_raw else False)

    def _on_pending_writes_done(self) -> None:
        self.cycle_phase = "refreshing_pending"
        if self.status_seq > self.cycle_seq_before_last and self.status_frames:
            self.cycle_after_raw = self.status_frames[-1]
            self.cycle_latest_status_hex = self.cycle_after_raw.hex().upper()
            self._finish_pending_write_ok()
            return
        self.cancel_timer("refresh_timer_id")
        self.refresh_timer_id = GLib.timeout_add(450, self._on_watch_spontaneous_refresh_timeout)

    def _on_watch_spontaneous_refresh_timeout(self) -> bool:
        self.refresh_timer_id = None
        if self.stopping or self.finished:
            return False
        if self.status_seq > self.cycle_seq_before_last and self.status_frames:
            self.cycle_after_raw = self.status_frames[-1]
            self.cycle_latest_status_hex = self.cycle_after_raw.hex().upper()
            self._finish_pending_write_ok()
            return False
        if not self.connected or not self.ff02_path:
            self._finish_pending_write_ok()
            return False
        self.cycle_cycling_notify = True
        try:
            dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.ff02_path), GATT_CHAR_IFACE).StopNotify(
                reply_handler=self._on_watch_cycle_stop_done,
                error_handler=lambda _e: self._on_watch_cycle_stop_done(),
                timeout=4,
            )
        except Exception:
            self._on_watch_cycle_stop_done()
        return False

    def _on_watch_cycle_stop_done(self) -> None:
        if self.stopping or self.finished:
            return
        self.cancel_timer("cycle_timer_id")
        self.cycle_timer_id = GLib.timeout_add(150, self._on_watch_cycle_start_notify)

    def _on_watch_cycle_start_notify(self) -> bool:
        self.cycle_timer_id = None
        if self.stopping or self.finished or not self.connected or not self.ff02_path:
            self.cycle_cycling_notify = False
            self._finish_pending_write_ok()
            return False
        def _on_cycle_start_err(_err: Any) -> None:
            self.cycle_cycling_notify = False
            self._finish_pending_write_ok()
        try:
            dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.ff02_path), GATT_CHAR_IFACE).StartNotify(
                reply_handler=lambda: self.on_notify_started(),
                error_handler=_on_cycle_start_err,
                timeout=6,
            )
        except Exception:
            self.cycle_cycling_notify = False
            self._finish_pending_write_ok()
        return False

    def _on_watch_cycle_refresh_timeout(self) -> bool:
        self.refresh_timer_id = None
        if self.status_seq > self.cycle_seq_before_last and self.status_frames:
            self.cycle_after_raw = self.status_frames[-1]
            self.cycle_latest_status_hex = self.cycle_after_raw.hex().upper()
        self._finish_pending_write_ok()
        return False

    def _finish_pending_write_ok(self) -> None:
        self.cycle_cycling_notify = False
        patch_id = self.cycle_pending_patch_id
        self.cycle_applied_patch_id = patch_id
        self.last_applied_patch_id = patch_id
        self._consume_pending_patch_if_matches(patch_id)
        self.cycle_sync_emitted = True
        self._emit_outbox_event("sync")
        self.state["error"] = None
        if not self.connected:
            self._disconnect_and_cooldown(self.cooldown_sec, "cooldown", "已完成暂存参数同步，短连接已释放")
            return
        ref_raw = self.cycle_after_raw or self.cycle_baseline_raw
        self._after_status_synced(parse_status_running(ref_raw) if ref_raw else False, just_wrote=True)

    def _after_status_synced(self, running: bool | None, just_wrote: bool = False) -> None:
        if running is True:
            self.cancel_timer("idle_release_timer_id")
            self.cancel_timer("sync_emit_timer_id")
            if not self.cycle_last_running:
                self.cycle_running_started_at = self.cycle_running_started_at or now_ms()
            self.cycle_last_running = True
            self.cycle_phase = "brushing"
            self.state["phase"] = "brushing"
            self.state["message"] = "检测到正在刷牙，实时记录刷牙时长与状态…"
            if not self.cycle_sync_emitted and self.cycle_latest_status_hex:
                self.cycle_sync_emitted = True
                self._emit_outbox_event("sync")
            self.flush(force=True)
            return

        self.cycle_phase = "idle_hold"
        if not self.cycle_sync_emitted and self.cycle_latest_status_hex:
            delay = 20 if self.cycle_info_hex else 200
            self.cancel_timer("sync_emit_timer_id")
            self.sync_emit_timer_id = GLib.timeout_add(delay, self._on_sync_emit_timer)
        self.state["phase"] = "syncing"
        self.state["message"] = (
            "已自动写入暂存参数并校验完成，短连接即将释放" if just_wrote
            else "已自动同步牙刷电量与状态，几秒内自动释放连接"
        )
        self.flush(force=True)
        self.cancel_timer("idle_release_timer_id")
        self.idle_release_timer_id = GLib.timeout_add(int(self.idle_hold_sec * 1000), self._on_idle_release)

    def on_ff02_packet(self, raw: bytes, hex_str: str) -> None:
        if is_info_frame(raw):
            self.cycle_info_hex = hex_str
            if (
                self.cycle_phase == "idle_hold"
                and not self.cycle_sync_emitted
                and self.cycle_latest_status_hex
            ):
                self.cancel_timer("sync_emit_timer_id")
                self.cycle_sync_emitted = True
                self._emit_outbox_event("sync")
            return

        if is_over_pressure_frame(raw):
            if not self.cycle_over_pressure_active:
                self.cycle_over_pressure += 1
            self.cycle_over_pressure_active = True
            return
        if len(raw) >= 10 and raw[0] == 0x5A and raw[1] == 0x82 and raw[2] == 0x0C:
            self.cycle_over_pressure_active = False
            return

        if self.cycle_phase == "writing_pending":
            if self.cycle_waiting_ack:
                self._check_pending_write_ack()
            return
        if self.cycle_phase == "refreshing_pending":
            if is_status_frame(raw) and self.status_seq > self.cycle_seq_before_last:
                self.cycle_after_raw = raw
                self.cycle_latest_status_hex = hex_str
                self.cancel_timer("refresh_timer_id")
                self._finish_pending_write_ok()
            return

        if not is_status_frame(raw):
            return

        self.cancel_timer("status_wait_timer_id")
        first_in_cycle = self.cycle_first_status_hex is None
        if first_in_cycle:
            self.cycle_first_status_hex = hex_str
        self.cycle_latest_status_hex = hex_str
        running = parse_status_running(raw)

        if first_in_cycle and self.cycle_phase == "waiting_status":
            pending = self._read_pending_patch()
            if pending and str(pending.get("patchId") or "") != self.last_applied_patch_id:
                if self._start_pending_write(raw, pending):
                    return
            self._after_status_synced(running)
            return

        if running is True:
            self.cancel_timer("idle_release_timer_id")
            self.cancel_timer("grace_timer_id")
            if not self.cycle_last_running:
                self.cycle_running_started_at = self.cycle_running_started_at or now_ms()
            self.cycle_last_running = True
            self.cycle_phase = "brushing"
            self.state["phase"] = "brushing"
            self.state["message"] = "检测到正在刷牙，实时记录刷牙时长与状态…"
            self.flush()
        elif running is False and self.cycle_last_running:
            self.cycle_last_running = False
            elapsed_sec = int((now_ms() - (self.cycle_running_started_at or now_ms())) / 1000)
            self.cycle_active_sec = max(self.cycle_active_sec, elapsed_sec)
            if elapsed_sec >= 10:
                self.state["message"] = "检测到刷牙结束，正在归档打卡…"
                self.flush(force=True)
                self.cancel_timer("grace_timer_id")
                self.grace_timer_id = GLib.timeout_add(1500, self._on_brushing_idle_grace)
            else:
                self._after_status_synced(False)

    def start(self) -> int:
        self.flush(force=True)
        install_signal_handlers(lambda: self.finish("stopped", "已停止后台自动唤醒监听"))
        self.install_receivers()
        self.tick_timer_id = GLib.timeout_add(1500, self._on_tick)
        self.begin_scan()
        try:
            self.loop.run()
        finally:
            if not self.finished:
                self.cleanup_ble()
                self.flush(force=True)
        return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Laifen BLE helper over BlueZ D-Bus")
    sub = parser.add_subparsers(dest="command", required=True)

    scan_p = sub.add_parser("scan")
    scan_p.add_argument("--timeout", type=float, default=5.0)
    scan_p.add_argument("--target-mac", default="")
    scan_p.add_argument("--name-prefix", default="LFTB")
    scan_p.add_argument("--adapter", default="")
    scan_p.add_argument("--stop-on-match", action="store_true")

    sync_p = sub.add_parser("sync")
    sync_p.add_argument("--timeout", type=float, default=25.0)
    sync_p.add_argument("--target-mac", default="")
    sync_p.add_argument("--name-prefix", default="LFTB")
    sync_p.add_argument("--adapter", default="")
    sync_p.add_argument("--state-file", default="")
    sync_p.add_argument("--session-id", default="")

    write_p = sub.add_parser("write")
    write_p.add_argument("--timeout", type=float, default=25.0)
    write_p.add_argument("--target-mac", default="")
    write_p.add_argument("--name-prefix", default="LFTB")
    write_p.add_argument("--adapter", default="")
    write_p.add_argument("--ops-json", required=True)
    write_p.add_argument("--state-file", default="")
    write_p.add_argument("--session-id", default="")

    mon_p = sub.add_parser("monitor")
    mon_p.add_argument("--state-file", required=True)
    mon_p.add_argument("--session-id", default="")
    mon_p.add_argument("--timeout", type=float, default=180.0)
    mon_p.add_argument("--target-mac", default="")
    mon_p.add_argument("--name-prefix", default="LFTB")
    mon_p.add_argument("--adapter", default="")

    watch_p = sub.add_parser("watch")
    watch_p.add_argument("--state-file", required=True)
    watch_p.add_argument("--outbox-dir", required=True)
    watch_p.add_argument("--pending-file", default="")
    watch_p.add_argument("--yield-lock-file", default="")
    watch_p.add_argument("--peer-session-file", default="")
    watch_p.add_argument("--target-mac", default="")
    watch_p.add_argument("--name-prefix", default="LFTB")
    watch_p.add_argument("--adapter", default="")
    watch_p.add_argument("--cooldown-sec", type=float, default=45.0)
    watch_p.add_argument("--idle-hold-sec", type=float, default=6.0)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)

    try:
        if args.command == "monitor":
            return MonitorSession(args).start()
        if args.command == "watch":
            return WatchSession(args).start()
        if args.command == "scan":
            res = run_scan(args)
        elif args.command == "sync":
            res = AsyncOneShotSession("sync", args).run()
        elif args.command == "write":
            ops = json.loads(args.ops_json)
            res = AsyncOneShotSession("write", args, ops).run()
        else:
            res = {"ok": False, "error": f"Unknown command: {args.command}"}
        print(json.dumps(res, ensure_ascii=False), flush=True)
        return 0 if res.get("ok") else 1
    except Exception as exc:
        if args.command in ("monitor", "watch") and getattr(args, "state_file", None):
            try:
                atomic_write_json(
                    args.state_file,
                    {
                        "sessionId": getattr(args, "session_id", "") or f"brush-{now_ms()}",
                        "pid": os.getpid(),
                        "phase": "error",
                        "startedAt": now_ms(),
                        "updatedAt": now_ms(),
                        "message": f"蓝牙监听初始化失败：{exc}",
                        "device": None,
                        "notifications": [],
                        "error": str(exc),
                    },
                )
            except Exception:
                pass
            return 1
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())

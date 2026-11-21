#!/usr/bin/env python3
"""BlueZ D-Bus helper for scanning and controlling Netlea BLE aquarium lights.

Uses system Python `dbus` + `gi.repository.GLib` with zero third-party pip deps.
Supports two subcommands:
  - scan: discover matching Netlea BLE light(s) and print JSON to stdout
  - command: short-lived GATT connection to 0xFFFA (notify 0xFF01, write 0xFF02),
             send one or more comma-separated 0x5A frames, capture 0x14/0x1A/0x12/ack frames,
             and disconnect immediately.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any

import dbus
import dbus.mainloop.glib
from gi.repository import GLib


BLUEZ_SERVICE = "org.bluez"
OBJECT_MANAGER_IFACE = "org.freedesktop.DBus.ObjectManager"
PROPERTIES_IFACE = "org.freedesktop.DBus.Properties"
ADAPTER_IFACE = "org.bluez.Adapter1"
DEVICE_IFACE = "org.bluez.Device1"
GATT_CHAR_IFACE = "org.bluez.GattCharacteristic1"

ADV_FAFF_UUID = "0000faff-0000-1000-8000-00805f9b34fb"
SERVICE_FFFA_UUID = "0000fffa-0000-1000-8000-00805f9b34fb"
NOTIFY_FF01_UUID = "0000ff01-0000-1000-8000-00805f9b34fb"
WRITE_FF02_UUID = "0000ff02-0000-1000-8000-00805f9b34fb"


def now_ms() -> int:
    return int(time.time() * 1000)


def serialize_device(path: str, props: dict[str, Any]) -> dict[str, Any]:
    raw_mfg = props.get("ManufacturerData") or {}
    mfg_out: dict[str, str] = {}
    for company_id, payload in raw_mfg.items():
        cid = int(company_id)
        data_bytes = bytes(int(b) & 0xFF for b in payload)
        mfg_out[f"0x{cid:04x}"] = data_bytes.hex().upper()

    raw_svc = props.get("ServiceData") or {}
    svc_out: dict[str, str] = {}
    for uuid_key, payload in raw_svc.items():
        data_bytes = bytes(int(b) & 0xFF for b in payload)
        svc_out[str(uuid_key).lower()] = data_bytes.hex().upper()

    uuids = [str(u).lower() for u in (props.get("UUIDs") or [])]
    name = str(props.get("Name") or props.get("Alias") or "")
    rssi = int(props["RSSI"]) if "RSSI" in props and props["RSSI"] is not None else None
    return {
        "path": str(path),
        "address": str(props.get("Address") or "").upper(),
        "name": name,
        "rssi": rssi,
        "uuids": uuids,
        "manufacturerData": mfg_out,
        "serviceData": svc_out,
        "connected": bool(props.get("Connected", False)),
        "paired": bool(props.get("Paired", False)),
        "servicesResolved": bool(props.get("ServicesResolved", False)),
    }


def matches_netlea(dev: dict[str, Any], target_mac: str, name_prefix: str) -> bool:
    norm_mac = (target_mac or "").strip().upper()
    addr = (dev.get("address") or "").upper()
    if norm_mac:
        return addr == norm_mac

    uuids = dev.get("uuids") or []
    if ADV_FAFF_UUID in uuids or SERVICE_FFFA_UUID in uuids:
        return True

    norm_prefix = (name_prefix or "").strip().upper()
    name = (dev.get("name") or "").upper()
    if norm_prefix and name.startswith(norm_prefix):
        return True
    if name.startswith("NETLEA"):
        return True
    return False


def get_managed_objects(bus: dbus.SystemBus) -> dict[str, dict[str, dict[str, Any]]]:
    manager = dbus.Interface(bus.get_object(BLUEZ_SERVICE, "/"), OBJECT_MANAGER_IFACE)
    return manager.GetManagedObjects()


def find_adapter(bus: dbus.SystemBus, preferred_adapter: str | None = None) -> tuple[str, dict[str, Any]]:
    objects = get_managed_objects(bus)
    adapters: list[tuple[str, dict[str, Any]]] = []
    for path, ifaces in objects.items():
        if ADAPTER_IFACE in ifaces:
            adapters.append((str(path), dict(ifaces[ADAPTER_IFACE])))
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
        prop_iface = dbus.Interface(bus.get_object(BLUEZ_SERVICE, adapter_path), PROPERTIES_IFACE)
        prop_iface.Set(ADAPTER_IFACE, "Powered", dbus.Boolean(True))


def safe_stop_discovery(adapter: dbus.Interface) -> None:
    try:
        adapter.StopDiscovery()
    except Exception:
        pass


def safe_start_le_discovery(adapter: dbus.Interface) -> None:
    for filt in (
        {"Transport": dbus.String("le"), "DuplicateData": dbus.Boolean(True)},
        {"Transport": dbus.String("le")},
    ):
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


def clear_stale_unpaired_devices(
    bus: dbus.SystemBus,
    adapter: dbus.Interface,
    target_mac: str,
    name_prefix: str,
) -> list[dict[str, Any]]:
    """Remove unpaired disconnected matching devices so fresh advertisements arrive."""
    connected_matches: list[dict[str, Any]] = []
    objects = get_managed_objects(bus)
    for path, ifaces in objects.items():
        if DEVICE_IFACE not in ifaces:
            continue
        dev = serialize_device(str(path), dict(ifaces[DEVICE_IFACE]))
        if not matches_netlea(dev, target_mac, name_prefix):
            continue
        if dev["connected"]:
            connected_matches.append(dev)
        elif not dev["paired"]:
            try:
                adapter.RemoveDevice(dbus.ObjectPath(str(path)))
            except Exception:
                pass
    return connected_matches


def merge_device_record(prev: dict[str, Any], dev: dict[str, Any]) -> dict[str, Any]:
    merged = {**prev}
    for key, val in dev.items():
        if key in ("manufacturerData", "serviceData") and isinstance(val, dict):
            existing_map = dict(prev.get(key) or {})
            existing_map.update(val)
            if existing_map:
                merged[key] = existing_map
        elif key == "uuids" and isinstance(val, list):
            merged_uuids = list(dict.fromkeys([*(prev.get("uuids") or []), *val]))
            merged[key] = merged_uuids
        elif val not in (None, "", [], {}):
            merged[key] = val
    merged["seenAt"] = now_ms()
    return merged


def discover_matching_devices(
    bus: dbus.SystemBus,
    adapter: dbus.Interface,
    target_mac: str,
    name_prefix: str,
    timeout_sec: float,
    *,
    prefer_mac: str = "",
    stop_early_for_target: bool = False,
) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    already_connected = clear_stale_unpaired_devices(bus, adapter, target_mac, name_prefix)
    for dev in already_connected:
        key = dev["address"] or dev["path"]
        found[key] = merge_device_record({}, dev)

    def record_device(path: str, props: dict[str, Any]) -> None:
        dev = serialize_device(path, props)
        if matches_netlea(dev, target_mac, name_prefix):
            key = dev["address"] or dev["path"]
            found[key] = merge_device_record(found.get(key, {}), dev)

    def on_interfaces_added(path: Any, interfaces: dict[str, Any]) -> None:
        if DEVICE_IFACE in interfaces:
            record_device(str(path), dict(interfaces[DEVICE_IFACE]))

    def on_properties_changed(
        interface: str, _changed: dict[str, Any], _invalidated: Any, path: str | None = None
    ) -> None:
        if interface != DEVICE_IFACE or not path:
            return
        try:
            prop_iface = dbus.Interface(bus.get_object(BLUEZ_SERVICE, path), PROPERTIES_IFACE)
            all_props = dict(prop_iface.GetAll(DEVICE_IFACE))
            record_device(str(path), all_props)
        except Exception:
            pass

    sig1 = bus.add_signal_receiver(
        on_interfaces_added,
        dbus_interface=OBJECT_MANAGER_IFACE,
        signal_name="InterfacesAdded",
        bus_name=BLUEZ_SERVICE,
    )
    sig2 = bus.add_signal_receiver(
        on_properties_changed,
        dbus_interface=PROPERTIES_IFACE,
        signal_name="PropertiesChanged",
        bus_name=BLUEZ_SERVICE,
        path_keyword="path",
    )

    safe_stop_discovery(adapter)
    safe_start_le_discovery(adapter)

    norm_target = (target_mac or "").strip().upper()
    norm_prefer = (prefer_mac or "").strip().upper()
    start_ts = time.monotonic()
    hard_deadline = start_ts + max(0.5, float(timeout_sec))
    first_match_ts: float | None = None
    if found:
        first_match_ts = start_ts

    ctx = GLib.MainContext.default()
    try:
        while True:
            while ctx.pending():
                ctx.iteration(False)

            now_ts = time.monotonic()
            if now_ts >= hard_deadline:
                break

            if found and first_match_ts is None:
                first_match_ts = now_ts

            if norm_target and norm_target in found:
                dev = found[norm_target]
                elapsed = now_ts - (first_match_ts or now_ts)
                if stop_early_for_target and (dev.get("manufacturerData") or elapsed >= 0.35):
                    break
                if elapsed >= 0.45 and dev.get("rssi") is not None and dev.get("manufacturerData"):
                    break
            elif not norm_target and found and first_match_ts is not None:
                if norm_prefer and norm_prefer in found:
                    pref_dev = found[norm_prefer]
                    if stop_early_for_target and (pref_dev.get("manufacturerData") or (now_ts - first_match_ts) >= 0.35):
                        break
                settle_window = 0.8 if stop_early_for_target else min(float(timeout_sec), 2.5)
                if (now_ts - first_match_ts) >= settle_window:
                    break

            time.sleep(0.03)
    finally:
        sig1.remove()
        sig2.remove()
        safe_stop_discovery(adapter)

    return found


def pick_best_device(devices: dict[str, dict[str, Any]], target_mac: str, prefer_mac: str) -> dict[str, Any] | None:
    norm_target = (target_mac or "").strip().upper()
    if norm_target:
        return devices.get(norm_target)
    norm_prefer = (prefer_mac or "").strip().upper()
    if norm_prefer and norm_prefer in devices:
        return devices[norm_prefer]
    if not devices:
        return None
    return max(
        devices.values(),
        key=lambda d: d.get("rssi") if isinstance(d.get("rssi"), int) else -999,
    )


def format_adapter_info(adapter_path: str, adapter_props: dict[str, Any]) -> dict[str, Any]:
    return {
        "path": adapter_path,
        "address": str(adapter_props.get("Address") or "").upper(),
        "name": str(adapter_props.get("Name") or ""),
    }


def sanitize_device_out(dev: dict[str, Any]) -> dict[str, Any]:
    return {
        "address": dev.get("address", ""),
        "name": dev.get("name", ""),
        "rssi": dev.get("rssi"),
        "uuids": dev.get("uuids", []),
        "manufacturerData": dev.get("manufacturerData", {}),
        "serviceData": dev.get("serviceData", {}),
        "connected": bool(dev.get("connected", False)),
        "seenAt": dev.get("seenAt"),
    }


def run_scan(args: argparse.Namespace) -> int:
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    adapter_path, adapter_props = find_adapter(bus, args.adapter)
    ensure_adapter_powered(bus, adapter_path, adapter_props)
    adapter = dbus.Interface(bus.get_object(BLUEZ_SERVICE, adapter_path), ADAPTER_IFACE)

    found = discover_matching_devices(
        bus,
        adapter,
        args.target_mac,
        args.name_prefix,
        args.timeout,
        stop_early_for_target=False,
    )

    devices = sorted(
        (sanitize_device_out(d) for d in found.values()),
        key=lambda d: d.get("rssi") if isinstance(d.get("rssi"), int) else -999,
        reverse=True,
    )
    result = {
        "ok": True,
        "scannedAt": now_ms(),
        "adapter": format_adapter_info(adapter_path, adapter_props),
        "devices": devices,
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


VALID_REPLY_CMDS = {0x02, 0x07, 0x12, 0x13, 0x14, 0x19, 0x1A, 0x1C, 0x1F, 0x20}


def is_expected_netlea_reply(raw_bytes: bytes) -> tuple[bool, bool]:
    """Return (is_ack, is_state_14_frame) after verifying frame length and checksum."""
    if len(raw_bytes) < 7 or raw_bytes[0] != 0x5A:
        return False, False
    declared_len = raw_bytes[1]
    if declared_len < 7 or len(raw_bytes) < declared_len:
        return False, False
    if (sum(raw_bytes[: declared_len - 1]) & 0xFF) != raw_bytes[declared_len - 1]:
        return False, False
    cmd = raw_bytes[3]
    if cmd == 0x14:
        return (True, True) if declared_len >= 38 and len(raw_bytes) >= 38 else (False, False)
    if cmd == 0x1A:
        return (True, False) if declared_len >= 19 and len(raw_bytes) >= 19 else (False, False)
    if cmd == 0x12:
        return (True, False) if declared_len >= 152 and len(raw_bytes) >= 152 else (False, False)
    if cmd in VALID_REPLY_CMDS:
        return True, False
    return False, False


def _pump_glib(ctx: GLib.MainContext, duration_sec: float) -> None:
    end_ts = time.monotonic() + max(0.0, duration_sec)
    while time.monotonic() < end_ts:
        while ctx.pending():
            ctx.iteration(False)
        time.sleep(0.015)


def run_command(args: argparse.Namespace) -> int:
    raw_tx_spec = str(args.tx or "").strip().upper()
    tx_parts = [part.strip() for part in raw_tx_spec.split(",") if part.strip()]
    tx_frames: list[bytes] = []
    for part in tx_parts:
        try:
            frame_bytes = bytes.fromhex(part)
        except ValueError as exc:
            print(json.dumps({"ok": False, "code": "INVALID_TX", "error": f"无效的 TX 十六进制帧: {exc}"}, ensure_ascii=False))
            return 0
        if frame_bytes:
            tx_frames.append(frame_bytes)
    if not tx_frames:
        print(json.dumps({"ok": False, "code": "INVALID_TX", "error": "TX 命令帧不能为空"}, ensure_ascii=False))
        return 0
    tx_hex = ",".join(f.hex().upper() for f in tx_frames)

    tx_cmds = {f[3] for f in tx_frames if len(f) >= 4}
    expected_cmds: set[int] = set()
    if tx_cmds & {0x13, 0x15, 0x10}:
        expected_cmds.add(0x14)
    if tx_cmds & {0x1A, 0x1B}:
        expected_cmds.add(0x1A)
    if 0x25 in tx_cmds:
        expected_cmds.add(0x12)

    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    adapter_path, adapter_props = find_adapter(bus, args.adapter)
    ensure_adapter_powered(bus, adapter_path, adapter_props)
    adapter = dbus.Interface(bus.get_object(BLUEZ_SERVICE, adapter_path), ADAPTER_IFACE)

    found = discover_matching_devices(
        bus,
        adapter,
        args.target_mac,
        args.name_prefix,
        args.scan_timeout,
        prefer_mac=args.prefer_mac,
        stop_early_for_target=True,
    )
    target = pick_best_device(found, args.target_mac, args.prefer_mac)
    if not target:
        print(
            json.dumps(
                {
                    "ok": False,
                    "code": "NOT_FOUND",
                    "error": "未扫描到匹配的尼特利鱼缸灯蓝牙广播，请确认灯具已通电且手机 App 未占用连接",
                    "adapter": format_adapter_info(adapter_path, adapter_props),
                },
                ensure_ascii=False,
            )
        )
        return 0

    dev_path = target["path"]
    dev_iface = dbus.Interface(bus.get_object(BLUEZ_SERVICE, dev_path), DEVICE_IFACE)
    prop_iface = dbus.Interface(bus.get_object(BLUEZ_SERVICE, dev_path), PROPERTIES_IFACE)

    # Brief pause after StopDiscovery avoids BlueZ le-connection-abort-by-local
    time.sleep(0.15)

    replies: list[dict[str, Any]] = []
    rx_buf = bytearray()
    state_hex: str | None = None
    temp_config_hex: str | None = None
    schedule_hex: str | None = None
    state_has_travel: bool | None = None
    received_cmds: set[int] = set()
    ack_received = False
    last_ack_ts = 0.0
    notify_iface: dbus.Interface | None = None
    prop_sig = None

    def process_packet(pkt: bytes, char_name: str) -> None:
        nonlocal state_hex, temp_config_hex, schedule_hex, state_has_travel, ack_received, last_ack_ts
        pkt_hex = pkt.hex().upper()
        replies.append({"char": char_name, "hex": pkt_hex, "at": now_ms()})
        is_ack, is_state14 = is_expected_netlea_reply(pkt)
        if not is_ack:
            return
        ack_received = True
        last_ack_ts = time.monotonic()
        cmd = pkt[3]
        received_cmds.add(cmd)
        if is_state14:
            state_hex = pkt_hex
            if len(pkt) > 11:
                state_has_travel = bool(pkt[11] & 0x02)
        elif cmd == 0x1A:
            temp_config_hex = pkt_hex
        elif cmd == 0x12:
            schedule_hex = pkt_hex

    def on_props_changed(
        interface: str, changed: dict[str, Any], _invalidated: Any, path: str | None = None
    ) -> None:
        if interface != GATT_CHAR_IFACE or not path or not str(path).startswith(dev_path + "/"):
            return
        if "Value" not in changed:
            return
        raw_bytes = bytes(int(b) & 0xFF for b in changed["Value"])
        char_name = str(path).split("/")[-1]
        rx_buf.extend(raw_bytes)
        while rx_buf:
            if rx_buf[0] != 0x5A:
                idx = rx_buf.find(b"\x5a")
                if idx < 0:
                    rx_buf.clear()
                    break
                del rx_buf[:idx]
            if len(rx_buf) < 7:
                break
            declared_len = rx_buf[1]
            if declared_len < 7:
                del rx_buf[0]
                continue
            if len(rx_buf) < declared_len:
                break
            pkt = bytes(rx_buf[:declared_len])
            del rx_buf[:declared_len]
            process_packet(pkt, char_name)

    prop_sig = bus.add_signal_receiver(
        on_props_changed,
        dbus_interface=PROPERTIES_IFACE,
        signal_name="PropertiesChanged",
        bus_name=BLUEZ_SERVICE,
        path_keyword="path",
    )

    ctx = GLib.MainContext.default()
    try:
        try:
            if not bool(prop_iface.Get(DEVICE_IFACE, "Connected")):
                dev_iface.Connect()
            connect_deadline = time.monotonic() + max(2.0, float(args.connect_timeout))
            while time.monotonic() < connect_deadline:
                while ctx.pending():
                    ctx.iteration(False)
                connected = bool(prop_iface.Get(DEVICE_IFACE, "Connected"))
                resolved = bool(prop_iface.Get(DEVICE_IFACE, "ServicesResolved"))
                if connected and resolved:
                    break
                time.sleep(0.05)
            else:
                raise RuntimeError("连接超时：GATT 服务未能在时限内解析完成")
        except Exception as exc:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "code": "CONNECT_FAILED",
                        "error": f"蓝牙连接失败: {exc}",
                        "device": sanitize_device_out(target),
                    },
                    ensure_ascii=False,
                )
            )
            return 0

        objs = get_managed_objects(bus)
        notify_path: str | None = None
        write_path: str | None = None
        for path, ifaces in sorted(objs.items()):
            if not str(path).startswith(dev_path + "/") or GATT_CHAR_IFACE not in ifaces:
                continue
            uuid = str(ifaces[GATT_CHAR_IFACE].get("UUID", "")).lower()
            if uuid == NOTIFY_FF01_UUID:
                notify_path = str(path)
            elif uuid == WRITE_FF02_UUID:
                write_path = str(path)

        if not notify_path or not write_path:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "code": "GATT_MISSING",
                        "error": "未在灯具上找到尼特利 GATT 特征 0xFF01 / 0xFF02",
                        "device": sanitize_device_out(target),
                    },
                    ensure_ascii=False,
                )
            )
            return 0

        notify_iface = dbus.Interface(bus.get_object(BLUEZ_SERVICE, notify_path), GATT_CHAR_IFACE)
        write_iface = dbus.Interface(bus.get_object(BLUEZ_SERVICE, write_path), GATT_CHAR_IFACE)

        notify_iface.StartNotify()
        _pump_glib(ctx, 0.2)
        replies.clear()
        rx_buf.clear()
        state_hex = None
        temp_config_hex = None
        schedule_hex = None
        state_has_travel = None
        received_cmds.clear()
        ack_received = False
        last_ack_ts = 0.0

        inter_frame_sec = max(0.05, float(args.inter_frame_ms) / 1000.0)
        for idx, frame_bytes in enumerate(tx_frames):
            # Track state_has_travel freshly from any state queries triggered later
            if len(frame_bytes) >= 4 and frame_bytes[3] in (0x12, 0x10):
                state_hex = None
                state_has_travel = None
                received_cmds.discard(0x14)
                if frame_bytes[3] == 0x12:
                    received_cmds.discard(0x12)
                    schedule_hex = None
            arr = dbus.Array([dbus.Byte(b) for b in frame_bytes], signature="y")
            try:
                write_iface.WriteValue(arr, dbus.Dictionary({"type": dbus.String("command")}, signature="sv"))
            except Exception:
                write_iface.WriteValue(arr, dbus.Dictionary({}, signature="sv"))
            if idx < len(tx_frames) - 1:
                _pump_glib(ctx, inter_frame_sec)

        reply_deadline = time.monotonic() + max(0.5, float(args.reply_timeout))
        while time.monotonic() < reply_deadline:
            while ctx.pending():
                ctx.iteration(False)
            eff_expected = set(expected_cmds)
            if state_has_travel is False:
                eff_expected.discard(0x12)
            if eff_expected and eff_expected.issubset(received_cmds):
                _pump_glib(ctx, 0.1)
                break
            if not eff_expected and ack_received and (time.monotonic() - last_ack_ts) >= 0.15:
                break
            time.sleep(0.02)

        if not ack_received:
            print(
                json.dumps(
                    {
                        "ok": False,
                        "code": "ACK_TIMEOUT",
                        "error": "指令已下发但等待灯具回执超时",
                        "device": sanitize_device_out(target),
                        "tx": tx_hex,
                        "replies": replies,
                    },
                    ensure_ascii=False,
                )
            )
            return 0

        print(
            json.dumps(
                {
                    "ok": True,
                    "device": sanitize_device_out(target),
                    "tx": tx_hex,
                    "replies": replies,
                    "stateHex": state_hex,
                    "tempConfigHex": temp_config_hex,
                    "scheduleHex": schedule_hex,
                },
                ensure_ascii=False,
            )
        )
        return 0
    finally:
        if prop_sig is not None:
            try:
                prop_sig.remove()
            except Exception:
                pass
        if notify_iface is not None:
            try:
                notify_iface.StopNotify()
            except Exception:
                pass
        try:
            dev_iface.Disconnect()
        except Exception:
            pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Netlea BLE aquarium light helper over BlueZ D-Bus")
    sub = parser.add_subparsers(dest="command", required=True)

    scan_p = sub.add_parser("scan")
    scan_p.add_argument("--timeout", type=float, default=5.0)
    scan_p.add_argument("--target-mac", default="")
    scan_p.add_argument("--name-prefix", default="SG-")
    scan_p.add_argument("--adapter", default="")

    cmd_p = sub.add_parser("command")
    cmd_p.add_argument("--tx", required=True)
    cmd_p.add_argument("--target-mac", default="")
    cmd_p.add_argument("--prefer-mac", default="")
    cmd_p.add_argument("--name-prefix", default="SG-")
    cmd_p.add_argument("--scan-timeout", type=float, default=6.0)
    cmd_p.add_argument("--connect-timeout", type=float, default=10.0)
    cmd_p.add_argument("--reply-timeout", type=float, default=3.5)
    cmd_p.add_argument("--inter-frame-ms", type=int, default=120)
    cmd_p.add_argument("--adapter", default="")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "scan":
            return run_scan(args)
        if args.command == "command":
            return run_command(args)
        return 1
    except Exception as exc:
        print(json.dumps({"ok": False, "code": "BLE_ERROR", "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())

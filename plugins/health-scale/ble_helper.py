#!/usr/bin/env python3
"""BlueZ D-Bus helper for scanning and reading Welland / Ant-Afu A1 BLE scales.

Uses system Python `dbus` + `gi.repository.GLib` with zero third-party pip deps.
Supports two commands:
  - scan: discover matching BLE scale(s) and print one JSON object to stdout
  - measure: connect to GATT, enable FFB2 notifications, write FFB1 handshake,
             and stream atomic JSON state snapshots to --state-file.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
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

SERVICE_FFB0_UUID = "0000ffb0-0000-1000-8000-00805f9b34fb"
WRITE_FFB1_UUID = "0000ffb1-0000-1000-8000-00805f9b34fb"
NOTIFY_FFB2_UUID = "0000ffb2-0000-1000-8000-00805f9b34fb"
SERVICE_27AC_UUID = "000027ac-0000-1000-8000-00805f9b34fb"

DEVICE_INFO_UUIDS = {
    "mac": "00002a23-0000-1000-8000-00805f9b34fb",
    "model": "00002a24-0000-1000-8000-00805f9b34fb",
    "hardware": "00002a27-0000-1000-8000-00805f9b34fb",
    "software": "00002a28-0000-1000-8000-00805f9b34fb",
    "manufacturer": "00002a29-0000-1000-8000-00805f9b34fb",
}


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


def now_ms() -> int:
    return int(time.time() * 1000)


def dbus_to_py(value: Any) -> Any:
    if isinstance(value, (dbus.String,)):
        return str(value)
    if isinstance(value, (dbus.Boolean,)):
        return bool(value)
    if isinstance(value, (dbus.Byte, dbus.Int16, dbus.UInt16, dbus.Int32, dbus.UInt32, dbus.Int64, dbus.UInt64)):
        return int(value)
    if isinstance(value, (dbus.Double,)):
        return float(value)
    if isinstance(value, (dbus.Array, list, tuple)):
        return [dbus_to_py(item) for item in value]
    if isinstance(value, (dbus.Dictionary, dict)):
        return {dbus_to_py(k): dbus_to_py(v) for k, v in value.items()}
    return value


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


def matches_scale(dev: dict[str, Any], target_mac: str, name_prefix: str) -> bool:
    norm_mac = (target_mac or "").strip().upper()
    norm_prefix = (name_prefix or "").strip().upper()
    addr = (dev.get("address") or "").upper()
    name = (dev.get("name") or "").upper()
    if norm_mac and addr == norm_mac:
        return True
    if norm_prefix and name.startswith(norm_prefix):
        return True
    svc_data = dev.get("serviceData") or {}
    if SERVICE_27AC_UUID in svc_data:
        return True
    mfg_data = dev.get("manufacturerData") or {}
    if "0x27ac" in mfg_data:
        return True
    uuids = dev.get("uuids") or []
    if SERVICE_FFB0_UUID in uuids and SERVICE_27AC_UUID in uuids:
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
    """Remove unpaired disconnected matching devices so fresh advertisements emit InterfacesAdded.

    Returns any already-connected matching devices so callers can reuse active connections.
    """
    connected_matches: list[dict[str, Any]] = []
    objects = get_managed_objects(bus)
    for path, ifaces in objects.items():
        if DEVICE_IFACE not in ifaces:
            continue
        dev = serialize_device(str(path), dict(ifaces[DEVICE_IFACE]))
        if not matches_scale(dev, target_mac, name_prefix):
            continue
        if dev["connected"]:
            connected_matches.append(dev)
        elif not dev["paired"]:
            try:
                adapter.RemoveDevice(dbus.ObjectPath(str(path)))
            except Exception:
                pass
    return connected_matches


def run_scan(args: argparse.Namespace) -> int:
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SystemBus()
    adapter_path, adapter_props = find_adapter(bus, args.adapter)
    ensure_adapter_powered(bus, adapter_path, adapter_props)
    adapter = dbus.Interface(bus.get_object(BLUEZ_SERVICE, adapter_path), ADAPTER_IFACE)

    found: dict[str, dict[str, Any]] = {}
    already_connected = clear_stale_unpaired_devices(bus, adapter, args.target_mac, args.name_prefix)
    for dev in already_connected:
        key = dev["address"] or dev["path"]
        found[key] = dev

    loop = GLib.MainLoop()

    def record_device(path: str, props: dict[str, Any]) -> None:
        dev = serialize_device(path, props)
        if matches_scale(dev, args.target_mac, args.name_prefix):
            key = dev["address"] or dev["path"]
            prev = found.get(key, {})
            merged = {**prev, **{k: v for k, v in dev.items() if v not in (None, "", [], {})}}
            merged["seenAt"] = now_ms()
            found[key] = merged

    def on_interfaces_added(path: Any, interfaces: dict[str, Any]) -> None:
        if DEVICE_IFACE in interfaces:
            record_device(str(path), dict(interfaces[DEVICE_IFACE]))

    def on_properties_changed(interface: str, changed: dict[str, Any], _invalidated: Any, path: str | None = None) -> None:
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

    def finish_scan() -> bool:
        loop.quit()
        return False

    GLib.timeout_add(int(max(1.0, args.timeout) * 1000), finish_scan)
    try:
        loop.run()
    finally:
        sig1.remove()
        sig2.remove()
        safe_stop_discovery(adapter)

    devices = sorted(
        found.values(),
        key=lambda d: d.get("rssi") if isinstance(d.get("rssi"), int) else -999,
        reverse=True,
    )
    result = {
        "ok": True,
        "scannedAt": now_ms(),
        "adapter": {
            "path": adapter_path,
            "address": str(adapter_props.get("Address") or "").upper(),
            "name": str(adapter_props.get("Name") or ""),
        },
        "devices": devices,
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


class MeasureSession:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.state_file = args.state_file
        self.bus = dbus.SystemBus()
        self.loop = GLib.MainLoop()
        self.adapter_path, self.adapter_props = find_adapter(self.bus, args.adapter)
        ensure_adapter_powered(self.bus, self.adapter_path, self.adapter_props)
        self.adapter = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.adapter_path), ADAPTER_IFACE)

        self.started_at = now_ms()
        self.deadline = time.monotonic() + max(5.0, float(args.timeout))
        self.stopping = False
        self.finished = False
        self.connecting = False
        self.device_path: str | None = None
        self.notify_path: str | None = None
        self.write_path: str | None = None
        self.notifications: list[dict[str, Any]] = []
        self.seen_stable_weight = False
        self.seen_adc = False

        self.grace_timer_id: int | None = None
        self.resolve_timer_id: int | None = None
        self.retry_timer_id: int | None = None
        self.overall_timer_id: int | None = None
        self.receivers: list[Any] = []

        self.session_id: str = getattr(args, "session_id", "") or f"meas-{self.started_at}"
        self.profile_id: str = getattr(args, "profile_id", "") or ""
        self.state: dict[str, Any] = {
            "sessionId": self.session_id,
            "profileId": self.profile_id,
            "pid": os.getpid(),
            "phase": "scanning",
            "startedAt": self.started_at,
            "updatedAt": self.started_at,
            "timeoutSec": float(args.timeout),
            "message": "正在扫描并等待沃莱 A1 体脂秤唤醒（请赤脚上秤）…",
            "adapter": {
                "path": self.adapter_path,
                "address": str(self.adapter_props.get("Address") or "").upper(),
            },
            "device": None,
            "deviceInfo": {},
            "notifications": self.notifications,
            "error": None,
        }

    def flush(self) -> None:
        if self.profile_id and not self.state.get("profileId"):
            self.state["profileId"] = self.profile_id
        self.state["updatedAt"] = now_ms()
        atomic_write_json(self.state_file, self.state)

    def cancel_timer(self, attr: str) -> None:
        timer_id = getattr(self, attr)
        if timer_id is not None:
            try:
                GLib.source_remove(timer_id)
            except Exception:
                pass
            setattr(self, attr, None)

    def cleanup_ble(self) -> None:
        self.cancel_timer("grace_timer_id")
        self.cancel_timer("resolve_timer_id")
        self.cancel_timer("retry_timer_id")
        self.cancel_timer("overall_timer_id")
        for rec in self.receivers:
            try:
                rec.remove()
            except Exception:
                pass
        self.receivers.clear()
        safe_stop_discovery(self.adapter)
        if self.notify_path:
            try:
                char_iface = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.notify_path), GATT_CHAR_IFACE)
                char_iface.StopNotify()
            except Exception:
                pass
        if self.device_path:
            try:
                dev_iface = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.device_path), DEVICE_IFACE)
                dev_iface.Disconnect()
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
        self.flush()
        self.loop.quit()

    def on_signal(self, *_args: Any) -> bool:
        self.finish("stopped", "已手动停止测量会话")
        return False

    def on_overall_timeout(self) -> bool:
        self.overall_timer_id = None
        if self.seen_adc or self.seen_stable_weight:
            self.finish("completed", "测量已完成")
        else:
            self.finish("timeout", "等待超时：未检测到稳定的上秤测量信号，请确认赤脚站立且手机 App 未占用连接", "测量等待超时")
        return False

    def start(self) -> int:
        self.flush()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, self.on_signal)
            except Exception:
                signal.signal(sig, lambda *_a: GLib.idle_add(lambda: (self.on_signal(), False)[1]))

        self.overall_timer_id = GLib.timeout_add(int(max(5.0, float(self.args.timeout)) * 1000), self.on_overall_timeout)

        self.receivers.append(
            self.bus.add_signal_receiver(
                self.on_interfaces_added,
                dbus_interface=OBJECT_MANAGER_IFACE,
                signal_name="InterfacesAdded",
                bus_name=BLUEZ_SERVICE,
            )
        )
        self.receivers.append(
            self.bus.add_signal_receiver(
                self.on_properties_changed,
                dbus_interface=PROPERTIES_IFACE,
                signal_name="PropertiesChanged",
                bus_name=BLUEZ_SERVICE,
                path_keyword="path",
            )
        )

        self.begin_scan()
        try:
            self.loop.run()
        finally:
            if not self.finished:
                self.cleanup_ble()
                self.flush()
        return 0

    def begin_scan(self) -> bool:
        self.retry_timer_id = None
        if self.stopping or self.finished:
            return False
        if time.monotonic() >= self.deadline:
            self.on_overall_timeout()
            return False

        self.connecting = False
        self.device_path = None
        self.notify_path = None
        self.write_path = None
        self.state["phase"] = "scanning"
        self.state["message"] = "正在扫描沃莱 A1 广播信号（请踩亮秤面）…"
        self.flush()

        safe_stop_discovery(self.adapter)
        connected_matches = clear_stale_unpaired_devices(
            self.bus, self.adapter, self.args.target_mac, self.args.name_prefix
        )
        if connected_matches:
            dev = connected_matches[0]
            self.device_path = dev["path"]
            self.state["device"] = dev
            if dev.get("servicesResolved"):
                self.on_services_resolved()
                return False
            self.trigger_connect(dev)
            return False

        safe_start_le_discovery(self.adapter)
        return False

    def on_interfaces_added(self, path: Any, interfaces: dict[str, Any]) -> None:
        if self.stopping or self.finished or self.connecting or self.device_path:
            return
        if DEVICE_IFACE not in interfaces:
            return
        dev = serialize_device(str(path), dict(interfaces[DEVICE_IFACE]))
        if matches_scale(dev, self.args.target_mac, self.args.name_prefix):
            self.trigger_connect(dev)

    def on_properties_changed(
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
                if "RSSI" in changed and self.state.get("device"):
                    self.state["device"]["rssi"] = int(changed["RSSI"])
                if "ServicesResolved" in changed and bool(changed["ServicesResolved"]):
                    self.cancel_timer("resolve_timer_id")
                    self.on_services_resolved()
                if "Connected" in changed and not bool(changed["Connected"]):
                    if self.seen_adc or self.seen_stable_weight:
                        self.finish("completed", "秤端测量锁定并自动断开，数据已同步")
                    elif self.state.get("phase") == "measuring":
                        self.finish("error", "体重秤在锁定前意外断开连接", "体重秤意外断开")
                    elif self.state.get("phase") == "connecting":
                        self._schedule_retry("蓝牙连接尚未完成即断开，正在重新等待唤醒…")
            elif not self.connecting and not self.device_path:
                try:
                    prop_iface = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, path), PROPERTIES_IFACE)
                    dev = serialize_device(str(path), dict(prop_iface.GetAll(DEVICE_IFACE)))
                    if matches_scale(dev, self.args.target_mac, self.args.name_prefix):
                        self.trigger_connect(dev)
                except Exception:
                    pass

        elif interface == GATT_CHAR_IFACE and self.notify_path and str(path) == self.notify_path:
            if "Value" in changed:
                raw_bytes = bytes(int(b) & 0xFF for b in changed["Value"])
                self.handle_notification(raw_bytes)

    def trigger_connect(self, dev: dict[str, Any]) -> None:
        if self.connecting or self.stopping or self.finished:
            return
        self.connecting = True
        self.device_path = dev["path"]
        self.state["device"] = dev
        self.state["phase"] = "connecting"
        self.state["message"] = f"发现 {dev.get('name') or dev['address']} (RSSI {dev.get('rssi', '--')} dBm)，正在建立 GATT 连接…"
        self.flush()

        # Stop discovery before Connect() to avoid Intel 3165 le-connection-abort-by-local
        safe_stop_discovery(self.adapter)
        GLib.timeout_add(250, self._do_connect_async)

    def _do_connect_async(self) -> bool:
        if self.stopping or self.finished or not self.device_path:
            return False
        try:
            dev_iface = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.device_path), DEVICE_IFACE)
            dev_iface.Connect(
                reply_handler=self._on_connect_ok,
                error_handler=self._on_connect_err,
                timeout=12,
            )
        except Exception as exc:
            self._on_connect_err(exc)
        return False

    def _on_connect_ok(self) -> None:
        if self.stopping or self.finished or not self.device_path:
            return
        try:
            prop_iface = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.device_path), PROPERTIES_IFACE)
            all_props = dict(prop_iface.GetAll(DEVICE_IFACE))
            self.state["device"] = serialize_device(self.device_path, all_props)
            if bool(all_props.get("ServicesResolved", False)):
                self.on_services_resolved()
                return
        except Exception:
            pass
        self.state["message"] = "GATT 已连接，正在解析蓝牙服务特征…"
        self.flush()
        self.cancel_timer("resolve_timer_id")
        self.resolve_timer_id = GLib.timeout_add(8000, self._on_resolve_timeout)

    def _on_resolve_timeout(self) -> bool:
        self.resolve_timer_id = None
        if not self.stopping and not self.finished and not self.notify_path:
            self._schedule_retry("蓝牙服务发现超时，正在重连…")
        return False

    def _on_connect_err(self, err: Any) -> None:
        if self.stopping or self.finished:
            return
        self._schedule_retry(f"连接未就绪 ({str(err)[:80]})，正在重新等待唤醒…")

    def _schedule_retry(self, msg: str) -> None:
        if self.device_path:
            try:
                dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.device_path), DEVICE_IFACE).Disconnect()
            except Exception:
                pass
        if time.monotonic() + 2.0 >= self.deadline:
            self.on_overall_timeout()
            return
        self.state["phase"] = "scanning"
        self.state["message"] = msg
        self.flush()
        self.cancel_timer("retry_timer_id")
        self.retry_timer_id = GLib.timeout_add(700, self.begin_scan)

    def on_services_resolved(self) -> None:
        if self.stopping or self.finished or not self.device_path or self.notify_path:
            return
        objects = get_managed_objects(self.bus)
        prefix = self.device_path + "/"
        info_chars: dict[str, str] = {}
        notify_path: str | None = None
        write_path: str | None = None

        for path, ifaces in objects.items():
            spath = str(path)
            if not spath.startswith(prefix) or GATT_CHAR_IFACE not in ifaces:
                continue
            props = ifaces[GATT_CHAR_IFACE]
            uuid = str(props.get("UUID") or "").lower()
            if uuid == NOTIFY_FFB2_UUID:
                notify_path = spath
            elif uuid == WRITE_FFB1_UUID:
                write_path = spath
            else:
                for key, info_uuid in DEVICE_INFO_UUIDS.items():
                    if uuid == info_uuid:
                        info_chars[key] = spath

        if not notify_path:
            self._schedule_retry("未找到 FFB2 测量通知特征，正在重连…")
            return

        self.notify_path = notify_path
        self.write_path = write_path

        device_info: dict[str, str] = {}
        for key, cpath in info_chars.items():
            try:
                char_iface = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, cpath), GATT_CHAR_IFACE)
                raw_val = bytes(int(b) & 0xFF for b in char_iface.ReadValue(dbus.Dictionary({}, signature="sv")))
                if key == "mac":
                    device_info[key] = ":".join(f"{b:02X}" for b in raw_val)
                else:
                    device_info[key] = raw_val.split(b"\x00", 1)[0].decode("utf-8", errors="replace").strip()
            except Exception:
                pass
        if device_info:
            self.state["deviceInfo"] = device_info

        try:
            char_iface = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, notify_path), GATT_CHAR_IFACE)
            char_iface.StartNotify(
                reply_handler=self._on_notify_started,
                error_handler=lambda e: self._schedule_retry(f"订阅 FFB2 失败: {str(e)[:60]}"),
                timeout=8,
            )
        except Exception as exc:
            self._schedule_retry(f"订阅 FFB2 异常: {str(exc)[:60]}")

    def _on_notify_started(self) -> None:
        if self.stopping or self.finished:
            return
        self.state["phase"] = "measuring"
        self.state["message"] = "已连接体脂秤并同步档案，请保持赤脚站立等待锁定…"
        self.flush()

        if self.write_path and self.args.tx_packet_hex:
            try:
                pkt = bytes.fromhex(self.args.tx_packet_hex.strip())
                write_iface = dbus.Interface(self.bus.get_object(BLUEZ_SERVICE, self.write_path), GATT_CHAR_IFACE)
                arr = dbus.Array([dbus.Byte(b) for b in pkt], signature="y")
                try:
                    write_iface.WriteValue(arr, dbus.Dictionary({"type": dbus.String("command")}, signature="sv"))
                except Exception:
                    write_iface.WriteValue(arr, dbus.Dictionary({}, signature="sv"))
            except Exception:
                pass

    def handle_notification(self, pkt: bytes) -> None:
        if self.stopping or self.finished or not pkt:
            return
        self.notifications.append(
            {
                "at": now_ms(),
                "uuid": NOTIFY_FFB2_UUID,
                "hex": pkt.hex().upper(),
            }
        )

        # Inspect Scale27 packet type solely for completion/grace scheduling
        if len(pkt) >= 20 and (pkt[1] & 0x80) == 0:
            checksum_calc = sum(pkt[2:19]) & 0x1F
            checksum_pkt = pkt[19] & 0x1F
            if checksum_calc == checksum_pkt:
                pkt_type = pkt[18]
                if pkt_type == 213:  # PACKET_WEIGHT
                    encoded = int.from_bytes(pkt[2:6], "big")
                    stable = bool((encoded >> 31) & 1)
                    if stable and not self.seen_stable_weight:
                        self.seen_stable_weight = True
                        if not self.seen_adc:
                            self.state["message"] = "体重已锁定，正在测量双频生物电阻抗…"
                            self.cancel_timer("grace_timer_id")
                            # Wait up to 8.5s for BIA impedance (user might be wearing socks)
                            self.grace_timer_id = GLib.timeout_add(8500, self._on_weight_only_grace)
                elif pkt_type == 214:  # PACKET_ADC
                    adc_count = pkt[2]
                    adcs: list[int] = []
                    if adc_count <= 6:
                        for idx in range(adc_count):
                            pos = 4 + idx * 2
                            if pos + 2 <= 18:
                                adcs.append(int.from_bytes(pkt[pos:pos + 2], "big"))
                    if any(0 < val < 65535 for val in adcs):
                        self.seen_adc = True
                        self.state["message"] = "已采集双频生物电阻抗与稳定体重，正在收尾同步…"
                        self.cancel_timer("grace_timer_id")
                        self.grace_timer_id = GLib.timeout_add(
                            550,
                            lambda: (self.finish("completed", "测量完成，已获取完整体重与生物电阻抗数据"), False)[1],
                        )
        self.flush()

    def _on_weight_only_grace(self) -> bool:
        self.grace_timer_id = None
        if not self.finished and self.seen_stable_weight and not self.seen_adc:
            self.finish("completed", "体重测量已完成（未检测到赤脚阻抗，已按 BMI 估算成分）")
        return False


def run_measure(args: argparse.Namespace) -> int:
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    session = MeasureSession(args)
    return session.start()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Welland A1 BLE helper over BlueZ D-Bus")
    sub = parser.add_subparsers(dest="command", required=True)

    scan_p = sub.add_parser("scan")
    scan_p.add_argument("--timeout", type=float, default=4.0)
    scan_p.add_argument("--target-mac", default="")
    scan_p.add_argument("--name-prefix", default="AFU-WL")
    scan_p.add_argument("--adapter", default="")

    meas_p = sub.add_parser("measure")
    meas_p.add_argument("--state-file", required=True)
    meas_p.add_argument("--session-id", default="")
    meas_p.add_argument("--profile-id", default="")
    meas_p.add_argument("--timeout", type=float, default=45.0)
    meas_p.add_argument("--target-mac", default="")
    meas_p.add_argument("--name-prefix", default="AFU-WL")
    meas_p.add_argument("--tx-packet-hex", default="")
    meas_p.add_argument("--adapter", default="")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "scan":
            return run_scan(args)
        if args.command == "measure":
            return run_measure(args)
        return 1
    except Exception as exc:
        if args.command == "measure" and getattr(args, "state_file", None):
            try:
                err_state = {
                    "sessionId": getattr(args, "session_id", "") or f"meas-{now_ms()}",
                    "profileId": getattr(args, "profile_id", "") or "",
                    "pid": os.getpid(),
                    "phase": "error",
                    "startedAt": now_ms(),
                    "updatedAt": now_ms(),
                    "message": f"蓝牙测量初始化失败：{exc}",
                    "device": None,
                    "deviceInfo": {},
                    "notifications": [],
                    "error": str(exc),
                }
                atomic_write_json(args.state_file, err_state)
            except Exception:
                pass
            return 1
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())

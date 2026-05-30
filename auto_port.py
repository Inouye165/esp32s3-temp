# auto_port.py — PlatformIO pre-upload extra script
# Finds the right board by MAC address before every upload.

Import("env")  # noqa: F821

import re
import subprocess
import sys
from serial.tools.list_ports import comports

BOARD_MACS = {
    "sender":   "a4:cb:8f:d1:ef:58",
    "receiver": "a4:cb:8f:d1:f2:a8",
    "unit_c":   "a4:cb:8f:d1:ef:a0",
}


def _mac_on_port(port: str) -> str | None:
    try:
        r = subprocess.run(
            [sys.executable, "-m", "esptool", "--port", port, "chip_id"],
            capture_output=True, text=True, timeout=10,
        )
        m = re.search(r"MAC:\s*([0-9a-f:]{17})", r.stdout + r.stderr, re.IGNORECASE)
        return m.group(1).lower() if m else None
    except Exception:
        return None


def before_upload(source, target, env):  # noqa: ARG001
    pioenv     = env["PIOENV"]
    target_mac = BOARD_MACS.get(pioenv)
    if not target_mac:
        return

    usb_ports = [p.device for p in comports() if p.vid is not None]
    if not usb_ports:
        print("\n[auto_port] No USB serial ports found — using port from platformio.ini\n")
        return

    for port in usb_ports:
        mac = _mac_on_port(port)
        if mac and mac == target_mac.lower():
            print(f"\n[auto_port] {pioenv} -> {port}  (MAC {mac})\n")
            env.Replace(UPLOAD_PORT=port)
            env.Replace(MONITOR_PORT=port)
            return

    print(f"\n[auto_port] WARNING: {pioenv} ({target_mac}) not found — using platformio.ini\n")


env.AddPreAction("upload", before_upload)  # noqa: F821

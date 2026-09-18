"""SIP endpoint to Fail2Ban address association and restricted actions."""
import ipaddress
import os
import re
import subprocess
import threading
import time


class BanManager:
    def __init__(self, get, put, commit, state_lock):
        self.get, self.put, self.commit = get, put, commit
        self.state_lock = state_lock
        self.lock = threading.Lock()
        self.offset = None
        self.inode = None
        self.pending = b""

    def command(self, *args):
        return subprocess.check_output(
            ["fail2ban-client", *args], text=True, timeout=5,
            stderr=subprocess.STDOUT).strip()

    def addresses(self):
        return sorted({str(ipaddress.ip_address(x)) for x in
                       self.command("get", "asterisk", "banip").split()})

    def refresh(self, contacts):
        with self.lock:
            with self.state_lock:
                known = self.get("ban_endpoints") or {}
            now = time.time()
            # Read a bounded initial tail, then only appended REGISTER failures.
            try:
                with open("/var/log/asterisk/messages", "rb") as f:
                    stat = os.fstat(f.fileno())
                    if self.inode != stat.st_ino or self.offset is None or stat.st_size < self.offset:
                        self.offset = max(0, stat.st_size - 512 * 1024)
                        self.pending = b""
                        self.inode = stat.st_ino
                    f.seek(self.offset)
                    raw = self.pending + f.read(1024 * 1024)
                    self.offset = f.tell()
                lines = raw.split(b"\n")
                self.pending = lines.pop()
                for line in lines:
                    text = line.decode("utf-8", "replace")
                    match = re.search(r"Request 'REGISTER' from '.*?sip:(\d{3,6})@.*?' failed for '(\[[0-9a-fA-F:]+\]|[0-9.]+):\d+'.*Failed to authenticate", text)
                    if match:
                        ext, addr = match.groups()
                        addr = str(ipaddress.ip_address(addr.strip("[]")))
                        known[ext] = {"ip": addr, "source": "register_failure", "observed_at": now}
            except (OSError, ValueError):
                pass
            for c in contacts or []:
                if c.get("ip") and c.get("ext"):
                    try:
                        addr = str(ipaddress.ip_address(c["ip"]))
                    except ValueError:
                        continue
                    known[str(c["ext"])] = {"ip": addr, "source": "contact", "observed_at": now}
            known = {e: v for e, v in known.items() if now - v.get("observed_at", 0) < 30 * 86400}
            try:
                banned = self.addresses()
                error = ""
            except Exception:
                banned, error = [], "无法读取服务器封禁状态"
            state = {"available": not error, "error": error, "checked_at": now,
                     "banned_ips": banned, "endpoints": known}
            with self.state_lock:
                self.put("ban_endpoints", known)
                self.put("ban_status", state)
                self.commit()
            return state

    def action(self, ext, action, expected_ip):
        if not re.fullmatch(r"\d{3,6}", str(ext)) or action not in ("ban", "unban"):
            raise ValueError("无效封禁操作")
        with self.lock:
            with self.state_lock:
                known = self.get("ban_endpoints") or {}
            record = known.get(ext) or {}
            addr = record.get("ip")
            if not addr or addr != expected_ip or time.time() - record.get("observed_at", 0) > 30 * 86400:
                raise ValueError("分机出口 IP 已变化或未知，请刷新后重试")
            ipaddress.ip_address(addr)
            self.command("set", "asterisk", "banip" if action == "ban" else "unbanip", addr)
            banned = self.addresses()
            if (addr in banned) != (action == "ban"):
                raise RuntimeError("服务器未确认封禁状态变化")
            with self.state_lock:
                state = self.get("ban_status") or {}
                state.update(available=True, error="", banned_ips=banned, checked_at=time.time())
                self.put("ban_status", state)
                self.commit()
            return {"ok": True, "ip": addr, "banned": addr in banned,
                    "affected": sorted(e for e, v in known.items() if v.get("ip") == addr)}

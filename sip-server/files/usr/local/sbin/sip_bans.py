"""SIP endpoint to Fail2Ban address association and restricted actions."""
import ipaddress
import os
import re
import subprocess
import threading
import time

from sip_parse import parse_bans, parse_ignoreip, parse_sip_ports

SETTINGS_SEC = 60


class BanManager:
    def __init__(self, get, put, commit, state_lock):
        self.get, self.put, self.commit = get, put, commit
        self.state_lock = state_lock
        self.lock = threading.Lock()
        self.offset = None
        self.inode = None
        self.pending = b""
        self.settings = {}
        self.settings_at = 0

    def command(self, *args):
        return subprocess.check_output(
            ["fail2ban-client", *args], text=True, timeout=5,
            stderr=subprocess.STDOUT).strip()

    def iptables(self):
        return subprocess.check_output(
            ["iptables", "-S", "INPUT"], text=True, timeout=5,
            stderr=subprocess.STDOUT)

    def current_bans(self):
        return parse_bans(self.command("get", "asterisk", "banip", "--with-time"))

    def addresses(self):
        return sorted(b["ip"] for b in self.current_bans())

    def read_settings(self):
        """Jail thresholds, whitelist and open SIP ports change rarely; read them once a minute."""
        now = time.time()
        if self.settings and now - self.settings_at < SETTINGS_SEC:
            return self.settings
        settings = {}
        try:
            settings["rules"] = {k: int(self.command("get", "asterisk", k))
                                 for k in ("maxretry", "findtime", "bantime")}
            settings["ignoreip"] = parse_ignoreip(self.command("get", "asterisk", "ignoreip"))
        except Exception:
            pass
        try:
            settings["ports"] = parse_sip_ports(self.iptables())
        except Exception:
            pass
        self.settings, self.settings_at = settings, now
        return settings

    def firewall(self, bans, known, error=""):
        """Firewall card data. Extensions per banned IP come from the same map the rows use."""
        return dict(self.read_settings(), service="error" if error else "running",
                    bans=[dict(b, exts=sorted(e for e, v in known.items() if v.get("ip") == b["ip"]))
                          for b in bans])

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
                bans = self.current_bans()
                error = ""
            except Exception:
                bans, error = [], "无法读取服务器封禁状态"
            return self.publish(known, bans, error, now)

    def publish(self, known, bans, error="", now=None):
        state = {"available": not error, "error": error, "checked_at": now or time.time(),
                 "banned_ips": sorted(b["ip"] for b in bans), "endpoints": known,
                 "firewall": self.firewall(bans, known, error)}
        with self.state_lock:
            self.put("ban_endpoints", known)
            self.put("ban_status", state)
            self.commit()
        return state

    def unban_ip(self, addr):
        """Firewall card: release one address that the asterisk jail currently holds."""
        addr = str(ipaddress.ip_address(str(addr or "")))
        with self.lock:
            if addr not in self.addresses():
                raise ValueError("该 IP 当前未被封禁，请刷新后重试")
            self.command("set", "asterisk", "unbanip", addr)
            bans = self.current_bans()
            if any(b["ip"] == addr for b in bans):
                raise RuntimeError("服务器未确认解封")
            with self.state_lock:
                known = self.get("ban_endpoints") or {}
            self.publish(known, bans)
            return {"ok": True, "ip": addr, "banned": False,
                    "affected": sorted(e for e, v in known.items() if v.get("ip") == addr)}

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
            bans = self.current_bans()
            banned = [b["ip"] for b in bans]
            if (addr in banned) != (action == "ban"):
                raise RuntimeError("服务器未确认封禁状态变化")
            self.publish(known, bans)
            return {"ok": True, "ip": addr, "banned": addr in banned,
                    "affected": sorted(e for e, v in known.items() if v.get("ip") == addr)}

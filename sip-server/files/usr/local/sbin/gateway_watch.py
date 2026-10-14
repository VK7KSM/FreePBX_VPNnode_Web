"""Gateway transport watchdog for sip-statusd.

2026-10-14: the TLS connection from gateway 300 stayed up and its 5-minute REGISTERs kept
succeeding, but every request Asterisk itself started on it (INVITE, MESSAGE, OPTIONS) was logged
as transmitted and never left the box. Outbound calls and SMS failed silently, possibly for a
month, while the panel showed the gateway online. Dropping the TCP connection made the gateway
reconnect and everything worked again.

Gateways are now qualified every 60 s. When a gateway contact stays unreachable for
UNREACHABLE_SEC, its connection is dropped once so the gateway reconnects; at most one drop per
gateway every COOLDOWN_SEC.
"""
import ipaddress
import subprocess

UNREACHABLE_SEC = 150
COOLDOWN_SEC = 600
REACHABLE = ("Avail", "Reachable")


class GatewayWatch:
    def __init__(self, drop=None, log=print):
        self.drop = drop or drop_connection
        self.log = log
        self.bad_since = {}
        self.last_drop = {}

    def check(self, contacts, gateways, now):
        """contacts: rows from sip_parse.parse_contacts; gateways: set of gateway extensions."""
        seen = set()
        for c in contacts or []:
            ext = str(c.get("ext") or "")
            if ext not in gateways:
                continue
            seen.add(ext)
            key = (ext, c.get("ip"), str(c.get("port") or ""))
            if c.get("status") in REACHABLE or c.get("status") == "NonQual":
                self.bad_since.pop(ext, None)
                continue
            since = self.bad_since.setdefault(ext, (key, now))
            if since[0] != key:
                # The gateway moved to a new connection: start counting again.
                self.bad_since[ext] = (key, now)
                continue
            if now - since[1] < UNREACHABLE_SEC or now - self.last_drop.get(ext, -COOLDOWN_SEC) < COOLDOWN_SEC:
                continue
            ok = self.drop(c.get("ip"), c.get("port"))
            self.last_drop[ext] = now
            self.bad_since[ext] = (key, now)
            self.log("gateway-watch: %s unreachable %ds on %s:%s, connection drop %s" % (
                ext, int(now - since[1]), c.get("ip"), c.get("port"), "done" if ok else "failed"), flush=True)
        for ext in list(self.bad_since):
            if ext not in seen:
                self.bad_since.pop(ext)


def drop_connection(ip, port):
    """Kill the server side of the TLS connection to ip:port; True if it is gone afterwards."""
    try:
        ip = str(ipaddress.ip_address(ip))
        port = int(port)
        if not 0 < port < 65536:
            return False
    except (TypeError, ValueError):
        return False
    flt = ["dst", ip, "dport", "=", str(port)]
    subprocess.run(["ss", "-K"] + flt, capture_output=True, timeout=5)
    left = subprocess.run(["ss", "-Htn"] + flt, capture_output=True, text=True, timeout=5).stdout
    return not left.strip()

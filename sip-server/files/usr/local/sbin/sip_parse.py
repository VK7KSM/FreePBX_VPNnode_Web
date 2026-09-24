"""Pure parsers for Asterisk and Fail2Ban command output used by sip-statusd."""
import ipaddress
import json
import re
import time


def transport_of(uri):
    """Transport named by a SIP contact URI; the SIP default without a parameter is UDP."""
    m = re.search(r";transport=([A-Za-z]*)", uri or "")
    if not m:
        return "UDP"
    value = m.group(1).upper()
    for name in ("TLS", "TCP", "UDP", "WSS", "WS"):
        if value == name:
            return name
    # `pjsip show contacts` cuts long URIs at a fixed width (e.g. "transport=TL").
    for prefix, name in (("TL", "TLS"), ("TC", "TCP"), ("U", "UDP")):
        if value.startswith(prefix):
            return name
    return "?"


def registrar_uris(raw):
    """Map "<ext>;@<hash>" to the full contact URI from `database show registrar/contact`."""
    out = {}
    for line in (raw or "").splitlines():
        m = re.match(r"\s*/registrar/contact/(\S+?)\s*:\s*(\{.*\})\s*$", line)
        if not m:
            continue
        try:
            uri = json.loads(m.group(2)).get("uri")
        except (ValueError, AttributeError):
            continue
        if uri:
            out[m.group(1)] = uri
    return out


def full_uri(ext, short_hash, uris):
    """Full registrar URI for a CLI row: same endpoint, 32-hex hash starting with the 10-char column."""
    if re.fullmatch(r"[0-9a-f]{6,}", short_hash or ""):
        for key, uri in uris.items():
            k_ext, _, k_hash = key.partition(";@")
            if k_ext == ext and k_hash.startswith(short_hash):
                return uri
    return ""


def parse_contacts(table, registrar=""):
    """Rows of `pjsip show contacts`, with transport taken from the registrar's full URI."""
    if "Objects found" not in table and "Aor/ContactUri" not in table:
        return None
    uris = registrar_uris(registrar)
    out = []
    for line in table.splitlines():
        if "Contact:" not in line or "Aor/ContactUri" in line or "===" in line:
            continue
        parts = line.split()
        if len(parts) < 4:
            continue
        uri = parts[1]
        ext = uri.split("/")[0]
        full = full_uri(ext, parts[2], uris) if len(parts) >= 5 else ""
        m = re.search(r"@(\d+\.\d+\.\d+\.\d+)(?::(\d+))?", full or uri)
        try:
            rtt = round(float(parts[-1]), 1)
            if rtt != rtt:
                rtt = None
        except ValueError:
            rtt = None
        out.append({
            "ext": ext, "uri": full or uri, "ip": m.group(1) if m else "",
            "port": (m.group(2) or "") if m else "",
            "transport": transport_of(full or uri), "status": parts[-2], "rtt": rtt,
        })
    return out


def parse_bans(raw):
    """`fail2ban-client get <jail> banip --with-time` -> [{ip, since, until}] (epoch seconds).

    Fail2Ban prints server local time, so the times are read back with mktime."""
    out = []
    for line in (raw or "").splitlines():
        m = re.match(r"\s*(\S+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s*\+\s*(-?\d+)\s*=\s*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)", line)
        if not m:
            continue
        try:
            ip = str(ipaddress.ip_address(m.group(1)))
            since = int(time.mktime(time.strptime(m.group(2), "%Y-%m-%d %H:%M:%S")))
        except ValueError:
            continue
        duration = int(m.group(3))
        out.append({"ip": ip, "since": since, "until": since + duration if duration >= 0 else None})
    return sorted(out, key=lambda b: b["since"], reverse=True)


def parse_ignoreip(raw):
    """`fail2ban-client get <jail> ignoreip` tree output -> address list."""
    out = []
    for line in (raw or "").splitlines():
        m = re.match(r"\s*[|`]-\s*(\S+)\s*$", line)
        if m:
            out.append(m.group(1))
    return out


def parse_sip_ports(rules):
    """Which SIP signalling/media ports `iptables -S INPUT` accepts from anywhere."""
    accepted = {"tcp": set(), "udp": set()}
    for line in (rules or "").splitlines():
        if not line.startswith("-A INPUT") or not line.rstrip().endswith("-j ACCEPT"):
            continue
        if " -s " in line or " -i " in line:
            continue
        proto = re.search(r"-p (tcp|udp)", line)
        port = re.search(r"--dports? (\S+)", line)
        if proto and port:
            accepted[proto.group(1)].update(port.group(1).split(","))
    return {
        "tls_5061": "5061" in accepted["tcp"],
        "tcp_5060": "5060" in accepted["tcp"],
        "udp_5060": "5060" in accepted["udp"],
        "rtp": sorted(p for p in accepted["udp"] if ":" in p),
    }

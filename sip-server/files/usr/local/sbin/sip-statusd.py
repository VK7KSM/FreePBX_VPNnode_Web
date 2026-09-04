#!/usr/bin/env python3
"""Osaka SIP local status daemon: SQLite + 127.0.0.1:8080. Keep CPU/RAM low."""
import csv
import io
import json
import os
import re
import socket
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN_PATH = "/etc/sip-heartbeat.token"
DB_PATH = "/var/lib/sip-panel/status.sqlite"
BIND = "127.0.0.1"
PORT = 8080
SAMPLE_SEC = 1
AST_SEC = 5
PULL_SEC = 30
KEEP_SAMPLES = 120
CDR_KEEP = 200
PULL_URL = "https://v.elfradio.net/api/sip/pull"
CPU_SNAP = "/run/sip-panel-cpu"

LOCK = threading.Lock()
TOKEN = ""
LAST_PULL = 0.0
LAST_AST = 0.0
PREV_RX = None
PREV_TX = None
PREV_NET_T = None
CDR_MTIME = None
CDR_CACHE = []


def finite(x, default=0.0):
    try:
        v = float(x)
        if v != v or v in (float("inf"), float("-inf")):
            return default
        return v
    except Exception:
        return default


def sh(cmd):
    try:
        return subprocess.check_output(
            cmd, shell=True, text=True, stderr=subprocess.DEVNULL, timeout=4
        ).strip()
    except Exception:
        return ""


def utcnow():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def cpu_pct():
    def snap():
        with open("/proc/stat") as f:
            p = f.readline().split()
        nums = [int(x) for x in p[1:]]
        idle = nums[3] + nums[4]
        return idle, sum(nums)
    i2, t2 = snap()
    i1 = t1 = None
    try:
        a, b = open(CPU_SNAP).read().split()
        i1, t1 = int(a), int(b)
    except Exception:
        pass
    try:
        open(CPU_SNAP, "w").write("%s %s" % (i2, t2))
    except Exception:
        pass
    if i1 is None or t1 is None or t2 <= t1:
        return 0.0
    return round(100.0 * (1.0 - (i2 - i1) / float(t2 - t1)), 1)


def mem():
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":")
            info[k] = int(v.strip().split()[0])
    total = info.get("MemTotal", 0)
    avail = info.get("MemAvailable", 0)
    used = total - avail
    def g(x):
        return str(round(x / 1024 / 1024, 2)) + "G"
    pct = round(100.0 * used / total, 1) if total else 0
    return g(used), g(total), pct


def disk():
    line = sh("df -B1 / | tail -n 1").split()
    if len(line) < 5:
        return "-", "-", 0
    used, total = int(line[2]), int(line[1])
    def g(x):
        return str(round(x / 1024 / 1024 / 1024, 1)) + "G"
    pct = int(line[4].replace("%", ""))
    return g(used), g(total), pct


def net():
    with open("/proc/net/dev") as f:
        for line in f:
            if "ens3:" in line or "eth0:" in line:
                p = line.replace(":", " ").split()
                rx, tx = int(p[1]), int(p[9])
                label = "rx " + str(round(rx / 1024 / 1024, 1)) + "MB / tx " + str(round(tx / 1024 / 1024, 1)) + "MB"
                return rx, tx, label
    return 0, 0, "-"


PJSIP_CHAN = re.compile(r"PJSIP/(\d+)", re.I)
PJSIP_HEAD = re.compile(r"^PJSIP/(\d+)-", re.I)
GW_KEY = re.compile(r"is_gw/(\d+)")


def gateway_exts():
    raw = sh("asterisk -rx 'database show SIP/is_gw'")
    out = set()
    for line in raw.splitlines():
        m = GW_KEY.search(line)
        if m:
            out.add(m.group(1))
    return out


def talking_exts():
    """Internal: caller flashes while dialing, callee after Up.
    Gateway inbound: gateway flashes on Dial; dest flashes only if it has a live channel (INVITE arrived)."""
    raw = sh("asterisk -rx 'core show channels concise'")
    gw = gateway_exts()
    chans = []
    for line in raw.splitlines():
        if "PJSIP/" not in line:
            continue
        parts = line.strip().split("!")
        if len(parts) < 7:
            continue
        m = PJSIP_HEAD.match(parts[0])
        if not m:
            continue
        chans.append({
            "ext": m.group(1),
            "context": (parts[1] or "").strip().lower(),
            "exten": (parts[2] or "").strip(),
            "state": (parts[4] or "").strip().lower(),
            "app": (parts[5] or "").strip().lower(),
            "data": parts[6] or "",
        })
    flash = set()
    gw_dial_dest = set()
    wait = ("up", "ring", "ringing", "dialing", "proceeding")
    have = set(c["ext"] for c in chans)
    for c in chans:
        if c["state"] == "up":
            flash.add(c["ext"])
        if c["app"] == "dial" and c["state"] in wait:
            flash.add(c["ext"])
            from_gw = c["ext"] in gw or c["context"] in ("from-pstn", "from-did-direct")
            if from_gw:
                dm = PJSIP_CHAN.search(c["data"])
                dest = dm.group(1) if dm else ""
                if not dest and c["exten"].isdigit():
                    dest = c["exten"]
                if dest:
                    gw_dial_dest.add(dest)
    for dest in gw_dial_dest:
        if dest in have:
            flash.add(dest)
    return sorted(flash)


def call_stats():
    raw = sh("asterisk -rx 'core show channels count'")
    calls = 0
    chans = 0
    for line in raw.splitlines():
        parts = line.split()
        if not parts:
            continue
        try:
            n = int(parts[0])
        except Exception:
            continue
        low = line.lower()
        if "active call" in low:
            calls = n
        elif "active channel" in low:
            chans = n
    return calls, chans


def contacts():
    raw = sh("asterisk -rx 'pjsip show contacts'")
    if "Objects found" not in raw and "Aor/ContactUri" not in raw:
        return None
    out = []
    for line in raw.splitlines():
        if "Contact:" not in line or "Aor/ContactUri" in line or "===" in line:
            continue
        parts = line.split()
        if len(parts) < 4:
            continue
        uri = parts[1]
        ext = uri.split("/")[0]
        u = uri.upper()
        if "TRANSPORT=TLS" in u:
            transport = "TLS"
        elif "TRANSPORT=TCP" in u:
            transport = "TCP"
        else:
            transport = "UDP"
        m = re.search(r"@(\d+\.\d+\.\d+\.\d+)(?::(\d+))?", uri)
        ip = m.group(1) if m else ""
        port = m.group(2) if m and m.group(2) else ""
        status = parts[-2]
        rtt = parts[-1]
        try:
            rtt_ms = round(float(rtt), 1)
            if rtt_ms != rtt_ms:
                rtt_ms = None
        except Exception:
            rtt_ms = None
        out.append({
            "ext": ext, "uri": uri, "ip": ip, "port": port,
            "transport": transport, "status": status, "rtt": rtt_ms,
        })
    return out


def parse_qos(userfield):
    if not userfield:
        return {"quality": "-", "media_rtt": "-", "jitter": "-", "loss": "-"}
    kv = {}
    for part in userfield.replace(";", " ").split():
        if "=" in part:
            k, v = part.split("=", 1)
            kv[k.lower()] = v
    jitter = kv.get("rxjitter") or kv.get("jitter") or ""
    loss = kv.get("lp") or kv.get("loss") or kv.get("rlp") or ""
    rtt = kv.get("rtt") or ""
    try:
        jn = float(jitter)
    except Exception:
        jn = None
    try:
        ln = float(loss)
    except Exception:
        ln = None
    if jn is None and ln is None and not rtt:
        return {"quality": "-", "media_rtt": "-", "jitter": "-", "loss": "-"}
    if ln is not None and ln >= 8:
        quality = "差"
    elif (ln is not None and ln >= 3) or (jn is not None and jn >= 40):
        quality = "一般"
    else:
        quality = "好"
    return {"quality": quality, "media_rtt": rtt or "-", "jitter": jitter or "-", "loss": loss if loss != "" else "-"}


def cdr_rows():
    global CDR_MTIME, CDR_CACHE
    path = "/var/log/asterisk/cdr-csv/Master.csv"
    if not os.path.isfile(path):
        return []
    try:
        mt = os.path.getmtime(path)
        sz = os.path.getsize(path)
    except Exception:
        return CDR_CACHE
    if CDR_MTIME == (mt, sz):
        return CDR_CACHE
    try:
        with open(path, "rb") as f:
            if sz > 262144:
                f.seek(sz - 262144)
                f.readline()
            text = f.read().decode("utf-8", "replace")
        rows = []
        reader = csv.reader(io.StringIO(text))
        for rec in reader:
            if len(rec) < 15:
                continue
            userfield = rec[17] if len(rec) > 17 else ""
            qos = parse_qos(userfield)
            try:
                dur_i = int(float(rec[12] or 0))
            except Exception:
                dur_i = 0
            try:
                bill_i = int(float(rec[13] or 0))
            except Exception:
                bill_i = 0
            rows.append({
                "time": rec[9], "answer": rec[10], "end": rec[11],
                "src": rec[1], "dst": rec[2], "clid": rec[4],
                "duration": dur_i, "billsec": bill_i, "disposition": rec[14],
                "uniqueid": rec[16] if len(rec) > 16 else "",
                "quality": qos["quality"], "media_rtt": qos["media_rtt"],
                "jitter": qos["jitter"], "loss": qos["loss"],
            })
        CDR_CACHE = rows[-CDR_KEEP:]
        CDR_MTIME = (mt, sz)
    except Exception:
        pass
    return CDR_CACHE


def db():
    os.makedirs("/var/lib/sip-panel", exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=5, check_same_thread=False)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA temp_store=MEMORY")
    con.execute("""CREATE TABLE IF NOT EXISTS sample (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        cpu REAL, mem REAL, disk REAL,
        rx_bps REAL, tx_bps REAL,
        online INTEGER, calls INTEGER
    )""")
    con.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)")
    return con


CON = db()


def kv_get(k, default=None):
    row = CON.execute("SELECT v FROM kv WHERE k=?", (k,)).fetchone()
    if not row:
        return default
    try:
        return json.loads(row[0])
    except Exception:
        return row[0]


def kv_set(k, v):
    CON.execute("INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)", (k, json.dumps(v)))


def online_count(cs):
    n = 0
    for c in cs or []:
        if c and "avail" in str(c.get("status") or "").lower():
            n += 1
    return n


def collect_proc():
    global PREV_RX, PREV_TX, PREV_NET_T
    now = time.time()
    used, total, mpct = mem()
    rx, tx, net_label = net()
    rx_bps = tx_bps = 0.0
    if PREV_RX is not None and PREV_NET_T and now > PREV_NET_T:
        dt = now - PREV_NET_T
        if dt > 0.4:
            rx_bps = max(0.0, (rx - PREV_RX) / dt)
            tx_bps = max(0.0, (tx - PREV_TX) / dt)
    PREV_RX, PREV_TX, PREV_NET_T = rx, tx, now
    ts = utcnow()
    load = " ".join(open("/proc/loadavg").read().split()[:3])
    cpu = finite(cpu_pct(), 0.0)
    mpct = finite(mpct, 0.0)
    rx_bps = finite(rx_bps, 0.0)
    tx_bps = finite(tx_bps, 0.0)
    try:
        talking = talking_exts()
    except Exception:
        talking = None
    with LOCK:
        host = kv_get("host") or {}
        host.update({
            "hostname": socket.gethostname(),
            "load": load,
            "cpu_pct": round(cpu, 1),
            "mem_used": used,
            "mem_total": total,
            "mem_pct": round(mpct, 1),
            "net": net_label,
            "rx_bytes": rx,
            "tx_bytes": tx,
            "rx_bps": round(rx_bps, 1),
            "tx_bps": round(tx_bps, 1),
            "received_at": ts,
        })
        if talking is not None:
            host["talking_exts"] = talking
        online = int(host.get("online_count") or 0)
        calls = int(host.get("active_calls") or 0)
        disk_pct = finite(host.get("disk_pct"), 0.0)
        kv_set("host", host)
        CON.execute(
            "INSERT INTO sample(ts,cpu,mem,disk,rx_bps,tx_bps,online,calls) VALUES(?,?,?,?,?,?,?,?)",
            (ts, host["cpu_pct"], host["mem_pct"], disk_pct, rx_bps, tx_bps, online, calls),
        )
        CON.execute(
            "DELETE FROM sample WHERE id NOT IN (SELECT id FROM sample ORDER BY id DESC LIMIT ?)",
            (KEEP_SAMPLES,),
        )
        CON.commit()


def collect_asterisk():
    cs = contacts()
    prev_cs = kv_get("contacts") or []
    if cs is None:
        cs = prev_cs
    calls, chans = call_stats()
    last_seen = kv_get("last_seen") or {}
    if not isinstance(last_seen, dict):
        last_seen = {}
    prev_online = set(str(x) for x in (kv_get("online_set") or []))
    ts = utcnow()
    now_online = set()
    for c in cs:
        if c and c.get("ext") and "avail" in str(c.get("status") or "").lower():
            now_online.add(str(c["ext"]))
    for ext in now_online:
        if ext not in prev_online:
            last_seen[ext] = ts
    online_set = sorted(now_online)
    dused, dtotal, dpct = disk()
    up_s = float(open("/proc/uptime").read().split()[0])
    days = int(up_s // 86400)
    hours = int((up_s % 86400) // 3600)
    talking = talking_exts()
    with LOCK:
        host = kv_get("host") or {}
        host.update({
            "uptime": "%dd %dh" % (days, hours),
            "disk_used": dused,
            "disk_total": dtotal,
            "disk_pct": int(finite(dpct, 0)),
            "asterisk": sh("systemctl is-active asterisk") or "unknown",
            "active_calls": int(calls),
            "active_channels": int(chans),
            "talking_exts": talking,
            "online_count": online_count(cs),
            "applied_rev": kv_get("applied_rev", 0),
            "apply_error": kv_get("apply_error", "") or "",
        })
        kv_set("host", host)
        kv_set("contacts", cs)
        kv_set("last_seen", last_seen)
        kv_set("online_set", online_set)
        kv_set("cdr", cdr_rows())
        CON.commit()


def history():
    rows = CON.execute(
        "SELECT ts,cpu,mem,disk,rx_bps,tx_bps,online,calls FROM sample ORDER BY id ASC"
    ).fetchall()
    out = []
    for r in rows:
        out.append({
            "t": r[0], "cpu": r[1] or 0, "mem": r[2] or 0, "disk": r[3] or 0,
            "rx": r[4] or 0, "tx": r[5] or 0, "online": r[6] or 0, "calls": r[7] or 0,
        })
    return out


def status_payload():
    with LOCK:
        host = kv_get("host") or {}
        host["contacts"] = kv_get("contacts") or []
        host["last_seen"] = kv_get("last_seen") or {}
        host["cdr"] = kv_get("cdr") or []
        host["history"] = history()
        host["applied_rev"] = kv_get("applied_rev", 0)
        host["apply_error"] = kv_get("apply_error", "") or ""
        return host


def pull_config():
    global LAST_PULL
    if time.time() - LAST_PULL < PULL_SEC:
        return
    LAST_PULL = time.time()
    if not TOKEN:
        return
    try:
        applied = kv_get("applied_rev", 0)
        try:
            applied = int(open("/var/lib/sip-panel/applied_rev").read().strip() or "0")
        except Exception:
            pass
        url = PULL_URL + "?applied=" + str(int(applied or 0))
        req = urllib.request.Request(
            url,
            headers={
                "X-Heartbeat-Token": TOKEN,
                "User-Agent": "sip-statusd/1.0",
            },
        )
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as e:
        with LOCK:
            kv_set("apply_error", "拉取配置失败: " + str(e))
            CON.commit()
        return
    if not data.get("ok"):
        with LOCK:
            kv_set("apply_error", data.get("msg") or "拉取配置被拒绝")
            CON.commit()
        return
    if not data.get("pending"):
        rev = int(data.get("config_rev") or 0)
        with LOCK:
            kv_set("applied_rev", rev)
            kv_set("apply_error", "")
            CON.commit()
        return
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("hb", "/usr/local/sbin/sip-heartbeat.py")
        hb = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hb)
        hb.apply_config(data.get("extensions") or [], data.get("groups") or [], data.get("gateways") or [])
        rev = int(data.get("config_rev") or 0)
        hb.write_rev(rev)
        hb.write_err("")
        with LOCK:
            kv_set("applied_rev", rev)
            kv_set("apply_error", "")
            CON.commit()
    except Exception as e:
        with LOCK:
            kv_set("apply_error", str(e))
            CON.commit()


def loop():
    global LAST_AST
    while True:
        t0 = time.time()
        try:
            collect_proc()
        except Exception:
            pass
        if t0 - LAST_AST >= AST_SEC:
            LAST_AST = t0
            try:
                collect_asterisk()
            except Exception:
                pass
            try:
                pull_config()
            except Exception:
                pass
        time.sleep(max(0.2, SAMPLE_SEC - (time.time() - t0)))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def _send(self, code, obj, extra=None):
        body = json.dumps(obj, allow_nan=False, separators=(",", ":")).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/health", "/", "/healthz"):
            self._send(200, {"ok": True, "service": "sip-statusd"})
            return
        if path in ("/status", "/api/status", "/api/sip/status"):
            tok = self.headers.get("X-Heartbeat-Token") or ""
            if not TOKEN or tok != TOKEN:
                self._send(401, {"ok": False, "msg": "unauthorized"})
                return
            st = status_payload()
            st["ok"] = True
            self._send(200, st)
            return
        self._send(404, {"ok": False, "msg": "not found"})


def main():
    global TOKEN
    try:
        TOKEN = open(TOKEN_PATH).read().strip()
    except Exception:
        TOKEN = ""
    try:
        collect_proc()
        collect_asterisk()
    except Exception:
        pass
    th = threading.Thread(target=loop, name="collect", daemon=True)
    th.start()
    httpd = ThreadingHTTPServer((BIND, PORT), Handler)
    httpd.serve_forever()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Queue SIP SMS when MessageSend fails; flush after the dest is Avail."""
import argparse
import base64
import os
import re
import sqlite3
import sys
import time

DB_PATH = os.environ.get("SMS_QUEUE_DB", "/var/lib/sip-panel/sms_queue.sqlite")
OUTGOING_DIR = os.environ.get("SMS_QUEUE_OUTGOING", "/var/spool/asterisk/outgoing")
MAX_BODY = 1024
MAX_PER_DST = 50
MAX_RETRIES = 30
TTL_SEC = 7 * 24 * 3600
INFLIGHT_SEC = 120
FLUSH_BATCH = 3
DST_RE = re.compile(r"^[0-9]{3,6}$")
FROM_RE = re.compile(r"^[0-9A-Za-z+]{1,16}$")


def utc_now():
    return time.time()


def ensure_db_perms(path):
    try:
        import grp
        import pwd
        uid = pwd.getpwnam("asterisk").pw_uid
        gid = grp.getgrnam("asterisk").gr_gid
        os.chown(path, uid, gid)
        os.chmod(path, 0o660)
        for extra in (path + "-wal", path + "-shm"):
            if os.path.exists(extra):
                os.chown(extra, uid, gid)
                os.chmod(extra, 0o660)
    except Exception:
        pass


def connect(path=None):
    db = path or DB_PATH
    parent = os.path.dirname(db)
    if parent:
        os.makedirs(parent, exist_ok=True)
    con = sqlite3.connect(db, timeout=5)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute(
        """CREATE TABLE IF NOT EXISTS sms_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at REAL NOT NULL,
            dst TEXT NOT NULL,
            from_user TEXT NOT NULL,
            body TEXT NOT NULL,
            gw TEXT,
            status TEXT NOT NULL DEFAULT 'queued',
            retries INTEGER NOT NULL DEFAULT 0,
            last_try REAL,
            delivered_at REAL
        )"""
    )
    con.execute(
        "CREATE INDEX IF NOT EXISTS idx_sms_queue_dst_status ON sms_queue(dst, status)"
    )
    ensure_db_perms(db)
    return con


def is_avail(status):
    s = (status or "").strip().lower()
    return s in ("avail", "available")


def is_reachable(status):
    """Qualify-disabled gateways stay NonQual while registered."""
    s = (status or "").strip().lower()
    return s in ("avail", "available", "nonqual")


def validate_dst(dst):
    dst = (dst or "").strip()
    if not DST_RE.match(dst):
        return ""
    return dst


def validate_from(from_user):
    from_user = (from_user or "").strip()
    if not FROM_RE.match(from_user):
        return ""
    return from_user


def decode_body(raw, is_b64=True):
    if raw is None:
        return ""
    if not is_b64:
        body = raw
    else:
        try:
            pad = (-len(raw)) % 4
            body = base64.b64decode(raw + ("=" * pad), validate=False).decode("utf-8")
        except Exception:
            return ""
    body = body.replace("\x00", "").strip()
    if not body:
        return ""
    encoded = body.encode("utf-8")
    if len(encoded) > MAX_BODY:
        body = encoded[:MAX_BODY].decode("utf-8", "ignore").strip()
    return body


def expire(con, now=None):
    now = utc_now() if now is None else now
    con.execute(
        "DELETE FROM sms_queue WHERE created_at < ? OR (status = 'failed')",
        (now - TTL_SEC,),
    )
    con.execute(
        """UPDATE sms_queue
           SET status='queued'
           WHERE status='inflight' AND (last_try IS NULL OR last_try < ?)""",
        (now - INFLIGHT_SEC,),
    )


def store(con, dst, from_user, body, gw="", now=None):
    dst = validate_dst(dst)
    from_user = validate_from(from_user)
    body = (body or "").replace("\x00", "").strip()
    if not dst or not from_user or not body:
        return None
    if len(body.encode("utf-8")) > MAX_BODY:
        body = body.encode("utf-8")[:MAX_BODY].decode("utf-8", "ignore").strip()
        if not body:
            return None
    now = utc_now() if now is None else now
    expire(con, now)
    n = con.execute(
        "SELECT COUNT(*) FROM sms_queue WHERE dst=? AND status IN ('queued','inflight')",
        (dst,),
    ).fetchone()[0]
    while n >= MAX_PER_DST:
        row = con.execute(
            """SELECT id FROM sms_queue
               WHERE dst=? AND status IN ('queued','inflight')
               ORDER BY created_at ASC, id ASC LIMIT 1""",
            (dst,),
        ).fetchone()
        if not row:
            break
        con.execute("DELETE FROM sms_queue WHERE id=?", (row["id"],))
        n -= 1
    cur = con.execute(
        """INSERT INTO sms_queue(created_at, dst, from_user, body, gw, status, retries)
           VALUES (?, ?, ?, ?, ?, 'queued', 0)""",
        (now, dst, from_user, body, (gw or "").strip()),
    )
    con.commit()
    return int(cur.lastrowid)


def claim_batch(con, dst, now=None, limit=FLUSH_BATCH):
    dst = validate_dst(dst)
    if not dst:
        return []
    now = utc_now() if now is None else now
    expire(con, now)
    rows = con.execute(
        """SELECT id, dst, from_user, body, gw, retries
           FROM sms_queue
           WHERE dst=? AND status='queued'
           ORDER BY created_at ASC, id ASC
           LIMIT ?""",
        (dst, int(limit)),
    ).fetchall()
    claimed = []
    for row in rows:
        cur = con.execute(
            """UPDATE sms_queue
               SET status='inflight', last_try=?, retries=retries+1
               WHERE id=? AND status='queued'""",
            (now, row["id"]),
        )
        if cur.rowcount == 1:
            claimed.append(dict(row))
    con.commit()
    return claimed


def ack(con, qid, success, now=None):
    try:
        qid = int(qid)
    except Exception:
        return False
    now = utc_now() if now is None else now
    row = con.execute(
        "SELECT id, retries, status FROM sms_queue WHERE id=?", (qid,)
    ).fetchone()
    if not row:
        return False
    if success:
        con.execute("DELETE FROM sms_queue WHERE id=?", (qid,))
        con.commit()
        return True
    if int(row["retries"] or 0) >= MAX_RETRIES:
        con.execute("DELETE FROM sms_queue WHERE id=?", (qid,))
        con.commit()
        return True
    con.execute(
        "UPDATE sms_queue SET status='queued', last_try=? WHERE id=?",
        (now, qid),
    )
    con.commit()
    return True


def queued_dests(con):
    expire(con)
    rows = con.execute(
        "SELECT DISTINCT dst FROM sms_queue WHERE status IN ('queued','inflight')"
    ).fetchall()
    return [r["dst"] for r in rows]


def write_call_file(outgoing, dst, from_user, body, qid):
    dst = validate_dst(dst)
    from_user = validate_from(from_user)
    if not dst or not from_user or not body:
        return None
    b64 = base64.b64encode(body.encode("utf-8")).decode("ascii")
    if any(ch in b64 for ch in ("\n", "\r", ";")):
        return None
    content = (
        "Channel: Local/%s@sms-flush/n\n"
        "MaxRetries: 0\n"
        "RetryTime: 30\n"
        "WaitTime: 15\n"
        "Set: QUEUE_FROM=%s\n"
        "Set: QUEUE_BODY_B64=%s\n"
        "Set: QUEUE_ID=%s\n"
        "Application: Wait\n"
        "Data: 30\n"
    ) % (dst, from_user, b64, int(qid))
    os.makedirs(outgoing, exist_ok=True)
    tmp_dir = os.path.dirname(DB_PATH) or "/tmp"
    os.makedirs(tmp_dir, exist_ok=True)
    tmp = os.path.join(tmp_dir, "smsq-%s.tmp" % int(qid))
    final = os.path.join(outgoing, "smsq-%s.call" % int(qid))
    with open(tmp, "w", encoding="ascii", newline="\n") as f:
        f.write(content)
    try:
        os.replace(tmp, final)
    except OSError:
        import shutil
        shutil.copyfile(tmp, final)
        try:
            os.remove(tmp)
        except Exception:
            pass
    try:
        os.chmod(final, 0o640)
    except Exception:
        pass
    return final


def flush_available(online_exts, con=None, outgoing=None):
    own = con is None
    if own:
        con = connect()
    try:
        expire(con)
        want = set(validate_dst(x) for x in (online_exts or []))
        want.discard("")
        if not want:
            return 0
        dests = [d for d in queued_dests(con) if d in want]
        n = 0
        outdir = outgoing or OUTGOING_DIR
        for dst in dests:
            for row in claim_batch(con, dst):
                path = write_call_file(
                    outdir, row["dst"], row["from_user"], row["body"], row["id"]
                )
                if not path:
                    ack(con, row["id"], False)
                    continue
                n += 1
        return n
    finally:
        if own:
            con.close()


def _agi_read_env():
    env = {}
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.rstrip("\r\n")
        if line == "":
            break
        if ":" in line:
            k, v = line.split(":", 1)
            env[k.strip()] = v.strip()
    return env


def _agi_cmd(cmd):
    sys.stdout.write(cmd + "\n")
    sys.stdout.flush()
    return sys.stdin.readline().rstrip("\r\n")


def _agi_get(name):
    raw = _agi_cmd("GET VARIABLE %s" % name)
    if "result=1" not in raw:
        return ""
    lb = raw.find("(")
    rb = raw.rfind(")")
    if lb >= 0 and rb > lb:
        return raw[lb + 1 : rb]
    return ""


def _agi_set(name, value):
    value = str(value).replace("\n", " ").replace("\r", " ")
    _agi_cmd('SET VARIABLE %s "%s"' % (name, value.replace('"', "")))


def _agi_verbose(msg):
    msg = msg.replace('"', "'")
    _agi_cmd('VERBOSE "%s" 1' % msg)


def agi_main(action=None):
    env = _agi_read_env()
    if not action:
        action = (env.get("agi_arg_1") or "").strip()
    con = connect()
    try:
        if action == "store":
            dst = validate_dst(_agi_get("QUEUE_DST"))
            from_user = validate_from(_agi_get("QUEUE_FROM"))
            body = decode_body(_agi_get("QUEUE_BODY_B64"), True)
            gw = (_agi_get("GW") or "").strip()
            qid = store(con, dst, from_user, body, gw)
            if qid is None:
                _agi_set("SMS_QID", "")
                _agi_verbose("SMS queue store rejected dst=%s" % dst)
                return 1
            _agi_set("SMS_QID", qid)
            _agi_verbose("SMS queue stored id=%s dst=%s" % (qid, dst))
            return 0
        if action in ("ack", "ackfail"):
            qid = _agi_get("QUEUE_ID")
            status = _agi_get("MESSAGE_SEND_STATUS")
            success = action == "ack" and status == "SUCCESS"
            ack(con, qid, success)
            _agi_verbose(
                "SMS queue ack id=%s success=%s status=%s"
                % (qid, success, status)
            )
            return 0
        _agi_verbose("SMS queue unknown action")
        return 1
    finally:
        con.close()


def cli_main(argv=None):
    p = argparse.ArgumentParser(prog="sms-queue")
    sub = p.add_subparsers(dest="cmd", required=True)
    st = sub.add_parser("store")
    st.add_argument("--dst", required=True)
    st.add_argument("--from-user", required=True)
    st.add_argument("--body", required=True)
    st.add_argument("--gw", default="")
    ac = sub.add_parser("ack")
    ac.add_argument("--id", required=True)
    ac.add_argument("--success", action="store_true")
    sub.add_parser("list")
    fl = sub.add_parser("flush")
    fl.add_argument("--online", required=True, help="comma-separated dests")
    args = p.parse_args(argv)
    con = connect()
    try:
        if args.cmd == "store":
            qid = store(con, args.dst, args.from_user, args.body, args.gw)
            if qid is None:
                sys.stderr.write("store rejected\n")
                return 1
            sys.stdout.write("%s\n" % qid)
            return 0
        if args.cmd == "ack":
            ack(con, args.id, bool(args.success))
            return 0
        if args.cmd == "list":
            rows = con.execute(
                "SELECT id,dst,status,retries,from_user FROM sms_queue ORDER BY id"
            ).fetchall()
            for r in rows:
                sys.stdout.write(
                    "%s %s %s retries=%s from=%s\n"
                    % (r["id"], r["dst"], r["status"], r["retries"], r["from_user"])
                )
            return 0
        if args.cmd == "flush":
            online = [x.strip() for x in args.online.split(",") if x.strip()]
            n = flush_available(online, con=con)
            sys.stdout.write("%s\n" % n)
            return 0
        return 1
    finally:
        con.close()


if __name__ == "__main__":
    if any(a.startswith("-") for a in sys.argv[1:]):
        sys.exit(cli_main() or 0)
    if len(sys.argv) > 1 and sys.argv[1] in ("store", "ack", "ackfail"):
        sys.exit(agi_main(sys.argv[1]) or 0)
    if len(sys.argv) > 1:
        sys.exit(cli_main() or 0)
    sys.exit(agi_main() or 0)

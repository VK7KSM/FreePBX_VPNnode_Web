#!/usr/bin/env python3
import json, os, socket, subprocess, time, urllib.request, urllib.error, sys

TOKEN_PATH = "/etc/sip-heartbeat.token"
URL = "https://v.elfradio.net/api/sip/heartbeat"


def sh(cmd):
    try:
        return subprocess.check_output(cmd, shell=True, text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return ""


CPU_SNAP = "/run/sip-panel-cpu"

def cpu_pct():
    def snap():
        with open("/proc/stat") as f:
            p = f.readline().split()
        nums = [int(x) for x in p[1:]]
        idle = nums[3] + nums[4]
        total = sum(nums)
        return idle, total
    i2, t2 = snap()
    i1 = t1 = None
    try:
        a, b = open(CPU_SNAP).read().split()
        i1, t1 = int(a), int(b)
    except Exception:
        i1 = t1 = None
    try:
        open(CPU_SNAP, "w").write("%s %s" % (i2, t2))
    except Exception:
        pass
    if i1 is None or t1 is None:
        return 0.0
    dt, di = (t2 - t1), (i2 - i1)
    if dt <= 0:
        return 0.0
    return round(100.0 * (1.0 - di / dt), 1)


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
                label = "rx " + str(round(rx/1024/1024, 1)) + "MB / tx " + str(round(tx/1024/1024, 1)) + "MB"
                return rx, tx, label
    return 0, 0, "-"


def call_stats():
    raw = sh("asterisk -rx 'core show channels count'")
    calls = 0
    chans = 0
    for line in raw.splitlines():
        low = line.lower()
        parts = line.split()
        if not parts:
            continue
        try:
            n = int(parts[0])
        except Exception:
            continue
        if "active call" in low:
            calls = n
        elif "active channel" in low:
            chans = n
    return calls, chans


def contacts():
    import re
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
            "ext": ext,
            "uri": uri,
            "ip": ip,
            "port": port,
            "transport": transport,
            "status": status,
            "rtt": rtt_ms,
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
    return {
        "quality": quality,
        "media_rtt": rtt or "-",
        "jitter": jitter or "-",
        "loss": loss if loss != "" else "-",
    }


def cdr_rows():
    import csv
    path = "/var/log/asterisk/cdr-csv/Master.csv"
    rows = []
    if not os.path.isfile(path):
        return rows
    with open(path, newline="") as f:
        reader = csv.reader(f)
        for rec in reader:
            if len(rec) < 15:
                continue
            src, dst = rec[1], rec[2]
            clid, start, answer, end = rec[4], rec[9], rec[10], rec[11]
            duration, billsec, disp, uid = rec[12], rec[13], rec[14], rec[16] if len(rec) > 16 else ""
            userfield = rec[17] if len(rec) > 17 else ""
            qos = parse_qos(userfield)
            try:
                dur_i = int(float(duration or 0))
            except Exception:
                dur_i = 0
            try:
                bill_i = int(float(billsec or 0))
            except Exception:
                bill_i = 0
            rows.append({
                "time": start,
                "answer": answer,
                "end": end,
                "src": src,
                "dst": dst,
                "clid": clid,
                "duration": dur_i,
                "billsec": bill_i,
                "disposition": disp,
                "uniqueid": uid,
                "quality": qos["quality"],
                "media_rtt": qos["media_rtt"],
                "jitter": qos["jitter"],
                "loss": qos["loss"],
            })
    return rows[-500:]


AST = "/etc/asterisk"
REV_PATH = "/var/lib/sip-panel/applied_rev"
ERR_PATH = "/var/lib/sip-panel/apply_error"
PROTECTED = {"300"}
SEC_RE = __import__("re").compile(r"^\[([^\]]+)\]\s*$", __import__("re").M)
PANEL_EXT = "/etc/asterisk/extensions.conf"
PANEL_SMS = "/etc/asterisk/freepbx-pixel-sms.conf"


def read_rev():
    try:
        return int(open(REV_PATH).read().strip() or "0")
    except Exception:
        return 0


def write_rev(n):
    os.makedirs("/var/lib/sip-panel", exist_ok=True)
    open(REV_PATH, "w").write(str(int(n)))


def write_err(msg):
    os.makedirs("/var/lib/sip-panel", exist_ok=True)
    open(ERR_PATH, "w").write(msg or "")


def split_sections(text):
    matches = list(SEC_RE.finditer(text))
    header = text[: matches[0].start()] if matches else text
    parts = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        parts.append([m.group(1), text[m.start() : end]])
    return header, parts


def join_sections(header, parts):
    return header + "".join(body for _, body in parts)


def set_kv(body, key, value):
    lines = body.splitlines(True)
    out = []
    found = False
    prefix = key + "="
    want = None if value is None else str(value)
    for line in lines:
        raw = line.lstrip()
        if raw.startswith(prefix) or raw.startswith(key + " ="):
            found = True
            if want is None:
                continue
            cur = raw.split("=", 1)[1].strip() if "=" in raw else ""
            if cur == want:
                out.append(line)
            else:
                out.append("%s=%s\n" % (key, want))
        else:
            out.append(line)
    if not found and want is not None:
        if out and not out[-1].endswith("\n"):
            out.append("\n")
        out.append("%s=%s\n" % (key, want))
    return "".join(out)


def write_if_changed(path, content):
    old = ""
    try:
        old = open(path, encoding="utf-8", errors="replace").read()
    except Exception:
        old = ""
    if old == content:
        return False
    open(path, "w", encoding="utf-8").write(content)
    return True


def get_kv(body, key):
    prefix = key + "="
    for line in body.splitlines():
        s = line.strip()
        if s.startswith(prefix):
            return s[len(prefix) :].strip()
    return ""


def template_aor(ext, gateway=False):
    return (
        "[%s]\n"
        "type=aor\n"
        "mailboxes=%s@device\n"
        "max_contacts=1\n"
        "remove_existing=yes\n"
        "maximum_expiration=7200\n"
        "minimum_expiration=60\n"
        "qualify_frequency=%s\n\n" % (ext, ext, "0" if gateway else "15")
    )


def template_auth(ext, password):
    return (
        "[%s-auth]\n"
        "type=auth\n"
        "auth_type=userpass\n"
        "password=%s\n"
        "username=%s\n\n" % (ext, password, ext)
    )


def template_endpoint(ext, name):
    cid = '%s <%s>' % (name or ext, ext)
    return (
        "[%s]\n"
        "type=endpoint\n"
        "allow_unauthenticated_options=no\n"
        "aors=%s\n"
        "auth=%s-auth\n"
        "tos_audio=ef\n"
        "tos_video=af41\n"
        "cos_audio=5\n"
        "cos_video=4\n"
        "allow=ulaw,alaw,gsm,g726,g722,h264,vp8\n"
        "context=from-internal\n"
        "callerid=%s\n"
        "dtmf_mode=rfc4733\n"
        "direct_media=no\n"
        "mailboxes=%s@device\n"
        "mwi_subscribe_replaces_unsolicited=yes\n"
        "aggregate_mwi=no\n"
        "use_avpf=no\n"
        "rtcp_mux=no\n"
        "max_audio_streams=1\n"
        "max_video_streams=1\n"
        "webrtc=no\n"
        "bundle=no\n"
        "ice_support=no\n"
        "media_use_received_transport=no\n"
        "trust_id_inbound=yes\n"
        "user_eq_phone=no\n"
        "send_connected_line=yes\n"
        "media_encryption=no\n"
        "timers=yes\n"
        "timers_min_se=90\n"
        "media_encryption_optimistic=no\n"
        "refer_blind_progress=yes\n"
        "rtp_timeout=30\n"
        "rtp_timeout_hold=300\n"
        "rtp_keepalive=0\n"
        "send_pai=yes\n"
        "rtp_symmetric=yes\n"
        "rewrite_contact=yes\n"
        "force_rport=yes\n"
        "language=en_AU\n"
        "one_touch_recording=on\n"
        "record_on_feature=apprecord\n"
        "record_off_feature=apprecord\n\n" % (ext, ext, ext, cid, ext)
    )


def apply_file(path, mutate):
    text = open(path, encoding="utf-8", errors="replace").read()
    new = mutate(text)
    if new != text:
        open(path, "w", encoding="utf-8").write(new)
        return True
    return False


def _ext_of(item):
    return str((item or {}).get("ext") or "").strip()


def merge_desired(exts, groups, gateways):
    desired = {}
    gw_set = set()
    for g in gateways or []:
        ext = _ext_of(g)
        if not ext:
            continue
        item = dict(g)
        item["_role"] = "gateway"
        desired[ext] = item
        gw_set.add(ext)
    for x in exts or []:
        ext = _ext_of(x)
        if not ext or ext in gw_set:
            continue
        item = dict(x)
        item["_role"] = "intranet"
        desired[ext] = item
    if not gw_set:
        raise RuntimeError("拒绝应用：至少需要一个网关账户")
    return desired, gw_set, groups or []


def write_panel_dialplan(gw_set):
    rejects = []
    for g in sorted(gw_set):
        rejects.append("exten => %s,1,NoOp(Reject direct dial of gateway %s)\n same => n,Hangup()\n" % (g, g))
    reject_block = "".join(rejects)
    qos = (
        "exten => h,1,NoOp(Write RTP QoS into CDR userfield)\n"
        " same => n,Set(CDR(userfield)=rxjitter=${RTPAUDIOQOSJITTER} rtt=${RTPAUDIOQOSRTT} lp=${RTPAUDIOQOSLOSS})\n"
        " same => n,Hangup()\n"
    )
    ext_conf = """[general]
static=yes
writeprotect=yes
clearglobalvars=no

[globals]

[from-internal]

""" + qos + """
exten => *43,1,Answer()
 same => n,Echo()
 same => n,Hangup()
exten => _04XXXXXXXX,1,Goto(outbound-pixel,${EXTEN},1)
exten => _1XXXXXXXXXX,1,Goto(outbound-pixel,${EXTEN},1)
exten => _00.,1,Goto(outbound-pixel,${EXTEN},1)
exten => _+.,1,Goto(outbound-pixel,${EXTEN},1)
""" + reject_block + """
exten => _XXX,1,Goto(internal-ext,${EXTEN},1)
exten => _XXXX,1,Goto(internal-ext,${EXTEN},1)
exten => _XXXXX,1,Goto(internal-ext,${EXTEN},1)
exten => _XXXXXX,1,Goto(internal-ext,${EXTEN},1)
exten => i,1,NoOp(Unhandled from-internal ${EXTEN})
 same => n,Hangup()

[internal-ext]
exten => _.,1,NoOp(Internal ${CHANNEL(endpoint)} -> ${EXTEN})
 same => n,GotoIf($["${DB(SIP/is_gw/${EXTEN})}" = "1"]?rej)
 same => n,Set(SG=${DB(SIP/group/${CHANNEL(endpoint)})})
 same => n,Set(DG=${DB(SIP/group/${EXTEN})})
 same => n,Set(POL=${DB(SIP/gpol/${SG})})
 same => n,ExecIf($["${SG}" = ""]?Set(POL=self))
 same => n,GotoIf($["${POL}" = "all"]?fwd)
 same => n,GotoIf($["${SG}" = "${DG}"]?fwd)
 same => n,GotoIf($["${POL}" = "peers" & "${DB(SIP/gpeer/${SG}/${DG})}" = "1"]?fwd)
 same => n,NoOp(Internal denied ${CHANNEL(endpoint)} -> ${EXTEN})
 same => n,Hangup()
 same => n(fwd),GotoIf($[${SIPFWDCOUNT} >= 3]?dial)
 same => n,GotoIf($["${DB(CF/${EXTEN})}" = ""]?dial)
 same => n,Set(__SIPFWDCOUNT=$[${SIPFWDCOUNT} + 1])
 same => n,Set(FWD=${DB(CF/${EXTEN})})
 same => n,GotoIf($[${LEN(${FWD})} <= 6]?cfint:cfext)
 same => n(cfint),Goto(from-internal,${FWD},1)
 same => n(cfext),Goto(outbound-pixel,${FWD},1)
 same => n(dial),Set(RT=${DB(CFRING/${EXTEN})})
 same => n,ExecIf($["${RT}" = ""]?Set(RT=60))
 same => n,Dial(PJSIP/${EXTEN},${RT})
 same => n,GotoIf($["${DIALSTATUS}" = "BUSY"]?busy)
 same => n,GotoIf($["${DIALSTATUS}" = "NOANSWER" | "${DIALSTATUS}" = "CANCEL" | "${DIALSTATUS}" = "CHANUNAVAIL"]?na)
 same => n,Hangup()
 same => n(busy),GotoIf($["${DB(CFB/${EXTEN})}" = ""]?hang)
 same => n,Set(FWD=${DB(CFB/${EXTEN})})
 same => n,GotoIf($[${LEN(${FWD})} <= 6]?bfint:bfext)
 same => n(bfint),Goto(from-internal,${FWD},1)
 same => n(bfext),Goto(outbound-pixel,${FWD},1)
 same => n(na),GotoIf($["${DB(CFU/${EXTEN})}" = ""]?hang)
 same => n,Set(FWD=${DB(CFU/${EXTEN})})
 same => n,GotoIf($[${LEN(${FWD})} <= 6]?ufint:ufext)
 same => n(ufint),Goto(from-internal,${FWD},1)
 same => n(ufext),Goto(outbound-pixel,${FWD},1)
 same => n(hang),Hangup()
 same => n(rej),Hangup()

[outbound-pixel]

""" + qos + """
exten => _.,1,NoOp(PSTN outbound ${CHANNEL(endpoint)} -> ${EXTEN})
 same => n,GotoIf($["${DB(SIP/is_gw/${CHANNEL(endpoint)})}" = "1"]?reject)
 same => n,GotoIf($["${DB(SIP/outbound/${CHANNEL(endpoint)})}" != "1"]?deny)
 same => n,Set(GW=${DB(SIP/extgw/${CHANNEL(endpoint)})})
 same => n,GotoIf($["${GW}" = ""]?reject)
 same => n,Dial(PJSIP/${FILTER(0-9+,${EXTEN})}@${GW},90)
 same => n,Hangup()
 same => n(deny),NoOp(Outbound denied for ${CHANNEL(endpoint)})
 same => n,Hangup()
 same => n(reject),NoOp(No gateway for ${CHANNEL(endpoint)})
 same => n,Hangup()

[from-pstn]
include => from-pstn-custom
exten => s,1,Set(DST=${DB(SIP/gwin/${CHANNEL(endpoint)})})
 same => n,GotoIf($["${DST}" = ""]?hang)
 same => n,Goto(from-did-direct,${DST},1)
 same => n(hang),Hangup()
exten => _.,1,Goto(s,1)

[from-did-direct]

""" + qos + """
exten => _X.,1,NoOp(Inbound DID ${EXTEN})
 same => n,GotoIf($["${DB(CF/${EXTEN})}" = ""]?dial)
 same => n,Set(FWD=${DB(CF/${EXTEN})})
 same => n,GotoIf($[${LEN(${FWD})} <= 6]?int:ext)
 same => n(int),Goto(from-internal,${FWD},1)
 same => n(ext),Goto(outbound-pixel,${FWD},1)
 same => n(dial),Set(RT=${DB(CFRING/${EXTEN})})
 same => n,ExecIf($["${RT}" = ""]?Set(RT=60))
 same => n,Dial(PJSIP/${EXTEN},${RT})
 same => n,Hangup()

[ext-did]
exten => _X.,1,Goto(from-did-direct,${EXTEN},1)

#include freepbx-pixel-sms.conf
#include freepbx-pixel-callerid.conf
"""
    sms_conf = """[from-internal-pixel-sms]
exten => _.,1,NoOp(Outbound SMS from ${CHANNEL(endpoint)} to ${EXTEN})
 same => n,Set(SRC=${CHANNEL(endpoint)})
 same => n,GotoIf($["${SRC}" = ""]?invalid)
 same => n,GotoIf($["${DB(SIP/sms/${SRC})}" != "1"]?invalid)
 same => n,Set(GW=${DB(SIP/extgw/${SRC})})
 same => n,GotoIf($["${GW}" = ""]?invalid)
 same => n,Set(SMS_NUMBER=${FILTER(0-9+,${EXTEN})})
 same => n,GotoIf($[${LEN(${SMS_NUMBER})} < 10]?invalid)
 same => n,GotoIf($[${LEN(${SMS_NUMBER})} > 15]?invalid)
 same => n,Set(MESSAGE(body)=SMS ${SMS_NUMBER}: ${MESSAGE(body)})
 same => n,MessageSend(pjsip:${GW},sip:${SRC}@sip.elfradio.net,sip:${GW}@sip.elfradio.net)
 same => n,NoOp(Outbound SMS submit status: ${MESSAGE_SEND_STATUS})
 same => n,Hangup()
 same => n(invalid),NoOp(Rejected outbound SMS)
 same => n,Hangup()

[from-pixel-sms]
exten => _.,1,NoOp(Inbound SMS on gateway ${CHANNEL(endpoint)})
 same => n,Set(GW=${CHANNEL(endpoint)})
 same => n,Set(DST=${DB(SIP/gwsms/${GW})})
 same => n,GotoIf($["${DST}" = ""]?invalid)
 same => n,Set(GSM_SMS_SENDER=${FILTER(0-9+,${MESSAGE_DATA(X-GSM-CallerID)})})
 same => n,GotoIf($[${LEN(${GSM_SMS_SENDER})} < 6]?invalid)
 same => n,GotoIf($[${LEN(${GSM_SMS_SENDER})} > 16]?invalid)
 same => n,Set(SIP_SMS_SENDER=${GSM_SMS_SENDER})
 same => n,GotoIf($["${GSM_SMS_SENDER:0:3}" = "+61" & ${LEN(${GSM_SMS_SENDER})} = 12]?australia)
 same => n,GotoIf($["${GSM_SMS_SENDER:0:3}" = "+86" & ${LEN(${GSM_SMS_SENDER})} = 14]?china)
 same => n,Goto(send)
 same => n(australia),Set(SIP_SMS_SENDER=0${GSM_SMS_SENDER:3})
 same => n,Goto(send)
 same => n(china),Set(SIP_SMS_SENDER=${GSM_SMS_SENDER:3})
 same => n(send),MessageSend(pjsip:${DST},sip:${SIP_SMS_SENDER}@sip.elfradio.net,sip:${DST}@sip.elfradio.net)
 same => n,NoOp(Inbound SMS submit status ${MESSAGE_SEND_STATUS} to ${DST})
 same => n,Hangup()
 same => n(invalid),NoOp(Rejected inbound SMS)
 same => n,Hangup()
"""
    changed = write_if_changed(PANEL_EXT, ext_conf)
    changed |= write_if_changed(PANEL_SMS, sms_conf)
    return changed


def apply_ast_db(desired, gw_set, groups):
    for fam in ("group", "gpol", "gpeer", "extgw", "is_gw", "gwin", "gwsms", "ggw"):
        sh("asterisk -rx 'database deltree SIP %s'" % fam)
    group_gw = {}
    group_ids = set()
    for g in groups:
        gid = str(g.get("id") or "").strip()
        if not gid:
            continue
        group_ids.add(gid)
        pol = g.get("internal") or "self"
        if pol not in ("self", "peers", "all"):
            pol = "self"
        sh("asterisk -rx 'database put SIP gpol/%s %s'" % (gid, pol))
        gw = str(g.get("gateway") or "").strip()
        if gw and gw in gw_set:
            group_gw[gid] = gw
            sh("asterisk -rx 'database put SIP ggw/%s %s'" % (gid, gw))
        if pol == "peers":
            peers = g.get("peers") or []
            for pid in peers:
                pid = str(pid or "").strip()
                if pid and pid != gid:
                    sh("asterisk -rx 'database put SIP gpeer/%s/%s 1'" % (gid, pid))
                    sh("asterisk -rx 'database put SIP gpeer/%s/%s 1'" % (pid, gid))
    for ext, item in desired.items():
        role = item.get("_role") or "intranet"
        if role == "gateway":
            sh("asterisk -rx 'database put SIP is_gw/%s 1'" % ext)
            sh("asterisk -rx 'database put SIP outbound/%s 0'" % ext)
            sh("asterisk -rx 'database put SIP sms/%s 0'" % ext)
            inn = str(item.get("inbound_fwd") or "").strip()
            smsf = str(item.get("sms_fwd") or "").strip()
            if inn:
                sh("asterisk -rx 'database put SIP gwin/%s %s'" % (ext, inn))
            if smsf:
                sh("asterisk -rx 'database put SIP gwsms/%s %s'" % (ext, smsf))
            continue
        gid = str(item.get("group_id") or "").strip()
        if gid and gid in group_ids:
            sh("asterisk -rx 'database put SIP group/%s %s'" % (ext, gid))
            if gid in group_gw:
                sh("asterisk -rx 'database put SIP extgw/%s %s'" % (ext, group_gw[gid]))
        sh("asterisk -rx 'database put SIP outbound/%s %s'" % (ext, "1" if item.get("outbound") else "0"))
        sh("asterisk -rx 'database put SIP sms/%s %s'" % (ext, "1" if item.get("sms") else "0"))
        ring = int(item.get("ringtimer") or 60)
        sh("asterisk -rx 'database put CFRING %s %s'" % (ext, ring))
        for key, field in (("CF", "cf"), ("CFB", "cf_busy"), ("CFU", "cf_noreply")):
            val = str(item.get(field) or "").strip()
            if val:
                sh("asterisk -rx 'database put %s %s %s'" % (key, ext, val))
            else:
                sh("asterisk -rx 'database del %s %s'" % (key, ext))


def apply_config(exts, groups=None, gateways=None):
    desired, gw_set, groups = merge_desired(exts, groups, gateways)

    def patch_endpoint(body, ext, item):
        nm = item.get("name") or ext
        body = set_kv(body, "callerid", "%s <%s>" % (nm, ext))
        if item.get("_role") == "gateway":
            body = set_kv(body, "context", "from-pstn")
            body = set_kv(body, "message_context", "from-pixel-sms")
        else:
            body = set_kv(body, "context", "from-internal")
            if item.get("sms"):
                body = set_kv(body, "message_context", "from-internal-pixel-sms")
            else:
                body = set_kv(body, "message_context", None)
        return body

    def mut_aor(text):
        header, parts = split_sections(text)
        have = {n: True for n, _ in parts}
        keep = []
        for name, body in parts:
            if name in desired:
                qf = "0" if desired[name].get("_role") == "gateway" else "15"
                body = set_kv(body, "qualify_frequency", qf)
                keep.append((name, body))
        for ext in desired:
            if ext not in have:
                keep.append((ext, template_aor(ext, desired[ext].get("_role") == "gateway")))
        return join_sections(header, keep)

    def mut_auth(text):
        header, parts = split_sections(text)
        have = {n: True for n, _ in parts}
        keep = []
        for name, body in parts:
            ext = name[:-5] if name.endswith("-auth") else name
            if ext in desired:
                pw = desired[ext].get("password")
                if pw:
                    body = set_kv(body, "password", pw)
                keep.append((name, body))
        for ext, item in desired.items():
            key = ext + "-auth"
            if key not in have:
                pw = item.get("password")
                if not pw:
                    raise RuntimeError("新分机 %s 没有密码，无法在 SIP 机上创建" % ext)
                keep.append((key, template_auth(ext, pw)))
        return join_sections(header, keep)

    def mut_ep(text):
        header, parts = split_sections(text)
        have = {n: True for n, _ in parts}
        keep = []
        for name, body in parts:
            if name in desired:
                keep.append((name, patch_endpoint(body, name, desired[name])))
        for ext, item in desired.items():
            if ext not in have:
                body = template_endpoint(ext, item.get("name") or ext)
                keep.append((ext, patch_endpoint(body, ext, item)))
        return join_sections(header, keep)

    pjsip_changed = False
    pjsip_changed |= apply_file(os.path.join(AST, "pjsip.aor.conf"), mut_aor)
    pjsip_changed |= apply_file(os.path.join(AST, "pjsip.auth.conf"), mut_auth)
    pjsip_changed |= apply_file(os.path.join(AST, "pjsip.endpoint.conf"), mut_ep)
    dp_changed = write_panel_dialplan(gw_set)
    apply_ast_db(desired, gw_set, groups)
    if pjsip_changed:
        sh("asterisk -rx 'pjsip reload'")
    if dp_changed:
        sh("asterisk -rx 'dialplan reload'")
    return True


def main():
    token = open(TOKEN_PATH).read().strip()
    used, total, mpct = mem()
    dused, dtotal, dpct = disk()
    load = " ".join(open("/proc/loadavg").read().split()[:3])
    up_s = float(open("/proc/uptime").read().split()[0])
    days = int(up_s // 86400)
    hours = int((up_s % 86400) // 3600)
    cs = contacts()
    if cs is None:
        payload_contacts_ok = False
        payload_contacts = None
    else:
        payload_contacts_ok = True
        payload_contacts = cs
    applied = read_rev()
    err = ""
    try:
        err = open(ERR_PATH).read().strip()
    except Exception:
        err = ""
    payload = {
        "hostname": socket.gethostname(),
        "uptime": "%dd %dh" % (days, hours),
        "load": load,
        "cpu_pct": cpu_pct(),
        "mem_used": used,
        "mem_total": total,
        "mem_pct": mpct,
        "disk_used": dused,
        "disk_total": dtotal,
        "disk_pct": dpct,
        "asterisk": sh("systemctl is-active asterisk") or "unknown",
        "cdr": cdr_rows(),
        "applied_rev": applied,
        "apply_error": err,
        "contacts_ok": payload_contacts_ok,
    }
    rx_b, tx_b, net_label = net()
    calls, chans = call_stats()
    payload["rx_bytes"] = rx_b
    payload["tx_bytes"] = tx_b
    payload["net"] = net_label
    payload["active_calls"] = calls
    payload["active_channels"] = chans
    if payload_contacts is not None:
        payload["contacts"] = payload_contacts
    req = urllib.request.Request(
        URL,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Heartbeat-Token": token,
            "User-Agent": "sip-heartbeat/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        sys.stderr.write("heartbeat http %s %s\n" % (e.code, e.read()[:300].decode("utf-8", "replace")))
        return
    except Exception as e:
        sys.stderr.write("heartbeat error %s\n" % e)
        return
    try:
        data = json.loads(raw)
    except Exception:
        return
    if not data.get("ok"):
        return
    if data.get("pending") and (isinstance(data.get("extensions"), list) or isinstance(data.get("gateways"), list)):
        try:
            apply_config(data.get("extensions") or [], data.get("groups") or [], data.get("gateways") or [])
            write_rev(data.get("config_rev") or applied)
            write_err("")
        except Exception as e:
            write_err(str(e))


if __name__ == "__main__":
    main()


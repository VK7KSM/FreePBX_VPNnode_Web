#!/usr/bin/env python3
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path
import re
import subprocess
import time

PRIVATE = Path("/etc/elfremote-mqtt")
PROVISION = "/usr/local/lib/elfremote-mqtt/provision.py"


def username(value):
    if not isinstance(value, str) or not re.fullmatch(r"d_[a-f0-9]{64}", value):
        raise ValueError("设备连接名称无效")
    return value


def notification(value, now=None):
    now = int(time.time() * 1000) if now is None else now
    if not isinstance(value, dict) or value.get("type") != "status_request":
        raise ValueError("只支持状态通知")
    if not isinstance(value.get("request_id"), str) or not re.fullmatch(r"[A-Za-z0-9-]{1,96}", value["request_id"]):
        raise ValueError("请求编号无效")
    for field in ("version", "expires_at_ms"):
        if type(value.get(field)) is not int or not 0 < value[field] <= 9007199254740991:
            raise ValueError("通知字段无效")
    if not now < value["expires_at_ms"] <= now + 600000:
        raise ValueError("通知已过期或有效期过长")
    return {key: value[key] for key in ("type", "request_id", "version", "expires_at_ms")}


class Backend:
    def __init__(self):
        import paho.mqtt.client as mqtt
        self.client = mqtt.Client(client_id="elfremote-control-plane", protocol=mqtt.MQTTv311)
        password = json.loads((PRIVATE / "credentials.json").read_text())["control-plane"]
        self.client.username_pw_set("control-plane", password)
        self.client.tls_set()
        self.client.reconnect_delay_set(1, 60)
        self.client.connect_async("mqtt.elfradio.net", 8883, 60)
        self.client.loop_start()

    def credentials(self, name):
        # 重跑维护工具会修复前次中断留下的密码文件，不仅检查原件是否存在。
        subprocess.run(["python3", PROVISION, name], check=True, timeout=10, stdout=subprocess.DEVNULL)
        password = json.loads((PRIVATE / "credentials.json").read_text())[name]
        return {"host": "mqtt.elfradio.net", "port": 8883, "tls": True, "username": name,
                "password": password, "client_id": name, "topic": "elfremote/" + name + "/notify",
                "keepalive_seconds": 900}

    def revoke(self, name):
        subprocess.run(["python3", PROVISION, name, "--delete"], check=True, timeout=10, stdout=subprocess.DEVNULL)

    def publish(self, name, payload):
        if not self.client.is_connected():
            raise RuntimeError("推送服务未连接")
        info = self.client.publish("elfremote/" + name + "/notify", json.dumps(payload, separators=(",", ":")), qos=1, retain=False)
        if info.rc != 0:
            raise RuntimeError("发布失败")
        deadline = time.monotonic() + 5
        while not info.is_published():
            if time.monotonic() > deadline:
                raise RuntimeError("发布回执超时")
            time.sleep(0.02)


def handler(token, backend):
    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, *args):
            pass

        def reply(self, code, body):
            encoded = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def do_POST(self):
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.reply(401, {"ok": False})
                return
            if self.path not in ("/v1/credentials", "/v1/publish", "/v1/revoke"):
                self.reply(404, {"ok": False})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 8192 or self.headers.get("Transfer-Encoding"):
                    raise ValueError("请求长度无效")
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError("请求不完整")
                data = json.loads(raw)
                if not isinstance(data, dict):
                    raise ValueError("请求无效")
                name = username(data.get("username"))
                if self.path == "/v1/credentials":
                    result = {"ok": True, "connection": backend.credentials(name)}
                elif self.path == "/v1/revoke":
                    backend.revoke(name)
                    result = {"ok": True}
                else:
                    payload = notification(data.get("notification"))
                    backend.publish(name, payload)
                    result = {"ok": True, "accepted": True, "request_id": payload["request_id"]}
                self.reply(200, result)
            except (ValueError, TypeError):
                self.reply(400, {"ok": False, "msg": "请求格式无效"})
            except Exception:
                self.reply(503, {"ok": False, "msg": "推送服务暂不可用"})
    return Handler


if __name__ == "__main__":
    token = (PRIVATE / "api-token").read_text().strip()
    if len(token) < 32:
        raise ValueError("服务凭据未配置")
    HTTPServer(("127.0.0.1", 8787), handler(token, Backend())).serve_forever()

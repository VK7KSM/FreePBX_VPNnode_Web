#!/usr/bin/env python3
import json
from pathlib import Path
import threading
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import uuid
import paho.mqtt.client as mqtt


token = Path("/etc/elfremote-mqtt/api-token").read_text().strip()
name = "d_" + uuid.uuid4().hex + uuid.uuid4().hex
client = None


def post(path, body, secret=token):
    request = Request("https://mqtt-api.elfradio.net/v1/" + path, data=json.dumps(body).encode(),
                      headers={"Authorization": "Bearer " + secret, "Content-Type": "application/json",
                               "User-Agent": "elfRemote-service-test/1.0"})
    with urlopen(request, timeout=20) as response:
        return json.load(response)


try:
    try:
        post("credentials", {"username": name}, "incorrect")
        raise AssertionError("未授权调用未被拒绝")
    except HTTPError as error:
        assert error.code == 401
    config = post("credentials", {"username": name})["connection"]
    assert post("credentials", {"username": name})["connection"] == config
    received, ready = threading.Event(), threading.Event()
    messages = []
    client = mqtt.Client(client_id=config["client_id"], protocol=mqtt.MQTTv311)
    client.username_pw_set(config["username"], config["password"])
    client.tls_set()
    client.on_connect = lambda c, u, f, rc: c.subscribe(config["topic"], qos=1) if rc == 0 else None
    client.on_subscribe = lambda c, u, mid, codes: ready.set()
    client.on_message = lambda c, u, message: (messages.append(json.loads(message.payload)), received.set())
    client.connect(config["host"], config["port"], 60)
    client.loop_start()
    assert ready.wait(10), "MQTT 订阅未完成"
    notification = {"type": "status_request", "request_id": str(uuid.uuid4()), "version": 1,
                    "expires_at_ms": int(time.time() * 1000) + 60000}
    reply = post("publish", {"username": name, "notification": notification})
    assert reply["accepted"] and reply["request_id"] == notification["request_id"]
    assert received.wait(10), "通知未送达"
    assert messages == [notification]
    print("通过：CF 隧道鉴权、凭据重复发放一致、HTTPS 发布与 MQTT/TLS 实际送达")
finally:
    if client:
        client.disconnect()
        client.loop_stop()
    # 公网入口失败时仍清理本机测试身份，保留最初的失败原因。
    import subprocess
    subprocess.run(["python3", "/usr/local/lib/elfremote-mqtt/provision.py", name, "--delete"], check=True)
    print("临时设备凭据已撤销")

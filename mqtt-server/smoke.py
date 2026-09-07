#!/usr/bin/env python3
import json
from pathlib import Path
import subprocess
import threading
import time
import uuid
import paho.mqtt.client as mqtt

PROVISION = "/usr/local/lib/elfremote-mqtt/provision.py"
clients = []
names = ["test-" + uuid.uuid4().hex for _ in range(2)]


def publish(client, topic, payload):
    info = client.publish(topic, payload, qos=1)
    deadline = time.monotonic() + 10
    while not info.is_published():
        assert time.monotonic() < deadline, "发布回执超时"
        time.sleep(0.05)


def connect(username=None, password=None, expected=0):
    client = mqtt.Client(client_id="check-" + uuid.uuid4().hex, protocol=mqtt.MQTTv5)
    clients.append(client)
    ready = threading.Event()
    codes = []
    client.on_connect = lambda c, u, f, rc, p: (codes.append(rc.value), ready.set())
    if username:
        client.username_pw_set(username, password)
    client.tls_set()
    client.connect("mqtt.elfradio.net", 8883, 60)
    client.loop_start()
    assert ready.wait(10), "连接回执超时"
    assert codes == [expected], "连接返回码不符: " + str(codes)
    return client


try:
    for name in names:
        subprocess.run(["python3", PROVISION, name], check=True)
    credentials = json.loads(Path("/etc/elfremote-mqtt/credentials.json").read_text())
    connect(expected=135)
    connect(names[0], "incorrect-test-password", expected=135)
    print("通过：匿名与错误密码拒绝")
    device = connect(names[0], credentials[names[0]])
    publisher = connect("control-plane", credentials["control-plane"])
    arrived = threading.Event()
    subscribed = threading.Event()
    messages = []
    topic = "elfremote/" + names[0] + "/notify"
    other = "elfremote/" + names[1] + "/notify"
    device.on_message = lambda c, u, m: (messages.append((m.topic, m.payload)), arrived.set())
    device.on_subscribe = lambda c, u, mid, codes, p: subscribed.set()
    device.subscribe([(topic, 1), (other, 1)])
    assert subscribed.wait(10), "订阅回执超时"
    payload = uuid.uuid4().hex.encode()
    publish(publisher, topic, payload)
    assert arrived.wait(10), "自己的通知未到达"
    assert messages == [(topic, payload)]
    arrived.clear()
    publish(publisher, other, b"other-device")
    assert not arrived.wait(2), "收到其它设备通知"
    print("通过：TLS连接、自己的通知送达、跨设备通知隔离")
    ack = threading.Event()
    device.on_publish = lambda c, u, mid: ack.set()
    # Paho 1.x 不暴露 MQTT 5 发布拒绝码，以其它合法接收者确实收不到判定。
    receiver = connect(names[1], credentials[names[1]])
    unwanted = threading.Event()
    ready = threading.Event()
    receiver.on_message = lambda c, u, m: unwanted.set()
    receiver.on_subscribe = lambda c, u, mid, codes, p: ready.set()
    receiver.subscribe(other, qos=1)
    assert ready.wait(10)
    publish(device, other, b"forbidden")
    assert ack.wait(10)
    assert not unwanted.wait(2), "设备越权发布成功"
    publish(publisher, other, b"allowed")
    assert unwanted.wait(10), "对照接收通路不通"
    print("通过：设备不能发布通知，控制面发布正常")
finally:
    for client in clients:
        client.disconnect()
        client.loop_stop()
    for name in names:
        subprocess.run(["python3", PROVISION, name, "--delete"], check=True)

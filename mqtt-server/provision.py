#!/usr/bin/env python3
import argparse
import fcntl
import grp
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description="维护 MQTT 独立连接凭据，不输出密码")
    parser.add_argument("username")
    parser.add_argument("--delete", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,96}", args.username):
        parser.error("用户名只能使用字母、数字、下划线和短横线")
    if os.geteuid() != 0:
        parser.error("需要管理员权限")
    private = Path("/etc/elfremote-mqtt")
    private.mkdir(mode=0o700, exist_ok=True)
    os.chmod(private, 0o700)
    with (private / "provision.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        credentials = private / "credentials.json"
        data = json.loads(credentials.read_text()) if credentials.exists() else {}
        if args.delete:
            data.pop(args.username, None)
        else:
            data.setdefault(args.username, secrets.token_urlsafe(32))
        # 先保存受保护原件，失败后重跑不会悄悄改变已生成的密码。
        fd, name = tempfile.mkstemp(dir=private)
        with os.fdopen(fd, "w") as output:
            json.dump(data, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, credentials)
        target = Path("/etc/mosquitto/elfremote")
        fd, name = tempfile.mkstemp(dir=target)
        try:
            with os.fdopen(fd, "w") as output:
                for username, password in data.items():
                    output.write(username + ":" + password + "\n")
            subprocess.run(["mosquitto_passwd", "-U", name], check=True)
            os.chown(name, 0, grp.getgrnam("mosquitto").gr_gid)
            os.chmod(name, 0o640)
            os.replace(name, target / "passwords")
        finally:
            Path(name).unlink(missing_ok=True)
        if subprocess.run(["systemctl", "is-active", "--quiet", "mosquitto"]).returncode == 0:
            subprocess.run(["systemctl", "reload", "mosquitto"], check=True)
    print("凭据已更新，密码未输出")


if __name__ == "__main__":
    main()

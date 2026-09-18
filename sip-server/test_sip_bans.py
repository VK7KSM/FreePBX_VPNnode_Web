import importlib.util
import pathlib
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location("sip_bans", pathlib.Path(__file__).parent / "files/usr/local/sbin/sip_bans.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BanTests(unittest.TestCase):
    def setUp(self):
        self.data = {"ban_endpoints": {e: {"ip": "192.0.2.1", "observed_at": time.time()} for e in ("109", "204")}}
        self.manager = module.BanManager(self.data.get, self.data.__setitem__, lambda: None, threading.Lock())
        self.calls = []
        self.banned = {"192.0.2.1", "198.51.100.1"}

        def command(*args):
            self.calls.append(args)
            if args[:2] == ("get", "asterisk"):
                return " ".join(self.banned)
            if args[2] == "unbanip":
                self.banned.discard(args[3])
            else:
                self.banned.add(args[3])
            return "1"
        self.manager.command = command

    def test_shared_ip_unban_preserves_other_bans(self):
        result = self.manager.action("204", "unban", "192.0.2.1")
        self.assertEqual(result["affected"], ["109", "204"])
        self.assertFalse(result["banned"])
        self.assertEqual(self.banned, {"198.51.100.1"})

    def test_changed_ip_and_shell_input_rejected_without_command(self):
        for ext, action, ip in [("204", "unban", "192.0.2.2"), ("204;id", "ban", "192.0.2.1"), ("204", "stop", "192.0.2.1")]:
            with self.assertRaises(ValueError):
                self.manager.action(ext, action, ip)
        self.assertEqual(self.calls, [])

    def test_ban_is_verified(self):
        self.banned.clear()
        self.assertTrue(self.manager.action("109", "ban", "192.0.2.1")["banned"])

    def test_backend_failure_is_not_success(self):
        self.manager.command = lambda *args: "192.0.2.1"
        with self.assertRaises(RuntimeError):
            self.manager.action("204", "unban", "192.0.2.1")


if __name__ == "__main__":
    unittest.main()

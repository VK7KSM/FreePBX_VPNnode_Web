import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent / "files/usr/local/sbin"))
import gateway_watch  # noqa: E402
from gateway_watch import GatewayWatch, UNREACHABLE_SEC, COOLDOWN_SEC  # noqa: E402


def row(ext, status, port="45483", ip="198.51.100.7"):
    return {"ext": ext, "ip": ip, "port": port, "status": status}


class WatchTests(unittest.TestCase):
    def setUp(self):
        self.drops, self.logs = [], []
        self.watch = GatewayWatch(drop=lambda ip, port: self.drops.append((ip, port)) or True,
                                  log=lambda *a, **k: self.logs.append(a[0]))

    def test_drops_once_after_sustained_unreachable(self):
        w = self.watch
        w.check([row("300", "Unavail")], {"300"}, 1000)
        w.check([row("300", "Unavail")], {"300"}, 1000 + UNREACHABLE_SEC - 1)
        self.assertEqual(self.drops, [])
        w.check([row("300", "Unavail")], {"300"}, 1000 + UNREACHABLE_SEC)
        self.assertEqual(self.drops, [("198.51.100.7", "45483")])
        self.assertIn("300 unreachable", self.logs[0])
        # 冷却期内不再断
        w.check([row("300", "Unavail")], {"300"}, 1000 + UNREACHABLE_SEC + COOLDOWN_SEC - 1)
        self.assertEqual(len(self.drops), 1)
        w.check([row("300", "Unavail")], {"300"}, 1000 + UNREACHABLE_SEC + COOLDOWN_SEC)
        self.assertEqual(len(self.drops), 2)

    def test_recovery_or_new_connection_resets_the_clock(self):
        w = self.watch
        w.check([row("300", "Unavail")], {"300"}, 1000)
        w.check([row("300", "Avail")], {"300"}, 1100)
        w.check([row("300", "Unavail")], {"300"}, 1200)
        w.check([row("300", "Unavail")], {"300"}, 1200 + UNREACHABLE_SEC - 1)
        self.assertEqual(self.drops, [])
        w.check([row("300", "Unavail", port="43239")], {"300"}, 1200 + UNREACHABLE_SEC + 10)
        self.assertEqual(self.drops, [], "换了新连接要重新计时")

    def test_only_gateways_are_watched(self):
        w = self.watch
        w.check([row("101", "Unavail"), row("300", "NonQual")], {"300"}, 1000)
        w.check([row("101", "Unavail"), row("300", "NonQual")], {"300"}, 1000 + 10 * UNREACHABLE_SEC)
        self.assertEqual(self.drops, [])

    def test_drop_rejects_bad_addresses_without_running_ss(self):
        calls = []
        orig = gateway_watch.subprocess.run
        gateway_watch.subprocess.run = lambda *a, **k: calls.append(a)
        try:
            for ip, port in [("1.2.3.4;id", "5"), ("198.51.100.7", "0"), ("198.51.100.7", "x"), (None, None)]:
                self.assertFalse(gateway_watch.drop_connection(ip, port))
        finally:
            gateway_watch.subprocess.run = orig
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()

import importlib.util
import pathlib
import sys
import threading
import time
import unittest

SBIN = pathlib.Path(__file__).parent / "files/usr/local/sbin"
sys.path.insert(0, str(SBIN))
spec = importlib.util.spec_from_file_location("sip_bans", SBIN / "sip_bans.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
import sip_parse  # noqa: E402


def with_time(ips):
    return "\n".join(f"{ip} \t2026-09-24 02:00:00 + 3600 = 2026-09-24 03:00:00" for ip in sorted(ips))


class BanTests(unittest.TestCase):
    def setUp(self):
        self.data = {"ban_endpoints": {e: {"ip": "192.0.2.1", "observed_at": time.time()} for e in ("109", "204")}}
        self.manager = module.BanManager(self.data.get, self.data.__setitem__, lambda: None, threading.Lock())
        self.manager.iptables = lambda: "-A INPUT -p tcp -m tcp --dport 5061 -j ACCEPT\n"
        self.calls = []
        self.banned = {"192.0.2.1", "198.51.100.1"}

        def command(*args):
            self.calls.append(args)
            if args[:3] == ("get", "asterisk", "banip"):
                return with_time(self.banned) if "--with-time" in args else " ".join(self.banned)
            if args[:2] == ("get", "asterisk"):
                return {"ignoreip": "These IP addresses/networks are ignored:\n`- 127.0.0.1/8"}.get(args[2], "15")
            if args[2] == "unbanip":
                self.banned.discard(args[3])
            else:
                self.banned.add(args[3])
            return "1"
        self.manager.command = command

    def mutating(self):
        return [c for c in self.calls if c[0] == "set"]

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
        self.manager.command = lambda *args: with_time({"192.0.2.1"})
        with self.assertRaises(RuntimeError):
            self.manager.action("204", "unban", "192.0.2.1")

    def test_firewall_card_names_the_same_extensions_as_rows(self):
        state = self.manager.refresh([])
        card = {b["ip"]: b["exts"] for b in state["firewall"]["bans"]}
        self.assertEqual(card, {"192.0.2.1": ["109", "204"], "198.51.100.1": []})
        self.assertEqual(state["banned_ips"], ["192.0.2.1", "198.51.100.1"])
        self.assertEqual(state["firewall"]["rules"], {"maxretry": 15, "findtime": 15, "bantime": 15})
        self.assertEqual(state["firewall"]["ignoreip"], ["127.0.0.1/8"])
        self.assertTrue(state["firewall"]["ports"]["tls_5061"])
        self.assertFalse(state["firewall"]["ports"]["udp_5060"])

    def test_firewall_unban_releases_only_a_banned_address(self):
        result = self.manager.unban_ip("198.51.100.1")
        self.assertFalse(result["banned"])
        self.assertEqual(self.banned, {"192.0.2.1"})
        self.assertEqual([b["ip"] for b in self.data["ban_status"]["firewall"]["bans"]], ["192.0.2.1"])
        for bad in ("203.0.113.9", "1.2.3.4;id", "", None):
            with self.assertRaises(ValueError):
                self.manager.unban_ip(bad)
        self.assertEqual(self.mutating(), [("set", "asterisk", "unbanip", "198.51.100.1")])

    def test_unreadable_fail2ban_is_reported_not_empty(self):
        def broken(*args):
            raise OSError("no fail2ban")
        self.manager.command = broken
        state = self.manager.refresh([])
        self.assertFalse(state["available"])
        self.assertEqual(state["firewall"]["service"], "error")


TABLE = """
  Contact:  <Aor/ContactUri..............................> <Hash....> <Status> <RTT(ms)..>
==========================================================================================

  Contact:  203/sip:203@203.0.113.7:36864;transport=TL f967f993b1 Avail       220.555
  Contact:  205/sip:205@203.0.113.7:36870;transport=TL a1fc8d4177 Avail       286.091
  Contact:  101/sip:101@198.51.100.4:53216;transport=TLS; a15c8d81af Avail       560.869
  Contact:  301/sip:301@198.51.100.4:5060              1122334455 NonQual         nan

Objects found: 4
"""
REGISTRAR = """/registrar/contact/203;@f967f993b15a69788796a5b4c3d2e1f0: {"endpoint":"203","uri":"sip:203@203.0.113.7:36864;transport=TLS;ob;x-ast-orig-host=192.168.1.37:52627"}
/registrar/contact/205;@a1fc8d41775f60718293a4b5c6d7e8f9: {"endpoint":"205","uri":"sip:205@203.0.113.7:36870;transport=TLS;ob"}
"""


class ParseTests(unittest.TestCase):
    def test_truncated_cli_uri_uses_registrar_transport(self):
        rows = {r["ext"]: r for r in sip_parse.parse_contacts(TABLE, REGISTRAR)}
        self.assertEqual(rows["203"]["transport"], "TLS")
        self.assertEqual(rows["203"]["port"], "36864")
        self.assertIn("x-ast-orig-host", rows["203"]["uri"])
        self.assertEqual(rows["205"]["transport"], "TLS")
        self.assertEqual(rows["101"]["transport"], "TLS")
        self.assertEqual(rows["301"]["transport"], "UDP")
        self.assertEqual(rows["301"]["status"], "NonQual")
        self.assertIsNone(rows["301"]["rtt"])

    def test_truncated_uri_without_registrar_is_not_reported_as_udp(self):
        rows = {r["ext"]: r for r in sip_parse.parse_contacts(TABLE, "")}
        self.assertEqual(rows["203"]["transport"], "TLS")
        self.assertEqual(sip_parse.transport_of("sip:1@h;transport="), "?")
        self.assertIsNone(sip_parse.parse_contacts("Unable to connect", ""))

    def test_ban_times_are_epoch(self):
        bans = sip_parse.parse_bans("192.0.2.1 \t2026-09-24 02:00:00 + 3600 = 2026-09-24 03:00:00\nbad line")
        self.assertEqual(len(bans), 1)
        self.assertEqual(bans[0]["until"] - bans[0]["since"], 3600)
        self.assertEqual(sip_parse.parse_bans("192.0.2.1 \t2026-09-24 02:00:00 + -1 = 9999-12-31 23:59:59")[0]["until"], None)

    def test_ports_ignore_source_limited_rules(self):
        rules = ("-A INPUT -s 10.0.0.0/24 -j ACCEPT\n-A INPUT -s 10.0.0.0/24 -p udp --dport 5060 -j ACCEPT\n"
                 "-A INPUT -p udp -m udp --dport 10000:20000 -j ACCEPT\n"
                 "-A INPUT -p tcp -m multiport --dports 5060,5061 -j f2b-asterisk-tcp\n")
        self.assertEqual(sip_parse.parse_sip_ports(rules),
                         {"tls_5061": False, "tcp_5060": False, "udp_5060": False, "rtp": ["10000:20000"]})


if __name__ == "__main__":
    unittest.main()

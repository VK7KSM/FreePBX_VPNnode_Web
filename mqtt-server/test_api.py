import http.client
from http.server import HTTPServer
import json
import threading
import unittest
from api import handler, notification


class FakeBackend:
    def __init__(self):
        self.calls = []
        self.fail = False

    def credentials(self, name):
        self.calls.append(("credentials", name))
        return {"username": name, "password": "fixture-secret"}

    def publish(self, name, payload):
        if self.fail:
            raise RuntimeError("internal-secret")
        self.calls.append(("publish", name, payload))

    def revoke(self, name):
        self.calls.append(("revoke", name))


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.backend = FakeBackend()
        self.server = HTTPServer(("127.0.0.1", 0), handler("fixture-token", self.backend))
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.name = "d_" + "a" * 64

    def tearDown(self):
        self.server.shutdown()
        self.thread.join()
        self.server.server_close()

    def post(self, path, data, token="fixture-token"):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            connection.request("POST", path, json.dumps(data), {"Authorization": "Bearer " + token})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_unauthorized_has_no_side_effects(self):
        self.assertEqual(self.post("/v1/credentials", {"username": self.name}, "wrong")[0], 401)
        self.assertEqual(self.backend.calls, [])

    def test_reserved_users_and_wildcards_rejected(self):
        for name in ("control-plane", "d_+", "../passwords", None):
            self.assertEqual(self.post("/v1/credentials", {"username": name})[0], 400)
        self.assertEqual(self.backend.calls, [])

    def test_credentials_and_revoke(self):
        status, body = self.post("/v1/credentials", {"username": self.name})
        self.assertEqual(status, 200)
        self.assertEqual(body["connection"]["username"], self.name)
        self.assertEqual(self.post("/v1/revoke", {"username": self.name})[0], 200)

    def test_notification_is_bounded_and_only_status(self):
        import time
        value = {"type": "status_request", "request_id": "fixture", "version": 1,
                 "expires_at_ms": int(time.time() * 1000) + 60000, "command": "must-not-leak"}
        self.assertEqual(self.post("/v1/publish", {"username": self.name, "notification": value})[0], 200)
        self.assertNotIn("command", self.backend.calls[-1][2])
        for change in ({"type": "shell"}, {"expires_at_ms": 1}, {"version": True}, {"expires_at_ms": 9999999999999}):
            with self.assertRaises(ValueError):
                notification({**value, **change})

    def test_publish_failure_never_claims_accepted_or_exposes_error(self):
        import time
        self.backend.fail = True
        status, body = self.post("/v1/publish", {"username": self.name, "notification": {
            "type": "status_request", "request_id": "fixture", "version": 1,
            "expires_at_ms": int(time.time() * 1000) + 60000}})
        self.assertEqual(status, 503)
        self.assertNotIn("accepted", body)
        self.assertNotIn("internal-secret", json.dumps(body))


if __name__ == "__main__":
    unittest.main()

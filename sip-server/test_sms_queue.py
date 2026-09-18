#!/usr/bin/env python3
import importlib.util
import os
import tempfile
import unittest


def load_mod():
    path = os.path.join(
        os.path.dirname(__file__), "files", "usr", "local", "sbin", "sms-queue.py"
    )
    spec = importlib.util.spec_from_file_location("sms_queue", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class SmsQueueTest(unittest.TestCase):
    def setUp(self):
        self.mod = load_mod()
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "q.sqlite")
        self.out = os.path.join(self.tmp.name, "outgoing")
        os.makedirs(self.out, exist_ok=True)
        self.mod.DB_PATH = self.db
        self.mod.OUTGOING_DIR = self.out
        self.con = self.mod.connect(self.db)

    def tearDown(self):
        self.con.close()
        self.tmp.cleanup()

    def test_is_avail_does_not_match_unavailable(self):
        self.assertTrue(self.mod.is_avail("Avail"))
        self.assertTrue(self.mod.is_avail("Avail "))
        self.assertFalse(self.mod.is_avail("Unavailable"))
        self.assertFalse(self.mod.is_avail("Unavail"))
        self.assertFalse(self.mod.is_avail("NonQual"))
        self.assertFalse(self.mod.is_avail(""))
        self.assertTrue(self.mod.is_reachable("Avail"))
        self.assertTrue(self.mod.is_reachable("NonQual"))
        self.assertFalse(self.mod.is_reachable("Unavail"))
        self.assertFalse(self.mod.is_reachable("Unavailable"))
        self.assertFalse(self.mod.is_reachable(""))

    def test_cli_store_with_flags_not_agi(self):
        rc = self.mod.cli_main(
            ["store", "--dst", "199", "--from-user", "anonymous", "--body", "cli"]
        )
        self.assertEqual(rc, 0)
        dests = self.mod.queued_dests(self.con)
        self.assertIn("199", dests)

    def test_store_and_list(self):
        qid = self.mod.store(self.con, "106", "anonymous", "hello")
        self.assertIsInstance(qid, int)
        dests = self.mod.queued_dests(self.con)
        self.assertEqual(dests, ["106"])

    def test_reject_bad_dst_and_empty_body(self):
        self.assertIsNone(self.mod.store(self.con, "ab", "anonymous", "hello"))
        self.assertIsNone(self.mod.store(self.con, "106", "bad user", "hello"))
        self.assertIsNone(self.mod.store(self.con, "106", "anonymous", "  "))

    def test_overflow_drops_oldest(self):
        old = self.mod.MAX_PER_DST
        self.mod.MAX_PER_DST = 2
        try:
            a = self.mod.store(self.con, "106", "anonymous", "one")
            b = self.mod.store(self.con, "106", "anonymous", "two")
            c = self.mod.store(self.con, "106", "anonymous", "three")
            ids = [
                r["id"]
                for r in self.con.execute("SELECT id FROM sms_queue ORDER BY id").fetchall()
            ]
            self.assertEqual(ids, [b, c])
            self.assertNotIn(a, ids)
        finally:
            self.mod.MAX_PER_DST = old

    def test_claim_exclusive_and_ack_deletes(self):
        qid = self.mod.store(self.con, "106", "anonymous", "hello")
        claimed = self.mod.claim_batch(self.con, "106")
        self.assertEqual(len(claimed), 1)
        self.assertEqual(claimed[0]["id"], qid)
        self.assertEqual(self.mod.claim_batch(self.con, "106"), [])
        self.mod.ack(self.con, qid, True)
        self.assertEqual(self.mod.queued_dests(self.con), [])

    def test_ack_failure_requeues_until_max(self):
        qid = self.mod.store(self.con, "106", "anonymous", "hello")
        self.mod.claim_batch(self.con, "106")
        self.mod.ack(self.con, qid, False)
        row = self.con.execute("SELECT status, retries FROM sms_queue WHERE id=?", (qid,)).fetchone()
        self.assertEqual(row["status"], "queued")
        self.assertEqual(row["retries"], 1)

    def test_flush_writes_call_file_only_for_online(self):
        self.mod.store(self.con, "106", "anonymous", "hello")
        self.mod.store(self.con, "102", "anonymous", "other")
        n = self.mod.flush_available(["106"], con=self.con, outgoing=self.out)
        self.assertEqual(n, 1)
        files = os.listdir(self.out)
        self.assertEqual(len(files), 1)
        with open(os.path.join(self.out, files[0]), encoding="ascii") as fh:
            text = fh.read()
        self.assertIn("Local/106@sms-flush/n", text)
        self.assertIn("QUEUE_FROM=anonymous", text)
        self.assertIn("QUEUE_BODY_B64=", text)
        self.assertIn("Application: Wait", text)
        dests = self.mod.queued_dests(self.con)
        self.assertEqual(sorted(dests), ["102", "106"])
        row106 = self.con.execute(
            "SELECT status FROM sms_queue WHERE dst='106'"
        ).fetchone()
        self.assertEqual(row106["status"], "inflight")

    def test_decode_body_b64(self):
        import base64
        raw = base64.b64encode("测试".encode("utf-8")).decode("ascii")
        self.assertEqual(self.mod.decode_body(raw, True), "测试")

    def test_expire_old_rows(self):
        qid = self.mod.store(self.con, "106", "anonymous", "hello", now=1)
        self.mod.expire(self.con, now=1 + self.mod.TTL_SEC + 10)
        row = self.con.execute("SELECT id FROM sms_queue WHERE id=?", (qid,)).fetchone()
        self.assertIsNone(row)

    def test_inflight_timeout_returns_to_queued(self):
        qid = self.mod.store(self.con, "106", "anonymous", "hello", now=1000)
        self.con.execute(
            "UPDATE sms_queue SET status='inflight', last_try=? WHERE id=?",
            (1000, qid),
        )
        self.con.commit()
        self.mod.expire(self.con, now=1000 + self.mod.INFLIGHT_SEC + 1)
        row = self.con.execute("SELECT status FROM sms_queue WHERE id=?", (qid,)).fetchone()
        self.assertEqual(row["status"], "queued")


if __name__ == "__main__":
    unittest.main()

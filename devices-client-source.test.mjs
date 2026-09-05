import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import source from "./devices-client-source.js";

test("devices-client-source 必须与 devices-client.js 逐字一致", () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const raw = fs.readFileSync(path.join(root, "devices-client.js"), "utf8");
  assert.equal(source, raw);
});

test("修机页本刀只开放拉取日志", () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const raw = fs.readFileSync(path.join(root, "devices-client.js"), "utf8");
  assert.match(raw, /类型化修机/);
  assert.match(raw, /pull_logs/);
  assert.match(raw, /enqueueRepair/);
  assert.equal(/enqueueRepair\([^)]*reboot/.test(raw), false);
  assert.equal(/enqueueRepair\([^)]*install_apk/.test(raw), false);
});

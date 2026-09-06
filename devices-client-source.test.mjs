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

test("修机页属于 elfRemote，不用自造产品名", () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const raw = fs.readFileSync(path.join(root, "devices-client.js"), "utf8");
  assert.match(raw, /\["repair", "修机"/);
  assert.equal(raw.includes("类型化修机"), false);
  assert.match(raw, /kv\("elfRemote"/);
  assert.match(raw, /pull_logs/);
  assert.match(raw, /heal_network/);
  assert.match(raw, /reboot/);
  assert.match(raw, /install_apk/);
  assert.match(raw, /enqueueRepair/);
});

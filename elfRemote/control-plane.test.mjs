import test from "node:test";
import assert from "node:assert/strict";
import {
  isControlPlaneOnline,
  normalizePairCode,
  makePairCode,
  tokenSha256HexLooksValid,
  CONTROL_PLANE_ONLINE_MS
} from "./control-plane.js";

test("六位码去掉空格，拒绝非数字", () => {
  assert.equal(normalizePairCode(" 123456 "), "123456");
  assert.equal(normalizePairCode("12345"), "");
  assert.equal(normalizePairCode("12345a"), "");
});

test("配对码落在 100000-999999", () => {
  const code = makePairCode([1, 2, 3]);
  assert.match(code, /^\d{6}$/);
  assert.ok(Number(code) >= 100000);
});

test("控制面在线窗口为 120 秒", () => {
  const now = Date.parse("2026-09-05T12:00:00.000Z");
  assert.equal(isControlPlaneOnline("2026-09-05T11:58:01.000Z", now), true);
  assert.equal(isControlPlaneOnline("2026-09-05T11:57:59.000Z", now), false);
  assert.equal(isControlPlaneOnline(null, now), false);
  assert.equal(CONTROL_PLANE_ONLINE_MS, 120000);
});

test("设备令牌哈希必须是 64 位十六进制", () => {
  assert.equal(tokenSha256HexLooksValid("a".repeat(64)), true);
  assert.equal(tokenSha256HexLooksValid("A".repeat(64)), true);
  assert.equal(tokenSha256HexLooksValid("ab"), false);
});

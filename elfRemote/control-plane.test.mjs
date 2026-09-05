import test from "node:test";
import assert from "node:assert/strict";
import {
  isControlPlaneOnline,
  normalizePairCode,
  makePairCode,
  tokenSha256HexLooksValid,
  pairCodeRequiredMessage,
  managerAppLabel,
  CONTROL_PLANE_ONLINE_MS,
  updateStateLabel,
  shouldOfferUpdate,
  applyUpdateProgress
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

test("无六位码不得手工建档", () => {
  assert.equal(pairCodeRequiredMessage(""), "请用六位配对码添加设备");
  assert.equal(pairCodeRequiredMessage("12345"), "请用六位配对码添加设备");
  assert.equal(pairCodeRequiredMessage("123456"), "");
});

test("管理程序显示名为 elfRemote", () => {
  assert.equal(managerAppLabel(""), "elfRemote");
  assert.equal(managerAppLabel("0.1.2-d22xx-control-plane"), "elfRemote 0.1.2");
  assert.equal(managerAppLabel("elfRemote"), "elfRemote");
});

test("更新阶段中文标签覆盖健康更新路径", () => {
  assert.equal(updateStateLabel("pending"), "待通知");
  assert.equal(updateStateLabel("claimed"), "已领取");
  assert.equal(updateStateLabel("downloading"), "下载中");
  assert.equal(updateStateLabel("verifying"), "校验中");
  assert.equal(updateStateLabel("installing"), "安装中");
  assert.equal(updateStateLabel("wait_health"), "等待健康确认");
  assert.equal(updateStateLabel("success"), "成功");
  assert.equal(updateStateLabel("bogus"), "");
});

test("只向未过期且尚未成功的设备提供更新任务", () => {
  const now = Date.parse("2026-09-05T12:00:00.000Z");
  const pending = {
    app_version: "0.1.11-d22xx-upda",
    update: {
      job_id: "job1",
      state: "pending",
      versionName: "0.1.12-d22xx-updb",
      expires_at: "2026-09-06T00:00:00.000Z"
    }
  };
  assert.equal(shouldOfferUpdate(pending, now), true);
  pending.app_version = "0.1.12-d22xx-updb";
  assert.equal(shouldOfferUpdate(pending, now), false);
  pending.app_version = "0.1.11-d22xx-upda";
  pending.update.state = "success";
  assert.equal(shouldOfferUpdate(pending, now), false);
  pending.update.state = "pending";
  pending.update.expires_at = "2026-09-05T11:00:00.000Z";
  assert.equal(shouldOfferUpdate(pending, now), false);
  pending.update.expires_at = now + 60000;
  assert.equal(shouldOfferUpdate(pending, now), true);
  pending.update.expires_at = now - 1;
  assert.equal(shouldOfferUpdate(pending, now), false);
});

test("安装成功不能直接标为健康成功", () => {
  const d = { update: { job_id: "job1", state: "installing" } };
  applyUpdateProgress(d, "job1", "success", "pm ok");
  assert.equal(d.update.state, "installing");
  applyUpdateProgress(d, "job1", "wait_health", "installed");
  assert.equal(d.update.state, "wait_health");
  applyUpdateProgress(d, "job1", "success", "health ok");
  assert.equal(d.update.state, "success");
});

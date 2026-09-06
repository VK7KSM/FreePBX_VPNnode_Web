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
  applyUpdateProgress,
  isAllowedRepairType,
  repairStateLabel,
  repairTypeLabel,
  makeRepairTask,
  enqueueRepairTask,
  shouldOfferRepair,
  applyRepairProgress
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

test("校验失败应拒绝且不得安装", () => {
  assert.equal(updateStateLabel("rejected"), "已拒绝");
  const d = { update: { job_id: "job1", state: "verifying" } };
  applyUpdateProgress(d, "job1", "rejected", "hash-mismatch");
  assert.equal(d.update.state, "rejected");
  applyUpdateProgress(d, "job1", "installing", "no");
  assert.equal(d.update.state, "rejected");
});

test("安装中被杀后允许直接进入回滚", () => {
  const d = { update: { job_id: "job1", state: "installing" } };
  applyUpdateProgress(d, "job1", "rollback", "health-timeout");
  assert.equal(d.update.state, "rollback");
  applyUpdateProgress(d, "job1", "recovered", "last-good");
  assert.equal(d.update.state, "recovered");
});

test("校验中丢失后续进度时仍可回滚", () => {
  const d = { update: { job_id: "job1", state: "verifying" } };
  applyUpdateProgress(d, "job1", "rollback", "health-timeout");
  assert.equal(d.update.state, "rollback");
  applyUpdateProgress(d, "job1", "recovered", "last-good");
  assert.equal(d.update.state, "recovered");
});

test("健康超时走回滚再标已恢复", () => {
  assert.equal(updateStateLabel("rollback"), "回滚中");
  assert.equal(updateStateLabel("recovered"), "已恢复");
  const d = { update: { job_id: "job1", state: "wait_health" } };
  applyUpdateProgress(d, "job1", "recovered", "skip");
  assert.equal(d.update.state, "wait_health");
  applyUpdateProgress(d, "job1", "rollback", "timeout");
  assert.equal(d.update.state, "rollback");
  applyUpdateProgress(d, "job1", "recovered", "last-good");
  assert.equal(d.update.state, "recovered");
});

test("本刀修机白名单为拉取日志、强制自愈和受控重启", () => {
  assert.equal(isAllowedRepairType("pull_logs"), true);
  assert.equal(isAllowedRepairType("heal_network"), true);
  assert.equal(isAllowedRepairType("reboot"), true);
  assert.equal(isAllowedRepairType("install_apk"), false);
  assert.equal(isAllowedRepairType("shell"), false);
  assert.equal(repairTypeLabel("pull_logs"), "拉取日志");
  assert.equal(repairTypeLabel("heal_network"), "强制自愈");
  assert.equal(repairTypeLabel("reboot"), "受控重启");
  assert.equal(repairTypeLabel("install_apk"), "");
  assert.equal(repairStateLabel("pending"), "待领取");
  assert.equal(repairStateLabel("claimed"), "已领取");
  assert.equal(repairStateLabel("running"), "执行中");
  assert.equal(repairStateLabel("success"), "成功");
  assert.equal(repairStateLabel("failed"), "失败");
  assert.equal(repairStateLabel("expired"), "已过期");
  assert.equal(repairStateLabel("rejected"), "已拒绝");
  assert.equal(repairStateLabel("bogus"), "");
});

test("未过期的拉取日志任务才会发给设备", () => {
  const now = 1_000_000;
  const d = { task: makeRepairTask({ type: "pull_logs", id: "t1" }, now) };
  assert.equal(d.task.state, "pending");
  assert.equal(shouldOfferRepair(d, now), true);
  d.task.state = "success";
  assert.equal(shouldOfferRepair(d, now), false);
  d.task.state = "pending";
  d.task.expires_at = now;
  assert.equal(shouldOfferRepair(d, now), false);
  d.task.expires_at = now + 1;
  d.task.state = "claimed";
  assert.equal(shouldOfferRepair(d, now), true);
  d.task.state = "running";
  assert.equal(shouldOfferRepair(d, now), true);
});

test("未知类型不得入队，进行中不得插队", () => {
  const now = 1_000_000;
  const d = {};
  const bad = enqueueRepairTask(d, { type: "shell" }, now);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "unknown-type");
  assert.equal(d.task, undefined);
  const first = enqueueRepairTask(d, { type: "pull_logs", id: "t1", idempotency_key: "k1" }, now);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(d.task.id, "t1");
  const blocked = enqueueRepairTask(d, { type: "pull_logs", id: "t2", idempotency_key: "k2" }, now);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "inflight");
  assert.equal(d.task.id, "t1");
  const dup = enqueueRepairTask(d, { type: "pull_logs", id: "t9", idempotency_key: "k1" }, now);
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicate, true);
  assert.equal(d.task.id, "t1");
});

test("修机阶段必须领取后执行，成功要带制品哈希", () => {
  const now = 1_000_000;
  const d = {};
  enqueueRepairTask(d, { type: "pull_logs", id: "t1" }, now);
  applyRepairProgress(d, "t1", "success", "skip", { sha256: "a".repeat(64), bytes: 12 });
  assert.equal(d.task.state, "pending");
  applyRepairProgress(d, "t1", "claimed", "claimed");
  assert.equal(d.task.state, "claimed");
  applyRepairProgress(d, "t1", "running", "pull_logs");
  assert.equal(d.task.state, "running");
  applyRepairProgress(d, "t1", "success", "packed", {
    sha256: "ab".repeat(32),
    bytes: 80,
    truncated: false,
    text: "app_version=0.1.39"
  });
  assert.equal(d.task.state, "success");
  assert.equal(d.task.result.sha256, "ab".repeat(32));
  assert.equal(d.task.result.bytes, 80);
  assert.equal(d.task.result.truncated, false);
  assert.equal(d.task.result.text, "app_version=0.1.39");
});

test("过期或未知任务可拒绝，不得从成功倒退", () => {
  const now = 1_000_000;
  const d = {};
  enqueueRepairTask(d, { type: "pull_logs", id: "t1" }, now);
  applyRepairProgress(d, "t1", "rejected", "unknown-type");
  assert.equal(d.task.state, "rejected");
  applyRepairProgress(d, "t1", "claimed", "no");
  assert.equal(d.task.state, "rejected");
  const d2 = {};
  enqueueRepairTask(d2, { type: "pull_logs", id: "t2" }, now);
  applyRepairProgress(d2, "t2", "claimed", "claimed");
  applyRepairProgress(d2, "t2", "expired", "expired");
  assert.equal(d2.task.state, "expired");
});

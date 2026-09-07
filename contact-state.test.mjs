import test from "node:test";
import assert from "node:assert/strict";
import { contactState } from "./elfRemote/control-plane.js";

test("小时报告空窗仅标记等待，不能宣称 MQTT 已确认在线或立即离线", () => {
  const seen="2026-09-07T00:00:00Z", at=Date.parse(seen);
  assert.equal(contactState(seen,at+60000,true).state,"recent_contact");
  assert.equal(contactState(seen,at+180000,true).state,"awaiting_report");
  assert.equal(contactState(seen,at+3600000,true).state,"awaiting_report");
  assert.equal(contactState(seen,at+4500001,true).state,"report_overdue");
  assert.equal(contactState(seen,at+180000,false).state,"report_overdue");
});

test("缺失、无效和未来联系时间不冒充最近联系", () => {
  const now=Date.parse("2026-09-07T00:00:00Z");
  for(const seen of [null,"bad","2026-09-08T00:00:00Z"])
    assert.deepEqual(contactState(seen,now,true),{state:"unknown",report_due_at:null});
});

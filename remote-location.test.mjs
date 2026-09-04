import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateIp, pickLocation, parseGeoCache } from "./remote-location.js";

test("内网 IP 判定", () => {
  assert.equal(isPrivateIp("192.168.2.1"), true);
  assert.equal(isPrivateIp("10.0.0.8"), true);
  assert.equal(isPrivateIp("172.16.1.1"), true);
  assert.equal(isPrivateIp("175.32.39.217"), false);
  assert.equal(isPrivateIp(""), true);
});

test("有 GPS 时不用 IP", () => {
  const loc = pickLocation(
    { gps: { lat: -33.8, lng: 151.2, acc_m: 12, at: "t1" } },
    { lat: 1, lng: 2 }
  );
  assert.equal(loc.source, "gps");
  assert.equal(loc.lat, -33.8);
  assert.equal(loc.acc_m, 12);
});

test("无 GPS 时用 IP 粗圈", () => {
  const loc = pickLocation({}, { lat: -33.87, lng: 151.21 });
  assert.equal(loc.source, "ip");
  assert.equal(loc.acc_m, 25000);
  assert.equal(loc.lat, -33.87);
});

test("Wi-Fi 粗点优先于 IP", () => {
  const loc = pickLocation(
    { wifi: { lat: -33.9, lng: 151.1, acc_m: 80 } },
    { lat: 0, lng: 0 }
  );
  assert.equal(loc.source, "wifi");
  assert.equal(loc.acc_m, 80);
});

test("没有坐标则空", () => {
  assert.equal(pickLocation({}, null), null);
  assert.equal(pickLocation({ gps: { lat: "x", lng: 1 } }, null), null);
});

test("旧版城市名字符串缓存不算命中", () => {
  assert.equal(parseGeoCache("澳大利亚 新南威尔士 悉尼"), null);
  const o = parseGeoCache({ label: "悉尼", lat: -33.8, lng: 151.2 });
  assert.equal(o.lat, -33.8);
});

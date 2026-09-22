import assert from "node:assert/strict";
import worker, { ElfStore } from "./worker.js";

export function fixture(initial = { admin_pass: "fixture-password" }) {
  // 测试直接 f.data.set("remote_devices", list) 是「整表重灌」，意图是权威覆盖；
  // 设备列表拆键之后，重灌时要把这些设备残留的 device_ext/<id> 一并清掉，
  // 否则旧的大字段会从扩展键合并回来，测试看到的是它刚删掉的东西。
  // 生产代码的 saveDevices 走 storage.put，绕过这个覆盖——它自己会维护扩展键。
  // 不能用 Map 子类：有测试拿 structuredClone(f.data) 做前后快照再 deepEqual，
  // 子类实例与普通 Map 原型不同会被判不等。改成实例上的不可枚举属性，原型仍是 Map。
  const data = new Map(Object.entries(initial));
  Object.defineProperty(data, "set", { enumerable: false, configurable: true, value(k, v) {
    if (k === "remote_devices" && Array.isArray(v))
      for (const d of v) if (d && d.id) Map.prototype.delete.call(data, "device_ext/" + encodeURIComponent(String(d.id)));
    return Map.prototype.set.call(data, k, v);
  } });
  const storage = {
    async get(k) { return structuredClone(data.get(k)); },
    async put(k, v) { Map.prototype.set.call(data, k, structuredClone(v)); },
    async delete(k) { return data.delete(k); },
    async list({ prefix = "", start, startAfter, end, limit = Infinity }) {
      return new Map([...data].filter(([k]) => k.startsWith(prefix) && (!start || k >= start)
        && (!startAfter || k > startAfter) && (!end || k < end)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0,limit));
    },
    async transaction(fn) {
      const snapshot = structuredClone(data);
      try { return await fn(storage); }
      // 回滚要绕过 set 覆盖：那个覆盖只服务于测试「整表重灌」，回滚是原样恢复，不能顺手删扩展键。
      catch (error) { data.clear(); for (const [k,v] of snapshot) Map.prototype.set.call(data,k,v); throw error; }
    }
  };
  let pending = Promise.resolve();
  const ctx = { storage, blockConcurrencyWhile(fn) {
    const next = pending.then(fn); pending = next.catch(() => {}); return next;
  } };
  const env = {};
  const store = new ElfStore(ctx, env);
  const googleData = new Map();
  let googlePending = Promise.resolve();
  const googleStore = new ElfStore({storage:{
    get:async k=>structuredClone(googleData.get(k)),put:async(k,v)=>googleData.set(k,structuredClone(v))
  },blockConcurrencyWhile(fn){const next=googlePending.then(fn);googlePending=next.catch(()=>{});return next;}},env);
  env.ELF_DO = { idFromName: x => x, get: id => ({ fetch: (url, init) => (id === "google-geolocation" ? googleStore : store).fetch(url instanceof Request ? url : new Request(url, init)) }) };
  // 设备列表拆成索引 + device_ext/<id> 之后，直接读 remote_devices 只能看到小字段。
  // 测试要的是「这台设备现在是什么样」，用这个合并视图，别去猜字段在哪个键里。
  // 返回的是存储里那份记录本身（不是拷贝）：老测试一直靠「拿到引用直接改」来改存储，
  // 140 处调用都是这么写的。扩展键里的字段就地并回索引记录（索引里已有的优先），
  // 于是记录暂时回到「大字段在索引里」的旧格式，生产代码读它照常、下次保存再拆开。
  const devices = () => {
    const list = data.get("remote_devices");
    if (!Array.isArray(list)) return [];
    for (const d of list) {
      const ext = d && d.id ? data.get("device_ext/" + encodeURIComponent(String(d.id))) : null;
      if (ext && typeof ext === "object") for (const [k, v] of Object.entries(ext)) if (!(k in d)) d[k] = v;
    }
    return list;   // 同一个数组实例：老测试靠 push/splice 直接改存储
  };
  return { data, storage, env, store, googleData, devices };
}
export function request(path, method = "GET", body, cookie, extra = {}) {
  return new Request("https://example.test" + path, { method, headers: {
    ...(cookie ? { Cookie: cookie } : {}), "Content-Type": "application/json", ...extra
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
export async function login(f) {
  const response = await worker.fetch(request("/api/login", "POST", { username: "admin", password: "fixture-password" }), f.env);
  assert.equal(response.status, 200);
  return response.headers.get("Set-Cookie").split(";")[0];
}

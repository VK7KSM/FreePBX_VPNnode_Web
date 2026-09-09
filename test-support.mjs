import assert from "node:assert/strict";
import worker, { ElfStore } from "./worker.js";

export function fixture(initial = { admin_pass: "fixture-password" }) {
  const data = new Map(Object.entries(initial));
  const storage = {
    async get(k) { return structuredClone(data.get(k)); },
    async put(k, v) { data.set(k, structuredClone(v)); },
    async delete(k) { return data.delete(k); },
    async list({ prefix = "", start, startAfter, end, limit = Infinity }) {
      return new Map([...data].filter(([k]) => k.startsWith(prefix) && (!start || k >= start)
        && (!startAfter || k > startAfter) && (!end || k < end)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0,limit));
    },
    async transaction(fn) {
      const snapshot = structuredClone(data);
      try { return await fn(storage); }
      catch (error) { data.clear(); for (const [k,v] of snapshot) data.set(k,v); throw error; }
    }
  };
  let pending = Promise.resolve();
  const ctx = { storage, blockConcurrencyWhile(fn) {
    const next = pending.then(fn); pending = next.catch(() => {}); return next;
  } };
  const env = {};
  const store = new ElfStore(ctx, env);
  env.ELF_DO = { idFromName: x => x, get: () => ({ fetch: (url, init) => store.fetch(url instanceof Request ? url : new Request(url, init)) }) };
  return { data, storage, env, store };
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

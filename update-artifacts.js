const MAX_APK_BYTES = 64 * 1024 * 1024;

export async function saveReleaseApk(env, manifest, encoded) {
  if (!env.ELF_ARTIFACTS) throw new Error("制品存储未配置");
  if (!Number.isInteger(manifest.size) || manifest.size <= 0 || manifest.size > MAX_APK_BYTES
      || typeof encoded !== "string" || encoded.length > Math.ceil(manifest.size / 3) * 4
      || !/^[0-9a-f]{64}$/.test(manifest.sha256 || "")) throw new Error("制品长度或哈希无效");
  let raw;
  try { raw = atob(encoded); } catch { throw new Error("制品编码无效"); }
  if (raw.length !== manifest.size) throw new Error("制品长度不匹配");
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
  if (hash !== manifest.sha256) throw new Error("制品哈希不匹配");
  const key = "apks/" + hash;
  await env.ELF_ARTIFACTS.put(key, bytes, {httpMetadata:{contentType:"application/vnd.android.package-archive"}});
  return key;
}

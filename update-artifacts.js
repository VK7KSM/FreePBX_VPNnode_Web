const MAX_APK_BYTES = 64 * 1024 * 1024;

export async function saveReleaseApk(env, manifest, encoded) {
  if (!env.ELF_ARTIFACTS) throw new Error("制品存储未配置");
  if (!Number.isInteger(manifest.size) || manifest.size <= 0 || manifest.size > MAX_APK_BYTES
      || typeof encoded !== "string" || encoded.length > Math.ceil(manifest.size / 3) * 4
      || !/^[0-9a-f]{64}$/.test(manifest.sha256 || "")) throw new Error("制品长度或哈希无效");
  let raw;
  try { raw = atob(encoded); } catch { throw new Error("制品编码无效"); }
  if (raw.length !== manifest.size) throw new Error("制品长度不匹配");
  const bytes = new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
  if (hash !== manifest.sha256) throw new Error("制品哈希不匹配");
  const key = "apks/" + hash;
  await env.ELF_ARTIFACTS.put(key, bytes, {httpMetadata:{contentType:"application/vnd.android.package-archive"}});
  return key;
}

// 新发布通路使用固定长度正文，避免在DO内同时保留JSON、Base64和解码副本。
export async function streamReleaseApk(env,manifest,request){
  if(!env.ELF_ARTIFACTS)throw Error('制品存储未配置');
  if(!Number.isInteger(manifest.size)||manifest.size<=0||manifest.size>MAX_APK_BYTES
    ||Number(request.headers.get('Content-Length'))!==manifest.size||!request.body
    ||!/^[0-9a-f]{64}$/.test(manifest.sha256||''))throw Error('制品长度或哈希无效');
  const key='apks/'+manifest.sha256;
  // R2边接收边校验SHA-256，失败不登记可安装版本。
  await env.ELF_ARTIFACTS.put(key,request.body,{sha256:manifest.sha256,httpMetadata:{contentType:'application/vnd.android.package-archive'}});
  return key;
}

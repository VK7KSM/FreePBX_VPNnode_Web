import { authJson } from "./admin-auth.js";

async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2,"0")).join("");
}
async function objectKey(deviceId, taskId) {
  const enc=new TextEncoder();
  return "task-logs/"+await digest(enc.encode(deviceId))+"/"+await digest(enc.encode(taskId));
}

export async function saveTaskLog(env, deviceId, taskId, result) {
  if (!env.ELF_ARTIFACTS) throw authJson({ok:false,msg:"日志存储未配置"},503);
  if (typeof result.log_text!=="string") throw authJson({ok:false,msg:"日志内容无效"},400);
  const bytes=new TextEncoder().encode(result.log_text);
  if (bytes.length>3*1024*1024 || bytes.length!==result.bytes || await digest(bytes)!==result.sha256)
    throw authJson({ok:false,msg:"日志长度或校验值不匹配"},400);
  const key=await objectKey(deviceId,taskId);
  const previous=await env.__storage.get(key);
  if (previous) {
    if(previous.sha256!==result.sha256) throw authJson({ok:false,msg:"该任务日志已保存且内容不同"},409);
    return previous;
  }
  try { await env.ELF_ARTIFACTS.put(key,bytes,{httpMetadata:{contentType:"text/plain; charset=utf-8"}}); }
  catch { throw authJson({ok:false,msg:"日志上传暂时失败"},503); }
  const metadata={bytes:bytes.length,sha256:result.sha256,truncated:result.truncated===true};
  await env.__storage.put(key,metadata);
  return metadata;
}

export async function downloadTaskLog(env,url) {
  const device=url.searchParams.get("device_id"),task=url.searchParams.get("task_id");
  if(!device || !task || device.length>128 || task.length>128) return authJson({ok:false,msg:"缺少有效任务"},400);
  const key=await objectKey(device,task),metadata=await env.__storage.get(key);
  if(!metadata) return authJson({ok:false,msg:"日志不存在"},404);
  const object=await env.ELF_ARTIFACTS?.get(key);
  if(!object) return authJson({ok:false,msg:"日志制品不可用"},503);
  return new Response(object.body,{headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store",
    "Content-Disposition":"attachment; filename=elfRemote-log.txt","X-Content-Type-Options":"nosniff","X-Content-SHA256":metadata.sha256}});
}

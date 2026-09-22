// 单设备分享的范围与动作矩阵：纯函数，供 Worker 两道鉴权门调用。矩阵原文在
// remote/docs/2026-09-18-单设备分享-接口盘点与动作矩阵.md；表本身在 route-table.js，改路由只改那里。
import {DEVICE_ID_QUERY,DEVICE_ID_BODY,DEVICE_ID_BODY_ID,SHARE_FORBIDDEN,SHARE_GLOBAL_READ,OBSERVER_ALLOWED} from './route-table.js';
const OBSERVER_TASK_TYPES=/^(lost_|safety_|cancel_lost|lost)/;
const OBSERVER_ADB_OBSERVE=new Set(['/api/elfremote/adb/observer']);
export const DEVICE_UPDATE_FIELDS=new Set(['id','name','enabled','model_id','ip','note']);

function parseBody(bodyText){if(!bodyText)return null;try{const v=JSON.parse(bodyText);return v&&typeof v==='object'&&!Array.isArray(v)?v:null;}catch{return null;}}
function pathPrefix(pathname){
  if(pathname.startsWith('/api/elfremote/files/'))return '/api/elfremote/files';
  if(/^\/api\/elfremote\/proxy-config\//.test(pathname))return '/api/elfremote/proxy-config';
  return pathname;
}
/** 从请求里取设备编号；取不到返回 null。 */
export function requestDeviceId(pathname,method,url,bodyText){
  const p=pathPrefix(pathname),body=parseBody(bodyText);
  if(DEVICE_ID_BODY_ID.has(p)&&body&&typeof body.id==='string')return body.id;
  if(DEVICE_ID_BODY.has(p)&&body&&typeof body.device_id==='string')return body.device_id;
  const q=url.searchParams.get('device_id');
  if(DEVICE_ID_QUERY.has(p)&&typeof q==='string'&&q)return q;
  return null;
}
export function shareForbidden(pathname,method){const p=pathPrefix(pathname);return SHARE_FORBIDDEN.some(([m,r])=>m===method&&r===p);}
/**
 * 独立页范围裁决：返回 null 表示放行，否则返回 {status,msg}。
 * 规则：明确禁止的拒绝；有设备编号的必须等于本设备；无设备编号的只放行只读白名单与实时会话 WS（由调用方按会话 owner 另核）。
 */
export function shareVerdict(ctx,pathname,method,url,bodyText){
  if(!ctx||ctx.kind!=='share')return null;
  const p=pathPrefix(pathname);
  if(shareForbidden(pathname,method))return {status:403,msg:'此操作不属于本设备管理页'};
  const deviceId=requestDeviceId(pathname,method,url,bodyText);
  if(deviceId!==null)return deviceId===ctx.device_id?null:{status:403,msg:'只能操作本设备'};
  // 分享接口自身按链接归属校验设备（updateLink/revokeLink），此处不再要求 device_id。
  if(p.startsWith('/api/share/'))return null;
  if(SHARE_GLOBAL_READ.has(p)&&(method==='GET'||p.startsWith('/api/share/')||p==='/api/logout'))return null;
  if(/^\/api\/elfremote\/(media|adb|adb-tunnel|desktop)\/(browser|observer)$/.test(p))return null;
  // 关闭/查询自己的实时会话：请求体只有 session_id，归属由 DO 按会话 owner 核对。
  if(/^\/api\/elfremote\/(media|adb-tunnel|desktop)\/session$/.test(p)&&(method==='DELETE'||method==='GET'))return null;
  if(p==='/api/devices/update'||p==='/api/devices/delete')return {status:403,msg:'只能操作本设备'};
  return {status:403,msg:'此操作不属于本设备管理页'};
}
/** 独立用户在线时管理员的动作裁决：返回 null 放行，否则 {status,msg}。只对涉及该设备的请求调用。 */
export function observerVerdict(pathname,method,bodyText){
  const p=pathPrefix(pathname);
  if(method==='GET')return null;
  if(OBSERVER_ALLOWED.some(([m,r])=>m===method&&r===p))return null;
  if(p==='/api/elfremote/task'){const body=parseBody(bodyText);if(body&&typeof body.type==='string'&&OBSERVER_TASK_TYPES.test(body.type))return null;}
  if(OBSERVER_ADB_OBSERVE.has(p))return null;
  return {status:403,msg:'独立用户使用中，总后台只读'};
}
/** 管理员编辑设备时只接受原表单字段。 */
export function sanitizeDeviceUpdate(body){
  if(!body||typeof body!=='object')return null;
  const extra=Object.keys(body).filter(k=>!DEVICE_UPDATE_FIELDS.has(k));
  return extra.length?{error:'不接受字段：'+extra.slice(0,5).join('、')}:{ok:true};
}
export function sameOwner(owner,ctx){
  if(!owner)return ctx?.kind==='admin';
  if(owner.kind!==ctx?.kind)return false;
  return owner.kind==='admin'||owner.session_id===ctx.session_id;
}
export function ownerOf(ctx){return ctx?.kind==='share'?{kind:'share',session_id:ctx.session_id,generation:ctx.generation}:{kind:'admin'};}

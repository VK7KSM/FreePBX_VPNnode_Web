// 数据保留与自动清理（加固方案第七节）。拆键解决「明天就可能停摆」，这里决定「两三年后」：
// 每一份只写不删的数据都有保留期，由定时任务小批量物理删除，稳态与追溯清理都不越额度。
//
//   位置/上报历史  history/<设备>/<时间>/<id> + history-id/<设备>/<id>   保留 90 天，先按天汇总流量再删
//   撤销/到期链接  share/link/<token>（及 share/fail、share/request）        撤销或到期后 7 天删
//   MCP 令牌       mcp/token/<hash>                                          到期即删（listTokens 顺带）
//   发布任务映射   elfremote_job_<id>                                        所指制品已退休即删
//   任务历史       repair-history/<设备>/<id>                                 归档时已物理删 30 天前的，不在此处
//
// 删除也算 DO 写入行：每次运行最多 RETENTION_BATCH 个键，每小时一次；存量按天分批，跨数日清完。
// 流量账本是从 history 行里的累计计数差分出来的，删行前必须把那一天汇总进 traffic-day/<设备>/<日期>，
// 且**汇总某天时它前一天的行还得在**（差分要用前一天最后一次采样做基线）——所以每次先把
// 最老那天 D 与 D+1 都汇总好，再删 D 的行；到 D+1 轮到被删时它的汇总早已算好。
import {sydneyDate,dateShift,sydneyMidnight,queryDailyTraffic} from './daily-traffic.js';
import {listTokens} from './mcp-tokens.js';
import {RELEASE_VARIANTS,releaseKey} from './release-channels.js';

export const HISTORY_RETENTION_DAYS=90;
export const SHARE_LINK_GRACE_MS=7*86400000;
export const RETENTION_BATCH=400;
export const LAST_RUN_KEY='retention/last';
export const rollupKey=(device,day)=>'traffic-day/'+encodeURIComponent(device)+'/'+day;
const historyPrefix=device=>'history/'+encodeURIComponent(device)+'/';

/** 有历史行的设备前缀（含已删除的设备）：每个前缀只读一行，靠 '~' 跳到下一个前缀。 */
export async function historyDevices(storage){
  const out=[];let start='history/';
  for(let i=0;i<500;i++){
    const page=await storage.list({prefix:'history/',start,limit:1});
    if(!page.size)break;
    const key=page.keys().next().value;
    const segment=key.slice('history/'.length).split('/')[0];
    if(!segment)break;
    out.push(decodeURIComponent(segment));
    start='history/'+segment+'/~';
  }
  return out;
}

/** 把某一天的流量按现有原始行汇总成一条 traffic-day 记录；已有则不重算。 */
async function ensureRollup(storage,device,day,now){
  const key=rollupKey(device,day);
  if(await storage.get(key))return false;
  const url=new URL('https://elf-store/api/devices/traffic');
  url.searchParams.set('device_id',device);url.searchParams.set('from',day);url.searchParams.set('to',day);
  const result=await queryDailyTraffic(storage,url,now,{rollups:false});
  const row=result.days[0];
  await storage.put(key,{date:day,rx_bytes:row.rx_bytes,tx_bytes:row.tx_bytes,observed_ms:row.observed_ms,
    estimated:row.estimated,gaps:row.gaps,available:row.available,partial:row.partial,rolled_up_at:now});
  return true;
}

/** 删一台设备保留期外的历史行（及去重键），最多 budget 个键；返回删了多少、汇总了几天。 */
export async function purgeDeviceHistory(storage,device,now,budget){
  const cutoffDay=sydneyDate(now-HISTORY_RETENTION_DAYS*86400000);
  const prefix=historyPrefix(device);
  let deleted=0,rollups=0;
  while(deleted<budget){
    const first=await storage.list({prefix,limit:1});
    if(!first.size)break;
    const oldest=first.keys().next().value;
    const stamp=Date.parse(oldest.slice(prefix.length).split('/')[0]);
    if(!Number.isFinite(stamp))break;
    const day=sydneyDate(stamp);
    if(!(day<cutoffDay))break;
    // 先汇总 D 与 D+1，再删 D：D+1 的汇总要用 D 的最后一次采样做基线
    if(await ensureRollup(storage,device,day,now))rollups++;
    if(await ensureRollup(storage,device,dateShift(day,1),now))rollups++;
    const dayEnd=new Date(sydneyMidnight(dateShift(day,1))).toISOString();
    const rows=await storage.list({prefix,end:prefix+dayEnd,limit:Math.max(1,Math.min(100,Math.ceil((budget-deleted)/2)))});
    if(!rows.size)break;
    for(const key of rows.keys()){
      const id=key.slice(key.lastIndexOf('/')+1);
      await storage.delete(key);
      await storage.delete('history-id/'+encodeURIComponent(device)+'/'+id);
      deleted+=2;
    }
  }
  return {deleted,rollups};
}

/** 撤销或到期超过 7 天的分享链接：删链接、失败计数、它的 request 键，并从索引里摘掉。 */
export async function purgeShareLinks(storage,now,budget){
  let deleted=0;
  const links=await storage.list({prefix:'share/link/',limit:200});
  for(const [key,link] of links){
    if(deleted>=budget)break;
    if(!link||typeof link!=='object')continue;
    const dead=link.revoked_at?Number(link.revoked_at):(link.expires_at!==null&&Number(link.expires_at)<=now?Number(link.expires_at):null);
    if(dead===null||!(dead<=now-SHARE_LINK_GRACE_MS))continue;
    await storage.delete(key);await storage.delete('share/fail/'+link.token);deleted+=2;
    const index=await storage.get('share/index/'+link.device_id);
    if(Array.isArray(index)&&index.includes(link.token))await storage.put('share/index/'+link.device_id,index.filter(t=>t!==link.token));
    const requests=await storage.list({prefix:'share/request/'+link.device_id+'/',limit:200});
    for(const [rk,token] of requests)if(token===link.token){await storage.delete(rk);deleted++;}
  }
  return {deleted};
}

/** 所指制品已退休（或记录已不存在）的发布任务映射。 */
export async function purgeJobMappings(storage,budget){
  let deleted=0;
  const rows=await storage.list({prefix:'elfremote_job_',limit:100});
  for(const [key,mapping] of rows){
    if(deleted>=budget)break;
    let live=false;
    if(mapping&&mapping.channel&&mapping.versionCode){
      for(const variant of RELEASE_VARIANTS){
        const record=await storage.get(releaseKey(mapping.channel,mapping.versionCode,variant));
        if(record&&!record.retired_at){live=true;break;}
      }
    }
    if(!live){await storage.delete(key);deleted++;}
  }
  return {deleted};
}

/** 一次清理：按预算依次处理历史、链接、令牌、映射；把结果记到 retention/last 供健康摘要读。 */
export async function retentionSweep(storage,{now=Date.now(),budget=RETENTION_BATCH}={}){
  const summary={at:now,devices:0,history_deleted:0,rollups:0,share_deleted:0,mcp_pruned:0,jobs_deleted:0};
  let left=budget;
  for(const device of await historyDevices(storage)){
    if(left<=0)break;
    summary.devices++;
    const r=await purgeDeviceHistory(storage,device,now,left);
    summary.history_deleted+=r.deleted;summary.rollups+=r.rollups;left-=r.deleted;
  }
  if(left>0){const r=await purgeShareLinks(storage,now,left);summary.share_deleted=r.deleted;left-=r.deleted;}
  const devices=(await storage.get('remote_devices'))||[];
  for(const d of devices){
    if(!d||!d.id)continue;
    const index=(await storage.get('mcp/index/'+d.id))||[];
    const kept=(await listTokens(storage,d.id,now)).length;
    summary.mcp_pruned+=Math.max(0,index.length-kept);
  }
  if(left>0){const r=await purgeJobMappings(storage,left);summary.jobs_deleted=r.deleted;left-=r.deleted;}
  summary.budget_left=left;
  await storage.put(LAST_RUN_KEY,summary);
  return summary;
}

/** 定时任务入口：整点跑一次，交给 DO 在自己的串行队列里做。 */
export async function runRetention(env,stub){
  if(!stub)return;
  const response=await stub.fetch('https://elf-store/__retention',{method:'POST'});
  if(!response.ok)throw Error('retention '+response.status);
  // 留一行日志：wrangler tail 能看到每小时清了多少，不用登录面板。
  try{const s=await response.json();console.log('retention_sweep',JSON.stringify({devices:s.devices,history_deleted:s.history_deleted,rollups:s.rollups,share_deleted:s.share_deleted,mcp_pruned:s.mcp_pruned,jobs_deleted:s.jobs_deleted,budget_left:s.budget_left}));}catch{}
}

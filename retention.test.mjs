import test from 'node:test';import assert from 'node:assert/strict';
import worker from './worker.js';import {fixture,request,login} from './test-support.mjs';
import {historyDevices,purgeDeviceHistory,purgeShareLinks,purgeJobMappings,retentionSweep,runRetention,rollupKey,
  HISTORY_RETENTION_DAYS,SHARE_LINK_GRACE_MS,LAST_RUN_KEY} from './retention.js';
import {queryDailyTraffic,sydneyDate,dateShift} from './daily-traffic.js';
import {releaseKey} from './release-channels.js';

// 固定「现在」：2026-09-23 12:00 悉尼
const NOW=Date.parse('2026-09-23T02:00:00Z');
const DAY=86400000;
const H='history/',HID='history-id/';
/** 每小时一条上报，累计流量线性增长（每小时 rx 1000 / tx 100），跨 days 天。 */
function seedHistory(data,device,days,{startDaysAgo=days,step=3600000}={}){
  const started=NOW-startDaysAgo*DAY;
  let n=0;
  for(let t=started;t<NOW;t+=step){
    const id='r'+(n++);
    const iso=new Date(t).toISOString();
    const elapsedH=(t-started)/3600000;
    data.set(H+device+'/'+iso+'/'+id,{device_id:device,report_id:id,timeline_at:iso,installation_id:'inst1',
      traffic:{available:true,scope:'application_uid',source:'qtaguid_uid',started_at_ms:started,sampled_at_ms:t,covered_ms:t-started,gaps:0,
        rx_bytes:Math.round(elapsedH*1000),tx_bytes:Math.round(elapsedH*100),interfaces:{}}});
    data.set(HID+device+'/'+id,{key:H+device+'/'+iso+'/'+id,hash:'x',hash_version:2});
  }
  return n;
}
const rowsOf=(f,device)=>[...f.data.keys()].filter(k=>k.startsWith(H+device+'/'));
const idsOf=(f,device)=>[...f.data.keys()].filter(k=>k.startsWith(HID+device+'/'));
async function traffic(f,device,from,to){
  const url=new URL('https://x/api/devices/traffic');url.searchParams.set('device_id',device);url.searchParams.set('from',from);url.searchParams.set('to',to);
  return (await queryDailyTraffic(f.storage,url,NOW)).days;
}

test('发现有历史行的设备前缀，包括名字互为前缀的与已删除的设备', async () => {
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'dev1',name:'A'}]});
  seedHistory(f.data,'dev1',2);seedHistory(f.data,'dev10',2);seedHistory(f.data,'gone',2);
  assert.deepEqual(await historyDevices(f.storage),['dev1','dev10','gone']);
});

test('90 天前的行连同去重键一起删；流量先按天汇总，查询结果与删前一致', async () => {
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'dev1',name:'A'}]});
  const total=seedHistory(f.data,'dev1',100);
  const from=sydneyDate(NOW-99*DAY),to=sydneyDate(NOW);
  const before=await traffic(f,'dev1',from,to);
  assert.ok(before.filter(d=>d.available).length>=98,'种子数据应覆盖整段');
  // 反复跑到没有进展为止（模拟跨多次定时运行）
  let rounds=0;
  while(rounds++<200){const r=await purgeDeviceHistory(f.storage,'dev1',NOW,400);if(!r.deleted)break;}
  const cutoff=sydneyDate(NOW-HISTORY_RETENTION_DAYS*DAY);
  for(const k of rowsOf(f,'dev1')){const day=sydneyDate(Date.parse(k.split('/')[2]));assert.ok(day>=cutoff,'保留期外的行必须删掉：'+k);}
  assert.equal(idsOf(f,'dev1').length,rowsOf(f,'dev1').length,'去重键与行一一对应');
  assert.ok(rowsOf(f,'dev1').length<total&&rowsOf(f,'dev1').length>0);
  // 汇总键：被删的每一天，加上保留期第一天（它的基线在被删的前一天里）
  assert.ok(f.data.get(rollupKey('dev1',dateShift(cutoff,-1))),'最后被删的那天要有汇总');
  assert.ok(f.data.get(rollupKey('dev1',cutoff)),'保留期第一天也要有汇总，否则它的基线没了');
  const after=await traffic(f,'dev1',from,to);
  for(let i=0;i<before.length;i++){
    assert.equal(after[i].rx_bytes,before[i].rx_bytes,before[i].date+' rx');
    assert.equal(after[i].tx_bytes,before[i].tx_bytes,before[i].date+' tx');
    assert.equal(after[i].available,before[i].available,before[i].date+' available');
  }
  // 再跑一次没有任何变化（幂等）
  const again=await purgeDeviceHistory(f.storage,'dev1',NOW,400);
  assert.deepEqual(again,{deleted:0,rollups:0});
});

test('预算按键数封顶；每次运行只做得完的那一部分，下次接着来', async () => {
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'dev1',name:'A'}]});
  seedHistory(f.data,'dev1',95);
  const n0=rowsOf(f,'dev1').length;
  const r=await purgeDeviceHistory(f.storage,'dev1',NOW,10);
  assert.equal(r.deleted,10,'10 个键 = 5 行 + 5 个去重键');
  assert.equal(rowsOf(f,'dev1').length,n0-5);
  const r2=await purgeDeviceHistory(f.storage,'dev1',NOW,10);
  assert.equal(r2.deleted,10);assert.equal(r2.rollups,0,'同一天不重复汇总');
});

test('分享链接：撤销/到期满 7 天才删，连带失败计数、request 键与索引；未满与仍有效的不动', async () => {
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'dev1',name:'A'}]});
  const link=(token,over)=>({token,device_id:'dev1',created_at:NOW-30*DAY,expires_at:null,password:null,revoked_at:null,...over});
  f.data.set('share/link/OLDREV',link('OLDREV',{revoked_at:NOW-SHARE_LINK_GRACE_MS-1000}));
  f.data.set('share/link/NEWREV',link('NEWREV',{revoked_at:NOW-DAY}));
  f.data.set('share/link/EXPIRED',link('EXPIRED',{expires_at:NOW-10*DAY}));
  f.data.set('share/link/ACTIVE',link('ACTIVE',{expires_at:NOW+DAY}));
  f.data.set('share/index/dev1',['NEWREV','EXPIRED','ACTIVE']);
  f.data.set('share/fail/OLDREV',[{until:NOW+1}]);
  f.data.set('share/request/dev1/req-a','OLDREV');f.data.set('share/request/dev1/req-b','ACTIVE');
  const r=await purgeShareLinks(f.storage,NOW,400);
  assert.equal(r.deleted,5,'两条链接各 2 个键 + 1 个 request 键');
  assert.equal(f.data.has('share/link/OLDREV'),false);assert.equal(f.data.has('share/link/EXPIRED'),false);
  assert.equal(f.data.has('share/fail/OLDREV'),false);assert.equal(f.data.has('share/request/dev1/req-a'),false);
  assert.ok(f.data.has('share/link/NEWREV')&&f.data.has('share/link/ACTIVE')&&f.data.has('share/request/dev1/req-b'));
  assert.deepEqual(f.data.get('share/index/dev1'),['NEWREV','ACTIVE']);
});

test('发布任务映射：所指制品已退休或记录不存在就删，仍在架的留着', async () => {
  const f=fixture({admin_pass:'fixture-password',remote_devices:[]});
  f.data.set(releaseKey('d22',200),{versionCode:200,retired_at:NOW-DAY});
  f.data.set(releaseKey('d22',201),{versionCode:201});
  f.data.set('elfremote_job_old',{channel:'d22',versionCode:200,apk_key:'apks/a'});
  f.data.set('elfremote_job_live',{channel:'d22',versionCode:201,apk_key:'apks/b'});
  f.data.set('elfremote_job_orphan',{channel:'d22',versionCode:150,apk_key:'apks/c'});
  const r=await purgeJobMappings(f.storage,400);
  assert.equal(r.deleted,2);
  assert.ok(f.data.has('elfremote_job_live'));assert.ok(!f.data.has('elfremote_job_old')&&!f.data.has('elfremote_job_orphan'));
});

test('整轮清理：过期 MCP 令牌顺带清掉，结果记到 retention/last，健康摘要能读到', async () => {
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'dev1',name:'A'}]});
  seedHistory(f.data,'dev1',92);
  f.data.set('mcp/token/h1',{device_id:'dev1',expires_at:NOW-1000,revoked_at:null,scopes:[],created_at:NOW-DAY});
  f.data.set('mcp/token/h2',{device_id:'dev1',expires_at:NOW+DAY,revoked_at:null,scopes:[],created_at:NOW-DAY});
  f.data.set('mcp/index/dev1',['h1','h2']);
  const s=await retentionSweep(f.storage,{now:NOW,budget:400});
  assert.equal(s.devices,1);assert.ok(s.history_deleted>0);assert.equal(s.mcp_pruned,1);
  assert.ok(!f.data.has('mcp/token/h1')&&f.data.has('mcp/token/h2'));
  assert.deepEqual(f.data.get('mcp/index/dev1'),['h2']);
  assert.deepEqual(f.data.get(LAST_RUN_KEY),s);
  const cookie=await login(f);
  const h=await (await worker.fetch(request('/api/admin/health','GET',undefined,cookie),f.env)).json();
  assert.equal(h.retention.history_deleted,s.history_deleted);
});

test('定时入口经 DO 的 /__retention 执行；DO 路由真的跑了一轮', async () => {
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'dev1',name:'A'}]});
  seedHistory(f.data,'dev1',92);
  const stub=f.env.ELF_DO.get(f.env.ELF_DO.idFromName('main'));
  await runRetention(f.env,stub);
  const last=f.data.get(LAST_RUN_KEY);
  assert.ok(last&&last.history_deleted>0,JSON.stringify(last));
  const paths=[];
  await runRetention({},{async fetch(url){paths.push(new URL(url).pathname);return new Response('{}');}});
  assert.deepEqual(paths,['/__retention']);
});

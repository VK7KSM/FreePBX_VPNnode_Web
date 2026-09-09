import test from 'node:test';
import assert from 'node:assert/strict';
import {sydneyDate,sydneyMidnight,dateShift,aggregateDailyTraffic,queryDailyTraffic} from './daily-traffic.js';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
function sample(start,end,rx,tx=0){return {available:true,started_at_ms:start,sampled_at_ms:end,covered_ms:end-start,gaps:0,rx_bytes:rx,tx_bytes:tx};}
test('不同安装即使起始时间相同也不跨实例相减',()=>{
 const a=sydneyMidnight('2026-09-08');
 const rows=aggregateDailyTraffic([{...sample(a,a+1000,100),installation_id:'old'},
   {...sample(a,a+2000,150),installation_id:'new'}],'2026-09-08','2026-09-08',a+3000);
 assert.equal(rows[0].rx_bytes,250);
});
test('悉尼自然日正确覆盖夏令时23小时与25小时',()=>{
 for(const [day,hours] of [['2026-10-04',23],['2026-04-05',25],['2026-09-08',24]]){
  const a=sydneyMidnight(day),b=sydneyMidnight(dateShift(day,1));
  assert.equal((b-a)/3600000,hours);assert.equal(sydneyDate(a),day);
  assert.equal(sydneyDate(a-1),dateShift(day,-1));
 }
 assert.throws(()=>sydneyMidnight('2026-02-30'));
});
test('跨日分摊字节守恒，重复与未来采样不重复计算，无数据不冒充零',()=>{
 const a=sydneyMidnight('2026-09-07'),b=sydneyMidnight('2026-09-09'),s=sample(a,b,101,51);
 const rows=aggregateDailyTraffic([s,s,sample(a,b+86400000,999)],'2026-09-06','2026-09-09',b);
 assert.equal(rows.reduce((n,r)=>n+r.rx_bytes,0),101);
 assert.equal(rows.reduce((n,r)=>n+r.tx_bytes,0),51);
 assert.equal(rows[0].available,false);assert.equal(rows[3].available,false);
});
test('同序列累计差分、新序列及计数回退不产生负流量',()=>{
 const a=sydneyMidnight('2026-09-08'),h=3600000;
 const rows=aggregateDailyTraffic([sample(a,a+h,100),sample(a,a+2*h,150),sample(a,a+3*h,10),sample(a,a+4*h,30),sample(a+4*h,a+5*h,7)],'2026-09-08','2026-09-08',a+6*h);
 assert.equal(rows[0].rx_bytes,177);
 assert.equal(rows[0].partial,true);
});
test('历史查询完整分页并使用边界两侧基线',async()=>{
 const a=sydneyMidnight('2026-09-08'),data=[];
 for(let i=0;i<603;i++){const at=a+(i-1)*60000;data.push(['history/d/'+new Date(at).toISOString()+'/'+i,{traffic:sample(a-60000,at,i*10)}]);}
 const storage={async list(o){let list=data.filter(([k])=>k.startsWith(o.prefix)&&(!o.start||k>=o.start)&&(!o.end||k<o.end)&&(!o.startAfter||k>o.startAfter)).sort(([a],[b])=>a.localeCompare(b));if(o.reverse)list.reverse();return new Map(list.slice(0,o.limit));}};
 const x=await queryDailyTraffic(storage,new URL('https://x/?device_id=d&from=2026-09-08&to=2026-09-08'),a+86400000);
 assert.equal(x.days[0].rx_bytes,6010);
 await assert.rejects(()=>queryDailyTraffic(storage,new URL('https://x/?device_id=d&from=2025-01-01&to=2026-09-08')));
});
test('流量接口沿用管理登录且返回自然日数据',async()=>{
 const f=fixture(),url='/api/devices/traffic?device_id=d&from=2026-09-08&to=2026-09-08';
 assert.equal((await worker.fetch(request(url),f.env)).status,401);
 const cookie=await login(f),r=await worker.fetch(request(url,'GET',undefined,cookie),f.env);
 assert.equal(r.status,200);const x=await r.json();assert.equal(x.timezone,'Australia/Sydney');assert.equal(x.days[0].available,false);
});

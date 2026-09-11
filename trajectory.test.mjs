import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fixture,request,login} from './test-support.mjs';
import worker from './worker.js';
import {appendLocationHistory} from './location-history.js';
import {archiveMedia,queryTrajectoryMedia} from './trajectory-media.js';
import {recordingMetadata} from './media-recordings.js';
import {photoMetadata} from './report-photo.js';
const source=fs.readFileSync(new URL('./devices-client.js',import.meta.url),'utf8');
const c=vm.createContext({});vm.runInContext(source.slice(0,source.indexOf('// 轨迹纯规则结束。')),c);const T=c.Trajectory;
const plain=x=>JSON.parse(JSON.stringify(x));
const start=Date.parse('2026-09-11T00:00:00Z');
const row=(i,source='gps',acc_m=10)=>({report_id:'r'+i,timeline_at:new Date(start+i*900000).toISOString(),network:'wifi',location:{lat:0,lng:i*.0001,source,acc_m}});
test('轨迹100米边界、孤立粗定位与连续粗定位分别处理，保留原始坐标',()=>{
  assert.equal(T.quality(row(1,'wifi',100)),'good');assert.equal(T.quality(row(1,'cell',101)),'coarse');
  const rows=[row(0),row(1,'wifi',400),row(2),row(3,'cell',200),row(4,'wifi',300),row(5)];const before=JSON.stringify(rows),r=T.build(rows);
  assert.deepEqual(plain(r.segments),[[0,2],[5]]);assert.deepEqual(plain(r.ignored),[1]);assert.deepEqual(plain(r.areas),[3,4]);assert.equal(JSON.stringify(rows),before);
  assert.deepEqual(plain(T.build(rows.slice(0,2)).segments),[[0]]);assert.deepEqual(plain(T.build(rows.slice(0,2)).ignored),[1]);
  assert.deepEqual(plain(T.build([row(0),row(1),row(2)]).groups),[[0,1,2]]);
});
test('IP、长缺报和陈旧采样不跨接，蜂窝报告节拍不误判为Wi-Fi缺报',()=>{
  assert.deepEqual(plain(T.build([row(0),row(1,'ip',2000),row(2)]).segments),[[0],[2]]);
  assert.deepEqual(plain(T.build([row(0),row(4)]).segments),[[0],[1]]);
  assert.deepEqual(plain(T.build([row(0),row(4)].map(r=>({...r,network:'cellular'}))).segments),[[0,1]]);
  const stale={...row(4),sample_at:new Date(start).toISOString()};assert.equal(T.quality(stale),'gap');
  assert.deepEqual(plain(T.build([row(0),{...row(1),location:null},row(2)]).segments),[[0],[2]]);
});
test('悉尼日期范围包含夏令时23与25小时，媒体播放不选择未来位置',()=>{
  for(const [date,hours] of [['2026-10-04',23],['2026-04-05',25],['2026-09-11',24]]){const r=T.dayRange(date,date);assert.equal(r.to-r.from+1,hours*3600000);}
  const e=[{at:10},{at:20},{at:30}];assert.equal(T.nearest(e,18),1);assert.equal(T.preceding(e,18),0);assert.equal(T.preceding(e,5),-1);assert.equal(T.preceding(e,30),2);
});
test('照片严格按报告关联，独立媒体保留自身时间，录音覆盖时段可关联多个报告',()=>{
  const rows=[row(0),row(1)],media=[{id:'p',report_id:'r0',type:'photo',captured_at:start+15000},{id:'manual',type:'photo',report_id:'manual',captured_at:start+60000},{id:'a',type:'audio',captured_at:start-1000,ended_at:start+1000000}];
  const events=T.events(rows,media);assert.equal(events.length,4);
  assert.equal(T.related(events.find(e=>e.key==='report:r0'),media).length,2);
  assert.equal(T.related(events.find(e=>e.key==='report:r1'),media).some(m=>m.type==='photo'),false);
  assert.equal(events.find(e=>e.key==='photo:manual').record,undefined);
});
test('历史电量、充电和无电池写入；旧hash报告重试仍兼容，新hash能检测变更',async()=>{
  const f=fixture();const data={report_id:'r',reported_at:'2026-09-11T00:00:00Z',network:'wifi',battery:65,charging:true,battery_present:true};
  const saved=await appendLocationHistory(f.storage,'fixture',data,'',null,start);
  assert.equal(saved.record.battery,65);assert.equal(saved.record.charging,true);assert.equal(saved.record.battery_present,true);
  await assert.rejects(()=>appendLocationHistory(f.storage,'fixture',{...data,charging:false},'',null,start),/内容不一致/);
  const key='history-id/fixture/r',index=f.data.get(key);
  const old={reported_at:data.reported_at.replace('00Z','00.000Z'),gps:null,wifi:null,cell:null,network:'wifi',battery:65,app_version:'',os_version:'',ready:null,status_request_id:null};
  index.hash=createHash('sha256').update(JSON.stringify(old)).digest('hex');delete index.hash_version;f.data.set(key,index);
  assert.equal((await appendLocationHistory(f.storage,'fixture',data,'',null,start)).duplicate,true);
  const absent=(await appendLocationHistory(f.storage,'fixture',{report_id:'empty'},'',null,start)).record;assert.equal(absent.battery,null);assert.equal(absent.charging,null);
  const mains=(await appendLocationHistory(f.storage,'fixture',{report_id:'mains',battery_present:false},'',null,start)).record;assert.equal(mains.battery_present,false);
});
const query=(device,from=start,to=start+3600000,cursor='')=>new URL('https://example.test/api/devices/trajectory-media?'+new URLSearchParams({device_id:device,from:new Date(from).toISOString(),to:new Date(to).toISOString(),...(cursor?{cursor}:{})}));
test('媒体索引鉴权、设备隔离、跨范围录音、过期保留和分页',async()=>{
  const f=fixture();const url=query('fixture');assert.equal((await worker.fetch(request(url.pathname+url.search),f.env)).status,401);
  for(let i=0;i<501;i++)await archiveMedia(f.storage,{device_id:'fixture',id:'a'+i,type:'audio',captured_at:start-1000+i,duration_ms:2000,expires_at:start+10000,object_key:'private-object'});
  await archiveMedia(f.storage,{device_id:'other',report_id:'secret',captured_at:start,expires_at:start+10000},'photo');
  const a=await queryTrajectoryMedia(f.storage,url,start+20000);assert.equal(a.records.length,500);assert.equal(a.records[0].expired,true);assert.ok(a.next_cursor);assert.doesNotMatch(JSON.stringify(a),/private-object|secret/);
  const b=await queryTrajectoryMedia(f.storage,query('fixture',start,start+3600000,a.next_cursor),start+20000);assert.equal(b.records.length,1);assert.equal(b.next_cursor,null);
  const cookie=await login(f);assert.equal((await worker.fetch(request(url.pathname+url.search,'GET',undefined,cookie),f.env)).status,200);
});
test('旧照片清理前补事件索引，七天后显示过期，旧正文和元数据删除',async()=>{
  const f=fixture(),photo={device_id:'fixture',report_id:'legacy',captured_at:new Date(start).toISOString(),expires_at:start+1000,ready:true,expiry_key:'expiry',object_key:'private'};
  f.data.set('report-photo/fixture/legacy',photo);
  const result=await photoMetadata(f.storage,request('/','POST',{action:'removed',device_id:'fixture',report_id:'legacy'}),async()=>[],async()=>{},start+2000);
  assert.equal(result.status,200);assert.equal(f.data.has('report-photo/fixture/legacy'),false);
  const media=await queryTrajectoryMedia(f.storage,query('fixture'),start+2000);assert.equal(media.records[0].expired,true);assert.equal(media.records[0].time_source,'device');
});
test('录制使用浏览器开始时间，重复分段不重复索引，结束与中断清理保留时长',async()=>{
  const f=fixture();let now=start;
  const rpc=async data=>{const r=await recordingMetadata(f.storage,request('/','POST',{device_id:'fixture',id:'audio',...data}),async()=>[{id:'fixture'}],now);assert.equal(r.status,200);return r.json();};
  await rpc({action:'create',type:'audio',mime:'audio/webm;codecs=opus'});now+=30000;
  const part={action:'part',index:0,bytes:10,sha256:'a'.repeat(64),captured_at:start+5000,duration_ms:20000};await rpc(part);await rpc(part);
  await rpc({...part,index:1,duration_ms:30000});
  let list=await queryTrajectoryMedia(f.storage,query('fixture'),now);assert.equal(list.records.length,1);assert.equal(list.records[0].duration_ms,30000);assert.equal(list.records[0].captured_at,start+5000);
  await rpc({action:'finish',parts:2,duration_ms:31000});list=await queryTrajectoryMedia(f.storage,query('fixture'),now);assert.equal(list.records[0].complete,true);assert.equal(list.records[0].duration_ms,31000);
  now=start+8*86400000;await rpc({action:'removed'});list=await queryTrajectoryMedia(f.storage,query('fixture'),now);assert.equal(list.records[0].expired,true);assert.equal(list.records[0].duration_ms,31000);
});

test('媒体回放只推进对应录制和报告，不跳到其它媒体事件',()=>{
  const media={id:'a',type:'audio',captured_at:10};
  const events=[{at:10,media},{at:11,media:{id:'v',type:'video'}},{at:12,record:{}}];
  assert.equal(T.playbackIndex(events,media,11),0);assert.equal(T.playbackIndex(events,media,12),2);
});
test('媒体索引第二页从游标开始，不重复扫描前页历史',async()=>{
  const f=fixture();for(let i=0;i<1100;i++)await archiveMedia(f.storage,{device_id:'fixture',id:'a'+i,type:'audio',captured_at:start+i,duration_ms:0,expires_at:start});
  const first=await queryTrajectoryMedia(f.storage,query('fixture'),start+8*86400000);let count=0;const list=f.storage.list;f.storage.list=async p=>{assert.equal(p.startAfter,first.next_cursor);const result=await list(p);count+=result.size;return result;};
  const next=await queryTrajectoryMedia(f.storage,query('fixture',start,start+3600000,first.next_cursor),start+8*86400000);assert.equal(next.records.length,500);assert.equal(count,501);
  await assert.rejects(()=>queryTrajectoryMedia(f.storage,query('other',start,start+3600000,first.next_cursor)),/分页位置无效/);
});
test('重复拖动同一点不重复请求照片，返回实时后选点恢复轨迹图层',()=>{
  const context=vm.createContext({URLSearchParams,adminSession:{check(){}},setTimeout(){},setInterval(){},document:{getElementById:()=>null}});vm.runInContext(source,context);
  context.selDev='fixture';context.selFn='locate';context.DEV=[{id:'fixture'}];const s=context.historyState();
  s.events=[{key:'report:r',at:start,record:row(0)}];s.selected=0;s.historical=true;s.viewFrom=start;s.viewTo=start+1000;
  let render=0,draw=0;context.renderRemoteConsole=()=>render++;context.trajectoryDrawSelected=()=>{};context.trajectoryDrawMap=()=>draw++;
  context.trajectorySelect(0);assert.equal(render,0);s.historical=false;context.trajectorySelect(0);assert.equal(render,1);assert.equal(draw,1);
});

test('跨午夜后拍摄的报告照片仍归属原报告日期，拍摄时间保留',async()=>{
 const f=fixture();await archiveMedia(f.storage,{device_id:'fixture',report_id:'midnight',report_timeline_at:new Date(start-1000).toISOString(),captured_at:start+2000,expires_at:start+86400000},'photo');
 const page=await queryTrajectoryMedia(f.storage,query('fixture',start-86400000,start-1),start+10000);
 assert.equal(page.records.length,1);assert.equal(page.records[0].captured_at,start+2000);assert.equal(page.records[0].timeline_at,start-1000);
});

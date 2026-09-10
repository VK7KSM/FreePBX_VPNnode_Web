import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import source from './devices-client-source.js';
import worker from './worker.js';
import {fixture,login,request} from './test-support.mjs';
import {photoMetadata,cleanupPhotos} from './report-photo.js';

test('照片历史分页隔离设备，排除未上传和过期照片，查询需管理员登录',async()=>{
  const f=fixture(),cookie=await login(f);f.env.ELF_ARTIFACTS={};
  for(let i=0;i<102;i++)f.data.set('report-photo/a/'+String(i).padStart(3,'0'),{report_id:String(i).padStart(3,'0'),captured_at:new Date().toISOString(),expires_at:Date.now()+60000,ready:i!==3,object_key:'private',...(i===4?{expires_at:1}:{})});
  f.data.set('report-photo/b/other',{ready:true,expires_at:Date.now()+60000});
  const url='/api/elfremote/report-photo?list=1&device_id=a';
  assert.equal((await worker.fetch(request(url),f.env)).status,401);
  const first=await (await worker.fetch(request(url,'GET',undefined,cookie),f.env)).json();
  assert.equal(first.photos.length,98);assert.equal(first.next,'099');assert.equal(first.photos[0].object_key,undefined);
  const last=await (await worker.fetch(request(url+'&cursor='+first.next,'GET',undefined,cookie),f.env)).json();
  assert.equal(last.photos.length,2);assert.equal(last.next,null);
  assert.equal((await worker.fetch(request(url+'&cursor=../b','GET',undefined,cookie),f.env)).status,400);
});

test('七天到期即停止访问，R2删除失败保留索引供下次重试',async()=>{
  const f=fixture(),at=Date.now(),ttl=7*86400000;
  const photo={device_id:'a',report_id:'one',ready:true,expires_at:at+ttl,expiry_key:'report-photo-expiry/'+String(at+ttl)+'/a/one',object_key:'object'};
  await f.storage.put('report-photo/a/one',photo);await f.storage.put(photo.expiry_key,photo);
  const get=now=>photoMetadata(f.storage,new Request('https://test',{method:'POST',body:JSON.stringify({action:'get',device_id:'a',report_id:'one'})}),async()=>[],async()=>{},now);
  assert.equal((await get(at+ttl-1)).status,200);assert.equal((await get(at+ttl)).status,404);
  photo.expires_at=1;await f.storage.delete(photo.expiry_key);photo.expiry_key='report-photo-expiry/0000000000001/a/one';
  await f.storage.put('report-photo/a/one',photo);await f.storage.put(photo.expiry_key,photo);
  f.env.ELF_ARTIFACTS={async delete(){throw Error('temporary');}};
  await assert.rejects(cleanupPhotos(f.env,f.env.ELF_DO.get('main')));assert.ok(f.data.has(photo.expiry_key));
  f.env.ELF_ARTIFACTS.delete=async()=>{};await cleanupPhotos(f.env,f.env.ELF_DO.get('main'));
  assert.equal(f.data.has(photo.expiry_key),false);assert.equal(f.data.has('report-photo/a/one'),false);
});

test('照片按拍摄时间翻看，自动刷新保留选择，切设备不串台，边界与过期照片不可选',async()=>{
  const c=vm.createContext({adminSession:{check(){}},setTimeout(){},setInterval(){},URLSearchParams});vm.runInContext(source,c);
  const a={id:'a'},b={id:'b'};c.DEV=[a,b];c.selDev='a';let renders=0;c.renderRemoteConsole=()=>renders++;
  const p=n=>({report_id:String(n),captured_at:'2026-09-09T00:00:0'+n+'Z',expires_at:Date.now()+60000});
  let finish;c.fetch=()=>new Promise(r=>finish=r);const loading=c.loadReportPhotos(a);
  c.selDev='b';finish({ok:true,json:async()=>({ok:true,photos:[p(1),p(2)],next:null})});await loading;
  assert.equal(renders,0);assert.equal(c.photoHistory(b).photos.length,0);c.selDev='a';
  assert.match(c.reportPhotoHtml(a),/report_id=2/);assert.match(c.reportPhotoHtml(a),/2026\/9\/9 10:00:02/);
  c.stepReportPhoto(1);assert.equal(c.photoHistory(a).selected,'1');
  c.photoHistory(a).photos.unshift(p(3));assert.match(c.reportPhotoHtml(a),/report_id=1/);
  c.stepReportPhoto(1);assert.equal(c.photoHistory(a).selected,'1');
  c.stepReportPhoto(-1);c.stepReportPhoto(-1);assert.equal(c.photoHistory(a).selected,null);
  c.photoHistory(a).photos[0].expires_at=1;assert.match(c.reportPhotoHtml(a),/report_id=2/);
  assert.match(c.reportPhotoHtml(b),/aria-label="上一张照片"[^>]*disabled/);
});

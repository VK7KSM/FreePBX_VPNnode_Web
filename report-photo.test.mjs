import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture,login,request} from './test-support.mjs';
import {PHOTO_MAX,cleanupPhotos} from './report-photo.js';
const token='photo-test-token',sha=b=>createHash('sha256').update(b).digest('hex');
function setup(){
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'test',enabled:true,status_only:true,token_sha256:sha(token)}]});
  const objects=new Map();f.objects=objects;
  f.env.ELF_ARTIFACTS={async put(k,b,opt){assert.equal(sha(b),opt.sha256);objects.set(k,Buffer.from(b));},
    async get(k){return objects.has(k)?{body:objects.get(k)}:null;},async delete(k){objects.delete(k);}};
  return f;
}
const jpeg=Buffer.from([255,216,1,2,3,255,217]);
const upload=(f,id,bytes=jpeg,t=token)=>worker.fetch(new Request('https://example.test/api/elfremote/report-photo?'+new URLSearchParams({device_id:'test',report_id:id,captured_at:Date.now()}),
  {method:'POST',headers:{Authorization:'Bearer '+t,'Content-Length':String(bytes.length)},body:bytes}),f.env);
async function report(f,id,network='wifi',report_event){
  const r=await worker.fetch(request('/api/devices/report','POST',{device_id:'test',token,report_id:id,reported_at:new Date().toISOString(),network,status_only:true,...(report_event?{report_event}:{})}),f.env);
  assert.equal(r.status,200);
}
test('照片必须跟随已确认报告，设备鉴权上传、管理员读取且重复上传幂等',async()=>{
  const f=setup(),c=await login(f);
  assert.equal((await upload(f,'before-report')).status,409);
  await report(f,'first');assert.equal((await upload(f,'first',jpeg,'wrong')).status,401);
  assert.equal((await upload(f,'first')).status,200);assert.equal((await upload(f,'first')).status,200);assert.equal(f.objects.size,1);
  const url='/api/elfremote/report-photo?device_id=test&report_id=first';
  assert.equal((await worker.fetch(request(url),f.env)).status,401);
  const response=await worker.fetch(request(url,'GET',undefined,c),f.env);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),jpeg);
  assert.equal((await upload(f,'first',Buffer.from([255,216,4,255,217]))).status,409);
});
test('普通蜂窝不拍照，最低电量例外允许且旧照片迟到不覆盖新照片',async()=>{
  const f=setup();await report(f,'cell','cellular');assert.equal((await upload(f,'cell')).status,409);
  await report(f,'old','cellular',{type:'low_battery',level:1,thresholds:[2],at:Date.now()});
  const index=f.data.get('history-id/test/old'),old=f.data.get(index.key);old.received_at=new Date(Date.now()-1000).toISOString();f.data.set(index.key,old);
  await report(f,'new');assert.equal((await upload(f,'new')).status,200);assert.equal((await upload(f,'old')).status,200);
  assert.equal(f.data.get('remote_devices')[0].report_photo.report_id,'new');
});
test('照片大小和格式有界，过期文件清理后移除最新显示入口',async()=>{
  const f=setup();await report(f,'limit');
  assert.equal((await upload(f,'limit',Buffer.alloc(PHOTO_MAX+1))).status,413);
  assert.equal((await upload(f,'limit',Buffer.from('not-jpeg'))).status,400);
  await upload(f,'limit');
  const m=f.data.get('report-photo/test/limit');f.data.delete(m.expiry_key);m.expires_at=1;m.expiry_key='report-photo-expiry/0000000000001/test/limit';f.data.set('report-photo/test/limit',m);f.data.set(m.expiry_key,m);
  await cleanupPhotos(f.env,f.env.ELF_DO.get('main'));assert.equal(f.objects.size,0);assert.equal(f.data.has('report-photo/test/limit'),false);assert.equal(f.data.get('remote_devices')[0].report_photo,undefined);
});
test('照片慢上传期间设备报告仍可完成',async()=>{
  const f=setup();await report(f,'first');let release,started;const wait=new Promise(r=>release=r),begun=new Promise(r=>started=r);
  f.env.ELF_ARTIFACTS.put=async()=>{started();await wait;};const sending=upload(f,'first');
  try{await begun;await report(f,'during-upload');}finally{release();await sending;}
});
test('照片存储暂时失败返回可重试状态，不提前宣布照片可见',async()=>{
  const f=setup();await report(f,'retry');f.env.ELF_ARTIFACTS.put=async()=>{throw Error('temporary storage failure');};
  assert.equal((await upload(f,'retry')).status,503);assert.equal(f.data.get('remote_devices')[0].report_photo,undefined);
  assert.equal(f.data.get('report-photo/test/retry').ready,false);
});

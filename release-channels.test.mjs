import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
import {RELEASE_CHANNELS,validateReleaseManifest} from './release-channels.js';

const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const hash=b=>createHash('sha256').update(b).digest('hex');
function signed(channel,changes={},bytes=Buffer.from(channel)){
 const m={...RELEASE_CHANNELS[channel],channel,versionCode:68,versionName:'1.0',certSha256:'a'.repeat(64),size:bytes.length,sha256:hash(bytes),job_id:'job-'+channel,expires_at:Date.now()+3600000,...changes};
 if(channel==='d31')m.certSha256=changes.certSha256||RELEASE_CHANNELS.d31.certSha256;
 m.url='https://v.elfradio.net/api/elfremote/apk/'+m.job_id;
 const manifest_raw=JSON.stringify(m);return {manifest_raw,signature:sign('sha256',Buffer.from(manifest_raw),keys.privateKey).toString('hex'),apk_b64:bytes.toString('base64'),publish_only:true};
}
test('独立发布通道从上传、筛选、分配到领取完整隔离，保留旧D22下载',async t=>{
 const original=crypto.subtle.importKey.bind(crypto.subtle);
 t.mock.method(crypto.subtle,'importKey',(format,data,algorithm,...rest)=>original(format,algorithm.name==='RSASSA-PKCS1-v1_5'?keys.publicKey.export({type:'spki',format:'der'}):data,algorithm,...rest));
 const f=fixture({admin_pass:'fixture-password',remote_devices:['d22','d31'].map(c=>({id:c,hardware_identity:{variant:c},enabled:true,status_only:true,managed_update:true,managed_update_v2:true,token_sha256:hash('token-'+c)}))});
 const objects=new Map();f.env.ELF_ARTIFACTS={async put(k,b,o){const bytes=Buffer.from(await new Response(b).arrayBuffer());if(o.sha256)assert.equal(hash(bytes),o.sha256);objects.set(k,bytes);},async get(k){return objects.has(k)?{body:objects.get(k)}:null;}};
 const cookie=await login(f);
 const post=(p,b)=>worker.fetch(request(p,'POST',b,cookie),f.env);
 const publish=b=>post('/api/elfremote/releases',b);
 const list=q=>worker.fetch(request('/api/elfremote/releases?'+q,'GET',undefined,cookie),f.env);
 const d22=signed('d22'),d31=signed('d31');
 for(const payload of [d22,d31]){const response=await publish(payload);assert.equal(response.status,200,await response.text());}
 assert.equal(f.data.get('remote_devices').every(d=>!d.update),true);
 const visible=await (await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).json();
 for(const c of ['d22','d31']){const d=visible.devices.find(d=>d.id===c);assert.equal(d.update_channel,c);assert.equal(d.can_update,true);}
 for(const c of ['d22','d31']){
  const body=await (await list('device_id='+c)).json();assert.equal(body.channel,c);assert.equal(body.releases.length,1);assert.equal(body.releases[0].package,RELEASE_CHANNELS[c].package);
  assert.equal(await (await worker.fetch(request('/api/elfremote/apk/job-'+c),f.env)).text(),c);
 }
 assert.equal((await list('device_id=d31&channel=d22')).status,400);
 assert.equal((await post('/api/elfremote/assign',{device_id:'d31',channel:'d22',versionCode:68})).status,400);
 const devices=f.data.get('remote_devices');devices[1].managed_update=false;f.data.set('remote_devices',devices);
 assert.equal((await post('/api/elfremote/assign',{device_id:'d31',channel:'d31',versionCode:68})).status,400);
 devices[1].managed_update=true;f.data.set('remote_devices',devices);
 const assignment={device_id:'d31',channel:'d31',versionCode:68,request_id:'fixture-request'};
 const first=await (await post('/api/elfremote/assign',assignment)).json();assert.equal(first.ok,true);assert.equal(first.update.channel,'d31');assert.match(first.update.job_id,/^update-/);
 assert.equal((await (await post('/api/elfremote/assign',assignment)).json()).update.job_id,first.update.job_id);
 const report=await worker.fetch(request('/api/devices/report','POST',{device_id:'d31',token:'token-d31',status_only:true,managed_update:true,managed_update_v2:true,report_id:'report-one',reported_at:new Date().toISOString()}),f.env);
 const offer=(await report.json()).managed_update;assert.equal(offer.manifest_raw,d31.manifest_raw);assert.equal(offer.task_device_id,'d31');assert.equal(offer.task_id,first.update.job_id);assert.ok(offer.task_expires_at>Date.now());
 for(const state of ['downloading','installing','success']){const response=await post('/api/elfremote/update-progress',{device_id:'d31',token:'token-d31',job_id:offer.task_id,state,detail:state==='success'?'health-ok':''});assert.equal(response.status,200);assert.equal((await response.json()).update.state,state);}
 assert.equal(f.data.get('remote_devices')[0].update,undefined);
 assert.equal((await publish(signed('d31',{job_id:'changed'},Buffer.from('changed')))).status,400);
 assert.equal((await publish(signed('d31',{job_id:'job-d22'}))).status,400);
 assert.equal((await publish(signed('d31',{job_id:'renewed'}))).status,200);
 assert.equal(await (await worker.fetch(request('/api/elfremote/apk/job-d31'),f.env)).text(),'d31');
 const stream=signed('d31',{versionCode:69,job_id:'stream'}),bytes=Buffer.from(stream.apk_b64,'base64');
 const upload=()=>worker.fetch(new Request('https://example.test/api/elfremote/releases/upload',{method:'PUT',headers:{Cookie:cookie,'X-Elf-Manifest':Buffer.from(stream.manifest_raw).toString('base64'),'X-Elf-Signature':stream.signature,'X-Elf-Publish-Only':'1','Content-Length':String(bytes.length)},body:bytes}),f.env);
 assert.equal((await upload()).status,200);assert.deepEqual((await (await list('channel=d31')).json()).releases.map(r=>r.versionCode),[69,68]);
 assert.equal((await (await list('')).json()).releases.length,1);
 for(const changes of [{package:'wrong'},{model_id:'mdl_d22'},{certSha256:'b'.repeat(64)},{channel:'pixel3'},{expires_at:1}])assert.equal((await publish(signed('d31',{job_id:crypto.randomUUID(),...changes}))).status,400);
 assert.equal((await publish({...d31,signature:'aa'})).status,400);
 f.data.set('elfremote_job_legacy',67);f.data.set('elfremote_rel_67',{apk_b64:Buffer.from('legacy').toString('base64')});
 assert.equal(await (await worker.fetch(request('/api/elfremote/apk/legacy'),f.env)).text(),'legacy');
 // 内部流式发布失败必须回滚整个索引事务。
 const before=structuredClone(f.data),put=f.storage.put;
 f.storage.put=async(k,v)=>{if(k==='elfremote_releases_d31')throw Error('fixture write failure');return put(k,v);};
 const failed=signed('d31',{versionCode:70,job_id:'rollback'});
 const response=await f.store.fetch(new Request('https://elf-store/__release',{method:'POST',body:JSON.stringify({...failed,apk_b64:undefined,apk_key:'apks/'+JSON.parse(failed.manifest_raw).sha256})}));
 assert.equal(response.status,400);assert.deepEqual(f.data,before);
});
test('历史D22清单兼容，其他机型不能借用D22通道',()=>{
 const m=JSON.parse(signed('d22').manifest_raw);delete m.channel;delete m.model_id;assert.equal(validateReleaseManifest(m),'d22');
 assert.throws(()=>validateReleaseManifest({...m,package:RELEASE_CHANNELS.d31.package}));
});

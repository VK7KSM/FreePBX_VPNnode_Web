import test from 'node:test';import assert from 'node:assert/strict';
import worker from './worker.js';import {fixture,request,login} from './test-support.mjs';
import {releaseKey,releaseListKey} from './release-channels.js';
import {cleanupRetiredReleases,retireReleases} from './release-retention.js';
function setup(){const f=fixture(),objects=new Set();for(const channel of ['d22','d31']){const ids=Array.from({length:12},(_,i)=>i+1);f.data.set(releaseListKey(channel),ids);for(const n of ids){const sha=(channel==='d22'?'a':'b')+n.toString(16).padStart(63,'0'),r={versionCode:n,versionName:'fixture-'+n,channel,sha256:sha,size:n,apk_key:'apks/'+sha,manifest_raw:'{}'};f.data.set(releaseKey(channel,n),r);objects.add(r.apk_key);}}f.env.ELF_ARTIFACTS={async delete(keys){for(const k of keys)objects.delete(k);}};return {...f,objects};}
test('清理需管理员，按通道保留十版并保护所有未决更新',async()=>{
 const f=setup(),cookie=await login(f),path='/api/elfremote/releases/prune';f.data.set('remote_devices',[{id:'synthetic',update:{job_id:'pending-update',channel:'d22',versionCode:1,state:'running'}}]);
 assert.equal((await worker.fetch(request(path,'POST',{action:'plan'}),f.env)).status,401);
 const post=body=>worker.fetch(request(path,'POST',body,cookie),f.env);const plan=await (await post({action:'plan'})).json();assert.equal(plan.channels.d22.keep.length,11);assert.equal(plan.channels.d31.keep.length,10);assert.equal(plan.keys.length,3);assert.equal(f.objects.size,24);
 assert.equal((await post({action:'apply',digest:'bad'})).status,409);assert.equal(f.objects.size,24);
 const result=await (await post({action:'apply',digest:plan.digest})).json();assert.equal(result.purged,3);assert.equal(f.objects.size,21);assert.equal(f.data.get(releaseKey('d22',2)).retired_at>0,true);assert.equal(f.data.get(releaseListKey('d31')).length,10);
 assert.equal((await worker.fetch(request('/api/elfremote/assign','POST',{device_id:'synthetic',versionCode:2},cookie),f.env)).status,404);
});
test('R2失败保留清理队列，重试前保护并发新发布复用的APK',async()=>{
 const f=setup(),c=await login(f),post=body=>worker.fetch(request('/api/elfremote/releases/prune','POST',body,c),f.env);
 const plan=await (await post({action:'plan'})).json(),del=f.env.ELF_ARTIFACTS.delete;f.env.ELF_ARTIFACTS.delete=async()=>{throw Error('模拟存储失败');};
 assert.equal((await (await post({action:'apply',digest:plan.digest})).json()).cleanup_pending,true);assert.equal(f.objects.size,24);assert.equal(f.data.get('elfremote_apk_cleanup_pending').length,4);
 const r=f.data.get(releaseKey('d22',1));f.data.set(releaseKey('d22',13),{...r,versionCode:13,retired_at:undefined});f.data.get(releaseListKey('d22')).push(13);
 f.env.ELF_ARTIFACTS.delete=del;const result=await (await post({action:'retry'})).json();assert.equal(result.purged,3);assert.equal(f.objects.has(r.apk_key),true);assert.equal(f.data.get('elfremote_apk_cleanup_pending').length,0);
});

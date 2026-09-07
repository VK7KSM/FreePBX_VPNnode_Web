import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {saveReleaseApk} from './update-artifacts.js';
import worker from './worker.js';
import {fixture,request} from './test-support.mjs';

test('更新制品校验后进入私有对象存储，下载不依赖状态中的Base64',async()=>{
  const bytes=Buffer.alloc(512*1024,7),sha256=createHash('sha256').update(bytes).digest('hex');
  const f=fixture(),objects=new Map();
  f.env.ELF_ARTIFACTS={async put(key,value){objects.set(key,value);},async get(key){return objects.has(key)?{body:objects.get(key)}:null;}};
  const manifest={size:bytes.length,sha256};
  const key=await saveReleaseApk(f.env,manifest,bytes.toString('base64'));
  f.data.set('elfremote_job_fixture-job',100);
  f.data.set('elfremote_rel_100',{apk_key:key,...manifest});
  const response=await worker.fetch(request('/api/elfremote/apk/fixture-job'),f.env);
  assert.equal(response.status,200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
  await assert.rejects(saveReleaseApk(f.env,{...manifest,size:1},bytes.toString('base64')));
  await assert.rejects(saveReleaseApk(f.env,{...manifest,sha256:'0'.repeat(64)},bytes.toString('base64')));
  assert.equal(objects.size,1);
});

test('旧制品仍可下载，新制品缺失不返回空APK',async()=>{
  const f=fixture();
  f.data.set('elfremote_job_fixture-job',100);
  f.data.set('elfremote_rel_100',{apk_b64:Buffer.from('fixture').toString('base64')});
  assert.equal(await (await worker.fetch(request('/api/elfremote/apk/fixture-job'),f.env)).text(),'fixture');
  f.data.set('elfremote_rel_100',{apk_key:'apks/fixture'});
  assert.equal((await worker.fetch(request('/api/elfremote/apk/fixture-job'),f.env)).status,503);
});

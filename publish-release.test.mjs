import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {publishRelease,validateInput,sessionCookie} from './elfRemote/tools/publish_release.mjs';
import {RELEASE_CHANNELS} from './release-channels.js';
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const bytes=Buffer.from('fixture-d31'),manifest={...RELEASE_CHANNELS.d31,channel:'d31',versionCode:68,versionName:'1.0',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),job_id:'fixture',expires_at:Date.now()+600000,url:'https://v.elfradio.net/api/elfremote/apk/fixture'};
const raw=JSON.stringify(manifest),input={manifest_raw:raw,signature:sign('sha256',Buffer.from(raw),keys.privateKey).toString('hex'),apk_b64:bytes.toString('base64')};
const session={cookies:[{name:'elf_admin',domain:'v.elfradio.net',value:'fixture-session',expires:Date.now()/1000+600}]};
test('发布工具默认只上传，核验签名与生产下载，可选下发使用对应通道',async()=>{
 for(const assign of [undefined,'fixture-device']){
  const calls=[];const fetcher=async(url,options={})=>{
   assert.ok(url.startsWith('https://v.elfradio.net/'));assert.equal(options.redirect,'error');calls.push({url,options});
   if(url===manifest.url){assert.equal(options.headers,undefined);return new Response(bytes);}
   assert.equal(options.headers.Cookie,'elf_admin=fixture-session');
   if(url.endsWith('/upload')){assert.equal(options.headers['X-Elf-Publish-Only'],'1');assert.deepEqual(options.body,bytes);return Response.json({ok:true,...manifest});}
   if(url.endsWith('/assign')){const data=JSON.parse(options.body);assert.equal(data.channel,'d31');assert.equal(data.device_id,assign);return Response.json({ok:true});}
   return Response.json({ok:true,channel:'d31',releases:[manifest]});
  };
  const result=await publishRelease({input,session,assign,publicKey:keys.publicKey},fetcher);assert.equal(result.assigned,!!assign);assert.equal(calls.length,assign?5:4);
 }
});
test('发布工具拒绝被改动的APK、签名、错误站点或过期会话',()=>{
 assert.throws(()=>validateInput({...input,apk_b64:Buffer.from('bad').toString('base64')},keys.publicKey));
 assert.throws(()=>validateInput({...input,signature:'aa'},keys.publicKey));
 assert.throws(()=>sessionCookie({cookies:[{...session.cookies[0],domain:'wrong.test'}]}));
 assert.throws(()=>sessionCookie({cookies:[{...session.cookies[0],expires:1}]}));
 const m={...manifest,url:'https://wrong.test/api/elfremote/apk/fixture'},manifest_raw=JSON.stringify(m);
 assert.throws(()=>validateInput({...input,manifest_raw,signature:sign('sha256',Buffer.from(manifest_raw),keys.privateKey).toString('hex')},keys.publicKey));
});

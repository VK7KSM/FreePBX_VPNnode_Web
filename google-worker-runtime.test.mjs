import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import * as runtime from 'miniflare';

test('Workers实际Request规则允许Google请求，且不跟随携带密钥的重定向',async()=>{
 const bundled=await build({stdin:{contents:`
 import {googleLocation} from './google-geolocation.js';
 export default {async fetch(){
   const rows=new Map();const env={GOOGLE_GEOLOCATION_API_KEY:'fixture-key',__storage:{get:async k=>rows.get(k),put:async(k,v)=>rows.set(k,v)}};
   const now=Date.now();const radio={sampled_at_ms:now,wifiAccessPoints:[{macAddress:'10:11:22:33:44:55',signalStrength:-50},{macAddress:'20:11:22:33:44:55',signalStrength:-60}]};
   let mode;
   const result=await googleLocation(env,'fixture',{radio},now,async(url,init)=>{
     const request=new Request(url,init);mode=request.redirect;
     return Response.json({location:{lat:1,lng:2},accuracy:42});
   });
   return Response.json({result,mode,used:rows.get('google-usage/billing-primary')?.used});
 }};`,resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'browser'});
 const options={modules:true,compatibilityDate:'2024-09-23',script:bundled.outputFiles[0].text};
 const mf=new runtime.Miniflare(runtime.convertV4MiniflareOptions?runtime.convertV4MiniflareOptions(options):options);
 try {
   const value=await (await mf.dispatchFetch('https://unit.test')).json();
   assert.equal(value.result.reason,'located');assert.equal(value.mode,'manual');assert.equal(value.used,1);
 }finally{await mf.dispose();}
});

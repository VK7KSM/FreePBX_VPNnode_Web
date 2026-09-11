import test from 'node:test';
import assert from 'node:assert/strict';
import {kvJson,putKvJson,panelRead,panelWrite} from './panel-kv.js';
import {handleKvAuth} from './admin-auth.js';

function fixture(values={}){
 const data=new Map(Object.entries(values));const reads=[];
 const env={SUB_STORE_KV:{async get(key){reads.push(key);return structuredClone(data.get(key)??null);},async put(key,value){data.set(key,JSON.parse(value));},async delete(key){data.delete(key);}}};
 return {env,data,reads};
}

test('普通配置的重复读取复用快照且不共享可变对象，写入绕过旧快照并立即失效',async()=>{
 const f=fixture({'panel/proxy':{nodes:[{name:'原值'}],sub_token:'原令牌'}});
 for(let i=0;i<20;i++)(await kvJson(f.env,'panel/proxy')).nodes[0].name='外部改动';
 assert.equal(f.reads.length,1);assert.equal((await kvJson(f.env,'panel/proxy')).nodes[0].name,'原值');
 // 另一实例刚写入，管理保存必须重新读 KV，不能用旧本地快照覆盖未修改字段。
 f.data.set('panel/proxy',{nodes:[{name:'另一实例新值'}],sub_token:'原令牌'});
 await panelWrite(f.env,{sub_token:'新令牌'});
 assert.equal(f.data.get('panel/proxy').nodes[0].name,'另一实例新值');
 assert.equal(await panelRead({...f.env,__panelReads:{}},'sub_token'),'新令牌');
});

test('并发读取只调用一次KV，认证资料跨HTTP请求不保留成功缓存',async()=>{
 const f=fixture({'panel/auth':{revision:'旧版本'}});
 let release;f.env.SUB_STORE_KV.get=key=>{f.reads.push(key);return new Promise(resolve=>{release=()=>resolve({revision:'旧版本'});});};
 const pending=Array.from({length:20},()=>kvJson(f.env,'panel/auth'));
 await Promise.resolve();release();await Promise.all(pending);assert.equal(f.reads.length,1);
 f.env.SUB_STORE_KV.get=async key=>{f.reads.push(key);return {revision:'新版本'};};
 assert.equal((await kvJson(f.env,'panel/auth')).revision,'新版本');assert.equal(f.reads.length,2);
});

test('同请求鉴权读取复用、注销或改密写入后同请求也不接受旧缓存',async()=>{
 const f=fixture({'panel/auth':{revision:'旧版本'}}),request=new Request('https://example.test/api/save');
 for(let i=0;i<20;i++)await kvJson(f.env,'panel/auth',{request});
 assert.equal(f.reads.length,1);
 await putKvJson(f.env,'panel/auth',{revision:'新版本'});
 assert.equal((await kvJson(f.env,'panel/auth',{request})).revision,'新版本');assert.equal(f.reads.length,2);
 const other=new Request(request);await kvJson(f.env,'panel/auth',{request:other});assert.equal(f.reads.length,3);
});

test('写入期间返回的旧在途读取不会重新污染缓存',async()=>{
 const f=fixture();let release;
 f.env.SUB_STORE_KV.get=key=>{f.reads.push(key);if(f.reads.length===1)return new Promise(resolve=>{release=()=>resolve({revision:'旧版本'});});return Promise.resolve(f.data.get(key));};
 const pending=kvJson(f.env,'panel/auth');await Promise.resolve();
 await putKvJson(f.env,'panel/auth',{revision:'新版本'});release();
 assert.equal((await pending).revision,'新版本');
});

test('认证读取故障短暂合并并失败关闭，匿名或格式伪造请求不读取KV',async()=>{
 const f=fixture();f.env.SUB_STORE_KV.get=async key=>{f.reads.push(key);throw Error('quota');};
 for(let i=0;i<20;i++)await assert.rejects(kvJson(f.env,'panel/auth'),/quota/);
 assert.equal(f.reads.length,1);
 for(const cookie of ['', 'elf_admin=fake','elf_admin=v2.fake.fake']){
  const request=new Request('https://example.test/api/session',{headers:{Cookie:cookie}});
  assert.equal((await handleKvAuth(f.env,request,'session')).status,401);
 }
 assert.equal(f.reads.length,1);
});

test('缓存容量有界，过期配置必须重新读取而不无限保留',async()=>{
 const f=fixture(),originalNow=Date.now;let now=100000;Date.now=()=>now;
 try{
  await kvJson(f.env,'panel/proxy');now+=15001;await kvJson(f.env,'panel/proxy');assert.equal(f.reads.length,2);
  for(let i=0;i<129;i++)await kvJson(f.env,'panel/cache/'+i);
  const before=f.reads.length;await kvJson(f.env,'panel/cache/0');assert.equal(f.reads.length,before+1);
 }finally{Date.now=originalNow;}
});

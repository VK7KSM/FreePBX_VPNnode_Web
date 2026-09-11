import test from 'node:test';import assert from 'node:assert/strict';
import worker from './worker.js';import {fixture,request,login} from './test-support.mjs';
import {handleKvAuth} from './admin-auth.js';
function withKv(f){const values=new Map(),writes=[];let reads=0;f.env.SUB_STORE_KV={
 async get(key,options){reads++;const raw=values.get(key);return raw===undefined?null:options?.type==='json'?JSON.parse(raw):raw;},
 async put(key,value,options){values.set(key,value);writes.push({key,options});},async delete(key){values.delete(key);}
 };return {values,writes,reads:()=>reads};}
async function migrated(){const f=fixture({admin_pass:'fixture-password',nodes:[{name:'已有节点'}],sub_token:'valid-sub',sip_config_rev:5,sip_heartbeat_token:'service-token'}),kv=withKv(f),cookie=await login(f);
 const r=await worker.fetch(request('/api/admin/prepare-kv','POST',{},cookie),f.env);assert.equal(r.status,200);assert.equal((await r.json()).sessions,1);f.env.PANEL_KV_ENABLED='1';return {...f,kv,cookie};}
test('迁移保留当前口令与旧会话，签名登录无需新增KV会话写入',async()=>{
 const f=await migrated();assert.ok(f.data.has('panel_kv_backup'));assert.ok(!JSON.stringify([...f.kv.values]).includes('fixture-password'));
 assert.equal((await worker.fetch(request('/api/session','GET',undefined,f.cookie),f.env)).status,200);
 const before=f.kv.writes.length,cookie=await login(f);assert.ok(cookie.includes('v2.'));assert.equal(f.kv.writes.length,before);
 assert.equal((await worker.fetch(request('/api/session','GET',undefined,cookie),f.env)).status,200);
 assert.equal((await worker.fetch(request('/api/session','GET',undefined,cookie+'x'),f.env)).status,401);
 const requestLogout=request('/api/logout','POST',{},cookie);assert.equal((await worker.fetch(requestLogout,f.env)).status,200);
 assert.equal((await worker.fetch(request('/api/session','GET',undefined,cookie),f.env)).status,401);
});
test('DO额度耗尽时登录、代理订阅及SIP配置拉取仍成功，设备操作保持503',async()=>{
 const f=await migrated();let calls=0;f.env.ELF_DO.get=()=>({fetch(){calls++;throw Error('Exceeded allowed volume of requests in Durable Objects free tier.');}});
 assert.equal((await worker.fetch(request('/api/devices','GET',undefined,f.cookie),f.env)).status,503);
 const cookie=await login(f);for(const path of ['/api/session','/api/data','/sub/valid-sub'])assert.equal((await worker.fetch(request(path,'GET',undefined,cookie),f.env)).status,200,path);
 const pull=await worker.fetch(request('/api/sip/pull?applied=5','GET',undefined,null,{'X-Heartbeat-Token':'service-token'}),f.env);assert.equal(pull.status,200);assert.equal((await pull.json()).config_rev,5);
 assert.equal(calls,1);
});
test('代理与SIP分别整份保存，配置版本和内容不拆成多次KV写入',async()=>{
 const f=await migrated();let n=f.kv.writes.length;
 assert.equal((await worker.fetch(request('/api/save','POST',{nodes:[],cf_ip:'example.test',sub_token:'changed'},f.cookie),f.env)).status,200);
 assert.equal(f.kv.writes.length-n,1);assert.equal(f.kv.writes.at(-1).key,'panel/proxy');
 n=f.kv.writes.length;const response=await worker.fetch(request('/api/sip/save','POST',{extensions:[],groups:[],gateways:[{ext:'300',name:'测试网关'}]},f.cookie),f.env);
 assert.equal(response.status,200,await response.clone().text());assert.equal(f.kv.writes.length-n,1);const snapshot=JSON.parse(f.kv.values.get('panel/sip'));assert.equal(snapshot.sip_config_rev,6);assert.deepEqual(snapshot.sip_extensions,[]);
});
test('改密码撤销签名及迁移会话，旧DO口令不回退，新会话无需等待新KV键传播',async()=>{
 const f=await migrated(),cookie=await login(f);
 assert.equal((await worker.fetch(request('/api/save','POST',{new_password:'new-password'},cookie),f.env)).status,200);
 for(const c of [cookie,f.cookie])assert.equal((await worker.fetch(request('/api/session','GET',undefined,c),f.env)).status,401);
 assert.equal((await worker.fetch(request('/api/login','POST',{username:'admin',password:'fixture-password'}),f.env)).status,401);
 const r=await worker.fetch(request('/api/login','POST',{username:'admin',password:'new-password'}),f.env);assert.equal(r.status,200);
 assert.equal((await worker.fetch(request('/api/session','GET',undefined,r.headers.get('Set-Cookie').split(';')[0]),f.env)).status,200);
 const auth=f.kv.values.get('panel/auth');f.kv.values.delete('panel/auth');assert.equal((await worker.fetch(request('/api/session','GET',undefined,cookie),f.env)).status,503);f.kv.values.set('panel/auth',auth);
});
test('迁移后尚未切入口时账户已使用KV，旧DO写配置被拒绝而不会悄悄丢失',async()=>{
 const f=await migrated();f.env.PANEL_KV_ENABLED='0';const cookie=await login(f);assert.ok(cookie.includes('v2.'));
 assert.equal((await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).status,200);
 assert.notEqual((await worker.fetch(request('/api/save','POST',{nodes:[]},cookie),f.env)).status,200);
});
test('KV签名会话过期后失效，错误密码有界退避，不写全局计数键',async()=>{
 const f=await migrated(),cookie=await login(f),n=f.kv.writes.length;
 assert.equal((await handleKvAuth(f.env,request('/api/session','GET',undefined,cookie),'session',undefined,Date.now()+15*86400000)).status,401);
 for(let i=0;i<8;i++)assert.equal((await worker.fetch(request('/api/login','POST',{username:'admin',password:'wrong'}),f.env)).status,401);
 assert.equal((await worker.fetch(request('/api/login','POST',{username:'admin',password:'wrong'}),f.env)).status,429);assert.equal(f.kv.writes.length,n);
});

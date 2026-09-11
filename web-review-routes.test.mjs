import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';
import {CF_USAGE_KEY} from './cf-usage.js';

async function migrated(devices=[]){
 const f=fixture({admin_pass:'fixture-password',remote_devices:devices}),values=new Map(),reads=[];
 f.env.SUB_STORE_KV={
  async get(key,options){reads.push(key);const value=values.get(key);return value===undefined?null:options?.type==='json'?JSON.parse(value):value;},
  async put(key,value){values.set(key,value);},async delete(key){values.delete(key);}
 };
 const legacy=await login(f);
 assert.equal((await worker.fetch(request('/api/admin/prepare-kv','POST',{},legacy),f.env)).status,200);
 f.env.PANEL_KV_ENABLED='1';const cookie=await login(f);reads.length=0;
 return {...f,values,reads,cookie};
}
function device(model='d22'){
 return {id:'fixture-device',enabled:true,status_only:true,model_id:'mdl_'+model,
  token_sha256:createHash('sha256').update('fixture-token').digest('hex'),
  managed_log_tasks:true,managed_system_settings:true,managed_config_tasks:true};
}
const task=(f,type,params,id='fixture-task',extra={})=>worker.fetch(request('/api/elfremote/task','POST',{
 device_id:'fixture-device',type,params,id
},f.cookie,extra),f.env);

test('CF用量入口匿名拒绝、KV登录后正常读取共享快照且不访问设备DO',async()=>{
 const f=await migrated();let calls=0;f.env.ELF_DO.get=()=>({fetch(){calls++;throw Error('DO must not be called');}});
 f.values.set(CF_USAGE_KEY,JSON.stringify({version:1,status:'ready',generatedAt:new Date().toISOString(),metrics:[{id:'workers_requests',used:123}]}));
 assert.equal((await worker.fetch(request('/api/cf-usage'),f.env)).status,401);
 const response=await worker.fetch(request('/api/cf-usage','GET',undefined,f.cookie),f.env);
 assert.equal(response.status,200);const body=await response.json();assert.equal(body.ok,true);assert.equal(body.metrics[0].used,123);
 assert.equal(calls,0);
 assert.equal((await worker.fetch(request('/api/cf-usage','POST',{},f.cookie),f.env)).status,405);
});

test('设备DO额度失败后的冷却期不拦截独立KV用量入口',async()=>{
 const f=await migrated();let calls=0;f.env.ELF_DO.get=()=>({fetch(){calls++;throw Error('Exceeded allowed volume of requests in Durable Objects free tier.');}});
 assert.equal((await worker.fetch(request('/api/devices','GET',undefined,f.cookie),f.env)).status,503);
 const response=await worker.fetch(request('/api/cf-usage','GET',undefined,f.cookie),f.env);
 assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).ok,true);assert.equal(calls,1);
});

test('任务转发只鉴权一次，同时保留任务落库后的推送准备',async()=>{
 const f=await migrated([device()]),paths=[],get=f.env.ELF_DO.get;
 f.env.ELF_DO.get=id=>{const stub=get(id);return {fetch(input,init){paths.push(new URL(input instanceof Request?input.url:input).pathname);return stub.fetch(input,init);}};};
 const response=await task(f,'pull_logs',{});assert.equal(response.status,200,await response.clone().text());
 assert.equal(f.reads.filter(k=>k==='panel/auth').length,1);
 assert.equal(f.reads.filter(k=>k.startsWith('panel/revoked/')).length,1);
 assert.equal(f.data.get('remote_devices')[0].task.type,'pull_logs');
 assert.ok(paths.includes('/__push/prepare'));assert.ok(f.data.has('push/request/fixture-device'));
});

test('白名单任务转发仍拒绝跨站、未登录、已注销会话，拒绝时不入队',async()=>{
 const f=await migrated([device()]);
 assert.equal((await task(f,'pull_logs',{},'cross-site',{Origin:'https://other.test'})).status,403);
 const anonymous=await worker.fetch(request('/api/elfremote/task','POST',{device_id:'fixture-device',type:'pull_logs'}),f.env);assert.equal(anonymous.status,401);
 assert.equal((await worker.fetch(request('/api/logout','POST',{},f.cookie),f.env)).status,200);
 assert.equal((await task(f,'pull_logs',{},'after-logout')).status,401);
 assert.equal(f.data.get('remote_devices')[0].task,undefined);assert.equal(f.data.has('push/request/fixture-device'),false);
});

test('D31未读取设置快照时直接API修改未实现项目和旧Wi-Fi入口均被拒绝',async()=>{
 const f=await migrated([device('d31')]);
 const cases=[
  {group:'sound',action:'set',key:'font_scale',value:1.2},
  {group:'time',action:'set',key:'locale',value:'en-AU'},
  {group:'network',action:'set',key:'mobile_data',value:true},
  {group:'wifi',action:'set',key:'connect',value:{ssid:'fixture',password:'fixture-pass'}},
  ...['notifications','background'].map(key=>({group:'apps',action:'set',key,package:'test.app',value:true})),
  {group:'apps',action:'set',key:'permission',package:'test.app',value:{name:'android.permission.CAMERA',granted:true}}
 ];
 for(const [index,params] of cases.entries())assert.equal((await task(f,'system_config',params,'unsupported-'+index)).status,409,params.key);
 assert.equal((await task(f,'connect_wifi',{ssid:'fixture',password:'fixture-pass'})).status,409);
 assert.equal(f.data.get('remote_devices')[0].task,undefined);assert.equal(f.data.has('push/request/fixture-device'),false);
});

test('D22保留原设置及Wi-Fi下发路径，D31已经实现的设置仍可正常下发',async()=>{
 for(const [model,type,params] of [
  ['d22','system_config',{group:'sound',action:'set',key:'font_scale',value:1.2}],
  ['d22','system_config',{group:'time',action:'set',key:'locale',value:'en-AU'}],
  ['d22','connect_wifi',{ssid:'fixture',password:'fixture-pass'}],
  ['d31','system_config',{group:'sound',action:'set',key:'brightness',value:80}],
  ['d31','system_config',{group:'time',action:'set',key:'timezone',value:'Australia/Sydney'}],
  ['d31','system_config',{group:'apps',action:'set',key:'enabled',package:'test.app',value:true}],
  ['d31','system_config',{group:'network',action:'read'}]
 ]){
  const f=await migrated([device(model)]),response=await task(f,type,params);
  assert.equal(response.status,200,model+' '+type+' '+(params.key||params.action)+' '+await response.clone().text());
  assert.equal(f.data.get('remote_devices')[0].task.type,type);
 }
});

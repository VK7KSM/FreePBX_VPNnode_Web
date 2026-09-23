import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import worker from './worker.js';
import {fixture,login,request} from './test-support.mjs';
import {GATEWAY_PRODUCT} from './gateway-product.js';

test('生产显式部署配置绑定私有日志桶',()=>{
  // 同上：JSONC 允许注释，只剥行首那种。
  const config=JSON.parse(readFileSync(new URL('./wrangler.jsonc',import.meta.url),'utf8').replace(/^[ 	]*\/\/.*$/gm,''));
  assert.deepEqual(config.r2_buckets,[{binding:'ELF_ARTIFACTS',bucket_name:'elfremote-private'}]);
  assert.match(readFileSync(new URL('./.github/workflows/deploy.yml',import.meta.url),'utf8'),/command: deploy --config wrangler\.jsonc/);
});

function setup(){
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'device',enabled:true,token_sha256:createHash('sha256').update('fixture-token').digest('hex'),
    task:{id:'log-task',type:'pull_logs',state:'running',expires_at:Date.now()+60000}}]});
  const objects=new Map();let writes=0;
  f.env.ELF_ARTIFACTS={async put(key,bytes){writes++;objects.set(key,bytes);},async get(key){return objects.has(key)?{body:objects.get(key)}:null;}};
  const text='complete-fixture-log\n'.repeat(400);
  f.body={device_id:'device',token:'fixture-token',task_id:'log-task',state:'success',result:{log_text:text,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),text:'summary'}};
  f.writes=()=>writes;
  return f;
}

test('完整日志保存、校验、重试去重和历史下载都受正确认证约束',async()=>{
  const f=setup(),cookie=await login(f);
  const send=body=>worker.fetch(request('/api/elfremote/task-progress','POST',body),f.env);
  assert.equal((await send({...f.body,token:'bad'})).status,401);
  assert.equal(f.writes(),0);
  const reply=await send(f.body);assert.equal(reply.status,200);
  const data=await reply.json();assert.equal(data.task.result.artifact.bytes,f.body.result.bytes);
  assert.equal(JSON.stringify(data).includes('complete-fixture-log'),false);
  assert.equal((await send(f.body)).status,200);assert.equal(f.writes(),1);
  const path='/api/elfremote/task-log?device_id=device&task_id=log-task';
  assert.equal((await worker.fetch(request(path),f.env)).status,401);
  const download=await worker.fetch(request(path,'GET',undefined,cookie),f.env);
  assert.equal(await download.text(),f.body.result.log_text);
  assert.equal(download.headers.get('X-Content-SHA256'),f.body.result.sha256);
  const devices=f.devices();devices[0].task={id:'next'};f.data.set('remote_devices',devices);
  assert.equal((await worker.fetch(request(path,'GET',undefined,cookie),f.env)).status,200);
});

test('坏校验和存储失败不提交成功状态',async()=>{
  const f=setup();
  const send=body=>worker.fetch(request('/api/elfremote/task-progress','POST',body),f.env);
  assert.equal((await send({...f.body,result:{...f.body.result,bytes:1}})).status,400);
  assert.equal(f.writes(),0);
  f.env.ELF_ARTIFACTS.put=async()=>{throw Error('private fixture failure');};
  const response=await send(f.body);assert.equal(response.status,503);
  assert.equal((await response.text()).includes('private fixture'),false);
  assert.equal(f.devices()[0].task.state,'running');
});

test('缺少设备凭证记录时不能上传日志',async()=>{
  const f=setup();
  const devices=f.devices();delete devices[0].token_sha256;f.data.set('remote_devices',devices);
  assert.equal((await worker.fetch(request('/api/elfremote/task-progress','POST',f.body),f.env)).status,401);
  assert.equal(f.writes(),0);
});

test('状态模式仅向声明能力的客户端提供新建日志任务',async()=>{
  const f=setup(),cookie=await login(f);
  let sequence=0;
  const report=async capable => (await worker.fetch(request('/api/devices/report','POST',{
    device_id:'device',token:'fixture-token',status_only:true,managed_log_tasks:capable,
    report_id:'fixture-report-'+(++sequence),sampled_at:new Date(Date.now()+sequence*1000).toISOString()
  }),f.env)).json();
  const enqueue=type=>worker.fetch(request('/api/elfremote/task','POST',{device_id:'device',type},cookie),f.env);
  assert.equal((await report(true)).managed_task,undefined);
  const devices=f.devices();devices[0].task.state='success';f.data.set('remote_devices',devices);
  assert.equal((await enqueue('reboot')).status,409);
  assert.equal((await enqueue('pull_logs')).status,200);
  const offered=await report(true);
  assert.equal(offered.managed_task.type,'pull_logs');
  assert.equal(offered.managed_task.managed_log_v1,true);
  assert.equal(offered.task,undefined);assert.equal(offered.update,undefined);
  const repeated=await (await worker.fetch(request('/api/devices/report','POST',{
    device_id:'device',token:'fixture-token',status_only:true,managed_log_tasks:true,report_id:'fixture-report-'+sequence
  }),f.env)).json();
  assert.equal(repeated.duplicate,true);
  assert.equal(repeated.managed_task.id,offered.managed_task.id);
  assert.equal((await report(false)).managed_task,undefined);
  assert.equal((await enqueue('pull_logs')).status,409);
});

test('新自愈能力不影响旧客户端且停用设备不能领取',async()=>{
  const f=setup(),cookie=await login(f);
  const devices=f.devices();devices[0].status_only=true;devices[0].task.state='success';f.data.set('remote_devices',devices);
  const enqueue=()=>worker.fetch(request('/api/elfremote/task','POST',{device_id:'device',type:'heal_network'},cookie),f.env);
  assert.equal((await enqueue()).status,409);
  let sequence=0;
  const report=async capable => (await worker.fetch(request('/api/devices/report','POST',{
    device_id:'device',token:'fixture-token',status_only:true,managed_heal_tasks:capable,
    report_id:'heal-report-'+(++sequence),sampled_at:new Date(Date.now()+sequence*1000).toISOString()
  }),f.env)).json();
  await report(true);
  assert.equal((await enqueue()).status,200);
  assert.equal((await report(false)).managed_task,undefined);
  assert.equal((await report(true)).managed_task.managed_heal_v1,true);
  const disabled=f.devices();disabled[0].enabled=false;f.data.set('remote_devices',disabled);
  assert.equal((await report(true)).managed_task,undefined);
});

// connect_wifi 不在下面这张通用能力表里：主线「添加Pixel Gateway独立Wi-Fi任务合同」之后，
// 它的下发分成网关与非网关两条路径，判定条件完全不同，通用夹具覆盖不到。下面两条专门覆盖它。

function wifiParams(){return {ssid:'fixture',password:'fixture-pass'};}

test('connect_wifi 非网关路径：要通用配置能力，且系统设置的 wifi/connect 被判不可用时不下发',async()=>{
  const f=setup(),cookie=await login(f);
  const devices=f.devices();devices[0].status_only=true;devices[0].task.state='success';f.data.set('remote_devices',devices);
  const enqueue=()=>worker.fetch(request('/api/elfremote/task','POST',{device_id:'device',type:'connect_wifi',params:wifiParams()},cookie),f.env);
  const freeTask=()=>{const rows=f.devices();rows[0].task.state='success';f.data.set('remote_devices',rows);};
  let sequence=0;
  const report=async body=>(await worker.fetch(request('/api/devices/report','POST',{
    device_id:'device',token:'fixture-token',status_only:true,
    report_id:'wifi-report-'+(++sequence),sampled_at:new Date(Date.now()+sequence*1000).toISOString(),...body
  }),f.env));

  const bare=await enqueue();
  assert.equal(bare.status,409);
  assert.equal((await bare.json()).msg,'当前客户端尚未接通该任务');

  await report({managed_config_tasks:true});
  assert.equal((await enqueue()).status,200,'声明通用配置能力后即可下发');

  // 设备自报 wifi 分组里 connect 不可用时，必须拦在下发之前，且理由要和缺能力区分开。
  freeTask();
  const blocked=f.devices();
  blocked[0].system_settings={wifi:{unavailable:['connect']}};
  f.data.set('remote_devices',blocked);
  const refused=await enqueue();
  assert.equal(refused.status,409);
  assert.equal((await refused.json()).msg,'设备网络修改尚未接通，未下发修改');

  // 专用 Wi-Fi 能力位只属于网关产品，非网关上报它要被直接拒绝，不能靠它绕过上面的判定。
  assert.equal((await report({managed_config_tasks:true,managed_wifi_config_tasks:true})).status,400);
});

test('connect_wifi 网关路径：认专用能力位，且不受系统设置 wifi/connect 判定影响',async()=>{
  const f=setup(),cookie=await login(f);
  const devices=f.devices();
  // 产品身份的四个字段缺一不可，服务端会逐项比对；直接引常量，免得证书指纹变了测试还钉着旧值。
  Object.assign(devices[0],{status_only:true,product_id:GATEWAY_PRODUCT.product_id,app_package:GATEWAY_PRODUCT.app_package,
    model_id:GATEWAY_PRODUCT.model_id,app_cert_sha256:GATEWAY_PRODUCT.certSha256,app_abi:GATEWAY_PRODUCT.abi});
  devices[0].task.state='success';
  // 故意把 wifi/connect 标成不可用：网关走的是另一条判定，这一格不该影响它。
  devices[0].system_settings={wifi:{unavailable:['connect']}};
  f.data.set('remote_devices',devices);
  const enqueue=()=>worker.fetch(request('/api/elfremote/task','POST',{device_id:'device',type:'connect_wifi',params:wifiParams()},cookie),f.env);
  let sequence=0;
  const report=async capable=>(await worker.fetch(request('/api/devices/report','POST',{
    device_id:'device',token:'fixture-token',status_only:true,managed_wifi_config_tasks:capable,
    report_id:'gw-wifi-report-'+(++sequence),sampled_at:new Date(Date.now()+sequence*1000).toISOString()
  }),f.env)).json();

  const bare=await enqueue();
  assert.equal(bare.status,409);
  assert.equal((await bare.json()).msg,'当前客户端尚未接通该任务');

  await report(true);
  assert.equal((await enqueue()).status,200,'网关声明专用 Wi-Fi 能力后即可下发，不看系统设置那一格');
  assert.equal((await report(true)).managed_task.managed_wifi_config_v1,true);
  assert.equal((await report(false)).managed_task,undefined,'撤回能力位后不再派发');
});

for (const [type, capability, marker] of [['reboot','managed_reboot_tasks','managed_reboot_v1'],['restart_adbd','managed_adbd_tasks','managed_adbd_v1'],['scan_wifi','managed_wifi_scan_tasks','managed_wifi_scan_v1'],['play_alarm','managed_alarm_tasks','managed_alarm_v1'],['stop_alarm','managed_alarm_tasks','managed_alarm_v1'],['locate_now','managed_locate_tasks','managed_locate_v1'],['set_lost_mode','managed_lost_tasks','managed_lost_v1'],...['contacts_read','contact_add','contact_update','contact_delete'].map(type=>[type,'managed_config_tasks','managed_config_v1'])]) {
test(type+' 只提供给明确声明能力的客户端且过期后不再提供',async()=>{
  const f=setup(),cookie=await login(f);
  const devices=f.devices();devices[0].status_only=true;devices[0].task.state='success';f.data.set('remote_devices',devices);
  const enqueue=()=>worker.fetch(request('/api/elfremote/task','POST',{device_id:'device',type,params:{ssid:'fixture',password:'fixture-pass',id:1,name:'测试',phone:'000',enabled:true,message:'测试'}},cookie),f.env);
  assert.equal((await enqueue()).status,409);
  let sequence=0;
  const report=async capable => (await worker.fetch(request('/api/devices/report','POST',{
    device_id:'device',token:'fixture-token',status_only:true,[capability]:capable,
    report_id:'reboot-report-'+(++sequence),sampled_at:new Date(Date.now()+sequence*1000).toISOString()
  }),f.env)).json();
  await report(true); assert.equal((await enqueue()).status,200);
  assert.equal((await report(false)).managed_task,undefined);
  assert.equal((await report(true)).managed_task[marker],true);
  const expired=f.devices();expired[0].task.expires_at=1;f.data.set('remote_devices',expired);
  assert.equal((await report(true)).managed_task,undefined);
  assert.equal(f.devices()[0].task.state,'expired');
});
}

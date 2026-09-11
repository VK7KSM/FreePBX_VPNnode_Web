import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import source from './devices-client-source.js';
import {fixture,request,login} from './test-support.mjs';
import {applySystemSettingsResult} from './system-settings.js';

const caps={pull_logs:'managed_log_tasks',heal_network:'managed_heal_tasks',reboot:'managed_reboot_tasks',restart_adbd:'managed_adbd_tasks'};
function browser(){const ctx=vm.createContext({Date,adminSession:{check(){}},setTimeout(){},setInterval(){}});vm.runInContext(source,ctx);return ctx;}
test('D31与D22报告的维护能力完整传到列表和按钮，假值、缺失及非布尔不误开',async()=>{
  const f=fixture(),cookie=await login(f),token='fixture-token',ctx=browser();
  for(const model of ['mdl_d31','mdl_d22'])for(const flag of [true,false,undefined,'true']){
    const d={id:'device',paired:true,model_id:model,token_sha256:createHash('sha256').update(token).digest('hex')};
    f.data.set('remote_devices',[d]);
    const body={device_id:d.id,token,status_only:true,report_id:crypto.randomUUID(),reported_at:new Date().toISOString(),network:'ethernet'};
    for(const cap of Object.values(caps))if(flag!==undefined)body[cap]=flag;
    assert.equal((await worker.fetch(request('/api/devices/report','POST',body),f.env)).status,200);
    const visible=(await (await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).json()).devices[0];
    assert.equal(visible.status_only,true);
    for(const [type,cap] of Object.entries(caps)){assert.equal(visible[cap],flag===true);assert.equal(ctx.maintenanceAvailable(visible,type),flag===true);}
  }
});
test('D31仅声明重启adbd时仅该维护按钮可用，任务占用与结束保持现有规则',async()=>{
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id:'device',model_id:'mdl_d31',paired:true,status_only:true,managed_adbd_tasks:true}]}),cookie=await login(f),ctx=browser();
  const list=async()=>{const d=(await (await worker.fetch(request('/api/devices','GET',undefined,cookie),f.env)).json()).devices[0];ctx.DEV=[d];ctx.selDev=d.id;return d;};
  let d=await list();assert.equal(ctx.maintenanceAvailable(d,'restart_adbd'),true);
  for(const type of ['pull_logs','heal_network','reboot']){
    assert.equal(ctx.maintenanceAvailable(d,type),false);
    assert.equal((await worker.fetch(request('/api/elfremote/task','POST',{device_id:d.id,type,id:'denied-'+type},cookie),f.env)).status,409);
  }
  assert.match(ctx.pageAdb(''),/class="btn-green" onclick="enqueueRepair\('restart_adbd'\)"/);
  assert.equal((await worker.fetch(request('/api/elfremote/task','POST',{device_id:d.id,type:'restart_adbd',id:'restart-test'},cookie),f.env)).status,200);
  d=await list();assert.equal(ctx.maintenanceAvailable(d,'restart_adbd'),false);
  const stored=f.data.get('remote_devices');stored[0].task.state='success';stored[0].task.detail='已完成';f.data.set('remote_devices',stored);
  d=await list();assert.equal(ctx.maintenanceAvailable(d,'restart_adbd'),true);
  // 老式非status_only客户端维持原有任务协议。
  assert.equal(ctx.maintenanceAvailable({enabled:true,status_only:false},'restart_adbd'),true);
});
test('后台设置能力随真实配置回执保留，明确不支持时无开关，旧D22快照兼容',()=>{
  const ctx=browser();
  for(const flag of [false,true,undefined]){
    const snapshot={group:'apps',package:'test.app',name:'测试应用',sampled_at:1000,background:true,notifications:true,enabled:true,permissions:[],...(flag===undefined?{}:{background_supported:flag})};
    const d={id:'device',managed_system_settings:true,task:{state:'running',params:{group:'apps',action:'read'}}};
    applySystemSettingsResult(d,{exit_code:0,action:'completed',text:JSON.stringify(snapshot)},1001);
    assert.equal(d.system_settings.apps.background_supported,flag);ctx.DEV=[d];ctx.selDev=d.id;ctx.SYSTEM_TAB='应用';
    const html=ctx.pageSystemSettings('');
    if(flag===false){assert.match(html,/此系统不支持单独设置/);assert.doesNotMatch(html,/id="setting-background"/);}
    else assert.match(html,/id="setting-background"/);
    assert.match(html,/id="setting-notifications"/);assert.match(html,/id="setting-enabled"/);
  }
});

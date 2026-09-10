import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import worker from './worker.js';
import {fixture,request,login} from './test-support.mjs';

test('无电池报告、充电电池、未知状态和型号覆盖分别展示，非法状态拒绝',async()=>{
  const f=fixture(),cookie=await login(f),token='power-fixture';
  const call=(path,body,auth)=>worker.fetch(request(path,body?'POST':'GET',body ?? undefined,auth),f.env);
  const e=await (await call('/api/devices/enroll',{token,token_sha256:createHash('sha256').update(token).digest('hex'),model_hint:'Pixel 3'})).json();
  const report=extra=>call('/api/devices/report',{device_id:e.device_id,token,status_only:true,network:'wifi',...extra});
  const device=async()=>(await (await call('/api/devices',null,cookie)).json()).devices.find(d=>d.id===e.device_id);
  await report({battery:100,charging:true});
  assert.equal((await device()).battery_present,null);assert.equal((await device()).charging,true);
  await report({battery_present:false,battery:0});
  let d=await device();assert.equal(d.battery_present,false);assert.equal(d.battery,null);assert.equal(d.charging,false);
  await report({battery_present:true,battery:82,charging:true});
  d=await device();assert.equal(d.battery_present,true);assert.equal(d.battery,82);assert.equal(d.charging,true);
  assert.equal((await report({battery_present:'false'})).status,400);
  assert.equal((await device()).battery_present,true);
  await report({battery_present:null});assert.equal((await device()).battery_present,null);
  assert.equal((await call('/api/device-models',{id:'mdl_pixel3',name:'Pixel 3',power_type:'external'},cookie)).status,200);
  await report({battery_present:true,battery:100,charging:true});
  assert.equal((await device()).battery_present,false);
  assert.equal((await call('/api/device-models',{id:'mdl_pixel3',name:'Pixel 3',power_type:'bad'},cookie)).status,400);
});

test('旧D31型号兼容外接电源，管理员可修改，改名不丢失供电设置',async()=>{
  const f=fixture({admin_pass:'fixture-password',remote_device_models:[{id:'mdl_d31',name:'D31'}]}),cookie=await login(f);
  const call=(path,body)=>worker.fetch(request(path,body?'POST':'GET',body ?? undefined,cookie),f.env);
  let m=(await (await call('/api/device-models')).json()).models[0];assert.equal(m.power_type,'external');
  m=(await (await call('/api/device-models',{id:m.id,name:'桌面设备'})).json()).model;
  assert.equal(m.power_type,'external');assert.equal(m.registration_key,'d31');
  m=(await (await call('/api/device-models',{id:m.id,name:m.name,power_type:'auto'})).json()).model;assert.equal(m.power_type,'auto');
});

test('地图插头和电池闪电互斥，未知电量不伪装外接电源',()=>{
  const src=fs.readFileSync(new URL('./devices-client.js',import.meta.url),'utf8');
  const c=vm.createContext({});vm.runInContext(src.slice(src.indexOf('function batteryText('),src.indexOf('function pinHtml(')),c);
  assert.equal(c.batteryText({battery_present:false,battery:0,charging:true}),'外接电源');
  const plug=c.battHtml(0,true,false);assert.match(plug,/外接电源/);assert.doesNotMatch(plug,/mbatt-bolt|mbatt-l/);
  assert.match(c.battHtml(82,true,true),/mbatt-bolt/);assert.match(c.battHtml(null,false,null),/电量未知/);
});

import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import worker from './worker.js';import {fixture,request} from './test-support.mjs';

// 设备自助分享：二维码文本是整条链接的大写形式（二维码字母数字模式不收小写），
// 所以扫出来的路径是 /M/<TOKEN>，单设备管理页必须照样能打开，不能 404。
test('设备自助分享链接：二维码文本全大写，扫出来的大写路径同样打开单设备管理页',async()=>{
  const token='synthetic-share-token',id='synthetic-share-device';
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id,model_id:'mdl_d31',paired:true,enabled:true,
    token_sha256:createHash('sha256').update(token).digest('hex')}]});
  const created=await worker.fetch(request('/api/devices/share-link','POST',{device_id:id,token,request_id:'r1'}),f.env);
  assert.equal(created.status,200);
  const body=await created.json();
  assert.equal(body.ok,true);
  assert.equal(body.qr_text,body.url.toUpperCase(),'二维码文本是整条链接的大写');
  assert.match(body.token,/^[A-Z0-9]{12}$/);

  const lower=new URL(body.url).pathname,upper=new URL(body.qr_text).pathname;
  assert.notEqual(lower,upper,'大小写路径确实不同，这正是要覆盖的情形');
  for(const pathname of [lower,upper]){
    const page=await worker.fetch(request(pathname),f.env);
    assert.equal(page.status,200,'路径 '+pathname+' 应当渲染单设备管理页');
    assert.match(await page.text(),new RegExp('<meta name="elf-share" content="'+body.token+'"'),
      '路径 '+pathname+' 应当带上该链接的分享上下文');
  }

  const repeated=await worker.fetch(request('/api/devices/share-link','POST',{device_id:id,token,request_id:'r1'}),f.env);
  assert.equal((await repeated.json()).token,body.token,'同一请求编号重试不应再开一条链接');
});

// 单设备管理页是发给设备使用者的，顶部导航必须整条拿掉，换成设备名。
// 这层靠一条正则在 renderDevicesHtml() 的产物上做替换，导航一改样式就可能悄悄失配——
// 2026-09-20 把「代理节点」的 href 改成 s.elfradio.net 时就正是这样断了一次。
test('单设备分享页不保留任何通往总后台的导航入口',async()=>{
  const token='synthetic-nav-token',id='synthetic-nav-device';
  const f=fixture({admin_pass:'fixture-password',remote_devices:[{id,model_id:'mdl_d31',paired:true,enabled:true,
    token_sha256:createHash('sha256').update(token).digest('hex')}]});
  const created=await worker.fetch(request('/api/devices/share-link','POST',{device_id:id,token,request_id:'nav'}),f.env);
  const body=await created.json();
  const html=await (await worker.fetch(request(new URL(body.url).pathname),f.env)).text();
  assert.match(html,/id="shareDeviceName"/,'导航应当被替换成设备名');
  for(const entry of ['代理节点','电话管理','>设备管理<','s.elfradio.net'])
    assert.equal(html.includes(entry),false,'分享页不该出现总后台入口：'+entry);
});

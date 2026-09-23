import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';
import {build} from 'esbuild';
import {proxyRoleBlocked, PROXY_ROLE_PATHS} from './worker.js';
import {buildAssets} from './build-static-assets.mjs';
import {buildProxyAssets} from './build-proxy-assets.mjs';

// 代理面板单独部署在 s.elfradio.net。订阅接口天然要对全网开放，而设备管理与 SIP 管理
// 是纯后台，不该跟着暴露在同一个公开 Worker 上——两次封禁都是公开面被刷导致的。
test('proxy 角色只放行代理面板与订阅，其余一律挡掉', () => {
  const proxy = {PANEL_ROLE: 'proxy'};
  for (const allowed of ['/', '/index.html', '/logo.png', '/admin-session.js', '/cf-usage.js',
      '/panel-lifecycle.js', '/api/login', '/api/logout', '/api/session', '/api/data', '/api/save', '/api/cf-usage'])
    assert.equal(proxyRoleBlocked(proxy, allowed), false, allowed + ' 是代理面板自己要用的，不能挡');
  for (const sub of ['/sub', '/sub/', '/sub/abc123', '/sub?token=x'])
    assert.equal(proxyRoleBlocked(proxy, sub), false, sub + ' 是订阅接口，必须放行');
  for (const blocked of ['/devices', '/sip', '/api/devices', '/api/sip', '/api/elfremote/task',
      '/desktop-client.js', '/devices-client.js', '/m/ABCDEFGH1234', '/api/elfremote/releases/upload'])
    assert.equal(proxyRoleBlocked(proxy, blocked), true, blocked + ' 属于管理面板，不能出现在代理 Worker 上');
});

test('未设角色或 manage 角色时闸门完全不生效', () => {
  for (const env of [undefined, null, {}, {PANEL_ROLE: 'manage'}, {PANEL_ROLE: ''}])
    for (const p of ['/devices', '/api/devices', '/sub/x', '/'])
      assert.equal(proxyRoleBlocked(env, p), false, JSON.stringify(env) + ' 不应挡 ' + p);
  // 放行名单必须真的改不动。注意不能用 Set：Object.freeze 冻不住 Set 的内容，
  // add() 照样成功，那是一层看着有、实际没有的防护。
  assert.throws(() => PROXY_ROLE_PATHS.push('/api/devices'), TypeError);
  assert.equal(PROXY_ROLE_PATHS.includes('/api/devices'), false);
});

// 用户要求 v.elfradio.net 这个 Worker 里不出现任何代理协议字段。
// 靠 PANEL_ROLE 在运行时分流做不到这一点：代码仍然整份打在包里，看得见也搜得到。
// 真正的保证是打包产物本身，所以这里直接编译两个入口，比对里面有没有这些词。
const PROXY_TERMS = /vless|v2ray|vmess|mihomo|clash|trojan|shadowsocks|shadowrocket|nekobox|xray/i;

test('管理面板的打包产物里没有任何代理协议字段，代理面板的产物里有', async () => {
  const bundleOf = async entry => (await build({
    entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'neutral',
    external: ['cloudflare:*'], logLevel: 'silent',
  })).outputFiles[0].text;

  const manage = await bundleOf('worker.js');
  const hit = manage.match(PROXY_TERMS);
  assert.equal(hit, null, '管理面板产物里出现了代理协议字段：' + (hit && hit[0]));

  // 反过来验一遍，否则上面那条断言在代理面板被误删时也会「通过」。
  assert.match(await bundleOf('worker-proxy.js'), PROXY_TERMS);
});

test('代理面板的静态资源只带自己那几个文件，管理面板的页面根本不在上面', async () => {
  await buildAssets();
  const copied = await buildProxyAssets();
  assert.ok(copied.includes('index.html'), '代理面板首页必须静态托管');
  for (const forbidden of ['devices.html', 'sip.html', 'devices-client.js', 'desktop-client.js', 'terminal.js'])
    assert.equal(copied.includes(forbidden), false, forbidden + ' 属于管理面板，不能出现在代理 Worker 上');
  const index = fs.readFileSync(new URL('./.generated-assets-proxy/index.html', import.meta.url), 'utf8');
  assert.match(index, /<title>elfRemote Manager<\/title>/);
  assert.equal(index.includes('__ELF_PANEL_VERSION__'), false, '面板版本号必须替换掉');
  for (const match of index.matchAll(/(?:src|href)="(\/[^"#?]+\.(?:js|css|png))"/g))
    assert.ok(copied.includes(match[1].slice(1)), '本地资源必须随代理面板一起发布 ' + match[1]);
});

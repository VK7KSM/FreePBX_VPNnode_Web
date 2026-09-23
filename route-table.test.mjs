import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ROUTES,routeFor,isMachineRoute,DEVICE_ROUTES,unknownDeviceRoute,DEVICE_ID_QUERY,DEVICE_ID_BODY,DEVICE_ID_BODY_ID,
  SHARE_FORBIDDEN,SHARE_GLOBAL_READ,OBSERVER_ALLOWED,PROXY_ROLE_PATHS,singleStoreRead,storeAuthenticates,KV_INDEPENDENT,outerDeviceRoute} from './route-table.js';
import {PROXY_ROLE_PATHS as fromWorker} from './worker.js';
import {isMachineRoute as fromAuth,DEVICE_ROUTES as authRoutes} from './admin-auth.js';

// ── 一、并表不改行为：派生结果必须与并表前七份手工名单逐条相等 ──
// 这些字面量是 2026-09-23 并表当天从 admin-auth.js / share-scope.js / worker.js 原样抄来的快照。
// 以后改路由只改 route-table.js，这里的快照跟着改；改快照的提交就是「有意改行为」的证据。
const same=(actual,expected,label)=>assert.deepEqual([...actual].sort(),[...expected].sort(),label);
test('isMachineRoute：22 条精确 + 2 条正则（2026-09-23 删去已废弃的 sip/heartbeat）', () => {
  const old=["GET /api/sip/pull","POST /api/devices/enroll","GET /api/devices/enroll-status","POST /api/devices/report",
    "POST /api/devices/push-config","POST /api/devices/push-sync","POST /api/devices/share-link","POST /api/devices/proxy-config/offer",
    "POST /api/devices/media-native/offer","POST /api/mcp","DELETE /api/mcp","POST /api/elfremote/update-progress","POST /api/elfremote/task-progress",
    "GET /api/elfremote/file-download","POST /api/elfremote/report-photo","POST /api/elfremote/file-return","PUT /api/elfremote/file-return",
    "GET /api/elfremote/adb/device","GET /api/elfremote/media/device","GET /api/elfremote/desktop/device","GET /api/elfremote/adb-tunnel/host","GET /api/elfremote/adb-tunnel/device"];
  const now=ROUTES.filter(r=>!r.pattern&&(r.who==='device'||r.who==='agent')).map(r=>r.method+' '+r.path);
  same(now,old,'机器路由');
  for(const entry of old){const [m,p]=entry.split(' ');assert.equal(isMachineRoute(p,m),true,entry);assert.equal(isMachineRoute(p,m==='GET'?'POST':'GET'),false,entry+' 换方法不放行');}
  assert.equal(isMachineRoute('/api/elfremote/apk/test-job','GET'),true);
  assert.equal(isMachineRoute('/api/elfremote/apk/test-job/extra','GET'),false);
  assert.equal(isMachineRoute('/api/elfremote/proxy-config/t1-abc','GET'),true);
  assert.equal(isMachineRoute('/api/elfremote/proxy-config/t1-abc','POST'),false);
  assert.equal(isMachineRoute('/api/elfremote/proxy-config/'+'x'.repeat(97),'GET'),false,'超长编号不匹配');
  assert.equal(isMachineRoute('/api/devices/report','GET'),false);
  assert.equal(fromAuth,isMachineRoute,'admin-auth.js 转口的是同一个函数');
});
test('DEVICE_ROUTES：20 条 /api/devices 路径', () => {
  same(DEVICE_ROUTES,["/api/devices","/api/devices/delete","/api/devices/enroll","/api/devices/enroll-status","/api/devices/events","/api/devices/history",
    "/api/devices/media-native/offer","/api/devices/pair","/api/devices/proxy-config/offer","/api/devices/push-config","/api/devices/push-sync",
    "/api/devices/recovery","/api/devices/report","/api/devices/request-status","/api/devices/share-link","/api/devices/sip-directory",
    "/api/devices/status-request","/api/devices/traffic","/api/devices/trajectory-media","/api/devices/update"]);
  assert.equal(authRoutes,DEVICE_ROUTES);
  assert.equal(unknownDeviceRoute('/api/devices/does-not-exist'),true);
  assert.equal(unknownDeviceRoute('/api/devices/update'),false);
});
test('独立页五张表与 share-scope.js 并表前一致', () => {
  same(DEVICE_ID_QUERY,['/api/devices/status-request','/api/devices/traffic','/api/devices/history','/api/devices/trajectory-media','/api/elfremote/tasks',
    '/api/elfremote/mcp-tokens','/api/elfremote/task-log','/api/elfremote/file-return','/api/elfremote/file-return/received','/api/elfremote/report-photo',
    '/api/elfremote/media-recordings','/api/elfremote/files','/api/elfremote/media/session','/api/elfremote/adb/session','/api/elfremote/adb-tunnel/session',
    '/api/elfremote/desktop/session','/api/share/links'],'query');
  same(DEVICE_ID_BODY,['/api/devices/request-status','/api/elfremote/task','/api/elfremote/mcp-tokens','/api/elfremote/mcp-tokens/delete','/api/elfremote/mcp-tokens/release',
    '/api/elfremote/assign','/api/elfremote/media/session','/api/elfremote/adb/session','/api/elfremote/adb-tunnel/session','/api/elfremote/desktop/session',
    '/api/elfremote/files','/api/elfremote/file-return','/api/share/links','/api/share/links/update','/api/share/links/delete'],'body');
  same(DEVICE_ID_BODY_ID,['/api/devices/update','/api/devices/delete'],'body_id');
  // 旧表里有一条 ['POST','/api/sip']——服务端从来没有这条路由，死条目不再保留。
  same(SHARE_FORBIDDEN.map(x=>x.join(' ')),['POST /api/devices','POST /api/device-models','POST /api/devices/delete','POST /api/devices/pair','GET /api/devices/recovery',
    'GET /api/devices/sip-directory','POST /api/elfremote/releases','POST /api/elfremote/releases/prune','PUT /api/elfremote/releases/upload','POST /api/elfremote/proxy-config',
    'GET /api/cf-usage','GET /api/admin/legacy-store','GET /api/admin/store-size','GET /api/admin/health','POST /api/admin/legacy-store','POST /api/admin/prepare-kv',
    'POST /api/sip/ban','POST /api/sip/save','POST /api/save'],'forbidden');
  same(SHARE_GLOBAL_READ,['/api/devices','/api/device-models','/api/elfremote/releases','/api/devices/events','/api/share/session','/api/share/logout','/api/share/login','/api/session','/api/logout'],'global');
  same(OBSERVER_ALLOWED.map(x=>x.join(' ')),['POST /api/devices/update','POST /api/devices/delete','POST /api/devices/pair','POST /api/devices','POST /api/device-models',
    'POST /api/share/links','POST /api/share/links/update','POST /api/share/links/delete','POST /api/elfremote/releases','POST /api/elfremote/releases/prune',
    'PUT /api/elfremote/releases/upload','POST /api/elfremote/proxy-config'],'observer');
});
test('外层分流三张表与 worker.js 并表前一致', () => {
  const reads=['/api/devices/events','/api/devices','/api/device-models','/api/devices/traffic','/api/devices/history','/api/devices/status-request','/api/elfremote/tasks','/api/elfremote/releases','/api/admin/store-size','/api/admin/health'];
  same(ROUTES.filter(r=>r.store==='read').map(r=>r.path),reads,'singleStoreRead');
  for(const p of reads){assert.equal(singleStoreRead(p,'GET'),true,p);assert.equal(singleStoreRead(p,'POST'),false,p);}
  for(const p of ['/api/elfremote/task','/api/elfremote/assign','/api/devices','/api/devices/pair','/api/device-models','/api/share/login'])assert.equal(storeAuthenticates(p,'POST'),true,p);
  assert.equal(storeAuthenticates('/api/share/session','GET'),true);
  assert.equal(storeAuthenticates('/api/devices','GET'),false);
  same(KV_INDEPENDENT,['/api/login','/api/logout','/api/session','/api/data','/api/save','/api/sip','/api/sip/live','/api/sip/save','/api/sip/pull','/api/cf-usage']);
  for(const p of ['/api/elfremote/files','/api/elfremote/files/x/y','/api/elfremote/file-return','/api/elfremote/file-return/received','/api/elfremote/proxy-config'])assert.equal(outerDeviceRoute(p),true,p);
  assert.equal(outerDeviceRoute('/api/elfremote/task'),false);
});
test('PROXY_ROLE_PATHS 顺序与内容不变，且 worker.js 转口的是同一份冻结数组', () => {
  assert.deepEqual([...PROXY_ROLE_PATHS],['/','/index.html','/favicon.ico','/logo.png','/admin-session.js','/cf-usage.js','/panel-lifecycle.js',
    '/api/login','/api/logout','/api/session','/api/data','/api/save','/api/cf-usage']);
  assert.equal(fromWorker,PROXY_ROLE_PATHS);
  assert.throws(()=>PROXY_ROLE_PATHS.push('/api/devices'),TypeError);
});

// ── 二、表与代码互相覆盖：漏一条的后果是那条接口安静地变成 404 或「请先登录」 ──
const dir=new URL('./',import.meta.url);
const serverFiles=()=>[...fs.readdirSync(dir).filter(f=>f.endsWith('.js')&&!f.includes('client')&&f!=='admin-session.js'),
  ...fs.readdirSync(new URL('./elfRemote/',dir)).filter(f=>f.endsWith('.js')).map(f=>'elfRemote/'+f)];
function literals(){
  const found=new Map();
  for(const file of serverFiles())
    for(const m of fs.readFileSync(new URL(file,dir),'utf8').matchAll(/['"`](\/api\/[a-z][A-Za-z0-9/_-]*)['"`]/g)){
      // 以斜杠结尾的是 startsWith 用的前缀（'/api/share/'、'/api/elfremote/'），不是路由
      if(m[1].endsWith('/'))continue;
      const p=m[1];
      if(!found.has(p))found.set(p,file);
    }
  return found;
}
const known=(p)=>ROUTES.some(r=>r.pattern?(r.pattern.test(p)||p===r.alias||(r.alias&&p.startsWith(r.alias+'/'))||r.pattern.test(p+'/x')):r.path===p);
test('服务端每一处 /api 字面量都在路由表里', () => {
  const found=literals();
  assert.ok(found.size>=75,'没扫到路由，正则要跟着改：'+found.size);
  const missing=[...found].filter(([p])=>!known(p)).map(([p,f])=>p+'（'+f+'）');
  assert.deepEqual(missing,[],'这些路径出现在服务端代码里却不在表里');
});
test('路由表每一条都在服务端代码里，没有死条目', () => {
  const source=serverFiles().map(f=>fs.readFileSync(new URL(f,dir),'utf8')).join('\n');
  for(const r of ROUTES){
    const needle=r.pattern?r.path.replace(/\/:[a-z]+$/,'/'):r.path;
    assert.ok(source.includes("'"+needle)||source.includes('"'+needle)||source.includes('`'+needle)||source.includes(needle+"'")||source.includes(needle+'"'),
      r.method+' '+r.path+' 在代码里找不到');
  }
});
test('表本身自洽：机器路由不带独立页属性，方法+路径不重复，正则路由都有别名或独立方法', () => {
  const seen=new Set();
  for(const r of ROUTES){
    const key=r.method+' '+r.path;assert.ok(!seen.has(key),'重复：'+key);seen.add(key);
    assert.ok(['GET','POST','PUT','DELETE'].includes(r.method),key);
    if(r.who==='device'||r.who==='agent'){assert.equal(r.id,undefined,key+' 机器路由没有设备范围');assert.equal(r.share,undefined,key);assert.equal(r.observer,undefined,key);}
    if(r.who==='public')assert.notEqual(r.share,'forbidden',key+' 公开路由不能对独立页禁止');
    if(r.store==='read')assert.equal(r.method,'GET',key);
    assert.ok(Object.isFrozen(r));
  }
  assert.equal(routeFor('/api/elfremote/apk/j1','GET').who,'device');
  assert.equal(routeFor('/api/elfremote/files/dev/x','GET').alias,'/api/elfremote/files');
  assert.equal(routeFor('/api/nope','GET'),undefined);
});

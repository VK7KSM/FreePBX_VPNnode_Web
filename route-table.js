// 路由表：整站 /api 路径的唯一清单。谁能访问、设备编号在哪、独立页与旁观规则、
// 哪些直读存储、哪些不依赖 DO、哪些暴露在代理面板——以前散在七份手工名单里
// （isMachineRoute、DEVICE_ROUTES、share-scope 的五张表、PROXY_ROLE_PATHS、
// singleStoreRead、storeAuthenticates、KV 独立路由），9 月 21 日「历史媒体：接口不存在」
// 就是名单没对上。现在只改这一处，其余全部派生；route-table.test.mjs 盯住
// 「服务端每一处 /api 字面量都在表里」与「表里每一条都在服务端代码里」。
//
// 字段：
//   who      'device' 设备令牌 / 'agent' MCP Bearer / 'public' 无需登录 / 'admin' 管理员会话（独立页按 share 规则）
//   id       设备编号在哪：'query' | 'body'（device_id）| 'body_id'（id 字段）；数组表示多处都认
//   share    独立页：'forbidden' 一律拒绝 / 'global' 无设备范围也放行 / 缺省 = 有编号须等于本设备
//   observer 独立用户在线时总后台仍允许的动作
//   store    'read' 高频只读，外层直接经 DO 一次完成鉴权与读取 / 'auth' 由 DO 自行鉴权的 POST
//   kv       KV 权威模式下不依赖 DO 的路由（额度冷却期内照常应答）
//   proxy    暴露在 s.elfradio.net 代理面板角色上
//   pattern  正则路由（带参数的路径），alias 为范围裁决时折算到的表内路径
//   outer    外层 Worker 自己处理、不落 DO 事务的设备范围路由：改动前要先取旁观锁自行裁决
const r=(method,path,attrs={})=>Object.freeze({method,path,who:'admin',...attrs});

export const ROUTES=Object.freeze([
  // ── 登录与会话：两个面板共用，不依赖 DO ──
  r('POST','/api/login',{who:'public',kv:true,proxy:true}),
  r('POST','/api/logout',{who:'public',share:'global',kv:true,proxy:true}),
  r('GET','/api/session',{who:'public',share:'global',kv:true,proxy:true}),
  // ── 代理面板：s.elfradio.net 只放行这几条 ──
  r('GET','/api/data',{kv:true,proxy:true}),
  r('POST','/api/save',{share:'forbidden',kv:true,proxy:true}),
  r('GET','/api/cf-usage',{share:'forbidden',kv:true,proxy:true}),
  // ── 电话管理 ──
  r('GET','/api/sip',{kv:true}),
  r('GET','/api/sip/live',{kv:true}),
  r('POST','/api/sip/save',{share:'forbidden',kv:true}),
  r('POST','/api/sip/ban',{share:'forbidden'}),
  r('GET','/api/sip/pull',{who:'device',kv:true}),
  // 已废弃：自 2026-09-02 18:37（悉尼）起无调用方（大阪 sip-heartbeat.timer 停用），处理函数本来就不写任何状态。
  // 待 SIP-dev 清掉 sip-server/ 里的发送端后删除。注意：同一个 X-Heartbeat-Token 仍是 /api/sip/pull 的凭据，不得吊销。
  r('POST','/api/sip/heartbeat',{who:'device'}),
  // ── 设备列表与型号 ──
  r('GET','/api/devices',{share:'global',store:'read'}),
  r('POST','/api/devices',{share:'forbidden',observer:true,store:'auth'}),
  r('GET','/api/device-models',{share:'global',store:'read'}),
  r('POST','/api/device-models',{share:'forbidden',observer:true,store:'auth'}),
  r('POST','/api/devices/update',{id:'body_id',observer:true}),
  r('POST','/api/devices/delete',{id:'body_id',share:'forbidden',observer:true}),
  r('POST','/api/devices/pair',{share:'forbidden',observer:true,store:'auth'}),
  r('GET','/api/devices/recovery',{share:'forbidden'}),
  r('GET','/api/devices/sip-directory',{share:'forbidden'}),
  r('GET','/api/devices/events',{share:'global',store:'read'}),
  r('GET','/api/devices/history',{id:'query',store:'read'}),
  r('GET','/api/devices/traffic',{id:'query',store:'read'}),
  r('GET','/api/devices/trajectory-media',{id:'query'}),
  r('GET','/api/devices/status-request',{id:'query',store:'read'}),
  r('POST','/api/devices/request-status',{id:'body'}),
  // ── 设备自己来的：凭设备令牌，不认管理员会话 ──
  r('POST','/api/devices/enroll',{who:'device'}),
  r('GET','/api/devices/enroll-status',{who:'device'}),
  r('POST','/api/devices/report',{who:'device'}),
  r('POST','/api/devices/push-config',{who:'device'}),
  r('POST','/api/devices/push-sync',{who:'device'}),
  r('POST','/api/devices/share-link',{who:'device'}),
  r('POST','/api/devices/proxy-config/offer',{who:'device'}),
  r('POST','/api/devices/media-native/offer',{who:'device'}),
  r('POST','/api/elfremote/update-progress',{who:'device'}),
  r('POST','/api/elfremote/task-progress',{who:'device'}),
  r('GET','/api/elfremote/file-download',{who:'device'}),
  r('POST','/api/elfremote/report-photo',{who:'device'}),
  r('POST','/api/elfremote/file-return',{who:'device'}),
  r('PUT','/api/elfremote/file-return',{who:'device'}),
  r('GET','/api/elfremote/adb/device',{who:'device'}),
  r('GET','/api/elfremote/media/device',{who:'device'}),
  r('GET','/api/elfremote/desktop/device',{who:'device'}),
  r('GET','/api/elfremote/adb-tunnel/host',{who:'device'}),
  r('GET','/api/elfremote/adb-tunnel/device',{who:'device'}),
  r('GET','/api/elfremote/apk/:job',{who:'device',pattern:/^\/api\/elfremote\/apk\/[^/]+$/}),
  r('GET','/api/elfremote/proxy-config/:task',{who:'device',pattern:/^\/api\/elfremote\/proxy-config\/[A-Za-z0-9-]{1,96}$/,alias:'/api/elfremote/proxy-config'}),
  // ── agent：MCP 端点自带 Bearer，由 handleMcp 自行认证 ──
  r('POST','/api/mcp',{who:'agent'}),
  r('DELETE','/api/mcp',{who:'agent'}),
  // ── 任务与制品 ──
  r('POST','/api/elfremote/task',{id:'body',store:'auth'}),
  r('GET','/api/elfremote/tasks',{id:'query',store:'read'}),
  r('GET','/api/elfremote/task-log',{id:'query'}),
  r('POST','/api/elfremote/assign',{id:'body',store:'auth'}),
  r('GET','/api/elfremote/releases',{share:'global',store:'read'}),
  r('POST','/api/elfremote/releases',{share:'forbidden',observer:true}),
  r('POST','/api/elfremote/releases/prune',{share:'forbidden',observer:true}),
  r('PUT','/api/elfremote/releases/upload',{share:'forbidden',observer:true}),
  r('POST','/api/elfremote/proxy-config',{share:'forbidden',observer:true,outer:true}),
  r('GET','/api/elfremote/report-photo',{id:'query'}),
  r('GET','/api/elfremote/media-recordings',{id:'query'}),
  r('GET','/api/elfremote/files',{id:'query',outer:true}),
  r('POST','/api/elfremote/files',{id:'body',outer:true}),
  r('GET','/api/elfremote/files/:rest',{id:'query',pattern:/^\/api\/elfremote\/files\//,alias:'/api/elfremote/files',outer:true}),
  r('DELETE','/api/elfremote/file-return',{id:['body','query'],outer:true}),
  r('GET','/api/elfremote/file-return/received',{id:'query',outer:true}),
  // ── MCP 令牌管理（管理员），一令牌一设备 ──
  r('GET','/api/elfremote/mcp-tokens',{id:'query'}),
  r('POST','/api/elfremote/mcp-tokens',{id:'body'}),
  r('POST','/api/elfremote/mcp-tokens/delete',{id:'body'}),
  r('POST','/api/elfremote/mcp-tokens/release',{id:'body'}),
  // ── 实时会话：建立带 device_id；查询/关闭只带 session_id，归属由 DO 按会话 owner 核对 ──
  r('POST','/api/elfremote/media/session',{id:'body'}),
  r('GET','/api/elfremote/media/session',{id:'query'}),
  r('DELETE','/api/elfremote/media/session'),
  r('POST','/api/elfremote/adb/session',{id:'body'}),
  r('GET','/api/elfremote/adb/session',{id:'query'}),
  r('POST','/api/elfremote/adb-tunnel/session',{id:'body'}),
  r('GET','/api/elfremote/adb-tunnel/session',{id:'query'}),
  r('DELETE','/api/elfremote/adb-tunnel/session'),
  r('POST','/api/elfremote/desktop/session',{id:'body'}),
  r('GET','/api/elfremote/desktop/session',{id:'query'}),
  r('DELETE','/api/elfremote/desktop/session'),
  r('GET','/api/elfremote/media/browser'),
  r('GET','/api/elfremote/adb/browser'),
  r('GET','/api/elfremote/adb/observer'),
  r('GET','/api/elfremote/desktop/browser'),
  // ── 单设备分享 ──
  r('POST','/api/share/login',{who:'public',share:'global',store:'auth'}),
  r('GET','/api/share/session',{who:'public',share:'global',store:'auth'}),
  r('POST','/api/share/logout',{who:'public',share:'global'}),
  r('GET','/api/share/links',{id:'query'}),
  r('POST','/api/share/links',{id:'body',observer:true}),
  r('POST','/api/share/links/update',{id:'body',observer:true}),
  r('POST','/api/share/links/delete',{id:'body',observer:true}),
  // ── 管理员运维 ──
  r('GET','/api/admin/store-size',{share:'forbidden',store:'read'}),
  r('GET','/api/admin/health',{share:'forbidden',store:'read'}),
  r('GET','/api/admin/legacy-store',{share:'forbidden'}),
  r('POST','/api/admin/legacy-store',{share:'forbidden'}),
  r('POST','/api/admin/prepare-kv',{share:'forbidden'}),
]);

const exact=new Map();
for(const route of ROUTES)if(!route.pattern)exact.set(route.method+' '+route.path,route);
/** 按方法与路径找表项；正则路由按 pattern 匹配。找不到返回 undefined。 */
export function routeFor(path,method){
  return exact.get(method+' '+path)||ROUTES.find(route=>route.pattern&&route.method===method&&route.pattern.test(path));
}
const paths=(filter)=>new Set(ROUTES.filter(route=>!route.pattern&&filter(route)).map(route=>route.path));
const idSources=(kind)=>paths(route=>[].concat(route.id||[]).includes(kind));

/** 机器路由：设备令牌或 agent Bearer 自证，不走管理员会话、不查来源。 */
export function isMachineRoute(path,method){
  const route=routeFor(path,method);
  return !!route&&(route.who==='device'||route.who==='agent');
}
/** /api/devices 下所有已注册路径；不在其中的回 404 而不是「请先登录」。 */
export const DEVICE_ROUTES=paths(route=>route.path.startsWith('/api/devices'));
export function unknownDeviceRoute(path){return path.startsWith('/api/devices')&&!DEVICE_ROUTES.has(path);}

// 独立页范围裁决用的五张表
export const DEVICE_ID_QUERY=idSources('query');
export const DEVICE_ID_BODY=idSources('body');
export const DEVICE_ID_BODY_ID=idSources('body_id');
export const SHARE_FORBIDDEN=Object.freeze(ROUTES.filter(route=>route.share==='forbidden').map(route=>[route.method,route.path]));
export const SHARE_GLOBAL_READ=paths(route=>route.share==='global');
export const OBSERVER_ALLOWED=Object.freeze(ROUTES.filter(route=>route.observer).map(route=>[route.method,route.path]));

// 外层 Worker 的三类分流
export function singleStoreRead(path,method){return method==='GET'&&routeFor(path,method)?.store==='read';}
export function storeAuthenticates(path,method){return routeFor(path,method)?.store==='auth';}
export const KV_INDEPENDENT=paths(route=>route.kv);
const OUTER_DEVICE=paths(route=>route.outer);
/** 外层 Worker 自己处理的设备范围路由（文件、取回、代理配置）：写操作前要先取旁观锁。 */
export function outerDeviceRoute(path){return OUTER_DEVICE.has(path)||path.startsWith('/api/elfremote/files/');}

// 代理面板单独部署在 s.elfradio.net，与管理面板共用同一份代码，靠 PANEL_ROLE 区分角色。
// 订阅接口必须对全网开放，是天然的公开面；设备管理与电话管理是纯后台，不该跟着一起暴露。
// 2026-09-17 与 09-19 两次封禁都是公开地址被刷所致，把两者放在同一个 Worker 里，
// 一次举报就会连带打掉后台。proxy 角色只放行代理面板自己用到的路径，其余一律 404。
// 用冻结数组而不是 Set：Object.freeze 对 Set 无效，add() 照样能往里塞路径。
export const PROXY_ROLE_STATIC=Object.freeze(['/','/index.html','/favicon.ico','/logo.png','/admin-session.js','/cf-usage.js','/panel-lifecycle.js']);
export const PROXY_ROLE_PATHS=Object.freeze([...PROXY_ROLE_STATIC,...paths(route=>route.proxy)]);

// 代理面板 Worker（s.elfradio.net）的入口。
// 管理面板 v.elfradio.net 的入口是 worker.js 本身，它不认识 proxy-panel.js，
// 打包时也就不会把订阅生成和节点池页面带进去——两个域名跑的是同一份仓库、不同的产物。
import worker from './worker.js';
// 这个 import 本身就是注册动作：proxy-panel.js 在模块顶层调用 registerProxyPanel，
// 把 /、/sub*、/api/data、/api/save 四条路由接回 worker.js 的路由表。
import './proxy-panel.js';

export { ElfStore, ElfStoreLegacy, PROXY_ROLE_PATHS, proxyRoleBlocked } from './worker.js';
export default worker;

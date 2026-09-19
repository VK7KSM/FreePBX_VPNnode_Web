import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// 代理面板单独部署在 s.elfradio.net，只带它自己用得到的静态资源。
// 与其靠路由规则把管理面板的页面挡回去，不如根本不把它们放上去：
// 静态资源是在 Worker 之前返回的，run_worker_first 没覆盖到的路径闸门管不着，
// /devices 和 /sip 那两个页面就会照常 200。少放文件是唯一彻底的办法。
const root = fileURLToPath(new URL('.', import.meta.url));
const FROM = root + '.generated-assets/';
const TO = root + '.generated-assets-proxy/';
export const PROXY_ASSETS = Object.freeze([
  'index.html', 'logo.png', 'favicon.ico',
  'admin-session.js', 'cf-usage.js', 'panel-lifecycle.js', 'panel-version.json',
  '_headers',
]);

export function buildProxyAssets() {
  fs.rmSync(TO, { recursive: true, force: true });
  fs.mkdirSync(TO, { recursive: true });
  const copied = [];
  for (const name of PROXY_ASSETS) {
    if (!fs.existsSync(FROM + name)) continue;
    fs.copyFileSync(FROM + name, TO + name);
    copied.push(name);
  }
  return copied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const copied = buildProxyAssets();
  console.log('代理面板静态资源', copied.length, '个：' + copied.join(', '));
}

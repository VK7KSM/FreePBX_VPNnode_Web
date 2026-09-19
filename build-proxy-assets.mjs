import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import proxyWorker from './worker-proxy.js';

// 代理面板单独部署在 s.elfradio.net，只带它自己用得到的静态资源。
// 与其靠路由规则把管理面板的页面挡回去，不如根本不把它们放上去：
// 静态资源是在 Worker 之前返回的，run_worker_first 没覆盖到的路径闸门管不着，
// /devices 和 /sip 那两个页面就会照常 200。少放文件是唯一彻底的办法。
const root = fileURLToPath(new URL('.', import.meta.url));
const FROM = root + '.generated-assets/';
const TO = root + '.generated-assets-proxy/';

// 首页只有代理 Worker 会渲染（管理面板的 / 是一条跳转），所以在这里单独生成，
// 不能从 .generated-assets 里拷——那边已经不产 index.html 了。
export const PROXY_ASSETS = Object.freeze([
  'logo.png', 'favicon.ico',
  'admin-session.js', 'cf-usage.js', 'panel-lifecycle.js', 'panel-version.json',
  '_headers',
]);

export async function buildProxyAssets() {
  fs.rmSync(TO, { recursive: true, force: true });
  fs.mkdirSync(TO, { recursive: true });
  const copied = [];
  for (const name of PROXY_ASSETS) {
    if (!fs.existsSync(FROM + name)) continue;
    fs.copyFileSync(FROM + name, TO + name);
    copied.push(name);
  }
  const response = await proxyWorker.fetch(new Request('https://assets-build.invalid/'), {});
  if (!response.ok) throw Error('代理面板首页生成失败 ' + response.status);
  // 版本号沿用管理面板那一份：两个 Worker 同一份代码、同一批脚本，面板生命周期脚本比对的就是它。
  const { version } = JSON.parse(fs.readFileSync(FROM + 'panel-version.json', 'utf8'));
  fs.writeFileSync(path.join(TO, 'index.html'), (await response.text()).replaceAll('__ELF_PANEL_VERSION__', version));
  copied.push('index.html');
  return copied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const copied = await buildProxyAssets();
  console.log('代理面板静态资源', copied.length, '个：' + copied.join(', '));
}

// 为某个发布通道离线签一份清单，产出可直接拖进网页「客户端管理」页的 JSON。
//
// 私钥只在本机，永远不进浏览器、不进服务器——正是这一点保证了服务端即使被攻破
// 也没法让设备装上伪造的包。所以网页那一步只能上传「已签好的清单 + APK」，
// 签名这一步必须在本机做，这个脚本就是把它压成一条命令。
//
// 用法：
//   node tools/sign_channel_release.mjs --apk <路径> --channel d22 \
//        --version-code 201 --version-name 0.1.201-production-movement \
//        [--variant full|slim] [--cert <64位十六进制>] [--expires-days N]
//
// --variant 缺省为 full。同一版本的全量包与精简包版本码相同、哈希不同，
// 服务端按「通道 + 版本码 + 变体」判重，两者互不覆盖。
//
// 与 prepare_release.mjs 的区别：那个脚本产出的是**指派给某一台设备**的清单
// （必须给 --device），装完即针对该设备生效；这个脚本产出的是**整条通道**的清单，
// 不含 device_id，上传后不会自动指派给任何设备。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const {validateReleaseManifest, RELEASE_CHANNELS} = await import(pathToFileURL(path.join(here, '../../release-channels.js')).href);

function arg(name, required = true) {
  const i = process.argv.indexOf('--' + name);
  const value = i > 0 ? process.argv[i + 1] : undefined;
  if (required && (!value || value.startsWith('--'))) throw Error('缺少参数 --' + name);
  return value;
}

const apkPath = arg('apk');
const channel = arg('channel');
const versionName = arg('version-name');
const versionCode = Number(arg('version-code'));
if (!Object.hasOwn(RELEASE_CHANNELS, channel)) throw Error('未知通道：' + channel + '，可用：' + Object.keys(RELEASE_CHANNELS).join('、'));
if (!Number.isSafeInteger(versionCode) || versionCode <= 0) throw Error('版本码无效');

const apk = fs.readFileSync(apkPath);
const sha256 = crypto.createHash('sha256').update(apk).digest('hex');

// 证书指纹宁可现测也不要手填：填错的后果是设备验签通过、安装时才被系统拒绝，
// 那时候包已经发出去了，排查起来看着像「更新莫名失败」。
function certFromApk() {
  const explicit = arg('cert', false);
  if (explicit) return explicit.toLowerCase();
  const roots = [];
  try {
    const local = fs.readFileSync(path.join(here, '../local.properties'), 'utf8').match(/sdk\.dir=(.+)/);
    if (local) roots.push(local[1].trim().replace(/\\\\/g, '/'));
  } catch {}
  if (process.env.ANDROID_SDK_ROOT) roots.push(process.env.ANDROID_SDK_ROOT);
  for (const root of roots) {
    let tools = [];
    try { tools = fs.readdirSync(path.join(root, 'build-tools')).sort(); } catch { continue; }
    for (const version of tools.reverse()) {
      const signer = path.join(root, 'build-tools', version, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
      if (!fs.existsSync(signer)) continue;
      // Windows 上 apksigner 是 .bat，execFileSync 直接拉会 EINVAL，必须过一层 shell。
      const out = execFileSync(signer, ['verify', '--print-certs', apkPath],
        {encoding: 'utf8', shell: process.platform === 'win32'});
      const found = out.match(/certificate SHA-256 digest:\s*([0-9a-f]{64})/i);
      if (found) return found[1].toLowerCase();
    }
  }
  throw Error('找不到 apksigner，无法读取 APK 证书指纹；请显式传 --cert <64位十六进制>');
}

const profile = RELEASE_CHANNELS[channel];
const variant = arg('variant', false) || 'full';
if (!['full','slim'].includes(variant)) throw Error('变体只能是 full 或 slim');
// job_id 要区分变体：它同时是 R2 的对象键与下载地址，两个变体撞键会互相覆盖。
const job = channel + '-' + (variant === 'slim' ? 'slim-' : '')
  + versionName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() + '-' + sha256.slice(0, 12);
const manifest = {
  channel, package: profile.package, model_id: profile.model_id,
  // 同一版本会出两个包：全量自带原生库供首次装机，精简不带库做日常更新。
  // 服务端按「通道 + 版本码 + 变体」判重，不写变体则按 full 处理。
  ...(variant === 'slim' ? {variant} : {}),
  ...(profile.product_id ? {product_id: profile.product_id} : {}),
  ...(profile.abi ? {abi: profile.abi} : {}),
  ...(profile.asset === true ? {} : {certSha256: certFromApk()}),
  versionCode, versionName, size: apk.length, sha256,
  // 有效期就是防重放的那道闸：设备会拒绝过期的清单（UpdateTool 第 92 行，理由记作 expired）。
  // d22 以前用 expires_at=0（永不过期），等于自己关掉了这道闸——服务端一旦失守，
  // 攻击者可以把任意一份当年合法签过的旧清单连同旧 APK 原样重发，把设备降级回去。
  // 不用「禁止降级」来解决，是因为那会把远程回退一起堵死：新版装上去了、健康检查也过了、
  // 只是某个功能坏了，这时唯一的远程手段就是下发旧版本，自动回滚救不了这种。
  // 90 天由所有者拍板（2026-09-21）：这个数同时是「.sig 能放多久再传」「能回退到多旧的版本」
  // 和「攻击者能重放多久以前的包」，三者是同一个旋钮。
  expires_at: Date.now() + (Number(arg('expires-days', false) || (channel === 'd22' ? 90 : 0.042)) * 86400000),
  job_id: job,
  url: 'https://v.elfradio.net/api/elfremote/apk/' + job
};

const raw = JSON.stringify(manifest);
validateReleaseManifest(manifest);
const signature = crypto.sign('sha256', Buffer.from(raw), fs.readFileSync(path.join(here, 'update-keys/private.pem'))).toString('hex');
if (!crypto.verify('sha256', Buffer.from(raw), fs.readFileSync(path.join(here, 'update-keys/public.pem')), Buffer.from(signature, 'hex')))
  throw Error('本机验签未通过，不要上传');

const output = arg('out', false) || apkPath.replace(/\.apk$/i, '') + '.sig';
fs.writeFileSync(output, JSON.stringify({manifest_raw: raw, signature}), {mode: 0o600});
console.log(JSON.stringify({channel, versionCode, versionName, size: apk.length, sha256, job_id: job, signed_manifest: path.resolve(output)}, null, 2));
console.log('');
console.log('把这个 .sig 文件连同 APK 一起交给发布者即可。');
console.log('发布者在网页「客户端管理」里两个文件都选上、点上传——');
console.log('不需要密钥、不需要命令行，也不需要构建方在场。');

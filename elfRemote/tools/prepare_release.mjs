import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const [apkPath, metadataPath, deviceId, outputPath] = process.argv.slice(2);
if (!apkPath || !metadataPath || !deviceId || !outputPath) throw new Error('需要 APK、实际解析元数据、目标设备和输出路径');
const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8').replace(/^\uFEFF/, ''));
if (metadata.package !== 'net.elfradio.elfremote' || !Number.isInteger(metadata.versionCode) || metadata.versionCode <= 0
    || !metadata.versionName || !/^[0-9a-f]{64}$/.test(metadata.certSha256 || '') || deviceId.length > 128)
  throw new Error('实际 APK 元数据或目标设备无效');
const apk = fs.readFileSync(apkPath);
if (!apk.length || apk.length > 64 * 1024 * 1024) throw new Error('APK 大小无效');
const job = 'upd-' + Date.now().toString(36) + '-' + crypto.randomUUID().slice(0,8);
const manifest = {...metadata,device_id:deviceId,job_id:job,size:apk.length,
  sha256:crypto.createHash('sha256').update(apk).digest('hex'),expires_at:Date.now()+3600000,
  url:'https://v.elfradio.net/api/elfremote/apk/'+job};
const raw = JSON.stringify(manifest);
const directory = path.dirname(fileURLToPath(import.meta.url));
const signature = crypto.sign('sha256',Buffer.from(raw),fs.readFileSync(path.join(directory,'update-keys/private.pem'))).toString('hex');
fs.writeFileSync(outputPath,JSON.stringify({manifest_raw:raw,signature,apk_b64:apk.toString('base64')}),{flag:'wx',mode:0o600});
console.log(JSON.stringify({versionCode:manifest.versionCode,bytes:apk.length,sha256:manifest.sha256,output:path.resolve(outputPath)}));

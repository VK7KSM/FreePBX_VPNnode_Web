// 从全量包生出精简包：去掉 lib/ 下的原生库，其余条目原样搬运，然后重新对齐并签名。
//
// 为什么从全量包裁，而不是分别构建两次：两次构建的 dex 与资源不保证逐字节相同。
// 一旦有差异，「同一版本的两个包」就不再是同一份程序，现场出问题时无从判断装的是哪个。
// 裁剪保证两者除那个原生库之外完全一致。
//
// 条目是按原压缩数据整段搬运的，不重新压缩，所以保留下来的每一个文件都逐字节不变。
// 改动归档之后原签名必然失效（APK 签名覆盖归档内容），故最后必须重新签名。
//
// 用法：
//   node tools/make_slim_apk.mjs --full <全量包> --out <精简包>
//        [--keystore <路径>] [--alias <别名>] [--storepass <口令>]
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
function arg(name, required = true, fallback) {
  const i = process.argv.indexOf('--' + name);
  const value = i > 0 ? process.argv[i + 1] : undefined;
  if (value && !value.startsWith('--')) return value;
  if (required) throw Error('缺少参数 --' + name);
  return fallback;
}

const fullPath = arg('full');
const outPath = arg('out');
const home = process.env.USERPROFILE || process.env.HOME || '';
const keystore = arg('keystore', false, path.join(home, '.android', 'debug.keystore'));
const alias = arg('alias', false, 'androiddebugkey');
const storePass = arg('storepass', false, 'android');

function sdkTool(name) {
  const roots = [];
  try {
    const found = fs.readFileSync(path.join(here, '../local.properties'), 'utf8').match(/sdk\.dir=(.+)/);
    if (found) roots.push(found[1].trim());
  } catch {}
  if (process.env.ANDROID_SDK_ROOT) roots.push(process.env.ANDROID_SDK_ROOT);
  for (const root of roots) {
    let versions = [];
    try { versions = fs.readdirSync(path.join(root, 'build-tools')).sort().reverse(); } catch { continue; }
    for (const version of versions) {
      const tool = path.join(root, 'build-tools', version, process.platform === 'win32' ? name + '.bat' : name);
      if (fs.existsSync(tool)) return tool;
      const bare = path.join(root, 'build-tools', version, name + (process.platform === 'win32' ? '.exe' : ''));
      if (fs.existsSync(bare)) return bare;
    }
  }
  throw Error('找不到 ' + name + '，请检查 local.properties 的 sdk.dir 或 ANDROID_SDK_ROOT');
}
const run = (tool, args) => execFileSync(tool, args, {encoding: 'utf8', shell: process.platform === 'win32'});

const SIG_CENTRAL = 0x02014b50, SIG_LOCAL = 0x04034b50, SIG_EOCD = 0x06054b50;

function centralDirectory(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i--)
    if (buffer.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  if (eocd < 0) throw Error('不是有效的 zip：找不到中央目录结尾记录');
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  if (at === 0xffffffff) throw Error('该归档使用了 zip64，本工具未实现');
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(at) !== SIG_CENTRAL) throw Error('中央目录记录损坏');
    const flags = buffer.readUInt16LE(at + 8);
    // 位 3 表示长度写在数据描述符里而非头部。AGP 产出的 APK 不用它；
    // 真遇到就直接报错，不要按「大概没有描述符」去猜，猜错会把归档切坏。
    if (flags & 0x8) throw Error('条目使用了数据描述符，本工具未实现：' + at);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const compressed = buffer.readUInt32LE(at + 20);
    const localOffset = buffer.readUInt32LE(at + 42);
    if (compressed === 0xffffffff || localOffset === 0xffffffff) throw Error('该条目使用了 zip64，本工具未实现');
    entries.push({
      name: buffer.toString('utf8', at + 46, at + 46 + nameLength),
      central: buffer.subarray(at, at + 46 + nameLength + extraLength + commentLength),
      compressed, localOffset
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const full = fs.readFileSync(fullPath);
const entries = centralDirectory(full);
const isNative = e => /^lib\/.*\.so$/.test(e.name);
const dropped = entries.filter(isNative);
if (!dropped.length) throw Error('这个包里没有 lib/*.so，无需精简');

// 精简包不含原生库，必须自带「我需要哪一个库」的身份，否则设备无从判断
// 本地那份是不是对的、该去下载哪一个。全量包不需要——它自己就带着那个库。
function nativeIdentity(entry) {
  const local = entry.localOffset;
  const nameLength = full.readUInt16LE(local + 26), extraLength = full.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const raw = full.subarray(start, start + entry.compressed);
  const method = full.readUInt16LE(local + 8);
  const bytes = method === 0 ? raw : zlib.inflateRawSync(raw);
  return {abi: entry.name.split('/')[1], name: entry.name.split('/').pop(),
    size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex')};
}

function storedEntry(name, contents) {
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = zlib.crc32 ? zlib.crc32(contents) : crc32(contents);
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(SIG_LOCAL, 0); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(contents.length, 18); local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(SIG_CENTRAL, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(contents.length, 20); central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  nameBytes.copy(central, 46);
  return {data: Buffer.concat([local, contents]), central};
}
// Node 18 起才有 zlib.crc32；老版本自己算，免得换机器就跑不起来。
function crc32(buffer) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  c = -1;
  for (const byte of buffer) c = (c >>> 8) ^ table[(c ^ byte) & 0xff];
  return (c ^ -1) >>> 0;
}

const identity = nativeIdentity(dropped[0]);
const identityEntry = storedEntry('assets/media-native.json',
  Buffer.from(JSON.stringify(identity), 'utf8'));

const pieces = [];
const centrals = [];
let cursor = 0;
for (const entry of entries) {
  if (isNative(entry)) continue;
  // 本地头的 extra 长度可能与中央目录里的不同，必须按本地头自己的字段算。
  const local = entry.localOffset;
  if (full.readUInt32LE(local) !== SIG_LOCAL) throw Error('本地文件头损坏：' + entry.name);
  const localNameLength = full.readUInt16LE(local + 26);
  const localExtraLength = full.readUInt16LE(local + 28);
  const start = local, end = local + 30 + localNameLength + localExtraLength + entry.compressed;
  const central = Buffer.from(entry.central);
  central.writeUInt32LE(cursor, 42);            // 指向条目在新归档中的位置
  pieces.push(full.subarray(start, end));
  centrals.push(central);
  cursor += end - start;
}

// 身份文件排在最后一个条目，偏移用当前游标。
{
  const central = Buffer.from(identityEntry.central);
  central.writeUInt32LE(cursor, 42);
  pieces.push(identityEntry.data);
  centrals.push(central);
  cursor += identityEntry.data.length;
}

const centralStart = cursor;
const centralBytes = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(SIG_EOCD, 0);
eocd.writeUInt16LE(centrals.length, 8);
eocd.writeUInt16LE(centrals.length, 10);
eocd.writeUInt32LE(centralBytes.length, 12);
eocd.writeUInt32LE(centralStart, 16);

const staged = outPath + '.staged';
fs.writeFileSync(staged, Buffer.concat([...pieces, centralBytes, eocd]));

// 删掉条目会让后面所有条目的偏移改变，STORED 条目的对齐随之被破坏；
// zipalign 重新对齐，再签名。顺序不能反：签名之后再动归档会让签名失效。
const aligned = outPath + '.aligned';
fs.rmSync(aligned, {force: true});
run(sdkTool('zipalign'), ['-p', '-f', '4', staged, aligned]);
fs.rmSync(staged, {force: true});
fs.rmSync(outPath, {force: true});
fs.renameSync(aligned, outPath);

const apksigner = sdkTool('apksigner');
run(apksigner, ['sign', '--ks', keystore, '--ks-pass', 'pass:' + storePass,
  '--ks-key-alias', alias, '--key-pass', 'pass:' + storePass, outPath]);
fs.rmSync(outPath + '.idsig', {force: true});

const verified = run(apksigner, ['verify', '--print-certs', outPath]);
const cert = (verified.match(/certificate SHA-256 digest:\s*([0-9a-f]{64})/i) || [])[1];
const before = fs.statSync(fullPath).size, after = fs.statSync(outPath).size;
console.log(JSON.stringify({
  移除: dropped.map(e => e.name),
  写入身份: identity,
  全量包: before, 精简包: after, 省下: before - after,
  证书: cert
}, null, 2));

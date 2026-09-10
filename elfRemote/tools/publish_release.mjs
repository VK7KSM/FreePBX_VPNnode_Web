import fs from 'node:fs';
import {createHash,verify,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {validateReleaseManifest} from '../../release-channels.js';

const BASE='https://v.elfradio.net';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function validateInput(input,publicKey){
 if(typeof input.manifest_raw!=='string'||!/^(?:[0-9a-f]{2})+$/i.test(input.signature||''))throw Error('缺少签名清单');
 if(!verify('sha256',Buffer.from(input.manifest_raw),publicKey,Buffer.from(input.signature,'hex')))throw Error('发布清单签名不匹配');
 const manifest=JSON.parse(input.manifest_raw),channel=validateReleaseManifest(manifest);
 if(typeof input.apk_b64!=='string')throw Error('缺少APK');
 const bytes=Buffer.from(input.apk_b64,'base64');
 if(bytes.length!==manifest.size||hash(bytes)!==manifest.sha256)throw Error('APK与清单的长度或哈希不符');
 return {manifest,channel,bytes};
}
export function sessionCookie(session){
 const c=session.cookies?.find(c=>c.name==='elf_admin'&&['v.elfradio.net','.elfradio.net'].includes(c.domain));
 if(!c||!c.value||(c.expires>0&&c.expires*1000<=Date.now())||/[\r\n;]/.test(c.value))throw Error('管理员会话缺失或过期，请正常登录生产网页后更新会话文件');
 return 'elf_admin='+c.value;
}
export async function publishRelease({input,session,assign,publicKey},fetcher=fetch){
 const {manifest:m,channel,bytes}=validateInput(input,publicKey),cookie=sessionCookie(session);
 if(assign&&m.device_id&&assign!==m.device_id)throw Error('下发目标与签名清单不一致');
 const headers={Cookie:cookie,Origin:BASE};
 async function json(url,options={}){
  const response=await fetcher(BASE+url,{...options,redirect:'error',signal:AbortSignal.timeout(120000),headers:{...headers,...options.headers}});
  if(response.status===401)throw Error('管理员会话已失效，请重新登录');
  if(!response.ok)throw Error('发布接口 HTTP '+response.status+'；请检查通道、目标能力、版本冲突和清单有效期');
  const result=await response.json();if(!result.ok)throw Error('发布接口未确认成功');return result;
 }
 const endpoint='/api/elfremote/releases?channel='+channel;
 const before=await json(endpoint);if(before.channel!==channel)throw Error('生产服务器尚未支持该独立通道');
 const result=await json('/api/elfremote/releases/upload',{method:'PUT',headers:{'Content-Type':'application/vnd.android.package-archive','Content-Length':String(bytes.length),'X-Elf-Manifest':Buffer.from(input.manifest_raw).toString('base64'),'X-Elf-Signature':input.signature,'X-Elf-Publish-Only':'1'},body:bytes});
 for(const field of ['versionCode','versionName','package','sha256','size'])if(result[field]!==m[field])throw Error('发布返回信息与制品不一致');
 if(result.channel!==channel)throw Error('发布返回通道不一致');
 const listed=await json(endpoint);if(!listed.releases.some(r=>r.versionCode===m.versionCode&&r.sha256===m.sha256&&r.channel===channel&&!r.expired))throw Error('发布后版本目录核验失败');
 const download=await fetcher(m.url,{redirect:'error',signal:AbortSignal.timeout(120000)});
 if(!download.ok)throw Error('发布后APK下载核验失败');
 const actual=Buffer.from(await download.arrayBuffer());if(actual.length!==m.size||hash(actual)!==m.sha256)throw Error('发布后APK下载校验不一致');
 let assigned=false;
 if(assign){await json('/api/elfremote/assign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_id:assign,channel,versionCode:m.versionCode,request_id:randomUUID()})});assigned=true;}
 return {channel,versionCode:m.versionCode,versionName:m.versionName,size:m.size,sha256:m.sha256,published:true,download_verified:true,assigned};
}
async function main(){
 const args=process.argv.slice(2);
 if(args.includes('--help')){console.log('用法：node elfRemote/tools/publish_release.mjs --input 已签名发布.json --session 管理员会话.json [--assign 目标设备编号]\n默认只发布并校验下载；仅 --assign 会下发更新。固定使用生产服务，私钥和会话不写入代码或日志。');return;}
 const options={};for(let i=0;i<args.length;i+=2){if(!['--input','--session','--assign'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error('参数无效，请使用 --help');options[args[i].slice(2)]=args[i+1];}
 if(!options.input||!options.session)throw Error('必须指定 --input 和 --session');
 const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 const publicKey=fs.readFileSync(new URL('./update-keys/public.pem',import.meta.url));
 const result=await publishRelease({input:read(options.input),session:read(options.session),assign:options.assign,publicKey});
 console.log(JSON.stringify(result,null,2));
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(error.message);process.exitCode=1;});

import {faultRequire as need, faultReceipt} from './fault-contract.js';
const MAX=8388608, decoder=new TextDecoder('utf-8',{fatal:true});
export async function faultHash(data){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).map(b=>b.toString(16).padStart(2,'0')).join('');}
// JSON.parse本身会吞掉重复键，故障清单在解析前必须检查每层对象。
export function faultJson(bytes){
  const s=decoder.decode(bytes);let at=0;
  const ws=()=>{while(/\s/.test(s[at]||'')&&at<s.length)at++;};
  const str=()=>{const start=at;need(s[at++]==='"','JSON字符串无效');while(at<s.length){const c=s[at++];if(c==='\\'){at++;continue;}if(c==='"')return JSON.parse(s.slice(start,at));}throw Error('JSON字符串不完整');};
  function value(depth){need(depth<=64,'JSON嵌套过深');ws();const c=s[at];
    if(c==='{'){at++;ws();const keys=new Set();if(s[at]==='}'){at++;return;}for(;;){ws();const key=str();need(!keys.has(key),'JSON包含重复字段');keys.add(key);ws();need(s[at++]===':','JSON字段无效');value(depth+1);ws();const end=s[at++];if(end==='}')break;need(end===',','JSON对象不完整');}}
    else if(c==='['){at++;ws();if(s[at]===']'){at++;return;}for(;;){value(depth+1);ws();const end=s[at++];if(end===']')break;need(end===',','JSON数组不完整');}}
    else if(c==='"')str();else {const m=/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(s.slice(at));need(m,'JSON值无效');at+=m[0].length;}
  }
  value(0);ws();need(at===s.length,'JSON含尾随数据');return JSON.parse(s);
}
function crc32(bytes){let crc=0xffffffff;for(const b of bytes){crc^=b;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
export function faultZip(bytes){
  need(bytes.length>22&&bytes.length<=MAX,'ZIP长度超限');const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),u16=p=>v.getUint16(p,true),u32=p=>v.getUint32(p,true);
  let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(u32(i)===0x06054b50&&i+22+u16(i+20)===bytes.length){end=i;break;}
  need(end>=0&&u16(end+4)===0&&u16(end+6)===0&&u16(end+8)===u16(end+10),'ZIP目录无效');
  const count=u16(end+10),size=u32(end+12),start=u32(end+16);need(count>1&&count<=49&&start+size===end,'ZIP条目数量或目录尺寸无效');
  const entries=new Map(),ranges=[];let p=start;
  for(let i=0;i<count;i++){
    need(p+46<=end&&u32(p)===0x02014b50,'ZIP条目损坏');const flags=u16(p+8),method=u16(p+10),crc=u32(p+16),packed=u32(p+20),length=u32(p+24),nameLen=u16(p+28),extra=u16(p+30),comment=u16(p+32),offset=u32(p+42),attributes=u32(p+38);
    need(p+46+nameLen+extra+comment<=end&&method===0&&(flags&~0x800)===0&&length<=1048576&&packed===length&&((attributes>>>16)&0xf000)!==0xa000,'ZIP编码或文件类型不符');
    const name=decoder.decode(bytes.subarray(p+46,p+46+nameLen));need(!name.endsWith('/')&&!entries.has(name)&&nameLen>0,'ZIP重复或目录条目');
    need(offset+30<=start&&u32(offset)===0x04034b50&&u16(offset+6)===flags&&u16(offset+8)===method&&u32(offset+14)===crc&&u32(offset+18)===packed&&u32(offset+22)===length,'ZIP本地头不一致');
    const localName=u16(offset+26),localExtra=u16(offset+28),dataAt=offset+30+localName+localExtra;
    need(dataAt+length<=start&&decoder.decode(bytes.subarray(offset+30,offset+30+localName))===name,'ZIP本地路径或长度不一致');
    need(!ranges.some(r=>offset<r[1]&&dataAt+length>r[0]),'ZIP文件范围重叠');ranges.push([offset,dataAt+length]);
    const data=bytes.slice(dataAt,dataAt+length);need(crc32(data)===crc,'ZIP校验和不一致');entries.set(name,data);p+=46+nameLen+extra+comment;
  }
  need(p===end,'ZIP目录含多余条目');return entries;
}
export async function verifyFaultPackage(bytes,receipt,eventId){
  faultReceipt(receipt,eventId);need(bytes.length===receipt.bytes&&await faultHash(bytes)===receipt.sha256,'故障包长度或摘要不符');const zip=faultZip(bytes),mb=zip.get('manifest.json');
  need(mb&&mb.length<=65536&&mb.length===receipt.manifestBytes&&await faultHash(mb)===receipt.manifestSha256,'故障清单长度或摘要不符');
  const m=faultJson(mb);need(m.schemaVersion===1&&m.kind==='FAULT_EVENT_BUNDLE'&&m.eventId===eventId&&m.scope==='ALL_FROZEN_EVENT_FILES','故障清单身份不符');
  need(Array.isArray(m.files)&&m.files.length>0&&m.files.length<=48&&m.files.length===receipt.files,'故障清单数量不符');
  const paths=new Set(['manifest.json']);let total=0,rawFiles=0;
  for(const f of m.files){
    need(typeof f.path==='string'&&/^(?:event\.json|state\.json(?:\.next)?|pre-[1-4]\.json|post\.json|export-seal\.json|attempt-[1-3]\/[A-Za-z0-9][A-Za-z0-9_.-]{0,79})$/.test(f.path),'故障清单路径无效');
    const key='evidence/'+f.path,data=zip.get(key);need(!paths.has(key)&&data&&Number.isSafeInteger(f.bytes)&&data.length===f.bytes&&await faultHash(data)===f.sha256,'故障原件缺失、重复或摘要不符');paths.add(key);
    const raw=f.path.endsWith('.bin');need(f.role===(raw?'RAW':'METADATA'),'故障原件类别不符');if(raw)rawFiles++;total+=data.length;
  }
  need(paths.size===zip.size&&['event.json','state.json','export-seal.json'].every(p=>paths.has('evidence/'+p)),'故障包原件清单不完整');
  need(total===m.totalBytes&&total===receipt.evidenceBytes&&rawFiles===m.rawFiles&&total+mb.length<=MAX,'故障包总量不符');
  need(Array.isArray(m.gaps)&&m.gaps.length<=256,'源缺口清单无效');
  const metadata=p=>{const b=zip.get('evidence/'+p);if(!b||b.length>65536)return null;try{return faultJson(b);}catch{return null;}};
  const complete=new Map(),catalog=new Map(m.files.map(f=>[f.path,f]));
  if(receipt.captureState==='COMPLETE'&&m.rawEvidence?.captureState==='COMPLETE'&&metadata('state.json')?.capture==='COMPLETE')for(let a=1;a<=3;a++){
    const d=metadata(`attempt-${a}/report.json`)?.diagnostic;if(d?.state!=='COMPLETE'||!Array.isArray(d.items)||d.items.length>64)continue;
    for(const item of d.items){if(item?.state!=='COMPLETE'||typeof item.artifact!=='string'||! /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(item.artifact))continue;
      const path=`attempt-${a}/${item.artifact}`,f=catalog.get(path);
      if(f?.role==='RAW'&&f.bytes>0&&Number.isSafeInteger(item.before?.size)&&Number.isSafeInteger(item.storedBytes)&&f.bytes===item.before.size&&f.bytes===item.storedBytes&&f.sha256===item.storedSha256)complete.set(path,{artifact:path,bytes:f.bytes,sha256:f.sha256});
    }
  }
  return {schemaVersion:1,state:'HOST_PACKAGE_VERIFIED',eventId,bytes:bytes.length,sha256:receipt.sha256,manifestSha256:receipt.manifestSha256,files:m.files.length,rawFiles,gapCount:m.gaps.length,gaps:m.gaps,sourceLogComplete:complete.size>0,completeSourceFiles:[...complete.values()],sourceLogCompletenessScope:'AT_LEAST_ONE_NONEMPTY_CAPTURED_SOURCE_FILE_NOT_FULL_INCIDENT_WINDOW',sourceCompleteness:'SEE_MANIFEST_GAPS',deviceArchiveExecuted:false,archiveArgs:['archive',eventId,receipt.sha256,String(bytes.length),receipt.manifestSha256]};
}

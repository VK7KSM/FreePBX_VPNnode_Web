// 严格读取原JSON，重复成员或精度丢失不能用于证据指针查证。
export function parseEvidenceJson(text) {
  let at=0,nodes=0;
  const fail=()=>{throw Error('证据JSON无效、重复成员或超出读取限制');};
  const space=()=>{while(/[ \t\r\n]/.test(text[at]||'!'))at++;};
  function string(){const start=at++;while(at<text.length){const c=text[at++];if(c==='"'){try{return JSON.parse(text.slice(start,at));}catch{fail();}}if(c==='\\')at++;}fail();}
  function value(depth){
    if(depth>32||++nodes>300000)fail();space();const c=text[at];
    if(c==='"')return string();
    if(c==='{'||c==='['){const object=c==='{',out=object?Object.create(null):[];at++;space();if(text[at]===(object?'}':']')){at++;return out;}
      for(;;){space();let k;if(object){if(text[at]!=='"')fail();k=string();if(Object.hasOwn(out,k))fail();space();if(text[at++]!==':')fail();}
        const v=value(depth+1);if(object)out[k]=v;else out.push(v);space();const end=text[at++];if(end===(object?'}':']'))return out;if(end!==',')fail();}
    }
    const token=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));if(!token)fail();at+=token[0].length;
    const v=JSON.parse(token[0]);if(typeof v==='number'&&(!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v)))fail();return v;
  }
  const out=value(0);space();if(at!==text.length)fail();return out;
}

export function resolveEvidencePointer(root,pointer) {
  if(typeof pointer!=='string'||pointer.length>4096||pointer!==''&&!pointer.startsWith('/'))throw Error('JSON指针无效');
  if(pointer==='')return root;
  let value=root;
  for(const part of pointer.slice(1).split('/')){
    if(/~(?:[^01]|$)/.test(part))throw Error('JSON指针转义无效');
    const key=part.replace(/~1/g,'/').replace(/~0/g,'~');
    if(value===null||typeof value!=='object'||Array.isArray(value)&&!/^(0|[1-9]\d*)$/.test(key)||!Object.hasOwn(value,key))throw Error('原件中不存在该JSON指针');
    value=value[key];
  }
  return value;
}

export function evidenceRows(report) {
  if(report?.schemaVersion!==1||report.method!=='HISTORICAL_TWO_INPUT_EVIDENCE_COVERAGE'||!Array.isArray(report.entries)||report.entries.length>4096)throw Error('不支持的系统对照报告结构');
  const rows=[];
  if(report.configurationCoverage&&(!Array.isArray(report.configurationCoverage.items)||report.configurationCoverage.items.length>64))throw Error('配置目录结构无效');
  report.entries.forEach((entry,i)=>{
    if(typeof entry.path!=='string'||!Array.isArray(entry.fields)||entry.fields.length>48)throw Error('报告字段超出已支持范围');
    entry.fields.forEach((field,j)=>rows.push({...field,path:entry.path,reportPointer:'/entries/'+i+'/fields/'+j}));
  });return rows;
}

export async function readEvidenceBytes(stream,expected){
  if(!Number.isSafeInteger(expected)||expected<1||expected>8*1024*1024)throw Error('证据长度无效');
  const reader=new Response(stream).body.getReader(),chunks=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>expected)throw Error('证据实际长度超出声明');chunks.push(value);}if(size!==expected)throw Error('证据实际长度与声明不符');}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}

export function evidenceInputLink(report,side,field,files,group) {
  const input=report.inputs?.[side],point=field?.[side]?.pointer;
  if(!input||typeof point!=='string'||!point||typeof input.manifestPointer!=='string')return null;
  const matches=files.filter(f=>f.state==='ready'&&f.evidence?.diagnostic_id===group&&f.evidence?.role===side&&f.sha256===input.sha256&&f.size===input.bytes);
  if(matches.length!==1)return null;
  return {id:matches[0].id,sha256:input.sha256,pointer:input.manifestPointer+point};
}

export const evidenceDataSource='window.ElfEvidenceData={parse:'+parseEvidenceJson.toString()+',pointer:'+resolveEvidencePointer.toString()+',rows:'+evidenceRows.toString()+',inputLink:'+evidenceInputLink.toString()+'};';

// MediaRecorder输出的WebM通常没有Duration；只修正首段Info，不重新编码媒体。
function element(bytes,at){
  const start=at;let width=1,mask=128;
  while(width<=4&&!(bytes[at]&mask)){mask>>=1;width++;}if(width>4||at+width>=bytes.length)throw Error('WebM元素编号无效：偏移'+at+'，首段长度'+bytes.length);
  let id=0;for(let i=0;i<width;i++)id=id*256+bytes[at++];
  const sizeAt=at;mask=128;width=1;while(width<=8&&!(bytes[at]&mask)){mask>>=1;width++;}if(width>8||at+width>bytes.length)throw Error('WebM元素长度无效');
  let size=bytes[at++]&(mask-1),unknown=size===mask-1;
  for(let i=1;i<width;i++){unknown=unknown&&bytes[at]===255;size=size*256+bytes[at++];}
  return {id,start,sizeAt,width,data:at,size,unknown,end:at+size};
}
function sizeBytes(size,width){
  if(!Number.isSafeInteger(size)||size<0||size>=2**(7*width)-1)throw Error('WebM长度超出原编码范围');
  const out=new Uint8Array(width);for(let i=width-1;i>=0;i--){out[i]=size%256;size=Math.floor(size/256);}out[0]|=1<<(8-width);return out;
}
export function webmDuration(input,durationMs){
  if(!Number.isFinite(durationMs)||durationMs<=0||durationMs>1800000)throw Error('录制时长无效');
  const bytes=new Uint8Array(input);let at=0,segment;
  while(at<bytes.length){const e=element(bytes,at);if(e.id===0x18538067){segment=e;break;}if(e.unknown||e.end<=at)throw Error('WebM段结构无效');at=e.end;}
  if(!segment)throw Error('WebM段缺失');at=segment.data;let info;
  while(at<bytes.length){const e=element(bytes,at);if(e.id===0x1549a966){info=e;break;}if(e.unknown||e.end<=at||e.id===0x1f43b675)throw Error('WebM信息段缺失');at=e.end;}
  if(!info||info.unknown||info.end>bytes.length)throw Error('WebM首段不完整');
  let scale=1000000,existing;at=info.data;
  while(at<info.end){const e=element(bytes,at);if(e.unknown||e.end>info.end||e.end<=at)throw Error('WebM信息无效');if(e.id===0x2ad7b1){scale=0;for(let i=e.data;i<e.end;i++)scale=scale*256+bytes[i];}if(e.id===0x4489)existing=e;at=e.end;}
  if(!scale||!Number.isFinite(scale))throw Error('WebM时间刻度无效');const duration=durationMs*1000000/scale;
  if(existing){const out=bytes.slice(),view=new DataView(out.buffer);if(existing.size===8)view.setFloat64(existing.data,duration);else if(existing.size===4)view.setFloat32(existing.data,duration);else throw Error('WebM时长字段无效');return out;}
  const field=new Uint8Array(11);field.set([0x44,0x89,0x88]);new DataView(field.buffer).setFloat64(3,duration);
  const out=new Uint8Array(bytes.length+field.length);out.set(bytes.subarray(0,info.end));out.set(field,info.end);out.set(bytes.subarray(info.end),info.end+field.length);
  out.set(sizeBytes(info.size+field.length,info.width),info.sizeAt);
  if(!segment.unknown)out.set(sizeBytes(segment.size+field.length,segment.width),segment.sizeAt);
  return out;
}

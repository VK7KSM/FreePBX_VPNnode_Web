import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {gunzipSync} from 'node:zlib';

const module=await WebAssembly.compile(fs.readFileSync(new URL('./vendor/webrtcaec3/webrtcaec3-0.3.0-elf1.wasm',import.meta.url)));
let Processor;
vm.runInNewContext(fs.readFileSync(new URL('./vendor/webrtcaec3/webrtcaec3-0.3.0-elf1.js',import.meta.url),'utf8')+'\n'+fs.readFileSync(new URL('./ptt-aec-worklet.js',import.meta.url),'utf8'),{
 WebAssembly,console,AudioWorkletProcessor:class{constructor(){this.messages=[];this.port={postMessage:m=>this.messages.push(m)};}},
 registerProcessor(name,klass){assert.equal(name,'elf-ptt-aec3');Processor=klass;}
});
async function processor(){const p=new Processor({processorOptions:{module}});await new Promise(r=>setImmediate(r));assert.equal(p.messages[0]?.type,'ready');return p;}
function mode(p,value){p.port.onmessage({data:{type:'mode',mode:value}});}
function close(p){p.port.onmessage({data:{type:'close'}});}

test('音频线程在待命和停止时不输出声音，重启不回放旧声音，断开释放实例',async()=>{
 const p=await processor(),input=new Float32Array(128).fill(.08),output=new Float32Array(128);
 try{
  for(let i=0;i<20;i++)p.process([[input]],[[output]]);
  assert.ok(output.every(v=>v===0));
  mode(p,'ptt');let energy=0;
  for(let i=0;i<200;i++){p.process([[input]],[[output]]);energy+=output.reduce((n,v)=>n+v*v,0);}
  assert.ok(energy>0);
  mode(p,'idle');p.process([[input]],[[output]]);assert.ok(output.every(v=>v===0));
  mode(p,'ptt');input.fill(0);
  for(let i=0;i<200;i++){p.process([[input]],[[output]]);assert.ok(output.every(v=>Math.abs(v)<1e-7));}
 }finally{close(p);}
 assert.equal(p.aec,null);assert.equal(p.process([[input]],[[output]]),false);
});

function speech(){
 // 固定的电脑合成语音，没有采集真人音频。先解析WAV，再线性重采样到处理采样率。
 const wav=gunzipSync(fs.readFileSync(new URL('./test-fixtures/ptt-speech.wav.gz',import.meta.url)));let data,rate;
 for(let at=12;at+8<=wav.length;){const bytes=wav.readUInt32LE(at+4),kind=wav.toString('ascii',at,at+4);if(kind==='fmt ')rate=wav.readUInt32LE(at+12);if(kind==='data')data=wav.subarray(at+8,at+8+bytes);at+=8+bytes+(bytes%2);}
 const signal=new Float32Array(48000*27);
 for(let i=48000;i<signal.length;i++){const position=(i-48000)*rate/48000,j=Math.floor(position),fraction=position-j;if(j+1>=data.length/2)break;signal[i]=.4*((1-fraction)*data.readInt16LE(j*2)+fraction*data.readInt16LE((j+1)*2))/32768;}
 return signal;
}
const clean=speech();
function measure(signal,filtered,shift){let error=0,energy=0,cross=0,outEnergy=0,tail=0;
 for(let i=48000*4;i<signal.length-48000*6;i++){const x=signal[i],y=filtered[i+shift];error+=(x-y)**2;energy+=x*x;cross+=x*y;outEnergy+=y*y;}
 for(let i=signal.length-96000;i<signal.length;i++)tail+=filtered[i]**2;
 return {snr:10*Math.log10(energy/error),correlation:cross/Math.sqrt(energy*outEnergy),voiceGain:cross/energy,tailRms:Math.sqrt(tail/96000)};
}
async function loop(delayMs,gain,enabled){
 const p=enabled?await processor():null;if(p)mode(p,'ptt');
 const history=new Float32Array(clean.length),input=new Float32Array(128),output=new Float32Array(128),delay=delayMs*48;
 try{for(let i=0;i<history.length;i+=128){for(let j=0;j<128;j++){const at=i+j;input[j]=Math.max(-1,Math.min(1,(clean[at]||0)+gain*(history[at-delay]||0)+gain*.2*(history[at-delay-192]||0)));}
   if(p)p.process([[input]],[[output]]);else output.set(input);
   history.set(output.subarray(0,Math.min(128,history.length-i)),i);
  }return measure(clean,history,p?912:0);
 }finally{if(p)close(p);}
}
test('没有声学反馈时仍保留正常讲话，处理管线只增加19毫秒固定帧延迟',async()=>{
 const r=await loop(180,0,true);
 assert.ok(r.correlation>.90,JSON.stringify(r));assert.ok(r.voiceGain>.8,JSON.stringify(r));assert.ok(r.tailRms<1e-6,JSON.stringify(r));
});
for(const delay of [80,180,400,800])test(`闭环语音：${delay}毫秒反馈、增益2和第二条反射，消除持续失控且保留讲话`,async t=>{
 const original=await loop(delay,2,false),fixed=await loop(delay,2,true);t.diagnostic(JSON.stringify({delay,original,fixed}));
 assert.ok(original.tailRms>.05,'对照必须确实产生反馈，不能用原本安静的样本通过测试');
 assert.ok(fixed.correlation>.75,JSON.stringify(fixed));assert.ok(fixed.voiceGain>.6,JSON.stringify(fixed));
 assert.ok(fixed.tailRms<original.tailRms/50,JSON.stringify(fixed));assert.ok(fixed.tailRms<.005,JSON.stringify(fixed));
});

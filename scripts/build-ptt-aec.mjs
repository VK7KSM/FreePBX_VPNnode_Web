import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
const [sourceArg,compilerArg,outputArg]=process.argv.slice(2);
if(!sourceArg||!compilerArg||!outputArg)throw Error('需要上游源码目录、emcc.py路径和新的输出目录');
const source=path.resolve(sourceArg),compiler=path.resolve(compilerArg),output=path.resolve(outputArg);
for(const [directory,commit] of [[source,'e1d663e86f2ab03269b9ae873af38d0103c4df3d'],[path.join(source,'webrtc'),'bbc840f60818516a42e5ea6781a90d20c27afd8b'],[path.join(source,'abseil-cpp'),'fb3621f4f897824c0dbe0615fa94543df6192f30']]){
 if(execFileSync('git',['-C',directory,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==commit)throw Error('上游源码版本不符：'+directory);
 if(execFileSync('git',['-C',directory,'diff','--name-only'],{encoding:'utf8'}).trim())throw Error('上游源码存在未提交修改：'+directory);
}
await fs.mkdir(output,{recursive:false});
const bindings=(await fs.readFile(path.join(source,'bindings.cc'),'utf8')).replace('webrtc::EchoCanceller3Config config;','webrtc::EchoCanceller3Config config;\n            config.delay.num_filters = 20;');
if(!bindings.includes('config.delay.num_filters = 20;'))throw Error('上游配置入口不符');
await fs.writeFile(path.join(output,'bindings.cc'),bindings);
const make=await fs.readFile(path.join(source,'Makefile'),'utf8');
const files=[...make.match(/SRC=\\\r?\n([\s\S]*?)\r?\n\r?\nSRCCCO/)[1].matchAll(/(?:webrtc\/[^\s\\]+|bindings\.cc)/g)].map(m=>m[0]);
const flags=['-Oz','-I'+source,'-I'+path.join(source,'abseil-cpp'),'-I'+path.join(source,'webrtc'),'-I'+path.join(source,'webrtc/rtc_base'),'-DNDEBUG','-DWEBRTC_POSIX','-DRTC_DISABLE_LOGGING','-DWEBRTC_APM_DEBUG_DUMP=0','-DLAST_SYSTEM_ERROR=errno'];
function run(args){return new Promise((resolve,reject)=>{const p=spawn(process.env.PYTHON||'python',[compiler,...args],{cwd:source,windowsHide:true,stdio:'inherit'});p.on('error',reject);p.on('exit',code=>code?reject(Error('编译失败，退出码 '+code)):resolve());});}
const queue=files.slice(),object=f=>path.join(output,f.replaceAll('/','_')+'.o');
await Promise.all(Array.from({length:4},async()=>{while(queue.length){const f=queue.shift();await run([...flags,...(f.endsWith('.cc')?['-std=c++17']:[]),'-c',path.join(f==='bindings.cc'?output:source,f),'-o',object(f)]);}}));
const args=[...flags,...files.map(object),'--pre-js','pre.js','--post-js','post.js','-sWASM=1','-sMODULARIZE=1','-sEXPORT_NAME=WebRtcAec3','-sEXPORTED_FUNCTIONS=@exports.json','-sEXPORTED_RUNTIME_METHODS=["cwrap"]','-o',path.join(output,'webrtcaec3-0.3.0-elf1.js')];
const response=path.join(output,'link.rsp');await fs.writeFile(response,args.map(a=>JSON.stringify(a)).join('\n'));await run(['@'+response]);
console.log('PTT消回声制品已生成，尚未替换发行文件');

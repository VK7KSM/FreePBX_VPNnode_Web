import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
// 远程桌面网页端连同固定版本的 Tango 库一起打包；上游版本见 package.json（@yume-chan/scrcpy 2.3.0 = scrcpy 服务端 3.3.3）。
export async function buildDesktopClient(check=false){
  const pkg=JSON.parse(fs.readFileSync(root+'package.json','utf8'));
  const pinned=['@yume-chan/scrcpy','@yume-chan/scrcpy-decoder-webcodecs','@yume-chan/stream-extra'].map(n=>n+'@'+pkg.dependencies[n]).join(',');
  const digest=createHash('sha256').update(pinned+'\n'+fs.readFileSync(root+'desktop-client.js','utf8').replace(/\r\n/g,'\n')).digest('hex');
  const header='// 源码摘要 '+digest+'\n',dest=root+'desktop-client-source.js';
  if(check){
    const actual=fs.existsSync(dest)?fs.readFileSync(dest,'utf8').replace(/\r\n/g,'\n'):'';
    if(!actual.startsWith(header))throw Error('远程桌面嵌入文件不同步，请运行 node build-desktop-client.mjs');
    return;
  }
  const {build}=await import('esbuild');
  const result=await build({entryPoints:[root+'desktop-client.js'],bundle:true,format:'iife',platform:'browser',target:'es2022',write:false,minify:true,legalComments:'none'});
  fs.writeFileSync(dest,header+'export default '+JSON.stringify(result.outputFiles[0].text)+';\n');
  console.log('已生成远程桌面嵌入文件',result.outputFiles[0].text.length);
}
if(process.argv[1]===fileURLToPath(import.meta.url))await buildDesktopClient(process.argv.includes('--check'));

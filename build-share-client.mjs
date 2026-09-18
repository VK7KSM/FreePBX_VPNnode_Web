import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
// 分享管理弹窗连同 qrcode-generator（MIT）打包；二维码本地生成，不经第三方服务。
export async function buildShareClient(check=false){
  const pkg=JSON.parse(fs.readFileSync(root+'package.json','utf8'));
  const digest=createHash('sha256').update('qrcode-generator@'+pkg.dependencies['qrcode-generator']+'\n'+fs.readFileSync(root+'share-client.js','utf8').replace(/\r\n/g,'\n')).digest('hex');
  const header='// 源码摘要 '+digest+'\n',dest=root+'share-client-source.js';
  if(check){
    const actual=fs.existsSync(dest)?fs.readFileSync(dest,'utf8').replace(/\r\n/g,'\n'):'';
    if(!actual.startsWith(header))throw Error('分享管理嵌入文件不同步，请运行 node build-share-client.mjs');
    return;
  }
  const {build}=await import('esbuild');
  const result=await build({entryPoints:[root+'share-client.js'],bundle:true,format:'iife',platform:'browser',target:'es2022',write:false,minify:true,legalComments:'none'});
  fs.writeFileSync(dest,header+'export default '+JSON.stringify(result.outputFiles[0].text)+';\n');
  console.log('已生成分享管理嵌入文件',result.outputFiles[0].text.length);
}
if(process.argv[1]===fileURLToPath(import.meta.url))await buildShareClient(process.argv.includes('--check'));

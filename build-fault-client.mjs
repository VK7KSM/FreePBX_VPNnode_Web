import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
export async function buildFaultClient(check=false){
  const files=['fault-client.js','fault-contract.js','fault-package.js','build-fault-client.mjs'];
  const digest=createHash('sha256').update(files.map(name=>name+'\n'+fs.readFileSync(root+name,'utf8').replace(/\r\n/g,'\n')).join('\n')).digest('hex');
  const header='// 源码摘要 '+digest+'\n',dest=root+'fault-client-source.js';
  if(check){if(!fs.existsSync(dest)||!fs.readFileSync(dest,'utf8').startsWith(header))throw Error('故障页面嵌入文件不同步');return;}
  const {build}=await import('esbuild');
  const result=await build({entryPoints:[root+'fault-client.js'],bundle:true,format:'iife',platform:'browser',target:'es2022',write:false,minify:false,legalComments:'none'});
  fs.writeFileSync(dest,header+'export default '+JSON.stringify(result.outputFiles[0].text)+';\n');
}
if(process.argv[1]===fileURLToPath(import.meta.url))await buildFaultClient(process.argv.includes('--check'));

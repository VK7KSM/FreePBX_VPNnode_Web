import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';
import worker from './worker.js';
export const STATIC_ROUTES={'/':'index.html','/devices':'devices.html','/sip':'sip.html','/admin-session.js':'admin-session.js','/devices-client.js':'devices-client.js','/media-client.js':'media-client.js','/file-hash.js':'file-hash.js','/terminal.js':'terminal.js','/terminal.css':'terminal.css','/logo.png':'logo.png'};
export async function buildAssets(directory='.generated-assets'){
 await fs.mkdir(directory,{recursive:true});const files=[];
 for(const [route,file] of Object.entries(STATIC_ROUTES)){
  const response=await worker.fetch(new Request('https://assets-build.invalid'+route),{});
  if(!response.ok)throw Error('静态页面生成失败 '+route);
  const body=Buffer.from(await response.arrayBuffer());await fs.writeFile(path.join(directory,file),body);files.push({file,bytes:body.length});
 }
 await fs.writeFile(path.join(directory,'_headers'),'/*\n  Cache-Control: no-cache\n  X-Content-Type-Options: nosniff\n');
 return files;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(await buildAssets()));

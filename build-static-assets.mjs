import fs from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';
import worker from './worker.js';
import {createHash} from 'node:crypto';
export const STATIC_ROUTES={'/':'index.html','/devices':'devices.html','/sip':'sip.html','/panel-events.js':'panel-events.js','/panel-lifecycle.js':'panel-lifecycle.js','/cf-usage.js':'cf-usage.js','/admin-session.js':'admin-session.js','/devices-client.js':'devices-client.js','/media-client.js':'media-client.js','/fault-client.js':'fault-client.js','/file-hash.js':'file-hash.js','/terminal.js':'terminal.js','/terminal.css':'terminal.css','/logo.png':'logo.png','/favicon.ico':'favicon.ico'};
export async function buildAssets(directory='.generated-assets'){
 await fs.mkdir(directory,{recursive:true});const files=[];
 for(const [route,file] of Object.entries(STATIC_ROUTES)){
  const response=await worker.fetch(new Request('https://assets-build.invalid'+route),{});
  if(!response.ok)throw Error('静态页面生成失败 '+route);
  const body=Buffer.from(await response.arrayBuffer());await fs.writeFile(path.join(directory,file),body);files.push({file,bytes:body.length});
 }
 const hash=createHash('sha256');for(const item of files)hash.update(await fs.readFile(path.join(directory,item.file)));
 const version=hash.digest('hex').slice(0,20);
 for(const item of files.filter(item=>item.file.endsWith('.html'))){const target=path.join(directory,item.file);await fs.writeFile(target,(await fs.readFile(target,'utf8')).replaceAll('__ELF_PANEL_VERSION__',version));}
 await fs.writeFile(path.join(directory,'panel-version.json'),JSON.stringify({version}));
 await fs.writeFile(path.join(directory,'_headers'),'/*\n  Cache-Control: no-cache\n  X-Content-Type-Options: nosniff\n');
 return files;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)console.log(JSON.stringify(await buildAssets()));

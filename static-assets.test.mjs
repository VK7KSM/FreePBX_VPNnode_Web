import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import worker from './worker.js';import {buildAssets,STATIC_ROUTES} from './build-static-assets.mjs';
import faultClientSource from './fault-client-source.js';
test('静态托管保持三页和脚本原内容，API和订阅仍交给Worker处理',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'elf-assets-'));
 try{
  const files=await buildAssets(dir);assert.equal(files.length,13);
  assert.equal(await fs.readFile(path.join(dir,'fault-client.js'),'utf8'),faultClientSource);
  for(const [route,file] of Object.entries(STATIC_ROUTES)){
   const body=await fs.readFile(path.join(dir,file));assert.deepEqual(body,Buffer.from(await (await worker.fetch(new Request('https://example.test'+route),{})).arrayBuffer()));
   if(file.endsWith('.html'))for(const match of body.toString().matchAll(/(?:src|href)="(\/[^"#?]+\.(?:js|css|png))"/g))assert.ok(STATIC_ROUTES[match[1]],'本地资源必须静态托管 '+match[1]);
  }
  const config=JSON.parse(await fs.readFile('wrangler.jsonc','utf8'));
  assert.deepEqual(config.assets.run_worker_first,['/api/*','/sub*']);assert.equal(config.assets.html_handling,'drop-trailing-slash');
  assert.ok(!Object.keys(STATIC_ROUTES).some(route=>route.startsWith('/api/')||route.startsWith('/sub')));
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

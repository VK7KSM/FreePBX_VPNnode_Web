import {build} from 'esbuild';
import fs from 'node:fs';
const result=await build({stdin:{contents:"export {sha256} from '@noble/hashes/sha256';",resolveDir:process.cwd()},bundle:true,format:'esm',minify:true,write:false});
fs.writeFileSync('file-hash-source.js','// 由 build-file-hash.mjs 生成；增量SHA-256，避免把整个大文件读入内存。\nexport default '+JSON.stringify(result.outputFiles[0].text)+';\n');

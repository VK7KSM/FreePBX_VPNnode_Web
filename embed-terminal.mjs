import fs from 'node:fs';
const files=['node_modules/@xterm/xterm/lib/xterm.js','node_modules/@xterm/addon-fit/lib/addon-fit.js'];
const licenses=['node_modules/@xterm/xterm/LICENSE','node_modules/@xterm/addon-fit/LICENSE'].map(p=>fs.readFileSync(p,'utf8')).join('\n');
const script='/*\n'+licenses+'\n*/\n'+files.map(p=>fs.readFileSync(p,'utf8').replace(/^\/\/# sourceMappingURL=.*$/gm,'')).join('\n;\n');
const css=fs.readFileSync('node_modules/@xterm/xterm/css/xterm.css','utf8');
fs.writeFileSync('terminal-assets.js','// 从固定版本xterm资源生成，运行node embed-terminal.mjs更新。\nexport const terminalScript='+JSON.stringify(script)+';\nexport const terminalCss='+JSON.stringify(css)+';\n');
console.log('终端资源已生成');

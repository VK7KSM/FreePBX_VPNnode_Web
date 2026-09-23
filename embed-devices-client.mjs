import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {buildFaultClient} from './build-fault-client.mjs';
import {buildDesktopClient} from './build-desktop-client.mjs';
import {buildShareClient} from './build-share-client.mjs';
import {systemSettingAllowed} from './system-settings.js';
import {contactsPagesClientSource} from './contacts-pages.js';

const root = path.dirname(fileURLToPath(import.meta.url));
await buildFaultClient(process.argv.includes('--check'));
await buildDesktopClient(process.argv.includes('--check'));
await buildShareClient(process.argv.includes('--check'));
// MCP 说明文档一份内容三处用：弹窗里的链接、MCP 的 resource、仓库里的源文件。
// 嵌进 Worker 才能在这三处都拿到同一份，不会出现两种说法打架。
{
  const guide = fs.readFileSync(path.join(root, "mcp-guide.md"), "utf8").replace(/\r\n/g, "\n");
  const dest = path.join(root, "mcp-guide-source.js");
  const output = "export default " + JSON.stringify(guide) + ";\n";
  if (process.argv.includes("--check")) {
    const actual = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8").replace(/\r\n/g, "\n") : "";
    if (actual !== output) { console.error("mcp-guide 嵌入文件不同步，请运行 npm run embed:devices-client"); process.exitCode = 1; }
  } else { fs.writeFileSync(dest, output); console.log("已生成网页嵌入文件", "mcp-guide", guide.length); }
}
for (const name of ["devices-client", "sip-client", "media-client"]) {
const src = ((name==='devices-client'?systemSettingAllowed.toString()+'\n'+contactsPagesClientSource:'')+fs.readFileSync(path.join(root, name + ".js"), "utf8")).replace(/\r\n/g, "\n");
const dest = path.join(root, name + "-source.js");
const output = "export default " + JSON.stringify(src) + ";\n";
if (process.argv.includes("--check")) {
  const actual = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8").replace(/\r\n/g, "\n") : "";
  if (actual !== output) {
    console.error(name + " 嵌入文件不同步，请运行 npm run embed:devices-client");
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(dest, output);
  console.log("已生成网页嵌入文件", name, src.length);
}
}

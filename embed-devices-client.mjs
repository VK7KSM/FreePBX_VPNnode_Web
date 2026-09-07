import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
for (const name of ["devices-client", "sip-client"]) {
const src = fs.readFileSync(path.join(root, name + ".js"), "utf8").replace(/\r\n/g, "\n");
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

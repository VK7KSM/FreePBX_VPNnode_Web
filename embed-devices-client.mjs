import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(root, "devices-client.js"), "utf8");
const dest = path.join(root, "devices-client-source.js");
fs.writeFileSync(dest, "export default " + JSON.stringify(src) + ";\n");
console.log("wrote", dest, src.length, "chars");

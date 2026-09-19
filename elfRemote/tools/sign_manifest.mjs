import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const privPath = path.join(root, "update-keys", "private.pem");
const priv = fs.readFileSync(privPath, "utf8");
const raw = fs.readFileSync(process.argv[2], "utf8").replace(/\r\n/g, "\n").trim();
JSON.parse(raw);
const sig = crypto.sign("sha256", Buffer.from(raw, "utf8"), priv).toString("hex");
process.stdout.write(JSON.stringify({ manifest_raw: raw, signature: sig }));

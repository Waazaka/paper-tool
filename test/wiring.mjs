// Diagnostic: every RPC method the client calls must exist on the Host service
// and be marked Remote, otherwise the call fails at runtime in the sidebar.
import { readFileSync } from "node:fs";

const client = readFileSync("client.js", "utf8");
const host = readFileSync("lib/host-service.js", "utf8");

const called = [...new Set([...client.matchAll(/callRemote\(\s*sessionId,\s*"(\w+)"/g)].map((m) => m[1]))].sort();
const defined = [...host.matchAll(/^  async (\w+)\(/gm)].map((m) => m[1]);
const marked = [...host.matchAll(/^  "(\w+)",$/gm)].map((m) => m[1]);

console.log("client calls  :", called.join(", "));
const missingDef = called.filter((name) => !defined.includes(name));
const missingRemote = called.filter((name) => !marked.includes(name));
console.log("missing method:", missingDef.length === 0 ? "none" : missingDef.join(", "));
console.log("missing @Remote:", missingRemote.length === 0 ? "none" : missingRemote.join(", "));
process.exit(missingDef.length + missingRemote.length === 0 ? 0 : 1);

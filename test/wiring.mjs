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

// Feature wiring that a refactor could silently drop. These strings are the
// contract between the usable UI and the Host methods added for it.
const features = [
  ["PDF text layer", /new pdfjs\.TextLayer\(/],
  ["library list on mount", /"listPapers"/],
  ["metadata editing", /"updatePaper"/],
  ["evidence deletion", /"deleteEvidence"/],
  ["matrix UI", /"reviewMatrix"/],
  ["citation UI", /"formatCitations"/],
  ["export UI", /"exportReview"/],
  ["chat insertion", /captureInsertion\(\)/],
];
const missingFeatures = features
  .filter(([, pattern]) => !pattern.test(client))
  .map(([label]) => label);
console.log("missing feature:", missingFeatures.length === 0 ? "none" : missingFeatures.join(", "));
process.exit(missingDef.length + missingRemote.length + missingFeatures.length === 0 ? 0 : 1);

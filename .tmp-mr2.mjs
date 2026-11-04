import fs from "node:fs";
const host = fs.readFileSync("lib/host-service.js", "utf8");
// How is the args descriptor declared for each remote method?
const i = host.indexOf("markRemote");
console.log("--- markRemote definition / import ---");
const lines = host.split("\n");
lines.forEach((l, n) => { if (/markRemote/.test(l) && n < 60) console.log((n+1) + ": " + l.trim()); });
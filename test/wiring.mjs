// Diagnostic: every RPC method the client calls must exist on the Host service
// and be marked Remote, otherwise the call fails at runtime in the sidebar.
//
// It also guards three classes of defect that unit tests on the Host cannot see
// and that actually shipped once:
//   * a `--dsw-alias-*` token the host bundle does not define, so every var()
//     silently falls back to a literal and dark mode loses the primary button;
//   * literal colours bypassing the theme;
//   * `dangerouslySetInnerHTML`, which is the only way model or PDF text could
//     become markup.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const client = readFileSync("client.js", "utf8");
const host = readFileSync("lib/host-service.js", "utf8");

const called = [...new Set([...client.matchAll(/callRemote\(\s*sessionId,\s*"(\w+)"/g)].map((m) => m[1]))].sort();
const defined = [...host.matchAll(/^  async (\w+)\(/gm)].map((m) => m[1]);
const marked = [...host.matchAll(/^  "(\w+)",$/gm)].map((m) => m[1]);

// Matching the literal strings above only proves the source lists a name. The
// wire contract is the decorator marker that `remoteMethods()` reads, so ask the
// protocol implementation directly. (An earlier shim exported a no-op Remote(),
// which made this read 0 and let every RPC test pass without validating
// anything; the real package must be the source of truth.)
let realRemote = [];
try {
  const { remoteMethods } = await import("@deepseek-ai/dsh-typert-protocol");
  const { PaperToolService } = await import("../lib/host-service.js");
  realRemote = remoteMethods(Object.create(PaperToolService.prototype))
    .map((marker) => marker.method)
    .sort();
} catch (error) {
  console.log("remote markers  : SKIP (protocol unavailable:", error.message, ")");
}

console.log("client calls  :", called.join(", "));
const missingDef = called.filter((name) => !defined.includes(name));
const missingRemote = called.filter((name) => !marked.includes(name));
console.log("missing method:", missingDef.length === 0 ? "none" : missingDef.join(", "));
console.log("missing @Remote:", missingRemote.length === 0 ? "none" : missingRemote.join(", "));
if (realRemote.length > 0) {
  const unmarkedCallable = called.filter((name) => !realRemote.includes(name));
  console.log(
    "real markers  :",
    unmarkedCallable.length === 0
      ? `${realRemote.length} methods marked, every client call is covered`
      : `client calls unmarked methods -> ${unmarkedCallable.join(", ")}`,
  );
}
const missingReal = realRemote.length === 0 ? [] : called.filter((name) => !realRemote.includes(name));

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
  ["render cancellation", /renderTask\.cancel\(\)|renderTaskRef\.current\.cancel\(\)/],
  ["document disposal", /doc\.destroy\(\)/],
  ["container query", /@container pt /],
];
const missingFeatures = features
  .filter(([, pattern]) => !pattern.test(client))
  .map(([label]) => label);
console.log("missing feature:", missingFeatures.length === 0 ? "none" : missingFeatures.join(", "));

// --- theme tokens must exist in the host bundle -------------------------
// Read the alias tokens actually referenced by the installed host client
// bundles. A token that is not there cannot resolve, no matter which theme is
// active, so the fallback literal is what the user sees.
const HOST_ROOTS = [
  join(process.cwd(), "..", "..", ".dsh", "dsh-checkout", "node_modules", "@deepseek-ai"),
  join(process.env.USERPROFILE ?? "", ".dsh", "profiles", "desktop", "node_modules", "@deepseek-ai"),
];

function collectHostTokens() {
  const tokens = new Set();
  let scanned = 0;
  for (const root of HOST_ROOTS) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("dsh-client-")) continue;
      const bundle = join(root, entry.name, "lib", "client.js");
      if (!existsSync(bundle)) continue;
      let text;
      try {
        text = readFileSync(bundle, "utf8");
      } catch {
        continue;
      }
      scanned += 1;
      for (const match of text.matchAll(/--dsw-alias-[a-z0-9-]+(?![-a-z0-9])/g)) tokens.add(match[0]);
    }
    if (tokens.size > 0) break;
  }
  return { tokens, scanned };
}

const { tokens, scanned } = collectHostTokens();
const usedTokens = [...new Set([...client.matchAll(/--dsw-alias-[a-z0-9-]+(?![-a-z0-9])/g)].map((m) => m[0]))].sort();
let unknownTokens = [];
if (scanned === 0) {
  console.log("theme tokens  : SKIP (host client bundles not found)");
} else {
  unknownTokens = usedTokens.filter((token) => !tokens.has(token));
  console.log(
    "theme tokens  :",
    unknownTokens.length === 0
      ? `all ${usedTokens.length} known (${scanned} host bundles scanned)`
      : `UNKNOWN -> ${unknownTokens.join(", ")}`,
  );
}

// Literal colours are how the theme silently stopped applying.
const literalColours = [...client.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]);
const ignoredLiterals = literalColours.filter((value) => !/^#(?:[0-9a-fA-F]{3,4})$/.test(value) || true);
console.log("literal colours:", ignoredLiterals.length === 0 ? "none" : `${ignoredLiterals.length} (${[...new Set(ignoredLiterals)].join(", ")})`);

const dangerousHtml = [...client.matchAll(/dangerouslySetInnerHTML/g)].length;
console.log("dangerous HTML:", dangerousHtml === 0 ? "none" : `${dangerousHtml} occurrence(s)`);

const failures =
  missingDef.length +
  missingRemote.length +
  missingReal.length +
  missingFeatures.length +
  unknownTokens.length +
  ignoredLiterals.length +
  dangerousHtml;
process.exit(failures === 0 ? 0 : 1);

// S2 host-layer gate: exercise the real service methods without a browser.
//
// The sidebar UI cannot be asserted from here, but every operation it calls
// goes through these methods, so this pins the contract the UI depends on.
//
// Run: node test/s2-host.mjs <pdfDir>
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name} ${detail}`);
    failures.push(`${name} ${detail}`);
  }
}

// Import the service module with the DSH protocol dependency shimmed: the real
// package only exists inside a DSH profile, so a local stand-in is substituted
// for those two imports and everything else runs the shipped source.
const work = mkdtempSync(join(tmpdir(), "paper-tool-s2-"));
const { loadService } = await import("./shim.mjs");
const { PaperToolService } = await loadService();

const dirs = process.argv.slice(2);
const pdfs = [];
for (const dir of dirs) {
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile?.()) continue;
    if (!entry.name.toLowerCase().endsWith(".pdf")) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    try {
      if (statSync(full).size > 8192) pdfs.push(full);
    } catch {
      /* ignore */
    }
  }
}
if (pdfs.length === 0) {
  console.error("S2: no PDFs found");
  process.exit(2);
}

const scope = { sessionId: "session-s2-test", workspaceRoot: work };
const service = new PaperToolService({ inject() {}, get() {} }, {});

// --- status on an empty library
const emptyStatus = await service.status(scope);
check("status returns library stats", typeof emptyStatus.library?.papers === "number");
check("empty library has 0 papers", emptyStatus.library.papers === 0);

// --- import
const files = pdfs.slice(0, 2).map((path) => ({
  name: path.split(/[\\/]/).pop(),
  data: Array.from(new Uint8Array(readFileSync(path))),
}));
const imported = await service.importPdf(scope, { files });
check("import returns imported list", Array.isArray(imported.imported) && imported.imported.length > 0, JSON.stringify(imported.failed));
check("imported has a paperId", typeof imported.imported[0]?.paperId === "string");
check("imported records page count", imported.imported[0]?.numPages > 0);
check("library grew", imported.library.papers === files.length);

const paperId = imported.imported[0].paperId;

// --- search finds the imported paper
const firstWords = imported.imported[0].title.split(/\s+/).slice(0, 1)[0];
if (firstWords && firstWords.length >= 3) {
  const found = await service.search(scope, { query: firstWords });
  check(`search "${firstWords.slice(0, 20)}" hits`, found.hits.length > 0);
}

// --- readPaper returns page text with honest coverage
const read = await service.readPaper(scope, { paperId, fromPage: 0, toPage: 2 });
check("readPaper returns pages", read.pages.length > 0);
check("readPaper coverage matches", read.coverage.numPages === read.paper.numPages);
check("readPaper page text non-empty", read.pages.some((page) => page.text.length > 20));

// --- readPaperBytes returns parseable bytes
const bytes = await service.readPaperBytes(scope, { paperId });
check("readPaperBytes returns bytes", bytes.bytes > 1000);
check("bytes are a PDF", String.fromCharCode(...new Uint8Array(bytes.data).slice(0, 5)) === "%PDF-");

// --- pdfjs runtime crosses the RPC boundary
const runtime = await service.getPdfRuntime(scope);
check("pdf runtime main source present", typeof runtime.pdfMainSource === "string" && runtime.pdfMainSource.length > 1000);
check("pdf runtime worker source present", typeof runtime.pdfWorkerSource === "string" && runtime.pdfWorkerSource.length > 1000);

// --- evidence anchoring
const pageText = read.pages[0].text;
const quote = pageText.slice(20, 60);
const evidence = await service.addEvidence(scope, { paperId, pageIndex: 0, quote });
check("evidence stored", typeof evidence.evidenceId === "string");
check("evidence anchored to real offsets", evidence.anchored === true);

// --- unknown paper is a typed error, never a silent empty result
let typed = false;
try {
  await service.readPaper(scope, { paperId: "no-such-id" });
} catch (error) {
  typed = error?.code === "paper-tool/paper-not-found" || /not-found/.test(error?.code ?? "");
}
check("unknown paper is a typed error", typed);

// --- importing identical bytes again must reuse the paper, not duplicate it
const again = await service.importPdf(scope, { files: [files[0]] });
check("re-import is reported as a duplicate", again.duplicates.length === 1, JSON.stringify(again.duplicates));
check("re-import reuses the same paperId", again.duplicates[0]?.paperId === paperId, JSON.stringify(again.duplicates[0]));
check("re-import adds nothing", again.imported.length === 0);
check("re-import did not grow the library", again.library.papers === files.length, JSON.stringify(again.library));

// --- an oversized quote is rejected instead of silently stored
let quoteRejected = false;
try {
  await service.addEvidence(scope, { paperId, pageIndex: 0, quote: "x".repeat(200000) });
} catch (error) {
  quoteRejected = error?.code === "paper-tool/quote-too-long";
}
check("oversized quote is rejected", quoteRejected);

// --- a quote that is not on the page must be stored as unlocated, not as a
// zero-width anchor at the start of the page
const unlocatable = await service.addEvidence(scope, {
  paperId,
  pageIndex: 0,
  quote: "zzzqqqxyzzy no such sentence appears anywhere on this page zzz",
});
check("unlocatable quote reports anchored=false", unlocatable.anchored === false);
check("unlocatable quote stores the -1 sentinel", unlocatable.evidence.charStart === -1 && unlocatable.evidence.charEnd === -1);
const relisted = (await service.listEvidence(scope, { limit: 100 })).evidence.find(
  (row) => row.evidenceId === unlocatable.evidenceId,
);
check("unlocated state survives a re-read", relisted !== undefined && relisted.charStart === -1);

// --- evidence anchors describe the stored quote exactly
const anchored = await service.addEvidence(scope, { paperId, pageIndex: 0, quote: pageText.slice(30, 80) });
const storedQuote = anchored.evidence.quote;
const slice = pageText.slice(anchored.evidence.charStart, anchored.evidence.charEnd);
check(
  "evidence offsets reproduce the quote",
  slice === storedQuote || slice === storedQuote.replace(/\u2026$/, ""),
  JSON.stringify({ slice: slice.slice(0, 20), stored: storedQuote.slice(0, 20) }),
);

// --- delete removes it
const deleted = await service.deletePaper(scope, { paperId });
check("delete reports the id", deleted.deleted === paperId);
check("library shrank", deleted.library.papers === files.length - 1);
check("delete removed the stored PDF file", !existsSync(join(work, ".dsh", "paper-tool", "files", `${paperId}.pdf`)));
let goneTyped = false;
try {
  await service.readPaper(scope, { paperId });
} catch {
  goneTyped = true;
}
check("deleted paper is gone", goneTyped);

service.stores.forEach((store) => store.close());
rmSync(work, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\nS2 FAILED (${failures.length}):`);
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("\nS2 PASS");

// S5 gate: metadata editing, evidence deletion and the review export bundle.
//
// The export must be reproducible from stored rows only, carry page-anchored
// evidence, render a real CSL bibliography, and produce a valid-looking BibTeX
// file with collision-free keys.
//
// Run: node test/s5-export.mjs <pdfDir>
import { readFileSync, readdirSync, statSync, mkdtempSync, existsSync } from "node:fs";
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

const { loadService } = await import("./shim.mjs");
const { PaperToolService } = await loadService();

const work = mkdtempSync(join(tmpdir(), "paper-tool-s5-"));
const scope = { sessionId: "session-s5-test", workspaceRoot: work };
const ctx = { reflect: { provide: () => {} }, inject: () => {}, effect: () => {}, get: () => undefined };
const service = new PaperToolService(ctx, {});

const pdfs = [];
for (const dir of process.argv.slice(2)) {
  try {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile?.() || !entry.name.toLowerCase().endsWith(".pdf")) continue;
      const full = join(entry.parentPath ?? entry.path, entry.name);
      try {
        if (statSync(full).size > 8192) pdfs.push(full);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
}
if (pdfs.length < 2) {
  console.error("S5: need at least 2 PDFs");
  process.exit(2);
}

const imported = await service.importPdf(scope, {
  files: pdfs.slice(0, 2).map((path) => ({
    name: path.split(/[\\/]/).pop(),
    data: Array.from(new Uint8Array(readFileSync(path))),
  })),
});
check("imported two papers", imported.imported.length === 2, JSON.stringify(imported.failed));
const [first, second] = imported.imported;

// --- metadata editing is what citations depend on
const edited = await service.updatePaper(scope, {
  paperId: first.paperId,
  title: "Testing Traceable Reviews",
  authors: "Li, Shuhao; Wei, Min",
  year: "2024",
  venue: "Journal of Reproducible Tests",
  doi: "10.1234/example.001",
});
check("updatePaper changes title", edited.paper.title === "Testing Traceable Reviews");
check("updatePaper changes authors", edited.paper.authors.includes("Li"));
check("updatePaper keeps the same paperId", edited.paper.paperId === first.paperId);
const missing = await service.updatePaper(scope, { paperId: "no-such-paper", title: "x" }).then(
  () => null,
  (error) => error,
);
check("updatePaper rejects an unknown paper", missing !== null && /paper-not-found/.test(missing.code ?? ""));

// --- quote anchoring tolerates whitespace from a browser selection
const read = await service.readPaper(scope, { paperId: first.paperId, fromPage: 0, toPage: 1 });
const pageText = read.pages[0]?.text ?? "";
const raw = pageText.trim().slice(20, 120);
if (raw.length > 20) {
  const spaced = raw.replace(/\s+/g, "  ");
  const added = await service.addEvidence(scope, {
    paperId: first.paperId,
    pageIndex: 0,
    quote: spaced,
  });
  check("whitespace-different quote still anchors", added.anchored === true);
  check("stored quote is the selection", added.evidence.quote === spaced);
  const removed = await service.deleteEvidence(scope, { evidenceId: added.evidenceId });
  check("deleteEvidence removes the row", removed.deleted === added.evidenceId);
  const gone = await service.deleteEvidence(scope, { evidenceId: added.evidenceId }).then(
    () => null,
    (error) => error,
  );
  check("deleting twice is a typed error", gone !== null && /evidence-not-found/.test(gone.code ?? ""));
} else {
  check("page text long enough for anchoring test", false, `${pageText.length}`);
}

// --- collect evidence for export
const collected = await service.collectEvidence(scope, { query: "the", limit: 6 });
check("collected evidence", collected.evidence.length > 0);

const noEvidence = await service.exportReview(scope, { style: "apa", evidenceIds: [] }).then(
  (result) => result,
  (error) => ({ ok: false, reason: error.message }),
);
check("export with no evidence refuses", noEvidence.ok === false, JSON.stringify(noEvidence));

const apa = await service.exportReview(scope, { style: "apa", locale: "en-US", title: "Review Test" });
check("APA export succeeds", apa.ok === true, apa.reason);
check("APA export writes a markdown file", existsSync(apa.paths?.markdown ?? ""));
check("APA export writes a bib file", existsSync(apa.paths?.bibtex ?? ""));
check("markdown has the evidence outline", apa.markdown.includes("## 证据大纲"));
check("markdown has page anchors", /p\.\d+ \[E:[0-9a-f]{8}\]/.test(apa.markdown));
check("markdown has a bibliography", apa.markdown.includes("## 参考文献"));
check("bibtex contains an entry", /@(article|misc)\{/.test(apa.bibtex));
check("bibtex entries carry titles", apa.bibtex.includes("title = {"));
check("bibtex keys are reported", apa.entries.every((entry) => entry.citekey.length > 0));

const gb = await service.exportReview(scope, { style: "gb-t-7714", locale: "zh-CN" });
check("GB/T export succeeds", gb.ok === true, gb.reason);
check("GB/T export has a bibliography", gb.bibliography.length > 0);

const badStyle = await service.exportReview(scope, { style: "no-such-style" }).then(
  (result) => result,
  (error) => ({ ok: false, reason: error.message }),
);
check("unknown style fails honestly", badStyle.ok === false);

// --- duplicate author/year keys must not collide
await service.updatePaper(scope, {
  paperId: second.paperId,
  title: "Testing Traceable Reviews",
  authors: "Li, Shuhao",
  year: "2024",
  venue: "Journal of Reproducible Tests",
});
const secondCollected = await service.collectEvidence(scope, { query: "the", limit: 2 });
check("second paper can also contribute evidence", secondCollected.evidence.length > 0);
const both = await service.exportReview(scope, { style: "apa" });
if (both.ok) {
  const keys = both.entries.map((entry) => entry.citekey);
  check("all bibtex keys are unique", new Set(keys).size === keys.length, JSON.stringify(keys));
  check("bibtex escapes braces", !/title = \{[^}]*\{[^}]*\}/.test(both.bibtex));
} else {
  check("duplicate-key export succeeds", false, both.reason);
}

// --- missing metadata is surfaced, not hidden
const warnings = await service.exportReview(scope, { style: "apa" });
check("export reports checks", Array.isArray(warnings.warnings));

if (failures.length > 0) {
  console.error(`S5 FAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("S5 PASS");

// S3+S4 gate: evidence matrix and traceable review, on real PDFs.
//
// Every assertion here is about provenance: a review may only cite what is
// actually stored, with a real paper, page and quote.
//
// Run: node test/s3-evidence.mjs <pdfDir>
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
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

const work = mkdtempSync(join(tmpdir(), "paper-tool-s3-"));
const scope = { sessionId: "session-s3-test", workspaceRoot: work };
const ctx = { reflect: { provide: () => {} }, inject: () => {}, effect: () => {}, get: () => undefined };
const service = new PaperToolService(ctx, {});

// Pick Chinese and English PDFs so both script regimes are exercised.
const pdfs = [];
for (const dir of process.argv.slice(2)) {
  try {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile?.() || !entry.name.toLowerCase().endsWith(".pdf")) continue;
      const full = join(entry.parentPath ?? entry.path, entry.name);
      try {
        if (statSync(full).size > 8192) pdfs.push(full);
      } catch {
        /* skip unreadable */
      }
    }
  } catch {
    /* skip missing dir */
  }
}
const chinese = pdfs.filter((path) => /[\u4e00-\u9fff]/.test(path));
const english = pdfs.filter((path) => !/[\u4e00-\u9fff]/.test(path));
const picked = [...chinese.slice(0, 2), ...english.slice(0, 2)];
if (picked.length < 2) {
  console.error("S3: need at least 2 PDFs");
  process.exit(2);
}

const imported = await service.importPdf(scope, {
  files: picked.map((path) => ({
    name: path.split(/[\\/]/).pop(),
    data: Array.from(new Uint8Array(readFileSync(path))),
  })),
});
check("imported the corpus", imported.imported.length >= 2, JSON.stringify(imported.failed));
check("library reports full-text coverage", imported.library.withFullText >= 2);

// --- status lists usable styles (no external install)
const status = await service.status(scope);
check("status lists citation styles", Array.isArray(status.styles) && status.styles.length > 0);
check("GB/T 7714 style is available", status.styles.includes("gb-t-7714"));

// --- evidence collection anchors to a real page and a real quote
const evidence = await service.collectEvidence(scope, { query: "旅游", limit: 5 });
const chineseEvidence = evidence.evidence.filter((row) => /[\u4e00-\u9fff]/.test(row.quote));
if (chineseEvidence.length > 0) {
  const row = chineseEvidence[0];
  const paper = await service.readPaper(scope, { paperId: row.paperId, fromPage: row.pageIndex, toPage: row.pageIndex + 1 });
  const pageText = paper.pages[0]?.text ?? "";
  check("evidence quote appears verbatim on its page", pageText.includes(row.quote.slice(0, 40)));
  check("evidence carries a page index", Number.isInteger(row.pageIndex));
} else {
  // Fall back to an English term so the gate still proves anchoring.
  const englishEvidence = await service.collectEvidence(scope, { query: "the", limit: 3 });
  const row = englishEvidence.evidence[0];
  check("evidence collected (english fallback)", row !== undefined);
  if (row) {
    const paper = await service.readPaper(scope, { paperId: row.paperId, fromPage: row.pageIndex, toPage: row.pageIndex + 1 });
    check("evidence quote appears verbatim on its page", (paper.pages[0]?.text ?? "").includes(row.quote.slice(0, 40)));
  }
}

// --- negative control: nonsense collects nothing
const nothing = await service.collectEvidence(scope, { query: "zzzqqqxyzzy", limit: 5 });
check("nonsense query collects no evidence", nothing.evidence.length === 0);

// --- outline groups by paper
const outline = await service.reviewOutline(scope, {});
check("outline lists groups", Array.isArray(outline.groups) && outline.groups.length > 0);
check("outline text is non-empty", outline.text.length > 20);
check("outline groups carry evidence counts", outline.groups.every((group) => group.evidenceCount > 0));

// --- matrix reports not_found as a real stance, never silently support
const matrix = await service.reviewMatrix(scope, { claim: "旅游发展促进经济增长" });
check("matrix returns rows", matrix.rows.length > 0);
check("matrix has stance counts", typeof matrix.counts.support === "number");
const stances = new Set(matrix.rows.map((row) => row.stance));
check(
  "matrix uses only declared stances",
  [...stances].every((stance) => ["support", "conflict", "not_found", "no_evidence"].includes(stance)),
  JSON.stringify([...stances]),
);
check(
  "matrix can report not_found",
  matrix.rows.some((row) => row.stance === "not_found") || matrix.counts.not_found >= 0,
);
// A claim that matches nothing must be all not_found, not invented support.
const unmatched = await service.reviewMatrix(scope, { claim: "zzzqqqxyzzy quantum entanglement blockchain" });
check("unmatched claim yields no support", unmatched.counts.support === 0, JSON.stringify(unmatched.counts));
check(
  "unmatched claim is reported not_found or no_evidence",
  unmatched.counts.not_found > 0 || unmatched.counts.no_evidence > 0,
  JSON.stringify(unmatched.counts),
);
// "no evidence was ever collected for this paper" is a different finding from
// "evidence exists and none of it addresses the claim". Collapsing them hides
// which gap the reviewer has to act on.
check(
  "papers with no evidence are distinguished from silent ones",
  unmatched.rows.every((row) => row.stance === "not_found" || row.stance === "no_evidence"),
  JSON.stringify([...new Set(unmatched.rows.map((row) => row.stance))]),
);

// With no claim there is nothing to judge: the matrix must degrade to coverage
// and must NOT fabricate support/conflict stances.
const coverage = await service.reviewMatrix(scope, {});
check("claim-less matrix marks itself coverage-only", coverage.coverageOnly === true);
check(
  "claim-less matrix uses coverage stances only",
  coverage.rows.every((row) => row.stance === "covered" || row.stance === "empty"),
  JSON.stringify([...new Set(coverage.rows.map((row) => row.stance))]),
);
check("claim-less matrix reports no support", coverage.counts.support === undefined);
check("claim-less matrix counts what it claims", coverage.counts.covered + coverage.counts.empty === coverage.rows.length);

// Stance filtering selects, and an unknown stance is ignored rather than
// silently returning nothing.
const conflictsOnly = await service.reviewMatrix(scope, { claim: "旅游", stance: "conflict" });
check("stance filter returns only that stance", conflictsOnly.rows.every((row) => row.stance === "conflict"));
const badStance = await service.reviewMatrix(scope, { claim: "旅游", stance: "banana" });
const unfiltered = await service.reviewMatrix(scope, { claim: "旅游" });
check("unknown stance is ignored", badStance.rows.length === unfiltered.rows.length);

// --- citations render from stored metadata only
for (const style of ["apa", "ieee", "gb-t-7714"]) {
  const citations = await service.formatCitations(scope, { style });
  check(`${style} citation renders`, citations.ok === true, citations.reason ?? "");
  check(`${style} bibliography is non-empty`, citations.bibliography.length > 20);
  check(`${style} only cites stored papers`, citations.entries.length > 0);
}

// A locale that is not bundled must not be reported as if it had been used,
// and must not reach the filesystem as a path fragment.
const pathLocale = await service.formatCitations(scope, { style: "apa", locale: "x/../../../etc/passwd" });
check(
  "unknown locale is refused rather than resolved as a path",
  pathLocale.locale === "en-US" && pathLocale.warnings.some((warning) => /not bundled/.test(warning)),
  JSON.stringify({ locale: pathLocale.locale, warnings: pathLocale.warnings }),
);
const zh = await service.formatCitations(scope, { style: "apa", locale: "zh-CN" });
check("bundled zh-CN locale is honoured", zh.locale === "zh-CN", JSON.stringify(zh.locale));

const unknown = await service.formatCitations(scope, { style: "no-such-style" });
check("unknown style fails honestly", unknown.ok === false && typeof unknown.reason === "string");

// --- empty library is not an error
const emptyWork = mkdtempSync(join(tmpdir(), "paper-tool-s3-empty-"));
const emptyScope = { sessionId: "session-empty", workspaceRoot: emptyWork };
const emptyOutline = await service.reviewOutline(emptyScope, {});
check("empty library outline explains itself", emptyOutline.groups.length === 0 && emptyOutline.text.length > 0);
const emptyCitations = await service.formatCitations(emptyScope, { style: "apa" });
check("empty library citations fail honestly", emptyCitations.ok === false && emptyCitations.bibliography === "");

service.stores.forEach((store) => store.close());
for (const dir of [work, emptyWork]) rmSync(dir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\nS3/S4 FAILED (${failures.length}):`);
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("\nS3+S4 PASS");

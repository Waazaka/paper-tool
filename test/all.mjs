// One command that runs every gate.
//
// Two constraints shape this runner:
//
//   * The harness sandbox forbids a child process from writing to an inherited
//     pipe, so `spawnSync` with a captured stdout fails with EPERM. Gates are
//     therefore run with stdio "inherit" (their output goes straight to the
//     terminal) and each one records its verdict in a small result file, which
//     this runner reads back.
//   * Gates are ordered cheap-to-expensive: a syntax error or a broken contract
//     should stop the run before six real PDFs get parsed.
//
// Run: node test/all.mjs [corpusDir]
// Exit: 0 only when every gate passed; skips are reported, never hidden.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const corpus = process.argv[2] ?? join(process.env.USERPROFILE ?? "", "Zotero", "storage");
const node = process.execPath;
const outDir = join(import.meta.dirname, ".results");
mkdirSync(outDir, { recursive: true });

// `needsCorpus` gates verify behaviour on real papers, which a bare checkout does
// not have; without a corpus they are skipped (not failed).
const GATES = [
  { name: "s1-library", script: "s1-library.mjs", needsCorpus: true, what: "store, search, page text" },
  { name: "s2-host", script: "s2-host.mjs", needsCorpus: true, what: "host service contract" },
  { name: "s3-evidence", script: "s3-evidence.mjs", needsCorpus: true, what: "evidence + citations" },
  { name: "s4-tools", script: "s4-tools.mjs", needsCorpus: true, what: "tool registration" },
  { name: "s5-export", script: "s5-export.mjs", needsCorpus: true, what: "metadata + export" },
  { name: "s3-real-protocol", script: "s3-real-protocol.mjs", needsCorpus: true, what: "real typert protocol" },
  { name: "s6-ocr", script: "s6-ocr.mjs", needsCorpus: false, what: "scanned PDF to OCR text" },
  { name: "s7-functional", script: "s7-functional.mjs", needsCorpus: true, what: "end-to-end on real PDFs" },
  { name: "s9-metadata", script: "s9-metadata.mjs", needsCorpus: false, what: "title, authors, journal, year" },
  { name: "s10-anchoring", script: "s10-anchoring.mjs", needsCorpus: false, what: "quote offsets survive whitespace" },
  { name: "s11-search", script: "s11-search.mjs", needsCorpus: false, what: "CJK queries, terms, ordering" },
  { name: "wiring", script: "wiring.mjs", needsCorpus: false, what: "client/host RPC + theme tokens" },
  { name: "ui-render", script: "ui-render.mjs", needsCorpus: false, what: "every view renders" },
  { name: "s8-ui-a11y", script: "s8-ui-a11y.mjs", needsCorpus: false, what: "labels, state claims, honesty" },
  // Mounting gates. react-dom/server never runs an effect, so the reader and the
  // tab switch — the exact sequence that produced a blank pane — were invisible
  // to every gate above. These mount the real bundle in a DOM stub and click.
  { name: "s11-interaction", script: "s11-interaction.mjs", needsCorpus: false, what: "open a paper, switch tabs" },
  { name: "s12-reader-lifecycle", script: "s12-reader-lifecycle.mjs", needsCorpus: false, what: "reader mount/unmount" },
  { name: "s13-resilience", script: "s13-resilience.mjs", needsCorpus: false, what: "a crash keeps the pane alive" },
  // PDF.js API and teardown gates. These cover the two defects the user hit that
  // no earlier gate could see: "doc.destroy is not a function" on close (PDF.js 6
  // moved destroy to the loading task), and the fact that a teardown throw is not
  // always caught by an error boundary.
  { name: "s14-pdf-api", script: "s14-pdf-api.mjs", needsCorpus: true, what: "PDF.js teardown API" },
  { name: "s15-teardown", script: "s15-teardown.mjs", needsCorpus: false, what: "which unmount paths catch a throw" },
  // Regressions reported by the user after the mount fix: a library that looked
  // empty when the workbench was opened from another workspace (it was per
  // workspace by construction), and "re-read metadata" producing worse values
  // than the import (the file-name channel was dropped, and a legacy wrong year
  // could never be repaired because it looked user-confirmed).
  { name: "s17-shared-reextract", script: "s17-shared-and-reextract.mjs", needsCorpus: true, what: "shared library + honest re-extract" },
];

function corpusLooksUsable(dir) {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir, { recursive: true }).some((entry) => String(entry).toLowerCase().endsWith(".pdf"));
  } catch {
    return false;
  }
}

const haveCorpus = corpusLooksUsable(corpus);
console.log(`paper-tool gates — corpus: ${haveCorpus ? corpus : "NOT AVAILABLE"}\n`);

const results = [];
for (const gate of GATES) {
  if (gate.needsCorpus && !haveCorpus) {
    console.log(`skip ${gate.name} (needs a PDF corpus)`);
    results.push({ ...gate, status: "skip" });
    continue;
  }
  const resultFile = join(outDir, `${gate.name}.json`);
  rmSync(resultFile, { force: true });
  const args = [join(import.meta.dirname, gate.script)];
  if (gate.needsCorpus) args.push(corpus);
  console.log(`\n=== ${gate.name} ===`);
  const started = Date.now();
  const run = spawnSync(node, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: { ...process.env, PAPER_TOOL_RESULT_FILE: resultFile },
  });
  const ms = Date.now() - started;

  let detail = null;
  if (existsSync(resultFile)) {
    try {
      detail = JSON.parse(readFileSync(resultFile, "utf8"));
    } catch {
      detail = null;
    }
  }
  // Trust the file when the gate wrote one; otherwise fall back to the exit code.
  const status = detail !== null ? (detail.skipped ? "skip" : run.status === 0 ? "pass" : "fail") : run.status === 0 ? "pass" : "fail";
  results.push({ ...gate, status, ms, detail, exit: run.status, error: run.error?.code ?? null });
  const label = status === "pass" ? "pass" : status === "skip" ? "skip" : "FAIL";
  console.log(`${label} ${gate.name} (${ms}ms)`);
}

const failed = results.filter((result) => result.status === "fail");
const skipped = results.filter((result) => result.status === "skip");
const passed = results.filter((result) => result.status === "pass");

console.log(`\n${"=".repeat(60)}`);
for (const result of results) {
  const label = result.status === "pass" ? "pass" : result.status === "skip" ? "skip" : "FAIL";
  const counts = result.detail?.failures !== undefined ? ` (${result.detail.failures} failures)` : "";
  console.log(`${label.padEnd(4)} ${result.name.padEnd(18)} ${String(result.ms ?? "").padStart(7)}ms  ${result.what}${counts}`);
}
console.log(`${"-".repeat(60)}`);
console.log(`${passed.length} passed, ${skipped.length} skipped, ${failed.length} failed`);
if (skipped.length > 0) {
  console.log(`skipped: ${skipped.map((gate) => gate.name).join(", ")}`);
  console.log("(A skip is not a pass. These paths were not verified in this run.)");
}
if (failed.length > 0) {
  console.log(`\nFAILED: ${failed.map((gate) => gate.name).join(", ")}`);
  if (failed.some((gate) => gate.error !== null)) {
    console.log("Some gates could not be launched at all (no result file, non-zero exit).");
  }
  process.exit(1);
}
process.exit(0);

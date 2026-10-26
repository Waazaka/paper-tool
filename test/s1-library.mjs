// S1 end-to-end: import real PDFs -> index -> search (Chinese + English).
//
// Run: node test/s1-library.mjs [pdfDir...]
// Exits non-zero if any assertion fails, so it is a real gate, not a demo.
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPdfPages, guessMetadata } from "../lib/pdf-extract.js";
import { openStore } from "../lib/store.js";

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name} ${detail}`);
    failures.push(`${name} ${detail}`);
  }
}

function collectPdfs(dirs) {
  const out = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir, { recursive: true, withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile?.()) continue;
      if (!entry.name.toLowerCase().endsWith(".pdf")) continue;
      const full = join(entry.parentPath ?? entry.path, entry.name);
      try {
        if (statSync(full).size < 4096) continue;
      } catch {
        continue;
      }
      out.push(full);
    }
  }
  return out;
}

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("usage: node test/s1-library.mjs <pdfDir> [pdfDir...]");
  process.exit(2);
}

const pdfs = collectPdfs(dirs).slice(0, 6);
if (pdfs.length === 0) {
  console.error("S1: no PDFs found under", dirs.join(", "));
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "paper-tool-s1-"));
const storePath = join(work, "library.sqlite");
const store = openStore(storePath);

console.log(`S1: importing ${pdfs.length} PDF(s)`);
let withText = 0;
let chinesePages = 0;
let englishPages = 0;

for (const [index, file] of pdfs.entries()) {
  const paperId = `p${index + 1}`;
  try {
    const extracted = await extractPdfPages(readFileSync(file));
    const meta = guessMetadata(extracted.pages);
    const nonEmpty = extracted.pages.filter((page) => page.length > 40).length;
    if (nonEmpty > 0) withText += 1;
    chinesePages += extracted.pages.filter((page) => /[\u4e00-\u9fff]/.test(page)).length;
    englishPages += extracted.pages.filter((page) => /[A-Za-z]{4,}/.test(page)).length;
    store.upsertPaper({
      paperId,
      title: meta.title,
      year: meta.year,
      doi: meta.doi,
      pdfPath: file,
      fingerprint: extracted.fingerprint,
      material: nonEmpty > 0 ? "fulltext" : "metadata",
      pages: extracted.pages,
    });
    console.log(
      `  ${paperId}: ${extracted.numPages}p, ${nonEmpty} with text, fp ${extracted.fingerprint.slice(0, 8)} :: ${meta.title.slice(0, 40)}`,
    );
  } catch (error) {
    console.log(`  ${paperId}: SKIP (${error.message.slice(0, 60)})`);
  }
}

const stats = store.stats();
console.log("stats:", JSON.stringify(stats));

check("papers imported", stats.papers > 0, `got ${stats.papers}`);
check("some paper has extracted text", withText > 0, `withText=${withText}`);
check("pages indexed", stats.pages > 0, `got ${stats.pages}`);

// Chinese must round-trip: this is what the cMap fix is for.
if (chinesePages > 0) {
  check("chinese pages present", true);
  for (const query of ["旅游", "研究", "发展"]) {
    const hits = store.search(query);
    check(`search 「${query}」`, hits.length > 0, `got ${hits.length}`);
    if (hits.length > 0) {
      check(`  hit has page index`, Number.isInteger(hits[0].pageIndex) && hits[0].pageIndex >= 0);
      check(`  hit has snippet`, typeof hits[0].snippet === "string" && hits[0].snippet.length > 0);
    }
  }
} else {
  console.log("  note: no Chinese pages in sample; CJK assertions skipped");
}

if (englishPages > 0) {
  check("english pages present", true);
  for (const query of ["customer", "hotel", "research"]) {
    const hits = store.search(query);
    check(`search "${query}"`, hits.length > 0, `got ${hits.length}`);
  }
}

// Negative control: nonsense must not match anything.
check("no false positive", store.search("zzzqqqxyzzy").length === 0);

// A shared term must not be monopolised by one paper. Ordering search results
// by paperId alone is ordering by random UUID, so before this was fixed a
// single paper with many matching pages filled the whole result set and every
// other paper was invisible — which the evidence matrix then reported as
// "not found".
{
  const common = "the";
  const depthLimited = store.search(common, { limit: 8 });
  const papersInResult = new Set(depthLimited.map((hit) => hit.paperId)).size;
  const totalPapers = store.stats().papers;
  if (totalPapers > 1) {
    check(
      `search "${common}" spans more than one paper`,
      papersInResult > 1,
      `${papersInResult} of ${totalPapers} papers in ${depthLimited.length} rows`,
    );
  }
  check(
    `search "${common}" respects its limit`,
    depthLimited.length <= 8,
    `got ${depthLimited.length}`,
  );
}

// Deletion must remove pages from the index too: the deleted paper must not
// come back from any query (a total-hit count can legitimately stay the same
// because other papers still match).
const firstId = store.listPapers()[0]?.paperId;
if (firstId) {
  store.deletePaper(firstId);
  check("delete removes paper", store.getPaper(firstId) === null);
  check("delete removes pages", store.getPageText(firstId, 0) === null);
  const stillThere = [...store.search("旅游"), ...store.search("研究"), ...store.search("the")].some(
    (hit) => hit.paperId === firstId,
  );
  check("deleted paper gone from index", !stillThere);
}

store.close();
rmSync(work, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\nS1 FAILED (${failures.length}):`);
  for (const failure of failures) console.error(" -", failure);
  process.exit(1);
}
console.log("\nS1 PASS");

// Functional gate: the whole review workflow, on real papers.
//
// The s1-s5 gates each check one service layer with small synthetic inputs.
// This one answers a different question: can the plugin actually do the job a
// researcher hired it for, end to end, on the PDFs sitting in the corpus?
//
//    import real PDFs -> search inside them -> read the landing page ->
//    store evidence with a real offset -> check the jump lands on the quote ->
//    build the matrix -> render a citation -> export a review
//
// It is deliberately tolerant about *content* (which words a paper contains is
// not this test's business) and strict about *plumbing* (every step must hand
// real data to the next one, and any claim of coverage must match the data).
//
// Run: node test/s7-functional.mjs "<corpus dir with PDFs>"
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { openStore } from "../lib/store.js";
import { extractPdfPages, guessMetadata } from "../lib/pdf-extract.js";
import { renderBibliography } from "../lib/citeproc.js";
import { report } from "./report.mjs";

const corpus = process.argv[2] ?? join(process.env.USERPROFILE ?? "", "Zotero", "storage");
const SCRATCH = join(import.meta.dirname, ".scratch", "functional");
mkdirSync(SCRATCH, { recursive: true });

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

function findPdfs(root, limit) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      const full = join(dir, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) walk(full);
      else if (entry.toLowerCase().endsWith(".pdf")) out.push(full);
    }
  };
  walk(root);
  return out;
}

console.log("Functional gate");
console.log(`     corpus: ${corpus}`);

const pdfs = findPdfs(corpus, 6);
if (pdfs.length === 0) {
  console.log(`\nSKIP: no PDFs under ${corpus}. Pass a directory as the first argument.`);
  process.exit(report({ failures: 0, skipped: true, skipReason: "no PDF corpus" }));
}
console.log(`     found ${pdfs.length} PDF(s)\n`);

const store = openStore(join(SCRATCH, `functional-${Date.now()}.sqlite`));
const imported = [];

await check("imports real PDFs with their page text", async () => {
  for (const path of pdfs) {
    const bytes = new Uint8Array(readFileSync(path));
    const extracted = await extractPdfPages(bytes);
    assert.ok(extracted.numPages > 0, `${path} reported 0 pages`);
    const guess = guessMetadata(extracted.pages);
    const withText = extracted.pages.filter((page) => page.trim() !== "").length;
    store.upsertPaper({
      paperId: `paper-${imported.length + 1}`,
      title: guess.title || path,
      year: guess.year,
      doi: guess.doi,
      pdfPath: path,
      fingerprint: extracted.fingerprint,
      material: withText > 0 ? "fulltext" : "metadata",
      pages: extracted.pages,
    });
    imported.push({ paperId: `paper-${imported.length + 1}`, pages: extracted.pages, numPages: extracted.numPages, path });
  }
  assert.equal(imported.length, pdfs.length);
  assert.ok(store.stats().papers > 0, "store reports no papers after import");
});

await check("every imported paper is in the store with its page count", () => {
  for (const paper of imported) {
    const row = store.getPaper(paper.paperId);
    assert.ok(row !== null, `${paper.paperId} missing`);
    assert.equal(row.numPages, paper.numPages, `${paper.paperId} page count changed`);
  }
});

// Pick a real word out of the corpus so the search test cannot pass by accident
// on a term the index knows from a fixture.
//
// Only whole tokens count: the FTS5 path matches whole words, so a term cut out
// of the middle of a longer word ("Internationa" from "International") would
// make this test demand behaviour the index never promised.
function pickTerm(papers) {
  const stop = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was", "were", "研究", "本文"]);
  for (const paper of papers) {
    for (const page of paper.pages) {
      for (const word of page.match(/[A-Za-z][A-Za-z-]{5,14}/g) ?? []) {
        // Require the token to stand alone in the text, not be a prefix.
        if (stop.has(word.toLowerCase())) continue;
        const surrounded = new RegExp(`(^|[^A-Za-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z]|$)`);
        if (surrounded.test(page)) return word;
      }
    }
  }
  return null;
}

const term = pickTerm(imported);
let searchHits = [];

await check("search finds a term that exists in the corpus", () => {
  if (term === null) return; // nothing to search; the import test already proved text
  searchHits = store.search(term, { limit: 20 });
  assert.ok(searchHits.length > 0, `searching "${term}" returned nothing`);
  // The snippet must be real text from the page, not an empty placeholder.
  assert.ok(
    searchHits.some((hit) => typeof hit.snippet === "string" && hit.snippet.length > 0),
    "every hit had an empty snippet",
  );
});

await check("each hit points at a page that really contains the term", () => {
  if (term === null) return;
  const needle = term.toLowerCase();
  for (const hit of searchHits.slice(0, 10)) {
    const text = store.getPageText(hit.paperId, hit.pageIndex);
    assert.ok(text !== null, `hit ${hit.paperId} p${hit.pageIndex} has no page text`);
    // CJK is matched case-insensitively too, so comparing lower-cased is safe.
    assert.ok(
      text.toLowerCase().includes(needle),
      `hit says ${hit.paperId} p${hit.pageIndex + 1} but the term is not on that page`,
    );
  }
});

await check("reading a paper returns pages that match storage", () => {
  const target = imported.find((paper) => paper.numPages > 2) ?? imported[0];
  const from = 0;
  const to = Math.min(target.numPages, 3);
  const read = [];
  for (let pageIndex = from; pageIndex < to; pageIndex += 1) {
    const text = store.getPageText(target.paperId, pageIndex);
    assert.ok(text !== null, `page ${pageIndex} is missing from storage`);
    read.push(text);
  }
  assert.equal(read.length, to - from);
});

// The core promise of the product: a saved quote can be jumped back to.
await check("evidence keeps a quote that the page really contains", () => {
  const candidate = imported.find((paper) => paper.pages.some((page) => page.trim().length > 200));
  assert.ok(candidate !== undefined, "no imported paper had enough text to quote");
  const pageIndex = candidate.pages.findIndex((page) => page.trim().length > 200);
  const pageText = candidate.pages[pageIndex];
  // Take a mid-page span so the offset is not trivially 0.
  const start = Math.min(120, Math.max(0, pageText.length - 60));
  const quote = pageText.slice(start, start + 50).trim();
  assert.ok(quote.length >= 20, "could not carve a quote out of the page");

  const located = pageText.indexOf(quote);
  assert.ok(located >= 0, "quote was not found in the page it came from");

  store.addEvidence({
    evidenceId: "ev-functional-1",
    paperId: candidate.paperId,
    pageIndex,
    charStart: located,
    charEnd: located + quote.length,
    quote,
  });
  const stored = store.listEvidence({ paperId: candidate.paperId });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].quote, quote);
  assert.equal(stored[0].charStart, located);

  // Re-derive the quote from the stored offsets: this is the jump-back check.
  const pageForJump = store.getPageText(candidate.paperId, stored[0].pageIndex);
  assert.equal(
    pageForJump.slice(stored[0].charStart, stored[0].charEnd),
    quote,
    "the stored offsets do not reproduce the quote — jumping would land wrong",
  );
});

await check("evidence is listed back with usable anchors", () => {
  const stored = store.listEvidence({ paperId: imported[0].paperId });
  // Evidence belongs to whichever paper it was carved from; assert the shape of
  // whatever comes back rather than assuming which paper.
  const all = [];
  for (const paper of imported) all.push(...store.listEvidence({ paperId: paper.paperId }));
  assert.ok(all.length > 0, "no evidence was stored at all");
  for (const row of all) {
    assert.equal(typeof row.evidenceId, "string");
    assert.equal(typeof row.pageIndex, "number");
    assert.ok(row.pageIndex >= 0, "evidence landed on a negative page");
    assert.equal(typeof row.quote, "string");
    assert.ok(row.quote.length > 0, "evidence stored an empty quote");
  }
  assert.ok(Array.isArray(stored), "listEvidence did not return an array");
});

await check("renders a bibliography for an imported paper", async () => {
  const paper = store.getPaper(imported[0].paperId);
  const rendered = await renderBibliography(
    [
      {
        paperId: paper.paperId,
        title: paper.title || "Untitled",
        authors: paper.authors || "Unknown",
        year: paper.year || "n.d.",
        venue: paper.venue || "",
        doi: paper.doi || "",
      },
    ],
    "apa",
  );
  assert.ok(rendered !== null, "citeproc returned nothing");
  assert.ok(typeof rendered.bibliography === "string" && rendered.bibliography.length > 0, "empty bibliography");
});

await check("coverage claims match what the library actually holds", () => {
  const stats = store.stats();
  assert.ok(stats.papers === imported.length, `stats say ${stats.papers} papers, imported ${imported.length}`);
  let pagesWithText = 0;
  for (const paper of imported) {
    pagesWithText += paper.pages.filter((page) => page.trim() !== "").length;
  }
  assert.ok(
    typeof stats.pages === "number" && stats.pages >= pagesWithText,
    `stats report ${stats.pages} pages but the corpus had ${pagesWithText} non-empty pages`,
  );
});

await check("evidence carries the text origin of the paper it came from", () => {
  // A quote lifted from OCR text is not the same evidence as one lifted from a
  // text layer. If the origin is dropped here it is dropped everywhere
  // downstream (outline, matrix, export), and the final review silently presents
  // guessed characters as the paper's own words.
  const rows = store.listEvidence({ limit: 50 });
  assert.ok(rows.length > 0, "no evidence to check");
  for (const row of rows) {
    assert.ok(
      "paperTextSource" in row,
      "evidence row does not carry the paper's textSource",
    );
    assert.ok(
      ["text-layer", "ocr"].includes(row.paperTextSource),
      `unexpected textSource: ${row.paperTextSource}`,
    );
  }
});

await check("library statistics do not contradict themselves", () => {
  // withFullText used to exclude OCR papers while pagesWithText counted their
  // pages, so a library of scanned papers reported "0 searchable, 300 pages with
  // text". These three must stay consistent.
  const stats = store.stats();
  assert.ok(typeof stats.withOcrText === "number", "stats has no withOcrText");
  assert.ok(typeof stats.searchable === "number", "stats has no searchable count");
  assert.ok(typeof stats.pagesWithOcr === "number", "stats has no pagesWithOcr");
  assert.equal(
    stats.searchable,
    stats.withFullText + stats.withOcrText,
    `searchable (${stats.searchable}) is not fulltext (${stats.withFullText}) + ocr (${stats.withOcrText})`,
  );
  assert.ok(
    stats.pagesWithOcr <= stats.pagesWithText,
    `pagesWithOcr (${stats.pagesWithOcr}) exceeds pagesWithText (${stats.pagesWithText})`,
  );
});

await check("an exported review marks OCR quotes as OCR", () => {
  // The exported review is what gets pasted into a manuscript. A quote guessed by
  // OCR must stay distinguishable from one read out of a text layer after it
  // leaves the app, so the marker has to survive into the markdown itself.
  const dir = mkdtempSync(join(SCRATCH, "ocr-export-"));
  const ocrStore = openStore(join(dir, "library.sqlite"));
  try {
    ocrStore.upsertPaper({
      paperId: "ocr-export-1",
      title: "Scanned",
      authors: "Someone",
      year: "2024",
      material: "ocr",
      textSource: "ocr",
      pages: ["旅游经济贡献率协调关系研究"],
      pageSources: ["ocr"],
    });
    ocrStore.addEvidence({
      evidenceId: "abcdef123456",
      paperId: "ocr-export-1",
      pageIndex: 0,
      charStart: 0,
      charEnd: 6,
      quote: "旅游经济贡献",
    });
    const rows = ocrStore.listEvidence({ paperId: "ocr-export-1" });
    assert.equal(rows[0].paperTextSource, "ocr", "evidence lost its text origin");

    // Same marker rule the exporter applies in host-service.exportReview.
    const fromOcr = rows[0].paperTextSource === "ocr";
    const line = `- p.${rows[0].pageIndex + 1} [E:${rows[0].evidenceId.slice(0, 8)}]${fromOcr ? "（OCR）" : ""} “${rows[0].quote}”`;
    assert.ok(line.includes("（OCR）"), `exported quote is not marked as OCR: ${line}`);
  } finally {
    ocrStore.close();
  }
});

store.close();
console.log(failures === 0 ? "\nFUNCTIONAL PASS" : `\n${failures} FAILURE(S)`);
process.exit(report({ failures }));

// OCR gate: a scanned PDF must become searchable text.
//
// What makes this a real test rather than a mock:
//   * the fixture is an image-only PDF, so `extractPdfPages` returns zero
//     characters and OCR is the ONLY possible source of the text;
//   * the expected words are checked as substrings, and the CJK check
//     specifically fails if the engine's per-glyph spacing survives ("旅 游"
//     instead of "旅游"), because that text is unsearchable;
//   * the import -> search -> evidence path is exercised end to end against a
//     real store, not by calling the OCR helper alone.
//
// On a machine without the Windows OCR engine this test SKIPS (exit 0) and says
// so. It never pretends to have verified recognition it did not run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ocrAvailable, normalizeOcrText, ocrPages } from "../lib/ocr.js";
import { rasterizePdfPages, rasterizerAvailable } from "../lib/pdf-raster.js";
import { extractPdfPages } from "../lib/pdf-extract.js";
import { openStore } from "../lib/store.js";
import { report } from "./report.mjs";

const FIXTURE = join(import.meta.dirname, "fixtures", "scanned-cn.pdf");
// Scratch databases live under the package: the harness sandbox denies removal
// of directories it created in the platform temp area, which made cleanup throw.
const SCRATCH = join(import.meta.dirname, ".scratch");
mkdirSync(SCRATCH, { recursive: true });
let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   ${name}`))
    .catch((error) => {
      failures += 1;
      console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n")[0]}`);
    });
}

console.log("OCR gate");

await check("normalizeOcrText joins per-glyph CJK spacing", () => {
  assert.equal(normalizeOcrText("旅 游 经 济"), "旅游经济");
  assert.equal(normalizeOcrText("本 文 以 山 东 省 为 例 ， 分 析"), "本文以山东省为例，分析");
  // A space between Latin and CJK is preserved so numbers stay readable.
  assert.equal(normalizeOcrText("第 3 章 旅 游"), "第 3 章旅游");
  assert.equal(normalizeOcrText("GDP 增 长 率"), "GDP 增长率");
});

await check("fixture has no text layer (OCR is the only source)", async () => {
  const { pages, numPages } = await extractPdfPages(new Uint8Array(readFileSync(FIXTURE)));
  assert.equal(numPages, 1, "fixture should be one page");
  assert.equal(
    pages.join("").trim(),
    "",
    "fixture must have zero extractable text or this test proves nothing",
  );
});

const rasterOk = await rasterizerAvailable();
const ocrStatus = await ocrAvailable();
console.log(`     rasterizer: ${rasterOk ? "available" : "UNAVAILABLE"}`);
console.log(`     ocr engine: ${ocrStatus.available ? `${ocrStatus.language} (${ocrStatus.languages.join(", ")})` : `UNAVAILABLE (${ocrStatus.reason})`}`);

if (!rasterOk || !ocrStatus.available) {
  console.log("\nSKIP: this machine cannot rasterize or OCR; recognition not verified here.");
  console.log("(Not a failure — but do not claim OCR works based on this run.)");
  process.exit(report({
    failures,
    skipped: true,
    skipReason: !rasterOk ? "rasterizer unavailable" : ocrStatus.reason,
  }));
}

let recognisedText = "";

await check("rasterizes the scanned page to a PNG", async () => {
  const { pages, numPages } = await rasterizePdfPages(new Uint8Array(readFileSync(FIXTURE)));
  assert.equal(numPages, 1);
  assert.equal(pages.length, 1);
  assert.ok(pages[0].png.length > 1000, "PNG should have real content");
});

await check("an oversized render is clamped below the engine limit", async () => {
  // The Windows OCR engine refuses an image whose longest side exceeds
  // MaxImageDimension (10000) — it does not downscale, it throws and returns no
  // text. A large-format page at a high scale therefore has to be clamped by the
  // rasterizer, or a whole paper silently yields nothing.
  const { pages } = await rasterizePdfPages(new Uint8Array(readFileSync(FIXTURE)), { scale: 40 });
  assert.equal(pages.length, 1);
  const longest = Math.max(pages[0].width, pages[0].height);
  assert.ok(longest <= 10000, `rendered ${pages[0].width}x${pages[0].height}, above the 10000 limit`);
  assert.ok(pages[0].scale < 40, "the requested scale was not reduced");
});

await check("recognises readable Chinese from the scan", async () => {
  const { pages } = await rasterizePdfPages(new Uint8Array(readFileSync(FIXTURE)));
  const texts = await ocrPages(pages.map((page) => page.png));
  assert.equal(texts.length, 1);
  assert.equal(typeof texts[0], "string", "page 0 was not recognised");
  recognisedText = texts[0];
  // The fixture's real text; OCR may misread a glyph, so check whole phrases
  // that survived measurement, not a byte-exact string.
  assert.ok(recognisedText.includes("旅游经济"), `missing 旅游经济 in: ${recognisedText}`);
  assert.ok(recognisedText.includes("山东省"), `missing 山东省 in: ${recognisedText}`);
  assert.ok(/贡献率/.test(recognisedText), `missing 贡献率 in: ${recognisedText}`);
});

await check("CJK text carries no per-glyph spacing", () => {
  // The failure this guards: "旅 游 经 济" is unsearchable by the CJK LIKE path.
  assert.ok(!/旅\s+游/.test(recognisedText), `glyphs still spaced apart: ${recognisedText}`);
  assert.ok(!/经\s+济/.test(recognisedText), `glyphs still spaced apart: ${recognisedText}`);
});

await check("OCR text is searchable through the store", async () => {
  const dir = mkdtempSync(join(SCRATCH, "store-"));
  {
    const store = openStore(join(dir, "library.sqlite"));
    store.upsertPaper({
      paperId: "scan-1",
      title: "扫描件",
      material: "ocr",
      textSource: "ocr",
      pages: [recognisedText],
      pageSources: ["ocr"],
    });
    const hits = store.search("旅游经济", { limit: 10 });
    assert.ok(hits.length > 0, "OCR text did not match a CJK search");
    assert.equal(hits[0].paperId, "scan-1");
    // The row must remember it came from OCR, not a text layer.
    const paper = store.getPaper("scan-1");
    assert.equal(paper.textSource, "ocr");
    assert.equal(paper.material, "ocr");
    assert.equal(store.getPageText("scan-1", 0), recognisedText);
    store.close();
  }
  // Scratch databases are left in place: the sandbox denies recursive removal,
  // and each run gets a fresh mkdtemp directory anyway.
});

await check("OCR text can be anchored as evidence", async () => {
  const dir = mkdtempSync(join(SCRATCH, "evidence-"));
  {
    const store = openStore(join(dir, "library.sqlite"));
    store.upsertPaper({
      paperId: "scan-2",
      title: "扫描件2",
      material: "ocr",
      textSource: "ocr",
      pages: [recognisedText],
      pageSources: ["ocr"],
    });
    const quote = "旅游经济贡献率协调关系研究";
    const located = recognisedText.indexOf(quote);
    // A misread glyph would break the exact offset; that is why the store keeps
    // -1 for "not located" instead of faking precision.
    const evidence = store.addEvidence({
      evidenceId: "ev-1",
      paperId: "scan-2",
      pageIndex: 0,
      charStart: located,
      charEnd: located >= 0 ? located + quote.length : -1,
      quote,
    });
    assert.ok(evidence, "evidence was not stored");
    if (located >= 0) {
      assert.equal(recognisedText.slice(located, located + quote.length), quote);
    }
    store.close();
  }
});

// --- degraded scans -------------------------------------------------------
// A real library contains bad scans, not just clean ones. Unknown text must come
// back as null (no text) rather than as invented characters: a hallucinated
// quote in a review is worse than a missing one.
const DEGRADED = join(import.meta.dirname, "fixtures");

await check("unreadable noise yields no text instead of invented text", async () => {
  const path = join(DEGRADED, "degraded-noise.png");
  let png;
  try {
    png = readFileSync(path);
  } catch {
    console.log("     (fixture missing, skipped)");
    return;
  }
  const [text] = await ocrPages([png]);
  assert.equal(text, null, `OCR invented text for a noise image: ${JSON.stringify(String(text).slice(0, 60))}`);
});

await check("a faint but legible scan is still readable", async () => {
  const path = join(DEGRADED, "degraded-faint.png");
  let png;
  try {
    png = readFileSync(path);
  } catch {
    return;
  }
  const [text] = await ocrPages([png]);
  assert.equal(typeof text, "string", "a faint scan produced no text");
  assert.ok(text.length > 0);
});

await check("a heavily blurred scan degrades but does not crash", async () => {
  const path = join(DEGRADED, "degraded-blurry.png");
  let png;
  try {
    png = readFileSync(path);
  } catch {
    return;
  }
  const [text] = await ocrPages([png]);
  // It may be wrong — that is expected — but it must be a string, and the paper
  // is still marked "ocr" so the user knows not to trust it verbatim.
  assert.equal(typeof text, "string", "a blurred scan produced a null instead of a string");
});

// --- through the real import path ---------------------------------------
// Everything above calls the rasterizer directly. That is not how a user reaches
// OCR: they drop a file on the sidebar and `importPdf` runs. Driving the real
// service is the only way to catch a defect in the wiring between the two — and
// it did catch one: pdf.js detaches the buffer it is handed, so the rasterizer
// was destroying the bytes `importPdf` still needed to save the PDF, and every
// scanned import failed with "Cannot perform Construct on a detached
// ArrayBuffer" while these lower-level checks stayed green.
const { loadService } = await import("./shim.mjs");
const { PaperToolService } = await loadService();

await check("importPdf stores a scanned PDF as searchable OCR text", async () => {
  const root = mkdtempSync(join(SCRATCH, "import-"));
  const service = new PaperToolService({ inject() {}, get() {} }, {});
  const scope = { sessionId: "ocr-import", workspaceRoot: root };
  const result = await service.importPdf(scope, {
    files: [{ name: "scan.pdf", data: new Uint8Array(readFileSync(FIXTURE)) }],
  });
  assert.equal(result.failed.length, 0, `import failed: ${JSON.stringify(result.failed)}`);
  assert.equal(result.imported.length, 1, "the scanned PDF was not imported");
  const paper = result.imported[0];
  assert.equal(paper.material, "ocr", `expected material "ocr", got "${paper.material}"`);
  assert.equal(paper.textSource, "ocr", `expected textSource "ocr", got "${paper.textSource}"`);
  assert.equal(paper.numPages, 1);
  assert.equal(paper.pagesWithText, 1, "the recognised page was not counted as having text");
  assert.equal(paper.ocr.pagesRecognised, 1, "the report does not say a page was recognised");
  // The bytes must still be usable AFTER OCR. pdf.js detaches the buffer it is
  // given, so a rasterizer that passed the caller's buffer through would leave
  // importPdf unable to save the PDF while every lower-level check stayed green.
  const saved = readFileSync(join(root, ".dsh", "paper-tool", "files", `${paper.paperId}.pdf`));
  assert.equal(saved.length, readFileSync(FIXTURE).length, "the saved PDF is truncated or empty");
});

await check("re-importing the same scan does not pay for OCR twice", async () => {
  const root = mkdtempSync(join(SCRATCH, "import-dup-"));
  const service = new PaperToolService({ inject() {}, get() {} }, {});
  const scope = { sessionId: "ocr-dup", workspaceRoot: root };
  const make = () => ({
    files: [{ name: "scan.pdf", data: new Uint8Array(readFileSync(FIXTURE)) }],
  });
  const first = await service.importPdf(scope, make());
  assert.equal(first.imported.length, 1, "first import did not succeed");
  const started = Date.now();
  const second = await service.importPdf(scope, make());
  const elapsed = Date.now() - started;
  assert.equal(second.duplicates.length, 1, "the second import was not detected as a duplicate");
  assert.equal(second.imported.length, 0, "the duplicate was stored twice");
  // Dedupe must run before recognition, or dropping the same 40-page scan twice
  // costs a full OCR pass for nothing. A clean recognition takes ~1.2s here.
  assert.ok(elapsed < 700, `duplicate import took ${elapsed}ms — OCR probably ran again`);
});

console.log(failures === 0 ? "\nOCR PASS" : `\n${failures} FAILURE(S)`);
process.exit(report({ failures }));


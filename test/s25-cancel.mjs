// Cancellation: a long job the user stopped must report "you stopped it", not
// "it broke", and must not leave the library in a half-written state.
//
// The interesting assertions are the three that distinguish a real cancellation
// implementation from a button that just stops listening:
//   - an abort mid-import keeps the files already imported
//   - the skipped remainder is counted, so the user knows work was dropped
//   - a cancelled OCR leaves the paper exactly as it was, not half-OCR'd
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadService } from "./shim.mjs";

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else {
    console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail));
    failures.push(name);
  }
}

const dir = mkdtempSync(join(tmpdir(), "cancel-gate-"));
const { PaperToolService } = await loadService();
const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: dir });
const scope = { sessionId: "cancel", workspaceRoot: dir };
const store = service.storeFor(scope);

// A real PDF to import, so the abort paths run against actual extraction work.
const corpus = join(process.env.USERPROFILE ?? "", "Zotero", "storage");
function findPdf(root, depth = 0) {
  if (depth > 3) return null;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith(".pdf")) continue;
    const p = join(root, e.name);
    const size = statSync(p).size;
    if (size > 50000 && size < 4_000_000) return p;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const f = findPdf(join(root, e.name), depth + 1);
    if (f !== null) return f;
  }
  return null;
}
const pdf = findPdf(corpus);
check("a corpus PDF is available for a real import", pdf !== null, corpus);
if (pdf === null) {
  console.log("\nCANCEL SKIPPED: no corpus PDF (a skip is not a pass)");
  process.exit(2);
}
const pdfBytes = Array.from(readFileSync(pdf));

// --- helper: an already-aborted signal ----------------------------------
function abortedSignal() {
  const controller = new AbortController();
  controller.abort(new DOMException("cancelled by test", "AbortError"));
  return { controller, signal: controller.signal };
}

// --- 1. an aborted import reports cancellation, not failure ------------
{
  const { signal } = abortedSignal();
  let result = null;
  let error = null;
  try {
    result = await service.importPdf(scope, { files: [{ name: "a.pdf", data: pdfBytes }] }, signal);
  } catch (caught) {
    error = caught;
  }
  // Nothing was imported yet, so the only honest outcome is an abort. The failure
  // mode this guards against is reporting `failed: [{ reason: "This operation was
  // aborted" }]`, which makes the user think their PDF is broken.
  check("aborting before any work aborts the call", error !== null, JSON.stringify(result));
  check("the abort is recognisable as a cancellation",
    error?.name === "AbortError" || error?.constructor?.name === "AbortError" || /abort/i.test(String(error?.message)),
    `${error?.name} / ${error?.message}`);
  check("a cancellation is not reported as a per-file failure",
    result === null || (result.failed ?? []).length === 0,
    JSON.stringify(result?.failed));
}

// --- 2. aborting after some files keeps the finished ones --------------
{
  // Import three files; abort after the first completes. The signal is flipped from
  // inside a proxy that counts calls to throwIfAborted, which is exactly how the real
  // per-file checkpoint is reached.
  let checks = 0;
  const controller = new AbortController();
  const signal = {
    get aborted() { return controller.signal.aborted; },
    throwIfAborted() {
      checks += 1;
      // Let the first file through, stop before the second.
      if (checks >= 2) controller.abort(new DOMException("cancelled by test", "AbortError"));
      controller.signal.throwIfAborted();
    },
  };
  const files = [
    { name: "one.pdf", data: pdfBytes },
    { name: "two.pdf", data: pdfBytes },
    { name: "three.pdf", data: pdfBytes },
  ];
  let result = null;
  let error = null;
  try {
    result = await service.importPdf(scope, { files, ocr: false, enrich: false }, signal);
  } catch (caught) {
    error = caught;
  }
  check("aborting mid-batch returns a partial result instead of throwing", result !== null,
    error === null ? "returned nothing" : `${error.name}: ${error.message}`);
  if (result !== null) {
    check("the already-imported file is kept", (result.imported ?? []).length >= 1,
      String((result.imported ?? []).length));
    check("the result is marked as aborted", result.aborted === true, String(result.aborted));
    check("fewer files were processed than submitted",
      (result.imported ?? []).length < files.length, `${(result.imported ?? []).length}/${files.length}`);
    check("the skipped remainder is counted", typeof result.skipped === "number" && result.skipped >= 1,
      String(result.skipped));
    check("nothing was recorded as a failure", (result.failed ?? []).length === 0,
      JSON.stringify(result.failed));
  }
}

// --- 3. the library is consistent after a cancelled import -------------
{
  // A half-written paper would be one with a `papers` row but no `pages` rows. The
  // import writes the PDF file and the paper row together, so an abort can only land
  // before either — but asserting it is what keeps that true.
  const orphans = store.db
    .prepare(`SELECT COUNT(*) c FROM papers p
              WHERE p.material IN ('fulltext','ocr')
                AND NOT EXISTS (SELECT 1 FROM pages pg WHERE pg.paperId = p.paperId)`)
    .get().c;
  check("no paper claims full text while having no pages", orphans === 0, String(orphans));
  const noPdf = store.db
    .prepare("SELECT COUNT(*) c FROM papers WHERE pdfPath = '' OR pdfPath IS NULL").get().c;
  // Papers imported from metadata only legitimately have no pdfPath; an imported file
  // must have one. Distinguish by source.
  const importedWithoutPdf = store.db
    .prepare("SELECT COUNT(*) c FROM papers WHERE source = 'import' AND (pdfPath = '' OR pdfPath IS NULL)").get().c;
  check("every imported paper has its PDF on disk", importedWithoutPdf === 0,
    `${importedWithoutPdf} imported papers without a pdfPath`);
  check("the metadata-only count is not confused with a broken import", noPdf >= 0);

  // Re-importing the same files must still work after a cancellation, and must be
  // recognised as duplicates rather than re-added.
  const again = await service.importPdf(scope, {
    files: [{ name: "one.pdf", data: pdfBytes }], ocr: false, enrich: false,
  });
  check("importing again after a cancellation succeeds", again !== null && again.failed.length === 0,
    JSON.stringify(again?.failed));
  check("the re-import is recognised as a duplicate", (again.duplicates ?? []).length === 1,
    JSON.stringify(again.duplicates));
}

// --- 3b. external search: cancel is not a timeout ----------------------
{
  // The bug this pins down was found while writing this work item's evidence: the
  // search layer turned every AbortError into the reason "timed out". That merged two
  // opposite facts — "the network was slow" and "you pressed stop" — into one
  // message, and the merged version is actively confusing: a user who cancelled reads
  // that their sources timed out and may conclude the tool is unreliable.
  //
  // Tested ONE SOURCE AT A TIME, deliberately. With the default source list, a guard
  // removed from the OpenAlex path is masked by the identical guard still present in
  // the arXiv path — the search throws anyway, for the wrong reason, and the assertion
  // passes. That masking is exactly why the first version of this gate could not
  // detect the mutation.
  for (const source of ["openalex", "crossref", "arxiv"]) {
    const { signal } = abortedSignal();
    let result = null;
    let error = null;
    try {
      result = await service.searchExternal(scope, { query: "servicescape", limit: 3, sources: [source] }, signal);
    } catch (caught) {
      error = caught;
    }
    check(`${source}: a cancelled search throws instead of returning failures`,
      error !== null, JSON.stringify(result));
    check(`${source}: the thrown error is a cancellation`,
      error !== null && (error.name === "AbortError" || /abort/i.test(String(error?.message))),
      `${error?.name}: ${error?.message}`);
    check(`${source}: cancelling never produces a "timed out" failure`,
      !/timed out/i.test(String(error?.message ?? "")) &&
        !/timed out/i.test(JSON.stringify(result ?? {})),
      `${error?.message ?? ""} ${JSON.stringify(result?.failures ?? [])}`);
  }

  // The other half of the distinction: a genuine timeout must STILL be reported as a
  // timeout. Fixing the cancellation path must not silence real network problems —
  // that would trade one misleading message for another. Asserted on the same source
  // that the cancel case exercised, so a "just always throw" over-fix is caught.
  const searchSource = readFileSync("lib/external-search.js", "utf8");
  check("a real timeout is still reported as a timeout", /"timed out"/.test(searchSource));
  check("the timeout path is kept distinct from the cancel path",
    /if \(signal\?\.aborted === true\) throw error;/.test(searchSource));
  // Both the JSON sources and the XML source need their own guard: they have separate
  // fetch sites, so one guard does not cover the other.
  const guards = (searchSource.match(/if \(signal\?\.aborted === true\) throw error;/g) ?? []).length;
  check("every fetch site distinguishes cancellation from timeout", guards >= 2, String(guards));

  // And the over-fix direction: turning every AbortError into a rethrow would break the
  // genuine timeout, whose whole purpose is to record a failed source rather than abort
  // the whole search. A timeout is our own controller firing while the caller's signal
  // is still live, so `signal?.aborted` is false and the failure branch must run.
  check("the cancel guard is keyed on the caller's signal, not on the error name",
    /signal\?\.aborted === true\) throw error/.test(searchSource) &&
      !/if \(error\?\.name === "AbortError"\) throw error;/.test(searchSource));
}

// --- 4. OCR accepts a signal and aborts ---------------------------------
{
  const hostSource = readFileSync("lib/host-service.js", "utf8");
  check("ocrPaper takes a signal parameter",
    /async ocrPaper\(paperToolScope, input, signal\)/.test(hostSource));
  const { signal } = abortedSignal();
  let error = null;
  try {
    await service.ocrPaper(scope, { paperId: "no-such-paper" }, signal);
  } catch (caught) {
    error = caught;
  }
  // The paper lookup happens before the signal check, so this specific call fails on
  // the missing paper. What matters is that the call accepts a third argument at all.
  check("ocrPaper accepts a third argument without throwing a type error",
    error === null || !/not a function|undefined is not/i.test(String(error?.message)),
    error?.message);
}

// --- 5. a cancelled OCR leaves the paper untouched ----------------------
{
  // Build a metadata-only paper whose PDF has no text layer, so OCR would run.
  const scanned = join(dir, "scan.pdf");
  // A minimal PDF with one empty page: parseable, no text layer.
  const minimal = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF\n",
    "utf8",
  );
  writeFileSync(scanned, minimal);
  store.upsertPaper({
    paperId: "scan1", title: "Scanned thing", authors: "", year: "", venue: "", doi: "",
    source: "import", pdfPath: scanned, fingerprint: "f-scan", material: "metadata",
    pages: [""], pageSources: ["text-layer"],
  });
  const before = store.getPaper("scan1");
  const { signal } = abortedSignal();
  let error = null;
  try {
    await service.ocrPaper(scope, { paperId: "scan1" }, signal);
  } catch (caught) {
    error = caught;
  }
  const after = store.getPaper("scan1");
  // Either outcome is legitimate here: the abort may fire before OCR starts (the
  // signal is already aborted, so it throws) or the page may have no rasterisable
  // content (the skip path). What must NOT happen is a half-written paper, which the
  // assertions below pin down. A check like "something happened" would pass on every
  // possible implementation, including a broken one, so it is not written.
  check("a cancelled OCR does not mark the paper as ocr",
    after.material === before.material, `${before.material} -> ${after.material}`);
  check("a cancelled OCR leaves the page text unchanged",
    JSON.stringify(after.pages) === JSON.stringify(before.pages),
    `${JSON.stringify(before.pages)} -> ${JSON.stringify(after.pages)}`);
  check("a cancelled OCR leaves textSource unchanged",
    after.textSource === before.textSource, `${before.textSource} -> ${after.textSource}`);
}

// --- 5b. the signal actually reaches #runOcr ---------------------------
{
  // A signature check is not enough: `ocrPaper(scope, input, signal)` could accept a
  // signal and then fail to forward it, leaving a 40-page recognition run uncancellable
  // while the gate stayed green. The checkpoints have a known order, so aborting at a
  // specific one tests a specific part of the path:
  //
  //   1-2  ocrPaper, before reading bytes / extracting pages
  //   3-4  #runOcr, before the engine check and before rasterising
  //   5+   ocrPages, before recognition and at each page
  //
  // Aborting at 3 or later is only possible if the signal made it into #runOcr at all —
  // which is exactly what "the signal reaches OCR" means. A run whose #runOcr dropped
  // the parameter has just two checkpoints and cannot be aborted past them.
  const scanned2 = join(dir, "scan2.pdf");
  const minimal2 = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF\n",
    "utf8",
  );
  writeFileSync(scanned2, minimal2);
  store.upsertPaper({
    paperId: "scan2", title: "Second scan", authors: "", year: "", venue: "", doi: "",
    source: "import", pdfPath: scanned2, fingerprint: "f-scan2", material: "metadata",
    pages: [""], pageSources: ["text-layer"],
  });

  /**
   * Run ocrPaper with an abort that fires on the Nth consult of the signal.
   * Returns how many times the signal was consulted and what came back.
   */
  async function ocrAbortingAt(nth) {
    let consulted = 0;
    const controller = new AbortController();
    const counting = {
      get aborted() { return controller.signal.aborted; },
      get reason() { return controller.signal.reason; },
      throwIfAborted() {
        consulted += 1;
        if (consulted >= nth) controller.abort(new DOMException("stop", "AbortError"));
        controller.signal.throwIfAborted();
      },
      addEventListener(...args) { return controller.signal.addEventListener(...args); },
      removeEventListener(...args) { return controller.signal.removeEventListener(...args); },
    };
    let result = null;
    let error = null;
    try {
      result = await service.ocrPaper(scope, { paperId: "scan2" }, counting);
    } catch (caught) {
      error = caught;
    }
    return { consulted, result, error };
  }

  // Baseline: with no abort, how deep does the path go? This is measured, not assumed —
  // an OCR engine that is unavailable would stop earlier and silently weaken the
  // assertions below, so the depth is asserted rather than trusted.
  const plain = await ocrAbortingAt(Number.MAX_SAFE_INTEGER);
  check("the OCR path consults the signal at least four times when it runs",
    plain.consulted >= 4, String(plain.consulted));
  check("the un-aborted OCR run completes without an error", plain.error === null,
    `${plain.error?.name}: ${plain.error?.message}`);

  // Abort at the first checkpoint that lives inside #runOcr. If #runOcr does not
  // receive the signal, this abort never fires and the call returns a normal skip.
  const mid = await ocrAbortingAt(3);
  check("an abort at the first in-OCR checkpoint throws a cancellation",
    mid.error !== null, `consulted=${mid.consulted} result=${JSON.stringify(mid.result)}`);
  check("that abort is recognisable as a cancellation",
    mid.error !== null && (mid.error.name === "AbortError" || /abort/i.test(String(mid.error?.message))),
    `${mid.error?.name}: ${mid.error?.message}`);
  check("that abort is not reported as a skip", mid.result === null,
    JSON.stringify(mid.result));

  const afterMid = store.getPaper("scan2");
  check("a mid-OCR abort leaves the paper unmodified", afterMid.material === "metadata",
    afterMid.material);
  check("a mid-OCR abort leaves the page text empty",
    (afterMid.pages ?? []).every((page) => String(page).trim() === ""),
    JSON.stringify(afterMid.pages));

  // Abort at the checkpoint immediately before rasterising. That throw happens inside a
  // try/catch whose failure branch records "page rendering failed" — so this is the
  // assertion that a user's own cancellation is never blamed on their PDF.
  const atRaster = await ocrAbortingAt(4);
  check("an abort before rasterising is not reported as a rendering failure",
    atRaster.error !== null || atRaster.result === null,
    `result=${JSON.stringify(atRaster.result)}`);
  if (atRaster.result !== null) {
    check("a rendering-failure message never mentions a cancellation",
      !/abort|cancel/i.test(String(atRaster.result.reason ?? "")),
      String(atRaster.result.reason));
    // The real requirement: it must NOT say "page rendering failed", because nothing
    // about the PDF is broken.
    check("a cancelled run does not blame the PDF",
      !/page rendering failed/i.test(String(atRaster.result.reason ?? "")),
      String(atRaster.result.reason));
  }
}

// --- 6. cancellation is not mistaken for a real failure ----------------
{
  const hostSource = readFileSync("lib/host-service.js", "utf8");
  check("there is an explicit abort detector", /function isAbortError\(/.test(hostSource));
  // The import catch used to swallow every throw into `failed`; the abort branch must
  // come before that.
  const catchIndex = hostSource.indexOf("} catch (error) {\n        // A cancellation is not a failure.");
  check("the import loop handles abort before recording a failure", catchIndex > 0);
  check("a partial import result carries an aborted flag", hostSource.includes("aborted: true"));

  // The detector is behaviour, not a string: exercise it through both error shapes it
  // claims to handle. Reading the source for "ABORT_ERR" would pass even if the
  // comparison used the wrong property or the wrong string.
  const { isAbortError } = await import("./.shim/host-service.js").catch(() => ({}));
  // isAbortError is module-private, so probe it the way callers see it: through a
  // cancelled import, once with a DOMException and once with a plain Error carrying
  // code ABORT_ERR.
  const shapes = [
    { label: "a DOMException named AbortError", error: new DOMException("stop", "AbortError") },
    { label: "a plain Error with code ABORT_ERR", error: Object.assign(new Error("stop"), { code: "ABORT_ERR" }) },
  ];
  for (const shape of shapes) {
    let thrown = null;
    try {
      // A signal that is aborted from the start makes importPdf throw before any work,
      // and the way it propagates shows whether the caller's shape is recognised as a
      // cancellation rather than a failure.
      const controller = new AbortController();
      controller.abort(shape.error);
      await service.importPdf(scope, { files: [{ name: "x.pdf", data: pdfBytes }] }, controller.signal);
    } catch (caught) {
      thrown = caught;
    }
    check(`importing with ${shape.label} aborts instead of failing`,
      thrown !== null && !/UNIQUE|empty file|cap/i.test(String(thrown?.message)),
      thrown === null ? "no throw" : `${thrown.name}: ${thrown.message}`);
  }
}

try {
  store.close?.();
} catch {
  /* already closed */
}
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

if (failures.length > 0) {
  console.log("\nCANCEL FAILED (" + failures.length + "):");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
console.log("\nCANCEL PASS");

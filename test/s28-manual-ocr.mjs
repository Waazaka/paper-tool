// Manual OCR re-run, the configurable page cap, and anchor repair (PT-016).
//
// Three separate guarantees, each of which can fail while the happy path looks fine:
//   1. The import cap stays 40 by default — raising it must be opt-in, because the
//      original reason (OCR runs synchronously while the user waits) is still true.
//   2. A manual re-run may exceed the import cap but not by an unbounded amount, and the
//      refusal message quotes the cap that was actually applied, not a hardcoded 40.
//   3. Replacing page text invalidates every character offset anchored into the old text.
//      Evidence and annotations must keep their quote and be re-anchored, or be marked
//      lost — never silently deleted, and never left pointing at a stale offset.
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadService } from "./shim.mjs";

// The two rules this gate checks are imported from the Host rather than reimplemented.
// Reimplementing them would test the test: a gate that copies the logic agrees with
// itself no matter what the product does. The shim returns the whole module namespace,
// so the exported helpers come back alongside the service class.
const hostModule = await loadService();
const { resolveOcrPageCap, locateQuote, PaperToolService } = hostModule;

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else {
    console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail));
    failures.push(name);
  }
}

const dir = mkdtempSync(join(tmpdir(), "ocr16-"));

function makeService(config = {}) {
  return new PaperToolService({ inject() {}, get() {} }, { homeDir: dir, ...config });
}

const service = makeService();
const scope = { sessionId: "ocr16", workspaceRoot: dir };
const store = service.storeFor(scope);

// --- 1. the default cap is still 40 -----------------------------------
{
  const serviceDefault = makeService();
  check("the default cap is 40 when nothing is configured",
    serviceDefault.config?.maxOcrPages === undefined,
    String(serviceDefault.config?.maxOcrPages));
  // The constant is still the fallback; it must not have been raised or deleted.
  const host = readFileSync("lib/host-service.js", "utf8");
  check("MAX_OCR_PAGES constant still exists", /const MAX_OCR_PAGES = 40;/.test(host));
  // The rule is exercised through the exported function, not by reading the source: a
  // regex over `clampInt(...)` would pass even if the branches were swapped.
  check("no config means the 40-page default",
    resolveOcrPageCap(undefined, undefined) === 40, String(resolveOcrPageCap(undefined, undefined)));
  check("an empty config means the 40-page default",
    resolveOcrPageCap({}, undefined) === 40, String(resolveOcrPageCap({}, undefined)));
  // A nonsense value must fall back, not disable OCR: 0 would otherwise mean "never".
  check("maxOcrPages 0 falls back to the default",
    resolveOcrPageCap({ maxOcrPages: 0 }, undefined) === 40,
    String(resolveOcrPageCap({ maxOcrPages: 0 }, undefined)));
  check("a non-numeric maxOcrPages falls back to the default",
    resolveOcrPageCap({ maxOcrPages: "many" }, undefined) === 40,
    String(resolveOcrPageCap({ maxOcrPages: "many" }, undefined)));
  check("a negative maxOcrPages falls back to the default",
    resolveOcrPageCap({ maxOcrPages: -5 }, undefined) === 40,
    String(resolveOcrPageCap({ maxOcrPages: -5 }, undefined)));
  check("an absurdly large maxOcrPages is clamped",
    resolveOcrPageCap({ maxOcrPages: 1e9 }, undefined) === 5000,
    String(resolveOcrPageCap({ maxOcrPages: 1e9 }, undefined)));
}

// --- 2. the refusal message quotes the applied cap ---------------------
{
  // A per-run cap wins over the configured one, which is what lets the manual re-run use
  // a bigger limit than an import does.
  check("a per-run cap overrides the configured value",
    resolveOcrPageCap({ maxOcrPages: 7 }, 400) === 400,
    String(resolveOcrPageCap({ maxOcrPages: 7 }, 400)));
  check("the configured value applies when no per-run cap is given",
    resolveOcrPageCap({ maxOcrPages: 7 }, undefined) === 7,
    String(resolveOcrPageCap({ maxOcrPages: 7 }, undefined)));
  // The message the user sees must name the cap that was actually applied. Assert that the
  // message is built from the resolved value rather than the constant — a message that
  // always says 40 while the applied cap is 7 tells the user the wrong number.
  const host = readFileSync("lib/host-service.js", "utf8");
  // The helper is an ordinary method, not `#runOcr`: a Remote method that calls a
  // `#private` member fails at RPC time because the gateway dispatches on a derived
  // receiver (see s47). Slice on the current name.
  const runOcrAt = host.indexOf("async runOcrInternal(");
  check("the OCR helper is findable by name", runOcrAt >= 0, String(runOcrAt));
  const runOcr = host.slice(runOcrAt, host.indexOf("async ocrPaper("));
  check("the skip message interpolates the resolved cap",
    /more than the \$\{maxOcrPages\}-page OCR cap/.test(runOcr));
  check("the skip message does not hardcode the constant",
    !/more than the \$\{MAX_OCR_PAGES\}/.test(runOcr));
}

// --- 3. the manual cap exceeds the import cap but stays finite --------
{
  const host = readFileSync("lib/host-service.js", "utf8");
  const manualCap = /const MANUAL_OCR_CAP = (\d+);/.exec(host);
  check("the manual re-run declares its own cap", manualCap !== null);
  const value = Number(manualCap?.[1] ?? 0);
  check("the manual cap is larger than the import cap", value > 40, String(value));
  // Finite on purpose: unbounded OCR of a 3000-page scan is minutes of no feedback.
  check("the manual cap is finite", value > 0 && value <= 5000, String(value));
  check("ocrPaper passes the manual cap to the recogniser",
    /this\.runOcrInternal\(bytes, extracted, signal, MANUAL_OCR_CAP\)/.test(host));
}

// --- 4. re-running OCR repairs anchors instead of dropping them -------
{
  store.upsertPaper({
    paperId: "p-ocr", title: "Scanned dissertation", authors: "Li", year: "2020",
    venue: "", doi: "", source: "import", pdfPath: "", fingerprint: "f-ocr",
    // The state after an import that could not OCR: metadata only, empty pages.
    material: "metadata", pages: ["", "", ""], pageSources: ["none", "none", "none"],
  });
  store.addEvidence({
    evidenceId: "ev-ocr-1",
    paperId: "p-ocr", pageIndex: 0, charStart: -1, charEnd: -1,
    quote: "citizenship behaviour is shaped by the servicescape",
  });
  store.addEvidence({
    evidenceId: "ev-ocr-2",
    paperId: "p-ocr", pageIndex: 0, charStart: -1, charEnd: -1,
    quote: "a quote that will not appear in the recognised text at all",
  });
  store.upsertAnnotation({
    annotationId: "ann-ocr", paperId: "p-ocr", pageIndex: 0, charStart: -1, charEnd: -1,
    // Quoted exactly as the recognised text will spell it. locateQuote is case-sensitive
    // on purpose — a quote that differs in case is not the same string, and treating it
    // as a match would put the anchor on a passage the user never selected.
    quote: "Customer engagement mediates", note: "my note", tags: ["重点"], color: "yellow",
  });

  // Simulate the text the recogniser would produce, then run the same repair the Host
  // runs after a successful re-run. Testing the repair rather than driving a real OCR
  // keeps this gate fast and corpus-free; the wiring (that ocrPaper calls it) is asserted
  // separately by reading the source.
  const recognised = [
    "The servicescape shapes how citizenship behaviour is shaped by the servicescape in hotels.",
    "Customer engagement mediates the relationship between the two constructs.",
    "",
  ];
  const locate = (quote) => {
    for (let index = 0; index < recognised.length; index += 1) {
      // locateQuote is the Host's own matcher; importing it keeps this gate honest about
      // whitespace handling instead of reimplementing a weaker version.
      const anchor = locateQuote(recognised[index] ?? "", quote);
      if (anchor !== null) return { pageIndex: index, charStart: anchor.start, charEnd: anchor.end };
    }
    return null;
  };

  const evidenceResult = store.reanchorEvidence("p-ocr", locate);
  check("every evidence row is accounted for", evidenceResult.total === 2,
    String(evidenceResult.total));
  check("the locatable quote is re-anchored", evidenceResult.relocated === 1,
    String(evidenceResult.relocated));
  check("the unlocatable quote is reported lost", evidenceResult.lost === 1,
    String(evidenceResult.lost));

  const rows = store.listEvidence({ paperId: "p-ocr" });
  const moved = rows.find((r) => r.quote.includes("citizenship behaviour"));
  const lost = rows.find((r) => r.quote.includes("will not appear"));
  check("the re-anchored row now points at a real page", moved?.pageIndex === 0, String(moved?.pageIndex));
  check("the re-anchored row has a real character offset", (moved?.charStart ?? -1) >= 0,
    String(moved?.charStart));
  // Verify the offset against the text it claims to point into.
  const sliced = recognised[moved.pageIndex].slice(moved.charStart, moved.charEnd);
  check("the re-anchored offset slices back to the quote", sliced === moved.quote, JSON.stringify(sliced));
  check("the lost row is kept, not deleted", lost !== undefined);
  check("the lost row is marked with charStart -1", lost?.charStart === -1, String(lost?.charStart));
  check("the lost row is marked with charEnd -1", lost?.charEnd === -1, String(lost?.charEnd));
  check("the lost row keeps its quote", lost?.quote.includes("will not appear"));
  check("both rows still exist", rows.length === 2, String(rows.length));

  const annResult = store.reanchorAnnotations("p-ocr", locate);
  check("the annotation with a quote is re-anchored", annResult.relocated === 1,
    String(annResult.relocated));
  const ann = store.getAnnotation("ann-ocr");
  check("the annotation's note survives the repair", ann?.note === "my note", String(ann?.note));
  check("the annotation keeps its tags", JSON.stringify(ann?.tags) === JSON.stringify(["重点"]),
    JSON.stringify(ann?.tags));
  check("the annotation's anchor moved to the recognised text", (ann?.charStart ?? -1) >= 0,
    String(ann?.charStart));

  // The same -1 sentinel must apply to annotations, not just to evidence. Without this,
  // a repair that guessed an offset for an unlocatable annotation would pass: the note is
  // still there, its tags are still there, only the anchor silently points somewhere else.
  store.upsertAnnotation({
    annotationId: "ann-lost", paperId: "p-ocr", pageIndex: 0, charStart: -1, charEnd: -1,
    quote: "this annotation's quote is gone too", note: "n", tags: [], color: "yellow",
  });
  store.reanchorAnnotations("p-ocr", locate);
  const lostAnn = store.getAnnotation("ann-lost");
  check("an unlocatable annotation is marked charStart -1", lostAnn?.charStart === -1,
    String(lostAnn?.charStart));
  check("an unlocatable annotation is marked charEnd -1", lostAnn?.charEnd === -1,
    String(lostAnn?.charEnd));
  check("an unlocatable annotation is kept, not deleted", lostAnn !== null);
  check("an unlocatable annotation keeps its quote",
    String(lostAnn?.quote).includes("gone too"), String(lostAnn?.quote));
}

// --- 5. a pure note annotation is not disturbed by the repair ---------
{
  store.upsertAnnotation({
    annotationId: "ann-note-only", paperId: "p-ocr", pageIndex: 1, charStart: 5, charEnd: 9,
    quote: "", note: "a thought with no selected text", tags: [], color: "yellow",
  });
  const before = store.getAnnotation("ann-note-only");
  store.reanchorAnnotations("p-ocr", () => null);
  const after = store.getAnnotation("ann-note-only");
  // Its anchor was never derived from a quote, so a repair that cannot locate anything
  // must leave it exactly as it was rather than marking it lost.
  check("a note-only annotation keeps its page", after?.pageIndex === before.pageIndex,
    `${before?.pageIndex} -> ${after?.pageIndex}`);
  check("a note-only annotation keeps its offsets", after?.charStart === before.charStart,
    `${before?.charStart} -> ${after?.charStart}`);
  // A note-only annotation is counted in `total` (it is a row of this paper) but must not
  // be reported in `lost` — its anchor was never derived from a quote, so "could not
  // locate the quote" is not true of it. Asserting the arithmetic rather than a fixed
  // number keeps this honest as other annotations are added above.
  const noteOnlyRepair = store.reanchorAnnotations("p-ocr", () => null);
  check("a note-only annotation is counted in total", noteOnlyRepair.total > 0,
    String(noteOnlyRepair.total));
  check("a note-only annotation is not reported as lost by the repair",
    noteOnlyRepair.lost === noteOnlyRepair.total - 1,
    `total ${noteOnlyRepair.total}, lost ${noteOnlyRepair.lost} — exactly one row (the note-only one) is exempt`);
}

// --- 6. ocrPaper actually calls the repair -----------------------------
{
  const host = readFileSync("lib/host-service.js", "utf8");
  const block = host.slice(host.indexOf("async ocrPaper("), host.indexOf("async status("));
  check("ocrPaper re-anchors evidence after replacing page text",
    /store\.reanchorEvidence\(paperId, locate\)/.test(block));
  check("ocrPaper re-anchors annotations too",
    /store\.reanchorAnnotations\(paperId, locate\)/.test(block));
  check("the repair runs after the page text is written",
    block.indexOf("upsertPaper") < block.indexOf("reanchorEvidence"));
  check("the repair result is reported to the caller",
    /reanchored: \{ evidence: evidenceReanchor, annotations: annotationReanchor \}/.test(block));
  // The three-state model has no "half recognised" state, so a cancelled or failed run
  // must not write pages. Assert the write is still guarded by a successful result.
  check("the page write is guarded by a successful recognition",
    /if \(ocr === null\) \{\s*\n\s*return \{ paperId, skipped: true/.test(block));
}

// --- 7. the UI reaches ocrPaper ---------------------------------------
{
  const client = readFileSync("client.js", "utf8");
  check("the client calls ocrPaper", /callRemote\(sessionId, "ocrPaper"/.test(client));
  check("ocrPaper is listed in INPUT_METHODS", /"ocrPaper"/.test(
    client.slice(client.indexOf("const INPUT_METHODS"), client.indexOf("]);", client.indexOf("const INPUT_METHODS"))),
  ));
  // The button must be scoped: on a fulltext paper OCR would replace correct text with
  // guesses, and the Host refuses it — so offering the button would invite a refusal.
  check("the re-run button is scoped to material === metadata",
    /paper\.material === "metadata" && hasPdf/.test(client));
  check("the button is wired to reocrOne", /onReocr: reocrOne/.test(client));
  check("PaperCard accepts onReocr", /function PaperCard\(\{[^}]*onReocr/.test(client));
  check("re-running OCR is cancellable", /runCancellable\(t\("busyStageOcr"\)/.test(client));
  check("a cancelled re-run is not reported as an error",
    /isAbortError\(reocrError\)/.test(client));
  // The outcome is shown, including how many anchors were lost — otherwise the user finds
  // out only when a quote stops highlighting.
  check("the result reports re-anchored anchors", /reocrDone/.test(client));
  check("the reocrDone string mentions lost anchors", /reocrDone: "[^"]*\{lost\}/.test(client));
}

// --- 8. capability is a RPC, not a new tool (D-013/D-014) -------------
{
  const tools = readFileSync("lib/tools.js", "utf8");
  const names = [...tools.matchAll(/name: "(paper_\w+)"/g)].map((m) => m[1]);
  check("still exactly six tools", names.length === 6, JSON.stringify(names));
  check("no ocr tool was added", !names.includes("paper_ocr"));
  const host = readFileSync("lib/host-service.js", "utf8");
  const markRemoteBlock = host.slice(host.indexOf("for (const method of ["));
  check("ocrPaper is a registered RPC", markRemoteBlock.includes('"ocrPaper"'));
}

try {
  store.close?.();
} catch {
  /* closed */
}
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

if (failures.length > 0) {
  console.log("\nMANUAL-OCR FAILED (" + failures.length + "):");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
console.log("\nMANUAL-OCR PASS");

// S2 host-layer gate: exercise the real service methods without a browser.
//
// The sidebar UI cannot be asserted from here, but every operation it calls
// goes through these methods, so this pins the contract the UI depends on.
//
// One section covers attaching a PDF to a bibliography-only row, because that is
// the one import shape that must NOT create a paper: it updates an existing id in
// place, and every refusal (second attach, bytes already linked elsewhere) has to
// leave the library byte-for-byte unchanged.
//
// Run: node test/s2-host.mjs <pdfDir>
import { readdirSync, readFileSync, statSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
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

// --- refusal shorthands -------------------------------------------------
// A refusal may legitimately arrive three ways: a thrown typed error, a `failed`
// entry, or a `duplicates` entry. All three say "I did not do this"; what must
// never happen is a silent success. The attach section below therefore checks the
// shape once here and then concentrates on "nothing changed".
function describe(outcome) {
  if (outcome.error !== undefined) return `${outcome.error.code ?? outcome.error.name}: ${outcome.error.message}`;
  return JSON.stringify({
    imported: (outcome.value?.imported ?? []).length,
    duplicates: outcome.value?.duplicates ?? [],
    failed: outcome.value?.failed ?? [],
  }).slice(0, 300);
}
const refused = (outcome) => outcome.error !== undefined ||
  (outcome.value?.imported ?? []).length === 0 ||
  (outcome.value?.duplicates ?? []).length > 0 ||
  (outcome.value?.failed ?? []).length > 0;
// A raw SQLite message leaking through a refusal would be a bug in itself: the UI
// shows it verbatim to the user. Every refusal must be a typed `paper-tool/*` code
// or a per-file reported reason.
const typedRefusal = (outcome) => {
  if (outcome.error !== undefined) return typeof outcome.error.code === "string" && outcome.error.code.startsWith("paper-tool/");
  if ((outcome.value?.failed ?? []).length > 0) return outcome.value.failed.every((row) => typeof row.reason === "string" && row.reason !== "");
  return (outcome.value?.duplicates ?? []).length > 0;
};

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

// --- attaching a PDF to a bibliography-only row -------------------------
// Bytes for the attach come from a real corpus PDF plus a trailing comment after
// %%EOF: a PDF tolerates that, so the result is a distinct fingerprint that still
// extracts, with no new fixture file. A third corpus paper is preferred as the
// base so the attach exercises a document that was never imported by this gate;
// falls back to the first one on a one- or two-PDF corpus, where the padding alone
// still makes the bytes distinct from anything already stored.
const ATTACH_BASE = readFileSync(pdfs[2] ?? pdfs[0]);
const ATTACH_BYTES = Array.from(
  Buffer.concat([ATTACH_BASE, Buffer.from("\n% s2 attach-gate padding, not part of the document\n")]),
);
// A second distinct PDF for the "already has a PDF" refusal. It must not collide
// with any fingerprint in the library, or the refusal could be explained by the
// bytes alone and prove nothing about the target's state.
const SECOND_BYTES = Array.from(
  Buffer.concat([ATTACH_BASE, Buffer.from("\n% s2 attach-gate padding, second document variant\n")]),
);
// A metadata-only entry (imported from .bib/.ris, no file) is the target shape:
// the user picked one existing row and expects its PDF attached, not a second row
// holding the same paper. Every failure path here must also prove the row was not
// touched, because a half-attached row would show a PDF it cannot read.
{
  // A row with no PDF, its own title and DOI distinct from the imported paper —
  // distinct so nothing can pass by silently matching the already-imported file.
  const bib = [
    "@article{attachtarget,",
    "  title = {Attach Target Bibliography Entry},",
    "  author = {Example, Alice},",
    "  year = {2020},",
    "  journal = {Journal of Attach Contracts},",
    "  doi = {10.5555/attach.target}",
    "}",
  ].join("\n");
  const seeded = await service.importCitations(scope, { fileName: "attach.bib", text: bib });
  const targetId = seeded.imported[0]?.paperId;
  check("a bibliography-only row is available to attach onto", typeof targetId === "string", JSON.stringify(seeded.imported));
  // Guarded so a broken seed reports as failures instead of crashing the gate with
  // a stack trace from a store lookup whose key does not exist.
  const before = typeof targetId === "string" ? service.storeFor(scope).getPaper(targetId) : null;
  check("the target row starts with no PDF", before !== null && before.pdfPath === "" && before.material === "metadata",
    JSON.stringify({ pdfPath: before?.pdfPath, material: before?.material }));
  check("the target keeps its own metadata", before !== null && before.title === "Attach Target Bibliography Entry" &&
    before.doi === "10.5555/attach.target", JSON.stringify({ title: before?.title, doi: before?.doi }));
  check("the target starts with no indexed pages", before !== null && before.numPages === 0, String(before?.numPages));
  const countBefore = service.storeFor(scope).stats().papers;

  const attached = await service.importPdf(scope, {
    targetPaperId: targetId,
    files: [{ name: "attach-target.pdf", data: ATTACH_BYTES }],
    enrich: false,
  }).then((value) => ({ value }), (error) => ({ error }));
  const attachOk = attached.error === undefined && Array.isArray(attached.value?.imported) && attached.value.imported.length === 1;
  check("attaching onto a bibliography row succeeds", attachOk,
    attached.error === undefined ? JSON.stringify(attached.value?.failed ?? attached.value) : attached.error.message);
  const attachedRow = attachOk ? attached.value.imported[0] : {};
  check("the attach reports the target's paperId, not a new one", attachedRow.paperId === targetId,
    `${attachedRow.paperId} vs ${targetId}`);
  check("the attach adds no paper to the library", attachOk && attached.value.library.papers === countBefore,
    JSON.stringify({ before: countBefore, after: attached.value?.library?.papers }));
  check("the attach creates no duplicate row", attachOk && (attached.value.duplicates ?? []).length === 0,
    JSON.stringify(attached.value?.duplicates));

  // Null-guarded reads throughout: a failed seed must report as FAILs, not abort
  // the gate with a stack trace that hides every assertion after it.
  const rowOf = (id) => (typeof id === "string" ? service.storeFor(scope).getPaper(id) : null);
  const after = rowOf(targetId) ?? {};
  check("the confirmed bibliography metadata survives the attach",
    before !== null && after.title === before.title && after.doi === before.doi && after.authors === before.authors &&
      after.year === before.year && after.venue === before.venue,
    JSON.stringify({ title: after.title, doi: after.doi, authors: after.authors, year: after.year, venue: after.venue }));
  check("the target now holds a stored PDF", typeof after.pdfPath === "string" && after.pdfPath !== "" && existsSync(after.pdfPath), after.pdfPath);
  check("the target is no longer metadata-only", after.material === "fulltext" || after.material === "ocr", after.material);
  check("the attach indexed pages", after.numPages > 0, String(after.numPages));

  // Readable once, through the ordinary reader path: a stored path that does not
  // open would make the row look attached and then fail on the first page turn.
  const readAfter = await service.readPaper(scope, { paperId: targetId, fromPage: 0, toPage: 2 })
    .then((value) => value, () => ({ paper: {}, pages: [] }));
  check("the attached paper is readable", readAfter.paper.paperId === targetId && readAfter.pages.some((page) => page.text.length > 20),
    JSON.stringify(readAfter.pages.map((page) => page.text.length)));
  // A refusal to serve bytes is a legitimate failure to report, not a crash: the
  // gate must keep running so the remaining assertions still produce a verdict.
  const bytesAfter = await service.readPaperBytes(scope, { paperId: targetId })
    .then((value) => ({ value }), (error) => ({ error }));
  check("the attached PDF's bytes are readable", bytesAfter.error === undefined && bytesAfter.value.bytes > 1000 &&
    String.fromCharCode(...new Uint8Array(bytesAfter.value.data).slice(0, 5)) === "%PDF-",
    bytesAfter.error?.code ?? String(bytesAfter.value?.bytes));
  // The probe word comes from the attached page itself, so the assertion does not
  // depend on which corpus PDF the machine happens to have.
  const probeWord = (readAfter.pages.find((page) => page.text.length > 20)?.text ?? "")
    .split(/[^\p{L}\p{N}]+/u)
    .find((word) => word.length >= 6) ?? "";
  const searchAfter = probeWord === "" ? { hits: [] } : await service.search(scope, { query: probeWord });
  check("the attached text is searchable", searchAfter.hits.some((hit) => hit.paperId === targetId),
    JSON.stringify({ probeWord, hits: searchAfter.hits.map((hit) => hit.paperId) }));

  // Second attach on the same target must be refused: one paper, one PDF. A silent
  // success here would overwrite the file the reader is currently showing.
  const snapshot = () => {
    const row = rowOf(targetId) ?? {};
    return JSON.stringify({
      title: row.title, doi: row.doi, authors: row.authors, year: row.year, venue: row.venue,
      pdfPath: row.pdfPath, material: row.material, numPages: row.numPages,
      pages: service.storeFor(scope).stats().pages,
      papers: service.storeFor(scope).stats().papers,
      fileBytes: typeof row.pdfPath === "string" && row.pdfPath !== "" && existsSync(row.pdfPath)
        ? statSync(row.pdfPath).size
        : 0,
    });
  };
  const beforeSecond = snapshot();
  const second = await service.importPdf(scope, {
    targetPaperId: targetId,
    files: [{ name: "second.pdf", data: SECOND_BYTES }],
    enrich: false,
  }).then((value) => ({ value }), (error) => ({ error }));
  check("a second PDF cannot be attached to the same paper", refused(second), describe(second));
  check("the refusal is a typed refusal, not a raw database error", typedRefusal(second), describe(second));
  check("the refused second attach left the row unchanged", snapshot() === beforeSecond,
    `${beforeSecond} -> ${snapshot()}`);

  // Bytes already linked to one paper must not be linked to a second: the
  // fingerprint index is what makes "one document, one row" true, and attaching is
  // the one path that could otherwise bypass it.
  const otherSeeded = await service.importCitations(scope, {
    fileName: "other.bib",
    text: "@article{othertarget,\n  title = {Second Bibliography Entry},\n  author = {Example, Bob},\n  year = {2021},\n  journal = {Journal of Attach Contracts},\n  doi = {10.5555/attach.other}\n}",
  });
  const otherId = otherSeeded.imported[0]?.paperId;
  const beforeOther = rowOf(otherId) ?? {};
  const countBeforeOther = service.storeFor(scope).stats().papers;
  const collision = await service.importPdf(scope, {
    targetPaperId: otherId,
    files: [{ name: "collide.pdf", data: ATTACH_BYTES }],
    enrich: false,
  }).then((value) => ({ value }), (error) => ({ error }));
  check("bytes already linked to one paper cannot attach to another", refused(collision), describe(collision));
  check("the collision refusal is typed, not a raw database error", typedRefusal(collision), describe(collision));
  const afterOther = rowOf(otherId) ?? {};
  check("the refused collision left the second row metadata-only",
    afterOther.pdfPath === "" && afterOther.material === "metadata" && afterOther.numPages === 0,
    JSON.stringify({ pdfPath: afterOther.pdfPath, material: afterOther.material, numPages: afterOther.numPages }));
  check("the refused collision did not rewrite the confirmed metadata",
    afterOther.title === beforeOther.title && afterOther.doi === beforeOther.doi, JSON.stringify({ title: afterOther.title, doi: afterOther.doi }));
  check("the refused collision added no row", service.storeFor(scope).stats().papers === countBeforeOther,
    `${countBeforeOther} -> ${service.storeFor(scope).stats().papers}`);
  // Computed here rather than read back from the response: the assertion is that
  // the bytes on disk are keyed to this row, and metadata-only rows also carry an
  // empty fingerprint, so "matching the row" would match every un-attached entry.
  const attachFingerprint = createHash("sha256").update(Uint8Array.from(ATTACH_BYTES)).digest("hex").slice(0, 32);
  const holders = service.storeFor(scope).listPapers({ limit: 500 })
    .filter((row) => row.fingerprint === attachFingerprint);
  check("exactly one row holds the attached bytes", holders.length === 1 && holders[0].paperId === targetId,
    JSON.stringify(holders.map((row) => row.paperId)));

  // --- a cancelled attach leaves neither a row nor a file ---------------
  // The targeted path has exactly two cancellation checkpoints, and that is read
  // out of the Host source before it is exercised rather than assumed: one before
  // extraction runs, one after the bytes are on disk but before the row points at
  // them. Aborting at the second is the case worth pinning — the file already
  // exists by then, so the only acceptable outcome is that it is removed again and
  // the row stays exactly as it was, still metadata-only and still attachable.
  const hostSource = readFileSync(join(import.meta.dirname, "..", "lib", "host-service.js"), "utf8");
  const importStart = hostSource.indexOf("async importPdf(");
  const attachStart = hostSource.indexOf("if (targetPaperId !== null) {", importStart);
  const attachEnd = hostSource.indexOf("// Re-importing a file the library already holds", attachStart);
  const targetedSource = attachStart >= 0 && attachEnd > attachStart
    ? hostSource.slice(attachStart, attachEnd)
    : "";
  check("the targeted import path is inspectable in the Host source", targetedSource !== "",
    `${attachStart}..${attachEnd}`);
  // "Two places" is counted over everything a targeted call can reach, which stops
  // just before the non-targeted tail of the function (the attach `continue`s before
  // it): the per-file loop top and the one inside the attach branch. A third call
  // site appearing there would mean a checkpoint moved without this gate noticing.
  const targetedPrefix = hostSource.slice(importStart, attachEnd);
  const reachable = (targetedPrefix.match(/signal\?\.throwIfAborted\(\)/g) ?? []).length;
  check("a targeted import has exactly two reachable cancellation checkpoints", reachable === 2, String(reachable));
  // The cancellation case below must not be explained by OCR: it pins the
  // text-layer path, where the second checkpoint sits right after the file write.
  check("the attach-base PDF has its own text layer, so no OCR is in play",
    rowOf(targetId)?.textSource === "text-layer", String(rowOf(targetId)?.textSource));
  const inBranch = (targetedSource.match(/signal\?\.throwIfAborted\(\)/g) ?? []).length;
  check("the commit-adjacent checkpoint lives inside the attach branch", inBranch === 1, String(inBranch));
  const commitAt = targetedSource.indexOf("committed = true;");
  const branchAbortAt = targetedSource.lastIndexOf("signal?.throwIfAborted()");
  check("that checkpoint precedes the commit, so a cancel is still a clean no-op",
    commitAt > 0 && branchAbortAt > 0 && branchAbortAt < commitAt, `${branchAbortAt} vs ${commitAt}`);

  // Bytes that are neither in the library nor equal to any earlier attach: the
  // same base PDF plus a third distinct trailing note. A fingerprint collision
  // would refuse the attach for the wrong reason and prove nothing about
  // cancellation, so the distinctness is asserted rather than hoped for.
  const CANCEL_ATTACH_BYTES = Array.from(
    Buffer.concat([ATTACH_BASE, Buffer.from("\n% s2 attach-gate padding, cancelled attach variant\n")]),
  );
  const cancelFingerprint = createHash("sha256").update(Uint8Array.from(CANCEL_ATTACH_BYTES)).digest("hex").slice(0, 32);
  check("the cancelled-attach bytes are not already in the library",
    service.storeFor(scope).listPapers({ limit: 500 }).every((row) => row.fingerprint !== cancelFingerprint));

  // The signal is a counting proxy around a real AbortController — the same
  // shape s25-cancel uses — so the abort fires on the second consult, and the
  // throw ends the call there. With a text-layer base (what this gate uses) the
  // second consult is the checkpoint between "file written" and "row committed",
  // which is the one that can leak a file; on a scanned base it would land inside
  // OCR, before any file exists. Either way the row and the directory must be
  // untouched, which is what the assertions below require.
  let consults = 0;
  const controller = new AbortController();
  const counting = {
    get aborted() { return controller.signal.aborted; },
    get reason() { return controller.signal.reason; },
    throwIfAborted() {
      consults += 1;
      if (consults >= 2) controller.abort(new DOMException("cancelled by test", "AbortError"));
      controller.signal.throwIfAborted();
    },
    addEventListener(...args) { return controller.signal.addEventListener(...args); },
    removeEventListener(...args) { return controller.signal.removeEventListener(...args); },
  };
  const listFilesDir = () => {
    try { return readdirSync(service.filesDir(scope)).sort(); } catch { return []; }
  };
  const filesBeforeCancel = listFilesDir();
  // The attach above already put a file here, so a non-empty listing proves the
  // comparison below is real: comparing two empty listings would pass whether the
  // cleanup ran or the directory was never read.
  check("the files directory is listable and already holds the earlier attach",
    filesBeforeCancel.length >= 1, JSON.stringify(filesBeforeCancel));
  const countBeforeCancel = service.storeFor(scope).stats().papers;
  const cancelled = await service.importPdf(scope, {
    targetPaperId: otherId,
    // Text layer, so no OCR runs, and no enrichment: the only work left between
    // the two checkpoints is extraction and the file write.
    files: [{ name: "cancelled.pdf", data: CANCEL_ATTACH_BYTES }],
    enrich: false,
  }, counting).then((value) => ({ value }), (error) => ({ error }));
  check("cancelling an attach reaches exactly the second checkpoint", consults === 2, String(consults));
  check("a cancelled attach is refused instead of silently completing", refused(cancelled), describe(cancelled));
  check("the cancellation is recognisable as an abort, not a failure",
    cancelled.error !== undefined &&
      (cancelled.error.name === "AbortError" || /abort/i.test(String(cancelled.error.message))),
    describe(cancelled));

  const afterCancel = rowOf(otherId) ?? {};
  check("the cancelled attach leaves the row unattached",
    afterCancel.pdfPath === "" && afterCancel.material === "metadata" && afterCancel.numPages === 0 &&
      afterCancel.fingerprint === "",
    JSON.stringify({
      pdfPath: afterCancel.pdfPath, material: afterCancel.material,
      numPages: afterCancel.numPages, fingerprint: afterCancel.fingerprint,
    }));
  check("the cancelled attach does not change the confirmed metadata",
    afterCancel.title === beforeOther.title && afterCancel.doi === beforeOther.doi,
    JSON.stringify({ title: afterCancel.title, doi: afterCancel.doi }));
  check("the cancelled attach adds no row", service.storeFor(scope).stats().papers === countBeforeCancel,
    `${countBeforeCancel} -> ${service.storeFor(scope).stats().papers}`);
  // The file is written before the second checkpoint, so this is the assertion
  // that the cleanup path actually removes it instead of leaking one PDF per
  // cancelled attach into the files directory, where no row would ever find it.
  const filesAfterCancel = listFilesDir();
  check("the cancelled attach leaves no new file in the files directory",
    JSON.stringify(filesAfterCancel) === JSON.stringify(filesBeforeCancel),
    JSON.stringify({ added: filesAfterCancel.filter((name) => !filesBeforeCancel.includes(name)) }));
}

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
// Counted rather than hard-coded: the attach section above leaves its own rows in
// the library, and this assertion is about "one row fewer", not about a total.
const papersBeforeDelete = service.storeFor(scope).stats().papers;
const deleted = await service.deletePaper(scope, { paperId });
check("delete reports the id", deleted.deleted === paperId);
check("library shrank", deleted.library.papers === papersBeforeDelete - 1,
  `${papersBeforeDelete} -> ${deleted.library.papers}`);
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

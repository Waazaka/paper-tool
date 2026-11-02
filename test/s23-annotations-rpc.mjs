// RPC layer for annotations: the paths the client actually calls.
//
// Separate from s22 (which tests the store directly) because the interesting
// behaviour here is the refusal policy: no empty annotations, no unknown papers,
// no promoting a note-only annotation into fake evidence.
import { mkdtempSync, rmSync } from "node:fs";
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
async function refused(promiseFactory) {
  try {
    await promiseFactory();
    return null;
  } catch (error) {
    return error;
  }
}

const dir = mkdtempSync(join(tmpdir(), "annot-rpc-"));
const { PaperToolService } = await loadService();
const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: dir });
const scope = { sessionId: "annot-rpc", workspaceRoot: dir };

service.storeFor(scope).upsertPaper({
  paperId: "p1", title: "Servicescape", authors: "Li", year: "2021", venue: "IJCHM",
  doi: "10.1/p1", source: "test", pdfPath: "", fingerprint: "f1", material: "fulltext",
  pages: ["Servicescape shapes customer citizenship behaviour in hotels through engagement."],
  pageSources: ["text-layer"],
});
const TEXT = "Servicescape shapes customer citizenship behaviour in hotels through engagement.";

// --- save + list ---------------------------------------------------------
const saved = await service.saveAnnotation(scope, {
  paperId: "p1", pageIndex: 0, charStart: 0, charEnd: 47,
  quote: "Servicescape shapes customer citizenship behaviour",
  note: "这是我自己的批注。", tags: ["机制"], color: "green",
});
check("saveAnnotation succeeds", saved.ok === true, JSON.stringify(saved.reason ?? saved));
check("saveAnnotation returns the stored row", saved.annotation?.annotationId?.startsWith("ann-"), saved.annotation?.annotationId);
check("saveAnnotation reports a per-paper total", saved.total === 1, String(saved.total));

const listed = await service.listAnnotations(scope, { paperId: "p1" });
check("listAnnotations returns it", listed.annotations.length === 1, String(listed.annotations.length));
check("listed annotation carries its anchor", listed.annotations[0].charStart === 0 && listed.annotations[0].charEnd === 47);
check("listed annotation carries its note", listed.annotations[0].note.includes("我自己的批注"));
check("listed annotation carries its tags", listed.annotations[0].tags.length === 1);
check("list count matches", listed.count === 1);

// --- the same selection saved twice updates instead of duplicating ------
const again = await service.saveAnnotation(scope, {
  paperId: "p1", pageIndex: 0, charStart: 0, charEnd: 47,
  quote: "Servicescape shapes customer citizenship behaviour", note: "改过的批注。",
});
check("saving the same anchor twice does not duplicate", again.total === 1, String(again.total));
check("it updated the note instead", again.annotation.note === "改过的批注。", again.annotation.note);

// --- refusals ------------------------------------------------------------
{
  const error = await refused(() => service.saveAnnotation(scope, { paperId: "ghost", quote: "x" }));
  check("annotation on an unknown paper is refused", error !== null);
  check("the refusal names the paper problem",
    String(error?.code ?? error?.message ?? "").includes("unknown-paper"),
    error?.code ?? error?.message);
}
{
  const error = await refused(() => service.saveAnnotation(scope, { paperId: "p1", quote: "   ", note: "" }));
  check("an annotation with neither quote nor note is refused", error !== null);
  check("the refusal names why",
    String(error?.code ?? error?.message ?? "").includes("empty-annotation"),
    error?.code ?? error?.message);
}
{
  const error = await refused(() =>
    service.saveAnnotation(scope, { paperId: "p1", pageIndex: -3, quote: "x" }));
  check("a negative pageIndex is refused", error !== null);
  check("the refusal names the anchor problem",
    String(error?.code ?? error?.message ?? "").includes("bad-anchor"),
    error?.code ?? error?.message);
}
{
  const error = await refused(() => service.deleteAnnotation(scope, {}));
  check("delete without an id is refused", error !== null);
}

// --- note-only annotation is allowed to exist but not to become evidence
const noteOnly = await service.saveAnnotation(scope, {
  paperId: "p1", pageIndex: 0, charStart: -1, charEnd: -1, quote: "", note: "整篇的感想，没有选原文。",
});
check("a note-only annotation is allowed", noteOnly.ok === true);
{
  const error = await refused(() =>
    service.promoteAnnotation(scope, { annotationId: noteOnly.annotation.annotationId }));
  check("promoting a note-only annotation is refused", error !== null);
  check("the refusal explains there is nothing to quote",
    String(error?.code ?? error?.message ?? "").includes("no-quote"),
    error?.code ?? error?.message);
}

// --- promote an annotation with a quote into real evidence --------------
{
  const before = service.storeFor(scope).stats();
  const promoted = await service.promoteAnnotation(scope, { annotationId: saved.annotation.annotationId });
  check("promoteAnnotation succeeds for a quoted annotation", promoted.ok === true);
  check("it produced an evidence row", typeof promoted.evidence?.evidenceId === "string" && promoted.evidence.evidenceId !== "");
  check("the evidence carries the annotation's anchor",
    promoted.evidence.charStart === 0 && promoted.evidence.charEnd === 47, JSON.stringify(promoted.evidence));
  check("the evidence carries the annotation's quote", promoted.evidence.quote === saved.annotation.quote);
  const after = service.storeFor(scope).stats();
  check("evidence count went up by one", after.evidence === before.evidence + 1,
    `${before.evidence} -> ${after.evidence}`);
  check("the annotation still exists after promotion (copy, not move)",
    service.storeFor(scope).getAnnotation(saved.annotation.annotationId) !== null);
  check("annotation count is unchanged by promotion", after.annotations === before.annotations);
}
{
  const before = service.storeFor(scope).stats().evidence;
  await service.promoteAnnotation(scope, { annotationId: saved.annotation.annotationId });
  const after = service.storeFor(scope).stats().evidence;
  check("promoting the same annotation twice does not add a second evidence row",
    after === before, `${before} -> ${after}`);
}

// --- stats / status report annotations separately -----------------------
const stats = service.storeFor(scope).stats();
check("stats reports annotations", stats.annotations === 2, String(stats.annotations));
check("stats reports evidence independently", stats.evidence === 1, String(stats.evidence));
{
  const status = await service.status(scope);
  check("paper_status surfaces the annotation count", status.library.annotations === 2,
    JSON.stringify(status.library.annotations));
}

// --- delete --------------------------------------------------------------
{
  const before = service.storeFor(scope).stats().annotations;
  const gone = await service.deleteAnnotation(scope, { annotationId: noteOnly.annotation.annotationId });
  check("deleteAnnotation reports the removal", gone.ok === true && gone.removed === true);
  check("the row is gone", service.storeFor(scope).stats().annotations === before - 1);
  // Deleting the same id again must report that nothing was there, not silently "ok".
  const second = await service.deleteAnnotation(scope, { annotationId: noteOnly.annotation.annotationId });
  check("deleting a nonexistent annotation reports removed:false", second.removed === false);
}

// --- deleting the paper removes its annotations (the cascade) -----------
{
  const before = service.storeFor(scope).stats().annotations;
  check("annotations exist before the paper is deleted", before > 0, String(before));
  service.storeFor(scope).db.exec("DELETE FROM papers WHERE paperId = 'p1'");
  const after = service.storeFor(scope).stats().annotations;
  check("deleting the paper cascaded to its annotations", after === 0, `${before} -> ${after}`);
  const orphans = service.storeFor(scope).db
    .prepare("SELECT COUNT(*) c FROM annotations WHERE paperId = 'p1'").get().c;
  check("no orphan annotation rows remain", orphans === 0, String(orphans));
}

// Close the store before removing the directory: on Windows an open SQLite handle
// makes rmdir fail with EPERM, and a cleanup crash after every assertion passed would
// report a green gate as a failure.
try {
  service.storeFor(scope).close?.();
} catch {
  /* already closed */
}
rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

if (failures.length > 0) {
  console.log("\nANNOTATIONS-RPC FAILED (" + failures.length + "):");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
console.log("\nANNOTATIONS-RPC PASS");

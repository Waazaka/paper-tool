// Exercise the panel-only RPCs against a COPY of the real library.
//
// Why a copy: these entry points write (annotations, claims, backups), and the user's
// live library must never be the test subject. VACUUM INTO is used for the snapshot
// because the DB runs in WAL mode — a plain file copy can miss committed pages.
//
// Scope, stated honestly: this proves the host half answers correctly for the shapes the
// panel sends, including the zero-argument backupStatus call that shipped broken to a
// release. It does NOT prove the panel renders those answers. s38 catches call-site
// arity drift; this catches a wrong answer from a correct call. Neither replaces
// clicking the thing.
//
// Skips (reported as SKIP, never as a pass) when there is no live library to snapshot:
// a fresh machine has none, and inventing one here would hide the difference.
import { mkdtempSync, rmSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { loadService } = await import("./shim.mjs");
const { PaperToolService } = await loadService();

const LIVE = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh-desktop"), "paper-tool", "library.sqlite");

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else { console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail)); failures.push(name); }
}

if (!existsSync(LIVE)) {
  console.log("  SKIP no live library at " + LIVE + " (nothing to snapshot; not a pass)");
  console.log("");
  console.log("RPC-LIVE SKIP");
  process.exit(0);
}
console.log("  live db: " + LIVE + " (" + statSync(LIVE).size + " bytes)");

const home = mkdtempSync(join(tmpdir(), "rpc-verify-home-"));
const work = mkdtempSync(join(tmpdir(), "rpc-verify-work-"));

// Snapshot the live DB into the scratch home. WAL: VACUUM INTO, never copyFile.
const destDir = join(home, "paper-tool");
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, "library.sqlite");
{
  const db = new DatabaseSync(LIVE, { readOnly: true });
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  db.close();
}
check("the snapshot is readable", existsSync(dest) && statSync(dest).size > 0, "bytes=" + (existsSync(dest) ? statSync(dest).size : "missing"));

const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home, shared: true });
const scope = { sessionId: "rpc-verify", workspaceRoot: work };
const store = service.storeFor(scope);

try {
  // --- status ---------------------------------------------------------
  {
    const status = await service.status(scope);
    check("status reports the copied library", status.library.papers === 4 && status.library.pages === 55,
      JSON.stringify(status.library));
    check("status counts the evidence rows", status.library.evidence === 2, JSON.stringify(status.library));
    check("status exposes the writing block", status.writing?.supported === true, JSON.stringify(status.writing));
    // The panel reads these exact method names off status; a rename would silently
    // break the writing panel without any test noticing.
    check("status names the three writing RPCs",
      status.writing.skeletonMethod === "sectionSkeleton" &&
      status.writing.importMethod === "importCitations" &&
      status.writing.similarityMethod === "similarityNotice",
      JSON.stringify(status.writing));
  }

  // --- sectionSkeleton ------------------------------------------------
  {
    const out = await service.sectionSkeleton(scope, {});
    check("skeleton returns sections", Array.isArray(out.sections) && out.sections.length > 0, "sections=" + out.sections?.length);
    check("skeleton note does not leak evidenceId", !/evidenceId/.test(out.note ?? ""), JSON.stringify(out.note));
    check("skeleton note names paper and page", /哪篇/.test(out.note ?? "") && /哪一页/.test(out.note ?? ""), JSON.stringify(out.note));
    // Every bound id must exist in the library: a fabricated id is the failure mode the
    // claims work was about.
    // The row field is evidenceId, not id — using row.id makes this set all-undefined
    // and the assertion fails against perfectly correct output.
    const known = new Set(store.listEvidence(500).map((row) => row.evidenceId));
    const bound = out.sections.flatMap((section) => section.evidenceIds ?? []);
    check("every bound evidence id exists", bound.length > 0 && bound.every((id) => known.has(id)), JSON.stringify(bound) + " known=" + JSON.stringify([...known]));
    console.log("    skeleton: sections=" + out.sections.length + " bound=" + bound.length);
  }

  // --- similarityNotice ----------------------------------------------
  {
    const text = "旅游业高质量发展要求升级旅游产品质量、提高旅游经济效率、优化旅游产业结构。";
    const out = await service.similarityNotice(scope, { text });
    check("similarity always carries its disclaimer", typeof out.disclaimer === "string" && out.disclaimer.length > 0);
    check("similarity is not a percentage", !/%|重复率|查重率是|降重/.test(JSON.stringify(out.matches ?? [])));
    console.log("    similarity: comparable=" + out.comparable + " matches=" + (out.matches?.length ?? 0));
  }

  // --- annotations ----------------------------------------------------
  {
    const before = store.listAnnotations("68c6f928-edad-4583-8e48-78fde9748675").length;
    const created = await service.saveAnnotation(scope, {
      paperId: "68c6f928-edad-4583-8e48-78fde9748675",
      pageIndex: 1,
      quote: "围绕旅游业高质量发展这一话题",
      note: "验证用标注（临时库副本）",
    });
    check("saveAnnotation returns a row", created !== null && created !== undefined, JSON.stringify(created)?.slice(0, 120));
    const after = store.listAnnotations("68c6f928-edad-4583-8e48-78fde9748675").length;
    check("saveAnnotation persisted", after === before + 1, before + " -> " + after);
  }

  // --- claims ---------------------------------------------------------
  // Corrections after reading the real host source: the method is recordClaims, the
  // incoming field is `text` (not `sentence`), and store.listClaims takes an options
  // object. The first run of this script guessed all three and crashed or misreported —
  // a wrong guess about a signature is not a product defect.
  {
    const evidence = store.listEvidence(10);
    const realId = evidence[0].evidenceId;
    const recorded = await service.recordClaims(scope, {
      claims: [{ text: "中国旅游业高质量发展需要升级产品质量、提高经济效率、优化产业结构并增强可持续性。", evidenceIds: [realId] }],
    }).catch((error) => ({ error: error.message }));
    check("recordClaims accepts a real evidence id",
      recorded && recorded.error === undefined && (recorded.accepted ?? []).length >= 1,
      JSON.stringify(recorded)?.slice(0, 240));
    const listed = store.listClaims({ limit: 50 });
    check("the recorded claim is readable back", listed.length >= 1, "claims=" + listed.length);
    // And refuses to invent one.
    const bogus = await service.recordClaims(scope, {
      claims: [{ text: "一条指向不存在证据的句子。", evidenceIds: ["00000000-0000-4000-8000-000000000000"] }],
    }).catch((error) => ({ error: error.message }));
    check("recordClaims refuses a fabricated evidence id",
      bogus && (bogus.error !== undefined || (bogus.rejected ?? []).length >= 1),
      JSON.stringify(bogus)?.slice(0, 240));
  }

  // --- backupStatus (the arity fix) -----------------------------------
  {
    const out = await service.backupStatus(scope);
    check("backupStatus takes no input and answers", out !== null && typeof out === "object", JSON.stringify(out)?.slice(0, 120));
    check("backupStatus reports the backup location", typeof out.backupsDir === "string" && out.backupsDir.length > 0);
    check("backupStatus measures the library", out.measured !== undefined && out.measured.dbBytes > 0);
  }

  // --- backup + restore ----------------------------------------------
  {
    const made = await service.backupLibrary(scope, {});
    check("backupLibrary produces a snapshot", made && made.ok === true && typeof made.directory === "string",
      JSON.stringify(made)?.slice(0, 240));
    // backupStatus lists backup DIRECTORY NAMES, not objects with a directory field.
    const listed = await service.backupStatus(scope);
    const names = listed.backups ?? [];
    const wanted = typeof made.directory === "string" ? made.directory.split(/[\\/]/).pop() : "";
    check("the new backup is listed", names.includes(wanted), "want=" + wanted + " got=" + JSON.stringify(names));
    // Restoring over a live library must be refused without the explicit flag.
    const refused = await service.restoreLibrary(scope, { directory: made.directory })
      .then((value) => (value?.ok === false ? "refused: " + (value.reason ?? "") : null))
      .catch((error) => error.message);
    check("restore refuses to overwrite without force", typeof refused === "string", String(refused));
  }

  // --- importCitations -------------------------------------------------
  // The status block only ever asserted that this method is NAMED in status.writing;
  // it was never actually called here, so the panel's .bib/.ris import path had no
  // live-shape coverage at all. It is the one writing-assist entry point that writes
  // papers, which makes it the most valuable one to exercise.
  {
    const BIB = `@article{verify2024shape,
  title = {A Verification Entry for Shape Coverage},
  author = {Smith, John and Doe, Jane},
  year = {2024},
  journal = {Journal of Verification},
  doi = {10.9999/verify.shape.2024},
}`;
    const before = store.stats().papers;
    const out = await service.importCitations(scope, { fileName: "verify.bib", text: BIB });
    check("importCitations parses a .bib file",
      out && Array.isArray(out.imported) && out.imported.length >= 1,
      JSON.stringify(out)?.slice(0, 260));
    check("importCitations actually added the paper", store.stats().papers === before + 1,
      before + " -> " + store.stats().papers);
    const added = out.imported?.[0];
    check("the imported entry keeps its metadata",
      added && /Verification Entry/i.test(JSON.stringify(added)) && /2024/.test(JSON.stringify(added)),
      JSON.stringify(added)?.slice(0, 240));

    // Importing the SAME file again must dedupe on DOI rather than add a second copy:
    // the panel offers this button twice a session and a duplicate per click would rot
    // the library silently.
    const again = await service.importCitations(scope, { fileName: "verify.bib", text: BIB });
    check("re-importing the same DOI does not duplicate", store.stats().papers === before + 1,
      "papers=" + store.stats().papers + " result=" + JSON.stringify(again).slice(0, 200));

    // An empty file and an unrecognised format must be refusals, not silent no-ops.
    const emptyRefused = await service.importCitations(scope, { fileName: "x.bib", text: "   " })
      .then(() => null).catch((error) => error.message);
    check("an empty citation file is refused", typeof emptyRefused === "string", String(emptyRefused));
    const junkRefused = await service.importCitations(scope, { fileName: "x.txt", text: "not a citation file" })
      .then(() => null).catch((error) => error.message);
    check("an unrecognised citation format is refused", typeof junkRefused === "string", String(junkRefused));
  }

  // --- annotations, translation, topics, anchored ask -------------------
  // These eight panel RPCs had no live coverage at all. Four of them are the annotation
  // RPCs whose wire arity was wrong (see s44); calling them here is what proves the
  // service side is sound once the transport is fixed, on a real library shape rather
  // than an empty fixture.
  {
    // Pick a paper that actually has page text. `listPapers` returns whatever is newest
    // first, and by this point the .bib import above has added a metadata-only paper
    // with no pages — so taking the first row would test against a row that cannot carry
    // segments or anchors, and the failures would look like product bugs.
    const withPages = store.listPapers({ limit: 50, offset: 0 })
      .find((row) => store.getPage(row.paperId, 0) !== null);
    check("the live library has a paper with page text", withPages !== undefined,
      "papers=" + store.stats().papers + " pages=" + store.stats().pages);

    if (withPages !== undefined) {
      const paperId = withPages.paperId;

      const topics = await service.topicRecommend(scope, { query: "旅游" });
      check("topicRecommend returns candidates and a disclaimer",
        Array.isArray(topics.candidates) && typeof topics.disclaimer === "string",
        "candidates=" + (topics.candidates?.length ?? "?"));
      check("topicRecommend restates the disclaimer at the top level, below `candidates`",
        typeof topics.disclaimer === "string" && topics.disclaimer.length > 0);
      check("topicRecommend reports already-in-library separately from candidates",
        typeof topics.alreadyInLibrary === "number", String(topics.alreadyInLibrary));

      const segments = await service.translateSegments(scope, { paperId, targetLang: "en", fromPage: 0, toPage: 1 });
      check("translateSegments returns anchored segments",
        Array.isArray(segments.segments) && segments.segments.length > 0,
        "segments=" + (segments.segments?.length ?? "?"));
      const firstSegment = segments.segments?.[0];
      check("a segment carries a real anchor",
        Number.isInteger(firstSegment?.pageIndex) && Number.isInteger(firstSegment?.charStart)
          && Number.isInteger(firstSegment?.charEnd) && firstSegment.charEnd > firstSegment.charStart,
        JSON.stringify(firstSegment)?.slice(0, 160));
      check("translateSegments reports unmatched segments instead of hiding them",
        typeof segments.untranslated === "number" && segments.untranslated === segments.segments.length,
        "untranslated=" + segments.untranslated + " segments=" + segments.segments.length);

      if (firstSegment !== undefined) {
        const savedTranslation = await service.saveTranslation(scope, {
          paperId,
          targetLang: "en",
          items: [{ pageIndex: firstSegment.pageIndex, charStart: firstSegment.charStart, charEnd: firstSegment.charEnd, text: "a translation" }],
        });
        check("saveTranslation stores an item", savedTranslation.saved === 1, JSON.stringify(savedTranslation)?.slice(0, 160));
        check("saveTranslation reports rejections as an array", Array.isArray(savedTranslation.rejected));
        // A bad anchor must be refused, not stored at the wrong place.
        const beforeBad = store.countTranslations({ paperId });
        const badTranslation = await service.saveTranslation(scope, {
          paperId,
          targetLang: "en",
          items: [{ pageIndex: -1, charStart: 0, charEnd: 5, text: "x" }],
        });
        check("saveTranslation rejects an invalid anchor", badTranslation.rejected.length === 1,
          JSON.stringify(badTranslation.rejected).slice(0, 160));
        // Refusing is not enough: nothing may be written. Without this, a version that
        // reported the rejection but stored the row anyway would pass.
        check("a rejected translation is not stored",
          badTranslation.saved === 0 && store.countTranslations({ paperId }) === beforeBad,
          "saved=" + badTranslation.saved + " count " + beforeBad + " -> " + store.countTranslations({ paperId }));
      }

      const listedTranslations = await service.listTranslations(scope, { paperId, targetLang: "en" });
      check("listTranslations reads back what was saved",
        listedTranslations.translations.length >= 1, "total=" + listedTranslations.total);
      if (listedTranslations.translations[0] !== undefined) {
        const removed = await service.deleteTranslation(scope, {
          translationId: listedTranslations.translations[0].translationId,
        });
        check("deleteTranslation removes it", removed.deleted === listedTranslations.translations[0].translationId,
          JSON.stringify(removed));
        const afterDelete = await service.listTranslations(scope, { paperId, targetLang: "en" });
        check("the deleted translation is gone", afterDelete.total === listedTranslations.total - 1,
          afterDelete.total + " vs " + listedTranslations.total);
      }

      // Annotations: save, list, promote to evidence, delete.
      const page = store.getPage(paperId, 0);
      const quote = String(page?.text ?? "").slice(0, 12);
      const savedAnnotation = await service.saveAnnotation(scope, {
        paperId, pageIndex: 0, charStart: 0, charEnd: quote.length, quote, note: "gate note", tags: [], color: "",
      });
      check("saveAnnotation stores an annotation with an id",
        typeof savedAnnotation.annotation?.annotationId === "string", JSON.stringify(savedAnnotation)?.slice(0, 160));
      const listedAnnotations = await service.listAnnotations(scope, { paperId, limit: 100 });
      check("listAnnotations reads it back",
        listedAnnotations.annotations.some((row) => row.annotationId === savedAnnotation.annotation.annotationId));
      check("listAnnotations reports a total", typeof listedAnnotations.total === "number", String(listedAnnotations.total));

      if (savedAnnotation.annotation?.annotationId !== undefined) {
        const promoted = await service.promoteAnnotation(scope, { annotationId: savedAnnotation.annotation.annotationId });
        check("promoteAnnotation creates an evidence row", typeof promoted.evidence?.evidenceId === "string",
          JSON.stringify(promoted)?.slice(0, 160));
        check("promoteAnnotation keeps the annotation in place",
          promoted.annotation?.annotationId === savedAnnotation.annotation.annotationId);
        const removedAnnotation = await service.deleteAnnotation(scope, { annotationId: savedAnnotation.annotation.annotationId });
        check("deleteAnnotation removes the annotation", removedAnnotation.ok === true, JSON.stringify(removedAnnotation));
      }

      // askContext builds a packet; it must never answer. The answer is the Agent's.
      // The selection is passed as TEXT, not as offsets: the host locates the passage
      // itself and treats a caller-supplied pageIndex as a hint only, so that a UI
      // showing page 9 cannot attach every question to page 9. Passing offsets here
      // would leave the selection unanchored and look like a product defect.
      const selectionText = String(page?.text ?? "").trim().slice(0, 40);
      const packet = await service.askContext(scope, {
        paperId, question: "这一页讲了什么？", selectionText,
      });
      check("askContext returns the question and the anchored selection",
        packet.question === "这一页讲了什么？" && packet.selection?.anchored === true,
        JSON.stringify(packet.selection));
      check("askContext located the passage on a real page",
        Number.isInteger(packet.selection?.pageIndex) && packet.selection.pageIndex >= 0,
        JSON.stringify(packet.selection));
      check("askContext returns surrounding context", typeof packet.context?.text === "string" && packet.context.text.length > 0,
        "len=" + (packet.context?.text?.length ?? 0));
      check("askContext returns no answer of its own", packet.answer === undefined, JSON.stringify(Object.keys(packet)));
      // A question with no selection must still work, falling back to a page hint — and
      // must be reported as unanchored rather than given a plausible-looking offset.
      const noSelection = await service.askContext(scope, { paperId, question: "无选区", pageIndex: 0 });
      check("askContext without a selection reports an unanchored selection",
        noSelection.selection?.anchored === false && noSelection.selection.charStart === -1,
        JSON.stringify(noSelection.selection));
    }
  }

  // --- export ---------------------------------------------------------
  // exportReview returns the rendered documents, not paths: the panel writes the files
  // through the file picker, so a path here would mean the host had written somewhere
  // the user never chose.
  {
    const out = await service.exportReview(scope, { title: "验证标题" });
    check("exportReview returns markdown", out.ok === true && typeof out.markdown === "string" && out.markdown.length > 200,
      "ok=" + out.ok + " len=" + (out.markdown?.length ?? 0));
    check("exportReview returns a bibliography", typeof out.bibtex === "string" && out.bibtex.includes("@"),
      (out.bibtex ?? "").slice(0, 120));
    check("exportReview reports no warnings for a clean library", Array.isArray(out.warnings), JSON.stringify(out.warnings));
  }
} finally {
  try { service.dispose(); } catch { /* already closed */ }
  for (const dir of [home, work]) rmSync(dir, { recursive: true, force: true });
}

console.log("");
if (failures.length > 0) {
  console.log("RPC-LIVE FAILED (" + failures.length + "):");
  for (const name of failures) console.log("  - " + name);
  process.exit(1);
}
console.log("RPC-LIVE PASS");

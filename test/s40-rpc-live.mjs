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

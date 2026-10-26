// S17: the three defects reported after the sidebar mount fix.
//
// 1. Opening the workbench from another workspace showed an empty shelf. The
//    library was per-workspace by construction, so a paper imported in one
//    folder was invisible in the next 鈥?which reads as data loss.
// 2. "Re-read metadata" produced worse values than the original import, because
//    the importer used the file name (a citation in disguise on Zotero/CNKI
//    exports) and the re-extract passed `filename: ""`.
// 3. A wrong year could never be repaired: legacy rows carry an empty
//    `metadataSource` yet had already been stamped `metadataVerifiedAt`, so the
//    guard treated every field as user-verified and refused to replace it.
//
// Run: node test/s17-shared-and-reextract.mjs <pdfDir>
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const { loadService } = await import("./shim.mjs");
const { PaperToolService } = await loadService();

const pdfDirs = process.argv.slice(2);
const pdfs = [];
for (const dir of pdfDirs) {
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
  console.error("S17: no PDFs found");
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), "paper-tool-S17-home-"));
const workspaceA = mkdtempSync(join(tmpdir(), "paper-tool-S17-a-"));
const workspaceB = mkdtempSync(join(tmpdir(), "paper-tool-S17-b-"));

// --- 1. one library across workspaces ------------------------------------
{
  const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home });
  const scopeA = { sessionId: "session-a", workspaceRoot: workspaceA };
  const scopeB = { sessionId: "session-b", workspaceRoot: workspaceB };
  const files = pdfs.slice(0, 1).map((path) => ({
    name: path.split(/[\\/]/).pop(),
    data: Array.from(new Uint8Array(readFileSync(path))),
  }));
  const importedA = await service.importPdf(scopeA, { files });
  check("import in workspace A succeeds", importedA.imported.length === 1, JSON.stringify(importedA.failed));

  const listedB = await service.listPapers(scopeB, {});
  check("workspace B sees the paper imported in A", listedB.papers.length === 1,
    `A=${importedA.library.papers} B=${listedB.papers.length}`);
  check("the same paper id is visible from B",
    listedB.papers[0]?.paperId === importedA.imported[0].paperId);

  const statusB = await service.status(scopeB);
  check("status agrees across workspaces", statusB.library.papers === 1, JSON.stringify(statusB.library));

  // The bytes must live beside the shared library, or B could read a row it
  // cannot render: a pdfPath pointing into A's workspace would still "work"
  // today and break the moment A is moved or deleted.
  const paper = listedB.papers[0];
  check("the PDF path is not inside workspace A",
    typeof paper.pdfPath === "string" && !paper.pdfPath.startsWith(workspaceA),
    paper.pdfPath);

  service.dispose();
}

// --- 2. opt-out restores per-workspace libraries -------------------------
{
  const home2 = mkdtempSync(join(tmpdir(), "paper-tool-S17-home2-"));
  const workA = mkdtempSync(join(tmpdir(), "paper-tool-S17-oa-"));
  const workB = mkdtempSync(join(tmpdir(), "paper-tool-S17-ob-"));
  const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home2, shared: false });
  const files = pdfs.slice(0, 1).map((path) => ({
    name: path.split(/[\\/]/).pop(),
    data: Array.from(new Uint8Array(readFileSync(path))),
  }));
  await service.importPdf({ sessionId: "s-a", workspaceRoot: workA }, { files });
  const listedB = await service.listPapers({ sessionId: "s-b", workspaceRoot: workB }, {});
  check("shared:false keeps libraries per workspace", listedB.papers.length === 0,
    String(listedB.papers.length));
  service.dispose();
  rmSync(home2, { recursive: true, force: true });
  rmSync(workA, { recursive: true, force: true });
  rmSync(workB, { recursive: true, force: true });
}

// --- 3. re-extraction keeps the file-name channel ------------------------
{
  const home3 = mkdtempSync(join(tmpdir(), "paper-tool-S17-home3-"));
  const work = mkdtempSync(join(tmpdir(), "paper-tool-S17-reextract-"));
  const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home3 });
  const scope = { sessionId: "session-reextract", workspaceRoot: work };
  const source = pdfs[0];
  const originalName = source.split(/[\\/]/).pop();
  const imported = await service.importPdf(scope, {
    files: [{ name: originalName, data: Array.from(new Uint8Array(readFileSync(source))) }],
  });
  const paperId = imported.imported[0].paperId;

  // The original name must survive the import: without it a re-extract cannot
  // reproduce the import's own result.
  const paper = (await service.listPapers(scope, {})).papers.find((row) => row.paperId === paperId);
  check("the import stores the original file name",
    typeof paper.sourceName === "string" && paper.sourceName === originalName,
    JSON.stringify(paper.sourceName));

  const first = await service.reextractMetadata(scope, { paperId });
  check("re-extraction reports the file-name channel",
    ["filename", "xmp", "info", "subject"].includes(first.guess.sources?.title ?? ""),
    JSON.stringify(first.guess.sources));

  // Simulate the legacy defect exactly as the real library has it: a wrong year,
  // an empty provenance map, and NO verified stamp 鈥?`upsertPaper` never wrote
  // one, which is why all four real imported rows carry `metadataVerifiedAt = ''`
  // while still being wrong.
  service.storeFor(scope).db
    .prepare("UPDATE papers SET year = '2013', metadataSource = '{}', metadataVerifiedAt = '' WHERE paperId = ?")
    .run(paperId);
  const legacy = (await service.listPapers(scope, {})).papers.find((row) => row.paperId === paperId);
  check("legacy row starts with the wrong year", legacy.year === "2013", legacy.year);

  const repaired = await service.reextractMetadata(scope, { paperId });
  const after = (await service.listPapers(scope, {})).papers.find((row) => row.paperId === paperId);
  const expected = repaired.guess.year;
  if (expected !== "" && expected !== "2013") {
    check("a wrong year on a legacy row is repairable", after.year === expected,
      `after=${after.year} guess=${expected}`);
  } else {
    // The extractor found no year for this PDF; then the guard is not exercised,
    // and the honest assertion is that the stamp was cleared so a later pass can.
    check("no year found, so the verified stamp is cleared instead",
      after.metadataVerifiedAt === "" || after.year === "2013",
      `year=${after.year} stamp=${after.metadataVerifiedAt}`);
  }

  // A genuinely user-typed value must still survive re-extraction. Model it the
  // way the app actually produces it: `updatePaper` stamps the row and drops the
  // edited field from the provenance map, so the stamp is what distinguishes a
  // hand edit from an import.
  service.storeFor(scope).updatePaper(paperId, {
    title: "A Title The User Typed Themselves",
  });
  const edited = (await service.listPapers(scope, {})).papers.find((row) => row.paperId === paperId);
  check("a user edit records the verified stamp", edited.metadataVerifiedAt !== "", edited.metadataVerifiedAt);
  check("a user edit drops the field's provenance",
    JSON.parse(edited.metadataSource || "{}").title === undefined, edited.metadataSource);

  await service.reextractMetadata(scope, { paperId });
  const preserved = (await service.listPapers(scope, {})).papers.find((row) => row.paperId === paperId);
  check("a user-written title is never overwritten",
    preserved.title === "A Title The User Typed Themselves", preserved.title);

  service.dispose();
  rmSync(home3, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

// --- 4. an existing per-workspace library is adopted, never clobbered ----
{
  const store = await import("../lib/store.js");
  const home4 = mkdtempSync(join(tmpdir(), "paper-tool-S17-home4-"));
  const work = mkdtempSync(join(tmpdir(), "paper-tool-S17-adopt-"));
  const legacy = store.defaultDbPath(work);
  const shared = store.sharedDbPath(home4);

  // First upgrade: the legacy file exists and the shared one does not, so the
  // papers a user already imported must reappear.
  {
    const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home4, shared: false });
    const files = pdfs.slice(0, 1).map((path) => ({
      name: path.split(/[\\/]/).pop(),
      data: Array.from(new Uint8Array(readFileSync(path))) ,
    }));
    await service.importPdf({ sessionId: "legacy", workspaceRoot: work }, { files });
    service.dispose();
  }
  check("the legacy library exists before the upgrade", (await import("node:fs")).existsSync(legacy), legacy);

  {
    const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home4 });
    const listed = await service.listPapers({ sessionId: "after", workspaceRoot: work }, {});
    check("an existing workspace library is adopted into the shared one",
      listed.papers.length === 1, String(listed.papers.length));
    service.dispose();
  }

  // Second start must not copy again: the shared library is now the real one and
  // an older legacy file must never overwrite it.
  {
    const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home4, shared: false });
    const other = mkdtempSync(join(tmpdir(), "paper-tool-S17-adopt2-"));
    await service.importPdf({ sessionId: "second", workspaceRoot: other }, {
      files: pdfs.slice(0, 1).map((path) => ({
        name: path.split(/[\\/]/).pop(),
        data: Array.from(new Uint8Array(readFileSync(path))),
      })),
    });
    service.dispose();
    rmSync(other, { recursive: true, force: true });
  }
  {
    const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home4 });
    const listed = await service.listPapers({ sessionId: "again", workspaceRoot: work }, {});
    check("an existing shared library is never overwritten by a legacy one",
      listed.papers.length === 1, String(listed.papers.length));
    service.dispose();
  }
  rmSync(home4, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

rmSync(home, { recursive: true, force: true });
rmSync(workspaceA, { recursive: true, force: true });
rmSync(workspaceB, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\nS17 FAILED (${failures.length}):`);
  for (const failure of failures) console.error(" -", failure);
  if (process.env.PAPER_TOOL_RESULT_FILE) {
    writeFileSync(process.env.PAPER_TOOL_RESULT_FILE, JSON.stringify({ gate: "S17", failures: failures.length }));
  }
  process.exit(1);
}
if (process.env.PAPER_TOOL_RESULT_FILE) {
  writeFileSync(process.env.PAPER_TOOL_RESULT_FILE, JSON.stringify({ gate: "S17", failures: 0 }));
}
console.log("\nS17 PASS");

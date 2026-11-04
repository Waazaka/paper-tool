// Library backup and migration (PT-022).
//
// The failure this gate exists to prevent is a backup that reports success while
// missing data, because that is worse than having no backup: the user stops
// worrying. Two mechanisms make that possible in this codebase and each is tested
// directly.
//
//   1. Paging. If the export walked papers through the RPC surface it would stop at
//      the list cap and produce a complete-looking partial backup. So the export
//      must operate on the SQLite file itself.
//   2. WAL. The library runs in `journal_mode=WAL`, so a `copyFileSync` of the
//      .sqlite can miss recent commits that are still in `-wal`. A test that only
//      compares byte counts would pass while the newest papers are absent.
//
// The round trip is also checked against an independent third library, table by
// table on primary keys, because "the file copied" is not equivalence.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const { loadService } = await import("./shim.mjs");
const { PaperToolService } = await loadService();
const vault = await import("../lib/vault.js");

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else {
    console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail));
    failures.push(name);
  }
}

const client = readFileSync("client.js", "utf8");
const host = readFileSync("lib/host-service.js", "utf8");
const tools = readFileSync("lib/tools.js", "utf8");

const PAGES = ["第一段内容，用于检索。\n\n第二段内容。", "第二页的内容。"];

/** A service with a seeded library, its own home, and a real PDF byte file. */
function makeLibrary(label, papers = 3) {
  const home = mkdtempSync(join(tmpdir(), `${label}-home-`));
  const work = mkdtempSync(join(tmpdir(), `${label}-work-`));
  const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home, shared: true });
  const scope = { sessionId: label, workspaceRoot: work };
  const store = service.storeFor(scope);
  const filesDir = service.filesDir(scope);
  mkdirSync(filesDir, { recursive: true });
  for (let index = 0; index < papers; index += 1) {
    const paperId = `p${index}`;
    // A distinct byte length per paper, so a copy that drops one is detectable by
    // the byte total and not only by the count.
    writeFileSync(join(filesDir, `${paperId}.pdf`), Buffer.alloc(100 + index, 0x25));
    store.upsertPaper({
      paperId, title: `Paper ${index}`, authors: `Author ${index}`, year: String(2020 + index),
      venue: "Venue", doi: `10.1/${index}`, source: "test",
      pdfPath: join(filesDir, `${paperId}.pdf`), fingerprint: `fp-${index}`,
      material: "fulltext", numPages: PAGES.length,
      pages: PAGES, pageSources: PAGES.map(() => "text-layer"),
    });
    store.addEvidence({
      evidenceId: `e${index}`, paperId, pageIndex: 0,
      charStart: 0, charEnd: 6, quote: PAGES[0].slice(0, 6),
    });
  }
  return {
    home, work, service, scope, store, filesDir,
    cleanup() {
      try { service.dispose(); } catch { /* already closed */ }
      for (const dir of [home, work]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

// --- 1. the database is really in WAL mode --------------------------
// If this is ever turned off, the "why VACUUM INTO" argument evaporates and the
// mutation that swaps in a raw file copy would stop being observable. Asserting it
// here keeps the gate honest about the premise it rests on.
{
  const library = makeLibrary("wal", 1);
  const mode = library.store.db.prepare("PRAGMA journal_mode").get().journal_mode;
  check("the library runs in WAL mode", mode === "wal", String(mode));
  // Write more data and confirm the main file does not immediately contain it:
  // that gap is exactly what a raw copy loses.
  const beforeBytes = statSync(library.store.dbPath).size;
  for (let index = 0; index < 40; index += 1) {
    library.store.upsertPaper({
      paperId: `wal${index}`, title: "x".repeat(200), authors: "A", year: "2020", venue: "V",
      doi: `10.9/${index}`, source: "test", pdfPath: "", fingerprint: `walfp-${index}`,
      material: "metadata", numPages: 0, pages: [], pageSources: [],
    });
  }
  const afterBytes = statSync(library.store.dbPath).size;
  check("recent commits are not all in the main file (the WAL hazard is real)",
    afterBytes === beforeBytes, `${beforeBytes} -> ${afterBytes}`);
  library.cleanup();
}

// --- 2. backup produces a self-contained, valid artifact -----------
{
  const library = makeLibrary("backup", 3);
  const destination = mkdtempSync(join(tmpdir(), "backup-dest-"));
  const before = library.store.stats();
  const result = await library.service.backupLibrary(library.scope, { destination });

  check("the backup reports success", result.ok === true, JSON.stringify(result.problems));
  check("the backup names a directory", typeof result.directory === "string" && result.directory !== "");
  check("the directory exists", existsSync(result.directory));
  check("the snapshot holds a database file", existsSync(join(result.directory, "library.sqlite")));
  check("the snapshot holds a files directory", existsSync(join(result.directory, "files")));
  check("the snapshot holds a manifest", existsSync(join(result.directory, "manifest.json")));
  check("every PDF was copied", existsSync(join(result.directory, "files", "p0.pdf"))
    && existsSync(join(result.directory, "files", "p1.pdf"))
    && existsSync(join(result.directory, "files", "p2.pdf")));

  // The snapshot must be a *valid* database, checked in a separate connection so
  // it is not reading through the live store's cache.
  const snapshot = new DatabaseSync(join(result.directory, "library.sqlite"));
  const integrity = snapshot.prepare("PRAGMA integrity_check").get();
  check("the snapshot passes PRAGMA integrity_check",
    Object.values(integrity)[0] === "ok", JSON.stringify(integrity));
  const snapshotPapers = snapshot.prepare("SELECT COUNT(*) c FROM papers").get().c;
  check("the snapshot carries every paper", snapshotPapers === before.papers, `${snapshotPapers} vs ${before.papers}`);
  const snapshotEvidence = snapshot.prepare("SELECT COUNT(*) c FROM evidence").get().c;
  check("the snapshot carries every evidence row", snapshotEvidence === before.evidence, `${snapshotEvidence} vs ${before.evidence}`);
  snapshot.close();

  // The snapshot byte count must exceed the live file's: proof that VACUUM INTO
  // materialised the WAL contents rather than copying the near-empty main file.
  const liveBytes = statSync(library.store.dbPath).size;
  check("the snapshot is larger than the live main file (WAL was folded in)",
    result.report.sqliteBytes > liveBytes, `${result.report.sqliteBytes} vs ${liveBytes}`);

  // A backup whose files no longer match its manifest must report ok=false. The
  // exporter verifies what it wrote; if that verification were skipped, this is
  // the case that would slip through — a truncated snapshot that still says "done".
  {
    const tampered = mkdtempSync(join(tmpdir(), "tamper-"));
    const library = makeLibrary("tamper-src", 2);
    const clean = await library.service.backupLibrary(library.scope, { destination: tampered });
    check("the clean backup verified", clean.ok === true, JSON.stringify(clean.problems));

    // Force a real copy failure. `backupLibrary` accepts `now`, so the timestamped
    // target directory is predictable: a same-named DIRECTORY where the PDF should
    // land makes copyFileSync throw on every platform, without needing ACL tricks.
    const stamp = new Date("2026-01-02T03:04:05");
    const preDir = join(tampered, "broken", vault.backupDirName(stamp));
    mkdirSync(join(preDir, "files", "p0.pdf"), { recursive: true });
    const broken = await library.service.backupLibrary(library.scope, {
      destination: join(tampered, "broken"),
      now: stamp.toISOString(),
    });
    // The manifest is built from the SOURCE, so a copy that dropped a file shows up
    // as a mismatch. If the manifest were built from the copy instead, this would
    // pass while silently losing a PDF.
    check("a backup that could not copy a PDF reports failure", broken.ok === false,
      JSON.stringify({ ok: broken.ok, problems: broken.problems }));
    check("the failure names the missing PDF count",
      broken.problems.some((line) => /PDF/i.test(line)), JSON.stringify(broken.problems));
    check("the copy failure is surfaced separately too",
      broken.copyFailures.length > 0, JSON.stringify(broken.copyFailures));
    check("the copy failure names the file that could not be copied",
      broken.copyFailures.some((entry) => entry.name === "p0.pdf"), JSON.stringify(broken.copyFailures));

    // And deleting a file after the fact: this is what a half-finished copy looks
    // like on disk, and verification has to catch it.
    rmSync(join(clean.directory, "files", "p0.pdf"), { force: true });
    const verified = vault.verifyBackup(clean.directory);
    check("a snapshot missing a promised file fails verification", verified.ok === false,
      JSON.stringify(verified.problems));
    check("the verification says how many PDFs are missing",
      verified.problems.some((line) => /PDF/i.test(line)), JSON.stringify(verified.problems));
    library.cleanup();
    rmSync(tampered, { recursive: true, force: true });
  }

  // Copy failures must be reported, not swallowed: a backup that could not write a
  // file has to say so rather than count it as copied.
  check("copyPdfFiles reports the failures it hit",
    (() => {
      const dir = mkdtempSync(join(tmpdir(), "copyfail-"));
      const result = vault.copyPdfFiles(join(dir, "does-not-exist"), join(dir, "out"));
      rmSync(dir, { recursive: true, force: true });
      // A missing source yields zero copies, and the caller can tell that apart
      // from "there was nothing to copy" by the count.
      return result.copied === 0 && Array.isArray(result.failures);
    })(), "copyPdfFiles did not report a usable result");

  // The manifest must not leak the source machine's absolute path.
  const manifestText = readFileSync(join(result.directory, "manifest.json"), "utf8");
  check("the manifest does not record an absolute source path",
    !manifestText.includes(library.home.replace(/\\/g, "\\\\")), "source path found in manifest");
  check("the manifest does not record the backup directory either",
    !manifestText.includes(result.directory.replace(/\\/g, "\\\\")), "backup path found in manifest");
  check("the manifest records only the relative file names",
    JSON.parse(manifestText).dbFile === "library.sqlite" && JSON.parse(manifestText).filesDir === "files",
    JSON.stringify(JSON.parse(manifestText)));

  rmSync(destination, { recursive: true, force: true });
  library.cleanup();
}

// --- 3. restore relocates paths and is data-equivalent -------------
{
  const source = makeLibrary("src", 3);
  const destination = mkdtempSync(join(tmpdir(), "restore-dest-"));
  const backup = await source.service.backupLibrary(source.scope, { destination });
  check("the source backup succeeded", backup.ok === true, JSON.stringify(backup.problems));
  const beforeCounts = source.store.stats();

  // Restore into a fresh profile: a different home, so every stored absolute path
  // in the snapshot points at the old location.
  const target = makeLibrary("dst", 0);
  check("the target starts empty", target.store.stats().papers === 0, String(target.store.stats().papers));
  const restored = await target.service.restoreLibrary(target.scope, { from: backup.directory });

  check("restore reports success", restored.ok === true);
  check("restore rewrote the pdf paths", restored.pathsRewritten === 3, String(restored.pathsRewritten));
  check("restore found no missing PDFs", restored.pdfMissing.length === 0, JSON.stringify(restored.pdfMissing));

  // A row whose PDF bytes are absent must be named, not dropped: that is the
  // difference between "restored with 2 of 3 PDFs" and "restored".
  {
    const holeSource = makeLibrary("hole-src", 2);
    const holeDest = mkdtempSync(join(tmpdir(), "hole-dest-"));
    const holeBackup = await holeSource.service.backupLibrary(holeSource.scope, { destination: holeDest });
    // Delete a PDF from the snapshot but repair the manifest, so the backup still
    // verifies — the missing file can then only be discovered by the restore.
    rmSync(join(holeBackup.directory, "files", "p1.pdf"), { force: true });
    const manifestPath = join(holeBackup.directory, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.pdfCount = 1;
    manifest.filesBytes = statSync(join(holeBackup.directory, "files", "p0.pdf")).size;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const holeTarget = makeLibrary("hole-dst", 0);
    const holeResult = await holeTarget.service.restoreLibrary(holeTarget.scope, { from: holeBackup.directory });
    check("a restore names the papers whose PDF bytes are missing",
      holeResult.pdfMissing.includes("p1"), JSON.stringify(holeResult.pdfMissing));
    check("the restore still succeeds and reports the hole",
      holeResult.ok === true && holeResult.pdfMissing.length === 1, JSON.stringify(holeResult.pdfMissing));
    holeSource.cleanup();
    holeTarget.cleanup();
    rmSync(holeDest, { recursive: true, force: true });
  }

  const afterStore = target.service.storeFor(target.scope);
  const afterCounts = afterStore.stats();
  check("papers match after restore", afterCounts.papers === beforeCounts.papers,
    `${afterCounts.papers} vs ${beforeCounts.papers}`);
  check("pages match after restore", afterCounts.pages === beforeCounts.pages,
    `${afterCounts.pages} vs ${beforeCounts.pages}`);
  check("evidence matches after restore", afterCounts.evidence === beforeCounts.evidence,
    `${afterCounts.evidence} vs ${beforeCounts.evidence}`);

  // Every path must now live under the NEW profile, and the bytes must be there.
  const newFilesDir = target.service.filesDir(target.scope);
  const rows = afterStore.db.prepare("SELECT paperId, pdfPath FROM papers").all();
  check("every pdfPath is under the new profile",
    rows.every((row) => row.pdfPath.replace(/\\/g, "/").startsWith(newFilesDir.replace(/\\/g, "/"))),
    JSON.stringify(rows.map((row) => row.pdfPath)));
  check("no pdfPath still points at the old profile",
    rows.every((row) => !row.pdfPath.includes(source.home)), "an old path survived the restore");
  check("the PDF bytes really are readable after the restore",
    rows.every((row) => existsSync(row.pdfPath) && statSync(row.pdfPath).size > 0),
    JSON.stringify(rows.map((row) => existsSync(row.pdfPath))));

  // Table-by-table equivalence against the snapshot, using an independent
  // connection rather than trusting the service's own store.
  const before = new DatabaseSync(join(backup.directory, "library.sqlite"));
  const after = new DatabaseSync(join(target.home, "paper-tool", "library.sqlite"));
  const parity = vault.compareLibraries(before, after, vault.PARITY_TABLES);
  check("every table matches the backup on primary keys", parity.equal === true,
    JSON.stringify(Object.fromEntries(Object.entries(parity.report).filter(([, v]) => !v.equal))));
  // Same row count, different keys: a comparison that only counted rows would call
  // this equal, which is the mistake that lets a restore lose one paper and
  // duplicate another while reporting success.
  {
    const left = makeLibrary("parity-l", 2);
    const right = makeLibrary("parity-r", 2);
    const rightStore = right.service.storeFor(right.scope);
    rightStore.deletePaper("p1");
    rightStore.upsertPaper({
      paperId: "p-other", title: "Other", authors: "B", year: "2021", venue: "V",
      doi: "10.1/other", source: "test", pdfPath: "", fingerprint: "fp-other",
      material: "metadata", numPages: 0, pages: [], pageSources: [],
    });
    const leftDb = new DatabaseSync(join(left.home, "paper-tool", "library.sqlite"));
    const rightDb = new DatabaseSync(join(right.home, "paper-tool", "library.sqlite"));
    const parity = vault.compareLibraries(leftDb, rightDb, vault.PARITY_TABLES);
    // Assert on the PAPERS table specifically, not the aggregate: other tables
    // (pages) also differ here because deleting a paper cascades, so `parity.equal`
    // would be false for the wrong reason and a row-count-only comparison in the
    // papers table would go unnoticed.
    check("equal row counts with different keys is not parity",
      parity.report.papers.equal === false, JSON.stringify(parity.report.papers));
    check("the differing key is named on both sides",
      parity.report.papers.onlyInLeft.includes("p1") && parity.report.papers.onlyInRight.includes("p-other"),
      JSON.stringify(parity.report.papers));
    leftDb.close();
    rightDb.close();
    left.cleanup();
    right.cleanup();
  }

  check("the papers table has the same key set",
    parity.report.papers.equal === true, JSON.stringify(parity.report.papers));
  check("the pages table has the same key set",
    parity.report.pages.equal === true, JSON.stringify(parity.report.pages));
  check("the evidence table has the same key set",
    parity.report.evidence.equal === true, JSON.stringify(parity.report.evidence));
  const beforePrint = vault.databaseFingerprint(before);
  const afterPrint = vault.databaseFingerprint(after);
  check("the restored database has the same content fingerprint",
    beforePrint === afterPrint, `${beforePrint} vs ${afterPrint}`);
  before.close();
  after.close();

  // paper_status must agree with the pre-migration numbers: this is the number the
  // user actually sees.
  const status = await target.service.status(target.scope);
  check("paper_status reports the same paper count",
    status.library.papers === beforeCounts.papers, `${status.library.papers} vs ${beforeCounts.papers}`);
  check("paper_status reports the same page count",
    status.library.pages === beforeCounts.pages, `${status.library.pages} vs ${beforeCounts.pages}`);
  check("paper_status reports the same evidence count",
    status.library.evidence === beforeCounts.evidence, `${status.library.evidence} vs ${beforeCounts.evidence}`);

  rmSync(destination, { recursive: true, force: true });
  source.cleanup();
  target.cleanup();
}

// --- 4. the restore guard refuses to overwrite ---------------------
{
  const source = makeLibrary("guard-src", 2);
  const destination = mkdtempSync(join(tmpdir(), "guard-dest-"));
  const backup = await source.service.backupLibrary(source.scope, { destination });

  const target = makeLibrary("guard-dst", 2);
  const before = target.store.stats().papers;
  let refused = null;
  try {
    await target.service.restoreLibrary(target.scope, { from: backup.directory });
  } catch (error) {
    refused = error;
  }
  check("restoring over a library with papers is refused", refused !== null, "the restore went through");
  check("the refusal names the target path",
    String(refused?.message ?? "").includes(target.home), String(refused?.message ?? ""));
  // Matched as "2 篇" rather than /2/: a bare digit could appear in the path or a
  // timestamp, and \b does not fire between a digit and a Chinese character.
  check("the refusal says how many papers are in the way",
    String(refused?.message ?? "").includes("2 篇"), String(refused?.message ?? ""));
  check("the refusal explains that force overrides it",
    /force/i.test(String(refused?.message ?? "")), String(refused?.message ?? ""));
  // The library must be untouched: a refusal that half-restores is worse than no guard.
  check("the target library is unchanged after a refusal",
    target.service.storeFor(target.scope).stats().papers === before, String(target.service.storeFor(target.scope).stats().papers));

  // An empty target is allowed without force: a fresh profile has an empty
  // database file and the user must be able to restore onto it.
  const emptyTarget = makeLibrary("guard-empty", 0);
  const guard = vault.checkRestoreGuard({
    targetDbPath: emptyTarget.store.dbPath, force: false,
    targetExists: true, targetPapers: 0,
  });
  check("an existing but empty library does not block a restore", guard.allowed === true, guard.reason);
  const blocked = vault.checkRestoreGuard({
    targetDbPath: "/some/library.sqlite", force: false, targetExists: true, targetPapers: 5,
  });
  check("a populated library blocks a restore", blocked.allowed === false, blocked.reason);
  check("force overrides the block",
    vault.checkRestoreGuard({ targetDbPath: "x", force: true, targetExists: true, targetPapers: 5 }).allowed === true);

  // With force, the restore goes through and replaces the data.
  const forced = await target.service.restoreLibrary(target.scope, { from: backup.directory, force: true });
  check("a forced restore succeeds", forced.ok === true);
  check("the forced restore replaced the data",
    target.service.storeFor(target.scope).stats().papers === 2, String(target.service.storeFor(target.scope).stats().papers));

  rmSync(destination, { recursive: true, force: true });
  source.cleanup();
  target.cleanup();
  emptyTarget.cleanup();
}

// --- 5. an invalid backup is refused before anything is touched ----
{
  const destination = mkdtempSync(join(tmpdir(), "invalid-dest-"));
  const brokenDir = join(destination, "broken");
  mkdirSync(join(brokenDir, "files"), { recursive: true });
  writeFileSync(join(brokenDir, "library.sqlite"), Buffer.from("not a database"));

  const target = makeLibrary("invalid-dst", 2);
  const before = target.store.stats().papers;
  let refused = null;
  try {
    await target.service.restoreLibrary(target.scope, { from: brokenDir });
  } catch (error) {
    refused = error;
  }
  check("a backup without a manifest is refused", refused !== null, "the restore went through");
  check("the refusal is about the backup, not the target",
    /manifest|invalid/i.test(String(refused?.message ?? "")), String(refused?.message ?? ""));
  check("the target library survives a refused restore",
    target.service.storeFor(target.scope).stats().papers === before);

  // A manifest that disagrees with the files on disk is also refused: this is the
  // "half-copied backup" case.
  const source = makeLibrary("manifest-src", 2);
  const backup = await source.service.backupLibrary(source.scope, { destination });
  rmSync(join(backup.directory, "files", "p1.pdf"), { force: true });
  let manifestRefused = null;
  try {
    await target.service.restoreLibrary(target.scope, { from: backup.directory, force: true });
  } catch (error) {
    manifestRefused = error;
  }
  check("a backup missing files the manifest promised is refused",
    manifestRefused !== null, "the restore went through");
  check("the refusal names the missing PDF count",
    /PDF/i.test(String(manifestRefused?.message ?? "")), String(manifestRefused?.message ?? ""));

  rmSync(destination, { recursive: true, force: true });
  source.cleanup();
  target.cleanup();
}

// --- 6. the report numbers match the disk -------------------------
{
  const library = makeLibrary("report", 4);
  const destination = mkdtempSync(join(tmpdir(), "report-dest-"));
  const result = await library.service.backupLibrary(library.scope, { destination });

  check("the report has a sqlite byte count", Number.isFinite(result.report.sqliteBytes));
  check("the report has a files byte count", Number.isFinite(result.report.filesBytes));
  check("the report has a duration", Number.isFinite(result.report.durationMs));
  check("the reported sqlite size matches the file on disk",
    result.report.sqliteBytes === statSync(join(result.directory, "library.sqlite")).size,
    `${result.report.sqliteBytes} vs ${statSync(join(result.directory, "library.sqlite")).size}`);
  // PDFs written as 100..103 bytes each.
  check("the reported PDF byte total matches the disk",
    result.report.filesBytes === 100 + 101 + 102 + 103, String(result.report.filesBytes));
  check("the reported PDF count matches the disk",
    result.report.pdfCount === 4, String(result.report.pdfCount));
  // The paper count and the PDF count are made to DIFFER here on purpose: with one
  // PDF per paper they are numerically identical, so a mutation that reports the
  // paper count as the PDF count is invisible. A metadata-only paper has no file.
  library.store.upsertPaper({
    paperId: "p-no-pdf", title: "No file", authors: "A", year: "2020", venue: "V",
    doi: "10.1/nofile", source: "test", pdfPath: "", fingerprint: "fp-nofile",
    material: "metadata", numPages: 0, pages: [], pageSources: [],
  });
  const mixed = await library.service.backupLibrary(library.scope, { destination: join(destination, "mixed") });
  check("the PDF count is not the paper count",
    mixed.report.pdfCount === 4 && mixed.counts.papers === 5,
    `pdf=${mixed.report.pdfCount} papers=${mixed.counts.papers}`);
  check("the reported PDF count still matches the disk when a paper has no file",
    mixed.report.pdfCount === 4, String(mixed.report.pdfCount));
  // And the duration must be a real measurement, not a constant: two backups of the
  // same library are extremely unlikely to take an identical number of milliseconds.
  check("the duration is a measured value, not a constant",
    Number.isFinite(result.report.durationMs) && result.report.durationMs >= 0, String(result.report.durationMs));
  check("the duration differs from a zero placeholder",
    result.report.durationMs !== 0 || mixed.report.durationMs !== 0,
    `${result.report.durationMs} / ${mixed.report.durationMs}`);
  check("the manifest records the same counts as the library",
    result.counts.papers === 4 && result.counts.pages === 8 && result.counts.evidence === 4,
    JSON.stringify(result.counts));

  // backupStatus must agree with what a backup would contain.
  const status = await library.service.backupStatus(library.scope);
  check("backupStatus reports the live PDF count", status.measured.pdfCount === 4, String(status.measured.pdfCount));
  // The library gained a metadata-only paper earlier in this block, so the live
  // count is read from the store rather than hardcoded: a hardcoded 4 was passing
  // only as long as nothing else touched the library.
  check("backupStatus reports the live paper count",
    status.counts.papers === library.store.stats().papers, `${status.counts.papers} vs ${library.store.stats().papers}`);
  // The listing is of the DEFAULT backups directory, so a backup written elsewhere
  // is correctly absent from it. Both halves are asserted: the default location is
  // discoverable, and a custom destination does not appear under it.
  check("a backup written to a custom destination is not listed under the default",
    !status.backups.some((name) => result.directory.endsWith(name)), JSON.stringify(status.backups));

  const defaultBackup = await library.service.backupLibrary(library.scope, {});
  check("a backup with no destination succeeds", defaultBackup.ok === true, JSON.stringify(defaultBackup.problems));
  check("the default destination is under the library directory",
    defaultBackup.directory.startsWith(join(dirname(library.store.dbPath), "backups")),
    defaultBackup.directory);
  const afterDefault = await library.service.backupStatus(library.scope);
  check("backupStatus lists the backup just written to the default location",
    afterDefault.backups.some((name) => defaultBackup.directory.endsWith(name)), JSON.stringify(afterDefault.backups));

  rmSync(destination, { recursive: true, force: true });
  library.cleanup();
}

// --- 7. backupStatus is honest about an empty library --------------
{
  const library = makeLibrary("empty", 0);
  const status = await library.service.backupStatus(library.scope);
  check("an empty library reports zero PDFs", status.measured.pdfCount === 0, String(status.measured.pdfCount));
  check("an empty library reports zero papers", status.counts.papers === 0, String(status.counts.papers));
  check("an empty library still names where backups go",
    typeof status.backupsDir === "string" && status.backupsDir !== "");
  library.cleanup();
}

// --- 8. the tool surface is untouched -----------------------------
{
  check("no backup tool was added", !/name: "paper_backup"/.test(tools) && !/paper_backup/.test(tools));
  check("the three backup RPCs are registered in markRemote",
    ["backupLibrary", "restoreLibrary", "backupStatus"].every((method) => host.includes(`"${method}"`)));
  check("the client reaches the input-taking backup RPCs through the wrapped path",
    /"backupLibrary",\s*"restoreLibrary"/.test(client));
  // backupStatus takes no input, and listing it in the wrapped set sends `input: {}`
  // anyway (callRemote defaults args to {}), which the gateway rejects. This assertion
  // used to require all three to be listed — it was encoding the defect, so fixing the
  // client turned it red.
  //
  // Scoped to the set itself: `backupStatus` is also a local variable holding the panel
  // state, so a bare /"backupStatus"/ over the whole file would always match.
  {
    const setStart = client.indexOf("INPUT_METHODS = new Set([");
    const setEnd = client.indexOf("]);", setStart);
    const wrappedSet = setStart >= 0 && setEnd > setStart ? client.slice(setStart, setEnd) : "";
    check("the zero-input backup RPC is not in the wrapped set", !/"backupStatus"/.test(wrappedSet));
  }
  // The export must not be built out of listPapers pages: that caps at the list
  // limit and would silently truncate a large library.
  const backupMethod = host.slice(host.indexOf("async backupLibrary("), host.indexOf("async restoreLibrary("));
  check("the export does not page through listPapers",
    !/listPapers/.test(backupMethod), "backupLibrary mentions listPapers");
  check("the export uses VACUUM INTO", /VACUUM INTO/.test(backupMethod));
}

// --- 9. the client renders the panel ------------------------------
// Mounted, so these are behaviour rather than strings: a mutation that deletes the
// panel while leaving the i18n keys in place must fail.
{
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { sep } = await import("node:path");
  const { installDom } = await import("./dom-stub.mjs");

  const ROOT = join(process.env.USERPROFILE ?? "", ".dsh", "profiles", "node_modules");
  const requireFromProfile = createRequire(join(ROOT, "noop.js"));
  let React;
  let createRoot;
  try {
    const domEntry = requireFromProfile.resolve("react-dom/server");
    const domRoot = domEntry.slice(0, domEntry.indexOf(`${sep}react-dom${sep}`));
    const requireFromDom = createRequire(join(domRoot, "noop.js"));
    ({ createRoot } = requireFromDom("react-dom/client"));
    React = requireFromDom("react");
  } catch (error) {
    console.log(`  SKIP the mount section (react unavailable: ${error.message})`);
  }

  if (React !== undefined) {
    const { document, window } = installDom({ width: 380, height: 720 });
    const seenErrors = [];
    const realError = console.error;
    console.error = (...args) => { seenErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")); };

    let exported = null;
    globalThis.window.__ModuleLoader__ = {
      load({ factory }) {
        exported = factory((id) => {
          if (id === "react") return React;
          throw new Error(`unexpected require: ${id}`);
        });
      },
    };
    await import(pathToFileURL(join(process.cwd(), "client.js")).href);
    const { Body, DICTS } = exported.__test;
    const zh = DICTS.zh;
    const t = (key, params) => {
      const raw = zh[key];
      if (raw === undefined) return key;
      return params === undefined ? raw : String(raw).replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])));
    };

    const PAPER = {
      paperId: "p1", title: "A paper", authors: "A", year: "2021", venue: "V", doi: "10.1/p1",
      source: "test", pdfPath: "/p1.pdf", numPages: 1, indexedAt: "2026-01-01",
      material: "fulltext", unverifiedFields: [], fromCrossrefFields: [],
    };
    const calls = [];
    let backupMade = false;
    let restoreCount = 0;
    const answer = (method, params) => {
      const input = params?.input ?? params?.args?.input ?? {};
      calls.push({ method, input });
      switch (method) {
        case "status":
          return { library: { papers: 1, pages: 2, evidence: 3 }, styles: ["apa"], translation: { supported: true, total: 0, engine: "agent", indexed: false }, limits: { maxImportFiles: 32, maxPdfBytes: 67108864 } };
        case "listPapers":
          return { papers: [PAPER], library: { papers: 1, pages: 2, evidence: 3 }, paging: { offset: 0, limit_returned: 1, total: 1, hasMore: false } };
        case "listEvidence":
          return { evidence: [], paging: { offset: 0, limit_returned: 0, total: 0, hasMore: false, anchoredTotal: 0, allTotal: 0 } };
        case "listAnnotations":
          return { annotations: [] };
        case "watchStatus":
          return { watching: false };
        case "backupStatus":
          return {
            dbPath: "C:\\profile\\paper-tool\\library.sqlite",
            filesDir: "C:\\profile\\paper-tool\\files",
            backupsDir: "C:\\profile\\paper-tool\\backups",
            measured: { dbBytes: 204800, filesBytes: 3145728, fileCount: 3, pdfCount: 3 },
            counts: { papers: 1, pages: 2, evidence: 3 },
            backups: backupMade ? ["paper-tool-backup-20261103-150000"] : [],
          };
        case "backupLibrary":
          backupMade = true;
          return {
            ok: true,
            directory: "C:\\profile\\paper-tool\\backups\\paper-tool-backup-20261103-150000",
            report: { sqliteBytes: 204800, filesBytes: 3145728, pdfCount: 3, durationMs: 42 },
            counts: { papers: 1, pages: 2, evidence: 3 },
            copyFailures: [], problems: [],
          };
        case "restoreLibrary":
          restoreCount += 1;
          return {
            ok: true, from: input.from, to: "C:\\profile\\paper-tool\\library.sqlite",
            filesCopied: 3, pathsRewritten: 1,
            // A paper whose bytes did not come across. Reported by the Host, and the
            // panel has to surface it: silence here reads as a clean restore.
            pdfMissing: restoreCount > 1 ? ["p-missing"] : [],
            counts: { papers: 1, pages: 2, evidence: 3 },
            expectedCounts: { papers: 1, pages: 2, evidence: 3 },
            fingerprint: "abc123",
          };
        default:
          return {};
      }
    };
    exported.apply({
      connection: { rpc: { async call(_path, method, options) {
        return { ok: true, value: answer(String(method).replace(/^paperTool\//, ""), options) };
      } } },
      locale: { register() {}, bind: () => t },
      slots: { inject() {}, register: () => ({}) },
      sidebarRightTabs: { register: () => ({}) },
      effect() {},
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(React.createElement(Body, { sessionId: "s34-ui", inputActions: { captureInsertion() {}, insertText() {} }, t }));
    const settle = async (turns = 20) => { for (let i = 0; i < turns; i += 1) await new Promise((r) => setTimeout(r, 0)); };
    await settle();

    check("the backup panel is reachable on mount", calls.some((call) => call.method === "backupStatus"),
      calls.map((call) => call.method).join(","));
    const text = () => host.textContent;
    check("the panel states the library size before backing up",
      text().includes(zh.backupSummary.split("{")[0].trim()) || /200 KB|3\.0 MB/.test(text()),
      text().slice(0, 300));
    check("the panel names where backups go",
      text().includes(zh.backupLivesAt), text().slice(0, 300));
    check("the panel explains the WAL/VACUUM choice",
      text().includes(zh.backupWalNote), text().slice(0, 400));
    check("an empty backup list says so",
      text().includes(zh.backupNone), text().slice(0, 300));

    const buttons = () => [...host.querySelectorAll("button")];
    const backupButton = buttons().find((button) => button.textContent.trim() === zh.backupNow);
    check("there is a control to back up the library", backupButton !== undefined,
      JSON.stringify(buttons().map((b) => b.textContent.trim())));
    backupButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();

    check("backing up issues the RPC", calls.some((call) => call.method === "backupLibrary"),
      calls.map((call) => call.method).join(","));
    check("the panel reports what landed on disk",
      text().includes("200 KB") && /3 PDF|3 个 PDF/.test(text()), text().slice(0, 400));
    // The three numbers individually, not just "backup complete": a mutation that
    // drops them can still leave the words "200 KB" elsewhere in the panel, so the
    // assertion is on the composed report line.
    // The composed note line, not the report block: a mutation that drops the
    // numbers from the note is invisible if the assertion only looks for "200 KB"
    // anywhere in the panel, because the report row prints it too.
    const noteLine = `${zh.backupDone} · 200 KB + 3 PDF · 42 ms`;
    check("the note reports what landed on disk",
      text().replace(/\s+/g, "").includes(noteLine.replace(/\s+/g, "")),
      text().slice(0, 600));
    check("the new backup appears in the list",
      text().includes("paper-tool-backup-20261103-150000"), text().slice(0, 500));

    // The force checkbox exists and is off by default: overwriting must be a
    // deliberate act, not a default.
    const forceBox = [...host.querySelectorAll("input")]
      .find((element) => element.getAttribute("aria-label") === zh.restoreForce);
    check("there is an explicit overwrite control", forceBox !== undefined,
      JSON.stringify([...host.querySelectorAll("input")].map((el) => el.getAttribute("aria-label"))));
    check("overwrite is off by default", forceBox?.checked === false, String(forceBox?.checked));

    const restoreButton = buttons().find((button) => button.textContent.trim() === zh.restore);
    check("each listed backup offers a restore control", restoreButton !== undefined,
      JSON.stringify(buttons().map((b) => b.textContent.trim())));
    restoreButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    const restoreCall = calls.find((call) => call.method === "restoreLibrary");
    check("restoring issues the RPC", restoreCall !== undefined);
    check("the restore names the backup directory",
      String(restoreCall?.input?.from ?? "").includes("paper-tool-backup-20261103-150000"),
      JSON.stringify(restoreCall?.input));
    check("the restore passes force=false by default",
      restoreCall?.input?.force === false, String(restoreCall?.input?.force));

    // Ticking the box must change what is sent. Without this, a mutation that
    // hardcodes force:false passes, and the overwrite control silently does nothing.
    // A controlled checkbox takes its state through onChange, same as the textarea
    // in s33: react-dom tracks `checked` separately and a hand-set property plus a
    // synthetic event does not always reach the handler through the stub.
    const checkboxPropsKey = Object.keys(forceBox).find((key) => key.startsWith("__reactProps"));
    const onCheck = forceBox[checkboxPropsKey]?.onChange;
    check("the overwrite control is a controlled input with an onChange", typeof onCheck === "function", typeof onCheck);
    onCheck({ target: { checked: true } });
    await settle(6);
    // Checked BEFORE restoring: a successful restore clears the flag, so a warning
    // asserted afterwards would be checking a state the UI has already left.
    check("ticking the overwrite box warns before overwriting",
      host.textContent.includes(zh.restoreForceWarning) || host.textContent.includes(zh.restoreForceDetail),
      host.textContent.slice(0, 400));
    const callsBefore = calls.filter((call) => call.method === "restoreLibrary").length;
    buttons().find((button) => button.textContent.trim() === zh.restore)
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    const forcedCall = calls.filter((call) => call.method === "restoreLibrary")[callsBefore];
    check("ticking the overwrite box makes the next restore send force=true",
      forcedCall?.input?.force === true, JSON.stringify(forcedCall?.input));


    // The forced restore returns a paper whose PDF bytes are absent. The panel has
    // to say so: a silent "restore complete" over a hole is the failure mode this
    // whole feature exists to prevent.
    check("a restore that left a PDF behind says which paper",
      text().includes(zh.restoreMissingPdf) && text().includes("p-missing"),
      text().slice(0, 600));

    const relevant = seenErrors.filter((line) => !/Warning:/.test(line) && !/not wrapped in act/.test(line));
    check("driving the backup panel raises no unexpected errors", relevant.length === 0, relevant.slice(0, 2).join(" | "));
    console.error = realError;
    try { root.unmount(); } catch { /* ignore */ }
  }
}

console.log("");
if (failures.length > 0) {
  console.log(`BACKUP FAILED (${failures.length}):`);
  for (const failure of failures) console.log("  - " + failure);
  process.exit(1);
}
console.log("BACKUP PASS");

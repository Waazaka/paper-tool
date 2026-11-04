// Gate: a database that is ALREADY at the current schema version must still receive
// columns that were added after its migration function was written.
//
// This is the shape of defect that a from-scratch test library can never catch, and it
// did ship: `sourceName` was appended to migrateToV4, but migrations are guarded by the
// stored version, so a library already at v4..v7 skipped it and kept a papers table
// without the column. Every path that writes a paper then failed with
// "table papers has no column named sourceName" — PDF import, .bib import, .ris import.
// A fresh install ran the whole chain and worked, so the plugin looked fine until it met
// an upgraded library.
//
// The test builds a v7 database that is missing the column, opens it through the real
// store, and asserts the column appears and stays usable. It also asserts the version
// number is NOT bumped, because rewriting user_version to force a migration would make
// an older build refuse to open the file.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { loadService } = await import("./shim.mjs");
const { PaperToolService } = await loadService();

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else { console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail)); failures.push(name); }
}

const home = mkdtempSync(join(tmpdir(), "s41-home-"));
const work = mkdtempSync(join(tmpdir(), "s41-work-"));
const { mkdirSync } = await import("node:fs");

try {
  // --- build a v7 database that predates sourceName --------------------
  // Let the real store create the file, then strip the column back out. SQLite cannot
  // DROP COLUMN before 3.35 and node:sqlite may not be that new, so the table is
  // rebuilt without it — which is also closer to what an old build actually wrote.
  const dbPath = join(home, "paper-tool", "library.sqlite");
  mkdirSync(join(home, "paper-tool"), { recursive: true });
  {
    const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home, shared: true });
    service.storeFor({ sessionId: "schema-build", workspaceRoot: work });
    service.dispose();
  }
  check("the store created a database", existsSync(dbPath));

  // A brand-new database must get the column too. It is easy to forget this half: the
  // repair is called in the "already current" branch for old databases AND after the
  // DDL for new ones, and dropping the second call leaves fresh installs broken while
  // the strip-and-reopen test below still passes. That gap was found by mutation.
  {
    const db = new DatabaseSync(dbPath);
    const columns = db.prepare("PRAGMA table_info(papers)").all().map((column) => column.name);
    check("a freshly created database has sourceName", columns.includes("sourceName"), columns.join(","));
    db.close();
  }

  let versionBefore = 0;
  {
    const db = new DatabaseSync(dbPath);
    const columns = db.prepare("PRAGMA table_info(papers)").all().map((column) => column.name);
    // The CREATE TABLE in DDL deliberately does not list sourceName — it arrives through
    // the repair pass. So the only thing to assert here is that the column is absent
    // BEFORE the repair, which the strip below establishes explicitly. What matters is
    // that opening a stripped database restores it (asserted further down).
    console.log("  info columns before strip: " + columns.join(","));

    // Rebuild papers without sourceName — this is what an older build left behind:
    // a table at the current version that never received the column.
    db.exec("BEGIN IMMEDIATE");
    db.exec("ALTER TABLE papers RENAME TO papers_old");
    const createSql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='papers_old'")
      .get().sql
      .replace(/^CREATE TABLE "papers_old"/, "CREATE TABLE papers")
      .replace(/,?\s*sourceName TEXT NOT NULL DEFAULT ''/, "");
    db.exec(createSql);
    db.exec("DROP TABLE papers_old");
    db.exec("COMMIT");

    const stripped = db.prepare("PRAGMA table_info(papers)").all().map((column) => column.name);
    check("the stripped database really lost the column", !stripped.includes("sourceName"), stripped.join(","));
    versionBefore = db.prepare("PRAGMA user_version").get().user_version;
    check("the stripped database still reports the current version", versionBefore > 0, "user_version=" + versionBefore);
    db.close();
  }

  // --- open it through the real store ---------------------------------
  {
    const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home, shared: true });
    const scope = { sessionId: "schema-open", workspaceRoot: work };
    const store = service.storeFor(scope);

    const db = new DatabaseSync(dbPath);
    const columns = db.prepare("PRAGMA table_info(papers)").all().map((column) => column.name);
    check("opening an up-to-date database adds the missing column", columns.includes("sourceName"), columns.join(","));
    const versionAfter = db.prepare("PRAGMA user_version").get().user_version;
    check("the repair does not bump the schema version", versionAfter === versionBefore,
      versionBefore + " -> " + versionAfter);
    db.close();

    // The point of the column is that writing a paper works at all.
    let wrote = null;
    try {
      wrote = store.upsertPaper({
        paperId: "s41-paper-0000-4000-8000-000000000001",
        title: "A Paper Written Into a Repaired Database",
        authors: "Doe, Jane",
        year: "2024",
        venue: "Journal of Repairs",
        doi: "10.9999/repair.2024",
        source: "manual",
        pdfPath: "",
        fingerprint: "s41-fingerprint",
        numPages: 1,
        material: "fulltext",
        textSource: "text-layer",
        metadataSource: {},
        sourceName: "repair-test.pdf",
      });
    } catch (error) {
      wrote = { error: error.message };
    }
    check("writing a paper into the repaired database succeeds", wrote !== null && wrote.error === undefined,
      JSON.stringify(wrote)?.slice(0, 200));
    check("the repair kept the source file name", (wrote?.sourceName ?? store.getPaper?.(wrote?.paperId)?.sourceName ?? "") === "repair-test.pdf",
      JSON.stringify(wrote?.sourceName));

    // Re-opening must be idempotent: a second ensureSourceNameColumn pass must not throw
    // on a column that already exists.
    service.dispose();
    let reopened = true;
    try {
      const again = new PaperToolService({ inject() {}, get() {} }, { homeDir: home, shared: true });
      again.storeFor({ sessionId: "schema-reopen", workspaceRoot: work });
      again.dispose();
    } catch (error) {
      reopened = false;
      check("re-opening the repaired database is idempotent", false, error.message);
    }
    if (reopened) check("re-opening the repaired database is idempotent", true);
  }
} finally {
  // Windows keeps a directory busy briefly after the sqlite handles close; a hard
  // failure here would report a cleanup problem as a gate failure.
  for (const dir of [home, work]) {
    try { rmSync(dir, { recursive: true, force: true }); }
    catch { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp dir */ } }
  }
}

console.log("");
if (failures.length > 0) {
  console.log("SCHEMA-REPAIR FAILED (" + failures.length + "):");
  for (const name of failures) console.log("  - " + name);
  process.exit(1);
}
console.log("SCHEMA-REPAIR PASS");

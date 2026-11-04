// Gate: every column the store adds with ALTER TABLE must reach a database that is
// ALREADY at the current schema version.
//
// This generalises the defect s41 caught by hand. `sourceName` was appended to
// migrateToV4, but migrations are guarded by the stored version — `if (current < 4)
// migrateToV4(db)` — so a library already past v4 never ran it, kept a papers table
// without the column, and every import died with "table papers has no column named
// sourceName". A fresh install ran the whole chain and worked, which is why it shipped.
//
// The next column will be added the same way, and will be equally unreachable for every
// database that already passed that migration. So this gate does not test one column: it
// reads every `ALTER TABLE <table> ADD COLUMN <name>` out of lib/store.js, builds a
// database at the current version, strips each such column in turn, reopens it through
// the real store, and requires the column back.
//
// It also checks the write contract directly: every column named in an INSERT must exist
// in the schema a freshly built database has, because a mismatch there means some code
// path cannot run on a correctly built database at all.
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const { loadService } = await import("./shim.mjs");
const { PaperToolService } = await loadService();

const storeSource = readFileSync(new URL("../lib/store.js", import.meta.url), "utf8");

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else { console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail)); failures.push(name); }
}

function openService(home) {
  const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home, shared: true });
  service.storeFor({ sessionId: "s42-" + Math.random().toString(36).slice(2), workspaceRoot: home });
  service.dispose();
  return join(home, "paper-tool", "library.sqlite");
}

function columnsOf(dbPath, table) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name); }
  finally { db.close(); }
}

// --- the columns added after CREATE TABLE -----------------------------
// Read the authoritative list out of the store. It used to be derived from `ALTER TABLE`
// statements scattered through the migration functions; they are now centralised in
// LATE_COLUMNS, which is also what makes this gate possible to write at all.
const lateBlock = storeSource.slice(
  storeSource.indexOf("const LATE_COLUMNS"),
  storeSource.indexOf("];", storeSource.indexOf("const LATE_COLUMNS")),
);
const alters = [...lateBlock.matchAll(/table:\s*"(\w+)",\s*column:\s*"(\w+)"/g)]
  .map((match) => ({ table: match[1], column: match[2] }));
check("the gate found the late-added columns", alters.length >= 5,
  "found=" + alters.map((a) => a.table + "." + a.column).join(","));
console.log("  info late columns: " + alters.map((a) => a.table + "." + a.column).join(", "));

// Guard against the list quietly losing an entry: every ALTER left in the store must
// also be registered, or it is back to being invisible to a database at the current
// version.
{
  const strayAlters = [...storeSource.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)/g)]
    .map((match) => ({ table: match[1], column: match[2] }))
    .filter((alter) => !alters.some((a) => a.table === alter.table && a.column === alter.column));
  check("no ALTER bypasses the late-column list", strayAlters.length === 0,
    "unregistered=" + strayAlters.map((a) => a.table + "." + a.column).join(","));
}

// --- every ALTER column survives a repair on a current-version DB ------
for (const { table, column } of alters) {
  const home = mkdtempSync(join(tmpdir(), `s42-${table}-${column}-`));
  try {
    const dbPath = openService(home);
    check(`${table}.${column}: a fresh database has it`, columnsOf(dbPath, table).includes(column));

    // Strip just this column by rebuilding the table without it. This is what an older
    // build left behind: a table at the current version missing one late-added column.
    {
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA foreign_keys=OFF");
      db.exec("BEGIN IMMEDIATE");
      db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
      const createSql = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(`${table}_old`).sql
        .replace(new RegExp(`^CREATE TABLE "${table}_old"`), `CREATE TABLE ${table}`)
        .replace(new RegExp(`,\\s*${column}\\s+TEXT\\s+NOT NULL\\s+DEFAULT\\s*'[^']*'`), "");
      db.exec(createSql);
      // The tables are empty at this point (a fresh library), so there are no rows to
      // carry over — copying them would only add a way for this gate to break on SQL
      // quoting rather than on the schema question it exists to ask.
      db.exec(`DROP TABLE ${table}_old`);
      db.exec("COMMIT");
      db.close();
    }

    {
      const db = new DatabaseSync(dbPath);
      const stripped = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      check(`${table}.${column}: the strip really removed it`, !stripped.includes(column), stripped.join(","));
      const version = db.prepare("PRAGMA user_version").get().user_version;
      check(`${table}.${column}: the stripped database is still at the current version`, version > 0, "v=" + version);
      db.close();
    }

    // Reopen through the real store: the repair must restore it.
    const reopened = openService(home);
    check(`${table}.${column}: reopening restores the column`, columnsOf(reopened, table).includes(column));

    // And doing it twice must not throw.
    let twice = true;
    try { openService(home); } catch (error) { twice = false; check(`${table}.${column}: repairing twice is idempotent`, false, error.message); }
    if (twice) check(`${table}.${column}: repairing twice is idempotent`, true);
  } finally {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
  }
}

// --- the write contract matches a fresh schema ------------------------
{
  const home = mkdtempSync(join(tmpdir(), "s42-contract-"));
  try {
    const dbPath = openService(home);
    const written = new Map();
    for (const match of storeSource.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]*)\)/g)) {
      const table = match[1];
      if (table.endsWith("_fts") || table.endsWith("_cjk")) continue;
      if (!written.has(table)) written.set(table, new Set());
      for (const raw of match[2].split(",")) {
        const name = raw.trim().split(/\s+/)[0];
        if (name !== "") written.get(table).add(name);
      }
    }
    check("the gate found the write contract", written.size >= 5, "tables=" + [...written.keys()].join(","));
    for (const [table, columns] of written) {
      const actual = columnsOf(dbPath, table);
      if (actual.length === 0) { check(`${table}: table exists`, false, "missing table"); continue; }
      const missing = [...columns].filter((name) => !actual.includes(name));
      check(`${table}: every inserted column exists in a fresh schema`, missing.length === 0, "missing=" + missing.join(","));
    }
  } finally {
    try { rmSync(home, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp */ }
  }
}

console.log("");
if (failures.length > 0) {
  console.log("SCHEMA-PARITY FAILED (" + failures.length + "):");
  for (const name of failures) console.log("  - " + name);
  process.exit(1);
}
console.log("SCHEMA-PARITY PASS");

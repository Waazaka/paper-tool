/**
 * Library backup and migration.
 *
 * The library is a single SQLite file plus a `files/` directory of PDF bytes, both
 * living under the DSH profile home — not in the workspace, not in git, not on any
 * natural sync path. The design that puts it there is deliberate (a personal
 * research library crosses projects, so a per-workspace library would look like
 * data loss the first time you opened another folder), but the cost is that the
 * one thing in this tool that cannot be rebuilt is also the thing nobody would
 * think to back up.
 *
 * What cannot be rebuilt: evidence rows with their hand-selected character
 * offsets, claims and their evidence bindings, and metadata the user corrected by
 * hand. PDFs can be downloaded again; those cannot.
 *
 * Two rules shape everything below:
 *
 *   1. A backup that silently misses data is worse than no backup, because the
 *      user believes they are covered. So the export is verified by reading the
 *      snapshot back, and the file counts are reported rather than assumed.
 *
 *   2. The database is in WAL mode, so a plain file copy can miss the newest
 *      commits. `VACUUM INTO` writes a checkpointed, self-consistent snapshot of a
 *      live database — that is the whole reason this module does not just
 *      `copyFileSync` the .sqlite.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

/** Name of the manifest written into every backup directory. */
export const MANIFEST_NAME = "manifest.json";

/** Bumped when the manifest shape changes; a reader refuses what it cannot read. */
export const MANIFEST_VERSION = 1;

/**
 * Summarise what a library directory holds, before or after a backup.
 *
 * Sizes come from `statSync` on the real files, not from a running total the
 * caller maintains: a reported size that disagrees with the disk is the exact
 * failure this is meant to rule out.
 *
 * @param {{ dbPath: string, filesDir: string }} input
 * @returns {{ dbBytes: number, filesBytes: number, fileCount: number, pdfCount: number }}
 */
export function measureLibrary({ dbPath, filesDir }) {
  let dbBytes = 0;
  if (typeof dbPath === "string" && existsSync(dbPath)) {
    dbBytes = statSync(dbPath).size;
  }
  let filesBytes = 0;
  let pdfCount = 0;
  if (typeof filesDir === "string" && existsSync(filesDir)) {
    for (const name of readdirSync(filesDir)) {
      if (!name.toLowerCase().endsWith(".pdf")) continue;
      const full = join(filesDir, name);
      const stat = statSync(full);
      if (!stat.isFile()) continue;
      filesBytes += stat.size;
      pdfCount += 1;
    }
  }
  return { dbBytes, filesBytes, fileCount: pdfCount, pdfCount };
}

/**
 * Record what a backup contains, so a restore can be checked against it.
 *
 * The manifest is the difference between "the copy finished" and "the copy is
 * complete": a restore compares the destination against these numbers and fails
 * loudly if they disagree, instead of leaving a half-copied library that looks
 * plausible.
 *
 * @param {{ createdAt: string, dbBytes: number, filesBytes: number, pdfCount: number, papers: number, pages: number, evidence: number, sourceDbPath: string }} input
 */
export function buildManifest(input) {
  return {
    manifestVersion: MANIFEST_VERSION,
    createdAt: input.createdAt,
    // Only the database file name is recorded, never the absolute path it came
    // from: the snapshot must be relocatable, and a stored absolute path is how a
    // restore ends up writing to the old machine's directory layout.
    dbFile: "library.sqlite",
    filesDir: "files",
    dbBytes: input.dbBytes,
    filesBytes: input.filesBytes,
    pdfCount: input.pdfCount,
    counts: { papers: input.papers, pages: input.pages, evidence: input.evidence },
  };
}

/**
 * Check that a completed backup matches its own manifest.
 *
 * Run against the files on disk. Returns `{ ok, problems }` rather than throwing,
 * because the caller has to report the reason — "backup failed: 3 PDFs missing"
 * is actionable, an exception is not.
 *
 * @param {string} backupDir
 */
export function verifyBackup(backupDir) {
  const problems = [];
  const manifestPath = join(backupDir, MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    return { ok: false, problems: ["manifest.json is missing"], manifest: null };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return { ok: false, problems: [`manifest.json is not valid JSON: ${String(error?.message ?? error)}`], manifest: null };
  }
  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    problems.push(`manifest version ${manifest.manifestVersion} is not ${MANIFEST_VERSION}`);
  }
  const dbPath = join(backupDir, manifest.dbFile ?? "library.sqlite");
  if (!existsSync(dbPath)) {
    problems.push("the database file is missing");
  } else {
    const actual = statSync(dbPath).size;
    if (actual !== manifest.dbBytes) {
      problems.push(`database is ${actual} bytes but the manifest says ${manifest.dbBytes}`);
    }
  }
  const filesDir = join(backupDir, manifest.filesDir ?? "files");
  const measured = measureLibrary({ dbPath, filesDir });
  if (measured.pdfCount !== manifest.pdfCount) {
    problems.push(`${measured.pdfCount} PDFs present but the manifest says ${manifest.pdfCount}`);
  }
  if (measured.filesBytes !== manifest.filesBytes) {
    problems.push(`PDF bytes total ${measured.filesBytes} but the manifest says ${manifest.filesBytes}`);
  }
  return { ok: problems.length === 0, problems, manifest };
}

/**
 * Rewrite a library's `pdfPath` values so they point inside the destination.
 *
 * This is the step that makes a backup actually portable. Every row stores an
 * absolute path (`<profile>/paper-tool/files/<paperId>.pdf`), so restoring on
 * another machine — or into another profile — leaves every paper pointing at a
 * directory that does not exist there. The PDFs are present and correct; only the
 * string is wrong, and the failure looks like "the PDF is gone".
 *
 * Only the file name is kept, so the rewrite is independent of the old layout.
 * Rows whose path is already empty or not a PDF are left alone.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} filesDir absolute destination `files/` directory
 * @returns {{ rewritten: number, missing: string[] }}
 */
export function rewritePdfPaths(db, filesDir) {
  const rows = db.prepare("SELECT paperId, pdfPath FROM papers").all();
  const update = db.prepare("UPDATE papers SET pdfPath = ? WHERE paperId = ?");
  const missing = [];
  let rewritten = 0;
  for (const row of rows) {
    const current = typeof row.pdfPath === "string" ? row.pdfPath : "";
    if (current === "") continue;
    // Whatever the old prefix was, the file name is the identity: it is
    // `<paperId>.pdf` by construction. Keeping the name and replacing the
    // directory is what makes this layout-independent.
    const name = basename(current.replace(/\\/g, "/"));
    if (!name.toLowerCase().endsWith(".pdf")) continue;
    const next = join(filesDir, name);
    if (next !== current) {
      update.run(next, row.paperId);
      rewritten += 1;
    }
    // Reported, not silently repaired: a row whose bytes never made it into the
    // backup is a real hole, and the user has to hear about it.
    if (!existsSync(next)) missing.push(row.paperId);
  }
  return { rewritten, missing };
}

/**
 * Guard a restore against overwriting a library that already holds data.
 *
 * Refusing is the default because the destructive direction is unrecoverable from
 * inside this tool: there is no undo for "I restored an empty backup over my
 * library". The check looks at the *existence* of a database file, not at whether
 * it is empty, because a fresh install creates an empty one on first open — a
 * user restoring onto a machine they have just launched DSH on should be allowed
 * to proceed, so an existing-but-empty database is not a reason to refuse.
 *
 * @param {{ targetDbPath: string, force: boolean, targetExists: boolean, targetPapers: number }} input
 * @returns {{ allowed: boolean, reason: string, message: string }}
 */
export function checkRestoreGuard({ targetDbPath, force, targetExists, targetPapers }) {
  if (force === true) {
    return { allowed: true, reason: "forced", message: "" };
  }
  if (targetExists !== true) {
    return { allowed: true, reason: "empty-target", message: "" };
  }
  if (targetPapers === 0) {
    return { allowed: true, reason: "empty-target", message: "" };
  }
  return {
    allowed: false,
    reason: "target-has-data",
    message: `目标位置已有 ${targetPapers} 篇论文：${targetDbPath}。要覆盖请显式指定 force。`,
  };
}

/**
 * Compare two libraries table by table.
 *
 * Restoration is only worth anything if the result is equivalent, and "the file
 * copied" is not equivalence. Rows and primary keys are compared, not just counts:
 * a restore that lost one paper and duplicated another has the right count and the
 * wrong contents.
 *
 * @param {import("node:sqlite").DatabaseSync} left
 * @param {import("node:sqlite").DatabaseSync} right
 * @param {Array<{ table: string, key: string }>} tables
 */
export function compareLibraries(left, right, tables) {
  const report = {};
  let equal = true;
  for (const { table, key } of tables) {
    const leftRows = left.prepare(`SELECT ${key} FROM ${table}`).all().map((row) => String(row[key]));
    const rightRows = right.prepare(`SELECT ${key} FROM ${table}`).all().map((row) => String(row[key]));
    const leftSet = new Set(leftRows);
    const rightSet = new Set(rightRows);
    const onlyLeft = leftRows.filter((id) => !rightSet.has(id));
    const onlyRight = rightRows.filter((id) => !leftSet.has(id));
    const tableEqual = onlyLeft.length === 0 && onlyRight.length === 0 && leftRows.length === rightRows.length;
    if (!tableEqual) equal = false;
    report[table] = {
      leftRows: leftRows.length,
      rightRows: rightRows.length,
      onlyInLeft: onlyLeft.slice(0, 10),
      onlyInRight: onlyRight.slice(0, 10),
      equal: tableEqual,
    };
  }
  return { equal, report };
}

/** Tables and their primary keys, for the equivalence check. */
export const PARITY_TABLES = [
  { table: "papers", key: "paperId" },
  { table: "pages", key: "rowid" },
  { table: "evidence", key: "evidenceId" },
  { table: "claims", key: "claimId" },
  { table: "claim_evidence", key: "rowid" },
  { table: "annotations", key: "annotationId" },
  { table: "translations", key: "translationId" },
];

/**
 * A stable directory name for one backup.
 *
 * Sortable by time and free of characters a shell or a Windows path dislikes, so
 * a folder of backups lists in chronological order without opening any of them.
 *
 * @param {Date} [now]
 */
export function backupDirName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `paper-tool-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * Copy a directory of PDFs, returning what actually landed.
 *
 * Returns the counts instead of assuming success: the manifest is built from the
 * destination, so a file that failed to copy shows up as a mismatch at verify
 * time rather than as a number the exporter wished for.
 *
 * @param {string} fromDir
 * @param {string} toDir
 */
export function copyPdfFiles(fromDir, toDir) {
  if (!existsSync(fromDir)) return { copied: 0, failures: [] };
  mkdirSync(toDir, { recursive: true });
  const failures = [];
  let copied = 0;
  for (const name of readdirSync(fromDir)) {
    if (!name.toLowerCase().endsWith(".pdf")) continue;
    const from = join(fromDir, name);
    if (!statSync(from).isFile()) continue;
    try {
      copyFileSync(from, join(toDir, name));
      copied += 1;
    } catch (error) {
      failures.push({ name, reason: String(error?.message ?? error) });
    }
  }
  return { copied, failures };
}

/** Write the manifest, so a half-finished backup is recognisable as one. */
export function writeManifest(backupDir, manifest) {
  mkdirSync(backupDir, { recursive: true });
  const path = join(backupDir, MANIFEST_NAME);
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf8");
  return path;
}

/**
 * A short content hash, used only to prove two databases hold the same rows.
 *
 * Deliberately not a security primitive: it answers "did the copy change
 * anything", not "did someone tamper with this".
 *
 * `papers.pdfPath` is normalised out. Every backup stores absolute paths, and a
 * restore into another profile necessarily rewrites them — that rewrite is the
 * point of the feature, not corruption. Hashing the column would make the
 * fingerprint differ for every correct restore, which would turn a useful check
 * into a permanent failure.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 */
export function databaseFingerprint(db) {
  const hash = createHash("sha256");
  for (const table of ["papers", "pages", "evidence", "claims", "claim_evidence", "annotations", "translations"]) {
    hash.update(table);
    let rows = [];
    try {
      rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    } catch {
      // A table that does not exist in an older library contributes nothing.
      continue;
    }
    for (const row of rows) {
      const copy = { ...row };
      if (table === "papers") {
        // Keep only the file name: it is the identity, the directory is not.
        copy.pdfPath = typeof copy.pdfPath === "string" && copy.pdfPath !== ""
          ? copy.pdfPath.replace(/\\/g, "/").split("/").pop()
          : "";
      }
      hash.update(JSON.stringify(copy));
    }
  }
  return hash.digest("hex").slice(0, 16);
}

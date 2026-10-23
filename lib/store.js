// Local library store (S1): node:sqlite + FTS5.
//
// Zero external deps: Node 24 ships node:sqlite with FTS5 (unicode61 for
// latin, plus a trigram index for CJK, where unicode61 would tokenize the
// whole Chinese run as one token).
//
// Schema is versioned by PRAGMA user_version; migrations run forward only.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = 1;

/** Tables. `pages` keeps one row per PDF page so offsets stay page-local. */
const DDL = [
  `CREATE TABLE IF NOT EXISTS papers (
    paperId     TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    authors     TEXT NOT NULL DEFAULT '',
    year        TEXT NOT NULL DEFAULT '',
    venue       TEXT NOT NULL DEFAULT '',
    doi         TEXT NOT NULL DEFAULT '',
    abstract    TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT '',
    pdfPath     TEXT NOT NULL DEFAULT '',
    fingerprint TEXT NOT NULL DEFAULT '',
    numPages    INTEGER NOT NULL DEFAULT 0,
    indexedAt   TEXT NOT NULL DEFAULT '',
    material    TEXT NOT NULL DEFAULT 'metadata'
  )`,
  `CREATE TABLE IF NOT EXISTS pages (
    paperId   TEXT NOT NULL,
    pageIndex INTEGER NOT NULL,
    text      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (paperId, pageIndex)
  )`,
  `CREATE TABLE IF NOT EXISTS evidence (
    evidenceId TEXT PRIMARY KEY,
    paperId    TEXT NOT NULL,
    pageIndex  INTEGER NOT NULL,
    charStart  INTEGER NOT NULL DEFAULT 0,
    charEnd    INTEGER NOT NULL DEFAULT 0,
    quote      TEXT NOT NULL,
    createdAt  TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS evidence_paper ON evidence(paperId)`,
  `CREATE TABLE IF NOT EXISTS claims (
    claimId   TEXT PRIMARY KEY,
    text      TEXT NOT NULL,
    section   TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS claim_evidence (
    claimId    TEXT NOT NULL,
    evidenceId TEXT NOT NULL,
    stance     TEXT NOT NULL DEFAULT 'support',
    strength   TEXT NOT NULL DEFAULT 'medium',
    PRIMARY KEY (claimId, evidenceId)
  )`,
  // Latin/word index over page text.
  `CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    text, content='pages', content_rowid='rowid', tokenize='unicode61'
  )`,
  // CJK index: trigram lets Chinese substrings match without a segmenter.
  `CREATE VIRTUAL TABLE IF NOT EXISTS pages_cjk USING fts5(
    text, content='pages', content_rowid='rowid', tokenize='trigram'
  )`,
  `CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts(rowid, text) VALUES (new.rowid, new.text);
    INSERT INTO pages_cjk(rowid, text) VALUES (new.rowid, new.text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO pages_cjk(pages_cjk, rowid, text) VALUES ('delete', old.rowid, old.text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO pages_cjk(pages_cjk, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO pages_fts(rowid, text) VALUES (new.rowid, new.text);
    INSERT INTO pages_cjk(rowid, text) VALUES (new.rowid, new.text);
  END`,
];

/**
 * Open (or create) the library database.
 * @param {string} dbPath absolute path to the sqlite file.
 */
export function openStore(dbPath) {
  if (typeof dbPath !== "string" || dbPath === "") throw new Error("openStore: dbPath required");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  return new Store(db);
}

function migrate(db) {
  const current = db.prepare("PRAGMA user_version").get().user_version;
  if (current === SCHEMA_VERSION) return;
  if (current > SCHEMA_VERSION) {
    throw new Error(`store: database schema v${current} is newer than v${SCHEMA_VERSION}`);
  }
  db.exec("BEGIN");
  try {
    for (const stmt of DDL) db.exec(stmt);
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Split text into CJK-aware query terms; returns FTS match expressions. */
export function buildMatchQuery(raw) {
  const query = String(raw ?? "").trim();
  if (query === "") return null;
  const hasCjk = /[\u3400-\u9fff\uf900-\ufaff]/.test(query);
  // Strip FTS operators so user input cannot become syntax.
  const cleaned = query.replace(/["'^*():-]/g, " ").trim();
  if (cleaned === "") return null;
  // AND the terms; trigram needs >= 3 chars, so short CJK runs fall back to a
  // prefix match on the word index.
  const words = cleaned.split(/\s+/).filter(Boolean);
  return { words, hasCjk };
}

/**
 * Run a full-text search over page text.
 *
 * Latin queries use the FTS5 word index. CJK queries use a LIKE scan instead:
 * measured against real papers, unicode61 treats a whole Chinese run as one
 * token (so 「研究」 only matched when the term happened to sit beside
 * punctuation) and trigram cannot match anything shorter than 3 characters.
 * A LIKE scan is correct for every CJK length.
 * ponytail: LIKE is O(pages); fine for a personal library (10^3-10^4 pages).
 * If the library ever reaches 10^5+ pages, add a bigram FTS index instead.
 *
 * @returns {{paperId: string, pageIndex: number, snippet: string}[]}
 */
function searchPages(db, rawQuery, limit) {
  const query = String(rawQuery ?? "").trim();
  if (query === "") return [];

  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(query)) {
    const needle = query.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    const rows = db
      .prepare(
        `SELECT paperId, pageIndex, text FROM pages
          WHERE text LIKE ? ESCAPE '\\'
          ORDER BY paperId, pageIndex LIMIT ?`,
      )
      .all(`%${needle}%`, limit);
    return rows.map((row) => ({
      paperId: row.paperId,
      pageIndex: row.pageIndex,
      snippet: makeSnippet(row.text, query),
    }));
  }

  // Latin: AND the terms on the word index. Strip FTS operators so user input
  // cannot become query syntax.
  const words = query
    .replace(/["'^*():-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return [];
  const expr = words.map((word) => `"${word}"`).join(" AND ");
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT p.paperId AS paperId, p.pageIndex AS pageIndex,
                snippet(pages_fts, 0, '[', ']', '…', 12) AS snippet
           FROM pages_fts
           JOIN pages p ON p.rowid = pages_fts.rowid
          WHERE pages_fts MATCH ?
          LIMIT ?`,
      )
      .all(expr, limit);
  } catch {
    rows = db
      .prepare(
        `SELECT paperId, pageIndex, text FROM pages
          WHERE text LIKE ? ESCAPE '\\' LIMIT ?`,
      )
      .all(`%${query.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`, limit)
      .map((row) => ({ ...row, snippet: makeSnippet(row.text, query) }));
  }
  return rows.map((row) => ({
    paperId: row.paperId,
    pageIndex: row.pageIndex,
    snippet: row.snippet ?? "",
  }));
}

/** Bracket the match inside a short window of surrounding text. */
function makeSnippet(text, query) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, 80);
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + query.length + 40);
  return `${start > 0 ? "…" : ""}${text.slice(start, at)}[${text.slice(at, at + query.length)}]${text.slice(at + query.length, end)}${end < text.length ? "…" : ""}`;
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  /** Insert or replace a paper with its page texts. */
  upsertPaper(paper) {
    const {
      paperId,
      title = "",
      authors = "",
      year = "",
      venue = "",
      doi = "",
      abstract = "",
      source = "",
      pdfPath = "",
      fingerprint = "",
      material = "metadata",
      pages = [],
    } = paper;
    if (typeof paperId !== "string" || paperId === "") throw new Error("upsertPaper: paperId required");
    const db = this.db;
    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT INTO papers (paperId,title,authors,year,venue,doi,abstract,source,pdfPath,fingerprint,numPages,indexedAt,material)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(paperId) DO UPDATE SET
           title=excluded.title, authors=excluded.authors, year=excluded.year,
           venue=excluded.venue, doi=excluded.doi, abstract=excluded.abstract,
           source=excluded.source, pdfPath=excluded.pdfPath,
           fingerprint=excluded.fingerprint, numPages=excluded.numPages,
           indexedAt=excluded.indexedAt, material=excluded.material`,
      ).run(
        paperId,
        title,
        authors,
        year,
        venue,
        doi,
        abstract,
        source,
        pdfPath,
        fingerprint,
        pages.length,
        new Date().toISOString(),
        material,
      );
      db.prepare("DELETE FROM pages WHERE paperId = ?").run(paperId);
      const insertPage = db.prepare("INSERT INTO pages (paperId,pageIndex,text) VALUES (?,?,?)");
      pages.forEach((text, index) => insertPage.run(paperId, index, text));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return this.getPaper(paperId);
  }

  getPaper(paperId) {
    return this.db.prepare("SELECT * FROM papers WHERE paperId = ?").get(paperId) ?? null;
  }

  /** Update user-editable metadata; bibliographic fields are the only ones. */
  updatePaper(paperId, fields = {}) {
    const current = this.getPaper(paperId);
    if (current === null) return null;
    const pick = (name) => (typeof fields[name] === "string" ? fields[name] : current[name]);
    this.db
      .prepare(
        `UPDATE papers
            SET title = ?, authors = ?, year = ?, venue = ?, doi = ?, abstract = ?
          WHERE paperId = ?`,
      )
      .run(
        pick("title"),
        pick("authors"),
        pick("year"),
        pick("venue"),
        pick("doi"),
        pick("abstract"),
        paperId,
      );
    return this.getPaper(paperId);
  }

  /**
   * Find an already-imported paper by its content fingerprint.
   *
   * pdf.js reports the same fingerprint for the same bytes, so re-importing a
   * file the library already holds must return the existing row instead of
   * creating a second entry with a fresh id.
   */
  findByFingerprint(fingerprint) {
    if (typeof fingerprint !== "string" || fingerprint === "") return null;
    return this.db.prepare("SELECT * FROM papers WHERE fingerprint = ? LIMIT 1").get(fingerprint) ?? null;
  }

  listPapers({ limit = 200, offset = 0 } = {}) {
    return this.db
      .prepare("SELECT * FROM papers ORDER BY indexedAt DESC, title ASC LIMIT ? OFFSET ?")
      .all(limit, offset);
  }

  deletePaper(paperId) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM pages WHERE paperId = ?").run(paperId);
      this.db.prepare("DELETE FROM evidence WHERE paperId = ?").run(paperId);
      this.db.prepare("DELETE FROM papers WHERE paperId = ?").run(paperId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getPageText(paperId, pageIndex) {
    const row = this.db
      .prepare("SELECT text FROM pages WHERE paperId = ? AND pageIndex = ?")
      .get(paperId, pageIndex);
    return row?.text ?? null;
  }

  /** Full-text search across indexed pages. */
  search(query, { limit = 30 } = {}) {
    const hits = searchPages(this.db, query, limit);
    return hits.map((hit) => {
      const paper = this.getPaper(hit.paperId);
      return {
        paperId: hit.paperId,
        pageIndex: hit.pageIndex,
        snippet: hit.snippet ?? "",
        title: paper?.title ?? "",
        year: paper?.year ?? "",
        material: paper?.material ?? "metadata",
      };
    });
  }

  /** Metadata-only search over titles/abstracts, for papers without a PDF. */
  searchMetadata(query, { limit = 30 } = {}) {
    const term = `%${String(query ?? "").trim()}%`;
    if (term === "%%") return [];
    return this.db
      .prepare(
        `SELECT * FROM papers
          WHERE title LIKE ? OR abstract LIKE ? OR authors LIKE ? OR doi LIKE ?
          ORDER BY year DESC LIMIT ?`,
      )
      .all(term, term, term, term, limit);
  }

  addEvidence({ evidenceId, paperId, pageIndex, charStart, charEnd, quote }) {
    this.db
      .prepare(
        `INSERT INTO evidence (evidenceId,paperId,pageIndex,charStart,charEnd,quote,createdAt)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(evidenceId) DO UPDATE SET quote=excluded.quote`,
      )
      .run(evidenceId, paperId, pageIndex, charStart, charEnd, quote, new Date().toISOString());
    return this.getEvidence(evidenceId);
  }

  getEvidence(evidenceId) {
    return this.db.prepare("SELECT * FROM evidence WHERE evidenceId = ?").get(evidenceId) ?? null;
  }

  deleteEvidence(evidenceId) {
    this.db.prepare("DELETE FROM evidence WHERE evidenceId = ?").run(evidenceId);
  }

  listEvidence({ paperId, limit = 200 } = {}) {
    if (paperId) {
      return this.db
        .prepare(
          `SELECT e.*, p.title AS paperTitle FROM evidence e
             LEFT JOIN papers p ON p.paperId = e.paperId
            WHERE e.paperId = ? ORDER BY e.pageIndex, e.charStart LIMIT ?`,
        )
        .all(paperId, limit);
    }
    return this.db
      .prepare(
        `SELECT e.*, p.title AS paperTitle FROM evidence e
           LEFT JOIN papers p ON p.paperId = e.paperId
          ORDER BY e.createdAt DESC LIMIT ?`,
      )
      .all(limit);
  }

  /** Evidence grouped by paper, for review outlining. */
  evidenceByPaper({ limit = 500 } = {}) {
    return this.listEvidence({ limit });
  }

  /** All papers referenced by evidence, in a stable order (for bibliographies). */
  papersForEvidence({ evidenceIds } = {}) {
    if (Array.isArray(evidenceIds) && evidenceIds.length > 0) {
      // SQLite caps bound parameters (32766 here, far fewer in practice), so a
      // large selection is chunked rather than sent as one giant IN list.
      const CHUNK = 500;
      const found = new Map();
      for (let offset = 0; offset < evidenceIds.length; offset += CHUNK) {
        const chunk = evidenceIds.slice(offset, offset + CHUNK);
        const placeholders = chunk.map(() => "?").join(",");
        const rows = this.db
          .prepare(
            `SELECT DISTINCT p.* FROM papers p
               JOIN evidence e ON e.paperId = p.paperId
              WHERE e.evidenceId IN (${placeholders})`,
          )
          .all(...chunk);
        for (const row of rows) found.set(row.paperId, row);
      }
      return [...found.values()].sort((a, b) => String(a.title).localeCompare(String(b.title)));
    }
    return this.db
      .prepare(
        `SELECT DISTINCT p.* FROM papers p
           JOIN evidence e ON e.paperId = p.paperId
          ORDER BY p.title`,
      )
      .all();
  }

  stats() {
    const one = (sql) => this.db.prepare(sql).get()?.c ?? 0;
    return {
      papers: one("SELECT COUNT(*) c FROM papers"),
      // "Full text" means the pages actually carry text, not merely that a file
      // was imported: a scanned PDF has pages but nothing to search, and
      // counting it here would overstate what the library can answer from.
      withFullText: one(
        `SELECT COUNT(DISTINCT p.paperId) c FROM papers p
           JOIN pages pg ON pg.paperId = p.paperId
          WHERE p.material = 'fulltext' AND TRIM(pg.text) <> ''`,
      ),
      pages: one("SELECT COUNT(*) c FROM pages"),
      pagesWithText: one("SELECT COUNT(*) c FROM pages WHERE TRIM(text) <> ''"),
      evidence: one("SELECT COUNT(*) c FROM evidence"),
      claims: one("SELECT COUNT(*) c FROM claims"),
    };
  }
}

/** Default database location for a workspace. */
export function defaultDbPath(workspaceRoot) {
  return join(workspaceRoot, ".dsh", "paper-tool", "library.sqlite");
}

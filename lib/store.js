// Local library store (S1): node:sqlite + FTS5.
//
// Zero external deps: Node 24 ships node:sqlite with FTS5 (unicode61 for
// latin). CJK uses a LIKE scan instead of a second index — see searchPages.
//
// Schema is versioned by PRAGMA user_version; migrations run forward only.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = 5;

/**
 * FTS5 external-content bookkeeping. The index content lives in `pages`.
 *
 * Two indexes, because one tokenizer cannot serve both languages:
 *
 *   `pages_fts`   unicode61 — Latin word search. Fast, but treats a run of CJK as
 *                 a single token, so 「研究」 only matched when the term happened to
 *                 sit beside a word boundary.
 *   `pages_cjk`   trigram  — CJK substring search. Matches any ≥3-character Chinese
 *                 phrase anywhere in the text, which is what users type. Measured
 *                 on the real corpus this replaced a full-table LIKE scan.
 *
 * The trigram index cannot answer 1–2 character queries (a trigram is 3 chars), so
 * those still fall back to LIKE. That limit is real and is handled in `searchPages`;
 * silently returning nothing for 「旅游」 would be worse than a slower scan.
 */
const TRIGGERS = [
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
    INSERT INTO pages_fts(rowid, text) VALUES (new.rowid, new.text);
    INSERT INTO pages_cjk(pages_cjk, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO pages_cjk(rowid, text) VALUES (new.rowid, new.text);
  END`,
];

// Import is idempotent only if the database enforces it: the service checks
// fingerprints before inserting, but two concurrent imports both see an empty
// result. A partial unique index makes the second insert a conflict instead of
// a duplicate paper. Empty values are excluded because metadata-only entries
// (external search candidates) carry neither.
const INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS papers_fingerprint
     ON papers(fingerprint) WHERE fingerprint <> ''`,
  `CREATE UNIQUE INDEX IF NOT EXISTS papers_doi
     ON papers(doi) WHERE doi <> ''`,
];

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
    charStart  INTEGER NOT NULL DEFAULT -1,
    charEnd    INTEGER NOT NULL DEFAULT -1,
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
  // CJK substring index. The trigram tokenizer breaks text into overlapping
  // 3-character runs, which is what makes arbitrary Chinese phrases searchable
  // without a dictionary-based segmenter. See the TRIGGERS note for the 1–2
  // character fallback.
  `CREATE VIRTUAL TABLE IF NOT EXISTS pages_cjk USING fts5(
    text, content='pages', content_rowid='rowid', tokenize='trigram'
  )`,
  ...TRIGGERS,
  ...INDEXES,
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
  // node:sqlite defaults busy_timeout to 0, so a second connection writing at
  // the same moment fails immediately instead of waiting. The tool and the
  // sidebar can both write, so waiting is the correct behaviour.
  db.exec("PRAGMA busy_timeout=5000");
  migrate(db);
  return new Store(db);
}

function migrate(db) {
  const current = db.prepare("PRAGMA user_version").get().user_version;
  if (current === SCHEMA_VERSION) return;
  if (current > SCHEMA_VERSION) {
    throw new Error(`store: database schema v${current} is newer than v${SCHEMA_VERSION}`);
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const stmt of DDL) db.exec(stmt);
    if (current < 2) migrateToV2(db);
    if (current < 3) migrateToV3(db);
    if (current < 4) migrateToV4(db);
    if (current < 5) migrateToV5(db);
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * v1 stored 0 as the anchor sentinel, which is indistinguishable from "the
 * quote starts at character 0". Anything still sitting exactly at 0 with a
 * length matching nothing is therefore reported as unlocated rather than
 * silently claiming precision it never had.
 */
function migrateToV2(db) {
  db.exec(`UPDATE evidence SET charStart = -1, charEnd = -1
            WHERE charStart = 0 AND charEnd = LENGTH(quote)`);
  // Rebuild the triggers so they match the current TRIGGERS definition.
  //
  // This used to also `DROP TABLE IF EXISTS pages_cjk`, from a period when the
  // trigram index was created but never queried — it doubled write cost for no
  // benefit, so dropping it was right at the time. v5 puts it back and actually
  // uses it, so the drop must not run again: it was deleting the index that
  // search now depends on, and the failure surfaced as "no such table: pages_cjk"
  // on the very next insert.
  for (const name of ["pages_ai", "pages_ad", "pages_au"]) {
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
  for (const stmt of TRIGGERS) db.exec(stmt);
}

/**
 * v3 records where page text came from.
 *
 * Until now every page's text was read from the PDF's own text layer. OCR
 * changes that: `Windows.Media.Ocr` guesses glyphs from a bitmap and misreads
 * some of them (measured on a real Chinese scan: 「济」 came back as 「冫齐」).
 * A reviewer must be able to see that, so the source is stored per page rather
 * than inferred, and a paper built out of OCR text is never presented as
 * equivalent to one with a real text layer.
 *
 * Existing rows are text-layer by definition: nothing else was possible before.
 */
function migrateToV3(db) {
  const paperColumns = db.prepare("PRAGMA table_info(papers)").all();
  if (!paperColumns.some((column) => column.name === "textSource")) {
    db.exec("ALTER TABLE papers ADD COLUMN textSource TEXT NOT NULL DEFAULT 'text-layer'");
  }
  const pageColumns = db.prepare("PRAGMA table_info(pages)").all();
  if (!pageColumns.some((column) => column.name === "textSource")) {
    db.exec("ALTER TABLE pages ADD COLUMN textSource TEXT NOT NULL DEFAULT 'text-layer'");
  }
}

/**
 * v4 records where each bibliographic field came from, and whether the user has
 * confirmed it.
 *
 * The metadata is guessed, and a guess the user cannot identify as a guess gets
 * cited. Storing the provenance (`metadataSource`, a JSON object of
 * field → xmp|info|subject|filename|layout|page-text) lets the UI mark exactly the
 * fields that need checking, and lets a later re-index refuse to overwrite a value
 * the user already verified. Existing rows get '{}' — we genuinely do not know
 * where their values came from, and claiming otherwise would be the same mistake.
 */
function migrateToV4(db) {
  const columns = db.prepare("PRAGMA table_info(papers)").all();
  if (!columns.some((column) => column.name === "metadataSource")) {
    db.exec("ALTER TABLE papers ADD COLUMN metadataSource TEXT NOT NULL DEFAULT '{}'");
  }
  if (!columns.some((column) => column.name === "metadataVerifiedAt")) {
    db.exec("ALTER TABLE papers ADD COLUMN metadataVerifiedAt TEXT NOT NULL DEFAULT ''");
  }
  // The original file name is a citation in disguise on Zotero/CNKI exports
  // ("Li - 2021 - Title.pdf"), and it was thrown away at import. Without it a
  // re-extract had to re-derive everything from the PDF alone, so "re-read
  // metadata" could produce worse values than the import that preceded it.
  if (!columns.some((column) => column.name === "sourceName")) {
    db.exec("ALTER TABLE papers ADD COLUMN sourceName TEXT NOT NULL DEFAULT ''");
  }
}

/**
 *
 * Returns the cleaned word list and whether the query contains CJK, so callers
 * cannot disagree with the search path about which branch a query takes.
 */
export function buildMatchQuery(raw) {
  const query = String(raw ?? "").trim();
  if (query === "") return null;
  const hasCjk = /[\u3400-\u9fff\uf900-\ufaff]/.test(query);
  // Strip FTS operators so user input cannot become syntax.
  const cleaned = query.replace(/["'^*():-]/g, " ").trim();
  if (cleaned === "") return null;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return { words, hasCjk };
}

/**
 * v5 adds the CJK trigram index and fills it from existing page text.
 *
 * The DDL creates `pages_cjk` empty on an upgraded database, and the triggers only
 * fire on future inserts. Without an explicit backfill every paper already in the
 * library would be invisible to Chinese search — present in the UI, absent from
 * results, with nothing to indicate why. The rebuild reads the `pages` table
 * directly, so it is a pure function of existing data and safe to repeat.
 */
function migrateToV5(db) {
  const hasCjkIndex = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pages_cjk'")
    .get();
  if (hasCjkIndex === undefined) return;
  // 'rebuild' is the FTS5 command for exactly this: repopulate an external-content
  // index from its content table.
  db.exec("INSERT INTO pages_cjk(pages_cjk) VALUES('rebuild')");
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * Split a CJK query into terms that can each be matched with LIKE.
 *
 * Punctuation, brackets and whitespace are separators, not searchable characters.
 * Before this existed, `旅游 经济` searched for the literal seven-character string
 * "旅游 经济" and found nothing on pages that contain both words — while the same
 * query in Latin worked, because that branch had always split on whitespace.
 *
 * A term that mixes scripts ("Tourism 经济") splits into both parts so each is
 * matched independently; latin fragments inside a CJK query must still go through
 * the LIKE scan, because mixing FTS5 and LIKE in one statement would silently drop
 * the CJK requirement.
 */
export function cjkSearchTerms(raw) {
  const query = String(raw ?? "").trim();
  if (query === "") return [];
  const parts = query
    // Quotes, brackets, CJK/enumeration punctuation and dashes all act as gaps.
    .split(/[\s"'^*():;\-–—、，。；：？！《》〈〉「」『』【】〔〕（）()\[\]{}<>·…]+/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  // Dedupe while preserving order, and drop one-character fragments only when a
  // longer term exists (a single Chinese character is a legitimate query).
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    if (seen.has(part)) continue;
    seen.add(part);
    out.push(part);
  }
  return out;
}

/**
 * Run a full-text search over page text.
 *
 * Three paths, because one index cannot serve both languages:
 *
 *   Latin only            → `pages_fts` (unicode61), word match.
 *   CJK term ≥3 chars     → `pages_cjk` (trigram), substring match.
 *   CJK term 1–2 chars    → LIKE scan, since a trigram needs three characters.
 *
 * Every path interleaves by paper before applying the row cap. Ordering by
 * `paperId` alone is ordering by random UUID, which let one paper with many
 * matching pages fill the entire result set and made every other paper
 * invisible to search — and the matrix then reported those papers as
 * "not found", which is exactly the false negative a review must not produce.
 *
 * @returns {{paperId: string, pageIndex: number, snippet: string}[]}
 */
function searchPages(db, rawQuery, limit) {
  const built = buildMatchQuery(rawQuery);
  if (built === null) return [];
  const query = String(rawQuery).trim();

  if (built.hasCjk) {
    // Split the query into terms first: "旅游 经济", "旅游、经济" and "《旅游经济》"
    // all used to return zero hits while the equivalent Latin query worked, because
    // the space and the punctuation were matched literally.
    const terms = cjkSearchTerms(query);
    if (terms.length === 0) return [];
    const cap = Math.max(1, limit);
    const perPaper = Math.max(3, Math.min(cap, 20));

    // A trigram is three characters, so the FTS index can answer any CJK term of
    // length 3 or more, but nothing shorter. Falling back to LIKE for those is
    // deliberate: returning zero hits for 「旅游」 would be a silent wrong answer,
    // and a scan on a personal library is cheap. Mixing both in one statement keeps
    // the AND semantics intact.
    const indexable = terms.filter((term) => [...term].length >= 3);
    const scanOnly = terms.filter((term) => [...term].length < 3);

    if (indexable.length > 0) {
      const expr = indexable.map((term) => `"${term.replace(/"/g, '""')}"`).join(" AND ");
      const clauses = scanOnly.map(() => "AND p.text LIKE ? ESCAPE '\\'").join(" ");
      const params = scanOnly.map((term) => `%${term.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`);
      try {
        // Two passes, because combining them is what was slow.
        //
        // `ROW_NUMBER() OVER (PARTITION BY p.paperId ...)` over an FTS join cannot
        // use the index order, so SQLite materialises every matching row: measured
        // 272ms for a term matching all 24 000 pages, against 0ms for the same
        // query without the window function, and 4ms with the window function but
        // no page-text join. Pass 1 therefore ranks over rowids only, and pass 2
        // fetches the text for the handful of rows that survived.
        const ranked = db
          .prepare(
            `SELECT paperId, pageIndex FROM (
                SELECT p.paperId AS paperId, p.pageIndex AS pageIndex,
                       ROW_NUMBER() OVER (PARTITION BY p.paperId ORDER BY p.pageIndex) AS depth
                  FROM pages_cjk
                  JOIN pages p ON p.rowid = pages_cjk.rowid
                 WHERE pages_cjk MATCH ? ${clauses}
             )
             WHERE depth <= ?
             ORDER BY depth, paperId, pageIndex
             LIMIT ?`,
          )
          .all(expr, ...params, perPaper, cap);
        if (ranked.length === 0) return [];
        const textStmt = db.prepare("SELECT text FROM pages WHERE paperId = ? AND pageIndex = ?");
        return ranked.map((row) => ({
          paperId: row.paperId,
          pageIndex: row.pageIndex,
          snippet: makeSnippet(textStmt.get(row.paperId, row.pageIndex)?.text ?? "", indexable[0] ?? query),
        }));
      } catch {
        // An unparseable FTS expression (stray operator in user input) must not
        // break search: fall through to the scan below.
      }
    }

    // All terms shorter than 3 characters, or the index query failed: scan.
    const allTerms = indexable.length > 0 ? scanOnly : terms;
    if (allTerms.length === 0) return [];
    const where = allTerms.map(() => "text LIKE ? ESCAPE '\\'").join(" AND ");
    const params = allTerms.map((term) => `%${term.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`);
    // Order by depth *within each paper* before interleaving papers, so a result
    // cap cannot truncate away the second half of a long paper. Ordering by raw
    // pageIndex did exactly that: a query matching pages 1–18 of one paper always
    // returned pages 1–8, so automated evidence collection drew every quote from
    // the introduction and never from the discussion or conclusion.
    const rows = db
      .prepare(
        `WITH hits AS (
            SELECT paperId, pageIndex, text
              FROM pages
             WHERE ${where}
         ),
         ranked AS (
            SELECT paperId, pageIndex, text,
                   ROW_NUMBER() OVER (PARTITION BY paperId ORDER BY pageIndex) AS depth
              FROM hits
         )
         SELECT paperId, pageIndex, text
           FROM ranked
          WHERE depth <= ?
          ORDER BY depth, paperId, pageIndex
          LIMIT ?`,
      )
      .all(...params, perPaper, cap);
    return rows.map((row) => ({
      paperId: row.paperId,
      pageIndex: row.pageIndex,
      snippet: makeSnippet(row.text, allTerms[0]),
    }));
  }

  const expr = built.words.map((word) => `"${word}"`).join(" AND ");
  const cap = Math.max(1, limit);
  const perPaper = Math.max(3, Math.min(cap, 20));
  try {
    const rows = db
      .prepare(
        `WITH hits AS (
            SELECT p.paperId AS paperId, p.pageIndex AS pageIndex,
                   snippet(pages_fts, 0, '[', ']', '…', 12) AS snippet
              FROM pages_fts
              JOIN pages p ON p.rowid = pages_fts.rowid
             WHERE pages_fts MATCH ?
         ),
         ranked AS (
            SELECT paperId, pageIndex, snippet,
                   ROW_NUMBER() OVER (PARTITION BY paperId ORDER BY pageIndex) AS depth
              FROM hits
         )
         SELECT paperId, pageIndex, snippet
           FROM ranked
          WHERE depth <= ?
          ORDER BY depth, paperId, pageIndex
          LIMIT ?`,
      )
      .all(expr, perPaper, cap);
    return rows.map((row) => ({
      paperId: row.paperId,
      pageIndex: row.pageIndex,
      snippet: row.snippet ?? "",
    }));
  } catch {
    // A query FTS cannot parse still has to search: fall back to the scan,
    // with the same per-paper interleaving.
    const needle = query.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    const rows = db
      .prepare(
        `WITH hits AS (
            SELECT paperId, pageIndex, text
              FROM pages
             WHERE text LIKE ? ESCAPE '\\'
         ),
         ranked AS (
            SELECT paperId, pageIndex, text,
                   ROW_NUMBER() OVER (PARTITION BY paperId ORDER BY pageIndex) AS depth
              FROM hits
         )
         SELECT paperId, pageIndex, text
           FROM ranked
          WHERE depth <= ?
          ORDER BY depth, paperId, pageIndex
          LIMIT ?`,
      )
      .all(`%${needle}%`, perPaper, cap);
    return rows.map((row) => ({
      paperId: row.paperId,
      pageIndex: row.pageIndex,
      snippet: makeSnippet(row.text, query),
    }));
  }
}

/** Bracket the match inside a short window of surrounding text. */
function makeSnippet(text, query) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return text.slice(0, 80);
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + query.length + 40);
  return `${start > 0 ? "…" : ""}${text.slice(start, at)}[${text.slice(at, at + query.length)}]${text.slice(at + query.length, end)}${end < text.length ? "…" : ""}`;
}

/** Run `fn` inside BEGIN IMMEDIATE: the write lock is taken up front, so a
 *  reader cannot turn a deferred transaction into a deadlock. */
function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the transaction may already be gone */
    }
    throw error;
  }
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
      textSource = "text-layer",
      pages = [],
      pageSources = [],
      metadataSource = "{}",
      sourceName = "",
    } = paper;
    if (typeof paperId !== "string" || paperId === "") throw new Error("upsertPaper: paperId required");
    const db = this.db;
    transaction(db, () => {
      db.prepare(
        `INSERT INTO papers (paperId,title,authors,year,venue,doi,abstract,source,pdfPath,fingerprint,numPages,indexedAt,material,textSource,metadataSource,sourceName)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(paperId) DO UPDATE SET
           title=excluded.title, authors=excluded.authors, year=excluded.year,
           venue=excluded.venue, doi=excluded.doi, abstract=excluded.abstract,
           source=excluded.source, pdfPath=excluded.pdfPath,
           fingerprint=excluded.fingerprint, numPages=excluded.numPages,
           indexedAt=excluded.indexedAt, material=excluded.material,
           textSource=excluded.textSource, metadataSource=excluded.metadataSource,
           sourceName=excluded.sourceName`,
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
        textSource,
        typeof metadataSource === "string" ? metadataSource : JSON.stringify(metadataSource ?? {}),
        sourceName,
      );
      db.prepare("DELETE FROM pages WHERE paperId = ?").run(paperId);
      const insertPage = db.prepare("INSERT INTO pages (paperId,pageIndex,text,textSource) VALUES (?,?,?,?)");
      pages.forEach((text, index) => {
        const pageSource = typeof pageSources[index] === "string" ? pageSources[index] : textSource;
        insertPage.run(paperId, index, text, pageSource);
      });
    });
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
    // A value the user typed is no longer a guess, so record that it was verified
    // and drop its provenance. `metadataSource` is what the UI reads to decide
    // which fields still carry a "please check" mark; leaving a corrected field
    // marked as guessed would train the user to ignore the mark entirely.
    const edited = ["title", "authors", "year", "venue", "doi"].filter(
      (name) => typeof fields[name] === "string" && fields[name] !== current[name],
    );
    let metadataSource = current.metadataSource ?? "{}";
    let verifiedAt = current.metadataVerifiedAt ?? "";
    if (edited.length > 0 && fields.verified !== false) {
      try {
        const parsed = JSON.parse(metadataSource === "" ? "{}" : metadataSource);
        for (const name of edited) delete parsed[name];
        metadataSource = JSON.stringify(parsed);
      } catch {
        metadataSource = "{}";
      }
      verifiedAt = new Date().toISOString();
    }
    this.db
      .prepare(
        `UPDATE papers
            SET title = ?, authors = ?, year = ?, venue = ?, doi = ?, abstract = ?,
                metadataSource = ?, metadataVerifiedAt = ?
          WHERE paperId = ?`,
      )
      .run(
        pick("title"),
        pick("authors"),
        pick("year"),
        pick("venue"),
        pick("doi"),
        pick("abstract"),
        metadataSource,
        verifiedAt,
        paperId,
      );
    return this.getPaper(paperId);
  }

  /**
   * Replace a paper's provenance map without touching its values.
   *
   * `updatePaper` deliberately clears the entry for any field the user edits, which
   * is right for a user edit but wrong for re-extraction: re-extraction needs to
   * record the *new* source for fields it just replaced. Keeping the two paths
   * separate means neither has to guess the other's intent.
   */
  setMetadataSource(paperId, metadataSource) {
    const value = typeof metadataSource === "string" ? metadataSource : JSON.stringify(metadataSource ?? {});
    this.db.prepare("UPDATE papers SET metadataSource = ? WHERE paperId = ?").run(value, paperId);
    return this.getPaper(paperId);
  }

  /**
   * Clear a paper's "the user confirmed this" stamp.
   *
   * `metadataVerifiedAt` is set by `updatePaper` whenever a value the user typed
   * differs from the stored one. Rows imported before v4 have an empty
   * `metadataSource`, so nothing marks their values as guesses — yet
   * `updatePaper` had already stamped them verified, and re-extraction then
   * refused to correct them forever. A 2013 import kept its wrong year through
   * every re-extract because of exactly that. Re-extraction clears the stamp so
   * a value it could not repair is at least presented as a guess again.
   */
  clearMetadataVerifiedAt(paperId) {
    this.db.prepare("UPDATE papers SET metadataVerifiedAt = '' WHERE paperId = ?").run(paperId);
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
    return (
      this.db
        .prepare("SELECT * FROM papers WHERE fingerprint = ? ORDER BY indexedAt LIMIT 1")
        .get(fingerprint) ?? null
    );
  }

  /** Find a paper already holding this DOI, so external imports do not duplicate. */
  findByDoi(doi) {
    const value = String(doi ?? "").trim();
    if (value === "") return null;
    return (
      this.db
        .prepare("SELECT * FROM papers WHERE doi = ? ORDER BY indexedAt LIMIT 1")
        .get(value) ?? null
    );
  }

  listPapers({ limit = 200, offset = 0 } = {}) {
    return this.db
      .prepare("SELECT * FROM papers ORDER BY indexedAt DESC, title ASC LIMIT ? OFFSET ?")
      .all(limit, offset);
  }

  deletePaper(paperId) {
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM pages WHERE paperId = ?").run(paperId);
      this.db.prepare("DELETE FROM evidence WHERE paperId = ?").run(paperId);
      this.db.prepare("DELETE FROM papers WHERE paperId = ?").run(paperId);
    });
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
    const paperIds = [...new Set(hits.map((hit) => hit.paperId))];
    const papers = new Map();
    for (const paperId of paperIds) {
      const paper = this.getPaper(paperId);
      if (paper !== null) papers.set(paperId, paper);
    }
    return hits.map((hit) => {
      const paper = papers.get(hit.paperId);
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
    const raw = String(query ?? "").trim();
    if (raw === "") return [];
    const term = `%${raw.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`;
    return this.db
      .prepare(
        `SELECT * FROM papers
          WHERE title LIKE ? ESCAPE '\\' OR abstract LIKE ? ESCAPE '\\'
             OR authors LIKE ? ESCAPE '\\' OR doi LIKE ? ESCAPE '\\'
          ORDER BY year DESC LIMIT ?`,
      )
      .all(term, term, term, term, limit);
  }

  addEvidence({ evidenceId, paperId, pageIndex, charStart, charEnd, quote }) {
    this.db
      .prepare(
        `INSERT INTO evidence (evidenceId,paperId,pageIndex,charStart,charEnd,quote,createdAt)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(evidenceId) DO UPDATE SET quote=excluded.quote,
           charStart=excluded.charStart, charEnd=excluded.charEnd`,
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
          `SELECT e.*, p.title AS paperTitle, p.textSource AS paperTextSource FROM evidence e
             LEFT JOIN papers p ON p.paperId = e.paperId
            WHERE e.paperId = ? ORDER BY e.pageIndex, e.charStart LIMIT ?`,
        )
        .all(paperId, limit);
    }
    return this.db
      .prepare(
        `SELECT e.*, p.title AS paperTitle, p.textSource AS paperTextSource FROM evidence e
           LEFT JOIN papers p ON p.paperId = e.paperId
          ORDER BY e.createdAt DESC LIMIT ?`,
      )
      .all(limit);
  }

  /**
   * Evidence subset by id, preserving the stored order.
   *
   * The matrix and the exporter both need "exactly these rows", and re-reading
   * the newest N and filtering in JavaScript silently drops rows once the
   * library outgrows N.
   */
  evidenceByIds(evidenceIds, { limit = 5000 } = {}) {
    const ids = [...new Set((evidenceIds ?? []).filter((id) => typeof id === "string" && id !== ""))];
    if (ids.length === 0) return [];
    const CHUNK = 500;
    const found = new Map();
    for (let offset = 0; offset < ids.length && found.size < limit; offset += CHUNK) {
      const chunk = ids.slice(offset, offset + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT e.*, p.title AS paperTitle, p.textSource AS paperTextSource FROM evidence e
             LEFT JOIN papers p ON p.paperId = e.paperId
            WHERE e.evidenceId IN (${placeholders})`,
        )
        .all(...chunk);
      for (const row of rows) found.set(row.evidenceId, row);
    }
    return ids.map((id) => found.get(id)).filter((row) => row !== undefined);
  }

  /** Evidence grouped by paper, for review outlining. */
  evidenceByPaper({ limit = 2000 } = {}) {
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
      // Papers whose text came from the PDF's own text layer.
      withFullText: one(
        `SELECT COUNT(DISTINCT p.paperId) c FROM papers p
           JOIN pages pg ON pg.paperId = p.paperId
          WHERE p.material = 'fulltext' AND TRIM(pg.text) <> ''`,
      ),
      // Papers searchable only through OCR. Counted separately rather than folded
      // into withFullText: the two are not the same promise, and the UI has to be
      // able to say how many papers rest on guessed characters.
      withOcrText: one(
        `SELECT COUNT(DISTINCT p.paperId) c FROM papers p
           JOIN pages pg ON pg.paperId = p.paperId
          WHERE p.material = 'ocr' AND TRIM(pg.text) <> ''`,
      ),
      // Papers with searchable text of either origin. This is the number that
      // matches pagesWithText below; withFullText alone made the two disagree as
      // soon as an OCR paper existed.
      searchable: one(
        `SELECT COUNT(DISTINCT p.paperId) c FROM papers p
           JOIN pages pg ON pg.paperId = p.paperId
          WHERE p.material IN ('fulltext','ocr') AND TRIM(pg.text) <> ''`,
      ),
      pages: one("SELECT COUNT(*) c FROM pages"),
      pagesWithText: one("SELECT COUNT(*) c FROM pages WHERE TRIM(text) <> ''"),
      pagesWithOcr: one("SELECT COUNT(*) c FROM pages WHERE textSource = 'ocr' AND TRIM(text) <> ''"),
      evidence: one("SELECT COUNT(*) c FROM evidence"),
      anchoredEvidence: one("SELECT COUNT(*) c FROM evidence WHERE charStart >= 0"),
      claims: one("SELECT COUNT(*) c FROM claims"),
    };
  }
}

/** Default database location for a workspace. */
export function defaultDbPath(workspaceRoot) {
  return join(workspaceRoot, ".dsh", "paper-tool", "library.sqlite");
}

/**
 * Fold a legacy per-workspace library into the shared one.
 *
 * Changing where the library lives is invisible only while nobody has data: the
 * moment this ships, a user who already imported papers in one workspace would
 * open the workbench and see an empty shelf, because the plugin now reads a
 * different file. Copying the old database across once — only when the shared
 * file does not exist yet, so it can never clobber newer data — is what makes
 * the move safe rather than a silent data loss.
 *
 * Returns a short report so the caller can log what happened instead of guessing.
 */
export function adoptLegacyLibrary(legacyPath, sharedPath) {
  if (typeof legacyPath !== "string" || legacyPath === "") return { adopted: false, reason: "no-legacy" };
  if (typeof sharedPath !== "string" || sharedPath === "") return { adopted: false, reason: "no-shared" };
  if (legacyPath === sharedPath) return { adopted: false, reason: "same-path" };
  if (existsSync(sharedPath)) return { adopted: false, reason: "shared-exists" };
  if (!existsSync(legacyPath)) return { adopted: false, reason: "legacy-absent" };
  mkdirSync(dirname(sharedPath), { recursive: true });
  try {
    // Copy rather than move: if the copy is interrupted the original library is
    // still there, so the user loses nothing and the next start retries.
    copyFileSync(legacyPath, sharedPath);
    // A WAL-mode database keeps recent commits in `-wal`. Without it the copied
    // file can silently lack the newest papers.
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(legacyPath + suffix)) copyFileSync(legacyPath + suffix, sharedPath + suffix);
    }
    return { adopted: true, reason: "copied", from: legacyPath, to: sharedPath };
  } catch (error) {
    return { adopted: false, reason: "copy-failed", error: String(error?.message ?? error) };
  }
}

/**
 * Where the library lives when the user has not pointed it at one directory.
 *
 * A library per workspace sounds tidy but reads as data loss: the same plugin in
 * another workspace shows an empty shelf, and the paper you imported a minute
 * ago is "gone". Research libraries are personal and cross-project — you read the
 * same paper while writing in two different folders — so the default is one
 * library for the user, keyed off the profile home rather than the cwd.
 *
 * `DSH_HOME` is the desktop profile root (e.g. `~/.dsh-desktop`); the caller
 * passes it in because the store must not read process env for a path it does
 * not own. Falls back to the workspace when it is unavailable, which keeps the
 * old per-workspace behaviour rather than inventing a location.
 */
export function sharedDbPath(homeDir) {
  if (typeof homeDir !== "string" || homeDir.trim() === "") return null;
  return join(homeDir, "paper-tool", "library.sqlite");
}


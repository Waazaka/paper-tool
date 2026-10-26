// Search gate: the query the user types must be the query the library answers.
//
// The defect this guards was not "search is slow" — it was that the same search box
// behaved differently in two languages. The Latin branch split the query on
// whitespace and required every word (AND); the CJK branch passed the whole string
// to a single LIKE pattern, so the space itself became a character to match. Every
// one of these returned zero hits on a library that contains all the words:
//
//    旅游 经济      旅游、经济      旅游，经济      《旅游经济》
//    旅游-经济      旅游　经济      Tourism 经济    高质量发展 水平
//
// The Latin equivalent worked, so the failure looked like "Chinese search is bad"
// rather than "the query was never split". Worse, `paper_evidence collect` goes
// through the same `store.search`, so a model collecting evidence with the user's
// own phrasing silently received nothing.
//
// Run: node test/s11-search.mjs
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cjkSearchTerms, openStore } from "../lib/store.js";
import { report } from "./report.mjs";

const SCRATCH = join(import.meta.dirname, ".scratch");
mkdirSync(SCRATCH, { recursive: true });

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n")[0]}`);
  }
}

console.log("Search gate");

// A tiny library with the words a real query would target.
const PAGE = "本文以山东省为例，研究旅游经济贡献率与旅游化水平的协调关系。高质量发展水平测度是核心议题。";
const ENGLISH = "This paper studies tourism economy coordination and service quality.";

const store = openStore(join(SCRATCH, `search-${Date.now()}.sqlite`));
store.upsertPaper({
  paperId: "cn",
  title: "中文论文",
  material: "fulltext",
  textSource: "text-layer",
  pages: [PAGE],
});
store.upsertPaper({
  paperId: "en",
  title: "English paper",
  material: "fulltext",
  textSource: "text-layer",
  pages: [ENGLISH],
});

function hitsFor(query) {
  return store.search(query, { limit: 50 });
}

// --- the separators that used to break it --------------------------------
await check("a CJK query with a space matches both words", () => {
  // The space is a separator between terms, not a character in the text.
  for (const query of ["旅游 经济", "旅游　经济", "旅游，经济", "旅游、经济", "旅游-经济", "旅游;经济"]) {
    assert.ok(hitsFor(query).length > 0, `no hits for ${JSON.stringify(query)}`);
  }
});

await check("brackets and quotes around a term are ignored", () => {
  for (const query of ["《旅游经济》", '"旅游经济"', "「旅游经济」", "（旅游经济）", "【旅游经济】"]) {
    assert.ok(hitsFor(query).length > 0, `no hits for ${JSON.stringify(query)}`);
  }
});

await check("every term must match, not just one of them", () => {
  // AND semantics: "旅游" alone matches, but "旅游 不存在的词" must not.
  assert.ok(hitsFor("旅游").length > 0, "the single term did not match");
  assert.equal(
    hitsFor("旅游 这段文字并不在页面上").length,
    0,
    "a query with an unmatched term still returned hits — terms are being OR'd",
  );
});

await check("a multi-word phrase still matches as a phrase", () => {
  // "高质量发展水平" is contiguous in the page; splitting must not turn the query
  // into "any of these characters".
  assert.ok(hitsFor("高质量发展水平").length > 0, "contiguous phrase did not match");
});

await check("English search is unaffected", () => {
  // The Latin branch goes through FTS5; the CJK fix must not have touched it.
  assert.ok(hitsFor("tourism").length > 0, "English term did not match");
  assert.ok(hitsFor("tourism economy").length > 0, "English phrase did not match");
  assert.equal(hitsFor("zzzznotpresent").length, 0, "a missing English term matched");
});

await check("a CJK query does not match pages without the terms", () => {
  const hits = hitsFor("旅游经济");
  assert.ok(hits.length > 0, "no hits at all");
  assert.ok(
    hits.every((hit) => hit.paperId === "cn"),
    "a Chinese query matched the English paper",
  );
});

await check("an empty or punctuation-only query returns nothing instead of throwing", () => {
  for (const query of ["", "   ", "、，。", "《》", "..."]) {
    const hits = hitsFor(query);
    assert.ok(Array.isArray(hits), `query ${JSON.stringify(query)} did not return an array`);
    assert.equal(hits.length, 0, `query ${JSON.stringify(query)} returned hits`);
  }
});

await check("LIKE wildcards in user input are escaped, not interpreted", () => {
  // `%` and `_` are LIKE syntax. If they passed through, "%" would match every
  // page — a search for a literal percent sign would return the whole library.
  assert.equal(hitsFor("%").length, 0, "a literal % matched pages");
  assert.equal(hitsFor("旅游%经济").length, 0, "a % wildcard was interpreted");
});

// --- the splitter itself -------------------------------------------------
await check("cjkSearchTerms separates on every punctuation class", () => {
  const cases = [
    ["旅游 经济", ["旅游", "经济"]],
    ["旅游、经济", ["旅游", "经济"]],
    ["Tourism 经济", ["Tourism", "经济"]],
    ["高质量发展 水平", ["高质量发展", "水平"]],
  ];
  for (const [input, expected] of cases) {
    assert.deepEqual(cjkSearchTerms(input), expected, `split of ${JSON.stringify(input)}`);
  }
});

await check("cjkSearchTerms keeps a contiguous term whole", () => {
  assert.deepEqual(cjkSearchTerms("旅游经济"), ["旅游经济"]);
  assert.deepEqual(cjkSearchTerms("高质量发展水平"), ["高质量发展水平"]);
});

await check("cjkSearchTerms does not emit empty terms", () => {
  for (const input of ["  旅游  ", "旅游、", "、旅游", "（）旅游（）", ""]) {
    const terms = cjkSearchTerms(input);
    assert.ok(terms.every((term) => term !== ""), `empty term from ${JSON.stringify(input)}`);
  }
});

await check("a result cap does not always truncate a long paper's late pages", () => {
  // Ordering by raw pageIndex meant a query matching pages 1..18 of one paper
  // returned pages 1..8 every time, so automated evidence collection drew every
  // quote from the introduction. When several papers match, the first `limit`
  // results must not all be the opening pages of the same paper.
  const deep = openStore(join(SCRATCH, `deep-${Date.now()}.sqlite`));
  const longPages = Array.from({ length: 18 }, (_, index) => `第 ${index + 1} 页 经济 内容`);
  deep.upsertPaper({ paperId: "long", title: "长文", material: "fulltext", textSource: "text-layer", pages: longPages });
  deep.upsertPaper({ paperId: "short", title: "短文", material: "fulltext", textSource: "text-layer", pages: ["经济"] });
  const hits = deep.search("经济", { limit: 6 });
  assert.ok(hits.length > 0, "no hits");
  const papers = new Set(hits.map((hit) => hit.paperId));
  assert.ok(papers.size > 1, `all ${hits.length} hits came from a single paper`);
  deep.close();
});

await check("the CJK index exists and is kept in sync by the triggers", () => {
  // The trigram index is only useful if the triggers maintain it. This failed
  // silently once: a leftover `DROP TABLE IF EXISTS pages_cjk` in the v2 migration
  // deleted the table the v5 DDL had just created, so the next insert died with
  // "no such table" and every Chinese search would have returned nothing. Assert
  // the wiring, not just the query.
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pages_cjk'")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ["pages_cjk"], "the trigram index table does not exist");
  assert.ok(store.db.prepare("SELECT COUNT(*) c FROM pages_cjk").get().c > 0, "the trigram index is empty");

  const probe = openStore(join(SCRATCH, `trg-${Date.now()}.sqlite`));
  probe.upsertPaper({
    paperId: "t1", title: "触发测试", material: "fulltext", textSource: "text-layer",
    pages: ["服务场景影响顾客公民行为"],
  });
  assert.ok(probe.search("服务场景", { limit: 5 }).length > 0, "a new page never reached the trigram index");
  // A deleted page must leave the index, or it keeps appearing in results.
  probe.db.prepare("DELETE FROM pages WHERE paperId = ?").run("t1");
  assert.equal(probe.search("服务场景", { limit: 5 }).length, 0, "a deleted page is still in the trigram index");
  probe.close();
});

await check("a 1-2 character query still matches through the fallback", () => {
  // A trigram is three characters, so the index cannot answer 「旅游」 or 「经济」.
  // Returning nothing would be a silent wrong answer, so those scan instead.
  for (const query of ["旅游", "经济", "经"]) {
    assert.ok(hitsFor(query).length > 0, `${JSON.stringify(query)} returned nothing`);
  }
});

await check("an upgraded library becomes Chinese-searchable without re-importing", () => {
  // The migration path is the one that matters: papers imported before the index
  // existed must become searchable. Without the backfill they stay in the library
  // but invisible to Chinese search, with nothing to indicate why.
  const legacyPath = join(SCRATCH, `legacy-${Date.now()}.sqlite`);
  const raw = new DatabaseSync(legacyPath);
  raw.exec(`CREATE TABLE papers (paperId TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', authors TEXT NOT NULL DEFAULT '',
    year TEXT NOT NULL DEFAULT '', venue TEXT NOT NULL DEFAULT '', doi TEXT NOT NULL DEFAULT '', abstract TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '', pdfPath TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '',
    numPages INTEGER NOT NULL DEFAULT 0, indexedAt TEXT NOT NULL DEFAULT '', material TEXT NOT NULL DEFAULT 'metadata',
    textSource TEXT NOT NULL DEFAULT 'text-layer', metadataSource TEXT NOT NULL DEFAULT '{}',
    metadataVerifiedAt TEXT NOT NULL DEFAULT '')`);
  raw.exec(`CREATE TABLE pages (paperId TEXT NOT NULL, pageIndex INTEGER NOT NULL, text TEXT NOT NULL,
    textSource TEXT NOT NULL DEFAULT 'text-layer', PRIMARY KEY (paperId, pageIndex))`);
  raw.exec(`CREATE VIRTUAL TABLE pages_fts USING fts5(text, content='pages', content_rowid='rowid', tokenize='unicode61')`);
  raw.exec(`INSERT INTO papers (paperId,title,material,numPages) VALUES ('legacy','旧论文','fulltext',1)`);
  raw.exec(`INSERT INTO pages (paperId,pageIndex,text) VALUES ('legacy',0,'高质量发展水平的测度研究是核心议题。')`);
  raw.exec("PRAGMA user_version=4");
  raw.close();

  const upgraded = openStore(legacyPath);
  assert.ok(upgraded.search("高质量发展", { limit: 5 }).length > 0, "old pages were not backfilled into the CJK index");
  assert.ok(upgraded.search("测度研究", { limit: 5 }).length > 0, "old pages are missing from the CJK index");
  upgraded.close();
});

store.close();

console.log(failures === 0 ? "\nSEARCH PASS" : `\n${failures} FAILURE(S)`);
process.exit(report({ failures }));

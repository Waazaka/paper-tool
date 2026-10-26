// Metadata gate: the fields that end up in someone's bibliography.
//
// The user's complaint was concrete — "期刊名和论文名、年份这些识别不准确" — and it
// measured worse than that: over 32 real papers the old extractor produced authors
// 0/32, venue 0/32, and a wrong title on 10/32. `venue` was not merely inaccurate,
// it was structurally dead: `importPdf` wrote `venue: file.venue ?? ""` and the
// import path never supplies `file.venue`, so the field could never be non-empty.
//
// Two properties matter more than the counts:
//
//   * A wrong value is worse than an empty one. An empty journal invites a fix; a
//     wrong one gets pasted into a reference list and cited. Every reusable helper
//     below is therefore checked on its rejections, not just its hits.
//   * A guess must be identifiable as a guess. Each field carries `confidence` and
//     `source` so the UI can ask the user to confirm, instead of presenting a
//     guess with the same authority as an XMP fact.
//
// Run: node test/s9-metadata.mjs [corpusDir]
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  guessMetadata,
  parseFilename,
  parseSubject,
  layoutLines,
} from "../lib/pdf-metadata.js";
import { extractPdfPages } from "../lib/pdf-extract.js";
import { openStore } from "../lib/store.js";
import { report } from "./report.mjs";

const SCRATCH = join(import.meta.dirname, ".scratch");
mkdirSync(SCRATCH, { recursive: true });

const corpus = process.argv[2] ?? join(process.env.USERPROFILE ?? "", "Zotero", "storage");

let failures = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   ${name}`))
    .catch((error) => {
      failures += 1;
      console.log(`FAIL ${name}\n     ${String(error?.message ?? error).split("\n")[0]}`);
    });
}

console.log("Metadata gate");

// --- rejected values -----------------------------------------------------
// These are not hypothetical: each string was actually produced as a title by the
// old "first line wins" rule on a paper in the corpus.
const BAD_TITLES = [
  "Full Terms & Conditions of access and use can be found at",
  "See discussions, stats, and author profiles for this publication at",
  "Empirical Research Article",
  "JTR1187334 1..18",
  "EM-IJCH200211 587..603",
  "Downloaded from http://example.org",
  "2020 年第 11 期",
  "Vol. 36 No. 3",
  "Abstract",
  "School of Management, Xiamen University",
];

await check("page furniture is never accepted as a title", () => {
  // Feed each junk string as the ONLY candidate: no XMP, no layout, no filename.
  for (const junk of BAD_TITLES) {
    const guess = guessMetadata([junk], {});
    assert.notEqual(
      guess.title,
      junk,
      `junk was accepted as a title: ${JSON.stringify(junk)}`,
    );
  }
});

await check("a bare page number is not a year", () => {
  // The old rule took the first four-digit run on page 1, which is often a page
  // range, a volume, or a grant number.
  const guess = guessMetadata(["Page 1234 of the proceedings"], {});
  assert.equal(guess.year, "", `invented the year ${guess.year}`);
});

// --- the individual parsers ----------------------------------------------
await check("Zotero file names yield author, year and title", () => {
  const parsed = parseFilename("Li 等 - 2021 - Antecedents and consequences of hotel customers' psychological ownership.pdf");
  assert.equal(parsed.year, "2021");
  assert.equal(parsed.title, "Antecedents and consequences of hotel customers' psychological ownership");
  assert.equal(parsed.authors[0], "Li");
});

await check("CNKI file names yield title and author", () => {
  // The title itself can contain an underscore ("…的影响_一个链式中介模型"), so only
  // the LAST underscore separates the author. Splitting on the first would lose
  // half the title, which is a silent corruption rather than a parse failure.
  const parsed = parseFilename("3、酒店服务场景对顾客公民行为的影响_一个链式中介模型_李书昊.pdf");
  assert.ok(parsed.title.startsWith("酒店服务场景对顾客公民行为的影响"), `title: ${parsed.title}`);
  assert.ok(parsed.title.includes("一个链式中介模型"), `subtitle lost: ${parsed.title}`);
  assert.equal(parsed.authors[0], "李书昊");
  // The leading "3、" is a download serial, not part of the title.
  assert.ok(!/^\d/.test(parsed.title), `serial number kept in title: ${parsed.title}`);
});

await check("a publisher Subject line is parsed into venue, year and doi", () => {
  const parsed = parseSubject(
    "International Journal of Hospitality Management, 93 (2021) 102773. doi:10.1016/j.ijhm.2020.102773",
  );
  assert.equal(parsed.venue, "International Journal of Hospitality Management");
  assert.equal(parsed.year, "2021");
  assert.equal(parsed.doi, "10.1016/j.ijhm.2020.102773");
});

await check("the literal producer name CNKI is not accepted as an author", () => {
  // 13 of 32 papers in the corpus have Info.Author === "CNKI" verbatim.
  const guess = guessMetadata(["x"], { info: { Author: "CNKI" }, filename: "a.pdf" });
  assert.notEqual(guess.authors, "CNKI", "producer name leaked into authors");
});

await check("an affiliation is not accepted as a journal", () => {
  for (const bad of [
    "Yan Peng, School of Management, Xiamen University",
    "School of Management, Xiamen",
    "Research limitations/implications",
    "然而，现有文献的关注点仍聚焦于经济增长数量",
    "Previous researchers have done",
  ]) {
    const guess = guessMetadata(["x"], {
      info: { Subject: bad },
      layout: [{ y: 750, height: 8, text: bad }],
      filename: "a.pdf",
    });
    assert.notEqual(guess.venue, bad, `accepted as a venue: ${JSON.stringify(bad)}`);
  }
});

await check("a corrected field stops being marked as a guess", () => {
  // The whole point of recording provenance is so the UI can stop nagging once the
  // user has checked something. If editing a field left it marked, the mark would
  // become permanent noise and the user would learn to ignore it — which is worse
  // than never showing it.
  const store = openStore(join(SCRATCH, `verify-${Date.now()}.sqlite`));
  store.upsertPaper({
    paperId: "p1",
    title: "Guessed Title",
    authors: "Guessed Authors",
    venue: "",
    material: "fulltext",
    metadataSource: JSON.stringify({ title: "layout", authors: "layout", venue: "" }),
    pages: ["body"],
  });
  const before = store.getPaper("p1");
  assert.deepEqual(JSON.parse(before.metadataSource), { title: "layout", authors: "layout", venue: "" });
  assert.equal(before.metadataVerifiedAt, "");

  // The user corrects the authors only.
  store.updatePaper("p1", { authors: "Alice; Bob" });
  const after = store.getPaper("p1");
  const sources = JSON.parse(after.metadataSource);
  assert.equal(after.authors, "Alice; Bob");
  assert.equal(sources.authors, undefined, "the corrected field is still marked as a guess");
  assert.equal(sources.title, "layout", "an untouched field lost its provenance");
  assert.notEqual(after.metadataVerifiedAt, "", "no verification timestamp was recorded");

  // A field cleared to empty is also a deliberate choice, not a guess.
  store.updatePaper("p1", { title: "" });
  assert.equal(JSON.parse(store.getPaper("p1").metadataSource).title, undefined);
  store.close();
});

await check("a year inside a citation is not taken as the publication year", () => {
  // The old rule took the first four-digit number on page 1, which is whatever
  // citation the introduction opens with. One real paper came out as 2013 from
  // "(Dong and Siu, 2013)" while it was published in 2021. A wrong year silently
  // corrupts every citation and every "recent literature" claim built on it.
  const guess = guessMetadata(
    ["This has received considerable attention over the past decade (Dong and Siu, 2013; Durna et al., 2015)."],
    {},
  );
  assert.equal(guess.year, "", `invented the year ${guess.year} from a citation`);
});

await check("a volume/year line is accepted as the publication year", () => {
  const footer = guessMetadata(["Vol. 33 No. 2, 2021\npp. 587-603"], {});
  assert.equal(footer.year, "2021", `footer year not read: ${JSON.stringify(footer.year)}`);
  const chinese = guessMetadata(["2023 年 01 月\n第 40 卷第 1 期\n云南民族大学学报 ( 哲学社会科学版)"], {});
  assert.equal(chinese.year, "2023", `Chinese issue year not read: ${JSON.stringify(chinese.year)}`);
});

await check("a running head in XMP does not beat the real title on the page", () => {
  // Some producers write the journal header into dc:title:
  // "International Journal of Hospitality Management 94 (2021) 102880".
  // XMP normally wins, but not when it holds page furniture.
  const layout = [
    { y: 700, height: 21.5, text: "Linking servicescape and customer engagement" },
    { y: 680, height: 21.5, text: "in the hotel context" },
    { y: 660, height: 12, text: "Shuhao Li" },
  ];
  const guess = guessMetadata([""], {
    xmp: { title: "International Journal of Hospitality Management 94 (2021) 102880", authors: [], venue: "", doi: "", year: "" },
    layout,
    filename: "",
  });
  assert.ok(
    !/^\s*International Journal of Hospitality Management \d/.test(guess.title),
    `a running head was accepted as the title from XMP: ${JSON.stringify(guess.title)}`,
  );
  assert.ok(guess.title.includes("Linking servicescape"), `the real title was not recovered: ${JSON.stringify(guess.title)}`);
});

await check("an author list separates names but keeps given names together", () => {
  // "Shuhao Li and Min Wei" must become two authors, not four fragments with
  // "and" among them.
  const layout = [
    { y: 700, height: 21.5, text: "Hotel servicescape and customer citizenship behaviors" },
    { y: 680, height: 12.5, text: "Shuhao Li and Min Wei" },
    { y: 668, height: 10.5, text: "School of Management, Xiamen University" },
  ];
  const guess = guessMetadata([""], { layout, filename: "" });
  assert.equal(guess.authors, "Shuhao Li; Min Wei", `author split wrong: ${JSON.stringify(guess.authors)}`);
});

await check("a journal printed across several lines is joined", () => {
  // Emerald sets the name as stacked lines at the same size; taking only the first
  // gave the stump "International Journal of", which is not a journal.
  const layout = [
    { y: 700, height: 21.5, text: "Some article title here" },
    { y: 100, height: 5.3, text: "International Journal of" },
    { y: 94, height: 5.3, text: "Contemporary Hospitality" },
    { y: 88, height: 5.3, text: "Management" },
    { y: 82, height: 5.2, text: "Vol. 33 No. 2, 2021" },
  ];
  const guess = guessMetadata([""], { layout, filename: "" });
  assert.equal(
    guess.venue,
    "International Journal of Contemporary Hospitality Management",
    `multi-line journal not joined: ${JSON.stringify(guess.venue)}`,
  );
});

// --- layout: the only signal for CJK PDFs --------------------------------
await check("a two-line CJK title is joined at the largest type size", () => {
  // Real CNKI layout: header h=8.8, title h=19.7 across two lines, authors h=13.7.
  const items = [
    { str: "2020 年 第 11 期", transform: [1, 0, 0, 1, 40, 780], height: 8.8, hasEOL: true },
    { str: "酒店服务场景对顾客公民行为的影响：", transform: [1, 0, 0, 1, 40, 700], height: 19.7, hasEOL: true },
    { str: "一个链式中介模型", transform: [1, 0, 0, 1, 40, 676], height: 19.7, hasEOL: true },
    { str: "李书昊 魏敏", transform: [1, 0, 0, 1, 40, 650], height: 13.7, hasEOL: true },
  ];
  const layout = layoutLines(items);
  const guess = guessMetadata([""], { layout, filename: "x.pdf" });
  assert.ok(guess.title.includes("酒店服务场景"), `title missing: ${guess.title}`);
  assert.ok(guess.title.includes("一个链式中介模型"), `second title line dropped: ${guess.title}`);
});

await check("confidence and source are reported for every field", () => {
  // The UI needs these to decide what to ask the user to confirm. A field with no
  // provenance cannot be shown as a guess, and would be trusted like a fact.
  const guess = guessMetadata(["some page text"], {
    xmp: { title: "A Real Title From XMP", authors: ["Alice"], doi: "", venue: "", year: "" },
    info: {},
    layout: [],
    filename: "x.pdf",
  });
  for (const field of ["title", "authors", "year", "venue", "doi"]) {
    assert.ok(typeof guess.confidence[field] === "string", `${field} has no confidence`);
    assert.ok(typeof guess.sources[field] === "string", `${field} has no source`);
  }
  assert.equal(guess.sources.title, "xmp");
  assert.equal(guess.confidence.title, "high");
});

// --- against the real corpus ---------------------------------------------
let pdfs = [];
try {
  pdfs = readdirSync(corpus, { recursive: true })
    .filter((entry) => String(entry).toLowerCase().endsWith(".pdf"))
    .slice(0, 10);
} catch {
  pdfs = [];
}

if (pdfs.length === 0) {
  console.log(`\nSKIP: no PDF corpus at ${corpus}; corpus checks not run.`);
  console.log("(The parser checks above still ran. This is a skip, not a pass.)");
  process.exit(report({ failures, skipped: true, skipReason: "no PDF corpus" }));
}

const samples = [];
for (const relative of pdfs) {
  try {
    const name = String(relative).split(/[\\/]/).pop();
    const extracted = await extractPdfPages(new Uint8Array(readFileSync(join(corpus, String(relative)))));
    samples.push({
      name,
      guess: guessMetadata(extracted.pages, {
        info: extracted.info,
        xmp: extracted.xmp,
        layout: extracted.layout,
        filename: name,
      }),
    });
  } catch {
    // A PDF that cannot be parsed is not a metadata failure.
  }
}

await check("every real paper yields a title, and none is page furniture", () => {
  assert.ok(samples.length > 0, "no paper could be parsed");
  for (const sample of samples) {
    assert.ok(sample.guess.title !== "", `${sample.name}: no title recovered`);
    const title = sample.guess.title;
    assert.ok(
      !/^(Full Terms|JTR\d|EM-|Empirical Research|Downloaded from|See discussions)/i.test(title),
      `${sample.name}: page furniture was accepted as the title: ${JSON.stringify(title)}`,
    );
    assert.ok(
      !/\.\.\s*\d+\s*$/.test(title),
      `${sample.name}: a typesetter page range was accepted as the title: ${JSON.stringify(title)}`,
    );
  }
});

await check("authors are recovered for real papers, not left empty", () => {
  // This is the field that was 0/32. If it regresses, every citation loses its
  // author — which is the difference between a usable bibliography and a list of
  // titles.
  const withAuthors = samples.filter((sample) => sample.guess.authors !== "");
  assert.ok(
    withAuthors.length >= Math.ceil(samples.length * 0.8),
    `only ${withAuthors.length}/${samples.length} papers got authors`,
  );
});

await check("a journal is recovered for at least half the real papers", () => {
  const withVenue = samples.filter((sample) => sample.guess.venue !== "");
  assert.ok(
    withVenue.length >= Math.ceil(samples.length / 2),
    `only ${withVenue.length}/${samples.length} papers got a venue`,
  );
});

await check("no recovered journal is a sentence or an affiliation", () => {
  // Recall is worth nothing if the field is filled with prose. These are the
  // shapes that actually appeared before the guards were added.
  for (const sample of samples) {
    const venue = sample.guess.venue;
    if (venue === "") continue;
    assert.ok(!/[。；;：:，、]/.test(venue), `${sample.name}: venue contains prose punctuation: ${JSON.stringify(venue)}`);
    assert.ok(!/\b(school|college|university|department|institute)\b/i.test(venue), `${sample.name}: venue is an affiliation: ${JSON.stringify(venue)}`);
    assert.ok(venue.length <= 90, `${sample.name}: venue is too long to be a name: ${JSON.stringify(venue)}`);
    assert.ok(/[A-Za-z]{2,}|[\u4e00-\u9fff]/.test(venue), `${sample.name}: venue has no word characters`);
  }
});

await check("a year is a four-digit year or nothing", () => {
  for (const sample of samples) {
    const year = sample.guess.year;
    if (year === "") continue;
    assert.match(year, /^(19|20)\d{2}$/, `${sample.name}: implausible year ${JSON.stringify(year)}`);
  }
});

console.log(failures === 0 ? "\nMETADATA PASS" : `\n${failures} FAILURE(S)`);
process.exit(report({ failures }));

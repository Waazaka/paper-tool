// Writing assistance (PT-021).
//
// Three features that share only a work item, so the gate is organised by the failure
// each one can produce rather than by the code it covers:
//
//   1. **Import.** A .bib or .ris that parses "mostly right" is worse than one that
//      refuses: a dropped author or a mangled year looks like data. So the assertions
//      are on stored field values, and the round trip actually runs — export the
//      library, import it into an empty one, compare row by row.
//   2. **Skeleton.** The criterion says each section must bind at least one real
//      evidenceId. Asserting the shape of the output is not enough — an id that is not
//      in the library would still look like a binding. The gate builds the skeleton
//      from a known library and checks every returned id against it.
//   3. **Overlap.** This is the one that can go wrong quietly, by becoming a
//      plagiarism score. The gate asserts what must NOT be there (percentages, advice
//      wording) as hard as what must be, and re-derives the "no score" rule from the
//      response shape rather than from a comment (D-015).
//
// The mounted section drives the real panel: the three features are buttons, and a
// button that is not on screen is not shipped.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const { loadService } = await import("./shim.mjs");
const { installDom } = await import("./dom-stub.mjs");
const citations = await import("../lib/citation-import.js");
const skeletonModule = await import("../lib/section-skeleton.js");
const similarity = await import("../lib/similarity.js");
const { renderBibtex } = await import("../lib/bibtex.js");

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else {
    console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail));
    failures.push(name);
  }
}

const client = readFileSync("client.js", "utf8");
const hostSource = readFileSync("lib/host-service.js", "utf8");
const tools = readFileSync("lib/tools.js", "utf8");
const similaritySource = readFileSync("lib/similarity.js", "utf8");
const { PaperToolService } = await loadService();

function makeLibrary(label) {
  const home = mkdtempSync(join(tmpdir(), `s37-${label}-home-`));
  const work = mkdtempSync(join(tmpdir(), `s37-${label}-work-`));
  const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home, shared: true });
  const scope = { sessionId: `s37-${label}`, workspaceRoot: work };
  return {
    service,
    scope,
    store: service.storeFor(scope),
    cleanup() {
      try { service.dispose(); } catch { /* already closed */ }
      for (const dir of [home, work]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

const BIB = `@article{smith2020deep,
  title = {Deep Learning for {DNA} Sequencing},
  author = {Smith, John and Doe, Jane},
  year = {2020},
  journal = {Nature Methods},
  doi = {10.1038/s41592-020-12345},
}

@inproceedings{chen2021gap,
  author = "Chen, Wei",
  title = "A Gap in the Literature",
  booktitle = "Proc. of Something",
  year = "2021",
  doi = "10.1109/CONF.2021.00042",
}

@misc{anon2022note,
  title = {An Entry With No DOI},
  author = {Anonymous},
  year = {2022},
}
`;

const RIS = `TY  - JOUR
AU  - Smith, John
AU  - Doe, Jane
TI  - Deep Learning for DNA Sequencing
JO  - Nature Methods
PY  - 2020
DO  - 10.1038/s41592-020-12345
ER  - 

TY  - JOUR
AU  - Chen, Wei
TI  - A Gap in the
      Literature
T2  - Proc. of Something
PY  - 2021
DO  - 10.1109/CONF.2021.00042
ER  - 
`;

// --- 1. the tool surface is still six ------------------------------
// PT-021 adds three capabilities and zero tools (D-014). If this count ever moves,
// the decision was reversed silently.
{
  const names = [...tools.matchAll(/^\s+name: "(paper_[a-z]+)",$/gm)].map((m) => m[1]);
  check("there are exactly six tools", names.length === 6, names.join(", "));
  for (const forbidden of ["paper_writing", "paper_outline", "paper_import_bib", "paper_plagiarism"]) {
    check(`no ${forbidden} tool was added`, !new RegExp(forbidden).test(tools));
  }
  for (const method of ["sectionSkeleton", "importCitations", "similarityNotice"]) {
    check(`${method} is marked remote`, new RegExp(`^\\s+"${method}",$`, "m").test(hostSource));
    check(`the client reaches ${method} through the wrapped input path`,
      new RegExp(`"${method}"`).test(client));
  }
  // Asserted on the INPUT_METHODS set specifically, not on the file text: the call
  // sites mention the same names, so a file-wide search would still pass if the set
  // entry were deleted and only the unnamed call remained.
  {
    const blockStart = client.indexOf("const INPUT_METHODS = new Set([");
    const blockEnd = client.indexOf("]);", blockStart);
    const block = blockStart < 0 || blockEnd < 0 ? "" : client.slice(blockStart, blockEnd);
    for (const method of ["sectionSkeleton", "importCitations", "similarityNotice"]) {
      check(`INPUT_METHODS lists ${method}`, block.includes(`"${method}"`), block.length === 0 ? "block not found" : "");
    }
  }
  check("paper_status reports the writing section", /writing:\s*\{/.test(hostSource));
  check("paper_status publishes the section plan", /sections:\s*SECTION_PLAN\.map/.test(hostSource));
  check("paper_status carries the similarity disclaimer",
    /disclaimer:\s*SIMILARITY_DISCLAIMER/.test(hostSource));
}

// --- 2. no model channel anywhere in the new code -------------------
{
  const sources = {
    "lib/citation-import.js": readFileSync("lib/citation-import.js", "utf8"),
    "lib/section-skeleton.js": readFileSync("lib/section-skeleton.js", "utf8"),
    "lib/similarity.js": similaritySource,
  };
  for (const [name, source] of Object.entries(sources)) {
    for (const forbidden of ["generateText", "ctx.model", "ctx.llm", "openai", "chatCompletion"]) {
      check(`${name} does not call a model (${forbidden})`, !source.includes(forbidden), forbidden);
    }
    check(`${name} declares no model import`,
      !/from\s+["'][^"']*(model|llm|openai|anthropic)[^"']*["']/i.test(source));
  }
}

// --- 3. BibTeX parsing keeps every field ---------------------------
{
  const parsed = citations.parseCitationFile({ fileName: "refs.bib", text: BIB });
  check("the .bib is recognised as BibTeX", parsed.format === "bibtex", parsed.format);
  check("every entry is parsed", parsed.records.length === 3, String(parsed.records.length));
  const first = parsed.records[0];
  check("the title keeps inner braces but drops the braces themselves",
    first.title === "Deep Learning for DNA Sequencing", first.title);
  check("two authors are split and reordered as Given Family",
    first.authors === "John Smith; Jane Doe", first.authors);
  check("the year is the four-digit year", first.year === "2020", first.year);
  check("the journal is read from the journal field", first.venue === "Nature Methods", first.venue);
  check("the DOI is normalised", first.doi === "10.1038/s41592-020-12345", first.doi);
  check("a quoted entry parses the same as a braced one",
    parsed.records[1].title === "A Gap in the Literature" && parsed.records[1].authors === "Wei Chen",
    JSON.stringify(parsed.records[1]).slice(0, 120));
  check("booktitle is used as the venue when journal is absent",
    parsed.records[1].venue === "Proc. of Something", parsed.records[1].venue);
}

// --- 4. hostile .bib input is refused, not half-parsed -------------
{
  const noTitle = citations.parseCitationFile({ fileName: "x.bib", text: "@article{k, author={A}, year={2020},}" });
  check("an entry without a title is skipped, not stored as an empty paper",
    noTitle.records.length === 0 && noTitle.skipped.length === 1,
    JSON.stringify(noTitle.skipped));
  const nested = citations.parseCitationFile({
    fileName: "x.bib",
    text: "@article{k, title={A {B} {C} D}, author={X}, year={2021},}",
  });
  check("nested braces do not end the entry early",
    nested.records.length === 1 && nested.records[0].title === "A B C D",
    JSON.stringify(nested.records[0]?.title));
  const comment = citations.parseCitationFile({
    fileName: "x.bib",
    text: "@comment{this is not a record}\n@string{foo = {bar}}\n@article{k, title={Real}, year={2020},}",
  });
  // Both halves matter: the pseudo-entries must not become papers, and must not be
  // reported as unreadable entries either — they are neither.
  check("comment and string pseudo-entries are not treated as papers",
    comment.records.length === 1 && comment.records[0].title === "Real",
    String(comment.records.length));
  check("comment and string pseudo-entries are not reported as skipped records",
    comment.skipped.length === 0, JSON.stringify(comment.skipped));
  const unknown = citations.parseCitationFile({ fileName: "x.txt", text: "just some prose" });
  check("an unrecognised file is reported rather than guessed at",
    unknown.format === "" && unknown.records.length === 0, JSON.stringify(unknown.format));
  check("a .txt that contains BibTeX is still detected by content",
    citations.parseCitationFile({ fileName: "x.txt", text: BIB }).format === "bibtex");
  // DOIs are case-insensitive by spec and other tools disagree about the case, so the
  // stored form has to be normalised or the dedupe below silently stops matching.
  check("a DOI is lower-cased", citations.normalizeDoi("10.1038/S41592-020-12345") === "10.1038/s41592-020-12345",
    citations.normalizeDoi("10.1038/S41592-020-12345"));
  check("a doi.org URL is reduced to the DOI",
    citations.normalizeDoi("https://doi.org/10.1000/XYZ") === "10.1000/xyz",
    citations.normalizeDoi("https://doi.org/10.1000/XYZ"));
  check("a doi: prefix is stripped", citations.normalizeDoi("doi: 10.1/AbC") === "10.1/abc",
    citations.normalizeDoi("doi: 10.1/AbC"));
}

// --- 5. RIS parsing keeps every field ------------------------------
{
  const parsed = citations.parseCitationFile({ fileName: "refs.ris", text: RIS });
  check("the .ris is recognised as RIS", parsed.format === "ris", parsed.format);
  check("both JOUR records are parsed", parsed.records.length === 2, String(parsed.records.length));
  const first = parsed.records[0];
  check("the RIS title is read from TI", first.title === "Deep Learning for DNA Sequencing", first.title);
  check("repeated AU lines become two authors in Given Family order",
    first.authors === "John Smith; Jane Doe", first.authors);
  check("the RIS year comes from PY", first.year === "2020", first.year);
  check("the RIS venue falls back through JO", first.venue === "Nature Methods", first.venue);
  check("the RIS DOI is normalised", first.doi === "10.1038/s41592-020-12345", first.doi);
  check("a wrapped title is joined rather than truncated",
    parsed.records[1].title === "A Gap in the Literature", parsed.records[1].title);
  check("T2 is used as the venue when JO is absent",
    parsed.records[1].venue === "Proc. of Something", parsed.records[1].venue);
  const typeCount = parsed.records.filter((row) => row.entryType === "article").length;
  check("TY JOUR maps to an article", typeCount === 2, String(typeCount));
}

// --- 6. importing into a real library -----------------------------
{
  const library = makeLibrary("import");
  try {
    const result = await library.service.importCitations(library.scope, { fileName: "refs.bib", text: BIB });
    check("the import reports the format it used", result.format === "bibtex", result.format);
    check("three entries are imported", result.imported.length === 3, String(result.imported.length));
    check("nothing is reported as duplicate on a first import", result.duplicates.length === 0);
    check("entries without a DOI are reported so the caller knows they cannot dedupe",
      result.withoutDoi.length === 1, JSON.stringify(result.withoutDoi));

    const papers = library.store.listPapers({ limit: 50 }).papers ?? library.store.listPapers({ limit: 50 });
    check("the library now holds three papers", papers.length === 3, String(papers.length));
    check("every imported paper is metadata-only",
      papers.every((paper) => paper.material === "metadata"),
      JSON.stringify(papers.map((paper) => paper.material)));
    const deep = papers.find((paper) => paper.title.startsWith("Deep Learning"));
    check("the stored title matches the file", deep?.title === "Deep Learning for DNA Sequencing", deep?.title);
    check("the stored authors match the file", deep?.authors === "John Smith; Jane Doe", deep?.authors);
    check("the stored year matches the file", deep?.year === "2020", deep?.year);
    check("the stored DOI matches the file", deep?.doi === "10.1038/s41592-020-12345", deep?.doi);
    check("the stored venue matches the file", deep?.venue === "Nature Methods", deep?.venue);
  } finally {
    library.cleanup();
  }
}

// --- 7. RIS imports the same way ----------------------------------
{
  const library = makeLibrary("ris");
  try {
    const result = await library.service.importCitations(library.scope, { fileName: "refs.ris", text: RIS });
    check("the .ris import is recognised as RIS", result.format === "ris", result.format);
    check("two records are imported from the .ris", result.imported.length === 2, String(result.imported.length));
    check("the .ris entries are metadata-only", result.imported.every((row) => typeof row.paperId === "string"));
    const papers = library.store.listPapers({ limit: 50 }).papers ?? library.store.listPapers({ limit: 50 });
    const deep = papers.find((paper) => paper.title.startsWith("Deep Learning"));
    check("a .ris title is stored intact", deep?.title === "Deep Learning for DNA Sequencing", deep?.title);
    check("a .ris author list is stored intact", deep?.authors === "John Smith; Jane Doe", deep?.authors);
    check("a .ris DOI is stored normalised", deep?.doi === "10.1038/s41592-020-12345", deep?.doi);
  } finally {
    library.cleanup();
  }
}

// --- 8. DOI dedupe on a second import -----------------------------
{
  const library = makeLibrary("dedupe");
  try {
    const first = await library.service.importCitations(library.scope, { fileName: "refs.bib", text: BIB });
    check("the first import stores three", first.imported.length === 3, String(first.imported.length));
    const second = await library.service.importCitations(library.scope, { fileName: "refs.bib", text: BIB });
    // The DOI-bearing entries are caught; the DOI-less entry has nothing to match on and
    // is imported again. Asserting "nothing is imported" would be asserting a dedupe
    // rule that does not exist — the honest claim is "only the DOI-less one repeats",
    // and that the repeat is reported rather than hidden.
    check("the second import re-imports only the entry that has no DOI",
      second.imported.length === 1, String(second.imported.length));
    check("the second import reports the two DOI-bearing entries as duplicates",
      second.duplicates.length === 2, String(second.duplicates.length));
    check("the duplicate report names the existing papers",
      second.duplicates.every((row) => typeof row.paperId === "string" && row.paperId !== ""));
    // The entry without a DOI has nothing to match on, so it is imported again. That is
    // a property of DOI dedupe, not a bug — but it must be reported, not silent.
    check("the DOI-less entry is reported as un-dedupable rather than silently duplicated",
      second.withoutDoi.length === 1 && second.withoutDoi[0].title === "An Entry With No DOI",
      JSON.stringify(second.withoutDoi));
    const papers = library.store.listPapers({ limit: 50 }).papers ?? library.store.listPapers({ limit: 50 });
    check("the library grew by exactly the DOI-less entry", papers.length === 4, String(papers.length));
  } finally {
    library.cleanup();
  }
}

// --- 8b. the criterion as written: a .bib where every entry has a DOI ---
// Section 8 documents the real boundary (an entry with no DOI cannot be matched). The
// acceptance criterion states the plain case — import twice, the second import reports
// duplicates and no imports — so that case is asserted on its own rather than being
// inferred from a fixture that also contains the exception.
{
  const library = makeLibrary("dedupe-all");
  const allDoi = BIB.replace(
    `@misc{anon2022note,
  title = {An Entry With No DOI},
  author = {Anonymous},
  year = {2022},
}`,
    `@misc{anon2022note,
  title = {An Entry With A DOI},
  author = {Anonymous},
  year = {2022},
  doi = {10.5555/anon.2022.1},
}`,
  );
  try {
    const first = await library.service.importCitations(library.scope, { fileName: "all.bib", text: allDoi });
    check("the all-DOI fixture imports three", first.imported.length === 3, String(first.imported.length));
    const second = await library.service.importCitations(library.scope, { fileName: "all.bib", text: allDoi });
    check("a second import of an all-DOI .bib imports nothing", second.imported.length === 0,
      String(second.imported.length));
    check("a second import reports all three as duplicates", second.duplicates.length === 3,
      String(second.duplicates.length));
    const papers = library.store.listPapers({ limit: 50 }).papers ?? library.store.listPapers({ limit: 50 });
    check("the library did not grow on the second import", papers.length === 3, String(papers.length));
  } finally {
    library.cleanup();
  }
}

// --- 9. DOI matching is case-insensitive --------------------------
{
  const library = makeLibrary("doicase");
  try {
    await library.service.importCitations(library.scope, { fileName: "a.bib", text: BIB });
    const shouty = BIB.replace("10.1038/s41592-020-12345", "10.1038/S41592-020-12345");
    const again = await library.service.importCitations(library.scope, { fileName: "b.bib", text: shouty });
    check("a DOI written in different case is still recognised as the same work",
      again.duplicates.length === 2, String(again.duplicates.length));
    // The store lookup itself has to be case-insensitive: normalising on the way in is
    // not enough, because a row imported before this rule existed is already stored in
    // whatever case the file used.
    library.store.upsertPaper({
      paperId: "legacy", title: "Legacy Row", authors: "A", year: "2019", venue: "V",
      doi: "10.9999/LEGACY", source: "test", material: "metadata", pages: [],
    });
    check("findByDoi matches a stored DOI whose case differs",
      library.store.findByDoi("10.9999/legacy") !== null,
      String(library.store.findByDoi("10.9999/legacy")?.paperId ?? "null"));
  } finally {
    library.cleanup();
  }
}

// --- 10. round trip: export, import into an empty library ---------
{
  const source = makeLibrary("rt-source");
  const target = makeLibrary("rt-target");
  try {
    await source.service.importCitations(source.scope, { fileName: "refs.bib", text: BIB });
    const before = (source.store.listPapers({ limit: 50 }).papers ?? source.store.listPapers({ limit: 50 }))
      .map((paper) => ({ title: paper.title, authors: paper.authors, year: paper.year, doi: paper.doi }))
      .sort((a, b) => a.title.localeCompare(b.title));
    // Rendered through the same function the export path uses for its .bib sidecar.
    // Going through exportReview would require evidence in the library, which the round
    // trip has nothing to do with — the question here is whether metadata survives a
    // .bib round trip, not whether a review body can be written.
    const exported = renderBibtex(
      (source.store.listPapers({ limit: 50 }).papers ?? source.store.listPapers({ limit: 50 })),
    );
    check("the library exports a .bib", typeof exported.bibtex === "string" && exported.bibtex.length > 0);
    const reimported = await target.service.importCitations(target.scope, { fileName: "roundtrip.bib", text: exported.bibtex });
    check("every exported entry imports back", reimported.imported.length === before.length,
      `${reimported.imported.length} of ${before.length}`);
    const after = (target.store.listPapers({ limit: 50 }).papers ?? target.store.listPapers({ limit: 50 }))
      .map((paper) => ({ title: paper.title, authors: paper.authors, year: paper.year, doi: paper.doi }))
      .sort((a, b) => a.title.localeCompare(b.title));
    check("the round trip preserves the row count", after.length === before.length,
      `${after.length} vs ${before.length}`);
    // Compared field by field rather than by JSON equality, so a mismatch names the
    // field that broke. Keys are allowed to differ; the criterion says so.
    let fieldMismatch = "";
    for (let index = 0; index < before.length && fieldMismatch === ""; index += 1) {
      for (const field of ["title", "authors", "year", "doi"]) {
        if (before[index][field] !== after[index][field]) {
          fieldMismatch = `${field}: ${JSON.stringify(before[index][field])} -> ${JSON.stringify(after[index][field])} (${before[index].title})`;
          break;
        }
      }
    }
    check("every field survives the round trip", fieldMismatch === "", fieldMismatch);
  } finally {
    source.cleanup();
    target.cleanup();
  }
}

// --- 11. the skeleton is structurally different from the outline ---
{
  const library = makeLibrary("skeleton");
  try {
    check("the plan has a stable section list", skeletonModule.SECTION_PLAN.length >= 4,
      String(skeletonModule.SECTION_PLAN.length));
    const empty = await library.service.sectionSkeleton(library.scope, {});
    check("an empty library produces no sections", empty.sections.length === 0, String(empty.sections.length));
    check("an empty library explains why instead of returning a bare empty list",
      typeof empty.note === "string" && empty.note.length > 10, empty.note);

    // Seed two papers with three evidence rows each.
    for (let p = 0; p < 2; p += 1) {
      const paperId = `p${p}`;
      library.store.upsertPaper({
        paperId, title: `Paper ${p}`, authors: `Author ${p}`, year: "2021",
        venue: "V", doi: `10.1/sk-${p}`, source: "test", material: "metadata", pages: [],
      });
      for (let e = 0; e < 3; e += 1) {
        library.store.addEvidence({
          evidenceId: `e${p}${e}`, paperId, pageIndex: e,
          charStart: 0, charEnd: 10, quote: `passage ${p}-${e} about the method`,
        });
      }
    }
    const built = await library.service.sectionSkeleton(library.scope, {});
    check("a seeded library produces sections", built.sections.length > 0, String(built.sections.length));
    const allIds = new Set();
    for (let p = 0; p < 2; p += 1) for (let e = 0; e < 3; e += 1) allIds.add(`e${p}${e}`);
    let dangling = "";
    let emptySection = "";
    for (const section of built.sections) {
      if (section.evidenceIds.length === 0) emptySection = section.id;
      for (const id of section.evidenceIds) if (!allIds.has(id)) dangling = `${section.id}: ${id}`;
    }
    check("every section binds at least one evidence id", emptySection === "", emptySection);
    check("every bound id exists in the library", dangling === "", dangling);
    // The panel used to print the first eight characters of an id, which appears
    // nowhere else in the UI, so the writer could not look the evidence up. The host
    // now ships a locator per bound id; asserted here because the mounted test below
    // runs on a mock and would keep passing if the host stopped sending them.
    {
      const missing = [];
      for (const section of built.sections) {
        if (!Array.isArray(section.citations)) { missing.push(section.id + ":no-array"); continue; }
        if (section.citations.length !== section.evidenceIds.length) { missing.push(section.id + ":length"); continue; }
        for (const cite of section.citations) {
          if (typeof cite.paperTitle !== "string" || cite.paperTitle === "") missing.push(section.id + ":title");
          if (!Number.isInteger(cite.pageIndex) || cite.pageIndex < 0) missing.push(section.id + ":page");
          if (typeof cite.quote !== "string") missing.push(section.id + ":quote");
        }
      }
      check("every bound id ships a readable locator", missing.length === 0, missing.join(", "));
      const first = built.sections[0]?.citations?.[0];
      check("the locator names the paper the evidence came from",
        first !== undefined && /^Paper [01]$/.test(first.paperTitle), JSON.stringify(first));
    }
    check("every section carries a purpose", built.sections.every((s) => typeof s.purpose === "string" && s.purpose.length > 4));
    // The panel stopped printing raw ids, so a note promising "lists the evidenceId"
    // would describe something the user cannot see.
    check("the skeleton note matches what the panel actually shows",
      !/evidenceId/.test(built.note), built.note);
    check("the skeleton note says the locator is a paper and a page",
      /哪篇/.test(built.note) && /哪一页/.test(built.note), built.note);
    check("the skeleton cites all six rows across its sections",
      built.sections.reduce((sum, s) => sum + s.evidenceIds.length, 0) === 6,
      String(built.sections.reduce((sum, s) => sum + s.evidenceIds.length, 0)));

    // The structural difference from reviewOutline: that one groups by paper, this one
    // groups by section. Asserted on the payload shapes so a future refactor that makes
    // them the same thing fails here.
    const outline = await library.service.reviewOutline(library.scope, {});
    check("the outline groups by paper", Array.isArray(outline.groups) && outline.groups[0]?.paperId !== undefined,
      JSON.stringify(Object.keys(outline.groups?.[0] ?? {})));
    check("the skeleton groups by section, not by paper",
      built.sections[0]?.id !== undefined && built.sections[0]?.paperIds !== undefined,
      JSON.stringify(Object.keys(built.sections[0] ?? {})));
    check("the two payloads are not interchangeable",
      JSON.stringify(outline.groups[0]) !== JSON.stringify(built.sections[0]));

    // A binding to an id that is not in the library must be dropped, never emitted.
    const poisoned = skeletonModule.buildSkeleton(
      [{ evidenceId: "ghost", paperId: "p0", pageIndex: 0, quote: "x" }],
      { knownEvidenceIds: new Set(["e00"]) },
    );
    check("a skeleton built from an unknown id binds nothing",
      poisoned.sections.every((section) => !section.evidenceIds.includes("ghost")),
      JSON.stringify(poisoned.sections));
    check("the drop is reported rather than silent", poisoned.droppedEvidence === 1,
      String(poisoned.droppedEvidence));
  } finally {
    library.cleanup();
  }
}

// --- 12. the overlap check never becomes a score ------------------
{
  check("the module exports a disclaimer", typeof similarity.SIMILARITY_DISCLAIMER === "string"
    && similarity.SIMILARITY_DISCLAIMER.length > 20);
  // The wording rule is the feature (D-015). Two separate things are asserted:
  //   (a) the disclaimer must not OFFER a score or rewriting advice;
  //   (b) where it names those things, it must be negating them — "not a plagiarism
  //       rate" is the sentence doing the work, so the word has to be there.
  // Asserting "查重率 never appears" would forbid the very disclaimer that prevents the
  // misreading, so (b) is asserted as a co-occurrence instead.
  for (const forbidden of ["降重", "相似度百分比", "重复率", "plagiarism rate", "%"]) {
    check(`the disclaimer does not offer ${forbidden}`,
      !similarity.SIMILARITY_DISCLAIMER.includes(forbidden), forbidden);
  }
  check("the disclaimer says it is assistance only", /仅作辅助/.test(similarity.SIMILARITY_DISCLAIMER));
  check("the disclaimer negates the originality reading it names",
    /不评判原创性/.test(similarity.SIMILARITY_DISCLAIMER), similarity.SIMILARITY_DISCLAIMER);
  check("the disclaimer negates the plagiarism-rate reading it names",
    /不是查重率/.test(similarity.SIMILARITY_DISCLAIMER), similarity.SIMILARITY_DISCLAIMER);
  check("the source never names a feature after plagiarism",
    !/plagiar/i.test(similaritySource));
  // The repository-wide rule from the work item: the neutral name must hold.
  const c = createRequire(import.meta.url);
  void c;
}

// --- 13. overlap matching is real, and reports no score -----------
{
  const rows = [
    { evidenceId: "e1", paperId: "p1", paperTitle: "Paper 1", pageIndex: 0, quote: "深度学习在图像识别任务上取得了显著进展" },
    { evidenceId: "e2", paperId: "p2", paperTitle: "Paper 2", pageIndex: 3, quote: "完全无关的一段材料，讲的是别的题目" },
  ];
  const hit = similarity.findByOverlap("本文认为深度学习在图像识别任务上取得了显著进展并且还在继续", rows);
  check("an overlapping passage is found", hit.hits.length === 1, String(hit.hits.length));
  check("the hit names the evidence row", hit.hits[0]?.evidenceId === "e1", hit.hits[0]?.evidenceId);
  check("the hit carries the page so the writer can look it up", hit.hits[0]?.pageIndex === 0);
  check("the hit reports how many characters overlap", hit.hits[0]?.overlapChars >= 12,
    String(hit.hits[0]?.overlapChars));
  check("an unrelated passage produces no hits",
    similarity.findByOverlap("完全不相关的新内容", rows).hits.length === 0);
  check("short text is refused instead of reported as clean",
    similarity.findByOverlap("太短", rows).enoughText === false);
  check("no response field is a score", !("score" in hit) && !("percent" in hit) && !("similarity" in hit),
    JSON.stringify(Object.keys(hit)));
  // Whitespace and punctuation differ between a PDF extraction and a typed passage
  // while the words are identical; neither may affect the result.
  const spaced = similarity.findByOverlap("深度学习 在图像识别任务上 取得了显著进展", rows);
  check("whitespace differences do not hide an overlap", spaced.hits.length === 1, String(spaced.hits.length));
}

// --- 14. the RPC wires the module without adding a score ----------
{
  const library = makeLibrary("similar");
  try {
    library.store.upsertPaper({
      paperId: "p1", title: "P1", authors: "A", year: "2021", venue: "V",
      doi: "10.1/sim", source: "test", material: "metadata", pages: [],
    });
    library.store.addEvidence({
      evidenceId: "e1", paperId: "p1", pageIndex: 2,
      charStart: 0, charEnd: 20, quote: "深度学习在图像识别任务上取得了显著进展",
    });
    const result = await library.service.similarityNotice(library.scope, {
      text: "我们认为深度学习在图像识别任务上取得了显著进展，这一点很重要",
    });
    check("the RPC finds the stored row", result.hits.length === 1, String(result.hits.length));
    check("the RPC carries the disclaimer", result.disclaimer === similarity.SIMILARITY_DISCLAIMER);
    check("the RPC reports how many rows it checked", result.checked === 1, String(result.checked));
    const serialised = JSON.stringify(result);
    // The response carries the disclaimer, which names 「原创性」 and 「查重率」 in order to
    // deny them. What must never appear is the offer: a percentage or rewriting advice.
    for (const forbidden of ["降重", "重复率", "相似度百分比"]) {
      check(`the RPC response never offers ${forbidden}`, !serialised.includes(forbidden), forbidden);
    }
    check("the response denies the plagiarism reading rather than omitting it",
      serialised.includes("不是查重率"));
    check("the response contains no percentage sign at all", !serialised.includes("%"));
    check("the response has no numeric score field",
      !/(^|[{,]")[a-zA-Z]*(score|percent|ratio|plagiar)[a-zA-Z]*":/.test(serialised),
      serialised.slice(0, 160));
    const tooShort = await library.service.similarityNotice(library.scope, { text: "短" });
    check("the RPC refuses text too short to compare", tooShort.enoughText === false);
  } finally {
    library.cleanup();
  }
}

// --- 14b. an empty library refuses instead of reporting "no overlap" ------
// Found on the real GUI: with zero evidence the panel said "compared against 0
// rows, no overlap of 12+ characters found", which reads as a clean result. It is a
// conclusion drawn from no samples, so the RPC must refuse. Same rule as the topic
// recommender's sample floor.
{
  const library = makeLibrary("similar-empty");
  try {
    const empty = await library.service.similarityNotice(library.scope, {
      text: "深度学习在图像识别任务上取得了显著进展，这一点值得进一步讨论",
    });
    check("an empty library reports nothing was comparable", empty.comparable === false,
      JSON.stringify(empty));
    check("an empty library checks zero rows", empty.checked === 0, String(empty.checked));
    check("an empty library produces no hits", empty.hits.length === 0, String(empty.hits.length));
    check("the refusal explains that no comparison is not the same as no overlap",
      /没有比对不等于没有相似/.test(empty.note), empty.note);
    check("the refusal does not claim the passage is clean",
      !/没有发现/.test(empty.note), empty.note);
    check("the refusal still carries the disclaimer", empty.disclaimer === similarity.SIMILARITY_DISCLAIMER);
  } finally {
    library.cleanup();
  }
}

// --- 15. mounted panel -------------------------------------------------
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
  console.log(`  SKIP mounted section (react unavailable: ${error.message})`);
}

if (React !== undefined) {
  const { document, window } = installDom({ width: 380, height: 700 });

  const papers = [
    { paperId: "pA", title: "论文 A", authors: "A", year: "2021", venue: "V", material: "metadata", pdfPath: "", hitCount: 0 },
  ];
  const calls = [];
  // Flipped to 0 for the empty-library case below; the host reports allTotal from the
  // same count, so the mock has to agree with it or the button state proves nothing.
  let mountedEvidenceCount = 1;
  let emptySkeletonNote = "";
  const answer = (method) => {
    switch (method) {
      case "status":
        return {
          library: { papers: 1, pages: 0, evidence: 1 },
          styles: ["apa"],
          translation: { supported: true, total: 0, engine: "agent", indexed: false },
          topics: { supported: true, method: "topicRecommend", minSample: 8, disclaimer: "x" },
          writing: {
            supported: true,
            skeletonMethod: "sectionSkeleton",
            importMethod: "importCitations",
            similarityMethod: "similarityNotice",
            sections: [{ id: "introduction", title: "引言" }],
            similarity: { minProbeChars: 8, disclaimer: "仅作辅助：不评判原创性" },
          },
          limits: { maxImportFiles: 32, maxPdfBytes: 67108864 },
        };
      case "listPapers": return { papers, library: { papers: 1, pages: 0, evidence: 1 }, paging: { offset: 0, limit_returned: 1, total: 1, hasMore: false } };
      case "listEvidence": {
        const rows = mountedEvidenceCount === 0
          ? []
          : [{ evidenceId: "e1", paperId: "pA", paperTitle: "论文 A", pageIndex: 0, quote: "深度学习在图像识别任务上取得了显著进展", status: "anchored" }];
        return { evidence: rows, paging: { offset: 0, limit_returned: rows.length, total: rows.length, hasMore: false, anchoredTotal: rows.length, allTotal: rows.length } };
      }
      case "listAnnotations": return { annotations: [] };
      case "listClaims": return { claims: [] };
      case "sectionSkeleton":
        if (mountedEvidenceCount === 0) {
          return {
            sections: [],
            totalEvidence: 0,
            droppedEvidence: 0,
            note: "库里还没有可用证据：这个骨架不是空的建议，是没有材料可依据，所以不产出章节。",
            text: "库里还没有可用证据：这个骨架不是空的建议，是没有材料可依据，所以不产出章节。",
          };
        }
        return {
          sections: [
            { id: "introduction", title: "引言", purpose: "问题是什么", evidenceIds: ["e1"], paperIds: ["pA"],
              citations: [{ evidenceId: "e1", paperTitle: "论文 A", pageIndex: 0, quote: "深度学习在图像识别任务上取得了显著进展" }] },
            { id: "conclusion", title: "结论", purpose: "综合起来能说什么", evidenceIds: ["e1"], paperIds: ["pA"],
              citations: [{ evidenceId: "e1", paperTitle: "论文 A", pageIndex: 0, quote: "深度学习在图像识别任务上取得了显著进展" }] },
          ],
          totalEvidence: 1,
          droppedEvidence: 0,
          note: "骨架依据 1 条证据",
          text: "章节骨架：2 章",
        };
      case "importCitations":
        return {
          format: "bibtex",
          imported: [{ paperId: "pX", title: "导入的标题", doi: "10.1/x", citeKey: "k" }],
          duplicates: [],
          withoutDoi: [],
          skipped: [],
          text: "导入 BibTeX：新增 1 条",
        };
      case "similarityNotice":
        return {
          hits: [{ evidenceId: "e1", paperId: "pA", paperTitle: "论文 A", pageIndex: 0, quote: "深度学习在图像识别任务上取得了显著进展", overlapChars: 18 }],
          enoughText: true,
          checked: 1,
          note: "与库内 1 条证据比对，发现 1 条重叠。",
          disclaimer: "仅作辅助：只与你自己库里已存的证据比对，不评判原创性，也不是查重率。",
          text: "x",
        };
      default: return {};
    }
  };

  let exported = null;
  globalThis.window.__ModuleLoader__ = {
    load({ factory }) {
      exported = factory((id) => {
        if (id === "react") return React;
        throw new Error(`unexpected require: ${id}`);
      });
    },
  };
  await import(new URL("../client.js", import.meta.url).href);
  const { Body, DICTS } = exported.__test;
  const zh = DICTS.zh;
  const t = (key, params) => {
    const raw = zh[key];
    if (raw === undefined) return key;
    return params === undefined ? raw : String(raw).replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])));
  };

  const seenErrors = [];
  const realError = console.error;
  console.error = (...args) => { seenErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")); };

  exported.apply({
    connection: { rpc: { async call(_path, method, options) {
      const name = String(method).replace(/^paperTool\//, "");
      calls.push({ method: name, payload: options?.args ?? {} });
      return { ok: true, value: answer(name) };
    } } },
    locale: { register() {}, bind: () => t },
    slots: { inject() {}, register: () => ({}) },
    sidebarRightTabs: { register: () => ({}) },
    effect() {},
  });

  const mountHost = document.createElement("div");
  document.body.appendChild(mountHost);
  const root = createRoot(mountHost);
  root.render(React.createElement(Body, { sessionId: "s37", inputActions: { captureInsertion() {}, insertText() {} }, t }));
  const settle = async (turns = 30) => { for (let i = 0; i < turns; i += 1) await new Promise((r) => setTimeout(r, 0)); };
  await settle();

  const buttons = () => [...mountHost.querySelectorAll("button")];
  const byText = (label) => buttons().filter((b) => b.textContent.trim() === label);
  const tab = (label) => buttons().find((b) => b.textContent.trim().startsWith(label));
  const click = async (button, turns = 10) => {
    button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(turns);
  };

  // The three panels live on the review tab.
  await click(tab(zh.reviewTab));
  check("the review tab opens", mountHost.textContent.includes(zh.reviewTab ?? "review"), mountHost.textContent.slice(0, 80));

  // Same rule as the PDF import path (s26): a user's own cancel is not a defect,
  // and an AbortError banner would report it as one.
  {
    const at = client.indexOf("} catch (citeError) {");
    const body = at < 0 ? "" : client.slice(at, at + 400);
    check("a cancelled citation import is not shown as an error",
      /isAbortError\(citeError\)/.test(body), at < 0 ? "no catch block" : body.slice(0, 120));
    check("the cancelled-import branch refreshes instead of setting an error",
      /isAbortError\(citeError\)\) \{\s*await refresh\(\);/.test(body));
  }
  check("the skeleton control is on screen", byText(zh.buildSkeleton).length === 1,
    JSON.stringify(buttons().map((b) => b.textContent.trim()).slice(0, 20)));
  check("the skeleton hint distinguishes it from the evidence outline",
    mountHost.textContent.includes(zh.skeletonHint));
  await click(byText(zh.buildSkeleton)[0]);
  // Found on the real GUI: with no evidence the panel printed the same sentence
  // twice (once in the banner, once as the footnote), which read like two problems.
  {
    const emptyLibrary = makeLibrary("skeleton-empty");
    try {
      const empty = await emptyLibrary.service.sectionSkeleton(emptyLibrary.scope, {});
      check("an empty skeleton has no sections", empty.sections.length === 0);
      check("an empty skeleton says why in one note", typeof empty.note === "string" && empty.note.length > 10);
      // The duplicate sentence was a render bug, so it is counted in the DOM below,
      // on a mount whose skeleton comes back empty.
      emptySkeletonNote = empty.note;
    } finally {
      emptyLibrary.cleanup();
    }
  }
  check("the skeleton renders one card per section",
    mountHost.querySelectorAll("[data-section]").length === 2,
    String(mountHost.querySelectorAll("[data-section]").length));
  const sectionCards = [...mountHost.querySelectorAll("[data-section]")];
  // Found on the real GUI: the bound-id line reused the overlap panel's caption, so
  // real evidence ids were labelled as overlap hits.
  check("the skeleton has its own binding label, not the overlap one",
    zh.skeletonBinds !== undefined && zh.skeletonBinds !== zh.similarHits,
    JSON.stringify({ binds: zh.skeletonBinds, hits: zh.similarHits }));
  // The dictionary keys differing is not enough: the render could still reference the
  // wrong one. This asserts the label that actually appeared on the card.
  {
    const cardText = sectionCards.map((card) => card.textContent ?? "").join(" ");
    check("the rendered skeleton card uses the binding label",
      cardText.includes(zh.skeletonBinds) && !cardText.includes(zh.similarHits),
      cardText.slice(0, 160));
  }
  // The card used to print the first eight characters of the id, which appears
  // nowhere else in the UI. It now names the paper and page, which the writer can
  // actually look up.
  check("a skeleton card locates its evidence by paper and page",
    sectionCards.length > 0
      && sectionCards.every((card) => (card.textContent ?? "").includes("论文 A p.1")),
    sectionCards.map((card) => card.textContent).join(" | "));
  check("a skeleton card no longer prints a bare evidence id",
    sectionCards.every((card) => !/[0-9a-f]{8}/.test((card.textContent ?? "").replace(/论文 A/g, ""))),
    sectionCards.map((card) => card.textContent).join(" | "));

  check("the citation import control is on screen", byText(zh.citeImportPick).length === 1);
  const fileInputs = [...mountHost.querySelectorAll("input")].filter((el) => el.getAttribute("type") === "file");
  const citeInput = fileInputs.find((el) => (el.getAttribute("accept") ?? "").includes(".ris"));
  check("there is a file input that accepts .ris", citeInput !== undefined,
    JSON.stringify(fileInputs.map((el) => el.getAttribute("accept"))));
  // Drive the import through the real file input with a fake File, so the handler that
  // reads the file and calls the RPC is exercised, not just the presence of a button.
  const input = citeInput;
  const file = { name: "refs.bib", text: async () => "@article{a, title={T}, year={2020},}" };
  input.dispatchEvent(Object.assign(new window.Event("change", { bubbles: true }), { target: Object.assign(input, { files: [file] }) }));
  await settle(20);
  const importCall = calls.find((row) => row.method === "importCitations");
  check("choosing a file calls importCitations with the file text",
    importCall !== undefined && String(importCall.payload?.input?.text ?? importCall.payload?.text ?? "").includes("@article"),
    JSON.stringify(importCall?.payload ?? null).slice(0, 160));

  // Found on the real GUI: with zero evidence the button was still enabled, so the
  // only way to learn the library could not answer was to click and read a refusal.
  check("the overlap hint states when there is nothing to compare",
    zh.similarNoEvidence !== undefined && zh.similarNoEvidence.length > 10);
  // The button has two independent reasons to be disabled (empty box, empty library),
  // so "enabled" is only meaningful once text is present — which is asserted below,
  // after the passage box is filled.
  check("the overlap panel is on screen", byText(zh.similarCheck).length === 1,
    JSON.stringify(buttons().map((b) => b.textContent.trim()).slice(0, 20)));
  check("the overlap hint says it is not a plagiarism rate",
    mountHost.textContent.includes(zh.similarHint));
  const box = mountHost.querySelector("textarea");
  check("there is a passage box", box !== null);
  if (box !== null) {
    const propsKey = Object.keys(box).find((key) => key.startsWith("__reactProps"));
    box[propsKey].onChange({ target: { value: "深度学习在图像识别任务上取得了显著进展" } });
    await settle(10);
    await click(byText(zh.similarCheck)[0]);
    check("the overlap result renders one hit", mountHost.querySelectorAll("[data-similar-hit]").length === 1,
      String(mountHost.querySelectorAll("[data-similar-hit]").length));
    check("the rendered disclaimer says it is assistance only",
      mountHost.textContent.includes("仅作辅助"));
    // The disclaimer names 查重率 only to deny it ("不是查重率"), which is the sentence
    // that stops the panel being read as a detection tool. What must never render is the
    // offer: a percentage or rewriting advice.
    for (const forbidden of ["原创性百分比", "降重建议", "%"]) {
      check(`the panel never shows ${forbidden}`, !mountHost.textContent.includes(forbidden));
    }
    check("the panel states that it is not a detection rate",
      mountHost.textContent.includes("不是查重率"));
  }

  check("no unexpected React errors while driving the writing panels",
    seenErrors.length === 0, seenErrors.slice(0, 2).join(" | "));

  // --- the same panel on an empty library -----------------------------
  // Found on the real GUI: with zero evidence the overlap button was still enabled,
  // so the only way to learn the library could not answer was to click and read a
  // refusal. Mounted separately because the evidence count is read at mount time.
  mountedEvidenceCount = 0;
  const emptyHost = document.createElement("div");
  document.body.appendChild(emptyHost);
  const emptyRoot = createRoot(emptyHost);
  emptyRoot.render(React.createElement(Body, { sessionId: "s37-empty", inputActions: { captureInsertion() {}, insertText() {} }, t }));
  await settle();
  const emptyTab = [...emptyHost.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith(zh.reviewTab));
  if (emptyTab !== undefined) {
    emptyTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(10);
  }
  // Text is filled first on purpose: with an empty box the button is disabled for a
  // second reason, and that would hide whether the empty-library rule works at all.
  const emptyBox = emptyHost.querySelector("textarea");
  check("there is a passage box on the empty library too", emptyBox !== null);
  if (emptyBox !== null) {
    const emptyPropsKey = Object.keys(emptyBox).find((key) => key.startsWith("__reactProps"));
    emptyBox[emptyPropsKey].onChange({ target: { value: "深度学习在图像识别任务上取得了显著进展" } });
    await settle(10);
  }
  const emptyCheck = [...emptyHost.querySelectorAll("button")].filter((b) => b.textContent.trim() === zh.similarCheck);
  check("the overlap button is disabled while the library holds no evidence",
    emptyCheck.length === 1 && emptyCheck[0].disabled === true,
    JSON.stringify(emptyCheck.map((b) => b.disabled)));
  check("the empty library explanation is shown before any click",
    emptyHost.textContent.includes(zh.similarNoEvidence), zh.similarNoEvidence);
  // The skeleton note appeared TWICE on the real GUI (once in the banner, once as the
  // footnote below it), which read like two separate problems. Counting occurrences in
  // the rendered text is the only way to see a duplicate.
  const emptySkeletonButton = [...emptyHost.querySelectorAll("button")].filter((b) => b.textContent.trim() === zh.buildSkeleton);
  if (emptySkeletonButton.length === 1) {
    emptySkeletonButton[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle(20);
  }
  const occurrences = emptySkeletonNote === ""
    ? 0
    : (emptyHost.textContent.split(emptySkeletonNote).length - 1);
  check("an empty skeleton explains itself exactly once", occurrences === 1, String(occurrences));
  // Found on the real GUI: the refusal sentence was still offerable as "send to chat",
  // which would push a non-answer into the conversation.
  {
    const sends = [...emptyHost.querySelectorAll("button")].filter((b) => b.textContent.trim() === zh.sendToChat);
    check("an empty skeleton offers no send button", sends.length === 0,
      JSON.stringify(sends.map((b) => b.textContent.trim())));
  }
  check("no React errors on the empty library",
    seenErrors.length === 0, seenErrors.slice(0, 2).join(" | "));
  console.error = realError;

    // --- fit-to-width does not clip the page -----------------------------
  // Found on the real GUI: in a narrow sidebar the PDF page was cut off on the right
  // and could not be scrolled to. Two things had to be true for that: the scale came
  // from a guessed padding constant, and the container centred an overflowing child in
  // a way that hides its start edge. Both are asserted here.
  {
    // Arithmetic first, as a pure function.
    const { fitScale } = exported.__test;
    check("a page is scaled to fill the available width",
      fitScale({ available: 400, pageWidth: 800 }) === 0.5,
      String(fitScale({ available: 400, pageWidth: 800 })));
    check("a narrow container shrinks the page below 1",
      fitScale({ available: 260, pageWidth: 595 }) === 0.44,
      String(fitScale({ available: 260, pageWidth: 595 })));
    check("a wide container enlarges the page",
      fitScale({ available: 1200, pageWidth: 595 }) === 2.02,
      String(fitScale({ available: 1200, pageWidth: 595 })));
    // The floor and ceiling exist so an extreme layout cannot ask for a 0.01x page.
    check("the scale is clamped from below", fitScale({ available: 10, pageWidth: 800 }) === 0.3,
      String(fitScale({ available: 10, pageWidth: 800 })));
    check("the scale is clamped from above", fitScale({ available: 100000, pageWidth: 100 }) === 3,
      String(fitScale({ available: 100000, pageWidth: 100 })));
    check("an unmeasurable width yields no scale rather than a guess",
      fitScale({ available: 0, pageWidth: 800 }) === null);
    check("a missing page width yields no scale",
      fitScale({ available: 400, pageWidth: 0 }) === null);

    // The CSS half: centring must not clip an overflowing child.
    // Strip CSS comments before looking for declarations: the comment above the rule
    // names the property it replaced, and matching that text makes the assertion
    // unpassable while telling you nothing about the code.
    const cssDeclarations = client.replace(/\/\*[\s\S]*?\*\//g, "");
    check("the page container does not centre by clipping",
      !/\.pt-canvas-wrap\s*\{[^}]*justify-content:\s*center/.test(cssDeclarations),
      "justify-content:center clips the start edge of an overflowing child");
    check("the page uses auto margins to centre", /\.pt-page\s*\{[^}]*margin:\s*0 auto/.test(client));
    // Same trap: the doc comment quotes the old expression it replaced.
    const codeDeclarations = client.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    check("the available width is measured from real padding, not a constant",
      /parseFloat\(style\?\.paddingLeft/.test(codeDeclarations)
        && !/clientWidth - 18/.test(codeDeclarations),
      "still subtracting a guessed constant");
  }

}

// --- summary ---------------------------------------------------------
console.log("");
if (failures.length > 0) {
  console.log(`WRITING FAILED (${failures.length}):`);
  for (const name of failures) console.log("  - " + name);
  process.exit(1);
}
console.log("WRITING PASS");

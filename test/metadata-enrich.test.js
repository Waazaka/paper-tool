import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCrossrefWork, planEnrichment, lookupDoi } from "../lib/metadata-enrich.js";

// A trimmed real Crossref /works/{doi} payload (Emerald, IJCHM).
const SAMPLE = {
  message: {
    DOI: "10.1108/IJCHM-07-2020-0656",
    title: ["Hotel servicescape and customer citizenship behaviour"],
    author: [
      { family: "Wei", given: "Min" },
      { family: "Li", given: "Shuhao" },
    ],
    issued: { "date-parts": [[2020]] },
    "published-print": { "date-parts": [[2021]] },
    "container-title": ["International Journal of Contemporary Hospitality Management"],
    type: "journal-article",
    publisher: "Emerald",
  },
};

test("parseCrossrefWork reads the authoritative record", () => {
  const r = parseCrossrefWork(SAMPLE);
  assert.equal(r.title, "Hotel servicescape and customer citizenship behaviour");
  assert.equal(r.authors, "Wei, Min; Li, Shuhao");
  // published-print wins over issued: a bibliography cites the version of record.
  assert.equal(r.year, "2021");
  assert.equal(r.venue, "International Journal of Contemporary Hospitality Management");
  assert.equal(r.doi, "10.1108/IJCHM-07-2020-0656");
});

test("parseCrossrefWork tolerates publisher shape drift", () => {
  // Some publishers send a bare string instead of an array, and omit dates.
  const r = parseCrossrefWork({
    message: { DOI: "10.1/x", title: "Bare Title", "container-title": "Bare Venue" },
  });
  assert.equal(r.title, "Bare Title");
  assert.equal(r.venue, "Bare Venue");
  assert.equal(r.year, "");
  assert.equal(r.authors, "");
});

test("parseCrossrefWork returns null for a shapeless payload", () => {
  assert.equal(parseCrossrefWork(null), null);
  assert.equal(parseCrossrefWork({}), null);
  assert.equal(parseCrossrefWork({ message: "nope" }), null);
});

test("planEnrichment fills empty guesses and records provenance", () => {
  const paper = { title: "Hotel servicescape and customer", authors: "", year: "2013", venue: "", metadataSource: JSON.stringify({ title: "page-text", year: "page-text" }) };
  const record = {
    title: "Hotel servicescape and customer citizenship behaviour",
    authors: "Wei, Min; Li, Shuhao",
    year: "2021",
    venue: "International Journal of Hospitality Management",
  };
  const plan = planEnrichment(paper, record);
  assert.deepEqual(plan.filled.sort(), ["authors", "title", "venue", "year"].sort());
  assert.equal(plan.changes.authors, "Wei, Min; Li, Shuhao");
  assert.equal(plan.changes.title, "Hotel servicescape and customer citizenship behaviour");
});

test("planEnrichment never overwrites a field the user typed", () => {
  // updatePaper deletes a user-edited field from metadataSource, so an absent key
  // plus a non-empty value in a row that HAS provenance IS a user edit.
  const paper = {
    title: "My hand-corrected title",
    authors: "Me, Myself",
    year: "",
    venue: "",
    metadataSource: JSON.stringify({ year: "page-text" }),
  };
  const record = {
    title: "Crossref title",
    authors: "Someone, Else",
    year: "2021",
    venue: "A Journal",
  };
  const plan = planEnrichment(paper, record);
  assert.deepEqual(plan.kept.sort(), ["authors", "title"].sort());
  assert.equal(plan.changes.title, undefined, "user title must not be overwritten");
  assert.equal(plan.changes.authors, undefined, "user authors must not be overwritten");
  // Empty fields are still filled.
  assert.equal(plan.changes.venue, "A Journal");
  assert.equal(plan.changes.year, "2021");
});

test("planEnrichment overwrites a guess in a row with no provenance at all", () => {
  // Legacy rows imported before provenance existed have metadataSource = "{}" and
  // no verification stamp. Treating those as user edits would freeze every bad
  // guess forever — the exact defect this module was written to fix.
  const paper = {
    title: "Hotel servicescape and customer",
    authors: "",
    year: "2013",
    venue: "",
    metadataSource: "{}",
    metadataVerifiedAt: "",
  };
  const record = {
    title: "Hotel servicescape and customer citizenship behaviors",
    authors: "Li, Shuhao; Wei, Min",
    year: "2021",
    venue: "International Journal of Contemporary Hospitality Management",
  };
  const plan = planEnrichment(paper, record);
  assert.equal(plan.kept.length, 0, "a bare {} must not be read as user intent");
  assert.equal(plan.changes.title, record.title);
  assert.equal(plan.changes.authors, record.authors);
  assert.equal(plan.changes.venue, record.venue);
  assert.deepEqual(plan.unknownProvenance.sort(), ["title", "year"].sort(), "the override is reported, not silent");
});

test("planEnrichment still protects a row that was stamped verified", () => {
  // A non-empty metadataVerifiedAt is the signal that values were confirmed. Even
  // with an empty metadataSource, such a row must be left alone.
  const paper = {
    title: "Confirmed Title",
    authors: "Confirmed, Author",
    year: "2020",
    venue: "",
    metadataSource: "{}",
    metadataVerifiedAt: "2026-11-02T00:00:00.000Z",
  };
  const plan = planEnrichment(paper, {
    title: "Crossref Title",
    authors: "Other, Person",
    year: "2021",
    venue: "A Journal",
  });
  assert.deepEqual(plan.kept.sort(), ["authors", "title", "year"].sort());
  assert.equal(plan.changes.title, undefined);
  assert.equal(plan.changes.venue, "A Journal", "empty fields are still fillable");
});

test("planEnrichment refuses an obviously worse title", () => {
  const paper = { title: "A Good Long Title About Things", authors: "", year: "", venue: "", metadataSource: JSON.stringify({ title: "layout" }) };
  const plan = planEnrichment(paper, { title: "Short", authors: "X, Y", year: "", venue: "" });
  assert.deepEqual(plan.unchanged, ["title"]);
  assert.equal(plan.changes.title, undefined);
});

test("planEnrichment reports no change when values already match", () => {
  const paper = {
    title: "Same Title Here",
    authors: "A, B",
    year: "2021",
    venue: "V",
    metadataSource: JSON.stringify({ title: "crossref", authors: "crossref", year: "crossref", venue: "crossref" }),
  };
  const plan = planEnrichment(paper, { title: "Same Title Here", authors: "A, B", year: "2021", venue: "V" });
  assert.deepEqual(plan.changes, {});
  assert.equal(plan.filled.length, 0);
});

test("lookupDoi refuses an empty DOI without touching the network", async () => {
  const r = await lookupDoi("");
  assert.equal(r.ok, false);
  assert.match(r.reason, /no DOI/);
});

test("lookupDoi degrades to a reason instead of throwing when offline", async () => {
  // A bogus host is not needed: an unreachable endpoint is simulated by aborting.
  const controller = new AbortController();
  controller.abort();
  const r = await lookupDoi("10.1108/IJCHM-07-2020-0656", { signal: controller.signal });
  assert.equal(r.ok, false);
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason.length > 0);
});

test("lookupDoi strips a doi.org URL prefix", async () => {
  const controller = new AbortController();
  controller.abort();
  // Sends the request (aborted immediately) — proves the prefix did not make it
  // bail out early as "no DOI".
  const r = await lookupDoi("https://doi.org/10.1108/IJCHM-07-2020-0656", { signal: controller.signal });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.reason, /no DOI/);
});

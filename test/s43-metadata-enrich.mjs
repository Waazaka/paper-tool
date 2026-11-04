// Gate: DOI enrichment — Crossref parsing, the merge rules, and the network contract.
//
// This module had no test at all. It is the path behind "补全元数据" in the panel, and it
// carries a promise the rest of the tool depends on: a field the user typed is never
// overwritten by a machine record. Nothing verified that promise, and nothing verified
// the opposite half of it either — that a library imported before provenance existed
// (`metadataSource = "{}"`, no stamp) must NOT be frozen in place forever, which is the
// exact bug the module was written to fix.
//
// Everything here runs offline. `lookupDoi` is exercised through a stubbed global fetch,
// so the real code path is covered — URL, headers, status handling, JSON parse — without
// touching the network, and the test cannot pass or fail depending on whether Crossref
// is reachable today.
import { parseCrossrefWork, planEnrichment, enrichPapers, lookupDoi, ENRICHABLE } from "../lib/metadata-enrich.js";

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else { console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail)); failures.push(name); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, "got " + a + " want " + e);
}

// --- parseCrossrefWork: the shapes publishers actually send ------------
{
  // Crossref wraps the record in `message` and is inconsistent about arrays.
  const record = parseCrossrefWork({
    message: {
      DOI: "https://doi.org/10.1234/ABC.def",
      title: ["A Study of Things"],
      "container-title": ["Journal of Things"],
      author: [
        { family: "Wei", given: "Min" },
        { family: "Solo" },
        { given: "OnlyGiven" },
        { family: "", given: "" },
      ],
      "published-print": { "date-parts": [[2019, 3]] },
      issued: { "date-parts": [[2021, 7]] },
      type: "journal-article",
      publisher: "Things Press",
    },
  });
  eq("title comes out of an array", record.title, "A Study of Things");
  eq("venue comes out of an array", record.venue, "Journal of Things");
  eq("authors are family-first and joined", record.authors, "Wei, Min; Solo; OnlyGiven");
  eq("the DOI is stripped to its bare form", record.doi, "10.1234/ABC.def");
  // published-print is the version of record; issued is the online-first date.
  eq("the print year wins over the online-first year", record.year, "2019");

  const bare = parseCrossrefWork({
    message: { DOI: "10.1/x", title: "Bare String Title", "container-title": "Bare Venue", issued: { "date-parts": [[2020]] } },
  });
  eq("a bare string title is accepted", bare.title, "Bare String Title");
  eq("a bare string venue is accepted", bare.venue, "Bare Venue");
  eq("the year falls back to issued", bare.year, "2020");
  eq("no authors is an empty string, not undefined", bare.authors, "");
  eq("a record with no author field still parses", parseCrossrefWork({ message: { title: ["T"] } }).authors, "");

  check("a payload with no message is rejected", parseCrossrefWork({}) === null);
  check("a null message is rejected", parseCrossrefWork({ message: null }) === null);
  check("a garbage payload is rejected", parseCrossrefWork(null) === null);
  check("the enrichable field list is exactly title/authors/year/venue",
    JSON.stringify(ENRICHABLE) === JSON.stringify(["title", "authors", "year", "venue"]), JSON.stringify(ENRICHABLE));
}

// --- planEnrichment: which fields may be written -----------------------
{
  const record = { title: "Authoritative Title", authors: "Doe, Jane", year: "2020", venue: "Real Journal" };

  // An empty field is always fillable.
  {
    const plan = planEnrichment({ title: "", metadataSource: "{}", metadataVerifiedAt: "" }, record);
    eq("an empty field is filled", plan.changes, { title: "Authoritative Title", authors: "Doe, Jane", year: "2020", venue: "Real Journal" });
    eq("filled fields are reported", plan.filled.sort(), ["authors", "title", "venue", "year"]);
  }

  // A machine guess is replaceable.
  {
    const plan = planEnrichment(
      { title: "Guessed Title", metadataSource: JSON.stringify({ title: "layout" }), metadataVerifiedAt: "" },
      record,
    );
    eq("a marked guess is replaced", plan.changes.title, "Authoritative Title");
  }

  // THE data-preservation promise: a user-typed field is never overwritten.
  {
    const plan = planEnrichment(
      { title: "My Own Title", metadataSource: "{}", metadataVerifiedAt: "2026-01-01T00:00:00Z" },
      record,
    );
    eq("a verified field is left alone", plan.changes.title, undefined);
    check("a verified field is reported as kept", plan.kept.includes("title"), JSON.stringify(plan.kept));
  }

  // A row that has provenance recorded, and this field is not in it, means the user
  // typed it (store.updatePaper removes user-edited fields from metadataSource).
  {
    const plan = planEnrichment(
      { title: "My Own Title", metadataSource: JSON.stringify({ authors: "layout" }), metadataVerifiedAt: "" },
      record,
    );
    eq("a field absent from recorded provenance is left alone", plan.changes.title, undefined);
    check("it is reported as kept", plan.kept.includes("title"), JSON.stringify(plan.kept));
    // The field that IS a guess still gets replaced.
    eq("another field that is still a guess is replaced", plan.changes.authors, "Doe, Jane");
  }

  // The anti-freeze rule: a pre-provenance library has no stamps and no recorded
  // sources. Treating those as user edits would lock every bad guess in place forever.
  {
    const plan = planEnrichment(
      { title: "Bad Extracted Title", metadataSource: "{}", metadataVerifiedAt: "" },
      record,
    );
    eq("an unprovenanced guess is still replaced", plan.changes.title, "Authoritative Title");
    check("it is flagged as unknown provenance, not silently overwritten",
      plan.unknownProvenance.includes("title"), JSON.stringify(plan.unknownProvenance));
  }

  // A near-empty Crossref title is not an improvement.
  {
    const plan = planEnrichment({ title: "Real Title Here", metadataSource: "{}", metadataVerifiedAt: "" }, { title: "abc" });
    eq("a too-short incoming title does not replace a real one", plan.changes.title, undefined);
    check("the short title is reported as unchanged", plan.unchanged.includes("title"), JSON.stringify(plan.unchanged));
  }

  // Identical values are not a change.
  {
    const plan = planEnrichment({ title: "Same", metadataSource: "{}", metadataVerifiedAt: "" }, { title: "Same" });
    eq("an identical value is not a change", plan.changes, {});
    check("it is reported as unchanged", plan.unchanged.includes("title"), JSON.stringify(plan.unchanged));
  }

  // Empty incoming values never erase anything.
  {
    const plan = planEnrichment({ title: "Keep Me", metadataSource: "{}", metadataVerifiedAt: "" }, { title: "" });
    eq("an empty incoming value is ignored", plan.changes, {});
  }

  // Corrupt provenance JSON must not throw — an unparseable blob means "unknown".
  {
    let threw = null;
    let plan = null;
    try {
      plan = planEnrichment({ title: "T", metadataSource: "{not json", metadataVerifiedAt: "" }, record);
    } catch (error) { threw = error.message; }
    check("corrupt provenance JSON does not throw", threw === null, threw);
    eq("corrupt provenance is treated as unknown, so the guess is replaceable", plan?.changes?.title, "Authoritative Title");
  }

  // fillEmpty:false leaves gaps alone.
  {
    const plan = planEnrichment({ title: "", metadataSource: "{}", metadataVerifiedAt: "" }, record, { fillEmpty: false });
    eq("fillEmpty:false does not fill gaps", plan.changes, {});
  }
}

// --- lookupDoi: the network contract, through a stubbed fetch ----------
const realFetch = globalThis.fetch;
const calls = [];
function stubFetch(handler) {
  calls.length = 0;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
}
try {
  // Success: the URL must be the Crossref works endpoint for the bare DOI.
  {
    stubFetch(() => new Response(JSON.stringify({ message: { DOI: "10.1/ok", title: ["Okay"] } }), { status: 200 }));
    const found = await lookupDoi("https://doi.org/10.1/ok");
    check("a successful lookup returns ok", found.ok === true, JSON.stringify(found));
    eq("the value is parsed", found.record?.title, "Okay");
    check("the request goes to the Crossref works endpoint", calls[0]?.url === "https://api.crossref.org/works/10.1%2Fok", calls[0]?.url);
    check("the DOI was normalised before being sent", !String(calls[0]?.url).includes("doi.org"), calls[0]?.url);
    check("a user agent is sent", String(calls[0]?.init?.headers?.["user-agent"] ?? "").includes("paper-tool"), JSON.stringify(calls[0]?.init?.headers));
  }

  // Not found is not a failure.
  {
    stubFetch(() => new Response("", { status: 404 }));
    const found = await lookupDoi("10.1/missing");
    check("a 404 is reported without ok", found.ok === false);
    check("a 404 says Crossref does not know the DOI", String(found.reason).includes("does not know"), found.reason);
  }

  // A server error IS a failure and keeps its status.
  {
    stubFetch(() => new Response("", { status: 503 }));
    const found = await lookupDoi("10.1/broken");
    check("a 503 is a failure", found.ok === false);
    check("the status is reported", String(found.reason).includes("503"), found.reason);
  }

  // A network exception is not an error the user has to handle.
  {
    stubFetch(() => { throw new Error("getaddrinfo ENOTFOUND"); });
    const found = await lookupDoi("10.1/offline");
    check("a network exception returns ok:false instead of throwing", found.ok === false);
    check("the reason carries the cause", String(found.reason).includes("ENOTFOUND"), found.reason);
  }

  // No DOI at all: never even make a request.
  {
    stubFetch(() => { throw new Error("must not be called"); });
    const found = await lookupDoi("");
    check("a paper with no DOI is refused without a request", found.ok === false && calls.length === 0, "calls=" + calls.length);
  }

  // A 200 with an unusable body must not crash.
  {
    stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    let threw = null;
    let found = null;
    try { found = await lookupDoi("10.1/empty"); } catch (error) { threw = error.message; }
    check("an empty Crossref body does not throw", threw === null, threw);
    check("an empty Crossref body reports no record", found?.ok === false && String(found.reason).includes("no record"), JSON.stringify(found));
  }

  // --- enrichPapers: dedupe, classification, and the write ------------
  {
    const record = { title: "Authoritative", authors: "Doe, Jane", year: "2020", venue: "J" };
    stubFetch((url) => {
      if (String(url).includes("knows-not")) return new Response("", { status: 404 });
      if (String(url).includes("breaks")) return new Response("", { status: 500 });
      return new Response(JSON.stringify({ message: { DOI: "10.1/x", ...record } }), { status: 200 });
    });
    const writes = [];
    const store = {
      updatePaper: (id, patch) => { writes.push({ id, patch }); return { paperId: id, ...patch }; },
    };
    const papers = [
      { paperId: "p1", title: "", doi: "10.1/good", metadataSource: "{}", metadataVerifiedAt: "" },
      { paperId: "p1", title: "", doi: "10.1/good", metadataSource: "{}", metadataVerifiedAt: "" }, // duplicate
      { paperId: "p2", title: "x", doi: "", metadataSource: "{}", metadataVerifiedAt: "" },
      { paperId: "p3", title: "", doi: "10.1/knows-not", metadataSource: "{}", metadataVerifiedAt: "" },
      { paperId: "p4", title: "", doi: "10.1/breaks", metadataSource: "{}", metadataVerifiedAt: "" },
      { paperId: "p5", title: "Authoritative", authors: "Doe, Jane", year: "2020", venue: "J", doi: "10.1/same", metadataSource: "{}", metadataVerifiedAt: "" },
    ];
    const result = await enrichPapers(store, papers);
    const ids = (list) => list.map((entry) => entry.paperId);
    eq("a duplicate is fetched once", ids(result.enriched), ["p1", "p5"]);
    eq("a paper with no DOI is skipped", ids(result.skipped), ["p2", "p3"]);
    eq("an unknown DOI is skipped, not failed", result.skipped.find((e) => e.paperId === "p3")?.reason.includes("does not know"), true);
    eq("a server error is a failure", ids(result.failures), ["p4"]);
    // Exactly one write: p1 had an empty title, p5 already matched the record.
    eq("only the paper that had something to change is written", writes.map((w) => w.id), ["p1"]);
    check("the paper whose fields were empty was written", writes.some((w) => w.id === "p1"), JSON.stringify(writes.map((w) => w.id)));
    check("the paper with nothing to change was not written", !writes.some((w) => w.id === "p5"), JSON.stringify(writes.map((w) => w.id)));
    const p1Write = writes.find((w) => w.id === "p1");
    eq("the write carries the authoritative fields", p1Write?.patch?.title, "Authoritative");
    eq("the write records that these values are not user-verified", p1Write?.patch?.verified, false);
    check("the write does not touch fields outside the enrichable set",
      Object.keys(p1Write?.patch ?? {}).every((key) => key === "verified" || ENRICHABLE.includes(key)),
      JSON.stringify(Object.keys(p1Write?.patch ?? {})));

    // Four lookups for five papers: p2 has no DOI so it never reaches the network, and
    // the duplicate p1 is fetched once.
    eq("a duplicate is not fetched twice", calls.length, 4);
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log("");
if (failures.length > 0) {
  console.log("ENRICH FAILED (" + failures.length + "):");
  for (const name of failures) console.log("  - " + name);
  process.exit(1);
}
console.log("ENRICH PASS");

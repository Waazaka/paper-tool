// External search: more sources, citations carried through, and a merge that does not
// rank by source order (PT-018).
//
// The load-bearing guarantee here is the last one. Before this change the merge simply
// concatenated per-source results and truncated, so whichever source was queried first
// filled the visible list while the UI presented it as relevance-ranked. That is a
// structural bias that looks like a working feature, which is why it needs assertions
// about ordering rather than just about the presence of a `citations` field.
import { readFileSync } from "node:fs";
import { mergeCandidates, parseArxivXml, searchExternal, SOURCES } from "../lib/external-search.js";

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else {
    console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail));
    failures.push(name);
  }
}

const source = readFileSync("lib/external-search.js", "utf8");
const tools = readFileSync("lib/tools.js", "utf8");
const client = readFileSync("client.js", "utf8");
const host = readFileSync("lib/host-service.js", "utf8");

/** A candidate with a known citation count. */
function cited(title, citations, doi = `10.1/${title.toLowerCase()}`) {
  return { title, doi, citations, citationsKnown: true, year: "2020", source: "openalex" };
}
/** A candidate from a source that publishes no counts (arXiv, PubMed). */
function uncited(title) {
  return { title, doi: "", citations: 0, citationsKnown: false, year: "2024", source: "arxiv" };
}
function ok(sourceName, candidates) {
  return { source: sourceName, ok: true, candidates };
}

// --- 1. the source list grew -------------------------------------------
{
  check("SOURCES lists at least five sources", SOURCES.length >= 5, JSON.stringify(SOURCES));
  check("Semantic Scholar is a source", SOURCES.includes("semanticscholar"));
  check("PubMed is a source", SOURCES.includes("pubmed"));
  // Each named source needs its own runner, or it will fail at query time with a
  // "is not a function" error that only appears for users who happen to select it.
  const runnerBlock = source.slice(source.indexOf("const runners = {"), source.indexOf("};", source.indexOf("const runners = {")));
  for (const name of SOURCES) {
    check(`${name} has a runner wired into the source map`, new RegExp(`${name}:\\s*search\\w+`).test(runnerBlock));
  }
  check("a Semantic Scholar runner exists", /async function searchSemanticScholar\(/.test(source));
  check("a PubMed runner exists", /async function searchPubMed\(/.test(source));
  // Semantic Scholar's whole reason for being here is extra citation signal.
  check("the Semantic Scholar runner asks for citationCount",
    /citationCount/.test(source.slice(source.indexOf("searchSemanticScholar"))));
}

// --- 1b. arXiv Atom: the DOI and the PDF link --------------------------
// Both of these parsed to "" on every entry, which a test that only asked "did the entry
// parse" could not see. arXiv does not use Atom's `<doi>` element — it sends the DOI as the
// namespaced `<arxiv:doi>` — so a `<doi>` pattern matched nothing, and every preprint was
// stored DOI-less: a preprint and its published version deduped as two different papers.
//
// The PDF link failed for a different reason: Atom says nothing about attribute order, and
// the live feed sends href first. A pattern requiring `title="pdf"` before `href` never
// matched, so the one source whose job is handing out direct PDF links always arrived
// without one.
//
// The feed text below is the shape export.arxiv.org actually returned on 2026-11-18,
// trimmed to the elements the parser reads.
{
  const entry = (inner) => `<feed xmlns:arxiv="http://arxiv.org/schemas/atom">\n<entry>\n${inner}\n</entry>\n</feed>`;
  const base = `
    <id>http://arxiv.org/abs/1904.08014v1</id>
    <title>Fermions and bosons in nonsymmorphic PdSb2</title>
    <link href="https://arxiv.org/abs/1904.08014v1" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/1904.08014v1" rel="related" type="application/pdf" title="pdf"/>
    <summary>PdSb2 is a candidate.</summary>
    <published>2019-04-16T23:30:23Z</published>
    <author><name>Ramakanta Chapai</name></author>
    <author><name>Rongying Jin</name></author>`;

  const [withDoi] = parseArxivXml(entry(`${base}
    <arxiv:doi>10.1103/PhysRevB.99.161110</arxiv:doi>
    <link rel="related" href="https://doi.org/10.1103/PhysRevB.99.161110" title="doi"/>`), 5);
  check("the namespaced <arxiv:doi> is read", withDoi.doi === "10.1103/PhysRevB.99.161110", withDoi.doi);
  check("the arXiv id is not mistaken for a DOI", !/arxiv\.org/i.test(withDoi.doi), withDoi.doi);
  check("the DOI scheme prefix is stripped", !/^https?:/i.test(withDoi.doi), withDoi.doi);
  // The prefixed element must win over the <link title="doi"> copy of the same value, but
  // the link alone is still a DOI — a feed without the namespace is not "no DOI".
  const [linkOnly] = parseArxivXml(entry(`${base}
    <link rel="related" href="https://doi.org/10.1038/s41467-019-12784-4" title="doi"/>`), 5);
  check("a DOI that only appears as a related link is still read",
    linkOnly.doi === "10.1038/s41467-019-12784-4", linkOnly.doi);
  const [noDoi] = parseArxivXml(entry(`${base}
    <link rel="related" href="https://example.org/elsewhere" title="related"/>`), 5);
  check("an entry without a DOI keeps an empty DOI", noDoi.doi === "", noDoi.doi);

  check("the PDF link is read in the live attribute order (href first)",
    withDoi.pdfUrl === "https://arxiv.org/pdf/1904.08014v1", withDoi.pdfUrl);
  // The other order still has to work: a feed change in either direction must not silently
  // disable the link again.
  const [reordered] = parseArxivXml(entry(`
    <id>http://arxiv.org/abs/1508.05555v2</id>
    <title>New Parities</title>
    <link title="pdf" rel="related" type="application/pdf" href="https://arxiv.org/pdf/1508.05555v2"/>
    <summary>S.</summary>
    <published>2015-08-23T01:45:14Z</published>`), 5);
  check("the PDF link is read when title comes first too",
    reordered.pdfUrl === "https://arxiv.org/pdf/1508.05555v2", reordered.pdfUrl);
  // Every entry carries an abs URL and arXiv serves the PDF at the same path under /pdf/,
  // so a missing link is recoverable rather than a missing PDF.
  const [noLink] = parseArxivXml(entry(`
    <id>http://arxiv.org/abs/1904.00001v1</id>
    <title>No pdf link</title>
    <summary>S.</summary>
    <published>2019-04-16T12:43:38Z</published>
    <arxiv:doi>10.1/x</arxiv:doi>`), 5);
  check("a missing PDF link falls back to the abs URL",
    noLink.pdfUrl === "http://arxiv.org/pdf/1904.00001v1", noLink.pdfUrl);

  // The remaining fields still come through: a fix for the lookup must not break the parse.
  check("the title, authors, year and abstract survive",
    withDoi.title === "Fermions and bosons in nonsymmorphic PdSb2" &&
    withDoi.authors === "Ramakanta Chapai; Rongying Jin" &&
    withDoi.year === "2019" && withDoi.abstract === "PdSb2 is a candidate." &&
    withDoi.url === "http://arxiv.org/abs/1904.08014v1",
    JSON.stringify(withDoi));
  check("the entry limit is still honoured", parseArxivXml(entry(base) + entry(base).replace("1904.08014", "1904.99999"), 1).length === 1);

  // Source-shape assertions: the two broken patterns must not come back.
  const atom = source.slice(source.indexOf("function arxivDoi"), source.indexOf("async function searchArxiv"));
  check("the DOI lookup accepts the arxiv: prefix", /arxiv:/.test(atom));
  check("the PDF lookup parses attributes instead of their order",
    !/title="pdf"\[\^>\]\*href=/.test(source), "order-dependent PDF regex is back");
}

// --- 1c. the same Atom, end to end through searchExternal --------------
// The block above feeds `parseArxivXml` in isolation, so it sees neither the wiring between
// the runner and the parser nor the shape of the live feed. A stub here drives the public
// entry point instead: `searchExternal({ sources: ["arxiv"] })` with `fetch` replaced, on
// the Atom export.arxiv.org returned on 2026-11-18 — every <link> puts `href` before
// `rel`/`title`, and the DOI is the namespaced <arxiv:doi>. Both defects this gate exists
// for lived exactly in that gap.
{
  const entry = (inner) => `<entry>\n${inner}\n  </entry>`;
  // The fields the parser reads, in the live order: href first on both <link> elements.
  const live = entry(`    <id>http://arxiv.org/abs/1904.08014v1</id>
    <title>Fermions and bosons in nonsymmorphic PdSb2 with sixfold degeneracy</title>
    <link href="https://arxiv.org/abs/1904.08014v1" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/1904.08014v1" rel="related" type="application/pdf" title="pdf"/>
    <summary>PdSb2 is a candidate.</summary>
    <published>2019-04-16T23:30:23Z</published>
    <arxiv:doi>10.1103/PhysRevB.99.161110</arxiv:doi>
    <author><name>Ramakanta Chapai</name></author>`);
  // A second entry whose <arxiv:doi> start tag carries an attribute. That is legal Atom, and
  // a DOI pattern anchored on `<arxiv:doi>` exactly would miss it.
  const attributed = entry(`    <id>http://arxiv.org/abs/1508.05555v2</id>
    <title>New Parities, and a DOI element with attributes</title>
    <link href="https://arxiv.org/pdf/1508.05555v2" rel="related" type="application/pdf" title="pdf"/>
    <summary>S.</summary>
    <published>2015-08-23T01:45:14Z</published>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1038/s41467-019-12784-4</arxiv:doi>`);
  const feed = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  ${live}
  ${attributed}
</feed>`;

  // The fixture is the evidence that href-first order is exercised: if someone "tidies" it
  // into the other order, the checks below would pass while testing nothing.
  check("the fixture really puts href before title on the PDF link",
    feed.indexOf('href="https://arxiv.org/pdf/1904.08014v1"') < feed.indexOf('title="pdf"'),
    "fixture drifted away from the live attribute order");

  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(feed, { status: 200 });
  };
  let result = null;
  let threw = null;
  try {
    result = await searchExternal("nonsymmorphic PdSb2", { sources: ["arxiv"], limit: 5 });
  } catch (error) {
    threw = error;
  } finally {
    globalThis.fetch = realFetch;
  }
  check("a stubbed arXiv feed does not throw out of searchExternal", threw === null, threw?.message);
  const candidates = result?.candidates ?? [];
  const byTitle = (needle) => candidates.find((c) => c.title.includes(needle));

  check("searchExternal runs the arXiv runner it was asked for",
    calls.length === 1 && /^https:\/\/export\.arxiv\.org\/api\/query\?search_query=all:/.test(calls[0]?.url),
    JSON.stringify(calls.map((c) => c.url)));
  check("both stubbed entries become candidates", candidates.length === 2, JSON.stringify(candidates.map((c) => c.title)));
  check("the live entry keeps its DOI", byTitle("sixfold degeneracy")?.doi === "10.1103/PhysRevB.99.161110",
    byTitle("sixfold degeneracy")?.doi);
  check("the live entry keeps its PDF URL despite href coming first",
    byTitle("sixfold degeneracy")?.pdfUrl === "https://arxiv.org/pdf/1904.08014v1",
    byTitle("sixfold degeneracy")?.pdfUrl);
  check("an <arxiv:doi> with attributes is still read",
    byTitle("DOI element with attributes")?.doi === "10.1038/s41467-019-12784-4",
    byTitle("DOI element with attributes")?.doi);
  check("a valid feed reports no source failure",
    JSON.stringify(result?.failures) === "[]", JSON.stringify(result?.failures));
}

// --- 2. citations are known-or-unknown, never silently zero ------------
{
  check("OpenAlex marks its citation counts as known",
    /citations:\s*typeof work\.cited_by_count === "number" \? work\.cited_by_count : 0,\s*\n\s*citationsKnown:\s*typeof work\.cited_by_count === "number"/.test(source));
  check("Crossref marks its citation counts as known",
    /citationsKnown:\s*typeof item\["is-referenced-by-count"\] === "number"/.test(source));
  check("arXiv marks its zero as an unknown count, not a real zero",
    /citations: 0,\s*\n\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*citationsKnown: false/.test(source) ||
    /citationsKnown: false/.test(source));
  check("PubMed marks its zero as an unknown count",
    (source.match(/citationsKnown: false/g) ?? []).length >= 2,
    String((source.match(/citationsKnown: false/g) ?? []).length));
  // The tool output must omit the field rather than emit 0 for an unknown count, because
  // "cited by nobody" and "the source does not say" are different facts.
  const toolHit = tools.slice(tools.indexOf("hits: external.candidates.map"), tools.indexOf("failures: external.failures"));
  check("the tool omits citations when the count is unknown",
    /candidate\.citationsKnown === false \? \{\} : \{ citations:/.test(toolHit), toolHit.slice(0, 200));
  check("the tool output schema declares citations", /citations: \{ type: "integer" \}/.test(tools));
}

// --- 3. the tool exposes sources and sort ------------------------------
{
  const params = tools.slice(tools.indexOf('name: "paper_search"'), tools.indexOf("output:", tools.indexOf('name: "paper_search"')));
  check("paper_search accepts a sources parameter", /sources: \{/.test(params));
  check("the sources parameter is constrained to known sources",
    SOURCES.every((name) => new RegExp(`"${name}"`).test(params)));
  check("paper_search accepts a sort parameter", /sort: \{/.test(params));
  check("sort offers relevance, citations and year",
    /"relevance", "citations", "year"/.test(params) || /enum: \["relevance", "citations", "year"\]/.test(params));
  // The host must pass them through, or the schema advertises controls that do nothing.
  const hostCall = host.slice(host.indexOf("async searchExternal("), host.indexOf("async addCandidates("));
  check("the host passes sources through", /sources: Array\.isArray\(input\?\.sources\)/.test(hostCall));
  check("the host passes sort through", /sort: input\?\.sort === "citations"/.test(hostCall));
  // An unknown sort value must fall back rather than reach the merge function.
  check("an unknown sort mode falls back to relevance",
    /input\?\.sort === "citations" \|\| input\?\.sort === "year" \? input\.sort : "relevance"/.test(hostCall));
}

// --- 4. sorting works --------------------------------------------------
{
  const results = [
    ok("openalex", [cited("low", 5), cited("high", 900), cited("mid", 100)]),
  ];
  const byCitations = mergeCandidates(results, { limit: 3, sort: "citations" });
  check("sort=citations returns the most cited first",
    byCitations.map((c) => c.title).join(",") === "high,mid,low",
    byCitations.map((c) => c.title).join(","));
  check("sort=citations is monotonically non-increasing",
    byCitations.every((c, i) => i === 0 || (byCitations[i - 1].citations ?? 0) >= (c.citations ?? 0)),
    JSON.stringify(byCitations.map((c) => c.citations)));

  const byYear = mergeCandidates([ok("openalex", [
    { ...cited("old", 1), year: "2001" },
    { ...cited("new", 1), year: "2023" },
  ])], { limit: 2, sort: "year" });
  check("sort=year returns the newest first", byYear.map((c) => c.title).join(",") === "new,old",
    byYear.map((c) => c.title).join(","));

  const byRelevance = mergeCandidates([ok("openalex", [cited("first", 1), cited("second", 999)])], { limit: 2 });
  check("the default sort leaves the source's own order alone",
    byRelevance.map((c) => c.title).join(",") === "first,second",
    byRelevance.map((c) => c.title).join(","));
}

// --- 5. the merge does not rank by source order ------------------------
{
  const a = ok("openalex", [cited("A1", 400), cited("A2", 200)]);
  const b = ok("crossref", [cited("B1", 10), cited("B2", 5)]);
  const forward = mergeCandidates([a, b], { limit: 4 });
  const reversed = mergeCandidates([b, a], { limit: 4 });
  check("swapping the query order does not change the result order",
    forward.map((c) => c.title).join(",") === reversed.map((c) => c.title).join(","),
    `${forward.map((c) => c.title).join(",")} vs ${reversed.map((c) => c.title).join(",")}`);

  // And every source must get representation before any gets a second slot: that is the
  // whole point of the quota. Without it the first source fills the list.
  const firstTwo = forward.slice(0, 2).map((c) => c.title);
  check("each source contributes before any source contributes twice",
    new Set(firstTwo.map((t) => t[0])).size === 2, JSON.stringify(firstTwo));
  check("the visible list is not just the first source",
    forward.slice(0, 3).some((c) => c.title.startsWith("B")),
    forward.map((c) => c.title).join(","));
}

// --- 6. uncounted sources are neither buried nor promoted -------------
{
  const counted = ok("openalex", [cited("cited300", 300), cited("cited10", 10)]);
  const uncounted = ok("arxiv", [uncited("preprint1"), uncited("preprint2")]);
  const merged = mergeCandidates([counted, uncounted], { limit: 4, sort: "citations" });
  const titles = merged.map((c) => c.title);
  check("preprints are still present under a citation sort",
    titles.includes("preprint1") && titles.includes("preprint2"), JSON.stringify(titles));
  // They must not outrank a genuinely highly-cited paper: 300 real citations beats an
  // unknown count, otherwise "no data" silently wins.
  check("uncounted results do not outrank counted ones under sort=citations",
    titles.indexOf("cited300") < titles.indexOf("preprint1"), JSON.stringify(titles));
  check("both preprints are kept even when the counted source has fewer results",
    merged.filter((c) => c.title.startsWith("preprint")).length === 2, JSON.stringify(titles));
  // Relevance sort must interleave them normally — the demotion is specific to citations.
  const byRelevance = mergeCandidates([counted, uncounted], { limit: 4 });
  check("under relevance the uncounted source is interleaved, not demoted",
    byRelevance.slice(0, 2).some((c) => c.title.startsWith("preprint")),
    byRelevance.map((c) => c.title).join(","));
}

// --- 7. one failing source does not fail the batch --------------------
{
  const merged = mergeCandidates([
    { source: "openalex", ok: false, reason: "HTTP 429", candidates: [] },
    ok("crossref", [cited("survivor", 3)]),
  ], { limit: 5 });
  check("a failed source contributes nothing but does not throw",
    merged.map((c) => c.title).join(",") === "survivor", merged.map((c) => c.title).join(","));
  // Failure reporting lives in searchExternal, not the merge; assert the shape there.
  const fn = source.slice(source.indexOf("export async function searchExternal"), source.indexOf("function orderWithinSource"));
  check("per-source failures are collected with a reason",
    /failures\.push\(\{ source, reason: result\.reason \}\)/.test(fn));
  check("a failing source does not abort the loop",
    !/break|return \{ query/.test(fn.slice(fn.indexOf("for (const source of wanted)"), fn.indexOf("const merged"))));
}

// --- 8. deduplication survives the rewrite ---------------------------
{
  const merged = mergeCandidates([
    ok("openalex", [cited("Same Paper", 10, "10.1/same")]),
    ok("crossref", [cited("Same Paper", 10, "10.1/same")]),
  ], { limit: 5 });
  check("the same DOI from two sources appears once", merged.length === 1,
    String(merged.length));
  const byTitle = mergeCandidates([
    ok("openalex", [{ ...cited("Title Only"), doi: "" }]),
    ok("crossref", [{ ...cited("Title  only!"), doi: "" }]),
  ], { limit: 5 });
  check("the same title with different punctuation appears once", byTitle.length === 1,
    String(byTitle.length));
}

// --- 9. the UI shows the count and the sort control -------------------
{
  check("the candidate row renders a citation count",
    /citationCount", \{ n: candidate\.citations \}/.test(client));
  // An unknown count must render nothing at all, not "0 引用".
  check("an unknown count renders no number",
    /candidate\.citations === undefined \|\| candidate\.citations === null/.test(client));
  check("there is a sort control", /sortMode/.test(client));
  check("the sort control is limited to external search",
    /mode === "external"\s*\n?\s*\? h\("select"/.test(client));
  check("the chosen sort is sent with the search",
    /callRemote\(sessionId, "searchExternal", \{ query, limit: 10, sort: sortMode \}/.test(client));
  check("sortMode is a dependency of the search callback",
    /\[sessionId, query, mode, sortMode, t, runCancellable\]/.test(client));
}

// --- 10. still six tools (D-013/D-014) --------------------------------
{
  const names = [...tools.matchAll(/name: "(paper_\w+)"/g)].map((m) => m[1]);
  check("still exactly six tools", names.length === 6, JSON.stringify(names));
  check("no paper_cite/download tool was added", !names.includes("paper_cite") && !names.includes("paper_download"));
}

if (failures.length > 0) {
  console.log("\nEXTERNAL-SOURCES FAILED (" + failures.length + "):");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
console.log("\nEXTERNAL-SOURCES PASS");

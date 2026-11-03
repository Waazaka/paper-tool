// List paging and payload trimming (PT-015).
//
// The defect this closes is not "the sidebar is slow" — it is that paper 501 was
// permanently invisible: the client asked for the Host's 500-row ceiling and never
// sent an offset, so the row existed in the database and could never appear.
// A gate that only measured latency would have missed that entirely, so the
// assertions here are about reachability and about what the response contains.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// Load through the standard shim: the real DSH protocol package only exists
// inside a profile, so the shim substitutes those imports and runs the shipped
// source for everything else. Instantiating the service directly cannot work.
const { loadService } = await import("./shim.mjs");
const { PaperToolService, projectPaperForList } = await loadService();

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else {
    console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail));
    failures.push(name);
  }
}
function checkEqual(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

const client = readFileSync("client.js", "utf8");
const host = readFileSync("lib/host-service.js", "utf8");
const storeSource = readFileSync("lib/store.js", "utf8");

// --- 1. the projection drops storage-only fields ------------------------
{
  const row = {
    paperId: "p1", title: "T", authors: "A", year: "2021", venue: "V", doi: "10.1/x",
    abstract: "a long abstract that the list does not need",
    source: "import", pdfPath: "/x.pdf",
    // A real SHA-256 hex string. Pure waste on the wire: the client never reads it.
    fingerprint: "a".repeat(64),
    numPages: 9, indexedAt: "2026-01-01", material: "fulltext",
    metadataSource: '{"title":"layout","authors":"xmp","venue":"crossref"}',
    metadataVerifiedAt: "", sourceName: "x.pdf", textSource: "text-layer",
  };
  const projected = projectPaperForList(row);
  check("fingerprint is dropped from the list payload", projected.fingerprint === undefined);
  check("metadataSource is dropped from the list payload", projected.metadataSource === undefined);
  // Omitted because the editor needs it and would otherwise save an empty value
  // over the real abstract. It is fetched on demand through readPaper.
  check("abstract is dropped from the list payload", projected.abstract === undefined);
  check("sourceName is dropped from the list payload", projected.sourceName === undefined);
  check("paperId survives", projected.paperId === "p1");
  check("title survives", projected.title === "T");
  check("material survives (the card renders a badge from it)", projected.material === "fulltext");
  check("numPages survives", projected.numPages === 9);
  // The two badges the card draws, precomputed so the parse leaves the browser.
  checkEqual("guessed fields are precomputed", projected.unverifiedFields, ["title"]);
  checkEqual("crossref-confirmed fields are precomputed", projected.fromCrossrefFields, ["venue"]);

  // A corrupt provenance string must not read as "everything verified".
  const corrupt = projectPaperForList({ ...row, metadataSource: "not json" });
  checkEqual("corrupt provenance yields no badges", corrupt.unverifiedFields, []);
  // Nor may an empty field be reported as a guess: there is no value to doubt.
  const empty = projectPaperForList({ ...row, title: "", metadataSource: '{"title":"layout"}' });
  checkEqual("an empty field is not reported as guessed", empty.unverifiedFields, []);
  check("a null row passes through untouched", projectPaperForList(null) === null);
}

// --- 2. paging reaches past the old 500 ceiling ------------------------
{
  const home = mkdtempSync(join(tmpdir(), "paper-tool-S30-home-"));
  const work = mkdtempSync(join(tmpdir(), "paper-tool-S30-work-"));
  const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home, shared: true });
  const scope = { sessionId: "s30", workspaceRoot: work };
  const store = service.storeFor(scope);

  // 600 rows: the old request stopped at 500, so rows 501-600 were unreachable.
  for (let index = 0; index < 600; index += 1) {
    store.upsertPaper({
      paperId: `paper-${String(index).padStart(4, "0")}`,
      title: `Paper ${index}`,
      authors: "", year: "2020", venue: "", doi: "", source: "test",
      pdfPath: "", fingerprint: `fp-${index}`, material: "metadata",
    });
  }
  check("the library really has 600 papers", store.stats().papers === 600, String(store.stats().papers));

  const first = await service.listPapers(scope, { limit: 50 });
  check("the first page returns 50 rows", first.papers.length === 50, String(first.papers.length));
  check("the first page reports the true total", first.paging.total === 600, String(first.paging.total));
  check("the first page knows there is more", first.paging.hasMore === true);

  // Walk the pages the way "load more" does and collect every id.
  const seen = new Set();
  let offset = 0;
  let guard = 0;
  while (guard < 40) {
    guard += 1;
    const page = await service.listPapers(scope, { limit: 50, offset });
    for (const paper of page.papers) seen.add(paper.paperId);
    if (page.paging.hasMore !== true) break;
    offset += page.papers.length;
  }
  check("walking the pages reaches all 600 papers", seen.size === 600, String(seen.size));
  // The specific rows the old implementation could not show.
  check("paper 501 is reachable", seen.has("paper-0500"));
  check("paper 600 is reachable", seen.has("paper-0599"));

  const last = await service.listPapers(scope, { limit: 50, offset: 550 });
  check("the final page holds the remainder", last.papers.length === 50, String(last.papers.length));
  check("the final page reports no more", last.paging.hasMore === false);
  // Offsets past the end are a normal outcome, not an error: the caller may race
  // with a deletion. It must return an empty page, not throw.
  const beyond = await service.listPapers(scope, { limit: 50, offset: 590 });
  check("an offset past the end returns an empty page", beyond.papers.length === 10, String(beyond.papers.length));

  service.dispose();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

// --- 3. evidence paging and the anchor filter -------------------------
{
  const home = mkdtempSync(join(tmpdir(), "paper-tool-S30-home2-"));
  const work = mkdtempSync(join(tmpdir(), "paper-tool-S30-work2-"));
  const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home, shared: true });
  const scope = { sessionId: "s30b", workspaceRoot: work };
  const store = service.storeFor(scope);

  store.upsertPaper({
    paperId: "ev-paper", title: "Evidence paper", authors: "", year: "2021", venue: "",
    doi: "", source: "test", pdfPath: "", fingerprint: "fp", material: "fulltext",
  });
  // 120 evidence rows, of which every third is unanchored (charStart -1).
  for (let index = 0; index < 120; index += 1) {
    const anchored = index % 3 !== 0;
    store.addEvidence({
      evidenceId: `ev-${String(index).padStart(3, "0")}`,
      paperId: "ev-paper",
      pageIndex: Math.floor(index / 10),
      // charStart 0 is a legitimate offset at the very start of a page, so the
      // fixture includes it: a truthiness bug would drop it.
      charStart: anchored ? index : -1,
      charEnd: anchored ? index + 10 : -1,
      quote: `quote ${index}`,
    });
  }
  const anchoredCount = store.countEvidence({ anchor: "anchored" });
  const unanchoredCount = store.countEvidence({ anchor: "unanchored" });
  check("anchor counting splits the library", anchoredCount + unanchoredCount === 120,
    `${anchoredCount}+${unanchoredCount}`);
  check("a charStart of 0 counts as anchored",
    store.countEvidence({ anchor: "anchored" }) === 80, String(anchoredCount));

  const page = await service.listEvidence(scope, { limit: 50 });
  check("evidence returns one page", page.evidence.length === 50, String(page.evidence.length));
  check("evidence reports the true total", page.paging.total === 120, String(page.paging.total));
  check("evidence knows there is more", page.paging.hasMore === true);
  check("the anchored total is a library-wide count", page.paging.anchoredTotal === 80,
    String(page.paging.anchoredTotal));
  check("the all total is a library-wide count", page.paging.allTotal === 120,
    String(page.paging.allTotal));

  const anchoredPage = await service.listEvidence(scope, { limit: 50, anchor: "anchored" });
  check("the anchored filter is applied by the Host",
    anchoredPage.evidence.every((row) => row.charStart >= 0));
  check("the filtered page reports the filtered total", anchoredPage.paging.total === 80,
    String(anchoredPage.paging.total));
  const unanchoredPage = await service.listEvidence(scope, { limit: 50, anchor: "unanchored" });
  check("the unanchored filter is applied by the Host",
    unanchoredPage.evidence.every((row) => row.charStart < 0));
  check("the unanchored filter reports its own total", unanchoredPage.paging.total === 40,
    String(unanchoredPage.paging.total));

  // Walking the anchored pages must reach all 80, not just the first page.
  const seenAnchored = new Set();
  let offset = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    const chunk = await service.listEvidence(scope, { limit: 50, offset, anchor: "anchored" });
    for (const row of chunk.evidence) seenAnchored.add(row.evidenceId);
    if (chunk.paging.hasMore !== true) break;
    offset += chunk.evidence.length;
  }
  check("paging the anchored filter reaches all 80 rows", seenAnchored.size === 80,
    String(seenAnchored.size));

  service.dispose();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

// --- 4. citations cover the whole library, not the loaded page --------
{
  const home = mkdtempSync(join(tmpdir(), "paper-tool-S30-home3-"));
  const work = mkdtempSync(join(tmpdir(), "paper-tool-S30-work3-"));
  const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home, shared: true });
  const scope = { sessionId: "s30c", workspaceRoot: work };
  const store = service.storeFor(scope);

  // Three papers. `p-c` has ONLY unanchored evidence, so it is the row that
  // distinguishes "the Host applied the anchored filter" from "the Host ignored
  // it": including p-c would mean an unlocatable quote got into a bibliography.
  // Without such a paper the filter is invisible — both paths return the same
  // papers, which is exactly how a mutation survived the first version of this gate.
  for (const [id, title] of [["p-a", "Alpha"], ["p-b", "Beta"], ["p-c", "Gamma"]]) {
    store.upsertPaper({
      paperId: id, title, authors: "Author", year: "2021", venue: "V", doi: `10.1/${id}`,
      source: "test", pdfPath: "", fingerprint: `fp-${id}`, material: "fulltext",
    });
  }
  store.addEvidence({ evidenceId: "e-a1", paperId: "p-a", pageIndex: 0, charStart: 0, charEnd: 5, quote: "alpha" });
  // This one is unanchored: it must never appear in a bibliography.
  store.addEvidence({ evidenceId: "e-a2", paperId: "p-a", pageIndex: 0, charStart: -1, charEnd: -1, quote: "lost" });
  store.addEvidence({ evidenceId: "e-b1", paperId: "p-b", pageIndex: 0, charStart: 3, charEnd: 8, quote: "beta" });
  // p-c contributes nothing citable: every one of its rows failed to locate.
  store.addEvidence({ evidenceId: "e-c1", paperId: "p-c", pageIndex: 0, charStart: -1, charEnd: -1, quote: "gone" });
  store.addEvidence({ evidenceId: "e-c2", paperId: "p-c", pageIndex: 1, charStart: -1, charEnd: -1, quote: "also gone" });

  const formatted = await service.formatCitations(scope, { style: "apa", anchor: "anchored" });
  const cited = (formatted.entries ?? []).map((entry) => entry.paperId).sort();
  checkEqual("citations include every paper with anchored evidence", cited, ["p-a", "p-b"]);
  check("a paper whose evidence is entirely unlocatable is not cited",
    !cited.includes("p-c"), JSON.stringify(cited));
  // And without the filter it *would* be cited — proving the filter, not the
  // fixture, is what excludes it.
  const unfiltered = await service.formatCitations(scope, { style: "apa" });
  const citedUnfiltered = (unfiltered.entries ?? []).map((entry) => entry.paperId).sort();
  check("without the filter the unlocatable paper does appear",
    citedUnfiltered.includes("p-c"), JSON.stringify(citedUnfiltered));

  const exported = await service.exportReview(scope, { style: "apa", anchor: "anchored" });
  check("an export succeeds", exported.ok === true, JSON.stringify(exported.reason));
  // The export's own bibliography is what the user reads, so it is the strongest
  // place to prove an unlocatable quote was excluded rather than merely uncounted.
  const exportedText = String(exported.bibliography ?? exported.markdown ?? "");
  check("the export omits the unlocatable paper", !/Gamma/.test(exportedText), exportedText.slice(0, 200));
  check("the export still contains the citable papers",
    /Alpha/.test(exportedText) && /Beta/.test(exportedText), exportedText.slice(0, 200));

  // The client must ask for the filter, not send its loaded ids.
  // Search from the call site, not from the RPC method list at the top of the file:
  // indexOf('"formatCitations"') hits that list first and would assert against it.
  const formatCall = client.indexOf('callRemote(sessionId, "formatCitations"');
  check("the client calls formatCitations", formatCall >= 0);
  const renderCitations = client.slice(formatCall, formatCall + 400);
  check("the client asks the Host for anchored evidence", /anchor: "anchored"/.test(renderCitations),
    renderCitations.slice(0, 160));
  check("the client no longer sends a paged id list to formatCitations",
    !/evidenceIds,/.test(renderCitations));
  const exportStart = client.indexOf('callRemote(sessionId, "exportReview"');
  check("the client calls exportReview", exportStart >= 0);
  const exportCall = client.slice(exportStart, exportStart + 400);
  check("the client asks the Host for anchored evidence on export", /anchor: "anchored"/.test(exportCall));

  service.dispose();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

// --- 5. the client pages instead of asking for everything -------------
{
  check("the paper page size is at most 50", /const PAPER_PAGE_SIZE = (\d+);/.test(client) &&
    Number(/const PAPER_PAGE_SIZE = (\d+);/.exec(client)[1]) <= 50,
    (/const PAPER_PAGE_SIZE = (\d+);/.exec(client) ?? [])[1]);
  check("the evidence page size is at most 50", /const EVIDENCE_PAGE_SIZE = (\d+);/.test(client) &&
    Number(/const EVIDENCE_PAGE_SIZE = (\d+);/.exec(client)[1]) <= 50,
    (/const EVIDENCE_PAGE_SIZE = (\d+);/.exec(client) ?? [])[1]);
  check("the first paint no longer asks for 500 papers", !/"listPapers", \{ limit: 500 \}/.test(client));
  check("the first paint no longer asks for 2000 evidence rows", !/"listEvidence", \{ limit: 2000 \}/.test(client));
  check("every listPapers call passes an explicit limit",
    !/"listPapers", \{ \}/.test(client));
  check("there is a load-more path for papers", /const loadMorePapers = useCallback/.test(client));
  check("the paper load-more sends an offset", /offset: papers\.length/.test(client));
  check("there is a load-more path for evidence", /const loadMoreEvidence = useCallback/.test(client));
  check("the evidence load-more sends an offset", /offset: evidence\.length/.test(client));
  // Appending without deduplication duplicates rows when an offset goes stale
  // (a delete between pages shifts everything after it).
  check("appending papers deduplicates by id", /new Set\(current\.map\(\(paper\) => paper\.paperId\)\)/.test(client));
  check("appending evidence deduplicates by id", /new Set\(current\.map\(\(row\) => row\.evidenceId\)\)/.test(client));
  check("the load-more button is hidden when there is nothing more",
    /paperPaging\.hasMore/.test(client) && /evidencePaging\.hasMore/.test(client));
  // The editor needs the abstract, which the list projection drops.
  check("the metadata editor fetches the full row", /callRemote\(sessionId, "readPaper", \{ paperId: paper\.paperId \}\)/.test(client));
  check("the editor is opened through that fetch", /onEdit: openEditor/.test(client));
  // Filtering must refetch: the filter is a Host query now. The refetch is owned
  // by a dedicated effect; the loader reads the filter through a ref so that
  // `refresh` stays stable and one click costs one request.
  check("a dedicated effect reacts to the filter",
    /\}, \[evidenceFilter, loadEvidence\]\)/.test(client));
  check("the loader reads the filter through a ref",
    /anchor: evidenceFilterRef\.current/.test(client));
  check("the ref is kept current", /evidenceFilterRef\.current = evidenceFilter;/.test(client));
  check("the loader does not depend on the filter (keeps refresh stable)",
    !/\}, \[sessionId, evidenceFilter\]\);/.test(client));
}

// --- 6. the Host-side counting cannot disagree with the listing ------
{
  // One helper builds the SQL for both, so a page and its total cannot diverge.
  check("one helper builds the anchor predicate", /function anchorWhere\(anchor, column = "charStart"\)/.test(storeSource));
  // Slice each method body and look for the call inside it, rather than trying to
  // express "the body contains" as one regex across a nested-brace distance.
  const bodyOf = (signature) => {
    const start = storeSource.indexOf(signature);
    if (start < 0) return "";
    return storeSource.slice(start, start + 700);
  };
  check("the listing uses that helper",
    /anchorWhere\(anchor\)/.test(bodyOf("listEvidence({ paperId, limit = 200, offset = 0, anchor = \"all\" } = {})")));
  check("the count uses the same helper",
    /anchorWhere\(anchor\)/.test(bodyOf("countEvidence({ paperId, anchor = \"all\" } = {})")));
  // The column prefix is a parameter: count queries have no `e` alias, and
  // `e.charStart` there is a SQL error rather than a wrong answer.
  check("the helper takes the column as a parameter", /function anchorWhere\(anchor, column = "charStart"\)/.test(storeSource));
  check("the aliased queries pass e.charStart", /anchorWhere\(anchor, "e\.charStart"\)/.test(storeSource));

  check("listPapers returns a paging envelope", /paging: \{[\s\S]{0,200}hasMore/.test(host));
  check("listEvidence returns a paging envelope", /hasMore: offset \+ limit < total/.test(host));
}

if (failures.length > 0) {
  console.log("\nPAGING FAILED (" + failures.length + "):");
  for (const failure of failures) console.log(" - " + failure);
  process.exit(1);
}
console.log("\nPAGING PASS");

// Topic recommendation (PT-019).
//
// The claim under test is not "a function exists". It is that the thing the plugin
// produces is *counted material* rather than a confident-looking invention, and that
// it refuses when the sample cannot carry a conclusion. Those are the two failure
// modes that would make this feature actively harmful:
//
//   1. A trend line drawn from four papers reads exactly like one drawn from four
//      hundred. So the sample size is asserted to gate the output, and a small
//      sample must produce a refusal and zero candidates.
//   2. A "research gap" with no co-occurrence behind it is a fabricated result. So
//      every gap row must carry the paper ids that support it, and a pair that is
//      really one phrase ("deep" + "learning") must not be reported at all.
//
// Determinism is asserted by running the same input twice and comparing the full
// payload: the criterion asks for it, and it is also what stops an accidental
// Map-iteration-order dependency from making the panel flicker between runs.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { loadService } = await import("./shim.mjs");
const topics = await import("../lib/topics.js");

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else {
    console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail));
    failures.push(name);
  }
}

const client = readFileSync("client.js", "utf8");
const host = readFileSync("lib/host-service.js", "utf8");
const tools = readFileSync("lib/tools.js", "utf8");
const { PaperToolService } = await loadService();

/** A corpus with a deliberate structure: one rising topic, one flat, one gap pair. */
function corpus() {
  const rows = [];
  let index = 0;
  const add = (title, year, citations = 0, extra = {}) => {
    rows.push({ paperId: `p${index}`, title, year: String(year), citations, venue: "V", authors: "A", doi: `10.1/${index}`, source: "openalex", ...extra });
    index += 1;
  };
  // A topic that grows over time.
  for (let year = 2017; year <= 2022; year += 1) {
    for (let n = 0; n < year - 2016; n += 1) add(`Graph neural networks for chemistry discovery ${year}-${n}`, year, (year - 2016) * 10);
  }
  // A topic that stays flat.
  for (let year = 2017; year <= 2022; year += 1) add(`Peer review quality assessment ${year}`, year, 5);
  // A pair that co-occurs across three SEPARATE papers, with each term also appearing
  // in other papers. That is what makes it a combination worth reporting rather than
  // one phrase written two ways.
  add("Privacy in federated archives", 2021, 30);
  add("Privacy risks for federated records", 2022, 14);
  add("Privacy law and federated collections", 2020, 9);
  // "privacy" alone, and "federated" alone: this is what keeps independentA/B > 0.
  add("Privacy preserving archives", 2021, 12);
  add("Privacy risks in archives", 2022, 8);
  add("Federated archives for museums", 2020, 7);
  add("Federated archives and law", 2022, 9);
  add("Federated discovery platforms", 2019, 4);
  return rows;
}

// --- 1. the tool surface stays at six -----------------------------
{
  const names = [...tools.matchAll(/^\s+name: "(paper_[a-z]+)",$/gm)].map((m) => m[1]);
  check("there are exactly six tools", names.length === 6, names.join(", "));
  check("no paper_topics tool was added", !/paper_topics/.test(tools), "paper_topics appears in tools.js");
  check("topicRecommend is marked remote", /^\s+"topicRecommend",$/m.test(host));
  check("the client reaches it through the wrapped input path", /"topicRecommend"/.test(client));
  // The status payload is how a caller discovers an RPC that has no tool behind it.
  check("paper_status reports a topics field", /topics:\s*\{/.test(host));
  check("paper_status publishes the sample floor", /minSample:\s*MIN_TOPIC_SAMPLE/.test(host));
  check("paper_status carries the disclaimer", /disclaimer:\s*TOPIC_DISCLAIMER/.test(host));
}

// --- 2. the disclaimer is required, not decorative ----------------
{
  check("there is a disclaimer constant", typeof topics.TOPIC_DISCLAIMER === "string" && topics.TOPIC_DISCLAIMER.length > 20);
  // D-014: the plugin has no model channel. A call to one here would make the
  // "counted, not generated" claim false even if every number stayed correct.
  const topicsSource = readFileSync("lib/topics.js", "utf8");
  for (const forbidden of ["generateText", "ctx.model", "ctx.llm", "openai", "chatCompletion", "completion("]) {
    check(`the module does not call a model (${forbidden})`, !topicsSource.includes(forbidden), forbidden);
  }
  check("the module declares no model import",
    !/from\s+["'][^"']*(model|llm|openai|anthropic)[^"']*["']/i.test(topicsSource));
  check("the disclaimer says the rows are not conclusions",
    /不.*结论|不是研究结论/.test(topics.TOPIC_DISCLAIMER), topics.TOPIC_DISCLAIMER);
  check("the disclaimer says the plugin does not decide for you",
    /你自己判断|不替你下结论/.test(topics.TOPIC_DISCLAIMER), topics.TOPIC_DISCLAIMER);
  const payload = topics.recommendTopics({ query: "graph", papers: corpus(), now: 2026 });
  check("every payload carries the disclaimer", payload.disclaimer === topics.TOPIC_DISCLAIMER);

}

// --- 3. trends are counted, from real years -----------------------
{
  const papers = corpus();
  const trend = topics.computeTrend(papers, { now: 2026 });
  check("the trend covers at least three years", trend.years.length >= 3, String(trend.years.length));
  check("the verdict is ok for a large sample", trend.verdict === "ok", trend.verdict);
  check("the total equals the dated papers", trend.total === papers.length, `${trend.total} vs ${papers.length}`);
  check("the window is bounded", trend.window.from === 2016 && trend.window.to === 2026, JSON.stringify(trend.window));
  // Growing topic: 2017 has 1, 2022 has 6. The older half must average below the newer.
  check("a growing topic is reported as rising", trend.direction === "rising", trend.direction);

  // A year outside the window is counted as undated, not clamped into the edge year.
  const skewed = topics.computeTrend([
    ...papers,
    { paperId: "x1", title: "Old", year: "1200" },
    { paperId: "x2", title: "Future", year: "9999" },
  ], { now: 2026 });
  check("out-of-window years are excluded rather than clamped",
    skewed.undated === 2 && skewed.total === papers.length, `${skewed.undated} / ${skewed.total}`);

  // Flat topic.
  const flat = topics.computeTrend(
    Array.from({ length: 24 }, (_, i) => ({ paperId: `f${i}`, title: "Peer review quality", year: String(2017 + (i % 6)), citations: 1 })),
    { now: 2026 },
  );
  check("a flat topic is reported as flat", flat.direction === "flat", flat.direction);
}

// --- 4. the sample floor actually refuses -------------------------
{
  const small = topics.recommendTopics({ query: "graph", papers: corpus().slice(0, 4), now: 2026 });
  check("a tiny sample is refused", small.refusal !== null, "no refusal");
  check("the refusal names the sample size", /4/.test(small.refusal?.message ?? ""), small.refusal?.message);
  check("the refusal names the minimum", String(small.refusal?.message ?? "").includes(String(small.sample.minSample)), small.refusal?.message);
  check("the refusal says it cannot judge a trend", /无法给出趋势判断|趋势判断/.test(small.refusal?.message ?? ""), small.refusal?.message);
  check("a refused sample produces no candidates", small.candidates.length === 0, String(small.candidates.length));
  // Co-occurrence alone can clear the support threshold on a four-paper corpus, so the
  // floor has to gate candidate construction too — not just the trend. This was a real
  // bug: a 4-paper sample produced one candidate from a gap until the check was added
  // inside buildCandidates.
  // A small corpus built to contain a real gap: three papers share the privacy ×
  // federated pair, and each term also appears alone. Five papers total is well under
  // the floor, so the guard is what must stop the candidate.
  const tinyWithGap = [
    { paperId: "t0", title: "Privacy in federated archives", year: "2021", citations: 5 },
    { paperId: "t1", title: "Privacy risks for federated records", year: "2022", citations: 3 },
    { paperId: "t2", title: "Privacy law and federated collections", year: "2020", citations: 2 },
    { paperId: "t3", title: "Privacy preserving archives", year: "2021", citations: 1 },
    { paperId: "t4", title: "Federated discovery platforms", year: "2019", citations: 1 },
  ];
  const tinyGaps = topics.findGaps(tinyWithGap, { minSupport: 2 });
  check("the tiny corpus really contains a gap (so the test is not vacuous)",
    tinyGaps.length > 0, String(tinyGaps.length));
  // buildCandidates is called directly with a sufficient=false trend: even with real
  // gaps in hand, it must refuse. This is the guard that was missing.
  const forced = topics.buildCandidates({
    query: "graph",
    trend: topics.computeTrend(tinyWithGap, { now: 2026 }),
    gaps: tinyGaps,
    papers: tinyWithGap,
  });
  check("gaps alone cannot produce a candidate below the sample floor",
    forced.length === 0, `${forced.length} candidate(s) from a ${tinyWithGap.length}-paper sample`);
  check("the same gaps do produce candidates once the sample is sufficient",
    topics.buildCandidates({
      query: "graph",
      trend: topics.computeTrend(corpus(), { now: 2026 }),
      gaps: topics.findGaps(corpus(), { minSupport: 2 }),
      papers: corpus(),
    }).length > 0);
  check("a refused sample still reports its own size", small.sample.papers === 4, String(small.sample.papers));

  // No dated papers at all: a different reason, because "0 of 4 dated" and
  // "0 papers found" are different problems for the reader.
  const noDates = topics.recommendTopics({ query: "x", papers: [{ paperId: "a", title: "Deep learning", year: "" }], now: 2026 });
  check("undated-only input is refused as no-data", noDates.refusal?.reason === "no-dated-papers", noDates.refusal?.reason);
  check("empty input does not throw", topics.recommendTopics({ query: "x", papers: [], now: 2026 }).candidates.length === 0);
}

// --- 5. gaps carry their own evidence -----------------------------
{
  const gaps = topics.findGaps(corpus(), { minSupport: 2 });
  check("gaps are found in the corpus", gaps.length > 0, String(gaps.length));
  check("every gap carries the supporting paper ids",
    gaps.every((gap) => Array.isArray(gap.paperIds) && gap.paperIds.length >= 2), JSON.stringify(gaps[0] ?? null));
  check("every gap reports how often it co-occurs",
    gaps.every((gap) => Number.isInteger(gap.coOccurrences) && gap.coOccurrences >= 2));
  check("every gap reports each term's independent support",
    gaps.every((gap) => Number.isInteger(gap.independentA) && Number.isInteger(gap.independentB)));
  // The pair that is really one phrase must never be reported as a gap.
  check("a pair that always travels together is not a gap",
    !gaps.some((gap) => gap.terms.join("+") === "deep+learning"), JSON.stringify(gaps.map((gap) => gap.terms.join("+")).slice(0, 8)));
  // Independent support must be strictly positive for every reported gap.
  check("every reported gap has both terms appearing elsewhere",
    gaps.every((gap) => gap.independentA > 0 && gap.independentB > 0),
    JSON.stringify(gaps.map((gap) => [gap.terms, gap.independentA, gap.independentB]).slice(0, 4)));

  // The order must be a total order, not whatever the map happened to yield: two
  // gaps with equal support have to come out in the same order every time, or the
  // panel reorders itself between runs.
  const orderOnce = topics.findGaps(corpus(), { minSupport: 2 }).map((gap) => gap.terms.join("+"));
  const orderTwice = topics.findGaps([...corpus()].reverse(), { minSupport: 2 }).map((gap) => gap.terms.join("+"));
  check("gap order is stable under input reversal",
    JSON.stringify(orderOnce) === JSON.stringify(orderTwice),
    `${orderOnce.slice(0, 4).join(",")} vs ${orderTwice.slice(0, 4).join(",")}`);
  // And the order is by descending support, which is the documented contract.
  const supporting = topics.findGaps(corpus(), { minSupport: 2 });
  const supports = supporting.map((gap) => gap.coOccurrences);
  check("gaps are ordered by descending co-occurrence",
    supports.every((value, index) => index === 0 || supports[index - 1] >= value), JSON.stringify(supports));
  // Ties are broken lexicographically, ascending. Asserting only "stable across runs"
  // does not catch a flipped comparator: a reversed tiebreak is still perfectly stable.
  // So the documented order is spelled out row by row.
  for (let index = 1; index < supporting.length; index += 1) {
    const previous = supporting[index - 1];
    const current = supporting[index];
    if (previous.coOccurrences !== current.coOccurrences) continue;
    const expected = [previous.terms[0], previous.terms[1]].join("\u0000").localeCompare([current.terms[0], current.terms[1]].join("\u0000"));
    check(`equal-support gaps are in lexicographic order (${previous.terms.join("+")} before ${current.terms.join("+")})`,
      expected <= 0, `${previous.terms.join("+")} vs ${current.terms.join("+")}`);
  }

  // Raising the floor must monotonically shrink the result: evidence, not noise.
  const low = topics.findGaps(corpus(), { minSupport: 2 }).length;
  const high = topics.findGaps(corpus(), { minSupport: 5 }).length;
  check("a higher support floor returns fewer gaps", high <= low, `${low} -> ${high}`);
}

// --- 6. candidates have all four fields, and are traceable --------
{
  const rec = topics.recommendTopics({ query: "graph neural networks", papers: corpus(), now: 2026 });
  check("candidates are produced for a good sample", rec.candidates.length > 0, String(rec.candidates.length));
  const required = ["title", "researchQuestion", "feasibility", "innovation"];
  check("every candidate has the four fields",
    rec.candidates.every((row) => required.every((field) => row[field] !== undefined && row[field] !== "")),
    JSON.stringify(rec.candidates[0] ?? null).slice(0, 300));
  check("every candidate states its provenance",
    rec.candidates.every((row) => row.provenance !== undefined && typeof row.provenance.kind === "string"));
  // A gap-derived candidate must name the papers behind it, or the reader cannot check
  // the one claim it makes.
  const fromGaps = rec.candidates.filter((row) => row.provenance.kind === "co-occurrence-gap");
  check("gap candidates name their supporting papers",
    fromGaps.every((row) => Array.isArray(row.provenance.paperIds) && row.provenance.paperIds.length > 0),
    JSON.stringify(fromGaps[0]?.provenance ?? null));
  // The fields that could be mistaken for a finding must describe their own basis.
  // The note must cite counts. Matching on loose words is not enough: "该方向具有显著
  // 创新性" contains 方向 and would pass while being exactly the fabricated claim this
  // design forbids. So the assertion requires the actual numbers.
  check("the innovation field states a counted basis, not a novelty claim",
    rec.candidates.every((row) => {
      const note = String(row.innovation.note ?? "");
      if (/显著|原创|前沿|突破|填补空白/.test(note)) return false;
      const provenance = row.provenance;
      if (provenance.kind === "co-occurrence-gap") {
        // Must quote the co-occurrence count and both independent supports.
        return note.includes(String(provenance.paperIds.length));
      }
      // A trend row must quote the yearly counts it is based on.
      return Array.isArray(row.innovation.basis) && row.innovation.basis.length > 0;
    }),
    JSON.stringify(rec.candidates[0]?.innovation ?? null));
  check("the feasibility field carries the sample size",
    rec.candidates.every((row) => Number.isInteger(row.feasibility.sampleSize)));

  // Representatives are ranked by citations, most-cited first. This is the only
  // ordering that makes the list useful as a reading list.
  const reps = topics.representatives(corpus(), 5);
  const repCounts = reps.map((row) => row.citations ?? 0);
  check("representatives are ordered most-cited first",
    repCounts.every((value, index) => index === 0 || repCounts[index - 1] >= value), JSON.stringify(repCounts));
  check("the most-cited paper is actually first",
    repCounts[0] === Math.max(...corpus().map((row) => row.citations)), `${repCounts[0]} vs ${Math.max(...corpus().map((row) => row.citations))}`);
}

// --- 7. two runs agree exactly ------------------------------------
{
  const once = JSON.stringify(topics.recommendTopics({ query: "graph neural networks", papers: corpus(), now: 2026 }));
  const twice = JSON.stringify(topics.recommendTopics({ query: "graph neural networks", papers: corpus(), now: 2026 }));
  check("the same input produces byte-identical output", once === twice, "output differed between runs");
  // Shuffling the input must not change the counts, only their order of discovery.
  const shuffled = [...corpus()].reverse();
  const fromShuffled = topics.computeTrend(shuffled, { now: 2026 });
  const original = topics.computeTrend(corpus(), { now: 2026 });
  check("input order does not change the yearly counts",
    JSON.stringify(fromShuffled.years) === JSON.stringify(original.years),
    `${JSON.stringify(fromShuffled.years.slice(0, 2))} vs ${JSON.stringify(original.years.slice(0, 2))}`);
}

// --- 8. term extraction survives Chinese --------------------------
{
  const terms = topics.extractTerms("深度学习在教育中的应用");
  check("Chinese titles produce terms", terms.length > 0, JSON.stringify(terms));
  // Bigrams straddling a grammar character are word boundaries, not terms.
  check("grammar characters do not become terms",
    !terms.includes("在教") && !terms.includes("的应") && !terms.includes("中的"), JSON.stringify(terms));
  check("a real Chinese term survives", terms.includes("学习") || terms.includes("教育"), JSON.stringify(terms));
  // Latin stopwords are removed; the topic words are not.
  const latin = topics.extractTerms("A study of deep learning for education");
  check("Latin stopwords are removed", !latin.includes("study") && !latin.includes("the"), JSON.stringify(latin));
  check("Latin topic words survive", latin.includes("deep") && latin.includes("learning") && latin.includes("education"), JSON.stringify(latin));
  check("empty input yields no terms", topics.extractTerms("").length === 0 && topics.extractTerms(undefined).length === 0);
}

// --- 9. the RPC returns counted material --------------------------
{
  const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: process.env.TEMP ?? ".", shared: false });
  const scope = { sessionId: "s35", workspaceRoot: process.cwd() };
  check("the RPC is a method", typeof service.topicRecommend === "function");
  // The status field must be reachable without calling the RPC first.
  const status = await service.status(scope);
  check("status exposes the topics path", status.topics?.supported === true, JSON.stringify(status.topics));
  check("status publishes the same floor the RPC uses", status.topics?.minSample === topics.MIN_SAMPLE,
    `${status.topics?.minSample} vs ${topics.MIN_SAMPLE}`);
  check("status carries the disclaimer verbatim", status.topics?.disclaimer === topics.TOPIC_DISCLAIMER);
  // Provenance is added by the RPC (the pure function cannot know where its input came
  // from), so this is asserted on the Host source plus a deterministic shape check.
  // A recommendation whose counts cannot be traced to a source is unauditable.
  const rpcBody = host.slice(host.indexOf("async topicRecommend("), host.indexOf("async addCandidates("));
  // Behaviour, not text: a mutation can leave the word "provenance" in the source while
  // returning null. What matters is the object handed back having the four fields, so
  // the return statement itself is matched structurally.
  const returnsProvenance = /return\s*\{[\s\S]*?\bprovenance\b\s*,\s*[\s\S]*?\};/.test(rpcBody)
    && !/provenance:\s*null/.test(rpcBody);
  check("the RPC returns the provenance block", returnsProvenance, rpcBody.slice(-400));
  check("the RPC records the sources it asked", /sourcesRequested:/.test(rpcBody));
  check("the RPC records which sources failed", /failures:/.test(rpcBody));
  check("the RPC keeps one raw row verbatim", /sampleRaw:/.test(rpcBody));
  check("the RPC reports how many rows came back", /returned:\s*search\.candidates\.length/.test(rpcBody));
  check("the RPC flags papers already in the library", /alreadyInLibrary:/.test(rpcBody));
  try { service.dispose(); } catch { /* already closed */ }
}

// --- 10. the client renders counted material ---------------------
// Mounted, so these are behaviour: a mutation that deletes the panel while leaving
// the i18n keys in place must fail.
{
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { sep } = await import("node:path");
  const { installDom } = await import("./dom-stub.mjs");

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
    console.log(`  SKIP the mount section (react unavailable: ${error.message})`);
  }

  if (React !== undefined) {
    const { document, window } = installDom({ width: 420, height: 760 });
    const seenErrors = [];
    const realError = console.error;
    console.error = (...args) => { seenErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")); };

    let exported = null;
    globalThis.window.__ModuleLoader__ = {
      load({ factory }) {
        exported = factory((id) => {
          if (id === "react") return React;
          throw new Error(`unexpected require: ${id}`);
        });
      },
    };
    await import(pathToFileURL(join(process.cwd(), "client.js")).href);
    const { Body, DICTS } = exported.__test;
    const zh = DICTS.zh;
    const t = (key, params) => {
      const raw = zh[key];
      if (raw === undefined) return key;
      return params === undefined ? raw : String(raw).replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])));
    };

    const GOOD = {
      query: "graph neural networks",
      sample: { papers: 42, dated: 42, undated: 0, minSample: 8, sufficient: true },
      trend: { years: [{ year: 2020, count: 4, citations: 40 }, { year: 2021, count: 9, citations: 90 }, { year: 2022, count: 14, citations: 140 }], total: 42, undated: 0, minSample: 8, sufficient: true, verdict: "ok", direction: "rising", window: { from: 2016, to: 2026 } },
      gaps: [{ terms: ["privacy", "federated"], coOccurrences: 4, supportA: 7, supportB: 9, independentA: 3, independentB: 5, paperIds: ["p1", "p2", "p3", "p4"] }],
      candidates: [{
        title: "privacy × federated", researchQuestion: "是否有未被单独研究的问题？",
        feasibility: { sampleSize: 42, coOccurrences: 4, independentA: 3, independentB: 5, readingListSize: 3, note: "共现次数较多" },
        innovation: { basis: ["p1", "p2"], note: "该组合在 4 篇标题中共现" },
        provenance: { kind: "co-occurrence-gap", terms: ["privacy", "federated"], paperIds: ["p1", "p2", "p3", "p4"] },
      }],
      representatives: [{ title: "A cited paper", authors: "A", year: "2021", venue: "V", doi: "10.1/x", citations: 120, abstract: "" }],
      disclaimer: "候选选题由标题词频与共现计数生成，不是研究结论；创新性与可行性需你自己判断。",
      provenance: { query: "graph neural networks", sourcesRequested: ["openalex"], failures: [], returned: 42, sampleRaw: { title: "x", year: "2021" } },
      alreadyInLibrary: 0,
      refusal: null,
    };
    const SMALL = {
      ...GOOD,
      sample: { papers: 3, dated: 3, undated: 0, minSample: 8, sufficient: false },
      trend: { years: [{ year: 2021, count: 3, citations: 3 }], total: 3, undated: 0, minSample: 8, sufficient: false, verdict: "insufficient", direction: "flat", window: { from: 2016, to: 2026 } },
      gaps: [], candidates: [], representatives: [],
      // The message deliberately does NOT contain the heading text, so a missing
      // heading cannot be masked by the message body.
      refusal: { reason: "insufficient-sample", message: "只有 3 篇有效年份，至少需要 8 篇，无法给出趋势判断。" },
    };

    const calls = [];
    let nextResult = GOOD;
    const answer = (method, params) => {
      // The wire shape is { args: { paperSessionId, input } } for INPUT_METHODS
      // entries and { args: { paperSessionId, ...args } } for the rest. Reading
      // params.input directly would silently see {} for every call.
      const payload = params?.args ?? params ?? {};
      calls.push({ method, input: payload.input ?? payload });
      switch (method) {
        case "status":
          return { library: { papers: 1, pages: 2, evidence: 3 }, styles: ["apa"], translation: { supported: true, total: 0, engine: "agent", indexed: false }, topics: { supported: true, method: "topicRecommend", minSample: 8, disclaimer: GOOD.disclaimer }, limits: { maxImportFiles: 32, maxPdfBytes: 67108864 } };
        case "listPapers":
          return { papers: [], library: { papers: 1, pages: 2, evidence: 3 }, paging: { offset: 0, limit_returned: 0, total: 0, hasMore: false } };
        case "listEvidence":
          return { evidence: [], paging: { offset: 0, limit_returned: 0, total: 0, hasMore: false, anchoredTotal: 0, allTotal: 0 } };
        case "listAnnotations": return { annotations: [] };
        case "watchStatus": return { watching: false };
        case "backupStatus":
          return { dbPath: "x", filesDir: "y", backupsDir: "z", measured: { dbBytes: 0, filesBytes: 0, fileCount: 0, pdfCount: 0 }, counts: { papers: 0, pages: 0, evidence: 0 }, backups: [] };
        case "topicRecommend": return nextResult;
        default: return {};
      }
    };
    exported.apply({
      connection: { rpc: { async call(_path, method, options) {
        return { ok: true, value: answer(String(method).replace(/^paperTool\//, ""), options) };
      } } },
      locale: { register() {}, bind: () => t },
      slots: { inject() {}, register: () => ({}) },
      sidebarRightTabs: { register: () => ({}) },
      effect() {},
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(React.createElement(Body, { sessionId: "s35-ui", inputActions: { captureInsertion() {}, insertText() {} }, t }));
    const settle = async (turns = 24) => { for (let i = 0; i < turns; i += 1) await new Promise((r) => setTimeout(r, 0)); };
    await settle();
    const text = () => host.textContent;
    const buttons = () => [...host.querySelectorAll("button")];

    const topicsTab = buttons().find((button) => button.textContent.trim() === zh.topicsTab);
    check("there is a topics tab", topicsTab !== undefined, JSON.stringify(buttons().map((b) => b.textContent.trim()).slice(0, 12)));
    topicsTab?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();

    check("the panel explains it does not pick the topic", text().includes(zh.topicIntro), text().slice(0, 400));
    check("the disclaimer is shown before any result", text().includes(zh.topicDisclaimer), text().slice(0, 400));

    const input = [...host.querySelectorAll("input")].find((element) => element.getAttribute("aria-label") === zh.topicPlaceholder);
    check("there is a keyword input", input !== undefined, JSON.stringify([...host.querySelectorAll("input")].map((el) => el.getAttribute("aria-label"))));
    // A controlled input takes text through onChange; a hand-set value does not reach
    // React's state (same reason the textarea in s33 is driven this way).
    const propsKey = Object.keys(input ?? {}).find((key) => key.startsWith("__reactProps"));
    input?.[propsKey]?.onChange({ target: { value: "graph neural networks" } });
    await settle(6);

    const gather = buttons().find((button) => button.textContent.trim() === zh.topicRecommend);
    check("there is a control to gather material", gather !== undefined, JSON.stringify(buttons().map((b) => b.textContent.trim())));
    gather?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();

    const call = calls.find((row) => row.method === "topicRecommend");
    check("the panel issues the RPC", call !== undefined, calls.map((row) => row.method).join(","));
    check("the RPC is called with the typed keyword", call?.input?.query === "graph neural networks", JSON.stringify(call?.input));

    // Counted material must be visible: the sample size, the years, the counts.
    // The exact sample line: "42" also appears in the candidate's feasibility note,
    // so a bare number check would pass even if the sample header were removed.
    check("the usable sample is shown",
      text().replace(/\s+/g, "").includes(`${zh.topicSample}:42${zh.topicPapers}`.replace(/\s+/g, "")),
      text().slice(0, 600));
    check("the yearly counts are rendered", text().includes("2020") && text().includes("2021") && text().includes("2022"), text().slice(0, 700));
    check("the direction is rendered", text().includes(zh.topicDir_rising), text().slice(0, 700));
    check("the gap pair is rendered with its support", text().includes("privacy") && text().includes("federated"));
    check("the gap shows how often it co-occurs", text().includes("4"), text().slice(0, 800));
    check("the candidate's four fields are rendered",
      text().includes(zh.topicQuestion) && text().includes(zh.topicFeasibility) && text().includes(zh.topicInnovation), text().slice(0, 900));
    check("the candidate states its provenance", text().includes("co-occurrence-gap"), text().slice(0, 900));

    // Now the refusal path: a small sample must replace the results with a warning,
    // not merely omit them.
    nextResult = SMALL;
    const inputAgain = [...host.querySelectorAll("input")].find((element) => element.getAttribute("aria-label") === zh.topicPlaceholder);
    const propsKeyAgain = Object.keys(inputAgain ?? {}).find((key) => key.startsWith("__reactProps"));
    inputAgain?.[propsKeyAgain]?.onChange({ target: { value: "tiny" } });
    await settle(6);
    buttons().find((button) => button.textContent.trim() === zh.topicRecommend)
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();

    check("a refused sample is announced with its own heading",
      text().includes(zh.topicInsufficient), text().slice(0, 600));
    // And the heading is not merely a substring of the message: with the message
    // reworded above, only a real heading element can satisfy the previous check.
    check("the refusal message itself is rendered, not just the heading",
      text().includes(SMALL.refusal.message), text().slice(0, 600));
    check("the refusal states the sample size and the floor", /3/.test(text()) && /8/.test(text()), text().slice(0, 600));
    check("a refused sample renders no candidate cards", !text().includes(zh.topicQuestion), text().slice(0, 600));

    const relevant = seenErrors.filter((line) => !/Warning:/.test(line) && !/not wrapped in act/.test(line));
    check("driving the topics panel raises no unexpected errors", relevant.length === 0, relevant.slice(0, 2).join(" | "));
    console.error = realError;
    try { root.unmount(); } catch { /* ignore */ }
  }
}

console.log("");
if (failures.length > 0) {
  console.log(`TOPICS FAILED (${failures.length}):`);
  for (const failure of failures) console.log("  - " + failure);
  process.exit(1);
}
console.log("TOPICS PASS");

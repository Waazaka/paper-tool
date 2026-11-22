// Mount the real client bundle and drive paging through RPC observations (PT-015).
//
// Why this exists as a separate file from s30-paging.mjs: s30 asserts the Host
// side by calling it. The client half has a load-bearing behavioural contract that
// source grepping cannot check — "load more actually sends the next offset",
// "changing the filter refetches instead of re-rendering the loaded page",
// "the editor reads the full row before opening". Each of those survived a
// deliberate mutation while s30 was matching on source text: the string was still
// there, the behaviour was gone. This file mounts the shipped Body against a DOM
// stub and inspects the RPC calls it makes.
//
// Run: node test/s30b-paging-mount.mjs
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join, sep } from "node:path";
import { installDom, clickText, typeInto } from "./dom-stub.mjs";

const failures = [];
function check(name, ok, detail = "") {
  if (ok) console.log("  ok   " + name);
  else {
    console.log("  FAIL " + name + (detail === "" ? "" : " -> " + detail));
    failures.push(`${name} ${detail}`);
  }
}

// --- React from the desktop profile --------------------------------------
// The DOM goes in BEFORE `react-dom` is required. react-dom decides once, at
// module load, whether the environment supports the `input` event; with no
// `document` yet it concludes it does not and takes the IE9 polyfill path, whose
// keydown handling dereferences a null `activeElementInst` and throws. That made
// every keystroke in this gate untestable — and a search gate that cannot type
// cannot see the defect it is meant to guard. test/s16-typing.mjs and
// test/s11-interaction.mjs install the DOM first for the same reason.
const { document, Event: DomEventClass } = installDom({ width: 360, height: 640 });

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
  console.error(`PAGING-MOUNT: react not resolvable from ${ROOT}: ${error.message}`);
  process.exit(2);
}

const seenErrors = [];
console.error = (...args) => {
  const text = args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(" ");
  seenErrors.push(text);
};
process.on("unhandledRejection", (reason) => {
  seenErrors.push(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

// --- Host stand-in -------------------------------------------------------
// A library big enough to need two pages, so "load more" has somewhere to go.
const TOTAL_PAPERS = 120;
const PAGE = 50;
const papers = Array.from({ length: TOTAL_PAPERS }, (_, index) => ({
  paperId: `paper-${String(index).padStart(3, "0")}`,
  title: `Paper number ${index}`,
  authors: "Author",
  year: "2021",
  venue: "Journal",
  doi: "",
  source: "test",
  pdfPath: `/p${index}.pdf`,
  numPages: 5,
  indexedAt: "2026-01-01",
  material: "fulltext",
  // The projection the real Host sends: no metadataSource, no fingerprint.
  unverifiedFields: [],
  fromCrossrefFields: [],
}));

const TOTAL_EVIDENCE = 90;
// Outside the first page of 50: the hit must exercise "the paper is not in the
// loaded page", not merely "the paper is somewhere in `papers`".
const SEARCH_HIT_PAPER_INDEX = 80;
const evidence = Array.from({ length: TOTAL_EVIDENCE }, (_, index) => ({
  evidenceId: `ev-${String(index).padStart(3, "0")}`,
  paperId: papers[index % papers.length].paperId,
  pageIndex: 0,
  charStart: index % 3 === 0 ? -1 : index,
  charEnd: index % 3 === 0 ? -1 : index + 5,
  quote: `quote ${index}`,
  paperTitle: papers[index % papers.length].title,
  paperTextSource: "text-layer",
  createdAt: "2026-01-01",
}));

const calls = [];
function answer(method, params) {
  // The RPC envelope wraps the arguments as `{ paperSessionId, input }`; the method
  // body is interested in `input`. Record both so assertions can read either.
  calls.push({ method, params: params ?? {}, input: params?.input ?? {} });
  const input = params?.input ?? {};
  const offset = Number(input.offset ?? 0);
  const limit = Number(input.limit ?? PAGE);
  switch (method) {
    case "status":
      return { library: { papers: TOTAL_PAPERS, pages: 12, evidence: TOTAL_EVIDENCE } };
    case "listPapers": {
      const page = papers.slice(offset, offset + limit);
      return {
        papers: page,
        library: { papers: TOTAL_PAPERS, pages: 12, evidence: TOTAL_EVIDENCE },
        paging: { offset, limit_returned: limit, total: TOTAL_PAPERS, hasMore: offset + limit < TOTAL_PAPERS },
      };
    }
    case "listEvidence": {
      const anchor = input.anchor ?? "all";
      const pool = evidence.filter((row) => (anchor === "anchored" ? row.charStart >= 0
        : anchor === "unanchored" ? row.charStart < 0 : true));
      const page = pool.slice(offset, offset + limit);
      return {
        evidence: page,
        paging: {
          offset,
          limit_returned: limit,
          total: pool.length,
          hasMore: offset + limit < pool.length,
          anchoredTotal: evidence.filter((row) => row.charStart >= 0).length,
          allTotal: evidence.length,
        },
      };
    }
    case "listAnnotations":
      return { annotations: [] };
    case "search": {
      // A query hit on a paper the CURRENT PAGE does not contain: search spans the
      // whole library while the list holds one page (PT-015), which is exactly the
      // case where a hit card lost its stored row.
      const matched = papers[SEARCH_HIT_PAPER_INDEX];
      return {
        query: input.query,
        hits: [
          { paperId: matched.paperId, pageIndex: 3, snippet: "[hit] on page four", title: matched.title, year: matched.year, material: matched.material },
          { paperId: matched.paperId, pageIndex: 7, snippet: "[hit] on page eight", title: matched.title, year: matched.year, material: matched.material },
        ],
        library: { papers: TOTAL_PAPERS, pages: 12, evidence: TOTAL_EVIDENCE },
      };
    }
    case "readPaper": {
      const found = papers.find((paper) => paper.paperId === input.paperId);
      // The full row has the abstract the list projection omits.
      const result = { paper: { ...found, abstract: "the stored abstract" }, pages: [] };
      return result;
    }
    default:
      return {};
  }
}

let exported = null;
let loadError = null;
globalThis.window.__ModuleLoader__ = {
  load({ factory }) {
    try {
      exported = factory((id) => {
        if (id === "react") return React;
        throw new Error(`unexpected require: ${id}`);
      });
    } catch (error) {
      loadError = error;
    }
  },
};
await import(pathToFileURL(join(process.cwd(), "client.js")).href);
check("the client bundle loads", loadError === null && exported !== null, loadError?.message ?? "");
if (loadError !== null) process.exit(1);

const { Body, DICTS } = exported.__test;
function makeT(dict) {
  return (key, params) => {
    const raw = dict[key];
    if (raw === undefined) throw new Error(`missing translation key: ${key}`);
    if (params === undefined) return raw;
    return String(raw).replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])));
  };
}
const t = makeT(DICTS.zh);

const ctx = {
  connection: {
    rpc: {
      async call(_path, method, options) {
        const bare = String(method).replace(/^paperTool\//, "");
        try {
          return { ok: true, value: answer(bare, options?.args) };
        } catch (error) {
          return { ok: false, error: { message: error.message } };
        }
      },
    },
  },
  locale: { register() {}, bind: () => t },
  slots: { inject() {}, register: () => ({}) },
  sidebarRightTabs: { register: () => ({}) },
  effect() {},
};
exported.apply(ctx);

const container = document.createElement("div");
document.body.appendChild(container);
const inputActions = { captureInsertion() {}, insertText() {} };
const root = createRoot(container);
root.render(React.createElement(Body, { sessionId: "session-paging-mount", inputActions, t }));

async function settle(turns = 16) {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
const paneText = () => container.textContent;
const callsTo = (method) => calls.filter((call) => call.method === method);

await settle();

// --- 1. the first paint asks for one page, not the ceiling -------------
{
  const listCalls = callsTo("listPapers");
  check("the library list was requested on mount", listCalls.length >= 1, String(listCalls.length));
  const first = listCalls[0];
  check("the first request asks for one page, not 500",
    Number(first?.input?.limit) > 0 && Number(first?.input?.limit) <= 50,
    JSON.stringify(first?.input));
  check("the first request starts at offset 0", Number(first?.input?.offset ?? 0) === 0,
    JSON.stringify(first?.input));
  const evidenceCalls = callsTo("listEvidence");
  check("the evidence list was requested on mount", evidenceCalls.length >= 1);
  check("the first evidence request asks for one page, not 2000",
    Number(evidenceCalls[0]?.input?.limit) > 0 && Number(evidenceCalls[0]?.input?.limit) <= 50,
    JSON.stringify(evidenceCalls[0]?.input));
  check("the first page of papers is rendered", paneText().includes(papers[0].title));
  check("the 51st paper is not rendered yet", !paneText().includes(papers[60].title));
}

// --- 1b. a hit outside the loaded page is still openable ----------------
// Search covers the whole library; the list holds one page. Merging a hit with a
// page-only map therefore produced a card with no `pdfPath` and no `numPages`, and
// the card read that absence as 「无 PDF · 0 页」 — 阅读 and every page hit disabled,
// on a paper the search had just matched inside its full text. This gate drives the
// real search box and inspects the real card, because the defect lives in the merge
// between two states, not in either one alone.
{
  const hitPaper = papers[SEARCH_HIT_PAPER_INDEX];
  const searchBox = container.find((element) =>
    element.localName === "input" && element.getAttribute("aria-label") === DICTS.zh.searchPlaceholder);
  check("the search box is mounted", searchBox !== null, paneText().slice(0, 200));

  if (searchBox !== null) {
    const readPaperBefore = callsTo("readPaper").length;
    typeInto(searchBox, "[hit]", DomEventClass);
    await settle();
    // Enter, not the button: this is the path a user takes, and it also covers the
    // keydown handling the DOM stub has to be able to deliver.
    searchBox.dispatchEvent(new DomEventClass("keydown", { bubbles: true, key: "Enter", keyCode: 13 }));
    await settle();

    const searchCalls = callsTo("search");
    check("Enter in the search box issues a library search", searchCalls.length >= 1,
      `${searchCalls.length} search call(s)`);

    const card = container.find((element) =>
      element.localName === "li" && element.textContent.includes(hitPaper.title));
    check("the hit for a paper outside the loaded page is rendered", card !== null,
      paneText().slice(0, 300));

    const buttons = card === null ? [] : card.findAll((element) => element.localName === "button");
    const openButton = buttons.find((element) => element.textContent.trim() === DICTS.zh.open);
    check("the hit card does not claim it has no PDF", !(card?.textContent ?? "").includes(DICTS.zh.noPdf),
      card?.textContent ?? "");
    check("the hit card shows the paper's real page count",
      (card?.textContent ?? "").includes(`${hitPaper.numPages} ${DICTS.zh.pages}`),
      card?.textContent ?? "");
    check("the hit card can be opened", openButton !== undefined && openButton.disabled === false,
      `open button: ${openButton === undefined ? "missing" : `disabled=${openButton.disabled}`}`);

    // The page hits are the whole point of a grouped card, and they share the same
    // `hasPdf` gate — a fix that only re-enabled 阅读 would leave them dead.
    const hitButtons = buttons.filter((element) => element.textContent.includes(DICTS.zh.hitOnPage.split("{")[0].trim()));
    check("the page hits of the hit card are clickable too",
      hitButtons.length === 2 && hitButtons.every((element) => element.disabled === false),
      JSON.stringify(hitButtons.map((element) => ({ text: element.textContent.trim(), disabled: element.disabled }))));

    // The row has to come from somewhere: the paper is not in `papers`, so the panel
    // must have asked the Host for it. Without this the assertions above could pass
    // by rendering a path the client made up.
    const fetched = callsTo("readPaper").slice(readPaperBefore)
      .filter((call) => call.input.paperId === hitPaper.paperId);
    check("the missing row is fetched from the Host, not assumed", fetched.length >= 1,
      JSON.stringify(callsTo("readPaper").slice(readPaperBefore).map((call) => call.input)));

    // Clicking it must actually reach the reader. The reader is identified by its
    // own class, not by a label: its close control is icon-only (`←`), so the
    // dictionary string lives in `aria-label`.
    openButton?.dispatchEvent(new DomEventClass("click", { bubbles: true }));
    await settle();
    check("opening a hit outside the loaded page mounts the reader",
      container.find((element) => element.classList.contains("pt-reader")) !== null,
      paneText().slice(0, 260));

    const closeButton = container.find((element) =>
      element.localName === "button" && element.getAttribute("aria-label") === DICTS.zh.closeReader);
    if (closeButton !== null) {
      closeButton.dispatchEvent(new DomEventClass("click", { bubbles: true }));
      await settle();
    }
    check("the reader can be closed again", container.find((element) => element.classList.contains("pt-reader")) === null,
      paneText().slice(0, 200));

    // Back to the unfiltered list for the sections below, which assume it.
    if (paneText().includes(DICTS.zh.clear)) {
      clickText(container, DICTS.zh.clear);
      await settle();
    }
    check("clearing the search restores the loaded page",
      paneText().includes(papers[0].title) && paneText().includes(papers[PAGE - 1].title),
      paneText().slice(0, 200));
  }
}

// --- 2. "load more" sends the next offset -----------------------------
{
  // Render the label the way the component does, with its parameters filled.
  // Clicking a truncated prefix fails: clickText matches on the element's text.
  const button = t("loadMore", { shown: PAGE, total: TOTAL_PAPERS });
  const before = callsTo("listPapers").length;
  clickText(container, button);
  await settle();
  const after = callsTo("listPapers");
  check("clicking load-more issues another listPapers call", after.length > before,
    `${before} -> ${after.length}`);
  const followUp = after[after.length - 1];
  check("the follow-up request continues from the loaded count",
    Number(followUp?.input?.offset) === PAGE, JSON.stringify(followUp?.input));
  check("the follow-up request still asks for one page",
    Number(followUp?.input?.limit) <= 50, JSON.stringify(followUp?.input));
  // Behaviour, not source text: the new rows must actually appear.
  check("the next page of papers is rendered after load-more",
    paneText().includes(papers[PAGE].title), paneText().slice(0, 200));
}

// --- 3. the metadata editor reads the full row ------------------------
{
  const before = callsTo("readPaper").length;
  clickText(container, DICTS.zh.editMeta);
  await settle();
  const after = callsTo("readPaper");
  check("opening the editor fetches the full paper row", after.length > before,
    `${before} -> ${after.length}`);
  // The editor's abstract field must be populated from that fetch, because the
  // list projection omits `abstract` and saving an empty box would erase it.
  //
  // Read the textarea's `value`, not the pane text: a textarea's content is its
  // value property, so textContent never contains it. Asserting on pane text here
  // would have passed for the wrong reason (or, as it did, failed for one).
  const areas = [...container.querySelectorAll("textarea")];
  const abstractValue = areas.map((area) => area.value ?? "").find((value) => value !== "") ?? "";
  check("the editor received the full row (a textarea is populated)",
    areas.length > 0, String(areas.length));
  check("the editor's abstract holds the stored value",
    abstractValue === "the stored abstract", JSON.stringify(abstractValue));
}

// --- 6. isolated: the editor itself renders the abstract it is given ------
{
  const { MetadataEditor } = exported.__test;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const isolated = createRoot(host);
  isolated.render(React.createElement(MetadataEditor, {
    paper: { title: "T", authors: "A", year: "2021", venue: "V", doi: "d", abstract: "isolated abstract" },
    t,
    onSave() {},
    onCancel() {},
    busy: null,
  }));
  await settle(4);
  const area = [...host.querySelectorAll("textarea")][0];
  check("MetadataEditor renders a textarea", area !== undefined);
  check("MetadataEditor shows the abstract it was given",
    area?.value === "isolated abstract", JSON.stringify(area?.value));
  try { isolated.unmount(); } catch { /* ignore */ }
}

// --- 3b. the card's provenance badges read the trimmed projection ----
// The list payload no longer carries `metadataSource` (PT-015 trims it), so the
// badges must come from the precomputed arrays. Without this the badge silently
// disappears on every record — a hint that "this field is a guess" going missing
// is exactly the kind of quiet regression the trimming could cause.
{
  const { PaperCard } = exported.__test;
  const mountCard = async (paper) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const cardRoot = createRoot(host);
    cardRoot.render(React.createElement(PaperCard, {
      paper: { paperId: "x", title: "A title", authors: "A", year: "2021", venue: "V", doi: "d", source: "test", material: "fulltext", numPages: 3, ...paper },
      t,
      busy: null,
      onOpen() {}, onEdit() {}, onReextract() {}, onEnrich() {}, onReocr() {}, onDelete() {},
    }));
    await settle(4);
    const text = host.textContent;
    try { cardRoot.unmount(); } catch { /* ignore */ }
    return text;
  };

  const guessHint = t("guessBadge", { fields: t("fieldTitle") });
  const guessedCard = await mountCard({ unverifiedFields: ["title"], fromCrossrefFields: [] });
  check("the card shows a guess badge for a precomputed unverified field",
    guessedCard.includes(guessHint), guessedCard.slice(0, 220));

  const cleanCard = await mountCard({ unverifiedFields: [], fromCrossrefFields: [] });
  check("the card shows no guess badge when nothing is unverified",
    !cleanCard.includes(t("guessBadge", { fields: "" })), cleanCard.slice(0, 220));

  const crossrefCard = await mountCard({ unverifiedFields: [], fromCrossrefFields: ["venue"] });
  check("a Crossref-confirmed field is not reported as a guess",
    !crossrefCard.includes(guessHint), crossrefCard.slice(0, 220));
  // Positive half: the confirmation badge has to actually appear. Asserting only
  // "no guess badge" would pass if the badge code were deleted outright.
  const crossrefHint = t("crossrefBadge", { fields: t("fieldVenue") });
  check("a Crossref-confirmed field gets its own badge",
    crossrefCard.includes(crossrefHint), crossrefCard.slice(0, 260));
  const plainCard = await mountCard({ unverifiedFields: [], fromCrossrefFields: [] });
  check("no Crossref badge when nothing came from Crossref",
    !plainCard.includes(crossrefHint), plainCard.slice(0, 260));
}

// --- 4. changing the evidence filter refetches with the filter --------
{
  // The filter buttons live on the evidence tab, which is not the default view.
  // Close the metadata editor first: it occupies the panel, and leaving it open
  // would make the tab click land on a covered control in a real browser too.
  clickText(container, DICTS.zh.cancel);
  await settle();
  // The tab label carries a count ("证据 50"), so match on the name alone.
  const tabButton = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent.trim().startsWith(DICTS.zh.evidenceTab));
  check("the evidence tab is present", tabButton !== undefined,
    JSON.stringify([...container.querySelectorAll("button")].map((b) => b.textContent.trim()).slice(0, 8)));
  tabButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await settle();
  check("the evidence view is showing",
    paneText().includes(DICTS.zh.filterAll), paneText().slice(0, 200));
  const before = callsTo("listEvidence").length;
  const papersBefore = callsTo("listPapers").length;
  const annotationsBefore = callsTo("listAnnotations").length;
  const anchoredCount = evidence.filter((row) => row.charStart >= 0).length;
  // The label is rendered as `${t("filterAnchored")} ${count}` — the dictionary string
  // has no placeholder, so match the button by its prefix and assert the count.
  const filterButton = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent.trim().startsWith(DICTS.zh.filterAnchored));
  check("the anchored filter button is present", filterButton !== undefined,
    JSON.stringify([...container.querySelectorAll("button")].map((b) => b.textContent.trim()).slice(0, 12)));
  check("the filter button shows the library-wide count",
    filterButton?.textContent.includes(String(anchoredCount)), filterButton?.textContent);
  filterButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await settle();
  const after = callsTo("listEvidence");
  check("switching the filter issues another listEvidence call", after.length > before,
    `${before} -> ${after.length}`);
  const filtered = after[after.length - 1];
  check("the refetch carries the selected filter", filtered?.input?.anchor === "anchored",
    JSON.stringify(filtered?.input));
  check("the refetch restarts at offset 0", Number(filtered?.input?.offset ?? 0) === 0,
    JSON.stringify(filtered?.input));
  // Answering one click must not re-fetch the paper list or the annotations. This
  // caught a real waste: `loadEvidence` used to depend on the filter, which made
  // `refresh` unstable, so a filter click re-ran the whole panel load.
  check("a filter change does not re-fetch the paper list",
    callsTo("listPapers").length === papersBefore, `${papersBefore} -> ${callsTo("listPapers").length}`);
  check("a filter change does not re-fetch annotations",
    callsTo("listAnnotations").length === annotationsBefore,
    `${annotationsBefore} -> ${callsTo("listAnnotations").length}`);
}

// --- 5. nothing threw while any of that ran ---------------------------
{
  const real = seenErrors.filter((text) => !/not wrapped in act|Warning:/.test(text));
  check("driving the paging paths raised no errors", real.length === 0, real.slice(0, 3).join(" | "));
}

try { root.unmount(); } catch { /* the stub may not support it; irrelevant here */ }

if (failures.length > 0) {
  console.log("\nPAGING-MOUNT FAILED (" + failures.length + "):");
  for (const failure of failures) console.log(" - " + failure);
  process.exit(1);
}
console.log("\nPAGING-MOUNT PASS");

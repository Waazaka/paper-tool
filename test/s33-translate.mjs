// Translation: anchored segmentation, write-back, side-by-side alignment, search
// isolation, OCR caveat (PT-012).
//
// The contract this gate protects is unusual, so state it plainly: the plugin does
// NOT translate. It holds no model channel (D-014) and the tool surface is frozen at
// six (README hard rule 4). Its job is preparation and write-back — cut the page into
// segments with exact character anchors, hand them over, store what comes back
// against those anchors, and show the two columns paired.
//
// The failure this is written against is silent misalignment. If write-back paired by
// position instead of by anchor, a skipped paragraph would shift every translation
// below it onto the wrong original, and the view would still look like a translated
// paper. A count comparison would not catch it either — one missing plus one extra
// has the right total. So alignment is checked by anchor, per row.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const { loadService } = await import("./shim.mjs");
const { PaperToolService } = await loadService();
const { splitPageSegments, alignSegments } = await import("../lib/translate.js");

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
const store = readFileSync("lib/store.js", "utf8");
const tools = readFileSync("lib/tools.js", "utf8");

function makeService(label) {
  const home = mkdtempSync(join(tmpdir(), `${label}-home-`));
  const work = mkdtempSync(join(tmpdir(), `${label}-work-`));
  const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: home, shared: true });
  return {
    service,
    scope: { sessionId: label, workspaceRoot: work },
    cleanup() { service.dispose(); rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); },
  };
}

const PAGES = [
  "第一段讲研究背景与问题。\n\n第二段讲方法，包括数据来源与实验设计。\n\n第三段给出结论。",
  "This page is in English.\n\nIt has two paragraphs so the walker has work to do.",
];

/** A paper with real page text so segments come from the store, not from a fixture. */
function seed(service, scope, extra = {}) {
  const store_ = service.storeFor(scope);
  store_.upsertPaper({
    paperId: "p-trans", title: "Translatable paper", authors: "A", year: "2021",
    venue: "V", doi: "10.1/t", source: "test", pdfPath: "", fingerprint: "fp-trans",
    material: "fulltext", numPages: PAGES.length,
    pages: PAGES, pageSources: PAGES.map(() => "text-layer"),
    ...extra,
  });
  return store_;
}

// --- 1. the tool surface is untouched ---------------------------------
// The first version of this criterion said "register paper_translate". That was
// written before D-014 settled the plugin's scope, and it is now the wrong shape.
{
  check("no paper_translate tool exists",
    !/paper_translate/.test(tools), "lib/tools.js mentions paper_translate");
  // Six tools, still. This is the hard rule, checked here because a translation
  // feature is exactly the kind of thing that tempts a seventh tool.
  const { service, scope, cleanup } = makeService("c");
  const listed = await service.status(scope);
  check("status advertises translation as an RPC path", listed.translation?.supported === true,
    JSON.stringify(listed.translation));
  check("status says the engine is the agent, not the plugin",
    listed.translation?.engine === "agent", String(listed.translation?.engine));
  check("status reports whether translations are indexed",
    listed.translation?.indexed === false, String(listed.translation?.indexed));
  cleanup();
  check("the four translation RPCs are registered",
    ["translateSegments", "saveTranslation", "listTranslations", "deleteTranslation"]
      .every((method) => new RegExp(`"${method}"`).test(host)));
  check("the client calls them through the input-wrapped path",
    /"translateSegments", "saveTranslation", "listTranslations", "deleteTranslation"/.test(client));
}

// --- 2. segmentation is anchor-exact ---------------------------------
{
  const page = PAGES[0];
  const segments = splitPageSegments(page, 0);
  check("a page with three paragraphs yields three segments", segments.length === 3, String(segments.length));
  // The anchor must be exact, not approximate: the whole write-back path depends on
  // being able to re-read the original from these offsets.
  const exact = segments.every((segment) => page.slice(segment.charStart, segment.charEnd) === segment.text);
  check("every segment's offsets re-read exactly its text", exact,
    segments.map((s) => `[${s.charStart},${s.charEnd})`).join(" "));
  check("offsets are unique and ordered",
    segments.every((segment, index) => index === 0 || segment.charStart >= segments[index - 1].charEnd));
  check("pageIndex travels with every segment",
    segments.every((segment) => segment.pageIndex === 0));

  // Leading and trailing whitespace must not be part of a segment, or the offsets
  // point at blanks and re-reading the page by them returns something the caller
  // never sent for translation.
  {
    const padded = "\n\n  第一段。  \n\n  第二段。\n\n    ";
    const paddedSegments = splitPageSegments(padded, 0);
    check("segments are trimmed of surrounding whitespace",
      paddedSegments.every((segment) => segment.text === segment.text.trim()),
      JSON.stringify(paddedSegments.map((segment) => segment.text)));
    check("trimmed offsets still re-read exactly",
      paddedSegments.every((segment) => padded.slice(segment.charStart, segment.charEnd) === segment.text));
    check("the padding does not become a segment of its own",
      !paddedSegments.some((segment) => segment.text.trim() === ""),
      JSON.stringify(paddedSegments.map((segment) => segment.text)));
  }

  // Blank page is empty, not one empty segment: an empty segment would be offered
  // for translation and then rejected on save, which reads as a bug.
  check("a blank page yields no segments", splitPageSegments("   \n\n \n ", 3).length === 0);
  // No segment may be empty or whitespace-only, on any page shape. Three separate
  // guards enforce this (the blank-page early return, the trim-before-push check,
  // and the final filter) and any one alone is enough, so this is asserted on the
  // observable property rather than on one guard: a segment with no text would be
  // offered for translation and then rejected on save.
  {
    const shapes = [
      ["   \n\n  \n\n   ", "an all-whitespace page"],
      ["\n\n\n内容。", "a page starting with blank lines"],
      ["内容。\n\n   \n\n更多内容。", "a page with a blank paragraph between two"],
      ["\n\n   \n\n内容。\n\n  \n\n", "a page padded on both ends"],
    ];
    for (const [page, description] of shapes) {
      const produced = splitPageSegments(page, 0);
      check(`${description} produces no empty segment`,
        produced.every((segment) => segment.text.trim() !== ""),
        JSON.stringify(produced.map((segment) => segment.text)));
      check(`${description} keeps its offsets exact`,
        produced.every((segment) => page.slice(segment.charStart, segment.charEnd) === segment.text),
        JSON.stringify(produced.map((segment) => [segment.charStart, segment.charEnd])));
    }
  }
  check("a one-paragraph page yields one segment", splitPageSegments("只有一个段落。", 1).length === 1);

  // Long paragraphs are capped. CJK PDFs often have no blank lines at all, so this
  // is the common case rather than an edge case.
  const long = "这是很长的一段话。".repeat(400);
  const capped = splitPageSegments(long, 0, { maxChars: 100 });
  check("a long paragraph is split", capped.length > 1, String(capped.length));
  check("split pieces stay exact", capped.every((segment) => long.slice(segment.charStart, segment.charEnd) === segment.text));
  check("split pieces respect the cap",
    capped.every((segment) => segment.text.length <= 100),
    String(Math.max(...capped.map((segment) => segment.text.length))));
  // A cap inside a multi-paragraph page must rebase onto the PAGE, not onto the
  // paragraph. Getting this wrong only shows up on the second paragraph onwards,
  // where a paragraph-relative offset points at the wrong text entirely.
  {
    const head = "开头一段。\n\n";
    const body = "这是需要切分的长段落。".repeat(80);
    const multi = head + body;
    const pieces = splitPageSegments(multi, 0, { maxChars: 120 });
    check("a long paragraph after a short one is still exact",
      pieces.every((segment) => multi.slice(segment.charStart, segment.charEnd) === segment.text),
      pieces.map((segment) => `[${segment.charStart},${segment.charEnd})`).join(" ").slice(0, 120));
    check("capped pieces start after the earlier paragraph",
      pieces.filter((segment) => segment.text.startsWith("这是")).every((segment) => segment.charStart >= head.length),
      String(Math.min(...pieces.filter((segment) => segment.text.startsWith("这是")).map((segment) => segment.charStart))));
    check("capped offsets stay unique",
      new Set(pieces.map((segment) => `${segment.charStart}:${segment.charEnd}`)).size === pieces.length);
  }
}

// --- 3. segmentation through the RPC ---------------------------------
{
  const { service, scope, cleanup } = makeService("r");
  seed(service, scope);
  const result = await service.translateSegments(scope, { paperId: "p-trans", fromPage: 0, toPage: 1, targetLang: "zh" });
  check("the RPC returns segments for both pages", result.segments.length > 3, String(result.segments.length));
  check("each segment carries a textSource", result.segments.every((segment) => typeof segment.textSource === "string"));
  check("each segment carries its page and offsets",
    result.segments.every((segment) => Number.isInteger(segment.pageIndex)
      && Number.isInteger(segment.charStart) && Number.isInteger(segment.charEnd)));
  check("a page range is respected",
    result.segments.every((segment) => segment.pageIndex >= 0 && segment.pageIndex <= 1));
  check("nothing is translated yet", result.translated === 0, String(result.translated));
  check("every segment is reported untranslated",
    result.untranslated === result.segments.length, `${result.untranslated} vs ${result.segments.length}`);
  check("the result is not aligned until translated", result.aligned === false);

  // A page range that starts later must not include earlier pages.
  const second = await service.translateSegments(scope, { paperId: "p-trans", fromPage: 1, toPage: 1, targetLang: "zh" });
  check("a single-page range returns only that page",
    second.segments.every((segment) => segment.pageIndex === 1), JSON.stringify(second.segments.map((s) => s.pageIndex)));
  cleanup();
}

// --- 4. write-back is anchored and idempotent ------------------------
{
  const { service, scope, cleanup } = makeService("w");
  seed(service, scope);
  const first = await service.translateSegments(scope, { paperId: "p-trans", fromPage: 0, toPage: 0, targetLang: "zh" });
  const items = first.segments.map((segment) => ({
    pageIndex: segment.pageIndex,
    charStart: segment.charStart,
    charEnd: segment.charEnd,
    text: `译:${segment.text.slice(0, 6)}`,
  }));
  const saved = await service.saveTranslation(scope, { paperId: "p-trans", targetLang: "zh", items });
  check("every segment was saved", saved.saved === items.length, `${saved.saved} of ${items.length}`);
  check("nothing was rejected", saved.rejected.length === 0, JSON.stringify(saved.rejected.slice(0, 2)));
  // Saving the whole page must make the view aligned, which is the point of
  // translating a page in one round trip.
  check("the page is fully aligned after saving", saved.aligned === true, String(saved.aligned));

  const after = await service.translateSegments(scope, { paperId: "p-trans", fromPage: 0, toPage: 0, targetLang: "zh" });
  check("translated count matches", after.translated === items.length, String(after.translated));
  check("nothing left untranslated", after.untranslated === 0, String(after.untranslated));

  // Re-translating replaces rather than appends: a second copy would show the same
  // paragraph twice in the side-by-side view.
  const rewritten = await service.saveTranslation(scope, {
    paperId: "p-trans", targetLang: "zh",
    items: items.map((item) => ({ ...item, text: `改:${item.text}` })),
  });
  check("re-saving does not duplicate", rewritten.saved === items.length);
  const rows = service.storeFor(scope).listTranslations({ paperId: "p-trans" });
  check("the row count is unchanged after re-saving", rows.length === items.length, String(rows.length));
  check("the text was replaced, not appended",
    rows.every((row) => row.text.startsWith("改:")), rows.map((row) => row.text.slice(0, 4)).join(","));

  // The stored source is the page's words, not the caller's claim about them.
  check("stored sourceText comes from the page",
    rows.every((row) => row.sourceText === PAGES[0].slice(row.charStart, row.charEnd)),
    "sourceText does not match the page at its own anchor");

  // Invalid anchors are rejected, not matched positionally.
  const mixed = await service.saveTranslation(scope, {
    paperId: "p-trans", targetLang: "zh",
    items: [
      { pageIndex: 0, charStart: -1, charEnd: 5, text: "坏的锚点" },
      { pageIndex: 0, charStart: 0, charEnd: 0, text: "空区间" },
      { pageIndex: 0, charStart: 5, charEnd: 5, text: "零宽" },
      { pageIndex: 99, charStart: 0, charEnd: 1, text: "不存在的页" },
      { pageIndex: 0, charStart: 0, charEnd: 6, text: "   " },
    ],
  });
  check("anchors that cannot be written back are rejected", mixed.rejected.length === 5, String(mixed.rejected.length));
  check("nothing was saved from the rejected batch", mixed.saved === 0, String(mixed.saved));
  cleanup();
}

// --- 5. persistence survives a reopen -------------------------------
// The criterion says "restart DSH and the translation is still readable". A new
// service instance over the same database is the closest a gate can get to that.
{
  const home = mkdtempSync(join(tmpdir(), "persist-home-"));
  const work = mkdtempSync(join(tmpdir(), "persist-work-"));
  const scope = { sessionId: "persist", workspaceRoot: work };
  const first = new PaperToolService({ inject() {}, get() {} }, { homeDir: home, shared: true });
  seed(first, scope);
  const segments = (await first.translateSegments(scope, { paperId: "p-trans", fromPage: 0, toPage: 0, targetLang: "zh" })).segments;
  await first.saveTranslation(scope, {
    paperId: "p-trans", targetLang: "zh",
    items: segments.map((segment) => ({ pageIndex: segment.pageIndex, charStart: segment.charStart, charEnd: segment.charEnd, text: `持久:${segment.charStart}` })),
  });
  first.dispose();

  const second = new PaperToolService({ inject() {}, get() {} }, { homeDir: home, shared: true });
  const reread = await second.listTranslations(scope, { paperId: "p-trans", targetLang: "zh" });
  check("translations survive a service restart", reread.translations.length === segments.length,
    `${reread.translations.length} of ${segments.length}`);
  check("anchors survive the restart",
    reread.translations.every((row) => Number.isInteger(row.pageIndex)
      && Number.isInteger(row.charStart) && Number.isInteger(row.charEnd)));
  check("the paper id is preserved", reread.translations.every((row) => row.paperId === "p-trans"));
  // The text must line up with the original after the restart, which is the whole
  // point of persisting the offsets rather than the text alone.
  check("each translation still matches its original at its anchor",
    reread.translations.every((row) => row.sourceText === PAGES[0].slice(row.charStart, row.charEnd)));
  second.dispose();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}

// --- 6. alignment is by anchor, not by position ----------------------
{
  const sources = splitPageSegments(PAGES[0], 0);
  const all = sources.map((source) => ({ ...source, targetLang: "zh", text: `译${source.charStart}` }));

  const full = alignSegments(sources, all, { targetLang: "zh" });
  check("a fully translated page is aligned", full.aligned === true);
  check("every source has a pair", full.pairs.length === sources.length);

  // Drop the middle translation but keep the count trick: add a bogus extra row so
  // a naive "same length" check would call this aligned.
  const skipped = [all[0], all[2], { pageIndex: 0, charStart: 9999, charEnd: 10000, text: "多余", targetLang: "zh" }];
  const partial = alignSegments(sources, skipped, { targetLang: "zh" });
  check("a skipped paragraph is detected", partial.aligned === false);
  check("the same total count does not pass as aligned",
    partial.pairs.length === sources.length && partial.aligned === false,
    `pairs=${partial.pairs.length} aligned=${partial.aligned}`);
  check("the untranslated segment is named, not just counted",
    partial.unmatchedSource.length === 1 && partial.unmatchedSource[0].charStart === sources[1].charStart,
    JSON.stringify(partial.unmatchedSource.map((row) => row.charStart)));
  check("the orphan translation is named",
    partial.unmatchedTranslation.length === 1 && partial.unmatchedTranslation[0].charStart === 9999);
  // The pair for the skipped paragraph must carry a null translation, so the view
  // renders it as untranslated instead of shifting the next translation up.
  check("a skipped paragraph pairs with null, not with the next translation",
    partial.pairs[1].translation === null, JSON.stringify(partial.pairs[1].translation?.text));
  check("the pairs that do exist stay on their own source",
    partial.pairs[0].translation?.text === "译0" && partial.pairs[2].translation?.text === `译${sources[2].charStart}`,
    partial.pairs.map((pair) => `${pair.source.charStart}->${pair.translation?.text ?? "null"}`).join(" "));

  // A different target language is a separate set and must not be mixed in.
  const twoLangs = [...all, ...all.map((row) => ({ ...row, targetLang: "ja", text: "日" }))];
  const zhOnly = alignSegments(sources, twoLangs, { targetLang: "zh" });
  check("alignment filters to one target language",
    zhOnly.pairs.every((pair) => pair.translation?.targetLang === "zh"));
}

// --- 7. translations do not pollute search --------------------------
// This is the tradeoff recorded in the work item: the plugin's whole promise is that
// a quote is the paper's own words. If translations were indexed, a Chinese search
// would return text the paper never wrote with no way to tell.
{
  const { service, scope, cleanup } = makeService("s");
  seed(service, scope);
  const before = service.storeFor(scope).search("结论", { limit: 50 }).length;
  const segments = (await service.translateSegments(scope, { paperId: "p-trans", fromPage: 0, toPage: 0, targetLang: "zh" })).segments;
  await service.saveTranslation(scope, {
    paperId: "p-trans", targetLang: "zh",
    items: segments.map((segment) => ({
      pageIndex: segment.pageIndex, charStart: segment.charStart, charEnd: segment.charEnd,
      // Deliberately worded to be findable if it were indexed.
      text: "结论 结论 唯一可搜索的译文标记",
    })),
  });
  const after = service.storeFor(scope).search("结论", { limit: 50 }).length;
  check("a search result count is unchanged by translating", after === before, `${before} -> ${after}`);
  const translatedOnly = service.storeFor(scope).search("唯一可搜索的译文标记", { limit: 50 });
  check("text that exists only in a translation is not searchable",
    translatedOnly.length === 0, String(translatedOnly.length));
  // And the translations really are stored — otherwise "not searchable" would pass
  // because nothing was saved.
  check("the translation really was stored",
    service.storeFor(scope).countTranslations({ paperId: "p-trans" }) === segments.length,
    String(service.storeFor(scope).countTranslations({ paperId: "p-trans" })));
  // The indexes are over `pages` only.
  check("the full-text index covers pages only",
    /content='pages'/.test(store) && !/translations.*fts5/i.test(store));
  cleanup();
}

// --- 8. OCR provenance is carried to the UI -------------------------
// A translation of recognized text compounds the recognition error. The caveat has
// to reach the reader, and it has to be per page rather than a global banner.
{
  const { service, scope, cleanup } = makeService("o");
  seed(service, scope, {
    pages: ["扫描得来的文字。\n\n第二段也是识别出来的。", "这一页有文本层。"],
    pageSources: ["ocr", "text-layer"],
  });
  const result = await service.translateSegments(scope, { paperId: "p-trans", fromPage: 0, toPage: 1, targetLang: "zh" });
  check("the OCR page is reported", result.ocrPages.includes(0), JSON.stringify(result.ocrPages));
  check("the text-layer page is not reported as OCR", !result.ocrPages.includes(1), JSON.stringify(result.ocrPages));
  check("each segment carries its own provenance",
    result.segments.filter((segment) => segment.pageIndex === 0).every((segment) => segment.textSource === "ocr")
    && result.segments.filter((segment) => segment.pageIndex === 1).every((segment) => segment.textSource === "text-layer"),
    JSON.stringify(result.segments.map((segment) => `${segment.pageIndex}:${segment.textSource}`)));

  // The client must render the caveat next to the segment it applies to.
  check("the client shows a per-segment OCR caveat", /translateOcrCaveat/.test(client));
  check("the caveat only appears on OCR pages", /ocrPages\.has\(segment\.pageIndex\)/.test(client));
  check("the view summarises how many pages were OCR'd", /translateOcrNote/.test(client));
  cleanup();
}

// --- 9. the client actually renders it ------------------------------
// Asserted by mounting the real Body and driving the tab, not by grepping
// client.js. Five mutations survived the grep version of this section: the strings
// were all still in the file while the behaviour was gone.
{
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { join, sep } = await import("node:path");
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
    const { document, window } = installDom({ width: 380, height: 720 });
    const seenErrors = [];
    const realError = console.error;
    console.error = (...args) => {
      const line = args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" ");
      seenErrors.push(line);
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
    await import(pathToFileURL(join(process.cwd(), "client.js")).href);
    const { Body, DICTS } = exported.__test;
    const zh = DICTS.zh;
    const t = (key, params) => {
      const raw = zh[key];
      if (raw === undefined) return key;
      return params === undefined ? raw : String(raw).replace(/\{(\w+)\}/g, (all, name) => (params[name] === undefined ? all : String(params[name])));
    };

    // Host stand-in. Deliberately reports a rejected item so the UI has something
    // to surface: a save that silently drops a paragraph is the failure mode.
    const PAPER = {
      paperId: "p1", title: "A translatable paper", authors: "A", year: "2021",
      venue: "V", doi: "10.1/p1", source: "test", pdfPath: "/p1.pdf", numPages: 2,
      indexedAt: "2026-01-01", material: "fulltext", unverifiedFields: [], fromCrossrefFields: [],
    };
    const SEGMENTS = [
      { segmentId: "p0-0-6", pageIndex: 0, charStart: 0, charEnd: 6, text: "第一段原文。", textSource: "text-layer", material: "fulltext" },
      { segmentId: "p0-8-14", pageIndex: 0, charStart: 8, charEnd: 14, text: "第二段原文。", textSource: "text-layer", material: "fulltext" },
      { segmentId: "p1-0-6", pageIndex: 1, charStart: 0, charEnd: 6, text: "扫描页文字。", textSource: "ocr", material: "fulltext" },
    ];
    const calls = [];
    const answer = (method, params) => {
      const input = params?.input ?? params?.args?.input ?? {};
      calls.push({ method, input });
      switch (method) {
        case "status":
          return { library: { papers: 1, pages: 2, evidence: 0 }, styles: ["apa"], translation: { supported: true, total: 0, engine: "agent", indexed: false }, limits: { maxImportFiles: 32, maxPdfBytes: 67108864 } };
        case "listPapers":
          return { papers: [PAPER], library: { papers: 1, pages: 2, evidence: 0 }, paging: { offset: 0, limit_returned: 1, total: 1, hasMore: false } };
        case "listEvidence":
          return { evidence: [], paging: { offset: 0, limit_returned: 0, total: 0, hasMore: false, anchoredTotal: 0, allTotal: 0 } };
        case "listAnnotations":
          return { annotations: [] };
        case "translateSegments":
          return { paperId: input.paperId, title: PAPER.title, fromPage: 0, toPage: 1, totalPages: 2, targetLang: "zh", segments: SEGMENTS, translated: 0, untranslated: SEGMENTS.length, aligned: false, ocrPages: [1] };
        case "listTranslations":
          return { paperId: input.paperId, targetLang: "zh", translations: [], total: 0 };
        case "saveTranslation":
          return {
            paperId: input.paperId,
            saved: (input.items ?? []).length - 1,
            rejected: [{ reason: "missing or invalid anchor" }],
            translations: [],
            aligned: false,
          };
        default:
          return {};
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
    root.render(React.createElement(Body, { sessionId: "s33-ui", inputActions: { captureInsertion() {}, insertText() {} }, t }));
    const settle = async (turns = 18) => { for (let i = 0; i < turns; i += 1) await new Promise((r) => setTimeout(r, 0)); };
    await settle();

    const buttons = () => [...host.querySelectorAll("button")];
    const openBtn = buttons().find((button) => button.textContent.trim() === zh.open);
    check("a paper can be opened in the reader", openBtn !== undefined,
      JSON.stringify(buttons().map((b) => b.textContent.trim())));
    openBtn?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();

    const tab = buttons().find((button) => button.textContent.trim().startsWith(zh.translateTab));
    check("a bilingual translation toggle exists inside the reader", tab !== undefined,
      JSON.stringify(buttons().map((b) => b.textContent.trim())));
    tab?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();

    // The paper is auto-bound to the open reader; pick/confirm and load segments through the real controls.
    const select = [...host.querySelectorAll("select")].find((element) => element.getAttribute("aria-label") === zh.translatePaper);
    check("the paper picker is present", select !== undefined,
      JSON.stringify([...host.querySelectorAll("select")].map((element) => element.getAttribute("aria-label"))));
    if (select !== undefined) {
      select.value = "p1";
      select.dispatchEvent(new window.Event("change", { bubbles: true }));
      await settle(4);
      const load = buttons().find((button) => button.textContent.trim() === zh.loadSegments);
      check("there is a control to cut the page into segments", load !== undefined,
        JSON.stringify(buttons().map((b) => b.textContent.trim())));
      const callsBeforeLoad = calls.length;
      load?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await settle();

      const loadCalls = calls.slice(callsBeforeLoad);
      check("loading segments issues the RPC", loadCalls.some((call) => call.method === "translateSegments"),
        loadCalls.map((call) => call.method).join(","));
      const sent = loadCalls.find((call) => call.method === "translateSegments")?.input ?? {};
      check("the RPC is told which paper", sent.paperId === "p1", JSON.stringify(sent.paperId));

      const bodyText = host.textContent;
      // One row per segment, with the original in one column.
      check("both column headers are rendered",
        bodyText.includes(zh.translateSourceCol) && bodyText.includes(zh.translateTargetCol),
        bodyText.slice(0, 200));
      check("every segment's original text is on screen",
        SEGMENTS.every((segment) => bodyText.includes(segment.text)),
        SEGMENTS.map((segment) => bodyText.includes(segment.text)).join(","));
      // One textarea per segment: that is what makes each translation land on its own
      // anchor. A shared key would collapse them into one field.
      const inputs = [...host.querySelectorAll("textarea")]
        .filter((element) => (element.getAttribute("aria-label") ?? "").startsWith(zh.translateSegmentAria.split("{")[0]));
      check("there is one translation field per segment",
        inputs.length === SEGMENTS.length, `${inputs.length} of ${SEGMENTS.length}`);
      const anchors = inputs.map((element) => element.getAttribute("aria-label"));
      check("each field names its own page and offset",
        new Set(anchors).size === anchors.length, JSON.stringify(anchors));
      // Progress is reported as counts so an incomplete page is visible. The
      // assertion names the whole line: checking for "the number appears somewhere"
      // or "the word 未译 appears somewhere" both pass while the progress line is
      // gone, because the alignedPartly badge uses the same words.
      const expectedProgress = `${SEGMENTS.length} ${t("segmentCount")} · 0 ${t("translatedCount")} · ${SEGMENTS.length} ${t("untranslatedCount")}`;
      check("the view reports translated and untranslated counts",
        bodyText.includes(expectedProgress), JSON.stringify(expectedProgress) + " not in " + bodyText.slice(0, 300));
      check("an incomplete page is labelled, not presented as done",
        bodyText.includes(t("alignedPartly", { n: SEGMENTS.length })) || /未译/.test(bodyText),
        bodyText.slice(0, 300));
      // OCR provenance reaches the reader next to the affected segment.
      check("the OCR caveat is shown",
        bodyText.includes(zh.translateOcrCaveat) || bodyText.includes(zh.translateOcrNote),
        bodyText.slice(0, 400));
      check("the plugin says plainly that it does not translate",
        bodyText.includes(zh.translateIntro) || /不翻译/.test(bodyText), bodyText.slice(0, 200));

      // Fill one field and save; the Host rejects one item, which must be shown.
      //
      // The value is delivered by calling the textarea's own onChange, not by
      // synthesising an input event. That is not a shortcut around the UI: a
      // controlled <textarea> receives its text exclusively through onChange, so
      // this is the same function a keystroke reaches. Dispatching a DOM event here
      // does not work and never did: react-dom wraps textarea in a special path that
      // writes through `defaultValue`, so a hand-set `.value` is reverted on the
      // next render and the tracker reports "unchanged". The typeInto helper works
      // for <input> (s16, s31), not for this case.
      const reactPropsKey = Object.keys(inputs[0]).find((key) => key.startsWith("__reactProps"));
      const onChange = inputs[0][reactPropsKey]?.onChange;
      check("the translation field is a controlled input with an onChange", typeof onChange === "function",
        typeof onChange);
      onChange({ target: { value: "第一段译文。" } });
      await settle(6);
      const renderedValue = [...host.querySelectorAll("textarea")][0]?.value;
      check("the typed translation reaches the field", renderedValue === "第一段译文。",
        JSON.stringify(renderedValue));

      const saveButton = buttons().find((button) => button.textContent.trim() === zh.saveTranslation);
      check("there is a control to save the translation", saveButton !== undefined,
        JSON.stringify(buttons().map((b) => b.textContent.trim()).filter((label) => /译/.test(label))));
      saveButton?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await settle();

      const saves = calls.filter((call) => call.method === "saveTranslation");
      check("saving issues the write-back RPC", saves.length === 1, String(saves.length));
      const items = saves[0]?.input?.items ?? [];
      check("the write-back carries the anchor, not just the text",
        items.length === 1 && items[0].charStart === SEGMENTS[0].charStart && items[0].charEnd === SEGMENTS[0].charEnd,
        JSON.stringify(items));
      check("only a filled-in segment is sent",
        items.length === 1, String(items.length));
      // The reason string reaches the DOM only through the error banner. Asserting
      // on "被拒绝" would pass off the note line, which reports the count whether or
      // not the failure was surfaced.
      check("a rejected item is reported to the user",
        host.textContent.includes("missing or invalid anchor"),
        host.textContent.slice(0, 400));
    }

    const relevant = seenErrors.filter((text) => !/Warning:/.test(text) && !/not wrapped in act/.test(text));
    check("driving the translation tab raises no unexpected errors", relevant.length === 0, relevant.slice(0, 2).join(" | "));
    console.error = realError;
    try { root.unmount(); } catch { /* ignore */ }
  }
}

console.log("");
if (failures.length > 0) {
  console.log(`TRANSLATE FAILED (${failures.length}):`);
  for (const failure of failures) console.log("  - " + failure);
  process.exit(1);
}
console.log("TRANSLATE PASS");

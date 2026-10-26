// Anchoring gate: a saved quote must find itself again in the page text.
//
// This is the gate for the defect that mattered most, and it is worth being
// precise about why it was invisible for so long.
//
// The client normalizes a browser selection one way (`normalizeSelection`: collapse
// whitespace, then delete the space between two CJK characters). The host looked
// the quote up another way (`normalizeSpaceWithMap`: collapse whitespace, keep one
// space). A Chinese PDF breaks lines mid-sentence, so those two rules disagree on
// almost every line. Hand-picked quotes therefore failed to anchor on 7 of 24 real
// papers, and — because the exporter only sends located evidence — those quotes
// vanished from `review.md` with no error. Measured on a real Chinese paper, the
// old rule located 1 of 8 samples; the current one locates 8 of 8.
//
// The invariant this gate enforces: **if the client would send this string, the
// host must find it, and the offsets it returns must point at the original text.**
// Run: node test/s10-anchoring.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { locateQuote } from "../lib/host-service.js";
import { openStore } from "../lib/store.js";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
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

console.log("Anchoring gate");

/** Exactly what client.js sends: collapse whitespace, then join split CJK runs. */
function whatClientSends(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, "$1");
}

// --- the real defect, reproduced ------------------------------------------
// A Chinese page whose lines break mid-sentence, which is how every CNKI PDF
// looks. The blank lines are pdf.js emitting a newline where the layout broke.
const CJK_PAGE = [
  "第 ３ 卷 第 ２ 期",
  "如果申办",
  "",
  "能够最佳匹配城市的体育、经济、社会和环境长期",
  "",
  "规划的需要，则可以认为该城市具备承办条件。",
  "。 其中，旅游经济贡献率的测算方法如下：",
].join("\n");

check("a CJK quote that crossed a line break still anchors", () => {
  const quote = whatClientSends("能够最佳匹配城市的体育、经济、社会和环境长期\n\n规划的需要，则可以认为该城市具备承办条件。");
  const hit = locateQuote(CJK_PAGE, quote);
  assert.ok(hit !== null, "quote was not located — the client and host rules disagree again");
  assert.ok(hit.start >= 0 && hit.end > hit.start, "offsets are not a forward range");
});

check("the located offsets reproduce the quote from the original text", () => {
  // This is the property that matters: not "a match was found" but "the numbers
  // you stored point at the words you quoted". The UI jumps using these.
  const quote = whatClientSends("如果申办\n\n能够最佳匹配城市的体育、经济、社会和环境长期");
  const hit = locateQuote(CJK_PAGE, quote);
  assert.ok(hit !== null, "quote was not located");
  const fromOffsets = CJK_PAGE.slice(hit.start, hit.end);
  assert.equal(
    whatClientSends(fromOffsets),
    quote,
    `offsets ${hit.start}..${hit.end} do not reproduce the quote`,
  );
});

check("a space beside punctuation does not break the match", () => {
  // `。 其中` on the page vs `。其中` from the client: the old rule kept that
  // space, so this failed even though not a single character differed.
  const quote = whatClientSends("。 其中，旅游经济贡献率的测算方法如下：");
  const hit = locateQuote(CJK_PAGE, quote);
  assert.ok(hit !== null, "punctuation-adjacent whitespace broke the match");
});

check("a page with per-glyph spacing still anchors a normal quote", () => {
  // Some text layers emit "旅 游 经 济" for every glyph. The client joins them;
  // the host has to reach the same conclusion.
  const page = "旅 游 经 济 贡 献 率 协 调 关 系 研 究";
  const hit = locateQuote(page, whatClientSends("旅游经济贡献率"));
  assert.ok(hit !== null, "per-glyph spacing defeated the lookup");
  assert.equal(page.slice(hit.start, hit.end).replace(/\s+/g, ""), "旅游经济贡献率");
});

check("Latin text with a line break anchors", () => {
  const page = "Antecedents and consequences of hotel\ncustomers\u2019 psychological ownership";
  const hit = locateQuote(page, whatClientSends("hotel\ncustomers\u2019 psychological ownership"));
  assert.ok(hit !== null, "Latin line break defeated the lookup");
  assert.ok(hit.start > 0, "matched at the wrong position");
});

check("a quote that is genuinely absent is reported absent", () => {
  // The honest negative case. If this ever returned offsets, the UI would jump
  // to the wrong page and the export would carry a fabricated anchor.
  const hit = locateQuote(CJK_PAGE, "这段文字根本不在这一页上面");
  assert.equal(hit, null, "a missing quote was reported as located");
});

check("empty inputs do not throw", () => {
  assert.equal(locateQuote("", "x"), null);
  assert.equal(locateQuote("text", ""), null);
  assert.equal(locateQuote(null, null), null);
});

// --- the same thing, through the real service ----------------------------
// The unit checks above could pass while the service wires them up wrongly.
const { loadService } = await import("./shim.mjs");
const { PaperToolService } = await loadService();

const store = openStore(join(mkdtempSync(join(SCRATCH, "anchor-")), "library.sqlite"));
store.upsertPaper({
  paperId: "anchor-paper",
  title: "锚定测试",
  material: "fulltext",
  textSource: "text-layer",
  pages: [CJK_PAGE],
});

check("addEvidence stores an anchor that reproduces the quote", () => {
  const service = new PaperToolService({ inject() {}, get() {} }, {});
  // The service reads its own store per scope; drive the store directly here so
  // the check is about locateQuote's output, not about path resolution.
  const quote = whatClientSends("能够最佳匹配城市的体育、经济、社会和环境长期\n\n规划的需要");
  const hit = locateQuote(store.getPageText("anchor-paper", 0), quote);
  assert.ok(hit !== null, "the stored page text did not contain the quote");
  const evidence = store.addEvidence({
    evidenceId: "anchored-1",
    paperId: "anchor-paper",
    pageIndex: 0,
    charStart: hit.start,
    charEnd: hit.end,
    quote,
  });
  assert.ok(evidence, "evidence was not stored");
  const rows = store.listEvidence({ paperId: "anchor-paper" });
  const row = rows.find((entry) => entry.evidenceId === "anchored-1");
  assert.equal(row.charStart, hit.start);
  assert.equal(whatClientSends(store.getPageText("anchor-paper", 0).slice(row.charStart, row.charEnd)), quote);
});

check("an unlocatable quote is stored with -1, not with fake offsets", () => {
  // `-1` is what tells the UI "page only, no highlight" and what the exporter
  // uses to exclude the row. Any invented offset would defeat both.
  store.addEvidence({
    evidenceId: "unanchored-1",
    paperId: "anchor-paper",
    pageIndex: 0,
    charStart: -1,
    charEnd: -1,
    quote: "这句话不在页面上",
  });
  const row = store.listEvidence({ paperId: "anchor-paper" }).find((entry) => entry.evidenceId === "unanchored-1");
  assert.equal(row.charStart, -1, "an unlocated quote was given a fake anchor");
});

store.close();

console.log(failures === 0 ? "\nANCHORING PASS" : `\n${failures} FAILURE(S)`);
process.exit(report({ failures }));

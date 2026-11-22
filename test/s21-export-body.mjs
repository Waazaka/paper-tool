// 导出集成：review.md 的正文节必须存在、非空、且不与 claims 节撞名
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadService } from "./shim.mjs";

const dir = mkdtempSync(join(tmpdir(), "export-body-"));
const { PaperToolService } = await loadService();
const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: dir });
const scope = { sessionId: "export-body", workspaceRoot: dir };
const store = service.storeFor(scope);

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else {
    console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail));
    failures.push(name);
  }
}

store.upsertPaper({
  paperId: "p1", title: "Servicescape and citizenship behaviour", authors: "Li, Shuhao",
  year: "2021", venue: "IJCHM", doi: "10.1/p1", source: "test", pdfPath: "", fingerprint: "f1",
  material: "fulltext", pages: ["Servicescape shapes customer citizenship behaviour in hotels."],
  pageSources: ["text-layer"],
});
const EV1 = "e1aaaaaa1111222233334444555566";
store.addEvidence({ evidenceId: EV1, paperId: "p1", pageIndex: 0, charStart: 0, charEnd: 20, quote: "Servicescape shapes" });

const plan = await service.reviewBodyPlan(scope, {});

// Same section name on both layers, which is the collision the fix addresses.
const exported = await service.exportReview(scope, {
  style: "apa",
  bodySection: "研究现状",
  sentences: [
    { slotId: plan.slots[0].slotId, text: "服务场景塑造顾客公民行为。" },
    { slotId: plan.slots[0].slotId, text: "这句暂时没有证据。", evidenceIds: [] },
    { slotId: "s999", text: "这句槽位不存在。" },
  ],
  claims: [{ text: "服务场景影响公民行为。", section: "研究现状", evidenceIds: [EV1] }],
});

check("export succeeds", exported.ok === true, exported.reason);
const md = exported.markdown;
const headings = md.split("\n").filter((l) => /^#{2,3} /.test(l));

// --- the body section exists and is non-empty -----------------------------
check("review.md contains the body section", md.includes("## 研究现状"));
const bodyIdx = md.indexOf("## 研究现状");
const bodyEnd = md.indexOf("\n## ", bodyIdx + 1);
const bodyChunk = md.slice(bodyIdx + "## 研究现状".length, bodyEnd < 0 ? undefined : bodyEnd);
const bodyLines = bodyChunk.split("\n").filter((l) => l.trim() !== "");
check("body section has >= 3 content lines", bodyLines.length >= 3, String(bodyLines.length));
check("body line carries an [E:xxxxxxxx] anchor", /\[E:[0-9a-f]{8}\]/.test(bodyChunk));

// --- the collision that was a real bug -----------------------------------
const dupHeadings = headings.filter((h, i) => headings.indexOf(h) !== i);
check("no two headings share the same text", dupHeadings.length === 0, JSON.stringify(dupHeadings));

// --- ordering: body reads before the apparatus ---------------------------
check("body section appears before the claim section",
  md.indexOf("## 研究现状") < md.indexOf("## 论断与证据"),
  `body=${md.indexOf("## 研究现状")} claims=${md.indexOf("## 论断与证据")}`);

// --- unsupported sentences are visible, rejected ones are not ------------
check("unsupported sentence appears under 待补充证据", md.includes("### 待补充证据") && md.includes("这句暂时没有证据"));
check("rejected sentence does not appear in the document", !md.includes("这句槽位不存在"));
check("export reports the body counters",
  exported.body?.sentences === 1 && exported.body?.unsupported.length === 1 && exported.body?.rejected.length === 1,
  JSON.stringify(exported.body));

// --- an export with no sentences must not grow a body section -----------
const noBody = await service.exportReview(scope, { style: "apa" });
check("export without sentences has no body section", !noBody.markdown.includes("## 研究现状"));
check("export without sentences reports no body field", noBody.body === undefined);

// --- claims still work alongside the body -------------------------------
check("claim section still present", md.includes("## 论断与证据"));
check("claim line still carries its anchor", /\[E:[0-9a-f]{8}\]/.test(md.slice(md.indexOf("## 论断与证据"))));

// --- a claim stored outside the exported scope must not leak into review.md ---
store.upsertPaper({
  paperId: "p2", title: "Customer citizenship in service encounters", authors: "Wang, Mei",
  year: "2019", venue: "JSM", doi: "10.1/p2", source: "test", pdfPath: "", fingerprint: "f2",
  material: "fulltext", pages: ["Customer citizenship behaviour follows perceived justice."],
  pageSources: ["text-layer"],
});
const EV2 = "e2bbbbbb22223333444455556666";
store.addEvidence({ evidenceId: EV2, paperId: "p2", pageIndex: 0, charStart: 0, charEnd: 20, quote: "Customer citizenship" });

const recordedOutside = await service.recordClaims(scope, {
  claims: [{ text: "Outside scoped claim", evidenceIds: [EV2] }],
});
check("claim outside the scope is stored", recordedOutside.accepted.length === 1, JSON.stringify(recordedOutside.rejected));

const scoped = await service.exportReview(scope, { style: "apa", paperIds: ["p1"], includeStoredClaims: true });
check("scoped export succeeds", scoped.ok === true, scoped.reason);
const scopedMd = scoped.markdown ?? "";
check("scoped export omits the claim stored for another paper", !scopedMd.includes("Outside scoped claim"));
check("scoped export still carries the p1 claim", scopedMd.includes("服务场景影响公民行为"));

// --- two pieces of evidence must land in two different slots --------------
const bothPlan = await service.reviewBodyPlan(scope, { paperIds: ["p1", "p2"] });
const slotForEvidence = (id) => bothPlan.slots.find((s) => s.evidence.some((e) => e.evidenceId === id))?.slotId;
const slotP1 = slotForEvidence(EV1);
const slotP2 = slotForEvidence(EV2);
check("p1 and p2 evidence get distinct slots",
  slotP1 !== undefined && slotP2 !== undefined && slotP1 !== slotP2, `${slotP1} vs ${slotP2}`);

// Swapping evidenceIds onto another slot is the subtle invented citation: the id
// resolves, but it does not support this sentence's slot. It must be refused.
const swapped = await service.renderBody(scope, {
  paperIds: ["p1", "p2"],
  sentences: [{ slotId: slotP2, text: "拿 p1 的证据写 p2 的句子。", evidenceIds: [EV1] }],
});
check("renderBody refuses evidence borrowed from the other slot",
  swapped.summary.accepted === 0 && swapped.summary.rejected === 1, JSON.stringify(swapped.summary));
check("borrowed evidence never reaches the rendered body", swapped.markdown === "", swapped.markdown);

// Evidence-narrowed export: the slot and the claim that reach outside the exported
// evidence set must be refused, and the mixed claim must not be written at all.
const mixed = "混用 p1 与 p2 证据的论断。";
const scopedBody = await service.exportReview(scope, {
  style: "apa", evidenceIds: [EV1], bodySection: "研究现状",
  sentences: [{ slotId: slotP1, text: "只用 p1 的证据写这句。" }, { slotId: slotP2, text: "拿 p2 的证据写这句。" }],
  claims: [
    { text: "只用 p1 证据的论断。", section: "研究现状", evidenceIds: [EV1] },
    { text: mixed, section: "研究现状", evidenceIds: [EV1, EV2] },
  ],
});
check("evidence-narrowed export succeeds", scopedBody.ok === true, scopedBody.reason);
const scopedBodyMd = scopedBody.markdown ?? "";
check("only the in-scope sentence and claim are rendered",
  scopedBodyMd.includes("只用 p1 的证据写这句") && !scopedBodyMd.includes("拿 p2 的证据写这句") &&
  scopedBodyMd.includes("只用 p1 证据的论断") && !scopedBodyMd.includes(mixed));
check("body and claims report the rejected sentence and claim",
  scopedBody.body?.sentences === 1 && scopedBody.body?.rejected.length === 1 &&
  scopedBody.claims?.accepted === 1 && scopedBody.claims?.rejected === 1,
  JSON.stringify([scopedBody.body, scopedBody.claims]));
check("the mixed claim never reaches the store", store.listClaims({ limit: 5000 }).every((c) => c.text !== mixed));

// --- formatCitations honours optional paperIds and matches export scope 100% ---
const citedScoped = await service.formatCitations(scope, { style: "apa", anchor: "anchored", paperIds: ["p1"] });
check("formatCitations with paperIds succeeds", citedScoped.ok === true, citedScoped.reason ?? "");
check("formatCitations with paperIds only cites the requested paper",
  citedScoped.entries.length === 1 && citedScoped.entries[0].paperId === "p1",
  JSON.stringify(citedScoped.entries.map((e) => e.paperId)));
check("formatCitations bibliography matches scoped exportReview bibliography",
  citedScoped.bibliography === scoped.bibliography,
  JSON.stringify({ preview: citedScoped.bibliography, exported: scoped.bibliography }));

const citedIntersect = await service.formatCitations(scope, {
  style: "apa", anchor: "anchored", evidenceIds: [EV1, EV2], paperIds: ["p1"],
});
check("formatCitations intersects evidenceIds and paperIds",
  citedIntersect.ok === true && citedIntersect.entries.length === 1 && citedIntersect.entries[0].paperId === "p1",
  JSON.stringify(citedIntersect.entries.map((e) => e.paperId)));

const citedEmptyScope = await service.formatCitations(scope, { style: "apa", anchor: "anchored", paperIds: ["no-such-paper"] });
check("formatCitations with unmatched paperIds fails honestly",
  citedEmptyScope.ok === false && citedEmptyScope.entries.length === 0 && citedEmptyScope.bibliography === "",
  JSON.stringify({ ok: citedEmptyScope.ok, entries: citedEmptyScope.entries.length }));

const citedUnfiltered = await service.formatCitations(scope, { style: "apa", anchor: "anchored", paperIds: [] });
check("formatCitations treats empty paperIds array as unfiltered",
  citedUnfiltered.ok === true && citedUnfiltered.entries.length === 2,
  JSON.stringify(citedUnfiltered.entries.map((e) => e.paperId)));

store.close?.();
rmSync(dir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log("\nEXPORT-BODY FAILED (" + failures.length + "):");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
console.log("\nEXPORT-BODY PASS");

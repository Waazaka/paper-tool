// Review body: slots bound to evidence before any words exist, and anchors that
// must resolve or the sentence is refused.
//
// The whole point of this gate is the refusal paths. A generator that produces
// prose is easy; one that provably cannot produce unattributed prose is the feature.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadService } from "./shim.mjs";

const dir = mkdtempSync(join(tmpdir(), "body-gate-"));
const { PaperToolService } = await loadService();
const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: dir });
const scope = { sessionId: "body-gate", workspaceRoot: dir };
const store = service.storeFor(scope);

const failures = [];
function check(name, ok, detail) {
  if (ok) {
    console.log("  ok   " + name);
  } else {
    console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail));
    failures.push(name);
  }
}

// --- 0. empty library must refuse, with a reason, not an empty shell --------
{
  const plan = await service.reviewBodyPlan(scope, {});
  check("empty library refuses to build a plan", plan.ok === false);
  check("refusal carries a reason", typeof plan.reason === "string" && plan.reason.length > 0, plan.reason);
  check("refusal returns no slots", Array.isArray(plan.slots) && plan.slots.length === 0);
  check("refusal explains what to do instead", /paper_evidence|导入/.test(plan.reason ?? ""), plan.reason);
}

// --- fixture: two papers, four evidence rows --------------------------------
const mkPaper = (id, title, year, pageText) => store.upsertPaper({
  paperId: id, title, authors: "Li, Shuhao", year, venue: "IJCHM", doi: `10.1/${id}`,
  source: "test", pdfPath: "", fingerprint: `fp-${id}`, material: "fulltext",
  pages: [pageText], pageSources: ["text-layer"],
});
mkPaper("p1", "Servicescape and citizenship behaviour", "2021",
  "Servicescape shapes customer citizenship behaviour in hotels through engagement.");
mkPaper("p2", "Psychological ownership in hospitality", "2023",
  "Psychological ownership mediates the effect of servicescape on customer behaviour.");

const addEv = (id, paperId, start, quote) => store.addEvidence({
  evidenceId: id, paperId, pageIndex: 0, charStart: start, charEnd: start + quote.length, quote,
});
// Ids are the shape the real library uses (randomUUID, 8-hex prefix in anchors);
// short made-up ids like "e1" would pass the logic but not exercise the `[E:xxxxxxxx]`
// tag format, which is what a reader actually sees.
const E1 = "e1aaaaaa1111222233334444555566";
const E2 = "e2bbbbbb1111222233334444555566";
const E3 = "e3cccccc1111222233334444555566";
const E4 = "e4dddddd1111222233334444555566";
addEv(E1, "p1", 0, "Servicescape shapes customer citizenship behaviour");
addEv(E2, "p1", 56, "through engagement");
addEv(E3, "p2", 0, "Psychological ownership mediates the effect of servicescape");
addEv(E4, "p2", 62, "on customer behaviour");

// --- 1. the plan binds evidence before words exist -------------------------
const plan = await service.reviewBodyPlan(scope, {});
check("plan is ok once evidence exists", plan.ok === true, plan.reason);
check("one slot per evidence row", plan.slots.length === 4, String(plan.slots.length));
check("every slot carries at least one evidenceId",
  plan.slots.every((s) => Array.isArray(s.evidence) && s.evidence.length > 0));
check("every slot has a stable slotId", plan.slots.every((s) => typeof s.slotId === "string" && s.slotId !== ""));
check("slotIds are unique", new Set(plan.slots.map((s) => s.slotId)).size === plan.slots.length);
check("slots carry page anchors", plan.slots.every((s) => typeof s.pageIndex === "number" && s.pageIndex >= 0));
check("slots carry char offsets (so a reader can jump to the exact text)",
  plan.slots.every((s) => typeof s.charStart === "number" && s.charStart >= 0), JSON.stringify(plan.slots.map((s) => s.charStart)));
check("plan text lists every slot for the model", plan.text.split("\n").filter((l) => l.startsWith("- s")).length === 4);
check("plan groups by paper", plan.text.includes("2 篇文献"), plan.text.slice(0, 80));

// A slot's evidence binding is what renderBody will hold the caller to.
// A slot's topic must be the stored quote itself, not a paraphrase. Slot ids are
// assigned in `listEvidence` order, which is newest-first, so do not assume s1 is
// the first paper added — look up the slot by the evidence it actually carries.
const slot1 = plan.slots.find((s) => s.evidence.some((e) => e.evidenceId === E1));
check("slot topic comes from the quote, not invented",
  slot1 !== undefined && slot1.topic.includes("Servicescape"), slot1?.topic);

// --- 2. a well-formed body renders ---------------------------------------
const good = await service.renderBody(scope, {
  section: "机制",
  sentences: plan.slots.map((slot) => ({ slotId: slot.slotId, text: `关于${slot.paperTitle}的一句话。` })),
});
check("well-formed body renders", good.ok === true, good.reason);
check("every sentence accepted", good.summary.accepted === 4, JSON.stringify(good.summary));
check("nothing rejected", good.summary.rejected === 0, JSON.stringify(good.rejected));
check("markdown is non-empty", good.markdown.trim().length > 0);
check("section is honoured", good.section === "机制", good.section);
check("markdown sentence count matches", good.markdown.split("\n\n").length === 4, String(good.markdown.split("\n\n").length));

// A sentence must be attributed to the evidence its own slot was bound to, not to
// whatever evidence happened to be nearby.
check("sentence rendered for a slot carries that slot's own evidence",
  good.sentences.find((s) => s.slotId === slot1?.slotId)?.anchors[0]?.evidenceId === E1,
  JSON.stringify(good.sentences.find((s) => s.slotId === slot1?.slotId)?.anchors?.map((a) => a.evidenceId)));

// --- 3. every anchor resolves to title + page + charStart ---------------
check("each accepted sentence carries anchors", good.sentences.every((s) => s.anchors.length > 0));
const allAnchors = good.sentences.flatMap((s) => s.anchors);
check("anchors resolve to a paper title", allAnchors.every((a) => typeof a.paperTitle === "string" && a.paperTitle !== ""));
check("anchors resolve to a page", allAnchors.every((a) => typeof a.pageIndex === "number" && a.pageIndex >= 0));
check("anchors resolve to charStart >= 0", allAnchors.every((a) => typeof a.charStart === "number" && a.charStart >= 0));
check("anchors carry the original quote", allAnchors.every((a) => typeof a.quote === "string" && a.quote !== ""));
check("markdown embeds one [E:xxxxxxxx] tag per anchor",
  (good.markdown.match(/\[E:[0-9a-f]{8}\]/g) ?? []).length === allAnchors.length,
  `${(good.markdown.match(/\[E:[0-9a-f]{8}\]/g) ?? []).length} tags vs ${allAnchors.length} anchors`);

// Slot ids follow `listEvidence` order (newest evidence first), so tests must not
// assume s1 is the first paper added. Resolve the slot that owns a given evidence id.
const slotOf = (evidenceId) => plan.slots.find((s) => s.evidence.some((e) => e.evidenceId === evidenceId))?.slotId;
const slotP1 = slotOf(E1);
const slotP2 = slotOf(E3);
check("every fixture piece of evidence owns a slot", slotP1 !== undefined && slotP2 !== undefined,
  JSON.stringify({ slotP1, slotP2 }));

// --- 4. refusal: unknown slot -------------------------------------------
const unknown = await service.renderBody(scope, {
  sentences: [{ slotId: "s999", text: "这句来自一个不存在的槽位。" }],
});
check("unknown slot is rejected", unknown.summary.rejected === 1, JSON.stringify(unknown.summary));
check("unknown slot is NOT rendered", !unknown.markdown.includes("不存在的槽位"));
check("rejection names the slot", String(unknown.rejected[0]?.reason ?? "").includes("s999"));

// --- 5. refusal: no slotId at all (free prose) -------------------------
const free = await service.renderBody(scope, {
  sentences: [{ text: "完全自由发挥的一句话。" }],
});
check("a sentence with no slotId is rejected", free.summary.rejected === 1, JSON.stringify(free.summary));
check("free prose is not rendered", free.summary.accepted === 0);

// --- 6. refusal: evidence from another slot (the subtle case) -----------
// The id exists, so a naive check passes — but it is not what this slot was bound
// to, so the sentence would be attributed to evidence that does not support it.
const crossSlot = await service.renderBody(scope, {
  sentences: [{ slotId: slotP1, text: "张冠李戴的一句。", evidenceIds: [E3] }],
});
check("cross-slot evidence is rejected", crossSlot.summary.rejected === 1, JSON.stringify(crossSlot.summary));
check("cross-slot rejection explains why", /not bound to this slot/.test(String(crossSlot.rejected[0]?.reason ?? "")), crossSlot.rejected[0]?.reason);
check("cross-slot rejection lists the allowed ids", Array.isArray(crossSlot.rejected[0]?.allowed) && crossSlot.rejected[0].allowed.includes(E1));

// --- 7. refusal: evidence id that does not exist at all ----------------
const fabricated = await service.renderBody(scope, {
  sentences: [{ slotId: slotP1, text: "编造锚点。", evidenceIds: ["deadbeef-0000-0000-0000-000000000000"] }],
});
check("fabricated evidence id is rejected", fabricated.summary.rejected === 1, JSON.stringify(fabricated.summary));
check("fabricated id does not reach the markdown", !fabricated.markdown.includes("编造锚点"));

// --- 8. unsupported sentences are reported, not dropped ----------------
const unsupported = await service.renderBody(scope, {
  sentences: [{ slotId: slotP1, text: "这句我暂时没有证据。", evidenceIds: [] }],
});
check("sentence with no evidence is stored as unsupported", unsupported.unsupported.length === 1, JSON.stringify(unsupported.summary));
check("unsupported sentence is still kept (visible, not vanished)", unsupported.unsupported[0].text.includes("暂时没有证据"));
check("unsupported sentence is not in the markdown", !unsupported.markdown.includes("暂时没有证据"),
  "unsupported text leaked into the body");

// --- 9. mixed payload: good + bad, bad never contaminates output ------
const mixed = await service.renderBody(scope, {
  sentences: [
    { slotId: slotP1, text: "好的一句。" },
    { slotId: "s999", text: "坏的一句。" },
    { slotId: slotP2, text: "没有证据的一句。", evidenceIds: [] },
  ],
});
check("mixed payload keeps the good sentence", mixed.summary.accepted === 1);
check("mixed payload reports the bad one", mixed.summary.rejected === 1);
check("mixed payload reports the unsupported one", mixed.summary.unsupported === 1);
check("mixed markdown contains only the good sentence",
  mixed.markdown.includes("好的一句") && !mixed.markdown.includes("坏的一句") && !mixed.markdown.includes("没有证据的一句"));

// --- 10. dropping a sentence is reported, not silently accepted ------
const dropped = await service.renderBody(scope, { sentences: [{ slotId: slotP1, text: "只写一句。" }] });
check("partial coverage reports slot count separately from accepted",
  dropped.summary.slots === 4 && dropped.summary.accepted === 1,
  JSON.stringify(dropped.summary));

// --- 11. empty payload is an error, not an empty review --------------
let emptyRefused = null;
try {
  await service.renderBody(scope, { sentences: [] });
} catch (error) {
  emptyRefused = error;
}
check("empty sentences throws", emptyRefused !== null, "returned a result instead");

// --- 12. cross-plan: a slotId must not identify different evidence ---------
// Two single-evidence plans over two different evidence rows. If slotIds are only
// positional (`s1`, `s2`, ... restarting inside every plan), both plans mint the
// *same* id for different evidence — and a slotId taken from plan A is then a
// perfectly valid slot in plan B. That is a cross-plan leak, not a hypothetical.
const planA = await service.reviewBodyPlan(scope, { evidenceIds: [E1] });
const planB = await service.reviewBodyPlan(scope, { evidenceIds: [E3] });
check("single-evidence plan A has one slot", planA.ok === true && planA.slots.length === 1, JSON.stringify(planA.slots?.length));
check("single-evidence plan B has one slot", planB.ok === true && planB.slots.length === 1, JSON.stringify(planB.slots?.length));
check("plan A slot carries the evidence it was scoped to",
  planA.slots[0]?.evidence?.[0]?.evidenceId === E1, JSON.stringify(planA.slots[0]?.evidence));
check("plan B slot carries the evidence it was scoped to",
  planB.slots[0]?.evidence?.[0]?.evidenceId === E3, JSON.stringify(planB.slots[0]?.evidence));
const slotA = planA.slots[0]?.slotId;
const slotB = planB.slots[0]?.slotId;
check("plans over different evidence mint different slotIds", slotA !== slotB, `A=${slotA} B=${slotB}`);

// The literal leak: plan A's slotId, no sentence.evidenceIds ("use the slot's
// binding"), and plan B's evidence as the top-level render scope. If the rebuild
// ignores that scope, the sentence is accepted and B's anchor is printed.
const crossPlan = await service.renderBody(scope, {
  section: "跨计划",
  evidenceIds: [E3],
  sentences: [{ slotId: slotA, text: "这句属于计划 A 的证据。" }],
});
const crossMarkdown = typeof crossPlan.markdown === "string" ? crossPlan.markdown : "";
check("cross-plan sentence is accepted zero times", (crossPlan.summary?.accepted ?? 0) === 0,
  JSON.stringify(crossPlan.summary ?? crossPlan));
check("cross-plan render never emits plan B's evidence tag", !crossMarkdown.includes(`[E:${E3.slice(0, 8)}]`), crossMarkdown);
check("cross-plan render never emits plan B's quote", !crossMarkdown.includes("Psychological ownership"), crossMarkdown);
check("cross-plan render emits no anchors at all", !crossMarkdown.includes("[E:"), crossMarkdown);

store.close?.();
rmSync(dir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log("\nREVIEW-BODY FAILED (" + failures.length + "):");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
console.log("\nREVIEW-BODY PASS");

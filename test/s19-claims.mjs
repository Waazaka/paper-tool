// Claims layer: writing, linking, and refusing invented citations.
//
// No corpus and no network needed: everything runs on a temporary database.
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadService } from "./shim.mjs";

const dir = mkdtempSync(join(tmpdir(), "claims-gate-"));
const { PaperToolService } = await loadService();
const service = new PaperToolService({ inject() {}, get() {} }, { homeDir: dir });
const scope = { sessionId: "claims-gate", workspaceRoot: dir };
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

// --- fixture: one paper, one page, three evidence rows -----------------------
const paper = store.upsertPaper({
  paperId: "p1",
  title: "Hotel servicescape and customer citizenship behaviour",
  authors: "Li, Shuhao",
  year: "2021",
  venue: "IJCHM",
  doi: "10.1108/x",
  source: "test",
  pdfPath: "",
  fingerprint: "fp1",
  material: "fulltext",
  pages: ["Servicescape shapes customer citizenship behaviour in hotels."],
  pageSources: ["text-layer"],
});
const ev = (id, start) => store.addEvidence({
  evidenceId: id,
  paperId: paper.paperId,
  pageIndex: 0,
  charStart: start,
  charEnd: start + 20,
  quote: "Servicescape shapes " + id,
});
ev("e1", 0);
ev("e2", 21);
ev("e3", 42);

// --- 1. a claim with two evidence rows writes both tables --------------------
const written = store.upsertClaim({
  claimId: "c1",
  text: "服务场景影响顾客公民行为",
  section: "机制",
  evidence: [
    { evidenceId: "e1", stance: "support", strength: "high" },
    { evidenceId: "e2", stance: "support", strength: "medium" },
  ],
});
check("claim row written", written.claim !== null && written.claim.claimId === "c1");
check("two evidence links written", written.links.length === 2, String(written.links.length));
check("stance and strength stored", written.links.every((l) => l.stance === "support"));
check("store.stats reports claims > 0", store.stats().claims === 1, String(store.stats().claims));

// --- 2. stats reflect the write (the original P0 symptom was claims always 0) --
check("stats.claims is not stuck at 0", store.stats().claims > 0);

// --- 3. one claim can bind more than one evidence row (many-to-many) --------
check("claim_evidence is many-to-many", store.claimEvidence("c1").length >= 2);

// --- 4. a second claim on the same evidence row is allowed ------------------
store.upsertClaim({ claimId: "c2", text: "另一个论断", section: "机制", evidence: [{ evidenceId: "e1" }] });
check("same evidence can serve two claims", store.claimEvidence("c2").length === 1);
check("two claims now stored", store.stats().claims === 2);

// --- 5. refused: unknown evidence id (invented citation) --------------------
let refused = null;
try {
  store.upsertClaim({ claimId: "c3", text: "编造的论断", section: "机制", evidence: [{ evidenceId: "does-not-exist" }] });
} catch (error) {
  refused = error;
}
check("unknown evidenceId is rejected", refused !== null, "no throw");
check("rejection names the missing id", String(refused?.message ?? "").includes("does-not-exist"));
check("rejected claim is NOT stored", store.getClaim("c3") === null);
check("rejection did not create a partial claim", store.stats().claims === 2, String(store.stats().claims));

// --- 6. refused: mixed valid and invalid ids -> all-or-nothing --------------
let partial = null;
try {
  store.upsertClaim({ claimId: "c4", text: "半真半假", section: "机制", evidence: [{ evidenceId: "e1" }, { evidenceId: "nope" }] });
} catch (error) {
  partial = error;
}
check("mixed valid+invalid ids rejected", partial !== null);
check("no partial claim left behind", store.getClaim("c4") === null);
check("existing claim c1 untouched by the failed write", store.claimEvidence("c1").length === 2);

// --- 7. idempotent re-upsert does not duplicate rows -----------------------
store.upsertClaim({
  claimId: "c1",
  text: "服务场景影响顾客公民行为（修订）",
  section: "机制",
  evidence: [{ evidenceId: "e1" }, { evidenceId: "e2" }],
});
check("re-upsert keeps one claim row", store.stats().claims === 2, String(store.stats().claims));
check("re-upsert replaces links, not appends", store.claimEvidence("c1").length === 2);
check("re-upsert updated the text", store.getClaim("c1").text.includes("修订"));

// --- 8. shrinking the link set actually drops stale bindings --------------
store.upsertClaim({ claimId: "c1", text: "只剩一条证据", section: "机制", evidence: [{ evidenceId: "e1" }] });
check("removed link is deleted, not left stale", store.claimEvidence("c1").length === 1);

// --- 9. unsupported claims are reported, not dropped -----------------------
store.upsertClaim({ claimId: "c5", text: "没有证据的论断", section: "机制", evidence: [] });
const unsupported = store.unsupportedClaims();
check("unsupported claim is stored", store.getClaim("c5") !== null);
check("unsupported claim is reported", unsupported.some((c) => c.claimId === "c5"));
check("supported claims are not reported as unsupported", !unsupported.some((c) => c.claimId === "c1"));

// --- 10. listClaims joins evidence ----------------------------------------
const listed = store.listClaims();
check("listClaims returns every claim", listed.length === 3, String(listed.length));
const c1 = listed.find((c) => c.claimId === "c1");
check("listClaims attaches evidence rows", Array.isArray(c1?.evidence));
check("attached evidence carries the quote", typeof c1?.evidence?.[0]?.quote === "string");
check("attached evidence carries the page", typeof c1?.evidence?.[0]?.pageIndex === "number");

// --- 11. deleting a claim removes its links -------------------------------
store.deleteClaim("c2");
check("deleted claim is gone", store.getClaim("c2") === null);
check("deleted claim's links are gone", store.claimEvidence("c2").length === 0);
check("stats dropped by one", store.stats().claims === 2, String(store.stats().claims));

// --- 12. empty id is rejected, not silently skipped -----------------------
let emptyRefused = null;
try {
  store.upsertClaim({ claimId: "c6", text: "空 id", section: "机制", evidence: [{ evidenceId: "" }] });
} catch (error) {
  emptyRefused = error;
}
check("empty evidenceId is rejected", emptyRefused !== null, "inserted a link with an empty id");

// --- 13. claim identity is content-derived, so re-running is idempotent -----
// Regression: the first implementation used a random UUID per claim, so exporting
// the same draft twice grew the table with duplicates. The table cannot dedupe by
// text by itself (claimId is the key), so the *producer* must derive a stable one.
{
  const claimIdOf = (section, text) =>
    `claim-${createHash("sha256").update(`${section}\u0000${text}`).digest("hex").slice(0, 32)}`;
  const a = store.upsertClaim({ claimId: claimIdOf("机制", "稳定的论断"), text: "稳定的论断", section: "机制", evidence: [{ evidenceId: "e1" }] });
  const countAfterFirst = store.stats().claims;
  const b = store.upsertClaim({ claimId: claimIdOf("机制", "稳定的论断"), text: "稳定的论断", section: "机制", evidence: [{ evidenceId: "e1" }] });
  check("same sentence yields the same claimId", a.claim.claimId === b.claim.claimId);
  check("re-recording does not add a row", store.stats().claims === countAfterFirst, `${countAfterFirst} -> ${store.stats().claims}`);
  check("claim_evidence did not duplicate either", store.claimEvidence(a.claim.claimId).length === 1);
}

store.close?.();
rmSync(dir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log("\nCLAIMS FAILED (" + failures.length + "):");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
console.log("\nCLAIMS PASS");

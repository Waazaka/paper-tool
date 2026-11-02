// Reader annotations: persisted highlights with their own notes, never counted as
// evidence.
//
// The interesting assertions here are the separations, not the round-trip: an
// annotation must survive a reopen, must not inflate the evidence count, and must
// disappear when its paper does. Those are the three ways a "notes" feature rots.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../lib/store.js";

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else {
    console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail));
    failures.push(name);
  }
}

const dir = mkdtempSync(join(tmpdir(), "annot-gate-"));
const dbPath = join(dir, "library.sqlite");

// --- 1. schema v6 has the table -----------------------------------------
{
  const store = openStore(dbPath);
  const db = new DatabaseSync(dbPath);
  check("user_version is 6", db.prepare("PRAGMA user_version").get().user_version === 6,
    String(db.prepare("PRAGMA user_version").get().user_version));
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='annotations'").get();
  check("annotations table exists", table !== undefined);
  const cols = db.prepare("PRAGMA table_info(annotations)").all().map((c) => c.name);
  check("annotation has an anchor (pageIndex/charStart/charEnd)",
    cols.includes("pageIndex") && cols.includes("charStart") && cols.includes("charEnd"), JSON.stringify(cols));
  check("annotation has a separate note column", cols.includes("note"), JSON.stringify(cols));
  check("annotation has a quote column distinct from note", cols.includes("quote"));
  check("annotation has tags", cols.includes("tags"));
  check("foreign_keys pragma is on (needed for the cascade)",
    db.prepare("PRAGMA foreign_keys").get().foreign_keys === 1);
  db.close();
  store.close?.();

  // stats reports the counter, starting at zero
  const store2 = openStore(dbPath);
  check("stats exposes an annotation counter", typeof store2.stats().annotations === "number",
    JSON.stringify(store2.stats().annotations));
  check("annotation counter starts at 0", store2.stats().annotations === 0);
  store2.close?.();
}

// --- 2. write an annotation and read it back ----------------------------
const PAPER = "p1";
const ANN1 = "a1aaaaaa1111222233334444555566";
{
  const store = openStore(dbPath);
  store.upsertPaper({
    paperId: PAPER, title: "Servicescape and citizenship", authors: "Li, Shuhao", year: "2021",
    venue: "IJCHM", doi: "10.1/p1", source: "test", pdfPath: "", fingerprint: "f1",
    material: "fulltext",
    pages: ["Servicescape shapes customer citizenship behaviour in hotels through engagement."],
    pageSources: ["text-layer"],
  });

  const written = store.upsertAnnotation({
    annotationId: ANN1,
    paperId: PAPER,
    pageIndex: 0,
    charStart: 0,
    charEnd: 47,
    quote: "Servicescape shapes customer citizenship behaviour",
    note: "这段是我自己的话，不是原文。",
    tags: ["机制", "重要"],
    color: "green",
  });

  check("annotation round-trips", written.annotationId === ANN1);
  check("pageIndex stored", written.pageIndex === 0);
  check("charStart stored", written.charStart === 0);
  check("charEnd stored", written.charEnd === 47);
  check("quote is the selected text", written.quote.startsWith("Servicescape shapes"));
  check("note is the user's own words", written.note.includes("我自己的话"));
  check("quote and note are separate fields (note is not inside quote)",
    !written.quote.includes("我自己的话") && !written.note.includes("Servicescape shapes"));
  check("tags come back as an array", Array.isArray(written.tags) && written.tags.length === 2, JSON.stringify(written.tags));
  check("tags survived the comma join", written.tags.includes("机制") && written.tags.includes("重要"));
  check("color stored", written.color === "green");
  check("createdAt is set", typeof written.createdAt === "string" && written.createdAt !== "");
  store.close?.();
}

// --- 3. it survives closing and reopening (this is the whole point) -----
{
  const store = openStore(dbPath);
  const back = store.getAnnotation(ANN1);
  check("annotation is still there after reopening the database", back !== null);
  check("its anchor survived", back?.charStart === 0 && back?.charEnd === 47);
  check("its quote survived", String(back?.quote).includes("Servicescape"));
  check("its note survived", String(back?.note).includes("我自己的话"));
  check("its tags survived", back?.tags?.length === 2);

  // --- 4. annotations must not inflate the evidence count --------------
  const before = store.stats();
  for (let i = 0; i < 5; i += 1) {
    store.upsertAnnotation({
      annotationId: `a-extra-${i}`,
      paperId: PAPER,
      pageIndex: 0,
      charStart: i * 5,
      charEnd: i * 5 + 4,
      quote: `片段 ${i}`,
      note: `笔记 ${i}`,
    });
  }
  const after = store.stats();
  check("adding 5 annotations leaves evidence count unchanged",
    after.evidence === before.evidence, `${before.evidence} -> ${after.evidence}`);
  check("adding 5 annotations raises the annotation count by 5",
    after.annotations === before.annotations + 5, `${before.annotations} -> ${after.annotations}`);
  check("annotations are not counted as claims either", after.claims === before.claims);

  // The annotation counter must be the annotations table alone. A counter that
  // added evidence into it would pass every assertion above (evidence was still 0
  // when the 5 annotations were added) while reporting a number that means nothing.
  {
    const beforeEvidence = store.stats();
    store.addEvidence({
      evidenceId: "e1aaaaaa1111222233334444555566", paperId: PAPER, pageIndex: 0,
      charStart: 0, charEnd: 47, quote: "Servicescape shapes customer citizenship behaviour",
    });
    store.addEvidence({
      evidenceId: "e2bbbbbb1111222233334444555566", paperId: PAPER, pageIndex: 0,
      charStart: 56, charEnd: 74, quote: "through engagement",
    });
    const afterEvidence = store.stats();
    check("adding evidence does not change the annotation count",
      afterEvidence.annotations === beforeEvidence.annotations,
      `${beforeEvidence.annotations} -> ${afterEvidence.annotations}`);
    check("adding evidence does raise the evidence count",
      afterEvidence.evidence === beforeEvidence.evidence + 2,
      `${beforeEvidence.evidence} -> ${afterEvidence.evidence}`);
  }

  // --- 5. list by paper, ordered by page --------------------------------
  const listed = store.listAnnotations({ paperId: PAPER });
  check("listAnnotations returns every annotation for the paper", listed.length === 6, String(listed.length));
  const pages = listed.map((a) => a.pageIndex);
  check("annotations are ordered by page", pages.every((p, i) => i === 0 || p >= pages[i - 1]), JSON.stringify(pages));
  check("countAnnotations agrees with the list", store.countAnnotations({ paperId: PAPER }) === listed.length);

  // A second paper must not leak into the first paper's list.
  store.upsertPaper({
    paperId: "p2", title: "Other paper", authors: "B", year: "2022", venue: "V", doi: "10.1/p2",
    source: "test", pdfPath: "", fingerprint: "f2", material: "fulltext",
    // Three pages so that page ordering is actually exercised: with every annotation
    // on page 0 an unsorted query still looks sorted, and the ordering assertion
    // would pass on a list that was never sorted at all.
    pages: ["Page zero text.", "Page one text.", "Page two text."],
    pageSources: ["text-layer", "text-layer", "text-layer"],
  });
  store.upsertAnnotation({ annotationId: "a-p2", paperId: "p2", pageIndex: 0, charStart: 0, charEnd: 5, quote: "Other", note: "" });
  // Inserted out of page order on purpose: page 2, then 1, then 0.
  //
  // The ids are deliberately NOT in page order. With ids like `a-p2-p2`/`a-p2-p1`/
  // `a-p2-p0` a query that ordered by `annotationId` instead of `pageIndex` would
  // produce the same output, so the assertion would pass on unsorted data and the
  // mutation test would miss it — which is exactly what happened the first time.
  const idForPage = { 0: "a-p2-zeta", 1: "a-p2-mu", 2: "a-p2-alpha" };
  for (const pageIndex of [2, 1, 0]) {
    store.upsertAnnotation({
      annotationId: idForPage[pageIndex], paperId: "p2", pageIndex,
      charStart: 0, charEnd: 4, quote: `Page ${pageIndex}`, note: "",
    });
  }
  check("per-paper filter excludes other papers",
    store.listAnnotations({ paperId: PAPER }).length === 6, String(store.listAnnotations({ paperId: PAPER }).length));
  check("the other paper has its own annotations",
    store.listAnnotations({ paperId: "p2" }).length === 4, String(store.listAnnotations({ paperId: "p2" }).length));
  check("global count includes both", store.countAnnotations() === 10, String(store.countAnnotations()));

  // The ordering assertion that survives a page-insensitive query: assert the exact
  // sequence across distinct pages, not merely that it is non-decreasing.
  {
    const ordered = store.listAnnotations({ paperId: "p2" }).map((a) => a.pageIndex);
    check("annotations come back in page order across distinct pages",
      JSON.stringify(ordered) === JSON.stringify([0, 0, 1, 2]), JSON.stringify(ordered));
  }

  // --- 6. update replaces fields without duplicating the row -----------
  const countBefore = store.countAnnotations();
  store.upsertAnnotation({
    annotationId: ANN1, paperId: PAPER, pageIndex: 0, charStart: 0, charEnd: 47,
    quote: "Servicescape shapes customer citizenship behaviour",
    note: "改过的笔记", tags: ["机制"],
  });
  const updated = store.getAnnotation(ANN1);
  check("upsert updates rather than duplicates", store.countAnnotations() === countBefore, String(store.countAnnotations()));
  check("upsert replaced the note", updated.note === "改过的笔记", updated.note);
  check("upsert replaced the tags", updated.tags.length === 1, JSON.stringify(updated.tags));
  check("upsert set updatedAt", typeof updated.updatedAt === "string" && updated.updatedAt !== "");

  // --- 7. unknown paper is refused with a nameable code ----------------
  let refused = null;
  try {
    store.upsertAnnotation({ annotationId: "a-orphan", paperId: "no-such-paper", pageIndex: 0, quote: "x" });
  } catch (error) {
    refused = error;
  }
  check("annotation on an unknown paper is refused", refused !== null, "inserted an orphan");
  check("the refusal names the problem", refused?.code === "paper-tool/unknown-paper", refused?.code);
  check("the refused annotation was not stored", store.getAnnotation("a-orphan") === null);

  // --- 8. deleting a paper cascades to its annotations -----------------
  const beforeDelete = store.countAnnotations();
  const p2Count = store.listAnnotations({ paperId: "p2" }).length;
  check("the paper about to be deleted owns several annotations", p2Count === 4, String(p2Count));
  store.deletePaper?.("p2");
  if (typeof store.deletePaper === "function") {
    check("deleting a paper removed exactly its own annotations",
      store.countAnnotations() === beforeDelete - p2Count,
      `${beforeDelete} - ${p2Count} -> ${store.countAnnotations()}`);
    check("the other paper's annotations are untouched", store.getAnnotation(ANN1) !== null);
    check("no orphan rows remain", store.listAnnotations({ paperId: "p2" }).length === 0);
  } else {
    // deletePaper may live on the service; exercise the cascade directly instead.
    const raw = new DatabaseSync(dbPath);
    raw.exec("DELETE FROM papers WHERE paperId = 'p2'");
    const orphans = raw.prepare("SELECT COUNT(*) c FROM annotations WHERE paperId = 'p2'").get().c;
    raw.close();
    check("deleting a paper via SQL cascades to its annotations", orphans === 0, `${orphans} orphan rows left`);
  }

  store.close?.();
}

// --- 9. deleting an annotation removes only that one -------------------
{
  const store = openStore(dbPath);
  const before = store.countAnnotations();
  store.deleteAnnotation(ANN1);
  check("deleteAnnotation removes one row", store.countAnnotations() === before - 1);
  check("the deleted annotation is gone", store.getAnnotation(ANN1) === null);
  check("other annotations remain", store.countAnnotations() > 0);
  store.close?.();
}

rmSync(dir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log("\nANNOTATIONS FAILED (" + failures.length + "):");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
console.log("\nANNOTATIONS PASS");

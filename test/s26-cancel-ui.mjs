// The UI half of cancellation: is there actually a button, and does the busy row say
// what is happening?
//
// This is a source-level gate rather than a render gate because the behaviour it
// checks is about wiring, not markup: a component that renders a Cancel button whose
// onClick does nothing would pass a render test. The things that can go wrong are
// "no controller exists", "the controller's signal is never passed to the call that
// needs it", and "the abort is reported as an error" — all of which are visible in
// the source and none of which a DOM snapshot would catch.
import { readFileSync } from "node:fs";

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log("  ok   " + name);
  else {
    console.log("  FAIL " + name + (detail === undefined ? "" : " -> " + detail));
    failures.push(name);
  }
}

const src = readFileSync("client.js", "utf8");

// --- 1. there is more than one controller ---------------------------------
{
  const controllers = (src.match(/new AbortController\(/g) ?? []).length;
  check("client.js has at least two AbortControllers", controllers >= 2, String(controllers));
  // The reader already had one. The new one must belong to the shared busy path, not
  // to another reader-local controller — otherwise the cancel button has nothing to
  // abort outside the reader.
  check("a controller is created in the cancellable-job helper",
    /const runCancellable = useCallback\(async \(stage, work\) => \{[\s\S]{0,200}new AbortController\(\)/.test(src));
}

// --- 2. the signal reaches the calls that need it -------------------------
{
  // Was 1 (readPaperBytes only). Import and the two network searches must now pass it.
  const withSignal = (src.match(/callRemote\([^)]*,\s*signal\)/g) ?? []).length;
  check("more than one call site passes a signal to callRemote", withSignal >= 3, String(withSignal));
  check("import sends a signal", /"importPdf",\s*\{ files \},\s*signal\)/.test(src));
  check("external search sends a signal", /"searchExternal",\s*\{ query, limit: 10 \},\s*signal\)/.test(src));
  check("cnki search sends a signal", /"cnkiSearch",\s*\{ query, limit: 20 \},\s*signal\)/.test(src));
}

// --- 3. the cancel button is reachable while busy -------------------------
{
  check("there is a cancel handler", /const cancelBusy = useCallback\(/.test(src));
  check("the cancel handler aborts the controller", /controller\.abort\(/.test(src));
  // The button must be gated on a controller existing, not on a particular busy value:
  // hard-coding `busy === "import"` would hide the button for a cancelled search.
  check("the cancel button is rendered only when a job can be cancelled",
    /abortRef\.current !== null\s*\n?\s*\?\s*h\(Button,\s*\{ onClick: cancelBusy/.test(src));
  check("the cancel button has a label", /t\("cancelBusy"\)/.test(src));
}

// --- 4. the busy row says what is happening -------------------------------
{
  check("a busy stage state exists", /const \[busyStage, setBusyStage\] = useState/.test(src));
  check("the stage is set when a cancellable job starts", /setBusyStage\(stage\)/.test(src));
  check("the stage is cleared when the job ends", /setBusyStage\(""\)/.test(src));
  check("the busy row renders the stage", /busyStage !== ""\s*\?\s*busyStage\s*:\s*busy/.test(src));
  check("the busy row is announced to assistive tech", /role: "status"/.test(src) && /"aria-live": "polite"/.test(src));
  // Distinct stage strings, so "Importing" and "Searching" are not the same word.
  const stages = ["busyStageImport", "busyStageSearch"].filter((key) => src.includes(`t("${key}")`));
  check("at least two distinct stages are wired", stages.length >= 2, JSON.stringify(stages));
}

// --- 5. a cancellation is not dressed up as a failure ---------------------
{
  check("the client has its own abort detector", /function isAbortError\(error\) \{/.test(src));
  check("the import catch checks for cancellation before reporting",
    /if \(isAbortError\(importError\)\)/.test(src));
  check("the search catch checks for cancellation before reporting",
    /if \(isAbortError\(searchError\)\)/.test(src));
  // The specific failure this guards: describeError turns an AbortError into
  // "AbortError: The operation was aborted" printed in a red banner.
  check("describing a cancellation as an error is avoided in the import path",
    !/catch \(importError\) \{\s*setError\(describeError/.test(src));
  check("describing a cancellation as an error is avoided in the search path",
    !/catch \(searchError\) \{\s*setError\(describeError/.test(src));
}

// --- 6. the user is told how much work was dropped ------------------------
{
  check("a cancelled import reports the skipped count", /result\.aborted === true \? t\("cancelSkipped"/.test(src));
  check("the skipped-count message takes the number", /cancelSkipped: "已取消，剩下 \{n\} 个未处理"/.test(src));
  check("a cancelled import refreshes the library so finished files appear",
    /if \(isAbortError\(importError\)\) \{\s*await refresh\(\);/.test(src));
}

// --- 7. i18n keys exist in both languages ---------------------------------
{
  const keys = ["cancel", "cancelBusy", "cancelledByUser", "busyStageImport",
    "busyStageSearch", "busyStageOcr", "busyStageDownload", "busyStageExport", "cancelSkipped"];
  for (const key of keys) {
    const occurrences = (src.match(new RegExp(`\\b${key}:`, "g")) ?? []).length;
    check(`i18n key ${key} exists in both dictionaries`, occurrences >= 2, String(occurrences));
  }
}

if (failures.length > 0) {
  console.log("\nCANCEL-UI FAILED (" + failures.length + "):");
  for (const f of failures) console.log(" - " + f);
  process.exit(1);
}
console.log("\nCANCEL-UI PASS");

// Gate: a confirmation banner must not follow the user to an unrelated tab.
//
// Found by clicking, not by reading. After 取分段 the translate view set a global
// `note` to "45 段"; the note banner renders ABOVE the view switch, so the count stayed
// pinned over the topics tab after the user moved on. On screen it read as a stray
// input box labelled "45 段" at the top of a view it had nothing to do with.
//
// This is the kind of defect no signature-level gate can see: every RPC is correct,
// every call site is correct, and the wrong thing is where a piece of state is shown.
// So the assertion is about the relationship between `note` and tab switching.
import { readFileSync } from "node:fs";

const failures = [];
function check(name, ok, detail) {
  if (ok) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${detail === undefined ? "" : ` -> ${detail}`}`); failures.push(name); }
}

const client = readFileSync("client.js", "utf8");

// --- 1. there is exactly one note banner, and it is outside the view switch -----
{
  const bannerUses = [...client.matchAll(/note\s*\?\s*h\("div"/g)].length;
  check("the note banner is rendered once", bannerUses === 1, `found ${bannerUses}`);

  // The banner must appear BEFORE the switch expression in source order, which is what
  // makes it persist across views. If someone moves it inside a view, this gate should
  // be rewritten deliberately rather than silently passing.
  const bannerAt = client.indexOf("note ? h(\"div\"");
  const switchAt = client.indexOf('view === "library" ? renderLibrary()');
  check("the banner is declared above the view switch", bannerAt > 0 && switchAt > bannerAt,
    `banner@${bannerAt} switch@${switchAt}`);
}

// --- 2. every path that changes the view clears the note ------------------------
{
  // The tab buttons. A tab click is the ordinary way a view changes.
  const tabClick = client.indexOf("onClick: () => { setView(id); setNote(\"\"); }");
  check("switching tabs clears the note", tabClick > 0, "the tab onClick does not clear note");

  // Opening the reader and adding to compare also move the user to the library view.
  // Both are reached from other tabs, so both can carry a stale banner with them.
  for (const [label, marker] of [
    ["opening the reader", "const openReader = useCallback("],
    ["adding a paper to compare", "const addToCompare = useCallback("],
  ]) {
    const at = client.indexOf(marker);
    check(`${label} exists`, at > 0, "call site not found");
    if (at < 0) continue;
    // Look at the body up to the closing `}, []);` — these are dependency-free callbacks.
    const body = client.slice(at, client.indexOf("}, []);", at));
    check(`${label} clears the note`, /setNote\(""\)/.test(body), "does not clear note");
    check(`${label} switches to the library view`, /setView\("library"\)/.test(body), "does not switch view");
  }
}

// --- 3. the translate view must not announce its own count globally ------------
{
  // The count is already shown inside the view (the segment tally line) and in the list
  // header. Setting the global note as well is what leaked in the first place.
  const loadSegments = client.indexOf("const loadSegments = useCallback(");
  check("the segment loader exists", loadSegments > 0);
  if (loadSegments > 0) {
    const body = client.slice(loadSegments, client.indexOf("}, [sessionId, translatePaperId", loadSegments));
    check("loading segments does not set a global note", !/setNote\(/.test(body),
      "setNote is called inside loadSegments");
    // It must still show the count somewhere the user is looking.
    check("the segment count is still displayed inside the view",
      /segmentCount/.test(client), "the in-view tally lost its count");
    check("the in-view tally reports translated and untranslated too",
      /untranslatedCount/.test(client), "the tally lost its untranslated count");
  }
}

// --- 4. errors are deliberately NOT cleared on a tab change --------------------
// Clearing the note is safe because a note only ever confirms something that already
// succeeded. An error is usually the reason the user is changing tabs; hiding it on the
// way out would make the failure vanish before it was read.
{
  const tabClickAt = client.indexOf("onClick: () => { setView(id); setNote(\"\"); }");
  const line = client.slice(tabClickAt, client.indexOf("}, ", tabClickAt));
  check("a tab change does not clear the error banner", !/setError\(/.test(line),
    "the tab onClick clears the error state");
}

console.log("");
if (failures.length > 0) {
  console.log("BANNER-SCOPE FAILED (" + failures.length + "):");
  for (const name of failures) console.log("  - " + name);
  process.exit(1);
}
console.log("BANNER-SCOPE PASS");
